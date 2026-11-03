//! 数据依赖、分支和等待由 JavaScript 编排，原生执行与事实仍归 Core/Runtime。
use super::registry::RegisteredTool;
use super::*;
use std::time::Instant;
mod js;

const MAX_CALLS: usize = 64;
const MAX_CODE: usize = 64 * 1024;
const MAX_TEXT: usize = 1024 * 1024;
const RECEIPT_RESERVE: usize = 96 * 1024;

pub(super) fn definition() -> areal_protocol::ToolDefinition {
    areal_protocol::ToolDefinition {
        name: "tool_program".into(),
        description: "Run bounded JavaScript with top-level await to compose native tools, use their returned data in subsequent calls, branch, loop, poll processes, and select observations. Prefer this for an already-decided sequence of at least two native calls; use a direct tool for a single operation. If a process is running and no independent work remains, wait inside the program using the normal wait budget instead of repeated one-second model status turns. Use tools.NAME(arguments). Each returns {success,outcome,callId,itemId,data,text,availableImages}; data is the parsed native JSON result, text is its text representation. Use text(value) to return selected observations; text(nativeResult) avoids duplicating parsed data and text. Use image(nativeResult) to forward actual images. Intermediate native outputs stay in durable history; retrieve by itemId with read_history when needed. All native calls retain their existing permissions, hooks, schemas, aliases and shared budgets. Calls execute serially, including Promise.all; no parallel resource increase. This is a fresh isolated interpreter with no Node, filesystem, network, timers, imports or persistent state. Maximum 64 native calls, 64 KiB code/arguments, 1 MiB archived text with a 16 KiB preview and read_tool_result reference, four image results; default 600 seconds, max 1800. Only declared tools are accessible. No automatic retries. UNKNOWN, cancellation, and exhausted budgets stop dispatch even if caught. Completed effects are retained on error. A program may inspect known failures but must report meaningful failures; mandatory receipts preserve every child outcome and process status. Await run/read_process as needed and inspect commandStatus/outputReadComplete before using generated files. When visual judgment or a new model decision is needed, emit images/relevant observations and finish. Large selected output is saved with a preview; retrieve it without rerunning completed effects. Do not conceal unresolved processes. Example after reading both files and choosing the test: const e=await tools.edit_files({files:[{path:'src/a.py',patches:[{oldText:'old_a',newText:'new_a'}]},{path:'src/b.py',patches:[{oldText:'old_b',newText:'new_b'}]}]}); text(e); if(e.success && e.data.allApplied){let r=await tools.run_command({argv:['python','-m','pytest','tests/test_feature.py','-q']}); text(r); for(let i=0;i<2 && r.success && (r.data.commandStatus==='running' || r.data.outputReadComplete===false);i++){r=await tools.read_process({processId:r.data.processId}); text(r);}} Return new errors for model judgment; do not auto-install, retry edits, or change the test. Known-range read example: for(const path of ['src/a.py','src/b.py']) text(await tools.read_file({path,offset:1,limit:80})); Return to the model before interpreting unfamiliar code.".into(),
        input_schema: json!({"type":"object","properties":{"code":{"type":"string","maxLength":65536},"timeoutMs":{"type":"integer","minimum":1,"maximum":1800000}},"required":["code"],"additionalProperties":false}),
        output_schema: None,
    }
}

fn eligible(entry: &RegisteredTool) -> bool {
    matches!(entry.backend, Backend::Builtin)
        || matches!(entry.backend, Backend::Core)
            && matches!(
                entry.definition.name.as_str(),
                "read_history" | "read_tool_result" | "edit_files"
            )
}

fn error(code: rt::ErrorCode, message: impl ToString) -> rt::Error {
    rt::Error::new(code, message.to_string())
}

fn receipt(item: &Item) -> Option<Value> {
    let Item::DynamicToolCall {
        id,
        tool,
        call_id,
        success,
        content_items,
        execution,
        ..
    } = item
    else {
        return None;
    };
    let mut result = json!({"tool":tool,"callId":call_id,"itemId":id,"success":success,"outcome":execution.outcome});
    // 进程状态属于必须保留的执行事实，不能由生成代码隐藏未完成效果。
    if let Some(data) = content_items.as_ref().and_then(|parts| {
        parts.iter().find_map(|part| {
            serde_json::from_str::<Value>(part["text"].as_str()?)
                .ok()
                .filter(|v| v.get("processId").is_some())
        })
    }) {
        for key in [
            "processId",
            "commandStatus",
            "outputReadComplete",
            "nextCursor",
            "exitCode",
        ] {
            if let Some(value) = data.get(key) {
                result[key] = value.clone();
            }
        }
    }
    Some(result)
}

pub(super) fn child_view(item: &Item) -> Value {
    let mut result = receipt(item).unwrap();
    let Item::DynamicToolCall { content_items, .. } = item else {
        unreachable!()
    };
    let parts = content_items.as_deref().unwrap_or_default();
    let text = parts
        .iter()
        .filter_map(|p| p["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    result["data"] = serde_json::from_str(&text).unwrap_or(Value::Null);
    result["text"] = json!(text);
    result["availableImages"] = json!(parts.iter().filter(|p| native_image(p)).count());
    result
}

fn native_image(part: &Value) -> bool {
    part["type"] == "inputImage" || (part["type"] == "arealMedia" && part["modality"] == "image")
}

fn child_receipts(items: &[Item], parent: &str) -> Vec<Value> {
    items.iter().filter(|item|matches!(item,Item::DynamicToolCall {execution,..} if execution.parent_call_id.as_deref() == Some(parent)))
        .filter_map(receipt).collect()
}

fn program_receipt(executed: usize, error: &Option<String>, receipts: &[Value]) -> Value {
    json!({"type":"inputText","text":json!({"executed":executed,"error":error,"children":receipts,"note":"Native receipts retained. read_history(itemId) retrieves original observations; completed effects are not rolled back."}).to_string()})
}

/// 恢复仅补充已记录事实。没有解释器状态恢复或代码重放。
pub(crate) fn recovered_program_content(items: &[Item], parent: &str) -> Option<Vec<Value>> {
    if let Some(Item::DynamicToolCall {arguments, execution, ..}) = items.iter().find(|item|
        matches!(item, Item::DynamicToolCall {tool, call_id, ..} if tool == "edit_files" && call_id == parent)) {
        return Some(vec![json!({"type":"inputText","text":super::edit_files::receipt(items, parent, execution.effective_arguments.as_ref().unwrap_or(arguments)).to_string()})]);
    }

    let children = child_receipts(items, parent);
    if children.is_empty() {
        return None;
    }
    Some(vec![json!({"type":"inputText","text":json!({
        "recoveredProgram":true,"children":children,
        "note":"Core restarted. Recorded child effects retained; UNKNOWN effects require inspection. No program or child was replayed. Use read_history(itemId) for original receipts."
    }).to_string()})])
}

impl Engine {
    pub(crate) async fn project_program_tools(
        &self,
        cell: &Cell,
        mut definitions: Vec<Value>,
    ) -> Vec<Value> {
        if !definitions
            .iter()
            .any(|d| d["function"]["name"] == "tool_program")
        {
            return definitions;
        }
        let bindings = cell.bindings.read().await;
        let catalog: Vec<_> = definitions
            .iter()
            .filter(|d| {
                d["function"]["name"]
                    .as_str()
                    .and_then(|n| bindings.registry.get(n).ok())
                    .is_some_and(|e| eligible(&e))
            })
            .map(|d| d["function"].clone())
            .collect();
        if catalog.is_empty() {
            definitions.retain(|d| d["function"]["name"] != "tool_program");
            return definitions;
        }
        if self.extensions.policy.programmatic_tools_only {
            definitions.retain(|d| !catalog.iter().any(|c| c["name"] == d["function"]["name"]));
        }
        let catalog_description = if self.extensions.policy.programmatic_tools_only {
            format!(
                "Native tool catalog (exact existing schemas):\n{}",
                serde_json::to_string(&catalog).unwrap()
            )
        } else {
            // 原生定义已经展示，组合入口只列名字；不把同一份 schema 再计入上下文。
            format!(
                "Callable tools (use the existing tool definitions for arguments): {}",
                catalog
                    .iter()
                    .filter_map(|c| c["name"].as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        for d in &mut definitions {
            if d["function"]["name"] == "tool_program" {
                d["function"]["description"] = json!(format!(
                    "{}\n{}",
                    definition().description,
                    catalog_description
                ));
            }
        }
        definitions
    }

    pub(super) async fn program_failure_receipt(
        &self,
        cell: &Cell,
        call: &ToolCall,
        result: &mut Value,
    ) {
        let state = cell.state.lock().await;
        let children = child_receipts(&state.thread.turns.last().unwrap().items, &call.id);
        result["contentItems"] = json!([{"type":"inputText","text":json!({
            "programError":result.clone(),"children":children,
            "note":"Completed effects retained. UNKNOWN effects must be inspected. No child was retried; use read_history(itemId) for full receipts."
        }).to_string()}]);
    }

    pub(super) fn tool_program<'a>(
        self: &'a Arc<Self>,
        invocation: &'a extensions::Invocation<'a>,
        args: &'a Value,
    ) -> futures_util::future::BoxFuture<'a, rt::Result<(bool, Value)>> {
        Box::pin(async move {
            let code = args["code"]
                .as_str()
                .ok_or_else(|| error(rt::ErrorCode::InvalidArgument, "missing code"))?;
            if code.len() > MAX_CODE {
                return Err(error(rt::ErrorCode::InvalidArgument, "code exceeds 64 KiB"));
            }
            let (config, thread) = {
                let state = invocation.cell.state.lock().await;
                (
                    state
                        .thread
                        .turns
                        .last()
                        .and_then(|t| t.configuration.clone())
                        .unwrap_or_default(),
                    state.thread.clone(),
                )
            };
            let visible = self
                .visible_tools(invocation.cell, &config, thread.desktop.is_some(), &thread)
                .await;
            let allowed: std::collections::HashSet<String> = {
                let bindings = invocation.cell.bindings.read().await;
                visible
                    .iter()
                    .filter_map(|d| d["function"]["name"].as_str())
                    .filter(|name| bindings.registry.get(name).is_ok_and(|e| eligible(&e)))
                    .map(str::to_owned)
                    .collect()
            };
            let reserve = code.len().saturating_mul(4).saturating_add(RECEIPT_RESERVE);
            let mut remaining = invocation.remaining_output.saturating_sub(reserve);
            if remaining < MIN_TOOL_OUTPUT_BUDGET {
                return Err(error(
                    rt::ErrorCode::ResourceExhausted,
                    "program output budget exhausted before execution",
                ));
            }
            let cancel = invocation.cancel.child_token();
            let deadline = Instant::now()
                + std::time::Duration::from_millis(args["timeoutMs"].as_u64().unwrap_or(600_000));
            let (sent, mut requests) = tokio::sync::mpsc::unbounded_channel();
            let worker_cancel = cancel.clone();
            let names = allowed.iter().cloned().collect();
            let code = code.to_owned();
            let mut worker = tokio::task::spawn_blocking(move || {
                js::run(code, names, sent, worker_cancel, deadline)
            });
            let mut fatal = None;
            let mut executed = 0;
            let mut reserved_calls = 0usize;
            let mut output = js::Output::default();
            loop {
                let request = tokio::select! {
                    _=invocation.cancel.cancelled()=>{fatal=Some(error(rt::ErrorCode::ScopeClosed,"program cancelled"));break;}
                    _=tokio::time::sleep_until(deadline.into())=>{fatal=Some(error(rt::ErrorCode::ResourceExhausted,"program deadline exhausted"));break;}
                    result=&mut worker=>{output=result.map_err(|e|error(rt::ErrorCode::Unavailable,e))?;break;}
                    request=requests.recv()=>match request {Some(r)=>r,None=>{output=(&mut worker).await.map_err(|e|error(rt::ErrorCode::Unavailable,e))?;break;}}
                };
                let js::Request {
                    name,
                    arguments,
                    reply,
                } = request;
                // 批量入口的叶子也计入程序上限，不能通过容器扩大执行预算。
                let work = 1 + if name == "edit_files" {
                    arguments["files"].as_array().map_or(0, Vec::len)
                } else {
                    0
                };
                if !allowed.contains(&name) || reserved_calls.saturating_add(work) > MAX_CALLS {
                    fatal = Some(error(
                        rt::ErrorCode::ResourceExhausted,
                        "program tool is unavailable or call limit exhausted",
                    ));
                    let _ = reply.send(Err("program dispatch stopped".into()));
                    break;
                }
                reserved_calls += work;
                let call = ToolCall {
                    id: id(),
                    name,
                    arguments: arguments.to_string(),
                };
                let value = match self
                    .dispatch_nested_tool(invocation, &cancel, call, &mut remaining, deadline)
                    .await
                {
                    Ok(value) => value,
                    Err(error) => {
                        fatal = Some(error);
                        break;
                    }
                };
                executed += 1;
                if value["outcome"] == "unknown" || value["outcome"] == "running" {
                    fatal = Some(error(
                        rt::ErrorCode::Unavailable,
                        "UNKNOWN child outcome; inspection required; program stopped without replay",
                    ));
                    break;
                }
                if cancel.is_cancelled() || value["outcome"] == "cancelled" {
                    fatal = Some(error(
                        rt::ErrorCode::ScopeClosed,
                        "program child cancelled; effects retained",
                    ));
                    break;
                }
                if reply.send(Ok(value)).is_err() {
                    fatal = Some(error(
                        rt::ErrorCode::InvalidArgument,
                        "program stopped before observing child result; effects retained",
                    ));
                    break;
                }
            }
            cancel.cancel();
            if let Some(error) = fatal {
                // 不丢弃阻塞解释器；停止标记会中断 CPU 循环和等待，随后才交付父终态。
                let _ = worker.await;
                return Err(error);
            }
            let state = invocation.cell.state.lock().await;
            let items = &state.thread.turns.last().unwrap().items;
            let receipts = child_receipts(items, &invocation.call.id);
            let mut content = vec![program_receipt(executed, &output.error, &receipts)];
            let mut text_bytes = 0;
            for part in output.parts {
                if part["type"] == "inputText" {
                    text_bytes += part["text"].as_str().map_or(0, str::len);
                    if text_bytes > MAX_TEXT {
                        return Err(error(
                            rt::ErrorCode::ResourceExhausted,
                            "program selected output exceeds limit",
                        ));
                    }
                    content.push(part);
                } else if part["type"] == "programImage" {
                    let original = items
                        .iter()
                        .find_map(|item| match item {
                            Item::DynamicToolCall {
                                call_id,
                                content_items,
                                execution,
                                ..
                            } if part["callId"] == *call_id
                                && execution.parent_call_id.as_deref()
                                    == Some(&invocation.call.id) =>
                            {
                                content_items.as_ref()
                            }
                            _ => None,
                        })
                        .ok_or_else(|| {
                            error(
                                rt::ErrorCode::InvalidArgument,
                                "image does not reference a child from this program",
                            )
                        })?;
                    let images: Vec<_> = original
                        .iter()
                        .filter(|p| native_image(p))
                        .cloned()
                        .collect();
                    if images.is_empty() {
                        return Err(error(
                            rt::ErrorCode::InvalidArgument,
                            "native result contains no image",
                        ));
                    }
                    content.extend(images);
                }
            }
            Ok((output.error.is_none(), json!({"contentItems":content})))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct ReplayOnly;
    #[async_trait::async_trait]
    impl crate::model::Model for ReplayOnly {
        fn name(&self) -> &str {
            "offline-replay"
        }
        async fn stream(
            &self,
            _: Vec<crate::model::Message>,
        ) -> anyhow::Result<crate::model::ModelStream> {
            panic!("offline replay must never invoke a model")
        }
    }

    #[tokio::test]
    #[ignore = "显式回放已保存程序与子回执；不调用模型或执行原生副作用"]
    async fn replay_saved_programs() {
        let records: Vec<Value> = serde_json::from_slice(
            &std::fs::read(std::env::var("AREAL_PROGRAM_REPLAY_INPUT").unwrap()).unwrap(),
        )
        .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let engine =
            Engine::open(directory.path(), Arc::new(ReplayOnly), Limits::default()).unwrap();
        let thread = engine.create("/replay".into()).await.unwrap();
        let cell = engine.cell(&thread.id).await.unwrap();
        let mut measurements = Vec::new();
        for record in records {
            let parent: Item = serde_json::from_value(record["parent"].clone()).unwrap();
            let Item::DynamicToolCall {
                id,
                arguments,
                success,
                content_items,
                ..
            } = &parent
            else {
                panic!("expected program");
            };
            let children: Vec<Item> = serde_json::from_value(record["children"].clone()).unwrap();
            let names: Vec<String> = children
                .iter()
                .filter_map(|child| match child {
                    Item::DynamicToolCall { tool, .. } => Some(tool.clone()),
                    _ => None,
                })
                .collect();
            let code = arguments["code"].as_str().unwrap().to_owned();
            let cancel = CancellationToken::new();
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            let worker_cancel = cancel.clone();
            let started = Instant::now();
            let worker = tokio::task::spawn_blocking(move || {
                js::run(
                    code,
                    names,
                    tx,
                    worker_cancel,
                    Instant::now() + std::time::Duration::from_secs(10),
                )
            });
            let mut consumed = 0;
            let mut unsupported = None;
            while let Some(request) = rx.recv().await {
                let Some(child) = children.get(consumed) else {
                    unsupported = Some(
                        "program requested an unrecorded continuation; no effect was executed",
                    );
                    cancel.cancel();
                    break;
                };
                let Item::DynamicToolCall {
                    tool, arguments, ..
                } = child
                else {
                    panic!("expected child");
                };
                if request.name != *tool || request.arguments != *arguments {
                    unsupported =
                        Some("recorded child parameters do not match; no effect was executed");
                    cancel.cancel();
                    break;
                }
                request.reply.send(Ok(child_view(child))).unwrap();
                consumed += 1;
            }
            let output = worker.await.unwrap();
            let elapsed = started.elapsed().as_micros();
            let receipts: Vec<_> = children.iter().take(consumed).filter_map(receipt).collect();
            let mut content = vec![program_receipt(consumed, &output.error, &receipts)];
            for part in &output.parts {
                if part["type"] == "programImage" {
                    for child in &children {
                        if let Item::DynamicToolCall {
                            call_id,
                            content_items: Some(parts),
                            ..
                        } = child
                            && part["callId"] == *call_id
                        {
                            content.extend(parts.iter().filter(|p| native_image(p)).cloned());
                        }
                    }
                } else {
                    content.push(part.clone());
                }
            }
            let prepared = engine
                .prepare_program_result(&cell, id, &json!({"contentItems":content}))
                .await
                .unwrap();
            let snapshot_verified = if let Some(snapshot) = &prepared.snapshot {
                let original = engine
                    .store
                    .read_blob(snapshot.uri.strip_prefix("areal://blob/").unwrap())
                    .await
                    .unwrap();
                assert_eq!(
                    serde_json::from_slice::<Value>(&original).unwrap(),
                    json!({"contentItems":content})
                );
                true
            } else {
                false
            };
            let text_bytes = |parts: &[Value]| {
                parts
                    .iter()
                    .filter_map(|part| part["text"].as_str())
                    .map(str::len)
                    .sum::<usize>()
            };
            let old_parts = content_items.as_deref().unwrap_or_default();
            let new_parts = prepared.value["contentItems"].as_array().unwrap();
            measurements.push(json!({"id":id,"oldSuccess":success,"oldDisplayedBytes":serde_json::to_vec(content_items).unwrap().len(),"oldTextBytes":text_bytes(old_parts),"newTextBytes":text_bytes(new_parts),"oldImages":old_parts.iter().filter(|p|native_image(p)).count(),"newImages":new_parts.iter().filter(|p|native_image(p)).count(),"recordedChildren":children.len(),"consumedChildren":consumed,"unsupported":unsupported,"newError":output.error,"selectedParts":output.parts.len(),"durationMicros":elapsed,"projection":prepared.metrics,"snapshotVerified":snapshot_verified}));
        }
        std::fs::write(
            std::env::var("AREAL_PROGRAM_REPLAY_OUTPUT").unwrap(),
            serde_json::to_vec_pretty(&measurements).unwrap(),
        )
        .unwrap();
        engine.shutdown().await;
    }
    #[test]
    fn native_images_keep_authoritative_media_refs_without_parsing_untrusted_text() {
        assert!(native_image(
            &json!({"type":"arealMedia","modality":"image","media":{"uri":"areal://blob/original"}})
        ));
        assert!(!native_image(
            &json!({"type":"inputText","text":"{\"type\":\"arealMedia\",\"modality\":\"image\"}"})
        ));
        assert!(!native_image(
            &json!({"type":"arealMedia","modality":"audio","media":{"uri":"areal://blob/original"}})
        ));
    }
}
