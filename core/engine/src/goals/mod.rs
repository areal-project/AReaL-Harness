//! 持久目标与线程调度；Core 保留唯一的目标控制权。
mod budget;
mod tools;
use super::*;
use areal_protocol::desktop::EffectiveConfig;
use areal_protocol::goals::*;
pub use budget::Budget;
use std::collections::VecDeque;
use std::sync::{Mutex as StdMutex, RwLock as StdRwLock};
pub(crate) use tools::definitions;

#[derive(Clone, Debug)]
pub struct Policy {
    pub max_turns: u64,
    pub max_active_seconds: u64,
    pub max_unreported_turns: u64,
    pub turn_model_rounds: usize,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            max_turns: 100,
            max_active_seconds: 3600,
            max_unreported_turns: 3,
            turn_model_rounds: 32,
        }
    }
}
pub(super) struct Goals {
    started: std::sync::atomic::AtomicBool,
    budgets: StdRwLock<BTreeMap<String, Arc<Budget>>>,
    ready: StdMutex<VecDeque<String>>,
    changed: Arc<tokio::sync::Notify>,
}
impl Goals {
    pub(super) fn open(root: &Path, threads: &BTreeMap<String, Arc<Cell>>) -> anyhow::Result<Self> {
        let mut budgets = BTreeMap::new();
        for cell in threads.values() {
            let state = cell.state.try_lock()?;
            if let Some(goal) = &state.thread.goals.goal {
                budgets.insert(goal.id.clone(), Budget::open(root, goal)?);
            }
        }
        Ok(Self {
            started: std::sync::atomic::AtomicBool::new(false),
            budgets: StdRwLock::new(budgets),
            ready: StdMutex::new(VecDeque::new()),
            changed: Arc::new(tokio::sync::Notify::new()),
        })
    }
    pub(super) fn budget(&self, thread: &Thread) -> Option<Arc<Budget>> {
        let key = thread
            .goal_owner
            .as_ref()
            .map(|o| &o.goal_id)
            .or_else(|| thread.goals.goal.as_ref().map(|g| &g.id))?;
        self.budgets.read().unwrap().get(key).cloned()
    }
    pub(super) fn request(&self, id: &str) {
        let mut ready = self.ready.lock().unwrap();
        if !ready.iter().any(|v| v == id) {
            ready.push_back(id.into());
        }
        self.changed.notify_one();
    }
    pub(super) fn defer(&self, id: &str) {
        let mut q = self.ready.lock().unwrap();
        if !q.iter().any(|v| v == id) {
            q.push_back(id.into());
        }
    }
    pub(super) fn wake(&self) {
        self.changed.notify_one();
    }
}
fn invalid(s: impl ToString) -> Error {
    Error::Invalid(s.to_string())
}
fn changed(state: &mut GoalState) {
    state.revision += 1;
    state.event_sequence += 1;
}
fn objective(text: &str) -> Result<()> {
    if text.trim().is_empty() || text.chars().count() > 4000 {
        return Err(invalid("objective must contain 1..4000 characters"));
    }
    Ok(())
}
fn has_pending(thread: &Thread) -> bool {
    thread.desktop.as_ref().is_some_and(|d| {
        d.queue
            .items
            .iter()
            .any(|q| matches!(q.status.as_str(), "pending" | "running"))
    })
}
fn projection(thread: &Thread) -> Value {
    json!({"threadId":thread.id,"revision":thread.goals.revision,"eventSequence":thread.goals.event_sequence,"goal":thread.goals.goal})
}
fn emit(cell: &Cell, thread: &Thread) {
    cell.emit("areal/goal/updated", projection(thread));
}

impl Engine {
    pub(super) fn spawn_goal_scheduler(self: &Arc<Self>) {
        if self.goals.started.swap(true, Ordering::AcqRel) {
            return;
        }
        let weak = Arc::downgrade(self);
        let changed = self.goals.changed.clone();
        let cancel = self.shutdown.clone();
        self.tasks.spawn(async move {
            loop {
                tokio::select! { _ = cancel.cancelled() => break, _ = changed.notified() => {} }
                let Some(engine) = weak.upgrade() else {
                    break;
                };
                let count = engine.goals.ready.lock().unwrap().len();
                for _ in 0..count {
                    let id = engine.goals.ready.lock().unwrap().pop_front();
                    let Some(id) = id else {
                        break;
                    };
                    if let Ok(cell) = engine.cell(&id).await
                        && let Err(error) = engine.advance_thread(&cell).await
                    {
                        tracing::error!(%error, "goal dispatch failed");
                    }
                }
            }
        });
    }
    fn validate_goal_limits(&self, token: Option<u64>, turns: u64, seconds: u64) -> Result<()> {
        if token == Some(0)
            || turns == 0
            || turns > self.limits.goals.max_turns
            || seconds == 0
            || seconds > self.limits.goals.max_active_seconds
        {
            return Err(invalid("goal limits exceed deployment policy or are zero"));
        }
        Ok(())
    }
    fn validate_goal_config(&self, config: &EffectiveConfig) -> Result<()> {
        if config.options.max_model_rounds.is_some_and(|n| n < 2)
            || config.tool_allowlist.as_ref().is_some_and(|a| {
                !["goal_read", "goal_update"]
                    .iter()
                    .all(|n| a.iter().any(|v| v == n))
            })
        {
            return Err(invalid(
                "Goal requires goal_read, goal_update and at least two model rounds",
            ));
        }
        Ok(())
    }
    pub async fn goal_get(&self, thread_id: &str) -> Result<Value> {
        let cell = self.raw_cell(thread_id).await?;
        let state = cell.state.lock().await;
        let mut thread = state.thread.clone();
        self.refresh_goal_usage(&mut thread);
        Ok(projection(&thread))
    }
    pub async fn goal_create(
        self: &Arc<Self>,
        identity: String,
        request: GoalCreate,
    ) -> Result<Value> {
        self.mutate(move |engine| async move {
            let _gate = engine.desktop.lifecycle.gate.lock().await;
            let cell = engine.cell(&request.thread_id).await?;
            let mut state = cell.state.lock().await;
            let hash = desktop::digest(&request)?;
            let mut candidate = state.thread.clone();
            let data = candidate.desktop.get_or_insert_with(Default::default);
            if let Some(value) = desktop::receipt(
                data,
                &identity,
                &request.request_id,
                "areal/goal/create",
                &hash,
            )? {
                return Ok(value);
            }
            if !engine.accepting_work() {
                return Err(Error::Closed);
            }
            if state.active.is_some()
                || state.compacting
                || state.thread.parent_thread_id.is_some()
                || state.thread.goals.goal.is_some()
                || state.thread.goals.revision != request.expected_revision
                || has_pending(&state.thread)
            {
                return Err(Error::Conflict);
            }
            engine.check_turn_available(&cell, &state).await?;
            engine.validate_goal_config(&data.configuration)?;
            objective(&request.objective)?;
            let max_turns = request.max_turns.unwrap_or(engine.limits.goals.max_turns);
            let max_active_seconds = request
                .max_active_seconds
                .unwrap_or(engine.limits.goals.max_active_seconds);
            engine.validate_goal_limits(request.token_budget, max_turns, max_active_seconds)?;
            let goal = Goal {
                interaction_mode: request
                    .interaction_mode
                    .unwrap_or(data.configuration.options.interaction_mode),
                id: id(),
                thread_id: request.thread_id.clone(),
                objective: request.objective.clone(),
                status: GoalStatus::Active,
                reason: None,
                token_budget: request.token_budget,
                max_turns,
                max_active_seconds,
                usage: GoalUsage {
                    accounting_complete: true,
                    ..Default::default()
                },
                active_turn_id: None,
                settling: false,
                waiting_for_input: false,
                waiting_for_agents: false,
                waiting_for_capacity: false,
                report: None,
                report_turn_id: None,
                unreported_turns: 0,
            };
            candidate.goals.goal = Some(goal.clone());
            changed(&mut candidate.goals);
            let (mut candidate, turn) =
                engine.prepare_turn(&candidate, vec![Input::text(request.objective)])?;
            let permit = engine.reserve_active_turn()?;
            let budget = Budget::open(engine.store.root(), &goal).map_err(invalid)?;
            budget.flush().await.map_err(invalid)?;
            let (task_id, run_id) = engine
                .bind_goal_task(&identity, &request.request_id, &goal)
                .await?;
            let result = {
                let mut value = projection(&candidate);
                value["turnId"] = json!(turn.id);
                value["taskId"] = json!(task_id);
                value["runId"] = json!(run_id);
                value
            };
            desktop::remember(
                candidate.desktop.as_mut().unwrap(),
                &identity,
                &request.request_id,
                "areal/goal/create",
                hash,
                result.clone(),
            );
            engine.persist(&candidate).await?;
            engine
                .goals
                .budgets
                .write()
                .unwrap()
                .insert(goal.id, budget);
            state.thread = candidate;
            emit(&cell, &state.thread);
            engine.activate(
                &cell,
                &mut state,
                &turn,
                engine.shutdown.child_token(),
                permit,
            );
            Ok(result)
        })
        .await
    }
    pub async fn goal_control(
        self: &Arc<Self>,
        identity: String,
        action: String,
        request: GoalControl,
        update: Option<GoalUpdate>,
    ) -> Result<Value> {
        self.mutate(move |engine| async move {
            let _gate = engine.desktop.lifecycle.gate.lock().await;
            let cell = engine.cell(&request.thread_id).await?;
            let mut state = cell.state.lock().await;
            let method = format!("areal/goal/{action}");
            let hash = desktop::digest(&(&request, &update))?;
            let mut candidate = state.thread.clone();
            let data = candidate.desktop.get_or_insert_with(Default::default);
            if let Some(value) =
                desktop::receipt(data, &identity, &request.request_id, &method, &hash)?
            {
                return Ok(value);
            }
            if candidate.goals.revision != request.expected_revision
                || (candidate.parent_thread_id.is_some() || candidate.goal_owner.is_some())
            {
                return Err(Error::Conflict);
            }
            if action == "resume" && !engine.task_goal_can_resume(&request.goal_id).await {
                return Err(Error::Conflict);
            }
            if action != "pause" {
                engine.task_workers_settled(&candidate, false).await?;
            }
            let budget = engine.goals.budget(&candidate).ok_or(Error::NotFound)?;
            engine.refresh_goal_usage(&mut candidate);
            let previous_goal = candidate.goals.goal.clone();
            let goal = candidate
                .goals
                .goal
                .as_mut()
                .filter(|g| g.id == request.goal_id)
                .ok_or(Error::Conflict)?;
            let reopen =
                action == "update" && update.as_ref().is_some_and(|patch| patch.reopen_completed);
            if reopen
                && (goal.status != GoalStatus::Completed
                    || update
                        .as_ref()
                        .is_none_or(|patch| patch.objective.is_none())
                    || !engine.task_goal_can_reopen(&request.goal_id).await)
            {
                return Err(invalid(
                    "repair requires a completed, uncancelled latest non-scheduled Goal and an explicit objective",
                ));
            }
            if goal.status == GoalStatus::Completed && action != "clear" && !reopen {
                return Err(Error::Conflict);
            }
            if action != "pause"
                && (state.active.is_some() || state.compacting || goal.status == GoalStatus::Active)
            {
                return Err(Error::Conflict);
            }
            match action.as_str() {
                "pause" => {
                    goal.status = GoalStatus::Paused;
                    goal.reason = Some("user".into());
                    goal.settling = state.active.is_some();
                    goal.waiting_for_capacity = false;
                    goal.report_turn_id = None;
                    let queue = &mut candidate.desktop.as_mut().unwrap().queue;
                    if !queue.paused {
                        queue.paused = true;
                        queue.pause_reason = Some(format!("goal:{}", request.goal_id));
                        queue.revision += 1;
                    }
                }
                "update" => {
                    engine.check_turn_available(&cell, &state).await?;
                    let patch = update
                        .as_ref()
                        .ok_or_else(|| invalid("update parameters required"))?;
                    if patch.objective.is_none()
                        && patch.token_budget.is_none()
                        && patch.max_turns.is_none()
                        && patch.max_active_seconds.is_none()
                    {
                        return Err(invalid("empty goal update"));
                    }
                    if let Some(text) = &patch.objective {
                        objective(text)?;
                        goal.objective = text.clone();
                    }
                    if let Some(value) = patch.token_budget {
                        goal.token_budget = value;
                    }
                    if let Some(value) = patch.max_turns {
                        goal.max_turns = value;
                    }
                    if let Some(value) = patch.max_active_seconds {
                        goal.max_active_seconds = value;
                    }
                    engine.validate_goal_limits(
                        goal.token_budget,
                        goal.max_turns,
                        goal.max_active_seconds,
                    )?;
                    if reopen {
                        // 只开放显式修复阶段；沿用原目标、累计用量和历史完成报告。
                        goal.status = GoalStatus::Paused;
                        goal.reason = Some("repairRequested".into());
                        goal.unreported_turns = 0;
                        let queue = &mut candidate.desktop.as_mut().unwrap().queue;
                        queue.paused = true;
                        queue.pause_reason = Some(format!("goal:{}", request.goal_id));
                        queue.revision += 1;
                    }
                    goal.report_turn_id = None;
                }
                "resume" => {
                    if !engine.accepting_work() {
                        return Err(Error::Closed);
                    }
                    engine.check_turn_available(&cell, &state).await?;
                    if goal.usage.turns_started >= goal.max_turns
                        || goal.usage.time_used_seconds >= goal.max_active_seconds as f64
                        || goal.token_budget.is_some_and(|n| {
                            goal.usage
                                .tokens_used
                                .saturating_add(goal.usage.reserved_tokens)
                                >= n
                        })
                    {
                        return Err(invalid("increase exhausted goal budget before resuming"));
                    }
                    engine.validate_goal_config(
                        &state.thread.desktop.as_ref().unwrap().configuration,
                    )?;
                    budget.acknowledge_usage();
                    budget.flush().await.map_err(invalid)?;
                    engine.ensure_goal_task(&identity, goal).await?;
                    goal.status = GoalStatus::Active;
                    goal.reason = None;
                    goal.unreported_turns = 0;
                    goal.report_turn_id = None;
                    let queue = &mut candidate.desktop.as_mut().unwrap().queue;
                    if queue.pause_reason.as_deref() == Some(&format!("goal:{}", request.goal_id)) {
                        queue.paused = false;
                        queue.pause_reason = None;
                        queue.revision += 1;
                    }
                }
                "clear" => {
                    engine.check_turn_available(&cell, &state).await?;
                    if has_pending(&candidate)
                        || candidate
                            .desktop
                            .as_ref()
                            .is_some_and(|d| d.processes.iter().any(|p| !p.cleanup_confirmed))
                    {
                        return Err(invalid("settle queue and resources before clearing goal"));
                    }
                    candidate.goals.goal = None;
                    let queue = &mut candidate.desktop.as_mut().unwrap().queue;
                    if queue.pause_reason.as_deref() == Some(&format!("goal:{}", request.goal_id)) {
                        queue.paused = false;
                        queue.pause_reason = None;
                        queue.revision += 1;
                    }
                }
                _ => return Err(invalid("unknown goal operation")),
            }
            changed(&mut candidate.goals);
            let result = projection(&candidate);
            desktop::remember(
                candidate.desktop.as_mut().unwrap(),
                &identity,
                &request.request_id,
                &method,
                hash,
                result.clone(),
            );
            engine.persist(&candidate).await?;
            state.thread = candidate;
            budget.configure(
                state
                    .thread
                    .goals
                    .goal
                    .as_ref()
                    .and_then(|g| g.token_budget),
                state
                    .thread
                    .goals
                    .goal
                    .as_ref()
                    .is_some_and(|g| g.status == GoalStatus::Active),
            );
            if action == "pause"
                && let Some(active) = &state.active
            {
                active.cancel.cancel();
            }
            if action == "clear" {
                engine
                    .goals
                    .budgets
                    .write()
                    .unwrap()
                    .remove(&request.goal_id);
                let mut event = result.clone();
                event["goalId"] = json!(request.goal_id);
                cell.emit("areal/goal/cleared", event);
            } else {
                emit(&cell, &state.thread);
            }
            engine
                .sync_goal_task_control(
                    &state.thread,
                    &request.goal_id,
                    &action,
                    previous_goal.as_ref(),
                )
                .await?;
            if action == "resume" {
                engine.spawn_goal_scheduler();
                engine.goals.request(&state.thread.id);
            }
            Ok(result)
        })
        .await
    }
    pub(super) fn prepare_goal_turn(&self, thread: &mut Thread, turn: &mut Turn) -> Result<()> {
        let Some(goal) = thread
            .goals
            .goal
            .as_mut()
            .filter(|g| g.status == GoalStatus::Active)
        else {
            return Ok(());
        };
        if goal.usage.turns_started >= goal.max_turns
            || goal.usage.time_used_seconds >= goal.max_active_seconds as f64
        {
            return Err(Error::Exhausted("goal execution limit reached".into()));
        }
        let config = turn.configuration.get_or_insert_with(Default::default);
        config.options.interaction_mode = goal.interaction_mode;
        self.validate_goal_config(config)?;
        config.options.max_model_rounds = Some(
            config
                .options
                .max_model_rounds
                .unwrap_or(self.limits.goals.turn_model_rounds)
                .min(self.limits.goals.turn_model_rounds),
        );
        goal.usage.turns_started += 1;
        turn.goal = Some(GoalTurn {
            goal_id: goal.id.clone(),
            sequence: goal.usage.turns_started,
            origin: if goal.usage.turns_started == 1 {
                "initial"
            } else {
                "user"
            }
            .into(),
            predecessor_turn_id: thread.turns.last().map(|t| t.id.clone()),
        });
        goal.active_turn_id = Some(turn.id.clone());
        goal.waiting_for_capacity = false;
        goal.waiting_for_input = false;
        goal.waiting_for_agents = false;
        goal.settling = false;
        thread.goals.event_sequence += 1;
        Ok(())
    }
    pub(super) fn refresh_goal_usage(&self, thread: &mut Thread) {
        if let Some(budget) = self.goals.budget(thread)
            && let Some(goal) = &mut thread.goals.goal
        {
            let count = goal.usage.turns_started;
            goal.usage = budget.usage();
            goal.usage.turns_started = count;
            goal.waiting_for_input |= thread
                .desktop
                .as_ref()
                .is_some_and(|d| d.interactions.iter().any(|i| i.status == "pending"));
        }
    }
    pub(super) fn settle_goal(&self, thread: &mut Thread) {
        self.refresh_goal_usage(thread);
        let unknown_pending = self
            .goals
            .budget(thread)
            .is_some_and(|b| b.unknown_pending());
        let Some(turn) = thread.turns.last() else {
            return;
        };
        let Some(goal) = thread
            .goals
            .goal
            .as_mut()
            .filter(|g| turn.goal.as_ref().is_some_and(|t| t.goal_id == g.id))
        else {
            return;
        };
        goal.active_turn_id = None;
        goal.settling = false;
        if goal.status == GoalStatus::Active {
            let error = turn
                .error
                .as_ref()
                .map(|e| e.message.as_str())
                .unwrap_or("");
            if error.contains("GOAL_TOKEN_BUDGET") || error.contains("GOAL_TIME_BUDGET") {
                goal.status = GoalStatus::BudgetLimited;
                goal.reason = Some(error.into());
            } else if unknown_pending {
                goal.status = GoalStatus::Blocked;
                goal.reason = Some("usageUnknown".into());
            } else if turn.status != TurnStatus::Completed {
                goal.status =
                    if error.contains("GOAL_TOKEN_BUDGET") || error.contains("GOAL_TIME_BUDGET") {
                        GoalStatus::BudgetLimited
                    } else if error.contains("UNKNOWN")
                        || error.contains("interaction")
                        || error.contains("GOAL_DEPENDENCY_FAILED")
                    {
                        GoalStatus::Blocked
                    } else if turn.status == TurnStatus::Interrupted {
                        GoalStatus::Paused
                    } else {
                        GoalStatus::Failed
                    };
                goal.reason = Some(
                    if error.is_empty() {
                        "interrupted"
                    } else {
                        error
                    }
                    .into(),
                );
            } else if goal.waiting_for_input || goal.waiting_for_agents {
                // 主动挂起已完成本轮清理，不应被未报告次数触发暂停。
                goal.unreported_turns = 0;
            } else if let Some(report) = &goal.report
                && goal.report_turn_id.as_deref() == Some(&turn.id)
            {
                goal.unreported_turns = 0;
                match report.status {
                    GoalReportStatus::Complete => {
                        goal.status = GoalStatus::Completed;
                        goal.reason = None;
                    }
                    GoalReportStatus::Blocked => {
                        goal.status = GoalStatus::Blocked;
                        goal.reason = report.blocker.clone();
                    }
                    GoalReportStatus::Continue => {}
                }
            } else {
                goal.unreported_turns += 1;
                if goal.unreported_turns >= self.limits.goals.max_unreported_turns {
                    goal.status = GoalStatus::Paused;
                    goal.reason = Some("progressUnreported".into());
                }
            }
            if goal.status == GoalStatus::Active
                && (goal.usage.turns_started >= goal.max_turns
                    || goal.usage.time_used_seconds >= goal.max_active_seconds as f64
                    || goal
                        .token_budget
                        .is_some_and(|n| goal.usage.tokens_used >= n))
            {
                goal.status = GoalStatus::BudgetLimited;
                goal.reason = Some("goalBudget".into());
            }
        }
        if !matches!(goal.status, GoalStatus::Active | GoalStatus::Completed)
            && let Some(data) = &mut thread.desktop
            && !data.queue.paused
        {
            data.queue.paused = true;
            data.queue.pause_reason = Some(format!("goal:{}", goal.id));
            data.queue.revision += 1;
        }
        changed(&mut thread.goals);
        if let Some(budget) = self.goals.budget(thread) {
            let goal = thread.goals.goal.as_ref().unwrap();
            budget.configure(goal.token_budget, goal.status == GoalStatus::Active);
        }
    }
    pub(super) fn goal_emit(&self, cell: &Cell, thread: &Thread) {
        if thread.goals.goal.is_some() {
            emit(cell, thread);
        }
    }
    pub(super) async fn goal_for_owner(&self, owner: &str) -> Option<Arc<Budget>> {
        let id = owner.split('/').next()?;
        let cell = self.raw_cell(id).await.ok()?;
        {
            let state = cell.state.lock().await;
            if state.thread.goal_owner.is_some()
                || state.thread.turns.last().is_some_and(|t| t.goal.is_some())
            {
                self.goals.budget(&state.thread)
            } else {
                None
            }
        }
    }
}
