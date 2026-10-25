#[path = "support/solve_only_http.rs"]
mod solve_only_http;
use solve_only_http::SolveOnlyHttpModel;

use areal_engine::{
    Engine, Limits,
    model::{ChatModel, HttpModel, ModelProtocol},
};
use areal_protocol::{Input, Item, Modality, TurnStatus};
use axum::{
    Json, Router,
    response::sse::{Event, Sse},
    routing::post,
};
use serde_json::{Value, json};
use std::{
    convert::Infallible,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

#[tokio::test]
async fn responses_argument_chunks_signal_activity_before_completion() {
    use areal_engine::model::{Message, Model, ModelEvent};
    use futures_util::{StreamExt, stream};
    use std::time::Duration;
    let release = Arc::new(tokio::sync::Notify::new());
    let gate = release.clone();
    let app = Router::new().route("/", post(move || {
        let gate = gate.clone();
        async move {
            let argument = json!({"type":"response.function_call_arguments.delta","delta":" ","item_id":"fc_test","output_index":0});
            let first = stream::once(async move {
                Ok::<_, Infallible>(Event::default().data(argument.to_string()))
            });
            let terminal = stream::once(async move {
                // 客户端观察到 Activity 才允许终态到达，避免靠 sleep 猜测 HTTP 分包。
                gate.notified().await;
                Ok::<_, Infallible>(Event::default().data(json!({"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":2}}}).to_string()))
            });
            Sse::new(first.chain(terminal))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let model = HttpModel::with_protocol(
        format!("http://{address}/"),
        "fixture".into(),
        None,
        ModelProtocol::Responses,
    )
    .unwrap();
    let mut response = model
        .stream(vec![Message::text("user", "write")])
        .await
        .unwrap();
    let first = tokio::time::timeout(Duration::from_secs(5), response.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(matches!(first, ModelEvent::Activity));
    release.notify_one();
    let rest = tokio::time::timeout(Duration::from_secs(5), response.collect::<Vec<_>>())
        .await
        .unwrap();
    assert!(rest.iter().all(Result::is_ok));
    assert!(rest.iter().any(|event| matches!(event, Ok(ModelEvent::Usage(usage)) if usage.input_tokens == 5 && usage.output_tokens == 2)));
    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn sampling_parameters_reach_solve_and_summary_http_requests_without_dropping_zero() {
    use areal_engine::model::{Message, Model, ModelOptions, RequestPurpose};
    use futures_util::StreamExt;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let app = Router::new().route("/", post(move |Json(request): Json<Value>| {
        let tx = tx.clone();
        async move {
            tx.send(request).unwrap();
            ([("content-type", "text/event-stream")], "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let configured = ModelOptions {
        reasoning_effort: Some("xhigh".into()),
        temperature: Some(1.0),
        top_p: Some(0.95),
        top_k: Some(20),
        min_p: Some(0.0),
        presence_penalty: Some(0.0),
        repetition_penalty: Some(1.0),
        max_output_tokens: Some(32000),
        ..Default::default()
    };
    let expected = json!({"reasoning_effort":"xhigh", "temperature":1.0,
        "top_p":0.95, "top_k":20, "min_p":0.0, "presence_penalty":0.0, "repetition_penalty":1.0});
    for (options, purpose, limit, has_sampling) in [
        (configured.clone(), RequestPurpose::Solve, 32000, true),
        (configured, RequestPurpose::Summary, 16384, true),
        (ModelOptions::default(), RequestPurpose::Solve, 16384, false),
        (
            ModelOptions {
                max_output_tokens: None,
                ..Default::default()
            },
            RequestPurpose::Solve,
            16384,
            false,
        ),
    ] {
        let audit_dir = tempfile::tempdir().unwrap();
        let model = HttpModel::new(
            format!("http://{address}/"),
            "fixture".into(),
            Some("fixture-secret".into()),
        )
        .unwrap()
        .with_options(options)
        .unwrap()
        .with_audit_directory(audit_dir.path().to_path_buf());
        let events = model
            .chat_for(vec![Message::text("user", "hello")], vec![], purpose)
            .await
            .unwrap()
            .collect::<Vec<_>>()
            .await;
        assert!(events.iter().all(Result::is_ok));
        let request = rx.recv().await.unwrap();
        for (field, value) in expected.as_object().unwrap() {
            if has_sampling {
                assert_eq!(&request[field], value, "{field}");
            } else {
                assert!(request.get(field).is_none(), "{field}");
            }
        }
        assert_eq!(request["max_completion_tokens"], limit);
        let path = std::fs::read_dir(audit_dir.path())
            .unwrap()
            .find(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .path()
                    .extension()
                    .is_some_and(|e| e == "json")
            })
            .unwrap()
            .unwrap()
            .path();
        let audit_text = std::fs::read_to_string(path).unwrap();
        let audit: Value = serde_json::from_str(&audit_text).unwrap();
        let collected = std::fs::read_to_string(audit_dir.path().join("requests.jsonl")).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(collected.trim()).unwrap(),
            audit
        );
        for (key, value) in audit["parameters"].as_object().unwrap() {
            assert_eq!(&request[key], value);
        }
        assert_eq!(audit["outcome"], "completed");
        assert_eq!(audit["stopReason"], "stop");
        assert_eq!(audit["httpAttempts"], 1);
        assert_eq!(audit["bodySha256"].as_str().unwrap().len(), 64);
        for private in ["hello", "fixture-secret", "127.0.0.1"] {
            assert!(!audit_text.contains(private));
        }
    }
    server.abort();
    let _ = server.await;
}

#[test]
fn direct_model_options_reject_invalid_or_unsupported_sampling() {
    use areal_engine::model::ModelOptions;
    for options in [
        ModelOptions {
            top_p: Some(f64::NAN),
            ..Default::default()
        },
        ModelOptions {
            top_k: Some(0),
            ..Default::default()
        },
        ModelOptions {
            min_p: Some(-0.1),
            ..Default::default()
        },
        ModelOptions {
            presence_penalty: Some(2.1),
            ..Default::default()
        },
        ModelOptions {
            repetition_penalty: Some(0.0),
            ..Default::default()
        },
    ] {
        assert!(
            HttpModel::new("http://127.0.0.1:9/".into(), "fixture".into(), None)
                .unwrap()
                .with_options(options)
                .is_err()
        );
    }
    for options in [
        ModelOptions {
            top_k: Some(20),
            ..Default::default()
        },
        ModelOptions {
            min_p: Some(0.0),
            ..Default::default()
        },
        ModelOptions {
            presence_penalty: Some(0.0),
            ..Default::default()
        },
        ModelOptions {
            repetition_penalty: Some(1.0),
            ..Default::default()
        },
    ] {
        assert!(
            HttpModel::with_protocol(
                "http://127.0.0.1:9/".into(),
                "fixture".into(),
                None,
                ModelProtocol::Responses
            )
            .unwrap()
            .with_options(options)
            .is_err()
        );
    }
}

#[tokio::test]
async fn request_retries_transient_status_but_not_authentication_errors() {
    use areal_engine::model::{Message, Model, ModelEvent, ModelOptions};
    use axum::response::IntoResponse;
    use futures_util::StreamExt;
    for status in [408, 429, 501, 503, 599, 401, 403, 400] {
        let requests = Arc::new(AtomicUsize::new(0));
        let recorded = requests.clone();
        let app = Router::new().route("/", post(move || {
            let recorded = recorded.clone();
            async move {
                if recorded.fetch_add(1, Ordering::SeqCst) == 0 {
                    return axum::http::StatusCode::from_u16(status).unwrap().into_response();
                }
                ([("content-type", "text/event-stream")], "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n").into_response()
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let model = HttpModel::new(format!("http://{address}/"), "fixture".into(), None)
            .unwrap()
            .with_options(ModelOptions {
                max_retries: 1,
                ..ModelOptions::default()
            })
            .unwrap();
        let stream = model.stream(vec![Message::text("user", "hello")]).await;
        if status != 400 && status != 401 && status != 403 {
            let events = stream.unwrap().collect::<Vec<_>>().await;
            assert!(
                events
                    .iter()
                    .any(|e| matches!(e, Ok(ModelEvent::TextDelta(text)) if text == "ok"))
            );
            assert_eq!(requests.load(Ordering::SeqCst), 2);
        } else {
            assert!(stream.is_err());
            assert_eq!(requests.load(Ordering::SeqCst), 1);
        }
        server.abort();
        let _ = server.await;
    }
}

#[tokio::test]
async fn text_before_an_error_is_preserved_when_events_share_one_http_chunk() {
    let body = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"accepted-prefix\"},\"finish_reason\":null}]}\n\n",
        "data: {\"error\":{\"message\":\"fixture failure\"}}\n\n"
    );
    let app = Router::new().route(
        "/",
        post(move || async move { ([("content-type", "text/event-stream")], body) }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let dir = tempfile::tempdir().unwrap();
    let model = ChatModel::new(format!("http://{address}/"), "fixture".into(), None).unwrap();
    let engine = Engine::open(dir.path(), Arc::new(model), Limits::default()).unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    engine
        .start(&thread.id, vec![Input::text("test")])
        .await
        .unwrap();
    let done = engine.wait(&thread.id).await.unwrap();
    engine.shutdown().await;
    server.abort();
    let _ = server.await;
    assert_eq!(done.turns[0].status, TurnStatus::Failed);
    assert!(
        done.turns[0].items.iter().any(
            |item| matches!(item, Item::AgentMessage { text, .. } if text == "accepted-prefix")
        )
    );
}

#[tokio::test]
async fn real_http_adapter_streams_and_detects_clean_truncation() {
    let app=Router::new().route("/v1/chat/completions",post(|Json(request):Json<Value>|async move {
        assert_eq!(request["stream"],true);assert_eq!(request["model"],"test-model");
        assert_eq!(request["stream_options"]["include_usage"],true);
        let prompt=request["messages"].as_array().unwrap().iter().find(|message| message["role"] == "user").unwrap()["content"].as_str().unwrap();
        let mut events=vec![Event::default().data(json!({"choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}).to_string())];
        if prompt!="truncate" {
            events.push(Event::default().data(json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}).to_string()));
            events.push(Event::default().data(json!({"choices":[],"usage":{"input_tokens":5,"input_tokens_details":{"cached_tokens":2},"output_tokens":1}}).to_string()));
            if prompt != "no-done" { events.push(Event::default().data("[DONE]")); }
        }
        Sse::new(futures_util::stream::iter(events.into_iter().map(Ok::<_,Infallible>)))
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let dir = tempfile::tempdir().unwrap();
    let model = ChatModel::new(
        format!("http://{address}/v1/chat/completions"),
        "test-model".into(),
        None,
    )
    .unwrap();
    let engine = Engine::open(
        dir.path(),
        Arc::new(model),
        Limits {
            watchdog_disable: true,
            ..Limits::default()
        },
    )
    .unwrap();
    for (prompt, status) in [
        ("hello", TurnStatus::Completed),
        ("no-done", TurnStatus::Completed),
        ("truncate", TurnStatus::Failed),
    ] {
        let thread = engine.create("/a".into()).await.unwrap();
        engine
            .start(&thread.id, vec![Input::text(prompt)])
            .await
            .unwrap();
        let done = engine.wait(&thread.id).await.unwrap();
        assert_eq!(done.turns[0].status, status);
        assert!(
            done.turns[0]
                .items
                .iter()
                .any(|i| matches!(i,Item::AgentMessage{text,..} if text=="你好"))
        );
        if status == TurnStatus::Completed {
            assert_eq!(done.turns[0].usage.as_ref().unwrap().input_tokens, 5);
            assert_eq!(done.turns[0].usage.as_ref().unwrap().cached_input_tokens, 2);
        }
    }
    engine.shutdown().await;
    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn responses_adapter_preserves_multimodal_input_and_persists_output() {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let image = STANDARD.encode(b"generated-image");
    let calls = Arc::new(AtomicUsize::new(0));
    let app = Router::new().route(
        "/v1/responses",
        post(move |Json(request): Json<Value>| {
            let image = image.clone();
            let calls = calls.clone();
            async move {
                let call = calls.fetch_add(1, Ordering::SeqCst);
                assert_eq!(request["stream"], true);
                assert_eq!(request["store"], false);
                assert_eq!(request["max_output_tokens"], 16384);
                let input = request["input"].as_array().unwrap();
                let first_user = input.iter().position(|message| message["role"] == "user").unwrap();
                let content = input[first_user]["content"].as_array().unwrap();
                assert_eq!(
                    content
                        .iter()
                        .map(|part| part["type"].as_str().unwrap())
                        .collect::<Vec<_>>(),
                    ["input_text", "input_image"]
                );
                assert_eq!(content[1]["detail"], "high");
                assert_eq!(input[first_user + 1]["type"], "input_audio");
                assert_eq!(input[first_user + 1]["input_audio"]["format"], "mp3");
                assert_eq!(input[first_user + 2]["content"][0]["type"], "input_file");
                if call > 0 {
                    assert!(input.iter().any(|item| {
                        item["role"] == "assistant"
                            && item["content"].as_array().is_some_and(|content| {
                                content.iter().any(|part| {
                                    part["type"] == "input_image"
                                        && part["image_url"]
                                            .as_str()
                                            .is_some_and(|url| url.starts_with("data:image/png;base64,"))
                                })
                            })
                    }));
                }
                let events = [
                    json!({"type":"response.output_text.delta","delta":"answer"}),
                    json!({"type":"response.output_item.done","item":{"type":"image_generation_call","result":image}}),
                    json!({"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":11,"input_tokens_details":{"cached_tokens":4},"output_tokens":7}}}),
                ]
                .into_iter()
                .map(|value| Ok::<_, Infallible>(Event::default().data(value.to_string())));
                Sse::new(futures_util::stream::iter(events))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let dir = tempfile::tempdir().unwrap();
    let audio_path = dir.path().join("input.mp3");
    std::fs::write(&audio_path, b"audio").unwrap();
    let model = HttpModel::with_protocol(
        format!("http://{address}/v1/responses"),
        "test-model".into(),
        None,
        ModelProtocol::Responses,
    )
    .unwrap();
    let engine = Engine::open(
        dir.path(),
        Arc::new(SolveOnlyHttpModel(model)),
        Limits::default(),
    )
    .unwrap();
    let thread = engine.create("/a".into()).await.unwrap();
    engine
        .start(
            &thread.id,
            vec![
                Input::text("describe"),
                Input::Image {
                    url: "https://example.test/input.png".into(),
                    detail: Some(areal_protocol::ImageDetail::High),
                },
                Input::LocalAudio {
                    path: audio_path.to_string_lossy().into_owned(),
                },
                Input::File {
                    url: "https://example.test/input.pdf".into(),
                    name: Some("input.pdf".into()),
                    mime_type: Some("application/pdf".into()),
                },
            ],
        )
        .await
        .unwrap();
    let done = engine.wait(&thread.id).await.unwrap();
    let turn = &done.turns[0];
    assert_eq!(turn.status, TurnStatus::Completed);
    assert_eq!(turn.usage.as_ref().unwrap().input_tokens, 11);
    assert_eq!(turn.usage.as_ref().unwrap().cached_input_tokens, 4);
    assert!(
        turn.items
            .iter()
            .any(|item| matches!(item, Item::AgentMessage { text, .. } if text == "answer"))
    );
    let media = turn
        .items
        .iter()
        .find_map(|item| match item {
            Item::AgentMedia {
                modality: Modality::Image,
                media,
                ..
            } => Some(media),
            _ => None,
        })
        .unwrap();
    let blob_id = media.uri.strip_prefix("areal://blob/").unwrap();
    assert_eq!(engine.read_blob(blob_id).await.unwrap(), b"generated-image");
    engine
        .start(&thread.id, vec![Input::text("refine the generated image")])
        .await
        .unwrap();
    let continued = engine.wait(&thread.id).await.unwrap();
    assert_eq!(continued.turns.len(), 2);
    assert_eq!(continued.turns[1].status, TurnStatus::Completed);
    engine.shutdown().await;
    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn transport_failure_after_finish_reason_does_not_release_tool_calls() {
    use areal_engine::model::{Message, Model, ModelEvent};
    use futures_util::StreamExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut bytes = [0; 4096];
        loop {
            let count = socket.read(&mut bytes).await.unwrap();
            assert_ne!(count, 0);
            request.extend_from_slice(&bytes[..count]);
            if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = std::str::from_utf8(&request[..end]).unwrap();
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().unwrap())
                    })
                    .unwrap();
                if request.len() >= end + 4 + length {
                    break;
                }
            }
        }
        let body = concat!(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"prefix\",\"tool_calls\":[{\"index\":0,\"id\":\"call\",\"function\":{\"name\":\"fs_stat\",\"arguments\":\"{}\"}}]},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n"
        );
        // A complete SSE finish event is insufficient when HTTP itself is
        // truncated: advertise more bytes than are actually sent.
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len() + 100).as_bytes()).await.unwrap();
        socket.shutdown().await.unwrap();
    });
    let model = HttpModel::new(endpoint, "fixture".into(), None).unwrap();
    let events = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        model
            .stream(vec![Message::text("user", "fixture")])
            .await
            .unwrap()
            .collect::<Vec<_>>()
            .await
    })
    .await
    .unwrap();
    server.await.unwrap();
    assert!(
        events
            .iter()
            .any(|event| matches!(event, Ok(ModelEvent::TextDelta(text)) if text == "prefix"))
    );
    assert!(
        events
            .iter()
            .all(|event| !matches!(event, Ok(ModelEvent::ToolCall(_))))
    );
    assert!(
        events
            .last()
            .unwrap()
            .as_ref()
            .unwrap_err()
            .to_string()
            .contains("transport failed")
    );
}

#[tokio::test]
async fn retryable_http_failures_are_typed_without_reclassifying_auth_or_bad_requests() {
    use areal_engine::model::{Model, ModelFailure};
    use axum::http::StatusCode;
    for (status, expected) in [
        (408, Some(ModelFailure::ResponseTimeout)),
        (429, Some(ModelFailure::RateLimited)),
        (501, Some(ModelFailure::Unavailable)),
        (599, Some(ModelFailure::Unavailable)),
        (503, Some(ModelFailure::Unavailable)),
        (400, None),
        (401, None),
    ] {
        let app = Router::new().route(
            "/",
            post(move || async move { StatusCode::from_u16(status).unwrap() }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let audit_dir = tempfile::tempdir().unwrap();
        let model = ChatModel::new(format!("http://{address}/"), "fixture".into(), None)
            .unwrap()
            .with_audit_directory(audit_dir.path().into());
        let error = match model.chat(vec![], vec![]).await {
            Err(error) => error,
            Ok(_) => panic!("HTTP error accepted"),
        };
        assert_eq!(error.downcast_ref::<ModelFailure>().copied(), expected);
        let audit_text = std::fs::read_to_string(audit_dir.path().join("requests.jsonl")).unwrap();
        let audit: Value = serde_json::from_str(audit_text.trim()).unwrap();
        assert_eq!(audit["outcome"], "failed");
        assert_eq!(audit["httpStatus"], status);
        if status == 408 {
            assert_eq!(audit["terminalOutcome"]["code"], "LLM_RESPONSE_TIMEOUT");
            assert_eq!(audit["terminalOutcome"]["class"], "timeout");
        }
        assert_eq!(audit["error"], error.to_string());
        assert_eq!(audit["usageObserved"], false);
        server.abort();
        let _ = server.await;
    }
}

#[tokio::test]
async fn adjacent_system_hints_and_null_error_preserve_valid_response_and_safe_diagnostics() {
    use areal_engine::model::{Message, Model};
    use futures_util::StreamExt;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let app = Router::new().route("/", post(move |Json(request): Json<Value>| {
        let tx=tx.clone();
        async move {
            tx.send(request.clone()).unwrap();
            let body = if request["model"] == "valid" {
                "data: {\"error\":null,\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
            } else {
                "data: {\"error\":{\"code\":\"invalid_messages\",\"type\":\"validation_error\",\"message\":\"fixture-secret and private input\"}}\n\n"
            };
            ([("content-type","text/event-stream"), ("x-cpa-trace-id","trace-fixture-123"), ("x-request-id","request-fixture-456")], body)
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    for name in ["valid", "invalid"] {
        let dir = tempfile::tempdir().unwrap();
        let model = HttpModel::new(format!("http://{addr}/"), name.into(), None)
            .unwrap()
            .with_audit_directory(dir.path().into());
        let mut stream = model
            .chat(
                vec![
                    Message::text("system", "budget: 8 requests remain"),
                    Message::text("system", "task instructions"),
                    Message::text("user", "work"),
                    Message::text("system", "current goal: continue"),
                    Message::text("assistant", "working"),
                    Message::text("system", "budget: 7 requests remain"),
                ],
                vec![],
            )
            .await
            .unwrap();
        let mut text = String::new();
        let mut failure = None;
        while let Some(event) = stream.next().await {
            match event {
                Ok(areal_engine::model::ModelEvent::TextDelta(v)) => text.push_str(&v),
                Err(e) => failure = Some(e.to_string()),
                _ => {}
            }
        }
        drop(stream);
        let request = rx.recv().await.unwrap();
        assert_eq!(request["messages"].as_array().unwrap().len(), 3);
        assert_eq!(
            request["messages"][0]["content"],
            "budget: 8 requests remain\n\ntask instructions\n\ncurrent goal: continue\n\nbudget: 7 requests remain"
        );
        assert_eq!(
            request["messages"][1],
            json!({"role":"user","content":"work"})
        );
        assert_eq!(
            request["messages"][2],
            json!({"role":"assistant","content":"working"})
        );
        let audit = std::fs::read_to_string(dir.path().join("requests.jsonl")).unwrap();
        assert!(!audit.contains("fixture-secret") && !audit.contains("private input"));
        let audit: Value = serde_json::from_str(audit.trim()).unwrap();
        assert_eq!(audit["systemMessageCount"], 1);
        assert_eq!(audit["gatewayTraceId"], "trace-fixture-123");
        assert_eq!(audit["httpRequestId"], "request-fixture-456");
        assert!(
            audit["timeToFirstResponseBytesMs"].as_u64().unwrap()
                <= audit["durationMs"].as_u64().unwrap()
        );
        if name == "valid" {
            assert!(
                audit["timeToFirstTextDeltaMs"].as_u64().unwrap()
                    <= audit["durationMs"].as_u64().unwrap()
            );
            assert!(failure.is_none());
            assert_eq!(text, "ok");
            assert_eq!(audit["responseShape"]["contentFieldBytes"], 2);
        } else {
            assert!(failure.unwrap().contains("invalid_messages"));
            assert_eq!(audit["streamError"]["errorType"], "validation_error");
        }
    }
    server.abort();
}

#[tokio::test]
async fn runtime_context_keeps_chat_prefix_and_never_emits_a_late_system_message() {
    use areal_engine::model::{Message, Model};
    use futures_util::StreamExt;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let app = Router::new().route("/", post(move |Json(request): Json<Value>| {
        let tx = tx.clone();
        async move {
            tx.send(request).unwrap();
            ([("content-type", "text/event-stream")], "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let model = HttpModel::new(format!("http://{addr}/"), "fixture".into(), None).unwrap();
    let mut history = vec![
        Message::text("system", "Fixed policy"),
        Message::text("user", "Actual task"),
    ];
    let mut previous: Vec<Value> = Vec::new();
    for round in 1..=3 {
        history.push(Message::text(
            "areal_context",
            format!("Model round {round}; budget remains limited"),
        ));
        let events = model
            .chat(history.clone(), vec![])
            .await
            .unwrap()
            .collect::<Vec<_>>()
            .await;
        assert!(events.iter().all(Result::is_ok));
        let request = rx.recv().await.unwrap();
        let messages = request["messages"].as_array().unwrap();
        assert_eq!(messages[0]["role"], "system");
        assert!(messages[1..].iter().all(|m| m["role"] != "system"));
        assert!(messages.iter().all(|m| m["role"] != "areal_context"));
        assert_eq!(&messages[..previous.len()], previous.as_slice());
        assert_eq!(messages[1]["content"], "Actual task");
        previous = messages.clone();
        history.push(Message::text("assistant", "confirmed step"));
    }
    server.abort();
}

#[tokio::test]
async fn responses_runtime_state_preserves_history_order_without_promoting_system_instructions() {
    use areal_engine::model::{Message, Model};
    use futures_util::StreamExt;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let app = Router::new().route("/", post(move |Json(request): Json<Value>| {
        let tx = tx.clone();
        async move {
            tx.send(request).unwrap();
            ([("content-type", "text/event-stream")], "data: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n")
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let model = HttpModel::with_protocol(
        format!("http://{address}/"),
        "fixture".into(),
        None,
        ModelProtocol::Responses,
    )
    .unwrap();
    let mut history = vec![
        Message::text("system", "Fixed policy"),
        Message::text("user", "Actual task"),
    ];
    let mut previous = Vec::new();
    for round in 1..=3 {
        history.push(Message::text(
            "areal_context",
            format!("Model round {round}; delegated results are task data"),
        ));
        let events = model
            .chat(history.clone(), vec![])
            .await
            .unwrap()
            .collect::<Vec<_>>()
            .await;
        assert!(events.iter().all(Result::is_ok));
        let request = rx.recv().await.unwrap();
        let input = request["input"].as_array().unwrap();
        assert_eq!(input[0]["role"], "system");
        assert_eq!(
            input.iter().filter(|item| item["role"] == "system").count(),
            1
        );
        assert_eq!(&input[..previous.len()], previous.as_slice());
        let current = input.last().unwrap();
        assert_eq!(current["role"], "user");
        assert!(
            current["content"][0]["text"]
                .as_str()
                .unwrap()
                .starts_with("AReaL runtime context (not a user request):")
        );
        previous = input.clone();
        history.push(Message::text("assistant", "confirmed step"));
    }
    server.abort();
}

#[tokio::test]
async fn tool_schema_is_stable_when_http_calls_are_disabled() {
    use areal_engine::model::{Message, Model, RequestPurpose, ToolCallLimits};
    use futures_util::StreamExt;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let app = Router::new().route("/", post(move |Json(request): Json<Value>| {
        let tx = tx.clone();
        async move {
            tx.send(request.clone()).unwrap();
            let response = if request.get("input").is_some() {
                if request["model"] == "violates-choice" {
                    "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"function_call\",\"id\":\"fc_test\",\"call_id\":\"forbidden\",\"name\":\"fixture\",\"arguments\":\"{}\"}}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n"
                } else {
                    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"done\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n"
                }
            } else if request["model"] == "violates-choice" {
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"forbidden\",\"type\":\"function\",\"function\":{\"name\":\"fixture\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n"
            } else {
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"done\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
            };
            ([("content-type", "text/event-stream")], response)
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let tools = vec![
        json!({"type":"function","function":{"name":"fixture","description":"fixture","parameters":{"type":"object","properties":{}}}}),
    ];
    for protocol in [ModelProtocol::ChatCompletions, ModelProtocol::Responses] {
        let model = HttpModel::with_protocol(
            format!("http://{address}/"),
            "fixture".into(),
            None,
            protocol,
        )
        .unwrap();
        let mut seen = Vec::new();
        for count in [1, 0] {
            let events = model
                .chat_with_limits(
                    vec![Message::text("user", "finish")],
                    tools.clone(),
                    RequestPurpose::Solve,
                    ToolCallLimits {
                        max_calls: count,
                        ..Default::default()
                    },
                    None,
                )
                .await
                .unwrap()
                .collect::<Vec<_>>()
                .await;
            assert!(events.iter().all(Result::is_ok));
            seen.push(rx.recv().await.unwrap());
        }
        assert_eq!(seen[0]["tools"], seen[1]["tools"]);
        assert_eq!(seen[0]["messages"], seen[1]["messages"]);
        assert_eq!(seen[0]["input"], seen[1]["input"]);
        assert_eq!(seen[1]["tool_choice"], "none");
        let model = HttpModel::with_protocol(
            format!("http://{address}/"),
            "violates-choice".into(),
            None,
            protocol,
        )
        .unwrap();
        let events = model
            .chat_with_limits(
                vec![Message::text("user", "finish")],
                tools.clone(),
                RequestPurpose::Solve,
                ToolCallLimits {
                    max_calls: 0,
                    ..Default::default()
                },
                None,
            )
            .await
            .unwrap()
            .collect::<Vec<_>>()
            .await;
        assert!(events.iter().any(Result::is_err));
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, Ok(areal_engine::model::ModelEvent::ToolCall(_))))
        );
        // 消费违规请求，避免下一协议读取上一轮的观测。
        rx.recv().await.unwrap();
    }
    server.abort();
}

#[tokio::test]
async fn summary_overrides_are_isolated_and_never_raise_the_goal_output_cap() {
    use areal_engine::model::{Message, Model, ModelOptions, RequestPurpose};
    use futures_util::StreamExt;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let app = Router::new().route("/", post(move |Json(request): Json<Value>| {
        let tx = tx.clone();
        async move {
            tx.send(request.clone()).unwrap();
            let response = if request.get("input").is_some() {
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"done\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n"
            } else { "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"done\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n" };
            ([("content-type", "text/event-stream")], response)
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    for protocol in [ModelProtocol::ChatCompletions, ModelProtocol::Responses] {
        let model = HttpModel::with_protocol(
            format!("http://{address}/"),
            "fixture".into(),
            None,
            protocol,
        )
        .unwrap()
        .with_options(ModelOptions {
            reasoning_effort: Some("high".into()),
            summary_reasoning_effort: Some("low".into()),
            summary_max_output_tokens: Some(4096),
            max_output_tokens: Some(32000),
            ..Default::default()
        })
        .unwrap();
        for (purpose, cap, effort, output) in [
            (RequestPurpose::Solve, None, "high", 32000),
            (RequestPurpose::Summary, None, "low", 4096),
            (RequestPurpose::Summary, Some(512), "low", 512),
            (RequestPurpose::Solve, None, "high", 32000),
        ] {
            let events = model
                .chat_limited(vec![Message::text("user", "work")], vec![], purpose, cap)
                .await
                .unwrap()
                .collect::<Vec<_>>()
                .await;
            assert!(events.iter().all(Result::is_ok));
            let request = rx.recv().await.unwrap();
            let (actual_effort, actual_output) = match protocol {
                ModelProtocol::ChatCompletions => (
                    &request["reasoning_effort"],
                    &request["max_completion_tokens"],
                ),
                ModelProtocol::Responses => (
                    &request["reasoning"]["effort"],
                    &request["max_output_tokens"],
                ),
            };
            assert_eq!(actual_effort, effort);
            assert_eq!(actual_output, output);
        }
    }
    server.abort();
}

#[test]
fn known_context_capacities_preserve_explicit_overrides_and_unknown_models() {
    use areal_engine::model::{Model, ModelOptions};
    for (name, expected) in [
        ("gpt-6.1-sol", Some(1_050_000)),
        ("gpt-6-sol", Some(1_050_000)),
        ("gpt-6-astra", Some(1_050_000)),
        ("gpt-6-luna", Some(1_050_000)),
        ("gpt-5.6-sol", Some(1_050_000)),
        ("gpt-5.6", Some(1_050_000)),
        ("deepseek-flash", Some(1_000_000)),
        ("deepseek-v4-pro", Some(1_000_000)),
        ("glm-5", Some(200_000)),
        ("claude-opus-5-5", Some(1_000_000)),
        ("claude-sonnet-5-5", Some(1_000_000)),
        ("claude-haiku-5-5", Some(1_000_000)),
        ("claude-sonnet-4-6", Some(1_000_000)),
        ("custom-gpt-6.1-sol", None),
        ("gpt-6.1-sol-unverified", None),
        ("fixture", None),
    ] {
        for protocol in [ModelProtocol::ChatCompletions, ModelProtocol::Responses] {
            let model =
                HttpModel::with_protocol("http://127.0.0.1:9/".into(), name.into(), None, protocol)
                    .unwrap();
            assert_eq!(
                model.capabilities().context_window_tokens,
                expected,
                "{name}"
            );
            let configured = model
                .with_options(ModelOptions {
                    context_window_tokens: Some(64000),
                    ..Default::default()
                })
                .unwrap();
            assert_eq!(configured.capabilities().context_window_tokens, Some(64000));
            assert_eq!(configured.capabilities().max_output_tokens, Some(16384));
        }
    }
}

#[tokio::test]
async fn model_catalog_preserves_per_model_validation_without_upstream_requests() {
    use areal_engine::desktop::ConfiguredModels;
    use areal_protocol::desktop::Provider;
    let requests = Arc::new(AtomicUsize::new(0));
    let recorded = requests.clone();
    let app = Router::new().route(
        "/",
        post(move || {
            recorded.fetch_add(1, Ordering::SeqCst);
            async { axum::http::StatusCode::INTERNAL_SERVER_ERROR }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    for protocol in ["chatCompletions", "responses"] {
        let data = tempfile::tempdir().unwrap();
        let engine = Engine::open(
            data.path(),
            Arc::new(HttpModel::new(endpoint.clone(), "default".into(), None).unwrap()),
            Limits {
                watchdog_disable: true,
                ..Limits::default()
            },
        )
        .unwrap();
        let declared = json!({"tools":true,"vision":false,"reasoning":true,"reasoningEffortOptions":["low","high"]});
        let mut provider = json!({
            "id":"valid", "revision":0, "endpoint":endpoint, "protocol":protocol,
            "models":["primary","sibling","temperature","effort","output","summary","capabilities","context"],
            "parameters":{"temperature":0.0,"maxOutputTokens":512,"reasoningEffort":"low"},
            "modelCapabilities":{"primary":declared},
            "modelParameters":{
                "temperature":{"temperature":3.0},
                "effort":{"reasoningEffort":"invalid"},
                "output":{"maxOutputTokens":0},
                "summary":{"reasoningSummary":"invalid"}
            }
        });
        provider["modelCapabilities"]["capabilities"] = json!({"tools":true,"vision":true,"reasoning":true,"reasoningEffortOptions":["low","low"]});
        let providers: Vec<Provider> = [
            provider,
            json!({"id":"z-missing", "revision":0, "endpoint":endpoint, "protocol":protocol,"models":["primary"],"credentialRef":"absent"}),
            json!({"id":"z-endpoint", "revision":0, "endpoint":"file:///tmp/model", "protocol":protocol,"models":["primary"]}),
            json!({"id":"z-empty", "revision":0, "endpoint":endpoint, "protocol":protocol,"models":[""]}),
            json!({"id":"summary", "revision":0, "endpoint":endpoint, "protocol":protocol,"models":["primary"],"parameters":{"reasoningSummary":"concise"}}),
        ].into_iter().map(|provider| serde_json::from_value(provider).unwrap()).collect();
        let mut configured = ConfiguredModels {
            provider_ids: providers
                .iter()
                .map(|provider| provider.id.clone())
                .collect(),
            providers,
            ..Default::default()
        };
        configured.parameters.insert(
            ("valid".into(), "context".into()),
            serde_json::from_value(json!({"contextWindowTokens":0})).unwrap(),
        );
        engine.install_configured_models(configured).unwrap();
        let catalog = engine.model_catalog().await;
        let rows = catalog["data"].as_array().unwrap();
        let row = |provider: &str, model: &str| {
            rows.iter()
                .find(|row| row["providerId"] == provider && row["modelId"] == model)
                .unwrap()
        };
        assert_eq!(rows.len(), 13);
        for model in ["primary", "sibling"] {
            let row = row("valid", model);
            assert_eq!(row["available"], true, "{protocol}/{model}");
            assert_eq!(row["credentialState"], "notRequired");
            assert_eq!(row["providerRevision"], 1);
            assert_eq!(row["transport"], protocol);
            assert_eq!(row["connectionState"], "unchecked");
            assert_eq!(
                row["parameters"],
                json!({"temperature":0.0,"maxOutputTokens":512,"reasoningEffort":"low"})
            );
        }
        assert_eq!(row("valid", "primary")["capabilities"], declared);
        assert_eq!(
            row("valid", "primary")["reasoningEffortOptions"],
            json!(["low", "high"])
        );
        assert_eq!(
            row("valid", "primary")["input"],
            if protocol == "responses" {
                json!(["text", "audio", "file"])
            } else {
                json!(["text", "audio"])
            }
        );
        assert_eq!(
            row("valid", "primary")["output"],
            if protocol == "responses" {
                json!(["text", "image", "audio"])
            } else {
                json!(["text"])
            }
        );
        assert_eq!(
            row("valid", "primary")["parameterCapabilities"],
            if protocol == "responses" {
                json!([
                    "temperature",
                    "maxOutputTokens",
                    "contextWindowTokens",
                    "reasoningEffort",
                    "reasoningSummary"
                ])
            } else {
                json!([
                    "temperature",
                    "maxOutputTokens",
                    "contextWindowTokens",
                    "reasoningEffort"
                ])
            }
        );
        for model in [
            "temperature",
            "effort",
            "output",
            "summary",
            "capabilities",
            "context",
        ] {
            assert_eq!(
                row("valid", model)["available"],
                false,
                "{protocol}/{model}"
            );
        }
        assert_eq!(row("z-missing", "primary")["available"], false);
        assert_eq!(
            row("z-missing", "primary")["credentialState"],
            "unavailable"
        );
        assert_eq!(row("z-endpoint", "primary")["available"], false);
        assert_eq!(row("z-empty", "")["available"], false);
        assert_eq!(
            row("summary", "primary")["available"],
            protocol == "responses"
        );
        assert_eq!(requests.load(Ordering::SeqCst), 0);
        engine.shutdown().await;
    }
    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn model_catalog_refreshes_credentials_and_provider_revisions_before_local_turns() {
    use areal_engine::desktop::ConfiguredModels;
    use areal_protocol::desktop::Provider;
    use axum::http::HeaderMap;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let app = Router::new().route("/", post(move |headers: HeaderMap, Json(request): Json<Value>| {
        let tx = tx.clone();
        async move {
            tx.send((headers,request.clone())).unwrap();
            let response = if request.get("input").is_some() {
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"done\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n"
            } else {
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"done\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
            };
            ([("content-type","text/event-stream")],response)
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    for protocol in ["chatCompletions", "responses"] {
        let data = tempfile::tempdir().unwrap();
        let engine = Engine::open(
            data.path(),
            Arc::new(HttpModel::new(endpoint.clone(), "default".into(), None).unwrap()),
            Limits {
                watchdog_disable: true,
                ..Limits::default()
            },
        )
        .unwrap();
        for revision in 1..=2 {
            let reference = format!("credential-{revision}");
            let provider: Provider = serde_json::from_value(json!({"id":"local","revision":0,"endpoint":endpoint,"protocol":protocol,"models":["primary","sibling"],"credentialRef":reference,"parameters":{"temperature":0.0,"maxOutputTokens":512,"reasoningEffort":if revision == 1 {"low"} else {"high"}}})).unwrap();
            engine
                .install_configured_models(ConfiguredModels {
                    providers: vec![provider],
                    provider_ids: ["local".into()].into_iter().collect(),
                    ..Default::default()
                })
                .unwrap();
            let missing = engine.model_catalog().await;
            for row in missing["data"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|row| row["providerId"] == "local")
            {
                assert_eq!(row["providerRevision"], revision);
                assert_eq!(row["available"], false);
                assert_eq!(row["credentialState"], "unavailable");
            }
            let secret = format!("fixture-secret-{revision}");
            engine
                .register_credential(reference, secret.clone())
                .unwrap();
            let catalog = engine.model_catalog().await;
            for row in catalog["data"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|row| row["providerId"] == "local")
            {
                assert_eq!(row["providerRevision"], revision);
                assert_eq!(row["available"], true);
                assert_eq!(row["credentialState"], "available");
                assert_eq!(
                    row["parameters"]["reasoningEffort"],
                    if revision == 1 { "low" } else { "high" }
                );
            }
            let thread = engine
                .create(data.path().to_string_lossy().into_owned())
                .await
                .unwrap();
            engine.configure_thread(serde_json::from_value(json!({"threadId":thread.id,"expectedRevision":1,"model":{"providerId":"local","modelId":"primary"}})).unwrap()).await.unwrap();
            let prompt = format!("fixture {protocol} revision {revision}");
            engine
                .start(&thread.id, vec![Input::text(&prompt)])
                .await
                .unwrap();
            let done = engine.wait(&thread.id).await.unwrap();
            assert_eq!(done.turns[0].status, TurnStatus::Completed);
            let (headers, request) =
                tokio::time::timeout(std::time::Duration::from_secs(10), async {
                    loop {
                        let (headers, request) = rx.recv().await.unwrap();
                        let messages = request
                            .get("messages")
                            .or_else(|| request.get("input"))
                            .and_then(Value::as_array)
                            .unwrap();
                        if messages.iter().any(|message| {
                            message["role"] == "user"
                                && (message["content"] == prompt
                                    || message["content"].as_array().is_some_and(|parts| {
                                        parts.iter().any(|part| part["text"] == prompt)
                                    }))
                        }) {
                            break (headers, request);
                        }
                    }
                })
                .await
                .unwrap();
            assert_eq!(
                headers["authorization"].to_str().unwrap(),
                format!("Bearer {secret}")
            );
            assert_eq!(request["model"], "primary");
            assert_eq!(request["temperature"], 0.0);
            assert_eq!(
                if protocol == "responses" {
                    &request["reasoning"]["effort"]
                } else {
                    &request["reasoning_effort"]
                },
                if revision == 1 { "low" } else { "high" }
            );
            assert_eq!(
                if protocol == "responses" {
                    &request["max_output_tokens"]
                } else {
                    &request["max_completion_tokens"]
                },
                512
            );
        }
        engine.shutdown().await;
    }
    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn explicit_model_capabilities_control_catalog_admission_and_wire() {
    async fn request_for(
        rx: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
        prompt: &str,
    ) -> Value {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let body = rx.recv().await.unwrap();
                if body["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .rev()
                    .find(|message| message["role"] == "user")
                    .is_some_and(|message| message["content"] == prompt)
                {
                    return body;
                }
            }
        })
        .await
        .unwrap()
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let app=Router::new().route("/",post(move |Json(request):Json<Value>| { let tx=tx.clone(); async move {let tool_disabled=request.get("tools").is_none();tx.send(request).unwrap(); ([("content-type","text/event-stream")],if tool_disabled {"data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"forbidden\",\"type\":\"function\",\"function\":{\"name\":\"shell\",\"arguments\":\"{}\"}}]},\"finish_reason\":null}]}\n\ndata: [DONE]\n\n"} else {"data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"})}}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let data = tempfile::tempdir().unwrap();
    let engine = Engine::open(
        data.path(),
        Arc::new(HttpModel::new(format!("http://{address}/"), "default".into(), None).unwrap()),
        Limits {
            watchdog_disable: true,
            ..Limits::default()
        },
    )
    .unwrap();
    let mut provider = json!({"id":"custom","revision":0,"endpoint":format!("http://{address}/"),"protocol":"chatCompletions","models":["opaque"],"parameters":{"reasoningEffort":"max"},"modelCapabilities":{"opaque":{"tools":false,"vision":false,"reasoning":false}}});
    engine
        .upsert_provider(serde_json::from_value(provider.clone()).unwrap(), 0)
        .await
        .unwrap();
    let catalog = engine.model_catalog().await;
    let item = catalog["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["providerId"] == "custom")
        .unwrap();
    assert_eq!(item["input"], json!(["text", "audio"]));
    assert_eq!(item["reasoningEffortOptions"], json!([]));
    assert_eq!(item["capabilities"]["tools"], false);
    let thread = engine.create("/workspace".into()).await.unwrap();
    engine.configure_thread(serde_json::from_value(json!({"threadId":thread.id,"expectedRevision":1,"model":{"providerId":"custom","modelId":"opaque"}})).unwrap()).await.unwrap();
    let image: Vec<Input> =
        serde_json::from_value(json!([{"type":"image","url":"https://example.invalid/image.png"}]))
            .unwrap();
    assert!(engine.start(&thread.id, image).await.is_err());
    engine
        .start(&thread.id, vec![Input::text("plain")])
        .await
        .unwrap();
    engine.wait(&thread.id).await.unwrap();
    let failed = engine.read(&thread.id, true).await.unwrap();
    assert_eq!(failed.turns[0].status, TurnStatus::Failed);
    assert!(
        !failed.turns[0]
            .items
            .iter()
            .any(|item| matches!(item, Item::DynamicToolCall { .. }))
    );
    let body = request_for(&mut rx, "plain").await;
    assert_eq!(body["model"], "opaque");
    assert!(body.get("tools").is_none());
    assert!(body.get("reasoning_effort").is_none());
    assert!(body.get("reasoning").is_none());
    provider["modelCapabilities"]["opaque"] =
        json!({"tools":true,"vision":true,"reasoning":true,"reasoningEffortOptions":["low","max"]});
    engine
        .upsert_provider(serde_json::from_value(provider.clone()).unwrap(), 1)
        .await
        .unwrap();
    engine
        .start(&thread.id, vec![Input::text("reason")])
        .await
        .unwrap();
    engine.wait(&thread.id).await.unwrap();
    let body = request_for(&mut rx, "reason").await;
    assert_eq!(body["reasoning_effort"], "max");
    assert!(
        body["tools"]
            .as_array()
            .is_some_and(|tools| !tools.is_empty())
    );
    let catalog = engine.model_catalog().await;
    let item = catalog["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["providerId"] == "custom")
        .unwrap();
    assert_eq!(item["reasoningEffortOptions"], json!(["low", "max"]));
    assert!(item["input"].as_array().unwrap().contains(&json!("image")));
    let fallback = json!(["none", "minimal", "low", "medium", "high", "xhigh"]);
    assert_eq!(catalog["data"][0]["reasoningEffortOptions"], fallback);
    for (revision, options) in [(2, None), (3, Some(json!([])))] {
        let capabilities = provider["modelCapabilities"]["opaque"]
            .as_object_mut()
            .unwrap();
        capabilities.remove("reasoningEffortOptions");
        if let Some(options) = options {
            capabilities.insert("reasoningEffortOptions".into(), options);
        }
        engine
            .upsert_provider(serde_json::from_value(provider.clone()).unwrap(), revision)
            .await
            .unwrap();
        let catalog = engine.model_catalog().await;
        let item = catalog["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["providerId"] == "custom")
            .unwrap();
        assert_eq!(item["reasoningEffortOptions"], fallback);
        assert_eq!(item["available"], true);
        let prompt = format!("default efforts {revision}");
        engine
            .start(&thread.id, vec![Input::text(&prompt)])
            .await
            .unwrap();
        engine.wait(&thread.id).await.unwrap();
        assert_eq!(
            request_for(&mut rx, &prompt).await["reasoning_effort"],
            "max"
        );
    }
    provider["parameters"]["reasoningEffort"] = json!("high");
    provider["modelParameters"] = json!({"opaque":{"reasoningEffort":"low"}});
    provider["modelCapabilities"]["opaque"]["reasoningEffortOptions"] = json!(["low"]);
    engine
        .upsert_provider(serde_json::from_value(provider.clone()).unwrap(), 4)
        .await
        .unwrap();
    let selected = engine.create("/workspace".into()).await.unwrap();
    let configuration = engine.configure_thread(serde_json::from_value(json!({"threadId":selected.id,"expectedRevision":1,"model":{"providerId":"custom","modelId":"opaque"},"parameters":{}})).unwrap()).await.unwrap();
    assert_eq!(
        configuration.parameters.reasoning_effort.as_deref(),
        Some("low")
    );
    engine
        .start(&selected.id, vec![Input::text("model default wins")])
        .await
        .unwrap();
    engine.wait(&selected.id).await.unwrap();
    assert_eq!(
        request_for(&mut rx, "model default wins").await["reasoning_effort"],
        "low"
    );
    for (key, invalid) in [
        ("contextWindowTokens", json!(0)),
        ("temperature", json!(3.0)),
        ("reasoningEffort", json!("invalid")),
    ] {
        for model_override in [false, true] {
            let mut invalid_provider = provider.clone();
            if model_override {
                invalid_provider["modelParameters"]["opaque"][key] = invalid.clone();
            } else {
                invalid_provider["parameters"][key] = invalid.clone();
            }
            assert!(
                engine
                    .upsert_provider(serde_json::from_value(invalid_provider).unwrap(), 5)
                    .await
                    .is_err()
            );
        }
    }
    for mapping in ["modelParameters", "modelCapabilities"] {
        let mut invalid_provider = provider.clone();
        invalid_provider[mapping]["unknown"] = provider[mapping]["opaque"].clone();
        assert!(
            engine
                .upsert_provider(serde_json::from_value(invalid_provider).unwrap(), 5)
                .await
                .is_err()
        );
    }
    engine.shutdown().await;
    server.abort();
}
