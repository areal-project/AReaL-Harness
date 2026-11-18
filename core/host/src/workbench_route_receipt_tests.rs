//! 从 workbench_route.rs 拆出的测试：写命令回执（明确失败按拒绝结算、回复丢失保持未知且不重放）与后台准入。
use super::*;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

const TEST_PROJECT_ALIAS: &str = "fedcba9876543210fedcba98";

async fn setup_archive_fixture<F>(
    root: &Path,
    handler: F,
) -> (Rc<Host>, String, tokio::task::JoinHandle<()>, Box<dyn Fn()>)
where
    F: FnMut(&str, &Value) -> Option<Value> + 'static,
{
    let base = root.canonicalize().unwrap();
    let mut host = crate::server::schedules::tests::fixture(&base);
    host.bin = base.join("bin");
    for dir in [&host.bin, &base.join("profile"), &base.join("data")] {
        areal_local_service::storage::private_dir(dir).unwrap();
    }
    let source = crate::migration::Source {
        profile: base.join("profile"),
        core_home: base.join("data"),
        legacy_service_home: base.join("legacy"),
    };
    host.migration
        .attach(source.clone(), "fixture", None)
        .unwrap();
    let imported = host
        .migration
        .import(
            serde_json::from_value(json!({
                "requestId": uuid::Uuid::new_v4().to_string(),
                "expectedGeneration": host.identity.generation,
                "source": source,
            }))
            .unwrap(),
            "fixture",
            &[],
            &host.journal,
        )
        .unwrap();
    assert_eq!(imported["kind"], "ready");
    let source_id = host
        .migration
        .navigation_source_id(&source.profile)
        .unwrap()
        .unwrap();
    let workspace = base.join("project");
    areal_local_service::storage::private_dir(&workspace).unwrap();
    {
        let mut slots = host.slots.borrow_mut();
        let slot = slots.get_mut("project").unwrap();
        slot.registration.workspace = workspace.clone();
        slot.registration.source = crate::ProjectSource::Gui {
            profile: source.profile.clone(),
            legacy_project_id: TEST_PROJECT_ALIAS.into(),
        };
    }
    areal_local_service::storage::write(
        &source.core_home.join("projects.json"),
        &json!([{ "id": TEST_PROJECT_ALIAS, "root": workspace }]),
    )
    .unwrap();
    let host = Rc::new(host);
    host.gateway.workbench.test_source(&source_id);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let registration = host.slots.borrow()["project"].registration.clone();
    let service = areal_protocol::service::Service {
        identity: areal_protocol::service::Identity {
            protocol_version: 1,
            service_id: "fixture".into(),
            generation: "gen-1".into(),
            workspace: registration.workspace,
            data_dir: registration.data_dir,
            config_fingerprint: "fixture".into(),
        },
        owner: Some(host.owner()),
        endpoint: format!("ws://{}/", listener.local_addr().unwrap()),
        web_url: String::new(),
        auth_file: host.home.join("core-auth.json"),
        log_file: host.home.join("core.log"),
        host_pid: 1,
        core_pid: 2,
        state: areal_protocol::service::State::Ready,
    };
    areal_local_service::storage::write(
        &service.auth_file,
        &json!({"principals":[{"id":"desktop-owner","token":"fixture"}]}),
    )
    .unwrap();
    {
        let mut slots = host.slots.borrow_mut();
        let slot = slots.get_mut("project").unwrap();
        slot.service = Some(service.clone());
        slot.state = "ready".into();
        let (writer, lifetime) = areal_local_service::OwnerLifetime::pair().unwrap();
        slot.writer = Some(writer);
        slot.lifetime = Some(Rc::new(lifetime));
    }
    let mut handler = handler;
    let server = tokio::task::spawn_local(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        while let Some(Ok(Message::Text(text))) = socket.next().await {
            let call: Value = serde_json::from_str(&text).unwrap();
            if call.get("id").is_none() {
                continue;
            }
            let method = call["method"].as_str().unwrap();
            let Some(mut response) = handler(method, &call["params"]) else {
                break;
            };
            response["jsonrpc"] = json!("2.0");
            response["id"] = call["id"].clone();
            socket
                .send(Message::Text(response.to_string().into()))
                .await
                .unwrap();
        }
    });
    let close = host
        .schedules
        .connections
        .connect_test_core(host.clone(), "project", service)
        .await
        .unwrap();
    (host, source_id, server, close)
}

#[tokio::test(flavor = "current_thread")]
async fn thread_creation_preparation_and_original_receipt_need_no_node_backend() {
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let calls = Rc::new(RefCell::new(Vec::new()));
        let observed = calls.clone();
        let (host, _source, server, close) = setup_archive_fixture(root.path(), move |method, params| {
            observed.borrow_mut().push((method.to_owned(), params.clone()));
            Some(json!({"result":match method {
                "initialize" | "areal/server/status" => json!({}),
                "areal/task/list" => json!({"data":[],"nextCursor":null}),
                "areal/capabilities" => json!({"methods":["areal/thread/start","areal/request/read"],"features":{"threadCreationJournal":{"binding":{"identity":"fixture","journalEpoch":"epoch","coreInstanceId":"fixture"}}}}),
                "areal/thread/start" => json!({"thread":{"id":"native-created"},"requestId":params["requestId"]}),
                "areal/turn/start" | "areal/turn/enqueue" | "turn/steer" => json!({"threadId":params["threadId"],"turn":{"id":"native-turn"},"queueItemId":"queued"}),
                other => panic!("unexpected {other}"),
            }}))
        }).await;
        let registration = host.slots.borrow()["project"].registration.clone();
        let launch_dir = host.home.join("host/launch").join(storage::digest(b"project"));
        storage::private_dir(&launch_dir).unwrap();
        storage::write(&launch_dir.join("inputs.json"), &crate::LaunchInputs {
            workspace:registration.workspace.clone(),cwd:registration.workspace.clone(),
            config_home:root.path().join("data"),homedir:None,config_path:None,deployment_path:None,
            schedule_preparation:None,environment:Default::default(),credential_names:Vec::new(),options:Default::default(),
        }).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let params = json!({"projectId":TEST_PROJECT_ALIAS,"requestId":id,"options":{"permissionPreset":"ask","appendInstructions":"keep this"},"model":{"providerId":"fixture","modelId":"model"},"parameters":{"temperature":0.25},"browserEnabled":false});
        let mut prepared = host.gateway.workbench.prepare_execution(&host,"owner","project","workbench/thread/create",params.clone()).await.unwrap().unwrap();
        assert_eq!(prepared.params,params);
        let receipt = prepared.dispatch().await.unwrap();
        assert_eq!(receipt["state"],"ready");
        assert_eq!(receipt["threadId"],"native-created");
        let again = host.gateway.workbench.prepare_execution(&host,"owner","project","workbench/thread/create",params.clone()).await.unwrap().unwrap().dispatch().await.unwrap();
        assert_eq!(again,receipt);
        let calls = calls.borrow();
        let starts:Vec<_> = calls.iter().filter(|(method,_)|method=="areal/thread/start").collect();
        assert_eq!(starts.len(),1);
        assert_eq!(starts[0].1["options"]["appendInstructions"],"keep this");
        assert_eq!(starts[0].1["model"],params["model"]);
        assert_eq!(starts[0].1["parameters"]["temperature"],params["parameters"]["temperature"]);
        assert_eq!(starts[0].1["cwd"],json!(registration.workspace));
        drop(calls);
        let mut changed = params.clone();
        changed["model"]["modelId"] = json!("different-model");
        let rejected = host.gateway.workbench.prepare_execution(&host,"owner","project","workbench/thread/create",changed).await;
        assert_eq!(rejected.err().unwrap().to_string(),"COMMAND_CONFLICT");
        for method in ["areal/thread/start","areal/turn/start","areal/turn/enqueue","turn/steer"] {
            let native = if method == "areal/thread/start" {
                json!({"requestId":uuid::Uuid::new_v4().to_string(),"cwd":registration.workspace,"options":{"permissionPreset":"ask"}})
            } else { json!({"requestId":uuid::Uuid::new_v4().to_string(),"threadId":"native-created","input":[{"type":"text","text":"original input"}]}) };
            let mut prepared = host.gateway.workbench.prepare_execution(&host,"owner","project",method,native.clone()).await.unwrap().unwrap();
            assert_eq!(prepared.params,native);
            let result=prepared.dispatch().await.unwrap();
            assert!(result.is_object());
            assert_eq!(prepared.dispatch().await.unwrap_err().to_string(),"SUBMISSION_UNKNOWN");
        }
        close();server.abort();
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn explicit_backend_failure_settles_as_rejection_not_unknown() {
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().canonicalize().unwrap().join("project");
        let (host, source, server, close) = setup_archive_fixture(root.path(), move |method, params| match method {
            "initialize" => Some(json!({"result":{}})),
            "areal/task/list" => Some(json!({"result":{"data":[],"nextCursor":null}})),
            "areal/capabilities" => Some(json!({"result":{"methodSemantics":{"areal/thread/archive":{"effect":"mutation","receipt":"management"}},"features":{"threadCreationJournal":{"binding":null}}}})),
            "thread/read" => Some(json!({"result":{"thread":{"id":params["threadId"],"sessionId":"s-1","cwd":workspace,"conversation":{"kind":"ordinary","policy":{"kind":"ordinaryV1"}},"turns":[]}}})),
            "areal/thread/archive" => Some(json!({"error":{"code":-32009,"message":"TARGET_CHANGED","data":{"outcome":{"kind":"rejected"}}}})),
            other => panic!("unexpected {other}"),
        }).await;
        let command = uuid::Uuid::new_v4().to_string();
        let request = json!({"method":"manage.command","commandId":command,"params":{"sourceId":source,"operation":"archive","projectId":TEST_PROJECT_ALIAS,"threadId":"t"}});
        assert_eq!(backend_command(&host, "local", &request).await.unwrap_err().to_string(), "TARGET_CHANGED");
        // 同一命令再来一次只读原结论，不重新派发，也不留在待核对列表里。
        assert_eq!(backend_command(&host, "local", &request).await.unwrap_err().to_string(), "TARGET_CHANGED");
        assert_eq!(backend_receipt(&host, "local", &command).unwrap_err().to_string(), "TARGET_CHANGED");
        let scope = format!("workbench-{}", areal_local_service::storage::digest(b"local"));
        let (_, snapshot) = host.journal.native_snapshot(&scope).unwrap();
        assert_eq!(snapshot["pending"], json!([]));
        assert_eq!(snapshot["outcomes"][&command]["admissionState"], "rejected");
        close();
        server.abort();
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn lost_backend_reply_keeps_the_original_library_command_unknown() {
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let workspace = base.join("project");
        let effects = base.join("effects");
        let effects_cb = effects.clone();
        let (host, source, server, close) = setup_archive_fixture(root.path(), move |method, params| match method {
            "initialize" => Some(json!({"result":{}})),
            "areal/task/list" => Some(json!({"result":{"data":[],"nextCursor":null}})),
            "areal/capabilities" => Some(json!({"result":{"methodSemantics":{"areal/thread/archive":{"effect":"mutation","receipt":"management"}},"features":{"threadCreationJournal":{"binding":null}}}})),
            "thread/read" => Some(json!({"result":{"thread":{"id":params["threadId"],"sessionId":"s-1","cwd":workspace,"conversation":{"kind":"ordinary","policy":{"kind":"ordinaryV1"}},"turns":[]}}})),
            "areal/thread/archive" => {
                use std::io::Write;
                let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&effects_cb).unwrap();
                f.write_all(b"once\n").unwrap();
                None
            }
            other => panic!("unexpected {other}"),
        }).await;
        let command = uuid::Uuid::new_v4().to_string();
        let request = json!({"method":"manage.command","commandId":command,"params":{"sourceId":source,"operation":"archive","projectId":TEST_PROJECT_ALIAS,"threadId":"t"}});
        let first = backend_command(&host, "local", &request).await.unwrap();
        assert_eq!(first["submissionUnknown"], true);
        assert_eq!(backend_command(&host, "local", &request).await.unwrap(), first);
        assert_eq!(std::fs::read_to_string(&effects).unwrap(), "once\n");
        let mut conflict = request.clone();
        conflict["params"]["threadId"] = json!("other");
        assert_eq!(backend_command(&host, "local", &conflict).await.unwrap_err().to_string(), "COMMAND_CONFLICT");
        assert_eq!(backend_receipt(&host, "local", &command).unwrap().unwrap()["submissionUnknown"], true);
        let other_method = json!({"method":"worktree.command","commandId":command,"params":{"sourceId":"fixture","operation":"worktreeSettings","worktreeRoot":"/isolated","branchPrefix":"fixture"}});
        assert_eq!(backend_command(&host, "local", &other_method).await.unwrap_err().to_string(), "COMMAND_CONFLICT");
        close();
        server.abort();
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn lost_library_preference_reply_is_not_replayed() {
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let workspace = base.join("project");
        let effects = base.join("effects");
        let effects_cb = effects.clone();
        let (host, source, server, close) = setup_archive_fixture(root.path(), move |method, params| match method {
            "initialize" => Some(json!({"result":{}})),
            "areal/task/list" => Some(json!({"result":{"data":[],"nextCursor":null}})),
            "areal/capabilities" => Some(json!({"result":{"methodSemantics":{"areal/thread/archive":{"effect":"mutation","receipt":"management"}},"features":{"threadCreationJournal":{"binding":null}}}})),
            "thread/read" => Some(json!({"result":{"thread":{"id":params["threadId"],"sessionId":"s-1","cwd":workspace,"conversation":{"kind":"ordinary","policy":{"kind":"ordinaryV1"}},"turns":[]}}})),
            "areal/thread/archive" => {
                use std::io::Write;
                let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&effects_cb).unwrap();
                f.write_all(b"once\n").unwrap();
                None
            }
            other => panic!("unexpected {other}"),
        }).await;
        let command = uuid::Uuid::new_v4().to_string();
        let request = json!({"method":"manage.command","commandId":command,"params":{"sourceId":source,"operation":"archive","projectId":TEST_PROJECT_ALIAS,"threadId":"t"}});
        let first = backend_command(&host, "local", &request).await.unwrap();
        assert_eq!(first["submissionUnknown"], true);
        assert_eq!(backend_command(&host, "local", &request).await.unwrap(), first);
        assert_eq!(std::fs::read_to_string(&effects).unwrap(), "once\n");
        let mut conflict = request.clone();
        conflict["params"]["threadId"] = json!("other");
        assert_eq!(backend_command(&host, "local", &conflict).await.unwrap_err().to_string(), "COMMAND_CONFLICT");
        assert_eq!(backend_receipt(&host, "local", &command).unwrap().unwrap()["submissionUnknown"], true);
        let other_method = json!({"method":"worktree.command","commandId":command,"params":{"sourceId":"fixture","operation":"worktreeSettings","worktreeRoot":"/isolated","branchPrefix":"fixture"}});
        assert_eq!(backend_command(&host, "local", &other_method).await.unwrap_err().to_string(), "COMMAND_CONFLICT");
        close();
        server.abort();
    }).await;
}

fn layout(root: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let contents = root.join("Contents/Resources");
    let bin = contents.join("areal-core/bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(bin.join("areal"), b"").unwrap();
    std::fs::write(contents.join("app.asar"), b"fixture").unwrap();
    std::fs::create_dir_all(root.join("profile")).unwrap();
    std::fs::create_dir_all(root.join("profile/areal-core")).unwrap();
    std::fs::create_dir_all(root.join("host")).unwrap();
    (bin, root.join("profile"), root.join("host"))
}

fn options(root: &Path, bin: &Path) -> Value {
    json!({
        "binary": bin.join("areal"),
        "home": root.join("profile/areal-core"),
        "guiProfile": root.join("profile"),
        "hostHome": root.join("host"),
    })
}

fn code(result: Result<(String, Launch)>) -> String {
    let error = result.err().unwrap();
    error
        .downcast_ref::<crate::wire::Error>()
        .map(|error| error.code.to_owned())
        .unwrap_or_else(|| error.to_string())
}

#[test]
fn launch_validation_uses_the_gui_profile_and_host_core_without_an_app_archive() {
    let root = tempfile::tempdir().unwrap();
    let (bin, profile, host_home) = layout(root.path());
    let app = root.path().join("Contents/Resources/app.asar");
    std::fs::remove_file(app).unwrap();
    let accepted = launch_at(
        &bin,
        &host_home,
        Ensure {
            profile: profile.clone(),
            options: options(root.path(), &bin),
            environment_credentials: Default::default(),
        },
    )
    .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&accepted.0).unwrap(),
        options(root.path(), &bin)
    );
    assert_eq!(accepted.1.options, options(root.path(), &bin));

    let mut other_core = options(root.path(), &bin);
    other_core["binary"] = json!(root.path().join("other/bin/areal"));
    std::fs::create_dir_all(root.path().join("other/bin")).unwrap();
    std::fs::write(root.path().join("other/bin/areal"), b"").unwrap();
    assert_eq!(
        code(launch_at(
            &bin,
            &host_home,
            Ensure {
                profile: profile.clone(),
                options: other_core,
                environment_credentials: Default::default(),
            },
        )),
        "invalidRequest"
    );

    let mut other_host = options(root.path(), &bin);
    other_host["hostHome"] = json!(root.path().join("profile"));
    assert_eq!(
        code(launch_at(
            &bin,
            &host_home,
            Ensure {
                profile,
                options: other_host,
                environment_credentials: Default::default(),
            },
        )),
        "invalidRequest"
    );
}

#[test]
fn manage_operations_that_admit_or_stop_work_need_their_own_capability() {
    let capability = |params: Value| manage_capability("manage.command", &params);
    for operation in ["taskRunNow", "taskResumeRun"] {
        assert_eq!(capability(json!({"operation":operation})), Some("submit"));
        let mut params = json!({"sourceId":"source","projectId":"project",
            "operation":operation,"taskId":"task","expectedRevision":2});
        if operation == "taskResumeRun" {
            params["expectedRunId"] = json!("run");
            let missing_guard = params
                .as_object_mut()
                .unwrap()
                .remove("expectedRunId")
                .unwrap();
            assert!(
                serde_json::from_value::<areal_protocol::host::WorkbenchManageCommandParams>(
                    params.clone()
                )
                .is_err()
            );
            params["expectedRunId"] = missing_guard;
        }
        assert!(
            serde_json::from_value::<areal_protocol::host::WorkbenchManageCommandParams>(params)
                .is_ok()
        );
    }
    assert!(
        validate_backend_result(
            "manage.command",
            &json!({
                "accepted":true,"taskId":"task","runId":"run","revision":3
            })
        )
        .is_ok()
    );
    for operation in MANAGE_SUBMIT_OPERATIONS {
        assert_eq!(
            capability(json!({"operation":operation})),
            Some("submit"),
            "{operation}"
        );
    }
    for operation in MANAGE_INTERRUPT_OPERATIONS {
        assert_eq!(
            capability(json!({"operation":operation})),
            Some("interrupt"),
            "{operation}"
        );
    }
    // 只读、目录、插件与配置管理不额外索取提交或中断能力。
    for operation in [
        "pluginComponentConfigure",
        "pluginHooksConfigure",
        "taskPause",
        "planUpdate",
        "serverDrain",
    ] {
        assert_eq!(
            capability(json!({"operation":operation})),
            None,
            "{operation}"
        );
    }
    assert_eq!(
        manage_capability("manage.read", &json!({"operation":"processStart"})),
        None
    );
    assert_eq!(manage_capability("manage.command", &json!({})), None);
    assert_eq!(
        manage_capability("tasks.read", &json!({"operation":"processStart"})),
        None
    );
}

#[test]
fn backend_status_is_not_routed_to_external_clients() {
    assert!(!METHODS.contains(&"backend.ensure") && !METHODS.contains(&"backend.status"));
}

#[tokio::test(flavor = "current_thread")]
async fn native_skill_creator_requires_exact_available_builtin_without_node() {
    tokio::task::LocalSet::new().run_until(async {
        let root=tempfile::tempdir().unwrap();
        let descriptor=crate::builtin_skills::descriptor(&root.path().join("data")).unwrap();
        let revision=descriptor["skill"]["revision"].clone();
        let available=Rc::new(std::cell::Cell::new(true));let observed=available.clone();
        let (host,source,server,close)=setup_archive_fixture(root.path(),move|method,params|{
            Some(json!({"result":match method {
                "initialize"=>json!({}),
                "areal/skill/list"=>{
                    assert_eq!(params["agentProfile"],json!({"id":"custom","revision":"v1"}));
                    json!({"data":[{"id":crate::builtin_skills::ID,"revision":revision,"available":observed.get()}]})
                },
                other=>panic!("unexpected {other}"),
            }}))
        }).await;
        let registration=host.slots.borrow()["project"].registration.clone();
        let directory=host.home.join("host/launch").join(storage::digest(b"project"));storage::private_dir(&directory).unwrap();
        let deployment=directory.join("external.json");storage::write(&deployment,&json!({"profiles":[{"id":"custom","revision":"v1"}]})).unwrap();
        storage::write(&directory.join("inputs.json"),&crate::LaunchInputs {
            workspace:registration.workspace.clone(),cwd:registration.workspace,config_home:root.path().join("data"),homedir:None,config_path:None,
            deployment_path:Some(deployment),schedule_preparation:None,environment:Default::default(),credential_names:vec![],options:Default::default(),
        }).unwrap();
        let request=json!({"params":{"sourceId":source,"command":"prepareCreator","request":{"projectId":TEST_PROJECT_ALIAS,"profile":{"id":"custom","revision":"v1"}}}});
        let result=desktop_command(&host,"local","creator",&request).await.unwrap();
        assert_eq!(result["skill"],descriptor["skill"]);assert_eq!(result["provenance"],descriptor["provenance"]);
        available.set(false);
        assert!(desktop_command(&host,"local","creator",&request).await.is_err());
        close();server.await.unwrap();
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn prepared_creation_cannot_rebind_to_a_later_core_generation() {
    tokio::task::LocalSet::new().run_until(async {
        let root=tempfile::tempdir().unwrap();
        let (host,source,server,close)=setup_archive_fixture(root.path(),|method,_|Some(json!({"result":match method {
            "initialize"|"areal/server/status"=>json!({}),
            "areal/capabilities"=>json!({"methods":["areal/thread/start","areal/request/read"],"features":{"threadCreationJournal":{"binding":{"identity":"fixture","journalEpoch":"epoch","coreInstanceId":"fixture"}}}}),
            other=>panic!("unexpected {other}"),
        }}))).await;
        let registration=host.slots.borrow()["project"].registration.clone();
        let directory=host.home.join("host/launch").join(storage::digest(b"project"));storage::private_dir(&directory).unwrap();
        storage::write(&directory.join("inputs.json"),&crate::LaunchInputs{
            workspace:registration.workspace.clone(),cwd:registration.workspace,config_home:root.path().join("data"),homedir:None,config_path:None,deployment_path:None,schedule_preparation:None,environment:Default::default(),credential_names:vec![],options:Default::default(),
        }).unwrap();
        let id=uuid::Uuid::new_v4().to_string();let request=json!({"projectId":TEST_PROJECT_ALIAS,"requestId":id,"browserEnabled":false});
        host.gateway.workbench.prepare_execution(&host,"owner","project","workbench/thread/create",request.clone()).await.unwrap().unwrap();
        let path=super::super::library_store::source_home(&host,&source).unwrap().join("worktree-requests").join(format!("{id}.json"));
        let mut original:Value=storage::read(&path).unwrap();original["preparedCore"]["generation"]=json!("original-retired-generation");storage::write(&path,&original).unwrap();
        let frozen=std::fs::read(&path).unwrap();
        assert!(host.gateway.workbench.prepare_execution(&host,"owner","project","workbench/thread/create",request).await.is_err());
        assert_eq!(std::fs::read(path).unwrap(),frozen);
        close();server.await.unwrap();
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn recovery_inspection_uses_host_space_owner_without_node() {
    tokio::task::LocalSet::new().run_until(async {
        let root=tempfile::tempdir().unwrap();
        let (host,source,server,close)=setup_archive_fixture(root.path(),|method,_|Some(json!({"result":match method {
            "initialize"|"areal/server/status"=>json!({}),
            other=>panic!("unexpected recovery RPC {other}"),
        }}))).await;
        let request=json!({"params":{"sourceId":source,"command":"recovery","request":{"operation":"inspect"}}});
        let result=desktop_command(&host,"local","recovery-reader",&request).await.unwrap();
        assert_eq!(result,json!({"kind":"none"}));
        let mut invalid=request;
        invalid["params"]["request"]["unexpected"]=json!(true);
        assert!(desktop_command(&host,"local","recovery-reader",&invalid).await.is_err());
        close();server.await.unwrap();
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn native_connect_keeps_explicit_stop_and_reconciles_unknown_activation() {
    tokio::task::LocalSet::new().run_until(async {
        let root=tempfile::tempdir().unwrap();
        let (host,source,server,close)=setup_archive_fixture(root.path(),|method,_|Some(json!({"result":match method {
            "initialize"|"areal/server/status"=>json!({}),
            other=>panic!("unexpected connection RPC {other}"),
        }}))).await;
        let mut request=json!({"params":{"sourceId":source,"command":"connect","request":{"projectId":TEST_PROJECT_ALIAS}}});
        let ready=desktop_command(&host,"local","native-connection",&request).await.unwrap();
        assert_eq!(ready["projectId"],"project");
        assert_eq!(ready["serviceGeneration"],"gen-1");
        host.schedules.suppress("project",true).unwrap();
        assert!(desktop_command(&host,"local","native-connection",&request).await.is_err());
        assert!(host.schedules.suppressed("project"));
        let original=uuid::Uuid::new_v4().to_string();
        storage::write(&crate::wire::operation_path(&host.home,&original),&json!({
            "digest":"original", "receipt":{"requestId":original,"method":"project.ensure","projectId":"project","state":"acceptedPending"},"evidence":{}
        })).unwrap();
        let gate=host.gate("project").unwrap();
        let _starting=gate.write().await;
        request["params"]["request"]["resumeScheduling"]=json!(true);
        for _ in 0..2 {
            let pending=desktop_command(&host,"local","native-connection",&request).await.unwrap();
            assert_eq!(pending["activationId"],original);
            assert_eq!(pending["state"],"pending");
        }
        assert!(host.schedules.suppressed("project"));
        assert_eq!(storage::json_records(&host.home.join("host/operations"),false).unwrap().len(),1);
        close();server.await.unwrap();
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn explicit_native_resume_records_intent_and_original_failed_activation() {
    tokio::task::LocalSet::new().run_until(async {
        let root=tempfile::tempdir().unwrap();
        let (host,source,server,close)=setup_archive_fixture(root.path(),|method,_|Some(json!({"result":match method {
            "initialize"|"areal/server/status"=>json!({}),
            other=>panic!("unexpected connection RPC {other}"),
        }}))).await;
        host.schedules.suppress("project",true).unwrap();
        // 已损坏的启动配置应明确结算失败；恢复意图仍属于同一份持久受理记录。
        let path=host.home.join("host/launch").join(storage::digest(b"project")).join("inputs.json");
        storage::private_dir(path.parent().unwrap()).unwrap();
        storage::write(&path,&json!({})).unwrap();
        let request=json!({"params":{"sourceId":source,"command":"connect","request":{"projectId":TEST_PROJECT_ALIAS,"resumeScheduling":true}}});
        let result=desktop_command(&host,"local","native-connection",&request).await.unwrap();
        assert_eq!(result["state"],"blocked");
        let activation=result["activationId"].as_str().unwrap();
        let record=host.receipt(activation).unwrap().unwrap();
        assert_eq!(record.receipt["method"],"project.ensure");
        assert_eq!(record.receipt["projectId"],"project");
        assert_eq!(record.receipt["state"],"blocked");
        assert!(!host.schedules.suppressed("project"));
        assert!(!super::super::schedules::Schedules::load(&host.home).unwrap().suppressed("project"));
        close();server.await.unwrap();
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn attachment_inventory_and_release_do_not_start_node_or_repeat_original_request() {
    tokio::task::LocalSet::new().run_until(async {
        let root=tempfile::tempdir().unwrap();
        let workspace=root.path().canonicalize().unwrap().join("project");
        let count=Rc::new(std::cell::Cell::new(0));
        let dispatched=count.clone();
        let uri=format!("areal://blob/{}", "a".repeat(64));
        let upload=json!({"uri":uri,"mimeType":"image/png","sizeBytes":123});
        let stored=upload.clone();
        let (host,source,server,close)=setup_archive_fixture(root.path(),move |method,params| match method {
            "initialize" | "areal/server/status" => Some(json!({"result":{}})),
            "areal/task/list" => Some(json!({"result":{"data":[],"nextCursor":null}})),
            "thread/read" => {
                assert_eq!(params["threadId"],"t");
                assert_eq!(params["includeTurns"],false);
                Some(json!({"result":{"thread":{"id":"t","sessionId":"s-1","cwd":workspace,"turns":[],"conversation":{"kind":"ordinary","policy":{"kind":"ordinaryV1"}},"desktop":{"archived":false,"uploads":[stored]}}}}))
            }
            "areal/capabilities" => Some(json!({"result":{"methodSemantics":{"areal/blob/release":{"effect":"mutation","receipt":"management"}}}})),
            "areal/blob/release" => {
                dispatched.set(dispatched.get()+1);
                assert_eq!(params["threadId"],"t");
                assert_eq!(params["uri"],stored["uri"]);
                assert!(params["requestId"].is_string());
                Some(json!({"result":{"released":true}}))
            }
            "areal/request/read" => Some(json!({"result":{}})),
            other=>panic!("unexpected {other}"),
        }).await;
        let original=uuid::Uuid::new_v4().to_string();
        let mut call=json!({"params":{"sourceId":source,"command":"media","request":{"projectId":TEST_PROJECT_ALIAS,"threadId":"t","operation":"list"}}});
        assert_eq!(desktop_command_capability(&call["params"]), None);
        let listed=desktop_command(&host,"local","native-media",&call).await.unwrap();
        assert_eq!(listed,json!({"uploads":[upload],"archived":false}));
        call["params"]["request"]["operation"]=json!("release");
        call["params"]["request"]["uri"]=json!(uri);
        call["params"]["request"]["requestId"]=json!(original);
        assert_eq!(desktop_command_capability(&call["params"]), Some("submit"));
        assert_eq!(desktop_command(&host,"local","native-media",&call).await.unwrap(),json!({"released":true}));
        assert!(desktop_command(&host,"local","native-media",&call).await.is_err());
        assert_eq!(count.get(),1);
        assert!(crate::server::workbench_submissions::find(&host,"project",&original).unwrap().is_some());
        close();server.abort();
    }).await;
}
