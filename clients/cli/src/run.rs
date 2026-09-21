use super::*;
use crate::rpc::Rpc;
use anyhow::{Context, bail};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{BufRead, IsTerminal, Read, Write},
    time::Duration,
};
use tokio::sync::mpsc;
pub fn emit(value: &Value) -> Result<()> {
    let mut out = std::io::stdout().lock();
    serde_json::to_writer(&mut out, value)?;
    out.write_all(b"\n")?;
    out.flush()?;
    Ok(())
}
fn names(values: &[String]) -> Vec<String> {
    values
        .iter()
        .flat_map(|s| s.split([',', ' ']))
        .filter(|s| !s.is_empty())
        .map(|s| {
            match s {
                "AskUserQuestion" => "ask_user_question",
                "Bash" => "run_command",
                "Read" => "fs_read",
                "Write" => "fs_create",
                "Edit" => "fs_apply_patch",
                "TodoWrite" => "plan_update",
                "Task" => "agent_spawn",
                _ => s,
            }
            .into()
        })
        .collect()
}
fn stdin(args: &Cli) -> mpsc::Receiver<Result<Value>> {
    let (tx, rx) = mpsc::channel(32);
    let format = args.input_format.clone();
    let prompt = args.prompt.clone();
    let terminal = std::io::stdin().is_terminal();
    std::thread::spawn(move || {
        let input = std::io::stdin();
        let mut input = input.lock();
        if format == "text" {
            let mut text = prompt.unwrap_or_default();
            if !terminal {
                let mut buffer = String::new();
                let result = (&mut input)
                    .take(1024 * 1024 + 1)
                    .read_to_string(&mut buffer);
                if let Err(e) = result {
                    let _ = tx.blocking_send(Err(e.into()));
                    return;
                }
                if buffer.len() > 1024 * 1024 {
                    let _ = tx.blocking_send(Err(anyhow::anyhow!("stdin exceeds 1 MiB")));
                    return;
                }
                if !text.is_empty() && !buffer.is_empty() {
                    text.push('\n');
                }
                text.push_str(&buffer);
            }
            let _=tx.blocking_send(Ok(json!({"type":"user","message":{"role":"user","content":[{"type":"text","text":text}]}})));
            return;
        }
        if let Some(prompt) = prompt
            && tx.blocking_send(Ok(json!({"type":"user","message":{"role":"user","content":[{"type":"text","text":prompt}]}}))).is_err(){return;}
        loop {
            let mut line = Vec::new();
            match (&mut input)
                .take(1024 * 1024 + 1)
                .read_until(b'\n', &mut line)
            {
                Ok(0) => break,
                Ok(_) => {
                    if line.len() > 1024 * 1024 {
                        let _ = tx.blocking_send(Err(anyhow::anyhow!("JSONL frame exceeds 1 MiB")));
                        break;
                    }
                    if tx
                        .blocking_send(serde_json::from_slice(&line).map_err(Into::into))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(e) => {
                    let _ = tx.blocking_send(Err(e.into()));
                    break;
                }
            }
        }
    });
    rx
}
fn input(value: &Value, session: &str) -> Result<Value> {
    ensure!(
        value["type"] == "user" && value["message"]["role"] == "user",
        "expected user message"
    );
    if let Some(id) = value.get("session_id").and_then(Value::as_str) {
        ensure!(
            id.is_empty() || id == session,
            "message session_id mismatch"
        );
    }
    ensure!(
        value.get("parent_tool_use_id").is_none_or(Value::is_null),
        "child tool input is not a user request"
    );
    let content = &value["message"]["content"];
    let blocks = if let Some(text) = content.as_str() {
        vec![json!({"type":"text","text":text})]
    } else {
        content
            .as_array()
            .context("message.content must be text or an array")?
            .clone()
    };
    ensure!(
        !blocks.is_empty() && blocks.len() <= 32,
        "invalid user message size"
    );
    Ok(Value::Array(
        blocks
            .into_iter()
            .map(|b| match b["type"].as_str() {
                Some("text") => {
                    ensure!(b["text"].is_string(), "invalid text block");
                    Ok(json!({"type":"text","text":b["text"]}))
                }
                Some("image") => {
                    let s = &b["source"];
                    ensure!(
                        s["type"] == "base64",
                        "only inline base64 image input supported"
                    );
                    let mime = s["media_type"].as_str().context("image MIME required")?;
                    let bytes = s["data"].as_str().context("image data required")?;
                    Ok(json!({"type":"image","url":format!("data:{mime};base64,{bytes}")}))
                }
                _ => bail!("unsupported user content block"),
            })
            .collect::<Result<Vec<_>>>()?,
    ))
}
pub async fn execute(args: &Cli) -> Result<i32> {
    ensure!(
        !args.include_partial_messages || args.output_format == "stream-json",
        "partial messages require stream-json output"
    );
    ensure!(
        args.max_turns.is_none_or(|n| n > 0 && n <= 1024),
        "max-turns must be 1..1024"
    );
    if let Some(effort) = &args.effort {
        ensure!(
            ["none", "minimal", "low", "medium", "high", "xhigh"].contains(&effort.as_str()),
            "unsupported effort"
        );
    }
    let mut local = local::Local::start(args).await?;
    let result = execute_connected(args, &local).await;
    let cleanup = local.close().await;
    cleanup?;
    let (code, results) = result?;
    for value in results {
        output_result(args, &value)?;
    }
    Ok(code)
}
fn output_result(args: &Cli, result: &Value) -> Result<()> {
    if args.output_format == "text" {
        let mut out = std::io::stdout().lock();
        if let Some(text) = result["result"].as_str() {
            writeln!(out, "{text}")?;
        } else if let Some(errors) = result["errors"].as_array() {
            for error in errors.iter().filter_map(Value::as_str) {
                writeln!(out, "{error}")?;
            }
        }
        out.flush()?;
        Ok(())
    } else {
        emit(result)
    }
}
async fn execute_connected(args: &Cli, local: &local::Local) -> Result<(i32, Vec<Value>)> {
    let mut rpc = Rpc::connect(&local.endpoint, &local.token).await?;
    rpc.call(
        "initialize",
        json!({"clientInfo":{"name":"areal-claude-cli","version":env!("CARGO_PKG_VERSION")}}),
    )
    .await?;
    rpc.send(json!({"method":"initialized","params":{}}))
        .await?;
    rpc.call("areal/capabilities", json!({"apiVersion":"areal.core.v1"}))
        .await?;
    for (id, config) in &local.mcp {
        let catalog = rpc.call("areal/mcp/list", json!({})).await?;
        let revision = catalog["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == *id)
            .and_then(|s| s["revision"].as_u64())
            .unwrap_or(0);
        let result = rpc
            .call(
                "areal/mcp/configure",
                json!({"id":id,"expectedRevision":revision,"config":config}),
            )
            .await?;
        rpc.call(
            "areal/mcp/connect",
            json!({"id":id,"expectedRevision":result["data"].as_array().and_then(|entries|entries.iter().find(|r|r["id"]==*id)).and_then(|r|r["revision"].as_u64()).context("missing MCP configuration revision")?}),
        )
        .await?;
    }
    let thread = if let Some(id) = &args.resume {
        rpc.call("thread/resume", json!({"threadId":id})).await?
    } else {
        rpc.call(
            "areal/thread/start",
            json!({"requestId":key(),"agentProfile":local.profile}),
        )
        .await?
    };
    let session = thread["thread"]["id"]
        .as_str()
        .context("Core did not return a thread")?
        .to_owned();
    local.record(
        &session,
        thread["thread"]["cwd"]
            .as_str()
            .context("missing thread workspace")?,
    )?;
    let config = thread["thread"]["desktop"]["configuration"].clone();
    let inspection = rpc
        .call("areal/thread/inspect", json!({"threadId":session}))
        .await?;
    let mut available: Vec<String> = inspection["tools"]
        .as_array()
        .context("missing tools")?
        .iter()
        .filter_map(|t| t["function"]["name"].as_str().map(str::to_owned))
        .collect();
    let mcp = rpc.call("areal/mcp/list", json!({})).await?;
    for server in mcp["data"].as_array().unwrap() {
        if let Some(tools) = server["tools"].as_array() {
            available.extend(
                tools
                    .iter()
                    .filter_map(|t| t["name"].as_str().map(str::to_owned)),
            );
        }
    }
    available.sort();
    available.dedup();
    let denied = names(&args.disallowed_tools);
    let allowed = names(&args.allowed_tools);
    for name in denied.iter().chain(&allowed) {
        ensure!(available.contains(name), "unknown tool rule {name}");
    }
    let mut visible = if let Some(tools) = &args.tools {
        if tools == "default" {
            available.clone()
        } else {
            names(std::slice::from_ref(tools))
        }
    } else {
        available.clone()
    };
    for name in &visible {
        ensure!(available.contains(name), "unknown visible tool {name}");
    }
    visible.retain(|n| !denied.contains(n));
    let bypass = args.dangerously_skip_permissions || args.permission_mode == "bypassPermissions";
    let approvals = if bypass || args.permission_mode == "plan" {
        vec![]
    } else {
        vec!["*".to_owned()]
    };
    let mut approved = allowed;
    if args.permission_mode == "acceptEdits" {
        approved.extend(["fs_create".into(), "fs_apply_patch".into()]);
    }
    let system = if let Some(path) = &args.system_prompt_file {
        Some(read_text(path)?)
    } else {
        args.system_prompt.clone()
    };
    let append = if let Some(path) = &args.append_system_prompt_file {
        read_text(path)?
    } else {
        args.append_system_prompt.clone().unwrap_or_default()
    };
    let mut configure = json!({"threadId":session,"expectedRevision":config["revision"].as_u64().unwrap_or(1),"options":{"readOnly":args.permission_mode=="plan","systemPrompt":system,"appendInstructions":append,"toolAllowlist":visible,"approvalTools":approvals,"preapprovedTools":approved,"maxModelRounds":args.max_turns}});
    if local.profile.is_some() {
        configure["agentProfile"] = local.profile.clone().unwrap();
    }
    if let Some(effort) = &args.effort {
        configure["parameters"] = json!({"reasoningEffort":effort});
    }
    if let Some(name) = &args.model {
        let catalog = rpc.call("areal/model/list", json!({})).await?;
        let entries = catalog["data"].as_array().unwrap();
        let matches: Vec<_> = entries
            .iter()
            .filter(|m| {
                m["modelId"] == *name
                    || format!(
                        "{}:{}",
                        m["providerId"].as_str().unwrap_or("default"),
                        m["modelId"].as_str().unwrap_or("")
                    ) == *name
            })
            .collect();
        ensure!(
            matches.len() == 1,
            "model must identify exactly one configured API model"
        );
        let model = matches[0];
        if model["providerId"].is_string() {
            configure["model"] =
                json!({"providerId":model["providerId"],"modelId":model["modelId"]});
        } else {
            ensure!(
                config["model"].is_null(),
                "cannot reset a provider selection with the default alias"
            );
        }
    }
    let effective = rpc.call("areal/thread/configure", configure).await?;
    let model = if let Some(model) = effective["model"]["modelId"].as_str() {
        model.to_owned()
    } else {
        let catalog = rpc.call("areal/model/list", json!({})).await?;
        catalog["data"]
            .as_array()
            .and_then(|models| models.iter().find(|m| m["providerId"].is_null()))
            .and_then(|m| m["modelId"].as_str())
            .context("default API model unavailable")?
            .to_owned()
    };
    if args.output_format == "stream-json" {
        emit(
            &json!({"type":"system","subtype":"init","session_id":session,"uuid":key(),"cwd":thread["thread"]["cwd"],"model":model,"tools":visible,"permissionMode":if args.dangerously_skip_permissions{"bypassPermissions"}else{args.permission_mode.as_str()}}),
        )?;
    }
    let mut input_rx = stdin(args);
    let mut eof = false;
    let mut outstanding = 0usize;
    let mut terminal_results = Vec::new();
    let mut accepted = BTreeSet::<String>::new();
    let mut queued = BTreeSet::<String>::new();
    let mut active = None::<String>;
    let mut pending = BTreeMap::<String, Value>::new();
    let mut started = BTreeMap::new();
    let mut failed = false;
    let mut rounds = BTreeMap::<String, usize>::new();
    let mut terminating = false;
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    loop {
        tokio::select! {biased;
                 _=term.recv(),if !terminating=>{terminating=true;failed=true;if let Some(turn)=&active{rpc.call("turn/interrupt",json!({"threadId":session,"turnId":turn})).await?;}else{break;}}
                 _=interrupt.recv(),if !terminating=>{terminating=true;failed=true;if let Some(turn)=&active{rpc.call("turn/interrupt",json!({"threadId":session,"turnId":turn})).await?;}else{break;}}
                 incoming=input_rx.recv(),if !eof&&!terminating=>{
                  let Some(value)=incoming else{eof=true;if outstanding==0{ensure!(!accepted.is_empty(),"no input supplied");break;}
        if !pending.is_empty(){failed=true;if let Some(turn)=&active{rpc.call("turn/interrupt",json!({"threadId":session,"turnId":turn})).await?;}}continue;};
                  let value=value?;
                  if value["type"]=="control_response"{
                   let response=&value["response"];let id=response["request_id"].as_str().context("control response request_id missing")?;let request=pending.remove(id).context("unknown or already answered control request")?;
                   ensure!(response["subtype"]=="success","control response must be success");let payload=&response["response"];let mut answer=json!({"threadId":session,"turnId":request["turnId"],"requestId":id});
                   if request["kind"]=="approval" {let original=&request["effectiveArguments"];ensure!(payload.get("updatedInput").is_none_or(|v|v==original),"updatedInput changed; approval must bind original arguments");answer["decision"]=json!(if payload["behavior"]=="allow"{"allowOnce"}else{"deny"});answer["argumentsDigest"]=request["argumentsDigest"].clone();}
                   else{answer["answers"]=payload["updatedInput"]["answers"].clone();ensure!(answer["answers"].is_object(),"AskUserQuestion requires explicit answers");}
                   rpc.call("areal/interaction/respond",answer).await?;continue;
                  }
                  if value["type"]=="control_request"&&value["request"]["subtype"]=="interrupt" {ensure!(value["request_id"].as_str().is_some_and(|id|!id.is_empty()),"control request_id required");if let Some(turn)=&active{rpc.call("turn/interrupt",json!({"threadId":session,"turnId":turn})).await?;}
        if args.output_format=="stream-json"{emit(&json!({"type":"control_response","response":{"subtype":"success","request_id":value["request_id"],"response":{}}}))?;}continue;}
                  ensure!(outstanding<32,"CLI input queue capacity reached");let content=input(&value,&session)?;let request=value.get("uuid").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(key);
                  let method=if outstanding>0{"areal/turn/enqueue"}else{"areal/turn/start"};let result=rpc.call(method,json!({"requestId":request,"threadId":session,"input":content,"expectedConfigRevision":effective["revision"]})).await?;
                  if let Some(turn)=result["turn"]["id"].as_str(){if accepted.insert(turn.into()){outstanding+=1;started.insert(turn.to_owned(),std::time::Instant::now());}active=Some(turn.into());}else{let id=result["queueItemId"].as_str().context("missing queue receipt")?;if queued.insert(id.into()){outstanding+=1;}}
                 }
                 event=rpc.events.recv()=>{
                  let event=event.context("Core event stream disconnected; no successful result can be inferred")?;let p=&event["params"];let method=event["method"].as_str().unwrap_or("");
                  if event.get("id").is_some(){rpc.send(json!({"id":event["id"],"error":{"code":-32601,"message":"CLI has no ambient tool host"}})).await?;continue;}
                  if method=="areal/interaction/requested" {let r=&p["interaction"];if r["threadId"]!=session{continue;}let id=r["requestId"].as_str().context("invalid interaction")?.to_owned();
                   if eof||args.input_format!="stream-json"||args.output_format!="stream-json"||args.permission_mode=="dontAsk"{failed=true;rpc.call("turn/interrupt",json!({"threadId":session,"turnId":r["turnId"]})).await?;continue;}
                   emit(&json!({"type":"control_request","request_id":id,"request":{"subtype":"can_use_tool","tool_name":if r["kind"]=="question"{json!("AskUserQuestion")}else{r["tool"].clone()},"input":if r["kind"]=="question"{json!({"questions":r["questions"]})}else{r["effectiveArguments"].clone()},"tool_use_id":r["callId"]}}))?;pending.insert(id,r.clone());continue;
                  }
                  if p["threadId"]!=session{continue;}
                  let turn=p["turnId"].as_str().or_else(||p["turn"]["id"].as_str()).unwrap_or("");
                  if method=="turn/started"&&!accepted.contains(turn)&&!queued.is_empty(){let q=rpc.call("areal/queue/list",json!({"threadId":session})).await?;if q["items"].as_array().unwrap().iter().any(|i|i["turnId"]==turn&&queued.contains(i["id"].as_str().unwrap_or(""))){accepted.insert(turn.into());started.insert(turn.into(),std::time::Instant::now());active=Some(turn.into());}}
                  if !accepted.contains(turn){continue;}
                  let item=&p["item"];let stream=args.output_format=="stream-json";
                  if method=="item/started"&&item["type"]=="agentMessage"{*rounds.entry(turn.into()).or_default()+=1;if stream&&args.include_partial_messages{emit(&json!({"type":"stream_event","uuid":key(),"session_id":session,"parent_tool_use_id":null,"event":{"type":"message_start","message":{"id":item["id"],"type":"message","role":"assistant","model":model,"content":[]}}}))?;emit(&json!({"type":"stream_event","uuid":key(),"session_id":session,"parent_tool_use_id":null,"event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}))?;}}
                  if method=="item/agentMessage/delta"&&stream&&args.include_partial_messages{emit(&json!({"type":"stream_event","uuid":key(),"session_id":session,"parent_tool_use_id":null,"event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":p["delta"]}}}))?;}
                  if method=="item/started"&&item["type"]=="dynamicToolCall"&&stream&&args.verbose{emit(&json!({"type":"assistant","uuid":item["id"],"session_id":session,"parent_tool_use_id":null,"message":{"id":item["id"],"type":"message","role":"assistant","model":model,"content":[{"type":"tool_use","id":item["callId"],"name":item["tool"],"input":item["arguments"]}]}}))?;}
                  if method=="item/completed"&&item["type"]=="agentMessage"{if stream&&args.include_partial_messages{for e in [json!({"type":"content_block_stop","index":0}),json!({"type":"message_stop"})]{emit(&json!({"type":"stream_event","uuid":key(),"session_id":session,"parent_tool_use_id":null,"event":e}))?;}}
        if stream&&args.verbose{emit(&json!({"type":"assistant","uuid":item["id"],"session_id":session,"parent_tool_use_id":null,"message":{"id":item["id"],"type":"message","role":"assistant","model":model,"content":[{"type":"text","text":item["text"]}]}}))?;}}
                  if method=="item/completed"&&item["type"]=="dynamicToolCall"&&item["contentItems"].as_array().is_some_and(|items|items.iter().any(|c|c["type"]!="inputText")){failed=true;}
                  if method=="item/completed"&&item["type"]=="dynamicToolCall"&&stream&&args.verbose{let contents=item["contentItems"].as_array().map(|items|items.iter().map(|c|{if c["type"]=="inputText"{json!({"type":"text","text":c["text"]})}else{failed=true;json!({"type":"text","text":"UNSUPPORTED_CLI_MEDIA: read media through authenticated Core API"})}}).collect::<Vec<_>>()).unwrap_or_default();emit(&json!({"type":"user","uuid":key(),"session_id":session,"parent_tool_use_id":null,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":item["callId"],"is_error":item["success"]!=true,"content":contents}]}}))?;}
                  if method=="turn/completed"{
                   let t=&p["turn"];let success=t["status"]=="completed"&&!failed;failed|=!success;outstanding=outstanding.saturating_sub(1);active=None;pending.clear();
                   let text=t["items"].as_array().unwrap().iter().filter(|i|i["type"]=="agentMessage").filter_map(|i|i["text"].as_str()).collect::<Vec<_>>().join("\n");
                   let subtype=if success{"success"}else if t["error"]["message"].as_str().is_some_and(|m|m.contains("MAX_MODEL_ROUNDS")){"error_max_turns"}else{"error_during_execution"};
                   let mut result=json!({"type":"result","subtype":subtype,"is_error":!success,"session_id":session,"uuid":key(),"duration_ms":started.get(turn).map(|v|v.elapsed().as_millis()),"num_turns":rounds.get(turn).copied().unwrap_or(0),"stop_reason":null});
                   if success {result["result"]=json!(text);} else {result["errors"]=json!([t["error"]["message"].as_str().unwrap_or(if t["status"]=="interrupted"{"Turn interrupted"}else{"Turn failed or output could not be represented"})]);}
                   if !t["usage"].is_null(){let u=&t["usage"];result["usage"]=json!({"input_tokens":u["inputTokens"],"output_tokens":u["outputTokens"],"cache_read_input_tokens":u["cachedInputTokens"]});}
                   if failed||terminating||outstanding==0{
                    terminal_results.push(result);
                    if outstanding>0 {
                     let q=rpc.call("areal/queue/list",json!({"threadId":session})).await?;
                     for entry in q["items"].as_array().context("invalid queue snapshot")? {
                      if queued.contains(entry["id"].as_str().unwrap_or(""))&&entry["status"]!="completed"&&entry["turnId"]!=turn {
                       terminal_results.push(json!({"type":"result","subtype":"error_during_execution","is_error":true,"session_id":session,"uuid":key(),"errors":["Accepted input remains in the durable queue; inspect before resuming"],"num_turns":0,"stop_reason":null}));
                      }
                     }
                    }
                    break;
                   }
                   output_result(args,&result)?;
                  }
                 }
                 _=tokio::time::sleep(Duration::from_secs(30)),if !pending.is_empty()=>{failed=true;if let Some(turn)=&active{rpc.call("turn/interrupt",json!({"threadId":session,"turnId":turn})).await?;}}
                }
    }
    Ok((if failed { 1 } else { 0 }, terminal_results))
}
