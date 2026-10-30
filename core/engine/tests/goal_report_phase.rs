use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelEvent, ModelStream, RequestPurpose, ToolCall, ToolCallLimits},
};
use areal_protocol::{Input, ModelUsage, goals::GoalCreate};
use async_trait::async_trait;
use futures_util::stream;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

#[derive(Clone, Copy)]
enum Reply {
    Complete,
    Continue,
    Ignore,
    Forbidden,
    Stale,
    Startup,
    Empty,
}
struct Reporter {
    calls: AtomicUsize,
    reports: AtomicUsize,
    reply: Reply,
}
#[async_trait]
impl Model for Reporter {
    fn name(&self) -> &str {
        "goal-report-phase-fixture"
    }
    async fn stream(&self, messages: Vec<Message>) -> anyhow::Result<ModelStream> {
        self.chat(messages, vec![]).await
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<ModelStream> {
        self.chat_with_limits(
            messages,
            tools,
            RequestPurpose::Solve,
            ToolCallLimits::default(),
            None,
        )
        .await
    }
    async fn chat_limited(
        &self,
        messages: Vec<Message>,
        tools: Vec<Value>,
        purpose: RequestPurpose,
        cap: Option<u64>,
    ) -> anyhow::Result<ModelStream> {
        self.chat_with_limits(messages, tools, purpose, ToolCallLimits::default(), cap)
            .await
    }
    async fn chat_with_limits(
        &self,
        messages: Vec<Message>,
        tools: Vec<Value>,
        _: RequestPurpose,
        limits: ToolCallLimits,
        _: Option<u64>,
    ) -> anyhow::Result<ModelStream> {
        if messages.iter().any(|m| {
            m.text_content()
                .starts_with("Generate a concise semantic session title")
        }) {
            return Ok(Box::pin(stream::iter([Ok(ModelEvent::text(
                "Report fixture",
            ))])));
        }
        self.calls.fetch_add(1, Ordering::SeqCst);
        let mut events = vec![];
        if limits.require_call {
            let attempt = self.reports.fetch_add(1, Ordering::SeqCst);
            assert_eq!(limits.max_calls, 1);
            assert_eq!(tools.len(), 2);
            let view: Value = messages
                .iter()
                .rev()
                .find_map(|m| {
                    m.text_content()
                        .split("Current authoritative goal: ")
                        .nth(1)
                        .and_then(|s| serde_json::from_str(s).ok())
                })
                .unwrap();
            let pending = view["goal"]["limitsPending"] == true;
            let write_tool = if pending {
                "goal_set_limits"
            } else {
                "goal_update"
            };
            assert!(
                tools
                    .iter()
                    .any(|tool| tool["function"]["name"] == write_tool)
            );
            assert!(
                tools
                    .iter()
                    .any(|tool| tool["function"]["name"] == "goal_read")
            );
            if pending {
                events.push(Ok(ModelEvent::ToolCall(ToolCall {
                    id: format!("limits-{attempt}"),
                    name: "goal_set_limits".into(),
                    arguments: json!({"expectedRevision":view["revision"],"sources":{}})
                        .to_string(),
                })));
            } else {
                match self.reply {
                Reply::Ignore => {
                    events.push(Ok(ModelEvent::text("Ordinary text is still not a report")))
                }
                Reply::Forbidden => events.push(Ok(ModelEvent::ToolCall(ToolCall {
                    id: format!("forbidden-{attempt}"),
                    name: "fs_write".into(),
                    arguments:
                        json!({"path":"workspace://repo/unrequested","content":"must not execute"})
                            .to_string(),
                }))),
                Reply::Stale if attempt == 1 => {
                    assert!(messages.iter().any(|m| {
                        m.role == "tool"
                            && m.text_content().contains("GOAL_REVISION_CONFLICT")
                            && m.text_content().contains("currentRevision")
                    }));
                    events.push(Ok(ModelEvent::ToolCall(ToolCall {
                        id: "read-current-goal".into(),
                        name: "goal_read".into(),
                        arguments: "{}".into(),
                    })));
                }
                _ => {
                    let complete = !matches!(self.reply, Reply::Continue)
                        || view["goal"]["usage"]["turnsStarted"].as_u64().unwrap() > 1;
                    let revision = view["revision"].as_u64().unwrap();
                    events.push(Ok(ModelEvent::ToolCall(ToolCall {
                        id:format!("report-{attempt}"),name:"goal_update".into(),
                        arguments:json!({"expectedRevision":if matches!(self.reply, Reply::Stale) && attempt == 0 {revision+1}else{revision},"status":if complete {"complete"}else{"continue"},"summary":"observed fixture stage","evidence":["fixture verification observed"],"remaining":if complete {vec![]}else{vec!["one remaining stage"]}}).to_string(),
                    })));
                }
            }
            }
        } else if !matches!(self.reply, Reply::Empty) || self.reports.load(Ordering::SeqCst) > 0 {
            events.push(Ok(ModelEvent::text(
                if self.reports.load(Ordering::SeqCst) > 0 {
                    "Recorded fixture handoff"
                } else {
                    "An unfinished ordinary handoff"
                },
            )));
        } else {
            events.push(Ok(ModelEvent::reasoning("fixture internal reasoning")));
        }
        events.push(Ok(ModelEvent::Usage(ModelUsage {
            input_tokens: 11,
            cached_input_tokens: 3,
            output_tokens: 7,
        })));
        Ok(Box::pin(stream::iter(events)))
    }
}

async fn stopped(engine: &Engine, thread: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let state = engine.goal_get(thread).await.unwrap();
            if state["goal"]["status"] != "active" && state["goal"]["activeTurnId"].is_null() {
                return state;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap()
}

async fn exercise(
    reply: Reply,
    rounds: usize,
) -> (tempfile::TempDir, Arc<Engine>, Arc<Reporter>, String, Value) {
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(Reporter {
        calls: AtomicUsize::new(0),
        reports: AtomicUsize::new(0),
        reply,
    });
    let engine = Engine::open(
        dir.path(),
        model.clone(),
        Limits {
            max_goal_report_rounds: rounds,
            ..Limits::default()
        },
    )
    .unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    engine
        .goal_create(
            "fixture".into(),
            GoalCreate {
                infer_limits: matches!(reply, Reply::Startup),
                interaction_mode: None,
                request_id: "create".into(),
                thread_id: thread.id.clone(),
                expected_revision: 0,
                objective: "Complete the fixture stages with evidence".into(),
                token_budget: None,
                max_turns: if matches!(reply, Reply::Startup) {
                    None
                } else {
                    Some(5)
                },
                max_active_seconds: None,
            },
        )
        .await
        .unwrap();
    let done = stopped(&engine, &thread.id).await;
    (dir, engine, model, thread.id, done)
}

#[tokio::test]
async fn report_phase_completes_without_consuming_generic_recovery_and_uses_normal_finalization() {
    let (_dir, engine, model, id, done) = exercise(Reply::Complete, 2).await;
    assert_eq!(done["goal"]["status"], "completed", "{done}");
    assert_eq!(done["goal"]["usage"]["turnsStarted"], 1);
    assert_eq!(done["goal"]["usage"]["tokensUsed"], 54);
    assert_eq!(model.calls.load(Ordering::SeqCst), 3);
    let history = engine.read(&id, true).await.unwrap();
    assert!(history.turns.iter().flat_map(|t| &t.items).all(|i| !matches!(i,areal_protocol::Item::AgentMessage{text,..} if text.contains("unfinished ordinary"))));
    engine.shutdown().await;
}

#[tokio::test]
async fn continue_report_advances_the_same_goal_and_keeps_cumulative_usage() {
    let (_dir, engine, model, _id, done) = exercise(Reply::Continue, 2).await;
    assert_eq!(done["goal"]["status"], "completed", "{done}");
    assert_eq!(done["goal"]["usage"]["turnsStarted"], 2);
    assert_eq!(done["goal"]["usage"]["tokensUsed"], 108);
    assert_eq!(done["goal"]["unreportedTurns"], 0);
    assert_eq!(model.calls.load(Ordering::SeqCst), 6);
    engine.shutdown().await;
}

#[tokio::test]
async fn ignored_report_phase_fails_once_with_a_typed_reason_instead_of_three_completed_turns() {
    let (_dir, engine, model, id, done) = exercise(Reply::Ignore, 2).await;
    assert_eq!(done["goal"]["status"], "failed", "{done}");
    assert_eq!(done["goal"]["usage"]["turnsStarted"], 1);
    assert_eq!(done["goal"]["usage"]["tokensUsed"], 54);
    assert_eq!(model.calls.load(Ordering::SeqCst), 3);
    let history = engine.read(&id, true).await.unwrap();
    let error = history.turns.last().unwrap().error.as_ref().unwrap();
    assert_eq!(
        error.outcome.as_ref().unwrap().code,
        "GOAL_PROGRESS_UNREPORTED"
    );
    assert_eq!(
        error.outcome.as_ref().unwrap().details.as_ref().unwrap()["reason"],
        "report_phase_exhausted"
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn report_phase_rejects_unadvertised_task_mutations_before_dispatch() {
    let (_dir, engine, _model, id, done) = exercise(Reply::Forbidden, 2).await;
    assert_eq!(done["goal"]["status"], "failed");
    assert_eq!(done["goal"]["usage"]["tokensUsed"], 36);
    assert_eq!(done["goal"]["usage"]["unknownRequests"], 0);
    let history = engine.read(&id, true).await.unwrap();
    assert!(
        history.turns.iter().flat_map(|t| &t.items).all(
            |i| !matches!(i,areal_protocol::Item::DynamicToolCall{tool,..} if tool=="fs_write")
        )
    );
    let error = history.turns.last().unwrap().error.as_ref().unwrap();
    assert_eq!(
        error.outcome.as_ref().unwrap().details.as_ref().unwrap()["reason"],
        "unexpected_report_tool"
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn stale_report_can_be_corrected_without_replaying_the_task() {
    let (_dir, engine, model, id, done) = exercise(Reply::Stale, 3).await;
    assert_eq!(done["goal"]["status"], "completed", "{done}");
    assert_eq!(model.calls.load(Ordering::SeqCst), 5);
    assert_eq!(model.reports.load(Ordering::SeqCst), 3);
    let history = engine.read(&id, true).await.unwrap();
    assert!(history.turns.iter().flat_map(|t| &t.items).any(|i| {
        matches!(i, areal_protocol::Item::DynamicToolCall { tool, success: Some(true), .. } if tool == "goal_read")
    }));
    engine.shutdown().await;
}

#[tokio::test]
async fn stale_report_readback_cannot_extend_the_report_round_allowance() {
    let (_dir, engine, model, _id, done) = exercise(Reply::Stale, 2).await;
    assert_eq!(done["goal"]["status"], "failed", "{done}");
    assert_eq!(model.reports.load(Ordering::SeqCst), 2);
    assert_eq!(done["goal"]["usage"]["tokensUsed"], 54);
    engine.shutdown().await;
}

#[tokio::test]
async fn report_policy_does_not_change_an_ordinary_turn() {
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(Reporter {
        calls: AtomicUsize::new(0),
        reports: AtomicUsize::new(0),
        reply: Reply::Ignore,
    });
    let engine = Engine::open(
        dir.path(),
        model.clone(),
        Limits {
            max_goal_report_rounds: 2,
            ..Limits::default()
        },
    )
    .unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    engine
        .start(&thread.id, vec![Input::text("ordinary request")])
        .await
        .unwrap();
    engine.wait(&thread.id).await.unwrap();
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    assert_eq!(model.reports.load(Ordering::SeqCst), 0);
    engine.shutdown().await;
}

#[tokio::test]
async fn report_phase_handles_reasoning_only_handoff_with_no_empty_retry_allowance() {
    let (_dir, engine, model, _id, done) = exercise(Reply::Empty, 2).await;
    assert_eq!(done["goal"]["status"], "completed", "{done}");
    assert_eq!(model.calls.load(Ordering::SeqCst), 3);
    engine.shutdown().await;
}
#[tokio::test]
async fn report_phase_confirms_pending_limits_without_inventing_new_budgets() {
    let (_dir, engine, model, _id, done) = exercise(Reply::Startup, 2).await;
    assert_eq!(done["goal"]["status"], "completed", "{done}");
    assert_eq!(done["goal"]["limitsPending"], false);
    assert!(done["goal"]["tokenBudget"].is_null());
    assert_eq!(model.reports.load(Ordering::SeqCst), 2);
    assert_eq!(model.calls.load(Ordering::SeqCst), 4);
    engine.shutdown().await;
}

#[path = "support/solve_only_http.rs"]
mod solve_only_http;

#[tokio::test]
async fn required_http_report_works_after_generic_recovery_is_exhausted_and_keeps_final_usage() {
    use areal_engine::model::{HttpModel, ModelProtocol};
    use axum::{Json, Router, routing::post};
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    fn goal_view(value: &Value) -> Option<Value> {
        match value {
            Value::String(text) => text
                .split("Current authoritative goal: ")
                .nth(1)
                .and_then(|s| serde_json::from_str(s).ok()),
            Value::Array(items) => items.iter().find_map(goal_view),
            Value::Object(items) => items.values().find_map(goal_view),
            _ => None,
        }
    }
    let app=Router::new().route("/",post(move |Json(body):Json<Value>| {
        let n=count.fetch_add(1,Ordering::SeqCst);
        async move {
            let mut output=vec![];
            let kind=if n==0 {"response.incomplete"} else {"response.completed"};
            let status=if n==0 {"incomplete"} else {"completed"};
            if n==2 {
                assert_eq!(body["tool_choice"],"required");
                assert_eq!(body["parallel_tool_calls"],false);
                let tools=body["tools"].as_array().unwrap();
                assert_eq!(tools.len(),2);
                assert!(tools.iter().any(|tool|tool["name"]=="goal_update"));
                assert!(tools.iter().any(|tool|tool["name"]=="goal_read"));
                let view=goal_view(&body).unwrap();
                output.push(json!({"type":"function_call","id":"report-item","call_id":"report-call","name":"goal_update","arguments":json!({"expectedRevision":view["revision"],"status":"complete","summary":"verified fixture","evidence":["fixture observed"],"remaining":[]}).to_string(),"status":"completed"}));
            }
            let mut raw=if n==1 || n==3 {format!("data: {}\n\n",json!({"type":"response.output_text.delta","delta":"Observed handoff"}))} else {String::new()};
            raw+=&format!("data: {}\n\n",json!({"type":kind,"response":{"id":format!("reply-{n}"),"status":status,"incomplete_details":if n==0 {json!({"reason":"max_output_tokens"})}else{Value::Null},"output":output,"usage":{"input_tokens":11,"output_tokens":7,"total_tokens":18}}}));
            ([("content-type","text/event-stream")],raw)
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let dir = tempfile::tempdir().unwrap();
    let model = HttpModel::with_protocol(
        format!("http://{address}/"),
        "fixture".into(),
        None,
        ModelProtocol::Responses,
    )
    .unwrap();
    let engine = Engine::open(
        dir.path(),
        Arc::new(solve_only_http::SolveOnlyHttpModel(model)),
        Limits {
            max_completion_retries: 1,
            max_goal_report_rounds: 2,
            ..Limits::default()
        },
    )
    .unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    engine
        .goal_create(
            "fixture".into(),
            GoalCreate {
                infer_limits: false,
                interaction_mode: None,
                request_id: "http".into(),
                thread_id: thread.id.clone(),
                expected_revision: 0,
                objective: "Verify fixture".into(),
                token_budget: None,
                max_turns: Some(2),
                max_active_seconds: None,
            },
        )
        .await
        .unwrap();
    let done = stopped(&engine, &thread.id).await;
    assert_eq!(done["goal"]["status"], "completed", "{done}");
    assert_eq!(done["goal"]["usage"]["tokensUsed"], 72);
    assert_eq!(done["goal"]["usage"]["unknownRequests"], 0);
    assert_eq!(calls.load(Ordering::SeqCst), 4);
    engine.shutdown().await;
    server.abort();
    let _ = server.await;
}
