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
async fn token_budget_can_compact_before_byte_limit_and_preserves_original_assertion() {
    let data = tempfile::tempdir().unwrap();
    let model = model(false);
    let limits = Limits {
        context_window_bytes: 1024 * 1024,
        context_recent_bytes: 256,
        context_window_tokens: 1800,
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
