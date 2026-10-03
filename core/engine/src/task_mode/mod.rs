//! 任务身份与通信独立持久化；执行继续复用 Goal、Thread 和 Runtime 的准入边界。
mod channel;
mod scheduler;
mod workers;
use super::*;
use areal_protocol::{desktop::RequestReceipt, goals::*, tasks::*};
use serde::{Deserialize, Serialize};
use std::sync::atomic::AtomicBool;

const MAX_TASKS: usize = 1024;
const MAX_RUNS: usize = 128;
const MAX_MESSAGES: usize = 1024;
const MAX_RECEIPTS: usize = 8192;
const MAX_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Default, Serialize, Deserialize)]
struct Snapshot {
    version: u32,
    tasks: BTreeMap<String, Task>,
    receipts: Vec<RequestReceipt>,
}

pub(crate) struct Tasks {
    state: Mutex<Snapshot>,
    events: broadcast::Sender<Value>,
    changed: Arc<tokio::sync::Notify>,
    started: AtomicBool,
}

impl Tasks {
    pub(crate) fn open(root: &Path) -> anyhow::Result<Self> {
        let path = root.join("desktop/task-mode.json");
        let mut state: Snapshot = if path.exists() {
            anyhow::ensure!(
                std::fs::metadata(&path)?.len() <= MAX_BYTES as u64,
                "task store exceeds capacity"
            );
            serde_json::from_slice(&std::fs::read(path)?)?
        } else {
            Snapshot {
                version: 1,
                ..Default::default()
            }
        };
        anyhow::ensure!(
            state.version == 1 && state.tasks.len() <= MAX_TASKS,
            "unsupported task store"
        );
        for task in state.tasks.values_mut() {
            for run in &mut task.runs {
                if matches!(
                    run.status,
                    RunStatus::Running | RunStatus::WaitingForInput | RunStatus::WaitingForAgents
                ) {
                    run.status = RunStatus::Paused;
                    run.reason = Some("serverRestarted".into());
                    task.paused = true;
                    task.revision += 1;
                }
            }
        }
        Ok(Self {
            state: Mutex::new(state),
            events: broadcast::channel(256).0,
            changed: Arc::new(tokio::sync::Notify::new()),
            started: AtomicBool::new(false),
        })
    }
}

fn invalid(e: impl ToString) -> Error {
    Error::Invalid(e.to_string())
}

fn receipt(
    state: &Snapshot,
    owner: &str,
    method: &str,
    request: &str,
    hash: &str,
) -> Result<Option<Value>> {
    if request.is_empty() || request.len() > 128 {
        return Err(invalid("requestId must contain 1..128 bytes"));
    }
    if let Some(r) = state
        .receipts
        .iter()
        .find(|r| r.identity == owner && r.method == method && r.request_id == request)
    {
        return if r.digest == hash {
            Ok(Some(r.result.clone()))
        } else {
            Err(Error::Conflict)
        };
    }
    if state.receipts.len() >= MAX_RECEIPTS {
        return Err(Error::Exhausted("task receipt capacity reached".into()));
    }
    Ok(None)
}

fn remember(
    state: &mut Snapshot,
    owner: String,
    method: &str,
    request: String,
    hash: String,
    result: Value,
) {
    state.receipts.push(RequestReceipt {
        identity: owner,
        request_id: request,
        method: method.into(),
        digest: hash,
        result,
    });
}

fn run_id(task: &Task) -> Option<&str> {
    task.runs.last().map(|r| r.id.as_str())
}
fn new_run(thread_id: Option<String>, scheduled_at: i64) -> TaskRun {
    TaskRun {
        workers: vec![],
        id: id(),
        thread_id,
        goal_id: None,
        status: RunStatus::Queued,
        reason: None,
        scheduled_at,
        completed_at: None,
        usage: GoalUsage::default(),
        wait_requested: false,
    }
}

fn summary(task: &Task) -> Value {
    let mut value = json!(task);
    value.as_object_mut().unwrap().remove("messages");
    value["pendingQuestions"] = json!(
        task.messages
            .iter()
            .filter(|m| m.kind == "question" && m.status == "pending")
            .count()
    );
    value
}

impl Engine {
    async fn save_tasks(
        &self,
        state: &mut Snapshot,
        candidate: Snapshot,
        task_id: &str,
    ) -> Result<()> {
        if serde_json::to_vec(&candidate).map_err(invalid)?.len() > MAX_BYTES {
            return Err(Error::Exhausted("task store capacity reached".into()));
        }
        self.store
            .save_metadata("task-mode", &candidate)
            .await
            .map_err(|e| Error::Storage(e.to_string()))?;
        *state = candidate;
        if let Some(task) = state.tasks.get(task_id) {
            let _ = self.task_modes.events.send(notification("areal/task/updated", json!({
                "taskId":task.id,"revision":task.revision,"channelSequence":task.channel_sequence,
                "runId":run_id(task),"task":summary(task)
            })));
        }
        Ok(())
    }

    pub async fn task_read(&self, task_id: &str) -> Result<Task> {
        self.task_modes
            .state
            .lock()
            .await
            .tasks
            .get(task_id)
            .cloned()
            .ok_or(Error::NotFound)
    }

    pub async fn task_list(&self) -> Vec<Task> {
        self.task_modes
            .state
            .lock()
            .await
            .tasks
            .values()
            .cloned()
            .collect()
    }

    pub async fn task_snapshot_and_subscribe(
        &self,
        task_id: &str,
    ) -> Result<(Value, broadcast::Receiver<Value>)> {
        let state = self.task_modes.state.lock().await;
        let task = state.tasks.get(task_id).ok_or(Error::NotFound)?;
        Ok((summary(task), self.task_modes.events.subscribe()))
    }

    pub async fn task_create(
        self: &Arc<Self>,
        owner: String,
        request: TaskCreate,
    ) -> Result<Value> {
        self.mutate(move |engine| async move {
            let _gate = engine.desktop.lifecycle.gate.lock().await;
            if !engine.accepting_work() { return Err(Error::Closed); }
            if request.objective.trim().is_empty() || request.objective.chars().count() > 4000 {
                return Err(invalid("objective must contain 1..4000 characters"));
            }
            if request.token_budget == Some(0)
                || request.max_turns.is_some_and(|n| n == 0 || n > engine.limits.goals.max_turns)
                || request.max_active_seconds.is_some_and(|n| n == 0 || n > engine.limits.goals.max_active_seconds) {
                return Err(invalid("task budgets exceed deployment limits"));
            }
            if request.mode != TaskMode::Background && request.thread_id.is_none() {
                return Err(invalid("foreground and scheduled tasks require threadId"));
            }
            if (request.mode == TaskMode::Scheduled) != request.schedule.is_some()
                || request.schedule.as_ref().is_some_and(|s| s.at < 0 || s.interval_seconds.is_some_and(|n| !(1..=31_536_000).contains(&n))) {
                return Err(invalid("scheduled tasks require a UTC timestamp and optional intervalSeconds in 1..31536000"));
            }
            if let Some(thread) = &request.thread_id {
                let cell = engine.cell(thread).await?;
                let state = cell.state.lock().await;
                if state.thread.parent_thread_id.is_some() || state.thread.goal_owner.is_some() { return Err(invalid("task binding requires a root Thread")); }
                if request.mode != TaskMode::Foreground && !state.thread.dynamic_tools.is_empty() { return Err(invalid("detached tasks require server-owned tools")); }
            }
            if request.mode != TaskMode::Foreground && request.interaction_mode == Some(InteractionMode::Interactive) { return Err(invalid("detached tasks require asynchronous or headless interactions")); }
            let hash = desktop::digest(&request)?;
            let mut state = engine.task_modes.state.lock().await;
            if let Some(result) = receipt(&state, &owner, "create", &request.request_id, &hash)? { return Ok(result); }
            if state.tasks.len() >= MAX_TASKS { return Err(Error::Exhausted("task capacity reached".into())); }
            let mut candidate = state.clone();
            let task = Task {
                id: id(), revision: 1, channel_sequence: 0, owner: owner.clone(), mode: request.mode,
                interaction_mode: request.interaction_mode.unwrap_or(match request.mode {
                    TaskMode::Foreground => InteractionMode::Interactive,
                    TaskMode::Background => InteractionMode::Asynchronous,
                    TaskMode::Scheduled => InteractionMode::Headless,
                }), objective: request.objective, thread_id: request.thread_id.clone(),
                next_run_at: request.schedule.as_ref().map(|s| s.at), schedule: request.schedule,
                paused: false, cancelled: false, token_budget: request.token_budget,
                max_turns: request.max_turns, max_active_seconds: request.max_active_seconds,
                runs: if request.mode == TaskMode::Scheduled { vec![] } else { vec![new_run(request.thread_id, now())] },
                messages: vec![],
            };
            let result = summary(&task);
            let task_id = task.id.clone();
            candidate.tasks.insert(task_id.clone(), task);
            remember(&mut candidate, owner, "create", request.request_id, hash, result.clone());
            engine.save_tasks(&mut state, candidate, &task_id).await?;
            drop(state);
            engine.start_task_scheduler();
            engine.wake_tasks();
            Ok(result)
        }).await
    }

    pub async fn task_control(
        self: &Arc<Self>,
        owner: String,
        action: String,
        request: TaskControl,
    ) -> Result<Value> {
        self.mutate(move |engine| async move {
            let _gate = engine.desktop.lifecycle.gate.lock().await;
            let hash = desktop::digest(&request)?;
            let mut state = engine.task_modes.state.lock().await;
            if let Some(value) = receipt(&state, &owner, &action, &request.request_id, &hash)? {
                return Ok(value);
            }
            let mut candidate = state.clone();
            let task = candidate
                .tasks
                .get_mut(&request.task_id)
                .ok_or(Error::NotFound)?;
            if task.revision != request.expected_revision || task.cancelled {
                return Err(Error::Conflict);
            }
            match action.as_str() {
                "pause" => task.paused = true,
                "resume" => {
                    if task.next_run_at.is_none()
                        && task.runs.last().is_some_and(|r| r.status.terminal())
                    {
                        return Err(Error::Conflict);
                    }
                    if !engine.accepting_work() {
                        return Err(Error::Closed);
                    }
                    task.paused = false;
                    if let Some(run) = task.runs.last_mut()
                        && !run.status.terminal()
                        && run.goal_id.is_some()
                    {
                        run.status = RunStatus::Running;
                        run.reason = Some("resumeRequested".into());
                    }
                }
                "cancel" => {
                    task.cancelled = true;
                    task.next_run_at = None;
                }
                _ => return Err(invalid("unknown task action")),
            }
            task.revision += 1;
            let result = summary(task);
            remember(
                &mut candidate,
                owner,
                &action,
                request.request_id,
                hash,
                result.clone(),
            );
            engine
                .save_tasks(&mut state, candidate, &request.task_id)
                .await?;
            drop(state);
            engine.start_task_scheduler();
            engine.wake_tasks();
            Ok(result)
        })
        .await
    }

    /// Goal 受理与独立任务登记采用持久意图关联；调度器不会重放已有 Goal。
    pub(super) async fn bind_goal_task(
        &self,
        owner: &str,
        request_id: &str,
        goal: &Goal,
    ) -> Result<(String, String)> {
        let mut state = self.task_modes.state.lock().await;
        let mut candidate = state.clone();
        if candidate.tasks.values().any(|t| {
            (t.paused || t.cancelled)
                && t.runs
                    .iter()
                    .any(|r| format!("task-run-{}", r.id) == request_id)
        }) {
            return Err(Error::Conflict);
        }
        let found = candidate.tasks.values_mut().find_map(|t| {
            let task_id = t.id.clone();
            t.runs
                .iter_mut()
                .find(|r| {
                    format!("task-run-{}", r.id) == request_id
                        || r.goal_id.as_deref() == Some(&goal.id)
                })
                .map(|r| (task_id, r))
        });
        let (task_id, run_id) = if let Some((task_id, run)) = found {
            run.goal_id = Some(goal.id.clone());
            run.thread_id = Some(goal.thread_id.clone());
            run.status = RunStatus::Running;
            (task_id, run.id.clone())
        } else {
            if candidate.tasks.len() >= MAX_TASKS {
                return Err(Error::Exhausted("task capacity reached".into()));
            }
            let task_id = goal.id.clone();
            let run_id = id();
            let mut run = new_run(Some(goal.thread_id.clone()), now());
            run.id = run_id.clone();
            run.goal_id = Some(goal.id.clone());
            run.status = RunStatus::Running;
            candidate.tasks.insert(
                task_id.clone(),
                Task {
                    id: task_id.clone(),
                    revision: 1,
                    channel_sequence: 0,
                    owner: owner.into(),
                    mode: TaskMode::Foreground,
                    interaction_mode: goal.interaction_mode,
                    objective: goal.objective.clone(),
                    thread_id: Some(goal.thread_id.clone()),
                    schedule: None,
                    next_run_at: None,
                    paused: false,
                    cancelled: false,
                    token_budget: goal.token_budget,
                    max_turns: Some(goal.max_turns),
                    max_active_seconds: Some(goal.max_active_seconds),
                    runs: vec![run],
                    messages: vec![],
                },
            );
            (task_id, run_id)
        };
        candidate.tasks.get_mut(&task_id).unwrap().revision += 1;
        self.save_tasks(&mut state, candidate, &task_id).await?;
        Ok((task_id, run_id))
    }

    pub(crate) async fn task_allows_continuation(&self, thread: &Thread) -> bool {
        let Some(goal) = thread.goals.goal.as_ref() else {
            return true;
        };
        self.task_modes
            .state
            .lock()
            .await
            .tasks
            .values()
            .find_map(|t| {
                t.runs
                    .iter()
                    .find(|r| r.goal_id.as_deref() == Some(&goal.id))
                    .map(|r| !t.paused && !t.cancelled && !r.wait_requested)
            })
            .unwrap_or(true)
    }

    pub(crate) async fn task_active_count(&self) -> usize {
        self.task_modes
            .state
            .lock()
            .await
            .tasks
            .values()
            .filter(|t| {
                !t.cancelled
                    && !t.paused
                    && (t.next_run_at.is_some()
                        || t.runs.iter().any(|r| {
                            matches!(
                                r.status,
                                RunStatus::Queued
                                    | RunStatus::Running
                                    | RunStatus::WaitingForInput
                                    | RunStatus::WaitingForAgents
                            )
                        }))
            })
            .count()
    }

    pub(crate) async fn task_wait_state(&self, thread: &Thread) -> (bool, bool) {
        let Some(goal) = thread.goals.goal.as_ref() else {
            return (false, false);
        };
        self.task_modes
            .state
            .lock()
            .await
            .tasks
            .values()
            .find_map(|t| {
                t.runs
                    .iter()
                    .find(|r| r.goal_id.as_deref() == Some(&goal.id))
                    .map(|r| {
                        let agents = r.wait_requested && r.workers.iter().any(|w| !w.settled);
                        (r.wait_requested && !agents, agents)
                    })
            })
            .unwrap_or((false, false))
    }

    pub(crate) async fn ensure_goal_task(&self, owner: &str, goal: &Goal) -> Result<()> {
        if !self.task_modes.state.lock().await.tasks.values().any(|t| {
            t.runs
                .iter()
                .any(|r| r.goal_id.as_deref() == Some(&goal.id))
        }) {
            self.bind_goal_task(owner, "", goal).await?;
        }
        Ok(())
    }

    pub(crate) async fn task_goal_can_resume(&self, goal_id: &str) -> bool {
        !self
            .task_modes
            .state
            .lock()
            .await
            .tasks
            .values()
            .any(|t| t.cancelled && t.runs.iter().any(|r| r.goal_id.as_deref() == Some(goal_id)))
    }

    pub(crate) async fn task_goal_can_reopen(&self, goal_id: &str) -> bool {
        // 历史定时运行不能重新激活并改写另一轮的调度/额度。
        self.task_modes
            .state
            .lock()
            .await
            .tasks
            .values()
            .find(|t| t.runs.iter().any(|r| r.goal_id.as_deref() == Some(goal_id)))
            .is_none_or(|t| {
                !t.cancelled
                    && t.mode != TaskMode::Scheduled
                    && t.runs
                        .last()
                        .is_some_and(|r| r.goal_id.as_deref() == Some(goal_id))
            })
    }

    pub(crate) async fn sync_goal_task_control(
        &self,
        thread: &Thread,
        goal_id: &str,
        action: &str,
        previous_goal: Option<&Goal>,
    ) -> Result<()> {
        let mut state = self.task_modes.state.lock().await;
        let mut candidate = state.clone();
        let Some(task) = candidate
            .tasks
            .values_mut()
            .find(|t| t.runs.iter().any(|r| r.goal_id.as_deref() == Some(goal_id)))
        else {
            return Ok(());
        };
        if action == "resume" && task.cancelled {
            return Err(Error::Conflict);
        }
        match action {
            "update"
                if previous_goal.is_some_and(|g| g.status == GoalStatus::Completed)
                    && thread
                        .goals
                        .goal
                        .as_ref()
                        .is_some_and(|g| g.status == GoalStatus::Paused) =>
            {
                task.paused = true;
                let run = task
                    .runs
                    .iter_mut()
                    .find(|r| r.goal_id.as_deref() == Some(goal_id))
                    .unwrap();
                run.status = RunStatus::Paused;
                run.reason = Some("repairRequested".into());
                run.completed_at = None;
                run.wait_requested = false;
            }
            "pause" => task.paused = true,
            "resume" => {
                task.paused = false;
                task.runs.last_mut().unwrap().wait_requested = false;
            }
            "clear" => {
                let run = task
                    .runs
                    .iter_mut()
                    .find(|r| r.goal_id.as_deref() == Some(goal_id))
                    .unwrap();
                if !run.status.terminal() {
                    run.status = match previous_goal.map(|g| &g.status) {
                        Some(GoalStatus::Completed) => RunStatus::Completed,
                        Some(GoalStatus::Failed) => RunStatus::Failed,
                        _ => RunStatus::Cancelled,
                    };
                    if let Some(goal) = previous_goal {
                        run.usage = goal.usage.clone();
                    }
                    run.completed_at = Some(now());
                }
                for m in &mut task.messages {
                    if m.run_id == run.id && m.status == "pending" {
                        m.status = "cancelled".into();
                        task.channel_sequence += 1;
                        m.sequence = task.channel_sequence;
                    }
                }
            }
            _ => {}
        }
        if let Some(goal) = thread.goals.goal.as_ref() {
            task.objective = goal.objective.clone();
            task.max_turns = Some(goal.max_turns);
            task.max_active_seconds = Some(goal.max_active_seconds);
            if task.mode != TaskMode::Scheduled {
                task.token_budget = goal.token_budget;
            }
        }
        task.revision += 1;
        let id = task.id.clone();
        self.save_tasks(&mut state, candidate, &id).await?;
        self.wake_tasks();
        Ok(())
    }

    pub(crate) async fn drain_task_modes(&self) -> Result<()> {
        let mut state = self.task_modes.state.lock().await;
        let ids: Vec<_> = state.tasks.keys().cloned().collect();
        for id in ids {
            if state.tasks[&id].paused || state.tasks[&id].cancelled {
                continue;
            }
            let mut candidate = state.clone();
            let task = candidate.tasks.get_mut(&id).unwrap();
            task.paused = true;
            task.revision += 1;
            self.save_tasks(&mut state, candidate, &id).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod repair_tests {
    use super::*;
    struct NoRequests;
    #[async_trait::async_trait]
    impl crate::model::Model for NoRequests {
        fn name(&self) -> &str {
            "repair-admission"
        }
        async fn stream(
            &self,
            _: Vec<crate::model::Message>,
        ) -> anyhow::Result<crate::model::ModelStream> {
            unreachable!()
        }
    }

    #[tokio::test]
    async fn repair_admission_does_not_revive_cancelled_scheduled_or_historical_task_runs() {
        use areal_protocol::tasks::{Task, TaskMode};
        let dir = tempfile::tempdir().unwrap();
        let e = Engine::open(dir.path(), Arc::new(NoRequests), Limits::default()).unwrap();
        let mut task:Task=serde_json::from_value(json!({
        "id":"task","revision":1,"channelSequence":0,"owner":"test","mode":"background",
        "interactionMode":"headless","objective":"repair","paused":true,"cancelled":false,
        "runs":[{"id":"run","goalId":"goal","status":"completed","scheduledAt":1,"completedAt":2,"usage":areal_protocol::goals::GoalUsage::default(),"waitRequested":false}],"messages":[]
    })).unwrap();
        e.task_modes
            .state
            .lock()
            .await
            .tasks
            .insert(task.id.clone(), task.clone());
        assert!(e.task_goal_can_reopen("goal").await);
        task.cancelled = true;
        e.task_modes
            .state
            .lock()
            .await
            .tasks
            .insert(task.id.clone(), task.clone());
        assert!(!e.task_goal_can_reopen("goal").await);
        task.cancelled = false;
        task.mode = TaskMode::Scheduled;
        e.task_modes
            .state
            .lock()
            .await
            .tasks
            .insert(task.id.clone(), task.clone());
        assert!(!e.task_goal_can_reopen("goal").await);
        task.mode = TaskMode::Background;
        let mut later = task.runs[0].clone();
        later.id = "later".into();
        later.goal_id = Some("later-goal".into());
        task.runs.push(later);
        e.task_modes
            .state
            .lock()
            .await
            .tasks
            .insert(task.id.clone(), task);
        assert!(!e.task_goal_can_reopen("goal").await);
        assert!(e.task_goal_can_reopen("later-goal").await);
        e.shutdown().await;
    }
}
