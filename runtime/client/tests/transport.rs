use areal_runtime_client::Client;
use areal_runtime_protocol::{ErrorCode, VERSION};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

async fn fixture() -> (
    std::sync::Arc<Client>,
    mpsc::UnboundedReceiver<Value>,
    mpsc::UnboundedSender<Value>,
    tokio::task::JoinHandle<()>,
) {
    fixture_with_capabilities(json!({"methods":[]})).await
}

async fn fixture_with_capabilities(
    capabilities: Value,
) -> (
    std::sync::Arc<Client>,
    mpsc::UnboundedReceiver<Value>,
    mpsc::UnboundedSender<Value>,
    tokio::task::JoinHandle<()>,
) {
    let (local, peer) = tokio::io::duplex(256 * 1024);
    let (read, write) = tokio::io::split(local);
    let (peer_read, mut peer_write) = tokio::io::split(peer);
    let (seen, requests) = mpsc::unbounded_channel();
    let (reply, mut replies) = mpsc::unbounded_channel::<Value>();
    let task = tokio::spawn(async move {
        let mut lines = BufReader::new(peer_read).lines();
        loop {
            tokio::select! {
                line = lines.next_line() => {
                    let Some(line) = line.unwrap() else { break };
                    let request: Value = serde_json::from_str(&line).unwrap();
                    if request["method"] == "connection.open" {
                        peer_write.write_all(format!("{}\n",json!({"id":request["id"],"result":{"protocolVersion":VERSION,"runtimeEpoch":"fixture","connectionId":"connection","rootScopeId":"root","capabilities":capabilities}})).as_bytes()).await.unwrap();
                    } else { seen.send(request).unwrap(); }
                }
                reply = replies.recv() => {
                    let Some(reply) = reply else { break };
                    peer_write.write_all(format!("{reply}\n").as_bytes()).await.unwrap();
                }
            }
        }
    });
    (
        Client::connect(read, write).await.unwrap(),
        requests,
        reply,
        task,
    )
}

#[tokio::test(start_paused = true)]
async fn long_process_deadlines_do_not_extend_control_rpc_timeouts() {
    let (client, mut requests, replies, peer) = fixture_with_capabilities(
        json!({"processLimits":{"wallTimeMs":300000,"outputBytes":8192,"maxProcesses":4}}),
    )
    .await;
    let wait = {
        let client = client.clone();
        tokio::spawn(async move { client.call::<_, Value>("process.wait", json!({})).await })
    };
    let request = requests.recv().await.unwrap();
    tokio::time::advance(Duration::from_secs(120)).await;
    tokio::task::yield_now().await;
    assert!(
        !client.is_closed(),
        "a valid long command was fenced by the 90 second RPC timer"
    );
    replies
        .send(json!({"id":request["id"],"result":{}}))
        .unwrap();
    wait.await.unwrap().unwrap();
    let control = {
        let client = client.clone();
        tokio::spawn(async move { client.call::<_, Value>("scope.get", json!({})).await })
    };
    requests.recv().await.unwrap();
    tokio::time::advance(Duration::from_secs(13)).await;
    assert_eq!(
        control.await.unwrap().unwrap_err().code,
        ErrorCode::Unavailable
    );
    peer.await.unwrap();
}

#[tokio::test]
async fn unexpected_eof_fails_pending_operations_and_cannot_confirm_cleanup() {
    let (client, mut requests, replies, task) = fixture().await;
    let waiting = {
        let client = client.clone();
        tokio::spawn(async move {
            client
                .call::<_, Value>("process.wait", json!({"processId":"process"}))
                .await
        })
    };
    requests.recv().await.unwrap();
    drop(replies);
    task.await.unwrap();
    assert_eq!(
        waiting.await.unwrap().unwrap_err().code,
        ErrorCode::Unavailable
    );
    assert!(client.is_closed());
    assert_eq!(
        client.shutdown().await.unwrap_err().code,
        ErrorCode::Unavailable
    );
    assert_eq!(
        client.shutdown().await.unwrap_err().code,
        ErrorCode::Unavailable
    );
}

#[tokio::test]
async fn cancelled_shutdown_waiter_preserves_one_owned_close_and_its_acknowledgement() {
    let (client, mut requests, replies, task) = fixture().await;
    let closing = {
        let client = client.clone();
        tokio::spawn(async move { client.shutdown().await })
    };
    let close = requests.recv().await.unwrap();
    assert_eq!(close["method"], "connection.close");
    closing.abort();
    let _ = closing.await;
    replies
        .send(json!({"id":close["id"],"result":{"closed":true}}))
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), client.shutdown())
        .await
        .unwrap()
        .unwrap();
    client.shutdown().await.unwrap();
    task.await.unwrap();
    assert!(requests.try_recv().is_err());
}

#[tokio::test]
async fn cancelled_rpc_waiters_keep_correlation_and_reserved_control_capacity() {
    let (client, mut requests, replies, task) = fixture().await;
    for _ in 0..112 {
        let client = client.clone();
        let (sent, ready) = oneshot::channel();
        let waiting = tokio::spawn(async move {
            let _ = sent.send(());
            client.call::<_, Value>("process.wait", json!({})).await
        });
        ready.await.unwrap();
        requests.recv().await.unwrap();
        waiting.abort();
        let _ = waiting.await;
    }
    assert_eq!(
        client
            .call::<_, Value>("process.wait", json!({}))
            .await
            .unwrap_err()
            .code,
        ErrorCode::ResourceExhausted
    );
    let control = {
        let client = client.clone();
        tokio::spawn(async move { client.call::<_, Value>("scope.revoke", json!({})).await })
    };
    let request = requests.recv().await.unwrap();
    assert_eq!(request["method"], "scope.revoke");
    replies
        .send(json!({"id":request["id"],"result":{}}))
        .unwrap();
    control.await.unwrap().unwrap();
    let closing = {
        let client = client.clone();
        tokio::spawn(async move { client.shutdown().await })
    };
    let request = requests.recv().await.unwrap();
    replies
        .send(json!({"id":request["id"],"result":{"closed":true}}))
        .unwrap();
    closing.await.unwrap().unwrap();
    task.await.unwrap();
}

#[tokio::test]
async fn malformed_cleanup_acknowledgement_is_not_success() {
    let (client, mut requests, replies, task) = fixture().await;
    let closing = {
        let client = client.clone();
        tokio::spawn(async move { client.shutdown().await })
    };
    let request = requests.recv().await.unwrap();
    replies
        .send(json!({"id":request["id"],"result":{}}))
        .unwrap();
    assert_eq!(
        closing.await.unwrap().unwrap_err().code,
        ErrorCode::Unavailable
    );
    task.await.unwrap();
}
