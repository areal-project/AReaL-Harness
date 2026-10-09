//! 将 Engine 轨迹事件桥接为关联 Trace/Span 的标准 OTLP LogRecord。

use opentelemetry::{
    logs::{AnyValue, LogRecord, Logger, Severity},
    trace::TraceContextExt,
};
use opentelemetry_sdk::logs::SdkLogger;
use std::{
    collections::BTreeMap,
    fmt,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::SystemTime,
};
use tracing::{
    Event, Subscriber,
    field::{Field, Visit},
    span::{Attributes, Id, Record},
};
use tracing_opentelemetry::get_otel_context;
use tracing_subscriber::{Layer, layer::Context, registry::LookupSpan};

struct Budget {
    used: AtomicUsize,
    limit: usize,
}

// 继承字段可能同时被多个事件使用；SDK 记录的临时副本也必须占用共享额度。
struct RecordReservation {
    budget: Option<Arc<Budget>>,
    bytes: usize,
}
impl RecordReservation {
    fn reserve(&mut self, bytes: usize) -> bool {
        if let Some(budget) = &self.budget {
            if !budget.reserve(bytes) {
                return false;
            }
            self.bytes += bytes;
        }
        true
    }
}
impl Drop for RecordReservation {
    fn drop(&mut self) {
        if let Some(budget) = &self.budget {
            budget.used.fetch_sub(self.bytes, Ordering::Relaxed);
        }
    }
}
impl Budget {
    fn reserve(&self, bytes: usize) -> bool {
        self.used
            .fetch_update(Ordering::AcqRel, Ordering::Relaxed, |used| {
                used.checked_add(bytes).filter(|used| *used <= self.limit)
            })
            .is_ok()
    }
}

// 在每块格式化输出分配前取得额度；失败会丢弃整字段，避免输出不完整的 JSON。
struct BudgetedString {
    value: String,
    budget: Arc<Budget>,
    bytes: usize,
    failed: bool,
}
impl BudgetedString {
    fn new(budget: Arc<Budget>, overhead: usize) -> Option<Self> {
        budget.reserve(overhead).then(|| Self {
            value: String::new(),
            budget,
            bytes: overhead,
            failed: false,
        })
    }

    fn into_field(mut self) -> FieldValue {
        FieldValue {
            value: AnyValue::String(std::mem::take(&mut self.value).into()),
            budget: Some(self.budget.clone()),
            bytes: std::mem::take(&mut self.bytes),
        }
    }
}
impl fmt::Write for BudgetedString {
    fn write_str(&mut self, value: &str) -> fmt::Result {
        if self.failed || !self.budget.reserve(value.len()) {
            self.failed = true;
            return Err(fmt::Error);
        }
        self.bytes += value.len();
        if self.value.try_reserve_exact(value.len()).is_err() {
            self.failed = true;
            return Err(fmt::Error);
        }
        self.value.push_str(value);
        Ok(())
    }
}
impl Drop for BudgetedString {
    fn drop(&mut self) {
        self.budget.used.fetch_sub(self.bytes, Ordering::Relaxed);
    }
}

struct FieldValue {
    value: AnyValue,
    budget: Option<Arc<Budget>>,
    bytes: usize,
}
impl Drop for FieldValue {
    fn drop(&mut self) {
        if let Some(budget) = &self.budget {
            budget.used.fetch_sub(self.bytes, Ordering::Relaxed);
        }
    }
}
#[derive(Clone, Default)]
struct Fields<const CHANNEL: u8> {
    values: BTreeMap<String, Arc<FieldValue>>,
    budget: Option<Arc<Budget>>,
    truncated: bool,
}
impl<const CHANNEL: u8> Fields<CHANNEL> {
    fn insert(&mut self, key: &str, value: impl FnOnce() -> AnyValue, bytes: usize) {
        self.values.remove(key);
        if let Some(budget) = &self.budget
            && !budget.reserve(bytes)
        {
            self.truncated = true;
            return;
        }
        self.values.insert(
            key.into(),
            Arc::new(FieldValue {
                value: value(),
                budget: self.budget.clone(),
                bytes,
            }),
        );
    }
}
impl<const CHANNEL: u8> Visit for Fields<CHANNEL> {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.insert(
            field.name(),
            || AnyValue::String(value.to_owned().into()),
            value
                .len()
                .saturating_add(field.name().len())
                .saturating_add(128),
        );
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.insert(field.name(), || AnyValue::Int(value), 128);
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        if let Ok(value) = i64::try_from(value) {
            self.record_i64(field, value);
        }
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        self.insert(field.name(), || AnyValue::Double(value), 128);
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.insert(field.name(), || AnyValue::Boolean(value), 128);
    }
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        let Some(budget) = self.budget.clone().filter(|_| CHANNEL != 0) else {
            self.record_str(field, &format!("{value:?}"));
            return;
        };
        self.values.remove(field.name());
        let Some(mut output) = BudgetedString::new(budget, field.name().len().saturating_add(128))
        else {
            self.truncated = true;
            return;
        };
        if fmt::write(&mut output, format_args!("{value:?}")).is_err() || output.failed {
            self.truncated = true;
            return;
        }
        self.values
            .insert(field.name().into(), Arc::new(output.into_field()));
    }
}

struct LocalContext<const CHANNEL: u8>(opentelemetry::trace::SpanContext);

pub(super) struct EventLayer<const CHANNEL: u8> {
    logger: Option<SdkLogger>,
    budget: Option<Arc<Budget>>,
    dispatch: OnceLock<tracing::dispatcher::WeakDispatch>,
}

impl<const CHANNEL: u8> EventLayer<CHANNEL> {
    pub fn new(logger: Option<SdkLogger>) -> Self {
        Self {
            logger,
            budget: None,
            dispatch: OnceLock::new(),
        }
    }
    pub fn with_capture_limit(mut self, limit: Option<usize>) -> Self {
        self.budget = limit.map(|limit| {
            Arc::new(Budget {
                used: AtomicUsize::new(0),
                limit,
            })
        });
        self
    }
}

impl<S: Subscriber + for<'a> LookupSpan<'a>, const CHANNEL: u8> Layer<S> for EventLayer<CHANNEL> {
    fn on_register_dispatch(&self, dispatch: &tracing::Dispatch) {
        // 事件回调中不能递归读取当前 tracing dispatcher；弱引用也避免订阅器循环持有。
        let _ = self.dispatch.set(dispatch.downgrade());
    }

    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        if attrs.metadata().target() != "areal::trajectory" {
            return;
        }
        let mut fields = Fields::<CHANNEL> {
            budget: self.budget.clone(),
            ..Fields::default()
        };
        attrs.record(&mut fields);
        if let Some(span) = ctx.span(id) {
            use opentelemetry::trace::{SpanContext, SpanId, TraceFlags, TraceId, TraceState};
            let trace_id = span
                .parent()
                .and_then(|p| {
                    p.extensions()
                        .get::<LocalContext<CHANNEL>>()
                        .map(|c| c.0.trace_id())
                })
                .unwrap_or_else(|| TraceId::from_bytes(*uuid::Uuid::new_v4().as_bytes()));
            let span_id =
                SpanId::from_bytes(uuid::Uuid::new_v4().as_bytes()[..8].try_into().unwrap());
            span.extensions_mut()
                .insert(LocalContext::<CHANNEL>(SpanContext::new(
                    trace_id,
                    span_id,
                    TraceFlags::SAMPLED,
                    false,
                    TraceState::default(),
                )));
            span.extensions_mut().insert(fields);
        }
    }

    fn on_record(&self, id: &Id, values: &Record<'_>, ctx: Context<'_, S>) {
        if let Some(span) = ctx.span(id)
            && let Some(fields) = span.extensions_mut().get_mut::<Fields<CHANNEL>>()
        {
            values.record(fields);
        }
    }

    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        if event.metadata().target() != "areal::trajectory" {
            return;
        }
        let mut fields = Fields::<CHANNEL> {
            budget: self.budget.clone(),
            ..Fields::default()
        };
        if let Some(scope) = ctx.event_scope(event) {
            for span in scope.from_root() {
                if let Some(parent) = span.extensions().get::<Fields<CHANNEL>>() {
                    fields.values.extend(parent.values.clone());
                    fields.truncated |= parent.truncated;
                }
            }
        }
        event.record(&mut fields);
        let Some(span) = ctx.event_span(event) else {
            return;
        };
        let exported = self
            .dispatch
            .get()
            .and_then(|weak| weak.upgrade())
            .and_then(|dispatch| get_otel_context(&span.id(), &dispatch))
            .map(|ctx| ctx.span().span_context().clone())
            .filter(|sc| sc.is_valid());
        let local = span
            .extensions()
            .get::<LocalContext<CHANNEL>>()
            .map(|c| c.0.clone());
        let Some(sc) = exported.or(local) else {
            return;
        };
        let Some(logger) = &self.logger else {
            return;
        };
        let mut record = logger.create_log_record();
        if let Some(AnyValue::String(name)) = fields.values.get("event.name").map(|v| &v.value) {
            // SDK 要求静态事件名，使用 Engine 定义的有限事件集合。
            let name = match name.as_str() {
                "gen_ai.client.inference.operation.details" => {
                    "gen_ai.client.inference.operation.details"
                }
                "areal.user_prompt" => "areal.user_prompt",
                "areal.turn.completed" => "areal.turn.completed",
                "areal.tool.call" => "areal.tool.call",
                "areal.tool.result" => "areal.tool.result",
                "areal.context.compacted" => "areal.context.compacted",
                _ => return,
            };
            record.set_event_name(name);
        }
        record.set_timestamp(SystemTime::now());
        record.set_severity_number(Severity::Info);
        record.set_trace_context(sc.trace_id(), sc.span_id(), Some(sc.trace_flags()));
        let mut reservation = RecordReservation {
            budget: self.budget.clone(),
            bytes: 0,
        };
        let mut truncated = fields.truncated;
        record.add_attributes(
            fields
                .values
                .into_iter()
                .filter(|(k, _)| !k.starts_with("otel.") && k != "message")
                .filter_map(|(key, held)| {
                    if !reservation.reserve(held.bytes) {
                        truncated = true;
                        return None;
                    }
                    let value = held.value.clone();
                    // 旧 OTLP 保持原投影；持久通道交给取得预算的后台线程解析 JSON。
                    let value = match (CHANNEL, key.as_str(), &value) {
                        (
                            0,
                            "gen_ai.input.messages"
                            | "gen_ai.output.messages"
                            | "gen_ai.tool.call.arguments"
                            | "gen_ai.tool.call.result",
                            AnyValue::String(text),
                        ) => serde_json::from_str(text.as_str())
                            .map(json_value)
                            .unwrap_or(value),
                        _ => value,
                    };
                    Some((key, value))
                }),
        );
        if truncated {
            record.add_attribute("areal.capture.truncated", true);
        }
        logger.emit(record);
    }
}

// OTLP LogRecord 支持嵌套属性；SDK 没有 Null 变体时保留 JSON 字面量。
fn json_value(value: serde_json::Value) -> AnyValue {
    use serde_json::Value;
    match value {
        Value::Null => AnyValue::String("null".into()),
        Value::Bool(value) => AnyValue::Boolean(value),
        Value::String(value) => AnyValue::String(value.into()),
        Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                AnyValue::Int(value)
            } else if value.is_f64() {
                AnyValue::Double(value.as_f64().unwrap())
            } else {
                AnyValue::String(value.to_string().into())
            }
        }
        Value::Array(values) => values.into_iter().map(json_value).collect(),
        Value::Object(values) => values
            .into_iter()
            .map(|(key, value)| (key, json_value(value)))
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry::{logs::LoggerProvider as _, trace::TracerProvider as _};
    use opentelemetry_sdk::{
        logs::{InMemoryLogExporter, SdkLoggerProvider},
        trace::{InMemorySpanExporter, SdkTracerProvider},
    };
    use tracing_subscriber::{filter::filter_fn, layer::SubscriberExt};

    #[test]
    fn events_preserve_content_and_correlate_with_spans_even_without_trace_export() {
        for export_traces in [true, false] {
            let logs = InMemoryLogExporter::default();
            let logger = SdkLoggerProvider::builder()
                .with_simple_exporter(logs.clone())
                .build();
            let traces = InMemorySpanExporter::default();
            let mut builder = SdkTracerProvider::builder();
            if export_traces {
                builder = builder.with_simple_exporter(traces.clone());
            }
            let provider = builder.build();
            let subscriber = tracing_subscriber::registry()
                .with(
                    tracing_opentelemetry::layer()
                        .with_tracer(provider.tracer("test"))
                        .with_filter(filter_fn(|metadata| {
                            metadata.is_span() && metadata.target() == "areal::trajectory"
                        })),
                )
                .with(EventLayer::<0>::new(Some(logger.logger("test"))));
            let input =
                r#"[{"role":"user","parts":[{"type":"text","content":"原始输入 token=abc"}]}]"#;
            let output = r#"[{"role":"assistant","parts":[{"type":"text","content":"原始输出"}]}]"#;
            tracing::subscriber::with_default(subscriber, || {
                let root = tracing::info_span!(target: "areal::trajectory", "invoke_agent", gen_ai.conversation.id = "session");
                let _root = root.enter();
                let span = tracing::info_span!(target: "areal::trajectory", "chat",
                    gen_ai.input.messages = input,
                    gen_ai.output.messages = tracing::field::Empty,
                    gen_ai.usage.input_tokens = tracing::field::Empty);
                let _entered = span.enter();
                span.record("gen_ai.output.messages", output);
                span.record("gen_ai.usage.input_tokens", 42u64);
                tracing::event!(target: "areal::trajectory", tracing::Level::INFO, { "event.name" = "gen_ai.client.inference.operation.details" });
                tracing::warn!("unrelated diagnostic");
            });
            provider.force_flush().unwrap();
            logger.force_flush().unwrap();
            let records = logs.get_emitted_logs().unwrap();
            assert_eq!(records.len(), 1);
            let record = &records[0].record;
            assert_eq!(
                record.event_name(),
                Some("gen_ai.client.inference.operation.details")
            );
            let attrs: BTreeMap<_, _> = record
                .attributes_iter()
                .map(|(key, value)| (key.as_str(), value.clone()))
                .collect();
            assert_eq!(
                attrs["gen_ai.input.messages"],
                json_value(serde_json::from_str(input).unwrap())
            );
            assert_eq!(
                attrs["gen_ai.output.messages"],
                json_value(serde_json::from_str(output).unwrap())
            );
            assert_eq!(
                attrs["gen_ai.conversation.id"],
                AnyValue::String("session".into())
            );
            assert_eq!(attrs["gen_ai.usage.input_tokens"], AnyValue::Int(42));
            let context = record.trace_context().unwrap();
            assert_ne!(context.trace_id, opentelemetry::TraceId::INVALID);
            assert_ne!(context.span_id, opentelemetry::SpanId::INVALID);
            let spans = traces.get_finished_spans().unwrap();
            if export_traces {
                let chat = spans.iter().find(|s| s.name == "chat").unwrap();
                let root = spans.iter().find(|s| s.name == "invoke_agent").unwrap();
                assert_eq!(chat.parent_span_id, root.span_context.span_id());
                assert_eq!(context.trace_id, chat.span_context.trace_id());
                assert_eq!(context.span_id, chat.span_context.span_id());
            } else {
                assert!(spans.is_empty());
            }
            logger.shutdown().unwrap();
            provider.shutdown().unwrap();
        }
    }
}

#[cfg(test)]
mod isolation_tests {
    use super::*;
    use opentelemetry::logs::LoggerProvider as _;
    use opentelemetry_sdk::logs::{InMemoryLogExporter, SdkLoggerProvider};
    use std::fmt::Write as _;
    use tracing_subscriber::layer::SubscriberExt;

    #[test]
    fn concurrent_record_copies_share_the_field_budget() {
        let budget = Arc::new(Budget {
            used: AtomicUsize::new(300),
            limit: 1024,
        });
        let mut first = RecordReservation {
            budget: Some(budget.clone()),
            bytes: 0,
        };
        let mut second = RecordReservation {
            budget: Some(budget.clone()),
            bytes: 0,
        };
        assert!(first.reserve(600));
        assert!(!second.reserve(600));
        assert_eq!(budget.used.load(Ordering::Relaxed), 900);
        drop(first);
        assert!(second.reserve(600));
        drop(second);
        assert_eq!(budget.used.load(Ordering::Relaxed), 300);
    }

    #[test]
    fn bounded_formatter_rejects_oversize_chunk_before_allocating() {
        let budget = Arc::new(Budget {
            used: AtomicUsize::new(0),
            limit: 1024,
        });
        let mut output = BudgetedString::new(budget.clone(), 128).unwrap();
        assert!(output.write_str(&"x".repeat(1024 * 1024)).is_err());
        assert!(output.value.is_empty());
        assert_eq!(output.value.capacity(), 0);
        assert!(output.write_str("small").is_err());
        assert_eq!(budget.used.load(Ordering::Relaxed), 128);
        drop(output);
        assert_eq!(budget.used.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn bounded_formatter_transfers_reservation_to_field() {
        let budget = Arc::new(Budget {
            used: AtomicUsize::new(0),
            limit: 1024,
        });
        let mut output = BudgetedString::new(budget.clone(), 128).unwrap();
        output.write_str("保留").unwrap();
        let field = output.into_field();
        assert_eq!(field.value, AnyValue::String("保留".into()));
        assert_eq!(budget.used.load(Ordering::Relaxed), 128 + "保留".len());
        drop(field);
        assert_eq!(budget.used.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn bounded_collection_stops_large_display_and_keeps_event() {
        struct LargeDisplay<'a>(&'a AtomicUsize);
        impl fmt::Display for LargeDisplay<'_> {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                for _ in 0..1_000_000 {
                    self.0.fetch_add(1, Ordering::Relaxed);
                    // 正常 Display 会传播写入错误；采集器不承诺中断任意自分配的实现。
                    f.write_str(&"x".repeat(512))?;
                }
                Ok(())
            }
        }
        let logs = InMemoryLogExporter::default();
        let provider = SdkLoggerProvider::builder()
            .with_simple_exporter(logs.clone())
            .build();
        let layer =
            EventLayer::<1>::new(Some(provider.logger("bounded"))).with_capture_limit(Some(1024));
        let budget = layer.budget.clone().unwrap();
        let subscriber = tracing_subscriber::registry().with(layer);
        let writes = AtomicUsize::new(0);
        tracing::subscriber::with_default(subscriber, || {
            let root =
                tracing::info_span!(target:"areal::trajectory","invoke_agent",areal.turn.id="turn");
            let _root = root.enter();
            let request = tracing::info_span!(target:"areal::trajectory","chat",gen_ai.input.messages=%LargeDisplay(&writes));
            let _request = request.enter();
            tracing::event!(target:"areal::trajectory",tracing::Level::INFO,{"event.name"="gen_ai.client.inference.operation.details"});
        });
        assert!((1..=2).contains(&writes.load(Ordering::Relaxed)));
        assert_eq!(budget.used.load(Ordering::Relaxed), 0);
        let records = logs.get_emitted_logs().unwrap();
        assert_eq!(records.len(), 1);
        let attrs: BTreeMap<_, _> = records[0]
            .record
            .attributes_iter()
            .map(|(key, value)| (key.as_str(), value.clone()))
            .collect();
        assert_eq!(attrs["areal.capture.truncated"], AnyValue::Boolean(true));
        assert!(!attrs.contains_key("gen_ai.input.messages"));
        assert_eq!(attrs["areal.turn.id"], AnyValue::String("turn".into()));
        assert!(records[0].record.trace_context().is_some());
        provider.shutdown().unwrap();
    }

    #[test]
    fn durable_collection_leaves_json_projection_to_background() {
        let legacy = InMemoryLogExporter::default();
        let durable = InMemoryLogExporter::default();
        let a = SdkLoggerProvider::builder()
            .with_simple_exporter(legacy.clone())
            .build();
        let b = SdkLoggerProvider::builder()
            .with_simple_exporter(durable.clone())
            .build();
        let subscriber = tracing_subscriber::registry()
            .with(EventLayer::<0>::new(Some(a.logger("legacy"))))
            .with(EventLayer::<1>::new(Some(b.logger("bounded"))).with_capture_limit(Some(4096)));
        let input = r#"[{"role":"user","parts":[{"type":"text","content":"原始内容"}]}]"#;
        tracing::subscriber::with_default(subscriber, || {
            let root =
                tracing::info_span!(target:"areal::trajectory","invoke_agent",areal.turn.id="turn");
            let _root = root.enter();
            let request =
                tracing::info_span!(target:"areal::trajectory","chat",gen_ai.input.messages=%input);
            let _request = request.enter();
            tracing::event!(target:"areal::trajectory",tracing::Level::INFO,{"event.name"="gen_ai.client.inference.operation.details"});
        });
        for (exporter, expected) in [
            (&legacy, json_value(serde_json::from_str(input).unwrap())),
            (&durable, AnyValue::String(input.into())),
        ] {
            let records = exporter.get_emitted_logs().unwrap();
            assert_eq!(records.len(), 1);
            assert!(records[0].record.attributes_iter().any(|(key, value)| {
                key.as_str() == "gen_ai.input.messages" && *value == expected
            }));
            assert!(
                !records[0]
                    .record
                    .attributes_iter()
                    .any(|(key, _)| { key.as_str() == "areal.capture.truncated" })
            );
        }
        a.shutdown().unwrap();
        b.shutdown().unwrap();
    }

    #[test]
    fn bounded_collection_does_not_change_existing_otlp_content() {
        let legacy = InMemoryLogExporter::default();
        let limited = InMemoryLogExporter::default();
        let a = SdkLoggerProvider::builder()
            .with_simple_exporter(legacy.clone())
            .build();
        let b = SdkLoggerProvider::builder()
            .with_simple_exporter(limited.clone())
            .build();
        let subscriber = tracing_subscriber::registry()
            .with(EventLayer::<0>::new(Some(a.logger("legacy"))))
            .with(EventLayer::<1>::new(Some(b.logger("bounded"))).with_capture_limit(Some(1024)));
        let input = format!(
            r#"[{{"role":"user","parts":[{{"type":"text","content":"{}"}}]}}]"#,
            "x".repeat(8192)
        );
        tracing::subscriber::with_default(subscriber, || {
            let root =
                tracing::info_span!(target:"areal::trajectory","invoke_agent",areal.turn.id="turn");
            let _root = root.enter();
            let request =
                tracing::info_span!(target:"areal::trajectory","chat",gen_ai.input.messages=%input);
            let _request = request.enter();
            tracing::event!(target:"areal::trajectory",tracing::Level::INFO,{"event.name"="gen_ai.client.inference.operation.details"});
        });
        let old = legacy.get_emitted_logs().unwrap();
        let new = limited.get_emitted_logs().unwrap();
        assert_eq!(old.len(), 1);
        assert_eq!(new.len(), 1);
        assert!(
            old[0]
                .record
                .attributes_iter()
                .any(|(k, v)| k.as_str() == "gen_ai.input.messages"
                    && *v == json_value(serde_json::from_str(&input).unwrap()))
        );
        assert!(
            new[0]
                .record
                .attributes_iter()
                .any(|(k, v)| k.as_str() == "areal.capture.truncated"
                    && *v == AnyValue::Boolean(true))
        );
        assert!(
            !new[0]
                .record
                .attributes_iter()
                .any(|(k, _)| k.as_str() == "gen_ai.input.messages")
        );
        assert!(new[0].record.trace_context().is_some());
    }
}
