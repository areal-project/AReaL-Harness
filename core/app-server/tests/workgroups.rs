use anyhow::Result;
use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelStream},
    workgroup::{
        service::*,
        tree::{self, Tree},
        *,
    },
};
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{path::Path, sync::Arc, time::Duration};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::Message as Wire};
use tokio_util::sync::CancellationToken;

struct Fixture;
#[async_trait]
impl Model for Fixture {
    fn name(&self) -> &str {
        "fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> Result<ModelStream> {
        Ok(Box::pin(futures_util::stream::empty()))
    }
}
impl Factory for Fixture {
    fn executor(&self, _: &Path, _: &Policy) -> Result<Arc<dyn Executor>> {
        Ok(Arc::new(Self))
    }
}
#[async_trait]
impl Executor for Fixture {
    async fn attempt(
        &self,
        _: Task,
        _: u32,
        tree: Tree,
        _: Option<Tree>,
        _: String,
        cancel: CancellationToken,
    ) -> Result<Tree> {
        cancel.cancelled().await;
        Ok(tree)
    }
    async fn verify(&self, tree: Tree, _: Vec<Vec<String>>, _: CancellationToken) -> Result<Check> {
        Ok(Check {
            tree_hash: tree::digest(&tree),
            passed: true,
            output: "checked".into(),
        })
    }
}
type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
async fn receive(socket: &mut Socket) -> Value {
    let wire = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    serde_json::from_str(wire.to_text().unwrap()).unwrap()
}
async fn send(socket: &mut Socket, id: u64, method: &str, params: Value) {
    socket
        .send(Wire::Text(
            json!({"id":id,"method":method,"params":params})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
}

#[tokio::test]
async fn cursor_wait_does_not_block_cancel_or_other_requests_on_the_same_connection() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    std::fs::create_dir(&source).unwrap();
    let engine = Engine::open(
        &temp.path().join("engine"),
        Arc::new(Fixture),
        Limits::default(),
    )
    .unwrap();
    let service = Service::open(
        &temp.path().join("groups"),
        &source,
        Policy {
            allowed_directories: vec![],
            allowed_writes: vec!["a".into()],
            checks: vec![vec!["check".into()]],
            workers: 2,
            verifiers: 1,
            active_groups: 2,
            timeout_seconds: 120,
            command_timeout_ms: 300_000,
            max_model_requests: 16,
        },
        Arc::new(Fixture),
    )
    .unwrap();
    engine.attach_workgroups(service.clone()).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let server = tokio::spawn(areal_app_server::serve(
        listener,
        engine.clone(),
        stop.clone(),
    ));
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}"))
        .await
        .unwrap();
    send(
        &mut socket,
        1,
        "initialize",
        json!({"clientInfo":{"name":"workgroup-test","version":"1"}}),
    )
    .await;
    assert!(receive(&mut socket).await.get("result").is_some());
    socket
        .send(Wire::Text(
            json!({"method":"initialized"}).to_string().into(),
        ))
        .await
        .unwrap();
    let request = json!({"requestId":"deduplicate","plan":{"objective":"work","tasks":[{"id":"a","instruction":"work","writes":["a"]}]}});
    send(&mut socket, 2, "areal/workgroup/start", request.clone()).await;
    let started = receive(&mut socket).await;
    assert!(started.get("error").is_none(), "{started}");
    let id = started["result"]["id"].as_str().unwrap();
    send(&mut socket, 3, "areal/workgroup/start", request).await;
    assert_eq!(receive(&mut socket).await["result"]["id"], id);
    // Saturate long waits. Future cursors stay pending through ordinary revisions;
    // cancellation/read capacity must remain available on this same connection.
    for request_id in 4..17 {
        send(
            &mut socket,
            request_id,
            "areal/workgroup/wait",
            json!({"id":id,"afterRevision":100000,"timeoutMs":60000}),
        )
        .await;
    }
    let rejected = receive(&mut socket).await;
    assert_eq!(rejected["id"], 16);
    assert!(rejected.get("error").is_some());
    send(&mut socket, 17, "areal/workgroup/cancel", json!({"id":id})).await;
    send(&mut socket, 18, "areal/workgroup/list", json!({})).await;
    let mut got = std::collections::BTreeMap::new();
    while got.len() < 14 {
        let response = receive(&mut socket).await;
        let key = response["id"].as_u64().unwrap();
        assert!(response.get("error").is_none(), "{response}");
        got.insert(key, response);
    }
    assert_eq!(got[&4]["result"]["record"]["status"], "cancelled");
    assert_eq!(got[&4]["result"]["record"]["cleanupConfirmed"], true);
    send(
        &mut socket,
        19,
        "areal/workgroup/wait",
        json!({"id":id,"afterRevision":0,"timeoutMs":60001}),
    )
    .await;
    assert!(receive(&mut socket).await.get("error").is_some());
    socket.close(None).await.unwrap();
    engine.shutdown().await;
    stop.cancel();
    server.await.unwrap().unwrap();
}
