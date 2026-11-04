//! 工具结果快照与一次性模型投影。引用只由当前 Thread 的权威调用记录授权。
use super::*;
use registry::ResultViewMode;
use sha2::{Digest, Sha256};

const MAX_SNAPSHOT: usize = areal_protocol::MAX_TOOL_RESULT_BYTES;

pub(super) struct Prepared {
    pub value: Value,
    pub snapshot: Option<areal_protocol::MediaRef>,
    pub metrics: Value,
}

#[derive(Clone, Copy)]
enum ProjectionKind {
    Ordinary,
    Coordination,
    Program,
}

impl Engine {
    pub(crate) async fn read_history(&self, cell: &Cell, args: &Value) -> anyhow::Result<Value> {
        let thread = cell.state.lock().await.thread.clone();
        let Some(item_id) = args["itemId"].as_str() else {
            return self
                .store
                .history_page(
                    &thread,
                    args["before"].as_str().map(str::to_owned),
                    args["limit"].as_u64().unwrap_or(8) as usize,
                )
                .await;
        };
        let item = self
            .store
            .history_item(&thread, item_id)
            .await?
            .context("history item is not in this thread; use agent_read(executionId, offset) for a child handoff, or list this thread's history without itemId")?;
        let text = serde_json::to_string(&item)?;
        let offset = match args["after"].as_str() {
            Some(cursor) => cursor
                .strip_prefix(&format!("{item_id}:"))
                .context("cursor belongs to a different item")?
                .parse()?,
            None => 0,
        };
        let max_bytes = args["maxBytes"].as_u64().unwrap_or(8192) as usize;
        anyhow::ensure!((4..=8192).contains(&max_bytes), "maxBytes must be 4..8192");
        result_page(item_id, &text, offset, max_bytes)
    }

    pub(super) async fn prepare_tool_result(
        &self,
        cell: &Cell,
        item_id: &str,
        name: &str,
        raw: &Value,
        argv: Option<&[String]>,
    ) -> anyhow::Result<Prepared> {
        self.prepare_tool_result_inner(cell, item_id, name, raw, argv, ProjectionKind::Ordinary)
            .await
    }

    pub(super) async fn prepare_coordination_result(
        &self,
        cell: &Cell,
        item_id: &str,
        name: &str,
        raw: &Value,
    ) -> anyhow::Result<Prepared> {
        self.prepare_tool_result_inner(cell, item_id, name, raw, None, ProjectionKind::Coordination)
            .await
    }

    pub(super) async fn prepare_program_result(
        &self,
        cell: &Cell,
        item_id: &str,
        raw: &Value,
    ) -> anyhow::Result<Prepared> {
        self.prepare_tool_result_inner(
            cell,
            item_id,
            "tool_program",
            raw,
            None,
            ProjectionKind::Program,
        )
        .await
    }

    async fn prepare_tool_result_inner(
        &self,
        cell: &Cell,
        item_id: &str,
        name: &str,
        raw: &Value,
        argv: Option<&[String]>,
        projection: ProjectionKind,
    ) -> anyhow::Result<Prepared> {
        let coordination = matches!(projection, ProjectionKind::Coordination);
        let program = matches!(projection, ProjectionKind::Program);
        let started = std::time::Instant::now();
        let bytes = serde_json::to_vec(raw)?;
        let policy = &self.extensions.policy.result_views;
        // 无损行格式在首次记录时确定，历史回放不重写旧 provider 上下文。
        let mut baseline = if coordination && name.starts_with("agent_") {
            crate::agents::model_execution_view(raw.clone())
        } else if name == "read_file" && policy.file_lines {
            crate::history::compact_file_text(&raw.to_string())
                .and_then(|v| serde_json::from_str(&v).ok())
                .unwrap_or_else(|| raw.clone())
        } else {
            raw.clone()
        };
        if raw.get("mcpResult").is_some() {
            crate::desktop::mcp_apps::strip_meta(&mut baseline);
        }
        let file_compacted = name == "read_file" && baseline != *raw;
        let identity_compacted = coordination && baseline != *raw;
        if let Some(argv) = argv {
            apply_output_view(&mut baseline, argv);
        }
        let candidate = if policy.mode == ResultViewMode::Off {
            None
        } else if name == "search_files" && policy.search_groups {
            search_groups(raw)
        } else if argv.is_some_and(|v| output::classify(v).is_some()) && policy.repeat_lines {
            repeat_lines(raw)
        } else {
            None
        };
        // 程序子调用的数据由 JavaScript 消费，未必展示给模型，不能登记为已见观察。
        let program_child = {
            let state = cell.state.lock().await;
            state.thread.turns.last().is_some_and(|turn| {
                turn.items.iter().any(|item| {
                    matches!(item,
                    Item::DynamicToolCall { id, execution, .. }
                    if id == item_id && execution.parent_call_id.is_some())
                })
            })
        };
        let observation_key = (policy.repeated_observations && !program_child)
            .then(|| observation_key(name, raw))
            .flatten();
        let projection_snapshot = observation_key.is_some()
            || raw.get("mcpResult").is_some()
            || bytes.len() > MAX_RESULT
            || baseline != *raw
            || candidate.is_some();
        let needs_snapshot = projection_snapshot
            || (self.limits.context_compaction_enabled
                && self.limits.context_auto_compaction
                && self.limits.context_observation_tokens > 0
                && bytes.len() > 2048);
        let readback_allowed = {
            let state = cell.state.lock().await;
            state
                .thread
                .turns
                .last()
                .and_then(|t| t.configuration.as_ref())
                .and_then(|c| c.tool_allowlist.as_ref())
                .is_none_or(|names| names.iter().any(|n| n == "read_tool_result"))
        };
        let mut reason = "passthrough";
        let snapshot = if needs_snapshot && name != "read_tool_result" {
            if !readback_allowed && raw.get("mcpResult").is_none() {
                reason = "retrievalDisabled";
                None
            } else if bytes.len() > MAX_SNAPSHOT {
                reason = "snapshotQuota";
                None
            } else {
                match self
                    .store
                    .save_blob("application/json".into(), bytes.clone())
                    .await
                {
                    Ok(reference) => Some(reference),
                    Err(_) => {
                        reason = "snapshotUnavailable";
                        None
                    }
                }
            }
        } else {
            None
        };
        let reference = snapshot.as_ref().map(|s| {
            json!({
                "resultId":item_id,"bytes":s.size_bytes,"format":"json",
                "scope":"this tool result only; unobserved process bytes are not included",
                "readback":"read_tool_result(resultId, after=null); follow nextCursor"
            })
        });
        let mut value = baseline;
        // 折叠必须有持久原文；写入失败只退回有界原文，不重跑原来的操作。
        if snapshot.is_none() && value != *raw && raw.get("mcpResult").is_none() {
            value = raw.clone();
        }
        // 观察候选需要留存原文，但未变且未超限的结果无需增加模型侧回取包装。
        // 候选随后与实际发送的基线比较，不能靠先扩大基线满足净节省门槛。
        if (value != *raw || bytes.len() > MAX_RESULT || raw.get("mcpResult").is_some())
            && !program
            && let Some(reference) = &reference
        {
            if !value.is_object() {
                value = json!({"result":value});
            }
            value["rawResult"] = reference.clone();
            if value.get("outputView").is_some() {
                value["outputView"]["rawReadback"] = json!(format!(
                    "read_tool_result with resultId={item_id}; follow nextCursor"
                ));
            }
        }
        let mut candidate_bytes = None;
        let mut kind = if identity_compacted {
            "coordination-v2"
        } else if file_compacted && snapshot.is_some() {
            "file-lines-v1"
        } else {
            "none"
        };
        if file_compacted && snapshot.is_some() {
            // 文件行压缩的门槛也包含回取引用；短片段可能被固定元数据抵消收益。
            if value.to_string().len() + 128 < bytes.len() {
                reason = "lossless";
            } else {
                value = raw.clone();
                kind = "none";
                reason = "noNetSaving";
            }
        }
        if let Some((format, mut proposed)) = candidate {
            kind = format;
            proposed["rawResult"] = reference.clone().unwrap_or(Value::Null);
            let encoded = proposed.to_string();
            candidate_bytes = Some(encoded.len());
            let baseline = value.to_string();
            if snapshot.is_some() && worthwhile(&baseline, &encoded) {
                if policy.mode == ResultViewMode::On {
                    value = proposed;
                    reason = "applied";
                } else {
                    reason = "observe";
                }
            } else if snapshot.is_some() {
                reason = "noNetSaving";
            }
        }
        if let Some(key) = observation_key
            && snapshot.is_some()
        {
            let mut state = cell.state.lock().await;
            if let Some(active) = state.active.as_mut() {
                if let Some(previous) = active.observation_results.get(&key)
                    && previous != item_id
                {
                    let mut proposed = raw.clone();
                    for field in [
                        "lines",
                        "text",
                        "declarations",
                        "absentDeclarations",
                        "executables",
                    ] {
                        proposed.as_object_mut().unwrap().remove(field);
                    }
                    proposed["unchangedObservation"] = json!({"previousResultId":previous,"basis":"fresh observation matched exactly; current versions and pagination retained"});
                    proposed["rawResult"] = reference.clone().unwrap();
                    if worthwhile(&value.to_string(), &proposed.to_string()) {
                        value = proposed;
                        kind = "repeated-observation-v1";
                        reason = "applied";
                    }
                } else if !active.observation_results.contains_key(&key) {
                    if active.observation_results.len() >= 128 {
                        active.observation_results.clear();
                    }
                    active.observation_results.insert(key, item_id.into());
                }
            }
        }
        if coordination
            && snapshot.is_some()
            && value.to_string().len() > MAX_RESULT
            && let Some(preview) = coordination_handoff_preview(&value)
        {
            // 只缩短可按字节回取的正文，不能让通用头尾截断破坏整批回执的状态与游标。
            value = preview;
            kind = "coordination-v2-preview-v1";
            reason = "pagedHandoffPreview";
        }
        if raw.get("processId").is_some()
            && (value.to_string().len() > MAX_RESULT
                || value["stdout"].as_str().map_or(0, str::len)
                    + value["stderr"].as_str().map_or(0, str::len)
                    > raw["outputPageBytes"].as_u64().unwrap_or(8192) as usize)
        {
            // 已收集区间先保存，再缩短显示。保存失败仍可从 Runtime 原游标回取，不重放进程。
            if snapshot.is_none() {
                value["rawResult"] = json!({"processId":raw["processId"],"after":raw["collectedFromCursor"],"view":"raw",
                    "readback":"read_process with this processId, after and view=raw; follow nextCursor",
                    "scope":"Runtime process lifetime; durable snapshot unavailable"});
            }
            if let Some(preview) = output::bounded_preview(
                &value,
                raw["outputPageBytes"].as_u64().unwrap_or(8192) as usize,
            ) {
                value = preview;
                kind = "process-collected-preview-v1";
                reason = "boundedDisplayWithRawEvidence";
            }
        }
        if value.to_string().len() > MAX_RESULT && !program {
            // 先装入可信回取引用，再分配头尾预算；不能让通用截断删掉回取入口。
            let full = value.to_string();
            value = bounded_snapshot(&full, reference.clone());
        }
        if program {
            // 解释器选择输出与强制回执各有独立上限，父子文本都计入同一总预算。
            // 不能用普通头尾截断删除中间子调用的 UNKNOWN 或未完成进程事实。
            if let Some(reference) = &reference
                && let Some(preview) = program_preview(&value, reference)
            {
                value = preview;
                kind = "native-program-preview-v2";
                reason = "archivedSelectedOutput";
            } else {
                kind = "native-program-selected-v1";
                reason = "boundedSelectedOutputAndReceipts";
            }
        }
        let displayed_bytes = value.to_string().len();
        let displayed_tokens = context::text_tokens(&value.to_string());
        let storage_bytes = snapshot.as_ref().map_or(0, |s| s.size_bytes);
        Ok(Prepared {
            value,
            snapshot,
            metrics: json!({
                "version":1,"mode":policy.mode,"transform":kind,"reason":reason,
                "rawBytes":bytes.len(),"displayedBytes":displayed_bytes,
                "candidateBytes":candidate_bytes,"estimatedRawTokens":context::text_tokens(&String::from_utf8_lossy(&bytes)),
                "storageBytes":storage_bytes,
                "estimatedDisplayedTokens":displayed_tokens,
                "durationMicros":started.elapsed().as_micros() as u64
            }),
        })
    }

    pub(crate) async fn read_tool_result(
        &self,
        cell: &Cell,
        args: &Value,
    ) -> anyhow::Result<Value> {
        let result_id = args["resultId"].as_str().context("resultId required")?;
        let thread = cell.state.lock().await.thread.clone();
        let snapshot = match self.store.history_item(&thread, result_id).await? {
            Some(Item::DynamicToolCall { execution, .. }) => execution.result_snapshot,
            _ => None,
        }.context("original result unavailable in this thread; do not rerun an effectful tool to recover it")?;
        let digest = snapshot
            .uri
            .strip_prefix("areal://blob/")
            .context("invalid result snapshot")?;
        anyhow::ensure!(
            snapshot.size_bytes <= MAX_SNAPSHOT as u64,
            "snapshot exceeds size limit"
        );
        let bytes = self.store.read_blob(digest).await?;
        anyhow::ensure!(
            bytes.len() as u64 == snapshot.size_bytes
                && format!("{:x}", Sha256::digest(&bytes)) == digest,
            "result snapshot failed integrity verification"
        );
        let mut text = String::from_utf8(bytes)?;
        if let Ok(mut value) = serde_json::from_str::<Value>(&text)
            && value.get("mcpResult").is_some()
        {
            crate::desktop::mcp_apps::strip_meta(&mut value);
            text = serde_json::to_string(&value)?;
        }
        let offset = match args.get("after").filter(|v| !v.is_null()) {
            Some(cursor) => cursor
                .as_str()
                .context("invalid cursor")?
                .strip_prefix(&format!("{result_id}:"))
                .context("cursor belongs to a different result")?
                .parse::<usize>()?,
            None => 0,
        };
        let max_bytes = args["maxBytes"].as_u64().unwrap_or(8192) as usize;
        anyhow::ensure!((4..=8192).contains(&max_bytes), "maxBytes must be 4..8192");
        result_page(result_id, &text, offset, max_bytes)
    }
}

fn program_preview(raw: &Value, reference: &Value) -> Option<Value> {
    let parts = raw["contentItems"].as_array()?;
    let selected_bytes: usize = parts
        .iter()
        .skip(1)
        .filter_map(|part| part["text"].as_str())
        .map(str::len)
        .sum();
    if selected_bytes <= MAX_RESULT {
        return None;
    }
    let mut remaining = MAX_RESULT;
    let mut preview = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        // 第一项是 Core 的完整子操作回执；真实图片和状态不能随文本展示一起截断。
        let Some(text) = part["text"].as_str().filter(|_| index > 0) else {
            preview.push(part.clone());
            continue;
        };
        if remaining == 0 {
            continue;
        }
        let mut selected = part.clone();
        if text.len() > remaining {
            let head = super::prefix(text, remaining * 3 / 4);
            let tail = super::suffix(text, remaining / 4);
            selected["text"] = json!(format!("{head}\n[preview shortened]\n{tail}"));
            remaining = 0;
        } else {
            remaining -= text.len();
        }
        preview.push(selected);
    }
    preview.push(json!({"type":"inputText","text":json!({
        "selectedOutputTruncated":true,"selectedOutputBytes":selected_bytes,"rawResult":reference,
        "note":"Execution completed as recorded above. Full selected output is saved; use read_tool_result with this resultId if needed. Do not repeat completed effects to recover output."
    }).to_string()}));
    let mut value = raw.clone();
    value["contentItems"] = json!(preview);
    Some(value)
}

fn coordination_handoff_preview(value: &Value) -> Option<Value> {
    let mut preview = value.clone();
    for limit in [2048, 1024, 512, 256, 128, 64, 0] {
        for key in ["completed", "pending", "agents"] {
            if let Some(rows) = preview.get_mut(key).and_then(Value::as_array_mut) {
                for row in rows {
                    let (Some(text), Some(offset)) = (row["text"].as_str(), row["offset"].as_u64())
                    else {
                        continue;
                    };
                    let short = prefix(text, limit);
                    if short.len() < text.len() {
                        let next = offset.checked_add(short.len() as u64)?;
                        let short = short.to_owned();
                        row["text"] = json!(short);
                        row["nextOffset"] = json!(next);
                    }
                }
            }
        }
        if preview.to_string().len() <= MAX_RESULT {
            return Some(preview);
        }
    }
    // 元数据本身仍超限时保留原有有界原文回取，不丢状态字段或伪造完整交接。
    None
}

fn result_page(id: &str, text: &str, offset: usize, max_bytes: usize) -> anyhow::Result<Value> {
    anyhow::ensure!(
        offset <= text.len() && text.is_char_boundary(offset),
        "cursor is outside a UTF-8 result boundary"
    );
    let mut end = offset.saturating_add(max_bytes).min(text.len());
    loop {
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        let value = json!({"resultId":id,"encoding":"utf8","text":&text[offset..end],
            "bytes":end-offset,"totalBytes":text.len(),"eof":end==text.len(),
            "nextCursor":if end<text.len(){Some(format!("{id}:{end}"))}else{None},
            "historicalSnapshot":true});
        if value.to_string().len() <= MAX_RESULT - 1024 {
            return Ok(value);
        }
        anyhow::ensure!(end > offset + 4, "result page metadata exceeds budget");
        end = offset + (end - offset) / 2;
    }
}

fn bounded_snapshot(text: &str, reference: Option<Value>) -> Value {
    let mut half = MAX_RESULT / 3;
    loop {
        let head = prefix(text, half);
        let tail = suffix(text, half);
        let value = json!({"truncated":true,"prefix":head,"suffix":tail,
            "truncatedBytes":text.len()-head.len()-tail.len(),"rawResult":reference,
            "rawAvailable":reference.is_some()});
        if value.to_string().len() <= MAX_RESULT {
            return value;
        }
        half /= 2;
    }
}

fn worthwhile(raw: &str, candidate: &str) -> bool {
    candidate.len() + 256 <= raw.len()
        && candidate.len() * 100 <= raw.len() * 85
        && context::text_tokens(candidate) <= context::text_tokens(raw)
}

fn search_groups(raw: &Value) -> Option<(&'static str, Value)> {
    let rows = raw["matches"].as_array()?;
    let mut groups: Vec<Value> = Vec::new();
    for row in rows {
        if row.as_object()?.len() != 4
            || !row["path"].is_string()
            || !row["text"].is_string()
            || !row["line"].is_u64()
            || !matches!(row["kind"].as_str(), Some("match" | "context"))
        {
            return None;
        }
        if groups.last().is_none_or(|g| g["path"] != row["path"]) {
            groups.push(json!({"path":row["path"],"rows":[]}));
        }
        groups.last_mut()?["rows"].as_array_mut()?.push(json!([
            row["line"],
            row["kind"],
            row["text"]
        ]));
    }
    let decoded: Vec<Value> = groups
        .iter()
        .flat_map(|g| {
            g["rows"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| json!({"path":g["path"],"line":r[0],"kind":r[1],"text":r[2]}))
        })
        .collect();
    if decoded != *rows {
        return None;
    }
    let mut value = raw.clone();
    value.as_object_mut()?.remove("matches");
    value["matchGroups"] = json!(groups);
    value["resultView"] = json!({"format":"search-groups-v1","rowFields":["line","kind","text"],"allReturnedMatchesPreserved":true});
    worthwhile(&raw.to_string(), &value.to_string()).then_some(("search-groups-v1", value))
}

fn repeat_lines(raw: &Value) -> Option<(&'static str, Value)> {
    if raw["gap"] != false || raw["truncated"] != false {
        return None;
    }
    let mut value = raw.clone();
    let mut changed = false;
    for stream in ["stdout", "stderr"] {
        let text = raw[stream].as_str()?;
        let mut runs: Vec<(usize, &str)> = Vec::new();
        for line in text.split_inclusive('\n') {
            if let Some((count, previous)) = runs.last_mut()
                && *previous == line
            {
                *count += 1;
            } else {
                runs.push((1, line));
            }
        }
        if !runs.iter().any(|(count, _)| *count > 1) {
            continue;
        }
        let decoded: String = runs
            .iter()
            .map(|(count, line)| line.repeat(*count))
            .collect();
        if decoded != text {
            return None;
        }
        let encoded = json!(runs);
        if encoded.to_string().len() >= text.len() {
            continue;
        }
        value.as_object_mut()?.remove(stream);
        value[format!("{stream}Runs")] = encoded;
        changed = true;
    }
    value["resultView"] = json!({"format":"repeat-lines-v1","runFields":["repeat","text"],"restore":"concatenate each text repeated repeat times, in order; streams remain separate"});
    (changed && worthwhile(&raw.to_string(), &value.to_string()))
        .then_some(("repeat-lines-v1", value))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NoModel;
    #[async_trait::async_trait]
    impl Model for NoModel {
        fn name(&self) -> &str {
            "no-model"
        }
        async fn stream(&self, _: Vec<Message>) -> anyhow::Result<model::ModelStream> {
            unreachable!()
        }
    }

    #[test]
    fn handoff_previews_preserve_offsets_pending_failures_and_metadata_overflow() {
        let text = "失败限制与未完成检查\n".repeat(1000);
        let raw = json!({"completed":[{"text":text,"offset":9,"status":"failed","error":"verification failed"}],
            "pending":[{"text":text,"offset":6,"status":"running","resourcesReleased":false}],
            "allSettled":false,"nextAfter":{"completed":"unchanged-version"}});
        let preview = coordination_handoff_preview(&raw).unwrap();
        for key in ["completed", "pending"] {
            let row = &preview[key][0];
            assert_eq!(row["status"], raw[key][0]["status"]);
            assert_eq!(row["offset"], raw[key][0]["offset"]);
            assert_eq!(
                row["nextOffset"].as_u64(),
                Some(row["offset"].as_u64().unwrap() + row["text"].as_str().unwrap().len() as u64)
            );
        }
        assert_eq!(
            preview["completed"][0]["error"],
            raw["completed"][0]["error"]
        );
        assert_eq!(preview["pending"][0]["resourcesReleased"], false);
        assert_eq!(preview["allSettled"], false);
        assert_eq!(preview["nextAfter"], raw["nextAfter"]);
        let mut overflow = raw;
        overflow["unresolvedMetadata"] = json!("must retain".repeat(MAX_RESULT));
        assert!(coordination_handoff_preview(&overflow).is_none());
    }

    #[tokio::test]
    async fn oversized_coordination_batch_retains_structured_receipts_and_full_readback() {
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path(), Arc::new(NoModel), Limits::default()).unwrap();
        let thread = engine.create("/fixture".into()).await.unwrap();
        let cell = engine.cell(&thread.id).await.unwrap();
        let reports: Vec<_> = (0..3).map(|index| json!({
            "executionId":format!("execution-{index}"),"threadId":format!("child-{index}"),
            "turnId":"child-turn","status":if index==2 {"cancelled"} else {"completed"},
            "settled":true,"resourcesReleased":true,"sourceItemId":format!("report-{index}"),
            "text":"检查与限制\n".repeat(1200),"textBytes":19200,"offset":0,"nextOffset":null,
            "delivery":{"status":"notRequired"},"verification":{"status":"unknown"}
        })).collect();
        let raw = json!({"completed":reports,"pending":[],"allSettled":true,
            "nextAfter":{"execution-0":"version-0","execution-1":"version-1","execution-2":"version-2"}});
        let prepared = engine
            .prepare_coordination_result(&cell, "batch-call", "agent_wait_any", &raw)
            .await
            .unwrap();
        assert!(prepared.value.to_string().len() <= MAX_RESULT);
        assert!(
            prepared.value.get("prefix").is_none(),
            "a batch must not become partial JSON strings"
        );
        assert_eq!(prepared.value["nextAfter"], raw["nextAfter"]);
        assert_eq!(prepared.value["allSettled"], true);
        for (index, report) in prepared.value["completed"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
        {
            let original = &raw["completed"][index];
            for field in [
                "executionId",
                "sourceItemId",
                "status",
                "settled",
                "resourcesReleased",
                "delivery",
                "verification",
                "textBytes",
            ] {
                assert_eq!(report[field], original[field], "{field}");
            }
            let text = report["text"].as_str().unwrap();
            assert!(!text.is_empty());
            assert!(original["text"].as_str().unwrap().starts_with(text));
            assert_eq!(report["nextOffset"].as_u64(), Some(text.len() as u64));
        }
        let turn:Turn=serde_json::from_value(json!({"id":"turn","status":"completed","items":[{
            "type":"dynamicToolCall","id":"batch-call","tool":"agent_wait_any","callId":"call","arguments":{},"status":"completed","success":true,
            "contentItems":[{"type":"inputText","text":prepared.value.to_string()}],
            "execution":{"runtimeEpoch":"epoch","scopeId":"scope","operationId":"op","outcome":"succeeded","resultSnapshot":prepared.snapshot}
        }]})).unwrap();
        cell.state.lock().await.thread.turns.push(turn);
        let mut args = json!({"resultId":"batch-call"});
        let mut full = String::new();
        loop {
            let page = engine.read_tool_result(&cell, &args).await.unwrap();
            full.push_str(page["text"].as_str().unwrap());
            if page["eof"] == true {
                break;
            }
            args["after"] = page["nextCursor"].clone();
        }
        assert_eq!(serde_json::from_str::<Value>(&full).unwrap(), raw);
        let small = json!({"completed":[{"executionId":"one","offset":4,"text":"ok","nextOffset":null}],"pending":[]});
        let direct = engine
            .prepare_coordination_result(&cell, "small", "agent_wait_any", &small)
            .await
            .unwrap();
        assert_eq!(direct.value, small);
        engine.shutdown().await;
    }

    #[tokio::test]
    #[ignore = "通过 tests/perf/result_view_report.py --replay 显式回放本地原文"]
    async fn replay_saved_originals() {
        let input = std::env::var("AREAL_RESULT_REPLAY_INPUT").unwrap();
        let output = std::env::var("AREAL_RESULT_REPLAY_OUTPUT").unwrap();
        let records: Vec<Value> = serde_json::from_slice(&std::fs::read(input).unwrap()).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let mut extensions = ToolExtensions::default();
        extensions.policy.result_views.mode = std::env::var("AREAL_RESULT_REPLAY_MODE")
            .ok()
            .map(|mode| serde_json::from_value(json!(mode)).unwrap())
            .unwrap_or(ResultViewMode::On);
        let engine = Engine::open_with_extensions(
            directory.path(),
            Arc::new(NoModel),
            Limits::default(),
            None,
            extensions,
        )
        .unwrap();
        let thread = engine.create("/replay".into()).await.unwrap();
        let cell = engine.cell(&thread.id).await.unwrap();
        let mut measurements = Vec::new();
        for record in records {
            let argv: Option<Vec<String>> = serde_json::from_value(record["argv"].clone()).unwrap();
            let prepared = engine
                .prepare_tool_result(
                    &cell,
                    record["id"].as_str().unwrap(),
                    record["tool"].as_str().unwrap(),
                    &record["raw"],
                    argv.as_deref(),
                )
                .await
                .unwrap();
            if let Some(snapshot) = &prepared.snapshot {
                let digest = snapshot.uri.strip_prefix("areal://blob/").unwrap();
                let bytes = engine.store.read_blob(digest).await.unwrap();
                assert_eq!(bytes, serde_json::to_vec(&record["raw"]).unwrap());
            }
            measurements.push(
                json!({"id":record["id"],"tool":record["tool"],"projection":prepared.metrics,
                    "value":prepared.value,"snapshotVerified":prepared.snapshot.is_some()}),
            );
        }
        std::fs::write(output, serde_json::to_vec_pretty(&measurements).unwrap()).unwrap();
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn program_preview_retains_all_child_facts_images_and_exact_original_readback() {
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path(), Arc::new(NoModel), Limits::default()).unwrap();
        let thread = engine.create("/fixture".into()).await.unwrap();
        let cell = engine.cell(&thread.id).await.unwrap();
        let receipts = json!({"children":[
            {"itemId":"one","outcome":"succeeded"},
            {"itemId":"middle","outcome":"unknown","processId":"process","commandStatus":"running","outputReadComplete":false},
            {"itemId":"last","outcome":"failed"}
        ]});
        let raw = json!({"contentItems":[
            {"type":"inputText","text":receipts.to_string()},
            {"type":"inputText","text":"原始观察😀".repeat(6000)},
            {"type":"inputImage","imageUrl":"data:image/png;base64,evidence"},
            {"type":"inputText","text":"last selected evidence"}
        ]});
        let prepared = engine
            .prepare_program_result(&cell, "program-item", &raw)
            .await
            .unwrap();
        assert_eq!(prepared.value["contentItems"][0], raw["contentItems"][0]);
        assert_eq!(prepared.value["contentItems"][2], raw["contentItems"][2]);
        assert!(prepared.value.to_string().len() < 20000);
        assert!(
            prepared
                .value
                .to_string()
                .contains("selectedOutputTruncated")
        );
        assert_eq!(prepared.metrics["transform"], "native-program-preview-v2");
        let turn: Turn = serde_json::from_value(json!({"id":"turn","status":"completed","items":[{
            "type":"dynamicToolCall","id":"program-item","tool":"tool_program","callId":"parent","arguments":{},"status":"completed","success":false,
            "contentItems":prepared.value["contentItems"],
            "execution":{"runtimeEpoch":"epoch","scopeId":"scope","operationId":"op","outcome":"failed","resultSnapshot":prepared.snapshot}
        }]})).unwrap();
        cell.state.lock().await.thread.turns.push(turn);
        let mut args = json!({"resultId":"program-item","maxBytes":997});
        let mut full = String::new();
        loop {
            let page = engine.read_tool_result(&cell, &args).await.unwrap();
            full.push_str(page["text"].as_str().unwrap());
            if page["eof"] == true {
                break;
            }
            args["after"] = page["nextCursor"].clone();
        }
        assert_eq!(serde_json::from_str::<Value>(&full).unwrap(), raw);
        // 禁止回取时不创建一个无法兑现的缩略引用，也不伪造重新执行。
        cell.state
            .lock()
            .await
            .thread
            .turns
            .last_mut()
            .unwrap()
            .configuration
            .get_or_insert_with(Default::default)
            .tool_allowlist = Some(vec!["tool_program".into(), "fs_stat".into()]);
        let unshortened = engine
            .prepare_program_result(&cell, "unretrievable", &raw)
            .await
            .unwrap();
        assert_eq!(unshortened.value, raw);
        assert!(unshortened.snapshot.is_none());
        engine.shutdown().await;
    }

    #[test]
    fn grouping_keeps_unique_middle_evidence_and_order() {
        let rows: Vec<Value> = (1..=80).map(|line|json!({"path":"src/a/very/long/path/configuration.rs","line":line,"kind":"match","text":if line==41 {"the selected value is violet"} else {"value = red"}})).collect();
        let raw = json!({"matches":rows,"limited":true,"guidance":"narrow path"});
        let (_, view) = search_groups(&raw).unwrap();
        assert_eq!(
            view["matchGroups"][0]["rows"][40],
            json!([41, "match", "the selected value is violet"])
        );
        assert_eq!(view["limited"], true);
        assert_eq!(view["matchGroups"][0]["rows"].as_array().unwrap().len(), 80);
        let mut extended = raw;
        extended["matches"][0]["unexpected"] = json!("must not disappear");
        assert!(search_groups(&extended).is_none());
        assert!(search_groups(&json!({"stdout":"12:30:20 log"})).is_none());
    }

    #[test]
    fn exact_runs_preserve_marker_like_text_unicode_and_last_line() {
        let raw = json!({"stdout":format!("{}{}","重复 [repeat: 100] ⇢\n".repeat(200),"literal without newline"),"stderr":"\u{1b}[31mFAIL\u{1b}[0m\n    - old\n    + new\n","gap":false,"truncated":false});
        let (_, view) = repeat_lines(&raw).unwrap();
        let restored: String = view["stdoutRuns"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                r[1].as_str()
                    .unwrap()
                    .repeat(r[0].as_u64().unwrap() as usize)
            })
            .collect();
        assert_eq!(restored, raw["stdout"]);
        assert_eq!(view["stderr"], raw["stderr"]);
        let mut incomplete = raw;
        incomplete["gap"] = json!(true);
        assert!(repeat_lines(&incomplete).is_none());
    }

    #[test]
    fn pages_fit_final_json_budget_and_restore_every_byte() {
        let text = format!("{}tail", "\"\\\u{1}中文🙂\n".repeat(5000));
        let mut offset = 0;
        let mut restored = String::new();
        loop {
            let page = result_page("result", &text, offset, 8192).unwrap();
            assert!(page.to_string().len() <= MAX_RESULT - 1024);
            assert!(page["bytes"].as_u64().unwrap() <= 8192);
            restored.push_str(page["text"].as_str().unwrap());
            if page["eof"] == true {
                break;
            }
            let next: usize = page["nextCursor"]
                .as_str()
                .unwrap()
                .strip_prefix("result:")
                .unwrap()
                .parse()
                .unwrap();
            assert!(next > offset);
            offset = next;
        }
        assert_eq!(restored, text);
        assert!(result_page("r", "中文", 1, 8192).is_err());
    }

    #[tokio::test]
    async fn modes_measure_without_rewriting_and_failure_keeps_bounded_original() {
        let rows:Vec<Value>=(0..60).map(|line|json!({"path":"src/a/long/configuration/path/repeated.rs","line":line,"kind":"match","text":"keep every value"})).collect();
        let raw = json!({"matches":rows,"limited":false});
        for mode in [
            ResultViewMode::Off,
            ResultViewMode::Observe,
            ResultViewMode::On,
        ] {
            let directory = tempfile::tempdir().unwrap();
            let mut extensions = ToolExtensions::default();
            extensions.policy.result_views.mode = mode;
            let engine = Engine::open_with_extensions(
                directory.path(),
                Arc::new(NoModel),
                Limits::default(),
                None,
                extensions,
            )
            .unwrap();
            let thread = engine.create("/fixture".into()).await.unwrap();
            let cell = engine.cell(&thread.id).await.unwrap();
            let prepared = engine
                .prepare_tool_result(&cell, "call", "search_files", &raw, None)
                .await
                .unwrap();
            if mode == ResultViewMode::On {
                assert_eq!(prepared.metrics["reason"], "applied");
                assert!(prepared.value["matchGroups"].is_array());
                assert!(prepared.value.to_string().len() < raw.to_string().len());
            } else {
                assert_eq!(prepared.value["matches"], raw["matches"]);
                assert_eq!(prepared.value, raw, "未应用候选时不向模型增加回取包装");
                assert_eq!(
                    prepared.metrics["reason"],
                    if mode == ResultViewMode::Off {
                        "passthrough"
                    } else {
                        "observe"
                    }
                );
            }
            std::fs::rename(
                directory.path().join("blobs"),
                directory.path().join("saved-blobs"),
            )
            .unwrap();
            std::fs::write(directory.path().join("blobs"), b"storage failure").unwrap();
            let large = json!("x".repeat(MAX_RESULT * 2));
            let fallback = engine
                .prepare_tool_result(&cell, "other", "fixture", &large, None)
                .await
                .unwrap();
            assert!(fallback.snapshot.is_none());
            assert_eq!(fallback.metrics["reason"], "snapshotUnavailable");
            assert_eq!(fallback.value["rawAvailable"], false);
            assert!(fallback.value.to_string().len() <= MAX_RESULT);
            engine.shutdown().await;
        }
    }

    #[tokio::test]
    async fn candidate_savings_use_the_unwrapped_baseline() {
        let directory = tempfile::tempdir().unwrap();
        let mut extensions = ToolExtensions::default();
        extensions.policy.result_views.mode = ResultViewMode::On;
        let engine = Engine::open_with_extensions(
            directory.path(),
            Arc::new(NoModel),
            Limits::default(),
            None,
            extensions,
        )
        .unwrap();
        let thread = engine.create("/fixture".into()).await.unwrap();
        let cell = engine.cell(&thread.id).await.unwrap();
        for count in [4, 5, 6, 7, 8, 16, 80] {
            let raw = json!({"matches":(1..=count).map(|n|json!({"path":"src/components/serialization/nested/configuration/reader.rs","line":n,"kind":"match","text":"关键值\n"})).collect::<Vec<_>>(),"limited":false});
            let prepared = engine
                .prepare_tool_result(
                    &cell,
                    "search-call-with-a-realistic-identifier",
                    "search_files",
                    &raw,
                    None,
                )
                .await
                .unwrap();
            println!(
                "search rows={count} raw={} displayed={} reason={}",
                raw.to_string().len(),
                prepared.value.to_string().len(),
                prepared.metrics["reason"]
            );
            if prepared.value != raw {
                assert!(
                    worthwhile(&raw.to_string(), &prepared.value.to_string()),
                    "最终候选必须对原始结果满足净节省门槛"
                );
            }
        }
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn file_projection_counts_retrieval_metadata_in_savings() {
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path(), Arc::new(NoModel), Limits::default()).unwrap();
        let thread = engine.create("/fixture".into()).await.unwrap();
        let cell = engine.cell(&thread.id).await.unwrap();
        for count in [9, 12, 16, 32, 80] {
            let raw = json!({"path":"src/配置.rs","fileVersion":"observed-handle",
                "lines":(1..=count).map(|n|json!({"number":n,"text":"value = '中文';\n"})).collect::<Vec<_>>()});
            let prepared = engine
                .prepare_tool_result(
                    &cell,
                    "file-call-with-a-realistic-identifier",
                    "read_file",
                    &raw,
                    None,
                )
                .await
                .unwrap();
            let raw_bytes = raw.to_string().len();
            let displayed_bytes = prepared.value.to_string().len();
            println!("file lines={count} raw={raw_bytes} displayed={displayed_bytes}");
            if prepared.value != raw {
                assert!(
                    displayed_bytes + 128 < raw_bytes,
                    "回取元数据也必须计入文件行视图的净节省: {displayed_bytes} vs {raw_bytes}"
                );
                assert_eq!(prepared.value["fileVersion"], raw["fileVersion"]);
                assert!(prepared.snapshot.is_some());
            }
        }
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn file_projection_preserves_original_and_can_be_disabled() {
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path(), Arc::new(NoModel), Limits::default()).unwrap();
        let thread = engine.create("/fixture".into()).await.unwrap();
        let cell = engine.cell(&thread.id).await.unwrap();
        let raw = json!({"path":"src/a.js","sha256":"observed","fileVersion":"edit-handle","lines":(1..=80).map(|n|json!({"number":n,"text":format!("const x{n} = '中文';\n")})).collect::<Vec<_>>()});
        let prepared = engine
            .prepare_tool_result(&cell, "file-call", "read_file", &raw, None)
            .await
            .unwrap();
        assert_eq!(prepared.metrics["reason"], "lossless");
        assert_eq!(prepared.value["fileVersion"], "edit-handle");
        assert!(prepared.value.to_string().len() < raw.to_string().len());
        let turn: Turn = serde_json::from_value(json!({"id":"turn","status":"completed","items":[{
            "type":"dynamicToolCall","id":"file-call","tool":"read_file","callId":"call","arguments":{},"status":"completed","success":true,
            "contentItems":[{"type":"inputText","text":prepared.value.to_string()}],
            "execution":{"runtimeEpoch":"epoch","scopeId":"scope","operationId":"op","outcome":"succeeded","resultSnapshot":prepared.snapshot}
        }]})).unwrap();
        cell.state.lock().await.thread.turns.push(turn);
        let page = engine
            .read_tool_result(&cell, &json!({"resultId":"file-call"}))
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(page["text"].as_str().unwrap()).unwrap(),
            raw
        );
        engine.shutdown().await;
        let mut extensions = ToolExtensions::default();
        extensions.policy.result_views.file_lines = false;
        let other = tempfile::tempdir().unwrap();
        let engine = Engine::open_with_extensions(
            other.path(),
            Arc::new(NoModel),
            Limits::default(),
            None,
            extensions,
        )
        .unwrap();
        let thread = engine.create("/fixture".into()).await.unwrap();
        let prepared = engine
            .prepare_tool_result(
                &engine.cell(&thread.id).await.unwrap(),
                "file",
                "read_file",
                &raw,
                None,
            )
            .await
            .unwrap();
        assert_eq!(prepared.value, raw);
        assert!(prepared.snapshot.is_none());
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn quota_failures_never_publish_a_retrieval_reference() {
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path(), Arc::new(NoModel), Limits::default()).unwrap();
        let thread = engine.create("/fixture".into()).await.unwrap();
        let cell = engine.cell(&thread.id).await.unwrap();
        let large = json!({"text":"x".repeat(MAX_SNAPSHOT)});
        let prepared = engine
            .prepare_tool_result(&cell, "oversize", "fixture", &large, None)
            .await
            .unwrap();
        assert_eq!(prepared.metrics["reason"], "snapshotQuota");
        assert_eq!(prepared.value["rawAvailable"], false);
        assert!(prepared.snapshot.is_none());
        let turn:Turn=serde_json::from_value(json!({"id":"turn","status":"completed","items":[{
            "type":"dynamicToolCall","id":"old","tool":"fixture","callId":"call","arguments":{},"status":"completed","success":true,
            "execution":{"runtimeEpoch":"epoch","scopeId":"scope","operationId":"op","outcome":"succeeded","resultSnapshot":{"uri":"areal://blob/old","mimeType":"application/json","sizeBytes":32 * 1024 * 1024}}
        }]})).unwrap();
        cell.state.lock().await.thread.turns.push(turn);
        let scalar = json!("large scalar ".repeat(2000));
        let prepared = engine
            .prepare_tool_result(&cell, "new", "fixture", &scalar, None)
            .await
            .unwrap();
        assert!(prepared.snapshot.is_some());
        // 历史快照总量不构成隐式累计预算。
        let replaced = engine
            .prepare_tool_result(&cell, "old", "fixture", &scalar, None)
            .await
            .unwrap();
        assert!(replaced.snapshot.is_some());
        assert_eq!(replaced.value["rawAvailable"], true);
        cell.state.lock().await.thread.turns[0].configuration =
            Some(areal_protocol::desktop::EffectiveConfig {
                tool_allowlist: Some(vec!["fixture".into()]),
                ..Default::default()
            });
        let hidden = engine
            .prepare_tool_result(&cell, "blocked", "fixture", &scalar, None)
            .await
            .unwrap();
        assert_eq!(hidden.metrics["reason"], "retrievalDisabled");
        assert_eq!(hidden.value["rawAvailable"], false);
        assert!(hidden.snapshot.is_none());
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn original_survives_restart_and_gc_but_not_cross_thread_access() {
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::open(directory.path(), Arc::new(NoModel), Limits::default()).unwrap();
        let thread = engine.create("/fixture".into()).await.unwrap();
        let other = engine.create("/fixture".into()).await.unwrap();
        let cell = engine.cell(&thread.id).await.unwrap();
        let raw = json!({"text":format!("{}needle{}","a".repeat(20000),"z".repeat(20000)),"sha256":"old-file-version"});
        let prepared = engine
            .prepare_tool_result(&cell, "saved-call", "mcp_fixture", &raw, None)
            .await
            .unwrap();
        assert_eq!(prepared.value["rawAvailable"], true);
        let snapshot = prepared.snapshot.unwrap();
        let turn:Turn=serde_json::from_value(json!({"id":"turn","status":"completed","items":[{
            "type":"dynamicToolCall","id":"saved-call","tool":"mcp_fixture","callId":"call","arguments":{},"status":"completed","success":true,
            "contentItems":[{"type":"inputText","text":prepared.value.to_string()}],
            "execution":{"runtimeEpoch":"old-epoch","scopeId":"old-scope","operationId":"op","outcome":"succeeded","resultSnapshot":snapshot}
        }]})).unwrap();
        {
            let mut state = cell.state.lock().await;
            state.thread.turns.push(turn);
            engine.persist(&state.thread).await.unwrap();
        }
        assert!(
            engine
                .read_tool_result(
                    &engine.cell(&other.id).await.unwrap(),
                    &json!({"resultId":"saved-call"})
                )
                .await
                .is_err()
        );
        assert!(
            engine
                .read_tool_result(&cell, &json!({"resultId":"saved-call","after":"other:0"}))
                .await
                .is_err()
        );
        engine.shutdown().await;
        drop(cell);
        drop(engine);
        let engine = Engine::open(directory.path(), Arc::new(NoModel), Limits::default()).unwrap();
        engine.store.collect_blobs().await.unwrap();
        let cell = engine.cell(&thread.id).await.unwrap();
        let mut args = json!({"resultId":"saved-call"});
        let mut collected = String::new();
        loop {
            let page = engine.read_tool_result(&cell, &args).await.unwrap();
            collected.push_str(page["text"].as_str().unwrap());
            if page["eof"] == true {
                break;
            }
            args["after"] = page["nextCursor"].clone();
        }
        assert_eq!(serde_json::from_str::<Value>(&collected).unwrap(), raw);
        assert!(cell.state.lock().await.active.is_none());
        let path = engine
            .store
            .blob_path(snapshot.uri.strip_prefix("areal://blob/").unwrap())
            .unwrap();
        std::fs::write(path, b"corrupt").unwrap();
        assert!(
            engine
                .read_tool_result(&cell, &json!({"resultId":"saved-call"}))
                .await
                .is_err()
        );
        engine.shutdown().await;
    }
}

// 必须先执行只读操作再比较；不省略 I/O、不复用旧版本、不折叠错误或进程输出。
fn observation_key(name: &str, raw: &Value) -> Option<String> {
    if raw.get("error").is_some() || raw.to_string().len() < 1024 {
        return None;
    }
    let body = match name {
        "read_file" if raw["sha256"].is_string() && raw["lines"].is_array() => {
            json!({"path":raw["path"],"sha256":raw["sha256"],"offset":raw["offset"],"lines":raw["lines"],"nextLine":raw["nextLine"],"nextColumn":raw["nextColumn"],"nextRead":raw["nextRead"],"eof":raw["eof"],"truncated":raw["truncated"]})
        }
        "environment_info" if raw["fingerprint"].is_string() => {
            json!({"fingerprint":raw["fingerprint"]})
        }
        _ => return None,
    };
    Some(format!("{name}:{:x}", Sha256::digest(body.to_string())))
}

#[cfg(test)]
mod observation_tests {
    use super::*;
    #[test]
    fn repeated_observation_key_is_content_and_range_bound_but_preserves_new_versions() {
        let mut value = json!({"path":"workspace://repo/a", "sha256":"a", "fileVersion":"v1", "offset":1,"nextLine":2,"eof":true,"lines":[{"number":1,"text":"x".repeat(1600)}]});
        let key = observation_key("read_file", &value).unwrap();
        value["fileVersion"] = json!("v2");
        assert_eq!(observation_key("read_file", &value).unwrap(), key);
        for (field, next) in [
            ("sha256", json!("b")),
            ("offset", json!(2)),
            ("path", json!("workspace://repo/b")),
        ] {
            let mut changed = value.clone();
            changed[field] = next;
            assert_ne!(observation_key("read_file", &changed).unwrap(), key);
        }
        value["error"] = json!("permission denied");
        assert!(observation_key("read_file", &value).is_none());
        assert!(observation_key("run_command", &value).is_none());
    }
}

#[cfg(test)]
mod repeated_projection_tests {
    use super::*;
    struct PendingModel(Arc<tokio::sync::Notify>);
    #[async_trait::async_trait]
    impl Model for PendingModel {
        fn name(&self) -> &str {
            "pending-fixture"
        }
        async fn stream(&self, _: Vec<Message>) -> anyhow::Result<model::ModelStream> {
            self.0.notify_one();
            Ok(Box::pin(futures_util::stream::pending()))
        }
    }
    #[tokio::test]
    async fn repeated_read_retains_new_version_and_retrievable_full_observation() {
        let directory = tempfile::tempdir().unwrap();
        let mut extensions = ToolExtensions::default();
        extensions.policy.result_views.repeated_observations = true;
        let entered = Arc::new(tokio::sync::Notify::new());
        let engine = Engine::open_with_extensions(
            directory.path(),
            Arc::new(PendingModel(entered.clone())),
            Limits::default(),
            None,
            extensions,
        )
        .unwrap();
        let thread = engine.create("/fixture".into()).await.unwrap();
        engine
            .start(&thread.id, vec![Input::text("observe")])
            .await
            .unwrap();
        // 先让模型进入等待，避免 fixture 改写历史触发并发请求组装的重启清空。
        tokio::time::timeout(Duration::from_secs(10), entered.notified())
            .await
            .unwrap();
        let cell = engine.cell(&thread.id).await.unwrap();
        let mut raw = json!({"path":"workspace://repo/a","sha256":"same","fileVersion":"first", "offset":1,"nextLine":51,"eof":true,"lines":(1..=50).map(|n|json!({"number":n,"text":"a sufficiently long line of unchanged source text\n"})).collect::<Vec<_>>()});
        let child: Item = serde_json::from_value(json!({"type":"dynamicToolCall","id":"program-only","tool":"read_file","callId":"program-only","arguments":{},"status":"completed","success":true,"execution":{"runtimeEpoch":"epoch","scopeId":"scope","operationId":"operation","outcome":"succeeded","parentCallId":"parent"}})).unwrap();
        cell.state
            .lock()
            .await
            .thread
            .turns
            .last_mut()
            .unwrap()
            .items
            .push(child);
        for _ in 0..2 {
            let child = engine
                .prepare_tool_result(&cell, "program-only", "read_file", &raw, None)
                .await
                .unwrap();
            assert!(child.value.get("unchangedObservation").is_none());
        }
        let first = engine
            .prepare_tool_result(&cell, "first", "read_file", &raw, None)
            .await
            .unwrap();
        assert!(first.value.get("unchangedObservation").is_none());
        // 同一调用会先提交事实再处理后置 hook；投影重入不能把首个结果折叠成自己。
        let first_again = engine
            .prepare_tool_result(&cell, "first", "read_file", &raw, None)
            .await
            .unwrap();
        assert_eq!(first_again.value, first.value);
        raw["fileVersion"] = json!("fresh-version");
        let second = engine
            .prepare_tool_result(&cell, "second", "read_file", &raw, None)
            .await
            .unwrap();
        assert_eq!(second.value["fileVersion"], "fresh-version");
        assert_eq!(second.value["nextLine"], 51);
        assert_eq!(
            second.value["unchangedObservation"]["previousResultId"],
            "first"
        );
        assert!(second.value.to_string().len() < first.value.to_string().len());
        let item: Item = serde_json::from_value(json!({"type":"dynamicToolCall","id":"second","tool":"read_file","callId":"second","arguments":{},"status":"completed","success":true,"contentItems":[{"type":"inputText","text":second.value.to_string()}],"execution":{"runtimeEpoch":"epoch","scopeId":"scope","operationId":"operation","outcome":"succeeded","resultSnapshot":second.snapshot}})).unwrap();
        cell.state
            .lock()
            .await
            .thread
            .turns
            .last_mut()
            .unwrap()
            .items
            .push(item);
        let page = engine
            .read_tool_result(&cell, &json!({"resultId":"second"}))
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(page["text"].as_str().unwrap()).unwrap(),
            raw
        );
        raw["sha256"] = json!("changed");
        assert!(
            engine
                .prepare_tool_result(&cell, "third", "read_file", &raw, None)
                .await
                .unwrap()
                .value
                .get("unchangedObservation")
                .is_none()
        );
        engine.shutdown().await;
    }
}
