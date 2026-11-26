//! 工具编号诊断与请求级缓冲预算；不把本地资源限制当作协议或网络故障。

use super::*;

/// 调用 ID 可能携带供应商的关联信息；按不透明字节串保留，单项与整条响应均有上限。
pub(super) const MAX_TOOL_CALL_ID_BYTES: usize = 64 * 1024;
pub const MAX_TOOL_ARGUMENT_BYTES: usize = 64 * 1024;

/// 宿主传入的请求策略。零调用额度禁用工具；require_call 映射到受支持 Provider 的结构化调用要求。
#[derive(Clone, Copy, Debug)]
pub struct ToolCallLimits {
    /// 仅求解请求使用；不能扩大已有工具目录或调用预算。
    pub require_call: bool,
    pub max_calls: usize,
    pub max_buffer_bytes: usize,
}

impl Default for ToolCallLimits {
    fn default() -> Self {
        Self {
            require_call: false,
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
            ("id_bytes", MAX_TOOL_CALL_ID_BYTES),
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
