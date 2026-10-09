//! 可选的标准 OTLP Logs 持久发送器；不依赖任何平台或修改 Agent 的执行结果。
mod json;
mod processor;
mod queue;
#[cfg(test)]
mod tests;
mod worker;

use anyhow::{Context, Result};
use areal_config::TrajectoryConfig;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub(crate) use processor::Processor;
pub use worker::run_worker;

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
fn destination(config: &TrajectoryConfig) -> String {
    format!("{:x}", Sha256::digest(config.endpoint.as_bytes()))
}
fn endpoint(config: &TrajectoryConfig) -> Result<url::Url> {
    let mut url =
        url::Url::parse(&config.endpoint).map_err(|_| anyhow::anyhow!("invalid_endpoint"))?;
    anyhow::ensure!(
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "invalid_endpoint"
    );
    if !url.path().trim_end_matches('/').ends_with("/v1/logs") {
        url.set_path(&format!("{}/v1/logs", url.path().trim_end_matches('/')));
    }
    Ok(url)
}

/// 写入无秘密的控制快照；运行中的上传器会在下一次发送前重新读取。
/// 不等待网络，不验证远端连通性。停用保留历史和未上传数据。
pub fn configure(config: &TrajectoryConfig) -> Result<()> {
    if !config.enabled && !config.spool_dir.exists() {
        return Ok(());
    }
    let root = &config.spool_dir;
    queue::directory(root)?;
    {
        let _lock = queue::lock(root, ".queue.lock", true)?;
        queue::atomic(root, "control.json", &serde_json::to_vec(config)?)?;
        let mut totals = queue::stats(root);
        queue::prune(config, 0, false, &mut totals)?;
        queue::save_stats(root, &totals)?;
    }
    if config.enabled && endpoint(config).is_ok() {
        ensure_worker(root)?;
    }
    Ok(())
}

fn worker_running(root: &Path) -> bool {
    if !root.exists() {
        return false;
    }
    matches!(queue::lock(root, ".worker.lock", false), Ok(None))
}
fn ensure_worker(root: &Path) -> Result<()> {
    if cfg!(test) {
        return Ok(());
    }
    use std::{
        os::unix::process::CommandExt,
        process::{Command, Stdio},
    };
    let Some(_spawn) = queue::lock(root, ".spawn.lock", false)? else {
        return Ok(());
    };
    if !queue::read::<TrajectoryConfig>(root, "control.json", 16384).is_ok_and(|c| c.enabled) {
        return Ok(());
    }
    if worker_running(root) {
        return Ok(());
    }
    if queue::read::<u64>(root, "spawned_at.json", 128)
        .is_ok_and(|t| now().saturating_sub(t) < 5000)
    {
        return Ok(());
    }
    {
        let _queue = queue::lock(root, ".queue.lock", true)?;
        queue::atomic(root, "spawned_at.json", &serde_json::to_vec(&now())?)?;
    }
    #[cfg(target_os = "macos")]
    let mut command = {
        // 与可信 launcher 保持相同的 macOS 启动路径；Python 持有实际 Rust 子进程。
        let mut c = Command::new("/usr/bin/python3");
        c.args(["-I","-S","-c","import subprocess,sys; p=subprocess.run(sys.argv[1:]); sys.exit(p.returncode if p.returncode>=0 else 128-p.returncode)"])
            .arg(std::env::current_exe()?);
        c
    };
    #[cfg(not(target_os = "macos"))]
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("trajectory-worker")
        .arg("--spool-dir")
        .arg(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // 上传器不能继承 Core 的会话/生命周期；关闭终端或独占 launcher 不终止它。
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().context("cannot start trajectory worker")?;
    // 仍在同一宿主存活期间主动回收子进程；Core 退出后由系统收养。
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// 状态只输出有界元数据；不读取轨迹正文或凭据。
pub fn status(config: &TrajectoryConfig) -> Result<Value> {
    let root = &config.spool_dir;
    let records = if root.exists() {
        queue::records(root, config.max_disk_bytes)?
    } else {
        Vec::new()
    };
    let totals = queue::stats(root);
    let bytes: u64 = records
        .iter()
        .map(|r| {
            serde_json::to_vec(r).map_or(0, |b| b.len() as u64)
                + if r.payload_present { r.bytes as u64 } else { 0 }
        })
        .sum();
    let count = |state: &str| records.iter().filter(|r| r.status == state).count();
    let invalid = config.enabled && endpoint(config).is_err();
    let error = if invalid {
        Some("invalid_endpoint".to_string())
    } else {
        totals.last_error.clone()
    };
    let running = worker_running(root);
    Ok(json!({
        "enabled": config.enabled, "state": if !config.enabled {"disabled"} else if invalid {"invalid"} else if error.is_some() || count("failed") > 0 {"degraded"} else {"ready"},
        "endpoint": config.diagnostic()["endpoint"], "spool_dir": root, "worker_running": running,
        "queue": {"pending":count("pending"),"uploading":count("uploading"),"failed":count("failed"),
            "uploaded":totals.uploaded,"evicted":totals.evicted,"bytes":bytes,"max_bytes":config.max_disk_bytes,
            "dropped_memory":totals.dropped_memory,"dropped_oversize":totals.dropped_oversize},
        "last_error":error,"last_success_at":totals.last_success_at,
        "records":records.iter().rev().take(100).map(|r|json!({"id":r.id,"status":r.status,"created_at":r.created_at,
            "uploaded_at":r.uploaded_at,"attempts":r.attempts,"next_attempt_at":r.next_attempt_at,
            "bytes":r.bytes,"error":r.error,"turn_id":r.turn_id,"event_name":r.event_name,"model_name":r.model_name,
            "harness_version":r.harness_version,"occurred_at":r.occurred_at,"execution_duration_ms":r.execution_duration_ms})).collect::<Vec<_>>(),
        "limits":{"max_retries":config.max_retries,"upload_interval_ms":config.upload_interval_ms,"max_memory_bytes":config.max_memory_bytes}
    }))
}

pub fn retry_failed(config: &TrajectoryConfig) -> Result<Value> {
    if !config.spool_dir.exists() {
        return status(config);
    }
    {
        let _lock = queue::lock(&config.spool_dir, ".queue.lock", true)?;
        for mut record in queue::records(&config.spool_dir, config.max_disk_bytes)? {
            if record.status == "failed"
                && record.payload_present
                && record.destination == destination(config)
            {
                record.status = "pending".into();
                record.attempts = 0;
                record.next_attempt_at = None;
                record.error = None;
                queue::save(&config.spool_dir, &record)?;
            }
        }
        let mut totals = queue::stats(&config.spool_dir);
        totals.not_before = 0;
        totals.consecutive_failures = 0;
        totals.last_error = None;
        queue::save_stats(&config.spool_dir, &totals)?;
    }
    configure(config)?;
    status(config)
}
