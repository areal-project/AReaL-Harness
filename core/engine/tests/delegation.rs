use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelEvent, ModelStream},
    tools::RuntimeConfig,
    workgroup::{
        self, Check, Executor,
        service::{AvailabilityError, Factory, Policy, Service},
        tree::{self, File, Tree},
    },
};
use areal_protocol::{Input, delegation::DelegationRequest};
use areal_runtime_client::Client;
use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::Semaphore,
};
use tokio_util::sync::CancellationToken;

struct ModelFixture {
    reject_work: AtomicBool,
    started: Semaphore,
    release: Semaphore,
}
#[async_trait]
impl Model for ModelFixture {
    fn check_work(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            !self.reject_work.load(Ordering::SeqCst),
            "fixture workload blocked"
        );
        Ok(())
    }
    fn name(&self) -> &str {
        "unified-delegation"
    }
    async fn stream(&self, messages: Vec<Message>) -> anyhow::Result<ModelStream> {
        let root = messages
            .iter()
            .any(|message| message.role == "user" && message.text_content() == "root");
        if root {
            self.started.add_permits(1);
            self.release.acquire().await?.forget();
        }
        if messages
            .iter()
            .any(|message| message.role == "user" && message.text_content() == "long-child")
        {
            return Ok(Box::pin(futures_util::stream::iter([Ok(
                ModelEvent::text("猫".repeat(6000)),
            )])));
        }
        Ok(Box::pin(futures_util::stream::iter([Ok(
            ModelEvent::text(if root { "root-result" } else { "child-result" }),
        )])))
    }
}
struct WorkerFixture {
    probes: AtomicUsize,
    availability: std::sync::Mutex<Result<(), AvailabilityError>>,
    attempts: AtomicUsize,
    checks: AtomicUsize,
    max_model_rounds: AtomicUsize,
}
struct FactoryFixture(Arc<WorkerFixture>);
#[async_trait]
impl Factory for FactoryFixture {
    async fn probe_availability(&self, _: &Path) -> Result<(), AvailabilityError> {
        self.0.probes.fetch_add(1, Ordering::SeqCst);
        self.0.availability.lock().unwrap().clone()
    }

    fn executor(&self, _: &Path, _: &Policy) -> anyhow::Result<Arc<dyn Executor>> {
        Ok(self.0.clone())
    }
}
#[async_trait]
impl Executor for WorkerFixture {
    async fn attempt(
        &self,
        task: workgroup::Task,
        _: u32,
        mut base: Tree,
        _: Option<Tree>,
        _: String,
        _: CancellationToken,
    ) -> anyhow::Result<Tree> {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        self.max_model_rounds.store(
            task.configuration
                .as_ref()
                .and_then(|configuration| configuration.max_model_rounds)
                .unwrap_or_default(),
            Ordering::SeqCst,
        );
        base.insert(
            task.writes[0].clone(),
            File {
                bytes: b"candidate".to_vec(),
                executable: false,
            },
        );
        Ok(base)
    }
    async fn verify(
        &self,
        tree: Tree,
        checks: Vec<Vec<String>>,
        _: CancellationToken,
    ) -> anyhow::Result<Check> {
        if !checks.is_empty() {
            self.checks.fetch_add(1, Ordering::SeqCst);
        }
        Ok(Check {
            tree_hash: tree::digest(&tree),
            passed: true,
            output: "trusted fixture check".into(),
        })
    }
}

async fn runtime(workspace: std::path::PathBuf) -> (Arc<Client>, tokio::task::JoinHandle<()>) {
    let (pipe, peer) = tokio::io::duplex(65536);
    let (read, write) = tokio::io::split(pipe);
    let (reader, mut writer) = tokio::io::split(peer);
    let task = tokio::spawn(async move {
        let epoch = uuid::Uuid::new_v4().to_string();
        let root = format!("{epoch}:scope:{}", uuid::Uuid::new_v4());
        let mut staged = std::collections::HashMap::<String, Vec<u8>>::new();
        let mut lines = BufReader::new(reader).lines();
        while let Some(line) = lines.next_line().await.unwrap() {
            let request: Value = serde_json::from_str(&line).unwrap();
            let method = request["method"].as_str().unwrap();
            let result = match method {
                "connection.open" => {
                    json!({"protocolVersion":"areal.runtime.v0","runtimeEpoch":epoch,"connectionId":"fixture","rootScopeId":root,"capabilities":{"methods":["fs.execute"],"filesystem":{"artifactDelivery":true}}})
                }
                "scope.create" | "scope.get" | "scope.revoke" | "scope.waitClosed" => {
                    json!({"scopeId":root,"parentScopeId":null,"state":if method=="scope.waitClosed"{"closed"}else{"active"},"owner":{"taskId":"fixture"},"readRoots":["workspace://repo"],"writeRoots":["workspace://repo"],"network":"deny","limits":{"wallTimeMs":10000,"outputBytes":8388608,"maxProcesses":4},"activeProcesses":0,"outputBytes":0,"cleanupError":null})
                }
                "connection.close" => json!({"closed":true}),
                "fs.execute" => {
                    use areal_runtime_protocol::{FileCommand, FileRequest};
                    let request: FileRequest =
                        serde_json::from_value(request["params"].clone()).unwrap();
                    let path = workspace.join(
                        request
                            .command
                            .path()
                            .strip_prefix("workspace://repo/")
                            .unwrap(),
                    );
                    match request.command {
                        FileCommand::StageFileChunk {
                            upload_id,
                            offset,
                            data_base64,
                            ..
                        } => {
                            let bytes = staged.entry(upload_id.clone()).or_default();
                            assert_eq!(bytes.len() as u64, offset);
                            bytes.extend(STANDARD.decode(data_base64).unwrap());
                            json!({"uploadId":upload_id,"nextOffset":bytes.len()})
                        }
                        FileCommand::CommitFile {
                            upload_id,
                            sha256,
                            executable,
                            ..
                        } => {
                            std::fs::write(path, staged.remove(&upload_id).unwrap()).unwrap();
                            json!({"sha256":sha256,"executable":executable})
                        }
                        _ => panic!("unexpected file command"),
                    }
                }
                _ => panic!("unexpected runtime request {method}"),
            };
            writer
                .write_all(format!("{}\n", json!({"id":request["id"],"result":result})).as_bytes())
                .await
                .unwrap();
            if method == "connection.close" {
                break;
            }
        }
    });
    (Client::connect(read, write).await.unwrap(), task)
}

struct Fixture {
    root: tempfile::TempDir,
    engine: Arc<Engine>,
    model: Arc<ModelFixture>,
    worker: Arc<WorkerFixture>,
    parent: String,
    runtime: Arc<Client>,
    peer: tokio::task::JoinHandle<()>,
}
impl Fixture {
    async fn open(policy: Option<bool>) -> Self {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("repo");
        std::fs::create_dir(&workspace).unwrap();
        let (runtime, peer) = runtime(workspace.clone()).await;
        let model = Arc::new(ModelFixture {
            reject_work: AtomicBool::new(false),
            started: Semaphore::new(0),
            release: Semaphore::new(0),
        });
        let worker = Arc::new(WorkerFixture {
            probes: AtomicUsize::new(0),
            availability: std::sync::Mutex::new(Ok(())),
            attempts: AtomicUsize::new(0),
            checks: AtomicUsize::new(0),
            max_model_rounds: AtomicUsize::new(0),
        });
        let engine = Engine::open_with_runtime(
            &root.path().join("data"),
            model.clone(),
            Limits::default(),
            RuntimeConfig {
                client: runtime.clone(),
                workspace: workspace.clone(),
                writable: true,
                command_scope: None,
                command_scratch: None,
            },
        )
        .unwrap();
        if let Some(strict) = policy {
            let factory = Arc::new(FactoryFixture(worker.clone()));
            if strict {
                let service = Service::open(
                    &root.path().join("workgroups"),
                    &workspace,
                    Policy {
                        allowed_writes: vec!["result.txt".into()],
                        allowed_directories: vec![],
                        checks: vec![vec!["trusted-check".into()]],
                        workers: 2,
                        verifiers: 1,
                        active_groups: 2,
                        timeout_seconds: 10,
                        command_timeout_ms: 1000,
                        max_model_requests: 64,
                    },
                    factory,
                )
                .unwrap();
                engine.attach_workgroups(service).unwrap();
            } else {
                engine
                    .attach_automatic_workgroups(
                        Service::open_automatic(
                            &root.path().join("automatic"),
                            &workspace,
                            factory,
                            2,
                        )
                        .unwrap(),
                    )
                    .unwrap();
            }
        }
        let parent = engine
            .create(workspace.to_string_lossy().into_owned())
            .await
            .unwrap();
        engine
            .start(&parent.id, vec![Input::text("root")])
            .await
            .unwrap();
        model.started.acquire().await.unwrap().forget();
        Self {
            root,
            engine,
            model,
            worker,
            parent: parent.id,
            runtime,
            peer,
        }
    }
    fn request(&self, key: &str, intent: &str, delivery: &str) -> DelegationRequest {
        serde_json::from_value(json!({"requestId":key,"parentThreadId":self.parent,"input":[{"type":"text","text":"child"}],"intent":intent,"delivery":delivery})).unwrap()
    }
    async fn wait(&self, value: &Value) -> Value {
        self.engine
            .execution_wait(&self.parent, value["executionId"].as_str().unwrap(), 5000)
            .await
            .unwrap()
    }
    async fn close(self) {
        self.model.release.add_permits(32);
        tokio::time::timeout(Duration::from_secs(10), self.engine.wait(&self.parent))
            .await
            .unwrap()
            .unwrap();
        self.engine.shutdown().await;
        self.runtime.shutdown().await.unwrap();
        self.peer.await.unwrap();
    }
}

#[tokio::test]
async fn inspect_uses_read_only_children_and_foreign_parent_cannot_read_the_execution() {
    let fixture = Fixture::open(None).await;
    let result = fixture
        .engine
        .delegate(fixture.request("inspect", "inspect", "report"))
        .await
        .unwrap();
    assert_eq!(result["strategy"], "sharedReadOnly");
    let done = fixture.wait(&result).await;
    assert_eq!(done["status"], "completed");
    let child = fixture
        .engine
        .read(done["threadId"].as_str().unwrap(), true)
        .await
        .unwrap();
    assert!(child.turns[0].configuration.as_ref().unwrap().read_only);
    let other = fixture
        .engine
        .create(
            fixture
                .root
                .path()
                .join("repo")
                .to_string_lossy()
                .into_owned(),
        )
        .await
        .unwrap();
    assert!(
        fixture
            .engine
            .execution_read(&other.id, done["executionId"].as_str().unwrap())
            .await
            .is_err()
    );
    fixture.close().await;
}

#[tokio::test]
async fn unified_shared_reply_pages_preserve_utf8_and_handoff_metadata() {
    let fixture = Fixture::open(None).await;
    let mut request = fixture.request("pages", "inspect", "report");
    request.input = vec![Input::text("long-child")];
    let result = fixture.engine.delegate(request).await.unwrap();
    let first = fixture.wait(&result).await;
    assert_eq!(first["source"], "message");
    assert_eq!(first["textBytes"], 18000);
    assert_eq!(first["offset"], 0);
    assert_eq!(first["partial"], false);
    let execution = first["executionId"].as_str().unwrap();
    let source_item = first["sourceItemId"].clone();
    let mut page = first.clone();
    let mut restored = String::new();
    loop {
        assert_eq!(page["sourceItemId"], source_item);
        restored.push_str(page["text"].as_str().unwrap());
        let Some(offset) = page["nextOffset"].as_u64() else {
            break;
        };
        page = fixture
            .engine
            .execution_read_page(&fixture.parent, execution, offset as usize)
            .await
            .unwrap();
        assert_eq!(page["offset"], offset);
    }
    assert_eq!(restored, "猫".repeat(6000));
    assert!(
        fixture
            .engine
            .execution_read_page(&fixture.parent, execution, 1)
            .await
            .is_err()
    );
    fixture.close().await;
}

#[tokio::test]
async fn environment_bound_modifications_use_a_shared_exclusive_writer() {
    let fixture = Fixture::open(Some(true)).await;
    let mut request = fixture.request("modify", "modify", "changes");
    request.independent = true;
    request.requires_current_environment = true;
    request.writes = vec!["result.txt".into()];
    let result = fixture.engine.delegate(request).await.unwrap();
    assert_eq!(result["strategy"], "sharedExclusive");
    let done = fixture.wait(&result).await;
    assert_eq!(done["status"], "completed");
    let child = fixture
        .engine
        .read(done["threadId"].as_str().unwrap(), true)
        .await
        .unwrap();
    assert!(
        child
            .desktop
            .as_ref()
            .unwrap()
            .execution_policy
            .exclusive_write
    );
    assert!(!child.turns[0].configuration.as_ref().unwrap().read_only);
    assert_eq!(fixture.worker.attempts.load(Ordering::SeqCst), 0);
    fixture.close().await;
}

#[tokio::test]
async fn unavailable_native_isolation_falls_back_before_worker_creation_and_is_cached() {
    let fixture = Fixture::open(Some(false)).await;
    *fixture.worker.availability.lock().unwrap() = Err(AvailabilityError::Unavailable(
        "fixture: user namespaces denied".into(),
    ));
    for key in ["first", "second"] {
        let mut request = fixture.request(key, "modify", "changes");
        request.independent = true;
        request.writes = vec!["result.txt".into()];
        let first = fixture.engine.delegate(request.clone()).await.unwrap();
        assert_eq!(first["strategy"], "sharedExclusive");
        assert!(
            first["reason"]
                .as_str()
                .unwrap()
                .contains("user namespaces denied")
        );
        let second = fixture.engine.delegate(request).await.unwrap();
        assert_eq!(first["executionId"], second["executionId"]);
        assert_eq!(fixture.wait(&first).await["status"], "completed");
    }
    assert_eq!(fixture.worker.probes.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.worker.attempts.load(Ordering::SeqCst), 0);
    fixture.close().await;
}

#[tokio::test]
async fn unavailable_native_isolation_rejects_required_guarantees_before_recording_work() {
    let fixture = Fixture::open(Some(true)).await;
    *fixture.worker.availability.lock().unwrap() = Err(AvailabilityError::Unavailable(
        "fixture: native sandbox missing".into(),
    ));
    for (key, delivery, trusted) in [("patch", "patch", false), ("trusted", "changes", true)] {
        let mut request = fixture.request(key, "modify", delivery);
        request.require_trusted_checks = trusted;
        request.writes = vec!["result.txt".into()];
        let error = fixture
            .engine
            .delegate(request)
            .await
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("required execution guarantee unavailable"),
            "{error}"
        );
    }
    assert!(
        fixture
            .engine
            .execution_list(&fixture.parent, 0, 50)
            .await
            .unwrap()["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(fixture.worker.probes.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.worker.attempts.load(Ordering::SeqCst), 0);
    fixture.close().await;
}

#[tokio::test]
async fn probe_cleanup_unknown_never_falls_back_or_creates_a_worker() {
    let fixture = Fixture::open(Some(false)).await;
    *fixture.worker.availability.lock().unwrap() = Err(AvailabilityError::CleanupUnknown(
        "fixture: close acknowledgement lost".into(),
    ));
    for key in ["first", "second"] {
        let mut request = fixture.request(key, "modify", "changes");
        request.independent = true;
        request.writes = vec!["result.txt".into()];
        let error = fixture
            .engine
            .delegate(request)
            .await
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("probe did not settle") && error.contains("UNKNOWN"),
            "{error}"
        );
    }
    assert!(
        fixture
            .engine
            .execution_list(&fixture.parent, 0, 50)
            .await
            .unwrap()["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(fixture.worker.probes.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.worker.attempts.load(Ordering::SeqCst), 0);
    fixture.close().await;
}

struct BlockingProbeFactory {
    started: Semaphore,
    release: Semaphore,
    finished: AtomicBool,
}
#[async_trait]
impl Factory for BlockingProbeFactory {
    async fn probe_availability(&self, _: &Path) -> Result<(), AvailabilityError> {
        self.started.add_permits(1);
        self.release.acquire().await.unwrap().forget();
        self.finished.store(true, Ordering::SeqCst);
        Ok(())
    }
    fn executor(&self, _: &Path, _: &Policy) -> anyhow::Result<Arc<dyn Executor>> {
        anyhow::bail!("capability probe must not create an executor")
    }
}

#[tokio::test]
async fn cancelled_probe_waiter_preserves_owned_cleanup_and_service_shutdown_waits() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let factory = Arc::new(BlockingProbeFactory {
        started: Semaphore::new(0),
        release: Semaphore::new(0),
        finished: AtomicBool::new(false),
    });
    let service =
        Service::open_automatic(&root.path().join("service"), &workspace, factory.clone(), 1)
            .unwrap();
    let pending = service.clone();
    let waiter = tokio::spawn(async move { pending.probe_availability().await });
    factory.started.acquire().await.unwrap().forget();
    waiter.abort();
    assert!(waiter.await.unwrap_err().is_cancelled());
    let shutdown = service.shutdown();
    tokio::pin!(shutdown);
    assert!(futures_util::poll!(shutdown.as_mut()).is_pending());
    assert!(!factory.finished.load(Ordering::SeqCst));
    factory.release.add_permits(1);
    tokio::time::timeout(Duration::from_secs(5), shutdown)
        .await
        .unwrap();
    assert!(factory.finished.load(Ordering::SeqCst));
}

#[tokio::test]
async fn trusted_isolation_is_idempotent_and_reports_verified_candidates() {
    let fixture = Fixture::open(Some(true)).await;
    let mut request = fixture.request("isolated", "modify", "patch");
    request.require_trusted_checks = true;
    request.max_model_rounds = Some(3);
    request.writes = vec!["result.txt".into()];
    let result = fixture.engine.delegate(request.clone()).await.unwrap();
    let repeated = fixture.engine.delegate(request.clone()).await.unwrap();
    assert_eq!(result["executionId"], repeated["executionId"]);
    let done = fixture.wait(&result).await;
    assert_eq!(done["status"], "completed");
    assert_eq!(
        done["verification"],
        json!({"kind":"trusted","status":"passed"})
    );
    assert_eq!(done["delivery"]["status"], "candidate");
    assert!(!fixture.root.path().join("repo/result.txt").exists());
    assert_eq!(fixture.worker.attempts.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.worker.max_model_rounds.load(Ordering::SeqCst), 3);
    request.input = vec![Input::text("different work")];
    assert!(fixture.engine.delegate(request).await.is_err());
    fixture.close().await;
}

#[tokio::test]
async fn automatic_isolation_without_checks_never_claims_trusted_verification() {
    let fixture = Fixture::open(Some(false)).await;
    let mut request = fixture.request("automatic", "modify", "patch");
    request.writes = vec!["result.txt".into()];
    let result = fixture.engine.delegate(request).await.unwrap();
    let done = fixture.wait(&result).await;
    assert_eq!(done["status"], "completed");
    assert_eq!(
        done["verification"],
        json!({"kind":"none","status":"notRun"})
    );
    assert_eq!(fixture.worker.checks.load(Ordering::SeqCst), 0);
    let mut required = fixture.request("required", "modify", "patch");
    required.writes = vec!["result.txt".into()];
    required.require_trusted_checks = true;
    assert!(fixture.engine.delegate(required).await.is_err());
    fixture.close().await;
}

#[tokio::test]
async fn cancelling_a_completed_candidate_prevents_delivery_and_survives_restart() {
    let fixture = Fixture::open(Some(false)).await;
    let mut request = fixture.request("cancel-candidate", "modify", "changes");
    request.independent = true;
    request.writes = vec!["result.txt".into()];
    let started = fixture.engine.delegate(request.clone()).await.unwrap();
    let done = fixture.wait(&started).await;
    assert_eq!(done["status"], "awaitingDelivery");
    let execution = started["executionId"].as_str().unwrap();
    let stopped = fixture
        .engine
        .execution_cancel(&fixture.parent, execution, false)
        .await
        .unwrap();
    assert_eq!(stopped["status"], "cancelled");
    assert_eq!(stopped["stopRequested"], true);
    assert_eq!(stopped["settled"], true);
    assert_eq!(stopped["delivery"]["status"], "cancelled");
    assert_eq!(fixture.wait(&started).await["status"], "cancelled");
    assert_eq!(
        fixture
            .engine
            .execution_apply(&fixture.parent, execution)
            .await
            .unwrap()["delivery"]["status"],
        "cancelled"
    );
    assert_eq!(
        fixture.engine.delegate(request).await.unwrap()["executionId"],
        started["executionId"]
    );
    // Turn 正常收尾不能重新应用已经取消的 changes 候选。
    fixture.model.release.add_permits(32);
    tokio::time::timeout(
        Duration::from_secs(10),
        fixture.engine.wait(&fixture.parent),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!fixture.root.path().join("repo/result.txt").exists());
    fixture.engine.shutdown().await;
    let Fixture {
        root,
        engine,
        model,
        worker,
        parent,
        runtime,
        peer,
    } = fixture;
    drop(engine);
    // 服务恢复会创建新 token，持久执行记录仍必须挡住手动及自动交付。
    let restored = Engine::open_with_runtime(
        &root.path().join("data"),
        model,
        Limits::default(),
        RuntimeConfig {
            client: runtime.clone(),
            workspace: root.path().join("repo"),
            writable: true,
            command_scope: None,
            command_scratch: None,
        },
    )
    .unwrap();
    restored
        .attach_automatic_workgroups(
            Service::open_automatic(
                &root.path().join("automatic"),
                &root.path().join("repo"),
                Arc::new(FactoryFixture(worker.clone())),
                2,
            )
            .unwrap(),
        )
        .unwrap();
    assert_eq!(
        restored.execution_read(&parent, execution).await.unwrap()["status"],
        "cancelled"
    );
    assert_eq!(
        restored.execution_apply(&parent, execution).await.unwrap()["delivery"]["status"],
        "cancelled"
    );
    assert!(!root.path().join("repo/result.txt").exists());
    assert_eq!(worker.attempts.load(Ordering::SeqCst), 1);
    restored.shutdown().await;
    runtime.shutdown().await.unwrap();
    peer.await.unwrap();
}

#[tokio::test]
async fn normal_turn_settlement_keeps_an_uncancelled_patch_deliverable_in_a_later_turn() {
    let fixture = Fixture::open(Some(false)).await;
    fixture
        .engine
        .set_permissions(
            areal_config::PermissionConfig {
                mode: areal_config::PermissionMode::Yolo,
                ..Default::default()
            },
            None,
        )
        .unwrap();
    let mut request = fixture.request("later-patch", "modify", "patch");
    request.writes = vec!["result.txt".into()];
    let started = fixture.engine.delegate(request).await.unwrap();
    assert_eq!(
        fixture.wait(&started).await["delivery"]["status"],
        "candidate"
    );
    fixture.model.release.add_permits(32);
    tokio::time::timeout(
        Duration::from_secs(10),
        fixture.engine.wait(&fixture.parent),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!fixture.root.path().join("repo/result.txt").exists());
    let unused = fixture.model.release.available_permits() as u32;
    fixture
        .model
        .release
        .acquire_many(unused)
        .await
        .unwrap()
        .forget();
    fixture
        .engine
        .start(&fixture.parent, vec![Input::text("root")])
        .await
        .unwrap();
    let applied = fixture
        .engine
        .execution_apply(&fixture.parent, started["executionId"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(applied["delivery"]["status"], "applied");
    assert_eq!(
        std::fs::read(fixture.root.path().join("repo/result.txt")).unwrap(),
        b"candidate"
    );
    fixture.close().await;
}

#[tokio::test]
async fn delivery_receipt_overrides_original_verification_and_corruption_is_unknown() {
    let fixture = Fixture::open(Some(true)).await;
    let mut request = fixture.request("delivery-recovery", "modify", "patch");
    request.require_trusted_checks = true;
    request.writes = vec!["result.txt".into()];
    let started = fixture.engine.delegate(request).await.unwrap();
    let done = fixture.wait(&started).await;
    assert_eq!(done["verification"]["status"], "passed");
    let group = done["artifact"]["workgroupId"].as_str().unwrap();
    let path = fixture
        .root
        .path()
        .join("workgroups")
        .join(group)
        .join("delivery.json");
    let journal = json!({
        "version":2,"threadId":fixture.parent,"groupId":group,
        "sourceHead":done["artifact"]["head"],"head":"composed-head","baseline":"current-base",
        "verified":false,"verification":null,"status":"unknown","appliedPaths":[],"steps":[],
        "error":"verification cleanup was not confirmed"
    });
    std::fs::write(&path, serde_json::to_vec(&journal).unwrap()).unwrap();
    let recovered = fixture
        .engine
        .execution_read(&fixture.parent, started["executionId"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(
        recovered["verification"],
        json!({"status":"notRun","kind":"trusted","head":"composed-head"})
    );
    assert_eq!(recovered["resourcesReleased"], false);

    std::fs::write(&path, b"{interrupted journal").unwrap();
    let corrupted = fixture
        .engine
        .execution_read(&fixture.parent, started["executionId"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(corrupted["status"], "unknown");
    assert_eq!(corrupted["settled"], false);
    assert_eq!(corrupted["resourcesReleased"], false);
    assert_eq!(corrupted["delivery"]["status"], "unknown");
    assert_eq!(corrupted["verification"]["status"], "notRun");
    assert!(
        corrupted["error"]
            .as_str()
            .unwrap()
            .contains("delivery receipt unavailable")
    );
    // 恢复只读取日志，不以原候选通过回执覆盖未知交付，也不执行新的作者请求。
    assert_eq!(fixture.worker.attempts.load(Ordering::SeqCst), 1);
    std::fs::remove_file(path).unwrap();
    fixture.close().await;
}

#[tokio::test]
async fn public_delivery_respects_work_guard_but_can_inspect_an_existing_receipt() {
    let fixture = Fixture::open(Some(true)).await;
    let mut request = fixture.request("guarded-delivery", "modify", "patch");
    request.require_trusted_checks = true;
    request.writes = vec!["result.txt".into()];
    let started = fixture.engine.delegate(request).await.unwrap();
    let done = fixture.wait(&started).await;
    let execution = started["executionId"].as_str().unwrap();
    let group = done["artifact"]["workgroupId"].as_str().unwrap();
    let journal_path = fixture
        .root
        .path()
        .join("workgroups")
        .join(group)
        .join("delivery.json");
    fixture.model.reject_work.store(true, Ordering::SeqCst);
    let error = fixture
        .engine
        .execution_apply(&fixture.parent, execution)
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("fixture workload blocked"),
        "{error}"
    );
    assert!(!journal_path.exists());
    assert!(!fixture.root.path().join("repo/result.txt").exists());
    let journal = serde_json::to_vec(&json!({
        "version":2,"threadId":fixture.parent,"groupId":group,
        "sourceHead":done["artifact"]["head"],"head":done["artifact"]["head"],"baseline":"previous-baseline",
        "verified":false,"verification":null,"status":"unknown","appliedPaths":[],"steps":[],
        "error":"lost delivery receipt"
    })).unwrap();
    std::fs::write(&journal_path, &journal).unwrap();
    let inspected = fixture
        .engine
        .execution_apply(&fixture.parent, execution)
        .await
        .unwrap();
    assert_eq!(inspected["delivery"]["status"], "unknown");
    assert_eq!(std::fs::read(&journal_path).unwrap(), journal);
    assert!(!fixture.root.path().join("repo/result.txt").exists());
    fixture.model.reject_work.store(false, Ordering::SeqCst);
    fixture.close().await;
}
