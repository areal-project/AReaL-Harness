//! 可信桌面 Main 可直接 exec 此 JSON 入口；浏览器只访问 Core HTTP/WS。
use anyhow::{Result, ensure};
use areal_local_service::{LaunchSpec, LocalArgs};
use clap::Subcommand;
use std::path::PathBuf;

#[derive(clap::Args)]
pub struct ServiceTarget {
    #[arg(long, conflicts_with_all = ["workspace", "data_dir"])]
    instance: Option<String>,
    #[arg(long)]
    workspace: Option<PathBuf>,
    #[arg(long)]
    data_dir: Option<PathBuf>,
}

impl ServiceTarget {
    async fn resolve(&self, root: &std::path::Path) -> Result<String> {
        areal_local_service::select(
            root,
            self.instance.as_deref(),
            self.workspace.as_deref(),
            self.data_dir.as_deref(),
        )
        .await
    }
}

#[derive(Subcommand)]
pub enum ServiceCommand {
    /// 复用兼容的本地服务；不存在时启动。
    Ensure {
        #[command(flatten)]
        local: Box<LocalArgs>,
        #[arg(long)]
        json: bool,
    },
    List {
        #[arg(long)]
        json: bool,
    },
    Status {
        #[command(flatten)]
        target: ServiceTarget,
        #[arg(long)]
        json: bool,
    },
    /// 默认拒绝停止仍在工作的实例；--cancel 显式取消并结算。
    Stop {
        #[command(flatten)]
        target: ServiceTarget,
        #[arg(long)]
        cancel: bool,
        #[arg(long)]
        json: bool,
    },
    /// 按当前工作区重启；忙碌时拒绝，--cancel 显式取消并结算。
    Restart {
        #[command(flatten)]
        local: Box<LocalArgs>,
        #[arg(long)]
        cancel: bool,
        #[arg(long)]
        json: bool,
    },
    /// 将已有历史绑定到工作区；要求服务已停止且历史属于该工作区。
    Bind {
        #[arg(long)]
        workspace: PathBuf,
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long)]
        json: bool,
    },
}

pub async fn execute(command: ServiceCommand) -> Result<()> {
    let root = areal_local_service::home()?;
    let value = match command {
        ServiceCommand::Ensure { local, .. } => {
            serde_json::to_value(areal_local_service::ensure(&LaunchSpec::resolve(&local)?).await?)?
        }
        ServiceCommand::List { .. } => {
            serde_json::to_value(areal_local_service::list(&root).await?)?
        }
        ServiceCommand::Status { target, .. } => serde_json::to_value(
            areal_local_service::status(&root, &target.resolve(&root).await?).await?,
        )?,
        ServiceCommand::Stop { target, cancel, .. } => serde_json::to_value(
            areal_local_service::stop(&root, &target.resolve(&root).await?, cancel).await?,
        )?,
        ServiceCommand::Restart { local, cancel, .. } => serde_json::to_value(
            areal_local_service::restart(&LaunchSpec::resolve(&local)?, cancel).await?,
        )?,
        ServiceCommand::Bind {
            workspace,
            data_dir,
            ..
        } => {
            serde_json::json!({"dataDir":areal_local_service::bind(&root, &workspace, &data_dir).await?})
        }
    };
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}

pub async fn web(local: LocalArgs, json: bool) -> Result<()> {
    let service = areal_local_service::ensure(&LaunchSpec::resolve(&local)?).await?;
    if !json {
        let login_url = areal_local_service::browser_login_url(&service).await?;
        let opener = if cfg!(target_os = "macos") {
            "/usr/bin/open"
        } else {
            "/usr/bin/xdg-open"
        };
        let result = tokio::process::Command::new(opener)
            .arg(&login_url)
            // 打开失败时系统工具可能回显完整 URL，不能将登录码写入终端或日志。
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await?;
        ensure!(
            result.success(),
            "could not open browser; visit {}",
            service.web_url
        );
    }
    println!("{}", serde_json::to_string_pretty(&service)?);
    Ok(())
}
