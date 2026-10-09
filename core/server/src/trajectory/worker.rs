use super::*;
use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceResponse;
use prost::Message;
use queue::Record;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use std::{
    fs::OpenOptions,
    io::Read,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    time::{Duration, Instant},
};

pub(super) fn headers(config: &TrajectoryConfig) -> Result<HeaderMap> {
    let value = if let Some(path) = &config.headers_file {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .map_err(|_| anyhow::anyhow!("credential_unavailable"))?;
        let metadata = file.metadata()?;
        anyhow::ensure!(
            metadata.is_file()
                && metadata.len() <= 16384
                && metadata.permissions().mode() & 0o077 == 0,
            "credential_permissions"
        );
        let mut value = String::new();
        file.take(16385).read_to_string(&mut value)?;
        value
    } else if let Some(name) = &config.headers_env {
        std::env::var(name).map_err(|_| anyhow::anyhow!("credential_unavailable"))?
    } else {
        String::new()
    };
    anyhow::ensure!(value.len() <= 16384, "credential_too_large");
    let mut headers = HeaderMap::new();
    for pair in value.trim().split(',').filter(|s| !s.trim().is_empty()) {
        let (name, value) = pair.split_once('=').context("invalid_credential_headers")?;
        let name = HeaderName::from_bytes(name.trim().as_bytes())
            .map_err(|_| anyhow::anyhow!("invalid_credential_headers"))?;
        anyhow::ensure!(
            !matches!(
                name.as_str(),
                "host" | "content-length" | "content-type" | "connection"
            ),
            "invalid_credential_headers"
        );
        let value = decode_header(value.trim())?;
        headers.insert(
            name,
            HeaderValue::from_str(&value)
                .map_err(|_| anyhow::anyhow!("invalid_credential_headers"))?,
        );
    }
    Ok(headers)
}
fn decode_header(value: &str) -> Result<String> {
    let mut bytes = Vec::with_capacity(value.len());
    let input = value.as_bytes();
    let mut i = 0;
    while i < input.len() {
        if input[i] == b'%' {
            anyhow::ensure!(i + 2 < input.len(), "invalid_credential_headers");
            let a = (input[i + 1] as char)
                .to_digit(16)
                .context("invalid_credential_headers")?;
            let b = (input[i + 2] as char)
                .to_digit(16)
                .context("invalid_credential_headers")?;
            bytes.push((a * 16 + b) as u8);
            i += 3;
        } else {
            bytes.push(input[i]);
            i += 1;
        }
    }
    String::from_utf8(bytes).map_err(|_| anyhow::anyhow!("invalid_credential_headers"))
}
#[derive(Debug)]
pub(super) enum Outcome {
    Success,
    Retry(&'static str, Option<u64>),
    Failed(&'static str),
}
pub(super) async fn upload(
    client: &reqwest::Client,
    config: &TrajectoryConfig,
    bytes: Vec<u8>,
) -> Outcome {
    let url = match endpoint(config) {
        Ok(v) => v,
        Err(_) => return Outcome::Failed("invalid_endpoint"),
    };
    let headers = match headers(config) {
        Ok(v) => v,
        Err(_) => return Outcome::Retry("credential_unavailable", None),
    };
    let response = client
        .post(url)
        .headers(headers)
        .header("content-type", "application/x-protobuf")
        .timeout(Duration::from_secs(config.request_timeout_seconds))
        .body(bytes)
        .send()
        .await;
    let mut response = match response {
        Ok(v) => v,
        Err(e) => {
            return Outcome::Retry(
                if e.is_timeout() {
                    "upload_timeout"
                } else {
                    "connection_failed"
                },
                None,
            );
        }
    };
    let status = response.status().as_u16();
    let after = response
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if matches!(status, 408 | 429 | 502 | 503 | 504) || status >= 500 {
        return Outcome::Retry(
            if status == 429 {
                "rate_limited"
            } else {
                "remote_unavailable"
            },
            after,
        );
    }
    if status != 200 {
        return Outcome::Failed(if matches!(status, 401 | 403) {
            "authentication_rejected"
        } else {
            "request_rejected"
        });
    }
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if body.len() + chunk.len() > 32768 {
                    return Outcome::Failed("invalid_otlp_response");
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(_) => return Outcome::Retry("response_interrupted", None),
        }
    }
    match ExportLogsServiceResponse::decode(body.as_slice()) {
        Ok(v)
            if v.partial_success
                .as_ref()
                .is_none_or(|p| p.rejected_log_records == 0) =>
        {
            Outcome::Success
        }
        Ok(_) => Outcome::Failed("otlp_partial_rejection"),
        Err(_) => Outcome::Failed("invalid_otlp_response"),
    }
}

pub(super) fn backoff(
    config: &TrajectoryConfig,
    failures: u32,
    after: Option<u64>,
    jitter: u64,
) -> u64 {
    let base = config.retry_initial_seconds.saturating_mul(
        1u64.checked_shl(failures.saturating_sub(1).min(32))
            .unwrap_or(u64::MAX),
    );
    let seconds = base
        .saturating_add(jitter % (base / 4 + 1))
        .max(after.unwrap_or(0))
        .min(config.retry_max_seconds);
    seconds.saturating_mul(1000)
}

pub(super) fn pick(config: &TrajectoryConfig) -> Result<Option<Record>> {
    let root = &config.spool_dir;
    let _lock = queue::lock(root, ".queue.lock", true)?;
    let current: TrajectoryConfig = queue::read(root, "control.json", 16384)?;
    anyhow::ensure!(
        owns_control(config, &current),
        "spool_configuration_conflict"
    );
    if !current.enabled {
        return Ok(None);
    }
    let config = &current;
    let mut totals = queue::stats(root);
    if totals.not_before > now() {
        return Ok(None);
    }
    let before = totals.clone();
    queue::prune(config, 0, false, &mut totals)?;
    if before != totals {
        queue::save_stats(root, &totals)?;
    }
    let records = queue::records(root, config.max_disk_bytes)?;
    let settled: std::collections::HashSet<_> = records
        .iter()
        .filter(|r| r.terminal)
        .map(|r| r.turn_id.clone())
        .collect();
    for mut record in records {
        if !record.payload_present || !matches!(record.status.as_str(), "pending" | "uploading") {
            continue;
        }
        if !record.turn_id.is_empty()
            && !settled.contains(&record.turn_id)
            && let Some(producer) = &record.producer
            && producer.starts_with(".producer-")
            && producer.ends_with(".lock")
            && !producer.contains('/')
            && matches!(queue::lock(root, producer, false), Ok(None))
            && now().saturating_sub(record.created_at) < 300_000
        {
            continue;
        }
        if record.destination != destination(config) {
            record.status = "failed".into();
            record.error = Some("destination_changed".into());
            queue::save(root, &record)?;
            continue;
        }
        if record.next_attempt_at.is_some_and(|t| t > now()) {
            continue;
        }
        if record.attempts > config.max_retries {
            record.status = "failed".into();
            record.error = Some("retry_exhausted".into());
            queue::save(root, &record)?;
            continue;
        }
        // 单worker锁保证 uploading 为上次崩溃遗留或当前唯一请求；先记attempt避免重启重置预算。
        record.status = "uploading".into();
        record.attempts += 1;
        queue::save(root, &record)?;
        return Ok(Some(record));
    }
    Ok(None)
}

pub(super) fn settle(config: &TrajectoryConfig, record: &Record, outcome: Outcome) -> Result<()> {
    let root = &config.spool_dir;
    let _lock = queue::lock(root, ".queue.lock", true)?;
    let path = format!("record-{}.json", record.id);
    let Ok(mut current) = queue::read::<Record>(root, &path, 8192) else {
        return Ok(());
    };
    // 上传期间允许 FIFO 回收本地副本，结果不能复活已淘汰的数据。
    if current.status == "evicted" || !current.payload_present {
        return Ok(());
    }
    let mut totals = queue::stats(root);
    totals.not_before = now().saturating_add(config.upload_interval_ms);
    match outcome {
        Outcome::Success => {
            let mut previous = current.clone();
            current.status = "uploaded".into();
            current.uploaded_at = Some(now());
            current.completion_sequence = Some(totals.uploaded.saturating_add(1));
            current.completion_not_before = Some(totals.not_before);
            current.next_attempt_at = None;
            current.error = None;
            current.payload_present = false;
            // 先持久确认再删除副本；磁盘满或崩溃时，至少保留可重放正文或已确认的完成记录。
            queue::save(root, &current)?;
            queue::remove_payload(root, &mut previous)?;
            totals.uploaded = current.completion_sequence.unwrap();
            totals.last_success_at = Some(now());
            totals.last_error = None;
            totals.consecutive_failures = 0;
        }
        Outcome::Failed(error) => {
            current.status = "failed".into();
            current.error = Some(error.into());
            current.next_attempt_at = None;
            totals.last_error = Some(error.into());
        }
        Outcome::Retry(error, after) => {
            totals.consecutive_failures = totals.consecutive_failures.saturating_add(1);
            let delay = backoff(config, totals.consecutive_failures, after, now());
            totals.not_before = now().saturating_add(delay).max(totals.not_before);
            current.error = Some(error.into());
            totals.last_error = Some(error.into());
            if current.attempts > config.max_retries {
                current.status = "failed".into();
                current.next_attempt_at = None;
            } else {
                current.status = "pending".into();
                current.next_attempt_at = Some(totals.not_before);
            }
        }
    }
    queue::save(root, &current)?;
    queue::save_stats(root, &totals)?;
    Ok(())
}

/// 独立进程持有一把跨进程租约；单次请求、固定速率和全局退避隔离补传洪峰。
pub async fn run_worker(root: PathBuf) -> Result<()> {
    let Some(_worker) = queue::lock(&root, ".worker.lock", false)? else {
        return Ok(());
    };
    {
        let _queue = queue::lock(&root, ".queue.lock", true)?;
        let mut stats = queue::stats(&root);
        let previous = stats.clone();
        // 单次启动恢复 ACK，避免上一进程写统计失败后继续使用过时的长退避。
        queue::recover_statistics(&queue::records(&root, 0)?, &mut stats);
        if stats != previous {
            queue::save_stats(&root, &stats)?;
        }
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let mut idle = Instant::now();
    loop {
        let config = queue::read::<TrajectoryConfig>(&root, "control.json", 16384)?;
        if !config.enabled {
            return Ok(());
        }
        if endpoint(&config).is_err() {
            return Ok(());
        }
        let selected = pick(&config)?;
        if let Some(record) = selected {
            idle = Instant::now();
            let result = match queue::payload(&root, &record, config.max_batch_bytes) {
                Ok(bytes) => {
                    // 网络await前再次检查控制，关闭和切换地址不会把队列送到新目的地。
                    let current = queue::read::<TrajectoryConfig>(&root, "control.json", 16384)?;
                    if !current.enabled || destination(&current) != record.destination {
                        return Ok(());
                    }
                    upload(&client, &current, bytes).await
                }
                Err(_) => Outcome::Failed("payload_unavailable"),
            };
            settle(&config, &record, result)?;
        } else if idle.elapsed() > Duration::from_secs(60) {
            // 有退避中的积压就继续存活；空闲或全部失败时退出，下一次入队会重新唤醒。
            let pending = queue::records(&root, config.max_disk_bytes)?
                .iter()
                .any(|r| matches!(r.status.as_str(), "pending" | "uploading"));
            if !pending {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(
            config.upload_interval_ms.clamp(100, 5000),
        ))
        .await;
    }
}
