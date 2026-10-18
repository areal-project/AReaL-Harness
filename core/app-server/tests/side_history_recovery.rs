use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelCapabilities, ModelStream},
};
use areal_protocol::Modality;
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::Message as Wire};
use tokio_util::sync::CancellationToken;

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
struct FixedModel(Arc<AtomicUsize>);
#[async_trait]
impl Model for FixedModel {
    fn configure(
        &self,
        _: &areal_protocol::desktop::ModelParameters,
    ) -> anyhow::Result<Arc<dyn Model>> {
        Ok(Arc::new(FixedModel(self.0.clone())))
    }
    fn name(&self) -> &str {
        "fixed"
    }
    fn capabilities(&self) -> ModelCapabilities {
        ModelCapabilities {
            context_window_tokens: None,
            max_output_tokens: None,
            summary_output_tokens: None,
            input: vec![Modality::Text],
            output: vec![Modality::Text],
        }
    }
    async fn stream(&self, messages: Vec<Message>) -> anyhow::Result<ModelStream> {
        self.0.fetch_add(1, Ordering::SeqCst);
        let input = messages
            .iter()
            .rev()
            .find(|message| message.role == "user")
            .map(Message::text_content)
            .unwrap_or_default();
        if input == "fixture fail" {
            anyhow::bail!("fixture model failure");
        }
        if input == "fixture wait" {
            return Ok(Box::pin(futures_util::stream::pending()));
        }
        if input == "fixture large" {
            return Ok(Box::pin(futures_util::stream::iter([Ok("x"
                .repeat(3 * 1024 * 1024)
                .into())])));
        }
        Ok(Box::pin(futures_util::stream::iter([Ok(
            "fixed answer".into()
        )])))
    }
}
struct Fixture {
    engine: Arc<Engine>,
    model_calls: Arc<AtomicUsize>,
    stop: CancellationToken,
    server: tokio::task::JoinHandle<anyhow::Result<()>>,
    addr: std::net::SocketAddr,
}
impl Fixture {
    async fn open(path: &Path, limits: Limits) -> Self {
        unsafe {
            std::env::set_var("AREAL_DEV_CONVERSATION_DERIVATION", "1");
        }
        let model_calls = Arc::new(AtomicUsize::new(0));
        let engine = Engine::open(path, Arc::new(FixedModel(model_calls.clone())), limits).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let stop = CancellationToken::new();
        let server = tokio::spawn(areal_app_server::serve(
            listener,
            engine.clone(),
            stop.clone(),
        ));
        Self {
            engine,
            model_calls,
            stop,
            server,
            addr,
        }
    }
    async fn socket(&self) -> Socket {
        let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{}", self.addr))
            .await
            .unwrap();
        let response = call(
            &mut socket,
            1,
            "initialize",
            json!({"clientInfo":{"name":"fork-edges","version":"1"}}),
        )
        .await;
        assert!(response.get("result").is_some(), "{response}");
        socket
            .send(Wire::Text(
                json!({"method":"initialized"}).to_string().into(),
            ))
            .await
            .unwrap();
        socket
    }
    async fn close(self) {
        self.stop.cancel();
        tokio::time::timeout(Duration::from_secs(10), self.server)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        self.engine.shutdown().await;
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
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let wire = socket.next().await.unwrap().unwrap();
            let value: Value = serde_json::from_str(wire.to_text().unwrap()).unwrap();
            if value["id"] == id {
                if method == "areal/conversation/history"
                    && let Some(result) = value.get("result")
                {
                    // 参考页、分片及空历史层都按公开响应契约验证。
                    static SCHEMA: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
                    let schema = SCHEMA.get_or_init(|| {
                        let schemas: Value = serde_json::from_str(include_str!(
                            "../../../schemas/areal-core-v1.json"
                        ))
                        .unwrap();
                        schemas["responses"]["areal/conversation/history"].clone()
                    });
                    assert!(
                        jsonschema::is_valid(schema, result),
                        "invalid history response: {result}"
                    );
                }
                return value;
            }
        }
    })
    .await
    .unwrap()
}
async fn source(socket: &mut Socket) -> String {
    let response = call(socket, 2, "thread/start", json!({"cwd":"/workspace"})).await;
    response["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned()
}
async fn turn(socket: &mut Socket, thread: &str, id: u64, text: &str) -> String {
    let response = call(
        socket,
        id,
        "turn/start",
        json!({"threadId":thread,"input":[{"type":"text","text":text}]}),
    )
    .await;
    assert!(response.get("result").is_some(), "{response}");
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let read = call(
                socket,
                id + 1000,
                "thread/read",
                json!({"threadId":thread,"includeTurns":true}),
            )
            .await;
            if let Some(last) = read["result"]["thread"]["turns"]
                .as_array()
                .and_then(|v| v.last())
                && last["status"] == "completed"
            {
                return last["id"].as_str().unwrap().to_owned();
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap()
}
fn fork_params(source: &str, anchor: &str, key: &str) -> Value {
    json!({"requestId":key,"sourceThreadId":source,
        "anchor":{"turnId":anchor,"boundary":"after"},"workspaceMode":"sharedCurrent"})
}
async fn close_socket(mut socket: Socket) {
    socket.close(None).await.unwrap();
}
fn record_path(path: &Path, id: &str) -> std::path::PathBuf {
    path.join(format!("{id}.json"))
}

fn side_params(source: &str, key: &str) -> Value {
    json!({"requestId":key,"sourceThreadId":source,"workspaceAccess":"none",
        "input":[{"type":"text","text":"first question"}]})
}

#[tokio::test]
async fn side_creation_replay_survives_archive_restart_and_legacy_receipt() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = Fixture::open(dir.path(), Limits::default()).await;
    let mut socket = fixture.socket().await;
    let source = source(&mut socket).await;
    turn(&mut socket, &source, 3, "source evidence").await;
    let params = side_params(&source, "recover-side");
    let created = call(&mut socket, 4, "areal/side/start", params.clone()).await;
    assert!(created.get("result").is_some(), "{created}");
    let side = created["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let first = created["result"]["turn"]["id"].clone();
    fixture.engine.wait(&side).await.unwrap();
    turn(&mut socket, &side, 5, "later question").await;
    let archived = call(
        &mut socket,
        6,
        "areal/thread/archive",
        json!({"threadId":side}),
    )
    .await;
    assert!(archived.get("result").is_some(), "{archived}");
    let replay = call(&mut socket, 7, "areal/side/start", params.clone()).await;
    assert_eq!(replay["result"]["turn"]["id"], first, "{replay}");
    close_socket(socket).await;
    fixture.close().await;
    for legacy in [false, true] {
        let path = record_path(dir.path(), &side);
        let mut record: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(record["thread"]["desktop"]["archived"], true);
        if legacy {
            record["thread"]["desktop"]["receipts"][0]["result"]
                .as_object_mut()
                .unwrap()
                .remove("turnId");
            std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        } else {
            assert_eq!(
                record["thread"]["desktop"]["receipts"][0]["result"]["turnId"],
                first
            );
        }
        let before = std::fs::read(&path).unwrap();
        let fixture = Fixture::open(dir.path(), Limits::default()).await;
        let mut socket = fixture.socket().await;
        let replay = call(&mut socket, 8, "areal/side/start", params.clone()).await;
        assert_eq!(replay["result"]["turn"]["id"], first, "{replay}");
        assert_eq!(replay["result"]["thread"]["id"], side);
        assert_eq!(std::fs::read(&path).unwrap(), before);
        close_socket(socket).await;
        fixture.close().await;
    }
}

#[tokio::test]
async fn reference_history_is_immutable_bounded_and_cursor_scoped() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = Fixture::open(dir.path(), Limits::default()).await;
    let mut socket = fixture.socket().await;
    let source = source(&mut socket).await;
    let text = format!("FROZEN {}", "中\"\n".repeat(1500));
    let anchor = turn(&mut socket, &source, 3, &text).await;
    let mut sides = Vec::new();
    for n in 0..2 {
        let created = call(
            &mut socket,
            4 + n,
            "areal/side/start",
            side_params(&source, &format!("side-{n}")),
        )
        .await;
        assert!(created.get("result").is_some(), "{created}");
        let side = created["result"]["thread"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        fixture.engine.wait(&side).await.unwrap();
        sides.push(side);
    }
    let fork = call(
        &mut socket,
        7,
        "areal/thread/fork",
        fork_params(&source, &anchor, "same-snapshot"),
    )
    .await;
    let fork_id = fork["result"]["thread"]["id"].as_str().unwrap();
    turn(&mut socket, &source, 8, "LATER_ONLY").await;
    let first = call(
        &mut socket,
        9,
        "areal/conversation/history",
        json!({"threadId":sides[0],"view":"reference","maxBytes":1024}),
    )
    .await;
    assert!(first.get("result").is_some(), "{first}");
    let cursor = first["result"]["nextCursor"].clone();
    assert!(cursor.is_string(), "{first}");
    // 合法游标本身不授予跨身份的目标读取权限。
    use areal_app_server::auth::{Authentication, Permission, Principal};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let token = "reference-outsider-token-123456789012345";
    let auth = Authentication {
        version: 1,
        principals: vec![Principal {
            id: "outsider".into(),
            token: token.into(),
            permissions: [Permission::Observe].into(),
            thread_ids: Some([source.clone()].into()),
        }],
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let auth_stop = CancellationToken::new();
    let auth_server = tokio::spawn(areal_app_server::serve_authenticated(
        listener,
        fixture.engine.clone(),
        auth_stop.clone(),
        Some(auth),
    ));
    let mut request = format!("ws://{addr}").into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Authorization", format!("Bearer {token}").parse().unwrap());
    let (mut outsider, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    call(
        &mut outsider,
        1,
        "initialize",
        json!({"clientInfo":{"name":"outsider","version":"1"}}),
    )
    .await;
    outsider
        .send(Wire::Text(
            json!({"method":"initialized"}).to_string().into(),
        ))
        .await
        .unwrap();
    let denied = call(
        &mut outsider,
        2,
        "areal/conversation/history",
        json!({"threadId":sides[0],"view":"reference","cursor":cursor,"maxBytes":1024}),
    )
    .await;
    assert_eq!(denied["error"]["code"], -32003, "{denied}");
    assert!(denied.get("result").is_none());
    close_socket(outsider).await;
    auth_stop.cancel();
    auth_server.await.unwrap().unwrap();

    for (target, view) in [
        (&sides[1], "reference"),
        (&sides[0], "inherited"),
        (&fork_id.to_owned(), "inherited"),
    ] {
        let rejected = call(
            &mut socket,
            10,
            "areal/conversation/history",
            json!({"threadId":target,"view":view,"cursor":cursor,"maxBytes":1024}),
        )
        .await;
        assert!(rejected.get("error").is_some(), "{rejected}");
    }
    let empty = call(
        &mut socket,
        11,
        "areal/conversation/history",
        json!({"threadId":sides[0],"view":"inherited"}),
    )
    .await;
    assert_eq!(empty["result"]["data"], json!([]), "{empty}");
    let mut page = first["result"].clone();
    let mut content = String::new();
    loop {
        assert!(serde_json::to_vec(&page).unwrap().len() <= 1024);
        for entry in page["data"].as_array().unwrap() {
            assert_eq!(entry["sourceThreadId"], source);
            if let Some(part) = entry["fragment"]["text"].as_str() {
                content.push_str(part);
            } else {
                content.push_str(&entry.to_string());
            }
        }
        if page["complete"] == true {
            break;
        }
        page = call(&mut socket, 12, "areal/conversation/history", json!({"threadId":sides[0],"view":"reference","cursor":page["nextCursor"],"maxBytes":1024})).await["result"].clone();
    }
    assert!(content.contains("FROZEN"));
    assert!(!content.contains("LATER_ONLY"));
    assert!(content.contains(&serde_json::to_string(&text).unwrap()));
    close_socket(socket).await;
    fixture.close().await;
}

#[tokio::test]
async fn side_lost_creation_response_reconciles_without_second_model_call() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = Fixture::open(dir.path(), Limits::default()).await;
    let mut first_socket = fixture.socket().await;
    let source = source(&mut first_socket).await;
    let params = side_params(&source, "lost-side-reply");
    // 首连接发送后不消费回复；另一连接观察已提交收据，随后丢弃首连接。
    first_socket
        .send(Wire::Text(
            json!({"id":3,"method":"areal/side/start","params":params})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let mut observer = fixture.socket().await;
    let receipt = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let reply = call(
                &mut observer,
                4,
                "areal/request/read",
                json!({"requestId":"lost-side-reply"}),
            )
            .await;
            if reply["result"]["data"]
                .as_array()
                .is_some_and(|items| !items.is_empty())
            {
                break reply["result"]["data"][0]["result"].clone();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    drop(first_socket);
    let id = receipt["threadId"].as_str().unwrap();
    fixture.engine.wait(id).await.unwrap();
    assert_eq!(fixture.model_calls.load(Ordering::SeqCst), 1);
    for attempt in 0..2 {
        let mut reconnected = fixture.socket().await;
        let replay = call(
            &mut reconnected,
            10 + attempt,
            "areal/side/start",
            params.clone(),
        )
        .await;
        assert_eq!(
            replay["result"]["thread"]["id"], receipt["threadId"],
            "{replay}"
        );
        assert_eq!(
            replay["result"]["turn"]["id"], receipt["turnId"],
            "{replay}"
        );
        close_socket(reconnected).await;
    }
    let listed = call(
        &mut observer,
        20,
        "areal/conversation/list",
        json!({"view":"side","sourceThreadId":source}),
    )
    .await;
    assert_eq!(listed["result"]["data"].as_array().unwrap().len(), 1);
    let read = call(
        &mut observer,
        21,
        "thread/read",
        json!({"threadId":id,"includeTurns":true}),
    )
    .await;
    assert_eq!(
        read["result"]["thread"]["turns"].as_array().unwrap().len(),
        1
    );
    assert_eq!(fixture.model_calls.load(Ordering::SeqCst), 1);
    close_socket(observer).await;
    fixture.close().await;
}

#[tokio::test]
async fn side_after_accepts_failed_and_interrupted_but_rejects_active() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = Fixture::open(dir.path(), Limits::default()).await;
    let mut socket = fixture.socket().await;
    let source = source(&mut socket).await;
    for (index, (text, expected)) in [("fixture fail", "failed"), ("fixture wait", "interrupted")]
        .into_iter()
        .enumerate()
    {
        let started = call(
            &mut socket,
            10,
            "turn/start",
            json!({"threadId":source,"input":[{"type":"text","text":text}]}),
        )
        .await;
        let turn_id = started["result"]["turn"]["id"].as_str().unwrap();
        let mut params = side_params(&source, &format!("terminal-side-{index}"));
        params["anchor"] = json!({"kind":"turn","turnId":turn_id,"boundary":"after"});
        if expected == "interrupted" {
            let denied = call(&mut socket, 11, "areal/side/start", params.clone()).await;
            assert_eq!(
                denied["error"]["data"]["reason"], "TURN_NOT_TERMINAL",
                "{denied}"
            );
            let stopped = call(
                &mut socket,
                12,
                "turn/interrupt",
                json!({"threadId":source,"turnId":turn_id}),
            )
            .await;
            assert!(stopped["error"].is_null(), "{stopped}");
        }
        fixture.engine.wait(&source).await.unwrap();
        let read = call(
            &mut socket,
            13,
            "thread/read",
            json!({"threadId":source,"includeTurns":true}),
        )
        .await;
        assert_eq!(
            read["result"]["thread"]["turns"]
                .as_array()
                .unwrap()
                .last()
                .unwrap()["status"],
            expected
        );
        let side = call(&mut socket, 14, "areal/side/start", params).await;
        assert!(side["result"].is_object(), "{side}");
        let side_id = side["result"]["thread"]["id"].as_str().unwrap();
        fixture.engine.wait(side_id).await.unwrap();
        let history = call(
            &mut socket,
            15,
            "areal/conversation/history",
            json!({"threadId":side_id,"view":"reference"}),
        )
        .await;
        assert!(history["result"]["data"].as_array().unwrap().iter().any(|item| item["sourceTurnId"] == turn_id && item["sourceTurnStatus"] == expected), "{history}");
    }
    close_socket(socket).await;
    fixture.close().await;
}

#[tokio::test]
async fn derivation_replay_returns_bounded_summaries_without_execution() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = Fixture::open(dir.path(), Limits::default()).await;
    let mut socket = fixture.socket().await;
    let source = source(&mut socket).await;
    let anchor = turn(&mut socket, &source, 3, "source evidence").await;
    let mut params = side_params(&source, "large-side");
    params["input"] = json!([{"type":"text","text":"fixture large"}]);
    let created = call(&mut socket, 4, "areal/side/start", params.clone()).await;
    let side = created["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let first = created["result"]["turn"]["id"].clone();
    fixture.engine.wait(&side).await.unwrap();
    let calls = fixture.model_calls.load(Ordering::SeqCst);
    let replay = call(&mut socket, 5, "areal/side/start", params).await;
    assert_eq!(replay["result"]["thread"]["id"], side);
    assert_eq!(replay["result"]["turn"]["id"], first);
    assert!(serde_json::to_vec(&replay).unwrap().len() < areal_protocol::MAX_FRAME_BYTES);
    assert_eq!(replay["result"]["thread"]["turns"], json!([]));
    assert_eq!(replay["result"]["turn"]["items"], json!([]));
    assert_eq!(fixture.model_calls.load(Ordering::SeqCst), calls);
    assert!(
        fixture.engine.read(&side, true).await.unwrap().turns[0]
            .items
            .iter()
            .any(|item| serde_json::to_vec(item).unwrap().len() >= 3 * 1024 * 1024)
    );
    let params = fork_params(&source, &anchor, "large-fork");
    let created = call(&mut socket, 6, "areal/thread/fork", params.clone()).await;
    let fork = created["result"]["thread"]["id"].as_str().unwrap();
    for _ in 0..2 {
        fixture
            .engine
            .start(fork, vec![areal_protocol::Input::text("fixture large")])
            .await
            .unwrap();
        fixture.engine.wait(fork).await.unwrap();
    }
    let calls = fixture.model_calls.load(Ordering::SeqCst);
    let replay = call(&mut socket, 7, "areal/thread/fork", params).await;
    assert_eq!(replay["result"]["thread"]["id"], fork);
    assert_eq!(replay["result"]["thread"]["turns"], json!([]));
    assert!(serde_json::to_vec(&replay).unwrap().len() < areal_protocol::MAX_FRAME_BYTES);
    assert_eq!(fixture.model_calls.load(Ordering::SeqCst), calls);
    assert_eq!(
        fixture.engine.read(fork, true).await.unwrap().turns.len(),
        2
    );
    close_socket(socket).await;
    fixture.close().await;
}
