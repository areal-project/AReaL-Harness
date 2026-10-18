use areal_engine::model::{HttpModel, Message, Model, ModelEvent, ModelFailure, ModelOptions};
use axum::{
    Router,
    response::sse::{Event, Sse},
    routing::post,
};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{convert::Infallible, time::Duration};

fn read_audit(directory: &std::path::Path) -> Value {
    let text = std::fs::read_to_string(directory.join("requests.jsonl")).unwrap();
    assert_eq!(text.lines().count(), 1);
    serde_json::from_str(text.trim()).unwrap()
}

#[tokio::test]
async fn truncated_usage_survives_frame_order_and_clean_eof_without_releasing_tools() {
    for text_only in [false, true] {
        for layout in ["same", "after", "before", "absent", "zero"] {
            for done in [false, true] {
                let usage = if layout == "zero" {
                    json!({"prompt_tokens":0,"completion_tokens":0})
                } else {
                    json!({"prompt_tokens":7,"completion_tokens":3,
                        "prompt_tokens_details":{"cached_tokens":2}})
                };
                let delta = if text_only {
                    json!({"content":"<tool_call>{\"name\":\"fs_stat\",\"arguments\":"})
                } else {
                    json!({"tool_calls":[{"index":0,"id":"partial",
                        "function":{"name":"fs_stat","arguments":"{"}}]})
                };
                let mut frames = vec![json!({"choices":[{"index":0,"delta":delta}]}).to_string()];
                if layout == "before" {
                    frames.push(json!({"choices":[],"usage":usage}).to_string());
                }
                let mut terminal =
                    json!({"choices":[{"index":0,"delta":{},"finish_reason":"length"}]});
                if layout == "same" {
                    terminal["usage"] = usage.clone();
                }
                frames.push(terminal.to_string());
                if layout == "after" || layout == "zero" {
                    frames.push(json!({"choices":[],"usage":usage}).to_string());
                }
                if done {
                    frames.push("[DONE]".into());
                }
                let app = Router::new().route(
                    "/",
                    post(move || {
                        let frames = frames.clone();
                        async move {
                            Sse::new(futures_util::stream::iter(frames).then(|frame| async move {
                                // Exercise trailers arriving in a later body chunk.
                                tokio::time::sleep(Duration::from_millis(2)).await;
                                Ok::<_, Infallible>(Event::default().data(frame))
                            }))
                        }
                    }),
                );
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let endpoint = format!("http://{}/", listener.local_addr().unwrap());
                let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
                let directory = tempfile::tempdir().unwrap();
                let model = HttpModel::new(endpoint, "fixture".into(), None)
                    .unwrap()
                    .with_options(ModelOptions {
                        ..Default::default()
                    })
                    .unwrap()
                    .with_audit_directory(directory.path().to_path_buf());
                let tools = vec![json!({"type":"function","function":{"name":"fs_stat",
                    "parameters":{"type":"object","properties":{"path":{"type":"string"}}}}})];
                let events = tokio::time::timeout(Duration::from_secs(5), async {
                    model
                        .chat(vec![Message::text("user", "fixture")], tools)
                        .await
                        .unwrap()
                        .collect::<Vec<_>>()
                        .await
                })
                .await
                .unwrap();
                assert!(
                    events
                        .iter()
                        .all(|event| !matches!(event, Ok(ModelEvent::ToolCall(_))))
                );
                let errors: Vec<_> = events
                    .iter()
                    .filter_map(|event| event.as_ref().err())
                    .collect();
                assert_eq!(errors.len(), 1);
                assert_eq!(
                    errors[0].downcast_ref::<ModelFailure>(),
                    Some(&ModelFailure::Truncated)
                );
                let usages: Vec<_> = events
                    .iter()
                    .filter_map(|event| match event {
                        Ok(ModelEvent::Usage(usage)) => Some(usage),
                        _ => None,
                    })
                    .collect();
                assert_eq!(
                    usages.len(),
                    usize::from(layout != "absent"),
                    "{layout}, text_only={text_only}, done={done}"
                );
                let audit = read_audit(directory.path());
                assert_eq!(audit["usageObserved"], layout != "absent");
                assert_eq!(audit["stopReason"], "length");
                assert_eq!(audit["outcome"], "failed");
                let expected = if layout == "absent" || layout == "zero" {
                    (0, 0, 0)
                } else {
                    (7, 3, 2)
                };
                assert_eq!(
                    audit["usage"],
                    json!({"inputTokens":expected.0,
                    "outputTokens":expected.1,"cachedInputTokens":expected.2})
                );
                server.abort();
                let _ = server.await;
            }
        }
    }
}

#[tokio::test]
async fn truncated_usage_wait_can_be_cancelled_and_missing_usage_is_unknown() {
    for include_usage in [false, true] {
        let mut frames =
            vec![json!({"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}).to_string()];
        if include_usage {
            frames.push(
                json!({"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}).to_string(),
            );
        }
        let app = Router::new().route(
            "/",
            post(move || {
                let frames = frames.clone();
                async move {
                    Sse::new(
                        futures_util::stream::iter(
                            frames
                                .into_iter()
                                .map(|frame| Ok::<_, Infallible>(Event::default().data(frame))),
                        )
                        .chain(futures_util::stream::pending()),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let directory = tempfile::tempdir().unwrap();
        let model = HttpModel::new(endpoint, "fixture".into(), None)
            .unwrap()
            .with_audit_directory(directory.path().to_path_buf());
        let mut stream = model
            .stream(vec![Message::text("user", "fixture")])
            .await
            .unwrap();
        let first = tokio::time::timeout(Duration::from_secs(5), stream.next())
            .await
            .unwrap();
        assert!(first.unwrap().is_ok());
        if include_usage {
            loop {
                let next = tokio::time::timeout(Duration::from_secs(5), stream.next())
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap();
                if matches!(next, ModelEvent::Usage(_)) {
                    break;
                }
            }
        }
        drop(stream);
        let audit = read_audit(directory.path());
        assert_eq!(audit["stopReason"], "length");
        assert_eq!(audit["usageObserved"], include_usage);
        assert_eq!(audit["outcome"], "interrupted_or_unfinished");
        assert_eq!(
            audit["usage"]["inputTokens"],
            if include_usage { 7 } else { 0 }
        );
        server.abort();
        let _ = server.await;
    }
}

#[tokio::test]
async fn truncated_usage_is_counted_once_across_engine_recovery() {
    use areal_engine::{Engine, Limits};
    use areal_protocol::{Input, Item, TurnStatus};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    let requests = Arc::new(AtomicUsize::new(0));
    let count = requests.clone();
    let app = Router::new().route("/", post(move || {
        let first = count.fetch_add(1, Ordering::SeqCst) == 0;
        async move {
            let frames = if first {
                vec![
                    json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"must-not-run",
                        "function":{"name":"fs_create","arguments":"{\"path\":\"must-not-exist\",\"text\":\"discarded\"}"}}]}}]}),
                    json!({"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}),
                    json!({"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":2}}}),
                ]
            } else {
                vec![
                    json!({"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}),
                    json!({"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":1}}}),
                ]
            };
            let body = frames.into_iter().map(|frame| format!("data: {frame}\n\n")).collect::<String>()
                + "data: [DONE]\n\n";
            ([("content-type", "text/event-stream")], body)
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let directory = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let audit_directory = directory.path().join("audits");
    let model = HttpModel::new(endpoint, "fixture".into(), None)
        .unwrap()
        .with_audit_directory(audit_directory.clone());
    let engine = Engine::open(
        &directory.path().join("core"),
        Arc::new(model),
        Limits {
            max_completion_retries: 1,
            ..Default::default()
        },
    )
    .unwrap();
    let thread = engine
        .create(workspace.path().to_string_lossy().into_owned())
        .await
        .unwrap();
    engine
        .start(&thread.id, vec![Input::text("fixture")])
        .await
        .unwrap();
    let completed = tokio::time::timeout(Duration::from_secs(5), engine.wait(&thread.id))
        .await
        .unwrap()
        .unwrap();
    let turn = &completed.turns[0];
    assert_eq!(turn.status, TurnStatus::Completed);
    assert!(
        turn.items
            .iter()
            .all(|item| !matches!(item, Item::DynamicToolCall { .. }))
    );
    assert!(!workspace.path().join("must-not-exist").exists());
    let usage = turn.usage.as_ref().unwrap();
    assert_eq!(
        (
            usage.input_tokens,
            usage.output_tokens,
            usage.cached_input_tokens
        ),
        (12, 5, 3)
    );
    assert_eq!(requests.load(Ordering::SeqCst), 2);
    let records: Vec<Value> = std::fs::read_to_string(audit_directory.join("requests.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(records.len(), 2);
    assert!(records.iter().all(|record| record["usageObserved"] == true));
    assert_eq!(records[0]["outcome"], "failed");
    assert_eq!(records[1]["outcome"], "completed");
    engine.shutdown().await;
    server.abort();
    let _ = server.await;
}
