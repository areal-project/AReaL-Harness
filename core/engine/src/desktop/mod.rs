//! 桌面状态复用 Thread 快照、现有工具注册表及 Turn 调度。
mod agents;
mod catalog;
mod context;
mod interactions;
mod mcp;
pub(crate) mod mcp_interactions;
pub(crate) mod mcp_tools;
pub(crate) mod media;
mod model_configuration;
mod model_selection;
mod plugin_mcp;
mod plugins;
mod processes;
mod queue;
mod retention;
mod server;
mod side;
pub(crate) mod skill_loading;
mod skills;
mod state;
mod submissions;
mod tools;
mod workflows;
use super::*;
use areal_protocol::desktop::*;
pub use catalog::{ConfiguredModels, Deployment};
pub use model_configuration::PreparedModelConfiguration;
pub use processes::ProcessConnection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
pub use skills::{SkillLocation, SkillMetadata};
pub(crate) use tools::definitions;
pub use workflows::Workflow;

pub(crate) struct Desktop {
    plugins: std::sync::RwLock<plugins::Manager>,
    plugin_refresh: Mutex<()>,
    discovered_skills: std::sync::Mutex<Option<skills::Discovery>>,
    configured_models: std::sync::RwLock<ConfiguredModels>,
    model_configuration: std::sync::RwLock<()>,
    pub(crate) default_profile: std::sync::RwLock<Option<VersionRef>>,
    worker_model: std::sync::atomic::AtomicBool,
    submissions: submissions::Submissions,
    pub(crate) lifecycle: server::Lifecycle,
    pub(crate) plugin_mcp: plugin_mcp::Manager,
    pub(crate) mcp_interactions: mcp_interactions::Manager,
    catalog: std::sync::RwLock<catalog::Catalog>,
    catalog_write: Mutex<()>,
    model_events: broadcast::Sender<Value>,
    model_revision: std::sync::atomic::AtomicU64,
    creation: Mutex<()>,
    credentials: std::sync::RwLock<BTreeMap<String, String>>,
}
impl Desktop {
    pub fn open(root: &Path) -> anyhow::Result<Self> {
        Ok(Self {
            plugins: Default::default(),
            plugin_refresh: Mutex::new(()),
            discovered_skills: Default::default(),
            configured_models: Default::default(),
            model_configuration: Default::default(),
            default_profile: Default::default(),
            worker_model: std::sync::atomic::AtomicBool::new(false),
            submissions: submissions::Submissions::open(root)?,
            plugin_mcp: plugin_mcp::Manager::open(root)?,
            mcp_interactions: mcp_interactions::Manager::open(root)?,
            lifecycle: Default::default(),
            catalog: std::sync::RwLock::new(catalog::Catalog::load(root)?),
            catalog_write: Mutex::new(()),
            model_events: broadcast::channel(128).0,
            model_revision: std::sync::atomic::AtomicU64::new(0),
            creation: Mutex::new(()),
            credentials: std::sync::RwLock::new(BTreeMap::new()),
        })
    }
}
impl Engine {
    pub fn subscribe_model_catalog(&self) -> broadcast::Receiver<Value> {
        self.desktop.model_events.subscribe()
    }
    fn emit_model_catalog_changed(&self) {
        let revision = self.desktop.model_revision.fetch_add(1, Ordering::Relaxed) + 1;
        let _ = self.desktop.model_events.send(notification(
            "areal/model/catalogChanged",
            json!({"revision":revision}),
        ));
    }
}
fn invalid(error: impl std::fmt::Display) -> Error {
    Error::Invalid(error.to_string())
}
pub(crate) fn digest(value: &impl Serialize) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).map_err(invalid)?)
    ))
}

pub(crate) fn retire_removed_desktop_tools(thread: &mut Thread) {
    // 过渡：到 0.2.0 删；仅识别旧部署的固定定义，保留其他同名客户端工具。
    const REMOVED_COMPUTER: &str =
        "d73942d3d47fd2c929e5888866efe8a2081bff8b500758fc91dc53e6eacaa3b4";
    let was_external_cua = thread
        .desktop
        .as_ref()
        .is_some_and(|data| data.configuration.options.retired_external_cua);
    let count = thread.dynamic_tools.len();
    thread.dynamic_tools.retain(|tool| {
        !(tool.name == "computer_v1" && digest(tool).is_ok_and(|hash| hash == REMOVED_COMPUTER)
            || was_external_cua && matches!(tool.name.as_str(), "js" | "js_reset"))
    });
    if thread.dynamic_tools.len() != count {
        thread.toolset_revision = thread.toolset_revision.saturating_add(1);
    }
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.' | b':'))
}
fn desktop(thread: &Thread) -> DesktopState {
    thread.desktop.clone().unwrap_or_default()
}
pub(crate) fn receipt(
    state: &DesktopState,
    identity: &str,
    request: &str,
    method: &str,
    hash: &str,
) -> Result<Option<Value>> {
    if !valid_id(request) {
        return Err(invalid(
            "requestId must be 1..128 ASCII identifier characters",
        ));
    }
    if let Some(record) = state
        .receipts
        .iter()
        .find(|r| r.identity == identity && r.request_id == request && r.method == method)
    {
        if record.digest != hash {
            return Err(Error::Conflict);
        }
        return Ok(Some(record.result.clone()));
    }
    if state.receipts.len() >= 1024 {
        return Err(Error::Exhausted(
            "submission receipt capacity reached; retained keys are never silently forgotten"
                .into(),
        ));
    }
    Ok(None)
}
pub(crate) fn remember(
    state: &mut DesktopState,
    identity: &str,
    request: &str,
    method: &str,
    hash: String,
    result: Value,
) {
    state.receipts.push(RequestReceipt {
        identity: identity.into(),
        request_id: request.into(),
        method: method.into(),
        digest: hash,
        result,
    });
}

pub use areal_mcp::ServerConfig as McpConfig;
