//! User configuration. All process context is supplied by the caller.
mod file;
mod resolve;
pub mod skills;

use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, ffi::OsString, fmt, net::SocketAddr, path::PathBuf};

pub use resolve::{load_config, load_management_config};

/// 可信工具宿主继承连接所需的代理变量；不借此透传模型凭据或其他宿主环境。
pub const PROXY_ENV_VARS: [&str; 8] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
];

/// Contains secrets: deliberately does not implement Debug or Serialize.
#[derive(Clone, Default)]
pub struct ConfigInputs {
    pub cwd: PathBuf,
    pub homedir: Option<PathBuf>,
    pub env: BTreeMap<OsString, OsString>,
    pub config_file: Option<PathBuf>,
    pub overrides: ConfigOverrides,
}

/// Only explicit CLI values belong here. Text is validated without echoing it.
#[derive(Clone, Default)]
pub struct ConfigOverrides {
    pub permissions: Option<String>,
    pub listen: Option<String>,
    pub data_dir: Option<PathBuf>,
    pub model: Option<String>,
    pub model_provider: Option<String>,
    pub model_endpoint: Option<String>,
    pub model_protocol: Option<String>,
    pub api_key_env: Option<String>,
    pub model_concurrency: Option<String>,
    pub max_threads: Option<String>,
    pub max_active_turns: Option<String>,
    pub max_children_per_turn: Option<String>,
    pub max_agent_depth: Option<String>,
    pub log_filter: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum PermissionMode {
    #[default]
    #[serde(rename = "YOLO", alias = "yolo")]
    Yolo,
    #[serde(rename = "ASK_PERMISSIONS", alias = "ask_permissions")]
    AskPermissions,
}

impl PermissionMode {
    pub const fn requires_approval(self) -> bool {
        matches!(self, Self::AskPermissions)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PermissionConfig {
    pub mode: PermissionMode,
    #[serde(default)]
    pub allow: Vec<String>,
    #[serde(default)]
    pub ask: Vec<String>,
    #[serde(default)]
    pub deny: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConfigSource {
    Default,
    File {
        path: PathBuf,
        line: usize,
        column: usize,
    },
    Env {
        name: String,
    },
    Cli {
        flag: String,
    },
}

impl fmt::Display for ConfigSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Default => write!(f, "default"),
            Self::File { path, line, column } => write!(f, "{}:{line}:{column}", path.display()),
            Self::Env { name } => write!(f, "env {name}"),
            Self::Cli { flag } => write!(f, "CLI {flag}"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigErrorKind {
    Io,
    Parse,
    UnknownField,
    UnsupportedVersion,
    InvalidValue,
    MissingValue,
    Conflict,
}

#[derive(Debug)]
pub struct ConfigError {
    pub kind: ConfigErrorKind,
    pub field: String,
    pub source: ConfigSource,
    pub message: &'static str,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{:?}: {} ({}): {}",
            self.kind, self.field, self.source, self.message
        )
    }
}
impl std::error::Error for ConfigError {}
pub type Result<T> = std::result::Result<T, ConfigError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelProtocolConfig {
    ChatCompletions,
    Responses,
}

// Raw endpoint/filter values may contain private query data: use diagnostic().
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SelectedModelConfig {
    pub provider: String,
    pub name: String,
    pub endpoint: String,
    pub protocol: ModelProtocolConfig,
    pub api_key_env: Option<String>,
    pub reasoning_effort: Option<String>,
    pub reasoning_summary: Option<String>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub top_k: Option<i64>,
    pub min_p: Option<f64>,
    pub presence_penalty: Option<f64>,
    pub repetition_penalty: Option<f64>,
    pub max_output_tokens: Option<u64>,
    pub max_retries: usize,
}

impl SelectedModelConfig {
    /// 只比较配置和凭据引用；密钥值不进入登记或历史。
    pub fn fingerprint(&self) -> String {
        use sha2::{Digest, Sha256};
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(self).expect("model config"))
        )
    }

    pub fn credential(&self, inputs: &ConfigInputs) -> Result<Option<String>> {
        self.api_key_env
            .as_ref()
            .map(|name| {
                inputs
                    .env
                    .get(std::ffi::OsStr::new(name))
                    .and_then(|v| v.to_str())
                    .filter(|v| {
                        !v.trim().is_empty() && v.bytes().all(|b| (0x20..=0x7e).contains(&b))
                    })
                    .map(str::to_owned)
                    .ok_or_else(|| ConfigError {
                        kind: ConfigErrorKind::MissingValue,
                        field: format!("model.providers.{}.api_key_env", self.provider),
                        source: ConfigSource::Env { name: name.clone() },
                        message: "credential must be set to a nonempty HTTP header value",
                    })
            })
            .transpose()
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct GoalConfig {
    pub max_turns: u64,
    pub max_active_seconds: u64,
    pub max_unreported_turns: u64,
    pub turn_model_rounds: usize,
}

pub struct ResolvedCoreConfig {
    pub permissions: PermissionConfig,
    pub goals: GoalConfig,
    pub home: PathBuf,
    pub config_file: Option<PathBuf>,
    pub listen: SocketAddr,
    pub data_dir: PathBuf,
    pub tool_extensions_file: Option<PathBuf>,
    pub model: SelectedModelConfig,
    pub model_concurrency: usize,
    pub max_threads: usize,
    pub max_active_turns: usize,
    pub max_children_per_turn: usize,
    pub max_agent_depth: usize,
    pub turn_timeout_seconds: u64,
    pub stream_idle_timeout_seconds: u64,
    pub max_history_bytes: usize,
    pub max_output_bytes: usize,
    pub max_tool_calls: usize,
    pub max_tool_buffer_bytes: usize,
    pub context_window_bytes: usize,
    pub context_compaction_enabled: bool,
    pub context_window_tokens: usize,
    pub context_output_reserve_tokens: usize,
    pub context_recent_bytes: usize,
    pub max_completion_retries: usize,
    pub watchdog_disable: bool,
    pub log_filter: String,
    pub sources: BTreeMap<String, ConfigSource>,
    pub warnings: Vec<String>,
}

impl ResolvedCoreConfig {
    /// Resolve the credential separately, from the same environment snapshot.
    pub fn credential(&self, inputs: &ConfigInputs) -> Result<Option<String>> {
        self.model.credential(inputs)
    }

    /// Redacted, stable JSON shared by local diagnostics and the launcher.
    pub fn diagnostic(&self, sources: bool) -> serde_json::Value {
        // 管理模式允许尚未配置模型，此时没有可解析的 endpoint。
        let endpoint = if self.model.endpoint.is_empty() {
            String::new()
        } else {
            let mut endpoint = url::Url::parse(&self.model.endpoint).expect("validated endpoint");
            endpoint.set_query(None);
            endpoint.set_fragment(None);
            endpoint.to_string()
        };
        let mut result = serde_json::json!({
            "permissions": self.permissions,
            "goals": self.goals,
            "home": self.home, "config_file": self.config_file,
            "server": { "listen": self.listen, "data_dir": self.data_dir },
            "tools": { "extensions_file": self.tool_extensions_file },
            "model": { "provider": self.model.provider, "name": self.model.name,
                "endpoint": endpoint.as_str(), "protocol": self.model.protocol,
                "api_key_env": self.model.api_key_env, "reasoning_effort": self.model.reasoning_effort,
                "reasoning_summary": self.model.reasoning_summary,
                "temperature": self.model.temperature,
                "top_p": self.model.top_p,
                "top_k": self.model.top_k,
                "min_p": self.model.min_p,
                "presence_penalty": self.model.presence_penalty,
                "repetition_penalty": self.model.repetition_penalty,
                "max_output_tokens": self.model.max_output_tokens, "max_retries": self.model.max_retries },
            "limits": { "max_active_turns": self.max_active_turns, "max_children_per_turn": self.max_children_per_turn, "max_agent_depth": self.max_agent_depth, "model_concurrency": self.model_concurrency, "max_threads": self.max_threads,
                "turn_timeout_seconds": self.turn_timeout_seconds, "stream_idle_timeout_seconds": self.stream_idle_timeout_seconds,
                "max_history_bytes": self.max_history_bytes, "max_output_bytes": self.max_output_bytes, "max_tool_calls": self.max_tool_calls, "max_tool_buffer_bytes": self.max_tool_buffer_bytes,
                "context_window_bytes": self.context_window_bytes, "context_compaction_enabled": self.context_compaction_enabled, "context_window_tokens":self.context_window_tokens, "context_output_reserve_tokens":self.context_output_reserve_tokens, "context_recent_bytes": self.context_recent_bytes,
                "max_completion_retries": self.max_completion_retries, "watchdog_disable": self.watchdog_disable },
            "logging": { "filter": self.log_filter },
        });
        if sources {
            result["sources"] = serde_json::json!(self.sources);
        }
        result
    }
}

pub(crate) fn error(
    kind: ConfigErrorKind,
    field: &str,
    source: &ConfigSource,
    message: &'static str,
) -> ConfigError {
    ConfigError {
        kind,
        field: field.into(),
        source: source.clone(),
        message,
    }
}
