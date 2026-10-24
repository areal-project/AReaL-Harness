//! AReaL 客户端契约独立版本；能力不能从二进制版本推断。
use serde::{Deserialize, Serialize};

pub const API_VERSION: &str = "areal.core.v1";
pub const MAX_SUBSCRIPTIONS: usize = 128;

pub const BROWSER_V1_BUNDLE: &str = "areal.browser.v1";
pub const COMPUTER_V1_BUNDLE: &str = "areal.computer.v1";

/// 本机电脑工具与浏览器分别启用，操作仍由 Core 审批和记录。
pub fn computer_v1_tool() -> super::ToolDefinition {
    super::ToolDefinition {
        name: "computer_v1".into(),
        description: "Control authorized local desktop applications. Call describe first. Get fresh app state before acting. OS permissions must be granted by the user in Computer control settings. Never replay an action whose dispatch is unknown.".into(),
        input_schema: serde_json::json!({
            "type":"object",
            "properties":{"operation":{"type":"string"},"parameters":{"type":"object"}},
            "required":["operation","parameters"],
            "additionalProperties":false
        }),
        output_schema: None,
    }
}

/// 已部署的 Browser 工具包；追加请求只选择此身份，不接受客户端定义。
pub fn browser_v1_tool() -> super::ToolDefinition {
    super::ToolDefinition {
        name: "browser_v1".into(),
        description: "Inspect and navigate authorized pages in this desktop thread. Call describe first; page changes require Core approval.".into(),
        input_schema: serde_json::json!({
            "type":"object",
            "properties":{"operation":{"type":"string"},"parameters":{"type":"object"}},
            "required":["operation","parameters"],
            "additionalProperties":false
        }),
        output_schema: None,
    }
}

#[derive(Clone, Copy, Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum MethodEffect {
    Read,
    Subscription,
    Mutation,
}

#[derive(Clone, Copy, Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ReceiptFamily {
    Thread,
    Task,
    Management,
}

#[derive(Clone, Copy, Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MethodSemantics {
    pub effect: MethodEffect,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt: Option<ReceiptFamily>,
}

/// 方法声明同时产生语义，避免新增路由后客户端误判写入。
#[macro_export]
macro_rules! method_catalog {
    ($($method:literal => $effect:ident $(, $receipt:ident)?;)+) => {
        pub const METHODS: &[&str] = &[$($method),+];
        pub fn method_semantics(method: &str) -> Option<$crate::desktop::MethodSemantics> {
            match method {
                $($method => Some($crate::desktop::MethodSemantics {
                    effect: $crate::desktop::MethodEffect::$effect,
                    receipt: $crate::method_catalog!(@receipt $($receipt)?),
                }),)+
                _ => None,
            }
        }
    };
    (@receipt) => { None };
    (@receipt $receipt:ident) => { Some($crate::desktop::ReceiptFamily::$receipt) };
}

crate::method_catalog! {
    "initialize" => Read;
    "model/list" => Read;
    "thread/start" => Mutation;
    "thread/list" => Read;
    "thread/read" => Read;
    "thread/resume" => Subscription;
    "areal/thread/observe" => Subscription;
    "turn/start" => Mutation;
    "turn/steer" => Mutation;
    "turn/interrupt" => Mutation;
    "areal/capabilities" => Read;
    "areal/subscription/remove" => Subscription;
    "areal/thread/tools/attach" => Mutation, Thread;
    "areal/agent/spawn" => Mutation;
    "areal/agent/delegate" => Mutation;
    "areal/execution/list" => Read;
    "areal/execution/read" => Read;
    "areal/execution/wait" => Read;
    "areal/execution/cancel" => Mutation;
    "areal/execution/apply" => Mutation;
    "areal/execution/artifact" => Read;
    "areal/agent/list" => Read;
    "areal/tool/acknowledge" => Mutation;
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum OperationTarget {
    Project,
    Thread {
        #[serde(rename = "threadId")]
        thread_id: String,
    },
    Task {
        #[serde(rename = "taskId")]
        task_id: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationRef {
    pub request_id: String,
    pub method: String,
    pub target: OperationTarget,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum FailureOutcome {
    NoMutation,
    Rejected,
    Unconfirmed { operation: OperationRef },
    Admitted { operation: OperationRef },
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Recovery {
    RetryRead,
    QueryOriginal,
    NeedsUser,
    None,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationFailure {
    pub reason: String,
    pub outcome: FailureOutcome,
    pub recovery: Recovery,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppliedModelConfiguration {
    pub revision: String,
    pub sequence: u64,
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelConfigurationRead {
    pub request_id: Option<String>,
    pub expected_generation: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelConfigurationApply {
    pub request_id: String,
    pub expected_generation: String,
    pub expected_applied: AppliedModelConfiguration,
    pub target_revision: String,
    pub credentials: std::collections::BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachBrowserTools {
    pub request_id: String,
    pub thread_id: String,
    pub expected_toolset_revision: u64,
    pub bundle_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObserveThread {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<ObservationMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1, max = 1048576))]
    pub max_bytes: Option<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ObservationMode {
    Bounded,
}

pub const DEFAULT_HISTORY_PAGE_BYTES: usize = 256 * 1024;
pub const MAX_HISTORY_PAGE_BYTES: usize = 1024 * 1024;

/// 只用于显示 DTO；绝不进入执行域 Item 或持久 Thread。
#[derive(Clone, Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeferredHistoryItem {
    pub r#type: String,
    pub id: String,
    pub original_type: String,
    pub cursor: String,
    pub version: String,
    pub total_bytes: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForkAnchor {
    pub turn_id: String,
    pub boundary: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForkThread {
    pub request_id: String,
    pub source_thread_id: String,
    pub anchor: ForkAnchor,
    pub workspace_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<ForkTarget>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForkTarget {
    #[serde(default)]
    pub agent_profile: Option<VersionRef>,
    #[serde(default)]
    pub model: Option<ModelRef>,
    #[serde(default)]
    pub parameters: Option<ModelParameters>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SideAnchor {
    pub kind: String,
    pub turn_id: Option<String>,
    pub boundary: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SideStart {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub reset_model: bool,
    pub request_id: String,
    pub source_thread_id: String,
    pub anchor: Option<SideAnchor>,
    pub selection: Option<SideSelection>,
    pub workspace_access: String,
    pub model: Option<ModelRef>,
    pub parameters: Option<ModelParameters>,
    pub input: Vec<super::Input>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SideCreate {
    pub request_id: String,
    pub source_thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_input: Option<Vec<super::Input>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SideClose {
    pub request_id: String,
    pub thread_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SideSelection {
    ItemRange {
        turn_id: String,
        item_id: String,
        start_utf8: usize,
        end_utf8: usize,
        text_sha256: String,
    },
    UserQuote {
        text: String,
        claimed_turn_id: Option<String>,
        claimed_item_id: Option<String>,
    },
}

/// 与观察快照同锁捕获，不持久化到 Thread；标识仅对可见 Task 暴露。
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ThreadOwnership {
    Ordinary,
    Task {
        #[serde(rename = "taskId", skip_serializing_if = "Option::is_none")]
        task_id: Option<String>,
        #[serde(rename = "runId", skip_serializing_if = "Option::is_none")]
        run_id: Option<String>,
    },
}
pub const SERVER_REQUESTS: &[&str] = &[
    "item/tool/call",
    "areal/task/prepare",
    "areal/browser/prepare",
    "areal/computer/prepare",
    "areal/cua/turnEnded",
];

pub const NOTIFICATIONS: &[&str] = &[
    "areal/mcp/app/notification",
    "areal/mcp/tool/result",
    "areal/mcp/form/requested",
    "areal/goal/updated",
    "areal/goal/cleared",
    "thread/started",
    "turn/started",
    "turn/completed",
    "item/started",
    "item/completed",
    "item/agentMessage/delta",
    "areal/agent/spawned",
    "areal/item/agentMedia/available",
    "areal/context/compacted",
    "areal/context/compactionFailed",
    "areal/model/completionDiscarded",
    "areal/model/watchdogRetry",
    "areal/tool/cancelled",
    "areal/thread/configured",
    "areal/thread/edited",
    "areal/thread/predictionChanged",
    "areal/thread/archived",
    "areal/thread/unarchived",
    "areal/plan/updated",
    "areal/queue/updated",
    "areal/side/capacity",
    "areal/task/updated",
    "areal/interaction/requested",
    "areal/interaction/resolved",
    "areal/thread/tools/attached",
    "areal/process/updated",
    "areal/server/draining",
    "areal/server/configurationChanged",
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window_tokens: Option<usize>,
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_summary: Option<String>,
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

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelCapabilityConfig {
    pub tools: bool,
    pub vision: bool,
    pub reasoning: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort_options: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Provider {
    pub id: String,
    pub revision: u64,
    pub endpoint: String,
    pub protocol: String,
    pub models: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub model_parameters: BTreeMap<String, ModelParameters>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub model_capabilities: BTreeMap<String, ModelCapabilityConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_source: Option<super::context::ContextWindowSource>,
    #[serde(default)]
    pub credential_ref: Option<String>,
    #[serde(default)]
    pub parameters: ModelParameters,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProfile {
    /// 显式 Profile 默认不继承插件；此项仍受父任务范围与逐定义信任约束。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub allow_plugin_skills: bool,
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

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PermissionPreset {
    Ask,
    AutoReview,
    FullAccess,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ResourcePolicy {
    Workspace,
    Deployment,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalReviewer {
    Human,
    Model,
    None,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EffectivePermissions {
    pub resources: ResourcePolicy,
    pub reviewer: ApprovalReviewer,
    pub full_access_available: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientOptions {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub external_cua: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_preset: Option<PermissionPreset>,
    #[serde(default)]
    pub interaction_mode: crate::tasks::InteractionMode,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<EffectivePermissions>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<super::context::ContextWindow>,
    /// Core-owned scope marker; legacy snapshots conservatively keep explicit scope.
    #[serde(default)]
    pub allow_plugin_skills: bool,
    /// None on live ordinary sessions; revisions are fixed at Turn/queue admission.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_skills: Option<Vec<VersionRef>>,
    /// 服务默认模型在提交时固定；不包含端点或凭据。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model_revision: Option<String>,
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
            permissions: None,
            context_window: None,
            allow_plugin_skills: false,
            plugin_skills: None,
            default_model_revision: None,
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

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionGrant {
    pub key: String,
    pub tool: String,
    pub arguments: Value,
}

/// Model preference captured in the same snapshot as a user submission receipt.
#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptedModelSelection {
    pub accepted_at: u64,
    pub model: Option<ModelRef>,
    pub model_id: String,
    pub reasoning_effort: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PromptPrediction {
    Pending {
        source_turn_id: String,
        configuration_revision: u64,
    },
    Ready {
        source_turn_id: String,
        configuration_revision: u64,
        text: String,
    },
    Unavailable {
        source_turn_id: String,
        configuration_revision: u64,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromptPredictionRequest {
    pub thread_id: String,
    pub source_turn_id: String,
    pub operation: PromptPredictionOperation,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PromptPredictionOperation {
    Request,
    Cancel,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_prediction: Option<PromptPrediction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_accepted_model: Option<AcceptedModelSelection>,
    /// 只在读取活跃 Side 时由 Core 投影；历史快照不承载模型等待状态。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side_capacity_status: Option<String>,
    #[serde(default)]
    pub executions: Vec<crate::delegation::ExecutionRecord>,
    #[serde(default)]
    pub execution_policy: crate::delegation::ChildExecutionPolicy,
    #[serde(default)]
    pub permission_grants: Vec<PermissionGrant>,
    /// Core-owned hook invocation receipts. Running entries recover as UNKNOWN,
    /// never as instructions to execute the hook again.
    #[serde(default)]
    pub hook_runs: Vec<HookRun>,
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
    /// 自动绑定的 Profile Workflow；线程恢复时不会再次启动。
    #[serde(default)]
    pub workflow_run: Option<WorkflowRun>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HookRun {
    pub id: String,
    pub plugin_id: String,
    pub package_digest: String,
    pub definition_digest: String,
    pub event: String,
    pub turn_id: Option<String>,
    pub tool_use_id: Option<String>,
    pub operation_id: Option<String>,
    pub outcome: String,
    pub asynchronous: bool,
    pub delivered: bool,
    pub output: serde_json::Value,
    pub inspection: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRun {
    pub workflow: VersionRef,
    pub workgroup_id: String,
    pub status: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadStart {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<ClientOptions>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admission_guard: Option<ThreadStartAdmissionGuard>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admission_guard: Option<TurnStartAdmissionGuard>,
    #[serde(default)]
    pub interaction_mode: Option<crate::tasks::InteractionMode>,
    pub request_id: String,
    pub thread_id: String,
    pub input: Vec<Input>,
    pub expected_config_revision: Option<u64>,
}
#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnSubmit {
    pub request_id: String,
    pub thread_id: String,
    pub expected_config_revision: u64,
    pub intent: TurnSubmitIntent,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum TurnSubmitIntent {
    Message {
        input: Vec<Input>,
    },
    Continue {
        #[serde(rename = "expectedTurnId")]
        expected_turn_id: String,
    },
    Edit {
        #[serde(rename = "expectedTurnId")]
        expected_turn_id: String,
        #[serde(rename = "itemId")]
        item_id: String,
        input: Vec<Input>,
    },
}
#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnInterrupt {
    pub thread_id: String,
    pub turn_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admission_guard: Option<TurnInterruptAdmissionGuard>,
}
/// 在同一准入边界核验活动 Turn 和普通会话所有权。
#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnInterruptAdmissionGuard {
    pub ordinary_session: bool,
}

/// Resolve and admit only a profile without Workflow execution.
#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadStartAdmissionGuard {
    pub ordinary_session: bool,
}
/// Optional atomic ordinary-session admission; callers must request `true`.
#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnStartAdmissionGuard {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_turn_id: Option<String>,
    pub config_revision: u64,
    pub ordinary_session: bool,
}
/// 把一个 pending 排队项一次受理到指定活动轮次；不允许客户端拼接 remove/steer。
#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueSteer {
    pub request_id: String,
    pub thread_id: String,
    pub expected_revision: u64,
    pub queue_item_id: String,
    pub expected_turn_id: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigureThread {
    #[serde(default)]
    pub request_id: Option<String>,
    pub options: Option<ClientOptions>,
    pub thread_id: String,
    pub expected_revision: u64,
    pub agent_profile: Option<VersionRef>,
    pub model: Option<ModelRef>,
    /// 清除会话模型覆盖，重新采用 Profile 或服务端默认模型。
    #[serde(default)]
    pub reset_model: bool,
    pub parameters: Option<ModelParameters>,
    /// 会话允许使用的 Skill；省略时沿用当前选择，空数组表示清空覆盖。
    #[serde(default)]
    pub selected_skills: Option<Vec<VersionRef>>,
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
