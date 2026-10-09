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
    dropped: AtomicU64,
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
            dropped: AtomicU64::new(0),
            stopped: AtomicBool::new(false),
        });
        let shared_worker = shared.clone();
        let config_worker = config.clone();
        std::thread::Builder::new()
            .name("areal-trajectory-spool".into())
            .spawn(move || {
                // 安装ID、历史清理和磁盘锁均在后台初始化，慢磁盘不阻塞 Core 启动。
                let initialize = || -> Result<_> {
                    configure(&config_worker)?;
                    endpoint(&config_worker)?;
                    let installation = queue::installation(&config_worker.spool_dir)?;
                    let _queue = queue::lock(&config_worker.spool_dir, ".queue.lock", true)?;
                    let lease = queue::lock(&config_worker.spool_dir, &producer, false)?
                        .context("producer lease unavailable")?;
                    let resource = Resource::builder()
                        .with_service_name("areal-core")
                        .with_attribute(opentelemetry::KeyValue::new("service.version", env!("CARGO_PKG_VERSION")))
                        .with_attribute(opentelemetry::KeyValue::new("service.instance.id", installation))
                        .build();
                    Ok((resource, lease))
                };
                let Ok((resource, _producer_lease)) = initialize() else {
                    shared_worker.stopped.store(true, Ordering::Release);
                    eprintln!("Warning: trajectory reporting unavailable; Agent execution continues. See areal trajectory status.");
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
                            let _ = done.send(());
                        }
                        Ok(Work::Stop(done)) => {
                            let _ = done.send(());
                            break;
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            // 启动瞬间的进程故障也需要恢复，不能只等下一次 Agent 请求。
                            if queue::records(
                                &config_worker.spool_dir,
                                config_worker.max_disk_bytes,
                            )
                            .is_ok_and(|rs| {
                                rs.iter()
                                    .any(|r| matches!(r.status.as_str(), "pending" | "uploading"))
                            }) {
                                let _ = ensure_worker(&config_worker.spool_dir);
                            }
                        }
                    }
                    let dropped = shared_worker.dropped.swap(0, Ordering::Relaxed);
                    if dropped > 0
                        && let Ok(Some(_guard)) =
                            queue::lock(&config_worker.spool_dir, ".queue.lock", false)
                    {
                        let mut totals = queue::stats(&config_worker.spool_dir);
                        totals.dropped_memory += dropped;
                        totals.last_error = Some("capture_capacity_or_storage".into());
                        if queue::save_stats(&config_worker.spool_dir, &totals).is_err() {
                            shared_worker.dropped.fetch_add(dropped, Ordering::Relaxed);
                        }
                    } else if dropped > 0 {
                        shared_worker.dropped.fetch_add(dropped, Ordering::Relaxed);
                    }
                }
            })?;
        Ok(Self {
            sender,
            shared,
            // 剩余四分之一由 EventLayer 的共享字段预算使用。
            max_memory: config.max_memory_bytes / 4 * 3,
            max_record: config.max_batch_bytes,
        })
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
