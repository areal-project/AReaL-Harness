//! 采集初始化诊断与上传统计分离，上传成功不能掩盖采集已经停止。
use super::*;
use serde::{Deserialize, Serialize};
use std::sync::{
    Arc, Mutex, Weak,
    atomic::{AtomicU8, Ordering},
};

const STARTING: u8 = 0;
const READY: u8 = 1;
const INITIALIZATION_FAILED: u8 = 2;
const THREAD_UNAVAILABLE: u8 = 3;
const MAX_FAILURES: usize = 64;

// 一个 Core 只有一个有效采集配置；弱引用不延长它的生命周期。
static ACTIVE: Mutex<Option<Weak<Inner>>> = Mutex::new(None);
#[cfg(test)]
pub(super) static ACTIVE_TEST_LOCK: Mutex<()> = Mutex::new(());

struct Inner {
    identity: String,
    pid: u32,
    state: AtomicU8,
    persisted: AtomicU8,
}

#[derive(Clone)]
pub struct CaptureHealth(Arc<Inner>);

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Failure {
    CaptureInitializationFailed,
    CaptureThreadUnavailable,
}
impl Failure {
    fn code(self) -> &'static str {
        match self {
            Self::CaptureInitializationFailed => "capture_initialization_failed",
            Self::CaptureThreadUnavailable => "capture_thread_unavailable",
        }
    }
}

#[derive(Serialize, Deserialize)]
struct ProcessFailure {
    pid: u32,
    error: Failure,
}

#[derive(Default, Serialize, Deserialize)]
struct Snapshot {
    identity: String,
    failures: Vec<ProcessFailure>,
    overflow: bool,
}

fn process_exists(pid: u32) -> bool {
    let pid = match i32::try_from(pid) {
        Ok(pid) if pid > 0 => pid,
        _ => return false,
    };
    // 只探测存活，不发送信号；PID 复用宁可暂时保留旧故障，也不误报其它活动 Core 健康。
    let exists = unsafe { libc::kill(pid, 0) == 0 };
    exists || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

fn snapshot(root: &Path) -> Result<Option<Snapshot>> {
    match std::fs::symlink_metadata(root.join("capture-status.json")) {
        Ok(_) => queue::read::<Snapshot>(root, "capture-status.json", 16384).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn identity(config: &TrajectoryConfig) -> String {
    // 与部署兼容性使用同一有效设置；模型或注释修订不能掩盖仍存活 Core 的采集故障。
    // 原文件版本只参与写入防过期，不是故障身份；摘要不保存路径或凭据正文。
    format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&config.diagnostic()).expect("trajectory configuration serializes")
        )
    )
}

fn failure(state: u8) -> Option<Failure> {
    match state {
        INITIALIZATION_FAILED => Some(Failure::CaptureInitializationFailed),
        THREAD_UNAVAILABLE => Some(Failure::CaptureThreadUnavailable),
        _ => None,
    }
}

impl CaptureHealth {
    pub fn new(config: &TrajectoryConfig) -> Self {
        Self(Arc::new(Inner {
            identity: identity(config),
            pid: std::process::id(),
            state: AtomicU8::new(STARTING),
            persisted: AtomicU8::new(STARTING),
        }))
    }

    pub fn activate(&self) {
        *ACTIVE.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::downgrade(&self.0));
    }

    pub(super) fn initialized(&self) {
        self.0.state.store(READY, Ordering::Release);
    }

    pub(super) fn initialization_failed(&self) {
        self.0.state.store(INITIALIZATION_FAILED, Ordering::Release);
    }

    pub(super) fn thread_unavailable(&self) {
        self.0.state.store(THREAD_UNAVAILABLE, Ordering::Release);
    }

    // 只能由采集线程或现有诊断后台调用；主启动和事件发射不等待磁盘。
    pub fn persist(&self, config: &TrajectoryConfig) {
        let state = self.0.state.load(Ordering::Acquire);
        if state == STARTING || state == self.0.persisted.load(Ordering::Acquire) {
            return;
        }
        if self.persist_inner(config, state).is_ok() {
            self.0.persisted.store(state, Ordering::Release);
        }
    }

    fn persist_inner(&self, config: &TrajectoryConfig, state: u8) -> Result<()> {
        let _lock = queue::lock(&config.spool_dir, ".queue.lock", false)?
            .context("capture_diagnostic_busy")?;
        let control = persisted_control(&config.spool_dir)?;
        // 同一采集配置的活动故障必须能继续补写，模型或注释修订不能永久饿死诊断。
        // 这里只写健康快照，不更新控制；成功清理或没有控制快照时仍要求原文件版本。
        let failure_scope = control.is_some() && failure(state).is_some();
        if !failure_scope && let Some(path) = &config.source_file {
            anyhow::ensure!(
                source_revision(path)? == config.source_revision,
                "capture_diagnostic_expired"
            );
        }
        if let Some(control) = control {
            anyhow::ensure!(
                owns_control(config, &control)
                    && same_settings(config, &control)
                    && (failure_scope || control.source_revision == config.source_revision),
                "capture_diagnostic_expired"
            );
        }
        let mut snapshot = snapshot(&config.spool_dir)?
            .filter(|snapshot| snapshot.identity == self.0.identity)
            .unwrap_or_else(|| Snapshot {
                identity: self.0.identity.clone(),
                ..Snapshot::default()
            });
        anyhow::ensure!(
            snapshot.failures.len() <= MAX_FAILURES,
            "capture_diagnostic_invalid"
        );
        snapshot
            .failures
            .retain(|failure| failure.pid != self.0.pid && process_exists(failure.pid));
        if let Some(error) = failure(state) {
            if snapshot.failures.len() < MAX_FAILURES {
                snapshot.failures.push(ProcessFailure {
                    pid: self.0.pid,
                    error,
                });
            } else {
                // 超过固定上限时保持保守告警；有效采集设置变化前不能证明遗漏的 Core 已恢复。
                snapshot.overflow = true;
            }
        }
        queue::atomic(
            &config.spool_dir,
            "capture-status.json",
            &serde_json::to_vec(&snapshot)?,
        )
    }
}

pub(super) fn error(config: &TrajectoryConfig) -> Option<&'static str> {
    if !config.enabled {
        return None;
    }
    let identity = identity(config);
    let active = ACTIVE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(health) = active.as_ref().and_then(Weak::upgrade)
        && health.identity == identity
    {
        let state = health.state.load(Ordering::Acquire);
        if let Some(failure) = failure(state) {
            return Some(failure.code());
        }
    }
    drop(active);
    match snapshot(&config.spool_dir) {
        Ok(Some(snapshot)) if snapshot.identity == identity => {
            if snapshot.overflow || snapshot.failures.len() > MAX_FAILURES {
                Some("capture_diagnostic_capacity")
            } else {
                snapshot
                    .failures
                    .first()
                    .map(|failure| failure.error.code())
            }
        }
        Ok(_) => None,
        Err(_) => Some("capture_diagnostic_unavailable"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file_config(root: &Path, model: &str, comment: &str, endpoint: &str) -> TrajectoryConfig {
        let path = root.join("config.toml");
        std::fs::write(
            &path,
            format!(
                "schema_version=2\n# {comment}\n[model]\nname='{model}'\n[trajectory]\nenabled=true\nendpoint='{endpoint}'\nspool_dir='spool'\n"
            ),
        )
        .unwrap();
        areal_config::load_management_config(&areal_config::ConfigInputs {
            cwd: root.into(),
            homedir: Some(root.into()),
            config_file: Some(path),
            overrides: areal_config::ConfigOverrides {
                model_endpoint: Some("http://127.0.0.1:9/v1/chat/completions".into()),
                ..Default::default()
            },
            ..Default::default()
        })
        .unwrap()
        .trajectory
    }

    #[test]
    fn file_model_and_comment_edits_keep_live_capture_failure_visible() {
        use opentelemetry_sdk::logs::LogProcessor;
        let _active = ACTIVE_TEST_LOCK.lock().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let original = file_config(directory.path(), "first", "initial", "http://127.0.0.1:1");
        configure(&original).unwrap();
        // 用真实初始化文件错误终止采集线程；存活的 Core 状态仍由同一个 health 持有。
        std::fs::create_dir(original.spool_dir.join("installation.json")).unwrap();
        let failed = CaptureHealth::new(&original);
        failed.activate();
        let processor =
            super::super::processor::Processor::with_health(&original, failed.clone(), TEST_BUILD)
                .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while snapshot(&original.spool_dir).unwrap().is_none() {
            assert!(
                std::time::Instant::now() < deadline,
                "failure not persisted"
            );
            failed.persist(&original);
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let saved = std::fs::read(original.spool_dir.join("capture-status.json")).unwrap();
        for (model, comment) in [("first", "comment edit"), ("second", "comment edit")] {
            let current = file_config(directory.path(), model, comment, "http://127.0.0.1:1");
            assert_ne!(original.source_revision, current.source_revision);
            assert!(same_settings(&original, &current));
            assert_eq!(error(&current), Some("capture_initialization_failed"));
            assert_eq!(status(&current).unwrap()["state"], "degraded");
            // 独立 CLI/GUI 没有当前 Core 内存态，也必须继续看见已经保存的故障。
            *ACTIVE.lock().unwrap() = None;
            assert_eq!(error(&current), Some("capture_initialization_failed"));
            assert_eq!(status(&current).unwrap()["state"], "degraded");
            failed.activate();
        }

        let changed = file_config(directory.path(), "second", "changed", "http://127.0.0.1:2");
        configure(&changed).unwrap();
        assert_eq!(error(&changed), None);
        failed.initialized();
        failed.persist(&original);
        assert_eq!(
            std::fs::read(original.spool_dir.join("capture-status.json")).unwrap(),
            saved,
            "old configuration must not overwrite the new destination's diagnostic scope"
        );
        let mut disabled = original.clone();
        disabled.enabled = false;
        assert_eq!(error(&disabled), None);
        processor
            .shutdown_with_timeout(std::time::Duration::from_millis(200))
            .unwrap();
    }

    #[test]
    fn failed_diagnostic_retries_after_model_edit_without_changing_control() {
        let _active = ACTIVE_TEST_LOCK.lock().unwrap();
        *ACTIVE.lock().unwrap() = None;
        for apply_current in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let original = file_config(directory.path(), "first", "initial", "http://127.0.0.1:1");
            configure(&original).unwrap();
            let failed = CaptureHealth::new(&original);
            failed.thread_unavailable();
            queue::fail_next_write("capture-status.json".into());
            failed.persist(&original);
            assert!(snapshot(&original.spool_dir).unwrap().is_none());

            let current = file_config(
                directory.path(),
                "second",
                "new comment",
                "http://127.0.0.1:1",
            );
            if apply_current {
                configure(&current).unwrap();
            }
            let control = std::fs::read(current.spool_dir.join("control.json")).unwrap();
            failed.persist(&original);
            // 不注册 ACTIVE，独立状态读取必须能看见后台迟到的故障补写。
            assert_eq!(error(&current), Some("capture_thread_unavailable"));
            assert_eq!(status(&current).unwrap()["state"], "degraded");
            assert_eq!(
                std::fs::read(current.spool_dir.join("control.json")).unwrap(),
                control
            );

            let saved = std::fs::read(current.spool_dir.join("capture-status.json")).unwrap();
            let stale_ready = CaptureHealth::new(&original);
            stale_ready.initialized();
            stale_ready.persist(&original);
            assert_eq!(
                std::fs::read(current.spool_dir.join("capture-status.json")).unwrap(),
                saved,
                "model-only edits must not authorize stale success to clear a failure"
            );
            let mut foreign = current.clone();
            foreign.source_id = "another-configuration".into();
            let foreign_failure = CaptureHealth::new(&foreign);
            foreign_failure.initialization_failed();
            foreign_failure.persist(&foreign);
            assert_eq!(
                std::fs::read(current.spool_dir.join("capture-status.json")).unwrap(),
                saved
            );

            let mut disabled = current.clone();
            disabled.enabled = false;
            configure(&disabled).unwrap();
            let stale_failure = CaptureHealth::new(&original);
            stale_failure.initialization_failed();
            stale_failure.persist(&original);
            assert_eq!(
                std::fs::read(current.spool_dir.join("capture-status.json")).unwrap(),
                saved
            );
            assert_eq!(error(&disabled), None);

            let changed = file_config(
                directory.path(),
                "second",
                "new destination",
                "http://127.0.0.1:2",
            );
            configure(&changed).unwrap();
            let snapshot = std::fs::read(current.spool_dir.join("capture-status.json")).unwrap();
            let stale = CaptureHealth::new(&original);
            stale.initialization_failed();
            stale.persist(&original);
            assert_eq!(
                std::fs::read(current.spool_dir.join("capture-status.json")).unwrap(),
                snapshot
            );
            assert_eq!(error(&changed), None);
        }
    }

    #[test]
    fn missing_control_keeps_file_revision_fence_for_thread_failure() {
        let directory = tempfile::tempdir().unwrap();
        let original = file_config(directory.path(), "first", "initial", "http://127.0.0.1:1");
        let failed = CaptureHealth::new(&original);
        failed.thread_unavailable();
        file_config(
            directory.path(),
            "second",
            "new comment",
            "http://127.0.0.1:1",
        );
        failed.persist(&original);
        assert!(snapshot(&original.spool_dir).unwrap().is_none());
        assert!(persisted_control(&original.spool_dir).unwrap().is_none());
    }

    #[test]
    fn diagnostic_retries_after_write_failure_and_cannot_overwrite_new_control() {
        let directory = tempfile::tempdir().unwrap();
        let mut config = super::super::tests::config(directory.path());
        configure(&config).unwrap();
        let health = CaptureHealth::new(&config);
        health.initialization_failed();
        queue::fail_next_write("capture-status.json".into());
        health.persist(&config);
        assert!(!directory.path().join("capture-status.json").exists());
        // 后台采用 try_lock，模拟后续 tick 重试，不能假定一次调用一定获得队列锁。
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while error(&config) != Some("capture_initialization_failed") {
            assert!(
                std::time::Instant::now() < deadline,
                "diagnostic write did not recover"
            );
            health.persist(&config);
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(error(&config), Some("capture_initialization_failed"));

        config.source_revision = "new-revision".into();
        configure(&config).unwrap();
        let replacement = CaptureHealth::new(&config);
        replacement.thread_unavailable();
        replacement.persist(&config);
        let saved = std::fs::read(directory.path().join("capture-status.json")).unwrap();
        let mut stale = config.clone();
        stale.source_revision.clear();
        health.initialized();
        health.persist(&stale);
        assert_eq!(
            std::fs::read(directory.path().join("capture-status.json")).unwrap(),
            saved
        );
        assert_eq!(error(&config), Some("capture_thread_unavailable"));
        assert_eq!(error(&stale), Some("capture_thread_unavailable"));
    }

    #[test]
    fn healthy_core_does_not_hide_another_live_core_failure() {
        let _active = ACTIVE_TEST_LOCK.lock().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let config = file_config(directory.path(), "first", "initial", "http://127.0.0.1:1");
        configure(&config).unwrap();
        // 独立存活进程表示共用队列的另一个 Core，无需启动 Agent 或发送网络请求。
        let mut process = std::process::Command::new("sleep")
            .arg("10")
            .spawn()
            .unwrap();
        let mut failed = CaptureHealth::new(&config);
        Arc::get_mut(&mut failed.0).unwrap().pid = process.id();
        failed.initialization_failed();
        failed.persist(&config);

        let config = file_config(
            directory.path(),
            "second",
            "model edit",
            "http://127.0.0.1:1",
        );
        configure(&config).unwrap();
        let healthy = CaptureHealth::new(&config);
        healthy.activate();
        healthy.initialized();
        healthy.persist(&config);
        assert_eq!(error(&config), Some("capture_initialization_failed"));
        assert_eq!(status(&config).unwrap()["state"], "degraded");
        process.kill().unwrap();
        process.wait().unwrap();
        // 失败历史不会随进程消失立即丢失；后续成功初始化才能清除已退出进程的记录。
        assert_eq!(error(&config), Some("capture_initialization_failed"));
        let restarted = CaptureHealth::new(&config);
        restarted.initialized();
        restarted.persist(&config);
        assert_eq!(error(&config), None);
    }

    #[test]
    fn corrupted_diagnostics_are_visible_and_never_replaced_with_ready() {
        let directory = tempfile::tempdir().unwrap();
        let config = super::super::tests::config(directory.path());
        configure(&config).unwrap();
        let path = directory.path().join("capture-status.json");
        std::fs::write(&path, "private-token invalid JSON").unwrap();
        let healthy = CaptureHealth::new(&config);
        healthy.initialized();
        healthy.persist(&config);
        assert_eq!(error(&config), Some("capture_diagnostic_unavailable"));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "private-token invalid JSON"
        );
    }

    #[test]
    fn diagnostic_capacity_is_bounded_and_overflow_cannot_claim_ready() {
        let directory = tempfile::tempdir().unwrap();
        let config = super::super::tests::config(directory.path());
        configure(&config).unwrap();
        let existing = Snapshot {
            identity: identity(&config),
            failures: (0..MAX_FAILURES)
                .map(|_| ProcessFailure {
                    pid: std::process::id(),
                    error: Failure::CaptureInitializationFailed,
                })
                .collect(),
            overflow: false,
        };
        queue::atomic(
            directory.path(),
            "capture-status.json",
            &serde_json::to_vec(&existing).unwrap(),
        )
        .unwrap();
        let mut additional = CaptureHealth::new(&config);
        Arc::get_mut(&mut additional.0).unwrap().pid = 0;
        additional.thread_unavailable();
        additional.persist(&config);
        let saved = snapshot(directory.path()).unwrap().unwrap();
        assert!(saved.overflow);
        assert_eq!(saved.failures.len(), MAX_FAILURES);
        assert!(serde_json::to_vec(&saved).unwrap().len() < 16384);
        assert_eq!(error(&config), Some("capture_diagnostic_capacity"));
        let healthy = CaptureHealth::new(&config);
        healthy.initialized();
        healthy.persist(&config);
        assert_eq!(error(&config), Some("capture_diagnostic_capacity"));
    }
}
