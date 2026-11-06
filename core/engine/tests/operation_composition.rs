//! 轨迹中的已决定链条：相同真实文件改动和检查，只改变模型交接粒度。
use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelEvent, ModelStream, ToolCall},
    tools::RuntimeConfig,
};
use areal_protocol::{Input, Item, TurnStatus};
use areal_runtime_client::Client;
use areal_runtime_protocol::{FileCommand, FileHelperRequest};
use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::Mutex,
};

const CHECK: &str =
    "test \"$(cat a)\" = new_a && test \"$(cat b)\" = new_b && printf 'both checks passed\\n'";

fn patch(path: &str) -> Value {
    json!({"path":path,"patches":[{"oldText":format!("old_{path}"),"newText":format!("new_{path}")}]})
}
fn call(name: &str, arguments: Value, index: usize) -> ModelEvent {
    ModelEvent::ToolCall(ToolCall {
        id: format!("call-{index}"),
        name: name.into(),
        arguments: arguments.to_string(),
    })
}

struct PlannedModel {
    composed: bool,
    requests: AtomicUsize,
    input_bytes: AtomicUsize,
}
#[async_trait]
impl Model for PlannedModel {
    fn name(&self) -> &str {
        "known-operation-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<ModelStream> {
        let wire: Vec<_> = messages.iter().map(|m| json!({"role":m.role,"content":m.text_content(),"calls":m.tool_calls,"callId":m.tool_call_id})).collect();
        self.input_bytes.fetch_add(
            serde_json::to_vec(&json!({"messages":wire,"tools":tools}))?.len(),
            Ordering::SeqCst,
        );
        let round = self.requests.fetch_add(1, Ordering::SeqCst);
        let events = if round == 0 {
            vec![
                call("fs_read", json!({"path":"a"}), 0),
                call("fs_read", json!({"path":"b"}), 1),
            ]
        } else if self.composed && round == 1 {
            let code = "const e=await tools.edit_files(input.edit);text(e);if(e.success && e.data.allApplied){await collect(await tools.run_command(input.check));}";
            vec![call(
                "tool_program",
                json!({"code":code,"input":{"edit":{"files":[patch("a"),patch("b")]},"check":{"argv":["/bin/sh","-c",CHECK],"yieldMs":0}}}),
                2,
            )]
        } else if !self.composed && round <= 4 {
            vec![match round {
                1 => call("fs_apply_patches", patch("a"), 2),
                2 => call("fs_apply_patches", patch("b"), 3),
                3 => call(
                    "run_command",
                    json!({"argv":["/bin/sh","-c",CHECK],"yieldMs":0}),
                    4,
                ),
                4 => {
                    let result: Value =
                        serde_json::from_str(&messages.last().unwrap().text_content())?;
                    assert_eq!(result["commandStatus"], "running");
                    call("read_process", json!({"processId":result["processId"]}), 5)
                }
                _ => unreachable!(),
            }]
        } else {
            let last = messages.last().unwrap().text_content();
            assert!(
                last.contains("both checks passed"),
                "composed={} round={round} result={last}",
                self.composed
            );
            assert!(last.contains("succeeded"));
            vec![ModelEvent::text(
                "Both edited files and selected checks verified",
            )]
        };
        Ok(Box::pin(futures_util::stream::iter(
            events.into_iter().map(Ok),
        )))
    }
}

async fn runtime(
    workspace: &Path,
    log: Arc<Mutex<Vec<Value>>>,
) -> (Arc<Client>, tokio::task::JoinHandle<()>) {
    let root_path = workspace.to_owned();
    let (pipe, peer) = tokio::io::duplex(256 * 1024);
    let (read, write) = tokio::io::split(pipe);
    let (peer_read, mut peer_write) = tokio::io::split(peer);
    let task = tokio::spawn(async move {
        let mut lines = BufReader::new(peer_read).lines();
        let epoch = uuid::Uuid::new_v4().to_string();
        let scope = format!("{epoch}:scope:{}", uuid::Uuid::new_v4());
        let process = format!("{epoch}:process:{}", uuid::Uuid::new_v4());
        let mut output = None;
        let mut collected = false;
        while let Some(line) = lines.next_line().await.unwrap() {
            let req: Value = serde_json::from_str(&line).unwrap();
            let method = req["method"].as_str().unwrap();
            let result = match method {
                "connection.open" => {
                    json!({"protocolVersion":"areal.runtime.v0","runtimeEpoch":epoch,"connectionId":"fixture","rootScopeId":scope,"capabilities":{"methods":["scope.check","fs.execute"]}})
                }
                "scope.check" => json!({"available":true}),
                "scope.create" | "scope.get" | "scope.revoke" | "scope.waitClosed" => {
                    json!({"scopeId":scope,"parentScopeId":null,"state":if method=="scope.waitClosed" {"closed"} else {"active"},"owner":{"taskId":"fixture"},"readRoots":["workspace://repo"],"writeRoots":["workspace://repo"],"network":"deny","limits":{"wallTimeMs":30000,"outputBytes":8388608,"maxProcesses":4},"activeProcesses":0,"outputBytes":0,"cleanupError":null})
                }
                "fs.execute" => {
                    let mut command: FileCommand =
                        serde_json::from_value(req["params"]["command"].clone()).unwrap();
                    let relative = command
                        .path()
                        .strip_prefix("workspace://repo/")
                        .unwrap()
                        .to_owned();
                    *command.path_mut() = relative;
                    log.lock().await.push(json!({"file":command}));
                    // 真实描述符文件实现和 CAS；RPC/Scope 仅由夹具提供，不冒充 OS 沙箱验收。
                    areal_runtime_fs::execute(FileHelperRequest {
                        root: root_path.to_string_lossy().into_owned(),
                        command,
                    })
                    .unwrap()
                }
                "process.start" => {
                    let argv: Vec<String> =
                        serde_json::from_value(req["params"]["argv"].clone()).unwrap();
                    assert_eq!(argv, vec!["/bin/sh", "-c", CHECK]);
                    log.lock().await.push(json!({"argv":argv}));
                    output = Some(
                        tokio::process::Command::new(&argv[0])
                            .args(&argv[1..])
                            .current_dir(&root_path)
                            .output()
                            .await
                            .unwrap(),
                    );
                    json!({"processId":process,"scopeId":scope})
                }
                "output.read" => {
                    // 固定一个 running→collection 边界，不使用墙钟或 sleep 判定收益。
                    if req["params"]["waitMs"].as_u64().unwrap() > 0 {
                        collected = true;
                    }
                    let chunks = if collected
                        && !req["params"]["after"]
                            .as_str()
                            .is_some_and(|s| s.ends_with("/1"))
                    {
                        vec![
                            json!({"cursor":format!("{process}/1"),"stream":"stdout","dataBase64":STANDARD.encode(&output.as_ref().unwrap().stdout)}),
                        ]
                    } else {
                        vec![]
                    };
                    json!({"chunks":chunks,"nextCursor":format!("{process}/{}",usize::from(collected)),"closed":collected,"gap":false,"truncated":false})
                }
                "process.get" | "process.wait" => {
                    json!({"processId":process,"scopeId":scope,"state":if collected {"exited"} else {"running"},"exitCode":if collected {output.as_ref().unwrap().status.code()} else {None},"signal":null,"sandboxDenied":false,"stopReason":null,"cleanupError":null,"cleanupConfirmed":collected})
                }
                "connection.close" => json!({"closed":true}),
                _ => panic!("unexpected Runtime method {method}"),
            };
            peer_write
                .write_all(format!("{}\n", json!({"id":req["id"],"result":result})).as_bytes())
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
async fn two_observed_edits_test_and_collection_keep_work_but_halve_model_requests() {
    let mut measurements = Vec::new();
    let mut operation_logs = Vec::new();
    for composed in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        for path in ["a", "b"] {
            std::fs::write(workspace.join(path), format!("old_{path}")).unwrap();
        }
        let log = Arc::new(Mutex::new(Vec::new()));
        let (client, runtime) = runtime(&workspace, log.clone()).await;
        let model = Arc::new(PlannedModel {
            composed,
            requests: AtomicUsize::new(0),
            input_bytes: AtomicUsize::new(0),
        });
        let engine = Engine::open_with_runtime(
            &dir.path().join("data"),
            model.clone(),
            Limits::default(),
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
            .create(workspace.to_str().unwrap().into())
            .await
            .unwrap();
        engine
            .start(
                &thread.id,
                vec![Input::text(
                    "Apply the related changes and run the selected checks",
                )],
            )
            .await
            .unwrap();
        let done = tokio::time::timeout(Duration::from_secs(15), engine.wait(&thread.id))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            done.turns[0].status,
            TurnStatus::Completed,
            "{:?}",
            done.turns[0].error
        );
        for path in ["a", "b"] {
            assert_eq!(
                std::fs::read_to_string(workspace.join(path)).unwrap(),
                format!("new_{path}")
            );
        }
        let native_calls=done.turns[0].items.iter().filter(|i|matches!(i,Item::DynamicToolCall{execution,..} if execution.backend.as_deref()==Some("runtime"))).count();
        assert_eq!(native_calls, 6);
        measurements.push(json!({"composed":composed,"model_requests":model.requests.load(Ordering::SeqCst),"logical_input_bytes":model.input_bytes.load(Ordering::SeqCst),"native_calls":native_calls,"provider_tokens":null,"checks":"passed","delivery":"two actual files updated"}));
        operation_logs.push(log.lock().await.clone());
        engine.shutdown().await;
        client.shutdown().await.unwrap();
        runtime.await.unwrap();
    }
    assert_eq!(operation_logs[0], operation_logs[1]);
    assert_eq!(measurements[0]["model_requests"], 6);
    assert_eq!(measurements[1]["model_requests"], 3);
    println!(
        "MECHANISM_EVIDENCE {}",
        json!({"measurements":measurements,"same_native_operations":true,"provider_usage":"not measured; scripted fixture, no model network calls"})
    );
}

struct FactModel(Mutex<Vec<String>>);
#[async_trait]
impl Model for FactModel {
    fn name(&self) -> &str {
        "instruction-facts-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, _: Vec<Value>) -> anyhow::Result<ModelStream> {
        self.0.lock().await.push(
            messages
                .iter()
                .filter(|m| m.role == "system")
                .map(Message::text_content)
                .collect::<Vec<_>>()
                .join("\n"),
        );
        Ok(Box::pin(futures_util::stream::iter([Ok(
            ModelEvent::text("observed"),
        )])))
    }
}

#[tokio::test]
async fn instruction_facts_distinguish_empty_missing_and_loaded_and_refresh_next_turn() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(workspace.join("sub")).unwrap();
    std::fs::write(workspace.join("AGENTS.override.md"), " \n").unwrap();
    std::fs::write(workspace.join("AGENTS.md"), "root rule").unwrap();
    std::fs::write(workspace.join("sub/AGENTS.md"), "nested rule").unwrap();
    let (client, runtime) = runtime(&workspace, Arc::new(Mutex::new(Vec::new()))).await;
    let model = Arc::new(FactModel(Mutex::new(Vec::new())));
    let engine = Engine::open_with_runtime(
        &dir.path().join("data"),
        model.clone(),
        Limits::default(),
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
        .create(workspace.join("sub").to_str().unwrap().into())
        .await
        .unwrap();
    for turn in 0..2 {
        if turn == 1 {
            std::fs::write(workspace.join("sub/AGENTS.md"), "changed nested rule").unwrap();
        }
        engine
            .start(&thread.id, vec![Input::text("read instructions")])
            .await
            .unwrap();
        let done = tokio::time::timeout(Duration::from_secs(10), engine.wait(&thread.id))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            done.turns.last().unwrap().status,
            TurnStatus::Completed,
            "{:?}",
            done.turns.last().unwrap().error
        );
    }
    let observed = model.0.lock().await;
    assert_eq!(observed.len(), 2);
    for text in observed.iter() {
        assert!(text.contains("root rule") && text.contains("nested rule"));
        assert!(text.contains("\"state\":\"empty\"") && text.contains("\"state\":\"loaded\""));
        assert!(text.contains("\"path\":\"sub/AGENTS.override.md\",\"state\":\"missing\""));
        assert!(text.contains("commandDefaultCwd") && text.contains("sessionCwd"));
    }
    assert!(!observed[0].contains("changed nested rule"));
    assert!(observed[1].contains("changed nested rule"));
    drop(observed);
    engine.shutdown().await;
    client.shutdown().await.unwrap();
    runtime.await.unwrap();
}

struct SurfaceModel {
    round: AtomicUsize,
    program_only: bool,
    direct_edit: bool,
}
#[async_trait]
impl Model for SurfaceModel {
    fn name(&self) -> &str {
        "compact-surface-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<ModelStream> {
        let round = self.round.fetch_add(1, Ordering::SeqCst) % 4;
        let names: Vec<_> = tools
            .iter()
            .filter_map(|d| d["function"]["name"].as_str())
            .collect();
        assert!(names.contains(&"tool_program") && names.contains(&"tool_search"));
        let catalog = tools
            .iter()
            .find(|d| d["function"]["name"] == "tool_program")
            .unwrap()["function"]["description"]
            .as_str()
            .unwrap();
        assert!(catalog.contains("edit_files") && catalog.contains("environment_info"));
        assert_eq!(
            names.contains(&"edit_files"),
            !self.program_only || self.direct_edit
        );
        assert_eq!(
            catalog.contains("### tools.edit_files\n"),
            self.program_only && !self.direct_edit
        );
        assert_eq!(names.contains(&"environment_info"), !self.program_only);
        assert!(!names.contains(&"fs_apply_patches") && !names.contains(&"fs_create"));
        assert_eq!(
            names.contains(&"read_history"),
            round != 0 && !self.program_only
        );
        if self.program_only && round != 0 {
            assert!(catalog.contains("### tools.read_history\n"));
        }
        let event = match round {
            0 => {
                assert!(names.len() <= 15, "{names:?}");
                assert!(
                    messages
                        .iter()
                        .any(|m| m.text_content().contains("await collect"))
                );
                // 完整示例集中在工具定义；基础说明只保留决策边界，避免重复输入。
                assert!(catalog.contains("```json\n"));
                assert!(catalog.contains("await collect(await tools.verify_command(input.check))"));
                call("tool_search", json!({"query":"read_history","limit":1}), 0)
            }
            1 if self.direct_edit => call(
                "edit_files",
                json!({"files":[{"path":"created","text":"content"}]}),
                1,
            ),
            1 => call(
                "tool_program",
                json!({"code":"text(await tools.edit_files({files:[{path:'created',text:'content'}]}));"}),
                1,
            ),
            2 => {
                assert!(messages.last().unwrap().text_content().contains("APPLIED"));
                if self.program_only {
                    call(
                        "tool_program",
                        json!({"code":"text(await tools.read_history({limit:1}));"}),
                        2,
                    )
                } else {
                    call("read_history", json!({"limit":1}), 2)
                }
            }
            _ => ModelEvent::text("discovered and edited through native children"),
        };
        Ok(Box::pin(futures_util::stream::iter([Ok(event)])))
    }
}

#[tokio::test]
async fn compact_surface_discovers_next_request_and_keeps_hidden_edit_children() {
    for (program_only, direct_edit) in [(false, false), (true, false), (true, true)] {
        compact_surface(program_only, direct_edit).await;
    }
}

async fn compact_surface(program_only: bool, direct_edit: bool) {
    use areal_engine::tools::{ToolExtensions, ToolPolicy};
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let (client, rt) = runtime(&workspace, Arc::new(Mutex::new(vec![]))).await;
    let engine = Engine::open_with_extensions(
        &dir.path().join("data"),
        Arc::new(SurfaceModel {
            round: AtomicUsize::new(0),
            program_only,
            direct_edit,
        }),
        Limits::default(),
        Some(RuntimeConfig {
            client: client.clone(),
            workspace: workspace.clone(),
            writable: true,
            command_scope: None,
            command_scratch: None,
        }),
        ToolExtensions {
            policy: ToolPolicy {
                compact_tools: true,
                programmatic_tools_only: program_only,
                programmatic_direct_tools: if direct_edit {
                    vec!["edit_files".into(), "fs_create".into()]
                } else {
                    Vec::new()
                },
                ..Default::default()
            },
            ..Default::default()
        },
    )
    .unwrap();
    let thread = engine
        .create(workspace.to_str().unwrap().into())
        .await
        .unwrap();
    for _ in 0..2 {
        engine
            .start(
                &thread.id,
                vec![Input::text(
                    "Create the decided file and inspect its record",
                )],
            )
            .await
            .unwrap();
        let done = tokio::time::timeout(Duration::from_secs(15), engine.wait(&thread.id))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            done.turns.last().unwrap().status,
            TurnStatus::Completed,
            "{:?}",
            done.turns.last().unwrap().error
        );
        assert_eq!(
            std::fs::read_to_string(workspace.join("created")).unwrap(),
            "content"
        );
        std::fs::remove_file(workspace.join("created")).unwrap();
    }
    engine.shutdown().await;
    client.shutdown().await.unwrap();
    rt.await.unwrap();
}
