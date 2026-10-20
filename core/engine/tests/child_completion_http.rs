use areal_engine::{
    Engine, Limits,
    model::{HttpModel, ModelOptions, ModelProtocol},
};
use areal_protocol::{AgentMessagePhase, Input, Item, TurnStatus};
use axum::{Json, Router, routing::post};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Semaphore, mpsc};

struct Fixture {
    responses: bool,
    execution_id: bool,
    parent_requests: AtomicUsize,
    child_requests: AtomicUsize,
    ready: mpsc::UnboundedSender<()>,
    release: Semaphore,
}

fn content(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.into();
    }
    value
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|part| part["text"].as_str())
        .collect()
}

impl Fixture {
    async fn respond(&self, request: Value) -> String {
        let messages = request[if self.responses { "input" } else { "messages" }]
            .as_array()
            .unwrap();
        assert_eq!(request["stream"], true);
        let child = messages
            .iter()
            .any(|m| m["role"] == "user" && content(&m["content"]) == "wire-child");
        let mut tool = None;
        let text;
        if child {
            self.child_requests.fetch_add(1, Ordering::SeqCst);
            text = "wire child finding";
        } else {
            let index = self.parent_requests.fetch_add(1, Ordering::SeqCst);
            match index {
                0 => {
                    let mut args = json!({"prompt":"wire-child"});
                    if self.execution_id {
                        args["intent"] = json!("inspect");
                        args["delivery"] = json!("report");
                    }
                    tool = Some(("agent_spawn", args));
                    text = "";
                }
                1 => {
                    self.ready.send(()).unwrap();
                    self.release.acquire().await.unwrap().forget();
                    let result = messages
                        .iter()
                        .find(|m| m["role"] == "tool" || m["type"] == "function_call_output")
                        .unwrap();
                    let value: Value = serde_json::from_str(&content(
                        &result[if self.responses { "output" } else { "content" }],
                    ))
                    .unwrap();
                    let key = if self.execution_id {
                        "executionId"
                    } else {
                        "threadId"
                    };
                    assert!(value[key].is_string(), "{value}");
                    tool = Some(("agent_wait", json!({key:value[key],"timeoutMs":0})));
                    text = "";
                }
                2 => {
                    let result = messages
                        .iter()
                        .rev()
                        .find(|m| m["role"] == "tool" || m["type"] == "function_call_output")
                        .unwrap();
                    let value: Value = serde_json::from_str(&content(
                        &result[if self.responses { "output" } else { "content" }],
                    ))
                    .unwrap();
                    assert_eq!(value["text"], "wire child finding");
                    assert_eq!(value["settled"], true);
                    assert_eq!(value["resourcesReleased"], true);
                    text = "final uses the delivered wire result";
                }
                // 通过真实传输返回空正文，确保重复收尾不会被模型替身的固定答案遮住。
                _ => text = "",
            }
        }
        let mut events = Vec::new();
        if self.responses {
            if let Some((name, args)) = tool {
                events.push(json!({"type":"response.output_item.done","output_index":0,
                    "item":{"type":"function_call","id":format!("fc_{name}"),"call_id":name,
                    "name":name,"arguments":args.to_string()}}));
            } else if !text.is_empty() {
                events.push(json!({"type":"response.output_text.delta","delta":text}));
            }
            events.push(json!({"type":"response.completed","response":{
                "status":"completed","usage":{"input_tokens":10,"output_tokens":1}}}));
        } else {
            let (delta, finish) = if let Some((name, args)) = tool {
                (
                    json!({"tool_calls":[{"index":0,"id":name,"type":"function",
                    "function":{"name":name,"arguments":args.to_string()}}]}),
                    "tool_calls",
                )
            } else {
                (json!({"content":text}), "stop")
            };
            events.push(json!({"choices":[{"index":0,"delta":delta,"finish_reason":null}]}));
            events.push(
                json!({"choices":[{"index":0,"delta":{},"finish_reason":finish}],
                "usage":{"prompt_tokens":10,"completion_tokens":1}}),
            );
        }
        let mut body: String = events
            .into_iter()
            .map(|v| format!("data: {v}\n\n"))
            .collect();
        if !self.responses {
            body.push_str("data: [DONE]\n\n");
        }
        body
    }
}

async fn exercise(responses: bool, execution_id: bool) {
    let (ready, mut receiver) = mpsc::unbounded_channel();
    let fixture = Arc::new(Fixture {
        responses,
        execution_id,
        parent_requests: AtomicUsize::new(0),
        child_requests: AtomicUsize::new(0),
        ready,
        release: Semaphore::new(0),
    });
    let handler = fixture.clone();
    let app = Router::new().route(
        "/",
        post(move |Json(request): Json<Value>| {
            let handler = handler.clone();
            async move {
                (
                    [("content-type", "text/event-stream")],
                    handler.respond(request).await,
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let model = HttpModel::with_protocol(
        format!("http://{address}/"),
        "wire-fixture".into(),
        None,
        if responses {
            ModelProtocol::Responses
        } else {
            ModelProtocol::ChatCompletions
        },
    )
    .unwrap()
    .with_options(ModelOptions {
        max_retries: 0,
        ..Default::default()
    })
    .unwrap();
    let data = tempfile::tempdir().unwrap();
    let engine = Engine::open(
        data.path(),
        Arc::new(model),
        Limits {
            watchdog_disable: true,
            ..Limits::default()
        },
    )
    .unwrap();
    let parent = engine.create("/workspace".into()).await.unwrap();
    engine
        .start(&parent.id, vec![Input::text("wire-parent")])
        .await
        .unwrap();
    let done = tokio::time::timeout(Duration::from_secs(10), async {
        receiver.recv().await.unwrap();
        let children = engine.list(None, 10, Some(&parent.id)).await.unwrap().0;
        assert_eq!(children.len(), 1);
        let child = engine.wait(&children[0].id).await.unwrap();
        assert_eq!(child.turns[0].status, TurnStatus::Completed);
        fixture.release.add_permits(1);
        engine.wait(&parent.id).await.unwrap()
    })
    .await;
    engine.shutdown().await;
    server.abort();
    let _ = server.await;
    let done = done.expect("HTTP child completion deadlocked");
    assert_eq!(fixture.parent_requests.load(Ordering::SeqCst), 3);
    assert_eq!(fixture.child_requests.load(Ordering::SeqCst), 1);
    assert_eq!(
        done.turns[0].status,
        TurnStatus::Completed,
        "{:?}",
        done.turns[0].error
    );
    assert_eq!(done.turns[0].usage.as_ref().unwrap().input_tokens, 30);
    assert!(matches!(done.turns[0].items.last(),
        Some(Item::AgentMessage {text, phase:Some(AgentMessagePhase::FinalAnswer), ..})
        if text == "final uses the delivered wire result"));
}

#[tokio::test]
async fn chat_completion_legacy_child_finishes_without_duplicate_request() {
    exercise(false, false).await;
}

#[tokio::test]
async fn chat_completion_execution_finishes_without_duplicate_request() {
    exercise(false, true).await;
}

#[tokio::test]
async fn responses_legacy_child_finishes_without_duplicate_request() {
    exercise(true, false).await;
}

#[tokio::test]
async fn responses_execution_finishes_without_duplicate_request() {
    exercise(true, true).await;
}
