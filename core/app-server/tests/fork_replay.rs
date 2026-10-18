use areal_app_server::auth::{Authentication, Permission, Principal};
use areal_engine::{
    Engine, Limits,
    model::{ContentPart, MediaSource, Message, Model, ModelCapabilities, ModelEvent, ModelStream},
};
use areal_protocol::Modality;
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{Message as Wire, client::IntoClientRequest},
};
use tokio_util::sync::CancellationToken;

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

struct ImageModel(Mutex<Vec<Vec<Message>>>);

#[async_trait]
impl Model for ImageModel {
    fn name(&self) -> &str {
        "image-fixture"
    }
    fn capabilities(&self) -> ModelCapabilities {
        ModelCapabilities {
            input: vec![Modality::Text, Modality::Image],
            output: vec![Modality::Text, Modality::Image],
            context_window_tokens: None,
            max_output_tokens: None,
            summary_output_tokens: None,
        }
    }
    async fn stream(&self, messages: Vec<Message>) -> anyhow::Result<ModelStream> {
        self.0.lock().unwrap().push(messages);
        let png = vec![
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
            8, 4, 0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 252, 255, 31,
            0, 3, 3, 2, 0, 239, 191, 151, 137, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
        ];
        Ok(Box::pin(futures_util::stream::iter([
            Ok(ModelEvent::Binary {
                modality: Modality::Image,
                mime_type: "image/png".into(),
                data: png,
            }),
            Ok(ModelEvent::TextDelta("image retained".into())),
        ])))
    }
}

struct TextOnlyModel;

#[async_trait]
impl Model for TextOnlyModel {
    fn name(&self) -> &str {
        "text-only-target"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        panic!("incompatible target must never execute")
    }
}

async fn call(socket: &mut Socket, id: u64, method: &str, params: Value) -> Value {
    socket
        .send(Wire::Text(
            json!({"id":id,"method":method,"params":params})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    loop {
        let wire = tokio::time::timeout(Duration::from_secs(10), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let value: Value = serde_json::from_str(wire.to_text().unwrap()).unwrap();
        if value["id"] == id {
            return value;
        }
    }
}

#[tokio::test]
async fn fork_keeps_inherited_media_readable_without_copying_execution() {
    unsafe {
        std::env::set_var("AREAL_DEV_CONVERSATION_DERIVATION", "1");
    }
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(ImageModel(Mutex::new(Vec::new())));
    let engine = Engine::open(dir.path(), model.clone(), Limits::default()).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let owner_token = "fork-image-owner-token-1234567890";
    let scoped_token = "fork-image-scoped-token-1234567890";
    let auth = Authentication {
        version: 1,
        principals: vec![
            Principal {
                id: "owner".into(),
                token: owner_token.into(),
                permissions: [
                    Permission::Observe,
                    Permission::Interact,
                    Permission::Manage,
                ]
                .into(),
                thread_ids: None,
            },
            Principal {
                id: "scoped".into(),
                token: scoped_token.into(),
                permissions: [Permission::Observe].into(),
                thread_ids: Some(BTreeSet::new()),
            },
        ],
    };
    let server = tokio::spawn(areal_app_server::serve_authenticated(
        listener,
        engine.clone(),
        stop.clone(),
        Some(auth),
    ));
    let mut request = format!("ws://{addr}").into_client_request().unwrap();
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {owner_token}").parse().unwrap(),
    );
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    call(
        &mut socket,
        1,
        "initialize",
        json!({"clientInfo":{"name":"test","version":"1"}}),
    )
    .await;
    socket
        .send(Wire::Text(
            json!({"method":"initialized"}).to_string().into(),
        ))
        .await
        .unwrap();
    let source = call(&mut socket, 2, "thread/start", json!({"cwd":"/workspace"})).await;
    let source_id = source["result"]["thread"]["id"].as_str().unwrap();
    let png = vec![
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4,
        0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 252, 255, 31, 0, 3, 3,
        2, 0, 239, 191, 151, 137, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ];
    let uploaded: Value = reqwest::Client::new()
        .post(format!("http://{addr}/areal/blobs?threadId={source_id}"))
        .bearer_auth(owner_token)
        .header("Content-Type", "image/png")
        .body(png)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let source_image = uploaded["uri"].as_str().unwrap();
    call(
        &mut socket,
        3,
        "turn/start",
        json!({"threadId":source_id,"input":[{"type":"text","text":"show image"},{"type":"image","url":source_image}]}),
    )
    .await;
    let read = loop {
        let read = call(
            &mut socket,
            4,
            "thread/read",
            json!({"threadId":source_id,"includeTurns":true}),
        )
        .await;
        if read["result"]["thread"]["turns"][0]["status"] == "completed" {
            break read;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let turn_id = read["result"]["thread"]["turns"][0]["id"].as_str().unwrap();
    let media = read["result"]["thread"]["turns"][0]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["type"] == "agentMedia")
        .unwrap();
    let blob = media["media"]["uri"]
        .as_str()
        .unwrap()
        .strip_prefix("areal://blob/")
        .unwrap();
    // 真实上传和模型输出的媒体都在来源中；拒绝不能产生目标或模型请求。
    engine.register_default_model("text-only-target".into(), Arc::new(TextOnlyModel), true);
    let source_before = call(
        &mut socket,
        41,
        "thread/read",
        json!({"threadId":source_id,"includeTurns":true}),
    )
    .await;
    let count_before = engine.list(None, 100, None).await.unwrap().0.len();
    let requests_before = model.0.lock().unwrap().len();
    let rejected = call(&mut socket, 42, "areal/thread/fork", json!({
        "requestId":"image-incompatible-target", "sourceThreadId":source_id,
        "anchor":{"turnId":turn_id,"boundary":"after"}, "workspaceMode":"sharedCurrent", "target":{}
    })).await;
    assert!(
        rejected["error"]
            .to_string()
            .contains("MODEL_MODALITY_INCOMPATIBLE"),
        "{rejected}"
    );
    assert_eq!(
        engine.list(None, 100, None).await.unwrap().0.len(),
        count_before
    );
    assert_eq!(model.0.lock().unwrap().len(), requests_before);
    assert_eq!(
        call(
            &mut socket,
            43,
            "thread/read",
            json!({"threadId":source_id,"includeTurns":true})
        )
        .await["result"],
        source_before["result"]
    );
    // 后面的媒体访问路径仍沿用原始图像模型。
    engine.register_default_model("image-fixture-restored".into(), model.clone(), true);
    let fork = call(
        &mut socket,
        5,
        "areal/thread/fork",
        json!({"requestId":"image-fork","sourceThreadId":source_id,
        "anchor":{"turnId":turn_id,"boundary":"after"},"workspaceMode":"sharedCurrent"}),
    )
    .await;
    assert!(fork.get("result").is_some(), "{fork}");
    let fork_id = fork["result"]["thread"]["id"].as_str().unwrap();
    assert_eq!(fork["result"]["thread"]["turns"], json!([]));
    call(
        &mut socket,
        7,
        "turn/start",
        json!({"threadId":fork_id,"input":[{"type":"text","text":"continue"}]}),
    )
    .await;
    loop {
        let read = call(
            &mut socket,
            8,
            "thread/read",
            json!({"threadId":fork_id,"includeTurns":true}),
        )
        .await;
        if read["result"]["thread"]["turns"][0]["status"] == "completed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        model
            .0
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .iter()
            .flat_map(|message| &message.content)
            .any(
                |part| matches!(part, ContentPart::Image { source: MediaSource::Url(url), .. }
            if url.starts_with("data:image/png;base64,"))
            )
    );
    let side = call(&mut socket, 9, "areal/side/start", json!({"requestId":"image-side-a",
        "sourceThreadId":source_id,"workspaceAccess":"none","input":[{"type":"text","text":"Describe the retained image"}]})).await;
    let side_id = side["result"]["thread"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("{}", side))
        .to_owned();
    engine.wait(&side_id).await.unwrap();
    let other_side = call(&mut socket, 10, "areal/side/start", json!({"requestId":"image-side-b",
        "sourceThreadId":source_id,"workspaceAccess":"none","input":[{"type":"text","text":"Describe it again"}]})).await;
    let other_side_id = other_side["result"]["thread"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("{}", other_side))
        .to_owned();
    engine.wait(&other_side_id).await.unwrap();
    let archived = call(
        &mut socket,
        6,
        "areal/thread/archive",
        json!({"threadId":source_id}),
    )
    .await;
    assert!(archived.get("result").is_some(), "{archived}");
    let url = format!("http://{addr}/areal/blobs/{blob}?threadId={fork_id}");
    let client = reqwest::Client::new();
    let owner_read = client
        .get(&url)
        .bearer_auth(owner_token)
        .send()
        .await
        .unwrap();
    assert_eq!(owner_read.status(), reqwest::StatusCode::OK);
    assert_eq!(
        owner_read.bytes().await.unwrap().len() as u64,
        media["media"]["sizeBytes"]
    );
    let scoped_read = client
        .get(&url)
        .bearer_auth(scoped_token)
        .send()
        .await
        .unwrap();
    assert_eq!(scoped_read.status(), reqwest::StatusCode::FORBIDDEN);
    let foreign = client
        .get(format!(
            "http://{addr}/areal/blobs/{blob}?threadId=unrelated"
        ))
        .bearer_auth(owner_token)
        .send()
        .await
        .unwrap();
    assert_eq!(foreign.status(), reqwest::StatusCode::NOT_FOUND);
    stop.cancel();
    server.await.unwrap().unwrap();
    let target_token = "side-image-target-token-1234567890123";
    let target_auth = Authentication {
        version: 1,
        principals: vec![Principal {
            id: "target-only".into(),
            token: target_token.into(),
            permissions: [Permission::Observe].into(),
            thread_ids: Some([side_id.clone()].into()),
        }],
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target_addr = listener.local_addr().unwrap();
    let target_stop = CancellationToken::new();
    let target_server = tokio::spawn(areal_app_server::serve_authenticated(
        listener,
        engine.clone(),
        target_stop.clone(),
        Some(target_auth),
    ));
    let target_url = |id: &str| format!("http://{target_addr}/areal/blobs/{blob}?threadId={id}");
    let target_read = client
        .get(target_url(&side_id))
        .bearer_auth(target_token)
        .send()
        .await
        .unwrap();
    assert_eq!(target_read.status(), reqwest::StatusCode::OK);
    assert_eq!(
        target_read.bytes().await.unwrap().len() as u64,
        media["media"]["sizeBytes"]
    );
    for denied in [source_id, other_side_id.as_str()] {
        let response = client
            .get(target_url(denied))
            .bearer_auth(target_token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::FORBIDDEN);
    }
    target_stop.cancel();
    target_server.await.unwrap().unwrap();
    engine.shutdown().await;
}

// 验收真实 HTTP 适配器、持久快照和公开工具回调的连接处，不构造历史 Item。
#[tokio::test]
async fn fork_replays_actual_adapter_tool_batches_without_reexecuting_source() {
    use areal_engine::model::{HttpModel, ModelProtocol};
    use axum::{
        Json, Router,
        response::sse::{Event, Sse},
        routing::post,
    };
    use std::{
        convert::Infallible,
        sync::atomic::{AtomicUsize, Ordering},
    };

    unsafe {
        std::env::set_var("AREAL_DEV_CONVERSATION_DERIVATION", "1");
    }
    for protocol in [ModelProtocol::ChatCompletions, ModelProtocol::Responses] {
        let responses = protocol == ModelProtocol::Responses;
        let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = requests.clone();
        let context = json!({"type":"reasoning","id":"rs_anchor","summary":[],"encrypted_content":"ANCHOR_ENCRYPTED_REASONING"});
        let calls: Vec<Value> = (0..2).map(|i| json!({"type":"function_call","id":format!("fc_{i}"),"call_id":format!("call_{i}"),"name":"lookup","arguments":format!("{{\"key\":\"value_{i}\"}}"),"status":"completed"})).collect();
        let returned_calls = calls.clone();
        let returned_context = context.clone();
        let app = Router::new().route("/", post(move |Json(request): Json<Value>| {
            let round = { let mut captured = captured.lock().unwrap(); let round = captured.len(); captured.push(request); round };
            let mut output = vec![returned_context.clone()];
            output.extend(returned_calls.clone());
            async move {
                let events = if responses {
                    if round == 0 {
                        vec![json!({"type":"response.completed","response":{"id":"resp_anchor","status":"completed","output":output,"usage":{"input_tokens":11,"output_tokens":7}}})]
                    } else {
                        let text = if round == 2 { "AFTER_ANCHOR_SENTINEL" } else { "completed" };
                        vec![json!({"type":"response.output_text.delta","delta":text}),json!({"type":"response.completed","response":{"id":format!("resp_{round}"),"status":"completed","output":[],"usage":{"input_tokens":11,"output_tokens":7}}})]
                    }
                } else if round == 0 {
                    vec![json!({"choices":[{"index":0,"delta":{"reasoning_content":"ANCHOR_CHAT_REASONING","tool_calls":[
                        {"index":0,"id":"call_0","type":"function","function":{"name":"lookup","arguments":"{\"key\":\"value_0\"}"}},
                        {"index":1,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\"key\":\"value_1\"}"}}
                    ]}}]}),json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":11,"completion_tokens":7}})]
                } else {
                    let text = if round == 2 { "AFTER_ANCHOR_SENTINEL" } else { "completed" };
                    vec![json!({"choices":[{"index":0,"delta":{"content":text}}]}),json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7}})]
                };
                Sse::new(futures_util::stream::iter(events.into_iter().map(|v| Ok::<_,Infallible>(Event::default().data(v.to_string())))))
            }
        }));
        let http_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/", http_listener.local_addr().unwrap());
        let http_server =
            tokio::spawn(async move { axum::serve(http_listener, app).await.unwrap() });
        let model = Arc::new(
            HttpModel::with_protocol(endpoint.clone(), "replay-fixture".into(), None, protocol)
                .unwrap(),
        );
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(dir.path(), model, Limits::default()).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let stop = CancellationToken::new();
        let server = tokio::spawn(areal_app_server::serve(
            listener,
            engine.clone(),
            stop.clone(),
        ));
        let (mut socket, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        assert!(
            call(
                &mut socket,
                1,
                "initialize",
                json!({"clientInfo":{"name":"replay-acceptance","version":"1"}})
            )
            .await["result"]
                .is_object()
        );
        socket
            .send(Wire::Text(
                json!({"method":"initialized"}).to_string().into(),
            ))
            .await
            .unwrap();
        let source = call(&mut socket, 2, "thread/start", json!({"cwd":"/workspace","dynamicTools":[{"name":"lookup","description":"Count an actual host execution","inputSchema":{"type":"object","properties":{"key":{"type":"string"}},"required":["key"],"additionalProperties":false}}]})).await;
        let source_id = source["result"]["thread"]["id"].as_str().unwrap();
        let anchor = call(
            &mut socket,
            3,
            "turn/start",
            json!({"threadId":source_id,"input":[{"type":"text","text":"ANCHOR_QUESTION"}]}),
        )
        .await;
        let anchor_id = anchor["result"]["turn"]["id"].as_str().unwrap();
        let execution_count = Arc::new(AtomicUsize::new(0));
        let mut executions = Vec::new();
        while executions.len() < 2 {
            let wire = tokio::time::timeout(Duration::from_secs(10), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let value: Value = serde_json::from_str(wire.to_text().unwrap()).unwrap();
            if value["method"] == "item/tool/call" {
                assert_eq!(value["params"]["threadId"], source_id);
                assert_eq!(value["params"]["tool"], "lookup");
                let key = value["params"]["arguments"]["key"]
                    .as_str()
                    .unwrap()
                    .to_owned();
                executions.push(key.clone());
                execution_count.fetch_add(1, Ordering::SeqCst);
                socket.send(Wire::Text(json!({"id":value["id"],"result":{"success":true,"contentItems":[{"type":"inputText","text":format!("ACTUAL_RESULT_{key}")} ]}}).to_string().into())).await.unwrap();
            }
        }
        executions.sort();
        assert_eq!(executions, ["value_0", "value_1"]);
        let settled = tokio::time::timeout(Duration::from_secs(10), engine.wait(source_id))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            settled.turns[0].status,
            areal_protocol::TurnStatus::Completed,
            "{:?}",
            settled.turns[0].error
        );
        assert_eq!(settled.turns[0].usage.as_ref().unwrap().input_tokens, 22);
        // 来源工具宿主持续接收回调，后面的计数断言可以捕获意外重放。
        let host_count = execution_count.clone();
        let source_host = tokio::spawn(async move {
            while let Some(wire) = socket.next().await {
                let wire = wire.unwrap();
                if !wire.is_text() {
                    continue;
                }
                let value: Value = serde_json::from_str(wire.to_text().unwrap()).unwrap();
                if value["method"] == "item/tool/call" {
                    host_count.fetch_add(1, Ordering::SeqCst);
                    socket.send(Wire::Text(json!({"id":value["id"],"result":{"success":true,"contentItems":[{"type":"inputText","text":"UNEXPECTED_REEXECUTION"}]}}).to_string().into())).await.unwrap();
                }
            }
        });
        let (mut socket, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        assert!(
            call(
                &mut socket,
                31,
                "initialize",
                json!({"clientInfo":{"name":"replay-observer","version":"1"}})
            )
            .await["result"]
                .is_object()
        );
        socket
            .send(Wire::Text(
                json!({"method":"initialized"}).to_string().into(),
            ))
            .await
            .unwrap();
        let later = call(
            &mut socket,
            4,
            "turn/start",
            json!({"threadId":source_id,"input":[{"type":"text","text":"AFTER_ANCHOR_SENTINEL"}]}),
        )
        .await;
        assert!(later["result"].is_object(), "{later}");
        tokio::time::timeout(Duration::from_secs(10), engine.wait(source_id))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(requests.lock().unwrap().len(), 3);
        let source_before = call(
            &mut socket,
            5,
            "thread/read",
            json!({"threadId":source_id,"includeTurns":true}),
        )
        .await;
        let fork_params = json!({"requestId":"adapter-fork","sourceThreadId":source_id,"anchor":{"turnId":anchor_id,"boundary":"after"},"workspaceMode":"sharedCurrent"});
        let fork = call(&mut socket, 6, "areal/thread/fork", fork_params.clone()).await;
        assert!(fork["result"].is_object(), "{fork}");
        let fork_id = fork["result"]["thread"]["id"].as_str().unwrap();
        assert_eq!(fork["result"]["thread"]["turns"], json!([]));
        assert!(fork["result"]["thread"]["contextCheckpoint"].is_null());
        assert_eq!(
            fork["result"]["thread"]["conversation"]["historySeed"]["turnCount"],
            1
        );
        let own_tokens: u64 = fork["result"]["thread"]["turns"]
            .as_array()
            .unwrap()
            .iter()
            .map(|turn| {
                turn["usage"]["inputTokens"].as_u64().unwrap_or(0)
                    + turn["usage"]["outputTokens"].as_u64().unwrap_or(0)
            })
            .sum();
        assert_eq!(own_tokens, 0);
        assert_eq!(requests.lock().unwrap().len(), 3);
        assert!(
            call(
                &mut socket,
                7,
                "turn/start",
                json!({"threadId":fork_id,"input":[{"type":"text","text":"FORK_CONTINUATION"}]})
            )
            .await["result"]
                .is_object()
        );
        let target = tokio::time::timeout(Duration::from_secs(10), engine.wait(fork_id))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            target.turns[0].status,
            areal_protocol::TurnStatus::Completed
        );
        assert_eq!(target.turns[0].usage.as_ref().unwrap().input_tokens, 11);
        let request = requests.lock().unwrap().last().unwrap().clone();
        assert_eq!(requests.lock().unwrap().len(), 4);
        assert!(!request.to_string().contains("AFTER_ANCHOR_SENTINEL"));
        assert!(request.to_string().contains("FORK_CONTINUATION"));
        assert!(request.get("previous_response_id").is_none());
        if responses {
            let input = request["input"].as_array().unwrap();
            let replay: Vec<_> = input
                .iter()
                .filter(|item| {
                    matches!(
                        item["type"].as_str(),
                        Some("reasoning" | "function_call" | "function_call_output")
                    )
                })
                .collect();
            assert_eq!(replay.len(), 5, "{request}");
            assert_eq!(replay[0], &context);
            assert_eq!(replay[1], &calls[0]);
            assert_eq!(replay[2], &calls[1]);
            for i in 0..2 {
                assert_eq!(replay[i + 3]["type"], "function_call_output");
                assert_eq!(replay[i + 3]["call_id"], format!("call_{i}"));
                assert!(
                    replay[i + 3]["output"]
                        .as_str()
                        .unwrap()
                        .contains(&format!("ACTUAL_RESULT_value_{i}"))
                );
            }
        } else {
            let messages = request["messages"].as_array().unwrap();
            let batches: Vec<_> = messages
                .iter()
                .enumerate()
                .filter(|(_, m)| m["tool_calls"].is_array())
                .collect();
            assert_eq!(batches.len(), 1, "{request}");
            let (at, batch) = batches[0];
            // Chat 的 reasoning 是可展示历史，适配器没有声明其为可重放 ProviderContext。
            assert!(batch.get("reasoning_content").is_none());
            let history = call(
                &mut socket,
                71,
                "areal/conversation/history",
                json!({"threadId":fork_id,"view":"inherited","maxBytes":16384}),
            )
            .await;
            assert!(
                history.to_string().contains("ANCHOR_CHAT_REASONING"),
                "{history}"
            );
            assert_eq!(batch["tool_calls"].as_array().unwrap().len(), 2);
            for i in 0..2 {
                assert_eq!(batch["tool_calls"][i]["id"], format!("call_{i}"));
                assert_eq!(
                    batch["tool_calls"][i]["function"]["arguments"],
                    calls[i]["arguments"]
                );
                assert_eq!(messages[at + i + 1]["role"], "tool");
                assert_eq!(messages[at + i + 1]["tool_call_id"], format!("call_{i}"));
                assert!(
                    messages[at + i + 1]["content"]
                        .as_str()
                        .unwrap()
                        .contains(&format!("ACTUAL_RESULT_value_{i}"))
                );
            }
        }
        assert_eq!(
            call(
                &mut socket,
                8,
                "thread/read",
                json!({"threadId":source_id,"includeTurns":true})
            )
            .await["result"],
            source_before["result"]
        );
        let count = engine.list(None, 100, None).await.unwrap().0.len();
        for (key, invalid_turn) in [
            ("missing", "missing-turn"),
            ("cross-source", target.turns[0].id.as_str()),
        ] {
            let mut params = fork_params.clone();
            params["requestId"] = json!(key);
            params["anchor"]["turnId"] = json!(invalid_turn);
            let rejected = call(&mut socket, 9, "areal/thread/fork", params).await;
            assert!(
                rejected["error"].to_string().contains("ANCHOR_NOT_FOUND"),
                "{rejected}"
            );
            assert_eq!(engine.list(None, 100, None).await.unwrap().0.len(), count);
        }
        if responses {
            engine.register_default_model(
                "chat-target".into(),
                Arc::new(HttpModel::new(endpoint, "chat-target".into(), None).unwrap()),
                true,
            );
            let mut params = fork_params.clone();
            params["requestId"] = json!("incompatible-context");
            params["target"] = json!({});
            let rejected = call(&mut socket, 10, "areal/thread/fork", params).await;
            assert!(
                rejected["error"]
                    .to_string()
                    .contains("MODEL_CONTEXT_INCOMPATIBLE"),
                "{rejected}"
            );
        }
        let deployment = dir.path().join("fixture-deployment.json");
        std::fs::write(&deployment, serde_json::to_vec(&json!({"profiles":[{"id":"automatic","revision":"1","displayName":"Automatic","instructions":"","workflow":{"id":"flow","revision":"1"}}],"workflows":[{"id":"flow","revision":"1","displayName":"Flow","plan":{"objective":"must not start","tasks":[{"id":"one","instruction":"must not execute","writes":[]}]}}]})).unwrap()).unwrap();
        engine.install_deployment(&deployment).unwrap();
        let mut params = fork_params;
        params["requestId"] = json!("automatic-profile");
        params["target"] = json!({"agentProfile":{"id":"automatic","revision":"1"}});
        let rejected = call(&mut socket, 11, "areal/thread/fork", params).await;
        assert!(
            rejected["error"]
                .to_string()
                .contains("PROFILE_NOT_SUPPORTED"),
            "{rejected}"
        );
        assert_eq!(engine.list(None, 100, None).await.unwrap().0.len(), count);
        assert_eq!(requests.lock().unwrap().len(), 4);
        assert_eq!(execution_count.load(Ordering::SeqCst), 2);
        assert_eq!(
            call(
                &mut socket,
                12,
                "thread/read",
                json!({"threadId":source_id,"includeTurns":true})
            )
            .await["result"],
            source_before["result"]
        );
        eprintln!(
            "SCF_REPLAY_ACCEPTANCE protocol={protocol:?} actualSourceToolExecutions=2 capturedRequests=4 inheritedBatchCalls=2 inheritedBatchResults=2 ownUsageBeforeRequest=0 laterSentinelAbsent=true invalidAnchorNoTarget=true automaticProfileNoTarget=true"
        );
        stop.cancel();
        server.await.unwrap().unwrap();
        source_host.abort();
        let _ = source_host.await;
        engine.shutdown().await;
        http_server.abort();
        let _ = http_server.await;
    }
}
