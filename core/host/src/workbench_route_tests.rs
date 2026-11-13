use super::*;

#[tokio::test(flavor = "current_thread")]
async fn task_rejection_is_recovered_for_original_workbench_command() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    tokio::task::LocalSet::new().run_until(async {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let (host, input, source) = resumable_host(&root);
        host.slots.borrow_mut().get_mut("project").unwrap().registration.source =
            crate::ProjectSource::Gui { profile: input.profile.clone(), legacy_project_id: "logical".into() };
        host.gateway.workbench.ensure_backend(&host, input).await.unwrap();
        host.gateway.workbench.test_source(&source);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let registration = host.slots.borrow()["project"].registration.clone();
        let service = areal_protocol::service::Service {
            identity: areal_protocol::service::Identity { protocol_version: 1, service_id: "fixture".into(), generation: "first".into(), workspace: registration.workspace, data_dir: registration.data_dir, config_fingerprint: "fixture".into() },
            owner: Some(host.owner()), endpoint: format!("ws://{}/", listener.local_addr().unwrap()), web_url: String::new(), auth_file: host.home.join("core-auth.json"), log_file: host.home.join("core.log"), host_pid: 1, core_pid: 2, state: areal_protocol::service::State::Ready,
        };
        areal_local_service::storage::write(&service.auth_file, &json!({"principals":[{"id":"desktop-owner","token":"fixture"}]})).unwrap();
        let gate = host.slots.borrow()["project"].gate.clone();
        let _guard = gate.write().await;
        { let mut slots = host.slots.borrow_mut(); let slot = slots.get_mut("project").unwrap(); slot.service = Some(service.clone()); slot.state = "ready".into(); let (writer, lifetime) = areal_local_service::OwnerLifetime::pair().unwrap(); slot.writer = Some(writer); slot.lifetime = Some(Rc::new(lifetime)); }
        let count = Rc::new(std::cell::Cell::new(0)); let observed = count.clone();
        let server = tokio::task::spawn_local(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            while let Some(Ok(Message::Text(text))) = socket.next().await {
                let call: Value = serde_json::from_str(&text).unwrap();
                if call.get("id").is_none() { continue; }
                let response = match call["method"].as_str().unwrap() {
                    "initialize" => json!({"id":call["id"],"result":{}}),
                    "areal/conversation/list" | "areal/work/overview" => json!({"id":call["id"],"result":{"data":[],"nextCursor":null}}),
                    "areal/task/stopRun" => { observed.set(observed.get()+1); if call["params"]["taskId"] == "lost" { break; } json!({"id":call["id"],"error":{"code":-32009,"message":"private","data":{"outcome":{"kind":"rejected"}}}}) },
                    method => panic!("unexpected {method}"),
                };
                socket.send(Message::Text(response.to_string().into())).await.unwrap();
            }
        });
        let close = host.schedules.connections.connect_test_core(host.clone(), "project", service).await.unwrap();
        let command = uuid::Uuid::new_v4().to_string();
        let request = json!({"method":"manage.command","commandId":command,"params":{"sourceId":source,"projectId":"logical","operation":"taskStopRun","taskId":"task","expectedRevision":9,"expectedRunId":"run"}});
        for _ in 0..2 {
            let error = backend_command(&host, "local", &request).await.unwrap_err();
            assert_eq!(super::super::task_catalog::task_rejection_response(&error).unwrap()["coreCode"], -32009);
        }
        assert_eq!(count.get(), 1);
        let mut changed = request.clone(); changed["params"]["expectedRevision"] = json!(10);
        assert_eq!(backend_command(&host, "local", &changed).await.unwrap_err().to_string(), "COMMAND_CONFLICT");
        let mut foreign = request.clone(); foreign["params"]["sourceId"] = json!("different-source");
        assert_eq!(backend_command(&host, "local", &foreign).await.unwrap_err().to_string(), "COMMAND_CONFLICT");
        assert!(backend_receipt(&host, "local", &command).unwrap_err().downcast_ref::<super::super::task_catalog::TaskRejection>().is_some());
        let mut lost = request.clone(); lost["commandId"] = json!(uuid::Uuid::new_v4().to_string()); lost["params"]["taskId"] = json!("lost");
        let unknown = backend_command(&host, "local", &lost).await.unwrap();
        assert_eq!(unknown["submissionUnknown"], true);
        assert_eq!(backend_command(&host, "local", &lost).await.unwrap(), unknown);
        assert_eq!(count.get(), 2);
        close(); server.abort(); host.gateway.workbench.stop_backend().await;
    }).await;
}

// 只替代 Node 业务装配，恢复、来源校验、启动记录和子进程监督均走正式路径。
fn resumable_host(root: &Path) -> (Rc<Host>, Ensure, String) {
    let mut host = crate::server::schedules::tests::fixture(root);
    host.bin = root.join("target/debug");
    for path in [
        host.bin.clone(),
        root.join("services/workbench/src"),
        root.join("clients/gui/app"),
        root.join("profile"),
        root.join("data"),
    ] {
        areal_local_service::storage::private_dir(&path).unwrap();
    }
    std::fs::write(host.bin.join("areal"), "").unwrap();
    std::fs::write(root.join("services/workbench/package.json"), "{}").unwrap();
    std::fs::write(root.join("services/workbench/src/backend-main.cjs"), r#"
        const readline = require('node:readline');
        const out = frame => console.log(JSON.stringify({version:1,...frame}));
        readline.createInterface({input:process.stdin}).on('line', line => {
            const frame = JSON.parse(line);
            if (frame.method === 'backend.start') {
                out({event:'ready',methods:['providers.read','pages.command'],service:{pid:process.pid,identity:String(process.pid)}});
            } else if (frame.params?.crash) {
                process.exit(1);
            } else if (frame.id !== undefined) {
                out({id:frame.id,result:frame.method === 'providers.read' ? {models:[]} : {pid:process.pid}});
            }
        });
    "#).unwrap();
    let source = crate::migration::Source {
        profile: root.join("profile"),
        core_home: root.join("data"),
        legacy_service_home: root.join("legacy"),
    };
    host.migration
        .attach(source.clone(), "fixture", None)
        .unwrap();
    let imported = host.migration.import(serde_json::from_value(json!({
        "requestId": uuid::Uuid::new_v4().to_string(), "expectedGeneration":host.identity.generation, "source":source,
    })).unwrap(), "fixture", &[], &host.journal).unwrap();
    assert_eq!(imported["kind"], "ready");
    let source_id = host
        .migration
        .navigation_source_id(&source.profile)
        .unwrap()
        .unwrap();
    let input = Ensure {
        profile: source.profile.clone(),
        options: json!({
            "binary":host.bin.join("areal"),"home":source.core_home,"guiProfile":source.profile,"hostHome":host.home,"userHome":root,
        }),
        environment_credentials: Default::default(),
    };
    (Rc::new(host), input, source_id)
}

#[test]
fn gui_environment_credentials_are_limited_to_configured_non_vault_names() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join(".areal");
    std::fs::create_dir(&home).unwrap();
    std::fs::write(
        home.join("config.toml"),
        r#"schema_version=1
[model]
catalog_version=1
provider="ordinary"
name="fixture"
[model.providers.ordinary]
name="ordinary"
endpoint="http://127.0.0.1:1/v1/chat/completions"
protocol="chat-completions"
api_key_env="FIXTURE_MODEL_API_KEY"
models=[{id="fixture",enabled=true}]
[model.providers.saved]
name="saved"
endpoint="http://127.0.0.1:1/v1/chat/completions"
protocol="chat-completions"
api_key_env="AREAL_CREDENTIAL_saved"
models=[{id="saved",enabled=true}]
"#,
    )
    .unwrap();
    let names =
        environment_credential_names(&json!({"home":root.path(), "userHome":root.path()})).unwrap();
    assert_eq!(
        names.into_iter().collect::<Vec<_>>(),
        vec!["FIXTURE_MODEL_API_KEY"]
    );
}

#[tokio::test(flavor = "current_thread")]
async fn running_backend_accepts_updated_and_explicitly_cleared_environment_credentials() {
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let (host, input, source) = resumable_host(&root);
        std::fs::create_dir(root.join(".areal")).unwrap();
        std::fs::write(root.join(".areal/config.toml"), "schema_version=1\n[model]\nprovider='fixture'\nname='fixture'\n[model.providers.fixture]\nendpoint='http://127.0.0.1:1/'\nprotocol='responses'\napi_key_env='FIXTURE_KEY'\n").unwrap();
        host.gateway.workbench.ensure_backend(&host, input.clone()).await.unwrap();
        let mut wire = serde_json::to_value(&input).unwrap();
        wire["environmentCredentials"] = json!({"FIXTURE_KEY":"secret"});
        host.gateway.workbench.ensure_backend(&host, serde_json::from_value(wire.clone()).unwrap()).await.unwrap();
        assert_eq!(host.gateway.workbench.environment_credentials(&source).get("FIXTURE_KEY").map(String::as_str), Some("secret"));
        host.gateway.workbench.ensure_backend(&host, input.clone()).await.unwrap();
        assert_eq!(host.gateway.workbench.environment_credentials(&source).get("FIXTURE_KEY").map(String::as_str), Some("secret"));
        wire["environmentCredentials"] = json!({});
        host.gateway.workbench.ensure_backend(&host, serde_json::from_value(wire).unwrap()).await.unwrap();
        assert!(host.gateway.workbench.environment_credentials(&source).is_empty());
        host.gateway.workbench.stop_backend().await;
    }).await;
}

#[test]
fn inaccessible_model_configuration_is_not_hidden() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path().canonicalize().unwrap();
    let (host, mut input, _) = resumable_host(&root);
    input.options["config"] = json!(root.join("missing.toml"));
    let error = host
        .gateway
        .workbench
        .credential_names(&host, input)
        .unwrap_err();
    assert_eq!(
        error
            .downcast_ref::<areal_config::ConfigError>()
            .unwrap()
            .kind,
        areal_config::ConfigErrorKind::Io
    );
}

#[tokio::test(flavor = "current_thread")]
async fn invalid_model_configuration_does_not_prevent_backend_start() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let root = root.path().canonicalize().unwrap();
            let (host, input, _) = resumable_host(&root);
            std::fs::create_dir(root.join(".areal")).unwrap();
            std::fs::write(root.join(".areal/config.toml"), "invalid = [").unwrap();
            let result = host
                .gateway
                .workbench
                .credential_names(&host, input.clone())
                .unwrap();
            assert_eq!(result["configurationError"], true);
            host.gateway
                .workbench
                .ensure_backend(&host, input)
                .await
                .unwrap();
            host.gateway.workbench.stop_backend().await;
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn cold_backend_read_and_managed_requests_resume_the_persisted_launch() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let root = root.path().canonicalize().unwrap();
            let (host, input, source) = resumable_host(&root);
            host.gateway
                .workbench
                .ensure_backend(&host, input)
                .await
                .unwrap();
            host.gateway.workbench.stop_backend().await;
            assert!(launch_record(&host).is_file());
            // 重建 Host，只有磁盘记录，不保留 Supervisor 内存状态。
            let (host, _, _) = resumable_host(&root);
            let request =
                json!({"method":"providers.read","params":{"sourceId":source,"operation":"list"}});
            assert_eq!(
                backend_read(&host, "web:fixture", &request).await.unwrap(),
                json!({"models":[]})
            );
            let mut forged = request.clone();
            forged["params"]["sourceId"] = json!("forged");
            assert_eq!(
                backend_read(&host, "web:fixture", &forged)
                    .await
                    .unwrap_err()
                    .to_string(),
                "FORBIDDEN"
            );
            host.gateway.workbench.stop_backend().await;
            let (host, _, _) = resumable_host(&root);
            let page = host
                .gateway
                .workbench
                .request(
                    &host,
                    "pages.command",
                    json!({}),
                    json!({"connection":"fixture"}),
                )
                .await
                .unwrap();
            assert!(page["pid"].as_u64().is_some());
            host.gateway.workbench.stop_backend().await;
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn backend_first_exit_recovers_immediately_but_repeated_exits_back_off() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let (host, input, _) = resumable_host(&root.path().canonicalize().unwrap());
            let original = host
                .gateway
                .workbench
                .ensure_backend(&host, input)
                .await
                .unwrap();
            let request = |params| {
                host.gateway.workbench.request(
                    &host,
                    "pages.command",
                    params,
                    json!({"connection":"fixture"}),
                )
            };
            assert!(request(json!({"crash":true})).await.is_err());
            let restarted = request(json!({})).await.unwrap();
            assert_ne!(restarted["pid"], original["pid"]);
            assert!(request(json!({"crash":true})).await.is_err());
            let error = request(json!({})).await.unwrap_err();
            assert_eq!(
                error.downcast_ref::<crate::wire::Error>().unwrap().code,
                "CAPABILITY_UNAVAILABLE"
            );
            tokio::time::sleep(Duration::from_millis(1100)).await;
            assert!(request(json!({})).await.is_ok());
            host.gateway.workbench.stop_backend().await;
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn analytics_first_exit_recovers_immediately_but_repeated_exits_back_off() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let (host, _, _) = resumable_host(&root.path().canonicalize().unwrap());
            std::fs::write(
                root.path().join("services/workbench/src/main.cjs"),
                r#"
            const out = frame => console.log(JSON.stringify({version:1,...frame}));
            out({event:'ready',methods:['analytics.read']});
            require('node:readline').createInterface({input:process.stdin}).on('line', line => {
                const frame = JSON.parse(line);
                if (frame.params.crash) process.exit(1);
                out({id:frame.id,result:{pid:process.pid}});
            });
        "#,
            )
            .unwrap();
            let request = |params| {
                host.gateway
                    .workbench
                    .request(&host, "analytics.read", params, json!({}))
            };
            let original = request(json!({})).await.unwrap();
            assert!(request(json!({"crash":true})).await.is_err());
            let restarted = request(json!({})).await.unwrap();
            assert_ne!(restarted, original);
            assert!(request(json!({"crash":true})).await.is_err());
            assert_eq!(
                request(json!({})).await.unwrap_err().to_string(),
                "CAPABILITY_UNAVAILABLE"
            );
            tokio::time::sleep(Duration::from_millis(1100)).await;
            assert!(request(json!({})).await.is_ok());
            host.gateway.workbench.stop().await;
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn backend_business_errors_preserve_only_codes_supported_by_the_host() {
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let host = Rc::new(crate::server::schedules::tests::fixture(root.path()));
        let app = root.path().join("app");
        let package = app.join("node_modules/@areal/workbench-service");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(app.join("package.json"), "{}").unwrap();
        std::fs::write(package.join("package.json"), r#"{"exports":{"./desktop/core/service-main.cjs":"./main.cjs"}}"#).unwrap();
        std::fs::write(package.join("main.cjs"), r#"
            exports.createMainDesktop = async () => ({backend:{cloud:{}},adapter:{
                listen:async () => ({pid:process.pid,identity:'fixture'}),
                executeRemote:async (_, params) => { throw Object.assign(Error('private detail'), {code:params.code}); }
            },close:async () => {}});
        "#).unwrap();
        let runtime = std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|path| path.join("node")).find(|path| path.is_file()).unwrap();
        let runner = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../services/workbench/src/backend-main.cjs");
        let data = root.path().join("data");
        std::fs::create_dir(&data).unwrap();
        let (backend, _) = Workbench::start_with(&runtime, &runner, root.path(), reverse(&host), Some(("backend.start", json!({
            "appRoot":app,"options":{"home":data,"userHome":root.path()},
        })))).await.unwrap();
        for (code, expected) in [(json!("COMMAND_CONFLICT"), "COMMAND_CONFLICT"), (json!("TURN_BUSY"), "TURN_BUSY"), (json!("MIGRATION_PENDING"), "MIGRATION_PENDING"), (json!("migrationBlocked"), "migrationBlocked"), (json!("ENOENT"), "CORE_UNAVAILABLE"), (json!(-32602), "CORE_UNAVAILABLE")] {
            assert_eq!(backend.request("providers.read", json!({"code":code}), json!({})).await.unwrap_err().to_string(), expected);
        }
        backend.stop().await.unwrap();
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn pages_bind_authenticated_connection_and_forward_disconnect_without_a_journal() {
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let host = Rc::new(crate::server::schedules::tests::fixture(root.path()));
        let runtime = std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|path| path.join("node")).find(|path| path.is_file()).expect("Node is required");
        let runner = root.path().join("pages.cjs");
        std::fs::write(&runner, r#"
            const out = value => console.log(JSON.stringify({version:1,...value}));
            out({event:'ready',methods:['pages.command','pages.resource']});
            require('node:readline').createInterface({input:process.stdin}).on('line', line => {
              const frame = JSON.parse(line);
              if (frame.event === 'pages.disconnect') {
                out({event:'pages.event',params:{connection:frame.connection,token:'page',notification:{jsonrpc:'2.0',method:'ui/notifications/closed'}}});
              } else {
                out({id:frame.id,result:{owner:frame.context.connection}});
              }
            });
        "#).unwrap();
        let backend = Workbench::start(&runtime, &runner, root.path(), reverse(&host)).await.unwrap();
        *host.gateway.workbench.backend.running.borrow_mut() = Some(Rc::new(backend));
        let mut first = crate::server::gateway_owner::LocalSession::new(host.clone(), "first".into()).unwrap();
        let mut second = crate::server::gateway_owner::LocalSession::new(host.clone(), "second".into()).unwrap();
        let request = json!({"id":"page","method":"pages.command","params":{"operation":"close","token":"page"}});
        assert_eq!(first.request(&request).await.unwrap()["owner"], "first");
        assert_eq!(second.request(&request).await.unwrap()["owner"], "second");
        let mut forged = request.clone();
        forged["context"] = json!({"connection":"second"});
        assert_eq!(first.request(&forged).await.unwrap_err().to_string(), "INVALID_PARAMS");
        forged = request.clone();
        forged["params"]["connection"] = json!("second");
        assert_eq!(first.request(&forged).await.unwrap_err().to_string(), "INVALID_PARAMS");
        let mut events = host.gateway.workbench.page_events();
        host.gateway.workbench.disconnect_pages("first");
        let event = tokio::time::timeout(Duration::from_secs(2), events.recv()).await.unwrap().unwrap();
        assert_eq!(event["connection"], "first");
        assert_eq!(event["notification"]["method"], "ui/notifications/closed");
        assert!(backend_receipt(&host, "local", &uuid::Uuid::new_v4().to_string()).unwrap().is_none());
        host.gateway.workbench.stop_backend().await;
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn local_gui_source_worktree_profile_keeps_native_admission_and_identity() {
    tokio::task::LocalSet::new().run_until(async {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let (host, input, source) = resumable_host(&root);
        host.slots.borrow_mut().get_mut("project").unwrap().registration.source =
            crate::ProjectSource::Gui { profile:input.profile.clone(), legacy_project_id:"logical".into() };
        host.gateway.workbench.ensure_backend(&host,input).await.unwrap();
        host.gateway.workbench.test_source(&source);
        assert_eq!(super::super::plugins::backend_project_id(&host,"logical").unwrap(),"project");
        assert_eq!(super::super::plugins::backend_project_id(&host,"other").unwrap_err().to_string(),"RESOURCE_UNAVAILABLE");
        let home=super::super::library_store::source_home(&host,&source).unwrap();
        let creation=uuid::Uuid::new_v4().to_string();
        areal_local_service::storage::private_dir(&home.join("worktree-requests")).unwrap();
        areal_local_service::storage::write(&home.join("worktree-requests").join(format!("{creation}.json")),
            &json!({"requestId":creation,"projectId":"logical","state":"ready","threadId":"original-thread","record":{"directory":root.join("workspace")}})).unwrap();
        let command=uuid::Uuid::new_v4().to_string();
        let request=json!({"method":"worktree.command","commandId":command,"params":{"sourceId":source,"projectId":"logical","operation":"worktreeOpen","requestId":uuid::Uuid::new_v4().to_string(),"worktreeRequestId":creation,"agentProfile":{"id":"areal-standard","revision":"resources-existing"}}});
        let mut old_params=request["params"].clone();
        old_params.as_object_mut().unwrap().remove("agentProfile");
        assert_eq!(serde_json::to_value(serde_json::from_value::<areal_protocol::host::LocalWorktreeCommandInput>(old_params.clone()).unwrap()).unwrap(),
            serde_json::to_value(serde_json::from_value::<areal_protocol::host::WorkbenchWorktreeCommandParams>(old_params).unwrap()).unwrap());
        let receipt=backend_command(&host,"local",&request).await.unwrap();
        assert_eq!(receipt["submissionUnknown"],false);
        assert_eq!(receipt["receipt"]["threadId"],"original-thread");
        assert_eq!(backend_command(&host,"local",&request).await.unwrap(),receipt);
        let mut changed=request.clone();
        changed["params"]["agentProfile"]["revision"]=json!("different-revision");
        assert_eq!(backend_command(&host,"local",&changed).await.unwrap_err().to_string(),"COMMAND_CONFLICT");
        let mut foreign=request.clone();
        foreign["commandId"]=json!(uuid::Uuid::new_v4().to_string());
        foreign["params"]["sourceId"]=json!("foreign-source");
        assert_eq!(backend_command(&host,"local",&foreign).await.unwrap_err().to_string(),"FORBIDDEN");
        assert!(backend_receipt(&host,"local",foreign["commandId"].as_str().unwrap()).unwrap().is_none());
        assert_eq!(backend_command(&host,"web:fixture",&request).await.unwrap_err().to_string(),"INVALID_PARAMS");
        host.gateway.workbench.stop_backend().await;
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn reverse_calls_are_read_only_and_scoped_to_registered_projects() {
    let root = tempfile::tempdir().unwrap();
    let host = Rc::new(crate::server::schedules::tests::fixture(root.path()));
    let reverse = reverse(&host);
    let listed = reverse("projects.list".into(), json!({})).await.unwrap();
    assert_eq!(listed["projects"][0]["projectId"], "project");
    for (call, params, code) in [
        ("vault.read", json!({"slot":"x"}), "FORBIDDEN"),
        (
            "core.request",
            json!({"projectId":"project","method":"turn/start","params":{}}),
            "FORBIDDEN",
        ),
        (
            "core.request",
            json!({"projectId":"other","method":"thread/read","params":{}}),
            "NOT_FOUND",
        ),
        (
            "core.request",
            json!({"projectId":"project","method":"thread/read","extra":1}),
            "INVALID_PARAMS",
        ),
    ] {
        let error = reverse(call.into(), params).await.unwrap_err();
        assert_eq!(error.to_string(), code, "{call}");
    }
}

#[test]
fn restarts_back_off_and_stop_after_five_failures() {
    let supervisor = Supervisor::default();
    assert!(supervisor.admit().is_ok());
    supervisor.failures.borrow_mut().push(Instant::now());
    assert!(supervisor.admit().is_err());
    *supervisor.failures.borrow_mut() = vec![Instant::now() - Duration::from_secs(2)];
    assert!(supervisor.admit().is_ok());
    *supervisor.failures.borrow_mut() = vec![Instant::now() - Duration::from_secs(120); 5];
    assert!(supervisor.admit().is_err());
    *supervisor.failures.borrow_mut() =
        vec![Instant::now() - FAILURE_WINDOW - Duration::from_secs(1); 5];
    assert!(supervisor.admit().is_ok());
}
