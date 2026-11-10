use super::*;

#[tokio::test(flavor = "current_thread")]
async fn creation_outcome_failure_never_projects_changed_pending_as_original_unknown() {
    tokio::task::LocalSet::new().run_until(async {
        let mut f = Fixture::new().await;
        let command = uuid::Uuid::new_v4().to_string();
        let creating = Fixture::dispatch(f.session("a"), f.request("session.create", json!({}), Some(&command)));
        f.call("areal/capabilities").await.reply(json!({"features":{"threadStartAdmissionGuard":true,"permissionPresets":true,"threadCreationJournal":{"binding":binding()}},"methods":["areal/thread/start","areal/request/read"]}));
        let held = f.call("areal/thread/start").await;
        let (revision, mut snapshot) = f.host.journal.native_snapshot("project").unwrap();
        let operation = snapshot["pending"][0]["operationId"].clone();
        assert_eq!(held.request["params"]["requestId"], operation);
        snapshot["pending"][0]["nativeDigest"] = json!("changed-pending-digest");
        f.host.journal.native_replace("project", revision, snapshot).unwrap();
        let before = f.host.journal.native_snapshot("project").unwrap();
        crate::journal::FAIL_RECORD_WRITES.with(|fail| fail.set(true));
        held.reply(json!({"thread":{"id":"created-thread"}}));
        let (_, result) = creating.await.unwrap();
        crate::journal::FAIL_RECORD_WRITES.with(|fail| fail.set(false));
        assert!(result.unwrap_err().downcast_ref::<std::io::Error>().is_some_and(|error| error.kind() == std::io::ErrorKind::PermissionDenied));
        assert_eq!(f.host.journal.native_snapshot("project").unwrap(), before);
        assert!(f.calls.try_recv().is_err());
    }).await;
}

fn binding() -> Value {
    json!({"identity":"store","journalEpoch":"11111111-1111-4111-8111-111111111111","coreInstanceId":"22222222-2222-4222-8222-222222222222"})
}

fn pending(f: &Fixture) -> Value {
    let session = f.session("a");
    let command = uuid::Uuid::new_v4().to_string();
    let record = json!({"method":"areal/thread/start","operationId":"original-create","nativeDigest":ORIGINAL_DIGEST,"params":{"requestId":"original-create","creationAdmission":binding()},"coreScope":{"serviceId":"original-service","generation":"retired-generation","connectionId":"retired-connection"},"remote":{"hostId":session.host_peer,"devicePeerId":"a","projectId":f.alias,"commandId":command,"method":"session.create","capability":"submit","admittedGrantRevision":1,"semanticDigest":ORIGINAL_DIGEST,"target":{}}});
    let (revision, mut snapshot) = f.host.journal.native_snapshot("project").unwrap();
    snapshot["pending"]
        .as_array_mut()
        .unwrap()
        .push(record.clone());
    f.host
        .journal
        .native_replace("project", revision, snapshot)
        .unwrap();
    record
}

fn current_binding() -> Value {
    let mut current = binding();
    current["coreInstanceId"] = json!("33333333-3333-4333-8333-333333333333");
    current
}

fn proof() -> Value {
    let mut proof = binding();
    proof["status"] = json!("notAdmitted");
    proof["requestId"] = json!("original-create");
    proof["method"] = json!("areal/thread/start");
    proof
}

fn receipt() -> Value {
    json!({"requestId":"original-create","method":"areal/thread/start","digest":ORIGINAL_DIGEST,"identity":"store","status":"completed","threadId":"created-thread","operation":{"requestId":"original-create","method":"areal/thread/start","target":{"kind":"thread","threadId":"created-thread"}}})
}

// 认证 Core fixture 控制回执，真实 Host journal 负责结算；不模拟真实进程崩溃。
#[tokio::test(flavor = "current_thread")]
async fn creation_recovery_across_generation_uses_original_receipt_or_exact_negative_proof() {
    tokio::task::LocalSet::new().run_until(async {
        for accepted in [true, false] {
            let mut f = Fixture::new().await;
            let record = pending(&f);
            let command = record["remote"]["commandId"].as_str().unwrap();
            let request = f.request("command.read", json!({"commandId":command}), None);
            let mut recovering = Fixture::dispatch(f.session("a"), request.clone());
            let caps = tokio::select! {
                call = f.call("areal/capabilities") => call,
                result = &mut recovering => panic!("recovery stopped before checking current store: {:?}", result.unwrap().1),
            };
            caps.reply(json!({"features":{"threadCreationJournal":{"binding":current_binding()}}}));
            let query = f.call("areal/request/read").await;
            assert_eq!(query.request["params"], json!({"requestId":"original-create","creationAdmission":binding()}));
            query.reply(if accepted { json!({"data":[receipt()]}) } else { json!({"data":[],"creationAdmission":proof()}) });
            let (_, recovered) = recovering.await.unwrap();
            let recovered = recovered.unwrap();
            assert_eq!(recovered["admissionState"], if accepted { "accepted" } else { "rejected" });
            let (_, snapshot) = f.host.journal.native_snapshot("project").unwrap();
            assert_eq!(snapshot["outcomes"]["original-create"]["admissionState"], if accepted { "accepted" } else { "rejected" });
            assert_eq!(snapshot["outcomes"]["original-create"]["accepted"], accepted);
            assert_eq!(recovered["commandId"], command);
            assert_eq!(recovered["submissionUnknown"], false);
            assert!(snapshot["pending"].as_array().unwrap().is_empty());
            let (_, duplicate) = Fixture::dispatch(f.session("a"), request).await.unwrap();
            assert_eq!(duplicate.unwrap(), recovered);
            assert!(f.calls.try_recv().is_err());
        }
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn creation_recovery_incomplete_or_changed_evidence_remains_unknown() {
    tokio::task::LocalSet::new().run_until(async {
        for case in ["wrong-service", "original-malformed", "wrong-identity", "wrong-epoch", "current-malformed", "same-instance", "proof-identity", "proof-epoch", "proof-instance", "proof-request", "proof-method", "proof-unconfirmed",
            "malformed-read", "other-receipt", "receipt-request", "receipt-method", "receipt-digest", "receipt-identity", "receipt-operation", "receipt-target", "receipt-pending", "scope-change", "grant-change"] {
            let mut f = Fixture::new().await;
            let mut record = pending(&f);
            if case == "wrong-service" { record["coreScope"]["serviceId"] = json!("other-service"); }
            if case == "original-malformed" { record["params"]["creationAdmission"]["coreInstanceId"] = json!(null); }
            let before = f.host.journal.native_snapshot("project").unwrap();
            let original = record.clone();
            let session = f.session("a");
            let alias = f.alias.clone();
            let mut recovering = tokio::task::spawn_local(async move { session.reconcile_creation(&alias, &record).await });
            if matches!(case, "wrong-service" | "original-malformed") {
                assert_eq!(recovering.await.unwrap().unwrap(), original, "{case}");
            } else {
                let mut current = current_binding();
                match case {
                    "wrong-identity" => current["identity"] = json!("other-store"),
                    "wrong-epoch" => current["journalEpoch"] = json!("44444444-4444-4444-8444-444444444444"),
                    "current-malformed" => current["coreInstanceId"] = json!(null),
                    "same-instance" => current = binding(),
                    _ => {}
                }
                f.call("areal/capabilities").await.reply(json!({"features":{"threadCreationJournal":{"binding":current}}}));
                if matches!(case, "wrong-identity" | "wrong-epoch" | "current-malformed") {
                    assert_eq!(recovering.await.unwrap().unwrap(), original, "{case}");
                } else {
                    let query = tokio::select! {
                        call = f.call("areal/request/read") => call,
                        result = &mut recovering => panic!("{case}: premature result {:?}", result.unwrap()),
                    };
                    let mut negative = proof();
                    let mut completed = receipt();
                    match case {
                        "proof-identity" => negative["identity"] = json!("other-store"),
                        "proof-epoch" => negative["journalEpoch"] = json!("other-epoch"),
                        "proof-instance" => negative["coreInstanceId"] = current_binding()["coreInstanceId"].clone(),
                        "proof-request" => negative["requestId"] = json!("other-request"),
                        "proof-method" => negative["method"] = json!("areal/turn/start"),
                        "proof-unconfirmed" => negative["status"] = json!("unconfirmed"),
                        "receipt-request" => completed["requestId"] = json!("other-request"),
                        "receipt-method" => completed["method"] = json!("areal/turn/start"),
                        "receipt-digest" => completed["digest"] = json!("other-digest"),
                        "receipt-identity" => completed["identity"] = json!("other-store"),
                        "receipt-operation" => completed["operation"]["requestId"] = json!("other-request"),
                        "receipt-target" => completed["operation"]["target"]["threadId"] = json!("other-thread"),
                        "receipt-pending" => completed["status"] = json!("pending"),
                        "scope-change" => f.reconnect().await,
                        "grant-change" => f.grant("a", |grant| grant["capabilities"] = json!(["observe"])),
                        _ => {}
                    }
                    let data = if case.starts_with("receipt-") || matches!(case, "scope-change" | "grant-change") { json!([completed]) } else if case == "other-receipt" { json!([{"method":"other"}]) } else { json!([]) };
                    query.reply(if case == "malformed-read" { json!({"creationAdmission":negative}) } else { json!({"data":data,"creationAdmission":negative}) });
                    let result = recovering.await.unwrap();
                    if case == "grant-change" { assert!(result.is_err()); }
                    else { assert_eq!(result.unwrap(), original, "{case}"); }
                }
            }
            assert_eq!(f.host.journal.native_snapshot("project").unwrap(), before, "{case}");
            assert!(f.calls.try_recv().is_err(), "{case}: recovery dispatched an extra request");
        }
    }).await;
}
