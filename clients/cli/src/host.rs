use anyhow::Result;
use areal_host::{Client, ResolveProject, StopStrategy};
use clap::Subcommand;
#[derive(Subcommand)]
pub enum HostCommand {
    Run {
        #[arg(long)]
        managed: bool,
    },
    Install,
    Uninstall,
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
        HostCommand::Uninstall => serde_json::to_value(
            areal_host::ServiceInstallation::uninstall(&areal_local_service::home()?).await?,
        )?,
        HostCommand::Status { .. } => match Client::connect().await {
            Ok(client) => serde_json::to_value(client.status().await?)?,
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
