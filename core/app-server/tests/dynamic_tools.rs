use areal_engine::{
    Engine, Limits,
    model::{AgentStream, Message, Model, ModelEvent, ModelStream, ToolCall},
};
use areal_protocol::{Input, Item, ToolOutcome, TurnStatus};
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::Message as Wire};
use tokio_util::sync::CancellationToken;

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
struct FixtureModel;
#[async_trait]
impl Model for FixtureModel {
    fn name(&self) -> &str {
        "dynamic-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<AgentStream> {
        assert!(
            tools
                .iter()
                .any(|tool| tool["function"]["name"] == "lookup")
        );
        assert!(
            tools
                .iter()
                .any(|tool| tool["function"]["name"] == "agent_spawn")
        );
        let event = if messages.last().unwrap().role == "tool" {
            assert!(messages.last().unwrap().text_content().contains("value 7"));
            ModelEvent::TextDelta("done".into())
        } else {
            ModelEvent::ToolCall(ToolCall {
                id: "call-1".into(),
                name: "lookup".into(),
                arguments: json!({"key":"seven"}).to_string(),
            })
        };
        Ok(Box::pin(futures_util::stream::iter([Ok(event)])))
    }
}
fn definition() -> Value {
    json!({"name":"lookup","description":"Look up a value","inputSchema":{"type":"object","properties":{"key":{"type":"string"}},"required":["key"],"additionalProperties":false},"outputSchema":{"type":"integer"}})
}
fn result() -> Value {
    json!({"success":true,"contentItems":[{"type":"inputText","text":"value 7"}],"structuredContent":7})
}
async fn send(socket: &mut Socket, value: Value) {
    socket
        .send(Wire::Text(value.to_string().into()))
        .await
        .unwrap();
}
async fn receive(socket: &mut Socket) -> Value {
    let value = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    serde_json::from_str(value.to_text().unwrap()).unwrap()
}
async fn call(socket: &mut Socket, method: &str, params: Value) -> Value {
    send(socket, json!({"id":1,"method":method,"params":params})).await;
    loop {
        let value = receive(socket).await;
        if value["id"] == 1 {
            return value;
        }
    }
}
async fn connected(url: &str) -> Socket {
    let (mut socket, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    assert!(
        call(
            &mut socket,
            "initialize",
            json!({"clientInfo":{"name":"fixture","version":"1"}})
        )
        .await
        .get("result")
        .is_some()
    );
    send(&mut socket, json!({"method":"initialized"})).await;
    socket
}
async fn tool_request(socket: &mut Socket) -> Value {
    loop {
        let value = receive(socket).await;
        if value["method"] == "item/tool/call" {
            return value;
        }
    }
}
async fn start(socket: &mut Socket) -> String {
    let reply = call(
        socket,
        "thread/start",
        json!({"cwd":"/workspace","dynamicTools":[definition()]}),
    )
    .await;
    assert_eq!(reply["result"]["thread"]["dynamicTools"][0], definition());
    reply["result"]["thread"]["id"].as_str().unwrap().into()
}
async fn serve(
    engine: Arc<Engine>,
) -> (
    String,
    CancellationToken,
    tokio::task::JoinHandle<anyhow::Result<()>>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let stop = CancellationToken::new();
    let task = tokio::spawn(areal_app_server::serve(listener, engine, stop.clone()));
    (url, stop, task)
}
async fn settled(engine: &Engine, id: &str) -> areal_protocol::Thread {
    tokio::time::timeout(Duration::from_secs(5), engine.wait(id))
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn callback_roundtrip_is_connection_scoped_and_definitions_survive_restart() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(FixtureModel), Limits::default()).unwrap();
    let (url, stop, server) = serve(engine.clone()).await;
    let mut owner = connected(&url).await;
    let mut other = connected(&url).await;
    let invalid = call(
        &mut owner,
        "thread/start",
        json!({"dynamicTools":[definition(),definition()]}),
    )
    .await;
    assert_eq!(invalid["error"]["code"], -32602);
    assert!(engine.list(None, 100, None).await.unwrap().0.is_empty());
    let id = start(&mut owner).await;
    assert_eq!(
        call(&mut other, "thread/resume", json!({"threadId":id})).await["error"]["code"],
        -32009
    );
    engine
        .start(&id, vec![Input::text("lookup")])
        .await
        .unwrap();
    let request = tool_request(&mut owner).await;
    assert_eq!(request["params"]["tool"], "lookup");
    assert_eq!(request["params"]["arguments"], json!({"key":"seven"}));
    // An identically numbered reply from a different socket cannot execute or finish this call.
    send(&mut other, json!({"id":request["id"],"result":{"success":true,"contentItems":[{"type":"inputText","text":"wrong owner"}],"structuredContent":0}})).await;
    call(&mut other, "model/list", json!({})).await;
    assert_eq!(
        engine.read(&id, true).await.unwrap().turns[0].status,
        TurnStatus::InProgress
    );
    send(&mut owner, json!({"id":request["id"],"result":result()})).await;
    let done = settled(&engine, &id).await;
    assert_eq!(done.turns[0].status, TurnStatus::Completed);
    let item = done.turns[0]
        .items
        .iter()
        .find_map(|i| match i {
            Item::DynamicToolCall { execution, .. } => Some(execution),
            _ => None,
        })
        .unwrap();
    assert_eq!(item.backend.as_deref(), Some("client"));
    assert_eq!(item.outcome, ToolOutcome::Succeeded);
    owner.close(None).await.unwrap();
    other.close(None).await.unwrap();
    engine.shutdown().await;
    stop.cancel();
    server.await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while Arc::strong_count(&engine) > 1 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    drop(engine);

    let engine = Engine::open(dir.path(), Arc::new(FixtureModel), Limits::default()).unwrap();
    assert_eq!(engine.read(&id, true).await.unwrap().dynamic_tools.len(), 1);
    assert!(
        engine
            .start(&id, vec![Input::text("again")])
            .await
            .unwrap_err()
            .to_string()
            .contains("connected owner")
    );
    let (url, stop, server) = serve(engine.clone()).await;
    let mut owner = connected(&url).await;
    assert!(
        call(&mut owner, "thread/resume", json!({"threadId":id}))
            .await
            .get("result")
            .is_some()
    );
    engine.start(&id, vec![Input::text("again")]).await.unwrap();
    let request = tool_request(&mut owner).await;
    send(&mut owner, json!({"id":request["id"],"result":result()})).await;
    assert_eq!(
        settled(&engine, &id).await.turns[1].status,
        TurnStatus::Completed
    );
    owner.close(None).await.unwrap();
    engine.shutdown().await;
    stop.cancel();
    server.await.unwrap().unwrap();
}

#[tokio::test]
async fn disconnect_malformed_reply_and_invalid_output_are_unknown_without_replay() {
    for failure in ["disconnect", "malformed", "schema", "oversized"] {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(dir.path(), Arc::new(FixtureModel), Limits::default()).unwrap();
        let (url, stop, server) = serve(engine.clone()).await;
        let mut owner = connected(&url).await;
        let id = start(&mut owner).await;
        engine
            .start(&id, vec![Input::text("lookup")])
            .await
            .unwrap();
        let request = tool_request(&mut owner).await;
        match failure {
            "disconnect" => owner.close(None).await.unwrap(),
            "malformed" => {
                send(
                    &mut owner,
                    json!({"id":request["id"],"result":{"success":true}}),
                )
                .await
            }
            _ => {
                let mut reply = result();
                if failure == "schema" {
                    reply["structuredContent"] = json!("7");
                } else {
                    reply["contentItems"][0]["text"] = json!("x".repeat(16384));
                }
                send(&mut owner, json!({"id":request["id"],"result":reply})).await;
            }
        }
        let done = settled(&engine, &id).await;
        assert_eq!(done.turns[0].status, TurnStatus::Failed, "{failure}");
        assert_eq!(done.turns[0].items.iter().filter(|i| matches!(i, Item::DynamicToolCall {execution,..} if execution.outcome == ToolOutcome::Unknown)).count(), 1);
        assert!(engine.start(&id, vec![Input::text("again")]).await.is_err());
        let _ = owner.close(None).await;
        engine.shutdown().await;
        stop.cancel();
        server.await.unwrap().unwrap();
    }
}

#[tokio::test]
async fn cancellation_notifies_client_and_does_not_claim_remote_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(FixtureModel), Limits::default()).unwrap();
    let (url, stop, server) = serve(engine.clone()).await;
    let mut owner = connected(&url).await;
    let id = start(&mut owner).await;
    let turn = engine
        .start(&id, vec![Input::text("lookup")])
        .await
        .unwrap();
    let request = tool_request(&mut owner).await;
    engine.interrupt(&id, &turn.id).await.unwrap();
    loop {
        let event = receive(&mut owner).await;
        if event["method"] == "areal/tool/cancelled" {
            assert_eq!(event["params"]["requestId"], request["id"]);
            break;
        }
    }
    assert_eq!(
        settled(&engine, &id).await.turns[0].status,
        TurnStatus::Failed
    );
    // Late replies are ignored and cannot overwrite the durable UNKNOWN result.
    send(&mut owner, json!({"id":request["id"],"result":result()})).await;
    call(&mut owner, "model/list", json!({})).await;
    assert!(engine.read(&id, true).await.unwrap().turns[0].items.iter().any(|i| matches!(i, Item::DynamicToolCall {execution,..} if execution.outcome == ToolOutcome::Unknown)));
    owner.close(None).await.unwrap();
    engine.shutdown().await;
    stop.cancel();
    server.await.unwrap().unwrap();
}
