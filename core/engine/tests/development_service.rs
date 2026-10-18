use areal_engine::{
    Engine, Limits,
    model::{AgentStream, Message, Model, ModelEvent, ModelStream, ToolCall},
    tools::DynamicToolHost,
};
use areal_protocol::{DynamicToolResponse, Input, Item, ToolOutcome, desktop::ThreadStart};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

struct InspectFixture;
struct NoDynamicTools;

#[async_trait]
impl DynamicToolHost for NoDynamicTools {
    fn id(&self) -> &str {
        "no-dynamic-tools"
    }
    fn is_closed(&self) -> bool {
        false
    }
    async fn call(&self, _: Value, _: CancellationToken) -> anyhow::Result<DynamicToolResponse> {
        unreachable!()
    }
}

#[async_trait]
impl Model for InspectFixture {
    fn name(&self) -> &str {
        "development-service-inspect"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<AgentStream> {
        assert!(
            tools
                .iter()
                .any(|tool| tool["function"]["name"] == "development_service_inspect")
        );
        let event = if messages.last().is_some_and(|m| m.role == "tool") {
            assert_eq!(messages.last().unwrap().text_content(), r#"{"data":[]}"#);
            ModelEvent::text("no service")
        } else {
            ModelEvent::ToolCall(ToolCall {
                id: "inspect-1".into(),
                name: "development_service_inspect".into(),
                arguments: json!({}).to_string(),
            })
        };
        Ok(Box::pin(futures_util::stream::iter([Ok(event)])))
    }
}

#[tokio::test]
async fn model_inspects_only_its_thread_managed_services() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(InspectFixture), Limits::default()).unwrap();
    let thread = engine
        .create_configured(
            "test-client".into(),
            ThreadStart {
                request_id: "start-1".into(),
                cwd: Some(dir.path().to_string_lossy().into_owned()),
                agent_profile: None,
                model: None,
                parameters: Default::default(),
                dynamic_tools: vec![],
            },
            Arc::new(NoDynamicTools),
        )
        .await
        .unwrap();
    engine
        .start(&thread.id, vec![Input::text("Which service is running?")])
        .await
        .unwrap();
    let completed = engine.wait(&thread.id).await.unwrap();
    assert!(completed.turns[0].items.iter().any(
        |item| matches!(item, Item::DynamicToolCall { tool, execution, .. }
        if tool == "development_service_inspect" && execution.outcome == ToolOutcome::Succeeded)
    ));
    engine.shutdown().await;
}
