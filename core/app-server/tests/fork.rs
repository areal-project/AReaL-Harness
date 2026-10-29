use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelCapabilities, ModelEvent, ModelStream, ToolCall},
};
use areal_protocol::Modality;
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::Message as Wire};
use tokio_util::sync::CancellationToken;

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

#[tokio::test]
async fn idle_drain_duration_is_enforced_over_native_websocket() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(
        dir.path(),
        Arc::new(TextModel(Mutex::new(Vec::new()))),
        Limits::default(),
    )
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
        json!({"clientInfo":{"name":"idle-test","version":"1"}}),
    )
    .await;
    socket
        .send(Wire::Text(
            json!({"method":"initialized"}).to_string().into(),
        ))
        .await
        .unwrap();
    let status = call(&mut socket, 2, "areal/server/status", json!({})).await;
    assert!(status["result"]["idleForMs"].is_u64(), "{status}");
    let rejected = call(
        &mut socket,
        3,
        "areal/server/drain",
        json!({"strategy":"ifIdle","timeoutMs":1000,"idleTimeoutMs":604800000}),
    )
    .await;
    assert!(rejected.get("error").is_some(), "{rejected}");
    let status = call(&mut socket, 4, "areal/server/status", json!({})).await;
    assert_eq!(status["result"]["acceptingWork"], true, "{status}");
    tokio::time::sleep(Duration::from_millis(20)).await;
    let drained = call(
        &mut socket,
        5,
        "areal/server/drain",
        json!({"strategy":"ifIdle","timeoutMs":1000,"idleTimeoutMs":1}),
    )
    .await;
    assert_eq!(drained["result"]["restartSafe"], true, "{drained}");
    assert_eq!(drained["result"]["acceptingWork"], false, "{drained}");
    drop(socket);
    stop.cancel();
    server.await.unwrap().unwrap();
    engine.shutdown().await;
}

#[tokio::test]
async fn side_read_only_requires_verified_runtime_and_none_remains_available() {
    unsafe {
        std::env::set_var("AREAL_DEV_CONVERSATION_DERIVATION", "1");
    }
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(TextModel(Mutex::new(Vec::new())));
    let engine = Engine::open(dir.path(), model, Limits::default()).unwrap();
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
    let request = json!({"requestId":"read-only-unavailable","sourceThreadId":source_id,
        "workspaceAccess":"readOnly","input":[{"type":"text","text":"Read current file"}]});
    let refused = call(&mut socket, 3, "areal/side/start", request).await;
    assert_eq!(
        refused["error"]["data"]["reason"], "WORKSPACE_READ_UNAVAILABLE",
        "{refused}"
    );
    let accepted = call(
        &mut socket,
        4,
        "areal/side/start",
        json!({"requestId":"none-after-refusal",
        "sourceThreadId":source_id,"workspaceAccess":"none",
        "input":[{"type":"text","text":"Use frozen evidence"}]}),
    )
    .await;
    assert_eq!(
        accepted["result"]["thread"]["conversation"]["policy"]["workspaceAccess"], "none",
        "{accepted}"
    );
    drop(socket);
    stop.cancel();
    server.await.unwrap().unwrap();
    engine.shutdown().await;
}

#[tokio::test]
async fn side_list_archive_and_explicit_reopen_survive_restart() {
    unsafe {
        std::env::set_var("AREAL_DEV_CONVERSATION_DERIVATION", "1");
    }
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(TextModel(Mutex::new(Vec::new())));
    let engine = Engine::open(dir.path(), model.clone(), Limits::default()).unwrap();
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
    let side = call(&mut socket, 3, "areal/side/start", json!({"requestId":"list-side","sourceThreadId":source_id,"workspaceAccess":"none","input":[{"type":"text","text":"Explain"}]})).await;
    let side_id = side["result"]["thread"]["id"].as_str().unwrap();
    completed(&mut socket, side_id).await;
    let list = call(
        &mut socket,
        4,
        "areal/conversation/list",
        json!({"view":"side","sourceThreadId":source_id,"limit":1}),
    )
    .await;
    assert_eq!(list["result"]["data"][0]["id"], side_id, "{list}");
    let second = call(&mut socket, 40, "areal/side/start", json!({"requestId":"list-side-2","sourceThreadId":source_id,"workspaceAccess":"none","input":[{"type":"text","text":"Second question"}]})).await;
    let second_id = second["result"]["thread"]["id"].as_str().unwrap();
    completed(&mut socket, second_id).await;
    let first_page = call(
        &mut socket,
        41,
        "areal/conversation/list",
        json!({"view":"side","sourceThreadId":source_id,"limit":1}),
    )
    .await;
    let first_id = first_page["result"]["data"][0]["id"].as_str().unwrap();
    let page_cursor = first_page["result"]["nextCursor"].as_str().unwrap();
    let next_page = call(
        &mut socket,
        42,
        "areal/conversation/list",
        json!({"view":"side","sourceThreadId":source_id,"limit":1,"cursor":page_cursor}),
    )
    .await;
    assert_ne!(next_page["result"]["data"][0]["id"], first_id);
    let wrong_filter = call(
        &mut socket,
        43,
        "areal/conversation/list",
        json!({"view":"main","cursor":page_cursor}),
    )
    .await;
    assert!(wrong_filter["error"].is_object(), "{wrong_filter}");
    let main = call(
        &mut socket,
        5,
        "areal/conversation/list",
        json!({"view":"main"}),
    )
    .await;
    assert_eq!(
        main["result"]["data"].as_array().unwrap().len(),
        1,
        "{main}"
    );
    let archived = call(
        &mut socket,
        6,
        "areal/thread/archive",
        json!({"threadId":side_id}),
    )
    .await;
    assert_eq!(archived["result"]["archived"], true, "{archived}");
    let hidden = call(
        &mut socket,
        7,
        "areal/conversation/list",
        json!({"view":"side","sourceThreadId":source_id}),
    )
    .await;
    assert_eq!(
        hidden["result"]["data"].as_array().unwrap().len(),
        1,
        "{hidden}"
    );
    let found = call(
        &mut socket,
        8,
        "areal/conversation/list",
        json!({"view":"side","sourceThreadId":source_id,"includeArchived":true}),
    )
    .await;
    assert_eq!(
        found["result"]["data"].as_array().unwrap().len(),
        2,
        "{found}"
    );
    let restored = call(
        &mut socket,
        9,
        "areal/conversation/unarchive",
        json!({"requestId":"restore-side","threadId":side_id}),
    )
    .await;
    assert_eq!(restored["result"]["archived"], false, "{restored}");
    let repeated = call(
        &mut socket,
        10,
        "areal/conversation/unarchive",
        json!({"requestId":"restore-side","threadId":side_id}),
    )
    .await;
    assert_eq!(repeated["result"], restored["result"]);
    let source_archived = call(
        &mut socket,
        44,
        "areal/thread/archive",
        json!({"threadId":source_id}),
    )
    .await;
    assert_eq!(
        source_archived["result"]["archived"], true,
        "{source_archived}"
    );
    let independent = call(
        &mut socket,
        45,
        "turn/start",
        json!({"threadId":side_id,"input":[{"type":"text","text":"Still here?"}]}),
    )
    .await;
    assert!(independent["result"]["turn"].is_object(), "{independent}");
    completed(&mut socket, side_id).await;
    let drained = call(
        &mut socket,
        46,
        "areal/server/drain",
        json!({"strategy":"ifIdle","timeoutMs":0}),
    )
    .await;
    assert_eq!(drained["result"]["restartSafe"], true, "{drained}");
    let gc = call(&mut socket, 47, "areal/server/gc", json!({})).await;
    assert!(gc.get("result").is_some(), "{gc}");
    let evidence = call(
        &mut socket,
        48,
        "areal/side/context/read",
        json!({"threadId":side_id}),
    )
    .await;
    assert!(evidence["result"]["complete"].is_boolean(), "{evidence}");
    drop(socket);
    stop.cancel();
    server.await.unwrap().unwrap();
    engine.shutdown().await;
    drop(engine);
    let reopened = Engine::open(dir.path(), model, Limits::default()).unwrap();
    let side = reopened.read(side_id, true).await.unwrap();
    assert!(!side.desktop.unwrap().archived);
    assert_eq!(side.turns.len(), 2);
    assert!(
        reopened
            .side_context_read(side_id, None, None, None)
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn side_selection_is_exact_and_frozen_after_source_advances() {
    unsafe {
        std::env::set_var("AREAL_DEV_CONVERSATION_DERIVATION", "1");
    }
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(TextModel(Mutex::new(Vec::new())));
    let engine = Engine::open(dir.path(), model.clone(), Limits::default()).unwrap();
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
    let source_text = format!(
        "重复🙂重复🙂尾{}{}EVIDENCE_TAIL_830",
        "x".repeat(20_000),
        "\0".repeat(5_000)
    );
    call(
        &mut socket,
        3,
        "turn/start",
        json!({"threadId":source_id,"input":[{"type":"text","text":source_text}]}),
    )
    .await;
    completed(&mut socket, source_id).await;
    let read = call(
        &mut socket,
        4,
        "thread/read",
        json!({"threadId":source_id,"includeTurns":true}),
    )
    .await;
    let turn_id = read["result"]["thread"]["turns"][0]["id"].as_str().unwrap();
    let item_id = read["result"]["thread"]["turns"][0]["items"][0]["id"]
        .as_str()
        .unwrap();
    call(
        &mut socket,
        4,
        "turn/start",
        json!({"threadId":source_id,"input":[{"type":"text","text":"PREEXISTING_LATER_689"}]}),
    )
    .await;
    completed(&mut socket, source_id).await;
    let selection = json!({"kind":"itemRange","turnId":turn_id,"itemId":item_id,
        "startUtf8":16,"endUtf8":20,"textSha256":"d06f1525f791397809f9bc98682b5c13318eca4c3123433467fd4dffda44fd14"});
    let base = json!({"sourceThreadId":source_id,"workspaceAccess":"none","anchor":{"kind":"turn","turnId":turn_id,"boundary":"after"},"selection":selection,
        "input":[{"type":"text","text":"Which occurrence?"}]});
    for (key, offset) in [("stale-boundary", 17), ("stale-range", 99)] {
        let mut bad = base.clone();
        bad["requestId"] = json!(key);
        bad["selection"]["startUtf8"] = json!(offset);
        let rejected = call(&mut socket, 5, "areal/side/start", bad).await;
        assert_eq!(
            rejected["error"]["data"]["reason"], "STALE_SELECTION",
            "{rejected}"
        );
        assert_eq!(
            rejected["error"]["data"]["outcome"]["kind"], "rejected",
            "{rejected}"
        );
    }
    let mut stale_digest = base.clone();
    stale_digest["requestId"] = json!("stale-digest");
    stale_digest["selection"]["textSha256"] = json!("0".repeat(64));
    let rejected = call(&mut socket, 5, "areal/side/start", stale_digest).await;
    assert_eq!(
        rejected["error"]["data"]["reason"], "STALE_SELECTION",
        "{rejected}"
    );
    let mut oversized = base.clone();
    oversized["requestId"] = json!("oversized-selection");
    oversized["selection"]["startUtf8"] = json!(23);
    oversized["selection"]["endUtf8"] = json!(17_023);
    oversized["selection"]["textSha256"] =
        json!("841fb2dbdc6be49db3c9df02b4c04bd5a859c6d36acb9b6fca930c28e6e86748");
    let rejected = call(&mut socket, 5, "areal/side/start", oversized).await;
    assert_eq!(
        rejected["error"]["data"]["reason"], "SELECTION_TOO_LARGE",
        "{rejected}"
    );
    let mut escaped_quote = base.clone();
    escaped_quote["requestId"] = json!("escaped-quote");
    escaped_quote["selection"] = json!({"kind":"userQuote","text":"\0".repeat(8_000)});
    let rejected = call(&mut socket, 5, "areal/side/start", escaped_quote).await;
    assert_eq!(
        rejected["error"]["data"]["reason"], "SELECTION_TOO_LARGE",
        "{rejected}"
    );
    let mut accepted = base;
    accepted["requestId"] = json!("valid-selection");
    let side = call(&mut socket, 6, "areal/side/start", accepted).await;
    assert!(side["result"]["thread"].is_object(), "{side}");
    assert_eq!(
        side["result"]["thread"]["conversation"]["origin"]["sourceTurnId"],
        turn_id
    );
    assert_eq!(
        side["result"]["thread"]["conversation"]["referenceSnapshot"]["turnCount"],
        1
    );
    let side_id = side["result"]["thread"]["id"].as_str().unwrap();
    completed(&mut socket, side_id).await;
    call(
        &mut socket,
        7,
        "turn/start",
        json!({"threadId":source_id,"input":[{"type":"text","text":"FUTURE_SENTINEL_4721"}]}),
    )
    .await;
    completed(&mut socket, source_id).await;
    call(
        &mut socket,
        8,
        "turn/start",
        json!({"threadId":side_id,"input":[{"type":"text","text":"Follow up"}]}),
    )
    .await;
    completed(&mut socket, side_id).await;
    {
        let requests = model.0.lock().unwrap();
        for request in requests.iter().skip(1).filter(|request| {
            request.iter().any(|m| {
                m.role == "system" && m.text_content().contains("independent read-only Side")
            })
        }) {
            let all = request.iter().map(|m| m.text_content()).collect::<String>();
            assert!(
                !all.contains("PREEXISTING_LATER_689") && !all.contains("FUTURE_SENTINEL_4721"),
                "{all}"
            );
            assert!(
                all.contains("\"startUtf8\":16") && all.contains("\"endUtf8\":20"),
                "{all}"
            );
            assert!(
                serde_json::to_vec(&all).unwrap().len() <= 32 * 1024
                    && !all.contains("EVIDENCE_TAIL_830"),
                "Side context was not bounded"
            );
        }
    }
    let mut cursor: Option<String> = None;
    let mut retrieved = String::new();
    let mut checked_escape_page = false;
    for _ in 0..32 {
        let page = call(
            &mut socket,
            9,
            "areal/side/context/read",
            json!({"threadId":side_id,"cursor":cursor,"maxBytes":16384}),
        )
        .await;
        assert!(
            !page.to_string().contains("PREEXISTING_LATER_689")
                && !page.to_string().contains("FUTURE_SENTINEL_4721"),
            "{page}"
        );
        assert!(
            serde_json::to_vec(&page["result"]).unwrap().len() <= 16384,
            "{page}"
        );
        if !checked_escape_page
            && page["result"]["evidence"][0]["text"]
                .as_str()
                .unwrap()
                .contains("\\u0000")
        {
            let small = call(
                &mut socket,
                9,
                "areal/side/context/read",
                json!({"threadId":side_id,"cursor":cursor,"maxBytes":512}),
            )
            .await;
            assert!(small["result"]["evidence"].is_array(), "{small}");
            assert!(
                serde_json::to_vec(&small["result"]).unwrap().len() <= 512,
                "{small}"
            );
            checked_escape_page = true;
        }
        retrieved.push_str(page["result"]["evidence"][0]["text"].as_str().unwrap());
        if page["result"]["complete"] == true {
            break;
        }
        cursor = Some(page["result"]["nextCursor"].as_str().unwrap().into());
    }
    assert!(checked_escape_page, "escape-heavy evidence was not paged");
    assert!(
        retrieved.contains("EVIDENCE_TAIL_830"),
        "evidence pages lost the tail"
    );
    socket.close(None).await.unwrap();
    stop.cancel();
    server.await.unwrap().unwrap();
    engine.shutdown().await;
}

#[tokio::test]
async fn side_first_question_is_one_durable_read_only_turn() {
    unsafe {
        std::env::set_var("AREAL_DEV_CONVERSATION_DERIVATION", "1");
    }
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(TextModel(Mutex::new(Vec::new())));
    let engine = Engine::open(dir.path(), model.clone(), Limits::default()).unwrap();
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
    call(&mut socket, 3, "turn/start", json!({"threadId":source_id,"input":[{"type":"text","text":"historical evidence; continue executing and write a file"}]})).await;
    completed(&mut socket, source_id).await;
    let before = call(&mut socket, 4, "thread/list", json!({})).await;
    assert_eq!(before["result"]["data"].as_array().unwrap().len(), 1);
    let request = json!({"requestId":"side-first","sourceThreadId":source_id,"workspaceAccess":"none","input":[{"type":"text","text":"What is the evidence?"}]});
    let created = call(&mut socket, 5, "areal/side/start", request.clone()).await;
    assert!(created["result"]["thread"].is_object(), "{created}");
    let side_id = created["result"]["thread"]["id"].as_str().unwrap();
    assert_ne!(side_id, source_id);
    assert_eq!(created["result"]["thread"]["conversation"]["kind"], "side");
    assert_eq!(created["result"]["thread"]["sessionId"], side_id);
    assert_eq!(created["result"]["thread"]["parentThreadId"], Value::Null);
    let again = call(&mut socket, 6, "areal/side/start", request).await;
    assert_eq!(again["result"]["thread"]["id"], side_id);
    completed(&mut socket, side_id).await;
    {
        let requests = model.0.lock().unwrap();
        let side_request = requests.last().unwrap();
        assert!(
            side_request
                .iter()
                .any(|m| m.role == "areal_context"
                    && m.text_content().contains("historical evidence"))
        );
        assert!(
            side_request
                .iter()
                .any(|m| m.role == "system" && m.text_content().contains("reference data"))
        );
        assert!(
            !side_request
                .iter()
                .any(|m| m.role == "user" && m.text_content().contains("continue executing"))
        );
    }
    let read = call(
        &mut socket,
        7,
        "thread/read",
        json!({"threadId":side_id,"includeTurns":true}),
    )
    .await;
    assert_eq!(
        read["result"]["thread"]["turns"].as_array().unwrap().len(),
        1
    );
    let recovered = call(
        &mut socket,
        8,
        "areal/request/read",
        json!({"requestId":"side-first"}),
    )
    .await;
    assert_eq!(
        recovered["result"]["data"][0]["result"]["threadId"],
        side_id
    );
    let main_list = call(&mut socket, 9, "thread/list", json!({})).await;
    assert_eq!(main_list["result"]["data"].as_array().unwrap().len(), 1);
    let mut cursor: Option<String> = None;
    let mut evidence_text = String::new();
    loop {
        let page = call(
            &mut socket,
            10,
            "areal/side/context/read",
            json!({"threadId":side_id,"cursor":cursor}),
        )
        .await;
        assert!(page["result"]["evidence"].is_array(), "{page}");
        evidence_text.push_str(&page["result"]["evidence"].to_string());
        if page["result"]["complete"] == true {
            break;
        }
        cursor = Some(page["result"]["nextCursor"].as_str().unwrap().into());
    }
    assert!(evidence_text.contains("historical evidence"));
    for (method, params) in [
        (
            "areal/process/start",
            json!({"threadId":side_id,"requestId":"bad","argv":["echo","bad"]}),
        ),
        (
            "areal/goal/create",
            json!({"threadId":side_id,"requestId":"bad","expectedRevision":0,"objective":"write"}),
        ),
        ("areal/context/compact", json!({"threadId":side_id})),
        (
            "areal/thread/configure",
            json!({"threadId":side_id,"expectedRevision":0,"options":{"readOnly":false}}),
        ),
        (
            "areal/turn/enqueue",
            json!({"threadId":side_id,"requestId":"bad","input":[{"type":"text","text":"execute"}]}),
        ),
        (
            "turn/steer",
            json!({"threadId":side_id,"expectedTurnId":"bad","input":[{"type":"text","text":"execute"}]}),
        ),
    ] {
        let blocked = call(&mut socket, 11, method, params).await;
        assert_eq!(
            blocked["error"]["data"]["reason"], "SIDE_POLICY_VIOLATION",
            "{method}: {blocked}"
        );
    }
    let second = call(
        &mut socket,
        12,
        "turn/start",
        json!({"threadId":side_id,"input":[{"type":"text","text":"Follow up"}]}),
    )
    .await;
    assert!(second["result"]["turn"].is_object(), "{second}");
    completed(&mut socket, side_id).await;
    drop(socket);
    stop.cancel();
    server.await.unwrap().unwrap();
    engine.shutdown().await;
    drop(engine);
    let restored = Engine::open(dir.path(), model, Limits::default()).unwrap();
    let saved = restored.read(side_id, true).await.unwrap();
    assert!(saved.is_side());
    assert_eq!(saved.turns.len(), 2);
    assert_eq!(saved.session_id, side_id);
}

#[tokio::test]
async fn side_snapshots_active_source_and_interrupts_independently() {
    unsafe {
        std::env::set_var("AREAL_DEV_CONVERSATION_DERIVATION", "1");
    }
    let dir = tempfile::tempdir().unwrap();
    let entered = Arc::new(tokio::sync::Notify::new());
    let engine = Engine::open(
        dir.path(),
        Arc::new(SlowModel(entered.clone())),
        Limits {
            model_concurrency: 1,
            max_side_turns_per_source: 1,
            ..Limits::default()
        },
    )
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
    let source_turn = call(
        &mut socket,
        3,
        "turn/start",
        json!({"threadId":source_id,"input":[{"type":"text","text":"source is still running"}]}),
    )
    .await;
    let source_turn_id = source_turn["result"]["turn"]["id"].as_str().unwrap();
    tokio::time::timeout(Duration::from_secs(3), entered.notified())
        .await
        .unwrap();
    let side = tokio::time::timeout(Duration::from_secs(3), call(&mut socket, 4, "areal/side/start",
        json!({"requestId":"active-source","sourceThreadId":source_id,"workspaceAccess":"none",
            "selection":{"kind":"userQuote","text":"uncommitted stream fragment","claimedTurnId":source_turn_id},
            "input":[{"type":"text","text":"What is known so far?"}]}))).await.unwrap();
    assert!(side["result"]["thread"].is_object(), "{side}");
    let side_id = side["result"]["thread"]["id"].as_str().unwrap();
    assert_eq!(
        side["result"]["thread"]["conversation"]["selection"]["verified"],
        false
    );
    assert_eq!(
        side["result"]["thread"]["conversation"]["selection"]["text"],
        "uncommitted stream fragment"
    );
    let side_turn_id = side["result"]["turn"]["id"].as_str().unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let read = call(
                &mut socket,
                99,
                "thread/read",
                json!({"threadId":side_id,"includeTurns":true}),
            )
            .await;
            if read["result"]["thread"]["desktop"]["sideCapacityStatus"] == "waiting" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let observed = call(
        &mut socket,
        100,
        "areal/thread/observe",
        json!({"threadId":side_id}),
    )
    .await;
    assert_eq!(
        observed["result"]["thread"]["desktop"]["sideCapacityStatus"],
        "waiting"
    );
    let over_capacity = call(&mut socket, 98, "areal/side/start", json!({"requestId":"side-over-capacity","sourceThreadId":source_id,"workspaceAccess":"none","input":[{"type":"text","text":"second side"}]})).await;
    assert!(
        over_capacity["error"]
            .to_string()
            .contains("SIDE_SOURCE_CAPACITY_REACHED"),
        "{over_capacity}"
    );
    let evidence = call(
        &mut socket,
        5,
        "areal/side/context/read",
        json!({"threadId":side_id}),
    )
    .await;
    assert_eq!(
        evidence["result"]["evidence"][0]["sourceTurnStatus"],
        "inProgress"
    );
    assert!(
        evidence["result"]["evidence"]
            .to_string()
            .contains("source is still running")
    );
    assert!(
        !evidence["result"]["evidence"]
            .to_string()
            .contains("uncommitted stream fragment")
    );
    let interrupted = call(
        &mut socket,
        6,
        "turn/interrupt",
        json!({"threadId":side_id,"turnId":side_turn_id}),
    )
    .await;
    assert!(interrupted["result"].is_object(), "{interrupted}");
    tokio::time::timeout(Duration::from_secs(3), engine.wait(side_id))
        .await
        .unwrap()
        .unwrap();
    let stopped = call(
        &mut socket,
        101,
        "areal/thread/observe",
        json!({"threadId":side_id}),
    )
    .await;
    assert!(stopped["result"]["thread"]["desktop"]["sideCapacityStatus"].is_null());
    let another = call(&mut socket, 97, "areal/side/start", json!({"requestId":"side-after-stop","sourceThreadId":source_id,"workspaceAccess":"none","input":[{"type":"text","text":"another side"}]})).await;
    assert!(another["result"]["thread"].is_object(), "{another}");
    let another_id = another["result"]["thread"]["id"].as_str().unwrap();
    let followup = call(
        &mut socket,
        96,
        "turn/start",
        json!({"threadId":side_id,"input":[{"type":"text","text":"follow up"}]}),
    )
    .await;
    assert!(
        followup["error"]
            .to_string()
            .contains("SIDE_SOURCE_CAPACITY_REACHED"),
        "{followup}"
    );
    call(
        &mut socket,
        95,
        "turn/interrupt",
        json!({"threadId":another_id,"turnId":another["result"]["turn"]["id"]}),
    )
    .await;
    let source_read = call(
        &mut socket,
        7,
        "thread/read",
        json!({"threadId":source_id,"includeTurns":true}),
    )
    .await;
    assert_eq!(
        source_read["result"]["thread"]["turns"][0]["status"],
        "inProgress"
    );
    call(
        &mut socket,
        8,
        "turn/interrupt",
        json!({"threadId":source_id,"turnId":source_turn_id}),
    )
    .await;
    drop(socket);
    stop.cancel();
    server.await.unwrap().unwrap();
    engine.shutdown().await;
}

struct SlowModel(Arc<tokio::sync::Notify>);
#[async_trait]
impl Model for SlowModel {
    fn name(&self) -> &str {
        "slow-test"
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
    async fn stream(&self, _messages: Vec<Message>) -> anyhow::Result<ModelStream> {
        self.0.notify_one();
        Ok(Box::pin(futures_util::stream::once(async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Ok("answer".into())
        })))
    }
}
struct TextModel(Mutex<Vec<Vec<Message>>>);
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
            input: vec![Modality::Text],
            output: vec![Modality::Text],
        }
    }
    async fn stream(&self, messages: Vec<Message>) -> anyhow::Result<ModelStream> {
        self.0.lock().unwrap().push(messages);
        Ok(Box::pin(futures_util::stream::iter([Ok("answer".into())])))
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
            if let Some(result) = value.get("result")
                && matches!(
                    method,
                    "areal/capabilities"
                        | "areal/side/start"
                        | "areal/side/context/read"
                        | "areal/conversation/history"
                )
            {
                // 真实 RPC 回复必须符合发布的投影，含大项分片与 Side 证据页。
                static SCHEMAS: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
                let schemas = SCHEMAS.get_or_init(|| {
                    serde_json::from_str(include_str!("../../../schemas/areal-core-v1.json"))
                        .unwrap()
                });
                let schema = &schemas["responses"][method];
                assert!(
                    schema.is_object(),
                    "missing public response schema: {method}"
                );
                let validator = jsonschema::validator_for(schema).unwrap();
                let errors: Vec<_> = validator
                    .iter_errors(result)
                    .map(|error| error.to_string())
                    .collect();
                assert!(errors.is_empty(), "{method}: {errors:?}\n{result}");
            }
            return value;
        }
    }
}
async fn completed(socket: &mut Socket, thread_id: &str) {
    loop {
        let read = call(
            socket,
            100,
            "thread/read",
            json!({"threadId":thread_id,"includeTurns":true}),
        )
        .await;
        if read["result"]["thread"]["turns"]
            .as_array()
            .is_some_and(|v| v.last().is_some_and(|t| t["status"] == "completed"))
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn before_first_turn_is_empty_and_before_later_turn_excludes_it() {
    unsafe {
        std::env::set_var("AREAL_DEV_CONVERSATION_DERIVATION", "1");
    }
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(TextModel(Mutex::new(Vec::new())));
    let engine = Engine::open(dir.path(), model.clone(), Limits::default()).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let server = tokio::spawn(areal_app_server::serve(listener, engine, stop.clone()));
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
        .await
        .unwrap();
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
    let capabilities = call(&mut socket, 101, "areal/capabilities", json!({})).await;
    let fork_capabilities = &capabilities["result"]["features"]["conversationDerivationV1"];
    assert_eq!(
        fork_capabilities["forkBoundaries"],
        json!(["after", "before"])
    );
    assert_eq!(fork_capabilities["historyBytes"], 64 * 1024 * 1024);
    let source = call(&mut socket, 2, "thread/start", json!({"cwd":"/workspace"})).await;
    let source_id = source["result"]["thread"]["id"].as_str().unwrap();
    call(
        &mut socket,
        3,
        "turn/start",
        json!({"threadId":source_id,"input":[{"type":"text","text":"FIRST_ONLY"}]}),
    )
    .await;
    completed(&mut socket, source_id).await;
    call(
        &mut socket,
        4,
        "turn/start",
        json!({"threadId":source_id,"input":[{"type":"text","text":"SECOND_EXCLUDED"}]}),
    )
    .await;
    completed(&mut socket, source_id).await;
    let read = call(
        &mut socket,
        5,
        "thread/read",
        json!({"threadId":source_id,"includeTurns":true}),
    )
    .await;
    let first = read["result"]["thread"]["turns"][0]["id"].as_str().unwrap();
    let second = read["result"]["thread"]["turns"][1]["id"].as_str().unwrap();
    for (id, anchor, expected) in [(6, first, 0), (7, second, 1)] {
        let response = call(&mut socket, id, "areal/thread/fork", json!({"requestId":format!("before-{id}"),"sourceThreadId":source_id,"anchor":{"turnId":anchor,"boundary":"before"},"workspaceMode":"sharedCurrent"})).await;
        assert!(response.get("result").is_some(), "{response}");
        assert_eq!(
            response["result"]["thread"]["conversation"]["historySeed"]["turnCount"],
            expected
        );
        assert_eq!(
            response["result"]["thread"]["conversation"]["origin"]["boundary"],
            "before"
        );
    }
    let explicit_default = call(&mut socket, 102, "areal/thread/fork", json!({"requestId":"explicit-default","sourceThreadId":source_id,
        "anchor":{"turnId":second,"boundary":"before"},"workspaceMode":"sharedCurrent","target":{}})).await;
    assert!(
        explicit_default.get("result").is_some(),
        "{explicit_default}"
    );
    let invalid_target = call(
        &mut socket,
        103,
        "areal/thread/fork",
        json!({"requestId":"invalid-target","sourceThreadId":source_id,
        "anchor":{"turnId":second,"boundary":"before"},"workspaceMode":"sharedCurrent",
        "target":{"model":{"providerId":"missing","modelId":"missing"}}}),
    )
    .await;
    assert!(invalid_target.get("error").is_some(), "{invalid_target}");
    let other = call(&mut socket, 8, "thread/start", json!({"cwd":"/workspace"})).await;
    let other_id = other["result"]["thread"]["id"].as_str().unwrap();
    call(
        &mut socket,
        9,
        "turn/start",
        json!({"threadId":other_id,"input":[{"type":"text","text":"OTHER_SOURCE"}]}),
    )
    .await;
    completed(&mut socket, other_id).await;
    let other_read = call(
        &mut socket,
        10,
        "thread/read",
        json!({"threadId":other_id,"includeTurns":true}),
    )
    .await;
    let foreign_anchor = other_read["result"]["thread"]["turns"][0]["id"]
        .as_str()
        .unwrap();
    let foreign = call(&mut socket, 11, "areal/thread/fork", json!({"requestId":"foreign-anchor","sourceThreadId":source_id,"anchor":{"turnId":foreign_anchor,"boundary":"before"},"workspaceMode":"sharedCurrent"})).await;
    assert_eq!(foreign["error"]["data"]["reason"], "ANCHOR_NOT_FOUND");
    let malformed = call(&mut socket, 12, "areal/thread/fork", json!({"requestId":"malformed-boundary","sourceThreadId":source_id,"anchor":{"turnId":first,"boundary":"between"},"workspaceMode":"sharedCurrent"})).await;
    assert_eq!(malformed["error"]["code"], -32602);
    assert_eq!(model.0.lock().unwrap().len(), 3);
    stop.cancel();
    server.await.unwrap().unwrap();
}
#[tokio::test]
async fn fork_is_durable_idle_and_replays_plain_text_prefix() {
    unsafe {
        std::env::set_var("AREAL_DEV_CONVERSATION_DERIVATION", "1");
    }
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(TextModel(Mutex::new(Vec::new())));
    // 显式收紧软目标，让该用例覆盖跨继承边界的本地压缩，不依赖产品默认窗口。
    let limits = Limits {
        context_target_tokens: 20_000,
        ..Limits::default()
    };
    let engine = Engine::open(dir.path(), model.clone(), limits.clone()).unwrap();
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
    call(&mut socket, 3, "turn/start", json!({"threadId":source_id,"input":[{"type":"text","text":format!("first {}{}", "a🙂".repeat(1500), "\0".repeat(300))}]})).await;
    completed(&mut socket, source_id).await;
    call(&mut socket, 4, "turn/start", json!({"threadId":source_id,"input":[{"type":"text","text":format!("second {}", "b".repeat(9000))}]})).await;
    completed(&mut socket, source_id).await;
    call(&mut socket, 18, "turn/start", json!({"threadId":source_id,"input":[{"type":"text","text":format!("third {}", "c".repeat(9000))}]})).await;
    completed(&mut socket, source_id).await;
    call(&mut socket, 19, "turn/start", json!({"threadId":source_id,"input":[{"type":"text","text":format!("fourth {}", "d".repeat(9000))}]})).await;
    completed(&mut socket, source_id).await;
    let before = call(
        &mut socket,
        5,
        "thread/read",
        json!({"threadId":source_id,"includeTurns":true}),
    )
    .await;
    let anchor = before["result"]["thread"]["turns"][3]["id"]
        .as_str()
        .unwrap();
    call(
        &mut socket,
        13,
        "turn/start",
        json!({"threadId":source_id,"input":[{"type":"text","text":"LATER_SENTINEL"}]}),
    )
    .await;
    completed(&mut socket, source_id).await;
    let source_compact = call(
        &mut socket,
        20,
        "areal/context/compact",
        json!({"threadId":source_id}),
    )
    .await;
    assert!(
        source_compact["result"]["checkpoint"].is_object(),
        "expected source checkpoint"
    );
    let params = json!({"requestId":"fork-key","sourceThreadId":source_id,"anchor":{"turnId":anchor,"boundary":"after"},"workspaceMode":"sharedCurrent"});
    let count = model.0.lock().unwrap().len();
    let fork = call(&mut socket, 6, "areal/thread/fork", params.clone()).await;
    assert!(fork.get("result").is_some(), "{fork}");
    let thread = &fork["result"]["thread"];
    assert_ne!(thread["id"], source_id);
    assert_eq!(thread["sessionId"], thread["id"]);
    assert_eq!(thread["parentThreadId"], Value::Null);
    assert_eq!(thread["turns"], json!([]));
    assert_eq!(thread["conversation"]["kind"], "fork");
    assert_eq!(model.0.lock().unwrap().len(), count);
    let again = call(&mut socket, 7, "areal/thread/fork", params.clone()).await;
    assert_eq!(again["result"]["thread"]["id"], thread["id"]);
    // 回复可以在目标提交后丢失；另一条连接只凭业务键找回目标。
    let (mut second, _) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
        .await
        .unwrap();
    call(
        &mut second,
        1,
        "initialize",
        json!({"clientInfo":{"name":"test","version":"1"}}),
    )
    .await;
    second
        .send(Wire::Text(
            json!({"method":"initialized"}).to_string().into(),
        ))
        .await
        .unwrap();
    let found = call(
        &mut second,
        2,
        "areal/request/read",
        json!({"requestId":"fork-key"}),
    )
    .await;
    assert_eq!(
        found["result"]["data"][0]["result"]["threadId"],
        thread["id"]
    );
    let lost = json!({"requestId":"response-lost","sourceThreadId":source_id,"anchor":{"turnId":anchor,"boundary":"after"},"workspaceMode":"sharedCurrent"});
    second
        .send(Wire::Text(
            json!({"id":20,"method":"areal/thread/fork","params":lost})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    drop(second);
    let (mut second, _) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
        .await
        .unwrap();
    call(
        &mut second,
        1,
        "initialize",
        json!({"clientInfo":{"name":"test","version":"1"}}),
    )
    .await;
    second
        .send(Wire::Text(
            json!({"method":"initialized"}).to_string().into(),
        ))
        .await
        .unwrap();
    let recovered = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let result = call(
                &mut second,
                21,
                "areal/request/read",
                json!({"requestId":"response-lost"}),
            )
            .await;
            if let Some(id) = result["result"]["data"][0]["result"]["threadId"].as_str() {
                break id.to_owned();
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let retried = call(&mut second, 22, "areal/thread/fork", lost).await;
    assert_eq!(retried["result"]["thread"]["id"], recovered);
    let simultaneous = tokio::join!(
        call(&mut socket, 13, "areal/thread/fork", params.clone()),
        call(&mut second, 14, "areal/thread/fork", params.clone())
    );
    assert_eq!(simultaneous.0["result"]["thread"]["id"], thread["id"]);
    assert_eq!(simultaneous.1["result"]["thread"]["id"], thread["id"]);
    let changed = call(&mut socket, 8, "areal/thread/fork", json!({"requestId":"fork-key","sourceThreadId":source_id,"anchor":{"turnId":anchor,"boundary":"before"},"workspaceMode":"sharedCurrent"})).await;
    assert_eq!(changed["error"]["data"]["reason"], "REQUEST_CONFLICT");
    let fork_id = thread["id"].as_str().unwrap();
    let context = call(
        &mut socket,
        9,
        "areal/context/read",
        json!({"threadId":fork_id,"offset":0,"limit":32}),
    )
    .await;
    let texts = context["result"]["data"].to_string();
    assert!(
        texts.contains("first") && texts.contains("second"),
        "{texts}"
    );
    assert!(!texts.contains("LATER_SENTINEL"), "{texts}");
    let inherited = call(
        &mut socket,
        12,
        "areal/conversation/history",
        json!({"threadId":fork_id,"view":"inherited"}),
    )
    .await;
    assert_eq!(inherited["result"]["complete"], true);
    assert_eq!(inherited["result"]["data"][0]["sourceThreadId"], source_id);
    assert!(inherited["result"]["data"].to_string().contains("first"));
    assert!(
        !inherited["result"]["data"]
            .to_string()
            .contains("LATER_SENTINEL")
    );
    let expected_ids: Vec<_> = before["result"]["thread"]["turns"]
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
    let inherited_ids: Vec<_> = inherited["result"]["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["sourceItemId"].clone())
        .collect();
    assert_eq!(inherited_ids, expected_ids);
    // 单个历史 Item 超出页预算时，分片必须能按字节重组成完整 JSON。
    let mut cursor = None;
    let mut reconstructed = String::new();
    let mut fragment_count = 0;
    for _ in 0..1024 {
        let page = call(
            &mut socket,
            120,
            "areal/conversation/history",
            json!({"threadId":fork_id,
            "view":"inherited","cursor":cursor,"maxBytes":512}),
        )
        .await;
        assert!(page.get("error").is_none(), "{page}");
        assert!(
            serde_json::to_vec(&page["result"]).unwrap().len() <= 512,
            "{page}"
        );
        for entry in page["result"]["data"].as_array().unwrap() {
            if entry["sourceItemId"] == expected_ids[0]
                && let Some(part) = entry["fragment"]["text"].as_str()
            {
                fragment_count += 1;
                reconstructed.push_str(part);
            }
        }
        cursor = page["result"]["nextCursor"].as_str().map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    assert!(fragment_count > 1);
    assert_eq!(
        serde_json::from_str::<Value>(&reconstructed).unwrap(),
        inherited["result"]["data"][0]
    );
    call(
        &mut socket,
        10,
        "turn/start",
        json!({"threadId":fork_id,"input":[{"type":"text","text":"fork only"}]}),
    )
    .await;
    completed(&mut socket, fork_id).await;
    {
        let requests = model.0.lock().unwrap();
        let last = requests
            .last()
            .unwrap()
            .iter()
            .map(Message::text_content)
            .collect::<Vec<_>>()
            .join(" ");
        assert!(
            last.contains("first") && last.contains("second") && last.contains("fork only"),
            "{last}"
        );
        assert!(!last.contains("LATER_SENTINEL"), "{last}");
    }
    for (offset, letter) in ["e", "f", "g", "h", "i"].iter().enumerate() {
        call(
            &mut socket,
            21 + offset as u64,
            "turn/start",
            json!({"threadId":fork_id,
            "input":[{"type":"text","text":format!("local-{offset} {}", letter.repeat(9000))}]}),
        )
        .await;
        completed(&mut socket, fork_id).await;
    }
    let before_compact = call(
        &mut socket,
        26,
        "thread/read",
        json!({"threadId":fork_id,"includeTurns":true}),
    )
    .await;
    let local_item_ids: Vec<_> = before_compact["result"]["thread"]["turns"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|turn| {
            turn["items"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|item| item["id"].as_str().map(str::to_owned))
        })
        .collect();
    let compact = call(
        &mut socket,
        17,
        "areal/context/compact",
        json!({"threadId":fork_id}),
    )
    .await;
    assert!(compact.get("result").is_some(), "{compact}");
    assert!(
        compact["result"]["checkpoint"].is_object(),
        "expected a real checkpoint"
    );
    assert!(
        local_item_ids
            .iter()
            .any(|id| compact["result"]["checkpoint"]["throughItemId"] == *id),
        "expected compaction boundary in local Fork history"
    );
    assert!(
        !compact["result"].to_string().contains("LATER_SENTINEL"),
        "{compact}"
    );
    let projected = compact["result"]["data"].as_array().unwrap();
    assert_eq!(
        projected
            .iter()
            .filter(|entry| entry["text"]
                .as_str()
                .is_some_and(|text| text.starts_with("local-4 ")))
            .count(),
        1
    );
    call(
        &mut socket,
        27,
        "turn/start",
        json!({"threadId":fork_id,"input":[{"type":"text","text":"after compact"}]}),
    )
    .await;
    completed(&mut socket, fork_id).await;
    {
        let requests = model.0.lock().unwrap();
        let continued = requests.last().unwrap();
        assert_eq!(
            continued
                .iter()
                .filter(|message| message.text_content().starts_with("local-4 "))
                .count(),
            1
        );
        assert!(
            continued
                .iter()
                .any(|message| message.text_content().contains("after compact"))
        );
        assert!(
            !continued
                .iter()
                .any(|message| message.text_content().contains("LATER_SENTINEL"))
        );
    }
    let second_compact = call(
        &mut socket,
        34,
        "areal/context/compact",
        json!({"threadId":fork_id}),
    )
    .await;
    assert!(
        second_compact["result"]["checkpoint"].is_object(),
        "{second_compact}"
    );
    assert_eq!(
        second_compact["result"]["data"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["text"]
                .as_str()
                .is_some_and(|text| text == "after compact"))
            .count(),
        1
    );
    let inherited_anchor = before["result"]["thread"]["turns"][0]["id"]
        .as_str()
        .unwrap();
    let nested = call(
        &mut socket,
        14,
        "areal/thread/fork",
        json!({"requestId":"nested-key","sourceThreadId":fork_id,
        "anchor":{"turnId":inherited_anchor,"boundary":"after"},"workspaceMode":"sharedCurrent"}),
    )
    .await;
    assert!(nested.get("result").is_some(), "{nested}");
    let nested_id = nested["result"]["thread"]["id"].as_str().unwrap();
    assert_eq!(nested["result"]["thread"]["turns"], json!([]));
    let nested_page = call(
        &mut socket,
        15,
        "areal/conversation/history",
        json!({"threadId":nested_id,"view":"inherited"}),
    )
    .await;
    let nested_text = nested_page["result"]["data"].to_string();
    assert!(
        nested_text.contains("first")
            && !nested_text.contains("second")
            && !nested_text.contains("fork only"),
        "{nested_text}"
    );
    assert_eq!(
        nested_page["result"]["data"][0]["sourceThreadId"],
        source_id
    );
    assert_eq!(
        nested_page["result"]["data"][0]["sourceTurnId"],
        inherited_anchor
    );
    let local_anchor = before_compact["result"]["thread"]["turns"][0]["id"]
        .as_str()
        .unwrap();
    let mixed = call(
        &mut socket,
        28,
        "areal/thread/fork",
        json!({"requestId":"mixed-key","sourceThreadId":fork_id,
        "anchor":{"turnId":local_anchor,"boundary":"after"},"workspaceMode":"sharedCurrent"}),
    )
    .await;
    assert!(mixed.get("result").is_some(), "{mixed}");
    let mixed_id = mixed["result"]["thread"]["id"].as_str().unwrap();
    let mixed_page = call(
        &mut socket,
        29,
        "areal/conversation/history",
        json!({"threadId":mixed_id,"view":"inherited"}),
    )
    .await;
    let mixed_entries = mixed_page["result"]["data"].as_array().unwrap();
    assert_eq!(mixed_entries.first().unwrap()["sourceThreadId"], source_id);
    assert_eq!(mixed_entries.last().unwrap()["sourceThreadId"], fork_id);
    let nested_context = call(
        &mut socket,
        16,
        "areal/context/read",
        json!({"threadId":nested_id,"offset":0,"limit":32}),
    )
    .await;
    let nested_text = nested_context["result"]["data"].to_string();
    assert!(
        nested_text.contains("first")
            && !nested_text.contains("second")
            && !nested_text.contains("fork only"),
        "{nested_text}"
    );
    let source_after = call(
        &mut socket,
        11,
        "thread/read",
        json!({"threadId":source_id,"includeTurns":true}),
    )
    .await;
    assert_eq!(
        source_after["result"]["thread"]["turns"]
            .as_array()
            .unwrap()
            .len(),
        5
    );
    let source_archived = call(
        &mut socket,
        32,
        "areal/thread/archive",
        json!({"threadId":source_id}),
    )
    .await;
    assert_eq!(
        source_archived["result"]["archived"], true,
        "{source_archived}"
    );
    let retained = call(
        &mut socket,
        33,
        "areal/conversation/history",
        json!({"threadId":nested_id,"view":"inherited","maxBytes":512}),
    )
    .await;
    assert!(retained["result"]["data"].is_array(), "{retained}");
    let archived = call(
        &mut socket,
        30,
        "areal/thread/archive",
        json!({"threadId":fork_id}),
    )
    .await;
    assert_eq!(archived["result"]["archived"], true, "{archived}");
    let after_archive = call(
        &mut second,
        31,
        "areal/request/read",
        json!({"requestId":"fork-key"}),
    )
    .await;
    assert_eq!(
        after_archive["result"]["data"][0]["result"]["threadId"],
        fork_id
    );
    socket.close(None).await.unwrap();
    drop(socket);
    second.close(None).await.unwrap();
    drop(second);
    stop.cancel();
    server.await.unwrap().unwrap();
    engine.shutdown().await;
    drop(engine);
    let restored = Engine::open(dir.path(), model, limits).unwrap();
    let receipt = restored
        .find_request("trusted-embedded-host", "fork-key")
        .await
        .unwrap();
    assert_eq!(receipt["data"][0]["result"]["threadId"], fork_id);
    // 归档后的热投影只显示继承块；最新本地请求应从持久原文核验。
    let inherited = restored.context_read(fork_id, 0, 32).await.unwrap();
    let texts = inherited["data"].to_string();
    assert!(texts.contains("first"), "{texts}");
    assert!(!texts.contains("LATER_SENTINEL"), "{texts}");
    assert_eq!(
        inherited["data"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["text"]
                .as_str()
                .is_some_and(|text| text.starts_with("first ")))
            .count(),
        1
    );
    let original = restored.read(fork_id, true).await.unwrap();
    assert!(original.context_checkpoint.is_some());
    assert_eq!(
        original
            .turns
            .iter()
            .flat_map(|turn| &turn.items)
            .filter(|item| {
                matches!(item, areal_protocol::Item::UserMessage { content, .. }
                if content.len() == 1 && content[0].as_text() == "after compact")
            })
            .count(),
        1
    );
}

// AC03 使用公开入口建立真实控制状态；主 Goal 的 goalOwner 合法为空，不伪造 Worker 归属。
struct PopulatedSourceModel;
#[async_trait]
impl Model for PopulatedSourceModel {
    fn name(&self) -> &str {
        "populated-source-fixture"
    }
    fn capabilities(&self) -> ModelCapabilities {
        TextModel(Mutex::new(Vec::new())).capabilities()
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, _: Vec<Value>) -> anyhow::Result<ModelStream> {
        let held = messages
            .iter()
            .rev()
            .find(|m| m.role == "user")
            .is_some_and(|m| m.text_content().contains("AC03_HOLD_GOAL"));
        let event = if held {
            ModelEvent::ToolCall(ToolCall { id: "ac03-question".into(), name: "ask_user_question".into(),
                arguments: json!({"questions":[{"id":"confirm","title":"Hold source at this barrier","options":[],"allowFreeText":true}],"mode":"wait","timeoutSeconds":300}).to_string() })
        } else {
            ModelEvent::TextDelta("anchor complete".into())
        };
        Ok(Box::pin(futures_util::stream::iter([
            Ok(event),
            Ok(ModelEvent::Usage(areal_protocol::ModelUsage {
                input_tokens: 11,
                cached_input_tokens: 2,
                output_tokens: 7,
            })),
        ])))
    }
}

#[tokio::test]
async fn fork_from_populated_source_has_independent_execution_state() {
    unsafe {
        std::env::set_var("AREAL_DEV_CONVERSATION_DERIVATION", "1");
    }
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(
        dir.path(),
        Arc::new(PopulatedSourceModel),
        Limits::default(),
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let stop = CancellationToken::new();
    let server = tokio::spawn(areal_app_server::serve(
        listener,
        engine.clone(),
        stop.clone(),
    ));
    let (mut socket, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    call(
        &mut socket,
        1,
        "initialize",
        json!({"clientInfo":{"name":"ac03","version":"1"}}),
    )
    .await;
    socket
        .send(Wire::Text(
            json!({"method":"initialized"}).to_string().into(),
        ))
        .await
        .unwrap();
    let definition = json!({"name":"source_only","description":"Source host binding","inputSchema":{"type":"object","properties":{},"additionalProperties":false}});
    let source = call(
        &mut socket,
        2,
        "thread/start",
        json!({"cwd":"/workspace","dynamicTools":[definition.clone()]}),
    )
    .await;
    let source_id = source["result"]["thread"]["id"].as_str().unwrap();
    assert_eq!(source["result"]["thread"]["dynamicTools"][0], definition);
    let anchor = call(
        &mut socket,
        3,
        "turn/start",
        json!({"threadId":source_id,"input":[{"type":"text","text":"AC03_COMPLETED_ANCHOR"}]}),
    )
    .await;
    let anchor_id = anchor["result"]["turn"]["id"].as_str().unwrap();
    completed(&mut socket, source_id).await;
    let goal = call(&mut socket, 4, "areal/goal/create", json!({"requestId":"ac03-goal","threadId":source_id,"expectedRevision":0,"objective":"AC03_HOLD_GOAL","maxTurns":2,"interactionMode":"interactive"})).await;
    assert!(goal.get("result").is_some(), "{goal}");
    let interactions = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let value = call(
                &mut socket,
                5,
                "areal/interaction/list",
                json!({"threadId":source_id}),
            )
            .await;
            if value["result"]["data"]
                .as_array()
                .is_some_and(|v| v.iter().any(|i| i["status"] == "pending"))
            {
                break value;
            }

            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    if interactions.is_err() {
        eprintln!(
            "AC03_FAILED_STATE {}",
            call(
                &mut socket,
                99,
                "thread/read",
                json!({"threadId":source_id,"includeTurns":true})
            )
            .await
        );
    }
    let interactions = interactions.unwrap();
    let queued = call(&mut socket, 6, "areal/turn/enqueue", json!({"requestId":"ac03-queued","threadId":source_id,"input":[{"type":"text","text":"AC03_SOURCE_QUEUE"}]})).await;
    assert!(queued["result"]["queueItemId"].is_string(), "{queued}");
    let source_before = call(
        &mut socket,
        7,
        "thread/read",
        json!({"threadId":source_id,"includeTurns":true}),
    )
    .await;
    let source_inspect = call(
        &mut socket,
        8,
        "areal/thread/inspect",
        json!({"threadId":source_id}),
    )
    .await;
    let source_queue = call(
        &mut socket,
        9,
        "areal/queue/list",
        json!({"threadId":source_id}),
    )
    .await;
    assert!(
        source_before["result"]["thread"]["goals"]["goal"].is_object(),
        "{source_before}"
    );
    assert_eq!(
        source_queue["result"]["items"][0]["status"], "pending",
        "{source_queue}"
    );
    assert!(
        source_inspect["result"]["activeTurnId"].is_string(),
        "{source_inspect}"
    );
    assert!(
        source_inspect["result"]["tools"]
            .to_string()
            .contains("source_only"),
        "{source_inspect}"
    );
    let created = call(&mut socket, 10, "areal/thread/fork", json!({"requestId":"ac03-fork","sourceThreadId":source_id,"anchor":{"turnId":anchor_id,"boundary":"after"},"workspaceMode":"sharedCurrent"})).await;
    let fork_id = created["result"]["thread"]["id"].as_str().unwrap();
    let fork = call(
        &mut socket,
        11,
        "thread/read",
        json!({"threadId":fork_id,"includeTurns":true}),
    )
    .await;
    let thread = &fork["result"]["thread"];
    assert_eq!(thread["turns"], json!([]));
    assert!(thread["dynamicTools"].is_null() || thread["dynamicTools"] == json!([]));
    assert!(thread["goalOwner"].is_null());
    assert!(
        thread["goals"].is_null() || thread["goals"]["goal"].is_null(),
        "{thread}"
    );
    assert_ne!(
        thread["sessionId"],
        source_before["result"]["thread"]["sessionId"]
    );
    assert!(
        call(
            &mut socket,
            12,
            "areal/queue/list",
            json!({"threadId":fork_id})
        )
        .await["result"]["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        call(
            &mut socket,
            13,
            "areal/interaction/list",
            json!({"threadId":fork_id})
        )
        .await["result"]["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let inspected = call(
        &mut socket,
        14,
        "areal/thread/inspect",
        json!({"threadId":fork_id}),
    )
    .await;
    assert!(inspected["result"]["activeTurnId"].is_null());
    assert!(
        !inspected["result"]["tools"]
            .to_string()
            .contains("source_only")
    );
    // 目标取消不接触来源的待回答交互、Goal 或队列。
    let target_turn = call(
        &mut socket,
        15,
        "turn/start",
        json!({"threadId":fork_id,"input":[{"type":"text","text":"AC03_HOLD_GOAL"}]}),
    )
    .await;
    // 来源的真实待回答交互不能借目标 Thread/Turn 身份控制，两个 ID 都来自公开回读。
    let source_interaction = interactions["result"]["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["status"] == "pending")
        .unwrap();
    for (turn_id, expected_code) in [
        (source_interaction["turnId"].clone(), -32009),
        (target_turn["result"]["turn"]["id"].clone(), -32004),
    ] {
        let denied = call(
            &mut socket,
            151,
            "areal/interaction/respond",
            json!({
                "threadId":fork_id, "turnId":turn_id, "requestId":source_interaction["requestId"],
                "answers":{"confirm":"must not reach source"}
            }),
        )
        .await;
        assert_eq!(denied["error"]["code"], expected_code, "{denied}");
    }
    call(
        &mut socket,
        16,
        "turn/interrupt",
        json!({"threadId":fork_id,"turnId":target_turn["result"]["turn"]["id"]}),
    )
    .await;
    engine.wait(fork_id).await.unwrap();
    let after = call(
        &mut socket,
        17,
        "areal/thread/inspect",
        json!({"threadId":source_id}),
    )
    .await;
    assert_eq!(
        after["result"]["activeTurnId"],
        source_inspect["result"]["activeTurnId"]
    );
    assert_eq!(
        call(
            &mut socket,
            18,
            "areal/interaction/list",
            json!({"threadId":source_id})
        )
        .await["result"],
        interactions["result"]
    );
    assert_eq!(
        call(
            &mut socket,
            19,
            "areal/queue/list",
            json!({"threadId":source_id})
        )
        .await["result"],
        source_queue["result"]
    );
    // 非零用量只进入目标自己的执行账本；继承种子保留来源身份，不转成目标新采样。
    let expected_usage = json!({"inputTokens":11,"cachedInputTokens":2,"outputTokens":7});
    assert_eq!(
        source_before["result"]["thread"]["turns"][0]["usage"],
        expected_usage
    );
    let own = call(
        &mut socket,
        20,
        "turn/start",
        json!({"threadId":fork_id,"input":[{"type":"text","text":"AC70_FORK_OWN_SAMPLE"}]}),
    )
    .await;
    assert!(own["result"]["turn"].is_object(), "{own}");
    completed(&mut socket, fork_id).await;
    let side = call(&mut socket, 21, "areal/side/start", json!({"requestId":"ac71-billable-side","sourceThreadId":source_id,"anchor":{"kind":"turn","turnId":anchor_id,"boundary":"after"},"workspaceAccess":"none","input":[{"type":"text","text":"AC71_SIDE_OWN_SAMPLE"}]})).await;
    let side_id = side["result"]["thread"]["id"].as_str().unwrap();
    completed(&mut socket, side_id).await;
    let fork_export = call(
        &mut socket,
        22,
        "thread/read",
        json!({"threadId":fork_id,"includeTurns":true}),
    )
    .await;
    let side_export = call(
        &mut socket,
        23,
        "thread/read",
        json!({"threadId":side_id,"includeTurns":true}),
    )
    .await;
    assert_eq!(
        fork_export["result"]["thread"]["turns"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["usage"],
        expected_usage
    );
    assert_eq!(
        side_export["result"]["thread"]["turns"][0]["usage"],
        expected_usage
    );
    assert_eq!(
        fork_export["result"]["thread"]["turns"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        fork_export["result"]["thread"]["conversation"]["historySeed"]["turnCount"],
        1
    );
    assert_eq!(
        fork_export["result"]["thread"]["conversation"]["origin"]["sourceThreadId"],
        source_id
    );
    assert_ne!(
        side_export["result"]["thread"]["sessionId"],
        source_before["result"]["thread"]["sessionId"]
    );
    assert!(side_export["result"]["thread"]["goalOwner"].is_null());
    assert!(side_export["result"]["thread"]["goals"]["goal"].is_null());
    let source_after_usage = call(
        &mut socket,
        24,
        "thread/read",
        json!({"threadId":source_id,"includeTurns":true}),
    )
    .await;
    assert_eq!(
        source_after_usage["result"]["thread"]["turns"],
        source_before["result"]["thread"]["turns"]
    );
    for counter in [
        "inputTokens",
        "cachedInputTokens",
        "outputTokens",
        "tokensUsed",
        "turnsStarted",
    ] {
        assert_eq!(
            source_after_usage["result"]["thread"]["goals"]["goal"]["usage"][counter],
            source_before["result"]["thread"]["goals"]["goal"]["usage"][counter]
        );
    }
    // 使用真实 Side 与其完成轮次验证来源类型，不以不存在的锚点代替类型拒绝。
    let threads_before = engine.list(None, 100, None).await.unwrap().0.len();
    let rejected_side = call(&mut socket, 25, "areal/thread/fork", json!({
        "requestId":"ac23-side-source", "sourceThreadId":side_id,
        "anchor":{"turnId":side_export["result"]["thread"]["turns"][0]["id"],"boundary":"after"},
        "workspaceMode":"sharedCurrent"
    })).await;
    assert_eq!(
        rejected_side["error"]["data"]["reason"], "SOURCE_KIND_UNSUPPORTED",
        "{rejected_side}"
    );
    assert_eq!(
        engine.list(None, 100, None).await.unwrap().0.len(),
        threads_before
    );
    assert_eq!(
        call(
            &mut socket,
            26,
            "thread/read",
            json!({"threadId":side_id,"includeTurns":true})
        )
        .await["result"],
        side_export["result"]
    );
    let source_after_refusal = call(
        &mut socket,
        27,
        "thread/read",
        json!({"threadId":source_id,"includeTurns":true}),
    )
    .await;
    // 活跃 Goal 的计时会自然推进；比较实际控制与执行记录。
    for field in ["turns", "desktop", "status"] {
        assert_eq!(
            source_after_refusal["result"]["thread"][field],
            source_after_usage["result"]["thread"][field],
            "source field {field} changed"
        );
    }
    println!(
        "AC16_AC23 actualSourcePendingInteractionRejectedByTarget=true sourceStateUnchanged=true actualSideSourceRejected=true targetCountUnchanged=true"
    );
    println!(
        "AC03_AC70_AC71 {}",
        json!({"sourceDynamicTools":1,"sourcePendingInteractions":1,"sourcePendingQueue":1,"sourceGoalPresent":true,"sourceTurnHeld":true,"forkOwnUsage":expected_usage,"sideOwnUsage":expected_usage,"sourceGoalTokenAndTurnCountersUnchanged":true,"inheritedTurns":1,"forkLocalTurns":2,"deploymentAccounting":"no public deployment usage aggregate RPC; not measured","nativeProcessResources":"no Runtime attached; not measured","goalOwner":"main root is null by contract, no fabricated Worker source"})
    );
    drop(socket);
    stop.cancel();
    server.await.unwrap().unwrap();
    engine.shutdown().await;
}

struct CapacityModel {
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}
#[async_trait]
impl Model for CapacityModel {
    fn name(&self) -> &str {
        "capacity-barrier-fixture"
    }
    fn capabilities(&self) -> ModelCapabilities {
        TextModel(Mutex::new(Vec::new())).capabilities()
    }
    async fn stream(&self, messages: Vec<Message>) -> anyhow::Result<ModelStream> {
        if messages
            .last()
            .is_some_and(|m| m.text_content() == "AC77_SOURCE_PROGRESS")
        {
            self.entered.notify_one();
            self.release.notified().await;
        }
        Ok(Box::pin(futures_util::stream::iter([Ok("answer".into())])))
    }
}

// 手动基准输出原始样本；无统计 SLA，时间包括真实公开 WebSocket RPC 和持久快照写入。
#[tokio::test]
#[ignore = "repeatable AC77 capacity benchmark; run with --ignored --nocapture"]
async fn conversation_derivation_capacity_benchmark() {
    unsafe {
        std::env::set_var("AREAL_DEV_CONVERSATION_DERIVATION", "1");
    }
    let limit = 128 * 1024;
    for (size_name, text_bytes) in [
        ("small", 1024),
        ("medium", 48 * 1024),
        ("near_limit", 118 * 1024),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let model = Arc::new(CapacityModel {
            entered: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
        });
        let limits = Limits {
            max_history_bytes: limit,
            model_concurrency: 1,
            max_side_turns_per_source: 1,
            max_side_turns_per_deployment: 1,
            ..Limits::default()
        };
        let engine = Engine::open(dir.path(), model.clone(), limits).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let stop = CancellationToken::new();
        let server = tokio::spawn(areal_app_server::serve(
            listener,
            engine.clone(),
            stop.clone(),
        ));
        let (mut socket, _) = tokio_tungstenite::connect_async(url).await.unwrap();
        call(
            &mut socket,
            1,
            "initialize",
            json!({"clientInfo":{"name":"ac77","version":"1"}}),
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
        let anchor = call(
            &mut socket,
            3,
            "turn/start",
            json!({"threadId":source_id,"input":[{"type":"text","text":"x".repeat(text_bytes)}]}),
        )
        .await;
        let anchor_id = anchor["result"]["turn"]["id"].as_str().unwrap();
        completed(&mut socket, source_id).await;
        let active = call(
            &mut socket,
            4,
            "turn/start",
            json!({"threadId":source_id,"input":[{"type":"text","text":"AC77_SOURCE_PROGRESS"}]}),
        )
        .await;
        assert!(active["result"]["turn"].is_object(), "{active}");
        tokio::time::timeout(Duration::from_secs(5), model.entered.notified())
            .await
            .unwrap();
        for sample in 0..5 {
            let started = std::time::Instant::now();
            let fork = call(&mut socket, 5, "areal/thread/fork", json!({"requestId":format!("ac77-{size_name}-{sample}"),"sourceThreadId":source_id,"anchor":{"turnId":anchor_id,"boundary":"after"},"workspaceMode":"sharedCurrent"})).await;
            let elapsed_us = started.elapsed().as_micros();
            let seed = &fork["result"]["thread"]["conversation"]["historySeed"];
            assert!(seed["logicalBytes"].is_u64(), "{fork}");
            assert!(seed["logicalBytes"].as_u64().unwrap() <= limit as u64);
            let source_state = call(
                &mut socket,
                6,
                "areal/thread/inspect",
                json!({"threadId":source_id}),
            )
            .await;
            assert_eq!(
                source_state["result"]["activeTurnId"],
                active["result"]["turn"]["id"]
            );
            println!(
                "AC77_SAMPLE {}",
                json!({"size":size_name,"sample":sample,"inputTextBytes":text_bytes,"snapshotLimitBytes":limit,"prefixBytes":seed["logicalBytes"],"prefixItems":seed["itemCount"],"prefixTurns":seed["turnCount"],"creationMicros":elapsed_us,"sourceActiveDuringCreation":true,"modelConcurrency":1,"sideSourceSlots":1,"sideDeploymentSlots":1})
            );
        }
        let side_started = std::time::Instant::now();
        let side = call(&mut socket, 7, "areal/side/start", json!({"requestId":"ac77-side","sourceThreadId":source_id,"anchor":{"kind":"turn","turnId":anchor_id,"boundary":"after"},"workspaceAccess":"none","input":[{"type":"text","text":"explain"}]})).await;
        let side_id = side["result"]["thread"]["id"].as_str().unwrap();
        let admission_us = side_started.elapsed().as_micros();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let state = call(
                    &mut socket,
                    8,
                    "thread/read",
                    json!({"threadId":side_id,"includeTurns":false}),
                )
                .await;
                if state["result"]["thread"]["desktop"]["sideCapacityStatus"] == "waiting" {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let rejected = call(&mut socket, 9, "areal/side/start", json!({"requestId":"ac77-over-quota","sourceThreadId":source_id,"workspaceAccess":"none","input":[{"type":"text","text":"over quota"}]})).await;
        assert!(
            rejected["error"]
                .to_string()
                .contains("SIDE_SOURCE_CAPACITY_REACHED"),
            "{rejected}"
        );
        call(
            &mut socket,
            10,
            "turn/interrupt",
            json!({"threadId":side_id,"turnId":side["result"]["turn"]["id"]}),
        )
        .await;
        engine.wait(side_id).await.unwrap();
        let reclaimed = call(&mut socket, 11, "areal/side/start", json!({"requestId":"ac77-reclaimed","sourceThreadId":source_id,"anchor":{"kind":"turn","turnId":anchor_id,"boundary":"after"},"workspaceAccess":"none","input":[{"type":"text","text":"slot reclaimed"}]})).await;
        let reclaimed_id = reclaimed["result"]["thread"]["id"].as_str().unwrap();
        let release_started = std::time::Instant::now();
        model.release.notify_one();
        completed(&mut socket, source_id).await;
        completed(&mut socket, reclaimed_id).await;
        println!(
            "AC77_CAPACITY {}",
            json!({"size":size_name,"sideAdmissionMicros":admission_us,"sideWaitedForModel":true,"quotaRejected":true,"slotReclaimedAfterStop":true,"sourceCompletedAfterReleaseMicros":release_started.elapsed().as_micros(),"memoryScope":"wrapper RUSAGE_CHILDREN maximum RSS includes cargo and test compilation; no per-snapshot memory attribution"})
        );
        drop(socket);
        stop.cancel();
        server.await.unwrap().unwrap();
        engine.shutdown().await;
    }
    rejected_fork_snapshot_is_reclaimed().await;
}

async fn rejected_fork_snapshot_is_reclaimed() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(
        dir.path(),
        Arc::new(TextModel(Mutex::new(Vec::new()))),
        Limits {
            max_threads: 1,
            ..Limits::default()
        },
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let stop = CancellationToken::new();
    let server = tokio::spawn(areal_app_server::serve(
        listener,
        engine.clone(),
        stop.clone(),
    ));
    let (mut socket, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    call(
        &mut socket,
        1,
        "initialize",
        json!({"clientInfo":{"name":"ac77-gc","version":"1"}}),
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
    let anchor = call(
        &mut socket,
        3,
        "turn/start",
        json!({"threadId":source_id,"input":[{"type":"text","text":"retained source"}]}),
    )
    .await;
    completed(&mut socket, source_id).await;
    let before = std::fs::read_dir(dir.path().join("history"))
        .map(|v| v.count())
        .unwrap_or(0);
    let rejected = call(&mut socket, 4, "areal/thread/fork", json!({"requestId":"ac77-rejected-target","sourceThreadId":source_id,"anchor":{"turnId":anchor["result"]["turn"]["id"],"boundary":"after"},"workspaceMode":"sharedCurrent"})).await;
    assert!(
        rejected["error"]
            .to_string()
            .contains("thread capacity reached"),
        "{rejected}"
    );
    let staged = std::fs::read_dir(dir.path().join("history"))
        .unwrap()
        .count();
    assert!(
        staged > before,
        "capacity rejection did not exercise an unreferenced snapshot"
    );
    let list = call(
        &mut socket,
        5,
        "areal/conversation/list",
        json!({"view":"all"}),
    )
    .await;
    assert_eq!(list["result"]["data"].as_array().unwrap().len(), 1);
    let receipt = call(
        &mut socket,
        6,
        "areal/request/read",
        json!({"requestId":"ac77-rejected-target"}),
    )
    .await;
    assert!(receipt["result"]["data"].as_array().unwrap().is_empty());
    let drained = call(
        &mut socket,
        7,
        "areal/server/drain",
        json!({"strategy":"ifIdle","timeoutMs":0}),
    )
    .await;
    assert_eq!(drained["result"]["restartSafe"], true, "{drained}");
    let gc = call(&mut socket, 8, "areal/server/gc", json!({})).await;
    assert!(gc.get("result").is_some(), "{gc}");
    let remaining = std::fs::read_dir(dir.path().join("history"))
        .unwrap()
        .count();
    assert_eq!(remaining, before);
    let retained = call(
        &mut socket,
        9,
        "thread/read",
        json!({"threadId":source_id,"includeTurns":true}),
    )
    .await;
    assert!(retained.to_string().contains("retained source"));
    println!(
        "AC77_RECLAIM {}",
        json!({"rejection":"thread capacity reached","threadLimit":1,"targetsAfterRejection":0,"receiptsAfterRejection":0,"snapshotFilesBefore":before,"snapshotFilesAfterRejection":staged,"snapshotFilesAfterGc":remaining,"sourceRetained":true})
    );
    drop(socket);
    stop.cancel();
    server.await.unwrap().unwrap();
    engine.shutdown().await;
}
