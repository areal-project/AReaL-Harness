//! 有界多文件表达；每个文件复用原生 CAS、权限、hooks 和收据。
use super::*;
use std::time::{Duration, Instant};

const MAX_FILES: usize = 16;

pub(super) fn definition() -> areal_protocol::ToolDefinition {
    let definitions = definitions_with_policy(&ToolPolicy::default());
    let schemas: Vec<_> = ["fs_create", "fs_apply_patches"]
        .iter()
        .map(|name| {
            definitions
                .iter()
                .find(|d| d["function"]["name"] == *name)
                .unwrap()["function"]["parameters"]
                .clone()
        })
        .collect();
    areal_protocol::ToolDefinition {
        name: "edit_files".into(),
        description: "Apply 1..16 already-decided file edits in order. Each file uses {path,text} to create an absent file, or {path,patches:[{oldText,newText}]} to update an observed file (optional fileVersion/expectedSha256). Read existing files first; versions, permissions and hooks are checked per file. Stops at the first failure; reports APPLIED/FAILED/NOT_RUN/UNKNOWN with native receipts. Not a cross-file atomic transaction: prior writes remain. Never replay the whole batch after a failure or UNKNOWN. Paths must be distinct; parent directories must exist. For small patches with an already-selected test, prefer one tool_program: put edit and check objects in input; call tools.edit_files(input.edit), then collect(tools.verify_command(input.check)) only if allApplied=true. Prefer this direct entry for large file creation; do not embed full source in JavaScript. After its receipt, compose selected execution and collection with tool_program.".into(),
        input_schema: json!({"type":"object","properties":{"files":{"type":"array","minItems":1,"maxItems":MAX_FILES,"items":{"oneOf":schemas}}},"required":["files"],"additionalProperties":false}),
        output_schema: None,
    }
}

fn child_id(parent: &str, index: usize) -> String {
    format!("{parent}:file:{index}")
}

/// 仅从持久收据推导效果，取消或丢失回执不能被解释为没有写入。
pub(super) fn receipt(items: &[Item], parent: &str, arguments: &Value) -> Value {
    let files: Vec<_> = arguments["files"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(index, args)| {
            let call = child_id(parent, index);
            let item = items.iter().find(|item| {
                matches!(item, Item::DynamicToolCall {call_id, execution, ..}
            if call_id == &call && execution.parent_call_id.as_deref() == Some(parent))
            });
            let mut file = json!({"index":index,"path":args["path"],"status":"NOT_RUN"});
            if let Some(item) = item {
                let mut native = program::child_view(item);
                file["status"] = json!(match native["outcome"].as_str() {
                    Some("succeeded") if native["success"] == true => "APPLIED",
                    Some("failed") => "FAILED",
                    _ => "UNKNOWN",
                });
                // data/text 是同一份原生 JSON，直接调用也不重复携带。
                if !native["data"].is_null() {
                    native.as_object_mut().unwrap().remove("text");
                }
                file["receipt"] = native;
            }
            file
        })
        .collect();
    json!({"allApplied":!files.is_empty() && files.iter().all(|f| f["status"] == "APPLIED"),"files":files,
        "note":"Sequential edits, not a cross-file transaction. Prior effects remain; inspect FAILED/UNKNOWN before any new edit. NOT_RUN files were not dispatched. Native receipts are retrievable by itemId."})
}

impl Engine {
    pub(super) async fn edit_files_failure_receipt(
        &self,
        cell: &Cell,
        call: &ToolCall,
        result: &mut Value,
    ) {
        let state = cell.state.lock().await;
        let items = &state.thread.turns.last().unwrap().items;
        let original = serde_json::from_str(&call.arguments).unwrap_or(Value::Null);
        let args = items
            .iter()
            .find_map(|item| match item {
                Item::DynamicToolCall {
                    call_id, execution, ..
                } if call_id == &call.id => execution.effective_arguments.as_ref(),
                _ => None,
            })
            .unwrap_or(&original);
        let failure = result.clone();
        *result = receipt(items, &call.id, args);
        result["error"] = failure.get("error").cloned().unwrap_or(failure);
    }

    pub(super) fn edit_files<'a>(
        self: &'a Arc<Self>,
        invocation: &'a extensions::Invocation<'a>,
        args: &'a Value,
    ) -> futures_util::future::BoxFuture<'a, rt::Result<(bool, Value)>> {
        Box::pin(async move {
            let invalid = |e: String| rt::Error::new(rt::ErrorCode::InvalidArgument, e);
            let files = args["files"]
                .as_array()
                .ok_or_else(|| invalid("missing files".into()))?;
            if files.is_empty() || files.len() > MAX_FILES {
                return Err(invalid("expected 1..16 files".into()));
            }
            let runtime = self
                .runtime
                .as_ref()
                .ok_or_else(|| invalid("Runtime unavailable".into()))?;
            let mut paths = std::collections::HashSet::new();
            let mut calls = Vec::new();
            // 先校验形状和路径重复；文件版本仍在各次原生派发时检查，避免预检后的竞态。
            let bindings = invocation.cell.bindings.read().await;
            for (index, file) in files.iter().enumerate() {
                let name = if file.get("text").is_some() {
                    "fs_create"
                } else {
                    "fs_apply_patches"
                };
                let entry = bindings
                    .registry
                    .get(name)
                    .map_err(|e| invalid(e.to_string()))?;
                entry
                    .validate_input(file)
                    .map_err(|e| invalid(e.to_string()))?;
                let path = resource_uri(file["path"].as_str().unwrap(), runtime)
                    .map_err(|e| invalid(e.to_string()))?;
                if !paths.insert(path) {
                    return Err(invalid(
                        "duplicate file; combine its patches in one entry".into(),
                    ));
                }
                calls.push(ToolCall {
                    id: child_id(&invocation.call.id, index),
                    name: name.into(),
                    arguments: file.to_string(),
                });
            }
            drop(bindings);
            let cancel = invocation.cancel.child_token();
            let deadline = Instant::now() + Duration::from_secs(600);
            let mut remaining = invocation.remaining_output.saturating_sub(96 * 1024);
            for call in calls {
                let value = self
                    .dispatch_nested_tool(invocation, &cancel, call, &mut remaining, deadline)
                    .await?;
                if matches!(
                    value["outcome"].as_str(),
                    Some("unknown" | "running" | "cancelled")
                ) {
                    return Err(rt::Error::new(
                        rt::ErrorCode::Unavailable,
                        "edit outcome UNKNOWN; inspect receipts; later files were not dispatched",
                    ));
                }
                if value["success"] != true {
                    break;
                }
            }
            let state = invocation.cell.state.lock().await;
            let result = receipt(
                &state.thread.turns.last().unwrap().items,
                &invocation.call.id,
                args,
            );
            Ok((result["allApplied"] == true, result))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_retains_partial_effects_and_never_replays_missing_children() {
        let args = json!({"files":[{"path":"a","text":"a"},{"path":"b","text":"b"},{"path":"c","text":"c"}]});
        let parent = json!({"type":"dynamicToolCall","id":"parent-item","callId":"batch","tool":"edit_files","arguments":args,"status":"inProgress","success":null,"contentItems":null,"execution":{"runtimeEpoch":"e","scopeId":"s","operationId":"p","outcome":"running"}});
        let child = |index: usize, outcome: &str| json!({"type":"dynamicToolCall","id":format!("child-{index}"),"callId":child_id("batch",index),"tool":"fs_create","arguments":{},"status":if outcome=="succeeded" {"completed"}else{"failed"},"success":outcome=="succeeded","contentItems":[{"type":"inputText","text":"{}"}],"execution":{"runtimeEpoch":"e","scopeId":"s","operationId":format!("op-{index}"),"outcome":outcome,"parentCallId":"batch"}});
        let items: Vec<Item> = vec![parent, child(0, "succeeded"), child(1, "unknown")]
            .into_iter()
            .map(|v| serde_json::from_value(v).unwrap())
            .collect();
        let recovered = program::recovered_program_content(&items, "batch").unwrap();
        let value: Value = serde_json::from_str(recovered[0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(value["allApplied"], false);
        assert_eq!(value["files"][0]["status"], "APPLIED");
        assert_eq!(value["files"][1]["status"], "UNKNOWN");
        assert_eq!(value["files"][2]["status"], "NOT_RUN");
        assert_eq!(
            recovered,
            program::recovered_program_content(&items, "batch").unwrap()
        );
    }
}
