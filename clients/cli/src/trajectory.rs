use anyhow::Result;
use areal_config::{ConfigInputs, load_management_config};
use clap::{Args, Subcommand};
use std::{
    future::Future,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

const WARNING: &str = "AReaL: 轨迹导出需要处理；Agent 可继续使用。请在设置 → 数据飞轮或 areal trajectory status 中查看状态。";
const UNREADABLE: &str = "AReaL: 暂时无法检查轨迹导出状态；Agent 可继续使用。请在设置 → 数据飞轮或 areal trajectory status 中查看状态。";

pub struct Monitor {
    stopped: Arc<AtomicBool>,
    worker: std::thread::Thread,
    notice: Option<oneshot::Receiver<String>>,
}

impl Monitor {
    pub fn start(config_file: Option<PathBuf>) -> Option<Self> {
        static STARTED: AtomicBool = AtomicBool::new(false);
        Self::spawn(
            move || check_attention(config_file.clone()),
            Duration::from_secs(5),
            &STARTED,
        )
    }

    fn spawn(
        mut check: impl FnMut() -> Option<&'static str> + Send + 'static,
        interval: Duration,
        started: &AtomicBool,
    ) -> Option<Self> {
        if started.swap(true, Ordering::Relaxed) {
            return None;
        }
        let stopped = Arc::new(AtomicBool::new(false));
        let cancelled = stopped.clone();
        let (sender, receiver) = oneshot::channel();
        // 单独的普通线程顺序读盘；不占 Tokio blocking pool，退出不等待慢磁盘。
        let worker = std::thread::Builder::new()
            .name("areal-trajectory-status".into())
            .spawn(move || {
                while !cancelled.load(Ordering::Acquire) {
                    let notice = check();
                    if cancelled.load(Ordering::Acquire) {
                        return;
                    }
                    if let Some(notice) = notice {
                        let _ = sender.send(notice.to_owned());
                        return;
                    }
                    // 从检查完成后计时，慢检查不会叠加线程或追赶积压 tick。
                    let deadline = Instant::now() + interval;
                    while !cancelled.load(Ordering::Acquire) {
                        let remaining = deadline.saturating_duration_since(Instant::now());
                        if remaining.is_zero() {
                            break;
                        }
                        std::thread::park_timeout(remaining);
                    }
                }
            })
            .ok()?;
        Some(Self {
            stopped,
            worker: worker.thread().clone(),
            notice: Some(receiver),
        })
    }

    pub fn take_notice(&mut self) -> Option<oneshot::Receiver<String>> {
        self.notice.take()
    }
}

impl Drop for Monitor {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        self.worker.unpark();
    }
}

pub async fn with_stderr_notice<T>(
    receiver: Option<oneshot::Receiver<String>>,
    work: impl Future<Output = T>,
) -> T {
    with_notice(receiver, work, |notice| eprintln!("{notice}")).await
}

async fn with_notice<T>(
    receiver: Option<oneshot::Receiver<String>>,
    work: impl Future<Output = T>,
    notify: impl FnOnce(String),
) -> T {
    let Some(receiver) = receiver else {
        return work.await;
    };
    tokio::pin!(work);
    tokio::select! {
        // 短任务已完成时直接返回，不为补提示延长用户请求。
        biased;
        result = &mut work => result,
        result = receiver => {
            if let Ok(notice) = result { notify(notice); }
            work.await
        }
    }
}

fn check_attention(config_file: Option<PathBuf>) -> Option<&'static str> {
    let Ok(cwd) = std::env::current_dir() else {
        return Some(UNREADABLE);
    };
    let inputs = ConfigInputs {
        cwd,
        homedir: std::env::home_dir(),
        env: std::env::vars_os().collect(),
        config_file,
        ..Default::default()
    };
    attention_from_inputs(&inputs)
}

fn attention_from_inputs(inputs: &ConfigInputs) -> Option<&'static str> {
    let Ok(config) = load_management_config(inputs) else {
        // 无法确认开关时只报告检查不可用，不泄露配置错误或声称上传已失败。
        return Some(UNREADABLE);
    };
    if !config.trajectory.enabled {
        return None;
    }
    match areal_server::trajectory::status(&config.trajectory) {
        Ok(status) if matches!(status["state"].as_str(), Some("degraded" | "invalid")) => {
            Some(WARNING)
        }
        Ok(_) => None,
        Err(_) => Some(UNREADABLE),
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
    /// 检查接收端是否支持用户显式评价。
    FeedbackStatus,
    /// 从标准输入提交冻结上下文和用户评价。
    FeedbackSubmit,
    /// 读取本地轨迹积压和错误，不启动模型或上传。
    Status,
    /// 只切换已有接收配置的启用状态；保留队列并应用后台上传控制。
    SetEnabled {
        #[arg(action = clap::ArgAction::Set, value_parser = clap::value_parser!(bool))]
        enabled: bool,
        #[arg(long)]
        expected_revision: Option<String>,
    },
    /// 将失败记录重新排队；上传由独立后台进程完成。
    Retry,
    /// 应用持久导出控制；现有 Core 的采集配置仍需安全重启。
    SyncConfig {
        /// 显式重新开启时补传仍保留的失败记录，保留接收端退避。
        #[arg(long)]
        resume_retained: bool,
    },
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
        Command::FeedbackStatus => {
            areal_server::trajectory::feedback::request(&config.trajectory, None)?
        }
        Command::FeedbackSubmit => {
            use std::io::Read;
            let mut bytes = Vec::new();
            std::io::stdin()
                .take((16 << 20) + (128 << 10) + 1)
                .read_to_end(&mut bytes)?;
            anyhow::ensure!(
                bytes.len() <= (16 << 20) + (128 << 10),
                "feedback_request_oversize"
            );
            areal_server::trajectory::feedback::request(
                &config.trajectory,
                Some(serde_json::from_slice(&bytes)?),
            )?
        }
        Command::Status => areal_server::trajectory::status(&config.trajectory)?,
        Command::SetEnabled {
            enabled,
            expected_revision,
        } => {
            let was_enabled = config.trajectory.enabled;
            // 恢复决策绑定本次读取；省略显式版本也拒绝并发变更，避免重复恢复失败副本。
            let expected_revision =
                expected_revision.unwrap_or_else(|| config.trajectory.source_revision.clone());
            config =
                areal_config::set_trajectory_enabled(&inputs, enabled, Some(&expected_revision))?;
            areal_server::trajectory::configure(&config.trajectory)?;
            if enabled && !was_enabled {
                areal_server::trajectory::resume_retained(&config.trajectory)?
            } else {
                areal_server::trajectory::status(&config.trajectory)?
            }
        }
        Command::Retry => areal_server::trajectory::retry_failed(&config.trajectory)?,
        Command::SyncConfig { resume_retained } => {
            areal_server::trajectory::configure(&config.trajectory)?;
            if resume_retained && config.trajectory.enabled {
                areal_server::trajectory::resume_retained(&config.trajectory)?
            } else {
                areal_server::trajectory::status(&config.trajectory)?
            }
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
    if result.get("queue").is_some() && result.get("records").is_some() {
        result["config_revision"] = config.trajectory.source_revision.into();
    }
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{atomic::AtomicUsize, mpsc};

    #[test]
    fn disabled_skips_queue_reads_and_unreadable_configuration_is_redacted() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.toml");
        let inputs = ConfigInputs {
            cwd: directory.path().to_owned(),
            homedir: Some(directory.path().to_owned()),
            config_file: Some(path.clone()),
            ..Default::default()
        };
        std::fs::write(directory.path().join("queue"), "not a queue directory").unwrap();
        std::fs::write(&path, "schema_version=2\n[trajectory]\nenabled=false\nendpoint='invalid'\nspool_dir='queue'\n").unwrap();
        assert_eq!(attention_from_inputs(&inputs), None);
        std::fs::write(&path, "not valid TOML private-token").unwrap();
        assert_eq!(attention_from_inputs(&inputs), Some(UNREADABLE));
        assert!(!UNREADABLE.contains("private-token"));
        assert!(!directory.path().join(".areal").exists());
    }

    #[tokio::test]
    async fn slow_check_delivers_while_session_lives_without_delaying_start() {
        let (release, blocked) = mpsc::channel();
        let gate = AtomicBool::new(false);
        let started = Instant::now();
        let mut monitor = Monitor::spawn(
            move || {
                blocked.recv().unwrap();
                Some(WARNING)
            },
            Duration::from_secs(5),
            &gate,
        )
        .unwrap();
        assert!(started.elapsed() < Duration::from_millis(200));
        tokio::time::sleep(Duration::from_millis(40)).await;
        release.send(()).unwrap();
        let notice = tokio::time::timeout(Duration::from_secs(1), monitor.take_notice().unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(notice, WARNING);
        assert!(Monitor::spawn(|| Some(WARNING), Duration::ZERO, &gate).is_none());
    }

    #[tokio::test]
    async fn later_failure_is_checked_serially_and_notified_once() {
        let calls = Arc::new(AtomicUsize::new(0));
        let checks = calls.clone();
        let mut monitor = Monitor::spawn(
            move || {
                let n = checks.fetch_add(1, Ordering::SeqCst);
                (n == 2).then_some(WARNING)
            },
            Duration::from_millis(20),
            &AtomicBool::new(false),
        )
        .unwrap();
        let notices = AtomicUsize::new(0);
        let (notified, observed) = oneshot::channel();
        let output = with_notice(
            monitor.take_notice(),
            async {
                tokio::time::timeout(Duration::from_secs(2), observed)
                    .await
                    .unwrap()
                    .unwrap();
                "json result"
            },
            |_| {
                notices.fetch_add(1, Ordering::SeqCst);
                let _ = notified.send(());
            },
        )
        .await;
        assert_eq!(output, "json result");
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        assert_eq!(notices.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cancellation_does_not_wait_for_slow_disk_or_publish_after_exit() {
        let (release, blocked) = mpsc::channel();
        let (entered, started) = mpsc::channel();
        let mut monitor = Monitor::spawn(
            move || {
                entered.send(()).unwrap();
                blocked.recv().unwrap();
                Some(WARNING)
            },
            Duration::from_secs(5),
            &AtomicBool::new(false),
        )
        .unwrap();
        started.recv_timeout(Duration::from_secs(1)).unwrap();
        let receiver = monitor.take_notice().unwrap();
        let at = Instant::now();
        drop(monitor);
        assert!(at.elapsed() < Duration::from_millis(100));
        release.send(()).unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), receiver)
                .await
                .unwrap()
                .is_err()
        );
    }

    #[tokio::test]
    async fn completed_exec_never_waits_for_a_notice() {
        let (_sender, receiver) = oneshot::channel();
        let result = tokio::time::timeout(
            Duration::from_millis(100),
            with_notice(Some(receiver), async { 17 }, |_| {
                panic!("completed task must not wait")
            }),
        )
        .await
        .unwrap();
        assert_eq!(result, 17);
    }
}
