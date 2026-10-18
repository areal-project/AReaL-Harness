use areal_mcp::Connections;
use areal_protocol::ToolContent;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{io::AsyncWriteExt, net::TcpListener, time::timeout};
use tokio_util::sync::CancellationToken;

#[path = "../../../tests/support/proxy.rs"]
mod proxy;

#[tokio::test]
async fn mcp_search_uses_proxy_environment() {
    if let Ok(endpoint) = std::env::var("AREAL_TEST_PROXY_ENDPOINT") {
        let config = serde_json::from_value(json!({"transport":{"type":"streamableHttp","url":endpoint},"startupTimeoutMs":5000,"callTimeoutMs":5000})).unwrap();
        let mut connections = Connections::connect(
            &[("search".into(), config)].into(),
            &BTreeMap::new(),
            std::path::Path::new("."),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let tool = connections.tools().remove(0);
        assert_eq!(tool.definition.name, "mcp__search__web_search");
        let response = tool
            .call(json!({"query":"fixture"}), CancellationToken::new())
            .await
            .unwrap();
        assert!(response.success);
        assert!(
            matches!(&response.content_items[0], ToolContent::InputText { text } if text == "search through proxy")
        );
        connections.shutdown().await.unwrap();
        return;
    }
    for (scheme, variable, auth, bypass) in [
        ("http", "HTTP_PROXY", true, false),
        ("socks5h", "ALL_PROXY", false, false),
        ("socks5h", "all_proxy", true, false),
        ("socks5", "http_proxy", false, false),
        ("socks5h", "ALL_PROXY", false, true),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let hostname = if bypass {
            "127.0.0.1"
        } else if scheme == "socks5" {
            "localhost"
        } else {
            "mcp.invalid"
        };
        let proxy = proxy::Proxy::start(scheme, address, hostname, auth).await;
        let records = Arc::new(Mutex::new(Vec::new()));
        let observed = records.clone();
        let app = axum::Router::new().route("/mcp", axum::routing::any(move |method: axum::http::Method, headers: axum::http::HeaderMap, body: axum::body::Bytes| {
            let records = observed.clone();
            async move {
                use axum::{http::StatusCode, response::IntoResponse};
                assert!(!headers.contains_key("proxy-authorization"));
                if method != axum::http::Method::POST { return StatusCode::METHOD_NOT_ALLOWED.into_response(); }
                let request: Value = serde_json::from_slice(&body).unwrap();
                records.lock().unwrap().push(request.clone());
                let result = match request["method"].as_str().unwrap() {
                    "initialize" => json!({"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}}),
                    "notifications/initialized" => return StatusCode::ACCEPTED.into_response(),
                    "tools/list" => json!({"tools":[{"name":"web_search","description":"fixture search","inputSchema":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}]}),
                    "tools/call" => {
                        assert_eq!(request["params"]["name"], "web_search");
                        assert_eq!(request["params"]["arguments"]["query"], "fixture");
                        json!({"content":[{"type":"text","text":"search through proxy"}]})
                    }
                    other => panic!("unexpected MCP method {other}"),
                };
                axum::Json(json!({"jsonrpc":"2.0","id":request["id"],"result":result})).into_response()
            }
        }));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let output = timeout(
            Duration::from_secs(20),
            proxy::child("mcp_search_uses_proxy_environment")
                .env(
                    "AREAL_TEST_PROXY_ENDPOINT",
                    format!("http://{hostname}:{}/mcp", address.port()),
                )
                .env(variable, &proxy.url)
                .env("NO_PROXY", if bypass { hostname } else { "" })
                .output(),
        )
        .await
        .unwrap()
        .unwrap();
        server.abort();
        assert!(
            output.status.success(),
            "{scheme} {variable} auth={auth} bypass={bypass}: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            records
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r["method"] == "tools/call")
                .count(),
            1
        );
        assert_eq!(proxy.hits() == 0, bypass);
    }
}

#[tokio::test]
async fn mcp_http_transport_supports_tls_proxies_and_tunnels() {
    // 独立客户端显式信任测试证书；不向宿主系统信任库安装 fixture CA。
    if let Ok(endpoint) = std::env::var("AREAL_TEST_TLS_ENDPOINT") {
        let client = reqwest_mcp::Client::builder()
            .tls_certs_only([reqwest_mcp::Certificate::from_pem(proxy::CERT).unwrap()])
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap();
        let response = client.get(endpoint).send().await.unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.text().await.unwrap(), "proxy works");
        return;
    }
    for (scheme, secure) in [
        ("http", true),
        ("https", false),
        ("https", true),
        ("socks5h", true),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let proxy = proxy::Proxy::start(scheme, address, "mcp.invalid", true).await;
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut stream: proxy::Stream = if secure {
                Box::new(proxy::tls().accept(socket).await.unwrap())
            } else {
                Box::new(socket)
            };
            let request = proxy::headers(&mut *stream).await;
            assert!(!request.to_ascii_lowercase().contains("proxy-authorization"));
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\nproxy works").await.unwrap();
            stream.shutdown().await.unwrap();
        });
        let output = timeout(
            Duration::from_secs(20),
            proxy::child("mcp_http_transport_supports_tls_proxies_and_tunnels")
                .env(
                    "AREAL_TEST_TLS_ENDPOINT",
                    format!(
                        "{}://mcp.invalid:{}/test",
                        if secure { "https" } else { "http" },
                        address.port()
                    ),
                )
                .env(
                    if secure { "HTTPS_PROXY" } else { "HTTP_PROXY" },
                    &proxy.url,
                )
                .env("SSL_CERT_FILE", proxy::CERT_PATH)
                .output(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(
            output.status.success(),
            "{scheme} tls={secure}: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(proxy.hits(), 1);
    }
}
