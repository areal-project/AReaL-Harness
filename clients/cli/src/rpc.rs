use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;
pub struct Rpc {
    out: mpsc::Sender<Value>,
    pending: Pending,
    sequence: AtomicU64,
    pub events: mpsc::Receiver<Value>,
}
impl Rpc {
    pub async fn connect(endpoint: &str, token: &str) -> Result<Self> {
        let mut request = endpoint.into_client_request()?;
        request
            .headers_mut()
            .insert("Authorization", format!("Bearer {token}").parse()?);
        let (socket, _) = tokio_tungstenite::connect_async(request).await?;
        let (mut writer, mut reader) = socket.split();
        let (out, mut messages) = mpsc::channel::<Value>(32);
        let (events_tx, events) = mpsc::channel(512);
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let p = pending.clone();
        tokio::spawn(async move {
            while let Some(v) = messages.recv().await {
                if tokio::time::timeout(
                    Duration::from_secs(10),
                    writer.send(Message::Text(v.to_string().into())),
                )
                .await
                .is_err()
                {
                    break;
                }
            }
        });
        tokio::spawn(async move {
            while let Some(Ok(frame)) = reader.next().await {
                if let Message::Text(text) = frame {
                    let Ok(v) = serde_json::from_str::<Value>(&text) else {
                        break;
                    };
                    if v.get("method").is_none() {
                        if let Some(id) = v["id"].as_u64()
                            && let Some(tx) = p.lock().await.remove(&id)
                        {
                            let _ = tx.send(v);
                        }
                    } else if events_tx.try_send(v).is_err() {
                        break;
                    }
                }
            }
            p.lock().await.clear();
        });
        Ok(Self {
            out,
            pending,
            sequence: AtomicU64::new(1),
            events,
        })
    }
    pub async fn send(&self, value: Value) -> Result<()> {
        self.out.send(value).await.context("Core connection closed")
    }
    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.sequence.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        self.send(json!({"id":id,"method":method,"params":params}))
            .await?;
        let result = tokio::time::timeout(Duration::from_secs(65), rx).await;
        self.pending.lock().await.remove(&id);
        let v = result
            .context("Core response deadline; query request receipt before retry")?
            .context("Core disconnected; acceptance is unknown")?;
        if let Some(error) = v.get("error") {
            bail!("Core: {error}");
        }
        Ok(v["result"].clone())
    }
}
