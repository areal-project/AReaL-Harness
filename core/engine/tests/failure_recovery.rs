use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelEvent, ModelStream, ToolCall},
    tools::DynamicToolHost,
};
use areal_protocol::{DynamicToolResponse, Input, ToolDefinition, TurnStatus};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Fixture {
    calls: Mutex<usize>,
    failures_before_success: Option<usize>,
}
#[async_trait]
impl DynamicToolHost for Fixture {
    fn id(&self) -> &str {
        "failure-fixture"
    }
    fn is_closed(&self) -> bool {
        false
    }
    async fn call(&self, _: Value, _: CancellationToken) -> anyhow::Result<DynamicToolResponse> {
        let success = {
            let mut calls = self.calls.lock().unwrap();
            *calls += 1;
            self.failures_before_success.is_some_and(|n| *calls > n)
        };
        Ok(DynamicToolResponse {
            success,
            content_items: vec![
                serde_json::from_value(
                    json!({"type":"inputText","text":if success {"target ready; update confirmed"}else{"target not found; state may have changed"}}),
                )
                .unwrap(),
            ],
            structured_content: None,
        })
    }
}
struct RecoveryModel;
#[async_trait]
impl Model for RecoveryModel {
    fn name(&self) -> &str {
        "failure-recovery-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, _: Vec<Value>) -> anyhow::Result<ModelStream> {
        // 每个新 Turn 从用户消息之后计算，证明提示不跨 Turn 延续。
        let start = messages.iter().rposition(|m| m.role == "user").unwrap();
        let results: Vec<_> = messages[start..]
            .iter()
            .filter(|m| m.role == "tool")
            .collect();
        if let Some(last) = results.last() {
            assert!(last.text_content().contains("target not found"));
            assert_eq!(
                last.text_content().contains("previousMatchingFailures=1"),
                results.len() == 2
            );
            if results.len() == 2 {
                assert!(last.text_content().contains("partially changed state"));
            }
        }
        let event = if results.len() < 2 {
            ModelEvent::ToolCall(ToolCall {
                id: format!("call-{}-{}", start, results.len()),
                name: "update".into(),
                arguments: json!({"target":"missing"}).to_string(),
            })
        } else {
            ModelEvent::text(
                "Stopped repeating; inspect current state before a different approach.",
            )
        };
        Ok(Box::pin(futures_util::stream::iter([Ok(event)])))
    }
}
#[tokio::test]
async fn recovery_notice_reaches_model_and_preserves_execution_and_turn_boundary() {
    let data = tempfile::tempdir().unwrap();
    let engine = Engine::open(data.path(), Arc::new(RecoveryModel), Limits::default()).unwrap();
    let host = Arc::new(Fixture::default());
    let thread = engine.create_with_tools("/fixture".into(), vec![ToolDefinition { name:"update".into(), description:"fixture state change".into(), input_schema:json!({"type":"object","properties":{"target":{"type":"string"}},"required":["target"]}), output_schema:None }], host.clone()).await.unwrap();
    for expected in [2, 4] {
        engine
            .start(&thread.id, vec![Input::text("Try the operation")])
            .await
            .unwrap();
        let done =
            tokio::time::timeout(std::time::Duration::from_secs(10), engine.wait(&thread.id))
                .await
                .unwrap()
                .unwrap();
        assert_eq!(done.turns.last().unwrap().status, TurnStatus::Completed);
        assert_eq!(
            *host.calls.lock().unwrap(),
            expected,
            "提示不能代替实际执行或发起隐式重试"
        );
    }
    engine.shutdown().await;
}

struct StubbornModel;
#[async_trait]
impl Model for StubbornModel {
    fn name(&self) -> &str {
        "bounded-failure-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, _: Vec<Value>) -> anyhow::Result<ModelStream> {
        let count = messages.iter().filter(|m| m.role == "tool").count();
        let event = if count < 4 {
            ModelEvent::ToolCall(ToolCall {
                id: format!("repeat-{count}"),
                name: "update".into(),
                arguments: json!({"target":"missing"}).to_string(),
            })
        } else {
            ModelEvent::text("Four attempts observed")
        };
        Ok(Box::pin(futures_util::stream::iter([Ok(event)])))
    }
}
#[tokio::test]
async fn repeated_failure_ablation_bounds_real_invocations_and_keeps_rejections() {
    for enabled in [false, true] {
        let data = tempfile::tempdir().unwrap();
        let engine = Engine::open(
            data.path(),
            Arc::new(StubbornModel),
            Limits {
                max_repeated_tool_failures: if enabled { 2 } else { 0 },
                ..Limits::default()
            },
        )
        .unwrap();
        let host = Arc::new(Fixture::default());
        let thread=engine.create_with_tools("/fixture".into(),vec![ToolDefinition {name:"update".into(),description:"fixture mutation".into(),input_schema:json!({"type":"object","properties":{"target":{"type":"string"}},"required":["target"]}),output_schema:None}],host.clone()).await.unwrap();
        engine
            .start(&thread.id, vec![Input::text("Try bounded operation")])
            .await
            .unwrap();
        let done =
            tokio::time::timeout(std::time::Duration::from_secs(10), engine.wait(&thread.id))
                .await
                .unwrap()
                .unwrap();
        let turn = done.turns.last().unwrap();
        assert_eq!(
            turn.status,
            if enabled {
                TurnStatus::Failed
            } else {
                TurnStatus::Completed
            }
        );
        assert_eq!(*host.calls.lock().unwrap(), if enabled { 2 } else { 4 });
        let items: Vec<_> = turn
            .items
            .iter()
            .filter(|i| matches!(i, areal_protocol::Item::DynamicToolCall { .. }))
            .collect();
        assert_eq!(items.len(), 4, "拒绝也必须保留逐调用记录");
        println!(
            "failure_ablation enabled={enabled}: executed={}, retained=4, status={:?}",
            *host.calls.lock().unwrap(),
            turn.status
        );
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn default_failure_policy_allows_unchanged_calls_after_transient_failures() {
    let data = tempfile::tempdir().unwrap();
    let engine = Engine::open(data.path(), Arc::new(StubbornModel), Limits::default()).unwrap();
    let host = Arc::new(Fixture {
        failures_before_success: Some(2),
        ..Default::default()
    });
    let thread = engine
        .create_with_tools(
            "/fixture".into(),
            vec![ToolDefinition {
                name: "update".into(),
                description: "fixture with transient failures".into(),
                input_schema: json!({"type":"object","properties":{"target":{"type":"string"}},"required":["target"]}),
                output_schema: None,
            }],
            host.clone(),
        )
        .await
        .unwrap();
    engine
        .start(&thread.id, vec![Input::text("Wait for the target")])
        .await
        .unwrap();
    let done = tokio::time::timeout(std::time::Duration::from_secs(10), engine.wait(&thread.id))
        .await
        .unwrap()
        .unwrap();
    let turn = done.turns.last().unwrap();
    assert_eq!(turn.status, TurnStatus::Completed);
    assert_eq!(*host.calls.lock().unwrap(), 4);
    let outcomes: Vec<_> = turn
        .items
        .iter()
        .filter_map(|item| match item {
            areal_protocol::Item::DynamicToolCall { success, .. } => *success,
            _ => None,
        })
        .collect();
    assert_eq!(outcomes, [false, false, true, true]);
    engine.shutdown().await;
}
