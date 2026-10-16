use super::*;
use opentelemetry_proto::tonic::{
    collector::logs::v1::ExportLogsServiceRequest,
    common::v1::{AnyValue, KeyValue, any_value},
    logs::v1::{LogRecord, ResourceLogs, ScopeLogs},
    resource::v1::Resource,
};
use prost::Message;
use std::time::Duration;

pub(super) fn config(root: &Path) -> TrajectoryConfig {
    TrajectoryConfig {
        source_id: "test-configuration".into(),
        source_file: None,
        source_revision: String::new(),
        enabled: true,
        endpoint: "http://127.0.0.1:1".into(),
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
fn attr(key: &str, value: &str) -> KeyValue {
    KeyValue {
        key: key.into(),
        value: Some(AnyValue {
            value: Some(any_value::Value::StringValue(value.into())),
        }),
        ..Default::default()
    }
}
fn event(turn: &str, terminal: bool, size: usize) -> Vec<u8> {
    ExportLogsServiceRequest {
        resource_logs: vec![ResourceLogs {
            resource: Some(Resource {
                attributes: vec![
                    attr("service.name", "areal-core"),
                    attr("service.version", env!("CARGO_PKG_VERSION")),
                    attr("service.instance.id", "test-installation"),
                ],
                ..Default::default()
            }),
            scope_logs: vec![ScopeLogs {
                log_records: vec![LogRecord {
                    time_unix_nano: 1_600_000_000_000_000_000,
                    event_name: if terminal {
                        "areal.turn.completed"
                    } else {
                        "areal.user_prompt"
                    }
                    .into(),
                    attributes: vec![
                        attr("areal.turn.id", turn),
                        attr("areal.thread.id", "thread"),
                        attr("gen_ai.request.model", "test-model"),
                        attr("gen_ai.input.messages", &"x".repeat(size)),
                    ],
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        }],
    }
    .encode_to_vec()
}
fn duration_event(turn: &str, name: &str, duration: Option<any_value::Value>) -> Vec<u8> {
    let mut request = ExportLogsServiceRequest::decode(event(turn, false, 0).as_slice()).unwrap();
    let log = &mut request.resource_logs[0].scope_logs[0].log_records[0];
    log.event_name = name.into();
    if let Some(value) = duration {
        log.attributes.push(KeyValue {
            key: "areal.duration_ms".into(),
            value: Some(AnyValue { value: Some(value) }),
            ..Default::default()
        });
    }
    request.encode_to_vec()
}

#[test]
fn model_call_duration_preserves_fractional_metadata_and_ignores_invalid_or_other_events() {
    let d = tempfile::tempdir().unwrap();
    let c = config(d.path());
    configure(&c).unwrap();
    let values = [
        (
            Some(any_value::Value::DoubleValue(16.924917)),
            Some(16.924917),
        ),
        (Some(any_value::Value::IntValue(0)), Some(0.0)),
        (Some(any_value::Value::IntValue(12)), Some(12.0)),
        (Some(any_value::Value::IntValue(-1)), None),
        (Some(any_value::Value::DoubleValue(-0.5)), None),
        (Some(any_value::Value::DoubleValue(f64::NAN)), None),
        (Some(any_value::Value::DoubleValue(f64::INFINITY)), None),
        (Some(any_value::Value::DoubleValue(f64::NEG_INFINITY)), None),
        (Some(any_value::Value::StringValue("42".into())), None),
        (Some(any_value::Value::BoolValue(true)), None),
        (None, None),
    ];
    for (idx, (duration, expected)) in values.into_iter().enumerate() {
        let turn = format!("model-{idx}");
        let body = duration_event(&turn, "gen_ai.client.inference.operation.details", duration);
        queue::enqueue(&c, &body, None).unwrap();
        let record = queue::records(d.path(), c.max_disk_bytes)
            .unwrap()
            .into_iter()
            .find(|r| r.turn_id == turn)
            .unwrap();
        assert_eq!(record.model_call_duration_ms, expected);
        assert_eq!(record.execution_duration_ms, None);
        assert_eq!(
            queue::payload(d.path(), &record, c.max_batch_bytes).unwrap(),
            body
        );
    }
    for (turn, name) in [
        ("terminal", "areal.turn.completed"),
        ("tool", "areal.tool.result"),
    ] {
        queue::enqueue(
            &c,
            &duration_event(turn, name, Some(any_value::Value::IntValue(999))),
            None,
        )
        .unwrap();
    }
    let view = status(&c).unwrap();
    let records = view["records"].as_array().unwrap();
    let terminal = records.iter().find(|r| r["turn_id"] == "terminal").unwrap();
    assert_eq!(terminal["execution_duration_ms"], 999);
    assert!(terminal["model_call_duration_ms"].is_null());
    let tool = records.iter().find(|r| r["turn_id"] == "tool").unwrap();
    assert!(tool["execution_duration_ms"].is_null());
    assert!(tool["model_call_duration_ms"].is_null());
    assert_eq!(view["model_call_summary"]["model_calls"], 3);
    assert_eq!(view["model_call_summary"]["max_duration_ms"], 16.924917);
}

#[test]
fn model_call_duration_legacy_metadata_stays_unknown_without_reading_payload() {
    let d = tempfile::tempdir().unwrap();
    let c = config(d.path());
    configure(&c).unwrap();
    queue::enqueue(
        &c,
        &duration_event(
            "legacy",
            "gen_ai.client.inference.operation.details",
            Some(any_value::Value::DoubleValue(500.25)),
        ),
        None,
    )
    .unwrap();
    let record = queue::records(d.path(), c.max_disk_bytes)
        .unwrap()
        .remove(0);
    let mut legacy = serde_json::to_value(&record).unwrap();
    legacy
        .as_object_mut()
        .unwrap()
        .remove("model_call_duration_ms");
    queue::atomic(
        d.path(),
        &format!("record-{}.json", record.id),
        &serde_json::to_vec(&legacy).unwrap(),
    )
    .unwrap();
    // 状态查询不能为了补旧字段去解码大正文；损坏正文也不影响元数据展示。
    std::fs::write(
        d.path().join(format!("payload-{}.pb", record.id)),
        b"not-protobuf",
    )
    .unwrap();
    let view = status(&c).unwrap();
    assert!(view["records"][0]["model_call_duration_ms"].is_null());
    assert_eq!(view["model_call_summary"]["model_calls"], 0);
    for field in ["total_duration_ms", "mean_duration_ms", "max_duration_ms"] {
        assert!(view["model_call_summary"][field].is_null());
    }
}

#[test]
fn model_call_summary_uses_exact_recent_record_window_without_counting_upload_retries() {
    let d = tempfile::tempdir().unwrap();
    let mut c = config(d.path());
    c.max_records = 120;
    configure(&c).unwrap();
    for idx in 0..102 {
        let turn = format!("model-{idx}");
        let value = if idx < 2 { 10_000.0 } else { 1.0 };
        queue::enqueue(
            &c,
            &duration_event(
                &turn,
                "gen_ai.client.inference.operation.details",
                Some(any_value::Value::DoubleValue(value)),
            ),
            None,
        )
        .unwrap();
        let mut record = queue::records(d.path(), c.max_disk_bytes)
            .unwrap()
            .into_iter()
            .find(|r| r.turn_id == turn)
            .unwrap();
        record.created_at = idx;
        record.attempts = 7;
        record.status = if idx % 2 == 0 { "failed" } else { "pending" }.into();
        queue::save(d.path(), &record).unwrap();
    }
    let view = status(&c).unwrap();
    assert_eq!(view["records"].as_array().unwrap().len(), 100);
    assert_eq!(view["records"][0]["turn_id"], "model-101");
    assert_eq!(view["records"][99]["turn_id"], "model-2");
    assert_eq!(
        view["model_call_summary"],
        json!({
            "scope":"recent_records", "record_limit":100, "records_considered":100,
            "model_calls":100, "total_duration_ms":100.0, "mean_duration_ms":1.0, "max_duration_ms":1.0
        })
    );
}

#[test]
fn model_call_summary_overflow_remains_valid_json_with_unknown_total() {
    let d = tempfile::tempdir().unwrap();
    let c = config(d.path());
    configure(&c).unwrap();
    for turn in ["large-a", "large-b"] {
        queue::enqueue(
            &c,
            &duration_event(
                turn,
                "gen_ai.client.inference.operation.details",
                Some(any_value::Value::DoubleValue(f64::MAX)),
            ),
            None,
        )
        .unwrap();
    }
    let view = status(&c).unwrap();
    let summary = &view["model_call_summary"];
    assert_eq!(summary["model_calls"], 2);
    assert!(summary["total_duration_ms"].is_null());
    assert!(summary["mean_duration_ms"].is_null());
    assert_eq!(summary["max_duration_ms"].as_f64(), Some(f64::MAX));
    serde_json::from_str::<Value>(&view.to_string()).unwrap();
}

fn reset_delay(c: &TrajectoryConfig) {
    let _lock = queue::lock(&c.spool_dir, ".queue.lock", true).unwrap();
    let mut s = queue::stats(&c.spool_dir);
    s.not_before = 0;
    queue::save_stats(&c.spool_dir, &s).unwrap();
    for mut r in queue::records(&c.spool_dir, c.max_disk_bytes).unwrap() {
        r.next_attempt_at = None;
        queue::save(&c.spool_dir, &r).unwrap();
    }
}
#[test]
fn disabled_does_not_create_storage_and_invalid_endpoint_is_redacted() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = config(&dir.path().join("absent"));
    c.enabled = false;
    configure(&c).unwrap();
    assert!(!c.spool_dir.exists());
    assert_eq!(status(&c).unwrap()["state"], "disabled");
    c.enabled = true;
    c.endpoint = "https://secret:credential@example.com/?token=private".into();
    let view = status(&c).unwrap();
    assert_eq!(view["state"], "invalid");
    assert!(!view.to_string().contains("credential"));
}

#[test]
fn delayed_startup_cannot_undo_suspend_or_activate_an_old_configuration() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.toml");
    std::fs::write(&path, "first revision").unwrap();
    let mut old = config(&dir.path().join("spool"));
    old.source_file = Some(path.clone());
    old.source_revision = format!("{:x}", Sha256::digest(b"first revision"));
    configure_on_startup(&old).unwrap();
    let mut suspended = old.clone();
    suspended.enabled = false;
    configure(&suspended).unwrap();
    assert!(configure_on_startup(&old).is_err());
    assert!(!persisted_control(&old.spool_dir).unwrap().unwrap().enabled);

    std::fs::write(&path, "second revision").unwrap();
    let mut current = old.clone();
    current.source_revision = format!("{:x}", Sha256::digest(b"second revision"));
    current.endpoint = "http://127.0.0.1:2".into();
    configure_on_startup(&current).unwrap();
    assert!(configure_on_startup(&old).is_err());
    let control = persisted_control(&current.spool_dir).unwrap().unwrap();
    assert!(control.enabled);
    assert_eq!(control.endpoint, current.endpoint);
    // 同一快照的晚到 disabled Core 也不能关闭新配置。
    assert!(configure_on_startup(&suspended).is_err());
}

#[test]
fn unrelated_configuration_revision_does_not_report_unapplied_trajectory() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = config(dir.path());
    configure(&c).unwrap();
    c.source_revision = "model-only-edit".into();
    assert_eq!(status(&c).unwrap()["state"], "ready");
}

#[test]
fn replaced_configuration_fifo_cannot_stall_the_spool_lock() {
    use std::os::unix::ffi::OsStrExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.toml");
    let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    let mut c = config(&dir.path().join("spool"));
    c.source_file = Some(path);
    c.source_revision = "old-file".into();
    assert!(configure_on_startup(&c).is_err());
    // 检查失败已经释放控制锁，显式停用仍然可以完成。
    c.enabled = false;
    configure(&c).unwrap();
    assert!(!persisted_control(&c.spool_dir).unwrap().unwrap().enabled);
    assert!(source_revision(Path::new("/dev/zero")).is_err());
}

#[test]
fn different_configuration_cannot_override_a_shared_spool() {
    let d = tempfile::tempdir().unwrap();
    let first = config(d.path());
    configure(&first).unwrap();
    queue::enqueue(&first, &event("private-turn", true, 0), None).unwrap();
    let mut second = first.clone();
    second.source_id = "other-configuration".into();
    second.enabled = false;
    assert!(
        configure(&second).is_err(),
        "another Core must not disable this queue"
    );
    let current: TrajectoryConfig = queue::read(d.path(), "control.json", 16384).unwrap();
    assert!(current.enabled);
    assert_eq!(
        status(&second).unwrap()["last_error"],
        "spool_configuration_conflict"
    );
    let mut changed = first.clone();
    assert!(
        status(&second).unwrap()["records"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    changed.enabled = false;
    configure(&changed).unwrap();
    assert_eq!(
        status(&first).unwrap()["last_error"],
        "configuration_not_applied"
    );
    assert_eq!(status(&first).unwrap()["state"], "degraded");
}

#[test]
fn legacy_control_is_claimed_only_for_the_same_destination() {
    let d = tempfile::tempdir().unwrap();
    let mut legacy = config(d.path());
    legacy.source_id.clear();
    configure(&legacy).unwrap();
    let mut current = config(d.path());
    current.endpoint = "http://127.0.0.1:2".into();
    assert!(configure(&current).is_err());
    current.endpoint = legacy.endpoint;
    configure(&current).unwrap();
    let persisted: TrajectoryConfig = queue::read(d.path(), "control.json", 16384).unwrap();
    assert_eq!(persisted.source_id, current.source_id);
}

#[test]
fn corrupt_control_is_not_silently_overwritten_or_reported_ready() {
    let d = tempfile::tempdir().unwrap();
    let c = config(d.path());
    std::fs::write(d.path().join("control.json"), "{broken").unwrap();
    assert!(status(&c).is_err());
    assert!(configure(&c).is_err());
    assert_eq!(
        std::fs::read_to_string(d.path().join("control.json")).unwrap(),
        "{broken"
    );
}

#[test]
fn large_model_name_keeps_bounded_index_and_complete_wire_payload() {
    let d = tempfile::tempdir().unwrap();
    let c = config(d.path());
    configure(&c).unwrap();
    let mut request = ExportLogsServiceRequest::decode(event("turn", true, 0).as_slice()).unwrap();
    let name = "模型\u{0001}".repeat(1800);
    let attributes = &mut request.resource_logs[0].scope_logs[0].log_records[0].attributes;
    *attributes
        .iter_mut()
        .find(|a| a.key == "gen_ai.request.model")
        .unwrap() = attr("gen_ai.request.model", &name);
    let body = request.encode_to_vec();
    queue::enqueue(&c, &body, None).unwrap();
    let record = worker::pick(&c).unwrap().unwrap();
    assert!(record.model_name.ends_with('…'));
    assert_eq!(
        queue::payload(d.path(), &record, c.max_batch_bytes).unwrap(),
        body
    );
    assert_eq!(status(&c).unwrap()["queue"]["uploading"], 1);
}
#[test]
fn restart_recovers_pending_and_preserves_event_time_and_version() {
    let d = tempfile::tempdir().unwrap();
    let c = config(d.path());
    configure(&c).unwrap();
    let body = event("turn", true, 50);
    queue::enqueue(&c, &body, None).unwrap();
    let r = worker::pick(&c).unwrap().unwrap();
    let saved = queue::payload(d.path(), &r, c.max_batch_bytes).unwrap();
    assert_eq!(body, saved);
    let decoded = ExportLogsServiceRequest::decode(saved.as_slice()).unwrap();
    assert_eq!(
        decoded.resource_logs[0].scope_logs[0].log_records[0].time_unix_nano,
        1_600_000_000_000_000_000
    );
    worker::settle(&c, &r, worker::Outcome::Success).unwrap();
    let view = status(&c).unwrap();
    assert_eq!(view["queue"]["uploaded"], 1);
    assert!(view["records"][0]["uploaded_at"].as_u64().unwrap() > 1_600_000_000_000);
    assert!(!d.path().join(format!("payload-{}.pb", r.id)).exists());
}
#[test]
fn fifo_bounds_payload_and_reports_eviction_including_unsent_records() {
    let d = tempfile::tempdir().unwrap();
    let mut c = config(d.path());
    c.max_memory_bytes = 1024 * 1024;
    c.max_batch_bytes = 700_000;
    configure(&c).unwrap();
    queue::enqueue(&c, &event("a", true, 600_000), None).unwrap();
    std::thread::sleep(Duration::from_millis(2));
    queue::enqueue(&c, &event("b", true, 600_000), None).unwrap();
    let view = status(&c).unwrap();
    assert_eq!(view["queue"]["evicted"], 1);
    assert_eq!(view["records"][1]["status"], "evicted");
    let actual: u64 = std::fs::read_dir(d.path())
        .unwrap()
        .map(|e| e.unwrap().metadata().unwrap().len())
        .sum();
    assert!(actual <= c.max_disk_bytes);
}

#[test]
fn record_limit_prunes_oldest_history_and_failed_payload_without_reordering_newer_events() {
    let d = tempfile::tempdir().unwrap();
    let mut c = config(d.path());
    c.max_records = 2;
    configure(&c).unwrap();
    queue::enqueue(&c, &event("uploaded", true, 0), None).unwrap();
    let first = worker::pick(&c).unwrap().unwrap();
    worker::settle(&c, &first, worker::Outcome::Success).unwrap();
    std::thread::sleep(Duration::from_millis(2));
    reset_delay(&c);
    queue::enqueue(&c, &event("failed", true, 0), None).unwrap();
    let failed = worker::pick(&c).unwrap().unwrap();
    worker::settle(
        &c,
        &failed,
        worker::Outcome::Failed("authentication_rejected"),
    )
    .unwrap();
    for name in ["newer-a", "newer-b"] {
        std::thread::sleep(Duration::from_millis(2));
        queue::enqueue(&c, &event(name, true, 0), None).unwrap();
    }
    let records = queue::records(d.path(), c.max_disk_bytes).unwrap();
    assert_eq!(
        records
            .iter()
            .map(|r| r.turn_id.as_str())
            .collect::<Vec<_>>(),
        ["newer-a", "newer-b"]
    );
    assert!(
        records
            .iter()
            .all(|r| r.payload_present && r.status == "pending")
    );
    assert_eq!(status(&c).unwrap()["queue"]["evicted"], 1);
    assert_eq!(status(&c).unwrap()["queue"]["uploaded"], 1);
    assert!(!d.path().join(format!("payload-{}.pb", failed.id)).exists());
}

#[test]
fn lowering_disk_quota_prunes_existing_oldest_payload_even_while_disabled() {
    let d = tempfile::tempdir().unwrap();
    let mut c = config(d.path());
    c.max_disk_bytes = 2 * 1024 * 1024;
    c.max_memory_bytes = 1024 * 1024;
    c.max_batch_bytes = 700_000;
    configure(&c).unwrap();
    queue::enqueue(&c, &event("oldest", true, 600_000), None).unwrap();
    std::thread::sleep(Duration::from_millis(2));
    queue::enqueue(&c, &event("newest", true, 600_000), None).unwrap();
    assert_eq!(status(&c).unwrap()["queue"]["pending"], 2);
    c.enabled = false;
    c.max_disk_bytes = 1024 * 1024;
    configure(&c).unwrap();
    let records = queue::records(d.path(), c.max_disk_bytes).unwrap();
    assert_eq!(records[0].turn_id, "oldest");
    assert_eq!(records[0].status, "evicted");
    assert!(!records[0].payload_present);
    assert_eq!(records[1].turn_id, "newest");
    assert!(records[1].payload_present);
    let actual: u64 = std::fs::read_dir(d.path())
        .unwrap()
        .map(|e| e.unwrap().metadata().unwrap().len())
        .sum();
    assert!(actual <= c.max_disk_bytes);
    assert!(!status(&c).unwrap()["worker_running"].as_bool().unwrap());
}
#[test]
fn lowered_budget_rejects_old_producer_and_removes_orphan_temp() {
    let d = tempfile::tempdir().unwrap();
    let mut c = config(d.path());
    c.max_disk_bytes = 2 * 1024 * 1024;
    c.max_memory_bytes = 2 * 1024 * 1024;
    c.max_batch_bytes = 2 * 1024 * 1024;
    configure(&c).unwrap();
    std::fs::write(d.path().join(".trajectory-tmp-crashed"), vec![0; 200_000]).unwrap();
    let mut lowered = c.clone();
    lowered.max_disk_bytes = 1024 * 1024;
    lowered.max_batch_bytes = 1024 * 1024;
    configure(&lowered).unwrap();
    assert!(!d.path().join(".trajectory-tmp-crashed").exists());
    queue::enqueue(&c, &event("large", true, 1024 * 1024 - 32768), None).unwrap();
    assert_eq!(status(&lowered).unwrap()["queue"]["pending"], 0);
    assert_eq!(status(&lowered).unwrap()["queue"]["dropped_oversize"], 1);
}
#[test]
fn retry_budget_survives_restart_and_manual_retry_resets_only_failed() {
    let d = tempfile::tempdir().unwrap();
    let c = config(d.path());
    configure(&c).unwrap();
    queue::enqueue(&c, &event("turn", true, 0), None).unwrap();
    for attempt in 1..=7 {
        reset_delay(&c);
        let r = worker::pick(&c).unwrap().unwrap();
        assert_eq!(r.attempts, attempt);
        worker::settle(&c, &r, worker::Outcome::Retry("connection_failed", None)).unwrap();
    }
    assert_eq!(status(&c).unwrap()["queue"]["failed"], 1);
    reset_delay(&c);
    assert!(worker::pick(&c).unwrap().is_none());
    assert_eq!(retry_failed(&c).unwrap()["queue"]["pending"], 1);
    assert_eq!(worker::pick(&c).unwrap().unwrap().attempts, 1);
}

#[test]
fn resume_retained_requeues_failed_without_shortening_receiver_backoff_or_resetting_pending_attempts()
 {
    let d = tempfile::tempdir().unwrap();
    let c = config(d.path());
    configure(&c).unwrap();
    queue::enqueue(&c, &event("failed", true, 0), None).unwrap();
    let failed = worker::pick(&c).unwrap().unwrap();
    worker::settle(
        &c,
        &failed,
        worker::Outcome::Failed("authentication_rejected"),
    )
    .unwrap();
    reset_delay(&c);
    queue::enqueue(&c, &event("throttled", true, 0), None).unwrap();
    let pending = worker::pick(&c).unwrap().unwrap();
    worker::settle(
        &c,
        &pending,
        worker::Outcome::Retry("rate_limited", Some(300)),
    )
    .unwrap();
    let before = queue::stats(d.path());
    assert!(before.not_before > now());
    assert_eq!(resume_retained(&c).unwrap()["queue"]["pending"], 2);
    let after = queue::stats(d.path());
    assert_eq!(after.not_before, before.not_before);
    assert_eq!(after.consecutive_failures, before.consecutive_failures);
    let records = queue::records(d.path(), c.max_disk_bytes).unwrap();
    let failed = records.iter().find(|r| r.turn_id == "failed").unwrap();
    let pending = records.iter().find(|r| r.turn_id == "throttled").unwrap();
    assert_eq!(failed.attempts, 0);
    assert_eq!(failed.next_attempt_at, Some(before.not_before));
    assert_eq!(pending.attempts, 1);
    assert!(worker::pick(&c).unwrap().is_none());
    resume_retained(&c).unwrap();
    assert_eq!(
        queue::records(d.path(), c.max_disk_bytes)
            .unwrap()
            .iter()
            .find(|r| r.turn_id == "throttled")
            .unwrap()
            .attempts,
        1
    );
    let mut other = c.clone();
    other.endpoint = "http://127.0.0.1:2".into();
    configure(&other).unwrap();
    assert!(worker::pick(&other).unwrap().is_none());
    assert_eq!(resume_retained(&other).unwrap()["queue"]["pending"], 0);
    assert_eq!(status(&other).unwrap()["queue"]["failed"], 2);
}

#[test]
fn worker_shutdown_rechecks_enable_before_releasing_its_lease() {
    let d = tempfile::tempdir().unwrap();
    let mut c = config(d.path());
    c.enabled = false;
    configure(&c).unwrap();
    let queue_lock = queue::lock(d.path(), ".queue.lock", true).unwrap();
    let spawn_lock = queue::lock(d.path(), ".spawn.lock", true).unwrap();
    let root = d.path().to_path_buf();
    let (done, exited) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let _ = done.send(runtime.block_on(run_worker(root)));
    });
    let started = std::time::Instant::now();
    while !worker_running(d.path()) && started.elapsed() < Duration::from_secs(2) {
        std::thread::sleep(Duration::from_millis(5));
    }
    let acquired = worker_running(d.path());
    drop(queue_lock);
    // 让 worker 读到 disabled 并等待退出交接；enable 在其交还租约前发布。
    std::thread::sleep(Duration::from_millis(50));
    let waited_for_handoff = worker_running(d.path());
    c.enabled = true;
    configure(&c).unwrap();
    drop(spawn_lock);
    std::thread::sleep(Duration::from_millis(150));
    let retained = worker_running(d.path());
    c.enabled = false;
    configure(&c).unwrap();
    exited
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .unwrap();
    worker.join().unwrap();
    assert!(acquired, "worker 必须先取得唯一上传租约");
    assert!(waited_for_handoff, "正常退出必须等待启动锁完成交接");
    assert!(retained, "新 enable 不能丢给已经决定退出的旧 worker");
    assert!(!worker_running(d.path()));
}

#[test]
fn waits_for_turn_terminal_but_does_not_strand_dead_producer() {
    let d = tempfile::tempdir().unwrap();
    let c = config(d.path());
    configure(&c).unwrap();
    let producer = format!(".producer-{}.lock", uuid::Uuid::new_v4());
    let lease = queue::lock(d.path(), &producer, false).unwrap();
    queue::enqueue(&c, &event("turn", false, 0), Some(producer.clone())).unwrap();
    assert!(worker::pick(&c).unwrap().is_none());
    queue::enqueue(&c, &event("turn", true, 0), Some(producer.clone())).unwrap();
    assert!(worker::pick(&c).unwrap().is_some());
    queue::enqueue(&c, &event("crashed", false, 0), Some(producer)).unwrap();
    drop(lease);
    assert!(
        queue::records(d.path(), c.max_disk_bytes)
            .unwrap()
            .iter()
            .any(|r| r.turn_id == "crashed")
    );
}
#[test]
fn authentication_rotation_keeps_destination_but_endpoint_change_never_redirects_backlog() {
    let d = tempfile::tempdir().unwrap();
    let mut c = config(d.path());
    configure(&c).unwrap();
    queue::enqueue(&c, &event("turn", true, 0), None).unwrap();
    let mut rotated = c.clone();
    rotated.headers_file = Some(d.path().join("new-secret"));
    assert_eq!(destination(&c), destination(&rotated));
    c.endpoint = "http://127.0.0.1:2".into();
    configure(&c).unwrap();
    assert!(worker::pick(&c).unwrap().is_none());
    let view = status(&c).unwrap();
    assert_eq!(view["queue"]["failed"], 1);
    assert_eq!(view["records"][0]["error"], "destination_changed");
}

#[test]
fn destination_switch_releases_old_throttle_without_redirecting_payloads() {
    let d = tempfile::tempdir().unwrap();
    let old = config(d.path());
    configure(&old).unwrap();
    let body = event("old", true, 0);
    queue::enqueue(&old, &body, None).unwrap();
    let record = worker::pick(&old).unwrap().unwrap();
    worker::settle(
        &old,
        &record,
        worker::Outcome::Retry("rate_limited", Some(86_400)),
    )
    .unwrap();
    let throttled = queue::stats(d.path());
    assert!(throttled.not_before >= now() + 86_399_000);
    configure(&old).unwrap();
    assert_eq!(queue::stats(d.path()).not_before, throttled.not_before);
    assert!(worker::pick(&old).unwrap().is_none());

    let mut new = old.clone();
    new.endpoint = "http://127.0.0.1:2".into();
    configure(&new).unwrap();
    let stats = queue::stats(d.path());
    assert_eq!(stats.destination, destination(&new));
    assert_eq!(stats.not_before, 0);
    assert_eq!(stats.consecutive_failures, 0);
    assert_eq!(stats.last_error, None);
    assert!(worker::pick(&new).unwrap().is_none());
    queue::enqueue(&new, &event("new", true, 0), None).unwrap();
    let selected = worker::pick(&new).unwrap().unwrap();
    assert_eq!(selected.turn_id, "new");
    let retained = queue::records(d.path(), new.max_disk_bytes)
        .unwrap()
        .into_iter()
        .find(|r| r.id == record.id)
        .unwrap();
    assert_eq!(retained.error.as_deref(), Some("destination_changed"));
    assert_eq!(retained.destination, destination(&old));
    assert_eq!(
        queue::payload(d.path(), &retained, old.max_batch_bytes).unwrap(),
        body
    );
}

#[test]
fn old_inflight_outcomes_and_ack_recovery_do_not_override_new_destination_state() {
    for outcome in [
        worker::Outcome::Retry("rate_limited", Some(86_400)),
        worker::Outcome::Failed("authentication_rejected"),
        worker::Outcome::Success,
    ] {
        let d = tempfile::tempdir().unwrap();
        let old = config(d.path());
        configure(&old).unwrap();
        queue::enqueue(&old, &event("old", true, 0), None).unwrap();
        let record = worker::pick(&old).unwrap().unwrap();
        let mut new = old.clone();
        new.endpoint = "http://127.0.0.1:2".into();
        configure(&new).unwrap();
        let mut expected = queue::stats(d.path());
        expected.not_before = now() + 123_000;
        expected.consecutive_failures = 3;
        expected.last_error = Some("remote_unavailable".into());
        queue::save_stats(d.path(), &expected).unwrap();
        let success = matches!(outcome, worker::Outcome::Success);
        if success {
            // 模拟旧请求 ACK 已持久确认，但统计未落盘；重启也不能清新接收端退避。
            queue::fail_next_write("statistics.json".into());
            assert!(worker::settle(&old, &record, outcome).is_err());
        } else {
            worker::settle(&old, &record, outcome).unwrap();
        }
        let records = queue::records(d.path(), new.max_disk_bytes).unwrap();
        let mut actual = queue::stats(d.path());
        queue::recover_statistics(&records, &mut actual);
        assert_eq!(actual.destination, expected.destination);
        assert_eq!(actual.not_before, expected.not_before);
        assert_eq!(actual.consecutive_failures, expected.consecutive_failures);
        assert_eq!(actual.last_error, expected.last_error);
        assert_eq!(actual.uploaded, u64::from(success));
        assert_eq!(records[0].payload_present, !success);
        assert_eq!(records[0].destination, destination(&old));
    }
}

#[test]
fn legacy_statistics_keep_same_destination_delay_and_survive_interrupted_switch() {
    let d = tempfile::tempdir().unwrap();
    let old = config(d.path());
    configure(&old).unwrap();
    let mut original = queue::stats(d.path());
    original.not_before = now() + 86_400_000;
    original.consecutive_failures = 4;
    original.last_error = Some("rate_limited".into());
    let mut legacy = serde_json::to_value(&original).unwrap();
    legacy.as_object_mut().unwrap().remove("destination");
    queue::atomic(
        d.path(),
        "statistics.json",
        &serde_json::to_vec(&legacy).unwrap(),
    )
    .unwrap();
    configure(&old).unwrap();
    assert_eq!(queue::stats(d.path()), original);

    // 旧文件升级时切换：若新 control 写失败，旧接收端的 deadline 仍然完整。
    queue::atomic(
        d.path(),
        "statistics.json",
        &serde_json::to_vec(&legacy).unwrap(),
    )
    .unwrap();
    let mut new = old.clone();
    new.endpoint = "http://127.0.0.1:2".into();
    queue::fail_next_write("control.json".into());
    assert!(configure(&new).is_err());
    let saved: queue::Statistics = queue::read(d.path(), "statistics.json", 8192).unwrap();
    assert_eq!(saved, original);

    // 模拟 control 已发布、更新统计前崩溃，读取/重启仍按新地址解除旧退避。
    queue::atomic(d.path(), "control.json", &serde_json::to_vec(&new).unwrap()).unwrap();
    let resumed = queue::stats(d.path());
    assert_eq!(resumed.destination, destination(&new));
    assert_eq!(resumed.not_before, 0);
    assert_eq!(resumed.consecutive_failures, 0);
    assert_eq!(resumed.last_error, None);
    configure(&new).unwrap();
    assert_eq!(queue::stats(d.path()), resumed);
}
#[test]
fn completion_of_evicted_inflight_record_does_not_resurrect_it() {
    let d = tempfile::tempdir().unwrap();
    let mut c = config(d.path());
    c.max_memory_bytes = 1024 * 1024;
    c.max_batch_bytes = 700_000;
    configure(&c).unwrap();
    queue::enqueue(&c, &event("a", true, 600_000), None).unwrap();
    let a = worker::pick(&c).unwrap().unwrap();
    std::thread::sleep(Duration::from_millis(2));
    queue::enqueue(&c, &event("b", true, 600_000), None).unwrap();
    worker::settle(&c, &a, worker::Outcome::Success).unwrap();
    assert_eq!(status(&c).unwrap()["queue"]["uploaded"], 0);
    assert_eq!(status(&c).unwrap()["queue"]["evicted"], 1);
}

#[test]
fn acknowledged_payload_survives_failed_completion_commit() {
    let d = tempfile::tempdir().unwrap();
    let c = config(d.path());
    configure(&c).unwrap();
    let body = event("turn", true, 50);
    queue::enqueue(&c, &body, None).unwrap();
    let record = worker::pick(&c).unwrap().unwrap();
    queue::fail_next_write(format!("record-{}.json", record.id));
    assert!(worker::settle(&c, &record, worker::Outcome::Success).is_err());
    assert_eq!(
        queue::payload(d.path(), &record, c.max_batch_bytes).unwrap(),
        body,
        "a failed local ACK commit must retain the replayable payload"
    );
    let resumed = worker::pick(&c).unwrap().unwrap();
    worker::settle(&c, &resumed, worker::Outcome::Success).unwrap();
    assert_eq!(status(&c).unwrap()["queue"]["uploaded"], 1);
}

#[test]
fn completion_is_recoverable_when_statistics_write_fails() {
    let d = tempfile::tempdir().unwrap();
    let c = config(d.path());
    configure(&c).unwrap();
    queue::enqueue(&c, &event("a", true, 0), None).unwrap();
    let record = worker::pick(&c).unwrap().unwrap();
    let mut totals = queue::stats(d.path());
    totals.last_error = Some("connection_failed".into());
    totals.consecutive_failures = 5;
    totals.not_before = now() + 300_000;
    queue::save_stats(d.path(), &totals).unwrap();
    queue::fail_next_write("statistics.json".into());
    assert!(worker::settle(&c, &record, worker::Outcome::Success).is_err());
    assert_eq!(status(&c).unwrap()["queue"]["uploaded"], 1);
    assert_eq!(status(&c).unwrap()["state"], "ready");
    assert_eq!(status(&c).unwrap()["last_error"], Value::Null);
    let mut recovered = queue::stats(d.path());
    recovered.last_error = Some("capture_capacity_or_storage".into());
    queue::recover_statistics(
        &queue::records(d.path(), c.max_disk_bytes).unwrap(),
        &mut recovered,
    );
    assert_eq!(
        recovered.last_error.as_deref(),
        Some("capture_capacity_or_storage")
    );
    assert_eq!(recovered.consecutive_failures, 0);
    assert!(recovered.not_before < totals.not_before);
    queue::enqueue(&c, &event("b", true, 0), None).unwrap();
    reset_delay(&c);
    let second = worker::pick(&c).unwrap().unwrap();
    worker::settle(&c, &second, worker::Outcome::Success).unwrap();
    assert_eq!(status(&c).unwrap()["queue"]["uploaded"], 2);
}
#[test]
fn headers_follow_otlp_percent_decoding_and_private_file_rules() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    let mut c = config(d.path());
    let p = d.path().join("headers");
    std::fs::write(&p, "authorization=Bearer%20abc+def&ghi").unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).unwrap();
    c.headers_file = Some(p.clone());
    assert_eq!(
        worker::headers(&c).unwrap()["authorization"],
        "Bearer abc+def&ghi"
    );
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(worker::headers(&c).is_err());
}
#[test]
fn backoff_is_bounded_and_honors_retry_after() {
    let c = config(Path::new("/unused"));
    assert_eq!(worker::backoff(&c, 1, None, 0), 1000);
    assert_eq!(worker::backoff(&c, 2, None, 0), 2000);
    assert_eq!(worker::backoff(&c, 1, Some(8), 0), 8000);
    assert_eq!(worker::backoff(&c, 100, None, 0), 10_000);
    assert_eq!(worker::backoff(&c, 1, Some(60), 0), 60_000);
    assert_eq!(worker::backoff(&c, 100, Some(u64::MAX), 0), u64::MAX);
}

#[test]
fn retry_after_accepts_http_dates_and_never_rounds_before_server_deadline() {
    use std::time::UNIX_EPOCH;
    let at = UNIX_EPOCH + Duration::from_millis(1_700_000_000_500);
    let date = httpdate::fmt_http_date(at + Duration::from_secs(61));
    assert_eq!(worker::retry_after(&date, at), Some(61));
    assert_eq!(worker::retry_after(" 120 ", at), Some(120));
    assert_eq!(
        worker::retry_after("Thu, 01 Jan 1970 00:00:00 GMT", at),
        Some(0)
    );
    for invalid in ["", "-1", "+1", "1.5", "tomorrow", "18446744073709551616"] {
        assert_eq!(worker::retry_after(invalid, at), None, "{invalid}");
    }
}
#[test]
fn capture_is_nonblocking_when_spool_lock_is_held() {
    use opentelemetry::{
        KeyValue,
        logs::{LogRecord as _, Logger, LoggerProvider},
    };
    let d = tempfile::tempdir().unwrap();
    let mut c = config(d.path());
    c.max_memory_bytes = 65536;
    let lock = queue::lock(d.path(), ".queue.lock", true).unwrap();
    let initialization = std::time::Instant::now();
    let processor = Processor::new(&c).unwrap();
    assert!(
        initialization.elapsed() < Duration::from_secs(1),
        "Core startup must not wait on spool initialization"
    );
    let provider = opentelemetry_sdk::logs::SdkLoggerProvider::builder()
        .with_log_processor(processor)
        .build();
    let logger = provider.logger("fixture");
    let start = std::time::Instant::now();
    for _ in 0..500 {
        let mut r = logger.create_log_record();
        r.set_event_name("areal.user_prompt");
        r.add_attribute("body", "x".repeat(2048));
        logger.emit(r);
    }
    assert!(
        start.elapsed() < Duration::from_secs(1),
        "capture must not wait on disk lock"
    );
    drop(lock);
    let _ = provider.shutdown();
    let _ = KeyValue::new("unused", true);
}

fn http_fixture(response: Vec<u8>) -> String {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        let (mut s, _) = listener.accept().unwrap();
        s.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut b = [0; 16384];
        let _ = s.read(&mut b);
        let _ = s.write_all(&response);
    });
    format!("http://{addr}")
}
#[tokio::test]
async fn otlp_response_validation_handles_throttle_partial_failure_and_broken_body() {
    let client = reqwest::Client::new();
    let mut c = config(Path::new("/unused"));
    c.endpoint=http_fixture(b"HTTP/1.1 429 Too Many Requests\r\nRetry-After: 7\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec());
    assert!(matches!(
        worker::upload(&client, &c, vec![0]).await,
        worker::Outcome::Retry("rate_limited", Some(7))
    ));
    c.endpoint = http_fixture(
        b"HTTP/1.1 200 OK\r\nContent-Type: application/x-protobuf\r\nContent-Length: 10\r\nConnection: close\r\n\r\n".to_vec(),
    );
    assert!(matches!(
        worker::upload(&client, &c, vec![0]).await,
        worker::Outcome::Retry("response_interrupted", _)
    ));
    c.endpoint = http_fixture(
        b"HTTP/1.1 200 OK\r\nContent-Type: application/x-protobuf\r\nContent-Length: 5\r\nConnection: close\r\n\r\n<html".to_vec(),
    );
    assert!(matches!(
        worker::upload(&client, &c, vec![0]).await,
        worker::Outcome::Failed("invalid_otlp_response")
    ));
    use opentelemetry_proto::tonic::collector::logs::v1::{
        ExportLogsPartialSuccess, ExportLogsServiceResponse,
    };
    let body = ExportLogsServiceResponse {
        partial_success: Some(ExportLogsPartialSuccess {
            rejected_log_records: 1,
            error_message: "fixture rejection".into(),
        }),
    }
    .encode_to_vec();
    let mut response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/x-protobuf\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    response.extend(body);
    c.endpoint = http_fixture(response);
    assert!(matches!(
        worker::upload(&client, &c, vec![0]).await,
        worker::Outcome::Failed("otlp_partial_rejection")
    ));
    c.endpoint =
        http_fixture(b"HTTP/1.1 200 OK\r\nContent-Type: application/x-protobuf\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec());
    assert!(matches!(
        worker::upload(&client, &c, vec![0]).await,
        worker::Outcome::Success
    ));
}

#[tokio::test]
async fn otlp_http_retries_only_standard_codes_and_validates_ack_media_type() {
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let mut c = config(Path::new("/unused"));
    for status in [400, 401, 403, 408, 413, 500, 501, 505, 599] {
        c.endpoint = http_fixture(
            format!("HTTP/1.1 {status} Fixture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .into_bytes(),
        );
        assert!(
            matches!(
                worker::upload(&client, &c, vec![0]).await,
                worker::Outcome::Failed(_)
            ),
            "{status}"
        );
    }
    for status in [429, 502, 503, 504] {
        c.endpoint = http_fixture(format!("HTTP/1.1 {status} Fixture\r\nRetry-After: 60\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes());
        assert!(
            matches!(
                worker::upload(&client, &c, vec![0]).await,
                worker::Outcome::Retry(_, Some(60))
            ),
            "{status}"
        );
    }
    let date = httpdate::fmt_http_date(std::time::SystemTime::now() + Duration::from_secs(120));
    c.endpoint = http_fixture(format!("HTTP/1.1 503 Fixture\r\nRetry-After: {date}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes());
    assert!(matches!(
        worker::upload(&client, &c, vec![0]).await,
        worker::Outcome::Retry(_, Some(110..=120))
    ));
    for content_type in [
        "",
        "Content-Type: text/plain\r\n",
        "Content-Type: application/json\r\n",
    ] {
        c.endpoint = http_fixture(
            format!(
                "HTTP/1.1 200 OK\r\n{content_type}Content-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .into_bytes(),
        );
        assert!(matches!(
            worker::upload(&client, &c, vec![0]).await,
            worker::Outcome::Failed("invalid_otlp_response")
        ));
    }
    c.endpoint = http_fixture(b"HTTP/1.1 200 OK\r\nContent-Type: Application/X-Protobuf; charset=binary\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec());
    assert!(matches!(
        worker::upload(&client, &c, vec![0]).await,
        worker::Outcome::Success
    ));
}

#[tokio::test]
async fn remote_retry_deadline_and_invalid_ack_preserve_durable_payload() {
    let d = tempfile::tempdir().unwrap();
    let mut c = config(d.path());
    let payload = event("delayed", true, 0);
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    c.endpoint = http_fixture(
        b"HTTP/1.1 503 Busy\r\nRetry-After: 120\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            .to_vec(),
    );
    configure(&c).unwrap();
    queue::enqueue(&c, &payload, None).unwrap();
    let record = worker::pick(&c).unwrap().unwrap();
    let before = now();
    let outcome = worker::upload(&client, &c, payload.clone()).await;
    worker::settle(&c, &record, outcome).unwrap();
    let saved = queue::records(d.path(), c.max_disk_bytes)
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(saved.status, "pending");
    assert!(saved.next_attempt_at.unwrap() >= before + 120_000);
    assert_eq!(
        queue::payload(d.path(), &saved, c.max_batch_bytes).unwrap(),
        payload
    );
    // 重开配置不能清掉接收端退避；进程恢复仍不允许立即发送。
    configure(&c.clone()).unwrap();
    assert!(worker::pick(&c).unwrap().is_none());

    let d = tempfile::tempdir().unwrap();
    c.spool_dir = d.path().into();
    c.endpoint = http_fixture(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec());
    configure(&c).unwrap();
    queue::enqueue(&c, &payload, None).unwrap();
    let record = worker::pick(&c).unwrap().unwrap();
    let outcome = worker::upload(&client, &c, payload.clone()).await;
    worker::settle(&c, &record, outcome).unwrap();
    let saved = queue::records(d.path(), c.max_disk_bytes)
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(saved.status, "failed");
    assert_eq!(saved.error.as_deref(), Some("invalid_otlp_response"));
    assert_eq!(
        queue::payload(d.path(), &saved, c.max_batch_bytes).unwrap(),
        payload
    );
}
