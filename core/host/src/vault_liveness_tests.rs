use super::*;
use std::sync::{
    Condvar, Mutex as BlockingMutex,
    atomic::{AtomicUsize, Ordering},
};

// 屏障由 Host 线程之外持有；断言失败也必须释放真实写调用并回收线程。
#[derive(Default)]
struct WriteGate {
    released: BlockingMutex<bool>,
    changed: Condvar,
}

impl WriteGate {
    fn wait(&self) {
        let mut released = self.released.lock().unwrap();
        while !*released {
            released = self.changed.wait(released).unwrap();
        }
    }

    fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.changed.notify_all();
    }
}

struct ReleaseOnDrop(Arc<WriteGate>);
impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        self.0.release();
    }
}

async fn authenticate(stream: std::os::unix::net::UnixStream) -> BufReader<UnixStream> {
    stream.set_nonblocking(true).unwrap();
    let mut reader = BufReader::new(UnixStream::from_std(stream).unwrap());
    send(
        &mut reader,
        "hello",
        json!({"authToken":"fixture","protocolVersions":[1],"capabilities":[]}),
    )
    .await;
    let hello = wire::read(&mut reader).await.unwrap().unwrap();
    assert!(hello.get("error").is_none(), "{hello}");
    reader
}

async fn send(reader: &mut BufReader<UnixStream>, method: &str, params: Value) {
    wire::write(
        reader.get_mut(),
        &json!({"version":1,"id":method,"method":method,"params":params}),
    )
    .await
    .unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn blocked_vault_write_keeps_other_authenticated_reads_live_and_receipt_pending() {
    blocked_write(false).await;
}

#[tokio::test(flavor = "current_thread")]
async fn blocked_subscription_handoff_keeps_original_receipt_and_survives_disconnect() {
    blocked_write(true).await;
}

#[tokio::test(flavor = "current_thread")]
async fn project_preparation_defers_only_proven_optional_subscription_and_recovers_original_slot() {
    let root = tempfile::tempdir().unwrap();
    let base = root.path().canonicalize().unwrap();
    let mut host = schedules::tests::fixture(&base);
    let mut migration = crate::migration::Migration::new(&host.home).unwrap();
    migration.vault = crate::vault::Vault::isolated_files(&host.home);
    let core = base.join("core");
    let profile = base.join("profile");
    storage::private_dir(&core).unwrap();
    storage::private_dir(&profile).unwrap();
    storage::write(&core.join("projects.json"), &json!([])).unwrap();
    let source = crate::migration::Source {
        profile,
        core_home: core,
        legacy_service_home: base.join("legacy"),
    };
    migration.attach(source.clone(), "fixture", None).unwrap();
    let imported = migration.import(serde_json::from_value(json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":host.identity.generation,"source":source})).unwrap(), "fixture", &[], &host.journal).unwrap();
    let source = imported["receipt"]["sourceId"].as_str().unwrap().to_owned();
    let provider = "AREAL_CREDENTIAL_arena";
    let openai = "AREAL_CREDENTIAL_areal_openai";
    migration.vault.dispatch("vault.replace", json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":host.identity.generation,"slot":{"kind":"providerCredential","sourceId":source,"reference":provider},"expectedRevision":0,"value":"synthetic-arena"}), &host.identity.generation, &migration).unwrap();
    migration
        .vault
        .replace_subscription_transport(
            &source,
            &uuid::Uuid::new_v4().to_string(),
            0,
            json!({"token":"old-synthetic","port":1234}),
            &migration,
        )
        .unwrap();
    storage::private_dir(&host.home.join("host/subscription-owners")).unwrap();
    storage::write(
        &host
            .home
            .join("host/subscription-owners")
            .join(format!("{source}.json")),
        &json!({"owner":"nativeV1"}),
    )
    .unwrap();
    std::fs::write(host.home.join("config.toml"), "schema_version=2\n[model]\nname='fixture'\n[model.providers.default]\nendpoint='http://127.0.0.1:1/v1/chat/completions'\napi_key_env='AREAL_CREDENTIAL_arena'\n").unwrap();
    storage::private_dir(&host.bin).unwrap();
    for name in [
        "areal",
        "areal-runtime",
        "areal-runtime-fs",
        "areal-runtime-reaper",
    ] {
        std::fs::write(host.bin.join(name), "fixture").unwrap();
    }
    let gate = Arc::new(WriteGate::default());
    let release = ReleaseOnDrop(gate.clone());
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let entered = BlockingMutex::new(Some(entered_tx));
    migration.vault.before_write = Some(Arc::new(move || {
        if let Some(entered) = entered.lock().unwrap().take() {
            let _ = entered.send(());
        }
        gate.wait();
    }));
    host.migration = migration.into();
    {
        let mut slots = host.slots.borrow_mut();
        let slot = slots.get_mut("project").unwrap();
        slot.credentials
            .insert(openai.into(), "do-not-use-cached-token".into());
        slot.imported_credentials.insert(openai.into());
    }
    let request = uuid::Uuid::new_v4().to_string();
    let mut writing = Box::pin(host.migration.vault.replace_subscription_transport_async(
        &source,
        &request,
        1,
        json!({"token":"new-synthetic","port":1234}),
        &host.migration,
    ));
    tokio::select! {
        result=entered_rx=>result.unwrap(),
        result=&mut writing=>panic!("write ended before barrier: {result:?}"),
    }
    let arena = Ensure {
        request_id: uuid::Uuid::new_v4().to_string(),
        expected_generation: host.identity.generation.clone(),
        project_id: "project".into(),
        no_auto_restart: false,
        resume_scheduling: false,
        launch_inputs: Some(LaunchInputs {
            workspace: base.join("workspace"),
            cwd: base.join("workspace"),
            config_home: host.home.clone(),
            homedir: Some(base.join("isolated-home")),
            config_path: None,
            deployment_path: None,
            schedule_preparation: None,
            environment: BTreeMap::new(),
            credential_names: vec![provider.into(), openai.into()],
            options: areal_local_service::LocalArgs {
                model: Some("fixture".into()),
                ..Default::default()
            },
        }),
        credentials: BTreeMap::new(),
    };
    let prepared = tokio::time::timeout(Duration::from_secs(1), host.ensure_inner(&arena)).await;
    let mut chatgpt = arena.clone();
    chatgpt.launch_inputs.as_mut().unwrap().options.api_key_env = Some(openai.into());
    let waiting_chatgpt =
        tokio::time::timeout(Duration::from_millis(50), host.ensure_inner(&chatgpt)).await;
    let mut unknown = arena.clone();
    unknown.launch_inputs.as_mut().unwrap().options.api_key_env =
        Some("UNRESOLVED_CREDENTIAL".into());
    let waiting_unknown =
        tokio::time::timeout(Duration::from_millis(50), host.ensure_inner(&unknown)).await;
    let pending = host
        .migration
        .vault
        .operation_async(&request, &host.migration)
        .await
        .unwrap()
        .unwrap();
    let cached = host.slots.borrow()["project"].credentials[openai].clone();
    let saved_path = host
        .home
        .join("host/launch")
        .join(storage::digest(b"project"))
        .join("inputs.json");
    let projected: Option<LaunchInputs> = storage::read_optional(&saved_path).unwrap();
    release.0.release();
    let done = writing.await.unwrap();
    assert!(
        prepared
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("missing activation receipt"),
        "Arena must reach the prepared launch boundary"
    );
    assert!(
        waiting_chatgpt.is_err() && waiting_unknown.is_err(),
        "explicit or unproven subscription dependency must wait"
    );
    assert_eq!(pending["state"], "acceptedPending");
    assert_eq!(cached, "do-not-use-cached-token");
    assert!(
        !projected
            .unwrap()
            .credential_names
            .contains(&openai.to_owned())
    );
    assert_eq!(done["revision"], 2);
    let resumed = host.ensure_inner(&chatgpt).await.unwrap_err();
    assert!(
        resumed.to_string().contains("missing activation receipt"),
        "{resumed:#}"
    );
    assert_eq!(
        host.slots.borrow()["project"].credentials[openai],
        "new-synthetic"
    );
    let restored: LaunchInputs = storage::read(&saved_path).unwrap();
    assert!(restored.credential_names.contains(&openai.to_owned()));
}

#[tokio::test(flavor = "current_thread")]
async fn project_preparation_isolates_pending_migration_credentials_without_losing_them() {
    let root = tempfile::tempdir().unwrap();
    let base = root.path().canonicalize().unwrap();
    let mut host = schedules::tests::fixture(&base);
    let mut migration = crate::migration::Migration::new(&host.home).unwrap();
    migration.vault = crate::vault::Vault::isolated_files(&host.home);
    let core = base.join("core");
    let profile = base.join("profile");
    storage::private_dir(&core).unwrap();
    storage::private_dir(&profile).unwrap();
    storage::write(&core.join("projects.json"), &json!([])).unwrap();
    storage::write(
        &core.join("provider-credentials.json"),
        &json!({"keys":{"AREAL_CREDENTIAL_arena":"cipher-a","AREAL_CREDENTIAL_other":"cipher-b"}}),
    )
    .unwrap();
    storage::write(
        &core.join("subscription-transport.json"),
        &json!({"token":"cipher-c","port":1234}),
    )
    .unwrap();
    let source = crate::migration::Source {
        profile,
        core_home: core,
        legacy_service_home: base.join("legacy"),
    };
    migration.attach(source.clone(), "fixture", None).unwrap();
    let request = uuid::Uuid::new_v4().to_string();
    let imported = migration.import(serde_json::from_value(json!({"requestId":request,"expectedGeneration":host.identity.generation,"source":source})).unwrap(), "fixture", &[], &host.journal).unwrap();
    assert_eq!(imported["sourcePublished"], true);
    let secrets = imported["pendingSecrets"].as_array().unwrap();
    let import = |secret: &Value, value: Value| {
        serde_json::from_value(json!({"requestId":secret["requestId"],"expectedGeneration":host.identity.generation,"migrationId":request,"slot":secret["slot"],"sourceDigest":secret["sourceDigest"],"value":value})).unwrap()
    };
    let arena_secret = secrets
        .iter()
        .find(|v| v["slot"]["reference"] == "AREAL_CREDENTIAL_arena")
        .unwrap();
    migration
        .import_secret_async(import(arena_secret, json!("synthetic-arena")), "fixture")
        .await
        .unwrap();
    let deferred = ["AREAL_CREDENTIAL_other", "AREAL_CREDENTIAL_areal_openai"];
    std::fs::write(host.home.join("config.toml"), "schema_version=2\n[model]\nname='fixture'\n[model.providers.default]\nendpoint='http://127.0.0.1:1/v1/chat/completions'\napi_key_env='AREAL_CREDENTIAL_arena'\n").unwrap();
    storage::private_dir(&host.bin).unwrap();
    for name in [
        "areal",
        "areal-runtime",
        "areal-runtime-fs",
        "areal-runtime-reaper",
    ] {
        std::fs::write(host.bin.join(name), "fixture").unwrap();
    }
    host.migration = migration.into();
    for name in deferred {
        let mut slots = host.slots.borrow_mut();
        let slot = slots.get_mut("project").unwrap();
        slot.credentials
            .insert(name.into(), "do-not-use-cached-token".into());
        slot.imported_credentials.insert(name.into());
    }
    let arena = Ensure {
        request_id: uuid::Uuid::new_v4().to_string(),
        expected_generation: host.identity.generation.clone(),
        project_id: "project".into(),
        no_auto_restart: false,
        resume_scheduling: false,
        launch_inputs: Some(LaunchInputs {
            workspace: base.join("workspace"),
            cwd: base.join("workspace"),
            config_home: host.home.clone(),
            homedir: Some(base.join("isolated-home")),
            config_path: None,
            deployment_path: None,
            schedule_preparation: None,
            environment: BTreeMap::new(),
            credential_names: vec![
                "AREAL_CREDENTIAL_arena".into(),
                deferred[0].into(),
                deferred[1].into(),
            ],
            options: areal_local_service::LocalArgs {
                model: Some("fixture".into()),
                ..Default::default()
            },
        }),
        credentials: BTreeMap::new(),
    };
    let prepared = host.ensure_inner(&arena).await.unwrap_err();
    assert!(
        prepared.to_string().contains("missing activation receipt"),
        "safe Arena launch failed: {prepared:#}"
    );
    let saved_path = host
        .home
        .join("host/launch")
        .join(storage::digest(b"project"))
        .join("inputs.json");
    let projected: LaunchInputs = storage::read(&saved_path).unwrap();
    for name in deferred {
        assert!(!projected.credential_names.contains(&name.to_owned()));
        assert_eq!(
            host.slots.borrow()["project"].credentials[name],
            "do-not-use-cached-token"
        );
    }
    for selected in [deferred[0], deferred[1], "UNRESOLVED_CREDENTIAL"] {
        let mut explicit = arena.clone();
        explicit.launch_inputs.as_mut().unwrap().options.api_key_env = Some(selected.into());
        let failure = host.ensure_inner(&explicit).await.unwrap_err();
        assert!(
            failure.to_string().contains("migrationPending"),
            "{failure:#}"
        );
    }
    assert_eq!(
        host.migration.operation(&request).unwrap().unwrap()["state"],
        "acceptedPending"
    );
    for secret in secrets
        .iter()
        .filter(|v| v["slot"]["reference"] != "AREAL_CREDENTIAL_arena")
    {
        let value = if secret["slot"]["kind"] == "subscriptionTransport" {
            json!({"token":"synthetic-restored","port":1234})
        } else {
            json!("synthetic-restored")
        };
        host.migration
            .import_secret_async(import(secret, value), "fixture")
            .await
            .unwrap();
    }
    for selected in deferred {
        let mut explicit = arena.clone();
        explicit.launch_inputs.as_mut().unwrap().options.api_key_env = Some(selected.into());
        assert!(
            host.ensure_inner(&explicit)
                .await
                .unwrap_err()
                .to_string()
                .contains("missing activation receipt")
        );
        assert_eq!(
            host.slots.borrow()["project"].credentials[selected],
            "synthetic-restored"
        );
    }
}

async fn blocked_write(handoff: bool) {
    let root = tempfile::tempdir().unwrap();
    let root_path = root.path().to_owned();
    let gate = Arc::new(WriteGate::default());
    let release = ReleaseOnDrop(gate.clone());
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let (finished_tx, finished_rx) = tokio::sync::oneshot::channel();
    let writes = Arc::new(AtomicUsize::new(0));
    let worker_writes = writes.clone();
    let pairs: Vec<_> = (0..4)
        .map(|_| std::os::unix::net::UnixStream::pair().unwrap())
        .collect();
    let (clients, servers): (Vec<_>, Vec<_>) = pairs.into_iter().unzip();
    let worker = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(tokio::task::LocalSet::new().run_until(async move {
                let mut host = schedules::tests::fixture(&root_path);
                host.slots.borrow_mut().clear();
                let mut migration = crate::migration::Migration::new(&host.home).unwrap();
                migration.vault = crate::vault::Vault::isolated_files(&host.home);
                let core = root_path.join("core");
                let profile = root_path.join("profile");
                storage::private_dir(&core).unwrap();
                storage::private_dir(&profile).unwrap();
                storage::write(&core.join("projects.json"), &json!([])).unwrap();
                let source = crate::migration::Source {
                    profile,
                    core_home: core,
                    legacy_service_home: root_path.join("legacy"),
                };
                migration.attach(source.clone(), "fixture", None).unwrap();
                let migration_id = uuid::Uuid::new_v4().to_string();
                let imported = migration.import(
                    serde_json::from_value(json!({"requestId":migration_id,"expectedGeneration":host.identity.generation,"source":source})).unwrap(),
                    "fixture", &[], &host.journal,
                ).unwrap();
                assert_eq!(imported["kind"], "ready");
                let slot = json!({"kind":"subscriptionTransport","sourceId":imported["receipt"]["sourceId"]});
                if handoff {
                    let retired = migration.retirement_prepare(serde_json::from_value(json!({"requestId":uuid::Uuid::new_v4().to_string(),"migrationId":migration_id,"expectedGeneration":host.identity.generation})).unwrap(), "fixture").unwrap();
                    assert_eq!(retired["state"], "completed");
                }
                let entered = BlockingMutex::new(Some(entered_tx));
                migration.vault.before_write = Some(Arc::new(move || {
                    worker_writes.fetch_add(1, Ordering::SeqCst);
                    if let Some(entered) = entered.lock().unwrap().take() {
                        let _ = entered.send(());
                    }
                    gate.wait();
                }));
                host.migration = migration.into();
                let generation = host.identity.generation.clone();
                let host = Rc::new(host);
                let mut tasks = tokio::task::JoinSet::new();
                let mut finished = Some(finished_tx);
                for (index, stream) in servers.into_iter().enumerate() {
                    stream.set_nonblocking(true).unwrap();
                    let host = host.clone();
                    let finished = if index == 0 { finished.take() } else { None };
                    tasks.spawn_local(async move {
                        let result = connection_loop(host, UnixStream::from_std(stream).unwrap()).await;
                        if let Some(finished) = finished {
                            let _ = finished.send(());
                            if let Err(error) = result {
                                assert!(error.downcast_ref::<std::io::Error>().is_some_and(|error| matches!(error.kind(), std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset)), "{error}");
                            }
                            Ok(())
                        } else { result }
                    });
                }
                ready_tx.send((generation, slot, migration_id)).unwrap();
                while let Some(result) = tasks.join_next().await {
                    result.unwrap().unwrap();
                }
                host.close_subscriptions().await;
            }));
    });
    let (generation, slot, migration_id) = ready_rx.await.unwrap();
    let mut clients = clients.into_iter();
    let mut writing = authenticate(clients.next().unwrap()).await;
    let mut status = authenticate(clients.next().unwrap()).await;
    let mut operation = authenticate(clients.next().unwrap()).await;
    let mut checking = authenticate(clients.next().unwrap()).await;
    let request = uuid::Uuid::new_v4().to_string();
    let vault_params = json!({"requestId":request,"expectedGeneration":generation,"slot":slot,"expectedRevision":0,"value":{"synthetic":true}});
    let method = if handoff {
        "subscription.handoff"
    } else {
        "vault.replace"
    };
    let params = if handoff {
        json!({"requestId":request,"expectedGeneration":generation,"sourceId":slot["sourceId"],"migrationId":migration_id,"expectedAccountRevision":0,"expectedTransportRevision":0,"network":{}})
    } else {
        vault_params.clone()
    };
    send(&mut writing, method, params.clone()).await;
    tokio::time::timeout(Duration::from_secs(5), entered_rx)
        .await
        .expect("fixture write did not reach the accepted-pending barrier")
        .unwrap();
    let original_path = root
        .path()
        .join("home/host/subscription-operations")
        .join(format!("{request}.json"));
    let original: Option<Value> = if handoff {
        Some(storage::read(&original_path).unwrap())
    } else {
        None
    };
    let vault_request = original.as_ref().map_or(request.as_str(), |record| {
        record["context"]["transportRequestId"].as_str().unwrap()
    });
    let receipt_path = root
        .path()
        .join("home/host/vault-operations")
        .join(format!("{vault_request}.json"));
    let before: Value = storage::read(&receipt_path).unwrap();
    assert_eq!(before["state"], "acceptedPending");
    send(&mut status, "host.status", json!({})).await;
    send(
        &mut operation,
        "host.operation",
        json!({"requestId":request}),
    )
    .await;
    // 有界等待是响应断言和死锁清理期限；写屏障只由显式释放事件推进。
    let (status_before_release, operation_before_release) = tokio::join!(
        tokio::time::timeout(Duration::from_secs(1), wire::read(&mut status)),
        tokio::time::timeout(Duration::from_secs(1), wire::read(&mut operation)),
    );
    let status_progress = matches!(&status_before_release, Ok(Ok(Some(response))) if response.get("error").is_none() && response["id"] == "host.status");
    let operation_progress = matches!(&operation_before_release, Ok(Ok(Some(response))) if response.get("error").is_none() && response["id"] == "host.operation");
    send(&mut checking, method, params.clone()).await;
    let same = tokio::time::timeout(Duration::from_secs(1), wire::read(&mut checking)).await;
    let mut conflict = params.clone();
    if handoff {
        conflict["expectedAccountRevision"] = json!(9);
    } else {
        conflict["value"] = json!({"different":true});
    }
    let mut conflict_result = None;
    let mut busy_result = None;
    if same.is_ok() {
        send(&mut checking, method, conflict).await;
        conflict_result = Some(wire::read(&mut checking).await.unwrap().unwrap());
        let mut another = vault_params;
        another["requestId"] = json!(uuid::Uuid::new_v4().to_string());
        send(&mut checking, "vault.replace", another).await;
        busy_result =
            Some(tokio::time::timeout(Duration::from_millis(50), wire::read(&mut checking)).await);
    }
    let while_blocked: Value = storage::read(&receipt_path).unwrap();
    drop(writing);
    release.0.release();
    tokio::time::timeout(Duration::from_secs(5), finished_rx)
        .await
        .unwrap()
        .unwrap();
    let completed: Value = storage::read(&receipt_path).unwrap();
    let original_completed: Option<Value> = if handoff {
        Some(storage::read(&original_path).unwrap())
    } else {
        None
    };
    let queued_result = match busy_result {
        Some(Err(_)) => wire::read(&mut checking).await.unwrap().unwrap(),
        Some(Ok(Ok(Some(value)))) => panic!("另一写入不应在原事务完成前执行: {value}"),
        _ => Value::Null,
    };
    if same.is_err() {
        wire::read(&mut checking).await.unwrap().unwrap();
    }
    if status_before_release.is_err() {
        wire::read(&mut status).await.unwrap().unwrap();
    }
    if operation_before_release.is_err() {
        wire::read(&mut operation).await.unwrap().unwrap();
    }
    drop((checking, status, operation));
    worker.join().unwrap();
    eprintln!(
        "vault barrier: status_progress={}, operation_progress={}, pending_during_write={}, final_state={}, final_revision={}",
        status_before_release.is_ok(),
        operation_before_release.is_ok(),
        while_blocked["state"],
        completed["state"],
        completed["revision"]
    );
    assert_eq!(
        while_blocked, before,
        "原写尚在进行时不能按缺失 entry 提前结算"
    );
    assert_eq!(completed["state"], "completed");
    assert_eq!(completed["revision"], 1);
    assert_eq!(
        writes.load(Ordering::SeqCst),
        if handoff { 2 } else { 1 },
        "同 ID 复查与断连不得重放凭据写入"
    );
    if let Ok(Ok(Some(response))) = same {
        assert_eq!(
            response["result"],
            original
                .as_ref()
                .map_or(&before, |record| &record["receipt"])
                .clone()
        );
    } else {
        panic!("同 ID 复查被凭据写屏障阻塞");
    }
    if let Some(original) = original_completed {
        assert_eq!(original["receipt"]["state"], "completed", "{original}");
        assert_eq!(original["receipt"]["result"]["owner"], "nativeV1");
        assert_eq!(original["receipt"]["result"]["transportRevision"], 2);
    }
    assert_eq!(conflict_result.unwrap()["error"]["code"], "requestConflict");
    assert_eq!(queued_result["error"]["code"], "revisionConflict");
    if let Ok(Ok(Some(response))) = &operation_before_release {
        assert_eq!(response["result"]["operation"]["state"], "acceptedPending");
    }
    assert!(
        status_progress && operation_progress,
        "Keychain 写屏障阻塞了其他已认证连接的状态和原回执读取"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn source_imports_on_one_authenticated_connection_progress_by_slot() {
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let mut host = schedules::tests::fixture(&base);
        let mut migration = crate::migration::Migration::new(&host.home).unwrap();
        migration.vault = crate::vault::Vault::isolated_files(&host.home);
        let core = base.join("import-core");
        let profile = base.join("import-profile");
        storage::private_dir(&core).unwrap();
        storage::private_dir(&profile).unwrap();
        storage::write(&core.join("projects.json"), &json!([])).unwrap();
        let keys: BTreeMap<_,_> = (0..17).map(|index| (format!("AREAL_CREDENTIAL_{index:02}"), "cipher")).collect();
        storage::write(&core.join("provider-credentials.json"), &json!({"keys":keys})).unwrap();
        let source = json!({"profile":profile,"coreHome":core,"legacyServiceHome":base.join("legacy")});
        let gate = Arc::new(WriteGate::default());
        let release = ReleaseOnDrop(gate.clone());
        let (entered, mut observed) = tokio::sync::mpsc::unbounded_channel();
        let writes = Arc::new(AtomicUsize::new(0));
        let counted = writes.clone();
        migration.vault.before_write = Some(Arc::new(move || {
            if counted.fetch_add(1,Ordering::SeqCst) < 16 {
                entered.send(()).unwrap();
                gate.wait();
            }
        }));
        host.migration = migration.into();
        let generation = host.identity.generation.clone();
        let host = Rc::new(host);
        let (server, client) = std::os::unix::net::UnixStream::pair().unwrap();
        server.set_nonblocking(true).unwrap();
        let owned = host.clone();
        let server = tokio::task::spawn_local(async move { connection_loop(owned,UnixStream::from_std(server).unwrap()).await });
        let mut client = authenticate(client).await;
        send(&mut client,"gui.attachSource",json!({"source":source})).await;
        assert!(wire::read(&mut client).await.unwrap().unwrap().get("error").is_none());
        let migration_id = uuid::Uuid::new_v4().to_string();
        send(&mut client,"gui.import",json!({"requestId":migration_id,"expectedGeneration":generation,"source":source})).await;
        let imported = wire::read(&mut client).await.unwrap().unwrap();
        assert_eq!(imported["result"]["sourcePublished"],true);
        let secrets = imported["result"]["pendingSecrets"].as_array().unwrap();
        let params = |secret:&Value| json!({"requestId":secret["requestId"],"expectedGeneration":generation,"migrationId":migration_id,"slot":secret["slot"],"sourceDigest":secret["sourceDigest"],"value":"synthetic"});
        for (index,secret) in secrets.iter().take(16).enumerate() {
            wire::write(client.get_mut(), &json!({"version":1,"id":format!("slow-{index}"),"method":"gui.importSecret","params":params(secret)})).await.unwrap();
            tokio::time::timeout(Duration::from_secs(3),observed.recv()).await.unwrap().unwrap();
        }
        for _ in 0..32 {
            send(&mut client,"gui.importSecret",params(&secrets[0])).await;
            let duplicate=tokio::time::timeout(Duration::from_secs(3),wire::read(&mut client)).await.unwrap().unwrap().unwrap();
            assert_eq!(duplicate["result"]["state"],"acceptedPending");
            assert_eq!(duplicate["result"]["requestId"],secrets[0]["requestId"]);
            assert_eq!(writes.load(Ordering::SeqCst),16);
        }
        wire::write(client.get_mut(), &json!({"version":1,"id":"fast","method":"gui.importSecret","params":params(&secrets[16])})).await.unwrap();
        let fast = tokio::time::timeout(Duration::from_secs(3),wire::read(&mut client)).await.expect("independent slot waited behind slow import").unwrap().unwrap();
        assert_eq!(fast["id"],"fast");
        assert_eq!(fast["result"]["state"],"completed");
        send(&mut client,"host.operation",json!({"requestId":secrets[0]["requestId"]})).await;
        let pending = wire::read(&mut client).await.unwrap().unwrap();
        assert_eq!(pending["result"]["operation"]["state"],"acceptedPending");
        drop(release);
        for _ in 0..16 {
            let slow = wire::read(&mut client).await.unwrap().unwrap();
            assert!(slow["id"].as_str().unwrap().starts_with("slow-"));
            assert_eq!(slow["result"]["state"],"completed");
        }
        assert_eq!(writes.load(Ordering::SeqCst),17);
        drop(client);
        server.await.unwrap().unwrap();
    }).await;
}
