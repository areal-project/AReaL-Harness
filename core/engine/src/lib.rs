mod agents;
pub mod concurrency;
mod context;
mod default_model;
pub mod desktop;
pub mod diagnostics;
mod generation;
pub mod goals;
mod history;
pub mod model;
mod outcome;
mod permissions;
mod sessions;
mod store;
mod task_mode;
pub mod tools;
mod trajectory;
pub use trajectory::{configure_trajectory_capture_budget, record_json as record_trajectory_json};
mod turns;
mod watchdog;
pub mod workgroup;

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
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Mutex, OwnedSemaphorePermit, RwLock, Semaphore, broadcast, mpsc, watch};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use tracing::{Instrument, info_span};

#[derive(Clone, Debug)]
pub struct Limits {
    pub goals: goals::Policy,
    pub max_threads: usize,
    pub model_concurrency: usize,
    pub max_active_turns: usize,
    pub max_children_per_turn: usize,
    pub max_agent_depth: usize,
    pub max_history_bytes: usize,
    pub max_output_bytes: usize,
    pub max_media_output_bytes: usize,
    pub mailbox_capacity: usize,
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
    /// Total discarded completions that may be retried within one Turn.
    pub max_completion_retries: usize,
    /// 关闭默认启用的网络 watchdog；有限响应恢复额度仍独立生效。
    pub watchdog_disable: bool,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            goals: goals::Policy::default(),
            max_threads: 20_000,
            model_concurrency: 32,
            max_active_turns: 256,
            max_children_per_turn: 64,
            max_agent_depth: 8,
            max_history_bytes: 0,
            max_output_bytes: 0,
            max_media_output_bytes: 0,
            mailbox_capacity: 32,
            stream_idle_timeout: Duration::from_secs(30),
            max_tool_calls: 0,
            max_response_tool_calls: 128,
            max_response_bytes: 4 * 1024 * 1024,
            max_tool_buffer_bytes: 4 * 1024 * 1024,
            context_window_bytes: 0,
            context_compaction_enabled: true,
            context_auto_compaction: true,
            context_recent_tokens: 8192,
            context_window_tokens: 64 * 1024,
            context_target_tokens: 0,
            context_output_reserve_tokens: 8 * 1024,
            context_recent_bytes: 0,
            max_completion_retries: 0,
            watchdog_disable: false,
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

struct Active {
    tool_calls: usize,
    started: std::time::Instant,
    isolated_children: usize,
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
    model: Arc<dyn Model>,
    tools: TaskTracker,
    process_cursors: BTreeMap<String, String>,
    handles: tools::Handles,
}
struct State {
    thread: Thread,
    active: Option<Active>,
    poisoned: bool,
    compacting: bool,
    // Failed cleanup or final persistence is not evidence that capacity is
    // reusable. Keep the reservation until this Engine is dropped/recovered.
    quarantined_admission: Option<OwnedSemaphorePermit>,
}
struct Cell {
    // 工具投影可能已持有会话锁，原子角色避免为读取 Goal 可见性再次加锁。
    goal_role: AtomicUsize,
    depth: usize,
    research: bool,
    id: String,
    agent_requests: AtomicUsize,
    agent_tools: AtomicUsize,
    // 普通接管允许当前请求有界结算；强制取消仍使用短期限。
    cancel_grace_ms: AtomicUsize,
    bindings: RwLock<tools::Bindings>,
    state: Mutex<State>,
    events: broadcast::Sender<Value>,
    settled: watch::Sender<bool>,
    interaction_changed: watch::Sender<u64>,
    resource_gate: Mutex<()>,
}
impl Cell {
    fn new(thread: Thread, depth: usize, bindings: tools::Bindings) -> Arc<Self> {
        Arc::new(Self {
            goal_role: AtomicUsize::new(if thread.goal_owner.is_some() { 2 } else { 0 }),
            depth,
            research: thread.source == "nativeResearchAgent",
            id: thread.id.clone(),
            agent_requests: AtomicUsize::new(0),
            agent_tools: AtomicUsize::new(0),
            cancel_grace_ms: AtomicUsize::new(1000),
            bindings: RwLock::new(bindings),
            state: Mutex::new(State {
                thread,
                active: None,
                poisoned: false,
                compacting: false,
                quarantined_admission: None,
            }),
            events: broadcast::channel(128).0,
            settled: watch::channel(true).0,
            interaction_changed: watch::channel(0).0,
            resource_gate: Mutex::new(()),
        })
    }
    fn emit(&self, method: &str, params: Value) {
        let _ = self.events.send(notification(method, params));
    }
}

pub struct Engine {
    permissions: permissions::Permissions,
    default_models: std::sync::RwLock<default_model::DefaultModels>,
    configuration_status: std::sync::RwLock<Value>,
    goals: goals::Goals,
    task_modes: task_mode::Tasks,
    threads: RwLock<BTreeMap<String, Arc<Cell>>>,
    store: store::Store,
    model: Arc<dyn Model>,
    limits: Limits,
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
    desktop: desktop::Desktop,
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
    let threads: BTreeMap<_, _> = threads.into_iter().map(|t| (t.id.clone(), t)).collect();
    let mut depths: BTreeMap<String, usize> = BTreeMap::new();
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
            depths.insert(child, depth);
        }
    }
    threads
        .into_iter()
        .map(|(id, thread)| {
            let bindings = tools::Bindings {
                registry: if thread.source == "nativeResearchAgent" {
                    registry.clone().research_only()
                } else {
                    registry.with_dynamic(&thread.dynamic_tools)?
                },
                host: None,
            };
            let cell = Cell::new(thread, depths[&id], bindings);
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
                && limits.max_tool_buffer_bytes > 0
                && (limits.context_window_bytes == 0
                    || limits.context_recent_bytes < limits.context_window_bytes)
                && limits.max_completion_retries <= 8
                && (limits.max_history_bytes == 0
                    || limits.max_output_bytes < limits.max_history_bytes)
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
        let threads = restore_cells(
            store.load(limits.max_threads, limits.max_history_bytes)?,
            &registry,
        )?;
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
        let task_modes = task_mode::Tasks::open(root)?;
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
            threads: RwLock::new(threads),
            store,
            model,
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
    async fn raw_cell(&self, thread_id: &str) -> Result<Arc<Cell>> {
        self.threads
            .read()
            .await
            .get(thread_id)
            .cloned()
            .ok_or(Error::NotFound)
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
        let bytes = store::encode(thread).map_err(|e| Error::Storage(e.to_string()))?;
        tracing::debug!(target: "areal::persistence", thread_id = %thread.id, bytes = bytes.len(),
            serialize_ms = started.elapsed().as_secs_f64() * 1000.0, "thread encoded");
        if self.limits.max_history_bytes > 0
            && (bytes.len() as u64)
                .saturating_add(thread.history_archive.as_ref().map_or(0, |a| a.bytes))
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
            .map_err(|e| Error::Storage(e.to_string()))
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

    pub async fn shutdown(&self) {
        self.shutdown.cancel();
        if let Some(service) = self.workgroups.get() {
            service.shutdown().await;
        }
        self.tasks.close();
        self.tasks.wait().await;
        if let Err(error) = self.desktop.mcp.shutdown().await {
            tracing::error!(%error, "managed MCP cleanup failed");
        }
        let cells: Vec<_> = self.threads.read().await.values().cloned().collect();
        for cell in cells {
            if let Err(error) = self.close_managed(&cell, None).await {
                tracing::error!(%error,"thread resource cleanup failed");
            }
        }
    }
}

use anyhow::Context;

#[cfg(test)]
mod tests;
