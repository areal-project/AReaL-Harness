//! Typed desktop MCP boundaries shared with generated schemas. Secrets remain trusted launch inputs.
use serde_json::Value;

/// 以下管理方法对完整原始参数计算回执摘要，包括 requestId。
pub const FULL_MANAGEMENT_RECEIPT_PARAMS: &[&str] = &[
    "areal/plugin/userConfig/set",
    "areal/plugin/development/link",
    "areal/plugin/development/unlink",
    "areal/plugin/hooks/configure",
    "areal/hook/acknowledge",
    "areal/plugin/connection",
    "areal/plugin/auth/configure",
    "areal/mcp/form/resource/stage",
];

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Empty {}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolResult {
    pub thread_id: String,
    pub call_id: String,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Connection {
    pub request_id: String,
    pub id: String,
    pub expected_digest: String,
    pub connect: bool,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Auth {
    pub id: String,
    pub server: String,
    pub operation: String,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// 把 Host vault 里刚保存的凭据交给运行中的 Core，按引用使用，无需重启。
pub struct CredentialsRegister {
    pub credentials: std::collections::BTreeMap<String, String>,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Extension {
    pub thread_id: String,
    pub server_id: String,
    pub expected_generation: u64,
    pub kind: String,
    pub arguments: Value,
    pub request_id: String,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Forms {
    pub thread_id: String,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Respond {
    pub thread_id: String,
    pub request_id: String,
    pub response: Value,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preview {
    pub thread_id: String,
    pub request_id: String,
    pub target: Value,
}

/// References supplied by the trusted host; secret values never enter RPCs.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostAuthReferences {
    pub client_secret_ref: Option<String>,
    pub private_key_ref: Option<String>,
    pub private_key_id: Option<String>,
    pub client_metadata_url: Option<String>,
    pub api_key_ref: Option<String>,
    pub callback_url: Option<String>,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthConfigure {
    pub request_id: String,
    pub id: String,
    pub server: String,
    pub expected_digest: String,
    pub configuration: HostAuthReferences,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FormResourcePrepare {
    pub thread_id: String,
    pub request_id: String,
    pub field_name: String,
}
/// Private native-picker data. No renderer command accepts this DTO.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FormResourceStage {
    pub selection_token: String,
    pub request_id: String,
    pub paths: Vec<std::path::PathBuf>,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FormResourceRelease {
    pub thread_id: String,
    pub request_id: String,
    pub field_name: String,
    pub uri: String,
}

/// Explicit review of the current package and effective hooks, independently of MCP trust.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HooksConfigure {
    pub request_id: String,
    pub id: String,
    pub expected_digest: String,
    pub definition_digest: String,
    pub enabled: bool,
    pub trusted: bool,
    /// Separate consent for isolated command hooks in ordinary read-only child Sessions.
    #[serde(default)]
    pub allow_read_only_commands: bool,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HookAcknowledge {
    pub request_id: String,
    pub thread_id: String,
    pub invocation_id: String,
    pub inspection: String,
}

// 仅保留历史 ToolExecution 的页面字段；当前运行时不登记或执行页面工具。
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    serde::Serialize,
    serde::Deserialize,
    schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum PageToolKind {
    GetSelection,
    ApplyPatch,
}

#[derive(
    Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageBinding {
    pub thread_id: String,
    pub cwd: String,
    pub instance_id: String,
    pub apps_epoch: String,
    pub generation: u64,
    pub plugin_id: String,
    pub plugin_digest: String,
    pub registration_id: String,
    pub tool_host_id: String,
    pub owner_id: String,
    pub document_id: String,
    pub kind: PageToolKind,
    pub schema_digest: String,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageExecution {
    pub binding: PageBinding,
    pub dispatch: PageDispatch,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PageDispatch {
    Pending {
        arguments_digest: Option<String>,
    },
    Claimed {
        arguments_digest: String,
        claim_id: String,
    },
    Terminal {
        arguments_digest: Option<String>,
        claim_id: Option<String>,
        reply_digest: String,
    },
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComponentRead {
    pub id: String,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum UserConfigValue {
    String(String),
    Boolean(bool),
    Number(serde_json::Number),
    SecretRef(String),
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserConfigSet {
    pub request_id: String,
    pub id: String,
    pub expected_revision: u64,
    pub expected_digest: String,
    pub values: std::collections::BTreeMap<String, UserConfigValue>,
    #[serde(default)]
    pub clear_keys: Vec<String>,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DevelopmentLink {
    pub request_id: String,
    pub id: String,
    pub expected_revision: u64,
    pub expected_digest: String,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DevelopmentUnlink {
    pub request_id: String,
    pub id: String,
    pub expected_revision: u64,
}
