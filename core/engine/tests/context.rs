use areal_engine::{
    Engine, Limits,
    model::{AgentStream, Message, Model, ModelEvent, ModelStream, RequestPurpose},
};
use areal_protocol::{Input, ModelUsage, TurnStatus};
use async_trait::async_trait;
use futures_util::stream;
use serde_json::Value;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Notify;

struct LongSession {
    requests: Mutex<Vec<Vec<Message>>>,
    summary_started: Notify,
    hold_summary: bool,
}
#[async_trait]
impl Model for LongSession {
    fn name(&self) -> &str {
        "long-session"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<AgentStream> {
        self.chat_for(messages, tools, RequestPurpose::Solve).await
    }
    async fn chat_for(
        &self,
        messages: Vec<Message>,
        tools: Vec<Value>,
        purpose: RequestPurpose,
    ) -> anyhow::Result<AgentStream> {
        let summarizing = purpose == RequestPurpose::Summary;
        self.requests.lock().unwrap().push(messages);
        if summarizing {
            assert!(tools.is_empty());
            self.summary_started.notify_one();
            if self.hold_summary {
                return Ok(Box::pin(stream::pending()));
            }
        }
        Ok(Box::pin(stream::iter([
            Ok(ModelEvent::TextDelta(if summarizing {
                "Completed the initial edits; retain the latest test result and continue verification.".into()
            } else {
                "recorded result ".repeat(90)
            })),
            Ok(ModelEvent::Usage(ModelUsage {
                input_tokens: 11,
                output_tokens: 7,
                cached_input_tokens: 0,
            })),
        ])))
    }
}
fn limits() -> Limits {
    Limits {
        context_window_bytes: 2200,
        context_recent_bytes: 256,
        ..Limits::default()
    }
}
async fn turn(engine: &Arc<Engine>, id: &str, prompt: &str) -> areal_protocol::Thread {
    engine.start(id, vec![Input::text(prompt)]).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), engine.wait(id))
        .await
        .unwrap()
        .unwrap()
}
fn model(hold_summary: bool) -> Arc<LongSession> {
    Arc::new(LongSession {
        requests: Mutex::new(Vec::new()),
        summary_started: Notify::new(),
        hold_summary,
    })
}

#[tokio::test]
async fn manual_mode_stops_before_overflow_and_explicit_compaction_recovers() {
    let data = tempfile::tempdir().unwrap();
    let model = model(false);
    let engine = Engine::open(
        data.path(),
        model.clone(),
        Limits {
            context_auto_compaction: false,
            ..limits()
        },
    )
    .unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    turn(&engine, &thread.id, "Original task").await;
    turn(&engine, &thread.id, "Second step").await;
    let failed = turn(&engine, &thread.id, "Third step").await;
    assert_eq!(failed.turns.last().unwrap().status, TurnStatus::Failed);
    assert!(failed.context_checkpoint.is_none());
    assert_eq!(model.requests.lock().unwrap().len(), 2);
    engine.context_compact(thread.id.clone()).await.unwrap();
    let done = turn(&engine, &thread.id, "Continue").await;
    assert!(done.context_checkpoint.is_some());
    assert_eq!(done.turns.last().unwrap().status, TurnStatus::Completed);
    engine.shutdown().await;
}

#[tokio::test]
async fn many_compactions_keep_hot_snapshot_small_and_restore_every_original() {
    let data = tempfile::tempdir().unwrap();
    let engine = Engine::open(data.path(), model(false), limits()).unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    for n in 0..48 {
        let result = turn(
            &engine,
            &thread.id,
            &format!(
                "User revision {n}: {}",
                "retain the requested interface. ".repeat(48)
            ),
        )
        .await;
        assert_eq!(result.turns.last().unwrap().status, TurnStatus::Completed);
    }
    let full = engine.read(&thread.id, true).await.unwrap();
    let bytes = std::fs::read(data.path().join(format!("{}.json", thread.id))).unwrap();
    let record: Value = serde_json::from_slice(&bytes).unwrap();
    assert!(bytes.len() * 2 < serde_json::to_vec(&full).unwrap().len());
    assert!(
        record["thread"]["historyArchive"]["items"]
            .as_u64()
            .unwrap()
            > 80
    );
    let retained = full
        .context_checkpoint
        .as_ref()
        .unwrap()
        .retained_inputs
        .as_ref()
        .unwrap();
    assert!(retained.len() < 24);
    assert_eq!(retained[0].item_id, full.turns[0].items[0].id());
    assert_eq!(full.turns.len(), 48);
    assert!(full.history_archive.is_none());
    engine.shutdown().await;
    drop(engine);
    let engine = Engine::open(data.path(), model(false), limits()).unwrap();
    assert_eq!(
        serde_json::to_value(engine.read(&thread.id, true).await.unwrap()).unwrap(),
        serde_json::to_value(full).unwrap()
    );
    engine.shutdown().await;
}
#[tokio::test]
async fn compaction_preserves_goal_recent_input_archive_usage_and_restart() {
    let data = tempfile::tempdir().unwrap();
    let model = model(false);
    let engine = Engine::open(data.path(), model.clone(), limits()).unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    let goal = "Implement the requested feature and verify all changes.";
    turn(&engine, &thread.id, goal).await;
    let before = turn(&engine, &thread.id, "Keep the public API compatible.").await;
    assert!(before.context_checkpoint.is_none());
    let after = turn(
        &engine,
        &thread.id,
        "Latest input: verify cancellation too.",
    )
    .await;
    assert_eq!(after.turns.last().unwrap().status, TurnStatus::Completed);
    assert_eq!(after.context_checkpoint.as_ref().unwrap().compactions, 1);
    assert_eq!(
        serde_json::to_value(&after.turns[..2]).unwrap(),
        serde_json::to_value(&before.turns).unwrap()
    );
    assert_eq!(
        after
            .turns
            .last()
            .unwrap()
            .usage
            .as_ref()
            .unwrap()
            .input_tokens,
        22
    );
    {
        let requests = model.requests.lock().unwrap();
        let request = requests.last().unwrap();
        assert_eq!(
            request
                .iter()
                .find(|message| message.role == "user")
                .unwrap()
                .text_content(),
            goal
        );
        assert!(request.iter().any(|message| {
            message
                .text_content()
                .contains("Completed the initial edits")
        }));
        assert_eq!(
            request.last().unwrap().text_content(),
            "Latest input: verify cancellation too."
        );
        assert!(
            request
                .iter()
                .filter(|message| message.text_content().contains("recorded result"))
                .count()
                < 2
        );
    }
    engine.shutdown().await;
    drop(engine);
    let restored = Engine::open(data.path(), model, limits()).unwrap();
    let loaded = restored.read(&thread.id, true).await.unwrap();
    assert_eq!(
        serde_json::to_value(loaded).unwrap(),
        serde_json::to_value(after).unwrap()
    );
    assert!(
        restored
            .read(&thread.id, false)
            .await
            .unwrap()
            .context_checkpoint
            .is_none()
    );
    restored.shutdown().await;
}
#[tokio::test]
async fn cancelling_compaction_keeps_the_original_history_and_no_checkpoint() {
    let data = tempfile::tempdir().unwrap();
    let model = model(true);
    let engine = Engine::open(data.path(), model.clone(), limits()).unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    turn(&engine, &thread.id, "Original task").await;
    let before = turn(&engine, &thread.id, "Continue").await;
    let active = engine
        .start(&thread.id, vec![Input::text("Verify")])
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), model.summary_started.notified())
        .await
        .unwrap();
    engine.interrupt(&thread.id, &active.id).await.unwrap();
    let after = engine.wait(&thread.id).await.unwrap();
    assert_eq!(after.turns.last().unwrap().status, TurnStatus::Interrupted);
    assert!(after.context_checkpoint.is_none());
    assert_eq!(
        serde_json::to_value(&after.turns[..2]).unwrap(),
        serde_json::to_value(before.turns).unwrap()
    );
    engine.shutdown().await;
}

struct ArchivedChatReasoning;
#[async_trait]
impl Model for ArchivedChatReasoning {
    fn name(&self) -> &str {
        "archived-chat-reasoning"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, _: Vec<Value>) -> anyhow::Result<AgentStream> {
        assert!(
            !messages
                .iter()
                .any(|m| m.provider_context.is_some() || m.text_content().contains("thought"))
        );
        Ok(Box::pin(stream::iter([
            Ok(ModelEvent::ProviderContext(
                serde_json::json!({"type":"chat_reasoning", "reasoning_content":"internal thought ".repeat(2000)}),
            )),
            Ok(ModelEvent::reasoning("streamed thought ".repeat(2000))),
            Ok(ModelEvent::text("verified")),
        ])))
    }
}

#[tokio::test]
async fn archived_chat_reasoning_does_not_trigger_compaction_or_disappear_from_history() {
    let data = tempfile::tempdir().unwrap();
    let engine = Engine::open(data.path(), Arc::new(ArchivedChatReasoning), limits()).unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    for _ in 0..3 {
        let completed = turn(&engine, &thread.id, "Continue implementation").await;
        assert_eq!(
            completed.turns.last().unwrap().status,
            TurnStatus::Completed
        );
        assert!(completed.context_checkpoint.is_none());
        assert!(completed.turns.last().unwrap().items.iter().any(|item| matches!(item, areal_protocol::Item::Reasoning { content, .. } if content[0].len() > 16 * 1024)));
        assert!(completed.turns.last().unwrap().items.iter().any(|item| matches!(item, areal_protocol::Item::ModelContext { value, .. } if value["reasoning_content"].as_str().unwrap().len() > 16*1024)));
    }
    engine.shutdown().await;
}

#[tokio::test]
async fn storage_pressure_rolls_nonreplayed_reasoning_and_preserves_originals() {
    let data = tempfile::tempdir().unwrap();
    let engine = Engine::open(
        data.path(),
        Arc::new(ArchivedChatReasoning),
        Limits::default(),
    )
    .unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    for _ in 0..24 {
        assert_eq!(
            turn(&engine, &thread.id, "Continue")
                .await
                .turns
                .last()
                .unwrap()
                .status,
            TurnStatus::Completed
        );
    }
    let full = engine.read(&thread.id, true).await.unwrap();
    assert_eq!(full.turns.len(), 24);
    assert_eq!(
        full.turns
            .iter()
            .flat_map(|t| &t.items)
            .filter(|i| matches!(i, areal_protocol::Item::Reasoning { .. }))
            .count(),
        24
    );
    let bytes = std::fs::read(data.path().join(format!("{}.json", thread.id))).unwrap();
    assert!(bytes.len() < 1024 * 1024);
    assert!(full.context_checkpoint.is_some());
    engine.shutdown().await;
}

#[tokio::test]
async fn token_budget_can_compact_before_byte_limit_and_preserves_original_assertion() {
    let data = tempfile::tempdir().unwrap();
    let model = model(false);
    let limits = Limits {
        context_window_bytes: 1024 * 1024,
        context_recent_bytes: 256,
        context_window_tokens: 12000,
        context_output_reserve_tokens: 400,
        ..Limits::default()
    };
    let engine = Engine::open(data.path(), model.clone(), limits).unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    let goal = "Original API foo(None) must raise ValueError, even if bar() passes.";
    turn(&engine, &thread.id, goal).await;
    turn(
        &engine,
        &thread.id,
        "Another passing check is not the original assertion",
    )
    .await;
    for _ in 0..30 {
        turn(&engine, &thread.id, "Keep debugging").await;
    }
    let after = turn(&engine, &thread.id, "Keep debugging").await;
    assert_eq!(after.turns.last().unwrap().status, TurnStatus::Completed);
    assert!(after.context_checkpoint.is_some());
    {
        let requests = model.requests.lock().unwrap();
        assert_eq!(
            requests
                .last()
                .unwrap()
                .iter()
                .find(|m| m.role == "user")
                .unwrap()
                .text_content(),
            goal
        );
        let summary = requests
            .iter()
            .find(|r| {
                r[0].text_content()
                    .starts_with("Summarize this session prefix")
            })
            .unwrap();
        assert!(
            summary[0]
                .text_content()
                .contains("Counterexamples and uncertainty")
        );
        assert!(summary.iter().any(|m| m.text_content().contains(goal)));
    }
    engine.shutdown().await;
}

#[tokio::test]
async fn disabled_compaction_fails_at_byte_limit_without_summarizing() {
    let data = tempfile::tempdir().unwrap();
    let model = model(false);
    let limits = Limits {
        context_compaction_enabled: false,
        ..limits()
    };
    let engine = Engine::open(data.path(), model.clone(), limits).unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    turn(&engine, &thread.id, "Original task").await;
    turn(&engine, &thread.id, "Continue").await;
    let failed = turn(&engine, &thread.id, "Verify").await;
    assert_eq!(failed.turns.last().unwrap().status, TurnStatus::Failed);
    assert!(
        failed
            .turns
            .last()
            .unwrap()
            .error
            .as_ref()
            .unwrap()
            .message
            .contains("context window limit exceeded: compaction is disabled")
    );
    let outcome = failed
        .turns
        .last()
        .unwrap()
        .error
        .as_ref()
        .unwrap()
        .outcome
        .as_ref()
        .unwrap();
    assert_eq!(outcome.code, "LLM_CONTEXT_WINDOW_EXCEEDED");
    assert_eq!(outcome.source, "core_context_budget");
    assert!(failed.context_checkpoint.is_none());
    assert_eq!(model.requests.lock().unwrap().len(), 2);
    engine.shutdown().await;
}

#[tokio::test]
async fn disabled_compaction_fails_at_token_limit_and_rejects_manual_compaction() {
    let data = tempfile::tempdir().unwrap();
    let model = model(false);
    let limits = Limits {
        context_compaction_enabled: false,
        context_window_bytes: 1024 * 1024,
        context_recent_bytes: 256,
        context_window_tokens: 1800,
        context_output_reserve_tokens: 400,
        ..Limits::default()
    };
    let engine = Engine::open(data.path(), model.clone(), limits).unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    assert!(
        engine
            .context_compact(thread.id.clone())
            .await
            .unwrap_err()
            .to_string()
            .contains("context compaction is disabled")
    );
    let failed = turn(&engine, &thread.id, "Original task").await;
    assert_eq!(failed.turns.last().unwrap().status, TurnStatus::Failed);
    assert!(
        failed
            .turns
            .last()
            .unwrap()
            .error
            .as_ref()
            .unwrap()
            .message
            .contains("context window limit exceeded: compaction is disabled")
    );
    let outcome = failed
        .turns
        .last()
        .unwrap()
        .error
        .as_ref()
        .unwrap()
        .outcome
        .as_ref()
        .unwrap();
    assert_eq!(outcome.code, "LLM_CONTEXT_WINDOW_EXCEEDED");
    assert_eq!(outcome.source, "core_context_budget");
    assert!(failed.context_checkpoint.is_none());
    assert!(model.requests.lock().unwrap().is_empty());
    engine.shutdown().await;
}

struct ContinuityModel {
    requests: Mutex<Vec<(RequestPurpose, Vec<Message>)>>,
    summary: String,
    gate: Mutex<Option<Arc<Notify>>>,
}
#[async_trait]
impl Model for ContinuityModel {
    fn name(&self) -> &str {
        "continuity"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<AgentStream> {
        self.chat_for(messages, tools, RequestPurpose::Solve).await
    }
    async fn chat_for(
        &self,
        messages: Vec<Message>,
        _: Vec<Value>,
        purpose: RequestPurpose,
    ) -> anyhow::Result<AgentStream> {
        self.requests.lock().unwrap().push((purpose, messages));
        let gate = if purpose == RequestPurpose::Summary {
            self.gate.lock().unwrap().take()
        } else {
            None
        };
        if let Some(gate) = gate {
            gate.notified().await;
        }
        Ok(Box::pin(stream::iter([
            Ok(ModelEvent::text(if purpose == RequestPurpose::Summary {
                self.summary.clone()
            } else {
                "observed implementation evidence ".repeat(180)
            })),
            Ok(ModelEvent::Usage(ModelUsage {
                input_tokens: 100,
                output_tokens: 20,
                cached_input_tokens: 0,
            })),
        ])))
    }
}
fn continuity_model(summary: &str) -> Arc<ContinuityModel> {
    Arc::new(ContinuityModel {
        requests: Mutex::new(Vec::new()),
        summary: summary.into(),
        gate: Mutex::new(None),
    })
}

#[tokio::test]
async fn user_revisions_survive_repeated_lossy_and_degraded_summaries_and_restart() {
    // 摘要既可能遗漏修订，也可能完全无效；两种情况下修订必须独立保留。
    for summary in ["Old task is complete. No scope correction.", ""] {
        let data = tempfile::tempdir().unwrap();
        let model = continuity_model(summary);
        let limits = Limits {
            context_window_bytes: 9000,
            context_recent_bytes: 256,
            ..Limits::default()
        };
        let engine = Engine::open(data.path(), model.clone(), limits.clone()).unwrap();
        let thread = engine.create("/workspace".into()).await.unwrap();
        let inputs = [
            "Build game revision 1; initial scope included music.",
            "Revision 2: only fix pc-ads-fire-button-chord, pc-button-chord-release-stuck-fire, ads-optical-center, retry-hud-feedback-reset, low-quality-render-draw-budget. Do not redo music.",
            "Revision 3: ads-optical-center is accepted; only four checks remain. Never undo the accepted fix.",
            "Continue from verified evidence.",
            "Check actual files and deliver only the remaining four fixes.",
            "Preserve revision 3 while checking results.",
        ];
        for input in inputs {
            let t = turn(&engine, &thread.id, input).await;
            assert_eq!(t.turns.last().unwrap().status, TurnStatus::Completed);
        }
        let state = engine.read(&thread.id, true).await.unwrap();
        assert!(state.context_checkpoint.as_ref().unwrap().compactions >= 2);
        if summary.is_empty() {
            assert_eq!(
                state
                    .context_checkpoint
                    .as_ref()
                    .unwrap()
                    .summary
                    .matches("DEGRADED CONTEXT:")
                    .count(),
                1
            );
        }
        engine.shutdown().await;
        drop(engine);
        let engine = Engine::open(data.path(), model.clone(), limits).unwrap();
        let state = turn(
            &engine,
            &thread.id,
            "Resume and finish the current revision.",
        )
        .await;
        assert_eq!(state.turns.last().unwrap().status, TurnStatus::Completed);
        {
            let calls = model.requests.lock().unwrap();
            let (_, request) = calls
                .iter()
                .rev()
                .find(|(p, _)| *p == RequestPurpose::Solve)
                .unwrap();
            let users: Vec<_> = request
                .iter()
                .filter(|m| m.role == "user")
                .map(Message::text_content)
                .collect();
            assert_eq!(&users[..inputs.len()], &inputs);
            for (_, messages) in calls.iter().filter(|(p, _)| *p == RequestPurpose::Summary) {
                assert!(
                    !messages
                        .iter()
                        .filter(|m| m.role == "user")
                        .any(|m| m.text_content().contains("summary was rejected")
                            || m.text_content().contains("Core compaction control"))
                );
            }
        }
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn valid_8027_byte_summary_is_not_discarded_at_an_arbitrary_8000_byte_limit() {
    let data = tempfile::tempdir().unwrap();
    let summary = format!("Latest repair: five checks. {}", "x".repeat(7999));
    assert_eq!(summary.len(), 8027);
    let model = continuity_model(&summary);
    let engine = Engine::open(
        data.path(),
        model.clone(),
        Limits {
            context_window_bytes: 1024 * 1024,
            context_recent_bytes: 256,
            context_target_tokens: 1000,
            ..Limits::default()
        },
    )
    .unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    for n in 0..10 {
        turn(&engine, &thread.id, &format!("Retain repair revision {n}")).await;
    }
    engine.context_compact(thread.id.clone()).await.unwrap();
    let state = engine.read(&thread.id, true).await.unwrap();
    assert_eq!(state.context_checkpoint.unwrap().summary, summary);
    engine.shutdown().await;
}

#[tokio::test]
async fn expanding_summary_falls_back_without_losing_user_input_or_failing_the_turn() {
    let data = tempfile::tempdir().unwrap();
    let model = continuity_model(&"summary ".repeat(1500));
    let engine = Engine::open(
        data.path(),
        model.clone(),
        Limits {
            context_window_bytes: 9000,
            context_recent_bytes: 8500,
            ..Limits::default()
        },
    )
    .unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    for input in [
        "Original goal",
        "修订：只修瞄准组合键，不重做已验收功能",
        "Verify current revision",
    ] {
        let state = turn(&engine, &thread.id, input).await;
        assert_eq!(state.turns.last().unwrap().status, TurnStatus::Completed);
    }
    let state = engine.read(&thread.id, true).await.unwrap();
    assert!(
        state
            .context_checkpoint
            .unwrap()
            .summary
            .starts_with("DEGRADED CONTEXT:")
    );
    assert!(
        model
            .requests
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .1
            .iter()
            .any(|m| m.role == "user"
                && m.text_content() == "修订：只修瞄准组合键，不重做已验收功能")
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn user_only_prefix_is_not_sent_to_a_paid_summarizer_when_it_cannot_shrink() {
    let data = tempfile::tempdir().unwrap();
    let model = continuity_model("summary");
    let engine = Engine::open(data.path(), model.clone(), limits()).unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    let result = turn(
        &engine,
        &thread.id,
        &"large exact user specification ".repeat(400),
    )
    .await;
    assert_eq!(result.turns.last().unwrap().status, TurnStatus::Completed);
    assert!(result.context_checkpoint.is_none());
    assert_eq!(model.requests.lock().unwrap().len(), 1);
    engine.shutdown().await;
}

#[tokio::test]
async fn explicit_compaction_target_leaves_headroom_across_long_conversations() {
    let mut compactions = Vec::new();
    for target in [0, 700] {
        let data = tempfile::tempdir().unwrap();
        let model = model(false);
        let engine = Engine::open(
            data.path(),
            model,
            Limits {
                context_window_bytes: 7000,
                context_recent_bytes: 5000,
                context_target_tokens: target,
                ..Limits::default()
            },
        )
        .unwrap();
        let thread = engine.create("/workspace".into()).await.unwrap();
        let mut result = thread.clone();
        for n in 0..16 {
            result = turn(
                &engine,
                &thread.id,
                &format!("Continue implementation checkpoint {n}; preserve original constraint"),
            )
            .await;
            assert_eq!(result.turns.last().unwrap().status, TurnStatus::Completed);
        }
        compactions.push(result.context_checkpoint.unwrap().compactions);
        engine.shutdown().await;
    }
    assert!(
        compactions[1] <= compactions[0] && compactions.iter().all(|n| *n > 0 && *n < 8),
        "automatic and explicit targets should leave headroom: {compactions:?}"
    );
}

#[tokio::test]
async fn steering_during_summary_is_preserved_and_not_misclassified_as_failed_reduction() {
    let data = tempfile::tempdir().unwrap();
    let model = continuity_model("Old prefix summarized; retain user corrections.");
    let engine = Engine::open(
        data.path(),
        model.clone(),
        Limits {
            context_window_bytes: 9000,
            context_recent_bytes: 256,
            ..Limits::default()
        },
    )
    .unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    turn(&engine, &thread.id, "Original task").await;
    turn(&engine, &thread.id, "Continue").await;
    let gate = Arc::new(Notify::new());
    *model.gate.lock().unwrap() = Some(gate.clone());
    let active = engine
        .start(&thread.id, vec![Input::text("Verify")])
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if model
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|(p, _)| *p == RequestPurpose::Summary)
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let revision = format!(
        "LATEST STEER: only repair chord. {}",
        "exact scope condition ".repeat(900)
    );
    engine
        .steer(&thread.id, &active.id, vec![Input::text(&revision)])
        .await
        .unwrap();
    gate.notify_one();
    let result = tokio::time::timeout(Duration::from_secs(5), engine.wait(&thread.id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        result.turns.last().unwrap().status,
        TurnStatus::Completed,
        "{:?}",
        result.turns.last().unwrap().error
    );
    {
        let calls = model.requests.lock().unwrap();
        assert!(
            calls
                .iter()
                .rev()
                .find(|(p, _)| *p == RequestPurpose::Solve)
                .unwrap()
                .1
                .iter()
                .any(|m| m.role == "user" && m.text_content() == revision)
        );
    }
    engine.shutdown().await;
}

struct LargeReadModel {
    requests: Mutex<Vec<(RequestPurpose, Vec<Message>)>>,
}
#[async_trait]
impl Model for LargeReadModel {
    fn name(&self) -> &str {
        "large-read-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<AgentStream> {
        self.chat_for(messages, tools, RequestPurpose::Solve).await
    }
    async fn chat_for(
        &self,
        messages: Vec<Message>,
        _: Vec<Value>,
        purpose: RequestPurpose,
    ) -> anyhow::Result<AgentStream> {
        let n = {
            let mut requests = self.requests.lock().unwrap();
            let n = requests
                .iter()
                .filter(|(p, _)| *p == RequestPurpose::Solve)
                .count();
            requests.push((purpose, messages));
            n
        };
        let event = if purpose == RequestPurpose::Summary {
            ModelEvent::text(
                "Read design chapter; preserve exact task. Asset interfaces are recorded and tools have completed.",
            )
        } else if n < 3 {
            ModelEvent::ToolCall(areal_engine::model::ToolCall {
                id: format!("read-{n}"),
                name: "read_design".into(),
                arguments: serde_json::json!({"large":n==1}).to_string(),
            })
        } else {
            ModelEvent::text("verified")
        };
        Ok(Box::pin(stream::iter([Ok(event)])))
    }
}
struct DesignHost;
#[async_trait]
impl areal_engine::tools::DynamicToolHost for DesignHost {
    fn id(&self) -> &str {
        "design-fixture"
    }
    fn is_closed(&self) -> bool {
        false
    }
    async fn call(
        &self,
        request: Value,
        _: tokio_util::sync::CancellationToken,
    ) -> anyhow::Result<areal_protocol::DynamicToolResponse> {
        Ok(areal_protocol::DynamicToolResponse {
            success: true,
            structured_content: None,
            content_items: vec![areal_protocol::ToolContent::InputText {
                text: if request["arguments"]["large"] == true {
                    (0..5000)
                        .map(|n| format!("完整设计章节 {n}: 关卡尺寸与道具点位必须准确。\n"))
                        .collect::<String>()
                } else {
                    "small checkpoint".into()
                },
            }],
        })
    }
}
#[tokio::test]
async fn completed_large_tool_round_is_summarized_once_without_losing_task_or_archive() {
    let data = tempfile::tempdir().unwrap();
    let model = Arc::new(LargeReadModel {
        requests: Mutex::new(vec![]),
    });
    let engine = Engine::open(
        data.path(),
        model.clone(),
        Limits {
            context_window_tokens: 16000,
            context_output_reserve_tokens: 2000,
            context_target_tokens: 8000,
            context_recent_bytes: 6000,
            context_window_bytes: 12000,
            max_children_per_turn: 0,
            max_agent_depth: 0,
            ..Limits::default()
        },
    )
    .unwrap();
    let thread=engine.create_with_tools("/workspace".into(),vec![areal_protocol::ToolDefinition {
        name:"read_design".into(),description:"read fixture chapter".into(),
        input_schema:serde_json::json!({"type":"object","properties":{"large":{"type":"boolean"}},"required":["large"]}),output_schema:None,
    }],Arc::new(DesignHost)).await.unwrap();
    let result = turn(
        &engine,
        &thread.id,
        "Original exact design contract: all three levels, no audio.",
    )
    .await;
    assert_eq!(
        result.turns.last().unwrap().status,
        TurnStatus::Completed,
        "{:?}",
        result.turns.last().unwrap().error
    );
    {
        let requests = model.requests.lock().unwrap();
        let solves: Vec<_> = requests
            .iter()
            .filter(|(p, _)| *p == RequestPurpose::Solve)
            .collect();
        assert_eq!(solves.len(), 4);
        assert_eq!(
            requests
                .iter()
                .filter(|(p, _)| *p == RequestPurpose::Summary)
                .count(),
            1
        );
        assert!(
            solves[2]
                .1
                .iter()
                .all(|m| !m.text_content().contains("完整设计章节 0:"))
        );
        assert!(solves[2].1.iter().any(
            |m| m.role == "user" && m.text_content().contains("Original exact design contract")
        ));
        assert!(
            solves[2]
                .1
                .iter()
                .any(|m| m.text_content().contains("Read design chapter"))
        );
        assert!(solves[2].1.iter().any(|m| {
            m.role == "areal_context"
                && m.text_content()
                    .starts_with("Internal checkpoint restoration")
        }));
        assert_eq!(result.context_checkpoint.as_ref().unwrap().compactions, 1);
        assert_eq!(
            result.turns[0]
                .items
                .iter()
                .filter(|i| matches!(
                    i,
                    areal_protocol::Item::DynamicToolCall {
                        success: Some(true),
                        ..
                    }
                ))
                .count(),
            3
        );
        assert!(
            serde_json::to_string(&result.turns)
                .unwrap()
                .contains("完整设计章节 0:")
        );
    }
    engine.shutdown().await;
}

#[tokio::test]
async fn byte_pressure_requests_shorter_checkpoint_even_with_large_token_target() {
    let data = tempfile::tempdir().unwrap();
    let model = continuity_model("Prior checks completed. Continue the current task.");
    let engine = Engine::open(
        data.path(),
        model.clone(),
        Limits {
            context_window_bytes: 9000,
            context_recent_bytes: 4096,
            context_target_tokens: 16000,
            ..Limits::default()
        },
    )
    .unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    for n in 0..8 {
        let result = turn(
            &engine,
            &thread.id,
            &format!("Continue checkpoint {n}; preserve the original constraint"),
        )
        .await;
        assert_eq!(result.turns.last().unwrap().status, TurnStatus::Completed);
    }
    let requests = model.requests.lock().unwrap().clone();
    assert!(
        requests
            .iter()
            .any(|(purpose, messages)| *purpose == RequestPurpose::Summary
                && messages[0]
                    .text_content()
                    .contains("Summary writing target:")),
        "byte pressure must guide summary size even when the token target is already satisfied"
    );
    engine.shutdown().await;
}

struct CancelledSummaryUsage {
    usage_polled: Arc<Notify>,
}
#[async_trait]
impl Model for CancelledSummaryUsage {
    fn name(&self) -> &str {
        "cancelled-summary-usage"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, m: Vec<Message>, t: Vec<Value>) -> anyhow::Result<ModelStream> {
        self.chat_for(m, t, RequestPurpose::Solve).await
    }
    async fn chat_for(
        &self,
        _: Vec<Message>,
        _: Vec<Value>,
        purpose: RequestPurpose,
    ) -> anyhow::Result<ModelStream> {
        use futures_util::StreamExt;
        let usage = ModelUsage {
            input_tokens: 11,
            output_tokens: 7,
            cached_input_tokens: 3,
        };
        if purpose == RequestPurpose::Summary {
            // 后续轮询已发生，证明消费者已经处理前一条用量，而不是仅打开了请求。
            let notify = self.usage_polled.clone();
            Ok(Box::pin(
                stream::iter([Ok(ModelEvent::Usage(usage))]).chain(stream::once(async move {
                    notify.notify_one();
                    std::future::pending::<anyhow::Result<ModelEvent>>().await
                })),
            ))
        } else {
            Ok(Box::pin(stream::iter([
                Ok(ModelEvent::text("recorded result ".repeat(90))),
                Ok(ModelEvent::Usage(usage)),
            ])))
        }
    }
}
#[tokio::test]
async fn cancelled_compaction_preserves_already_observed_turn_usage_across_restart() {
    let data = tempfile::tempdir().unwrap();
    let model = Arc::new(CancelledSummaryUsage {
        usage_polled: Arc::new(Notify::new()),
    });
    let engine = Engine::open(data.path(), model.clone(), limits()).unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    turn(&engine, &thread.id, "Original task").await;
    turn(&engine, &thread.id, "Continue").await;
    let active = engine
        .start(&thread.id, vec![Input::text("Verify")])
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), model.usage_polled.notified())
        .await
        .unwrap();
    engine.interrupt(&thread.id, &active.id).await.unwrap();
    let after = engine.wait(&thread.id).await.unwrap();
    assert_eq!(after.turns.last().unwrap().status, TurnStatus::Interrupted);
    assert!(after.context_checkpoint.is_none());
    let usage = after
        .turns
        .last()
        .unwrap()
        .usage
        .as_ref()
        .expect("observed summary usage must survive cancellation");
    assert_eq!(
        (
            usage.input_tokens,
            usage.output_tokens,
            usage.cached_input_tokens
        ),
        (11, 7, 3)
    );
    engine.shutdown().await;
    drop(engine);
    let restored = Engine::open(data.path(), model, limits()).unwrap();
    let saved = restored.read(&thread.id, true).await.unwrap();
    assert_eq!(
        saved.turns.last().unwrap().usage,
        after.turns.last().unwrap().usage
    );
    restored.shutdown().await;
}
