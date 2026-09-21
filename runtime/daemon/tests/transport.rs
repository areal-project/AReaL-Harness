use areal_runtime_protocol::*;
use areal_runtime_supervisor::{
    Config,
    backend::{Backend, Event, Execution},
};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct NoExecution;
#[async_trait]
impl Backend for NoExecution {
    async fn start(&self, _: Execution) -> Result<mpsc::Receiver<Event>> {
        panic!("invalid request reached executor");
    }
    async fn terminate(&self, _: &str) -> Result<()> {
        Ok(())
    }
    async fn shutdown(&self) -> Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn private_transport_requires_handshake_and_rejects_unadvertised_privileges() {
    let dir = tempfile::tempdir().unwrap();
    let host =
        RuntimeHost::with_backend(Config::read_only(dir.path().into()), Arc::new(NoExecution))
            .await
            .unwrap();
    let runtime = host.supervisor();
    let root = runtime.connection_info().root_scope_id;
    let epoch = runtime.connection_info().runtime_epoch;
    let (client, server) = tokio::io::duplex(16 * 1024);
    let (read, write) = tokio::io::split(server);
    let service = tokio::spawn(areal_runtime::serve(
        read,
        write,
        host,
        CancellationToken::new(),
    ));
    let (read, mut write) = tokio::io::split(client);
    let mut read = BufReader::new(read).lines();
    let cases = [
        (
            json!({"id":1,"method":"scope.get","params":{"scopeId":root}}),
            Some("UNAUTHENTICATED"),
        ),
        (
            json!({"id":2,"method":"connection.open","params":{"protocolVersion":"invalid"}}),
            Some("UNSUPPORTED"),
        ),
        (
            json!({"id":3,"method":"connection.open","params":{"protocolVersion":VERSION}}),
            None,
        ),
        (
            json!({"id":4,"method":"process.start","params":{"operationId":format!("{epoch}:op:{}",uuid::Uuid::new_v4()),
            "scopeId":root,"argv":["/usr/bin/true"],"cwd":"workspace://repo","sandbox":null}}),
            Some("INVALID_ARGUMENT"),
        ),
        (
            json!({"id":5,"method":"fs.write","params":{}}),
            Some("UNSUPPORTED"),
        ),
        (
            json!({"id":6,"method":"connection.close","params":{}}),
            None,
        ),
    ];
    for (request, expected) in cases {
        write
            .write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        let line = tokio::time::timeout(Duration::from_secs(3), read.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let response: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(response["id"], request["id"]);
        assert_eq!(
            response.get("error").map(|e| e["code"].as_str().unwrap()),
            expected
        );
    }
    service.await.unwrap().unwrap();
    assert_eq!(runtime.scope(&root).unwrap().state, ScopeState::Closed);
}

#[tokio::test]
async fn a_client_that_never_reads_cannot_leave_the_response_writer_running() {
    let dir = tempfile::tempdir().unwrap();
    let host =
        RuntimeHost::with_backend(Config::read_only(dir.path().into()), Arc::new(NoExecution))
            .await
            .unwrap();
    let runtime = host.supervisor();
    let root = runtime.connection_info().root_scope_id;
    let (mut client, server) = tokio::io::duplex(32);
    let (read, write) = tokio::io::split(server);
    let service = tokio::spawn(areal_runtime::serve(
        read,
        write,
        host,
        CancellationToken::new(),
    ));
    let flood = tokio::spawn(async move {
        for id in 0..100 {
            if client
                .write_all(
                    format!("{}\n", json!({"id":id,"method":"scope.get","params":{}})).as_bytes(),
                )
                .await
                .is_err()
            {
                break;
            }
        }
        // 保持客户端存活，避免把 EOF 当成慢消费者问题的解决方式。
        tokio::time::sleep(Duration::from_secs(10)).await;
    });
    let result = tokio::time::timeout(Duration::from_secs(4), service)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.unwrap_err().code, ErrorCode::Unavailable);
    assert_eq!(runtime.scope(&root).unwrap().state, ScopeState::Closed);
    flood.abort();
    let _ = flood.await;
}
use areal_runtime::components::RuntimeHost;
