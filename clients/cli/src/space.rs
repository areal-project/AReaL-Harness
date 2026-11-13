use anyhow::Result;
use clap::{Args, Subcommand};
use std::path::PathBuf;
#[derive(Args)]
pub struct Options {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    Preflight {
        #[arg(long)]
        source_profile: PathBuf,
        #[arg(long)]
        source_core_home: PathBuf,
        #[arg(long)]
        source_host_home: PathBuf,
    },
    Prepare {
        #[arg(long)]
        request_id: String,
        #[arg(long)]
        source_profile: PathBuf,
        #[arg(long)]
        source_core_home: PathBuf,
        #[arg(long)]
        source_host_home: PathBuf,
    },
    Resolve {
        #[arg(long)]
        space_id: String,
    },
    Inspect {
        #[arg(long)]
        space_id: String,
    },
    Active,
    Activate {
        #[arg(long)]
        space_id: String,
    },
    Deactivate,
}
async fn execute(options: Options) -> Result<serde_json::Value> {
    let result = match options.command {
        Command::Preflight {
            source_profile,
            source_core_home,
            source_host_home,
        } => {
            areal_host::preflight_space(areal_host::SpaceSource {
                profile: source_profile,
                core_home: source_core_home,
                host_home: source_host_home,
            })
            .await?
        }
        Command::Prepare {
            request_id,
            source_profile,
            source_core_home,
            source_host_home,
        } => areal_host::prepare_space(
            &request_id,
            areal_host::SpaceSource {
                profile: source_profile,
                core_home: source_core_home,
                host_home: source_host_home,
            },
        )?,
        Command::Resolve { space_id } => areal_host::resolve_space(&space_id)?,
        Command::Inspect { space_id } => areal_host::inspect_space(&space_id)?,
        Command::Active => areal_host::active_space()?,
        Command::Activate { space_id } => areal_host::activate_space(Some(&space_id))?,
        Command::Deactivate => areal_host::activate_space(None)?,
    };
    Ok(result)
}

pub async fn run(options: Options) -> Result<()> {
    match execute(options).await {
        Ok(value) => {
            println!("{}", serde_json::to_string(&value)?);
            Ok(())
        }
        Err(error) => {
            let detail = error.to_string();
            let code = if detail.contains("requestConflict") {
                "SPACE_REQUEST_CONFLICT"
            } else if detail.contains("unknown") || detail.contains("unconfirmed") {
                "SPACE_PREPARATION_UNKNOWN"
            } else if detail.contains("collision")
                || detail.contains("identity")
                || detail.contains("overlaps")
            {
                "SPACE_IDENTITY_CONFLICT"
            } else {
                "SPACE_UNAVAILABLE"
            };
            println!(
                "{}",
                serde_json::json!({"error":{"code":code,"message":"无法确认空间状态；请保留原操作，不要重复创建。"}})
            );
            anyhow::bail!("space operation refused ({code})")
        }
    }
}
