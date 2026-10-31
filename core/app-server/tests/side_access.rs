use areal_app_server::auth::{Authentication, Permission, Principal};
use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelStream},
};
use areal_protocol::Input;
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc, time::Duration};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{Message as Wire, client::IntoClientRequest},
};
use tokio_util::sync::CancellationToken;

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
struct TextModel;
#[async_trait]
impl Model for TextModel {
    fn name(&self) -> &str {
        "side-access-fixture"
    }
    fn configure(
        &self,
        _: &areal_protocol::desktop::ModelParameters,
    ) -> anyhow::Result<Arc<dyn Model>> {
        Ok(Arc::new(TextModel))
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        Ok(Box::pin(futures_util::stream::iter([Ok(
            areal_engine::model::ModelEvent::text("answer"),
        )])))
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
async fn connect(addr: std::net::SocketAddr, token: &str) -> Socket {
    let mut request = format!("ws://{addr}").into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Authorization", format!("Bearer {token}").parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    assert!(
        call(
            &mut socket,
            1,
            "initialize",
            json!({"clientInfo":{"name":"legacy","version":"1"}})
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
    socket
}
fn principal(
    id: &str,
    token: &str,
    permissions: &[Permission],
    thread_ids: Option<Vec<String>>,
) -> Principal {
    Principal {
        id: id.into(),
        token: token.into(),
        permissions: permissions.iter().cloned().collect(),
        thread_ids: thread_ids.map(|ids| ids.into_iter().collect::<BTreeSet<_>>()),
    }
}

#[tokio::test]
async fn authenticated_side_access_and_legacy_routes_preserve_policy() {
    unsafe {
        std::env::set_var("AREAL_DEV_CONVERSATION_DERIVATION", "1");
    }
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(TextModel), Limits::default()).unwrap();
    let source = engine.create("/workspace".into()).await.unwrap();
    engine
        .start(&source.id, vec![Input::text("source secret")])
        .await
        .unwrap();
    engine.wait(&source.id).await.unwrap();
    let tokens = [
        "side-owner-token-12345678901234567890",
        "side-observe-token-1234567890123456",
        "side-scoped-token-12345678901234567",
        "side-target-token-12345678901234567",
    ];
    let auth = Authentication {
        version: 1,
        principals: vec![
            principal(
                "owner",
                tokens[0],
                &[
                    Permission::Observe,
                    Permission::Interact,
                    Permission::Manage,
                ],
                None,
            ),
            principal("observer", tokens[1], &[Permission::Observe], None),
            principal(
                "scoped",
                tokens[2],
                &[Permission::Observe, Permission::Interact],
                Some(vec![source.id.clone()]),
            ),
            principal("target", tokens[3], &[Permission::Observe], Some(vec![])),
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
    let mut owner = connect(addr, tokens[0]).await;
    let mut observer = connect(addr, tokens[1]).await;
    let mut scoped = connect(addr, tokens[2]).await;
    let mut target = connect(addr, tokens[3]).await;
    let create = |request_id: &str| {
        json!({"requestId":request_id,"sourceThreadId":source.id,
        "workspaceAccess":"none","input":[{"type":"text","text":"Explain evidence"}]})
    };
    let denied = call(
        &mut observer,
        2,
        "areal/side/start",
        create("observer-side"),
    )
    .await;
    assert_eq!(denied["error"]["code"], -32003, "{denied}");
    let scoped_denied = call(&mut scoped, 2, "areal/side/start", create("scoped-side")).await;
    assert_eq!(
        scoped_denied["error"]["data"]["reason"], "SCOPED_PRINCIPAL_UNSUPPORTED",
        "{scoped_denied}"
    );
    let side = call(&mut owner, 2, "areal/side/start", create("owner-side-a")).await;
    let side_id = side["result"]["thread"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("{}", side))
        .to_owned();
    engine
        .start(&source.id, vec![Input::text("later source evidence")])
        .await
        .unwrap();
    engine.wait(&source.id).await.unwrap();
    let other = call(&mut owner, 3, "areal/side/start", create("owner-side-b")).await;
    let other_id = other["result"]["thread"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("{}", other))
        .to_owned();
    engine.wait(&side_id).await.unwrap();
    let before_configure = call(&mut owner, 6, "thread/read", json!({"threadId":side_id})).await;
    let before = &before_configure["result"]["thread"];
    let revision = before["desktop"]["configuration"]["revision"]
        .as_u64()
        .unwrap();
    let configured = call(
        &mut owner,
        7,
        "areal/thread/configure",
        json!({"threadId":side_id,
        "expectedRevision":revision,"parameters":{"temperature":0.2}}),
    )
    .await;
    assert_eq!(
        configured["result"]["revision"],
        revision + 1,
        "{configured}"
    );
    assert_eq!(configured["result"]["readOnly"], true, "{configured}");
    assert_eq!(
        configured["result"]["toolAllowlist"],
        before["desktop"]["configuration"]["toolAllowlist"]
    );
    assert_eq!(configured["result"]["parameters"]["temperature"], 0.2);
    let after_configure = call(&mut owner, 8, "thread/read", json!({"threadId":side_id})).await;
    assert_eq!(
        after_configure["result"]["thread"]["conversation"],
        before["conversation"]
    );
    for extra in [
        json!({"options":{"readOnly":false},"parameters":{"temperature":0.3}}),
        json!({"agentProfile":{"id":"workflow","revision":"1"}}),
        json!({"selectedSkills":[]}),
        json!({"resetModel":true}),
    ] {
        let mut params = json!({"threadId":side_id,"expectedRevision":revision + 1});
        params
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let rejected = call(&mut owner, 9, "areal/thread/configure", params).await;
        assert_eq!(
            rejected["error"]["data"]["reason"], "SIDE_POLICY_VIOLATION",
            "{rejected}"
        );
    }
    let unchanged = call(&mut owner, 10, "thread/read", json!({"threadId":side_id})).await;
    assert_eq!(
        unchanged["result"]["thread"]["desktop"]["configuration"],
        configured["result"]
    );
    let list = call(
        &mut target,
        2,
        "areal/conversation/list",
        json!({"view":"side"}),
    )
    .await;
    assert_eq!(list["result"]["data"], json!([]), "{list}");
    let read = call(&mut target, 3, "thread/read", json!({"threadId":side_id})).await;
    assert_eq!(read["error"]["code"], -32003, "{read}");
    let source_read = call(&mut scoped, 3, "thread/read", json!({"threadId":side_id})).await;
    assert_eq!(source_read["error"]["code"], -32003, "{source_read}");
    let evidence = call(
        &mut owner,
        4,
        "areal/side/context/read",
        json!({"threadId":other_id}),
    )
    .await;
    let reference = evidence["result"]["evidence"][0]["evidenceRef"]
        .as_str()
        .unwrap();
    let crossed = call(
        &mut owner,
        5,
        "areal/side/context/read",
        json!({"threadId":side_id,"evidenceRef":reference}),
    )
    .await;
    assert!(crossed["error"].is_object(), "{crossed}");
    for (method, params) in [
        (
            "areal/goal/create",
            json!({"threadId":side_id,"requestId":"legacy-goal","objective":"write","expectedRevision":0}),
        ),
        (
            "areal/process/start",
            json!({"threadId":side_id,"requestId":"legacy-process","argv":["echo","bad"]}),
        ),
        (
            "areal/thread/configure",
            json!({"threadId":side_id,"expectedRevision":0,"options":{"readOnly":false}}),
        ),
        (
            "areal/agent/spawn",
            json!({"parentThreadId":side_id,"requestId":"legacy-agent","prompt":"write"}),
        ),
        (
            "areal/agent/delegate",
            json!({"parentThreadId":side_id,"requestId":"side-delegate","input":[{"type":"text","text":"inspect"}]}),
        ),
        (
            "turn/steer",
            json!({"threadId":side_id,"expectedTurnId":"missing","input":[{"type":"text","text":"write"}]}),
        ),
    ] {
        let result = call(&mut owner, 20, method, params).await;
        assert_eq!(
            result["error"]["data"]["reason"], "SIDE_POLICY_VIOLATION",
            "{method}: {result}"
        );
    }
    let bad_route = call(
        &mut owner,
        30,
        "areal/side/context/read",
        json!({"threadId":side_id,"cursor":"bad"}),
    )
    .await;
    assert_ne!(bad_route["error"]["code"], -32601, "{bad_route}");
    drop(owner);
    drop(observer);
    drop(scoped);
    drop(target);
    stop.cancel();
    server.await.unwrap().unwrap();
    let auth = Authentication {
        version: 1,
        principals: vec![principal(
            "owner",
            tokens[3],
            &[Permission::Observe],
            Some(vec![side_id.clone()]),
        )],
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
    let mut target = connect(addr, tokens[3]).await;
    let own = call(
        &mut target,
        40,
        "areal/side/context/read",
        json!({"threadId":side_id}),
    )
    .await;
    assert!(own["result"]["evidence"].is_array(), "{own}");
    let list = call(
        &mut target,
        41,
        "areal/conversation/list",
        json!({"view":"side"}),
    )
    .await;
    assert_eq!(
        list["result"]["data"].as_array().unwrap().len(),
        1,
        "{list}"
    );
    assert_eq!(list["result"]["data"][0]["id"], side_id);
    let source_read = call(
        &mut target,
        42,
        "thread/read",
        json!({"threadId":source.id}),
    )
    .await;
    assert_eq!(source_read["error"]["code"], -32003, "{source_read}");
    let other_read = call(
        &mut target,
        43,
        "areal/side/context/read",
        json!({"threadId":other_id}),
    )
    .await;
    assert_eq!(other_read["error"]["code"], -32003, "{other_read}");
    let cross_ref = call(
        &mut target,
        44,
        "areal/side/context/read",
        json!({"threadId":side_id,"evidenceRef":reference}),
    )
    .await;
    assert!(cross_ref["error"].is_object(), "{cross_ref}");
    let hidden_receipt = call(
        &mut target,
        46,
        "areal/request/read",
        json!({"requestId":"owner-side-b"}),
    )
    .await;
    assert_eq!(
        hidden_receipt["result"]["data"],
        json!([]),
        "{hidden_receipt}"
    );
    let hidden_null = call(
        &mut target,
        48,
        "areal/request/read",
        json!({"requestId":"owner-side-b","threadId":null}),
    )
    .await;
    assert_eq!(hidden_null["result"]["data"], json!([]), "{hidden_null}");
    let own_receipt = call(
        &mut target,
        47,
        "areal/request/read",
        json!({"threadId":side_id,"requestId":"owner-side-a"}),
    )
    .await;
    assert_eq!(
        own_receipt["result"]["data"][0]["requestId"], "owner-side-a",
        "{own_receipt}"
    );
    let filtered = call(
        &mut target,
        45,
        "areal/conversation/list",
        json!({"view":"side","sourceThreadId":source.id}),
    )
    .await;
    assert_eq!(filtered["error"]["code"], -32003, "{filtered}");
    let guessed_blob = reqwest::Client::new()
        .get(format!(
            "http://{addr}/areal/blobs/{}?threadId={side_id}",
            "a".repeat(64)
        ))
        .bearer_auth(tokens[3])
        .send()
        .await
        .unwrap();
    assert_eq!(guessed_blob.status(), reqwest::StatusCode::NOT_FOUND);
    drop(target);
    stop.cancel();
    server.await.unwrap().unwrap();
    engine.wait(&side_id).await.unwrap();
    engine.shutdown().await;
    drop(engine);
    let valid = Engine::open(dir.path(), Arc::new(TextModel), Limits::default()).unwrap();
    let restored = valid.read(&side_id, false).await.unwrap();
    assert!(restored.is_side());
    assert_eq!(
        restored.desktop.unwrap().configuration.revision,
        revision + 1
    );
    valid.shutdown().await;
    drop(valid);
    let path = dir.path().join(format!("{side_id}.json"));
    let mut record: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(record["version"], areal_engine::state_version());
    assert_eq!(record["thread"]["conversation"]["kind"], "side");
    record["version"] = json!(13);
    std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    let refusal = Engine::open(dir.path(), Arc::new(TextModel), Limits::default())
        .err()
        .expect("version 13 Side record loaded as an ordinary conversation");
    assert!(
        refusal.to_string().contains("unsupported Side policy"),
        "{refusal}"
    );
}

#[tokio::test]
async fn recovered_side_unknown_can_be_inspected_without_changing_outcome() {
    unsafe {
        std::env::set_var("AREAL_DEV_CONVERSATION_DERIVATION", "1");
    }
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(TextModel), Limits::default()).unwrap();
    let source = engine.create("/workspace".into()).await.unwrap();
    engine
        .start(&source.id, vec![Input::text("source evidence")])
        .await
        .unwrap();
    engine.wait(&source.id).await.unwrap();
    engine.shutdown().await;
    drop(engine);
    let inject_unknown = |thread_id: &str, item_id: &str| {
        let path = dir.path().join(format!("{thread_id}.json"));
        let mut record: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        record["thread"]["turns"][0]["items"].as_array_mut().unwrap().push(json!({
            "type":"dynamicToolCall","id":item_id,"tool":"side_context_read","arguments":{},
            "status":"failed","success":false,"contentItems":null,"callId":format!("lost-{item_id}"),
            "execution":{"runtimeEpoch":"epoch","scopeId":"scope","operationId":item_id,"outcome":"unknown"}}));
        std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    };
    inject_unknown(&source.id, "source-unknown");
    let engine = Engine::open(dir.path(), Arc::new(TextModel), Limits::default()).unwrap();
    let (side, _) = engine
        .side_start(
            "owner".into(),
            serde_json::from_value(json!({
        "requestId":"unknown-side", "sourceThreadId":source.id,"workspaceAccess":"none",
        "input":[{"type":"text","text":"explain"}]}))
            .unwrap(),
        )
        .await
        .unwrap();
    engine.wait(&side.id).await.unwrap();
    engine.shutdown().await;
    drop(engine);
    inject_unknown(&side.id, "own-unknown");
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
        json!({"clientInfo":{"name":"test","version":"1"}}),
    )
    .await;
    socket
        .send(Wire::Text(
            json!({"method":"initialized"}).to_string().into(),
        ))
        .await
        .unwrap();
    let blocked = call(
        &mut socket,
        2,
        "turn/start",
        json!({"threadId":side.id,"input":[{"type":"text","text":"continue"}]}),
    )
    .await;
    assert!(blocked["error"].is_object(), "{blocked}");
    let inspected = call(&mut socket,3,"areal/tool/acknowledge",json!({"threadId":side.id,"itemId":"own-unknown","inspection":"Checked persisted evidence; outcome remains unconfirmed"})).await;
    assert!(inspected["error"].is_null(), "{inspected}");
    let forged = call(
        &mut socket,
        4,
        "areal/tool/acknowledge",
        json!({"threadId":side.id,"itemId":"source-unknown","inspection":"not owned"}),
    )
    .await;
    assert!(forged["error"].is_object(), "{forged}");
    let source_record = engine.read(&source.id, true).await.unwrap();
    let source_item = source_record.turns[0]
        .items
        .iter()
        .find(|item| item.id() == "source-unknown")
        .unwrap();
    let areal_protocol::Item::DynamicToolCall { execution, .. } = source_item else {
        panic!("tool expected")
    };
    assert!(execution.inspection.is_none());
    assert_eq!(execution.outcome, areal_protocol::ToolOutcome::Unknown);
    let thread = engine.read(&side.id, true).await.unwrap();
    let item = thread.turns[0]
        .items
        .iter()
        .find(|item| item.id() == "own-unknown")
        .unwrap();
    let areal_protocol::Item::DynamicToolCall { execution, .. } = item else {
        panic!("tool expected")
    };
    assert_eq!(execution.outcome, areal_protocol::ToolOutcome::Unknown);
    assert!(execution.inspection.is_some());
    let archived = call(
        &mut socket,
        5,
        "areal/thread/archive",
        json!({"threadId":side.id}),
    )
    .await;
    assert!(archived["error"].is_null(), "{archived}");
    drop(socket);
    stop.cancel();
    server.await.unwrap().unwrap();
    engine.shutdown().await;
}
