//! 任务身份与通信独立持久化；执行继续复用 Goal、Thread 和 Runtime 的准入边界。
mod catalog;
mod channel;
pub use catalog::{
    PublishedTaskCatalog, PublishedTaskCatalogFallback, read_published_task_catalog,
};
mod ledger;
#[cfg(feature = "test-support")]
pub use ledger::TaskCommitFault;
mod delegations;
mod desktop_schedules;
mod schedule_tools;
pub(crate) use schedule_tools::definitions as schedule_tool_definitions;
#[cfg(test)]
mod desktop_schedules_tests;

mod overview;
mod schedule;
mod scheduler;
mod workers;
use super::*;
use areal_protocol::{desktop::RequestReceipt, goals::*, tasks::*};
use serde::{Deserialize, Serialize};
use std::sync::atomic::AtomicBool;

pub enum TaskRunNowAdmission {
    Accepted(TaskRunNowAccepted),
    ActiveRun {
        task_id: String,
        run_id: String,
        revision: u64,
    },
}

const MAX_TASKS: usize = 1024;
const MAX_RUNS: usize = 128;
const MAX_MESSAGES: usize = 1024;
const MAX_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Default, Serialize, Deserialize)]
struct Snapshot {
    version: u32,
    tasks: BTreeMap<String, Task>,
    receipts: Vec<RequestReceipt>,
    #[serde(default)]
    preparations: BTreeMap<String, areal_protocol::desktop::ThreadStart>,
    #[serde(skip)]
    catalog: ledger::Catalog,
    #[serde(skip)]
    root: std::path::PathBuf,
    #[cfg(feature = "test-support")]
    #[serde(skip)]
    fault: Arc<std::sync::Mutex<Option<TaskCommitFault>>>,
}

pub(crate) struct Tasks {
    state: Mutex<Snapshot>,
    events: broadcast::Sender<Value>,
    changed: Arc<tokio::sync::Notify>,
    started: AtomicBool,
    #[cfg(feature = "test-support")]
    clock: std::sync::atomic::AtomicI64,
    frozen: AtomicBool,
    hosts: Mutex<BTreeMap<String, Arc<dyn tools::DynamicToolHost>>>,
    dispatching: Arc<std::sync::Mutex<HashSet<String>>>,
}

impl Tasks {
    pub(crate) fn open(root: &Path, store: &crate::store::Store) -> anyhow::Result<Self> {
        let mut state = Snapshot::open(root, store)?;
        state.restore_runs();
        Ok(Self {
            hosts: Mutex::new(BTreeMap::new()),
            dispatching: Arc::new(std::sync::Mutex::new(HashSet::new())),
            state: Mutex::new(state),
            events: broadcast::channel(256).0,
            changed: Arc::new(tokio::sync::Notify::new()),
            started: AtomicBool::new(false),
            #[cfg(feature = "test-support")]
            clock: std::sync::atomic::AtomicI64::new(-1),
            frozen: AtomicBool::new(false),
        })
    }
}

impl Snapshot {
    fn restore_runs(&mut self) {
        let previous_version = self.version;
        self.version = 5;
        for task in self.tasks.values_mut() {
            for run in &mut task.runs {
                if task.mode == TaskMode::Scheduled
                    && run.goal_id.is_none()
                    && !run.status.terminal()
                {
                    if run.objective.is_none() {
                        run.objective = Some(task.objective.clone());
                    }
                    if previous_version < 3 {
                        run.thread_id = None;
                    }
                }
                if matches!(
                    run.status,
                    RunStatus::Running | RunStatus::WaitingForInput | RunStatus::WaitingForAgents
                ) {
                    run.status = RunStatus::Paused;
                    if run.reason.as_deref() != Some("stopRequested") {
                        run.reason = Some("serverRestarted".into());
                    }
                    if task.mode != TaskMode::Scheduled {
                        task.paused = true;
                    }
                    task.revision += 1;
                }
            }
        }
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
    state.old_receipt(owner, method, request, hash)
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
        trigger: RunTrigger::Schedule,
        accepted_schedule: None,
        objective: None,
        started_at: None,
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
    value["runCount"] = json!(task.archived_run_count + task.runs.len() as u64);
    value["archivedRunCount"] = json!(task.archived_run_count);
    value["runsComplete"] = json!(task.archived_run_count == 0);
    value["pendingQuestions"] = json!(
        task.messages
            .iter()
            .filter(|m| m.kind == "question" && m.status == "pending")
            .count()
    );
    value
}

// Thread 与 Task 的所有权判断共用纯函数，防止观察和写准入漂移。
fn thread_ownership(
    thread: &Thread,
    tasks: &Snapshot,
    allowed: Option<&std::collections::BTreeSet<String>>,
) -> areal_protocol::desktop::ThreadOwnership {
    use areal_protocol::desktop::ThreadOwnership;
    let managed = thread.parent_thread_id.is_some()
        || thread.goal_owner.is_some()
        || thread.source == "nativeTaskAgent";
    let current_goal = thread.goals.goal.as_ref().filter(|goal| {
        goal.status == GoalStatus::Active || goal.settling || goal.active_turn_id.is_some()
    });
    let candidates = || {
        tasks.tasks.values().flat_map(|task| {
            task.runs
                .iter()
                .filter(|run| {
                    run.thread_id.as_deref() == Some(thread.id.as_str())
                        && (matches!(
                            run.status,
                            RunStatus::Queued
                                | RunStatus::Running
                                | RunStatus::WaitingForInput
                                | RunStatus::WaitingForAgents
                        ) || run.workers.iter().any(|worker| !worker.settled))
                })
                .map(move |run| (task, run))
        })
    };
    let run_owned = candidates().next().is_some();
    // 同一 Thread 可被多个 Task 预留；仅当前 Goal 的唯一 Run 或无 Goal 时的唯一候选可提供标识。
    let mut owners = candidates().filter(|(_, run)| {
        current_goal.is_none_or(|goal| run.goal_id.as_deref() == Some(goal.id.as_str()))
    });
    let owner = owners.next().filter(|_| owners.next().is_none());
    if let Some((task, run)) = owner {
        let sees = |id: &str| allowed.is_none_or(|ids| ids.contains(id));
        let visible = (allowed.is_none() || task.thread_id.as_deref().is_some_and(sees))
            && run.thread_id.as_deref().is_none_or(sees);
        return ThreadOwnership::Task {
            task_id: visible.then(|| task.id.clone()),
            run_id: visible.then(|| run.id.clone()),
        };
    }
    if managed || current_goal.is_some() || run_owned {
        ThreadOwnership::Task {
            task_id: None,
            run_id: None,
        }
    } else {
        ThreadOwnership::Ordinary
    }
}

// 保留 Task 预留锁直到普通 Turn 持久化并激活，或观察快照和订阅完成。
pub(super) struct OrdinaryAdmission<'a> {
    _tasks: tokio::sync::MutexGuard<'a, Snapshot>,
}

impl Engine {
    pub(super) async fn ownership_and_lock(
        &self,
        thread: &Thread,
        allowed: Option<&std::collections::BTreeSet<String>>,
    ) -> (
        areal_protocol::desktop::ThreadOwnership,
        OrdinaryAdmission<'_>,
    ) {
        let tasks = self.task_modes.state.lock().await;
        let ownership = thread_ownership(thread, &tasks, allowed);
        (ownership, OrdinaryAdmission { _tasks: tasks })
    }

    pub(crate) async fn conversation_reference_available(&self, thread: &Thread) -> Result<bool> {
        if thread.is_side()
            || thread.parent_thread_id.is_some()
            || thread.goal_owner.is_some()
            || thread.source == "nativeTaskAgent"
            || thread.desktop.as_ref().is_some_and(|desktop| {
                desktop
                    .configuration
                    .options
                    .append_instructions
                    .starts_with("AREAL_TASK_DRAFT_V1\n")
            })
        {
            return Ok(false);
        }
        let tasks = self.task_modes.state.lock().await;
        if thread_ownership(thread, &tasks, None)
            != areal_protocol::desktop::ThreadOwnership::Ordinary
        {
            return Ok(false);
        }
        if tasks.tasks.values().any(|task| {
            task.mode == TaskMode::Scheduled
                && (task.thread_id.as_deref() == Some(thread.id.as_str())
                    || task
                        .runs
                        .iter()
                        .any(|run| run.thread_id.as_deref() == Some(thread.id.as_str())))
        }) {
            return Ok(false);
        }
        for task in tasks
            .tasks
            .values()
            .filter(|task| task.mode == TaskMode::Scheduled)
        {
            let mut scheduled = false;
            tasks.visit_history(&task.id, |segment| {
                scheduled |= segment
                    .runs
                    .iter()
                    .any(|run| run.thread_id.as_deref() == Some(thread.id.as_str()));
                Ok(())
            })?;
            if scheduled {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub(super) async fn ordinary_admission(
        &self,
        thread: &Thread,
    ) -> Result<OrdinaryAdmission<'_>> {
        let (ownership, guard) = self.ownership_and_lock(thread, None).await;
        if ownership != areal_protocol::desktop::ThreadOwnership::Ordinary {
            return Err(Error::Conflict);
        }
        Ok(guard)
    }

    async fn save_tasks(
        &self,
        state: &mut Snapshot,
        candidate: Snapshot,
        task_id: &str,
        retain_history: bool,
    ) -> Result<()> {
        if self.task_modes.frozen.load(Ordering::Acquire) {
            return Err(Error::Storage(
                "Task persistence requires restart and durable reconciliation".into(),
            ));
        }
        let mut candidate = candidate;
        let result = if retain_history {
            let eligible = candidate.archiveable_ids(&self.store, Some(task_id));
            candidate.compact(&eligible, Some(task_id))
        } else {
            Ok(())
        };
        if let Err(error) = result.and_then(|_| candidate.persist(Some(state), Some(task_id))) {
            if matches!(error, Error::Storage(_)) {
                self.task_modes.frozen.store(true, Ordering::Release);
                return Err(Error::Storage(format!(
                    "Task persistence requires restart and durable reconciliation: {error}"
                )));
            }
            return Err(error);
        }
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
        self.task_snapshot_and_subscribe_for_threads(task_id, None)
            .await
    }
    pub async fn task_snapshot_and_subscribe_for_threads(
        &self,
        task_id: &str,
        allowed: Option<&std::collections::BTreeSet<String>>,
    ) -> Result<(Value, broadcast::Receiver<Value>)> {
        let (state, events) = {
            let state = self.task_modes.state.lock().await;
            (state.clone(), self.task_modes.events.subscribe())
        };
        if !state.visible(task_id, allowed)? {
            return Err(invalid("TASK_PERMISSION_DENIED"));
        }
        let task = state.tasks.get(task_id).ok_or(Error::NotFound)?;
        Ok((summary(task), events))
    }

    pub async fn task_create(
        self: &Arc<Self>,
        owner: String,
        request: TaskCreate,
    ) -> Result<Value> {
        self.mutate(move |engine| async move {
            let _gate = engine.desktop.lifecycle.gate.lock().await;
            let hash = desktop::digest(&request)?;
            {
                let state = engine.task_modes.state.lock().await;
                if let Some(result) = receipt(&state, &owner, "create", &request.request_id, &hash)? { return Ok(result); }
            }
            if !engine.accepting_work() { return Err(Error::Closed); }
            if request.objective.trim().is_empty() || request.objective.chars().count() > 4000 {
                return Err(invalid("objective must contain 1..4000 characters"));
            }
            if request.token_budget == Some(0)
                || request.max_turns.is_some_and(|n| n == 0 || (engine.limits.goals.max_turns > 0 && n > engine.limits.goals.max_turns))
                || request.max_active_seconds.is_some_and(|n| n == 0 || tokio::time::Instant::now().checked_add(Duration::from_secs(n)).is_none() || (engine.limits.goals.max_active_seconds > 0 && n > engine.limits.goals.max_active_seconds)) {
                return Err(invalid("task budgets exceed deployment limits"));
            }
            if request.mode != TaskMode::Background && request.thread_id.is_none() {
                return Err(invalid("foreground and scheduled tasks require threadId"));
            }
            if (request.mode == TaskMode::Scheduled) != (request.schedule.is_some() || request.schedule_v2.is_some())
                || (request.schedule.is_some() && request.schedule_v2.is_some())
                || request.schedule.as_ref().is_some_and(|s| s.at < 0 || s.interval_seconds.is_some_and(|n| !(1..=31_536_000).contains(&n))) {
                return Err(invalid("scheduled tasks require a UTC timestamp and optional intervalSeconds in 1..31536000"));
            }
            if let Some(thread) = &request.thread_id {
                let cell = engine.cell(thread).await?;
                let state = cell.state.lock().await;
                if state.thread.parent_thread_id.is_some() || state.thread.goal_owner.is_some() { return Err(invalid("task binding requires a root Thread")); }
                if request.mode == TaskMode::Background && !state.thread.dynamic_tools.is_empty() { return Err(invalid("detached tasks require server-owned tools")); }
            }
            if request.mode == TaskMode::Background && request.interaction_mode == Some(InteractionMode::Interactive) { return Err(invalid("detached tasks require asynchronous or headless interactions")); }
            engine.validate_schedule_source(&owner, &request).await?;
            let mut state = engine.task_modes.state.lock().await;
            if let Some(result) = receipt(&state, &owner, "create", &request.request_id, &hash)? { return Ok(result); }
            let captured_now = engine.schedule_now();
            let schedule_v2 = request.schedule_v2.map(|input| schedule::resolve(input, captured_now)).transpose()?;
            let next_run_at = if let Some(value) = &schedule_v2 { Some(schedule::Plan::versioned(value)?.first(captured_now, false)?) } else { request.schedule.as_ref().map(|s|s.at) };
            if state.tasks.len() >= MAX_TASKS { return Err(Error::Exhausted("task capacity reached".into())); }
            let mut candidate = state.clone();
            let task = Task {
                source_thread_id: request.source_thread_id, deleted_at: None,
                run_count: 0, archived_run_count: 0, runs_complete: true,
                skipped_runs: 0, last_skipped_at: None,
                id: id(), revision: 1, channel_sequence: 0, owner: owner.clone(), mode: request.mode,
                interaction_mode: if request.mode == TaskMode::Scheduled { InteractionMode::Interactive } else { request.interaction_mode.unwrap_or(match request.mode {
                    TaskMode::Foreground => InteractionMode::Interactive,
                    TaskMode::Background => InteractionMode::Asynchronous,
                    TaskMode::Scheduled => InteractionMode::Interactive,
                }) }, objective: request.objective, thread_id: request.thread_id.clone(),
                next_run_at, schedule: request.schedule, schedule_v2, last_trigger_decision: None,
                paused: false, cancelled: false, token_budget: request.token_budget,
                max_turns: request.max_turns, max_active_seconds: request.max_active_seconds,
                runs: if request.mode == TaskMode::Scheduled { vec![] } else { vec![new_run(request.thread_id, now())] },
                messages: vec![],
            };
            let result = summary(&task);
            let task_id = task.id.clone();
            candidate.tasks.insert(task_id.clone(), task);
            remember(&mut candidate, owner, "create", request.request_id, hash, result.clone());
            engine.save_tasks(&mut state, candidate, &task_id,true).await?;
            drop(state);
            engine.start_task_scheduler();
            engine.wake_tasks();
            Ok(result)
        }).await
    }

    pub async fn task_update(
        self: &Arc<Self>,
        owner: String,
        request: TaskUpdate,
    ) -> Result<Value> {
        self.task_update_for_threads(owner, request, None).await
    }
    pub async fn task_update_for_threads(
        self: &Arc<Self>,
        owner: String,
        request: TaskUpdate,
        allowed: Option<&std::collections::BTreeSet<String>>,
    ) -> Result<Value> {
        let authorized_revision = if allowed.is_some() {
            Some(
                self.task_read_for_threads(&request.task_id, allowed)
                    .await?
                    .revision,
            )
        } else {
            None
        };
        self.mutate(move |engine| async move {
            let _gate = engine.desktop.lifecycle.gate.lock().await;
            let hash = desktop::digest(&request)?;
            let mut state = engine.task_modes.state.lock().await;
            if let Some(value) = receipt(&state, &owner, "update", &request.request_id, &hash)? {
                return Ok(value);
            }
            if authorized_revision.is_some_and(|revision|state.tasks.get(&request.task_id).is_none_or(|task|task.revision!=revision)) {return Err(Error::Conflict);}
            if !engine.accepting_work() { return Err(Error::Closed); }
            if request.objective.is_none() && request.schedule.is_none() && request.schedule_v2.is_none() {
                return Err(invalid("provide an objective or schedule to update"));
            }
            if request.objective.as_ref().is_some_and(|s| s.trim().is_empty() || s.chars().count() > 4000) {
                return Err(invalid("objective must contain 1..4000 characters"));
            }
            let captured_now = engine.schedule_now();
            if request.schedule.is_some() && request.schedule_v2.is_some() { return Err(invalid("provide exactly one schedule")); }
            let schedule_v2 = request.schedule_v2.map(|input| schedule::resolve(input,captured_now)).transpose()?;
            let next_v2 = schedule_v2.as_ref().map(|value|schedule::Plan::versioned(value)?.first(captured_now,true)).transpose()?;
            if request.schedule.as_ref().is_some_and(|s| s.at <= captured_now || s.interval_seconds.is_some_and(|n| !(1..=31_536_000).contains(&n))) {
                return Err(invalid("schedule requires a future UTC timestamp and optional intervalSeconds in 1..31536000"));
            }
            let mut candidate = state.clone();
            let task = candidate.tasks.get_mut(&request.task_id).ok_or(Error::NotFound)?;
            if task.revision != request.expected_revision || task.cancelled || task.mode != TaskMode::Scheduled {
                return Err(Error::Conflict);
            }
            if let Some(objective) = request.objective { task.objective = objective; }
            if let Some(schedule) = request.schedule {
                task.next_run_at = Some(schedule.at);
                task.schedule = Some(schedule);
                task.schedule_v2 = None;
            }
            if let Some(schedule) = schedule_v2 {task.schedule_v2 = Some(schedule);task.schedule = None;task.next_run_at=next_v2;}
            task.revision += 1;
            let result = summary(task);
            remember(&mut candidate, owner, "update", request.request_id, hash, result.clone());
            engine.save_tasks(&mut state, candidate, &request.task_id,true).await?;
            drop(state);
            engine.start_task_scheduler();
            engine.wake_tasks();
            Ok(result)
        }).await
    }

    pub async fn task_run_now(
        self: &Arc<Self>,
        owner: String,
        request: TaskRunNow,
    ) -> Result<TaskRunNowAdmission> {
        self.task_run_now_for_threads(owner, request, None).await
    }

    pub async fn task_run_now_for_threads(
        self: &Arc<Self>,
        owner: String,
        request: TaskRunNow,
        allowed: Option<&std::collections::BTreeSet<String>>,
    ) -> Result<TaskRunNowAdmission> {
        let task = self
            .task_read_for_threads(&request.task_id, allowed)
            .await?;
        if allowed.is_some() {
            return Err(invalid("TASK_PERMISSION_DENIED"));
        }
        self.mutate(move |engine| async move {
            let host = engine.schedule_host(&task.owner).await;
            let _gate = engine.desktop.lifecycle.gate.lock().await;
            let hash = desktop::digest(&request)?;
            let mut state = engine.task_modes.state.lock().await;
            if let Some(value) = receipt(&state, &owner, "runNow", &request.request_id, &hash)? {
                return Ok(TaskRunNowAdmission::Accepted(
                    serde_json::from_value(value).map_err(invalid)?,
                ));
            }
            if !engine.accepting_work() {
                return Err(Error::Closed);
            }
            let mut candidate = state.clone();
            let task = candidate
                .tasks
                .get_mut(&request.task_id)
                .ok_or(Error::NotFound)?;
            if task.cancelled || task.mode != TaskMode::Scheduled {
                return Err(Error::Conflict);
            }
            if let Some(run) = task.runs.iter().find(|run| !run.status.terminal()) {
                return Ok(TaskRunNowAdmission::ActiveRun {
                    task_id: task.id.clone(),
                    run_id: run.id.clone(),
                    revision: task.revision,
                });
            }
            if task.revision != request.expected_revision {
                return Err(Error::Conflict);
            }
            if host.as_ref().is_none_or(|host| host.is_closed()) {
                return Err(invalid("scheduled task Host is unavailable"));
            }
            let mut run = new_run(None, engine.schedule_now());
            run.trigger = RunTrigger::Manual;
            run.accepted_schedule = Some(AcceptedSchedule {
                task_revision: task.revision,
                schedule: task.schedule.clone(),
                schedule_v2: task.schedule_v2.clone(),
                decision: None,
            });
            run.objective = Some(task.objective.clone());
            task.revision += 1;
            let accepted = TaskRunNowAccepted {
                task_id: task.id.clone(),
                run_id: run.id.clone(),
                revision: task.revision,
                accepted: true,
            };
            task.runs.push(run);
            remember(
                &mut candidate,
                owner,
                "runNow",
                request.request_id,
                hash,
                json!(accepted),
            );
            engine
                .save_tasks(&mut state, candidate, &request.task_id, true)
                .await?;
            drop(state);
            engine.start_task_scheduler();
            engine.wake_tasks();
            Ok(TaskRunNowAdmission::Accepted(accepted))
        })
        .await
    }

    pub async fn task_run_now_receipt_for_threads(
        &self,
        owner: &str,
        request: TaskRunNow,
        allowed: Option<&std::collections::BTreeSet<String>>,
    ) -> Result<Value> {
        let state = self.task_modes.state.lock().await;
        if !state.visible(&request.task_id, allowed)? {
            return Err(invalid("TASK_PERMISSION_DENIED"));
        }
        let hash = desktop::digest(&request)?;
        let result = receipt(&state, owner, "runNow", &request.request_id, &hash)?
            .map(serde_json::from_value::<TaskRunNowAccepted>)
            .transpose()
            .map_err(invalid)?;
        if result
            .as_ref()
            .is_some_and(|result| result.task_id != request.task_id)
        {
            return Err(Error::Conflict);
        }
        let records: Vec<_> = result.into_iter().map(|result| json!({
            "identity":owner,"requestId":request.request_id,"method":"areal/task/runNow","digest":hash,"result":result
        })).collect();
        Ok(json!({"data":records,"retention":"taskLifetime"}))
    }

    pub async fn task_control(
        self: &Arc<Self>,
        owner: String,
        action: String,
        request: TaskControl,
    ) -> Result<Value> {
        self.task_control_for_threads(owner, action, request, None)
            .await
    }
    pub async fn task_control_for_threads(
        self: &Arc<Self>,
        owner: String,
        action: String,
        request: TaskControl,
        allowed: Option<&std::collections::BTreeSet<String>>,
    ) -> Result<Value> {
        let authorized_revision = if allowed.is_some() {
            Some(
                self.task_read_for_threads(&request.task_id, allowed)
                    .await?
                    .revision,
            )
        } else {
            None
        };
        self.mutate(move |engine| async move {
            let _gate = engine.desktop.lifecycle.gate.lock().await;
            let hash = desktop::digest(&request)?;
            let mut state = engine.task_modes.state.lock().await;
            if let Some(value) = receipt(&state, &owner, &action, &request.request_id, &hash)? {
                return Ok(value);
            }
            if authorized_revision.is_some_and(|revision| {
                state
                    .tasks
                    .get(&request.task_id)
                    .is_none_or(|task| task.revision != revision)
            }) {
                return Err(Error::Conflict);
            }
            if request.expected_run_id.is_some()
                && !matches!(action.as_str(), "pause" | "stopRun" | "resumeRun")
            {
                return Err(invalid(
                    "expectedRunId is supported only for pause, stopRun and resumeRun",
                ));
            }
            let mut candidate = state.clone();
            let task = candidate
                .tasks
                .get_mut(&request.task_id)
                .ok_or(Error::NotFound)?;
            if task.revision != request.expected_revision
                || (task.cancelled && action != "delete")
                || task.deleted_at.is_some()
            {
                return Err(Error::Conflict);
            }
            if request
                .expected_run_id
                .as_deref()
                .is_some_and(|expected| run_id(task) != Some(expected))
            {
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
                    if task.mode != TaskMode::Scheduled
                        && let Some(run) = task.runs.last_mut()
                        && !run.status.terminal()
                        && run.goal_id.is_some()
                    {
                        run.status = RunStatus::Running;
                        run.started_at.get_or_insert(now());
                        run.reason = Some("resumeRequested".into());
                    }
                }
                "stopRun" | "resumeRun" => {
                    if request.expected_run_id.is_none() {
                        return Err(invalid("expectedRunId required"));
                    }
                    let run = task.runs.last_mut().ok_or(Error::Conflict)?;
                    if task.mode != TaskMode::Scheduled || run.status.terminal() {
                        return Err(Error::Conflict);
                    }
                    if action == "resumeRun"
                        && (run.reason.as_deref() == Some("stopRequested")
                            || !matches!(run.status, RunStatus::Blocked | RunStatus::Paused))
                    {
                        return Err(Error::Conflict);
                    }
                    if action == "resumeRun" && !engine.accepting_work() {
                        return Err(Error::Closed);
                    }
                    if action == "resumeRun" && run.goal_id.is_none() {
                        run.status = RunStatus::Queued;
                        run.reason = None;
                    } else {
                        run.reason = Some(
                            if action == "stopRun" {
                                "stopRequested"
                            } else {
                                "resumeRequested"
                            }
                            .into(),
                        );
                    }
                }
                "cancel" | "delete" => {
                    if action == "delete" {
                        task.deleted_at = Some(now());
                    }
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
                .save_tasks(&mut state, candidate, &request.task_id, false)
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
        if state
            .cold_run(Some(&goal.id), request_id.strip_prefix("task-run-"))?
            .is_some()
        {
            return Err(Error::Conflict);
        }
        let mut candidate = state.clone();
        if candidate.tasks.values().any(|t| {
            ((t.paused && t.mode != TaskMode::Scheduled)
                || t.cancelled
                || t.runs
                    .last()
                    .is_some_and(|r| r.reason.as_deref() == Some("stopRequested")))
                && t.runs
                    .iter()
                    .any(|r| format!("task-run-{}", r.id) == request_id)
        }) {
            return Err(Error::Conflict);
        }
        if let Some(_task) = candidate.tasks.values().find(|t| {
            t.mode == TaskMode::Scheduled
                && t.runs
                    .iter()
                    .any(|r| format!("task-run-{}", r.id) == request_id)
        }) {
            let cell = self.raw_cell(&goal.thread_id).await?;
            let host = cell
                .bindings
                .read()
                .await
                .host
                .clone()
                .ok_or(Error::Conflict)?;
            if !self.host_current(&host).await {
                return Err(Error::Conflict);
            }
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
            run.started_at.get_or_insert(now());
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
                    source_thread_id: None,
                    deleted_at: None,
                    run_count: 0,
                    archived_run_count: 0,
                    runs_complete: true,
                    skipped_runs: 0,
                    last_skipped_at: None,
                    id: task_id.clone(),
                    revision: 1,
                    channel_sequence: 0,
                    owner: owner.into(),
                    mode: TaskMode::Foreground,
                    interaction_mode: goal.interaction_mode,
                    objective: goal.objective.clone(),
                    thread_id: Some(goal.thread_id.clone()),
                    schedule: None,
                    schedule_v2: None,
                    last_trigger_decision: None,
                    next_run_at: None,
                    paused: false,
                    cancelled: false,
                    token_budget: goal.token_budget,
                    max_turns: goal.max_turns,
                    max_active_seconds: goal.max_active_seconds,
                    runs: vec![run],
                    messages: vec![],
                },
            );
            (task_id, run_id)
        };
        candidate.tasks.get_mut(&task_id).unwrap().revision += 1;
        self.save_tasks(&mut state, candidate, &task_id, true)
            .await?;
        Ok((task_id, run_id))
    }

    pub(crate) async fn task_allows_continuation(&self, thread: &Thread) -> Result<bool> {
        if self.task_modes.frozen.load(Ordering::Acquire) {
            return Err(Error::Storage("Task persistence requires restart".into()));
        }
        let Some(goal) = thread.goals.goal.as_ref() else {
            return Ok(true);
        };
        let state = self.task_modes.state.lock().await;
        let Some(task) = state.tasks.values().find(|t| {
            t.runs
                .iter()
                .any(|r| r.goal_id.as_deref() == Some(&goal.id))
        }) else {
            return Ok(state.cold_run(Some(&goal.id), None)?.is_none());
        };
        let run = task
            .runs
            .iter()
            .find(|r| r.goal_id.as_deref() == Some(&goal.id))
            .unwrap();
        if task.cancelled
            || run.wait_requested
            || run.reason.as_deref() == Some("stopRequested")
            || (task.mode != TaskMode::Scheduled && task.paused)
        {
            return Ok(false);
        }
        if task.mode != TaskMode::Scheduled {
            return Ok(true);
        }
        if run.status.terminal()
            || run.reason.as_deref() == Some("stopRequested")
            || task.runs.last().is_none_or(|r| r.id != run.id)
        {
            return Ok(false);
        }
        if run.started_at.is_none() {
            return Ok(true);
        }
        let Ok(cell) = self.raw_cell(&thread.id).await else {
            return Ok(false);
        };
        let Some(host) = cell.bindings.read().await.host.clone() else {
            return Ok(false);
        };
        drop(state);
        Ok(self.host_current(&host).await)
    }

    pub(crate) async fn task_active_count(&self) -> usize {
        self.task_modes
            .state
            .lock()
            .await
            .tasks
            .values()
            .filter(|t| {
                let live_run = t.runs.iter().any(|r| {
                    matches!(
                        r.status,
                        RunStatus::Queued
                            | RunStatus::Running
                            | RunStatus::WaitingForInput
                            | RunStatus::WaitingForAgents
                    )
                });
                match t.mode {
                    // Future triggers are durable configuration. Drain closes
                    // admission and preserves schedules across a safe restart.
                    TaskMode::Scheduled => live_run,
                    TaskMode::Foreground | TaskMode::Background => {
                        !t.cancelled && !t.paused && (t.next_run_at.is_some() || live_run)
                    }
                }
            })
            .count()
    }

    pub(crate) async fn task_wait_state(&self, thread: &Thread) -> (bool, bool) {
        let Some(goal) = thread.goals.goal.as_ref() else {
            return (false, false);
        };
        let state = self.task_modes.state.lock().await;
        if let Some(run) = state
            .tasks
            .values()
            .flat_map(|t| &t.runs)
            .find(|r| r.goal_id.as_deref() == Some(&goal.id))
        {
            let agents = run.wait_requested && run.workers.iter().any(|w| !w.settled);
            return (run.wait_requested && !agents, agents);
        }
        match state.cold_run(Some(&goal.id), None) {
            Ok(None) => (false, false),
            Ok(Some(_)) => (true, false),
            Err(error) => {
                tracing::error!(%error,"Task wait provenance unavailable");
                (true, false)
            }
        }
    }

    pub(crate) async fn ensure_goal_task(&self, owner: &str, goal: &Goal) -> Result<()> {
        let state = self.task_modes.state.lock().await;
        if state.tasks.values().any(|t| {
            t.runs
                .iter()
                .any(|r| r.goal_id.as_deref() == Some(&goal.id))
        }) {
            return Ok(());
        }
        if state.cold_run(Some(&goal.id), None)?.is_some() {
            return Err(Error::Conflict);
        }
        drop(state);
        self.bind_goal_task(owner, "", goal).await?;
        Ok(())
    }

    pub(crate) async fn task_goal_control_current(
        &self,
        task_id: &str,
        revision: u64,
        request: &GoalControl,
        action: &str,
    ) -> bool {
        let state = self.task_modes.state.lock().await;
        state.tasks.get(task_id).is_some_and(|task| {
            task.revision == revision
                && task.runs.last().is_some_and(|run| {
                    run.thread_id.as_ref() == Some(&request.thread_id)
                        && run.goal_id.as_ref() == Some(&request.goal_id)
                        && match action {
                            "pause" => {
                                task.paused
                                    || task.cancelled
                                    || (task.mode == TaskMode::Scheduled
                                        && matches!(
                                            run.reason.as_deref(),
                                            Some("stopRequested" | "hostUnavailable")
                                        ))
                            }
                            "resume" => {
                                (task.mode == TaskMode::Scheduled || !task.paused)
                                    && !task.cancelled
                                    && run.reason.as_deref() == Some("resumeRequested")
                            }
                            _ => false,
                        }
                })
        })
    }

    pub(crate) async fn task_goal_can_resume(&self, goal_id: &str) -> Result<bool> {
        if self.task_modes.frozen.load(Ordering::Acquire) {
            return Err(Error::Storage("Task persistence requires restart".into()));
        }
        let state = self.task_modes.state.lock().await;
        let Some(task) = state
            .tasks
            .values()
            .find(|t| t.runs.iter().any(|r| r.goal_id.as_deref() == Some(goal_id)))
        else {
            return Ok(state.cold_run(Some(goal_id), None)?.is_none());
        };
        if task.cancelled {
            return Ok(false);
        }
        let run = task
            .runs
            .iter()
            .find(|r| r.goal_id.as_deref() == Some(goal_id))
            .unwrap();
        if task.mode != TaskMode::Scheduled {
            return Ok(true);
        }
        if run.status.terminal()
            || run.reason.as_deref() == Some("stopRequested")
            || task.runs.last().is_none_or(|r| r.id != run.id)
        {
            return Ok(false);
        }
        if run.started_at.is_none() {
            return Ok(true);
        }
        if run.reason.as_deref() != Some("resumeRequested") {
            return Ok(false);
        }
        let Some(thread) = &run.thread_id else {
            return Ok(false);
        };
        let Ok(cell) = self.raw_cell(thread).await else {
            return Ok(false);
        };
        let Some(host) = cell.bindings.read().await.host.clone() else {
            return Ok(false);
        };
        drop(state);
        Ok(self.host_current(&host).await)
    }

    pub(crate) async fn validate_prompt_limit_owner(&self, goal_id: &str) -> Result<()> {
        let state = self.task_modes.state.lock().await;
        let task_id = state
            .tasks
            .values()
            .find(|t| t.runs.iter().any(|r| r.goal_id.as_deref() == Some(goal_id)))
            .map(|t| t.id.clone())
            .or(state.cold_run(Some(goal_id), None)?.map(|(id, _)| id));
        if task_id
            .and_then(|id| state.tasks.get(&id))
            .is_some_and(|t| t.mode == TaskMode::Scheduled && t.token_budget.is_some())
        {
            return Err(invalid(
                "prompt limits cannot replace a recurring Task budget",
            ));
        }
        Ok(())
    }
    pub(crate) async fn validate_task_goal_budget(
        &self,
        goal_id: &str,
        requested: Option<u64>,
    ) -> Result<()> {
        let state = self.task_modes.state.lock().await;
        let hot = state.tasks.values().find_map(|t| {
            t.runs
                .iter()
                .find(|r| r.goal_id.as_deref() == Some(goal_id))
                .map(|r| (t.id.clone(), r.usage.clone()))
        });
        let binding = if let Some(hot) = hot {
            Some(hot)
        } else {
            state
                .cold_run(Some(goal_id), None)?
                .map(|(id, run)| (id, run.usage))
        };
        if let Some((task_id, current)) = binding {
            let task = &state.tasks[&task_id];
            if task.mode == TaskMode::Scheduled
                && let Some(total) = task.token_budget
            {
                let usage = state.usage(&task_id);
                let other = usage
                    .tokens_used
                    .saturating_add(usage.reserved_tokens)
                    .saturating_sub(current.tokens_used.saturating_add(current.reserved_tokens));
                if requested.is_none_or(|n| n > total.saturating_sub(other)) {
                    return Err(invalid("TASK_TOKEN_BUDGET"));
                }
            }
        }
        Ok(())
    }

    pub(crate) async fn sync_goal_task_control(
        &self,
        thread: &Thread,
        goal_id: &str,
        action: &str,
        previous_goal: Option<&Goal>,
    ) -> Result<()> {
        let mut state = self.task_modes.state.lock().await;
        if state.cold_run(Some(goal_id), None)?.is_some() {
            return Err(Error::Conflict);
        }
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
            "pause" => {
                if task.mode != TaskMode::Scheduled {
                    task.paused = true;
                }
            }
            "resume" => {
                if task.mode != TaskMode::Scheduled {
                    task.paused = false;
                }
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
            // 周期任务的下一次目标由 Task 管理；旧 Run 的 Goal 控制不能覆盖新计划。
            if task.mode != TaskMode::Scheduled {
                task.objective = goal.objective.clone();
            }
            if task.mode != TaskMode::Scheduled {
                task.max_turns = goal.max_turns;
                task.max_active_seconds = goal.max_active_seconds;
            }
            if task.mode != TaskMode::Scheduled {
                task.token_budget = goal.token_budget;
            }
        }
        task.revision += 1;
        let id = task.id.clone();
        self.save_tasks(&mut state, candidate, &id, true).await?;
        self.wake_tasks();
        Ok(())
    }

    pub(crate) async fn drain_task_modes(&self) -> Result<()> {
        let mut state = self.task_modes.state.lock().await;
        let ids: Vec<_> = state.tasks.keys().cloned().collect();
        for id in ids {
            if state.tasks[&id].mode == TaskMode::Scheduled
                || state.tasks[&id].paused
                || state.tasks[&id].cancelled
            {
                continue;
            }
            let mut candidate = state.clone();
            let task = candidate.tasks.get_mut(&id).unwrap();
            task.paused = true;
            task.revision += 1;
            self.save_tasks(&mut state, candidate, &id, true).await?;
        }
        Ok(())
    }
}

impl Engine {
    pub async fn task_receipts(&self, identity: &str, request_id: &str) -> Result<Vec<Value>> {
        let state = self.task_modes.state.lock().await;
        let mut receipts: Vec<_> = state
            .receipts
            .iter()
            .filter(|record| record.identity == identity && record.request_id == request_id)
            .cloned()
            .collect();
        for method in [
            "create",
            "update",
            "runNow",
            "pause",
            "resume",
            "cancel",
            "delete",
            "stopRun",
            "resumeRun",
            "reply",
        ] {
            if receipts.iter().any(|record| record.method == method) {
                continue;
            }
            if let Some(record) = state.stored_receipt(identity, method, request_id)? {
                receipts.push(record);
            }
        }
        Ok(receipts.iter().filter_map(|record| {
            let task_id = record.result.get("taskId").or_else(|| record.result.get("id"))?.as_str()?;
            let task = state.tasks.get(task_id)?;
            let method = if record.method == "reply" { "areal/channel/reply".into() } else { format!("areal/task/{}", record.method) };
            let mut value = json!(record);
            value["method"] = json!(method);
            value["taskId"] = json!(task_id);
            value["threadId"] = json!(task.thread_id);
            value["operation"] = json!({"requestId":record.request_id,"method":method,"target":{"kind":"task","taskId":task_id}});
            value["status"] = json!("completed");
            Some(value)
        }).collect())
    }
}
