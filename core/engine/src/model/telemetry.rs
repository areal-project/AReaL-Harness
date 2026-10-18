//! 记录适配完成的请求，不读取认证头或重新解析用户配置。

use super::{ModelProtocol, RequestPurpose};
use serde_json::Value;
use tracing::Span;

pub(super) fn request(
    body: &Value,
    protocol: ModelProtocol,
    purpose: RequestPurpose,
    websocket: bool,
) {
    let span = Span::current();
    if span.is_disabled() {
        return;
    }
    span.record("areal.model.request.id", uuid::Uuid::new_v4().to_string());
    span.record("areal.model.adapter.version", "areal.model/v1");
    span.record(
        "areal.model.request.protocol",
        match protocol {
            ModelProtocol::ChatCompletions => "chat-completions",
            ModelProtocol::Responses => "responses",
        },
    );
    span.record(
        "areal.model.request.transport",
        if websocket { "websocket" } else { "http" },
    );
    span.record(
        "areal.model.request.purpose",
        match purpose {
            RequestPurpose::Solve => "solve",
            RequestPurpose::Summary => "summary",
        },
    );
    // 保留原始 JSON 字符串，哈希无需跨语言重新序列化浮点数或 Unicode。
    if let Some(hash) = crate::record_trajectory_json(&span, "areal.model.request.body", body) {
        let hash = hash.iter().map(|b| format!("{b:02x}")).collect::<String>();
        span.record("areal.model.request.sha256", hash);
    }
}

pub(super) fn response(event: &Value, protocol: ModelProtocol) {
    let span = Span::current();
    if span.is_disabled() {
        return;
    }
    let response = match protocol {
        ModelProtocol::ChatCompletions => event,
        ModelProtocol::Responses => &event["response"],
    };
    if let Some(id) = response["id"].as_str() {
        span.record("gen_ai.response.id", id);
    }
    if let Some(model) = response["model"].as_str() {
        span.record("gen_ai.response.model", model);
    }
    if protocol == ModelProtocol::Responses {
        if let Some(status) = response["status"].as_str() {
            span.record("areal.model.response.status", status);
        }
        if let Some(details) = response.get("incomplete_details").filter(|v| !v.is_null()) {
            crate::record_trajectory_json(
                &span,
                "areal.model.response.incomplete_details",
                details,
            );
        }
    }
    let reason = match protocol {
        ModelProtocol::ChatCompletions => event["choices"].as_array().and_then(|choices| {
            choices
                .iter()
                .find(|choice| choice["index"] == 0)
                .and_then(|choice| choice["finish_reason"].as_str())
        }),
        ModelProtocol::Responses => {
            response["incomplete_details"]["reason"]
                .as_str()
                .or_else(|| {
                    response["status"].as_str().filter(|status| {
                        matches!(*status, "completed" | "incomplete" | "failed" | "cancelled")
                    })
                })
        }
    };
    if let Some(reason) = reason {
        crate::record_trajectory_json(&span, "gen_ai.response.finish_reasons", &[reason]);
    }
}

pub(super) fn usage(details: &Value) {
    crate::record_trajectory_json(
        &Span::current(),
        "areal.model.response.usage_details",
        details,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sha2::{Digest, Sha256};
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
    #[test]
    fn provider_request_preserves_exact_json_and_responses_incomplete_reason() {
        let capture = Capture::default();
        let body = json!({"model":"alias", "input":[{"role":"user","content":"多行\n🙂"}], "tools":[{"type":"function","name":"read","parameters":{"type":"object"}}], "temperature":0.1});
        tracing::subscriber::with_default(
            tracing_subscriber::registry().with(capture.clone()),
            || {
                let span = tracing::info_span!(target: "areal::trajectory", "model", areal.model.request.body = tracing::field::Empty,
                areal.model.request.sha256 = tracing::field::Empty, areal.model.request.protocol = tracing::field::Empty,
                areal.model.request.id = tracing::field::Empty, areal.model.request.purpose = tracing::field::Empty,
                areal.model.request.transport = tracing::field::Empty, areal.model.adapter.version = tracing::field::Empty,
                gen_ai.response.id = tracing::field::Empty, gen_ai.response.model = tracing::field::Empty,
                gen_ai.response.finish_reasons = tracing::field::Empty, areal.model.response.status = tracing::field::Empty,
                areal.model.response.incomplete_details = tracing::field::Empty);
                let _entered = span.enter();
                request(&body, ModelProtocol::Responses, RequestPurpose::Solve, true);
                response(
                    &json!({"type":"response.incomplete", "response":{"id":"provider-id", "model":"snapshot-actual", "status":"incomplete", "incomplete_details":{"reason":"max_output_tokens"}}}),
                    ModelProtocol::Responses,
                );
            },
        );
        let values = capture.0.lock().unwrap();
        assert_eq!(
            values["areal.model.request.body"],
            serde_json::to_string(&body).unwrap()
        );
        assert_eq!(
            values["areal.model.request.sha256"],
            format!(
                "{:x}",
                Sha256::digest(values["areal.model.request.body"].as_bytes())
            )
        );
        assert_eq!(values["areal.model.request.transport"], "websocket");
        assert_eq!(values["gen_ai.response.model"], "snapshot-actual");
        assert_eq!(values["gen_ai.response.id"], "provider-id");
        assert_eq!(
            values["gen_ai.response.finish_reasons"],
            r#"["max_output_tokens"]"#
        );
        assert_eq!(values["areal.model.response.status"], "incomplete");
    }
}
