use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};

pub(super) fn pick(value: &Value, fields: &[&str]) -> Value {
    Value::Object(
        fields
            .iter()
            .filter_map(|field| {
                value
                    .get(*field)
                    .map(|value| ((*field).into(), value.clone()))
            })
            .collect(),
    )
}
fn rows(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}
fn prefix(value: &str, maximum: usize) -> &str {
    let mut end = maximum.min(value.len());
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}
fn preview(parts: &[&str], maximum: usize) -> Value {
    let text = parts.join("");
    let fragment = prefix(&text, maximum);
    json!({"preview":fragment,"textBytes":text.len(),"truncated":text.len()>maximum,"bodyDetail":if text.len()>maximum {json!({"state":"unavailable","reason":"desktopRequired"})}else{json!({"state":"inline"})}})
}
pub(super) fn body(item: &Value) -> Option<Value> {
    let mut result = pick(item, &["id", "type"]);
    match item["type"].as_str()? {
        "agentMessage" => result["text"] = item.get("text").cloned().unwrap_or(json!("")),
        "userMessage" => {
            result["content"] = json!(
                rows(&item["content"])
                    .iter()
                    .filter(|part| part["type"] == "text")
                    .map(|part| pick(part, &["type", "text"]))
                    .collect::<Vec<_>>()
            )
        }
        "reasoning" => {
            result["summary"] = item.get("summary").cloned().unwrap_or(json!([]));
            result["content"] = item.get("content").cloned().unwrap_or(json!([]));
        }
        "dynamicToolCall" => {
            result.as_object_mut()?.extend(
                pick(item, &["tool", "arguments", "status", "success"])
                    .as_object()?
                    .clone(),
            );
            result["contentItems"] = json!(
                rows(&item["contentItems"])
                    .iter()
                    .filter(|part| matches!(part["type"].as_str(), Some("inputText" | "text")))
                    .map(|part| pick(part, &["type", "text"]))
                    .collect::<Vec<_>>()
            );
            result["execution"] = pick(
                &item["execution"],
                &[
                    "outcome",
                    "exitCode",
                    "startedAt",
                    "completedAt",
                    "durationMs",
                ],
            );
        }
        _ => return None,
    }
    Some(result)
}
fn item(item: &Value, thread_id: &Value, turn_id: &Value) -> Option<Value> {
    let kind = item["type"].as_str()?;
    if kind == "modelContext" {
        return None;
    }
    let mut result = pick(item, &["id", "type", "phase", "status", "success"]);
    let parts: Vec<&str> = match kind {
        "agentMessage" => vec![item["text"].as_str().unwrap_or_default()],
        "userMessage" => rows(&item["content"])
            .iter()
            .filter(|part| part["type"] == "text")
            .filter_map(|part| part["text"].as_str())
            .collect(),
        "reasoning" => rows(&item["summary"])
            .iter()
            .chain(rows(&item["content"]))
            .filter_map(Value::as_str)
            .collect(),
        "dynamicToolCall" => rows(&item["contentItems"])
            .iter()
            .filter(|part| matches!(part["type"].as_str(), Some("inputText" | "text")))
            .filter_map(|part| part["text"].as_str())
            .collect(),
        _ => vec![],
    };
    result
        .as_object_mut()?
        .extend(preview(&parts, 1024).as_object()?.clone());
    if kind == "dynamicToolCall" {
        result["tool"] = json!(prefix(item["tool"].as_str().unwrap_or_default(), 200));
        result["executionOutcome"] = item["execution"]["outcome"].clone();
    }
    if let Some(body) = body(item) {
        let encoded = serde_json::to_vec(&body).ok()?;
        if encoded.len() <= 512 {
            result["body"] = body;
            result["bodyDetail"] = json!({"state":"inline"});
        } else {
            result["bodyDetail"] = json!({"state":"available","revision":areal_local_service::storage::digest(&encoded)});
        }
    }
    let media = kind == "agentMedia"
        || (kind == "userMessage"
            && rows(&item["content"])
                .iter()
                .any(|part| part["type"] != "text"))
        || (kind == "dynamicToolCall"
            && rows(&item["contentItems"])
                .iter()
                .any(|part| !matches!(part["type"].as_str(), Some("inputText" | "text"))));
    if media {
        result["mediaUnavailable"] = json!(true);
        result["truncated"] = json!(true);
        if result.get("body").is_none() {
            result["bodyDetail"] = json!({"state":"unavailable","reason":"mediaRequiresDesktop"});
        }
    }
    if result["bodyDetail"]["state"] == "unavailable" {
        result["bodyDetail"]["threadId"] = thread_id.clone();
        result["bodyDetail"]["turnId"] = turn_id.clone();
        result["bodyDetail"]["itemId"] = item["id"].clone();
    }
    Some(result)
}
fn turn(turn: &Value, items: Vec<Value>) -> Value {
    let mut result = pick(
        turn,
        &["id", "status", "startedAt", "completedAt", "durationMs"],
    );
    result["items"] = json!(items);
    if turn.get("goal").is_some() {
        result["goal"] = pick(&turn["goal"], &["origin", "sequence"]);
    }
    result
}
fn history_cursor(scope: &[String], item: &Value) -> Result<String> {
    let mut parts: Vec<Value> = scope.iter().map(|value| json!(value)).collect();
    parts.push(item["id"].clone());
    Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&parts)?))
}
pub(super) fn history(
    thread: &Value,
    scope: &[String],
    cursor: Option<&str>,
    limit: usize,
) -> Result<Value> {
    ensure!((1..=100).contains(&limit), "INVALID_PARAMS");
    let rows: Vec<_> = rows(&thread["turns"])
        .iter()
        .flat_map(|turn| {
            rows(&turn["items"])
                .iter()
                .filter(|item| item["type"] != "modelContext")
                .map(move |item| (turn, item))
        })
        .collect();
    let mut end = rows.len();
    if let Some(cursor) = cursor {
        let decoded: Vec<Value> =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(cursor).context("RESYNC_REQUIRED")?)
                .context("RESYNC_REQUIRED")?;
        ensure!(
            decoded.len() == scope.len() + 1
                && scope
                    .iter()
                    .zip(&decoded)
                    .all(|(left, right)| right == left),
            "RESYNC_REQUIRED"
        );
        end = rows
            .iter()
            .position(|(_, item)| item["id"] == decoded[scope.len()])
            .context("RESYNC_REQUIRED")?;
    }
    let start = end.saturating_sub(limit);
    let mut turns: Vec<Value> = vec![];
    for (native_turn, native_item) in &rows[start..end] {
        if turns
            .last()
            .is_none_or(|turn| turn["id"] != native_turn["id"])
        {
            turns.push(turn(native_turn, vec![]));
        }
        if let Some(item) = item(native_item, &thread["id"], &native_turn["id"]) {
            turns.last_mut().unwrap()["items"]
                .as_array_mut()
                .unwrap()
                .push(item);
        }
    }
    Ok(
        json!({"turns":turns,"nextCursor":if start>0 {Some(history_cursor(scope,rows[start].1)?)}else{None},"hasMore":start>0,"truncated":thread.get("historyArchive").is_some_and(|value|!value.is_null()),"unavailable":thread.get("historyArchive").is_some_and(|value|!value.is_null()),"range":"coreAccessible"}),
    )
}
pub(super) fn snapshot(
    thread: &Value,
    ownership: &Value,
    scope: &[String],
    features: &Value,
) -> Result<Value> {
    ensure!(
        thread["id"].as_str() == scope.last().map(String::as_str)
            && matches!(ownership["kind"].as_str(), Some("ordinary" | "task")),
        "RESYNC_REQUIRED"
    );
    let mut page = history(thread, scope, None, 100)?;
    for native in rows(&thread["turns"]).iter().rev().take(100).rev() {
        if rows(&native["items"]).is_empty()
            && !rows(&page["turns"])
                .iter()
                .any(|row| row["id"] == native["id"])
        {
            page["turns"]
                .as_array_mut()
                .unwrap()
                .push(turn(native, vec![]));
        }
    }
    let mut refs = vec![];
    for interaction in rows(&thread["desktop"]["interactions"]) {
        if interaction["status"] != "pending" {
            continue;
        }
        let approval = interaction["kind"] == "approval";
        refs.push(json!({"attentionRef":format!("{}:{}:{}",if approval{"approval"}else{"syncQuestion"},thread["id"].as_str().unwrap_or_default(),interaction["requestId"].as_str().unwrap_or_default()),"kind":if approval{"approval"}else{"syncQuestion"},"threadId":interaction["threadId"],"turnId":interaction["turnId"],"interactionId":interaction["requestId"],"status":interaction["status"],"expiresAt":interaction["expiresAt"],"summary":if approval{"Tool approval required"}else{prefix(interaction["questions"][0]["title"].as_str().unwrap_or("Question requires an answer"),256)}}));
    }
    for native_turn in rows(&thread["turns"]) {
        for item in rows(&native_turn["items"]) {
            if item["type"] == "dynamicToolCall"
                && item["execution"].get("inspection").is_none()
                && (item["execution"]["outcome"] == "unknown"
                    || rows(&item["execution"]["hooks"])
                        .iter()
                        .any(|hook| hook["outcome"] == "unknown"))
            {
                refs.push(json!({"attentionRef":format!("executionUnknown:{}:{}",thread["id"].as_str().unwrap_or_default(),item["id"].as_str().unwrap_or_default()),"kind":"executionUnknown","threadId":thread["id"],"turnId":native_turn["id"],"itemId":item["id"],"status":"pending","summary":"Tool outcome is unknown; inspect on desktop"}));
            }
        }
    }
    for receipt in rows(&thread["desktop"]["receipts"]) {
        if receipt["status"] == "unknown" {
            refs.push(json!({"attentionRef":format!("submissionUnknown:{}:{}",thread["id"].as_str().unwrap_or_default(),receipt["requestId"].as_str().unwrap_or_default()),"kind":"submissionUnknown","threadId":thread["id"],"status":"pending","summary":"Submission outcome is unknown"}));
        }
    }
    let native_config = &thread["desktop"]["configuration"];
    let mut configuration = pick(native_config, &["revision", "readOnly"]);
    if !native_config.is_null() {
        for (name, fields) in [
            ("model", vec!["providerId", "modelId"]),
            ("parameters", vec!["reasoningEffort"]),
            ("profile", vec!["id", "revision", "readOnly"]),
            (
                "options",
                vec![
                    "permissionPreset",
                    "readOnly",
                    "appendInstructions",
                    "approvalTools",
                    "preapprovedTools",
                ],
            ),
            (
                "permissions",
                vec!["resources", "reviewer", "fullAccessAvailable"],
            ),
        ] {
            if native_config.get(name).is_some() {
                configuration[name] = if native_config[name].is_null() {
                    Value::Null
                } else {
                    pick(&native_config[name], &fields)
                };
            }
        }
    }
    let native_goals = &thread["goals"];
    let mut goals = pick(native_goals, &["revision", "eventSequence"]);
    if native_goals.is_null() {
        goals = json!({"revision":0,"eventSequence":0});
    }
    goals["goal"] = if native_goals["goal"].is_object() {
        let mut goal = pick(
            &native_goals["goal"],
            &[
                "id",
                "status",
                "reason",
                "settling",
                "waitingForInput",
                "waitingForAgents",
                "waitingForCapacity",
                "limits",
                "usage",
            ],
        );
        goal["objective"] = json!(prefix(
            native_goals["goal"]["objective"]
                .as_str()
                .unwrap_or_default(),
            4096
        ));
        goal
    } else {
        Value::Null
    };
    let queue = &thread["desktop"]["queue"];
    let queued:Vec<_>=rows(&queue["items"]).iter().filter(|item|item["status"]=="pending").take(128).map(|item|{let input:Vec<&str>=rows(&item["input"]).iter().filter(|part|part["type"]=="text").filter_map(|part|part["text"].as_str()).collect();let text=preview(&input,1024);json!({"id":item["id"],"status":item["status"],"input":[{"type":"text","text":text["preview"]}],"truncated":text["truncated"],"hasAttachments":rows(&item["input"]).iter().any(|part|part["type"]!="text")})}).collect();
    let turns = page["turns"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .take(100)
        .rev()
        .cloned()
        .collect::<Vec<_>>();
    page.as_object_mut().unwrap().remove("turns");
    let snapshot = json!({"threadId":thread["id"],"title":prefix(thread["preview"].as_str().unwrap_or_default(),512),"configRevision":native_config["revision"],"configuration":if native_config.is_null(){Value::Null}else{configuration},"goals":goals,"goalControlAllowed":false,"ownership":pick(ownership,&["kind","taskId","runId"]),"activeTurnId":rows(&thread["turns"]).iter().rev().find(|turn|turn["status"]=="inProgress").map(|turn|turn["id"].clone()),"status":thread["status"]["type"].as_str().unwrap_or("unavailable"),"turns":turns,"attentionRefs":refs.iter().take(32).collect::<Vec<_>>(),"attentionComplete":refs.len()<=32,"queue":{"pendingCount":rows(&queue["items"]).iter().filter(|item|item["status"]=="pending").count(),"paused":queue["paused"]==true,"revision":queue.get("revision").cloned().unwrap_or(json!(0)),"complete":rows(&queue["items"]).len()<=128,"items":queued},"history":page,"permissionCapabilities":{"supported":features["permissionPresets"]==true,"fullAccessAvailable":features["permissionFullAccess"]==true}});
    ensure!(
        serde_json::to_vec(&snapshot)?.len() <= 192 * 1024,
        "RESOURCE_UNAVAILABLE"
    );
    Ok(snapshot)
}
