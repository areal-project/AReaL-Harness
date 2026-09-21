//! Connection-scoped server requests. Replies from another connection cannot satisfy a call.
use super::*;
use areal_engine::tools::DynamicToolHost;
use areal_protocol::DynamicToolResponse;
use std::sync::{
    Mutex as StdMutex,
    atomic::{AtomicU64, Ordering},
};
use tokio::sync::oneshot;

type Reply = oneshot::Sender<anyhow::Result<DynamicToolResponse>>;
static CONNECTION_ID: AtomicU64 = AtomicU64::new(1);

pub(super) struct ToolHost {
    id: String,
    identity: String,
    next: AtomicU64,
    tx: mpsc::Sender<Value>,
    stop: CancellationToken,
    pending: StdMutex<HashMap<String, Reply>>,
}
impl ToolHost {
    #[cfg(test)]
    pub fn new(tx: mpsc::Sender<Value>, stop: CancellationToken) -> Arc<Self> {
        Self::authenticated(tx, stop, "trusted-embedded-host".into())
    }
    pub fn authenticated(
        tx: mpsc::Sender<Value>,
        stop: CancellationToken,
        identity: String,
    ) -> Arc<Self> {
        Arc::new(Self {
            id: format!(
                "client-{}-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                CONNECTION_ID.fetch_add(1, Ordering::Relaxed)
            ),
            identity,
            next: AtomicU64::new(1),
            tx,
            stop,
            pending: StdMutex::new(HashMap::new()),
        })
    }
    pub fn respond(&self, response: Value) {
        let Some(id) = response["id"].as_str() else {
            return;
        };
        let Some(reply) = self.pending.lock().unwrap().remove(id) else {
            return;
        };
        let result = if response.get("error").is_some() || response.get("result").is_none() {
            Err(anyhow::anyhow!(
                "dynamic tool client returned an RPC error or malformed reply; outcome is UNKNOWN"
            ))
        } else {
            serde_json::from_value(response["result"].clone()).map_err(Into::into)
        };
        let _ = reply.send(result);
    }
}

struct Pending<'a> {
    host: &'a ToolHost,
    id: String,
}
impl Drop for Pending<'_> {
    fn drop(&mut self) {
        if self.host.pending.lock().unwrap().remove(&self.id).is_some() {
            // Best effort only: a remote client may already have committed a side effect.
            let _ = self.host.tx.try_send(areal_protocol::notification(
                "areal/tool/cancelled",
                json!({"requestId":self.id}),
            ));
        }
    }
}

#[async_trait::async_trait]
impl DynamicToolHost for ToolHost {
    fn id(&self) -> &str {
        &self.id
    }
    fn identity(&self) -> &str {
        &self.identity
    }
    fn is_closed(&self) -> bool {
        self.stop.is_cancelled()
    }
    async fn call(
        &self,
        params: Value,
        cancel: CancellationToken,
    ) -> anyhow::Result<DynamicToolResponse> {
        anyhow::ensure!(!self.is_closed(), "dynamic tool client disconnected");
        let id = format!(
            "areal-tool/{}/{}",
            self.id,
            self.next.fetch_add(1, Ordering::Relaxed)
        );
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        let _pending = Pending {
            host: self,
            id: id.clone(),
        };
        if self
            .tx
            .try_send(json!({"jsonrpc":"2.0","id":id,"method":"item/tool/call","params":params}))
            .is_err()
        {
            self.stop.cancel();
            anyhow::bail!("dynamic tool client delivery failed");
        }
        tokio::select! {
            biased;
            _ = cancel.cancelled() => anyhow::bail!("dynamic tool call cancelled; external outcome is UNKNOWN"),
            _ = self.stop.cancelled() => anyhow::bail!("dynamic tool client disconnected; outcome is UNKNOWN"),
            result = rx => result?,
        }
    }
}
