use super::*;
#[test]
#[cfg(target_os = "macos")]
fn prior_boot_host_activation_records_adoption_without_settling_history() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path().canonicalize().unwrap();
    let host = schedules::tests::fixture(&root);
    let registration = host.slots.borrow()["project"].registration.clone();
    storage::private_dir(&registration.data_dir).unwrap();
    storage::private_dir(&host.bin).unwrap();
    for name in [
        "areal",
        "areal-runtime",
        "areal-runtime-fs",
        "areal-runtime-reaper",
    ] {
        std::fs::write(host.bin.join(name), "not an executable").unwrap();
    }
    for name in ["service.lock", "owner.lock"] {
        storage::open_private(&registration.data_dir.join(name), true).unwrap();
    }
    let directory = storage::registry(&host.home, &Host::service_id(&registration)).unwrap();
    storage::private_dir(&directory).unwrap();
    let previous: Service = serde_json::from_value(json!({
        "protocolVersion":1,"serviceId":Host::service_id(&registration),
        "generation":uuid::Uuid::new_v4().to_string(),"workspace":registration.workspace,
        "dataDir":registration.data_dir,"configFingerprint":"old",
        "owner":{"kind":"host","hostId":host.identity.host_id,"generation":uuid::Uuid::new_v4().to_string()},
        "endpoint":"http://127.0.0.1:1","webUrl":"http://127.0.0.1:1",
        "authFile":directory.join("auth.json"),"logFile":directory.join("host.log"),
        "hostPid":500000000,"corePid":500000001,"state":"ready"
    })).unwrap();
    storage::write(&directory.join("service.json"), &previous).unwrap();
    let original_stop = storage::StopReceipt {
        operation: StopOperation {
            version: 1,
            request_id: uuid::Uuid::new_v4().to_string(),
            service_id: previous.identity.service_id.clone(),
            generation: previous.identity.generation.clone(),
            cancel: true,
            state: StopOperationState::AcceptedPending,
            message: None,
            lifecycle: None,
        },
        service: previous.clone(),
        cleanup_confirmed: false,
    };
    storage::write_stop_receipt(&directory, &original_stop).unwrap();
    let original_stop_path =
        storage::stop_receipt_path(&directory, &original_stop.operation.request_id).unwrap();
    let original_stop_bytes = std::fs::read(&original_stop_path).unwrap();
    let inputs = LaunchInputs {
        workspace: registration.workspace.clone(),
        cwd: registration.workspace.clone(),
        config_home: root.join("config"),
        homedir: Some(root.clone()),
        config_path: None,
        deployment_path: None,
        schedule_preparation: None,
        environment: BTreeMap::new(),
        credential_names: vec![],
        options: areal_local_service::LocalArgs::default(),
    };
    let input = Ensure {
        request_id: uuid::Uuid::new_v4().to_string(),
        expected_generation: host.identity.generation.clone(),
        project_id: "project".into(),
        no_auto_restart: false,
        resume_scheduling: true,
        launch_inputs: Some(inputs),
        credentials: BTreeMap::new(),
    };
    crate::migration::prior_boot::with_test_boot(-10, || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let mut current_boot = input.clone();
                current_boot.request_id = uuid::Uuid::new_v4().to_string();
                let failure = host.ensure(current_boot.clone()).await.unwrap_err();
                assert!(
                    failure.to_string().contains("migrationBlocked"),
                    "{failure:#}"
                );
                let record = host.receipt(&current_boot.request_id).unwrap().unwrap();
                assert_eq!(record.receipt["state"], "blocked");
                assert!(record.evidence["priorBootAdoption"].is_null());
            });
    });
    crate::migration::prior_boot::with_test_boot(10, || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                // 可执行文件故意缺失；本测试只走真实准入与接管门，不启动 Core。
                let startup = storage::open_private(&directory.join("start.lock"), true).unwrap();
                startup.try_lock_exclusive().unwrap();
                let opening = host.ensure(input.clone());
                tokio::pin!(opening);
                assert!(futures_util::poll!(&mut opening).is_pending());
                assert!(
                    host.receipt(&input.request_id).unwrap().unwrap().evidence["priorBootAdoption"]
                        .is_null()
                );
                drop(startup);
                let failure = opening.await.unwrap_err();
                let record = host.receipt(&input.request_id).unwrap().unwrap();
                assert!(
                    record.evidence["priorBootAdoption"].is_object(),
                    "{failure:#}"
                );
                assert!(host.schedules.suppressed("project"));
                assert_eq!(record.evidence["scheduleActivationSuppressed"], true);
                assert_eq!(
                    std::fs::read(&original_stop_path).unwrap(),
                    original_stop_bytes
                );
                assert_eq!(
                    areal_local_service::operation(
                        &host.home,
                        &previous.identity.service_id,
                        &previous.identity.generation,
                        &original_stop.operation.request_id
                    )
                    .await
                    .unwrap()
                    .unwrap()
                    .state,
                    StopOperationState::AdmissionUnknown
                );
                assert_eq!(
                    storage::read_stop_receipt(&directory, &original_stop.operation.request_id)
                        .unwrap()
                        .unwrap()
                        .operation
                        .state,
                    StopOperationState::AcceptedPending
                );
                assert!(!directory.join("cleanup.json").exists());
                assert!(!directory.join("crash.json").exists());
                let mut stopped = previous.clone();
                stopped.state = State::Stopped;
                assert!(host.cleanup_proof(&stopped).await.is_err());
                let mut next = input.clone();
                next.request_id = uuid::Uuid::new_v4().to_string();
                // 原 ensure 启动结果未知时，即便 boot 依据充分也不能换 ID 接管。
                assert!(
                    host.ensure(next.clone())
                        .await
                        .unwrap_err()
                        .to_string()
                        .contains("admissionUnknown")
                );
                assert!(host.receipt(&next.request_id).unwrap().is_none());
                assert_eq!(
                    host.receipt(&input.request_id).unwrap().unwrap().receipt,
                    record.receipt
                );
            });
    });
}
#[test]
fn task_rejection_keeps_safe_core_code_and_definitive_outcome_on_local_wire() {
    let error: anyhow::Error = task_catalog::TaskRejection(
        json!({"code":-32009,"message":"private","data":{"outcome":{"kind":"rejected"}}}),
    )
    .into();
    assert_eq!(
        local_command_error(&error),
        json!({"code":"TASK_REJECTED","message":"Core rejected task request","coreCode":-32009,"coreError":{"code":-32009,"message":"Core rejected task request","data":{"outcome":{"kind":"rejected"}}}})
    );
}
use crate::{Client, ProjectSource};

#[tokio::test(flavor = "current_thread")]
async fn concurrent_activity_observations_do_not_make_an_idle_project_unknown() {
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let host = schedules::tests::fixture(root.path());
        let registration = host.slots.borrow()["project"].registration.clone();
        let directory = storage::registry(&host.home, &Host::service_id(&registration)).unwrap();
        storage::private_dir(&directory).unwrap();
        drop(storage::open_private(&directory.join("start.lock"), true).unwrap());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let service: Service = serde_json::from_value(json!({
            "protocolVersion":1,"serviceId":Host::service_id(&registration),
            "generation":"activity-core","workspace":registration.workspace,
            "dataDir":registration.data_dir,"configFingerprint":"fixture","owner":host.owner(),
            "endpoint":format!("ws://{}/",listener.local_addr().unwrap()),"webUrl":"",
            "authFile":directory.join("auth.json"),"logFile":directory.join("host.log"),
            "hostPid":1,"corePid":1,"state":"ready"
        })).unwrap();
        storage::write(&service.auth_file, &json!({"principals":[{"id":"owner","token":"fixture"}]})).unwrap();
        storage::write(&directory.join("service.json"), &service).unwrap();
        {
            let mut slots = host.slots.borrow_mut();
            let slot = slots.get_mut("project").unwrap();
            let (writer, lifetime) = OwnerLifetime::pair().unwrap();
            slot.writer = Some(writer);
            slot.lifetime = Some(Rc::new(lifetime));
            slot.state = "ready".into();
            slot.service = Some(service.clone());
        }
        let identity = service.identity;
        let app = axum::Router::new()
            .route("/areal/service", axum::routing::get(move || {
                let identity = identity.clone();
                async move { axum::Json(identity) }
            }))
            .route("/", axum::routing::get(|ws: axum::extract::WebSocketUpgrade| async {
                ws.on_upgrade(|mut socket| async move {
                    while let Some(Ok(axum::extract::ws::Message::Text(text))) = socket.recv().await {
                        let request: Value = serde_json::from_str(&text).unwrap();
                        if request.get("id").is_none() { continue; }
                        let result = match request["method"].as_str().unwrap() {
                            "initialize" => json!({}),
                            "areal/server/status" => json!({"activeTasks":0,"activeTurns":[],"activeGoals":[],"pendingQueueItems":0,"lifecycle":{"version":1,"ifIdle":{"allowed":true}}}),
                            method => panic!("unexpected Core request {method}"),
                        };
                        socket.send(axum::extract::ws::Message::Text(json!({"id":request["id"],"result":result}).to_string().into())).await.unwrap();
                    }
                })
            }));
        let server = tokio::task::spawn_local(async move { axum::serve(listener, app).await.unwrap() });
        let (first, second, third) = tokio::join!(host.activity(), host.activity(), async { host.status().await; host.activity().await });
        assert!(first.complete && second.complete && third.complete, "readers must not invalidate each other: {first:?} {second:?} {third:?}");
        assert_eq!(first, second);
        assert_eq!(first, third);
        assert!(matches!(first.projects[0], ProjectActivity::Observed { idle_allowed: true, .. }));
        let gate = host.gate("project").unwrap();
        let syncing = gate.write().await;
        let writer = host.slots.borrow_mut().get_mut("project").unwrap().writer.take();
        let activity = host.activity();
        tokio::pin!(activity);
        assert!(futures_util::poll!(activity.as_mut()).is_pending(), "短同步不能直接投影成 UNKNOWN");
        host.slots.borrow_mut().get_mut("project").unwrap().writer = writer;
        drop(syncing);
        assert!(activity.await.complete, "取得读锁后必须重取已结算的 owner，再核对真实 Core 活动");
        let _changing = gate.write().await;
        assert!(!host.activity().await.complete, "a lasting lifecycle change must remain unknown");
        server.abort();
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn authenticated_activity_is_read_only_and_keeps_unknown_projects_incomplete() {
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let home = base.join("home");
        let workspace = base.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let task = tokio::task::spawn_local(run_local(RunOptions { home: home.clone(), bin_dir: base.clone() }));
        let client = loop {
            if let Ok(client) = Client::connect_at(home.clone()).await { break client; }
            tokio::task::yield_now().await;
        };
        assert!(client.status().await.unwrap().capabilities.iter().any(|capability| capability == "activity"));
        assert_eq!(client.activity().await.unwrap(), Activity { complete: true, projects: vec![], total_active_tasks: 0 });
        let registration = ProjectRegistration { project_id: "cli-project".into(), workspace: workspace.clone(), data_dir: base.join("unstarted-data"), source: ProjectSource::Cli, default_binding: false };
        client.register(&uuid::Uuid::new_v4().to_string(), registration.clone()).await.unwrap();
        let directory = storage::registry(&home, &Host::service_id(&registration)).unwrap();
        assert!(!directory.exists());
        assert!(!registration.data_dir.exists());
        let idle = ProjectActivity::Observed { project_id: registration.project_id.clone(), active_tasks: 0, active_turns: 0, active_goals: 0, pending_queue_items: 0, idle_allowed: true };
        assert_eq!(client.activity().await.unwrap(), Activity { complete: true, projects: vec![idle.clone()], total_active_tasks: 0 });
        assert!(!directory.exists());
        assert!(!registration.data_dir.exists());
        storage::private_dir(&registration.data_dir).unwrap();
        let locked = storage::open_private(&registration.data_dir.join("owner.lock"), true).unwrap();
        locked.try_lock_exclusive().unwrap();
        let unavailable = Activity { complete: false, projects: vec![ProjectActivity::Unavailable { project_id: registration.project_id.clone() }], total_active_tasks: 0 };
        assert_eq!(client.activity().await.unwrap(), unavailable);
        assert!(!directory.exists());
        assert!(!registration.data_dir.join("service.lock").exists());
        drop(locked);
        storage::private_dir(&directory).unwrap();
        let service: Service = serde_json::from_value(json!({"protocolVersion":1,"serviceId":Host::service_id(&registration),"generation":uuid::Uuid::new_v4().to_string(),"workspace":workspace,"dataDir":registration.data_dir,"configFingerprint":"fixture","endpoint":"ws://127.0.0.1:1","webUrl":"http://127.0.0.1:1","authFile":directory.join("auth.json"),"logFile":directory.join("host.log"),"hostPid":1,"corePid":1,"state":"stopped"})).unwrap();
        storage::write(&directory.join("service.json"), &service).unwrap();
        let original = std::fs::read(directory.join("service.json")).unwrap();
        assert_eq!(client.activity().await.unwrap(), unavailable);
        let mut cleanup = storage::CleanupReceipt { version: 1, identity: service.identity.clone(), owner: service.owner.clone(), components: BTreeMap::new(), cleanup_confirmed: true };
        cleanup.identity.generation = "other-generation".into();
        storage::write(&directory.join("cleanup.json"), &cleanup).unwrap();
        assert_eq!(client.activity().await.unwrap(), unavailable);
        cleanup.identity = service.identity.clone();
        storage::write(&directory.join("cleanup.json"), &cleanup).unwrap();
        assert_eq!(client.activity().await.unwrap(), Activity { complete: true, projects: vec![idle], total_active_tasks: 0 });
        assert_eq!(std::fs::read(directory.join("service.json")).unwrap(), original);
        assert!(!directory.join("start.lock").exists());
        assert!(!registration.data_dir.join("service.lock").exists());
        let mut connection = BufReader::new(UnixStream::connect(&client.identity().socket_path).await.unwrap());
        let token: String = storage::read(&client.identity().auth_file).unwrap();
        wire::write(connection.get_mut(), &json!({"version":1,"id":"hello","method":"hello","params":{"protocolVersions":[1],"capabilities":["activity"],"authToken":token}})).await.unwrap();
        assert!(wire::read(&mut connection).await.unwrap().unwrap().get("result").is_some());
        wire::write(connection.get_mut(), &json!({"version":1,"id":"invalid","method":"host.activity","params":{"projectId":"cli-project"}})).await.unwrap();
        assert!(wire::read(&mut connection).await.unwrap().unwrap().get("error").is_some());
        drop(connection);
        let other = ProjectRegistration { project_id: "other-project".into(), workspace: registration.workspace.clone(), data_dir: base.join("other-data"), source: ProjectSource::Cli, default_binding: false };
        client.register(&uuid::Uuid::new_v4().to_string(), other.clone()).await.unwrap();
        assert_eq!(client.activity().await.unwrap().projects.len(), 2);
        storage::private_dir(&other.data_dir).unwrap();
        let locked = storage::open_private(&other.data_dir.join("owner.lock"), true).unwrap();
        locked.try_lock_exclusive().unwrap();
        let partial = client.activity().await.unwrap();
        assert!(!partial.complete);
        assert_eq!(partial.total_active_tasks, 0);
        assert!(matches!(&partial.projects[0], ProjectActivity::Observed { project_id, idle_allowed: true, .. } if project_id == &registration.project_id));
        assert_eq!(partial.projects[1], ProjectActivity::Unavailable { project_id: other.project_id.clone() });
        assert!(!other.data_dir.join("service.lock").exists());
        drop(locked);
        let launch_inputs = home.join("host/launch").join(storage::digest(other.project_id.as_bytes())).join("inputs.json");
        storage::private_dir(launch_inputs.parent().unwrap()).unwrap();
        storage::write(&launch_inputs, &json!({"previousActivation":true})).unwrap();
        assert_eq!(client.activity().await.unwrap(), partial);
        task.abort();
        assert!(matches!(task.await, Err(error) if error.is_cancelled()));
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn unpublished_cli_import_blocks_journal_read_prepare_and_bound_commit() {
    use std::os::fd::AsRawFd;
    let root = tempfile::tempdir().unwrap();
    let base = root.path().canonicalize().unwrap();
    let home = base.join("home");
    let core = base.join("core");
    let workspace = base.join("workspace");
    let project = "a".repeat(24);
    let data = core.join(&project).join("state");
    for path in [
        &home,
        &home.join("host/operations"),
        &home.join("host/projects"),
        &core,
        &workspace,
        &data,
    ] {
        storage::private_dir(path).unwrap();
    }
    let registration = ProjectRegistration {
        project_id: project.clone(),
        workspace: workspace.clone(),
        data_dir: data.clone(),
        source: ProjectSource::Cli,
        default_binding: true,
    };
    let journal = crate::journal::Journal::new(&home).unwrap();
    let initial = json!({"version":1,"pending":[],"outcomes":{}});
    journal.initialize(&project, initial.clone()).unwrap();
    let bytes = serde_json::to_vec(&initial).unwrap();
    let request = uuid::Uuid::new_v4().to_string();
    let prepare = json!({"requestId":request,"expectedGeneration":"generation","projectId":project,"expectedRevision":0,"sha256":storage::digest(&bytes),"byteLength":bytes.len()});
    let slot = journal
        .dispatch("journal.prepare", prepare.clone(), "connection")
        .unwrap();
    std::fs::write(slot["writePath"].as_str().unwrap(), bytes).unwrap();
    storage::write(
        &core.join("projects.json"),
        &json!([{"id":project,"root":workspace}]),
    )
    .unwrap();
    let lock = storage::open_private(&data.join("owner.lock"), true).unwrap();
    lock.try_lock_exclusive().unwrap();
    let (changes, _) = watch::channel(0);
    let mut migration = crate::migration::Migration::new(&home).unwrap();
    migration.vault = crate::vault::Vault::isolated_files(&home);
    let host = Rc::new(Host {
        home: home.clone(),
        bin: base.clone(),
        identity: HostIdentity {
            version: 1,
            host_id: uuid::Uuid::new_v4().to_string(),
            generation: "generation".into(),
            socket_path: home.join("socket"),
            auth_file: home.join("auth"),
            pid: std::process::id(),
            executable_version: "fixture".into(),
        },
        token: "fixture".into(),
        slots: RefCell::new(BTreeMap::from([(
            project.clone(),
            Slot::imported(registration),
        )])),
        stop: RefCell::new(None),
        host_stop_gate: Mutex::new(()),
        changes,
        exit: Notify::new(),
        migration: migration.into(),
        journal,
        remote: crate::remote_state::RemoteState::new(&home),
        gateway: gateway_owner::Gateway::default(),
        subscriptions: subscriptions::Subscriptions::default(),
        power: power::Power::default(),
        read_models: Default::default(),
        loopback: loopback::Loopback::default(),
        schedules: schedules::Schedules::load(&home).unwrap(),
    });
    let (socket, _peer) = std::os::unix::net::UnixStream::pair().unwrap();
    let connection = ConnectionGuard {
        host: host.clone(),
        id: "connection".into(),
        socket: socket.as_raw_fd(),
    };
    let source = json!({"profile":base.join("profile"),"coreHome":core,"legacyServiceHome":base.join("legacy")});
    assert!(
        host.client_state("gui.source", json!({"source":source}), &connection)
            .unwrap()
            .is_null()
    );
    host.client_state("gui.attachSource", json!({"source":source}), &connection)
        .unwrap();
    let result = host.client_state("gui.import",json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":"generation","source":source}),&connection).unwrap();
    assert_eq!(result["kind"], "legacyPending");
    for (method, params) in [
        ("journal.read", json!({"projectId":project})),
        ("journal.prepare", prepare),
        (
            "journal.commit",
            json!({"requestId":request,"expectedGeneration":"generation","slotId":slot["slotId"]}),
        ),
    ] {
        let error = host.client_state(method, params, &connection).unwrap_err();
        assert!(
            error.to_string().contains("migrationPending"),
            "{method}: {error:#}"
        );
    }
    drop(lock);
    let ready = host.client_state("gui.import", json!({"requestId":result["requestId"],"expectedGeneration":"generation","source":source}), &connection).unwrap();
    assert_eq!(ready["kind"], "ready");
    let original_source = host
        .client_state("gui.source", json!({"source":source}), &connection)
        .unwrap();
    assert_eq!(
        original_source["bindings"][0]["registration"]["source"]["kind"],
        "cli"
    );
    let alias = "b".repeat(24);
    let gui_registration = ProjectRegistration {
        project_id: "new-gui-project".into(),
        workspace: workspace.clone(),
        data_dir: core.join(&alias).join("state"),
        source: ProjectSource::Gui {
            profile: base.join("profile"),
            legacy_project_id: alias.clone(),
        },
        default_binding: false,
    };
    let gui_request = uuid::Uuid::new_v4().to_string();
    let registered = host
        .register(Register {
            request_id: gui_request.clone(),
            expected_generation: "generation".into(),
            registration: gui_registration.clone(),
            bind_existing: false,
        })
        .await
        .unwrap();
    assert_eq!(registered["created"], true);
    assert_eq!(
        host.register(Register {
            request_id: gui_request.clone(),
            expected_generation: "generation".into(),
            registration: gui_registration.clone(),
            bind_existing: false
        })
        .await
        .unwrap(),
        registered
    );
    assert_eq!(
        host.receipt(&gui_request).unwrap().unwrap().receipt["state"],
        "completed"
    );
    let mut alias_conflict = gui_registration.clone();
    alias_conflict.project_id = "alias-rebound".into();
    let mut path_conflict = gui_registration.clone();
    path_conflict.data_dir = base.join("incorrect-store");
    let mut unknown_source = gui_registration.clone();
    unknown_source.source = ProjectSource::Gui {
        profile: base.join("unknown-profile"),
        legacy_project_id: alias.clone(),
    };
    let mut invalid_alias = gui_registration.clone();
    invalid_alias.source = ProjectSource::Gui {
        profile: base.join("profile"),
        legacy_project_id: "../invalid".into(),
    };
    let mut imported_alias = gui_registration.clone();
    imported_alias.source = ProjectSource::Gui {
        profile: base.join("profile"),
        legacy_project_id: project.clone(),
    };
    for (registration, code) in [
        (alias_conflict, "aliasConflict"),
        (path_conflict, "invalidRequest"),
        (unknown_source, "sourceNotFound"),
        (invalid_alias, "invalidRequest"),
        (imported_alias, "aliasConflict"),
    ] {
        let error = host
            .register(Register {
                request_id: uuid::Uuid::new_v4().to_string(),
                expected_generation: "generation".into(),
                registration: registration.clone(),
                bind_existing: false,
            })
            .await
            .unwrap_err();
        assert!(error.to_string().contains(code), "{code}: {error:#}");
        assert!(
            host.register(Register {
                request_id: uuid::Uuid::new_v4().to_string(),
                expected_generation: "stale".into(),
                registration,
                bind_existing: false
            })
            .await
            .unwrap_err()
            .to_string()
            .contains("generationMismatch")
        );
    }
    assert_eq!(host.slots.borrow().len(), 2);
    let view = host
        .client_state("gui.source", json!({"source":source}), &connection)
        .unwrap();
    assert_eq!(view["bindings"].as_array().unwrap().len(), 2);
    assert_eq!(view["bindings"][0], original_source["bindings"][0]);
    assert_eq!(
        view["bindings"][1]["registration"],
        serde_json::to_value(&gui_registration).unwrap()
    );
    assert_eq!(
        view["bindings"][1]["scratchDir"],
        core.join(&alias).join("scratch").to_str().unwrap()
    );
    let persisted: ProjectRegistration =
        storage::read(&host.record_path(&gui_registration.project_id)).unwrap();
    let restarted = crate::migration::Migration::new(&home).unwrap();
    let restarted_view = restarted
        .source(
            serde_json::from_value(source.clone()).unwrap(),
            &[persisted],
        )
        .unwrap();
    assert_eq!(restarted_view, view);
    assert_eq!(
        restarted.credential_source(&gui_registration).unwrap(),
        Some(view["sourceId"].as_str().unwrap().to_owned())
    );
    let retirement_id = uuid::Uuid::new_v4().to_string();
    let retirement_params = json!({"requestId":retirement_id,"migrationId":result["requestId"],"expectedGeneration":"generation"});
    let mut stale = retirement_params.clone();
    stale["expectedGeneration"] = json!("stale-generation");
    assert!(
        host.client_state("gui.retirementPrepare", stale, &connection)
            .unwrap_err()
            .to_string()
            .contains("generationMismatch")
    );
    assert!(
        host.client_state(
            "gui.retirementStatus",
            json!({"migrationId":result["requestId"]}),
            &connection
        )
        .unwrap()
        .is_null()
    );
    let retirement = host
        .client_state("gui.retirementPrepare", retirement_params, &connection)
        .unwrap();
    assert_eq!(retirement["state"], "completed");
    let confirm = json!({"requestId":retirement_id,"migrationId":result["requestId"],"planId":retirement["planId"],"expectedGeneration":"generation"});
    assert_eq!(
        host.client_state("gui.retirementConfirm", confirm.clone(), &connection)
            .unwrap(),
        retirement
    );
    let mut stale = confirm;
    stale["expectedGeneration"] = json!("stale-generation");
    assert!(
        host.client_state("gui.retirementConfirm", stale, &connection)
            .unwrap_err()
            .to_string()
            .contains("generationMismatch")
    );
    assert_eq!(
        host.client_operation(&retirement_id).unwrap().unwrap()["method"],
        "gui.retirementPrepare"
    );
    let vault_slot =
        json!({"kind":"subscriptionTransport","sourceId":ready["receipt"]["sourceId"]});
    assert_eq!(
        host.client_state("vault.read", json!({"slot":vault_slot}), &connection)
            .unwrap(),
        json!({"revision":0,"value":null})
    );
    let vault_id = uuid::Uuid::new_v4().to_string();
    let receipt = host.client_state("vault.replace",json!({"requestId":vault_id,"expectedGeneration":"generation","slot":vault_slot,"expectedRevision":0,"value":{"token":"isolated-dummy","port":1234}}),&connection).unwrap();
    assert_eq!(receipt["state"], "completed");
    assert_eq!(host.client_operation(&vault_id).unwrap().unwrap(), receipt);
    assert!(
        host.client_state(
            "remote.replace",
            json!({"requestId":vault_id,"expectedGeneration":"generation"}),
            &connection
        )
        .unwrap_err()
        .to_string()
        .contains("requestConflict")
    );
    assert!(host.client_state("vault.replace",json!({"requestId":result["requestId"],"expectedGeneration":"generation","slot":vault_slot,"expectedRevision":1,"value":null}),&connection).unwrap_err().to_string().contains("requestConflict"));
    let reference = "AREAL_CREDENTIAL_key";
    let credential_slot = json!({"kind":"providerCredential","sourceId":ready["receipt"]["sourceId"],"reference":reference});
    host.client_state("vault.replace",json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":"generation","slot":credential_slot,"expectedRevision":0,"value":"vault-secret"}),&connection).unwrap();
    let config_home = base.join("config");
    storage::private_dir(&config_home).unwrap();
    for name in [
        "areal",
        "areal-runtime",
        "areal-runtime-fs",
        "areal-runtime-reaper",
    ] {
        std::fs::write(base.join(name), "fixture").unwrap();
    }
    let input = Ensure {
        request_id: uuid::Uuid::new_v4().to_string(),
        expected_generation: "generation".into(),
        project_id: project.clone(),
        no_auto_restart: false,
        resume_scheduling: false,
        launch_inputs: Some(LaunchInputs {
            workspace: workspace.clone(),
            cwd: workspace,
            config_home,
            homedir: Some(base.join("isolated-home")),
            config_path: None,
            deployment_path: None,
            schedule_preparation: None,
            environment: BTreeMap::new(),
            credential_names: vec![reference.into(), "OPENAI_API_KEY".into()],
            options: areal_local_service::LocalArgs {
                model: Some("fixture".into()),
                model_endpoint: Some("http://127.0.0.1:1/v1/chat/completions".into()),
                api_key_env: Some(reference.into()),
                ..Default::default()
            },
        }),
        credentials: BTreeMap::from([
            (reference.into(), "stale-client-secret".into()),
            ("OPENAI_API_KEY".into(), "run-scoped-secret".into()),
        ]),
    };
    let cli_id = "independent-cli".to_owned();
    let cli_registration = ProjectRegistration {
        project_id: cli_id.clone(),
        workspace: input.launch_inputs.as_ref().unwrap().workspace.clone(),
        data_dir: base.join("independent-state"),
        source: ProjectSource::Cli,
        default_binding: false,
    };
    storage::private_dir(&cli_registration.data_dir).unwrap();
    host.slots
        .borrow_mut()
        .insert(cli_id.clone(), Slot::imported(cli_registration.clone()));
    std::fs::write(home.join("config.toml"), "schema_version=2\n[model]\nname='fixture'\n[model.providers.default]\nendpoint='http://127.0.0.1:1/v1/chat/completions'\napi_key_env='AREAL_CREDENTIAL_key'\n").unwrap();
    let mut saved = input.launch_inputs.clone().unwrap();
    saved.config_home = home.clone();
    saved.credential_names.clear();
    let saved_path = home
        .join("host/launch")
        .join(storage::digest(cli_id.as_bytes()))
        .join("inputs.json");
    storage::private_dir(saved_path.parent().unwrap()).unwrap();
    storage::write(&saved_path, &saved).unwrap();
    let cli_input = Ensure {
        project_id: cli_id.clone(),
        launch_inputs: None,
        credentials: BTreeMap::new(),
        ..input.clone()
    };
    let failure = host.ensure_inner(&cli_input).await.unwrap_err();
    assert!(
        failure.to_string().contains("missing activation receipt"),
        "{failure:#}"
    );
    assert!(host.project_uses_shared_config(&cli_registration));
    assert_eq!(
        host.slots.borrow()[&cli_id].credentials[reference],
        "vault-secret"
    );
    let custom = base.join("custom.toml");
    std::fs::copy(home.join("config.toml"), &custom).unwrap();
    saved.config_path = Some(custom.clone());
    saved.options.config = Some(custom);
    storage::write(&saved_path, &saved).unwrap();
    assert!(!host.project_uses_shared_config(&cli_registration));
    let _ = host.ensure_inner(&cli_input).await.unwrap_err();
    assert!(!host.project_uses_shared_config(&cli_registration));
    assert!(
        !host.slots.borrow()[&cli_id]
            .credentials
            .contains_key(reference)
    );
    let first = host.ensure_inner(&input).await.unwrap_err();
    assert!(
        first.to_string().contains("missing activation receipt"),
        "{first:#}"
    );
    assert_eq!(
        host.slots.borrow()[&project].credentials[reference],
        "vault-secret"
    );
    let gui_input = Ensure {
        project_id: gui_registration.project_id.clone(),
        ..input.clone()
    };
    let gui_error = host.ensure_inner(&gui_input).await.unwrap_err();
    assert!(
        gui_error.to_string().contains("missing activation receipt"),
        "{gui_error:#}"
    );
    assert_eq!(
        host.slots.borrow()[&gui_registration.project_id].credentials[reference],
        "vault-secret"
    );
    host.client_state("vault.replace",json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":"generation","slot":credential_slot,"expectedRevision":1,"value":null}),&connection).unwrap();
    assert!(
        host.ensure_inner(&gui_input)
            .await
            .unwrap_err()
            .to_string()
            .contains("missing activation receipt")
    );
    assert!(
        !host.slots.borrow()[&gui_registration.project_id]
            .credentials
            .contains_key(reference)
    );
    assert!(
        host.ensure_inner(&input)
            .await
            .unwrap_err()
            .to_string()
            .contains("missing activation receipt")
    );
    assert!(
        !host.slots.borrow()[&project]
            .credentials
            .contains_key(reference),
        "revoked secret must be removed from the same Host cache"
    );
    assert_eq!(
        host.slots.borrow()[&project].credentials["OPENAI_API_KEY"],
        "run-scoped-secret"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn activation_preserves_status_errors_without_attempting_launch() {
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let home = root.join("home");
        let workspace = root.join("workspace");
        let bin = root.join("bin");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::create_dir(&bin).unwrap();
        for name in ["areal", "areal-runtime", "areal-runtime-fs", "areal-runtime-reaper"] {
            std::fs::write(bin.join(name), "not executable").unwrap();
        }
        let task = tokio::task::spawn_local(run_local(RunOptions { home: home.clone(), bin_dir: bin }));
        let client = loop {
            if let Ok(client) = Client::connect_at(home.clone()).await { break client; }
            tokio::task::yield_now().await;
        };
        let registration = ProjectRegistration { project_id: "status-error".into(), workspace: workspace.clone(), data_dir: root.join("data"), source: ProjectSource::Cli, default_binding: false };
        client.register(&uuid::Uuid::new_v4().to_string(), registration.clone()).await.unwrap();
        let instance = Host::service_id(&registration);
        let directory = storage::registry(&home, &instance).unwrap();
        storage::private_dir(&directory).unwrap();
        let service: Service = serde_json::from_value(json!({"protocolVersion":0,"serviceId":instance,"generation":uuid::Uuid::new_v4().to_string(),"workspace":workspace,"dataDir":registration.data_dir,"configFingerprint":"fixture","endpoint":"ws://127.0.0.1:1","webUrl":"http://127.0.0.1:1","authFile":directory.join("auth.json"),"logFile":directory.join("host.log"),"hostPid":1,"corePid":1,"state":"ready"})).unwrap();
        storage::write(&directory.join("service.json"), &service).unwrap();
        let inputs = LaunchInputs { config_home: home.clone(), workspace: workspace.clone(), cwd: workspace, homedir: None, config_path: None, deployment_path: None, schedule_preparation: None, environment: BTreeMap::new(), credential_names: vec![], options: Default::default() };
        let request = uuid::Uuid::new_v4().to_string();
        let error = client.ensure(&request, &registration.project_id, Some(inputs), BTreeMap::new()).await.unwrap_err();
        assert!(format!("{error:#}").contains("cannot inspect existing service"), "{error:#}");
        assert!(format!("{error:#}").contains("invalid service record"), "{error:#}");
        assert_eq!(client.operation(&request).await.unwrap().unwrap()["state"], "blocked");
        assert_eq!(storage::read::<Service>(&directory.join("service.json")).unwrap().identity, service.identity);
        assert!(!directory.join("launch.json").exists());
        task.abort();
        assert!(matches!(task.await, Err(error) if error.is_cancelled()));
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn authenticated_registry_receipts_survive_restart_without_activation() {
    tokio::task::LocalSet::new().run_until(async {
        let root=tempfile::tempdir().unwrap();let home=root.path().join("home");let workspace=root.path().join("workspace");std::fs::create_dir(&workspace).unwrap();
        let bin=std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
        let task=tokio::task::spawn_local(run_local(RunOptions {home:home.clone(),bin_dir:bin.clone()}));
        let client=loop {if let Ok(client)=Client::connect_at(home.clone()).await {break client;}tokio::task::yield_now().await;};
        let run_record=std::fs::read(home.join("host/service-run.json")).unwrap();
        assert!(matches!(run_local(RunOptions {home:home.clone(),bin_dir:bin.clone()}).await.unwrap(),HostExit::AlreadyRunning));
        assert!(matches!(run_local_mode(RunOptions {home:home.clone(),bin_dir:bin.clone()},true).await.unwrap(),HostExit::AlreadyRunning));
        assert_eq!(std::fs::read(home.join("host/service-run.json")).unwrap(),run_record);
        let identity=client.identity().clone();assert!(client.status().await.unwrap().projects.is_empty());
        let mut bad=BufReader::new(UnixStream::connect(&identity.socket_path).await.unwrap());
        wire::write(bad.get_mut(),&json!({"version":1,"id":"bad","method":"hello","params":{"protocolVersions":[1],"capabilities":[],"authToken":"wrong"}})).await.unwrap();
        assert!(wire::read(&mut bad).await.unwrap().is_none());
        let mut subscription=client.subscribe().await.unwrap();
        let id=uuid::Uuid::new_v4().to_string();let registration=ProjectRegistration {project_id:"test-project".into(),workspace:workspace.canonicalize().unwrap(),data_dir:storage::canonical_pending(&root.path().join("data")).unwrap(),source:ProjectSource::Cli,default_binding:true};
        assert_eq!(client.register(&id,registration.clone()).await.unwrap(),registration);
        let journal_record = home.join("host/journals/records").join(format!("{}.json", storage::digest(registration.project_id.as_bytes())));
        assert!(!journal_record.exists());
        assert!(crate::operation_offline(&home, &uuid::Uuid::new_v4().to_string()).unwrap().is_none());
        assert!(!journal_record.exists());
        let mut journal_connection = BufReader::new(UnixStream::connect(&identity.socket_path).await.unwrap());
        let auth: String = storage::read(&identity.auth_file).unwrap();
        wire::write(journal_connection.get_mut(), &json!({"version":1,"id":"hello-journal","method":"hello","params":{"protocolVersions":[1],"capabilities":["submissionJournal"],"authToken":auth}})).await.unwrap();
        assert!(wire::read(&mut journal_connection).await.unwrap().unwrap().get("result").is_some());
        wire::write(journal_connection.get_mut(), &json!({"version":1,"id":"missing-journal","method":"journal.read","params":{"projectId":"missing"}})).await.unwrap();
        assert_eq!(wire::read(&mut journal_connection).await.unwrap().unwrap()["error"]["code"], "projectNotFound");
        for (method, params) in [
            ("journal.read", json!({"projectId":registration.project_id,"unexpected":true})),
            ("journal.prepare", json!({"projectId":registration.project_id,"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":identity.generation})),
            ("journal.prepare", json!({"projectId":registration.project_id,"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":identity.generation,"expectedRevision":0,"sha256":"invalid","byteLength":1})),
        ] {
            wire::write(journal_connection.get_mut(), &json!({"version":1,"id":"invalid-journal","method":method,"params":params})).await.unwrap();
            assert!(wire::read(&mut journal_connection).await.unwrap().unwrap().get("error").is_some());
            assert!(!journal_record.exists(), "invalid journal request must not initialize storage");
        }
        wire::write(journal_connection.get_mut(), &json!({"version":1,"id":"read-journal","method":"journal.read","params":{"projectId":registration.project_id}})).await.unwrap();
        let read = wire::read(&mut journal_connection).await.unwrap().unwrap();
        assert_eq!(read["result"]["revision"], 0);
        let snapshot: Value = storage::read(PathBuf::from(read["result"]["snapshotPath"].as_str().unwrap()).as_path()).unwrap();
        assert_eq!(snapshot, json!({"version":1,"pending":[],"outcomes":{}}));
        let prepare_request = uuid::Uuid::new_v4().to_string();
        let snapshot_bytes = serde_json::to_vec(&snapshot).unwrap();
        wire::write(journal_connection.get_mut(), &json!({"version":1,"id":"prepare-journal","method":"journal.prepare","params":{"requestId":prepare_request,"expectedGeneration":identity.generation,"projectId":registration.project_id,"expectedRevision":0,"sha256":storage::digest(&snapshot_bytes),"byteLength":snapshot_bytes.len()}})).await.unwrap();
        assert!(wire::read(&mut journal_connection).await.unwrap().unwrap()["result"]["slotId"].is_string());
        assert!(journal_record.exists());
        drop(journal_connection);
        assert_eq!(client.register(&id,registration.clone()).await.unwrap(),registration);
        let mut changed=registration.clone();changed.data_dir=root.path().join("different");assert!(format!("{:#}",client.register(&id,changed).await.unwrap_err()).contains("requestConflict"));
        let event=tokio::time::timeout(Duration::from_secs(3),subscription.next()).await.unwrap().unwrap().unwrap();assert_eq!(event["method"],"host.statusChanged");assert_eq!(event["params"]["sequence"],1);
        let path=wire::operation_path(&home,&id);let mut interrupted:Operation=storage::read(&path).unwrap();interrupted.receipt["state"]=json!("acceptedPending");interrupted.receipt.as_object_mut().unwrap().remove("result");storage::write(&path,&interrupted).unwrap();
        let receipt=client.operation(&id).await.unwrap().unwrap();assert_eq!(receipt["state"],"completed");assert_eq!(client.status().await.unwrap().projects[0].state,"stopped");
        assert!(client.reconnect("test-project").await.is_err());
        let mut nondefault=registration.clone();nondefault.default_binding=false;client.register(&uuid::Uuid::new_v4().to_string(),nondefault).await.unwrap();
        client.bind_registration(&uuid::Uuid::new_v4().to_string(),registration.clone()).await.unwrap();
        assert!(client.list().await.unwrap()[0].default_binding);
        let mapping=home.join("workspaces").join(format!("{}.json",storage::digest(registration.workspace.as_os_str().as_encoded_bytes())));assert_eq!(storage::read::<PathBuf>(&mapping).unwrap(),registration.data_dir);

        let stop_id=uuid::Uuid::new_v4().to_string();let stop=client.stop(&stop_id,&identity.generation,StopStrategy::IfIdle).await.unwrap();assert_eq!(stop["state"],"completed");assert!(matches!(task.await.unwrap().unwrap(),HostExit::Stopped));
        assert!(!home.join("host/host.json").exists());
        let stopped_record=std::fs::read(home.join("host/stop.json")).unwrap();
        match run_local_mode(RunOptions {home:home.clone(),bin_dir:bin.clone()},true).await.unwrap() {
            HostExit::Stopped => {},
            HostExit::AlreadyRunning => panic!("stopped Host retained its exclusive lock"),
        }
        assert!(!home.join("host/host.json").exists());
        assert_eq!(std::fs::read(home.join("host/stop.json")).unwrap(),stopped_record);
        let offline=crate::offline_service_status(&home).unwrap();
        assert_eq!(offline["state"],"stopped");
        assert_eq!(offline["stopIntent"],true);
        assert_eq!(storage::read::<String>(&home.join("host/identity.json")).unwrap(),identity.host_id);
        assert_eq!(crate::operation_offline(&home,&id).unwrap().unwrap(),receipt);
        let restarted=tokio::task::spawn_local(run_local(RunOptions {home:home.clone(),bin_dir:bin}));
        let next=loop {if let Ok(client)=Client::connect_at(home.clone()).await {break client;}tokio::task::yield_now().await;};
        assert_eq!(next.identity().host_id,identity.host_id);assert_ne!(next.identity().generation,identity.generation);assert_eq!(next.list().await.unwrap(),vec![registration]);assert_eq!(next.operation(&id).await.unwrap().unwrap(),receipt);assert_eq!(next.operation(&stop_id).await.unwrap().unwrap()["state"],"completed");assert_eq!(next.status().await.unwrap().state,"running");
        next.stop(&uuid::Uuid::new_v4().to_string(),&next.identity().generation,StopStrategy::IfIdle).await.unwrap();restarted.await.unwrap().unwrap();
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn interrupted_activation_requires_evidence_and_blocks_new_stop_ids() {
    tokio::task::LocalSet::new().run_until(async {
        let root=tempfile::tempdir().unwrap();let home=root.path().canonicalize().unwrap().join("home");let workspace=root.path().join("workspace");std::fs::create_dir(&workspace).unwrap();
        let task=tokio::task::spawn_local(run_local(RunOptions {home:home.clone(),bin_dir:std::env::current_exe().unwrap().parent().unwrap().into()}));
        let client=loop {if let Ok(client)=Client::connect_at(home.clone()).await {break client;}tokio::task::yield_now().await;};
        let registration=ProjectRegistration {project_id:"interrupted".into(),workspace:workspace.canonicalize().unwrap(),data_dir:home.join("data"),source:ProjectSource::Cli,default_binding:false};
        client.register(&uuid::Uuid::new_v4().to_string(),registration.clone()).await.unwrap();
        let request=uuid::Uuid::new_v4().to_string();let instance=Host::service_id(&registration);let owner=Owner::Host {host_id:client.identity().host_id.clone(),generation:uuid::Uuid::new_v4().to_string()};
        let record=Operation {digest:"fixture".into(),receipt:json!({"version":1,"requestId":request,"method":"project.ensure","hostId":client.identity().host_id,"generation":client.identity().generation,"projectId":registration.project_id,"state":"acceptedPending"}),evidence:json!({"serviceId":instance,"fingerprint":"fixture","owner":owner,"registration":registration,"previousService":null})};storage::write(&wire::operation_path(&home,&request),&record).unwrap();
        assert_eq!(client.operation(&request).await.unwrap().unwrap()["state"],"acceptedPending");
        let new_stop=uuid::Uuid::new_v4().to_string();let error=client.stop_project(&new_stop,&registration.project_id,"old",StopStrategy::Cancel).await.unwrap_err();assert!(format!("{error:#}").contains("admissionUnknown"));assert!(client.operation(&new_stop).await.unwrap().is_none());
        let new_host_stop=uuid::Uuid::new_v4().to_string();assert!(client.stop(&new_host_stop,&client.identity().generation,StopStrategy::Cancel).await.is_err());assert!(client.operation(&new_host_stop).await.unwrap().is_none());
        let directory=storage::registry(&home,&instance).unwrap();storage::private_dir(&directory).unwrap();storage::private_dir(&registration.data_dir).unwrap();
        let service:Service=serde_json::from_value(json!({"protocolVersion":1,"serviceId":instance,"generation":uuid::Uuid::new_v4().to_string(),"workspace":registration.workspace,"dataDir":registration.data_dir,"configFingerprint":"fixture","owner":owner,"endpoint":"http://127.0.0.1:1","webUrl":"http://127.0.0.1:1","authFile":directory.join("auth.json"),"logFile":directory.join("host.log"),"hostPid":1,"corePid":1,"state":"stopped"})).unwrap();storage::write(&directory.join("service.json"),&service).unwrap();storage::write(&directory.join("crash.json"),&storage::CrashReceipt {version:1,unexpected_core_exit:true,identity:service.identity.clone(),owner:service.owner.clone(),components:BTreeMap::new(),cleanup_confirmed:true}).unwrap();
        let mut interrupted:Operation=storage::read(&wire::operation_path(&home,&request)).unwrap();interrupted.evidence["previousService"]=serde_json::to_value(&service).unwrap();storage::write(&wire::operation_path(&home,&request),&interrupted).unwrap();
        assert_eq!(client.operation(&request).await.unwrap().unwrap()["state"],"acceptedPending");
        let mut successor=service.clone();successor.identity.generation=uuid::Uuid::new_v4().to_string();storage::write(&directory.join("service.json"),&successor).unwrap();storage::write(&directory.join("crash.json"),&storage::CrashReceipt {version:1,unexpected_core_exit:true,identity:successor.identity.clone(),owner:successor.owner.clone(),components:BTreeMap::new(),cleanup_confirmed:true}).unwrap();
        assert_eq!(client.operation(&request).await.unwrap().unwrap()["state"],"blocked");
        let stop=client.stop(&uuid::Uuid::new_v4().to_string(),&client.identity().generation,StopStrategy::IfIdle).await.unwrap();assert_eq!(stop["state"],"completed");assert!(matches!(task.await.unwrap().unwrap(),HostExit::Stopped));
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn interrupted_activation_reconciles_alongside_status_readers() {
    let root = tempfile::tempdir().unwrap();
    let host = schedules::tests::fixture(root.path());
    let registration = host.slots.borrow()["project"].registration.clone();
    storage::private_dir(&registration.data_dir).unwrap();
    let instance = Host::service_id(&registration);
    let directory = storage::registry(&host.home, &instance).unwrap();
    storage::private_dir(&directory).unwrap();
    let previous: Service = serde_json::from_value(json!({
        "protocolVersion":1,"serviceId":instance,"generation":"original-generation",
        "workspace":registration.workspace,"dataDir":registration.data_dir,
        "configFingerprint":"original-config","owner":host.owner(),
        "endpoint":"http://127.0.0.1:1","webUrl":"http://127.0.0.1:1",
        "authFile":directory.join("auth.json"),"logFile":directory.join("host.log"),
        "hostPid":1,"corePid":1,"state":"ready"
    }))
    .unwrap();
    let mut stopped = previous.clone();
    stopped.state = State::Stopped;
    storage::write(&directory.join("service.json"), &stopped).unwrap();
    storage::write(
        &directory.join("crash.json"),
        &storage::CrashReceipt {
            version: 1,
            unexpected_core_exit: true,
            identity: stopped.identity.clone(),
            owner: stopped.owner.clone(),
            components: BTreeMap::new(),
            cleanup_confirmed: true,
        },
    )
    .unwrap();
    for fingerprint in ["original-config", "replacement-config"] {
        let request = uuid::Uuid::new_v4().to_string();
        let record = Operation {
            digest: "fixture".into(),
            receipt: json!({"requestId":request,"method":"project.ensure","projectId":"project","state":"acceptedPending"}),
            evidence: json!({"serviceId":instance,"fingerprint":fingerprint,"owner":host.owner(),"registration":registration,"previousService":previous}),
        };
        storage::write(&wire::operation_path(&host.home, &request), &record).unwrap();
        let gate = host.gate("project").unwrap();
        // 状态读者不改变生命周期，也不能阻止已有精确清理证明的回执结算。
        let reading = gate.read().await;
        let receipt = host.reconcile(&request).await.unwrap().unwrap();
        assert_eq!(receipt["state"], "blocked", "{fingerprint}");
        assert_eq!(receipt["error"]["code"], "activationInterrupted");
        drop(reading);
        storage::write(&wire::operation_path(&host.home, &request), &record).unwrap();
        let _changing = gate.write().await;
        assert_eq!(
            host.reconcile(&request).await.unwrap().unwrap()["state"],
            "acceptedPending"
        );
    }
}

#[tokio::test(flavor = "current_thread")]
async fn interrupted_ready_activation_settles_only_after_exact_cleanup_and_lock_release() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let mut settled = Vec::new();
            for fingerprint in ["original-config", "replacement-config"] {
                let root = tempfile::tempdir().unwrap();
                let home = root.path().canonicalize().unwrap().join("home");
                let workspace = root.path().join("workspace");
                std::fs::create_dir(&workspace).unwrap();
                let task = tokio::task::spawn_local(run_local(RunOptions {
                    home: home.clone(),
                    bin_dir: std::env::current_exe().unwrap().parent().unwrap().into(),
                }));
                let client = loop {
                    if let Ok(client) = Client::connect_at(home.clone()).await {
                        break client;
                    }
                    tokio::task::yield_now().await;
                };
                let registration = ProjectRegistration {
                    project_id: "interrupted-ready".into(),
                    workspace: workspace.canonicalize().unwrap(),
                    data_dir: home.join("data"),
                    source: ProjectSource::Cli,
                    default_binding: false,
                };
                client
                    .register(&uuid::Uuid::new_v4().to_string(), registration.clone())
                    .await
                    .unwrap();
                let instance = Host::service_id(&registration);
                let directory = storage::registry(&home, &instance).unwrap();
                storage::private_dir(&directory).unwrap();
                storage::private_dir(&registration.data_dir).unwrap();
                let owner = Owner::Host {
                    host_id: client.identity().host_id.clone(),
                    generation: uuid::Uuid::new_v4().to_string(),
                };
                let previous: Service = serde_json::from_value(json!({
                    "protocolVersion": 1,
                    "serviceId": instance,
                    "generation": uuid::Uuid::new_v4().to_string(),
                    "workspace": registration.workspace,
                    "dataDir": registration.data_dir,
                    "configFingerprint": "original-config",
                    "owner": owner,
                    "endpoint": "http://127.0.0.1:1",
                    "webUrl": "http://127.0.0.1:1",
                    "authFile": directory.join("auth.json"),
                    "logFile": directory.join("host.log"),
                    "hostPid": 1,
                    "corePid": 1,
                    "state": "ready"
                }))
                .unwrap();
                let mut stopped = previous.clone();
                stopped.state = State::Stopped;
                storage::write(&directory.join("service.json"), &stopped).unwrap();
                let request = uuid::Uuid::new_v4().to_string();
                let record = Operation {
                    digest: "fixture".into(),
                    receipt: json!({
                        "version": 1,
                        "requestId": request,
                        "method": "project.ensure",
                        "hostId": client.identity().host_id,
                        "generation": client.identity().generation,
                        "projectId": registration.project_id,
                        "state": "acceptedPending"
                    }),
                    evidence: json!({
                        "serviceId": instance,
                        "fingerprint": fingerprint,
                        "owner": owner,
                        "registration": registration,
                        "previousService": previous
                    }),
                };
                storage::write(&wire::operation_path(&home, &request), &record).unwrap();
                assert_eq!(
                    client.operation(&request).await.unwrap().unwrap()["state"],
                    "acceptedPending"
                );

                let mut proof = storage::CrashReceipt {
                    version: 1,
                    unexpected_core_exit: true,
                    identity: stopped.identity.clone(),
                    owner: stopped.owner.clone(),
                    components: BTreeMap::new(),
                    cleanup_confirmed: true,
                };
                proof.identity.generation = uuid::Uuid::new_v4().to_string();
                storage::write(&directory.join("crash.json"), &proof).unwrap();
                assert_eq!(
                    client.operation(&request).await.unwrap().unwrap()["state"],
                    "acceptedPending"
                );
                proof.identity = stopped.identity.clone();
                storage::write(&directory.join("crash.json"), &proof).unwrap();
                for lock in ["service.lock", "owner.lock"] {
                    let held =
                        storage::open_private(&registration.data_dir.join(lock), true).unwrap();
                    held.try_lock_exclusive().unwrap();
                    assert_eq!(
                        client.operation(&request).await.unwrap().unwrap()["state"],
                        "acceptedPending",
                        "{fingerprint} with {lock} held"
                    );
                    drop(held);
                }

                let receipt = client.operation(&request).await.unwrap().unwrap();
                settled.push((
                    fingerprint,
                    receipt["state"].clone(),
                    receipt["error"]["code"].clone(),
                ));
                assert_eq!(client.operation(&request).await.unwrap().unwrap(), receipt);
                assert_eq!(
                    storage::read::<Value>(&directory.join("service.json")).unwrap(),
                    serde_json::to_value(&stopped).unwrap()
                );
                assert!(!directory.join("launch.json").exists());
                task.abort();
                assert!(matches!(task.await, Err(error) if error.is_cancelled()));
            }
            assert_eq!(
                settled,
                vec![
                    (
                        "original-config",
                        json!("blocked"),
                        json!("activationInterrupted")
                    ),
                    (
                        "replacement-config",
                        json!("blocked"),
                        json!("activationInterrupted")
                    ),
                ]
            );
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn host_stop_waits_for_live_activation_before_classifying_pending_admission() {
    tokio::task::LocalSet::new().run_until(async {
        let root=tempfile::tempdir().unwrap();let home=root.path().canonicalize().unwrap().join("home");
        for path in [&home,&home.join("host/operations"),&home.join("host/projects")] {storage::private_dir(path).unwrap();}
        let mut slots=BTreeMap::new();
        slots.insert("project".into(),Slot {registration:ProjectRegistration {project_id:"project".into(),workspace:root.path().into(),data_dir:home.join("data"),source:ProjectSource::Cli,default_binding:false},gate: Arc::new(RwLock::new(())),writer:None,uncertain_start:false,lifetime:None,state:"stopped".into(),service:None,migration:None,credentials:BTreeMap::new(),imported_credentials:BTreeSet::new()});
        let (changes,_)=watch::channel(0);let host=Rc::new(Host {home:home.clone(),bin:root.path().into(),identity:HostIdentity {version:1,host_id:uuid::Uuid::new_v4().to_string(),generation:uuid::Uuid::new_v4().to_string(),socket_path:home.join("control.sock"),auth_file:home.join("auth.json"),pid:std::process::id(),executable_version:"fixture".into()},token:"fixture".into(),slots:RefCell::new(slots),stop:RefCell::new(None),host_stop_gate:Mutex::new(()),changes,exit:Notify::new(),migration:crate::migration::Migration::new(&home).unwrap().into(),gateway:gateway_owner::Gateway::default(),subscriptions:subscriptions::Subscriptions::default(),power:power::Power::default(), read_models: Default::default(),loopback:loopback::Loopback::default(),journal:crate::journal::Journal::new(&home).unwrap(),remote:crate::remote_state::RemoteState::new(&home),schedules:schedules::Schedules::load(&home).unwrap()});
        let activation=uuid::Uuid::new_v4().to_string();
        let mut record=Operation {digest:"fixture".into(),receipt:json!({"requestId":activation,"method":"project.ensure","projectId":"project","state":"acceptedPending"}),evidence:Value::Null};
        storage::write(&wire::operation_path(&home,&activation),&record).unwrap();
        let held=host.gate("project").unwrap().write_owned().await;
        let request=uuid::Uuid::new_v4().to_string();
        let stopping=host.stop_host(Stop {suppress_scheduling:true,request_id:request.clone(),expected_generation:host.identity.generation.clone(),strategy:StopStrategy::IfIdle,project_id:None,service_generation:None});
        tokio::pin!(stopping);
        assert!(futures_util::poll!(&mut stopping).is_pending(), "live activation must settle before stop admission is classified");
        assert!(host.receipt(&request).unwrap().is_none());
        record.receipt["state"]=json!("blocked");
        storage::write(&wire::operation_path(&home,&activation),&record).unwrap();
        drop(held);
        assert_eq!(stopping.await.unwrap()["state"],"completed");
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn stop_barrier_closes_pre_admission_awaits_and_reconciliation_observes_busy_slots() {
    tokio::task::LocalSet::new().run_until(async {
        let root=tempfile::tempdir().unwrap();let home=root.path().canonicalize().unwrap().join("home");
        for path in [&home,&home.join("host/operations"),&home.join("host/projects")] {storage::private_dir(path).unwrap();}
        let workspace=root.path().join("workspace");std::fs::create_dir(&workspace).unwrap();let workspace=workspace.canonicalize().unwrap();
        let mut slots=BTreeMap::new();
        for id in ["a","b","c"] {slots.insert(id.into(),Slot {registration:ProjectRegistration {project_id:id.into(),workspace:workspace.clone(),data_dir:home.join(id),source:ProjectSource::Cli,default_binding:false},gate: Arc::new(RwLock::new(())),writer:None,uncertain_start:false,lifetime:None,state:"stopped".into(),service:None,migration:None,credentials:BTreeMap::new(),imported_credentials:BTreeSet::new()});}
        let (changes,_)=watch::channel(0);let host=Rc::new(Host {home:home.clone(),bin:root.path().into(),identity:HostIdentity {version:1,host_id:uuid::Uuid::new_v4().to_string(),generation:uuid::Uuid::new_v4().to_string(),socket_path:home.join("control.sock"),auth_file:home.join("auth.json"),pid:std::process::id(),executable_version:"fixture".into()},token:"fixture".into(),slots:RefCell::new(slots),stop:RefCell::new(None),host_stop_gate:Mutex::new(()),changes,exit:Notify::new(),migration:crate::migration::Migration::new(&home).unwrap().into(),gateway:gateway_owner::Gateway::default(),subscriptions:subscriptions::Subscriptions::default(),power:power::Power::default(), read_models: Default::default(),loopback:loopback::Loopback::default(),journal:crate::journal::Journal::new(&home).unwrap(),remote:crate::remote_state::RemoteState::new(&home),schedules:schedules::Schedules::load(&home).unwrap()});
        let registration=host.slots.borrow()["b"].registration.clone();storage::private_dir(&registration.data_dir).unwrap();let instance=Host::service_id(&registration);let directory=storage::registry(&home,&instance).unwrap();storage::private_dir(&directory).unwrap();
        let service:Service=serde_json::from_value(json!({"protocolVersion":1,"serviceId":instance,"generation":uuid::Uuid::new_v4().to_string(),"workspace":workspace,"dataDir":registration.data_dir,"configFingerprint":"fixture","owner":host.owner(),"endpoint":"http://127.0.0.1:1","webUrl":"http://127.0.0.1:1","authFile":directory.join("auth.json"),"logFile":directory.join("host.log"),"hostPid":1,"corePid":1,"state":"stopped"})).unwrap();storage::write(&directory.join("service.json"),&service).unwrap();storage::write(&directory.join("crash.json"),&storage::CrashReceipt {version:1,unexpected_core_exit:true,identity:service.identity.clone(),owner:service.owner.clone(),components:BTreeMap::new(),cleanup_confirmed:true}).unwrap();
        let activation=uuid::Uuid::new_v4().to_string();let record=Operation {digest:"fixture".into(),receipt:json!({"version":1,"requestId":activation,"method":"project.ensure","projectId":"b","state":"acceptedPending"}),evidence:json!({"serviceId":instance,"fingerprint":"fixture","owner":host.owner(),"registration":registration,"previousService":null})};storage::write(&wire::operation_path(&home,&activation),&record).unwrap();
        let held_b=host.gate("b").unwrap().write_owned().await;
        assert_eq!(host.reconcile(&activation).await.unwrap().unwrap()["state"],"acceptedPending");assert_eq!(host.receipt(&activation).unwrap().unwrap().receipt["state"],"acceptedPending");drop(held_b);
        assert_eq!(host.reconcile(&activation).await.unwrap().unwrap()["state"],"blocked");
        let held_a=host.gate("a").unwrap().write_owned().await;let startup=storage::open_private(&directory.join("start.lock"),true).unwrap();startup.try_lock_exclusive().unwrap();
        let project_request=uuid::Uuid::new_v4().to_string();let project_host=host.clone();let project_input=Stop {suppress_scheduling:true,request_id:project_request.clone(),expected_generation:host.identity.generation.clone(),strategy:StopStrategy::Cancel,project_id:Some("b".into()),service_generation:Some(service.identity.generation.clone())};
        let stopping_project=tokio::task::spawn_local(async move {project_host.stop_project(project_input).await});
        loop {if host.gate("b").unwrap().try_write().is_err(){break;}tokio::task::yield_now().await;}
        let host_request=uuid::Uuid::new_v4().to_string();let stopping_host=host.clone();let host_input=Stop {suppress_scheduling:true,request_id:host_request.clone(),expected_generation:host.identity.generation.clone(),strategy:StopStrategy::Cancel,project_id:None,service_generation:None};
        let stopping=tokio::task::spawn_local(async move {stopping_host.stop_host(host_input).await});
        loop {if host.stop.borrow().is_some(){break;}tokio::task::yield_now().await;}
        let original=host.receipt(&host_request).unwrap().unwrap().receipt;assert_eq!(host.reconcile(&host_request).await.unwrap().unwrap(),original);
        let request=uuid::Uuid::new_v4().to_string();let error=host.stop_project(Stop {suppress_scheduling:true,request_id:request.clone(),expected_generation:host.identity.generation.clone(),strategy:StopStrategy::Cancel,project_id:Some("c".into()),service_generation:Some("unused".into())}).await.unwrap_err();assert!(error.to_string().contains("stopInProgress"));assert!(host.receipt(&request).unwrap().is_none());
        drop(startup);assert!(stopping_project.await.unwrap().unwrap_err().to_string().contains("stopInProgress"));assert!(host.receipt(&project_request).unwrap().is_none());drop(held_a);
        assert_eq!(stopping.await.unwrap().unwrap()["state"],"completed");
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn settled_refusals_release_admission_live_and_after_restart_but_unknown_does_not() {
    tokio::task::LocalSet::new().run_until(async {
        for (states,expected,released) in [
            (vec![Some(StopOperationState::Blocked)],"blocked",true),
            (vec![Some(StopOperationState::Completed),Some(StopOperationState::Blocked)],"partial",true),
            (vec![Some(StopOperationState::Blocked),None],"admissionUnknown",false),
        ] {
            let root=tempfile::tempdir().unwrap();let home=root.path().canonicalize().unwrap().join("home");
            storage::private_dir(&home).unwrap();storage::private_dir(&home.join("host/operations")).unwrap();
            let request=uuid::Uuid::new_v4().to_string();let mut targets=Vec::new();
            for (index,state) in states.into_iter().enumerate() {
                let instance=format!("{index:024x}");let child=uuid::Uuid::new_v4().to_string();let generation=uuid::Uuid::new_v4().to_string();
                let directory=storage::registry(&home,&instance).unwrap();storage::private_dir(&directory).unwrap();
                if let Some(state)=state {
                    let service:Service=serde_json::from_value(json!({"protocolVersion":1,"serviceId":instance,"generation":generation,"workspace":root.path(),"dataDir":root.path().join(format!("data-{index}")),"configFingerprint":"fixture","endpoint":"http://127.0.0.1:1","webUrl":"http://127.0.0.1:1","authFile":directory.join("auth.json"),"logFile":directory.join("host.log"),"hostPid":1,"corePid":1,"state":"stopped"})).unwrap();
                    storage::write_stop_receipt(&directory,&storage::StopReceipt {operation:StopOperation {version:1,request_id:child.clone(),service_id:instance.clone(),generation:generation.clone(),cancel:false,state,message:None,lifecycle:None},service,cleanup_confirmed:state==StopOperationState::Completed}).unwrap();
                }
                targets.push(json!({"projectId":format!("old-{index}"),"serviceId":instance,"serviceGeneration":generation,"requestId":child,"dispatch":"started","receipt":{"state":"admissionUnknown"}}));
            }
            let receipt=json!({"version":1,"requestId":request,"hostId":uuid::Uuid::new_v4().to_string(),"generation":uuid::Uuid::new_v4().to_string(),"strategy":"ifIdle","state":"admissionUnknown","projects":targets});
            storage::write(&home.join("host/stop.json"),&receipt).unwrap();storage::write(&wire::operation_path(&home,&request),&Operation {digest:"fixture".into(),receipt,evidence:Value::Null}).unwrap();
            let workspace=root.path().join("workspace");std::fs::create_dir(&workspace).unwrap();
            let registration=ProjectRegistration {project_id:"new-project".into(),workspace:workspace.canonicalize().unwrap(),data_dir:home.join("new-data"),source:ProjectSource::Cli,default_binding:false};
            let bin=std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
            let task=tokio::task::spawn_local(run_local(RunOptions {home:home.clone(),bin_dir:bin.clone()}));
            let client=loop {if let Ok(client)=Client::connect_at(home.clone()).await {break client;}
if task.is_finished(){panic!("Host exited before connection: {:?}",task.await.unwrap().err());}tokio::task::yield_now().await;};
            assert!(client.status().await.unwrap().stop_intent);
            assert!(client.register(&uuid::Uuid::new_v4().to_string(),registration.clone()).await.is_err());
            let observed=client.operation(&request).await.unwrap().unwrap();assert_eq!(observed["state"],expected);
            assert_eq!(client.status().await.unwrap().stop_intent,!released);
            assert_eq!(client.register(&uuid::Uuid::new_v4().to_string(),registration.clone()).await.is_ok(),released);
            task.abort();assert!(task.await.is_err_and(|error|error.is_cancelled()));
            // 并行用例的 fork 可能短暂继承 CLOEXEC 锁，重启前先证明锁已实际释放。
            let lock=storage::open_private(&home.join("host.lock"),false).unwrap();
            let deadline=tokio::time::Instant::now()+Duration::from_secs(2);
            loop {
                match lock.try_lock_exclusive() {
                    Ok(())=>{FileExt::unlock(&lock).unwrap();break;},
                    Err(error) if error.kind()==std::io::ErrorKind::WouldBlock=>{},
                    Err(error)=>panic!("Host lock inspection failed: {error}"),
                }
                assert!(tokio::time::Instant::now()<deadline,"Host lock remained held after owner exit");
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
            drop(lock);
            let task=tokio::task::spawn_local(run_local(RunOptions {home:home.clone(),bin_dir:bin}));
            let client=loop {if let Ok(client)=Client::connect_at(home.clone()).await {break client;}
if task.is_finished(){panic!("Host exited before connection: {:?}",task.await.unwrap().err());}tokio::task::yield_now().await;};
            assert_eq!(client.status().await.unwrap().stop_intent,!released);
            assert_eq!(client.operation(&request).await.unwrap().unwrap()["state"],expected);
            assert_eq!(client.register(&uuid::Uuid::new_v4().to_string(),registration).await.is_ok(),released);
            assert_eq!(crate::operation_offline(&home,&request).unwrap().unwrap()["state"],expected);
            task.abort();assert!(task.await.is_err_and(|error|error.is_cancelled()));
        }
    }).await;
}

#[test]
fn only_fully_settled_operations_are_reclaimable() {
    let operation = |receipt: Value, evidence: Value| Operation {
        digest: "d".into(),
        receipt,
        evidence,
    };
    for (receipt, evidence, settled) in [
        (json!({"state":"completed"}), Value::Null, true),
        (json!({"state":"blocked"}), Value::Null, true),
        (json!({"state":"acceptedPending"}), Value::Null, false),
        (json!({"state":"admissionUnknown"}), Value::Null, false),
        (json!({"state":"settlementIncomplete"}), Value::Null, false),
        (json!({"state":"partial"}), Value::Null, false),
        (json!({}), Value::Null, false),
        (
            json!({"state":"completed"}),
            json!({"schedulingIntentPending":true}),
            false,
        ),
        (
            json!({"state":"completed","projects":[{"receipt":{"state":"completed"}},{"dispatch":"notStarted"}]}),
            Value::Null,
            false,
        ),
        (
            json!({"state":"blocked","projects":[{"receipt":{"state":"blocked"}}]}),
            Value::Null,
            true,
        ),
    ] {
        assert_eq!(
            operation(receipt.clone(), evidence).settled(),
            settled,
            "{receipt}"
        );
    }
}

#[test]
fn receipt_state_keeps_disk_strings_and_treats_unknown_as_unsettled() {
    use ReceiptState::*;
    for (state, disk) in [
        (AcceptedPending, "acceptedPending"),
        (AdmissionUnknown, "admissionUnknown"),
        (SettlementIncomplete, "settlementIncomplete"),
        (Partial, "partial"),
        (Blocked, "blocked"),
        (Completed, "completed"),
    ] {
        assert_eq!(json!(state), disk);
        assert_eq!(ReceiptState::of(&json!({"state":disk})), Some(state));
        assert_eq!(
            ReceiptState::settled(Some(state)),
            matches!(state, Blocked | Completed)
        );
    }
    for receipt in [json!({}), json!({"state":"Completed"}), json!({"state":1})] {
        assert_eq!(ReceiptState::of(&receipt), None);
        assert!(!ReceiptState::settled(ReceiptState::of(&receipt)));
    }
}

#[test]
fn aggregate_keeps_unknown_and_partial_targets_distinct() {
    for state in ["acceptedPending", "settlementIncomplete", "completed"] {
        assert_eq!(
            json!(aggregate(
                &json!({"projects":[{"receipt":{"state":"completed"}}],"localRelay":{"state":state}})
            )),
            state
        );
    }
    assert_eq!(
        json!(aggregate(
            &json!({"projects":[{"receipt":{"state":"blocked"}}],"localRelay":{"state":"acceptedPending"}})
        )),
        "blocked"
    );
    assert_eq!(
        json!(aggregate(
            &json!({"projects":[{"receipt":{"state":"completed"}},{"dispatch":"notStarted"}]})
        )),
        "partial"
    );
    assert_eq!(
        json!(aggregate(
            &json!({"projects":[{"receipt":{"state":"admissionUnknown"}},{"receipt":{"state":"blocked"}}]})
        )),
        "admissionUnknown"
    );
}

#[tokio::test]
async fn restored_host_does_not_settle_an_old_relay_without_original_exit_evidence() {
    let directory = tempfile::tempdir().unwrap();
    let home = directory.path().canonicalize().unwrap();
    let (changes, _) = watch::channel(0);
    let host = Host {
        home: home.clone(),
        bin: home.clone(),
        identity: HostIdentity {
            version: VERSION,
            host_id: "same-host".into(),
            generation: "replacement-generation".into(),
            socket_path: home.join("socket"),
            auth_file: home.join("auth"),
            pid: std::process::id(),
            executable_version: "fixture".into(),
        },
        token: "fixture".into(),
        slots: RefCell::new(BTreeMap::new()),
        stop: RefCell::new(None),
        host_stop_gate: Mutex::new(()),
        changes,
        exit: Notify::new(),
        migration: crate::migration::Migration::new(&home).unwrap().into(),
        journal: crate::journal::Journal::new(&home).unwrap(),
        remote: crate::remote_state::RemoteState::new(&home),
        gateway: gateway_owner::Gateway::default(),
        subscriptions: subscriptions::Subscriptions::default(),
        schedules: schedules::Schedules::load(&home).unwrap(),
        power: power::Power::default(),
        read_models: Default::default(),
        loopback: loopback::Loopback::default(),
    };
    let mut original = json!({"requestId":"original-stop","hostId":"same-host","generation":"original-generation","projects":[],"localRelay":{"state":"acceptedPending"}});
    host.settle_local_relay(&mut original).await;
    assert_eq!(original["localRelay"]["state"], "settlementIncomplete");
    assert_eq!(json!(aggregate(&original)), "settlementIncomplete");
    let mut completed = original.clone();
    completed["localRelay"]["state"] = json!("completed");
    host.settle_local_relay(&mut completed).await;
    assert_eq!(completed["localRelay"]["state"], "completed");
    let mut current = original.clone();
    current["generation"] = json!(host.identity.generation);
    host.settle_local_relay(&mut current).await;
    assert_eq!(current["localRelay"]["state"], "completed");
}
