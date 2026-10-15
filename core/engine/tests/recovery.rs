use areal_engine::{
    Engine, Limits,
    model::{
        AgentStream, Message, Model, ModelEvent, ModelFailure, ModelStream, RequestPurpose,
        ToolCall,
    },
};
use areal_protocol::{Input, Item, ModelUsage, TurnStatus};
use async_trait::async_trait;
use futures_util::stream;
use serde_json::Value;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

struct NeverRun;
#[async_trait]
impl areal_engine::tools::DynamicToolHost for NeverRun {
    fn id(&self) -> &str {
        "fixture"
    }
    fn is_closed(&self) -> bool {
        false
    }
    async fn call(
        &self,
        _: Value,
        _: tokio_util::sync::CancellationToken,
    ) -> anyhow::Result<areal_protocol::DynamicToolResponse> {
        panic!("discarded completion must not execute")
    }
}

struct Recovery {
    requests: AtomicUsize,
    summaries: AtomicUsize,
    fail_summaries: bool,
}
#[async_trait]
impl Model for Recovery {
    fn name(&self) -> &str {
        "recovery-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat_for(
        &self,
        messages: Vec<Message>,
        tools: Vec<Value>,
        purpose: RequestPurpose,
    ) -> anyhow::Result<AgentStream> {
        if purpose == RequestPurpose::Summary {
            assert!(tools.is_empty());
            self.summaries.fetch_add(1, Ordering::SeqCst);
            return Ok(Box::pin(stream::iter([Ok(ModelEvent::ToolCall(
                ToolCall {
                    id: "rejected-summary".into(),
                    name: "run_command".into(),
                    arguments: "{}".into(),
                },
            ))])));
        }
        self.chat(messages, tools).await
    }
    async fn chat(&self, messages: Vec<Message>, _: Vec<Value>) -> anyhow::Result<AgentStream> {
        let n = self.requests.fetch_add(1, Ordering::SeqCst);
        if n == 0 && !self.fail_summaries {
            return Ok(Box::pin(stream::iter(vec![
                Ok(ModelEvent::text("Discard this unfinished claim")),
                Ok(ModelEvent::ToolCall(ToolCall {
                    id: "never-execute".into(),
                    name: "fs_write".into(),
                    arguments: r#"{"path":"danger"}"#.into(),
                })),
                Ok(ModelEvent::Usage(ModelUsage {
                    input_tokens: 3,
                    output_tokens: 2,
                    cached_input_tokens: 0,
                })),
                Err(ModelFailure::Truncated.into()),
            ])));
        }
        assert!(
            !messages
                .iter()
                .any(|m| m.text_content().contains("Discard this"))
        );
        Ok(Box::pin(stream::iter([
            Ok(ModelEvent::text(if self.fail_summaries {
                "observed result ".repeat(95)
            } else {
                "Verified completion".into()
            })),
            Ok(ModelEvent::Usage(ModelUsage {
                input_tokens: 5,
                output_tokens: 3,
                cached_input_tokens: 0,
            })),
        ])))
    }
}
#[tokio::test]
async fn retry_discards_only_failed_completion_and_never_executes_its_calls() {
    let data = tempfile::tempdir().unwrap();
    let model = Arc::new(Recovery {
        requests: AtomicUsize::new(0),
        summaries: AtomicUsize::new(0),
        fail_summaries: false,
    });
    let engine = Engine::open(
        data.path(),
        model.clone(),
        Limits {
            max_completion_retries: 1,
            ..Limits::default()
        },
    )
    .unwrap();
    let t = engine
        .create_with_tools(
            "/workspace".into(),
            vec![areal_protocol::ToolDefinition {
                name: "fs_write".into(),
                description: "fixture mutation".into(),
                input_schema: serde_json::json!({"type":"object"}),
                output_schema: None,
            }],
            Arc::new(NeverRun),
        )
        .await
        .unwrap();
    engine
        .start(&t.id, vec![Input::text("Implement safely")])
        .await
        .unwrap();
    let result = engine.wait(&t.id).await.unwrap();
    let turn = result.turns.last().unwrap();
    assert_eq!(turn.status, TurnStatus::Completed);
    assert_eq!(model.requests.load(Ordering::SeqCst), 2);
    assert!(
        !turn
            .items
            .iter()
            .any(|i| matches!(i, Item::DynamicToolCall { .. }))
    );
    assert!(
        !turn
            .items
            .iter()
            .any(|i| matches!(i,Item::AgentMessage{text,..} if text.contains("Discard this")))
    );
    assert_eq!(turn.usage.as_ref().unwrap().input_tokens, 8);
    let audit = std::fs::read_dir(data.path().join("audit"))
        .unwrap()
        .find(|entry| {
            entry
                .as_ref()
                .is_ok_and(|e| e.path().extension().is_some_and(|x| x == "json"))
        })
        .unwrap()
        .unwrap()
        .path();
    let audit = std::fs::read_to_string(audit).unwrap();
    assert!(audit.contains("never-execute"));
    assert!(audit.contains("Discard this"));
    engine.shutdown().await;
}
#[tokio::test]
async fn malformed_summary_retries_then_preserves_originals_without_executing_tools() {
    let data = tempfile::tempdir().unwrap();
    let model = Arc::new(Recovery {
        requests: AtomicUsize::new(0),
        summaries: AtomicUsize::new(0),
        fail_summaries: true,
    });
    let engine = Engine::open(
        data.path(),
        model.clone(),
        Limits {
            context_window_bytes: 2200,
            context_recent_bytes: 256,
            ..Limits::default()
        },
    )
    .unwrap();
    let t = engine.create("/workspace".into()).await.unwrap();
    for prompt in ["Original task", "Continue", "Verify"] {
        engine
            .start(&t.id, vec![Input::text(prompt)])
            .await
            .unwrap();
        assert_eq!(
            engine
                .wait(&t.id)
                .await
                .unwrap()
                .turns
                .last()
                .unwrap()
                .status,
            TurnStatus::Completed
        );
    }
    let t = engine.read(&t.id, true).await.unwrap();
    assert_eq!(model.summaries.load(Ordering::SeqCst), 2);
    assert!(t.context_checkpoint.is_none());
    let prompts: Vec<_> = t
        .turns
        .iter()
        .flat_map(|turn| &turn.items)
        .filter_map(|item| {
            if let Item::UserMessage { content, .. } = item {
                Some(content.iter().map(Input::as_text).collect::<String>())
            } else {
                None
            }
        })
        .collect();
    assert_eq!(prompts, ["Original task", "Continue", "Verify"]);
    assert!(
        !t.turns
            .iter()
            .flat_map(|t| &t.items)
            .any(|i| matches!(i, Item::DynamicToolCall { .. }))
    );
    assert_eq!(
        std::fs::read_dir(data.path().join("audit"))
            .unwrap()
            .filter(|entry| {
                if entry
                    .as_ref()
                    .unwrap()
                    .path()
                    .extension()
                    .is_none_or(|x| x != "json")
                {
                    return false;
                }
                let audit: Value =
                    serde_json::from_slice(&std::fs::read(entry.as_ref().unwrap().path()).unwrap())
                        .unwrap();
                audit["kind"] == "contextSummary"
            })
            .count(),
        2
    );
    engine.shutdown().await;
}

struct EmptyThenAnswer {
    requests: AtomicUsize,
    always_empty: bool,
    media: bool,
}
#[async_trait]
impl Model for EmptyThenAnswer {
    fn name(&self) -> &str {
        "empty-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, _: Vec<Value>) -> anyhow::Result<AgentStream> {
        let n = self.requests.fetch_add(1, Ordering::SeqCst);
        let mut events = vec![Ok(ModelEvent::Usage(ModelUsage {
            input_tokens: 10,
            output_tokens: 3,
            cached_input_tokens: 0,
        }))];
        if self.media {
            events.push(Ok(ModelEvent::Binary {
                modality: areal_protocol::Modality::Image,
                mime_type: "image/png".into(),
                data: vec![1, 2, 3],
            }));
        } else if n == 0 || self.always_empty {
            events.push(Ok(ModelEvent::ProviderContext(
                serde_json::json!({"type":"chat_reasoning","reasoning_content":"internal only"}),
            )));
            events.push(Ok(ModelEvent::text(" \n\t")));
        } else {
            assert!(
                messages
                    .last()
                    .unwrap()
                    .text_content()
                    .contains("no visible answer")
            );
            assert!(!messages.iter().any(|m| m.provider_context.is_some()));
            events.push(Ok(ModelEvent::text(
                "No changes needed; inspected the supplied evidence.",
            )));
        }
        Ok(Box::pin(stream::iter(events)))
    }
}
#[tokio::test]
async fn empty_visible_stop_recovers_but_reasoning_is_not_a_final_answer() {
    for (always_empty, media, expected, requests) in [
        (false, false, TurnStatus::Completed, 2),
        (true, false, TurnStatus::Failed, 3),
        (false, true, TurnStatus::Completed, 1),
    ] {
        let data = tempfile::tempdir().unwrap();
        let model = Arc::new(EmptyThenAnswer {
            requests: AtomicUsize::new(0),
            always_empty,
            media,
        });
        let engine = Engine::open(
            data.path(),
            model.clone(),
            Limits {
                max_empty_completion_retries: 2,
                ..Limits::default()
            },
        )
        .unwrap();
        let thread = engine.create("/workspace".into()).await.unwrap();
        engine
            .start(&thread.id, vec![Input::text("Inspect the task")])
            .await
            .unwrap();
        let thread = engine.wait(&thread.id).await.unwrap();
        let turn = thread.turns.last().unwrap();
        assert_eq!(turn.status, expected);
        assert_eq!(model.requests.load(Ordering::SeqCst), requests);
        assert_eq!(
            turn.usage.as_ref().unwrap().input_tokens,
            requests as u64 * 10
        );
        if always_empty {
            assert!(
                turn.error
                    .as_ref()
                    .unwrap()
                    .message
                    .contains("without visible output")
            );
        }
        engine.shutdown().await;
    }
}

struct ConfirmedWriteThenEmpty(AtomicUsize);

#[tokio::test]
async fn empty_recovery_is_disabled_by_default() {
    let data = tempfile::tempdir().unwrap();
    let model = Arc::new(EmptyThenAnswer {
        requests: AtomicUsize::new(0),
        always_empty: true,
        media: false,
    });
    let engine = Engine::open(data.path(), model.clone(), Limits::default()).unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    engine
        .start(&thread.id, vec![Input::text("inspect")])
        .await
        .unwrap();
    let result = engine.wait(&thread.id).await.unwrap();
    assert_eq!(result.turns[0].status, TurnStatus::Failed);
    assert_eq!(model.requests.load(Ordering::SeqCst), 1);
    engine.shutdown().await;
}

struct InterleavedEmpty(AtomicUsize);
#[async_trait]
impl Model for InterleavedEmpty {
    fn name(&self) -> &str {
        "interleaved-empty"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, _: Vec<Message>, _: Vec<Value>) -> anyhow::Result<AgentStream> {
        let n = self.0.fetch_add(1, Ordering::SeqCst);
        assert!(
            n < 5,
            "successful tools must not reset the Turn recovery allowance"
        );
        let event = if n.is_multiple_of(2) {
            ModelEvent::text(" \n\t")
        } else {
            ModelEvent::ToolCall(ToolCall {
                id: format!("write-{n}"),
                name: "write_once".into(),
                arguments: "{}".into(),
            })
        };
        Ok(Box::pin(stream::iter([
            Ok(event),
            Ok(ModelEvent::Usage(ModelUsage {
                input_tokens: 10,
                output_tokens: 1,
                cached_input_tokens: 0,
            })),
        ])))
    }
}

#[tokio::test]
async fn blank_recovery_is_bounded_across_successful_tools_and_charges_all_attempts() {
    let data = tempfile::tempdir().unwrap();
    let host = Arc::new(CountWrites(AtomicUsize::new(0)));
    let model = Arc::new(InterleavedEmpty(AtomicUsize::new(0)));
    let engine = Engine::open(
        data.path(),
        model.clone(),
        Limits {
            max_empty_completion_retries: 2,
            ..Limits::default()
        },
    )
    .unwrap();
    let thread = engine
        .create_with_tools(
            "/workspace".into(),
            vec![areal_protocol::ToolDefinition {
                name: "write_once".into(),
                description: "fixture".into(),
                input_schema: serde_json::json!({"type":"object"}),
                output_schema: None,
            }],
            host.clone(),
        )
        .await
        .unwrap();
    engine
        .start(&thread.id, vec![Input::text("two writes")])
        .await
        .unwrap();
    let result = engine.wait(&thread.id).await.unwrap();
    assert_eq!(result.turns[0].status, TurnStatus::Failed);
    assert_eq!(model.0.load(Ordering::SeqCst), 5);
    assert_eq!(host.0.load(Ordering::SeqCst), 2);
    assert_eq!(result.turns[0].usage.as_ref().unwrap().input_tokens, 50);
    engine.shutdown().await;
}
struct CountWrites(AtomicUsize);
#[async_trait]
impl areal_engine::tools::DynamicToolHost for CountWrites {
    fn id(&self) -> &str {
        "write-fixture"
    }
    fn is_closed(&self) -> bool {
        false
    }
    async fn call(
        &self,
        _: Value,
        _: tokio_util::sync::CancellationToken,
    ) -> anyhow::Result<areal_protocol::DynamicToolResponse> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(areal_protocol::DynamicToolResponse {
            success: true,
            content_items: vec![],
            structured_content: Some(serde_json::json!({"written":true})),
        })
    }
}
#[async_trait]
impl Model for ConfirmedWriteThenEmpty {
    fn name(&self) -> &str {
        "confirmed-write"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, _: Vec<Value>) -> anyhow::Result<AgentStream> {
        let n = self.0.fetch_add(1, Ordering::SeqCst);
        let events = match n {
            0 => vec![Ok(ModelEvent::ToolCall(ToolCall {
                id: "once".into(),
                name: "write_once".into(),
                arguments: "{}".into(),
            }))],
            1 => vec![],
            2 => {
                assert_eq!(messages.iter().filter(|m| m.role == "tool").count(), 1);
                vec![Ok(ModelEvent::text("Confirmed previous write retained."))]
            }
            _ => panic!("unexpected retry"),
        };
        Ok(Box::pin(stream::iter(events)))
    }
}
#[tokio::test]
async fn empty_retry_keeps_confirmed_mutations_and_does_not_replay_them() {
    let data = tempfile::tempdir().unwrap();
    let host = Arc::new(CountWrites(AtomicUsize::new(0)));
    let engine = Engine::open(
        data.path(),
        Arc::new(ConfirmedWriteThenEmpty(AtomicUsize::new(0))),
        Limits {
            max_completion_retries: 1,
            ..Limits::default()
        },
    )
    .unwrap();
    let thread = engine
        .create_with_tools(
            "/workspace".into(),
            vec![areal_protocol::ToolDefinition {
                name: "write_once".into(),
                description: "Fixture side effect".into(),
                input_schema: serde_json::json!({"type":"object"}),
                output_schema: None,
            }],
            host.clone(),
        )
        .await
        .unwrap();
    engine
        .start(&thread.id, vec![Input::text("Write once")])
        .await
        .unwrap();
    let thread = engine.wait(&thread.id).await.unwrap();
    assert_eq!(thread.turns.last().unwrap().status, TurnStatus::Completed);
    assert_eq!(host.0.load(Ordering::SeqCst), 1);
    assert_eq!(
        thread.turns[0]
            .items
            .iter()
            .filter(|i| matches!(i, Item::DynamicToolCall { .. }))
            .count(),
        1
    );
    engine.shutdown().await;
}
