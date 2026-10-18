use areal_engine::{
    Engine, Limits,
    model::{HttpModel, Message, Model, ModelEvent, ModelProtocol, ModelStream},
};
use areal_protocol::{Input, Item, TurnStatus};
use async_trait::async_trait;
use axum::{
    Router,
    response::sse::{Event, Sse},
    routing::post,
};
use serde_json::{Value, json};
use std::{convert::Infallible, sync::Arc, time::Duration};
use tokio::sync::{Mutex, mpsc};

#[tokio::test]
async fn a_shared_chunk_error_follows_reasoning_without_waiting_for_more_network_data() {
    use axum::{body::Body, response::Response};
    use futures_util::StreamExt;

    for protocol in [ModelProtocol::ChatCompletions, ModelProtocol::Responses] {
        let frames = if protocol == ModelProtocol::ChatCompletions {
            [
                json!({"choices":[{"index":0,"delta":{"reasoning_content":"partial"}}]}),
                json!({"error":{"code":"server_error","message":"fixture failure"}}),
            ]
        } else {
            [
                json!({"type":"response.reasoning_summary_text.delta","item_id":"r","summary_index":0,"delta":"partial"}),
                json!({"type":"response.failed","response":{"error":{"code":"server_error","message":"fixture failure"}}}),
            ]
        };
        let chunk = frames.map(|frame| format!("data: {frame}\n\n")).concat();
        let app = Router::new().route(
            "/",
            post(move || {
                let chunk = chunk.clone();
                async move {
                    // 故意保持连接不结束，确保已知错误不依赖下一次网络读取。
                    let body = futures_util::stream::iter([Ok::<_, Infallible>(chunk)])
                        .chain(futures_util::stream::pending());
                    Response::builder()
                        .header("content-type", "text/event-stream")
                        .body(Body::from_stream(body))
                        .unwrap()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let model = HttpModel::with_protocol(
            format!("http://{}/", listener.local_addr().unwrap()),
            "fixture".into(),
            None,
            protocol,
        )
        .unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut stream = model.stream(Vec::new()).await.unwrap();
        let mut saw_reasoning = false;
        loop {
            let next = tokio::time::timeout(Duration::from_secs(5), stream.next())
                .await
                .expect("known error must not wait for more bytes")
                .expect("error must not be reported as success");
            match next {
                Ok(ModelEvent::Activity) => {}
                Ok(ModelEvent::ReasoningDelta { delta, .. }) => {
                    assert_eq!(delta, "partial");
                    saw_reasoning = true;
                }
                Err(error) => {
                    assert!(saw_reasoning);
                    assert!(error.to_string().contains("server_error"));
                    break;
                }
                _ => panic!("unexpected model event"),
            }
        }
        assert!(stream.next().await.is_none());
        drop(stream);
        server.abort();
        let _ = server.await;
    }
}

async fn event(events: &mut tokio::sync::broadcast::Receiver<Value>, method: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = events.recv().await.unwrap();
            if event["method"] == method {
                return event;
            }
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn http_reasoning_arrives_before_body_and_survives_completion_or_interrupt() {
    for (protocol, interrupt) in [
        (ModelProtocol::ChatCompletions, false),
        (ModelProtocol::ChatCompletions, true),
        (ModelProtocol::Responses, false),
        (ModelProtocol::Responses, true),
    ] {
        let responses = protocol == ModelProtocol::Responses;
        let (method, field, parts) = if responses {
            ("item/reasoning/summaryTextDelta", "summaryIndex", "summary")
        } else {
            ("item/reasoning/textDelta", "contentIndex", "content")
        };
        let (sender, receiver) = mpsc::channel::<Value>(8);
        let receiver = Arc::new(Mutex::new(Some(receiver)));
        let app = Router::new().route(
            "/",
            post(move || {
                let receiver = receiver.clone();
                async move {
                    let receiver = receiver.lock().await.take().unwrap();
                    Sse::new(futures_util::stream::unfold(
                        receiver,
                        |mut receiver| async {
                            receiver.recv().await.map(|value| {
                                (
                                    Ok::<_, Infallible>(Event::default().data(value.to_string())),
                                    receiver,
                                )
                            })
                        },
                    ))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let model = Arc::new(
            HttpModel::with_protocol(
                format!("http://{}/", listener.local_addr().unwrap()),
                "fixture".into(),
                None,
                protocol,
            )
            .unwrap(),
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let data = tempfile::tempdir().unwrap();
        let engine = Engine::open(data.path(), model.clone(), Limits::default()).unwrap();
        let thread = engine.create("/workspace".into()).await.unwrap();
        let mut events = engine.subscribe(&thread.id).await.unwrap();
        let turn = engine
            .start(&thread.id, vec![Input::text("Inspect")])
            .await
            .unwrap();
        let mut reasoning_id = String::new();
        for (index, text) in ["检查", "依赖🙂"].iter().enumerate() {
            let frame = if responses {
                json!({"type":"response.reasoning_summary_text.delta","item_id":"rs1","summary_index":0,"delta":text})
            } else {
                json!({"choices":[{"index":0,"delta":{"reasoning_content":text,"content":null}}]})
            };
            sender.send(frame).await.unwrap();
            if index == 0 {
                loop {
                    let started = event(&mut events, "item/started").await;
                    if started["params"]["item"]["type"] == "reasoning" {
                        reasoning_id = started["params"]["item"]["id"].as_str().unwrap().to_owned();
                        assert_eq!(started["params"]["item"]["content"], json!([]));
                        break;
                    }
                }
            }
            let delta = event(&mut events, method).await;
            assert_eq!(delta["params"]["delta"], *text);
            assert_eq!(delta["params"]["itemId"], reasoning_id);
            assert_eq!(delta["params"][field], 0);
        }
        let (snapshot, _) = engine.snapshot_and_subscribe(&thread.id).await.unwrap();
        assert_eq!(snapshot.turns[0].status, TurnStatus::InProgress);
        assert!(
            snapshot.turns[0]
                .items
                .iter()
                .any(|i| matches!(i, Item::Reasoning {content,summary,..} if (if responses {summary} else {content}) == &["检查依赖🙂"]))
        );
        assert!(
            !snapshot.turns[0]
                .items
                .iter()
                .any(|i| matches!(i, Item::AgentMessage {text,..} if !text.is_empty()))
        );
        if interrupt {
            engine.interrupt(&thread.id, &turn.id).await.unwrap();
        } else {
            if responses {
                sender
                    .send(json!({"type":"response.output_text.delta","delta":"done"}))
                    .await
                    .unwrap();
                sender.send(json!({"type":"response.completed","response":{"status":"completed","output":[{"type":"reasoning","id":"rs1","summary":[{"type":"summary_text","text":"检查依赖🙂"}],"encrypted_content":"opaque-fixture"}]}})).await.unwrap();
            } else {
                sender.send(json!({"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]})).await.unwrap();
            }
        }
        drop(sender);
        let finished = tokio::time::timeout(Duration::from_secs(5), engine.wait(&thread.id))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            finished.turns[0].status,
            if interrupt {
                TurnStatus::Interrupted
            } else {
                TurnStatus::Completed
            }
        );
        let completed = loop {
            let completed = event(&mut events, "item/completed").await;
            if completed["params"]["item"]["id"] == reasoning_id {
                break completed;
            }
        };
        assert_eq!(completed["params"]["item"]["id"], reasoning_id);
        assert_eq!(completed["params"]["item"][parts], json!(["检查依赖🙂"]));
        engine.shutdown().await;
        drop(engine);
        let reopened = Engine::open(data.path(), model, Limits::default()).unwrap();
        let saved = reopened.read(&thread.id, true).await.unwrap();
        assert_eq!(
            serde_json::to_value(saved.turns).unwrap(),
            serde_json::to_value(finished.turns).unwrap()
        );
        reopened.shutdown().await;
        server.abort();
        let _ = server.await;
    }
}

struct ReasoningOnly;
#[async_trait]
impl Model for ReasoningOnly {
    fn name(&self) -> &str {
        "reasoning-only"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        Ok(Box::pin(futures_util::stream::iter([Ok(
            ModelEvent::reasoning("thinking"),
        )])))
    }
}

#[tokio::test]
async fn reasoning_is_bounded_and_is_not_a_successful_answer() {
    for (max_output_bytes, error) in [
        (7, "reasoning output limit"),
        (1024, "without visible output"),
    ] {
        let data = tempfile::tempdir().unwrap();
        let engine = Engine::open(
            data.path(),
            Arc::new(ReasoningOnly),
            Limits {
                max_output_bytes,
                ..Limits::default()
            },
        )
        .unwrap();
        let thread = engine.create("/workspace".into()).await.unwrap();
        engine
            .start(&thread.id, vec![Input::text("Inspect")])
            .await
            .unwrap();
        let result = engine.wait(&thread.id).await.unwrap();
        assert_eq!(result.turns[0].status, TurnStatus::Failed);
        assert!(
            result.turns[0]
                .error
                .as_ref()
                .unwrap()
                .message
                .contains(error),
            "{:?}",
            result.turns[0].error
        );
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn responses_summary_is_opt_in_and_provider_context_replays_once() {
    use areal_engine::model::ModelOptions;
    use areal_protocol::desktop::{ConfigureThread, ForkAnchor, ForkThread, ModelParameters};
    use axum::Json;
    let context = json!({"type":"reasoning","id":"r1","summary":[{"type":"summary_text","text":"public summary"}],"encrypted_content":"opaque-provider-context"});
    for (index, summary) in [None, Some("auto"), Some("concise"), Some("detailed")]
        .into_iter()
        .enumerate()
    {
        let (requests, mut received) = mpsc::unbounded_channel();
        let returned = context.clone();
        let app = Router::new().route("/", post(move |Json(request): Json<Value>| {
            let requests = requests.clone();
            let returned = returned.clone();
            async move {
                requests.send(request).unwrap();
                let events = [
                    json!({"type":"response.reasoning_summary_text.delta","item_id":"r1","summary_index":0,"delta":"public "}),
                    json!({"type":"response.reasoning_summary_text.done","item_id":"r1","summary_index":0,"text":"public summary"}),
                    json!({"type":"response.output_text.delta","delta":"answer"}),
                    json!({"type":"response.output_item.done","item":returned}),
                    json!({"type":"response.completed","response":{"status":"completed","output":[returned],"usage":{"input_tokens":2,"output_tokens":3}}}),
                ].into_iter().map(|v| Ok::<_, Infallible>(Event::default().data(v.to_string())));
                Sse::new(futures_util::stream::iter(events))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let adapter = HttpModel::with_protocol(
            endpoint.clone(),
            "fixture".into(),
            None,
            ModelProtocol::Responses,
        )
        .unwrap()
        .with_options(ModelOptions {
            reasoning_effort: Some("low".into()),
            ..Default::default()
        })
        .unwrap();
        let model = adapter
            .configure(&ModelParameters {
                reasoning_summary: summary.map(str::to_owned),
                ..Default::default()
            })
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(dir.path(), model, Limits::default()).unwrap();
        let thread = engine.create("/workspace".into()).await.unwrap();
        for round in 0..2 {
            engine
                .start(&thread.id, vec![Input::text("Continue")])
                .await
                .unwrap();
            let finished = engine.wait(&thread.id).await.unwrap();
            let turn = finished.turns.last().unwrap();
            assert_eq!(turn.status, TurnStatus::Completed, "{:?}", turn.error);
            assert!(turn.items.iter().any(|i| matches!(i, Item::Reasoning {summary,content,..} if summary == &["public summary"] && content.is_empty())));
            assert_eq!(turn.usage.as_ref().unwrap().output_tokens, 3);
            let request = received.recv().await.unwrap();
            assert_eq!(request["reasoning"]["effort"], "low");
            assert_eq!(request["reasoning"]["summary"].as_str(), summary);
            if summary.is_none() {
                assert!(request["reasoning"].get("summary").is_none());
            }
            let input = request["input"].as_array().unwrap();
            let replayed: Vec<_> = input.iter().filter(|v| v["type"] == "reasoning").collect();
            assert_eq!(replayed.len(), round);
            if round == 1 {
                assert_eq!(replayed[0], &context);
            }
            assert!(
                !input
                    .iter()
                    .filter(|v| v["type"] != "reasoning")
                    .any(|v| v.to_string().contains("public summary"))
            );
        }
        let source = engine.read(&thread.id, true).await.unwrap();
        let fork = engine
            .fork_thread(
                "opaque-fixture".into(),
                ForkThread {
                    request_id: format!("opaque-{index}"),
                    source_thread_id: thread.id.clone(),
                    anchor: ForkAnchor {
                        turn_id: source.turns[0].id.clone(),
                        boundary: "after".into(),
                    },
                    workspace_mode: "sharedCurrent".into(),
                    target: None,
                },
            )
            .await
            .unwrap();
        assert!(fork.turns.is_empty());
        engine
            .start(&fork.id, vec![Input::text("Fork continuation")])
            .await
            .unwrap();
        let target = engine.wait(&fork.id).await.unwrap();
        assert_eq!(target.turns.len(), 1);
        assert_eq!(target.turns[0].usage.as_ref().unwrap().output_tokens, 3);
        let request = received.recv().await.unwrap();
        let input = request["input"].as_array().unwrap();
        assert_eq!(
            input
                .iter()
                .filter(|v| v["type"] == "reasoning")
                .collect::<Vec<_>>(),
            [&context]
        );
        assert!(
            input
                .iter()
                .any(|v| v["content"].to_string().contains("Fork continuation"))
        );
        if index == 0 {
            let chat = HttpModel::new(endpoint.clone(), "chat-fixture".into(), None).unwrap();
            engine.register_default_model("chat-revision".into(), Arc::new(chat), true);
            let configured = engine.configure_thread(serde_json::from_value::<ConfigureThread>(json!({
                "threadId":fork.id,"expectedRevision":fork.desktop.as_ref().unwrap().configuration.revision,
                "resetModel":true
            })).unwrap()).await.unwrap();
            assert_eq!(
                configured.revision,
                fork.desktop.as_ref().unwrap().configuration.revision + 1
            );
            let error = engine
                .start(
                    &fork.id,
                    vec![Input::text("must reject incompatible protocol")],
                )
                .await
                .unwrap_err();
            assert!(
                error.to_string().contains("MODEL_CONTEXT_INCOMPATIBLE"),
                "{error}"
            );
            assert_eq!(engine.read(&fork.id, true).await.unwrap().turns.len(), 1);
        }
        let wrong_protocol = HttpModel::new(endpoint, "fixture".into(), None)
            .unwrap()
            .with_options(ModelOptions {
                reasoning_summary: Some("auto".into()),
                ..Default::default()
            });
        assert!(wrong_protocol.is_err());
        engine.shutdown().await;
        server.abort();
        let _ = server.await;
    }
}
