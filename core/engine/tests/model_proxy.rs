use areal_engine::model::{HttpModel, Message, Model, ModelEvent, ModelProtocol};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::time::Duration;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    time::timeout,
};

#[path = "../../../tests/support/proxy.rs"]
mod proxy;

#[tokio::test]
async fn model_requests_use_proxy_environment() {
    // 环境变量只注入子进程，避免不同代理用例污染并行测试。
    if let Ok(endpoint) = std::env::var("AREAL_TEST_PROXY_ENDPOINT") {
        let protocol = if endpoint.ends_with("/responses") {
            ModelProtocol::Responses
        } else {
            ModelProtocol::ChatCompletions
        };
        let model = HttpModel::with_protocol(endpoint, "fixture".into(), None, protocol).unwrap();
        let events = timeout(Duration::from_secs(10), async {
            model
                .chat(vec![Message::text("user", "hello")], vec![])
                .await
                .unwrap()
                .collect::<Vec<_>>()
                .await
        })
        .await
        .expect("model request timed out");
        let events = events.into_iter().collect::<Result<Vec<_>, _>>().unwrap();
        assert!(
            events
                .iter()
                .any(|event| matches!(event, ModelEvent::TextDelta(text) if text == "proxy works"))
        );
        assert!(events.iter().any(|event| matches!(event, ModelEvent::Usage(usage) if usage.input_tokens == 3 && usage.output_tokens == 2)));
        return;
    }
    for (scheme, variable, path, authenticated, secure, bypass) in [
        (
            "http",
            "HTTP_PROXY",
            "chat/completions",
            false,
            false,
            false,
        ),
        ("http", "HTTPS_PROXY", "responses", true, true, false),
        (
            "https",
            "HTTPS_PROXY",
            "chat/completions",
            true,
            true,
            false,
        ),
        ("https", "ALL_PROXY", "responses", false, false, false),
        (
            "socks5h",
            "ALL_PROXY",
            "chat/completions",
            false,
            false,
            false,
        ),
        ("socks5h", "all_proxy", "responses", false, false, false),
        (
            "socks5",
            "HTTP_PROXY",
            "chat/completions",
            false,
            false,
            false,
        ),
        ("socks5h", "http_proxy", "responses", true, false, false),
        (
            "socks5h",
            "https_proxy",
            "chat/completions",
            true,
            true,
            false,
        ),
        (
            "socks5h",
            "ALL_PROXY",
            "chat/completions",
            false,
            false,
            true,
        ),
    ] {
        let origin = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = origin.local_addr().unwrap();
        let hostname = if bypass {
            "127.0.0.1"
        } else if scheme == "socks5" {
            "localhost"
        } else {
            "model.invalid"
        };
        let proxy = proxy::Proxy::start(scheme, address, hostname, authenticated).await;
        let endpoint = format!(
            "{}://{hostname}:{}/v1/{path}",
            if secure { "https" } else { "http" },
            address.port()
        );
        let server = tokio::spawn(async move {
            let (socket, _) = origin.accept().await.unwrap();
            let mut stream: proxy::Stream = if secure {
                Box::new(proxy::tls().accept(socket).await.unwrap())
            } else {
                Box::new(socket)
            };
            serve_model(&mut stream, path).await;
        });
        let output = timeout(
            Duration::from_secs(20),
            proxy::child("model_requests_use_proxy_environment")
                .env("AREAL_TEST_PROXY_ENDPOINT", endpoint)
                .env(variable, &proxy.url)
                .env("no_proxy", if bypass { hostname } else { "" })
                .env("SSL_CERT_FILE", proxy::CERT_PATH)
                .output(),
        )
        .await
        .expect("proxy client timed out")
        .unwrap();
        assert!(
            output.status.success(),
            "{scheme} {variable} {path} auth={authenticated} tls={secure} bypass={bypass}: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        timeout(Duration::from_secs(5), server)
            .await
            .expect("model fixture timed out")
            .unwrap();
        assert_eq!(proxy.hits(), usize::from(!bypass));
    }
}

async fn serve_model(stream: &mut proxy::Stream, path: &str) {
    let mut reader = BufReader::new(&mut *stream);
    let mut line = String::new();
    reader.read_line(&mut line).await.unwrap();
    assert!(
        line.starts_with("POST ") && line.ends_with(&format!("/v1/{path} HTTP/1.1\r\n")),
        "{line}"
    );
    let mut length = None;
    loop {
        line.clear();
        assert!(reader.read_line(&mut line).await.unwrap() > 0);
        if line == "\r\n" {
            break;
        }
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            length = Some(value.trim().parse::<usize>().unwrap());
        }
    }
    let mut body = vec![0; length.unwrap()];
    reader.read_exact(&mut body).await.unwrap();
    let request: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(request["model"], "fixture");
    assert_eq!(request["stream"], true);
    let events = if path == "responses" {
        vec![
            json!({"type":"response.output_text.delta","delta":"proxy works"}),
            json!({"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":2}}}),
        ]
    } else {
        vec![
            json!({"choices":[{"index":0,"delta":{"content":"proxy works"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}),
        ]
    };
    let body = events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect::<String>()
        + "data: [DONE]\n\n";
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).await.unwrap();
    stream.shutdown().await.unwrap();
}
