use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelStream},
};
use areal_protocol::{Input, Item, Thread, ThreadStatus, Turn, TurnStatus};
use async_trait::async_trait;
use futures_util::{StreamExt, stream};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::mpsc;

#[tokio::test]
async fn historical_unknown_outcomes_preserve_inspection_without_blocking_service_drain() {
    use serde_json::{Value, json};

    for kind in ["tool", "toolHook", "sessionHook"] {
        let (dir, engine, model, _entered) = setup(Limits::default());
        let thread = engine.create("/workspace".into()).await.unwrap();
        engine
            .start(&thread.id, vec![Input::text("done")])
            .await
            .unwrap();
        settled(&engine, &thread.id).await;
        engine.shutdown().await;
        drop(engine);

        let path = dir.path().join(format!("{}.json", thread.id));
        let mut record: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        record["thread"]["desktop"] =
            serde_json::to_value(areal_protocol::desktop::DesktopState::default()).unwrap();
        if kind == "sessionHook" {
            record["thread"]["desktop"]["hookRuns"] = json!([{
                "id":"historical-hook", "pluginId":"fixture", "packageDigest":"fixture",
                "definitionDigest":"fixture", "event":"Stop", "turnId":null,
                "toolUseId":null, "operationId":"historical-operation", "outcome":"unknown",
                "asynchronous":false, "delivered":true, "output":null, "inspection":null
            }]);
        } else {
            record["thread"]["turns"][0]["items"].as_array_mut().unwrap().push(json!({
                "type":"dynamicToolCall", "id":"historical-tool", "tool":"external_write",
                "arguments":{}, "status":"failed", "success":false, "contentItems":[],
                "callId":"historical-call", "execution":{
                    "runtimeEpoch":"historical-epoch", "scopeId":"historical-scope",
                    "operationId":"historical-operation", "outcome":if kind == "tool" {"unknown"} else {"succeeded"},
                    "hooks":if kind == "toolHook" {json!([{"name":"fixture", "event":"post", "operationId":"historical-hook", "outcome":"unknown"}])} else {json!([])}
                }
            }));
        }
        let stored: Thread = serde_json::from_value(record["thread"].clone()).unwrap();
        record["thread"] = serde_json::to_value(stored).unwrap();
        let journal = record["thread"]["turns"].clone();
        let hooks = record["thread"]["desktop"]["hookRuns"].clone();
        std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        let engine = Engine::open(dir.path(), model.clone(), Limits::default()).unwrap();
        let status = engine.server_status().await;
        assert_eq!(status["resources"], json!([]), "{kind}: {status}");
        assert_eq!(
            status["unresolvedTools"].as_array().unwrap().len(),
            1,
            "{kind}"
        );
        assert_eq!(
            status["restartSafe"], true,
            "historical {kind} is not a live resource: {status}"
        );
        assert_eq!(status["lifecycle"]["settled"]["allowed"], true);
        assert_eq!(status["lifecycle"]["ifIdle"]["allowed"], true);
        assert_eq!(
            status["lifecycle"]["executionOutcomes"]["uninspectedUnknown"],
            1
        );
        let calls = model.calls.load(Ordering::SeqCst);
        let rejected = engine
            .start(&thread.id, vec![Input::text("must not replay")])
            .await
            .unwrap_err();
        assert!(rejected.to_string().contains("UNKNOWN"), "{rejected}");
        assert_eq!(model.calls.load(Ordering::SeqCst), calls);
        let next = engine.create("/fresh".into()).await.unwrap();
        engine
            .start(&next.id, vec![Input::text("fresh")])
            .await
            .unwrap();
        assert_eq!(
            settled(&engine, &next.id).await.turns[0].status,
            TurnStatus::Completed
        );
        let drained = engine.drain("ifIdle".into(), 1000).await.unwrap();
        assert_eq!(drained["restartSafe"], true, "{drained}");
        assert_eq!(drained["unresolvedTools"], status["unresolvedTools"]);
        let after: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(after["thread"]["turns"], journal);
        assert_eq!(after["thread"]["desktop"]["hookRuns"], hooks);
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn historical_process_cleanup_unknown_still_blocks_service_drain() {
    use serde_json::{Value, json};

    let (dir, engine, model, _entered) = setup(Limits::default());
    let thread = engine.create("/workspace".into()).await.unwrap();
    engine.shutdown().await;
    drop(engine);
    let path = dir.path().join(format!("{}.json", thread.id));
    let mut record: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    record["thread"]["desktop"] =
        serde_json::to_value(areal_protocol::desktop::DesktopState::default()).unwrap();
    record["thread"]["desktop"]["processes"] = json!([{
        "id":"unconfirmed-process", "runtimeEpoch":"old-epoch", "scopeOperationId":"scope-op",
        "scopeId":"old-scope", "operationId":"process-op", "processId":"old-process",
        "lifetime":"thread", "turnId":null, "owner":"fixture", "argv":["fixture"],
        "state":"unknown", "cleanupConfirmed":false, "error":"unconfirmed cleanup", "inputs":[]
    }]);
    std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    let engine = Engine::open(dir.path(), model, Limits::default()).unwrap();
    let status = engine.server_status().await;
    assert_eq!(status["restartSafe"], false);
    assert_eq!(
        status["lifecycle"]["settled"]["reasons"],
        json!([{"code":"resource", "count":1}])
    );
    assert!(engine.drain("ifIdle".into(), 1000).await.is_err());
    assert_eq!(engine.server_status().await["acceptingWork"], true);
    assert_eq!(
        engine.drain("cancel".into(), 1000).await.unwrap()["restartSafe"],
        false
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn runtime_resource_observation_blocks_unconfirmed_cleanup_and_active_processes() {
    use areal_engine::tools::RuntimeConfig;
    use areal_runtime_client::Client;
    use serde_json::{Value, json};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    for condition in [
        "clean",
        "active",
        "cleanupUnknown",
        "statusUnavailable",
        "scopeUnavailable",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let (pipe, peer) = tokio::io::duplex(128 * 1024);
        let (read, write) = tokio::io::split(pipe);
        let (peer_read, mut peer_write) = tokio::io::split(peer);
        let task = tokio::spawn(async move {
            let mut lines = BufReader::new(peer_read).lines();
            while let Some(line) = lines.next_line().await.unwrap() {
                let request: Value = serde_json::from_str(&line).unwrap();
                let result = match request["method"].as_str().unwrap() {
                    "connection.open" => {
                        json!({"protocolVersion":"areal.runtime.v0", "runtimeEpoch":"fixture", "connectionId":"fixture", "rootScopeId":"fixture-root", "capabilities":{"methods":["fs.execute"]}})
                    }
                    "runtime.status" if condition != "statusUnavailable" => {
                        json!({"runtimeEpoch":"fixture", "activeProcesses":if condition == "active" {1} else {0}})
                    }
                    "scope.get" if condition != "scopeUnavailable" => {
                        json!({"scopeId":"fixture-root", "parentScopeId":null, "state":"active", "owner":{"taskId":"fixture"}, "readRoots":[], "writeRoots":[], "network":"deny", "limits":{"wallTimeMs":30000,"outputBytes":8388608,"maxProcesses":4}, "activeProcesses":if condition == "active" {1} else {0}, "outputBytes":0, "cleanupError":if condition == "cleanupUnknown" {json!("executor cleanup unconfirmed")} else {Value::Null}})
                    }
                    "connection.close" => json!({"closed":true}),
                    "runtime.status" | "scope.get" => {
                        peer_write.write_all(format!("{}\n", json!({"id":request["id"], "error":{"code":"UNAVAILABLE", "message":"fixture unavailable"}})).as_bytes()).await.unwrap();
                        continue;
                    }
                    method => panic!("unexpected Runtime method {method}"),
                };
                peer_write
                    .write_all(
                        format!("{}\n", json!({"id":request["id"], "result":result})).as_bytes(),
                    )
                    .await
                    .unwrap();
                if request["method"] == "connection.close" {
                    break;
                }
            }
        });
        let client = Client::connect(read, write).await.unwrap();
        let (entered, _received) = mpsc::unbounded_channel();
        let engine = Engine::open_with_runtime(
            dir.path(),
            Arc::new(Controlled {
                entered,
                calls: AtomicUsize::new(0),
            }),
            Limits::default(),
            RuntimeConfig {
                client: client.clone(),
                workspace: workspace.path().to_path_buf(),
                writable: true,
                command_scope: None,
                command_scratch: None,
            },
        )
        .unwrap();
        let status = engine.server_status().await;
        assert_eq!(
            status["restartSafe"],
            condition == "clean",
            "{condition}: {status}"
        );
        assert_eq!(
            status["lifecycle"]["ifIdle"]["allowed"],
            condition == "clean"
        );
        if condition != "clean" {
            assert!(
                !status["resources"].as_array().unwrap().is_empty(),
                "{condition}: {status}"
            );
            assert!(engine.drain("ifIdle".into(), 1000).await.is_err());
        }
        engine.shutdown().await;
        client.shutdown().await.unwrap();
        task.await.unwrap();
    }
}

struct Controlled {
    entered: mpsc::UnboundedSender<Vec<Message>>,
    calls: AtomicUsize,
}
#[async_trait]
impl Model for Controlled {
    fn name(&self) -> &str {
        "controlled"
    }
    async fn stream(&self, messages: Vec<Message>) -> anyhow::Result<ModelStream> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let _ = self.entered.send(messages.clone());
        let content = messages.last().unwrap().text_content();
        if content == "panic" {
            panic!("fixture model panicked");
        } else if content == "stream-panic" {
            Ok(Box::pin(stream::once(async {
                panic!("fixture stream panicked")
            })))
        } else if content == "hold" {
            Ok(Box::pin(
                stream::once(async { Ok("prefix".into()) }).chain(stream::pending()),
            ))
        } else {
            Ok(Box::pin(stream::iter([Ok(
                format!("reply:{content}").into()
            )])))
        }
    }
}
fn setup(
    limits: Limits,
) -> (
    tempfile::TempDir,
    Arc<Engine>,
    Arc<Controlled>,
    mpsc::UnboundedReceiver<Vec<Message>>,
) {
    let dir = tempfile::tempdir().unwrap();
    let (tx, rx) = mpsc::unbounded_channel();
    let model = Arc::new(Controlled {
        entered: tx,
        calls: AtomicUsize::new(0),
    });
    let engine = Engine::open(dir.path(), model.clone(), limits).unwrap();
    (dir, engine, model, rx)
}
async fn settled(engine: &Engine, id: &str) -> areal_protocol::Thread {
    tokio::time::timeout(Duration::from_secs(5), engine.wait(id))
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_children_share_active_capacity_and_rejections_leave_no_threads() {
    let (dir, engine, _model, mut entered) = setup(Limits {
        max_active_turns: 3,
        model_concurrency: 1,
        ..Limits::default()
    });
    let root = engine.create("/workspace".into()).await.unwrap();
    let turn = engine
        .start(&root.id, vec![Input::text("hold")])
        .await
        .unwrap();
    entered.recv().await.unwrap();
    let mut attempts = tokio::task::JoinSet::new();
    for _ in 0..32 {
        let engine = engine.clone();
        let id = root.id.clone();
        attempts.spawn(async move { engine.spawn_child(&id, vec![Input::text("hold")]).await });
    }
    let mut accepted = Vec::new();
    while let Some(result) = attempts.join_next().await {
        match result.unwrap() {
            Ok(child) => accepted.push(child),
            Err(error) => assert!(matches!(error, areal_engine::Error::Exhausted(_))),
        }
    }
    assert_eq!(accepted.len(), 2);
    assert_eq!(engine.list(None, 100, None).await.unwrap().0.len(), 3);
    assert_eq!(
        std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|p| p.ok())
            .filter(|p| p.path().extension().is_some_and(|e| e == "json"))
            .count(),
        3
    );
    assert!(
        entered.try_recv().is_err(),
        "queued children must not bypass model quota"
    );
    // A model-queued child still consumes capacity; cancellation must release it
    // without waiting for the parent's occupied model permit.
    let (child, child_turn) = &accepted[0];
    engine.interrupt(&child.id, &child_turn.id).await.unwrap();
    settled(&engine, &child.id).await;
    engine
        .spawn_child(&root.id, vec![Input::text("hold")])
        .await
        .unwrap();
    engine.interrupt(&root.id, &turn.id).await.unwrap();
    settled(&engine, &root.id).await;
    let next = engine.create("/next".into()).await.unwrap();
    engine
        .start(&next.id, vec![Input::text("next")])
        .await
        .unwrap();
    assert_eq!(
        settled(&engine, &next.id).await.turns[0].status,
        TurnStatus::Completed
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn depth_and_lifetime_fanout_are_distinct_and_reset_only_with_parent_turn() {
    let (_dir, engine, _model, mut entered) = setup(Limits {
        max_children_per_turn: 1,
        max_agent_depth: 2,
        ..Limits::default()
    });
    let root = engine.create("/workspace".into()).await.unwrap();
    let root_turn = engine
        .start(&root.id, vec![Input::text("hold")])
        .await
        .unwrap();
    entered.recv().await.unwrap();
    let (child, _) = engine
        .spawn_child(&root.id, vec![Input::text("hold")])
        .await
        .unwrap();
    let (grandchild, grandchild_turn) = engine
        .spawn_child(&child.id, vec![Input::text("hold")])
        .await
        .unwrap();
    assert!(
        matches!(engine.spawn_child(&grandchild.id, vec![Input::text("hold")]).await,
                    Err(areal_engine::Error::Exhausted(message)) if message.contains("depth"))
    );
    engine
        .interrupt(&grandchild.id, &grandchild_turn.id)
        .await
        .unwrap();
    settled(&engine, &grandchild.id).await;
    assert!(
        matches!(engine.spawn_child(&child.id, vec![Input::text("hold")]).await,
                    Err(areal_engine::Error::Exhausted(message)) if message.contains("child limit"))
    );
    engine.interrupt(&root.id, &root_turn.id).await.unwrap();
    settled(&engine, &root.id).await;
    let next = engine
        .start(&root.id, vec![Input::text("hold")])
        .await
        .unwrap();
    engine
        .spawn_child(&root.id, vec![Input::text("done")])
        .await
        .unwrap();
    engine.interrupt(&root.id, &next.id).await.unwrap();
    settled(&engine, &root.id).await;
    engine.shutdown().await;
}

#[tokio::test]
async fn admission_write_failure_releases_active_slot_before_a_healthy_start() {
    let (dir, engine, _model, _entered) = setup(Limits {
        max_active_turns: 1,
        ..Limits::default()
    });
    let broken = engine.create("/broken".into()).await.unwrap();
    let path = dir.path().join(format!("{}.json", broken.id));
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert!(matches!(
        engine.start(&broken.id, vec![Input::text("hello")]).await,
        Err(areal_engine::Error::Storage(_))
    ));
    assert!(
        engine
            .read(&broken.id, true)
            .await
            .unwrap()
            .turns
            .is_empty()
    );
    let healthy = engine.create("/healthy".into()).await.unwrap();
    engine
        .start(&healthy.id, vec![Input::text("hello")])
        .await
        .unwrap();
    assert_eq!(
        settled(&engine, &healthy.id).await.turns[0].status,
        TurnStatus::Completed
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn unconfirmed_final_persistence_quarantines_capacity() {
    let (dir, engine, _model, mut entered) = setup(Limits {
        max_active_turns: 1,
        ..Limits::default()
    });
    let broken = engine.create("/broken".into()).await.unwrap();
    let other = engine.create("/other".into()).await.unwrap();
    let turn = engine
        .start(&broken.id, vec![Input::text("hold")])
        .await
        .unwrap();
    entered.recv().await.unwrap();
    let path = dir.path().join(format!("{}.json", broken.id));
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    engine.interrupt(&broken.id, &turn.id).await.unwrap();
    assert!(matches!(
        settled(&engine, &broken.id).await.status,
        ThreadStatus::SystemError
    ));
    assert!(matches!(
        engine.start(&other.id, vec![Input::text("hello")]).await,
        Err(areal_engine::Error::Exhausted(_))
    ));
    engine.shutdown().await;
}

#[tokio::test]
async fn restored_agent_ownership_rejects_cycles_missing_parents_and_wrong_sessions() {
    for defect in ["cycle", "missing", "session"] {
        let (dir, engine, model, mut entered) = setup(Limits::default());
        let root = engine.create("/workspace".into()).await.unwrap();
        let turn = engine
            .start(&root.id, vec![Input::text("hold")])
            .await
            .unwrap();
        entered.recv().await.unwrap();
        let (child, _) = engine
            .spawn_child(&root.id, vec![Input::text("done")])
            .await
            .unwrap();
        settled(&engine, &child.id).await;
        engine.interrupt(&root.id, &turn.id).await.unwrap();
        settled(&engine, &root.id).await;
        engine.shutdown().await;
        drop(engine);
        let path = dir.path().join(format!("{}.json", child.id));
        let original = std::fs::read(&path).unwrap();
        let mut record: serde_json::Value = serde_json::from_slice(&original).unwrap();
        match defect {
            "cycle" => record["thread"]["parentThreadId"] = child.id.into(),
            "missing" => {
                record["thread"]["parentThreadId"] = uuid::Uuid::new_v4().to_string().into()
            }
            _ => record["thread"]["sessionId"] = uuid::Uuid::new_v4().to_string().into(),
        }
        std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(
            Engine::open(dir.path(), model.clone(), Limits::default()).is_err(),
            "{defect}"
        );
        std::fs::write(path, original).unwrap();
        let restored = Engine::open(
            dir.path(),
            model,
            Limits {
                max_active_turns: 1,
                ..Limits::default()
            },
        )
        .unwrap();
        restored
            .start(&root.id, vec![Input::text("ok")])
            .await
            .unwrap();
        assert_eq!(
            settled(&restored, &root.id)
                .await
                .turns
                .last()
                .unwrap()
                .status,
            TurnStatus::Completed
        );
        restored.shutdown().await;
    }
}

#[tokio::test]
async fn multi_turn_history_survives_restart_and_store_has_single_owner() {
    let (dir, engine, model, mut entered) = setup(Limits::default());
    assert!(Engine::open(dir.path(), model.clone(), Limits::default()).is_err());
    let thread = engine.create("/workspace".into()).await.unwrap();
    engine
        .start(&thread.id, vec![Input::text("first")])
        .await
        .unwrap();
    settled(&engine, &thread.id).await;
    engine
        .start(&thread.id, vec![Input::text("second")])
        .await
        .unwrap();
    let before = settled(&engine, &thread.id).await;
    assert_eq!(before.turns.len(), 2);
    let first = entered.recv().await.unwrap();
    assert_eq!(
        first.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(),
        ["system", "user"]
    );
    let request = entered.recv().await.unwrap();
    assert_eq!(
        request.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(),
        ["system", "user", "assistant", "user"]
    );
    engine.shutdown().await;
    drop(engine);
    let restored = Engine::open(dir.path(), model, Limits::default()).unwrap();
    assert_eq!(
        serde_json::to_value(restored.read(&thread.id, true).await.unwrap()).unwrap(),
        serde_json::to_value(before).unwrap()
    );
    restored.shutdown().await;
}

#[tokio::test]
async fn cancel_queued_request_never_calls_model_and_releases_admission() {
    let (_dir, engine, model, mut entered) = setup(Limits {
        model_concurrency: 1,
        ..Limits::default()
    });
    let a = engine.create("/a".into()).await.unwrap();
    let b = engine.create("/b".into()).await.unwrap();
    let a_turn = engine
        .start(&a.id, vec![Input::text("hold")])
        .await
        .unwrap();
    entered.recv().await.unwrap();
    let b_turn = engine
        .start(&b.id, vec![Input::text("queued")])
        .await
        .unwrap();
    assert!(
        engine
            .start(&a.id, vec![Input::text("conflict")])
            .await
            .is_err()
    );
    engine.interrupt(&b.id, &b_turn.id).await.unwrap();
    assert_eq!(
        settled(&engine, &b.id).await.turns[0].status,
        TurnStatus::Interrupted
    );
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    engine.interrupt(&a.id, &a_turn.id).await.unwrap();
    settled(&engine, &a.id).await;
    engine
        .start(&b.id, vec![Input::text("next")])
        .await
        .unwrap();
    assert_eq!(
        settled(&engine, &b.id).await.turns.last().unwrap().status,
        TurnStatus::Completed
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn steering_restarts_stream_in_same_turn_and_items_complete_once() {
    let (_dir, engine, _model, mut entered) = setup(Limits::default());
    let thread = engine.create("/a".into()).await.unwrap();
    let mut events = engine.subscribe(&thread.id).await.unwrap();
    let turn = engine
        .start(&thread.id, vec![Input::text("hold")])
        .await
        .unwrap();
    entered.recv().await.unwrap();
    loop {
        if events.recv().await.unwrap()["method"] == "item/agentMessage/delta" {
            break;
        }
    }
    assert!(
        engine
            .steer(&thread.id, "wrong", vec![Input::text("wrong")])
            .await
            .is_err()
    );
    engine
        .steer(&thread.id, &turn.id, vec![Input::text("corrected")])
        .await
        .unwrap();
    let done = settled(&engine, &thread.id).await;
    assert_eq!(done.turns.len(), 1);
    assert_eq!(done.turns[0].id, turn.id);
    let second = entered.recv().await.unwrap();
    assert_eq!(second.last().unwrap().text_content(), "corrected");
    let mut completed = std::collections::HashSet::new();
    while let Ok(event) = events.try_recv() {
        if event["method"] == "item/completed" {
            assert!(completed.insert(event["params"]["item"]["id"].as_str().unwrap().to_owned()));
        }
    }
    for item in &done.turns[0].items {
        if matches!(item, Item::AgentMessage { .. }) {
            assert!(completed.contains(item.id()));
        }
    }
    engine.shutdown().await;
}

#[tokio::test]
async fn parent_cancellation_waits_for_nested_children() {
    let (_dir, engine, _model, mut entered) = setup(Limits::default());
    let parent = engine.create("/a".into()).await.unwrap();
    let turn = engine
        .start(&parent.id, vec![Input::text("hold")])
        .await
        .unwrap();
    entered.recv().await.unwrap();
    let (child, _) = engine
        .spawn_child(&parent.id, vec![Input::text("hold")])
        .await
        .unwrap();
    entered.recv().await.unwrap();
    let (grandchild, _) = engine
        .spawn_child(&child.id, vec![Input::text("hold")])
        .await
        .unwrap();
    entered.recv().await.unwrap();
    assert_eq!(child.session_id, parent.session_id);
    assert_eq!(
        grandchild.parent_thread_id.as_deref(),
        Some(child.id.as_str())
    );
    engine.interrupt(&parent.id, &turn.id).await.unwrap();
    settled(&engine, &parent.id).await;
    for id in [&child.id, &grandchild.id] {
        assert_eq!(
            engine.read(id, true).await.unwrap().turns[0].status,
            TurnStatus::Interrupted
        );
    }
    assert!(
        engine
            .spawn_child(&parent.id, vec![Input::text("late")])
            .await
            .is_err()
    );
    assert!(
        engine
            .start(&child.id, vec![Input::text("detached")])
            .await
            .is_err()
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn model_panics_settle_the_turn_and_release_the_permit() {
    let (_dir, engine, _model, _entered) = setup(Limits {
        model_concurrency: 1,
        ..Limits::default()
    });
    let thread = engine.create("/a".into()).await.unwrap();
    for prompt in ["panic", "stream-panic", "healthy"] {
        engine
            .start(&thread.id, vec![Input::text(prompt)])
            .await
            .unwrap();
        let done = settled(&engine, &thread.id).await;
        let turn = done.turns.last().unwrap();
        assert_eq!(
            turn.status,
            if prompt == "healthy" {
                TurnStatus::Completed
            } else {
                TurnStatus::Failed
            }
        );
    }
    engine.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn shutdown_waits_for_concurrent_admission_and_durable_finalization() {
    let (dir, engine, model, mut entered) = setup(Limits::default());
    let first = engine.create("/shutdown".into()).await.unwrap();
    engine
        .start(&first.id, vec![Input::text("hold")])
        .await
        .unwrap();
    entered.recv().await.unwrap();
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..32 {
        let engine = engine.clone();
        tasks.spawn(async move {
            if let Ok(thread) = engine.create("/shutdown".into()).await {
                let _ = engine.start(&thread.id, vec![Input::text("hold")]).await;
            }
        });
    }
    tokio::task::yield_now().await;
    engine.shutdown().await;
    while let Some(task) = tasks.join_next().await {
        task.unwrap();
    }
    let (threads, _) = engine.list(None, 100, None).await.unwrap();
    for thread in &threads {
        let thread = engine.read(&thread.id, true).await.unwrap();
        assert!(
            thread
                .turns
                .iter()
                .all(|turn| turn.status != TurnStatus::InProgress)
        );
    }
    drop(engine);
    let restored = Engine::open(dir.path(), model, Limits::default()).unwrap();
    assert_eq!(
        restored.list(None, 100, None).await.unwrap().0.len(),
        threads.len()
    );
    restored.shutdown().await;
}

#[tokio::test]
async fn idle_timeout_and_capacity_are_explicit_errors() {
    let (_dir, engine, _model, _entered) = setup(Limits {
        max_threads: 1,
        stream_idle_timeout: Duration::from_millis(50),
        watchdog_disable: true,
        ..Limits::default()
    });
    let thread = engine.create("/a".into()).await.unwrap();
    assert!(engine.create("/b".into()).await.is_err());
    engine
        .start(&thread.id, vec![Input::text("hold")])
        .await
        .unwrap();
    let done = settled(&engine, &thread.id).await;
    assert_eq!(done.turns[0].status, TurnStatus::Failed);
    assert!(
        done.turns[0]
            .error
            .as_ref()
            .unwrap()
            .message
            .contains("idle timeout")
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn rejected_child_input_does_not_consume_a_thread_slot_or_leave_history() {
    let (dir, engine, _model, mut entered) = setup(Limits {
        max_threads: 2,
        max_history_bytes: 512 * 1024,
        max_output_bytes: 64 * 1024,
        ..Limits::default()
    });
    let parent = engine.create("/workspace".into()).await.unwrap();
    engine
        .start(&parent.id, vec![Input::text("hold")])
        .await
        .unwrap();
    entered.recv().await.unwrap();
    assert!(
        engine
            .spawn_child(&parent.id, vec![Input::text("x".repeat(512 * 1024))])
            .await
            .is_err()
    );
    let children = engine.list(None, 100, Some(&parent.id)).await.unwrap().0;
    let next = engine
        .spawn_child(&parent.id, vec![Input::text("healthy")])
        .await;
    engine.shutdown().await;
    assert!(
        children.is_empty(),
        "rejected spawn left an unusable child thread"
    );
    assert!(
        next.is_ok(),
        "rejected spawn leaked the remaining thread slot"
    );
    let count = std::fs::read_dir(dir.path())
        .unwrap()
        .filter(|entry| {
            entry
                .as_ref()
                .unwrap()
                .path()
                .extension()
                .is_some_and(|ext| ext == "json")
        })
        .count();
    assert_eq!(count, 2);
}

#[tokio::test]
async fn unsupported_future_session_format_fails_closed_without_rewriting() {
    let (dir, engine, model, _entered) = setup(Limits::default());
    let thread = engine.create("/workspace".into()).await.unwrap();
    engine.shutdown().await;
    drop(engine);
    let path = dir.path().join(format!("{}.json", thread.id));
    let mut record: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    record["version"] = serde_json::json!(areal_engine::state_version() + 1);
    let future = serde_json::to_vec(&record).unwrap();
    std::fs::write(&path, &future).unwrap();
    let error = Engine::open(dir.path(), model, Limits::default())
        .err()
        .expect("future session format must not be interpreted as current");
    assert!(
        error
            .to_string()
            .contains("unsupported or inconsistent session")
    );
    assert_eq!(std::fs::read(path).unwrap(), future);
}

#[tokio::test]
async fn legacy_text_sessions_load_and_upgrade_on_next_write() {
    for version in [1, 7, 14] {
        let dir = tempfile::tempdir().unwrap();
        let thread_id = uuid::Uuid::new_v4().to_string();
        let thread = Thread {
            conversation: None,
            history_archive: None,
            goals: Default::default(),
            goal_owner: None,
            desktop: None,
            id: thread_id.clone(),
            session_id: thread_id.clone(),
            parent_thread_id: None,
            preview: "old".into(),
            name: None,
            name_attempt_turn_id: None,
            model_provider: "configured".into(),
            created_at: 1,
            updated_at: 1,
            status: ThreadStatus::Idle,
            cwd: "/old".into(),
            cli_version: "0.1.0".into(),
            source: "appServer".into(),
            ephemeral: false,
            context_checkpoint: None,
            dynamic_tools: Vec::new(),
            toolset_revision: 0,
            turns: vec![Turn {
                trace: Default::default(),
                interruption: None,
                continued_from_turn_id: None,
                started_at: None,
                completed_at: None,
                duration_ms: None,
                goal: None,
                instruction_snapshot: None,
                instruction_attribution: None,
                generation: None,
                configuration: None,
                id: uuid::Uuid::new_v4().to_string(),
                items: vec![
                    Item::UserMessage {
                        id: uuid::Uuid::new_v4().to_string(),
                        content: vec![Input::text("old")],
                    },
                    Item::AgentMessage {
                        phase: None,
                        id: uuid::Uuid::new_v4().to_string(),
                        text: "reply:old".into(),
                    },
                ],
                status: TurnStatus::Completed,
                error: None,
                usage: None,
            }],
        };
        std::fs::write(
            dir.path().join(format!("{thread_id}.json")),
            serde_json::to_vec(&serde_json::json!({"version":version,"thread":thread})).unwrap(),
        )
        .unwrap();
        let (tx, _rx) = mpsc::unbounded_channel();
        let model = Arc::new(Controlled {
            entered: tx,
            calls: AtomicUsize::new(0),
        });
        let engine = Engine::open(dir.path(), model, Limits::default()).unwrap();
        assert_eq!(engine.read(&thread_id, true).await.unwrap().turns.len(), 1);
        engine
            .start(&thread_id, vec![Input::text("new")])
            .await
            .unwrap();
        settled(&engine, &thread_id).await;
        engine.shutdown().await;
        drop(engine);
        let record: serde_json::Value = serde_json::from_slice(
            &std::fs::read(dir.path().join(format!("{thread_id}.json"))).unwrap(),
        )
        .unwrap();
        assert_eq!(record["version"], areal_engine::state_version());
    }
}

#[tokio::test]
async fn idle_drain_does_not_close_admission_before_timeout_or_while_busy() {
    let (_dir, engine, _model, mut entered) = setup(Limits::default());
    assert!(
        engine
            .drain_with_idle("ifIdle".into(), 1000, Some(60_000))
            .await
            .is_err()
    );
    assert_eq!(engine.server_status().await["acceptingWork"], true);
    let thread = engine.create("/workspace".into()).await.unwrap();
    let turn = engine
        .start(&thread.id, vec![Input::text("hold")])
        .await
        .unwrap();
    entered.recv().await.unwrap();
    assert!(
        engine
            .drain_with_idle("ifIdle".into(), 1000, Some(1))
            .await
            .is_err()
    );
    assert_eq!(engine.server_status().await["acceptingWork"], true);
    engine.interrupt(&thread.id, &turn.id).await.unwrap();
    settled(&engine, &thread.id).await;
    assert!(
        engine
            .drain_with_idle("ifIdle".into(), 1000, Some(60_000))
            .await
            .is_err()
    );
    // 秒级持久时间戳向后取整，完成后至少保留一个完整的空闲区间。
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let status = engine
        .drain_with_idle("ifIdle".into(), 1000, Some(1))
        .await
        .unwrap();
    assert_eq!(status["acceptingWork"], false);
    assert_eq!(status["restartSafe"], true);
}
