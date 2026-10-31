//! 桌面安排复用 Task 账本；Host 只提供配置，不拥有触发时间或执行身份。
use super::*;
use areal_protocol::desktop::ThreadStart;

impl Engine {
    pub async fn register_schedule_host(
        self: &Arc<Self>,
        host: Arc<dyn tools::DynamicToolHost>,
    ) -> Result<()> {
        if host.is_closed() {
            return Err(Error::Closed);
        }
        let mut hosts = self.task_modes.hosts.lock().await;
        if hosts
            .get(host.identity())
            .is_some_and(|old| old.id() != host.id() && !old.is_closed())
        {
            return Err(Error::Conflict);
        }
        hosts.insert(host.identity().into(), host);
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
            .filter(|h| !h.is_closed())
            .cloned()
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
                let bound = cell.bindings.read().await.host.clone();
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
                    // 空工具集也绑定 Host，执行不能因没有浏览器工具而变成脱离桌面的任务。
                    {
                        let state = cell.state.lock().await;
                        if state.active.is_some() {
                            return Ok(());
                        }
                        let mut bindings = cell.bindings.write().await;
                        if bindings
                            .host
                            .as_ref()
                            .is_some_and(|old| !old.is_closed() && old.id() != host.id())
                        {
                            return Err(Error::Conflict);
                        }
                        bindings.host = Some(host);
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
            let p: ThreadStart = serde_json::from_value(value).map_err(invalid)?;
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
        let thread = if let Some(thread) = &run.thread_id {
            self.read(thread, false).await?
        } else {
            self.create_configured(task.owner.clone(), request, host.clone())
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
                .host
                .as_ref()
                .is_some_and(|h| !h.is_closed() && h.id() != host.id())
            {
                return Err(Error::Conflict);
            }
            bindings.host = Some(host);
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
