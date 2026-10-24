//! 桌面状态复用 Thread 快照、现有工具注册表及 Turn 调度。
mod agents;
mod catalog;
mod context;
pub(crate) mod gen_ui;
mod interactions;
mod mcp;
pub(crate) mod mcp_apps;
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
mod skills;
mod state;
mod submissions;
mod tools;
mod workflows;
use super::*;
use areal_protocol::desktop::*;
pub use catalog::{ConfiguredModels, Deployment};
pub use model_configuration::PreparedModelConfiguration;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
pub use skills::{SkillLocation, SkillMetadata};
pub(crate) use tools::definitions;
pub use workflows::Workflow;

pub(crate) struct Desktop {
    plugins: std::sync::RwLock<plugins::Manager>,
    plugin_refresh: Mutex<()>,
    configured_models: std::sync::RwLock<ConfiguredModels>,
    model_configuration: std::sync::RwLock<()>,
    pub(crate) default_profile: std::sync::RwLock<Option<VersionRef>>,
    worker_model: std::sync::atomic::AtomicBool,
    submissions: submissions::Submissions,
    pub(crate) lifecycle: server::Lifecycle,
    pub(crate) mcp: mcp::Manager,
    pub(crate) plugin_mcp: plugin_mcp::Manager,
    pub(crate) mcp_apps: mcp_apps::Manager,
    catalog: std::sync::RwLock<catalog::Catalog>,
    catalog_write: Mutex<()>,
    creation: Mutex<()>,
    credentials: std::sync::RwLock<BTreeMap<String, String>>,
}
impl Desktop {
    pub fn open(root: &Path) -> anyhow::Result<Self> {
        Ok(Self {
            plugins: Default::default(),
            plugin_refresh: Mutex::new(()),
            configured_models: Default::default(),
            model_configuration: Default::default(),
            default_profile: Default::default(),
            worker_model: std::sync::atomic::AtomicBool::new(false),
            submissions: submissions::Submissions::open(root)?,
            mcp: mcp::Manager::open(root)?,
            plugin_mcp: plugin_mcp::Manager::open(root)?,
            mcp_apps: mcp_apps::Manager::open(root)?,
            lifecycle: Default::default(),
            catalog: std::sync::RwLock::new(catalog::Catalog::load(root)?),
            catalog_write: Mutex::new(()),
            creation: Mutex::new(()),
            credentials: std::sync::RwLock::new(BTreeMap::new()),
        })
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
