//! Thin plugin management client; installation/selection authority stays in Core.
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
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
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
        #[arg(long, default_value = "user", value_parser = ["user", "project"])]
        scope: String,
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
        Command::List => {
            println!("{}", serde_json::to_string_pretty(&list)?);
            return Ok(());
        }
        Command::Read { id } => ("areal/plugin/read", json!({"id":id}), false),
        Command::MarketplaceAdd { root } => (
            "areal/marketplace/add",
            json!({"root":root.canonicalize()?,"expectedRevision":revision}),
            true,
        ),
        Command::Resolve { id } => (
            "areal/plugin/resolve",
            json!({"id":id,"expectedRevision":revision}),
            true,
        ),
        Command::MarketplaceAddGit { url, ref_name } => (
            "areal/marketplace/addGit",
            json!({"url":url,"refName":ref_name,"expectedRevision":revision}),
            true,
        ),
        Command::MarketplaceRemove { root } => (
            "areal/marketplace/remove",
            json!({"root":root.canonicalize().or_else(|_| std::path::absolute(&root))?,"expectedRevision":revision}),
            true,
        ),
        Command::MarketplaceUpdate => (
            "areal/marketplace/update",
            json!({"expectedRevision":revision}),
            true,
        ),
        Command::Install { id, scope } => {
            let selected = list["data"]
                .as_array()
                .context("invalid plugin catalog")?
                .iter()
                .find(|p| p["id"] == id)
                .context("plugin not in catalog; add its marketplace first")?;
            ensure!(
                selected["sourceDigest"]
                    .as_str()
                    .is_some_and(|digest| !digest.is_empty()),
                "plugin source is unresolved; run areal plugin resolve {id}, inspect it with areal plugin read {id}, then run areal plugin install {id}"
            );
            (
                "areal/plugin/install",
                json!({"id":id,"scope":scope,"expectedRevision":revision,
                "source":selected["source"],"expectedDigest":selected["admissionDigest"].as_str().map(Value::from).unwrap_or_else(||selected["sourceDigest"].clone())}),
                true,
            )
        }
        Command::Enable { id, scope } => (
            "areal/plugin/configure",
            json!({"id":id,"scope":scope,"enabled":true,"expectedRevision":revision}),
            true,
        ),
        Command::Disable { id, scope } => (
            "areal/plugin/configure",
            json!({"id":id,"scope":scope,"enabled":false,"expectedRevision":revision}),
            true,
        ),
        Command::Uninstall { id } => (
            "areal/plugin/uninstall",
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
    let result = if mutation && result["catalogRefreshRequired"] == true {
        let receipt_revision = result["revision"]
            .as_u64()
            .context("invalid plugin mutation receipt revision")?;
        let catalog = areal_local_service::rpc(&service, "areal/plugin/list", json!({}))
            .await
            .with_context(|| format!("plugin request {request_id} succeeded at receipt revision {receipt_revision}; current catalog read failed; no replay was attempted"))?;
        eprintln!(
            "plugin request {request_id} completed at receipt revision {receipt_revision}; stdout is the current catalog"
        );
        catalog
    } else {
        result
    };
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
