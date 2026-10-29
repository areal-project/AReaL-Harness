pub use areal_config::SessionCatalog;
pub use catalog::{ConversationFilter, ConversationView};
mod agents;
mod catalog;
pub mod concurrency;
mod context;
mod context_usage;
mod default_model;
pub mod delegation;
pub mod desktop;
pub mod diagnostics;
mod dormant;
mod generation;
pub mod goals;
mod history;
pub mod model;
mod observations;
mod outcome;
mod permissions;
mod plugin_hooks;
mod prompt_prediction;
mod request_meter;
mod session_name;
mod sessions;
mod store;
mod task_mode;
pub use areal_plugins::PluginComponentId;
#[cfg(feature = "test-support")]
pub use task_mode::TaskCommitFault;
pub use task_mode::TaskRunNowAdmission;
pub use task_mode::{
    PublishedTaskCatalog, PublishedTaskCatalogFallback, read_published_task_catalog,
};
pub mod tools;
mod trajectory;
pub use trajectory::{configure_trajectory_capture_budget, record_json as record_trajectory_json};
mod turns;
mod watchdog;
pub mod workgroup;
mod workspace;

use areal_protocol::{Input, Item, Modality, Thread, ThreadStatus, Turn, TurnStatus, notification};
use futures_util::{FutureExt, StreamExt};
use generation::emit_item;
use history::{history, validate_input};
use model::{
    ContentPart, MediaSource, Message, Model, ModelCapabilities, ModelEvent, content_from_input,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Mutex, OwnedSemaphorePermit, RwLock, Semaphore, broadcast, mpsc, watch};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use tracing::{Instrument, info_span};

#[derive(Clone, Debug)]
pub struct Limits {
    pub session_catalog: areal_config::SessionCatalog,
    pub inspection_permissions: areal_config::InspectionPermissions,
    pub goals: goals::Policy,
    pub max_threads: usize,
    pub model_concurrency: usize,
    pub max_active_turns: usize,
    pub max_side_turns_per_source: usize,
    pub max_side_turns_per_deployment: usize,
    pub max_side_model_rounds: usize,
    pub max_side_tool_calls: usize,
    pub max_side_turn_seconds: u64,
    pub max_children_per_turn: usize,
    pub max_agent_depth: usize,
    pub max_history_bytes: usize,
    pub max_output_bytes: usize,
    pub max_media_output_bytes: usize,
    pub mailbox_capacity: usize,
    pub model_request_timeout: Duration,
    pub stream_idle_timeout: Duration,
    pub max_tool_calls: usize,
    /// 单次响应的保护与整轮累计预算独立；累计预算为零表示不限制。
    pub max_response_tool_calls: usize,
    pub max_response_bytes: usize,
    pub max_tool_buffer_bytes: usize,
    pub context_window_bytes: usize,
    pub context_compaction_enabled: bool,
    pub context_auto_compaction: bool,
    pub context_recent_tokens: usize,
    pub context_window_tokens: usize,
    pub context_target_tokens: usize,
    pub context_output_reserve_tokens: usize,
    pub context_recent_bytes: usize,
    /// 实验性旧工具观察预算；默认 0 关闭，原文与最近结果始终保留。
    pub context_observation_tokens: usize,
    /// 实验性历史文件参考预算；默认 0 关闭。
    pub context_reference_tokens: usize,
    /// 实验性相同失败调用执行上限；默认 0 不限制。
    pub max_repeated_tool_failures: usize,
    pub command_stdin_closed: bool,
    /// 实验性空白恢复额度；默认 0 关闭，与一般恢复共享整轮已用计数。
    pub max_empty_completion_retries: usize,
    /// Total discarded completions that may be retried within one Turn.
    pub max_completion_retries: usize,
    /// 关闭默认启用的网络 watchdog；有限响应恢复额度仍独立生效。
    pub watchdog_disable: bool,
    /// 有限模式允许每个当前请求最多五次 Core 网络恢复，不增加既有请求预算。
    pub network_retry_mode: areal_config::NetworkRetryMode,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            session_catalog: {
                #[cfg(feature = "test-support")]
                {
                    match std::env::var("AREAL_TEST_SESSION_CATALOG").as_deref() {
                        Ok("memory-lazy") => SessionCatalog::MemoryLazy,
                        Ok("sqlite-lazy") => SessionCatalog::SqliteLazy,
                        _ => SessionCatalog::Memory,
                    }
                }
                #[cfg(not(feature = "test-support"))]
                {
                    SessionCatalog::Memory
                }
            },
            inspection_permissions: areal_config::InspectionPermissions::ReadOnly,
            goals: goals::Policy::default(),
            max_threads: 20_000,
            model_concurrency: 32,
            max_active_turns: 256,
            max_side_turns_per_source: 2,
            max_side_turns_per_deployment: 8,
            max_side_model_rounds: 8,
            max_side_tool_calls: 16,
            max_side_turn_seconds: 300,
            max_children_per_turn: 64,
            max_agent_depth: 8,
            max_history_bytes: 0,
            max_output_bytes: 0,
            max_media_output_bytes: 0,
            mailbox_capacity: 32,
            model_request_timeout: Duration::from_secs(300),
            stream_idle_timeout: Duration::from_secs(30),
            max_tool_calls: 0,
            max_response_tool_calls: 128,
            max_response_bytes: 4 * 1024 * 1024,
            max_tool_buffer_bytes: 4 * 1024 * 1024,
            context_window_bytes: 0,
            context_compaction_enabled: true,
            context_auto_compaction: true,
            context_recent_tokens: 0,
            context_window_tokens: 128 * 1024,
            context_target_tokens: 0,
            context_output_reserve_tokens: 8 * 1024,
            context_recent_bytes: 0,
            context_observation_tokens: 0,
            context_reference_tokens: 0,
            max_repeated_tool_failures: 0,
            command_stdin_closed: true,
            max_empty_completion_retries: 0,
            max_completion_retries: 0,
            watchdog_disable: false,
            network_retry_mode: areal_config::NetworkRetryMode::Persistent,
        }
    }
}

impl Limits {
    pub(crate) fn remaining_tool_calls(&self, used: usize) -> Option<usize> {
        (self.max_tool_calls > 0).then(|| self.max_tool_calls.saturating_sub(used))
    }

    pub(crate) fn remaining_output_bytes(&self, used: usize) -> usize {
        if self.max_output_bytes == 0 {
            usize::MAX
        } else {
            self.max_output_bytes.saturating_sub(used)
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Rejected(Box<Error>),
    #[error("operation outcome requires reconciliation: {0:?}")]
    OperationOutcome(Box<areal_protocol::desktop::OperationFailure>),
    #[error("history read unavailable: {reason}")]
    HistoryRead {
        reason: &'static str,
        thread_id: String,
        restart_cursor: Option<String>,
    },
    #[error("thread not found")]
    NotFound,
    #[error("{0}")]
    Invalid(String),
    #[error("thread is busy or the target turn is stale")]
    Conflict,
    #[error("{0}")]
    Exhausted(String),
    #[error("Core is shutting down")]
    Closed,
    #[error("session persistence failed: {0}")]
    Storage(String),
}
pub type Result<T> = std::result::Result<T, Error>;

struct TrustedPlugin {
    id: String,
    digest: String,
}

struct Active {
    context_usage: Option<areal_protocol::context::ContextUsage>,
    context_sequence: u64,
    generation: request_meter::Generation,
    registry: std::result::Result<tools::Registry, String>,
    hooks: Vec<plugin_hooks::BoundHook>,
    hook_user_input: bool,
    hook_tasks: TaskTracker,
    direct_tool: Option<model::ToolCall>,
    tool_meta: Option<serde_json::Map<String, Value>>,
    tool_calls: usize,
    cua_used: bool,
    waiting_for_model_capacity: bool,
    started: std::time::Instant,
    isolated_children: usize,
    workspace_exclusive: bool,
    deferred_workspace_guard: Option<tokio::sync::OwnedRwLockWriteGuard<()>>,
    workspace_lease_pinned: bool,
    workspace_version: Option<workspace::Version>,
    workspace_conflict_call: Option<String>,
    // Includes queued model work, tool waits and cleanup. Never wait for this
    // permit during admission: waiting parents must not deadlock their children.
    _admission: OwnedSemaphorePermit,
    id: String,
    cancel: CancellationToken,
    steer: mpsc::Sender<bool>,
    children: Vec<String>,
    model_children: Vec<String>,
    open_items: HashSet<String>,
    sealed: bool,
    scope: Option<String>,
    base_scope: Option<String>,
    model: Arc<dyn Model>,
    tools: TaskTracker,
    process_cursors: BTreeMap<String, String>,
    handles: tools::Handles,
}
struct State {
    prediction_source: Option<prompt_prediction::PredictionSource>,
    thread: Thread,
    active: Option<Active>,
    poisoned: bool,
    compacting: bool,
    compaction_owner: Option<desktop::mcp_apps::CallOwner>,
    // Failed cleanup or final persistence is not evidence that capacity is
    // reusable. Keep the reservation until this Engine is dropped/recovered.
    quarantined_admission: Option<OwnedSemaphorePermit>,
}
struct Cell {
    browser_permits: Mutex<HashSet<String>>,
    hooks: plugin_hooks::Session,
    inherited_registry: Option<tools::Registry>,
    exclusive_writer: bool,
    // 工具投影可能已持有会话锁，原子角色避免为读取 Goal 可见性再次加锁。
    goal_role: AtomicUsize,
    // 工具投影可能持有会话锁；隔离 worker 的交接角色与递归委派额度分开。
    handoff_worker: AtomicBool,
    depth: usize,
    research: bool,
    id: String,
    // 创建顺序在会话存活期内不变，目录索引不读取或复制会话正文。
    created_at: i64,
    scratch_path: std::path::PathBuf,
    agent_requests: AtomicUsize,
    agent_tools: AtomicUsize,
    // 普通接管允许当前请求有界结算；强制取消仍使用短期限。
    cancel_grace_ms: AtomicUsize,
    bindings: RwLock<tools::Bindings>,
    state: dormant::StateSlot,
    pending_registry: std::sync::Mutex<Option<Arc<tools::Registry>>>,
    events: dormant::Events,
    settled: watch::Sender<bool>,
    interaction_changed: watch::Sender<u64>,
    resource_gate: Mutex<()>,
    delegation_creation: Mutex<()>,
}
impl Cell {
    fn new(
        thread: Thread,
        depth: usize,
        bindings: tools::Bindings,
        parent_scratch: Option<&Path>,
    ) -> Arc<Self> {
        Self::restored(thread, depth, bindings, parent_scratch, None, None)
    }
    fn restored(
        mut thread: Thread,
        depth: usize,
        bindings: tools::Bindings,
        parent_scratch: Option<&Path>,
        pending_registry: Option<Arc<tools::Registry>>,
        activity_at: Option<i64>,
    ) -> Arc<Self> {
        let deferred = pending_registry.is_some();
        debug_assert_eq!(deferred, activity_at.is_some());
        if let Some(data) = &mut thread.desktop
            && let Some(areal_protocol::desktop::PromptPrediction::Pending {
                source_turn_id,
                configuration_revision,
            }) = data.prompt_prediction.clone()
        {
            data.prompt_prediction = Some(areal_protocol::desktop::PromptPrediction::Unavailable {
                source_turn_id,
                configuration_revision,
            });
        }
        Arc::new(Self {
            scratch_path: parent_scratch
                .unwrap_or_else(|| Path::new(""))
                .join(format!("agent-{}", thread.id)),
            browser_permits: Mutex::new(HashSet::new()),
            hooks: plugin_hooks::Session::new(&thread),
            inherited_registry: thread
                .parent_thread_id
                .as_ref()
                .map(|_| bindings.registry.clone()),
            exclusive_writer: thread.desktop.as_ref().is_some_and(|d| {
                d.execution_policy.exclusive_write || d.execution_policy.deferred_write
            }),
            goal_role: AtomicUsize::new(if thread.goal_owner.is_some() { 2 } else { 0 }),
            handoff_worker: AtomicBool::new(thread.source == "workgroupWorker"),
            depth,
            research: thread.source == "nativeResearchAgent",
            id: thread.id.clone(),
            created_at: thread.created_at,
            agent_requests: AtomicUsize::new(0),
            agent_tools: AtomicUsize::new(0),
            cancel_grace_ms: AtomicUsize::new(1000),
            bindings: RwLock::new(bindings),
            state: dormant::StateSlot::new(thread, activity_at),
            pending_registry: std::sync::Mutex::new(pending_registry),
            events: dormant::Events::new(deferred),
            settled: watch::channel(true).0,
            interaction_changed: watch::channel(0).0,
            resource_gate: Mutex::new(()),
            delegation_creation: Mutex::new(()),
        })
    }
    fn emit(&self, method: &str, params: Value) {
        let _ = self.events.send(notification(method, params));
    }
}

#[cfg(feature = "test-support")]
type ForkCommitBarrier = (Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>);
pub struct Engine {
    permissions: permissions::Permissions,
    default_models: std::sync::RwLock<default_model::DefaultModels>,
    configuration_status: std::sync::RwLock<Value>,
    goals: goals::Goals,
    task_modes: task_mode::Tasks,
    threads: RwLock<catalog::ThreadCatalog>,
    thread_creation: Mutex<()>,
    #[cfg(feature = "test-support")]
    fork_commit_barrier: std::sync::Mutex<Option<ForkCommitBarrier>>,
    store: store::Store,
    model: Arc<dyn Model>,
    limits: Limits,
    prediction_preemption: watch::Sender<()>,
    permits: Arc<Semaphore>,
    active_turns: Arc<Semaphore>,
    shutdown: CancellationToken,
    tasks: TaskTracker,
    runtime: Option<tools::RuntimeConfig>,
    tool_permits: Semaphore,
    registry: tools::Registry,
    extensions: tools::ToolExtensions,
    agent_model_requests: AtomicUsize,
    agent_tool_calls: AtomicUsize,
    workgroups: std::sync::OnceLock<Arc<workgroup::service::Service>>,
    automatic_workgroups: std::sync::OnceLock<Arc<workgroup::service::Service>>,
    workspace_gate: Arc<RwLock<()>>,
    desktop: desktop::Desktop,
    plugin_hooks: plugin_hooks::Manager,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

// Derive immutable depth from durable ownership, not a client-supplied value.
// Cache visited paths to perform a linear number of parent traversals.
fn restore_cells(
    threads: Vec<Thread>,
    registry: &tools::Registry,
) -> anyhow::Result<BTreeMap<String, Arc<Cell>>> {
    restore_sessions(
        threads.into_iter().map(store::RestoredSession::from),
        registry,
    )
}

fn restore_sessions(
    sessions: impl IntoIterator<Item = store::RestoredSession>,
    registry: &tools::Registry,
) -> anyhow::Result<BTreeMap<String, Arc<Cell>>> {
    let deferred_registry = Arc::new(registry.clone());
    let threads: BTreeMap<_, _> = sessions.into_iter().map(|t| (t.id.clone(), t)).collect();
    let mut depths: BTreeMap<String, usize> = BTreeMap::new();
    let mut scratch_paths: BTreeMap<String, std::path::PathBuf> = BTreeMap::new();
    for id in threads.keys() {
        let mut current = id.as_str();
        let mut path = Vec::new();
        let mut visited = HashSet::new();
        let mut depth = loop {
            if let Some(depth) = depths.get(current) {
                break *depth;
            }
            anyhow::ensure!(
                visited.insert(current),
                "cyclic agent ownership in stored sessions"
            );
            let thread = &threads[current];
            let Some(parent_id) = &thread.parent_thread_id else {
                anyhow::ensure!(
                    thread.session_id == thread.id,
                    "inconsistent root session ownership"
                );
                depths.insert(current.to_owned(), 0);
                scratch_paths.insert(current.to_owned(), format!("agent-{current}").into());
                break 0;
            };
            let parent = threads
                .get(parent_id)
                .context("stored agent parent is missing")?;
            anyhow::ensure!(
                parent.session_id == thread.session_id,
                "inconsistent child session ownership"
            );
            path.push(current.to_owned());
            current = parent_id;
        };
        for child in path.into_iter().rev() {
            depth += 1;
            let parent = threads[&child].parent_thread_id.as_ref().unwrap();
            let scratch = scratch_paths[parent].join(format!("agent-{child}"));
            scratch_paths.insert(child.clone(), scratch);
            depths.insert(child, depth);
        }
    }
    threads
        .into_iter()
        .map(|(id, session)| {
            let deferred = session.is_deferred();
            let activity_at = session.deferred_activity_at();
            let thread = session.into_thread()?;
            let mut bindings = tools::Bindings {
                registry: if thread.is_read_only_side() {
                    registry.clone().side_only(thread.side_workspace_read())
                } else if thread.source == "nativeResearchAgent" {
                    registry.clone().research_only()
                } else {
                    registry.with_dynamic(&thread.dynamic_tools)?
                },
                host: None,
            };
            let root_session = thread.parent_thread_id.is_none();
            let parent_scratch = thread
                .parent_thread_id
                .as_ref()
                .map(|parent| scratch_paths[parent].as_path());
            let pending_registry = deferred.then(|| deferred_registry.clone());
            if deferred {
                bindings.registry = tools::Registry::default();
            }
            let cell = Cell::restored(
                thread,
                depths[&id],
                bindings,
                parent_scratch,
                pending_registry,
                activity_at,
            );
            if root_session {
                *cell.hooks.pending.try_lock().expect("new hook session") = vec!["resume".into()];
            }
            Ok((id, cell))
        })
        .collect()
}

impl Engine {
    pub fn open(root: &Path, model: Arc<dyn Model>, limits: Limits) -> anyhow::Result<Arc<Self>> {
        Self::open_with_extensions(root, model, limits, None, tools::ToolExtensions::default())
    }
    pub fn open_with_runtime(
        root: &Path,
        model: Arc<dyn Model>,
        limits: Limits,
        runtime: tools::RuntimeConfig,
    ) -> anyhow::Result<Arc<Self>> {
        Self::open_with_extensions(
            root,
            model,
            limits,
            Some(runtime),
            tools::ToolExtensions::default(),
        )
    }
    pub fn open_with_extensions(
        root: &Path,
        model: Arc<dyn Model>,
        limits: Limits,
        runtime: Option<tools::RuntimeConfig>,
        extensions: tools::ToolExtensions,
    ) -> anyhow::Result<Arc<Self>> {
        anyhow::ensure!(
            extensions.mcp_servers.is_empty(),
            "MCP servers must be connected before opening Engine; use open_with_mcp"
        );
        Self::open_with_mcp(root, model, limits, runtime, extensions, Vec::new())
    }
    pub fn open_with_mcp(
        root: &Path,
        model: Arc<dyn Model>,
        limits: Limits,
        runtime: Option<tools::RuntimeConfig>,
        extensions: tools::ToolExtensions,
        mcp_tools: Vec<areal_mcp::McpTool>,
    ) -> anyhow::Result<Arc<Self>> {
        anyhow::ensure!(
            extensions.plugins.is_empty(),
            "plugin hosts must be connected before opening Engine; use open_with_plugins"
        );
        Self::open_with_plugins(
            root,
            model,
            limits,
            runtime,
            extensions,
            mcp_tools,
            Vec::new(),
        )
    }
    pub fn open_with_plugins(
        root: &Path,
        model: Arc<dyn Model>,
        limits: Limits,
        mut runtime: Option<tools::RuntimeConfig>,
        extensions: tools::ToolExtensions,
        mcp_tools: Vec<areal_mcp::McpTool>,
        plugin_tools: Vec<tools::plugins::PluginTool>,
    ) -> anyhow::Result<Arc<Self>> {
        anyhow::ensure!(
            limits.max_threads > 0
                && limits.model_concurrency > 0
                && limits.model_concurrency <= Semaphore::MAX_PERMITS
                && limits.max_active_turns > 0
                && limits.max_active_turns <= Semaphore::MAX_PERMITS
                && limits.mailbox_capacity > 0
                && limits.max_response_bytes > 0
                && limits.max_response_tool_calls > 0
                && limits.max_side_turns_per_source > 0
                && limits.max_side_turns_per_deployment > 0
                && (1..=1024).contains(&limits.max_side_model_rounds)
                && (1..=65536).contains(&limits.max_side_tool_calls)
                && (1..=86400).contains(&limits.max_side_turn_seconds)
                && limits.max_tool_buffer_bytes > 0
                && (limits.context_window_bytes == 0
                    || limits.context_recent_bytes < limits.context_window_bytes)
                && limits.max_completion_retries <= 8
                && limits.max_empty_completion_retries <= 8
                && limits.context_observation_tokens <= 2_000_000
                && limits.context_reference_tokens <= 2_000_000
                && limits.max_repeated_tool_failures <= 8
                && (limits.max_history_bytes == 0
                    || limits.max_output_bytes < limits.max_history_bytes)
                && !limits.model_request_timeout.is_zero()
                && !limits.stream_idle_timeout.is_zero(),
            "invalid Core limits"
        );
        anyhow::ensure!(
            (0..=86400).contains(&limits.goals.max_turns)
                && (0..=86400).contains(&limits.goals.max_active_seconds)
                && (1..=86400).contains(&limits.goals.max_unreported_turns)
                && (limits.goals.turn_model_rounds == 0
                    || (2..=1024).contains(&limits.goals.turn_model_rounds)),
            "invalid goal policy"
        );
        context::ContextBudget::resolve(&limits, model.as_ref())?;
        let store = store::Store::open(root)?;
        if let Some(runtime) = runtime.as_mut() {
            runtime.workspace = runtime.workspace.canonicalize()?;
            if let Some(scratch) = runtime.command_scratch.as_mut() {
                *scratch = scratch.canonicalize()?;
                anyhow::ensure!(
                    scratch.is_dir()
                        && !runtime.workspace.starts_with(&*scratch)
                        && !store.root().starts_with(&*scratch),
                    "command scratch cannot contain the workspace or Core data"
                );
            }
            anyhow::ensure!(
                !store.root().starts_with(&runtime.workspace),
                "Core data directory must be outside the Runtime workspace"
            );
            anyhow::ensure!(
                runtime.client.info().capabilities["methods"]
                    .as_array()
                    .is_some_and(|methods| methods.contains(&json!("fs.execute"))),
                "Runtime must support fs.execute for the tool profile"
            );
        }
        anyhow::ensure!(
            runtime.as_ref().is_some_and(|r| r.writable)
                || extensions
                    .plugins
                    .values()
                    .all(|p| p.write_roots.is_empty()),
            "plugin write roots require a writable Runtime deployment"
        );
        let configured: std::collections::BTreeSet<_> =
            extensions.plugins.keys().cloned().collect();
        let connected: std::collections::BTreeSet<_> =
            plugin_tools.iter().map(|t| t.host.id.clone()).collect();
        anyhow::ensure!(
            configured == connected,
            "plugin Host set does not match configuration"
        );
        if extensions.agents.is_some() {
            anyhow::ensure!(
                runtime
                    .as_ref()
                    .is_some_and(|r| r.command_scratch.is_some()),
                "native research agents require task scratch"
            );
            anyhow::ensure!(
                limits.max_children_per_turn > 0 && limits.max_agent_depth > 0,
                "native research agents require child admission"
            );
        }
        let mut registry = tools::Registry::new(runtime.is_some(), &extensions)?
            .with_command_scratch(
                runtime
                    .as_ref()
                    .is_some_and(|r| r.command_scratch.is_some()),
            )
            .with_mcp(mcp_tools)?
            .with_plugins(plugin_tools)?
            .with_agents(
                extensions.agents.is_none()
                    && limits.max_children_per_turn > 0
                    && limits.max_agent_depth > 0,
                false,
            )?
            .with_workgroups(limits.max_children_per_turn > 0)?;
        if let Some(runtime) = &runtime {
            if let Some(scope) = &runtime.command_scope {
                registry = registry.with_runtime_limits(&scope.limits)?;
            } else if let Some(limits) = runtime.client.info().capabilities.get("processLimits") {
                registry =
                    registry.with_runtime_limits(&serde_json::from_value(limits.clone())?)?;
            }
        }
        let threads = if limits.session_catalog.is_lazy() {
            restore_sessions(
                store.load_catalog(
                    limits.max_threads,
                    limits.max_history_bytes,
                    limits.session_catalog.is_sqlite(),
                )?,
                &registry,
            )?
        } else {
            restore_cells(
                store.load(limits.max_threads, limits.max_history_bytes)?,
                &registry,
            )?
        };
        let desktop = desktop::Desktop::open(root)?;
        let goals = goals::Goals::open(root, &threads)?;
        let permission_file = root.join("desktop/permissions.json");
        let project_permissions = if permission_file.exists() {
            let metadata = std::fs::symlink_metadata(&permission_file)?;
            anyhow::ensure!(
                metadata.is_file() && metadata.len() <= 256 * 1024,
                "permission memory must be a regular file of at most 256 KiB"
            );
            let bytes = std::fs::read(&permission_file)?;
            serde_json::from_slice(&bytes)?
        } else {
            permissions::ProjectGrants::default()
        };
        let task_modes = task_mode::Tasks::open(root, &store)?;
        for cell in threads.values() {
            let state = cell.state.try_lock().expect("unpublished Thread state");
            task_modes.directory.publish_thread(
                &state.thread.id,
                task_mode::directory::thread_attention(&state.thread)?,
                false,
            );
        }
        Ok(Arc::new(Self {
            permissions: permissions::Permissions {
                config: Default::default(),
                project: Mutex::new(project_permissions),
            },
            default_models: Default::default(),
            configuration_status: Default::default(),
            goals,
            task_modes,
            desktop,
            plugin_hooks: plugin_hooks::Manager::open(&store)?,
            threads: RwLock::new(catalog::ThreadCatalog::new(
                root,
                threads,
                limits.session_catalog,
            )),
            thread_creation: Mutex::new(()),
            #[cfg(feature = "test-support")]
            fork_commit_barrier: Default::default(),
            store,
            model,
            prediction_preemption: watch::channel(()).0,
            permits: Arc::new(Semaphore::new(limits.model_concurrency)),
            active_turns: Arc::new(Semaphore::new(limits.max_active_turns)),
            limits,
            shutdown: CancellationToken::new(),
            tasks: TaskTracker::new(),
            runtime,
            tool_permits: Semaphore::new(4),
            registry,
            extensions,
            agent_model_requests: AtomicUsize::new(0),
            agent_tool_calls: AtomicUsize::new(0),
            workgroups: std::sync::OnceLock::new(),
            automatic_workgroups: std::sync::OnceLock::new(),
            workspace_gate: Arc::new(RwLock::new(())),
        }))
    }
    pub fn model_name(&self) -> String {
        self.default_model().name().into()
    }
    pub fn model_provider(&self) -> String {
        self.default_model().provider().into()
    }
    pub fn model_capabilities(&self) -> ModelCapabilities {
        self.default_model().capabilities()
    }
    pub fn data_dir(&self) -> &Path {
        self.store.root()
    }
    /// 仅投影实际装配的后端，声明不赋予调用方额外权限。
    pub fn runtime_capabilities(&self) -> Value {
        self.runtime.as_ref().map_or(Value::Null, |runtime| {
            json!({"epoch": runtime.client.info().runtime_epoch,
                "capabilities": runtime.client.info().capabilities})
        })
    }
    pub fn side_workspace_read_available(&self) -> bool {
        let Some(runtime) = self.runtime.as_ref() else {
            return false;
        };
        let capabilities = &runtime.client.info().capabilities;
        let permissions = self.permission_config();
        let native = matches!(
            capabilities["sandbox"].as_str(),
            Some("runtimeSeatbeltPathV1" | "runtimeBubblewrapPathV1")
        );
        native && !runtime.client.is_closed() && capabilities["fullAccess"] == false
            && !["fs_read", "fs_list", "fs_stat", "search_files"].iter().any(|tool|
                permissions.deny.iter().any(|pattern| permissions::matches_tool(pattern, tool)))
            && capabilities["filesystem"]["symlinks"] == "reject"
            && capabilities["filesystem"]["search"] == "scopedNativeV1"
            && capabilities["methods"].as_array().is_some_and(|methods| methods.iter().any(|m| m == "fs.execute"))
            // 任意命令 hook 无法证明无副作用；不能跳过它们再声称已执行强制审计。
            && self.extensions.hooks.is_empty()
    }
    pub fn default_cwd(&self) -> String {
        self.runtime
            .as_ref()
            .map(|r| r.workspace.clone())
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
            .to_string_lossy()
            .into_owned()
    }
    pub fn sandbox(&self) -> Value {
        let network_access = self
            .runtime
            .as_ref()
            .is_some_and(|runtime| runtime.client.info().capabilities["rootNetwork"] == "inherit");
        match &self.runtime {
            Some(runtime) if runtime.client.info().capabilities["fullAccess"] == true => {
                json!({"type":"dangerFullAccess","networkAccess":network_access})
            }
            Some(runtime) if runtime.writable => {
                json!({"type":"workspaceWrite","writableRoots":[runtime.workspace],"networkAccess":network_access,"excludeTmpdirEnvVar":true,"excludeSlashTmp":true})
            }
            _ => json!({"type":"readOnly","networkAccess":network_access}),
        }
    }
    pub fn is_closed(&self) -> bool {
        self.shutdown.is_cancelled()
            || self
                .runtime
                .as_ref()
                .is_some_and(|runtime| runtime.client.is_closed())
    }
    /// 仅测试 feature 启用；在真实 Fork 持久提交窗口暂停，不替代 Core 锁。
    #[cfg(feature = "test-support")]
    pub fn test_pause_fork_commit(
        &self,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    ) {
        *self.fork_commit_barrier.lock().unwrap() = Some((entered, release));
    }
    #[cfg(feature = "test-support")]
    async fn test_fork_commit_barrier(&self) {
        let barrier = self.fork_commit_barrier.lock().unwrap().take();
        if let Some((entered, release)) = barrier {
            entered.notify_one();
            release.notified().await;
        }
    }
    /// 仅测试 feature 启用；模拟配置持久化持有真实目标状态锁。
    #[cfg(feature = "test-support")]
    pub async fn test_hold_thread_state(
        &self,
        id: &str,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    ) {
        let cell = self.raw_cell(id).await.unwrap();
        let _state = cell.state.lock().await;
        entered.notify_one();
        release.notified().await;
    }
    async fn lookup_cell(&self, thread_id: &str) -> Result<Arc<Cell>> {
        self.threads
            .read()
            .await
            .get(thread_id)
            .cloned()
            .ok_or(Error::NotFound)
    }
    async fn raw_cell(&self, thread_id: &str) -> Result<Arc<Cell>> {
        let cell = self.lookup_cell(thread_id).await?;
        self.materialize_cell(&cell).await?;
        Ok(cell)
    }
    async fn materialize_cell(&self, cell: &Arc<Cell>) -> Result<()> {
        if cell.state.is_loaded() {
            return Ok(());
        }
        let mut state = cell.state.lock().await;
        if cell.state.is_loaded() {
            return Ok(());
        }
        let mut thread = match self
            .store
            .materialize(
                &cell.id,
                self.limits.max_history_bytes,
                state.latest_activity_at(),
            )
            .await
        {
            Ok(thread) => thread,
            Err(error) => {
                self.store
                    .reject_cached_projection(
                        &cell.id,
                        self.limits.session_catalog.is_sqlite(),
                        self.limits.max_threads,
                    )
                    .await;
                return Err(Error::Storage(error.to_string()));
            }
        };
        thread.status = ThreadStatus::Idle;
        if let Some(desktop) = &mut thread.desktop {
            for hook in &mut desktop.hook_runs {
                if hook.outcome == "running" {
                    hook.outcome = "unknown".into();
                }
            }
            if let Some(areal_protocol::desktop::PromptPrediction::Pending {
                source_turn_id,
                configuration_revision,
            }) = desktop.prompt_prediction.clone()
            {
                desktop.prompt_prediction =
                    Some(areal_protocol::desktop::PromptPrediction::Unavailable {
                        source_turn_id,
                        configuration_revision,
                    });
            }
        }
        if serde_json::to_value(catalog::metadata(&thread))
            .map_err(|e| Error::Storage(e.to_string()))?
            != serde_json::to_value(catalog::metadata(&state.thread))
                .map_err(|e| Error::Storage(e.to_string()))?
        {
            self.store
                .reject_cached_projection(
                    &cell.id,
                    self.limits.session_catalog.is_sqlite(),
                    self.limits.max_threads,
                )
                .await;
            return Err(Error::Storage(
                "deferred metadata differs from authoritative facts; restart Core".into(),
            ));
        }
        let base = cell
            .pending_registry
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| Error::Storage("missing deferred registry".into()))?;
        let registry = if state.thread.source == "nativeResearchAgent" {
            base.as_ref().clone().research_only()
        } else {
            base.with_dynamic(&state.thread.dynamic_tools)
                .map_err(|e| Error::Storage(e.to_string()))?
        };
        let mut bindings = cell.bindings.write().await;
        if state.thread.desktop.as_ref().is_some_and(|d| d.archived) {
            thread.turns.clear();
            thread.context_checkpoint = None;
        }
        // 在所有可取消等待之后一次发布，取消读取不能把半份正文或空历史发布给执行端。
        state.thread = thread;
        bindings.registry = registry;
        state.materialized();
        self.store.materialized(&cell.id);
        cell.pending_registry.lock().unwrap().take();
        Ok(())
    }
    async fn cell(&self, thread_id: &str) -> Result<Arc<Cell>> {
        let cell = self.raw_cell(thread_id).await?;
        if cell
            .state
            .lock()
            .await
            .thread
            .desktop
            .as_ref()
            .is_some_and(|d| d.archived)
        {
            return Err(Error::Invalid(
                "THREAD_ARCHIVED: history is readable; archived sessions cannot accept mutations"
                    .into(),
            ));
        }
        Ok(cell)
    }
    async fn persist(&self, thread: &Thread) -> Result<()> {
        // 同一份编码同时用于容量检查与原子落盘，避免重复序列化及深拷贝。
        let started = std::time::Instant::now();
        let attention = task_mode::directory::thread_attention(thread)?;
        let bytes = store::encode(thread).map_err(|e| Error::Storage(e.to_string()))?;
        tracing::debug!(target: "areal::persistence", thread_id = %thread.id, bytes = bytes.len(),
            serialize_ms = started.elapsed().as_secs_f64() * 1000.0, "thread encoded");
        if self.limits.max_history_bytes > 0
            && (bytes.len() as u64)
                .saturating_add(thread.history_archive.as_ref().map_or(0, |a| a.bytes))
                .saturating_add(match &thread.conversation {
                    Some(areal_protocol::Conversation::Fork { history_seed, .. }) => {
                        history_seed.logical_bytes as u64
                    }
                    Some(areal_protocol::Conversation::Side {
                        reference_snapshot, ..
                    }) => reference_snapshot.logical_bytes as u64,
                    _ => 0,
                })
                > self.limits.max_history_bytes as u64
        {
            return Err(Error::Exhausted(
                "session history limit reached; start a new thread".into(),
            ));
        }
        self.store
            .save_encoded(&thread.id, bytes)
            .instrument(info_span!("persist_thread", areal.thread.id = %thread.id))
            .await
            .map_err(|e| Error::Storage(e.to_string()))?;
        self.task_modes
            .directory
            .publish_thread(&thread.id, attention, true);
        Ok(())
    }

    // 磁盘写入一旦开始就由 Core 持有。丢弃 API future 只丢弃响应等待，
    // 不能在 spawn_blocking 仍写盘时释放会话锁或遗留半注册状态。
    async fn mutate<T, F, Fut>(self: &Arc<Self>, run: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(Arc<Self>) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<T>> + Send + 'static,
    {
        if self.is_closed() {
            return Err(Error::Closed);
        }
        let engine = self.clone();
        self.tasks
            .spawn(async move { run(engine).await })
            .await
            .map_err(|_| Error::Storage("Core mutation task panicked".into()))?
    }

    pub async fn shutdown(self: &Arc<Self>) {
        self.shutdown.cancel();
        if let Some(service) = self.workgroups.get() {
            service.shutdown().await;
        }
        if let Some(service) = self.automatic_workgroups.get() {
            service.shutdown().await;
        }
        self.tasks.close();
        self.tasks.wait().await;
        let hook_cells: Vec<_> = self.threads.read().await.values().cloned().collect();
        for cell in &hook_cells {
            let _ = self.plugin_hooks_end(cell).await;
        }
        if let Err(error) = self.desktop.plugin_mcp.shutdown().await {
            tracing::warn!(%error, "plugin MCP cleanup remains unconfirmed");
        }
        if let Err(error) = self.desktop.mcp.shutdown(&self.store).await {
            tracing::error!(%error, "managed MCP cleanup failed");
        }
        let cells: Vec<_> = self.threads.read().await.values().cloned().collect();
        for cell in cells {
            if let Err(error) = self.close_managed(&cell, None).await {
                tracing::error!(%error,"thread resource cleanup failed");
            }
        }
        self.close_catalog().await;
    }
}

use anyhow::Context;

#[cfg(test)]
mod tests;

/// 持久格式兼容版本供可信打包身份查询使用。
pub fn state_version() -> u32 {
    store::STATE_VERSION
}
