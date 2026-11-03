use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelEvent, ModelStream, ToolCall},
    tools::{HookDefinition, HookEvent, RuntimeConfig, ToolExtensions, ToolPolicy},
};
use areal_protocol::{Input, Item, ToolOutcome, TurnStatus};
use areal_runtime_client::Client;
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
    sync::{Mutex, Notify, mpsc, oneshot},
};
use tokio_util::sync::CancellationToken;

struct BatchModel {
    calls: Vec<ToolCall>,
    sequential: bool,
    requests: AtomicUsize,
    input_bytes: AtomicUsize,
    expected_results: AtomicUsize,
    received: Mutex<Vec<Message>>,
    declarations: Mutex<Vec<Value>>,
}

#[async_trait]
impl Model for BatchModel {
    fn name(&self) -> &str {
        "tool-scheduling-fixture"
    }

    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }

    async fn chat(
        &self,
        messages: Vec<Message>,
        definitions: Vec<Value>,
    ) -> anyhow::Result<ModelStream> {
        let logical_messages: Vec<_> = messages
            .iter()
            .map(|m| {
                json!({
                    "role":m.role,"content":m.text_content(),"toolCalls":m.tool_calls,
                    "toolCallId":m.tool_call_id,"providerContext":m.provider_context,
                })
            })
            .collect();
        self.input_bytes.fetch_add(
            serde_json::to_vec(&json!({"messages":logical_messages,"tools":definitions}))?.len(),
            Ordering::SeqCst,
        );
        *self.received.lock().await = messages.clone();
        *self.declarations.lock().await = definitions;
        let round = self.requests.fetch_add(1, Ordering::SeqCst);
        if round == 0 && !self.calls.is_empty() {
            return Ok(Box::pin(futures_util::stream::iter(
                self.calls
                    .clone()
                    .into_iter()
                    .take(if self.sequential { 1 } else { self.calls.len() })
                    .map(ModelEvent::ToolCall)
                    .map(Ok),
            )));
        }
        if self.sequential && round == 1 {
            let observed = messages.iter().find(|m| m.role == "tool").unwrap();
            let data: Value = serde_json::from_str(&observed.text_content())?;
            let mut next = self.calls[1].clone();
            next.arguments = json!({"path":data["text"]}).to_string();
            return Ok(Box::pin(futures_util::stream::iter([Ok(
                ModelEvent::ToolCall(next),
            )])));
        }
        let expected = self.expected_results.load(Ordering::SeqCst);
        let results: Vec<_> = messages.iter().filter(|m| m.role == "tool").collect();
        assert_eq!(results.len(), expected);
        let advertised: Vec<_> = messages.iter().flat_map(|m| &m.tool_calls).collect();
        assert_eq!(advertised.len(), expected);
        for ((call, advertised), result) in self.calls.iter().zip(advertised).zip(results) {
            assert_eq!(advertised["id"], call.id);
            assert_eq!(result.tool_call_id.as_deref(), Some(call.id.as_str()));
            if matches!(call.name.as_str(), "tool_program" | "edit_files") {
                continue;
            }
            let value: Value = serde_json::from_str(&result.text_content())?;
            let arguments: Value = serde_json::from_str(&call.arguments)?;
            assert_eq!(value["path"], arguments["path"]);
            if call.name == "fs_read" {
                assert_eq!(value["text"], arguments["path"]);
                assert!(value["fileVersion"].as_str().unwrap().starts_with('v'));
            }
        }
        Ok(Box::pin(futures_util::stream::iter([Ok(
            ModelEvent::text("all results observed"),
        )])))
    }
}

struct Pending {
    request: Value,
    release: oneshot::Sender<Value>,
}

impl Pending {
    fn path(&self) -> &str {
        self.request["params"]["command"]["path"].as_str().unwrap()
    }

    fn succeed(self) {
        let path = self.path().to_owned();
        let mut result = json!({"path":path,"sha256":"a".repeat(64),"size":3});
        if self.request["params"]["command"]["kind"] == "read" {
            result["dataBase64"] = json!(STANDARD.encode(path));
        }
        self.release.send(json!({"result":result})).unwrap();
    }

    fn unknown(self) {
        self.release
            .send(json!({"error":{"code":"UNAVAILABLE","message":"fixture unknown result"}}))
            .unwrap();
    }
}

struct Runtime {
    client: Arc<Client>,
    seen: mpsc::UnboundedReceiver<Pending>,
    scopes: Arc<AtomicUsize>,
    closed: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}

async fn bounded<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(10), future)
        .await
        .expect("tool scheduling fixture stalled")
}

impl Runtime {
    async fn next(&mut self) -> Pending {
        bounded(self.seen.recv()).await.unwrap()
    }

    async fn pair(&mut self, left: &str, right: &str) -> (Pending, Pending) {
        let first = self.next().await;
        let second = self.next().await;
        let pair = if first.path().ends_with(left) {
            (first, second)
        } else {
            (second, first)
        };
        assert!(pair.0.path().ends_with(left) && pair.1.path().ends_with(right));
        pair
    }

    async fn assert_no_dispatch(&mut self) {
        assert!(
            tokio::time::timeout(Duration::from_millis(60), self.seen.recv())
                .await
                .is_err(),
            "a tool crossed an unsettled serial barrier"
        );
    }
}

async fn runtime(data: &Path) -> Runtime {
    let (client_pipe, peer) = tokio::io::duplex(256 * 1024);
    let (read, write) = tokio::io::split(client_pipe);
    let (peer_read, peer_write) = tokio::io::split(peer);
    let writer = Arc::new(Mutex::new(peer_write));
    let (seen, received) = mpsc::unbounded_channel();
    let scopes = Arc::new(AtomicUsize::new(0));
    let closed = Arc::new(AtomicUsize::new(0));
    let created = scopes.clone();
    let cleaned = closed.clone();
    let data = data.to_owned();
    let task = tokio::spawn(async move {
        let mut lines = BufReader::new(peer_read).lines();
        let pending = Arc::new(AtomicUsize::new(0));
        let changed = Arc::new(Notify::new());
        let revoked = CancellationToken::new();
        let epoch = uuid::Uuid::new_v4().to_string();
        let root = format!("{epoch}:scope:{}", uuid::Uuid::new_v4());
        let scope = json!({"scopeId":root,"parentScopeId":null,"state":"active","owner":{"taskId":"fixture"},"readRoots":["workspace://repo"],"writeRoots":["workspace://repo"],"network":"deny","limits":{"wallTimeMs":30000,"outputBytes":8388608,"maxProcesses":4},"activeProcesses":0,"outputBytes":0,"cleanupError":null});
        while let Some(line) = lines.next_line().await.unwrap() {
            let request: Value = serde_json::from_str(&line).unwrap();
            let method = request["method"].as_str().unwrap();
            if method == "fs.execute" {
                // 每个并发请求都必须已经有独立的持久化意图，不能只核对最后一项。
                let journaled = std::fs::read_dir(&data).unwrap().any(|entry| {
                    let path = entry.unwrap().path();
                    if path.extension().is_none_or(|extension| extension != "json") {
                        return false;
                    }
                    let record: Value =
                        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
                    record["thread"]["turns"][0]["items"]
                        .as_array()
                        .is_some_and(|items| {
                            items.iter().any(|item| {
                                item["execution"]["operationId"] == request["params"]["operationId"]
                                    && item["execution"]["outcome"] == "running"
                            })
                        })
                });
                assert!(journaled, "Runtime submission preceded its durable intent");
                let (release, ready) = oneshot::channel();
                pending.fetch_add(1, Ordering::SeqCst);
                seen.send(Pending {
                    request: request.clone(),
                    release,
                })
                .unwrap();
                let writer = writer.clone();
                let pending = pending.clone();
                let changed = changed.clone();
                let revoked = revoked.clone();
                tokio::spawn(async move {
                    let mut response = tokio::select! {
                        result = ready => result.unwrap_or_else(|_|json!({"error":{"code":"UNAVAILABLE","message":"fixture gate dropped"}})),
                        _ = revoked.cancelled() => json!({"error":{"code":"UNAVAILABLE","message":"fixture scope revoked"}}),
                    };
                    response["id"] = request["id"].clone();
                    writer
                        .lock()
                        .await
                        .write_all(format!("{response}\n").as_bytes())
                        .await
                        .unwrap();
                    pending.fetch_sub(1, Ordering::SeqCst);
                    changed.notify_one();
                });
                continue;
            }
            let result = match method {
                "connection.open" => {
                    json!({"protocolVersion":"areal.runtime.v0","runtimeEpoch":epoch,"connectionId":"fixture","rootScopeId":root,"capabilities":{"methods":["scope.check","fs.execute"]}})
                }
                "scope.check" => json!({"available":true}),
                "scope.get" => scope.clone(),
                "scope.create" => {
                    created.fetch_add(1, Ordering::SeqCst);
                    scope.clone()
                }
                "scope.revoke" => {
                    revoked.cancel();
                    scope.clone()
                }
                "scope.waitClosed" => {
                    while pending.load(Ordering::SeqCst) != 0 {
                        changed.notified().await;
                    }
                    cleaned.fetch_add(1, Ordering::SeqCst);
                    let mut result = scope.clone();
                    result["state"] = json!("closed");
                    result
                }
                "connection.close" => json!({"closed":true}),
                _ => panic!("unexpected Runtime method {method}"),
            };
            writer
                .lock()
                .await
                .write_all(format!("{}\n", json!({"id":request["id"],"result":result})).as_bytes())
                .await
                .unwrap();
            if method == "connection.close" {
                break;
            }
        }
    });
    Runtime {
        client: Client::connect(read, write).await.unwrap(),
        seen: received,
        scopes,
        closed,
        task,
    }
}

fn call(name: &str, path: &str) -> ToolCall {
    let arguments = if name == "fs_create" {
        json!({"path":format!("workspace://repo/{path}"),"text":"new"})
    } else {
        json!({"path":format!("workspace://repo/{path}")})
    };
    ToolCall {
        id: path.into(),
        name: name.into(),
        arguments: arguments.to_string(),
    }
}

async fn open(
    dir: &Path,
    calls: Vec<ToolCall>,
    limits: Limits,
    extensions: ToolExtensions,
) -> (Arc<Engine>, Arc<BatchModel>, Runtime, String, String) {
    open_with_mode(dir, calls, limits, extensions, false).await
}

async fn open_with_mode(
    dir: &Path,
    calls: Vec<ToolCall>,
    limits: Limits,
    extensions: ToolExtensions,
    sequential: bool,
) -> (Arc<Engine>, Arc<BatchModel>, Runtime, String, String) {
    let data = dir.join("data");
    let workspace = dir.join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let runtime = runtime(&data).await;
    let model = Arc::new(BatchModel {
        expected_results: AtomicUsize::new(calls.len()),
        received: Mutex::new(Vec::new()),
        declarations: Mutex::new(Vec::new()),
        calls,
        sequential,
        requests: AtomicUsize::new(0),
        input_bytes: AtomicUsize::new(0),
    });
    let engine = Engine::open_with_extensions(
        &data,
        model.clone(),
        limits,
        Some(RuntimeConfig {
            client: runtime.client.clone(),
            workspace: workspace.clone(),
            writable: true,
            command_scope: None,
            command_scratch: None,
        }),
        extensions,
    )
    .unwrap();
    let thread = engine
        .create(workspace.to_str().unwrap().into())
        .await
        .unwrap();
    let turn = engine
        .start(&thread.id, vec![Input::text("inspect files")])
        .await
        .unwrap();
    (engine, model, runtime, thread.id, turn.id)
}

fn parallel() -> ToolExtensions {
    ToolExtensions {
        policy: ToolPolicy {
            parallel_read_calls: 2,
            ..Default::default()
        },
        ..Default::default()
    }
}

async fn close(engine: Arc<Engine>, runtime: Runtime) {
    engine.shutdown().await;
    runtime.client.shutdown().await.unwrap();
    bounded(runtime.task).await.unwrap();
}

#[tokio::test]
async fn reads_overlap_without_reordering_history_or_crossing_write_barriers() {
    let dir = tempfile::tempdir().unwrap();
    let calls = vec![
        call("fs_read", "a"),
        call("fs_read", "b"),
        call("fs_create", "c"),
        call("fs_stat", "d"),
        call("fs_stat", "e"),
    ];
    let (engine, model, mut runtime, thread, _) =
        open(dir.path(), calls, Limits::default(), parallel()).await;
    let (a, b) = runtime.pair("/a", "/b").await;
    b.succeed();
    runtime.assert_no_dispatch().await;
    a.succeed();
    let write = runtime.next().await;
    assert!(write.path().ends_with("/c"));
    runtime.assert_no_dispatch().await;
    write.succeed();
    let (d, e) = runtime.pair("/d", "/e").await;
    e.succeed();
    d.succeed();
    let done = bounded(engine.wait(&thread)).await.unwrap();
    assert_eq!(done.turns[0].status, TurnStatus::Completed);
    assert_eq!(model.requests.load(Ordering::SeqCst), 2);
    // All calls share one authority/base pair for the Turn.
    assert_eq!(runtime.scopes.load(Ordering::SeqCst), 2);
    assert_eq!(runtime.closed.load(Ordering::SeqCst), 1);
    let ids: Vec<_> = done.turns[0]
        .items
        .iter()
        .filter_map(|item| match item {
            Item::DynamicToolCall {
                call_id, execution, ..
            } => {
                assert_eq!(execution.outcome, ToolOutcome::Succeeded);
                Some(call_id.as_str())
            }
            _ => None,
        })
        .collect();
    assert_eq!(ids, ["a", "b", "c", "d", "e"]);
    close(engine, runtime).await;
}

#[tokio::test]
async fn safe_reads_refill_a_free_slot_before_the_slowest_read_finishes() {
    let dir = tempfile::tempdir().unwrap();
    let calls = vec![
        call("fs_stat", "a"),
        call("fs_stat", "b"),
        call("fs_stat", "c"),
        call("fs_stat", "d"),
        call("fs_create", "e"),
    ];
    let (engine, _, mut runtime, thread, _) =
        open(dir.path(), calls, Limits::default(), parallel()).await;
    let (a, b) = runtime.pair("/a", "/b").await;
    runtime.assert_no_dispatch().await;
    b.succeed();
    let c = runtime.next().await;
    assert!(c.path().ends_with("/c"));
    runtime.assert_no_dispatch().await;
    c.succeed();
    let d = runtime.next().await;
    assert!(d.path().ends_with("/d"));
    d.succeed();
    runtime.assert_no_dispatch().await;
    a.succeed();
    let write = runtime.next().await;
    assert!(write.path().ends_with("/e"));
    write.succeed();
    let done = bounded(engine.wait(&thread)).await.unwrap();
    assert_eq!(done.turns[0].status, TurnStatus::Completed);
    let ids: Vec<_> = done.turns[0]
        .items
        .iter()
        .filter_map(|item| match item {
            Item::DynamicToolCall { call_id, .. } => Some(call_id.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(ids, ["a", "b", "c", "d", "e"]);
    close(engine, runtime).await;
}

#[tokio::test]
async fn defaults_finite_output_repeated_failure_limits_and_hooks_keep_serial_execution() {
    for case in 0..4 {
        let dir = tempfile::tempdir().unwrap();
        let mut extensions = parallel();
        let mut limits = Limits::default();
        match case {
            0 => extensions = ToolExtensions::default(),
            1 => limits.max_output_bytes = 1_000_000,
            2 => limits.max_repeated_tool_failures = 2,
            _ => extensions.hooks.push(HookDefinition {
                name: "matching".into(),
                event: HookEvent::PostToolUseFailure,
                matcher: "*".into(),
                argv: vec!["/bin/true".into()],
                timeout_ms: 1000,
            }),
        }
        let (engine, _, mut runtime, thread, _) = open(
            dir.path(),
            vec![call("fs_stat", "a"), call("fs_stat", "b")],
            limits,
            extensions,
        )
        .await;
        let first = runtime.next().await;
        runtime.assert_no_dispatch().await;
        first.succeed();
        runtime.next().await.succeed();
        assert_eq!(
            bounded(engine.wait(&thread)).await.unwrap().turns[0].status,
            TurnStatus::Completed
        );
        close(engine, runtime).await;
    }
}

#[tokio::test]
async fn finite_output_reserves_receipts_and_reuses_settled_capacity_for_parallel_reads() {
    let dir = tempfile::tempdir().unwrap();
    let limits = Limits {
        max_output_bytes: 16 * 1024 * 1024,
        ..Limits::default()
    };
    let (engine, _, mut runtime, thread, _) = open(
        dir.path(),
        vec![
            call("fs_stat", "a"),
            call("fs_stat", "b"),
            call("fs_stat", "c"),
        ],
        limits,
        parallel(),
    )
    .await;
    let first = runtime.next().await;
    let second = runtime.next().await;
    runtime.assert_no_dispatch().await;
    second.succeed();
    let replacement = runtime.next().await;
    assert!(replacement.path().ends_with("/c"));
    first.succeed();
    replacement.succeed();
    let done = bounded(engine.wait(&thread)).await.unwrap();
    assert_eq!(done.turns[0].status, TurnStatus::Completed);
    let bytes = done.turns[0]
        .items
        .iter()
        .filter(|item| matches!(item, Item::DynamicToolCall { .. }))
        .map(|item| serde_json::to_vec(item).unwrap().len())
        .sum::<usize>();
    assert!(bytes < 16 * 1024 * 1024);
    close(engine, runtime).await;
}

#[tokio::test]
async fn finite_parallel_budget_keeps_settled_results_and_does_not_admit_unaffordable_reads() {
    let dir = tempfile::tempdir().unwrap();
    let limits = Limits {
        max_output_bytes: 60 * 1024,
        ..Limits::default()
    };
    let mut unaffordable = call("fs_stat", &"unexecuted".repeat(2 * 1024));
    unaffordable.id = "unexecuted".into();
    let (engine, model, mut runtime, thread, _) = open(
        dir.path(),
        vec![call("fs_stat", "a"), call("fs_stat", "b"), unaffordable],
        limits,
        parallel(),
    )
    .await;
    model.expected_results.store(2, Ordering::SeqCst);
    let first = runtime.next().await;
    runtime.assert_no_dispatch().await;
    first.succeed();
    runtime.next().await.succeed();
    let done = bounded(engine.wait(&thread)).await.unwrap();
    assert_eq!(done.turns[0].status, TurnStatus::Completed);
    let calls = done.turns[0]
        .items
        .iter()
        .filter_map(|item| match item {
            Item::DynamicToolCall {
                call_id, execution, ..
            } => {
                assert_eq!(execution.outcome, ToolOutcome::Succeeded);
                Some(call_id.as_str())
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(calls, ["a", "b"]);
    assert_eq!(model.requests.load(Ordering::SeqCst), 2);
    close(engine, runtime).await;
}

#[tokio::test]
async fn an_unmatched_write_hook_does_not_serialize_trusted_reads() {
    let dir = tempfile::tempdir().unwrap();
    let mut extensions = parallel();
    extensions.hooks.push(HookDefinition {
        name: "write-only".into(),
        event: HookEvent::PreToolUse,
        matcher: "fs_create".into(),
        argv: vec!["/bin/true".into()],
        timeout_ms: 1000,
    });
    let (engine, _, mut runtime, thread, _) = open(
        dir.path(),
        vec![call("fs_stat", "a"), call("fs_stat", "b")],
        Limits::default(),
        extensions,
    )
    .await;
    let (a, b) = runtime.pair("/a", "/b").await;
    b.succeed();
    a.succeed();
    assert_eq!(
        bounded(engine.wait(&thread)).await.unwrap().turns[0].status,
        TurnStatus::Completed
    );
    close(engine, runtime).await;
}

#[tokio::test]
async fn unknown_waits_for_other_inflight_reads_and_never_dispatches_the_following_write() {
    for max_output_bytes in [0, 16 * 1024 * 1024] {
        let dir = tempfile::tempdir().unwrap();
        let (engine, model, mut runtime, thread, _) = open(
            dir.path(),
            vec![
                call("fs_stat", "a"),
                call("fs_stat", "b"),
                call("fs_stat", "c"),
                call("fs_create", "d"),
            ],
            Limits {
                max_output_bytes,
                ..Limits::default()
            },
            parallel(),
        )
        .await;
        let (first, second) = runtime.pair("/a", "/b").await;
        second.unknown();
        runtime.assert_no_dispatch().await;
        first.succeed();
        let done = bounded(engine.wait(&thread)).await.unwrap();
        assert_eq!(done.turns[0].status, TurnStatus::Failed);
        let outcomes: Vec<_> = done.turns[0]
            .items
            .iter()
            .filter_map(|item| match item {
                Item::DynamicToolCall { execution, .. } => Some(execution.outcome.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(outcomes, [ToolOutcome::Succeeded, ToolOutcome::Unknown]);
        assert_eq!(model.requests.load(Ordering::SeqCst), 1);
        assert!(runtime.seen.try_recv().is_err());
        close(engine, runtime).await;
    }
}

#[tokio::test]
async fn cancellation_settles_all_parallel_reads_before_scope_cleanup_without_replay() {
    for max_output_bytes in [0, 16 * 1024 * 1024] {
        let dir = tempfile::tempdir().unwrap();
        let (engine, model, mut runtime, thread, turn) = open(
            dir.path(),
            vec![
                call("fs_stat", "a"),
                call("fs_stat", "b"),
                call("fs_stat", "c"),
            ],
            Limits {
                max_output_bytes,
                ..Limits::default()
            },
            parallel(),
        )
        .await;
        let _first = runtime.next().await;
        let _second = runtime.next().await;
        engine.interrupt(&thread, &turn).await.unwrap();
        let done = bounded(engine.wait(&thread)).await.unwrap();
        assert_eq!(done.turns[0].status, TurnStatus::Failed);
        let outcomes: Vec<_> = done.turns[0]
            .items
            .iter()
            .filter_map(|item| match item {
                Item::DynamicToolCall { execution, .. } => Some(execution.outcome.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(outcomes, [ToolOutcome::Unknown, ToolOutcome::Unknown]);
        assert_eq!(runtime.closed.load(Ordering::SeqCst), 1);
        assert_eq!(model.requests.load(Ordering::SeqCst), 1);
        assert!(runtime.seen.try_recv().is_err());
        close(engine, runtime).await;
    }
}

fn program(code: &str) -> ToolCall {
    ToolCall {
        id: "program-parent".into(),
        name: "tool_program".into(),
        arguments: json!({"code":code}).to_string(),
    }
}
fn program_policy() -> ToolExtensions {
    ToolExtensions {
        policy: ToolPolicy {
            programmatic_tools: true,
            programmatic_tools_only: true,
            ..Default::default()
        },
        ..Default::default()
    }
}

#[tokio::test]
async fn dependent_program_removes_a_model_round_with_identical_native_work_and_budget() {
    let mut costs = Vec::new();
    let mut operations = Vec::new();
    for composed in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let calls = if composed {
            vec![program(
                "const a=await tools.fs_read({path:'workspace://repo/a'}); const b=await tools.fs_stat({path:a.data.text}); text(b);",
            )]
        } else {
            vec![
                ToolCall {
                    id: "read-a".into(),
                    name: "fs_read".into(),
                    arguments: json!({"path":"workspace://repo/a"}).to_string(),
                },
                ToolCall {
                    id: "stat-a".into(),
                    name: "fs_stat".into(),
                    arguments: json!({"path":"workspace://repo/a"}).to_string(),
                },
            ]
        };
        let extensions = ToolExtensions {
            policy: ToolPolicy {
                programmatic_tools: composed,
                ..Default::default()
            },
            ..Default::default()
        };
        let (engine, model, mut runtime, thread, _) =
            open_with_mode(dir.path(), calls, Limits::default(), extensions, !composed).await;
        for _ in 0..2 {
            runtime.next().await.succeed();
        }
        let done = bounded(engine.wait(&thread)).await.unwrap();
        assert_eq!(
            done.turns[0].status,
            TurnStatus::Completed,
            "{:?}",
            done.turns[0].error
        );
        assert!(runtime.seen.try_recv().is_err());
        operations.push(
            done.turns[0]
                .items
                .iter()
                .filter_map(|i| match i {
                    Item::DynamicToolCall {
                        tool,
                        arguments,
                        success,
                        ..
                    } if tool != "tool_program" => {
                        Some((tool.clone(), arguments.clone(), *success))
                    }
                    _ => None,
                })
                .collect::<Vec<_>>(),
        );
        costs.push((
            model.requests.load(Ordering::SeqCst),
            model.input_bytes.load(Ordering::SeqCst),
        ));
        close(engine, runtime).await;
    }
    assert_eq!(operations[0], operations[1]);
    assert_eq!(costs[0].0, 3);
    assert_eq!(costs[1].0, 2);
    assert!(
        costs[1].1 < costs[0].1,
        "include program schema/code overhead in the comparison: {costs:?}"
    );
    eprintln!(
        "same two native operations: sequential requests/inputBytes={:?}; composed={:?}; byte counts are not provider tokens",
        costs[0], costs[1]
    );
}

#[tokio::test]
async fn default_program_archives_large_output_and_finishes_the_same_native_steps_once() {
    let dir = tempfile::tempdir().unwrap();
    let code = "const a=await tools.fs_stat({path:'workspace://repo/a'}); text('evidence '.repeat(4000)); const b=await tools.fs_stat({path:'workspace://repo/b'});text(b);";
    let (engine, model, mut runtime, thread, _) = open(
        dir.path(),
        vec![program(code)],
        Limits::default(),
        ToolExtensions::default(),
    )
    .await;
    let a = runtime.next().await;
    assert!(a.path().ends_with("/a"));
    a.succeed();
    let b = runtime.next().await;
    assert!(b.path().ends_with("/b"));
    b.succeed();
    let done = bounded(engine.wait(&thread)).await.unwrap();
    assert_eq!(
        done.turns[0].status,
        TurnStatus::Completed,
        "{:?}",
        done.turns[0].error
    );
    assert_eq!(model.requests.load(Ordering::SeqCst), 2);
    let calls: Vec<_> = done.turns[0]
        .items
        .iter()
        .filter_map(|item| match item {
            Item::DynamicToolCall {
                tool,
                success,
                execution,
                ..
            } => Some((tool, success, execution)),
            _ => None,
        })
        .collect();
    assert_eq!(calls.len(), 3);
    assert!(calls.iter().all(|(_, success, _)| **success == Some(true)));
    assert!(
        calls
            .iter()
            .find(|(name, _, _)| *name == "tool_program")
            .unwrap()
            .2
            .result_snapshot
            .is_some()
    );
    assert!(runtime.seen.try_recv().is_err());
    let messages = model.received.lock().await;
    let result = messages
        .iter()
        .find(|m| m.role == "tool")
        .unwrap()
        .text_content();
    assert!(result.contains("selectedOutputTruncated"));
    assert!(result.contains("read_tool_result"));
    assert!(
        result.len() < 20000,
        "preview must actually reach the model: {}",
        result.len()
    );
    drop(messages);
    let definitions = model.declarations.lock().await;
    assert!(
        definitions
            .iter()
            .any(|d| d["function"]["name"] == "fs_stat")
    );
    let description = definitions
        .iter()
        .find(|d| d["function"]["name"] == "tool_program")
        .unwrap()["function"]["description"]
        .as_str()
        .unwrap();
    assert!(description.contains("fs_stat"));
    assert!(
        !description.contains("\"parameters\""),
        "default catalog must not duplicate schemas"
    );
    drop(definitions);
    close(engine, runtime).await;
}

#[tokio::test]
async fn program_composes_return_values_keeps_journals_and_projects_only_selected_observations() {
    let dir = tempfile::tempdir().unwrap();
    let (engine,model,mut runtime,thread,_)=open(dir.path(),vec![program("const a=await tools.fs_read({path:'workspace://repo/a'}); const b=await tools.fs_stat({path:a.data.text}); text({selected:b.data.size});")],Limits::default(),program_policy()).await;
    let a = runtime.next().await;
    assert!(a.path().ends_with("/a"));
    a.succeed();
    let b = runtime.next().await;
    assert!(b.path().ends_with("/a"));
    b.succeed();
    let done = bounded(engine.wait(&thread)).await.unwrap();
    assert_eq!(done.turns[0].status, TurnStatus::Completed);
    assert_eq!(model.requests.load(Ordering::SeqCst), 2);
    let children:Vec<_>=done.turns[0].items.iter().filter(|i|matches!(i,Item::DynamicToolCall{execution,..} if execution.parent_call_id.as_deref()==Some("program-parent"))).collect();
    assert_eq!(children.len(), 2);
    let messages = model.received.lock().await;
    let results: Vec<_> = messages.iter().filter(|m| m.role == "tool").collect();
    assert_eq!(results.len(), 1);
    assert!(results[0].text_content().contains("selected"));
    assert!(!results[0].text_content().contains("workspace://repo/a"));
    drop(messages);
    let definitions = model.declarations.lock().await;
    assert!(
        definitions
            .iter()
            .any(|d| d["function"]["name"] == "tool_program")
    );
    assert!(
        !definitions
            .iter()
            .any(|d| d["function"]["name"] == "fs_read")
    );
    drop(definitions);
    close(engine, runtime).await;
}

#[tokio::test]
async fn program_unknown_cannot_be_caught_to_submit_another_effect() {
    let dir = tempfile::tempdir().unwrap();
    let (engine,model,mut runtime,thread,_)=open(dir.path(),vec![program("try {await tools.fs_stat({path:'workspace://repo/a'});} catch(e) {} await tools.fs_create({path:'workspace://repo/must-not-exist',text:'x'});")],Limits::default(),program_policy()).await;
    runtime.next().await.unknown();
    let done = bounded(engine.wait(&thread)).await.unwrap();
    assert_eq!(done.turns[0].status, TurnStatus::Failed);
    assert_eq!(model.requests.load(Ordering::SeqCst), 1);
    let outcomes: Vec<_> = done.turns[0]
        .items
        .iter()
        .filter_map(|i| match i {
            Item::DynamicToolCall { execution, .. } => Some(&execution.outcome),
            _ => None,
        })
        .collect();
    assert_eq!(outcomes, vec![&ToolOutcome::Unknown, &ToolOutcome::Unknown]);
    assert!(runtime.seen.try_recv().is_err());
    close(engine, runtime).await;
}

#[tokio::test]
async fn program_cancel_settles_children_and_does_not_replay_tail() {
    let dir = tempfile::tempdir().unwrap();
    let (engine,_,mut runtime,thread,turn)=open(dir.path(),vec![program("await tools.fs_stat({path:'workspace://repo/a'});await tools.fs_create({path:'workspace://repo/tail',text:'x'});")],Limits::default(),program_policy()).await;
    let _pending = runtime.next().await;
    engine.interrupt(&thread, &turn).await.unwrap();
    let done = bounded(engine.wait(&thread)).await.unwrap();
    assert_ne!(done.turns[0].status, TurnStatus::Completed);
    assert!(runtime.seen.try_recv().is_err());
    assert_eq!(runtime.closed.load(Ordering::SeqCst), 1);
    close(engine, runtime).await;
}

#[tokio::test]
async fn program_children_share_tool_budget_and_invalid_arguments_never_dispatch() {
    for invalid in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let code = if invalid {
            "const a=await tools.fs_stat({unexpected:true});text(a);"
        } else {
            "await tools.fs_stat({path:'workspace://repo/a'});await tools.fs_stat({path:'workspace://repo/b'});"
        };
        let limits = Limits {
            max_tool_calls: 2,
            ..Limits::default()
        };
        let (engine, _, mut runtime, thread, _) =
            open(dir.path(), vec![program(code)], limits, program_policy()).await;
        if !invalid {
            runtime.next().await.succeed();
        }
        let done = bounded(engine.wait(&thread)).await.unwrap();
        let children=done.turns[0].items.iter().filter(|i|matches!(i,Item::DynamicToolCall{execution,..} if execution.parent_call_id.is_some())).count();
        assert_eq!(children, 1);
        assert!(runtime.seen.try_recv().is_err());
        close(engine, runtime).await;
    }
}

fn edits(files: Value) -> ToolCall {
    ToolCall {
        id: "batch-parent".into(),
        name: "edit_files".into(),
        arguments: json!({"files":files}).to_string(),
    }
}

fn edit_receipt(thread: &areal_protocol::Thread) -> Value {
    thread.turns[0]
        .items
        .iter()
        .find_map(|item| match item {
            Item::DynamicToolCall {
                tool,
                content_items: Some(content),
                ..
            } if tool == "edit_files" => {
                Some(serde_json::from_str(content[0]["text"].as_str().unwrap()).unwrap())
            }
            _ => None,
        })
        .unwrap()
}

#[tokio::test]
async fn edits_keep_native_receipts_without_requiring_programmatic_tools() {
    let dir = tempfile::tempdir().unwrap();
    let extensions = ToolExtensions {
        policy: ToolPolicy {
            programmatic_tools: false,
            ..Default::default()
        },
        ..Default::default()
    };
    let (engine, model, mut runtime, thread, _) = open(
        dir.path(),
        vec![edits(json!([
            {"path":"a","text":"first"},{"path":"b","text":"second"}
        ]))],
        Limits::default(),
        extensions,
    )
    .await;
    for expected in ["workspace://repo/a", "workspace://repo/b"] {
        let next = runtime.next().await;
        assert_eq!(next.path(), expected);
        assert_eq!(next.request["params"]["command"]["kind"], "write");
        assert_eq!(
            next.request["params"]["command"]["expected"]["kind"],
            "absent"
        );
        next.succeed();
    }
    let done = bounded(engine.wait(&thread)).await.unwrap();
    assert_eq!(done.turns[0].status, TurnStatus::Completed);
    let receipt = edit_receipt(&done);
    assert_eq!(receipt["allApplied"], true);
    for file in receipt["files"].as_array().unwrap() {
        assert_eq!(file["status"], "APPLIED");
        assert!(file["receipt"]["itemId"].is_string());
        assert!(file["receipt"].get("text").is_none());
        assert!(file["receipt"]["data"]["fileVersion"].is_string());
    }
    assert_eq!(model.requests.load(Ordering::SeqCst), 2);
    assert!(
        !model
            .declarations
            .lock()
            .await
            .iter()
            .any(|d| d["function"]["name"] == "tool_program")
    );
    assert!(runtime.seen.try_recv().is_err());
    close(engine, runtime).await;
}

#[tokio::test]
async fn edits_stop_on_conflict_permission_or_unknown_and_never_replay_applied_files() {
    for code in ["CONFLICT", "PERMISSION_DENIED", "UNAVAILABLE"] {
        let dir = tempfile::tempdir().unwrap();
        let (engine, _, mut runtime, thread, _) = open(
            dir.path(),
            vec![edits(json!([
                {"path":"a","text":"first"},{"path":"b","text":"second"},{"path":"c","text":"tail"}
            ]))],
            Limits::default(),
            ToolExtensions::default(),
        )
        .await;
        runtime.next().await.succeed();
        runtime
            .next()
            .await
            .release
            .send(json!({"error":{"code":code,"message":"fixture boundary"}}))
            .unwrap();
        let done = bounded(engine.wait(&thread)).await.unwrap();
        let receipt = edit_receipt(&done);
        let statuses: Vec<_> = receipt["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["status"].as_str().unwrap())
            .collect();
        assert_eq!(
            statuses,
            vec![
                "APPLIED",
                if code == "UNAVAILABLE" {
                    "UNKNOWN"
                } else {
                    "FAILED"
                },
                "NOT_RUN"
            ]
        );
        assert_eq!(receipt["allApplied"], false);
        assert!(runtime.seen.try_recv().is_err());
        close(engine, runtime).await;
    }
}

#[tokio::test]
async fn edits_reject_unobserved_patch_and_invalid_or_duplicate_batch_before_writes() {
    for files in [
        json!([{"path":"a","patches":[{"oldText":"old","newText":"new"}]},{"path":"tail","text":"x"}]),
        json!([{"path":"a","text":"x"},{"path":"workspace://repo/a","text":"y"}]),
        json!([{"path":"a","text":"x"},{"path":"b","patches":[]}]),
        json!([{"path":"a","text":"x","patches":[{"oldText":"x","newText":"y"}]}]),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let (engine, _, mut runtime, thread, _) = open(
            dir.path(),
            vec![edits(files)],
            Limits::default(),
            ToolExtensions::default(),
        )
        .await;
        let done = bounded(engine.wait(&thread)).await.unwrap();
        assert_eq!(edit_receipt(&done)["allApplied"], false);
        assert!(runtime.seen.try_recv().is_err());
        close(engine, runtime).await;
    }
}

#[tokio::test]
async fn edits_share_budget_and_preserve_partial_receipts_on_cancellation() {
    for cancelled in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let limits = Limits {
            max_tool_calls: if cancelled { 20 } else { 2 },
            ..Limits::default()
        };
        let (engine, _, mut runtime, thread, turn) = open(
            dir.path(),
            vec![edits(json!([
                {"path":"a","text":"x"},{"path":"b","text":"y"},{"path":"c","text":"z"}
            ]))],
            limits,
            ToolExtensions::default(),
        )
        .await;
        runtime.next().await.succeed();
        let pending = if cancelled {
            let pending = runtime.next().await;
            engine.interrupt(&thread, &turn).await.unwrap();
            Some(pending)
        } else {
            None
        };
        let done = bounded(engine.wait(&thread)).await.unwrap();
        let receipt = edit_receipt(&done);
        assert_eq!(receipt["files"][0]["status"], "APPLIED");
        assert_eq!(
            receipt["files"][1]["status"],
            if cancelled { "UNKNOWN" } else { "NOT_RUN" }
        );
        assert_eq!(receipt["files"][2]["status"], "NOT_RUN");
        assert!(runtime.seen.try_recv().is_err());
        drop(pending);
        close(engine, runtime).await;
    }
}

#[tokio::test]
async fn program_composes_batch_edits_without_exposing_child_calls_as_model_calls() {
    let dir = tempfile::tempdir().unwrap();
    let (engine, model, mut runtime, thread, _) = open(dir.path(), vec![program(
        "const e=await tools.edit_files({files:[{path:'a',text:'x'},{path:'b',text:'y'}]});text(e);if(e.success && e.data.allApplied)text(await tools.fs_stat({path:'b'}));"
    )], Limits::default(), program_policy()).await;
    for _ in 0..3 {
        runtime.next().await.succeed();
    }
    let done = bounded(engine.wait(&thread)).await.unwrap();
    assert_eq!(done.turns[0].status, TurnStatus::Completed);
    assert_eq!(model.requests.load(Ordering::SeqCst), 2);
    assert_eq!(
        done.turns[0]
            .items
            .iter()
            .filter(|i| matches!(i, Item::DynamicToolCall { .. }))
            .count(),
        5
    );
    assert!(runtime.seen.try_recv().is_err());
    close(engine, runtime).await;
}

#[tokio::test]
async fn empty_instruction_chain_reports_checked_scope_and_leaves_descendants_unclaimed() {
    let dir = tempfile::tempdir().unwrap();
    let (engine, model, runtime, thread, _) = open(
        dir.path(),
        vec![],
        Limits::default(),
        ToolExtensions::default(),
    )
    .await;
    let done = bounded(engine.wait(&thread)).await.unwrap();
    assert_eq!(done.turns[0].status, TurnStatus::Completed);
    let messages = model.received.lock().await;
    let text = messages
        .iter()
        .map(Message::text_content)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        text.contains("workspaceRoot")
            && text.contains("sessionCwd")
            && text.contains("commandDefaultCwd")
    );
    assert!(text.contains("\"path\":\"AGENTS.override.md\",\"state\":\"missing\""));
    assert!(text.contains("\"path\":\"AGENTS.md\",\"state\":\"missing\""));
    assert!(text.contains("descendants and paths outside this chain are not certified"));
    assert_eq!(runtime.scopes.load(Ordering::SeqCst), 0);
    drop(messages);
    close(engine, runtime).await;
}

#[tokio::test]
async fn batch_children_cannot_bypass_program_call_bound() {
    let dir = tempfile::tempdir().unwrap();
    let (engine, _, mut runtime, thread, _) = open(dir.path(), vec![program(
        "for(let batch=0;batch<4;batch++){const files=[];for(let i=0;i<16;i++)files.push({path:`f-${batch}-${i}`,text:'x'});await tools.edit_files({files});}"
    )], Limits::default(), program_policy()).await;
    // 3 × (容器 1 + 文件 16) = 51；第四批整体超出 64，不能在内部偷增额度。
    for _ in 0..48 {
        runtime.next().await.succeed();
    }
    let done = bounded(engine.wait(&thread)).await.unwrap();
    assert_eq!(
        done.turns[0]
            .items
            .iter()
            .filter(|i| matches!(i, Item::DynamicToolCall {tool, ..} if tool == "fs_create"))
            .count(),
        48
    );
    assert!(runtime.seen.try_recv().is_err());
    close(engine, runtime).await;
}
