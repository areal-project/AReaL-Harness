//! 在后台将 JSON 字符串投影为 OTLP 值；解析器和输出共享有界预算。

use opentelemetry_proto::tonic::{
    collector::logs::v1::ExportLogsServiceRequest,
    common::v1::{AnyValue, ArrayValue, KeyValue, KeyValueList, any_value::Value},
};
use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use std::{fmt, mem::size_of};

const MAX_DEPTH: usize = 32;
const MAX_NODES: usize = 65_536;
const ALLOCATION_OVERHEAD: usize = 64;
const PARSER_OVERHEAD: usize = 2048;
const TRUNCATED: &str = "areal.capture.truncated";

/// `limit` 约束新增 JSON 树和解析 scratch 的估算空间，所有日志/属性共用。
/// 原始 request 已由调用者计费；每条日志至多追加一个截断标记，其属性数组扩容
/// 也须由调用者随原始 request 预留。即使 limit 为零，仍会记录预算耗尽。
pub(super) fn project(request: &mut ExportLogsServiceRequest, limit: usize) {
    let mut budget = Budget::new(limit);
    for resource in &mut request.resource_logs {
        for scope in &mut resource.scope_logs {
            for record in &mut scope.log_records {
                let mut truncated = false;
                for attr in &mut record.attributes {
                    if !matches!(
                        attr.key.as_str(),
                        "gen_ai.input.messages"
                            | "gen_ai.output.messages"
                            | "gen_ai.tool.call.arguments"
                            | "gen_ai.tool.call.result"
                    ) {
                        continue;
                    }
                    let Some(Value::StringValue(raw)) =
                        attr.value.as_ref().and_then(|v| v.value.as_ref())
                    else {
                        continue;
                    };
                    match parse(raw, &mut budget) {
                        Projection::Value(value) => attr.value = Some(value),
                        Projection::Truncated => truncated = true,
                        Projection::Invalid => {}
                    }
                }
                if truncated {
                    mark_truncated(&mut record.attributes);
                }
            }
        }
    }
}

fn mark_truncated(attributes: &mut Vec<KeyValue>) {
    if let Some(attr) = attributes.iter_mut().find(|attr| attr.key == TRUNCATED) {
        attr.value = Some(any(Value::BoolValue(true)));
    } else {
        // 避免默认 push 的几何扩容；调用者预留至多 len + 1 个 KeyValue 的新数组。
        attributes.reserve_exact(1);
        attributes.push(KeyValue {
            key: TRUNCATED.into(),
            value: Some(any(Value::BoolValue(true))),
            ..Default::default()
        });
    }
}

struct Budget {
    remaining: usize,
    nodes: usize,
    exhausted: bool,
}

impl Budget {
    fn new(limit: usize) -> Self {
        Self {
            remaining: limit,
            nodes: MAX_NODES,
            exhausted: false,
        }
    }

    fn reject<T, E: de::Error>(&mut self) -> Result<T, E> {
        self.exhausted = true;
        Err(E::custom("JSON projection budget exceeded"))
    }

    fn claim<E: de::Error>(&mut self, bytes: usize) -> Result<(), E> {
        let Some(remaining) = self.remaining.checked_sub(bytes) else {
            return self.reject();
        };
        self.remaining = remaining;
        Ok(())
    }

    fn node<E: de::Error>(&mut self, depth: usize) -> Result<(), E> {
        if depth > MAX_DEPTH || self.nodes == 0 {
            return self.reject();
        }
        self.nodes -= 1;
        self.claim(size_of::<AnyValue>() + ALLOCATION_OVERHEAD)
    }

    fn string<E: de::Error>(&mut self, value: &str) -> Result<String, E> {
        self.claim(value.len().saturating_add(ALLOCATION_OVERHEAD))?;
        let mut result = String::new();
        if result.try_reserve_exact(value.len()).is_err() {
            return self.reject();
        }
        result.push_str(value);
        Ok(result)
    }

    fn grow<T, E: de::Error>(&mut self, values: &mut Vec<T>) -> Result<(), E> {
        if values.len() < values.capacity() {
            return Ok(());
        }
        let Some(capacity) = values.capacity().max(2).checked_mul(2) else {
            return self.reject();
        };
        let Some(bytes) = capacity
            .checked_mul(size_of::<T>())
            .and_then(|n| n.checked_add(ALLOCATION_OVERHEAD))
        else {
            return self.reject();
        };
        // 重分配期间新旧数组可能并存，完整计费新容量而非只计差值，不退还旧计费。
        self.claim(bytes)?;
        if values.try_reserve_exact(capacity - values.len()).is_err() {
            return self.reject();
        }
        Ok(())
    }
}

enum Projection {
    Value(AnyValue),
    Invalid,
    Truncated,
}

fn parse(raw: &str, budget: &mut Budget) -> Projection {
    budget.exhausted = false;
    // serde_json 在调用字符串 Visitor 前会解码转义到 scratch。预扫描不分配内存，
    // 只为最大转义字符串计费；无转义字符串直接借用原文。几何扩容期间新旧数组
    // 并存的峰值不超过三倍原文字节，必须在进入反序列化前预留。解析结束后释放
    // scratch 计费；已构建/尝试构建的节点不退还预算，避免非法字段反复扩张。
    let Some(scratch) = escaped_string_bound(raw)
        .checked_mul(3)
        .and_then(|n| n.checked_add(PARSER_OVERHEAD))
    else {
        return Projection::Truncated;
    };
    if budget.claim::<serde_json::Error>(scratch).is_err() {
        return Projection::Truncated;
    }
    let result = {
        let mut deserializer = serde_json::Deserializer::from_str(raw);
        ValueSeed { budget, depth: 0 }
            .deserialize(&mut deserializer)
            .and_then(|value| {
                deserializer.end()?;
                Ok(value)
            })
    };
    budget.remaining += scratch;
    match result {
        Ok(value) => Projection::Value(value),
        Err(_) if budget.exhausted => Projection::Truncated,
        Err(_) => Projection::Invalid,
    }
}

fn escaped_string_bound(raw: &str) -> usize {
    let bytes = raw.as_bytes();
    let mut start = None;
    let mut escaped = false;
    let mut largest = 0;
    let mut i = 0;
    while i < bytes.len() {
        match (start, bytes[i]) {
            (None, b'"') => {
                start = Some(i + 1);
                escaped = false;
            }
            (Some(_), b'\\') => {
                escaped = true;
                i += 1;
            }
            (Some(begin), b'"') => {
                if escaped {
                    largest = largest.max(i - begin);
                }
                start = None;
            }
            _ => {}
        }
        i += 1;
    }
    if let Some(begin) = start
        && escaped
    {
        largest = largest.max(bytes.len() - begin);
    }
    largest
}

fn any(value: Value) -> AnyValue {
    AnyValue { value: Some(value) }
}

struct ValueSeed<'a> {
    budget: &'a mut Budget,
    depth: usize,
}

impl<'de> DeserializeSeed<'de> for ValueSeed<'_> {
    type Value = AnyValue;

    fn deserialize<D: de::Deserializer<'de>>(self, deserializer: D) -> Result<AnyValue, D::Error> {
        self.budget.node(self.depth)?;
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for ValueSeed<'_> {
    type Value = AnyValue;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a bounded JSON value")
    }

    fn visit_unit<E: de::Error>(self) -> Result<AnyValue, E> {
        Ok(AnyValue { value: None })
    }

    fn visit_bool<E: de::Error>(self, value: bool) -> Result<AnyValue, E> {
        Ok(any(Value::BoolValue(value)))
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<AnyValue, E> {
        Ok(any(Value::IntValue(value)))
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<AnyValue, E> {
        // OTLP 没有 unsigned 整数；不能转 double 丢精度或擅自改变 JSON 值类型。
        i64::try_from(value)
            .map(|value| any(Value::IntValue(value)))
            .map_err(|_| E::custom("JSON integer exceeds OTLP int64"))
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<AnyValue, E> {
        if !value.is_finite() {
            return Err(E::custom("non-finite JSON number"));
        }
        Ok(any(Value::DoubleValue(value)))
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<AnyValue, E> {
        self.budget
            .string(value)
            .map(|s| any(Value::StringValue(s)))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<AnyValue, A::Error> {
        let mut values = Vec::new();
        while let Some(value) = seq.next_element_seed(ValueSeed {
            budget: self.budget,
            depth: self.depth + 1,
        })? {
            self.budget.grow(&mut values)?;
            values.push(value);
        }
        Ok(any(Value::ArrayValue(ArrayValue { values })))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<AnyValue, A::Error> {
        let mut values = Vec::new();
        while let Some(key) = map.next_key_seed(KeySeed(self.budget))? {
            let value = map.next_value_seed(ValueSeed {
                budget: self.budget,
                depth: self.depth + 1,
            })?;
            self.budget.grow(&mut values)?;
            values.push(KeyValue {
                key,
                value: Some(value),
                ..Default::default()
            });
        }
        // OTLP 要求对象键唯一。原地排序无额外堆分配，避免逐键线性查找导致平方开销。
        values.sort_unstable_by(|a, b| a.key.cmp(&b.key));
        if values.windows(2).any(|pair| pair[0].key == pair[1].key) {
            return Err(de::Error::custom("duplicate JSON object key"));
        }
        Ok(any(Value::KvlistValue(KeyValueList { values })))
    }
}

struct KeySeed<'a>(&'a mut Budget);

impl<'de> DeserializeSeed<'de> for KeySeed<'_> {
    type Value = String;

    fn deserialize<D: de::Deserializer<'de>>(self, deserializer: D) -> Result<String, D::Error> {
        self.0.node(0)?;
        deserializer.deserialize_str(self)
    }
}

impl Visitor<'_> for KeySeed<'_> {
    type Value = String;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a bounded JSON object key")
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<String, E> {
        self.0.string(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry_proto::tonic::logs::v1::{LogRecord, ResourceLogs, ScopeLogs};

    fn request(raw: &str) -> ExportLogsServiceRequest {
        ExportLogsServiceRequest {
            resource_logs: vec![ResourceLogs {
                scope_logs: vec![ScopeLogs {
                    log_records: vec![LogRecord {
                        attributes: vec![KeyValue {
                            key: "gen_ai.input.messages".into(),
                            value: Some(any(Value::StringValue(raw.into()))),
                            ..Default::default()
                        }],
                        ..Default::default()
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            }],
        }
    }

    fn attrs(request: &ExportLogsServiceRequest) -> &[KeyValue] {
        &request.resource_logs[0].scope_logs[0].log_records[0].attributes
    }

    fn truncated(request: &ExportLogsServiceRequest) -> bool {
        attrs(request)
            .iter()
            .any(|attr| attr.key == TRUNCATED && attr.value == Some(any(Value::BoolValue(true))))
    }

    fn preserved(request: &ExportLogsServiceRequest, raw: &str) {
        assert_eq!(
            attrs(request)[0].value,
            Some(any(Value::StringValue(raw.into())))
        );
        assert!(truncated(request));
    }

    #[test]
    fn nested_values_use_standard_otlp_types() {
        let mut r = request(r#"[{"role":"user","content":["a\nb",true,null,42,-3,1.25]}]"#);
        project(&mut r, 64 * 1024);
        let Some(Value::ArrayValue(array)) = attrs(&r)[0].value.as_ref().unwrap().value.as_ref()
        else {
            panic!("JSON array was not projected");
        };
        let Some(Value::KvlistValue(object)) = &array.values[0].value else {
            panic!("JSON object was not projected");
        };
        assert_eq!(object.values[0].key, "content");
        let Some(Value::ArrayValue(content)) = &object.values[0].value.as_ref().unwrap().value
        else {
            panic!("nested array was not projected");
        };
        assert_eq!(
            content.values,
            vec![
                any(Value::StringValue("a\nb".into())),
                any(Value::BoolValue(true)),
                AnyValue { value: None },
                any(Value::IntValue(42)),
                any(Value::IntValue(-3)),
                any(Value::DoubleValue(1.25)),
            ]
        );
        assert!(!truncated(&r));
    }

    #[test]
    fn many_small_nodes_cannot_bypass_byte_or_node_budgets() {
        let raw = format!("[{}]", vec!["0"; 1000].join(","));
        let mut small = request(&raw);
        project(&mut small, 16 * 1024);
        preserved(&small, &raw);

        let raw = format!("[{}]", vec!["0"; MAX_NODES].join(","));
        let mut many = request(&raw);
        project(&mut many, 64 * 1024 * 1024);
        preserved(&many, &raw);
    }

    #[test]
    fn depth_32_is_allowed_and_deeper_input_stays_a_string() {
        let raw = format!("{}0{}", "[".repeat(MAX_DEPTH), "]".repeat(MAX_DEPTH));
        let mut allowed = request(&raw);
        project(&mut allowed, 64 * 1024);
        assert!(matches!(
            attrs(&allowed)[0].value.as_ref().unwrap().value,
            Some(Value::ArrayValue(_))
        ));
        let raw = format!(
            "{}0{}",
            "[".repeat(MAX_DEPTH + 1),
            "]".repeat(MAX_DEPTH + 1)
        );
        let mut denied = request(&raw);
        project(&mut denied, 64 * 1024);
        preserved(&denied, &raw);
    }

    #[test]
    fn large_escaped_strings_are_rejected_before_parser_scratch_allocation() {
        let raw = format!("\"{}\"", "\\u0041".repeat(100_000));
        let mut budget = Budget::new(16 * 1024);
        assert!(matches!(parse(&raw, &mut budget), Projection::Truncated));
        assert_eq!(budget.nodes, MAX_NODES);
        assert_eq!(budget.remaining, 16 * 1024);
        let mut r = request(&raw);
        project(&mut r, 16 * 1024);
        preserved(&r, &raw);
    }

    #[test]
    fn scratch_bound_handles_escaped_quotes_keys_and_unterminated_strings() {
        assert_eq!(escaped_string_bound(r#"["plain","a\"bc","123\\456"]"#), 8);
        assert_eq!(escaped_string_bound(r#"{"a\u0041":"plain"}"#), 7);
        assert_eq!(escaped_string_bound(r#""abc\n"#), 5);
        assert_eq!(escaped_string_bound(r#"["a very long plain string"]"#), 0);
    }

    #[test]
    fn unescaped_string_is_borrowed_until_output_budget_is_checked() {
        let raw = format!("\"{}\"", "a".repeat(100_000));
        let mut budget = Budget::new(16 * 1024);
        assert!(matches!(parse(&raw, &mut budget), Projection::Truncated));
        assert_eq!(budget.nodes, MAX_NODES - 1);
        assert_eq!(
            budget.remaining,
            16 * 1024 - size_of::<AnyValue>() - ALLOCATION_OVERHEAD
        );
        let mut r = request(&raw);
        project(&mut r, 128 * 1024);
        assert_eq!(
            attrs(&r)[0].value,
            Some(any(Value::StringValue("a".repeat(100_000))))
        );
        assert!(!truncated(&r));
    }

    #[test]
    fn budget_is_shared_between_records_and_zero_still_marks_truncation() {
        let mut r = request("[0]");
        let second = r.resource_logs[0].scope_logs[0].log_records[0].clone();
        r.resource_logs[0].scope_logs[0].log_records.push(second);
        let per_value = 2 * (size_of::<AnyValue>() + ALLOCATION_OVERHEAD)
            + 4 * size_of::<AnyValue>()
            + ALLOCATION_OVERHEAD;
        project(&mut r, PARSER_OVERHEAD + per_value);
        assert!(matches!(
            attrs(&r)[0].value.as_ref().unwrap().value,
            Some(Value::ArrayValue(_))
        ));
        let second = &r.resource_logs[0].scope_logs[0].log_records[1].attributes;
        assert_eq!(second[0].value, Some(any(Value::StringValue("[0]".into()))));
        assert!(second.iter().any(|attr| attr.key == TRUNCATED));

        let mut zero = request("[]");
        project(&mut zero, 0);
        project(&mut zero, 0);
        preserved(&zero, "[]");
        assert_eq!(
            attrs(&zero).iter().filter(|a| a.key == TRUNCATED).count(),
            1
        );
    }

    #[test]
    fn invalid_or_lossy_values_keep_original_data_without_false_truncation() {
        for raw in [
            r#"{"bad":}"#,
            "{} trailing",
            r#"{"a":1,"a":2}"#,
            "18446744073709551615",
        ] {
            let mut r = request(raw);
            project(&mut r, 64 * 1024);
            assert_eq!(
                attrs(&r)[0].value,
                Some(any(Value::StringValue(raw.into())))
            );
            assert!(!truncated(&r));
        }
    }
}
