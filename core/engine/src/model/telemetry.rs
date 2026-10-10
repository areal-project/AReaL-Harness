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
    let reason = match protocol {
        ModelProtocol::ChatCompletions => event["choices"].as_array().and_then(|choices| {
            choices
                .iter()
                .find(|choice| choice["index"] == 0)
                .and_then(|choice| choice["finish_reason"].as_str())
        }),
        ModelProtocol::Responses => response["status"].as_str().filter(|status| {
            matches!(*status, "completed" | "incomplete" | "failed" | "cancelled")
        }),
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
