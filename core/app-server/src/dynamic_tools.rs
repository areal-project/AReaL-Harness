//! Connection-scoped server requests. Replies from another connection cannot satisfy a call.
use super::*;
use areal_engine::tools::DynamicToolHost;
use areal_protocol::DynamicToolResponse;
use std::sync::{
    Mutex as StdMutex,
    atomic::{AtomicU64, Ordering},
};
use tokio::sync::oneshot;

type Reply = oneshot::Sender<anyhow::Result<Value>>;
struct PendingReply {
    sender: Reply,
    prepare: bool,
}
static CONNECTION_ID: AtomicU64 = AtomicU64::new(1);

pub(super) struct ToolHost {
    id: String,
    identity: String,
    next: AtomicU64,
    tx: mpsc::Sender<Outbound>,
    stop: CancellationToken,
    pending: StdMutex<HashMap<String, PendingReply>>,
}
impl ToolHost {
    #[cfg(test)]
    pub fn new(tx: mpsc::Sender<Outbound>, stop: CancellationToken) -> Arc<Self> {
        Self::authenticated(tx, stop, "trusted-embedded-host".into())
    }
    pub fn authenticated(
        tx: mpsc::Sender<Outbound>,
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
            Err(anyhow::anyhow!(if reply.prepare {
                "host prepare failed before execution; dispatch is not_sent"
            } else {
                "dynamic tool client returned an RPC error or malformed reply; outcome is UNKNOWN"
            }))
        } else {
            Ok(response["result"].clone())
        };
        let _ = reply.sender.send(result);
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
            let _ = self
                .host
                .tx
                .try_send(Outbound::Message(areal_protocol::notification(
                    "areal/tool/cancelled",
                    json!({"requestId":self.id}),
                )));
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
    async fn prepare_schedule(
        &self,
        params: Value,
        cancel: CancellationToken,
    ) -> anyhow::Result<Value> {
        tokio::time::timeout(
            std::time::Duration::from_secs(12),
            self.request("areal/task/prepare", params, cancel),
        )
        .await
        .map_err(|_| anyhow::anyhow!("schedule preparation timed out; execution not started"))?
    }
    async fn prepare_browser(
        &self,
        params: Value,
        cancel: CancellationToken,
    ) -> anyhow::Result<Option<Value>> {
        Ok(Some(
            tokio::time::timeout(
                std::time::Duration::from_secs(12),
                self.request("areal/browser/prepare", params, cancel),
            )
            .await
            .map_err(|_| {
                anyhow::anyhow!("browser prepare timed out before execution; dispatch is not_sent")
            })??,
        ))
    }
    async fn prepare_computer(
        &self,
        params: Value,
        cancel: CancellationToken,
    ) -> anyhow::Result<Option<Value>> {
        Ok(Some(
            tokio::time::timeout(
                std::time::Duration::from_secs(12),
                self.request("areal/computer/prepare", params, cancel),
            )
            .await
            .map_err(|_| {
                anyhow::anyhow!("computer prepare timed out before execution; dispatch is not_sent")
            })??,
        ))
    }
    async fn end_cua_turn(&self, request: Value) -> anyhow::Result<()> {
        self.request("areal/cua/turnEnded", request, CancellationToken::new())
            .await?;
        Ok(())
    }
    async fn page_tool_notice(
        &self,
        notice: areal_protocol::plugin_runtime::PageToolNotice,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(!self.is_closed(), "page-tool Host disconnected");
        self.tx
            .try_send(Outbound::Message(notice.into_notification()))
            .map_err(|_| anyhow::anyhow!("page-tool notice delivery failed"))
    }
    async fn wait_closed(&self) {
        self.stop.cancelled().await;
    }
    async fn call(
        &self,
        params: Value,
        cancel: CancellationToken,
    ) -> anyhow::Result<DynamicToolResponse> {
        let value = self.request("item/tool/call", params, cancel).await?;
        serde_json::from_value(value).map_err(Into::into)
    }
}

impl ToolHost {
    async fn request(
        &self,
        method: &str,
        params: Value,
        cancel: CancellationToken,
    ) -> anyhow::Result<Value> {
        anyhow::ensure!(!self.is_closed(), "dynamic tool client disconnected");
        let id = format!(
            "areal-tool/{}/{}",
            self.id,
            self.next.fetch_add(1, Ordering::Relaxed)
        );
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(
            id.clone(),
            PendingReply {
                sender: tx,
                prepare: matches!(
                    method,
                    "areal/browser/prepare" | "areal/computer/prepare" | "areal/task/prepare"
                ),
            },
        );
        let _pending = Pending {
            host: self,
            id: id.clone(),
        };
        if self
            .tx
            .try_send(Outbound::Message(
                json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
            ))
            .is_err()
        {
            self.stop.cancel();
            anyhow::bail!("dynamic tool client delivery failed");
        }
        tokio::select! {
            biased;
            _ = cancel.cancelled() => anyhow::bail!("dynamic tool request cancelled"),
            _ = self.stop.cancelled() => anyhow::bail!("dynamic tool client disconnected"),
            result = rx => result?,
        }
    }
}
