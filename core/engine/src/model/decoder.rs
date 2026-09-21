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
    pub(super) fn feed(&mut self, bytes: &[u8]) -> Result<Vec<ModelEvent>> {
        match self {
            Self::Chat(decoder) => decoder.feed(bytes),
            Self::Responses(decoder) => decoder.feed(bytes),
        }
    }
    pub(super) fn finish(&mut self) -> Result<Vec<ModelEvent>> {
        if let Self::Chat(decoder) = self
            && let Some(error) = decoder.pending_error.take()
        {
            return Err(error);
        }
        if self.done() {
            return Ok(Vec::new());
        }
        if let Self::Chat(decoder) = self {
            if decoder.truncated {
                return Err(ModelFailure::Truncated.into());
            }
            // Called only on clean HTTP EOF, never on a transport error. A
            // finish reason is sufficient without [DONE], but a partial SSE
            // event (including a trailing usage/error event) is not success.
            if !decoder.frames.bytes.is_empty() || !decoder.frames.data.is_empty() {
                return Err(ModelFailure::Incomplete.into());
            }
            return decoder.complete();
        }
        Err(ModelFailure::Incomplete.into())
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
    pub(super) stop_reason: Option<String>,
    pub(super) truncated: bool,
    pub(super) content_bytes: usize,
    frames: SseFrames,
    finished: bool,
    done: bool,
    pending_error: Option<anyhow::Error>,
    calls: std::collections::BTreeMap<u64, ToolCall>,
    pub(super) tool_bytes: usize,
    pub(super) reasoning: String,
}

impl ChatDecoder {
    fn complete(&mut self) -> Result<Vec<ModelEvent>> {
        // A length finish is a failed inference even after clean HTTP EOF.
        // Hold partial calls while accepting the provider's trailing usage.
        if self.truncated {
            return Err(ModelFailure::Truncated.into());
        }
        if !self.finished {
            return Err(ModelFailure::Incomplete.into());
        }
        let mut output = Vec::new();
        if !self.reasoning.is_empty() {
            output.push(ModelEvent::ProviderContext(json!({
                "type": "chat_reasoning", "reasoning_content": std::mem::take(&mut self.reasoning)
            })));
        }
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
            let result = self.decode_event(&data).map_err(|error| {
                if self.truncated {
                    anyhow::Error::new(ModelFailure::Truncated)
                } else {
                    error
                }
            });
            match result {
                Ok(events) => output.extend(events),
                Err(error) if output.is_empty() => return Err(error),
                Err(error) => {
                    self.pending_error = Some(error);
                    break;
                }
            }
        }
        Ok(output)
    }

    fn decode_event(&mut self, data: &str) -> Result<Vec<ModelEvent>> {
        if data == "[DONE]" {
            return self.complete();
        }
        let event: Value = serde_json::from_str(data).context("invalid SSE JSON")?;
        if let Some(error) = event.get("error").filter(|v| !v.is_null()) {
            return Err(StreamError::from_value(error, "error").into());
        }
        let mut output = Vec::new();
        if let Some(usage) = parse_usage(event.get("usage")) {
            output.push(ModelEvent::Usage(usage));
        }
        for choice in event["choices"]
            .as_array()
            .context("missing stream choices")?
        {
            if choice["index"].as_u64() != Some(0) {
                bail!("unexpected model choice index");
            }
            let delta = &choice["delta"];
            if let Some(reasoning) = delta["reasoning_content"].as_str() {
                anyhow::ensure!(!self.finished, "reasoning after completion");
                anyhow::ensure!(
                    self.reasoning.len() + reasoning.len() <= 1024 * 1024,
                    "reasoning exceeds 1 MiB"
                );
                self.reasoning.push_str(reasoning);
            }
            if let Some(calls) = delta.get("tool_calls").filter(|v| !v.is_null()) {
                anyhow::ensure!(!self.finished, "tool data after completion");
                for fragment in calls.as_array().context("invalid tool_calls")? {
                    let index = fragment["index"].as_u64().context("missing tool index")?;
                    anyhow::ensure!(index < 16, "too many tool calls in one completion");
                    let call = self.calls.entry(index).or_insert_with(|| ToolCall {
                        id: String::new(),
                        name: String::new(),
                        arguments: String::new(),
                    });
                    if let Some(kind) = fragment["type"].as_str() {
                        anyhow::ensure!(kind == "function", "unsupported tool type");
                    }
                    for (field, value) in [
                        (&mut call.id, &fragment["id"]),
                        (&mut call.name, &fragment["function"]["name"]),
                        (&mut call.arguments, &fragment["function"]["arguments"]),
                    ] {
                        if value.is_null() {
                            continue;
                        }
                        let text = value.as_str().context("tool fragment must be a string")?;
                        self.tool_bytes += text.len();
                        anyhow::ensure!(
                            self.tool_bytes <= 64 * 1024,
                            "tool arguments exceed 64 KiB"
                        );
                        field.push_str(text);
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
                    return Ok(output);
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
        Ok(output)
    }
}

#[derive(Default)]
pub(super) struct ResponsesDecoder {
    frames: SseFrames,
    audio: String,
    finished: bool,
    done: bool,
    contexts: Vec<Value>,
    calls: Vec<ToolCall>,
    item_ids: std::collections::HashSet<String>,
}

impl ResponsesDecoder {
    fn record_item(&mut self, item: &Value) -> Result<()> {
        match item["type"].as_str() {
            Some("reasoning") => {
                let id = item["id"].as_str().context("reasoning item missing ID")?;
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
                let call = ToolCall {
                    id: item["call_id"].as_str().context("missing call ID")?.into(),
                    name: item["name"]
                        .as_str()
                        .context("missing function name")?
                        .into(),
                    arguments: item["arguments"]
                        .as_str()
                        .context("missing function arguments")?
                        .into(),
                };
                anyhow::ensure!(
                    !call.id.is_empty() && call.id.len() <= 256 && call.id.is_ascii(),
                    "invalid call ID"
                );
                anyhow::ensure!(
                    !call.name.is_empty() && call.name.len() <= 128 && call.name.is_ascii(),
                    "invalid function name"
                );
                anyhow::ensure!(
                    call.arguments.len() <= 64 * 1024
                        && serde_json::from_str::<Value>(&call.arguments)?.is_object(),
                    "invalid function arguments"
                );
                if let Some(existing) = self.calls.iter().find(|existing| existing.id == call.id) {
                    anyhow::ensure!(existing == &call, "conflicting function call replay");
                } else {
                    anyhow::ensure!(self.calls.len() < 16, "too many function calls");
                    self.calls.push(call);
                }
            }
            Some("computer_call" | "custom_tool_call") => bail!("unsupported Responses tool type"),
            _ => {}
        }
        Ok(())
    }

    fn feed(&mut self, bytes: &[u8]) -> Result<Vec<ModelEvent>> {
        let mut output = Vec::new();
        for data in self.frames.feed(bytes)? {
            if data == "[DONE]" {
                self.done = self.finished;
                if !self.done {
                    return Err(ModelFailure::Incomplete.into());
                }
                break;
            }
            let event: Value = serde_json::from_str(&data).context("invalid Responses SSE JSON")?;
            match event["type"].as_str().unwrap_or_default() {
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
                    self.record_item(item)?;
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
                    if event["response"]["status"] != "completed" {
                        bail!("Responses request did not complete successfully");
                    }
                    if let Some(items) = event["response"]["output"].as_array() {
                        for item in items {
                            self.record_item(item)?;
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
                    if let Some(usage) = parse_usage(event["response"].get("usage")) {
                        output.push(ModelEvent::Usage(usage));
                    }
                    self.finished = true;
                    self.done = true;
                }
                "response.failed" | "response.incomplete" | "error" => {
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
                    return Err(StreamError::from_value(value, kind).into());
                }
                _ => {}
            }
        }
        Ok(output)
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
        assert!(events.iter().any(|e| matches!(e, ModelEvent::ProviderContext(value) if value["reasoning_content"] == "inspect then test")));
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
