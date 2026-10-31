use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelCapabilities, ModelEvent, ModelStream, ReasoningKind},
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
            declared: None,
            context_window: None,
            context_window_tokens: None,
            max_output_tokens: None,
            summary_output_tokens: None,
            input: vec![Modality::Text, Modality::File],
            output: vec![Modality::Text, Modality::Image],
        }
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        Ok(Box::pin(futures_util::stream::iter([
            Ok(ModelEvent::reasoning("inspect first")),
            Ok(ModelEvent::ReasoningDelta {
                item_id: "response".into(),
                kind: ReasoningKind::Summary,
                index: 1,
                delta: "summary".into(),
            }),
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
                started_at_ms: None,
                permission_review: None,
                permission_scopes: Vec::new(),
                page: None,
                interactive_result: None,
                result_snapshot: None,
                file_before: None,
                output_projection: None,
                plugin: None,
                backend: None,
                hooks: Vec::new(),
                effective_arguments: None,
                model_arguments: Some(json!({"path":"code"})),
                original_arguments: None,
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
            "item/reasoning/textDelta" => "ReasoningTextDeltaNotification",
            "item/reasoning/summaryTextDelta" => "ReasoningSummaryTextDeltaNotification",
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

struct StreamingModel(tokio::sync::Mutex<Option<tokio::sync::mpsc::Receiver<ModelEvent>>>);
#[async_trait]
impl Model for StreamingModel {
    fn name(&self) -> &str {
        "controlled-stream"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        let receiver = self.0.lock().await.take().unwrap();
        Ok(Box::pin(futures_util::stream::unfold(
            receiver,
            |mut receiver| async { receiver.recv().await.map(|event| (Ok(event), receiver)) },
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
    let mut reasoning = String::new();
    let mut summary = String::new();
    for index in 0..32 {
        let text = format!("{index}|");
        expected.push_str(&text);
        sender
            .send(ModelEvent::reasoning(text.clone()))
            .await
            .unwrap();
        sender
            .send(ModelEvent::ReasoningDelta {
                item_id: "response".into(),
                kind: ReasoningKind::Summary,
                index: 1,
                delta: text.clone(),
            })
            .await
            .unwrap();
        sender.send(ModelEvent::TextDelta(text)).await.unwrap();
        let (response, _) = call(
            &mut socket,
            index + 2,
            "thread/resume",
            json!({"threadId":thread.id}),
        )
        .await;
        assert!(response.get("error").is_none(), "{response}");
        reasoning = response["result"]["thread"]["turns"][0]["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["type"] == "reasoning")
            .flat_map(|item| item["content"].as_array().unwrap())
            .map(|text| text.as_str().unwrap())
            .collect();
        summary = response["result"]["thread"]["turns"][0]["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["type"] == "reasoning")
            .flat_map(|item| item["summary"].as_array().unwrap())
            .map(|text| text.as_str().unwrap())
            .collect();
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
        if event["method"] == "item/reasoning/summaryTextDelta" {
            summary.push_str(event["params"]["delta"].as_str().unwrap());
        }
        if event["method"] == "item/reasoning/textDelta" {
            reasoning.push_str(event["params"]["delta"].as_str().unwrap());
        }
        if event["method"] == "item/agentMessage/delta" {
            projection.push_str(event["params"]["delta"].as_str().unwrap());
        }
        if event["method"] == "turn/completed" {
            break;
        }
    }
    assert_eq!(projection, expected);
    assert_eq!(reasoning, expected);
    assert_eq!(summary, expected);
    socket.close(None).await.unwrap();
    drop(socket);
    engine.shutdown().await;
    stop.cancel();
    server.await.unwrap().unwrap();
}

// RC-03 公开边界：先按 principal 过滤，Observer 可读且不暴露执行配置或历史正文。
#[tokio::test]
async fn work_overview_observer_is_scoped_before_paging() {
    use areal_app_server::auth::{Authentication, Permission, Principal};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(TextModel), Limits::default()).unwrap();
    let mut threads = Vec::new();
    for _ in 0..4 {
        threads.push(engine.create(engine.default_cwd()).await.unwrap().id);
    }
    threads.sort();
    let allowed = threads[3].clone();
    let token = "overview-observer-token-000000000000";
    let auth = Authentication {
        version: 1,
        principals: vec![Principal {
            id: "observer".into(),
            token: token.into(),
            permissions: [Permission::Observe].into(),
            thread_ids: Some([allowed.clone()].into()),
        }],
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let server = tokio::spawn(areal_app_server::serve_authenticated(
        listener,
        engine.clone(),
        stop.clone(),
        Some(auth),
    ));
    let mut request = format!("ws://{addr}").into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Authorization", format!("Bearer {token}").parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    call(
        &mut socket,
        1,
        "initialize",
        json!({"clientInfo":{"name":"overview","version":"1"}}),
    )
    .await;
    socket
        .send(Wire::Text(
            json!({"method":"initialized"}).to_string().into(),
        ))
        .await
        .unwrap();
    let (page, _) = call(&mut socket, 2, "areal/work/overview", json!({"limit":1})).await;
    assert!(page.get("error").is_none(), "{page}");
    assert_eq!(page["result"]["data"][0]["threadId"], allowed);
    assert_eq!(page["result"]["data"].as_array().unwrap().len(), 1);
    assert_eq!(page["result"]["complete"], true);
    assert_eq!(page["result"]["nextCursor"], Value::Null);
    let row = &page["result"]["data"][0];
    for key in ["cwd", "turns", "configuration", "receipts"] {
        assert!(row.get(key).is_none());
    }
    assert_eq!(row["execution"]["state"], "idle");
    assert_eq!(row["resultAvailable"], false);
    let (bad, _) = call(&mut socket, 3, "areal/work/overview", json!({"limit":101})).await;
    assert_eq!(bad["error"]["code"], -32602);
    let (caps, _) = call(&mut socket, 4, "areal/capabilities", json!({})).await;
    assert!(
        caps["result"]["methods"]
            .as_array()
            .unwrap()
            .contains(&json!("areal/work/overview"))
    );
    socket.close(None).await.unwrap();
    stop.cancel();
    server.await.unwrap().unwrap();
    engine.shutdown().await;
}

#[tokio::test]
async fn ordinary_admission_capabilities_and_rpc_errors_are_explicit() {
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
    call(
        &mut socket,
        1,
        "initialize",
        json!({"clientInfo":{"name":"guard-contract","version":"1"}}),
    )
    .await;
    socket
        .send(Wire::Text(
            json!({"method":"initialized"}).to_string().into(),
        ))
        .await
        .unwrap();
    let (caps, _) = call(&mut socket, 2, "areal/capabilities", json!({})).await;
    for feature in [
        "turnStartAdmissionGuard",
        "turnInterruptAdmissionGuard",
        "threadStartAdmissionGuard",
        "taskPauseRunGuard",
        "atomicObserveOwnership",
        "operationOutcomes",
        "taskRequestReceipts",
        "atomicConfigureReceipt",
        "automaticSessionName",
    ] {
        assert_eq!(caps["result"]["features"][feature], true, "{caps}");
    }
    let semantics = caps["result"]["methodSemantics"].as_object().unwrap();
    for method in caps["result"]["methods"].as_array().unwrap() {
        assert!(
            semantics.contains_key(method.as_str().unwrap()),
            "missing semantics: {method}"
        );
    }
    assert_eq!(semantics["areal/plugin/read"]["effect"], "read");
    assert_eq!(semantics["areal/task/subscribe"]["effect"], "subscription");
    assert_eq!(semantics["areal/thread/configure"]["receipt"], "thread");
    for (request_id, configuration) in [
        (
            "missing-profile",
            json!({"agentProfile":{"id":"missing","revision":"1"}}),
        ),
        (
            "missing-provider",
            json!({"model":{"providerId":"missing","modelId":"test"}}),
        ),
    ] {
        let mut request = configuration;
        request["requestId"] = json!(request_id);
        request["admissionGuard"] = json!({"ordinarySession":true});
        let (invalid, events) = call(&mut socket, 200, "areal/thread/start", request).await;
        assert_eq!(invalid["error"]["code"], -32004, "{invalid}");
        assert_eq!(
            invalid["error"]["data"]["outcome"]["kind"], "rejected",
            "{invalid}"
        );
        assert_eq!(
            invalid["error"]["data"]["recovery"]["kind"], "none",
            "{invalid}"
        );
        assert!(
            events
                .iter()
                .all(|event| event["method"] != "thread/started")
        );
        let (threads, _) = call(&mut socket, 201, "thread/list", json!({})).await;
        assert_eq!(threads["result"]["data"], json!([]), "{threads}");
        let (receipt, _) = call(
            &mut socket,
            202,
            "areal/request/read",
            json!({"requestId":request_id}),
        )
        .await;
        assert_eq!(receipt["result"]["data"], json!([]), "{receipt}");
    }
    let (invalid, _) = call(
        &mut socket,
        3,
        "areal/thread/start",
        json!({"requestId":"false-create","admissionGuard":{"ordinarySession":false}}),
    )
    .await;
    assert_eq!(invalid["error"]["code"], -32602, "{invalid}");
    let (created, _) = call(
        &mut socket,
        4,
        "areal/thread/start",
        json!({"requestId":"create","admissionGuard":{"ordinarySession":true}}),
    )
    .await;
    let id = created["result"]["thread"]["id"].as_str().unwrap();
    let (malformed, _) = call(
        &mut socket,
        100,
        "areal/thread/configure",
        json!({"threadId":id,"requestId":"bad","unexpected":true}),
    )
    .await;
    assert_eq!(malformed["error"]["data"]["outcome"]["kind"], "rejected");
    let (stale_config, _) = call(
        &mut socket,
        103,
        "areal/thread/configure",
        json!({"threadId":id,"requestId":"stale-config","expectedRevision":999,"options":{}}),
    )
    .await;
    assert_eq!(stale_config["error"]["code"], -32009);
    assert_eq!(stale_config["error"]["data"]["outcome"]["kind"], "rejected");
    let (failed, _) = call(
        &mut socket,
        101,
        "areal/plan/update",
        json!({"threadId":id,"requestId":"failed-plan","expectedRevision":999,"steps":[]}),
    )
    .await;
    assert_eq!(
        failed["error"]["data"]["outcome"]["kind"], "admitted",
        "{failed}"
    );
    assert_eq!(
        failed["error"]["data"]["outcome"]["operation"]["requestId"],
        "failed-plan"
    );
    let (receipt, _) = call(
        &mut socket,
        102,
        "areal/request/read",
        json!({"threadId":id,"requestId":"failed-plan"}),
    )
    .await;
    assert_eq!(
        receipt["result"]["data"][0]["status"], "failed",
        "{receipt}"
    );
    let (observed, _) = call(
        &mut socket,
        8,
        "areal/thread/observe",
        json!({"threadId":id}),
    )
    .await;
    assert_eq!(observed["result"]["ownership"], json!({"kind":"ordinary"}));
    let req = json!({"requestId":"stale","threadId":id,"input":[{"type":"text","text":"hello"}],"admissionGuard":{"configRevision":2,"ordinarySession":true}});
    let (stale, _) = call(&mut socket, 5, "areal/turn/start", req.clone()).await;
    assert_eq!(stale["error"]["code"], -32009, "{stale}");
    assert_eq!(
        stale["error"]["data"]["outcome"]["kind"], "rejected",
        "{stale}"
    );
    let mut req = req;
    req["admissionGuard"]["configRevision"] = json!(1);
    req["requestId"] = json!("false-send");
    req["admissionGuard"]["ordinarySession"] = json!(false);
    let (invalid, _) = call(&mut socket, 6, "areal/turn/start", req.clone()).await;
    assert_eq!(invalid["error"]["code"], -32602, "{invalid}");
    assert_eq!(
        invalid["error"]["data"]["outcome"]["kind"], "rejected",
        "{invalid}"
    );
    req["admissionGuard"]["ordinarySession"] = json!(true);
    req["requestId"] = json!("not-enqueue");
    let (invalid, _) = call(&mut socket, 7, "areal/turn/enqueue", req).await;
    assert_eq!(invalid["error"]["code"], -32602, "{invalid}");
    assert_eq!(
        invalid["error"]["data"]["outcome"]["kind"], "rejected",
        "{invalid}"
    );
    let (invalid, _) = call(
        &mut socket,
        104,
        "areal/turn/submit",
        json!({
            "threadId": id, "requestId": "invalid-input", "expectedConfigRevision": 1,
            "intent": {"type": "message", "input": []}
        }),
    )
    .await;
    assert_eq!(invalid["error"]["code"], -32602, "{invalid}");
    assert_eq!(
        invalid["error"]["data"]["outcome"]["kind"], "rejected",
        "{invalid}"
    );
    let (receipt, _) = call(
        &mut socket,
        105,
        "areal/request/read",
        json!({
            "threadId": id, "requestId": "invalid-input"
        }),
    )
    .await;
    assert_eq!(
        receipt["result"]["data"],
        json!([]),
        "rejection must not create an admission receipt: {receipt}"
    );
    assert!(engine.read(id, true).await.unwrap().turns.is_empty());
    let turn = engine
        .start(
            id,
            vec![serde_json::from_value(json!({"type":"text","text":"finish"})).unwrap()],
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), engine.wait(id))
        .await
        .unwrap()
        .unwrap();
    let before = serde_json::to_value(engine.queue(id).await.unwrap()).unwrap();
    let (stale, _) = call(
        &mut socket,
        9,
        "turn/interrupt",
        json!({"threadId":id,"turnId":turn.id,"admissionGuard":{"ordinarySession":true}}),
    )
    .await;
    assert_eq!(stale["error"]["code"], -32009, "{stale}");
    let (invalid, _) = call(
        &mut socket,
        10,
        "turn/interrupt",
        json!({"threadId":id,"turnId":turn.id,"admissionGuard":{"ordinarySession":false}}),
    )
    .await;
    assert_eq!(invalid["error"]["code"], -32602, "{invalid}");
    assert_eq!(
        serde_json::to_value(engine.queue(id).await.unwrap()).unwrap(),
        before
    );
    let (legacy, _) = call(
        &mut socket,
        11,
        "turn/interrupt",
        json!({"threadId":id,"turnId":turn.id}),
    )
    .await;
    assert_eq!(legacy["result"], json!({}), "{legacy}");
    assert!(engine.queue(id).await.unwrap().paused);

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

#[test]
fn interrupt_schema_keeps_guard_optional_and_strict() {
    let schema: Value =
        serde_json::from_str(include_str!("../../../schemas/areal-core-v1.json")).unwrap();
    let validator = jsonschema::validator_for(&schema["requests"]["turn/interrupt"]).unwrap();
    assert!(validator.is_valid(&json!({"threadId":"thread","turnId":"original"})));
    assert!(validator.is_valid(
        &json!({"threadId":"thread","turnId":"original","admissionGuard":{"ordinarySession":true}})
    ));
    assert!(
        !validator.is_valid(&json!({"threadId":"thread","turnId":"original","admissionGuard":{}}))
    );
    assert!(!validator.is_valid(&json!({"threadId":"thread","turnId":"original","admissionGuard":{"ordinarySession":true,"configRevision":1}})));
    assert!(
        !validator.is_valid(&json!({"threadId":"thread","turnId":"original","requestId":"new"}))
    );
}

#[tokio::test]
async fn task_request_lookup_filters_shared_principal_identity_by_thread_visibility() {
    use areal_app_server::auth::{Authentication, Permission, Principal};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(TextModel), Limits::default()).unwrap();
    let visible = engine.create("/fixture".into()).await.unwrap();
    let hidden = engine.create("/fixture".into()).await.unwrap();
    let mut tasks = Vec::new();
    for thread in [&visible, &hidden] {
        tasks.push(engine.task_create("shared-owner".into(), serde_json::from_value(json!({
            "requestId":"same-request","mode":"foreground","threadId":thread.id,"objective":"lookup fixture","tokenBudget":100,"maxTurns":1,"maxActiveSeconds":60
        })).unwrap()).await);
    }
    assert!(tasks[0].is_ok());
    assert!(
        tasks[1].is_err(),
        "same task request ID must reject a changed payload"
    );
    engine.task_create("shared-owner".into(), serde_json::from_value(json!({
        "requestId":"hidden-request","mode":"foreground","threadId":hidden.id,"objective":"hidden fixture","tokenBudget":100,"maxTurns":1,"maxActiveSeconds":60
    })).unwrap()).await.unwrap();
    engine
        .management_submission(
            "shared-owner".into(),
            "project-request".into(),
            "areal/provider/upsert".into(),
            json!({}),
            |_| async { json!({"result":{"secret":"project-only"}}) },
        )
        .await
        .unwrap();
    engine.shutdown().await;
    drop(engine);
    let engine = Engine::open(dir.path(), Arc::new(TextModel), Limits::default()).unwrap();
    let token = "receipt-observer-0000000000000000000000000";
    let other_token = "receipt-other-0000000000000000000000000000";
    let auth = Authentication {
        version: 1,
        principals: vec![
            Principal {
                id: "shared-owner".into(),
                token: token.into(),
                permissions: [Permission::Observe].into(),
                thread_ids: Some([visible.id.clone()].into()),
            },
            Principal {
                id: "other-owner".into(),
                token: other_token.into(),
                permissions: [Permission::Observe].into(),
                thread_ids: Some([visible.id.clone()].into()),
            },
        ],
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let server = tokio::spawn(areal_app_server::serve_authenticated(
        listener,
        engine.clone(),
        stop.clone(),
        Some(auth),
    ));
    let mut request = format!("ws://{addr}").into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Authorization", format!("Bearer {token}").parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    call(
        &mut socket,
        1,
        "initialize",
        json!({"clientInfo":{"name":"receipts","version":"1"}}),
    )
    .await;
    socket
        .send(Wire::Text(
            json!({"method":"initialized"}).to_string().into(),
        ))
        .await
        .unwrap();
    let (found, _) = call(
        &mut socket,
        2,
        "areal/request/read",
        json!({"requestId":"same-request"}),
    )
    .await;
    assert_eq!(
        found["result"]["data"][0]["operation"]["method"], "areal/task/create",
        "{found}"
    );
    assert_eq!(found["result"]["data"].as_array().unwrap().len(), 1);
    let receipt = &found["result"]["data"][0];
    assert_eq!(receipt["identity"], "shared-owner");
    assert_eq!(receipt["status"], "completed");
    assert_eq!(receipt["result"], *tasks[0].as_ref().unwrap());
    assert_eq!(
        receipt["operation"]["target"],
        json!({"kind":"task","taskId":tasks[0].as_ref().unwrap()["id"]})
    );
    let (bound_visible, _) = call(
        &mut socket,
        6,
        "areal/request/read",
        json!({"threadId":visible.id,"requestId":"same-request"}),
    )
    .await;
    assert_eq!(bound_visible["result"]["data"], found["result"]["data"]);
    let (hidden, _) = call(
        &mut socket,
        3,
        "areal/request/read",
        json!({"requestId":"hidden-request"}),
    )
    .await;
    assert_eq!(hidden["result"]["data"], json!([]), "{hidden}");
    let (bound, _) = call(
        &mut socket,
        4,
        "areal/request/read",
        json!({"threadId":visible.id,"requestId":"hidden-request"}),
    )
    .await;
    assert_eq!(bound["result"]["data"], json!([]), "{bound}");
    let (project, _) = call(
        &mut socket,
        5,
        "areal/request/read",
        json!({"threadId":visible.id,"requestId":"project-request"}),
    )
    .await;
    assert_eq!(project["result"]["data"], json!([]), "{project}");
    let (proof, _) = call(&mut socket, 7, "areal/request/read", json!({
        "requestId":"missing-creation", "creationAdmission":engine.creation_admission("shared-owner").await
    })).await;
    assert_eq!(proof["result"]["data"], json!([]));
    assert!(
        proof["result"].get("creationAdmission").is_none(),
        "Thread-scoped observers cannot obtain project admission evidence"
    );
    let mut other_request = format!("ws://{addr}").into_client_request().unwrap();
    other_request.headers_mut().insert(
        "Authorization",
        format!("Bearer {other_token}").parse().unwrap(),
    );
    let (mut other_socket, _) = tokio_tungstenite::connect_async(other_request)
        .await
        .unwrap();
    call(
        &mut other_socket,
        1,
        "initialize",
        json!({"clientInfo":{"name":"other-receipts","version":"1"}}),
    )
    .await;
    other_socket
        .send(Wire::Text(
            json!({"method":"initialized"}).to_string().into(),
        ))
        .await
        .unwrap();
    let (other_owner, _) = call(
        &mut other_socket,
        2,
        "areal/request/read",
        json!({"requestId":"same-request"}),
    )
    .await;
    assert_eq!(other_owner["result"]["data"], json!([]), "{other_owner}");
    other_socket.close(None).await.unwrap();
    socket.close(None).await.unwrap();
    stop.cancel();
    server.await.unwrap().unwrap();
    engine.shutdown().await;
}

#[tokio::test]
async fn configure_preserves_legacy_management_receipts_after_reopen() {
    use sha2::{Digest, Sha256};
    let hash = |value: &Value| format!("{:x}", Sha256::digest(serde_json::to_vec(value).unwrap()));
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(TextModel), Limits::default()).unwrap();
    let completed_thread = engine.create("/fixture".into()).await.unwrap();
    let unknown_thread = engine.create("/fixture".into()).await.unwrap();
    let fresh_thread = engine.create("/fixture".into()).await.unwrap();
    let completed_params = json!({"threadId":completed_thread.id,"expectedRevision":1,"options":{"appendInstructions":"legacy-config"}});
    let unknown_params = json!({"threadId":unknown_thread.id,"expectedRevision":1,"options":{"appendInstructions":"must-not-replay"}});
    let fresh_params = json!({"threadId":fresh_thread.id,"expectedRevision":1,"options":{"appendInstructions":"fresh-config"}});
    let original = engine
        .configure_thread(serde_json::from_value(completed_params.clone()).unwrap())
        .await
        .unwrap();
    let mut journal = serde_json::Map::new();
    for (identity, method, request_id, params, state, response) in [
        (
            "trusted-embedded-host",
            "areal/thread/configure",
            "legacy-completed",
            &completed_params,
            "completed",
            json!({"result":original}),
        ),
        (
            "trusted-embedded-host",
            "areal/thread/configure",
            "legacy-unknown",
            &unknown_params,
            "accepted",
            Value::Null,
        ),
        (
            "other-owner",
            "areal/thread/configure",
            "fresh-configure",
            &fresh_params,
            "completed",
            json!({"result":"wrong-owner"}),
        ),
        (
            "trusted-embedded-host",
            "areal/plan/update",
            "fresh-configure",
            &fresh_params,
            "completed",
            json!({"result":"wrong-method"}),
        ),
    ] {
        journal.insert(hash(&json!([identity, method, request_id])), json!({
            "identity":identity,"requestId":request_id,"method":method,"digest":hash(params),"state":state,"response":response
        }));
    }
    engine.shutdown().await;
    drop(engine);
    let journal_path = dir.path().join("desktop/submissions.json");
    std::fs::create_dir_all(journal_path.parent().unwrap()).unwrap();
    std::fs::write(&journal_path, serde_json::to_vec(&journal).unwrap()).unwrap();
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
    call(
        &mut socket,
        1,
        "initialize",
        json!({"clientInfo":{"name":"legacy-configure","version":"1"}}),
    )
    .await;
    socket
        .send(Wire::Text(
            json!({"method":"initialized"}).to_string().into(),
        ))
        .await
        .unwrap();
    let mut completed_request = completed_params.clone();
    completed_request["requestId"] = json!("legacy-completed");
    let (completed, _) = call(
        &mut socket,
        2,
        "areal/thread/configure",
        completed_request.clone(),
    )
    .await;
    completed_request["options"]["appendInstructions"] = json!("changed");
    let (conflict, _) = call(&mut socket, 3, "areal/thread/configure", completed_request).await;
    let mut unknown_request = unknown_params;
    unknown_request["requestId"] = json!("legacy-unknown");
    let (unknown, _) = call(
        &mut socket,
        4,
        "areal/thread/configure",
        unknown_request.clone(),
    )
    .await;
    let (unknown_repeat, _) = call(&mut socket, 5, "areal/thread/configure", unknown_request).await;
    let (unknown_config, _) = call(
        &mut socket,
        6,
        "areal/thread/inspect",
        json!({"threadId":unknown_thread.id}),
    )
    .await;
    let mut fresh_request = fresh_params;
    fresh_request["requestId"] = json!("fresh-configure");
    let (fresh, _) = call(&mut socket, 7, "areal/thread/configure", fresh_request).await;
    let (archived, _) = call(
        &mut socket,
        8,
        "areal/thread/archive",
        json!({"threadId":fresh_thread.id,"requestId":"archive-fresh"}),
    )
    .await;
    let (archive_receipt, _) = call(
        &mut socket,
        9,
        "areal/request/read",
        json!({"threadId":fresh_thread.id,"requestId":"archive-fresh"}),
    )
    .await;
    let (malformed, _) = call(
        &mut socket,
        10,
        "areal/thread/configure",
        json!({"threadId":unknown_thread.id,"expectedRevision":1,"requestId":7}),
    )
    .await;
    socket.close(None).await.unwrap();
    stop.cancel();
    server.await.unwrap().unwrap();
    engine.shutdown().await;
    assert_eq!(
        completed["result"],
        json!(original),
        "completed={completed}; unknown={unknown}; state={unknown_config}"
    );
    assert_eq!(conflict["error"]["code"], -32009, "{conflict}");
    assert_eq!(conflict["error"]["data"]["outcome"]["kind"], "rejected");
    assert_eq!(
        malformed["error"]["data"]["outcome"]["kind"], "rejected",
        "{malformed}"
    );
    assert_eq!(
        unknown["error"]["data"]["outcome"]["kind"], "admitted",
        "{unknown}"
    );
    assert_eq!(
        unknown["error"]["data"]["outcome"]["operation"]["target"]["threadId"],
        unknown_thread.id
    );
    assert_eq!(
        unknown["error"]["data"]["outcome"]["operation"]["requestId"],
        "legacy-unknown"
    );
    assert_eq!(unknown_repeat["error"], unknown["error"]);
    assert_eq!(
        unknown_config["result"]["configuration"]["revision"], 1,
        "{unknown_config}"
    );
    assert_eq!(fresh["result"]["revision"], 2, "{fresh}");
    assert_eq!(archived["result"]["archived"], true, "{archived}");
    assert_eq!(
        archive_receipt["result"]["data"][0]["result"], archived["result"],
        "{archive_receipt}"
    );
    let saved: Value = serde_json::from_slice(&std::fs::read(journal_path).unwrap()).unwrap();
    assert_eq!(
        saved["entries"].as_object().unwrap().len(),
        journal.len() + 1,
        "new configure must use the Thread receipt store; only archive adds a management record"
    );
}

#[tokio::test]
async fn creation_journal_protocol_distinguishes_retired_absence_from_unknown() {
    let dir = tempfile::tempdir().unwrap();
    let mut original_binding = Value::Null;
    let mut original_thread = Value::Null;
    for generation in 0..2 {
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
        call(
            &mut socket,
            1,
            "initialize",
            json!({"clientInfo":{"name":"creation-journal","version":"1"}}),
        )
        .await;
        socket
            .send(Wire::Text(
                json!({"method":"initialized"}).to_string().into(),
            ))
            .await
            .unwrap();
        let (cap, _) = call(&mut socket, 2, "areal/capabilities", json!({})).await;
        let journal = &cap["result"]["features"]["threadCreationJournal"];
        assert_eq!(journal["version"], 1);
        let binding = journal["binding"].clone();
        if generation == 0 {
            original_binding = binding.clone();
        } else {
            assert_eq!(binding["journalEpoch"], original_binding["journalEpoch"]);
            assert_ne!(
                binding["coreInstanceId"],
                original_binding["coreInstanceId"]
            );
        }
        let (missing, _) = call(
            &mut socket,
            3,
            "areal/request/read",
            json!({"requestId":"not-dispatched","creationAdmission":original_binding}),
        )
        .await;
        assert_eq!(
            missing["result"]["creationAdmission"]["status"],
            if generation == 0 {
                "unconfirmed"
            } else {
                "notAdmitted"
            }
        );
        assert!(missing["result"]["data"].as_array().unwrap().is_empty());
        if generation == 0 {
            let parameters = json!({"requestId":"created-once","creationAdmission":binding});
            let (created, _) = call(&mut socket, 4, "areal/thread/start", parameters.clone()).await;
            original_thread = created["result"]["thread"]["id"].clone();
            assert!(original_thread.is_string(), "{created}");
            let (duplicate, _) = call(&mut socket, 5, "areal/thread/start", parameters).await;
            assert_eq!(duplicate["result"]["thread"]["id"], original_thread);
        } else {
            let (late, _) = call(
                &mut socket,
                4,
                "areal/thread/start",
                json!({"requestId":"not-dispatched","creationAdmission":original_binding}),
            )
            .await;
            assert_eq!(late["error"]["data"]["outcome"]["kind"], "rejected");
            let (found, _) = call(
                &mut socket,
                5,
                "areal/request/read",
                json!({"requestId":"created-once","creationAdmission":original_binding}),
            )
            .await;
            assert_eq!(found["result"]["data"].as_array().unwrap().len(), 1);
            assert_eq!(found["result"]["data"][0]["threadId"], original_thread);
            assert_eq!(found["result"]["data"][0]["status"], "completed");
            let (legacy, _) = call(
                &mut socket,
                6,
                "areal/request/read",
                json!({"requestId":"not-dispatched"}),
            )
            .await;
            assert!(legacy["result"].get("creationAdmission").is_none());
            assert!(legacy["result"]["data"].as_array().unwrap().is_empty());
        }
        assert_eq!(engine.list(None, 100, None).await.unwrap().0.len(), 1);
        drop(socket);
        stop.cancel();
        server.await.unwrap().unwrap();
        engine.shutdown().await;
        drop(engine);
    }
}
