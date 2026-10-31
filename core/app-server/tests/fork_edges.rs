use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelCapabilities, ModelStream},
};
use areal_protocol::Modality;
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{collections::HashSet, path::Path, sync::Arc, time::Duration};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::Message as Wire};
use tokio_util::sync::CancellationToken;

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
struct FixedModel;
#[async_trait]
impl Model for FixedModel {
    fn name(&self) -> &str {
        "fixed"
    }
    fn capabilities(&self) -> ModelCapabilities {
        ModelCapabilities {
            declared: None,
            context_window: None,
            context_window_tokens: None,
            max_output_tokens: None,
            summary_output_tokens: None,
            input: vec![Modality::Text],
            output: vec![Modality::Text],
        }
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        Ok(Box::pin(futures_util::stream::iter([Ok(
            "fixed answer".into()
        )])))
    }
}
struct Fixture {
    engine: Arc<Engine>,
    stop: CancellationToken,
    server: tokio::task::JoinHandle<anyhow::Result<()>>,
    addr: std::net::SocketAddr,
}
impl Fixture {
    async fn open(path: &Path, limits: Limits) -> Self {
        unsafe {
            std::env::set_var("AREAL_DEV_CONVERSATION_DERIVATION", "1");
        }
        let engine = Engine::open(path, Arc::new(FixedModel), limits).unwrap();
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

#[tokio::test]
async fn fresh_same_key_race_creates_one_target_while_source_advances() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = Fixture::open(dir.path(), Limits::default()).await;
    let mut left = fixture.socket().await;
    let mut right = fixture.socket().await;
    let mut progress = fixture.socket().await;
    let source = source(&mut left).await;
    let anchor = turn(&mut left, &source, 3, "stable anchor").await;
    let params = fork_params(&source, &anchor, "fresh-race");
    // 两条连接首次同时提交同一业务键，来源还可独立继续推进。
    let (a, b, later) = tokio::join!(
        call(&mut left, 10, "areal/thread/fork", params.clone()),
        call(&mut right, 11, "areal/thread/fork", params.clone()),
        turn(&mut progress, &source, 12, "LATER_ONLY")
    );
    assert!(
        a.get("result").is_some() && b.get("result").is_some(),
        "{a} {b}"
    );
    let target = a["result"]["thread"]["id"].as_str().unwrap();
    assert_eq!(b["result"]["thread"]["id"], target);
    assert_ne!(anchor, later);
    let history = call(
        &mut left,
        13,
        "areal/conversation/history",
        json!({"threadId":target,"view":"inherited"}),
    )
    .await;
    assert!(
        history["result"]["data"]
            .to_string()
            .contains("stable anchor")
    );
    assert!(!history["result"]["data"].to_string().contains("LATER_ONLY"));
    let receipt = call(
        &mut right,
        14,
        "areal/request/read",
        json!({"requestId":"fresh-race"}),
    )
    .await;
    assert_eq!(receipt["result"]["data"].as_array().unwrap().len(), 1);
    assert_eq!(receipt["result"]["data"][0]["result"]["threadId"], target);
    let list = call(&mut left, 15, "thread/list", json!({"limit":100})).await;
    assert_eq!(
        list["result"]["data"].as_array().unwrap().len(),
        2,
        "{list}"
    );
    close_socket(left).await;
    close_socket(right).await;
    close_socket(progress).await;
    fixture.close().await;
}

#[tokio::test]
async fn corrupted_cold_segment_refuses_fork_without_creating_target() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = Fixture::open(dir.path(), Limits::default()).await;
    let mut socket = fixture.socket().await;
    let source = source(&mut socket).await;
    let anchor = turn(
        &mut socket,
        &source,
        3,
        &format!("COLD_ANCHOR {}", "x".repeat(9000)),
    )
    .await;
    let mut last_anchor = anchor.clone();
    for n in 0..4 {
        last_anchor = turn(
            &mut socket,
            &source,
            10 + n,
            &format!("filler-{n} {}", "y".repeat(9000)),
        )
        .await;
    }
    let compact = call(
        &mut socket,
        20,
        "areal/context/compact",
        json!({"threadId":source}),
    )
    .await;
    assert!(compact.get("result").is_some(), "{compact}");
    let record: Value =
        serde_json::from_slice(&std::fs::read(record_path(dir.path(), &source)).unwrap()).unwrap();
    let head = record["thread"]["historyArchive"]["head"]
        .as_str()
        .expect("fixture must archive cold turns");
    let cold: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("history").join(head)).unwrap())
            .unwrap();
    let cold_turns: HashSet<_> = cold["turns"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|turn| turn["id"].as_str())
        .collect();
    assert!(
        record["thread"]["turns"]
            .as_array()
            .unwrap()
            .iter()
            .any(|turn| turn["id"]
                .as_str()
                .is_some_and(|id| cold_turns.contains(id))),
        "fixture must split a Turn across cold and hot history"
    );
    let original = call(
        &mut socket,
        19,
        "thread/read",
        json!({"threadId":source,"includeTurns":true}),
    )
    .await;
    let expected: Vec<_> = original["result"]["thread"]["turns"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|turn| {
            turn["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["id"].clone())
        })
        .collect();
    let fork = call(
        &mut socket,
        23,
        "areal/thread/fork",
        fork_params(&source, &last_anchor, "split-valid"),
    )
    .await;
    assert!(fork.get("result").is_some(), "{fork}");
    let target = fork["result"]["thread"]["id"].as_str().unwrap();
    let mut cursor = Value::Null;
    let mut actual = Vec::new();
    loop {
        let page = call(
            &mut socket,
            24,
            "areal/conversation/history",
            json!({"threadId":target,"view":"inherited","cursor":cursor,"maxBytes":16000}),
        )
        .await;
        assert!(page.get("result").is_some(), "{page}");
        actual.extend(
            page["result"]["data"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["sourceItemId"].clone()),
        );
        cursor = page["result"]["nextCursor"].clone();
        if cursor.is_null() {
            break;
        }
    }
    assert_eq!(actual, expected);
    assert_eq!(actual.iter().collect::<HashSet<_>>().len(), actual.len());
    std::fs::write(
        dir.path().join("history").join(head),
        b"corrupted cold segment",
    )
    .unwrap();
    let refused = call(
        &mut socket,
        21,
        "areal/thread/fork",
        fork_params(&source, &anchor, "corrupt-cold"),
    )
    .await;
    assert!(refused.get("error").is_some(), "{refused}");
    let lookup = call(
        &mut socket,
        22,
        "areal/request/read",
        json!({"requestId":"corrupt-cold"}),
    )
    .await;
    assert!(
        lookup["result"]["data"].as_array().unwrap().is_empty(),
        "{lookup}"
    );
    assert_eq!(
        std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().is_some_and(|e| e == "json"))
            .count(),
        2
    );
    close_socket(socket).await;
    fixture.close().await;
}

#[tokio::test]
async fn unknown_persisted_conversation_kind_fails_closed_at_open() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = Fixture::open(dir.path(), Limits::default()).await;
    let mut socket = fixture.socket().await;
    let id = source(&mut socket).await;
    close_socket(socket).await;
    fixture.close().await;
    let path = record_path(dir.path(), &id);
    let mut record: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(record["version"], areal_engine::state_version());
    record["thread"]["conversation"] = json!({"kind":"futureRestrictedRole","version":1});
    std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    assert!(Engine::open(dir.path(), Arc::new(FixedModel), Limits::default()).is_err());
}

#[tokio::test]
async fn snapshot_over_limit_refuses_fork_and_leaves_no_target() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = Fixture::open(dir.path(), Limits::default()).await;
    let mut socket = fixture.socket().await;
    let source = source(&mut socket).await;
    let mut anchor = String::new();
    // 多个短轮次使快照的逐轮来源标记超过原记录额外开销。
    for n in 0..80 {
        anchor = turn(&mut socket, &source, 100 + n, &format!("short-{n}")).await;
    }
    let path = record_path(dir.path(), &source);
    let record: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let turns = record["thread"]["turns"].as_array().unwrap();
    let estimated_snapshot_bytes = serde_json::to_vec(&json!({
        "version":1,"previous":null,"turns":turns,
        "source_thread_ids":vec![source.clone(); turns.len()]
    }))
    .unwrap()
    .len();
    let record_bytes = std::fs::metadata(&path).unwrap().len() as usize;
    assert!(
        estimated_snapshot_bytes > record_bytes + 100,
        "fixture must put snapshot above the source record: {estimated_snapshot_bytes} <= {record_bytes}"
    );
    close_socket(socket).await;
    fixture.close().await;
    let limits = Limits {
        max_history_bytes: record_bytes + 100,
        ..Limits::default()
    };
    let fixture = Fixture::open(dir.path(), limits).await;
    let mut socket = fixture.socket().await;
    let refused = call(
        &mut socket,
        250,
        "areal/thread/fork",
        fork_params(&source, &anchor, "over-limit"),
    )
    .await;
    assert_eq!(
        refused["error"]["data"]["reason"], "HISTORY_LIMIT_EXCEEDED",
        "{refused}"
    );
    let lookup = call(
        &mut socket,
        251,
        "areal/request/read",
        json!({"requestId":"over-limit"}),
    )
    .await;
    assert!(
        lookup["result"]["data"].as_array().unwrap().is_empty(),
        "{lookup}"
    );
    let list = call(&mut socket, 252, "thread/list", json!({"limit":100})).await;
    assert_eq!(list["result"]["data"].as_array().unwrap().len(), 1);
    close_socket(socket).await;
    fixture.close().await;
}

#[tokio::test]
async fn full_target_receipt_ledger_refuses_new_mutation_but_keeps_creation_key() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = Fixture::open(dir.path(), Limits::default()).await;
    let mut socket = fixture.socket().await;
    let source = source(&mut socket).await;
    let anchor = turn(&mut socket, &source, 3, "receipt origin").await;
    let params = fork_params(&source, &anchor, "retained-create-key");
    let fork = call(&mut socket, 4, "areal/thread/fork", params.clone()).await;
    let target = fork["result"]["thread"]["id"].as_str().unwrap().to_owned();
    close_socket(socket).await;
    fixture.close().await;
    let path = record_path(dir.path(), &target);
    let mut record: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let receipts = record["thread"]["desktop"]["receipts"]
        .as_array_mut()
        .unwrap();
    assert_eq!(receipts.len(), 1);
    // 持久容量夹具只填入旧收据；真实创建键及目标仍由 RPC 产生。
    for n in 1..1024 {
        receipts.push(
            json!({"identity":"trusted-embedded-host","requestId":format!("old-{n}"),
            "method":"areal/turn/start","digest":"existing","result":{}}),
        );
    }
    std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    let fixture = Fixture::open(dir.path(), Limits::default()).await;
    let mut socket = fixture.socket().await;
    let old = call(
        &mut socket,
        5,
        "areal/request/read",
        json!({"requestId":"retained-create-key"}),
    )
    .await;
    assert_eq!(old["result"]["data"][0]["result"]["threadId"], target);
    let repeat = call(&mut socket, 6, "areal/thread/fork", params).await;
    assert_eq!(repeat["result"]["thread"]["id"], target);
    let refused = call(
        &mut socket,
        7,
        "areal/turn/start",
        json!({
            "requestId":"new-after-full","threadId":target,
            "input":[{"type":"text","text":"should not start"}]
        }),
    )
    .await;
    assert!(refused.get("error").is_some(), "{refused}");
    let read = call(
        &mut socket,
        8,
        "thread/read",
        json!({"threadId":target,"includeTurns":true}),
    )
    .await;
    assert!(
        read["result"]["thread"]["turns"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let old_again = call(
        &mut socket,
        9,
        "areal/request/read",
        json!({"requestId":"retained-create-key"}),
    )
    .await;
    assert_eq!(old_again["result"]["data"][0]["result"]["threadId"], target);
    close_socket(socket).await;
    fixture.close().await;
}
