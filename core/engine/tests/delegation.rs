use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelEvent, ModelStream, RequestPurpose},
    tools::RuntimeConfig,
    workgroup::{
        self, Check, Executor,
        service::{AvailabilityError, Factory, Policy, Service},
        tree::{self, File, Tree},
    },
};
use areal_protocol::{Input, Item, ToolOutcome, TurnStatus, delegation::DelegationRequest};
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
    read_execution: std::sync::Mutex<Option<String>>,
    root_calls: AtomicUsize,
    child_requests: AtomicUsize,
    advertised_tools: std::sync::Mutex<Vec<Vec<Value>>>,
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
    async fn chat_limited(
        &self,
        messages: Vec<Message>,
        tools: Vec<Value>,
        _: RequestPurpose,
        cap: Option<u64>,
    ) -> anyhow::Result<ModelStream> {
        use futures_util::StreamExt;
        self.advertised_tools.lock().unwrap().push(tools);
        // 固定响应也遵守 Goal 的输出预算，并提供已知用量，避免夹具先触发未知计量。
        let tokens = if messages.iter().any(|m| m.text_content() == "long-child") {
            6000
        } else {
            16
        };
        anyhow::ensure!(cap.is_none_or(|cap| cap >= tokens), "fixture output budget");
        Ok(Box::pin(self.stream(messages).await?.chain(
            futures_util::stream::once(async move {
                Ok(ModelEvent::Usage(areal_protocol::ModelUsage {
                    input_tokens: 1,
                    cached_input_tokens: 0,
                    output_tokens: tokens,
                }))
            }),
        )))
    }
    async fn stream(&self, messages: Vec<Message>) -> anyhow::Result<ModelStream> {
        let root = messages.iter().any(|message| {
            message.role == "user"
                && (message.text_content() == "root"
                    || message.text_content().contains("TASK_SCOPE_ROOT"))
        });
        if root {
            self.started.add_permits(1);
            self.release.acquire().await?.forget();
            let n = self.root_calls.fetch_add(1, Ordering::SeqCst);
            if let Some(execution) = self.read_execution.lock().unwrap().clone() {
                return Ok(Box::pin(futures_util::stream::iter(match n {
                    0 => vec![Ok(ModelEvent::ToolCall(areal_engine::model::ToolCall {
                        id: "read-settled-execution".into(),
                        name: "agent_wait".into(),
                        arguments: json!({"executionId":execution,"timeoutMs":5000}).to_string(),
                    }))],
                    1 => vec![Ok(ModelEvent::text("Verified delivered result"))],
                    _ => vec![],
                })));
            }
        } else {
            self.child_requests.fetch_add(1, Ordering::SeqCst);
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
    report: AtomicBool,
    probes: AtomicUsize,
    availability: std::sync::Mutex<Result<(), AvailabilityError>>,
    attempts: AtomicUsize,
    checks: AtomicUsize,
    max_model_rounds: AtomicUsize,
    block_attempt: AtomicBool,
    attempt_started: Semaphore,
    attempt_release: Semaphore,
}
struct FactoryFixture(Arc<WorkerFixture>);
#[async_trait]
impl Factory for FactoryFixture {
    async fn handoff(
        &self,
        _: &Path,
        _: &str,
        _: u32,
        offset: usize,
    ) -> anyhow::Result<Option<Value>> {
        if !self.0.report.load(Ordering::SeqCst) {
            return Ok(None);
        }
        let text = "Worker boundary checked; parent integration remains.";
        anyhow::ensure!(offset <= text.len());
        Ok(Some(
            json!({"text":&text[offset..],"source":"message","sourceItemId":"worker-report",
            "offset":offset,"nextOffset":null,"textBytes":text.len(),"partial":false,
            "activity":{"recordedItems":1}}),
        ))
    }
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
        if self.block_attempt.load(Ordering::SeqCst) {
            self.attempt_started.add_permits(1);
            self.attempt_release.acquire().await?.forget();
        }
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

#[derive(Default)]
struct ScopeFixture {
    active_processes: AtomicUsize,
    unavailable: AtomicBool,
    checks: std::sync::Mutex<Vec<Value>>,
}

async fn runtime_with_scope(
    workspace: std::path::PathBuf,
    scopes: Arc<ScopeFixture>,
) -> (Arc<Client>, tokio::task::JoinHandle<()>) {
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
                    json!({"protocolVersion":"areal.runtime.v0","runtimeEpoch":epoch,"connectionId":"fixture","rootScopeId":root,"capabilities":{"methods":["scope.check","fs.execute"],"restrictedScopes":{"available":!scopes.unavailable.load(Ordering::SeqCst)},"filesystem":{"artifactDelivery":true}}})
                }
                "scope.create" | "scope.get" | "scope.revoke" | "scope.waitClosed" => {
                    json!({"scopeId":root,"parentScopeId":null,"state":if method=="scope.waitClosed"{"closed"}else{"active"},"owner":{"taskId":"fixture"},"readRoots":["workspace://repo"],"writeRoots":["workspace://repo"],"network":"deny","limits":{"wallTimeMs":10000,"outputBytes":8388608,"maxProcesses":4},"activeProcesses":scopes.active_processes.load(Ordering::SeqCst),"outputBytes":0,"cleanupError":null})
                }
                "scope.check" => {
                    scopes
                        .checks
                        .lock()
                        .unwrap()
                        .push(request["params"].clone());
                    json!({"available":true})
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
            let restricted = request["params"]["permissions"]["readRoots"].is_array()
                || request["params"]["permissions"]["writeRoots"].is_array()
                || request["params"]["permissions"]["network"] == "deny";
            let response = if method == "scope.check"
                && restricted
                && scopes.unavailable.load(Ordering::SeqCst)
            {
                json!({"id":request["id"],"error":{"code":"UNSUPPORTED","message":"fixture: restricted sandbox unavailable"}})
            } else {
                json!({"id":request["id"],"result":result})
            };
            writer
                .write_all(format!("{response}\n").as_bytes())
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
    scopes: Arc<ScopeFixture>,
}
impl Fixture {
    async fn open(policy: Option<bool>) -> Self {
        Self::open_with_limits(policy, Limits::default()).await
    }
    async fn open_with_limits(policy: Option<bool>, limits: Limits) -> Self {
        Self::open_with_capability(policy, limits, false, true, false).await
    }
    async fn open_with_capability(
        policy: Option<bool>,
        limits: Limits,
        unavailable: bool,
        writable: bool,
        research: bool,
    ) -> Self {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("repo");
        std::fs::create_dir(&workspace).unwrap();
        let scratch = root.path().join("scratch");
        std::fs::create_dir(&scratch).unwrap();
        let scopes = Arc::new(ScopeFixture::default());
        scopes.unavailable.store(unavailable, Ordering::SeqCst);
        let (runtime, peer) = runtime_with_scope(workspace.clone(), scopes.clone()).await;
        let model = Arc::new(ModelFixture {
            reject_work: AtomicBool::new(false),
            started: Semaphore::new(0),
            release: Semaphore::new(0),
            read_execution: std::sync::Mutex::new(None),
            root_calls: AtomicUsize::new(0),
            child_requests: AtomicUsize::new(0),
            advertised_tools: std::sync::Mutex::new(Vec::new()),
        });
        let worker = Arc::new(WorkerFixture {
            report: AtomicBool::new(false),
            probes: AtomicUsize::new(0),
            availability: std::sync::Mutex::new(Ok(())),
            attempts: AtomicUsize::new(0),
            checks: AtomicUsize::new(0),
            max_model_rounds: AtomicUsize::new(0),
            block_attempt: AtomicBool::new(false),
            attempt_started: Semaphore::new(0),
            attempt_release: Semaphore::new(0),
        });
        let mut extensions = areal_engine::tools::ToolExtensions::default();
        if research {
            extensions.agents = Some(areal_engine::tools::AgentToolsConfig {
                max_model_requests: 40,
                max_tool_calls: 60,
                max_worker_model_requests: 10,
                max_worker_tool_calls: 12,
                worker_timeout_seconds: 30,
            });
        }
        let engine = Engine::open_with_extensions(
            &root.path().join("data"),
            model.clone(),
            limits,
            Some(RuntimeConfig {
                client: runtime.clone(),
                workspace: workspace.clone(),
                writable,
                command_scope: None,
                command_scratch: research.then_some(scratch),
            }),
            extensions,
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
            scopes,
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
async fn late_input_returns_explicit_non_delivery_without_resuming_the_child() {
    let fixture = Fixture::open(None).await;
    let started = fixture
        .engine
        .delegate(fixture.request("late-input", "inspect", "report"))
        .await
        .unwrap();
    let done = fixture.wait(&started).await;
    let thread = done["threadId"].as_str().unwrap();
    let before = fixture.engine.read(thread, true).await.unwrap();
    let result = fixture
        .engine
        .execution_send_input(
            &fixture.parent,
            done["executionId"].as_str().unwrap(),
            "Finish using the existing evidence".into(),
        )
        .await
        .unwrap();
    assert_eq!(result["inputAccepted"], false);
    assert_eq!(result["status"], "completed");
    assert_eq!(result["capabilities"]["sendInput"], false);
    assert_eq!(result["receiptVersion"], done["receiptVersion"]);
    assert_eq!(
        serde_json::to_value(fixture.engine.read(thread, true).await.unwrap()).unwrap(),
        serde_json::to_value(before).unwrap(),
        "迟到输入不得重启子任务、污染历史或增加模型预算"
    );
    let foreign = fixture
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
            .execution_send_input(
                &foreign.id,
                done["executionId"].as_str().unwrap(),
                "foreign".into()
            )
            .await
            .is_err()
    );
    fixture.close().await;
}

#[tokio::test]
async fn artifact_readiness_matches_the_guard_without_reading_unsettled_bytes() {
    let fixture = Fixture::open(Some(false)).await;
    fixture.worker.block_attempt.store(true, Ordering::SeqCst);
    let mut request = fixture.request("readiness", "modify", "changes");
    request.independent = true;
    request.writes = vec!["result.txt".into()];
    let started = fixture.engine.delegate(request).await.unwrap();
    let execution = started["executionId"].as_str().unwrap();
    fixture
        .worker
        .attempt_started
        .acquire()
        .await
        .unwrap()
        .forget();
    let pending = fixture
        .engine
        .execution_read(&fixture.parent, execution)
        .await
        .unwrap();
    assert_eq!(pending["capabilities"]["supportsArtifact"], true);
    assert_eq!(pending["capabilities"]["sourceView"], "snapshotAtCreation");
    assert_eq!(pending["capabilities"]["networkPolicy"], "unknown");
    assert_eq!(pending["capabilities"]["readArtifact"], false);
    assert_eq!(pending["artifact"]["available"], false);
    let not_ready = fixture
        .engine
        .execution_artifact(&fixture.parent, execution, Some("result.txt".into()), 0)
        .await
        .unwrap();
    assert_eq!(not_ready["ready"], false);
    assert!(not_ready.get("text").is_none() && not_ready.get("base64").is_none());
    assert_eq!(not_ready["execution"]["executionId"], execution);
    fixture.worker.attempt_release.add_permits(1);
    let ready = fixture.wait(&started).await;
    assert_eq!(ready["artifact"]["available"], true);
    assert_eq!(ready["capabilities"]["readArtifact"], true);
    assert_ne!(ready["receiptVersion"], pending["receiptVersion"]);
    let file = fixture
        .engine
        .execution_artifact(&fixture.parent, execution, Some("result.txt".into()), 0)
        .await
        .unwrap();
    assert_eq!(file["exists"], true);
    assert_eq!(file["verified"], false);
    fixture.close().await;
}

#[tokio::test]
async fn invalid_exact_writes_identify_the_entry_before_any_worker_or_probe_starts() {
    let fixture = Fixture::open(Some(false)).await;
    for (writes, index, bad) in [
        (vec!["public/"], 0, "public/"),
        (vec!["ok.rs", "../outside"], 1, "../outside"),
        (vec!["same.rs", "same.rs"], 1, "same.rs"),
        (vec!["/tmp/file"], 0, "/tmp/file"),
    ] {
        let mut request = fixture.request("invalid-path", "modify", "changes");
        request.writes = writes.into_iter().map(str::to_owned).collect();
        request.independent = true;
        let error = fixture
            .engine
            .delegate(request)
            .await
            .unwrap_err()
            .to_string();
        assert!(
            error.contains(&format!("writes[{index}]")) && error.contains(bad),
            "{error}"
        );
    }
    assert_eq!(fixture.worker.probes.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.worker.attempts.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.model.child_requests.load(Ordering::SeqCst), 0);
    fixture.close().await;
}

#[tokio::test]
async fn trusted_check_advertisement_matches_host_verifier_and_rejects_without_creating_work() {
    for policy in [None, Some(false), Some(true)] {
        let fixture = Fixture::open(policy).await;
        let definitions = fixture.model.advertised_tools.lock().unwrap()[0].clone();
        let spawn = definitions
            .iter()
            .find(|tool| tool["function"]["name"] == "agent_spawn")
            .unwrap();
        let field = &spawn["function"]["parameters"]["properties"]["requireTrustedChecks"];
        let strict = policy == Some(true);
        assert_eq!(
            field["enum"],
            if strict { Value::Null } else { json!([false]) }
        );
        assert!(
            field["description"]
                .as_str()
                .unwrap()
                .contains("host-owned")
        );
        if !strict {
            let mut required = fixture.request("unsupported-trusted", "modify", "changes");
            required.writes = vec!["result.txt".into()];
            required.require_trusted_checks = true;
            let error = fixture
                .engine
                .delegate(required)
                .await
                .unwrap_err()
                .to_string();
            assert!(error.contains("configured host-owned verifier"), "{error}");
            assert!(error.contains("No execution was created"), "{error}");
            let records = fixture
                .engine
                .execution_list(&fixture.parent, 0, 50)
                .await
                .unwrap();
            assert!(records["data"].as_array().unwrap().is_empty());
            assert_eq!(fixture.worker.probes.load(Ordering::SeqCst), 0);
            assert_eq!(fixture.worker.attempts.load(Ordering::SeqCst), 0);
        }
        fixture.close().await;
    }
}

#[tokio::test]
async fn advertised_delegation_matches_known_scope_capability_without_widening() {
    use areal_config::InspectionPermissions::{Inherit, ReadOnly};
    for research in [false, true] {
        for (unavailable, permissions, writable, expected) in [
            (false, ReadOnly, true, Some(json!(["inspect", "modify"]))),
            (true, ReadOnly, true, Some(json!(["modify"]))),
            (true, Inherit, true, Some(json!(["inspect", "modify"]))),
            (true, Inherit, false, None),
        ] {
            let fixture = Fixture::open_with_capability(
                None,
                Limits {
                    inspection_permissions: permissions,
                    ..Limits::default()
                },
                unavailable,
                writable,
                research,
            )
            .await;
            {
                let requests = fixture.model.advertised_tools.lock().unwrap();
                let tools = &requests[0];
                let advertised = tools
                    .iter()
                    .find(|tool| tool["function"]["name"] == "agent_spawn");
                assert_eq!(
                    advertised.map(|tool| {
                        tool["function"]["parameters"]["properties"]["intent"]["enum"].clone()
                    }),
                    if research { None } else { expected },
                    "research={research}, unavailable={unavailable}, permissions={permissions:?}, writable={writable}"
                );
                if !research {
                    for name in ["agent_wait", "agent_cancel"] {
                        assert!(tools.iter().any(|tool| tool["function"]["name"] == name));
                    }
                }
                assert_eq!(
                    tools
                        .iter()
                        .any(|tool| tool["function"]["name"] == "delegate_tasks"),
                    research && !unavailable,
                    "research creation must follow actual restricted-scope availability"
                );
                if research {
                    for name in ["read_agent", "cancel_agent"] {
                        assert!(tools.iter().any(|tool| tool["function"]["name"] == name));
                    }
                }
            }
            assert_eq!(fixture.model.child_requests.load(Ordering::SeqCst), 0);
            fixture.close().await;
        }
    }
}

#[tokio::test]
async fn an_observed_settled_delivery_does_not_require_another_final_model_response() {
    let fixture = Fixture::open(Some(false)).await;
    let mut request = fixture.request("observed-delivery", "modify", "changes");
    request.independent = true;
    request.writes = vec!["result.txt".into()];
    let execution = fixture.engine.delegate(request).await.unwrap();
    *fixture.model.read_execution.lock().unwrap() =
        Some(execution["executionId"].as_str().unwrap().into());
    fixture.model.release.add_permits(8);
    let done = tokio::time::timeout(
        Duration::from_secs(10),
        fixture.engine.wait(&fixture.parent),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        done.turns[0].status,
        areal_protocol::TurnStatus::Completed,
        "{:?}",
        done.turns[0].error
    );
    assert_eq!(fixture.model.root_calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        std::fs::read(fixture.root.path().join("repo/result.txt")).unwrap(),
        b"candidate"
    );
    assert_eq!(fixture.worker.attempts.load(Ordering::SeqCst), 1);
    fixture.close().await;
}

#[tokio::test]
async fn blocked_delivery_retains_handoff_and_wait_receipt_without_restarting_worker() {
    let fixture = Fixture::open(Some(false)).await;
    fixture.worker.report.store(true, Ordering::SeqCst);
    let mut request = fixture.request("blocked-delivery", "modify", "changes");
    request.independent = true;
    request.writes = vec!["result.txt".into()];
    let execution = fixture.engine.delegate(request).await.unwrap();
    let candidate = fixture.wait(&execution).await;
    assert_eq!(candidate["status"], "awaitingDelivery");
    fixture.scopes.active_processes.store(1, Ordering::SeqCst);
    *fixture.model.read_execution.lock().unwrap() =
        Some(execution["executionId"].as_str().unwrap().into());
    fixture.model.release.add_permits(1);
    tokio::time::timeout(Duration::from_secs(5), fixture.model.started.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    let parent = fixture.engine.read(&fixture.parent, true).await.unwrap();
    let tool = parent.turns[0]
        .items
        .iter()
        .find_map(|item| match item {
            Item::DynamicToolCall {
                tool,
                success,
                content_items,
                ..
            } if tool == "agent_wait" => {
                assert_eq!(*success, Some(true));
                Some(
                    serde_json::from_str::<Value>(
                        content_items.as_ref().unwrap()[0]["text"].as_str().unwrap(),
                    )
                    .unwrap(),
                )
            }
            _ => None,
        })
        .expect("wait must retain a structured delivery receipt");
    assert_eq!(tool["status"], "awaitingDelivery");
    assert_eq!(tool["settled"], false);
    assert_eq!(tool["delivery"]["status"], "candidate");
    assert!(
        tool["delivery"]["attemptError"]
            .as_str()
            .unwrap()
            .contains("workspace is busy")
    );
    assert_eq!(tool["text"], candidate["text"]);
    assert_ne!(tool["receiptVersion"], candidate["receiptVersion"]);
    assert!(!fixture.root.path().join("repo/result.txt").exists());
    assert_eq!(fixture.worker.attempts.load(Ordering::SeqCst), 1);
    fixture.scopes.active_processes.store(0, Ordering::SeqCst);
    *fixture.model.read_execution.lock().unwrap() = None;
    fixture.model.release.add_permits(8);
    let completed = tokio::time::timeout(
        Duration::from_secs(10),
        fixture.engine.wait(&fixture.parent),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(completed.turns[0].status, TurnStatus::Completed);
    assert_eq!(
        std::fs::read(fixture.root.path().join("repo/result.txt")).unwrap(),
        b"candidate"
    );
    assert_eq!(fixture.worker.attempts.load(Ordering::SeqCst), 1);
    fixture.close().await;
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
    assert_eq!(result["capabilities"]["networkPolicy"], "deny");
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
async fn inherited_inspection_runs_without_restricted_scopes_but_legacy_read_only_stays_strict() {
    let fixture = Fixture::open_with_limits(
        None,
        Limits {
            inspection_permissions: areal_config::InspectionPermissions::Inherit,
            ..Default::default()
        },
    )
    .await;
    fixture.scopes.unavailable.store(true, Ordering::SeqCst);
    let result = fixture
        .engine
        .delegate(fixture.request("inherit", "inspect", "report"))
        .await
        .unwrap();
    assert_eq!(result["strategy"], "sharedInherited");
    assert_eq!(result["capabilities"]["networkPolicy"], "inherit");
    let done = fixture.wait(&result).await;
    assert_eq!(done["status"], "completed");
    let child = fixture
        .engine
        .read(done["threadId"].as_str().unwrap(), true)
        .await
        .unwrap();
    assert!(!child.turns[0].configuration.as_ref().unwrap().read_only);
    assert!(
        child
            .desktop
            .as_ref()
            .unwrap()
            .execution_policy
            .deferred_write
    );
    assert_eq!(fixture.model.child_requests.load(Ordering::SeqCst), 1);
    let permissions = fixture.scopes.checks.lock().unwrap()[0]["permissions"].clone();
    assert!(permissions["readRoots"].is_null());
    assert!(permissions["writeRoots"].is_null());
    assert_eq!(permissions["network"], "inherit");
    let legacy=fixture.engine.spawn_configured_child(serde_json::from_value(json!({
        "parentThreadId":fixture.parent,"input":[{"type":"text","text":"legacy inspection"}],
        "workspaceMode":"sharedReadOnly"
    })).unwrap()).await;
    assert!(legacy.is_err());
    assert_eq!(fixture.model.child_requests.load(Ordering::SeqCst), 1);
    fixture.close().await;
}

#[tokio::test]
async fn task_run_inspection_rejects_unavailable_scope_before_registering_a_worker() {
    use areal_protocol::tasks::{TaskCreate, TaskMode};
    let fixture = Fixture::open(None).await;
    fixture.scopes.unavailable.store(true, Ordering::SeqCst);
    let accepted = fixture
        .engine
        .task_create(
            "fixture".into(),
            TaskCreate {
                source_thread_id: None,
                request_id: "task-admission".into(),
                mode: TaskMode::Background,
                objective: "TASK_SCOPE_ROOT".into(),
                thread_id: None,
                interaction_mode: None,
                schedule: None,
                schedule_v2: None,
                token_budget: Some(100000),
                max_turns: Some(2),
                max_active_seconds: Some(30),
            },
        )
        .await
        .unwrap();
    let task_id = accepted["id"].as_str().unwrap();
    match tokio::time::timeout(Duration::from_secs(5), fixture.model.started.acquire()).await {
        Ok(permit) => permit.unwrap().forget(),
        Err(_) => panic!(
            "TaskRun coordinator did not start: {:?}",
            fixture.engine.task_read(task_id).await.unwrap()
        ),
    }
    let task = fixture.engine.task_read(task_id).await.unwrap();
    let parent = task.runs.last().unwrap().thread_id.clone().unwrap();
    let mut request = fixture.request("task-inspect", "inspect", "report");
    request.parent_thread_id = parent;
    let result = fixture.engine.delegate(request).await.unwrap();
    assert_eq!(result["status"], "failed");
    assert_eq!(fixture.model.child_requests.load(Ordering::SeqCst), 0);
    assert!(
        fixture
            .engine
            .task_read(task_id)
            .await
            .unwrap()
            .runs
            .last()
            .unwrap()
            .workers
            .is_empty()
    );
    assert_eq!(
        fixture.engine.list(None, 100, None).await.unwrap().0.len(),
        2
    );
    assert_eq!(fixture.scopes.checks.lock().unwrap().len(), 1);
    fixture.model.release.add_permits(1);
    fixture.close().await;
}

#[tokio::test]
async fn task_run_inherited_inspection_runs_without_narrowing_the_scope() {
    use areal_protocol::tasks::{TaskCreate, TaskMode};
    let fixture = Fixture::open_with_limits(
        None,
        Limits {
            inspection_permissions: areal_config::InspectionPermissions::Inherit,
            ..Default::default()
        },
    )
    .await;
    fixture.scopes.unavailable.store(true, Ordering::SeqCst);
    let accepted = fixture
        .engine
        .task_create(
            "fixture".into(),
            TaskCreate {
                source_thread_id: None,
                request_id: "task-inherited".into(),
                mode: TaskMode::Background,
                objective: "TASK_SCOPE_ROOT".into(),
                thread_id: None,
                interaction_mode: None,
                schedule: None,
                schedule_v2: None,
                token_budget: Some(100000),
                max_turns: Some(2),
                max_active_seconds: Some(30),
            },
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), fixture.model.started.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    let task = fixture
        .engine
        .task_read(accepted["id"].as_str().unwrap())
        .await
        .unwrap();
    let parent = task.runs.last().unwrap().thread_id.clone().unwrap();
    let mut request = fixture.request("task-inspect-inherit", "inspect", "report");
    request.parent_thread_id = parent.clone();
    let result = fixture.engine.delegate(request).await.unwrap();
    assert_eq!(result["strategy"], "sharedInherited");
    let done = fixture
        .engine
        .execution_wait(&parent, result["executionId"].as_str().unwrap(), 5000)
        .await
        .unwrap();
    assert_eq!(done["status"], "completed");
    assert_eq!(fixture.model.child_requests.load(Ordering::SeqCst), 1);
    let worker = fixture
        .engine
        .read(done["threadId"].as_str().unwrap(), true)
        .await
        .unwrap();
    assert!(!worker.turns[0].configuration.as_ref().unwrap().read_only);
    assert!(worker.desktop.unwrap().execution_policy.deferred_write);
    let checks = fixture.scopes.checks.lock().unwrap().clone();
    assert_eq!(checks.len(), 1);
    assert_eq!(checks[0]["permissions"]["network"], "inherit");
    assert!(checks[0]["permissions"]["writeRoots"].is_null());
    fixture.close().await;
}

#[tokio::test]
async fn unavailable_read_only_scope_rejects_before_child_model_and_keeps_parent_usable() {
    let fixture = Fixture::open_with_limits(
        None,
        Limits {
            max_children_per_turn: 1,
            max_threads: 2,
            max_active_turns: 2,
            ..Default::default()
        },
    )
    .await;
    fixture.scopes.unavailable.store(true, Ordering::SeqCst);
    let request = fixture.request("blocked-inspection", "inspect", "report");
    let rejected = fixture.engine.delegate(request.clone()).await.unwrap();
    assert_eq!(rejected["status"], "failed");
    assert!(
        rejected.to_string().contains("before model start"),
        "{rejected}"
    );
    assert_eq!(fixture.model.child_requests.load(Ordering::SeqCst), 0);
    assert_eq!(
        fixture
            .engine
            .list(None, 50, Some(&fixture.parent))
            .await
            .unwrap()
            .0
            .len(),
        0
    );
    let repeated = fixture.engine.delegate(request).await.unwrap();
    assert_eq!(repeated["executionId"], rejected["executionId"]);
    let checks = fixture.scopes.checks.lock().unwrap().clone();
    assert_eq!(checks.len(), 1, "幂等读取不能重新检查或启动子任务");
    assert_eq!(checks[0]["permissions"]["network"], "deny");
    assert_eq!(checks[0]["permissions"]["writeRoots"], json!([]));
    assert_eq!(
        checks[0]["permissions"]["readRoots"],
        json!(["workspace://repo"])
    );
    // 外部能力确实改变后，一个新的请求可启动；旧失败记录仍保持失败。
    fixture.scopes.unavailable.store(false, Ordering::SeqCst);
    let accepted = fixture
        .engine
        .delegate(fixture.request("available-inspection", "inspect", "report"))
        .await
        .unwrap();
    assert_eq!(fixture.wait(&accepted).await["status"], "completed");
    assert_eq!(fixture.model.child_requests.load(Ordering::SeqCst), 1);
    fixture.close().await;
}

struct DelegationToolModel {
    unavailable: bool,
    child_requests: AtomicUsize,
}
#[async_trait]
impl Model for DelegationToolModel {
    fn name(&self) -> &str {
        "delegation-control-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, _: Vec<Value>) -> anyhow::Result<ModelStream> {
        if messages
            .iter()
            .any(|message| message.role == "user" && message.text_content() == "inspect-only")
        {
            self.child_requests.fetch_add(1, Ordering::SeqCst);
            return Ok(Box::pin(futures_util::stream::iter([Ok(
                ModelEvent::text("observed child result"),
            )])));
        }
        let tools: Vec<_> = messages
            .iter()
            .filter(|message| message.role == "tool")
            .collect();
        let event = match tools.len() {
            0 => ModelEvent::ToolCall(areal_engine::model::ToolCall {
                id: "inspection-request".into(),
                name: "agent_spawn".into(),
                arguments: json!({"prompt":"inspect-only","intent":"inspect","delivery":"report"})
                    .to_string(),
            }),
            1 => {
                let result: Value = serde_json::from_str(&tools[0].text_content())?;
                for field in ["owner", "parentThreadId", "threadId", "turnId"] {
                    assert!(result.get(field).is_none(), "{result}");
                }
                if self.unavailable {
                    assert_eq!(result["status"], "failed");
                    ModelEvent::text(
                        "Child capability unavailable; continuing locally within the existing permission boundary.",
                    )
                } else {
                    ModelEvent::ToolCall(areal_engine::model::ToolCall {
                        id: "recover-control-handles".into(),
                        name: "task_state".into(),
                        arguments: "{}".into(),
                    })
                }
            }
            2 => {
                let result: Value = serde_json::from_str(&tools[1].text_content())?;
                assert_eq!(result["executionCount"], 1);
                assert!(result["agents"][0].get("threadId").is_none());
                assert_eq!(
                    result["agents"][0]["executionId"],
                    result["executions"][0]["executionId"]
                );
                ModelEvent::ToolCall(areal_engine::model::ToolCall {
                    id: "wait-inspection".into(), name: "agent_wait".into(),
                    arguments: json!({"executionId":result["executions"][0]["executionId"],"timeoutMs":5000}).to_string(),
                })
            }
            3 => {
                let result: Value = serde_json::from_str(&tools[2].text_content())?;
                assert_eq!(result["status"], "completed");
                assert_eq!(result["text"], "observed child result");
                ModelEvent::text("Integrated the observed child result.")
            }
            _ => panic!("unexpected repeated delegation"),
        };
        Ok(Box::pin(futures_util::stream::iter([Ok(event)])))
    }
}

#[tokio::test]
async fn model_uses_one_execution_identity_and_rejected_spawn_is_not_reported_as_tool_success() {
    for unavailable in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("repo");
        let scratch = root.path().join("scratch");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::create_dir(&scratch).unwrap();
        let scopes = Arc::new(ScopeFixture::default());
        scopes.unavailable.store(unavailable, Ordering::SeqCst);
        let (runtime, peer) = runtime_with_scope(workspace.clone(), scopes).await;
        let model = Arc::new(DelegationToolModel {
            unavailable,
            child_requests: AtomicUsize::new(0),
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
                command_scratch: Some(scratch.clone()),
            },
        )
        .unwrap();
        let parent = engine
            .create(workspace.to_string_lossy().into_owned())
            .await
            .unwrap();
        engine
            .start(&parent.id, vec![Input::text("coordinate")])
            .await
            .unwrap();
        let finished = tokio::time::timeout(Duration::from_secs(10), engine.wait(&parent.id))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(finished.turns[0].status, TurnStatus::Completed);
        assert_eq!(
            model.child_requests.load(Ordering::SeqCst),
            usize::from(!unavailable)
        );
        let outcomes: Vec<_> = finished.turns[0]
            .items
            .iter()
            .filter_map(|item| {
                if let Item::DynamicToolCall { execution, .. } = item {
                    Some(execution.outcome.clone())
                } else {
                    None
                }
            })
            .collect();
        if unavailable {
            assert_eq!(outcomes, [ToolOutcome::Failed]);
            let parent_scratch = scratch.join(format!("agent-{}", parent.id));
            assert_eq!(
                std::fs::read_dir(&scratch)
                    .unwrap()
                    .map(|entry| entry.unwrap().path())
                    .collect::<Vec<_>>(),
                std::slice::from_ref(&parent_scratch),
                "只允许父会话自己的 scratch，不能遗留子会话目录"
            );
            assert_eq!(
                std::fs::read_dir(parent_scratch).unwrap().count(),
                0,
                "未准入子任务不能遗留空 scratch"
            );
        } else {
            assert_eq!(
                outcomes,
                [
                    ToolOutcome::Succeeded,
                    ToolOutcome::Succeeded,
                    ToolOutcome::Succeeded
                ]
            );
            let records = engine.execution_list(&parent.id, 0, 50).await.unwrap();
            assert!(
                records["data"][0]["threadId"].is_string(),
                "客户端仍保留完整身份"
            );
            let spawn = finished.turns[0]
                .items
                .iter()
                .find_map(|item| match item {
                    Item::DynamicToolCall {
                        tool,
                        content_items: Some(parts),
                        ..
                    } if tool == "agent_spawn" => Some(parts),
                    _ => None,
                })
                .unwrap();
            let receipt: Value = serde_json::from_str(spawn[0]["text"].as_str().unwrap()).unwrap();
            assert!(
                receipt["threadId"].is_string(),
                "持久工具原文须保留 GUI 子任务卡片关联；只有模型投影精简身份"
            );
        }
        engine.shutdown().await;
        runtime.shutdown().await.unwrap();
        peer.await.unwrap();
    }
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
    assert_eq!(result["capabilities"]["sourceView"], "currentShared");
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

#[tokio::test]
async fn slow_isolation_probe_does_not_block_another_parents_shared_child() {
    let fixture = Fixture::open(None).await;
    let factory = Arc::new(BlockingProbeFactory {
        started: Semaphore::new(0),
        release: Semaphore::new(0),
        finished: AtomicBool::new(false),
    });
    let workspace = fixture.root.path().join("repo");
    fixture
        .engine
        .attach_automatic_workgroups(
            Service::open_automatic(
                &fixture.root.path().join("slow-service"),
                &workspace,
                factory.clone(),
                1,
            )
            .unwrap(),
        )
        .unwrap();
    let other = fixture
        .engine
        .create(workspace.to_string_lossy().into_owned())
        .await
        .unwrap();
    fixture
        .engine
        .start(&other.id, vec![Input::text("root")])
        .await
        .unwrap();
    fixture.model.started.acquire().await.unwrap().forget();
    let mut request = fixture.request("slow-isolated", "modify", "patch");
    request.writes = vec!["result.txt".into()];
    let engine = fixture.engine.clone();
    let slow = tokio::spawn(async move { engine.delegate(request).await });
    factory.started.acquire().await.unwrap().forget();
    let mut request = fixture.request("other-inspection", "inspect", "report");
    request.parent_thread_id = other.id.clone();
    let accepted = tokio::time::timeout(Duration::from_secs(2), fixture.engine.delegate(request))
        .await
        .expect("另一个父任务不能排在全局委派探针之后")
        .unwrap();
    assert_eq!(
        fixture
            .engine
            .execution_wait(&other.id, accepted["executionId"].as_str().unwrap(), 5000)
            .await
            .unwrap()["status"],
        "completed"
    );
    assert!(!factory.finished.load(Ordering::SeqCst));
    factory.release.add_permits(1);
    let _ = tokio::time::timeout(Duration::from_secs(5), slow)
        .await
        .unwrap()
        .unwrap();
    fixture.close().await;
}

#[tokio::test]
async fn isolated_admission_rechecks_cumulative_limit_after_a_slow_probe() {
    let fixture = Fixture::open_with_limits(
        None,
        Limits {
            max_children_per_turn: 1,
            ..Default::default()
        },
    )
    .await;
    let factory = Arc::new(BlockingProbeFactory {
        started: Semaphore::new(0),
        release: Semaphore::new(0),
        finished: AtomicBool::new(false),
    });
    fixture
        .engine
        .attach_automatic_workgroups(
            Service::open_automatic(
                &fixture.root.path().join("slow-service"),
                &fixture.root.path().join("repo"),
                factory.clone(),
                1,
            )
            .unwrap(),
        )
        .unwrap();
    let mut request = fixture.request("slow-isolated", "modify", "patch");
    request.writes = vec!["result.txt".into()];
    let engine = fixture.engine.clone();
    let pending = tokio::spawn(async move { engine.delegate(request).await });
    factory.started.acquire().await.unwrap().forget();
    let (child, _) = fixture
        .engine
        .spawn_child(&fixture.parent, vec![Input::text("legacy child")])
        .await
        .unwrap();
    fixture.engine.wait(&child.id).await.unwrap();
    factory.release.add_permits(1);
    let result = tokio::time::timeout(Duration::from_secs(5), pending)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(result["status"], "failed");
    assert!(
        result["error"]
            .as_str()
            .unwrap()
            .contains("child admission exhausted during capability check"),
        "{result}"
    );
    assert_eq!(fixture.model.child_requests.load(Ordering::SeqCst), 1);
    fixture.close().await;
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
        scopes: _,
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
