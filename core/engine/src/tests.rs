use super::*;

#[tokio::test]
async fn fork_settled_failure_and_interruption_preserve_status() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(PendingModel), Limits::default()).unwrap();
    let mut source = engine.create("/fixture".into()).await.unwrap();
    let failed = id();
    let interrupted = id();
    let active = id();
    for (turn_id, status) in [
        (&failed, TurnStatus::Failed),
        (&interrupted, TurnStatus::Interrupted),
        (&active, TurnStatus::InProgress),
    ] {
        source.turns.push(Turn {
            started_at: None,
            completed_at: None,
            duration_ms: None,
            goal: None,
            configuration: None,
            instruction_snapshot: None,
            id: turn_id.clone(),
            error: match &status {
                TurnStatus::Failed | TurnStatus::Interrupted => Some(areal_protocol::TurnError {
                    message: format!("fork-error-sentinel-{turn_id}"),
                    outcome: Some(areal_protocol::TurnOutcome {
                        code: format!("fixture-{status:?}"),
                        class: "fixture-terminal".into(),
                        source: "fork-preservation-fixture".into(),
                        details: Some(
                            json!({"sourceTurnId": turn_id, "sentinel": "preserve-error-details"}),
                        ),
                    }),
                }),
                _ => None,
            },
            status,
            usage: None,
            items: vec![Item::UserMessage {
                id: id(),
                content: vec![Input::text(turn_id)],
            }],
        });
    }
    engine.persist(&source).await.unwrap();
    engine
        .raw_cell(&source.id)
        .await
        .unwrap()
        .state
        .lock()
        .await
        .thread = source.clone();
    let source_id = source.id.clone();
    let request = |key: &str, anchor: &str, boundary: &str| areal_protocol::desktop::ForkThread {
        request_id: key.into(),
        source_thread_id: source_id.clone(),
        anchor: areal_protocol::desktop::ForkAnchor {
            turn_id: anchor.into(),
            boundary: boundary.into(),
        },
        workspace_mode: "sharedCurrent".into(),
        target: None,
    };
    assert!(
        matches!(engine.fork_thread("owner".into(), request("active-after", &active, "after")).await,
        Err(Error::Invalid(reason)) if reason == "TURN_NOT_TERMINAL")
    );
    let fork = engine
        .fork_thread("owner".into(), request("active-before", &active, "before"))
        .await
        .unwrap();
    let Some(areal_protocol::Conversation::Fork { history_seed, .. }) = fork.conversation else {
        panic!("expected fork");
    };
    let (history, _) = engine
        .store
        .read_fork_snapshot_with_sources(&history_seed.snapshot_id)
        .unwrap();
    assert_eq!(
        history.iter().map(|turn| &turn.status).collect::<Vec<_>>(),
        vec![&TurnStatus::Failed, &TurnStatus::Interrupted]
    );
    let retained_source = engine.read(&source.id, true).await.unwrap();
    for (index, turn) in history.iter().enumerate().take(2) {
        let expected = serde_json::to_value(source.turns[index].error.as_ref().unwrap()).unwrap();
        assert_eq!(
            serde_json::to_value(turn.error.as_ref().unwrap()).unwrap(),
            expected,
            "fork must preserve the terminal error message, outcome, and details"
        );
        assert_eq!(
            serde_json::to_value(retained_source.turns[index].error.as_ref().unwrap()).unwrap(),
            expected,
            "fork must leave the source terminal error unchanged"
        );
    }
    assert_eq!(retained_source.turns[2].status, TurnStatus::InProgress);
    source.parent_thread_id = Some("delegating-thread".into());
    engine.persist(&source).await.unwrap();
    engine
        .raw_cell(&source.id)
        .await
        .unwrap()
        .state
        .lock()
        .await
        .thread = source.clone();
    assert!(
        matches!(engine.fork_thread("owner".into(), request("worker", &failed, "after")).await,
        Err(Error::Invalid(reason)) if reason == "SOURCE_KIND_UNSUPPORTED")
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn fork_unknown_hook_requires_source_inspection_and_keeps_unknown() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(PendingModel), Limits::default()).unwrap();
    let mut source = engine.create("/fixture".into()).await.unwrap();
    let anchor = id();
    let tool_id = id();
    let tool: Item = serde_json::from_value(json!({
        "type":"dynamicToolCall", "id":tool_id, "tool":"lookup", "callId":"call-1",
        "arguments":{}, "status":"failed", "success":false,
        "contentItems":[{"type":"inputText","text":"result unknown"}],
        "execution":{"runtimeEpoch":"runtime", "scopeId":"scope", "operationId":"operation",
            "outcome":"failed", "hooks":[{"name":"audit","event":"postToolUse",
                "operationId":"hook-operation", "outcome":"unknown"}],
            "plugin":{"pluginId":"fixture", "generation":"1", "scopeId":"scope",
                "operations":[{"operationId":"plugin-operation", "kind":"read", "path":"fixture",
                    "requestSha256":"digest", "outcome":"unknown", "result":null}]}}
    }))
    .unwrap();
    source.turns.push(Turn {
        started_at: None,
        completed_at: None,
        duration_ms: None,
        goal: None,
        configuration: None,
        instruction_snapshot: None,
        id: anchor.clone(),
        status: TurnStatus::Failed,
        error: None,
        usage: None,
        items: vec![
            Item::UserMessage {
                id: id(),
                content: vec![Input::text("lookup")],
            },
            tool,
        ],
    });
    if let Item::DynamicToolCall { execution, .. } = &mut source.turns[0].items[1] {
        execution.hooks[0].outcome = areal_protocol::ToolOutcome::Running;
    }
    engine.persist(&source).await.unwrap();
    engine
        .raw_cell(&source.id)
        .await
        .unwrap()
        .state
        .lock()
        .await
        .thread = source.clone();
    let source_id = source.id.clone();
    let request = |key: &str| areal_protocol::desktop::ForkThread {
        request_id: key.into(),
        source_thread_id: source_id.clone(),
        anchor: areal_protocol::desktop::ForkAnchor {
            turn_id: anchor.clone(),
            boundary: "after".into(),
        },
        workspace_mode: "sharedCurrent".into(),
        target: None,
    };
    assert!(
        matches!(engine.fork_thread("owner".into(), request("running-hook")).await,
        Err(Error::Invalid(reason)) if reason == "HISTORY_UNRESOLVED")
    );
    if let Item::DynamicToolCall { execution, .. } = &mut source.turns[0].items[1] {
        execution.hooks[0].outcome = areal_protocol::ToolOutcome::Unknown;
    }
    engine.persist(&source).await.unwrap();
    engine
        .raw_cell(&source.id)
        .await
        .unwrap()
        .state
        .lock()
        .await
        .thread = source.clone();
    assert!(
        matches!(engine.fork_thread("owner".into(), request("before-inspect")).await,
        Err(Error::Invalid(reason)) if reason == "HISTORY_UNRESOLVED")
    );
    engine
        .acknowledge_tool(
            source.id.clone(),
            tool_id,
            "Checked the actual operation and audit hook".into(),
        )
        .await
        .unwrap();
    let fork = engine
        .fork_thread("owner".into(), request("after-inspect"))
        .await
        .unwrap();
    let Some(areal_protocol::Conversation::Fork { history_seed, .. }) = fork.conversation else {
        panic!("expected fork");
    };
    let (history, _) = engine
        .store
        .read_fork_snapshot_with_sources(&history_seed.snapshot_id)
        .unwrap();
    assert_eq!(history[0].status, TurnStatus::Failed);
    assert!(
        matches!(&history[0].items[1], Item::DynamicToolCall { execution, .. }
        if execution.hooks[0].outcome == areal_protocol::ToolOutcome::Unknown
            && execution.plugin.as_ref().unwrap().operations[0].outcome == areal_protocol::ToolOutcome::Unknown
            && execution.inspection.is_some())
    );
    let mut plugin_only = engine.read(&source.id, true).await.unwrap();
    if let Item::DynamicToolCall { execution, .. } = &mut plugin_only.turns[0].items[1] {
        execution.hooks[0].outcome = areal_protocol::ToolOutcome::Succeeded;
        execution.inspection = None;
    }
    engine.persist(&plugin_only).await.unwrap();
    engine
        .raw_cell(&source.id)
        .await
        .unwrap()
        .state
        .lock()
        .await
        .thread = plugin_only;
    assert!(
        matches!(engine.fork_thread("owner".into(), request("plugin-unchecked")).await,
        Err(Error::Invalid(reason)) if reason == "HISTORY_UNRESOLVED")
    );
    engine
        .acknowledge_tool(
            source.id.clone(),
            history[0].items[1].id().into(),
            "Checked original plugin operation".into(),
        )
        .await
        .unwrap();
    let plugin_fork = engine
        .fork_thread("owner".into(), request("plugin-checked"))
        .await
        .unwrap();
    let Some(areal_protocol::Conversation::Fork { history_seed, .. }) = plugin_fork.conversation
    else {
        panic!("expected fork");
    };
    let (plugin_history, _) = engine
        .store
        .read_fork_snapshot_with_sources(&history_seed.snapshot_id)
        .unwrap();
    assert!(
        matches!(&plugin_history[0].items[1], Item::DynamicToolCall { execution, .. }
        if execution.plugin.as_ref().unwrap().operations[0].outcome == areal_protocol::ToolOutcome::Unknown
            && execution.inspection.is_some())
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn fork_creation_faults_recover_only_committed_targets() {
    for (stage, committed) in [
        (store::ForkFault::BeforeSnapshot, false),
        (store::ForkFault::AfterSnapshot, false),
        (store::ForkFault::AfterTarget, true),
        (store::ForkFault::AfterPersistError, true),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(dir.path(), Arc::new(PendingModel), Limits::default()).unwrap();
        let mut source = engine.create("/fixture".into()).await.unwrap();
        let anchor = id();
        source.turns.push(Turn {
            started_at: None,
            completed_at: None,
            duration_ms: None,
            goal: None,
            configuration: None,
            instruction_snapshot: None,
            id: anchor.clone(),
            status: TurnStatus::Completed,
            error: None,
            usage: None,
            items: vec![
                Item::UserMessage {
                    id: id(),
                    content: vec![Input::text("known prefix")],
                },
                Item::AgentMessage {
                    id: id(),
                    phase: None,
                    text: "known answer".into(),
                },
            ],
        });
        // 不相关会话的账本满额不能抢先挡住 Fork 的原键查找。
        let mut desktop = areal_protocol::desktop::DesktopState::default();
        desktop.receipts = (0..1024)
            .map(|index| areal_protocol::desktop::RequestReceipt {
                identity: "other".into(),
                request_id: format!("old-{index}"),
                method: "areal/turn/start".into(),
                digest: "old".into(),
                result: json!({}),
            })
            .collect();
        source.desktop = Some(desktop);
        engine.persist(&source).await.unwrap();
        engine
            .raw_cell(&source.id)
            .await
            .unwrap()
            .state
            .lock()
            .await
            .thread = source.clone();
        engine.store.set_fork_fault(stage);
        let request = areal_protocol::desktop::ForkThread {
            request_id: "stage-key".into(),
            source_thread_id: source.id.clone(),
            anchor: areal_protocol::desktop::ForkAnchor {
                turn_id: anchor,
                boundary: "after".into(),
            },
            workspace_mode: "sharedCurrent".into(),
            target: None,
        };
        let replay = request.clone();
        assert!(matches!(
            engine.fork_thread("owner".into(), request).await,
            Err(Error::Storage(_))
        ));
        let snapshots = std::fs::read_dir(dir.path().join("history"))
            .map(|entries| entries.count())
            .unwrap_or(0);
        assert_eq!(
            snapshots,
            if stage == store::ForkFault::BeforeSnapshot {
                0
            } else {
                1
            }
        );
        engine.store.collect_blobs().await.unwrap();
        let retained_snapshots = std::fs::read_dir(dir.path().join("history"))
            .map(|entries| entries.count())
            .unwrap_or(0);
        assert_eq!(retained_snapshots, usize::from(committed));
        if stage == store::ForkFault::AfterPersistError {
            let receipt = engine.find_request("owner", "stage-key").await.unwrap();
            let target = receipt["data"][0]["result"]["threadId"].as_str().unwrap();
            assert!(matches!(
                engine.start(target, vec![Input::text("must wait")]).await,
                Err(Error::Storage(_))
            ));
        }
        engine.shutdown().await;
        drop(engine);
        let restored = Engine::open(dir.path(), Arc::new(PendingModel), Limits::default()).unwrap();
        let receipts = restored.find_request("owner", "stage-key").await.unwrap();
        assert_eq!(
            receipts["data"].as_array().unwrap().len(),
            usize::from(committed)
        );
        if committed {
            let target = receipts["data"][0]["result"]["threadId"].as_str().unwrap();
            assert_eq!(
                restored
                    .fork_thread("owner".into(), replay)
                    .await
                    .unwrap()
                    .id,
                target
            );
        }
        let threads = restored.list(None, 100, None).await.unwrap().0;
        assert_eq!(threads.len(), if committed { 2 } else { 1 });
        restored.shutdown().await;
    }
}

struct FileModel;
#[async_trait::async_trait]
impl Model for FileModel {
    fn name(&self) -> &str {
        "file-fixture"
    }
    fn capabilities(&self) -> model::ModelCapabilities {
        model::ModelCapabilities {
            input: vec![
                areal_protocol::Modality::Text,
                areal_protocol::Modality::File,
            ],
            output: vec![areal_protocol::Modality::Text],
            context_window_tokens: None,
            max_output_tokens: None,
            summary_output_tokens: None,
        }
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<model::ModelStream> {
        Ok(Box::pin(futures_util::stream::pending()))
    }
}

#[tokio::test]
async fn inherited_media_survives_release_gc_and_restart() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(FileModel), Limits::default()).unwrap();
    let mut source = engine.create("/fixture".into()).await.unwrap();
    let media = engine
        .upload_blob(
            source.id.clone(),
            "owner".into(),
            None,
            "text/plain".into(),
            b"inherited original bytes".to_vec(),
        )
        .await
        .unwrap();
    let raw = engine
        .store
        .save_blob(
            "application/json".into(),
            br#"{"original":"tool result"}"#.to_vec(),
        )
        .await
        .unwrap();
    source = engine.read(&source.id, true).await.unwrap();
    let anchor = id();
    source.turns.push(Turn {
        started_at: None,
        completed_at: None,
        duration_ms: None,
        goal: None,
        configuration: None,
        instruction_snapshot: None,
        id: anchor.clone(),
        status: TurnStatus::Completed,
        error: None,
        usage: None,
        items: vec![
            Item::UserMessage {
                id: id(),
                content: vec![Input::File {
                    url: media.uri.clone(),
                    name: Some("evidence.txt".into()),
                    mime_type: Some("text/plain".into()),
                }],
            },
            serde_json::from_value(json!({"type":"dynamicToolCall","id":id(),"tool":"read",
            "callId":"raw-result","arguments":{},"status":"completed","success":true,
            "contentItems":[{"type":"inputText","text":"done"}],
            "execution":{"runtimeEpoch":"epoch","scopeId":"scope","operationId":"operation",
                "outcome":"succeeded","resultSnapshot":raw}}))
            .unwrap(),
        ],
    });
    engine.persist(&source).await.unwrap();
    engine
        .raw_cell(&source.id)
        .await
        .unwrap()
        .state
        .lock()
        .await
        .thread = source.clone();
    let fork = engine
        .fork_thread(
            "owner".into(),
            areal_protocol::desktop::ForkThread {
                request_id: "media-fork".into(),
                source_thread_id: source.id.clone(),
                anchor: areal_protocol::desktop::ForkAnchor {
                    turn_id: anchor,
                    boundary: "after".into(),
                },
                workspace_mode: "sharedCurrent".into(),
                target: None,
            },
        )
        .await
        .unwrap();
    let target_upload = engine
        .upload_blob(
            fork.id.clone(),
            "owner".into(),
            None,
            "text/plain".into(),
            b"inherited original bytes".to_vec(),
        )
        .await
        .unwrap();
    assert_eq!(target_upload.uri, media.uri);
    assert!(matches!(
        engine
            .release_upload(fork.id.clone(), media.uri.clone())
            .await,
        Err(Error::Invalid(_))
    ));
    assert_eq!(
        engine
            .thread_blob(&fork.id, media.uri.rsplit('/').next().unwrap())
            .await
            .unwrap(),
        b"inherited original bytes"
    );
    assert_eq!(
        engine
            .thread_blob(&fork.id, raw.uri.rsplit('/').next().unwrap())
            .await
            .unwrap(),
        br#"{"original":"tool result"}"#
    );
    // 来源释放热状态后，GC 仍须沿目标快照保留媒体和原始引用。
    engine.archive_thread(source.id.clone()).await.unwrap();
    engine.store.collect_blobs().await.unwrap();
    engine.shutdown().await;
    drop(engine);
    let reopened = Engine::open(dir.path(), Arc::new(FileModel), Limits::default()).unwrap();
    assert_eq!(
        reopened
            .thread_blob(&fork.id, media.uri.rsplit('/').next().unwrap())
            .await
            .unwrap(),
        b"inherited original bytes"
    );
    assert_eq!(
        reopened
            .thread_blob(&fork.id, raw.uri.rsplit('/').next().unwrap())
            .await
            .unwrap(),
        br#"{"original":"tool result"}"#
    );
    let page = reopened
        .fork_history(&fork.id, None, Some(1024))
        .await
        .unwrap();
    assert_eq!(page["data"][0]["item"]["content"][0]["url"], media.uri);
    reopened.shutdown().await;
}

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
        started_at: None,
        completed_at: None,
        duration_ms: None,
        goal: None,
        configuration: None,
        instruction_snapshot: None,
        id: "turn".into(),
        status: TurnStatus::Completed,
        error: None,
        usage: None,
        items: vec![
            Item::AgentMessage {
                phase: None,
                id: "completion-1".into(),
                text: "Inspect both".into(),
            },
            call("a", true),
            call("b", false),
            // An empty text item still marks a new model decision.
            Item::AgentMessage {
                phase: None,
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
            "fs_apply_patches",
            json!({"path":"code.py","fileVersion":"v1111111111111111","patches":[{"oldText":"old","newText":"new"}]}),
            json!({"path":"code.py","fileVersion":"v1111111111111111","patches":[{"oldText":"old","newText":"new"}]}),
            json!({"path":"workspace://repo/code.py","expectedSha256":"a".repeat(64),"patches":[{"oldText":"old","newText":"new"}]}),
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
        started_at: None,
        completed_at: None,
        duration_ms: None,
        goal: None,
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

#[tokio::test]
async fn browser_history_keeps_plan_private_and_preserves_rejected_arguments() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(PendingModel), Limits::default()).unwrap();
    let mut thread = engine.create("/fixture".into()).await.unwrap();
    let original = json!({"operation":"observe","parameters":{"pageId":"old"}});
    let canonical = json!({"operation":"observe","parameters":{"pageId":"hook-current"}});
    let audit = json!({"arguments":canonical,"plan":{"preparedActionId":"private-plan","fingerprint":"private-digest"}});
    let rejected = json!({"arguments":canonical,"plan":{"preparedActionId":"model-forged"}});
    let mut items = Vec::new();
    let mut expected = Vec::new();
    for (id, tool, backend, input, model, effective, want) in [
        (
            "new",
            "browser_v1",
            "client",
            original.clone(),
            Some(canonical.clone()),
            Some(audit.clone()),
            canonical.clone(),
        ),
        (
            "legacy",
            "browser_v1",
            "client",
            original.clone(),
            None,
            Some(audit.clone()),
            canonical.clone(),
        ),
        (
            "rejected",
            "browser_v1",
            "client",
            rejected.clone(),
            None,
            None,
            rejected.clone(),
        ),
        (
            "other",
            "fixture",
            "client",
            original.clone(),
            None,
            Some(audit.clone()),
            audit.clone(),
        ),
        (
            "runtime",
            "browser_v1",
            "runtime",
            original.clone(),
            None,
            Some(audit.clone()),
            audit.clone(),
        ),
    ] {
        items.push(serde_json::from_value::<Item>(json!({
            "type":"dynamicToolCall","id":id,"tool":tool,"callId":id,"arguments":input,
            "status":"completed","success":id!="rejected","contentItems":[{"type":"inputText","text":"receipt"}],
            "execution":{"backend":backend,"runtimeEpoch":"runtime","scopeId":"scope","operationId":id,
                "outcome":if id=="rejected" {"failed"} else {"succeeded"},
                "modelArguments":model,"effectiveArguments":effective}
        })).unwrap());
        expected.push(want);
    }
    thread.turns.push(Turn {
        started_at: None,
        completed_at: None,
        duration_ms: None,
        goal: None,
        configuration: None,
        instruction_snapshot: None,
        id: "turn".into(),
        status: TurnStatus::Completed,
        error: None,
        usage: None,
        items,
    });
    let saved = serde_json::to_value(&thread).unwrap();
    let restored: Thread = serde_json::from_value(saved.clone()).unwrap();
    let messages = history(&restored, &engine.store).unwrap();
    let calls: Vec<_> = messages
        .iter()
        .flat_map(|message| &message.tool_calls)
        .collect();
    for (call, wanted) in calls.iter().zip(expected) {
        let actual: Value =
            serde_json::from_str(call["function"]["arguments"].as_str().unwrap()).unwrap();
        assert_eq!(actual, wanted);
    }
    assert_eq!(
        serde_json::to_value(&restored).unwrap(),
        saved,
        "投影不改写审计原文"
    );
    assert_eq!(
        saved["turns"][0]["items"][1]["execution"]["effectiveArguments"],
        audit
    );
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

#[tokio::test]
async fn compacted_history_preserves_steer_inside_an_automatic_goal_turn() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(PendingModel), Limits::default()).unwrap();
    let mut thread = engine.create("/fixture".into()).await.unwrap();
    thread.turns.push(Turn {
        started_at: None,
        completed_at: None,
        duration_ms: None,
        goal: Some(areal_protocol::goals::GoalTurn {
            goal_id: id(),
            sequence: 2,
            origin: "continuation".into(),
            predecessor_turn_id: None,
        }),
        configuration: None,
        instruction_snapshot: None,
        id: id(),
        status: TurnStatus::Completed,
        error: None,
        usage: None,
        items: vec![
            Item::UserMessage {
                id: "automatic".into(),
                content: vec![Input::text("Automatic continuation adds no authorization")],
            },
            Item::UserMessage {
                id: "repair".into(),
                content: vec![
                    Input::text("修订：只修组合键；取消旧音乐任务。"),
                    Input::text("保留已验收光学中心。"),
                ],
            },
            Item::AgentMessage {
                id: "boundary".into(),
                phase: None,
                text: "verified".into(),
            },
        ],
    });
    thread.context_checkpoint = Some(areal_protocol::ContextCheckpoint {
        retained_inputs: None,
        evidence: Vec::new(),
        through_item_id: "boundary".into(),
        summary: "Old music task is pending".into(),
        usage: Default::default(),
        total_duration_ms: 0,
        compactions: 2,
    });
    let projected = history(&thread, &engine.store).unwrap();
    let users: Vec<_> = projected.iter().filter(|m| m.role == "user").collect();
    assert_eq!(users.len(), 1);
    assert_eq!(users[0].content.len(), 2);
    assert!(users[0].text_content().contains("取消旧音乐任务"));
    engine.persist(&thread).await.unwrap();
    let raw = std::fs::read(dir.path().join(format!("{}.json", thread.id))).unwrap();
    let restored: store::Record = serde_json::from_slice(&raw).unwrap();
    assert_eq!(
        serde_json::to_vec(&restored.thread).unwrap(),
        serde_json::to_vec(&thread).unwrap()
    );
    assert_eq!(
        history(&restored.thread, &engine.store)
            .unwrap()
            .iter()
            .map(Message::text_content)
            .collect::<Vec<_>>(),
        projected
            .iter()
            .map(Message::text_content)
            .collect::<Vec<_>>()
    );
    engine.shutdown().await;
}

#[tokio::test]
#[ignore = "local disk benchmark; not a timing assertion"]
async fn persistence_encoding_benchmark() {
    use std::io::Write;
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(PendingModel), Limits::default()).unwrap();
    let mut thread = engine.create("/fixture".into()).await.unwrap();
    thread.turns.push(Turn {
        started_at: None,
        completed_at: None,
        duration_ms: None,
        goal: None,
        configuration: None,
        instruction_snapshot: None,
        id: id(),
        status: TurnStatus::Completed,
        error: None,
        usage: None,
        items: (0..4000)
            .map(|n| Item::AgentMessage {
                id: n.to_string(),
                phase: None,
                text: "Observed tool JSON: {\"file\":\"src/main.rs\",\"result\":\"verified\"}\n"
                    .repeat(32),
            })
            .collect(),
    });
    let mut old_ms = Vec::new();
    let mut new_ms = Vec::new();
    for _ in 0..3 {
        let started = std::time::Instant::now();
        let _size = serde_json::to_vec(&thread).unwrap().len();
        let clone = thread.clone();
        let mut file = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
        serde_json::to_writer(
            &mut file,
            &store::Record {
                version: store::STATE_VERSION,
                thread: clone.clone(),
            },
        )
        .unwrap();
        file.flush().unwrap();
        file.as_file().sync_all().unwrap();
        old_ms.push(started.elapsed().as_secs_f64() * 1000.0);
        let started = std::time::Instant::now();
        let bytes = store::encode(&thread).unwrap();
        let mut optimized = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
        optimized.write_all(&bytes).unwrap();
        optimized.flush().unwrap();
        optimized.as_file().sync_all().unwrap();
        new_ms.push(started.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(
            std::fs::read(file.path()).unwrap(),
            std::fs::read(optimized.path()).unwrap()
        );
    }
    println!(
        "{}",
        json!({"bytes":store::encode(&thread).unwrap().len(),"oldMs":old_ms,"newMs":new_ms,"scope":"encoding, clone and file write/fsync; excludes queue and directory rename/sync"})
    );
    engine.shutdown().await;
}

// 系统故障验收：真实 Store 已提交、激活尚未发生；复用既有持久化故障注入点。
#[tokio::test]
async fn side_committed_store_fault_recovers_one_unexecuted_interrupted_turn() {
    struct CountModel(Arc<AtomicUsize>);
    #[async_trait::async_trait]
    impl model::Model for CountModel {
        fn name(&self) -> &str {
            "side-commit-fault"
        }
        async fn stream(&self, _: Vec<Message>) -> anyhow::Result<model::ModelStream> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(Box::pin(futures_util::stream::iter([Ok(
                model::ModelEvent::text("unexpected execution"),
            )])))
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let engine = Engine::open(
        dir.path(),
        Arc::new(CountModel(calls.clone())),
        Limits::default(),
    )
    .unwrap();
    let source = engine.create("/fixture".into()).await.unwrap();
    let request: areal_protocol::desktop::SideStart = serde_json::from_value(json!({
        "requestId":"side-before-activation","sourceThreadId":source.id,"workspaceAccess":"none",
        "input":[{"type":"text","text":"first question"}]}))
    .unwrap();
    engine
        .store
        .set_fork_fault(store::ForkFault::AfterPersistError);
    assert!(matches!(
        engine.side_start("owner".into(), request.clone()).await,
        Err(Error::Storage(_))
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let receipts = engine
        .find_request("owner", "side-before-activation")
        .await
        .unwrap();
    assert_eq!(receipts["data"].as_array().unwrap().len(), 1);
    let receipt = &receipts["data"][0]["result"];
    let side_id = receipt["threadId"].as_str().unwrap().to_owned();
    let first_id = receipt["turnId"].as_str().unwrap().to_owned();
    let durable = engine.store.read_thread(&side_id).await.unwrap();
    assert_eq!(durable.turns.len(), 1);
    assert_eq!(durable.turns[0].id, first_id);
    assert_eq!(durable.turns[0].status, TurnStatus::InProgress);
    assert_eq!(durable.turns[0].items.len(), 1);
    assert!(matches!(
        engine
            .start(&side_id, vec![Input::text("must not activate")])
            .await,
        Err(Error::Storage(_))
    ));
    engine.shutdown().await;
    drop(engine);
    let restored = Engine::open(
        dir.path(),
        Arc::new(CountModel(calls.clone())),
        Limits::default(),
    )
    .unwrap();
    let recovered = restored.read(&side_id, true).await.unwrap();
    assert_eq!(recovered.turns[0].status, TurnStatus::Interrupted);
    assert_eq!(recovered.turns[0].items.len(), 1);
    let (replayed, turn) = restored.side_start("owner".into(), request).await.unwrap();
    assert_eq!(replayed.id, side_id);
    assert_eq!(turn.id, first_id);
    assert_eq!(turn.status, TurnStatus::Interrupted);
    assert_eq!(restored.list(None, 100, None).await.unwrap().0.len(), 2);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    restored.shutdown().await;
}
