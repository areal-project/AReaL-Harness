mod decoder;
use decoder::{ChatDecoder, Decoder, ResponsesDecoder};

mod audit;
use anyhow::{Context, Result, bail};
use areal_protocol::{ImageDetail, Modality, ModelUsage};
use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::VecDeque, pin::Pin, time::Duration};

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

// Diagnostic attribution only; never changes provider request parameters.
tokio::task_local! {
    pub(crate) static REQUEST_OWNER: (String, String);
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
    ToolCall(ToolCall),
    Binary {
        modality: Modality,
        mime_type: String,
        data: Vec<u8>,
    },
    Usage(ModelUsage),
}

impl ModelEvent {
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
        mut tools: Vec<Value>,
        purpose: RequestPurpose,
    ) -> Result<AgentStream> {
        if purpose == RequestPurpose::Summary {
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
        if let Some(effort) = &self.options.reasoning_effort {
            match self.protocol {
                ModelProtocol::ChatCompletions => body["reasoning_effort"] = json!(effort),
                ModelProtocol::Responses => body["reasoning"] = json!({"effort":effort}),
            }
        }
        let output_tokens = if purpose == RequestPurpose::Summary {
            Some(self.options.max_output_tokens.unwrap_or(16384).min(16384))
        } else {
            self.options.max_output_tokens
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
                Ok(r) => matches!(r.status().as_u16(), 408 | 429 | 500 | 502 | 503 | 504),
                Err(e) => e.is_connect() || e.is_timeout(),
            };
            if transient && attempt < self.options.max_retries {
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
                tracing::warn!(connect = error.is_connect(), timeout = error.is_timeout(), error = %error.without_url(), "model request transport failure");
                ModelFailure::Transport
            })?;
        };
        if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(ModelFailure::RateLimited.into());
        }
        if response.status().is_server_error() {
            return Err(ModelFailure::Unavailable.into());
        }
        if !response.status().is_success() {
            bail!("model HTTP status {}", response.status());
        }
        if !response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|s| s.starts_with("text/event-stream"))
        {
            bail!("model response must use text/event-stream");
        }
        let decoder = match self.protocol {
            ModelProtocol::ChatCompletions => Decoder::Chat(ChatDecoder::default()),
            ModelProtocol::Responses => Decoder::Responses(ResponsesDecoder::default()),
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
                    if failed || decoder.done() {
                        if !failed {
                            audit.value["outcome"] = json!("completed");
                        }
                        return None;
                    }
                    let result = match stream.next().await {
                        Some(Ok(bytes)) => {
                            let parts = decoder.feed(&bytes);
                            if let Decoder::Chat(chat) = &decoder {
                                audit.value["stopReason"] = json!(chat.stop_reason);
                                audit.value["responseShape"] = json!({
                                    "contentFieldBytes":chat.content_bytes,
                                    "reasoningFieldBytes":chat.reasoning.len(),
                                    "toolArgumentBytes":chat.tool_bytes
                                });
                            }
                            if !bytes.is_empty() {
                                queued.push_back(ModelEvent::Activity);
                            }
                            parts
                        }
                        Some(Err(_)) => Err(match &decoder {
                            Decoder::Chat(chat) if chat.truncated => ModelFailure::Truncated,
                            _ => ModelFailure::Transport,
                        }
                        .into()),
                        None => decoder.finish(),
                    };
                    match result {
                        Ok(parts) => queued.extend(parts),
                        Err(error) => {
                            failed = true;
                            audit.value["outcome"] = json!("failed");
                            if let Some(detail) = error.downcast_ref::<StreamError>() {
                                audit.value["streamError"] = json!(detail);
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
