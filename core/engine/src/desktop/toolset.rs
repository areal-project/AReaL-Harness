//! 业务工具集只在两轮对话之间替换；版本和完整定义由同一份 Thread 快照持有。
use super::*;

impl Engine {
    pub async fn set_thread_tools(
        self: &Arc<Self>,
        request: SetThreadTools,
        host: Arc<dyn crate::tools::DynamicToolHost>,
    ) -> Result<ThreadToolsetVersion> {
        self.mutate(move |engine| async move {
            let cell = engine.cell(&request.thread_id).await?;
            let mut state = cell.state.lock().await;
            let thread = &state.thread;
            if thread.is_side() {
                return Err(invalid("SIDE_POLICY_VIOLATION"));
            }
            if state.poisoned
                || state.compacting
                || state.active.is_some()
                || !matches!(thread.status, ThreadStatus::Idle)
                || thread.parent_thread_id.is_some()
                || thread.source != "appServer"
                || thread.toolset_revision != request.expected_toolset_revision
                || thread.desktop.as_ref().is_some_and(|d| {
                    d.archived
                        || d.queue
                            .items
                            .iter()
                            .any(|item| matches!(item.status.as_str(), "pending" | "running"))
                })
            {
                return Err(Error::Conflict);
            }
            engine.ensure_hook_session_open(&cell, thread)?;
            // 与普通 Turn 一样在提交前持有任务预留锁，后台 Run 不能在换表期间接管本 Thread。
            let _ordinary = engine.ordinary_admission(thread).await?;
            let mut bindings = cell.bindings.write().await;
            // 已有业务工具必须先经 resume 重绑；空工具集无法由 resume 绑定，允许显式认领。
            let owns_tools = match bindings.host.as_ref().filter(|old| !old.is_closed()) {
                Some(owner) => owner.id() == host.id(),
                None => thread.dynamic_tools.is_empty(),
            };
            if host.is_closed() || !owns_tools || bindings.schedule_host.is_some() {
                return Err(Error::Conflict);
            }
            let mut version = ThreadToolsetVersion {
                thread_id: request.thread_id,
                toolset_revision: thread.toolset_revision,
            };
            if thread.dynamic_tools == request.dynamic_tools {
                return Ok(version);
            }
            // Browser Dispatcher 由桌面部署的专用通道授权。
            if thread
                .dynamic_tools
                .iter()
                .find(|tool| tool.name == "browser_v1")
                != request
                    .dynamic_tools
                    .iter()
                    .find(|tool| tool.name == "browser_v1")
            {
                return Err(invalid("cannot change desktop-managed tool: browser_v1"));
            }
            let mut candidate = thread.clone();
            candidate.dynamic_tools = request.dynamic_tools;
            // 不接受在下次恢复时会被移除的定义；普通客户端的同名工具仍可使用。
            let count = candidate.dynamic_tools.len();
            retire_removed_desktop_tools(&mut candidate);
            if candidate.dynamic_tools.len() != count {
                return Err(invalid("cannot register a retired desktop tool definition"));
            }
            version.toolset_revision = version
                .toolset_revision
                .checked_add(1)
                .ok_or(Error::Conflict)?;
            candidate.toolset_revision = version.toolset_revision;
            let retired_prediction = retire_prediction(&mut candidate);
            // 与 Turn 准入共用完整目录校验；任一 schema 或部署工具重名，整次更新不生效。
            let registry = engine
                .managed_registry(&candidate, cell.research)
                .map_err(invalid)?;
            engine.persist(&candidate).await?;
            state.thread = candidate;
            crate::prompt_prediction::invalidate(&mut state);
            bindings.registry = registry;
            bindings.host = Some(host);
            cell.emit(
                "areal/thread/tools/attached",
                json!({
                    "threadId": version.thread_id, "toolsetRevision": version.toolset_revision,
                    "dynamicTools": state.thread.dynamic_tools
                }),
            );
            if let Some(slot) = retired_prediction {
                cell.emit(
                    "areal/thread/predictionChanged",
                    json!({"threadId":version.thread_id,"promptPrediction":slot}),
                );
            }
            Ok(version)
        })
        .await
    }
}

// 已发布的建议也要从订阅者的 Composer 撤下，仅取消后台预测不会刷新投影。
fn retire_prediction(thread: &mut Thread) -> Option<PromptPrediction> {
    let slot = thread.desktop.as_mut()?.prompt_prediction.as_mut()?;
    match slot {
        PromptPrediction::Pending {
            source_turn_id,
            configuration_revision,
        }
        | PromptPrediction::Ready {
            source_turn_id,
            configuration_revision,
            ..
        } => {
            *slot = PromptPrediction::Unavailable {
                source_turn_id: source_turn_id.clone(),
                configuration_revision: *configuration_revision,
            };
            Some(slot.clone())
        }
        PromptPrediction::Unavailable { .. } => None,
    }
}
