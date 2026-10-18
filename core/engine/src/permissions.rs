//! 权限模式和记忆由 Core 统一判定，客户端只提交已展示请求的回答。
use crate::*;
use areal_config::{ConfigSource, PermissionConfig, PermissionMode};
use areal_protocol::desktop::PermissionGrant;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Default, Serialize, Deserialize)]
pub(crate) struct ProjectGrants {
    pub workspace: String,
    pub grants: Vec<PermissionGrant>,
}

#[derive(Default)]
pub(crate) struct Permissions {
    pub config: std::sync::OnceLock<(PermissionConfig, Option<ConfigSource>)>,
    pub project: Mutex<ProjectGrants>,
}

impl Engine {
    pub fn set_permissions(
        &self,
        config: PermissionConfig,
        source: Option<ConfigSource>,
    ) -> anyhow::Result<()> {
        self.permissions
            .config
            .set((config, source))
            .map_err(|_| anyhow::anyhow!("permissions are already configured"))?;
        Ok(())
    }

    pub fn permission_config(&self) -> PermissionConfig {
        self.permissions
            .config
            .get()
            .map(|(c, _)| c.clone())
            .unwrap_or_default()
    }

    pub(crate) fn permission_grant(
        &self,
        tool: &str,
        arguments: &Value,
        generation: Option<&str>,
        restrictions: &Value,
    ) -> anyhow::Result<PermissionGrant> {
        // Browser 许可不得跨越人工接管或页面替换。公网操作保留具体目标和负载，
        // 避免本地开发站点或另一表单的许可被静默复用于搜索提交。
        let grant_arguments = if tool == "browser_v1" && arguments["plan"].is_object() {
            let plan = &arguments["plan"];
            json!({"origin":plan["origin"],"targetOrigin":plan["targetOrigin"],
                "pageId":plan["pageId"],"pageGeneration":plan["pageGeneration"],
                "controlEpoch":plan["controlEpoch"],"browserHostId":plan["browserHostId"],
                "hostGeneration":plan["hostGeneration"],"operation":plan["operation"],
                "targetUrl":plan["targetUrl"],"target":plan["target"],"action":plan["action"],
                "parameters":arguments["arguments"]["parameters"]})
        } else {
            arguments.clone()
        };
        let key = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&json!({
                "tool":tool,"arguments":grant_arguments,"generation":generation,
                "workspace":self.default_cwd(),"policy":self.permission_config(),"restrictions":restrictions,
                "runtime":self.runtime_capabilities()["capabilities"],
            }))?)
        );
        Ok(PermissionGrant {
            key,
            tool: tool.into(),
            arguments: arguments.clone(),
        })
    }

    pub(crate) async fn permission_identity(
        &self,
        cell: &Cell,
        tool: &str,
        args: &Value,
    ) -> (Option<String>, bool) {
        let bindings = cell.bindings.read().await;
        let name = if bindings.registry.get(tool).is_ok() {
            tool
        } else {
            args.get("tool").and_then(Value::as_str).unwrap_or(tool)
        };
        match bindings
            .registry
            .get(name)
            .ok()
            .map(|entry| entry.backend.clone())
        {
            Some(
                tools::Backend::Builtin
                | tools::Backend::Core
                | tools::Backend::Coordination
                | tools::Backend::Agent,
            ) => (None, true),
            Some(tools::Backend::Plugin(p)) => (Some(p.host.generation.clone()), true),
            Some(tools::Backend::Command(command)) => (
                Some(format!(
                    "{:x}",
                    Sha256::digest(serde_json::to_vec(&command).unwrap())
                )),
                true,
            ),
            Some(tools::Backend::Client) => (
                bindings.host.as_ref().map(|host| host.id().to_owned()),
                bindings.host.is_some()
                    && !(tool == "browser_v1" && args["operation"] == "describe"),
            ),
            // MCP 尚未提供可验证的连接代际，只允许单次回答。
            _ => (None, false),
        }
    }

    pub(crate) async fn permission_action(
        &self,
        cell: &Cell,
        tool: &str,
        args: &Value,
    ) -> &'static str {
        let config = self.permission_config();
        for (rules, action) in [
            (&config.deny, "deny"),
            (&config.ask, "ask"),
            (&config.allow, "allow"),
        ] {
            if rules.iter().any(|pattern| matches_tool(pattern, tool)) {
                return action;
            }
        }
        if config.mode == PermissionMode::Yolo {
            return "allow";
        }
        let bindings = cell.bindings.read().await;
        let Some(entry) = bindings.registry.get(tool).ok() else {
            return "ask";
        };
        match &entry.backend {
            tools::Backend::Builtin => {
                if matches!(
                    tool,
                    "read_file" | "search_files" | "image_read" | "fs_read" | "fs_stat" | "fs_list"
                ) {
                    let path = args.get("path").and_then(Value::as_str).unwrap_or(".");
                    if self.runtime.as_ref().is_some_and(|runtime| {
                        tools::resource_uri(path, runtime)
                            .is_ok_and(|uri| !uri.starts_with("workspace://host"))
                    }) {
                        return "allow";
                    }
                }
                if matches!(tool, "read_process" | "terminate_process" | "task_state") {
                    return "allow";
                }
            }
            tools::Backend::Core
                if matches!(
                    tool,
                    "ask_user_question"
                        | "development_service_inspect"
                        | "read_tool_result"
                        | "read_history"
                        | "plan_update"
                        | "plan_read"
                        | "task_state"
                        | "goal_read"
                        | "goal_update"
                ) =>
            {
                return "allow";
            }
            tools::Backend::Coordination if tool.starts_with("agent_") => return "allow",
            _ => {}
        }
        "ask"
    }

    pub async fn permission_read(&self, thread_id: &str) -> Result<Value> {
        let thread = self.read(thread_id, false).await?;
        let project = self.permissions.project.lock().await;
        Ok(json!({"configuration": self.permission_config(),
            "source":self.permissions.config.get().and_then(|(_,source)| source.as_ref()),
            "sandbox":self.sandbox(), "workspace":self.default_cwd(),
            "session":thread.desktop.as_ref().map(|d| &d.permission_grants),
            "project":if project.workspace == self.default_cwd() { project.grants.clone() } else { Vec::new() },
            "projectFile":self.store.root().join("desktop/permissions.json")}))
    }

    pub async fn permission_forget(
        self: &Arc<Self>,
        thread_id: String,
        project: bool,
    ) -> Result<Value> {
        self.mutate(move |engine| async move {
            let cell = engine.cell(&thread_id).await?;
            let mut state = cell.state.lock().await;
            // 忙碌时拒绝撤销，避免已受理副作用被误认为已撤回。
            if state.active.is_some() {
                return Err(Error::Conflict);
            }
            if project {
                let mut saved = engine.permissions.project.lock().await;
                let empty = ProjectGrants {
                    workspace: engine.default_cwd(),
                    grants: Vec::new(),
                };
                engine
                    .store
                    .save_metadata("permissions", &empty)
                    .await
                    .map_err(|e| Error::Storage(e.to_string()))?;
                *saved = empty;
            } else {
                let mut thread = state.thread.clone();
                thread
                    .desktop
                    .get_or_insert_with(Default::default)
                    .permission_grants
                    .clear();
                engine.persist(&thread).await?;
                state.thread = thread;
            }
            Ok(json!({"cleared":true}))
        })
        .await
    }
}

pub(crate) fn forced(
    config: Option<&areal_protocol::desktop::EffectiveConfig>,
    tool: &str,
    args: &Value,
) -> bool {
    // Hook 可按父工具要求审批，但预批准只匹配当前操作，不能沿父工具传播。
    let parent_tool = args.get("tool").and_then(Value::as_str);
    let matches = |name: &str| name == "*" || name == tool || parent_tool == Some(name);
    config.is_some_and(|c| {
        c.profile
            .as_ref()
            .is_some_and(|p| p.approval_tools.iter().any(|n| matches(n)))
            || (c.options.approval_tools.iter().any(|n| matches(n))
                && !c
                    .options
                    .preapproved_tools
                    .iter()
                    .any(|n| n == "*" || n == tool))
    })
}

pub(crate) fn restrictions(config: Option<&areal_protocol::desktop::EffectiveConfig>) -> Value {
    // 模型切换和配置 CAS 修订不扩大权限，不应导致相同请求重复询问。
    let default = areal_protocol::desktop::EffectiveConfig::default();
    let c = config.unwrap_or(&default);
    json!({
        "readOnly":c.read_only, "toolAllowlist":c.tool_allowlist,
        "profile":c.profile.as_ref().map(|p| (&p.id, &p.revision)),
        "approvalTools":c.options.approval_tools,"preapprovedTools":c.options.preapproved_tools,
    })
}

pub(crate) fn remember(grants: &mut Vec<PermissionGrant>, grant: PermissionGrant) -> Result<()> {
    if grants.iter().any(|g| g.key == grant.key) {
        return Ok(());
    }
    if grants.len() >= 64
        || serde_json::to_vec(&grants)
            .map_err(|e| Error::Invalid(e.to_string()))?
            .len()
            + serde_json::to_vec(&grant)
                .map_err(|e| Error::Invalid(e.to_string()))?
                .len()
            > 128 * 1024
    {
        return Err(Error::Exhausted(
            "permission memory is full; clear rules or allow once".into(),
        ));
    }
    grants.push(grant);
    Ok(())
}

pub(crate) fn matches_tool(pattern: &str, tool: &str) -> bool {
    let (mut p, mut t, mut star, mut restart) = (0, 0, None, 0);
    let (pattern, tool) = (pattern.as_bytes(), tool.as_bytes());
    while t < tool.len() {
        if p < pattern.len() && pattern[p] == tool[t] {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            p += 1;
            restart = t;
        } else if let Some(s) = star {
            restart += 1;
            t = restart;
            p = s + 1;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use areal_protocol::desktop::EffectiveConfig;
    #[test]
    fn readonly_preapproval_does_not_approve_hooks_or_external_tool_arguments() {
        let mut config = EffectiveConfig::default();
        config.options.approval_tools = vec!["*".into()];
        config.options.preapproved_tools = vec!["fs_read".into()];
        assert!(!forced(Some(&config), "fs_read", &json!({"path":"file"})));
        assert!(forced(Some(&config), "fs_create", &json!({"path":"file"})));
        assert!(forced(
            Some(&config),
            "hook:audit",
            &json!({"tool":"fs_read"})
        ));
        assert!(forced(
            Some(&config),
            "external_tool",
            &json!({"tool":"fs_read"})
        ));
        config.options.preapproved_tools.push("hook:audit".into());
        assert!(!forced(
            Some(&config),
            "hook:audit",
            &json!({"tool":"fs_read"})
        ));
    }
    #[test]
    fn profile_approval_remains_mandatory() {
        let mut config = EffectiveConfig::default();
        config.options.preapproved_tools = vec!["*".into()];
        config.profile = Some(serde_json::from_value(json!({"id":"test","revision":"1","displayName":"test","instructions":"","approvalTools":["fs_read"]})).unwrap());
        assert!(forced(Some(&config), "fs_read", &json!({})));
        assert!(forced(
            Some(&config),
            "hook:audit",
            &json!({"tool":"fs_read"})
        ));
    }
    #[test]
    fn legacy_and_explicit_defaults_share_grants_but_readonly_does_not() {
        let mut config = areal_protocol::desktop::EffectiveConfig::default();
        assert_eq!(restrictions(None), restrictions(Some(&config)));
        config.revision += 1;
        assert_eq!(restrictions(None), restrictions(Some(&config)));
        config.read_only = true;
        assert_ne!(restrictions(None), restrictions(Some(&config)));
    }

    #[test]
    fn tool_patterns_do_not_match_unrelated_tools() {
        assert!(matches_tool("mcp__*__read*", "mcp__repo__read_file"));
        assert!(!matches_tool("read*", "fs_write"));
        assert!(!matches_tool("run_command", "run_command_extra"));
        assert!(matches_tool("*", "run_command"));
    }
}
