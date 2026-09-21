use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelCapabilities, ModelStream},
};
use areal_protocol::Modality;
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::Message as Wire};
use tokio_util::sync::CancellationToken;

struct TextModel;
#[async_trait]
impl Model for TextModel {
    fn name(&self) -> &str {
        "test"
    }
    fn capabilities(&self) -> ModelCapabilities {
        ModelCapabilities {
            input: vec![Modality::Text, Modality::File],
            output: vec![Modality::Text, Modality::Image],
        }
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        Ok(Box::pin(futures_util::stream::iter([
            Ok("hello".into()),
            Ok(" world".into()),
        ])))
    }
}
type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
fn validate(name: &str, value: &Value) {
    let schemas: Value = serde_json::from_str(include_str!(
        "../../../schemas/app-server/codex-0.145.0.json"
    ))
    .unwrap();
    let mut schema = schemas["schemas"][name].clone();
    schema["definitions"] = schemas["definitions"].clone();
    let validator = jsonschema::validator_for(&schema).unwrap();
    let errors: Vec<_> = validator
        .iter_errors(value)
        .map(|e| e.to_string())
        .collect();
    assert!(errors.is_empty(), "{name}: {errors:?}\n{value}");
}

#[test]
fn tool_journal_projection_preserves_pinned_upstream_item_schemas() {
    use areal_protocol::{Item, ToolExecution, ToolOutcome, ToolStatus};
    for (status, outcome, success) in [
        (ToolStatus::InProgress, ToolOutcome::Running, None),
        (ToolStatus::Completed, ToolOutcome::Succeeded, Some(true)),
        (ToolStatus::Failed, ToolOutcome::Unknown, Some(false)),
    ] {
        let item = Item::DynamicToolCall {
            id: "item".into(),
            tool: "fs_read".into(),
            arguments: json!({"path":"workspace://repo/code"}),
            status,
            success,
            content_items: Some(vec![json!({"type":"inputText","text":"tool result"})]),
            call_id: "call".into(),
            execution: Box::new(ToolExecution {
                plugin: None,
                backend: None,
                hooks: Vec::new(),
                effective_arguments: None,
                model_arguments: Some(json!({"path":"code"})),
                runtime_epoch: "epoch".into(),
                scope_id: "scope".into(),
                operation_id: "operation".into(),
                outcome,
                inspection: None,
                duration_ms: Some(12),
            }),
        };
        validate(
            "ItemStartedNotification",
            &json!({"threadId":"thread","turnId":"turn","item":item,"startedAtMs":0}),
        );
        validate(
            "ItemCompletedNotification",
            &json!({"threadId":"thread","turnId":"turn","item":item,"completedAtMs":1}),
        );
    }
}
async fn receive(socket: &mut Socket) -> Value {
    let wire = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    serde_json::from_str(wire.to_text().unwrap()).unwrap()
}
async fn call(socket: &mut Socket, id: u64, method: &str, params: Value) -> (Value, Vec<Value>) {
    socket
        .send(Wire::Text(
            json!({"id":id,"method":method,"params":params})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let mut events = Vec::new();
    loop {
        let value = receive(socket).await;
        if value["id"] == id {
            return (value, events);
        }
        events.push(value);
    }
}

#[tokio::test]
async fn websocket_lifecycle_matches_pinned_upstream_schemas() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(TextModel), Limits::default()).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let server = tokio::spawn(areal_app_server::serve(
        listener,
        engine.clone(),
        stop.clone(),
    ));
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
        .await
        .unwrap();
    let (early, _) = call(&mut socket, 1, "thread/start", json!({})).await;
    assert_eq!(early["error"]["message"], "Not initialized");
    let params = json!({"clientInfo":{"name":"test","version":"1"}});
    validate("InitializeParams", &params);
    let (init, _) = call(&mut socket, 2, "initialize", params.clone()).await;
    validate("InitializeResponse", &init["result"]);
    let (repeat, _) = call(&mut socket, 3, "initialize", params).await;
    assert!(repeat.get("error").is_some());
    socket
        .send(Wire::Text(
            json!({"method":"initialized"}).to_string().into(),
        ))
        .await
        .unwrap();
    let (models, _) = call(&mut socket, 4, "model/list", json!({})).await;
    validate("ModelListResponse", &models["result"]);
    assert_eq!(
        models["result"]["data"][0]["inputModalities"],
        json!(["text"])
    );
    assert_eq!(
        models["result"]["data"][0]["arealCapabilities"],
        json!({"inputModalities":["text","file"],"outputModalities":["text","image"]})
    );
    let (unsupported, _) = call(
        &mut socket,
        5,
        "thread/start",
        json!({"sandbox":"danger-full-access"}),
    )
    .await;
    assert_eq!(unsupported["error"]["code"], -32602);
    let (start, events) = call(&mut socket, 6, "thread/start", json!({"cwd":"/workspace"})).await;
    validate("ThreadStartResponse", &start["result"]);
    for e in events {
        validate("ThreadStartedNotification", &e["params"]);
    }
    let id = start["result"]["thread"]["id"].as_str().unwrap();
    let params = json!({"threadId":id,"input":[{"type":"text","text":"hi","text_elements":[]}]});
    validate("TurnStartParams", &params);
    let (turn, mut events) = call(&mut socket, 7, "turn/start", params).await;
    validate("TurnStartResponse", &turn["result"]);
    while !events.iter().any(|e| e["method"] == "turn/completed") {
        events.push(receive(&mut socket).await);
    }
    for event in &events {
        let name = match event["method"].as_str().unwrap() {
            "turn/started" => "TurnStartedNotification",
            "turn/completed" => "TurnCompletedNotification",
            "item/started" => "ItemStartedNotification",
            "item/completed" => "ItemCompletedNotification",
            "item/agentMessage/delta" => "AgentMessageDeltaNotification",
            other => panic!("unexpected {other}"),
        };
        validate(name, &event["params"]);
    }
    assert_eq!(
        events
            .iter()
            .filter(|e| e["method"] == "turn/completed")
            .count(),
        1
    );
    let text = events
        .iter()
        .filter(|e| e["method"] == "item/agentMessage/delta")
        .map(|e| e["params"]["delta"].as_str().unwrap())
        .collect::<String>();
    assert_eq!(text, "hello world");
    let (read, _) = call(
        &mut socket,
        8,
        "thread/read",
        json!({"threadId":id,"includeTurns":true}),
    )
    .await;
    validate("ThreadReadResponse", &read["result"]);
    let (resume, _) = call(&mut socket, 9, "thread/resume", json!({"threadId":id})).await;
    validate("ThreadResumeResponse", &resume["result"]);
    let (list, _) = call(&mut socket, 10, "thread/list", json!({"limit":1})).await;
    validate("ThreadListResponse", &list["result"]);
    let (unknown, _) = call(&mut socket, 11, "command/exec", json!({})).await;
    assert_eq!(unknown["error"]["code"], -32601);
    socket.close(None).await.unwrap();
    drop(socket);
    engine.shutdown().await;
    stop.cancel();
    tokio::time::timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn browser_origin_is_limited_to_the_served_loopback_ui() {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(TextModel), Limits::default()).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let server = tokio::spawn(areal_app_server::serve(
        listener,
        engine.clone(),
        stop.clone(),
    ));
    let http = reqwest::Client::new();
    let page = http.get(format!("http://{addr}/ui")).send().await.unwrap();
    assert!(page.status().is_success());
    assert!(
        page.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("frame-ancestors 'none'")
    );
    assert_eq!(page.headers()["x-content-type-options"], "nosniff");
    assert!(page.text().await.unwrap().contains("/ui/app.js"));
    for (path, mime) in [("app.js", "text/javascript"), ("style.css", "text/css")] {
        let asset = http
            .get(format!("http://{addr}/ui/{path}"))
            .send()
            .await
            .unwrap();
        assert!(asset.status().is_success());
        assert!(
            asset.headers()["content-type"]
                .to_str()
                .unwrap()
                .starts_with(mime)
        );
    }
    let mut request = format!("ws://{addr}").into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Origin", "https://example.com".parse().unwrap());
    let err = tokio_tungstenite::connect_async(request).await.unwrap_err();
    assert!(err.to_string().contains("403"));
    for origin in [
        "null".to_owned(),
        format!("https://{addr}"),
        format!("http://{addr}.example.com"),
    ] {
        let mut request = format!("ws://{addr}").into_client_request().unwrap();
        request
            .headers_mut()
            .insert("Origin", origin.parse().unwrap());
        assert!(
            tokio_tungstenite::connect_async(request)
                .await
                .unwrap_err()
                .to_string()
                .contains("403")
        );
    }
    let mut request = format!("ws://{addr}").into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Origin", format!("http://{addr}").parse().unwrap());
    let (mut browser, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    let (response, _) = call(
        &mut browser,
        1,
        "initialize",
        json!({"clientInfo":{"name":"browser","version":"1"}}),
    )
    .await;
    assert!(response.get("result").is_some());
    browser.close(None).await.unwrap();
    engine.shutdown().await;
    stop.cancel();
    server.await.unwrap().unwrap();
}

struct StreamingModel(tokio::sync::Mutex<Option<tokio::sync::mpsc::Receiver<String>>>);
#[async_trait]
impl Model for StreamingModel {
    fn name(&self) -> &str {
        "controlled-stream"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        let receiver = self.0.lock().await.take().unwrap();
        Ok(Box::pin(futures_util::stream::unfold(
            receiver,
            |mut receiver| async {
                receiver
                    .recv()
                    .await
                    .map(|text| (Ok(text.into()), receiver))
            },
        )))
    }
}

#[tokio::test]
async fn resume_during_stream_replaces_baseline_without_duplicate_deltas() {
    let dir = tempfile::tempdir().unwrap();
    let (sender, receiver) = tokio::sync::mpsc::channel(8);
    let model = StreamingModel(tokio::sync::Mutex::new(Some(receiver)));
    let engine = Engine::open(dir.path(), Arc::new(model), Limits::default()).unwrap();
    let thread = engine.create("/stream".into()).await.unwrap();
    engine
        .start(&thread.id, vec![areal_protocol::Input::text("stream")])
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let server = tokio::spawn(areal_app_server::serve(
        listener,
        engine.clone(),
        stop.clone(),
    ));
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
        .await
        .unwrap();
    call(
        &mut socket,
        1,
        "initialize",
        json!({"clientInfo":{"name":"resume-test","version":"1"}}),
    )
    .await;
    socket
        .send(Wire::Text(
            json!({"method":"initialized"}).to_string().into(),
        ))
        .await
        .unwrap();
    let mut expected = String::new();
    let mut projection = String::new();
    for index in 0..32 {
        let text = format!("{index}|");
        expected.push_str(&text);
        sender.send(text).await.unwrap();
        let (response, _) = call(
            &mut socket,
            index + 2,
            "thread/resume",
            json!({"threadId":thread.id}),
        )
        .await;
        assert!(response.get("error").is_none(), "{response}");
        projection = response["result"]["thread"]["turns"][0]["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| item["text"].as_str())
            .collect();
    }
    drop(sender);
    loop {
        let event = receive(&mut socket).await;
        if event["method"] == "item/agentMessage/delta" {
            projection.push_str(event["params"]["delta"].as_str().unwrap());
        }
        if event["method"] == "turn/completed" {
            break;
        }
    }
    assert_eq!(projection, expected);
    socket.close(None).await.unwrap();
    drop(socket);
    engine.shutdown().await;
    stop.cancel();
    server.await.unwrap().unwrap();
}
