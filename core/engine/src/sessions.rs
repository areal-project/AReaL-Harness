//! 会话查询、创建、订阅与子任务归属。

use super::*;

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
                .create_inner(cwd, None, None, Vec::new(), None, None)
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
                .create_inner(cwd, None, None, definitions, Some(host), None)
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

    pub(crate) async fn create_inner(
        self: &Arc<Self>,
        cwd: String,
        parent: Option<(&Thread, usize, bool)>,
        initial: Option<(Vec<Input>, CancellationToken)>,
        dynamic_tools: Vec<areal_protocol::ToolDefinition>,
        host: Option<Arc<dyn tools::DynamicToolHost>>,
        desktop: Option<areal_protocol::desktop::DesktopState>,
    ) -> Result<(Thread, Option<Turn>)> {
        let _admission = self.tasks.token();
        if !self.accepting_work() {
            return Err(Error::Closed);
        }
        let (parent, depth, research) = parent
            .map_or((None, 0, false), |(thread, depth, research)| {
                (Some(thread), depth + 1, research)
            });
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
        let desktop = if desktop.is_none() && parent.is_none() && default_profile.is_some() {
            Some(areal_protocol::desktop::DesktopState {
                configuration: self.resolve_config(default_profile, None, Default::default(), 1)?,
                ..Default::default()
            })
        } else {
            desktop
        };
        let bindings = tools::Bindings {
            registry: if research {
                self.registry.clone().research_only()
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
            desktop,
            id: thread_id.clone(),
            session_id: parent.map_or(thread_id.clone(), |p| p.session_id.clone()),
            parent_thread_id: parent.map(|p| p.id.clone()),
            preview: String::new(),
            model_provider: self.model.provider().into(),
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
        let cell = Cell::new(thread.clone(), depth, bindings);
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
        if research {
            let scratch = self
                .command_scratch(&cell)
                .ok_or_else(|| Error::Invalid("research agent scratch unavailable".into()))?;
            std::fs::create_dir(&scratch)
                .map_err(|e| Error::Storage(format!("create private agent scratch: {e}")))?;
            scratch_reservation.0 = Some(scratch);
        }
        let mut guard = cell.state.lock().await;
        {
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
        let cell = self.raw_cell(thread_id).await?;
        let mut thread = cell.state.lock().await.thread.clone();
        if include_turns && thread.desktop.as_ref().is_some_and(|d| d.archived) {
            thread = self
                .store
                .read_thread(thread_id)
                .await
                .map_err(|e| Error::Storage(e.to_string()))?;
        }
        if !include_turns {
            thread.turns.clear();
            thread.context_checkpoint = None;
        }
        Ok(thread)
    }

    pub async fn list(
        &self,
        after: Option<&str>,
        limit: usize,
        parent: Option<&str>,
    ) -> Result<(Vec<Thread>, Option<String>)> {
        if limit == 0 || limit > 100 {
            return Err(Error::Invalid("limit must be 1..100".into()));
        }
        let cells: Vec<_> = self
            .threads
            .read()
            .await
            .iter()
            .filter(|(key, _)| after.is_none_or(|a| key.as_str() > a))
            .map(|(_, cell)| cell.clone())
            .collect();
        let mut data = Vec::new();
        for cell in cells {
            let state = cell.state.lock().await;
            if parent.is_some_and(|p| state.thread.parent_thread_id.as_deref() != Some(p)) {
                continue;
            }
            if data.len() == limit {
                return Ok((data.clone(), data.last().map(|t: &Thread| t.id.clone())));
            }
            let mut thread = state.thread.clone();
            thread.turns.clear();
            thread.context_checkpoint = None;
            data.push(thread);
        }
        Ok((data, None))
    }

    pub async fn subscribe(&self, thread_id: &str) -> Result<broadcast::Receiver<Value>> {
        Ok(self.cell(thread_id).await?.events.subscribe())
    }

    pub async fn snapshot_and_subscribe(
        &self,
        thread_id: &str,
    ) -> Result<(Thread, broadcast::Receiver<Value>)> {
        let cell = self.raw_cell(thread_id).await?;
        let state = cell.state.lock().await;
        let thread = if state.thread.desktop.as_ref().is_some_and(|d| d.archived) {
            self.store
                .read_thread(thread_id)
                .await
                .map_err(|e| Error::Storage(e.to_string()))?
        } else {
            state.thread.clone()
        };
        Ok((thread, cell.events.subscribe()))
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
        if request.workspace_mode.as_deref() == Some("isolatedWrite") {
            return Err(Error::Invalid("use spawn_agent for isolated writes".into()));
        }
        self.mutate(move |engine| async move {
            engine
                .spawn_child_inner(
                    &request.parent_thread_id,
                    request.input.clone(),
                    false,
                    None,
                    Some(&request),
                    None,
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
                    .visible_tools(&parent, config, false)
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
                Some((&state.thread, parent.depth, research)),
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
                    ..Default::default()
                }),
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
