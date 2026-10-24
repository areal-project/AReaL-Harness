//! 可信桌面 Main 可直接 exec 此 JSON 入口；浏览器只访问 Core HTTP/WS。
use anyhow::{Result, ensure};
use areal_local_service::{
    LaunchSpec, LocalArgs,
    gui_owner::{self, GuiLifetime},
};
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
        /// 复用兼容实例或启动新实例；配置变化需要显式 lifecycle 操作。
        #[arg(long)]
        no_auto_restart: bool,
        #[arg(long)]
        json: bool,
    },
    /// 仅恢复同一 GUI 拥有且已确认资源清理的崩溃代际。
    Recover {
        #[command(flatten)]
        local: Box<LocalArgs>,
        #[arg(long)]
        instance: String,
        #[arg(long)]
        expected_generation: String,
        #[arg(long)]
        json: bool,
    },
    List {
        #[arg(long)]
        json: bool,
    },
    /// Read published scheduled-task previews without starting Core or Runtime.
    TaskCatalog {
        #[arg(long)]
        workspace: PathBuf,
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long, default_value_t = 30)]
        limit: usize,
        #[arg(long)]
        source_thread_id: Option<String>,
        #[arg(long)]
        json: bool,
    },
    Status {
        #[arg(long)]
        recovery: bool,
        #[command(flatten)]
        target: ServiceTarget,
        #[arg(long)]
        json: bool,
    },
    Capabilities {
        #[command(flatten)]
        target: ServiceTarget,
        #[arg(long)]
        expected_generation: String,
        #[arg(long)]
        json: bool,
    },
    /// 只读原停止操作；不存在回执不能证明请求没有被受理。
    Operation {
        #[command(flatten)]
        target: ServiceTarget,
        #[arg(long)]
        expected_generation: String,
        #[arg(long)]
        request_id: String,
        #[arg(long)]
        json: bool,
    },
    /// 默认拒绝停止仍在工作的实例；--cancel 显式取消并结算。
    Stop {
        #[command(flatten)]
        target: ServiceTarget,
        #[arg(long)]
        cancel: bool,
        /// 仅停止已确认的 generation；实例换代时拒绝。
        #[arg(long)]
        expected_generation: Option<String>,
        #[arg(long, requires = "expected_generation")]
        request_id: Option<String>,
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
    let lifetime = GuiLifetime::from_env()?;
    let owner = gui_owner::from_env()?;
    ensure!(
        lifetime.is_none() || owner.is_some(),
        "GUI lifetime requires an application owner"
    );
    let root = areal_local_service::home()?;
    let value = match command {
        ServiceCommand::Ensure {
            local,
            no_auto_restart,
            ..
        } => {
            let mut spec = LaunchSpec::resolve(&local)?;
            spec.owner = owner.clone();
            serde_json::to_value(if owner.is_some() {
                areal_local_service::ensure_with_lifetime(
                    &spec,
                    lifetime.as_ref().ok_or_else(|| {
                        anyhow::anyhow!("GUI ensure requires an inherited lifetime descriptor")
                    })?,
                    no_auto_restart,
                )
                .await?
            } else if no_auto_restart {
                areal_local_service::ensure_without_restart(&spec).await?
            } else {
                areal_local_service::ensure(&spec).await?
            })?
        }
        ServiceCommand::Recover {
            local,
            instance,
            expected_generation,
            ..
        } => {
            let mut spec = LaunchSpec::resolve(&local)?;
            spec.owner = owner.clone();
            ensure!(
                spec.service_id == instance,
                "recovery instance does not match local data directory"
            );
            serde_json::to_value(
                areal_local_service::recover_crashed(
                    &spec,
                    &expected_generation,
                    lifetime.as_ref().ok_or_else(|| {
                        anyhow::anyhow!("GUI recovery requires an inherited lifetime descriptor")
                    })?,
                )
                .await?,
            )?
        }
        ServiceCommand::List { .. } => {
            serde_json::to_value(areal_local_service::list(&root).await?)?
        }
        ServiceCommand::TaskCatalog {
            workspace,
            data_dir,
            limit,
            source_thread_id,
            ..
        } => {
            ensure!((1..=1024).contains(&limit), "limit must be 1..1024");
            let (target, bound) = areal_local_service::catalog_target(&workspace, &data_dir)?;
            let catalog = if bound {
                serde_json::to_value(areal_engine::read_published_task_catalog(
                    &target.data_dir,
                    source_thread_id.as_deref(),
                    limit,
                )?)?
            } else {
                serde_json::json!({"kind":"requiresCore","reason":"unbound"})
            };
            serde_json::json!({"version":1,"target":target,"source":"published",
                "executionState":"unobserved","catalog":catalog})
        }
        ServiceCommand::Status {
            target,
            recovery: true,
            ..
        } => {
            let status =
                areal_local_service::status_with_recovery(&root, &target.resolve(&root).await?)
                    .await?;
            if let Some(owner) = &owner {
                gui_owner::check(Some(owner), status.service.owner.as_ref())?;
            }
            serde_json::to_value(status)?
        }
        ServiceCommand::Status { target, .. } => {
            let service = areal_local_service::status(&root, &target.resolve(&root).await?).await?;
            if let Some(owner) = &owner {
                gui_owner::check(Some(owner), service.owner.as_ref())?;
            }
            serde_json::to_value(service)?
        }
        ServiceCommand::Capabilities {
            target,
            expected_generation,
            ..
        } => serde_json::to_value(
            areal_local_service::capabilities(
                &root,
                &target.resolve(&root).await?,
                &expected_generation,
            )
            .await?,
        )?,
        ServiceCommand::Operation {
            target,
            expected_generation,
            request_id,
            ..
        } => {
            serde_json::json!({"operation": areal_local_service::operation(
                &root, &target.resolve(&root).await?, &expected_generation, &request_id,
            ).await?})
        }
        ServiceCommand::Stop {
            target,
            cancel,
            expected_generation,
            request_id,
            ..
        } => {
            let id = target.resolve(&root).await?;
            if let Some(request_id) = request_id {
                serde_json::to_value(
                    areal_local_service::stop_operation(
                        &root,
                        &id,
                        expected_generation.as_deref().unwrap(),
                        &request_id,
                        cancel,
                    )
                    .await?,
                )?
            } else {
                let service = if let Some(generation) = expected_generation {
                    areal_local_service::stop_with_generation(&root, &id, cancel, &generation)
                        .await?
                } else {
                    areal_local_service::stop(&root, &id, cancel).await?
                };
                serde_json::to_value(service)?
            }
        }
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
