//! 主体加载与附件分页共用目录授权；完整主体不能经过普通工具的头尾裁剪。
use super::*;

/// 限制包含身份、正文及 JSON 转义的完整响应，而非给任意资源扩大工具预算。
pub(crate) const MAX_SKILL_LOAD_BYTES: usize = 64 * 1024;

pub(crate) fn is_complete_body(value: &Value) -> bool {
    value["complete"] == true
        && value["resource"] == "SKILL.md"
        && value["text"].as_str().is_some_and(|text| {
            value["sizeBytes"].as_u64() == Some(text.len() as u64)
                && value["sha256"] == format!("{:x}", Sha256::digest(text.as_bytes()))
        })
}

impl Engine {
    pub(super) async fn load_skill_body(
        &self,
        thread_id: &str,
        turn_id: &str,
        reference: VersionRef,
    ) -> Result<Value> {
        let skill = self
            .skill_for_read(thread_id, Some(turn_id), &reference)
            .await?;
        // 同一次打开完成读取，避免把不同文件版本的分页拼成一份指令。
        let page = skill
            .read("SKILL.md", 0, MAX_SKILL_LOAD_BYTES + 1)
            .await
            .map_err(|error| invalid(format!("{error:#}")))?;
        if page.size > MAX_SKILL_LOAD_BYTES || page.bytes.len() != page.size {
            return Err(invalid(
                "SKILL_NOT_LOADED: SKILL.md exceeds the 64 KiB complete-load budget. Move detailed references out of SKILL.md; supporting resources can be inspected with `read_file` or `fs_read`, but they do not load the complete skill.",
            ));
        }
        let text = String::from_utf8(page.bytes)
            .map_err(|_| invalid("SKILL_NOT_LOADED: SKILL.md must be valid UTF-8"))?;
        let result = json!({"id":reference.id,"revision":reference.revision,"resource":"SKILL.md",
            "resourceRoot":format!("areal://skill/{}/{}",reference.id,reference.revision),
            "sizeBytes":page.size,"sha256":format!("{:x}", Sha256::digest(text.as_bytes())),
            "text":text,"complete":true});
        if result.to_string().len() > MAX_SKILL_LOAD_BYTES {
            return Err(invalid(
                "SKILL_NOT_LOADED: the complete response exceeds 64 KiB after JSON encoding. Shorten SKILL.md and move detailed material to references; no partial body was loaded.",
            ));
        }
        self.record_skill_access(thread_id, &reference).await?;
        Ok(result)
    }

    pub(super) fn skill_bodies_in_context(&self, thread: &Thread) -> anyhow::Result<Value> {
        if !thread
            .turns
            .iter()
            .flat_map(|turn| &turn.items)
            .any(|item| {
                matches!(item,
            Item::DynamicToolCall {tool, success: Some(true), execution, ..}
                if tool == "skill_load" && execution.backend.as_deref() == Some("core"))
            })
        {
            return Ok(json!({}));
        }
        let messages = history(thread, &self.store)?;
        let mut loaded = serde_json::Map::new();
        for item in thread.turns.iter().flat_map(|turn| &turn.items) {
            let Item::DynamicToolCall {
                id,
                tool,
                call_id,
                success: Some(true),
                execution,
                content_items,
                arguments,
                ..
            } = item
            else {
                continue;
            };
            if tool != "skill_load"
                || execution.backend.as_deref() != Some("core")
                || execution.parent_call_id.is_some()
            {
                continue;
            }
            let matching: Vec<_> = messages
                .iter()
                .filter(|m| m.role == "tool" && m.tool_call_id.as_ref() == Some(call_id))
                .collect();
            if matching.len() != 1 {
                continue;
            }
            let text = matching[0].text_content();
            if !content_items.as_ref().is_some_and(|parts| {
                parts.len() == 1 && parts[0]["type"] == "inputText" && parts[0]["text"] == text
            }) {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            let args = execution.effective_arguments.as_ref().unwrap_or(arguments);
            if is_complete_body(&value)
                && value["id"] == args["skill"]["id"]
                && value["revision"] == args["skill"]["revision"]
                && let Some(skill_id) = value["id"].as_str()
            {
                loaded.insert(skill_id.into(), json!({"revision":value["revision"],"sha256":value["sha256"],"sourceItemId":id}));
            }
        }
        Ok(Value::Object(loaded))
    }
}
