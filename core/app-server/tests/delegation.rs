use areal_app_server::auth::{Authentication, Permission, Principal};
use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelStream},
};
use areal_protocol::{Input, delegation::DelegationRequest};
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{Message as Wire, client::IntoClientRequest},
};
use tokio_util::sync::CancellationToken;

struct PendingModel(CancellationToken);
#[async_trait]
impl Model for PendingModel {
    fn name(&self) -> &str {
        "fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        let stop = self.0.clone();
        Ok(Box::pin(futures_util::stream::once(async move {
            stop.cancelled().await;
            Ok(areal_engine::model::ModelEvent::text("stopped"))
        })))
    }
}
type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
async fn call(socket: &mut Socket, id: u64, method: &str, params: Value) -> Value {
    socket
        .send(Wire::Text(
            json!({"id":id,"method":method,"params":params})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
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
async fn connect(address: std::net::SocketAddr, token: &str) -> Socket {
    let mut request = format!("ws://{address}").into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Authorization", format!("Bearer {token}").parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    assert!(
        call(
            &mut socket,
            1,
            "initialize",
            json!({"clientInfo":{"name":"delegation-test","version":"1"}})
        )
        .await
        .get("result")
        .is_some()
    );
    socket
        .send(Wire::Text(
            json!({"method":"initialized"}).to_string().into(),
        ))
        .await
        .unwrap();
    socket
}

#[tokio::test]
async fn unified_execution_routes_keep_parent_authority_and_wait_does_not_block_cancel() {
    let temp = tempfile::tempdir().unwrap();
    let model_stop = CancellationToken::new();
    let engine = Engine::open(
        &temp.path().join("engine"),
        Arc::new(PendingModel(model_stop.clone())),
        Limits::default(),
    )
    .unwrap();
    let parent = engine
        .create(temp.path().to_string_lossy().into())
        .await
        .unwrap();
    let foreign = engine
        .create(temp.path().to_string_lossy().into())
        .await
        .unwrap();
    let parent_turn = engine
        .start(&parent.id, vec![Input::text("root")])
        .await
        .unwrap();
    let token = "interactive-delegation-token-00000000001";
    let observer_token = "observer-delegation-token-000000000001";
    let auth = Authentication {
        version: 1,
        principals: vec![
            Principal {
                id: "interactive".into(),
                token: token.into(),
                permissions: [Permission::Observe, Permission::Interact].into(),
                thread_ids: Some([parent.id.clone()].into()),
            },
            Principal {
                id: "observer".into(),
                token: observer_token.into(),
                permissions: [Permission::Observe].into(),
                thread_ids: Some([parent.id.clone()].into()),
            },
        ],
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let server = tokio::spawn(areal_app_server::serve_authenticated(
        listener,
        engine.clone(),
        stop.clone(),
        Some(auth),
    ));
    let mut interactive = connect(address, token).await;
    let mut observer = connect(address, observer_token).await;
    let request = json!({"requestId":"unique","parentThreadId":parent.id,"input":[{"type":"text","text":"inspect"}],"intent":"inspect","delivery":"report"});
    let accepted = call(&mut interactive, 2, "areal/agent/delegate", request.clone()).await;
    assert!(accepted.get("error").is_none(), "{accepted}");
    let id = accepted["result"]["executionId"].as_str().unwrap();
    assert_eq!(
        call(&mut interactive, 3, "areal/agent/delegate", request.clone()).await["result"]["executionId"],
        id
    );
    let target = json!({"parentThreadId":parent.id,"executionId":id});
    assert_eq!(
        call(&mut observer, 2, "areal/execution/read", target.clone()).await["result"]["strategy"],
        "sharedReadOnly"
    );
    for (index, method) in ["areal/execution/cancel", "areal/execution/apply"]
        .into_iter()
        .enumerate()
    {
        assert_eq!(
            call(&mut observer, 3 + index as u64, method, target.clone()).await["error"]["code"],
            -32003
        );
    }
    assert_eq!(
        call(&mut observer, 5, "areal/agent/delegate", request).await["error"]["code"],
        -32003
    );
    assert_eq!(
        call(
            &mut interactive,
            4,
            "areal/execution/list",
            json!({"parentThreadId":foreign.id})
        )
        .await["error"]["code"],
        -32003
    );
    assert!(engine.execution_read(&foreign.id, id).await.is_err());
    let mut changed:DelegationRequest=serde_json::from_value(json!({"requestId":"unique","parentThreadId":parent.id,"input":[{"type":"text","text":"changed"}]})).unwrap();
    changed.independent = true;
    assert!(engine.delegate(changed).await.is_err());
    // 同连接中的长等待必须给取消保留执行额度。
    interactive.send(Wire::Text(json!({"id":10,"method":"areal/execution/wait","params":{"parentThreadId":parent.id,"executionId":id,"timeoutMs":60000}}).to_string().into())).await.unwrap();
    let cancelled = call(
        &mut interactive,
        11,
        "areal/execution/cancel",
        json!({"parentThreadId":parent.id,"executionId":id,"mode":"force"}),
    )
    .await;
    assert!(cancelled.get("error").is_none(), "{cancelled}");
    let done = call(
        &mut observer,
        6,
        "areal/execution/wait",
        json!({"parentThreadId":parent.id,"executionId":id,"timeoutMs":4000}),
    )
    .await;
    assert_eq!(done["result"]["settled"], true, "{done}");
    assert_eq!(done["result"]["status"], "cancelled");
    assert_eq!(done["result"]["resourcesReleased"], true);
    let repeated = call(&mut interactive, 12, "areal/execution/cancel", target).await;
    assert!(repeated.get("error").is_none(), "{repeated}");
    assert_eq!(repeated["result"]["status"], "cancelled");
    assert_eq!(repeated["result"]["resourcesReleased"], true);
    model_stop.cancel();
    engine.interrupt(&parent.id, &parent_turn.id).await.unwrap();
    interactive.close(None).await.unwrap();
    observer.close(None).await.unwrap();
    stop.cancel();
    server.await.unwrap().unwrap();
    engine.shutdown().await;
}
