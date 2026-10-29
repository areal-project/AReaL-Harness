//! 会话查询、创建、订阅与子任务归属。

use super::*;

// 读取与订阅快照共用当前执行状态；冻结历史不持久化模型容量等待。
fn project_side_capacity(thread: &mut Thread, active: Option<&Active>) {
    if thread.is_read_only_side()
        && let Some(desktop) = thread.desktop.as_mut()
    {
        desktop.side_capacity_status = active.map(|active| {
            if active.waiting_for_model_capacity {
                "waiting"
            } else {
                "available"
            }
            .into()
        });
    }
}

impl Engine {
    pub async fn read_blob(&self, id: &str) -> Result<Vec<u8>> {
        self.store
            .read_blob(id)
            .await
            .map_err(|error| Error::Storage(error.to_string()))
    }

    pub async fn create(self: &Arc<Self>, cwd: String) -> Result<Thread> {
        self.mutate(move |engine| async move {
            engine
                .create_inner(cwd, None, None, Vec::new(), None, None, false)
                .await
                .map(|(thread, _)| thread)
        })
        .await
    }

    pub async fn create_with_tools(
        self: &Arc<Self>,
        cwd: String,
        definitions: Vec<areal_protocol::ToolDefinition>,
        host: Arc<dyn tools::DynamicToolHost>,
    ) -> Result<Thread> {
        self.mutate(move |engine| async move {
            engine
                .create_inner(cwd, None, None, definitions, Some(host), None, false)
                .await
                .map(|(thread, _)| thread)
        })
        .await
    }

    /// Reconnect the executor of a persisted dynamic-tool thread while idle.
    pub async fn bind_tool_host(
        &self,
        thread_id: &str,
        host: Arc<dyn tools::DynamicToolHost>,
    ) -> Result<()> {
        let cell = self.cell(thread_id).await?;
        let state = cell.state.lock().await;
        self.ensure_hook_session_open(&cell, &state.thread)?;
        if state.thread.dynamic_tools.is_empty() {
            return Ok(());
        }
        let mut bindings = cell.bindings.write().await;
        if bindings
            .host
            .as_ref()
            .is_some_and(|old| old.id() == host.id())
        {
            return Ok(());
        }
        if state.active.is_some() || bindings.host.as_ref().is_some_and(|old| !old.is_closed()) {
            return Err(Error::Conflict);
        }
        bindings.host = Some(host);
        Ok(())
    }

    // TaskRun 的独立 Session 也需复用创建与回滚边界，预检不能延后到首个工具。
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn create_inner(
        self: &Arc<Self>,
        cwd: String,
        parent: Option<(&Thread, usize, bool, &[crate::plugin_hooks::BoundHook])>,
        initial: Option<(Vec<Input>, CancellationToken)>,
        dynamic_tools: Vec<areal_protocol::ToolDefinition>,
        host: Option<Arc<dyn tools::DynamicToolHost>>,
        desktop: Option<areal_protocol::desktop::DesktopState>,
        check_execution: bool,
    ) -> Result<(Thread, Option<Turn>)> {
        let _admission = self.tasks.token();
        if !self.accepting_work() {
            return Err(Error::Closed);
        }
        let (parent, depth, research, inherited_hooks) = parent.map_or(
            (None, 0, false, None),
            |(thread, depth, research, hooks)| (Some(thread), depth + 1, research, Some(hooks)),
        );
        if !Path::new(&cwd).is_absolute() {
            return Err(Error::Invalid("cwd must be absolute".into()));
        }
        if let Some(runtime) = &self.runtime {
            let cwd = Path::new(&cwd)
                .canonicalize()
                .map_err(|_| Error::Invalid("cwd must exist in the Runtime workspace".into()))?;
            if !cwd.is_dir() || !cwd.starts_with(&runtime.workspace) {
                return Err(Error::Invalid(
                    "cwd is outside the configured Runtime workspace".into(),
                ));
            }
        }
        // 旧 thread/start 也使用同一默认 Skill 配置；子任务继续继承父任务的冻结配置。
        let default_profile = self.desktop.default_profile.read().unwrap().clone();
        let desktop = if desktop.is_none()
            && parent.is_none()
            && (default_profile.is_some() || self.plugin_store().is_ok())
        {
            Some(areal_protocol::desktop::DesktopState {
                configuration: {
                    let mut c =
                        self.resolve_config(default_profile, None, Default::default(), 1)?;
                    c.allow_plugin_skills = true;
                    c
                },
                ..Default::default()
            })
        } else {
            desktop
        };
        let parent_registry = if let Some(parent) = parent {
            let cell = self.threads.read().await.get(&parent.id).cloned();
            if let Some(cell) = cell {
                Some(cell.bindings.read().await.registry.clone())
            } else {
                None
            }
        } else {
            None
        };
        let bindings = tools::Bindings {
            registry: if research {
                self.registry.clone().research_only()
            } else if let Some(registry) = parent_registry {
                registry
            } else {
                self.registry
                    .with_dynamic(&dynamic_tools)
                    .map_err(|e| Error::Invalid(e.to_string()))?
            },
            host,
        };
        if initial.is_some()
            && !dynamic_tools.is_empty()
            && bindings.host.as_ref().is_none_or(|host| host.is_closed())
        {
            return Err(Error::Invalid(
                "dynamic tools require a connected owner".into(),
            ));
        }
        let thread_id = id();
        let mut thread = Thread {
            conversation: None,
            history_archive: None,
            goals: Default::default(),
            goal_owner: parent.and_then(|p| {
                p.goals
                    .goal
                    .as_ref()
                    .filter(|g| g.status == areal_protocol::goals::GoalStatus::Active)
                    .map(|g| areal_protocol::goals::GoalOwner {
                        thread_id: p.id.clone(),
                        goal_id: g.id.clone(),
                    })
                    .or_else(|| p.goal_owner.clone())
            }),
            desktop,
            id: thread_id.clone(),
            session_id: parent.map_or(thread_id.clone(), |p| p.session_id.clone()),
            parent_thread_id: parent.map(|p| p.id.clone()),
            preview: String::new(),
            name: None,
            name_attempt_turn_id: None,
            model_provider: self.model_provider(),
            created_at: now(),
            updated_at: now(),
            status: ThreadStatus::Idle,
            cwd,
            cli_version: env!("CARGO_PKG_VERSION").into(),
            source: if research {
                "nativeResearchAgent"
            } else {
                "appServer"
            }
            .into(),
            ephemeral: false,
            turns: Vec::new(),
            context_checkpoint: None,
            dynamic_tools,
            toolset_revision: 0,
        };
        if let Some(data) = &mut thread.desktop {
            for receipt in &mut data.receipts {
                if receipt.method == "areal/thread/start" && receipt.result.is_null() {
                    receipt.result = json!({"threadId":thread_id});
                }
            }
        }
        let initial = match initial {
            Some((input, cancel)) => {
                if cancel.is_cancelled() {
                    return Err(Error::Closed);
                }
                let (candidate, turn) = self.prepare_turn(&thread, input)?;
                let admission = self.reserve_active_turn()?;
                thread = candidate;
                Some((turn, cancel, admission))
            }
            None => None,
        };
        // 注册预留容量后释放目录锁；磁盘 I/O 不串行化不同会话。
        let parent_scratch = match parent {
            Some(parent) => Some(self.raw_cell(&parent.id).await?.scratch_path.clone()),
            None => None,
        };
        let cell = Cell::new(thread.clone(), depth, bindings, parent_scratch.as_deref());
        if let Some(hooks) = inherited_hooks
            && !research
        {
            let _ = cell.hooks.inherited.set(hooks.to_vec());
            cell.hooks.child_start.store(true, Ordering::Release);
        }
        // Roll back an unadmitted worker's empty directory on error or future
        // cancellation. Never recursively delete paths or worker evidence.
        struct PendingScratch(Option<std::path::PathBuf>);
        impl Drop for PendingScratch {
            fn drop(&mut self) {
                if let Some(path) = &self.0 {
                    let _ = std::fs::remove_dir(path);
                }
            }
        }
        let mut scratch_reservation = PendingScratch(None);
        let scratch = self.command_scratch(&cell);
        if research && scratch.is_none() {
            return Err(Error::Invalid("research agent scratch unavailable".into()));
        }
        if (research || check_execution || (parent.is_some() && initial.is_some()))
            && let Some(scratch) = scratch
        {
            if let Some(parent) = scratch.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| Error::Storage(format!("create agent scratch parent: {e}")))?;
            }
            std::fs::create_dir(&scratch)
                .map_err(|e| Error::Storage(format!("create private agent scratch: {e}")))?;
            scratch_reservation.0 = Some(scratch);
        }
        if (check_execution || (parent.is_some() && initial.is_some()))
            && let Some(runtime) = &self.runtime
        {
            // 子任务先证明收窄后的执行路径可用，再持久化和发送首个模型请求。
            // 这是只读能力查询；拒绝不创建执行，也不改变父任务的权限和可用性。
            let permissions = self.active_permissions(&cell).await.map_err(|error| {
                Error::Invalid(format!("child scope preparation failed: {error}"))
            })?;
            let checked = runtime.client.check_scope(areal_runtime_protocol::CheckScope {
                parent_scope_id: runtime.command_scope.as_ref().map_or_else(
                    || runtime.client.info().root_scope_id.clone(),
                    |scope| scope.scope_id.clone(),
                ),
                permissions,
            }).await.map_err(|error| Error::Invalid(format!(
                "child execution unavailable before model start: {error}; continue in the parent or use a deployment that supports this scope; do not widen permissions or retry unchanged"
            )))?;
            if !checked.available {
                return Err(Error::Invalid(
                    "child execution scope is unavailable; no child was started".into(),
                ));
            }
        }
        let mut guard = cell.state.lock().await;
        {
            // 与 Fork/Side 的未发布持久提交共用容量准入；注册预留后即可释放它。
            let _creation = self.thread_creation.lock().await;
            let mut threads = self.threads.write().await;
            if threads.len() >= self.limits.max_threads {
                return Err(Error::Exhausted("thread capacity reached".into()));
            }
            if !self.accepting_work() {
                return Err(Error::Closed);
            }
            threads.insert(thread_id.clone(), cell.clone());
        }
        if let Err(error) = self.persist(&thread).await {
            self.threads.write().await.remove(&thread_id);
            return Err(error);
        }
        // 子会话与首个 Turn 使用同一次快照和准入；失败不会留下不可启动的空子会话。
        let turn = initial.map(|(turn, cancel, admission)| {
            self.activate(&cell, &mut guard, &turn, cancel, admission);
            turn
        });
        drop(guard);
        scratch_reservation.0 = None;
        Ok((thread, turn))
    }

    pub async fn read(&self, thread_id: &str, include_turns: bool) -> Result<Thread> {
        let cell = if include_turns {
            self.raw_cell(thread_id).await?
        } else {
            self.lookup_cell(thread_id).await?
        };
        let mut thread = {
            let state = cell.state.lock().await;
            let mut thread = if include_turns {
                state.thread.clone()
            } else {
                crate::catalog::metadata(&state.thread)
            };
            project_side_capacity(&mut thread, state.active.as_ref());
            thread
        };
        if include_turns && thread.desktop.as_ref().is_some_and(|d| d.archived) {
            thread = self
                .store
                .read_thread(thread_id)
                .await
                .map_err(|e| Error::Storage(e.to_string()))?;
        }
        if include_turns {
            thread = self
                .store
                .hydrate(thread)
                .await
                .map_err(|e| Error::Storage(e.to_string()))?;
        }
        self.refresh_goal_usage(&mut thread);
        if !include_turns {
            thread.turns.clear();
            thread.context_checkpoint = None;
            thread.history_archive = None;
        }
        Ok(thread)
    }

    pub async fn list(
        &self,
        after: Option<&str>,
        limit: usize,
        parent: Option<&str>,
    ) -> Result<(Vec<Thread>, Option<String>)> {
        self.list_filtered(after, limit, |thread| {
            parent.is_none_or(|p| thread.parent_thread_id.as_deref() == Some(p))
        })
        .await
    }

    pub async fn subscribe(&self, thread_id: &str) -> Result<broadcast::Receiver<Value>> {
        Ok(self.cell(thread_id).await?.events.subscribe())
    }

    pub async fn snapshot_and_subscribe(
        &self,
        thread_id: &str,
    ) -> Result<(Thread, broadcast::Receiver<Value>)> {
        let (thread, _, events) = self
            .snapshot_and_subscribe_with_ownership(thread_id, None)
            .await?;
        Ok((thread, events))
    }

    /// 按 Thread → Tasks 顺序捕获快照、所有权与订阅；授权范围只控制标识的可见性。
    pub async fn snapshot_and_subscribe_with_ownership(
        &self,
        thread_id: &str,
        allowed: Option<&std::collections::BTreeSet<String>>,
    ) -> Result<(
        Thread,
        areal_protocol::desktop::ThreadOwnership,
        broadcast::Receiver<Value>,
    )> {
        let cell = self.raw_cell(thread_id).await?;
        let state = cell.state.lock().await;
        let (ownership, _tasks) = self.ownership_and_lock(&state.thread, allowed).await;
        let mut thread = if state.thread.desktop.as_ref().is_some_and(|d| d.archived) {
            self.store
                .read_thread(thread_id)
                .await
                .map_err(|e| Error::Storage(e.to_string()))?
        } else {
            self.store
                .hydrate(state.thread.clone())
                .await
                .map_err(|e| Error::Storage(e.to_string()))?
        };
        project_side_capacity(&mut thread, state.active.as_ref());
        self.refresh_goal_usage(&mut thread);
        Ok((thread, ownership, cell.events.subscribe()))
    }

    /// 有界显示与订阅仍在 Thread → Tasks 同一临界区；传输外壳由调用方提供并一起预算。
    pub async fn snapshot_and_subscribe_bounded(
        &self,
        thread_id: &str,
        identity: &str,
        allowed: Option<&std::collections::BTreeSet<String>>,
        max_bytes: usize,
        mut envelope: Value,
    ) -> Result<(Value, broadcast::Receiver<Value>)> {
        let cell = self.raw_cell(thread_id).await?;
        let state = cell.state.lock().await;
        let (ownership, _tasks) = self.ownership_and_lock(&state.thread, allowed).await;
        let mut thread = if state.thread.desktop.as_ref().is_some_and(|d| d.archived) {
            self.store
                .read_thread_record(thread_id)
                .await
                .map_err(|e| Error::Storage(e.to_string()))?
        } else {
            state.thread.clone()
        };
        project_side_capacity(&mut thread, state.active.as_ref());
        self.refresh_goal_usage(&mut thread);
        let mut metadata = thread.clone();
        metadata.turns.clear();
        metadata.context_checkpoint = None;
        if let Some(desktop) = metadata.desktop.as_mut() {
            desktop.receipts.clear();
        }
        envelope["cwd"] = json!(metadata.cwd);
        envelope["thread"] = json!(metadata);
        envelope["ownership"] = json!(ownership);
        let empty_active_turn = thread
            .turns
            .last()
            .filter(|turn| turn.status == TurnStatus::InProgress && turn.items.is_empty())
            .cloned();
        let result = self
            .store
            .own_history_page(
                thread,
                identity.into(),
                None,
                max_bytes,
                Some(envelope),
                empty_active_turn,
            )
            .await?;
        Ok((result, cell.events.subscribe()))
    }

    /// 旧页仅构造显示投影；归档会话从持久 Record 读取，不能使用已释放 turns 的驻留副本。
    pub async fn own_history(
        &self,
        identity: &str,
        thread_id: &str,
        cursor: Option<String>,
        max_bytes: usize,
    ) -> Result<Value> {
        let cell = self.raw_cell(thread_id).await?;
        let state = cell.state.lock().await;
        let thread = if state.thread.desktop.as_ref().is_some_and(|d| d.archived) {
            self.store
                .read_thread_record(thread_id)
                .await
                .map_err(|e| Error::Storage(e.to_string()))?
        } else {
            state.thread.clone()
        };
        self.store
            .own_history_page(thread, identity.into(), cursor, max_bytes, None, None)
            .await
    }

    pub async fn spawn_child(
        self: &Arc<Self>,
        parent_id: &str,
        input: Vec<Input>,
    ) -> Result<(Thread, Turn)> {
        let parent_id = parent_id.to_owned();
        self.mutate(move |engine| async move {
            engine
                .spawn_child_inner(&parent_id, input, false, None, None, None)
                .await
        })
        .await
    }

    pub async fn spawn_configured_child(
        self: &Arc<Self>,
        request: areal_protocol::desktop::AgentSpawn,
    ) -> Result<(Thread, Turn)> {
        self.spawn_configured_child_inner(request, None).await
    }

    pub(crate) async fn spawn_configured_model_child(
        self: &Arc<Self>,
        request: areal_protocol::desktop::AgentSpawn,
        parent_turn: String,
    ) -> Result<(Thread, Turn)> {
        self.spawn_configured_child_inner(request, Some(parent_turn))
            .await
    }

    async fn spawn_configured_child_inner(
        self: &Arc<Self>,
        request: areal_protocol::desktop::AgentSpawn,
        model_parent_turn: Option<String>,
    ) -> Result<(Thread, Turn)> {
        if request.workspace_mode.as_deref() == Some("isolatedWrite") {
            return Err(Error::Invalid("use spawn_agent for isolated writes".into()));
        }
        let execution_policy = areal_protocol::delegation::ChildExecutionPolicy {
            exclusive_write: request.workspace_mode.as_deref() == Some("sharedWrite"),
            ..Default::default()
        };
        self.mutate(move |engine| async move {
            engine
                .spawn_child_with_policy(
                    &request.parent_thread_id,
                    request.input.clone(),
                    false,
                    model_parent_turn.as_deref(),
                    Some(&request),
                    None,
                    execution_policy,
                )
                .await
        })
        .await
    }

    pub(crate) async fn spawn_delegated_child(
        self: &Arc<Self>,
        request: areal_protocol::desktop::AgentSpawn,
        parent_turn: String,
        exclusive_write: bool,
        max_model_rounds: Option<usize>,
    ) -> Result<(Thread, Turn)> {
        if request.workspace_mode.as_deref() == Some("isolatedWrite") {
            return Err(Error::Invalid(
                "shared child cannot use an isolated workspace".into(),
            ));
        }
        self.mutate(move |engine| async move {
            engine
                .spawn_child_with_policy(
                    &request.parent_thread_id,
                    request.input.clone(),
                    false,
                    Some(&parent_turn),
                    Some(&request),
                    max_model_rounds,
                    areal_protocol::delegation::ChildExecutionPolicy {
                        exclusive_write,
                        deferred_write: !exclusive_write
                            && request.workspace_mode.as_deref() == Some("sharedWrite"),
                    },
                )
                .await
        })
        .await
    }

    pub(super) async fn spawn_child_inner(
        self: &Arc<Self>,
        parent_id: &str,
        input: Vec<Input>,
        research: bool,
        model_parent_turn: Option<&str>,
        request: Option<&areal_protocol::desktop::AgentSpawn>,
        max_model_rounds: Option<usize>,
    ) -> Result<(Thread, Turn)> {
        self.spawn_child_with_policy(
            parent_id,
            input,
            research,
            model_parent_turn,
            request,
            max_model_rounds,
            Default::default(),
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn spawn_child_with_policy(
        self: &Arc<Self>,
        parent_id: &str,
        input: Vec<Input>,
        research: bool,
        model_parent_turn: Option<&str>,
        request: Option<&areal_protocol::desktop::AgentSpawn>,
        max_model_rounds: Option<usize>,
        mut execution_policy: areal_protocol::delegation::ChildExecutionPolicy,
    ) -> Result<(Thread, Turn)> {
        let parent = self.cell(parent_id).await?;
        let mut state = parent.state.lock().await;
        let active = state
            .active
            .as_ref()
            .filter(|a| {
                !a.cancel.is_cancelled()
                    && !a.sealed
                    && model_parent_turn.is_none_or(|id| id == a.id)
            })
            .ok_or(Error::Conflict)?;
        if parent.research || parent.depth >= self.limits.max_agent_depth {
            return Err(Error::Exhausted("agent depth limit reached".into()));
        }
        if active.children.len() + active.isolated_children >= self.limits.max_children_per_turn {
            return Err(Error::Exhausted("parent Turn child limit reached".into()));
        }
        let token = active.cancel.child_token();
        let mut configuration = self.child_configuration(&state.thread, request)?;
        // 父配置或可信 Profile 的只读限制不能被继承模式解除。
        if configuration
            .as_ref()
            .is_some_and(|config| config.read_only)
        {
            execution_policy.deferred_write = false;
        }
        if execution_policy.deferred_write {
            configuration.get_or_insert_with(Default::default).instructions.push_str(
                "\nThis is an inspection/report task. It inherits the parent's execution permissions, not a separate read-only OS sandbox. Do not modify source: those capabilities are not authorization to expand your assigned task. Use file reads and search where sufficient; commands and ambient tools may acquire an exclusive workspace lease. Return findings and evidence."
            );
        }
        if let Some(max) = max_model_rounds {
            let config = configuration.get_or_insert_with(Default::default);
            if max == 0
                || max > 1024
                || config
                    .options
                    .max_model_rounds
                    .is_some_and(|parent| max > parent)
            {
                return Err(Error::Invalid(
                    "child maxModelRounds must be 1..1024 and cannot exceed the parent limit"
                        .into(),
                ));
            }
            config.options.max_model_rounds = Some(max);
            if state.thread.desktop.is_none() {
                // 为预算创建配置不能顺带开放原父任务未启用的桌面工具。
                let mut allowed: Vec<_> = self
                    .visible_tools(&parent, config, false, &state.thread)
                    .await
                    .iter()
                    .filter_map(|d| d["function"]["name"].as_str().map(str::to_owned))
                    .collect();
                if config
                    .tool_allowlist
                    .as_ref()
                    .is_none_or(|names| names.iter().any(|name| name == "agent_report"))
                    && parent
                        .bindings
                        .read()
                        .await
                        .registry
                        .get("agent_report")
                        .is_ok()
                {
                    allowed.push("agent_report".into());
                }
                config.tool_allowlist = Some(allowed);
            }
        }
        validate_input(
            &input,
            &self
                .configured_model(&configuration.clone().unwrap_or_default())?
                .capabilities(),
        )?;
        let (child, turn) = self
            .create_inner(
                state.thread.cwd.clone(),
                Some((&state.thread, parent.depth, research, &active.hooks)),
                Some((input, token)),
                if research {
                    Vec::new()
                } else {
                    state.thread.dynamic_tools.clone()
                },
                if research {
                    None
                } else {
                    parent.bindings.read().await.host.clone()
                },
                configuration.map(|configuration| areal_protocol::desktop::DesktopState {
                    configuration,
                    execution_policy,
                    ..Default::default()
                }),
                false,
            )
            .await?;
        let turn = turn.expect("child creation includes its initial turn");
        state
            .active
            .as_mut()
            .unwrap()
            .children
            .push(child.id.clone());
        if model_parent_turn.is_some() {
            state
                .active
                .as_mut()
                .unwrap()
                .model_children
                .push(child.id.clone());
        }
        parent.emit(
            "areal/agent/spawned",
            json!({"parentThreadId": parent_id, "threadId": child.id, "turnId": turn.id}),
        );
        Ok((child, turn))
    }

    pub async fn wait(&self, thread_id: &str) -> Result<Thread> {
        let cell = self.cell(thread_id).await?;
        let mut settled = cell.settled.subscribe();
        settled
            .wait_for(|done| *done)
            .await
            .map_err(|_| Error::Closed)?;
        self.read(thread_id, true).await
    }
}
