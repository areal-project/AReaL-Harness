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
    for (options, purpose, limit) in [
        (configured.clone(), RequestPurpose::Solve, 32000),
        (configured, RequestPurpose::Summary, 16384),
        (ModelOptions::default(), RequestPurpose::Solve, 0),
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
            if limit == 0 {
                assert!(request.get(field).is_none(), "{field}");
            } else {
                assert_eq!(&request[field], value, "{field}");
            }
        }
        if limit != 0 {
            assert_eq!(request["max_completion_tokens"], limit);
        } else {
            assert!(request.get("max_completion_tokens").is_none());
        }
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
    for status in [503, 401] {
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
        if status == 503 {
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
    let engine = Engine::open(dir.path(), Arc::new(model), Limits::default()).unwrap();
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
    let engine = Engine::open(dir.path(), Arc::new(model), Limits::default()).unwrap();
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
        (429, Some(ModelFailure::RateLimited)),
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
        let model = ChatModel::new(format!("http://{address}/"), "fixture".into(), None).unwrap();
        let error = match model.chat(vec![], vec![]).await {
            Err(error) => error,
            Ok(_) => panic!("HTTP error accepted"),
        };
        assert_eq!(error.downcast_ref::<ModelFailure>().copied(), expected);
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
            ([("content-type","text/event-stream")], body)
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
        assert_eq!(request["messages"].as_array().unwrap().len(), 2);
        assert_eq!(
            request["messages"][0]["content"],
            "budget: 8 requests remain\n\ntask instructions"
        );
        let audit = std::fs::read_to_string(dir.path().join("requests.jsonl")).unwrap();
        assert!(!audit.contains("fixture-secret") && !audit.contains("private input"));
        let audit: Value = serde_json::from_str(audit.trim()).unwrap();
        assert_eq!(audit["systemMessageCount"], 1);
        if name == "valid" {
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
