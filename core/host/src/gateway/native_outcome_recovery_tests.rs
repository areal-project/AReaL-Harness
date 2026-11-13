use super::*;
use std::os::unix::fs::{MetadataExt, PermissionsExt};

struct RecordPermissions {
    directory: PathBuf,
    evidence: PathBuf,
    mode: u32,
}

impl RecordPermissions {
    fn new(directory: PathBuf, evidence: PathBuf) -> Self {
        let metadata = std::fs::symlink_metadata(&directory).unwrap();
        assert!(metadata.is_dir());
        assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
        let mode = metadata.permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
        Self {
            directory,
            evidence,
            mode,
        }
    }
}

impl Drop for RecordPermissions {
    fn drop(&mut self) {
        let restored =
            std::fs::set_permissions(&self.directory, std::fs::Permissions::from_mode(self.mode));
        let _ = storage::write(
            &self.evidence,
            &json!({
                "directory":self.directory,"originalMode":self.mode,"restored":restored.is_ok(),
                "error":restored.err().map(|error|error.to_string())
            }),
        );
    }
}

#[test]
fn outcome_directory_permissions_restore_during_panic() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("records");
    storage::private_dir(&directory).unwrap();
    let evidence = root.path().join("permissions.json");
    let result = std::panic::catch_unwind(|| {
        let _permissions = RecordPermissions::new(directory.clone(), evidence.clone());
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o500)).unwrap();
        panic!("intentional outcome fault assertion failure");
    });
    assert!(result.is_err());
    assert_eq!(
        std::fs::metadata(directory).unwrap().permissions().mode() & 0o777,
        0o700
    );
    let restored: Value = storage::read(&evidence).unwrap();
    assert_eq!(restored["restored"], true);
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "real Core/Runtime; finite T22 Host owner fixture only, pending projection is not a wire receipt; requires AREAL_CORE_BIN and AREAL_NATIVE_FAULT_EVIDENCE"]
async fn native_outcome_write_denied_preserves_original_pending_and_recovers() {
    tokio::task::LocalSet::new()
        .run_until(run_native_outcome_case())
        .await;
}

async fn run_native_outcome_case() {
    let mut f = Fixture::new().await;
    (f.close)();
    f.server.abort();
    let mut native = start_native_core(&f).await;
    let run = native.run.clone();
    let direct = native.direct.clone();
    let created = areal_local_service::rpc(
        &direct,
        "areal/thread/start",
        json!({
            "requestId":uuid::Uuid::new_v4().to_string(),"cwd":direct.identity.workspace,
            "agentProfile":{"id":"ordinary","revision":"v1"}
        }),
    )
    .await
    .unwrap();
    let thread = created["thread"]["id"].as_str().unwrap();
    let records = f.host.home.join("host/journals/records");
    let permissions =
        RecordPermissions::new(records.clone(), run.join("permissions-restored.json"));
    let record_path = records.join(format!("{}.json", storage::digest(b"project")));
    let proxy = attach_native_proxy(
        &mut f,
        &native,
        "areal/turn/start",
        NativeReplyFault::DenyOutcomeWrite(records.clone()),
    )
    .await;
    let command = uuid::Uuid::new_v4().to_string();
    let request = f.request(
        "session.send",
        json!({
            "threadId":thread,"expectedConfigRevision":1,"text":"Append original outcome marker"
        }),
        Some(&command),
    );
    let error = f.session("a").request(&request).await.unwrap_err();
    let cause = error
        .downcast_ref::<std::io::Error>()
        .expect("outcome fault must retain the actual I/O cause");
    storage::write(
        &run.join("original-error.json"),
        &json!({
            "kind":format!("{:?}",cause.kind()),"message":error.to_string(),
            "boundary":"Session.request error; wire submissionUnknown was not observed"
        }),
    )
    .unwrap();
    assert_eq!(cause.kind(), std::io::ErrorKind::PermissionDenied);
    assert_eq!(
        std::fs::metadata(&records).unwrap().permissions().mode() & 0o777,
        0o500
    );
    assert!(
        proxy.dropped.borrow().is_none(),
        "the real Core reply must be forwarded, not dropped"
    );
    let observed = proxy
        .failed_outcome
        .borrow()
        .clone()
        .expect("write denial follows real Core success");
    let operation = observed["request"]["params"]["requestId"].as_str().unwrap();
    let turn = observed["successResponse"]["result"]["turn"]["id"]
        .as_str()
        .unwrap();
    let before = std::fs::read(run.join("journal-before-outcome.bin")).unwrap();
    let after = std::fs::read(&record_path).unwrap();
    std::fs::write(run.join("journal-after-failed-outcome.bin"), &after).unwrap();
    assert_eq!(
        after, before,
        "failed outcome persistence preserves original pending bytes"
    );
    let pending: Value = storage::read(&run.join("pending-before-outcome.json")).unwrap();
    assert_eq!(pending["operationId"], operation);
    assert_eq!(pending["remote"]["commandId"], command);
    assert_eq!(pending["remote"]["target"]["threadId"], thread);
    assert_eq!(pending["params"], observed["request"]["params"]);
    assert!(pending.get("admissionState").is_none());
    assert!(pending.get("receipt").is_none());
    let projection = Session::command_view(Some(&pending), &command);
    storage::write(&run.join("pending-projection.json"), &projection).unwrap();
    assert_eq!(projection["operationId"], operation);
    assert_eq!(projection["admissionState"], "unknown");
    assert_eq!(projection["submissionUnknown"], true);
    assert!(projection.get("receipt").is_none());
    drop(permissions);
    let restored: Value = storage::read(&run.join("permissions-restored.json")).unwrap();
    assert_eq!(restored["restored"], true);
    assert_eq!(
        std::fs::metadata(&records).unwrap().permissions().mode() & 0o777,
        0o700
    );
    let recovered = f
        .session("a")
        .request(&f.request("command.read", json!({"commandId":command}), None))
        .await
        .unwrap();
    storage::write(&run.join("recovered.json"), &recovered).unwrap();
    assert_eq!(recovered["commandId"], command);
    assert_eq!(recovered["operationId"], operation);
    assert_eq!(recovered["nativeRequestId"], operation);
    assert_eq!(recovered["admissionState"], "accepted");
    assert_eq!(recovered["turnId"], turn);
    let receipt_read: Value = storage::read(&run.join("core-receipt.json")).unwrap();
    assert_eq!(receipt_read["request"]["params"]["requestId"], operation);
    assert_eq!(receipt_read["request"]["params"]["threadId"], thread);
    let receipts = receipt_read["response"]["result"]["data"]
        .as_array()
        .unwrap();
    assert_eq!(receipts.len(), 1);
    let receipt = &receipts[0];
    assert_eq!(receipt["requestId"], operation);
    assert_eq!(receipt["method"], "areal/turn/start");
    assert_eq!(receipt["digest"], pending["nativeDigest"]);
    assert_eq!(
        receipt["identity"],
        pending["coreScope"]["storeBinding"]["identity"]
    );
    assert_eq!(receipt["status"], "completed");
    assert_eq!(receipt["operation"]["requestId"], operation);
    assert_eq!(
        receipt["operation"]["target"],
        json!({"kind":"thread","threadId":thread})
    );
    assert_eq!(receipt["result"]["turn"]["id"], turn);
    let duplicate = f.session("a").request(&request).await.unwrap();
    assert_eq!(duplicate["operationId"], operation);
    assert_eq!(duplicate["admissionState"], "accepted");
    assert_eq!(duplicate["turnId"], turn);
    assert_eq!(proxy.requests.borrow().len(), 1);
    let terminal = wait_native_turn(&direct, thread, turn).await;
    storage::write(&run.join("terminal.json"), &terminal).unwrap();
    assert_eq!(terminal["status"], "completed");
    let tools: Vec<_> = terminal["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["tool"] == "run_command")
        .collect();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["execution"]["backend"], "runtime");
    assert_eq!(tools[0]["execution"]["outcome"], "succeeded");
    assert_eq!(std::fs::read_to_string(&native.effect).unwrap(), "x");
    let snapshot = areal_local_service::rpc(
        &direct,
        "thread/read",
        json!({"threadId":thread,"includeTurns":true}),
    )
    .await
    .unwrap();
    assert_eq!(snapshot["thread"]["turns"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["thread"]["turns"][0]["id"], turn);
    storage::write(&run.join("business.json"),&json!({
        "originalCase":"finite T22 real outcome write PermissionDenied",
        "originalError":format!("{error:#}"),"pendingProjection":projection,
        "commandId":command,"operationId":operation,"threadId":thread,"turnId":turn,
        "forwardedTurnStartRequests":proxy.requests.borrow().clone(),"duplicate":duplicate,"runtimeEffect":"x",
        "boundary":"Host owner+journal with real Core/Runtime; internal pending projection is not a real wire submissionUnknown"
    })).unwrap();
    stop_native(&mut f, &mut native, proxy).await;
    storage::write(&run.join("result.json"),&json!({"businessPassed":true,"cleanupPassed":true,
        "binary":native.binary,"corePid":native.core.0.id(),"modelPid":native.model.0.id(),
        "boundary":"finite T22 owner layer; no Remote Noise wire, independent Host crash or 100-race gate"
    })).unwrap();
    println!("native outcome fault evidence: {}", run.display());
}
