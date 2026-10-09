use anyhow::Result;
use areal_config::{ConfigInputs, load_management_config};
use clap::{Args, Subcommand};
use std::{path::PathBuf, time::Duration};

pub fn warn_startup(config_file: Option<&std::path::Path>) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static CHECKED: AtomicBool = AtomicBool::new(false);
    if CHECKED.swap(true, Ordering::Relaxed) {
        return;
    }
    let config_file = config_file.map(std::path::Path::to_owned);
    if check_with_deadline(
        move || startup_needs_attention(config_file),
        Duration::from_millis(20),
    ) {
        eprintln!(
            "AReaL: 轨迹导出需要处理；Agent 可继续使用。请在设置 → 数据飞轮或 areal trajectory status 中查看状态。"
        );
    }
}

fn check_with_deadline(check: impl FnOnce() -> bool + Send + 'static, timeout: Duration) -> bool {
    let (result, receiver) = std::sync::mpsc::channel();
    // 配置读取和队列扫描都可能遇到慢磁盘；后台只交回结果，不能在 TUI 打开后补打提示。
    if std::thread::Builder::new()
        .name("areal-trajectory-status".into())
        .spawn(move || {
            let _ = result.send(check());
        })
        .is_err()
    {
        return false;
    }
    receiver.recv_timeout(timeout).unwrap_or(false)
}

fn startup_needs_attention(config_file: Option<PathBuf>) -> bool {
    let Ok(cwd) = std::env::current_dir() else {
        return false;
    };
    let inputs = ConfigInputs {
        cwd,
        homedir: std::env::home_dir(),
        env: std::env::vars_os().collect(),
        config_file,
        ..Default::default()
    };
    let Ok(config) = load_management_config(&inputs) else {
        return false;
    };
    if !config.trajectory.enabled {
        return false;
    }
    areal_server::trajectory::status(&config.trajectory)
        .map(|status| matches!(status["state"].as_str(), Some("degraded" | "invalid")))
        .unwrap_or(true)
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
    /// 将失败记录重新排队；上传由独立后台进程完成。
    Retry,
    /// 应用持久导出控制；现有 Core 的采集配置仍需安全重启。
    SyncConfig,
    /// 配置脚本迁移队列前暂停原控制，不修改配置文件或已落盘轨迹。
    #[command(hide = true)]
    Suspend,
}

pub fn run(options: Options) -> Result<()> {
    let inputs = ConfigInputs {
        cwd: std::env::current_dir()?,
        homedir: std::env::home_dir(),
        env: std::env::vars_os().collect(),
        config_file: options.config,
        ..Default::default()
    };
    let mut config = load_management_config(&inputs)?;
    let mut result = match options.command {
        Command::Status => areal_server::trajectory::status(&config.trajectory)?,
        Command::Retry => areal_server::trajectory::retry_failed(&config.trajectory)?,
        Command::SyncConfig => {
            areal_server::trajectory::configure(&config.trajectory)?;
            areal_server::trajectory::status(&config.trajectory)?
        }
        Command::Suspend => {
            config.trajectory.enabled = false;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, time::Instant};

    #[test]
    fn startup_check_observes_results_within_its_deadline() {
        assert!(check_with_deadline(|| true, Duration::from_secs(1)));
        assert!(!check_with_deadline(|| false, Duration::from_secs(1)));
    }

    #[test]
    fn slow_startup_check_cannot_delay_launch_or_publish_a_late_warning() {
        let (release, blocked) = mpsc::channel();
        let (finished, done) = mpsc::channel();
        let started = Instant::now();
        let warning = check_with_deadline(
            move || {
                blocked.recv().unwrap();
                finished.send(()).unwrap();
                true
            },
            Duration::from_millis(20),
        );
        let elapsed = started.elapsed();
        release.send(()).unwrap();
        done.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(!warning, "超时以后不能向启动入口交付告警");
        assert!(
            elapsed < Duration::from_millis(500),
            "后台尚未完成时主启动路径必须返回：{elapsed:?}"
        );
    }
}
