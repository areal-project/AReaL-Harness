use super::*;
use opentelemetry_proto::tonic::{
    collector::logs::v1::ExportLogsServiceRequest,
    common::v1::{AnyValue, KeyValue, any_value},
    logs::v1::{LogRecord, ResourceLogs, ScopeLogs},
    resource::v1::Resource,
};
use prost::Message;
use std::time::Duration;

fn config(root: &Path) -> TrajectoryConfig {
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
    c.max_disk_bytes = 100_000;
    configure(&c).unwrap();
    queue::enqueue(&c, &event("a", true, 25_000), None).unwrap();
    std::thread::sleep(Duration::from_millis(2));
    queue::enqueue(&c, &event("b", true, 25_000), None).unwrap();
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
fn lowered_budget_rejects_old_producer_and_removes_orphan_temp() {
    let d = tempfile::tempdir().unwrap();
    let c = config(d.path());
    configure(&c).unwrap();
    std::fs::write(d.path().join(".trajectory-tmp-crashed"), vec![0; 200_000]).unwrap();
    let mut lowered = c.clone();
    lowered.max_disk_bytes = 70_000;
    configure(&lowered).unwrap();
    assert!(!d.path().join(".trajectory-tmp-crashed").exists());
    queue::enqueue(&c, &event("large", true, 20_000), None).unwrap();
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
fn completion_of_evicted_inflight_record_does_not_resurrect_it() {
    let d = tempfile::tempdir().unwrap();
    let mut c = config(d.path());
    c.max_disk_bytes = 100_000;
    configure(&c).unwrap();
    queue::enqueue(&c, &event("a", true, 25_000), None).unwrap();
    let a = worker::pick(&c).unwrap().unwrap();
    std::thread::sleep(Duration::from_millis(2));
    queue::enqueue(&c, &event("b", true, 25_000), None).unwrap();
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
        b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\n".to_vec(),
    );
    assert!(matches!(
        worker::upload(&client, &c, vec![0]).await,
        worker::Outcome::Retry("response_interrupted", _)
    ));
    c.endpoint = http_fixture(
        b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\n<html".to_vec(),
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
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
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
        http_fixture(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec());
    assert!(matches!(
        worker::upload(&client, &c, vec![0]).await,
        worker::Outcome::Success
    ));
}
