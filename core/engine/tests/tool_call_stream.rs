use areal_engine::{
    Engine, Limits,
    model::{HttpModel, Message, Model, ModelEvent, ModelProtocol, RequestPurpose, ToolCallLimits},
    tools::DynamicToolHost,
    workgroup::native::SharedModel,
};
use areal_protocol::{DynamicToolResponse, Input, Item, ToolDefinition, TurnStatus};
use async_trait::async_trait;
use axum::{
    Json, Router,
    body::{Body, Bytes},
    routing::post,
};
use futures_util::{StreamExt, stream};
use serde_json::{Value, json};
use std::{
    convert::Infallible,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

fn frame(value: Value) -> String {
    format!("data: {value}\n\n")
}
fn usage() -> Value {
    json!({"prompt_tokens":7,"completion_tokens":3})
}
fn finished() -> String {
    frame(
        json!({"choices":[{"index":0,"delta":{"content":"verified"},"finish_reason":"stop"}],"usage":usage()}),
    )
}
fn calls_body(count: usize, size: usize, responses: bool) -> String {
    let arguments = if size <= 2 {
        "{}".into()
    } else {
        json!({"text":"x".repeat(size - 11)}).to_string()
    };
    if responses {
        let items: Vec<_> = (0..count).map(|n| json!({"type":"function_call","call_id":format!("call{n}"),"name":"write_once","arguments":arguments})).collect();
        items
            .iter()
            .map(|item| frame(json!({"type":"response.output_item.done","item":item})))
            .collect::<String>()
            + &frame(
                json!({"type":"response.completed","response":{"status":"completed","output":items,"usage":usage()}}),
            )
    } else {
        let calls: Vec<_> = (0..count).map(|n| json!({"index":100+n,"id":format!("call{n}"),"function":{"name":"write_once","arguments":arguments}})).collect();
        frame(
            json!({"choices":[{"index":0,"delta":{"tool_calls":calls},"finish_reason":"tool_calls"}],"usage":usage()}),
        )
    }
}
fn broken() -> String {
    frame(json!({"choices":[{"index":0,"delta":{"content":"discard-me"}}]}))
        + &frame(json!({"choices":[{"index":0,"delta":{"tool_calls":[
            {"index":100,"id":"must-not-run","function":{"name":"write_once","arguments":"{}"}},
            {"id":"private-secret","function":{"name":"write_once","arguments":"private-secret"}}
        ]}}],"usage":usage()}))
}

struct Fixture {
    endpoint: String,
    requests: Arc<Mutex<Vec<Value>>>,
    count: tokio::sync::watch::Receiver<usize>,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}
impl Fixture {
    async fn start(bodies: Vec<String>, hold: Option<usize>) -> Self {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let (tx, count) = tokio::sync::watch::channel(0);
        let app = Router::new().route(
            "/",
            post(move |Json(request): Json<Value>| {
                let n = {
                    let mut requests = recorded.lock().unwrap();
                    requests.push(request);
                    requests.len() - 1
                };
                tx.send_replace(n + 1);
                let body = bodies[n.min(bodies.len() - 1)].clone();
                async move {
                    let body = if hold == Some(n) {
                        Body::from_stream(
                            stream::iter([Ok::<_, Infallible>(Bytes::from(body))])
                                .chain(stream::pending()),
                        )
                    } else {
                        Body::from(body)
                    };
                    ([("content-type", "text/event-stream")], body)
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            endpoint,
            requests,
            count,
            server,
        }
    }
    async fn wait_requests(&mut self, count: usize) {
        tokio::time::timeout(Duration::from_secs(5), self.count.wait_for(|n| *n >= count))
            .await
            .unwrap()
            .unwrap();
    }
    fn model(&self, audit: &std::path::Path, responses: bool) -> HttpModel {
        HttpModel::with_protocol(
            self.endpoint.clone(),
            "fixture".into(),
            None,
            if responses {
                ModelProtocol::Responses
            } else {
                ModelProtocol::ChatCompletions
            },
        )
        .unwrap()
        .with_audit_directory(audit.into())
    }
}
#[derive(Default)]
struct Writes {
    ids: Mutex<Vec<String>>,
    unknown: bool,
}
#[async_trait]
impl DynamicToolHost for Writes {
    fn id(&self) -> &str {
        "fixture-writes"
    }
    fn is_closed(&self) -> bool {
        false
    }
    async fn call(
        &self,
        request: Value,
        _: CancellationToken,
    ) -> anyhow::Result<DynamicToolResponse> {
        self.ids
            .lock()
            .unwrap()
            .push(request["callId"].as_str().unwrap().into());
        anyhow::ensure!(!self.unknown, "fixture connection lost after submission");
        Ok(DynamicToolResponse {
            success: true,
            content_items: vec![],
            structured_content: Some(json!({"written":true})),
        })
    }
}
async fn thread(engine: &Arc<Engine>, writes: Arc<Writes>) -> areal_protocol::Thread {
    engine
        .create_with_tools(
            "/workspace".into(),
            vec![ToolDefinition {
                name: "write_once".into(),
                description: "fixture mutation".into(),
                input_schema: json!({"type":"object"}),
                output_schema: None,
            }],
            writes,
        )
        .await
        .unwrap()
}
async fn settled(engine: &Arc<Engine>, id: &str) -> areal_protocol::Thread {
    tokio::time::timeout(Duration::from_secs(5), engine.wait(id))
        .await
        .unwrap()
        .unwrap()
}
fn audits(path: &std::path::Path) -> Vec<Value> {
    std::fs::read_to_string(path.join("requests.jsonl"))
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect()
}

#[tokio::test]
async fn pending_protocol_error_is_delivered_without_waiting_for_more_network_data() {
    for hold in [None, Some(0)] {
        let fixture = Fixture::start(vec![broken()], hold).await;
        let data = tempfile::tempdir().unwrap();
        let model = fixture.model(data.path(), false);
        let events = tokio::time::timeout(Duration::from_secs(2), async {
            model
                .chat(vec![Message::text("user", "fixture")], vec![])
                .await
                .unwrap()
                .collect::<Vec<_>>()
                .await
        })
        .await
        .unwrap();
        assert_eq!(events.iter().filter(|e| e.is_err()).count(), 1);
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, Ok(ModelEvent::Usage(_))))
                .count(),
            1
        );
        assert!(
            events
                .iter()
                .all(|e| !matches!(e, Ok(ModelEvent::ToolCall(_))))
        );
        let audit = &audits(data.path())[0];
        assert_eq!(audit["outcome"], "failed");
        assert_eq!(audit["usageObserved"], true);
        assert_eq!(audit["usage"]["inputTokens"], 7);
        assert_eq!(audit["errorCode"], "invalid_tool_call_index");
        assert_eq!(audit["toolCallError"]["eventNumber"], 2);
        assert_eq!(audit["toolCallError"]["callCount"], 1);
        assert!(audit["requestId"].is_string());
        assert!(!audit.to_string().contains("private-secret"));
    }
}

#[tokio::test]
async fn finite_recovery_keeps_confirmed_operations_and_usage_without_network_retry() {
    for (budget, failures) in [(0, 1), (1, 1), (2, 2), (2, 3)] {
        let mut bodies = vec![calls_body(1, 2, false)];
        bodies.extend(std::iter::repeat_n(broken(), failures));
        bodies.push(finished());
        let fixture = Fixture::start(bodies, None).await;
        let data = tempfile::tempdir().unwrap();
        let audit = data.path().join("requests");
        let pool = SharedModel::pool(Arc::new(fixture.model(&audit, false)), 1).unwrap();
        let engine = Engine::open(
            &data.path().join("core"),
            pool.clone(),
            Limits {
                max_completion_retries: budget,
                ..Limits::default()
            },
        )
        .unwrap();
        let writes = Arc::new(Writes::default());
        let thread = thread(&engine, writes.clone()).await;
        engine
            .start(&thread.id, vec![Input::text("fixture")])
            .await
            .unwrap();
        let result = settled(&engine, &thread.id).await;
        let success = budget >= failures;
        assert_eq!(
            result.turns[0].status,
            if success {
                TurnStatus::Completed
            } else {
                TurnStatus::Failed
            }
        );
        assert_eq!(*writes.ids.lock().unwrap(), ["call0"]);
        let expected = if success { failures + 2 } else { budget + 2 };
        assert_eq!(fixture.requests.lock().unwrap().len(), expected);
        assert_eq!(
            result.turns[0].usage.as_ref().unwrap().input_tokens,
            (7 * expected) as u64
        );
        assert_eq!(pool.load().unwrap().in_flight, 0);
        assert_eq!(
            result.turns[0]
                .items
                .iter()
                .filter(|i| matches!(i, Item::DynamicToolCall { .. }))
                .count(),
            1
        );
        for request in fixture.requests.lock().unwrap().iter().skip(2) {
            assert!(!request.to_string().contains("discard-me"));
            assert!(!request.to_string().contains("must-not-run"));
            assert_eq!(
                request["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|m| m["role"] == "tool")
                    .count(),
                1
            );
        }
        let audits = audits(&audit);
        assert_eq!(audits.len(), expected);
        for record in audits.iter().filter(|r| r["outcome"] == "failed") {
            assert_eq!(record["errorCode"], "invalid_tool_call_index");
        }
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn both_protocols_honor_request_budgets_through_the_shared_pool_before_execution() {
    for responses in [false, true] {
        for (count, size, max_calls, buffer, expected) in [
            (17, 2, 20, 4 * 1024 * 1024, None),
            (2, 40 * 1024, 2, 4 * 1024 * 1024, None),
            (2, 2, 1, 4 * 1024 * 1024, Some("calls")),
            (1, 2, 1, 1, Some("buffer_bytes")),
            (1, 65537, 1, 4 * 1024 * 1024, Some("argument_bytes")),
        ] {
            let final_body = if responses {
                frame(json!({"type":"response.output_text.delta","delta":"verified"}))
                    + &frame(json!({"type":"response.completed","response":{"status":"completed"}}))
            } else {
                finished()
            };
            let fixture =
                Fixture::start(vec![calls_body(count, size, responses), final_body], None).await;
            let data = tempfile::tempdir().unwrap();
            let audit = data.path().join("requests");
            let pool = SharedModel::pool(Arc::new(fixture.model(&audit, responses)), 1).unwrap();
            let engine = Engine::open(
                &data.path().join("core"),
                pool.clone(),
                Limits {
                    max_tool_calls: max_calls,
                    max_tool_buffer_bytes: buffer,
                    max_output_bytes: 4 * 1024 * 1024,
                    max_history_bytes: 32 * 1024 * 1024,
                    max_completion_retries: 2,
                    ..Limits::default()
                },
            )
            .unwrap();
            let writes = Arc::new(Writes::default());
            let thread = thread(&engine, writes.clone()).await;
            engine
                .start(&thread.id, vec![Input::text("fixture")])
                .await
                .unwrap();
            let result = settled(&engine, &thread.id).await;
            assert_eq!(
                result.turns[0].status,
                if expected.is_none() {
                    TurnStatus::Completed
                } else {
                    TurnStatus::Failed
                },
                "{:?}",
                result.turns[0].error
            );
            assert_eq!(
                writes.ids.lock().unwrap().len(),
                if expected.is_none() { count } else { 0 }
            );
            assert_eq!(
                fixture.requests.lock().unwrap().len(),
                if expected.is_none() { 2 } else { 1 }
            );
            assert_eq!(pool.load().unwrap().in_flight, 0);
            if let Some(kind) = expected {
                let audit = &audits(&audit)[0];
                assert_eq!(audit["errorCode"], "tool_call_budget_exceeded");
                assert_eq!(audit["toolCallError"]["budget"], kind);
            }
            engine.shutdown().await;
        }
    }
}

#[tokio::test]
async fn cancellation_timeout_and_steer_remain_effective_after_protocol_recovery() {
    for action in ["cancel", "timeout", "steer"] {
        let waiting = frame(json!({"choices":[{"index":0,"delta":{"content":"waiting"}}]}));
        let mut fixture = Fixture::start(vec![broken(), waiting, finished()], Some(1)).await;
        let data = tempfile::tempdir().unwrap();
        let pool = SharedModel::pool(
            Arc::new(fixture.model(&data.path().join("requests"), false)),
            1,
        )
        .unwrap();
        let engine = Engine::open(
            &data.path().join("core"),
            pool.clone(),
            Limits {
                max_completion_retries: 1,
                watchdog_disable: action == "timeout",
                stream_idle_timeout: if action == "timeout" {
                    Duration::from_millis(200)
                } else {
                    Duration::from_secs(10)
                },
                ..Limits::default()
            },
        )
        .unwrap();
        let writes = Arc::new(Writes::default());
        let thread = thread(&engine, writes.clone()).await;
        let turn = engine
            .start(&thread.id, vec![Input::text("fixture")])
            .await
            .unwrap();
        fixture.wait_requests(2).await;
        if action == "cancel" {
            engine.interrupt(&thread.id, &turn.id).await.unwrap();
        }
        if action == "steer" {
            engine
                .steer(&thread.id, &turn.id, vec![Input::text("corrected request")])
                .await
                .unwrap();
        }
        let result = settled(&engine, &thread.id).await;
        assert_eq!(
            result.turns[0].status,
            match action {
                "cancel" => TurnStatus::Interrupted,
                "timeout" => TurnStatus::Failed,
                _ => TurnStatus::Completed,
            }
        );
        assert!(writes.ids.lock().unwrap().is_empty());
        assert_eq!(pool.load().unwrap().in_flight, 0);
        {
            let requests = fixture.requests.lock().unwrap();
            assert_eq!(requests.len(), if action == "steer" { 3 } else { 2 });
            if action == "steer" {
                assert!(requests[2].to_string().contains("corrected request"));
            }
        }
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn unknown_tool_result_stops_before_any_further_model_request() {
    let fixture = Fixture::start(vec![calls_body(1, 2, false), broken()], None).await;
    let data = tempfile::tempdir().unwrap();
    let engine = Engine::open(
        &data.path().join("core"),
        Arc::new(fixture.model(&data.path().join("requests"), false)),
        Limits {
            max_completion_retries: 2,
            ..Limits::default()
        },
    )
    .unwrap();
    let writes = Arc::new(Writes {
        unknown: true,
        ..Writes::default()
    });
    let thread = thread(&engine, writes.clone()).await;
    engine
        .start(&thread.id, vec![Input::text("fixture")])
        .await
        .unwrap();
    assert_eq!(
        settled(&engine, &thread.id).await.turns[0].status,
        TurnStatus::Failed
    );
    assert_eq!(fixture.requests.lock().unwrap().len(), 1);
    assert_eq!(writes.ids.lock().unwrap().len(), 1);
    engine.shutdown().await;
}

#[tokio::test]
async fn summary_requests_and_configured_models_preserve_buffer_limits() {
    let fixture = Fixture::start(vec![calls_body(1, 2, false)], None).await;
    let data = tempfile::tempdir().unwrap();
    let configured = fixture
        .model(data.path(), false)
        .configure(&Default::default())
        .unwrap();
    let pool = SharedModel::pool(configured, 1).unwrap();
    for purpose in [RequestPurpose::Solve, RequestPurpose::Summary] {
        let events = pool
            .chat_with_limits(
                vec![Message::text("user", "fixture")],
                vec![],
                purpose,
                ToolCallLimits {
                    max_calls: 1,
                    max_buffer_bytes: 1,
                },
                None,
            )
            .await
            .unwrap()
            .collect::<Vec<_>>()
            .await;
        assert!(events.iter().any(Result::is_err));
        assert_eq!(pool.load().unwrap().in_flight, 0);
    }
    let records = audits(data.path());
    assert_eq!(records[0]["toolCallError"]["budget"], "buffer_bytes");
    assert_eq!(records[1]["toolCallError"]["budget"], "calls");
}

struct ScriptedCalls {
    batches: Vec<Vec<areal_engine::model::ToolCall>>,
    requests: std::sync::atomic::AtomicUsize,
}
#[async_trait]
impl Model for ScriptedCalls {
    fn name(&self) -> &str {
        "custom-model-budget-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<areal_engine::model::ModelStream> {
        let n = self
            .requests
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let events = match self.batches.get(n) {
            Some(calls) => calls
                .iter()
                .cloned()
                .map(|call| Ok(ModelEvent::ToolCall(call)))
                .collect::<Vec<_>>(),
            None => vec![Ok(ModelEvent::text("verified"))],
        };
        Ok(Box::pin(stream::iter(events)))
    }
}
#[tokio::test]
async fn engine_enforces_remaining_count_and_bytes_for_legacy_custom_models() {
    for (prefix, count, size, max_calls, buffer, kind) in [
        (true, 1, 2, 1, 4194304, "calls"),
        (false, 3, 2, 2, 4194304, "calls"),
        (false, 1, 2, 2, 1, "buffer_bytes"),
        (false, 1, 65537, 2, 4194304, "argument_bytes"),
    ] {
        let call = |size: usize| areal_engine::model::ToolCall {
            id: "call".into(),
            name: "write_once".into(),
            arguments: if size == 2 {
                "{}".into()
            } else {
                json!({"text":"x".repeat(size - 11)}).to_string()
            },
        };
        let mut batches = if prefix { vec![vec![call(2)]] } else { vec![] };
        batches.push(vec![call(size); count]);
        let model = Arc::new(ScriptedCalls {
            batches,
            requests: Default::default(),
        });
        let data = tempfile::tempdir().unwrap();
        let engine = Engine::open(
            data.path(),
            model.clone(),
            Limits {
                max_tool_calls: max_calls,
                max_tool_buffer_bytes: buffer,
                max_completion_retries: 2,
                ..Limits::default()
            },
        )
        .unwrap();
        let writes = Arc::new(Writes::default());
        let thread = thread(&engine, writes.clone()).await;
        engine
            .start(&thread.id, vec![Input::text("fixture")])
            .await
            .unwrap();
        let result = settled(&engine, &thread.id).await;
        assert_eq!(result.turns[0].status, TurnStatus::Failed);
        assert!(
            result.turns[0]
                .error
                .as_ref()
                .unwrap()
                .message
                .contains(kind)
        );
        assert_eq!(writes.ids.lock().unwrap().len(), usize::from(prefix));
        assert_eq!(
            model.requests.load(std::sync::atomic::Ordering::SeqCst),
            1 + usize::from(prefix)
        );
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn goal_requests_keep_output_caps_and_tool_budgets_through_shared_pools() {
    for responses in [false, true] {
        for (count, buffer, expected, limit) in [(2, 4096, "calls", 1), (1, 1, "buffer_bytes", 1)] {
            let fixture = Fixture::start(vec![calls_body(count, 2, responses)], None).await;
            let data = tempfile::tempdir().unwrap();
            let audit = data.path().join("requests");
            let model = fixture
                .model(&audit, responses)
                .configure(&areal_protocol::desktop::ModelParameters {
                    max_output_tokens: Some(16000),
                    ..Default::default()
                })
                .unwrap();
            let pool = SharedModel::pool(model, 1).unwrap();
            let engine = Engine::open(
                &data.path().join("core"),
                pool.clone(),
                Limits {
                    max_tool_calls: 1,
                    max_tool_buffer_bytes: buffer,
                    max_completion_retries: 2,
                    ..Limits::default()
                },
            )
            .unwrap();
            let writes = Arc::new(Writes::default());
            let thread = thread(&engine, writes.clone()).await;
            engine
                .goal_create(
                    "fixture".into(),
                    areal_protocol::goals::GoalCreate {
                        interaction_mode: None,
                        request_id: "goal-budget".into(),
                        thread_id: thread.id.clone(),
                        expected_revision: 0,
                        objective: "Run the fixture with both request budgets".into(),
                        token_budget: Some(8000),
                        max_turns: Some(1),
                        max_active_seconds: None,
                    },
                )
                .await
                .unwrap();
            let goal = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let goal = engine.goal_get(&thread.id).await.unwrap();
                    if goal["goal"]["status"] != "active" && goal["goal"]["activeTurnId"].is_null()
                    {
                        break goal;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert_eq!(goal["goal"]["status"], "blocked", "{goal}");
            assert_eq!(goal["goal"]["reason"], "usageUnknown");
            assert_eq!(goal["goal"]["usage"]["unknownRequests"], 1);
            assert!(writes.ids.lock().unwrap().is_empty());
            assert_eq!(pool.load().unwrap().in_flight, 0);
            {
                let requests = fixture.requests.lock().unwrap();
                assert_eq!(requests.len(), 1);
                let field = if responses {
                    "max_output_tokens"
                } else {
                    "max_completion_tokens"
                };
                assert!(
                    requests[0][field]
                        .as_u64()
                        .is_some_and(|cap| cap > 0 && cap < 8000)
                );
            }
            let records = audits(&audit);
            assert_eq!(records[0]["errorCode"], "tool_call_budget_exceeded");
            assert_eq!(records[0]["toolCallError"]["budget"], expected);
            assert_eq!(records[0]["toolCallError"]["limit"], limit);
            engine.shutdown().await;
        }
    }
}

#[tokio::test]
async fn final_round_only_classifies_http_call_budget_errors_as_round_exhaustion() {
    let invalid = frame(json!({"choices":[{"index":0,"delta":{"tool_calls":[{}]}}]}));
    for (responses, body, expected, error_code, retries) in [
        (
            false,
            calls_body(1, 2, false),
            "MAX_MODEL_ROUNDS",
            "tool_call_budget_exceeded",
            2,
        ),
        (
            true,
            calls_body(1, 2, true),
            "MAX_MODEL_ROUNDS",
            "tool_call_budget_exceeded",
            2,
        ),
        (
            false,
            invalid,
            "invalid_tool_call_index",
            "invalid_tool_call_index",
            0,
        ),
    ] {
        let fixture = Fixture::start(vec![body], None).await;
        let data = tempfile::tempdir().unwrap();
        let audit = data.path().join("requests");
        let pool = SharedModel::pool(Arc::new(fixture.model(&audit, responses)), 1).unwrap();
        let engine = Engine::open(
            &data.path().join("core"),
            pool.clone(),
            Limits {
                max_completion_retries: retries,
                ..Limits::default()
            },
        )
        .unwrap();
        let writes = Arc::new(Writes::default());
        let thread = thread(&engine, writes.clone()).await;
        engine
            .configure_thread(
                serde_json::from_value(json!({
                    "threadId":thread.id,"expectedRevision":1,"options":{"maxModelRounds":1}
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        engine
            .start(&thread.id, vec![Input::text("fixture")])
            .await
            .unwrap();
        let result = settled(&engine, &thread.id).await;
        assert_eq!(result.turns[0].status, TurnStatus::Failed);
        let message = &result.turns[0].error.as_ref().unwrap().message;
        assert!(message.contains(expected), "{message}");
        let outcome = result.turns[0]
            .error
            .as_ref()
            .unwrap()
            .outcome
            .as_ref()
            .unwrap();
        if expected == "MAX_MODEL_ROUNDS" {
            assert_eq!(outcome.code, "AGENT_MAX_TURNS_EXCEEDED");
            assert_eq!(outcome.class, "agent");
            assert_eq!(outcome.source, "core_model_round_budget");
            assert_eq!(outcome.details.as_ref().unwrap()["maxModelRounds"], 1);
        } else {
            assert_eq!(outcome.code, "LLM_RESPONSE_FAILED");
        }
        if expected != "MAX_MODEL_ROUNDS" {
            assert!(!message.contains("MAX_MODEL_ROUNDS"));
        }
        assert!(writes.ids.lock().unwrap().is_empty());
        assert!(
            !result.turns[0]
                .items
                .iter()
                .any(|item| matches!(item, Item::DynamicToolCall { .. }))
        );
        assert_eq!(pool.load().unwrap().in_flight, 0);
        {
            let requests = fixture.requests.lock().unwrap();
            assert_eq!(requests.len(), 1);
            assert!(requests[0]["tools"].as_array().is_none_or(Vec::is_empty));
        }
        let records = audits(&audit);
        assert_eq!(records[0]["errorCode"], error_code);
        if error_code == "tool_call_budget_exceeded" {
            assert_eq!(records[0]["toolCallError"]["budget"], "calls");
            assert_eq!(records[0]["toolCallError"]["limit"], 0);
        }
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn remaining_turn_allowance_reaches_http_decoder_after_a_confirmed_call() {
    let fixture = Fixture::start(vec![calls_body(1, 2, false)], None).await;
    let data = tempfile::tempdir().unwrap();
    let audit = data.path().join("requests");
    let pool = SharedModel::pool(Arc::new(fixture.model(&audit, false)), 1).unwrap();
    let engine = Engine::open(
        &data.path().join("core"),
        pool,
        Limits {
            max_tool_calls: 1,
            max_completion_retries: 2,
            ..Limits::default()
        },
    )
    .unwrap();
    let writes = Arc::new(Writes::default());
    let thread = thread(&engine, writes.clone()).await;
    engine
        .start(&thread.id, vec![Input::text("fixture")])
        .await
        .unwrap();
    let result = settled(&engine, &thread.id).await;
    assert_eq!(result.turns[0].status, TurnStatus::Failed);
    let message = &result.turns[0].error.as_ref().unwrap().message;
    assert!(message.contains("tool_call_budget_exceeded"));
    assert!(!message.contains("MAX_MODEL_ROUNDS"));
    assert_eq!(writes.ids.lock().unwrap().len(), 1);
    assert_eq!(fixture.requests.lock().unwrap().len(), 2);
    let records = audits(&audit);
    assert_eq!(records[1]["outcome"], "failed");
    assert_eq!(records[1]["toolCallError"]["budget"], "calls");
    assert_eq!(records[1]["toolCallError"]["limit"], 0);
    engine.shutdown().await;
}

#[tokio::test]
async fn protocol_error_distinguishes_unobserved_usage_from_observed_zero() {
    for observed in [false, true] {
        let mut event = json!({"choices":[{"index":0,"delta":{"tool_calls":[{}]}}]});
        if observed {
            event["usage"] = json!({"prompt_tokens":0,"completion_tokens":0});
        }
        let fixture = Fixture::start(vec![frame(event)], None).await;
        let data = tempfile::tempdir().unwrap();
        let model = fixture.model(data.path(), false);
        let events = model
            .stream(vec![Message::text("user", "fixture")])
            .await
            .unwrap()
            .collect::<Vec<_>>()
            .await;
        assert_eq!(events.iter().filter(|e| e.is_err()).count(), 1);
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, Ok(ModelEvent::Usage(_))))
                .count(),
            usize::from(observed)
        );
        let audit = &audits(data.path())[0];
        assert_eq!(audit["errorCode"], "invalid_tool_call_index");
        assert_eq!(audit["usageObserved"], observed);
        assert_eq!(audit["usage"]["inputTokens"], 0);
    }
}
