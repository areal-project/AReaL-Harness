use super::results::Prepared;
use super::*;
use areal_protocol::ToolOutcome;
use areal_runtime_protocol as rt;

pub(super) async fn output_budget(cell: &Cell, call: &ToolCall) -> usize {
    let bindings = cell.bindings.read().await;
    let plugin_budget = if bindings
        .registry
        .get(&call.name)
        .is_ok_and(|entry| matches!(entry.backend, Backend::Plugin(_)))
    {
        plugins::MAX_JOURNAL
    } else {
        0
    };
    let skill_load = is_core_skill_load(&bindings, &call.name);
    let result_budget = if skill_load {
        crate::desktop::skill_loading::MAX_SKILL_LOAD_BYTES * 2 + 4096
    } else {
        MIN_TOOL_OUTPUT_BUDGET
    };
    call.arguments
        .len()
        .saturating_mul(2)
        .saturating_add(result_budget)
        .saturating_add(plugin_budget)
}

pub(super) fn is_core_skill_load(bindings: &Bindings, name: &str) -> bool {
    name == "skill_load"
        && bindings
            .registry
            .get(name)
            .is_ok_and(|entry| matches!(entry.backend, Backend::Core))
}

pub(super) fn validate_result(result: &mut Value, success: &mut bool, outcome: &mut ToolOutcome) {
    if !*success
        || (crate::desktop::skill_loading::is_complete_body(result)
            && result.to_string().len() <= crate::desktop::skill_loading::MAX_SKILL_LOAD_BYTES)
    {
        return;
    }
    *success = false;
    *outcome = ToolOutcome::Failed;
    *result = json!({"error":rt::Error::new(rt::ErrorCode::InvalidArgument,
        "SKILL_NOT_LOADED: complete result including tool metadata exceeds 64 KiB or failed integrity validation; shorten SKILL.md and move details to references")});
}

pub(super) fn is_complete_result(skill_load: bool, success: bool, result: &Value) -> bool {
    skill_load && success && crate::desktop::skill_loading::is_complete_body(result)
}

pub(super) fn prepare_complete_skill_result(value: &Value) -> anyhow::Result<Prepared> {
    let encoded = serde_json::to_string(value)?;
    anyhow::ensure!(
        encoded.len() <= crate::desktop::skill_loading::MAX_SKILL_LOAD_BYTES,
        "SKILL_NOT_LOADED: complete result exceeds its bounded budget"
    );
    let tokens = crate::context::text_tokens(&encoded);
    // 原文随 ToolCall 持久化；不经过 16 KiB 预览，也不进入旧观察折叠。
    Ok(Prepared {
        value: value.clone(),
        snapshot: None,
        metrics: json!({"version":1,"transform":"skill-body-v1","reason":"completeBody",
            "rawBytes":encoded.len(),"displayedBytes":encoded.len(),
            "estimatedRawTokens":tokens,"estimatedDisplayedTokens":tokens,"storageBytes":0}),
    })
}

pub(super) fn serialize_result(complete: bool, value: &Value) -> anyhow::Result<String> {
    let result = serde_json::to_string(value)?;
    Ok(if complete {
        result
    } else {
        super::bounded_result(result)
    })
}

pub(super) fn pend(
    complete: bool,
    top_level: bool,
    call: &ToolCall,
    result: &str,
) -> Option<(String, String)> {
    (complete && top_level).then(|| (call.id.clone(), result.to_owned()))
}
