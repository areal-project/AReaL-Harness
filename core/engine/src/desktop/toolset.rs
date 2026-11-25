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
            let _ordinary = engine.toolset_admission(thread).await?;
            let mut bindings = cell.bindings.write().await;
            // 已有业务工具必须先经 resume 重绑；空工具集无法由 resume 绑定，允许显式认领。
            let owns_tools = match bindings.host.as_ref().filter(|old| !old.is_closed()) {
                Some(owner) => owner.id() == host.id(),
                None => thread.dynamic_tools.is_empty(),
            };
            if host.is_closed() || !owns_tools {
                return Err(Error::Conflict);
            }
            let mut version = ThreadToolsetVersion {
                thread_id: request.thread_id,
                toolset_revision: thread.toolset_revision,
            };
            if thread.dynamic_tools == request.dynamic_tools {
                bindings.schedule_host = None;
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
            let write_error = match engine.persist(&candidate).await {
                Ok(()) => None,
                Err(error @ Error::Storage(_)) => {
                    // rename 之后目录同步仍可能失败。保留可读到的版本，但本代不能再执行或确认换表。
                    state.poisoned = true;
                    if !engine
                        .store
                        .read_thread_record(&candidate.id)
                        .await
                        .is_ok_and(|saved| {
                            saved.toolset_revision == candidate.toolset_revision
                                && saved.dynamic_tools == candidate.dynamic_tools
                        })
                    {
                        return Err(error);
                    }
                    Some(error)
                }
                Err(error) => return Err(error),
            };
            state.thread = candidate;
            crate::prompt_prediction::invalidate(&mut state);
            bindings.registry = registry;
            bindings.host = Some(host);
            // 定时投递已结算；后续普通 Turn 必须再按当前业务宿主的在线状态准入。
            bindings.schedule_host = None;
            if let Some(error) = write_error {
                return Err(error);
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    struct Host;
    #[async_trait::async_trait]
    impl crate::tools::DynamicToolHost for Host {
        fn id(&self) -> &str {
            "toolset-write-fault"
        }
        fn is_closed(&self) -> bool {
            false
        }
        async fn call(
            &self,
            _: Value,
            _: CancellationToken,
        ) -> anyhow::Result<areal_protocol::DynamicToolResponse> {
            unreachable!("an uncertain write must not dispatch a tool")
        }
    }

    #[tokio::test]
    async fn post_rename_error_preserves_the_observed_revision_until_restart() {
        let dir = tempfile::tempdir().unwrap();
        let open = || {
            let model =
                model::ChatModel::new("http://127.0.0.1:9".into(), "fixture".into(), None).unwrap();
            Engine::open(dir.path(), Arc::new(model), Limits::default()).unwrap()
        };
        let engine = open();
        let id = engine.create("/workspace".into()).await.unwrap().id;
        let tool: areal_protocol::ToolDefinition = serde_json::from_value(json!({
            "name":"lookup", "description":"Look up a record", "inputSchema":{"type":"object"}
        }))
        .unwrap();
        let update = |revision, tools| SetThreadTools {
            thread_id: id.clone(),
            expected_toolset_revision: revision,
            dynamic_tools: tools,
        };
        let host = Arc::new(Host);
        let mut events = engine.subscribe(&id).await.unwrap();
        engine
            .store
            .set_fork_fault(crate::store::ForkFault::AfterPersistError);
        assert!(matches!(
            engine
                .set_thread_tools(update(0, vec![tool.clone()]), host.clone())
                .await,
            Err(Error::Storage(_))
        ));
        let disk = engine.store.read_thread_record(&id).await.unwrap();
        assert_eq!(disk.toolset_revision, 1);
        assert_eq!(disk.dynamic_tools, [tool]);
        let observed = engine.read(&id, false).await.unwrap();
        assert_eq!(observed.toolset_revision, disk.toolset_revision);
        assert_eq!(observed.dynamic_tools, disk.dynamic_tools);
        assert!(
            events.try_recv().is_err(),
            "未确认持久性前不能发布工具就绪事件"
        );
        for revision in [0, 1] {
            assert!(
                engine
                    .set_thread_tools(update(revision, vec![]), host.clone())
                    .await
                    .is_err()
            );
        }
        assert!(matches!(
            engine.start(&id, vec![Input::text("next")]).await,
            Err(Error::Storage(_))
        ));
        engine.shutdown().await;
        drop(engine);

        let restored = open();
        restored.bind_tool_host(&id, host.clone()).await.unwrap();
        assert_eq!(restored.read(&id, false).await.unwrap().toolset_revision, 1);
        assert_eq!(
            restored
                .set_thread_tools(update(1, vec![]), host)
                .await
                .unwrap()
                .toolset_revision,
            2
        );
        restored.shutdown().await;
    }
}
