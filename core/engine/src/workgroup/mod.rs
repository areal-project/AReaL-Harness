//! Core-owned task scheduling and verified artifact publication.
//!
//! Runtime executes operations; it never owns this task graph. Each attempt gets
//! an isolated binding. A worker's final text is not evidence of integration.
mod admission;
mod context;
mod control;
pub mod service;
pub(crate) mod tools;
pub use admission::AdmissionDecision;
pub use control::{Control, Revision};
pub mod native;
pub mod packing;
pub mod tree;

pub const MAX_TASKS: usize = 64;

use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use futures_util::FutureExt;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{task::JoinSet, time::Instant};
use tokio_util::sync::CancellationToken;
use tree::{Tree, compose, digest, materialize};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskConfiguration {
    pub agent_profile: Option<areal_protocol::desktop::VersionRef>,
    pub model: Option<areal_protocol::desktop::ModelRef>,
    pub skills: Option<Vec<areal_protocol::desktop::VersionRef>>,
    pub tool_allowlist: Option<Vec<String>>,
    #[serde(default)]
    pub read_only: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Task {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configuration: Option<TaskConfiguration>,
    pub id: String,
    pub instruction: String,
    pub writes: Vec<String>,
    #[serde(default)]
    pub depends: Vec<String>,
    /// These prerequisites block integration, but not execution. The instruction
    /// must describe the agreed interface; the final combined gate remains mandatory.
    #[serde(default)]
    pub integration_depends: Vec<String>,
    #[serde(default)]
    pub checks: Vec<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    pub objective: String,
    pub tasks: Vec<Task>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Strategy {
    Single,
    Contract,
    Cohesion,
    Balanced,
}

/// Fixed caps workers; Auto also bounds unverified work. Adaptive adjusts the
/// dispatch target inside that hard cap using measured local model pressure.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "lowercase")]
pub enum Admission {
    #[default]
    Fixed,
    Auto,
    Adaptive,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdmissionStats {
    pub policy: Admission,
    pub max_workers: usize,
    pub max_inflight: Option<usize>,
    pub peak_inflight: usize,
    pub peak_pending_verification: usize,
    #[serde(default)]
    pub initial_workers: usize,
    #[serde(default)]
    pub target_workers: usize,
    #[serde(default)]
    pub peak_target_workers: usize,
    #[serde(default)]
    pub decisions: Vec<AdmissionDecision>,
    #[serde(default)]
    pub omitted_decisions: usize,
}

#[derive(Clone, Debug)]
pub struct Options {
    pub workers: usize,
    pub admission: Admission,
    /// Adaptive starting target, clamped to the worker hard cap.
    pub initial_workers: usize,
    pub repairs: u32,
    pub timeout: Duration,
    pub strategy: Strategy,
    pub integration_repair: bool,
    /// Combine immediately available independent artifacts without waiting to fill a batch.
    pub verification_batch: usize,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            workers: 2,
            admission: Admission::Fixed,
            initial_workers: 2,
            repairs: 1,
            timeout: Duration::from_secs(600),
            strategy: Strategy::Balanced,
            integration_repair: true,
            verification_batch: 4,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Check {
    pub tree_hash: String,
    pub passed: bool,
    pub output: String,
}

/// A settled, scope-checked candidate after a classified inference failure.
/// Executors may return this only after all writers and tool outcomes settle.
/// Core still requires independent checks; it never treats this as completion.
#[derive(Debug, thiserror::Error)]
#[error("worker inference checkpoint: {failure}")]
pub struct AttemptCheckpoint {
    pub artifact: Tree,
    pub failure: crate::model::ModelFailure,
}

/// Cleanup could not establish that the owned Runtime released its resources.
/// This is never a recoverable inference checkpoint, including during drain.
#[derive(Debug, thiserror::Error)]
pub enum CleanupFailure {
    #[error("worker Runtime cleanup unconfirmed")]
    Worker,
    #[error("verification Runtime cleanup unconfirmed")]
    Verification,
}

#[async_trait]
pub trait Executor: Send + Sync + 'static {
    /// Adaptive admission requires local model-pool observations.
    fn model_load(&self) -> Option<crate::model::ModelLoad> {
        None
    }
    /// Return only after all writers and Runtime resources have settled.
    async fn attempt(
        &self,
        task: Task,
        generation: u32,
        base: Tree,
        seed: Option<Tree>,
        feedback: String,
        cancel: CancellationToken,
    ) -> Result<Tree>;
    async fn verify(
        &self,
        candidate: Tree,
        commands: Vec<Vec<String>>,
        cancel: CancellationToken,
    ) -> Result<Check>;
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    Ready,
    Running,
    Submitted,
    Validating,
    Integrated,
    Failed,
    Blocked,
    Unknown,
    Cancelled,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskState {
    pub spec: Task,
    pub generation: u32,
    pub status: TaskStatus,
    pub base: Option<String>,
    pub artifact: Option<String>,
    pub feedback: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub task: String,
    pub generation: u32,
    pub base: String,
    /// Unaccepted previous changes safely composed onto this attempt's base.
    #[serde(default)]
    pub seed: Option<String>,
    pub artifact: Option<String>,
    pub status: TaskStatus,
    pub started_seconds: f64,
    pub finished_seconds: Option<f64>,
    #[serde(default)]
    pub verification_started_seconds: Option<f64>,
    #[serde(default)]
    pub verification_finished_seconds: Option<f64>,
    pub check: Option<Check>,
    pub error: Option<String>,
    #[serde(default)]
    pub checkpoint: Option<crate::model::ModelFailure>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Verification {
    pub expected_head: String,
    pub members: Vec<(String, u32)>,
    pub check: Check,
    pub finished_seconds: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    #[serde(default)]
    pub authorized_directories: Vec<String>,
    #[serde(default)]
    pub authorized_writes: Vec<String>,
    pub version: u32,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub plan_revision: u64,
    #[serde(default)]
    pub revisions: BTreeMap<String, Revision>,
    pub objective: String,
    pub status: String,
    pub strategy: Strategy,
    pub tasks: Vec<TaskState>,
    pub history: Vec<Attempt>,
    /// Append-only receipts also retain failed batch checks before subdivision.
    #[serde(default)]
    pub verifications: Vec<Verification>,
    pub head: String,
    pub error: Option<String>,
    /// None in an unfinished or legacy record; never infer confirmation from exit.
    #[serde(default)]
    pub cleanup_confirmed: Option<bool>,
    #[serde(default)]
    pub cleanup_error: Option<String>,
    pub final_check: Option<Check>,
    #[serde(default)]
    pub final_checks: Vec<Check>,
    pub attempts: u32,
    pub conflicts: u32,
    pub repairs: u32,
    pub peak_workers: usize,
    #[serde(default)]
    pub admission: AdmissionStats,
    pub wall_seconds: f64,
}

fn bounded(text: &str) -> String {
    text.chars().take(8000).collect()
}

fn repair_seed(
    head: &Tree,
    base: &Tree,
    artifact: &Tree,
    writes: &[String],
) -> Result<Option<Tree>> {
    // Validate scope and integrity even when another writer now conflicts. Only
    // a concrete stale-file conflict permits dropping the unaccepted patch.
    compose(base, base, artifact, writes)?;
    for path in base.keys().chain(artifact.keys()) {
        if base.get(path) != artifact.get(path)
            && head.get(path) != base.get(path)
            && head.get(path) != artifact.get(path)
        {
            return Ok(None);
        }
    }
    let candidate = compose(head, base, artifact, writes)?;
    Ok((candidate != *head).then_some(candidate))
}

pub fn validate(plan: &Plan) -> Result<()> {
    ensure!(
        !plan.objective.trim().is_empty() && plan.objective.len() <= 32000,
        "invalid objective"
    );
    ensure!(
        !plan.tasks.is_empty() && plan.tasks.len() <= MAX_TASKS,
        "task count must be 1..64"
    );
    let mut ids = BTreeSet::new();
    for task in &plan.tasks {
        ensure!(
            !task.id.is_empty()
                && task.id.len() <= 80
                && task
                    .id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
            "invalid task id"
        );
        ensure!(ids.insert(&task.id), "duplicate task id");
        ensure!(
            !task.instruction.trim().is_empty() && task.instruction.len() <= 32000,
            "invalid task instruction"
        );
        ensure!(
            task.writes.len() <= 256 && task.writes.iter().all(|p| tree::valid_path(p)),
            "invalid write ownership"
        );
        ensure!(
            task.writes.iter().collect::<BTreeSet<_>>().len() == task.writes.len(),
            "duplicate write path"
        );
        ensure!(
            task.depends
                .iter()
                .chain(&task.integration_depends)
                .collect::<BTreeSet<_>>()
                .len()
                == task.depends.len() + task.integration_depends.len(),
            "duplicate dependency"
        );
        validate_commands(&task.checks, false)?;
    }
    for task in &plan.tasks {
        ensure!(
            task.depends
                .iter()
                .chain(&task.integration_depends)
                .all(|id| ids.contains(id)),
            "missing task dependency"
        );
    }
    let mut done = BTreeSet::new();
    loop {
        let before = done.len();
        for task in &plan.tasks {
            if task
                .depends
                .iter()
                .chain(&task.integration_depends)
                .all(|id| done.contains(id))
            {
                done.insert(task.id.clone());
            }
        }
        if done.len() == plan.tasks.len() {
            return Ok(());
        }
        ensure!(done.len() > before, "cyclic task dependencies");
    }
}

pub fn validate_commands(commands: &[Vec<String>], required: bool) -> Result<()> {
    ensure!(
        (!required || !commands.is_empty()) && commands.len() <= 16,
        "verification commands required or capacity exceeded"
    );
    ensure!(
        commands.iter().all(|argv| !argv.is_empty()
            && argv.len() <= 128
            && !argv[0].is_empty()
            && argv.iter().all(|s| !s.contains('\0'))
            && argv.iter().map(String::len).sum::<usize>() <= 32000),
        "invalid verification command"
    );
    Ok(())
}

/// A model-generated plan cannot grant itself new write authority. The caller
/// must keep acceptance tests and other immutable inputs outside this set.
/// 目录授权只在可信部署进入；计划始终保留精确写集合。
pub fn validate_directory_scope(
    plan: &Plan,
    allowed: &[String],
    directories: &[String],
) -> Result<()> {
    validate(plan)?;
    for path in plan.tasks.iter().flat_map(|t| &t.writes) {
        ensure!(
            allowed.contains(path)
                || directories.iter().any(|d| path
                    .strip_prefix(d)
                    .is_some_and(|suffix| suffix.starts_with('/'))),
            "write outside deployment authority: {path}"
        );
    }
    Ok(())
}

pub fn validate_write_scope(plan: &Plan, allowed: &[String]) -> Result<()> {
    ensure!(
        !allowed.is_empty() && allowed.len() <= 1024 && allowed.iter().all(|p| tree::valid_path(p)),
        "invalid trusted write scope"
    );
    ensure!(
        plan.tasks
            .iter()
            .all(|task| task.writes.iter().all(|path| allowed.contains(path))),
        "plan exceeds trusted write scope"
    );
    Ok(())
}

pub fn adapt(mut plan: Plan, strategy: Strategy, final_checks: &[Vec<String>]) -> Result<Plan> {
    ensure!(
        strategy != Strategy::Balanced,
        "balanced requires packing::prepare with the source snapshot"
    );
    validate(&plan)?;
    if plan.tasks.iter().any(|t| t.configuration.is_some()) {
        return Ok(plan);
    }

    // Explicit speculative edges are a granularity decision by the planner.
    // Preserve their IDs and barriers instead of contracting them implicitly.
    if strategy != Strategy::Single && plan.tasks.iter().any(|t| !t.integration_depends.is_empty())
    {
        return Ok(plan);
    }
    if strategy == Strategy::Contract {
        return Ok(plan);
    }
    if plan.tasks.len() == 1 {
        if strategy == Strategy::Single {
            plan.tasks[0].checks = final_checks.to_vec();
        }
        return Ok(plan);
    }
    let n = plan.tasks.len();
    let mut groups: Vec<usize> = (0..n).collect();
    fn root(groups: &[usize], mut i: usize) -> usize {
        while groups[i] != i {
            i = groups[i];
        }
        i
    }
    for i in 0..n {
        for j in 0..i {
            if strategy == Strategy::Single
                || plan.tasks[i]
                    .writes
                    .iter()
                    .any(|p| plan.tasks[j].writes.contains(p))
            {
                let a = root(&groups, i);
                let b = root(&groups, j);
                groups[a] = b;
            }
        }
    }
    // Contracting shared writers can create cycles. Merge each resulting SCC.
    loop {
        let mut reach = vec![vec![false; n]; n];
        for (i, task) in plan.tasks.iter().enumerate() {
            for dep in &task.depends {
                let j = plan.tasks.iter().position(|t| &t.id == dep).unwrap();
                reach[root(&groups, i)][root(&groups, j)] = true;
            }
        }
        for k in 0..n {
            for i in 0..n {
                for j in 0..n {
                    reach[i][j] |= reach[i][k] && reach[k][j];
                }
            }
        }
        let mut changed = false;
        for i in 0..n {
            for j in 0..i {
                let a = root(&groups, i);
                let b = root(&groups, j);
                if a != b && reach[a][b] && reach[b][a] {
                    groups[a] = b;
                    changed = true;
                }
            }
        }
        if !changed {
            break;
        }
    }
    let mut merged = BTreeMap::<usize, Task>::new();
    for (i, task) in plan.tasks.iter().enumerate() {
        let group = root(&groups, i);
        let result = merged.entry(group).or_insert_with(|| Task {
            configuration: None,
            id: format!("group_{group}"),
            instruction: String::new(),
            writes: vec![],
            depends: vec![],
            integration_depends: vec![],
            checks: vec![],
        });
        result
            .instruction
            .push_str(&format!("\n{}: {}\n", task.id, task.instruction));
        for path in &task.writes {
            if !result.writes.contains(path) {
                result.writes.push(path.clone());
            }
        }
        for dep in &task.depends {
            let other = root(
                &groups,
                plan.tasks.iter().position(|t| &t.id == dep).unwrap(),
            );
            let dep = format!("group_{other}");
            if other != group && !result.depends.contains(&dep) {
                result.depends.push(dep);
            }
        }
        for check in &task.checks {
            if !result.checks.contains(check) {
                result.checks.push(check.clone());
            }
        }
    }
    plan.tasks = merged.into_values().collect();
    if strategy == Strategy::Single {
        plan.tasks[0].checks = final_checks.to_vec();
    }
    validate(&plan)?;
    Ok(plan)
}

enum Event {
    Worker {
        index: usize,
        generation: u32,
        base: Tree,
        result: Result<Tree>,
    },
    Verification {
        members: Vec<(usize, u32)>,
        expected: String,
        candidate: Tree,
        result: Result<Check>,
    },
    FinalVerification(Result<Check>),
}

pub struct Workgroup {
    root: PathBuf,
    _lock: std::fs::File,
    record: Record,
    control: Control,
    commands: tokio::sync::mpsc::Receiver<control::Command>,
}

impl Workgroup {
    pub fn create(root: &Path, plan: Plan, base: &Tree, strategy: Strategy) -> Result<Self> {
        validate(&plan)?;
        ensure!(
            !root.exists(),
            "workgroup directory exists; inspect it, never replay implicitly"
        );
        std::fs::create_dir_all(root)?;
        let lock = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(root.join("owner.lock"))?;
        fs2::FileExt::try_lock_exclusive(&lock)?;
        let record = Record {
            authorized_directories: vec![],
            authorized_writes: vec![],
            version: 3,
            revision: 0,
            plan_revision: 0,
            revisions: BTreeMap::new(),
            objective: plan.objective,
            status: "running".into(),
            strategy,
            tasks: plan
                .tasks
                .into_iter()
                .map(|spec| TaskState {
                    spec,
                    generation: 0,
                    status: TaskStatus::Ready,
                    base: None,
                    artifact: None,
                    feedback: String::new(),
                })
                .collect(),
            head: tree::store(root, base)?,
            history: vec![],
            verifications: vec![],
            error: None,
            cleanup_confirmed: None,
            cleanup_error: None,
            final_check: None,
            final_checks: vec![],
            attempts: 0,
            conflicts: 0,
            repairs: 0,
            peak_workers: 0,
            admission: AdmissionStats::default(),
            wall_seconds: 0.0,
        };
        let (control, commands) = Control::new(&record);
        let mut group = Self {
            root: root.to_owned(),
            _lock: lock,
            record,
            control,
            commands,
        };
        group.save()?;
        Ok(group)
    }

    pub fn control(&self) -> Control {
        self.control.clone()
    }

    fn save(&mut self) -> Result<()> {
        self.record.revision += 1;
        Self::persist_record(&self.root, &self.record)?;
        self.control.publish(&self.record);
        Ok(())
    }

    async fn save_async(&mut self) -> Result<()> {
        self.record.revision += 1;
        let root = self.root.clone();
        let record = self.record.clone();
        tokio::task::spawn_blocking(move || Self::persist_record(&root, &record)).await??;
        self.control.publish(&self.record);
        Ok(())
    }

    fn persist_record(root: &Path, record: &Record) -> Result<()> {
        let mut temp = tempfile::NamedTempFile::new_in(root)?;
        serde_json::to_writer(&mut temp, record)?;
        temp.flush()?;
        temp.as_file().sync_all()?;
        temp.persist(root.join("run.json"))?;
        #[cfg(unix)]
        std::fs::File::open(root)?.sync_all()?;
        Ok(())
    }

    /// Read-only crash inspection: active states project to UNKNOWN, not Ready.
    pub fn inspect(root: &Path) -> Result<Record> {
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .open(root.join("owner.lock"))?;
        fs2::FileExt::try_lock_exclusive(&lock).context("workgroup still has an active owner")?;
        let mut record: Record = serde_json::from_slice(&std::fs::read(root.join("run.json"))?)?;
        ensure!(
            (1..=3).contains(&record.version),
            "unsupported workgroup version"
        );
        tree::load(root, &record.head)?;
        for task in &record.tasks {
            for id in [&task.base, &task.artifact].into_iter().flatten() {
                tree::load(root, id)?;
            }
        }
        for attempt in &record.history {
            tree::load(root, &attempt.base)?;
            if let Some(id) = &attempt.seed {
                tree::load(root, id)?;
            }
            if let Some(id) = &attempt.artifact {
                tree::load(root, id)?;
            }
        }
        if record.status == "running" {
            record.status = "unknown".into();
            record.error = Some("owner exited before durable completion; inspect artifacts and resources; no automatic replay".into());
            for task in &mut record.tasks {
                if matches!(
                    task.status,
                    TaskStatus::Running | TaskStatus::Submitted | TaskStatus::Validating
                ) {
                    task.status = TaskStatus::Unknown;
                }
            }
            for attempt in &mut record.history {
                if matches!(
                    attempt.status,
                    TaskStatus::Running | TaskStatus::Submitted | TaskStatus::Validating
                ) {
                    attempt.status = TaskStatus::Unknown;
                }
            }
        }
        Ok(record)
    }

    fn retry(&mut self, index: usize, feedback: &str, limit: u32) -> Result<()> {
        let task = &mut self.record.tasks[index];
        if let Some(attempt) = self
            .record
            .history
            .iter_mut()
            .rev()
            .find(|a| a.task == task.spec.id && a.generation == task.generation)
        {
            attempt.status = TaskStatus::Failed;
            attempt.error = Some(bounded(feedback));
        }
        task.feedback = bounded(feedback);
        if task.generation > limit {
            task.status = TaskStatus::Failed;
            // A settled task failure blocks its descendants, not independent work.
            return Ok(());
        }
        task.status = TaskStatus::Ready;
        self.record.repairs += 1;
        Ok(())
    }

    fn dispatchable(&self, index: usize) -> bool {
        let task = &self.record.tasks[index];
        task.status == TaskStatus::Ready
            && task.spec.depends.iter().all(|id| {
                self.record
                    .tasks
                    .iter()
                    .any(|t| &t.spec.id == id && t.status == TaskStatus::Integrated)
            })
            && !self.record.tasks.iter().enumerate().any(|(other, t)| {
                other != index
                    && matches!(
                        t.status,
                        TaskStatus::Running | TaskStatus::Submitted | TaskStatus::Validating
                    )
                    && (t.status != TaskStatus::Submitted || self.integration_ready(other))
                    && t.spec
                        .writes
                        .iter()
                        .any(|path| task.spec.writes.contains(path))
            })
    }

    fn integration_ready(&self, index: usize) -> bool {
        let task = &self.record.tasks[index];
        task.spec
            .depends
            .iter()
            .chain(&task.spec.integration_depends)
            .all(|id| {
                self.record
                    .tasks
                    .iter()
                    .any(|t| &t.spec.id == id && t.status == TaskStatus::Integrated)
            })
    }

    fn dispatch_order(&self) -> Vec<usize> {
        let mut order: Vec<_> = (0..self.record.tasks.len()).collect();
        if self
            .record
            .tasks
            .iter()
            .all(|t| t.spec.integration_depends.is_empty())
        {
            return order;
        }
        // An early consumer must never fill the unverified window ahead of all
        // its providers. Prefer ancestors across BOTH edge types; keep existing
        // packing order for ties and graphs without speculative dependencies.
        let mut ranks = BTreeMap::new();
        while ranks.len() < order.len() {
            for (index, task) in self.record.tasks.iter().enumerate() {
                let children: Vec<_> = self
                    .record
                    .tasks
                    .iter()
                    .enumerate()
                    .filter(|(_, t)| {
                        t.spec.depends.contains(&task.spec.id)
                            || t.spec.integration_depends.contains(&task.spec.id)
                    })
                    .map(|(i, _)| i)
                    .collect();
                if children.iter().all(|i| ranks.contains_key(i)) {
                    ranks.insert(
                        index,
                        1 + children.iter().map(|i| ranks[i]).max().unwrap_or(0usize),
                    );
                }
            }
        }
        order.sort_by_key(|i| std::cmp::Reverse(ranks[i]));
        order
    }

    fn dispatchable_count(&self) -> usize {
        let mut writes = BTreeSet::new();
        let mut count = 0;
        for (index, task) in self.record.tasks.iter().enumerate() {
            if self.dispatchable(index) && !task.spec.writes.iter().any(|p| writes.contains(p)) {
                writes.extend(task.spec.writes.iter());
                count += 1;
            }
        }
        count
    }

    pub async fn run(
        self,
        head: Tree,
        executor: Arc<dyn Executor>,
        checks: Vec<Vec<String>>,
        options: Options,
        stop: CancellationToken,
    ) -> Result<Record> {
        // The Core owner outlives a caller that drops its response future.
        // Explicit cancellation/deadline still owns every cleanup barrier.
        tokio::spawn(self.run_owned(head, executor, checks, options, stop))
            .await
            .context("workgroup owner task terminated; inspect durable state")?
    }

    async fn run_owned(
        mut self,
        mut head: Tree,
        executor: Arc<dyn Executor>,
        checks: Vec<Vec<String>>,
        options: Options,
        stop: CancellationToken,
    ) -> Result<Record> {
        validate_commands(&checks, true)?;
        ensure!(
            (1..=32).contains(&options.workers)
                && options.initial_workers <= 32
                && options.repairs <= 3
                && (1..=32).contains(&options.verification_batch)
                && !options.timeout.is_zero()
                && options.timeout <= Duration::from_secs(86400),
            "invalid workgroup limits"
        );
        ensure!(
            self.record.strategy == options.strategy && self.record.head == digest(&head),
            "workgroup inputs changed"
        );
        let started = Instant::now();
        let deadline = tokio::time::Instant::now() + options.timeout;
        let cancel = stop.child_token();
        let mut jobs = JoinSet::new();
        let mut submitted = BTreeMap::<usize, (u32, Tree, Tree)>::new();
        let mut active = 0;
        let mut verifying = false;
        let mut split_verification = BTreeSet::new();
        let adaptive = options.admission == Admission::Adaptive;
        let load = executor.model_load();
        ensure!(
            !adaptive || load.as_ref().is_some_and(|l| l.capacity > 0),
            "adaptive admission requires model load feedback"
        );
        let initial = if adaptive {
            let start = if options.initial_workers == 0 {
                load.as_ref()
                    .unwrap()
                    .capacity
                    .min(self.dispatchable_count().max(1))
            } else {
                options.initial_workers
            };
            start.min(options.workers).max(1)
        } else {
            options.workers
        };
        let mut controller = admission::Controller::new(options.workers, initial, load);
        let mut samples = tokio::time::interval_at(
            tokio::time::Instant::now() + admission::SAMPLE_INTERVAL,
            admission::SAMPLE_INTERVAL,
        );
        samples.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        self.record.admission = AdmissionStats {
            policy: options.admission,
            max_workers: options.workers,
            // One candidate may be checked while every worker is executing.
            // Queued artifacts consume this window as well: a slow verifier
            // must not let a large graph run arbitrarily far ahead of head.
            max_inflight: (options.admission != Admission::Fixed).then_some(options.workers + 1),
            initial_workers: initial,
            target_workers: initial,
            peak_target_workers: initial,
            ..AdmissionStats::default()
        };
        let mut result: Result<()> = std::panic::AssertUnwindSafe(async {
            let mut integration_repaired = false;
            loop {
            loop {
                ensure!(!cancel.is_cancelled(), "workgroup cancelled");
                ensure!(tokio::time::Instant::now() < deadline, "workgroup deadline exceeded");
                // Propagate a settled failure through dependency edges. Independent
                // branches keep running and retain their accepted artifacts.
                loop {
                    let failed: BTreeSet<_> = self.record.tasks.iter()
                        .filter(|t| matches!(t.status, TaskStatus::Failed | TaskStatus::Blocked))
                        .map(|t| t.spec.id.clone()).collect();
                    let mut changed = false;
                    for task in &mut self.record.tasks {
                        if matches!(task.status, TaskStatus::Ready | TaskStatus::Submitted)
                            && let Some(dep) = task.spec.depends.iter().chain(&task.spec.integration_depends).find(|id| failed.contains(*id)) {
                                task.status = TaskStatus::Blocked;
                                task.feedback = format!("dependency {dep} did not pass acceptance");
                                changed = true;
                        }
                    }
                    if !changed { break; }
                    self.save_async().await?;
                }
                submitted.retain(|i, _| self.record.tasks[*i].status != TaskStatus::Blocked);
                let pending = submitted.len();
                self.record.admission.peak_pending_verification = self.record.admission.peak_pending_verification.max(pending);
                let mut launches = Vec::new();
                for index in self.dispatch_order() {
                    if active >= controller.target { break; }
                    let window = if adaptive { Some(controller.target + 1) } else { self.record.admission.max_inflight };
                    if window.is_some_and(|limit| active + pending >= limit) { break; }
                    // A dependency is an integration barrier, not merely a hint.
                    // Independent branches still start immediately on the current head.
                    // Write ownership remains reserved through verification, even
                    // after a worker slot becomes free. Otherwise a one-worker
                    // run can still start its next writer on an unaccepted head.
                    if !self.dispatchable(index) { continue; }
                    // A failed local check does not make the previous patch
                    // worthless. Reuse only its owned delta, composed onto the
                    // latest accepted head. A real ownership conflict falls
                    // back to the clean head; a corrupt artifact fails closed.
                    let prior = &self.record.tasks[index];
                    let seed = match (&prior.base, &prior.artifact) {
                        (Some(base), Some(artifact)) => {
                            let base = tree::load_async(&self.root, base).await?;
                            let artifact = tree::load_async(&self.root, artifact).await?;
                            repair_seed(&head, &base, &artifact, &prior.spec.writes)?
                        }
                        _ => None,
                    };
                    let seed_hash = match &seed {Some(tree)=>Some(tree::store_async(&self.root, tree).await?),None=>None};
                    let task = &mut self.record.tasks[index];
                    task.generation += 1; task.status = TaskStatus::Running; task.base = Some(digest(&head)); task.artifact = None;
                    let generation = task.generation; let spec = task.spec.clone(); let feedback = task.feedback.clone();
                    self.record.history.push(Attempt { task: spec.id.clone(), generation, base: digest(&head), seed: seed_hash, artifact: None,
                        status: TaskStatus::Running, started_seconds: started.elapsed().as_secs_f64(), finished_seconds: None,
                        verification_started_seconds: None, verification_finished_seconds: None, check: None, error: None, checkpoint: None });
                    self.record.attempts += 1;
                    self.record.peak_workers = self.record.peak_workers.max(active + 1);
                    self.record.admission.peak_inflight = self.record.admission.peak_inflight.max(active + 1 + pending);
                    launches.push((index, generation, spec, seed, feedback));
                    active += 1;
                }
                if !launches.is_empty() {
                    // One durable frontier claim, then launch together. Per-worker
                    // fsync between spawns can serialize short independent jobs.
                    self.save_async().await?;
                    for (index, generation, spec, seed, feedback) in launches {
                        let executor = executor.clone(); let base = head.clone(); let token = cancel.child_token();
                        jobs.spawn(async move {
                            let result = executor.attempt(spec, generation, base.clone(), seed, feedback, token).await;
                            Event::Worker { index, generation, base, result }
                        });
                    }
                }
                if !verifying {
                    let ready: Vec<_> = submitted.keys().copied().filter(|index| self.integration_ready(*index)).collect();
                    let mut members = Vec::new();
                    let mut commands = Vec::new();
                    let mut candidate = head.clone();
                    for index in ready {
                        if members.len() >= options.verification_batch { break; }
                        if !members.is_empty() && (split_verification.contains(&index)
                            || members.iter().any(|(i, _)| split_verification.contains(i))) { break; }
                        let (generation, base, artifact) = &submitted[&index];
                        let task = &self.record.tasks[index];
                        let mut combined = commands.clone();
                        for check in &task.spec.checks { if !combined.contains(check) { combined.push(check.clone()); } }
                        if combined.len() > 16 { break; }
                        match compose(&candidate, base, artifact, &task.spec.writes) {
                            Ok(tree) => candidate = tree,
                            Err(error) => {
                                self.record.conflicts += 1;
                                self.retry(index, &error.to_string(), options.repairs)?;
                                submitted.remove(&index);
                                self.save_async().await?;
                                continue;
                            }
                        }
                        commands = combined;
                        members.push((index, *generation));
                    }
                    if !members.is_empty() {
                        let expected = self.record.head.clone();
                        for (index, generation) in &members {
                            self.record.tasks[*index].status = TaskStatus::Validating;
                            self.record.history.iter_mut().rev().find(|a| a.task == self.record.tasks[*index].spec.id && a.generation == *generation).unwrap()
                                .verification_started_seconds = Some(started.elapsed().as_secs_f64());
                        }
                        self.save_async().await?;
                        let executor = executor.clone(); let token = cancel.child_token();
                        jobs.spawn(async move {
                            let result = executor.verify(candidate.clone(), commands, token).await;
                            Event::Verification { members, expected, candidate, result }
                        });
                        verifying = true;
                    }
                }
                if self.record.tasks.iter().all(|t| t.status == TaskStatus::Integrated) { break; }
                if jobs.is_empty() {
                    let failures: Vec<_> = self.record.tasks.iter()
                        .filter(|t| t.status == TaskStatus::Failed)
                        .map(|t| format!("{}: {}", t.spec.id, t.feedback)).collect();
                    anyhow::bail!("task graph incomplete after independent work settled: {}", failures.join("; "));
                }
                let event = tokio::select! {
                    _ = cancel.cancelled() => anyhow::bail!("workgroup cancelled"),
                    _ = tokio::time::sleep_until(deadline) => anyhow::bail!("workgroup deadline exceeded"),
                    command = self.commands.recv() => {
                        if let Some(command) = command {
                            self.revise(command).await?;
                        }
                        continue;
                    },
                    _ = samples.tick(), if adaptive => {
                        let ready = self.dispatchable_count();
                        if let Some(decision) = controller.sample(executor.model_load(), active, ready, pending, started.elapsed().as_secs_f64()) {
                            self.record.admission.decision(decision);
                            self.save_async().await?;
                        }
                        continue;
                    },
                    event = jobs.join_next() => event.context("missing work item")??,
                };
                match event {
                    Event::Worker { index, generation, base, result } => {
                        active -= 1;
                        ensure!(self.record.tasks[index].generation == generation && self.record.tasks[index].status == TaskStatus::Running, "stale worker generation");
                        let (artifact, checkpoint) = match result {
                            Ok(artifact) => (artifact, None),
                            Err(error) => match error.downcast::<AttemptCheckpoint>() {
                                Ok(checkpoint) => (checkpoint.artifact, Some(checkpoint.failure)),
                                Err(error) => return Err(error),
                            },
                        };
                        compose(&base, &base, &artifact, &self.record.tasks[index].spec.writes)?;
                        self.record.tasks[index].artifact = Some(tree::store_async(&self.root, &artifact).await?);
                        let attempt = self.record.history.iter_mut().rev().find(|a| a.task == self.record.tasks[index].spec.id && a.generation == generation).unwrap();
                        attempt.artifact = self.record.tasks[index].artifact.clone();
                        attempt.status = TaskStatus::Submitted;
                        attempt.checkpoint = checkpoint;
                        attempt.finished_seconds = Some(started.elapsed().as_secs_f64());
                        if let Some(failure) = checkpoint {
                            attempt.error = Some(failure.to_string());
                            // No change or no local oracle cannot establish completion
                            // after an interrupted inference. Retry with the legal seed.
                            if artifact == base || self.record.tasks[index].spec.checks.is_empty() {
                                self.retry(index, &format!("Inference interrupted: {failure}. Continue from the retained source and complete the contract."), options.repairs)?;
                                self.save_async().await?;
                                continue;
                            }
                        }
                        self.record.tasks[index].status = TaskStatus::Submitted;
                        submitted.insert(index, (generation, base, artifact));
                    }
                    Event::Verification { members, expected, candidate, result } => {
                        verifying = false;
                        let check = result?;
                        ensure!(self.record.head == expected && check.tree_hash == digest(&candidate), "stale verification receipt");
                        self.record.verifications.push(Verification { expected_head: expected,
                            members: members.iter().map(|(i,g)|(self.record.tasks[*i].spec.id.clone(),*g)).collect(),
                            check:check.clone(), finished_seconds:started.elapsed().as_secs_f64() });
                        for (index, generation) in &members {
                            ensure!(self.record.tasks[*index].generation == *generation && self.record.tasks[*index].status == TaskStatus::Validating, "stale verification generation");
                            let attempt = self.record.history.iter_mut().rev().find(|a| a.task == self.record.tasks[*index].spec.id && a.generation == *generation).unwrap();
                            attempt.verification_finished_seconds = Some(started.elapsed().as_secs_f64());
                            attempt.check = Some(check.clone());
                        }
                        if check.passed {
                            // One tested tree and all its members share a durable commit.
                            self.record.head = tree::store_async(&self.root, &candidate).await?;
                            for (index, generation) in members {
                                submitted.remove(&index);
                                split_verification.remove(&index);
                                self.record.tasks[index].status = TaskStatus::Integrated;
                                self.record.history.iter_mut().rev().find(|a| a.task == self.record.tasks[index].spec.id && a.generation == generation).unwrap().status = TaskStatus::Integrated;
                            }
                            head = candidate;
                        } else if members.len() > 1 {
                            // A failed batch is not evidence that every worker is wrong.
                            // Recheck its retained artifacts individually before spending repairs.
                            for (index, _) in members {
                                self.record.tasks[index].status = TaskStatus::Submitted;
                                split_verification.insert(index);
                            }
                        } else {
                            let (index, _) = members[0];
                            submitted.remove(&index);
                            split_verification.remove(&index);
                            self.retry(index, &check.output, options.repairs)?;
                        }
                    }
                    Event::FinalVerification(_) => anyhow::bail!("unexpected final verification"),
                }
                self.save_async().await?;
            }
            let final_tree = head.clone(); let final_executor = executor.clone(); let token = cancel.child_token();
            let commands = checks.clone();
            jobs.spawn(async move { Event::FinalVerification(final_executor.verify(final_tree, commands, token).await) });
            let event = tokio::select! {
                _ = cancel.cancelled() => anyhow::bail!("workgroup cancelled"),
                _ = tokio::time::sleep_until(deadline) => anyhow::bail!("workgroup deadline exceeded"),
                event = jobs.join_next() => event.context("missing final verification")??,
            };
            let Event::FinalVerification(check) = event else { anyhow::bail!("unexpected pending worker"); };
            let check = check?;
            ensure!(check.tree_hash == digest(&head), "final verification references another candidate");
            let passed = check.passed;
            self.record.final_checks.push(check.clone());
            self.record.final_check = Some(check.clone());
            ensure!(tokio::time::Instant::now() <= deadline, "final verification exceeded deadline");
            if passed { return Ok(()); }
            ensure!(options.integration_repair && !integration_repaired, "final combined verification failed");
            // Only a concrete, settled test failure permits this fallback. All
            // original workers have closed. It never merges concurrent writes or
            // receives any broader source authority than the original plan.
            let mut serial = 0;
            while self.record.tasks.iter().any(|t| t.spec.id == format!("integration_{serial}")) { serial += 1; }
            let repair = Task {
                configuration: None,
                id: format!("integration_{serial}"),
                instruction: format!("Repair the already integrated candidate to satisfy the complete objective. Preserve existing behavior and resolve only the reported integration failures. Original objective: {}", self.record.objective),
                writes: self.record.tasks.iter().flat_map(|t| t.spec.writes.clone()).collect::<BTreeSet<_>>().into_iter().collect(),
                depends: self.record.tasks.iter().map(|t| t.spec.id.clone()).collect(),
                integration_depends: vec![],
                checks: checks.clone(),
            };
            let mut planned: Vec<_> = self.record.tasks.iter().map(|t| t.spec.clone()).collect(); planned.push(repair.clone());
            validate(&Plan { objective: self.record.objective.clone(), tasks: planned })?;
            self.record.tasks.push(TaskState { spec: repair, generation:0, status:TaskStatus::Ready,
                base:None, artifact:None, feedback:bounded(&check.output) });
            self.record.repairs += 1;
            integration_repaired = true;
            self.save_async().await?;
            }
        }).catch_unwind().await.unwrap_or_else(|_| Err(anyhow::anyhow!("workgroup scheduler panicked").context(CleanupFailure::Worker)));
        cancel.cancel();
        let cleanup_issue = |error: &anyhow::Error| {
            (error.downcast_ref::<CleanupFailure>().is_some()
                || error.downcast_ref::<tokio::task::JoinError>().is_some())
            .then(|| bounded(&error.to_string()))
        };
        self.record.cleanup_error = result.as_ref().err().and_then(cleanup_issue);
        // Never abort an owned attempt: its executor must close Runtime first.
        while let Some(event) = jobs.join_next().await {
            let error = match event {
                Ok(Event::Worker { index, result, .. }) => {
                    self.record.tasks[index].status = TaskStatus::Unknown;
                    result.err()
                }
                Ok(Event::Verification { result, .. }) | Ok(Event::FinalVerification(result)) => {
                    result.err()
                }
                Err(error) => Some(error.into()),
            };
            if self.record.cleanup_error.is_none() {
                self.record.cleanup_error = error.as_ref().and_then(cleanup_issue);
            }
        }
        self.record.cleanup_confirmed = Some(self.record.cleanup_error.is_none());
        if result.is_ok() && self.record.cleanup_error.is_some() {
            result = Err(anyhow::anyhow!("owned resource cleanup unconfirmed"));
        }
        // Export only accepted source after all owned resources have settled.
        let export = self.root.join("candidate");
        tokio::task::spawn_blocking(move || materialize(&head, &export)).await??;
        self.record.wall_seconds = started.elapsed().as_secs_f64();
        for attempt in &mut self.record.history {
            if matches!(
                attempt.status,
                TaskStatus::Running | TaskStatus::Submitted | TaskStatus::Validating
            ) {
                attempt.status = TaskStatus::Unknown;
                attempt
                    .finished_seconds
                    .get_or_insert(self.record.wall_seconds);
            }
        }
        if let Err(error) = result {
            self.record.status = if stop.is_cancelled() {
                "cancelled"
            } else {
                "failed"
            }
            .into();
            self.record.error = Some(bounded(&error.to_string()));
            for task in &mut self.record.tasks {
                if matches!(
                    task.status,
                    TaskStatus::Running | TaskStatus::Submitted | TaskStatus::Validating
                ) {
                    task.status = TaskStatus::Unknown;
                }
            }
        } else {
            self.record.status = "completed".into();
        }
        self.save_async().await?;
        Ok(self.record.clone())
    }
}

#[cfg(test)]
mod repair_tests {
    use super::*;
    fn source(text: &str) -> tree::File {
        tree::File {
            bytes: text.as_bytes().to_vec(),
            executable: false,
        }
    }
    #[test]
    fn repair_keeps_peer_head_and_owned_edits_but_never_bypasses_scope() {
        let base = Tree::from([
            ("a".into(), source("old")),
            ("peer".into(), source("before")),
        ]);
        let mut head = base.clone();
        head.insert("peer".into(), source("accepted peer"));
        let mut artifact = base.clone();
        artifact.insert("a".into(), source("unfinished edit"));
        let scope = vec!["a".into()];
        let seed = repair_seed(&head, &base, &artifact, &scope)
            .unwrap()
            .unwrap();
        assert_eq!(seed["peer"], source("accepted peer"));
        assert_eq!(seed["a"], source("unfinished edit"));
        assert!(repair_seed(&head, &base, &base, &scope).unwrap().is_none());
        head.insert("a".into(), source("different accepted edit"));
        assert!(
            repair_seed(&head, &base, &artifact, &scope)
                .unwrap()
                .is_none()
        );
        artifact.insert("peer".into(), source("illegal overwrite"));
        assert!(repair_seed(&head, &base, &artifact, &scope).is_err());
    }
}
