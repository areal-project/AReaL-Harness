use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelEvent, ModelFailure, ModelStream, RequestPurpose, ToolCall},
    tools::DynamicToolHost,
    workgroup::native::SharedModel,
};
use areal_protocol::{DynamicToolResponse, Input, Item, ModelUsage, TurnStatus};
use async_trait::async_trait;
use futures_util::{StreamExt, stream};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy)]
enum Fault {
    Error(ModelFailure),
    RequestIdle,
    StreamIdle,
}
struct Flaky {
    requests: AtomicUsize,
    faults: Vec<Fault>,
    write_first: bool,
    history: Mutex<Vec<(Vec<Message>, Vec<Value>)>>,
}
fn call(id: &str) -> ModelEvent {
    ModelEvent::ToolCall(ToolCall {
        id: id.into(),
        name: "write_once".into(),
        arguments: "{}".into(),
    })
}
#[async_trait]
impl Model for Flaky {
    fn name(&self) -> &str {
        "network-fixture"
    }
    async fn stream(&self, messages: Vec<Message>) -> anyhow::Result<ModelStream> {
        self.chat(messages, vec![]).await
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<ModelStream> {
        self.history.lock().unwrap().push((messages, tools));
        let n = self.requests.fetch_add(1, Ordering::SeqCst);
        if self.write_first && n == 0 {
            return Ok(Box::pin(stream::iter([Ok(call("confirmed"))])));
        }
        let fault = self.faults.get(n - usize::from(self.write_first));
        match fault {
            Some(Fault::RequestIdle) => std::future::pending().await,
            Some(Fault::StreamIdle) => Ok(Box::pin(
                stream::iter([Ok(ModelEvent::text("discard stalled output"))])
                    .chain(stream::pending()),
            )),
            Some(Fault::Error(failure)) => {
                let mut events = vec![Ok(ModelEvent::text("discard ".repeat(8192)))];
                if self.write_first {
                    events.push(Ok(call("must-not-execute")));
                }
                events.push(Ok(ModelEvent::Usage(ModelUsage {
                    input_tokens: 10,
                    output_tokens: 2,
                    cached_input_tokens: 0,
                })));
                events.push(Err((*failure).into()));
                Ok(Box::pin(stream::iter(events)))
            }
            None => Ok(Box::pin(stream::iter([Ok(ModelEvent::text(
                "Verified result",
            ))]))),
        }
    }
}
fn flaky(faults: Vec<Fault>, write_first: bool) -> Arc<Flaky> {
    Arc::new(Flaky {
        requests: AtomicUsize::new(0),
        faults,
        write_first,
        history: Mutex::new(vec![]),
    })
}
#[derive(Default)]
struct Writes(AtomicUsize);
#[async_trait]
impl DynamicToolHost for Writes {
    fn id(&self) -> &str {
        "fixture-writes"
    }
    fn is_closed(&self) -> bool {
        false
    }
    async fn call(&self, _: Value, _: CancellationToken) -> anyhow::Result<DynamicToolResponse> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(DynamicToolResponse {
            success: true,
            content_items: vec![],
            structured_content: Some(json!({"written":true})),
        })
    }
}
async fn settled(engine: &Arc<Engine>, id: &str) -> areal_protocol::Thread {
    tokio::time::timeout(Duration::from_secs(20), engine.wait(id))
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn repeated_network_failures_preserve_request_usage_and_confirmed_tools() {
    let data = tempfile::tempdir().unwrap();
    let model = flaky(
        vec![
            Fault::Error(ModelFailure::Transport),
            Fault::Error(ModelFailure::RateLimited),
            Fault::Error(ModelFailure::Unavailable),
            Fault::Error(ModelFailure::Incomplete),
            Fault::Error(ModelFailure::Transport),
        ],
        true,
    );
    let engine = Engine::open(
        data.path(),
        model.clone(),
        Limits {
            max_output_bytes: 128 * 1024,
            max_completion_retries: 0,
            ..Limits::default()
        },
    )
    .unwrap();
    let writes = Arc::new(Writes::default());
    let thread = engine
        .create_with_tools(
            "/workspace".into(),
            vec![areal_protocol::ToolDefinition {
                name: "write_once".into(),
                description: "fixture mutation".into(),
                input_schema: json!({"type":"object"}),
                output_schema: None,
            }],
            writes.clone(),
        )
        .await
        .unwrap();
    engine
        .configure_thread(
            serde_json::from_value(json!({
                "threadId":thread.id,"expectedRevision":1,"options":{"maxModelRounds":3}
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    engine
        .start(&thread.id, vec![Input::text("Implement once")])
        .await
        .unwrap();
    let result = settled(&engine, &thread.id).await;
    assert_eq!(
        result.turns[0].status,
        TurnStatus::Completed,
        "{:?}",
        result.turns[0].error
    );
    assert_eq!(writes.0.load(Ordering::SeqCst), 1);
    assert_eq!(model.requests.load(Ordering::SeqCst), 7);
    let history = model.history.lock().unwrap().clone();
    for request in &history[2..] {
        assert_eq!(request, &history[1]);
    }
    assert!(
        !result.turns[0]
            .items
            .iter()
            .any(|i| matches!(i, Item::AgentMessage {text,..} if text.contains("discard")))
    );
    assert_eq!(result.turns[0].usage.as_ref().unwrap().input_tokens, 50);
    let audits: Vec<Value> = std::fs::read_dir(data.path().join("audit"))
        .unwrap()
        .map(|f| serde_json::from_slice(&std::fs::read(f.unwrap().path()).unwrap()).unwrap())
        .collect();
    assert_eq!(audits.len(), 5);
    assert!(audits.iter().all(
        |a| a["retryKind"] == "network" && a["unexecutedCalls"][0]["id"] == "must-not-execute"
    ));
    drop(history);
    engine.shutdown().await;
}

#[tokio::test]
async fn request_and_stream_idle_timeouts_retry_and_release_model_permits() {
    for fault in [Fault::RequestIdle, Fault::StreamIdle] {
        let data = tempfile::tempdir().unwrap();
        let model = flaky(vec![fault], false);
        let pool = SharedModel::pool(model.clone(), 1).unwrap();
        let engine = Engine::open(
            data.path(),
            pool.clone(),
            Limits {
                stream_idle_timeout: Duration::from_millis(40),
                ..Limits::default()
            },
        )
        .unwrap();
        let thread = engine.create("/workspace".into()).await.unwrap();
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
            .start(&thread.id, vec![Input::text("Recover")])
            .await
            .unwrap();
        assert_eq!(
            settled(&engine, &thread.id).await.turns[0].status,
            TurnStatus::Completed
        );
        assert_eq!(model.requests.load(Ordering::SeqCst), 2);
        assert_eq!(pool.load().unwrap().in_flight, 0);
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn watchdog_disable_preserves_finite_recovery_and_semantic_errors_still_fail() {
    for (disabled, failure, finite, expected) in [
        (true, ModelFailure::Transport, 0, TurnStatus::Failed),
        (true, ModelFailure::Transport, 1, TurnStatus::Completed),
        (false, ModelFailure::Truncated, 0, TurnStatus::Failed),
        (false, ModelFailure::EmptyCompletion, 0, TurnStatus::Failed),
    ] {
        let data = tempfile::tempdir().unwrap();
        let model = flaky(vec![Fault::Error(failure)], false);
        let engine = Engine::open(
            data.path(),
            model.clone(),
            Limits {
                watchdog_disable: disabled,
                max_completion_retries: finite,
                ..Limits::default()
            },
        )
        .unwrap();
        let thread = engine.create("/workspace".into()).await.unwrap();
        engine
            .start(&thread.id, vec![Input::text("Try")])
            .await
            .unwrap();
        assert_eq!(settled(&engine, &thread.id).await.turns[0].status, expected);
        assert_eq!(
            model.requests.load(Ordering::SeqCst),
            if finite > 0 { 2 } else { 1 }
        );
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn cancellation_deadline_and_steer_interrupt_watchdog_backoff() {
    for action in ["cancel", "deadline", "steer"] {
        let data = tempfile::tempdir().unwrap();
        let model = flaky(vec![Fault::Error(ModelFailure::Transport)], false);
        let engine = Engine::open(
            data.path(),
            model.clone(),
            Limits {
                turn_timeout: if action == "deadline" {
                    Duration::from_millis(150)
                } else {
                    Duration::from_secs(10)
                },
                ..Limits::default()
            },
        )
        .unwrap();
        let thread = engine.create("/workspace".into()).await.unwrap();
        let mut events = engine.subscribe(&thread.id).await.unwrap();
        let started = engine
            .start(&thread.id, vec![Input::text("Try")])
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if events.recv().await.unwrap()["method"] == "areal/model/watchdogRetry" {
                    break;
                }
            }
        })
        .await
        .unwrap();
        if action == "cancel" {
            engine.interrupt(&thread.id, &started.id).await.unwrap();
        }
        if action == "steer" {
            engine
                .steer(
                    &thread.id,
                    &started.id,
                    vec![Input::text("New instruction")],
                )
                .await
                .unwrap();
        }
        let result = settled(&engine, &thread.id).await;
        assert_eq!(
            result.turns[0].status,
            match action {
                "cancel" => TurnStatus::Interrupted,
                "deadline" => TurnStatus::Failed,
                _ => TurnStatus::Completed,
            }
        );
        if action == "deadline" {
            assert!(
                result.turns[0]
                    .error
                    .as_ref()
                    .unwrap()
                    .message
                    .contains("deadline")
            );
        }
        assert_eq!(
            model.requests.load(Ordering::SeqCst),
            if action == "steer" { 2 } else { 1 }
        );
        if action == "steer" {
            assert!(
                model.history.lock().unwrap()[1]
                    .0
                    .iter()
                    .any(|m| m.text_content().contains("New instruction"))
            );
        }
        engine.shutdown().await;
    }
}

struct SummaryNetwork {
    attempts: AtomicUsize,
    requests: Mutex<Vec<Vec<Message>>>,
}
#[async_trait]
impl Model for SummaryNetwork {
    fn name(&self) -> &str {
        "summary-network"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, _: Vec<Message>, _: Vec<Value>) -> anyhow::Result<ModelStream> {
        Ok(Box::pin(stream::iter([Ok(ModelEvent::text(
            "observed result ".repeat(95),
        ))])))
    }
    async fn chat_for(
        &self,
        messages: Vec<Message>,
        tools: Vec<Value>,
        purpose: RequestPurpose,
    ) -> anyhow::Result<ModelStream> {
        if purpose != RequestPurpose::Summary {
            return self.chat(messages, tools).await;
        }
        assert!(tools.is_empty());
        self.requests.lock().unwrap().push(messages);
        let n = self.attempts.fetch_add(1, Ordering::SeqCst);
        if n < 3 {
            return Ok(Box::pin(stream::iter([
                Ok(ModelEvent::text("Discard interrupted summary")),
                Ok(ModelEvent::Usage(ModelUsage {
                    input_tokens: 3,
                    output_tokens: 1,
                    cached_input_tokens: 0,
                })),
                Err(ModelFailure::Transport.into()),
            ])));
        }
        Ok(Box::pin(stream::iter([Ok(ModelEvent::text(
            "Confirmed changes retained. Next inspect the remaining test results.",
        ))])))
    }
}
#[tokio::test]
async fn summary_network_retries_do_not_consume_semantic_attempts_or_change_input() {
    let data = tempfile::tempdir().unwrap();
    let model = Arc::new(SummaryNetwork {
        attempts: AtomicUsize::new(0),
        requests: Mutex::new(vec![]),
    });
    let engine = Engine::open(
        data.path(),
        model.clone(),
        Limits {
            context_window_bytes: 2200,
            context_recent_bytes: 256,
            ..Limits::default()
        },
    )
    .unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    for prompt in ["Original", "Continue", "Verify"] {
        engine
            .start(&thread.id, vec![Input::text(prompt)])
            .await
            .unwrap();
        assert_eq!(
            settled(&engine, &thread.id)
                .await
                .turns
                .last()
                .unwrap()
                .status,
            TurnStatus::Completed
        );
    }
    let result = engine.read(&thread.id, true).await.unwrap();
    let checkpoint = result.context_checkpoint.unwrap();
    assert!(checkpoint.summary.starts_with("Confirmed"));
    assert_eq!(checkpoint.usage.input_tokens, 9);
    assert_eq!(model.attempts.load(Ordering::SeqCst), 4);
    let history = model.requests.lock().unwrap().clone();
    assert!(history[1..].iter().all(|request| request == &history[0]));
    drop(history);
    engine.shutdown().await;
}

#[tokio::test]
async fn http_status_eof_and_sse_service_errors_recover_with_identical_requests() {
    use areal_engine::model::{HttpModel, ModelOptions, ModelProtocol};
    use axum::{Json, Router, response::IntoResponse, routing::post};
    for protocol in [ModelProtocol::ChatCompletions, ModelProtocol::Responses] {
        let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = requests.clone();
        let app = Router::new().route("/", post(move |Json(request): Json<Value>| {
            let requests = captured.clone();
            async move {
                let n = {
                    let mut requests = requests.lock().unwrap();
                    requests.push(request);
                    requests.len()
                };
                if n == 1 { return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response(); }
                let text = match (protocol, n) {
                    (ModelProtocol::ChatCompletions, 2) => "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"}}]}\n\n",
                    (ModelProtocol::Responses, 2) => "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n",
                    (ModelProtocol::ChatCompletions, 3) => "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"}}]}\n\ndata: {\"error\":{\"code\":\"rate_limit_exceeded\",\"message\":\"private fixture\"}}\n\n",
                    (ModelProtocol::Responses, 3) => "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"type\":\"overloaded_error\"}}}\n\n",
                    (ModelProtocol::ChatCompletions, _) => "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
                    (ModelProtocol::Responses, _) => "data: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
                };
                ([("content-type", "text/event-stream")], text).into_response()
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let model = HttpModel::with_protocol(endpoint, "fixture".into(), None, protocol)
            .unwrap()
            .with_options(ModelOptions {
                max_retries: 0,
                temperature: Some(1.0),
                top_p: Some(0.95),
                reasoning_effort: Some("xhigh".into()),
                ..ModelOptions::default()
            })
            .unwrap();
        let data = tempfile::tempdir().unwrap();
        let engine = Engine::open(data.path(), Arc::new(model), Limits::default()).unwrap();
        let thread = engine.create("/workspace".into()).await.unwrap();
        engine
            .start(&thread.id, vec![Input::text("Recover network")])
            .await
            .unwrap();
        let result = settled(&engine, &thread.id).await;
        assert_eq!(
            result.turns[0].status,
            TurnStatus::Completed,
            "{:?}",
            result.turns[0].error
        );
        assert!(
            !result.turns[0]
                .items
                .iter()
                .any(|i| matches!(i, Item::AgentMessage {text,..} if text.contains("partial")))
        );
        let captured = requests.lock().unwrap().clone();
        assert_eq!(captured.len(), 4);
        assert!(captured[1..].iter().all(|r| r == &captured[0]));
        drop(captured);
        engine.shutdown().await;
        server.abort();
        let _ = server.await;
    }
}
