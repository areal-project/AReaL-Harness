use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelStream},
};
use areal_plugins::Store;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    sync::{Arc, Mutex},
};

const ID: &str = "sample@local";
const ENV_SECRET: &str = "import-private-environment";
const HEADER_SECRET: &str = "import-private-header";
struct NoInference;
#[async_trait]
impl Model for NoInference {
    fn name(&self) -> &str {
        "unused"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        anyhow::bail!("import fixture must not invoke inference")
    }
}
fn write(root: &Path, path: &str, value: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, value).unwrap();
}
fn package(
    manifest_path: &str,
    manifest: Value,
    document_path: &str,
    document: Value,
) -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        ".agents/plugins/marketplace.json",
        r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
    );
    write(
        root.path(),
        &format!("pkg/{manifest_path}"),
        &manifest.to_string(),
    );
    write(
        root.path(),
        &format!("pkg/{document_path}"),
        &document.to_string(),
    );
    root
}
fn open(root: &Path) -> Arc<Store> {
    Arc::new(Store::open(root.join("plugins"), root.into(), None).unwrap())
}
fn report_rows(detail: &Value, field: &str) -> Vec<Value> {
    detail[field]["components"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["kind"] == "mcp")
        .cloned()
        .collect()
}
fn redacted(value: &Value) {
    for secret in [ENV_SECRET, HEADER_SECRET] {
        assert!(
            !value.to_string().contains(secret),
            "management projection leaked {secret}"
        );
    }
}
async fn http_fixture(
    axum::extract::State(seen): axum::extract::State<Arc<Mutex<Vec<String>>>>,
    headers: axum::http::HeaderMap,
    body: String,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let request: Value = serde_json::from_str(&body).unwrap();
    if request["method"] == "initialize" {
        seen.lock()
            .unwrap()
            .push(headers["x-import-secret"].to_str().unwrap().into());
    }
    let result = match request["method"].as_str().unwrap() {
        "initialize" => json!({"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"import-http","version":"1"}}),
        "tools/list" => json!({"tools":[]}),
        "server/discover" => return axum::Json(json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32601,"message":"Method not found"}})).into_response(),
        _ => return axum::http::StatusCode::ACCEPTED.into_response(),
    };
    axum::Json(json!({"jsonrpc":"2.0","id":request["id"],"result":result})).into_response()
}

#[tokio::test]
async fn portable_and_legacy_imports_preserve_observed_stdio_and_http_behavior() {
    for dialect in ["portable", "legacy-wrapped", "legacy-bare"] {
        let portable = dialect == "portable";
        let seen = Arc::new(Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let router = axum::Router::new()
            .route("/mcp", axum::routing::post(http_fixture))
            .with_state(seen.clone());
        let http = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let marker = tempfile::tempdir().unwrap();
        let marker_path = marker.path().join("started.json");
        let mut stdio = json!({"command":"python3","args":[if portable {"${PLUGIN_ROOT}/server.py"} else {"../server.py"},"fixture-argument"],"cwd":if portable {"${PLUGIN_ROOT}/work"} else {"work"},"env":{"IMPORT_LITERAL":ENV_SECRET,"IMPORT_MARKER":marker_path}});
        let mut remote = json!({"url":url});
        if portable {
            stdio["type"] = json!("stdio");
            remote["type"] = json!("streamable-http");
            remote["headers"] = json!({"X-Import-Secret":HEADER_SECRET});
        } else {
            remote["http_headers"] = json!({"X-Import-Secret":HEADER_SECRET});
        }
        let servers = json!({"fixture":stdio,"http":remote,"malformed":7});
        let document = match dialect {
            "portable" => {
                json!({"$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json","mcpServers":servers})
            }
            "legacy-wrapped" => json!({"mcpServers":servers}),
            _ => servers,
        };
        let root = package(
            if portable {
                "plugin.json"
            } else {
                ".codex-plugin/plugin.json"
            },
            if portable {
                json!({"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"sample"})
            } else {
                json!({"name":"sample"})
            },
            if portable { "mcp.json" } else { ".mcp.json" },
            document,
        );
        write(
            root.path(),
            "pkg/server.py",
            include_str!("fixtures/plugin_import.py"),
        );
        write(root.path(), "pkg/work/.keep", "");
        let state = tempfile::tempdir().unwrap();
        let engine = Engine::open(state.path(), Arc::new(NoInference), Limits::default()).unwrap();
        let store = open(root.path());
        engine.install_plugin_store(store.clone()).unwrap();
        let detail = store.read(ID).unwrap();
        let source = serde_json::to_value(&detail).unwrap();
        let base = match dialect {
            "portable" => "mcp.json#/mcpServers",
            "legacy-wrapped" => ".mcp.json#/mcpServers",
            _ => ".mcp.json#",
        };
        let rows = report_rows(&source, "componentSupport");
        assert_eq!(
            rows.iter()
                .map(|row| (&row["sourceField"], &row["status"]))
                .collect::<Vec<_>>(),
            vec![
                (&json!(format!("{base}/fixture")), &json!("supported")),
                (&json!(format!("{base}/http")), &json!("supported")),
                (&json!(format!("{base}/malformed")), &json!("partial"))
            ]
        );
        assert_eq!(rows[2]["reasonCodes"], json!(["invalidMcpEnvelope"]));
        redacted(&source["componentSupport"]);
        assert_eq!(
            engine.plugin_component_summary(ID.into()).await.unwrap()["mcpServers"],
            json!(["fixture", "http"])
        );
        assert!(!marker_path.exists());
        assert!(seen.lock().unwrap().is_empty());
        engine
            .plugin_install(
                detail.id,
                "user".into(),
                detail.revision,
                detail.source,
                detail.source_digest,
            )
            .await
            .unwrap();
        let installed = store.read(ID).unwrap();
        let installed_value = serde_json::to_value(&installed).unwrap();
        assert_eq!(
            report_rows(&installed_value, "installedComponentSupport"),
            rows
        );
        redacted(&installed_value["installedComponentSupport"]);
        let listed = engine.plugin_mcp_list().await.unwrap();
        redacted(&listed);
        let summary = engine.plugin_component_summary(ID.into()).await.unwrap();
        redacted(&summary);
        assert_eq!(summary["mcpServers"], json!(["fixture", "http"]));
        assert_eq!(listed["data"][0]["state"], "disconnected");
        assert_eq!(listed["data"][0]["servers"].as_array().unwrap().len(), 2);
        assert_eq!(listed["data"][0]["diagnostics"][0]["server"], "malformed");
        assert_eq!(
            listed["data"][0]["diagnostics"][0]["class"],
            "configuration"
        );
        assert!(
            !marker_path.exists(),
            "installation/list must not spawn a process"
        );
        assert!(
            seen.lock().unwrap().is_empty(),
            "installation/list must not contact HTTP"
        );
        let connected = engine
            .plugin_connection(ID.into(), installed.installed_digest.unwrap(), true)
            .await
            .unwrap();
        assert!(
            connected["data"][0]["servers"]
                .as_array()
                .unwrap()
                .iter()
                .all(|row| row["state"] == "connected"),
            "{dialect}: {connected}"
        );
        redacted(&connected);
        assert_eq!(*seen.lock().unwrap(), vec![HEADER_SECRET.to_owned()]);
        let components = store.installed_components().unwrap();
        let component = &components[0];
        let apps = engine.mcp_apps_list(None).await.unwrap();
        assert_eq!(apps["data"].as_array().unwrap().len(), 2);
        let app = apps["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|server| !server["tools"].as_array().unwrap().is_empty())
            .unwrap();
        let generation = app["generation"].as_u64().unwrap();
        let thread = engine
            .create(root.path().to_str().unwrap().into())
            .await
            .unwrap();
        let opened = engine
            .mcp_app_open(
                "owner".into(),
                None,
                thread.id.clone(),
                app["serverId"].as_str().unwrap().into(),
                generation,
                "observe".into(),
                None,
                "import-open".into(),
                None,
                None,
            )
            .await
            .unwrap();
        let result = engine.mcp_app_request("owner".into(), thread.id, opened["instanceId"].as_str().unwrap().into(), generation, json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"observe","arguments":{}}}), Some("import-observe".into())).await.unwrap();
        let observed: Value =
            serde_json::from_str(result["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(observed["argument"], "fixture-argument");
        assert_eq!(observed["literal"], ENV_SECRET);
        assert_eq!(
            observed["cwd"],
            json!(fs::canonicalize(component.root.join("work")).unwrap())
        );
        if portable {
            assert_eq!(
                observed["root"],
                json!(fs::canonicalize(&component.root).unwrap())
            );
            assert_eq!(
                observed["data"],
                json!(
                    fs::canonicalize(root.path())
                        .unwrap()
                        .join("plugins/data/sample@local")
                )
            );
        }
        assert_eq!(
            observed,
            serde_json::from_slice::<Value>(&fs::read(&marker_path).unwrap()).unwrap()
        );
        engine.shutdown().await;
        http.abort();
    }
}

#[tokio::test]
async fn unknown_portable_schema_is_statically_recognized_but_runtime_rejected() {
    let root = package(
        "plugin.json",
        json!({"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"sample"}),
        "mcp.json",
        json!({"$schema":"https://invalid.example/future-mcp.schema.json","mcpServers":{"fixture":{"type":"stdio","command":"NEVER_EXECUTE","env":{"SECRET":ENV_SECRET}}}}),
    );
    let state = tempfile::tempdir().unwrap();
    let engine = Engine::open(state.path(), Arc::new(NoInference), Limits::default()).unwrap();
    let store = open(root.path());
    engine.install_plugin_store(store.clone()).unwrap();
    let detail = store.read(ID).unwrap();
    let value = serde_json::to_value(&detail).unwrap();
    let rows = report_rows(&value, "componentSupport");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["sourceField"], "mcp.json#/mcpServers/fixture");
    assert_eq!(rows[0]["status"], "supported");
    assert_eq!(rows[0]["supportedSchema"], "areal-mcp-document-envelope-v1");
    assert_eq!(
        value["componentSupport"]["compatibility"]["state"],
        "allowed"
    );
    redacted(&value["componentSupport"]);
    assert!(engine.plugin_component_summary(ID.into()).await.is_err());
    store
        .install(
            ID,
            "user",
            detail.revision,
            &detail.source,
            &detail.source_digest,
        )
        .unwrap();
    assert!(engine.plugin_mcp_list().await.is_err());
    engine.shutdown().await;
}

#[test]
fn user_config_gate_scans_retained_whole_documents_after_claude_override() {
    for (claude, document, expected_blocked) in [
        (
            false,
            json!({"mcpServers":{"fixture":{"command":"NEVER_EXECUTE"}},"metadata":"${user_config.secret}"}),
            true,
        ),
        (false, json!({"mcpServers":"${userConfig.secret}"}), true),
        (
            true,
            json!({"mcpServers":{"fixture":{"command":"NEVER_EXECUTE"},"shared":{"command":"${user_config.secret}"}}}),
            false,
        ),
        (
            true,
            json!({"mcpServers":{"fixture":{"command":"NEVER_EXECUTE"},"shared":{"command":"${user_config.secret}"}},"metadata":"${user_config.secret}"}),
            true,
        ),
    ] {
        let manifest = if claude {
            json!({"name":"sample","mcpServers":{"shared":{"command":"NEVER_EXECUTE"}}})
        } else {
            json!({"name":"sample"})
        };
        let root = package(
            if claude {
                ".claude-plugin/plugin.json"
            } else {
                ".codex-plugin/plugin.json"
            },
            manifest,
            ".mcp.json",
            document,
        );
        let store = open(root.path());
        let detail = store.read(ID).unwrap();
        let value = serde_json::to_value(&detail).unwrap();
        assert_eq!(
            value["componentSupport"]["compatibility"]["reasonCodes"]
                .as_array()
                .unwrap()
                .contains(&json!("userConfigUnsupported")),
            expected_blocked
        );
        store
            .install(
                ID,
                "user",
                detail.revision,
                &detail.source,
                &detail.source_digest,
            )
            .unwrap();
        assert_eq!(
            store.installed_components().unwrap()[0]
                .mcp_documents
                .is_empty(),
            expected_blocked
        );
    }
}
