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
        let _admission = self.tasks.token();
        let _gate = self.desktop.lifecycle.gate.lock().await;
        let cell = self.cell(thread_id).await?;
        let mut state = cell.state.lock().await;
        if !self.accepting_work() || cancel.is_cancelled() {
            return Err(Error::Closed);
        }
        if state.active.is_some() || state.compacting {
            return Err(Error::Conflict);
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
        self.validate_uploads(thread, &input)?;
        let configuration = self.freeze_configuration(
            thread
                .desktop
                .as_ref()
                .map(|d| d.configuration.clone())
                .unwrap_or_default(),
        );
        validate_input(
            &input,
            &self.configured_model(&configuration)?.capabilities(),
        )?;
        let mut candidate = thread.clone();
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
            goal: None,
            instruction_snapshot: None,
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
        if serde_json::to_vec(&candidate).unwrap().len() + self.limits.max_output_bytes * 6 + 1024
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
        self.spawn_goal_scheduler();
        self.start_task_scheduler();
        let (tx, rx) = mpsc::channel(self.limits.mailbox_capacity);
        let mut model = self
            .configured_model(&turn.configuration.clone().unwrap_or_default())
            .expect("configuration validated before admission");
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
        state.active = Some(Active {
            isolated_children: 0,
            _admission: admission,
            id: turn.id.clone(),
            cancel: cancel.clone(),
            steer: tx,
            children: Vec::new(),
            model_children: Vec::new(),
            open_items: HashSet::new(),
            sealed: false,
            scope: None,
            model,
            tools: TaskTracker::new(),
            process_cursors: BTreeMap::new(),
            handles: tools::Handles::default(),
            started_at: tokio::time::Instant::now(),
        });
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
            areal.turn.number = state.thread.turns.len() as u64,
            otel.name = "invoke_agent",
            gen_ai.operation.name = "invoke_agent",
            gen_ai.conversation.id = %session_id,
            areal.thread.id = %thread_id,
            areal.parent_thread.id = %parent_thread_id,
            areal.turn.id = %turn.id,
            areal.turn.status = tracing::field::Empty,
        );
        self.tasks
            .spawn(async move { engine.run(run_cell, cancel, rx).await }.instrument(span));
    }

    pub async fn steer(
        self: &Arc<Self>,
        thread_id: &str,
        turn_id: &str,
        input: Vec<Input>,
    ) -> Result<()> {
        let thread_id = thread_id.to_owned();
        let turn_id = turn_id.to_owned();
        self.mutate(
            move |engine| async move { engine.steer_inner(&thread_id, &turn_id, input).await },
        )
        .await
    }

    async fn steer_inner(&self, thread_id: &str, turn_id: &str, input: Vec<Input>) -> Result<()> {
        let cell = self.cell(thread_id).await?;
        let mut state = cell.state.lock().await;
        let active = state
            .active
            .as_ref()
            .filter(|a| a.id == turn_id && !a.cancel.is_cancelled() && !a.sealed)
            .ok_or(Error::Conflict)?;
        validate_input(&input, &active.model.capabilities())?;
        self.validate_uploads(&state.thread, &input)?;
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
        if serde_json::to_vec(&candidate).unwrap().len() + self.limits.max_output_bytes * 6 + 1024
            > self.limits.max_history_bytes
        {
            return Err(Error::Exhausted("session history limit reached".into()));
        }
        self.persist(&candidate).await?;
        state.thread = candidate;
        emit_item(&cell, "item/started", thread_id, turn_id, &item);
        emit_item(&cell, "item/completed", thread_id, turn_id, &item);
        self.goal_emit(&cell, &state.thread);
        permit.send(());
        Ok(())
    }

    pub async fn interrupt(&self, thread_id: &str, turn_id: &str) -> Result<()> {
        let cell = self.cell(thread_id).await?;
        let mut state = cell.state.lock().await;
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
            let queue = &mut candidate.desktop.as_mut().unwrap().queue;
            queue.paused = true;
            queue.pause_reason = Some("stopped".into());
            queue.revision += 1;
            self.persist(&candidate).await?;
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
            let cell = engine.cell(&thread_id).await?;
            let mut state = cell.state.lock().await;
            if state.active.is_some() || state.compacting {
                return Err(Error::Conflict);
            }
            let mut candidate = state.thread.clone();
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
                            .any(|hook| hook.outcome == areal_protocol::ToolOutcome::Unknown) =>
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
            Ok(())
        })
        .await
    }

    async fn run(
        self: Arc<Self>,
        cell: Arc<Cell>,
        cancel: CancellationToken,
        mut steer: mpsc::Receiver<()>,
    ) {
        let input = {
            let state = cell.state.lock().await;
            state
                .thread
                .turns
                .last()
                .map(|turn| {
                    turn.items
                        .iter()
                        .filter_map(|item| {
                            if let Item::UserMessage { content, .. } = item {
                                let mut message = model::Message::text("user", "");
                                message.content =
                                    content.iter().map(model::content_from_input).collect();
                                Some(message)
                            } else {
                                None
                            }
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        };
        tracing::event!(target: trajectory::TARGET, tracing::Level::INFO, {
            "event.name" = "areal.user_prompt",
            gen_ai.input.messages = %trajectory::messages(&input)
        });
        let timeout = self
            .extensions
            .agents
            .as_ref()
            .filter(|_| cell.research)
            .map_or(self.limits.turn_timeout, |a| {
                self.limits
                    .turn_timeout
                    .min(Duration::from_secs(a.worker_timeout_seconds))
            });
        let (goal, owner) = {
            let state = cell.state.lock().await;
            (
                state.thread.goals.goal.clone().filter(|g| {
                    state
                        .thread
                        .turns
                        .last()
                        .and_then(|t| t.goal.as_ref())
                        .is_some_and(|t| t.goal_id == g.id)
                }),
                state.thread.goal_owner.clone(),
            )
        };
        let goal = if goal.is_none() {
            if let Some(owner) = owner {
                self.goal_get(&owner.thread_id)
                    .await
                    .ok()
                    .and_then(|v| {
                        serde_json::from_value::<areal_protocol::goals::Goal>(v["goal"].clone())
                            .ok()
                    })
                    .filter(|g| g.id == owner.goal_id)
            } else {
                None
            }
        } else {
            goal
        };
        let goal_seconds = goal
            .as_ref()
            .map(|g| (g.max_active_seconds as f64 - g.usage.time_used_seconds).max(0.0));
        let goal_deadline =
            goal_seconds.map(|v| tokio::time::Instant::now() + Duration::from_secs_f64(v));
        let deadline = (tokio::time::Instant::now() + timeout)
            .min(goal_deadline.unwrap_or(tokio::time::Instant::now() + timeout));
        let mut result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(anyhow::anyhow!("cancelled")),
            _ = tokio::time::sleep_until(deadline) => Err(crate::outcome::TerminalFailure::new(
                if goal_deadline.is_some_and(|g| g <= tokio::time::Instant::now()) {"GOAL_TIME_BUDGET"} else {"turn deadline exceeded"},
                crate::outcome::outcome("AGENT_RUN_TIMEOUT", "agent", "core_turn_deadline", json!({"goalDeadlineReached":goal_deadline.is_some_and(|g| g <= tokio::time::Instant::now())})),
            ).into()),
            result = std::panic::AssertUnwindSafe(self.generate(&cell, &cancel, &mut steer)).catch_unwind() =>
                result.unwrap_or_else(|_| Err(anyhow::anyhow!("model task panicked"))),
        };
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
        let mut cleanup_failed = false;
        let mut dependency_failed = false;
        let active_id = cell.state.lock().await.active.as_ref().unwrap().id.clone();
        if let Err(error) = self.close_managed(&cell, Some(&active_id)).await {
            cleanup_failed = true;
            result = Err(anyhow::anyhow!("managed process cleanup failed: {error}"));
        }
        if let Some(service) = self.workgroups.get() {
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
        let turn = state.thread.turns.last_mut().unwrap();
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
            if let Some(item) = data
                .queue
                .items
                .iter_mut()
                .find(|item| item.turn_id.as_deref() == Some(&final_turn.id))
            {
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
        let active = state.active.take().unwrap();
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
    }
}
