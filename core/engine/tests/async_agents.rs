use areal_engine::{
    Engine, Limits,
    model::{AgentStream, Message, Model, ModelEvent, ModelStream, ToolCall},
    tools::{AgentToolsConfig, RuntimeConfig, ToolExtensions},
};
use areal_protocol::{Input, Item, TurnStatus};
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
    sync::Notify,
};

struct AsyncModel {
    step: AtomicUsize,
    worker_started: Notify,
    release: Arc<Notify>,
    cancel: bool,
    batch: usize,
    finish_early: bool,
}
fn call(name: &str, args: Value) -> ModelEvent {
    ModelEvent::ToolCall(ToolCall {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.into(),
        arguments: args.to_string(),
    })
}
#[async_trait]
impl Model for AsyncModel {
    fn name(&self) -> &str {
        "async-research-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<AgentStream> {
        let worker = messages
            .iter()
            .any(|m| m.role == "user" && m.text_content() == "CHILD_WAIT");
        if worker {
            assert!(
                !tools
                    .iter()
                    .any(|t| t["function"]["name"] == "delegate_tasks")
            );
            self.worker_started.notify_one();
            let release = self.release.clone();
            return Ok(Box::pin(futures_util::stream::unfold(0, move |step| {
                let release = release.clone();
                async move {
                    match step {
                        0 => Some((
                            Ok(ModelEvent::text("Partial observation; check still pending")),
                            1,
                        )),
                        1 => {
                            release.notified().await;
                            Some((Ok(ModelEvent::text("; confirmed final finding")), 2))
                        }
                        _ => None,
                    }
                }
            })));
        }
        assert!(tools.iter().any(|t| t["function"]["name"] == "read_agent"));
        let step = self.step.fetch_add(1, Ordering::SeqCst);
        let prior: Option<Value> = messages
            .iter()
            .rev()
            .find(|m| m.role == "tool")
            .map(|m| serde_json::from_str(&m.text_content()).unwrap());
        let event = match step {
            0 => call(
                "delegate_tasks",
                json!({"tasks":vec![json!({"prompt":"CHILD_WAIT"});self.batch]}),
            ),
            1 => {
                // Parent is making its next model request while child inference
                // is pending. A synchronous delegate call cannot reach here.
                tokio::time::timeout(Duration::from_secs(2), self.worker_started.notified())
                    .await
                    .unwrap();
                let p = prior.unwrap();
                assert_eq!(p["asynchronous"], true);
                assert_eq!(p["started"], 1);
                assert_eq!(p["rejected"].as_array().unwrap().len(), self.batch - 1);
                if self.finish_early {
                    return Ok(Box::pin(futures_util::stream::iter([Ok(
                        ModelEvent::text(
                            "Independent answer ready; remaining research unnecessary",
                        ),
                    )])));
                }
                call(
                    "read_agent",
                    json!({"threadId":p["reports"][0]["threadId"],"waitMs":1}),
                )
            }
            2 => {
                let p = prior.unwrap();
                assert_eq!(p["status"], "inProgress");
                assert_ne!(p["reportKind"], "final");
                if self.cancel {
                    call("cancel_agent", json!({"threadId":p["threadId"]}))
                } else {
                    self.release.notify_one();
                    call(
                        "read_agent",
                        json!({"threadId":p["threadId"],"waitMs":1000}),
                    )
                }
            }
            3 => {
                let p = prior.unwrap();
                assert_eq!(
                    p["status"],
                    if self.cancel {
                        "interrupted"
                    } else {
                        "completed"
                    }
                );
                assert_eq!(
                    p["reportKind"],
                    if self.cancel { "partial" } else { "final" }
                );
                call("task_state", json!({}))
            }
            4 => {
                let p = prior.unwrap();
                assert_eq!(p["agentCount"], 1);
                ModelEvent::text("parent finished independent work")
            }
            _ => panic!("unexpected request"),
        };
        Ok(Box::pin(futures_util::stream::iter([Ok(event)])))
    }
}

async fn runtime() -> (Arc<Client>, tokio::task::JoinHandle<()>) {
    let (pipe, peer) = tokio::io::duplex(65536);
    let (read, write) = tokio::io::split(pipe);
    let (r, mut w) = tokio::io::split(peer);
    let task = tokio::spawn(async move {
        let epoch = uuid::Uuid::new_v4().to_string();
        let root = format!("{epoch}:scope:{}", uuid::Uuid::new_v4());
        let mut lines = BufReader::new(r).lines();
        while let Some(line) = lines.next_line().await.unwrap() {
            let req: Value = serde_json::from_str(&line).unwrap();
            let method = req["method"].as_str().unwrap();
            let result = match method {
                "connection.open" => {
                    json!({"protocolVersion":"areal.runtime.v0","runtimeEpoch":epoch,"connectionId":"fixture","rootScopeId":root,"capabilities":{"methods":["fs.execute"]}})
                }
                "scope.create" | "scope.revoke" | "scope.waitClosed" => {
                    json!({"scopeId":root,"parentScopeId":null,"state":if method=="scope.waitClosed" {"closed"}else{"active"},"owner":{"taskId":"fixture"},"readRoots":["workspace://repo"],"writeRoots":["workspace://repo"],"network":"deny","limits":{"wallTimeMs":10000,"outputBytes":8388608,"maxProcesses":4},"activeProcesses":0,"outputBytes":0,"cleanupError":null})
                }
                "connection.close" => json!({"closed":true}),
                _ => panic!("unexpected {method}"),
            };
            w.write_all(format!("{}\n", json!({"id":req["id"],"result":result})).as_bytes())
                .await
                .unwrap();
            if method == "connection.close" {
                break;
            }
        }
    });
    (Client::connect(read, write).await.unwrap(), task)
}

#[tokio::test]
async fn parent_progresses_during_child_inference_and_can_read_or_cancel_owned_work() {
    for (cancel, batch, finish_early) in [
        (false, 1, false),
        (true, 1, false),
        (false, 2, false),
        (false, 1, true),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("repo");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::create_dir(temp.path().join("scratch")).unwrap();
        let (client, peer) = runtime().await;
        let model = Arc::new(AsyncModel {
            step: AtomicUsize::new(0),
            worker_started: Notify::new(),
            release: Arc::new(Notify::new()),
            cancel,
            batch,
            finish_early,
        });
        let extensions = ToolExtensions {
            agents: Some(AgentToolsConfig {
                max_model_requests: 20,
                max_tool_calls: 20,
                max_worker_model_requests: 10,
                max_worker_tool_calls: 10,
                worker_timeout_seconds: 5,
            }),
            ..Default::default()
        };
        let engine = Engine::open_with_extensions(
            &temp.path().join("data"),
            model.clone(),
            Limits {
                model_concurrency: 2,
                max_threads: 2,
                ..Default::default()
            },
            Some(RuntimeConfig {
                client: client.clone(),
                workspace: workspace.clone(),
                writable: true,
                command_scratch: Some(temp.path().join("scratch")),
            }),
            extensions,
        )
        .unwrap();
        let parent = engine
            .create(workspace.to_string_lossy().into_owned())
            .await
            .unwrap();
        engine
            .start(&parent.id, vec![Input::text("parent")])
            .await
            .unwrap();
        let done = tokio::time::timeout(Duration::from_secs(5), engine.wait(&parent.id))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(done.turns[0].status, TurnStatus::Completed, "{done:?}");
        assert_eq!(
            model.step.load(Ordering::SeqCst),
            if finish_early { 2 } else { 5 }
        );
        let (threads, _) = engine.list(None, 100, Some(&parent.id)).await.unwrap();
        assert_eq!(threads.len(), 1);
        let child = engine.read(&threads[0].id, true).await.unwrap();
        assert_eq!(
            child.turns[0].status,
            if cancel || finish_early {
                TurnStatus::Interrupted
            } else {
                TurnStatus::Completed
            }
        );
        assert_eq!(
            std::fs::read_dir(temp.path().join("scratch"))
                .unwrap()
                .count(),
            1,
            "failed admission must not leave an empty private directory"
        );
        assert!(
            done.turns[0]
                .items
                .iter()
                .filter_map(|item| if let Item::DynamicToolCall { success, .. } = item {
                    Some(success)
                } else {
                    None
                })
                .all(|s| *s == Some(true))
        );
        engine.shutdown().await;
        client.shutdown().await.unwrap();
        peer.await.unwrap();
    }
}
