//! Engine 记录真实执行内容；传输、资源和导出配置由 server 装配。

use super::model::{ContentPart, MediaSource, Message, ModelEvent, ReasoningKind};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::time::Instant;
use tracing::Span;

pub(crate) const TARGET: &str = "areal::trajectory";

pub(crate) struct Operation {
    pub span: Span,
    started: Instant,
    event: &'static str,
    finished: bool,
    output: Vec<Value>,
}

impl Operation {
    pub fn new(span: Span, event: &'static str) -> Self {
        Self {
            span,
            started: Instant::now(),
            event,
            finished: false,
            output: Vec::new(),
        }
    }

    pub fn observe(&mut self, event: &ModelEvent) {
        if self.span.is_disabled() {
            return;
        }
        match event {
            ModelEvent::TextDelta(text) => self.append_text("text", None, text),
            ModelEvent::ReasoningDelta { item_id, kind, index, delta } => {
                let kind = if *kind == ReasoningKind::Summary { "summary" } else { "text" };
                self.append_text("reasoning", Some(json!({"id": item_id, "kind": kind, "index": index})), delta);
            }
            ModelEvent::ToolCall(call) => self.output.push(json!({
                "type": "tool_call", "id": call.id, "name": call.name,
                "arguments": json_arguments(&call.arguments),
                "arguments_json": call.arguments,
            })),
            ModelEvent::ProviderContext(value) => self.output.push(json!({"type": "provider_context", "content": value})),
            ModelEvent::Binary { modality, mime_type, data } => self.output.push(json!({
                "type": "blob", "modality": modality, "mime_type": mime_type, "content": STANDARD.encode(data)
            })),
            ModelEvent::Activity | ModelEvent::Usage(_) => {}
        }
    }

    fn append_text(&mut self, kind: &str, source: Option<Value>, text: &str) {
        // 流式文本合并后只在结算时序列化，避免每个 token 复制整段响应。
        if let Some(part) = self.output.last_mut()
            && part["type"] == kind
            && part.get("source") == source.as_ref()
            && let Some(Value::String(content)) = part.get_mut("content")
        {
            content.push_str(text);
            return;
        }
        let mut part = json!({"type": kind, "content": text});
        if let Some(source) = source {
            part["source"] = source;
        }
        self.output.push(part);
    }

    pub fn finish(&mut self, error: Option<&'static str>) {
        if self.finished {
            return;
        }
        self.finished = true;
        self.span.record(
            "areal.duration_ms",
            self.started.elapsed().as_secs_f64() * 1000.0,
        );
        if !self.output.is_empty() {
            self.span.record(
                "gen_ai.output.messages",
                json!([{"role": "assistant", "parts": self.output}]).to_string(),
            );
        }
        if let Some(error) = error {
            self.span.record("otel.status_code", "ERROR");
            self.span.record("error.type", error);
        }
        self.span.in_scope(|| {
            tracing::event!(target: TARGET, tracing::Level::INFO, { "event.name" = self.event });
        });
    }
}

impl Drop for Operation {
    fn drop(&mut self) {
        // Future 被取消或提前返回时也保留已收到的输出，并标记不完整调用。
        self.finish(Some("operation_aborted"));
    }
}

fn json_arguments(arguments: &str) -> Value {
    serde_json::from_str(arguments).unwrap_or_else(|_| Value::String(arguments.into()))
}

fn media(source: &MediaSource, modality: &str) -> Value {
    match source {
        MediaSource::Url(url) => {
            if let Some((header, content)) = url
                .strip_prefix("data:")
                .and_then(|s| s.split_once(";base64,"))
            {
                json!({"type": "blob", "modality": modality, "mime_type": header, "content": content})
            } else {
                json!({"type": "uri", "modality": modality, "uri": url})
            }
        }
        MediaSource::LocalPath(path) => {
            // 保留 Engine 接收的本地引用；遥测不额外读取模型输入之外的文件。
            json!({"type": "file", "modality": modality, "file_id": path})
        }
    }
}

pub(crate) fn messages(messages: &[Message]) -> String {
    Value::Array(messages.iter().map(|message| {
        let mut parts: Vec<Value> = message.content.iter().map(|part| match part {
            ContentPart::Text(text) => json!({"type": "text", "content": text}),
            ContentPart::Image { source, detail } => {
                let mut part = media(source, "image");
                if let Some(detail) = detail { part["detail"] = json!(detail); }
                part
            }
            ContentPart::Audio { source } => media(source, "audio"),
            ContentPart::File { source, name, mime_type } => {
                let mut part = media(source, "file");
                if let Some(name) = name { part["name"] = json!(name); }
                if let Some(mime_type) = mime_type { part["mime_type"] = json!(mime_type); }
                part
            }
        }).collect();
        if let Some(id) = &message.tool_call_id {
            parts = vec![json!({"type": "tool_call_response", "id": id, "response": parts})];
        }
        parts.extend(message.tool_calls.iter().map(|call| json!({
            "type": "tool_call", "id": call["id"], "name": call["function"]["name"],
            "arguments": call["function"]["arguments"].as_str().map(json_arguments).unwrap_or_else(|| call["function"]["arguments"].clone())
        })));
        if let Some(context) = &message.provider_context {
            parts.push(json!({"type": "provider_context", "content": context}));
        }
        json!({"role": message.role, "parts": parts})
    }).collect()).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inputs_keep_text_arguments_media_and_provider_context() {
        let mut message = Message::text("assistant", "原始文本 password=actual-value");
        message.content.push(ContentPart::Image {
            source: MediaSource::Url("https://example.org/image?token=original".into()),
            detail: None,
        });
        message.tool_calls.push(json!({"id": "call-1", "function": {"name": "read", "arguments": "{\"path\":\"/original/path\"}"}}));
        message.provider_context = Some(json!({"opaque": "original-context"}));
        let value: Value = serde_json::from_str(&messages(&[message])).unwrap();
        let parts = &value[0]["parts"];
        assert_eq!(parts[0]["content"], "原始文本 password=actual-value");
        assert_eq!(parts[1]["uri"], "https://example.org/image?token=original");
        assert_eq!(parts[2]["arguments"]["path"], "/original/path");
        assert_eq!(parts[3]["content"]["opaque"], "original-context");
    }

    #[test]
    fn dropped_request_keeps_partial_output_and_marks_error() {
        use std::{
            collections::BTreeMap,
            sync::{Arc, Mutex},
        };
        use tracing::{
            Subscriber,
            field::{Field, Visit},
            span::{Id, Record},
        };
        use tracing_subscriber::{Layer, layer::Context, prelude::*};

        #[derive(Clone, Default)]
        struct Capture(Arc<Mutex<BTreeMap<String, String>>>);
        impl Visit for Capture {
            fn record_str(&mut self, field: &Field, value: &str) {
                self.0
                    .lock()
                    .unwrap()
                    .insert(field.name().into(), value.into());
            }
            fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
                self.record_str(field, &format!("{value:?}"));
            }
        }
        impl<S: Subscriber> Layer<S> for Capture {
            fn on_record(&self, _: &Id, values: &Record<'_>, _: Context<'_, S>) {
                values.record(&mut self.clone());
            }
        }
        let capture = Capture::default();
        tracing::subscriber::with_default(
            tracing_subscriber::registry().with(capture.clone()),
            || {
                let span = tracing::info_span!(target: TARGET, "chat",
                gen_ai.output.messages = tracing::field::Empty,
                areal.duration_ms = tracing::field::Empty,
                otel.status_code = tracing::field::Empty,
                error.type = tracing::field::Empty);
                let mut operation =
                    Operation::new(span, "gen_ai.client.inference.operation.details");
                operation.observe(&ModelEvent::TextDelta("原始 partial ".into()));
                operation.observe(&ModelEvent::TextDelta("token=unchanged".into()));
                operation.observe(&ModelEvent::ToolCall(super::super::model::ToolCall {
                    id: "call-1".into(),
                    name: "read_file".into(),
                    arguments: r#"{"path":"/actual/path"}"#.into(),
                }));
                operation.observe(&ModelEvent::Binary {
                    modality: areal_protocol::Modality::Image,
                    mime_type: "image/png".into(),
                    data: vec![0, 1, 2],
                });
                // 取消 Future 和提前返回都会通过 Drop 结算已收到的内容。
                drop(operation);
            },
        );
        let fields = capture.0.lock().unwrap();
        assert_eq!(fields["otel.status_code"], "ERROR");
        assert_eq!(fields["error.type"], "operation_aborted");
        let output: Value = serde_json::from_str(&fields["gen_ai.output.messages"]).unwrap();
        assert_eq!(
            output[0]["parts"][0]["content"],
            "原始 partial token=unchanged"
        );
        assert_eq!(output[0]["parts"][1]["arguments"]["path"], "/actual/path");
        assert_eq!(output[0]["parts"][2]["content"], "AAEC");
    }
}
