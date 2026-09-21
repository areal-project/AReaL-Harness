//! AReaL 客户端契约独立版本；能力不能从二进制版本推断。
use serde::{Deserialize, Serialize};

pub const API_VERSION: &str = "areal.core.v1";
pub const MAX_SUBSCRIPTIONS: usize = 128;

pub const METHODS: &[&str] = &[
    "initialize",
    "model/list",
    "thread/start",
    "thread/list",
    "thread/read",
    "thread/resume",
    "turn/start",
    "turn/steer",
    "turn/interrupt",
    "areal/capabilities",
    "areal/subscription/remove",
    "areal/agent/spawn",
    "areal/agent/list",
    "areal/tool/acknowledge",
];
pub const NOTIFICATIONS: &[&str] = &[
    "thread/started",
    "turn/started",
    "turn/completed",
    "item/started",
    "item/completed",
    "item/agentMessage/delta",
    "areal/agent/spawned",
    "areal/item/agentMedia/available",
    "areal/context/compacted",
    "areal/tool/cancelled",
    "areal/thread/configured",
    "areal/thread/archived",
    "areal/plan/updated",
    "areal/queue/updated",
    "areal/interaction/requested",
    "areal/interaction/resolved",
    "areal/process/updated",
    "areal/server/draining",
];

#[derive(Clone, Debug, Default, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilitiesRequest {
    pub api_version: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveSubscriptions {
    pub thread_ids: Vec<String>,
}

use super::{Input, MediaRef};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelParameters {
    pub temperature: Option<f64>,
    pub max_output_tokens: Option<u64>,
    pub reasoning_effort: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VersionRef {
    pub id: String,
    pub revision: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelRef {
    pub provider_id: String,
    pub model_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Provider {
    pub id: String,
    pub revision: u64,
    pub endpoint: String,
    pub protocol: String,
    pub models: Vec<String>,
    #[serde(default)]
    pub credential_ref: Option<String>,
    #[serde(default)]
    pub parameters: ModelParameters,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProfile {
    pub id: String,
    pub revision: String,
    pub display_name: String,
    pub instructions: String,
    #[serde(default)]
    pub skills: Vec<VersionRef>,
    #[serde(default)]
    pub tool_allowlist: Option<Vec<String>>,
    #[serde(default)]
    pub model: Option<ModelRef>,
    #[serde(default)]
    pub required_modalities: Vec<super::Modality>,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub approval_tools: Vec<String>,
    #[serde(default)]
    pub allow_thread_processes: bool,
    #[serde(default)]
    pub workflow: Option<VersionRef>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientOptions {
    #[serde(default)]
    pub read_only: bool,
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub append_instructions: String,
    pub tool_allowlist: Option<Vec<String>>,
    #[serde(default)]
    pub approval_tools: Vec<String>,
    #[serde(default)]
    pub preapproved_tools: Vec<String>,
    pub max_model_rounds: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EffectiveConfig {
    #[serde(default)]
    pub options: ClientOptions,
    #[serde(default)]
    pub selected_skills: Option<Vec<VersionRef>>,
    pub revision: u64,
    pub model: Option<ModelRef>,
    pub provider: Option<Provider>,
    pub profile: Option<AgentProfile>,
    #[serde(default)]
    pub parameters: ModelParameters,
    #[serde(default)]
    pub instructions: String,
    #[serde(default)]
    pub tool_allowlist: Option<Vec<String>>,
    #[serde(default)]
    pub read_only: bool,
}
impl Default for EffectiveConfig {
    fn default() -> Self {
        Self {
            revision: 1,
            options: ClientOptions::default(),
            selected_skills: None,
            model: None,
            provider: None,
            profile: None,
            parameters: ModelParameters::default(),
            instructions: String::new(),
            tool_allowlist: None,
            read_only: false,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanStep {
    pub id: String,
    pub text: String,
    pub status: String,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    pub revision: u64,
    pub steps: Vec<PlanStep>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Question {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default = "yes")]
    pub allow_free_text: bool,
}
fn yes() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Interaction {
    pub request_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub call_id: String,
    pub kind: String,
    pub status: String,
    pub expires_at: i64,
    pub questions: Vec<Question>,
    pub tool: Option<String>,
    #[serde(default)]
    pub generation: Option<String>,
    #[serde(default)]
    pub effective_permissions: Option<Value>,
    pub effective_arguments: Option<Value>,
    pub arguments_digest: Option<String>,
    pub response: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestReceipt {
    pub identity: String,
    pub request_id: String,
    pub method: String,
    pub digest: String,
    pub result: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueItem {
    pub id: String,
    pub input: Vec<Input>,
    pub configuration: EffectiveConfig,
    pub submitted_by: String,
    pub status: String,
    pub turn_id: Option<String>,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Queue {
    pub revision: u64,
    pub paused: bool,
    pub pause_reason: Option<String>,
    pub items: Vec<QueueItem>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopState {
    #[serde(default)]
    pub archived: bool,
    pub configuration: EffectiveConfig,
    pub plan: Plan,
    pub loaded_skills: BTreeMap<String, String>,
    pub queue: Queue,
    pub interaction_revision: u64,
    pub interactions: Vec<Interaction>,
    pub receipts: Vec<RequestReceipt>,
    pub uploads: Vec<MediaRef>,
    #[serde(default)]
    pub processes: Vec<ManagedProcess>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadStart {
    pub request_id: String,
    pub cwd: Option<String>,
    pub agent_profile: Option<VersionRef>,
    pub model: Option<ModelRef>,
    #[serde(default)]
    pub parameters: ModelParameters,
    #[serde(default)]
    pub dynamic_tools: Vec<super::ToolDefinition>,
}
#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnStart {
    pub request_id: String,
    pub thread_id: String,
    pub input: Vec<Input>,
    pub expected_config_revision: Option<u64>,
}
#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigureThread {
    pub options: Option<ClientOptions>,
    pub thread_id: String,
    pub expected_revision: u64,
    pub agent_profile: Option<VersionRef>,
    pub model: Option<ModelRef>,
    /// 清除会话模型覆盖，重新采用 Profile 或服务端默认模型。
    #[serde(default)]
    pub reset_model: bool,
    pub parameters: Option<ModelParameters>,
}
#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanUpdate {
    pub thread_id: String,
    pub expected_revision: u64,
    pub steps: Vec<PlanStep>,
}
#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Respond {
    pub request_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub answers: Option<BTreeMap<String, String>>,
    pub decision: Option<String>,
    pub arguments_digest: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessStart {
    pub request_id: String,
    pub thread_id: String,
    #[serde(default = "turn_lifetime")]
    pub lifetime: String,
    pub argv: Vec<String>,
    #[serde(default = "dot")]
    pub cwd: String,
    #[serde(default)]
    pub tty: bool,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub timeout_ms: Option<u64>,
}
fn turn_lifetime() -> String {
    "turn".into()
}
fn dot() -> String {
    ".".into()
}
#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedProcess {
    #[serde(default)]
    pub cleanup_attestation: Option<CleanupAttestation>,
    pub id: String,
    pub runtime_epoch: String,
    pub scope_operation_id: String,
    pub scope_id: Option<String>,
    pub operation_id: String,
    pub process_id: Option<String>,
    pub lifetime: String,
    pub turn_id: Option<String>,
    pub owner: String,
    pub argv: Vec<String>,
    pub state: String,
    pub cleanup_confirmed: bool,
    pub error: Option<String>,
    pub inputs: Vec<ProcessOperation>,
}
#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessOperation {
    pub operation_id: String,
    pub identity: String,
    pub action: String,
    pub digest: String,
    pub outcome: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSpawn {
    pub writes: Option<Vec<String>>,
    pub parent_thread_id: String,
    pub input: Vec<Input>,
    pub agent_profile: Option<VersionRef>,
    pub instructions: Option<String>,
    pub skills: Option<Vec<VersionRef>>,
    pub model: Option<ModelRef>,
    pub tool_allowlist: Option<Vec<String>>,
    pub workspace_mode: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CleanupAttestation {
    pub identity: String,
    pub note: String,
    pub recorded_at: i64,
}
