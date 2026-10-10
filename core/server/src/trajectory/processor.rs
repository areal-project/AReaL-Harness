use super::*;
use opentelemetry::{InstrumentationScope, logs::AnyValue};
use opentelemetry_proto::{
    tonic::{collector::logs::v1::ExportLogsServiceRequest, logs::v1::ResourceLogs},
    transform::common::tonic::ResourceAttributesWithSchema,
};
use opentelemetry_sdk::{
    Resource,
    error::OTelSdkResult,
    logs::{LogProcessor, SdkLogRecord},
};
use prost::Message;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    mpsc,
};
use std::time::Duration;

struct MessageRecord {
    record: SdkLogRecord,
    scope: InstrumentationScope,
    reserved: usize,
}
enum Work {
    Record(Box<MessageRecord>),
    Flush(mpsc::Sender<()>),
    Stop(mpsc::Sender<()>),
}
struct Shared {
    used: AtomicUsize,
    dropped: Arc<AtomicU64>,
    stopped: AtomicBool,
}
pub(crate) struct Processor {
    sender: mpsc::SyncSender<Work>,
    shared: Arc<Shared>,
    max_memory: usize,
    max_record: usize,
}
impl std::fmt::Debug for Processor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DurableOtlpProcessor")
    }
}

// 只有采集后台读写磁盘。锁竞争或写入失败时归还计数，下一次 tick/flush 继续尝试。
fn persist_dropped(root: &Path, counter: &AtomicU64) {
    let dropped = counter.swap(0, Ordering::Relaxed);
    if dropped == 0 {
        return;
    }
    if let Ok(Some(_guard)) = queue::lock(root, ".queue.lock", false) {
        let mut totals = queue::stats(root);
        totals.dropped_memory = totals.dropped_memory.saturating_add(dropped);
        totals.last_error = Some("capture_capacity_or_storage".into());
        if queue::save_stats(root, &totals).is_ok() {
            return;
        }
    }
    counter.fetch_add(dropped, Ordering::Relaxed);
}

fn value_bytes(v: &AnyValue) -> usize {
    match v {
        AnyValue::String(v) => v.as_str().len().saturating_add(64),
        AnyValue::Bytes(v) => v.len().saturating_add(64),
        AnyValue::ListAny(v) => v.iter().fold(64, |n, v| n.saturating_add(value_bytes(v))),
        AnyValue::Map(v) => v.iter().fold(64, |n, (k, v)| {
            n.saturating_add(k.as_str().len())
                .saturating_add(128)
                .saturating_add(value_bytes(v))
        }),
        _ => 64,
    }
}
impl Processor {
    pub fn new(config: &TrajectoryConfig) -> Result<Self> {
        let producer = format!(".producer-{}.lock", uuid::Uuid::new_v4());
        let (sender, receiver) = mpsc::sync_channel(config.max_records.min(256));
        let shared = Arc::new(Shared {
            used: AtomicUsize::new(0),
            dropped: Arc::new(AtomicU64::new(0)),
            stopped: AtomicBool::new(false),
        });
        let shared_worker = shared.clone();
        let config_worker = config.clone();
        std::thread::Builder::new()
            .name("areal-trajectory-spool".into())
            .spawn(move || {
                // 安装ID、历史清理和磁盘锁均在后台初始化，慢磁盘不阻塞 Core 启动。
                let initialize = || -> Result<_> {
                    configure_on_startup(&config_worker)?;
                    endpoint(&config_worker)?;
                    let installation = queue::installation(&config_worker.spool_dir)?;
                    let _queue = queue::lock(&config_worker.spool_dir, ".queue.lock", true)?;
                    let lease = queue::lock(&config_worker.spool_dir, &producer, false)?
                        .context("producer lease unavailable")?;
                    let resource = Resource::builder()
                        .with_service_name("areal-core")
                        .with_attribute(opentelemetry::KeyValue::new(
                            "service.version",
                            env!("CARGO_PKG_VERSION"),
                        ))
                        .with_attribute(opentelemetry::KeyValue::new(
                            "service.build.revision",
                            env!("AREAL_BUILD_REVISION"),
                        ))
                        .with_attribute(opentelemetry::KeyValue::new(
                            "service.build.dirty",
                            env!("AREAL_BUILD_DIRTY"),
                        ))
                        .with_attribute(opentelemetry::KeyValue::new(
                            "service.instance.id",
                            installation,
                        ))
                        .build();
                    Ok((resource, lease))
                };
                let Ok((resource, _producer_lease)) = initialize() else {
                    shared_worker.stopped.store(true, Ordering::Release);
                    // 客户端统一显示一次提示，后台故障不向聊天/终端重复输出。
                    return;
                };
                let resource: ResourceAttributesWithSchema = (&resource).into();
                loop {
                    let work = receiver.recv_timeout(Duration::from_secs(1));
                    match work {
                        Ok(Work::Record(item)) => {
                            let mut request = ExportLogsServiceRequest {
                                resource_logs: vec![ResourceLogs::from((
                                    (&item.record, &item.scope),
                                    &resource,
                                ))],
                            };
                            // 结构化 JSON 展开属于采集后台，且从已预留的内存中扣除。
                            super::json::project(&mut request, item.reserved / 4);
                            let result = if request.encoded_len() <= config_worker.max_batch_bytes {
                                queue::enqueue(
                                    &config_worker,
                                    &request.encode_to_vec(),
                                    Some(producer.clone()),
                                )
                            } else {
                                shared_worker.dropped.fetch_add(1, Ordering::Relaxed);
                                Ok(())
                            };
                            shared_worker
                                .used
                                .fetch_sub(item.reserved, Ordering::Relaxed);
                            if result.is_err() {
                                shared_worker.dropped.fetch_add(1, Ordering::Relaxed);
                            }
                            if result.is_ok() {
                                let _ = ensure_worker(&config_worker.spool_dir);
                            }
                        }
                        Ok(Work::Flush(done)) => {
                            persist_dropped(&config_worker.spool_dir, &shared_worker.dropped);
                            let _ = done.send(());
                            continue;
                        }
                        Ok(Work::Stop(done)) => {
                            persist_dropped(&config_worker.spool_dir, &shared_worker.dropped);
                            let _ = done.send(());
                            break;
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            persist_dropped(&config_worker.spool_dir, &shared_worker.dropped);
                            break;
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            if shared_worker.stopped.load(Ordering::Acquire) {
                                persist_dropped(&config_worker.spool_dir, &shared_worker.dropped);
                                break;
                            }
                            // 启动瞬间的进程故障也需要恢复，不能只等下一次 Agent 请求。
                            if !worker_running(&config_worker.spool_dir)
                                && queue::records(
                                    &config_worker.spool_dir,
                                    config_worker.max_disk_bytes,
                                )
                                .is_ok_and(|rs| {
                                    rs.iter().any(|r| {
                                        matches!(r.status.as_str(), "pending" | "uploading")
                                    })
                                })
                            {
                                let _ = ensure_worker(&config_worker.spool_dir);
                            }
                        }
                    }
                    persist_dropped(&config_worker.spool_dir, &shared_worker.dropped);
                }
            })?;
        Ok(Self {
            sender,
            shared,
            // Engine 内容构造与 EventLayer 各占四分之一，其余供后台副本与编码。
            max_memory: config.max_memory_bytes / 2,
            max_record: config.max_batch_bytes,
        })
    }
    pub(crate) fn drop_counter(&self) -> Arc<AtomicU64> {
        self.shared.dropped.clone()
    }
    fn flush(&self, stop: bool, timeout: Duration) {
        if stop {
            self.shared.stopped.store(true, Ordering::Release);
        }
        let (done, wait) = mpsc::channel();
        let message = if stop {
            Work::Stop(done)
        } else {
            Work::Flush(done)
        };
        // 管理路径也不因满内存队列无限等待；断电/强杀前未落盘部分不承诺恢复。
        if self.sender.try_send(message).is_ok() {
            let _ = wait.recv_timeout(timeout);
        }
    }
}
impl LogProcessor for Processor {
    fn emit(&self, record: &mut SdkLogRecord, scope: &InstrumentationScope) {
        if self.shared.stopped.load(Ordering::Acquire) {
            return;
        }
        let size = record
            .attributes_iter()
            .fold(2048usize, |n, (k, v)| {
                n.saturating_add(k.as_str().len())
                    .saturating_add(value_bytes(v))
            })
            .saturating_add(record.body().map_or(0, value_bytes));
        // 为 clone、protobuf 投影与编码缓冲预留空间，拒绝超大事件而不阻塞模型线程。
        let reserved = size.saturating_mul(8);
        if size > self.max_record
            || self
                .shared
                .used
                .fetch_update(Ordering::AcqRel, Ordering::Relaxed, |used| {
                    used.checked_add(reserved).filter(|n| *n <= self.max_memory)
                })
                .is_err()
        {
            self.shared.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        let item = MessageRecord {
            record: record.clone(),
            scope: scope.clone(),
            reserved,
        };
        if self.sender.try_send(Work::Record(Box::new(item))).is_err() {
            self.shared.used.fetch_sub(reserved, Ordering::Relaxed);
            self.shared.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
    fn force_flush(&self) -> OTelSdkResult {
        self.flush(false, Duration::from_millis(200));
        Ok(())
    }
    fn shutdown_with_timeout(&self, timeout: Duration) -> OTelSdkResult {
        self.flush(true, timeout.min(Duration::from_millis(200)));
        Ok(())
    }
    // 使用独立、固定的资源身份，避免普通观测配置伪造安装ID或产品版本。
    fn set_resource(&mut self, _resource: &Resource) {}
}

#[cfg(test)]
mod drop_counter_tests {
    use super::*;

    fn config(root: &Path) -> TrajectoryConfig {
        TrajectoryConfig {
            source_id: "drop-counter-test".into(),
            source_file: None,
            source_revision: String::new(),
            enabled: true,
            endpoint: "http://127.0.0.1:1/v1/logs".into(),
            spool_dir: root.into(),
            max_disk_bytes: 1024 * 1024,
            max_memory_bytes: 256 * 1024,
            max_batch_bytes: 64 * 1024,
            max_records: 20,
            max_retries: 6,
            retry_initial_seconds: 1,
            retry_max_seconds: 10,
            request_timeout_seconds: 1,
            upload_interval_ms: 10,
            headers_env: None,
            headers_file: None,
        }
    }

    #[test]
    fn whole_event_drops_persist_before_flush_and_stop_without_records() {
        let dir = tempfile::tempdir().unwrap();
        let processor = Processor::new(&config(dir.path())).unwrap();
        let dropped = processor.drop_counter();
        for (stop, count, total) in [(false, 3, 3), (true, 2, 5)] {
            dropped.fetch_add(count, Ordering::Relaxed);
            let (done, wait) = mpsc::channel();
            processor
                .sender
                .send(if stop {
                    Work::Stop(done)
                } else {
                    Work::Flush(done)
                })
                .unwrap();
            // 回执之前必须已尝试持久化；不依赖后续成功事件或下一秒 tick。
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            let stats = queue::stats(dir.path());
            assert_eq!(stats.dropped_memory, total);
            assert_eq!(
                stats.last_error.as_deref(),
                Some("capture_capacity_or_storage")
            );
            assert_eq!(dropped.load(Ordering::Relaxed), 0);
            assert!(queue::records(dir.path(), 1024 * 1024).unwrap().is_empty());
        }
    }

    #[test]
    fn drop_counter_is_restored_on_lock_contention_and_not_double_counted() {
        let dir = tempfile::tempdir().unwrap();
        let dropped = AtomicU64::new(4);
        let held = queue::lock(dir.path(), ".queue.lock", true).unwrap();
        persist_dropped(dir.path(), &dropped);
        assert_eq!(dropped.load(Ordering::Relaxed), 4);
        assert_eq!(queue::stats(dir.path()).dropped_memory, 0);
        drop(held);
        persist_dropped(dir.path(), &dropped);
        persist_dropped(dir.path(), &dropped);
        assert_eq!(queue::stats(dir.path()).dropped_memory, 4);
        assert_eq!(dropped.load(Ordering::Relaxed), 0);
    }
}
