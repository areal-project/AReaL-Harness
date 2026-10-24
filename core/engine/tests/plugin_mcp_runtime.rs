//! 边界：纯 MCP 包不靠 Skill 激活；发现不运行；显式摘要连接；App 同代隔离、单次日志调用与失效。
use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelEvent, ModelStream},
};
use areal_plugins::Store;
use async_trait::async_trait;
use serde_json::json;
use std::{fs, path::Path, sync::Arc};
struct ModelFixture;
#[async_trait]
impl Model for ModelFixture {
    fn name(&self) -> &str {
        "fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        Ok(Box::pin(futures_util::stream::iter(vec![Ok(
            ModelEvent::text("done"),
        )])))
    }
}
fn write(root: &Path, path: &str, value: &str) {
    let p = root.join(path);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, value).unwrap();
}
#[tokio::test]
async fn mcp_only_discovery_trust_and_revocation() {
    let t = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    write(
        t.path(),
        ".agents/plugins/marketplace.json",
        r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
    );
    write(
        t.path(),
        "pkg/.codex-plugin/plugin.json",
        r#"{"name":"sample"}"#,
    );
    write(
        t.path(),
        "pkg/server.py",
        include_str!("../../mcp/tests/substrate.py"),
    );
    write(t.path(),"pkg/.mcp.json",&json!({"mcpServers":{"fixture":{"command":"python3","args":["server.py"],"env":{"LITERAL":"private-literal"}}}}).to_string());
    let e = Engine::open(state.path(), Arc::new(ModelFixture), Limits::default()).unwrap();
    e.set_permissions(
        serde_json::from_value(json!({"mode":"ASK_PERMISSIONS","ask":["mcp__*"]})).unwrap(),
        None,
    )
    .unwrap();
    let s = Arc::new(Store::open(t.path().join("plugins"), t.path().into(), None).unwrap());
    e.install_plugin_store(s.clone()).unwrap();
    let d = s.read("sample@local").unwrap();
    e.plugin_install(
        d.id.clone(),
        "user".into(),
        d.revision,
        d.source,
        d.source_digest,
    )
    .await
    .unwrap();
    let d = s.read(&d.id).unwrap();
    let digest = d.installed_digest.unwrap();
    let listed = e.plugin_mcp_list().await.unwrap();
    assert!(!listed.to_string().contains("private-literal"));
    assert_eq!(listed["data"][0]["state"], "disconnected");
    assert!(
        e.plugin_connection(d.id.clone(), "wrong".into(), true)
            .await
            .is_err()
    );
    e.plugin_connection(d.id.clone(), digest, true)
        .await
        .unwrap();
    let apps = e.mcp_apps_list(None).await.unwrap();
    assert_eq!(apps["data"].as_array().unwrap().len(), 1);
    let server = apps["data"][0]["serverId"].as_str().unwrap().to_owned();
    let generation = apps["data"][0]["generation"].as_u64().unwrap();
    let thread = e.create(t.path().to_str().unwrap().into()).await.unwrap();
    assert!(
        e.mcp_app_open(
            "owner".into(),
            None,
            thread.id.clone(),
            server.clone(),
            generation + 1,
            "app".into(),
            None,
            "badgen".into(),
            None,
            None
        )
        .await
        .is_err()
    );
    write(t.path(), "input.txt", "private file content");
    let app = e
        .mcp_app_open(
            "owner".into(),
            None,
            thread.id.clone(),
            server.clone(),
            generation,
            "app".into(),
            None,
            "open".into(),
            Some(json!({"uri":"opaque://file","path":t.path().join("input.txt")})),
            None,
        )
        .await
        .unwrap();
    assert_eq!(app["resource"]["html"], "<p>Hello</p>");
    let instance = app["instanceId"].as_str().unwrap().to_owned();
    let file_request = |method: &str, params: serde_json::Value| json!({"jsonrpc":"2.0","id":30,"method":"ui/host-file","params":{"request":{"jsonrpc":"2.0","id":31,"method":method,"params":params}}});
    let read = e
        .mcp_app_request(
            "owner".into(),
            thread.id.clone(),
            instance.clone(),
            generation,
            file_request("resources/read", json!({"uri":"opaque://file"})),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        read["result"]["contents"][0]["text"],
        "private file content"
    );
    assert_eq!(
        read["result"]["contents"][0]["_meta"]["openai/resource"]["writable"],
        false
    );
    assert!(
        e.mcp_app_request(
            "owner".into(),
            thread.id.clone(),
            instance.clone(),
            generation,
            file_request(
                "openai/resources/write",
                json!({"uri":"opaque://file","text":"mutated"})
            ),
            None
        )
        .await
        .is_err()
    );
    assert!(
        e.mcp_app_request(
            "owner".into(),
            thread.id.clone(),
            instance.clone(),
            generation,
            file_request("resources/read", json!({"uri":"opaque://other"})),
            None
        )
        .await
        .is_err()
    );
    fs::remove_file(t.path().join("input.txt")).unwrap();
    std::os::unix::fs::symlink(t.path().join("pkg/server.py"), t.path().join("input.txt")).unwrap();
    assert!(
        e.mcp_app_request(
            "owner".into(),
            thread.id.clone(),
            instance.clone(),
            generation,
            file_request("resources/read", json!({"uri":"opaque://file"})),
            None
        )
        .await
        .is_err()
    );
    assert!(
        e.mcp_app_request(
            "other".into(),
            thread.id.clone(),
            instance.clone(),
            generation,
            json!({"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"ui://app"}}),
            None
        )
        .await
        .is_err()
    );
    e.mcp_app_request("owner".into(),thread.id.clone(),instance.clone(),generation,json!({"jsonrpc":"2.0","id":2,"method":"ui/update-model-context","params":{"content":[{"type":"text","text":"new context","_meta":{"secret":true}}]}}),None).await.unwrap();
    let request = json!({"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"app","arguments":{}}});
    let job = {
        let e = e.clone();
        let thread = thread.id.clone();
        let instance = instance.clone();
        let request = request.clone();
        tokio::spawn(async move {
            e.mcp_app_request(
                "owner".into(),
                thread,
                instance,
                generation,
                request,
                Some("tool-once".into()),
            )
            .await
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    if job.is_finished() {
        panic!(
            "early App outcome: {:?}; state: {:?}",
            job.await.unwrap(),
            e.read(&thread.id, true).await.unwrap()
        );
    }
    approve(&e, &thread.id).await;
    let called = tokio::time::timeout(std::time::Duration::from_secs(5), job)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(called["result"]["_meta"]["secret"], "retained");
    let retry = e
        .mcp_app_request(
            "owner".into(),
            thread.id.clone(),
            instance.clone(),
            generation,
            request,
            Some("tool-once".into()),
        )
        .await
        .unwrap();
    assert_eq!(called, retry);
    assert_eq!(e.read(&thread.id, true).await.unwrap().turns.len(), 1);
    let context = e.context_read(&thread.id, 0, 16).await.unwrap().to_string();
    assert!(!context.contains("retained"));
    let form_request = json!({"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"app","arguments":{"form":"elicitation/create"}}});
    let job = {
        let e = e.clone();
        let thread = thread.id.clone();
        let instance = instance.clone();
        tokio::spawn(async move {
            e.mcp_app_request(
                "owner".into(),
                thread,
                instance,
                generation,
                form_request,
                Some("form-once".into()),
            )
            .await
        })
    };
    approve(&e, &thread.id).await;
    let form = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let data = e.mcp_forms_list(thread.id.clone()).await.unwrap();
            if let Some(form) = data["data"].as_array().unwrap().first() {
                break form.clone();
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        e.mcp_form_respond(
            "other".into(),
            thread.id.clone(),
            form["requestId"].as_str().unwrap().into(),
            json!({"action":"accept","content":{"answer":"yes"}})
        )
        .await
        .is_err()
    );
    assert!(
        e.mcp_form_respond(
            "owner".into(),
            thread.id.clone(),
            form["requestId"].as_str().unwrap().into(),
            json!({"action":"accept","content":{"answer":true}})
        )
        .await
        .is_err()
    );
    e.mcp_form_respond(
        "owner".into(),
        thread.id.clone(),
        form["requestId"].as_str().unwrap().into(),
        json!({"action":"accept","content":{"answer":"yes"}}),
    )
    .await
    .unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(5), job)
            .await
            .unwrap()
            .unwrap()
            .is_ok()
    );
    let pending_call = {
        let e = e.clone();
        let thread_id = thread.id.clone();
        let instance = instance.clone();
        tokio::spawn(async move {
            e.mcp_app_request("owner".into(),thread_id,instance,generation,json!({"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"app","arguments":{"form":"elicitation/create"}}}),Some("cancel-form".into())).await
        })
    };
    approve(&e, &thread.id).await;
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if !e.mcp_forms_list(thread.id.clone()).await.unwrap()["data"]
                .as_array()
                .unwrap()
                .is_empty()
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let revision = s.list().unwrap().revision;
    let saved_path = state.path().join("desktop/mcp-apps.json");
    let mut saved: serde_json::Value =
        serde_json::from_slice(&fs::read(&saved_path).unwrap()).unwrap();
    s.configure(&d.id, "user", false, revision).unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(5), pending_call)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    assert!(
        e.mcp_forms_list(thread.id.clone()).await.unwrap()["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        e.start(
            &thread.id,
            vec![areal_protocol::Input::text("do not replay")]
        )
        .await
        .is_err()
    );
    assert!(
        e.mcp_app_request(
            "owner".into(),
            thread.id.clone(),
            instance.clone(),
            generation,
            json!({"jsonrpc":"2.0","id":3,"method":"resources/read","params":{"uri":"ui://app"}}),
            None
        )
        .await
        .is_err()
    );
    e.shutdown().await;
    drop(e);
    s.configure(&d.id, "user", true, s.list().unwrap().revision)
        .unwrap();
    // Simulate the persisted generation number reused by a fresh Core process.
    saved["instances"][&instance]["generation"] = json!(1);
    fs::write(&saved_path, serde_json::to_vec(&saved).unwrap()).unwrap();
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "persisted_app_epoch_probe", "--nocapture"])
        .env("AREAL_EPOCH_TEST_STATE", state.path())
        .env("AREAL_EPOCH_TEST_WORKSPACE", t.path())
        .env("AREAL_EPOCH_TEST_THREAD", &thread.id)
        .env("AREAL_EPOCH_TEST_INSTANCE", &instance)
        .output()
        .unwrap();
    assert!(
        child.status.success(),
        "restart probe failed ({:?}): {} {}",
        child.status,
        String::from_utf8_lossy(&child.stdout),
        String::from_utf8_lossy(&child.stderr)
    );
}

#[tokio::test]
async fn persisted_app_epoch_probe() {
    let Ok(state) = std::env::var("AREAL_EPOCH_TEST_STATE") else {
        return;
    };
    let workspace = std::path::PathBuf::from(std::env::var("AREAL_EPOCH_TEST_WORKSPACE").unwrap());
    let e = Engine::open(
        std::path::Path::new(&state),
        Arc::new(ModelFixture),
        Limits::default(),
    )
    .unwrap();
    let store = Arc::new(Store::open(workspace.join("plugins"), workspace, None).unwrap());
    e.install_plugin_store(store.clone()).unwrap();
    let detail = store.read("sample@local").unwrap();
    e.plugin_connection(detail.id, detail.installed_digest.unwrap(), true)
        .await
        .unwrap();
    assert_eq!(
        e.mcp_apps_list(None).await.unwrap()["data"][0]["generation"],
        1
    );
    let result = e
        .mcp_app_request(
            "owner".into(),
            std::env::var("AREAL_EPOCH_TEST_THREAD").unwrap(),
            std::env::var("AREAL_EPOCH_TEST_INSTANCE").unwrap(),
            1,
            json!({"jsonrpc":"2.0","id":100,"method":"resources/read","params":{"uri":"ui://app"}}),
            None,
        )
        .await;
    e.shutdown().await;
    assert!(
        result.is_err(),
        "persisted App capability revived after restart: {result:?}"
    );
}

async fn approve(e: &Arc<Engine>, thread: &str) {
    let pending = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let interactions = e.interactions(thread).await.unwrap();
            if let Some(item) = interactions["data"]
                .as_array()
                .unwrap()
                .iter()
                .find(|i| i["status"] == "pending")
            {
                break item.clone();
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|error| panic!("approval wait: {error}"));
    e.respond(serde_json::from_value(json!({"threadId":thread,"turnId":pending["turnId"],"requestId":pending["requestId"],"decision":"allowOnce","argumentsDigest":pending["argumentsDigest"]})).unwrap()).await.unwrap();
}
struct GatedModel {
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
    rounds: std::sync::atomic::AtomicUsize,
    schemas: std::sync::Mutex<Vec<Vec<serde_json::Value>>>,
}
#[tokio::test]
async fn component_disable_revokes_captured_tools_and_retained_app_handles() {
    let workspace = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    write(
        workspace.path(),
        ".agents/plugins/marketplace.json",
        r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
    );
    write(
        workspace.path(),
        "pkg/.codex-plugin/plugin.json",
        r#"{"name":"sample"}"#,
    );
    let script = include_str!("../../mcp/tests/substrate.py")
        .replace("[\"app\"]", "[\"app\",\"model\"]")
        .replace("r=json.loads(line);m=r.get(\"method\");p=r.get(\"params\",{});out=None", "r=json.loads(line);m=r.get(\"method\");p=r.get(\"params\",{});out=None\n if m==\"tools/call\":open(os.environ[\"COUNTER\"],\"a\").write(\"called\\n\")");
    write(workspace.path(), "pkg/server.py", &script);
    write(workspace.path(), "pkg/.mcp.json", &json!({"mcpServers":{"fixture":{"command":"python3","args":["server.py"],"env":{"COUNTER":workspace.path().join("calls.txt")}}}}).to_string());
    let model = Arc::new(GatedModel {
        entered: Default::default(),
        release: Default::default(),
        rounds: Default::default(),
        schemas: Default::default(),
    });
    let engine = Engine::open(state.path(), model.clone(), Limits::default()).unwrap();
    let store = Arc::new(
        Store::open(
            workspace.path().join("plugins"),
            workspace.path().into(),
            None,
        )
        .unwrap(),
    );
    engine.install_plugin_store(store.clone()).unwrap();
    let detail = store.read("sample@local").unwrap();
    engine
        .plugin_install(
            detail.id.clone(),
            "user".into(),
            detail.revision,
            detail.source,
            detail.source_digest,
        )
        .await
        .unwrap();
    let detail = store.read(&detail.id).unwrap();
    engine
        .plugin_connection(
            detail.id.clone(),
            detail.installed_digest.clone().unwrap(),
            true,
        )
        .await
        .unwrap();
    let apps = engine.mcp_apps_list(None).await.unwrap();
    let server = apps["data"][0]["serverId"].as_str().unwrap().to_owned();
    let generation = apps["data"][0]["generation"].as_u64().unwrap();
    let thread = engine
        .create(workspace.path().to_str().unwrap().into())
        .await
        .unwrap();
    let app = engine
        .mcp_app_open(
            "owner".into(),
            None,
            thread.id.clone(),
            server.clone(),
            generation,
            "app".into(),
            None,
            "component-open".into(),
            None,
            None,
        )
        .await
        .unwrap();
    engine
        .start(&thread.id, vec![areal_protocol::Input::text("run")])
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), model.entered.notified())
        .await
        .unwrap();
    write(workspace.path(), "pkg/version.txt", "new package bytes");
    let updated = store.read(&detail.id).unwrap();
    engine
        .plugin_install(
            updated.id.clone(),
            "user".into(),
            updated.revision,
            updated.source,
            updated.source_digest,
        )
        .await
        .unwrap();
    let updated = store.read(&detail.id).unwrap();
    let component = areal_plugins::PluginComponentId::McpServer { id: server.clone() };
    assert!(
        engine
            .plugin_component_configure(
                updated.id.clone(),
                component.clone(),
                false,
                updated.revision,
                detail.installed_digest.unwrap()
            )
            .await
            .is_err()
    );
    engine
        .plugin_component_configure(
            updated.id.clone(),
            component.clone(),
            false,
            updated.revision,
            updated.installed_digest.clone().unwrap(),
        )
        .await
        .unwrap();
    let rows = engine.plugin_mcp_list().await.unwrap();
    assert_eq!(rows["data"][0]["servers"][0]["projectEnabled"], false);
    assert_eq!(rows["data"][0]["servers"][0]["state"], "disabled");
    assert!(engine.mcp_app_request("owner".into(), thread.id.clone(), app["instanceId"].as_str().unwrap().into(), generation, json!({"jsonrpc":"2.0","id":2,"method":"resources/read","params":{"uri":"ui://app"}}), None).await.is_err());
    assert!(
        engine
            .mcp_app_open(
                "owner".into(),
                None,
                thread.id.clone(),
                server,
                generation,
                "app".into(),
                None,
                "component-reopen".into(),
                None,
                None
            )
            .await
            .is_err()
    );
    model.release.notify_one();
    tokio::time::timeout(std::time::Duration::from_secs(5), engine.wait(&thread.id))
        .await
        .unwrap()
        .unwrap();
    assert!(
        !workspace.path().join("calls.txt").exists(),
        "captured disabled MCP tool executed"
    );
    let disabled = store.read(&detail.id).unwrap();
    engine
        .plugin_component_configure(
            disabled.id.clone(),
            component,
            true,
            disabled.revision,
            disabled.installed_digest.unwrap(),
        )
        .await
        .unwrap();
    assert!(
        engine.mcp_apps_list(None).await.unwrap()["data"]
            .as_array()
            .unwrap()
            .is_empty(),
        "enabling must not reconnect"
    );
    let enabled = store.read(&detail.id).unwrap();
    engine
        .plugin_connection(enabled.id, enabled.installed_digest.unwrap(), true)
        .await
        .unwrap();
    assert_eq!(
        engine.mcp_apps_list(None).await.unwrap()["data"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    engine.shutdown().await;
}
#[async_trait]
impl Model for GatedModel {
    fn name(&self) -> &str {
        "gated"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(
        &self,
        _: Vec<Message>,
        tools: Vec<serde_json::Value>,
    ) -> anyhow::Result<ModelStream> {
        self.schemas.lock().unwrap().push(tools.clone());
        let round = self
            .rounds
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let event = if round == 0 {
            self.entered.notify_one();
            self.release.notified().await;
            let name = tools
                .iter()
                .find_map(|t| {
                    t["function"]["name"]
                        .as_str()
                        .filter(|n| n.ends_with("__app"))
                })
                .unwrap();
            ModelEvent::ToolCall(areal_engine::model::ToolCall {
                id: "old-call".into(),
                name: name.into(),
                arguments: "{}".into(),
            })
        } else {
            ModelEvent::text("done")
        };
        Ok(Box::pin(futures_util::stream::iter(vec![Ok(event)])))
    }
}
#[tokio::test]
async fn active_schema_survives_update_and_busy_configure() {
    let t = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    write(
        t.path(),
        ".agents/plugins/marketplace.json",
        r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
    );
    write(
        t.path(),
        "pkg/.codex-plugin/plugin.json",
        r#"{"name":"sample"}"#,
    );
    let script =
        include_str!("../../mcp/tests/substrate.py").replace("[\"app\"]", "[\"app\",\"model\"]");
    write(t.path(), "pkg/server.py", &script);
    write(t.path(),"pkg/.mcp.json",&json!({"mcpServers":{"fixture":{"command":"python3","args":["server.py"],"env":{"LITERAL":"old-generation"}}}}).to_string());
    let model = Arc::new(GatedModel {
        entered: Default::default(),
        release: Default::default(),
        rounds: Default::default(),
        schemas: Default::default(),
    });
    let e = Engine::open(state.path(), model.clone(), Limits::default()).unwrap();
    let s = Arc::new(Store::open(t.path().join("plugins"), t.path().into(), None).unwrap());
    e.install_plugin_store(s.clone()).unwrap();
    let d = s.read("sample@local").unwrap();
    e.plugin_install(
        d.id.clone(),
        "user".into(),
        d.revision,
        d.source,
        d.source_digest,
    )
    .await
    .unwrap();
    let d = s.read(&d.id).unwrap();
    e.plugin_connection(d.id.clone(), d.installed_digest.unwrap(), true)
        .await
        .unwrap();
    let thread = e.create(t.path().to_str().unwrap().into()).await.unwrap();
    e.start(&thread.id, vec![areal_protocol::Input::text("run")])
        .await
        .unwrap();
    model.entered.notified().await;
    write(
        t.path(),
        "pkg/server.py",
        &script.replace("\"name\":\"app\"", "\"name\":\"replacement\""),
    );
    write(t.path(), "pkg/.mcp.json", &json!({"mcpServers":{"renamed":{"command":"python3","args":["server.py"],"env":{"LITERAL":"new-generation"}}}}).to_string());
    let next = s.read(&d.id).unwrap();
    e.plugin_install(
        next.id.clone(),
        "user".into(),
        next.revision,
        next.source,
        next.source_digest,
    )
    .await
    .unwrap();
    let next = s.read(&d.id).unwrap();
    e.plugin_connection(next.id, next.installed_digest.unwrap(), true)
        .await
        .unwrap();
    assert!(
        e.configure_thread(
            serde_json::from_value(
                json!({"threadId":thread.id,"expectedRevision":1,"parameters":{}})
            )
            .unwrap()
        )
        .await
        .is_err()
    );
    model.release.notify_one();
    let completed = tokio::time::timeout(std::time::Duration::from_secs(5), e.wait(&thread.id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        completed.turns.last().unwrap().status,
        areal_protocol::TurnStatus::Completed
    );
    assert!(
        serde_json::to_string(&completed)
            .unwrap()
            .contains("old-generation")
    );
    e.start(&thread.id, vec![areal_protocol::Input::text("next")])
        .await
        .unwrap();
    e.wait(&thread.id).await.unwrap();
    {
        let schemas = model.schemas.lock().unwrap();
        assert_eq!(schemas[0], schemas[1]);
        assert_ne!(schemas[1], schemas[2]);
    }
    e.shutdown().await;
}

// Real MCP transport and descriptor IO; Runtime connection only supplies deployment capabilities.
async fn file_runtime() -> (
    Arc<areal_runtime_client::Client>,
    tokio::task::JoinHandle<()>,
) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let (local, peer) = tokio::io::duplex(65536);
    let (read, write) = tokio::io::split(local);
    let (peer_read, mut peer_write) = tokio::io::split(peer);
    let task = tokio::spawn(async move {
        let mut lines = BufReader::new(peer_read).lines();
        while let Some(line) = lines.next_line().await.unwrap() {
            let r: serde_json::Value = serde_json::from_str(&line).unwrap();
            let result = match r["method"].as_str().unwrap() {
                "connection.open" => {
                    json!({"protocolVersion":"areal.runtime.v0","runtimeEpoch":"fixture","connectionId":"fixture","rootScopeId":"fixture:scope:root","capabilities":{"methods":["fs.execute"]}})
                }
                "connection.close" => json!({"closed":true}),
                other => panic!("unexpected Runtime operation {other}"),
            };
            peer_write
                .write_all(format!("{}\n", json!({"id":r["id"],"result":result})).as_bytes())
                .await
                .unwrap();
            if r["method"] == "connection.close" {
                break;
            }
        }
    });
    (
        areal_runtime_client::Client::connect(read, write)
            .await
            .unwrap(),
        task,
    )
}

#[tokio::test]
async fn app_file_receipt_and_close_context_race() {
    let workspace = tempfile::tempdir().unwrap();
    let workspace_root = workspace.path().canonicalize().unwrap();
    let data = tempfile::tempdir().unwrap();
    let block = workspace_root.as_path().join("block");
    let entered = workspace_root.as_path().join("entered");
    write(
        workspace_root.as_path(),
        ".agents/plugins/marketplace.json",
        r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
    );
    write(
        workspace_root.as_path(),
        "pkg/.codex-plugin/plugin.json",
        r#"{"name":"sample"}"#,
    );
    let script=include_str!("../../mcp/tests/substrate.py").replace("import sys,json,os","import sys,json,os,time").replace("elif m==\"resources/read\":out=",&format!("elif m==\"resources/read\":\n  if os.path.exists({}):\n   open({},'w').close()\n   while os.path.exists({}):time.sleep(0.01)\n  out=",json!(block),json!(entered),json!(block)));
    write(workspace_root.as_path(), "pkg/server.py", &script);
    write(
        workspace_root.as_path(),
        "pkg/.mcp.json",
        r#"{"mcpServers":{"fixture":{"command":"python3","args":["server.py"]}}}"#,
    );
    write(workspace_root.as_path(), "file.txt", "original");
    let (runtime, peer) = file_runtime().await;
    let e = Engine::open_with_runtime(
        data.path(),
        Arc::new(ModelFixture),
        Limits::default(),
        areal_engine::tools::RuntimeConfig {
            client: runtime.clone(),
            workspace: workspace_root.as_path().into(),
            writable: true,
            command_scope: None,
            command_scratch: None,
        },
    )
    .unwrap();
    let store = Arc::new(
        Store::open(
            workspace_root.as_path().join("plugins"),
            workspace_root.as_path().into(),
            None,
        )
        .unwrap(),
    );
    e.install_plugin_store(store.clone()).unwrap();
    let d = store.read("sample@local").unwrap();
    e.plugin_install(
        d.id.clone(),
        "user".into(),
        d.revision,
        d.source,
        d.source_digest,
    )
    .await
    .unwrap();
    let d = store.read(&d.id).unwrap();
    e.plugin_connection(d.id, d.installed_digest.unwrap(), true)
        .await
        .unwrap();
    let apps = e.mcp_apps_list(None).await.unwrap();
    let server = apps["data"][0]["serverId"].as_str().unwrap().to_owned();
    let generation = apps["data"][0]["generation"].as_u64().unwrap();
    let thread = e
        .create(workspace_root.as_path().to_str().unwrap().into())
        .await
        .unwrap();
    let app = e
        .mcp_app_open(
            "owner".into(),
            None,
            thread.id.clone(),
            server.clone(),
            generation,
            "app".into(),
            None,
            "file-open".into(),
            Some(json!({"uri":"opaque://file","path":workspace_root.as_path().join("file.txt")})),
            None,
        )
        .await
        .unwrap();
    let instance = app["instanceId"].as_str().unwrap().to_owned();
    let request = |text: &str| json!({"jsonrpc":"2.0","id":1,"method":"ui/host-file","params":{"request":{"jsonrpc":"2.0","id":2,"method":"openai/resources/write","params":{"uri":"opaque://file","text":text}}}});
    let key = uuid::Uuid::new_v4().to_string();
    let first = e
        .mcp_app_request(
            "owner".into(),
            thread.id.clone(),
            instance.clone(),
            generation,
            request("saved"),
            Some(key.clone()),
        )
        .await
        .unwrap();
    assert_eq!(first["result"]["outcome"], "saved");
    write(
        workspace_root.as_path(),
        "file.txt",
        "intervening user edit",
    );
    let retry = e
        .mcp_app_request(
            "owner".into(),
            thread.id.clone(),
            instance.clone(),
            generation,
            request("saved"),
            Some(key.clone()),
        )
        .await
        .unwrap();
    assert_eq!(retry, first);
    assert_eq!(
        fs::read_to_string(workspace_root.as_path().join("file.txt")).unwrap(),
        "intervening user edit"
    );
    assert!(matches!(
        e.mcp_app_request(
            "owner".into(),
            thread.id.clone(),
            instance.clone(),
            generation,
            request("different"),
            Some(key)
        )
        .await,
        Err(areal_engine::Error::Rejected(error)) if matches!(*error, areal_engine::Error::Conflict)
    ));

    // Hold App mutation across a real resource request, queue close first, then update.
    fs::write(&block, "").unwrap();
    let opening = {
        let e = e.clone();
        let thread = thread.id.clone();
        tokio::spawn(async move {
            e.mcp_app_open(
                "owner".into(),
                None,
                thread,
                server,
                generation,
                "app".into(),
                None,
                "blocking-open".into(),
                None,
                None,
            )
            .await
        })
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !entered.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let closing = {
        let e = e.clone();
        let thread = thread.id.clone();
        let instance = instance.clone();
        tokio::spawn(async move {
            e.mcp_app_close("owner".into(), thread, instance, generation)
                .await
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    let updating = {
        let e = e.clone();
        let thread = thread.id.clone();
        let instance = instance.clone();
        tokio::spawn(async move {
            e.mcp_app_request("owner".into(),thread,instance,generation,json!({"jsonrpc":"2.0","id":3,"method":"ui/update-model-context","params":{"content":[{"type":"text","text":"must not resurrect"}]}}),None).await
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    fs::remove_file(block).unwrap();
    opening.await.unwrap().unwrap();
    closing.await.unwrap().unwrap();
    assert!(updating.await.unwrap().is_err());
    let records: serde_json::Value =
        serde_json::from_slice(&fs::read(data.path().join("desktop/mcp-apps.json")).unwrap())
            .unwrap();
    assert!(records.get(&instance).is_none());
    e.shutdown().await;
    runtime.shutdown().await.unwrap();
    peer.await.unwrap();
}

#[tokio::test]
async fn long_mcp_aliases_are_valid_distinct_and_preserve_connector_id() {
    let workspace = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    write(
        workspace.path(),
        ".agents/plugins/marketplace.json",
        r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
    );
    write(
        workspace.path(),
        "pkg/.codex-plugin/plugin.json",
        r#"{"name":"sample"}"#,
    );
    write(
        workspace.path(),
        "pkg/server.py",
        include_str!("../../mcp/tests/substrate.py"),
    );
    let original = "original-github-acceptance-id";
    write(
        workspace.path(),
        "pkg/.app.json",
        &json!({"apps":[{"id":original,"name":"GitHub"}]}).to_string(),
    );
    let config = json!({"command":"python3","args":["server.py"]});
    let mut servers = serde_json::Map::new();
    for name in [
        original,
        "identical-prefix-server-name-one",
        "identical-prefix-server-name-two",
    ] {
        servers.insert(name.into(), config.clone());
    }
    write(
        workspace.path(),
        "pkg/.mcp.json",
        &json!({"mcpServers":servers}).to_string(),
    );
    let e = Engine::open(data.path(), Arc::new(ModelFixture), Limits::default()).unwrap();
    let store = Arc::new(
        Store::open(
            workspace.path().join("plugins"),
            workspace.path().into(),
            None,
        )
        .unwrap(),
    );
    e.install_plugin_store(store.clone()).unwrap();
    let d = store.read("sample@local").unwrap();
    e.plugin_install(
        d.id.clone(),
        "user".into(),
        d.revision,
        d.source,
        d.source_digest,
    )
    .await
    .unwrap();
    let d = store.read(&d.id).unwrap();
    let digest = d.installed_digest.unwrap();
    e.plugin_connection(d.id.clone(), digest.clone(), true)
        .await
        .unwrap();
    let apps = e.mcp_apps_list(None).await.unwrap();
    let aliases: std::collections::BTreeSet<_> = apps["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["serverId"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(aliases.len(), 3);
    assert!(aliases.iter().all(|name| name.len() <= 32));
    e.plugin_connection(d.id.clone(), digest.clone(), false)
        .await
        .unwrap();
    let mapping = e
        .connector_configure(
            d.id.clone(),
            original.into(),
            "github".into(),
            "fixture-reference".into(),
            digest,
        )
        .await
        .unwrap();
    assert_eq!(mapping["connectorId"], original);
    assert_eq!(
        e.plugin_component_summary(d.id).await.unwrap()["apps"][0]["id"],
        original
    );
    e.shutdown().await;
}

#[tokio::test]
async fn optional_server_readiness_preserves_healthy_siblings() {
    for mode in [
        "optional",
        "required",
        "auth",
        "disabled-auth",
        "unsupported-auth",
        "all-failed",
        "all-auth",
        "all-disabled",
    ] {
        let workspace = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        write(
            workspace.path(),
            ".agents/plugins/marketplace.json",
            r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
        );
        let portable = mode == "unsupported-auth";
        write(
            workspace.path(),
            if portable {
                "pkg/plugin.json"
            } else {
                "pkg/.codex-plugin/plugin.json"
            },
            if portable {
                r#"{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"sample"}"#
            } else {
                r#"{"name":"sample"}"#
            },
        );
        write(
            workspace.path(),
            "pkg/server.py",
            include_str!("../../mcp/tests/substrate.py"),
        );
        let good = if portable {
            json!({"type":"stdio","command":"python3","args":["server.py"]})
        } else {
            json!({"command":"python3","args":["server.py"]})
        };
        let bad = match mode {
            "unsupported-auth" => {
                json!({"type":"streamable-http","url":"https://example.invalid/mcp","extensions":{"com.openai":{"auth":{"type":"api_key","headerScheme":"bearer"}}}})
            }
            "auth" | "all-auth" => json!({"url":"https://example.invalid/mcp","auth":"oauth"}),
            "disabled-auth" | "all-disabled" => {
                json!({"url":"https://example.invalid/mcp","auth":"oauth","enabled":false})
            }
            _ => json!({"command":"/no-such-fixture-command","required":mode=="required"}),
        };
        let mut servers = json!({"bad":bad});
        if !mode.starts_with("all-") {
            servers["good"] = good;
        }
        if mode == "optional" {
            servers["malformed"] = json!(7);
        }
        write(
            workspace.path(),
            if portable {
                "pkg/mcp.json"
            } else {
                "pkg/.mcp.json"
            },
            &if portable {json!({"$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json","mcpServers":servers})} else {json!({"mcpServers":servers})}.to_string(),
        );
        let e = Engine::open(data.path(), Arc::new(ModelFixture), Limits::default()).unwrap();
        let store = Arc::new(
            Store::open(
                workspace.path().join("plugins"),
                workspace.path().into(),
                None,
            )
            .unwrap(),
        );
        e.install_plugin_store(store.clone()).unwrap();
        let d = store.read("sample@local").unwrap();
        e.plugin_install(
            d.id.clone(),
            "user".into(),
            d.revision,
            d.source,
            d.source_digest,
        )
        .await
        .unwrap();
        let d = store.read(&d.id).unwrap();
        let digest = d.installed_digest.unwrap();
        let result = e
            .plugin_connection(d.id.clone(), digest.clone(), true)
            .await;
        if mode == "required" {
            assert!(result.is_err());
            assert!(
                e.mcp_apps_list(None).await.unwrap()["data"]
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
        } else {
            let value = result.unwrap_or_else(|error| panic!("{mode}: {error}"));
            let row = &value["data"][0];
            let expected = match mode {
                "disabled-auth" => "connected",
                "all-disabled" => "disabled",
                "all-auth" => "authRequired",
                "all-failed" => "failed",
                _ => "partial",
            };
            assert_eq!(row["state"], expected, "{mode}");
            assert_eq!(
                e.mcp_apps_list(None).await.unwrap()["data"]
                    .as_array()
                    .unwrap()
                    .len(),
                if mode.starts_with("all-") { 0 } else { 1 },
                "{mode}"
            );
            if expected == "partial" {
                assert_eq!(
                    e.plugin_connection(d.id.clone(), digest, true)
                        .await
                        .unwrap()["data"][0]["state"],
                    "partial"
                );
                assert!(!row["diagnostics"].as_array().unwrap().is_empty());
            }
            assert!(
                row["servers"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|server| server["state"].is_string())
            );
        }
        e.shutdown().await;
    }
}

struct ProfileInventory(std::sync::Mutex<Vec<Vec<serde_json::Value>>>);
#[async_trait]
impl Model for ProfileInventory {
    fn name(&self) -> &str {
        "profile-inventory"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(
        &self,
        _: Vec<Message>,
        tools: Vec<serde_json::Value>,
    ) -> anyhow::Result<ModelStream> {
        self.0.lock().unwrap().push(tools);
        Ok(Box::pin(futures_util::stream::iter([Ok(
            ModelEvent::text("done"),
        )])))
    }
}
#[tokio::test]
async fn explicit_profile_entrypoint_does_not_expand_model_or_app_visibility() {
    let workspace = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    write(
        workspace.path(),
        ".agents/plugins/marketplace.json",
        r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
    );
    write(
        workspace.path(),
        "pkg/.codex-plugin/plugin.json",
        r#"{"name":"sample"}"#,
    );
    let script = include_str!("../../mcp/tests/substrate.py")
        .replace("\"visibility\":[\"app\"]", "\"visibility\":[\"model\"]")
        .replace(
            "}},\"icons\"",
            "},\"openai/ui\":{\"entrypoints\":[{\"type\":\"global\"}]}},\"icons\"",
        );
    write(workspace.path(), "pkg/server.py", &script);
    write(
        workspace.path(),
        "pkg/.mcp.json",
        r#"{"mcpServers":{"fixture":{"command":"python3","args":["server.py"]}}}"#,
    );
    let model = Arc::new(ProfileInventory(Default::default()));
    let e = Engine::open(data.path(), model.clone(), Limits::default()).unwrap();
    write(
        workspace.path(),
        "deployment.json",
        r#"{"profiles":[{"id":"explicit","revision":"v1","displayName":"Explicit","instructions":""},{"id":"restricted","revision":"v1","displayName":"Restricted","instructions":"","toolAllowlist":[]}]}"#,
    );
    e.install_deployment(&workspace.path().join("deployment.json"))
        .unwrap();
    let store = Arc::new(
        Store::open(
            workspace.path().join("plugins"),
            workspace.path().into(),
            None,
        )
        .unwrap(),
    );
    e.install_plugin_store(store.clone()).unwrap();
    let d = store.read("sample@local").unwrap();
    e.plugin_install(
        d.id.clone(),
        "user".into(),
        d.revision,
        d.source,
        d.source_digest,
    )
    .await
    .unwrap();
    let d = store.read(&d.id).unwrap();
    e.plugin_connection(d.id, d.installed_digest.unwrap(), true)
        .await
        .unwrap();
    let apps = e.mcp_apps_list(None).await.unwrap();
    let server = apps["data"][0]["serverId"].as_str().unwrap().to_owned();
    let generation = apps["data"][0]["generation"].as_u64().unwrap();
    let thread = e
        .create(workspace.path().to_str().unwrap().into())
        .await
        .unwrap();
    e.configure_thread(serde_json::from_value(json!({"threadId":thread.id,"expectedRevision":1,"agentProfile":{"id":"explicit","revision":"v1"}})).unwrap()).await.unwrap();
    assert!(
        !e.read(&thread.id, true)
            .await
            .unwrap()
            .desktop
            .unwrap()
            .configuration
            .allow_plugin_skills
    );
    let app = e
        .mcp_app_open(
            "owner".into(),
            None,
            thread.id.clone(),
            server.clone(),
            generation,
            "app".into(),
            Some(json!({})),
            "entrypoint".into(),
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(app["initialResult"]["structuredContent"]["v"], 1);
    assert!(
        model.0.lock().unwrap().is_empty(),
        "explicit App call must not run inference"
    );
    let instance = app["instanceId"].as_str().unwrap().to_owned();
    assert!(e.mcp_app_request("owner".into(),thread.id.clone(),instance,generation,json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"app","arguments":{}}}),Some("not-an-entrypoint".into())).await.is_err());
    e.start(
        &thread.id,
        vec![areal_protocol::Input::text("ordinary inventory")],
    )
    .await
    .unwrap();
    e.wait(&thread.id).await.unwrap();
    assert!(model.0.lock().unwrap().iter().flatten().all(|tool| {
        !tool["function"]["name"]
            .as_str()
            .unwrap_or("")
            .starts_with("mcp__")
    }));
    let restricted = e
        .create(workspace.path().to_str().unwrap().into())
        .await
        .unwrap();
    e.configure_thread(serde_json::from_value(json!({"threadId":restricted.id,"expectedRevision":1,"agentProfile":{"id":"restricted","revision":"v1"}})).unwrap()).await.unwrap();
    assert!(
        e.mcp_app_open(
            "owner".into(),
            None,
            restricted.id,
            server,
            generation,
            "app".into(),
            Some(json!({})),
            "restricted-entrypoint".into(),
            None,
            None
        )
        .await
        .is_err()
    );
    e.shutdown().await;
}

async fn retry_oauth_fixture(
    axum::extract::State(base): axum::extract::State<String>,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    body: String,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let result = match uri.path() {
        "/.well-known/oauth-protected-resource/mcp" | "/.well-known/oauth-protected-resource" => {
            json!({"resource":format!("{base}/mcp"),"authorization_servers":[base]})
        }
        "/.well-known/oauth-authorization-server" => {
            json!({"issuer":base,"authorization_endpoint":format!("{base}/authorize"),"token_endpoint":format!("{base}/token"),"response_types_supported":["code"],"grant_types_supported":["authorization_code"],"code_challenge_methods_supported":["S256"]})
        }
        "/token" => {
            json!({"access_token":"synthetic-retry-token","token_type":"Bearer","expires_in":3600})
        }
        "/mcp" => {
            if headers.get("authorization").is_none() {
                return (axum::http::StatusCode::UNAUTHORIZED,[("www-authenticate",format!("Bearer resource_metadata=\"{base}/.well-known/oauth-protected-resource/mcp\""))]).into_response();
            }
            assert!(headers["authorization"] == "Bearer synthetic-retry-token");
            let request: serde_json::Value = serde_json::from_str(&body).unwrap();
            let result = match request["method"].as_str().unwrap() {
                "server/discover" => return axum::Json(json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32601,"message":"Method not found"}})).into_response(),
                "initialize" => {
                    json!({"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"authorized","version":"1"}})
                }
                "tools/list" => {
                    json!({"tools":[{"name":"authorized","inputSchema":{"type":"object"}}]})
                }
                _ => return axum::http::StatusCode::ACCEPTED.into_response(),
            };
            json!({"jsonrpc":"2.0","id":request["id"],"result":result})
        }
        _ => return axum::http::StatusCode::NOT_FOUND.into_response(),
    };
    axum::Json(result).into_response()
}
#[tokio::test]
async fn explicit_retry_after_optional_oauth_keeps_old_app_owner() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let router = axum::Router::new()
        .fallback(retry_oauth_fixture)
        .with_state(base);
    let address = listener.local_addr().unwrap();
    let http = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let workspace = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    write(
        workspace.path(),
        ".agents/plugins/marketplace.json",
        r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
    );
    write(
        workspace.path(),
        "pkg/.codex-plugin/plugin.json",
        r#"{"name":"sample"}"#,
    );
    write(
        workspace.path(),
        "pkg/server.py",
        include_str!("../../mcp/tests/substrate.py"),
    );
    write(workspace.path(),"pkg/.mcp.json",&json!({"mcpServers":{"healthy":{"command":"python3","args":["server.py"]},"optional":{"url":format!("http://{address}/mcp"),"oauth":{"clientId":"fixture"}}}}).to_string());
    let e = Engine::open(data.path(), Arc::new(ModelFixture), Limits::default()).unwrap();
    let store = Arc::new(
        Store::open(
            workspace.path().join("plugins"),
            workspace.path().into(),
            None,
        )
        .unwrap(),
    );
    e.install_plugin_store(store.clone()).unwrap();
    let d = store.read("sample@local").unwrap();
    e.plugin_install(
        d.id.clone(),
        "user".into(),
        d.revision,
        d.source,
        d.source_digest,
    )
    .await
    .unwrap();
    let d = store.read(&d.id).unwrap();
    let digest = d.installed_digest.unwrap();
    let partial = e
        .plugin_connection(d.id.clone(), digest.clone(), true)
        .await
        .unwrap();
    assert_eq!(partial["data"][0]["state"], "partial");
    let auth_server = partial["data"][0]["servers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["state"] == "authRequired")
        .unwrap()["serverId"]
        .as_str()
        .unwrap()
        .to_owned();
    let apps = e.mcp_apps_list(None).await.unwrap();
    let server = apps["data"][0]["serverId"].as_str().unwrap().to_owned();
    let generation = apps["data"][0]["generation"].as_u64().unwrap();
    let thread = e
        .create(workspace.path().to_str().unwrap().into())
        .await
        .unwrap();
    let app = e
        .mcp_app_open(
            "owner".into(),
            None,
            thread.id.clone(),
            server,
            generation,
            "app".into(),
            None,
            "retained".into(),
            None,
            None,
        )
        .await
        .unwrap();
    let pending = e
        .plugin_auth(d.id.clone(), auth_server.clone(), "start".into())
        .await
        .unwrap();
    let url = reqwest::Url::parse(
        pending["authorizationUrl"]
            .as_str()
            .expect("OAuth pending URL"),
    )
    .unwrap();
    let query: std::collections::BTreeMap<_, _> = url.query_pairs().into_owned().collect();
    let mut callback = reqwest::Url::parse(&query["redirect_uri"]).unwrap();
    callback
        .query_pairs_mut()
        .append_pair("code", "fixture-code")
        .append_pair("state", &query["state"]);
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(callback)
        .send()
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while e
            .plugin_auth(d.id.clone(), auth_server.clone(), "status".into())
            .await
            .unwrap()["status"]
            != "ready"
        {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let complete = e
        .plugin_connection(d.id.clone(), digest.clone(), true)
        .await
        .unwrap();
    assert_eq!(complete["data"][0]["state"], "connected");
    assert_eq!(
        e.mcp_apps_list(None).await.unwrap()["data"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let before = e.mcp_apps_list(None).await.unwrap();
    e.plugin_connection(d.id.clone(), digest, true)
        .await
        .unwrap();
    let after = e.mcp_apps_list(None).await.unwrap();
    assert!(
        after["data"]
            .as_array()
            .unwrap()
            .iter()
            .all(|server| before["data"]
                .as_array()
                .unwrap()
                .iter()
                .all(|old| old["generation"] != server["generation"])),
        "explicit retry must replace even apparently connected handles after reauth"
    );
    let old = e
        .mcp_app_request(
            "owner".into(),
            thread.id,
            app["instanceId"].as_str().unwrap().into(),
            generation,
            json!({"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"ui://app"}}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(old["result"]["contents"][0]["text"], "<p>Hello</p>");
    e.shutdown().await;
    http.abort();
    let _ = http.await;
}

#[tokio::test]
async fn mrtr_app_resource_and_tool_share_authoritative_forms() {
    let root = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    write(
        root.path(),
        ".agents/plugins/marketplace.json",
        r#"{"name":"local","plugins":[{"name":"modern","source":"./pkg"}]}"#,
    );
    write(
        root.path(),
        "pkg/.codex-plugin/plugin.json",
        r#"{"name":"modern"}"#,
    );
    write(
        root.path(),
        "pkg/server.py",
        include_str!("../../mcp/tests/mrtr.py"),
    );
    write(root.path(),"pkg/.mcp.json",&json!({"mcpServers":{"fixture":{"command":"python3","args":["server.py"],"env":{"READ_FORM":"1"}}}}).to_string());
    let e = Engine::open(state.path(), Arc::new(ModelFixture), Limits::default()).unwrap();
    e.set_permissions(
        serde_json::from_value(json!({"mode":"ASK_PERMISSIONS","ask":["mcp__*"]})).unwrap(),
        None,
    )
    .unwrap();
    let store =
        Arc::new(Store::open(root.path().join("plugins"), root.path().into(), None).unwrap());
    e.install_plugin_store(store.clone()).unwrap();
    let d = store.read("modern@local").unwrap();
    e.plugin_install(
        d.id.clone(),
        "user".into(),
        d.revision,
        d.source,
        d.source_digest,
    )
    .await
    .unwrap();
    let d = store.read(&d.id).unwrap();
    e.plugin_connection(d.id.clone(), d.installed_digest.unwrap(), true)
        .await
        .unwrap();
    let apps = e.mcp_apps_list(None).await.unwrap();
    let server = apps["data"][0]["serverId"].as_str().unwrap().to_owned();
    let generation = apps["data"][0]["generation"].as_u64().unwrap();
    let thread = e
        .create(root.path().to_str().unwrap().into())
        .await
        .unwrap();
    let open = {
        let e = e.clone();
        let thread = thread.id.clone();
        let server = server.clone();
        tokio::spawn(async move {
            e.mcp_app_open(
                "owner".into(),
                None,
                thread,
                server,
                generation,
                "app".into(),
                None,
                "modern-open".into(),
                None,
                None,
            )
            .await
        })
    };
    async fn next_form(e: &Arc<Engine>, thread: &str) -> serde_json::Value {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let forms = e.mcp_forms_list(thread.into()).await.unwrap();
                if let Some(f) = forms["data"].as_array().unwrap().first() {
                    return f.clone();
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap()
    }
    for index in 0..2 {
        let form = next_form(&e, &thread.id).await;
        assert_eq!(form["turnId"], "");
        let id = form["requestId"].as_str().unwrap().to_owned();
        assert!(
            e.mcp_form_respond(
                "stranger".into(),
                thread.id.clone(),
                id.clone(),
                json!({"action":"accept","content":{"answer":"yes"}})
            )
            .await
            .is_err()
        );
        assert!(
            e.mcp_form_respond(
                "owner".into(),
                thread.id.clone(),
                id.clone(),
                json!({"action":"accept","content":{"answer":true}})
            )
            .await
            .is_err()
        );
        e.mcp_form_respond(
            "owner".into(),
            thread.id.clone(),
            id,
            json!({"action":"accept","content":{"answer":format!("round{index}")}}),
        )
        .await
        .unwrap();
    }
    let app = open.await.unwrap().unwrap();
    assert_eq!(app["resource"]["html"], "<p>MRTR finished</p>");
    assert!(e.read(&thread.id, true).await.unwrap().turns.is_empty());
    let instance = app["instanceId"].as_str().unwrap().to_owned();
    let request = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"app","arguments":{"mode":"normal"}}});
    let job = {
        let e = e.clone();
        let thread = thread.id.clone();
        let instance = instance.clone();
        let request = request.clone();
        tokio::spawn(async move {
            e.mcp_app_request(
                "owner".into(),
                thread,
                instance,
                generation,
                request,
                Some("mrtr-once".into()),
            )
            .await
        })
    };
    approve(&e, &thread.id).await;
    for _ in 0..2 {
        let form = next_form(&e, &thread.id).await;
        assert_ne!(form["turnId"], "");
        e.mcp_form_respond(
            "owner".into(),
            thread.id.clone(),
            form["requestId"].as_str().unwrap().into(),
            json!({"action":"accept","content":{"answer":"accepted"}}),
        )
        .await
        .unwrap();
    }
    let result = job.await.unwrap().unwrap();
    assert_eq!(result["result"]["_meta"]["preserved"], true);
    let replay = e
        .mcp_app_request(
            "owner".into(),
            thread.id.clone(),
            instance.clone(),
            generation,
            request,
            Some("mrtr-once".into()),
        )
        .await
        .unwrap();
    assert_eq!(replay, result);
    assert_eq!(e.read(&thread.id, true).await.unwrap().turns.len(), 1);
    // Uploaded directory is outside the workspace; only the explicit picker operation can import it.
    let picked = tempfile::tempdir().unwrap();
    let picked_path = picked.path().canonicalize().unwrap();
    std::fs::write(picked_path.join("data.txt"), "snapshot-before").unwrap();
    let upload = {
        let e = e.clone();
        let thread = thread.id.clone();
        let instance = instance.clone();
        tokio::spawn(async move {
            // A steer hook can wait for a file form inside its durable submission.
            // An independent stage must still progress, while duplicates remain single-shot.
            e.management_submission("owner".into(), "waiting-upload".into(), "turn/steer".into(), json!({"mode":"upload"}), move |e| async move {
                e.mcp_app_request("owner".into(),thread,instance,generation,json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"app","arguments":{"mode":"upload"}}}),Some("upload-once".into())).await.unwrap()
            }).await
        })
    };
    approve(&e, &thread.id).await;
    let form = next_form(&e, &thread.id).await;
    let form_id = form["requestId"].as_str().unwrap().to_owned();
    assert!(
        e.mcp_form_resource_prepare(
            "stranger".into(),
            thread.id.clone(),
            form_id.clone(),
            "selected".into()
        )
        .await
        .is_err()
    );
    let prepared = e
        .mcp_form_resource_prepare(
            "owner".into(),
            thread.id.clone(),
            form_id.clone(),
            "selected".into(),
        )
        .await
        .unwrap();
    let token = prepared["selectionToken"].as_str().unwrap().to_owned();
    assert_eq!(prepared["multiple"], false);
    assert!(
        e.mcp_form_resource_stage("stranger".into(), token.clone(), vec![picked_path.clone()])
            .await
            .is_err()
    );
    let paths = vec![picked_path.clone()];
    let parameters = json!({"selectionToken":token,"paths":paths});
    let stage_id = uuid::Uuid::new_v4().to_string();
    let staged = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        e.management_submission(
            "owner".into(),
            stage_id.clone(),
            "areal/mcp/form/resource/stage".into(),
            parameters.clone(),
            {
                let token = token.clone();
                let paths = paths.clone();
                move |e| async move {
                    e.mcp_form_resource_stage("owner".into(), token, paths)
                        .await
                        .unwrap()
                }
            },
        ),
    )
    .await
    .expect("stage must progress while another submission waits for this upload form")
    .unwrap();
    assert_eq!(staged["summary"]["fileCount"], 1);
    assert_eq!(staged["summary"]["totalBytes"], 15);
    let uri = staged["resources"][0]["uri"].as_str().unwrap().to_owned();
    assert!(uri.starts_with("areal-mcp-resource://"));
    assert!(!staged.to_string().contains(picked_path.to_str().unwrap()));
    std::fs::write(picked_path.join("data.txt"), "changed-after-stage").unwrap();
    let repeated = e
        .management_submission(
            "owner".into(),
            stage_id,
            "areal/mcp/form/resource/stage".into(),
            parameters,
            |_| async { panic!("duplicate stage must not run") },
        )
        .await
        .unwrap();
    assert_eq!(repeated, staged);
    assert!(
        e.mcp_form_respond(
            "owner".into(),
            thread.id.clone(),
            form_id.clone(),
            json!({"action":"accept","content":{"selected":"file:///ungranted"}})
        )
        .await
        .is_err()
    );
    e.mcp_form_respond(
        "owner".into(),
        thread.id.clone(),
        form_id,
        json!({"action":"accept","content":{"selected":uri}}),
    )
    .await
    .unwrap();
    let result = upload.await.unwrap().unwrap();
    let receipt: serde_json::Value =
        serde_json::from_str(result["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(receipt["snapshot"], "snapshot-before");
    assert_eq!(
        std::fs::read_to_string(picked_path.join("data.txt")).unwrap(),
        "changed-after-stage"
    );
    let snapshot = reqwest::Url::parse(receipt["fileUri"].as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while snapshot.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        e.mcp_form_resource_stage("owner".into(), token, paths)
            .await
            .is_err()
    );
    let read = {
        let e = e.clone();
        let thread = thread.id.clone();
        let instance = instance.clone();
        tokio::spawn(async move {
            e.mcp_app_request("owner".into(),thread,instance,generation,json!({"jsonrpc":"2.0","id":2,"method":"resources/read","params":{"uri":"ui://app"}}),None).await
        })
    };
    let form = next_form(&e, &thread.id).await;
    e.mcp_app_close("owner".into(), thread.id.clone(), instance, generation)
        .await
        .unwrap();
    assert!(
        e.mcp_form_respond(
            "owner".into(),
            thread.id.clone(),
            form["requestId"].as_str().unwrap().into(),
            json!({"action":"cancel"})
        )
        .await
        .is_err()
    );
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(3), read)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    e.shutdown().await;
}

// Planned failure: the transport challenge's scope is lost between failed discovery
// and explicit Core authentication; auth must not replay the rejected startup POST.
async fn scoped_challenge_fixture(
    axum::extract::State((base, attempts)): axum::extract::State<(
        String,
        Arc<std::sync::atomic::AtomicUsize>,
    )>,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    body: String,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    if uri.path() == "/mcp" && headers.get("authorization").is_none() {
        let n = attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let scope = if n == 0 {
            "protected.read"
        } else {
            "unexpected.probe"
        };
        return (axum::http::StatusCode::UNAUTHORIZED,[("www-authenticate",format!("Bearer resource_metadata=\"{base}/.well-known/oauth-protected-resource/mcp\", scope=\"{scope}\""))]).into_response();
    }
    if uri
        .path()
        .starts_with("/.well-known/oauth-protected-resource")
    {
        return axum::Json(json!({"resource":format!("{base}/mcp"),"authorization_servers":[base],"scopes_supported":["default.read"]})).into_response();
    }
    retry_oauth_fixture(axum::extract::State(base), uri, headers, body).await
}
#[tokio::test]
async fn explicit_auth_uses_private_startup_challenge_without_replay() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let router = axum::Router::new()
        .fallback(scoped_challenge_fixture)
        .with_state((base.clone(), attempts.clone()));
    let http = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let workspace = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    write(
        workspace.path(),
        ".agents/plugins/marketplace.json",
        r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
    );
    write(
        workspace.path(),
        "pkg/plugin.json",
        r#"{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"sample","version":"1.0.0"}"#,
    );
    write(workspace.path(),"pkg/mcp.json",&json!({"$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json","mcpServers":{"scoped":{"type":"streamable-http","url":format!("{base}/mcp"),"extensions":{"com.openai":{"auth":{"type":"mixed","client":{"mode":"provided","clientId":"fixture"}}}}}}}).to_string());
    let e = Engine::open(data.path(), Arc::new(ModelFixture), Limits::default()).unwrap();
    let store = Arc::new(
        Store::open(
            workspace.path().join("plugins"),
            workspace.path().into(),
            None,
        )
        .unwrap(),
    );
    e.install_plugin_store(store.clone()).unwrap();
    let d = store.read("sample@local").unwrap();
    e.plugin_install(
        d.id.clone(),
        "user".into(),
        d.revision,
        d.source,
        d.source_digest,
    )
    .await
    .unwrap();
    let d = store.read(&d.id).unwrap();
    let digest = d.installed_digest.unwrap();
    let failed = e
        .plugin_connection(d.id.clone(), digest.clone(), true)
        .await
        .unwrap();
    let server = failed["data"][0]["servers"][0]["serverId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(failed["data"][0]["servers"][0]["state"], "authRequired");
    assert!(!failed.to_string().contains("protected.read"));
    let pending = e
        .plugin_auth(d.id.clone(), server.clone(), "start".into())
        .await
        .unwrap();
    let url = reqwest::Url::parse(pending["authorizationUrl"].as_str().unwrap()).unwrap();
    let query: std::collections::BTreeMap<_, _> = url.query_pairs().into_owned().collect();
    let scopes: std::collections::BTreeSet<_> = query["scope"].split_whitespace().collect();
    assert_eq!(
        scopes,
        std::collections::BTreeSet::from(["default.read", "protected.read"])
    );
    assert_eq!(
        attempts.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "explicit authentication never replays discovery"
    );
    let mut callback = reqwest::Url::parse(&query["redirect_uri"]).unwrap();
    callback
        .query_pairs_mut()
        .append_pair("code", "fixture-code")
        .append_pair("state", &query["state"]);
    assert!(
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(callback)
            .send()
            .await
            .unwrap()
            .status()
            .is_success()
    );
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while e
            .plugin_auth(d.id.clone(), server.clone(), "status".into())
            .await
            .unwrap()["status"]
            != "ready"
        {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let ready = e.plugin_connection(d.id, digest, true).await.unwrap();
    assert_eq!(ready["data"][0]["state"], "connected");
    assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
    e.shutdown().await;
    http.abort();
}

// Planned policy failures: ON_INSTALL mixed accidentally calls anonymously;
// listing/installation starts OAuth; ON_USE is prematurely blocked as installed.
#[tokio::test]
async fn marketplace_authentication_timing_gates_only_declared_servers() {
    for (timing, expected) in [("ON_INSTALL", "authRequired"), ("ON_USE", "disconnected")] {
        let workspace = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        write(workspace.path(),".agents/plugins/marketplace.json",&json!({"name":"local","plugins":[{"name":"sample","source":"./pkg","policy":{"installation":"AVAILABLE","authentication":timing}}]}).to_string());
        write(
            workspace.path(),
            "pkg/plugin.json",
            r#"{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"sample","version":"1.0.0"}"#,
        );
        write(workspace.path(),"pkg/mcp.json",&json!({"$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json","mcpServers":{"authenticated":{"type":"streamable-http","url":"http://127.0.0.1:1/mcp","extensions":{"com.openai":{"auth":{"type":"mixed","client":{"mode":"provided","clientId":"fixture"}}}}},"anonymous":{"type":"streamable-http","url":"http://127.0.0.1:1/other"}}}).to_string());
        let e = Engine::open(data.path(), Arc::new(ModelFixture), Limits::default()).unwrap();
        let store = Arc::new(
            Store::open(
                workspace.path().join("plugins"),
                workspace.path().into(),
                None,
            )
            .unwrap(),
        );
        e.install_plugin_store(store.clone()).unwrap();
        let d = store.read("sample@local").unwrap();
        let review_digest = d.review_digest().to_owned();
        e.plugin_install(
            d.id.clone(),
            "user".into(),
            d.revision,
            d.source,
            review_digest,
        )
        .await
        .unwrap();
        let listed = e.plugin_mcp_list().await.unwrap();
        let row = &listed["data"][0];
        assert_eq!(row["state"], expected);
        let servers = row["servers"].as_array().unwrap();
        let authenticated = servers
            .iter()
            .find(|s| s["authentication"] != "none")
            .unwrap();
        let anonymous = servers
            .iter()
            .find(|s| s["authentication"] == "none")
            .unwrap();
        assert_eq!(authenticated["state"], expected);
        assert_eq!(anonymous["state"], "disconnected");
        assert!(
            e.plugin_auth(
                d.id,
                authenticated["serverId"].as_str().unwrap().into(),
                "status".into()
            )
            .await
            .unwrap()
            .is_null(),
            "installation/listing must never initiate OAuth"
        );
        e.shutdown().await;
    }
}

// Failure contract: independent human waits must not consume unreserved journal
// response capacity; committed effects survive restart without duplicate execution.
#[tokio::test]
async fn parallel_submission_responses_remain_restartable() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let state = tempfile::tempdir().unwrap();
    fs::create_dir_all(state.path().join("desktop")).unwrap();
    let mut seed = serde_json::Map::new();
    for i in 0..30 {
        seed.insert(format!("seed-{i}"), json!({"identity":"owner","requestId":format!("old-{i}"),"method":"seed","digest":"old","state":"completed","response":{"payload":"s".repeat(250*1024)}}));
    }
    let path = state.path().join("desktop/submissions.json");
    fs::write(&path, serde_json::to_vec(&seed).unwrap()).unwrap();
    let engine = Engine::open(state.path(), Arc::new(ModelFixture), Limits::default()).unwrap();
    let release = Arc::new(tokio::sync::Notify::new());
    let effects = Arc::new(AtomicUsize::new(0));
    let mut jobs = vec![];
    for i in 0..3 {
        let engine = engine.clone();
        let release = release.clone();
        let effects = effects.clone();
        jobs.push(tokio::spawn(async move {
            engine
                .management_submission(
                    "owner".into(),
                    format!("new-{i}"),
                    "upload".into(),
                    json!({"index":i}),
                    move |_| async move {
                        let wait = release.notified();
                        tokio::pin!(wait);
                        wait.as_mut().enable();
                        effects.fetch_add(1, Ordering::SeqCst);
                        wait.await;
                        json!({"payload":"x".repeat(250*1024)})
                    },
                )
                .await
        }));
    }
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        let mut accounted = 0;
        for (i, job) in jobs.iter().enumerate().take(3) {
            let receipts = engine
                .management_receipts("owner", &format!("new-{i}"))
                .await;
            if job.is_finished()
                || receipts["data"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["state"] == "accepted")
            {
                accounted += 1;
            }
        }
        if accounted == 3 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "submission admission did not settle"
        );
        tokio::task::yield_now().await;
    }
    release.notify_waiters();
    let mut completed = vec![];
    for (i, job) in jobs.into_iter().enumerate() {
        if let Ok(response) = job.await.unwrap() {
            completed.push((i, response));
        }
        assert!(
            fs::metadata(&path).unwrap().len() <= 8 * 1024 * 1024,
            "parallel responses exceeded restart journal budget"
        );
    }
    assert!(!completed.is_empty());
    assert_eq!(effects.load(Ordering::SeqCst), completed.len());
    engine.shutdown().await;
    drop(engine);
    let restarted = Engine::open(state.path(), Arc::new(ModelFixture), Limits::default()).unwrap();
    for (i, response) in completed {
        assert_eq!(
            restarted
                .management_submission(
                    "owner".into(),
                    format!("new-{i}"),
                    "upload".into(),
                    json!({"index":i}),
                    |_| async { panic!("committed effect must not replay after restart") }
                )
                .await
                .unwrap(),
            response
        );
    }
    restarted.shutdown().await;
}

struct SavedResultModel {
    round: std::sync::atomic::AtomicUsize,
    requests: std::sync::Mutex<Vec<serde_json::Value>>,
}
#[async_trait]
impl Model for SavedResultModel {
    fn name(&self) -> &str {
        "saved-result-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(
        &self,
        messages: Vec<Message>,
        tools: Vec<serde_json::Value>,
    ) -> anyhow::Result<ModelStream> {
        self.requests
            .lock()
            .unwrap()
            .push(json!(format!("{messages:?}")));
        let round = self.round.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let event = if round.is_multiple_of(2) {
            let name = tools
                .iter()
                .find_map(|tool| {
                    tool["function"]["name"]
                        .as_str()
                        .filter(|name| name.ends_with("__app"))
                })
                .unwrap();
            ModelEvent::ToolCall(areal_engine::model::ToolCall {
                id: "repeated-upstream-id".into(),
                name: name.into(),
                arguments: json!({"value":round / 2 + 1}).to_string(),
            })
        } else {
            ModelEvent::text("saved result complete")
        };
        Ok(Box::pin(futures_util::stream::iter([Ok(event)])))
    }
}
struct SavedResultFixture {
    workspace: tempfile::TempDir,
    state: tempfile::TempDir,
    engine: Arc<Engine>,
    store: Arc<Store>,
    model: Arc<SavedResultModel>,
    thread: String,
}
impl SavedResultFixture {
    async fn new(mode: &str) -> Self {
        let workspace = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        write(
            workspace.path(),
            ".agents/plugins/marketplace.json",
            r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
        );
        write(
            workspace.path(),
            "pkg/.codex-plugin/plugin.json",
            r#"{"name":"sample"}"#,
        );
        let server = include_str!("../../mcp/tests/substrate.py")
            .replace("\"visibility\":[\"app\"]", "\"visibility\":[\"model\"]")
            .replace("r=json.loads(line);m=r.get(\"method\");p=r.get(\"params\",{});out=None", "r=json.loads(line);m=r.get(\"method\");p=r.get(\"params\",{});out=None\n if m==\"tools/call\":\n  with open(os.environ[\"COUNTER\"],\"a\") as f:f.write(json.dumps(p)+\"\\n\")\n if m==\"resources/read\":\n  with open(os.environ[\"READS\"],\"a\") as f:f.write(\"read\\n\")")
            .replace("\"_meta\":{\"secret\":\"retained\"},\"structuredContent\":{\"v\":1}", "\"_meta\":{\"secret\":\"SAVED_RESULT_PRIVATE\"},\"structuredContent\":{\"v\":p.get(\"arguments\",{}).get(\"value\"),\"_meta\":{\"private\":\"NESTED_PRIVATE\"}},\"isError\":os.environ.get(\"RESULT_MODE\")==\"failed\"");
        let server = server.replace("\"text\":\"<p>Hello</p>\"", "\"text\":(\"<p>\"+(\"x\"*(1900*1024) if os.environ.get(\"RESULT_MODE\")==\"capacity\" else \"Hello\")+\"</p>\")");
        write(workspace.path(), "pkg/server.py", &server);
        write(workspace.path(), "pkg/.mcp.json", &json!({"mcpServers":{"fixture":{"command":"python3","args":["server.py"],"env":{"COUNTER":workspace.path().join("business.jsonl"),"READS":workspace.path().join("reads.txt"),"RESULT_MODE":mode,"LITERAL":"ordinary result remains readable"}}}}).to_string());
        let model = Arc::new(SavedResultModel {
            round: Default::default(),
            requests: Default::default(),
        });
        let engine = Engine::open(state.path(), model.clone(), Limits::default()).unwrap();
        let store = Arc::new(
            Store::open(
                workspace.path().join("plugins"),
                workspace.path().into(),
                None,
            )
            .unwrap(),
        );
        engine.install_plugin_store(store.clone()).unwrap();
        let package = store.read("sample@local").unwrap();
        engine
            .plugin_install(
                package.id.clone(),
                "user".into(),
                package.revision,
                package.source,
                package.source_digest,
            )
            .await
            .unwrap();
        let package = store.read(&package.id).unwrap();
        engine
            .plugin_connection(package.id, package.installed_digest.unwrap(), true)
            .await
            .unwrap();
        let thread = engine
            .create(workspace.path().to_str().unwrap().into())
            .await
            .unwrap()
            .id;
        Self {
            workspace,
            state,
            engine,
            store,
            model,
            thread,
        }
    }
    async fn result(&self) -> areal_protocol::plugin_runtime::OpenFromResult {
        self.engine
            .start(
                &self.thread,
                vec![areal_protocol::Input::text(
                    "call the app business tool once",
                )],
            )
            .await
            .unwrap();
        let thread = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            self.engine.wait(&self.thread),
        )
        .await
        .unwrap()
        .unwrap();
        let turn = thread.turns.last().unwrap();
        let item = turn
            .items
            .iter()
            .find_map(|item| match item {
                areal_protocol::Item::DynamicToolCall { id, call_id, .. }
                    if call_id == "repeated-upstream-id" =>
                {
                    Some(id.clone())
                }
                _ => None,
            })
            .unwrap();
        let epoch = self.engine.mcp_apps_list(None).await.unwrap()["requestEpoch"]
            .as_str()
            .unwrap()
            .to_owned();
        areal_protocol::plugin_runtime::OpenFromResult {
            thread_id: self.thread.clone(),
            turn_id: turn.id.clone(),
            item_id: item,
            request_id: format!("result-v1.{epoch}.{}", uuid::Uuid::new_v4()),
        }
    }
    fn count(&self) -> usize {
        fs::read_to_string(self.workspace.path().join("business.jsonl"))
            .unwrap()
            .lines()
            .count()
    }
    async fn open(
        &self,
        input: &areal_protocol::plugin_runtime::OpenFromResult,
    ) -> serde_json::Value {
        self.engine
            .mcp_app_open_from_result("owner".into(), None, input.clone())
            .await
            .unwrap()
    }
    async fn close(&self, reply: &serde_json::Value) {
        self.engine
            .mcp_app_close(
                "owner".into(),
                self.thread.clone(),
                reply["instance"]["instanceId"].as_str().unwrap().into(),
                reply["instance"]["generation"].as_u64().unwrap(),
            )
            .await
            .unwrap();
    }
    fn fresh(
        &self,
        input: &areal_protocol::plugin_runtime::OpenFromResult,
    ) -> areal_protocol::plugin_runtime::OpenFromResult {
        let mut input = input.clone();
        input.request_id = format!(
            "{}.{}",
            input.request_id.rsplit_once('.').unwrap().0,
            uuid::Uuid::new_v4()
        );
        input
    }
}

#[tokio::test]
async fn saved_result_exact_identity_reuses_without_business_replay() {
    let fixture = SavedResultFixture::new("success").await;
    let first = fixture.result().await;
    let second = fixture.result().await;
    assert_eq!(fixture.count(), 2);
    assert_ne!(first.turn_id, second.turn_id);
    assert_ne!(first.item_id, second.item_id);
    assert!(
        !fixture.state.path().join("desktop/mcp-apps.json").exists(),
        "reading historical tools must not mount an App"
    );
    let opened = fixture.open(&second).await;
    assert_eq!(opened["status"], "open");
    assert_eq!(opened["instance"]["initialArguments"], json!({"value":2}));
    assert_eq!(
        opened["instance"]["initialResult"]["structuredContent"]["v"],
        2
    );
    assert_eq!(
        opened["instance"]["initialResult"]["_meta"]["secret"],
        "SAVED_RESULT_PRIVATE"
    );
    let alias = fixture.fresh(&second);
    let (a, b, c) = tokio::join!(
        fixture.open(&second),
        fixture.open(&alias),
        fixture.open(&second)
    );
    assert_eq!(a, opened);
    assert_eq!(b, opened);
    assert_eq!(c, opened);
    assert_eq!(
        fs::read_to_string(fixture.workspace.path().join("reads.txt")).unwrap(),
        "read\n"
    );
    let mut conflicting = second.clone();
    conflicting.item_id = first.item_id.clone();
    assert!(
        fixture
            .engine
            .mcp_app_open_from_result("owner".into(), None, conflicting)
            .await
            .is_err()
    );
    let mut other_thread = second.clone();
    other_thread.thread_id = fixture
        .engine
        .create(fixture.workspace.path().to_str().unwrap().into())
        .await
        .unwrap()
        .id;
    assert!(
        fixture
            .engine
            .mcp_app_open_from_result("owner".into(), None, other_thread)
            .await
            .is_err(),
        "one result requestId cannot change its source Thread"
    );
    let mut wrong_turn = fixture.fresh(&first);
    wrong_turn.turn_id = second.turn_id.clone();
    assert_eq!(fixture.open(&wrong_turn).await["status"], "unavailable");
    let fork = fixture.engine.fork_thread("owner".into(), serde_json::from_value(json!({"requestId":"saved-result-fork","sourceThreadId":fixture.thread,"anchor":{"turnId":second.turn_id,"boundary":"after"},"workspaceMode":"sharedCurrent"})).unwrap()).await.unwrap();
    let mut inherited = fixture.fresh(&second);
    inherited.thread_id = fork.id;
    assert_eq!(
        fixture.open(&inherited).await["status"],
        "unavailable",
        "inherited history cannot claim the original source"
    );
    let page_call = fixture.engine.mcp_app_request("owner".into(), fixture.thread.clone(), opened["instance"]["instanceId"].as_str().unwrap().into(), opened["instance"]["generation"].as_u64().unwrap(), json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"app","arguments":{}}}), Some("page-may-not-call-model-only-tool".into())).await;
    assert!(page_call.is_err());
    fixture.close(&opened).await;
    assert_eq!(fixture.open(&second).await, json!({"status":"closed"}));
    assert_eq!(fixture.open(&alias).await, json!({"status":"closed"}));
    let reopened = fixture.open(&fixture.fresh(&second)).await;
    assert_eq!(reopened["status"], "open");
    assert_ne!(
        reopened["instance"]["instanceId"],
        opened["instance"]["instanceId"]
    );
    assert_eq!(fixture.count(), 2);
    assert_eq!(
        fixture
            .engine
            .read(&fixture.thread, true)
            .await
            .unwrap()
            .turns
            .len(),
        2,
        "mount creates no extra business Turn"
    );
    let model_text = serde_json::to_string(&*fixture.model.requests.lock().unwrap()).unwrap();
    assert!(!model_text.contains("SAVED_RESULT_PRIVATE"));
    assert!(!model_text.contains("NESTED_PRIVATE"));
    fixture.engine.shutdown().await;
}

#[tokio::test]
async fn saved_result_concurrent_admission_and_full_receipts_preserve_closed_facts() {
    let fixture = SavedResultFixture::new("success").await;
    let input = fixture.result().await;
    let alias = fixture.fresh(&input);
    let (first, second) = tokio::join!(fixture.open(&input), fixture.open(&alias));
    assert_eq!(first, second);
    assert_eq!(
        fs::read_to_string(fixture.workspace.path().join("reads.txt")).unwrap(),
        "read\n"
    );
    for _ in 2..1024 {
        assert_eq!(fixture.open(&fixture.fresh(&input)).await, first);
    }
    assert_eq!(
        fixture.open(&fixture.fresh(&input)).await,
        json!({"status":"unavailable","reason":"capacityReached"})
    );
    assert_eq!(fixture.open(&input).await, first);
    fixture.close(&first).await;
    fixture.close(&first).await;
    assert_eq!(fixture.open(&input).await, json!({"status":"closed"}));
    assert_eq!(fixture.open(&alias).await, json!({"status":"closed"}));
    let store: serde_json::Value = serde_json::from_slice(
        &fs::read(fixture.state.path().join("desktop/mcp-apps.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(store["version"], 2);
    assert_eq!(store["resultOperations"].as_object().unwrap().len(), 1024);
    assert_eq!(store["instances"], json!({}));
    assert!(
        store["resultOperations"]
            .as_object()
            .unwrap()
            .values()
            .all(|entry| serde_json::to_vec(entry).unwrap().len() <= 1024)
    );
    assert_eq!(fixture.count(), 1);
    fixture.engine.shutdown().await;

    let large = SavedResultFixture::new("capacity").await;
    let mut live = Vec::new();
    for _ in 0..4 {
        let input = large.result().await;
        let reply = large.open(&input).await;
        assert_eq!(reply["status"], "open");
        assert!(
            reply["instance"]["resource"]["html"]
                .as_str()
                .unwrap()
                .len()
                < 2 * 1024 * 1024
        );
        live.push((input, reply));
    }
    let refused = large.result().await;
    assert_eq!(
        large.open(&refused).await,
        json!({"status":"unavailable","reason":"capacityReached"})
    );
    assert!(
        fs::metadata(large.state.path().join("desktop/mcp-apps.json"))
            .unwrap()
            .len()
            <= 8 * 1024 * 1024
    );
    assert_eq!(large.open(&live[0].0).await, live[0].1);
    large.close(&live[0].1).await;
    large.close(&live[0].1).await;
    assert_eq!(large.open(&live[0].0).await, json!({"status":"closed"}));
    assert_eq!(
        large.open(&refused).await,
        json!({"status":"unavailable","reason":"capacityReached"})
    );
    assert_eq!(large.open(&large.fresh(&refused)).await["status"], "open");
    assert_eq!(
        large.count(),
        5,
        "capacity retry and close never replay business calls"
    );
    large.engine.shutdown().await;
}

#[tokio::test]
async fn saved_result_failed_corrupt_disabled_updated_and_restarted_sources_are_unavailable() {
    let failed = SavedResultFixture::new("failed").await;
    let input = failed.result().await;
    assert_eq!(
        failed.open(&input).await,
        json!({"status":"unavailable","reason":"notSuccessful"})
    );
    assert_eq!(failed.count(), 1);
    failed.engine.shutdown().await;

    let fixture = SavedResultFixture::new("success").await;
    let input = fixture.result().await;
    let thread = fixture.engine.read(&fixture.thread, true).await.unwrap();
    let snapshot = thread
        .turns
        .iter()
        .flat_map(|turn| &turn.items)
        .find_map(|item| match item {
            areal_protocol::Item::DynamicToolCall { id, execution, .. } if id == &input.item_id => {
                execution.result_snapshot.clone()
            }
            _ => None,
        })
        .unwrap();
    let digest = snapshot.uri.strip_prefix("areal://blob/").unwrap();
    let path = fixture.state.path().join("blobs").join(digest);
    let original = fs::read(&path).unwrap();
    fs::write(&path, b"corrupt").unwrap();
    assert_eq!(
        fixture.open(&input).await,
        json!({"status":"unavailable","reason":"corruptSnapshot"})
    );
    fs::write(&path, original).unwrap();
    let package = fixture.store.read("sample@local").unwrap();
    fixture
        .engine
        .plugin_configure(package.id.clone(), "user".into(), false, package.revision)
        .await
        .unwrap();
    assert_eq!(
        fixture.open(&fixture.fresh(&input)).await["status"],
        "unavailable"
    );
    let package = fixture.store.read("sample@local").unwrap();
    fixture
        .engine
        .plugin_uninstall(package.id, package.revision)
        .await
        .unwrap();
    assert_eq!(
        fixture.open(&fixture.fresh(&input)).await["status"],
        "unavailable"
    );
    assert_eq!(fixture.count(), 1);
    fixture.engine.shutdown().await;

    let fixture = SavedResultFixture::new("success").await;
    let input = fixture.result().await;
    let package = fixture.store.read("sample@local").unwrap();
    write(
        fixture.workspace.path(),
        "pkg/upgrade.txt",
        "digest changed",
    );
    let next = fixture.store.read(&package.id).unwrap();
    fixture
        .engine
        .plugin_install(
            next.id.clone(),
            "user".into(),
            next.revision,
            next.source,
            next.source_digest,
        )
        .await
        .unwrap();
    assert_eq!(fixture.open(&input).await["status"], "unavailable");
    assert_eq!(fixture.count(), 1);
    fixture.engine.shutdown().await;

    let fixture = SavedResultFixture::new("success").await;
    let input = fixture.result().await;
    let opened = fixture.open(&input).await;
    fixture.close(&opened).await;
    fixture.engine.shutdown().await;
    drop(fixture.engine);
    let next = Engine::open(
        fixture.state.path(),
        Arc::new(ModelFixture),
        Limits::default(),
    )
    .unwrap();
    assert_eq!(
        next.mcp_app_open_from_result("owner".into(), None, input.clone())
            .await
            .unwrap(),
        json!({"status":"unavailable","reason":"staleSourceEpoch"})
    );
    let mut changed_source = input;
    changed_source.thread_id = next
        .create(fixture.workspace.path().to_str().unwrap().into())
        .await
        .unwrap()
        .id;
    assert_eq!(
        next.mcp_app_open_from_result("owner".into(), None, changed_source)
            .await
            .unwrap(),
        json!({"status":"unavailable","reason":"staleSourceEpoch"})
    );
    assert_eq!(
        fs::read_to_string(fixture.workspace.path().join("business.jsonl"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    next.shutdown().await;
}

#[tokio::test]
async fn saved_result_old_snapshot_and_recovered_non_success_remain_readable() {
    use sha2::{Digest, Sha256};
    let fixture = SavedResultFixture::new("success").await;
    let original_input = fixture.result().await;
    let thread = fixture.engine.read(&fixture.thread, true).await.unwrap();
    let snapshot = thread
        .turns
        .iter()
        .flat_map(|turn| &turn.items)
        .find_map(|item| match item {
            areal_protocol::Item::DynamicToolCall { execution, .. } => {
                execution.result_snapshot.clone()
            }
            _ => None,
        })
        .unwrap();
    fixture.engine.shutdown().await;
    drop(fixture.engine);
    let thread_path = fixture
        .state
        .path()
        .join(format!("{}.json", fixture.thread));
    let original: serde_json::Value =
        serde_json::from_slice(&fs::read(&thread_path).unwrap()).unwrap();
    for (outcome, backend) in [
        ("failed", "mcp"),
        ("cancelled", "mcp"),
        ("unknown", "mcp"),
        ("succeeded", "runtime"),
    ] {
        let mut saved = original.clone();
        let item = saved["thread"]["turns"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .flat_map(|turn| turn["items"].as_array_mut().unwrap())
            .find(|item| item["id"] == original_input.item_id)
            .unwrap();
        item["execution"]["outcome"] = json!(outcome);
        item["execution"]["backend"] = json!(backend);
        fs::write(&thread_path, serde_json::to_vec(&saved).unwrap()).unwrap();
        let engine = Engine::open(
            fixture.state.path(),
            Arc::new(ModelFixture),
            Limits::default(),
        )
        .unwrap();
        let epoch = engine.mcp_apps_list(None).await.unwrap()["requestEpoch"]
            .as_str()
            .unwrap()
            .to_owned();
        let mut input = original_input.clone();
        input.request_id = format!("result-v1.{epoch}.{}", uuid::Uuid::new_v4());
        assert_eq!(
            engine
                .mcp_app_open_from_result("owner".into(), None, input)
                .await
                .unwrap(),
            json!({"status":"unavailable","reason":"notSuccessful"})
        );
        assert!(
            serde_json::to_string(&engine.read(&fixture.thread, true).await.unwrap())
                .unwrap()
                .contains("ordinary result remains readable")
        );
        engine.shutdown().await;
    }
    let mut raw: serde_json::Value = serde_json::from_slice(
        &fs::read(
            fixture
                .state
                .path()
                .join("blobs")
                .join(snapshot.uri.strip_prefix("areal://blob/").unwrap()),
        )
        .unwrap(),
    )
    .unwrap();
    raw["mcpServer"].as_object_mut().unwrap().remove("source");
    let bytes = serde_json::to_vec(&raw).unwrap();
    let digest = format!("{:x}", Sha256::digest(&bytes));
    fs::write(fixture.state.path().join("blobs").join(&digest), &bytes).unwrap();
    let mut saved = original;
    let item = saved["thread"]["turns"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .flat_map(|turn| turn["items"].as_array_mut().unwrap())
        .find(|item| item["id"] == original_input.item_id)
        .unwrap();
    item["execution"]["resultSnapshot"]["uri"] = json!(format!("areal://blob/{digest}"));
    item["execution"]["resultSnapshot"]["sizeBytes"] = json!(bytes.len());
    fs::write(&thread_path, serde_json::to_vec(&saved).unwrap()).unwrap();
    let engine = Engine::open(
        fixture.state.path(),
        Arc::new(ModelFixture),
        Limits::default(),
    )
    .unwrap();
    let epoch = engine.mcp_apps_list(None).await.unwrap()["requestEpoch"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut input = original_input;
    input.request_id = format!("result-v1.{epoch}.{}", uuid::Uuid::new_v4());
    assert_eq!(
        engine
            .mcp_app_open_from_result("owner".into(), None, input)
            .await
            .unwrap(),
        json!({"status":"unavailable","reason":"missingProvenance"})
    );
    assert_eq!(
        fs::read_to_string(fixture.workspace.path().join("business.jsonl"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    engine.shutdown().await;
}

struct PageModel {
    selection: bool,
    arguments: serde_json::Value,
}
#[async_trait]
impl Model for PageModel {
    fn name(&self) -> &str {
        "page-tools-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(
        &self,
        messages: Vec<Message>,
        tools: Vec<serde_json::Value>,
    ) -> anyhow::Result<ModelStream> {
        let event = if messages.last().is_some_and(|m| m.role == "tool") {
            ModelEvent::text("page complete")
        } else {
            let tool = tools
                .iter()
                .find(|t| {
                    t["function"]["name"].as_str().is_some_and(|s| {
                        s.ends_with(if self.selection {
                            "_get_selection"
                        } else {
                            "_apply_patch"
                        })
                    })
                })
                .expect("ordinary model inventory must contain the registered page tool");
            ModelEvent::ToolCall(areal_engine::model::ToolCall {
                id: "page-call".into(),
                name: tool["function"]["name"].as_str().unwrap().into(),
                arguments: self.arguments.to_string(),
            })
        };
        Ok(Box::pin(futures_util::stream::iter([Ok(event)])))
    }
}
struct PageHost {
    id: String,
    closed: std::sync::atomic::AtomicBool,
    notices: tokio::sync::mpsc::Sender<areal_protocol::plugin_runtime::PageToolNotice>,
}
#[async_trait]
impl areal_engine::tools::DynamicToolHost for PageHost {
    fn id(&self) -> &str {
        &self.id
    }
    fn identity(&self) -> &str {
        "owner"
    }
    fn is_closed(&self) -> bool {
        self.closed.load(std::sync::atomic::Ordering::SeqCst)
    }
    async fn call(
        &self,
        _: serde_json::Value,
        _: tokio_util::sync::CancellationToken,
    ) -> anyhow::Result<areal_protocol::DynamicToolResponse> {
        anyhow::bail!("page tools must not use generic dynamic requests")
    }
    async fn page_tool_notice(
        &self,
        notice: areal_protocol::plugin_runtime::PageToolNotice,
    ) -> anyhow::Result<()> {
        self.notices.try_send(notice)?;
        Ok(())
    }
}

#[tokio::test]
async fn page_claim_is_single_use_and_terminal_receipt_survives_finalization_and_restart() {
    for mode in [
        "normal",
        "feedback",
        "postFailure",
        "postCancel",
        "pendingCancel",
        "claimedCancel",
        "revoked",
        "hostLost",
    ] {
        page_lifecycle_case(mode).await;
    }
}
#[tokio::test]
async fn page_selection_accepts_final_observable_revision() {
    page_lifecycle_case("selectionRevisionLimit").await;
}

#[tokio::test]
async fn page_conflict_accepts_final_observable_revision() {
    page_lifecycle_case("conflictRevisionLimit").await;
}

#[tokio::test]
async fn page_applied_accepts_final_observable_revision() {
    page_lifecycle_case("appliedRevisionLimit").await;
}

#[tokio::test]
async fn page_applied_rejects_reversed_range() {
    page_lifecycle_case("reversedRange").await;
}

#[tokio::test]
async fn page_applied_rejects_empty_insertion() {
    page_lifecycle_case("emptyInsertion").await;
}

async fn page_lifecycle_case(mode: &str) {
    use areal_protocol::plugin_runtime::*;
    let workspace = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    write(
        workspace.path(),
        ".agents/plugins/marketplace.json",
        r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
    );
    write(
        workspace.path(),
        "pkg/.codex-plugin/plugin.json",
        &json!({"name":"sample","hooks":{"hooks":{"PostToolUse":[{"matcher":"app_.*","hooks":[{"type":"mcp_tool","server":"fixture","tool":"app","input":{}}]}]}}}).to_string(),
    );
    write(
        workspace.path(),
        "pkg/server.py",
        &include_str!("../../mcp/tests/substrate.py").replace("import sys,json,os", "import sys,json,os,time").replace(" elif m==\"tools/call\":out=", " elif m==\"tools/call\" and os.environ.get(\"PAGE_MODE\")==\"postFailure\": os._exit(0)\n elif m==\"tools/call\" and os.environ.get(\"PAGE_MODE\")==\"postCancel\":\n  open(os.environ[\"MARKER\"],\"w\").write(\"entered\");time.sleep(5);out={\"content\":[]}\n elif m==\"tools/call\":out="),
    );
    write(workspace.path(), "pkg/.mcp.json", &json!({"mcpServers":{"fixture":{"command":"python3","args":["server.py"],"env":{"LITERAL":"{\"continue\":false,\"stopReason\":\"page-feedback\"}","PAGE_MODE":mode,"MARKER":workspace.path().join("hook-entered")}}}}).to_string());
    let arguments = match mode {
        "selectionRevisionLimit" => json!({}),
        "conflictRevisionLimit" | "appliedRevisionLimit" => {
            json!({"expectedDocumentRevision":9_007_199_254_740_990_u64,"patch":{"from":0,"to":0,"insert":"x"}})
        }
        "reversedRange" => {
            json!({"expectedDocumentRevision":0,"patch":{"from":2,"to":1,"insert":"x"}})
        }
        "emptyInsertion" => {
            json!({"expectedDocumentRevision":0,"patch":{"from":0,"to":0,"insert":""}})
        }
        _ => json!({"expectedDocumentRevision":0,"patch":{"from":0,"to":0,"insert":"x"}}),
    };
    let engine = Engine::open(
        state.path(),
        Arc::new(PageModel {
            selection: mode == "selectionRevisionLimit",
            arguments,
        }),
        Limits::default(),
    )
    .unwrap();
    let store = Arc::new(
        Store::open(
            workspace.path().join("plugins"),
            workspace.path().into(),
            None,
        )
        .unwrap(),
    );
    engine.install_plugin_store(store.clone()).unwrap();
    let package = store.read("sample@local").unwrap();
    engine
        .plugin_install(
            package.id.clone(),
            "user".into(),
            package.revision,
            package.source,
            package.source_digest,
        )
        .await
        .unwrap();
    let package = store.read(&package.id).unwrap();
    engine
        .plugin_connection(package.id, package.installed_digest.unwrap(), true)
        .await
        .unwrap();
    if matches!(mode, "feedback" | "postFailure" | "postCancel") {
        let hook = engine.plugin_hooks_list().await.unwrap()["data"][0].clone();
        engine.plugin_hooks_configure(serde_json::from_value(json!({"requestId":"trust-page-fixture","id":"sample@local","expectedDigest":hook["installedDigest"],"definitionDigest":hook["definitionDigest"],"enabled":true,"trusted":true})).unwrap()).await.unwrap();
    }
    engine
        .set_permissions(
            serde_json::from_value(json!({"mode":"YOLO"})).unwrap(),
            None,
        )
        .unwrap();
    let thread = engine
        .create(workspace.path().to_str().unwrap().into())
        .await
        .unwrap()
        .id;
    let apps = engine.mcp_apps_list(None).await.unwrap();
    let server = apps["data"][0]["serverId"].as_str().unwrap().to_owned();
    let generation = apps["data"][0]["generation"].as_u64().unwrap();
    let (tx, mut notices) = tokio::sync::mpsc::channel(8);
    let host = Arc::new(PageHost {
        id: "original-host".into(),
        closed: Default::default(),
        notices: tx.clone(),
    });
    let other = Arc::new(PageHost {
        id: "sibling-host".into(),
        closed: Default::default(),
        notices: tx,
    });
    let app = engine
        .mcp_app_open(
            "owner".into(),
            Some(host.clone()),
            thread.clone(),
            server.clone(),
            generation,
            "app".into(),
            None,
            "open-page".into(),
            None,
            None,
        )
        .await
        .unwrap();
    assert!(
        engine
            .mcp_app_open(
                "owner".into(),
                Some(other.clone()),
                thread.clone(),
                server,
                generation,
                "app".into(),
                None,
                "open-page".into(),
                None,
                None
            )
            .await
            .is_err()
    );
    let declaration = PageDeclaration {
        version: 1,
        document_id: "00000000-0000-4000-8000-000000000001".into(),
        tools: vec![PageToolKind::GetSelection, PageToolKind::ApplyPatch],
    };
    let input = PageRegister {
        thread_id: thread.clone(),
        instance_id: app["instanceId"].as_str().unwrap().into(),
        generation,
        owner_id: "00000000-0000-4000-8000-000000000002".into(),
        declaration,
    };
    assert!(
        engine
            .mcp_page_tools_register(other.clone(), input.clone())
            .await
            .is_err()
    );
    let registration = engine
        .mcp_page_tools_register(host.clone(), input.clone())
        .await
        .unwrap();
    assert_eq!(
        registration,
        engine
            .mcp_page_tools_register(host.clone(), input.clone())
            .await
            .unwrap()
    );
    let mut changed = input.clone();
    changed.declaration.document_id = "00000000-0000-4000-8000-000000000003".into();
    assert!(
        engine
            .mcp_page_tools_register(host.clone(), changed)
            .await
            .is_err()
    );
    engine
        .start(&thread, vec![areal_protocol::Input::text("edit this page")])
        .await
        .unwrap();
    let notice = tokio::time::timeout(std::time::Duration::from_secs(10), notices.recv())
        .await
        .unwrap()
        .unwrap();
    let coordinates = match notice {
        PageToolNotice::Pending(c) => c,
        _ => panic!("expected pending"),
    };
    if matches!(mode, "pendingCancel" | "revoked") {
        if mode == "revoked" {
            engine
                .mcp_page_tools_revoke(
                    host.clone(),
                    PageRevoke {
                        thread_id: thread.clone(),
                        instance_id: input.instance_id.clone(),
                        generation,
                        registration_id: coordinates.registration_id.clone(),
                        owner_id: input.owner_id.clone(),
                    },
                )
                .await
                .unwrap();
            assert!(
                engine
                    .mcp_page_tools_register(host.clone(), input)
                    .await
                    .is_err()
            );
        } else {
            engine
                .interrupt(&thread, &coordinates.turn_id)
                .await
                .unwrap();
        }
        let finished = engine.wait(&thread).await.unwrap();
        let page = page_terminal(&finished);
        assert_eq!(page["outcome"], "cancelled", "{mode}: {page}");
        assert_eq!(page["page"]["dispatch"]["claimId"], serde_json::Value::Null);
        assert_eq!(
            engine
                .mcp_page_tools_claim(host, coordinates)
                .await
                .unwrap()["status"],
            "notGranted"
        );
        engine.shutdown().await;
        return;
    }
    assert!(
        engine
            .mcp_page_tools_claim(other.clone(), coordinates.clone())
            .await
            .is_err()
    );
    let grant = engine
        .mcp_page_tools_claim(host.clone(), coordinates.clone())
        .await
        .unwrap();
    assert_eq!(grant["status"], "granted");
    let durable_claim = serde_json::to_value(engine.read(&thread, true).await.unwrap()).unwrap();
    assert!(durable_claim.to_string().contains("claimed"));
    assert_eq!(
        engine
            .mcp_page_tools_claim(host.clone(), coordinates.clone())
            .await
            .unwrap()["status"],
        "notGranted"
    );
    let result = match mode {
        "selectionRevisionLimit" => {
            json!({"kind":"selection","documentId":input.declaration.document_id,"documentRevision":9_007_199_254_740_991_u64,"anchor":0,"head":1,"selectedText":"x","truncated":false,"dirty":true})
        }
        "conflictRevisionLimit" => {
            json!({"kind":"conflict","documentId":input.declaration.document_id,"expectedDocumentRevision":9_007_199_254_740_990_u64,"documentRevision":9_007_199_254_740_991_u64})
        }
        "appliedRevisionLimit" => {
            json!({"kind":"applied","documentId":input.declaration.document_id,"previousDocumentRevision":9_007_199_254_740_990_u64,"documentRevision":9_007_199_254_740_991_u64,"from":0,"to":0,"insertedLength":1,"dirty":true})
        }
        "reversedRange" => {
            json!({"kind":"applied","documentId":input.declaration.document_id,"previousDocumentRevision":0,"documentRevision":1,"from":2,"to":1,"insertedLength":1,"dirty":true})
        }
        "emptyInsertion" => {
            json!({"kind":"applied","documentId":input.declaration.document_id,"previousDocumentRevision":0,"documentRevision":1,"from":0,"to":0,"insertedLength":0,"dirty":true})
        }
        _ => {
            json!({"kind":"applied","documentId":input.declaration.document_id,"previousDocumentRevision":0,"documentRevision":1,"from":0,"to":0,"insertedLength":1,"dirty":true})
        }
    };
    let mut resolve: PageResolve = serde_json::from_value(json!({"threadId":coordinates.thread_id,"turnId":coordinates.turn_id,"callId":coordinates.call_id,"registrationId":coordinates.registration_id,"ownerId":coordinates.owner_id,"schemaDigest":coordinates.schema_digest,"claimId":grant["claimId"],"reply":{"status":"completed","result":result}})).unwrap();
    assert!(
        engine
            .mcp_page_tools_resolve(other, resolve.clone())
            .await
            .is_err()
    );
    if matches!(mode, "claimedCancel" | "hostLost") {
        if mode == "hostLost" {
            host.closed.store(true, std::sync::atomic::Ordering::SeqCst);
        } else {
            engine
                .interrupt(&thread, &coordinates.turn_id)
                .await
                .unwrap();
        }
        let finished = engine.wait(&thread).await.unwrap();
        let page = page_terminal(&finished);
        assert_eq!(page["outcome"], "unknown", "{mode}: {page}");
        assert!(engine.mcp_page_tools_resolve(host, resolve).await.is_err());
        assert!(
            engine
                .start(
                    &thread,
                    vec![areal_protocol::Input::text("must not replay")]
                )
                .await
                .is_err()
        );
        engine.shutdown().await;
        return;
    }
    if matches!(mode, "reversedRange" | "emptyInsertion") {
        assert!(
            matches!(
                engine
                    .mcp_page_tools_resolve(host.clone(), resolve.clone())
                    .await,
                Err(areal_engine::Error::Invalid(_))
            ),
            "applied evidence must reject an invalid or empty replacement range"
        );
        let pending = page_terminal(&engine.read(&thread, true).await.unwrap());
        assert_eq!(pending["page"]["dispatch"]["state"], "claimed");
        resolve.reply = PageReply::NoEffect {
            reason: PageNoEffect::Unavailable,
        };
    }
    assert_eq!(
        engine
            .mcp_page_tools_resolve(host.clone(), resolve.clone())
            .await
            .unwrap(),
        json!({"status":"accepted"})
    );
    let accepted = engine.read(&thread, true).await.unwrap();
    let expected = page_terminal(&accepted);
    assert_eq!(
        expected["outcome"],
        if matches!(
            mode,
            "conflictRevisionLimit" | "reversedRange" | "emptyInsertion"
        ) {
            "failed"
        } else {
            "succeeded"
        }
    );
    if mode == "postCancel" {
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while !workspace.path().join("hook-entered").exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        engine
            .interrupt(&thread, &coordinates.turn_id)
            .await
            .unwrap();
    }
    let finished = engine.wait(&thread).await.unwrap();
    assert_eq!(page_terminal(&finished), expected, "{mode}");
    if mode == "feedback" {
        assert!(
            serde_json::to_value(&finished)
                .unwrap()
                .to_string()
                .contains("page-feedback")
        );
    }
    if matches!(mode, "postFailure" | "postCancel") {
        assert!(
            finished
                .desktop
                .as_ref()
                .unwrap()
                .hook_runs
                .iter()
                .any(|h| h.event == "PostToolUse" && h.outcome == "unknown"),
            "{mode} must exercise a failed post hook"
        );
    }
    assert_eq!(
        engine
            .mcp_page_tools_resolve(host.clone(), resolve.clone())
            .await
            .unwrap(),
        json!({"status":"accepted"})
    );
    let mut conflicting = resolve;
    conflicting.reply = PageReply::Unknown;
    assert!(
        engine
            .mcp_page_tools_resolve(host, conflicting)
            .await
            .is_err()
    );
    engine.shutdown().await;
    drop(engine);
    let reopened = Engine::open(state.path(), Arc::new(ModelFixture), Limits::default()).unwrap();
    assert_eq!(
        page_terminal(&reopened.read(&thread, true).await.unwrap()),
        expected
    );
    reopened.shutdown().await;
}

fn page_terminal(thread: &areal_protocol::Thread) -> serde_json::Value {
    thread.turns.last().unwrap().items.iter().find_map(|item| match item {
        areal_protocol::Item::DynamicToolCall { execution, content_items, success, .. } if execution.page.is_some() => Some(json!({"page":execution.page,"outcome":execution.outcome,"snapshot":execution.result_snapshot,"content":content_items,"success":success})),
        _ => None,
    }).unwrap()
}
