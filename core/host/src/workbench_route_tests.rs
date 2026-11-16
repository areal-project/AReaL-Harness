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
            for (method, operation) in [
                ("tasks.read", "list"),
                ("worktree.read", "worktreeList"),
                ("providers.read", "list"),
            ] {
                let request =
                    json!({"method":method,"params":{"sourceId":source,"operation":operation}});
                let value = backend_read(&host, "web:fixture", &request).await.unwrap();
                if method == "tasks.read" {
                    assert_eq!(value["data"], json!([]));
                    assert_eq!(value["errors"], json!([]));
                    assert_eq!(value["hasMore"], false);
                } else if method == "worktree.read" {
                    assert_eq!(value["projects"], json!([]));
                    assert_eq!(value["settings"]["branchPrefix"], "areal");
                } else {
                    assert!(value["data"].is_array());
                    assert_eq!(value["application"]["kind"], "saved");
                    assert!(
                        value["definitions"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|row| row["id"] == "custom-compatible")
                    );
                    assert!(value.get("credentials").is_none());
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
async fn cold_native_provider_read_and_managed_requests_restore_the_persisted_launch() {
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
            let result = backend_read(&host, "web:fixture", &request).await.unwrap();
            assert_eq!(result["projects"], json!([]));
            assert_eq!(result["application"]["kind"], "saved");
            assert!(host.gateway.workbench.backend.running.borrow().is_none());
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
            assert_eq!(backend.request("feedback.read", json!({"code":code}), json!({})).await.unwrap_err().to_string(), expected);
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
async fn reverse_calls_reject_removed_analytics_ports() {
    let root = tempfile::tempdir().unwrap();
    let host = Rc::new(crate::server::schedules::tests::fixture(root.path()));
    let reverse = reverse(&host);
    for (call, params) in [
        ("projects.list", json!({})),
        (
            "core.request",
            json!({"projectId":"project","method":"thread/read","params":{}}),
        ),
        ("vault.read", json!({"slot":"x"})),
    ] {
        assert_eq!(
            reverse(call.into(), params).await.unwrap_err().to_string(),
            "FORBIDDEN"
        );
    }
}

#[test]
fn restarts_back_off_and_stop_after_five_failures() {
    let supervisor = Backend::default();
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

#[tokio::test(flavor = "current_thread")]
async fn native_provider_settings_publish_credential_checks_and_invalidate_same_reference() {
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let (mut host, input, source) = resumable_host(&root);
        Rc::get_mut(&mut Rc::get_mut(&mut host).unwrap().migration).unwrap().vault = crate::vault::Vault::isolated_files(&host.home);
        storage::private_dir(launch_record(&host).parent().unwrap()).unwrap();
        storage::write(&launch_record(&host), &input).unwrap();
        std::fs::write(root.join("services/workbench/src/backend-main.cjs"), "throw new Error('provider settings must not launch Node');").unwrap();
        std::fs::create_dir(root.join(".areal")).unwrap();
        std::fs::write(root.join(".areal/config.toml"), "schema_version=1\n[model]\nprovider='fixture'\nname='fixture'\n[model.providers.fixture]\nendpoint='https://api.openai.com/v1/responses'\nprotocol='responses'\napi_key_env='AREAL_CREDENTIAL_fixture'\n[model.providers.raw]\nendpoint='https://example.invalid/custom/'\nprotocol='responses'\n").unwrap();
        let registration = host.slots.borrow()["project"].registration.clone();
        let launch = crate::LaunchInputs {
            workspace:registration.workspace.clone(), cwd:registration.workspace, config_home:host.home.clone(),
            homedir:Some(root.clone()), config_path:None, deployment_path:None, schedule_preparation:None,
            environment:Default::default(), credential_names:vec![], options:Default::default(),
        };
        let launch_path = host.home.join("host/launch").join(storage::digest(b"project")).join("inputs.json");
        storage::private_dir(launch_path.parent().unwrap()).unwrap();
        storage::write(&launch_path, &launch).unwrap();
        let slot = json!({"kind":"providerCredential","sourceId":source,"reference":"AREAL_CREDENTIAL_fixture"});
        let replace = |revision, value|host.migration.vault.dispatch("vault.replace", json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":host.identity.generation,"slot":slot,"expectedRevision":revision,"value":value}), &host.identity.generation,&host.migration).unwrap();
        replace(0, json!("synthetic-provider-secret"));
        let request = json!({"method":"providers.read","params":{"sourceId":source,"operation":"list"}});
        let mut changes = host.changes.subscribe();
        let initial = backend_read(&host,"web:fixture",&request).await.unwrap();
        assert_eq!(initial["credentialStates"]["fixture"], "checking");
        assert_eq!(initial["projects"][0]["projectId"], storage::digest(b"host:project")[..24]);
        assert_eq!(initial["data"][0]["baseUrl"], "https://api.openai.com/v1");
        let raw = initial["data"].as_array().unwrap().iter().find(|row|row["id"]=="raw").unwrap();
        assert_eq!(raw["baseUrl"], "https://example.invalid/custom/");
        let first_revision = host.gateway.workbench.provider_revision(&host, &source).unwrap();
        tokio::time::timeout(Duration::from_secs(5),changes.changed()).await.unwrap().unwrap();
        let ready = backend_read(&host,"web:fixture",&request).await.unwrap();
        assert_eq!(ready["credentialStates"]["fixture"], "available");
        assert_eq!(ready["refreshing"], false);
        assert_ne!(host.gateway.workbench.provider_revision(&host, &source).unwrap(), first_revision);
        assert!(!ready.to_string().contains("synthetic-provider-secret"));
        let ready_revision = host.gateway.workbench.provider_revision(&host, &source).unwrap();
        replace(1, Value::Null);
        let checking = backend_read(&host,"web:fixture",&request).await.unwrap();
        assert_eq!(checking["credentialStates"]["fixture"], "checking");
        assert_ne!(host.gateway.workbench.provider_revision(&host, &source).unwrap(), ready_revision);
        tokio::time::timeout(Duration::from_secs(5),changes.changed()).await.unwrap().unwrap();
        let missing = backend_read(&host,"web:fixture",&request).await.unwrap();
        assert_eq!(missing["credentialStates"]["fixture"], "unavailable");
        assert!(host.gateway.workbench.backend.running.borrow().is_none());
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn native_provider_settings_import_legacy_configuration_once_without_node() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let root = root.path().canonicalize().unwrap();
            storage::private_dir(&root.join("data")).unwrap();
            storage::write(
                &root.join("data/providers.json"),
                &json!({"data":[{
            "id":"old","name":"Imported provider","baseUrl":"https://example.invalid/custom/",
            "protocol":"responses","enabled":true,"parameters":{},
            "models":[{"id":"fixture","enabled":true,"parameters":{}}]
        }],"retired":[]}),
            )
            .unwrap();
            let (host, input, source) = resumable_host(&root);
            storage::private_dir(launch_record(&host).parent().unwrap()).unwrap();
            storage::write(&launch_record(&host), &input).unwrap();
            std::fs::write(
                root.join("services/workbench/src/backend-main.cjs"),
                "throw new Error('provider import must not launch Node');",
            )
            .unwrap();
            let request =
                json!({"method":"providers.read","params":{"sourceId":source,"operation":"list"}});
            let first = backend_read(&host, "web:fixture", &request).await.unwrap();
            assert!(
                first["data"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|provider| provider["id"] == "old")
            );
            let mut update = first.clone();
            update["data"] = json!([]);
            let options = host.gateway.workbench.utility_options(&source).unwrap();
            let inputs = super::super::workbench_utility::inputs(&options).unwrap();
            let current = areal_config::models::read(&inputs, &[]).unwrap();
            areal_config::models::write(
                &inputs,
                areal_config::models::ModelConfigurationUpdate {
                    expected_revision: current.revision,
                    data: vec![],
                    default_model: None,
                },
                &[],
            )
            .unwrap();
            let second = backend_read(&host, "web:fixture", &request).await.unwrap();
            assert!(
                !second["data"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|provider| provider["id"] == "old")
            );
            assert!(host.gateway.workbench.backend.running.borrow().is_none());
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn native_provider_import_preserves_conflicting_current_configuration() {
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        storage::private_dir(&root.join("data")).unwrap();
        storage::write(&root.join("data/providers.json"), &json!({"data":[{
            "id":"old","name":"Saved name","baseUrl":"https://example.invalid/v1",
            "protocol":"responses","enabled":true,"parameters":{},"models":[]
        }]})).unwrap();
        storage::private_dir(&root.join(".areal")).unwrap();
        let path = root.join(".areal/config.toml");
        let original = "schema_version=1\n[model.providers.old]\nname='Current name'\nendpoint='https://example.invalid/v1/responses'\nprotocol='responses'\n";
        std::fs::write(&path, original).unwrap();
        let (host, input, source) = resumable_host(&root);
        storage::private_dir(launch_record(&host).parent().unwrap()).unwrap();
        storage::write(&launch_record(&host), &input).unwrap();
        let error = backend_read(&host,"web:fixture",&json!({"method":"providers.read",
            "params":{"sourceId":source,"operation":"list"}})).await.unwrap_err();
        assert!(error.to_string().contains("conflicts with current model configuration"));
        assert_eq!(std::fs::read_to_string(path).unwrap(), original);
        assert!(!root.join("data/model-config-migrations.json").exists());
        assert!(host.gateway.workbench.backend.running.borrow().is_none());
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn provider_configuration_writes_do_not_start_node_and_preserve_original_receipts() {
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let (mut host, input, source) = resumable_host(&root);
        Rc::get_mut(&mut Rc::get_mut(&mut host).unwrap().migration).unwrap().vault = crate::vault::Vault::isolated_files(&host.home);
        host.slots.borrow_mut().get_mut("project").unwrap().registration.source =
            crate::ProjectSource::Gui { profile: input.profile.clone(), legacy_project_id: "logical".into() };
        storage::private_dir(launch_record(&host).parent().unwrap()).unwrap();
        storage::write(&launch_record(&host), &input).unwrap();
        std::fs::write(root.join("services/workbench/src/backend-main.cjs"), "throw new Error('provider writes must not launch Node');").unwrap();
        std::fs::create_dir(root.join(".areal")).unwrap();
        std::fs::write(root.join(".areal/config.toml"), "schema_version=1\n[model]\nprovider='fixture'\nname='fixture'\n[model.providers.fixture]\nendpoint='https://example.invalid/custom/'\nprotocol='responses'\napi_key_env='CLI_FIXTURE_KEY'\nmodels=[{id='fixture'}]\n").unwrap();
        let list = json!({"method":"providers.read","params":{"sourceId":source,"operation":"list"}});
        let initial = backend_read(&host,"web:fixture",&list).await.unwrap();
        let command = uuid::Uuid::new_v4().to_string();
        let save = json!({"method":"providers.command","commandId":command,"params":{"sourceId":source,
            "operation":"saveAndApply","expectedRevision":initial["revision"],
            "provider":{"id":"fixture","name":" Renamed ","baseUrl":"https://example.invalid/custom/","protocol":"responses",
                "models":[{"id":" fixture ","enabled":true,"parameters":{"serviceTier":"default"},"reportedContextWindowTokens":64000,
                    "capabilities":{"tools":false,"vision":true,"reasoning":false}}],"enabled":true,"parameters":{"serviceTier":"fast"}}}});
        // 模型配置保存不应被其他项目的执行状态或生命周期锁阻塞。
        let gate = host.slots.borrow()["project"].gate.clone();
        let _busy = gate.write().await;
        let saved = backend_command(&host,"web:fixture",&save).await.unwrap();
        assert_eq!(saved["submissionUnknown"],false);
        assert_eq!(saved["receipt"]["data"][0]["name"],"Renamed");
        assert_ne!(saved["receipt"]["revision"],initial["revision"]);
        assert_eq!(saved["receipt"]["data"][0]["parameters"]["serviceTier"],"fast");
        assert_eq!(saved["receipt"]["data"][0]["models"][0]["parameters"]["serviceTier"],"default");
        assert_eq!(saved["receipt"]["data"][0]["models"][0]["reportedContextWindowTokens"],64000);
        assert_eq!(saved["receipt"]["data"][0]["models"][0]["capabilities"],json!({"tools":false,"vision":true,"reasoning":false}));
        assert_eq!(backend_command(&host,"web:fixture",&save).await.unwrap(),saved);
        let (_, intents) = host.journal.native_snapshot(&format!("model-configuration-{}",storage::digest(b"project"))).unwrap();
        assert_eq!(intents["outcomes"][&command]["method"],"host/modelConfiguration/intent");
        let current = backend_read(&host,"web:fixture",&list).await.unwrap();
        assert_eq!(current["data"][0]["baseUrl"],"https://example.invalid/custom/");
        assert_eq!(current["data"][0]["apiKeyEnv"],"CLI_FIXTURE_KEY");
        for invalid_window in [json!(0),json!(2_000_001),json!(1.5)] {
            let mut invalid = save.clone();
            invalid["commandId"] = json!(uuid::Uuid::new_v4().to_string());
            invalid["params"]["expectedRevision"] = current["revision"].clone();
            invalid["params"]["provider"]["models"][0]["reportedContextWindowTokens"] = invalid_window;
            assert_eq!(backend_command(&host,"web:fixture",&invalid).await.unwrap_err().to_string(),"INVALID_PARAMS");
            assert_eq!(backend_read(&host,"web:fixture",&list).await.unwrap()["revision"],current["revision"]);
        }
        let mut missing_key = save.clone();
        missing_key["commandId"] = json!(uuid::Uuid::new_v4().to_string());
        missing_key["params"]["expectedRevision"] = current["revision"].clone();
        missing_key["params"]["provider"].as_object_mut().unwrap().remove("id");
        missing_key["params"]["authentication"] = json!("apiKey");
        assert_eq!(backend_command(&host,"web:fixture",&missing_key).await.unwrap_err().to_string(),"PROVIDER_CREDENTIAL_REQUIRED");
        assert!(host.migration.vault.provider_references(&source).unwrap().is_empty());
        let mut stale = save.clone();
        stale["commandId"] = json!(uuid::Uuid::new_v4().to_string());
        assert_eq!(backend_command(&host,"web:fixture",&stale).await.unwrap_err().to_string(),"TARGET_CHANGED");
        assert_eq!(backend_receipt(&host,"web:fixture",stale["commandId"].as_str().unwrap()).unwrap_err().to_string(),"TARGET_CHANGED");
        let select = json!({"method":"providers.command","commandId":uuid::Uuid::new_v4().to_string(),
            "params":{"sourceId":source,"operation":"defaultAndApply","expectedRevision":current["revision"],
                "model":{"providerId":"fixture","modelId":"fixture"}}});
        let selected = backend_command(&host,"web:fixture",&select).await.unwrap();
        assert_eq!(selected["receipt"]["defaultModel"],json!({"providerId":"fixture","modelId":"fixture"}));
        let mut with_key = save.clone();
        with_key["commandId"] = json!(uuid::Uuid::new_v4().to_string());
        with_key["params"]["expectedRevision"] = selected["receipt"]["revision"].clone();
        with_key["params"]["authentication"] = json!("apiKey");
        with_key["params"]["apiKey"] = json!("synthetic-native-provider-secret");
        let keyed = backend_command(&host,"web:fixture",&with_key).await.unwrap();
        assert_eq!(backend_command(&host,"web:fixture",&with_key).await.unwrap(),keyed);
        assert!(!keyed.to_string().contains("synthetic-native-provider-secret"));
        assert!(!std::fs::read_to_string(root.join(".areal/config.toml")).unwrap().contains("synthetic-native-provider-secret"));
        let references = host.migration.vault.provider_references(&source).unwrap();
        assert_eq!(references.len(),1);
        let key = host.migration.vault.dispatch_async("vault.read", json!({"slot":{
            "kind":"providerCredential","sourceId":source,"reference":references.first().unwrap()},"interactionAllowed":false}),
            &host.identity.generation,&host.migration).await.unwrap();
        assert_eq!(key["value"],"synthetic-native-provider-secret");
        let mut conflict = with_key.clone();
        conflict["params"]["apiKey"] = json!("changed-secret");
        assert_eq!(backend_command(&host,"web:fixture",&conflict).await.unwrap_err().to_string(),"COMMAND_CONFLICT");
        let journal = host.journal.native_snapshot(&format!("workbench-{}",storage::digest(b"web:fixture"))).unwrap().1;
        assert!(!journal.to_string().contains("synthetic-native-provider-secret"));
        let remove = json!({"method":"providers.command","commandId":uuid::Uuid::new_v4().to_string(),
            "params":{"sourceId":source,"operation":"removeAndApply","expectedRevision":keyed["receipt"]["revision"],"id":"fixture"}});
        let removed = backend_command(&host,"web:fixture",&remove).await.unwrap();
        assert!(removed["receipt"]["data"].as_array().unwrap().is_empty());
        assert!(removed["receipt"]["defaultModel"].is_null());
        assert!(host.gateway.workbench.backend.running.borrow().is_none());
        assert!(host.journal.native_snapshot(&format!("workbench-{}",storage::digest(b"web:fixture"))).unwrap().1["pending"].as_array().unwrap().is_empty());
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn provider_write_preserves_desired_configuration_when_core_wakes_during_vault_storage() {
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let (mut host, input, source) = resumable_host(&root);
        let blocked = std::sync::Arc::new(tokio::sync::Notify::new());
        let signal = blocked.clone();
        let (release, released) = std::sync::mpsc::channel::<()>();
        let released = std::sync::Mutex::new(released);
        let mut vault = crate::vault::Vault::isolated_files(&host.home);
        vault.before_write = Some(std::sync::Arc::new(move || {
            signal.notify_one();
            let _ = released.lock().unwrap().recv();
        }));
        Rc::get_mut(&mut Rc::get_mut(&mut host).unwrap().migration).unwrap().vault = vault;
        host.slots.borrow_mut().get_mut("project").unwrap().registration.source =
            crate::ProjectSource::Gui { profile: input.profile.clone(), legacy_project_id: "logical".into() };
        storage::private_dir(launch_record(&host).parent().unwrap()).unwrap();
        storage::write(&launch_record(&host), &input).unwrap();
        std::fs::create_dir(root.join(".areal")).unwrap();
        let config = root.join(".areal/config.toml");
        std::fs::write(&config,"schema_version=1\n[model]\nprovider='fixture'\nname='fixture'\n[model.providers.fixture]\nendpoint='https://example.invalid/v1/responses'\nprotocol='responses'\nmodels=[{id='fixture'}]\n").unwrap();
        let initial = backend_read(&host,"web:fixture",&json!({"method":"providers.read","params":{"sourceId":source,"operation":"list"}})).await.unwrap();
        let command = uuid::Uuid::new_v4().to_string();
        let request = json!({"method":"providers.command","commandId":command,"params":{"sourceId":source,
            "operation":"save","expectedRevision":initial["revision"],"authentication":"apiKey","apiKey":"synthetic-racing-secret",
            "provider":{"id":"fixture","name":"Changed","baseUrl":"https://example.invalid/v1","protocol":"responses","models":[{"id":"fixture"}]}}});
        let writing = { let host = host.clone(); tokio::task::spawn_local(async move {
            backend_command(&host,"web:fixture",&request).await
        }) };
        tokio::time::timeout(Duration::from_secs(5),blocked.notified()).await.unwrap();
        host.slots.borrow_mut().get_mut("project").unwrap().state = "starting".into();
        release.send(()).unwrap();
        let saved = writing.await.unwrap().unwrap();
        assert_eq!(saved["submissionUnknown"], false);
        assert_eq!(saved["receipt"]["data"][0]["name"], "Changed");
        assert_ne!(saved["receipt"]["application"]["kind"], "applied");
        assert_eq!(backend_receipt(&host,"web:fixture",&command).unwrap().unwrap()["receipt"]["revision"], saved["receipt"]["revision"]);
        let desired = backend_read(&host,"web:fixture",&json!({"method":"providers.read","params":{"sourceId":source,"operation":"list"}})).await.unwrap();
        assert_eq!(desired["revision"], saved["receipt"]["revision"]);
        assert_eq!(desired["data"][0]["name"], "Changed");
        assert!(host.gateway.workbench.backend.running.borrow().is_none());
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn online_provider_save_commits_desired_configuration_without_waiting_for_core() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let (mut host, input, source) = resumable_host(&root);
        Rc::get_mut(&mut Rc::get_mut(&mut host).unwrap().migration).unwrap().vault = crate::vault::Vault::isolated_files(&host.home);
        host.slots.borrow_mut().get_mut("project").unwrap().registration.source =
            crate::ProjectSource::Gui { profile: input.profile.clone(), legacy_project_id: "logical".into() };
        storage::private_dir(launch_record(&host).parent().unwrap()).unwrap();
        storage::write(&launch_record(&host), &input).unwrap();
        std::fs::write(root.join("services/workbench/src/backend-main.cjs"), "throw new Error('online provider save must not launch Node');").unwrap();
        std::fs::create_dir(root.join(".areal")).unwrap();
        std::fs::write(root.join(".areal/config.toml"),"schema_version=1\n[model]\nprovider='fixture'\nname='fixture'\n[model.providers.fixture]\nendpoint='https://example.invalid/v1/responses'\nprotocol='responses'\nmodels=[{id='fixture'}]\n").unwrap();
        host.gateway.workbench.restore_source(&host).unwrap();
        let initial = super::super::workbench_utility::models_catalog(&host,&source,&input.options).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let registration = host.slots.borrow()["project"].registration.clone();
        let service = areal_protocol::service::Service {
            identity: areal_protocol::service::Identity { protocol_version:1,service_id:"online-fixture".into(),generation:"generation".into(),
                workspace:registration.workspace,data_dir:registration.data_dir,config_fingerprint:"fixture".into() },
            owner:Some(host.owner()),endpoint:format!("ws://{}/",listener.local_addr().unwrap()),web_url:String::new(),
            auth_file:host.home.join("online-auth.json"),log_file:host.home.join("online-core.log"),host_pid:1,core_pid:2,state:areal_protocol::service::State::Ready,
        };
        storage::write(&service.auth_file,&json!({"principals":[{"id":"desktop-owner","token":"fixture"}]})).unwrap();
        { let mut slots = host.slots.borrow_mut(); let slot = slots.get_mut("project").unwrap();slot.state="ready".into();slot.service=Some(service.clone()); }
        let (received, mut requests) = tokio::sync::mpsc::unbounded_channel();
        let server = tokio::task::spawn_local(async move {
            let (stream,_) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            while let Some(Ok(Message::Text(text))) = socket.next().await {
                let request:Value = serde_json::from_str(&text).unwrap();
                if request["method"] == "initialize" {
                    socket.send(Message::Text(json!({"id":request["id"],"result":{}}).to_string().into())).await.unwrap();
                } else if request.get("id").is_some() {
                    received.send(request).unwrap();
                    // 已连接 Core 的应用证明一直未返回；保存不能等它，也不能伪称已经应用。
                }
            }
        });
        let close = host.schedules.connections.connect_test_core(host.clone(),"project",service).await.unwrap();
        let request = json!({"method":"providers.command","commandId":uuid::Uuid::new_v4().to_string(),"params":{"sourceId":source,
            "operation":"save","expectedRevision":initial["revision"],"provider":{"id":"fixture","name":"New desired",
                "baseUrl":"https://example.invalid/v1","protocol":"responses","models":[{"id":"fixture"}]}}});
        let saved = tokio::time::timeout(Duration::from_secs(1),backend_command(&host,"web:fixture",&request)).await
            .expect("desired save cannot wait for execution preparation or a Core reply").unwrap();
        assert_eq!(saved["submissionUnknown"],false);
        assert_eq!(saved["receipt"]["data"][0]["name"],"New desired");
        assert_ne!(saved["receipt"]["application"]["kind"],"applied");
        assert_eq!(tokio::time::timeout(Duration::from_secs(5),requests.recv()).await.unwrap().unwrap()["method"],"areal/server/modelConfiguration/read");
        assert!(host.gateway.workbench.backend.running.borrow().is_none());
        close();server.abort();
    }).await;
}
