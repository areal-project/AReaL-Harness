use super::*;

#[tokio::test(flavor = "current_thread")]
async fn supervised_workbench_connection_is_not_an_external_client() {
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let (host, input, _) = resumable_host(&root);
        let socket = root.join("host-client.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let accepting = host.clone();
        let server = tokio::task::spawn_local(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let host = accepting.clone();
                tokio::task::spawn_local(async move { let _ = crate::server::connection_loop(host, stream).await; });
            }
        });
        storage_write_fixture(&root, &host, &socket);
        let backend = host.gateway.workbench.ensure_backend(&host, input).await.unwrap();
        let pid = backend["pid"].as_u64().unwrap() as u32;
        assert!(host.clients.borrow().values().any(|value| *value == Some(pid)));
        assert!(!host.has_external_clients(), "Host-owned Node must not veto release");
        let mut external = tokio::net::UnixStream::connect(&socket).await.unwrap();
        crate::wire::write(&mut external, &json!({"version":1,"id":"external","method":"hello","params":{"protocolVersions":[1],"capabilities":[],"authToken":host.token}})).await.unwrap();
        let mut external = tokio::io::BufReader::new(external);
        crate::wire::read(&mut external).await.unwrap().unwrap();
        assert!(host.has_external_clients(), "an authenticated external client still retains Host");
        drop(external);
        tokio::time::timeout(Duration::from_secs(5), async {
            while host.has_external_clients() { tokio::task::yield_now().await; }
        }).await.unwrap();
        host.gateway.workbench.stop_backend().await;
        server.abort();
    }).await;
}

fn storage_write_fixture(root: &Path, host: &Host, socket: &Path) {
    let runner = root.join("services/workbench/src/backend-main.cjs");
    areal_local_service::storage::write(
        &runner.with_extension("json"),
        &json!({"socket":socket,"token":host.token}),
    )
    .unwrap();
    std::fs::write(runner, r#"
const config = require('./backend-main.json');
const out = frame => console.log(JSON.stringify({version:1,...frame}));
let connection;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.method !== 'backend.start') return;
  connection = require('node:net').createConnection(config.socket, () => {
    connection.write(JSON.stringify({version:1,id:'owned',method:'hello',params:{protocolVersions:[1],capabilities:[],authToken:config.token}})+'\n');
  });
  connection.once('data', () => out({event:'ready',methods:[],service:{pid:process.pid,identity:String(process.pid)}}));
}).on('close', () => connection?.end());
"#).unwrap();
}

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

#[tokio::test(flavor = "current_thread")]
async fn successor_host_recovers_a_crashed_backend_discovery() {
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let (old, input, _) = resumable_host(&root);
        let runner = root.join("services/workbench/src/backend-main.cjs");
        let source = r#"
const fs = require('node:fs');
const lines = require('node:readline').createInterface({input:process.stdin});
lines.on('line', line => {
 const frame = JSON.parse(line);
 if (frame.method === 'backend.start') {
  const service = {pid:process.pid,identity:'backend',desktopGeneration:String(process.pid),owner:frame.params.owner};
  fs.writeFileSync(frame.params.options.home+'/service.json',JSON.stringify(service),{flag:'wx',mode:0o600});
  console.log(JSON.stringify({version:1,event:'ready',methods:['crash'],service}));
 } else if (frame.method === 'crash') process.kill(process.pid,'SIGKILL');
});
lines.on('close',()=>process.exit(0));
"#;
        std::fs::write(&runner, source).unwrap();
        old.gateway.workbench.ensure_backend(&old, input).await.unwrap();
        let child = old.gateway.workbench.backend.running.borrow().clone().unwrap();
        assert!(child.request("crash", json!({}), json!({})).await.is_err());
        child.stop().await.unwrap();
        let original = std::fs::read(root.join("data/service.json")).unwrap();
        let host_id = old.identity.host_id.clone();
        drop(child);
        drop(old);
        let (mut next, input, _) = resumable_host(&root);
        Rc::get_mut(&mut next).unwrap().identity.host_id = host_id;
        std::fs::write(&runner, source).unwrap();
        let owner = next.gateway.workbench.ensure_backend(&next, input).await.unwrap();
        assert_ne!(std::fs::read(root.join("data/service.json")).unwrap(), original);
        assert_eq!(owner["generation"], next.identity.generation);
        next.gateway.workbench.stop_backend().await;
        assert!(!root.join("data/service.json").exists());
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn inherited_backend_lease_blocks_another_host_after_parent_handle_closes() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let root = root.path().canonicalize().unwrap();
            let (old, input, _) = resumable_host(&root);
            old.gateway
                .workbench
                .ensure_backend(&old, input)
                .await
                .unwrap();
            let lease =
                areal_local_service::storage::open_private(&root.join("data/backend.lock"), false)
                    .unwrap();
            assert!(
                fs2::FileExt::try_lock_exclusive(&lease).is_err(),
                "the child must retain the lease after Backend::start returns"
            );
            old.gateway.workbench.stop_backend().await;
            fs2::FileExt::try_lock_exclusive(&lease).unwrap();
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn successor_host_recovers_a_claim_left_before_ready() {
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let (old, input, _) = resumable_host(&root);
        let runner = root.join("services/workbench/src/backend-main.cjs");
        std::fs::write(&runner, r#"
const fs=require('node:fs');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const frame=JSON.parse(line);
 fs.writeFileSync(frame.params.options.home+'/service.json',JSON.stringify({state:'starting',pid:process.pid,owner:frame.params.owner}),{flag:'wx',mode:0o600});
 process.kill(process.pid,'SIGKILL');
});
"#).unwrap();
        assert!(old.gateway.workbench.ensure_backend(&old, input).await.is_err());
        assert!(root.join("data/service.json").exists());
        let host_id = old.identity.host_id.clone();
        drop(old);
        let (mut next, input, _) = resumable_host(&root);
        Rc::get_mut(&mut next).unwrap().identity.host_id = host_id;
        next.gateway.workbench.ensure_backend(&next, input).await.unwrap();
        assert!(!root.join("data/service.json").exists(), "the fixture successor publishes no discovery file");
        next.gateway.workbench.stop_backend().await;
    }).await;
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
async fn stopped_backend_retires_only_its_own_discovery_record_after_child_exit() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for changed in [None, Some("pid"), Some("identity"), Some("desktopGeneration")] {
                let root = tempfile::tempdir().unwrap();
                let root = root.path().canonicalize().unwrap();
                let (host, input, _) = resumable_host(&root);
                std::fs::write(
                    root.join("services/workbench/src/backend-main.cjs"),
                    r#"
const fs = require('node:fs');
const lines = require('node:readline').createInterface({input:process.stdin});
lines.on('line', line => {
    const frame = JSON.parse(line);
    if (frame.method !== 'backend.start') return;
    const service = {pid:process.pid, identity:'owned-backend', desktopGeneration:'owned-generation', owner:frame.params.owner};
    fs.writeFileSync(frame.params.options.home + '/service.json', JSON.stringify(service), {flag:'wx',mode:0o600});
    console.log(JSON.stringify({version:1,event:'ready',methods:[],service}));
});
// 真实退出，但保留发现记录，模拟关闭异常或来不及执行子进程 finally。
lines.on('close', () => process.exit(1));
"#,
                )
                .unwrap();
                let path = root.join("data/service.json");
                let owner = host
                    .gateway
                    .workbench
                    .ensure_backend(&host, input)
                    .await
                    .unwrap();
                let mut record: Value = areal_local_service::storage::read(&path).unwrap();
                assert_eq!(record["pid"], owner["pid"]);
                if let Some(field) = changed {
                    record[field] = if field == "pid" {
                        json!(std::process::id())
                    } else {
                        json!("another-owner")
                    };
                    areal_local_service::storage::write(&path, &record).unwrap();
                }
                host.gateway.workbench.stop_backend().await;
                if changed.is_none() {
                    assert!(
                        !path.exists(),
                        "a confirmed child exit must release its discovery record before the Host exits"
                    );
                } else {
                    assert_eq!(
                        areal_local_service::storage::read::<Value>(&path)
                            .unwrap(),
                        record,
                        "stopping one backend must preserve a different discovery owner"
                    );
                }
            }
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn native_catalog_reads_restore_saved_source_without_starting_workbench() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let root = root.path().canonicalize().unwrap();
            let (host, input, source) = resumable_host(&root);
            storage::private_dir(launch_record(&host).parent().unwrap()).unwrap();
            storage::write(&launch_record(&host), &input).unwrap();
            std::fs::write(
                root.join("services/workbench/src/backend-main.cjs"),
                "throw new Error('native reads must not launch Node');",
            )
            .unwrap();
            assert!(host.gateway.workbench.active_source().is_none());
            for (method, operation) in [("tasks.read", "list"), ("worktree.read", "worktreeList")] {
                let request =
                    json!({"method":method,"params":{"sourceId":source,"operation":operation}});
                let value = backend_read(&host, "web:fixture", &request).await.unwrap();
                if method == "tasks.read" {
                    assert_eq!(value["data"], json!([]));
                    assert_eq!(value["errors"], json!([]));
                    assert_eq!(value["hasMore"], false);
                } else {
                    assert_eq!(value["projects"], json!([]));
                    assert_eq!(value["settings"]["branchPrefix"], "areal");
                }
                assert_eq!(host.gateway.workbench.active_source(), Some(source.clone()));
                assert!(host.gateway.workbench.backend.running.borrow().is_none());
                let mut forged = request;
                forged["params"]["sourceId"] = json!("forged");
                assert_eq!(
                    backend_read(&host, "web:fixture", &forged)
                        .await
                        .unwrap_err()
                        .to_string(),
                    "FORBIDDEN"
                );
            }
            assert!(host.gateway.workbench.utility_options(&source).is_ok());
            assert!(!root.join("data/service.json").exists());
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
        let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap();
        let runner_root = root.path().join("runner");
        std::fs::create_dir_all(&runner_root).unwrap();
        let contract = app.join("node_modules/@areal/workbench");
        std::fs::create_dir_all(&contract).unwrap();
        for file in ["backend-main.cjs", "channel.cjs", "pages.cjs"] {
            std::fs::copy(repository.join("services/workbench/src").join(file), runner_root.join(file)).unwrap();
        }
        std::fs::write(contract.join("package.json"), r#"{"exports":{"./desktop-contract":"./contract.cjs","./desktop-contract/shared":"./shared.cjs"}}"#).unwrap();
        for (shim, source) in [("contract.cjs", "desktop-contract.cjs"), ("shared.cjs", "desktop-contract/shared.cjs")] {
            let path = repository.join("clients/gui/packages/workbench/client").join(source);
            std::fs::write(contract.join(shim), format!("module.exports = require({});", serde_json::to_string(&path).unwrap())).unwrap();
        }
        let runner = runner_root.join("backend-main.cjs");
        let data = root.path().join("data");
        std::fs::create_dir(&data).unwrap();
        let (backend, _) = Workbench::start_with(&runtime, &runner, root.path(), reverse(&host), Some(("backend.start", json!({
            "appRoot":app,"options":{"home":data,"userHome":root.path()},
        }))), &[]).await.unwrap();
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

#[tokio::test(flavor = "current_thread")]
async fn provider_catalog_reads_configuration_without_opening_credentials() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path().canonicalize().unwrap();
    let (mut host, input, source) = resumable_host(&root);
    let vault = crate::vault::Vault::isolated_files(&host.home);
    Rc::get_mut(&mut Rc::get_mut(&mut host).unwrap().migration)
        .unwrap()
        .vault = vault;
    let reference = "AREAL_CREDENTIAL_catalog_fixture";
    host.migration
        .vault
        .dispatch(
            "vault.replace",
            json!({
                "requestId":uuid::Uuid::new_v4().to_string(),
                "expectedGeneration":host.identity.generation,
                "slot":{"kind":"providerCredential","sourceId":source,"reference":reference},
                "expectedRevision":0,"value":"synthetic-secret"
            }),
            &host.identity.generation,
            &host.migration,
        )
        .unwrap();
    std::fs::create_dir(root.join(".areal")).unwrap();
    std::fs::write(root.join(".areal/config.toml"), format!(
        "schema_version=1\n[model]\nprovider='fixture'\nname='fixture'\n[model.providers.fixture]\nendpoint='http://example.invalid/v1/responses'\nprotocol='responses'\napi_key_env='{reference}'\n"
    )).unwrap();
    let started = std::time::Instant::now();
    let result = crate::server::workbench_utility::execute_with_options(
        &host,
        &source,
        json!({"operation":"modelsCatalog"}),
        input.options.clone(),
    )
    .await
    .unwrap();
    assert!(started.elapsed() < std::time::Duration::from_millis(300));
    assert_eq!(result["data"][0]["id"], "fixture");
    assert_eq!(result["credentialStates"]["fixture"], "checking");
    assert_eq!(result["credentialSources"]["fixture"], "stored");
    assert!(!result.to_string().contains("synthetic-secret"));
    eprintln!("provider catalog elapsed: {:?}", started.elapsed());
    let execution = crate::server::workbench_utility::execute_with_options(
        &host,
        &source,
        json!({"operation":"modelsRead"}),
        input.options,
    )
    .await
    .unwrap();
    assert_eq!(
        execution["snapshot"]["credentialStates"]["fixture"],
        "available"
    );
    assert!(
        !execution["snapshot"]
            .to_string()
            .contains("synthetic-secret")
    );
    assert_eq!(execution["credentials"]["references"], json!([reference]));
    assert_eq!(
        execution["credentials"]["values"][reference],
        "synthetic-secret"
    );
    assert_eq!(execution["credentials"]["errors"], json!({}));
}
