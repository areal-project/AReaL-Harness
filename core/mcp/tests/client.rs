use areal_mcp::{Connections, ServerConfig};
use areal_protocol::ToolContent;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

fn env() -> BTreeMap<OsString, OsString> {
    [
        ("PATH".into(), std::env::var_os("PATH").unwrap_or_default()),
        ("MCP_VISIBLE".into(), "visible".into()),
        ("MCP_HIDDEN".into(), "hidden".into()),
        ("MCP_TEST_TOKEN".into(), "fixture-token".into()),
    ]
    .into()
}
fn stdio(log: &Path, mode: &str) -> ServerConfig {
    serde_json::from_value(json!({"transport":{"type":"stdio", "command":"python3", "args":[concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures/mcp-server.py"), log, mode], "envVars":["MCP_VISIBLE"]}, "callTimeoutMs":2000})).unwrap()
}
fn read_log(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}
async fn wait_log(path: &Path, predicate: impl Fn(&Value) -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if read_log(path).iter().any(&predicate) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("fixture event");
}
fn text(result: &areal_protocol::DynamicToolResponse) -> &str {
    match &result.content_items[0] {
        ToolContent::InputText { text } => text,
        _ => panic!("expected text result"),
    }
}

#[tokio::test]
async fn stdio_discovers_pages_maps_results_and_closes_child() {
    let temp = tempfile::tempdir().unwrap();
    let log = temp.path().join("calls.jsonl");
    let mut connections = Connections::connect(
        &[("fixture".into(), stdio(&log, "normal"))].into(),
        &env(),
        temp.path(),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    let tools = connections.tools();
    assert_eq!(tools.len(), 2);
    assert_eq!(tools[0].definition.name, "mcp__fixture__echo");
    assert!(tools[1].definition.name.starts_with("mcp__fixture__"));
    assert!(!tools[1].definition.name.contains('.'));
    assert_eq!(
        tools[0].definition.output_schema.as_ref().unwrap()["required"],
        json!(["echo"])
    );
    let result = tools[1]
        .call(json!({"value":"environment"}), CancellationToken::new())
        .await
        .unwrap();
    let exposed: Value = serde_json::from_str(text(&result)).unwrap();
    assert_eq!(exposed["visible"], "visible");
    assert!(exposed["hidden"].is_null());
    assert_eq!(
        std::fs::canonicalize(exposed["cwd"].as_str().unwrap()).unwrap(),
        std::fs::canonicalize(temp.path()).unwrap()
    );
    assert!(result.success);
    assert_eq!(result.structured_content.unwrap()["echo"], "environment");
    let result = tools[0]
        .call(json!({"value":"failure"}), CancellationToken::new())
        .await
        .unwrap();
    assert!(!result.success);
    for value in ["large"] {
        let error = tools[0]
            .call(json!({"value":value}), CancellationToken::new())
            .await
            .unwrap_err();
        assert!(error.to_string().contains("UNKNOWN"));
    }
    let media = tools[0]
        .call(json!({"value":"image"}), CancellationToken::new())
        .await
        .unwrap();
    assert!(
        matches!(&media.content_items[0],ToolContent::InlineMedia{data_base64,..} if data_base64=="AA==")
    );
    connections.shutdown().await.unwrap();
    let records = read_log(&log);
    assert!(
        records
            .iter()
            .any(|r| r["method"] == "notifications/initialized")
    );
    assert!(
        records
            .iter()
            .any(|r| r["method"] == "tools/call" && r["params"]["name"] == "echo.dot")
    );
    assert!(records.iter().any(|r| r["event"] == "exited"));
}

#[tokio::test]
async fn stdio_cancellation_and_timeout_notify_without_replay() {
    for timeout in [None, Some(80)] {
        let temp = tempfile::tempdir().unwrap();
        let log = temp.path().join("calls.jsonl");
        let mut config = stdio(&log, "normal");
        config.call_timeout_ms = timeout;
        let mut connections = Connections::connect(
            &[("fixture".into(), config)].into(),
            &env(),
            temp.path(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let tool = connections.tools().remove(0);
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let call = tokio::spawn(async move { tool.call(json!({"value":"hang"}), cancel).await });
        wait_log(&log, |r| r["method"] == "tools/call").await;
        if timeout.is_none() {
            stop.cancel();
        }
        assert!(
            tokio::time::timeout(Duration::from_secs(5), call)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err()
                .to_string()
                .contains("UNKNOWN")
        );
        wait_log(&log, |r| r["method"] == "notifications/cancelled").await;
        connections.shutdown().await.unwrap();
        let records = read_log(&log);
        let calls: Vec<_> = records
            .iter()
            .filter(|r| r["method"] == "tools/call")
            .collect();
        assert_eq!(calls.len(), 1);
        let notification = records
            .iter()
            .find(|r| r["method"] == "notifications/cancelled")
            .unwrap();
        assert_eq!(notification["params"]["requestId"], calls[0]["id"]);
    }
}

#[tokio::test]
async fn stdio_disconnect_and_list_change_stop_further_calls() {
    for value in ["disconnect", "change"] {
        let temp = tempfile::tempdir().unwrap();
        let log = temp.path().join("calls.jsonl");
        let mut connections = Connections::connect(
            &[("fixture".into(), stdio(&log, "normal"))].into(),
            &env(),
            temp.path(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let tool = connections.tools().remove(0);
        let result = tool
            .call(json!({"value":value}), CancellationToken::new())
            .await;
        assert_eq!(result.is_ok(), value == "change");
        assert!(
            tool.call(json!({"value":"must not run"}), CancellationToken::new())
                .await
                .is_err()
        );
        connections.shutdown().await.unwrap();
        assert_eq!(
            read_log(&log)
                .iter()
                .filter(|r| r["method"] == "tools/call")
                .count(),
            1
        );
    }
}

#[tokio::test]
async fn stdio_allowlist_and_startup_failure_roll_back() {
    let temp = tempfile::tempdir().unwrap();
    let log = temp.path().join("calls.jsonl");
    let mut config = stdio(&log, "normal");
    config.enabled_tools = Some(vec!["echo.dot".into()]);
    let mut connections = Connections::connect(
        &[("fixture".into(), config.clone())].into(),
        &env(),
        temp.path(),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(connections.tools().len(), 1);
    connections.shutdown().await.unwrap();
    for mode in ["normal", "repeat-cursor"] {
        let log = temp.path().join(format!("{mode}.jsonl"));
        let mut config = stdio(&log, mode);
        if mode == "normal" {
            config.enabled_tools = Some(vec!["missing".into()]);
        }
        assert!(
            Connections::connect(
                &[("fixture".into(), config)].into(),
                &env(),
                temp.path(),
                CancellationToken::new()
            )
            .await
            .is_err()
        );
        assert!(read_log(&log).iter().any(|r| r["event"] == "exited"));
    }
    let log = temp.path().join("rollback.jsonl");
    let mut missing = stdio(&log, "normal");
    missing.transport =
        serde_json::from_value(json!({"type":"stdio", "command":"areal-no-such-test-executable"}))
            .unwrap();
    assert!(
        Connections::connect(
            &[("a".into(), stdio(&log, "normal")), ("b".into(), missing)].into(),
            &env(),
            temp.path(),
            CancellationToken::new()
        )
        .await
        .is_err()
    );
    assert!(read_log(&log).iter().any(|r| r["event"] == "exited"));
}

#[test]
fn config_is_strict_and_long_timeouts_are_optional() {
    let mut config: ServerConfig = serde_json::from_value(
        json!({"transport":{"type":"streamableHttp", "url":"https://example.com/mcp"}}),
    )
    .unwrap();
    assert_eq!(config.call_timeout_ms, Some(120000));
    for timeout in [None, Some(172800000)] {
        config.call_timeout_ms = timeout;
        areal_mcp::validate(&[("fixture".into(), config.clone())].into()).unwrap();
    }
    for transport in [
        json!({"type":"stdio", "command":"x", "envVars":["bad=name"]}),
        json!({"type":"streamableHttp", "url":"https://user:password@example.com/mcp"}),
    ] {
        config.transport = serde_json::from_value(transport).unwrap();
        assert!(areal_mcp::validate(&[("fixture".into(), config.clone())].into()).is_err());
    }
    assert!(
        serde_json::from_value::<ServerConfig>(
            json!({"transport":{"type":"stdio","command":"x"}, "typo":true})
        )
        .is_err()
    );
}

#[derive(Clone)]
struct HttpState {
    records: Arc<Mutex<Vec<Value>>>,
    mode: &'static str,
}
async fn http_peer(
    axum::extract::State(state): axum::extract::State<HttpState>,
    method: axum::http::Method,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> axum::response::Response {
    use axum::{http::StatusCode, response::IntoResponse};
    assert_eq!(
        headers.get("authorization").unwrap(),
        "Bearer fixture-token"
    );
    if method == axum::http::Method::GET {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    if method == axum::http::Method::DELETE {
        state
            .records
            .lock()
            .unwrap()
            .push(json!({"method":"DELETE"}));
        return StatusCode::OK.into_response();
    }
    let request: Value = serde_json::from_slice(&body).unwrap();
    state.records.lock().unwrap().push(request.clone());
    let operation = request["method"].as_str().unwrap();
    if operation != "initialize" {
        assert_eq!(headers.get("mcp-session-id").unwrap(), "fixture-session");
        assert_eq!(headers.get("mcp-protocol-version").unwrap(), "2025-11-25");
    }
    let result = match operation {
        "initialize" => {
            json!({"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}})
        }
        "notifications/initialized" | "notifications/cancelled" => {
            return StatusCode::ACCEPTED.into_response();
        }
        "tools/list" => {
            json!({"tools":[{"name":"echo","description":"HTTP echo","inputSchema":{"type":"object"}}]})
        }
        "tools/call" if state.mode == "expired" => return StatusCode::NOT_FOUND.into_response(),
        "tools/call" => json!({"content":[{"type":"text","text":"http result"}]}),
        _ => panic!("unexpected request: {operation}"),
    };
    let reply = json!({"jsonrpc":"2.0","id":request["id"],"result":result});
    let mut response = if state.mode == "sse" && operation == "tools/call" {
        (
            [("content-type", "text/event-stream")],
            format!("event: message\ndata: {reply}\n\n"),
        )
            .into_response()
    } else {
        axum::Json(reply).into_response()
    };
    if operation == "initialize" {
        response
            .headers_mut()
            .insert("mcp-session-id", "fixture-session".parse().unwrap());
    }
    response
}

#[tokio::test]
async fn http_json_sse_auth_sessions_and_expiry_without_replay() {
    for mode in ["json", "sse", "expired"] {
        let state = HttpState {
            records: Arc::default(),
            mode,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/mcp", listener.local_addr().unwrap());
        let app = axum::Router::new()
            .route("/mcp", axum::routing::any(http_peer))
            .with_state(state.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let temp = tempfile::tempdir().unwrap();
        let config = serde_json::from_value(json!({"transport":{"type":"streamableHttp","url":endpoint,"bearerTokenEnv":"MCP_TEST_TOKEN"}, "startupTimeoutMs":2000,"callTimeoutMs":2000})).unwrap();
        let mut connections = Connections::connect(
            &[("fixture".into(), config)].into(),
            &env(),
            temp.path(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let result = connections.tools()[0]
            .call(json!({}), CancellationToken::new())
            .await;
        if mode == "expired" {
            assert!(result.unwrap_err().to_string().contains("UNKNOWN"));
        } else {
            assert_eq!(text(&result.unwrap()), "http result");
        }
        connections.shutdown().await.unwrap();
        let records = state.records.lock().unwrap();
        assert_eq!(
            records
                .iter()
                .filter(|r| r["method"] == "initialize")
                .count(),
            1
        );
        assert_eq!(
            records
                .iter()
                .filter(|r| r["method"] == "tools/call")
                .count(),
            1
        );
        assert!(records.iter().any(|r| r["method"] == "DELETE"));
        server.abort();
    }
}

#[cfg(unix)]
#[tokio::test]
async fn startup_timeout_and_cancellation_reap_stdio_child() {
    for interrupt in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let log = temp.path().join("startup.jsonl");
        let mut config = stdio(&log, "hang-startup");
        // Startup speed is not the property under test. Let the real child
        // become observable before advancing only the handshake deadline.
        config.startup_timeout_ms = 30000;
        let configs = [("fixture".into(), config)].into();
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let base = temp.path().to_owned();
        let connection =
            tokio::spawn(
                async move { Connections::connect(&configs, &env(), &base, cancel).await },
            );
        wait_log(&log, |r| r["event"] == "started").await;
        let pid = read_log(&log)[0]["pid"].as_u64().unwrap().to_string();
        if interrupt {
            stop.cancel();
        } else {
            tokio::time::pause();
            tokio::time::advance(Duration::from_secs(30)).await;
            tokio::time::resume();
        }
        assert!(connection.await.unwrap().is_err());
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let status = tokio::process::Command::new("kill")
                    .args(["-0", &pid])
                    .stderr(std::process::Stdio::null())
                    .status()
                    .await
                    .unwrap();
                if !status.success() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("SDK must reap startup child");
    }
}
