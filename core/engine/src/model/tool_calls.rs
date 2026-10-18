//! 工具编号诊断与请求级缓冲预算；不把本地资源限制当作协议或网络故障。

use super::*;

pub const MAX_TOOL_ARGUMENT_BYTES: usize = 64 * 1024;

/// 宿主传入的本地请求预算，不发送给模型供应商。零调用额度用于摘要等禁用工具的请求。
#[derive(Clone, Copy, Debug)]
pub struct ToolCallLimits {
    pub max_calls: usize,
    pub max_buffer_bytes: usize,
}

impl Default for ToolCallLimits {
    fn default() -> Self {
        Self {
            max_calls: 128,
            max_buffer_bytes: 4 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Serialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("invalid_tool_call_index: {reason} at {path} (event {event_number})")]
pub(crate) struct ToolCallIndexError {
    code: &'static str,
    protocol: &'static str,
    reason: &'static str,
    path: String,
    event_number: u64,
    index_type: &'static str,
    call_count: usize,
}

pub(crate) fn tool_index(
    fragment: &Value,
    event_number: u64,
    choice: usize,
    position: usize,
    call_count: usize,
) -> Result<u64> {
    let value = fragment.get("index");
    if fragment.is_object()
        && let Some(index) = value.and_then(Value::as_u64)
    {
        return Ok(index);
    }
    let index_type = match value {
        None => "missing",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    };
    let reason = if !fragment.is_object() {
        "fragment_not_object"
    } else {
        match value {
            None => "missing",
            Some(Value::Null) => "null",
            Some(Value::Number(number)) if number.as_i64().is_some_and(|n| n < 0) => "negative",
            Some(Value::Number(number)) if number.as_f64().is_some_and(|n| n < 0.0) => "negative",
            Some(Value::Number(number))
                if number.as_f64().is_some_and(|n| n >= u64::MAX as f64) =>
            {
                "out_of_range"
            }
            Some(Value::Number(_)) => "non_integer",
            _ => "wrong_type",
        }
    };
    Err(ToolCallIndexError {
        code: "invalid_tool_call_index",
        protocol: "chat-completions",
        reason,
        path: format!("choices[{choice}].delta.tool_calls[{position}].index"),
        event_number,
        index_type,
        call_count,
    }
    .into())
}

#[derive(Debug, Serialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("tool_call_budget_exceeded: {budget} (limit {limit}, observed {observed})")]
pub(crate) struct ToolCallBudgetError {
    code: &'static str,
    budget: &'static str,
    limit: usize,
    observed: usize,
}

impl ToolCallBudgetError {
    pub fn is_call_limit(&self) -> bool {
        self.budget == "calls"
    }
}

fn check(budget: &'static str, current: usize, added: usize, limit: usize) -> Result<()> {
    if current.checked_add(added).is_none_or(|size| size > limit) {
        return Err(ToolCallBudgetError {
            code: "tool_call_budget_exceeded",
            budget,
            limit,
            observed: current.saturating_add(added),
        }
        .into());
    }
    Ok(())
}

#[derive(Default)]
pub(crate) struct ToolCallBudget {
    limits: ToolCallLimits,
    calls: usize,
    pub bytes: usize,
}

impl ToolCallBudget {
    pub fn new(limits: ToolCallLimits) -> Self {
        Self {
            limits,
            ..Self::default()
        }
    }

    pub fn reserve(
        &mut self,
        new_call: bool,
        lengths: [usize; 3],
        added: [usize; 3],
    ) -> Result<()> {
        check(
            "calls",
            self.calls,
            usize::from(new_call),
            self.limits.max_calls,
        )?;
        for ((name, limit), (current, next)) in [
            ("id_bytes", 256),
            ("name_bytes", 128),
            ("argument_bytes", MAX_TOOL_ARGUMENT_BYTES),
        ]
        .into_iter()
        .zip(lengths.into_iter().zip(added))
        {
            check(name, current, next, limit)?;
        }
        let bytes = added
            .into_iter()
            .try_fold(0usize, |sum, n| sum.checked_add(n))
            .context("tool byte count overflow")?;
        check(
            "buffer_bytes",
            self.bytes,
            bytes,
            self.limits.max_buffer_bytes,
        )?;
        self.calls += usize::from(new_call);
        self.bytes += bytes;
        Ok(())
    }

    pub fn record(&mut self, call: &ToolCall) -> Result<()> {
        self.reserve(
            true,
            [0; 3],
            [call.id.len(), call.name.len(), call.arguments.len()],
        )
    }
}

pub(crate) fn tool_error_detail(error: &anyhow::Error) -> Option<Value> {
    if let Some(detail) = error.downcast_ref::<ToolCallIndexError>() {
        return Some(json!(detail));
    }
    error
        .downcast_ref::<ToolCallBudgetError>()
        .map(|detail| json!(detail))
}
