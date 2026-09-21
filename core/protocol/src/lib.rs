use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub mod desktop;

pub const CODEX_PROTOCOL_VERSION: &str = "0.145.0";
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TurnStatus {
    InProgress,
    Completed,
    Interrupted,
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnError {
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Input {
    Text {
        text: String,
        #[serde(default, rename = "text_elements")]
        text_elements: Vec<Value>,
    },
    Image {
        url: String,
        #[serde(default)]
        detail: Option<ImageDetail>,
    },
    LocalImage {
        path: String,
        #[serde(default)]
        detail: Option<ImageDetail>,
    },
    Audio {
        url: String,
    },
    LocalAudio {
        path: String,
    },
    File {
        url: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        mime_type: Option<String>,
    },
}

impl Input {
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text {
            text: text.into(),
            text_elements: Vec::new(),
        }
    }
    pub fn as_text(&self) -> &str {
        match self {
            Self::Text { text, .. } => text,
            _ => "",
        }
    }
    pub fn modality(&self) -> Modality {
        match self {
            Self::Text { .. } => Modality::Text,
            Self::Image { .. } | Self::LocalImage { .. } => Modality::Image,
            Self::Audio { .. } | Self::LocalAudio { .. } => Modality::Audio,
            Self::File { .. } => Modality::File,
        }
    }
}

#[derive(
    Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum Modality {
    Text,
    Image,
    Audio,
    File,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ImageDetail {
    Auto,
    Low,
    High,
    Original,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaRef {
    pub uri: String,
    pub mime_type: String,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelUsage {
    pub input_tokens: u64,
    #[serde(default)]
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
}

impl ModelUsage {
    pub fn add_assign(&mut self, other: &Self) {
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.cached_input_tokens = self
            .cached_input_tokens
            .saturating_add(other.cached_input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Item {
    UserMessage {
        id: String,
        content: Vec<Input>,
    },
    AgentMessage {
        id: String,
        text: String,
    },
    DynamicToolCall {
        id: String,
        tool: String,
        arguments: Value,
        status: ToolStatus,
        success: Option<bool>,
        #[serde(rename = "contentItems")]
        content_items: Option<Vec<Value>>,
        #[serde(rename = "callId")]
        call_id: String,
        execution: Box<ToolExecution>,
    },
    AgentMedia {
        id: String,
        modality: Modality,
        media: MediaRef,
    },
    /// Provider-owned opaque context retained for subsequent model requests.
    ModelContext {
        id: String,
        value: Value,
    },
}

impl Item {
    pub fn id(&self) -> &str {
        match self {
            Self::UserMessage { id, .. }
            | Self::AgentMessage { id, .. }
            | Self::DynamicToolCall { id, .. }
            | Self::ModelContext { id, .. }
            | Self::AgentMedia { id, .. } => id,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ToolStatus {
    InProgress,
    Completed,
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ToolOutcome {
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Unknown,
}

/// Durable journal carried alongside the upstream dynamic-tool item projection.
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecution {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    pub runtime_epoch: String,
    pub scope_id: String,
    pub operation_id: String,
    pub outcome: ToolOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inspection: Option<String>,
    /// Dispatch journal, tool/hooks execution and result preparation; excludes final commit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hooks: Vec<HookExecution>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_arguments: Option<Value>,
    /// Post-hook arguments before resolving model-facing aliases into Runtime IDs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_arguments: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin: Option<PluginExecution>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginExecution {
    pub plugin_id: String,
    pub generation: String,
    pub scope_id: String,
    pub operations: Vec<PluginOperation>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginOperation {
    pub operation_id: String,
    pub kind: String,
    pub path: String,
    pub request_sha256: String,
    pub outcome: ToolOutcome,
    pub result: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DynamicToolResponse {
    pub success: bool,
    pub content_items: Vec<ToolContent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structured_content: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum ToolContent {
    InputText {
        text: String,
    },
    ArealMedia {
        modality: Modality,
        media: MediaRef,
    },
    /// 只在受信任 MCP 适配器与 Engine 间使用，禁止通过公共 wire 注入。
    #[serde(skip)]
    InlineMedia {
        modality: Modality,
        mime_type: String,
        data_base64: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HookExecution {
    pub name: String,
    pub event: String,
    pub operation_id: String,
    pub outcome: ToolOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instruction_snapshot: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configuration: Option<desktop::EffectiveConfig>,
    pub id: String,
    pub items: Vec<Item>,
    pub status: TurnStatus,
    pub error: Option<TurnError>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<ModelUsage>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ThreadStatus {
    Idle,
    Active {
        #[serde(rename = "activeFlags")]
        active_flags: Vec<String>,
    },
    SystemError,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContextCheckpoint {
    pub through_item_id: String,
    pub summary: String,
    pub compactions: u64,
    #[serde(default)]
    pub total_duration_ms: u64,
    #[serde(default)]
    pub usage: ModelUsage,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop: Option<desktop::DesktopState>,
    pub id: String,
    pub session_id: String,
    pub parent_thread_id: Option<String>,
    pub preview: String,
    pub model_provider: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub status: ThreadStatus,
    pub cwd: String,
    pub cli_version: String,
    pub source: String,
    pub ephemeral: bool,
    pub turns: Vec<Turn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_checkpoint: Option<ContextCheckpoint>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dynamic_tools: Vec<ToolDefinition>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

impl RpcError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: -32602,
            message: message.into(),
        }
    }
    pub fn method() -> Self {
        Self {
            code: -32601,
            message: "Method not found".into(),
        }
    }
}

pub fn notification(method: &str, params: Value) -> Value {
    json!({"method": method, "params": params})
}

pub fn response(id: Value, result: Result<Value, RpcError>) -> Value {
    match result {
        Ok(result) => json!({"id": id, "result": result}),
        Err(error) => json!({"id": id, "error": error}),
    }
}
