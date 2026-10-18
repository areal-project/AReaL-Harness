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
            .context("history item is not in this thread")?;
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
        let started = std::time::Instant::now();
        let bytes = serde_json::to_vec(raw)?;
        let policy = &self.extensions.policy.result_views;
        // 无损行格式在首次记录时确定，历史回放不重写旧 provider 上下文。
        let mut baseline = if name == "read_file" && policy.file_lines {
            crate::history::compact_file_text(&raw.to_string())
                .and_then(|v| serde_json::from_str(&v).ok())
                .unwrap_or_else(|| raw.clone())
        } else {
            raw.clone()
        };
        let file_compacted = baseline != *raw;
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
        let needs_snapshot = bytes.len() > MAX_RESULT || baseline != *raw || candidate.is_some();
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
            if !readback_allowed {
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
        if snapshot.is_none() && value != *raw {
            value = raw.clone();
        }
        if let Some(reference) = &reference {
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
        let mut kind = if file_compacted {
            "file-lines-v1"
        } else {
            "none"
        };
        if file_compacted && snapshot.is_some() {
            reason = "lossless";
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
        if value.to_string().len() > MAX_RESULT {
            // 先装入可信回取引用，再分配头尾预算；不能让通用截断删掉回取入口。
            let full = value.to_string();
            value = bounded_snapshot(&full, reference);
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
        let text = String::from_utf8(bytes)?;
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

    #[tokio::test]
    #[ignore = "通过 tests/perf/result_view_report.py --replay 显式回放本地原文"]
    async fn replay_saved_originals() {
        let input = std::env::var("AREAL_RESULT_REPLAY_INPUT").unwrap();
        let output = std::env::var("AREAL_RESULT_REPLAY_OUTPUT").unwrap();
        let records: Vec<Value> = serde_json::from_slice(&std::fs::read(input).unwrap()).unwrap();
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
            measurements.push(
                json!({"id":record["id"],"tool":record["tool"],"projection":prepared.metrics}),
            );
        }
        std::fs::write(output, serde_json::to_vec_pretty(&measurements).unwrap()).unwrap();
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
