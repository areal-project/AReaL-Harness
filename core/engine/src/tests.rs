use super::*;

#[tokio::test]
async fn model_history_preserves_completion_batches_and_defers_tool_images() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(PendingModel), Limits::default()).unwrap();
    let mut thread = engine.create("/fixture".into()).await.unwrap();
    let media = engine
        .store
        .save_blob("image/png".into(), vec![1, 2])
        .await
        .unwrap();
    let call = |id: &str, image: bool| {
        let mut content = vec![json!({"type":"inputText","text":"confirmed"})];
        if image {
            content.push(json!({"type":"arealMedia","modality":"image","media":media}));
        }
        serde_json::from_value::<Item>(json!({
            "type":"dynamicToolCall", "id":id, "tool":"fixture", "callId":id,
            "arguments":{}, "status":"completed", "success":true,
            "contentItems":content,
            "execution":{"backend":"runtime", "runtimeEpoch":"runtime", "scopeId":"scope",
                "operationId":id, "outcome":"succeeded"}
        }))
        .unwrap()
    };
    thread.turns.push(Turn {
        configuration: None,
        instruction_snapshot: None,
        id: "turn".into(),
        status: TurnStatus::Completed,
        error: None,
        usage: None,
        items: vec![
            Item::AgentMessage {
                id: "completion-1".into(),
                text: "Inspect both".into(),
            },
            call("a", true),
            call("b", false),
            // An empty text item still marks a new model decision.
            Item::AgentMessage {
                id: "completion-2".into(),
                text: String::new(),
            },
            call("c", false),
        ],
    });
    let messages = history(&thread, &engine.store).unwrap();
    assert_eq!(
        messages.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(),
        ["assistant", "tool", "tool", "user", "assistant", "tool"]
    );
    assert_eq!(messages[0].text_content(), "Inspect both");
    assert_eq!(messages[0].tool_calls.len(), 2);
    assert_eq!(messages[1].tool_call_id.as_deref(), Some("a"));
    assert_eq!(messages[2].tool_call_id.as_deref(), Some("b"));
    assert!(matches!(messages[3].content[1], ContentPart::Image { .. }));
    assert_eq!(messages[4].tool_calls[0]["id"], "c");
    engine.shutdown().await;
}

#[tokio::test]
async fn model_history_keeps_short_references_and_preserves_runtime_audit() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(PendingModel), Limits::default()).unwrap();
    let mut thread = engine.create("/fixture".into()).await.unwrap();
    let mut items = Vec::new();
    for (name, original, visible, resolved) in [
        (
            "read_process",
            json!({"processId":"p1111111111111111","after":"c1111111111111111"}),
            // A pre-tool hook may redirect a request to another authorized alias.
            json!({"processId":"p2222222222222222","after":"c2222222222222222"}),
            json!({"processId":"runtime:process:long-id","after":"runtime:process:long-id/42"}),
        ),
        (
            "fs_apply_patch",
            json!({"path":"code.py","fileVersion":"v1111111111111111","oldText":"old","newText":"new"}),
            json!({"path":"code.py","fileVersion":"v1111111111111111","oldText":"old","newText":"new"}),
            json!({"path":"workspace://repo/code.py","expectedSha256":"a".repeat(64),"oldText":"old","newText":"new"}),
        ),
    ] {
        items.push(
            serde_json::from_value::<Item>(json!({
                "type":"dynamicToolCall", "id":name, "tool":name, "callId":name,
                "arguments":original, "status":"completed", "success":true,
                "contentItems":[{"type":"inputText","text":"confirmed"}],
                "execution":{"backend":"runtime", "runtimeEpoch":"runtime", "scopeId":"scope",
                    "operationId":"operation", "outcome":"succeeded",
                    "modelArguments":visible, "effectiveArguments":resolved}
            }))
            .unwrap(),
        );
    }
    thread.turns.push(Turn {
        configuration: None,
        instruction_snapshot: None,
        id: "turn".into(),
        items,
        status: TurnStatus::Completed,
        error: None,
        usage: None,
    });
    let saved = serde_json::to_value(&thread).unwrap();
    assert_eq!(
        saved["turns"][0]["items"][0]["execution"]["effectiveArguments"]["processId"],
        "runtime:process:long-id"
    );
    let restored: Thread = serde_json::from_value(saved).unwrap();
    let messages = history(&restored, &engine.store).unwrap();
    let calls: Vec<_> = messages.iter().flat_map(|m| &m.tool_calls).collect();
    let process: Value =
        serde_json::from_str(calls[0]["function"]["arguments"].as_str().unwrap()).unwrap();
    assert_eq!(
        process,
        json!({"processId":"p2222222222222222","after":"c2222222222222222"})
    );
    let patch: Value =
        serde_json::from_str(calls[1]["function"]["arguments"].as_str().unwrap()).unwrap();
    assert_eq!(patch["fileVersion"], "v1111111111111111");
    assert!(patch.get("expectedSha256").is_none());
    engine.shutdown().await;
}

#[test]
fn long_task_input_is_accepted_and_utf8_limit_covers_all_parts() {
    let caps = model::ModelCapabilities::text();
    assert!(validate_input(&[Input::text("x".repeat(134479))], &caps).is_ok());
    assert!(validate_input(&[Input::text("x".repeat(1024 * 1024))], &caps).is_ok());
    assert!(matches!(
        validate_input(
            &[Input::text("x".repeat(1024 * 1024)), Input::text("字")],
            &caps
        ),
        Err(Error::Exhausted(_))
    ));
}

struct PendingModel;
#[async_trait::async_trait]
impl Model for PendingModel {
    fn name(&self) -> &str {
        "pending"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<model::ModelStream> {
        Ok(Box::pin(futures_util::stream::pending()))
    }
}

#[tokio::test]
async fn dropping_a_create_waiter_does_not_abandon_the_reserved_session() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(PendingModel), Limits::default()).unwrap();
    let pause = engine.store.pause_writes().await;
    let owned = engine.clone();
    let request = tokio::spawn(async move { owned.create("/fixture".into()).await });
    tokio::time::timeout(Duration::from_secs(2), async {
        while engine.threads.read().await.is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    request.abort();
    let _ = request.await;
    drop(pause);
    engine.shutdown().await;
    let before = engine.list(None, 100, None).await.unwrap().0;
    drop(engine);
    let restored = Engine::open(dir.path(), Arc::new(PendingModel), Limits::default()).unwrap();
    let after = restored.list(None, 100, None).await.unwrap().0;
    assert_eq!(before.len(), 1);
    assert_eq!(
        after.len(),
        1,
        "cancelled caller left an in-memory-only session"
    );
    assert_eq!(before[0].id, after[0].id);
    restored.shutdown().await;
}

#[tokio::test]
async fn dropping_a_steer_waiter_keeps_durable_input_and_memory_consistent() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(PendingModel), Limits::default()).unwrap();
    let thread = engine.create("/fixture".into()).await.unwrap();
    let turn = engine
        .start(&thread.id, vec![Input::text("initial")])
        .await
        .unwrap();
    let pause = engine.store.pause_writes().await;
    let owned = engine.clone();
    let thread_id = thread.id.clone();
    let turn_id = turn.id.clone();
    let cell = engine.cell(&thread.id).await.unwrap();
    let request = tokio::spawn(async move {
        owned
            .steer(&thread_id, &turn_id, vec![Input::text("accepted steer")])
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        while cell.state.try_lock().is_ok() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    request.abort();
    let _ = request.await;
    drop(pause);
    engine.shutdown().await;
    let before = engine.read(&thread.id, true).await.unwrap();
    drop(engine);
    let restored = Engine::open(dir.path(), Arc::new(PendingModel), Limits::default()).unwrap();
    let after = restored.read(&thread.id, true).await.unwrap();
    for saved in [before, after] {
        assert!(saved.turns[0].items.iter().any(|item| matches!(item, Item::UserMessage { content, .. } if content[0].as_text() == "accepted steer")));
        assert_ne!(saved.turns[0].status, TurnStatus::InProgress);
    }
    restored.shutdown().await;
}
