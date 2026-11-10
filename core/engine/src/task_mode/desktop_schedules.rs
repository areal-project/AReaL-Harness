//! 桌面安排复用 Task 账本；Host 只提供配置，不拥有触发时间或执行身份。
use super::*;
use areal_protocol::desktop::ThreadStart;

impl Engine {
    pub async fn register_schedule_tools(
        &self,
        request: TaskToolsReady,
        host: Arc<dyn tools::DynamicToolHost>,
    ) -> Result<()> {
        if host.is_closed() {
            return Err(Error::Closed);
        }
        let mut definitions = Vec::new();
        for bundle in request.bundles {
            let definition = match bundle {
                DesktopToolBundle::Browser => areal_protocol::desktop::browser_v1_tool(),
                DesktopToolBundle::Computer => areal_protocol::desktop::computer_v1_tool(),
            };
            if definitions
                .iter()
                .any(|tool: &areal_protocol::ToolDefinition| tool.name == definition.name)
            {
                return Err(invalid("duplicate desktop tool bundle"));
            }
            definitions.push(definition);
        }
        let mut providers = self.task_modes.desktop_tools.lock().await;
        if definitions.is_empty() {
            if providers
                .get(host.identity())
                .is_some_and(|old| old.host.id() == host.id())
            {
                providers.remove(host.identity());
            }
            return Ok(());
        }
        if providers
            .get(host.identity())
            .is_some_and(|old| old.host.id() != host.id() && !old.host.is_closed())
        {
            return Err(Error::Conflict);
        }
        providers.insert(
            host.identity().into(),
            DesktopScheduleTools { host, definitions },
        );
        Ok(())
    }

    pub(super) async fn schedule_tools(&self, owner: &str) -> Option<DesktopScheduleTools> {
        self.task_modes
            .desktop_tools
            .lock()
            .await
            .get(owner)
            .filter(|provider| !provider.host.is_closed())
            .cloned()
    }

    pub async fn register_schedule_host(
        self: &Arc<Self>,
        host: Arc<dyn tools::DynamicToolHost>,
    ) -> Result<()> {
        self.register_schedule_host_capabilities(host, false).await
    }

    pub async fn register_schedule_host_capabilities(
        self: &Arc<Self>,
        host: Arc<dyn tools::DynamicToolHost>,
        prepare_create: bool,
    ) -> Result<()> {
        if host.is_closed() {
            return Err(Error::Closed);
        }
        let mut hosts = self.task_modes.hosts.lock().await;
        if hosts
            .get(host.identity())
            .is_some_and(|old| old.host.id() != host.id() && !old.host.is_closed())
        {
            return Err(Error::Conflict);
        }
        hosts.insert(
            host.identity().into(),
            ScheduleHost {
                host,
                prepare_create,
            },
        );
        drop(hosts);
        self.start_task_scheduler();
        self.wake_tasks();
        Ok(())
    }

    pub(super) async fn schedule_host(
        &self,
        owner: &str,
    ) -> Option<Arc<dyn tools::DynamicToolHost>> {
        self.task_modes
            .hosts
            .lock()
            .await
            .get(owner)
            .filter(|h| !h.host.is_closed())
            .map(|h| h.host.clone())
    }

    pub(super) async fn schedule_create_host(
        &self,
        owner: &str,
    ) -> Option<Arc<dyn tools::DynamicToolHost>> {
        self.task_modes
            .hosts
            .lock()
            .await
            .get(owner)
            .filter(|h| h.prepare_create && !h.host.is_closed())
            .map(|h| h.host.clone())
    }

    pub async fn host_update_status(
        &self,
        owner: &str,
    ) -> Option<areal_protocol::desktop::HostUpdateStatus> {
        let host = self.schedule_host(owner).await?;
        if !self.host_current(&host).await {
            return None;
        }
        let status = host
            .host_status(tokio_util::sync::CancellationToken::new())
            .await
            .ok()
            .flatten();
        if !self.host_current(&host).await {
            return None;
        }
        status
    }

    pub(super) async fn host_current(&self, host: &Arc<dyn tools::DynamicToolHost>) -> bool {
        !host.is_closed()
            && self
                .schedule_host(host.identity())
                .await
                .is_some_and(|h| h.id() == host.id())
    }

    pub(crate) async fn is_desktop_schedule_goal(&self, goal_id: &str) -> Result<bool> {
        let state = self.task_modes.state.lock().await;
        if state.tasks.values().any(|t| {
            t.mode == TaskMode::Scheduled
                && t.runs.iter().any(|r| r.goal_id.as_deref() == Some(goal_id))
        }) {
            return Ok(true);
        }
        Ok(state
            .cold_run(Some(goal_id), None)?
            .is_some_and(|(id, _)| state.tasks[&id].mode == TaskMode::Scheduled))
    }

    /// 先结算旧执行，再决定触发。未开始的离线时间合并一次；忙碌时间直接跳过。
    pub(super) async fn advance_desktop_schedule(self: &Arc<Self>, task_id: &str) -> Result<()> {
        let task = self.task_read(task_id).await?;
        self.settle_task_workers(&task).await?;
        let task = self.task_read(task_id).await?;
        if let Some(run) = task.runs.last().filter(|r| !r.status.terminal()) {
            if let (Some(thread_id), Some(goal_id)) = (&run.thread_id, &run.goal_id) {
                let view = self.goal_get(thread_id).await?;
                if view["goal"]["id"].as_str() != Some(goal_id) {
                    self.edit_task(task_id, |t| {
                        let r = t.runs.last_mut().unwrap();
                        // 定时运行没有可恢复的 Goal 时直接结算，否则后续触发会永久视为重叠。
                        r.status = if t.cancelled || r.reason.as_deref() == Some("stopRequested") {
                            RunStatus::Cancelled
                        } else {
                            RunStatus::Failed
                        };
                        r.completed_at = Some(now());
                        r.reason = Some("goalMissingOrReplaced".into());
                    })
                    .await?;
                    return Ok(());
                }
                let goal: Goal = serde_json::from_value(view["goal"].clone()).map_err(invalid)?;
                let stop = task.cancelled || run.reason.as_deref() == Some("stopRequested");
                let cell = self.cell(thread_id).await?;
                let bound = cell.bindings.read().await.schedule_host.clone();
                let online = bound.as_ref().is_some_and(|h| !h.is_closed());
                if goal.status == GoalStatus::Active && (stop || !online) {
                    if !stop {
                        self.edit_task(task_id, |t| {
                            let r = t.runs.last_mut().unwrap();
                            if !t.cancelled && r.reason.as_deref() != Some("stopRequested") {
                                r.reason = Some("hostUnavailable".into());
                            }
                        })
                        .await?;
                    }
                    let current = self.task_read(task_id).await?;
                    self.control_goal_from_task(
                        &current,
                        current.runs.last().unwrap(),
                        "pause",
                        &view,
                    )
                    .await?;
                    return Ok(());
                }
                if run.reason.as_deref() == Some("resumeRequested")
                    && !task.cancelled
                    && self.accepting_work()
                    && goal.active_turn_id.is_none()
                    && !goal.settling
                    && run.workers.iter().all(|w| w.settled)
                    && matches!(goal.status, GoalStatus::Paused | GoalStatus::Blocked)
                {
                    let Some(host) = self.schedule_host(&task.owner).await else {
                        return Ok(());
                    };
                    host.prepare_schedule(json!({"taskId":task.id,"runId":run.id,"threadId":thread_id,"scheduledAt":run.scheduled_at,"intent":"resume"}), self.shutdown.child_token()).await.map_err(invalid)?;
                    if !self.host_current(&host).await {
                        return Ok(());
                    }
                    let provider = self.schedule_tools(&task.owner).await;
                    {
                        let state = cell.state.lock().await;
                        if state.active.is_some() {
                            return Ok(());
                        }
                        let mut bindings = cell.bindings.write().await;
                        if bindings
                            .schedule_host
                            .as_ref()
                            .is_some_and(|old| !old.is_closed() && old.id() != host.id())
                        {
                            return Err(Error::Conflict);
                        }
                        bindings.schedule_host = Some(host);
                        if bindings.host.as_ref().is_none_or(|old| old.is_closed()) {
                            bindings.host = provider.and_then(|provider| {
                                provider.for_tools(&state.thread.dynamic_tools)
                            });
                        }
                    }
                    self.control_goal_from_task(&task, run, "resume", &view)
                        .await?;
                    self.edit_task(task_id, |t| {
                        let r = t.runs.last_mut().unwrap();
                        if r.reason.as_deref() == Some("resumeRequested") {
                            r.reason = None;
                            r.status = RunStatus::Running;
                        }
                    })
                    .await?;
                    return Ok(());
                }
                let expected_revision = task.revision;
                let pending = cell
                    .state
                    .lock()
                    .await
                    .thread
                    .desktop
                    .as_ref()
                    .is_some_and(|d| d.interactions.iter().any(|i| i.status == "pending"));
                self.edit_task(task_id, |t| {
                    if t.revision != expected_revision {
                        return;
                    }
                    let r = t.runs.last_mut().unwrap();
                    r.usage = goal.usage.clone();
                    if goal.active_turn_id.is_some()
                        || goal.settling
                        || (goal.status != GoalStatus::Active
                            && r.workers.iter().any(|w| !w.settled))
                    {
                        if pending {
                            r.status = RunStatus::WaitingForInput;
                        }
                        return;
                    }
                    r.status = if stop {
                        RunStatus::Cancelled
                    } else {
                        match goal.status {
                            GoalStatus::Active
                                if r.wait_requested && r.workers.iter().any(|w| !w.settled) =>
                            {
                                RunStatus::WaitingForAgents
                            }
                            GoalStatus::Active if r.wait_requested => RunStatus::WaitingForInput,
                            GoalStatus::Active => RunStatus::Running,
                            GoalStatus::Paused => RunStatus::Paused,
                            GoalStatus::Blocked | GoalStatus::BudgetLimited => RunStatus::Blocked,
                            GoalStatus::Completed => RunStatus::Completed,
                            GoalStatus::Failed => RunStatus::Failed,
                        }
                    };
                    if !matches!(
                        r.reason.as_deref(),
                        Some(
                            "resumeRequested"
                                | "stopRequested"
                                | "hostUnavailable"
                                | "serverRestarted"
                        )
                    ) {
                        r.reason = goal.reason.clone();
                    }
                    // 中断保留原 Run 的显式恢复机会；后续到期触发才结算已停住的旧 Run。
                    if r.status.terminal() && r.completed_at.is_none() {
                        r.completed_at = Some(now());
                        for m in &mut t.messages {
                            if m.run_id == r.id && m.status == "pending" {
                                m.status = "cancelled".into();
                                t.channel_sequence += 1;
                                m.sequence = t.channel_sequence;
                            }
                        }
                        {
                            t.channel_sequence += 1;
                            t.messages.push(ChannelMessage {
                                id: id(),
                                sequence: t.channel_sequence,
                                run_id: r.id.clone(),
                                author: "core".into(),
                                kind: "report".into(),
                                status: "published".into(),
                                created_at: now(),
                                expires_at: None,
                                questions: vec![],
                                required: false,
                                in_reply_to: None,
                                answers: None,
                                text: goal
                                    .report
                                    .as_ref()
                                    .map(|r| r.summary.clone())
                                    .unwrap_or_else(|| format!("{:?}", r.status)),
                            });
                        }
                    }
                })
                .await?;
                if goal.status == GoalStatus::Active
                    && goal.active_turn_id.is_none()
                    && online
                    && !stop
                    && !run.wait_requested
                {
                    self.goals.request(thread_id);
                }
                // 接在普通对话里的运行结束后清掉目标，对话回到普通状态；暂停/受阻的保留以便恢复。
                if task.delivery == TaskDelivery::Thread
                    && matches!(goal.status, GoalStatus::Completed | GoalStatus::Failed)
                    && goal.active_turn_id.is_none()
                    && !goal.settling
                    && run.workers.iter().all(|w| w.settled)
                    && self
                        .task_read(task_id)
                        .await?
                        .runs
                        .iter()
                        .any(|r| r.id == run.id && r.status.terminal())
                {
                    match self
                        .goal_control(
                            task.owner.clone(),
                            "clear".into(),
                            GoalControl {
                                request_id: format!("task-settled-{}", run.id),
                                thread_id: thread_id.clone(),
                                goal_id: goal_id.clone(),
                                expected_revision: view["revision"]
                                    .as_u64()
                                    .ok_or(Error::Conflict)?,
                            },
                            None,
                        )
                        .await
                    {
                        Ok(_) | Err(Error::Conflict) => {}
                        Err(error) => return Err(error),
                    }
                }
            } else if task.cancelled || run.reason.as_deref() == Some("stopRequested") {
                self.edit_task(task_id, |t| {
                    let r = t.runs.last_mut().unwrap();
                    r.status = RunStatus::Cancelled;
                    r.completed_at = Some(now());
                })
                .await?;
            }
        }
        let task = self.task_read(task_id).await?;
        let host = self.schedule_host(&task.owner).await;
        {
            // A trigger and ifIdle drain share admission: either the queued Run is
            // visible to the safety check or drain prevents its creation.
            let _admission = self.desktop.lifecycle.gate.lock().await;
            if self.accepting_work() {
                self.admit_schedule_due(task_id, host.is_some(), self.schedule_now())
                    .await?;
            }
        }
        let task = self.task_read(task_id).await?;
        let Some(run) = task
            .runs
            .last()
            .filter(|r| r.status == RunStatus::Queued && r.goal_id.is_none())
            .cloned()
        else {
            return Ok(());
        };
        if task.cancelled || !self.accepting_work() {
            return Ok(());
        }
        let Some(host) = host else {
            return Ok(());
        };
        if task.delivery == TaskDelivery::Thread {
            return self.start_bound_schedule_run(&task, &run, host).await;
        }
        let provider = self.schedule_tools(&task.owner).await;
        let prepared = self
            .task_modes
            .state
            .lock()
            .await
            .preparations
            .get(&run.id)
            .cloned();
        let request = if let Some(p) = prepared {
            p
        } else {
            let anchor = self
                .read(task.thread_id.as_ref().ok_or(Error::Conflict)?, false)
                .await?;
            let response=host.prepare_schedule(json!({"taskId":task.id,"runId":run.id,"threadId":anchor.id,"scheduledAt":run.scheduled_at,"intent":"start"}),self.shutdown.child_token()).await;
            let mut value = match response {
                Ok(value) => value,
                Err(_) if !self.host_current(&host).await => return Ok(()),
                Err(error) => return Err(invalid(error)),
            };
            if !self.host_current(&host).await {
                return Ok(());
            }
            let object = value
                .as_object_mut()
                .ok_or_else(|| invalid("schedule preparation requires an object"))?;
            object.insert(
                "requestId".into(),
                json!(format!("schedule-thread-{}", run.id)),
            );
            object.insert("cwd".into(), json!(anchor.cwd));
            object.insert("admissionGuard".into(), json!({"ordinarySession":true}));
            let mut p: ThreadStart = serde_json::from_value(value).map_err(invalid)?;
            if let Some(model) = &task.model {
                p.model = Some(model.clone());
                p.parameters = task.parameters.clone().unwrap_or_default();
            }
            p.dynamic_tools = provider
                .as_ref()
                .map(|provider| provider.definitions.clone())
                .unwrap_or_default();
            let mut state = self.task_modes.state.lock().await;
            let mut candidate = state.clone();
            let current = candidate.tasks.get(task_id).ok_or(Error::NotFound)?;
            if current.cancelled
                || current
                    .runs
                    .last()
                    .is_none_or(|r| r.id != run.id || r.reason.as_deref() == Some("stopRequested"))
            {
                return Ok(());
            }
            candidate.preparations.insert(run.id.clone(), p.clone());
            self.save_tasks(&mut state, candidate, task_id, true)
                .await?;
            p
        };
        if !self.host_current(&host).await {
            return Ok(());
        }
        let tool_host = provider.and_then(|provider| provider.for_tools(&request.dynamic_tools));
        let thread = if let Some(thread) = &run.thread_id {
            self.read(thread, false).await?
        } else {
            self.create_configured(
                task.owner.clone(),
                request,
                tool_host.clone().unwrap_or_else(|| host.clone()),
            )
            .await?
        };
        self.edit_task(task_id, |t| {
            let r = t.runs.last_mut().unwrap();
            if r.id == run.id && r.thread_id.is_none() {
                r.thread_id = Some(thread.id.clone());
            }
        })
        .await?;
        if !self.host_current(&host).await {
            return Ok(());
        }
        // 重启前已准备但尚未启动的同一 Run 可重绑；已有 Goal 的恢复必须走显式 resumeRun。
        {
            let cell = self.cell(&thread.id).await?;
            let state = cell.state.lock().await;
            if state.active.is_some() {
                return Ok(());
            }
            let mut bindings = cell.bindings.write().await;
            if bindings
                .schedule_host
                .as_ref()
                .is_some_and(|h| !h.is_closed() && h.id() != host.id())
            {
                return Err(Error::Conflict);
            }
            bindings.schedule_host = Some(host);
            if bindings.host.as_ref().is_none_or(|old| {
                old.is_closed() || old.id() == bindings.schedule_host.as_ref().unwrap().id()
            }) {
                bindings.host = tool_host;
            }
        }
        {
            let cell = self.cell(&thread.id).await?;
            let mut state = cell.state.lock().await;
            if state.thread.goals.goal.is_none() {
                let mut candidate = state.thread.clone();
                if let Some(data) = candidate.desktop.as_mut() {
                    data.configuration = self.freeze_configuration(data.configuration.clone());
                }
                self.persist(&candidate).await?;
                state.thread = candidate;
            }
        }
        let current = self.task_read(task_id).await?;
        if current
            .runs
            .last()
            .is_none_or(|r| r.id != run.id || r.reason.as_deref() == Some("stopRequested"))
            || current.cancelled
        {
            return Ok(());
        }
        let view = self.goal_get(&thread.id).await?;
        if !view["goal"].is_null() {
            return Ok(());
        }
        let usage = self.task_modes.state.lock().await.usage(task_id);
        let used = usage.tokens_used.saturating_add(usage.reserved_tokens);
        let budget = task.token_budget.map(|n| n.saturating_sub(used));
        if budget == Some(0) {
            return Err(invalid("task token budget exhausted"));
        }
        match self
            .goal_create(
                task.owner.clone(),
                GoalCreate {
                    model_override: None,
                    infer_limits: false,
                    request_id: format!("task-run-{}", run.id),
                    thread_id: thread.id,
                    expected_revision: view["revision"].as_u64().ok_or(Error::Conflict)?,
                    objective: run.objective.clone().unwrap_or(task.objective),
                    token_budget: budget,
                    max_turns: task.max_turns,
                    max_active_seconds: task.max_active_seconds,
                    interaction_mode: Some(InteractionMode::Interactive),
                },
            )
            .await
        {
            Ok(_) | Err(Error::Conflict) => Ok(()),
            Err(Error::Exhausted(ref reason)) if reason.starts_with("active Turn capacity") => {
                Ok(())
            }
            Err(error) => Err(error),
        }
    }
}

impl Engine {
    /// 定时任务固定模型：取对话当前所选模型，未选时取服务当前默认模型。
    pub(super) fn fixed_schedule_model(
        &self,
        configuration: &areal_protocol::desktop::EffectiveConfig,
    ) -> (
        Option<areal_protocol::desktop::ModelRef>,
        Option<areal_protocol::desktop::ModelParameters>,
    ) {
        let model = configuration
            .model
            .clone()
            .or_else(|| self.configured_default_model());
        let parameters = model
            .as_ref()
            .map(|_| areal_protocol::desktop::ModelParameters {
                reasoning_effort: configuration.parameters.reasoning_effort.clone(),
                service_tier: configuration.parameters.service_tier.clone(),
                ..Default::default()
            });
        (model, parameters)
    }

    /// 绑定对话的运行：对话空闲时作为一个 Goal 接在对话末尾；忙碌时保持 queued 等下一次唤醒。
    async fn start_bound_schedule_run(
        self: &Arc<Self>,
        task: &Task,
        run: &TaskRun,
        host: Arc<dyn tools::DynamicToolHost>,
    ) -> Result<()> {
        let Some(thread_id) = bound_thread(task) else {
            return Err(Error::Conflict);
        };
        let settle = |reason: &'static str| {
            let run_id = run.id.clone();
            move |t: &mut Task| {
                let r = t.runs.last_mut().unwrap();
                if r.id == run_id && !r.status.terminal() {
                    r.status = RunStatus::Failed;
                    r.reason = Some(reason.into());
                    r.completed_at = Some(now());
                }
            }
        };
        let cell = match self.cell(&thread_id).await {
            Ok(cell) => cell,
            Err(Error::NotFound) => {
                return self.edit_task(&task.id, settle("threadMissing")).await;
            }
            Err(error) => return Err(error),
        };
        {
            let state = cell.state.lock().await;
            if state.thread.desktop.as_ref().is_some_and(|d| d.archived) {
                drop(state);
                return self.edit_task(&task.id, settle("threadArchived")).await;
            }
            if bound_thread_busy(&state) {
                return Ok(());
            }
        }
        let mut view = self.goal_get(&thread_id).await?;
        if let Some(goal_id) = view["goal"]["id"].as_str().map(str::to_owned) {
            let status = view["goal"]["status"].as_str().unwrap_or_default();
            let ours = task
                .runs
                .iter()
                .any(|r| r.goal_id.as_deref() == Some(goal_id.as_str()));
            // 用户自己的未结束目标优先；只清理本任务的旧目标或已结束的目标。
            if status == "active" || (!ours && !matches!(status, "completed" | "failed")) {
                return Ok(());
            }
            self.goal_control(
                task.owner.clone(),
                "clear".into(),
                GoalControl {
                    request_id: format!("task-clear-{}", run.id),
                    thread_id: thread_id.clone(),
                    goal_id,
                    expected_revision: view["revision"].as_u64().ok_or(Error::Conflict)?,
                },
                None,
            )
            .await?;
            view = self.goal_get(&thread_id).await?;
        }
        if !self.host_current(&host).await {
            return Ok(());
        }
        let provider = self.schedule_tools(&task.owner).await;
        {
            let state = cell.state.lock().await;
            if bound_thread_busy(&state) {
                return Ok(());
            }
            let mut bindings = cell.bindings.write().await;
            if bindings
                .schedule_host
                .as_ref()
                .is_some_and(|h| !h.is_closed() && h.id() != host.id())
            {
                return Err(Error::Conflict);
            }
            bindings.schedule_host = Some(host);
            if bindings.host.as_ref().is_none_or(|old| old.is_closed()) {
                bindings.host =
                    provider.and_then(|provider| provider.for_tools(&state.thread.dynamic_tools));
            }
        }
        self.edit_task(&task.id, |t| {
            let r = t.runs.last_mut().unwrap();
            if r.id == run.id && r.thread_id.is_none() {
                r.thread_id = Some(thread_id.clone());
            }
        })
        .await?;
        let current = self.task_read(&task.id).await?;
        if current.cancelled
            || current
                .runs
                .last()
                .is_none_or(|r| r.id != run.id || r.reason.as_deref() == Some("stopRequested"))
        {
            return Ok(());
        }
        let usage = self.task_modes.state.lock().await.usage(&task.id);
        let used = usage.tokens_used.saturating_add(usage.reserved_tokens);
        let budget = task.token_budget.map(|n| n.saturating_sub(used));
        if budget == Some(0) {
            return Err(invalid("task token budget exhausted"));
        }
        match self
            .goal_create(
                task.owner.clone(),
                GoalCreate {
                    model_override: task.model.clone().map(|model| GoalModel {
                        model,
                        parameters: task.parameters.clone().unwrap_or_default(),
                    }),
                    infer_limits: false,
                    request_id: format!("task-run-{}", run.id),
                    thread_id,
                    expected_revision: view["revision"].as_u64().ok_or(Error::Conflict)?,
                    objective: run.objective.clone().unwrap_or(task.objective.clone()),
                    token_budget: budget,
                    max_turns: task.max_turns,
                    max_active_seconds: task.max_active_seconds,
                    interaction_mode: Some(InteractionMode::Interactive),
                },
            )
            .await
        {
            Ok(_) | Err(Error::Conflict) => Ok(()),
            Err(Error::Exhausted(ref reason)) if reason.starts_with("active Turn capacity") => {
                Ok(())
            }
            Err(error) => Err(error),
        }
    }

    /// 归档绑定对话时暂停接在它上面的任务；恢复归档不自动开启，由用户在定时页决定。
    pub(crate) async fn pause_tasks_bound_to(self: &Arc<Self>, thread_id: &str) -> Result<()> {
        let bound: Vec<(String, u64, String)> = {
            let state = self.task_modes.state.lock().await;
            state
                .tasks
                .values()
                .filter(|t| {
                    t.mode == TaskMode::Scheduled
                        && t.delivery == TaskDelivery::Thread
                        && !t.paused
                        && !t.cancelled
                        && t.deleted_at.is_none()
                        && bound_thread(t).as_deref() == Some(thread_id)
                })
                .map(|t| (t.id.clone(), t.revision, t.owner.clone()))
                .collect()
        };
        for (task_id, revision, owner) in bound {
            match self
                .task_control(
                    owner,
                    "pause".into(),
                    TaskControl {
                        expected_run_id: None,
                        request_id: format!("archive-pause-{thread_id}-{task_id}-{revision}"),
                        task_id,
                        expected_revision: revision,
                    },
                )
                .await
            {
                Ok(_) | Err(Error::Conflict) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
}

/// 接收运行的对话：对话里建的任务是来源对话，定时页建的任务是它的专属对话。
pub(crate) fn bound_thread(task: &Task) -> Option<String> {
    task.source_thread_id
        .clone()
        .or_else(|| task.thread_id.clone())
}

fn bound_thread_busy(state: &crate::State) -> bool {
    state.active.is_some()
        || state.compacting
        || state.thread.desktop.as_ref().is_some_and(|d| {
            d.queue
                .items
                .iter()
                .any(|i| matches!(i.status.as_str(), "pending" | "running"))
                || d.interactions.iter().any(|i| i.status == "pending")
        })
}

impl DesktopScheduleTools {
    fn for_tools(
        self,
        definitions: &[areal_protocol::ToolDefinition],
    ) -> Option<Arc<dyn tools::DynamicToolHost>> {
        if self.host.is_closed()
            || definitions.is_empty()
            || definitions.iter().any(|tool| {
                !self.definitions.iter().any(|known| {
                    tool.name == known.name
                        && tool.description == known.description
                        && tool.input_schema == known.input_schema
                        && tool.output_schema == known.output_schema
                })
            })
        {
            return None;
        }
        Some(self.host)
    }
}
