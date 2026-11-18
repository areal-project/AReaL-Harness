use super::*;
use crate::server::workbench_route::{
    backend_command, backend_read, desktop_command, desktop_command_capability,
};
use futures_util::{SinkExt, StreamExt};
use std::cell::Cell;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio_tungstenite::tungstenite::Message;

fn test_host(root: &Path) -> (Rc<Host>, String, String, PathBuf) {
    let mut host = crate::server::schedules::tests::fixture(root);
    host.bin = root.join("target/debug");
    let mut migration = crate::migration::Migration::new(&host.home).unwrap();
    migration.vault = crate::vault::Vault::isolated_files(&host.home);
    host.migration = migration.into();
    let config_home = root.join("config-home");
    let user_home = root.join("user-home");
    for dir in [
        &host.bin,
        &root.join("profile"),
        &root.join("data"),
        &config_home,
        &config_home.join("plugins"),
        &user_home,
    ] {
        areal_local_service::storage::private_dir(dir).unwrap();
    }
    let source = crate::migration::Source {
        profile: root.join("profile"),
        core_home: root.join("data"),
        legacy_service_home: root.join("legacy"),
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
    let alias = "fedcba9876543210fedcba98".to_owned();
    let workspace = root.join("project");
    areal_local_service::storage::private_dir(&workspace).unwrap();
    {
        let mut slots = host.slots.borrow_mut();
        let slot = slots.get_mut("project").unwrap();
        slot.registration.workspace = workspace.clone();
        slot.registration.source = crate::ProjectSource::Gui {
            profile: source.profile.clone(),
            legacy_project_id: alias.clone(),
        };
    }
    areal_local_service::storage::write(
        &source.core_home.join("projects.json"),
        &json!([{ "id": alias, "root": workspace }]),
    )
    .unwrap();
    let launch_dir = host
        .home
        .join("host/launch")
        .join(areal_local_service::storage::digest(b"project"));
    areal_local_service::storage::private_dir(&launch_dir).unwrap();
    let launch_inputs = crate::LaunchInputs {
        workspace: workspace.clone(),
        cwd: workspace.clone(),
        config_home: config_home.clone(),
        homedir: Some(user_home.clone()),
        config_path: None,
        deployment_path: None,
        schedule_preparation: None,
        environment: Default::default(),
        credential_names: Vec::new(),
        options: Default::default(),
    };
    areal_local_service::storage::write(&launch_dir.join("inputs.json"), &launch_inputs).unwrap();

    let host = Rc::new(host);
    host.gateway.workbench.set_test_source_and_options(
        &source_id,
        json!({
            "home": root.join("data"),
            "configHome": config_home,
            "userHome": user_home,
        }),
    );
    (host, source_id, alias, workspace)
}

async fn run_desktop_manage(host: &Rc<Host>, request: Value) -> Result<Value> {
    desktop_command(
        host,
        "local-desktop",
        "conn-1",
        &json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "method": "desktop.command",
            "params": {
                "command": "manage",
                "request": request,
            }
        }),
    )
    .await
}

fn fixture_server_status() -> Value {
    json!({
        "acceptingWork": true,
        "activeGoals": [],
        "activeTasks": 0,
        "activeTurns": [],
        "apiVersion": "areal.core.v1",
        "capacity": {
            "activeTurns": 0,
            "blobBytes": 0,
            "historyBytesPerThread": 0,
            "maxActiveTurns": 4,
            "maxThreads": 8,
            "threads": 0
        },
        "closed": false,
        "compactions": [],
        "configuration": Value::Null,
        "draining": false,
        "idleForMs": 0,
        "lifecycle": {
            "admission": "open",
            "executionOutcomes": { "uninspectedUnknown": 0 },
            "ifIdle": { "allowed": true, "reasons": [] },
            "settled": { "allowed": true, "reasons": [] },
            "version": 1
        },
        "pendingQueueItems": 0,
        "queues": [],
        "productVersion": "fixture",
        "resources": [],
        "restartSafe": true,
        "runtime": Value::Null,
        "stateVersion": 1,
        "unresolvedTools": [],
        "workgroups": []
    })
}

fn fixture_workgroup() -> Value {
    json!({
        "id": "wg-1",
        "candidatePath": "/tmp/cand",
        "recordPath": "/tmp/rec",
        "historyCount": 0,
        "verificationCount": 0,
        "record": {
            "attempts": 0,
            "conflicts": 0,
            "repairs": 0,
            "head": "abc123",
            "objective": "verify workgroup",
            "peakWorkers": 1,
            "planRevision": 1,
            "status": "running",
            "strategy": "single",
            "tasks": [],
            "version": 1,
            "wallSeconds": 0.1
        }
    })
}

fn fixture_plugin_detail() -> Value {
    json!({
        "admissionDigest": Value::Null,
        "catalogSource": Value::Null,
        "componentChoices": Value::Null,
        "componentSupport": Value::Null,
        "components": ["skill"],
        "description": "fixture plugin",
        "developmentLink": Value::Null,
        "diagnostics": [],
        "displayName": "Fixture",
        "enabled": true,
        "id": "fixture@local",
        "installed": true,
        "installedDigest": "digest-1",
        "installedSkills": [{ "id": "s1", "requiredTools": ["browser_v1"] }],
        "installedSourceDigest": "digest-1",
        "revision": 2,
        "status": {
            "state": "available",
            "nextAction": "none",
            "reason": Value::Null
        },
        "userConfiguration": {
            "fields": {
                "token": {
                    "definition": { "type": "string", "sensitive": true },
                    "configured": false
                },
                "note": {
                    "definition": { "type": "string", "sensitive": false },
                    "configured": false
                }
            }
        }
    })
}

async fn start_mock_core<F>(
    host: &Rc<Host>,
    mut handler: F,
) -> (tokio::task::JoinHandle<()>, Box<dyn Fn()>)
where
    F: FnMut(&str, &Value) -> Value + 'static,
{
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
    let server = tokio::task::spawn_local(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        while let Some(Ok(Message::Text(text))) = socket.next().await {
            let call: Value = serde_json::from_str(&text).unwrap();
            if call.get("id").is_none() {
                continue;
            }
            let method = call["method"].as_str().unwrap();
            let result = handler(method, &call["params"]);
            socket
                .send(Message::Text(
                    json!({ "jsonrpc": "2.0", "id": call["id"], "result": result })
                        .to_string()
                        .into(),
                ))
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
    (server, close)
}

#[tokio::test(flavor = "current_thread")]
async fn manage_reads_and_capabilities_run_without_node_backend() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let base = root.path().canonicalize().unwrap();
            let (host, source, alias, _workspace) = test_host(&base);

            assert_eq!(
                desktop_command_capability(&json!({"command":"manage","request":{"operation":"contextCompact"}})),
                Some("submit")
            );
            assert_eq!(
                desktop_command_capability(&json!({"command":"manage","request":{"operation":"executionCancel"}})),
                Some("interrupt")
            );
            assert_eq!(
                desktop_command_capability(&json!({"command":"manage","request":{"operation":"server"}})),
                None
            );

            let (server, close_core) = start_mock_core(&host, |method, params| match method {
                "initialize" => json!({}),
                "areal/task/list" => json!({ "data": [], "nextCursor": null }),
                "areal/capabilities" => json!({
                    "methods": [
                        "areal/plugin/list",
                        "areal/workgroup/start",
                        "areal/thread/observe",
                        "areal/thread/tools/attach"
                    ],
                    "features": {
                        "browserToolAttachment": true,
                        "computerToolAttachment": true,
                        "computerToolPreparation": true
                    },
                    "browserToolBundles": [{ "bundleId": "areal.browser.v1" }],
                    "desktopToolBundles": [{ "bundleId": "areal.computer.v1" }]
                }),
                "areal/server/status" => fixture_server_status(),
                "areal/workgroup/read" => {
                    assert_eq!(params["id"], "wg-1");
                    fixture_workgroup()
                }
                "areal/plugin/read" => {
                    let mut detail = fixture_plugin_detail();
                    if params["id"] == "computer@local" {
                        detail["id"] = json!("computer@local");
                        detail["installedSkills"] =
                            json!([{ "id": "s1", "requiredTools": ["browser_v1", "computer_v1"] }]);
                    } else {
                        assert_eq!(params["id"], "fixture@local");
                    }
                    detail
                }
                other => panic!("unexpected mock core method: {other}"),
            })
            .await;

            // manage.read RPCs
            let srv = backend_read(
                &host,
                "local",
                &json!({"method":"manage.read","params":{"sourceId":source,"projectId":alias,"operation":"server"}}),
            )
            .await
            .unwrap();
            assert_eq!(srv["apiVersion"], "areal.core.v1");

            let wg_rpc = backend_read(
                &host,
                "local",
                &json!({"method":"manage.read","params":{"sourceId":source,"projectId":alias,"operation":"workgroup","id":"wg-1"}}),
            )
            .await
            .unwrap();
            assert_eq!(wg_rpc["candidatePath"], "/tmp/cand");
            assert_eq!(wg_rpc["recordPath"], "/tmp/rec");

            let plugins_rpc = backend_read(
                &host,
                "local",
                &json!({"method":"manage.read","params":{"sourceId":source,"projectId":alias,"operation":"plugins"}}),
            )
            .await
            .unwrap();
            assert!(plugins_rpc["data"].is_array());

            // desktop.command "manage" capabilities, readiness, stripped workgroup, and pluginStore*
            assert_eq!(
                run_desktop_manage(&host, json!({"projectId":alias,"operation":"pluginCapabilities"}))
                    .await
                    .unwrap()["enabled"],
                true
            );
            assert_eq!(
                run_desktop_manage(&host, json!({"projectId":alias,"operation":"workgroupCapabilities"}))
                    .await
                    .unwrap()["enabled"],
                true
            );

            // Stale digest rejected
            assert!(
                run_desktop_manage(
                    &host,
                    json!({"projectId":alias,"operation":"pluginReadiness","id":"fixture@local","expectedDigest":"stale"})
                )
                .await
                .is_err()
            );

            // Headless (no desktop client PID) -> browser_v1 missing
            let headless = run_desktop_manage(
                &host,
                json!({"projectId":alias,"operation":"pluginReadiness","id":"fixture@local","expectedDigest":"digest-1"}),
            )
            .await
            .unwrap();
            assert_eq!(headless["available"], false);
            assert_eq!(headless["missingTools"], json!(["browser_v1"]));

            // Desktop owner connected -> browser_v1 deployed; computer_v1 removed so stays missing
            host.clients.borrow_mut().insert("desktop-1".into(), Some(12345));
            let desktop_ready = run_desktop_manage(
                &host,
                json!({"projectId":alias,"operation":"pluginReadiness","id":"fixture@local","expectedDigest":"digest-1"}),
            )
            .await
            .unwrap();
            assert_eq!(desktop_ready["available"], true);
            assert_eq!(desktop_ready["missingTools"], json!([]));
            let computer_missing = run_desktop_manage(
                &host,
                json!({"projectId":alias,"operation":"pluginReadiness","id":"computer@local","expectedDigest":"digest-1"}),
            )
            .await
            .unwrap();
            assert_eq!(computer_missing["available"], false);
            assert_eq!(computer_missing["missingTools"], json!(["computer_v1"]));
            host.clients.borrow_mut().remove("desktop-1");

            let wg_desktop = run_desktop_manage(
                &host,
                json!({"projectId":alias,"operation":"workgroup","id":"wg-1"}),
            )
            .await
            .unwrap();
            assert_eq!(wg_desktop["id"], "wg-1");
            assert!(wg_desktop.get("candidatePath").is_none());
            assert!(wg_desktop.get("recordPath").is_none());

            let snapshot = run_desktop_manage(
                &host,
                json!({"projectId":alias,"operation":"pluginStoreSnapshot"}),
            )
            .await
            .unwrap();
            assert_eq!(snapshot["runtimeObserved"], false);
            assert_eq!(snapshot["list"]["revision"], plugins_rpc["revision"]);

            let doctor = run_desktop_manage(
                &host,
                json!({"projectId":alias,"operation":"pluginStoreDoctor"}),
            )
            .await
            .unwrap();
            assert_eq!(doctor["runtimeObserved"], false);
            assert!(doctor["data"].is_array());

            close_core();
            server.abort();
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn manage_mutations_artifacts_and_plugin_credentials_run_without_node_backend() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let base = root.path().canonicalize().unwrap();
            let (host, source, alias, workspace) = test_host(&base);

            let artifact_bytes = b"hello artifact\n";
            let artifact_sha = sha256_hex(artifact_bytes);
            let artifact_b64 = {
                use base64::{Engine, engine::general_purpose::STANDARD};
                STANDARD.encode(artifact_bytes)
            };
            let registered_credentials = Rc::new(RefCell::new(None));
            let reg_creds_cb = registered_credentials.clone();
            let saved_secret_ref = Rc::new(RefCell::new(None));
            let saved_ref_cb = saved_secret_ref.clone();
            let config_request_id = uuid::Uuid::new_v4().to_string();
            let original_config_request = config_request_id.clone();
            let clear_request_id = uuid::Uuid::new_v4().to_string();
            let original_clear_request = clear_request_id.clone();
            let config_writes = Rc::new(Cell::new(0));
            let config_writes_cb = config_writes.clone();
            let mut config_digest = None;
            let connected_plugin = Rc::new(Cell::new(false));
            let connected_cb = connected_plugin.clone();
            let wg_started = Rc::new(Cell::new(false));
            let wg_started_cb = wg_started.clone();
            let archive_count = Rc::new(AtomicUsize::new(0));
            let archive_cb = archive_count.clone();
            let ws_clone = workspace.clone();

            let (server, close_core) = start_mock_core(&host, move |method, params| match method {
                "initialize" => json!({}),
                "areal/task/list" => json!({ "data": [], "nextCursor": null }),
                "areal/capabilities" => json!({
                    "methodSemantics": {
                        "areal/thread/archive": { "effect": "mutation", "receipt": "management" },
                        "areal/workgroup/start": { "effect": "mutation", "receipt": "management" },
                        "areal/plugin/userConfig/set": { "effect": "mutation", "receipt": "management" },
                        "areal/plugin/auth/configure": { "effect": "mutation", "receipt": "management" }
                    },
                    "features": { "threadCreationJournal": { "binding": {
                        "identity": "desktop-owner",
                        "journalEpoch": "fixture-epoch",
                        "coreInstanceId": "fixture-core"
                    } } }
                }),
                "thread/read" => {
                    let tid = params["threadId"].as_str().unwrap();
                    let append = if tid == "draft-1" {
                        json!("AREAL_TASK_DRAFT_V1\nTime zone: UTC\n")
                    } else {
                        Value::Null
                    };
                    let mut options = json!({ "permissionPreset": "ask" });
                    if !append.is_null() {
                        options["appendInstructions"] = append;
                    }
                    json!({
                        "thread": {
                            "id": tid,
                            "sessionId": "session-1",
                            "cwd": ws_clone,
                            "conversation": { "kind": "ordinary", "policy": { "kind": "ordinaryV1" } },
                            "turns": [],
                            "desktop": { "configuration": { "revision": 1, "options": options } }
                        }
                    })
                }
                "areal/thread/archive" => {
                    archive_cb.fetch_add(1, Ordering::SeqCst);
                    json!({
                        "archived": true,
                        "history": "retained",
                        "receiptsRetained": true,
                        "threadId": params["threadId"]
                    })
                }
                "areal/plan/update" => json!({
                    "revision": 2,
                    "steps": params["steps"]
                }),
                "areal/server/gc" => json!({
                    "deletedBlobs": 1,
                    "reclaimedBytes": 64,
                    "retainedBytes": 0
                }),
                "areal/workgroup/artifact" => json!({
                    "head": "head-1",
                    "path": "out/file.txt",
                    "exists": true,
                    "bytes": artifact_bytes.len(),
                    "baseSha256": Value::Null,
                    "sha256": artifact_sha,
                    "executable": false,
                    "offset": 0,
                    "nextOffset": artifact_bytes.len(),
                    "dataBase64": artifact_b64,
                    "complete": true
                }),
                "areal/plugin/read" => fixture_plugin_detail(),
                "areal/plugin/credentials/register" => {
                    *reg_creds_cb.borrow_mut() = Some(params["credentials"].clone());
                    json!({})
                }
                "areal/plugin/userConfig/set" => {
                    config_writes_cb.set(config_writes_cb.get() + 1);
                    if params["requestId"] == original_clear_request {
                        assert_eq!(params["clearKeys"], json!(["token"]));
                        assert_eq!(params["values"], json!({}));
                        assert!(params.get("secrets").is_none());
                        return fixture_plugin_detail();
                    }
                    assert_eq!(params["requestId"], original_config_request);
                    config_digest = Some(areal_local_service::storage::digest(
                        &serde_json::to_vec(&params).unwrap(),
                    ));
                    assert_eq!(params["values"]["token"]["kind"], "secretRef");
                    *saved_ref_cb.borrow_mut() =
                        params["values"]["token"]["value"].as_str().map(str::to_owned);
                    fixture_plugin_detail()
                }
                "areal/plugin/mcp/list" => json!({
                    "data":[{"pluginId":"fixture@local","installedDigest":"digest-1",
                        "state":if connected_cb.get() {"connected"} else {"disconnected"},
                        "servers":[{"serverId":"fixture-server"}]}]
                }),
                "areal/plugin/auth/configure" => {
                    assert_eq!(params["expectedDigest"], "digest-1");
                    assert_eq!(params["server"], "fixture-server");
                    assert!(params.get("credentials").is_none());
                    assert!(!params.to_string().contains("synthetic-auth-secret"));
                    json!({"configuration":params["configuration"]})
                }
                "areal/workgroup/start" => {
                    wg_started_cb.set(true);
                    fixture_workgroup()
                }
                "areal/request/read" => {
                    if params["requestId"] == original_config_request {
                        json!({
                            "data": [{
                                "requestId": original_config_request,
                                "method": "areal/plugin/userConfig/set",
                                "status": "completed",
                                "identity": "desktop-owner",
                                "digest": config_digest.as_ref().unwrap(),
                                "result": fixture_plugin_detail()
                            }]
                        })
                    } else if wg_started_cb.get() {
                        json!({
                            "data": [{
                                "requestId": params["requestId"],
                                "method": "areal/workgroup/start",
                                "status": "completed",
                                "identity": "desktop-owner",
                                "result": fixture_workgroup()
                            }]
                        })
                    } else {
                        json!({ "data": [] })
                    }
                }
                other => panic!("unexpected mock core method: {other}"),
            })
            .await;

            // 1. manage.command archive + planUpdate + serverGc
            let archive_cmd = uuid::Uuid::new_v4().to_string();
            let archived = backend_command(
                &host,
                "local",
                &json!({
                    "method": "manage.command",
                    "commandId": archive_cmd,
                    "params": {
                        "sourceId": source,
                        "projectId": alias,
                        "operation": "archive",
                        "threadId": "t-1"
                    }
                }),
            )
            .await
            .unwrap();
            assert_eq!(archived["receipt"]["archived"], true);
            assert_eq!(archive_count.load(Ordering::SeqCst), 1);

            let plan_cmd = uuid::Uuid::new_v4().to_string();
            let plan = backend_command(
                &host,
                "local",
                &json!({
                    "method": "manage.command",
                    "commandId": plan_cmd,
                    "params": {
                        "sourceId": source,
                        "projectId": alias,
                        "operation": "planUpdate",
                        "threadId": "t-1",
                        "expectedRevision": 1,
                        "steps": [{ "id": "s1", "status": "pending", "text": "do work" }]
                    }
                }),
            )
            .await
            .unwrap();
            assert_eq!(plan["receipt"]["revision"], 2);

            let gc_cmd = uuid::Uuid::new_v4().to_string();
            let gc = backend_command(
                &host,
                "local",
                &json!({
                    "method": "manage.command",
                    "commandId": gc_cmd,
                    "params": {
                        "sourceId": source,
                        "projectId": alias,
                        "operation": "serverGc"
                    }
                }),
            )
            .await
            .unwrap();
            assert_eq!(gc["receipt"]["deletedBlobs"], 1);

            // 2. workgroupArtifactStatus -> workgroupApplyArtifact -> external edit conflict
            let st1 = run_desktop_manage(
                &host,
                json!({
                    "projectId": alias,
                    "operation": "workgroupArtifactStatus",
                    "id": "wg-1",
                    "path": "out/file.txt",
                    "head": "head-1"
                }),
            )
            .await
            .unwrap();
            assert_eq!(st1["state"], "ready");

            let applied = run_desktop_manage(
                &host,
                json!({
                    "projectId": alias,
                    "operation": "workgroupApplyArtifact",
                    "id": "wg-1",
                    "path": "out/file.txt",
                    "head": "head-1"
                }),
            )
            .await
            .unwrap();
            assert_eq!(applied["state"], "matches");
            assert_eq!(
                std::fs::read(workspace.join("out/file.txt")).unwrap(),
                artifact_bytes
            );

            std::fs::write(workspace.join("out/file.txt"), b"external change\n").unwrap();
            let conflict_status = run_desktop_manage(
                &host,
                json!({
                    "projectId": alias,
                    "operation": "workgroupArtifactStatus",
                    "id": "wg-1",
                    "path": "out/file.txt",
                    "head": "head-1"
                }),
            )
            .await
            .unwrap();
            assert_eq!(conflict_status["state"], "conflict");
            assert!(
                run_desktop_manage(
                    &host,
                    json!({
                        "projectId": alias,
                        "operation": "workgroupApplyArtifact",
                        "id": "wg-1",
                        "path": "out/file.txt",
                        "head": "head-1"
                    })
                )
                .await
                .is_err()
            );
            assert_eq!(
                std::fs::read(workspace.join("out/file.txt")).unwrap(),
                b"external change\n"
            );

            // 3. pluginUserConfigSave stores secret in isolated vault + registers credential
            let cfg_res = run_desktop_manage(
                &host,
                json!({
                    "projectId": alias,
                    "operation": "pluginUserConfigSave",
                    "requestId": config_request_id,
                    "id": "fixture@local",
                    "expectedRevision": 2,
                    "expectedDigest": "digest-1",
                    "values": { "note": { "kind": "string", "value": "hello" } },
                    "secrets": { "token": "secret-token-value" }
                }),
            )
            .await
            .unwrap();
            assert_eq!(cfg_res["id"], "fixture@local");
            let query = |mutation: &str, request_id: &str| {
                json!({
                    "projectId": alias,
                    "operation": "pluginSubmission",
                    "mutation": mutation,
                    "requestId": request_id
                })
            };
            let recovered = run_desktop_manage(
                &host,
                query("pluginUserConfigSave", &config_request_id),
            )
            .await
            .unwrap();
            assert_eq!(recovered["confirmed"], true);
            assert_eq!(recovered["result"]["id"], cfg_res["id"]);
            assert!(run_desktop_manage(&host, query("pluginSetup", &config_request_id)).await.is_err());
            let unknown = run_desktop_manage(
                &host,
                query("pluginUserConfigSave", &uuid::Uuid::new_v4().to_string()),
            )
            .await
            .unwrap();
            assert_eq!(unknown["confirmed"], false);
            assert_eq!(config_writes.get(), 1);
            let secret_ref = saved_secret_ref.borrow().clone().unwrap();
            assert_eq!(
                registered_credentials.borrow().as_ref().unwrap()[&secret_ref],
                "secret-token-value"
            );
            let registered = registered_credentials.borrow().clone();
            let clear = run_desktop_manage(
                &host,
                json!({
                    "projectId": alias,
                    "operation": "pluginUserConfigSave",
                    "requestId": clear_request_id,
                    "id": "fixture@local",
                    "expectedRevision": 2,
                    "expectedDigest": "digest-1",
                    "values": {},
                    "clearKeys": ["token"]
                }),
            )
            .await
            .unwrap();
            assert_eq!(clear["id"], cfg_res["id"]);
            assert_eq!(config_writes.get(), 2);
            assert_eq!(*registered_credentials.borrow(), registered);

            let auth_request = json!({
                "projectId":alias, "operation":"pluginAuthCredential",
                "id":"fixture@local", "server":"fixture-server",
                "expectedDigest":"digest-1", "configuration":{},
                "credentials":{"clientSecret":"synthetic-auth-secret"}
            });
            let mut stale = auth_request.clone();
            stale["expectedDigest"] = json!("stale");
            assert!(run_desktop_manage(&host, stale).await.is_err());
            connected_plugin.set(true);
            assert!(run_desktop_manage(&host, auth_request.clone()).await.is_err());
            assert_eq!(registered_credentials.borrow().as_ref().unwrap()[&secret_ref], "secret-token-value");
            connected_plugin.set(false);
            let authenticated = run_desktop_manage(&host, auth_request).await.unwrap();
            let auth_ref = authenticated["configuration"]["clientSecretRef"].as_str().unwrap();
            assert_eq!(registered_credentials.borrow().as_ref().unwrap()[auth_ref], "synthetic-auth-secret");

            // 4. workgroupStart + workgroupSubmission
            let wg_req_id = uuid::Uuid::new_v4().to_string();
            let started = run_desktop_manage(
                &host,
                json!({
                    "projectId": alias,
                    "operation": "workgroupStart",
                    "requestId": wg_req_id,
                    "plan": { "objective": "obj", "tasks": [] },
                    "workers": 1,
                    "admission": {}
                }),
            )
            .await
            .unwrap();
            assert_eq!(started["id"], "wg-1");
            assert!(started.get("candidatePath").is_none());

            let recovered = run_desktop_manage(
                &host,
                json!({
                    "projectId": alias,
                    "operation": "workgroupSubmission",
                    "requestId": wg_req_id
                }),
            )
            .await
            .unwrap();
            assert_eq!(recovered["confirmed"], true);
            assert_eq!(recovered["workgroupId"], "wg-1");
            assert_eq!(recovered["planRevision"], 1);

            // 5. Task-draft thread rejects goalCreate
            let goal_err = run_desktop_manage(
                &host,
                json!({
                    "projectId": alias,
                    "operation": "goalCreate",
                    "threadId": "draft-1",
                    "expectedRevision": 0,
                    "objective": "should reject"
                }),
            )
            .await
            .unwrap_err();
            assert_eq!(
                goal_err.downcast_ref::<crate::wire::Error>().unwrap().code,
                "COMMAND_FAILED"
            );

            close_core();
            server.abort();
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn native_resource_inspection_uses_current_core_and_redacts_process_arguments() {
    tokio::task::LocalSet::new().run_until(async {
        let temp=tempfile::tempdir().unwrap();let base=temp.path().canonicalize().unwrap();
        let (host,source,alias,workspace)=test_host(&base);
        let (server,close)=start_mock_core(&host,|method,_params| match method {
            "initialize"=>json!({}),
            "areal/capabilities"=>json!({"methods":[],"features":{}}),
            "areal/server/status"=>{let mut status=fixture_server_status();status["resources"]=json!([{"threadId":"thread","id":"process"}]);status["runtime"]=json!({"runtimeEpoch":"runtime"});status["lifecycle"]["ifIdle"]["allowed"]=json!(false);status},
            "areal/process/list"=>json!({"data":[{"id":"process","runtimeEpoch":"runtime","state":"running","argv":["/bin/sh","synthetic-secret-argument"],"cleanupConfirmed":false}]}),
            "areal/task/list"=>json!({"data":[],"nextCursor":null}),
            other=>panic!("unexpected inspection RPC {other}"),
        }).await;
        let (revision,mut journal)=host.journal.native_snapshot("project").unwrap();
        let creation=uuid::Uuid::new_v4().to_string();
        let other_creation=uuid::Uuid::new_v4().to_string();
        journal["pending"]=json!([
            {"method":"areal/process/start","params":{"requestId":uuid::Uuid::new_v4().to_string(),"threadId":"thread","argv":["synthetic-pending-secret"]}},
            {"method":"areal/thread/start","params":{"requestId":creation,"text":"synthetic-creation-body"},"operation":{"requestId":creation,"method":"areal/thread/start","target":{"kind":"project"}}},
            {"method":"areal/thread/start","params":{"requestId":other_creation},"operation":{"requestId":creation,"method":"areal/thread/start","target":{"kind":"project"}}}
        ]);
        host.journal.native_replace("project",revision,journal.clone()).unwrap();
        let value=host.gateway.workbench.resources.command(&host,&source,&json!({"operation":"inspect","includeTasks":true})).await.unwrap();
        assert_eq!(value[0]["projectId"],alias);assert_eq!(value[0]["root"],json!(workspace));
        assert_eq!(value[0]["observation"],"known");assert_eq!(value[0]["restartSafe"],false);
        assert_eq!(value[0]["resources"][0]["executable"],"/bin/sh");
        assert!(!value.to_string().contains("synthetic-secret-argument"));
        assert!(!value.to_string().contains("synthetic-pending-secret"));
        assert!(!value.to_string().contains("synthetic-creation-body"));
        assert_eq!(value[0]["pendingRequests"][0]["threadId"],"thread");
        assert_eq!(value[0]["pendingRequests"][1],json!({"awaitingResponse":false,"creationRequestId":creation}));
        assert_eq!(value[0]["pendingRequests"][2],json!({"awaitingResponse":false}));
        assert_eq!(host.journal.native_snapshot("project").unwrap().1["pending"],journal["pending"]);
        close();server.await.unwrap();
        let stopped=host.gateway.workbench.resources.command(&host,&source,&json!({"operation":"inspect"})).await.unwrap();
        assert_eq!(stopped[0]["observation"],"unavailable");
    }).await;
}
