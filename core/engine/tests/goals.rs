use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelEvent, ModelStream, RequestPurpose, ToolCall},
};
use areal_protocol::{Input, ModelUsage, goals::*};
use async_trait::async_trait;
use futures_util::stream;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

struct Fixture {
    calls: AtomicUsize,
    report: bool,
    usage: bool,
    child: bool,
}
#[async_trait]
impl Model for Fixture {
    fn name(&self) -> &str {
        "goal-fixture"
    }
    async fn stream(&self, m: Vec<Message>) -> anyhow::Result<ModelStream> {
        self.chat(m, vec![]).await
    }
    async fn chat_limited(
        &self,
        m: Vec<Message>,
        t: Vec<Value>,
        _: RequestPurpose,
        cap: Option<u64>,
    ) -> anyhow::Result<ModelStream> {
        assert!(cap.is_none_or(|n| n > 0));
        self.chat(m, t).await
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<ModelStream> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        let has = |name: &str| tools.iter().any(|t| t["function"]["name"] == name);
        let view: Option<Value> = messages
            .iter()
            .rev()
            .filter_map(|m| {
                m.text_content()
                    .split("Current authoritative goal: ")
                    .nth(1)
                    .and_then(|s| serde_json::from_str(s).ok())
            })
            .next();
        let mut out = vec![Ok(ModelEvent::reasoning("inspect goal progress"))];
        if self.child && call == 0 {
            assert!(has("agent_spawn"));
            out.push(Ok(ModelEvent::ToolCall(ToolCall {
                id: format!("call-{call}"),
                name: "agent_spawn".into(),
                arguments: json!({"prompt":"Return the child result"}).to_string(),
            })));
        } else if self.report && has("goal_update") && call.is_multiple_of(2) {
            let v = view.unwrap();
            let complete = v["goal"]["usage"]["turnsStarted"].as_u64().unwrap() > 1;
            out.push(Ok(ModelEvent::ToolCall(ToolCall {id:format!("call-{call}"), name:"goal_update".into(), arguments:json!({"expectedRevision":v["revision"],"status":if complete {"complete"}else{"continue"},"summary":"fixture progress","evidence":["fixture check completed"],"remaining":if complete {vec![]}else{vec!["one more stage"]}}).to_string()})));
        } else {
            out.push(Ok(ModelEvent::TextDelta(
                "verified fixture response".into(),
            )));
        }
        if self.usage {
            out.push(Ok(ModelEvent::Usage(ModelUsage {
                input_tokens: 11,
                cached_input_tokens: 3,
                output_tokens: 7,
            })));
        }
        Ok(Box::pin(stream::iter(out)))
    }
}
fn model(report: bool, usage: bool) -> Arc<Fixture> {
    Arc::new(Fixture {
        calls: AtomicUsize::new(0),
        report,
        usage,
        child: false,
    })
}
fn request(thread_id: &str) -> GoalCreate {
    GoalCreate {
        interaction_mode: None,
        request_id: "create-1".into(),
        thread_id: thread_id.into(),
        expected_revision: 0,
        objective: "Finish both stages with evidence".into(),
        token_budget: None,
        max_turns: Some(5),
        max_active_seconds: None,
    }
}
async fn stopped(e: &Engine, id: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let v = e.goal_get(id).await.unwrap();
            if v["goal"]["status"] != "active" && v["goal"]["activeTurnId"].is_null() {
                return v;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap()
}
fn control(v: &Value, request_id: &str) -> GoalControl {
    GoalControl {
        request_id: request_id.into(),
        thread_id: v["threadId"].as_str().unwrap().into(),
        goal_id: v["goal"]["id"].as_str().unwrap().into(),
        expected_revision: v["revision"].as_u64().unwrap(),
    }
}

struct OversizedSummary {
    summaries: AtomicUsize,
    always_oversized: bool,
}

#[async_trait]
impl Model for OversizedSummary {
    fn name(&self) -> &str {
        "oversized-summary"
    }

    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }

    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<ModelStream> {
        self.chat_for(messages, tools, RequestPurpose::Solve).await
    }

    async fn chat_for(
        &self,
        _: Vec<Message>,
        _: Vec<Value>,
        purpose: RequestPurpose,
    ) -> anyhow::Result<ModelStream> {
        let mut events = if purpose == RequestPurpose::Summary {
            let attempt = self.summaries.fetch_add(1, Ordering::SeqCst);
            if self.always_oversized || attempt == 0 {
                // 多字节片段跨过上限，末尾用量必须仍被消费。
                vec![
                    Ok(ModelEvent::text("x".repeat(16 * 1024 - 1))),
                    Ok(ModelEvent::text("猫猫")),
                    Ok(ModelEvent::text("tail")),
                ]
            } else {
                vec![Ok(ModelEvent::text(
                    "Initial implementation recorded; verification remains unfinished.",
                ))]
            }
        } else {
            vec![Ok(ModelEvent::text("recorded result ".repeat(200)))]
        };
        events.push(Ok(ModelEvent::Usage(ModelUsage {
            input_tokens: 11,
            cached_input_tokens: 3,
            output_tokens: 7,
        })));
        Ok(Box::pin(stream::iter(events)))
    }
}

#[tokio::test]
async fn oversized_goal_summary_drains_usage_before_retry_or_fallback() {
    for always_oversized in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let model = Arc::new(OversizedSummary {
            summaries: AtomicUsize::new(0),
            always_oversized,
        });
        let limits = Limits {
            context_window_bytes: 2000,
            context_recent_bytes: 256,
            ..Limits::default()
        };
        let engine = Engine::open(dir.path(), model.clone(), limits).unwrap();
        let thread = engine.create("/workspace".into()).await.unwrap();
        let mut create = request(&thread.id);
        create.max_turns = Some(2);
        engine.goal_create("test".into(), create).await.unwrap();
        let done = stopped(&engine, &thread.id).await;
        assert_eq!(done["goal"]["status"], "budgetLimited", "{done}");
        assert_eq!(done["goal"]["usage"]["unknownRequests"], 0);
        assert_eq!(done["goal"]["usage"]["accountingComplete"], true);
        assert_eq!(model.summaries.load(Ordering::SeqCst), 2);
        assert_eq!(done["goal"]["usage"]["tokensUsed"], 72);
        let history = engine.read(&thread.id, true).await.unwrap();
        assert!(
            history
                .turns
                .iter()
                .all(|turn| turn.status == areal_protocol::TurnStatus::Completed)
        );
        let checkpoint = history.context_checkpoint.as_ref().unwrap();
        assert!(checkpoint.summary.len() <= 16 * 1024);
        assert_eq!(
            checkpoint.summary.starts_with("DEGRADED CONTEXT:"),
            always_oversized
        );
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn two_turn_goal_completes_once_and_retries_return_original_receipt() {
    let dir = tempfile::tempdir().unwrap();
    let m = model(true, true);
    let e = Engine::open(dir.path(), m.clone(), Limits::default()).unwrap();
    let t = e.create("/workspace".into()).await.unwrap();
    let first = e.goal_create("test".into(), request(&t.id)).await.unwrap();
    let done = stopped(&e, &t.id).await;
    assert_eq!(done["goal"]["status"], "completed");
    assert_eq!(done["goal"]["usage"]["turnsStarted"], 2);
    assert_eq!(done["goal"]["usage"]["tokensUsed"], 72);
    assert_eq!(done["goal"]["usage"]["cachedInputTokens"], 12);
    let history = e.read(&t.id, true).await.unwrap();
    assert_eq!(history.turns.len(), 2);
    assert!(history.turns.iter().all(|turn| turn.items.iter().any(|item| matches!(item, areal_protocol::Item::Reasoning {content, ..} if content == &["inspect goal progress"]))));
    assert_eq!(
        history.turns[1].goal.as_ref().unwrap().origin,
        "continuation"
    );
    assert_eq!(
        first,
        e.goal_create("test".into(), request(&t.id)).await.unwrap()
    );
    assert_eq!(m.calls.load(Ordering::SeqCst), 4);
    e.shutdown().await;
}
#[tokio::test]
async fn ordinary_turn_never_starts_a_goal_and_unreported_goals_stop() {
    let dir = tempfile::tempdir().unwrap();
    let m = model(false, true);
    let e = Engine::open(dir.path(), m.clone(), Limits::default()).unwrap();
    let t = e.create("/workspace".into()).await.unwrap();
    e.start(&t.id, vec![Input::text("ordinary")]).await.unwrap();
    e.wait(&t.id).await.unwrap();
    assert_eq!(m.calls.load(Ordering::SeqCst), 1);
    assert!(e.goal_get(&t.id).await.unwrap()["goal"].is_null());
    e.goal_create("test".into(), request(&t.id)).await.unwrap();
    let done = stopped(&e, &t.id).await;
    assert_eq!(done["goal"]["reason"], "progressUnreported");
    assert_eq!(done["goal"]["usage"]["turnsStarted"], 3);
    e.shutdown().await;
}
#[tokio::test]
async fn budget_stops_before_request_and_can_be_increased_without_reset() {
    let dir = tempfile::tempdir().unwrap();
    let m = model(true, true);
    let e = Engine::open(dir.path(), m.clone(), Limits::default()).unwrap();
    let t = e.create("/workspace".into()).await.unwrap();
    let mut r = request(&t.id);
    r.token_budget = Some(1);
    e.goal_create("test".into(), r).await.unwrap();
    let limited = stopped(&e, &t.id).await;
    assert_eq!(limited["goal"]["status"], "budgetLimited");
    assert_eq!(m.calls.load(Ordering::SeqCst), 0);
    let c = control(&limited, "edit");
    let updated = e
        .goal_control(
            "test".into(),
            "update".into(),
            c.clone(),
            Some(GoalUpdate {
                reopen_completed: false,
                control: c,
                objective: None,
                token_budget: Some(Some(100000)),
                max_turns: None,
                max_active_seconds: None,
            }),
        )
        .await
        .unwrap();
    e.goal_control(
        "test".into(),
        "resume".into(),
        control(&updated, "resume"),
        None,
    )
    .await
    .unwrap();
    let done = stopped(&e, &t.id).await;
    assert_eq!(done["goal"]["status"], "completed");
    assert_eq!(done["goal"]["usage"]["turnsStarted"], 2);
    e.shutdown().await;
}
#[tokio::test]
async fn unknown_usage_is_not_zero_or_automatically_retried() {
    let dir = tempfile::tempdir().unwrap();
    let m = model(false, false);
    let e = Engine::open(dir.path(), m.clone(), Limits::default()).unwrap();
    let t = e.create("/workspace".into()).await.unwrap();
    e.goal_create("test".into(), request(&t.id)).await.unwrap();
    let done = stopped(&e, &t.id).await;
    assert_eq!(done["goal"]["status"], "blocked");
    assert_eq!(done["goal"]["usage"]["unknownRequests"], 1);
    assert_eq!(done["goal"]["usage"]["accountingComplete"], false);
    assert!(done["goal"]["usage"]["reservedTokens"].as_u64().unwrap() > 0);
    assert_eq!(m.calls.load(Ordering::SeqCst), 1);
    e.shutdown().await;
}
#[tokio::test]
async fn goal_update_wire_preserves_null_budget_and_rejects_unknown_fields() {
    let v = json!({"requestId":"r","threadId":"t","expectedRevision":1,"goalId":"g","tokenBudget":null});
    let p: GoalUpdate = serde_json::from_value(v.clone()).unwrap();
    assert_eq!(p.token_budget, Some(None));
    let mut bad = v;
    bad["unexpected"] = json!(1);
    assert!(serde_json::from_value::<GoalUpdate>(bad).is_err());
}

struct Call {
    messages: Vec<Message>,
    tools: Vec<Value>,
    reply: tokio::sync::oneshot::Sender<Vec<ModelEvent>>,
}
impl Call {
    fn answer(self, text: &str) {
        self.send(vec![ModelEvent::TextDelta(text.into())]);
    }
    fn report(self, status: &str) {
        let view: Value = self
            .messages
            .iter()
            .rev()
            .find_map(|m| {
                m.text_content()
                    .split("Current authoritative goal: ")
                    .nth(1)
                    .and_then(|s| serde_json::from_str(s).ok())
            })
            .unwrap();
        self.send(vec![ModelEvent::ToolCall(ToolCall {
            id: "report".into(), name: "goal_update".into(),
            arguments: json!({"expectedRevision":view["revision"],"status":status,"summary":"verified progress","evidence":["observed fixture result"],"remaining":[]}).to_string(),
        })]);
    }
    fn send(self, mut events: Vec<ModelEvent>) {
        events.push(ModelEvent::Usage(ModelUsage {
            input_tokens: 11,
            cached_input_tokens: 3,
            output_tokens: 7,
        }));
        self.reply.send(events).unwrap();
    }
}
struct Controlled(tokio::sync::mpsc::UnboundedSender<Call>);
#[async_trait]
impl Model for Controlled {
    fn name(&self) -> &str {
        "controlled-goal"
    }
    async fn stream(&self, m: Vec<Message>) -> anyhow::Result<ModelStream> {
        self.chat(m, vec![]).await
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<ModelStream> {
        let (reply, rx) = tokio::sync::oneshot::channel();
        self.0
            .send(Call {
                messages,
                tools,
                reply,
            })
            .map_err(|_| anyhow::anyhow!("test receiver closed"))?;
        Ok(Box::pin(stream::iter(rx.await?.into_iter().map(Ok))))
    }
    async fn chat_limited(
        &self,
        m: Vec<Message>,
        t: Vec<Value>,
        _: RequestPurpose,
        _: Option<u64>,
    ) -> anyhow::Result<ModelStream> {
        self.chat(m, t).await
    }
}
fn controlled(
    limits: Limits,
) -> (
    tempfile::TempDir,
    Arc<Engine>,
    tokio::sync::mpsc::UnboundedReceiver<Call>,
) {
    let dir = tempfile::tempdir().unwrap();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let e = Engine::open(dir.path(), Arc::new(Controlled(tx)), limits).unwrap();
    (dir, e, rx)
}
async fn next(rx: &mut tokio::sync::mpsc::UnboundedReceiver<Call>) -> Call {
    tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn pause_settles_then_resume_keeps_unknown_reservations_and_clear_keeps_cas() {
    let (_dir, e, mut rx) = controlled(Limits::default());
    let t = e.create("/workspace".into()).await.unwrap();
    let created = e.goal_create("test".into(), request(&t.id)).await.unwrap();
    let pending = next(&mut rx).await;
    let pause = control(&created, "pause");
    let paused = e
        .goal_control("test".into(), "pause".into(), pause.clone(), None)
        .await
        .unwrap();
    let settled = stopped(&e, &t.id).await;
    assert_eq!(settled["goal"]["status"], "paused");
    assert_eq!(settled["goal"]["usage"]["unknownRequests"], 1);
    assert!(pending.reply.is_closed());
    assert_eq!(
        e.goal_control("test".into(), "pause".into(), pause, None)
            .await
            .unwrap(),
        paused
    );
    let stale = control(&paused, "stale");
    assert!(
        e.goal_control("test".into(), "resume".into(), stale, None)
            .await
            .is_err()
    );
    e.goal_control(
        "test".into(),
        "resume".into(),
        control(&settled, "resume"),
        None,
    )
    .await
    .unwrap();
    next(&mut rx).await.report("complete");
    next(&mut rx).await.answer("finished");
    let done = stopped(&e, &t.id).await;
    assert_eq!(done["goal"]["status"], "completed");
    assert_eq!(done["goal"]["usage"]["turnsStarted"], 2);
    assert_eq!(
        done["goal"]["usage"]["reservedTokens"],
        settled["goal"]["usage"]["reservedTokens"]
    );
    assert_eq!(done["goal"]["usage"]["accountingComplete"], false);
    assert!(!e.queue(&t.id).await.unwrap().paused);
    let cleared = e
        .goal_control("test".into(), "clear".into(), control(&done, "clear"), None)
        .await
        .unwrap();
    assert!(cleared["goal"].is_null());
    assert!(
        e.goal_create("test".into(), request(&t.id)).await.is_ok(),
        "duplicate create returns its original receipt"
    );
    assert!(e.goal_get(&t.id).await.unwrap()["goal"].is_null());
    let mut new = request(&t.id);
    new.request_id = "new".into();
    assert!(e.goal_create("test".into(), new.clone()).await.is_err());
    new.expected_revision = cleared["revision"].as_u64().unwrap();
    e.goal_create("test".into(), new).await.unwrap();
    next(&mut rx).await.report("complete");
    next(&mut rx).await.answer("new result");
    assert_eq!(stopped(&e, &t.id).await["goal"]["usage"]["tokensUsed"], 36);
    e.shutdown().await;
}

#[tokio::test]
async fn queued_input_invalidates_completion_and_precedes_automatic_continuation() {
    let (_dir, e, mut rx) = controlled(Limits::default());
    let t = e.create("/workspace".into()).await.unwrap();
    e.goal_create("test".into(), request(&t.id)).await.unwrap();
    next(&mut rx).await.report("complete");
    let final_reply = next(&mut rx).await;
    let queued = e
        .start_durable(
            "test".into(),
            areal_protocol::desktop::TurnStart {
                interaction_mode: None,
                request_id: "followup".into(),
                thread_id: t.id.clone(),
                input: vec![Input::text("also verify the new condition")],
                expected_config_revision: None,
            },
            true,
        )
        .await
        .unwrap();
    final_reply.answer("first stage");
    let second = next(&mut rx).await;
    assert!(
        second
            .messages
            .iter()
            .any(|m| m.text_content() == "also verify the new condition")
    );
    second.report("complete");
    next(&mut rx).await.answer("condition verified");
    assert_eq!(stopped(&e, &t.id).await["goal"]["status"], "completed");
    let history = e.read(&t.id, true).await.unwrap();
    assert_eq!(history.turns.len(), 2);
    assert_eq!(history.turns[1].goal.as_ref().unwrap().origin, "user");
    let queue = e.queue(&t.id).await.unwrap();
    assert_eq!(queue.items[0].id, queued["queueItemId"]);
    assert_eq!(
        queue.items[0].turn_id.as_deref(),
        Some(history.turns[1].id.as_str())
    );
    e.shutdown().await;
}

#[tokio::test]
async fn child_usage_is_charged_once_and_children_cannot_report_root_completion() {
    let (_dir, e, mut rx) = controlled(Limits::default());
    let t = e.create("/workspace".into()).await.unwrap();
    let mut r = request(&t.id);
    r.token_budget = Some(100000);
    let created = e.goal_create("test".into(), r).await.unwrap();
    let root = next(&mut rx).await;
    let (child, _) = e
        .spawn_child(&t.id, vec![Input::text("child task")])
        .await
        .unwrap();
    assert_eq!(
        child.goal_owner.as_ref().unwrap().goal_id,
        created["goal"]["id"]
    );
    let child_call = next(&mut rx).await;
    assert!(
        child_call
            .tools
            .iter()
            .any(|t| t["function"]["name"] == "goal_read")
    );
    assert!(
        !child_call
            .tools
            .iter()
            .any(|t| t["function"]["name"] == "goal_update")
    );
    child_call.answer("child verified");
    e.wait(&child.id).await.unwrap();
    root.report("complete");
    next(&mut rx).await.answer("all work verified");
    let done = stopped(&e, &t.id).await;
    assert_eq!(done["goal"]["status"], "completed");
    assert_eq!(done["goal"]["usage"]["tokensUsed"], 54);
    assert_eq!(done["goal"]["usage"]["cachedInputTokens"], 9);
    assert_eq!(done["goal"]["usage"]["turnsStarted"], 1);
    e.shutdown().await;
}

#[tokio::test]
async fn capacity_wait_can_be_paused_without_starting_an_extra_turn() {
    let l = Limits {
        max_active_turns: 1,
        ..Default::default()
    };
    let (_dir, e, mut rx) = controlled(l);
    let t = e.create("/workspace".into()).await.unwrap();
    let created = e.goal_create("test".into(), request(&t.id)).await.unwrap();
    let _pending = next(&mut rx).await;
    e.goal_control(
        "test".into(),
        "pause".into(),
        control(&created, "pause"),
        None,
    )
    .await
    .unwrap();
    let paused = stopped(&e, &t.id).await;
    let other = e.create("/other".into()).await.unwrap();
    e.start(&other.id, vec![Input::text("occupy capacity")])
        .await
        .unwrap();
    let occupied = next(&mut rx).await;
    e.goal_control(
        "test".into(),
        "resume".into(),
        control(&paused, "resume"),
        None,
    )
    .await
    .unwrap();
    let waiting = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let v = e.goal_get(&t.id).await.unwrap();
            if v["goal"]["waitingForCapacity"] == true {
                break v;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    e.goal_control(
        "test".into(),
        "pause".into(),
        control(&waiting, "pause-again"),
        None,
    )
    .await
    .unwrap();
    occupied.answer("done");
    e.wait(&other.id).await.unwrap();
    assert_eq!(stopped(&e, &t.id).await["goal"]["usage"]["turnsStarted"], 1);
    let paused = e.goal_get(&t.id).await.unwrap();
    e.goal_control(
        "test".into(),
        "resume".into(),
        control(&paused, "resume-again"),
        None,
    )
    .await
    .unwrap();
    next(&mut rx).await.report("complete");
    next(&mut rx).await.answer("done");
    assert_eq!(stopped(&e, &t.id).await["goal"]["usage"]["turnsStarted"], 2);
    e.shutdown().await;
}

#[tokio::test]
async fn restart_preserves_admission_and_unknown_usage_without_replaying_requests() {
    let (dir, e, mut rx) = controlled(Limits::default());
    let t = e.create("/workspace".into()).await.unwrap();
    e.goal_create("test".into(), request(&t.id)).await.unwrap();
    let _pending = next(&mut rx).await;
    // 复制已经落盘的准入和预留，模拟进程在请求返回前退出。
    let restored = tempfile::tempdir().unwrap();
    std::fs::copy(
        dir.path().join(format!("{}.json", t.id)),
        restored.path().join(format!("{}.json", t.id)),
    )
    .unwrap();
    std::fs::create_dir(restored.path().join("goals")).unwrap();
    for file in std::fs::read_dir(dir.path().join("goals")).unwrap() {
        let file = file.unwrap();
        std::fs::copy(
            file.path(),
            restored.path().join("goals").join(file.file_name()),
        )
        .unwrap();
    }
    e.shutdown().await;
    let m = model(true, true);
    let recovery = Engine::open(restored.path(), m.clone(), Limits::default()).unwrap();
    let paused = recovery.goal_get(&t.id).await.unwrap();
    assert_eq!(paused["goal"]["status"], "paused");
    assert_eq!(paused["goal"]["reason"], "serverRestarted");
    assert_eq!(paused["goal"]["usage"]["unknownRequests"], 1);
    assert_eq!(m.calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        recovery.read(&t.id, true).await.unwrap().turns[0].status,
        areal_protocol::TurnStatus::Interrupted
    );
    recovery
        .goal_control(
            "test".into(),
            "resume".into(),
            control(&paused, "resume"),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        stopped(&recovery, &t.id).await["goal"]["status"],
        "completed"
    );
    recovery.shutdown().await;
}

#[tokio::test]
async fn active_time_limit_cancels_an_inflight_request_and_never_continues() {
    let (_dir, e, mut rx) = controlled(Limits::default());
    let t = e.create("/workspace".into()).await.unwrap();
    let mut r = request(&t.id);
    r.max_active_seconds = Some(1);
    e.goal_create("test".into(), r).await.unwrap();
    let pending = next(&mut rx).await;
    let done = stopped(&e, &t.id).await;
    assert_eq!(done["goal"]["status"], "budgetLimited");
    assert!(
        done["goal"]["reason"]
            .as_str()
            .unwrap()
            .contains("GOAL_TIME_BUDGET")
    );
    assert!(pending.reply.is_closed());
    let thread = e.read(&t.id, true).await.unwrap();
    let outcome = thread.turns[0]
        .error
        .as_ref()
        .unwrap()
        .outcome
        .as_ref()
        .unwrap();
    assert_eq!(outcome.code, "AGENT_RUN_TIMEOUT");
    assert_eq!(outcome.source, "core_execution_budget");
    assert_eq!(done["goal"]["usage"]["turnsStarted"], 1);
    e.shutdown().await;
}

#[tokio::test]
async fn compaction_usage_belongs_to_the_goal_and_the_objective_survives() {
    let l = Limits {
        context_window_bytes: 5000,
        context_recent_bytes: 256,
        ..Default::default()
    };
    let (_dir, e, mut rx) = controlled(l);
    let t = e.create("/workspace".into()).await.unwrap();
    e.start(&t.id, vec![Input::text("initial investigation")])
        .await
        .unwrap();
    next(&mut rx).await.answer(&"old result ".repeat(250));
    e.wait(&t.id).await.unwrap();
    e.start(&t.id, vec![Input::text("more investigation")])
        .await
        .unwrap();
    next(&mut rx).await.answer(&"newer result ".repeat(220));
    e.wait(&t.id).await.unwrap();
    e.goal_create("test".into(), request(&t.id)).await.unwrap();
    let summary = next(&mut rx).await;
    assert_eq!(summary.messages.last().unwrap().role, "system");
    assert!(
        summary
            .messages
            .last()
            .unwrap()
            .text_content()
            .starts_with("Core compaction control")
    );
    assert!(summary.tools.is_empty());
    summary.answer("Earlier investigation is complete; now verify the new objective.");
    let solve = next(&mut rx).await;
    assert!(solve.messages.iter().any(|m| {
        m.text_content()
            .contains("Finish both stages with evidence")
    }));
    solve.report("complete");
    let mut calls = 3;
    let mut reply = next(&mut rx).await;
    if reply
        .messages
        .last()
        .unwrap()
        .text_content()
        .starts_with("Core compaction control")
    {
        reply.answer("Goal completion was verified and reported; provide the final reply.");
        calls += 1;
        reply = next(&mut rx).await;
    }
    reply.answer("verified");
    let done = stopped(&e, &t.id).await;
    assert_eq!(done["goal"]["status"], "completed");
    assert_eq!(done["goal"]["usage"]["tokensUsed"], calls * 18);
    assert!(
        e.read(&t.id, true)
            .await
            .unwrap()
            .context_checkpoint
            .is_some()
    );
    e.shutdown().await;
}

#[tokio::test]
async fn completion_is_not_published_when_final_persistence_fails() {
    let (dir, e, mut rx) = controlled(Limits::default());
    let t = e.create("/workspace".into()).await.unwrap();
    e.goal_create("test".into(), request(&t.id)).await.unwrap();
    next(&mut rx).await.report("complete");
    let final_reply = next(&mut rx).await;
    let file = dir.path().join(format!("{}.json", t.id));
    std::fs::remove_file(&file).unwrap();
    std::fs::create_dir(&file).unwrap();
    final_reply.answer("done");
    let done = stopped(&e, &t.id).await;
    assert_eq!(done["goal"]["status"], "failed");
    assert!(matches!(
        e.read(&t.id, true).await.unwrap().status,
        areal_protocol::ThreadStatus::SystemError
    ));
    e.shutdown().await;
}

#[tokio::test]
async fn drain_wait_stops_continuation_but_allows_current_turn_to_finish() {
    let (_dir, e, mut rx) = controlled(Limits::default());
    let t = e.create("/workspace".into()).await.unwrap();
    e.goal_create("test".into(), request(&t.id)).await.unwrap();
    let current = next(&mut rx).await;
    let draining = e.clone();
    let task = tokio::spawn(async move { draining.drain("wait".into(), 5000).await });
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if e.goal_get(&t.id).await.unwrap()["goal"]["reason"] == "serverDraining" {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    current.send(vec![ModelEvent::ToolCall(ToolCall {id:"plan".into(),name:"plan_update".into(),arguments:json!({"expectedRevision":0,"steps":[{"id":"one","text":"Finish already active work","status":"completed"}]}).to_string()})]);
    let reply = next(&mut rx).await;
    assert!(
        reply
            .messages
            .iter()
            .any(|m| m.role == "tool" && m.text_content().contains("completed"))
    );
    reply.answer("current work settled");
    task.await.unwrap().unwrap();
    let done = stopped(&e, &t.id).await;
    assert_eq!(done["goal"]["status"], "paused");
    assert_eq!(done["goal"]["reason"], "serverDraining");
    assert_eq!(done["goal"]["usage"]["turnsStarted"], 1);
    assert_eq!(
        e.read(&t.id, true).await.unwrap().turns[0].status,
        areal_protocol::TurnStatus::Completed
    );
    e.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn ordinary_turn_model_and_capacity_waits_have_no_aggregate_deadline() {
    let (_dir, e, mut rx) = controlled(Limits {
        model_concurrency: 1,
        stream_idle_timeout: Duration::from_secs(600),
        ..Limits::default()
    });
    let first = e.create("/workspace".into()).await.unwrap();
    let second = e.create("/workspace".into()).await.unwrap();
    e.start(&first.id, vec![Input::text("first")])
        .await
        .unwrap();
    let pending = next(&mut rx).await;
    e.start(&second.id, vec![Input::text("queued")])
        .await
        .unwrap();
    tokio::time::advance(Duration::from_secs(301)).await;
    assert!(!pending.reply.is_closed());
    pending.answer("first completed");
    next(&mut rx).await.answer("second completed");
    for id in [&first.id, &second.id] {
        assert_eq!(
            e.wait(id).await.unwrap().turns[0].status,
            areal_protocol::TurnStatus::Completed
        );
    }
    e.shutdown().await;
}

#[tokio::test]
async fn live_goal_and_round_context_follow_a_stable_history_prefix() {
    let (_dir, e, mut rx) = controlled(Limits::default());
    let t = e.create("/workspace".into()).await.unwrap();
    e.start(&t.id, vec![Input::text("establish stable history")])
        .await
        .unwrap();
    next(&mut rx).await.answer("verified earlier evidence");
    e.wait(&t.id).await.unwrap();
    e.goal_create("test".into(), request(&t.id)).await.unwrap();
    let first = next(&mut rx).await;
    let dynamic = |m: &Message| {
        m.text_content().starts_with("Model round ")
            || m.text_content().contains("Current authoritative goal: ")
    };
    let boundary = first.messages.iter().position(dynamic).unwrap();
    let prefix: Vec<_> = first.messages[..boundary]
        .iter()
        .map(|m| (m.role.clone(), m.text_content()))
        .collect();
    assert!(
        prefix
            .iter()
            .any(|(_, text)| text == "verified earlier evidence")
    );
    assert!(
        first.messages[boundary..]
            .iter()
            .all(|m| m.role == "areal_context")
    );
    assert!(
        first
            .messages
            .iter()
            .any(|m| m.text_content().starts_with("Model round 1 "))
    );
    let first_messages = first.messages.clone();
    first.report("complete");
    let second = next(&mut rx).await;
    let next_prefix: Vec<_> = second.messages[..boundary]
        .iter()
        .map(|m| (m.role.clone(), m.text_content()))
        .collect();
    assert_eq!(prefix, next_prefix);
    // 包含 opaque context、工具调用和多模态内容，不仅比较可见文本。
    assert_eq!(
        &second.messages[..first_messages.len()],
        first_messages.as_slice()
    );
    assert!(
        second
            .messages
            .iter()
            .any(|m| m.text_content().starts_with("Model round 2 "))
    );
    assert_eq!(
        second
            .messages
            .iter()
            .filter(|m| m.text_content().contains("Current authoritative goal: "))
            .count(),
        2
    );
    second.answer("completed");
    assert_eq!(stopped(&e, &t.id).await["goal"]["status"], "completed");
    let before = e.context_read(&t.id, 0, 32).await.unwrap();
    e.shutdown().await;
    drop(e);
    let restored = Engine::open(_dir.path(), model(true, true), Limits::default()).unwrap();
    let after = restored.context_read(&t.id, 0, 32).await.unwrap();
    assert_eq!(before["data"], after["data"]);
    restored.shutdown().await;
}

#[tokio::test]
async fn unchanged_goal_state_is_not_repeated_but_goal_read_keeps_full_usage() {
    let (_dir, e, mut rx) = controlled(Limits::default());
    let t = e.create("/workspace".into()).await.unwrap();
    e.goal_create("test".into(), request(&t.id)).await.unwrap();
    let first = next(&mut rx).await;
    first.send(vec![ModelEvent::ToolCall(ToolCall {
        id: "read-goal".into(),
        name: "goal_read".into(),
        arguments: "{}".into(),
    })]);
    let second = next(&mut rx).await;
    let snapshots: Vec<_> = second
        .messages
        .iter()
        .filter(|m| {
            m.role == "areal_context" && m.text_content().contains("Current authoritative goal: ")
        })
        .collect();
    assert_eq!(snapshots.len(), 1);
    let text = snapshots[0].text_content();
    let view: Value =
        serde_json::from_str(text.split("Current authoritative goal: ").nth(1).unwrap()).unwrap();
    assert!(view["goal"]["usage"].get("tokensUsed").is_none());
    assert_eq!(view["goal"]["usage"]["turnsStarted"], 1);
    assert!(
        second
            .messages
            .iter()
            .any(|m| m.role == "tool" && m.text_content().contains("tokensUsed"))
    );
    second.report("complete");
    let final_reply = next(&mut rx).await;
    assert_eq!(
        final_reply
            .messages
            .iter()
            .filter(|m| m.role == "areal_context"
                && m.text_content().contains("Current authoritative goal: "))
            .count(),
        2
    );
    final_reply.answer("verified");
    assert_eq!(stopped(&e, &t.id).await["goal"]["status"], "completed");
    e.shutdown().await;
}

struct StreamingControlled(tokio::sync::mpsc::UnboundedSender<Call>);
#[async_trait]
impl Model for StreamingControlled {
    fn name(&self) -> &str {
        "streaming-controlled"
    }
    async fn stream(&self, messages: Vec<Message>) -> anyhow::Result<ModelStream> {
        self.chat(messages, vec![]).await
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<ModelStream> {
        use futures_util::StreamExt;
        let (reply, rx) = tokio::sync::oneshot::channel();
        self.0
            .send(Call {
                messages,
                tools,
                reply,
            })
            .map_err(|_| anyhow::anyhow!("test receiver closed"))?;
        Ok(Box::pin(
            stream::once(async move {
                rx.await
                    .unwrap_or_default()
                    .into_iter()
                    .map(Ok)
                    .collect::<Vec<_>>()
            })
            .flat_map(stream::iter),
        ))
    }
    async fn chat_limited(
        &self,
        m: Vec<Message>,
        t: Vec<Value>,
        _: RequestPurpose,
        _: Option<u64>,
    ) -> anyhow::Result<ModelStream> {
        self.chat(m, t).await
    }
}

#[tokio::test]
async fn goal_steering_settles_opening_and_streaming_requests_before_discarding_tools() {
    for streaming in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let model: Arc<dyn Model> = if streaming {
            Arc::new(StreamingControlled(tx))
        } else {
            Arc::new(Controlled(tx))
        };
        let engine = Engine::open(dir.path(), model, Limits::default()).unwrap();
        let thread = engine.create("/fixture".into()).await.unwrap();
        let mut req = request(&thread.id);
        req.token_budget = Some(1000000);
        engine.goal_create("test".into(), req).await.unwrap();
        let first = next(&mut rx).await;
        let turn = engine
            .read(&thread.id, true)
            .await
            .unwrap()
            .turns
            .last()
            .unwrap()
            .id
            .clone();
        engine
            .steer(
                &thread.id,
                &turn,
                vec![Input::text("LATEST: do not run the obsolete tool")],
            )
            .await
            .unwrap();
        // 超过旧的一秒 drain，确认不会先丢弃请求或派发新请求。
        assert!(
            tokio::time::timeout(Duration::from_millis(1200), rx.recv())
                .await
                .is_err()
        );
        assert!(!first.reply.is_closed());
        first.send(vec![ModelEvent::ToolCall(ToolCall {
            id: "obsolete".into(),
            name: "must_not_execute".into(),
            arguments: "{}".into(),
        })]);
        let revised = next(&mut rx).await;
        assert!(
            revised
                .messages
                .iter()
                .any(|m| m.role == "user" && m.text_content().contains("LATEST:"))
        );
        revised.report("complete");
        next(&mut rx)
            .await
            .answer("Completed current request without the obsolete side effect.");
        let done = stopped(&engine, &thread.id).await;
        assert_eq!(done["goal"]["status"], "completed");
        assert_eq!(done["goal"]["usage"]["unknownRequests"], 0);
        assert_eq!(done["goal"]["usage"]["reservedTokens"], 0);
        assert_eq!(done["goal"]["usage"]["tokensUsed"], 54);
        let history = engine.read(&thread.id, true).await.unwrap();
        assert!(!history.turns.iter().flat_map(|t|&t.items).any(|i|matches!(i,areal_protocol::Item::DynamicToolCall {tool,..} if tool=="must_not_execute")));
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn steering_a_goal_child_does_not_block_the_shared_parent_ledger() {
    let (dir, engine, mut rx) = controlled(Limits::default());
    let thread = engine.create("/fixture".into()).await.unwrap();
    engine
        .goal_create("test".into(), request(&thread.id))
        .await
        .unwrap();
    let parent = next(&mut rx).await;
    let (child, turn) = engine
        .spawn_child(
            &thread.id,
            vec![Input::text("Investigate a bounded subtask")],
        )
        .await
        .unwrap();
    let first = next(&mut rx).await;
    engine
        .steer(
            &child.id,
            &turn.id,
            vec![Input::text("CHILD CORRECTION: report only, no writes")],
        )
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(1200), rx.recv())
            .await
            .is_err()
    );
    first.answer("superseded response");
    let corrected = next(&mut rx).await;
    assert!(
        corrected
            .messages
            .iter()
            .any(|m| m.text_content().contains("CHILD CORRECTION"))
    );
    corrected.answer("Verified bounded findings");
    engine.wait(&child.id).await.unwrap();
    parent.report("complete");
    next(&mut rx)
        .await
        .answer("Complete using verified child findings");
    let done = stopped(&engine, &thread.id).await;
    assert_eq!(done["goal"]["status"], "completed");
    assert_eq!(done["goal"]["usage"]["unknownRequests"], 0);
    assert_eq!(done["goal"]["usage"]["tokensUsed"], 72);
    assert!(dir.path().exists());
    engine.shutdown().await;
}

#[tokio::test]
async fn completed_goal_requires_explicit_repair_and_keeps_identity_usage_and_history() {
    let dir = tempfile::tempdir().unwrap();
    let m = model(true, true);
    let e = Engine::open(dir.path(), m.clone(), Limits::default()).unwrap();
    let t = e.create("/workspace".into()).await.unwrap();
    e.goal_create("test".into(), request(&t.id)).await.unwrap();
    let done = stopped(&e, &t.id).await;
    assert_eq!(done["goal"]["status"], "completed");
    assert!(
        e.goal_control(
            "test".into(),
            "resume".into(),
            control(&done, "reject-resume"),
            None
        )
        .await
        .is_err()
    );
    let c = control(&done, "repair");
    let mut patch = GoalUpdate {
        control: c.clone(),
        reopen_completed: true,
        objective: None,
        token_budget: None,
        max_turns: None,
        max_active_seconds: None,
    };
    assert!(
        e.goal_control(
            "test".into(),
            "update".into(),
            c.clone(),
            Some(patch.clone())
        )
        .await
        .is_err()
    );
    patch.objective = Some("Repair independently verified acceptance defect".into());
    let repaired = e
        .goal_control(
            "test".into(),
            "update".into(),
            c.clone(),
            Some(patch.clone()),
        )
        .await
        .unwrap();
    assert_eq!(repaired["goal"]["status"], "paused");
    assert_eq!(repaired["goal"]["reason"], "repairRequested");
    for key in [
        "id",
        "usage",
        "maxActiveSeconds",
        "maxTurns",
        "tokenBudget",
        "report",
    ] {
        assert_eq!(repaired["goal"][key], done["goal"][key], "{key}");
    }
    assert_eq!(m.calls.load(Ordering::SeqCst), 4);
    assert_eq!(
        repaired,
        e.goal_control("test".into(), "update".into(), c, Some(patch))
            .await
            .unwrap()
    );
    let tasks = e.task_list().await;
    let task = tasks
        .iter()
        .find(|task| {
            task.runs
                .iter()
                .any(|run| run.goal_id.as_deref() == done["goal"]["id"].as_str())
        })
        .unwrap();
    assert!(task.paused);
    assert_eq!(task.runs.len(), 1);
    assert_eq!(
        task.runs[0].status,
        areal_protocol::tasks::RunStatus::Paused
    );
    assert!(task.runs[0].completed_at.is_none());
    e.goal_control(
        "test".into(),
        "resume".into(),
        control(&repaired, "resume-repair"),
        None,
    )
    .await
    .unwrap();
    let finished = stopped(&e, &t.id).await;
    assert_eq!(finished["goal"]["status"], "completed");
    assert_eq!(finished["goal"]["id"], done["goal"]["id"]);
    assert!(
        finished["goal"]["usage"]["turnsStarted"].as_u64().unwrap()
            > done["goal"]["usage"]["turnsStarted"].as_u64().unwrap()
    );
    let history = e.read(&t.id, true).await.unwrap();
    assert!(history.turns.len() > 2);
    assert!(history.turns.iter().all(|turn| turn.goal.as_ref().unwrap().goal_id == done["goal"]["id"].as_str().unwrap()));
    e.shutdown().await;
}

#[tokio::test]
async fn reopened_goal_remains_budget_limited_across_restart_and_rejects_stale_control() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(dir.path(), model(true, true), Limits::default()).unwrap();
    let t = e.create("/fixture".into()).await.unwrap();
    let mut req = request(&t.id);
    req.max_turns = Some(2);
    e.goal_create("test".into(), req).await.unwrap();
    let done = stopped(&e, &t.id).await;
    assert_eq!(done["goal"]["status"], "completed");
    assert_eq!(done["goal"]["usage"]["turnsStarted"], 2);
    let mut patch = GoalUpdate {
        control: control(&done, "repair"),
        reopen_completed: false,
        objective: Some("Correct an independently verified missing requirement".into()),
        token_budget: None,
        max_turns: None,
        max_active_seconds: None,
    };
    assert!(
        e.goal_control(
            "test".into(),
            "update".into(),
            patch.control.clone(),
            Some(patch.clone())
        )
        .await
        .is_err()
    );
    patch.reopen_completed = true;
    let opened = e
        .goal_control(
            "test".into(),
            "update".into(),
            patch.control.clone(),
            Some(patch),
        )
        .await
        .unwrap();
    let history = e.read(&t.id, true).await.unwrap();
    assert!(
        e.goal_control(
            "test".into(),
            "resume".into(),
            control(&done, "stale"),
            None
        )
        .await
        .is_err()
    );
    assert!(
        e.goal_control(
            "test".into(),
            "resume".into(),
            control(&opened, "exhausted"),
            None
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("exhausted")
    );
    e.shutdown().await;
    drop(e);
    let e = Engine::open(dir.path(), model(true, true), Limits::default()).unwrap();
    let restored = e.goal_get(&t.id).await.unwrap();
    assert_eq!(restored["goal"]["status"], "paused");
    let mut restored_usage = restored["goal"]["usage"].clone();
    let mut original_usage = opened["goal"]["usage"].clone();
    let restored_time = restored_usage
        .as_object_mut()
        .unwrap()
        .remove("timeUsedSeconds")
        .unwrap()
        .as_f64()
        .unwrap();
    let original_time = original_usage
        .as_object_mut()
        .unwrap()
        .remove("timeUsedSeconds")
        .unwrap()
        .as_f64()
        .unwrap();
    // JSON 浮点往返允许舍入误差；整数计量与预留必须逐项完全一致。
    assert!((restored_time - original_time).abs() < 1e-9);
    assert_eq!(restored_usage, original_usage);
    assert_eq!(
        serde_json::to_value(e.read(&t.id, true).await.unwrap().turns).unwrap(),
        serde_json::to_value(history.turns).unwrap()
    );
    assert!(
        e.goal_control(
            "test".into(),
            "resume".into(),
            control(&restored, "still-exhausted"),
            None
        )
        .await
        .is_err()
    );
    e.shutdown().await;
}
