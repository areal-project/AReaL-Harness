//! 主体加载与附件分页共用目录授权；完整主体不能经过普通工具的头尾裁剪。
use super::skills::SkillPage;
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
                "SKILL_NOT_LOADED: SKILL.md exceeds the 64 KiB complete-load budget. Shorten SKILL.md and move details to references; no partial body was loaded.",
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

    pub(super) async fn read_model_skill_page(
        &self,
        thread_id: &str,
        turn_id: &str,
        args: &Value,
    ) -> Result<Value> {
        let reference: VersionRef =
            serde_json::from_value(args["skill"].clone()).map_err(invalid)?;
        let resource = args["resource"]
            .as_str()
            .ok_or_else(|| invalid("resource is required"))?;
        // 禁止通过路径别名、大小写或包内父路径把主体重新变成分页读取。
        if Path::new(resource).file_name().is_some_and(|name| {
            name.to_str()
                .is_some_and(|name| name.eq_ignore_ascii_case("SKILL.md"))
        }) {
            return Err(invalid(
                "SKILL_MAIN_REQUIRES_LOAD: use skill_load to load the complete SKILL.md",
            ));
        }
        let offset = args["offset"].as_u64().unwrap_or(0) as usize;
        let max_bytes = args["maxBytes"].as_u64().unwrap_or(8192) as usize;
        if !(1..=8192).contains(&max_bytes) {
            return Err(invalid("maxBytes must be 1..8192"));
        }
        let skill = self
            .skill_for_read(thread_id, Some(turn_id), &reference)
            .await?;
        let mut page = skill
            .read_versioned(
                resource,
                offset,
                max_bytes,
                args["expectedVersion"].as_str(),
            )
            .await
            .map_err(|error| invalid(format!("{error:#}")))?;
        // 完整 UTF-8 前缀可直接阅读；仅去掉跨页的尾字符，不替换或丢失其字节。
        if let Err(error) = std::str::from_utf8(&page.bytes)
            && error.error_len().is_none()
            && error.valid_up_to() > 0
            && offset + page.bytes.len() < page.size
        {
            page.bytes.truncate(error.valid_up_to());
        }
        // 通用工具投影上限为 16 KiB。换行转义或二进制 Base64 可能使
        // 8192 字节页面超过上限并裁掉续读游标，因此这里预留元数据空间。
        let result_budget =
            crate::tools::MAX_RESULT.saturating_sub(crate::tools::MODEL_OUTPUT_HEADROOM);
        let mut result = model_skill_page_result(&reference, resource, offset, &page, max_bytes);
        if result.to_string().len() > result_budget {
            let original = page.bytes.clone();
            let mut low = 0;
            let mut high = original.len();
            while low < high {
                let middle = low + (high - low).div_ceil(2);
                let candidate = model_page_prefix(&original, middle);
                let mut probe = page.clone();
                probe.bytes = candidate.to_vec();
                let encoded =
                    model_skill_page_result(&reference, resource, offset, &probe, max_bytes);
                if encoded.to_string().len() <= result_budget {
                    low = middle;
                } else {
                    high = middle - 1;
                }
            }
            page.bytes = model_page_prefix(&original, low).to_vec();
            result = model_skill_page_result(&reference, resource, offset, &page, max_bytes);
            // 无效 UTF-8 可能让二分条件在首个无效字节处改变形态；最后再防御性
            // 缩短，确保交给通用预览的结果始终保留 nextRead。
            while result.to_string().len() > result_budget && !page.bytes.is_empty() {
                let end = model_page_prefix(&page.bytes, page.bytes.len().saturating_sub(1)).len();
                page.bytes.truncate(end);
                result = model_skill_page_result(&reference, resource, offset, &page, max_bytes);
            }
        }
        if result.to_string().len() > result_budget {
            return Err(invalid(
                "SKILL_PAGE_NOT_LOADED: resource metadata exceeds the model tool-result budget",
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

fn model_page_prefix(bytes: &[u8], requested: usize) -> &[u8] {
    let end = requested.min(bytes.len());
    match std::str::from_utf8(&bytes[..end]) {
        Ok(_) => &bytes[..end],
        Err(error) if error.error_len().is_none() => &bytes[..error.valid_up_to()],
        // 无效序列视为二进制数据，保留原字节并让结果使用 Base64，不能静默丢弃。
        Err(_) => &bytes[..end],
    }
}

fn model_skill_page_result(
    reference: &VersionRef,
    resource: &str,
    offset: usize,
    page: &SkillPage,
    max_bytes: usize,
) -> Value {
    let end = offset + page.bytes.len();
    let mut result = json!({"id":reference.id,"revision":reference.revision,"resource":resource,
        "offset":offset,"sizeBytes":page.size,"resourceVersion":page.version,
        "text":std::str::from_utf8(&page.bytes).ok(),"nextOffset":end,"eof":end>=page.size});
    if !result["text"].is_string() {
        use base64::Engine as _;
        result["dataBase64"] = json!(base64::engine::general_purpose::STANDARD.encode(&page.bytes));
    }
    if end < page.size {
        result["notice"] = json!(format!(
            "Partial resource content: bytes {offset}..{end} of {}. More content remains; call skill_resource_read with nextRead to continue. A page does not load the skill's main instructions; use skill_load before applying the skill.",
            page.size
        ));
        result["nextRead"] = json!({"skill":reference,"resource":resource,"offset":end,
            "maxBytes":max_bytes,"expectedVersion":page.version});
    }
    result
}
