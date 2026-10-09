//! 队列只拥有遥测副本；清理绝不访问 Engine 的历史或 Blob。
use super::*;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
};

#[cfg(test)]
thread_local! {
    static FAIL_WRITE: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}
#[cfg(test)]
pub(super) fn fail_next_write(name: String) {
    FAIL_WRITE.with(|fault| *fault.borrow_mut() = Some(name));
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Record {
    pub id: String,
    pub status: String,
    pub created_at: u64,
    pub uploaded_at: Option<u64>,
    #[serde(default)]
    pub completion_sequence: Option<u64>,
    #[serde(default)]
    pub completion_not_before: Option<u64>,
    pub attempts: u32,
    pub next_attempt_at: Option<u64>,
    pub bytes: usize,
    pub error: Option<String>,
    pub destination: String,
    #[serde(default)]
    pub turn_id: String,
    #[serde(default)]
    pub event_name: String,
    #[serde(default)]
    pub model_name: String,
    #[serde(default)]
    pub harness_version: String,
    #[serde(default)]
    pub occurred_at: u64,
    #[serde(default)]
    pub execution_duration_ms: Option<u64>,
    #[serde(default)]
    pub terminal: bool,
    #[serde(default)]
    pub producer: Option<String>,
    pub payload_present: bool,
    pub sha256: String,
}
#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
pub(super) struct Statistics {
    pub uploaded: u64,
    pub evicted: u64,
    pub dropped_memory: u64,
    pub dropped_oversize: u64,
    pub last_error: Option<String>,
    pub last_success_at: Option<u64>,
    pub not_before: u64,
    pub consecutive_failures: u32,
}

pub(super) fn directory(root: &Path) -> Result<()> {
    if !root.exists() {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(root)?;
    }
    let metadata = fs::symlink_metadata(root)?;
    anyhow::ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "invalid spool directory"
    );
    Ok(())
}
pub(super) fn lock(root: &Path, name: &str, wait: bool) -> Result<Option<File>> {
    directory(root)?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root.join(name))?;
    if wait {
        file.lock_exclusive()?;
    } else if let Err(e) = file.try_lock_exclusive() {
        if e.kind() == std::io::ErrorKind::WouldBlock {
            return Ok(None);
        }
        return Err(e.into());
    }
    Ok(Some(file))
}
pub(super) fn atomic(root: &Path, name: &str, bytes: &[u8]) -> Result<()> {
    #[cfg(test)]
    if FAIL_WRITE.with(|fault| {
        let mut fault = fault.borrow_mut();
        if fault.as_deref() == Some(name) {
            fault.take();
            true
        } else {
            false
        }
    }) {
        anyhow::bail!("injected atomic write failure");
    }
    let mut temp = tempfile::Builder::new()
        .prefix(".trajectory-tmp-")
        .tempfile_in(root)?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(root.join(name))?;
    File::open(root)?.sync_all()?;
    Ok(())
}
pub(super) fn read<T: serde::de::DeserializeOwned>(
    root: &Path,
    name: &str,
    limit: u64,
) -> Result<T> {
    use std::io::Read;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(root.join(name))?;
    anyhow::ensure!(
        file.metadata()?.is_file() && file.metadata()?.len() <= limit,
        "spool record exceeds limit"
    );
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    anyhow::ensure!(bytes.len() as u64 <= limit, "spool record exceeds limit");
    Ok(serde_json::from_slice(&bytes)?)
}
pub(super) fn stats(root: &Path) -> Statistics {
    read(root, "statistics.json", 8192).unwrap_or_default()
}
pub(super) fn save_stats(root: &Path, stats: &Statistics) -> Result<()> {
    atomic(root, "statistics.json", &serde_json::to_vec(stats)?)
}
// 完成记录先于统计持久化；崩溃恢复不能把已确认完成的上传误算成失败或重复计数。
pub(super) fn recover_statistics(records: &[Record], stats: &mut Statistics) {
    for record in records {
        if record.status == "uploaded"
            && let Some(sequence) = record.completion_sequence
            && sequence > stats.uploaded
        {
            stats.uploaded = sequence;
            stats.last_success_at = record.uploaded_at;
            stats.consecutive_failures = 0;
            stats.not_before = record.completion_not_before.unwrap_or(stats.not_before);
            // 只清除被该 ACK 覆盖的传输错误，保留之后发生的采集/磁盘容量告警。
            if matches!(
                stats.last_error.as_deref(),
                Some(
                    "invalid_endpoint"
                        | "credential_unavailable"
                        | "upload_timeout"
                        | "connection_failed"
                        | "rate_limited"
                        | "remote_unavailable"
                        | "authentication_rejected"
                        | "request_rejected"
                        | "invalid_otlp_response"
                        | "response_interrupted"
                        | "otlp_partial_rejection"
                        | "payload_unavailable"
                )
            ) {
                stats.last_error = None;
            }
        }
    }
}
pub(super) fn records(root: &Path, _max_bytes: u64) -> Result<Vec<Record>> {
    let mut result = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("record-") || !name.ends_with(".json") {
            continue;
        }
        // 文件名只由本模块生成；未知文件既不读取也不删除。
        if uuid::Uuid::parse_str(&name[7..name.len() - 5]).is_err() {
            continue;
        }
        if let Ok(record) = read::<Record>(root, &name, 8192)
            && name == format!("record-{}.json", record.id)
        {
            result.push(record);
        }
    }
    result.sort_by(|a, b| (&a.created_at, &a.id).cmp(&(&b.created_at, &b.id)));
    Ok(result)
}
pub(super) fn save(root: &Path, record: &Record) -> Result<()> {
    anyhow::ensure!(
        uuid::Uuid::parse_str(&record.id).is_ok(),
        "invalid record id"
    );
    atomic(
        root,
        &format!("record-{}.json", record.id),
        &serde_json::to_vec(record)?,
    )
}
pub(super) fn payload(root: &Path, record: &Record, limit: usize) -> Result<Vec<u8>> {
    use std::io::Read;
    anyhow::ensure!(
        record.payload_present && record.bytes <= limit,
        "missing or oversized payload"
    );
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(root.join(format!("payload-{}.pb", record.id)))?;
    anyhow::ensure!(
        file.metadata()?.is_file() && file.metadata()?.len() == record.bytes as u64,
        "invalid payload"
    );
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    anyhow::ensure!(bytes.len() == record.bytes, "invalid payload");
    anyhow::ensure!(
        format!("{:x}", Sha256::digest(&bytes)) == record.sha256,
        "payload checksum mismatch"
    );
    Ok(bytes)
}
pub(super) fn remove_payload(root: &Path, record: &mut Record) -> Result<()> {
    if record.payload_present {
        match fs::remove_file(root.join(format!("payload-{}.pb", record.id))) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    record.payload_present = false;
    Ok(())
}
pub(super) fn enqueue(
    config: &TrajectoryConfig,
    bytes: &[u8],
    producer: Option<String>,
) -> Result<()> {
    let root = &config.spool_dir;
    let _lock = lock(root, ".queue.lock", true)?;
    let current = read::<TrajectoryConfig>(root, "control.json", 16384)?;
    // 停用和切换目的地以后，旧进程不能继续按过期配置采集。
    anyhow::ensure!(
        owns_control(config, &current),
        "spool_configuration_conflict"
    );
    if !current.enabled || destination(config) != destination(&current) {
        return Ok(());
    }
    let mut totals = stats(root);
    if bytes.len() > current.max_batch_bytes {
        totals.dropped_oversize += 1;
        totals.last_error = Some("record_too_large".into());
        save_stats(root, &totals)?;
        return Ok(());
    }
    use opentelemetry_proto::tonic::{
        collector::logs::v1::ExportLogsServiceRequest, common::v1::any_value,
    };
    use prost::Message;
    let request = ExportLogsServiceRequest::decode(bytes)?;
    let log = request
        .resource_logs
        .iter()
        .flat_map(|r| &r.scope_logs)
        .flat_map(|s| &s.log_records)
        .next();
    let turn_id = log
        .and_then(|l| l.attributes.iter().find(|a| a.key == "areal.turn.id"))
        .and_then(|a| a.value.as_ref())
        .and_then(|v| match &v.value {
            Some(any_value::Value::StringValue(s)) => Some(s.clone()),
            _ => None,
        })
        .unwrap_or_default();
    let terminal = log.is_some_and(|l| l.event_name == "areal.turn.completed");
    let event_name = log.map(|l| l.event_name.clone()).unwrap_or_default();
    let occurred_at = log.map_or(0, |l| l.time_unix_nano / 1_000_000);
    let model_name = log
        .and_then(|l| {
            l.attributes
                .iter()
                .find(|a| a.key == "gen_ai.request.model")
        })
        .and_then(|a| a.value.as_ref())
        .and_then(|v| match &v.value {
            Some(any_value::Value::StringValue(s)) => Some(s.clone()),
            _ => None,
        })
        .unwrap_or_default();
    // 索引字段受独立上限约束；完整模型名仍在不可变 protobuf 中，不因索引过大被误判为损坏。
    let model_name = if model_name.len() > 1024 {
        let mut end = 1024;
        while !model_name.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &model_name[..end])
    } else {
        model_name
    };
    let harness_version = env!("CARGO_PKG_VERSION").to_string();
    let execution_duration_ms = if terminal {
        log.and_then(|l| l.attributes.iter().find(|a| a.key == "areal.duration_ms"))
            .and_then(|a| a.value.as_ref())
            .and_then(|v| match v.value {
                Some(any_value::Value::IntValue(n)) => u64::try_from(n).ok(),
                _ => None,
            })
    } else {
        None
    };
    let record = Record {
        id: uuid::Uuid::new_v4().to_string(),
        status: "pending".into(),
        created_at: now(),
        uploaded_at: None,
        completion_sequence: None,
        completion_not_before: None,
        attempts: 0,
        next_attempt_at: None,
        bytes: bytes.len(),
        error: None,
        destination: destination(config),
        turn_id,
        event_name,
        occurred_at,
        model_name,
        harness_version,
        execution_duration_ms,
        terminal,
        producer,
        payload_present: true,
        sha256: format!("{:x}", Sha256::digest(bytes)),
    };
    let size = serde_json::to_vec(&record)?.len() as u64 + bytes.len() as u64;
    if size.saturating_add(65536) > current.max_disk_bytes {
        totals.dropped_oversize += 1;
        totals.last_error = Some("record_exceeds_disk_budget".into());
        save_stats(root, &totals)?;
        return Ok(());
    }
    prune(&current, size, true, &mut totals)?;
    atomic(root, &format!("payload-{}.pb", record.id), bytes)?;
    save(root, &record)?;
    save_stats(root, &totals)?;
    Ok(())
}

// 容量包括 payload、记录元数据和固定控制空间；按采集时间 FIFO 淘汰。
// 已发出的请求最多持有一个额外的有界 payload；被淘汰记录不会重新写回。
pub(super) fn prune(
    config: &TrajectoryConfig,
    incoming: u64,
    new_record: bool,
    totals: &mut Statistics,
) -> Result<()> {
    let root = &config.spool_dir;
    let mut entries = records(root, config.max_disk_bytes)?;
    let previous_uploaded = totals.uploaded;
    recover_statistics(&entries, totals);
    if totals.uploaded != previous_uploaded {
        // 先恢复统计再回收完成记录，否则第二次磁盘故障可能丢失唯一计数凭证。
        save_stats(root, totals)?;
    }
    let names: std::collections::HashSet<_> = entries
        .iter()
        .filter(|r| r.payload_present)
        .map(|r| format!("payload-{}.pb", r.id))
        .collect();
    let metadata_names: std::collections::HashSet<_> = entries
        .iter()
        .map(|r| format!("record-{}.json", r.id))
        .collect();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(".trajectory-tmp-") && entry.file_type()?.is_file() {
            fs::remove_file(entry.path())?;
        }
        if name.starts_with("record-")
            && name.ends_with(".json")
            && uuid::Uuid::parse_str(&name[7..name.len() - 5]).is_ok()
            && !metadata_names.contains(&name)
        {
            fs::remove_file(entry.path())?;
            totals.last_error = Some("corrupt_record_removed".into());
        }
        if name.starts_with("payload-")
            && name.ends_with(".pb")
            && uuid::Uuid::parse_str(&name[8..name.len() - 3]).is_ok()
            && !names.contains(&name)
        {
            fs::remove_file(entry.path())?;
        }
        if let Some(id) = name
            .strip_prefix(".producer-")
            .and_then(|s| s.strip_suffix(".lock"))
            && uuid::Uuid::parse_str(id).is_ok()
            && let Ok(Some(_lease)) = lock(root, &name, false)
        {
            let _ = fs::remove_file(entry.path());
        }
    }

    let mut used: u64 = entries
        .iter()
        .map(|r| {
            serde_json::to_vec(r).map_or(0, |b| b.len() as u64)
                + if r.payload_present { r.bytes as u64 } else { 0 }
        })
        .sum();
    for entry in &mut entries {
        if used.saturating_add(incoming).saturating_add(65536) <= config.max_disk_bytes {
            break;
        }
        if !entry.payload_present {
            continue;
        }
        let old = serde_json::to_vec(entry)?.len() as u64 + entry.bytes as u64;
        remove_payload(root, entry)?;
        entry.status = "evicted".into();
        entry.next_attempt_at = None;
        entry.error = Some("fifo_disk_limit".into());
        totals.evicted += 1;
        totals.last_error = Some("fifo_disk_limit".into());
        save(root, entry)?;
        used = used
            .saturating_sub(old)
            .saturating_add(serde_json::to_vec(entry)?.len() as u64);
    }
    let mut count = entries.len() + usize::from(new_record);
    for entry in &entries {
        if count <= config.max_records
            && used.saturating_add(incoming).saturating_add(65536) <= config.max_disk_bytes
        {
            break;
        }
        if entry.payload_present {
            totals.evicted += 1;
            totals.last_error = Some("fifo_record_limit".into());
        }
        used = used.saturating_sub(
            serde_json::to_vec(entry)?.len() as u64
                + if entry.payload_present {
                    entry.bytes as u64
                } else {
                    0
                },
        );
        remove_payload(root, &mut entry.clone())?;
        fs::remove_file(root.join(format!("record-{}.json", entry.id)))?;
        count = count.saturating_sub(1);
    }
    Ok(())
}

pub(super) fn installation(root: &Path) -> Result<String> {
    let _lock = lock(root, ".queue.lock", true)?;
    if let Ok(value) = read::<String>(root, "installation.json", 256)
        && uuid::Uuid::parse_str(&value).is_ok()
    {
        return Ok(value);
    }
    let value = uuid::Uuid::new_v4().to_string();
    atomic(root, "installation.json", &serde_json::to_vec(&value)?)?;
    Ok(value)
}
