use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelEvent, ModelStream, ToolCall},
    tools::DynamicToolHost,
};
use areal_protocol::{
    AgentMessagePhase, DynamicToolResponse, Input, Item, ToolDefinition, TurnStatus,
};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

struct PhaseModel {
    fail: bool,
}
#[async_trait]
impl Model for PhaseModel {
    fn name(&self) -> &str {
        "phase-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, _: Vec<Value>) -> anyhow::Result<ModelStream> {
        let events = if messages.last().is_some_and(|m| m.role == "tool") {
            let mut events = vec![Ok(ModelEvent::text("Observed result"))];
            if self.fail {
                events.push(Err(anyhow::anyhow!("fixture terminal failure")));
            }
            events
        } else {
            vec![
                Ok(ModelEvent::text(
                    "Task complete (this text is not a final answer)",
                )),
                Ok(ModelEvent::ToolCall(ToolCall {
                    id: "inspect".into(),
                    name: "inspect".into(),
                    arguments: "{}".into(),
                })),
            ]
        };
        Ok(Box::pin(futures_util::stream::iter(events)))
    }
}
struct Host;
#[async_trait]
impl DynamicToolHost for Host {
    fn id(&self) -> &str {
        "phase-host"
    }
    fn is_closed(&self) -> bool {
        false
    }
    async fn call(&self, _: Value, _: CancellationToken) -> anyhow::Result<DynamicToolResponse> {
        Ok(DynamicToolResponse {
            success: true,
            content_items: vec![],
            structured_content: None,
        })
    }
}

#[tokio::test]
async fn phases_follow_execution_and_survive_events_and_persistence() {
    for fail in [false, true] {
        let data = tempfile::tempdir().unwrap();
        let model = Arc::new(PhaseModel { fail });
        let engine = Engine::open(data.path(), model.clone(), Limits::default()).unwrap();
        let thread = engine
            .create_with_tools(
                "/workspace".into(),
                vec![ToolDefinition {
                    name: "inspect".into(),
                    description: "fixture inspection".into(),
                    input_schema: json!({"type":"object"}),
                    output_schema: None,
                }],
                Arc::new(Host),
            )
            .await
            .unwrap();
        let mut events = engine.subscribe(&thread.id).await.unwrap();
        engine
            .start(&thread.id, vec![Input::text("Inspect")])
            .await
            .unwrap();
        let done = tokio::time::timeout(Duration::from_secs(5), engine.wait(&thread.id))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            done.turns[0].status,
            if fail {
                TurnStatus::Failed
            } else {
                TurnStatus::Completed
            }
        );
        let messages: Vec<_> = done.turns[0]
            .items
            .iter()
            .filter_map(|i| match i {
                Item::AgentMessage { phase, text, .. } => Some((*phase, text.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].0, Some(AgentMessagePhase::Commentary));
        assert_eq!(
            messages[1].0,
            Some(if fail {
                AgentMessagePhase::Commentary
            } else {
                AgentMessagePhase::FinalAnswer
            })
        );
        assert_eq!(messages[1].1, "Observed result");
        let mut started = 0;
        let mut completed = Vec::new();
        while let Ok(event) = events.try_recv() {
            if event["params"]["item"]["type"] != "agentMessage" {
                continue;
            }
            if event["method"] == "item/started" {
                started += 1;
                assert_eq!(event["params"]["item"]["phase"], "commentary");
            }
            if event["method"] == "item/completed" {
                completed.push(event["params"]["item"]["phase"].clone());
            }
        }
        assert_eq!(started, 2);
        assert_eq!(
            completed,
            vec![
                json!("commentary"),
                json!(if fail { "commentary" } else { "final_answer" })
            ]
        );
        drop(engine);
        let reopened = Engine::open(data.path(), model, Limits::default()).unwrap();
        let (snapshot, _) = reopened.snapshot_and_subscribe(&thread.id).await.unwrap();
        assert_eq!(
            serde_json::to_value(&snapshot.turns[0].items).unwrap(),
            serde_json::to_value(&done.turns[0].items).unwrap()
        );
    }
}

#[test]
fn old_messages_remain_unclassified_and_roundtrip_without_a_phase() {
    let old = json!({"type":"agentMessage","id":"old","text":"Keep this answer"});
    let item: Item = serde_json::from_value(old.clone()).unwrap();
    assert!(matches!(&item, Item::AgentMessage { phase: None, .. }));
    assert_eq!(serde_json::to_value(item).unwrap(), old);
}
