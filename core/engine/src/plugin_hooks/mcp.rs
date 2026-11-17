use super::*;
use crate::desktop::mcp_interactions::CallOwner;
pub(super) struct HookMcpLease {
    pub(super) context: areal_mcp::RequestOwner,
    pub(super) owner: CallOwner,
    pub(super) key: (String, u64),
    engine: Arc<Engine>,
}
impl HookMcpLease {
    pub(super) async fn close(self) {
        self.owner.cancellation.cancel();
        let mut calls = self.engine.desktop.mcp_interactions.calls.lock().await;
        if calls
            .get(&self.key)
            .is_some_and(|owner| owner.token == self.owner.token)
        {
            calls.remove(&self.key);
        }
    }
}
pub(super) async fn mcp_owner(
    engine: &Arc<Engine>,
    cell: &Arc<Cell>,
    hook: &BoundHook,
    tool: &areal_mcp::McpTool,
    cancel: &CancellationToken,
) -> anyhow::Result<HookMcpLease> {
    let call = model::ToolCall {
        id: id(),
        name: tool.definition.name.clone(),
        arguments: "{}".into(),
    };
    let mut owner = engine.hook_call_owner(cell, &call).await?;
    owner.cancellation = cancel.child_token();
    let key: (String, u64) = (tool.server_name().into(), tool.generation());
    let context =
        engine.mcp_request_context(owner.clone(), key.0.clone(), key.1, Some(tool.clone()));
    let weak = Arc::downgrade(engine);
    let thread = cell.id.clone();
    let guarded_hook = hook.clone();
    let inner = context.clone();
    let guarded = areal_mcp::RequestOwner::new(owner.token.clone(), move || {
        let weak = weak.clone();
        let thread = thread.clone();
        let hook = guarded_hook.clone();
        let inner = inner.clone();
        Box::pin(async move {
            let engine = weak
                .upgrade()
                .ok_or_else(|| anyhow::anyhow!("Core ended"))?;
            let cell = engine.cell(&thread).await?;
            ensure_current(&engine, &cell, &hook).await?;
            inner.validate().await
        })
    });
    // Legacy reverse forms have one unambiguous caller per server generation.
    // Queue admitted handlers instead of skipping a valid deny on internal contention.
    loop {
        ensure_current(engine, cell, hook).await?;
        anyhow::ensure!(
            !cancel.is_cancelled(),
            "hook cancelled while waiting for MCP ownership"
        );
        let mut calls = engine.desktop.mcp_interactions.calls.lock().await;
        if !calls.contains_key(&key) {
            calls.insert(key.clone(), owner.clone());
            break;
        }
        drop(calls);
        tokio::select! {_ = cancel.cancelled()=>anyhow::bail!("hook cancelled waiting for MCP ownership"),_ = tokio::time::sleep(Duration::from_millis(25))=>{}}
    }
    Ok(HookMcpLease {
        context: guarded,
        owner,
        key,
        engine: engine.clone(),
    })
}
