//! 模型漏读原命令时，Turn 收尾仍保存 Runtime 的真实终态，重启后不重放。
use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelEvent, ModelFailure, ModelStream, ToolCall},
    tools::RuntimeConfig,
};
use areal_protocol::{Input, Item, ProcessReceiptState, TurnStatus};
use areal_runtime_client::Client;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{Mutex, Notify},
};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Ending {
    Complete,
    ModelError,
    Interrupt,
}

struct EarlyFinish {
    calls: AtomicUsize,
    ending: Ending,
    waiting: Notify,
}

#[async_trait]
impl Model for EarlyFinish {
    fn name(&self) -> &str {
        "early-finish-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, _: Vec<Message>, _: Vec<Value>) -> anyhow::Result<ModelStream> {
        let event = if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            ModelEvent::ToolCall(ToolCall {
                id: "original-call".into(),
                name: "run_command".into(),
                arguments: json!({"argv":["/bin/true"],"yieldMs":0}).to_string(),
            })
        } else {
            self.waiting.notify_one();
            if self.ending == Ending::ModelError {
                return Err(ModelFailure::ResponseTimeout.into());
            }
            if self.ending == Ending::Interrupt {
                return futures_util::future::pending().await;
            }
            ModelEvent::text("Finished without polling the command")
        };
        Ok(Box::pin(futures_util::stream::iter([Ok(event)])))
    }
}

#[tokio::test]
async fn pending_commands_are_settled_from_original_runtime_and_survive_restart() {
    for outcome in [
        "success",
        "failure",
        "signal",
        "unknown",
        "lost",
        "wrong_scope",
    ] {
        assert_settlement(outcome, Ending::Complete).await;
    }
}

#[tokio::test]
async fn unknown_process_receipts_preserve_the_original_model_error() {
    assert_settlement("unknown", Ending::ModelError).await;
}

#[tokio::test]
async fn cancellation_retains_known_exit_and_rejects_unknown_outcome() {
    assert_settlement("signal", Ending::Interrupt).await;
    assert_settlement("unknown", Ending::Interrupt).await;
}

#[tokio::test]
async fn incomplete_or_mismatched_receipts_cannot_complete_a_turn() {
    for outcome in [
        "wrong_process",
        "missing_outcome",
        "conflicting_outcomes",
        "unconfirmed_cleanup",
    ] {
        assert_settlement(outcome, Ending::Complete).await;
    }
}

#[tokio::test]
async fn process_observation_does_not_hide_scope_cleanup_failure() {
    assert_settlement("cleanup_failure", Ending::Complete).await;
}

#[tokio::test]
async fn observed_terminal_is_not_queried_again_or_marked_output_complete() {
    assert_settlement("observed", Ending::Complete).await;
}

async fn assert_settlement(outcome: &'static str, ending: Ending) {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let log = Arc::new(Mutex::new(Vec::new()));
    let requests = log.clone();
    let (pipe, peer) = tokio::io::duplex(256 * 1024);
    let (read, write) = tokio::io::split(pipe);
    let (peer_read, mut peer_write) = tokio::io::split(peer);
    let fixture = tokio::spawn(async move {
        let mut lines = BufReader::new(peer_read).lines();
        let epoch = uuid::Uuid::new_v4().to_string();
        let scope = format!("{epoch}:scope:{}", uuid::Uuid::new_v4());
        let process = format!("{epoch}:process:{}", uuid::Uuid::new_v4());
        let mut closed = false;
        while let Some(line) = lines.next_line().await.unwrap() {
            let request: Value = serde_json::from_str(&line).unwrap();
            let method = request["method"].as_str().unwrap();
            requests.lock().await.push(request.clone());
            if method == "scope.revoke" && outcome == "cleanup_failure" {
                peer_write
                    .write_all(
                        format!(
                            "{}\n",
                            json!({"id":request["id"],"error":{
                                "code":"UNAVAILABLE","message":"fixture cleanup failure"}})
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                continue;
            }
            let value = match method {
                "connection.open" => {
                    json!({"protocolVersion":"areal.runtime.v0","runtimeEpoch":epoch,
                        "connectionId":"fixture","rootScopeId":scope,"capabilities":{"methods":["scope.check","fs.execute"]}})
                }
                "scope.check" => json!({"available":true}),
                "scope.create" | "scope.get" | "scope.revoke" | "scope.waitClosed" => {
                    closed |= method == "scope.waitClosed";
                    json!({"scopeId":scope,"parentScopeId":null,"state":if closed {"closed"} else {"active"},
                            "owner":{"taskId":"fixture"},"readRoots":["workspace://repo"],"writeRoots":["workspace://repo"],
                            "network":"deny","limits":{"wallTimeMs":30000,"outputBytes":8388608,"maxProcesses":4},
                            "activeProcesses":0,"outputBytes":0,"cleanupError":null})
                }
                "process.start" => json!({"processId":process,"scopeId":scope}),
                "output.read" => json!({"chunks":[],"nextCursor":format!("{process}/0"),
                        "closed":false,"gap":false,"truncated":false}),
                "process.get" => {
                    assert_eq!(request["params"]["processId"], process);
                    if closed && outcome == "lost" {
                        peer_write
                            .write_all(
                                format!(
                                    "{}\n",
                                    json!({"id":request["id"],"error":{
                                "code":"UNAVAILABLE","message":"original Runtime receipt lost"}})
                                )
                                .as_bytes(),
                            )
                            .await
                            .unwrap();
                        continue;
                    }
                    json!({"processId":if closed && outcome == "wrong_process" {"different"} else {&process},
                            "scopeId":if closed && outcome == "wrong_scope" {"different"} else {&scope},
                            "state":if !closed && outcome != "observed" {"running"} else if outcome == "unknown" {"unknown"} else {"exited"},
                            "exitCode":if outcome == "observed" || (closed && matches!(outcome,"success"|"failure"|"wrong_scope"|"wrong_process"|"conflicting_outcomes"|"unconfirmed_cleanup")) {Some(if outcome=="failure" {7} else {0})} else {None},
                            "signal":if closed && matches!(outcome, "signal" | "conflicting_outcomes") {Some("15")} else {None},
                            "stopReason":if closed && outcome=="signal" {Some("scope closed")} else {None},
                            "sandboxDenied":false,"cleanupError":null,
                            "cleanupConfirmed":(closed || outcome == "observed") && outcome != "unconfirmed_cleanup"})
                }
                "connection.close" => json!({"closed":true}),
                _ => panic!("unexpected Runtime method {method}"),
            };
            peer_write
                .write_all(format!("{}\n", json!({"id":request["id"],"result":value})).as_bytes())
                .await
                .unwrap();
            if method == "connection.close" {
                break;
            }
        }
    });
    let client = Client::connect(read, write).await.unwrap();
    let model = Arc::new(EarlyFinish {
        calls: AtomicUsize::new(0),
        ending,
        waiting: Notify::new(),
    });
    let data = dir.path().join("data");
    let engine = Engine::open_with_runtime(
        &data,
        model.clone(),
        Limits {
            watchdog_disable: true,
            max_completion_retries: 0,
            ..Limits::default()
        },
        RuntimeConfig {
            client: client.clone(),
            workspace: workspace.clone(),
            writable: true,
            command_scope: None,
            command_scratch: None,
        },
    )
    .unwrap();
    let thread = engine
        .create(workspace.to_string_lossy().into_owned())
        .await
        .unwrap();
    let started = engine
        .start(&thread.id, vec![Input::text("Run the selected command")])
        .await
        .unwrap();
    if ending == Ending::Interrupt {
        tokio::time::timeout(Duration::from_secs(10), model.waiting.notified())
            .await
            .unwrap();
        engine.interrupt(&thread.id, &started.id).await.unwrap();
    }
    let done = tokio::time::timeout(Duration::from_secs(10), engine.wait(&thread.id))
        .await
        .unwrap()
        .unwrap();
    let turn = &done.turns[0];
    let known = matches!(outcome, "success" | "failure" | "signal" | "observed");
    assert_eq!(
        turn.status,
        if known && ending == Ending::Complete {
            TurnStatus::Completed
        } else if known && ending == Ending::Interrupt {
            TurnStatus::Interrupted
        } else {
            TurnStatus::Failed
        },
        "{outcome}: {:?}",
        turn.error
    );
    if ending == Ending::ModelError {
        let error = turn.error.as_ref().unwrap();
        assert_eq!(error.message, "model response timeout");
        assert_eq!(error.outcome.as_ref().unwrap().code, "LLM_RESPONSE_TIMEOUT");
    }
    if outcome == "cleanup_failure" {
        assert!(matches!(
            done.status,
            areal_protocol::ThreadStatus::SystemError
        ));
        assert!(
            turn.error
                .as_ref()
                .unwrap()
                .message
                .starts_with("Runtime scope cleanup failed:")
        );
    }
    assert_eq!(
        turn.process_receipts.len(),
        usize::from(outcome != "observed"),
        "{outcome}"
    );
    if let Some(receipt) = turn.process_receipts.first() {
        assert_eq!(matches!(receipt.state, ProcessReceiptState::Exited), known);
        assert_eq!(
            receipt.exit_code,
            match outcome {
                "success" | "conflicting_outcomes" | "unconfirmed_cleanup" => Some(0),
                "failure" => Some(7),
                _ => None,
            }
        );
        assert_eq!(
            receipt.signal.as_deref(),
            matches!(outcome, "signal" | "conflicting_outcomes").then_some("15")
        );
        assert_eq!(receipt.error.is_none(), known);
    }
    let original = turn
        .items
        .iter()
        .find_map(|item| match item {
            Item::DynamicToolCall {
                tool,
                content_items: Some(blocks),
                ..
            } if tool == "run_command" => blocks
                .iter()
                .find_map(|block| serde_json::from_str::<Value>(block["text"].as_str()?).ok()),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        original["state"],
        if outcome == "observed" {
            "exited"
        } else {
            "running"
        }
    );
    assert_eq!(original["outputReadComplete"], false);
    if let Some(receipt) = turn.process_receipts.first() {
        assert_eq!(original["processId"], receipt.process_id);
    }
    let frozen = serde_json::to_value(&turn.process_receipts).unwrap();
    let frozen_error = serde_json::to_value(&turn.error).unwrap();
    engine.shutdown().await;
    drop(engine);
    let restored = Engine::open(&data, model.clone(), Limits::default()).unwrap();
    let loaded = restored.read(&thread.id, true).await.unwrap();
    assert_eq!(
        serde_json::to_value(&loaded.turns[0].process_receipts).unwrap(),
        frozen
    );
    assert_eq!(
        serde_json::to_value(&loaded.turns[0].error).unwrap(),
        frozen_error
    );
    assert_eq!(model.calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        log.lock()
            .await
            .iter()
            .filter(|v| v["method"] == "process.start")
            .count(),
        1
    );
    let requests = log.lock().await;
    let cleanup = requests
        .iter()
        .position(|v| v["method"] == "scope.revoke")
        .unwrap();
    assert_eq!(
        requests[cleanup + 1..]
            .iter()
            .filter(|v| v["method"] == "process.get")
            .count(),
        usize::from(outcome != "observed")
    );
    drop(requests);
    restored.shutdown().await;
    client.shutdown().await.unwrap();
    fixture.await.unwrap();
}
