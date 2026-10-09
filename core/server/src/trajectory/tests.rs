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
