use super::*;
use crate::model::{Message, Model, ModelEvent, ModelStream, RequestPurpose, ToolCall};
use crate::workgroup::{
    self, Check, Executor,
    service::{Factory, Policy, Service, Start},
    tree::{self, File, Tree},
};
use async_trait::async_trait;
use std::sync::atomic::AtomicUsize;
use tokio::sync::Semaphore;

#[tokio::test]
async fn legacy_task_store_is_loaded_with_the_new_snapshot_version() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("desktop")).unwrap();
    std::fs::write(
        root.path().join("desktop/task-mode.json"),
        br#"{"version":1,"tasks":{},"receipts":[]}"#,
    )
    .unwrap();
    let tasks = Tasks::open(root.path()).unwrap();
    assert_eq!(tasks.state.lock().await.version, 2);
}

struct Coordinator {
    calls: AtomicUsize,
    started: Semaphore,
    release: Semaphore,
}

#[async_trait]
impl Model for Coordinator {
    fn name(&self) -> &str {
        "run-owned-isolated-worker"
    }

    fn capabilities(&self) -> crate::model::ModelCapabilities {
        let mut capabilities = crate::model::ModelCapabilities::text();
        capabilities.input.push(areal_protocol::Modality::Image);
        capabilities
    }

    async fn chat_limited(
        &self,
        messages: Vec<Message>,
        _: Vec<Value>,
        _: RequestPurpose,
        _: Option<u64>,
    ) -> anyhow::Result<ModelStream> {
        self.stream(messages).await
    }

    async fn stream(&self, messages: Vec<Message>) -> anyhow::Result<ModelStream> {
        if messages.iter().any(|message| {
            message
                .content
                .iter()
                .any(|part| matches!(part, crate::model::ContentPart::Image { .. }))
        }) {
            return Ok(Box::pin(futures_util::stream::iter([
                Ok(ModelEvent::text("image inspected")),
                Ok(ModelEvent::Usage(areal_protocol::ModelUsage {
                    input_tokens: 1,
                    cached_input_tokens: 0,
                    output_tokens: 1,
                })),
            ])));
        }
        let n = self.calls.fetch_add(1, Ordering::SeqCst);
        let event = if n == 0 {
            self.started.add_permits(1);
            self.release.acquire().await?.forget();
            ModelEvent::ToolCall(ToolCall {
                id: "wait".into(),
                name: "task_wait".into(),
                arguments: "{}".into(),
            })
        } else if n == 1 {
            assert!(
                messages
                    .iter()
                    .any(|message| message.text_content().contains("workerReport"))
            );
            let goal: Value = messages
                .iter()
                .rev()
                .find_map(|message| {
                    message
                        .text_content()
                        .split("Current authoritative goal: ")
                        .nth(1)
                        .and_then(|s| serde_json::from_str(s).ok())
                })
                .unwrap();
            ModelEvent::ToolCall(ToolCall {
                id: "complete".into(), name: "goal_update".into(),
                arguments:json!({"expectedRevision":goal["revision"],"status":"complete","summary":"isolated result checked","evidence":["worker report"],"remaining":[]}).to_string(),
            })
        } else {
            ModelEvent::text("isolated result delivered")
        };
        Ok(Box::pin(futures_util::stream::iter(vec![
            Ok(event),
            Ok(ModelEvent::Usage(areal_protocol::ModelUsage {
                input_tokens: 1,
                cached_input_tokens: 0,
                output_tokens: 1,
            })),
        ])))
    }
}

#[tokio::test]
async fn unified_task_worker_preserves_multimodal_input() {
    let root = tempfile::tempdir().unwrap();
    let model = Arc::new(Coordinator {
        calls: AtomicUsize::new(0),
        started: Semaphore::new(0),
        release: Semaphore::new(0),
    });
    let engine = Engine::open(root.path(), model.clone(), Limits::default()).unwrap();
    let task = engine
        .task_create(
            "owner".into(),
            TaskCreate {
                request_id: "create".into(),
                mode: TaskMode::Background,
                objective: "Inspect an image".into(),
                thread_id: None,
                interaction_mode: Some(InteractionMode::Headless),
                schedule: None,
                token_budget: Some(100000),
                max_turns: Some(4),
                max_active_seconds: Some(30),
            },
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), model.started.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    let task_id = task["id"].as_str().unwrap();
    let current = engine.task_read(task_id).await.unwrap();
    let result = engine
        .delegate(
            serde_json::from_value(json!({
                "requestId":"image-worker",
                "parentThreadId":current.runs[0].thread_id,
                "input":[{"type":"image","url":"https://example.com/fixture.png"}],
                "intent":"inspect","delivery":"report"
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(result["owner"]["kind"], "taskRun");
    let child = engine
        .wait(result["threadId"].as_str().unwrap())
        .await
        .unwrap();
    assert!(child.turns[0].items.iter().any(|item| {
        matches!(item, Item::UserMessage { content, .. } if matches!(content.as_slice(), [Input::Image { .. }]))
    }));
    assert!(child.turns[0].items.iter().any(|item| {
        matches!(item, Item::AgentMessage { text, .. } if text == "image inspected")
    }));
    model.release.add_permits(1);
    until(&engine, task_id, RunStatus::Completed).await;
    engine.shutdown().await;
}

struct Isolated {
    started: Semaphore,
    release: Semaphore,
    attempts: AtomicUsize,
}
struct FactoryFixture(Arc<Isolated>);
impl Factory for FactoryFixture {
    fn executor(&self, _: &Path, _: &Policy) -> anyhow::Result<Arc<dyn Executor>> {
        Ok(self.0.clone())
    }
    fn executor_for_goal(
        &self,
        root: &Path,
        policy: &Policy,
        _: Option<Arc<crate::goals::Budget>>,
    ) -> anyhow::Result<Arc<dyn Executor>> {
        // 此 fixture 不请求模型，仅验证 TaskRun 与 Workgroup 的生命周期绑定。
        self.executor(root, policy)
    }
}
#[async_trait]
impl Executor for Isolated {
    async fn attempt(
        &self,
        _: workgroup::Task,
        _: u32,
        mut base: Tree,
        _: Option<Tree>,
        _: String,
        cancel: CancellationToken,
    ) -> anyhow::Result<Tree> {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        self.started.add_permits(1);
        tokio::select! { _=cancel.cancelled()=>anyhow::bail!("cancelled"), permit=self.release.acquire()=>permit?.forget() }
        base.insert(
            "result.txt".into(),
            File {
                bytes: b"verified result".to_vec(),
                executable: false,
            },
        );
        Ok(base)
    }
    async fn verify(
        &self,
        tree: Tree,
        _: Vec<Vec<String>>,
        _: CancellationToken,
    ) -> anyhow::Result<Check> {
        Ok(Check {
            tree_hash: tree::digest(&tree),
            passed: true,
            output: "checked".into(),
        })
    }
}

async fn until(engine: &Engine, task_id: &str, status: RunStatus) -> Task {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let task = engine.task_read(task_id).await.unwrap();
            if task.runs.last().is_some_and(|run| run.status == status) {
                return task;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("task did not reach {status:?}"))
}

async fn fixture() -> (
    tempfile::TempDir,
    tempfile::TempDir,
    Arc<Engine>,
    Arc<Service>,
    Arc<Isolated>,
    String,
    String,
) {
    let root = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let model = Arc::new(Coordinator {
        calls: AtomicUsize::new(0),
        started: Semaphore::new(0),
        release: Semaphore::new(0),
    });
    let worker = Arc::new(Isolated {
        started: Semaphore::new(0),
        release: Semaphore::new(0),
        attempts: AtomicUsize::new(0),
    });
    let engine = Engine::open(root.path(), model.clone(), Limits::default()).unwrap();
    let service = Service::open(
        &root.path().join("workgroups"),
        workspace.path(),
        Policy {
            allowed_writes: vec!["result.txt".into()],
            allowed_directories: vec![],
            checks: vec![vec!["check".into()]],
            workers: 1,
            verifiers: 1,
            active_groups: 1,
            timeout_seconds: 30,
            command_timeout_ms: 1000,
            max_model_requests: 64,
        },
        Arc::new(FactoryFixture(worker.clone())),
    )
    .unwrap();
    engine.attach_workgroups(service.clone()).unwrap();
    let task = engine
        .task_create(
            "owner".into(),
            TaskCreate {
                request_id: "create".into(),
                mode: TaskMode::Background,
                objective: "Implement independent work".into(),
                thread_id: None,
                interaction_mode: Some(InteractionMode::Headless),
                schedule: None,
                token_budget: Some(100000),
                max_turns: Some(4),
                max_active_seconds: Some(30),
            },
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), model.started.acquire())
        .await
        .expect("coordinator did not start")
        .unwrap()
        .forget();
    let task_id = task["id"].as_str().unwrap().to_owned();
    let current = engine.task_read(&task_id).await.unwrap();
    let thread_id = current.runs[0].thread_id.clone().unwrap();
    let parent = engine.raw_cell(&thread_id).await.unwrap();
    let owner = engine.task_run_owner(&parent).await.unwrap().unwrap();
    let group = service
        .start_with_goal(
            format!("task:{task_id}/{}", current.runs[0].id),
            Start {
                request_id: "worker".into(),
                workers: Some(1),
                admission: workgroup::Admission::Fixed,
                plan: workgroup::Plan {
                    objective: "independent work".into(),
                    tasks: vec![workgroup::Task {
                        id: "worker".into(),
                        instruction: "write result".into(),
                        writes: vec!["result.txt".into()],
                        depends: vec![],
                        integration_depends: vec![],
                        checks: vec![],
                        configuration: None,
                    }],
                },
            },
            engine.shutdown.child_token(),
            engine.goals.budget(&parent.state.lock().await.thread),
        )
        .await
        .unwrap();
    let group_id = group["id"].as_str().unwrap().to_owned();
    let reference = ExecutionRef::Workgroup {
        workgroup_id: group_id.clone(),
        automatic: false,
    };
    {
        let mut state = parent.state.lock().await;
        let mut candidate = state.thread.clone();
        candidate
            .desktop
            .get_or_insert_with(Default::default)
            .executions
            .push(areal_protocol::delegation::ExecutionRecord {
                execution_id: "execution".into(),
                request_id: "worker".into(),
                request_hash: "fixture".into(),
                owner: owner.clone(),
                title: "isolated worker".into(),
                delivery: areal_protocol::delegation::Delivery::Patch,
                strategy: "isolated".into(),
                reason: "fixture".into(),
                execution: Some(reference.clone()),
                error: None,
                cancel_requested: false,
            });
        engine.persist(&candidate).await.unwrap();
        state.thread = candidate;
    }
    engine
        .register_task_execution(&owner, "execution", &reference)
        .await
        .unwrap();
    let revision = engine.task_read(&task_id).await.unwrap().revision;
    engine
        .register_task_execution(&owner, "execution", &reference)
        .await
        .unwrap();
    assert_eq!(revision, engine.task_read(&task_id).await.unwrap().revision);
    tokio::time::timeout(Duration::from_secs(5), worker.started.acquire())
        .await
        .expect("isolated worker did not start")
        .unwrap()
        .forget();
    model.release.add_permits(1);
    until(&engine, &task_id, RunStatus::WaitingForAgents).await;
    (root, workspace, engine, service, worker, task_id, group_id)
}

#[tokio::test]
async fn isolated_execution_survives_the_coordinator_turn_and_publishes_once() {
    let (_root, _workspace, engine, service, worker, task_id, group_id) = fixture().await;
    assert!(
        engine.server_status().await["activeTurns"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        service.read(&group_id, None).await.unwrap()["record"]["status"],
        "running"
    );
    worker.release.add_permits(1);
    let done = until(&engine, &task_id, RunStatus::Completed).await;
    assert_eq!(done.runs.len(), 1);
    assert!(done.runs[0].workers[0].settled);
    assert_eq!(done.runs[0].usage.turns_started, 2);
    engine.settle_task_workers(&done).await.unwrap();
    let task = engine.task_read(&task_id).await.unwrap();
    assert_eq!(
        task.messages
            .iter()
            .filter(|message| message.kind == "workerReport")
            .count(),
        1
    );
    let parent = engine
        .raw_cell(done.runs[0].thread_id.as_ref().unwrap())
        .await
        .unwrap();
    let thread = {
        let mut state = parent.state.lock().await;
        let mut candidate = state.thread.clone();
        candidate.desktop.as_mut().unwrap().executions[0].delivery =
            areal_protocol::delegation::Delivery::Changes;
        engine.persist(&candidate).await.unwrap();
        state.thread = candidate.clone();
        candidate
    };
    // 后端 completed、worker 已发布报告，也不能满足尚未写回的 Changes 交付。
    assert!(engine.task_workers_settled(&thread, true).await.is_err());
    engine.shutdown().await;
}

#[tokio::test]
async fn cancelling_the_task_cleans_its_isolated_execution() {
    let (_root, _workspace, engine, service, worker, task_id, group_id) = fixture().await;
    let task = engine.task_read(&task_id).await.unwrap();
    engine
        .task_control(
            "owner".into(),
            "cancel".into(),
            TaskControl {
                request_id: "cancel".into(),
                task_id: task_id.clone(),
                expected_revision: task.revision,
            },
        )
        .await
        .unwrap();
    let done = until(&engine, &task_id, RunStatus::Cancelled).await;
    assert!(done.runs[0].workers[0].settled);
    assert_ne!(done.runs[0].workers[0].status, "completed");
    assert_eq!(
        service.read(&group_id, None).await.unwrap()["record"]["cleanupConfirmed"],
        true
    );
    assert_eq!(worker.attempts.load(Ordering::SeqCst), 1);
    engine.shutdown().await;
}

#[tokio::test]
async fn candidate_without_active_turn_wakes_delivery_without_settling_or_redispatching() {
    let (root, workspace, engine, service, worker, task_id, _) = fixture().await;
    worker.release.add_permits(1);
    let done = until(&engine, &task_id, RunStatus::Completed).await;
    let thread_id = done.runs[0].thread_id.clone().unwrap();
    let policy = service.policy().clone();
    engine.shutdown().await;
    drop(engine);
    drop(service);

    let resumed = Engine::open(
        root.path(),
        Arc::new(Coordinator {
            calls: AtomicUsize::new(0),
            started: Semaphore::new(0),
            release: Semaphore::new(0),
        }),
        Limits::default(),
    )
    .unwrap();
    resumed
        .attach_workgroups(
            Service::open(
                &root.path().join("workgroups"),
                workspace.path(),
                policy,
                Arc::new(FactoryFixture(worker.clone())),
            )
            .unwrap(),
        )
        .unwrap();
    let parent = resumed.raw_cell(&thread_id).await.unwrap();
    {
        let mut state = parent.state.lock().await;
        let mut candidate = state.thread.clone();
        candidate.goals.goal.as_mut().unwrap().status = GoalStatus::Active;
        candidate.desktop.as_mut().unwrap().executions[0].delivery =
            areal_protocol::delegation::Delivery::Changes;
        resumed.persist(&candidate).await.unwrap();
        state.thread = candidate;
    }
    resumed
        .edit_task(&task_id, |task| {
            task.paused = false;
            task.messages.clear();
            task.runs[0].status = RunStatus::WaitingForAgents;
            task.runs[0].wait_requested = true;
            task.runs[0].workers[0].settled = false;
        })
        .await
        .unwrap();
    for _ in 0..2 {
        let task = resumed.task_read(&task_id).await.unwrap();
        resumed.settle_task_workers(&task).await.unwrap();
    }
    let task = resumed.task_read(&task_id).await.unwrap();
    assert!(!task.paused);
    assert!(!task.runs[0].wait_requested);
    assert!(!task.runs[0].workers[0].settled);
    assert_eq!(task.messages.len(), 1);
    assert_eq!(task.messages[0].id, "execution:delivery-ready");
    assert_eq!(worker.attempts.load(Ordering::SeqCst), 1);
    let thread = parent.state.lock().await.thread.clone();
    assert!(resumed.task_workers_settled(&thread, true).await.is_err());
    resumed.shutdown().await;
}

#[tokio::test]
async fn restart_preserves_unknown_isolated_work_and_never_replays_it() {
    let (root, workspace, engine, service, worker, task_id, group_id) = fixture().await;
    worker.release.add_permits(1);
    let done = until(&engine, &task_id, RunStatus::Completed).await;
    let thread_id = done.runs[0].thread_id.clone().unwrap();
    let policy = service.policy().clone();
    engine.shutdown().await;
    drop(engine);
    drop(service);

    // 模拟崩溃前已经持久化创建和运行状态、却没有保存最终结算的快照。
    let group_path = root
        .path()
        .join("workgroups")
        .join(&group_id)
        .join("run.json");
    let mut record: Value = serde_json::from_slice(&std::fs::read(&group_path).unwrap()).unwrap();
    record["status"] = json!("running");
    record["cleanupConfirmed"] = Value::Null;
    std::fs::write(&group_path, serde_json::to_vec(&record).unwrap()).unwrap();
    let task_path = root.path().join("desktop/task-mode.json");
    let mut tasks: Value = serde_json::from_slice(&std::fs::read(&task_path).unwrap()).unwrap();
    tasks["tasks"][&task_id]["runs"][0]["status"] = json!("running");
    tasks["tasks"][&task_id]["runs"][0]["workers"][0]["settled"] = json!(false);
    std::fs::write(task_path, serde_json::to_vec(&tasks).unwrap()).unwrap();

    let resumed = Engine::open(
        root.path(),
        Arc::new(Coordinator {
            calls: AtomicUsize::new(0),
            started: Semaphore::new(0),
            release: Semaphore::new(0),
        }),
        Limits::default(),
    )
    .unwrap();
    let recovered_service = Service::open(
        &root.path().join("workgroups"),
        workspace.path(),
        policy,
        Arc::new(FactoryFixture(worker.clone())),
    )
    .unwrap();
    resumed
        .attach_workgroups(recovered_service.clone())
        .unwrap();
    let task = resumed.task_read(&task_id).await.unwrap();
    assert_eq!(task.runs[0].status, RunStatus::Paused);
    assert!(!task.runs[0].workers[0].settled);
    assert_eq!(
        recovered_service.read(&group_id, None).await.unwrap()["record"]["status"],
        "unknown"
    );
    let thread = resumed.read(&thread_id, true).await.unwrap();
    assert!(resumed.task_workers_settled(&thread, true).await.is_err());
    assert_eq!(worker.attempts.load(Ordering::SeqCst), 1);
    resumed.shutdown().await;
}
