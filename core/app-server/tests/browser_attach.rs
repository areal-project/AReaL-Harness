use areal_app_server::auth::{Authentication, Permission, Principal};
use areal_engine::{
    Engine, Limits,
    model::{AgentStream, Message, Model, ModelEvent, ModelStream, ToolCall},
};
use areal_protocol::Input;
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{Message as Wire, client::IntoClientRequest},
};
use tokio_util::sync::CancellationToken;

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

struct ModelFixture;
#[async_trait]
impl Model for ModelFixture {
    fn name(&self) -> &str {
        "browser-attach-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<AgentStream> {
        let has_browser = tools
            .iter()
            .any(|tool| tool["function"]["name"] == "browser_v1");
        if let Some(tool) = tools
            .iter()
            .find(|tool| tool["function"]["name"] == "browser_v1")
        {
            let registered = areal_protocol::desktop::browser_v1_tool();
            assert_eq!(
                tool,
                &json!({"type":"function","function":{
                    "name":registered.name,"description":registered.description,"parameters":registered.input_schema
                }}),
                "actual model tool definition must preserve the deployed Browser identity"
            );
        }

        let guidance = messages.iter().any(|message| {
            message.role == "areal_context"
                && message
                    .text_content()
                    .starts_with("Built-in Browser guidance: ")
                && message
                    .text_content()
                    .contains("fresh observe before navigate")
        });
        assert_eq!(
            guidance, has_browser,
            "Browser guidance belongs to context only when its tool is visible"
        );
        let event = if has_browser && messages.last().is_some_and(|m| m.role != "tool") {
            ModelEvent::ToolCall(ToolCall {
                id: "browser-call-1".into(),
                name: "browser_v1".into(),
                arguments: json!({"operation":"describe","parameters":{}}).to_string(),
            })
        } else {
            ModelEvent::TextDelta(
                if has_browser {
                    "browser observed"
                } else {
                    "old history"
                }
                .into(),
            )
        };
        Ok(Box::pin(futures_util::stream::iter([Ok(event)])))
    }
}

async fn server(
    engine: Arc<Engine>,
) -> (
    String,
    CancellationToken,
    tokio::task::JoinHandle<anyhow::Result<()>>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let stop = CancellationToken::new();
    let auth = Authentication {
        version: 1,
        principals: vec![
            Principal {
                id: "desktop-owner".into(),
                token: "desktop-owner-test-token-1234567890".into(),
                permissions: [Permission::Observe, Permission::Interact, Permission::Tools].into(),
                thread_ids: None,
            },
            Principal {
                id: "other-host".into(),
                token: "other-host-test-token-12345678901234".into(),
                permissions: [Permission::Observe, Permission::Interact, Permission::Tools].into(),
                thread_ids: None,
            },
            Principal {
                id: "observer".into(),
                token: "observer-test-token-1234567890123456".into(),
                permissions: [Permission::Observe].into(),
                thread_ids: None,
            },
        ],
    };
    let task = tokio::spawn(areal_app_server::serve_authenticated(
        listener,
        engine,
        stop.clone(),
        Some(auth),
    ));
    (url, stop, task)
}

#[tokio::test]
async fn observer_subscribes_without_taking_the_browser_callback() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(ModelFixture), Limits::default()).unwrap();
    let (url, stop, task) = server(engine.clone()).await;
    let mut owner = connected(&url).await;
    let mut second_host = connected_with(&url, "other-host-test-token-12345678901234").await;
    let mut observer = connected_with(&url, "observer-test-token-1234567890123456").await;
    let tool = serde_json::to_value(areal_protocol::desktop::browser_v1_tool()).unwrap();
    let created = call(
        &mut owner,
        "thread/start",
        json!({"cwd":"/workspace","dynamicTools":[tool]}),
    )
    .await;
    let id = created["result"]["thread"]["id"].as_str().unwrap();
    let capabilities = call(&mut observer, "areal/capabilities", json!({})).await;
    assert!(
        capabilities["result"]["methods"]
            .as_array()
            .unwrap()
            .contains(&json!("areal/thread/observe"))
    );
    assert_eq!(
        call(&mut second_host, "thread/resume", json!({"threadId":id})).await["error"]["code"],
        -32009
    );
    assert_eq!(
        call(
            &mut observer,
            "areal/thread/observe",
            json!({"threadId":id})
        )
        .await["result"]["thread"]["id"],
        id
    );
    assert_eq!(
        call(
            &mut second_host,
            "areal/thread/observe",
            json!({"threadId":id})
        )
        .await["result"]["thread"]["id"],
        id
    );
    let sent = call(
        &mut second_host,
        "turn/start",
        json!({"threadId":id,"input":[{"type":"text","text":"inspect"}]}),
    )
    .await;
    assert!(sent["result"]["turn"]["id"].is_string(), "{sent}");
    let pending = approved_browser_call(&mut owner).await;
    let observed = loop {
        let message = next(&mut observer).await;
        if message["method"] == "turn/started" {
            break message;
        }
    };
    assert_eq!(observed["params"]["threadId"], id);
    second_host.send(Wire::Text(json!({"id":pending["id"],"result":{"success":true,"contentItems":[{"type":"inputText","text":"forged"}]}}).to_string().into())).await.unwrap();
    assert!(call(&mut second_host, "model/list", json!({})).await["result"].is_object());
    assert_eq!(
        engine.read(id, true).await.unwrap().turns[0].status,
        areal_protocol::TurnStatus::InProgress
    );
    owner.send(Wire::Text(json!({"id":pending["id"],"result":{"success":true,"contentItems":[{"type":"inputText","text":"ok"}]}}).to_string().into())).await.unwrap();
    let done = engine.wait(id).await.unwrap();
    assert_eq!(done.turns[0].status, areal_protocol::TurnStatus::Completed);
    let observed_done = loop {
        let message = next(&mut observer).await;
        if message["method"] == "turn/completed" {
            break message;
        }
    };
    assert_eq!(observed_done["params"]["threadId"], id);
    owner.close(None).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), owner.next())
        .await
        .unwrap();
    let rejected = call(
        &mut second_host,
        "turn/start",
        json!({"threadId":id,"input":[{"type":"text","text":"inspect again"}]}),
    )
    .await;
    assert_eq!(rejected["error"]["code"], -32602, "{rejected}");
    assert!(
        rejected["error"]["message"]
            .as_str()
            .unwrap()
            .contains("connected owner")
    );
    let history = engine.read(id, true).await.unwrap();
    assert_eq!(
        history.turns.len(),
        1,
        "rejected submission must not create a Turn"
    );
    assert!(
        history
            .turns
            .iter()
            .flat_map(|turn| &turn.items)
            .all(|item| !matches!(item,
        areal_protocol::Item::DynamicToolCall { execution, .. }
        if execution.outcome == areal_protocol::ToolOutcome::Unknown))
    );
    second_host.close(None).await.unwrap();
    observer.close(None).await.unwrap();
    engine.shutdown().await;
    stop.cancel();
    task.await.unwrap().unwrap();
}
async fn connected(url: &str) -> Socket {
    connected_with(url, "desktop-owner-test-token-1234567890").await
}
async fn connected_with(url: &str, token: &str) -> Socket {
    let mut request = url.into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Authorization", format!("Bearer {token}").parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    let reply = call(
        &mut socket,
        "initialize",
        json!({"clientInfo":{"name":"fixture","version":"1"}}),
    )
    .await;
    assert!(reply.get("result").is_some(), "{reply}");
    socket
        .send(Wire::Text(
            json!({"method":"initialized"}).to_string().into(),
        ))
        .await
        .unwrap();
    socket
}

#[tokio::test]
async fn busy_other_host_schema_conflict_and_untrusted_client_cannot_attach() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(ModelFixture), Limits::default()).unwrap();
    let (url, stop, task) = server(engine.clone()).await;
    let mut owner = connected(&url).await;
    let mut other = connected(&url).await;
    let mut untrusted = connected_with(&url, "other-host-test-token-12345678901234").await;
    let advertised = call(
        &mut owner,
        "areal/capabilities",
        json!({"apiVersion":"areal.core.v1"}),
    )
    .await;
    assert_eq!(
        advertised["result"]["features"]["browserToolAttachment"],
        true
    );
    assert_eq!(
        advertised["result"]["browserToolBundles"][0]["bundleId"],
        "areal.browser.v1"
    );
    let hidden = call(
        &mut untrusted,
        "areal/capabilities",
        json!({"apiVersion":"areal.core.v1"}),
    )
    .await;
    assert_eq!(hidden["result"]["features"]["browserToolAttachment"], false);
    let thread = call(&mut owner, "thread/start", json!({"cwd":"/workspace"})).await;
    let id = thread["result"]["thread"]["id"].as_str().unwrap();
    assert_eq!(
        call(
            &mut untrusted,
            "areal/thread/tools/attach",
            attach(id, "u-1", 0)
        )
        .await["error"]["code"],
        -32003
    );
    assert_eq!(call(&mut owner, "areal/thread/tools/attach", json!({"threadId":id,"requestId":"bad-bundle","expectedToolsetRevision":0,"bundleId":"custom"})).await["error"]["code"], -32602);
    assert_eq!(
        call(
            &mut owner,
            "areal/thread/tools/attach",
            attach(id, "a-1", 0)
        )
        .await["result"]["toolsetRevision"],
        1
    );
    let another = call(&mut owner, "thread/start", json!({"cwd":"/workspace"})).await;
    let another_id = another["result"]["thread"]["id"].as_str().unwrap();
    assert_eq!(
        call(
            &mut owner,
            "areal/thread/tools/attach",
            attach(another_id, "a-1", 0)
        )
        .await["error"]["code"],
        -32009
    );
    assert!(
        engine
            .read(another_id, false)
            .await
            .unwrap()
            .dynamic_tools
            .is_empty()
    );
    assert_eq!(
        call(
            &mut other,
            "areal/thread/tools/attach",
            attach(id, "a-2", 1)
        )
        .await["error"]["code"],
        -32009
    );
    assert_eq!(
        call(
            &mut owner,
            "areal/thread/tools/attach",
            attach(id, "a-3", 0)
        )
        .await["error"]["code"],
        -32009
    );
    engine.start(id, vec![Input::text("read")]).await.unwrap();
    let pending = approved_browser_call(&mut owner).await;
    assert_eq!(
        call(
            &mut owner,
            "areal/thread/tools/attach",
            attach(id, "busy", 1)
        )
        .await["error"]["code"],
        -32009
    );
    owner.send(Wire::Text(json!({"id":pending["id"],"result":{"success":true,"contentItems":[{"type":"inputText","text":"ok"}]}}).to_string().into())).await.unwrap();
    engine.wait(id).await.unwrap();

    let impostor = json!({"name":"browser_v1","description":"different deployed schema","inputSchema":{"type":"object","properties":{},"additionalProperties":false}});
    let conflict = call(
        &mut owner,
        "thread/start",
        json!({"cwd":"/workspace","dynamicTools":[impostor]}),
    )
    .await;
    let conflict_id = conflict["result"]["thread"]["id"].as_str().unwrap();
    assert_eq!(
        call(
            &mut owner,
            "areal/thread/tools/attach",
            attach(conflict_id, "c-1", 0)
        )
        .await["error"]["code"],
        -32009
    );
    assert_eq!(
        engine
            .read(conflict_id, false)
            .await
            .unwrap()
            .dynamic_tools
            .len(),
        1
    );
    let legacy_tool = json!({"name":"legacy_lookup","description":"Original callback tool","inputSchema":{"type":"object","properties":{},"additionalProperties":false}});
    let legacy = call(
        &mut owner,
        "thread/start",
        json!({"cwd":"/workspace","dynamicTools":[legacy_tool.clone()]}),
    )
    .await;
    let legacy_id = legacy["result"]["thread"]["id"].as_str().unwrap();
    owner.close(None).await.unwrap();
    let mut replacement = connected(&url).await;
    assert_eq!(
        call(
            &mut replacement,
            "areal/thread/tools/attach",
            attach(legacy_id, "old-host", 0)
        )
        .await["error"]["code"],
        -32602
    );
    let legacy_after = engine.read(legacy_id, true).await.unwrap();
    assert_eq!(
        serde_json::to_value(&legacy_after.dynamic_tools[0]).unwrap(),
        legacy_tool
    );
    assert_eq!(legacy_after.toolset_revision, 0);
    replacement.close(None).await.unwrap();
    other.close(None).await.unwrap();
    untrusted.close(None).await.unwrap();
    engine.shutdown().await;
    stop.cancel();
    task.await.unwrap().unwrap();
}
async fn approved_browser_call(socket: &mut Socket) -> Value {
    let mut approved = false;
    loop {
        let message = next(socket).await;
        if message["method"] == "areal/interaction/requested" {
            let interaction = &message["params"]["interaction"];
            assert_eq!(interaction["kind"], "approval");
            assert_eq!(
                interaction["effectivePermissions"]["rememberAllowed"],
                false
            );
            socket.send(Wire::Text(json!({"id":700,"method":"areal/interaction/respond","params":{
                "threadId":interaction["threadId"],"turnId":interaction["turnId"],
                "requestId":interaction["requestId"],"argumentsDigest":interaction["argumentsDigest"],
                "decision":"allowOnce"
            }}).to_string().into())).await.unwrap();
            approved = true;
        }
        if message["id"] == 700 {
            assert!(message.get("result").is_some(), "{message}");
        }
        if message["method"] == "item/tool/call" {
            assert!(approved, "Browser discovery dispatched before approval");
            return message;
        }
    }
}

async fn next(socket: &mut Socket) -> Value {
    let wire = tokio::time::timeout(Duration::from_secs(10), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    serde_json::from_str(wire.to_text().unwrap()).unwrap()
}
async fn call(socket: &mut Socket, method: &str, params: Value) -> Value {
    socket
        .send(Wire::Text(
            json!({"id":1,"method":method,"params":params})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    loop {
        let value = next(socket).await;
        if value["id"] == 1 {
            return value;
        }
    }
}
fn attach(thread_id: &str, request_id: &str, revision: u64) -> Value {
    json!({"threadId":thread_id,"requestId":request_id,"expectedToolsetRevision":revision,"bundleId":"areal.browser.v1"})
}

#[tokio::test]
async fn old_thread_keeps_history_and_tools_and_browser_attachment_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(ModelFixture), Limits::default()).unwrap();
    let (url, stop, task) = server(engine.clone()).await;
    let mut owner = connected(&url).await;
    let old = json!({"name":"old_tool","description":"Old tool","inputSchema":{"type":"object","properties":{},"additionalProperties":false}});
    let started = call(
        &mut owner,
        "thread/start",
        json!({"cwd":"/workspace","dynamicTools":[old.clone()]}),
    )
    .await;
    let id = started["result"]["thread"]["id"].as_str().unwrap();
    // An older turn and its tool identity must remain in the original Thread.
    engine.start(id, vec![Input::text("first")]).await.unwrap();
    engine.wait(id).await.unwrap();
    let before = engine.read(id, true).await.unwrap();
    assert_eq!(before.turns.len(), 1);
    assert_eq!(before.dynamic_tools.len(), 1);
    let params = attach(id, "attach-1", 0);
    owner
        .send(Wire::Text(
            json!({"id":1,"method":"areal/thread/tools/attach","params":params.clone()})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let mut attached = None;
    let mut event = None;
    while attached.is_none() || event.is_none() {
        let message = next(&mut owner).await;
        if message["id"] == 1 {
            attached = Some(message);
        } else if message["method"] == "areal/thread/tools/attached" {
            event = Some(message);
        }
    }
    let attached = attached.unwrap();
    let event = event.unwrap();
    assert_eq!(event["params"]["threadId"], id);
    assert_eq!(event["params"]["toolsetRevision"], 1);
    assert_eq!(event["params"]["dynamicTools"][0]["name"], "old_tool");
    assert_eq!(event["params"]["dynamicTools"][1]["name"], "browser_v1");
    assert_eq!(attached["result"]["toolsetRevision"], 1, "{attached}");
    assert_eq!(
        call(&mut owner, "areal/thread/tools/attach", params.clone()).await["result"],
        attached["result"]
    );
    assert_eq!(
        call(
            &mut owner,
            "areal/thread/tools/attach",
            attach(id, "attach-1", 1)
        )
        .await["error"]["code"],
        -32009
    );
    let after = engine.read(id, true).await.unwrap();
    assert_eq!(after.turns.len(), 1);
    assert_eq!(after.dynamic_tools.len(), 2);
    assert_eq!(after.dynamic_tools[0].name, "old_tool");
    assert_eq!(after.dynamic_tools[1].name, "browser_v1");
    engine
        .start(id, vec![Input::text("inspect browser")])
        .await
        .unwrap();
    let request = approved_browser_call(&mut owner).await;
    assert_eq!(request["params"]["tool"], "browser_v1");
    owner.send(Wire::Text(json!({"id":request["id"],"result":{"success":true,"contentItems":[{"type":"inputText","text":"live page sentinel"}]}}).to_string().into())).await.unwrap();
    engine.wait(id).await.unwrap();
    assert_eq!(engine.read(id, true).await.unwrap().turns.len(), 2);
    owner.close(None).await.unwrap();
    engine.shutdown().await;
    stop.cancel();
    task.await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while Arc::strong_count(&engine) > 1 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    drop(engine);
    let reopened = Engine::open(dir.path(), Arc::new(ModelFixture), Limits::default()).unwrap();
    let restored = reopened.read(id, true).await.unwrap();
    assert_eq!(restored.toolset_revision, 1);
    assert_eq!(restored.turns.len(), 2);
    assert_eq!(restored.dynamic_tools.len(), 2);
    assert_eq!(restored.dynamic_tools[0].name, "old_tool");
    assert_eq!(restored.dynamic_tools[1].name, "browser_v1");
    let (url, stop, task) = server(reopened.clone()).await;
    let mut restarted_owner = connected(&url).await;
    let replay = call(&mut restarted_owner, "areal/thread/tools/attach", params).await;
    assert_eq!(replay["result"]["toolsetRevision"], 1);
    let mut older_client = connected_with(&url, "other-host-test-token-12345678901234").await;
    let readable = call(
        &mut older_client,
        "thread/read",
        json!({"threadId":id,"includeTurns":true}),
    )
    .await;
    assert_eq!(
        readable["result"]["thread"]["turns"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    restarted_owner.close(None).await.unwrap();
    older_client.close(None).await.unwrap();
    reopened.shutdown().await;
    stop.cancel();
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn older_snapshot_defaults_revision_and_future_snapshot_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(ModelFixture), Limits::default()).unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    engine.shutdown().await;
    drop(engine);
    let file = dir.path().join(format!("{}.json", thread.id));
    let mut snapshot: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    let future_version = snapshot["version"].as_u64().unwrap() + 1;
    snapshot["version"] = json!(12);
    snapshot["thread"]
        .as_object_mut()
        .unwrap()
        .remove("toolsetRevision");
    std::fs::write(&file, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    let old = Engine::open(dir.path(), Arc::new(ModelFixture), Limits::default()).unwrap();
    assert_eq!(
        old.read(&thread.id, true).await.unwrap().toolset_revision,
        0
    );
    old.shutdown().await;
    drop(old);
    snapshot["version"] = json!(future_version);
    std::fs::write(&file, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    assert!(Engine::open(dir.path(), Arc::new(ModelFixture), Limits::default()).is_err());
}

#[tokio::test]
async fn denied_browser_discovery_never_dispatches_to_the_client_host() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(ModelFixture), Limits::default()).unwrap();
    let (url, stop, task) = server(engine.clone()).await;
    let mut owner = connected(&url).await;
    let tool = serde_json::to_value(areal_protocol::desktop::browser_v1_tool()).unwrap();
    let created = call(
        &mut owner,
        "thread/start",
        json!({"cwd":"/workspace","dynamicTools":[tool]}),
    )
    .await;
    let id = created["result"]["thread"]["id"].as_str().unwrap();
    engine
        .start(id, vec![Input::text("open the browser")])
        .await
        .unwrap();
    let interaction = loop {
        let message = next(&mut owner).await;
        assert_ne!(
            message["method"], "item/tool/call",
            "unapproved discovery reached the host"
        );
        if message["method"] == "areal/interaction/requested" {
            break message["params"]["interaction"].clone();
        }
    };
    assert_eq!(
        interaction["effectivePermissions"]["rememberAllowed"],
        false
    );
    owner
        .send(Wire::Text(
            json!({"id":700,"method":"areal/interaction/respond","params":{
                "threadId":id,"turnId":interaction["turnId"],"requestId":interaction["requestId"],
                "argumentsDigest":interaction["argumentsDigest"],"decision":"deny"
            }})
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    loop {
        let message = next(&mut owner).await;
        assert_ne!(
            message["method"], "item/tool/call",
            "denied discovery reached the host"
        );
        if message["id"] == 700 {
            assert!(message.get("result").is_some(), "{message}");
        }
        if message["method"] == "turn/completed" {
            break;
        }
    }
    let history = engine.read(id, true).await.unwrap();
    assert!(
        serde_json::to_string(&history)
            .unwrap()
            .contains("tool approval denied")
    );
    owner.close(None).await.unwrap();
    engine.shutdown().await;
    stop.cancel();
    task.await.unwrap().unwrap();
}
