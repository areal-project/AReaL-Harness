use super::*;
use areal_engine::model::{Message, Model, ModelEvent, ModelStream, RequestPurpose, ToolCall};

struct Complete;
#[async_trait::async_trait]
impl Model for Complete {
    fn name(&self) -> &str {
        "manual-run-fixture"
    }
    async fn stream(&self, messages: Vec<Message>) -> anyhow::Result<ModelStream> {
        self.chat_limited(messages, vec![], RequestPurpose::Solve, None)
            .await
    }
    async fn chat_limited(
        &self,
        messages: Vec<Message>,
        _: Vec<Value>,
        _: RequestPurpose,
        _: Option<u64>,
    ) -> anyhow::Result<ModelStream> {
        let view: Value = messages
            .iter()
            .rev()
            .find_map(|m| {
                m.text_content()
                    .split("Current authoritative goal: ")
                    .nth(1)
                    .and_then(|text| serde_json::from_str(text).ok())
            })
            .unwrap();
        let event = if view["goal"]["report"]["status"] == "complete" {
            ModelEvent::TextDelta("manual fixture complete".into())
        } else {
            ModelEvent::ToolCall(ToolCall { id: uuid::Uuid::new_v4().to_string(), name: "goal_update".into(), arguments: json!({"expectedRevision":view["revision"],"status":"complete","summary":"manual fixture report","evidence":["deterministic model"],"remaining":[]}).to_string() })
        };
        Ok(Box::pin(futures_util::stream::iter(vec![
            Ok(event),
            Ok(ModelEvent::Usage(areal_protocol::ModelUsage {
                input_tokens: 50_000,
                cached_input_tokens: 0,
                output_tokens: 50_000,
            })),
        ])))
    }
}
fn connect(principal: Arc<auth::Principal>) -> (Connection, mpsc::Receiver<Outbound>) {
    let (tx, rx) = mpsc::channel(128);
    let stop = CancellationToken::new();
    let tool_host =
        dynamic_tools::ToolHost::authenticated(tx.clone(), stop.clone(), principal.id.clone());
    (
        Connection {
            configuration: None,
            experimental_api: false,
            principal,
            tool_host,
            initialized: true,
            ready: true,
            owner_subscription: None,
            subscriptions: HashMap::new(),
            suppressed: HashSet::new(),
            tx,
            process_connection: areal_engine::desktop::ProcessConnection::new(stop.clone()),
            stop,
            tasks: TaskTracker::new(),
            delivery: Arc::new(Mutex::new(())),
            rpc_permits: Arc::new(tokio::sync::Semaphore::new(16)),
        },
        rx,
    )
}
fn open(path: &std::path::Path) -> Arc<Engine> {
    Engine::open(
        path,
        Arc::new(Complete),
        areal_engine::Limits {
            max_threads: 300,
            ..Default::default()
        },
    )
    .unwrap()
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
async fn create(
    engine: &Arc<Engine>,
    conn: &mut Connection,
    name: &str,
    at: u64,
    interval: Option<u64>,
    budget: Option<u64>,
) -> Value {
    let thread = engine.create(engine.default_cwd()).await.unwrap();
    conn.dispatch(engine,"areal/task/create",json!({"requestId":format!("create-{name}"),"mode":"scheduled","objective":name,"threadId":thread.id,"schedule":{"at":at,"intervalSeconds":interval},"tokenBudget":budget})).await.unwrap()
}
async fn read(engine: &Arc<Engine>, conn: &mut Connection, task: &Value) -> Value {
    conn.dispatch(engine, "areal/task/read", json!({"taskId":task["id"]}))
        .await
        .unwrap()
}
async fn status(
    engine: &Arc<Engine>,
    conn: &mut Connection,
    task: &Value,
    expected: &str,
) -> Value {
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let value = read(engine, conn, task).await;
            if value["runs"]
                .as_array()
                .unwrap()
                .last()
                .is_some_and(|run| run["status"] == expected)
            {
                return value;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    match result {
        Ok(value) => value,
        Err(_) => panic!("waiting for {expected}: {}", read(engine, conn, task).await),
    }
}
async fn prepare(rx: &mut mpsc::Receiver<Outbound>) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let Outbound::Message(value) = rx.recv().await.unwrap() else {
                continue;
            };
            if value["method"] == "areal/task/prepare" {
                return value;
            }
        }
    })
    .await
    .unwrap()
}
fn request(task: &Value, id: &str) -> Value {
    json!({"requestId":id,"taskId":task["id"],"expectedRevision":task["revision"]})
}
fn plan(task: &Value) -> Value {
    json!({"schedule":task["schedule"],"nextRunAt":task["nextRunAt"],"paused":task["paused"],"skippedRuns":task["skippedRuns"]})
}

#[tokio::test]
async fn desktop_tool_readiness_requires_unrestricted_manage_and_tools_and_fixed_bundles() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path());
    let owner = auth::Principal::embedded();
    let request = json!({"bundles":["areal.browser.v1","areal.computer.v1"]});
    for denied in [auth::Permission::Manage, auth::Permission::Tools] {
        let mut principal = (*owner).clone();
        principal.permissions.remove(&denied);
        let (mut conn, _rx) = connect(Arc::new(principal));
        assert_eq!(
            conn.dispatch(&engine, "areal/task/tools/ready", request.clone())
                .await
                .unwrap_err()
                .code,
            -32003
        );
        conn.stop.cancel();
    }
    let (mut scoped, _rx) = connect(Arc::new(auth::Principal {
        thread_ids: Some(Default::default()),
        ..(*owner).clone()
    }));
    assert_eq!(
        scoped
            .dispatch(&engine, "areal/task/tools/ready", request.clone())
            .await
            .unwrap_err()
            .code,
        -32003
    );
    scoped.stop.cancel();
    let (mut conn, _rx) = connect(owner.clone());
    for invalid in [
        json!({}),
        json!({"bundles":["other"]}),
        json!({"bundles":[],"hostId":"forged"}),
        json!({"bundles":["areal.browser.v1","areal.browser.v1"]}),
    ] {
        assert_eq!(
            conn.dispatch(&engine, "areal/task/tools/ready", invalid)
                .await
                .unwrap_err()
                .code,
            -32602
        );
    }
    assert_eq!(
        conn.dispatch(&engine, "areal/task/tools/ready", request.clone())
            .await
            .unwrap(),
        json!({"ready":true})
    );
    assert_eq!(
        conn.dispatch(&engine, "areal/task/tools/ready", request.clone())
            .await
            .unwrap(),
        json!({"ready":true})
    );
    let (mut successor, _rx) = connect(owner);
    assert_eq!(
        successor
            .dispatch(&engine, "areal/task/tools/ready", request.clone())
            .await
            .unwrap_err()
            .code,
        -32009
    );
    conn.stop.cancel();
    assert_eq!(
        successor
            .dispatch(&engine, "areal/task/tools/ready", request)
            .await
            .unwrap(),
        json!({"ready":true})
    );
    assert_eq!(
        successor
            .dispatch(&engine, "areal/task/tools/ready", json!({"bundles":[]}))
            .await
            .unwrap(),
        json!({"ready":true})
    );
    successor.stop.cancel();
    engine.shutdown().await;
}

struct DesktopCalls {
    tool: &'static str,
    requests: std::sync::atomic::AtomicUsize,
}
#[async_trait::async_trait]
impl Model for DesktopCalls {
    fn name(&self) -> &str {
        "scheduled-desktop-callback-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        Ok(Box::pin(futures_util::stream::pending()))
    }
    async fn chat_limited(
        &self,
        _: Vec<Message>,
        tools: Vec<Value>,
        _: RequestPurpose,
        _: Option<u64>,
    ) -> anyhow::Result<ModelStream> {
        let request = self
            .requests
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        if request >= 2 {
            return self.stream(vec![]).await;
        }
        assert!(
            tools
                .iter()
                .any(|tool| tool["function"]["name"] == self.tool)
        );
        Ok(Box::pin(futures_util::stream::iter(vec![
            Ok(ModelEvent::ToolCall(ToolCall {
                id: format!("desktop-{request}"),
                name: self.tool.into(),
                arguments: json!({"operation":"observe","parameters":{}}).to_string(),
            })),
            Ok(ModelEvent::Usage(areal_protocol::ModelUsage {
                input_tokens: 100,
                cached_input_tokens: 0,
                output_tokens: 20,
            })),
        ])))
    }
}

async fn callback(
    engine: &Arc<Engine>,
    task: &Value,
    rx: &mut mpsc::Receiver<Outbound>,
    method: &str,
) -> Value {
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let Outbound::Message(value) = rx.recv().await.unwrap() else {
                continue;
            };
            if value["method"] == method {
                return value;
            }
        }
    })
    .await;
    match result {
        Ok(value) => value,
        Err(_) => {
            let task = engine
                .task_read(task["id"].as_str().unwrap())
                .await
                .unwrap();
            let thread = engine
                .read(task.runs[0].thread_id.as_ref().unwrap(), true)
                .await
                .unwrap();
            panic!(
                "waiting for {method}: {}",
                json!({"goal":thread.goals,"turnError":thread.turns.last().and_then(|turn| turn.error.as_ref())})
            );
        }
    }
}

#[tokio::test]
async fn scheduled_desktop_callbacks_use_gui_connection_and_never_replay_to_successor() {
    for (tool, bundle, prepare_method) in [
        ("browser_v1", "areal.browser.v1", "areal/browser/prepare"),
        ("computer_v1", "areal.computer.v1", "areal/computer/prepare"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(
            dir.path(),
            Arc::new(DesktopCalls {
                tool,
                requests: Default::default(),
            }),
            Default::default(),
        )
        .unwrap();
        let principal = auth::Principal::embedded();
        let (mut scheduler, mut scheduler_rx) = connect(principal.clone());
        let (mut gui, mut gui_rx) = connect(principal.clone());
        scheduler
            .dispatch(&engine, "areal/task/host/ready", json!({}))
            .await
            .unwrap();
        gui.dispatch(
            &engine,
            "areal/task/tools/ready",
            json!({"bundles":[bundle]}),
        )
        .await
        .unwrap();
        let task = create(&engine, &mut scheduler, tool, now(), None, None).await;
        let preparation = prepare(&mut scheduler_rx).await;
        scheduler.tool_host.respond(
            json!({"id":preparation["id"],"result":{"options":{"approvalTools":["browser_v1","computer_v1"]}}}),
        );
        let mut calls = Vec::new();
        for index in 0..2 {
            let plan = callback(&engine, &task, &mut gui_rx, prepare_method).await;
            gui.tool_host.respond(json!({"id":plan["id"],"result":{"preparedActionId":format!("plan-{index}"),"operation":"observe","parameters":{},"origin":"fixture","fingerprint":"fixture"}}));
            let thread_id = plan["params"]["threadId"].as_str().unwrap();
            let approval = tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    let interactions = engine.interactions(thread_id).await.unwrap();
                    if let Some(pending) = interactions["data"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|interaction| interaction["status"] == "pending")
                    {
                        break pending.clone();
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            gui.dispatch(&engine, "areal/interaction/respond", json!({"requestId":approval["requestId"],"threadId":thread_id,"turnId":approval["turnId"],"argumentsDigest":approval["argumentsDigest"],"decision":"allowOnce"})).await.unwrap();
            let call = callback(&engine, &task, &mut gui_rx, "item/tool/call").await;
            assert_eq!(call["params"]["tool"], tool);
            assert_eq!(call["params"]["callId"], format!("desktop-{index}"));
            assert_eq!(
                call["params"]["hostGeneration"],
                areal_engine::tools::DynamicToolHost::id(gui.tool_host.as_ref())
            );
            if index == 0 {
                gui.tool_host.respond(json!({"id":call["id"],"result":{"success":true,"contentItems":[{"type":"inputText","text":"desktop callback succeeded"}]}}));
            }
            calls.push(call);
        }
        gui.stop.cancel();
        let (mut successor, mut successor_rx) = connect(principal);
        successor
            .dispatch(
                &engine,
                "areal/task/tools/ready",
                json!({"bundles":[bundle]}),
            )
            .await
            .unwrap();
        let thread_id = calls[0]["params"]["threadId"].as_str().unwrap();
        tokio::time::timeout(Duration::from_secs(10), engine.wait(thread_id))
            .await
            .unwrap()
            .unwrap();
        let thread = engine.read(thread_id, true).await.unwrap();
        let outcomes = thread
            .turns
            .iter()
            .flat_map(|turn| &turn.items)
            .filter_map(|item| match item {
                areal_protocol::Item::DynamicToolCall { execution, .. } => {
                    Some(execution.outcome.clone())
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            outcomes,
            [
                areal_protocol::ToolOutcome::Succeeded,
                areal_protocol::ToolOutcome::Unknown
            ]
        );
        assert!(successor_rx.try_recv().is_err());
        while let Ok(Outbound::Message(value)) = scheduler_rx.try_recv() {
            assert_ne!(value["method"], "item/tool/call");
        }
        let current = read(&engine, &mut scheduler, &task).await;
        assert_eq!(current["runCount"], 1);
        assert!(
            engine
                .start(thread_id, vec![areal_protocol::Input::text("continue")])
                .await
                .is_err()
        );
        successor.stop.cancel();
        scheduler.stop.cancel();
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn manual_run_admission_precedes_prepare_and_receipts_survive_restart() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path());
    let owner = auth::Principal::embedded();
    let (mut conn, mut rx) = connect(owner.clone());
    conn.dispatch(&engine, "areal/task/host/ready", json!({}))
        .await
        .unwrap();
    let created = create(
        &engine,
        &mut conn,
        "frozen objective",
        now() + 86400,
        Some(86400),
        Some(1_000_000),
    )
    .await;
    let paused = conn
        .dispatch(&engine, "areal/task/pause", request(&created, "pause"))
        .await
        .unwrap();
    let original = request(&paused, "manual-original");
    let accepted = tokio::time::timeout(
        Duration::from_secs(2),
        conn.dispatch(&engine, "areal/task/runNow", original.clone()),
    )
    .await
    .expect("acceptance must not wait for Host preparation")
    .expect("runNow must admit one durable manual Run");
    assert_eq!(
        accepted,
        json!({"taskId":created["id"],"runId":accepted["runId"],"revision":paused["revision"].as_u64().unwrap()+1,"accepted":true})
    );
    let pending = prepare(&mut rx).await;
    assert_eq!(pending["params"]["runId"], accepted["runId"]);
    let current = read(&engine, &mut conn, &created).await;
    assert_eq!(plan(&current), plan(&paused));
    assert_eq!(current["runCount"], 1);
    assert_eq!(current["runs"][0]["trigger"], "manual");
    assert_eq!(current["runs"][0]["objective"], "frozen objective");
    assert!(current["runs"][0]["threadId"].is_null());
    let receipt = conn
        .dispatch(&engine, "areal/request/read", original.clone())
        .await
        .unwrap();
    assert_eq!(receipt["data"][0]["method"], "areal/task/runNow");
    assert_eq!(receipt["data"][0]["result"], accepted);
    let scoped = Arc::new(auth::Principal {
        thread_ids: Some([created["threadId"].as_str().unwrap().to_string()].into()),
        ..(*owner).clone()
    });
    let (mut restricted, _) = connect(scoped);
    assert_eq!(
        restricted
            .dispatch(&engine, "areal/request/read", original.clone())
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(
        restricted
            .dispatch(&engine, "areal/task/runNow", original.clone())
            .await
            .unwrap_err()
            .code,
        -32003
    );
    let denied = Arc::new(auth::Principal {
        thread_ids: Some(Default::default()),
        ..(*owner).clone()
    });
    let (mut hidden, _) = connect(denied);
    assert_eq!(
        hidden
            .dispatch(&engine, "areal/request/read", original.clone())
            .await
            .unwrap_err()
            .code,
        -32003
    );
    let mut mixed = original.clone();
    mixed["threadId"] = created["threadId"].clone();
    assert_eq!(
        conn.dispatch(&engine, "areal/request/read", mixed)
            .await
            .unwrap_err()
            .code,
        -32602
    );
    let mut extra = original.clone();
    extra["force"] = json!(true);
    assert_eq!(
        conn.dispatch(&engine, "areal/task/runNow", extra)
            .await
            .unwrap_err()
            .code,
        -32602
    );
    let updated=conn.dispatch(&engine,"areal/task/update",json!({"requestId":"edit-after-manual","taskId":created["id"],"expectedRevision":current["revision"],"objective":"next objective"})).await.unwrap();
    assert_eq!(updated["runs"][0]["objective"], "frozen objective");
    let overlap = conn
        .dispatch(&engine, "areal/task/runNow", request(&updated, "overlap"))
        .await
        .unwrap_err();
    assert_eq!(overlap.code, -32009);
    assert_eq!(
        overlap.data,
        Some(
            json!({"reason":"activeRun","taskId":created["id"],"runId":accepted["runId"],"revision":updated["revision"],"outcome":{"kind":"rejected"},"recovery":{"kind":"none"}})
        )
    );
    let mut altered = original.clone();
    altered["expectedRevision"] = updated["revision"].clone();
    assert_eq!(
        conn.dispatch(&engine, "areal/request/read", altered.clone())
            .await
            .unwrap_err()
            .code,
        -32009
    );
    assert_eq!(
        conn.dispatch(&engine, "areal/task/runNow", altered)
            .await
            .unwrap_err()
            .code,
        -32009
    );
    conn.stop.cancel();
    engine.shutdown().await;
    drop(conn);
    drop(engine);
    let reopened = open(dir.path());
    let (mut conn, mut rx) = connect(owner);
    assert_eq!(
        conn.dispatch(&reopened, "areal/request/read", original.clone())
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(
        conn.dispatch(&reopened, "areal/task/runNow", original.clone())
            .await
            .unwrap(),
        accepted
    );
    conn.dispatch(&reopened, "areal/task/host/ready", json!({}))
        .await
        .unwrap();
    let second = prepare(&mut rx).await;
    assert_eq!(second["params"]["runId"], accepted["runId"]);
    conn.tool_host.respond(
        json!({"id":second["id"],"error":{"code":-32000,"message":"prepare fixture failure"}}),
    );
    let blocked = status(&reopened, &mut conn, &created, "blocked").await;
    assert_eq!(blocked["runs"][0]["id"], accepted["runId"]);
    assert_eq!(plan(&blocked), plan(&paused));
    conn.dispatch(&reopened,"areal/task/resumeRun",json!({"requestId":"resume-same","taskId":created["id"],"expectedRevision":blocked["revision"],"expectedRunId":accepted["runId"]})).await.unwrap();
    let third = prepare(&mut rx).await;
    assert_eq!(third["params"]["runId"], accepted["runId"]);
    conn.tool_host
        .respond(json!({"id":third["id"],"result":{}}));
    let completed = status(&reopened, &mut conn, &created, "completed").await;
    assert_eq!(completed["runCount"], 1);
    assert_eq!(plan(&completed), plan(&paused));
    let goal = reopened
        .goal_get(completed["runs"][0]["threadId"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(goal["goal"]["objective"], "frozen objective");
    assert_eq!(
        conn.dispatch(&reopened, "areal/task/runNow", original)
            .await
            .unwrap(),
        accepted
    );
    conn.stop.cancel();
    reopened.shutdown().await;
}

#[tokio::test]
async fn manual_run_rejects_offline_cancelled_scoped_and_serializes_edit_and_due() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path());
    let (mut conn, mut rx) = connect(auth::Principal::embedded());
    let created = create(
        &engine,
        &mut conn,
        "guards",
        now() + 86400,
        Some(86400),
        None,
    )
    .await;
    assert!(
        conn.dispatch(&engine, "areal/task/runNow", request(&created, "offline"))
            .await
            .is_err()
    );
    assert_eq!(read(&engine, &mut conn, &created).await["runCount"], 0);
    conn.dispatch(&engine, "areal/task/host/ready", json!({}))
        .await
        .unwrap();
    let manual = request(&created, "manual-cas");
    let edit = json!({"requestId":"edit-cas","taskId":created["id"],"expectedRevision":created["revision"],"objective":"edited"});
    let (run, edit) = tokio::join!(
        dispatch(&engine, &conn.principal, "areal/task/runNow", manual),
        dispatch(&engine, &conn.principal, "areal/task/update", edit)
    );
    assert_ne!(run.is_ok(), edit.is_ok());
    let mut current = read(&engine, &mut conn, &created).await;
    if run.is_err() {
        conn.dispatch(
            &engine,
            "areal/task/runNow",
            request(&current, "manual-after-edit"),
        )
        .await
        .unwrap();
        current = read(&engine, &mut conn, &created).await;
    }
    let held = prepare(&mut rx).await;
    let (first, second) = tokio::join!(
        dispatch(
            &engine,
            &conn.principal,
            "areal/task/runNow",
            request(&current, "double-one")
        ),
        dispatch(
            &engine,
            &conn.principal,
            "areal/task/runNow",
            request(&current, "double-two")
        )
    );
    for error in [first.unwrap_err(), second.unwrap_err()] {
        assert_eq!(error.code, -32009);
        assert_eq!(error.data.unwrap()["runId"], held["params"]["runId"]);
    }
    let cancelled = conn
        .dispatch(
            &engine,
            "areal/task/cancel",
            request(&current, "cancel-held"),
        )
        .await
        .unwrap();
    conn.tool_host.respond(json!({"id":held["id"],"result":{}}));
    let stopped = status(&engine, &mut conn, &created, "cancelled").await;
    assert!(stopped["runs"][0]["threadId"].is_null());
    assert_eq!(
        conn.dispatch(
            &engine,
            "areal/task/runNow",
            request(&cancelled, "cancelled-run")
        )
        .await
        .unwrap_err()
        .code,
        -32009
    );
    let due = create(&engine, &mut conn, "due race", now(), Some(86400), None).await;
    let result = conn
        .dispatch(&engine, "areal/task/runNow", request(&due, "due-manual"))
        .await;
    let prepared = prepare(&mut rx).await;
    let current = read(&engine, &mut conn, &due).await;
    assert_eq!(current["runCount"], 1);
    if let Err(error) = result {
        assert_eq!(error.code, -32009);
        assert_eq!(error.data.unwrap()["runId"], prepared["params"]["runId"]);
    }
    conn.stop.cancel();
    engine.shutdown().await;
}

#[tokio::test]
async fn manual_run_completed_once_and_archived_usage_keep_total_budget() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path());
    let (mut conn, mut rx) = connect(auth::Principal::embedded());
    conn.dispatch(&engine, "areal/task/host/ready", json!({}))
        .await
        .unwrap();
    let host = conn.tool_host.clone();
    let responder = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            let Outbound::Message(value) = message else {
                continue;
            };
            if value["method"] == "areal/task/prepare" {
                host.respond(json!({"id":value["id"],"result":{}}));
            }
        }
    });
    let created = create(
        &engine,
        &mut conn,
        "budget history",
        now(),
        None,
        Some(26_000_000),
    )
    .await;
    let mut current = status(&engine, &mut conn, &created, "completed").await;
    assert!(current["nextRunAt"].is_null());
    assert_eq!(current["runs"][0]["trigger"], "schedule");
    let unchanged = plan(&current);
    let original = request(&current, "first-manual");
    let first = conn
        .dispatch(&engine, "areal/task/runNow", original.clone())
        .await
        .unwrap();
    current = status(&engine, &mut conn, &created, "completed").await;
    for index in 2..130 {
        conn.dispatch(
            &engine,
            "areal/task/runNow",
            request(&current, &format!("manual-{index}")),
        )
        .await
        .unwrap();
        current = status(&engine, &mut conn, &created, "completed").await;
    }
    assert_eq!(current["runCount"], 130);
    assert!(current["archivedRunCount"].as_u64().unwrap() >= 2);
    assert_eq!(plan(&current), unchanged);
    assert_eq!(
        conn.dispatch(&engine, "areal/request/read", original.clone())
            .await
            .unwrap()["data"][0]["result"],
        first
    );
    let exhausted = conn
        .dispatch(&engine, "areal/task/runNow", request(&current, "exhausted"))
        .await
        .unwrap();
    let blocked = status(&engine, &mut conn, &created, "blocked").await;
    assert_eq!(
        blocked["runs"].as_array().unwrap().last().unwrap()["id"],
        exhausted["runId"]
    );
    assert_eq!(
        blocked["runs"].as_array().unwrap().last().unwrap()["reason"],
        "task token budget exhausted"
    );
    assert_eq!(plan(&blocked), unchanged);
    conn.stop.cancel();
    engine.shutdown().await;
    drop(conn);
    responder.abort();
    let _ = responder.await;
}
