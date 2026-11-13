//! 插件管理命令。插件库登记（市场、安装、启用）直接写插件库，与 Host 同一把文件锁；
//! 连接、认证、钩子信任等运行态操作仍交给项目 Core。
use anyhow::{Context, Result, ensure};
use clap::{Subcommand, ValueEnum};
use serde_json::{Value, json};
use std::path::PathBuf;

#[derive(clap::Args)]
pub struct Options {
    #[arg(long, global = true)]
    workspace: Option<PathBuf>,
    #[arg(long, global = true)]
    config: Option<PathBuf>,
    #[arg(long, global = true)]
    data_dir: Option<PathBuf>,
    #[arg(long, global = true)]
    json: bool,
    #[arg(long, global = true)]
    config_home: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// 直接读取插件文件，不启动或连接 Core 服务。
    Snapshot {
        #[arg(long)]
        id: Option<String>,
    },
    /// 报告插件静态信息，不推断实时连接状态。
    Doctor,
    List,
    Read {
        id: String,
    },
    /// Discover a local marketplace from its root.
    MarketplaceAdd {
        root: PathBuf,
    },
    /// 显式解析远程来源；完成后先 read 检查固定版本和摘要。
    Resolve {
        id: String,
    },
    /// 登记或刷新 Git marketplace，不安装或执行其中的插件。
    MarketplaceAddGit {
        url: String,
        #[arg(long)]
        ref_name: Option<String>,
    },
    MarketplaceRemove {
        root: PathBuf,
    },
    MarketplaceUpdate,
    /// 安装已检查的本地包或已解析远程候选；不执行安装脚本。
    Install {
        id: String,
    },
    /// 保存普通配置值或可信凭据引用，不接受秘密明文。
    Configure {
        id: String,
        #[arg(long)]
        values_file: PathBuf,
        #[arg(long = "clear")]
        clear_keys: Vec<String>,
    },
    /// 链接已安装包的本地目录，后续变化发布为新快照。
    DevLink {
        id: String,
        #[arg(long)]
        expected_digest: String,
    },
    DevUnlink {
        id: String,
    },
    Enable {
        id: String,
        #[arg(long, default_value = "user", value_parser = ["user", "project"])]
        scope: String,
    },
    Disable {
        id: String,
        #[arg(long, default_value = "user", value_parser = ["user", "project"])]
        scope: String,
    },
    Uninstall {
        id: String,
    },
    Setup {
        id: String,
        #[arg(long)]
        thread: Option<String>,
    },
    /// 信任并连接明确检查过的安装摘要，允许启动该包的 MCP。
    Connect {
        id: String,
        #[arg(long)]
        expected_digest: String,
    },
    Disconnect {
        id: String,
    },
    McpList,
    HooksList,
    /// Review current hooks separately from installation and MCP connection trust.
    HooksTrust {
        id: String,
        #[arg(long)]
        expected_digest: String,
        #[arg(long)]
        definition_digest: String,
        /// Independently allow command hooks in ordinary read-only child tasks: workspace read-only,
        /// private scratch and plugin data writable, no network or provider secrets.
        #[arg(long)]
        allow_read_only_commands: bool,
    },
    HooksRevoke {
        id: String,
    },

    /// 认证操作直接访问当前认证状态，不产生持久管理收据。
    Auth {
        id: String,
        server: String,
        #[arg(value_enum)]
        operation: AuthOperation,
    },
    /// 仅引用 Core 启动时已配置的受保护凭据，不接受 token 或端点。
    ConnectorConfigure {
        id: String,
        connector_id: String,
        #[arg(long, default_value = "github", value_parser = ["github"])]
        provider: String,
        #[arg(long)]
        credential_ref: String,
    },
    /// Inspect a prior accepted request. Never replay an unknown mutation.
    Submission {
        request_id: String,
    },
}
#[derive(Clone, ValueEnum)]
enum AuthOperation {
    Start,
    Status,
    Cancel,
}
fn installed_digest<'a>(list: &'a Value, id: &str) -> Result<&'a str> {
    list["data"]
        .as_array()
        .context("invalid plugin catalog")?
        .iter()
        .find(|plugin| plugin["id"] == id)
        .and_then(|plugin| plugin["installedDigest"].as_str())
        .filter(|digest| !digest.is_empty())
        .context("plugin is not installed")
}
pub async fn run(options: Options) -> Result<()> {
    if matches!(options.command, Command::Snapshot { .. } | Command::Doctor) {
        ensure!(
            options.config.is_none() && options.data_dir.is_none(),
            "snapshot and doctor use --config-home, not --config or --data-dir"
        );
        let user_home = std::env::var_os("HOME").map(PathBuf::from);
        let config_home = options
            .config_home
            .or_else(|| std::env::var_os("AREAL_HARNESS_HOME").map(PathBuf::from))
            .or_else(|| user_home.as_ref().map(|home| home.join(".areal")))
            .context("cannot locate config home; set --config-home")?;
        let selected = match &options.command {
            Command::Snapshot { id } => id.as_deref(),
            _ => None,
        };
        let snapshot = areal_plugins::Store::read_snapshot(
            config_home.join("plugins"),
            options.workspace,
            user_home,
            selected,
        )?;
        let value = if matches!(options.command, Command::Doctor) {
            serde_json::to_value(snapshot.doctor())?
        } else {
            serde_json::to_value(snapshot)?
        };
        println!("{}", serde_json::to_string_pretty(&value)?);
        return Ok(());
    }
    if let Some(result) = store_command(&options.command, options.workspace.as_deref())? {
        println!("{}", serde_json::to_string_pretty(&result)?);
        return Ok(());
    }
    ensure!(
        options.config_home.is_none(),
        "--config-home is available only for snapshot and doctor"
    );
    let root = areal_local_service::home()?;
    let service_id = areal_local_service::select(
        &root,
        None,
        options.workspace.as_deref(),
        options.data_dir.as_deref(),
    )
    .await
    .context("connect the workspace first with areal service ensure")?;
    let service = areal_local_service::status(&root, &service_id).await?;
    ensure!(
        options.config.is_none(),
        "plugin commands use the running Core configuration; use service ensure/restart to choose --config"
    );
    let list = areal_local_service::rpc(&service, "areal/plugin/list", json!({})).await?;
    let revision = list["revision"]
        .as_u64()
        .context("invalid plugin directory revision")?;
    let request_id = uuid::Uuid::new_v4().to_string();
    let (method, mut params, mutation) = match options.command {
        Command::Snapshot { .. }
        | Command::Doctor
        | Command::MarketplaceAdd { .. }
        | Command::Resolve { .. }
        | Command::MarketplaceAddGit { .. }
        | Command::MarketplaceRemove { .. }
        | Command::MarketplaceUpdate
        | Command::Install { .. }
        | Command::Enable { .. }
        | Command::Disable { .. }
        | Command::Uninstall { .. } => unreachable!(),
        Command::List => {
            println!("{}", serde_json::to_string_pretty(&list)?);
            return Ok(());
        }
        Command::Read { id } => ("areal/plugin/read", json!({"id":id}), false),
        Command::Configure {
            id,
            values_file,
            clear_keys,
        } => {
            let bytes = std::fs::read(values_file)?;
            ensure!(
                bytes.len() <= 256 * 1024,
                "plugin configuration exceeds 256 KiB"
            );
            let values: std::collections::BTreeMap<String, areal_plugins::PluginConfigValue> =
                serde_json::from_slice(&bytes)
                    .map_err(|_| anyhow::anyhow!("invalid plugin configuration value document"))?;
            (
                "areal/plugin/userConfig/set",
                json!({"id":id,"expectedRevision":revision,"expectedDigest":installed_digest(&list,&id)?,"values":values,"clearKeys":clear_keys}),
                true,
            )
        }
        Command::DevLink {
            id,
            expected_digest,
        } => (
            "areal/plugin/development/link",
            json!({"id":id,"expectedRevision":revision,"expectedDigest":expected_digest}),
            true,
        ),
        Command::DevUnlink { id } => (
            "areal/plugin/development/unlink",
            json!({"id":id,"expectedRevision":revision}),
            true,
        ),
        Command::Setup { id, thread } => {
            let mut p = json!({"id":id});
            if let Some(thread) = thread {
                p["threadId"] = json!(thread);
            }
            ("areal/plugin/setup", p, true)
        }
        Command::Connect {
            id,
            expected_digest,
        } => {
            ensure!(
                !expected_digest.is_empty(),
                "--expected-digest must be the reviewed installed digest"
            );
            (
                "areal/plugin/connection",
                json!({"id":id,"expectedDigest":expected_digest,"connect":true}),
                true,
            )
        }
        Command::Disconnect { id } => (
            "areal/plugin/connection",
            json!({"id":id,"expectedDigest":installed_digest(&list, &id)?,"connect":false}),
            true,
        ),
        Command::McpList => ("areal/plugin/mcp/list", json!({}), false),
        Command::HooksList => ("areal/plugin/hooks/list", json!({}), false),
        Command::HooksTrust {
            id,
            expected_digest,
            definition_digest,
            allow_read_only_commands,
        } => (
            "areal/plugin/hooks/configure",
            json!({"id":id,"expectedDigest":expected_digest,"definitionDigest":definition_digest,"enabled":true,"trusted":true,"allowReadOnlyCommands":allow_read_only_commands}),
            true,
        ),
        Command::HooksRevoke { id } => {
            let hooks =
                areal_local_service::rpc(&service, "areal/plugin/hooks/list", json!({})).await?;
            let row = hooks["data"]
                .as_array()
                .and_then(|rows| rows.iter().find(|row| row["pluginId"] == id))
                .context("installed hook package unavailable")?;
            (
                "areal/plugin/hooks/configure",
                json!({"id":id,"expectedDigest":row["installedDigest"],"definitionDigest":row["definitionDigest"],"enabled":false,"trusted":false}),
                true,
            )
        }
        Command::Auth {
            id,
            server,
            operation,
        } => {
            let operation = match operation {
                AuthOperation::Start => "start",
                AuthOperation::Status => "status",
                AuthOperation::Cancel => "cancel",
            };
            (
                "areal/plugin/auth",
                json!({"id":id,"server":server,"operation":operation}),
                false,
            )
        }
        Command::ConnectorConfigure {
            id,
            connector_id,
            provider,
            credential_ref,
        } => (
            "areal/plugin/connector/configure",
            json!({"id":id,"connectorId":connector_id,"provider":provider,"credentialRef":credential_ref,"expectedDigest":installed_digest(&list, &id)?}),
            true,
        ),
        Command::Submission { request_id } => {
            ("areal/request/read", json!({"requestId":request_id}), false)
        }
    };
    if mutation {
        params["requestId"] = json!(request_id);
    }
    let result: Value = areal_local_service::rpc(&service, method, params).await
        .with_context(|| if mutation { format!("plugin request {request_id}; if acceptance is unknown, inspect with areal plugin submission {request_id}; no replay was attempted") } else if method == "areal/plugin/auth" { "plugin authentication operation failed; inspect auth status before retrying; no replay was attempted".into() } else { "plugin read failed".into() })?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

fn store_root() -> Result<PathBuf> {
    let home = match std::env::var_os("AREAL_HARNESS_HOME") {
        Some(home) => PathBuf::from(home),
        None => std::env::home_dir()
            .context("cannot locate home")?
            .join(".areal"),
    };
    Ok(home.join("plugins"))
}

/// 插件库登记写入：不经过项目 Core；在运行的 Core 下一回合开始时会重新读取。
fn store_command(command: &Command, workspace: Option<&std::path::Path>) -> Result<Option<Value>> {
    let user_home = std::env::home_dir();
    let user = || areal_plugins::Store::open_user(store_root()?, user_home.clone());
    let project = || -> Result<areal_plugins::Store> {
        let workspace = match workspace {
            Some(path) => path.to_owned(),
            None => std::env::current_dir()?,
        };
        areal_plugins::Store::open(store_root()?, workspace.canonicalize()?, user_home.clone())
    };
    let scoped = |scope: &str| {
        if scope == "project" {
            project()
        } else {
            user()
        }
    };
    let revision = |store: &areal_plugins::Store| store.list().map(|list| list.revision);
    let value = match command {
        Command::MarketplaceAdd { root } => {
            let store = user()?;
            serde_json::to_value(store.add_marketplace(&root.canonicalize()?, revision(&store)?)?)?
        }
        Command::MarketplaceRemove { root } => {
            let store = user()?;
            let root = root.canonicalize().or_else(|_| std::path::absolute(root))?;
            serde_json::to_value(store.remove_marketplace(&root, revision(&store)?)?)?
        }
        Command::MarketplaceAddGit { url, ref_name } => {
            let store = user()?;
            serde_json::to_value(store.add_git_marketplace(
                url,
                ref_name.as_deref(),
                revision(&store)?,
            )?)?
        }
        Command::MarketplaceUpdate => {
            let store = user()?;
            serde_json::to_value(store.update_marketplaces(revision(&store)?)?)?
        }
        Command::Resolve { id } => {
            let store = user()?;
            serde_json::to_value(store.resolve_remote(id, revision(&store)?)?)?
        }
        Command::Install { id } => {
            let store = project().or_else(|_| user())?;
            let selected = store.read(id)?;
            ensure!(
                !selected.source_digest.is_empty(),
                "plugin source is unresolved; run areal plugin resolve {id}, inspect it with areal plugin read {id}, then run areal plugin install {id}"
            );
            serde_json::to_value(store.install(
                id,
                "user",
                revision(&store)?,
                &selected.source,
                selected.review_digest(),
            )?)?
        }
        Command::Enable { id, scope } | Command::Disable { id, scope } => {
            let store = scoped(scope)?;
            let enabled = matches!(command, Command::Enable { .. });
            serde_json::to_value(store.configure(id, scope, enabled, revision(&store)?)?)?
        }
        Command::Uninstall { id } => {
            let store = user()?;
            serde_json::to_value(store.uninstall(id, revision(&store)?)?)?
        }
        _ => return Ok(None),
    };
    Ok(Some(value))
}
