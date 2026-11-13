//! 扩展登记归 Host：插件库写入、市场来源与启用选择都在这里完成，不借任何项目后台。
//! 项目 Core 只读登记、建立连接和执行；写入后通知在线的 Core 重新读取登记。
use super::Host;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::path::PathBuf;

pub(super) const METHODS: &[&str] = &["plugins.read", "plugins.command"];

/// 插件库目录，与 Core 读取的位置一致（`$AREAL_HARNESS_HOME/plugins`，默认 `~/.areal/plugins`）。
pub(crate) fn root() -> Result<PathBuf> {
    let home = match std::env::var_os("AREAL_HARNESS_HOME") {
        Some(home) => {
            let home = PathBuf::from(home);
            ensure!(home.is_absolute(), "AREAL_HARNESS_HOME must be absolute");
            home
        }
        None => std::env::home_dir()
            .context("home unavailable")?
            .join(".areal"),
    };
    Ok(home.join("plugins"))
}

fn user_home() -> Option<PathBuf> {
    std::env::home_dir()
}

/// 内置默认市场，Host 在用户打开插件市场时登记并定期拉新。
const DEFAULT_MARKETPLACE: &str = "https://github.com/Sailfishc/areal-plugin.git";
const READS: &[&str] = &["plugins", "plugin", "mcp"];
const WRITES: &[&str] = &[
    "pluginInstall",
    "pluginUninstall",
    "pluginConfigure",
    "pluginResolve",
    "marketplaceAdd",
    "marketplaceAddGit",
    "marketplaceRemove",
    "marketplaceUpdate",
    "marketplaceSyncDefault",
    "mcpSave",
    "mcpRemove",
];

fn fields(operation: &str) -> Option<&'static [&'static str]> {
    Some(match operation {
        "plugins" | "mcp" => &["projectId"],
        "plugin" => &["projectId", "id"],
        // 安装是用户级的，projectId 只用来发现该项目工作区里的插件市场。
        "pluginInstall" => &[
            "id",
            "projectId",
            "expectedRevision",
            "source",
            "expectedDigest",
        ],
        "pluginUninstall" | "pluginResolve" => &["id", "expectedRevision"],
        "pluginConfigure" => &["id", "projectId", "enabled", "expectedRevision"],
        "marketplaceAdd" | "marketplaceRemove" => &["root", "expectedRevision"],
        "marketplaceAddGit" => &["url", "refName", "sparsePaths", "expectedRevision"],
        "marketplaceUpdate" | "marketplaceSyncDefault" => &["expectedRevision"],
        "mcpSave" => &["name", "server", "expectedRevision"],
        "mcpRemove" => &["name", "expectedRevision"],
        _ => return None,
    })
}

pub(crate) fn is_read(operation: &str) -> bool {
    READS.contains(&operation)
}
pub(crate) fn is_write(operation: &str) -> bool {
    WRITES.contains(&operation)
}

fn text<'a>(params: &'a Value, key: &str) -> Result<&'a str> {
    params[key]
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= 4096 && !v.contains('\0'))
        .context("INVALID_PARAMS")
}
fn revision(params: &Value) -> Result<u64> {
    params["expectedRevision"]
        .as_u64()
        .context("INVALID_PARAMS")
}
fn absolute(params: &Value, key: &str) -> Result<PathBuf> {
    let path = PathBuf::from(text(params, key)?);
    ensure!(path.is_absolute(), "INVALID_PARAMS");
    Ok(path)
}

fn saved_inputs(home: &std::path::Path, project: &str) -> Result<Option<crate::LaunchInputs>> {
    areal_local_service::storage::read_optional(
        &home
            .join("host/launch")
            .join(areal_local_service::storage::digest(project.as_bytes()))
            .join("inputs.json"),
    )
}

/// 项目视图用于读取项目里的市场和本项目的启用结果；没有项目时是用户级视图。
fn store(host: &Host, project: Option<&str>) -> Result<areal_plugins::Store> {
    let root = root()?;
    match project {
        None => areal_plugins::Store::open_user(root, user_home()),
        Some(project) => {
            // 网页传 Host 项目 ID；桌面界面传后台 alias，按当前后台的绑定换回。
            let known = host.slots.borrow().contains_key(project);
            let project = if known {
                project.to_owned()
            } else {
                backend_project_id(host, project)?
            };
            let project = project.as_str();
            let workspace = host
                .slots
                .borrow()
                .get(project)
                .map(|slot| slot.registration.workspace.clone())
                .context("RESOURCE_UNAVAILABLE")?;
            // 项目 Core 按启动时的配置目录读插件库；这里跟它读同一处，否则装完 Core 看不到。
            let (root, homedir) = match saved_inputs(&host.home, project)? {
                Some(inputs) => (
                    inputs.config_home.join("plugins"),
                    inputs.homedir.or_else(user_home),
                ),
                None => (root, user_home()),
            };
            areal_plugins::Store::open(root, workspace, homedir)
        }
    }
}

/// Host 网关入口：读直接返回；写返回已受理回执。插件库写入带 expectedRevision，
/// 没有回执时客户端重读当前登记核对，不重放。
pub(super) async fn gateway(host: &Host, method: &str, request: &Value) -> Result<Value> {
    let params = &request["params"];
    if method == "plugins.read" {
        ensure!(request.get("commandId").is_none(), "INVALID_PARAMS");
        return self::request(host, method, params).await;
    }
    let command = request["commandId"].as_str().context("INVALID_PARAMS")?;
    let receipt = self::request(host, method, params).await?;
    Ok(
        json!({"commandId":command,"method":method,"admissionState":"accepted","submissionUnknown":false,"receipt":receipt}),
    )
}

pub(super) async fn request(host: &Host, method: &str, params: &Value) -> Result<Value> {
    let operation = params["operation"].as_str().context("INVALID_PARAMS")?;
    let allowed = fields(operation).context("INVALID_PARAMS")?;
    ensure!(
        if method == "plugins.read" {
            is_read(operation)
        } else {
            is_write(operation)
        },
        "INVALID_PARAMS"
    );
    ensure!(
        params
            .as_object()
            .context("INVALID_PARAMS")?
            .keys()
            .all(|key| key == "operation" || allowed.contains(&key.as_str())),
        "INVALID_PARAMS"
    );
    let project = params
        .get("projectId")
        .map(|_| text(params, "projectId"))
        .transpose()?;
    let store = store(host, project)?;
    let params = params.clone();
    let operation = operation.to_owned();
    let value = tokio::task::spawn_blocking(move || execute(&store, &operation, &params))
        .await
        .context("plugin operation interrupted")??;
    if method == "plugins.command" {
        host.schedules.connections.refresh_plugins(host).await;
    }
    Ok(value)
}

fn execute(store: &areal_plugins::Store, operation: &str, p: &Value) -> Result<Value> {
    let value = match operation {
        "plugins" => serde_json::to_value(store.list()?)?,
        "plugin" => serde_json::to_value(store.read(text(p, "id")?)?)?,
        "mcp" => {
            let data: Vec<_> = store
                .local_mcp_servers()?
                .into_iter()
                .map(|(name, server)| {
                    json!({"name": name, "id": format!("{name}@{}", areal_plugins::LOCAL_MCP_MARKETPLACE), "server": server})
                })
                .collect();
            json!({"revision": store.list()?.revision, "data": data})
        }
        // 安装只有用户级一份；项目里只有“在此项目启用”。
        "pluginInstall" => serde_json::to_value(store.install(
            text(p, "id")?,
            "user",
            revision(p)?,
            &absolute(p, "source")?,
            text(p, "expectedDigest")?,
        )?)?,
        "pluginUninstall" => serde_json::to_value(store.uninstall(text(p, "id")?, revision(p)?)?)?,
        "pluginConfigure" => {
            let scope = if p.get("projectId").is_some() {
                "project"
            } else {
                "user"
            };
            let enabled = p["enabled"].as_bool().context("INVALID_PARAMS")?;
            serde_json::to_value(store.configure(text(p, "id")?, scope, enabled, revision(p)?)?)?
        }
        "pluginResolve" => {
            serde_json::to_value(store.resolve_remote(text(p, "id")?, revision(p)?)?)?
        }
        "marketplaceAdd" => {
            serde_json::to_value(store.add_marketplace(&absolute(p, "root")?, revision(p)?)?)?
        }
        "marketplaceRemove" => {
            serde_json::to_value(store.remove_marketplace(&absolute(p, "root")?, revision(p)?)?)?
        }
        "marketplaceAddGit" => {
            let sparse: Vec<String> = match p.get("sparsePaths") {
                Some(v) => serde_json::from_value(v.clone()).context("INVALID_PARAMS")?,
                None => Vec::new(),
            };
            let reference = p.get("refName").map(|_| text(p, "refName")).transpose()?;
            serde_json::to_value(store.add_git_marketplace_sparse(
                text(p, "url")?,
                reference,
                &sparse,
                revision(p)?,
            )?)?
        }
        "marketplaceUpdate" => serde_json::to_value(store.update_marketplaces(revision(p)?)?)?,
        "marketplaceSyncDefault" => {
            // 开发与隔离测试可用 AREAL_DEFAULT_MARKETPLACE 换地址，填 off 关闭。
            let url = std::env::var("AREAL_DEFAULT_MARKETPLACE")
                .unwrap_or_else(|_| DEFAULT_MARKETPLACE.into());
            if url == "off" {
                serde_json::to_value(store.list()?)?
            } else {
                serde_json::to_value(store.sync_default_marketplace(&url, "main", revision(p)?)?)?
            }
        }
        "mcpSave" => {
            ensure!(p["server"].is_object(), "INVALID_PARAMS");
            serde_json::to_value(store.save_local_mcp(
                text(p, "name")?,
                &p["server"],
                revision(p)?,
            )?)?
        }
        "mcpRemove" => {
            serde_json::to_value(store.remove_local_mcp(text(p, "name")?, revision(p)?)?)?
        }
        _ => anyhow::bail!("INVALID_PARAMS"),
    };
    Ok(value)
}

/// 过渡：到 0.2.0 删。停机导入：Host 启动、拉起任何项目 Core 之前做一次。
/// 1. 插件库项目选择改按项目身份记录；
/// 2. 旧的“直接添加的 MCP”（工作台 resources.json 的用户级条目、各项目 Core 的
///    `desktop/mcp.json`）转成只含一个服务的本地插件。单条失败只跳过那一条。
pub(super) fn import(host: &Host, projects: &[crate::ProjectRegistration]) {
    let result = root().and_then(|root| {
        let homes = host.migration.power_sources()?.into_values().collect();
        import_from(&root, homes, projects)
    });
    if let Err(error) = result {
        eprintln!("plugin store import failed: {error:#}");
    }
    // 项目 Core 读各自启动时的配置目录；与 Host 目录不同的，也在这次停机导入里一并处理。
    // 单个目录失败只记日志：插件读取会报错，项目照常启动。
    import_project_roots(&host.home, root().ok(), projects);
}

fn import_project_roots(
    home: &std::path::Path,
    host_root: Option<PathBuf>,
    projects: &[crate::ProjectRegistration],
) {
    let roots: BTreeSet<_> = projects
        .iter()
        .filter_map(|project| saved_inputs(home, &project.project_id).ok().flatten())
        .map(|inputs| inputs.config_home.join("plugins"))
        .filter(|root| Some(root) != host_root.as_ref())
        .collect();
    for root in roots {
        if let Err(error) = areal_plugins::Store::import_path_keyed_state(&root) {
            eprintln!(
                "plugin store import failed for {}: {error:#}",
                root.display()
            );
        }
    }
}

const STANDALONE_IMPORTED: &str = ".standalone-mcp-imported";

fn import_from(
    root: &std::path::Path,
    gui_homes: Vec<PathBuf>,
    projects: &[crate::ProjectRegistration],
) -> Result<()> {
    let root = root.to_owned();
    if root.join("state.json").exists() {
        areal_plugins::Store::import_path_keyed_state(&root)?;
    }
    let marker = root
        .join(areal_plugins::LOCAL_MCP_MARKETPLACE)
        .join(STANDALONE_IMPORTED);
    if marker.exists() {
        return Ok(());
    }
    let mut user = Vec::new();
    for home in gui_homes {
        let Ok(bytes) = std::fs::read(home.join("resources.json")) else {
            continue;
        };
        let value: Value = serde_json::from_slice(&bytes).unwrap_or_default();
        for entry in value["mcp"].as_array().into_iter().flatten() {
            if let (Some(id), Some(runtime)) = (entry["id"].as_str(), entry["runtimeId"].as_str()) {
                user.push((id.to_owned(), runtime.to_owned(), entry["config"].clone()));
            }
        }
    }
    let store = areal_plugins::Store::open_user(root.clone(), user_home())?;
    // 值记录配置和是否来自用户级；同名同配置复用已导入的插件，项目级来源仍要在本项目启用。
    let mut saved: std::collections::BTreeMap<String, (Value, bool)> = Default::default();
    let mut save = |name: &str, server: Value, user_level: bool| -> Result<Option<String>> {
        let mut candidate = name.to_owned();
        for n in 2.. {
            match saved.get(&candidate) {
                Some((existing, true)) if *existing == server => return Ok(None),
                Some((existing, false)) if *existing == server => return Ok(Some(candidate)),
                Some(_) => candidate = format!("{name}-{n}"),
                None => break,
            }
        }
        let revision = store.list()?.revision;
        store.save_local_mcp(&candidate, &server, revision)?;
        saved.insert(candidate.clone(), (server, user_level));
        Ok(Some(candidate))
    };
    let runtime_ids: Vec<_> = user.iter().map(|(_, runtime, _)| runtime.clone()).collect();
    for (id, _, config) in &user {
        match standalone_server(config) {
            Ok(server) => {
                if let Err(error) = save(id, server, true) {
                    eprintln!("standalone MCP {id} not imported: {error:#}");
                }
            }
            Err(error) => eprintln!("standalone MCP {id} not imported: {error:#}"),
        }
    }
    for project in projects {
        let path = project.data_dir.join("desktop/mcp.json");
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let records: serde_json::Map<String, Value> =
            serde_json::from_slice(&bytes).unwrap_or_default();
        for (id, record) in records {
            if runtime_ids.contains(&id) {
                continue;
            }
            let imported =
                standalone_server(&record["config"]).and_then(|server| save(&id, server, false));
            match imported {
                Ok(Some(name)) => {
                    // 只在原项目里启用：用户默认关，项目里开。
                    let plugin = format!("{name}@{}", areal_plugins::LOCAL_MCP_MARKETPLACE);
                    let result = (|| -> Result<()> {
                        let revision = store.list()?.revision;
                        store.configure(&plugin, "user", false, revision)?;
                        let scoped = areal_plugins::Store::open(
                            root.clone(),
                            project.workspace.clone(),
                            user_home(),
                        )?;
                        let revision = scoped.list()?.revision;
                        scoped.configure(&plugin, "project", true, revision)?;
                        Ok(())
                    })();
                    if let Err(error) = result {
                        eprintln!("standalone MCP {id} scope not imported: {error:#}");
                    }
                }
                Ok(None) => {}
                Err(error) => eprintln!("standalone MCP {id} not imported: {error:#}"),
            }
        }
    }
    std::fs::create_dir_all(marker.parent().context("marker parent")?)?;
    std::fs::write(&marker, b"")?;
    Ok(())
}

/// 过渡：到 0.2.0 删。旧独立 MCP 配置（`areal_mcp::ServerConfig` 的 JSON）转成 Codex `.mcp.json` 的服务声明。
/// 密钥仍按环境变量名引用，不在这里读取或写入值。
fn standalone_server(config: &Value) -> Result<Value> {
    let config: areal_mcp::ServerConfig =
        serde_json::from_value(config.clone()).context("invalid standalone MCP config")?;
    let mut server = match config.transport {
        areal_mcp::TransportConfig::Stdio {
            command,
            args,
            cwd,
            env_vars,
        } => {
            let mut server = json!({"command": command, "args": args});
            if let Some(cwd) = cwd {
                server["cwd"] = json!(cwd);
            }
            if !env_vars.is_empty() {
                server["env_vars"] = json!(env_vars);
            }
            server
        }
        areal_mcp::TransportConfig::StreamableHttp {
            url,
            bearer_token_env,
        } => {
            let mut server = json!({"url": url});
            if let Some(name) = bearer_token_env {
                server["bearer_token_env_var"] = json!(name);
            }
            server
        }
    };
    server["startup_timeout_ms"] = json!(config.startup_timeout_ms);
    if let Some(ms) = config.call_timeout_ms {
        server["tool_timeout_sec"] = json!(ms as f64 / 1000.0);
    }
    if let Some(tools) = config.enabled_tools {
        server["enabled_tools"] = json!(tools);
    }
    Ok(server)
}

/// `backend_project_alias` 的反向：桌面界面按后台 alias 访问 Host 方法时换回 Host 项目 ID。
pub(super) fn backend_project_id(host: &Host, alias: &str) -> Result<String> {
    let source = host
        .gateway
        .workbench
        .backend_source()
        .context("RESOURCE_UNAVAILABLE")?;
    let registrations: Vec<_> = host
        .slots
        .borrow()
        .values()
        .map(|slot| slot.registration.clone())
        .collect();
    let mut ids = host
        .migration
        .remote_bindings(&source, &registrations)?
        .into_iter()
        .filter(|(_, bound)| bound == alias);
    let (id, _) = ids.next().context("RESOURCE_UNAVAILABLE")?;
    ensure!(ids.next().is_none(), "RESYNC_REQUIRED");
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::standalone_server;
    use serde_json::Value;
    use serde_json::json;

    #[test]
    fn project_writes_land_where_its_core_reads_plugins() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let host = super::super::schedules::tests::fixture(&root);
        let workspace = root.join("workspace");
        let config_home = root.join("config");
        let saved = host
            .home
            .join("host/launch")
            .join(areal_local_service::storage::digest(b"project"))
            .join("inputs.json");
        areal_local_service::storage::private_dir(saved.parent().unwrap()).unwrap();
        areal_local_service::storage::write(
            &saved,
            &crate::LaunchInputs {
                workspace: workspace.clone(),
                cwd: workspace,
                config_home: config_home.clone(),
                homedir: Some(root.clone()),
                config_path: None,
                deployment_path: None,
                schedule_preparation: None,
                environment: Default::default(),
                credential_names: vec![],
                options: Default::default(),
            },
        )
        .unwrap();
        let store = super::store(&host, Some("project")).unwrap();
        let server = json!({"command":"docs-mcp"});
        store
            .save_local_mcp("docs", &server, store.list().unwrap().revision)
            .unwrap();
        // Core 以启动时的配置目录为家，从这里读插件库。
        let core_view =
            areal_plugins::Store::open_user(config_home.join("plugins"), Some(root)).unwrap();
        assert!(
            core_view
                .list()
                .unwrap()
                .data
                .iter()
                .any(|row| row.installed)
        );
    }

    #[test]
    fn standalone_servers_keep_transport_secrets_by_reference_and_timeouts() {
        let temp = tempfile::tempdir().unwrap();
        let store = areal_plugins::Store::open_user(temp.path().join("plugins"), None).unwrap();
        let stdio = standalone_server(&json!({"transport":{"type":"stdio","command":"docs-mcp","args":["--stdio"],"envVars":["DOCS_TOKEN"]},"startupTimeoutMs":5000,"callTimeoutMs":90000,"enabledTools":["search"]})).unwrap();
        assert_eq!(
            stdio,
            json!({"command":"docs-mcp","args":["--stdio"],"env_vars":["DOCS_TOKEN"],"startup_timeout_ms":5000,"tool_timeout_sec":90.0,"enabled_tools":["search"]})
        );
        store.save_local_mcp("docs", &stdio, 0).unwrap();
        let http = standalone_server(&json!({"transport":{"type":"streamableHttp","url":"https://mcp.example.test/mcp","bearerTokenEnv":"MCP_TOKEN"}})).unwrap();
        assert_eq!(http["bearer_token_env_var"], "MCP_TOKEN");
        let revision = store.list().unwrap().revision;
        let detail = store.save_local_mcp("remote", &http, revision).unwrap();
        assert!(detail.installed && detail.enabled);
        assert!(standalone_server(&json!({"transport":{"type":"ftp"}})).is_err());
    }

    #[test]
    fn standalone_mcp_imports_once_with_original_scope() {
        let temp = tempfile::tempdir().unwrap();
        let (gui, data, workspace, other) = (
            temp.path().join("gui"),
            temp.path().join("data"),
            temp.path().join("project"),
            temp.path().join("other"),
        );
        for dir in [&gui, &data.join("desktop"), &workspace, &other] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let http =
            json!({"transport":{"type":"streamableHttp","url":"https://mcp.example.test/mcp"}});
        std::fs::write(gui.join("resources.json"), json!({"revision":1,"skills":{},"mcp":[{"id":"docs","runtimeId":"user-docs","config":http}]}).to_string()).unwrap();
        std::fs::write(data.join("desktop/mcp.json"), json!({
            "user-docs":{"id":"user-docs","revision":1,"directoryRevision":0,"config":http},
            "local":{"id":"local","revision":1,"directoryRevision":0,"config":{"transport":{"type":"stdio","command":"local-mcp"}}},
            "broken":{"id":"broken","revision":1,"directoryRevision":0,"config":{"transport":{"type":"nope"}}}
        }).to_string()).unwrap();
        let project = crate::ProjectRegistration {
            project_id: "p".into(),
            workspace: workspace.clone(),
            data_dir: data.clone(),
            source: crate::ProjectSource::Cli,
            default_binding: false,
        };
        // 第二个项目有同名同配置的 MCP：复用同一插件，也在第二个项目里启用。
        let (second_data, second) = (temp.path().join("data2"), temp.path().join("second"));
        std::fs::create_dir_all(second_data.join("desktop")).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        std::fs::write(second_data.join("desktop/mcp.json"), json!({
            "local":{"id":"local","revision":1,"directoryRevision":0,"config":{"transport":{"type":"stdio","command":"local-mcp"}}}
        }).to_string()).unwrap();
        let projects = [
            project.clone(),
            crate::ProjectRegistration {
                project_id: "p2".into(),
                workspace: second.clone(),
                data_dir: second_data,
                ..project.clone()
            },
        ];
        let root = temp.path().join("plugins");
        super::import_from(&root, vec![gui.clone()], &projects).unwrap();
        let view = |workspace: &std::path::Path| {
            areal_plugins::Store::open(root.clone(), workspace.into(), None)
                .unwrap()
                .list()
                .unwrap()
        };
        let enabled = |list: &areal_plugins::PluginList, id: &str| {
            list.data
                .iter()
                .find(|d| d.id == id)
                .map(|d| (d.installed, d.enabled))
        };
        let here = view(&workspace);
        assert_eq!(enabled(&here, "docs@local-mcp"), Some((true, true)));
        assert_eq!(enabled(&here, "local@local-mcp"), Some((true, true)));
        assert_eq!(enabled(&here, "user-docs@local-mcp"), None);
        assert_eq!(enabled(&here, "broken@local-mcp"), None);
        assert_eq!(
            enabled(&view(&second), "local@local-mcp"),
            Some((true, true))
        );
        assert_eq!(enabled(&view(&second), "local-2@local-mcp"), None);
        let elsewhere = view(&other);
        assert_eq!(enabled(&elsewhere, "docs@local-mcp"), Some((true, true)));
        assert_eq!(enabled(&elsewhere, "local@local-mcp"), Some((true, false)));
        // 第二次启动不重复导入。
        std::fs::remove_dir_all(root.join("local-mcp/plugins/docs")).unwrap();
        super::import_from(&root, vec![gui], &projects).unwrap();
        assert!(!root.join("local-mcp/plugins/docs").exists());
    }
    #[test]
    fn startup_imports_each_project_configuration_home_without_blocking_others() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("service");
        let project = |id: &str| {
            let workspace = temp.path().join(id);
            std::fs::create_dir_all(&workspace).unwrap();
            let config_home = temp.path().join(format!("{id}-config"));
            let plugins = config_home.join("plugins");
            std::fs::create_dir_all(&plugins).unwrap();
            let saved = home
                .join("host/launch")
                .join(areal_local_service::storage::digest(id.as_bytes()));
            std::fs::create_dir_all(&saved).unwrap();
            let inputs = crate::LaunchInputs {
                workspace: workspace.clone(),
                cwd: workspace.clone(),
                config_home,
                homedir: None,
                config_path: None,
                deployment_path: None,
                schedule_preparation: None,
                environment: Default::default(),
                credential_names: Vec::new(),
                options: Default::default(),
            };
            areal_local_service::storage::write(&saved.join("inputs.json"), &inputs).unwrap();
            (
                crate::ProjectRegistration {
                    project_id: id.into(),
                    workspace: workspace.clone(),
                    data_dir: temp.path().join(format!("{id}-data")),
                    source: crate::ProjectSource::Cli,
                    default_binding: false,
                },
                workspace,
                plugins,
            )
        };
        let (broken, _, broken_root) = project("broken");
        std::fs::write(broken_root.join("state.json"), b"invalid plugin state").unwrap();
        let (old, workspace, old_root) = project("old");
        let key = workspace.to_string_lossy().into_owned();
        std::fs::write(
            old_root.join("state.json"),
            json!({"revision":6,"projects":{key.as_str():{"old@local":false}}}).to_string(),
        )
        .unwrap();
        super::import_project_roots(&home, None, &[broken, old]);
        // 坏的状态文件原样保留、不阻断其他项目；旧格式按项目身份导入，原选择保留。
        assert_eq!(
            std::fs::read(broken_root.join("state.json")).unwrap(),
            b"invalid plugin state"
        );
        let view = areal_plugins::Store::open(old_root.clone(), workspace.clone(), None).unwrap();
        assert_eq!(view.list().unwrap().revision, 7);
        let state: Value =
            serde_json::from_slice(&std::fs::read(old_root.join("state.json")).unwrap()).unwrap();
        assert_eq!(state["projects"][key.as_str()]["old@local"], false);
    }
}
