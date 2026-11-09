use anyhow::Result;
use areal_host::{Client, ResolveProject, StopStrategy};
use clap::{Subcommand, ValueEnum};
#[derive(Clone, Copy, ValueEnum)]
#[value(rename_all = "camelCase")]
pub enum UpdateStrategy {
    IfIdle,
    Cancel,
}
#[derive(Subcommand)]
pub enum UpdateCommand {
    Prepare {
        #[arg(long)]
        target_version: String,
        #[arg(long)]
        request_id: Option<String>,
        #[arg(long)]
        expected_generation: Option<String>,
        #[arg(long)]
        json: bool,
    },
    Apply {
        #[arg(long)]
        target_version: String,
        #[arg(long)]
        strategy: UpdateStrategy,
        #[arg(long)]
        confirm_cancel: bool,
        #[arg(long)]
        request_id: Option<String>,
        #[arg(long)]
        expected_generation: Option<String>,
        #[arg(long)]
        json: bool,
    },
}
#[derive(Subcommand)]
pub enum WebCommand {
    Approve {
        request_id: String,
        #[arg(long = "scope", value_delimiter = ',', default_value = "observe", value_parser = ["observe", "submit", "approve", "manage"])]
        scopes: Vec<String>,
    },
    Devices,
    Revoke {
        device_id: String,
    },
}
#[derive(Subcommand)]
pub enum HostCommand {
    #[cfg(target_os = "macos")]
    #[command(hide = true)]
    CredentialIo {
        #[arg(long)]
        channel_fd: i32,
        #[arg(long, allow_hyphen_values = true)]
        owner_fd: i32,
    },
    Web {
        #[command(subcommand)]
        action: WebCommand,
    },
    Run {
        #[arg(long)]
        managed: bool,
    },
    Install,
    Uninstall {
        #[arg(long)]
        stopped_only: bool,
    },
    ServiceStatus {
        #[arg(long)]
        json: bool,
    },
    UpdateStatus {
        #[arg(long)]
        json: bool,
    },
    Update {
        #[command(subcommand)]
        action: UpdateCommand,
    },
    Status {
        #[arg(long)]
        json: bool,
    },
    List {
        #[arg(long)]
        json: bool,
    },
    Ensure {
        #[command(flatten)]
        local: Box<areal_local_service::LocalArgs>,
        #[arg(long)]
        project_id: Option<String>,
        #[arg(long)]
        request_id: Option<String>,
        #[arg(long)]
        json: bool,
    },
    Stop {
        #[arg(long)]
        request_id: Option<String>,
        #[arg(long)]
        expected_generation: Option<String>,
        #[arg(long)]
        cancel: bool,
        #[arg(long)]
        json: bool,
    },
    Operation {
        request_id: String,
        #[arg(long)]
        json: bool,
    },
}
pub async fn execute(command: HostCommand) -> Result<()> {
    let value = match command {
        #[cfg(target_os = "macos")]
        HostCommand::CredentialIo {
            channel_fd,
            owner_fd,
        } => return areal_host::run_credential_io(channel_fd, owner_fd),
        HostCommand::Web {
            action: WebCommand::Approve { request_id, scopes },
        } => serde_json::to_value(
            Client::connect()
                .await?
                .approve_browser_with_scopes(
                    &request_id,
                    &scopes.iter().map(String::as_str).collect::<Vec<_>>(),
                )
                .await?,
        )?,
        HostCommand::Web {
            action: WebCommand::Devices,
        } => serde_json::to_value(Client::connect().await?.browser_devices().await?)?,
        HostCommand::Web {
            action: WebCommand::Revoke { device_id },
        } => serde_json::to_value(Client::connect().await?.revoke_browser(&device_id).await?)?,
        HostCommand::Run { managed } => {
            let options = areal_host::RunOptions::current()?;
            if !managed && areal_host::ServiceInstallation::start_installed(&options.home).await? {
                return Ok(());
            }
            let exit = if managed {
                areal_host::run_managed(options).await?
            } else {
                areal_host::run(options).await?
            };
            if exit.code() != 0 {
                std::process::exit(exit.code());
            }
            return Ok(());
        }
        HostCommand::Install => {
            let installation = areal_host::ServiceInstallation::current()?;
            installation.install()?;
            serde_json::to_value(installation)?
        }
        HostCommand::Uninstall { stopped_only } => {
            let home = areal_local_service::home()?;
            serde_json::to_value(if stopped_only {
                areal_host::ServiceInstallation::uninstall_stopped(&home).await?
            } else {
                areal_host::ServiceInstallation::uninstall(&home).await?
            })?
        }
        HostCommand::ServiceStatus { .. } => {
            areal_host::ServiceInstallation::status(&areal_local_service::home()?)?
        }
        HostCommand::UpdateStatus { .. } => Client::connect().await?.update_status().await?,
        HostCommand::Update { action } => {
            let client = Client::connect().await?;
            match action {
                UpdateCommand::Prepare {
                    target_version,
                    request_id,
                    expected_generation,
                    ..
                } => {
                    let request_id = request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                    eprintln!("Host update prepare requestId: {request_id}");
                    client
                        .prepare_update(
                            &request_id,
                            &expected_generation
                                .unwrap_or_else(|| client.identity().generation.clone()),
                            &target_version,
                        )
                        .await?
                }
                UpdateCommand::Apply {
                    target_version,
                    strategy,
                    confirm_cancel,
                    request_id,
                    expected_generation,
                    ..
                } => {
                    if matches!(strategy, UpdateStrategy::Cancel) {
                        anyhow::ensure!(
                            confirm_cancel,
                            "cancel requires --confirm-cancel and the exact prepared --target-version"
                        );
                        let prepared = client.update_status().await?;
                        let prepare_id = prepared["prepareRequestId"].as_str().ok_or_else(|| anyhow::anyhow!("no original prepared update; inspect update status before confirming cancellation"))?;
                        let original = client.operation(prepare_id).await?.ok_or_else(|| anyhow::anyhow!("original preparation is unavailable; cancellation was not submitted"))?;
                        anyhow::ensure!(
                            prepared["restartPending"] == true
                                && prepared["targetVersion"] == target_version
                                && original["state"] == "prepared"
                                && original["targetVersion"] == target_version
                                && original["generation"] == client.identity().generation,
                            "prepared target or Host generation changed; inspect the original update before confirming cancellation"
                        );
                    }
                    let request_id = request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                    eprintln!("Host update apply requestId: {request_id}");
                    client
                        .apply_update(
                            &request_id,
                            &expected_generation
                                .unwrap_or_else(|| client.identity().generation.clone()),
                            &target_version,
                            match strategy {
                                UpdateStrategy::IfIdle => StopStrategy::IfIdle,
                                UpdateStrategy::Cancel => StopStrategy::Cancel,
                            },
                        )
                        .await?
                }
            }
        }
        HostCommand::Status { .. } => match Client::connect().await {
            Ok(client) => {
                let mut value = serde_json::to_value(client.status().await?)?;
                value["executableVersion"] =
                    serde_json::json!(client.identity().executable_version);
                value
            }
            Err(_) => areal_host::offline_service_status(&areal_local_service::home()?)?,
        },
        HostCommand::List { .. } => {
            serde_json::json!({"projects":Client::connect().await?.list().await?})
        }
        HostCommand::Ensure {
            local,
            project_id,
            request_id,
            ..
        } => {
            let client = Client::connect_or_start().await?;
            let mut input = ResolveProject::from_local_args(&local)?;
            input.requested_project_id = project_id;
            let opened = match request_id {
                Some(id) => client.open_with_request(&id, input).await?,
                None => client.open(input).await?,
            };
            serde_json::to_value(opened)?
        }
        HostCommand::Stop {
            request_id,
            expected_generation,
            cancel,
            ..
        } => {
            let client = Client::connect().await?;
            let request = request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let generation =
                expected_generation.unwrap_or_else(|| client.identity().generation.clone());
            client
                .stop(
                    &request,
                    &generation,
                    if cancel {
                        StopStrategy::Cancel
                    } else {
                        StopStrategy::IfIdle
                    },
                )
                .await?
        }
        HostCommand::Operation { request_id, .. } => {
            let operation = match Client::connect().await {
                Ok(client) => client.operation(&request_id).await?,
                Err(_) => {
                    areal_host::operation_offline(&areal_local_service::home()?, &request_id)?
                }
            };
            serde_json::json!({"operation":operation})
        }
    };
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}
