use areal_engine::model::{
    HttpModel, Message, Model, ModelCapabilities, ModelProtocol, ModelStream, RequestPurpose,
    ToolCallLimits,
};
use async_trait::async_trait;
use serde_json::Value;

// 仅处理解题请求的 HTTP fixture 不承担自动命名；先按用途分流，避免后台断言污染测试。
// Summary 的输出额度与生命周期由 session_name 测试单独覆盖。
pub struct SolveOnlyHttpModel(pub HttpModel);
#[async_trait]
impl Model for SolveOnlyHttpModel {
    fn name(&self) -> &str {
        self.0.name()
    }
    fn capabilities(&self) -> ModelCapabilities {
        self.0.capabilities()
    }
    fn replay_protocol(&self) -> Option<ModelProtocol> {
        self.0.replay_protocol()
    }
    async fn stream(&self, messages: Vec<Message>) -> anyhow::Result<ModelStream> {
        self.0.stream(messages).await
    }
    async fn chat_with_limits(
        &self,
        messages: Vec<Message>,
        tools: Vec<Value>,
        purpose: RequestPurpose,
        limits: ToolCallLimits,
        cap: Option<u64>,
    ) -> anyhow::Result<ModelStream> {
        anyhow::ensure!(purpose == RequestPurpose::Solve, "solve-only HTTP fixture");
        self.0
            .chat_with_limits(messages, tools, purpose, limits, cap)
            .await
    }
}
