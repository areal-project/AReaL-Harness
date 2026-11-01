//! 可信桌面 Main 可直接 exec 此 JSON 入口；浏览器只访问 Core HTTP/WS。
use anyhow::{Context, Result, ensure};
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
            if owner.is_none() {
                let mut input = areal_host::ResolveProject::from_local_args(&local)?;
                input.no_auto_restart = no_auto_restart;
                let opened = areal_host::Client::connect_or_start()
                    .await?
                    .open(input)
                    .await?;
                println!("{}", serde_json::to_string_pretty(opened.service()?)?);
                return Ok(());
            }
            let mut spec = LaunchSpec::resolve(&local)?;
            spec.owner = owner.clone();
            serde_json::to_value(
                areal_local_service::ensure_with_lifetime(
                    &spec,
                    lifetime
                        .as_ref()
                        .context("GUI ensure requires an inherited lifetime descriptor")?,
                    no_auto_restart,
                )
                .await?,
            )?
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
            serde_json::json!({"version":2,"target":target,"source":"published",
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
            if owner.is_none() {
                let operation = match areal_host::Client::connect().await {
                    Ok(client) => client.operation(&request_id).await?,
                    Err(_) => areal_host::operation_offline(&root, &request_id)?,
                };
                if let Some(operation) = operation {
                    ensure!(
                        operation["serviceId"] == target.resolve(&root).await?
                            && operation["serviceGeneration"] == expected_generation,
                        "operation does not match the requested service generation"
                    );
                    println!(
                        "{}",
                        serde_json::to_string_pretty(
                            &serde_json::json!({"operation":service_stop_receipt(operation)})
                        )?
                    );
                    return Ok(());
                }
            }
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
            if owner.is_none() {
                let service = areal_local_service::status(&root, &id).await?;
                let client = areal_host::Client::connect_or_start().await?;
                let project = registered_service(&client, &service).await?;
                let receipt = client
                    .stop_project(
                        request_id
                            .as_deref()
                            .unwrap_or(&uuid::Uuid::new_v4().to_string()),
                        &project.project_id,
                        expected_generation
                            .as_deref()
                            .unwrap_or(&service.identity.generation),
                        if cancel {
                            areal_host::StopStrategy::Cancel
                        } else {
                            areal_host::StopStrategy::IfIdle
                        },
                    )
                    .await?;
                let value = if request_id.is_some() {
                    service_stop_receipt(receipt)
                } else {
                    ensure!(
                        receipt["state"] == "completed",
                        "service stop did not complete: {receipt}"
                    );
                    serde_json::to_value(areal_local_service::status(&root, &id).await?)?
                };
                println!("{}", serde_json::to_string_pretty(&value)?);
                return Ok(());
            }
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
        ServiceCommand::Restart { local, cancel, .. } => {
            if owner.is_some() {
                anyhow::bail!("GUI restart requires its generation-bound lifecycle operation");
            }
            let input = areal_host::ResolveProject::from_local_args(&local)?;
            let client = areal_host::Client::connect_or_start().await?;
            let opened = client
                .restart(
                    input,
                    if cancel {
                        areal_host::StopStrategy::Cancel
                    } else {
                        areal_host::StopStrategy::IfIdle
                    },
                )
                .await?;
            serde_json::to_value(opened.service()?)?
        }
        ServiceCommand::Bind {
            workspace,
            data_dir,
            ..
        } => {
            let data_dir = if owner.is_some() {
                areal_local_service::bind(&root, &workspace, &data_dir).await?
            } else {
                let data_dir = data_dir.canonicalize()?;
                let client = areal_host::Client::connect_or_start().await?;
                let existing = client
                    .list()
                    .await?
                    .into_iter()
                    .find(|p| p.data_dir == data_dir);
                let project = areal_host::ProjectRegistration {
                    project_id: existing
                        .map(|p| p.project_id)
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                    workspace: workspace.canonicalize()?,
                    data_dir: data_dir.clone(),
                    source: areal_host::ProjectSource::Cli,
                    default_binding: true,
                };
                client
                    .bind_registration(&uuid::Uuid::new_v4().to_string(), project)
                    .await?;
                data_dir
            };
            serde_json::json!({"dataDir":data_dir})
        }
    };
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}

pub async fn web(local: LocalArgs, json: bool) -> Result<()> {
    let opened = areal_host::Client::connect_or_start()
        .await?
        .open(areal_host::ResolveProject::from_local_args(&local)?)
        .await?;
    let service = opened.service()?;
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

async fn registered_service(
    client: &areal_host::Client,
    service: &areal_protocol::service::Service,
) -> Result<areal_host::ProjectRegistration> {
    if let Some(project) = client
        .list()
        .await?
        .into_iter()
        .find(|p| p.data_dir == service.identity.data_dir)
    {
        return Ok(project);
    }
    client
        .register(
            &uuid::Uuid::new_v4().to_string(),
            areal_host::ProjectRegistration {
                project_id: uuid::Uuid::new_v4().to_string(),
                workspace: service.identity.workspace.clone(),
                data_dir: service.identity.data_dir.clone(),
                source: areal_host::ProjectSource::Cli,
                default_binding: false,
            },
        )
        .await
}

fn service_stop_receipt(receipt: serde_json::Value) -> serde_json::Value {
    let mut result = serde_json::json!({
        "version":1, "requestId":receipt["requestId"], "serviceId":receipt["serviceId"],
        "generation":receipt["serviceGeneration"], "cancel":receipt["strategy"]=="cancel",
        "state":receipt["state"],
    });
    for name in ["message", "lifecycle"] {
        if let Some(value) = receipt.get(name) {
            result[name] = value.clone();
        }
    }
    result
}
