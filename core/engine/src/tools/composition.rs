//! 组合入口共用原生子调用派发，不增加执行后端或恢复重放。
use super::*;
use std::{sync::atomic::Ordering, time::Instant};

impl Engine {
    pub(super) async fn dispatch_nested_tool(
        self: &Arc<Self>,
        invocation: &extensions::Invocation<'_>,
        cancel: &CancellationToken,
        call: ToolCall,
        remaining: &mut usize,
        deadline: Instant,
    ) -> rt::Result<Value> {
        let error = |code, message: &str| rt::Error::new(code, message);
        if cancel.is_cancelled() || Instant::now() >= deadline {
            return Err(error(
                rt::ErrorCode::ScopeClosed,
                "composition cancelled before dispatch",
            ));
        }
        if *remaining < self.tool_output_budget(invocation.cell, &call).await {
            return Err(error(
                rt::ErrorCode::ResourceExhausted,
                "shared output budget exhausted",
            ));
        }
        {
            let mut state = invocation.cell.state.lock().await;
            let limit = if state.thread.is_read_only_side() {
                if self.limits.max_tool_calls == 0 {
                    self.limits.max_side_tool_calls
                } else {
                    self.limits
                        .max_tool_calls
                        .min(self.limits.max_side_tool_calls)
                }
            } else {
                self.limits.max_tool_calls
            };
            let active = state.active.as_mut().unwrap();
            if active.sealed || (limit != 0 && active.tool_calls >= limit) {
                return Err(error(
                    rt::ErrorCode::ResourceExhausted,
                    "shared tool budget exhausted",
                ));
            }
            self.reserve_agent_tool_call(invocation.cell)
                .map_err(|e| rt::Error::new(rt::ErrorCode::ResourceExhausted, e.to_string()))?;
            active.tool_calls += 1;
        }
        let call_id = call.id.clone();
        let mut child = self
            .start_tool(
                invocation.cell,
                cancel,
                call,
                *remaining,
                None,
                Some(invocation.call.id.clone()),
            )
            .await
            .map_err(|e| rt::Error::new(rt::ErrorCode::Unavailable, e.to_string()))?;
        // 取消后仍等待原生收据结算，不能遗留写入后继续派发后续操作。
        let result = tokio::select! {
            value = &mut child => value,
            _ = cancel.cancelled() => (&mut child).await,
            _ = tokio::time::sleep_until(deadline.into()) => { cancel.cancel(); (&mut child).await }
        };
        let bytes = match result {
            Ok(Ok(bytes)) => bytes,
            value => {
                return Err(rt::Error::new(
                    rt::ErrorCode::Unavailable,
                    format!("composition child did not settle: {value:?}"),
                ));
            }
        };
        invocation
            .nested_output_bytes
            .fetch_add(bytes, Ordering::Relaxed);
        *remaining = remaining.saturating_sub(bytes);
        let state = invocation.cell.state.lock().await;
        let item = state
            .thread
            .turns
            .last()
            .unwrap()
            .items
            .iter()
            .find(|item| matches!(item, Item::DynamicToolCall {call_id: id, ..} if id == &call_id))
            .ok_or_else(|| error(rt::ErrorCode::Unavailable, "missing child journal"))?;
        Ok(program::child_view(item))
    }
}
