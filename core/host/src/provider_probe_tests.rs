use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
async fn response(content_type: &str, body: Vec<u8>) -> reqwest::Response {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let content_type = content_type.to_owned();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        let _ = stream.read(&mut request).await;
        stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).as_bytes()).await.unwrap();
        let _ = stream.write_all(&body).await;
    });
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(endpoint)
        .send()
        .await
        .unwrap()
}
#[tokio::test]
async fn probe_requires_complete_nonempty_text_for_both_protocols() {
    for (protocol, payload, success) in [
        (
            "chat-completions",
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"完成\"},\"finish_reason\":\"stop\"}]}\r\n\r\n",
            true,
        ),
        (
            "responses",
            "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"content\":[{\"type\":\"output_text\",\"text\":\"OK\"}]}]}}\n\n",
            true,
        ),
        (
            "responses",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"OK\"}\n\n",
            false,
        ),
        (
            "responses",
            "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"incomplete\"}}\n\n",
            false,
        ),
        (
            "chat-completions",
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"OK\"},\"finish_reason\":\"length\"}]}\n\n",
            false,
        ),
        (
            "chat-completions",
            "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            false,
        ),
        ("chat-completions", "data: [DONE]\n\n", false),
        (
            "responses",
            "data: {\"type\":\"response.failed\",\"error\":\"private-key-echo\"}\n\n",
            false,
        ),
        ("responses", "data: invalid json\n\n", false),
    ] {
        let result = probe(
            response(
                "text/event-stream; charset=utf-8",
                payload.as_bytes().to_vec(),
            )
            .await,
            protocol,
        )
        .await;
        assert_eq!(result.is_ok(), success, "{protocol} {payload}");
        if let Err(error) = result {
            assert!(!error.to_string().contains("private-key-echo"));
        }
    }
}
#[tokio::test]
async fn probe_rejects_wrong_content_type_invalid_utf8_and_unbounded_bodies() {
    for (content_type, payload) in [
        ("application/json", b"{}".to_vec()),
        (
            "text/event-stream",
            vec![b'd', b'a', b't', b'a', b':', 255, b'\n', b'\n'],
        ),
        ("text/event-stream", vec![b' '; 1_048_577]),
    ] {
        assert!(
            probe(response(content_type, payload).await, "responses")
                .await
                .is_err()
        );
    }
}
