use super::*;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

struct Version {
    path: String,
    before: String,
    after: String,
}
fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
fn succeeded(item: &Value) -> bool {
    item["type"] == "dynamicToolCall"
        && item["status"] == "completed"
        && item["success"] == true
        && item["execution"]["backend"] == "runtime"
        && item["execution"]["outcome"] == "succeeded"
}
fn write_tool(tool: &str) -> bool {
    matches!(
        tool,
        "fs_create" | "fs_write" | "fs_apply_patch" | "fs_apply_patches"
    )
}
fn versions(turn: &Value, item_id: Option<&str>) -> Result<Vec<Version>> {
    ensure!(
        turn["status"] == "completed",
        "historical Turn is incomplete"
    );
    let items = turn["items"].as_array().context("missing native items")?;
    if let Some(id) = item_id {
        let selected: Vec<_> = items.iter().filter(|item| item["id"] == id).collect();
        ensure!(
            selected.len() == 1
                && succeeded(selected[0])
                && write_tool(selected[0]["tool"].as_str().unwrap_or_default()),
            "selected Item is not a verified write"
        );
    }
    let mut observed: HashMap<String, String> = HashMap::new();
    let mut changed: Vec<Version> = vec![];
    for item in items {
        if !succeeded(item) {
            continue;
        }
        let tool = item["tool"].as_str().unwrap_or_default();
        if !write_tool(tool) && tool != "fs_read" {
            continue;
        }
        let parts: Vec<_> = item["contentItems"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|part| matches!(part["type"].as_str(), Some("inputText" | "text")))
            .collect();
        ensure!(parts.len() == 1, "missing native result");
        let result: Value = serde_json::from_str(
            parts[0]["text"]
                .as_str()
                .context("missing native result text")?,
        )?;
        let args = item["execution"]
            .get("effectiveArguments")
            .unwrap_or(&item["arguments"]);
        ensure!(args.is_object(), "invalid effective arguments");
        let uri = result["path"].as_str().context("missing result path")?;
        let path = uri
            .strip_prefix("workspace://repo/")
            .context("non-workspace result")?;
        ensure!(
            args["path"] == uri
                && !path.is_empty()
                && !path.contains(['\r', '\n', '\t'])
                && path.split('/').all(|part| !matches!(part, "" | "." | "..")),
            "unverified native path"
        );
        let digest = result["sha256"].as_str().context("missing native digest")?;
        ensure!(
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
            "invalid native digest"
        );
        let size = result["size"]
            .as_u64()
            .filter(|size| *size <= 8 * 1024 * 1024)
            .context("invalid native byte length")? as usize;
        if tool == "fs_read" {
            let offset = args.get("offset").filter(|value| !value.is_null());
            let Some(text) = result["text"].as_str().filter(|text| {
                offset.is_none_or(|value| value.as_u64() == Some(0))
                    && result["eof"] == true
                    && text.len() == size
                    && hash(text) == digest
            }) else {
                continue;
            };
            ensure!(
                changed
                    .iter()
                    .find(|version| version.path == path)
                    .is_none_or(|version| hash(&version.after) == digest),
                "external change between native tools"
            );
            observed.insert(path.into(), text.into());
            continue;
        }
        // Remote 不提供 fileBefores；不能将当前磁盘或未验证 blob 充当写前版本。
        ensure!(
            item["execution"].get("fileBefore").is_none(),
            "historical before bytes are unavailable"
        );
        let patch = matches!(tool, "fs_apply_patch" | "fs_apply_patches");
        let creation =
            !patch && (tool == "fs_create" || args.get("expectedSha256") == Some(&Value::Null));
        let previous = observed.get(path);
        if !creation {
            ensure!(
                previous.is_some_and(
                    |text| args["expectedSha256"].as_str() == Some(hash(text).as_str())
                ),
                "missing verified before version"
            );
        }
        let after = if patch {
            let patches = args["patches"]
                .as_array()
                .filter(|patches| (1..=32).contains(&patches.len()))
                .context("invalid recorded patches")?;
            let mut after = previous.context("missing patch before version")?.clone();
            for patch in patches {
                let old = patch["oldText"]
                    .as_str()
                    .filter(|old| !old.is_empty())
                    .context("invalid old patch text")?;
                let new = patch["newText"]
                    .as_str()
                    .context("invalid new patch text")?;
                ensure!(
                    after.find(old).is_some() && after.find(old) == after.rfind(old),
                    "recorded patch is not unique"
                );
                after = after.replacen(old, new, 1);
            }
            after
        } else {
            ensure!(
                !creation || changed.iter().all(|version| version.path != path),
                "repeated native creation"
            );
            args["text"]
                .as_str()
                .context("missing native write text")?
                .into()
        };
        ensure!(
            after.len() == size && hash(&after) == digest,
            "write result does not match native confirmation"
        );
        let before = if creation {
            String::new()
        } else {
            previous.unwrap().clone()
        };
        if item_id.is_some_and(|id| item["id"] == id) {
            return Ok(vec![Version {
                path: path.into(),
                before,
                after,
            }]);
        }
        observed.insert(path.into(), after.clone());
        if let Some(version) = changed.iter_mut().find(|version| version.path == path) {
            version.after = after;
        } else {
            changed.push(Version {
                path: path.into(),
                before,
                after,
            });
        }
    }
    Ok(changed)
}

struct ReviewScratch(std::path::PathBuf);
impl Drop for ReviewScratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn range(value: &str) -> Result<(u64, u64)> {
    let (start, count) = value.split_once(',').unwrap_or((value, "1"));
    Ok((start.parse()?, count.parse()?))
}
fn hunks(diff: &str) -> Result<(Vec<Value>, u64, u64)> {
    let mut hunks: Vec<Value> = vec![];
    let mut old_line = 0;
    let mut new_line = 0;
    let mut additions = 0;
    let mut deletions = 0;
    for line in diff.split_terminator('\n') {
        if let Some(header) = line.strip_prefix("@@ -") {
            let (old, rest) = header
                .split_once(" +")
                .context("invalid historical diff hunk")?;
            let (new, _) = rest
                .split_once(" @@")
                .context("invalid historical diff hunk")?;
            let (old_start, old_lines) = range(old)?;
            let (new_start, new_lines) = range(new)?;
            old_line = old_start;
            new_line = new_start;
            hunks.push(json!({"oldStart":old_start,"oldLines":old_lines,"newStart":new_start,"newLines":new_lines,"lines":[]}));
            continue;
        }
        let Some(hunk) = hunks.last_mut() else {
            continue;
        };
        let kind = match line.as_bytes().first() {
            Some(b'+') => {
                additions += 1;
                "add"
            }
            Some(b'-') => {
                deletions += 1;
                "del"
            }
            Some(b' ') => "context",
            Some(b'\\') => "meta",
            _ => anyhow::bail!("invalid historical diff line"),
        };
        let old = if matches!(kind, "del" | "context") {
            let line = old_line;
            old_line += 1;
            Some(line)
        } else {
            None
        };
        let new = if matches!(kind, "add" | "context") {
            let line = new_line;
            new_line += 1;
            Some(line)
        } else {
            None
        };
        hunk["lines"]
            .as_array_mut()
            .unwrap()
            .push(json!({"kind":kind,"text":&line[1..],"oldLine":old,"newLine":new}));
    }
    Ok((hunks, additions, deletions))
}
async fn historical_diff(
    home: &std::path::Path,
    turn: &Value,
    item_id: Option<&str>,
) -> Result<Value> {
    use std::io::Write;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let versions = versions(turn, item_id)?;
    ensure!(
        versions
            .iter()
            .all(|version| !version.before.contains('\0') && !version.after.contains('\0')),
        "binary historical version"
    );
    let scratch = ReviewScratch(home.join(format!("review-{}", uuid::Uuid::new_v4())));
    std::fs::DirBuilder::new().mode(0o700).create(&scratch.0)?;
    let before = scratch.0.join("before");
    let after = scratch.0.join("after");
    let mut files = vec![];
    for version in versions {
        if version.before == version.after {
            continue;
        }
        for (path, text) in [(&before, &version.before), (&after, &version.after)] {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(path)?;
            file.write_all(text.as_bytes())?;
        }
        // 仅比较经 Core 回执验证的临时版本，不让 Git 读取工作区或执行外部 diff。
        let output = tokio::time::timeout(
            Duration::from_secs(10),
            tokio::process::Command::new("git")
                .args([
                    "-c",
                    "core.autocrlf=false",
                    "diff",
                    "--no-index",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--no-color",
                    "--no-renames",
                    "--no-indent-heuristic",
                    "--diff-algorithm=myers",
                    "--unified=4",
                    "--",
                ])
                .arg(&before)
                .arg(&after)
                .current_dir(&scratch.0)
                .env("LC_ALL", "C")
                .kill_on_drop(true)
                .output(),
        )
        .await??;
        ensure!(
            output.status.code() == Some(1) && output.stdout.len() <= 4 * 1024 * 1024,
            "historical diff unavailable"
        );
        let (hunks, additions, deletions) = hunks(std::str::from_utf8(&output.stdout)?)?;
        files.push(
            json!({"path":version.path,"hunks":hunks,"additions":additions,"deletions":deletions}),
        );
    }
    if files.is_empty() {
        return Ok(
            json!({"state":"unavailable","notice":"没有可重建的 Runtime 文本写入；Shell、重命名、删除、二进制及缺少写前版本的变更不可用。"}),
        );
    }
    let version = format!(
        "turn:{}{}",
        text(turn, "id")?,
        item_id.map(|id| format!(":item:{id}")).unwrap_or_default()
    );
    Ok(
        json!({"state":"available","scope":if item_id.is_some(){"tool"}else{"last-turn"},"base":format!("{version}:before"),"head":format!("{version}:after"),"notice":if item_id.is_some(){"仅显示该次可验证的文件工具修改，不使用当前磁盘版本。"}else{"仅显示本轮可验证的文件工具修改；Shell 或外部编辑不计入。"},"provenance":"verified-runtime-file-writes","files":files}),
    )
}

impl Session {
    pub(super) async fn review(
        &mut self,
        project: &str,
        generation: &str,
        params: &Value,
    ) -> Result<Value> {
        self.authorize(Some(project), "review")?;
        ensure!(
            exact(params, &["threadId", "turnId", "itemId", "cursor", "limit"]),
            "INVALID_PARAMS"
        );
        let thread_id = text(params, "threadId")?;
        let turn_id = text(params, "turnId")?;
        let (id, _) = self.project(project)?;
        let identity = self
            .host
            .schedules
            .connections
            .shared_identity(&self.host, &id)?;
        let response = self
            .rpc(
                project,
                generation,
                "thread/read",
                json!({"threadId":thread_id,"includeTurns":true}),
            )
            .await?;
        let thread = &response["thread"];
        let turn = thread["turns"]
            .as_array()
            .and_then(|turns| turns.iter().find(|turn| turn["id"] == turn_id))
            .context("RESOURCE_UNAVAILABLE")?;
        let items = turn["items"].as_array().context("RESOURCE_UNAVAILABLE")?;
        if let Some(id) = params.get("itemId") {
            ensure!(
                id.is_string() && items.iter().filter(|i| i["id"] == *id).count() == 1,
                "RESOURCE_UNAVAILABLE"
            );
        }
        let result:Vec<_>=items.iter().filter(|item|params.get("itemId").is_none_or(|id|item["id"]==*id)).filter(|i|matches!(i["type"].as_str(),Some("agentMessage"|"dynamicToolCall"))).map(|i|{
            let text=if i["type"]=="agentMessage"{i["text"].as_str().unwrap_or_default().to_owned()}else{i["contentItems"].as_array().map(|c|c.iter().filter(|c|matches!(c["type"].as_str(),Some("inputText"|"text"))).filter_map(|c|c["text"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default()};
            json!({"itemId":i["id"],"type":i["type"],"phase":i["phase"],"status":i["status"],"success":i["success"],"executionOutcome":i["execution"]["outcome"],"text":text})
        }).collect();
        let diff = historical_diff(&self.host.home, turn, params.get("itemId").and_then(Value::as_str)).await.unwrap_or_else(|_|json!({"state":"unavailable","notice":"此 Turn/Item 无法重建完整历史版本；不会使用当前工作区替代。"}));
        self.authorize(Some(project), "review")?;
        ensure!(
            self.project(project)?.1 == generation
                && self
                    .host
                    .schedules
                    .connections
                    .shared_identity(&self.host, &id)?
                    == identity,
            "RESYNC_REQUIRED"
        );
        let body = serde_json::to_string(
            &json!({"threadId":thread["id"],"turnId":turn["id"],"itemId":params["itemId"],"turnStatus":turn["status"],"error":turn["error"],"partial":turn["status"]!="completed","taskRunStatus":null,"notice":"原 Turn 输出；文本可读不代表成功。Task Run 状态需单独查看 Task，不能由此 Turn 推断。","result":result,"diff":diff,"artifactNotice":"最多列出 16 个具有原 Turn/Item 原生归属且不超过 16 MiB 的 PNG/JPEG/GIF/WebP；超出列表、动画或其他制品请在桌面查看。"}),
        )?;
        ensure!(body.len() <= 4 * 1024 * 1024, "RESOURCE_UNAVAILABLE");
        let target = json!({"threadId":thread_id,"turnId":turn_id,"itemId":params["itemId"]});
        let scope = self.scope(project, generation, &target, &body);
        let offset = self.offset(params.get("cursor"), &scope)?;
        ensure!(offset < body.len() || offset == 0, "INVALID_PARAMS");
        let limit = params
            .get("limit")
            .map(|n| n.as_u64().context("INVALID_PARAMS"))
            .transpose()?
            .unwrap_or(16384) as usize;
        ensure!((1..=16384).contains(&limit), "INVALID_PARAMS");
        let mut end = (offset + limit).min(body.len());
        while !body.is_char_boundary(end) {
            end -= 1;
        }
        ensure!(end > offset || end == body.len(), "INVALID_PARAMS");
        let next = if end < body.len() {
            Some(self.seal(scope, end)?)
        } else {
            None
        };
        self.authorize(Some(project), "review")?;
        let artifacts = self.review_artifacts(
            project,
            generation,
            thread,
            turn,
            params.get("itemId").and_then(Value::as_str),
            offset,
        )?;
        Ok(
            json!({"artifacts":artifacts,"projectId":project,"threadId":thread_id,"turnId":turn_id,"itemId":params["itemId"],"connectionId":self.connection,"gatewayGeneration":self.generation,"serviceGeneration":generation,"review":{"encoding":"json-utf8","offset":offset,"totalBytes":body.len(),"chunk":&body[offset..end]},"nextCursor":next}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str, tool: &str, args: Value, after: &str, extra: Value) -> Value {
        let mut result =
            json!({"path":"workspace://repo/native.txt","size":after.len(),"sha256":hash(after)});
        result
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        json!({"id":id,"type":"dynamicToolCall","tool":tool,"arguments":args,"status":"completed","success":true,"execution":{"backend":"runtime","outcome":"succeeded"},"contentItems":[{"type":"inputText","text":result.to_string()}]})
    }
    #[tokio::test]
    async fn original_native_records_rebuild_turn_and_selected_tool_hunks() {
        let read = record(
            "read",
            "fs_read",
            json!({"path":"workspace://repo/native.txt","offset":0}),
            "Before\n",
            json!({"text":"Before\n","eof":true}),
        );
        let write = record(
            "write",
            "fs_write",
            json!({"path":"workspace://repo/native.txt","text":"After\n","expectedSha256":hash("Before\n")}),
            "After\n",
            json!({}),
        );
        let patch = record(
            "patch",
            "fs_apply_patches",
            json!({"path":"workspace://repo/native.txt","patches":[{"oldText":"After","newText":"Final"}],"expectedSha256":hash("After\n")}),
            "Final\n",
            json!({}),
        );
        let turn = json!({"id":"turn","status":"completed","items":[read,write,patch]});
        let home = tempfile::tempdir().unwrap();
        let diff = historical_diff(home.path(), &turn, None).await.unwrap();
        assert_eq!(diff["state"], "available");
        assert_eq!(diff["base"], "turn:turn:before");
        assert_eq!(diff["files"][0]["path"], "native.txt");
        let lines = diff["files"][0]["hunks"][0]["lines"].as_array().unwrap();
        assert!(
            lines
                .iter()
                .any(|line| line["kind"] == "del" && line["text"] == "Before")
        );
        assert!(
            lines
                .iter()
                .any(|line| line["kind"] == "add" && line["text"] == "Final")
        );
        let selected = historical_diff(home.path(), &turn, Some("write"))
            .await
            .unwrap();
        assert_eq!(selected["scope"], "tool");
        assert!(
            selected["files"][0]["hunks"][0]["lines"]
                .as_array()
                .unwrap()
                .iter()
                .any(|line| line["kind"] == "add" && line["text"] == "After")
        );
        assert!(!diff.to_string().contains(home.path().to_str().unwrap()));
        assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 0);
    }
    #[test]
    fn effective_arguments_and_native_confirmation_are_authoritative() {
        let create = record(
            "create",
            "fs_create",
            json!({"path":"workspace://repo/native.txt","text":"Original\n"}),
            "Original\n",
            json!({}),
        );
        let mut turn = json!({"id":"turn","status":"completed","items":[create]});
        assert_eq!(versions(&turn, None).unwrap()[0].after, "Original\n");
        turn["items"][0]["execution"]["effectiveArguments"] = Value::Null;
        assert!(versions(&turn, None).is_err());
        turn["items"][0]["execution"]
            .as_object_mut()
            .unwrap()
            .remove("effectiveArguments");
        turn["items"][0]["arguments"]["path"] = json!("workspace://repo/other.txt");
        assert!(versions(&turn, None).is_err());
        turn["items"][0]["arguments"]["path"] = json!("workspace://repo/native.txt");
        turn["items"][0]["arguments"]["text"] = json!("unconfirmed replacement");
        assert!(versions(&turn, None).is_err());
        turn["items"][0]["execution"]["outcome"] = json!("unknown");
        assert!(versions(&turn, None).unwrap().is_empty());
        assert!(versions(&turn, Some("create")).is_err());
    }
    #[test]
    fn unsupported_or_missing_before_sources_never_substitute_workspace_bytes() {
        let write = record(
            "write",
            "fs_write",
            json!({"path":"workspace://repo/native.txt","text":"After\n","expectedSha256":hash("Before\n")}),
            "After\n",
            json!({}),
        );
        let mut turn = json!({"id":"turn","status":"completed","items":[write]});
        assert!(versions(&turn, None).is_err());
        turn["items"][0]["tool"] = json!("run_command");
        assert!(versions(&turn, None).unwrap().is_empty());
        turn["items"][0]["tool"] = json!("fs_create");
        turn["items"][0]["execution"]["fileBefore"] = json!({"uri":format!("areal://blob/{}",hash("Before\n")),"mimeType":"application/octet-stream","sizeBytes":7});
        assert!(versions(&turn, None).is_err());
    }
    #[tokio::test]
    async fn git_hunks_match_original_review_wire_for_line_endings_and_separate_edits() {
        let before_multi = (1..=24)
            .map(|line| format!("line {line}\n"))
            .collect::<String>();
        let after_multi = (1..=24)
            .map(|line| {
                if matches!(line, 2 | 22) {
                    format!("changed {line}\n")
                } else {
                    format!("line {line}\n")
                }
            })
            .collect::<String>();
        let crlf = json!([{"oldStart":1,"oldLines":1,"newStart":1,"newLines":1,"lines":[{"kind":"del","text":"Before\r","oldLine":1,"newLine":null},{"kind":"add","text":"After\r","oldLine":null,"newLine":1}]}]);
        let no_newline = json!([{"oldStart":1,"oldLines":1,"newStart":1,"newLines":1,"lines":[{"kind":"del","text":"Before","oldLine":1,"newLine":null},{"kind":"meta","text":" No newline at end of file","oldLine":null,"newLine":null},{"kind":"add","text":"After","oldLine":null,"newLine":1},{"kind":"meta","text":" No newline at end of file","oldLine":null,"newLine":null}]}]);
        let multi = json!([{"oldStart":1,"oldLines":6,"newStart":1,"newLines":6,"lines":[{"kind":"context","text":"line 1","oldLine":1,"newLine":1},{"kind":"del","text":"line 2","oldLine":2,"newLine":null},{"kind":"add","text":"changed 2","oldLine":null,"newLine":2},{"kind":"context","text":"line 3","oldLine":3,"newLine":3},{"kind":"context","text":"line 4","oldLine":4,"newLine":4},{"kind":"context","text":"line 5","oldLine":5,"newLine":5},{"kind":"context","text":"line 6","oldLine":6,"newLine":6}]},{"oldStart":18,"oldLines":7,"newStart":18,"newLines":7,"lines":[{"kind":"context","text":"line 18","oldLine":18,"newLine":18},{"kind":"context","text":"line 19","oldLine":19,"newLine":19},{"kind":"context","text":"line 20","oldLine":20,"newLine":20},{"kind":"context","text":"line 21","oldLine":21,"newLine":21},{"kind":"del","text":"line 22","oldLine":22,"newLine":null},{"kind":"add","text":"changed 22","oldLine":null,"newLine":22},{"kind":"context","text":"line 23","oldLine":23,"newLine":23},{"kind":"context","text":"line 24","oldLine":24,"newLine":24}]}]);
        for (before, after, expected, count) in [
            ("Before\r\n", "After\r\n", crlf, 1),
            ("Before", "After", no_newline, 1),
            (before_multi.as_str(), after_multi.as_str(), multi, 2),
        ] {
            let read = record(
                "read",
                "fs_read",
                json!({"path":"workspace://repo/native.txt"}),
                before,
                json!({"text":before,"eof":true}),
            );
            let write = record(
                "write",
                "fs_write",
                json!({"path":"workspace://repo/native.txt","text":after,"expectedSha256":hash(before)}),
                after,
                json!({}),
            );
            let turn = json!({"id":"turn","status":"completed","items":[read,write]});
            let home = tempfile::tempdir().unwrap();
            let diff = historical_diff(home.path(), &turn, None).await.unwrap();
            assert_eq!(diff["files"][0]["hunks"], expected);
            assert_eq!(diff["files"][0]["additions"], count);
            assert_eq!(diff["files"][0]["deletions"], count);
        }
    }
}
