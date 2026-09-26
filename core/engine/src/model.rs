mod decoder;
use decoder::{ChatDecoder, Decoder, ResponsesDecoder};

mod audit;
mod tool_calls;
use anyhow::{Context, Result, bail};
use areal_protocol::{ImageDetail, Modality, ModelUsage};
use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::VecDeque, pin::Pin, time::Duration};
pub(crate) use tool_calls::tool_index;
pub use tool_calls::{MAX_TOOL_ARGUMENT_BYTES, ToolCallLimits};
pub(crate) use tool_calls::{
    ToolCallBudget, ToolCallBudgetError, ToolCallIndexError, tool_error_detail,
};

const MAX_SSE_BYTES: usize = 24 * 1024 * 1024;
const MAX_LOCAL_MEDIA_BYTES: usize = 16 * 1024 * 1024;

pub type ModelStream = Pin<Box<dyn Stream<Item = Result<ModelEvent>> + Send>>;
pub type AgentStream = ModelStream;

/// Request policy belongs to Core; summaries never enable tool interpretation.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RequestPurpose {
    #[default]
    Solve,
    Summary,
}

/// Failures of inference, before any tool calls from that response are executed.
/// This classification never establishes that earlier tool operations settled.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Serialize,
    Deserialize,
    thiserror::Error,
    schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum ModelFailure {
    #[error("model stream transport failed")]
    Transport,
    #[error("model response timeout")]
    ResponseTimeout,
    #[error("model HTTP status 429 Too Many Requests")]
    RateLimited,
    #[error("model service temporarily unavailable")]
    Unavailable,
    #[error("model stopped with reason: length")]
    Truncated,
    #[error("model stream ended without a finish reason")]
    Incomplete,
    #[error("model stopped without visible output or tool calls")]
    EmptyCompletion,
    #[error("verification process has not been observed to finish")]
    PendingVerification,
}

/// Bounded protocol metadata only. Provider messages and response bodies may
/// contain prompts or credentials and are never copied into this diagnostic.
#[derive(Debug, Serialize, thiserror::Error)]
#[error(
    "model reported a streaming error (event={event_type}, code={code:?}, type={error_type:?}, reason={reason:?})"
)]
#[serde(rename_all = "camelCase")]
struct StreamError {
    event_type: &'static str,
    code: Option<String>,
    error_type: Option<String>,
    reason: Option<String>,
    error_shape: &'static str,
}
impl StreamError {
    fn from_value(value: &Value, event_type: &'static str) -> Self {
        fn label(value: &Value) -> Option<String> {
            // 只接受已知协议类别，避免看似标识符的凭据进入错误与审计。
            match value.as_str()? {
                name @ ("rate_limit_exceeded"
                | "rate_limit_error"
                | "insufficient_quota"
                | "context_length_exceeded"
                | "invalid_request_error"
                | "invalid_api_key"
                | "authentication_error"
                | "permission_error"
                | "not_found_error"
                | "model_not_found"
                | "server_error"
                | "api_error"
                | "overloaded_error"
                | "content_policy_violation"
                | "content_filter"
                | "max_tokens"
                | "max_output_tokens"
                | "invalid_messages"
                | "validation_error") => Some(name.to_owned()),
                _ => None,
            }
        }
        Self {
            event_type,
            code: label(&value["code"]),
            error_type: label(&value["type"]),
            reason: label(&value["reason"]),
            error_shape: match value {
                Value::Object(_) => "object",
                Value::String(_) => "string",
                _ => "other",
            },
        }
    }
}

// 非成功 HTTP 响应仅保留状态与白名单协议字段，限制读取量和耗时。
#[derive(Debug, thiserror::Error)]
#[error("model HTTP status {status}")]
struct HttpFailure {
    status: reqwest::StatusCode,
    detail: Option<StreamError>,
}
async fn http_failure(mut response: reqwest::Response) -> anyhow::Error {
    let status = response.status();
    match status {
        reqwest::StatusCode::REQUEST_TIMEOUT => return ModelFailure::ResponseTimeout.into(),
        reqwest::StatusCode::TOO_MANY_REQUESTS => return ModelFailure::RateLimited.into(),
        status if status.is_server_error() => return ModelFailure::Unavailable.into(),
        _ => {}
    }
    let detail = tokio::time::timeout(Duration::from_secs(2), async {
        let mut bytes = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) if bytes.len() + chunk.len() <= 64 * 1024 => {
                    bytes.extend_from_slice(&chunk)
                }
                Ok(None) => break,
                _ => return None,
            }
        }
        let value: Value = serde_json::from_slice(&bytes).ok()?;
        Some(StreamError::from_value(
            value.get("error").unwrap_or(&value),
            "http_error",
        ))
    })
    .await
    .ok()
    .flatten();
    HttpFailure { status, detail }.into()
}

fn stream_outcome(detail: &StreamError, source: &str) -> areal_protocol::TurnOutcome {
    let labels = [&detail.code, &detail.error_type, &detail.reason];
    let has = |name: &str| labels.iter().any(|v| v.as_deref() == Some(name));
    let (code, class) = if has("context_length_exceeded") {
        ("LLM_CONTEXT_WINDOW_EXCEEDED", "agent")
    } else if has("max_tokens") || has("max_output_tokens") {
        ("LLM_OUTPUT_TOKEN_LIMIT_EXCEEDED", "agent")
    } else {
        ("LLM_RESPONSE_FAILED", "infrastructure")
    };
    crate::outcome::outcome(code, class, source, json!(detail))
}

pub(crate) fn terminal_outcome(error: &anyhow::Error) -> Option<areal_protocol::TurnOutcome> {
    use crate::outcome::outcome;
    if let Some(detail) = error.downcast_ref::<HttpFailure>() {
        // 413 是 HTTP 请求体限制，不用其中的泛化错误标签覆盖状态码事实。
        let mut result = if detail.status == 413 {
            outcome(
                "LLM_RESPONSE_FAILED",
                "infrastructure",
                "provider_http",
                json!({"reason":"request_body_too_large"}),
            )
        } else if let Some(provider) = &detail.detail {
            stream_outcome(provider, "provider_http")
        } else {
            outcome(
                "LLM_RESPONSE_FAILED",
                "infrastructure",
                "provider_http",
                json!({"reason":"http_error"}),
            )
        };
        result.details.as_mut().unwrap()["httpStatus"] = json!(detail.status.as_u16());
        return Some(result);
    }
    if let Some(detail) = error.downcast_ref::<StreamError>() {
        return Some(stream_outcome(detail, "provider_stream"));
    }
    if let Some(detail) = tool_error_detail(error) {
        let class = if error.downcast_ref::<ToolCallBudgetError>().is_some() {
            "agent"
        } else {
            "infrastructure"
        };
        return Some(outcome(
            "LLM_RESPONSE_FAILED",
            class,
            "core_tool_decoder",
            detail,
        ));
    }
    let failure = error.downcast_ref::<ModelFailure>()?;
    let (code, class, reason) = match failure {
        ModelFailure::Truncated => (
            "LLM_OUTPUT_TOKEN_LIMIT_EXCEEDED",
            "agent",
            "provider_length_stop",
        ),
        ModelFailure::ResponseTimeout => ("LLM_RESPONSE_TIMEOUT", "timeout", "response_timeout"),
        ModelFailure::EmptyCompletion => ("LLM_RESPONSE_FAILED", "agent", "empty_completion"),
        ModelFailure::PendingVerification => {
            ("LLM_RESPONSE_FAILED", "agent", "pending_verification")
        }
        ModelFailure::Transport => ("LLM_RESPONSE_FAILED", "infrastructure", "transport"),
        ModelFailure::RateLimited => ("LLM_RESPONSE_FAILED", "infrastructure", "rate_limited"),
        ModelFailure::Unavailable => ("LLM_RESPONSE_FAILED", "infrastructure", "unavailable"),
        ModelFailure::Incomplete => ("LLM_RESPONSE_FAILED", "infrastructure", "incomplete_stream"),
    };
    Some(outcome(code, class, "core_model", json!({"reason":reason})))
}

pub(crate) fn is_network_error(error: &anyhow::Error) -> bool {
    if let Some(failure) = error.downcast_ref::<ModelFailure>() {
        return matches!(
            failure,
            ModelFailure::Transport
                | ModelFailure::ResponseTimeout
                | ModelFailure::RateLimited
                | ModelFailure::Unavailable
                | ModelFailure::Incomplete
        );
    }
    if let Some(detail) = error.downcast_ref::<StreamError>() {
        let labels: Vec<_> = [&detail.code, &detail.error_type, &detail.reason]
            .into_iter()
            .flatten()
            .map(String::as_str)
            .collect();
        // 额度、鉴权、参数和长度错误优先于笼统的 server_error，避免永久错误无限循环。
        let transient = |label: &&str| {
            matches!(
                *label,
                "rate_limit_exceeded"
                    | "rate_limit_error"
                    | "server_error"
                    | "api_error"
                    | "overloaded_error"
            )
        };
        return !labels.is_empty() && labels.iter().all(transient);
    }
    false
}

// 请求归属用于审计；Goal 标记另约束计量范围内的 HTTP 重试。
tokio::task_local! {
    pub(crate) static REQUEST_OWNER: (String, String);
    // 已计量请求不能在传输内部隐式重试，否则单次预留无法覆盖未知消费。
    pub(crate) static GOAL_REQUEST: ();
}

/// Local admission measurements, not provider/GPU utilization or RPM/TPM.
/// Durations are cumulative, monotonic, and include the current open interval.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelLoad {
    pub capacity: usize,
    pub in_flight: usize,
    pub waiting: usize,
    pub started_requests: u64,
    pub completed_requests: u64,
    pub elapsed_seconds: f64,
    /// Wall time with at least one caller waiting for a local model permit.
    pub queued_seconds: f64,
    /// Sum of time holding request permits, including HTTP/stream waits.
    pub occupied_slot_seconds: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ContentPart {
    Text(String),
    Image {
        source: MediaSource,
        detail: Option<ImageDetail>,
    },
    Audio {
        source: MediaSource,
    },
    File {
        source: MediaSource,
        name: Option<String>,
        mime_type: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub enum MediaSource {
    Url(String),
    LocalPath(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Message {
    pub role: String,
    pub content: Vec<ContentPart>,
    pub tool_calls: Vec<Value>,
    pub tool_call_id: Option<String>,
    /// Opaque provider context (e.g. encrypted Responses reasoning), not user text.
    pub provider_context: Option<Value>,
}

impl Message {
    pub fn text(role: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            role: role.into(),
            content: vec![ContentPart::Text(text.into())],
            tool_calls: Vec::new(),
            tool_call_id: None,
            provider_context: None,
        }
    }

    pub fn text_content(&self) -> String {
        self.content
            .iter()
            .filter_map(|part| match part {
                ContentPart::Text(text) => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum ModelEvent {
    /// Bytes arrived even when no complete semantic item is available yet.
    Activity,
    ProviderContext(Value),
    TextDelta(String),
    /// 供应商显式返回的思考增量，不是可见正文或不透明上下文。
    ReasoningDelta {
        item_id: String,
        kind: ReasoningKind,
        index: usize,
        delta: String,
    },
    ToolCall(ToolCall),
    Binary {
        modality: Modality,
        mime_type: String,
        data: Vec<u8>,
    },
    Usage(ModelUsage),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ReasoningKind {
    Summary,
    Text,
}

impl ModelEvent {
    pub fn reasoning(text: impl Into<String>) -> Self {
        Self::ReasoningDelta {
            item_id: "chat".into(),
            kind: ReasoningKind::Text,
            index: 0,
            delta: text.into(),
        }
    }
    pub fn text(text: impl Into<String>) -> Self {
        Self::TextDelta(text.into())
    }
}

impl From<String> for ModelEvent {
    fn from(value: String) -> Self {
        Self::TextDelta(value)
    }
}

impl From<&str> for ModelEvent {
    fn from(value: &str) -> Self {
        Self::TextDelta(value.to_owned())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelCapabilities {
    pub input: Vec<Modality>,
    pub output: Vec<Modality>,
}

impl ModelCapabilities {
    pub fn text() -> Self {
        Self {
            input: vec![Modality::Text],
            output: vec![Modality::Text],
        }
    }

    pub fn supports_input(&self, modality: Modality) -> bool {
        self.input.contains(&modality)
    }
}

#[async_trait]
pub trait Model: Send + Sync {
    /// 传播目标计量，不扩大模型并发池或工具权限。
    fn share_context(&self, inner: std::sync::Arc<dyn Model>) -> std::sync::Arc<dyn Model> {
        inner
    }
    fn check_work(&self) -> Result<()> {
        Ok(())
    }
    fn goal_id(&self) -> Option<&str> {
        None
    }
    /// 自定义适配器必须显式支持逐请求输出限制，不能静默忽略预算。
    async fn chat_limited(
        &self,
        messages: Vec<Message>,
        tools: Vec<Value>,
        purpose: RequestPurpose,
        cap: Option<u64>,
    ) -> Result<ModelStream> {
        anyhow::ensure!(
            cap.is_none(),
            "model adapter does not support goal output limits"
        );
        self.chat_for(messages, tools, purpose).await
    }
    /// 参数变化必须重建不可变请求配置，不能悄悄忽略。
    fn configure(
        &self,
        _parameters: &areal_protocol::desktop::ModelParameters,
    ) -> Result<std::sync::Arc<dyn Model>> {
        bail!("model adapter does not support per-Thread parameters")
    }
    /// 所有 Provider 和 Worker 复用同一部署并发池。
    fn share_capacity(&self, inner: std::sync::Arc<dyn Model>) -> std::sync::Arc<dyn Model> {
        inner
    }
    fn name(&self) -> &str;
    fn load(&self) -> Option<ModelLoad> {
        None
    }
    fn provider(&self) -> &str {
        "configured"
    }
    fn capabilities(&self) -> ModelCapabilities {
        ModelCapabilities::text()
    }
    async fn stream(&self, messages: Vec<Message>) -> Result<ModelStream>;
    async fn chat(
        &self,
        messages: Vec<Message>,
        _tools: Vec<serde_json::Value>,
    ) -> Result<AgentStream> {
        self.stream(messages).await
    }
    async fn chat_for(
        &self,
        messages: Vec<Message>,
        tools: Vec<Value>,
        _purpose: RequestPurpose,
    ) -> Result<AgentStream> {
        self.chat(messages, tools).await
    }
    /// 默认兼容自定义模型；内置适配器与包装器必须转发并在缓冲时执行预算。
    async fn chat_with_limits(
        &self,
        messages: Vec<Message>,
        tools: Vec<Value>,
        purpose: RequestPurpose,
        _limits: ToolCallLimits,
        cap: Option<u64>,
    ) -> Result<AgentStream> {
        self.chat_limited(messages, tools, purpose, cap).await
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelProtocol {
    ChatCompletions,
    Responses,
}

impl ModelProtocol {
    pub fn capabilities(self) -> ModelCapabilities {
        match self {
            ModelProtocol::ChatCompletions => ModelCapabilities {
                input: vec![Modality::Text, Modality::Image, Modality::Audio],
                output: vec![Modality::Text],
            },
            ModelProtocol::Responses => ModelCapabilities {
                input: vec![
                    Modality::Text,
                    Modality::Image,
                    Modality::Audio,
                    Modality::File,
                ],
                output: vec![Modality::Text, Modality::Image, Modality::Audio],
            },
        }
    }
}

#[derive(Clone)]
pub struct HttpModel {
    client: reqwest::Client,
    endpoint: String,
    name: String,
    key: Option<String>,
    protocol: ModelProtocol,
    options: ModelOptions,
    audit_directory: Option<std::path::PathBuf>,
    temperature: Option<f64>,
}

#[derive(Clone, Debug)]
pub struct ModelOptions {
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

impl Default for ModelOptions {
    fn default() -> Self {
        Self {
            reasoning_effort: None,
            reasoning_summary: None,
            temperature: None,
            top_p: None,
            top_k: None,
            min_p: None,
            presence_penalty: None,
            repetition_penalty: None,
            max_output_tokens: None,
            max_retries: 2,
        }
    }
}

pub type ChatModel = HttpModel;

impl HttpModel {
    pub fn new(endpoint: String, name: String, key: Option<String>) -> Result<Self> {
        Self::with_protocol(endpoint, name, key, ModelProtocol::ChatCompletions)
    }

    pub fn with_protocol(
        endpoint: String,
        name: String,
        key: Option<String>,
        protocol: ModelProtocol,
    ) -> Result<Self> {
        let url = reqwest::Url::parse(&endpoint).context("invalid model endpoint")?;
        if !matches!(url.scheme(), "http" | "https")
            || name.trim().is_empty()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            bail!("model endpoint must be HTTP(S) and model name must not be empty");
        }
        Ok(Self {
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            endpoint,
            name,
            key,
            protocol,
            options: ModelOptions::default(),
            audit_directory: None,
            temperature: None,
        })
    }

    /// The trusted host selects the audit directory. No headers, URLs or prompts
    /// are recorded; request parameters, hashes and completion facts only.
    pub fn with_audit_directory(mut self, directory: std::path::PathBuf) -> Self {
        self.audit_directory = Some(directory);
        self
    }

    pub fn with_options(mut self, options: ModelOptions) -> Result<Self> {
        anyhow::ensure!(options.max_retries <= 8, "model retries must be at most 8");
        anyhow::ensure!(
            options.max_output_tokens != Some(0),
            "output token limit must be positive"
        );
        anyhow::ensure!(
            options.reasoning_effort.as_deref().is_none_or(|v| matches!(
                v,
                "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
            )),
            "invalid reasoning effort"
        );
        anyhow::ensure!(
            options
                .temperature
                .is_none_or(|v| v.is_finite() && (0.0..=2.0).contains(&v)),
            "temperature must be between 0 and 2"
        );
        for (name, value, low, high) in [
            ("top_p", options.top_p, 0.0, 1.0),
            ("min_p", options.min_p, 0.0, 1.0),
            ("presence_penalty", options.presence_penalty, -2.0, 2.0),
        ] {
            anyhow::ensure!(
                value.is_none_or(|v| v.is_finite() && (low..=high).contains(&v)),
                "{name} must be finite and between {low} and {high}"
            );
        }
        anyhow::ensure!(
            options.top_k.is_none_or(|v| v == -1 || v > 0),
            "top_k must be -1 (disabled) or a positive integer"
        );
        anyhow::ensure!(
            options
                .repetition_penalty
                .is_none_or(|v| v.is_finite() && v > 0.0),
            "repetition_penalty must be finite and positive"
        );
        anyhow::ensure!(
            self.protocol != ModelProtocol::Responses
                || (options.top_k.is_none()
                    && options.min_p.is_none()
                    && options.presence_penalty.is_none()
                    && options.repetition_penalty.is_none()),
            "top_k, min_p, presence_penalty and repetition_penalty require chat-completions protocol"
        );
        anyhow::ensure!(
            options
                .reasoning_summary
                .as_deref()
                .is_none_or(|v| matches!(v, "auto" | "concise" | "detailed")),
            "invalid reasoning summary"
        );
        anyhow::ensure!(
            options.reasoning_summary.is_none() || self.protocol == ModelProtocol::Responses,
            "reasoning summary requires responses protocol"
        );
        self.options = options;
        Ok(self)
    }

    pub fn with_temperature(mut self, temperature: Option<f64>) -> Result<Self> {
        anyhow::ensure!(
            temperature.is_none_or(|t| t.is_finite() && (0.0..=2.0).contains(&t)),
            "temperature must be 0..2"
        );
        self.temperature = temperature;
        Ok(self)
    }

    async fn request_body(&self, messages: Vec<Message>) -> Result<Value> {
        match self.protocol {
            ModelProtocol::ChatCompletions => {
                let mut output: Vec<Value> = Vec::with_capacity(messages.len());
                for message in messages {
                    if message.provider_context.is_some() {
                        continue;
                    }
                    let content = chat_content(message.content).await?;
                    // Keep the same role and ordering, but represent adjacent
                    // text system instructions as one provider message. Budget
                    // hints must not change the provider's message grammar.
                    if message.role == "system"
                        && message.tool_calls.is_empty()
                        && message.tool_call_id.is_none()
                        && let Some(text) = content.as_str()
                        && let Some(previous) = output
                            .last_mut()
                            .filter(|m| m["role"] == "system" && m["content"].is_string())
                    {
                        previous["content"] = json!(format!(
                            "{}\n\n{}",
                            previous["content"].as_str().unwrap(),
                            text
                        ));
                        continue;
                    }
                    let mut item = json!({"role": message.role, "content": content});
                    if !message.tool_calls.is_empty() {
                        item["tool_calls"] = json!(message.tool_calls);
                    }
                    if let Some(call_id) = message.tool_call_id {
                        item["tool_call_id"] = json!(call_id);
                    }
                    output.push(item);
                }
                Ok(json!({
                    "model": self.name,
                    "messages": output,
                    "stream": true,
                    "stream_options": {"include_usage": true}
                }))
            }
            ModelProtocol::Responses => {
                let mut output = Vec::with_capacity(messages.len());
                for message in messages {
                    output.extend(responses_items(message).await?);
                }
                Ok(
                    json!({"model": self.name, "input": output, "stream": true, "store": false, "include": ["reasoning.encrypted_content"]}),
                )
            }
        }
    }
}

#[async_trait]
impl Model for HttpModel {
    async fn chat_limited(
        &self,
        messages: Vec<Message>,
        tools: Vec<Value>,
        purpose: RequestPurpose,
        cap: Option<u64>,
    ) -> Result<ModelStream> {
        self.chat_with_limits(messages, tools, purpose, ToolCallLimits::default(), cap)
            .await
    }
    fn configure(
        &self,
        p: &areal_protocol::desktop::ModelParameters,
    ) -> Result<std::sync::Arc<dyn Model>> {
        Ok(std::sync::Arc::new(
            self.clone()
                .with_options(ModelOptions {
                    reasoning_effort: p
                        .reasoning_effort
                        .clone()
                        .or(self.options.reasoning_effort.clone()),
                    reasoning_summary: p
                        .reasoning_summary
                        .clone()
                        .or(self.options.reasoning_summary.clone()),
                    max_output_tokens: p.max_output_tokens.or(self.options.max_output_tokens),
                    ..self.options.clone()
                })?
                .with_temperature(p.temperature.or(self.temperature))?,
        ))
    }
    fn name(&self) -> &str {
        &self.name
    }

    fn provider(&self) -> &str {
        match self.protocol {
            ModelProtocol::ChatCompletions => "openai.chat_completions",
            ModelProtocol::Responses => "openai.responses",
        }
    }

    fn capabilities(&self) -> ModelCapabilities {
        self.protocol.capabilities()
    }

    async fn stream(&self, messages: Vec<Message>) -> Result<ModelStream> {
        self.chat(messages, Vec::new()).await
    }

    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> Result<AgentStream> {
        self.chat_for(messages, tools, RequestPurpose::Solve).await
    }

    async fn chat_for(
        &self,
        messages: Vec<Message>,
        tools: Vec<Value>,
        purpose: RequestPurpose,
    ) -> Result<AgentStream> {
        self.chat_with_limits(messages, tools, purpose, ToolCallLimits::default(), None)
            .await
    }
    async fn chat_with_limits(
        &self,
        messages: Vec<Message>,
        mut tools: Vec<Value>,
        purpose: RequestPurpose,
        mut limits: ToolCallLimits,
        cap: Option<u64>,
    ) -> Result<AgentStream> {
        anyhow::ensure!(
            limits.max_buffer_bytes > 0,
            "tool buffer budget must be positive"
        );
        if purpose == RequestPurpose::Summary {
            limits.max_calls = 0;
            tools.clear();
        }
        let mut body = self.request_body(messages).await?;
        if let Some(temperature) = self.temperature.or(self.options.temperature) {
            body["temperature"] = json!(temperature);
        }
        for (name, value) in [
            ("top_p", self.options.top_p),
            ("min_p", self.options.min_p),
            ("presence_penalty", self.options.presence_penalty),
            ("repetition_penalty", self.options.repetition_penalty),
        ] {
            if let Some(value) = value {
                body[name] = json!(value);
            }
        }
        if let Some(value) = self.options.top_k {
            body["top_k"] = json!(value);
        }
        if let Some(summary) = &self.options.reasoning_summary {
            body["reasoning"] = json!({"summary":summary});
        }
        if let Some(effort) = &self.options.reasoning_effort {
            match self.protocol {
                ModelProtocol::ChatCompletions => body["reasoning_effort"] = json!(effort),
                ModelProtocol::Responses => body["reasoning"]["effort"] = json!(effort),
            }
        }
        let output_tokens = match (self.options.max_output_tokens, cap) {
            (Some(configured), Some(cap)) => Some(configured.min(cap)),
            (configured, cap) => configured.or(cap),
        };
        let output_tokens = if purpose == RequestPurpose::Summary {
            Some(output_tokens.unwrap_or(16384).min(16384))
        } else {
            output_tokens
        };
        if let Some(tokens) = output_tokens {
            body[match self.protocol {
                ModelProtocol::ChatCompletions => "max_completion_tokens",
                ModelProtocol::Responses => "max_output_tokens",
            }] = json!(tokens);
        }
        if !tools.is_empty() {
            body["tools"] = match self.protocol {
                ModelProtocol::ChatCompletions => json!(tools),
                ModelProtocol::Responses => Value::Array(
                    tools
                        .into_iter()
                        .map(|tool| {
                            let mut function = tool["function"].clone();
                            function["type"] = json!("function");
                            function["strict"] = json!(false);
                            function
                        })
                        .collect(),
                ),
            };
            body["parallel_tool_calls"] = json!(true);
        }
        if purpose == RequestPurpose::Summary {
            body["tool_choice"] = json!("none");
        }
        // Retrying before accepting a stream cannot replay a tool operation.
        // Never automatically replay a partially consumed model stream here.
        let mut audit = audit::Audit::new(self.audit_directory.as_deref(), &body, purpose);
        let mut attempt = 0;
        let response = loop {
            audit.value["httpAttempts"] = json!(attempt + 1);
            let mut request = self.client.post(&self.endpoint).json(&body);
            if let Some(key) = &self.key {
                request = request.bearer_auth(key);
            }
            let result = request.send().await;
            audit.value["httpStatus"] = result
                .as_ref()
                .ok()
                .map_or(Value::Null, |r| json!(r.status().as_u16()));
            let transient = match &result {
                Ok(r) => matches!(r.status().as_u16(), 408 | 429) || r.status().is_server_error(),
                Err(e) => !e.is_builder(),
            };
            if transient
                && attempt < self.options.max_retries
                && GOAL_REQUEST.try_with(|_| ()).is_err()
            {
                let delay = result
                    .as_ref()
                    .ok()
                    .and_then(|r| r.headers().get("retry-after"))
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .map(|seconds| Duration::from_secs(seconds.min(30)))
                    .unwrap_or_else(|| Duration::from_millis(250 * (1 << attempt)));
                attempt += 1;
                tracing::info!(
                    areal.model.retry = attempt,
                    delay_ms = delay.as_millis() as u64,
                    "retrying model request before stream acceptance"
                );
                tokio::time::sleep(delay).await;
                continue;
            }
            break result.map_err(|error| {
                let error = if error.is_builder() {
                    anyhow::anyhow!("invalid model HTTP request")
                } else {
                    let timed_out = error.is_timeout();
                    tracing::warn!(connect = error.is_connect(), timeout = timed_out, error = %error.without_url(), "model request transport failure");
                    anyhow::Error::new(if timed_out { ModelFailure::ResponseTimeout } else { ModelFailure::Transport })
                };
                audit.value["outcome"] = json!("failed");
                audit.value["error"] = json!(error.to_string());
                audit.value["terminalOutcome"] = json!(terminal_outcome(&error));
                error
            })?;
        };
        if !response.status().is_success() {
            let error = http_failure(response).await;
            audit.value["terminalOutcome"] = json!(terminal_outcome(&error));
            audit.value["outcome"] = json!("failed");
            audit.value["error"] = json!(error.to_string());
            return Err(error);
        }
        if !response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|s| s.starts_with("text/event-stream"))
        {
            // 错误页和 header 可能含敏感内容，只记录固定诊断与完整接口地址提示。
            let error = anyhow::anyhow!(
                "model response must use text/event-stream; check the full API endpoint (e.g. /v1/chat/completions or /v1/responses)"
            );
            audit.value["outcome"] = json!("failed");
            audit.value["error"] = json!(error.to_string());
            return Err(error);
        }
        let decoder = match self.protocol {
            ModelProtocol::ChatCompletions => Decoder::Chat(ChatDecoder::new(limits)),
            ModelProtocol::Responses => Decoder::Responses(ResponsesDecoder::new(limits)),
        };
        let state = (
            response.bytes_stream(),
            decoder,
            VecDeque::new(),
            false,
            audit,
        );
        Ok(Box::pin(futures_util::stream::unfold(
            state,
            |(mut stream, mut decoder, mut queued, mut failed, mut audit)| async move {
                loop {
                    if let Some(event) = queued.pop_front() {
                        if let ModelEvent::Usage(usage) = &event {
                            let mut total: ModelUsage =
                                serde_json::from_value(audit.value["usage"].clone())
                                    .unwrap_or_default();
                            total.add_assign(usage);
                            audit.value["usage"] = json!(total);
                            audit.value["usageObserved"] = json!(true);
                        }
                        return Some((Ok(event), (stream, decoder, queued, failed, audit)));
                    }
                    let pending_error = decoder.take_pending_error();
                    if failed || (decoder.done() && pending_error.is_none()) {
                        if !failed {
                            audit.value["outcome"] = json!("completed");
                        }
                        return None;
                    }
                    let result = if let Some(error) = pending_error {
                        Err(error)
                    } else {
                        match stream.next().await {
                            Some(Ok(bytes)) => {
                                let parts = decoder.feed(&bytes);
                                audit.value["usageDetails"] = decoder.usage_details();
                                if let Decoder::Chat(chat) = &decoder {
                                    audit.value["stopReason"] = json!(chat.stop_reason);
                                    audit.value["responseShape"] = json!({
                                        "contentFieldBytes":chat.content_bytes,
                                        "reasoningFieldBytes":chat.reasoning_bytes,
                                        "toolArgumentBytes":chat.tool_bytes
                                    });
                                }
                                if !bytes.is_empty() {
                                    queued.push_back(ModelEvent::Activity);
                                }
                                parts
                            }
                            Some(Err(error)) => Err(match &decoder {
                                Decoder::Chat(chat) if chat.truncated => ModelFailure::Truncated,
                                _ if error.is_timeout() => ModelFailure::ResponseTimeout,
                                _ => ModelFailure::Transport,
                            }
                            .into()),
                            None => decoder.finish(),
                        }
                    };
                    match result {
                        Ok(parts) => queued.extend(parts),
                        Err(error) => {
                            failed = true;
                            audit.value["terminalOutcome"] = json!(terminal_outcome(&error));
                            audit.value["outcome"] = json!("failed");
                            if let Some(detail) = error.downcast_ref::<StreamError>() {
                                audit.value["streamError"] = json!(detail);
                            }
                            if let Some(detail) = tool_error_detail(&error) {
                                audit.value["errorCode"] = detail["code"].clone();
                                audit.value["toolCallError"] = detail;
                            }
                            audit.value["error"] = json!(
                                error
                                    .downcast_ref::<ModelFailure>()
                                    .map_or("protocol_or_stream_error".to_owned(), |e| e
                                        .to_string())
                            );
                            return Some((Err(error), (stream, decoder, queued, failed, audit)));
                        }
                    }
                }
            },
        )))
    }
}

async fn chat_content(parts: Vec<ContentPart>) -> Result<Value> {
    if parts
        .iter()
        .all(|part| matches!(part, ContentPart::Text(_)))
    {
        return Ok(Value::String(
            parts
                .into_iter()
                .filter_map(|part| match part {
                    ContentPart::Text(text) => Some(text),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n"),
        ));
    }
    let mut content = Vec::with_capacity(parts.len());
    for part in parts {
        match part {
            ContentPart::Text(text) => content.push(json!({"type":"text", "text":text})),
            ContentPart::Image { source, detail } => {
                let url = materialize(source, "image/png").await?;
                content.push(json!({"type":"image_url", "image_url":{"url":url, "detail":detail.unwrap_or(ImageDetail::Auto)}}));
            }
            ContentPart::Audio { source } => {
                let (data, format) = inline_audio(source).await?;
                content.push(
                    json!({"type":"input_audio", "input_audio":{"data":data,"format":format}}),
                );
            }
            _ => bail!("Chat Completions adapter does not support this input modality"),
        }
    }
    Ok(Value::Array(content))
}

async fn responses_items(message: Message) -> Result<Vec<Value>> {
    if let Some(context) = &message.provider_context {
        if context["type"] == "chat_reasoning" {
            return Ok(Vec::new());
        }
        return Ok(vec![context.clone()]);
    }
    if let Some(call_id) = &message.tool_call_id {
        let output = if message
            .content
            .iter()
            .all(|p| matches!(p, ContentPart::Text(_)))
        {
            json!(message.text_content())
        } else {
            let mut parts = Vec::new();
            for part in message.content {
                match part {
                    ContentPart::Text(text)=>parts.push(json!({"type":"input_text","text":text})),
                    ContentPart::Image{source,..}=>parts.push(json!({"type":"input_image","image_url":materialize(source,"image/png").await?})),
                    ContentPart::File{source,name,mime_type}=>parts.push(json!({"type":"input_file","file_data":materialize(source,mime_type.as_deref().unwrap_or("application/octet-stream")).await?,"filename":name.unwrap_or_else(||"attachment".into())})),
                    ContentPart::Audio{..}=>bail!("Responses tool output does not support audio"),
                }
            }
            json!(parts)
        };
        return Ok(vec![
            json!({"type":"function_call_output", "call_id":call_id, "output":output}),
        ]);
    }
    let mut items = Vec::new();
    let mut content = Vec::new();
    for part in message.content {
        if let ContentPart::Audio { source } = part {
            push_response_message(&mut items, &message.role, &mut content);
            let (data, format) = inline_audio(source).await?;
            items.push(json!({"type":"input_audio", "input_audio":{"data":data,"format":format}}));
            continue;
        }
        match part {
            ContentPart::Text(text) if !text.is_empty() => content.push(json!({"type":if message.role == "assistant" { "output_text" } else { "input_text" }, "text":text})),
            ContentPart::Text(_) => {},
            ContentPart::Image { source, detail } => {
                let url = materialize(source, "image/png").await?;
                content.push(json!({"type":"input_image", "image_url":url, "detail":detail.unwrap_or(ImageDetail::Auto)}));
            }
            ContentPart::File {
                source,
                name,
                mime_type,
            } => {
                let file_url = materialize(
                    source,
                    mime_type.as_deref().unwrap_or("application/octet-stream"),
                )
                .await?;
                if file_url.starts_with("data:") {
                    content
                        .push(json!({"type":"input_file", "file_data":file_url, "filename":name}));
                } else {
                    content
                        .push(json!({"type":"input_file", "file_url":file_url, "filename":name}));
                }
            }
            ContentPart::Audio { .. } => unreachable!(),
        }
    }
    push_response_message(&mut items, &message.role, &mut content);
    for call in message.tool_calls {
        items.push(json!({"type":"function_call", "call_id":call["id"], "name":call["function"]["name"], "arguments":call["function"]["arguments"]}));
    }
    Ok(items)
}

fn push_response_message(items: &mut Vec<Value>, role: &str, content: &mut Vec<Value>) {
    if !content.is_empty() {
        items.push(json!({"role":role,"content":std::mem::take(content)}));
    }
}

async fn inline_audio(source: MediaSource) -> Result<(String, &'static str)> {
    let (bytes, format) = match source {
        MediaSource::LocalPath(path) => {
            let metadata = tokio::fs::metadata(&path)
                .await
                .with_context(|| format!("cannot read local audio: {path}"))?;
            if !metadata.is_file() || metadata.len() > MAX_LOCAL_MEDIA_BYTES as u64 {
                bail!("local audio must be a regular file no larger than 16 MiB");
            }
            let format = if path.to_ascii_lowercase().ends_with(".wav") {
                "wav"
            } else {
                "mp3"
            };
            (tokio::fs::read(path).await?, format)
        }
        MediaSource::Url(url) if url.starts_with("data:audio/") => {
            let (header, data) = url.split_once(',').context("invalid audio data URL")?;
            if !header.ends_with(";base64") {
                bail!("audio data URL must use base64 encoding");
            }
            let format = if header.contains("wav") { "wav" } else { "mp3" };
            (
                STANDARD.decode(data).context("invalid audio data URL")?,
                format,
            )
        }
        MediaSource::Url(_) => {
            bail!("remote audio URLs are not fetched; use localAudio or a data URL")
        }
    };
    Ok((STANDARD.encode(bytes), format))
}

async fn materialize(source: MediaSource, mime_type: &str) -> Result<String> {
    match source {
        MediaSource::Url(url) => {
            let parsed = reqwest::Url::parse(&url).context("invalid media URL")?;
            if !matches!(parsed.scheme(), "http" | "https" | "data") {
                bail!("media URL must use HTTP(S) or a data URL");
            }
            Ok(url)
        }
        MediaSource::LocalPath(path) => {
            let metadata = tokio::fs::metadata(&path)
                .await
                .with_context(|| format!("cannot read local media: {path}"))?;
            if !metadata.is_file() || metadata.len() > MAX_LOCAL_MEDIA_BYTES as u64 {
                bail!("local media must be a regular file no larger than 16 MiB");
            }
            let bytes = tokio::fs::read(&path).await?;
            let mime_type = match path_extension(&path).to_ascii_lowercase().as_str() {
                "jpg" | "jpeg" => "image/jpeg",
                "webp" => "image/webp",
                "gif" => "image/gif",
                "wav" => "audio/wav",
                "mp3" => "audio/mpeg",
                _ => mime_type,
            };
            Ok(format!(
                "data:{mime_type};base64,{}",
                STANDARD.encode(bytes)
            ))
        }
    }
}

fn path_extension(path: &str) -> &str {
    path.rsplit_once('.')
        .map(|(_, extension)| extension)
        .unwrap_or_default()
}

pub fn content_from_input(input: &areal_protocol::Input) -> ContentPart {
    use areal_protocol::Input;
    match input {
        Input::Text { text, .. } => ContentPart::Text(text.clone()),
        Input::Image { url, detail } => ContentPart::Image {
            source: MediaSource::Url(url.clone()),
            detail: *detail,
        },
        Input::LocalImage { path, detail } => ContentPart::Image {
            source: MediaSource::LocalPath(path.clone()),
            detail: *detail,
        },
        Input::Audio { url } => ContentPart::Audio {
            source: MediaSource::Url(url.clone()),
        },
        Input::LocalAudio { path } => ContentPart::Audio {
            source: MediaSource::LocalPath(path.clone()),
        },
        Input::File {
            url,
            name,
            mime_type,
        } => ContentPart::File {
            source: MediaSource::Url(url.clone()),
            name: name.clone(),
            mime_type: mime_type.clone(),
        },
    }
}

/// 管理模式没有可调用的模型，拒绝推理而不伪造模型就绪。
pub struct UnconfiguredModel;
#[async_trait]
impl Model for UnconfiguredModel {
    fn name(&self) -> &str {
        ""
    }
    fn provider(&self) -> &str {
        "unconfigured"
    }
    async fn stream(&self, _: Vec<Message>) -> Result<ModelStream> {
        anyhow::bail!("MODEL_NOT_CONFIGURED")
    }
}

/// 管理入口可启动，但缺少启动凭据的模型不能执行请求。
#[derive(Clone)]
pub struct CredentialUnavailableModel {
    pub name: String,
    pub provider: String,
    pub credential_env: String,
}

#[async_trait]
impl Model for CredentialUnavailableModel {
    fn name(&self) -> &str {
        &self.name
    }
    fn provider(&self) -> &str {
        &self.provider
    }
    fn check_work(&self) -> Result<()> {
        bail!(
            "MODEL_CREDENTIAL_UNAVAILABLE: {} must contain a nonempty HTTP header value",
            self.credential_env
        )
    }
    fn configure(
        &self,
        _: &areal_protocol::desktop::ModelParameters,
    ) -> Result<std::sync::Arc<dyn Model>> {
        Ok(std::sync::Arc::new(self.clone()))
    }
    async fn stream(&self, _: Vec<Message>) -> Result<ModelStream> {
        self.check_work()?;
        unreachable!()
    }
}

#[cfg(test)]
mod outcome_tests {
    use super::*;

    #[test]
    fn typed_model_outcomes_survive_context_and_preserve_retry_policy() {
        for (failure, code, network) in [
            (
                ModelFailure::Truncated,
                "LLM_OUTPUT_TOKEN_LIMIT_EXCEEDED",
                false,
            ),
            (ModelFailure::EmptyCompletion, "LLM_RESPONSE_FAILED", false),
            (ModelFailure::ResponseTimeout, "LLM_RESPONSE_TIMEOUT", true),
            (ModelFailure::Transport, "LLM_RESPONSE_FAILED", true),
        ] {
            let error = anyhow::Error::new(failure).context("outer");
            assert_eq!(terminal_outcome(&error).unwrap().code, code);
            assert_eq!(is_network_error(&error), network);
        }
        let error = tool_index(&json!({"index":-1}), 1, 0, 0, 0).unwrap_err();
        let outcome = terminal_outcome(&error).unwrap();
        assert_eq!(outcome.code, "LLM_RESPONSE_FAILED");
        assert_eq!(outcome.details.unwrap()["code"], "invalid_tool_call_index");
    }

    #[test]
    fn stream_metadata_is_classified_without_provider_message_or_credentials() {
        let detail = StreamError::from_value(
            &json!({
                "code":"context_length_exceeded", "type":"invalid_request_error",
                "message":"secret prompt", "reason":"secret-token"
            }),
            "error",
        );
        let error = anyhow::Error::new(detail).context("outer");
        assert!(!is_network_error(&error));
        let outcome = terminal_outcome(&error).unwrap();
        assert_eq!(outcome.code, "LLM_CONTEXT_WINDOW_EXCEEDED");
        assert_eq!(outcome.source, "provider_stream");
        assert!(!serde_json::to_string(&outcome).unwrap().contains("secret"));
    }

    #[tokio::test]
    async fn http_context_body_limit_and_untrusted_bodies_remain_distinct() {
        use axum::{Router, http::StatusCode, routing::post};
        for (status, body, code, expected_reason) in [
            (
                400,
                json!({"error":{"code":"context_length_exceeded","message":"secret"}}).to_string(),
                "LLM_CONTEXT_WINDOW_EXCEEDED",
                None,
            ),
            (
                413,
                json!({"error":{"code":"context_length_exceeded"}}).to_string(),
                "LLM_RESPONSE_FAILED",
                Some("request_body_too_large"),
            ),
            (
                400,
                json!({"error":{"message":"context_length_exceeded secret"}}).to_string(),
                "LLM_RESPONSE_FAILED",
                None,
            ),
            (
                400,
                "secret".repeat(20000),
                "LLM_RESPONSE_FAILED",
                Some("http_error"),
            ),
            (
                401,
                "secret invalid credential".into(),
                "LLM_RESPONSE_FAILED",
                Some("http_error"),
            ),
            (
                408,
                String::new(),
                "LLM_RESPONSE_TIMEOUT",
                Some("response_timeout"),
            ),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server =
                tokio::spawn(async move {
                    axum::serve(listener, Router::new().route("/", post(move || async move {
                    (StatusCode::from_u16(status).unwrap(), body)
                }))).await.unwrap();
                });
            let response = reqwest::Client::builder()
                .no_proxy()
                .build()
                .unwrap()
                .post(format!("http://{address}/"))
                .send()
                .await
                .unwrap();
            let error = http_failure(response).await;
            let outcome = terminal_outcome(&error).unwrap();
            assert_eq!(outcome.code, code);
            if let Some(reason) = expected_reason {
                assert_eq!(outcome.details.as_ref().unwrap()["reason"], reason);
            }
            if status != 408 {
                assert_eq!(outcome.details.as_ref().unwrap()["httpStatus"], status);
            }
            assert!(!serde_json::to_string(&outcome).unwrap().contains("secret"));
            server.abort();
        }
    }
}
