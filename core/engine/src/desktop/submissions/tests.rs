use super::*;
use crate::model::{Message, Model, ModelStream};
use async_trait::async_trait;

struct Idle;
#[async_trait]
impl Model for Idle {
    fn name(&self) -> &str {
        "creation-recovery"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        Ok(Box::pin(futures_util::stream::empty()))
    }
}
struct Host;
#[async_trait]
impl crate::tools::DynamicToolHost for Host {
    fn id(&self) -> &str {
        "creation-recovery-host"
    }
    fn is_closed(&self) -> bool {
        false
    }
    async fn call(
        &self,
        _: Value,
        _: CancellationToken,
    ) -> anyhow::Result<areal_protocol::DynamicToolResponse> {
        unreachable!("creation recovery must not execute a model or tool")
    }
}
fn open(root: &Path) -> Arc<Engine> {
    Engine::open(root, Arc::new(Idle), Limits::default()).unwrap()
}
fn request(binding: &CreationAdmission) -> ThreadStart {
    serde_json::from_value(json!({"requestId":"original-create","creationAdmission":binding}))
        .unwrap()
}

#[tokio::test]
async fn an_error_after_durable_admission_never_becomes_a_rejection() {
    let root = tempfile::tempdir().unwrap();
    let engine = open(root.path());
    let binding = engine.creation_admission("owner").await;
    let mut invalid = request(&binding);
    invalid.cwd = Some("relative-path".into());
    let error = engine
        .create_configured("owner".into(), invalid, Arc::new(Host))
        .await
        .unwrap_err();
    let Error::OperationOutcome(error) = error else {
        panic!("admitted errors must retain original admission")
    };
    assert_eq!(json!(error)["outcome"]["kind"], "admitted");
    engine.shutdown().await;
    drop(engine);
    let engine = open(root.path());
    let result = engine
        .resolve_creation_admission("owner", "original-create", binding)
        .await
        .unwrap();
    assert_eq!(result["creationAdmission"]["status"], "admitted");
    assert_eq!(result["data"][0]["state"], "unknown");
    assert!(engine.list(None, 100, None).await.unwrap().0.is_empty());
    engine.shutdown().await;
}

#[tokio::test]
async fn a_failed_directory_sync_after_replacement_recovers_as_unknown() {
    let root = tempfile::tempdir().unwrap();
    let engine = open(root.path());
    let binding = engine.creation_admission("owner").await;
    // 用真实原子替换后的故障构造“不知道是否已发布”的磁盘图像。
    let mut journal = engine.desktop.submissions.entries.lock().await;
    journal.entries.insert(
        digest(&("owner", "areal/thread/start", "original-create")).unwrap(),
        Submission {
            identity: "owner".into(),
            request_id: "original-create".into(),
            method: "areal/thread/start".into(),
            digest: digest(&request(&binding)).unwrap(),
            state: "accepted".into(),
            response: None,
            target: Some(OperationTarget::Project),
        },
    );
    let bytes = serde_json::to_vec(&*journal).unwrap();
    drop(journal);
    assert!(
        crate::store::write_metadata_after_replace(
            &root.path().join("desktop"),
            "submissions",
            &bytes,
            || anyhow::bail!("injected directory fsync failure")
        )
        .is_err()
    );
    engine.shutdown().await;
    drop(engine);
    let engine = open(root.path());
    let result = engine
        .resolve_creation_admission("owner", "original-create", binding)
        .await
        .unwrap();
    assert_eq!(result["creationAdmission"]["status"], "admitted");
    assert_eq!(result["data"][0]["state"], "unknown");
    assert!(engine.list(None, 100, None).await.unwrap().0.is_empty());
    engine.shutdown().await;
}

#[tokio::test]
async fn live_absence_and_changed_coverage_remain_unknown() {
    let root = tempfile::tempdir().unwrap();
    let engine = open(root.path());
    let binding = engine.creation_admission("owner").await;
    let live = engine
        .resolve_creation_admission("owner", "original-create", binding.clone())
        .await
        .unwrap();
    assert_eq!(live["creationAdmission"]["status"], "unconfirmed");
    assert!(live["data"].as_array().unwrap().is_empty());
    engine.shutdown().await;
    drop(engine);
    let engine = open(root.path());
    let known = engine
        .resolve_creation_admission("owner", "original-create", binding.clone())
        .await
        .unwrap();
    assert_eq!(known["creationAdmission"]["status"], "notAdmitted");
    assert_eq!(
        engine
            .resolve_creation_admission("other-owner", "original-create", binding.clone())
            .await
            .unwrap()["creationAdmission"]["status"],
        "unconfirmed"
    );
    let mut foreign = binding.clone();
    foreign.journal_epoch = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        engine
            .resolve_creation_admission("owner", "original-create", foreign)
            .await
            .unwrap()["creationAdmission"]["status"],
        "unconfirmed"
    );
    assert!(matches!(
        engine
            .create_configured("owner".into(), request(&binding), Arc::new(Host))
            .await,
        Err(Error::Rejected(_))
    ));
    assert!(engine.list(None, 100, None).await.unwrap().0.is_empty());
    let legacy = engine
        .find_request("owner", "legacy-without-binding")
        .await
        .unwrap();
    assert!(legacy["data"].as_array().unwrap().is_empty());
    assert!(legacy.get("creationAdmission").is_none());
    engine.shutdown().await;
}

#[tokio::test]
async fn failed_admission_persistence_runs_no_creation_and_keeps_unknown() {
    let root = tempfile::tempdir().unwrap();
    let engine = open(root.path());
    let binding = engine.creation_admission("owner").await;
    let path = root.path().join("desktop/submissions.json");
    let saved = root.path().join("desktop/saved-journal");
    std::fs::rename(&path, &saved).unwrap();
    std::fs::create_dir(&path).unwrap();
    let error = engine
        .create_configured("owner".into(), request(&binding), Arc::new(Host))
        .await
        .unwrap_err();
    let Error::OperationOutcome(error) = error else {
        panic!("expected uncertain publication")
    };
    assert_eq!(json!(error)["outcome"]["kind"], "unconfirmed");
    assert_eq!(
        engine
            .resolve_creation_admission("owner", "original-create", binding.clone())
            .await
            .unwrap()["creationAdmission"]["status"],
        "unconfirmed"
    );
    assert!(
        engine
            .create_configured("owner".into(), request(&binding), Arc::new(Host))
            .await
            .is_err()
    );
    assert!(engine.list(None, 100, None).await.unwrap().0.is_empty());
    engine.shutdown().await;
    drop(engine);
    std::fs::remove_dir(&path).unwrap();
    std::fs::rename(&saved, &path).unwrap();
    let engine = open(root.path());
    assert_eq!(
        engine
            .resolve_creation_admission("owner", "original-create", binding)
            .await
            .unwrap()["creationAdmission"]["status"],
        "notAdmitted"
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn capacity_preserves_legacy_keys_and_rejects_before_creation() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("desktop")).unwrap();
    let entries: BTreeMap<_, _> = (0..4096).map(|i| (format!("old-{i}"), json!({
        "identity":"owner","requestId":format!("old-{i}"),"method":"areal/provider/upsert",
        "digest":"legacy","state":"completed","response":{"result":{"saved":true}}
    }))).collect();
    let path = root.path().join("desktop/submissions.json");
    std::fs::write(&path, serde_json::to_vec(&entries).unwrap()).unwrap();
    let engine = open(root.path());
    let binding = engine.creation_admission("owner").await;
    assert!(matches!(
        engine
            .create_configured("owner".into(), request(&binding), Arc::new(Host))
            .await,
        Err(Error::Rejected(_))
    ));
    assert_eq!(
        engine.management_receipts("owner", "old-0").await["data"][0]["status"],
        "completed"
    );
    assert!(engine.list(None, 100, None).await.unwrap().0.is_empty());
    engine.shutdown().await;
    drop(engine);
    let mut journal: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(journal["entries"].as_object().unwrap().len(), 4096);
    let engine = open(root.path());
    assert_eq!(
        engine.creation_admission("owner").await.journal_epoch,
        binding.journal_epoch
    );
    assert_ne!(
        engine.creation_admission("owner").await.core_instance_id,
        binding.core_instance_id
    );
    engine.shutdown().await;
    drop(engine);
    journal["version"] = json!(99);
    std::fs::write(&path, serde_json::to_vec(&journal).unwrap()).unwrap();
    assert!(Engine::open(root.path(), Arc::new(Idle), Limits::default()).is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn sigkill_windows_preserve_original_admission_without_replay() {
    #[cfg(not(target_os = "macos"))]
    use std::os::unix::process::ExitStatusExt;
    for point in [
        "beforeAdmission",
        "afterAdmission",
        "afterSnapshot",
        "afterCompletion",
    ] {
        let root = tempfile::tempdir().unwrap();
        let executable = std::env::current_exe().unwrap();
        #[cfg(target_os = "macos")]
        let mut command = {
            // 与本机服务启动契约相同，由受信 Python 保持实际父进程身份。
            // 只接受工作进程真实的 SIGKILL；下面的 binding 检查仍证明已进入夹具。
            let mut command = std::process::Command::new("/usr/bin/python3");
            command.args([
                "-I",
                "-c",
                "import signal, subprocess, sys; code = subprocess.call(sys.argv[1:]); sys.exit(0 if code == -signal.SIGKILL else 1)",
            ]);
            command.arg(&executable);
            command
        };
        #[cfg(not(target_os = "macos"))]
        let mut command = std::process::Command::new(executable);
        let status = command
            .args([
                "--exact",
                "desktop::submissions::tests::creation_crash_worker",
                "--ignored",
            ])
            .env("AREAL_CREATION_CRASH_ROOT", root.path())
            .env("AREAL_CREATION_CRASH_POINT", point)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        #[cfg(target_os = "macos")]
        assert!(status.success(), "{point}");
        #[cfg(not(target_os = "macos"))]
        assert_eq!(status.signal(), Some(libc::SIGKILL), "{point}");
        let binding: CreationAdmission = serde_json::from_slice(
            &std::fs::read(root.path().join("desktop/test-binding.json")).unwrap(),
        )
        .unwrap();
        let engine = open(root.path());
        let result = engine
            .resolve_creation_admission("owner", "original-create", binding.clone())
            .await
            .unwrap();
        let expected = if point == "beforeAdmission" {
            "notAdmitted"
        } else {
            "admitted"
        };
        assert_eq!(result["creationAdmission"]["status"], expected, "{point}");
        let created = matches!(point, "afterSnapshot" | "afterCompletion");
        if created {
            assert_eq!(result["data"].as_array().unwrap().len(), 1, "{point}");
            assert_eq!(result["data"][0]["status"], "completed", "{point}");
        } else if point == "afterAdmission" {
            assert_eq!(result["data"][0]["state"], "unknown");
            assert_eq!(result["data"][0]["status"], "admitted");
        }
        assert!(
            engine
                .create_configured("owner".into(), request(&binding), Arc::new(Host))
                .await
                .is_err(),
            "stale original must not execute at {point}"
        );
        if point != "beforeAdmission" {
            let rebound = engine.creation_admission("owner").await;
            assert!(
                engine
                    .create_configured("owner".into(), request(&rebound), Arc::new(Host))
                    .await
                    .is_err(),
                "same ID cannot be rebound at {point}"
            );
        }
        assert_eq!(
            engine.list(None, 100, None).await.unwrap().0.len(),
            usize::from(created),
            "{point}"
        );
        engine.shutdown().await;
    }
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "isolated SIGKILL worker, executed by sigkill_windows_preserve_original_admission_without_replay"]
async fn creation_crash_worker() {
    let root = std::path::PathBuf::from(std::env::var("AREAL_CREATION_CRASH_ROOT").unwrap());
    let engine = open(&root);
    let binding = engine.creation_admission("owner").await;
    engine
        .store
        .save_metadata("test-binding", &binding)
        .await
        .unwrap();
    *engine.desktop.submissions.crash_point.lock().unwrap() =
        Some(std::env::var("AREAL_CREATION_CRASH_POINT").unwrap());
    engine
        .create_configured("owner".into(), request(&binding), Arc::new(Host))
        .await
        .unwrap();
    panic!("requested crash point was not reached");
}
