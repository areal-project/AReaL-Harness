//! SSE 分帧、两种模型协议的完整终态校验与用量解析。

use super::*;

#[derive(Default)]
struct SseFrames {
    bytes: Vec<u8>,
    data: Vec<String>,
    data_bytes: usize,
}

impl SseFrames {
    fn feed(&mut self, bytes: &[u8]) -> Result<Vec<String>> {
        self.bytes.extend_from_slice(bytes);
        if self.bytes.len() > MAX_SSE_BYTES {
            bail!("model SSE frame exceeds 24 MiB");
        }
        let mut output = Vec::new();
        while let Some(end) = self.bytes.iter().position(|b| *b == b'\n') {
            let line: Vec<_> = self.bytes.drain(..=end).collect();
            let line = std::str::from_utf8(&line)?.trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                if !self.data.is_empty() {
                    output.push(self.data.join("\n"));
                    self.data.clear();
                    self.data_bytes = 0;
                }
            } else if let Some(data) = line.strip_prefix("data:") {
                let data = data.strip_prefix(' ').unwrap_or(data);
                self.data_bytes = self.data_bytes.saturating_add(data.len() + 1);
                if self.data_bytes > MAX_SSE_BYTES {
                    bail!("model SSE event exceeds 24 MiB");
                }
                self.data.push(data.to_owned());
            }
        }
        Ok(output)
    }
}

pub(super) enum Decoder {
    Chat(ChatDecoder),
    Responses(ResponsesDecoder),
}

impl Decoder {
    pub(super) fn usage_details(&self) -> Value {
        let details = match self {
            Self::Chat(d) => &d.usage_details,
            Self::Responses(d) => &d.usage_details,
        };
        let mut value =
            json!({"cachedInputTokens":details.cached,"reasoningTokens":details.reasoning});
        if let Some(id) = &details.response_id {
            value["providerResponseId"] = json!(id);
        }
        if let Some(tokens) = details.cache_write {
            value["cacheWriteTokens"] = json!(tokens);
        }
        value
    }
    pub(super) fn feed(&mut self, bytes: &[u8]) -> Result<Vec<ModelEvent>> {
        match self {
            Self::Chat(decoder) => decoder.feed(bytes),
            Self::Responses(decoder) => decoder.feed(bytes),
        }
    }
    pub(super) fn finish(&mut self) -> Result<Vec<ModelEvent>> {
        if let Some(error) = self.take_pending_error() {
            return Err(error);
        }
        if self.done() {
            return Ok(Vec::new());
        }
        if let Self::Chat(decoder) = self {
            // Called only on clean HTTP EOF, never on a transport error. A
            // finish reason is sufficient without [DONE], but a partial SSE
            // event (including a trailing usage/error event) is not success.
            if !decoder.frames.bytes.is_empty() || !decoder.frames.data.is_empty() {
                return Err(if decoder.truncated {
                    ModelFailure::Truncated
                } else {
                    ModelFailure::Incomplete
                }
                .into());
            }
            return decoder.complete();
        }
        Err(ModelFailure::Incomplete.into())
    }
    pub(super) fn take_pending_error(&mut self) -> Option<anyhow::Error> {
        match self {
            Self::Chat(d) => d.pending_error.take(),
            Self::Responses(d) => d.pending_error.take(),
        }
    }
    pub(super) fn done(&self) -> bool {
        match self {
            Self::Chat(decoder) => decoder.done,
            Self::Responses(decoder) => decoder.done,
        }
    }
}

#[derive(Default)]
pub(super) struct ChatDecoder {
    usage_details: UsageDetails,
    pub(super) stop_reason: Option<String>,
    pub(super) truncated: bool,
    final_usage_observed: bool,
    pub(super) content_bytes: usize,
    frames: SseFrames,
    finished: bool,
    done: bool,
    pending_error: Option<anyhow::Error>,
    calls: std::collections::BTreeMap<u64, ToolCall>,
    pub(super) tool_bytes: usize,
    budget: ToolCallBudget,
    event_number: u64,
    pub(super) reasoning_bytes: usize,
}

impl ChatDecoder {
    pub(super) fn new(limits: ToolCallLimits) -> Self {
        Self {
            budget: ToolCallBudget::new(limits),
            ..Self::default()
        }
    }

    fn complete(&mut self) -> Result<Vec<ModelEvent>> {
        // A length finish is a failed inference even after clean HTTP EOF.
        // Hold partial calls while accepting the provider's trailing usage.
        if self.truncated {
            let error = anyhow::Error::new(ModelFailure::Truncated);
            return Err(if self.final_usage_observed {
                error.context(FinalUsageError)
            } else {
                error
            });
        }
        if !self.finished {
            return Err(ModelFailure::Incomplete.into());
        }
        let mut output = Vec::new();
        output.extend(
            std::mem::take(&mut self.calls)
                .into_values()
                .map(ModelEvent::ToolCall),
        );
        self.done = true;
        Ok(output)
    }

    fn feed(&mut self, bytes: &[u8]) -> Result<Vec<ModelEvent>> {
        if let Some(error) = self.pending_error.take() {
            return Err(error);
        }
        let mut output = Vec::new();
        let frames = self.frames.feed(bytes).map_err(|error| {
            if self.truncated {
                anyhow::Error::new(ModelFailure::Truncated)
            } else {
                error
            }
        })?;
        for data in frames {
            self.event_number = self.event_number.saturating_add(1);
            let result = self.decode_event(&data, &mut output).map_err(|error| {
                if self.truncated && !error.is::<FinalUsageError>() {
                    anyhow::Error::new(ModelFailure::Truncated)
                } else {
                    error
                }
            });
            match result {
                Ok(()) => {}
                Err(error) if output.is_empty() => return Err(error),
                Err(error) => {
                    self.pending_error = Some(error);
                    break;
                }
            }
        }
        Ok(output)
    }

    fn decode_event(&mut self, data: &str, output: &mut Vec<ModelEvent>) -> Result<()> {
        if data == "[DONE]" {
            output.extend(self.complete()?);
            return Ok(());
        }
        let event: Value = serde_json::from_str(data).context("invalid SSE JSON")?;
        telemetry::response(&event, ModelProtocol::ChatCompletions);
        if let Some(error) = event.get("error").filter(|v| !v.is_null()) {
            return Err(StreamError::from_value(error, "error").into());
        }
        self.usage_details.observe_response_id(event.get("id"));
        if let Some(usage) = parse_usage(event.get("usage")) {
            // Chat 的最终消费必须位于 finish 同帧或其后；中途统计不能解除 UNKNOWN。
            self.final_usage_observed |= self.finished
                || event["choices"].as_array().is_some_and(|choices| {
                    choices.iter().any(|choice| {
                        choice["index"] == 0
                            && matches!(
                                choice["finish_reason"].as_str(),
                                Some("length" | "stop" | "tool_calls")
                            )
                    })
                });
            self.usage_details.observe(&event["usage"]);
            output.push(ModelEvent::Usage(usage));
        }
        for (choice_position, choice) in event["choices"]
            .as_array()
            .context("missing stream choices")?
            .iter()
            .enumerate()
        {
            if choice["index"].as_u64() != Some(0) {
                bail!("unexpected model choice index");
            }
            let delta = &choice["delta"];
            if let Some(reasoning) = delta["reasoning_content"].as_str() {
                anyhow::ensure!(!self.finished, "reasoning after completion");
                anyhow::ensure!(
                    self.reasoning_bytes + reasoning.len() <= 1024 * 1024,
                    "reasoning exceeds 1 MiB"
                );
                self.reasoning_bytes += reasoning.len();
                if !reasoning.is_empty() {
                    output.push(ModelEvent::reasoning(reasoning));
                }
            }
            if let Some(calls) = delta.get("tool_calls").filter(|v| !v.is_null()) {
                anyhow::ensure!(!self.finished, "tool data after completion");
                for (position, fragment) in calls
                    .as_array()
                    .context("invalid tool_calls")?
                    .iter()
                    .enumerate()
                {
                    let index = tool_index(
                        fragment,
                        self.event_number,
                        choice_position,
                        position,
                        self.calls.len(),
                    )?;
                    if let Some(kind) = fragment["type"].as_str() {
                        anyhow::ensure!(kind == "function", "unsupported tool type");
                    }
                    let mut parts = [""; 3];
                    for (part, value) in parts.iter_mut().zip([
                        &fragment["id"],
                        &fragment["function"]["name"],
                        &fragment["function"]["arguments"],
                    ]) {
                        if !value.is_null() {
                            *part = value.as_str().context("tool fragment must be a string")?;
                        }
                    }
                    let existing = self.calls.get(&index);
                    let lengths = existing.map_or([0; 3], |call| {
                        [call.id.len(), call.name.len(), call.arguments.len()]
                    });
                    self.budget
                        .reserve(existing.is_none(), lengths, parts.map(str::len))?;
                    self.tool_bytes = self.budget.bytes;
                    let call = self.calls.entry(index).or_insert_with(|| ToolCall {
                        id: String::new(),
                        name: String::new(),
                        arguments: String::new(),
                    });
                    for (field, part) in [&mut call.id, &mut call.name, &mut call.arguments]
                        .into_iter()
                        .zip(parts)
                    {
                        field.push_str(part);
                    }
                }
            }
            if let Some(text) = delta["content"]
                .as_str()
                .or_else(|| delta["refusal"].as_str())
                .filter(|text| !text.is_empty())
            {
                self.content_bytes = self.content_bytes.saturating_add(text.len());
                if self.finished {
                    bail!("text received after model completion");
                }
                output.push(ModelEvent::text(text));
            }
            if let Some(reason) = choice["finish_reason"].as_str() {
                if self.finished {
                    bail!("duplicate model completion");
                }
                self.stop_reason = Some(
                    if reason.len() <= 64
                        && reason
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || c == b'_')
                    {
                        reason.to_owned()
                    } else {
                        "unrecognized".into()
                    },
                );
                if reason == "length" {
                    self.truncated = true;
                    self.finished = true;
                    // Do not discard usage already parsed from this event or
                    // stop before a separate usage trailer. complete() reports
                    // Truncated without releasing any buffered tool calls.
                    return Ok(());
                }
                if reason != "stop" && reason != "tool_calls" {
                    bail!("model stopped with reason: {reason}");
                }
                anyhow::ensure!(
                    (reason == "tool_calls") != self.calls.is_empty(),
                    "tool calls and finish reason disagree"
                );
                let mut ids = std::collections::HashSet::new();
                for call in self.calls.values() {
                    anyhow::ensure!(
                        !call.id.is_empty()
                            && call.id.len() <= 256
                            && call.id.is_ascii()
                            && ids.insert(&call.id),
                        "invalid or duplicate tool call ID"
                    );
                    anyhow::ensure!(
                        !call.name.is_empty() && call.name.len() <= 128 && call.name.is_ascii(),
                        "invalid tool name"
                    );
                    // A complete transport response can contain invalid model
                    // arguments. The tool layer journals a rejected call and
                    // lets the model correct it; no operation is submitted.
                }
                self.finished = true;
            }
        }
        Ok(())
    }
}

#[derive(Default)]
pub(super) struct ResponsesDecoder {
    usage_details: UsageDetails,
    frames: SseFrames,
    audio: String,
    finished: bool,
    done: bool,
    contexts: Vec<Value>,
    calls: Vec<ToolCall>,
    item_ids: std::collections::HashSet<String>,
    budget: ToolCallBudget,
    reasoning: std::collections::BTreeMap<(String, ReasoningKind, usize), String>,
    reasoning_bytes: usize,
    pending_error: Option<anyhow::Error>,
}

impl ResponsesDecoder {
    pub(super) fn new(limits: ToolCallLimits) -> Self {
        Self {
            budget: ToolCallBudget::new(limits),
            ..Self::default()
        }
    }

    fn record_item(&mut self, item: &Value, output: &mut Vec<ModelEvent>) -> Result<()> {
        match item["type"].as_str() {
            Some("reasoning") => {
                let id = item["id"].as_str().context("reasoning item missing ID")?;
                for (field, kind, part_type) in [
                    ("summary", ReasoningKind::Summary, "summary_text"),
                    ("content", ReasoningKind::Text, "reasoning_text"),
                ] {
                    if let Some(parts) = item[field].as_array() {
                        anyhow::ensure!(parts.len() <= 64, "too many reasoning parts");
                        for (index, part) in parts.iter().enumerate() {
                            if part["type"] == part_type {
                                let text = part["text"]
                                    .as_str()
                                    .context("reasoning text must be a string")?;
                                self.reasoning_part(id, kind, index, text, true, output)?;
                            }
                        }
                    }
                }
                if self.item_ids.insert(id.to_owned()) {
                    anyhow::ensure!(self.contexts.len() < 64, "too many reasoning items");
                    anyhow::ensure!(
                        item.to_string().len() <= 256 * 1024,
                        "reasoning context exceeds 256 KiB"
                    );
                    self.contexts.push(item.clone());
                }
            }
            Some("function_call") => {
                let id = item["call_id"].as_str().context("missing call ID")?;
                let name = item["name"].as_str().context("missing function name")?;
                let arguments = item["arguments"]
                    .as_str()
                    .context("missing function arguments")?;
                anyhow::ensure!(!id.is_empty() && id.is_ascii(), "invalid call ID");
                anyhow::ensure!(!name.is_empty() && name.is_ascii(), "invalid function name");
                if let Some(existing) = self.calls.iter().find(|call| call.id == id) {
                    anyhow::ensure!(
                        existing.name == name && existing.arguments == arguments,
                        "conflicting function call replay"
                    );
                } else {
                    self.budget
                        .reserve(true, [0; 3], [id.len(), name.len(), arguments.len()])?;
                    anyhow::ensure!(
                        serde_json::from_str::<Value>(arguments)?.is_object(),
                        "invalid function arguments"
                    );
                    // 保留 Responses 原始 item ID、参数字节与字段，用于后续 wire 回放。
                    self.contexts.push(item.clone());
                    self.calls.push(ToolCall {
                        id: id.into(),
                        name: name.into(),
                        arguments: arguments.into(),
                    });
                }
            }
            Some("computer_call" | "custom_tool_call") => bail!("unsupported Responses tool type"),
            _ => {}
        }
        Ok(())
    }

    fn reasoning_part(
        &mut self,
        item_id: &str,
        kind: ReasoningKind,
        index: usize,
        text: &str,
        snapshot: bool,
        output: &mut Vec<ModelEvent>,
    ) -> Result<()> {
        anyhow::ensure!(
            !item_id.is_empty() && item_id.len() <= 256,
            "invalid reasoning item ID"
        );
        anyhow::ensure!(index < 64, "reasoning part index exceeds limit");
        let key = (item_id.to_owned(), kind, index);
        anyhow::ensure!(
            self.reasoning.contains_key(&key) || self.reasoning.len() < 128,
            "too many reasoning parts"
        );
        let current = self.reasoning.entry(key).or_default();
        // done/part.done/最终 output 都是同一前缀的快照，只补尚未透传的后缀。
        let delta = if snapshot {
            text.strip_prefix(current.as_str())
                .context("conflicting reasoning snapshot")?
        } else {
            text
        };
        anyhow::ensure!(
            self.reasoning_bytes + delta.len() <= 1024 * 1024,
            "reasoning exceeds 1 MiB"
        );
        if !delta.is_empty() {
            self.reasoning_bytes += delta.len();
            current.push_str(delta);
            output.push(ModelEvent::ReasoningDelta {
                item_id: item_id.into(),
                kind,
                index,
                delta: delta.into(),
            });
        }
        Ok(())
    }

    fn feed(&mut self, bytes: &[u8]) -> Result<Vec<ModelEvent>> {
        if let Some(error) = self.pending_error.take() {
            return Err(error);
        }
        let mut output = Vec::new();
        for data in self.frames.feed(bytes)? {
            match self.decode_event(&data, &mut output) {
                Ok(()) => {}
                Err(error) if output.is_empty() => return Err(error),
                Err(error) => {
                    self.pending_error = Some(error);
                    break;
                }
            }
            if self.done {
                break;
            }
        }
        Ok(output)
    }

    fn decode_event(&mut self, data: &str, output: &mut Vec<ModelEvent>) -> Result<()> {
        if data == "[DONE]" {
            self.done = self.finished;
            if !self.done {
                return Err(ModelFailure::Incomplete.into());
            }
            return Ok(());
        }
        let event: Value = serde_json::from_str(data).context("invalid Responses SSE JSON")?;
        telemetry::response(&event, ModelProtocol::Responses);
        self.usage_details
            .observe_response_id(event["response"].get("id"));
        match event["type"].as_str().unwrap_or_default() {
            kind @ ("response.reasoning_summary_text.delta"
            | "response.reasoning_summary_text.done"
            | "response.reasoning_text.delta"
            | "response.reasoning_text.done"
            | "response.reasoning_summary_part.added"
            | "response.reasoning_summary_part.done") => {
                let summary = kind.starts_with("response.reasoning_summary_");
                let snapshot = !kind.ends_with(".delta");
                let text = if kind.contains("_part.") {
                    &event["part"]["text"]
                } else if snapshot {
                    &event["text"]
                } else {
                    &event["delta"]
                };
                self.reasoning_part(
                    event["item_id"]
                        .as_str()
                        .context("missing reasoning item ID")?,
                    if summary {
                        ReasoningKind::Summary
                    } else {
                        ReasoningKind::Text
                    },
                    event[if summary {
                        "summary_index"
                    } else {
                        "content_index"
                    }]
                    .as_u64()
                    .filter(|i| *i < 64)
                    .context("invalid reasoning part index")? as usize,
                    text.as_str().context("reasoning text must be a string")?,
                    snapshot,
                    output,
                )?;
            }
            "response.output_text.delta" | "response.refusal.delta" => {
                if let Some(delta) = event["delta"].as_str().filter(|v| !v.is_empty()) {
                    output.push(ModelEvent::text(delta));
                }
            }
            "response.audio.delta" => {
                if let Some(delta) = event["delta"].as_str() {
                    self.audio.push_str(delta);
                    if self.audio.len() > MAX_LOCAL_MEDIA_BYTES * 2 {
                        bail!("audio output exceeds encoded size limit");
                    }
                }
            }
            "response.audio.done" => {
                if !self.audio.is_empty() {
                    output.push(ModelEvent::Binary {
                        modality: Modality::Audio,
                        mime_type: "audio/mpeg".into(),
                        data: STANDARD
                            .decode(std::mem::take(&mut self.audio))
                            .context("invalid response audio base64")?,
                    });
                }
            }
            "response.output_item.done" => {
                let item = &event["item"];
                self.record_item(item, output)?;
                if item["type"] == "image_generation_call"
                    && let Some(result) = item["result"].as_str()
                {
                    output.push(ModelEvent::Binary {
                        modality: Modality::Image,
                        mime_type: "image/png".into(),
                        data: STANDARD
                            .decode(result)
                            .context("invalid generated image base64")?,
                    });
                }
            }
            "response.completed" => {
                self.usage_details
                    .observe_response_id(event["response"].get("id"));
                if event["response"]["status"] != "completed" {
                    bail!("Responses request did not complete successfully");
                }
                if let Some(usage) = parse_usage(event["response"].get("usage")) {
                    self.usage_details.observe(&event["response"]["usage"]);
                    output.push(ModelEvent::Usage(usage));
                }
                if let Some(items) = event["response"]["output"].as_array() {
                    for item in items {
                        self.record_item(item, output)?;
                    }
                }
                output.extend(
                    std::mem::take(&mut self.contexts)
                        .into_iter()
                        .map(ModelEvent::ProviderContext),
                );
                output.extend(
                    std::mem::take(&mut self.calls)
                        .into_iter()
                        .map(ModelEvent::ToolCall),
                );

                self.finished = true;
                self.done = true;
            }
            "response.failed" | "response.incomplete" | "error" => {
                // 已返回的消费先结算，再传播终止错误；不得把明确用量变成 unknown。
                if let Some(usage) = parse_usage(event["response"].get("usage")) {
                    self.usage_details.observe(&event["response"]["usage"]);
                    output.push(ModelEvent::Usage(usage));
                }
                let value = event
                    .get("error")
                    .filter(|v| !v.is_null())
                    .or_else(|| event["response"].get("error").filter(|v| !v.is_null()))
                    .or_else(|| event["response"].get("incomplete_details"))
                    .unwrap_or(&event);
                let kind = match event["type"].as_str() {
                    Some("response.failed") => "response.failed",
                    Some("response.incomplete") => "response.incomplete",
                    _ => "error",
                };
                let error = anyhow::Error::new(StreamError::from_value(value, kind));
                return Err(
                    if kind != "error" && parse_usage(event["response"].get("usage")).is_some() {
                        error.context(FinalUsageError)
                    } else {
                        error
                    },
                );
            }
            _ => {}
        }
        Ok(())
    }
}

#[derive(Default)]
struct UsageDetails {
    seen: bool,
    cached: Option<u64>,
    reasoning: Option<u64>,
    response_id: Option<String>,
    cache_write: Option<u64>,
}

impl UsageDetails {
    fn observe_response_id(&mut self, value: Option<&Value>) {
        // 只记录可用于供应商排障的规范 ID，不复制任意响应文本或认证字段。
        if let Some(id) = value.and_then(Value::as_str).filter(|id| {
            id.len() <= 128
                && (id.starts_with("resp_") || id.starts_with("chatcmpl-"))
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        }) {
            self.response_id = Some(id.to_owned());
        }
    }
    fn observe(&mut self, value: &Value) {
        // 缺失的可选计数保留 unknown；不改变现有预算使用的 ModelUsage。
        let cached = value
            .get("input_tokens_details")
            .or_else(|| value.get("prompt_tokens_details"))
            .and_then(|v| v["cached_tokens"].as_u64());
        let cache_write = value
            .get("input_tokens_details")
            .or_else(|| value.get("prompt_tokens_details"))
            .and_then(|v| v.get("cache_write_tokens"))
            .and_then(Value::as_u64);
        let reasoning = value
            .get("output_tokens_details")
            .or_else(|| value.get("completion_tokens_details"))
            .and_then(|v| v["reasoning_tokens"].as_u64());
        if self.seen {
            self.cache_write = self
                .cache_write
                .zip(cache_write)
                .map(|(a, b)| a.saturating_add(b));
            self.cached = self.cached.zip(cached).map(|(a, b)| a.saturating_add(b));
            self.reasoning = self
                .reasoning
                .zip(reasoning)
                .map(|(a, b)| a.saturating_add(b));
        } else {
            self.cached = cached;
            self.cache_write = cache_write;
            self.reasoning = reasoning;
        }
        self.seen = true;
    }
}

fn parse_usage(value: Option<&Value>) -> Option<ModelUsage> {
    let value = value?.as_object()?;
    Some(ModelUsage {
        input_tokens: value
            .get("input_tokens")
            .or_else(|| value.get("prompt_tokens"))?
            .as_u64()?,
        cached_input_tokens: value
            .get("input_tokens_details")
            .or_else(|| value.get("prompt_tokens_details"))
            .and_then(|v| v.get("cached_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        output_tokens: value
            .get("output_tokens")
            .or_else(|| value.get("completion_tokens"))?
            .as_u64()?,
    })
}

#[cfg(test)]
mod truncated_usage_tests {
    use super::*;

    #[test]
    fn zero_usage_is_known_but_missing_or_scalar_usage_is_not() {
        assert!(parse_usage(Some(&json!({"input_tokens":0,"output_tokens":0}))).is_some());
        assert!(parse_usage(Some(&json!({"prompt_tokens":0,"completion_tokens":0}))).is_some());
        for value in [json!(0), json!(null), json!({}), json!({"input_tokens":0})] {
            assert!(parse_usage(Some(&value)).is_none());
        }
        for (kind, known) in [("response.failed", true), ("error", false)] {
            let event = json!({"type":kind,"response":{
                "usage":{"input_tokens":0,"output_tokens":0},
                "error":{"code":"server_error"}
            }});
            let mut decoder = Decoder::Responses(ResponsesDecoder::default());
            let events = decoder
                .feed(format!("data: {event}\n\n").as_bytes())
                .unwrap();
            assert!(events.iter().any(
                |e| matches!(e, ModelEvent::Usage(u) if u.input_tokens == 0 && u.output_tokens == 0)
            ));
            assert_eq!(decoder.finish().unwrap_err().is::<FinalUsageError>(), known);
        }
    }

    #[test]
    fn final_usage_marker_requires_terminal_framing() {
        for (tail, known) in [("data: [DONE]\n\n", true), ("", true), ("data: {", false)] {
            let mut decoder = Decoder::Chat(ChatDecoder::default());
            let wire = concat!(
                "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"length\"}]}\n\n",
                "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":20}}\n\n"
            ).to_owned() + tail;
            let events = decoder.feed(wire.as_bytes()).unwrap();
            assert!(events.iter().any(|e| matches!(e, ModelEvent::Usage(_))));
            let error = decoder.finish().unwrap_err();
            assert_eq!(error.is::<FinalUsageError>(), known);
        }
    }

    #[test]
    fn responses_final_usage_marker_excludes_generic_errors_and_missing_usage() {
        for kind in ["response.failed", "response.incomplete", "error"] {
            for with_usage in [false, true] {
                let mut decoder = Decoder::Responses(ResponsesDecoder::default());
                let mut event = json!({"type":kind, "response":{"error":{"code":"server_error"}}});
                if with_usage {
                    event["response"]["usage"] = json!({"input_tokens":10,"output_tokens":20});
                }
                let result = decoder.feed(format!("data: {event}\n\n").as_bytes());
                let error = if with_usage {
                    assert!(
                        result
                            .unwrap()
                            .iter()
                            .any(|event| matches!(event, ModelEvent::Usage(_)))
                    );
                    decoder.finish().unwrap_err()
                } else {
                    result.unwrap_err()
                };
                assert_eq!(error.is::<FinalUsageError>(), with_usage && kind != "error");
                assert!(error.downcast_ref::<StreamError>().is_some());
            }
        }
    }

    #[test]
    fn intermediate_usage_before_length_is_not_final_consumption() {
        let mut decoder = Decoder::Chat(ChatDecoder::default());
        decoder.feed(b"data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":1}}\n\n").unwrap();
        let error = decoder.feed(b"data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"length\"}]}\n\ndata: [DONE]\n\n").unwrap_err();
        assert!(!error.is::<FinalUsageError>());
        assert_eq!(
            error.downcast_ref::<ModelFailure>(),
            Some(&ModelFailure::Truncated)
        );
    }

    #[test]
    fn optional_counters_preserve_unknown_and_both_wire_formats() {
        let mut details = UsageDetails::default();
        details.observe(&json!({"prompt_tokens_details":{"cached_tokens":12},"completion_tokens_details":{"reasoning_tokens":3}}));
        assert_eq!((details.cached, details.reasoning), (Some(12), Some(3)));
        details.observe(&json!({"input_tokens_details":{"cached_tokens":8},"output_tokens_details":{"reasoning_tokens":2}}));
        assert_eq!((details.cached, details.reasoning), (Some(20), Some(5)));
        details.observe(&json!({}));
        assert_eq!((details.cached, details.reasoning), (None, None));
    }

    #[test]
    fn malformed_or_partial_usage_tail_preserves_truncated_reason_and_known_usage() {
        for tail in [
            b"data: not-json\n\n".as_slice(),
            b"data: {\"usage\":".as_slice(),
        ] {
            let mut decoder = Decoder::Chat(ChatDecoder::default());
            let prefix = concat!(
                "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"length\"}]}\n\n",
                "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3}}\n\n"
            );
            let events = decoder.feed(prefix.as_bytes()).unwrap();
            assert!(
                matches!(events.as_slice(), [ModelEvent::Usage(usage)] if usage.input_tokens == 7 && usage.output_tokens == 3)
            );
            if let Err(error) = decoder.feed(tail) {
                assert_eq!(
                    error.downcast_ref::<ModelFailure>(),
                    Some(&ModelFailure::Truncated)
                );
            }
            assert_eq!(
                decoder.finish().unwrap_err().downcast_ref::<ModelFailure>(),
                Some(&ModelFailure::Truncated)
            );
            assert!(
                matches!(decoder, Decoder::Chat(ref chat) if chat.stop_reason.as_deref() == Some("length"))
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_error_categories_survive_without_echoing_sensitive_text() {
        let mut chat = Decoder::Chat(ChatDecoder::default());
        let data = format!(
            "data: {}\n\n",
            json!({"error":{
                "code":"context_length_exceeded","type":"invalid_request_error",
                "message":"Bearer secret-api-key; private prompt", "request_id":"secret-api-key"
            }})
        );
        let error = chat.feed(data.as_bytes()).unwrap_err().to_string();
        assert!(error.contains("context_length_exceeded"));
        assert!(error.contains("invalid_request_error"));
        assert!(!error.contains("secret-api-key"));
        assert!(!error.contains("private prompt"));
        for event in [
            json!({"type":"response.failed","response":{"error":{"code":"insufficient_quota","message":"secret-api-key"}}}),
            json!({"type":"error","code":"rate_limit_exceeded","message":"secret-api-key"}),
            json!({"type":"response.incomplete","response":{"error":null,"incomplete_details":{"reason":"max_output_tokens"}}}),
        ] {
            let expected = event["response"]["error"]["code"]
                .as_str()
                .or_else(|| event["code"].as_str())
                .or_else(|| event["response"]["incomplete_details"]["reason"].as_str())
                .unwrap();
            let error = ResponsesDecoder::default()
                .feed(format!("data: {event}\n\n").as_bytes())
                .unwrap_err()
                .to_string();
            assert!(error.contains(expected), "{error}");
            assert!(!error.contains("secret-api-key"));
        }
        let error = StreamError::from_value(
            &json!({"code":"secret-api-key","type":"private prompt","message":"secret"}),
            "error",
        )
        .to_string();
        assert!(!error.contains("secret"));
        assert!(!error.contains("private"));
    }

    #[test]
    fn watchdog_classifies_sse_network_errors_without_retrying_permanent_failures() {
        for (value, retry) in [
            (json!({"code":"rate_limit_exceeded"}), true),
            (json!({"type":"rate_limit_error"}), true),
            (json!({"type":"server_error"}), true),
            (json!({"type":"api_error"}), true),
            (json!({"type":"overloaded_error"}), true),
            (
                json!({"code":"server_is_overloaded","type":"service_unavailable_error"}),
                true,
            ),
            (json!({"code":"server_is_overloaded"}), true),
            (json!({"type":"service_unavailable_error"}), true),
            (
                json!({"code":"insufficient_quota","type":"service_unavailable_error"}),
                false,
            ),
            (
                json!({"code":"insufficient_quota","type":"server_error"}),
                false,
            ),
            (json!({"type":"authentication_error"}), false),
            (json!({"code":"invalid_api_key"}), false),
            (json!({"type":"permission_error"}), false),
            (json!({"type":"invalid_request_error"}), false),
            (json!({"code":"context_length_exceeded"}), false),
            (json!({"reason":"max_output_tokens"}), false),
            (
                json!({"message":"connection error in untrusted text"}),
                false,
            ),
        ] {
            for mut decoder in [
                Decoder::Chat(ChatDecoder::default()),
                Decoder::Responses(ResponsesDecoder::default()),
            ] {
                let event = json!({"type":"error", "error":value});
                let error = decoder
                    .feed(format!("data: {event}\n\n").as_bytes())
                    .unwrap_err();
                assert_eq!(is_network_error(&error), retry, "{value}");
            }
        }
        let error = ResponsesDecoder::default()
            .feed(b"data: [DONE]\n\n")
            .unwrap_err();
        assert!(is_network_error(&error));
    }

    #[test]
    fn a_late_upstream_error_preserves_classification_and_never_releases_tools() {
        let mut decoder = Decoder::Chat(ChatDecoder::default());
        let input = concat!(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"}}]}\n\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"x\",\"function\":{\"name\":\"fs_write\",\"arguments\":\"{}\"}}]}}]}\n\n",
            "data: {\"error\":{\"code\":\"rate_limit_exceeded\",\"message\":\"secret\"}}\n\n"
        );
        let events = decoder.feed(input.as_bytes()).unwrap();
        assert!(matches!(events.as_slice(), [ModelEvent::TextDelta(_)]));
        let error = decoder.finish().unwrap_err();
        assert!(is_network_error(&error));
        let error = error.to_string();
        assert!(error.contains("rate_limit_exceeded"));
        assert!(!error.contains("secret"));
    }

    #[test]
    fn response_error_diagnostics_keep_event_kind_and_bound_provider_labels() {
        for kind in ["response.failed", "response.incomplete", "error"] {
            let mut decoder = Decoder::Responses(ResponsesDecoder::default());
            let event = json!({"type":kind,"error":null,"response":{"error":{
                "code":"x".repeat(65),"type":"unsafe\nprivate-input","message":"fixture-secret"
            }}});
            let error = decoder
                .feed(format!("data: {event}\n\n").as_bytes())
                .unwrap_err();
            let detail =
                serde_json::to_value(error.downcast_ref::<StreamError>().unwrap()).unwrap();
            assert_eq!(detail["eventType"], kind);
            assert_eq!(detail["errorShape"], "object");
            assert!(detail["code"].is_null() && detail["errorType"].is_null());
            assert!(!detail.to_string().contains("fixture-secret"));
        }
    }

    #[test]
    fn tool_markup_in_content_stays_text_even_when_native_calls_are_present() {
        let text = "<think>notes</think><tool_call><function=fs_write><parameter=path>marker</parameter></function></tool_call>";
        for native in [false, true] {
            let mut decoder = Decoder::Chat(ChatDecoder::default());
            let mut delta = json!({"content":text});
            if native {
                delta["tool_calls"] = json!([{"index":0,"id":"native-call",
                    "type":"function","function":{"name":"fs_stat","arguments":"{}"}}]);
            }
            let event = json!({"choices":[{"index":0,"delta":delta,
                "finish_reason":if native {"tool_calls"} else {"stop"}}]});
            let events = decoder
                .feed(format!("data: {event}\n\ndata: [DONE]\n\n").as_bytes())
                .unwrap();
            let visible: String = events
                .iter()
                .filter_map(|event| match event {
                    ModelEvent::TextDelta(text) => Some(text.as_str()),
                    _ => None,
                })
                .collect();
            assert_eq!(visible, text);
            let calls: Vec<_> = events
                .iter()
                .filter_map(|event| match event {
                    ModelEvent::ToolCall(call) => Some(call),
                    _ => None,
                })
                .collect();
            assert_eq!(calls.len(), usize::from(native));
            assert!(
                calls
                    .iter()
                    .all(|call| call.id == "native-call" && call.name == "fs_stat")
            );
        }
    }

    #[test]
    fn chat_reasoning_is_preserved_separately_from_visible_text() {
        let mut decoder = Decoder::Chat(ChatDecoder::default());
        let bytes = concat!(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"inspect \"}}]}\n\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"then test\",\"content\":\"done\"}}]}\n\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n"
        );
        let events = decoder.feed(bytes.as_bytes()).unwrap();
        assert!(
            events
                .iter()
                .any(|e| matches!(e, ModelEvent::TextDelta(text) if text == "done"))
        );
        assert_eq!(
            events
                .iter()
                .filter_map(|e| match e {
                    ModelEvent::ReasoningDelta { delta, .. } => Some(delta.as_str()),
                    _ => None,
                })
                .collect::<String>(),
            "inspect then test"
        );
        assert!(
            !events
                .iter()
                .any(|e| matches!(e, ModelEvent::ProviderContext(_)))
        );
    }

    #[test]
    fn reasoning_is_emitted_before_completion_across_utf8_frame_boundaries() {
        let frame = "data: {\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"思考🙂\",\"content\":null}}]}\n\n";
        for split in 0..=frame.len() {
            let mut decoder = Decoder::Chat(ChatDecoder::default());
            let mut events = decoder.feed(&frame.as_bytes()[..split]).unwrap();
            events.extend(decoder.feed(&frame.as_bytes()[split..]).unwrap());
            assert_eq!(events, vec![ModelEvent::reasoning("思考🙂")]);
            assert!(!decoder.done());
        }
        let mut decoder = Decoder::Chat(ChatDecoder::default());
        let empty =
            b"data: {\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"\"}}]}\n\n";
        assert!(decoder.feed(empty).unwrap().is_empty());
    }

    fn response_frame(value: Value) -> String {
        format!("data: {value}\n\n")
    }

    #[test]
    fn responses_reasoning_keeps_items_parts_and_kinds_without_repeating_snapshots() {
        let mut decoder = Decoder::Responses(ResponsesDecoder::default());
        let item = json!({"type":"reasoning","id":"rs1","summary":[{"type":"summary_text","text":"检查依赖"},{"type":"summary_text","text":"再验证"}],"content":[{"type":"reasoning_text","text":"raw text"}],"encrypted_content":"private-opaque"});
        let frames = [
            json!({"type":"response.reasoning_summary_part.added","item_id":"rs1","summary_index":0,"part":{"type":"summary_text","text":""}}),
            json!({"type":"response.reasoning_summary_text.delta","item_id":"rs1","summary_index":0,"delta":"检查"}),
            json!({"type":"response.reasoning_summary_text.done","item_id":"rs1","summary_index":0,"text":"检查依赖"}),
            json!({"type":"response.reasoning_summary_part.done","item_id":"rs1","summary_index":0,"part":{"type":"summary_text","text":"检查依赖"}}),
            json!({"type":"response.reasoning_text.delta","item_id":"rs1","content_index":0,"delta":"raw "}),
            json!({"type":"response.reasoning_text.done","item_id":"rs1","content_index":0,"text":"raw text"}),
            json!({"type":"response.output_item.done","item":item}),
            json!({"type":"response.completed","response":{"status":"completed","output":[item, {"type":"reasoning","id":"rs2","summary":[{"type":"summary_text","text":"第二项"}]}]}}),
        ];
        let mut parts = std::collections::BTreeMap::<_, String>::new();
        let mut contexts = Vec::new();
        for (n, frame) in frames.into_iter().enumerate() {
            let bytes = response_frame(frame);
            let mut events = Vec::new();
            // 每字节分包覆盖非 ASCII 字符；分帧完成前不产生语义增量。
            for byte in bytes.bytes() {
                events.extend(decoder.feed(&[byte]).unwrap());
            }
            if n == 1 {
                assert!(
                    matches!(events.as_slice(), [ModelEvent::ReasoningDelta { delta, .. }] if delta == "检查")
                );
            }
            for event in events {
                match event {
                    ModelEvent::ReasoningDelta {
                        item_id,
                        kind,
                        index,
                        delta,
                    } => parts
                        .entry((item_id, kind, index))
                        .or_default()
                        .push_str(&delta),
                    ModelEvent::ProviderContext(context) => contexts.push(context),
                    _ => panic!("unexpected reasoning event"),
                }
            }
        }
        assert_eq!(parts.len(), 4);
        assert_eq!(
            parts[&("rs1".into(), ReasoningKind::Summary, 0)],
            "检查依赖"
        );
        assert_eq!(parts[&("rs1".into(), ReasoningKind::Summary, 1)], "再验证");
        assert_eq!(parts[&("rs1".into(), ReasoningKind::Text, 0)], "raw text");
        assert_eq!(parts[&("rs2".into(), ReasoningKind::Summary, 0)], "第二项");
        assert_eq!(contexts.len(), 2);
        assert_eq!(contexts[0], item);
        assert!(decoder.done());
    }

    #[test]
    fn responses_opaque_reasoning_is_context_only_and_failure_keeps_emitted_prefix() {
        let opaque =
            json!({"type":"reasoning","id":"opaque","summary":[],"encrypted_content":"private"});
        let mut decoder = Decoder::Responses(ResponsesDecoder::default());
        assert!(
            decoder
                .feed(
                    response_frame(json!({"type":"response.output_item.done","item":opaque}))
                        .as_bytes()
                )
                .unwrap()
                .is_empty()
        );
        let events = decoder.feed(response_frame(json!({"type":"response.completed","response":{"status":"completed","output":[opaque]}})).as_bytes()).unwrap();
        assert!(matches!(events.as_slice(), [ModelEvent::ProviderContext(v)] if v == &opaque));

        let mut decoder = Decoder::Responses(ResponsesDecoder::default());
        let frames = response_frame(
            json!({"type":"response.reasoning_summary_text.delta","item_id":"r","summary_index":0,"delta":"partial"}),
        ) + &response_frame(
            json!({"type":"response.failed","response":{"error":{"code":"server_error"}}}),
        );
        let events = decoder.feed(frames.as_bytes()).unwrap();
        assert!(
            matches!(events.as_slice(), [ModelEvent::ReasoningDelta {delta,..}] if delta == "partial")
        );
        assert!(decoder.finish().is_err());
    }

    #[test]
    fn responses_reasoning_rejects_conflicts_and_unbounded_indices() {
        let mut decoder = Decoder::Responses(ResponsesDecoder::default());
        decoder.feed(response_frame(json!({"type":"response.reasoning_summary_text.delta","item_id":"r","summary_index":0,"delta":"prefix"})).as_bytes()).unwrap();
        assert!(decoder.feed(response_frame(json!({"type":"response.reasoning_summary_text.done","item_id":"r","summary_index":0,"text":"different"})).as_bytes()).is_err());
        for index in [json!(-1), json!(64), json!(u64::MAX), json!(null)] {
            let mut decoder = Decoder::Responses(ResponsesDecoder::default());
            assert!(decoder.feed(response_frame(json!({"type":"response.reasoning_text.delta","item_id":"r","content_index":index,"delta":"x"})).as_bytes()).is_err());
        }
    }

    #[test]
    fn responses_final_reasoning_and_usage_survive_a_tool_budget_error() {
        let mut decoder = Decoder::Responses(ResponsesDecoder::new(ToolCallLimits {
            max_calls: 0,
            ..ToolCallLimits::default()
        }));
        let events = decoder.feed(response_frame(json!({
            "type":"response.completed",
            "response":{"status":"completed","usage":{"input_tokens":7,"output_tokens":3},"output":[
                {"type":"reasoning","id":"r","summary":[{"type":"summary_text","text":"checked"}]},
                {"type":"function_call","call_id":"c","name":"test","arguments":"{}"}
            ]}
        })).as_bytes()).unwrap();
        assert!(
            matches!(events.as_slice(), [ModelEvent::Usage(usage), ModelEvent::ReasoningDelta {delta, ..}] if usage.input_tokens == 7 && usage.output_tokens == 3 && delta == "checked")
        );
        assert_eq!(
            tool_error_detail(&decoder.take_pending_error().unwrap()).unwrap()["budget"],
            "calls"
        );
        assert!(!decoder.done());
    }

    #[test]
    fn typed_truncation_survives_prior_events_without_releasing_partial_tools() {
        let bytes = concat!(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"working\"}}]}\n\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"x\",\"function\":{\"name\":\"run_command\",\"arguments\":\"{\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"length\"}]}\n\n"
        );
        let mut decoder = Decoder::Chat(ChatDecoder::default());
        let events = decoder.feed(bytes.as_bytes()).unwrap();
        assert!(events.iter().all(|e| !matches!(e, ModelEvent::ToolCall(_))));
        assert_eq!(
            decoder.finish().unwrap_err().downcast_ref::<ModelFailure>(),
            Some(&ModelFailure::Truncated)
        );
        assert_eq!(
            decoder
                .feed(b"data: [DONE]\n\n")
                .unwrap_err()
                .downcast_ref::<ModelFailure>(),
            Some(&ModelFailure::Truncated)
        );
        let mut incomplete = Decoder::Chat(ChatDecoder::default());
        assert_eq!(
            incomplete
                .finish()
                .unwrap_err()
                .downcast_ref::<ModelFailure>(),
            Some(&ModelFailure::Incomplete)
        );
    }

    #[test]
    fn tool_fragments_are_emitted_only_after_verified_completion() {
        let mut decoder = ChatDecoder::default();
        let mut events = Vec::new();
        for delta in [
            json!({"tool_calls":[{"index":0,"id":"call_","type":"function","function":{"name":"fs_","arguments":"{\"path\":"}}]}),
            json!({"tool_calls":[{"index":0,"id":"1","function":{"name":"stat","arguments":"\"workspace://repo\"}"}}]}),
        ] {
            for byte in format!(
                "data: {}\n\n",
                json!({"choices":[{"index":0,"delta":delta,"finish_reason":null}]})
            )
            .bytes()
            {
                events.extend(decoder.feed(&[byte]).unwrap());
            }
        }
        assert!(events.is_empty());
        assert!(decoder.feed(b"data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n").unwrap().is_empty());
        let events = decoder.feed(b"data: [DONE]\n\n").unwrap();
        let ModelEvent::ToolCall(call) = events.into_iter().next().unwrap() else {
            panic!("missing tool")
        };
        assert_eq!(call.id, "call_1");
        assert_eq!(call.name, "fs_stat");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&call.arguments).unwrap()["path"],
            "workspace://repo"
        );
    }
    #[test]
    fn truncated_or_inconsistent_tool_completions_do_not_release_calls() {
        for reason in ["stop", "length"] {
            let mut decoder = ChatDecoder::default();
            let input = format!(
                "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call","function":{"name":"fs_stat","arguments":"{"}}]}}]}),
                json!({"choices":[{"index":0,"delta":{},"finish_reason":reason}]})
            );
            assert!(decoder.feed(input.as_bytes()).is_err());
            assert!(Decoder::Chat(decoder).finish().is_err());
        }
    }
    #[test]
    fn completed_invalid_arguments_reach_the_tool_rejection_boundary() {
        let mut decoder = ChatDecoder::default();
        let input = format!(
            "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
            json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call","function":{"name":"fs_stat","arguments":"{"}}]}}]}),
            json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]})
        );
        let events = decoder.feed(input.as_bytes()).unwrap();
        assert!(matches!(&events[..], [ModelEvent::ToolCall(call)] if call.arguments == "{"));
        assert!(Decoder::Chat(decoder).finish().is_ok());
    }
    #[test]
    fn chat_sse_accepts_byte_split_utf8_and_crlf() {
        let input = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你好\"},\"finish_reason\":null}]}\r\n\r\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
        let mut decoder = ChatDecoder::default();
        let mut text = String::new();
        for byte in input.bytes() {
            for event in decoder.feed(&[byte]).unwrap() {
                if let ModelEvent::TextDelta(delta) = event {
                    text.push_str(&delta);
                }
            }
        }
        assert_eq!(text, "你好");
        assert!(decoder.done);
    }

    #[test]
    fn responses_sse_emits_text_media_and_usage() {
        let image = STANDARD.encode(b"png");
        let input = format!(
            "data: {{\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}}\n\ndata: {{\"type\":\"response.output_item.done\",\"item\":{{\"type\":\"image_generation_call\",\"result\":\"{image}\"}}}}\n\ndata: {{\"type\":\"response.completed\",\"response\":{{\"status\":\"completed\",\"usage\":{{\"input_tokens\":3,\"output_tokens\":2}}}}}}\n\n"
        );
        let events = ResponsesDecoder::default().feed(input.as_bytes()).unwrap();
        assert!(matches!(&events[0], ModelEvent::TextDelta(v) if v == "hello"));
        assert!(matches!(&events[1], ModelEvent::Binary { data, .. } if data == b"png"));
        assert!(matches!(&events[2], ModelEvent::Usage(v) if v.input_tokens == 3));
    }

    #[test]
    fn responses_never_release_tools_from_incomplete_or_failed_streams() {
        let call = json!({"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_test","name":"fs_write","arguments":"{}"}});
        for end in ["response.failed", "response.incomplete", "error"] {
            let mut decoder = ResponsesDecoder::default();
            assert!(
                decoder
                    .feed(format!("data: {call}\n\n").as_bytes())
                    .unwrap()
                    .is_empty()
            );
            assert!(
                decoder
                    .feed(format!("data: {}\n\n", json!({"type":end})).as_bytes())
                    .is_err()
            );
        }
        let mut decoder = Decoder::Responses(ResponsesDecoder::default());
        assert!(
            decoder
                .feed(format!("data: {call}\n\n").as_bytes())
                .unwrap()
                .is_empty()
        );
        assert!(decoder.finish().is_err());
    }

    #[test]
    fn done_without_finish_is_not_success() {
        assert!(ChatDecoder::default().feed(b"data: [DONE]\n\n").is_err());
    }

    #[test]
    fn clean_eof_releases_validated_tools_once_and_preserves_usage() {
        for done_marker in [true, false] {
            let mut decoder = Decoder::Chat(ChatDecoder::default());
            for event in [
                json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call","function":{"name":"fs_stat","arguments":"{}"}}]}}]}),
                json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}),
            ] {
                assert!(
                    decoder
                        .feed(format!("data: {event}\n\n").as_bytes())
                        .unwrap()
                        .is_empty()
                );
            }
            assert!(!decoder.done());
            let usage = decoder.feed(b"data: {\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2}}\n\n").unwrap();
            assert!(
                matches!(usage.as_slice(), [ModelEvent::Usage(v)] if v.input_tokens == 5 && v.output_tokens == 2)
            );
            let calls = if done_marker {
                decoder.feed(b"data: [DONE]\n\n").unwrap()
            } else {
                decoder.finish().unwrap()
            };
            assert!(
                matches!(calls.as_slice(), [ModelEvent::ToolCall(call)] if call.id == "call" && call.name == "fs_stat" && call.arguments == "{}")
            );
            assert!(decoder.done());
            assert!(decoder.finish().unwrap().is_empty());
        }
    }

    #[test]
    fn clean_eof_rejects_missing_finish_and_partial_sse_after_finish() {
        let finish =
            b"data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n";
        assert!(Decoder::Chat(ChatDecoder::default()).finish().is_err());
        for tail in [
            &b"data: {\"choices\":[],\"usage\":"[..],
            &b"data: {\"error\":{}}\n"[..],
            &b"data: [DONE]\n"[..],
            &b"data: "[..],
        ] {
            let mut decoder = Decoder::Chat(ChatDecoder::default());
            decoder.feed(finish).unwrap();
            decoder.feed(tail).unwrap();
            assert!(decoder.finish().is_err());
            assert!(!decoder.done());
        }
        let mut decoder = Decoder::Chat(ChatDecoder::default());
        decoder.feed(&finish[..finish.len() - 1]).unwrap();
        assert!(decoder.finish().is_err());
    }

    #[test]
    fn clean_eof_does_not_hide_pending_error_after_finish() {
        let mut decoder = Decoder::Chat(ChatDecoder::default());
        let events = decoder.feed(concat!(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"prefix\"},\"finish_reason\":\"stop\"}]}\n\n",
            "data: {\"error\":{\"message\":\"late error\"}}\n\n"
        ).as_bytes()).unwrap();
        assert!(matches!(events.as_slice(), [ModelEvent::TextDelta(text)] if text == "prefix"));
        assert!(
            decoder
                .finish()
                .unwrap_err()
                .to_string()
                .contains("streaming error")
        );
    }

    #[test]
    fn empty_data_lines_cannot_bypass_the_event_budget() {
        let mut frames = SseFrames {
            data_bytes: MAX_SSE_BYTES,
            ..Default::default()
        };
        assert!(
            frames
                .feed(b"data:\n")
                .unwrap_err()
                .to_string()
                .contains("exceeds 24 MiB")
        );
    }
}

#[cfg(test)]
mod tool_call_tests {
    use super::*;

    fn frame(value: Value) -> String {
        format!("data: {value}\n\n")
    }
    fn delta(calls: Value) -> Value {
        json!({"choices":[{"index":0,"delta":{"tool_calls":calls}}]})
    }
    fn fragment(index: u64, id: &str, arguments: &str) -> Value {
        json!({"index":index,"id":id,"function":{"name":"test","arguments":arguments}})
    }

    #[test]
    fn invalid_indices_keep_typed_diagnostics_and_usage_across_frames_and_eof() {
        let secret = "secret-api-key-image-prompt".repeat(1000);
        for (fragment, reason, kind) in [
            (json!({}), "missing", "missing"),
            (json!({"index":null}), "null", "null"),
            (json!({"index":secret}), "wrong_type", "string"),
            (json!({"index":true}), "wrong_type", "boolean"),
            (json!({"index":[]}), "wrong_type", "array"),
            (json!({"index":{}}), "wrong_type", "object"),
            (json!({"index":-1}), "negative", "number"),
            (json!({"index":1.5}), "non_integer", "number"),
            (json!({"index":1.0}), "non_integer", "number"),
            (json!({"index":1e30}), "out_of_range", "number"),
            (json!(secret), "fragment_not_object", "missing"),
            (Value::Null, "fragment_not_object", "missing"),
        ] {
            for prefix in [false, true] {
                for same_chunk in [false, true] {
                    for eof in [false, true] {
                        let mut decoder = Decoder::Chat(ChatDecoder::default());
                        let previous = if prefix {
                            frame(
                                json!({"choices":[{"index":0,"delta":{"content":"partial","tool_calls":[{"index":100,"id":"good","function":{"name":"test","arguments":"{}"}}]}}]}),
                            )
                        } else {
                            String::new()
                        };
                        let mut bad = delta(json!([fragment.clone()]));
                        bad["usage"] = json!({"prompt_tokens":7,"completion_tokens":3});
                        let bad = frame(bad);
                        let mut output = Vec::new();
                        if same_chunk {
                            output.extend(decoder.feed((previous + &bad).as_bytes()).unwrap());
                        } else {
                            output.extend(decoder.feed(previous.as_bytes()).unwrap());
                            output.extend(decoder.feed(bad.as_bytes()).unwrap());
                        }
                        let error = if eof {
                            decoder.finish()
                        } else {
                            decoder.feed(b"data: [DONE]\n\n")
                        }
                        .unwrap_err();
                        assert!(error.downcast_ref::<ToolCallIndexError>().is_some());
                        assert!(!is_network_error(&error));
                        let detail = tool_error_detail(&error).unwrap();
                        assert_eq!(detail["reason"], reason);
                        assert_eq!(detail["indexType"], kind);
                        assert_eq!(detail["eventNumber"], 1 + u64::from(prefix));
                        assert_eq!(detail["callCount"], usize::from(prefix));
                        assert_eq!(detail["path"], "choices[0].delta.tool_calls[0].index");
                        assert!(detail.to_string().len() < 1024);
                        assert!(!format!("{error:?}{detail}").contains("secret-api"));
                        assert_eq!(
                            output
                                .iter()
                                .filter(|e| matches!(e, ModelEvent::Usage(_)))
                                .count(),
                            1
                        );
                        assert!(output.iter().all(|e| !matches!(e, ModelEvent::ToolCall(_))));
                    }
                }
            }
        }
    }

    #[test]
    fn sparse_interleaved_calls_over_sixteen_and_over_64k_keep_identity() {
        let mut decoder = Decoder::Chat(ChatDecoder::default());
        let arguments = json!({"text":"x".repeat(40 * 1024)}).to_string();
        for n in 0..17 {
            let index = if n == 16 { u64::MAX } else { 100 + n };
            let start = frame(delta(json!([fragment(index, &format!("call{n}"), "{")])));
            assert!(decoder.feed(start.as_bytes()).unwrap().is_empty());
        }
        for n in (0..17).rev() {
            let index = if n == 16 { u64::MAX } else { 100 + n };
            let tail = if n < 2 { &arguments[1..] } else { "}" };
            let bytes = frame(delta(
                json!([{"index":index,"function":{"arguments":tail}}]),
            ));
            for chunk in bytes.as_bytes().chunks(509) {
                assert!(decoder.feed(chunk).unwrap().is_empty());
            }
        }
        assert!(
            decoder
                .feed(
                    frame(json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}))
                        .as_bytes()
                )
                .unwrap()
                .is_empty()
        );
        let events = decoder.finish().unwrap();
        assert_eq!(events.len(), 17);
        for (n, event) in events.into_iter().enumerate() {
            let ModelEvent::ToolCall(call) = event else {
                panic!()
            };
            assert_eq!(call.id, format!("call{n}"));
            assert_eq!(call.name, "test");
            assert_eq!(
                call.arguments,
                if n < 2 { arguments.as_str() } else { "{}" }
            );
        }
    }

    #[test]
    fn protocols_share_budget_boundaries_and_responses_do_not_charge_repeated_items() {
        for size in [MAX_TOOL_ARGUMENT_BYTES, MAX_TOOL_ARGUMENT_BYTES + 1] {
            let arguments = json!({"text":"x".repeat(size - 11)}).to_string();
            assert_eq!(arguments.len(), size);
            for max_calls in [0, 1] {
                for max_buffer_bytes in [size + 4, size + 5] {
                    for chat in [false, true] {
                        let limits = ToolCallLimits {
                            max_calls,
                            max_buffer_bytes,
                        };
                        let mut decoder = if chat {
                            Decoder::Chat(ChatDecoder::new(limits))
                        } else {
                            Decoder::Responses(ResponsesDecoder::new(limits))
                        };
                        let item = json!({"type":"function_call","call_id":"c","name":"test","arguments":arguments});
                        let bytes = if chat {
                            frame(delta(json!([fragment(100, "c", &arguments)])))
                                + &frame(
                                    json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}),
                                )
                                + "data: [DONE]\n\n"
                        } else {
                            frame(json!({"type":"response.output_item.done","item":item}))
                                + &frame(
                                    json!({"type":"response.completed","response":{"status":"completed","output":[item]}}),
                                )
                        };
                        let expected = if max_calls == 0 {
                            Some("calls")
                        } else if size > MAX_TOOL_ARGUMENT_BYTES {
                            Some("argument_bytes")
                        } else if max_buffer_bytes < size + 5 {
                            Some("buffer_bytes")
                        } else {
                            None
                        };
                        match (decoder.feed(bytes.as_bytes()), expected) {
                            (Ok(events), None) => assert_eq!(
                                events
                                    .iter()
                                    .filter(|e| matches!(e, ModelEvent::ToolCall(_)))
                                    .count(),
                                1
                            ),
                            (Err(error), Some(kind)) => {
                                assert_eq!(tool_error_detail(&error).unwrap()["budget"], kind);
                                assert!(!is_network_error(&error));
                            }
                            (result, expected) => panic!("{result:?} != {expected:?}"),
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod cache_diagnostic_tests {
    use super::*;
    #[test]
    fn response_ids_are_bounded_and_missing_cache_writes_remain_unknown() {
        let mut details = UsageDetails::default();
        details.observe_response_id(Some(&json!("resp_valid-123")));
        assert_eq!(details.response_id.as_deref(), Some("resp_valid-123"));
        details.observe_response_id(Some(&json!("Bearer secret")));
        assert_eq!(details.response_id.as_deref(), Some("resp_valid-123"));
        details
            .observe(&json!({"input_tokens_details":{"cached_tokens":32,"cache_write_tokens":64}}));
        assert_eq!(details.cache_write, Some(64));
        details.observe(&json!({"input_tokens_details":{"cached_tokens":16}}));
        assert_eq!(details.cache_write, None);
        assert_eq!(details.cached, Some(48));
    }
}
