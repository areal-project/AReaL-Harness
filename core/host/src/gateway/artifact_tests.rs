use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn png() -> Vec<u8> {
    STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aKsAAAAASUVORK5CYII=").unwrap()
}

fn thread(bytes: &[u8]) -> Value {
    json!({"thread":{"id":"thread","turns":[{"id":"turn","items":[{"id":"item","type":"agentMedia","media":{"uri":format!("areal://blob/{:x}", Sha256::digest(bytes)),"mimeType":"image/png","sizeBytes":bytes.len()}}]}]}})
}

async fn start(
    f: &mut Fixture,
    listener: &TcpListener,
    bytes: &[u8],
) -> tokio::task::JoinHandle<Result<Value>> {
    f.grant("a", |grant| {
        grant["capabilities"] = json!(["observe", "review"])
    });
    let session = f.session("a");
    let original = thread(bytes);
    let reference = session
        .review_artifacts(
            &f.alias,
            "core-generation",
            &original["thread"],
            &original["thread"]["turns"][0],
            None,
            0,
        )
        .unwrap()[0]["artifactRef"]
        .clone();
    f.host
        .slots
        .borrow_mut()
        .get_mut("project")
        .unwrap()
        .service
        .as_mut()
        .unwrap()
        .endpoint = format!("ws://{}/", listener.local_addr().unwrap());
    let project = f.alias.clone();
    let task = tokio::task::spawn_local(async move {
        session
            .artifact(
                &project,
                "core-generation",
                &json!({"artifactRef":reference,"offset":0,"length":49152}),
            )
            .await
    });
    f.call("thread/read").await.reply(original);
    task
}

async fn accept(listener: &TcpListener) -> tokio::net::TcpStream {
    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let request = tokio::time::timeout(Duration::from_secs(5), async {
        let mut request = Vec::new();
        loop {
            let mut byte = [0];
            socket.read_exact(&mut byte).await.unwrap();
            request.push(byte[0]);
            assert!(request.len() <= 8192);
            if request.ends_with(b"\r\n\r\n") {
                break request;
            }
        }
    })
    .await
    .unwrap();
    let request = String::from_utf8(request).unwrap();
    assert!(request.starts_with("GET /areal/blobs/"));
    assert!(request.contains("threadId=thread"));
    assert!(
        request
            .to_ascii_lowercase()
            .contains("authorization: bearer original-owner-token\r\n")
    );
    socket
}

#[tokio::test(flavor = "current_thread")]
async fn http_faults_reject_unavailable_artifacts_and_cancel_oversize_stream() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for fault in ["404", "short", "length", "oversize"] {
                let mut f = Fixture::new().await;
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let bytes = png();
                let task = start(&mut f, &listener, &bytes).await;
                let mut socket = accept(&listener).await;
                match fault {
                    "404" => socket
                        .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                        .await
                        .unwrap(),
                    "short" => {
                        socket
                            .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
                            .await
                            .unwrap();
                        socket
                            .write_all(format!("{:x}\r\n", bytes.len() - 1).as_bytes())
                            .await
                            .unwrap();
                        socket.write_all(&bytes[..bytes.len() - 1]).await.unwrap();
                        socket.write_all(b"\r\n0\r\n\r\n").await.unwrap();
                    }
                    "length" => socket
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 9999\r\n\r\n")
                        .await
                        .unwrap(),
                    _ => {
                        socket
                            .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
                            .await
                            .unwrap();
                        socket
                            .write_all(format!("{:x}\r\n", bytes.len() + 1).as_bytes())
                            .await
                            .unwrap();
                        socket.write_all(&vec![0; bytes.len() + 1]).await.unwrap();
                        socket.write_all(b"\r\n").await.unwrap();
                    }
                }
                let result = tokio::time::timeout(Duration::from_secs(5), task)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(
                    result.unwrap_err().to_string(),
                    "RESOURCE_UNAVAILABLE",
                    "{fault}"
                );
                if fault == "oversize" {
                    let mut byte = [0];
                    assert_eq!(
                        tokio::time::timeout(Duration::from_secs(5), socket.read(&mut byte))
                            .await
                            .unwrap()
                            .unwrap(),
                        0
                    );
                }
            }
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn grant_change_while_http_response_is_pending_prevents_artifact_delivery() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let mut f = Fixture::new().await;
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let bytes = png();
            let task = start(&mut f, &listener, &bytes).await;
            let mut socket = accept(&listener).await;
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
                .await
                .unwrap();
            f.grant("a", |grant| grant["revision"] = json!(2));
            socket.write_all(b"5\r\nhello\r\n").await.unwrap();
            let result = tokio::time::timeout(Duration::from_secs(5), task)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(result.unwrap_err().to_string(), "GRANT_CHANGED");
            let mut byte = [0];
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(5), socket.read(&mut byte))
                    .await
                    .unwrap()
                    .unwrap(),
                0
            );
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn removed_media_after_http_read_prevents_artifact_delivery() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for removed in [false, true] {
                let mut f = Fixture::new().await;
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let bytes = png();
                let task = start(&mut f, &listener, &bytes).await;
                let mut socket = accept(&listener).await;
                socket
                    .write_all(
                        format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", bytes.len())
                            .as_bytes(),
                    )
                    .await
                    .unwrap();
                socket.write_all(&bytes).await.unwrap();
                let mut current = thread(&bytes);
                if removed {
                    current["thread"]["turns"][0]["items"] = json!([]);
                }
                f.call("thread/read").await.reply(current);
                let result = tokio::time::timeout(Duration::from_secs(5), task)
                    .await
                    .unwrap()
                    .unwrap();
                if removed {
                    assert_eq!(result.unwrap_err().to_string(), "RESOURCE_UNAVAILABLE");
                } else {
                    let result = result.unwrap();
                    assert_eq!(
                        STANDARD.decode(result["base64"].as_str().unwrap()).unwrap(),
                        bytes
                    );
                    assert_eq!(
                        result["raster"],
                        json!({"mime":"image/png","width":1,"height":1})
                    );
                }
            }
        })
        .await;
}
