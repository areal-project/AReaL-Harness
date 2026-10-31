//! Turn 准入、追加输入、取消与终态结算。

use super::*;

impl Engine {
    pub async fn start(self: &Arc<Self>, thread_id: &str, input: Vec<Input>) -> Result<Turn> {
        let thread_id = thread_id.to_owned();
        self.mutate(move |engine| async move {
            let cell = engine.cell(&thread_id).await?;
            {
                let state = cell.state.lock().await;
                if state.thread.parent_thread_id.is_some()
                    || state.thread.source == "nativeTaskAgent"
                {
                    return Err(Error::Invalid(
                        "managed workers cannot accept independent turns".into(),
                    ));
                }
            }
            engine
                .start_inner(&thread_id, input, engine.shutdown.child_token())
                .await
        })
        .await
    }

    async fn start_inner(
        self: &Arc<Self>,
        thread_id: &str,
        input: Vec<Input>,
        cancel: CancellationToken,
    ) -> Result<Turn> {
        self.refresh_plugins().await?;
        let _admission = self.tasks.token();
        let _gate = self.desktop.lifecycle.gate.lock().await;
        let cell = self.cell(thread_id).await?;
        let mut state = cell.state.lock().await;
        self.ensure_hook_session_open(&cell, &state.thread)?;
        if !self.accepting_work() || cancel.is_cancelled() {
            return Err(Error::Closed);
        }
        if state.active.is_some() || state.compacting {
            return Err(Error::Conflict);
        }
        if state.thread.desktop.as_ref().is_some_and(|data| {
            data.queue
                .items
                .iter()
                .any(|item| matches!(item.status.as_str(), "pending" | "running"))
        }) {
            return Err(Error::Conflict);
        }
        if state.thread.is_read_only_side()
            && (input.len() != 1 || !matches!(&input[0], Input::Text { .. }))
        {
            return Err(Error::Invalid("SIDE_POLICY_VIOLATION".into()));
        }
        if state.thread.is_read_only_side()
            && let Some(areal_protocol::Conversation::Side { origin, .. }) =
                &state.thread.conversation
        {
            self.check_side_capacity(&origin.source_thread_id, Some(&state.thread.id))
                .await?;
        }
        if !state.thread.dynamic_tools.is_empty()
            && cell
                .bindings
                .read()
                .await
                .host
                .as_ref()
                .is_none_or(|host| host.is_closed())
        {
            return Err(Error::Invalid(
                "dynamic tools require a connected owner; resume this thread to attach a client"
                    .into(),
            ));
        }
        if state.poisoned {
            return Err(Error::Storage(
                "session requires restart after a write failure".into(),
            ));
        }
        if state.thread.turns.iter().flat_map(|turn| &turn.items).any(|item| matches!(item, Item::DynamicToolCall {execution,..} if (execution.outcome == areal_protocol::ToolOutcome::Unknown || execution.hooks.iter().any(|hook| hook.outcome == areal_protocol::ToolOutcome::Unknown)) && execution.inspection.is_none())) {
            return Err(Error::Invalid("an UNKNOWN tool result requires operator inspection and areal/tool/acknowledge before a new turn".into()));
        }
        if state.thread.desktop.as_ref().is_some_and(|d| {
            d.hook_runs
                .iter()
                .any(|r| r.outcome == "unknown" && r.inspection.is_none())
        }) {
            return Err(Error::Invalid(
                "UNKNOWN hook requires operator inspection; refusing replay".into(),
            ));
        }
        let (candidate, turn) = self.prepare_turn(&state.thread, input)?;
        let admission = self.reserve_active_turn()?;
        self.persist(&candidate).await?;
        state.thread = candidate;
        self.activate(&cell, &mut state, &turn, cancel, admission);
        Ok(turn)
    }

    pub(super) fn prepare_turn(
        &self,
        thread: &Thread,
        input: Vec<Input>,
    ) -> Result<(Thread, Turn)> {
        self.prepare_turn_with_skill(thread, input, None)
    }

    /// Setup's Core-selected skill is the complete selection. Package text is not
    /// a user Composer attachment and must never be parsed for additional refs.
    pub(super) fn prepare_turn_with_skill(
        &self,
        thread: &Thread,
        input: Vec<Input>,
        skill: Option<&areal_protocol::desktop::VersionRef>,
    ) -> Result<(Thread, Turn)> {
        let configuration = self.next_request_configuration(
            thread
                .desktop
                .as_ref()
                .map(|d| d.configuration.clone())
                .unwrap_or_default(),
        );
        self.check_configuration_plugin_profile(&configuration)?;
        self.prepare_turn_from_configuration(thread, input, skill, configuration)
    }

    pub(super) fn prepare_turn_from_configuration(
        &self,
        thread: &Thread,
        input: Vec<Input>,
        skill: Option<&areal_protocol::desktop::VersionRef>,
        mut configuration: areal_protocol::desktop::EffectiveConfig,
    ) -> Result<(Thread, Turn)> {
        if let Some(skill) = skill {
            configuration.selected_skills = Some(vec![skill.clone()]);
        } else {
            self.select_plugin_attachments(
                &mut configuration,
                &input,
                !thread.is_read_only_side()
                    && thread.parent_thread_id.is_none()
                    && thread.source != "nativeTaskAgent",
            )?;
        }
        self.check_selected_plugin_tools(thread, &configuration)?;
        let configuration = self.freeze_configuration(configuration);
        let model = self.configured_model(&configuration)?;
        self.validate_fork_model_compatibility(thread, model.as_ref())?;
        self.validate_thread_input(thread, &input, &model.capabilities())?;
        let mut candidate = thread.clone();
        if let Some(data) = &mut candidate.desktop {
            data.prompt_prediction = None;
            if data
                .configuration
                .profile
                .as_ref()
                .is_some_and(|profile| profile.id == "areal-discovered-skills")
            {
                data.configuration.profile = configuration.profile.clone();
            }
        }
        let text = input
            .iter()
            .map(Input::as_text)
            .find(|text| !text.trim().is_empty())
            .unwrap_or_else(|| match input[0].modality() {
                Modality::Image => "[Image]",
                Modality::Audio => "[Audio]",
                Modality::File => "[File]",
                Modality::Text => "",
            });
        if candidate.preview.is_empty() {
            candidate.preview = text.chars().take(120).collect();
        }
        let mut turn = Turn {
            trace: areal_protocol::TurnTrace {
                started_at_ms: Some(crate::execution_trace::now_ms()),
                ..Default::default()
            },
            interruption: None,
            continued_from_turn_id: None,
            started_at: Some(now()),
            completed_at: None,
            duration_ms: None,
            goal: None,
            instruction_snapshot: None,
            instruction_attribution: None,
            generation: None,
            configuration: (thread.desktop.is_some()
                || configuration.default_model_revision.is_some())
            .then_some(configuration),
            id: id(),
            status: TurnStatus::InProgress,
            error: None,
            items: vec![Item::UserMessage {
                id: id(),
                content: input,
            }],
            usage: None,
        };
        self.prepare_goal_turn(&mut candidate, &mut turn)?;
        candidate.turns.push(turn.clone());
        candidate.updated_at = now();
        candidate.status = ThreadStatus::Active {
            active_flags: Vec::new(),
        };
        // 给最终输出预留空间；接受成功的输入和开始状态先落盘。
        if self.limits.max_history_bytes > 0
            && serde_json::to_vec(&candidate)
                .unwrap()
                .len()
                .saturating_add(
                    candidate
                        .history_archive
                        .as_ref()
                        .map_or(0, |a| usize::try_from(a.bytes).unwrap_or(usize::MAX)),
                )
                .saturating_add(self.limits.max_output_bytes.saturating_mul(6))
                .saturating_add(1024)
                > self.limits.max_history_bytes
        {
            return Err(Error::Exhausted(
                "insufficient session history space for another turn".into(),
            ));
        }
        Ok((candidate, turn))
    }

    pub(super) fn reserve_active_turn(&self) -> Result<OwnedSemaphorePermit> {
        if !self.accepting_work() {
            return Err(Error::Closed);
        }
        self.active_turns.clone().try_acquire_owned().map_err(|_| {
            Error::Exhausted("active Turn capacity reached; wait for a Turn to settle".into())
        })
    }

    pub(super) fn activate(
        self: &Arc<Self>,
        cell: &Arc<Cell>,
        state: &mut State,
        turn: &Turn,
        cancel: CancellationToken,
        admission: OwnedSemaphorePermit,
    ) {
        self.activate_with_tool(cell, state, turn, cancel, admission, (None, None));
    }

    pub(super) fn activate_with_tool(
        self: &Arc<Self>,
        cell: &Arc<Cell>,
        state: &mut State,
        turn: &Turn,
        cancel: CancellationToken,
        admission: OwnedSemaphorePermit,
        direct_tool: (
            Option<model::ToolCall>,
            Option<serde_json::Map<String, Value>>,
        ),
    ) {
        let (direct_tool, tool_meta) = direct_tool;
        prompt_prediction::invalidate(state);
        self.spawn_goal_scheduler();
        self.start_task_scheduler();
        let (tx, rx) = mpsc::channel(self.limits.mailbox_capacity);
        let mut model = if direct_tool.is_some() {
            self.model.clone()
        } else {
            self.configured_model(&turn.configuration.clone().unwrap_or_default())
                .expect("configuration validated before admission")
        };
        if turn.goal.is_some() || state.thread.goal_owner.is_some() {
            if let Some(budget) = self.goals.budget(&state.thread) {
                if let Some(goal) = &state.thread.goals.goal {
                    budget.configure(goal.token_budget, true);
                    budget.begin();
                }
                if state.thread.source == "nativeTaskAgent" {
                    budget.begin();
                }
                model = budget.wrap(model);
                cell.goal_role
                    .store(if turn.goal.is_some() { 1 } else { 2 }, Ordering::Release);
            }
        } else {
            cell.goal_role.store(0, Ordering::Release);
        }
        cell.cancel_grace_ms.store(1000, Ordering::Release);
        let execution_started = std::time::Instant::now();
        let started_at_ms = crate::execution_trace::now_ms();
        let trace = &mut state.thread.turns.last_mut().unwrap().trace;
        trace.started_at_ms = Some(started_at_ms);
        trace.queue_duration_ms = Some(trace.queued_at_ms.map_or(0, |queued| {
            started_at_ms.saturating_sub(queued).max(0) as u64
        }));
        state.active = Some(Active {
            tool_exposure: Default::default(),
            context_usage: None,
            context_sequence: 0,
            generation: Default::default(),
            registry: cell.inherited_registry.clone().map(Ok).unwrap_or_else(|| {
                self.managed_registry(&state.thread, cell.research)
                    .map_err(|e| e.to_string())
            }),
            hooks: cell
                .hooks
                .inherited
                .get()
                .map(|hooks| self.admitted_plugin_hooks(&state.thread, hooks))
                .unwrap_or_else(|| self.frozen_plugin_hooks(&state.thread)),
            hook_user_input: true,
            hook_tasks: TaskTracker::new(),
            direct_tool,
            tool_meta,
            tool_calls: 0,
            cua_used: false,
            waiting_for_model_capacity: false,
            started: execution_started,
            isolated_children: 0,
            workspace_exclusive: false,
            deferred_workspace_guard: None,
            workspace_lease_pinned: false,
            workspace_version: None,
            workspace_conflict_call: None,
            _admission: admission,
            id: turn.id.clone(),
            cancel: cancel.clone(),
            steer: tx,
            children: Vec::new(),
            model_children: Vec::new(),
            open_items: HashSet::new(),
            sealed: false,
            scope: None,
            base_scope: None,
            navigation_scopes: BTreeMap::new(),
            model,
            tools: TaskTracker::new(),
            process_cursors: BTreeMap::new(),
            handles: tools::Handles::default(),
        });
        let pending =
            self.pending_trusted_plugins(cell, &state.thread, turn, state.active.as_ref().unwrap());
        cell.settled.send_replace(false);
        let thread_id = &state.thread.id;
        cell.emit("turn/started", json!({"threadId": thread_id, "turn": turn}));
        emit_item(cell, "item/started", thread_id, &turn.id, &turn.items[0]);
        emit_item(cell, "item/completed", thread_id, &turn.id, &turn.items[0]);
        let engine = self.clone();
        let run_cell = cell.clone();
        let session_id = state.thread.session_id.clone();
        let parent_thread_id = state.thread.parent_thread_id.clone().unwrap_or_default();
        let span = info_span!(
            target: trajectory::TARGET,
            "invoke_agent",
            otel.kind = "internal",
            otel.status_code = tracing::field::Empty,
            error.type = tracing::field::Empty,
            areal.turn.number = state.thread.turns.len() as u64 + state.thread.history_archive.as_ref().map_or(0, |a| a.completed_turns),
            otel.name = "invoke_agent",
            gen_ai.operation.name = "invoke_agent",
            gen_ai.conversation.id = %session_id,
            areal.thread.id = %thread_id,
            areal.parent_thread.id = %parent_thread_id,
            areal.turn.id = %turn.id,
            gen_ai.request.model = %state.active.as_ref().unwrap().model.name(),
            gen_ai.provider.name = %state.active.as_ref().unwrap().model.provider(),
            areal.turn.status = tracing::field::Empty,
        );
        self.tasks
            .spawn(async move { engine.run(run_cell, cancel, rx, pending).await }.instrument(span));
    }

    pub async fn steer(
        self: &Arc<Self>,
        thread_id: &str,
        turn_id: &str,
        input: Vec<Input>,
    ) -> Result<()> {
        let thread_id = thread_id.to_owned();
        let turn_id = turn_id.to_owned();
        if self.read(&thread_id, false).await?.is_read_only_side() {
            return Err(Error::Invalid("SIDE_POLICY_VIOLATION".into()));
        }
        self.mutate(move |engine| async move {
            engine.steer_inner(&thread_id, &turn_id, input, false).await
        })
        .await
    }

    pub(crate) async fn steer_child_input(
        self: &Arc<Self>,
        thread_id: &str,
        turn_id: &str,
        input: Vec<Input>,
    ) -> Result<bool> {
        let thread_id = thread_id.to_owned();
        let turn_id = turn_id.to_owned();
        let result = self
            .mutate(move |engine| async move {
                engine.steer_inner(&thread_id, &turn_id, input, true).await
            })
            .await;
        // 读取回执和持久化输入之间子任务可能已封闭；不启动新 Turn 或重放修订。
        // 只有目标生命周期冲突属于未送达回执，其余校验/存储/额度错误仍向上传播。
        match result {
            Ok(()) => Ok(true),
            Err(Error::Conflict) => Ok(false),
            Err(error) => Err(error),
        }
    }

    async fn steer_inner(
        self: &Arc<Self>,
        thread_id: &str,
        turn_id: &str,
        input: Vec<Input>,
        settle_request: bool,
    ) -> Result<()> {
        let cell = self.cell(thread_id).await?;
        if !settle_request {
            let cancel = {
                let state = cell.state.lock().await;
                self.ensure_hook_session_open(&cell, &state.thread)?;
                // Validate admission without publishing user input; release the lock
                // while hooks run, then validate the still-current Turn again below.
                drop(self.prepare_steer(&state, turn_id, input.clone())?);
                state.active.as_ref().ok_or(Error::Conflict)?.cancel.clone()
            };
            self.plugin_hooks_user_input(&cell, &input, &cancel).await?;
        }
        let mut state = cell.state.lock().await;
        let (candidate, item, permit) = self.prepare_steer(&state, turn_id, input)?;
        self.persist(&candidate).await?;
        state.thread = candidate;
        emit_item(&cell, "item/started", thread_id, turn_id, &item);
        emit_item(&cell, "item/completed", thread_id, turn_id, &item);
        self.goal_emit(&cell, &state.thread);
        permit.send(settle_request);
        Ok(())
    }

    // 通道容量、附件和历史上限在持有同一 Thread 锁时校验，供普通引导与队列转移共用。
    pub(crate) fn prepare_steer(
        &self,
        state: &State,
        turn_id: &str,
        input: Vec<Input>,
    ) -> Result<(Thread, Item, tokio::sync::mpsc::OwnedPermit<bool>)> {
        let active = state
            .active
            .as_ref()
            .filter(|a| a.id == turn_id && !a.cancel.is_cancelled() && !a.sealed)
            .ok_or(Error::Conflict)?;
        self.validate_thread_input(&state.thread, &input, &active.model.capabilities())?;
        let permit = active
            .steer
            .clone()
            .try_reserve_owned()
            .map_err(|_| Error::Exhausted("steering mailbox is full".into()))?;
        let item = Item::UserMessage {
            id: id(),
            content: input,
        };
        let mut candidate = state.thread.clone();
        candidate.turns.last_mut().unwrap().items.push(item.clone());
        if let Some(goal) = &mut candidate.goals.goal {
            goal.report_turn_id = None;
            candidate.goals.revision += 1;
            candidate.goals.event_sequence += 1;
        }
        if self.limits.max_history_bytes > 0
            && serde_json::to_vec(&candidate)
                .unwrap()
                .len()
                .saturating_add(
                    candidate
                        .history_archive
                        .as_ref()
                        .map_or(0, |a| usize::try_from(a.bytes).unwrap_or(usize::MAX)),
                )
                .saturating_add(self.limits.max_output_bytes.saturating_mul(6))
                .saturating_add(1024)
                > self.limits.max_history_bytes
        {
            return Err(Error::Exhausted("session history limit reached".into()));
        }
        Ok((candidate, item, permit))
    }

    pub async fn interrupt(&self, thread_id: &str, turn_id: &str) -> Result<()> {
        self.interrupt_guarded(thread_id, turn_id, None).await
    }

    pub async fn interrupt_guarded(
        &self,
        thread_id: &str,
        turn_id: &str,
        admission_guard: Option<areal_protocol::desktop::TurnInterruptAdmissionGuard>,
    ) -> Result<()> {
        let cell = self.cell(thread_id).await?;
        let mut state = cell.state.lock().await;
        // Thread → Tasks 锁持续到队列持久化和取消完成，防止所有权在校验后改变。
        let _ordinary = if let Some(guard) = admission_guard {
            if !guard.ordinary_session {
                return Err(Error::Invalid("ordinarySession must be true".into()));
            }
            if state
                .active
                .as_ref()
                .is_none_or(|active| active.id != turn_id)
            {
                return Err(Error::Conflict);
            }
            Some(self.ordinary_admission(&state.thread).await?)
        } else {
            None
        };
        if let Some(active) = &state.active {
            if active.id != turn_id {
                return Err(Error::Conflict);
            }
        } else if !state.thread.turns.iter().any(|t| t.id == turn_id) {
            return Err(Error::Conflict);
        }
        if state.thread.goals.goal.is_some() {
            let mut candidate = state.thread.clone();
            let goal = candidate.goals.goal.as_mut().unwrap();
            if goal.status == areal_protocol::goals::GoalStatus::Active {
                goal.status = areal_protocol::goals::GoalStatus::Paused;
                goal.reason = Some("user".into());
                goal.settling = state.active.is_some();
                goal.report_turn_id = None;
                candidate.goals.revision += 1;
                candidate.goals.event_sequence += 1;
                let queue = &mut candidate.desktop.get_or_insert_with(Default::default).queue;
                if !queue.paused {
                    queue.paused = true;
                    queue.pause_reason = Some(format!("goal:{}", goal.id));
                    queue.revision += 1;
                }
                self.persist(&candidate).await?;
                state.thread = candidate;
                if let Some(budget) = self.goals.budget(&state.thread) {
                    budget.configure(
                        state
                            .thread
                            .goals
                            .goal
                            .as_ref()
                            .and_then(|g| g.token_budget),
                        false,
                    );
                }
                self.goal_emit(&cell, &state.thread);
            }
        } else if state.thread.desktop.is_some() {
            let mut candidate = state.thread.clone();
            if state.active.is_some()
                && !state.thread.is_read_only_side()
                && state.thread.parent_thread_id.is_none()
                && state.thread.goal_owner.is_none()
                && state.thread.source != "nativeTaskAgent"
                && let Some(turn) = candidate.turns.iter_mut().find(|turn| turn.id == turn_id)
                && turn.interruption.is_none()
            {
                turn.interruption = Some(areal_protocol::TurnInterruption::UserPause);
            }
            let queue = &mut candidate.desktop.as_mut().unwrap().queue;
            queue.paused = true;
            queue.pause_reason = Some("stopped".into());
            queue.revision += 1;
            if let Err(error) = self.persist(&candidate).await {
                if let Some(active) = &state.active {
                    active.cancel.cancel();
                }
                return Err(error);
            }
            state.thread = candidate;
            cell.emit(
                "areal/queue/updated",
                json!({"threadId":thread_id,"queue":state.thread.desktop.as_ref().unwrap().queue}),
            );
        }
        if let Some(active) = &state.active {
            if active.id != turn_id {
                return Err(Error::Conflict);
            }
            active.cancel.cancel();
        } else if !state.thread.turns.iter().any(|t| t.id == turn_id) {
            return Err(Error::Conflict);
        }
        Ok(())
    }

    pub async fn acknowledge_tool(
        self: &Arc<Self>,
        thread_id: String,
        item_id: String,
        inspection: String,
    ) -> Result<()> {
        if inspection.trim().is_empty() || inspection.len() > 1024 {
            return Err(Error::Invalid(
                "inspection must contain 1..1024 bytes describing the checked outcome".into(),
            ));
        }
        self.mutate(move |engine| async move {
            let cell = engine.raw_cell(&thread_id).await?;
            let mut state = cell.state.lock().await;
            if state
                .thread
                .desktop
                .as_ref()
                .is_some_and(|data| data.archived)
                && !state.thread.is_executable_side()
            {
                return Err(Error::Invalid("THREAD_ARCHIVED".into()));
            }
            if state.active.is_some() || state.compacting {
                return Err(Error::Conflict);
            }
            let mut candidate = if state.thread.is_executable_side()
                && state
                    .thread
                    .desktop
                    .as_ref()
                    .is_some_and(|data| data.archived)
            {
                engine
                    .store
                    .read_thread(&thread_id)
                    .await
                    .map_err(|error| Error::Storage(error.to_string()))?
            } else {
                state.thread.clone()
            };
            let item = candidate
                .turns
                .iter_mut()
                .flat_map(|turn| &mut turn.items)
                .find(|item| item.id() == item_id)
                .ok_or(Error::NotFound)?;
            match item {
                Item::DynamicToolCall { execution, .. }
                    if execution.outcome == areal_protocol::ToolOutcome::Unknown
                        || execution
                            .hooks
                            .iter()
                            .any(|hook| hook.outcome == areal_protocol::ToolOutcome::Unknown)
                        || execution.plugin.as_ref().is_some_and(|plugin| {
                            plugin.operations.iter().any(|operation| {
                                operation.outcome == areal_protocol::ToolOutcome::Unknown
                            })
                        }) =>
                {
                    execution.inspection = Some(inspection)
                }
                _ => {
                    return Err(Error::Invalid(
                        "only UNKNOWN tools can be acknowledged".into(),
                    ));
                }
            }
            engine.persist(&candidate).await?;
            state.thread = candidate;
            engine.finish_side_close(&cell, &mut state).await?;
            Ok(())
        })
        .await
    }

    async fn run(
        self: Arc<Self>,
        cell: Arc<Cell>,
        cancel: CancellationToken,
        mut steer: mpsc::Receiver<bool>,
        pending: Vec<TrustedPlugin>,
    ) {
        let prompt_span = info_span!(target: trajectory::TARGET, "areal.user_prompt",
            gen_ai.input.messages = tracing::field::Empty,
            areal.capture.truncated = tracing::field::Empty);
        let input = {
            let state = cell.state.lock().await;
            trajectory::capture_prompt(
                &prompt_span,
                state
                    .thread
                    .turns
                    .last()
                    .map_or(&[], |turn| turn.items.as_slice()),
            )
        };
        input.record(&prompt_span, "gen_ai.input.messages");
        prompt_span.in_scope(|| {
            tracing::event!(target: trajectory::TARGET, tracing::Level::INFO, { "event.name" = "areal.user_prompt" });
        });
        drop(prompt_span);
        // 普通 Turn 没有组合时限；仅保留显式研究 worker 和 Goal 预算。
        let worker_deadline = self
            .extensions
            .agents
            .as_ref()
            .filter(|_| cell.research)
            .map(|a| tokio::time::Instant::now() + Duration::from_secs(a.worker_timeout_seconds));
        let side_deadline = cell.state.lock().await.thread.is_read_only_side().then(|| {
            tokio::time::Instant::now() + Duration::from_secs(self.limits.max_side_turn_seconds)
        });
        let goal_budget = {
            let state = cell.state.lock().await;
            if state.thread.goal_owner.is_some()
                || state.thread.turns.last().is_some_and(|t| t.goal.is_some())
            {
                self.goals.budget(&state.thread)
            } else {
                None
            }
        };
        let goal_expired = async {
            match &goal_budget {
                Some(budget) => budget.wait_deadline().await,
                None => std::future::pending::<()>().await,
            }
        };
        let worker_expired = async {
            match worker_deadline {
                Some(deadline) => tokio::time::sleep_until(deadline).await,
                None => std::future::pending::<()>().await,
            }
        };
        let mut workspace_guard = None;
        let side_expired = async {
            match side_deadline {
                Some(deadline) => tokio::time::sleep_until(deadline).await,
                None => std::future::pending::<()>().await,
            }
        };
        let mut result = {
            let generation = std::panic::AssertUnwindSafe(async {
                if !pending.is_empty() {
                    let turn_id = cell.state.lock().await.active.as_ref().unwrap().id.clone();
                    self.prepare_turn_plugins(cell.clone(), turn_id, pending).await?;
                }
                anyhow::ensure!(!cancel.is_cancelled(), "cancelled before turn preparation completed");
                // 继承分析者的已冻结插件 hooks 可能在首个工具之前产生副作用，沿用整轮作者租约。
                let writer_hooks = {
                    let state = cell.state.lock().await;
                    state.thread.desktop.as_ref().is_some_and(|d| d.execution_policy.deferred_write || d.execution_policy.exclusive_write)
                        && state.active.as_ref().is_some_and(|active| !active.hooks.is_empty())
                };
                if writer_hooks {
                    let guard=tokio::select! {biased; _=cancel.cancelled()=>anyhow::bail!("cancelled before writer admission"), guard=self.workspace_gate.clone().write_owned()=>guard};
                    self.ensure_workspace_processes_settled().await?;
                    cell.state.lock().await.active.as_mut().unwrap().workspace_exclusive=true;
                    cell.state.lock().await.active.as_mut().unwrap().workspace_lease_pinned=true;
                    workspace_guard=Some(guard);
                }
                let (registry, direct) = {
                    let state = cell.state.lock().await;
                    let active = state.active.as_ref().unwrap();
                    (active.registry.clone().map_err(anyhow::Error::msg)?, active.direct_tool.clone())
                };
                cell.bindings.write().await.registry = registry;
                self.plugin_hooks_before_turn(&cell,&cancel).await?;
                if let Some(call) = direct {
                    self.tool(&cell, &cancel, call, usize::MAX).await.map(|_| ())
                } else {
                    self.generate(&cell, &cancel, &mut steer).await
                }
            }).catch_unwind();
            tokio::pin!(generation);
            let result = tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    // 不能先丢弃 generate，否则内部流收尾永远无法执行。
                    // 收尾仍受原 Goal/worker 截止时间约束，过时工具不会执行。
                    let started = tokio::time::Instant::now();
                    let deadline = worker_deadline.into_iter().chain(side_deadline).chain(goal_budget.as_ref().and_then(|b| b.deadline())).min();
                    let mut end = deadline.unwrap_or(started + Duration::from_secs(60));
                    loop {
                        // 重复取消不得延长期限；force 升级最多在 50ms 后缩短收尾。
                        let grace = Duration::from_millis(cell.cancel_grace_ms.load(Ordering::Acquire) as u64);
                        end = end.min(started + grace);
                        if tokio::time::Instant::now() >= end { break; }
                        tokio::select! {
                            _ = &mut generation => break,
                            _ = tokio::time::sleep_until(end.min(tokio::time::Instant::now() + Duration::from_millis(50))) => {}
                        }
                    }
                    Err(anyhow::anyhow!("cancelled"))
                },
                _ = goal_expired => Err(crate::outcome::TerminalFailure::new(
                    "GOAL_TIME_BUDGET",
                    crate::outcome::outcome("AGENT_RUN_TIMEOUT", "agent", "core_execution_budget", json!({"goalDeadlineReached":true})),
                ).into()),
                _ = worker_expired => Err(crate::outcome::TerminalFailure::new(
                    "research worker deadline exceeded",
                    crate::outcome::outcome("AGENT_RUN_TIMEOUT", "agent", "core_execution_budget", json!({"goalDeadlineReached":false})),
                ).into()),
                _ = side_expired => Err(crate::outcome::TerminalFailure::new(
                    "Side Turn deadline exceeded",
                    crate::outcome::outcome("AGENT_RUN_TIMEOUT", "agent", "core_side_budget", json!({"sideDeadlineReached":true})),
                ).into()),
                result = &mut generation =>
                    result.unwrap_or_else(|_| Err(anyhow::anyhow!("model task panicked"))),
            };
            // 在清理及账本刷新之前释放生成 future，包括内部计量 guard。
            result
        };
        if cancel.is_cancelled() && cell.state.lock().await.thread.parent_thread_id.is_none() {
            let _ = self
                .plugin_hook_event(
                    &cell,
                    areal_plugins::hooks::HookEvent::Interrupt,
                    json!({}),
                    &CancellationToken::new(),
                )
                .await;
        }
        // 关闭子任务准入并传播取消，再等待子树；整个过程不持有父会话锁。
        let (children, tools) = {
            let mut state = cell.state.lock().await;
            if cancel.is_cancelled() {
                result = Err(anyhow::anyhow!("cancelled"));
            }
            let children = state.active.as_ref().unwrap().children.clone();
            state.active.as_mut().unwrap().sealed = true;
            cancel.cancel();
            (children, state.active.as_ref().unwrap().tools.clone())
        };
        tools.close();
        tools.wait().await;
        let hook_tasks = cell
            .state
            .lock()
            .await
            .active
            .as_ref()
            .unwrap()
            .hook_tasks
            .clone();
        hook_tasks.close();
        hook_tasks.wait().await;
        let mut cleanup_failed = false;
        let mut dependency_failed = false;
        let active_id = cell.state.lock().await.active.as_ref().unwrap().id.clone();
        if let Err(error) = self.close_managed(&cell, Some(&active_id)).await {
            cleanup_failed = true;
            result = Err(anyhow::anyhow!("managed process cleanup failed: {error}"));
        }
        for service in [self.workgroups.get(), self.automatic_workgroups.get()]
            .into_iter()
            .flatten()
        {
            let owner = {
                let state = cell.state.lock().await;
                format!("{}/{}", state.thread.id, state.active.as_ref().unwrap().id)
            };
            match service.settle_owner(&owner, true).await {
                Ok(groups)
                    if groups
                        .iter()
                        .all(|g| g["record"]["cleanupConfirmed"] == true) =>
                {
                    dependency_failed |=
                        groups.iter().any(|g| g["record"]["status"] != "completed");
                }
                _ => {
                    cleanup_failed = true;
                    result = Err(anyhow::anyhow!("workgroup cleanup could not be confirmed"));
                }
            }
        }
        let scope = cell
            .state
            .lock()
            .await
            .active
            .as_ref()
            .unwrap()
            .scope
            .clone();
        if let (Some(runtime), Some(scope)) = (&self.runtime, scope)
            && let Err(error) = runtime.client.close_scope(&scope).await
        {
            cleanup_failed = true;
            result = Err(anyhow::anyhow!("Runtime scope cleanup failed: {error}"));
        }
        for child in children {
            match self.wait(&child).await {
                Ok(thread) if !matches!(thread.status, ThreadStatus::SystemError) => {
                    dependency_failed |= thread
                        .turns
                        .last()
                        .is_none_or(|t| t.status != TurnStatus::Completed);
                }
                _ => {
                    cleanup_failed = true;
                    result = Err(anyhow::anyhow!(
                        "child task cleanup or durable state could not be confirmed"
                    ));
                }
            }
        }
        let budget = {
            let state = cell.state.lock().await;
            if state.thread.turns.last().is_some_and(|t| t.goal.is_some())
                || state.thread.source == "nativeTaskAgent"
            {
                self.goals.budget(&state.thread)
            } else {
                None
            }
        };
        if let Some(budget) = &budget {
            budget.end();
            if let Err(error) = budget.flush().await {
                cleanup_failed = true;
                result = Err(anyhow::anyhow!("goal ledger persistence failed: {error}"));
            }
        }
        if cell
            .state
            .lock()
            .await
            .active
            .as_ref()
            .is_some_and(|active| active.cua_used)
        {
            let host = cell.bindings.read().await.host.clone();
            let cleanup = async {
                let host =
                    host.ok_or_else(|| anyhow::anyhow!("CUA host disappeared before cleanup"))?;
                host.end_cua_turn(json!({"threadId": cell.id, "turnId": active_id,
                    "hostGeneration": host.id(), "event": if result.is_err() { "Interrupt" } else { "Stop" }})).await
            };
            match tokio::time::timeout(Duration::from_secs(135), cleanup).await {
                Ok(Ok(())) => {}
                failure => {
                    cleanup_failed = true;
                    result = Err(anyhow::anyhow!(
                        "External CUA cleanup is unresolved: {failure:?}"
                    ));
                }
            }
        }
        let mut state = cell.state.lock().await;
        if dependency_failed
            && state.thread.goals.goal.as_ref().is_some_and(|g| {
                g.report_turn_id.as_deref() == Some(active_id.as_str())
                    && g.report.as_ref().is_some_and(|r| {
                        r.status == areal_protocol::goals::GoalReportStatus::Complete
                    })
            })
        {
            result = Err(anyhow::anyhow!(
                "GOAL_DEPENDENCY_FAILED: completion requires successful child tasks"
            ));
        }
        state.poisoned |= cleanup_failed;
        let thread_id = state.thread.id.clone();
        let open_items = std::mem::take(&mut state.active.as_mut().unwrap().open_items);
        let elapsed_ms = state
            .active
            .as_ref()
            .unwrap()
            .started
            .elapsed()
            .as_millis()
            .min(u64::MAX as u128) as u64;
        let generation = state
            .active
            .as_ref()
            .unwrap()
            .generation
            .lock()
            .unwrap()
            .clone();
        let turn = state.thread.turns.last_mut().unwrap();
        if generation.measured_requests + generation.unmeasured_requests > 0 {
            turn.generation = Some(generation);
        }
        for activity in &mut turn.trace.activities {
            if activity.status == "running" {
                activity.status = "unknown".into();
            }
        }
        turn.completed_at = Some(now());
        turn.duration_ms = Some(elapsed_ms);
        for item in &mut turn.items {
            if let Item::DynamicToolCall {
                execution,
                status,
                success,
                content_items,
                ..
            } = item
            {
                for hook in &mut execution.hooks {
                    if hook.outcome == areal_protocol::ToolOutcome::Running {
                        hook.outcome = areal_protocol::ToolOutcome::Unknown;
                    }
                }
                if execution.outcome == areal_protocol::ToolOutcome::Running {
                    execution.outcome = areal_protocol::ToolOutcome::Unknown;
                    *status = areal_protocol::ToolStatus::Failed;
                    *success = Some(false);
                    *content_items = Some(vec![
                        json!({"type":"inputText","text":"UNKNOWN: result was not durably confirmed; inspect before retrying"}),
                    ]);
                }
                if (execution.outcome == areal_protocol::ToolOutcome::Unknown
                    || execution
                        .hooks
                        .iter()
                        .any(|hook| hook.outcome == areal_protocol::ToolOutcome::Unknown))
                    && (result.is_ok() || result.as_ref().unwrap_err().to_string() == "cancelled")
                {
                    result = Err(anyhow::anyhow!(
                        "turn stopped with an UNKNOWN tool outcome; inspect the workspace before continuing"
                    ));
                }
            }
        }
        match result {
            Ok(()) => turn.status = TurnStatus::Completed,
            Err(error) if error.to_string() == "cancelled" => turn.status = TurnStatus::Interrupted,
            Err(error) => {
                turn.status = TurnStatus::Failed;
                turn.error = Some(crate::outcome::turn_error(&error));
            }
        }
        let status = match turn.status {
            TurnStatus::Completed => "completed",
            TurnStatus::Interrupted => "interrupted",
            TurnStatus::Failed => "failed",
            TurnStatus::InProgress => "in_progress",
        };
        tracing::Span::current().record("areal.turn.status", status);
        if turn.status != TurnStatus::Completed {
            tracing::Span::current().record("otel.status_code", "ERROR");
            tracing::Span::current().record("error.type", status);
        }
        tracing::info!(areal.turn.status = status, "agent turn settled");
        // 中断时仍提交已送达的文本前缀，不重放模型请求。
        for item in turn.items.iter().filter(|i| open_items.contains(i.id())) {
            emit_item(&cell, "item/completed", &thread_id, &turn.id, item);
        }
        let final_turn = state.thread.turns.last().unwrap().clone();
        if let Some(data) = &mut state.thread.desktop {
            if let Some(item) = data.queue.items.iter_mut().find(|item| {
                item.status == "running" && item.turn_id.as_deref() == Some(&final_turn.id)
            }) {
                item.status = match final_turn.status {
                    TurnStatus::Completed => "completed",
                    TurnStatus::Interrupted => "cancelled",
                    _ => "failed",
                }
                .into();
                data.queue.revision += 1;
            }
            if final_turn.status != TurnStatus::Completed
                && !data.queue.paused
                && final_turn.goal.is_none()
            {
                data.queue.paused = true;
                data.queue.pause_reason = Some("turn did not complete successfully".into());
                data.queue.revision += 1;
            }
        }
        let (input, agents) = self.task_wait_state(&state.thread).await;
        if let Some(goal) = &mut state.thread.goals.goal {
            goal.waiting_for_input = input;
            goal.waiting_for_agents = agents;
        }
        self.settle_goal(&mut state.thread);
        state.thread.updated_at = now();
        state.thread.status = if state.poisoned {
            ThreadStatus::SystemError
        } else {
            ThreadStatus::Idle
        };
        if let Err(error) = self.persist(&state.thread).await {
            state.poisoned = true;
            state.thread.status = ThreadStatus::SystemError;
            if let Some(goal) = &mut state.thread.goals.goal {
                goal.status = areal_protocol::goals::GoalStatus::Failed;
                goal.reason = Some("storageFailure".into());
            }
            let turn = state.thread.turns.last_mut().unwrap();
            turn.status = TurnStatus::Failed;
            turn.error = Some(crate::outcome::infrastructure(
                error.to_string(),
                "core_store",
                "persist_failed",
            ));
        }
        // 副作用与清理均已结束；必须先释放写租约，再发布资源已结算的观察结果。
        drop(workspace_guard);
        drop(
            state
                .active
                .as_mut()
                .unwrap()
                .deferred_workspace_guard
                .take(),
        );
        // 轨迹发送仅观察最终结算，不参与请求成败；时间来自执行记录而非上传时钟。
        if let Some(turn) = state.thread.turns.last() {
            let status = match turn.status {
                TurnStatus::Completed => "completed",
                TurnStatus::Interrupted => "interrupted",
                TurnStatus::Failed => "failed",
                TurnStatus::InProgress => "in_progress",
            };
            tracing::event!(target: trajectory::TARGET, tracing::Level::INFO, {
                "event.name" = "areal.turn.completed",
                areal.turn.status = status,
                areal.turn.started_at_ms = turn.started_at.map(|t| t.saturating_mul(1000)),
                areal.turn.completed_at_ms = turn.completed_at.map(|t| t.saturating_mul(1000)),
                areal.duration_ms = turn.duration_ms,
                gen_ai.usage.input_tokens = turn.usage.as_ref().map(|u|u.input_tokens),
                gen_ai.usage.output_tokens = turn.usage.as_ref().map(|u|u.output_tokens),
            });
        }
        let active = state.active.take().unwrap();
        let name_model = active.model.clone();
        prompt_prediction::capture(
            &mut state,
            active.model.clone(),
            self.shutdown.child_token(),
        );
        let name_turn = state
            .thread
            .turns
            .last()
            .filter(|turn| turn.status == TurnStatus::Completed && !state.poisoned)
            .cloned();
        if state.poisoned {
            state.quarantined_admission = Some(active._admission);
        } else {
            drop(active);
        }
        if let Some(data) = &state.thread.desktop {
            cell.emit(
                "areal/queue/updated",
                json!({"threadId":thread_id,"queue":data.queue}),
            );
        }
        cell.emit(
            "turn/completed",
            json!({"threadId": thread_id, "turn": state.thread.turns.last()}),
        );
        self.goal_emit(&cell, &state.thread);
        cell.settled.send_replace(true);
        drop(state);
        // 队列推进仍调用同一 Turn 准入与 activate，先持久化唯一的 item→Turn 关联。
        self.goals.request(&cell.id);
        self.goals.wake();
        self.wake_tasks();
        if let Some(turn) = name_turn {
            self.schedule_session_name(cell.clone(), turn, name_model);
        }
    }
}
