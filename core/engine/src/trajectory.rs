//! Engine 记录真实执行内容；传输、资源和导出配置由 server 装配。

use super::model::{ContentPart, MediaSource, Message, ModelEvent, ReasoningKind};
use base64::{display::Base64Display, engine::general_purpose::STANDARD};
use serde::{
    Serialize, Serializer,
    ser::{SerializeMap, SerializeSeq},
};
use serde_json::{Value, value::RawValue};
use sha2::{Digest, Sha256};
use std::{
    io::{self, Write},
    sync::{
        Arc, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::Instant,
};
use tracing::Span;

pub(crate) const TARGET: &str = "areal::trajectory";
const BUFFER_OVERHEAD: usize = 512;
const ALLOCATION_OVERHEAD: usize = 64;
static CAPTURE_BUDGET: OnceLock<Arc<Budget>> = OnceLock::new();

/// 在安装全局遥测、开始请求前初始化；Engine 不读取部署环境或传输配置。
pub fn configure_trajectory_capture_budget(limit: usize) {
    let _ = CAPTURE_BUDGET.set(Arc::new(Budget::new(limit)));
}
fn budget() -> Arc<Budget> {
    CAPTURE_BUDGET
        .get_or_init(|| Arc::new(Budget::new(4 * 1024 * 1024)))
        .clone()
}
struct Budget {
    used: AtomicUsize,
    limit: usize,
}
impl Budget {
    fn new(limit: usize) -> Self {
        Self {
            used: AtomicUsize::new(0),
            limit,
        }
    }
    fn claim(&self, bytes: usize) -> bool {
        self.used
            .fetch_update(Ordering::AcqRel, Ordering::Relaxed, |used| {
                used.checked_add(bytes).filter(|n| *n <= self.limit)
            })
            .is_ok()
    }
    fn release(&self, bytes: usize) {
        self.used.fetch_sub(bytes, Ordering::AcqRel);
    }
}
struct Buffer {
    value: Vec<u8>,
    budget: Arc<Budget>,
    held: usize,
}
impl Buffer {
    fn new(budget: Arc<Budget>) -> Option<Self> {
        budget.claim(BUFFER_OVERHEAD).then(|| Self {
            value: Vec::new(),
            budget,
            held: BUFFER_OVERHEAD,
        })
    }
    fn text(&self) -> &str {
        std::str::from_utf8(&self.value).expect("JSON encoder emits UTF-8")
    }
}
impl Write for Buffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let needed = self
            .value
            .len()
            .checked_add(bytes.len())
            .ok_or_else(capacity_error)?;
        if needed > self.value.capacity() {
            let old = self.value.capacity();
            let mut capacity = needed.max(old.saturating_mul(2)).max(256);
            let mut charge = capacity
                .checked_add(ALLOCATION_OVERHEAD)
                .ok_or_else(capacity_error)?;
            // 重分配的瞬时新旧缓冲同时计费；不足时仅尝试精确所需容量，不等待其他请求。
            if !self.budget.claim(charge) {
                capacity = needed.max(256);
                charge = capacity
                    .checked_add(ALLOCATION_OVERHEAD)
                    .ok_or_else(capacity_error)?;
                if !self.budget.claim(charge) {
                    return Err(capacity_error());
                }
            }
            if self
                .value
                .try_reserve_exact(capacity - self.value.len())
                .is_err()
            {
                self.budget.release(charge);
                return Err(capacity_error());
            }
            if old > 0 {
                self.budget.release(old + ALLOCATION_OVERHEAD);
                self.held -= old + ALLOCATION_OVERHEAD;
            }
            self.held += charge;
        }
        self.value.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl Drop for Buffer {
    fn drop(&mut self) {
        self.budget.release(self.held);
    }
}
fn capacity_error() -> io::Error {
    io::Error::other("trajectory capture capacity exceeded")
}

/// 借用已有值进行有界序列化；摘要针对实际记录字节，不复制 Value 树。
pub fn record_json<T: Serialize + ?Sized>(span: &Span, field: &str, value: &T) -> Option<[u8; 32]> {
    capture_json(span, value, budget()).record(span, field)
}
pub(crate) struct CapturedJson {
    output: Option<Buffer>,
    enabled: bool,
}
impl CapturedJson {
    pub(crate) fn record(self, span: &Span, field: &str) -> Option<[u8; 32]> {
        if !self.enabled {
            return None;
        }
        let Some(output) = self.output else {
            span.record("areal.capture.truncated", true);
            return None;
        };
        let digest: [u8; 32] = Sha256::digest(&output.value).into();
        span.record(field, output.text());
        Some(digest)
    }
}
fn capture_json<T: Serialize + ?Sized>(
    span: &Span,
    value: &T,
    budget: Arc<Budget>,
) -> CapturedJson {
    if span.is_disabled() {
        return CapturedJson {
            output: None,
            enabled: false,
        };
    }
    let output = Buffer::new(budget).and_then(|mut output| {
        serde_json::to_writer(&mut output, value).ok()?;
        Some(output)
    });
    CapturedJson {
        output,
        enabled: true,
    }
}
pub(crate) fn record_messages(span: &Span, field: &str, messages: &[Message]) {
    record_json(span, field, &Messages(messages));
}
pub(crate) fn record_text(span: &Span, field: &str, role: &str, text: &str) {
    #[derive(Serialize)]
    struct Part<'a> {
        r#type: &'static str,
        content: &'a str,
    }
    #[derive(Serialize)]
    struct Text<'a> {
        role: &'a str,
        parts: [Part<'a>; 1],
    }
    record_json(
        span,
        field,
        &[Text {
            role,
            parts: [Part {
                r#type: "text",
                content: text,
            }],
        }],
    );
}
pub(crate) fn capture_prompt(span: &Span, items: &[areal_protocol::Item]) -> CapturedJson {
    capture_json(span, &Prompt(items), budget())
}

pub(crate) struct Operation {
    pub span: Span,
    started: Instant,
    event: &'static str,
    finished: bool,
    output: Option<Buffer>,
    has_parts: bool,
    last_text: bool,
    truncated: bool,
    budget: Arc<Budget>,
    usage: areal_protocol::ModelUsage,
}
impl Operation {
    pub fn new(span: Span, event: &'static str) -> Self {
        Self::with_budget(span, event, budget())
    }
    fn with_budget(span: Span, event: &'static str, budget: Arc<Budget>) -> Self {
        Self {
            span,
            started: Instant::now(),
            event,
            finished: false,
            output: None,
            has_parts: false,
            last_text: false,
            truncated: false,
            budget,
            usage: Default::default(),
        }
    }
    pub fn usage(&self) -> &areal_protocol::ModelUsage {
        &self.usage
    }
    pub fn record_usage(&mut self, usage: &areal_protocol::ModelUsage) {
        self.usage.add_assign(usage);
        self.span
            .record("gen_ai.usage.input_tokens", self.usage.input_tokens);
        self.span.record(
            "gen_ai.usage.cache_read.input_tokens",
            self.usage.cached_input_tokens,
        );
        self.span
            .record("gen_ai.usage.output_tokens", self.usage.output_tokens);
    }
    pub fn observe(&mut self, event: &ModelEvent) {
        if let ModelEvent::Usage(usage) = event {
            self.record_usage(usage);
            return;
        }
        if self.span.is_disabled() || self.truncated || matches!(event, ModelEvent::Activity) {
            return;
        }
        if self.output.is_none() {
            self.output = Buffer::new(self.budget.clone());
            if let Some(output) = &mut self.output {
                if output
                    .write_all(b"[{\"role\":\"assistant\",\"parts\":[")
                    .is_err()
                {
                    self.truncate();
                    return;
                }
            } else {
                self.truncate();
                return;
            }
        }
        let output = self.output.as_mut().unwrap();
        let result = if self.last_text && matches!(event, ModelEvent::TextDelta(_)) {
            // 直接追加转义后的片段，不复制已有响应，也不为每个 token 建立 JSON 节点。
            output.value.truncate(output.value.len() - 2);
            let ModelEvent::TextDelta(text) = event else {
                unreachable!()
            };
            let mut serializer =
                serde_json::Serializer::with_formatter(&mut *output, FragmentFormatter);
            text.serialize(&mut serializer)
                .map_err(io::Error::other)
                .and_then(|_| output.write_all(b"\"}"))
        } else {
            let separator = if self.has_parts {
                output.write_all(b",")
            } else {
                Ok(())
            };
            separator.and_then(|_| {
                serde_json::to_writer(&mut *output, &EventPart(event)).map_err(io::Error::other)
            })
        };
        if result.is_err() {
            self.truncate();
            return;
        }
        self.has_parts = true;
        self.last_text = matches!(event, ModelEvent::TextDelta(_));
    }
    fn truncate(&mut self) {
        // 丢弃整字段而不是伪造半截 JSON；已收到业务输出不受影响，后续增量不再分配。
        self.output = None;
        self.truncated = true;
        self.span.record("areal.capture.truncated", true);
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
        if let Some(mut output) = self.output.take() {
            if output.write_all(b"]}]").is_ok() {
                self.span.record("gen_ai.output.messages", output.text());
            } else {
                self.truncate();
            }
        }
        self.span
            .record("areal.model.response.accepted", error.is_none());
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
        self.finish(Some("operation_aborted"));
    }
}
struct FragmentFormatter;
impl serde_json::ser::Formatter for FragmentFormatter {
    fn begin_string<W: ?Sized + Write>(&mut self, _: &mut W) -> io::Result<()> {
        Ok(())
    }
    fn end_string<W: ?Sized + Write>(&mut self, _: &mut W) -> io::Result<()> {
        Ok(())
    }
}
struct Arguments<'a>(&'a str);
impl Serialize for Arguments<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // RawValue 借用原始字节，只校验语法，不展开任意 JSON 树。
        match serde_json::from_str::<&RawValue>(self.0) {
            Ok(raw) => raw.serialize(serializer),
            Err(_) => serializer.serialize_str(self.0),
        }
    }
}
struct Base64<'a>(&'a [u8]);
impl Serialize for Base64<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(&Base64Display::new(self.0, &STANDARD))
    }
}
struct EventPart<'a>(&'a ModelEvent);
impl Serialize for EventPart<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        match self.0 {
            ModelEvent::TextDelta(text) => {
                map.serialize_entry("type", "text")?;
                map.serialize_entry("content", text)?;
            }
            ModelEvent::ReasoningDelta {
                item_id,
                kind,
                index,
                delta,
            } => {
                #[derive(Serialize)]
                struct Source<'a> {
                    id: &'a str,
                    kind: &'static str,
                    index: usize,
                }
                map.serialize_entry("type", "reasoning")?;
                map.serialize_entry(
                    "source",
                    &Source {
                        id: item_id,
                        kind: if *kind == ReasoningKind::Summary {
                            "summary"
                        } else {
                            "text"
                        },
                        index: *index,
                    },
                )?;
                map.serialize_entry("content", delta)?;
            }
            ModelEvent::ToolCall(call) => {
                map.serialize_entry("type", "tool_call")?;
                map.serialize_entry("id", &call.id)?;
                map.serialize_entry("name", &call.name)?;
                map.serialize_entry("arguments", &Arguments(&call.arguments))?;
            }
            ModelEvent::ProviderContext(value) => {
                map.serialize_entry("type", "provider_context")?;
                map.serialize_entry("content", value)?;
            }
            ModelEvent::Binary {
                modality,
                mime_type,
                data,
            } => {
                map.serialize_entry("type", "blob")?;
                map.serialize_entry("modality", modality)?;
                map.serialize_entry("mime_type", mime_type)?;
                map.serialize_entry("content", &Base64(data))?;
            }
            ModelEvent::Activity | ModelEvent::Usage(_) => unreachable!(),
        }
        map.end()
    }
}
struct Messages<'a>(&'a [Message]);
impl Serialize for Messages<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(Some(self.0.len()))?;
        for message in self.0 {
            seq.serialize_element(&MessageRef(message))?;
        }
        seq.end()
    }
}
struct MessageRef<'a>(&'a Message);
impl Serialize for MessageRef<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("role", &self.0.role)?;
        map.serialize_entry("parts", &Parts(self.0))?;
        map.end()
    }
}
struct Parts<'a>(&'a Message);
impl Serialize for Parts<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let message = self.0;
        let mut seq = serializer.serialize_seq(None)?;
        if let Some(id) = &message.tool_call_id {
            #[derive(Serialize)]
            struct Response<'a> {
                r#type: &'static str,
                id: &'a str,
                response: Contents<'a>,
            }
            seq.serialize_element(&Response {
                r#type: "tool_call_response",
                id,
                response: Contents(&message.content),
            })?;
        } else {
            for part in &message.content {
                seq.serialize_element(&Content(part))?;
            }
        }
        for call in &message.tool_calls {
            seq.serialize_element(&HistoryCall(call))?;
        }
        if let Some(context) = &message.provider_context {
            #[derive(Serialize)]
            struct Context<'a> {
                r#type: &'static str,
                content: &'a Value,
            }
            seq.serialize_element(&Context {
                r#type: "provider_context",
                content: context,
            })?;
        }
        seq.end()
    }
}
struct Contents<'a>(&'a [ContentPart]);
impl Serialize for Contents<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(Some(self.0.len()))?;
        for part in self.0 {
            seq.serialize_element(&Content(part))?;
        }
        seq.end()
    }
}
struct HistoryCall<'a>(&'a Value);
impl Serialize for HistoryCall<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(4))?;
        map.serialize_entry("type", "tool_call")?;
        map.serialize_entry("id", &self.0["id"])?;
        map.serialize_entry("name", &self.0["function"]["name"])?;
        let args = &self.0["function"]["arguments"];
        if let Some(raw) = args.as_str() {
            map.serialize_entry("arguments", &Arguments(raw))?;
        } else {
            map.serialize_entry("arguments", args)?;
        }
        map.end()
    }
}
struct Content<'a>(&'a ContentPart);
impl Serialize for Content<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self.0 {
            ContentPart::Text(text) => BorrowedContent::Text(text).serialize(serializer),
            ContentPart::Image { source, detail } => {
                media(source, "image", *detail, None, None).serialize(serializer)
            }
            ContentPart::Audio { source } => {
                media(source, "audio", None, None, None).serialize(serializer)
            }
            ContentPart::File {
                source,
                name,
                mime_type,
            } => media(source, "file", None, name.as_deref(), mime_type.as_deref())
                .serialize(serializer),
        }
    }
}
fn media<'a>(
    source: &'a MediaSource,
    modality: &'static str,
    detail: Option<areal_protocol::ImageDetail>,
    name: Option<&'a str>,
    mime: Option<&'a str>,
) -> BorrowedContent<'a> {
    let (source, local) = match source {
        MediaSource::Url(s) => (s.as_str(), false),
        MediaSource::LocalPath(s) => (s.as_str(), true),
    };
    BorrowedContent::Media {
        source,
        local,
        modality,
        detail,
        name,
        mime,
    }
}
enum BorrowedContent<'a> {
    Text(&'a str),
    Media {
        source: &'a str,
        local: bool,
        modality: &'static str,
        detail: Option<areal_protocol::ImageDetail>,
        name: Option<&'a str>,
        mime: Option<&'a str>,
    },
}
impl Serialize for BorrowedContent<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        let Self::Media {
            source,
            local,
            modality,
            detail,
            name,
            mime,
        } = self
        else {
            let Self::Text(text) = self else {
                unreachable!()
            };
            map.serialize_entry("type", "text")?;
            map.serialize_entry("content", text)?;
            return map.end();
        };
        map.serialize_entry("modality", modality)?;
        if let Some(detail) = detail {
            map.serialize_entry("detail", detail)?;
        }
        if let Some(name) = name {
            map.serialize_entry("name", name)?;
        }
        let data = (!local)
            .then(|| {
                source
                    .strip_prefix("data:")
                    .and_then(|s| s.split_once(";base64,"))
            })
            .flatten();
        if let Some((header, content)) = data {
            map.serialize_entry("type", "blob")?;
            map.serialize_entry("mime_type", header)?;
            map.serialize_entry("content", content)?;
        } else {
            if let Some(mime) = mime {
                map.serialize_entry("mime_type", mime)?;
            }
            map.serialize_entry("type", if *local { "file" } else { "uri" })?;
            map.serialize_entry(if *local { "file_id" } else { "uri" }, source)?;
        }
        map.end()
    }
}
struct Prompt<'a>(&'a [areal_protocol::Item]);
impl Serialize for Prompt<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct User<'a> {
            role: &'static str,
            parts: Inputs<'a>,
        }
        let mut seq = serializer.serialize_seq(None)?;
        for item in self.0 {
            if let areal_protocol::Item::UserMessage { content, .. } = item {
                seq.serialize_element(&User {
                    role: "user",
                    parts: Inputs(content),
                })?;
            }
        }
        seq.end()
    }
}
struct Inputs<'a>(&'a [areal_protocol::Input]);
impl Serialize for Inputs<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use areal_protocol::Input;
        let mut seq = serializer.serialize_seq(Some(self.0.len()))?;
        for input in self.0 {
            let part = match input {
                Input::Text { text, .. } => BorrowedContent::Text(text),
                Input::Image { url, detail } => BorrowedContent::Media {
                    source: url,
                    local: false,
                    modality: "image",
                    detail: *detail,
                    name: None,
                    mime: None,
                },
                Input::LocalImage { path, detail } => BorrowedContent::Media {
                    source: path,
                    local: true,
                    modality: "image",
                    detail: *detail,
                    name: None,
                    mime: None,
                },
                Input::Audio { url } => BorrowedContent::Media {
                    source: url,
                    local: false,
                    modality: "audio",
                    detail: None,
                    name: None,
                    mime: None,
                },
                Input::LocalAudio { path } => BorrowedContent::Media {
                    source: path,
                    local: true,
                    modality: "audio",
                    detail: None,
                    name: None,
                    mime: None,
                },
                Input::File {
                    url,
                    name,
                    mime_type,
                } => BorrowedContent::Media {
                    source: url,
                    local: false,
                    modality: "file",
                    detail: None,
                    name: name.as_deref(),
                    mime: mime_type.as_deref(),
                },
            };
            seq.serialize_element(&part)?;
        }
        seq.end()
    }
}

#[cfg(test)]
pub(crate) fn messages(messages: &[Message]) -> String {
    serde_json::to_string(&Messages(messages)).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

#[cfg(test)]
pub(crate) mod test_support {
    use std::{
        collections::BTreeMap,
        sync::{Arc, Mutex},
    };
    use tracing::{
        Subscriber,
        field::{Field, Visit},
        span::{Attributes, Id, Record},
    };
    use tracing_subscriber::{Layer, layer::Context, registry::LookupSpan};
    #[derive(Default)]
    struct Fields(BTreeMap<String, String>);
    impl Visit for Fields {
        fn record_str(&mut self, field: &Field, value: &str) {
            self.0.insert(field.name().into(), value.into());
        }
        fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
            self.record_str(field, &format!("{value:?}"));
        }
    }
    #[derive(Clone, Default)]
    pub(crate) struct Capture(pub Arc<Mutex<Vec<BTreeMap<String, String>>>>);
    impl<S: Subscriber + for<'a> LookupSpan<'a>> Layer<S> for Capture {
        fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
            let mut fields = Fields::default();
            attrs.record(&mut fields);
            ctx.span(id).unwrap().extensions_mut().insert(fields);
        }
        fn on_record(&self, id: &Id, values: &Record<'_>, ctx: Context<'_, S>) {
            values.record(
                ctx.span(id)
                    .unwrap()
                    .extensions_mut()
                    .get_mut::<Fields>()
                    .unwrap(),
            );
        }
        fn on_event(&self, event: &tracing::Event<'_>, ctx: Context<'_, S>) {
            if event.metadata().target() != super::TARGET {
                return;
            }
            let mut fields = Fields::default();
            if let Some(scope) = ctx.event_scope(event) {
                for span in scope.from_root() {
                    if let Some(parent) = span.extensions().get::<Fields>() {
                        fields.0.extend(parent.0.clone());
                    }
                }
            }
            event.record(&mut fields);
            self.0.lock().unwrap().push(fields.0);
        }
    }
    pub(crate) fn span() -> tracing::Span {
        tracing::info_span!(target: super::TARGET, "capture-fixture",
            gen_ai.input.messages = tracing::field::Empty,
            gen_ai.output.messages = tracing::field::Empty,
            areal.capture.truncated = tracing::field::Empty,
            areal.model.response.accepted = tracing::field::Empty,
            gen_ai.usage.input_tokens = tracing::field::Empty,
            gen_ai.usage.cache_read.input_tokens = tracing::field::Empty,
            gen_ai.usage.output_tokens = tracing::field::Empty,
            otel.status_code = tracing::field::Empty,
            error.type = tracing::field::Empty)
    }
}

#[cfg(test)]
mod capture_budget_tests {
    use super::test_support::{Capture, span};
    use super::*;
    use tracing_subscriber::prelude::*;

    #[test]
    fn unending_summary_and_parallel_operations_share_a_released_budget() {
        let capture = Capture::default();
        let _subscriber =
            tracing::subscriber::set_default(tracing_subscriber::registry().with(capture.clone()));
        let budget = Arc::new(Budget::new(4096));
        let mut operations: Vec<_> = (0..8)
            .map(|_| Operation::with_budget(span(), "summary", budget.clone()))
            .collect();
        let delta = ModelEvent::TextDelta("有界 capture \"\n".repeat(16));
        for _ in 0..10000 {
            for operation in &mut operations {
                operation.observe(&delta);
            }
            assert!(budget.used.load(Ordering::Acquire) <= budget.limit);
        }
        assert!(operations.iter().all(|o| o.truncated && o.output.is_none()));
        assert_eq!(budget.used.load(Ordering::Acquire), 0);
        let usage = areal_protocol::ModelUsage {
            input_tokens: 7,
            cached_input_tokens: 2,
            output_tokens: 3,
        };
        for operation in &mut operations {
            operation.observe(&ModelEvent::Usage(usage.clone()));
        }
        drop(operations);
        assert_eq!(budget.used.load(Ordering::Acquire), 0);
        let events = capture.0.lock().unwrap();
        assert_eq!(events.len(), 8);
        for event in events.iter() {
            assert_eq!(event["areal.capture.truncated"], "true");
            assert_eq!(event["gen_ai.usage.input_tokens"], "7");
            assert_eq!(event["gen_ai.usage.output_tokens"], "3");
            assert_eq!(event["areal.model.response.accepted"], "false");
            assert!(!event.contains_key("gen_ai.output.messages"));
        }
    }

    #[test]
    fn streamed_escaping_preserves_text_and_non_text_part_order() {
        let capture = Capture::default();
        let _subscriber =
            tracing::subscriber::set_default(tracing_subscriber::registry().with(capture.clone()));
        let budget = Arc::new(Budget::new(16 * 1024));
        let mut operation = Operation::with_budget(span(), "details", budget.clone());
        let fragments = ["引号\"", "\\反斜杠\n", "\t\u{0000}🍎"];
        for fragment in fragments {
            operation.observe(&ModelEvent::TextDelta(fragment.into()));
        }
        operation.observe(&ModelEvent::ReasoningDelta {
            item_id: "r".into(),
            kind: ReasoningKind::Summary,
            index: 0,
            delta: "reason".into(),
        });
        operation.observe(&ModelEvent::ToolCall(super::super::model::ToolCall {
            id: "call".into(),
            name: "read".into(),
            arguments: "[1,{\"x\":true}]".into(),
        }));
        operation.observe(&ModelEvent::ProviderContext(
            serde_json::json!({"opaque": [1,2]}),
        ));
        operation.observe(&ModelEvent::Binary {
            modality: areal_protocol::Modality::Image,
            mime_type: "image/png".into(),
            data: vec![0, 1, 2, 255],
        });
        operation.observe(&ModelEvent::TextDelta("end".into()));
        operation.finish(None);
        assert_eq!(budget.used.load(Ordering::Acquire), 0);
        let events = capture.0.lock().unwrap();
        let output: Value = serde_json::from_str(&events[0]["gen_ai.output.messages"]).unwrap();
        let parts = &output[0]["parts"];
        assert_eq!(parts[0]["content"], fragments.concat());
        assert_eq!(parts[1]["source"]["kind"], "summary");
        assert_eq!(parts[2]["arguments"], serde_json::json!([1, {"x": true}]));
        assert_eq!(parts[3]["content"]["opaque"], serde_json::json!([1, 2]));
        assert_eq!(parts[4]["content"], "AAEC/w==");
        assert_eq!(parts[5]["content"], "end");
        assert_eq!(events[0]["areal.model.response.accepted"], "true");
    }

    #[test]
    fn input_provider_tree_and_large_blob_fail_before_unbounded_capture() {
        let capture = Capture::default();
        let _subscriber =
            tracing::subscriber::set_default(tracing_subscriber::registry().with(capture));
        let budget = Arc::new(Budget::new(2048));
        let large = "x".repeat(1024 * 1024);
        let input = vec![Message::text("user", &large)];
        let request =
            serde_json::json!({"messages":[{"content":large}],"tools":[{"type":"function"}]});
        assert!(
            capture_json(&span(), &Messages(&input), budget.clone())
                .output
                .is_none()
        );
        assert!(
            capture_json(&span(), &request, budget.clone())
                .output
                .is_none()
        );
        let mut operation = Operation::with_budget(span(), "details", budget.clone());
        operation.observe(&ModelEvent::Binary {
            modality: areal_protocol::Modality::Image,
            mime_type: "image/png".into(),
            data: vec![0; 1024 * 1024],
        });
        assert!(operation.truncated);
        assert_eq!(budget.used.load(Ordering::Acquire), 0);
        let small = serde_json::json!({"small":1});
        let serialized = capture_json(&span(), &small, budget.clone());
        assert!(
            serialized.output.is_some(),
            "failed requests must release reservations"
        );
        drop(serialized);
        assert_eq!(budget.used.load(Ordering::Acquire), 0);
    }

    #[test]
    fn disabled_capture_never_visits_the_source_or_allocates_output() {
        struct MustNotSerialize;
        impl Serialize for MustNotSerialize {
            fn serialize<S: Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
                panic!("disabled capture must be free of serialization")
            }
        }
        let budget = Arc::new(Budget::new(4096));
        let span = Span::none();
        assert!(
            capture_json(&span, &MustNotSerialize, budget.clone())
                .record(&span, "gen_ai.input.messages")
                .is_none()
        );
        let mut operation = Operation::with_budget(span, "details", budget.clone());
        operation.observe(&ModelEvent::TextDelta("x".repeat(10000)));
        assert!(operation.output.is_none());
        assert_eq!(budget.used.load(Ordering::Acquire), 0);
    }

    #[test]
    fn borrowed_prompt_matches_model_input_projection_without_clones() {
        let inputs = vec![
            areal_protocol::Input::text("original"),
            areal_protocol::Input::Image {
                url: "data:image/png;base64,AAEC".into(),
                detail: None,
            },
            areal_protocol::Input::File {
                url: "data:application/pdf;base64,eA==".into(),
                name: Some("f.pdf".into()),
                mime_type: Some("overridden".into()),
            },
            areal_protocol::Input::LocalAudio {
                path: "/tmp/audio.wav".into(),
            },
        ];
        let mut message = Message::text("user", "");
        message.content = inputs
            .iter()
            .map(super::super::model::content_from_input)
            .collect();
        let items = vec![areal_protocol::Item::UserMessage {
            id: "input".into(),
            content: inputs,
        }];
        assert_eq!(
            serde_json::to_value(Prompt(&items)).unwrap(),
            serde_json::to_value(Messages(&[message])).unwrap()
        );
    }
}
