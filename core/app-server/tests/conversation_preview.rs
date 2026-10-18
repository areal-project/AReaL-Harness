use areal_engine::{Engine, Limits};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn default_capabilities_advertise_derivation_and_dispatch_routes() {
    unsafe {
        std::env::remove_var("AREAL_DEV_CONVERSATION_DERIVATION");
    }
    let dir = tempfile::tempdir().unwrap();
    let model =
        areal_engine::model::ChatModel::new("http://127.0.0.1:9".into(), "unused".into(), None)
            .unwrap();
    let engine = Engine::open(dir.path(), Arc::new(model), Limits::default()).unwrap();
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
    let methods = [
        "areal/thread/fork",
        "areal/side/start",
        "areal/conversation/list",
        "areal/conversation/history",
        "areal/conversation/unarchive",
        "areal/side/context/read",
    ];
    let requests = vec![
        (
            "initialize",
            json!({"clientInfo":{"name":"test","version":"1"}}),
        ),
        ("areal/capabilities", json!({})),
        ("areal/thread/fork", json!([])),
        ("areal/side/start", json!([])),
        ("areal/conversation/list", json!([])),
        ("areal/conversation/unarchive", json!([])),
        (
            "areal/thread/fork",
            json!({"requestId":"fork","sourceThreadId":"missing","anchor":{"turnId":"missing","boundary":"after"},"workspaceMode":"sharedCurrent"}),
        ),
        (
            "areal/side/start",
            json!({"requestId":"side","sourceThreadId":"missing","workspaceAccess":"none","input":[{"type":"text","text":"question"}]}),
        ),
        ("areal/conversation/list", json!({})),
        (
            "areal/conversation/unarchive",
            json!({"requestId":"unarchive","threadId":"missing"}),
        ),
    ];
    for (id, (method, params)) in requests.into_iter().enumerate() {
        socket
            .send(Message::Text(
                json!({"id":id,"method":method,"params":params})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let response = loop {
            let message = tokio::time::timeout(Duration::from_secs(10), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let value: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
            if value["id"] == id {
                break value;
            }
        };
        if id == 0 {
            assert!(response["result"].is_object(), "{response}");
            socket
                .send(Message::Text(
                    json!({"method":"initialized"}).to_string().into(),
                ))
                .await
                .unwrap();
        } else if id == 1 {
            let schemas: Value =
                serde_json::from_str(include_str!("../../../schemas/areal-core-v1.json")).unwrap();
            assert!(
                jsonschema::is_valid(
                    &schemas["responses"]["areal/capabilities"],
                    &response["result"]
                ),
                "capabilities schema mismatch: {response}"
            );
            let feature = &response["result"]["features"]["conversationDerivationV1"];
            assert_eq!(feature["preview"], false);
            assert_eq!(feature["methods"], json!(methods));
            assert_eq!(feature["forkBoundaries"], json!(["after", "before"]));
            assert_eq!(feature["workspaceModes"], json!(["sharedCurrent"]));
            assert_eq!(feature["sideWorkspaceAccess"], json!(["none"]));
            assert_eq!(feature["limits"], engine.conversation_derivation_limits());
            assert_eq!(feature["historyBytes"], engine.fork_snapshot_limit());
            for method in methods {
                assert!(
                    response["result"]["methods"]
                        .as_array()
                        .unwrap()
                        .contains(&json!(method)),
                    "{method} not advertised"
                );
            }
        } else if id < 6 {
            assert_eq!(response["error"]["code"], -32602, "{method}: {response}");
        } else if method == "areal/conversation/list" {
            assert_eq!(response["result"]["data"], json!([]), "{response}");
        } else {
            assert!(response["error"].is_object(), "{method}: {response}");
            assert_ne!(response["error"]["code"], -32601, "{response}");
            assert_ne!(
                response["error"]["data"]["reason"], "CONVERSATION_DERIVATION_DISABLED",
                "{response}"
            );
        }
    }
    assert!(engine.list(None, 100, None).await.unwrap().0.is_empty());
    drop(socket);
    stop.cancel();
    server.await.unwrap().unwrap();
    engine.shutdown().await;
}
