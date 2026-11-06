//! 连续可信读取按空闲槽补位；其他调用形成必须排空的串行屏障。

use super::*;
use futures_util::{StreamExt, stream::FuturesUnordered};

pub(crate) struct ParallelReadResult {
    pub(crate) bytes: usize,
    pub(crate) unexecuted: Option<String>,
}

impl Engine {
    pub(crate) async fn parallel_read_width(&self, cell: &Cell) -> usize {
        // 插件 hooks 与重复失败门禁仍依赖逐调用结算；有限输出使用逐调用预留。
        if cell
            .state
            .lock()
            .await
            .active
            .as_ref()
            .is_some_and(|active| !active.hooks.is_empty())
            || self.limits.max_repeated_tool_failures != 0
        {
            1
        } else {
            self.extensions.policy.parallel_read_calls
        }
    }

    pub(crate) fn supports_parallel_read_call(&self, tool: &registry::RegisteredTool) -> bool {
        tool.supports_parallel_reads()
            && !self
                .extensions
                .hooks
                .iter()
                .any(|hook| hook.matcher == "*" || hook.matcher == tool.definition.name)
    }

    pub(crate) async fn parallel_read_tools(
        self: &Arc<Self>,
        cell: &Arc<Cell>,
        cancel: &CancellationToken,
        calls: Vec<ToolCall>,
        tool_count: &mut usize,
        steer: &mpsc::Receiver<bool>,
        budgets: (usize, usize),
    ) -> anyhow::Result<ParallelReadResult> {
        let (tool_limit, remaining_output) = budgets;
        let width = self.parallel_read_width(cell).await;
        let finite = self.limits.max_output_bytes != 0;
        let mut available = remaining_output.saturating_sub(HANDOFF_OUTPUT_RESERVE);
        let mut pending = FuturesUnordered::new();
        let mut calls = calls.into_iter().peekable();
        let mut admission_error = None;
        let mut stopped = false;
        let mut bytes = 0;
        let mut unexecuted = None;
        loop {
            while !stopped && pending.len() < width {
                if cancel.is_cancelled() {
                    admission_error = Some(anyhow::anyhow!("cancelled"));
                    stopped = true;
                    break;
                }
                if !steer.is_empty() {
                    stopped = true;
                    break;
                }
                let Some(call) = calls.peek() else { break };
                let reservation = if finite {
                    let minimum = self.tool_output_budget(cell, call).await;
                    if available < minimum {
                        if pending.is_empty() {
                            unexecuted = Some(call.name.clone());
                            stopped = true;
                        }
                        break;
                    }
                    // 仅用于已声明可信、固定内置读取。结果有界；额外预留覆盖 JSON 转义及
                    // 原始/有效参数在审计元数据中的副本。预算不足时退回单个调用，不能抢占在途预留。
                    let bound = minimum
                        .saturating_mul(24)
                        .saturating_add(call.id.len().saturating_mul(24));
                    if available < bound && !pending.is_empty() {
                        break;
                    }
                    bound.min(available)
                } else {
                    usize::MAX
                };
                let call = calls.next().unwrap();
                let admission = async {
                    self.reserve_agent_tool_call(cell)?;
                    *tool_count += 1;
                    cell.state.lock().await.active.as_mut().unwrap().tool_calls = *tool_count;
                    anyhow::ensure!(
                        tool_limit == 0 || *tool_count <= tool_limit,
                        "turn tool-call limit exceeded"
                    );
                    let (started, ready) = tokio::sync::oneshot::channel();
                    let result = self
                        .start_tool(cell, cancel, call, reservation, Some(started), None)
                        .await?;
                    Ok::<_, anyhow::Error>((result, ready))
                }
                .await;
                let (result, ready) = match admission {
                    Ok(pair) => pair,
                    Err(error) => {
                        admission_error = Some(error);
                        stopped = true;
                        break;
                    }
                };
                if finite {
                    available -= reservation;
                }
                pending.push(async move { (reservation, result.await) });
                // 历史意图按模型声明顺序落盘；只等意图，不等执行完成。
                if ready.await.is_err() {
                    stopped = true;
                }
            }
            let Some((reservation, result)) = pending.next().await else {
                break;
            };
            match result
                .map_err(anyhow::Error::from)
                .and_then(|result| result)
            {
                Ok(size) => {
                    bytes += size;
                    if finite {
                        available = available.saturating_add(reservation).saturating_sub(size);
                        if size > reservation {
                            admission_error.get_or_insert_with(|| anyhow::anyhow!(
                                "trusted read receipt exceeded its output reservation; results retained, no further calls admitted"
                            ));
                            stopped = true;
                        }
                    }
                }
                Err(error) => {
                    admission_error.get_or_insert(error);
                    stopped = true;
                }
            }
            // 失败后只结算在途调用；不得补位、跨越写屏障或丢失 UNKNOWN。
        }
        if let Some(error) = admission_error {
            return Err(error);
        }
        Ok(ParallelReadResult { bytes, unexecuted })
    }
}
