use anyhow::Result;
use areal_config::{ConfigInputs, load_management_config};
use clap::{Args, Subcommand};
use std::path::PathBuf;

pub fn warn_startup(config_file: Option<&std::path::Path>) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static CHECKED: AtomicBool = AtomicBool::new(false);
    if CHECKED.swap(true, Ordering::Relaxed) {
        return;
    }
    let Ok(cwd) = std::env::current_dir() else {
        return;
    };
    let inputs = ConfigInputs {
        cwd,
        homedir: std::env::home_dir(),
        env: std::env::vars_os().collect(),
        config_file: config_file.map(std::path::Path::to_owned),
        ..Default::default()
    };
    let Ok(config) = load_management_config(&inputs) else {
        return;
    };
    if !config.trajectory.enabled {
        return;
    }
    let needs_attention = areal_server::trajectory::status(&config.trajectory)
        .map(|status| matches!(status["state"].as_str(), Some("degraded" | "invalid")))
        .unwrap_or(true);
    if needs_attention {
        eprintln!(
            "AReaL: 轨迹导出需要处理；Agent 可继续使用。请在设置 → 数据飞轮或 areal trajectory status 中查看状态。"
        );
    }
}

#[derive(Args)]
pub struct Options {
    /// 使用与目标 Core 服务相同的配置文件。
    #[arg(long, global = true)]
    config: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// 读取本地轨迹积压和错误，不启动模型或上传。
    Status,
    /// 将失败批次重新排队；上传由运行中的 Core 完成。
    Retry,
    /// 应用持久导出控制；现有 Core 的采集配置仍需安全重启。
    SyncConfig,
}

pub fn run(options: Options) -> Result<()> {
    let inputs = ConfigInputs {
        cwd: std::env::current_dir()?,
        homedir: std::env::home_dir(),
        env: std::env::vars_os().collect(),
        config_file: options.config,
        ..Default::default()
    };
    let config = load_management_config(&inputs)?;
    let mut result = match options.command {
        Command::Status => areal_server::trajectory::status(&config.trajectory)?,
        Command::Retry => areal_server::trajectory::retry_failed(&config.trajectory)?,
        Command::SyncConfig => {
            areal_server::trajectory::configure(&config.trajectory)?;
            areal_server::trajectory::status(&config.trajectory)?
        }
    };
    result["configPath"] = serde_json::json!(
        config
            .config_file
            .unwrap_or(config.home.join("config.toml"))
    );
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}
