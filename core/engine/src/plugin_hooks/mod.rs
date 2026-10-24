//! Core-owned Codex hooks: reviewed definitions, immutable admission, authoritative
//! events and no-replay receipts. Processes remain Runtime-owned, MCP stays shared.
use super::*;
use areal_plugins::hooks::{HookDefinition, HookEvent};
use areal_protocol::desktop::HookRun;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
mod execution;
mod lifecycle;
mod mcp;
pub(crate) mod output;
#[cfg(test)]
mod review_tests;
mod runner;
mod spill;
mod task_scope;
use mcp::mcp_owner;
use output::{HookOutput, PermissionDecision};
fn invalid(error: impl std::fmt::Display) -> Error {
    Error::Invalid(error.to_string())
}

#[derive(Clone)]
pub(super) struct BoundHook {
    pub(super) plugin_id: String,
    pub(super) package_digest: String,
    pub(super) root: PathBuf,
    pub(super) data_root: PathBuf,
    pub(super) definition: HookDefinition,
    pub(super) caller_admitted: bool,
    pub(super) packaged: bool,
    pub(super) read_only: bool,
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct Trust {
    enabled: bool,
    package: String,
    definition: String,
    #[serde(default)]
    allow_read_only_commands: bool,
}
pub(super) struct Manager {
    plans: std::sync::RwLock<Vec<BoundHook>>,
    trust: std::sync::RwLock<BTreeMap<String, Trust>>,
    enabled: std::sync::RwLock<HashSet<String>>,
    invocations: std::sync::Mutex<BTreeMap<String, (String, bool, CancellationToken)>>,
    configuration: Mutex<()>,
    pub(super) source_config: std::sync::OnceLock<(PathBuf, Option<PathBuf>)>,
    pub(super) sources: std::sync::RwLock<Vec<areal_plugins::hook_sources::HookSource>>,
}
impl Manager {
    pub(super) fn open(store: &store::Store) -> anyhow::Result<Self> {
        let path = store.root().join("desktop/plugin-hook-trust.json");
        let trust = if path.exists() {
            let bytes = std::fs::read(path)?;
            anyhow::ensure!(bytes.len() <= 1024 * 1024, "hook trust metadata limit");
            serde_json::from_slice(&bytes)?
        } else {
            BTreeMap::new()
        };
        Ok(Self {
            source_config: Default::default(),
            sources: Default::default(),
            plans: Default::default(),
            enabled: Default::default(),
            invocations: Default::default(),
            configuration: Mutex::new(()),
            trust: std::sync::RwLock::new(trust),
        })
    }
    fn key(h: &BoundHook) -> String {
        format!(
            "{}:{}:{}",
            h.plugin_id, h.package_digest, h.definition.digest
        )
    }
    fn allowed(&self, h: &BoundHook) -> bool {
        self.enabled.read().unwrap().contains(&h.plugin_id)
            && self
                .trust
                .read()
                .unwrap()
                .get(&Self::key(h))
                .is_some_and(|t| {
                    t.enabled
                        && t.package == h.package_digest
                        && t.definition == h.definition.digest
                })
    }
    fn read_only_allowed(&self, h: &BoundHook) -> bool {
        matches!(
            h.definition.handler,
            areal_plugins::hooks::HookHandler::Command { .. }
        ) && self.allowed(h)
            && self
                .trust
                .read()
                .unwrap()
                .get(&Self::key(h))
                .is_some_and(|t| t.allow_read_only_commands)
    }
    pub(super) fn publish(&self, hooks: Vec<BoundHook>, enabled: HashSet<String>) {
        for (_, (plugin, _, token)) in self.invocations.lock().unwrap().iter() {
            if !enabled.contains(plugin) {
                token.cancel();
            }
        }
        *self.enabled.write().unwrap() = enabled;
        *self.plans.write().unwrap() = hooks;
    }
    /// Revoke only: a watcher cannot grant trust or admit a replacement definition.
    pub(crate) fn revoke_disabled_packages(&self, current: &BTreeMap<String, String>) {
        let packaged: HashSet<_> = self
            .plans
            .read()
            .unwrap()
            .iter()
            .filter(|h| h.packaged)
            .map(|h| h.plugin_id.clone())
            .collect();
        for (_, (plugin, is_packaged, token)) in self.invocations.lock().unwrap().iter() {
            if *is_packaged && !current.contains_key(plugin) {
                token.cancel();
            }
        }
        self.enabled
            .write()
            .unwrap()
            .retain(|id| !packaged.contains(id) || current.contains_key(id));
    }
}
pub(super) struct Session {
    task_scope: Mutex<Option<task_scope::Anchor>>,
    pub(super) pending: Mutex<Vec<String>>,
    pub(super) ended: std::sync::atomic::AtomicBool,
    pub(super) inherited: std::sync::OnceLock<Vec<BoundHook>>,
    pub(super) child_start: std::sync::atomic::AtomicBool,
    pub(super) closing: std::sync::atomic::AtomicBool,
    end_gate: Mutex<()>,
    stop_active: std::sync::atomic::AtomicBool,
    pub(super) cancel: CancellationToken,
    tasks: TaskTracker,
    capacity: Arc<Semaphore>,
    started: std::sync::atomic::AtomicBool,
}
impl Session {
    pub(super) fn new(thread: &Thread) -> Self {
        let source = if matches!(
            thread.conversation,
            Some(areal_protocol::Conversation::Fork { .. })
        ) {
            "fork"
        } else if thread.turns.is_empty() {
            "startup"
        } else {
            "resume"
        };
        Self {
            task_scope: Mutex::new(None),
            closing: Default::default(),
            end_gate: Mutex::new(()),
            inherited: Default::default(),
            child_start: Default::default(),
            stop_active: Default::default(),
            pending: Mutex::new(if thread.parent_thread_id.is_none() {
                vec![source.into()]
            } else {
                vec![]
            }),
            ended: Default::default(),
            cancel: CancellationToken::new(),
            tasks: TaskTracker::new(),
            capacity: Arc::new(Semaphore::new(8)),
            started: Default::default(),
        }
    }
}
#[derive(Default)]
pub(super) struct Effects {
    pub(super) block: Option<String>,
    pub(super) stop: Option<String>,
    pub(super) continuation: Vec<String>,
    pub(super) updated_input: Option<Value>,
    pub(super) permission: Option<PermissionDecision>,
}
fn plan_digest(hooks: &[BoundHook]) -> String {
    format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(
                &hooks
                    .iter()
                    .map(|h| (&h.definition.id, &h.definition.digest))
                    .collect::<Vec<_>>()
            )
            .unwrap()
        )
    )
}
pub(super) fn bind(c: &areal_plugins::InstalledComponents) -> anyhow::Result<Vec<BoundHook>> {
    Ok(areal_plugins::hooks::normalize(c)?
        .entries
        .into_iter()
        .map(|definition| BoundHook {
            plugin_id: c.id.clone(),
            package_digest: c.digest.clone(),
            root: c.root.clone(),
            data_root: c.data_root.clone(),
            definition,
            caller_admitted: false,
            packaged: true,
            read_only: false,
        })
        .collect())
}
pub(super) fn bind_source(source: &areal_plugins::hook_sources::HookSource) -> Vec<BoundHook> {
    source
        .plan
        .entries
        .iter()
        .cloned()
        .map(|definition| BoundHook {
            plugin_id: source.id.clone(),
            package_digest: source.digest.clone(),
            root: source.root.clone(),
            data_root: source.data_root.clone(),
            definition,
            caller_admitted: false,
            packaged: false,
            read_only: false,
        })
        .collect()
}
// 角色来自已受理的 Profile 快照；自动 Skill 发现的内部 Profile 不冒充用户角色。
fn hook_agent_type(thread: &Thread) -> &str {
    thread
        .turns
        .last()
        .filter(|turn| turn.status == areal_protocol::TurnStatus::InProgress)
        .and_then(|turn| turn.configuration.as_ref())
        .or_else(|| thread.desktop.as_ref().map(|data| &data.configuration))
        .and_then(|config| config.profile.as_ref())
        .filter(|profile| profile.id != "areal-discovered-skills")
        .map_or("default", |profile| profile.id.as_str())
}
/// One Session policy for both frozen admission and live authority checks.
/// Read-only command consent applies only to ordinary child Sessions; it never
/// turns Side, research, native workers or restricted Profiles into hook callers.
fn hook_scope(thread: &Thread, research: bool) -> Option<bool> {
    if thread.is_read_only_side()
        || research
        || matches!(
            thread.source.as_str(),
            "nativeResearchAgent" | "nativeTaskAgent"
        )
    {
        return None;
    }
    let config = thread
        .turns
        .last()
        .filter(|t| t.status == areal_protocol::TurnStatus::InProgress)
        .and_then(|t| t.configuration.as_ref())
        .or_else(|| thread.desktop.as_ref().map(|d| &d.configuration));
    if config.is_some_and(|c| !c.allow_plugin_skills) {
        return None;
    }
    let read_only = config.is_some_and(|c| c.read_only);
    if read_only && thread.parent_thread_id.is_none() {
        return None;
    }
    Some(read_only)
}
pub(super) async fn ensure_current(
    engine: &Engine,
    cell: &Cell,
    hook: &BoundHook,
) -> anyhow::Result<()> {
    if hook.packaged {
        let store = engine.plugin_store()?;
        let current = tokio::task::spawn_blocking(move || store.enabled_revisions()).await??;
        engine.plugin_hooks.revoke_disabled_packages(&current);
        anyhow::ensure!(
            current.contains_key(&hook.plugin_id),
            "hook package disabled or uninstalled"
        );
    }
    anyhow::ensure!(
        !cell.hooks.ended.load(Ordering::Acquire),
        "hook session closed"
    );
    anyhow::ensure!(
        !cell.hooks.closing.load(Ordering::Acquire)
            || hook.definition.event == HookEvent::SessionEnd,
        "hook session closing"
    );
    anyhow::ensure!(
        engine.plugin_hooks.allowed(hook),
        "hook disabled or review changed"
    );
    let state = cell.state.lock().await;
    anyhow::ensure!(
        hook_scope(&state.thread, cell.research) == Some(hook.read_only)
            && (!hook.read_only || engine.plugin_hooks.read_only_allowed(hook)),
        "hook scope or independent read-only consent excluded"
    );
    Ok(())
}
impl Engine {
    pub(super) fn ensure_hook_session_open(&self, cell: &Cell, thread: &Thread) -> Result<()> {
        if thread.is_executable_side() && thread.desktop.as_ref().is_some_and(|data| data.archived)
        {
            return Err(invalid("THREAD_ARCHIVED"));
        }
        if cell.hooks.closing.load(Ordering::Acquire)
            && !thread.is_read_only_side()
            && !matches!(
                thread.source.as_str(),
                "nativeResearchAgent" | "nativeTaskAgent"
            )
        {
            return Err(invalid(
                "HOOK_SESSION_CLOSED: execution activation ended; inspect receipts and restart the service before resuming",
            ));
        }
        Ok(())
    }
    /// Explicit launcher config boundary; only hook definitions are projected.
    pub fn install_hook_configuration(
        &self,
        home: PathBuf,
        config: Option<PathBuf>,
    ) -> anyhow::Result<()> {
        self.plugin_hooks
            .source_config
            .set((home, config))
            .map_err(|_| anyhow::anyhow!("hook configuration already installed"))
    }
    pub(super) fn admitted_plugin_hooks(
        &self,
        thread: &Thread,
        hooks: &[BoundHook],
    ) -> Vec<BoundHook> {
        let Some(read_only) = hook_scope(thread, false) else {
            return vec![];
        };
        hooks
            .iter()
            .filter(|h| {
                if read_only {
                    self.plugin_hooks.read_only_allowed(h)
                } else {
                    self.plugin_hooks.allowed(h)
                }
            })
            .cloned()
            .map(|mut h| {
                h.read_only = read_only;
                h
            })
            .collect()
    }
    pub(super) fn frozen_plugin_hooks(&self, thread: &Thread) -> Vec<BoundHook> {
        self.admitted_plugin_hooks(thread, &self.plugin_hooks.plans.read().unwrap())
    }
    pub async fn plugin_hooks_list(&self) -> Result<Value> {
        self.refresh_plugins().await?;
        let store = self.plugin_store()?;
        let components = tokio::task::spawn_blocking(move || store.installed_components())
            .await
            .map_err(invalid)?
            .map_err(invalid)?;
        let mut rows = Vec::new();
        for c in components {
            let plan = areal_plugins::hooks::normalize(&c).map_err(invalid)?;
            let hooks = bind(&c).map_err(invalid)?;
            rows.push(json!({"pluginId":c.id,"installedDigest":c.digest,"definitionDigest":plan_digest(&hooks),"definitions":plan.entries.iter().zip(&hooks).map(|(d,h)|json!({"definition":d,"trusted":self.plugin_hooks.allowed(h),"readOnlyCommandTrusted":self.plugin_hooks.read_only_allowed(h)})).collect::<Vec<_>>(),"diagnostics":plan.diagnostics}));
        }
        for source in self.plugin_hooks.sources.read().unwrap().iter() {
            let hooks = bind_source(source);
            rows.push(json!({"pluginId":source.id,"sourceKind":format!("{:?}",source.kind),"origin":source.origin,"enabled":source.enabled,"installedDigest":source.digest,"definitionDigest":plan_digest(&hooks),"definitions":source.plan.entries.iter().zip(&hooks).map(|(d,h)|json!({"definition":d,"trusted":self.plugin_hooks.allowed(h),"readOnlyCommandTrusted":self.plugin_hooks.read_only_allowed(h)})).collect::<Vec<_>>(),"diagnostics":source.plan.diagnostics}));
        }
        Ok(json!({"data":rows}))
    }
    pub async fn plugin_hooks_configure(
        self: &Arc<Self>,
        p: areal_protocol::plugin_runtime::HooksConfigure,
    ) -> Result<Value> {
        let _configuration = self.plugin_hooks.configuration.lock().await;
        self.refresh_plugins().await?;
        let hooks: Vec<_> = self
            .plugin_hooks
            .plans
            .read()
            .unwrap()
            .iter()
            .filter(|h| h.plugin_id == p.id)
            .cloned()
            .collect();
        if hooks.is_empty() {
            return Err(Error::NotFound);
        }
        if hooks.iter().any(|h| h.package_digest != p.expected_digest)
            || plan_digest(&hooks) != p.definition_digest
        {
            return Err(invalid(
                "PLUGIN_HOOK_DEFINITION_CHANGED: review current package and hooks",
            ));
        }
        let mut candidate = self.plugin_hooks.trust.read().unwrap().clone();
        let read_only_revoked = !p.allow_read_only_commands
            && hooks.iter().any(|h| self.plugin_hooks.read_only_allowed(h));
        if !p.enabled || !p.trusted {
            candidate.retain(|k, _| !k.starts_with(&format!("{}:", p.id)));
        } else {
            for h in &hooks {
                candidate.insert(
                    Manager::key(h),
                    Trust {
                        enabled: true,
                        package: h.package_digest.clone(),
                        definition: h.definition.digest.clone(),
                        allow_read_only_commands: p.allow_read_only_commands
                            && matches!(
                                h.definition.handler,
                                areal_plugins::hooks::HookHandler::Command { .. }
                            ),
                    },
                );
            }
        }
        self.store
            .save_metadata("plugin-hook-trust", &candidate)
            .await
            .map_err(invalid)?;
        *self.plugin_hooks.trust.write().unwrap() = candidate;
        if !p.enabled || !p.trusted || read_only_revoked {
            for (_, (plugin, _, token)) in self.plugin_hooks.invocations.lock().unwrap().iter() {
                if plugin == &p.id {
                    token.cancel();
                }
            }
        }
        Ok(
            json!({"id":p.id,"installedDigest":p.expected_digest,"definitionDigest":p.definition_digest,"enabled":p.enabled,"trusted":p.trusted,"allowReadOnlyCommands":p.enabled&&p.trusted&&p.allow_read_only_commands}),
        )
    }
    pub async fn hook_acknowledge(
        self: &Arc<Self>,
        p: areal_protocol::plugin_runtime::HookAcknowledge,
    ) -> Result<Value> {
        if p.inspection.trim().is_empty() || p.inspection.len() > 8192 {
            return Err(invalid("bounded operator inspection required"));
        }
        let cell = self.raw_cell(&p.thread_id).await?;
        let mut state = cell.state.lock().await;
        if state
            .thread
            .desktop
            .as_ref()
            .is_some_and(|data| data.archived)
            && !state.thread.is_executable_side()
        {
            return Err(invalid("THREAD_ARCHIVED"));
        }
        if state.active.is_some() {
            return Err(Error::Conflict);
        }
        let mut candidate = if state.thread.is_executable_side()
            && state
                .thread
                .desktop
                .as_ref()
                .is_some_and(|data| data.archived)
        {
            self.store
                .read_thread(&p.thread_id)
                .await
                .map_err(invalid)?
        } else {
            state.thread.clone()
        };
        let r = candidate
            .desktop
            .get_or_insert_with(Default::default)
            .hook_runs
            .iter_mut()
            .find(|r| r.id == p.invocation_id && r.outcome == "unknown")
            .ok_or(Error::NotFound)?;
        r.inspection = Some(p.inspection);
        self.persist(&candidate).await?;
        state.thread = candidate;
        self.finish_side_close(&cell, &mut state).await?;
        Ok(json!({"threadId":p.thread_id,"invocationId":p.invocation_id,"acknowledged":true}))
    }
}

/// Native tools retain their actual argument schema. Shell payloads use Codex's
/// stable Bash command input; native file tools additionally match Write/Edit/Read.
pub(crate) fn tool_input(name: &str, args: &Value) -> (String, Value) {
    match name {
        "run_command" => (
            "Bash".into(),
            json!({"command":args.get("command").cloned().unwrap_or_else(||json!(args["argv"].as_array().map(|a|a.iter().map(|v|v.as_str().unwrap_or("")).collect::<Vec<_>>().join(" ")).unwrap_or_default()))}),
        ),
        "fs_write" | "fs_create" => ("Write".into(), args.clone()),
        "fs_apply_patches" => ("Edit".into(), args.clone()),
        "fs_read" | "read_file" => ("Read".into(), args.clone()),
        _ => (name.into(), args.clone()),
    }
}
pub(crate) fn updated_input(name: &str, original: &Value, updated: Value) -> anyhow::Result<Value> {
    if name == "run_command" {
        let command = updated
            .get("command")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("Bash hook rewrite requires command string"))?;
        let mut args = original.clone();
        args.as_object_mut()
            .context("tool arguments must be object")?
            .remove("argv");
        args["command"] = json!(command);
        Ok(args)
    } else {
        Ok(updated)
    }
}
