//! 普通 MCP 的发现、摘要连接、撤权、MRTR 表单与持久回执。
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
async fn retired_app_state_does_not_participate_in_core_open() {
    let state = tempfile::tempdir().unwrap();
    let historical = b"retired App state is not a current runtime input";
    write(
        state.path(),
        "desktop/mcp-apps.json",
        std::str::from_utf8(historical).unwrap(),
    );
    let engine = Engine::open(state.path(), Arc::new(ModelFixture), Limits::default())
        .expect("retired App metadata must not block current Core startup");
    let thread = engine
        .create(state.path().to_str().unwrap().into())
        .await
        .unwrap();
    assert_eq!(engine.read(&thread.id, false).await.unwrap().id, thread.id);
    assert_eq!(
        fs::read(state.path().join("desktop/mcp-apps.json")).unwrap(),
        historical
    );
    engine.shutdown().await;
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
    let connected = e.plugin_mcp_list().await.unwrap();
    assert_eq!(connected["data"][0]["state"], "connected");
    let digest = s.read(&d.id).unwrap().installed_digest.unwrap();
    e.plugin_connection(d.id.clone(), digest, false)
        .await
        .unwrap();
    assert_eq!(
        e.plugin_mcp_list().await.unwrap()["data"][0]["state"],
        "disconnected"
    );
    e.shutdown().await;
}
async fn connected_servers(engine: &Arc<Engine>) -> serde_json::Value {
    let listed = engine.plugin_mcp_list().await.unwrap();
    json!({"data":listed["data"].as_array().unwrap().iter().flat_map(|row|row["servers"].as_array().unwrap()).filter(|server|server["state"]=="connected").cloned().collect::<Vec<_>>()})
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
async fn component_disable_revokes_captured_tools() {
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
    let server = engine.plugin_mcp_list().await.unwrap()["data"][0]["servers"][0]["serverId"]
        .as_str()
        .unwrap()
        .to_owned();
    let thread = engine
        .create(workspace.path().to_str().unwrap().into())
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
        connected_servers(&engine).await["data"]
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
        connected_servers(&engine).await["data"]
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
#[tokio::test]
async fn long_mcp_aliases_are_valid_distinct_and_connectors_resolve_from_marketplace() {
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
        &json!({"apps":[{"id":original,"name":"GitHub"},{"id":"unlisted-app","name":"Other"}]})
            .to_string(),
    );
    // 市场收录的连接器在安装时变成普通远程 MCP；未收录的 ID 只报告为不支持。
    write(
        workspace.path(),
        "connectors.json",
        &json!({"version":1,"services":[{"id":"gh","aliases":[original],
            "mcp":{"type":"streamable-http","url":"https://connector.invalid/mcp"},
            "auth":{"type":"api_key","headerScheme":"bearer"}}]})
        .to_string(),
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
    let apps = connected_servers(&e).await;
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
    let rows = e.plugin_mcp_list().await.unwrap();
    let row = rows["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["pluginId"] == d.id.as_str())
        .unwrap();
    let states: std::collections::BTreeMap<_, _> = row["connectors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["id"].as_str().unwrap(), c["state"].as_str().unwrap()))
        .collect();
    assert_eq!(states[original], "mapped");
    assert_eq!(states["unlisted-app"], "missingMapping");
    let remote = row["servers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["config"]["transport"] == "streamable-http")
        .expect("connector resolved into a plugin MCP server");
    assert_eq!(
        remote["config"]["authenticationRequirements"]["mode"],
        "api_key"
    );
    assert_eq!(remote["state"], "authRequired");
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
                connected_servers(&e).await["data"]
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
                connected_servers(&e).await["data"]
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
async fn explicit_profile_does_not_expand_model_visibility() {
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
async fn explicit_retry_after_optional_oauth_replaces_current_generation() {
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
        connected_servers(&e).await["data"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let before = connected_servers(&e).await;
    e.plugin_connection(d.id.clone(), digest, true)
        .await
        .unwrap();
    let after = connected_servers(&e).await;
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
    e.shutdown().await;
    http.abort();
    let _ = http.await;
}

#[tokio::test]
async fn mrtr_extension_tools_keep_authoritative_forms_and_uploads() {
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
        &include_str!("../../mcp/tests/mrtr.py").replace("'capabilities':{'tools':{},'resources':{}}", "'capabilities':{'tools':{},'resources':{},'extensions':{'openai/mentions':{'searchTool':'app'}}}"),
    );
    write(root.path(),"pkg/.mcp.json",&json!({"mcpServers":{"fixture":{"command":"python3","args":["server.py"],"env":{"READ_FORM":"1","TRACE":state.path().join("mrtr-wire.jsonl")}}}}).to_string());
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
    let connection = e
        .plugin_connection(d.id.clone(), d.installed_digest.unwrap(), true)
        .await
        .unwrap();
    assert_eq!(
        connection["data"][0]["state"],
        "connected",
        "connection: {connection}; wire: {:?}",
        fs::read_to_string(state.path().join("mrtr-wire.jsonl"))
    );
    let servers = connected_servers(&e).await;
    let server = servers["data"][0]["serverId"].as_str().unwrap().to_owned();
    let generation = servers["data"][0]["generation"]
        .as_u64()
        .expect("ordinary MCP catalog must expose its current generation");
    let thread = e
        .create(root.path().to_str().unwrap().into())
        .await
        .unwrap();
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
    let job = {
        let e = e.clone();
        let thread = thread.id.clone();
        let server = server.clone();
        tokio::spawn(async move {
            e.mcp_extension_call(
                "owner".into(),
                thread,
                (server, generation),
                "mentionsSearch".into(),
                json!({"mode":"normal"}),
                "mrtr-once".into(),
            )
            .await
        })
    };
    approve(&e, &thread.id).await;
    for _ in 0..2 {
        let form = next_form(&e, &thread.id).await;
        assert_ne!(form["turnId"], "");
        assert!(
            e.mcp_form_respond(
                "stranger".into(),
                thread.id.clone(),
                form["requestId"].as_str().unwrap().into(),
                json!({"action":"accept","content":{"answer":"forbidden"}})
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
            json!({"action":"accept","content":{"answer":"accepted"}}),
        )
        .await
        .unwrap();
    }
    let result = job.await.unwrap().unwrap();
    assert_eq!(result["_meta"]["preserved"], true);
    let replay = e
        .mcp_extension_call(
            "owner".into(),
            thread.id.clone(),
            (server.clone(), generation),
            "mentionsSearch".into(),
            json!({"mode":"normal"}),
            "mrtr-once".into(),
        )
        .await
        .unwrap();
    assert_eq!(result, replay);
    let saved = e.read(&thread.id, true).await.unwrap();
    assert_eq!(saved.turns.len(), 1);
    let call = saved.turns[0]
        .items
        .iter()
        .find_map(|item| match item {
            areal_protocol::Item::DynamicToolCall { call_id, .. } => Some(call_id.clone()),
            _ => None,
        })
        .unwrap();
    let raw = e.mcp_tool_result(thread.id.clone(), call).await.unwrap();
    assert_eq!(raw["mcpResult"], result);
    assert!(
        e.mcp_extension_call(
            "owner".into(),
            thread.id.clone(),
            (server.clone(), generation),
            "mentionsSearch".into(),
            json!({"mode":"changed"}),
            "mrtr-once".into()
        )
        .await
        .is_err()
    );
    assert_eq!(e.read(&thread.id, true).await.unwrap().turns.len(), 1);
    // Uploaded directory is outside the workspace; only the explicit picker operation can import it.
    let picked = tempfile::tempdir().unwrap();
    let picked_path = picked.path().canonicalize().unwrap();
    std::fs::write(picked_path.join("data.txt"), "snapshot-before").unwrap();
    let upload = {
        let e = e.clone();
        let thread = thread.id.clone();
        let server = server.clone();
        tokio::spawn(async move {
            // A steer hook can wait for a file form inside its durable submission.
            // An independent stage must still progress, while duplicates remain single-shot.
            e.management_submission(
                "owner".into(),
                "waiting-upload".into(),
                "turn/steer".into(),
                json!({"mode":"upload"}),
                move |e| async move {
                    e.mcp_extension_call(
                        "owner".into(),
                        thread,
                        (server, generation),
                        "mentionsSearch".into(),
                        json!({"mode":"upload"}),
                        "upload-once".into(),
                    )
                    .await
                    .unwrap()
                },
            )
            .await
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
        serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
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
