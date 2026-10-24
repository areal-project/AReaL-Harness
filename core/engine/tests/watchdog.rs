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
                let mut events = vec![
                    Ok(ModelEvent::reasoning("discarded thought")),
                    Ok(ModelEvent::text("discard ".repeat(8192))),
                ];
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

#[tokio::test]
async fn bounded_network_recovery_preserves_tools_and_usage_then_stops() {
    for failures in [2, 6] {
        let data = tempfile::tempdir().unwrap();
        let model = flaky(vec![Fault::Error(ModelFailure::Transport); failures], true);
        let writes = Arc::new(Writes::default());
        let engine = Engine::open(
            data.path(),
            model.clone(),
            Limits {
                network_retry_mode: areal_config::NetworkRetryMode::Bounded,
                max_completion_retries: 2,
                ..Limits::default()
            },
        )
        .unwrap();
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
            .start(&thread.id, vec![Input::text("Implement once")])
            .await
            .unwrap();
        let result = settled(&engine, &thread.id).await;
        assert_eq!(
            result.turns[0].status,
            if failures == 2 {
                TurnStatus::Completed
            } else {
                TurnStatus::Failed
            }
        );
        assert_eq!(
            model.requests.load(Ordering::SeqCst),
            if failures == 2 { 4 } else { 7 }
        );
        assert_eq!(
            writes.0.load(Ordering::SeqCst),
            1,
            "accepted mutation must never be replayed"
        );
        assert_eq!(
            result.turns[0].usage.as_ref().unwrap().input_tokens,
            failures as u64 * 10
        );
        let history = model.history.lock().unwrap().clone();
        assert!(history[2..].iter().all(|request| request == &history[1]));
        engine.shutdown().await;
    }
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
            raw_mcp_result: None,
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
    assert!(
        !result.turns[0]
            .items
            .iter()
            .any(|i| matches!(i, Item::Reasoning { .. }))
    );
    assert_eq!(result.turns[0].usage.as_ref().unwrap().input_tokens, 50);
    let audits: Vec<Value> = std::fs::read_dir(data.path().join("audit"))
        .unwrap()
        .filter(|f| {
            f.as_ref()
                .unwrap()
                .path()
                .extension()
                .is_some_and(|x| x == "json")
        })
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
                model_request_timeout: Duration::from_millis(40),
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
async fn recovery_notifications_match_public_desktop_contract() {
    let data = tempfile::tempdir().unwrap();
    let engine = Engine::open(
        data.path(),
        flaky(vec![Fault::Error(ModelFailure::Transport)], false),
        Limits::default(),
    )
    .unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    let mut events = engine.subscribe(&thread.id).await.unwrap();
    engine
        .start(
            &thread.id,
            vec![Input::text("Recover from a network failure")],
        )
        .await
        .unwrap();
    assert_eq!(
        settled(&engine, &thread.id).await.turns[0].status,
        TurnStatus::Completed
    );
    let contract: Value =
        serde_json::from_str(include_str!("../../../schemas/areal-core-v1.json")).unwrap();
    let mut observed = std::collections::BTreeSet::new();
    while let Ok(event) = events.try_recv() {
        let method = event["method"].as_str().unwrap();
        if !matches!(
            method,
            "areal/model/watchdogRetry" | "areal/model/completionDiscarded"
        ) {
            continue;
        }
        assert!(
            areal_protocol::desktop::NOTIFICATIONS.contains(&method),
            "unadvertised notification: {method}"
        );
        let schema = &contract["notifications"][method];
        assert!(schema.is_object(), "missing public schema: {method}");
        let validator = jsonschema::validator_for(schema).unwrap();
        assert!(
            validator.is_valid(&event["params"]),
            "event violates public schema: {event}"
        );
        observed.insert(method.to_owned());
    }
    assert_eq!(
        observed.len(),
        2,
        "both real recovery events must be validated"
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn cancellation_and_steer_interrupt_watchdog_backoff() {
    for action in ["cancel", "steer"] {
        let data = tempfile::tempdir().unwrap();
        let model = flaky(vec![Fault::Error(ModelFailure::Transport)], false);
        let engine = Engine::open(
            data.path(),
            model.clone(),
            Limits {
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
                _ => TurnStatus::Completed,
            }
        );
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
    for mode in [
        areal_config::NetworkRetryMode::Persistent,
        areal_config::NetworkRetryMode::Bounded,
    ] {
        let data = tempfile::tempdir().unwrap();
        let model = Arc::new(SummaryNetwork {
            attempts: AtomicUsize::new(0),
            requests: Mutex::new(vec![]),
        });
        let engine = Engine::open(
            data.path(),
            model.clone(),
            Limits {
                network_retry_mode: mode,
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
}

#[tokio::test]
async fn goal_unknown_usage_stops_before_network_backoff_and_keeps_reservations() {
    for fault in [
        Fault::Error(ModelFailure::Transport),
        Fault::Error(ModelFailure::RateLimited),
        Fault::Error(ModelFailure::Unavailable),
        Fault::Error(ModelFailure::Incomplete),
        Fault::RequestIdle,
        Fault::StreamIdle,
    ] {
        let data = tempfile::tempdir().unwrap();
        let model = flaky(vec![fault], false);
        let pool = SharedModel::pool(model.clone(), 1).unwrap();
        let engine = Engine::open(
            data.path(),
            pool.clone(),
            Limits {
                stream_idle_timeout: Duration::from_millis(500),
                model_request_timeout: Duration::from_millis(500),
                max_completion_retries: 2,
                ..Limits::default()
            },
        )
        .unwrap();
        let thread = engine.create("/workspace".into()).await.unwrap();
        let mut events = engine.subscribe(&thread.id).await.unwrap();
        engine
            .goal_create(
                "test".into(),
                serde_json::from_value(json!({
                    "requestId":"goal-network", "threadId":thread.id,
                    "expectedRevision":0, "objective":"Verify the result"
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        let result = settled(&engine, &thread.id).await;
        let error = &result.turns[0].error.as_ref().unwrap().message;
        let cause = match fault {
            Fault::Error(failure) => failure.to_string(),
            Fault::RequestIdle => "model request idle timeout".into(),
            Fault::StreamIdle => "model stream idle timeout".into(),
        };
        assert!(error.contains("GOAL_USAGE_UNKNOWN"), "{error}");
        assert!(error.contains(&cause), "{error}");
        let goal = engine.goal_get(&thread.id).await.unwrap();
        assert_eq!(goal["goal"]["status"], "blocked");
        assert_eq!(goal["goal"]["reason"], "usageUnknown");
        assert_eq!(goal["goal"]["usage"]["unknownRequests"], 1);
        assert!(
            !goal["goal"]["usage"]["accountingComplete"]
                .as_bool()
                .unwrap()
        );
        assert!(goal["goal"]["usage"]["reservedTokens"].as_u64().unwrap() > 0);
        assert_eq!(model.requests.load(Ordering::SeqCst), 1);
        assert_eq!(pool.load().unwrap().in_flight, 0);
        while let Ok(event) = events.try_recv() {
            assert_ne!(event["method"], "areal/model/watchdogRetry");
        }
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn goal_summary_network_failure_blocks_without_replacing_the_checkpoint() {
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
    for prompt in ["Original", "Continue"] {
        engine
            .start(&thread.id, vec![Input::text(prompt)])
            .await
            .unwrap();
        settled(&engine, &thread.id).await;
    }
    let previous = engine
        .read(&thread.id, true)
        .await
        .unwrap()
        .context_checkpoint;
    let mut events = engine.subscribe(&thread.id).await.unwrap();
    engine
        .goal_create(
            "test".into(),
            serde_json::from_value(json!({
                "requestId":"goal-summary", "threadId":thread.id,
                "expectedRevision":0, "objective":"Verify the result"
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    let result = settled(&engine, &thread.id).await;
    let error = &result.turns.last().unwrap().error.as_ref().unwrap().message;
    assert!(error.contains("GOAL_USAGE_UNKNOWN"), "{error}");
    assert!(error.contains("model stream transport failed"), "{error}");
    let goal = engine.goal_get(&thread.id).await.unwrap();
    assert_eq!(goal["goal"]["status"], "blocked");
    assert_eq!(goal["goal"]["reason"], "usageUnknown");
    assert_eq!(goal["goal"]["usage"]["unknownRequests"], 1);
    assert_eq!(goal["goal"]["usage"]["tokensUsed"], 4);
    assert_eq!(model.attempts.load(Ordering::SeqCst), 1);
    assert_eq!(
        serde_json::to_value(result.context_checkpoint).unwrap(),
        serde_json::to_value(previous).unwrap()
    );
    while let Ok(event) = events.try_recv() {
        assert_ne!(event["method"], "areal/model/watchdogRetry");
    }
    engine.shutdown().await;
}

#[tokio::test]
async fn goal_http_rejections_preserve_the_cause_and_safe_audit() {
    use areal_engine::model::{HttpModel, ModelOptions, ModelProtocol};
    use axum::{Router, http::StatusCode, routing::post};

    for protocol in [ModelProtocol::ChatCompletions, ModelProtocol::Responses] {
        for (status, content_type, cause) in [
            (
                200,
                "text/html; private=private-header",
                "model response must use text/event-stream",
            ),
            (
                401,
                "application/json",
                "model HTTP status 401 Unauthorized",
            ),
        ] {
            let requests = Arc::new(AtomicUsize::new(0));
            let captured = requests.clone();
            let app = Router::new().route(
                "/v1",
                post(move || {
                    captured.fetch_add(1, Ordering::SeqCst);
                    async move {
                        (
                            StatusCode::from_u16(status).unwrap(),
                            [("content-type", content_type)],
                            "private-error-body",
                        )
                    }
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!(
                "http://{}/v1?token=private-url",
                listener.local_addr().unwrap()
            );
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let data = tempfile::tempdir().unwrap();
            let audit_dir = data.path().join("requests");
            let model = HttpModel::with_protocol(
                endpoint,
                "fixture".into(),
                Some("private-key".into()),
                protocol,
            )
            .unwrap()
            .with_options(ModelOptions {
                max_retries: 2,
                ..Default::default()
            })
            .unwrap()
            .with_audit_directory(audit_dir.clone());
            let engine = Engine::open(
                data.path(),
                Arc::new(model),
                Limits {
                    max_completion_retries: 2,
                    ..Default::default()
                },
            )
            .unwrap();
            let thread = engine.create("/workspace".into()).await.unwrap();
            let mut events = engine.subscribe(&thread.id).await.unwrap();
            engine
                .goal_create(
                    "test".into(),
                    serde_json::from_value(json!({
                        "requestId":"goal-http", "threadId":thread.id,
                        "expectedRevision":0, "objective":"private-prompt"
                    }))
                    .unwrap(),
                )
                .await
                .unwrap();
            let result = settled(&engine, &thread.id).await;
            assert_eq!(result.turns[0].status, TurnStatus::Failed);
            let error = &result.turns[0].error.as_ref().unwrap().message;
            assert!(error.contains("GOAL_USAGE_UNKNOWN"), "{error}");
            assert!(error.contains(cause), "{error}");
            if status == 200 {
                assert!(error.contains("/v1/chat/completions"), "{error}");
            }
            let goal = engine.goal_get(&thread.id).await.unwrap();
            assert_eq!(goal["goal"]["status"], "blocked");
            assert_eq!(goal["goal"]["reason"], "usageUnknown");
            assert_eq!(goal["goal"]["usage"]["unknownRequests"], 1);
            assert!(goal["goal"]["usage"]["reservedTokens"].as_u64().unwrap() > 0);
            assert_eq!(requests.load(Ordering::SeqCst), 1);
            while let Ok(event) = events.try_recv() {
                assert_ne!(event["method"], "areal/model/watchdogRetry");
            }
            let audit_text = std::fs::read_to_string(audit_dir.join("requests.jsonl")).unwrap();
            let records = audit_text
                .lines()
                .map(|line| serde_json::from_str::<Value>(line).unwrap())
                .collect::<Vec<_>>();
            assert_eq!(records.len(), 1);
            let audit = &records[0];
            assert_eq!(audit["httpStatus"], status);
            assert_eq!(audit["httpAttempts"], 1);
            assert_eq!(audit["outcome"], "failed");
            assert_eq!(audit["usageObserved"], false);
            assert!(audit["error"].as_str().unwrap().contains(cause));
            for private in [
                "private-header",
                "private-error-body",
                "private-url",
                "private-key",
                "private-prompt",
                "127.0.0.1",
            ] {
                assert!(!audit_text.contains(private), "{private}");
                assert!(!error.contains(private), "{private}");
            }
            engine.shutdown().await;
            server.abort();
            let _ = server.await;
        }
    }
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

#[tokio::test]
async fn network_backoff_releases_engine_capacity_to_healthy_threads() {
    struct Routes {
        healthy_started: tokio::sync::Semaphore,
    }
    #[async_trait]
    impl Model for Routes {
        fn name(&self) -> &str {
            "independent-network-routes"
        }
        async fn stream(&self, messages: Vec<Message>) -> anyhow::Result<ModelStream> {
            if messages.iter().any(|message| {
                message.role == "user" && message.text_content() == "unavailable route"
            }) {
                return Err(ModelFailure::Transport.into());
            }
            self.healthy_started.add_permits(1);
            Ok(Box::pin(stream::iter([Ok(ModelEvent::text(
                "healthy result",
            ))])))
        }
    }
    let data = tempfile::tempdir().unwrap();
    let model = Arc::new(Routes {
        healthy_started: tokio::sync::Semaphore::new(0),
    });
    let engine = Engine::open(
        data.path(),
        model.clone(),
        Limits {
            model_concurrency: 1,
            ..Limits::default()
        },
    )
    .unwrap();
    let failed = engine.create("/workspace".into()).await.unwrap();
    let mut events = engine.subscribe(&failed.id).await.unwrap();
    let failed_turn = engine
        .start(&failed.id, vec![Input::text("unavailable route")])
        .await
        .unwrap();
    // 第四次退避为两秒，留出明确窗口检查另一个会话，不依赖请求耗时。
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let event = events.recv().await.unwrap();
            if event["method"] == "areal/model/watchdogRetry" && event["params"]["retry"] == 4 {
                break;
            }
        }
    })
    .await
    .unwrap();
    let healthy = engine.create("/workspace".into()).await.unwrap();
    engine
        .start(&healthy.id, vec![Input::text("healthy route")])
        .await
        .unwrap();
    let started_during_backoff =
        tokio::time::timeout(Duration::from_secs(1), model.healthy_started.acquire())
            .await
            .is_ok();
    engine.interrupt(&failed.id, &failed_turn.id).await.unwrap();
    let result = settled(&engine, &healthy.id).await;
    engine.shutdown().await;
    assert_eq!(result.turns[0].status, TurnStatus::Completed);
    assert!(
        started_during_backoff,
        "network backoff reserved the sole Engine model permit and blocked a healthy thread"
    );
}

#[tokio::test]
async fn summary_requests_share_capacity_but_release_it_before_network_backoff() {
    struct Routes {
        summary_started: tokio::sync::Semaphore,
        release_summary: tokio::sync::Semaphore,
        healthy_started: tokio::sync::Semaphore,
        summaries: AtomicUsize,
        healthy_after_summaries: AtomicUsize,
    }
    #[async_trait]
    impl Model for Routes {
        fn name(&self) -> &str {
            "summary-capacity-routes"
        }
        async fn stream(&self, messages: Vec<Message>) -> anyhow::Result<ModelStream> {
            let healthy = messages
                .iter()
                .any(|message| message.role == "user" && message.text_content() == "healthy route");
            if healthy {
                self.healthy_after_summaries
                    .store(self.summaries.load(Ordering::SeqCst), Ordering::SeqCst);
                self.healthy_started.add_permits(1);
            }
            Ok(Box::pin(stream::iter([Ok(ModelEvent::text(if healthy {
                "healthy result".into()
            } else {
                "observed result ".repeat(95)
            }))])))
        }
        async fn chat_for(
            &self,
            messages: Vec<Message>,
            _: Vec<Value>,
            purpose: RequestPurpose,
        ) -> anyhow::Result<ModelStream> {
            if purpose != RequestPurpose::Summary {
                return self.stream(messages).await;
            }
            self.summaries.fetch_add(1, Ordering::SeqCst);
            self.summary_started.add_permits(1);
            self.release_summary.acquire().await?.forget();
            Err(ModelFailure::Transport.into())
        }
    }
    let data = tempfile::tempdir().unwrap();
    let model = Arc::new(Routes {
        summary_started: tokio::sync::Semaphore::new(0),
        release_summary: tokio::sync::Semaphore::new(0),
        healthy_started: tokio::sync::Semaphore::new(0),
        summaries: AtomicUsize::new(0),
        healthy_after_summaries: AtomicUsize::new(usize::MAX),
    });
    let engine = Engine::open(
        data.path(),
        model.clone(),
        Limits {
            model_concurrency: 1,
            context_window_bytes: 2200,
            context_recent_bytes: 256,
            ..Limits::default()
        },
    )
    .unwrap();
    let source = engine.create("/workspace".into()).await.unwrap();
    let mut events = engine.subscribe(&source.id).await.unwrap();
    let drive = {
        let engine = engine.clone();
        let source_id = source.id.clone();
        tokio::spawn(async move {
            for prompt in ["Original", "Continue", "Verify"] {
                engine
                    .start(&source_id, vec![Input::text(prompt)])
                    .await
                    .unwrap();
                if settled(&engine, &source_id)
                    .await
                    .turns
                    .last()
                    .unwrap()
                    .status
                    != TurnStatus::Completed
                {
                    break;
                }
            }
        })
    };
    tokio::time::timeout(Duration::from_secs(5), model.summary_started.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    let healthy = engine.create("/workspace".into()).await.unwrap();
    engine
        .start(&healthy.id, vec![Input::text("healthy route")])
        .await
        .unwrap();
    let admitted_during_summary =
        tokio::time::timeout(Duration::from_millis(100), model.healthy_started.acquire())
            .await
            .is_ok();
    model.release_summary.add_permits(1);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = events.recv().await.unwrap();
            if event["method"] == "areal/model/watchdogRetry"
                && event["params"]["purpose"] == "summary"
            {
                break;
            }
        }
    })
    .await
    .unwrap();
    let admitted_after_failure =
        tokio::time::timeout(Duration::from_secs(1), model.healthy_started.acquire())
            .await
            .is_ok();
    let current = engine.read(&source.id, true).await.unwrap();
    engine
        .interrupt(&source.id, &current.turns.last().unwrap().id)
        .await
        .unwrap();
    model.release_summary.add_permits(8);
    drive.await.unwrap();
    assert_eq!(
        settled(&engine, &healthy.id).await.turns[0].status,
        TurnStatus::Completed
    );
    engine.shutdown().await;
    assert!(
        !admitted_during_summary,
        "active summary bypassed Engine model capacity"
    );
    assert!(
        admitted_after_failure,
        "summary retry backoff blocked the healthy request"
    );
    assert_eq!(model.healthy_after_summaries.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn default_http_retries_release_nested_capacity_and_preserve_budget_and_cancellation() {
    use areal_engine::model::{HttpModel, ModelProtocol};
    use axum::{Json, Router, body::Body, http::StatusCode, response::IntoResponse, routing::post};
    struct HttpState {
        failed: tokio::sync::Semaphore,
        healthy: tokio::sync::Semaphore,
        finish: tokio::sync::Semaphore,
        bad_requests: AtomicUsize,
        healthy_requests: AtomicUsize,
    }
    for action in ["complete", "cancel", "budget"] {
        let http = Arc::new(HttpState {
            failed: tokio::sync::Semaphore::new(0),
            healthy: tokio::sync::Semaphore::new(0),
            finish: tokio::sync::Semaphore::new(0),
            bad_requests: AtomicUsize::new(0),
            healthy_requests: AtomicUsize::new(0),
        });
        let state = http.clone();
        let app = Router::new().route("/", post(move |Json(body): Json<Value>| {
            let state = state.clone();
            async move {
                if body["messages"].to_string().contains("failing HTTP route") {
                    state.bad_requests.fetch_add(1, Ordering::SeqCst);
                    state.failed.add_permits(1);
                    return (StatusCode::SERVICE_UNAVAILABLE, [("retry-after", "2")], "temporary failure").into_response();
                }
                state.healthy_requests.fetch_add(1, Ordering::SeqCst);
                state.healthy.add_permits(1);
                let events = stream::once(async { Ok::<_, std::convert::Infallible>("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"healthy\"}}]}\n\n") })
                    .chain(stream::once(async move {
                        state.finish.acquire().await.unwrap().forget();
                        Ok("data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1}}\n\ndata: [DONE]\n\n")
                    }));
                axum::http::Response::builder().header("content-type", "text/event-stream").body(Body::from_stream(events)).unwrap()
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        // 保留 HttpModel 默认两次 HTTP 重试，不能仅验证关闭内部重试的理想路径。
        let inner = Arc::new(
            HttpModel::with_protocol(
                endpoint,
                "fixture".into(),
                None,
                ModelProtocol::ChatCompletions,
            )
            .unwrap(),
        );
        let pool = if action == "budget" {
            SharedModel::new(inner, 1, 2).unwrap()
        } else {
            SharedModel::pool(inner, 1).unwrap()
        };
        let data = tempfile::tempdir().unwrap();
        let engine = Engine::open(
            data.path(),
            pool.clone(),
            Limits {
                model_concurrency: 1,
                watchdog_disable: true,
                ..Limits::default()
            },
        )
        .unwrap();
        let bad = engine.create("/workspace".into()).await.unwrap();
        let bad_turn = engine
            .start(&bad.id, vec![Input::text("failing HTTP route")])
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), http.failed.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
        let good = engine.create("/workspace".into()).await.unwrap();
        engine
            .start(&good.id, vec![Input::text("healthy HTTP route")])
            .await
            .unwrap();
        let admitted =
            tokio::time::timeout(Duration::from_millis(900), http.healthy.acquire()).await;
        let progressed_during_backoff = admitted.is_ok();
        if let Ok(Ok(permit)) = admitted {
            permit.forget();
        }
        if action == "complete" && progressed_during_backoff {
            let second = engine.create("/workspace".into()).await.unwrap();
            engine
                .start(&second.id, vec![Input::text("second healthy HTTP route")])
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_millis(60)).await;
            assert_eq!(
                http.healthy_requests.load(Ordering::SeqCst),
                1,
                "live streams must retain nested request capacity"
            );
        }
        http.finish.add_permits(8);
        if action == "cancel" {
            engine.interrupt(&bad.id, &bad_turn.id).await.unwrap();
        }
        let good_done = settled(&engine, &good.id).await;
        let bad_done = settled(&engine, &bad.id).await;
        engine.shutdown().await;
        server.abort();
        assert!(
            progressed_during_backoff,
            "default HTTP retry held Engine or SharedModel capacity: {action}"
        );
        assert_eq!(good_done.turns[0].status, TurnStatus::Completed);
        if action == "complete" {
            assert_eq!(http.bad_requests.load(Ordering::SeqCst), 3);
        } else {
            assert_eq!(http.bad_requests.load(Ordering::SeqCst), 1);
        }
        assert_eq!(
            bad_done.turns[0].status,
            if action == "cancel" {
                TurnStatus::Interrupted
            } else {
                TurnStatus::Failed
            }
        );
        let usage = pool.usage();
        let observed =
            http.bad_requests.load(Ordering::SeqCst) + http.healthy_requests.load(Ordering::SeqCst);
        if action == "cancel" {
            // 取消可能落在本地准入与服务端观察之间；该次预留必须保留 UNKNOWN。
            assert!((observed..=observed + 1).contains(&usage.requests));
            assert!(usage.unknown_requests >= http.bad_requests.load(Ordering::SeqCst));
        } else {
            assert_eq!(usage.requests, observed, "{action}");
            assert_eq!(
                usage.unknown_requests,
                http.bad_requests.load(Ordering::SeqCst),
                "failed HTTP attempts remain UNKNOWN, not zero usage: {action}"
            );
        }
        let load = pool.load().unwrap();
        assert_eq!(load.in_flight, 0);
        assert_eq!(load.waiting, 0);
        assert_eq!(load.started_requests as usize, usage.requests);
    }
}
