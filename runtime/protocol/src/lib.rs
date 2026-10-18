//! Core/SDK 与 Runtime 的公开契约；不暴露执行后端的私有协议。
use serde::{Deserialize, Serialize};
use serde_json::Value;
mod filesystem;
pub use filesystem::*;

pub const VERSION: &str = "areal.runtime.v0";
pub const MAX_FRAME_BYTES: usize = 128 * 1024;
pub const MAX_READ_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InvalidRequest,
    InvalidArgument,
    Unauthenticated,
    PermissionDenied,
    ScopeClosed,
    StaleHandle,
    NotFound,
    Conflict,
    ResourceExhausted,
    Unsupported,
    Unavailable,
    CleanupFailed,
}

#[derive(
    Clone, Debug, PartialEq, Eq, Serialize, Deserialize, thiserror::Error, schemars::JsonSchema,
)]
#[error("{code:?}: {message}")]
pub struct Error {
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}
impl Error {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
        }
    }
}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ScopeState {
    Active,
    Revoking,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum OperationState {
    Accepted,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ProcessState {
    Starting,
    Running,
    Exited,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum OutputStream {
    Stdout,
    Stderr,
    Pty,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Limits {
    /// 单进程墙钟时间上限，包括执行后端启动时间。
    pub wall_time_ms: u64,
    /// Scope 及后代的累计输出预算；进程上使用时为该进程预算。
    pub output_bytes: u64,
    /// Scope 及后代的并发进程数，包括启动中和清理中的进程。
    pub max_processes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            wall_time_ms: 30_000,
            output_bytes: 8 * 1024 * 1024,
            max_processes: 4,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LimitRequest {
    pub wall_time_ms: Option<u64>,
    pub output_bytes: Option<u64>,
    pub max_processes: Option<usize>,
}

#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "lowercase")]
pub enum NetworkRequest {
    Deny,
    #[default]
    Inherit,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionRequest {
    pub read_roots: Option<Vec<String>>,
    pub write_roots: Option<Vec<String>>,
    #[serde(default)]
    pub network: NetworkRequest,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Owner {
    pub task_id: String,
    #[serde(default)]
    pub plugin_instance_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateScope {
    pub operation_id: String,
    pub parent_scope_id: String,
    pub owner: Owner,
    #[serde(default)]
    pub permissions: PermissionRequest,
    #[serde(default)]
    pub limits: LimitRequest,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevokeOwner {
    pub plugin_instance_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OwnerRevocation {
    pub plugin_instance_id: String,
    pub scope_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartProcess {
    pub operation_id: String,
    pub scope_id: String,
    pub argv: Vec<String>,
    pub cwd: String,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub tty: bool,
    #[serde(default)]
    pub pipe_stdin: bool,
    #[serde(default)]
    pub limits: LimitRequest,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessInput {
    pub operation_id: String,
    pub process_id: String,
    pub data_base64: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResizeProcess {
    pub operation_id: String,
    pub process_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloseStdin {
    pub operation_id: String,
    pub process_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScopeInfo {
    pub scope_id: String,
    pub parent_scope_id: Option<String>,
    pub state: ScopeState,
    pub owner: Owner,
    pub read_roots: Vec<String>,
    pub write_roots: Vec<String>,
    pub network: NetworkRequest,
    pub limits: Limits,
    pub active_processes: usize,
    pub output_bytes: u64,
    pub cleanup_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProcessRef {
    pub process_id: String,
    pub scope_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub process_id: String,
    pub scope_id: String,
    pub state: ProcessState,
    pub exit_code: Option<i32>,
    /// POSIX 信号编号的十进制字符串；正常退出时为 null。
    pub signal: Option<String>,
    pub sandbox_denied: bool,
    pub stop_reason: Option<String>,
    pub cleanup_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadOutput {
    pub process_id: String,
    pub after: Option<String>,
    pub max_bytes: usize,
    #[serde(default)]
    pub wait_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OutputChunk {
    pub cursor: String,
    pub stream: OutputStream,
    pub data_base64: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OutputPage {
    pub chunks: Vec<OutputChunk>,
    pub next_cursor: String,
    pub gap: bool,
    /// 输出预算或传输故障导致流不完整，与保留窗口 gap 分开。
    pub truncated: bool,
    /// 不再产生输出且本页已经读到已保留输出的末尾。
    pub closed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OperationInfo {
    pub operation_id: String,
    pub state: OperationState,
    pub result: Option<Value>,
    pub error: Option<Error>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub protocol_version: String,
    pub runtime_epoch: String,
    pub connection_id: String,
    pub root_scope_id: String,
    pub capabilities: Value,
}
