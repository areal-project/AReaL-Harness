use super::*;

impl Engine {
    /// 嵌入式宿主应在完成模型与工具装配后启动；重复调用不产生多个调度器。
    pub fn start_task_scheduler(self: &Arc<Self>) {
        if self.task_modes.started.swap(true, Ordering::AcqRel) {
            return;
        }
        let weak = Arc::downgrade(self);
        let cancel = self.shutdown.clone();
        let changed = self.task_modes.changed.clone();
        self.tasks.spawn(async move {
            let mut timer = tokio::time::interval(Duration::from_secs(1));
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! { biased;
                    _ = cancel.cancelled() => break,
                    _ = changed.notified() => {},
                    _ = timer.tick() => {},
                }
                let Some(engine) = weak.upgrade() else {
                    break;
                };
                let ids: Vec<_> = engine
                    .task_modes
                    .state
                    .lock()
                    .await
                    .tasks
                    .keys()
                    .cloned()
                    .collect();
                for id in ids {
                    if cancel.is_cancelled() {
                        break;
                    }
                    if let Err(error) = engine.advance_task(&id).await {
                        // 用户控制或其他结算已推进 CAS；下一次唤醒重读，不能自行暂停新状态。
                        if matches!(error, Error::Conflict) {
                            continue;
                        }
                        tracing::error!(task_id=%id,%error,"task dispatch failed");
                        if let Err(error) = engine
                            .edit_task(&id, |task| {
                                task.paused = true;
                                if let Some(run) = task.runs.last_mut() {
                                    run.status = RunStatus::Blocked;
                                    run.reason = Some(error.to_string());
                                }
                            })
                            .await
                        {
                            tracing::error!(%error,"task failure persistence failed");
                        }
                    }
                }
            }
        });
    }

    pub(crate) fn wake_tasks(&self) {
        self.task_modes.changed.notify_one();
    }

    pub(super) async fn edit_task(&self, id: &str, edit: impl FnOnce(&mut Task)) -> Result<()> {
        let mut state = self.task_modes.state.lock().await;
        let mut candidate = state.clone();
        let task = candidate.tasks.get_mut(id).ok_or(Error::NotFound)?;
        let previous = serde_json::to_value(&task).map_err(invalid)?;
        edit(task);
        if previous == serde_json::to_value(&task).map_err(invalid)? {
            return Ok(());
        }
        task.revision += 1;
        self.save_tasks(&mut state, candidate, id).await
    }

    async fn control_goal_from_task(
        self: &Arc<Self>,
        task: &Task,
        run: &TaskRun,
        action: &str,
        view: &Value,
    ) -> Result<()> {
        let operation = if action == "pause" { "stop" } else { action };
        self.goal_control_for_task(
            task.owner.clone(),
            action.into(),
            GoalControl {
                request_id: format!("task-{operation}-{}-{}", run.id, task.revision),
                thread_id: run.thread_id.clone().ok_or(Error::Conflict)?,
                goal_id: run.goal_id.clone().ok_or(Error::Conflict)?,
                expected_revision: view["revision"].as_u64().ok_or(Error::Conflict)?,
            },
            (task.id.clone(), task.revision),
        )
        .await?;
        Ok(())
    }

    async fn advance_task(self: &Arc<Self>, task_id: &str) -> Result<()> {
        self.edit_task(task_id, |task| {
            let current_run = task.runs.last().map(|r| r.id.as_str());
            let mut expired = false;
            for m in &mut task.messages {
                if m.status == "pending" && m.expires_at.is_some_and(|at| at <= now()) {
                    m.status = "expired".into();
                    task.channel_sequence += 1;
                    m.sequence = task.channel_sequence;
                    expired |= current_run == Some(m.run_id.as_str());
                }
            }
            if let Some(run) = task.runs.last_mut()
                && (expired
                    || (run.workers.iter().all(|w| w.settled)
                        && !task
                            .messages
                            .iter()
                            .any(|m| m.run_id == run.id && m.status == "pending")))
            {
                // 任一问题过期都交还模型判断，其他未回答问题不能掩盖该唤醒。
                run.wait_requested = false;
            }
        })
        .await?;
        let task = self.task_read(task_id).await?;
        self.settle_task_workers(&task).await?;
        let task = self.task_read(task_id).await?;
        if let Some(run) = task.runs.last() {
            if let (Some(thread), Some(goal_id)) = (&run.thread_id, &run.goal_id) {
                let view = self.goal_get(thread).await?;
                if view["goal"]["id"].as_str() == Some(goal_id) {
                    let goal: Goal =
                        serde_json::from_value(view["goal"].clone()).map_err(invalid)?;
                    if (task.paused || task.cancelled) && goal.status == GoalStatus::Active {
                        self.control_goal_from_task(&task, run, "pause", &view)
                            .await?;
                        return Ok(());
                    }
                    if run.reason.as_deref() == Some("resumeRequested")
                        && !task.paused
                        && !task.cancelled
                        && self.accepting_work()
                        && goal.active_turn_id.is_none()
                        && !goal.settling
                        && run.workers.iter().all(|w| w.settled)
                        && matches!(goal.status, GoalStatus::Paused | GoalStatus::Blocked)
                    {
                        self.control_goal_from_task(&task, run, "resume", &view)
                            .await?;
                        self.edit_task(task_id, |task| {
                            task.runs.last_mut().unwrap().reason = None;
                        })
                        .await?;
                        return Ok(());
                    }
                    let expected_revision = task.revision;
                    self.edit_task(task_id, |task| {
                        // Goal 查询期间发生用户控制时，不能用旧投影覆盖 resumeRequested。
                        if task.revision != expected_revision {
                            return;
                        }
                        let cancelled = task.cancelled;
                        let run = task.runs.last_mut().unwrap();
                        // 计划控制只影响未结束的执行，不能改写已结算 Run 的历史。
                        if run.status.terminal() {
                            return;
                        }
                        run.usage = goal.usage.clone();
                        if goal.active_turn_id.is_some()
                            || goal.settling
                            || (goal.status != GoalStatus::Active
                                && run.workers.iter().any(|w| !w.settled))
                        {
                            return;
                        }
                        run.status = if cancelled {
                            RunStatus::Cancelled
                        } else {
                            match goal.status {
                                GoalStatus::Active
                                    if run.wait_requested
                                        && run.workers.iter().any(|w| !w.settled) =>
                                {
                                    RunStatus::WaitingForAgents
                                }
                                GoalStatus::Active if run.wait_requested => {
                                    RunStatus::WaitingForInput
                                }
                                GoalStatus::Active => RunStatus::Running,
                                GoalStatus::Paused => RunStatus::Paused,
                                GoalStatus::Blocked | GoalStatus::BudgetLimited => {
                                    RunStatus::Blocked
                                }
                                GoalStatus::Completed => RunStatus::Completed,
                                GoalStatus::Failed => RunStatus::Failed,
                            }
                        };
                        run.reason = goal.reason.clone();
                        if run.status.terminal() && run.completed_at.is_none() {
                            run.completed_at = Some(now());
                            for m in &mut task.messages {
                                if m.run_id == run.id && m.status == "pending" {
                                    m.status = "cancelled".into();
                                    task.channel_sequence += 1;
                                    m.sequence = task.channel_sequence;
                                }
                            }
                            if task.messages.len() < MAX_MESSAGES {
                                task.channel_sequence += 1;
                                task.messages.push(ChannelMessage {
                                    id: id(),
                                    sequence: task.channel_sequence,
                                    run_id: run.id.clone(),
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
                                        .unwrap_or_else(|| {
                                            format!(
                                                "{:?}: {}",
                                                run.status,
                                                run.reason.as_deref().unwrap_or("")
                                            )
                                        }),
                                });
                            }
                        }
                    })
                    .await?;
                    if goal.status == GoalStatus::Active
                        && goal.active_turn_id.is_none()
                        && !run.wait_requested
                        && !task.paused
                        && !task.cancelled
                    {
                        self.goals.request(thread);
                    }
                } else if !run.status.terminal() {
                    self.edit_task(task_id, |task| {
                        let run = task.runs.last_mut().unwrap();
                        run.status = RunStatus::Blocked;
                        run.reason = Some("goalMissingOrReplaced".into());
                        task.paused = true;
                    })
                    .await?;
                }
            } else if task.cancelled && !run.status.terminal() {
                self.edit_task(task_id, |task| {
                    let run = task.runs.last_mut().unwrap();
                    run.status = RunStatus::Cancelled;
                    run.completed_at = Some(now());
                })
                .await?;
            }
        }
        let task = self.task_read(task_id).await?;
        if task.cancelled || task.paused || !self.accepting_work() {
            return Ok(());
        }
        if task.next_run_at.is_some_and(|at| at <= now()) {
            self.edit_task(task_id, |task| {
                // 修改计划或暂停可能发生在上次读取之后，必须在同一状态锁下重新判断。
                if task.paused || task.cancelled {
                    return;
                }
                let Some(at) = task.next_run_at.filter(|at| *at <= now()) else {
                    return;
                };
                let busy = task.runs.last().is_some_and(|r| !r.status.terminal());
                task.next_run_at =
                    task.schedule
                        .as_ref()
                        .and_then(|s| s.interval_seconds)
                        .map(|interval| {
                            let interval = interval as i64;
                            at.saturating_add(
                                ((now() - at) / interval + 1).saturating_mul(interval),
                            )
                        });
                // 周期任务合并错过的时间点；已有 Run 未结束时跳过本次触发。
                if !busy {
                    if task.runs.len() >= MAX_RUNS {
                        task.paused = true;
                    } else {
                        task.runs.push(new_run(task.thread_id.clone(), at));
                    }
                }
            })
            .await?;
        }
        let task = self.task_read(task_id).await?;
        let Some(run) = task
            .runs
            .last()
            .filter(|r| r.status == RunStatus::Queued)
            .cloned()
        else {
            return Ok(());
        };
        let thread = match &run.thread_id {
            Some(id) => id.clone(),
            None => {
                let created = self.create(self.default_cwd()).await?;
                self.edit_task(task_id, |t| {
                    t.runs.last_mut().unwrap().thread_id = Some(created.id.clone())
                })
                .await?;
                created.id
            }
        };
        let cell = self.cell(&thread).await?;
        {
            let state = cell.state.lock().await;
            if state.active.is_some()
                || state.compacting
                || state.thread.desktop.as_ref().is_some_and(|d| {
                    d.queue
                        .items
                        .iter()
                        .any(|i| matches!(i.status.as_str(), "pending" | "running"))
                })
            {
                return Ok(());
            }
        }
        let mut view = self.goal_get(&thread).await?;
        if let Some(goal_id) = view["goal"]["id"].as_str() {
            if view["goal"]["status"] == "active" {
                return Ok(());
            }
            if !task
                .runs
                .iter()
                .any(|r| r.goal_id.as_deref() == Some(goal_id))
            {
                return Ok(());
            }
            self.goal_control(
                task.owner.clone(),
                "clear".into(),
                GoalControl {
                    request_id: format!("task-clear-{}", run.id),
                    thread_id: thread.clone(),
                    goal_id: goal_id.into(),
                    expected_revision: view["revision"].as_u64().unwrap(),
                },
                None,
            )
            .await?;
            view = self.goal_get(&thread).await?;
        }
        let used: u64 = task
            .runs
            .iter()
            .map(|r| r.usage.tokens_used.saturating_add(r.usage.reserved_tokens))
            .fold(0, u64::saturating_add);
        let budget = task.token_budget.map(|n| n.saturating_sub(used));
        if budget == Some(0) {
            return Err(invalid("task token budget exhausted"));
        }
        let result = self
            .goal_create(
                task.owner.clone(),
                GoalCreate {
                    output_format: None,
                    workflow: None,
                    infer_limits: false,
                    request_id: format!("task-run-{}", run.id),
                    thread_id: thread,
                    expected_revision: view["revision"].as_u64().unwrap(),
                    objective: task.objective,
                    token_budget: budget,
                    max_turns: task.max_turns,
                    max_active_seconds: task.max_active_seconds,
                    interaction_mode: Some(task.interaction_mode),
                },
            )
            .await;
        match result {
            Ok(_) => Ok(()),
            Err(Error::Conflict) => Ok(()),
            Err(Error::Exhausted(ref reason)) if reason.starts_with("active Turn capacity") => {
                Ok(())
            }
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod control_race_tests {
    use super::*;
    struct Pending;
    #[async_trait::async_trait]
    impl Model for Pending {
        fn name(&self) -> &str {
            "task-control-race"
        }
        async fn stream(&self, _: Vec<model::Message>) -> anyhow::Result<model::ModelStream> {
            Ok(Box::pin(futures_util::stream::pending()))
        }
        async fn chat_limited(
            &self,
            m: Vec<model::Message>,
            _: Vec<Value>,
            _: model::RequestPurpose,
            _: Option<u64>,
        ) -> anyhow::Result<model::ModelStream> {
            self.stream(m).await
        }
    }
    fn control(view: &Value, request_id: &str) -> GoalControl {
        GoalControl {
            request_id: request_id.into(),
            thread_id: view["threadId"].as_str().unwrap().into(),
            goal_id: view["goal"]["id"].as_str().unwrap().into(),
            expected_revision: view["revision"].as_u64().unwrap(),
        }
    }
    #[tokio::test]
    async fn stale_paused_task_cannot_pause_a_goal_after_user_resume() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(dir.path(), Arc::new(Pending), Limits::default()).unwrap();
        // 直接驱动同一调度动作，固定“读旧 Task → 用户恢复 → 读新 Goal”的交错。
        engine.task_modes.started.store(true, Ordering::Release);
        let thread = engine.create("/workspace".into()).await.unwrap();
        let created = engine
            .goal_create(
                "fixture".into(),
                GoalCreate {
                    output_format: None,
                    workflow: None,
                    request_id: "create".into(),
                    thread_id: thread.id.clone(),
                    expected_revision: 0,
                    objective: "controlled task".into(),
                    token_budget: None,
                    max_turns: Some(5),
                    max_active_seconds: None,
                    infer_limits: false,
                    interaction_mode: None,
                },
            )
            .await
            .unwrap();
        engine
            .goal_control(
                "fixture".into(),
                "pause".into(),
                control(&created, "pause"),
                None,
            )
            .await
            .unwrap();
        engine.wait(&thread.id).await.unwrap();
        let stale = engine.task_list().await.remove(0);
        assert!(stale.paused);
        let paused = engine.goal_get(&thread.id).await.unwrap();
        engine
            .goal_control(
                "fixture".into(),
                "resume".into(),
                control(&paused, "resume"),
                None,
            )
            .await
            .unwrap();
        let resumed = engine.goal_get(&thread.id).await.unwrap();
        assert_eq!(resumed["goal"]["status"], "active");
        assert!(!engine.task_read(&stale.id).await.unwrap().paused);
        let result = engine
            .control_goal_from_task(&stale, stale.runs.last().unwrap(), "pause", &resumed)
            .await;
        let current = engine.goal_get(&thread.id).await.unwrap();
        assert!(
            matches!(result, Err(Error::Conflict)),
            "stale control returned {result:?}; goal={current}"
        );
        assert_eq!(current["goal"]["status"], "active");
        assert!(!engine.task_read(&stale.id).await.unwrap().paused);
        engine.shutdown().await;
    }
    #[tokio::test]
    async fn stale_resume_task_cannot_override_a_newer_task_pause() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(dir.path(), Arc::new(Pending), Limits::default()).unwrap();
        engine.task_modes.started.store(true, Ordering::Release);
        let thread = engine.create("/workspace".into()).await.unwrap();
        let created = engine
            .goal_create(
                "fixture".into(),
                GoalCreate {
                    output_format: None,
                    workflow: None,
                    request_id: "create".into(),
                    thread_id: thread.id.clone(),
                    expected_revision: 0,
                    objective: "controlled task".into(),
                    token_budget: None,
                    max_turns: Some(5),
                    max_active_seconds: None,
                    infer_limits: false,
                    interaction_mode: None,
                },
            )
            .await
            .unwrap();
        engine
            .goal_control(
                "fixture".into(),
                "pause".into(),
                control(&created, "pause"),
                None,
            )
            .await
            .unwrap();
        engine.wait(&thread.id).await.unwrap();
        let task = engine.task_list().await.remove(0);
        engine
            .task_control(
                "fixture".into(),
                "resume".into(),
                TaskControl {
                    task_id: task.id.clone(),
                    request_id: "resume-task".into(),
                    expected_revision: task.revision,
                },
            )
            .await
            .unwrap();
        let stale = engine.task_read(&task.id).await.unwrap();
        assert_eq!(
            stale.runs.last().unwrap().reason.as_deref(),
            Some("resumeRequested")
        );
        engine
            .task_control(
                "fixture".into(),
                "pause".into(),
                TaskControl {
                    task_id: task.id.clone(),
                    request_id: "pause-task".into(),
                    expected_revision: stale.revision,
                },
            )
            .await
            .unwrap();
        let view = engine.goal_get(&thread.id).await.unwrap();
        let result = engine
            .control_goal_from_task(&stale, stale.runs.last().unwrap(), "resume", &view)
            .await;
        assert!(matches!(result, Err(Error::Conflict)));
        assert_eq!(
            engine.goal_get(&thread.id).await.unwrap()["goal"]["status"],
            "paused"
        );
        assert!(engine.task_read(&task.id).await.unwrap().paused);
        engine.shutdown().await;
    }
}
