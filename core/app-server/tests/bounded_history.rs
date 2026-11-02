use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelEvent, ModelStream, ReasoningKind},
};
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::Message as Wire};
use tokio_util::sync::CancellationToken;

struct IdleModel;
#[async_trait]
impl Model for IdleModel {
    fn name(&self) -> &str {
        "bounded-history-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        Ok(Box::pin(futures_util::stream::empty()))
    }
}
type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
struct Running {
    engine: Arc<Engine>,
    url: String,
    socket: Socket,
    stop: CancellationToken,
    server: tokio::task::JoinHandle<anyhow::Result<()>>,
}
impl Running {
    async fn open(path: &std::path::Path) -> Self {
        let engine = Engine::open(path, Arc::new(IdleModel), Limits::default()).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let stop = CancellationToken::new();
        let server = tokio::spawn(areal_app_server::serve(
            listener,
            engine.clone(),
            stop.clone(),
        ));
        let url = format!("ws://{addr}");
        let (socket, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        let mut running = Self {
            engine,
            url,
            socket,
            stop,
            server,
        };
        let initialized = running
            .call(
                "initialize",
                json!({"clientInfo":{"name":"bounded-test","version":"1"}}),
                None,
            )
            .await;
        assert!(initialized.get("error").is_none(), "{initialized}");
        running
            .socket
            .send(Wire::Text(
                json!({"method":"initialized"}).to_string().into(),
            ))
            .await
            .unwrap();
        running
    }
    async fn call(&mut self, method: &str, params: Value, budget: Option<usize>) -> Value {
        let id = "bounded-history-rpc-请求-\\\"".repeat(12);
        self.socket
            .send(Wire::Text(
                json!({"id":id,"method":method,"params":params})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        loop {
            let wire = tokio::time::timeout(Duration::from_secs(10), self.socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let text = wire.to_text().unwrap();
            let reply: Value = serde_json::from_str(text).unwrap();
            if reply["id"] != id {
                continue;
            }
            if let Some(max) = budget {
                assert!(
                    text.len() <= max,
                    "whole RPC response {} > {}",
                    text.len(),
                    max
                );
            }
            if let Some(result) = reply.get("result")
                && matches!(
                    method,
                    "areal/thread/observe" | "thread/resume" | "areal/conversation/history"
                )
            {
                static SCHEMAS: std::sync::OnceLock<BTreeMap<String, jsonschema::Validator>> =
                    std::sync::OnceLock::new();
                let schemas = SCHEMAS.get_or_init(|| {
                    let schema: Value =
                        serde_json::from_str(include_str!("../../../schemas/areal-core-v1.json"))
                            .unwrap();
                    [
                        "areal/thread/observe",
                        "thread/resume",
                        "areal/conversation/history",
                    ]
                    .into_iter()
                    .map(|name| {
                        (
                            name.into(),
                            jsonschema::validator_for(&schema["responses"][name]).unwrap(),
                        )
                    })
                    .collect()
                });
                let errors: Vec<_> = schemas[method]
                    .iter_errors(result)
                    .map(|error| error.instance_path.to_string())
                    .collect();
                assert!(
                    errors.is_empty(),
                    "{method} response violates published schema at {errors:?}"
                );
            }
            return reply;
        }
    }
    async fn close(mut self) {
        self.socket.close(None).await.unwrap();
        self.stop.cancel();
        self.server.await.unwrap().unwrap();
        self.engine.shutdown().await;
    }
}

fn turn(n: usize, text: String) -> Value {
    json!({"id":format!("turn-{n}"),"status":"completed","items":[
        {"id":format!("user-{n}"),"type":"userMessage","content":[{"type":"text","text":format!("question {n}")}]},
        {"id":format!("answer-{n}"),"type":"agentMessage","text":text}
    ]})
}
async fn fixture(path: &std::path::Path, archived: bool) -> (String, Vec<Value>) {
    let engine = Engine::open(path, Arc::new(IdleModel), Limits::default()).unwrap();
    let thread = engine.create("/bounded-fixture".into()).await.unwrap();
    engine.shutdown().await;
    drop(engine);
    let record_path = path.join(format!("{}.json", thread.id));
    let mut record: Value = serde_json::from_slice(&std::fs::read(&record_path).unwrap()).unwrap();
    let turns: Vec<Value> = (0..30)
        .map(|n| {
            turn(
                n,
                if n == 29 {
                    "引号\"反斜线\\\n🦀".repeat(20000)
                } else {
                    format!("answer {n} ").repeat(160)
                },
            )
        })
        .collect();
    std::fs::create_dir_all(path.join("history")).unwrap();
    let mut previous = Value::Null;
    for end in [10, 20] {
        let segment = json!({"version":1,"previous":previous,"turns":turns[end-10..end]});
        let bytes = serde_json::to_vec(&segment).unwrap();
        let head = format!("{:x}", Sha256::digest(&bytes));
        std::fs::write(path.join("history").join(&head), &bytes).unwrap();
        previous = json!({"head":head,"throughItemId":format!("answer-{}",end-1),"completedTurns":end,"items":end*2,"bytes":bytes.len()});
    }
    record["thread"]["turns"] = json!(turns[20..]);
    record["thread"]["historyArchive"] = previous;
    record["thread"]["desktop"] =
        serde_json::to_value(areal_protocol::desktop::DesktopState::default()).unwrap();
    record["thread"]["desktop"]["archived"] = json!(archived);
    record["thread"]["desktop"]["configuration"]["options"]["appendInstructions"] =
        json!("metadata".repeat(400));
    record["thread"]["desktop"]["receipts"] = json!([{"identity":"owner","requestId":"old","method":"areal/turn/submit","digest":"fixture","result":{"escaped":"\"\\\n".repeat(800)}}]);
    record["thread"]["desktop"]["queue"] = json!({"revision":1,"paused":true,"pauseReason":null,"items":[{
        "id":"settled-queue-item","input":[{"type":"text","text":"retained queue metadata".repeat(16)}],
        "configuration":record["thread"]["desktop"]["configuration"],"submittedBy":"owner","status":"completed","turnId":"turn-0"
    }]});
    record["thread"]["desktop"]["interactions"] = json!([{
        "requestId":"settled-interaction","threadId":thread.id,"turnId":"turn-0","callId":"call","kind":"question","status":"completed","expiresAt":0,
        "questions":[],"tool":null,"generation":null,"effectivePermissions":null,"effectiveArguments":{"evidence":"\\\"\n".repeat(100)},"argumentsDigest":null,"response":null
    }]);
    std::fs::write(record_path, serde_json::to_vec(&record).unwrap()).unwrap();
    (thread.id, turns)
}
fn item_map(turns: &[Value]) -> BTreeMap<String, Value> {
    turns
        .iter()
        .flat_map(|t| t["items"].as_array().unwrap())
        .map(|i| {
            (
                i["id"].as_str().unwrap().into(),
                serde_json::to_value(
                    serde_json::from_value::<areal_protocol::Item>(i.clone()).unwrap(),
                )
                .unwrap(),
            )
        })
        .collect()
}

#[tokio::test]
async fn bounded_observation_and_own_history_reassemble_escaped_oversize_across_segments_and_archive()
 {
    for archived in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (id, mut original) = fixture(dir.path(), archived).await;
        original[28]["status"] = json!("interrupted");
        original[28]["interruption"] = json!("userPause");
        original[29]["status"] = json!("interrupted");
        original[29]["interruption"] = json!("coreRecovery");
        original[29]["continuedFromTurnId"] = json!("turn-28");
        let record_path = dir.path().join(format!("{id}.json"));
        let mut record: Value =
            serde_json::from_slice(&std::fs::read(&record_path).unwrap()).unwrap();
        record["thread"]["turns"] = json!(original[20..]);
        std::fs::write(record_path, serde_json::to_vec(&record).unwrap()).unwrap();
        let assert_turn_metadata = |projected: &Value| {
            let source = original
                .iter()
                .find(|turn| turn["id"] == projected["id"])
                .unwrap();
            for field in ["interruption", "continuedFromTurnId"] {
                assert_eq!(
                    projected[field], source[field],
                    "{} loses {field}",
                    projected["id"]
                );
            }
        };
        let expected = item_map(&original);
        let mut running = Running::open(dir.path()).await;
        let max = 16 * 1024;
        let oldest = std::fs::read_dir(dir.path().join("history"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|path| {
                let value: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
                value["previous"].is_null()
            })
            .unwrap();
        let hidden = oldest.with_extension("temporarily-unavailable");
        std::fs::rename(&oldest, &hidden).unwrap();
        let reply = running
            .call(
                "areal/thread/observe",
                json!({"threadId":id,"mode":"bounded","maxBytes":max}),
                Some(max),
            )
            .await;
        std::fs::rename(hidden, oldest).unwrap();
        assert!(
            reply.get("error").is_none(),
            "bounded observation must succeed: {reply}"
        );
        assert_eq!(reply["result"]["thread"]["desktop"]["receipts"], json!([]));
        assert_eq!(reply["result"]["ownership"]["kind"], "ordinary");
        let result = &reply["result"];
        for turn in result["thread"]["turns"].as_array().unwrap() {
            assert_turn_metadata(turn);
        }
        assert_eq!(
            result["thread"]["desktop"]["queue"]["items"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            result["thread"]["desktop"]["interactions"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let mut ordered_ids: Vec<String> = result["thread"]["turns"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|t| t["items"].as_array().unwrap())
            .map(|i| i["id"].as_str().unwrap().into())
            .collect();
        let mut found: BTreeMap<String, Value> = BTreeMap::new();
        let mut deferred = Vec::new();
        for item in result["thread"]["turns"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|t| t["items"].as_array().unwrap())
        {
            if item["type"] == "historyDeferred" {
                deferred.push(item.clone());
            } else {
                assert!(
                    found
                        .insert(item["id"].as_str().unwrap().into(), item.clone())
                        .is_none()
                );
            }
        }
        assert!(
            !deferred.is_empty(),
            "oversize latest item must have an ordered typed placeholder"
        );
        for item in deferred {
            let mut cursor = item["cursor"].as_str().unwrap().to_owned();
            let mut text = String::new();
            loop {
                let page = running
                    .call(
                        "areal/conversation/history",
                        json!({"threadId":id,"view":"own","cursor":cursor,"maxBytes":max}),
                        Some(max),
                    )
                    .await;
                assert!(page.get("error").is_none(), "{page}");
                let entry = &page["result"]["data"][0];
                assert_eq!(entry["fragment"]["version"], item["version"]);
                assert_eq!(
                    entry["fragment"]["offsetUtf8"].as_u64().unwrap() as usize,
                    text.len()
                );
                text.push_str(entry["fragment"]["text"].as_str().unwrap());
                if text.len() == entry["fragment"]["totalBytes"].as_u64().unwrap() as usize {
                    break;
                }
                cursor = page["result"]["nextCursor"].as_str().unwrap().into();
            }
            let entry: Value = serde_json::from_str(&text).unwrap();
            assert_turn_metadata(&entry["turn"]);
            assert!(
                found
                    .insert(item["id"].as_str().unwrap().into(), entry["item"].clone())
                    .is_none()
            );
        }
        let mut cursor = result["history"]["nextCursor"].as_str().map(str::to_owned);
        while let Some(next) = cursor {
            let page = running
                .call(
                    "areal/conversation/history",
                    json!({"threadId":id,"view":"own","cursor":next,"maxBytes":max}),
                    Some(max),
                )
                .await;
            assert!(page.get("error").is_none(), "{page}");
            let mut older_ids: Vec<String> = page["result"]["data"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| e["sourceItemId"].as_str().unwrap().into())
                .collect();
            older_ids.extend(ordered_ids);
            ordered_ids = older_ids;
            let mut last_turn = Value::Null;
            for entry in page["result"]["data"].as_array().unwrap() {
                if entry["sourceTurnId"] != last_turn {
                    assert_turn_metadata(&entry["turn"]);
                    last_turn = entry["sourceTurnId"].clone();
                } else {
                    assert_eq!(
                        entry["turn"],
                        json!({"id":last_turn,"status":entry["sourceTurnStatus"]})
                    );
                }
                assert!(
                    entry.get("fragment").is_none(),
                    "ordinary small older items fit page"
                );
                assert!(
                    found
                        .insert(
                            entry["sourceItemId"].as_str().unwrap().into(),
                            entry["item"].clone()
                        )
                        .is_none(),
                    "duplicated item"
                );
            }
            cursor = page["result"]["nextCursor"].as_str().map(str::to_owned);
        }
        assert_eq!(
            found.keys().collect::<Vec<_>>(),
            expected.keys().collect::<Vec<_>>()
        );
        let original_ids: Vec<String> = original
            .iter()
            .flat_map(|t| t["items"].as_array().unwrap())
            .map(|i| i["id"].as_str().unwrap().into())
            .collect();
        assert_eq!(ordered_ids, original_ids);
        for (id, item) in &expected {
            assert!(found[id] == *item, "item content differs for {id}");
        }
        running.close().await;
    }
}

#[tokio::test]
async fn own_history_keeps_repeated_turn_configuration_and_trace_once_per_page() {
    for archived in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (id, _) = fixture(dir.path(), archived).await;
        let path = dir.path().join(format!("{id}.json"));
        let mut record: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let mut configuration = record["thread"]["desktop"]["configuration"].clone();
        configuration["options"]["appendInstructions"] = json!("configuration".repeat(1000));
        let trace = json!({"activities":[{"id":"request","kind":"model","label":"trace".repeat(2000),"startedAtMs":1,"status":"completed"}]});
        let turns: Vec<_> = (0..2).map(|n| {
            let mut value = turn(n, "answer".repeat(160));
            for item in 2..12 {
                value["items"].as_array_mut().unwrap().push(json!({"id":format!("item-{n}-{item}"),"type":"agentMessage","text":"message".repeat(140)}));
            }
            value["configuration"] = configuration.clone();
            value["trace"] = trace.clone();
            value
        }).collect();
        record["thread"]["turns"] = json!(turns);
        record["thread"]["historyArchive"] = Value::Null;
        std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        let mut running = Running::open(dir.path()).await;
        let max = 96 * 1024;
        let reply = running
            .call(
                "areal/conversation/history",
                json!({"threadId":id,"view":"own","maxBytes":max}),
                Some(max),
            )
            .await;
        assert!(reply.get("error").is_none(), "{reply}");
        assert_eq!(
            reply["result"]["complete"], true,
            "ordinary items and one copy of each turn's metadata fit"
        );
        let entries = reply["result"]["data"].as_array().unwrap();
        assert_eq!(entries.len(), 24);
        for group in entries.chunks(12) {
            assert_eq!(group[0]["turn"]["configuration"], configuration);
            assert_eq!(
                group[0]["turn"]["trace"]["activities"][0]["label"],
                trace["activities"][0]["label"]
            );
            for entry in &group[1..] {
                assert_eq!(
                    entry["turn"],
                    json!({"id":group[0]["sourceTurnId"],"status":"completed"})
                );
            }
        }
        assert_eq!(
            item_map(&turns),
            entries
                .iter()
                .map(|entry| (
                    entry["sourceItemId"].as_str().unwrap().to_owned(),
                    entry["item"].clone()
                ))
                .collect()
        );
        running.close().await;
    }
}

#[tokio::test]
async fn bounded_pages_prefer_whole_turns_and_preserve_oversized_turn_progress() {
    let dir = tempfile::tempdir().unwrap();
    let (id, _) = fixture(dir.path(), false).await;
    let path = dir.path().join(format!("{id}.json"));
    let mut record: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let mut older = turn(0, "a".repeat(4000));
    older["items"][0]["content"][0]["text"] = json!("q".repeat(8000));
    record["thread"]["turns"] = json!([older, turn(1, "a".repeat(1000))]);
    record["thread"]["historyArchive"] = Value::Null;
    record["thread"]["desktop"] =
        serde_json::to_value(areal_protocol::desktop::DesktopState::default()).unwrap();
    std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    let mut running = Running::open(dir.path()).await;
    for (method, max) in [
        ("areal/conversation/history", 11000),
        ("areal/thread/observe", 16000),
    ] {
        let params = if method == "areal/thread/observe" {
            json!({"threadId":id,"mode":"bounded","maxBytes":max})
        } else {
            json!({"threadId":id,"view":"own","maxBytes":max})
        };
        let reply = running.call(method, params, Some(max)).await;
        assert!(reply.get("error").is_none(), "{reply}");
        let result = &reply["result"];
        let cursor = if method == "areal/thread/observe" {
            let turns = result["thread"]["turns"].as_array().unwrap();
            assert_eq!(
                turns.len(),
                1,
                "do not include the older answer without its prompt"
            );
            assert_eq!(turns[0]["id"], "turn-1");
            &result["history"]["nextCursor"]
        } else {
            let entries = result["data"].as_array().unwrap();
            assert_eq!(
                entries.len(),
                2,
                "do not include the older answer without its prompt"
            );
            assert_eq!(entries[0]["sourceItemId"], "user-1");
            &result["nextCursor"]
        };
        assert!(cursor.is_string());
        let mut next = cursor.clone();
        let mut recovered = Vec::new();
        loop {
            let page = running
                .call(
                    "areal/conversation/history",
                    json!({"threadId":id,"view":"own","cursor":next,"maxBytes":11000}),
                    Some(11000),
                )
                .await;
            assert!(page.get("error").is_none(), "{page}");
            let mut items: Vec<_> = page["result"]["data"]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| entry["sourceItemId"].clone())
                .collect();
            items.extend(recovered);
            recovered = items;
            next = page["result"]["nextCursor"].clone();
            if next.is_null() {
                break;
            }
        }
        assert_eq!(recovered, vec![json!("user-0"), json!("answer-0")]);
    }
    running.close().await;
}

#[tokio::test]
async fn conversation_observation_keeps_basic_messages_independent_of_tool_body_size() {
    for archived in [false, true] {
        for body_size in [20_000, 80_000, 8] {
            let dir = tempfile::tempdir().unwrap();
            let (id, _) = fixture(dir.path(), archived).await;
            let path = dir.path().join(format!("{id}.json"));
            let mut record: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let turns: Vec<_> = (0..3).map(|n| {
                let mut value = turn(n, format!("answer {n}"));
                let tools = (0..8).map(|k| json!({
                    "id":format!("tool-{n}-{k}"),"type":"dynamicToolCall","tool":if k == 0 {"run_command"} else {"shell"},
                    "arguments":{"command":"echo fixture"},"status":"completed","success":true,
                    "callId":format!("call-{n}-{k}"),"execution":{"runtimeEpoch":"fixture","scopeId":"fixture","operationId":"fixture","outcome":"succeeded"},
                    "contentItems":[{"type":"text","text":if k == 0 {json!({"processId":format!("p-{n}"),"state":"exited","commandStatus":"succeeded","outputReadComplete":true,"stdout":"x".repeat(body_size),"stderr":""}).to_string()} else {"x".repeat(body_size)}}]
                }));
                value["items"].as_array_mut().unwrap().splice(1..1, tools);
                value["items"].as_array_mut().unwrap().insert(2, json!({"id":format!("opaque-{n}"),"type":"modelContext","value":"opaque".repeat(20000)}));
                value
            }).collect();
            record["thread"]["turns"] = json!(turns);
            record["thread"]["historyArchive"] = Value::Null;
            std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
            let mut running = Running::open(dir.path()).await;
            if body_size == 20_000 {
                let legacy = running
                    .call(
                        "areal/thread/observe",
                        json!({
                            "threadId":id,"mode":"bounded","maxBytes":65536
                        }),
                        Some(65536),
                    )
                    .await;
                assert_eq!(
                    legacy["result"]["history"]["complete"], false,
                    "the control keeps basic messages fixed while tool bodies exhaust the legacy budget"
                );
            }
            let reply = running
                .call(
                    "areal/thread/observe",
                    json!({
                        "threadId":id,"mode":"conversation","maxBytes":65536
                    }),
                    Some(65536),
                )
                .await;
            assert!(reply.get("error").is_none(), "{reply}");
            assert_eq!(reply["result"]["history"]["complete"], true);
            let observed = reply["result"]["thread"]["turns"].as_array().unwrap();
            assert_eq!(observed.len(), 3);
            for (n, value) in observed.iter().enumerate() {
                let items = value["items"].as_array().unwrap();
                assert_eq!(items.first().unwrap()["id"], format!("user-{n}"));
                assert_eq!(items.last().unwrap()["text"], format!("answer {n}"));
                assert_eq!(
                    items.len(),
                    10,
                    "provider context is not conversation content"
                );
                assert!(
                    items[1..9]
                        .iter()
                        .all(|item| item["type"] == "historyDeferred")
                );
                let preview = &items[1]["preview"];
                assert_eq!(preview["tool"], "run_command");
                let status: Value =
                    serde_json::from_str(preview["contentItems"][0]["text"].as_str().unwrap())
                        .unwrap();
                assert_eq!(status["commandStatus"], "succeeded");
                assert!(status.get("stdout").is_none());
            }
            let detail = running.call("areal/conversation/history", json!({
                "threadId":id,"view":"own","cursor":observed[0]["items"][1]["cursor"],"maxBytes":1048576
            }), Some(1048576)).await;
            let fragment = detail["result"]["data"][0]["fragment"]["text"]
                .as_str()
                .unwrap();
            let restored: Value = serde_json::from_str(fragment).unwrap();
            assert_eq!(restored["item"], item_map(&turns)["tool-0-0"]);
            running.close().await;
        }
    }
}

#[tokio::test]
async fn bounded_mode_is_negotiated_and_rejects_metadata_that_cannot_fit() {
    let dir = tempfile::tempdir().unwrap();
    let (id, _) = fixture(dir.path(), false).await;
    let mut running = Running::open(dir.path()).await;
    let capabilities = running.call("areal/capabilities", json!({}), None).await;
    assert_eq!(
        capabilities["result"]["features"]["boundedObservation"],
        true
    );
    assert_eq!(capabilities["result"]["features"]["boundedHistory"], true);
    let small = running
        .call(
            "areal/thread/observe",
            json!({"threadId":id,"mode":"bounded","maxBytes":2048}),
            None,
        )
        .await;
    assert_eq!(small["error"]["data"]["reason"], "HISTORY_BUDGET_TOO_SMALL");
    let legacy = running
        .call("areal/thread/observe", json!({"threadId":id}), None)
        .await;
    assert!(legacy.get("error").is_none());
    assert_eq!(
        legacy["result"]["thread"]["turns"]
            .as_array()
            .unwrap()
            .len(),
        30
    );
    running.close().await;
}

#[tokio::test]
async fn own_cursor_survives_append_and_compaction_but_real_suffix_edit_resets() {
    let dir = tempfile::tempdir().unwrap();
    let (id, _) = fixture(dir.path(), false).await;
    let mut running = Running::open(dir.path()).await;
    let observed = running
        .call(
            "areal/thread/observe",
            json!({"threadId":id,"mode":"bounded","maxBytes":16384}),
            Some(16384),
        )
        .await;
    let cursor = observed["result"]["history"]["nextCursor"]
        .as_str()
        .expect("bounded page has an older cursor")
        .to_owned();
    let foreign = running
        .engine
        .own_history("different-principal", &id, Some(cursor.clone()), 16384)
        .await
        .unwrap_err();
    assert!(matches!(
        foreign,
        areal_engine::Error::HistoryRead {
            reason: "HISTORY_CURSOR_STALE",
            ..
        }
    ));
    running.close().await;
    let path = dir.path().join(format!("{id}.json"));
    let mut record: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let hot = record["thread"]["turns"].as_array().unwrap().clone();
    let segment =
        json!({"version":1,"previous":record["thread"]["historyArchive"],"turns":hot[..5]});
    let bytes = serde_json::to_vec(&segment).unwrap();
    let head = format!("{:x}", Sha256::digest(&bytes));
    std::fs::write(dir.path().join("history").join(&head), &bytes).unwrap();
    record["thread"]["historyArchive"] = json!({"head":head,"throughItemId":"answer-24","completedTurns":25,"items":50,"bytes":bytes.len()});
    record["thread"]["turns"] = json!(hot[5..]);
    record["thread"]["turns"]
        .as_array_mut()
        .unwrap()
        .push(turn(30, "appended".into()));
    std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    let mut running = Running::open(dir.path()).await;
    let old_page = running
        .call(
            "areal/conversation/history",
            json!({"threadId":id,"view":"own","cursor":cursor,"maxBytes":16384}),
            Some(16384),
        )
        .await;
    assert!(
        old_page.get("error").is_none(),
        "append and archive movement preserve cursor: {old_page}"
    );
    let latest = running
        .call(
            "areal/thread/observe",
            json!({"threadId":id,"mode":"bounded","maxBytes":16384}),
            Some(16384),
        )
        .await;
    let latest_cursor = latest["result"]["history"]["nextCursor"]
        .as_str()
        .unwrap()
        .to_owned();
    let revision = latest["result"]["thread"]["desktop"]["configuration"]["revision"]
        .as_u64()
        .unwrap();
    running.engine.submit_turn("trusted-embedded-host".into(), serde_json::from_value(json!({
        "requestId":"edit-last","threadId":id,"expectedConfigRevision":revision,
        "intent":{"type":"edit","expectedTurnId":"turn-30","itemId":"user-30","input":[{"type":"text","text":"edited"}]}
    })).unwrap()).await.unwrap();
    let stale = running
        .call(
            "areal/conversation/history",
            json!({"threadId":id,"view":"own","cursor":latest_cursor,"maxBytes":16384}),
            None,
        )
        .await;
    assert_eq!(stale["error"]["data"]["reason"], "HISTORY_CURSOR_STALE");
    let still_valid = running
        .call(
            "areal/conversation/history",
            json!({"threadId":id,"view":"own","cursor":cursor,"maxBytes":16384}),
            Some(16384),
        )
        .await;
    assert!(
        still_valid.get("error").is_none(),
        "edit confined to newer suffix preserves old window: {still_valid}"
    );
    running.close().await;
}

#[tokio::test]
async fn fragment_rejects_same_id_new_content_and_supplies_restart_cursor() {
    let dir = tempfile::tempdir().unwrap();
    let (id, _) = fixture(dir.path(), false).await;
    let path = dir.path().join(format!("{id}.json"));
    let mut record: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    record["thread"]["turns"]
        .as_array_mut()
        .unwrap()
        .last_mut()
        .unwrap()["items"][1] = json!({
        "id":"answer-29","type":"dynamicToolCall","tool":"run_command","arguments":{"command":"evidence".repeat(20000)},
        "status":"failed","success":false,"contentItems":[],"callId":"original-call",
        "execution":{"runtimeEpoch":"fixture","scopeId":"scope","operationId":"operation","outcome":"unknown","inspection":null,"durationMs":null}
    });
    std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    let mut running = Running::open(dir.path()).await;
    let observed = running
        .call(
            "areal/thread/observe",
            json!({"threadId":id,"mode":"bounded","maxBytes":16384}),
            Some(16384),
        )
        .await;
    let placeholder = observed["result"]["thread"]["turns"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|t| t["items"].as_array().unwrap())
        .find(|i| i["type"] == "historyDeferred")
        .unwrap()
        .clone();
    let first = running
        .call(
            "areal/conversation/history",
            json!({"threadId":id,"view":"own","cursor":placeholder["cursor"],"maxBytes":4096}),
            Some(4096),
        )
        .await;
    let next = first["result"]["nextCursor"].as_str().unwrap().to_owned();
    running
        .engine
        .acknowledge_tool(
            id.clone(),
            "answer-29".into(),
            "Inspected actual outcome".into(),
        )
        .await
        .unwrap();
    let changed = running
        .call(
            "areal/conversation/history",
            json!({"threadId":id,"view":"own","cursor":next,"maxBytes":4096}),
            None,
        )
        .await;
    assert_eq!(changed["error"]["data"]["reason"], "HISTORY_ITEM_CHANGED");
    let restart = changed["error"]["data"]["restartCursor"].as_str().unwrap();
    let first = running
        .call(
            "areal/conversation/history",
            json!({"threadId":id,"view":"own","cursor":restart,"maxBytes":4096}),
            Some(4096),
        )
        .await;
    assert_eq!(first["result"]["data"][0]["fragment"]["offsetUtf8"], 0);
    assert_ne!(
        first["result"]["data"][0]["fragment"]["version"],
        placeholder["version"]
    );
    running.close().await;
}

async fn receive(socket: &mut Socket) -> Value {
    let wire = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    serde_json::from_str(wire.to_text().unwrap()).unwrap()
}
async fn socket_call(
    socket: &mut Socket,
    id: u64,
    method: &str,
    params: Value,
) -> (Value, Vec<Value>) {
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
async fn bounded_observe_during_stream_preserves_baseline_cut_and_subscription_replacement() {
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
    socket_call(
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
        let (response, _) = socket_call(
            &mut socket,
            index + 2,
            "areal/thread/observe",
            json!({"threadId":thread.id,"mode":"bounded","maxBytes":16384}),
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

#[tokio::test]
async fn bounded_resume_binds_host_without_hydration_and_preserves_subscription_and_legacy() {
    let dir = tempfile::tempdir().unwrap();
    let (id, _) = fixture(dir.path(), false).await;
    let record_path = dir.path().join(format!("{id}.json"));
    let mut record: Value = serde_json::from_slice(&std::fs::read(&record_path).unwrap()).unwrap();
    let tool = serde_json::to_value(areal_protocol::desktop::browser_v1_tool()).unwrap();
    record["thread"]["dynamicTools"] = json!([tool]);
    std::fs::write(record_path, serde_json::to_vec(&record).unwrap()).unwrap();
    let mut running = Running::open(dir.path()).await;
    assert!(
        running
            .engine
            .start(&id, vec![areal_protocol::Input::text("before bind")])
            .await
            .unwrap_err()
            .to_string()
            .contains("connected owner")
    );
    let oldest = std::fs::read_dir(dir.path().join("history"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            let segment: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            segment["previous"].is_null()
        })
        .unwrap();
    let hidden = oldest.with_extension("temporarily-unavailable");
    std::fs::rename(&oldest, &hidden).unwrap();
    let max = 32 * 1024;
    let resumed = running
        .call(
            "thread/resume",
            json!({"threadId":id,"mode":"bounded","maxBytes":max}),
            Some(max),
        )
        .await;
    std::fs::rename(hidden, oldest).unwrap();
    assert!(
        resumed.get("error").is_none(),
        "bounded resume must succeed: {resumed}"
    );
    assert_eq!(resumed["result"]["thread"]["dynamicTools"], json!([tool]));
    assert_eq!(
        resumed["result"]["thread"]["desktop"]["receipts"],
        json!([])
    );
    assert_eq!(resumed["result"]["ownership"]["kind"], "ordinary");
    assert_eq!(resumed["result"]["history"]["complete"], false);
    assert!(
        resumed["result"]["thread"]["turns"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|turn| turn["items"].as_array().unwrap())
            .any(|item| item["type"] == "historyDeferred")
    );
    let capabilities = running.call("areal/capabilities", json!({}), None).await;
    assert_eq!(capabilities["result"]["features"]["boundedResume"], true);

    let (mut other, _) = tokio_tungstenite::connect_async(&running.url)
        .await
        .unwrap();
    other.send(Wire::Text(json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"other-host","version":"1"}}}).to_string().into())).await.unwrap();
    let initialized = tokio::time::timeout(Duration::from_secs(5), other.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let initialized: Value = serde_json::from_str(initialized.to_text().unwrap()).unwrap();
    assert!(initialized.get("result").is_some(), "{initialized}");
    other
        .send(Wire::Text(
            json!({"method":"initialized"}).to_string().into(),
        ))
        .await
        .unwrap();
    other.send(Wire::Text(json!({"id":2,"method":"thread/resume","params":{"threadId":id,"mode":"bounded","maxBytes":max}}).to_string().into())).await.unwrap();
    let conflict = tokio::time::timeout(Duration::from_secs(5), other.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let conflict: Value = serde_json::from_str(conflict.to_text().unwrap()).unwrap();
    assert_eq!(conflict["error"]["code"], -32009, "{conflict}");

    let turn = running
        .engine
        .start(&id, vec![areal_protocol::Input::text("after bind")])
        .await
        .unwrap();
    let mut started = false;
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), running.socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let message: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
        if message["params"]["threadId"] != id || message["params"]["turn"]["id"] != turn.id {
            continue;
        }
        if message["method"] == "turn/started" {
            started = true;
        }
        if message["method"] == "turn/completed" {
            assert!(started);
            break;
        }
    }
    let legacy = running
        .call("thread/resume", json!({"threadId":id}), None)
        .await;
    assert!(legacy.get("error").is_none(), "{legacy}");
    assert_eq!(
        legacy["result"]["thread"]["turns"]
            .as_array()
            .unwrap()
            .len(),
        31
    );
    assert!(legacy["result"].get("history").is_none());
    other.close(None).await.unwrap();
    running.close().await;
}
