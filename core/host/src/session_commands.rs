use super::{
    Ensure, Host, gateway_owner::rich_message_input_with_command, library_store,
    workbench_submissions, worktree_catalog,
};
use anyhow::{Context, Result, bail, ensure};
use areal_local_service::storage;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    rc::Rc,
    time::Duration,
};

pub(super) struct ResolvedScope {
    pub(super) home: PathBuf,
    pub(super) alias: String,
    pub(super) logical: String,
    pub(super) canonical_id: String,
    pub(super) workspace: PathBuf,
}

fn identifier(value: Option<&Value>) -> Result<&str> {
    let text = value.and_then(Value::as_str).context("INVALID_PARAMS")?;
    ensure!(
        !text.trim().is_empty() && text.len() <= 256,
        "INVALID_PARAMS"
    );
    Ok(text)
}

fn optional_identifier(value: Option<&Value>) -> Result<Option<&str>> {
    match value {
        None => Ok(None),
        Some(value) => Ok(Some(identifier(Some(value))?)),
    }
}

fn uuid_str(value: Option<&Value>) -> Result<&str> {
    let text = value.and_then(Value::as_str).context("INVALID_PARAMS")?;
    ensure!(
        text.len() == 36
            && text
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'-')),
        "INVALID_PARAMS"
    );
    uuid::Uuid::parse_str(text).context("INVALID_PARAMS")?;
    Ok(text)
}

fn optional_uuid_or_new(value: Option<&Value>) -> Result<String> {
    match value {
        None => Ok(uuid::Uuid::new_v4().to_string()),
        Some(value) => Ok(uuid_str(Some(value))?.to_owned()),
    }
}

fn count_u64(value: Option<&Value>) -> Result<u64> {
    let number = value.and_then(Value::as_u64).context("INVALID_PARAMS")?;
    ensure!(number <= 9_007_199_254_740_991, "INVALID_PARAMS");
    Ok(number)
}

fn ensure_allowed_keys(object: &serde_json::Map<String, Value>, allowed: &[&str]) -> Result<()> {
    ensure!(
        object.keys().all(|key| allowed.contains(&key.as_str())),
        "INVALID_PARAMS"
    );
    Ok(())
}

fn map_worktree_error(error: anyhow::Error) -> anyhow::Error {
    if error.downcast_ref::<crate::wire::Error>().is_some() {
        return error;
    }
    let text = error.to_string();
    match text.as_str() {
        "INVALID_PARAMS"
        | "FORBIDDEN"
        | "CAPABILITY_UNAVAILABLE"
        | "RESOURCE_UNAVAILABLE"
        | "RESYNC_REQUIRED" => error,
        _ => crate::wire::error("COMMAND_FAILED", text.chars().take(512).collect::<String>()),
    }
}

pub(super) async fn ensure_project(host: &Rc<Host>, id: &str) -> Result<()> {
    if host.schedules.connections.shared_identity(host, id).is_ok() {
        return Ok(());
    }
    host.ensure(Ensure {
        request_id: uuid::Uuid::new_v4().to_string(),
        expected_generation: host.identity.generation.clone(),
        project_id: id.into(),
        no_auto_restart: false,
        resume_scheduling: false,
        launch_inputs: None,
        credentials: BTreeMap::new(),
    })
    .await?;
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let changed = host.schedules.connections.changed.notified();
            if host.schedules.connections.shared_identity(host, id).is_ok() {
                return Ok(());
            }
            host.admission()?;
            changed.await;
        }
    })
    .await
    .context("RESOURCE_UNAVAILABLE")?
}

pub(super) async fn resolve_project_scope(
    host: &Rc<Host>,
    source: &str,
    request: &Value,
    is_mutation: bool,
    ensure_running: bool,
) -> Result<ResolvedScope> {
    let project_id = identifier(request.get("projectId"))?;
    let home = library_store::source_home(host, source)?;
    let saved = worktree_catalog::saved_projects(&home)?;
    let (logical, alias) = if let Some(original) = saved.iter().find(|row| row["id"] == project_id)
    {
        let logical = original["logicalProjectId"]
            .as_str()
            .unwrap_or(project_id)
            .to_owned();
        if let Some(supplied) = request.get("logicalProjectId").and_then(Value::as_str)
            && supplied != logical
        {
            return Err(crate::wire::error("COMMAND_FAILED", "逻辑项目归属不匹配"));
        }
        let mut targets = Vec::new();
        for field in ["threadId", "sourceThreadId", "parentThreadId"] {
            if let Some(id) = request.get(field).and_then(Value::as_str)
                && !id.is_empty()
                && !targets.iter().any(|existing| existing == id)
            {
                targets.push(id.to_owned());
            }
        }
        let mut resolved_owners = BTreeSet::new();
        for tid in &targets {
            let resolved = worktree_catalog::thread_project(host, source, project_id, tid)
                .await
                .map_err(map_worktree_error)?;
            resolved_owners.insert(resolved);
        }
        let owner_rows = worktree_catalog::owners(&home, &logical)?;
        let req_id = request.get("requestId").and_then(Value::as_str);
        if targets.is_empty()
            && let Some(req_id) = req_id
        {
            for owner in &owner_rows {
                let Some(owner_alias) = owner["id"].as_str() else {
                    continue;
                };
                let Ok(registration) = worktree_catalog::project(host, source, owner_alias) else {
                    continue;
                };
                if let Ok((_, snapshot)) = host.journal.native_snapshot(&registration.project_id) {
                    let matched = snapshot["outcomes"].get(req_id).is_some()
                        || snapshot["pending"].as_array().is_some_and(|rows| {
                            rows.iter().any(|row| {
                                row["operationId"].as_str() == Some(req_id)
                                    || row["params"]["requestId"].as_str() == Some(req_id)
                            })
                        });
                    if matched {
                        resolved_owners.insert(owner_alias.to_owned());
                    }
                }
            }
        }
        let ops = worktree_catalog::operations(&home)?;
        if targets.is_empty()
            && let Some(req_id) = req_id
            && let Some(op) = ops.iter().find(|op| op["requestId"] == req_id)
        {
            if op["projectId"].as_str() != Some(logical.as_str()) {
                return Err(crate::wire::error(
                    "COMMAND_FAILED",
                    "原请求不属于此逻辑项目",
                ));
            }
            if let Some(exec) = op["executionProjectId"].as_str() {
                resolved_owners.insert(exec.to_owned());
            }
        }
        if let Some(exec_id) = request.get("executionProjectId").and_then(Value::as_str) {
            if !owner_rows.iter().any(|row| row["id"] == exec_id) {
                return Err(crate::wire::error(
                    "COMMAND_FAILED",
                    "执行工作区不属于此逻辑项目",
                ));
            }
            resolved_owners.insert(exec_id.to_owned());
        }
        if resolved_owners.len() > 1 {
            return Err(crate::wire::error(
                "COMMAND_FAILED",
                "一次操作不能跨越不同执行工作区",
            ));
        }
        let alias = resolved_owners
            .into_iter()
            .next()
            .unwrap_or_else(|| project_id.to_owned());
        for op in &ops {
            if op["executionProjectId"].as_str() != Some(alias.as_str()) {
                continue;
            }
            if op["deleted"] == true {
                return Err(crate::wire::error(
                    "COMMAND_FAILED",
                    "工作树目录已删除，历史仍保留",
                ));
            }
            if matches!(
                op["deletion"]["status"].as_str(),
                Some("running" | "unknown")
            ) {
                return Err(crate::wire::error(
                    "COMMAND_FAILED",
                    "工作树正在删除或结果尚未确认",
                ));
            }
            if is_mutation && op["threadId"].is_string() && op["state"] != "ready" {
                return Err(crate::wire::error(
                    "COMMAND_FAILED",
                    "工作树环境尚未就绪，不能执行会话写操作",
                ));
            }
        }
        (logical, alias)
    } else {
        ensure!(
            source == "host",
            crate::wire::error("COMMAND_FAILED", "未知工作区")
        );
        (project_id.to_owned(), project_id.to_owned())
    };
    let registration = worktree_catalog::project(host, source, &alias)?;
    if ensure_running {
        ensure_project(host, &registration.project_id).await?;
    }
    Ok(ResolvedScope {
        home,
        alias,
        logical,
        canonical_id: registration.project_id,
        workspace: registration.workspace,
    })
}

pub(super) fn record_thread_owner(home: &Path, alias: &str, thread_id: &str) {
    if alias.len() != 24 || !alias.bytes().all(|b| b.is_ascii_hexdigit()) {
        return;
    }
    if !home.join("projects.json").exists() {
        return;
    }
    let dir = home.join("thread-owners");
    if storage::private_dir(&dir).is_err() {
        return;
    }
    let path = dir.join(format!("{alias}.json"));
    let mut ids: Vec<String> = storage::read_optional(&path)
        .ok()
        .flatten()
        .unwrap_or_default();
    if !ids.iter().any(|existing| existing == thread_id) {
        ids.push(thread_id.to_owned());
        if let Ok(bytes) = serde_json::to_vec(&ids) {
            let _ = storage::write_bytes(&path, &bytes);
        }
    }
}

pub(super) async fn shared_rpc(
    host: &Host,
    project: &str,
    method: &str,
    params: Value,
) -> Result<Value> {
    let scope = host.schedules.connections.shared_identity(host, project)?;
    let response = host
        .schedules
        .connections
        .shared_workbench_request(
            host,
            project,
            (&scope.0, &scope.1, &scope.2),
            method,
            params,
        )
        .await?;
    if let Some(error) = response.get("error") {
        let message = error["message"].as_str().unwrap_or("Core request failed");
        if error["code"] == -32009 {
            bail!("TARGET_CHANGED");
        }
        if error["code"] == -32004 {
            bail!("RESOURCE_UNAVAILABLE");
        }
        return Err(crate::wire::error(
            "COMMAND_FAILED",
            message.chars().take(512).collect::<String>(),
        ));
    }
    response.get("result").cloned().context("INVALID_RESPONSE")
}

pub(super) async fn core_capabilities(host: &Host, project: &str) -> Result<Value> {
    shared_rpc(
        host,
        project,
        "areal/capabilities",
        json!({"apiVersion": "areal.core.v1"}),
    )
    .await
}

pub(super) fn has_method(caps: &Value, method: &str) -> bool {
    caps["methods"]
        .as_array()
        .is_some_and(|methods| methods.iter().any(|item| item == method))
}

async fn ensure_subscription_if_needed(
    host: &Rc<Host>,
    source: &str,
    canonical_id: &str,
    model: Option<&Value>,
) -> Result<()> {
    if model
        .and_then(|m| m.get("providerId"))
        .and_then(Value::as_str)
        == Some("areal_openai")
    {
        host.ensure_subscription_for_project(source, canonical_id)
            .await?;
    }
    Ok(())
}

pub(super) fn validate_plugin_command(value: &Value) -> Result<()> {
    let obj = value.as_object().context("INVALID_PARAMS")?;
    ensure_allowed_keys(
        obj,
        &["pluginId", "componentId", "installedDigest", "arguments"],
    )?;
    for key in ["pluginId", "componentId", "installedDigest"] {
        ensure!(
            obj.get(key)
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty()),
            "INVALID_PARAMS"
        );
    }
    let args = obj
        .get("arguments")
        .and_then(Value::as_str)
        .context("INVALID_PARAMS")?;
    ensure!(args.len() <= 65536, "INVALID_PARAMS");
    Ok(())
}

fn validate_resource_ref(value: &Value) -> Result<()> {
    let obj = value.as_object().context("INVALID_PARAMS")?;
    ensure!(
        obj.get("id")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.trim().is_empty())
            && obj
                .get("revision")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.trim().is_empty()),
        "INVALID_PARAMS"
    );
    Ok(())
}

fn validate_model_ref(value: &Value) -> Result<()> {
    let obj = value.as_object().context("INVALID_PARAMS")?;
    ensure!(
        obj.get("providerId").is_some_and(Value::is_string)
            && obj.get("modelId").is_some_and(Value::is_string),
        "INVALID_PARAMS"
    );
    Ok(())
}

fn validate_parameters(value: &Value) -> Result<()> {
    let obj = value.as_object().context("INVALID_PARAMS")?;
    for key in ["temperature", "maxOutputTokens", "contextWindowTokens"] {
        if let Some(v) = obj.get(key)
            && !v.is_null()
        {
            ensure!(v.as_f64().is_some_and(f64::is_finite), "INVALID_PARAMS");
        }
    }
    for key in ["reasoningEffort", "reasoningSummary"] {
        if let Some(v) = obj.get(key)
            && !v.is_null()
        {
            ensure!(v.is_string(), "INVALID_PARAMS");
        }
    }
    if let Some(tier) = obj.get("serviceTier")
        && !tier.is_null()
    {
        ensure!(
            matches!(tier.as_str(), Some("fast" | "default")),
            "INVALID_PARAMS"
        );
    }
    Ok(())
}

fn validate_client_options(value: &Value) -> Result<()> {
    let obj = value.as_object().context("INVALID_PARAMS")?;
    ensure_allowed_keys(
        obj,
        &[
            "permissionPreset",
            "interactionMode",
            "readOnly",
            "systemPrompt",
            "appendInstructions",
            "toolAllowlist",
            "approvalTools",
            "preapprovedTools",
            "maxModelRounds",
        ],
    )?;
    for key in ["readOnly"] {
        if let Some(v) = obj.get(key) {
            ensure!(v.is_boolean(), "INVALID_PARAMS");
        }
    }
    if let Some(preset) = obj.get("permissionPreset")
        && !preset.is_null()
    {
        ensure!(
            matches!(preset.as_str(), Some("ask" | "autoReview" | "fullAccess")),
            "INVALID_PARAMS"
        );
    }
    if let Some(mode) = obj.get("interactionMode") {
        ensure!(
            matches!(
                mode.as_str(),
                Some("interactive" | "asynchronous" | "headless")
            ),
            "INVALID_PARAMS"
        );
    }
    if let Some(prompt) = obj.get("systemPrompt")
        && !prompt.is_null()
    {
        ensure!(prompt.is_string(), "INVALID_PARAMS");
    }
    if let Some(append) = obj.get("appendInstructions") {
        ensure!(append.is_string(), "INVALID_PARAMS");
    }
    if let Some(list) = obj.get("toolAllowlist")
        && !list.is_null()
    {
        ensure!(
            list.as_array()
                .is_some_and(|items| items.iter().all(Value::is_string)),
            "INVALID_PARAMS"
        );
    }
    for key in ["approvalTools", "preapprovedTools"] {
        if let Some(list) = obj.get(key) {
            ensure!(
                list.as_array()
                    .is_some_and(|items| items.iter().all(Value::is_string)),
                "INVALID_PARAMS"
            );
        }
    }
    if let Some(rounds) = obj.get("maxModelRounds")
        && !rounds.is_null()
    {
        count_u64(Some(rounds))?;
    }
    Ok(())
}

pub(super) async fn execute(
    host: &Rc<Host>,
    source: &str,
    command: &str,
    request: &Value,
) -> Result<Value> {
    match command {
        "connect" => connect(host, source, request).await,
        "fork" => fork(host, source, request).await,
        "editMessage" => edit_message(host, source, request).await,
        "continue" => continue_turn(host, source, request).await,
        "configure" => configure(host, source, request).await,
        "prediction" => prediction(host, source, request).await,
        "queue" => queue(host, source, request).await,
        "queueEdit" => queue_edit(host, source, request).await,
        "reconcile" => reconcile(host, source, request).await,
        "dismissRecovery" => dismiss_recovery(host, source, request).await,
        _ => bail!("methodNotFound"),
    }
}

async fn connect(host: &Rc<Host>, source: &str, request: &Value) -> Result<Value> {
    let object = request.as_object().context("INVALID_PARAMS")?;
    ensure_allowed_keys(object, &["projectId", "threadId", "resumeScheduling"])?;
    optional_identifier(request.get("threadId"))?;
    let resume = match request.get("resumeScheduling") {
        None => false,
        Some(value) => value.as_bool().context("INVALID_PARAMS")?,
    };
    let scope = resolve_project_scope(host, source, request, true, false).await?;
    let id = &scope.canonical_id;
    ensure!(
        resume || !host.schedules.suppressed(id),
        crate::wire::error("CORE_STOPPED", "项目已停止，请明确恢复调度")
    );
    // 未决启动只核对原回执；显式恢复也不能越过原启动另发一次。
    for path in storage::json_records(&host.home.join("host/operations"), false)? {
        let record: super::Operation = storage::read(&path)?;
        if record.receipt["method"] == "project.ensure"
            && record.receipt["projectId"] == *id
            && !record.settled()
        {
            let original = identifier(record.receipt.get("requestId"))?;
            let receipt = host
                .reconcile(original)
                .await?
                .context("RESOURCE_UNAVAILABLE")?;
            if receipt["state"] == "completed"
                && !host.schedules.suppressed(id)
                && let Ok((_, generation, _)) = host.schedules.connections.shared_identity(host, id)
            {
                return Ok(
                    json!({"projectId":id,"state":"ready","activationId":original,"serviceGeneration":generation}),
                );
            }
            if matches!(receipt["state"].as_str(), Some("completed" | "blocked")) {
                return Ok(
                    json!({"projectId":id,"state":"blocked","activationId":original,"reason":if host.schedules.suppressed(id) { "explicitlyStopped" } else { "activationIncomplete" }}),
                );
            }
            return Ok(
                json!({"projectId":id,"state":"pending","activationId":original,"reason":"activationIncomplete"}),
            );
        }
    }
    let activation = if resume {
        let original = uuid::Uuid::new_v4().to_string();
        let result = host
            .ensure(Ensure {
                request_id: original.clone(),
                expected_generation: host.identity.generation.clone(),
                project_id: id.clone(),
                no_auto_restart: false,
                resume_scheduling: true,
                launch_inputs: None,
                credentials: BTreeMap::new(),
            })
            .await;
        if let Some(record) = host.receipt(&original)?
            && record.receipt["state"] != "completed"
        {
            return Ok(
                json!({"projectId":id,"state":if record.settled() { "blocked" } else { "pending" },"activationId":original,"reason":"activationIncomplete"}),
            );
        }
        result?;
        Some(original)
    } else {
        ensure_project(host, id).await?;
        None
    };
    let (_, generation, _) = host.schedules.connections.shared_identity(host, id)?;
    let mut response = if host.schedules.suppressed(id) {
        json!({"projectId":id,"state":"blocked","reason":"explicitlyStopped"})
    } else {
        json!({"projectId":id,"state":"ready","serviceGeneration":generation})
    };
    if let Some(activation) = activation {
        response["activationId"] = json!(activation);
    }
    Ok(response)
}

async fn fork(host: &Rc<Host>, source: &str, request: &Value) -> Result<Value> {
    let _obj = request.as_object().context("INVALID_PARAMS")?;
    let source_thread_id = identifier(request.get("sourceThreadId"))?;
    ensure!(
        request.get("workspaceMode").and_then(Value::as_str) == Some("sharedCurrent"),
        "INVALID_PARAMS"
    );
    let anchor = request
        .get("anchor")
        .and_then(Value::as_object)
        .context("INVALID_PARAMS")?;
    let turn_id = identifier(anchor.get("turnId"))?;
    let boundary = anchor
        .get("boundary")
        .and_then(Value::as_str)
        .filter(|b| matches!(*b, "before" | "after"))
        .context("INVALID_PARAMS")?;
    let request_id = optional_uuid_or_new(request.get("requestId"))?;
    if let Some(target) = request.get("target") {
        let target_obj = target.as_object().context("INVALID_PARAMS")?;
        if let Some(profile) = target_obj.get("agentProfile")
            && !profile.is_null()
        {
            validate_resource_ref(profile)?;
        }
        if let Some(model) = target_obj.get("model")
            && !model.is_null()
        {
            validate_model_ref(model)?;
        }
        if let Some(params) = target_obj.get("parameters")
            && !params.is_null()
        {
            validate_parameters(params)?;
        }
    }

    let scope = resolve_project_scope(host, source, request, true, true).await?;
    let caps = core_capabilities(host, &scope.canonical_id).await?;
    if !has_method(&caps, "areal/thread/fork") {
        return Err(crate::wire::error(
            "COMMAND_FAILED",
            "当前 Core 不支持从此轮次创建分支",
        ));
    }
    let mut wire = json!({
        "requestId": request_id,
        "sourceThreadId": source_thread_id,
        "anchor": { "turnId": turn_id, "boundary": boundary },
        "workspaceMode": "sharedCurrent",
    });
    if let Some(target) = request.get("target") {
        wire["target"] = target.clone();
    }
    let typed: areal_protocol::desktop::ForkThread =
        serde_json::from_value(wire).context("INVALID_PARAMS")?;
    let result = workbench_submissions::submit_shared(
        host,
        &scope.canonical_id,
        "areal/thread/fork",
        serde_json::to_value(typed)?,
        true,
    )
    .await?;
    let thread_id = result["thread"]["id"]
        .as_str()
        .context("INVALID_RESPONSE")?;
    let req_id = result["requestId"].as_str().unwrap_or(&request_id);
    record_thread_owner(&scope.home, &scope.alias, thread_id);
    Ok(json!({ "threadId": thread_id, "requestId": req_id }))
}

async fn edit_message(host: &Rc<Host>, source: &str, request: &Value) -> Result<Value> {
    let obj = request.as_object().context("INVALID_PARAMS")?;
    ensure_allowed_keys(
        obj,
        &[
            "projectId",
            "logicalProjectId",
            "executionProjectId",
            "threadId",
            "expectedTurnId",
            "itemId",
            "expectedConfigRevision",
            "requestId",
            "text",
            "attachments",
            "mcpContent",
            "conversationQuotes",
            "command",
        ],
    )?;
    let thread_id = identifier(obj.get("threadId"))?;
    let expected_turn_id = identifier(obj.get("expectedTurnId"))?;
    let item_id = identifier(obj.get("itemId"))?;
    let expected_config_revision = count_u64(obj.get("expectedConfigRevision"))?;
    let request_id = uuid_str(obj.get("requestId"))?;
    let text = obj
        .get("text")
        .and_then(Value::as_str)
        .context("INVALID_PARAMS")?;
    if let Some(cmd) = obj.get("command") {
        validate_plugin_command(cmd)?;
    }
    ensure!(
        !text.trim().is_empty() || obj.get("command").is_some(),
        "INVALID_PARAMS"
    );
    let input = rich_message_input_with_command(text, request, obj.get("command").is_some())
        .context("INVALID_PARAMS")?;

    let scope = resolve_project_scope(host, source, request, true, true).await?;
    let caps = core_capabilities(host, &scope.canonical_id).await?;
    if caps["features"]["editLastMessage"] != true {
        return Err(crate::wire::error(
            "COMMAND_FAILED",
            "当前 Core 不支持编辑消息，请更新 Core。",
        ));
    }
    let inspection = shared_rpc(
        host,
        &scope.canonical_id,
        "areal/thread/inspect",
        json!({ "threadId": thread_id }),
    )
    .await?;
    ensure_subscription_if_needed(
        host,
        source,
        &scope.canonical_id,
        inspection["configuration"].get("model"),
    )
    .await?;

    let mut intent = json!({
        "type": "edit",
        "expectedTurnId": expected_turn_id,
        "itemId": item_id,
        "input": input,
    });
    if let Some(cmd) = obj.get("command") {
        intent["command"] = cmd.clone();
    }
    let typed: areal_protocol::desktop::TurnSubmit = serde_json::from_value(json!({
        "requestId": request_id,
        "threadId": thread_id,
        "expectedConfigRevision": expected_config_revision,
        "intent": intent,
    }))
    .context("INVALID_PARAMS")?;
    workbench_submissions::submit_shared(
        host,
        &scope.canonical_id,
        "areal/turn/submit",
        serde_json::to_value(typed)?,
        true,
    )
    .await
}

async fn continue_turn(host: &Rc<Host>, source: &str, request: &Value) -> Result<Value> {
    let obj = request.as_object().context("INVALID_PARAMS")?;
    ensure_allowed_keys(
        obj,
        &[
            "projectId",
            "logicalProjectId",
            "executionProjectId",
            "threadId",
            "expectedTurnId",
            "expectedConfigRevision",
            "requestId",
        ],
    )?;
    let thread_id = identifier(obj.get("threadId"))?;
    let expected_turn_id = identifier(obj.get("expectedTurnId"))?;
    let supplied_revision = obj
        .get("expectedConfigRevision")
        .map(|v| count_u64(Some(v)))
        .transpose()?;
    let request_id = optional_uuid_or_new(obj.get("requestId"))?;

    let scope = resolve_project_scope(host, source, request, true, true).await?;
    let caps = core_capabilities(host, &scope.canonical_id).await?;
    if caps["features"]["ordinaryTurnSubmit"] != true {
        return Err(crate::wire::error(
            "COMMAND_FAILED",
            "当前 Core 不支持继续执行，请更新 Core。",
        ));
    }
    let inspection = shared_rpc(
        host,
        &scope.canonical_id,
        "areal/thread/inspect",
        json!({ "threadId": thread_id }),
    )
    .await?;
    ensure_subscription_if_needed(
        host,
        source,
        &scope.canonical_id,
        inspection["configuration"].get("model"),
    )
    .await?;
    let expected_config_revision = match supplied_revision {
        Some(rev) => rev,
        None => inspection["configuration"]["revision"]
            .as_u64()
            .context("INVALID_RESPONSE")?,
    };
    let typed: areal_protocol::desktop::TurnSubmit = serde_json::from_value(json!({
        "requestId": request_id,
        "threadId": thread_id,
        "expectedConfigRevision": expected_config_revision,
        "intent": {
            "type": "continue",
            "expectedTurnId": expected_turn_id,
        },
    }))
    .context("INVALID_PARAMS")?;
    workbench_submissions::submit_shared(
        host,
        &scope.canonical_id,
        "areal/turn/submit",
        serde_json::to_value(typed)?,
        true,
    )
    .await
}

async fn prediction(host: &Rc<Host>, source: &str, request: &Value) -> Result<Value> {
    let obj = request.as_object().context("INVALID_PARAMS")?;
    ensure_allowed_keys(
        obj,
        &[
            "projectId",
            "logicalProjectId",
            "executionProjectId",
            "threadId",
            "sourceTurnId",
            "operation",
        ],
    )?;
    let thread_id = identifier(obj.get("threadId"))?;
    let source_turn_id = identifier(obj.get("sourceTurnId"))?;
    let operation = obj
        .get("operation")
        .and_then(Value::as_str)
        .filter(|op| matches!(*op, "request" | "cancel"))
        .context("INVALID_PARAMS")?;

    let scope = resolve_project_scope(host, source, request, false, true).await?;
    let caps = core_capabilities(host, &scope.canonical_id).await?;
    if !has_method(&caps, "areal/thread/prediction") {
        return Ok(Value::Null);
    }
    shared_rpc(
        host,
        &scope.canonical_id,
        "areal/thread/prediction",
        json!({
            "threadId": thread_id,
            "sourceTurnId": source_turn_id,
            "operation": operation,
        }),
    )
    .await
}

async fn configure(host: &Rc<Host>, source: &str, request: &Value) -> Result<Value> {
    let obj = request.as_object().context("INVALID_PARAMS")?;
    let thread_id = identifier(obj.get("threadId"))?;
    let request_id = optional_uuid_or_new(obj.get("requestId"))?;
    let expected_revision = obj
        .get("expectedRevision")
        .map(|v| count_u64(Some(v)))
        .transpose()?;
    if ![
        "model",
        "profile",
        "options",
        "parameters",
        "selectedSkills",
    ]
    .iter()
    .any(|key| obj.contains_key(*key))
    {
        return Err(crate::wire::error("COMMAND_FAILED", "请选择需要修改的配置"));
    }
    if obj.get("profile") == Some(&Value::Null) {
        return Err(crate::wire::error(
            "COMMAND_FAILED",
            "当前 Core 不支持清除已选择的 Profile",
        ));
    }
    if let Some(profile) = obj.get("profile") {
        validate_resource_ref(profile)?;
    }
    if let Some(model) = obj.get("model")
        && !model.is_null()
    {
        validate_model_ref(model)?;
    }
    if let Some(parameters) = obj.get("parameters") {
        validate_parameters(parameters)?;
    }
    if let Some(options) = obj.get("options") {
        validate_client_options(options)?;
    }
    if let Some(skills) = obj.get("selectedSkills") {
        let Some(items) = skills.as_array() else {
            return Err(crate::wire::error("COMMAND_FAILED", "所选技能无效"));
        };
        for item in items {
            if validate_resource_ref(item).is_err() {
                return Err(crate::wire::error("COMMAND_FAILED", "所选技能无效"));
            }
        }
    }

    let scope = resolve_project_scope(host, source, request, false, true).await?;
    let caps = core_capabilities(host, &scope.canonical_id).await?;
    if obj
        .get("options")
        .and_then(|o| o.get("permissionPreset"))
        .is_some_and(|v| !v.is_null())
        && caps["features"]["permissionPresets"] != true
    {
        return Err(crate::wire::error(
            "COMMAND_FAILED",
            "当前 Core 不支持权限模式，请更新后台后重试",
        ));
    }

    let snapshot = shared_rpc(
        host,
        &scope.canonical_id,
        "thread/read",
        json!({ "threadId": thread_id, "includeTurns": true }),
    )
    .await?;
    let read_thread = &snapshot["thread"];
    let is_read_only_side = read_thread["conversation"]["policy"]["kind"] == "sideReadOnlyV1";
    let (current_config, active_turn_id) = if is_read_only_side {
        if read_thread["id"].as_str() != Some(thread_id)
            || read_thread["conversation"]["kind"] != "side"
        {
            return Err(crate::wire::error(
                "COMMAND_FAILED",
                "Side 配置快照与目标会话不匹配",
            ));
        }
        let cfg = read_thread["desktop"]["configuration"].clone();
        ensure!(cfg.is_object(), "CORE_INCOMPATIBLE");
        let active = read_thread["turns"]
            .as_array()
            .and_then(|turns| turns.iter().find(|t| t["status"] == "inProgress"))
            .and_then(|t| t["id"].as_str())
            .map(str::to_owned);
        (cfg, active)
    } else {
        let inspection = shared_rpc(
            host,
            &scope.canonical_id,
            "areal/thread/inspect",
            json!({ "threadId": thread_id }),
        )
        .await?;
        ensure!(inspection["configuration"].is_object(), "CORE_INCOMPATIBLE");
        let active = inspection["activeTurnId"].as_str().map(str::to_owned);
        (inspection["configuration"].clone(), active)
    };

    if current_config["options"]["appendInstructions"]
        .as_str()
        .is_some_and(|s| s.starts_with("AREAL_TASK_DRAFT_V1\n"))
        && (obj.contains_key("options") || obj.contains_key("profile"))
    {
        return Err(crate::wire::error(
            "COMMAND_FAILED",
            "任务管理会话的执行限制不能修改；请在会话中描述要调整的任务。",
        ));
    }
    if active_turn_id.is_some() {
        return Err(crate::wire::error(
            "COMMAND_FAILED",
            "任务正在执行，完成或停止后才能修改配置",
        ));
    }
    let current_rev = current_config["revision"]
        .as_u64()
        .context("CORE_INCOMPATIBLE")?;
    if expected_revision.is_some_and(|rev| rev != current_rev) {
        return Err(crate::wire::error(
            "COMMAND_FAILED",
            "会话配置已变化，请刷新后重新保存",
        ));
    }

    let mut params = serde_json::Map::new();
    params.insert("requestId".into(), json!(request_id));
    params.insert("threadId".into(), json!(thread_id));
    params.insert("expectedRevision".into(), json!(current_rev));
    if let Some(profile) = obj.get("profile") {
        params.insert("agentProfile".into(), profile.clone());
    }
    if let Some(model) = obj.get("model") {
        if model.is_null() {
            params.insert("resetModel".into(), json!(true));
        } else {
            params.insert("model".into(), model.clone());
        }
    }
    if let Some(incoming_options) = obj.get("options").and_then(Value::as_object) {
        let mut merged = current_config["options"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        merged.extend(incoming_options.clone());
        params.insert("options".into(), Value::Object(merged));
    }
    if let Some(parameters) = obj.get("parameters") {
        params.insert("parameters".into(), parameters.clone());
    } else if obj.contains_key("model") {
        params.insert("parameters".into(), json!({}));
    }
    if let Some(skills) = obj.get("selectedSkills").and_then(Value::as_array) {
        let mapped: Vec<Value> = skills
            .iter()
            .map(|skill| json!({ "id": skill["id"], "revision": skill["revision"] }))
            .collect();
        params.insert("selectedSkills".into(), json!(mapped));
    }
    let typed: areal_protocol::desktop::ConfigureThread =
        serde_json::from_value(Value::Object(params)).context("INVALID_PARAMS")?;
    workbench_submissions::submit_shared(
        host,
        &scope.canonical_id,
        "areal/thread/configure",
        serde_json::to_value(typed)?,
        true,
    )
    .await?;
    Ok(json!({
        "projects": [],
        "library": library_store::read_source(host, source)?,
    }))
}

async fn queue(host: &Rc<Host>, source: &str, request: &Value) -> Result<Value> {
    let obj = request.as_object().context("INVALID_PARAMS")?;
    let thread_id = identifier(obj.get("threadId"))?;
    let request_id = obj.get("requestId");
    if request_id.is_none() {
        ensure!(obj.get("operation").is_none(), "INVALID_PARAMS");
        let scope = resolve_project_scope(host, source, request, false, true).await?;
        return shared_rpc(
            host,
            &scope.canonical_id,
            "areal/queue/list",
            json!({ "threadId": thread_id }),
        )
        .await;
    }
    let req_id = uuid_str(request_id)?;
    let operation = obj
        .get("operation")
        .and_then(Value::as_str)
        .filter(|op| {
            matches!(
                *op,
                "update" | "remove" | "reorder" | "pause" | "resume" | "steer"
            )
        })
        .context("INVALID_PARAMS")?;
    let scope = resolve_project_scope(host, source, request, false, true).await?;
    workbench_submissions::reconcile_shared(
        host,
        &scope.canonical_id,
        &format!("areal/queue/{operation}"),
        json!({ "requestId": req_id, "threadId": thread_id }),
    )
    .await
}

async fn queue_edit(host: &Rc<Host>, source: &str, request: &Value) -> Result<Value> {
    let obj = request.as_object().context("INVALID_PARAMS")?;
    let thread_id = identifier(obj.get("threadId"))?;
    let operation = obj
        .get("operation")
        .and_then(Value::as_str)
        .filter(|op| {
            matches!(
                *op,
                "update" | "remove" | "reorder" | "pause" | "resume" | "steer"
            )
        })
        .context("INVALID_PARAMS")?;
    let expected_revision = count_u64(obj.get("expectedRevision"))?;
    let request_id = optional_uuid_or_new(obj.get("requestId"))?;

    let is_mutation = !matches!(operation, "pause" | "remove");
    let scope = resolve_project_scope(host, source, request, is_mutation, true).await?;

    let mut params = serde_json::Map::new();
    params.insert("requestId".into(), json!(request_id));
    params.insert("threadId".into(), json!(thread_id));
    params.insert("expectedRevision".into(), json!(expected_revision));

    if matches!(operation, "update" | "remove" | "steer") {
        let queue_item_id = identifier(obj.get("queueItemId"))?;
        params.insert("queueItemId".into(), json!(queue_item_id));
    }
    if operation == "steer" {
        let expected_turn_id = identifier(obj.get("expectedTurnId"))?;
        params.insert("expectedTurnId".into(), json!(expected_turn_id));
    }
    if operation == "reorder" {
        let ids = obj
            .get("queueItemIds")
            .and_then(Value::as_array)
            .context("INVALID_PARAMS")?;
        ensure!(ids.len() <= 128, "INVALID_PARAMS");
        let mut seen = BTreeSet::new();
        for id in ids {
            let text = id.as_str().context("INVALID_PARAMS")?;
            ensure!(seen.insert(text), "INVALID_PARAMS");
        }
        params.insert("queueItemIds".into(), Value::Array(ids.clone()));
    }
    if operation == "update" {
        let queue_item_id = identifier(obj.get("queueItemId"))?;
        let retained = match obj.get("retainedInput") {
            None => Vec::new(),
            Some(value) => value.as_array().context("INVALID_PARAMS")?.clone(),
        };
        ensure!(retained.len() <= 16, "INVALID_PARAMS");
        let mut original_inputs: Option<Vec<Value>> = None;
        for part in &retained {
            let part_obj = part.as_object().context("INVALID_PARAMS")?;
            if part_obj.get("type").and_then(Value::as_str) == Some("text") {
                return Err(crate::wire::error(
                    "COMMAND_FAILED",
                    "排队附件引用已变化，请核对原消息",
                ));
            }
            let inputs = match &original_inputs {
                Some(inputs) => inputs,
                None => {
                    let current = shared_rpc(
                        host,
                        &scope.canonical_id,
                        "areal/queue/list",
                        json!({ "threadId": thread_id }),
                    )
                    .await?;
                    let found = current["items"]
                        .as_array()
                        .and_then(|items| items.iter().find(|item| item["id"] == queue_item_id))
                        .and_then(|item| item["input"].as_array())
                        .cloned()
                        .unwrap_or_default();
                    original_inputs = Some(found);
                    original_inputs.as_ref().unwrap()
                }
            };
            if !inputs.iter().any(|existing| existing == part) {
                return Err(crate::wire::error(
                    "COMMAND_FAILED",
                    "排队附件引用已变化，请核对原消息",
                ));
            }
        }
        let has_changed = obj
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|t| !t.trim().is_empty())
            || obj
                .get("attachments")
                .and_then(Value::as_array)
                .is_some_and(|a| !a.is_empty())
            || obj
                .get("mcpContent")
                .and_then(Value::as_array)
                .is_some_and(|m| !m.is_empty())
            || obj
                .get("conversationQuotes")
                .and_then(Value::as_array)
                .is_some_and(|q| !q.is_empty())
            || obj
                .get("contextParts")
                .and_then(Value::as_array)
                .is_some_and(|c| !c.is_empty());
        let changed = if has_changed {
            let text = obj.get("text").and_then(Value::as_str).unwrap_or_default();
            serde_json::to_value(
                rich_message_input_with_command(text, request, false).context("INVALID_PARAMS")?,
            )?
            .as_array()
            .cloned()
            .unwrap_or_default()
        } else {
            Vec::new()
        };
        let mut combined = Vec::new();
        for part in &changed {
            if part["type"] == "text" {
                combined.push(part.clone());
            }
        }
        combined.extend(retained);
        for part in &changed {
            if part["type"] != "text" {
                combined.push(part.clone());
            }
        }
        let non_text = combined
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) != Some("text"))
            .count();
        if combined.is_empty() || non_text > 16 {
            return Err(crate::wire::error(
                "COMMAND_FAILED",
                "排队消息不能为空，且最多 16 个附件",
            ));
        }
        params.insert("input".into(), Value::Array(combined));
    }

    workbench_submissions::submit_shared(
        host,
        &scope.canonical_id,
        &format!("areal/queue/{operation}"),
        Value::Object(params),
        true,
    )
    .await
}

async fn reconcile(host: &Rc<Host>, source: &str, request: &Value) -> Result<Value> {
    let obj = request.as_object().context("INVALID_PARAMS")?;
    ensure_allowed_keys(
        obj,
        &[
            "projectId",
            "logicalProjectId",
            "executionProjectId",
            "requestId",
        ],
    )?;
    let filter_request = optional_identifier(obj.get("requestId"))?;
    ensure!(
        obj.get("executionProjectId").is_none() || filter_request.is_some(),
        "INVALID_PARAMS"
    );
    // 诊断已指明原执行工作区，只查日志与已有连接，不能唤醒已停止的工作区。
    let scope = resolve_project_scope(
        host,
        source,
        request,
        false,
        obj.get("executionProjectId").is_none(),
    )
    .await?;

    let mut merged =
        workbench_submissions::reconcile_project(host, &scope.canonical_id, filter_request).await?;
    if filter_request.is_none() && obj.get("executionProjectId").is_none() {
        let owners = worktree_catalog::owners(&scope.home, &scope.logical)?;
        for owner in owners {
            let Some(alias) = owner["id"].as_str() else {
                continue;
            };
            if alias == scope.alias {
                continue;
            }
            let Ok(reg) = worktree_catalog::project(host, source, alias) else {
                continue;
            };
            let sibling_outcomes = if host
                .schedules
                .connections
                .shared_identity(host, &reg.project_id)
                .is_ok()
            {
                workbench_submissions::reconcile_project(host, &reg.project_id, None)
                    .await
                    .unwrap_or_default()
            } else {
                // 未运行的工作树仍归集已落盘的历史终态，不因 reconcile 额外拉起休眠进程。
                serde_json::Map::new()
            };
            for (k, v) in sibling_outcomes {
                merged.entry(k).or_insert(v);
            }
        }
    }
    Ok(json!({ "outcomes": merged }))
}

async fn dismiss_recovery(host: &Rc<Host>, source: &str, request: &Value) -> Result<Value> {
    let obj = request.as_object().context("INVALID_PARAMS")?;
    ensure_allowed_keys(
        obj,
        &[
            "projectId",
            "logicalProjectId",
            "executionProjectId",
            "requestId",
        ],
    )?;
    let req_id = identifier(obj.get("requestId"))?;
    let scope = resolve_project_scope(host, source, request, false, true).await?;
    let _ = core_capabilities(host, &scope.canonical_id).await?;
    host.journal.native_dismiss(&scope.canonical_id, req_id)?;
    host.changed();
    Ok(json!({
        "projects": [],
        "library": library_store::read_source(host, source)?,
    }))
}

pub(super) async fn side(host: &Rc<Host>, source: &str, request: &Value) -> Result<Value> {
    let obj = request.as_object().context("INVALID_PARAMS")?;
    if let Some(req_id) = obj.get("requestId") {
        identifier(Some(req_id))?;
    }
    if let Some(reset) = obj.get("resetModel") {
        ensure!(reset.is_boolean(), "INVALID_PARAMS");
        if reset == true {
            ensure!(!obj.contains_key("model"), "INVALID_PARAMS");
        }
    }
    if let Some(model) = obj.get("model") {
        validate_model_ref(model)?;
    }
    if let Some(params) = obj.get("parameters") {
        validate_parameters(params)?;
    }
    let operation = obj
        .get("operation")
        .and_then(Value::as_str)
        .context("INVALID_PARAMS")?;

    let is_mutation =
        matches!(operation, "start" | "send" | "create" | "close") && operation == "create";
    let scope = resolve_project_scope(host, source, request, is_mutation, true).await?;
    let caps = core_capabilities(host, &scope.canonical_id).await?;
    if !has_method(&caps, "areal/side/start") {
        return Err(crate::wire::error(
            "COMMAND_FAILED",
            "当前 Core 不支持旁路讨论",
        ));
    }

    match operation {
        "list" => {
            let source_thread_id = identifier(obj.get("sourceThreadId"))?;
            if let Some(archived) = obj.get("includeArchived") {
                ensure!(archived.is_boolean(), "INVALID_PARAMS");
            }
            if let Some(cursor) = obj.get("cursor") {
                ensure!(cursor.is_string(), "INVALID_PARAMS");
            }
            if !has_method(&caps, "areal/conversation/list") {
                return Err(crate::wire::error(
                    "COMMAND_FAILED",
                    "当前 Core 不支持相关讨论列表",
                ));
            }
            let mut query = json!({
                "view": "side",
                "sourceThreadId": source_thread_id,
                "includeArchived": obj.get("includeArchived").and_then(Value::as_bool) == Some(true),
                "limit": 30,
            });
            if let Some(cursor) = obj.get("cursor").and_then(Value::as_str)
                && !cursor.is_empty()
            {
                query["cursor"] = json!(cursor);
            }
            let mut page =
                shared_rpc(host, &scope.canonical_id, "areal/conversation/list", query).await?;
            let filtered = page["data"]
                .as_array()
                .context("INVALID_RESPONSE")?
                .iter()
                .filter(|thread| thread["conversation"]["policy"]["kind"] == "sideReadOnlyV1")
                .cloned()
                .collect::<Vec<_>>();
            page["data"] = Value::Array(filtered);
            Ok(page)
        }
        "context" => {
            let thread_id = identifier(obj.get("threadId"))?;
            let mut query = json!({ "threadId": thread_id });
            for key in ["cursor", "evidenceRef"] {
                if let Some(value) = obj.get(key) {
                    let s = value.as_str().context("INVALID_PARAMS")?;
                    if !s.is_empty() {
                        query[key] = json!(s);
                    }
                }
            }
            if let Some(max_bytes) = obj.get("maxBytes") {
                let bytes = count_u64(Some(max_bytes))?;
                ensure!((64..=16384).contains(&bytes), "INVALID_PARAMS");
                query["maxBytes"] = json!(bytes);
            }
            shared_rpc(host, &scope.canonical_id, "areal/side/context/read", query).await
        }
        "create" | "close" => {
            if caps["features"]["sideExecutableV2"] != true {
                return Err(crate::wire::error(
                    "COMMAND_FAILED",
                    "当前 Core 不支持可执行 Side Chat",
                ));
            }
            let method = format!("areal/side/{operation}");
            let req_id = uuid_str(obj.get("requestId"))?;
            let wire = if operation == "create" {
                ensure_allowed_keys(
                    obj,
                    &[
                        "projectId",
                        "logicalProjectId",
                        "executionProjectId",
                        "operation",
                        "sourceThreadId",
                        "requestId",
                        "firstInput",
                    ],
                )?;
                let source_thread_id = identifier(obj.get("sourceThreadId"))?;
                let mut first_input = None;
                if let Some(first) = obj.get("firstInput") {
                    let first_obj = first.as_object().context("INVALID_PARAMS")?;
                    ensure_allowed_keys(first_obj, &["text"])?;
                    let text = first_obj
                        .get("text")
                        .and_then(Value::as_str)
                        .filter(|s| !s.trim().is_empty() && s.len() <= 64 * 1024)
                        .context("INVALID_PARAMS")?;
                    let inspection = shared_rpc(
                        host,
                        &scope.canonical_id,
                        "areal/thread/inspect",
                        json!({ "threadId": source_thread_id }),
                    )
                    .await?;
                    ensure_subscription_if_needed(
                        host,
                        source,
                        &scope.canonical_id,
                        inspection["configuration"].get("model"),
                    )
                    .await?;
                    first_input = Some(vec![areal_protocol::Input::text(text)]);
                }
                let typed: areal_protocol::desktop::SideCreate = serde_json::from_value(json!({
                    "requestId": req_id,
                    "sourceThreadId": source_thread_id,
                    "firstInput": first_input,
                }))
                .context("INVALID_PARAMS")?;
                serde_json::to_value(typed)?
            } else {
                ensure_allowed_keys(
                    obj,
                    &[
                        "projectId",
                        "logicalProjectId",
                        "executionProjectId",
                        "operation",
                        "threadId",
                        "requestId",
                    ],
                )?;
                let thread_id = identifier(obj.get("threadId"))?;
                let typed: areal_protocol::desktop::SideClose = serde_json::from_value(json!({
                    "requestId": req_id,
                    "threadId": thread_id,
                }))
                .context("INVALID_PARAMS")?;
                serde_json::to_value(typed)?
            };
            let result = workbench_submissions::submit_shared(
                host,
                &scope.canonical_id,
                &method,
                wire,
                true,
            )
            .await?;
            let child_id = result["thread"]["id"]
                .as_str()
                .or_else(|| result["threadId"].as_str())
                .context("INVALID_RESPONSE")?;
            if operation == "create" {
                record_thread_owner(&scope.home, &scope.alias, child_id);
                let mut out = json!({
                    "requestId": result["requestId"].as_str().unwrap_or(req_id),
                    "threadId": child_id,
                });
                if let Some(turn_id) = result["turn"]["id"].as_str() {
                    out["turnId"] = json!(turn_id);
                }
                Ok(out)
            } else {
                Ok(result)
            }
        }
        "recover" => {
            let req_id = uuid_str(obj.get("requestId"))?;
            let source_thread_id = optional_identifier(obj.get("sourceThreadId"))?;
            let thread_id = optional_identifier(obj.get("threadId"))?;
            let method = match obj.get("method").and_then(Value::as_str) {
                None => "areal/side/start",
                Some(m @ ("areal/side/start" | "areal/side/create" | "areal/side/close")) => m,
                Some(_) => bail!("INVALID_PARAMS"),
            };
            let mut query = json!({ "requestId": req_id });
            if let Some(id) = source_thread_id {
                query["sourceThreadId"] = json!(id);
            }
            if let Some(id) = thread_id {
                query["threadId"] = json!(id);
            }
            let recovered =
                workbench_submissions::reconcile_shared(host, &scope.canonical_id, method, query)
                    .await?;
            if recovered["confirmed"] != true || recovered.get("status").is_none() {
                return Ok(json!({ "confirmed": false }));
            }
            if recovered["status"] == "failed" || recovered["accepted"] == false {
                return Ok(json!({
                    "confirmed": true,
                    "requestId": req_id,
                    "status": "failed",
                    "accepted": recovered["accepted"].as_bool().unwrap_or(false),
                    "message": recovered["message"].as_str().unwrap_or("操作未完成，请检查后重试。"),
                }));
            }
            let Some(result) = recovered.get("result") else {
                return Ok(json!({ "confirmed": false }));
            };
            let Some(id) = result["threadId"]
                .as_str()
                .or_else(|| result["thread"]["id"].as_str())
            else {
                return Ok(json!({ "confirmed": false }));
            };
            if method != "areal/side/close" {
                record_thread_owner(&scope.home, &scope.alias, id);
            }
            let mut out = json!({
                "confirmed": true,
                "requestId": req_id,
                "threadId": id,
            });
            if let Some(turn_id) = result["turnId"]
                .as_str()
                .or_else(|| result["turn"]["id"].as_str())
            {
                out["turnId"] = json!(turn_id);
            }
            if method == "areal/side/close" {
                out["accepted"] = json!(true);
                out["cleanupConfirmed"] = json!(result["cleanupConfirmed"] == true);
            }
            Ok(out)
        }
        "send" => {
            let thread_id = identifier(obj.get("threadId"))?;
            let text = obj
                .get("text")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty() && s.len() <= 64 * 1024)
                .context("INVALID_PARAMS")?;
            let req_id = optional_uuid_or_new(obj.get("requestId"))?;
            let read = shared_rpc(
                host,
                &scope.canonical_id,
                "thread/read",
                json!({ "threadId": thread_id, "includeTurns": false }),
            )
            .await?;
            if read["thread"]["conversation"]["kind"] != "side" {
                return Err(crate::wire::error("COMMAND_FAILED", "目标不是旁路讨论"));
            }
            ensure_subscription_if_needed(
                host,
                source,
                &scope.canonical_id,
                read["thread"]["desktop"]["configuration"].get("model"),
            )
            .await?;
            let mut input = areal_protocol::Input::text(text);
            if let Some(parts) = obj.get("contextParts") {
                let parts: Vec<areal_protocol::ContextPart> =
                    serde_json::from_value(parts.clone()).context("INVALID_PARAMS")?;
                input = input.with_context_parts(parts);
            }
            let typed: areal_protocol::desktop::TurnStart = serde_json::from_value(json!({
                "requestId": req_id,
                "threadId": thread_id,
                "input": [input],
                "expectedConfigRevision": Value::Null,
            }))
            .context("INVALID_PARAMS")?;
            workbench_submissions::submit_shared(
                host,
                &scope.canonical_id,
                "areal/turn/start",
                serde_json::to_value(typed)?,
                true,
            )
            .await
        }
        "start" => {
            let source_thread_id = identifier(obj.get("sourceThreadId"))?;
            let text = obj
                .get("text")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty() && s.len() <= 64 * 1024)
                .context("INVALID_PARAMS")?;
            let req_id = optional_uuid_or_new(obj.get("requestId"))?;
            let workspace_access = match obj.get("workspaceAccess").and_then(Value::as_str) {
                Some("readOnly") => "readOnly",
                None | Some("none") => "none",
                Some(_) => bail!("INVALID_PARAMS"),
            };
            ensure_subscription_if_needed(host, source, &scope.canonical_id, obj.get("model"))
                .await?;
            let mut input = areal_protocol::Input::text(text);
            if let Some(parts) = obj.get("contextParts") {
                let parts: Vec<areal_protocol::ContextPart> =
                    serde_json::from_value(parts.clone()).context("INVALID_PARAMS")?;
                input = input.with_context_parts(parts);
            }
            let mut payload = json!({
                "requestId": req_id,
                "sourceThreadId": source_thread_id,
                "workspaceAccess": workspace_access,
                "input": [input],
                "anchor": obj.get("anchor").cloned().unwrap_or(Value::Null),
                "selection": obj.get("selection").cloned().unwrap_or(Value::Null),
                "model": obj.get("model").cloned().unwrap_or(Value::Null),
                "parameters": obj.get("parameters").cloned().unwrap_or(Value::Null),
            });
            if obj.get("resetModel") == Some(&json!(true)) {
                payload["resetModel"] = json!(true);
            }
            let typed: areal_protocol::desktop::SideStart =
                serde_json::from_value(payload).context("INVALID_PARAMS")?;
            let result = workbench_submissions::submit_shared(
                host,
                &scope.canonical_id,
                "areal/side/start",
                serde_json::to_value(typed)?,
                true,
            )
            .await?;
            let thread_id = result["thread"]["id"]
                .as_str()
                .context("INVALID_RESPONSE")?;
            record_thread_owner(&scope.home, &scope.alias, thread_id);
            let mut out = json!({
                "threadId": thread_id,
                "requestId": result["requestId"].as_str().unwrap_or(&req_id),
            });
            if let Some(turn_id) = result["turn"]["id"].as_str() {
                out["turnId"] = json!(turn_id);
            }
            Ok(out)
        }
        _ => bail!("INVALID_PARAMS"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::workbench_route::{desktop_command, desktop_command_capability};
    use futures_util::{SinkExt, StreamExt};
    use std::cell::RefCell;
    use tokio_tungstenite::tungstenite::Message;

    fn test_host(root: &Path) -> (Rc<Host>, String, String, std::path::PathBuf) {
        let mut host = crate::server::schedules::tests::fixture(root);
        host.bin = root.join("target/debug");
        areal_local_service::storage::private_dir(&host.bin).unwrap();
        areal_local_service::storage::private_dir(&root.join("profile")).unwrap();
        areal_local_service::storage::private_dir(&root.join("data")).unwrap();
        let source = crate::migration::Source {
            profile: root.join("profile"),
            core_home: root.join("data"),
            // 过渡：到 0.2.0 删；导入夹具沿用迁移来源字段。
            legacy_service_home: root.join("legacy"),
        };
        host.migration
            .attach(source.clone(), "fixture", None)
            .unwrap();
        let imported = host
            .migration
            .import(
                serde_json::from_value(json!({
                    "requestId": uuid::Uuid::new_v4().to_string(),
                    "expectedGeneration": host.identity.generation,
                    "source": source,
                }))
                .unwrap(),
                "fixture",
                &[],
                &host.journal,
            )
            .unwrap();
        assert_eq!(imported["kind"], "ready");
        let source_id = host
            .migration
            .navigation_source_id(&source.profile)
            .unwrap()
            .unwrap();
        let alias = "fedcba9876543210fedcba98".to_owned();
        let workspace = root.join("project");
        areal_local_service::storage::private_dir(&workspace).unwrap();
        {
            let mut slots = host.slots.borrow_mut();
            let slot = slots.get_mut("project").unwrap();
            slot.registration.workspace = workspace.clone();
            slot.registration.source = crate::ProjectSource::Gui {
                profile: source.profile.clone(),
                // 过渡：到 0.2.0 删；导入夹具沿用迁移来源字段。
                legacy_project_id: alias.clone(),
            };
        }
        areal_local_service::storage::write(
            &source.core_home.join("projects.json"),
            &json!([{ "id": alias, "root": workspace }]),
        )
        .unwrap();
        let host = Rc::new(host);
        host.gateway.workbench.test_source(&source_id);
        (host, source_id, alias, workspace)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn migrated_session_queue_and_side_commands_run_without_node_backend() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let base = root.path().canonicalize().unwrap();
                let (host, _source, alias, workspace) = test_host(&base);
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let registration = host.slots.borrow()["project"].registration.clone();
                let service = areal_protocol::service::Service {
                    identity: areal_protocol::service::Identity {
                        protocol_version: 1,
                        service_id: "fixture".into(),
                        generation: "gen-1".into(),
                        workspace: registration.workspace,
                        data_dir: registration.data_dir,
                        config_fingerprint: "fixture".into(),
                    },
                    owner: Some(host.owner()),
                    endpoint: format!("ws://{}/", listener.local_addr().unwrap()),
                    web_url: String::new(),
                    auth_file: host.home.join("core-auth.json"),
                    log_file: host.home.join("core.log"),
                    host_pid: 1,
                    core_pid: 2,
                    state: areal_protocol::service::State::Ready,
                };
                areal_local_service::storage::write(
                    &service.auth_file,
                    &json!({"principals":[{"id":"desktop-owner","token":"fixture"}]}),
                )
                .unwrap();
                {
                    let mut slots = host.slots.borrow_mut();
                    let slot = slots.get_mut("project").unwrap();
                    slot.service = Some(service.clone());
                    slot.state = "ready".into();
                    let (writer, lifetime) = areal_local_service::OwnerLifetime::pair().unwrap();
                    slot.writer = Some(writer);
                    slot.lifetime = Some(Rc::new(lifetime));
                }
                let recorded_methods = Rc::new(RefCell::new(Vec::<String>::new()));
                let methods_ref = recorded_methods.clone();
                let plugin_command = json!({"pluginId":"fixture@local","componentId":"commands/review.md","installedDigest":"fixture-digest","arguments":"path with spaces.ts --strict"});
                let expected_plugin_command = plugin_command.clone();
                let ws = workspace.clone();
                let server = tokio::task::spawn_local(async move {
                    let (stream, _) = listener.accept().await.unwrap();
                    let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                    while let Some(Ok(Message::Text(text))) = socket.next().await {
                        let call: Value = serde_json::from_str(&text).unwrap();
                        if call.get("id").is_none() {
                            continue;
                        }
                        let method = call["method"].as_str().unwrap().to_owned();
                        let params = &call["params"];
                        methods_ref.borrow_mut().push(method.clone());
                        let result = match method.as_str() {
                            "initialize" => json!({}),
                            "areal/capabilities" => json!({
                                "apiVersion": "areal.core.v1",
                                "methods": [
                                    "areal/thread/fork",
                                    "areal/turn/submit",
                                    "areal/turn/start",
                                    "areal/thread/configure",
                                    "areal/thread/prediction",
                                    "areal/thread/inspect",
                                    "areal/queue/list",
                                    "areal/queue/update",
                                    "areal/queue/pause",
                                    "areal/side/start",
                                    "areal/side/create",
                                    "areal/side/close",
                                    "areal/side/context/read",
                                    "areal/conversation/list",
                                    "areal/request/read",
                                    "thread/read"
                                ],
                                "features": {
                                    "editLastMessage": true,
                                    "ordinaryTurnSubmit": true,
                                    "permissionPresets": true,
                                    "sideExecutableV2": true,
                                    "threadCreationJournal": {
                                        "binding": { "identity": "store-1", "journalEpoch": "epoch-1" }
                                    }
                                },
                                "methodSemantics": {
                                    "areal/thread/fork": { "effect": "mutation", "receipt": "thread" },
                                    "areal/turn/submit": { "effect": "mutation", "receipt": "thread" },
                                    "areal/turn/start": { "effect": "mutation", "receipt": "thread" },
                                    "areal/thread/configure": { "effect": "mutation", "receipt": "thread" },
                                    "areal/queue/pause": { "effect": "mutation", "receipt": "thread" },
                                    "areal/queue/update": { "effect": "mutation", "receipt": "thread" },
                                    "areal/side/start": { "effect": "mutation", "receipt": "thread" },
                                    "areal/side/create": { "effect": "mutation", "receipt": "thread" },
                                    "areal/side/close": { "effect": "mutation", "receipt": "thread" }
                                }
                            }),
                            "areal/task/list" => json!({ "data": [], "nextCursor": null }),
                            "thread/read" => {
                                let tid = params["threadId"].as_str().unwrap();
                                let kind = if tid.starts_with("side") { "side" } else { "ordinary" };
                                let cfg = if tid == "draft-thread" {
                                    json!({
                                        "revision": 3,
                                        "options": { "appendInstructions": "AREAL_TASK_DRAFT_V1\nTask draft" }
                                    })
                                } else {
                                    json!({ "revision": 3, "options": { "permissionPreset": "ask" } })
                                };
                                json!({
                                    "thread": {
                                        "id": tid,
                                        "sessionId": "session-1",
                                        "cwd": ws,
                                        "conversation": {
                                            "kind": kind,
                                            "policy": {
                                                "kind": if kind == "side" { "sideReadOnlyV1" } else { "ordinaryV1" }
                                            }
                                        },
                                        "turns": [],
                                        "desktop": { "configuration": cfg }
                                    }
                                })
                            }
                            "areal/thread/inspect" => {
                                let tid = params["threadId"].as_str().unwrap();
                                let cfg = if tid == "draft-thread" {
                                    json!({
                                        "revision": 3,
                                        "options": { "appendInstructions": "AREAL_TASK_DRAFT_V1\nTask draft" }
                                    })
                                } else {
                                    json!({ "revision": 3, "options": { "permissionPreset": "ask" } })
                                };
                                json!({ "configuration": cfg, "activeTurnId": Value::Null })
                            }
                            "areal/thread/fork" => json!({
                                "thread": { "id": "forked-thread-1" },
                                "requestId": params["requestId"]
                            }),
                            "areal/turn/submit" => {
                                if params["intent"]["type"] == "edit" {
                                    assert_eq!(params["intent"]["command"], expected_plugin_command);
                                    assert_eq!(params["intent"]["input"], json!([]));
                                }
                                json!({
                                    "threadId": params["threadId"],
                                    "requestId": params["requestId"],
                                    "turn": { "id": "turn-submitted-1", "status": "inProgress", "items": [] }
                                })
                            }
                            "areal/turn/start" => json!({
                                "threadId": params["threadId"],
                                "requestId": params["requestId"],
                                "turn": { "id": "turn-side-1", "status": "inProgress", "items": [] }
                            }),
                            "areal/thread/configure" => json!({
                                "revision": 4,
                                "options": params.get("options").cloned().unwrap_or(json!({}))
                            }),
                            "areal/thread/prediction" => json!({
                                "status": "ready",
                                "sourceTurnId": params["sourceTurnId"],
                                "configurationRevision": 3,
                                "text": "next step"
                            }),
                            "areal/queue/list" => json!({
                                "revision": 2,
                                "paused": false,
                                "pauseReason": Value::Null,
                                "items": []
                            }),
                            "areal/queue/pause" => json!({
                                "revision": 3,
                                "paused": true,
                                "pauseReason": "pausedByUser",
                                "items": []
                            }),
                            "areal/request/read" => json!({
                                "data": [{
                                    "identity": "desktop-owner",
                                    "requestId": params["requestId"],
                                    "method": "areal/queue/pause",
                                    "threadId": params["threadId"],
                                    "status": "completed",
                                    "result": { "revision": 3, "paused": true, "pauseReason": "pausedByUser", "items": [] }
                                }]
                            }),
                            "areal/conversation/list" => json!({
                                "data": [
                                    { "id": "side-1", "conversation": { "kind": "side", "policy": { "kind": "sideReadOnlyV1" } } },
                                    { "id": "ordinary-other", "conversation": { "kind": "ordinary" } }
                                ],
                                "nextCursor": Value::Null
                            }),
                            "areal/side/context/read" => json!({
                                "snapshotId": "snap-1",
                                "evidence": [],
                                "nextCursor": Value::Null,
                                "complete": true
                            }),
                            "areal/side/start" => json!({
                                "requestId": params["requestId"],
                                "thread": { "id": "side-1" },
                                "turn": { "id": "turn-s1", "status": "inProgress", "items": [] }
                            }),
                            other => panic!("unexpected mock Core method: {other}"),
                        };
                        socket
                            .send(Message::Text(json!({"id": call["id"], "result": result}).to_string().into()))
                            .await
                            .unwrap();
                    }
                });
                let close_core = host
                    .schedules
                    .connections
                    .connect_test_core(host.clone(), "project", service)
                    .await
                    .unwrap();

                let call = |cmd: &'static str, req: Value| {
                    let host = host.clone();
                    async move {
                        desktop_command(
                            &host,
                            "local",
                            "conn-1",
                            &json!({
                                "method": "desktop.command",
                                "params": { "command": cmd, "request": req }
                            }),
                        )
                        .await
                    }
                };

                // 1. fork
                let fork_req = uuid::Uuid::new_v4().to_string();
                let forked = call(
                    "fork",
                    json!({
                        "projectId": alias,
                        "sourceThreadId": "t-1",
                        "requestId": fork_req,
                        "workspaceMode": "sharedCurrent",
                        "anchor": { "turnId": "turn-1", "boundary": "after" }
                    }),
                )
                .await
                .unwrap();
                assert_eq!(forked, json!({ "threadId": "forked-thread-1", "requestId": fork_req }));

                // 2. editMessage
                let edit_req = uuid::Uuid::new_v4().to_string();
                let edited = call(
                    "editMessage",
                    json!({
                        "projectId": alias,
                        "threadId": "t-1",
                        "expectedTurnId": "turn-1",
                        "itemId": "item-1",
                        "expectedConfigRevision": 3,
                        "requestId": edit_req,
                        "text": "",
                        "command": plugin_command
                    }),
                )
                .await
                .unwrap();
                assert_eq!(edited["turn"]["id"], "turn-submitted-1");
                assert_eq!(edited["requestId"], edit_req);

                // 3. continue
                let continued = call(
                    "continue",
                    json!({
                        "projectId": alias,
                        "threadId": "t-1",
                        "expectedTurnId": "turn-1"
                    }),
                )
                .await
                .unwrap();
                assert_eq!(continued["turn"]["id"], "turn-submitted-1");

                // 4. prediction
                let pred = call(
                    "prediction",
                    json!({
                        "projectId": alias,
                        "threadId": "t-1",
                        "sourceTurnId": "turn-1",
                        "operation": "request"
                    }),
                )
                .await
                .unwrap();
                assert_eq!(pred["text"], "next step");

                // 5. configure (plus task-draft options guard)
                let draft_err = call(
                    "configure",
                    json!({
                        "projectId": alias,
                        "threadId": "draft-thread",
                        "options": { "readOnly": false }
                    }),
                )
                .await
                .unwrap_err();
                assert_eq!(
                    draft_err.downcast_ref::<crate::wire::Error>().map(|e| e.code),
                    Some("COMMAND_FAILED")
                );
                let configured = call(
                    "configure",
                    json!({
                        "projectId": alias,
                        "threadId": "t-1",
                        "expectedRevision": 3,
                        "options": { "permissionPreset": "autoReview" }
                    }),
                )
                .await
                .unwrap();
                assert_eq!(configured["projects"], json!([]));
                assert!(configured["library"]["settings"].is_object());

                // 6. queue + queueEdit + queue receipt query + reconcile + dismissRecovery
                let q = call("queue", json!({ "projectId": alias, "threadId": "t-1" }))
                    .await
                    .unwrap();
                assert_eq!(q["revision"], 2);
                let q_req = uuid::Uuid::new_v4().to_string();
                let paused = call(
                    "queueEdit",
                    json!({
                        "projectId": alias,
                        "threadId": "t-1",
                        "operation": "pause",
                        "expectedRevision": 2,
                        "requestId": q_req
                    }),
                )
                .await
                .unwrap();
                assert_eq!(paused["paused"], true);
                let q_read = call(
                    "queue",
                    json!({
                        "projectId": alias,
                        "threadId": "t-1",
                        "operation": "pause",
                        "requestId": q_req
                    }),
                )
                .await
                .unwrap();
                assert_eq!(q_read["confirmed"], true);
                assert_eq!(q_read["accepted"], true);

                let reconciled = call("reconcile", json!({ "projectId": alias }))
                    .await
                    .unwrap();
                assert!(reconciled["outcomes"][&q_req].is_object());
                assert!(reconciled["outcomes"][&edit_req].is_object());

                let dismissed = call(
                    "dismissRecovery",
                    json!({ "projectId": alias, "requestId": q_req }),
                )
                .await
                .unwrap();
                assert_eq!(dismissed["projects"], json!([]));
                let (_, journal_after) = host.journal.native_snapshot("project").unwrap();
                assert!(journal_after["outcomes"].get(&q_req).is_none());

                // 7. side start / list / context / send
                let side_req = uuid::Uuid::new_v4().to_string();
                let started = call(
                    "side",
                    json!({
                        "projectId": alias,
                        "operation": "start",
                        "sourceThreadId": "t-1",
                        "text": "why?",
                        "requestId": side_req
                    }),
                )
                .await
                .unwrap();
                assert_eq!(started["threadId"], "side-1");
                let list = call(
                    "side",
                    json!({
                        "projectId": alias,
                        "operation": "list",
                        "sourceThreadId": "t-1"
                    }),
                )
                .await
                .unwrap();
                assert_eq!(list["data"].as_array().unwrap().len(), 1);
                let ctx = call(
                    "side",
                    json!({
                        "projectId": alias,
                        "operation": "context",
                        "threadId": "side-1"
                    }),
                )
                .await
                .unwrap();
                assert_eq!(ctx["snapshotId"], "snap-1");
                let sent = call(
                    "side",
                    json!({
                        "projectId": alias,
                        "operation": "send",
                        "threadId": "side-1",
                        "text": "follow up"
                    }),
                )
                .await
                .unwrap();
                assert_eq!(sent["turn"]["id"], "turn-side-1");

                // 8. desktop_command_capability submit gating
                assert_eq!(
                    desktop_command_capability(&json!({"command":"fork","request":{}})),
                    Some("submit")
                );
                assert_eq!(
                    desktop_command_capability(&json!({"command":"prediction","request":{"operation":"cancel"}})),
                    None
                );
                assert_eq!(
                    desktop_command_capability(&json!({"command":"queueEdit","request":{"operation":"remove"}})),
                    None
                );
                assert_eq!(
                    desktop_command_capability(&json!({"command":"side","request":{"operation":"close"}})),
                    None
                );

                assert!(recorded_methods.borrow().iter().any(|m| m == "areal/thread/fork"));

                close_core();
                server.abort();
            })
            .await;
    }
}
