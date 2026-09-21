use areal_engine::{
    Engine, Limits,
    model::{AgentStream, HttpModel, Message, Model, ModelEvent, ModelStream, ToolCall},
    tools::RuntimeConfig,
};
use areal_protocol::{Input, Item, ToolOutcome, TurnStatus};
use areal_runtime_client::Client;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::mpsc,
};

struct ToolModel;
#[async_trait]
impl Model for ToolModel {
    fn name(&self) -> &str {
        "tool-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<AgentStream> {
        assert!(
            tools
                .iter()
                .any(|tool| tool["function"]["name"] == "fs_write")
        );
        let event = if messages.last().unwrap().role == "tool" {
            assert_eq!(
                messages[messages.len() - 2].tool_calls[0]["id"],
                "fixture-call"
            );
            assert!(messages.last().unwrap().text_content().contains("sha256"));
            ModelEvent::TextDelta("verified tool result".into())
        } else {
            ModelEvent::ToolCall(ToolCall {
                id: "fixture-call".into(),
                name: "fs_write".into(),
                arguments:
                    json!({"path":"workspace://repo/code","text":"hello","expectedSha256":null})
                        .to_string(),
            })
        };
        Ok(Box::pin(futures_util::stream::iter([Ok(event)])))
    }
}
struct RuntimeFixture {
    client: Arc<Client>,
    seen: mpsc::UnboundedReceiver<Value>,
    release: mpsc::UnboundedSender<()>,
    methods: Arc<Mutex<Vec<String>>>,
    task: tokio::task::JoinHandle<()>,
}

struct CorrectingToolModel(&'static str, &'static str);
#[async_trait]
impl Model for CorrectingToolModel {
    fn name(&self) -> &str {
        "correcting-tool-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, _: Vec<Value>) -> anyhow::Result<ModelStream> {
        let count = messages.iter().filter(|m| m.role == "tool").count();
        let event = match count {
            0 => ModelEvent::ToolCall(ToolCall {
                id: "rejected-call".into(),
                name: self.0.into(),
                arguments: self.1.into(),
            }),
            1 => {
                let error: Value = serde_json::from_str(&messages.last().unwrap().text_content())?;
                assert_eq!(error["error"]["code"], "INVALID_ARGUMENT");
                assert!(!error["error"]["message"].as_str().unwrap().is_empty());
                let arguments = messages[messages.len() - 2].tool_calls[0]["function"]["arguments"]
                    .as_str()
                    .unwrap();
                assert!(serde_json::from_str::<Value>(arguments)?.is_object());
                ModelEvent::ToolCall(ToolCall {
                    id: "corrected-call".into(),
                    name: "fs_write".into(),
                    arguments:
                        json!({"path":"workspace://repo/code","text":"hello","expectedSha256":null})
                            .to_string(),
                })
            }
            2 => {
                assert!(messages.last().unwrap().text_content().contains("sha256"));
                ModelEvent::text("corrected and verified")
            }
            _ => panic!("unexpected repeated correction"),
        };
        Ok(Box::pin(futures_util::stream::iter([Ok(event)])))
    }
}

#[tokio::test]
async fn invalid_model_calls_are_journaled_without_execution_and_can_be_corrected() {
    for (name, arguments) in [
        "{",
        "[]",
        r#"{"path":"workspace://repo/code","text":"hello","fileVersion":"v-invalid","expectedSha256":null}"#,
        r#"{"path":"workspace://repo/code","text":"hello","expectedSha256":null,"unadvertised":"value"}"#,
        r#"{"path":"workspace://repo/code","text":["hello"],"expectedSha256":null}"#,
    ]
    .into_iter()
    .map(|arguments| ("fs_write", arguments))
    .chain([("unadvertised", "{}")])
    {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let workspace = dir.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let fixture = runtime(data.clone(), false).await;
        let engine = Engine::open_with_runtime(
            &data,
            Arc::new(CorrectingToolModel(name, arguments)),
            Limits::default(),
            RuntimeConfig {
                client: fixture.client.clone(),
                workspace: workspace.clone(),
                writable: true,
                command_scratch: None,
            },
        )
        .unwrap();
        let thread = engine
            .create(workspace.to_string_lossy().into_owned())
            .await
            .unwrap();
        engine
            .start(&thread.id, vec![Input::text("write")])
            .await
            .unwrap();
        let completed = bounded(engine.wait(&thread.id)).await.unwrap();
        assert_eq!(completed.turns[0].status, TurnStatus::Completed);
        let calls: Vec<_> = completed.turns[0]
            .items
            .iter()
            .filter_map(|item| match item {
                Item::DynamicToolCall {
                    arguments,
                    execution,
                    ..
                } => Some((arguments, &execution.outcome)),
                _ => None,
            })
            .collect();
        assert_eq!(calls.len(), 2);
        assert_eq!(*calls[0].1, ToolOutcome::Failed);
        assert_eq!(*calls[1].1, ToolOutcome::Succeeded);
        if arguments == "{" {
            assert_eq!(calls[0].0, &json!(arguments));
        }
        assert_eq!(
            fixture
                .methods
                .lock()
                .unwrap()
                .iter()
                .filter(|name| name.as_str() == "fs.execute")
                .count(),
            1
        );
        engine.shutdown().await;
        fixture.client.shutdown().await.unwrap();
        fixture.task.await.unwrap();
    }
}
async fn runtime(data: PathBuf, hold: bool) -> RuntimeFixture {
    let (client_pipe, peer) = tokio::io::duplex(128 * 1024);
    let (read, write) = tokio::io::split(client_pipe);
    let (peer_read, mut peer_write) = tokio::io::split(peer);
    let (seen, received) = mpsc::unbounded_channel();
    let (release, mut released) = mpsc::unbounded_channel();
    let methods = Arc::new(Mutex::new(Vec::new()));
    let recorded = methods.clone();
    let task = tokio::spawn(async move {
        let mut lines = BufReader::new(peer_read).lines();
        let epoch = uuid::Uuid::new_v4().to_string();
        let root = format!("{epoch}:scope:{}", uuid::Uuid::new_v4());
        let scope = json!({"scopeId":root,"parentScopeId":null,"state":"active","owner":{"taskId":"fixture"},"readRoots":["workspace://repo"],"writeRoots":["workspace://repo"],"network":"deny","limits":{"wallTimeMs":30000,"outputBytes":8388608,"maxProcesses":4},"activeProcesses":0,"outputBytes":0,"cleanupError":null});
        let mut pending = None;
        while let Some(line) = lines.next_line().await.unwrap() {
            let request: Value = serde_json::from_str(&line).unwrap();
            let method = request["method"].as_str().unwrap();
            recorded.lock().unwrap().push(method.into());
            let result = match method {
                "connection.open" => {
                    json!({"protocolVersion":"areal.runtime.v0","runtimeEpoch":epoch,"connectionId":"fixture","rootScopeId":root,"capabilities":{"methods":["fs.execute"]}})
                }
                "scope.create" | "scope.revoke" => scope.clone(),
                "scope.waitClosed" => {
                    // A completed Turn must not be visible before this acknowledgement.
                    if hold {
                        released.recv().await.unwrap();
                    }
                    let mut scope = scope.clone();
                    scope["state"] = json!("closed");
                    scope
                }
                "fs.execute" => {
                    let path = std::fs::read_dir(&data)
                        .unwrap()
                        .map(|e| e.unwrap().path())
                        .find(|p| p.extension().is_some_and(|e| e == "json"))
                        .unwrap();
                    let record: Value =
                        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
                    let item = record["thread"]["turns"][0]["items"]
                        .as_array()
                        .unwrap()
                        .last()
                        .unwrap();
                    assert_eq!(
                        item["execution"]["operationId"],
                        request["params"]["operationId"]
                    );
                    assert_eq!(item["execution"]["outcome"], "running");
                    seen.send(request.clone()).unwrap();
                    if hold {
                        pending = Some(request["id"].clone());
                        continue;
                    }
                    json!({"sha256":"fixture-digest","size":5})
                }
                "connection.close" => json!({"closed":true}),
                _ => panic!("unexpected method {method}"),
            };
            peer_write
                .write_all(format!("{}\n", json!({"id":request["id"],"result":result})).as_bytes())
                .await
                .unwrap();
            if method == "connection.close" {
                if let Some(id) = pending.take() {
                    let _=peer_write.write_all(format!("{}\n",json!({"id":id,"error":{"code":"UNAVAILABLE","message":"fixture close"}})).as_bytes()).await;
                }
                break;
            }
        }
    });
    RuntimeFixture {
        client: Client::connect(read, write).await.unwrap(),
        seen: received,
        release,
        methods,
        task,
    }
}
async fn bounded<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), future)
        .await
        .unwrap()
}

#[tokio::test]
async fn responses_tools_survive_active_argument_stream_and_retain_provider_context() {
    use areal_engine::model::{ModelOptions, ModelProtocol};
    use axum::{
        Json, Router,
        response::sse::{Event, Sse},
        routing::post,
    };
    use std::{
        convert::Infallible,
        sync::atomic::{AtomicUsize, Ordering},
    };
    let requests = Arc::new(AtomicUsize::new(0));
    let recorded = requests.clone();
    let app = Router::new().route("/", post(move |Json(request): Json<Value>| {
        let recorded = recorded.clone();
        async move {
            assert_eq!(request["reasoning"]["effort"], "xhigh");
            assert_eq!(request["max_output_tokens"], 8192);
            assert_eq!(request["temperature"], 1.0);
            assert_eq!(request["top_p"], 0.95);
            assert_eq!(request["tools"][0]["type"], "function");
            assert!(request["tools"].as_array().unwrap().iter().any(|tool| tool["name"] == "fs_read"));
            assert!(request["tools"].as_array().unwrap().iter().any(|tool| tool["name"] == "agent_spawn"));
            assert_eq!(request["parallel_tool_calls"], true);
            assert_eq!(request["store"], false);
            let round = recorded.fetch_add(1, Ordering::SeqCst);
            let mut events = Vec::new();
            if round == 0 {
                let context = json!({"type":"reasoning","id":"rs_test","summary":[],"encrypted_content":"opaque-fixture"});
                events.push(json!({"type":"response.output_item.done","item":context}));
                for _ in 0..8 { events.push(json!({"type":"response.function_call_arguments.delta","delta":" ","item_id":"fc_test","output_index":1})); }
                let call = json!({"type":"function_call","id":"fc_test","call_id":"call_test","name":"fs_write","arguments":json!({"path":"workspace://repo/code","text":"hello","expectedSha256":null}).to_string()});
                events.push(json!({"type":"response.output_item.done","item":call}));
                events.push(json!({"type":"response.completed","response":{"status":"completed","output":[context,call],"usage":{"input_tokens":5,"output_tokens":2}}}));
            } else {
                assert_eq!(round, 1);
                let input = request["input"].as_array().unwrap();
                assert_eq!(input.iter().filter(|v| v["type"] == "reasoning").count(), 1);
                assert!(input.iter().any(|v| v["encrypted_content"] == "opaque-fixture"));
                assert!(input.iter().any(|v| v["type"] == "function_call" && v["call_id"] == "call_test"));
                assert_eq!(input.last().unwrap()["type"], "function_call_output");
                assert!(input.last().unwrap()["output"].as_str().unwrap().contains("fixture-digest"));
                events.push(json!({"type":"response.output_text.delta","delta":"verified Responses result"}));
                events.push(json!({"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":7,"output_tokens":3}}}));
            }
            Sse::new(futures_util::stream::unfold(events.into_iter(), |mut events| async move {
                let event = events.next()?;
                tokio::time::sleep(Duration::from_millis(40)).await;
                Some((Ok::<_, Infallible>(Event::default().data(event.to_string())), events))
            }))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let workspace = dir.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let fixture = runtime(data.clone(), false).await;
    let model = HttpModel::with_protocol(
        format!("http://{address}/"),
        "fixture".into(),
        None,
        ModelProtocol::Responses,
    )
    .unwrap()
    .with_options(ModelOptions {
        reasoning_effort: Some("xhigh".into()),
        max_output_tokens: Some(8192),
        temperature: Some(1.0),
        top_p: Some(0.95),
        max_retries: 0,
        ..ModelOptions::default()
    })
    .unwrap();
    let engine = Engine::open_with_runtime(
        &data,
        Arc::new(model),
        Limits {
            stream_idle_timeout: Duration::from_millis(150),
            ..Limits::default()
        },
        RuntimeConfig {
            client: fixture.client.clone(),
            workspace: workspace.clone(),
            writable: true,
            command_scratch: None,
        },
    )
    .unwrap();
    let thread = engine
        .create(workspace.to_str().unwrap().into())
        .await
        .unwrap();
    engine
        .start(&thread.id, vec![Input::text("write a file")])
        .await
        .unwrap();
    let done = bounded(engine.wait(&thread.id)).await.unwrap();
    assert_eq!(
        done.turns[0].status,
        TurnStatus::Completed,
        "{:?}",
        done.turns[0].error
    );
    assert_eq!(done.turns[0].usage.as_ref().unwrap().input_tokens, 12);
    assert_eq!(
        fixture
            .methods
            .lock()
            .unwrap()
            .iter()
            .filter(|m| *m == "fs.execute")
            .count(),
        1
    );
    assert!(done.turns[0].items.iter().any(|i| matches!(i, Item::ModelContext {value,..} if value["encrypted_content"] == "opaque-fixture")));
    engine.shutdown().await;
    fixture.client.shutdown().await.unwrap();
    fixture.task.await.unwrap();
    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn tool_journal_precedes_submission_and_result_drives_the_next_model_round() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let workspace = dir.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let fixture = runtime(data.clone(), false).await;
    let engine = Engine::open_with_runtime(
        &data,
        Arc::new(ToolModel),
        Limits::default(),
        RuntimeConfig {
            client: fixture.client.clone(),
            workspace: workspace.clone(),
            writable: true,
            command_scratch: None,
        },
    )
    .unwrap();
    let thread = engine
        .create(workspace.to_str().unwrap().into())
        .await
        .unwrap();
    engine
        .start(&thread.id, vec![Input::text("write a file")])
        .await
        .unwrap();
    let done = bounded(engine.wait(&thread.id)).await.unwrap();
    assert_eq!(done.turns[0].status, TurnStatus::Completed);
    assert!(done.turns[0].items.iter().any(|item| matches!(item,Item::DynamicToolCall {execution,..} if execution.outcome==ToolOutcome::Succeeded)));
    assert!(
        done.turns[0]
            .items
            .iter()
            .any(|item| matches!(item,Item::AgentMessage{text,..} if text=="verified tool result"))
    );
    assert_eq!(
        *fixture.methods.lock().unwrap(),
        [
            "connection.open",
            "scope.create",
            "fs.execute",
            "scope.revoke",
            "scope.waitClosed"
        ]
    );
    engine.shutdown().await;
    fixture.client.shutdown().await.unwrap();
    fixture.task.await.unwrap();
}

#[tokio::test]
async fn runtime_disconnect_during_a_tool_fails_with_unknown_and_never_replays() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let workspace = dir.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let mut fixture = runtime(data.clone(), true).await;
    let engine = Engine::open_with_runtime(
        &data,
        Arc::new(ToolModel),
        Limits::default(),
        RuntimeConfig {
            client: fixture.client.clone(),
            workspace: workspace.clone(),
            writable: true,
            command_scratch: None,
        },
    )
    .unwrap();
    let thread = engine
        .create(workspace.to_string_lossy().into_owned())
        .await
        .unwrap();
    engine
        .start(&thread.id, vec![Input::text("write")])
        .await
        .unwrap();
    bounded(fixture.seen.recv()).await.unwrap();
    fixture.task.abort(); // Close the private transport before any tool reply.
    let done = bounded(engine.wait(&thread.id)).await.unwrap();
    assert_eq!(done.turns[0].status, TurnStatus::Failed);
    assert!(done.turns[0].error.is_some());
    assert!(done.turns[0].items.iter().any(
        |i| matches!(i, Item::DynamicToolCall { success,execution,.. }
        if *success != Some(true) && execution.outcome==ToolOutcome::Unknown)
    ));
    assert_eq!(
        fixture
            .methods
            .lock()
            .unwrap()
            .iter()
            .filter(|m| m.as_str() == "fs.execute")
            .count(),
        1
    );
    engine.shutdown().await;
    let _ = fixture.client.shutdown().await;
    assert!(fixture.task.await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn interrupted_inflight_tool_is_unknown_and_turn_waits_for_scope_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let workspace = dir.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let mut fixture = runtime(data.clone(), true).await;
    let engine = Engine::open_with_runtime(
        &data,
        Arc::new(ToolModel),
        Limits {
            max_active_turns: 1,
            ..Limits::default()
        },
        RuntimeConfig {
            client: fixture.client.clone(),
            workspace: workspace.clone(),
            writable: true,
            command_scratch: None,
        },
    )
    .unwrap();
    let thread = engine
        .create(workspace.to_str().unwrap().into())
        .await
        .unwrap();
    let turn = engine
        .start(&thread.id, vec![Input::text("write")])
        .await
        .unwrap();
    bounded(fixture.seen.recv()).await.unwrap();
    engine.interrupt(&thread.id, &turn.id).await.unwrap();
    let other = engine
        .create(workspace.to_str().unwrap().into())
        .await
        .unwrap();
    assert!(
        matches!(
            engine.start(&other.id, vec![Input::text("write")]).await,
            Err(areal_engine::Error::Exhausted(_))
        ),
        "cancellation must not release capacity before Runtime cleanup"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(30), engine.wait(&thread.id))
            .await
            .is_err()
    );
    fixture.release.send(()).unwrap();
    let done = bounded(engine.wait(&thread.id)).await.unwrap();
    assert_eq!(done.turns[0].status, TurnStatus::Failed);
    assert!(done.turns[0].items.iter().any(|item| matches!(item,Item::DynamicToolCall{execution,..} if execution.outcome==ToolOutcome::Unknown)));
    assert_eq!(
        fixture
            .methods
            .lock()
            .unwrap()
            .iter()
            .filter(|method| method.as_str() == "fs.execute")
            .count(),
        1
    );
    engine.shutdown().await;
    fixture.client.shutdown().await.unwrap();
    fixture.task.await.unwrap();
    drop(engine);
    let recovered = Engine::open(&data, Arc::new(ToolModel), Limits::default()).unwrap();
    assert_eq!(
        recovered.read(&thread.id, true).await.unwrap().turns[0].status,
        TurnStatus::Failed
    );
    recovered.shutdown().await;
}

struct InvalidProcessModel {
    process: String,
}
#[async_trait]
impl Model for InvalidProcessModel {
    fn name(&self) -> &str {
        "invalid-process-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, _: Vec<Value>) -> anyhow::Result<AgentStream> {
        let results: Vec<_> = messages
            .iter()
            .filter(|message| message.role == "tool")
            .collect();
        if let Some(result) = results.last() {
            assert!(result.text_content().contains(if results.len() < 3 {
                "INVALID_ARGUMENT"
            } else {
                "sha256"
            }));
        }
        let (name, args) = match results.len() {
            0 => (
                "read_process",
                json!({"processId":"mistyped-process/332","after":"332","waitMs":0}),
            ),
            1 => (
                "read_process",
                json!({"processId":self.process,"after":"332","waitMs":0}),
            ),
            2 => (
                "fs_write",
                json!({"path":"recovered","text":"hello","expectedSha256":null}),
            ),
            3 => {
                return Ok(Box::pin(futures_util::stream::iter([Ok(
                    ModelEvent::TextDelta("recovered without replay".into()),
                )])));
            }
            _ => panic!("unexpected extra model round"),
        };
        Ok(Box::pin(futures_util::stream::iter([Ok(
            ModelEvent::ToolCall(ToolCall {
                id: format!("call-{}", results.len()),
                name: name.into(),
                arguments: args.to_string(),
            }),
        )])))
    }
}

#[tokio::test]
async fn malformed_process_and_cursor_are_recoverable_without_runtime_submission() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let workspace = dir.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let fixture = runtime(data.clone(), false).await;
    let process = format!(
        "{}:process:{}",
        fixture.client.info().runtime_epoch,
        uuid::Uuid::new_v4()
    );
    let engine = Engine::open_with_runtime(
        &data,
        Arc::new(InvalidProcessModel { process }),
        Limits::default(),
        RuntimeConfig {
            client: fixture.client.clone(),
            workspace: workspace.clone(),
            writable: true,
            command_scratch: None,
        },
    )
    .unwrap();
    let thread = engine
        .create(workspace.to_str().unwrap().into())
        .await
        .unwrap();
    engine
        .start(
            &thread.id,
            vec![Input::text("recover a mistyped process handle")],
        )
        .await
        .unwrap();
    let done = bounded(engine.wait(&thread.id)).await.unwrap();
    assert_eq!(done.turns[0].status, TurnStatus::Completed);
    let outcomes: Vec<_> = done.turns[0]
        .items
        .iter()
        .filter_map(|item| match item {
            Item::DynamicToolCall { execution, .. } => Some(execution.outcome.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(
        outcomes,
        vec![
            ToolOutcome::Failed,
            ToolOutcome::Failed,
            ToolOutcome::Succeeded
        ]
    );
    assert!(
        !fixture
            .methods
            .lock()
            .unwrap()
            .iter()
            .any(|method| method.starts_with("process.") || method == "output.read")
    );
    engine.shutdown().await;
    fixture.client.shutdown().await.unwrap();
    fixture.task.await.unwrap();
}

#[tokio::test]
async fn http_tool_loop_preserves_multimodal_history_and_accumulates_usage() {
    for done_marker in [true, false] {
        http_tool_loop(done_marker).await;
    }
}

async fn http_tool_loop(done_marker: bool) {
    use axum::{Json, Router, routing::post};
    use std::sync::atomic::{AtomicUsize, Ordering};

    let requests = Arc::new(AtomicUsize::new(0));
    let seen = requests.clone();
    let app = Router::new().route(
        "/",
        post(move |Json(request): Json<Value>| {
            let seen = seen.clone();
            async move {
                assert!(request["tools"].as_array().unwrap().iter().any(|tool| tool["function"]["name"] == "fs_write"));
                assert_eq!(request["parallel_tool_calls"], true);
                assert_eq!(request["stream_options"]["include_usage"], true);
                let messages: Vec<_> = request["messages"].as_array().unwrap().iter().filter(|m| m["role"] != "system").collect();
                let user = messages.iter().find(|message| message["role"] == "user").unwrap();
                assert_eq!(user["content"][0]["text"], "inspect and write");
                assert_eq!(user["content"][1]["type"], "image_url");
                assert_eq!(user["content"][1]["image_url"]["url"], "https://example.test/input.png");
                let call = seen.fetch_add(1, Ordering::SeqCst);
                let (delta, reason, input_tokens) = if call == 0 {
                    (
                        json!({"content":"Writing both independent files.","tool_calls":(0..2).map(|index| json!({"index":index,"id":format!("fixture-call-{index}"),"type":"function","function":{"name":"fs_write","arguments":json!({"path":format!("workspace://repo/code-{index}"),"text":"hello","expectedSha256":null}).to_string()}})).collect::<Vec<_>>()}),
                        "tool_calls",
                        5,
                    )
                } else {
                    assert_eq!(call, 1);
                    let result = messages.last().unwrap();
                    assert_eq!(result["role"], "tool");
                    assert_eq!(result["tool_call_id"], "fixture-call-1");
                    assert!(result["content"].as_str().unwrap().contains("fixture-digest"));
                    let results: Vec<_> = messages.iter().filter(|message| message["role"] == "tool").collect();
                    assert_eq!(results.len(), 2);
                    assert_eq!(results[0]["tool_call_id"], "fixture-call-0");
                    assert_eq!(messages.len(), 4);
                    assert_eq!(messages[1]["role"], "assistant");
                    assert_eq!(messages[1]["content"], "Writing both independent files.");
                    assert_eq!(messages[1]["tool_calls"].as_array().unwrap().len(), 2);
                    assert_eq!(messages[1]["tool_calls"][0]["id"], "fixture-call-0");
                    assert_eq!(messages[1]["tool_calls"][1]["id"], "fixture-call-1");
                    (json!({"content":"verified HTTP tool result"}), "stop", 7)
                };
                let mut body = [
                    json!({"choices":[{"index":0,"delta":delta,"finish_reason":null}]}),
                    json!({"choices":[{"index":0,"delta":{},"finish_reason":reason}]}),
                    json!({"choices":[],"usage":{"prompt_tokens":input_tokens,"prompt_tokens_details":{"cached_tokens":2},"completion_tokens":3}}),
                ]
                .into_iter()
                .map(|event| format!("data: {event}\n\n"))
                .collect::<String>();
                if done_marker { body.push_str("data: [DONE]\n\n"); }
                ([("content-type", "text/event-stream")], body)
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let workspace = dir.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let fixture = runtime(data.clone(), false).await;
    let model = HttpModel::new(endpoint, "http-tool-fixture".into(), None).unwrap();
    let engine = Engine::open_with_runtime(
        &data,
        Arc::new(model),
        Limits::default(),
        RuntimeConfig {
            client: fixture.client.clone(),
            workspace: workspace.clone(),
            writable: true,
            command_scratch: None,
        },
    )
    .unwrap();
    let thread = engine
        .create(workspace.to_str().unwrap().into())
        .await
        .unwrap();
    engine
        .start(
            &thread.id,
            vec![
                Input::text("inspect and write"),
                Input::Image {
                    url: "https://example.test/input.png".into(),
                    detail: None,
                },
            ],
        )
        .await
        .unwrap();
    let done = bounded(engine.wait(&thread.id)).await.unwrap();
    assert_eq!(done.turns[0].status, TurnStatus::Completed);
    assert_eq!(requests.load(Ordering::SeqCst), 2);
    let usage = done.turns[0].usage.as_ref().unwrap();
    assert_eq!(
        (
            usage.input_tokens,
            usage.cached_input_tokens,
            usage.output_tokens
        ),
        (12, 4, 6)
    );
    assert!(done.turns[0].items.iter().any(|item| matches!(item, Item::DynamicToolCall { execution, .. } if execution.outcome == ToolOutcome::Succeeded)));
    assert!(done.turns[0].items.iter().any(|item| matches!(item, Item::AgentMessage { text, .. } if text == "verified HTTP tool result")));
    engine.shutdown().await;
    fixture.client.shutdown().await.unwrap();
    fixture.task.await.unwrap();
    server.abort();
    let _ = server.await;
}
