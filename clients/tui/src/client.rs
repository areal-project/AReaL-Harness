use anyhow::{Context, Result};
use areal_protocol::notification;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::sync::mpsc;

pub(crate) struct Client {
    pub(crate) tx: mpsc::Sender<Value>,
    pub(crate) rx: mpsc::Receiver<Value>,
    pub(crate) next: u64,
}
impl Client {
    pub(crate) async fn connect(
        endpoint: &str,
        auth_file: Option<&std::path::Path>,
    ) -> Result<Self> {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let mut request = endpoint.into_client_request()?;
        if let Some(path) = auth_file {
            let config: Value = serde_json::from_slice(&std::fs::read(path)?)?;
            let token = config["principals"][0]["token"]
                .as_str()
                .context("missing authentication token")?;
            request
                .headers_mut()
                .insert("authorization", format!("Bearer {token}").parse()?);
        }
        let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
            .max_message_size(Some(areal_protocol::MAX_FRAME_BYTES));
        let (socket, _) = tokio::time::timeout(
            Duration::from_secs(10),
            tokio_tungstenite::connect_async_with_config(request, Some(config), false),
        )
        .await??;
        let (mut sink, mut stream) = socket.split();
        let (tx, mut requests) = mpsc::channel::<Value>(64);
        let (events, rx) = mpsc::channel(256);
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    request = requests.recv() => {
                        let Some(request) = request else { let _ = sink.close().await; break; };
                        if !matches!(tokio::time::timeout(Duration::from_secs(5), sink.send(
                            tokio_tungstenite::tungstenite::Message::Text(request.to_string().into()))).await, Ok(Ok(()))) { break; }
                    }
                    event = stream.next() => match event {
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
                            let Ok(value) = serde_json::from_str::<Value>(&text) else { break; };
                            if value.get("id").is_some() && value.get("method").is_some() {
                                let reply = areal_protocol::response(value["id"].clone(), Err(areal_protocol::RpcError::method()));
                                if !matches!(tokio::time::timeout(Duration::from_secs(5), sink.send(
                                    tokio_tungstenite::tungstenite::Message::Text(reply.to_string().into()))).await, Ok(Ok(()))) { break; }
                                continue;
                            }
                            if events.try_send(value).is_err() { break; }
                        }
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Ping(bytes))) => {
                            if sink.send(tokio_tungstenite::tungstenite::Message::Pong(bytes)).await.is_err() { break; }
                        }
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) | None | Some(Err(_)) => break,
                        _ => {},
                    }
                }
            }
        });
        let mut client = Self { tx, rx, next: 1 };
        let init = client.send(
            "initialize",
            json!({"clientInfo":{"name":"areal_tui","version":env!("CARGO_PKG_VERSION")}}),
        )?;
        let reply = tokio::time::timeout(Duration::from_secs(10), client.rx.recv())
            .await?
            .context("connection closed during initialize")?;
        anyhow::ensure!(
            reply["id"] == init && reply.get("result").is_some(),
            "initialization failed: {reply}"
        );
        client
            .tx
            .send(notification("initialized", json!({})))
            .await?;
        Ok(client)
    }
    pub(crate) fn send(&mut self, method: &str, params: Value) -> Result<u64> {
        let id = self.next;
        self.next += 1;
        self.tx
            .try_send(json!({"id":id,"method":method,"params":params}))?;
        Ok(id)
    }
}
