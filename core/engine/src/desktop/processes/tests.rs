use super::*;
use areal_runtime_client::Client;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

struct NoModel;
#[async_trait::async_trait]
impl Model for NoModel {
    fn name(&self) -> &str {
        "resource-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<model::ModelStream> {
        unreachable!()
    }
}

struct Fixture {
    engine: Arc<Engine>,
    client: Arc<Client>,
    calls: Arc<std::sync::Mutex<Vec<Value>>>,
    task: tokio::task::JoinHandle<()>,
    _directory: tempfile::TempDir,
    root: rt::ScopeInfo,
    command: rt::ScopeInfo,
}

impl Fixture {
    async fn new(uncertain_start: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let epoch = uuid::Uuid::new_v4().to_string();
        let root: rt::ScopeInfo = serde_json::from_value(json!({
            "scopeId":format!("{epoch}:scope:{}",uuid::Uuid::new_v4()),
            "parentScopeId":null,"state":"active","owner":{"taskId":"fixture"},
            "readRoots":["workspace://repo"],"writeRoots":["workspace://repo"],"network":"deny",
            "limits":{"wallTimeMs":180000,"outputBytes":8388608,"maxProcesses":4},
            "activeProcesses":0,"outputBytes":0,"cleanupError":null
        }))
        .unwrap();
        let mut command = root.clone();
        command.parent_scope_id = Some(root.scope_id.clone());
        command.scope_id = format!("{epoch}:scope:{}", uuid::Uuid::new_v4());
        command.limits.wall_time_ms = 60000;
        let (pipe, peer) = tokio::io::duplex(128 * 1024);
        let (read, write) = tokio::io::split(pipe);
        let (peer_read, mut peer_write) = tokio::io::split(peer);
        let calls = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let observed = calls.clone();
        let scopes = [root.clone(), command.clone()];
        let task = tokio::spawn(async move {
            let mut scopes: BTreeMap<_, _> = scopes
                .into_iter()
                .map(|scope| (scope.scope_id.clone(), scope))
                .collect();
            let root = scopes
                .values()
                .find(|scope| scope.parent_scope_id.is_none())
                .unwrap()
                .scope_id
                .clone();
            let mut lines = BufReader::new(peer_read).lines();
            while let Some(line) = lines.next_line().await.unwrap() {
                let request: Value = serde_json::from_str(&line).unwrap();
                observed.lock().unwrap().push(request.clone());
                let params = &request["params"];
                let method = request["method"].as_str().unwrap();
                let result = match method {
                    "connection.open" => {
                        json!({"protocolVersion":"areal.runtime.v0","runtimeEpoch":epoch,
                        "connectionId":"fixture","rootScopeId":root,"capabilities":{"methods":["fs.execute","scope.check","process.start"],"filesystem":{"writeSerialization":"filePaths"}}})
                    }
                    "scope.get" | "scope.revoke" | "scope.waitClosed" => {
                        let mut scope = scopes[params["scopeId"].as_str().unwrap()].clone();
                        if method == "scope.waitClosed" {
                            scope.state = rt::ScopeState::Closed;
                        }
                        json!(scope)
                    }
                    "scope.create" => {
                        let mut scope = scopes[params["parentScopeId"].as_str().unwrap()].clone();
                        scope.parent_scope_id = Some(scope.scope_id.clone());
                        scope.scope_id = format!("{epoch}:scope:{}", uuid::Uuid::new_v4());
                        scopes.insert(scope.scope_id.clone(), scope.clone());
                        json!(scope)
                    }
                    "process.start" => {
                        if uncertain_start {
                            peer_write.write_all(format!("{}\n",json!({"id":request["id"],"error":{"code":"UNAVAILABLE","message":"start response lost"}})).as_bytes()).await.unwrap();
                            continue;
                        }
                        assert!(
                            params["limits"]["wallTimeMs"]
                                .as_u64()
                                .is_none_or(|timeout| timeout
                                    <= scopes[params["scopeId"].as_str().unwrap()]
                                        .limits
                                        .wall_time_ms)
                        );
                        json!({"processId":format!("{epoch}:process:{}",uuid::Uuid::new_v4()),"scopeId":params["scopeId"]})
                    }
                    "connection.close" => json!({"closed":true}),
                    _ => panic!("unexpected method {method}"),
                };
                peer_write
                    .write_all(
                        format!("{}\n", json!({"id":request["id"],"result":result})).as_bytes(),
                    )
                    .await
                    .unwrap();
                if method == "connection.close" {
                    break;
                }
            }
        });
        let client = Client::connect(read, write).await.unwrap();
        let workspace = directory.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let engine = Engine::open_with_runtime(
            &directory.path().join("data"),
            Arc::new(NoModel),
            Limits::default(),
            crate::tools::RuntimeConfig {
                client: client.clone(),
                workspace,
                writable: true,
                command_scope: Some(command.clone()),
                command_scratch: None,
            },
        )
        .unwrap();
        let deployment = directory.path().join("deployment.json");
        std::fs::write(
            &deployment,
            serde_json::to_vec(
                &json!({"profiles":[{"id":"services","revision":"v1","displayName":"Services",
            "instructions":"","allowThreadProcesses":true},
            {"id":"no-services","revision":"v1","displayName":"No services",
            "instructions":"","allowThreadProcesses":false}]}),
            )
            .unwrap(),
        )
        .unwrap();
        engine.install_deployment(&deployment).unwrap();
        Self {
            engine,
            client,
            calls,
            task,
            _directory: directory,
            root,
            command,
        }
    }
    async fn thread(&self) -> Thread {
        let thread = self
            .engine
            .create(
                self._directory
                    .path()
                    .join("workspace")
                    .to_string_lossy()
                    .into_owned(),
            )
            .await
            .unwrap();
        self.engine
            .configure_thread(
                serde_json::from_value(json!({"threadId":thread.id,"expectedRevision":1,
            "agentProfile":{"id":"services","revision":"v1"}}))
                .unwrap(),
            )
            .await
            .unwrap();
        self.engine.read(&thread.id, false).await.unwrap()
    }
    async fn close(self) {
        self.engine.shutdown().await;
        self.client.shutdown().await.unwrap();
        self.task.await.unwrap();
    }
}

fn request(thread: &Thread, timeout: u64) -> ProcessStart {
    serde_json::from_value(
        json!({"requestId":"service-start","threadId":thread.id,"lifetime":"thread",
        "argv":["fixture-service"],"timeoutMs":timeout}),
    )
    .unwrap()
}

#[tokio::test]
async fn development_service_visibility_matches_profile_admission() {
    for (profile, allowed) in [
        (None, false),
        (Some("no-services"), false),
        (Some("services"), true),
    ] {
        let fixture = Fixture::new(false).await;
        let thread = fixture
            .engine
            .create(
                fixture
                    ._directory
                    .path()
                    .join("workspace")
                    .to_string_lossy()
                    .into_owned(),
            )
            .await
            .unwrap();
        fixture
            .engine
            .configure_thread(
                serde_json::from_value(json!({
                    "threadId":thread.id,"expectedRevision":1,
                    "agentProfile":profile.map(|id| json!({"id":id,"revision":"v1"}))
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        let inspection = fixture.engine.inspect(&thread.id).await.unwrap();
        let tools = inspection["tools"].as_array().unwrap();
        assert_eq!(
            tools
                .iter()
                .any(|tool| tool["function"]["name"] == "development_service_start"),
            allowed,
            "profile {profile:?}"
        );
        assert!(
            tools
                .iter()
                .any(|tool| tool["function"]["name"] == "development_service_inspect")
        );
        // 隐藏 schema 不能替代执行授权；旧调用仍走相同的拒绝路径。
        let result = fixture
            .engine
            .process_start("fixture".into(), request(&thread, 120000))
            .await;
        if allowed {
            assert!(result.is_ok());
        } else {
            assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("profile does not authorize thread resources")
            );
        }
        assert_eq!(
            fixture
                .calls
                .lock()
                .unwrap()
                .iter()
                .filter(|call| call["method"] == "process.start")
                .count(),
            usize::from(allowed)
        );
        fixture.close().await;
    }
}

#[tokio::test]
async fn thread_service_uses_desktop_budget_without_relaxing_command_or_task_ancestry() {
    let fixture = Fixture::new(false).await;
    let thread = fixture.thread().await;
    let cell = fixture.engine.cell(&thread.id).await.unwrap();
    assert_eq!(
        fixture
            .engine
            .runtime_process_parent(&cell, false)
            .await
            .unwrap()
            .scope_id,
        fixture.command.scope_id
    );
    assert_eq!(
        fixture
            .engine
            .runtime_process_parent(&cell, true)
            .await
            .unwrap()
            .scope_id,
        fixture.root.scope_id
    );
    let owner = fixture.thread().await;
    cell.state.lock().await.thread.parent_thread_id = Some(owner.id);
    assert_eq!(
        fixture
            .engine
            .runtime_process_parent(&cell, true)
            .await
            .unwrap()
            .scope_id,
        fixture.command.scope_id
    );
    let denied = fixture
        .engine
        .process_start("fixture".into(), request(&thread, 120000))
        .await
        .unwrap_err();
    assert!(denied.to_string().contains("exceeds thread process parent"));
    cell.state.lock().await.thread.parent_thread_id = None;
    let started = fixture
        .engine
        .process_start("fixture".into(), request(&thread, 120000))
        .await
        .unwrap();
    let duplicate = fixture
        .engine
        .process_start("fixture".into(), request(&thread, 120000))
        .await
        .unwrap();
    assert_eq!(started, duplicate);
    assert_eq!(
        fixture
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call["method"] == "process.start")
            .count(),
        1
    );
    fixture
        .engine
        .process_start(
            "fixture".into(),
            ProcessStart {
                request_id: "inherited-budget".into(),
                timeout_ms: None,
                ..request(&thread, 120000)
            },
        )
        .await
        .unwrap();
    fixture.close().await;
}

#[tokio::test]
async fn oversize_service_is_rejected_before_receipt_and_uncertain_start_is_not_replayed() {
    for uncertain in [false, true] {
        let fixture = Fixture::new(uncertain).await;
        let thread = fixture.thread().await;
        let too_long = fixture
            .engine
            .process_start("fixture".into(), request(&thread, 180001))
            .await
            .unwrap_err();
        assert!(
            too_long
                .to_string()
                .contains("exceeds thread process parent")
        );
        let data = desktop(&fixture.engine.read(&thread.id, false).await.unwrap());
        assert!(data.processes.is_empty() && data.receipts.is_empty());
        let started = fixture
            .engine
            .process_start("fixture".into(), request(&thread, 120000))
            .await;
        assert_eq!(started.is_err(), uncertain);
        let duplicate = fixture
            .engine
            .process_start("fixture".into(), request(&thread, 120000))
            .await
            .unwrap();
        assert!(duplicate["id"].is_string());
        assert_eq!(
            fixture
                .calls
                .lock()
                .unwrap()
                .iter()
                .filter(|call| call["method"] == "process.start")
                .count(),
            1
        );
        fixture.close().await;
    }
}

#[test]
fn command_scope_with_additional_restrictions_cannot_be_bypassed() {
    let root: rt::ScopeInfo=serde_json::from_value(json!({"scopeId":"root","parentScopeId":null,"state":"active",
        "owner":{"taskId":"fixture"},"readRoots":["workspace://repo"],"writeRoots":["workspace://repo"],"network":"inherit",
        "limits":{"wallTimeMs":180000,"outputBytes":8000,"maxProcesses":4},"activeProcesses":0,"outputBytes":0,"cleanupError":null})).unwrap();
    let mut command = root.clone();
    command.parent_scope_id = Some(root.scope_id.clone());
    command.limits.wall_time_ms = 60000;
    assert!(command_budget_only(&command, &root));
    let mut narrowed = command.clone();
    narrowed.write_roots.clear();
    assert!(!command_budget_only(&narrowed, &root));
    narrowed = command.clone();
    narrowed.read_roots.clear();
    assert!(!command_budget_only(&narrowed, &root));
    narrowed = command.clone();
    narrowed.network = rt::NetworkRequest::Deny;
    assert!(!command_budget_only(&narrowed, &root));
    narrowed = command.clone();
    narrowed.limits.output_bytes = 1;
    assert!(!command_budget_only(&narrowed, &root));
    narrowed = command.clone();
    narrowed.limits.max_processes = 1;
    assert!(!command_budget_only(&narrowed, &root));
    narrowed = command.clone();
    narrowed.parent_scope_id = Some("another-task".into());
    assert!(!command_budget_only(&narrowed, &root));
}
