//! CLI 工作树入口只调用 Host；不加载 GUI 或 Node。
use anyhow::{Context, Result};
use areal_host::Client;
use clap::{Args, Subcommand};
use serde_json::{Value, json};

#[derive(Args)]
pub struct WorktreeArgs {
    /// Host 原生目录或已登记的 GUI source ID。
    #[arg(long, default_value = "host", global = true)]
    pub source: String,
    /// 原 commandId 用于查询丢失的写回执，同参不会重放未知操作。
    #[arg(long, global = true)]
    pub command_id: Option<uuid::Uuid>,
    #[command(subcommand)]
    pub action: WorktreeCommand,
}
#[derive(Subcommand)]
pub enum WorktreeCommand {
    List,
    Options {
        project: String,
    },
    Read {
        project: String,
        request_id: String,
    },
    Create {
        project: String,
        #[arg(long)]
        request_id: Option<String>,
        #[arg(long)]
        branch: Option<String>,
        #[arg(long)]
        reference: Option<String>,
        #[arg(long)]
        root: Option<String>,
        #[arg(long)]
        source_root: Option<String>,
        #[arg(long)]
        environment: Option<String>,
    },
    Open {
        project: String,
        creation_id: String,
        /// 显式选择已部署且授权环境进程的 Profile，格式 id@revision。
        #[arg(long)]
        agent: Option<String>,
    },
    Cancel {
        project: String,
        creation_id: String,
        #[arg(long)]
        request_id: Option<String>,
    },
    Delete {
        project: String,
        creation_id: String,
        #[arg(long)]
        request_id: Option<String>,
    },
    Action {
        project: String,
        creation_id: String,
        action: String,
        #[arg(long)]
        request_id: Option<String>,
    },
    Settings {
        #[arg(long)]
        root: String,
        #[arg(long, default_value = "areal")]
        branch_prefix: String,
        #[arg(long)]
        expected_revision: Option<u64>,
        #[arg(long)]
        fetch_before_create: bool,
        #[arg(long)]
        auto_cleanup: bool,
        #[arg(long, default_value_t = 10)]
        keep_count: u64,
    },
    EnvironmentSave {
        project: String,
        file: String,
        #[arg(long)]
        expected_revision: u64,
    },
    EnvironmentDelete {
        project: String,
        environment: String,
        #[arg(long)]
        expected_revision: u64,
    },
}
fn identity(request: Option<String>) -> String {
    request.unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
}
pub async fn run(args: WorktreeArgs) -> Result<()> {
    let client = Client::connect_or_start().await?;
    let (write, mut params) = match args.action {
        WorktreeCommand::List => (false, json!({"operation":"worktreeList"})),
        WorktreeCommand::Options { project } => (
            false,
            json!({"operation":"worktreeOptions","projectId":project}),
        ),
        WorktreeCommand::Read {
            project,
            request_id,
        } => (
            false,
            json!({"operation":"worktreeRead","projectId":project,"requestId":request_id}),
        ),
        WorktreeCommand::Create {
            project,
            request_id,
            branch,
            reference,
            root,
            source_root,
            environment,
        } => {
            let mut value = json!({"operation":"worktreeCreate","projectId":project,"requestId":identity(request_id),"source":if reference.is_some(){"branch"}else{"head"}});
            for (key, field) in [
                ("branch", branch),
                ("ref", reference),
                ("worktreeRoot", root),
                ("sourceRoot", source_root),
                ("environmentId", environment),
            ] {
                if let Some(field) = field {
                    value[key] = json!(field);
                }
            }
            (true, value)
        }
        WorktreeCommand::Open {
            project,
            creation_id,
            agent,
        } => {
            let mut value =
                json!({"operation":"worktreeOpen","projectId":project,"requestId":creation_id});
            if let Some(agent) = agent {
                value["agentProfile"] =
                    serde_json::to_value(areal_local_service::parse_agent_profile(&agent)?)?;
            }
            (true, value)
        }
        WorktreeCommand::Cancel {
            project,
            creation_id,
            request_id,
        } => (
            true,
            json!({"operation":"worktreeCancel","projectId":project,"worktreeRequestId":creation_id,"requestId":identity(request_id)}),
        ),
        WorktreeCommand::Delete {
            project,
            creation_id,
            request_id,
        } => (
            true,
            json!({"operation":"worktreeDelete","projectId":project,"worktreeRequestId":creation_id,"requestId":identity(request_id)}),
        ),
        WorktreeCommand::Action {
            project,
            creation_id,
            action,
            request_id,
        } => (
            true,
            json!({"operation":"worktreeAction","projectId":project,"worktreeRequestId":creation_id,"actionId":action,"requestId":identity(request_id)}),
        ),
        WorktreeCommand::Settings {
            root,
            branch_prefix,
            expected_revision,
            fetch_before_create,
            auto_cleanup,
            keep_count,
        } => {
            let mut value = json!({"operation":"worktreeSettings","worktreeRoot":root,"branchPrefix":branch_prefix,"fetchBeforeCreate":fetch_before_create,"autoCleanup":auto_cleanup,"keepCount":keep_count});
            if let Some(revision) = expected_revision {
                value["expectedRevision"] = json!(revision);
            }
            (true, value)
        }
        WorktreeCommand::EnvironmentSave {
            project,
            file,
            expected_revision,
        } => {
            let bytes = std::fs::read(file).context("cannot read environment JSON")?;
            let environment: Value =
                serde_json::from_slice(&bytes).context("invalid environment JSON")?;
            (
                true,
                json!({"operation":"worktreeEnvironmentSave","projectId":project,"environment":environment,"expectedRevision":expected_revision}),
            )
        }
        WorktreeCommand::EnvironmentDelete {
            project,
            environment,
            expected_revision,
        } => (
            true,
            json!({"operation":"worktreeEnvironmentDelete","projectId":project,"environmentId":environment,"expectedRevision":expected_revision}),
        ),
    };
    params["sourceId"] = json!(args.source);
    let result = if write {
        // commandId 与领域 requestId 分开；响应丢失时核对原 commandId，不能换 ID 重发。
        let command = args
            .command_id
            .unwrap_or_else(uuid::Uuid::new_v4)
            .to_string();
        eprintln!("commandId: {command}");
        client.worktree_command(&command, params).await?
    } else {
        client.worktree_read(params).await?
    };
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
