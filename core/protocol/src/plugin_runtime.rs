//! Typed desktop MCP boundaries shared with generated schemas. Secrets remain trusted launch inputs.
use serde_json::Value;
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
pub struct GenUiSource {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub path: Option<String>,
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
pub struct Connector {
    pub request_id: String,
    pub id: String,
    pub connector_id: String,
    pub provider: String,
    pub credential_ref: String,
    pub expected_digest: String,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Apps {
    pub thread_id: Option<String>,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Open {
    pub thread_id: String,
    pub server_id: String,
    pub expected_generation: u64,
    pub tool_name: String,
    pub arguments: Option<Value>,
    pub request_id: String,
    pub file_resource: Option<Value>,
    pub deep_link: Option<String>,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenFromResult {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub request_id: String,
}

#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ResultUnavailable {
    NotSuccessful,
    MissingProvenance,
    CorruptSnapshot,
    StaleSourceEpoch,
    PackageChanged,
    SourceDisabled,
    SourceUnavailable,
    ResourceRejected,
    ResourceReadFailed,
    PageFailed,
    CapacityReached,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(tag = "status", rename_all = "camelCase", deny_unknown_fields)]
pub enum ResultOpenReply {
    Open { instance: Value },
    Closed,
    Unavailable { reason: ResultUnavailable },
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppRequest {
    pub thread_id: String,
    pub instance_id: String,
    pub generation: u64,
    pub request: Value,
    pub request_id: Option<String>,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Close {
    pub thread_id: String,
    pub instance_id: String,
    pub generation: u64,
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

pub const PAGE_BYTES: usize = 32 * 1024;
pub const PAGE_DOCUMENT_UNITS: u64 = 65_536;
pub const PAGE_TEXT_UNITS: usize = 4096;
pub const PAGE_MAX_REVISION: u64 = 9_007_199_254_740_990;

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
pub struct PageDeclaration {
    #[schemars(range(min = 1, max = 1))]
    pub version: u8,
    #[schemars(length(min = 1, max = 64))]
    pub document_id: String,
    #[schemars(length(min = 1, max = 2))]
    pub tools: Vec<PageToolKind>,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageRegister {
    pub thread_id: String,
    pub instance_id: String,
    pub generation: u64,
    pub owner_id: String,
    pub declaration: PageDeclaration,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageRevoke {
    pub thread_id: String,
    pub instance_id: String,
    pub generation: u64,
    pub registration_id: String,
    pub owner_id: String,
}
#[derive(
    Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageCoordinates {
    pub thread_id: String,
    pub turn_id: String,
    pub call_id: String,
    pub registration_id: String,
    pub owner_id: String,
    pub schema_digest: String,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageResolve {
    pub thread_id: String,
    pub turn_id: String,
    pub call_id: String,
    pub registration_id: String,
    pub owner_id: String,
    pub schema_digest: String,
    pub claim_id: Option<String>,
    pub reply: PageReply,
}
impl PageResolve {
    pub fn coordinates(&self) -> PageCoordinates {
        PageCoordinates {
            thread_id: self.thread_id.clone(),
            turn_id: self.turn_id.clone(),
            call_id: self.call_id.clone(),
            registration_id: self.registration_id.clone(),
            owner_id: self.owner_id.clone(),
            schema_digest: self.schema_digest.clone(),
        }
    }
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
impl PageExecution {
    pub fn is_terminal(&self) -> bool {
        matches!(self.dispatch, PageDispatch::Terminal { .. })
    }
}
#[derive(Clone, Debug)]
pub enum PageToolNotice {
    Pending(PageCoordinates),
    Cancelled {
        coordinates: PageCoordinates,
        claim_id: Option<String>,
    },
}
impl PageToolNotice {
    pub fn into_notification(self) -> Value {
        match self {
            Self::Pending(c) => crate::notification(
                "areal/mcp/app/tools/pending",
                serde_json::to_value(c).unwrap(),
            ),
            Self::Cancelled {
                coordinates,
                claim_id,
            } => {
                let params = PageCancelled {
                    thread_id: coordinates.thread_id,
                    turn_id: coordinates.turn_id,
                    call_id: coordinates.call_id,
                    registration_id: coordinates.registration_id,
                    owner_id: coordinates.owner_id,
                    schema_digest: coordinates.schema_digest,
                    claim_id,
                };
                crate::notification(
                    "areal/mcp/app/tools/cancelled",
                    serde_json::to_value(params).unwrap(),
                )
            }
        }
    }
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PagePatch {
    #[schemars(range(min = 0, max = 9_007_199_254_740_990u64))]
    pub expected_document_revision: u64,
    pub patch: PageReplacement,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageReplacement {
    #[schemars(range(min = 0, max = 65_536))]
    pub from: u64,
    #[schemars(range(min = 0, max = 65_536))]
    pub to: u64,
    #[schemars(length(max = 4096))]
    pub insert: String,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(tag = "status", rename_all = "camelCase", deny_unknown_fields)]
pub enum PageReply {
    Completed { result: PageResult },
    NoEffect { reason: PageNoEffect },
    Unknown,
}
#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PageNoEffect {
    Cancelled,
    Closed,
    Unavailable,
}
#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PageRejection {
    InvalidRange,
    DocumentTooLarge,
    NoChange,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PageResult {
    Selection {
        #[schemars(length(min = 1, max = 64))]
        document_id: String,
        #[schemars(range(min = 0, max = 9_007_199_254_740_991u64))]
        document_revision: u64,
        #[schemars(range(min = 0, max = 65_536))]
        anchor: u64,
        #[schemars(range(min = 0, max = 65_536))]
        head: u64,
        #[schemars(length(max = 4096))]
        selected_text: String,
        truncated: bool,
        dirty: bool,
    },
    Applied {
        #[schemars(length(min = 1, max = 64))]
        document_id: String,
        #[schemars(range(min = 0, max = 9_007_199_254_740_990u64))]
        previous_document_revision: u64,
        #[schemars(range(min = 0, max = 9_007_199_254_740_991u64))]
        document_revision: u64,
        #[schemars(range(min = 0, max = 65_536))]
        from: u64,
        #[schemars(range(min = 0, max = 65_536))]
        to: u64,
        #[schemars(range(min = 0, max = 4096))]
        inserted_length: u64,
        dirty: bool,
    },
    Conflict {
        #[schemars(length(min = 1, max = 64))]
        document_id: String,
        #[schemars(range(min = 0, max = 9_007_199_254_740_990u64))]
        expected_document_revision: u64,
        #[schemars(range(min = 0, max = 9_007_199_254_740_991u64))]
        document_revision: u64,
    },
    Rejected {
        #[schemars(length(min = 1, max = 64))]
        document_id: String,
        #[schemars(range(min = 0, max = 9_007_199_254_740_991u64))]
        document_revision: u64,
        reason: PageRejection,
    },
}
impl PageToolKind {
    pub fn suffix(self) -> &'static str {
        match self {
            Self::GetSelection => "get_selection",
            Self::ApplyPatch => "apply_patch",
        }
    }
    pub fn input_schema(self) -> Value {
        match self {
            Self::GetSelection => {
                serde_json::json!({"type":"object","properties":{},"additionalProperties":false})
            }
            Self::ApplyPatch => {
                serde_json::json!({"type":"object","required":["expectedDocumentRevision","patch"],"additionalProperties":false,"properties":{"expectedDocumentRevision":{"type":"integer","minimum":0,"maximum":PAGE_MAX_REVISION},"patch":{"type":"object","required":["from","to","insert"],"additionalProperties":false,"properties":{"from":{"type":"integer","minimum":0,"maximum":PAGE_DOCUMENT_UNITS},"to":{"type":"integer","minimum":0,"maximum":PAGE_DOCUMENT_UNITS},"insert":{"type":"string","maxLength":PAGE_TEXT_UNITS,"pattern":"^[^\\r]*$"}}}}})
            }
        }
    }
    pub fn output_schema(self) -> Value {
        let mut schema = serde_json::to_value(schemars::schema_for!(PageResult)).unwrap();
        schema["oneOf"].as_array_mut().unwrap().retain(|variant| {
            let selection = variant["properties"]["kind"]["const"] == "selection";
            selection == (self == Self::GetSelection)
        });
        schema
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageRegisterReply {
    pub registration_id: String,
    pub document_id: String,
    pub tools: Vec<PageToolDefinition>,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageToolDefinition {
    pub kind: PageToolKind,
    pub name: String,
    pub schema_digest: String,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PageClaimReply {
    Granted {
        claim_id: String,
        kind: PageToolKind,
        document_id: String,
        arguments: Value,
    },
    NotGranted {
        reason: PageClaimDenial,
    },
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PageClaimDenial {
    AlreadyClaimed,
    Unavailable,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(tag = "status", rename_all = "camelCase", deny_unknown_fields)]
pub enum PageAccepted {
    Accepted,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageRevoked {
    pub revoked: bool,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageCancelled {
    pub thread_id: String,
    pub turn_id: String,
    pub call_id: String,
    pub registration_id: String,
    pub owner_id: String,
    pub schema_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim_id: Option<String>,
}
