use areal_config::CompletionRetryScope;
use areal_engine::{
    Engine, Limits,
    model::{AgentStream, Message, Model, ModelEvent, ModelFailure, ModelStream, ToolCall},
    tools::DynamicToolHost,
};
use areal_protocol::{DynamicToolResponse, Input, Item, ModelUsage, ToolDefinition, TurnStatus};
use async_trait::async_trait;
use futures_util::stream;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

#[derive(Clone, Copy)]
enum Step {
    Invalid,
    Empty,
    Write,
    Answer,
}

struct Scripted {
    steps: Vec<Step>,
    requests: AtomicUsize,
}

#[async_trait]
impl Model for Scripted {
    fn name(&self) -> &str {
        "completion-scope-fixture"
    }

    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }

    async fn chat(&self, messages: Vec<Message>, _: Vec<Value>) -> anyhow::Result<AgentStream> {
        let n = self.requests.fetch_add(1, Ordering::SeqCst);
        assert!(
            n < self.steps.len(),
            "recovery exceeded the fixture boundary"
        );
        // 已拒绝响应的正文不能作为事实回流；此前成功工具的结果必须保留。
        assert!(
            !messages
                .iter()
                .any(|m| m.text_content().contains("rejected claim"))
        );
        let confirmed = self.steps[..n]
            .iter()
            .filter(|s| matches!(s, Step::Write))
            .count();
        assert_eq!(
            messages.iter().filter(|m| m.role == "tool").count(),
            confirmed
        );
        let mut events = vec![Ok(ModelEvent::Usage(ModelUsage {
            input_tokens: 10,
            output_tokens: 2,
            cached_input_tokens: 4,
        }))];
        match self.steps[n] {
            Step::Invalid => {
                events.push(Ok(ModelEvent::text("rejected claim")));
                // 同一失败响应里已经解析出的工具也必须整体拒绝，不能提前执行。
                events.push(Ok(ModelEvent::ToolCall(ToolCall {
                    id: format!("rejected-{n}"),
                    name: "write_once".into(),
                    arguments: "{}".into(),
                })));
                events.push(Err(ModelFailure::InvalidToolArguments.into()));
            }
            Step::Empty => events.push(Ok(ModelEvent::text(" \n\t"))),
            Step::Write => events.push(Ok(ModelEvent::ToolCall(ToolCall {
                id: format!("accepted-{n}"),
                name: "write_once".into(),
                arguments: "{}".into(),
            }))),
            Step::Answer => events.push(Ok(ModelEvent::text("Confirmed writes retained."))),
        }
        Ok(Box::pin(stream::iter(events)))
    }
}

struct Writes(AtomicUsize);

#[async_trait]
impl DynamicToolHost for Writes {
    fn id(&self) -> &str {
        "scope-fixture"
    }
    fn is_closed(&self) -> bool {
        false
    }
    async fn call(
        &self,
        _: Value,
        _: tokio_util::sync::CancellationToken,
    ) -> anyhow::Result<DynamicToolResponse> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(DynamicToolResponse {
            raw_mcp_result: None,
            success: true,
            content_items: vec![],
            structured_content: Some(json!({"written": true})),
        })
    }
}

async fn run(
    steps: &[Step],
    limits: Limits,
    expected: TurnStatus,
    requests: usize,
    writes: usize,
    discarded: usize,
) {
    let data = tempfile::tempdir().unwrap();
    let model = Arc::new(Scripted {
        steps: steps.to_vec(),
        requests: AtomicUsize::new(0),
    });
    let host = Arc::new(Writes(AtomicUsize::new(0)));
    let engine = Engine::open(data.path(), model.clone(), limits).unwrap();
    let thread = engine
        .create_with_tools(
            "/workspace".into(),
            vec![ToolDefinition {
                name: "write_once".into(),
                description: "Fixture mutation".into(),
                input_schema: json!({"type": "object"}),
                output_schema: None,
            }],
            host.clone(),
        )
        .await
        .unwrap();
    engine
        .start(
            &thread.id,
            vec![Input::text("Perform the requested writes")],
        )
        .await
        .unwrap();
    let result = engine.wait(&thread.id).await.unwrap();
    let turn = result.turns.last().unwrap();
    assert_eq!(turn.status, expected, "{:?}", turn.error);
    assert_eq!(model.requests.load(Ordering::SeqCst), requests);
    assert_eq!(host.0.load(Ordering::SeqCst), writes);
    assert_eq!(
        turn.items
            .iter()
            .filter(|i| matches!(
                i,
                Item::DynamicToolCall {
                    success: Some(true),
                    ..
                }
            ))
            .count(),
        writes
    );
    let usage = turn.usage.as_ref().unwrap();
    assert_eq!(usage.input_tokens, requests as u64 * 10);
    assert_eq!(usage.output_tokens, requests as u64 * 2);
    assert_eq!(usage.cached_input_tokens, requests as u64 * 4);
    let audits: Vec<Value> = std::fs::read_dir(data.path().join("audit"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .map(|path| serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap())
        .filter(|value: &Value| value["kind"] == "discardedCompletion")
        .collect();
    assert_eq!(audits.len(), discarded);
    engine.shutdown().await;
}

#[tokio::test]
async fn default_turn_scope_stops_separated_failures_but_explicit_consecutive_can_continue() {
    let steps = [
        Step::Invalid,
        Step::Write,
        Step::Invalid,
        Step::Write,
        Step::Answer,
    ];
    run(
        &steps,
        Limits {
            max_completion_retries: 1,
            ..Limits::default()
        },
        TurnStatus::Failed,
        3,
        1,
        1,
    )
    .await;
    run(
        &steps,
        Limits {
            max_completion_retries: 1,
            completion_retry_scope: CompletionRetryScope::Consecutive,
            ..Limits::default()
        },
        TurnStatus::Completed,
        5,
        2,
        2,
    )
    .await;
}

#[tokio::test]
async fn consecutive_rejected_completions_never_reset_the_allowance() {
    for steps in [
        [Step::Invalid, Step::Invalid],
        [Step::Empty, Step::Empty],
        [Step::Invalid, Step::Empty],
    ] {
        run(
            &steps,
            Limits {
                max_completion_retries: 1,
                completion_retry_scope: CompletionRetryScope::Consecutive,
                ..Limits::default()
            },
            TurnStatus::Failed,
            2,
            0,
            1,
        )
        .await;
    }
}

#[tokio::test]
async fn selecting_consecutive_scope_does_not_enable_recovery_without_an_allowance() {
    run(
        &[Step::Invalid],
        Limits {
            completion_retry_scope: CompletionRetryScope::Consecutive,
            ..Limits::default()
        },
        TurnStatus::Failed,
        1,
        0,
        0,
    )
    .await;
}

#[tokio::test]
async fn consecutive_scope_does_not_reset_the_turn_tool_budget() {
    run(
        &[
            Step::Invalid,
            Step::Write,
            Step::Invalid,
            Step::Write,
            Step::Answer,
        ],
        Limits {
            max_completion_retries: 1,
            completion_retry_scope: CompletionRetryScope::Consecutive,
            max_tool_calls: 1,
            ..Limits::default()
        },
        TurnStatus::Failed,
        3,
        1,
        1,
    )
    .await;
}

#[tokio::test]
async fn explicit_empty_allowance_uses_the_same_scope_without_enabling_other_recovery() {
    let limits = Limits {
        max_empty_completion_retries: 1,
        completion_retry_scope: CompletionRetryScope::Consecutive,
        ..Limits::default()
    };
    run(
        &[
            Step::Empty,
            Step::Write,
            Step::Empty,
            Step::Write,
            Step::Answer,
        ],
        limits.clone(),
        TurnStatus::Completed,
        5,
        2,
        2,
    )
    .await;
    run(&[Step::Invalid], limits, TurnStatus::Failed, 1, 0, 0).await;
}
