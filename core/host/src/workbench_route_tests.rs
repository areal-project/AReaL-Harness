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
                out({event:'ready',methods:['providers.read','desktop.command'],service:{pid:process.pid,identity:String(process.pid)}});
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
async fn unused_subscription_reads_do_not_initialize_credentials() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let root = root.path().canonicalize().unwrap();
            let (host, _, source) = resumable_host(&root);
            let (socket, _peer) = std::os::unix::net::UnixStream::pair().unwrap();
            let connection = crate::server::ConnectionGuard {
                host: host.clone(),
                id: "subscription-read".into(),
                socket: socket.as_raw_fd(),
            };
            for _ in 0..2 {
                let state = host
                    .subscription_dispatch(
                        "subscription.read",
                        json!({"sourceId":source}),
                        &connection,
                    )
                    .await
                    .unwrap();
                assert_eq!(state["state"], "signed_out");
                assert_eq!(state["owner"], "legacy");
                assert_eq!(state["accountRevision"], 0);
                assert_eq!(state["transportRevision"], 0);
                assert_eq!(state["accounts"], json!([]));
                assert!(state["endpoint"].is_null());
            }
            assert!(
                host.migration
                    .vault
                    .subscription_owner(&source)
                    .unwrap()
                    .is_none()
            );
            assert!(!host.home.join("host/subscription-operations").exists());
            assert!(host.gateway.workbench.backend.running.borrow().is_none());
        })
        .await;
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
[trajectory]
headers_env="FIXTURE_FEEDBACK_HEADERS"
"#,
    )
    .unwrap();
    let names =
        environment_credential_names(&json!({"home":root.path(), "userHome":root.path()})).unwrap();
    assert_eq!(
        names.into_iter().collect::<Vec<_>>(),
        vec!["FIXTURE_FEEDBACK_HEADERS", "FIXTURE_MODEL_API_KEY"]
    );
    let configured = std::fs::read_to_string(home.join("config.toml")).unwrap();
    std::fs::write(
        home.join("config.toml"),
        configured.replace("FIXTURE_FEEDBACK_HEADERS", "AREAL_CREDENTIAL_saved"),
    )
    .unwrap();
    assert_eq!(
        environment_credential_names(&json!({"home":root.path(), "userHome":root.path()}))
            .unwrap()
            .into_iter()
            .collect::<Vec<_>>(),
        vec!["FIXTURE_MODEL_API_KEY"]
    );
}

#[test]
fn native_frontend_publishes_validated_launch_without_node_or_persisting_credentials() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path().canonicalize().unwrap();
    let (host, input, source) = resumable_host(&root);
    std::fs::remove_dir_all(root.join("services/workbench")).unwrap();
    std::fs::create_dir(root.join(".areal")).unwrap();
    std::fs::write(root.join(".areal/config.toml"), "schema_version=1\n[model]\nprovider='fixture'\nname='fixture'\n[model.providers.fixture]\nendpoint='http://127.0.0.1:1/'\nprotocol='responses'\napi_key_env='FIXTURE_KEY'\n").unwrap();
    let credentials = std::collections::BTreeMap::from([(
        "FIXTURE_KEY".into(),
        "synthetic-native-secret".into(),
    )]);
    let options =
        frontend_options(&host, &source, input.options.clone(), Some(credentials)).unwrap();
    assert_eq!(
        host.gateway.workbench.active_source().as_deref(),
        Some(source.as_str())
    );
    assert_eq!(
        host.gateway.workbench.utility_options(&source).unwrap(),
        options
    );
    assert_eq!(
        host.gateway
            .workbench
            .environment_credentials(&source)
            .get("FIXTURE_KEY")
            .map(String::as_str),
        Some("synthetic-native-secret")
    );
    let persisted = std::fs::read(launch_record(&host)).unwrap();
    assert!(!String::from_utf8_lossy(&persisted).contains("synthetic-native-secret"));
    assert!(!String::from_utf8_lossy(&persisted).contains("environmentCredentials"));
    // 过渡：到 0.2.0 删；次附件仍需核验导入来源的旧目录身份。
    let secondary = crate::migration::Source {
        profile: root.join("secondary-profile"),
        core_home: root.join("secondary-core"),
        legacy_service_home: root.join("secondary-services"),
    };
    // 过渡：到 0.2.0 删；来源目录属于同一次停机导入。
    for directory in [
        &secondary.profile,
        &secondary.core_home,
        &secondary.legacy_service_home,
    ] {
        storage::private_dir(directory).unwrap();
    }
    storage::write(&secondary.core_home.join("projects.json"), &json!([])).unwrap();
    host.migration
        .attach(secondary.clone(), "secondary", None)
        .unwrap();
    let imported = host.migration.import(serde_json::from_value(json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":host.identity.generation,"source":secondary})).unwrap(), "secondary", &[], &host.journal).unwrap();
    assert_eq!(imported["kind"], "ready");
    let secondary_id = host
        .migration
        .navigation_source_id(&secondary.profile)
        .unwrap()
        .unwrap();
    let mut secondary_options = input.options.clone();
    secondary_options["home"] = json!(secondary.core_home);
    secondary_options["guiProfile"] = json!(secondary.profile);
    frontend_options(&host, &secondary_id, secondary_options.clone(), None).unwrap();
    assert_eq!(
        host.gateway.workbench.active_source().as_deref(),
        Some(source.as_str())
    );
    assert_eq!(std::fs::read(launch_record(&host)).unwrap(), persisted);
    let secondary_secret =
        std::collections::BTreeMap::from([("FIXTURE_KEY".into(), "secondary-secret".into())]);
    assert_eq!(
        frontend_options(
            &host,
            &secondary_id,
            secondary_options,
            Some(secondary_secret)
        )
        .unwrap_err()
        .to_string(),
        "CONFLICT"
    );
    assert_eq!(
        host.gateway
            .workbench
            .environment_credentials(&source)
            .get("FIXTURE_KEY")
            .map(String::as_str),
        Some("synthetic-native-secret")
    );
    let forbidden =
        std::collections::BTreeMap::from([("UNDECLARED_KEY".into(), "forbidden".into())]);
    assert_eq!(
        frontend_options(&host, &source, input.options.clone(), Some(forbidden))
            .unwrap_err()
            .to_string(),
        "INVALID_PARAMS"
    );
    assert_eq!(std::fs::read(launch_record(&host)).unwrap(), persisted);
    frontend_options(&host, &source, input.options.clone(), None).unwrap();
    assert!(
        !host
            .gateway
            .workbench
            .environment_credentials(&source)
            .is_empty()
    );
    frontend_options(&host, &source, input.options, Some(Default::default())).unwrap();
    assert!(
        host.gateway
            .workbench
            .environment_credentials(&source)
            .is_empty()
    );
    host.gateway.workbench.backend.source.borrow_mut().take();
    host.gateway
        .workbench
        .backend
        .utility_options
        .borrow_mut()
        .take();
    host.gateway.workbench.restore_source(&host).unwrap();
    assert_eq!(
        host.gateway.workbench.active_source().as_deref(),
        Some(source.as_str())
    );
    assert!(host.gateway.workbench.backend.running.borrow().is_none());
    assert!(!root.join("data/service.json").exists());
}

#[tokio::test(flavor = "current_thread")]
async fn running_backend_accepts_updated_and_explicitly_cleared_environment_credentials() {
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let (host, input, source) = resumable_host(&root);
        std::fs::create_dir(root.join(".areal")).unwrap();
        std::fs::write(root.join(".areal/config.toml"), "schema_version=1\n[model]\nprovider='fixture'\nname='fixture'\n[model.providers.fixture]\nendpoint='http://127.0.0.1:1/'\nprotocol='responses'\napi_key_env='FIXTURE_KEY'\n[trajectory]\nheaders_env='FIXTURE_HEADERS'\n").unwrap();
        host.gateway.workbench.ensure_backend(&host, input.clone()).await.unwrap();
        let mut wire = serde_json::to_value(&input).unwrap();
        wire["environmentCredentials"] = json!({"FIXTURE_KEY":"secret","FIXTURE_HEADERS":"Authorization=Bearer synthetic-header"});
        host.gateway.workbench.ensure_backend(&host, serde_json::from_value(wire.clone()).unwrap()).await.unwrap();
        assert_eq!(host.gateway.workbench.environment_credentials(&source).get("FIXTURE_KEY").map(String::as_str), Some("secret"));
        assert_eq!(host.gateway.workbench.environment_credentials(&source).get("FIXTURE_HEADERS").map(String::as_str), Some("Authorization=Bearer synthetic-header"));
        assert!(!std::fs::read_to_string(launch_record(&host)).unwrap().contains("synthetic-header"));
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
            let desktop = host
                .gateway
                .workbench
                .request(
                    &host,
                    "desktop.command",
                    json!({}),
                    json!({"connection":"fixture"}),
                )
                .await
                .unwrap();
            assert!(desktop["pid"].as_u64().is_some());
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
                    "desktop.command",
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
        for file in ["backend-main.cjs", "channel.cjs"] {
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
            assert_eq!(backend.request("manage.read", json!({"code":code}), json!({})).await.unwrap_err().to_string(), expected);
        }
        backend.stop().await.unwrap();
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn connection_disconnect_is_forwarded_without_a_journal() {
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let host = Rc::new(crate::server::schedules::tests::fixture(root.path()));
        let runtime = std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|path| path.join("node")).find(|path| path.is_file()).expect("Node is required");
        let runner = root.path().join("disconnect.cjs");
        std::fs::write(&runner, r#"
            const out = value => console.log(JSON.stringify({version:1,...value}));
            out({event:'ready',methods:['desktop.command']});
            require('node:readline').createInterface({input:process.stdin}).on('line', line => {
              const frame = JSON.parse(line);
              if (frame.event === 'connection.disconnect') {
                out({id:'disconnected',call:'fixture.disconnected',params:{connection:frame.connection}});
              } else {
                out({id:frame.id,result:{}});
              }
            });
        "#).unwrap();
        let (disconnected, mut disconnects) = tokio::sync::mpsc::unbounded_channel();
        let reverse_call: crate::workbench::Reverse = Rc::new(move |method, params| {
            let disconnected = disconnected.clone();
            Box::pin(async move {
                assert_eq!(method, "fixture.disconnected");
                disconnected.send(params["connection"].clone()).unwrap();
                Ok(json!({}))
            })
        });
        let backend = Workbench::start(&runtime, &runner, root.path(), reverse_call).await.unwrap();
        *host.gateway.workbench.backend.running.borrow_mut() = Some(Rc::new(backend));
        host.gateway.workbench.disconnect_connection(&host, "first");
        let connection = tokio::time::timeout(Duration::from_secs(2), disconnects.recv()).await.unwrap().unwrap();
        assert_eq!(connection, "first");
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
        let reveal = json!({"profile":input.profile,"expectedGeneration":host.identity.generation,
            "id":"fixture","expectedRevision":keyed["receipt"]["revision"]});
        assert_eq!(host.dispatch("providers.revealKey",reveal.clone()).await.unwrap()["apiKey"],
            "synthetic-native-provider-secret");
        let mut stale_reveal = reveal.clone();
        stale_reveal["expectedRevision"] = initial["revision"].clone();
        assert_eq!(host.dispatch("providers.revealKey",stale_reveal).await.unwrap_err().to_string(),"TARGET_CHANGED");
        let mut other_profile = reveal.clone();
        other_profile["profile"] = json!(root.join("other-profile"));
        assert_eq!(host.dispatch("providers.revealKey",other_profile).await.unwrap_err().to_string(),"GUI_SOURCE_PENDING");
        let mut wrong_generation = reveal;
        wrong_generation["expectedGeneration"] = json!("stale");
        assert!(host.dispatch("providers.revealKey",wrong_generation).await.is_err());
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

#[tokio::test(flavor = "current_thread")]
async fn provider_discovery_uses_native_transport_without_node_or_secret_receipts() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let (host, input, source) = resumable_host(&root);
        storage::private_dir(launch_record(&host).parent().unwrap()).unwrap();
        storage::write(&launch_record(&host), &input).unwrap();
        host.gateway.workbench.restore_source(&host).unwrap();
        std::fs::write(root.join("services/workbench/src/backend-main.cjs"), "throw new Error('provider networking must not launch Node');").unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::task::spawn_local(async move {
            let (mut stream,_) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut bytes = [0;4096];let n = stream.read(&mut bytes).await.unwrap();assert!(n>0);
                request.extend_from_slice(&bytes[..n]);
                if request.windows(4).any(|b|b==b"\r\n\r\n") { break; }
                assert!(request.len()<16384);
            }
            let text = String::from_utf8(request).unwrap();
            assert!(text.starts_with("GET /v1/models HTTP/1.1\r\n"));
            assert!(text.to_ascii_lowercase().contains("authorization: bearer synthetic-discovery-secret"));
            let body = json!({"data":[{"id":"fixture","context_window":64000},
                {"id":"echo-synthetic-discovery-secret"},{"id":"fixture","context_window":64000},
                {"id":"other","context_window":2_000_001}]}).to_string();
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).as_bytes()).await.unwrap();
        });
        let command = uuid::Uuid::new_v4().to_string();
        let request = json!({"method":"providers.command","commandId":command,"params":{"sourceId":source,"operation":"discover",
            "connection":{"baseUrl":base,"protocol":"responses","credential":{"kind":"draft","value":"synthetic-discovery-secret"}}}});
        let receipt = backend_command(&host,"web:fixture",&request).await.unwrap();
        assert_eq!(receipt["submissionUnknown"],false);
        assert_eq!(receipt["receipt"],json!({"models":["fixture","other"],"modelParameters":{"fixture":{"contextWindowTokens":64000}}}));
        server.await.unwrap();
        assert_eq!(backend_command(&host,"web:fixture",&request).await.unwrap(),receipt);
        let mut conflict = request.clone();conflict["params"]["connection"]["credential"]["value"]=json!("changed-secret");
        assert_eq!(backend_command(&host,"web:fixture",&conflict).await.unwrap_err().to_string(),"COMMAND_CONFLICT");
        let journal = host.journal.native_snapshot(&format!("workbench-{}",storage::digest(b"web:fixture"))).unwrap().1;
        assert!(!journal.to_string().contains("synthetic-discovery-secret"));
        assert!(host.gateway.workbench.backend.running.borrow().is_none());
        assert!(host.slots.borrow().values().all(|slot|slot.service.is_none()));
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn provider_network_rejection_is_definitive_and_original_receipt_never_resends() {
    use tokio::io::AsyncWriteExt;
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();let root=root.path().canonicalize().unwrap();
        let (host,input,source)=resumable_host(&root);
        storage::private_dir(launch_record(&host).parent().unwrap()).unwrap();storage::write(&launch_record(&host),&input).unwrap();
        host.gateway.workbench.restore_source(&host).unwrap();
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let url=format!("http://{}/v1",listener.local_addr().unwrap());
        let server=tokio::task::spawn_local(async move {
            let (mut stream,_)=listener.accept().await.unwrap();let _head=read_provider_http_head(&mut stream).await;
            stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: /must-not-follow\r\nContent-Length: 16\r\nConnection: close\r\n\r\nprivate-key-echo").await.unwrap();
        });
        let command=uuid::Uuid::new_v4().to_string();
        let request=json!({"method":"providers.command","commandId":command,"params":{"sourceId":source,"operation":"discover",
            "connection":{"baseUrl":url,"protocol":"responses","credential":{"kind":"none"}}}});
        let original=backend_command(&host,"web:fixture",&request).await.unwrap_err();
        let projected = |error:&anyhow::Error| { let error=error.downcast_ref::<crate::wire::Error>().unwrap();json!({"code":error.code,"message":error.message}) };
        let failure=projected(&original);assert_eq!(failure["code"],"RESOURCE_UNAVAILABLE");
        server.await.unwrap();
        let repeated=backend_command(&host,"web:fixture",&request).await.unwrap_err();
        assert_eq!(projected(&repeated),failure);
        let queried=backend_receipt(&host,"web:fixture",&command).unwrap_err();
        assert_eq!(projected(&queried),failure);
        let journal=host.journal.native_snapshot(&format!("workbench-{}",storage::digest(b"web:fixture"))).unwrap().1;
        assert!(journal["pending"].as_array().unwrap().is_empty());assert_eq!(journal["outcomes"][command]["admissionState"],"rejected");
        assert!(!journal.to_string().contains("private-key-echo"));assert!(host.gateway.workbench.backend.running.borrow().is_none());
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn provider_save_discovers_models_natively_before_canonical_write() {
    use tokio::io::AsyncWriteExt;
    tokio::task::LocalSet::new().run_until(async {
        let root=tempfile::tempdir().unwrap();let root=root.path().canonicalize().unwrap();
        let (mut host,input,source)=resumable_host(&root);
        Rc::get_mut(&mut Rc::get_mut(&mut host).unwrap().migration).unwrap().vault=crate::vault::Vault::isolated_files(&host.home);
        storage::private_dir(launch_record(&host).parent().unwrap()).unwrap();storage::write(&launch_record(&host),&input).unwrap();
        std::fs::create_dir(root.join(".areal")).unwrap();
        std::fs::write(root.join(".areal/config.toml"),"schema_version=1\n[model]\nprovider='fixture'\nname='fixture'\n[model.providers.fixture]\nendpoint='https://example.invalid/v1/responses'\nprotocol='responses'\nmodels=[{id='fixture'}]\n").unwrap();
        std::fs::write(root.join("services/workbench/src/backend-main.cjs"),"throw new Error('auto discovery must not start Node');").unwrap();
        let initial=backend_read(&host,"web:fixture",&json!({"method":"providers.read","params":{"sourceId":source,"operation":"list"}})).await.unwrap();
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let url=format!("http://{}/v1",listener.local_addr().unwrap());
        let server=tokio::task::spawn_local(async move {
            for _ in 0..2 {
            let (mut stream,_)=listener.accept().await.unwrap();let head=read_provider_http_head(&mut stream).await;
            assert!(String::from_utf8(head).unwrap().to_ascii_lowercase().contains("authorization: bearer synthetic-native-saved-discovery"));
            let body=json!({"data":[{"id":"discovered","context_window":64000}]}).to_string();
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            }
        });
        let command=uuid::Uuid::new_v4().to_string();let request=json!({"method":"providers.command","commandId":command,"params":{"sourceId":source,"operation":"saveAndApply",
            "expectedRevision":initial["revision"],"authentication":"apiKey","apiKey":"synthetic-native-saved-discovery","provider":{"name":"Native discovered","baseUrl":url,"protocol":"responses","models":[]}}});
        let saved=backend_command(&host,"web:fixture",&request).await.unwrap();assert_eq!(saved["submissionUnknown"],false);
        let provider=saved["receipt"]["data"].as_array().unwrap().iter().find(|row|row["name"]=="Native discovered").unwrap();
        assert_eq!(provider["models"][0]["id"],"discovered");assert_eq!(provider["models"][0]["reportedContextWindowTokens"],64000);
        assert_eq!(provider["models"][0]["capabilities"],json!({"tools":true,"vision":false,"reasoning":true}));
        assert_eq!(saved["receipt"]["defaultModel"],initial["defaultModel"]);
        assert!(!saved.to_string().contains("synthetic-native-saved-discovery"));
        assert!(!std::fs::read_to_string(root.join(".areal/config.toml")).unwrap().contains("synthetic-native-saved-discovery"));
        let provider_id=provider["id"].clone();
        assert_eq!(backend_command(&host,"web:fixture",&request).await.unwrap(),saved);
        let discover=json!({"method":"providers.command","commandId":uuid::Uuid::new_v4().to_string(),"params":{"sourceId":source,"operation":"discover",
            "connection":{"baseUrl":url,"protocol":"responses","credential":{"kind":"saved","providerId":provider_id,"expectedRevision":saved["receipt"]["revision"]}}}});
        let discovered=backend_command(&host,"web:fixture",&discover).await.unwrap();
        assert_eq!(discovered["receipt"]["models"],json!(["discovered"]));
        server.await.unwrap();
        assert_eq!(backend_command(&host,"web:fixture",&discover).await.unwrap(),discovered);
        let mut stale=discover;stale["commandId"]=json!(uuid::Uuid::new_v4().to_string());stale["params"]["connection"]["credential"]["expectedRevision"]=initial["revision"].clone();
        assert_eq!(backend_command(&host,"web:fixture",&stale).await.unwrap_err().to_string(),"TARGET_CHANGED");
        assert!(host.gateway.workbench.backend.running.borrow().is_none());
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn provider_network_deadline_closes_original_request_and_does_not_replay() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    tokio::task::LocalSet::new().run_until(async {
        let root=tempfile::tempdir().unwrap();let root=root.path().canonicalize().unwrap();let (host,input,source)=resumable_host(&root);
        storage::private_dir(launch_record(&host).parent().unwrap()).unwrap();storage::write(&launch_record(&host),&input).unwrap();host.gateway.workbench.restore_source(&host).unwrap();
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let url=format!("http://{}/v1",listener.local_addr().unwrap());
        let entered=Rc::new(tokio::sync::Notify::new());let signal=entered.clone();
        let server=tokio::task::spawn_local(async move {
            let (mut stream,_)=listener.accept().await.unwrap();let _head=read_provider_http_head(&mut stream).await;
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n").await.unwrap();
            signal.notify_one();let mut bytes=[0;1];
            match stream.read(&mut bytes).await {
                Ok(0) => {},
                Err(error) if error.kind()==std::io::ErrorKind::ConnectionReset => {},
                result => panic!("timed-out request did not close its socket: {result:?}"),
            }
        });
        let command=uuid::Uuid::new_v4().to_string();let request=json!({"method":"providers.command","commandId":command,"params":{"sourceId":source,"operation":"discover",
            "connection":{"baseUrl":url,"protocol":"responses","credential":{"kind":"none"}}}});
        let running={let host=host.clone();let request=request.clone();tokio::task::spawn_local(async move {backend_command(&host,"web:fixture",&request).await})};
        tokio::time::timeout(Duration::from_secs(10),entered.notified()).await.unwrap();
        tokio::time::pause();tokio::time::advance(Duration::from_secs(31)).await;
        let failure=running.await.unwrap().unwrap_err();tokio::time::resume();
        assert_eq!(failure.downcast_ref::<crate::wire::Error>().unwrap().code,"RESOURCE_UNAVAILABLE");
        tokio::time::timeout(Duration::from_secs(5),server).await.unwrap().unwrap();
        assert_eq!(backend_command(&host,"web:fixture",&request).await.unwrap_err().to_string(),failure.to_string());
        assert_eq!(backend_receipt(&host,"web:fixture",&command).unwrap_err().to_string(),failure.to_string());
        assert!(host.gateway.workbench.backend.running.borrow().is_none());
    }).await;
}

async fn read_provider_http_head(stream: &mut tokio::net::TcpStream) -> Vec<u8> {
    use tokio::io::AsyncReadExt;
    let mut head = Vec::new();
    while !head.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
        let mut bytes = [0; 4096];
        let count = stream.read(&mut bytes).await.unwrap();
        assert!(count > 0 && head.len() + count <= 16384);
        head.extend_from_slice(&bytes[..count]);
    }
    head
}

#[tokio::test(flavor = "current_thread")]
async fn blocked_provider_credential_is_a_definitive_original_rejection() {
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let (mut host, input, source) = resumable_host(&root);
        Rc::get_mut(&mut Rc::get_mut(&mut host).unwrap().migration).unwrap().vault = crate::vault::Vault::isolated_files(&host.home);
        storage::private_dir(launch_record(&host).parent().unwrap()).unwrap();
        storage::write(&launch_record(&host), &input).unwrap();
        let list = json!({"method":"providers.read","params":{"sourceId":source,"operation":"list"}});
        let initial = backend_read(&host,"web:fixture",&list).await.unwrap();
        let command = uuid::Uuid::new_v4().to_string();
        let reference = format!("AREAL_CREDENTIAL_{}",command.replace('-',""));
        let entry = uuid::Uuid::new_v4().to_string();
        let receipt = json!({"requestId":command,"method":"vault.replace","state":"blocked",
            "slot":{"kind":"providerCredential","sourceId":source,"reference":reference},
            "previousRevision":0,"entryId":entry,
            "error":{"code":"storageMissing","message":"private storage diagnostic"}});
        let receipt_path = host.home.join("host/vault-operations").join(format!("{command}.json"));
        storage::private_dir(receipt_path.parent().unwrap()).unwrap();
        storage::write(&receipt_path,&receipt).unwrap();
        let request = json!({"method":"providers.command","commandId":command,"params":{
            "sourceId":source,"operation":"save","expectedRevision":initial["revision"],
            "authentication":"apiKey","apiKey":"synthetic-rejected-provider-key",
            "provider":{"name":"Blocked","baseUrl":"https://example.invalid/v1","protocol":"responses",
                "models":[{"id":"fixture","enabled":true,"parameters":{}}]}}});
        for result in [backend_command(&host,"web:fixture",&request).await,
            backend_receipt(&host,"web:fixture",&command).map(Option::unwrap)] {
            let error = result.unwrap_err();
            let wire = error.downcast_ref::<crate::wire::Error>().unwrap();
            assert_eq!(wire.code,"RESOURCE_UNAVAILABLE");
            let text = &wire.message;
            assert!(!text.contains("private storage diagnostic"));
            assert!(!text.contains("synthetic-rejected-provider-key"));
        }
        let (_, journal) = host.journal.native_snapshot(&format!("workbench-{}",storage::digest(b"web:fixture"))).unwrap();
        assert_eq!(journal["outcomes"][&command]["submissionUnknown"],false);
        assert_eq!(journal["outcomes"][&command]["admissionState"],"rejected");
        assert_eq!(storage::read::<Value>(&receipt_path).unwrap(),receipt);
        assert_eq!(backend_read(&host,"web:fixture",&list).await.unwrap()["revision"],initial["revision"]);
        assert!(host.gateway.workbench.backend.running.borrow().is_none());
        assert!(host.slots.borrow().values().all(|slot|slot.service.is_none()));
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn feedback_receiver_uses_source_credentials_without_cli_node_or_core() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    tokio::task::LocalSet::new().run_until(async {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let (mut host, mut input, source) = resumable_host(&root);
        Rc::get_mut(&mut Rc::get_mut(&mut host).unwrap().migration).unwrap().vault = crate::vault::Vault::isolated_files(&host.home);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/v1/logs",listener.local_addr().unwrap());
        let config_path = root.join("feedback.toml");
        let spool = root.join("feedback-spool");
        let reference = "AREAL_CREDENTIAL_feedback_fixture";
        std::fs::write(&config_path,format!("schema_version=1\n[trajectory]\nenabled=true\nendpoint='{endpoint}'\nspool_dir='{}'\nheaders_env='{reference}'\n",spool.display())).unwrap();
        input.options["config"] = json!(config_path);
        storage::private_dir(launch_record(&host).parent().unwrap()).unwrap();
        storage::write(&launch_record(&host),&input).unwrap();
        host.gateway.workbench.restore_source(&host).unwrap();
        let config = areal_config::load_management_config(&super::super::workbench_utility::inputs(&input.options).unwrap()).unwrap();
        storage::private_dir(&spool).unwrap();
        storage::write(&spool.join("control.json"),&config.trajectory).unwrap();
        let installation = uuid::Uuid::new_v4().to_string();
        storage::write(&spool.join("installation.json"),&installation).unwrap();
        host.migration.vault.dispatch_async("vault.replace",json!({"requestId":uuid::Uuid::new_v4().to_string(),
            "expectedGeneration":host.identity.generation,"expectedRevision":0,
            "slot":{"kind":"providerCredential","sourceId":source,"reference":reference},
            "value":"Authorization=Bearer synthetic-feedback-secret"}),&host.identity.generation,&host.migration).await.unwrap();
        let unused = host.migration.vault.dispatch_async("vault.replace",json!({"requestId":uuid::Uuid::new_v4().to_string(),
            "expectedGeneration":host.identity.generation,"expectedRevision":0,
            "slot":{"kind":"providerCredential","sourceId":source,"reference":"AREAL_CREDENTIAL_unrelated"},
            "value":"unrelated-private-value"}),&host.identity.generation,&host.migration).await.unwrap();
        std::fs::write(host.home.join("host/vault").join(format!("{}.json",unused["entryId"].as_str().unwrap())),"invalid unrelated vault entry").unwrap();
        let server = tokio::task::spawn_local(async move {
            let mut posts = 0;
            for _ in 0..12 {
                let (mut stream,_) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                let (header_end,length) = loop {
                    let mut chunk=[0;4096];let size=stream.read(&mut chunk).await.unwrap();assert!(size>0);bytes.extend_from_slice(&chunk[..size]);
                    if let Some(end)=bytes.windows(4).position(|v|v==b"\r\n\r\n") {
                        let header=String::from_utf8(bytes[..end].to_vec()).unwrap();
                        assert!(header.to_ascii_lowercase().contains("authorization: bearer synthetic-feedback-secret"));
                        let length=header.lines().find_map(|line|line.to_ascii_lowercase().strip_prefix("content-length:").map(|v|v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                        break (end+4,length);
                    }
                };
                while bytes.len()<header_end+length {let mut chunk=[0;4096];let size=stream.read(&mut chunk).await.unwrap();assert!(size>0);bytes.extend_from_slice(&chunk[..size]);}
                let response = if bytes.starts_with(b"GET /external-feedback/capabilities ") {
                    json!({"schema_version":"arena.user-feedback/v1","enabled":true,"owner":"fixture-owner","max_context_bytes":16384})
                } else {
                    assert!(bytes.starts_with(b"POST /external-feedback "));
                    posts+=1;
                    let body:Value=serde_json::from_slice(&bytes[header_end..]).unwrap();
                    assert_eq!(body["installation_id"],installation);
                    assert!(body.get("expected_owner").is_none());
                    assert_eq!(body["context"],json!({"frozen":"original evidence"}));
                    assert_eq!(body["reason"],"original reason");
                    json!({"feedback_id":if posts==1{json!("uncertain-receipt")}else{body["feedback_id"].clone()},"rating":body["rating"]})
                };
                let body=response.to_string();stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            }
            assert_eq!(posts,2);
        });
        storage::private_dir(&host.home.join("host/projects")).unwrap();
        let alias = super::super::worktree_catalog::add_project(&host,&source,json!({"root":root.join("workspace")})).await.unwrap()["projectId"].as_str().unwrap().to_owned();
        let status = backend_read(&host,"local",&json!({"method":"feedback.read","params":{"sourceId":source,"operation":"status"}})).await.unwrap();
        assert_eq!(status["connected"],true);
        assert_eq!(status["opted_in"],true);
        assert!(!status.to_string().contains("synthetic-feedback-secret"));
        let document=json!({"feedback_id":uuid::Uuid::new_v4().to_string(),"rating":"up","context":{},
            "expected_destination":status["destination"],"expected_owner":status["account"],"expected_installation":status["installation"]});
        let draft=json!({"id":document["feedback_id"],"projectId":alias,"threadId":"original-thread","turnId":"original-turn","itemId":"original-item","rating":"up","reason":"original reason","analysis":"",
            "context":{"frozen":"original evidence"},"contextSha256":"a".repeat(64),"expectedDestination":status["destination"],"expectedOwner":status["account"],"expectedInstallation":status["installation"],"state":"draft","createdAt":1});
        let draft_path=root.join("data").join(format!("feedback-{}.json",document["feedback_id"].as_str().unwrap()));
        storage::write(&draft_path,&draft).unwrap();
        let query=json!({"sourceId":source,"operation":"read","id":draft["id"],"projectId":alias,"threadId":"original-thread"});
        let read=backend_read(&host,"local",&json!({"method":"feedback.read","params":query})).await.unwrap();
        assert_eq!(read["id"],draft["id"]);
        assert!(read.get("context").is_none()&&read.get("expectedOwner").is_none());
        let submit=json!({"method":"feedback.command","commandId":uuid::Uuid::new_v4().to_string(),"params":{"sourceId":source,"operation":"submit","id":draft["id"],"projectId":alias,"threadId":"original-thread"}});
        let preference=|enabled|json!({"method":"feedback.command","commandId":uuid::Uuid::new_v4().to_string(),"params":{"sourceId":source,"operation":"preference","enabled":enabled}});
        assert_eq!(backend_command(&host,"local",&preference(false)).await.unwrap()["receipt"]["opted_in"],false);
        let mut denied=submit.clone();denied["commandId"]=json!(uuid::Uuid::new_v4().to_string());
        assert!(backend_command(&host,"local",&denied).await.is_err());
        assert_eq!(backend_receipt_raw(&host,"local",denied["commandId"].as_str().unwrap()).unwrap().unwrap()["submissionUnknown"],false);
        backend_command(&host,"local",&preference(true)).await.unwrap();
        for field in ["expectedOwner","expectedDestination","expectedInstallation"] {
            let mut changed=draft.clone();changed[field]=json!("different-binding");storage::write(&draft_path,&changed).unwrap();
            denied["commandId"]=json!(uuid::Uuid::new_v4().to_string());
            assert!(backend_command(&host,"local",&denied).await.is_err());
            assert_eq!(backend_receipt_raw(&host,"local",denied["commandId"].as_str().unwrap()).unwrap().unwrap()["submissionUnknown"],false);
        }
        storage::write(&draft_path,&draft).unwrap();
        let uncertain=backend_command(&host,"local",&submit).await.unwrap();
        assert_eq!(uncertain["submissionUnknown"],true);
        assert_eq!(backend_command(&host,"local",&submit).await.unwrap(),uncertain,"original command lookup never repeats a feedback POST");
        let frozen:Value=storage::read(&draft_path).unwrap();assert!(frozen["submission"].is_object());assert_eq!(frozen["state"],"draft");
        let mut retry=submit.clone();retry["commandId"]=json!(uuid::Uuid::new_v4().to_string());retry["params"]["reason"]=json!("new editor contents must not alter an uncertain submission");
        let receipt=backend_command(&host,"local",&retry).await.unwrap();
        assert_eq!(receipt["submissionUnknown"],false);
        assert_eq!(receipt["receipt"]["receipt"]["feedback_id"],document["feedback_id"]);
        assert_eq!(backend_command(&host,"local",&retry).await.unwrap(),receipt);
        let saved:Value=storage::read(&draft_path).unwrap();
        assert_eq!(saved["context"],draft["context"]);
        assert_eq!(saved["submission"],frozen["submission"]);
        assert_eq!(saved["submission"]["reason"],"original reason");
        assert_eq!(saved["state"],"submitted");
        let mut changed=document;changed["expected_owner"]=json!("other-owner");
        assert!(super::super::workbench_utility::feedback(&host,&source,Some(changed)).await.is_err());
        tokio::time::timeout(Duration::from_secs(5),server).await.unwrap().unwrap();
        let missing = std::fs::read_to_string(&config_path).unwrap().replace(reference,"AREAL_CREDENTIAL_missing");
        std::fs::write(&config_path,&missing).unwrap();
        assert_eq!(super::super::workbench_utility::feedback(&host,&source,None).await.unwrap_err().to_string(),"feedback_credential_unavailable");
        std::fs::write(&config_path,missing.replace("enabled=true","enabled=false")).unwrap();
        assert_eq!(super::super::workbench_utility::feedback(&host,&source,None).await.unwrap(),json!({"enabled":false,"connected":false}));
        assert!(host.gateway.workbench.backend.running.borrow().is_none());
        assert!(host.slots.borrow().values().all(|slot|slot.service.is_none()));
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn feedback_refinement_recovers_the_original_core_receipt_and_closes_without_node() {
    use futures_util::{SinkExt, StreamExt};
    use std::cell::Cell;
    use tokio_tungstenite::tungstenite::Message;
    tokio::task::LocalSet::new().run_until(async {
        let temp=tempfile::tempdir().unwrap(); let root=temp.path().canonicalize().unwrap();
        let (host,input,source)=resumable_host(&root);
        storage::private_dir(launch_record(&host).parent().unwrap()).unwrap();
        storage::write(&launch_record(&host),&input).unwrap();
        host.gateway.workbench.restore_source(&host).unwrap();
        let registration=host.slots.borrow()["project"].registration.clone();
        let alias=host.migration.remote_bindings(&source,&[registration.clone()]).unwrap().remove(0).1;
        storage::write(&root.join("data/projects.json"),&json!([{"id":alias,"root":registration.workspace}])).unwrap();
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let service=areal_protocol::service::Service {
            identity:areal_protocol::service::Identity {protocol_version:1,service_id:"fixture".into(),generation:"first".into(),workspace:registration.workspace,data_dir:registration.data_dir,config_fingerprint:"fixture".into()},
            owner:Some(host.owner()),endpoint:format!("ws://{}/",listener.local_addr().unwrap()),web_url:String::new(),auth_file:root.join("core-auth.json"),log_file:root.join("core.log"),host_pid:1,core_pid:2,state:areal_protocol::service::State::Ready,
        };
        storage::write(&service.auth_file,&json!({"principals":[{"id":"desktop-owner","token":"fixture"}]})).unwrap();
        {let mut slots=host.slots.borrow_mut();let slot=slots.get_mut("project").unwrap();let(writer,lifetime)=areal_local_service::OwnerLifetime::pair().unwrap();slot.writer=Some(writer);slot.lifetime=Some(Rc::new(lifetime));slot.service=Some(service.clone());slot.state="ready".into();}
        let starts=Rc::new(Cell::new(0));let sends=Rc::new(Cell::new(0));let stops=Rc::new(Cell::new(0));
        let receipt=Rc::new(RefCell::new(Value::Null));let active=Rc::new(Cell::new(false));
        let spawned=Rc::new(RefCell::new(Vec::<tokio::task::JoinHandle<()>>::new()));
        let handles=spawned.clone();let counts=(starts.clone(),sends.clone(),stops.clone());let workspace=root.join("workspace");
        let accepting=tokio::task::spawn_local(async move {
            loop {
                let(stream,_)=listener.accept().await.unwrap();
                let(starts,sends,stops)=counts.clone();let receipt=receipt.clone();let active=active.clone();let workspace=workspace.clone();
                handles.borrow_mut().push(tokio::task::spawn_local(async move {
                    let mut socket=tokio_tungstenite::accept_async(stream).await.unwrap();
                    while let Some(Ok(Message::Text(bytes)))=socket.next().await {
                        let call:Value=serde_json::from_str(&bytes).unwrap();if call.get("id").is_none(){continue;}
                        let caps=json!({"methods":["turn/interrupt"],"features":{"conversationObservation":true,"turnInterruptAdmissionGuard":true,"atomicObserveOwnership":true,"threadCreationJournal":{"binding":{"identity":"store","journalEpoch":"epoch"}}},
                            "methodSemantics":{"areal/side/start":{"effect":"mutation","receipt":"request"},"areal/turn/start":{"effect":"mutation","receipt":"thread"},"turn/interrupt":{"effect":"mutation","receipt":"thread"}}});
                        let method=call["method"].as_str().unwrap();let p=&call["params"];
                        let value=match method {
                            "initialize"=>json!({"capabilities":caps}),"areal/capabilities"=>caps,
                            "thread/read"|"areal/thread/observe"=>{
                                let side=p["threadId"]=="side";
                                let mut thread=json!({"id":p["threadId"],"sessionId":"author","cwd":workspace,"turns":[{"id":if side{"refine-turn"}else{"original-turn"},"status":if side&&active.get(){"inProgress"}else{"completed"},"items":[{"id":"reply","type":"agentMessage","text":"original"}]}]});
                                if side {thread["conversation"]=json!({"kind":"side","policy":{"kind":"sideReadOnlyV1"},"origin":{"sourceThreadId":"main"}});}
                                json!({"thread":thread,"ownership":{"kind":"ordinary"}})
                            },
                            "areal/side/start"=>{
                                starts.set(starts.get()+1);assert_eq!(starts.get(),1,"unknown creation must not be resent");
                                assert_eq!(p["workspaceAccess"],"none");assert_eq!(p["anchor"],json!({"kind":"turn","turnId":"original-turn","boundary":"after"}));
                                assert!(p["input"][0]["text"].as_str().unwrap().contains("original opinion"));
                                let typed:areal_protocol::desktop::SideStart=serde_json::from_value(p.clone()).unwrap();
                                *receipt.borrow_mut()=json!({"requestId":p["requestId"],"method":method,"identity":"store","digest":storage::digest(&serde_json::to_vec(&typed).unwrap()),"threadId":"side","accepted":true,"status":"completed","result":{"thread":{"id":"side"},"turn":{"id":"first-refinement"}}});
                                socket.send(Message::Text(json!({"id":call["id"],"error":{"code":-32011,"message":"ambiguous","data":{"outcome":{"kind":"unconfirmed"}}}}).to_string().into())).await.unwrap();continue;
                            },
                            "areal/request/read"=>{assert_eq!(p["requestId"],receipt.borrow()["requestId"]);json!({"data":[receipt.borrow().clone()]})},
                            "areal/turn/start"=>{sends.set(sends.get()+1);active.set(true);assert_eq!(p["threadId"],"side");assert_eq!(p["input"][0]["text"],"follow-up opinion");json!({"turn":{"id":"refine-turn"}})},
                            "turn/interrupt"=>{stops.set(stops.get()+1);active.set(false);assert_eq!(p,&json!({"threadId":"side","turnId":"refine-turn","admissionGuard":{"ordinarySession":true}}));assert!(p.get("requestId").is_none());json!({})},
                            "areal/subscription/remove"=>json!({"subscriptionCount":0}),
                            "areal/task/list"=>json!({"data":[],"hasMore":false}),
                            "areal/server/status"=>json!({"restartSafe":true}),
                            other=>panic!("unexpected feedback Core request {other}"),
                        };
                        socket.send(Message::Text(json!({"id":call["id"],"result":value}).to_string().into())).await.unwrap();
                    }
                }));
            }
        });
        let close=host.schedules.connections.connect_test_core(host.clone(),"project",service).await.unwrap();
        let id=uuid::Uuid::new_v4().to_string();
        let draft=json!({"id":id,"projectId":alias,"threadId":"main","turnId":"original-turn","itemId":"reply","rating":"down","reason":"","analysis":"","context":{"frozen":"source prefix"},"contextSha256":"a".repeat(64),"expectedDestination":"destination","expectedOwner":"owner","expectedInstallation":"installation","state":"draft","createdAt":1});
        let path=root.join("data").join(format!("feedback-{id}.json"));storage::write(&path,&draft).unwrap();
        let request=|operation:&str,extra:Value|{let mut params=json!({"sourceId":source,"operation":operation,"id":id,"projectId":alias,"threadId":"main"});params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());json!({"method":"feedback.command","commandId":uuid::Uuid::new_v4().to_string(),"params":params})};
        let unknown=backend_command(&host,"local",&request("refine",json!({"reason":"original opinion"}))).await.unwrap();
        assert_eq!(unknown["submissionUnknown"],true);
        let stored:Value=storage::read(&path).unwrap();assert_eq!(stored["refinementUnknown"],true);
        let original=stored["refineRequestId"].clone();let prompt=stored["refineInput"].clone();
        let recovered=backend_command(&host,"local",&request("refine",json!({"reason":"updated opinion"}))).await.unwrap();
        assert_eq!(recovered["receipt"]["sideThreadId"],"side");assert_eq!(recovered["receipt"]["refinementUnknown"],false);
        let stored:Value=storage::read(&path).unwrap();assert_eq!(stored["refineRequestId"],original);assert_eq!(stored["refineInput"],prompt);
        let followup=backend_command(&host,"local",&request("refine",json!({"text":"follow-up opinion"}))).await.unwrap();assert_eq!(followup["submissionUnknown"],false);
        let closed=backend_command(&host,"local",&request("close",json!({}))).await.unwrap();assert_eq!(closed["receipt"]["closed"],true);
        assert_eq!((starts.get(),sends.get(),stops.get()),(1,1,1));
        assert_eq!(host.gateway.workbench.backend_status(&host).await.unwrap()["owned"],false);
        close();accepting.abort();for handle in spawned.borrow().iter(){handle.abort();}
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn fresh_gui_registration_prepares_launch_without_node_or_core() {
    tokio::task::LocalSet::new().run_until(async {
        let root=tempfile::tempdir().unwrap();let root=root.path().canonicalize().unwrap();
        let (host,mut input,source)=resumable_host(&root);
        storage::private_dir(&host.home.join("host/projects")).unwrap();
        std::fs::remove_dir_all(root.join("services/workbench")).unwrap();
        let config_home=root.join("configuration");storage::private_dir(&config_home).unwrap();
        storage::write_bytes(&config_home.join("config.toml"),b"schema_version=1\n[model]\nprovider='fixture'\nname='fixture'\n[model.providers.fixture]\nendpoint='http://127.0.0.1:1/'\nprotocol='responses'\napi_key_env='FIXTURE_KEY'\n").unwrap();
        input.options["configHome"]=json!(config_home);input.options["desktopProcesses"]=json!(true);
        let launch_options=frontend_options(&host,&source,input.options,Some(std::collections::BTreeMap::from([("FIXTURE_KEY".into(),"synthetic-initial-secret".into())]))).unwrap();
        super::super::library_store::change(&host,&source,|value| {value["settings"]["httpProxy"]=json!("http://127.0.0.1:8888");Ok(())}).unwrap();
        let workspace=root.join("fresh-project");storage::private_dir(&workspace).unwrap();
        for (base,name) in [(&root,"user"),(&workspace,"project")] {
            let skill=base.join(".agents/skills/shared");storage::private_dir(&skill).unwrap();
            storage::write_bytes(&skill.join("SKILL.md"),format!("---\nname: {name}\ndescription: local fixture\n---\nRead the task.\n").as_bytes()).unwrap();
        }
        let (subscribed,_)=host.schedules.connections.frontend_subscribe(&host,"native-picker",&source,launch_options,None).unwrap();
        let result=host.schedules.connections.frontend_call(&host,&json!({"attachmentId":subscribed["attachmentId"],"call":"worktree.project.add","params":{"root":workspace}})).await.unwrap();
        let alias=result["projectId"].as_str().unwrap();
        let registration=super::super::worktree_catalog::project(&host,&source,alias).unwrap();
        let saved=host.home.join("host/launch").join(storage::digest(registration.project_id.as_bytes())).join("inputs.json");
        assert!(matches!(crate::activity::observe(&host.home,&registration,&host.owner(),false,None).await.unwrap(),crate::ProjectActivity::Observed{idle_allowed:true,..}),"preparing a fresh GUI project must not claim Core was launched");
        let inputs:crate::LaunchInputs=storage::read(&saved).expect("new GUI registration must prepare its first native launch");
        assert_eq!(inputs.workspace,workspace);assert_eq!(inputs.cwd,workspace);
        assert!(inputs.credential_names.iter().any(|name|name=="FIXTURE_KEY"));
        assert!(!String::from_utf8_lossy(&std::fs::read(&saved).unwrap()).contains("synthetic-initial-secret"));
        assert!(inputs.options.allow_concurrent_writes);assert!(!inputs.options.history_only);
        assert_eq!(inputs.environment.get("HTTPS_PROXY").map(String::as_str),Some("http://127.0.0.1:8888"));
        let deployment:Value=storage::read(inputs.deployment_path.as_ref().unwrap()).unwrap();
        assert!(deployment["skills"].as_array().unwrap().iter().any(|skill|skill["id"]=="shared"&&skill["metadata"]["name"]=="project"));
        assert!(deployment["skills"].as_array().unwrap().iter().any(|skill|skill["id"]=="openai-skill-creator"));
        assert!(deployment["profiles"].as_array().unwrap().iter().any(|profile|profile["revision"].as_str().is_some_and(|revision|revision.starts_with("resources-"))));
        for name in ["areal-runtime","areal-runtime-fs","areal-runtime-reaper"] {std::fs::write(host.bin.join(name),b"fixture").unwrap();}
        let (launch,_)=crate::launch::prepare(&host.home,&host.bin,&registration,&inputs,&Default::default()).unwrap();
        assert!(crate::activity::observe(&host.home,&registration,&host.owner(),false,None).await.is_err(),"launch admission must consume initial preparation proof");
        assert!(!launch.args.history_only,"native deployment must pass the shared Core launch preparation");
        let before=std::fs::read(&saved).unwrap();
        super::super::worktree_catalog::add_project(&host,&source,json!({"root":workspace})).await.unwrap();
        assert!(crate::activity::observe(&host.home,&registration,&host.owner(),false,None).await.is_err(),"re-registering cannot reset unknown launch history");
        assert_eq!(std::fs::read(&saved).unwrap(),before,"repeated registration retains original launch inputs");
        let same=super::super::gui_project::refresh_inputs(&host,&registration).await.unwrap().unwrap();
        assert!(super::super::gui_project::same_inputs(&inputs,&same).unwrap(),"unchanged settings must not request a restart; differing keys: {:?}", serde_json::to_value(&inputs).unwrap().as_object().unwrap().iter().filter_map(|(key,value)|(Some(value)!=serde_json::to_value(&same).unwrap().get(key)).then_some(key)).collect::<Vec<_>>());
        let hook_path=inputs.environment["AREAL_HARNESS_TOOL_EXTENSIONS"].clone();
        let mut relocated=inputs.clone();let copied_hooks=root.join("copied-hooks.json");
        std::fs::copy(&hook_path,&copied_hooks).unwrap();
        relocated.environment.insert("AREAL_HARNESS_TOOL_EXTENSIONS".into(),copied_hooks.to_string_lossy().into_owned());
        let copied_deployment=root.join("copied-deployment.json");std::fs::copy(inputs.deployment_path.as_ref().unwrap(),&copied_deployment).unwrap();
        relocated.deployment_path=Some(copied_deployment.clone());relocated.options.desktop_config=Some(copied_deployment);
        assert!(super::super::gui_project::same_inputs(&inputs,&relocated).unwrap(),"identical immutable snapshots in a worktree retain their configuration identity");
        let original_hooks=std::fs::read(&hook_path).unwrap();
        let saved_command=host.gateway.workbench.resources.command(&host,&source,&json!({"operation":"skillSave","scope":"project","projectId":alias,"id":"new-skill","content":"Use the current task.","expectedRevision":0})).await.unwrap();
        assert_eq!(saved_command["revision"],1);
        storage::write(&root.join("data/tool-extensions.json"),&json!({"hooks":[{"name":"audit","event":"PostToolUse","matcher":"*","argv":["echo","fixture"],"timeoutMs":1000}]})).unwrap();
        let mut failed=inputs.clone();failed.options.history_only=true;
        storage::write(&saved,&failed).unwrap();let frozen=std::fs::read(&saved).unwrap();
        let candidate=super::super::gui_project::refresh_inputs(&host,&registration).await.unwrap().unwrap();
        assert!(!candidate.options.history_only);
        assert!(!super::super::gui_project::same_inputs(&inputs,&candidate).unwrap());
        assert_eq!(std::fs::read(&saved).unwrap(),frozen);
        assert_eq!(std::fs::read(&hook_path).unwrap(),original_hooks);
        assert_ne!(candidate.environment["AREAL_HARNESS_TOOL_EXTENSIONS"],hook_path);
        let current:Value=storage::read(candidate.deployment_path.as_ref().unwrap()).unwrap();
        assert!(current["skills"].as_array().unwrap().iter().any(|row|row["id"]=="new-skill"));
        assert!(!host.gateway.workbench.has_running_backend());
        assert!(host.slots.borrow()[&registration.project_id].service.is_none());
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn projectless_allocations_keep_original_roots_without_node() {
    tokio::task::LocalSet::new().run_until(async {
        let temp=tempfile::tempdir().unwrap();let root=temp.path().canonicalize().unwrap();
        let (host,input,source)=resumable_host(&root);
        storage::private_dir(&host.home.join("host/projects")).unwrap();
        std::fs::remove_dir_all(root.join("services/workbench")).unwrap();
        let options=frontend_options(&host,&source,input.options,None).unwrap();
        host.schedules.connections.frontend_subscribe(&host,"projectless",&source,options,None).unwrap();
        let base=root.join("tasks");storage::private_dir(&base).unwrap();
        { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&base,std::fs::Permissions::from_mode(0o755)).unwrap(); }
        let call=|params:Value| {let host=host.clone();let source=source.clone();async move {
            desktop_command(&host,"local","projectless",&json!({"params":{"sourceId":source,"command":"projectless","request":params}})).await
        }};
        let directory=call(json!({"operation":"directory","path":base})).await.unwrap();
        assert_eq!(directory["directory"],json!(base));
        let id=uuid::Uuid::new_v4().to_string();
        let (first,second)=tokio::join!(call(json!({"operation":"prepare","requestId":id})),call(json!({"operation":"prepare","requestId":id})));
        let first=first.unwrap();assert_eq!(first,second.unwrap());assert_eq!(first["cwd"],json!(base.join(&id)));
        let allocations:Value=storage::read(&root.join("data/projectless-drafts.json")).unwrap();assert_eq!(allocations[&id]["root"],first["cwd"]);
        let other=root.join("other");storage::private_dir(&other).unwrap();
        assert!(call(json!({"operation":"prepare","requestId":id,"directory":other})).await.is_err());
        let alias=first["projectId"].as_str().unwrap();
        let projects:Value=storage::read(&root.join("data/projects.json")).unwrap();
        assert_eq!(projects.as_array().unwrap().iter().filter(|row|row["id"]==alias).count(),1);
        assert_eq!(projects.as_array().unwrap().iter().find(|row|row["id"]==alias).unwrap()["projectlessRequestId"],id);
        let normal=root.join("normal");storage::private_dir(&normal).unwrap();
        super::super::worktree_catalog::add_project(&host,&source,json!({"root":normal})).await.unwrap();
        assert!(call(json!({"operation":"prepare","requestId":uuid::Uuid::new_v4().to_string(),"directory":normal})).await.is_err());
        assert!(!host.gateway.workbench.has_running_backend());
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn projectless_native_catalog_and_scratch_share_source_authority() {
    tokio::task::LocalSet::new().run_until(async {
        let temp=tempfile::tempdir().unwrap();let root=temp.path().canonicalize().unwrap();
        let (host,mut input,source)=resumable_host(&root);
        storage::private_dir(&host.home.join("host/projects")).unwrap();
        std::fs::remove_dir_all(root.join("services/workbench")).unwrap();
        let config=root.join("config");storage::private_dir(&config).unwrap();
        storage::write_bytes(&config.join("config.toml"),b"schema_version=1\n[model]\nprovider='fixture'\nname='example'\n[model.providers.fixture]\nprotocol='responses'\nendpoint='http://127.0.0.1:9/private-endpoint'\napi_key_env='PROJECTLESS_FIXTURE_KEY'\n").unwrap();
        input.options["configHome"]=json!(config);
        let options=frontend_options(&host,&source,input.options,Some(std::collections::BTreeMap::from([("PROJECTLESS_FIXTURE_KEY".into(),"private-fixture-value".into())]))).unwrap();
        let (subscribed,_)=host.schedules.connections.frontend_subscribe(&host,"native-projectless",&source,options,None).unwrap();
        let call=|request:Value|{let host=host.clone();let attachment=subscribed["attachmentId"].clone();async move {
            host.schedules.connections.frontend_call(&host,&json!({"attachmentId":attachment,"call":"projectless.command","params":request})).await
        }};
        let catalog=call(json!({"operation":"catalog"})).await.unwrap();
        assert!(catalog["models"].as_array().unwrap().iter().any(|row|row["modelId"]=="example" && row["available"]==true));
        let encoded=serde_json::to_string(&catalog).unwrap();assert!(!encoded.contains("private-endpoint"));assert!(!encoded.contains("private-fixture-value"));
        let scratch=call(json!({"operation":"scratch"})).await.unwrap();
        assert_eq!(scratch["cwd"],json!(config.join("scratch")));
        assert_eq!(scratch,call(json!({"operation":"scratch"})).await.unwrap());
        assert!(call(json!({"operation":"prepare","requestId":uuid::Uuid::new_v4().to_string(),"directory":root.join("../escape")})).await.is_err());
        assert!(!host.gateway.workbench.has_running_backend());
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn native_resource_settings_own_skills_hooks_and_revisions_without_node() {
    tokio::task::LocalSet::new().run_until(async {
        let temp=tempfile::tempdir().unwrap();let root=temp.path().canonicalize().unwrap();
        let (host,input,source)=resumable_host(&root);
        storage::private_dir(&host.home.join("host/projects")).unwrap();
        std::fs::remove_dir_all(root.join("services/workbench")).unwrap();
        let options=frontend_options(&host,&source,input.options,None).unwrap();
        let (subscription,_)=host.schedules.connections.frontend_subscribe(&host,"resources",&source,options,None).unwrap();
        let workspace=root.join("project");storage::private_dir(&workspace).unwrap();
        let project=super::super::worktree_catalog::add_project(&host,&source,json!({"root":workspace})).await.unwrap()["projectId"].as_str().unwrap().to_owned();
        let command=|request:Value|{let host=host.clone();let source=source.clone();async move {
            desktop_command(&host,"local","resources",&json!({"params":{"sourceId":source,"command":"resources","request":request}})).await
        }};
        let initial=host.schedules.connections.frontend_call(&host,&json!({"attachmentId":subscription["attachmentId"],"call":"resources.command","params":{"operation":"skills","scope":"user"}})).await.unwrap();
        assert_eq!(initial["revision"],0);
        assert!(host.schedules.connections.frontend_call(&host,&json!({"attachmentId":subscription["attachmentId"],"call":"resources.command","params":{"operation":"skills","scope":"user","root":"/untrusted"}})).await.is_err());
        let saved=command(json!({"operation":"skillSave","scope":"user","id":"shared","name":"User skill","description":"fixture","content":"Read the current task.","expectedRevision":0})).await.unwrap();
        assert_eq!(saved,json!({"revision":1,"warning":null}));
        let user=command(json!({"operation":"skills","scope":"user"})).await.unwrap();
        assert_eq!(user["data"][0]["name"],"User skill");assert_eq!(user["data"][0]["managed"],true);
        let old=std::fs::read(root.join("data/resources.json")).unwrap();
        assert!(command(json!({"operation":"skillToggle","scope":"user","id":"shared","enabled":false,"expectedRevision":0})).await.is_err());
        assert_eq!(std::fs::read(root.join("data/resources.json")).unwrap(),old);
        command(json!({"operation":"skillSave","scope":"project","projectId":project,"id":"shared","name":"Project skill","content":"Local task.","expectedRevision":1})).await.unwrap();
        let user=command(json!({"operation":"skills","scope":"user","projectId":project})).await.unwrap();assert_eq!(user["data"][0]["overridden"],true);
        let read=command(json!({"operation":"skillRead","scope":"project","projectId":project,"id":"shared"})).await.unwrap();assert!(read["content"].as_str().unwrap().contains("Local task."));
        command(json!({"operation":"skillToggle","scope":"project","projectId":project,"id":"shared","enabled":false,"expectedRevision":2})).await.unwrap();
        assert_eq!(command(json!({"operation":"skills","scope":"project","projectId":project})).await.unwrap()["data"][0]["enabled"],false);
        let registration=super::super::worktree_catalog::project(&host,&source,&project).unwrap();
        let inputs:crate::LaunchInputs=storage::read(&host.home.join("host/launch").join(storage::digest(registration.project_id.as_bytes())).join("inputs.json")).unwrap();
        crate::schedule_resources::materialize(&host.home,&registration,&inputs).expect("GUI resource state without a retired mcp field must remain usable by native preparation");
        let hooks=command(json!({"operation":"hooks"})).await.unwrap();
        let next=command(json!({"operation":"hooksSave","expectedRevision":hooks["revision"],"hooks":[{"name":"audit","event":"PostToolUse","matcher":"*","argv":["echo","fixture"],"timeoutMs":1000}]})).await.unwrap();
        assert_ne!(next["revision"],hooks["revision"]);assert_eq!(next["hooks"][0]["name"],"audit");assert_eq!(next["projects"][0]["connected"],false);assert_eq!(next["projects"][0]["applied"],false);
        assert!(command(json!({"operation":"hooksSave","expectedRevision":hooks["revision"],"hooks":[]})).await.is_err());
        let builtin=command(json!({"operation":"builtinSkill","id":"openai-skill-creator"})).await.unwrap();assert_eq!(builtin["skill"]["id"],"openai-skill-creator");assert_eq!(builtin["provenance"]["upstream"],"https://github.com/openai/skills");
        assert!(!host.gateway.workbench.has_running_backend());
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn native_cloud_settings_bind_tokens_to_the_saved_service_without_node() {
    tokio::task::LocalSet::new().run_until(async {
        let temp=tempfile::tempdir().unwrap();let root=temp.path().canonicalize().unwrap();
        let (mut host,input,source)=resumable_host(&root);
        Rc::get_mut(&mut Rc::get_mut(&mut host).unwrap().migration).unwrap().vault=crate::vault::Vault::isolated_files(&host.home);
        std::fs::remove_dir_all(root.join("services/workbench")).unwrap();
        let options=frontend_options(&host,&source,input.options,None).unwrap();
        let (subscribed,_)=host.schedules.connections.frontend_subscribe(&host,"cloud-settings",&source,options,None).unwrap();
        let command=|request:Value|{let host=host.clone();let source=source.clone();async move {
            desktop_command(&host,"local","cloud",&json!({"params":{"sourceId":source,"command":"cloud","request":request}})).await
        }};
        assert_eq!(command(json!({"operation":"status"})).await.unwrap(),json!({"baseURL":"","tokenConfigured":false}));
        let legacy=root.join("data/cloud.json");let raw=br#"{"baseURL":"https://legacy.example.invalid","secret":"synthetic-ciphertext"}"#;storage::write_bytes(&legacy,raw).unwrap();
        assert!(command(json!({"operation":"status"})).await.is_err());
        let import=|params:Value|{let host=host.clone();let attachment=subscribed["attachmentId"].clone();async move {host.schedules.connections.frontend_call(&host,&json!({"attachmentId":attachment,"call":"cloud.import","params":params})).await}};
        let import_id=uuid::Uuid::new_v4().to_string();
        assert!(import(json!({"requestId":import_id,"sourceDigest":"wrong","token":"synthetic-old-token"})).await.is_err());
        assert_eq!(import(json!({"requestId":import_id,"sourceDigest":storage::digest(raw),"token":"synthetic-old-token"})).await.unwrap(),json!({"baseURL":"wss://legacy.example.invalid/openapi/v1/app-server","tokenConfigured":true}));
        assert_eq!(std::fs::read(&legacy).unwrap(),raw);
        let expected=json!({"baseURL":"wss://cloud.example.invalid/openapi/v1/app-server","tokenConfigured":true});
        assert_eq!(command(json!({"operation":"save","baseURL":"https://cloud.example.invalid","token":"synthetic-cloud-secret"})).await.unwrap(),expected);
        assert_eq!(command(json!({"operation":"save","baseURL":"https://cloud.example.invalid"})).await.unwrap(),expected);
        assert_eq!(import(json!({"requestId":import_id,"sourceDigest":storage::digest(raw),"token":"synthetic-old-token"})).await.unwrap(),expected,"late legacy import cannot overwrite an initialized Cloud account");
        for invalid in [" ","\n","valid\rvalue"] {
            assert!(command(json!({"operation":"save","baseURL":"https://cloud.example.invalid","token":invalid})).await.is_err());
        }
        for operation in storage::json_records(&host.home.join("host/vault-operations"),false).unwrap() {
            assert!(!std::fs::read_to_string(operation).unwrap().contains("synthetic-cloud-secret"),"credential values cannot enter operation receipts");
        }
        assert!(command(json!({"operation":"save","baseURL":"https://other.example.invalid"})).await.is_err());
        assert_eq!(command(json!({"operation":"status"})).await.unwrap(),expected);
        for base in ["https://user:pass@cloud.example.invalid","https://cloud.example.invalid/?token=private","file:///tmp/cloud","https://cloud.example.invalid/app-server/workspace"] {
            assert!(command(json!({"operation":"save","baseURL":base,"token":"synthetic-cloud-secret"})).await.is_err());
        }
        assert!(!serde_json::to_string(&command(json!({"operation":"status"})).await.unwrap()).unwrap().contains("synthetic-cloud-secret"));
        assert!(!host.gateway.workbench.has_running_backend());
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn configured_cloud_handshake_cannot_publish_after_token_revision_changes() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{
        Message,
        handshake::server::{Request, Response},
    };
    tokio::task::LocalSet::new()
        .run_until(async {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().canonicalize().unwrap();
            let (mut host, input, source) = resumable_host(&root);
            Rc::get_mut(&mut Rc::get_mut(&mut host).unwrap().migration)
                .unwrap()
                .vault = crate::vault::Vault::isolated_files(&host.home);
            let options = frontend_options(&host, &source, input.options, None).unwrap();
            host.schedules
                .connections
                .frontend_subscribe(&host, "cloud-race", &source, options, None)
                .unwrap();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("ws://{}/app-server/", listener.local_addr().unwrap());
            host.gateway
                .workbench
                .cloud
                .settings(
                    &host,
                    &source,
                    &json!({"operation":"save","baseURL":base,"token":"synthetic-original-token"}),
                )
                .await
                .unwrap();
            let (ready, observed) = tokio::sync::oneshot::channel();
            let (release, resume) = tokio::sync::oneshot::channel();
            let server = tokio::task::spawn_local(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_hdr_async(
                    stream,
                    |request: &Request, response: Response| {
                        assert_eq!(
                            request.headers().get("authorization").unwrap(),
                            "Bearer synthetic-original-token"
                        );
                        Ok(response)
                    },
                )
                .await
                .unwrap();
                let mut ready = Some(ready);
                let mut resume = Some(resume);
                while let Some(Ok(Message::Text(raw))) = socket.next().await {
                    let request: Value = serde_json::from_str(&raw).unwrap();
                    if request.get("id").is_none() {
                        continue;
                    }
                    let result = match request["method"].as_str().unwrap() {
                        "initialize" => json!({}),
                        "areal/capabilities" => {
                            ready.take().unwrap().send(()).unwrap();
                            resume.take().unwrap().await.unwrap();
                            json!({"apiVersion":"areal.core.v1","methods":[]})
                        }
                        other => panic!("unexpected {other}"),
                    };
                    socket
                        .send(Message::Text(
                            json!({"jsonrpc":"2.0","id":request["id"],"result":result})
                                .to_string()
                                .into(),
                        ))
                        .await
                        .unwrap();
                }
            });
            let connecting_host = host.clone();
            let connecting_source = source.clone();
            let connecting_base = base.clone();
            let connecting = tokio::task::spawn_local(async move {
                connecting_host
                    .gateway
                    .workbench
                    .cloud
                    .attach(
                        &connecting_host,
                        &connecting_source,
                        &json!({"baseURL":connecting_base}),
                    )
                    .await
            });
            observed.await.unwrap();
            host.gateway
                .workbench
                .cloud
                .settings(
                    &host,
                    &source,
                    &json!({"operation":"save","baseURL":base,"token":"synthetic-new-token"}),
                )
                .await
                .unwrap();
            release.send(()).unwrap();
            assert!(
                connecting
                    .await
                    .unwrap()
                    .unwrap_err()
                    .to_string()
                    .contains("TARGET_CHANGED")
            );
            server.await.unwrap();
            assert!(!host.gateway.workbench.has_running_backend());
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn native_cloud_sessions_create_and_submit_without_node_or_local_core() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{
        Message,
        handshake::server::{Request, Response},
    };
    tokio::task::LocalSet::new().run_until(async {
        let temp=tempfile::tempdir().unwrap();let root=temp.path().canonicalize().unwrap();
        let (mut host,input,source)=resumable_host(&root);
        Rc::get_mut(&mut Rc::get_mut(&mut host).unwrap().migration).unwrap().vault=crate::vault::Vault::isolated_files(&host.home);
        storage::private_dir(&host.home.join("host/projects")).unwrap();
        std::fs::remove_dir_all(root.join("services/workbench")).unwrap();
        let options=frontend_options(&host,&source,input.options,None).unwrap();
        host.schedules.connections.frontend_subscribe(&host,"cloud-sessions",&source,options,None).unwrap();
        let workspace=root.join("workspace");storage::private_dir(&workspace).unwrap();
        let alias=super::super::worktree_catalog::add_project(&host,&source,json!({"root":workspace})).await.unwrap()["projectId"].as_str().unwrap().to_owned();
        let registration=super::super::worktree_catalog::project(&host,&source,&alias).unwrap();
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        host.gateway.workbench.cloud.settings(&host,&source,&json!({"operation":"save","baseURL":format!("ws://{}/app-server/",listener.local_addr().unwrap()),"token":"synthetic-cloud-token"})).await.unwrap();
        let calls=Rc::new(RefCell::new(Vec::<Value>::new()));let observed=calls.clone();
        let creation_id=uuid::Uuid::new_v4().to_string();let requested_id=creation_id.clone();
        let server=tokio::task::spawn_local(async move {
            let (stream,_)=listener.accept().await.unwrap();
            let mut socket=tokio_tungstenite::accept_hdr_async(stream,move|request:&Request,response:Response|{
                assert_eq!(request.headers().get("authorization").unwrap(),"Bearer synthetic-cloud-token");
                assert_eq!(request.uri().path(),format!("/app-server/{requested_id}/"));Ok(response)
            }).await.unwrap();
            let upload = tokio::task::spawn_local(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut head=Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    head.push(stream.read_u8().await.unwrap());
                    assert!(head.len()<8192);
                }
                let head=String::from_utf8(head).unwrap().to_lowercase();
                assert!(head.starts_with("post /app-server/"));
                assert!(head.contains("/areal/blobs?threadid=native-cloud-thread http/1.1"));
                assert!(head.contains("authorization: bearer synthetic-cloud-token\r\n"));
                let mut body=[0;5];stream.read_exact(&mut body).await.unwrap();assert_eq!(&body,b"hello");
                let body=json!({"uri":format!("areal://blob/{}",storage::digest(b"hello")),"mimeType":"text/plain","sizeBytes":5}).to_string();
                let response=format!("HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                stream.write_all(response.as_bytes()).await.unwrap();
            });
            let mut thread=json!({"id":"native-cloud-thread","turns":[],"status":{"type":"idle"},"desktop":{"archived":false,"configuration":{"revision":0}}});
            while let Some(Ok(Message::Text(raw)))=socket.next().await {
                let request:Value=serde_json::from_str(&raw).unwrap();if request.get("id").is_none(){continue;}
                observed.borrow_mut().push(request.clone());
                let result=match request["method"].as_str().unwrap() {
                    "initialize"=>json!({}),
                    "areal/capabilities"=>json!({"apiVersion":"areal.core.v1","methods":["areal/profile/list","areal/thread/start","thread/read","areal/thread/observe","areal/conversation/history","areal/turn/start","turn/interrupt","areal/request/read"],"features":{"conversationObservation":true,"threadCreationJournal":{"binding":{"identity":"remote-cloud-store","journalEpoch":"epoch","coreInstanceId":"remote-core"}}},"methodSemantics":{"areal/thread/start":{"effect":"mutation","receipt":"management"},"areal/turn/start":{"effect":"mutation","receipt":"management"},"turn/interrupt":{"effect":"mutation","receipt":"management"}}}),
                    "areal/profile/list"=>json!({"data":[{"id":"remote-default","revision":"v1"}]}),
                    "areal/model/list"=>json!({"data":[{"providerId":"remote","modelId":"remote-model","displayName":"Remote model","available":true}]}),
                    "areal/thread/start"=>{
                        assert_eq!(request["params"]["agentProfile"],json!({"id":"remote-default","revision":"v1"}));
                        assert!(request["params"].get("dynamicTools").is_none_or(|tools|tools==&json!([])));
                        json!({"thread":thread,"requestId":request["params"]["requestId"]})
                    },
                    "thread/read"|"areal/thread/observe"=>json!({"thread":thread}),
                    "areal/request/read"=>json!({"data":[]}),
                    "areal/turn/start"=>{
                        let turn=json!({"id":"native-cloud-turn","status":"completed","items":[{"id":"answer","type":"agentMessage","text":"REMOTE_OK"}]});
                        thread["turns"].as_array_mut().unwrap().push(turn.clone());
                        json!({"threadId":thread["id"],"turn":turn,"requestId":request["params"]["requestId"],"accepted":true})
                    },
                    "turn/interrupt"=>json!({}),
                    other=>panic!("unexpected {other}"),
                };
                socket.send(Message::Text(json!({"jsonrpc":"2.0","id":request["id"],"result":result}).to_string().into())).await.unwrap();
            }
            upload.await.unwrap();
        });
        let command=|request:Value|{let host=host.clone();let source=source.clone();async move {desktop_command(&host,"local","cloud-session",&json!({"params":{"sourceId":source,"command":"cloudSession","request":request}})).await}};
        let request=json!({"operation":"create","projectId":alias,"requestId":creation_id});
        let created=command(request.clone()).await.unwrap();
        assert_eq!(created,json!({"threadId":"native-cloud-thread","sessionId":creation_id}));
        assert_eq!(command(request).await.unwrap(),created);
        let view=serde_json::to_value(host.read_models.shell(&host).await.unwrap()).unwrap();
        let remote=view["projects"].as_array().unwrap().iter().find(|row|row["logicalProjectId"]==registration.project_id && row["summaries"]["items"].as_array().is_some_and(|rows|rows.iter().any(|row|row["id"]=="native-cloud-thread"))).expect("native shell must publish the real remote Thread under its logical project");
        assert_eq!(remote["state"],"ready");assert!(remote["serviceGeneration"].is_string());
        let virtual_id=remote["projectId"].as_str().unwrap();
        let mut gateway=crate::server::gateway_owner::LocalSession::new(host.clone(),"native-cloud-reader".into()).unwrap();
        let activated=gateway.request(&json!({"id":"cloud-activate","method":"project.activate","context":{"projectId":virtual_id},"params":{}})).await.unwrap();
        assert_eq!(activated["state"],"ready");
        assert!(!remote["workspace"].as_str().unwrap().is_empty());
        assert!(host.schedules.connections.shared_identity(&host,virtual_id).is_ok());

        let sent=command(json!({"operation":"send","projectId":alias,"threadId":"native-cloud-thread","text":"Hello remote"})).await.unwrap();
        assert_eq!(sent["turn"]["id"],"native-cloud-turn");
        command(json!({"operation":"stop","projectId":alias,"threadId":"native-cloud-thread","turnId":"native-cloud-turn"})).await.unwrap();
        let opened=gateway.request(&json!({"id":"cloud-read","method":"session.open","context":{"projectId":virtual_id,"serviceGeneration":remote["serviceGeneration"]},"params":{"threadId":"native-cloud-thread","view":"conversation"}})).await.unwrap();
        assert_eq!(opened["snapshot"]["thread"]["turns"][0]["items"][0]["text"],"REMOTE_OK");
        assert!(gateway.request(&json!({"id":"cloud-other","method":"session.open","context":{"projectId":virtual_id,"serviceGeneration":remote["serviceGeneration"]},"params":{"threadId":"another-thread","view":"conversation"}})).await.is_err());
        let models=gateway.request(&json!({"id":"cloud-models","method":"project.models","context":{"projectId":virtual_id},"params":{}})).await.unwrap();
        assert_eq!(models["models"][0]["modelId"],"remote-model");
        let uploaded=gateway.request(&json!({"id":"cloud-upload","method":"attachment.upload","context":{"projectId":virtual_id,"gatewayGeneration":host.identity.generation,"grantRevision":0,"serviceGeneration":remote["serviceGeneration"]},"params":{"threadId":"native-cloud-thread","uploadId":uuid::Uuid::new_v4().to_string(),"mimeType":"text/plain","sizeBytes":5,"offset":0,"base64":"aGVsbG8="}})).await.unwrap();
        assert_eq!(uploaded["attachment"]["uri"],format!("areal://blob/{}",storage::digest(b"hello")));
        host.schedules.connections.workbench_close_terminals();
        assert!(host.gateway.workbench.cloud.sessions.scope(&host,virtual_id).is_ok());
        let calls=calls.borrow();assert_eq!(calls.iter().filter(|call|call["method"]=="areal/thread/start").count(),1);assert_eq!(calls.iter().filter(|call|call["method"]=="areal/turn/start").count(),1);drop(calls);
        assert!(host.slots.borrow()[&registration.project_id].service.is_none());assert!(!host.gateway.workbench.has_running_backend());
        let unknown_id=uuid::Uuid::new_v4().to_string();
        let home=super::super::library_store::source_home(&host,&source).unwrap();
        let path=home.join("cloud-sessions.json");
        let mut rows:Vec<Value>=storage::read(&path).unwrap();
        rows.push(json!({"id":unknown_id,"projectId":alias,"binding":{"baseURL":"ws://example.invalid/app-server/old","threadRequestId":unknown_id},"originalUnknown":true}));
        storage::write(&path,&rows).unwrap();
        let original=std::fs::read(&path).unwrap();
        assert!(command(json!({"operation":"create","projectId":alias,"requestId":unknown_id})).await.unwrap_err().to_string().contains("SUBMISSION_UNKNOWN"));
        assert_eq!(std::fs::read(&path).unwrap(),original);
        host.gateway.workbench.cloud.settings(&host,&source,&json!({"operation":"save","baseURL":host.gateway.workbench.cloud.settings(&host,&source,&json!({"operation":"status"})).await.unwrap()["baseURL"],"token":"revised-synthetic-token"})).await.unwrap();
        assert!(host.gateway.workbench.cloud.sessions.scope(&host,virtual_id).is_err());
        assert!(host.schedules.connections.shared_identity(&host,virtual_id).is_err());
        host.gateway.workbench.cloud.sessions.close_all(&host);server.await.unwrap();
    }).await;
}

#[tokio::test]
async fn native_gui_terminal_uses_its_attachment_and_original_process_receipt() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    tokio::task::LocalSet::new().run_until(async {
        let temp=tempfile::tempdir().unwrap();let root=temp.path().canonicalize().unwrap();
        let (host,input,source)=resumable_host(&root);
        storage::private_dir(&host.home.join("host/projects")).unwrap();
        let options=frontend_options(&host,&source,input.options,None).unwrap();
        let (attached,_events)=host.schedules.connections.frontend_subscribe(&host,"terminal-main",&source,options,None).unwrap();
        let attachment=attached["attachmentId"].as_str().unwrap();
        host.slots.borrow_mut().remove("project");
        let workspace=root.join("workspace");storage::private_dir(&workspace).unwrap();
        let alias=super::super::worktree_catalog::add_project(&host,&source,json!({"root":workspace})).await.unwrap()["projectId"].as_str().unwrap().to_owned();
        let registration=super::super::worktree_catalog::project(&host,&source,&alias).unwrap();
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let service=areal_protocol::service::Service {
            identity:areal_protocol::service::Identity {protocol_version:1,service_id:"terminal-core".into(),generation:"terminal-generation".into(),workspace:registration.workspace.clone(),data_dir:registration.data_dir.clone(),config_fingerprint:"fixture".into()},
            owner:Some(host.owner()),endpoint:format!("ws://{}/",listener.local_addr().unwrap()),web_url:String::new(),auth_file:root.join("core-auth.json"),log_file:root.join("core.log"),host_pid:1,core_pid:2,state:areal_protocol::service::State::Ready,
        };
        storage::write(&service.auth_file,&json!({"principals":[{"id":"desktop-owner","token":"synthetic-terminal-token"}]})).unwrap();
        {let mut slots=host.slots.borrow_mut();let slot=slots.get_mut(&registration.project_id).unwrap();slot.state="ready".into();slot.service=Some(service);let(writer,lifetime)=areal_local_service::OwnerLifetime::pair().unwrap();slot.writer=Some(writer);slot.lifetime=Some(Rc::new(lifetime));}
        let home=super::super::library_store::source_home(&host,&source).unwrap();
        storage::private_dir(&home.join("thread-owners")).unwrap();storage::write(&home.join("thread-owners").join(format!("{alias}.json")),&json!(["terminal-thread"])).unwrap();
        std::fs::remove_dir_all(root.join("services/workbench")).unwrap();
        let calls=Rc::new(RefCell::new(Vec::<Value>::new()));let recorded=calls.clone();let remote_cwd=workspace.clone();
        let core=tokio::task::spawn_local(async move {
            let(stream,_)=listener.accept().await.unwrap();let mut socket=tokio_tungstenite::accept_async(stream).await.unwrap();let mut process_receipt=Value::Null;
            while let Some(Ok(Message::Text(raw)))=socket.next().await {
                let q:Value=serde_json::from_str(&raw).unwrap();if q.get("id").is_none(){continue;}
                recorded.borrow_mut().push(q.clone());
                let result=match q["method"].as_str().unwrap() {
                    "initialize"=>json!({}),
                    "areal/capabilities"=>json!({"apiVersion":"areal.core.v1","methods":["areal/process/start","areal/process/list","areal/process/get","areal/request/read"],"features":{"connectionProcesses":true,"threadCreationJournal":{"binding":{"identity":"terminal-store","journalEpoch":"epoch","coreInstanceId":"terminal-core"}}},"methodSemantics":{"areal/process/start":{"effect":"mutation","receipt":"thread"}}}),
                    "thread/read"=>json!({"thread":{"id":"terminal-thread","sessionId":"terminal-thread","cwd":remote_cwd,"conversation":{"kind":"ordinary","policy":{"kind":"ordinaryV1"}},"desktop":{"archived":false}}}),
                    "areal/task/list"=>json!({"data":[],"nextCursor":null}),
                    "areal/process/start"=>{
                        assert_eq!(q["params"]["lifetime"],"connection");assert_eq!(q["params"]["threadId"],"terminal-thread");
                        let params:areal_protocol::desktop::ProcessStart=serde_json::from_value(q["params"].clone()).unwrap();
                        let result=json!({"id":"native-process","processId":41});
                        process_receipt=json!({"requestId":q["params"]["requestId"],"method":"areal/process/start","threadId":"terminal-thread","identity":"terminal-store","digest":storage::digest(&serde_json::to_vec(&params).unwrap()),"status":"completed","operation":{"requestId":q["params"]["requestId"],"method":"areal/process/start","target":{"kind":"thread","threadId":"terminal-thread"}},"result":result});
                        result
                    },
                    "areal/process/list"=>json!({"data":[{"id":"native-process","processId":41,"argv":["/bin/sh"],"inputs":[],"cleanupConfirmed":false}]}),
                    "areal/process/get"=>json!({"id":"native-process","processId":41,"argv":["/bin/sh"],"cleanupConfirmed":false}),
                    "areal/request/read"=>{assert_eq!(q["params"]["threadId"],"terminal-thread");json!({"data":if process_receipt["requestId"]==q["params"]["requestId"] {vec![process_receipt.clone()]}else{vec![]}})},
                    other=>panic!("unexpected terminal RPC {other}"),
                };
                socket.send(Message::Text(json!({"jsonrpc":"2.0","id":q["id"],"result":result}).to_string().into())).await.unwrap();
            }
        });
        let command=|request:Value| {let host=host.clone();let attachment=attachment.to_owned();async move {host.schedules.connections.frontend_call(&host,&json!({"attachmentId":attachment,"call":"terminal.command","params":request})).await}};
        let request_id=uuid::Uuid::new_v4().to_string();
        let request=json!({"operation":"processStart","projectId":alias,"threadId":"terminal-thread","guiOwned":true,"requestId":request_id,"lifetime":"thread","argv":["/bin/sh"],"tty":true});
        assert_eq!(command(request.clone()).await.unwrap()["id"],"native-process");
        assert_eq!(command(request).await.unwrap()["id"],"native-process");
        let original=command(json!({"operation":"processSubmission","projectId":alias,"threadId":"terminal-thread","requestId":request_id,"guiOwned":true})).await.unwrap();
        assert_eq!(original["confirmed"],true);assert_eq!(original["result"]["id"],"native-process");
        host.schedules.connections.workbench_close_terminals();
        assert_eq!(command(json!({"operation":"process","projectId":alias,"threadId":"terminal-thread","id":"native-process","guiOwned":true})).await.unwrap()["id"],"native-process");
        assert_eq!(calls.borrow().iter().filter(|call|call["method"]=="areal/process/start").count(),1);
        assert!(!host.gateway.workbench.has_running_backend());
        host.schedules.connections.frontend_disconnect("terminal-main");
        assert!(command(json!({"operation":"process","projectId":alias,"threadId":"terminal-thread","id":"native-process","guiOwned":true})).await.is_err());
        core.await.unwrap();
    }).await;
}

#[tokio::test]
async fn native_remote_status_and_control_do_not_start_node() {
    tokio::task::LocalSet::new().run_until(async {
        let temp=tempfile::tempdir().unwrap();let root=temp.path().canonicalize().unwrap();
        let (mut host,input,source)=resumable_host(&root);
        Rc::get_mut(&mut Rc::get_mut(&mut host).unwrap().migration).unwrap().vault=crate::vault::Vault::isolated_files(&host.home);
        frontend_options(&host,&source,input.options,None).unwrap();
        std::fs::remove_dir_all(root.join("services/workbench")).unwrap();
        let call=|request:Value| {let host=host.clone();let source=source.clone();async move {desktop_command(&host,"local","remote-fixture",&json!({"params":{"command":"remoteControl","sourceId":source,"request":request}})).await}};
        let status=call(json!({"operation":"status"})).await.unwrap();
        assert_eq!(status["enabled"],false);assert_eq!(status["directEnabled"],false);
        assert!(host.remote.native_owner().unwrap().is_none());
        let id=uuid::Uuid::new_v4().to_string();
        let result=call(json!({"operation":"disable","requestId":id})).await.unwrap();
        assert_eq!(result["enabled"],false);
        let owned=host.remote.native_owner().unwrap().unwrap();assert_eq!(owned["sourceId"],source);
        let receipt=host.remote.operation(&id,&host.migration).unwrap().unwrap();
        assert_eq!(receipt["state"],"completed");
        let before=host.remote.snapshot(&host.migration).unwrap();
        assert_eq!(call(json!({"operation":"disable","requestId":id})).await.unwrap()["enabled"],false);
        assert_eq!(host.remote.snapshot(&host.migration).unwrap()["revision"],before["revision"]);
        let adapted=reverse(&host)("remote.control".into(),json!({"sourceId":source,"request":{"operation":"status"}})).await.unwrap();
        assert_eq!(adapted["enabled"],false);
        let pending=super::super::library_store::source_home(&host,&source).unwrap().join("host-remote-gateway-operation.json");
        let reference=json!({"version":1,"pending":{"requestId":uuid::Uuid::new_v4().to_string(),"sourceId":source,"hostId":host.identity.host_id,"generation":host.identity.generation,"method":"remote.gateway.control","expectedRevision":before["revision"],"controlDigest":"a".repeat(64)}});
        storage::write(&pending,&reference).unwrap();let original=std::fs::read(&pending).unwrap();
        assert_eq!(call(json!({"operation":"status"})).await.unwrap()["enabled"],false);
        assert!(call(json!({"operation":"disable"})).await.unwrap_err().to_string().contains("SUBMISSION_UNKNOWN"));
        assert_eq!(std::fs::read(&pending).unwrap(),original);
        assert_eq!(host.remote.snapshot(&host.migration).unwrap()["revision"],before["revision"]);
        assert!(!host.gateway.workbench.has_running_backend());
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn first_gui_activation_waits_for_its_native_launch_configuration() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let root = root.path().canonicalize().unwrap();
            let (host, mut input, source) = resumable_host(&root);
            std::fs::remove_dir_all(root.join("services/workbench")).unwrap();
            let profile = root.join("profile");
            let alias = "0123456789abcdef01234567";
            let registration = {
                let mut slots = host.slots.borrow_mut();
                let slot = slots.get_mut("project").unwrap();
                slot.registration.source = crate::ProjectSource::Gui {
                    profile,
                    legacy_project_id: alias.into(),
                };
                slot.registration.clone()
            };
            storage::private_dir(&registration.workspace).unwrap();
            storage::write(
                &root.join("data/projects.json"),
                &json!([{"id":alias,"root":registration.workspace}]),
            )
            .unwrap();
            let configuration = root.join("configuration");
            storage::private_dir(&configuration).unwrap();
            input.options["configHome"] = json!(configuration);
            let mut preparation = Box::pin(super::super::gui_project::missing_inputs(
                &host,
                &registration,
            ));
            assert!(
                matches!(
                    futures_util::poll!(preparation.as_mut()),
                    std::task::Poll::Pending
                ),
                "published source must await its Main launch configuration before activation"
            );
            host.schedules
                .connections
                .frontend_subscribe(&host, "native-initial-source", &source, input.options, None)
                .unwrap();
            let inputs = tokio::time::timeout(std::time::Duration::from_secs(1), preparation)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(inputs.workspace, registration.workspace);
            assert_eq!(inputs.config_home, configuration);
            assert!(!host.gateway.workbench.has_running_backend());
            host.schedules
                .connections
                .frontend_disconnect("native-initial-source");
        })
        .await;
}
