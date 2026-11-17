//! 管理面（`manage.read`、`manage.command` 与 `desktop.command` `"manage"`）的 Host 原生实现。
//! 所有操作直接复用工作区归属、Core 共享通道、Host 提交日志、插件库与产物安全校验。

use super::{
    Host,
    gateway_owner::rich_message_input_with_command,
    library_store,
    session_commands::{
        ResolvedScope, core_capabilities, has_method, record_thread_owner, resolve_project_scope,
        shared_rpc,
    },
    workbench_submissions, workbench_utility, worktree_catalog,
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    ffi::{CStr, CString},
    fs::OpenOptions,
    io::{ErrorKind, Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Component, Path, PathBuf},
    rc::Rc,
    time::Duration,
};
use tokio::sync::{Mutex, Notify};

const ARTIFACT_LIMIT_BYTES: usize = 2 * 1024 * 1024;
const PROFILE_MAX_BYTES: usize = 2 * 1024 * 1024;

const FALLBACK_FONTS: &[&str] = &[
    "ui-monospace",
    "SFMono-Regular",
    "SF Mono",
    "Menlo",
    "Monaco",
    "Consolas",
    "Cascadia Mono",
    "JetBrains Mono",
    "MesloLGS NF",
    "Hack Nerd Font",
    "Noto Sans Mono CJK SC",
    "monospace",
];

const ANSI_KEYS: &[(&str, &str)] = &[
    ("black", "Ansi 0 Color"),
    ("red", "Ansi 1 Color"),
    ("green", "Ansi 2 Color"),
    ("yellow", "Ansi 3 Color"),
    ("blue", "Ansi 4 Color"),
    ("magenta", "Ansi 5 Color"),
    ("cyan", "Ansi 6 Color"),
    ("white", "Ansi 7 Color"),
    ("brightBlack", "Ansi 8 Color"),
    ("brightRed", "Ansi 9 Color"),
    ("brightGreen", "Ansi 10 Color"),
    ("brightYellow", "Ansi 11 Color"),
    ("brightBlue", "Ansi 12 Color"),
    ("brightMagenta", "Ansi 13 Color"),
    ("brightCyan", "Ansi 14 Color"),
    ("brightWhite", "Ansi 15 Color"),
];

const CLEANUP_OPS: &[&str] = &[
    "processTerminate",
    "executionCancel",
    "workgroupCancel",
    "taskCancel",
    "taskDelete",
    "taskPause",
    "taskStopRun",
    "goalPause",
    "goalClear",
    "closeResources",
    "toolAcknowledge",
    "hookAcknowledge",
    "serverDrain",
];

const TASK_READ_OPS: &[&str] = &[
    "taskSchedulePreview",
    "taskScheduleContext",
    "tasks",
    "task",
    "taskInbox",
    "taskChannel",
    "taskRuns",
    "taskRun",
    "taskDraftRead",
    "taskDraftHistory",
    "taskHistoryCapabilities",
    "taskWatch",
    "taskUnwatch",
];

const TASK_WRITE_OPS: &[&str] = &[
    "taskCreate",
    "taskUpdate",
    "taskRunNow",
    "taskPause",
    "taskResume",
    "taskStopRun",
    "taskResumeRun",
    "taskCancel",
    "taskDelete",
    "taskReply",
    "taskDraftStart",
    "taskDraftSend",
    "taskDraftConfirm",
];

#[derive(Default)]
pub(super) struct ManageService {
    applying_artifacts: RefCell<BTreeSet<(PathBuf, String)>>,
    artifact_notify: Notify,
    credential_gate: Mutex<()>,
}

/// 将 manage 服务层明确拒绝的 wire 错误转换为稳定的拒绝回执。
pub(super) fn rejection(error: &anyhow::Error) -> Option<Value> {
    let wire = error.downcast_ref::<crate::wire::Error>()?;
    matches!(
        wire.code,
        "COMMAND_FAILED"
            | "scheduleWorkspaceRequired"
            | "RESOURCE_UNAVAILABLE"
            | "INVALID_PARAMS"
            | "FORBIDDEN"
            | "TARGET_CHANGED"
            | "PROFILE_NOT_SUPPORTED"
    )
    .then(|| json!({ "code": wire.code, "message": wire.message }))
}

fn non_empty_text<'a>(value: Option<&'a Value>, code: &'static str, msg: &str) -> Result<&'a str> {
    let text = value
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && !s.contains('\0'));
    match text {
        Some(text) => Ok(text),
        None => Err(crate::wire::error(code, msg)),
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

fn pick_fields(value: &Value, keys: &[&str]) -> Value {
    let mut map = serde_json::Map::new();
    if let Some(obj) = value.as_object() {
        for key in keys {
            if let Some(field) = obj.get(*key) {
                map.insert((*key).to_owned(), field.clone());
            }
        }
    }
    Value::Object(map)
}

fn is_hex_sha256(value: Option<&str>) -> bool {
    value
        .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

fn format_workgroup_result(value: Value, from_manage_rpc: bool) -> Result<Value> {
    let obj = value.as_object().context("INVALID_RESPONSE")?;
    for key in ["id", "record", "historyCount", "verificationCount"] {
        ensure!(obj.contains_key(key), "INVALID_RESPONSE");
    }
    ensure!(
        obj["id"].is_string()
            && obj["record"].is_object()
            && obj["historyCount"].is_u64()
            && obj["verificationCount"].is_u64(),
        "INVALID_RESPONSE"
    );
    if from_manage_rpc {
        ensure!(
            obj.get("candidatePath").is_some_and(Value::is_string)
                && obj.get("recordPath").is_some_and(Value::is_string),
            "INVALID_RESPONSE"
        );
        return Ok(value);
    }
    Ok(json!({
        "id": obj["id"],
        "record": obj["record"],
        "historyCount": obj["historyCount"],
        "verificationCount": obj["verificationCount"],
    }))
}

fn direct_read_spec(operation: &str) -> Option<(&'static str, &'static [&'static str])> {
    Some(match operation {
        "pluginHooks" => ("areal/plugin/hooks/list", &[]),
        "pluginMcp" => ("areal/plugin/mcp/list", &[]),
        "pluginComponents" => ("areal/plugin/components", &["id"]),
        "providers" => ("areal/provider/list", &[]),
        "profile" => ("areal/profile/read", &["id", "revision"]),
        "skills" => ("areal/skill/list", &["threadId", "agentProfile"]),
        "skill" => (
            "areal/skill/read",
            &[
                "threadId",
                "agentProfile",
                "skill",
                "resource",
                "offset",
                "maxBytes",
            ],
        ),
        "inspect" => ("areal/thread/inspect", &["threadId"]),
        "context" => ("areal/context/read", &["threadId", "offset", "limit"]),
        "inheritedHistory" => (
            "areal/conversation/history",
            &["threadId", "view", "cursor", "maxBytes"],
        ),
        "plan" => ("areal/plan/read", &["threadId"]),
        "processes" => ("areal/process/list", &["threadId"]),
        "process" => ("areal/process/get", &["threadId", "id"]),
        "processWait" => ("areal/process/wait", &["threadId", "id", "timeoutMs"]),
        "goal" => ("areal/goal/get", &["threadId"]),
        "permissions" => ("areal/permissions/read", &["threadId"]),
        "interactions" => ("areal/interaction/list", &["threadId"]),
        "processOutput" => (
            "areal/process/read",
            &["threadId", "id", "after", "maxBytes", "waitMs"],
        ),
        "executionTraceResult" => (
            "areal/execution/traceResult",
            &["threadId", "executionId", "workerThreadId", "uri"],
        ),
        "executionTrace" => (
            "areal/execution/trace",
            &["threadId", "executionId", "workerThreadId", "cursor"],
        ),
        "executions" => (
            "areal/execution/list",
            &["parentThreadId", "offset", "limit"],
        ),
        "execution" => (
            "areal/execution/read",
            &["parentThreadId", "executionId", "offset"],
        ),
        "executionArtifact" => (
            "areal/execution/artifact",
            &["parentThreadId", "executionId", "path", "offset"],
        ),
        "executionWait" => (
            "areal/execution/wait",
            &["parentThreadId", "executionId", "timeoutMs"],
        ),
        "agents" => ("areal/agent/list", &["parentThreadId", "cursor", "limit"]),
        "agentWait" => (
            "areal/agent/wait",
            &["parentThreadId", "threadIds", "timeoutMs"],
        ),
        "workflows" => ("areal/workflow/list", &[]),
        "server" => ("areal/server/status", &[]),
        "workflow" => ("areal/workflow/read", &["id", "revision"]),
        "workgroupPolicy" => ("areal/workgroup/policy", &[]),
        "workgroups" => ("areal/workgroup/list", &[]),
        "workgroup" => ("areal/workgroup/read", &["id"]),
        "workgroupWait" => (
            "areal/workgroup/wait",
            &["id", "afterRevision", "timeoutMs"],
        ),
        "workgroupArtifact" => ("areal/workgroup/artifact", &["id", "path", "offset"]),
        _ => return None,
    })
}

fn journaled_mutation_spec(operation: &str) -> Option<(&'static str, &'static [&'static str])> {
    Some(match operation {
        "pluginArchiveImport" => ("areal/plugin/importArchive", &["path", "expectedRevision"]),
        "pluginHooksConfigure" => (
            "areal/plugin/hooks/configure",
            &[
                "id",
                "expectedDigest",
                "definitionDigest",
                "enabled",
                "trusted",
                "allowReadOnlyCommands",
            ],
        ),
        "hookAcknowledge" => (
            "areal/hook/acknowledge",
            &["threadId", "invocationId", "inspection"],
        ),
        "pluginAuthConfigure" => (
            "areal/plugin/auth/configure",
            &["id", "server", "expectedDigest", "configuration"],
        ),
        "pluginConnection" => (
            "areal/plugin/connection",
            &["id", "expectedDigest", "connect"],
        ),
        "pluginComponentConfigure" => (
            "areal/plugin/component/configure",
            &[
                "id",
                "component",
                "enabled",
                "expectedRevision",
                "expectedDigest",
            ],
        ),
        "pluginSetup" => ("areal/plugin/setup", &["id", "threadId"]),
        "pluginUserConfigSave" => (
            "areal/plugin/userConfig/set",
            &[
                "id",
                "expectedRevision",
                "expectedDigest",
                "values",
                "clearKeys",
            ],
        ),
        "pluginDevelopmentLink" => (
            "areal/plugin/development/link",
            &["id", "expectedRevision", "expectedDigest"],
        ),
        "pluginDevelopmentUnlink" => (
            "areal/plugin/development/unlink",
            &["id", "expectedRevision"],
        ),
        "providerSave" => ("areal/provider/upsert", &["provider", "expectedRevision"]),
        "providerRemove" => ("areal/provider/remove", &["id", "expectedRevision"]),
        "archive" => ("areal/thread/archive", &["threadId"]),
        "unarchive" => ("areal/conversation/unarchive", &["threadId"]),
        "processStart" => (
            "areal/process/start",
            &[
                "threadId",
                "lifetime",
                "argv",
                "cwd",
                "tty",
                "cols",
                "rows",
                "timeoutMs",
            ],
        ),
        "processCloseStdin" => ("areal/process/closeStdin", &["threadId", "id"]),
        "processWrite" => ("areal/process/write", &["threadId", "id", "dataBase64"]),
        "processResize" => ("areal/process/resize", &["threadId", "id", "cols", "rows"]),
        "processTerminate" => ("areal/process/terminate", &["threadId", "id"]),
        "goalCreate" => (
            "areal/goal/create",
            &[
                "threadId",
                "expectedRevision",
                "objective",
                "tokenBudget",
                "maxTurns",
                "maxActiveSeconds",
                "inferLimits",
            ],
        ),
        "goalUpdate" => (
            "areal/goal/update",
            &[
                "threadId",
                "expectedRevision",
                "goalId",
                "objective",
                "tokenBudget",
                "maxTurns",
                "maxActiveSeconds",
                "inferLimits",
            ],
        ),
        "goalPause" => (
            "areal/goal/pause",
            &["threadId", "expectedRevision", "goalId"],
        ),
        "goalResume" => (
            "areal/goal/resume",
            &["threadId", "expectedRevision", "goalId"],
        ),
        "goalClear" => (
            "areal/goal/clear",
            &["threadId", "expectedRevision", "goalId"],
        ),
        _ => return None,
    })
}

fn is_plugin_store_op(operation: &str) -> bool {
    super::plugins::is_read(operation) || super::plugins::is_write(operation)
}

fn is_read_operation(operation: &str) -> bool {
    is_plugin_store_op(operation) && super::plugins::is_read(operation)
        || direct_read_spec(operation).is_some()
        || matches!(
            operation,
            "pluginStoreSnapshot"
                | "pluginStoreDoctor"
                | "pluginReadiness"
                | "pluginCapabilities"
                | "workgroupCapabilities"
                | "workgroupArtifactStatus"
                | "pluginSubmission"
                | "workgroupSubmission"
                | "processSubmission"
                | "agentSubmission"
        )
        || TASK_READ_OPS.contains(&operation)
}

fn validate_plugin_store_op(
    host: &Host,
    source: &str,
    operation: &str,
    request: &Value,
) -> Result<(bool, Value)> {
    let reading = super::plugins::is_read(operation);
    let obj = request.as_object().context("INVALID_PARAMS")?;
    let scope = obj.get("scope").and_then(Value::as_str);
    if let Some(raw_scope) = obj.get("scope") {
        ensure!(
            matches!(raw_scope.as_str(), Some("user" | "project")),
            "INVALID_PARAMS"
        );
    }
    if operation == "pluginInstall" {
        let digest = obj
            .get("expectedDigest")
            .and_then(Value::as_str)
            .context("INVALID_PARAMS")?;
        ensure!(is_hex_sha256(Some(digest)), "INVALID_PARAMS");
    }
    let keep_project = obj.get("projectId").is_some()
        && (matches!(operation, "plugins" | "plugin" | "mcp" | "pluginInstall")
            || (operation == "pluginConfigure" && scope == Some("project")));

    let mut normalized = obj.clone();
    for stripped in ["sourceId", "requestId", "logicalProjectId", "scope"] {
        normalized.remove(stripped);
    }
    if keep_project {
        let alias = normalized["projectId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .context("INVALID_PARAMS")?;
        if source != "host" {
            let registration = worktree_catalog::project(host, source, alias)?;
            normalized.insert("projectId".into(), json!(registration.project_id));
        }
    } else {
        normalized.remove("projectId");
    }
    Ok((reading, Value::Object(normalized)))
}

async fn execute_plugin_store_snapshot_or_doctor(
    host: &Host,
    source: &str,
    operation: &str,
    request: &Value,
) -> Result<Value> {
    let obj = request.as_object().context("INVALID_PARAMS")?;
    let allowed: &[&str] = if operation == "pluginStoreSnapshot" {
        &["operation", "projectId", "id"]
    } else {
        &["operation", "projectId"]
    };
    ensure!(
        obj.keys().all(|k| allowed.contains(&k.as_str())),
        "INVALID_PARAMS"
    );
    let mut utility = json!({
        "operation": if operation == "pluginStoreDoctor" { "pluginDoctor" } else { "pluginSnapshot" }
    });
    if let Some(project_id) = obj.get("projectId") {
        let s = project_id.as_str().context("INVALID_PARAMS")?;
        ensure!(
            !s.trim().is_empty() && s.chars().count() <= 256,
            "INVALID_PARAMS"
        );
        utility["projectId"] = json!(s);
    }
    if operation == "pluginStoreSnapshot"
        && let Some(id) = obj.get("id")
    {
        let s = id.as_str().context("INVALID_PARAMS")?;
        ensure!(!s.is_empty() && s.chars().count() <= 256, "INVALID_PARAMS");
        utility["pluginId"] = json!(s);
    }
    workbench_utility::execute(host, source, utility).await
}

fn validate_secret_value(raw: &str, private_key: bool) -> Result<String> {
    let max_len = if private_key { 32768 } else { 16384 };
    ensure!(
        raw.len() <= max_len
            && !raw.contains('\0')
            && (private_key || raw.bytes().all(|b| (0x20..=0x7e).contains(&b))),
        crate::wire::error("COMMAND_FAILED", "凭据格式无效")
    );
    Ok(raw.trim().to_owned())
}

async fn save_plugin_credential(
    host: &Host,
    source: &str,
    raw_secret: &str,
    private_key: bool,
) -> Result<(String, String)> {
    let trimmed = validate_secret_value(raw_secret, private_key)?;
    if trimmed.is_empty() {
        return Err(crate::wire::error("COMMAND_FAILED", "凭据不能为空"));
    }
    let op_id = uuid::Uuid::new_v4().to_string();
    let short_ref = op_id.replace('-', "");
    let full_ref = format!("AREAL_CREDENTIAL_{short_ref}");
    let receipt = host
        .migration
        .vault
        .dispatch_async(
            "vault.replace",
            json!({
                "requestId": op_id,
                "expectedGeneration": host.identity.generation,
                "expectedRevision": 0,
                "slot": {
                    "kind": "providerCredential",
                    "sourceId": source,
                    "reference": full_ref,
                },
                "value": trimmed,
            }),
            &host.identity.generation,
            &host.migration,
        )
        .await?;
    ensure!(
        receipt["state"] == "completed",
        crate::wire::error("COMMAND_FAILED", "插件凭据未保存")
    );
    Ok((short_ref, trimmed))
}

async fn register_plugin_credentials(
    host: &Host,
    source: &str,
    primary_project_id: &str,
    credentials: &BTreeMap<String, String>,
) -> Result<bool> {
    let payload = json!({ "credentials": credentials });
    shared_rpc(
        host,
        primary_project_id,
        "areal/plugin/credentials/register",
        payload.clone(),
    )
    .await?;

    let other_ids: Vec<String> = {
        let slots = host.slots.borrow();
        let registrations: Vec<_> = slots
            .values()
            .map(|slot| slot.registration.clone())
            .collect();
        let source_profile = if source != "host" {
            host.migration.source_profile(source).ok()
        } else {
            None
        };
        registrations
            .into_iter()
            .filter(|reg| {
                if reg.project_id == primary_project_id {
                    return false;
                }
                if host
                    .schedules
                    .connections
                    .shared_identity(host, &reg.project_id)
                    .is_err()
                {
                    return false;
                }
                if source == "host" {
                    return true;
                }
                match &reg.source {
                    crate::ProjectSource::Gui { profile, .. } => {
                        source_profile.as_ref() == Some(profile)
                    }
                    _ => {
                        host.project_uses_shared_config(reg)
                            && host
                                .migration
                                .shared_credential_source(reg, true)
                                .ok()
                                .flatten()
                                .as_deref()
                                == Some(source)
                    }
                }
            })
            .map(|reg| reg.project_id)
            .collect()
    };

    let mut deferred = false;
    for other_id in other_ids {
        if shared_rpc(
            host,
            &other_id,
            "areal/plugin/credentials/register",
            payload.clone(),
        )
        .await
        .is_err()
        {
            deferred = true;
        }
    }
    Ok(deferred)
}

fn validate_artifact_rel_path(relative: &str) -> Result<Vec<String>> {
    ensure!(
        !relative.is_empty() && !relative.contains('\\') && !relative.contains('\0'),
        crate::wire::error("COMMAND_FAILED", "无效产物路径")
    );
    let path = Path::new(relative);
    ensure!(
        !path.is_absolute(),
        crate::wire::error("COMMAND_FAILED", "无效产物路径")
    );
    let parts: Vec<String> = relative.split('/').map(str::to_owned).collect();
    for part in &parts {
        ensure!(
            !part.is_empty() && part != "." && part != ".." && part != ".git",
            crate::wire::error("COMMAND_FAILED", "无效产物路径")
        );
    }
    let mut comps = path.components();
    ensure!(
        comps.all(|c| matches!(c, Component::Normal(_))),
        crate::wire::error("COMMAND_FAILED", "无效产物路径")
    );
    Ok(parts)
}

enum ArtifactDest {
    MissingParent,
    Target { file: PathBuf, mode: Option<u32> },
}

fn artifact_destination(root: &Path, relative: &str, create_parents: bool) -> Result<ArtifactDest> {
    let parts = validate_artifact_rel_path(relative)?;
    let real_root = root
        .canonicalize()
        .map_err(|_| crate::wire::error("COMMAND_FAILED", "工作区根目录不可用"))?;
    let mut parent = real_root.clone();
    for part in parts[..parts.len().saturating_sub(1)].iter() {
        parent = parent.join(part);
        match std::fs::symlink_metadata(&parent) {
            Ok(meta) => {
                ensure!(
                    !meta.file_type().is_symlink(),
                    crate::wire::error("COMMAND_FAILED", "产物路径包含符号链接，未应用。")
                );
                ensure!(
                    meta.is_dir(),
                    crate::wire::error("COMMAND_FAILED", "产物父路径不是目录，未应用。")
                );
            }
            Err(err) if err.kind() == ErrorKind::NotFound => {
                if !create_parents {
                    return Ok(ArtifactDest::MissingParent);
                }
                std::fs::create_dir(&parent)?;
                let meta = std::fs::symlink_metadata(&parent)?;
                ensure!(
                    !meta.file_type().is_symlink() && meta.is_dir(),
                    crate::wire::error("COMMAND_FAILED", "产物父路径无效，未应用。")
                );
            }
            Err(err) => return Err(err.into()),
        }
    }
    let file = parent.join(&parts[parts.len() - 1]);
    let mode = match std::fs::symlink_metadata(&file) {
        Ok(meta) => {
            ensure!(
                !meta.file_type().is_symlink(),
                crate::wire::error("COMMAND_FAILED", "产物文件是符号链接，未应用。")
            );
            ensure!(
                meta.is_file() && meta.len() as usize <= ARTIFACT_LIMIT_BYTES,
                crate::wire::error("COMMAND_FAILED", "产物目标不是2 MB以内的普通文件，未应用。")
            );
            Some(meta.permissions().mode())
        }
        Err(err) if err.kind() == ErrorKind::NotFound => None,
        Err(err) => return Err(err.into()),
    };
    Ok(ArtifactDest::Target { file, mode })
}

struct VerifiedArtifactMeta {
    path: String,
    head: String,
    exists: bool,
    bytes: usize,
    base_sha256: Option<String>,
    sha256: Option<String>,
    executable: Option<bool>,
}

fn parse_artifact_page_meta(
    page: &Value,
    expected_head: &str,
    expected_path: &str,
) -> Result<VerifiedArtifactMeta> {
    let head = page["head"].as_str().context("INVALID_RESPONSE")?;
    let path = page["path"].as_str().context("INVALID_RESPONSE")?;
    if head != expected_head || path != expected_path {
        return Err(crate::wire::error(
            "COMMAND_FAILED",
            "产物版本已变化，请重新审查。",
        ));
    }
    let bytes_u64 = page["bytes"]
        .as_u64()
        .filter(|&n| n as usize <= ARTIFACT_LIMIT_BYTES)
        .ok_or_else(|| crate::wire::error("COMMAND_FAILED", "产物元数据无效"))?;
    let exists = page["exists"]
        .as_bool()
        .ok_or_else(|| crate::wire::error("COMMAND_FAILED", "产物元数据无效"))?;
    let base_sha256 = match page.get("baseSha256") {
        Some(Value::Null) => None,
        Some(Value::String(s)) if is_hex_sha256(Some(s)) => Some(s.clone()),
        _ => return Err(crate::wire::error("COMMAND_FAILED", "产物元数据无效")),
    };
    let (sha256, executable) = if exists {
        let sha = page["sha256"]
            .as_str()
            .filter(|s| is_hex_sha256(Some(s)))
            .ok_or_else(|| crate::wire::error("COMMAND_FAILED", "产物元数据无效"))?
            .to_owned();
        let exec = page["executable"]
            .as_bool()
            .ok_or_else(|| crate::wire::error("COMMAND_FAILED", "产物元数据无效"))?;
        (Some(sha), Some(exec))
    } else {
        if !page["sha256"].is_null() || bytes_u64 != 0 {
            return Err(crate::wire::error("COMMAND_FAILED", "产物元数据无效"));
        }
        (None, page["executable"].as_bool())
    };
    Ok(VerifiedArtifactMeta {
        path: path.to_owned(),
        head: head.to_owned(),
        exists,
        bytes: bytes_u64 as usize,
        base_sha256,
        sha256,
        executable,
    })
}

fn artifact_file_state(root: &Path, meta: &VerifiedArtifactMeta) -> Result<Value> {
    let mut sha256: Option<String> = None;
    let mut executable: Option<bool> = None;
    if let ArtifactDest::Target {
        file,
        mode: Some(_),
    } = artifact_destination(root, &meta.path, false)?
    {
        let mut opts = OpenOptions::new();
        opts.read(true).custom_flags(libc::O_NOFOLLOW);
        let mut handle = opts.open(&file)?;
        let stat = handle.metadata()?;
        ensure!(
            stat.is_file() && stat.len() as usize <= ARTIFACT_LIMIT_BYTES,
            crate::wire::error("COMMAND_FAILED", "产物目标在读取期间变化，未应用。")
        );
        let mut buf = Vec::new();
        (&mut handle)
            .take((ARTIFACT_LIMIT_BYTES + 1) as u64)
            .read_to_end(&mut buf)?;
        ensure!(
            buf.len() <= ARTIFACT_LIMIT_BYTES,
            crate::wire::error("COMMAND_FAILED", "产物目标在读取期间变化，未应用。")
        );
        sha256 = Some(sha256_hex(&buf));
        executable = Some((stat.permissions().mode() & 0o111) != 0);
    }
    let state = if sha256 == meta.sha256 && (!meta.exists || executable == meta.executable) {
        "matches"
    } else if sha256 == meta.base_sha256 {
        "ready"
    } else {
        "conflict"
    };
    Ok(json!({
        "path": meta.path,
        "head": meta.head,
        "state": state,
    }))
}

fn apply_verified_artifact(
    root: &Path,
    meta: &VerifiedArtifactMeta,
    bytes: &[u8],
) -> Result<Value> {
    if bytes.len() > ARTIFACT_LIMIT_BYTES
        || if meta.exists {
            Some(sha256_hex(bytes)) != meta.sha256
        } else {
            !bytes.is_empty() || meta.sha256.is_some()
        }
    {
        return Err(crate::wire::error(
            "COMMAND_FAILED",
            "产物完整性校验失败，未应用。",
        ));
    }
    let previous = artifact_file_state(root, meta)?;
    if previous["state"] == "matches" {
        return Ok(previous);
    }
    if previous["state"] != "ready" {
        return Err(crate::wire::error(
            "COMMAND_FAILED",
            "文件已变化，与工作组基线不一致；未覆盖，请先处理冲突。",
        ));
    }
    let (target_file, existing_mode) = match artifact_destination(root, &meta.path, meta.exists)? {
        ArtifactDest::Target { file, mode } => (file, mode),
        ArtifactDest::MissingParent => {
            return Err(crate::wire::error(
                "COMMAND_FAILED",
                "产物父目录不存在，未应用。",
            ));
        }
    };
    let parent_dir = target_file
        .parent()
        .ok_or_else(|| crate::wire::error("COMMAND_FAILED", "产物父目录无效"))?;
    let temporary = parent_dir.join(format!(".areal-artifact-{}", uuid::Uuid::new_v4()));
    struct TempGuard<'a>(&'a Path);
    impl Drop for TempGuard<'_> {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(self.0);
        }
    }
    let _cleanup = TempGuard(&temporary);
    if meta.exists {
        let mode = ((existing_mode.unwrap_or(0o644)) & 0o666)
            | if meta.executable.unwrap_or(false) {
                0o111
            } else {
                0
            };
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(&temporary)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(mode))?;
    }
    let current = artifact_file_state(root, meta)?;
    let same_dest = matches!(
        artifact_destination(root, &meta.path, false)?,
        ArtifactDest::Target { file, .. } if file == target_file
    );
    if current["state"] != "ready" || !same_dest {
        return Err(crate::wire::error(
            "COMMAND_FAILED",
            "文件已变化，未覆盖；请先处理冲突。",
        ));
    }
    if !meta.exists {
        std::fs::remove_file(&target_file)?;
    } else if meta.base_sha256.is_none() {
        std::fs::hard_link(&temporary, &target_file)?;
    } else {
        std::fs::rename(&temporary, &target_file)?;
    }
    artifact_file_state(root, meta)
}

fn current_posix_user() -> Result<(String, Option<String>, Option<PathBuf>)> {
    unsafe {
        let uid = libc::geteuid();
        let mut pwd: libc::passwd = std::mem::zeroed();
        let mut result: *mut libc::passwd = std::ptr::null_mut();
        let mut size = 1024usize;
        let mut buf = vec![0u8; size];
        loop {
            let rc = libc::getpwuid_r(
                uid,
                &mut pwd,
                buf.as_mut_ptr().cast::<libc::c_char>(),
                buf.len(),
                &mut result,
            );
            if rc == 0 {
                if result.is_null() {
                    return Err(crate::wire::error("COMMAND_FAILED", "无法读取终端所属账户"));
                }
                let username = if pwd.pw_name.is_null() {
                    return Err(crate::wire::error("COMMAND_FAILED", "无法读取终端所属账户"));
                } else {
                    CStr::from_ptr(pwd.pw_name).to_string_lossy().into_owned()
                };
                if username.is_empty() || username.contains('\0') {
                    return Err(crate::wire::error("COMMAND_FAILED", "无法读取终端所属账户"));
                }
                let shell = if pwd.pw_shell.is_null() {
                    None
                } else {
                    Some(CStr::from_ptr(pwd.pw_shell).to_string_lossy().into_owned())
                };
                let homedir = if pwd.pw_dir.is_null() {
                    None
                } else {
                    Some(PathBuf::from(
                        CStr::from_ptr(pwd.pw_dir).to_string_lossy().into_owned(),
                    ))
                };
                return Ok((username, shell, homedir));
            }
            if rc != libc::ERANGE || size >= 1024 * 1024 {
                return Err(crate::wire::error("COMMAND_FAILED", "无法读取终端所属账户"));
            }
            size *= 2;
            buf.resize(size, 0);
        }
    }
}

fn is_executable_file(candidate: &str) -> bool {
    let path = Path::new(candidate);
    if candidate.is_empty() || !path.is_absolute() || candidate.contains('\0') {
        return false;
    }
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    let Ok(cstr) = CString::new(candidate) else {
        return false;
    };
    unsafe { libc::access(cstr.as_ptr(), libc::X_OK) == 0 }
}

fn login_terminal_command() -> Result<(String, Vec<String>)> {
    let (username, pw_shell, _) = current_posix_user()?;
    let env_shell = std::env::var("SHELL").ok();
    let candidates = [pw_shell, env_shell, Some("/bin/sh".to_owned())];
    let shell = candidates
        .into_iter()
        .flatten()
        .find(|candidate| is_executable_file(candidate))
        .ok_or_else(|| crate::wire::error("COMMAND_FAILED", "没有可用的登录 shell"))?;
    let argv = vec![
        "/usr/bin/env".to_owned(),
        format!("SHELL={shell}"),
        format!("USER={username}"),
        format!("LOGNAME={username}"),
        "TERM=xterm-256color".to_owned(),
        shell.clone(),
        "-l".to_owned(),
        "-i".to_owned(),
    ];
    Ok((shell, argv))
}

fn shell_from_managed_argv(argv: &Value) -> Option<String> {
    let arr = argv.as_array()?;
    if arr.len() == 8
        && arr[0] == "/usr/bin/env"
        && arr[5].is_string()
        && arr[1].as_str() == Some(&format!("SHELL={}", arr[5].as_str()?))
        && arr[2].as_str().is_some_and(|s| s.starts_with("USER="))
        && arr[3].as_str().is_some_and(|s| s.starts_with("LOGNAME="))
        && arr[4] == "TERM=xterm-256color"
        && arr[6] == "-l"
        && arr[7] == "-i"
    {
        return arr[5].as_str().map(str::to_owned);
    }
    arr.first()?.as_str().map(str::to_owned)
}

fn valid_font_size(value: Option<&Value>) -> Option<f64> {
    let val = value?;
    let parsed = val
        .as_f64()
        .or_else(|| val.as_str().and_then(|s| s.trim().parse::<f64>().ok()))?;
    (parsed.is_finite() && (6.0..=72.0).contains(&parsed)).then_some(parsed)
}

fn format_font_name(raw: &str) -> String {
    let trimmed = raw.trim();
    let without_size = match trimmed.rsplit_once(|c: char| c.is_whitespace()) {
        Some((head, tail))
            if !head.is_empty()
                && tail
                    .split_once('.')
                    .map(|(a, b)| !a.is_empty() && b.chars().all(|c| c.is_ascii_digit()))
                    .unwrap_or_else(|| {
                        !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit())
                    }) =>
        {
            head.trim_end()
        }
        _ => trimmed,
    };
    without_size.replace('-', " ")
}

fn trailing_font_size(raw: &str) -> Option<f64> {
    let trimmed = raw.trim();
    let (head, tail) = trimmed.rsplit_once(|c: char| c.is_whitespace())?;
    if head.is_empty() {
        return None;
    }
    let parsed = tail.parse::<f64>().ok()?;
    (parsed.is_finite() && (6.0..=72.0).contains(&parsed)).then_some(parsed)
}

fn is_valid_hex_color(value: &str) -> bool {
    let s = value.trim();
    let Some(hex) = s.strip_prefix('#') else {
        return false;
    };
    matches!(hex.len(), 3 | 6 | 8) && hex.bytes().all(|b| b.is_ascii_hexdigit())
}

fn parse_color_value(value: &Value) -> Option<String> {
    if let Some(s) = value.as_str() {
        let trimmed = s.trim();
        return is_valid_hex_color(trimmed).then(|| trimmed.to_owned());
    }
    let obj = value.as_object()?;
    let components = ["Red", "Green", "Blue"]
        .into_iter()
        .map(|key| {
            obj.get(&format!("{key} Component"))
                .or_else(|| obj.get(&key.to_lowercase()))
                .or_else(|| obj.get(key))
                .and_then(|v| {
                    v.as_f64()
                        .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
                })
        })
        .collect::<Option<Vec<_>>>()?;
    if components
        .iter()
        .any(|c| !c.is_finite() || !(0.0..=1.0).contains(c))
    {
        return None;
    }
    Some(format!(
        "#{:02x}{:02x}{:02x}",
        (components[0] * 255.0).round() as u8,
        (components[1] * 255.0).round() as u8,
        (components[2] * 255.0).round() as u8
    ))
}

fn read_bounded_file(path: &Path) -> Option<Vec<u8>> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() as usize > PROFILE_MAX_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    (bytes.len() <= PROFILE_MAX_BYTES).then_some(bytes)
}

#[cfg(target_os = "macos")]
async fn run_plutil(format: &str, input: &[u8]) -> Option<String> {
    use tokio::io::AsyncWriteExt;
    let mut cmd = tokio::process::Command::new("/usr/bin/plutil");
    cmd.args(["-convert", format, "-o", "-", "--", "-"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let mut child = cmd.spawn().ok()?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input).await;
    }
    let out = tokio::time::timeout(Duration::from_secs(1), child.wait_with_output())
        .await
        .ok()?
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8(out.stdout).ok())?
}

#[cfg(target_os = "macos")]
fn sanitize_xml_plist(xml: &str) -> String {
    let mut out = String::with_capacity(xml.len());
    let mut rest = xml;
    while let Some(start) = rest.find("<data>") {
        out.push_str(&rest[..start]);
        if let Some(end) = rest[start + 6..].find("</data>") {
            out.push_str("<string>");
            for ch in rest[start + 6..start + 6 + end].chars() {
                if !ch.is_whitespace() {
                    out.push(ch);
                }
            }
            out.push_str("</string>");
            rest = &rest[start + 6 + end + 7..];
        } else {
            out.push_str(&rest[start..]);
            rest = "";
            break;
        }
    }
    out.push_str(rest);
    let mut normalized = String::with_capacity(out.len());
    let mut cursor = out.as_str();
    while let Some(start) = cursor.find("<date>") {
        normalized.push_str(&cursor[..start]);
        if let Some(end) = cursor[start + 6..].find("</date>") {
            normalized.push_str("<string>");
            normalized.push_str(&cursor[start + 6..start + 6 + end]);
            normalized.push_str("</string>");
            cursor = &cursor[start + 6 + end + 7..];
        } else {
            normalized.push_str(&cursor[start..]);
            cursor = "";
            break;
        }
    }
    normalized.push_str(cursor);
    normalized.replace("<key>CF$UID</key>", "<key>NSArchiveUID</key>")
}

#[cfg(target_os = "macos")]
async fn read_plist(bytes: &[u8]) -> Option<Value> {
    let xml = run_plutil("xml1", bytes).await?;
    let portable = sanitize_xml_plist(&xml);
    let json_text = run_plutil("json", portable.as_bytes()).await?;
    let val: Value = serde_json::from_str(&json_text).ok()?;
    val.is_object().then_some(val)
}

#[cfg(target_os = "macos")]
async fn read_mac_terminal_profile(
    home: &Path,
) -> Option<(
    Option<String>,
    Option<f64>,
    Option<BTreeMap<String, String>>,
)> {
    use base64::{Engine, engine::general_purpose::STANDARD};

    let iterm_path = home.join("Library/Preferences/com.googlecode.iterm2.plist");
    if let Some(raw) = read_bounded_file(&iterm_path)
        && let Some(plist) = read_plist(&raw).await
        && let Some(bookmarks) = plist["New Bookmarks"].as_array()
    {
        let default_guid = plist.get("Default Bookmark Guid");
        let preferred = bookmarks
            .iter()
            .position(|b| b.is_object() && default_guid.is_some() && b.get("Guid") == default_guid)
            .or_else(|| {
                bookmarks
                    .iter()
                    .position(|b| b.is_object() && b.get("Default Bookmark") == Some(&json!(true)))
            });
        let ordered: Vec<&Value> = if let Some(idx) = preferred {
            std::iter::once(&bookmarks[idx])
                .chain(
                    bookmarks
                        .iter()
                        .enumerate()
                        .filter_map(|(i, v)| (i != idx).then_some(v)),
                )
                .collect()
        } else {
            bookmarks.iter().collect()
        };
        for profile in ordered {
            if !profile.is_object() {
                continue;
            }
            let mut theme = BTreeMap::new();
            for (dst, src) in [
                ("foreground", "Foreground Color"),
                ("background", "Background Color"),
                ("cursor", "Cursor Color"),
                ("cursorAccent", "Cursor Text Color"),
                ("selectionBackground", "Selection Color"),
            ]
            .into_iter()
            .chain(ANSI_KEYS.iter().copied())
            {
                if let Some(val) = profile.get(src).and_then(parse_color_value) {
                    theme.insert(dst.to_owned(), val);
                }
            }
            let descriptor = profile["Normal Font"].as_str().map(str::trim).unwrap_or("");
            let font_family = (!descriptor.is_empty()).then(|| format_font_name(descriptor));
            let font_size = trailing_font_size(descriptor);
            let theme = (!theme.is_empty()).then_some(theme);
            if font_family.is_some() || font_size.is_some() || theme.is_some() {
                return Some((font_family, font_size, theme));
            }
        }
    }

    let term_path = home.join("Library/Preferences/com.apple.Terminal.plist");
    let raw = read_bounded_file(&term_path)?;
    let plist = read_plist(&raw).await?;
    let windows = plist.get("Window Settings")?.as_object()?;
    for name_key in ["Startup Window Settings", "Default Window Settings"] {
        let Some(name) = plist[name_key].as_str() else {
            continue;
        };
        let Some(profile) = windows.get(name).and_then(Value::as_object) else {
            continue;
        };
        let mut theme = BTreeMap::new();
        for (dst, src) in [
            ("foreground", "TextColor".to_owned()),
            ("background", "BackgroundColor".to_owned()),
            ("cursor", "CursorColor".to_owned()),
            ("selectionBackground", "SelectionColor".to_owned()),
        ]
        .into_iter()
        .chain(ANSI_KEYS.iter().map(|(k, _)| {
            let mut chars = k.chars();
            let cap = match chars.next() {
                Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
                None => String::new(),
            };
            (*k, format!("ANSI{cap}Color"))
        })) {
            let Some(raw_color) = profile.get(&src) else {
                continue;
            };
            if let Some(hex) = parse_color_value(raw_color) {
                theme.insert(dst.to_owned(), hex);
                continue;
            }
            if let Some(encoded) = raw_color.as_str()
                && let Ok(decoded) = STANDARD.decode(encoded.as_bytes())
                && let Some(archive) = read_plist(&decoded).await
                && let Some(objects) = archive["$objects"].as_array()
            {
                for obj in objects {
                    let Some(obj_map) = obj.as_object() else {
                        continue;
                    };
                    let rgb = obj_map
                        .get("NSRGB")
                        .or_else(|| obj_map.get("NSWhite"))
                        .and_then(Value::as_str);
                    if let Some(b64) = rgb
                        && let Ok(raw_rgb) = STANDARD.decode(b64.as_bytes())
                    {
                        let ascii = String::from_utf8_lossy(&raw_rgb).replace('\0', "");
                        let nums: Vec<f64> = ascii
                            .split_whitespace()
                            .filter_map(|t| t.parse::<f64>().ok())
                            .collect();
                        let color_val = if obj_map.contains_key("NSWhite") && !nums.is_empty() {
                            json!({ "red": nums[0], "green": nums[0], "blue": nums[0] })
                        } else if nums.len() >= 3 {
                            json!({ "red": nums[0], "green": nums[1], "blue": nums[2] })
                        } else {
                            continue;
                        };
                        if let Some(hex) = parse_color_value(&color_val) {
                            theme.insert(dst.to_owned(), hex);
                            break;
                        }
                    }
                }
            }
        }
        let descriptor = profile
            .get("Font")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        let mut family = profile
            .get("FontName")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let mut size = valid_font_size(profile.get("FontSize"));
        if family.is_none()
            && !descriptor.is_empty()
            && !descriptor
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
        {
            family = Some(format_font_name(descriptor)).filter(|s| !s.is_empty());
        }
        if size.is_none() {
            size = trailing_font_size(descriptor);
        }
        if family.is_none()
            && !descriptor.is_empty()
            && let Ok(decoded) = STANDARD.decode(descriptor.as_bytes())
            && let Some(archive) = read_plist(&decoded).await
            && let Some(objects) = archive["$objects"].as_array()
            && let Some(font) = objects.iter().find(|o| {
                o.is_object() && (o.get("NSName").is_some() || o.get("NSFontName").is_some())
            })
        {
            let name_val = font.get("NSName").or_else(|| font.get("NSFontName"));
            let resolved = match name_val {
                Some(Value::String(s)) => Some(s.clone()),
                Some(Value::Object(map)) => map
                    .get("NSArchiveUID")
                    .and_then(Value::as_u64)
                    .and_then(|idx| objects.get(idx as usize))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                _ => None,
            };
            if let Some(name) = resolved {
                let formatted = format_font_name(&name);
                if !formatted.is_empty() {
                    family = Some(formatted);
                }
            }
            if size.is_none() {
                size = valid_font_size(font.get("NSSize"));
            }
        }
        let theme = (!theme.is_empty()).then_some(theme);
        if family.is_some() || size.is_some() || theme.is_some() {
            return Some((family, size, theme));
        }
    }
    None
}

fn read_kitty_profile(home: &Path) -> Option<String> {
    for rel in [
        ".config/kitty/kitty.conf",
        "Library/Application Support/kitty/kitty.conf",
    ] {
        let Some(bytes) = read_bounded_file(&home.join(rel)) else {
            continue;
        };
        let text = String::from_utf8_lossy(&bytes);
        for line in text.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("font_family")
                && rest.starts_with(char::is_whitespace)
            {
                let font = rest.trim().trim_matches('"').trim();
                if !font.is_empty() {
                    return Some(font.to_owned());
                }
            }
        }
    }
    None
}

async fn resolve_terminal_presentation(home: &Path, host: &Host, source: &str) -> Value {
    let settings = library_store::read_source(host, source)
        .ok()
        .and_then(|lib| lib.get("settings").cloned())
        .unwrap_or_else(|| json!({}));
    let custom = settings["terminalFontFamily"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let user_home = host
        .gateway
        .workbench
        .utility_options(source)
        .ok()
        .and_then(|opts| opts["userHome"].as_str().map(PathBuf::from))
        .or_else(|| current_posix_user().ok().and_then(|(_, _, h)| h))
        .or_else(|| Some(home.to_path_buf()));

    let mut detected_family: Option<String> = None;
    let mut detected_size: Option<f64> = None;
    let mut detected_theme: Option<BTreeMap<String, String>> = None;

    if settings["terminalInheritSystemProfile"] != false
        && let Some(user_home) = user_home.filter(|p| p.is_absolute())
    {
        #[cfg(target_os = "macos")]
        {
            if let Ok(Some((fam, size, theme))) = tokio::time::timeout(
                Duration::from_millis(2500),
                read_mac_terminal_profile(&user_home),
            )
            .await
            {
                detected_family = fam;
                detected_size = size;
                detected_theme = theme;
            }
        }
        if detected_family.is_none() && detected_size.is_none() && detected_theme.is_none() {
            detected_family = read_kitty_profile(&user_home);
        }
    }

    let chosen = custom
        .as_deref()
        .or(detected_family.as_deref())
        .unwrap_or("");
    let mut stack: Vec<String> = Vec::new();
    for part in chosen
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .chain(FALLBACK_FONTS.iter().copied())
    {
        if !stack.iter().any(|existing| existing == part) {
            stack.push(part.to_owned());
        }
    }
    let font_family_source = if custom.is_some() {
        "custom"
    } else if detected_family.is_some() || detected_size.is_some() || detected_theme.is_some() {
        "system"
    } else {
        "fallback"
    };
    let mut out = json!({
        "fontFamily": stack.join(", "),
        "fontFamilySource": font_family_source,
    });
    if let Some(size) = detected_size {
        out["fontSize"] = json!(size);
    }
    if let Some(theme) = detected_theme {
        out["theme"] = json!(theme);
    }
    out
}

fn validate_goal_fields(operation: &str, request: &Value) -> Result<()> {
    let valid_thread = request["threadId"].as_str().is_some_and(|s| !s.is_empty());
    let valid_rev = request["expectedRevision"].as_u64().is_some();
    if !valid_thread || !valid_rev {
        return Err(crate::wire::error(
            "COMMAND_FAILED",
            "目标缺少有效的会话或版本，请刷新后重试",
        ));
    }
    if operation != "goalCreate" && !request["goalId"].as_str().is_some_and(|s| !s.is_empty()) {
        return Err(crate::wire::error("COMMAND_FAILED", "缺少目标 ID"));
    }
    if operation == "goalCreate" || request.get("objective").is_some() {
        let valid_obj = request["objective"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty() && s.chars().count() <= 4000);
        if !valid_obj {
            return Err(crate::wire::error(
                "COMMAND_FAILED",
                "目标应包含 1–4000 个字符",
            ));
        }
    }
    if let Some(infer) = request.get("inferLimits")
        && !infer.is_boolean()
    {
        return Err(crate::wire::error("COMMAND_FAILED", "目标限制解析标识无效"));
    }
    for key in ["tokenBudget", "maxTurns", "maxActiveSeconds"] {
        if let Some(limit) = request.get(key)
            && !limit.is_null()
            && !limit.as_u64().is_some_and(|n| n > 0)
        {
            return Err(crate::wire::error("COMMAND_FAILED", "目标预算必须为正整数"));
        }
    }
    Ok(())
}

async fn refresh_goal_transport(
    host: &Rc<Host>,
    source: &str,
    canonical_id: &str,
    thread_id: &str,
) -> Result<()> {
    let inspection = shared_rpc(
        host,
        canonical_id,
        "areal/thread/inspect",
        json!({ "threadId": thread_id }),
    )
    .await?;
    let configuration = &inspection["configuration"];
    if configuration["model"]["providerId"].as_str() != Some("areal_openai") {
        return Ok(());
    }
    let unavailable = || {
        crate::wire::error(
            "COMMAND_FAILED",
            "当前 ChatGPT 模型不可用，请在模型设置中刷新登录状态或选择其他模型",
        )
    };
    host.ensure_subscription_for_project(source, canonical_id)
        .await
        .map_err(|_| unavailable())?;
    let providers = shared_rpc(host, canonical_id, "areal/provider/list", json!({})).await?;
    let current = providers["data"]
        .as_array()
        .and_then(|rows| rows.iter().find(|p| p["id"] == "areal_openai"))
        .ok_or_else(unavailable)?;
    let model_id = configuration["model"]["modelId"]
        .as_str()
        .ok_or_else(unavailable)?;
    let endpoint = current["endpoint"].as_str().ok_or_else(unavailable)?;
    if !current["models"]
        .as_array()
        .is_some_and(|m| m.iter().any(|item| item == model_id))
    {
        return Err(unavailable());
    }
    if configuration["provider"]["endpoint"].as_str() == Some(endpoint) {
        return Ok(());
    }
    let revision = configuration["revision"].as_u64().ok_or_else(unavailable)?;
    let params = configuration
        .get("parameters")
        .cloned()
        .unwrap_or_else(|| json!({}));
    shared_rpc(
        host,
        canonical_id,
        "areal/thread/configure",
        json!({
            "threadId": thread_id,
            "expectedRevision": revision,
            "model": configuration["model"],
            "parameters": params,
        }),
    )
    .await?;
    Ok(())
}

fn resolve_new_conversation_model_from_catalog(
    models: &[Value],
    last_accepted: &Value,
) -> (Option<Value>, Option<Value>, Option<&'static str>) {
    let last_obj = match last_accepted.as_object() {
        Some(obj) => obj,
        None => return (None, None, None),
    };
    let last_model_id = match last_obj.get("modelId").and_then(Value::as_str) {
        Some(id) if !id.is_empty() => id,
        _ => return (None, None, None),
    };
    let last_provider = last_obj
        .get("model")
        .and_then(|m| m.get("providerId"))
        .cloned()
        .unwrap_or(Value::Null);
    let remembered = models.iter().find(|item| {
        let item_provider = item.get("providerId").cloned().unwrap_or(Value::Null);
        item_provider == last_provider
            && item["modelId"] == last_model_id
            && item["availability"] != "unavailable"
            && (item["available"] != false || item["availability"] == "checking")
    });
    let catalog_ready = !models.is_empty();
    let candidate = if let Some(found) = remembered {
        found.clone()
    } else if !catalog_ready {
        json!({
            "providerId": last_provider,
            "modelId": last_model_id,
            "availability": "checking",
        })
    } else {
        return (None, None, None);
    };
    let effort = last_obj
        .get("reasoningEffort")
        .cloned()
        .filter(|v| !v.is_null());
    let supported = candidate["capabilities"]["reasoningEffortOptions"]
        .as_array()
        .or_else(|| {
            candidate["reasoningEffortOptions"]
                .as_array()
                .filter(|arr| !arr.is_empty())
        });
    let configured_effort = effort
        .as_ref()
        .or_else(|| candidate["parameters"].get("reasoningEffort"))
        .and_then(Value::as_str);
    let unsupported_effort = configured_effort.is_some_and(|eff| {
        eff != "default"
            && (candidate["capabilities"]["reasoning"] == false
                || supported.is_some_and(|opts| !opts.iter().any(|o| o.as_str() == Some(eff))))
    });
    let resolved_effort = if unsupported_effort {
        if candidate["capabilities"]["reasoning"] == false {
            None
        } else if let Some(opts) = supported {
            let preferred = effort.as_ref().and_then(Value::as_str);
            let model_eff = candidate["parameters"]["reasoningEffort"].as_str();
            let chosen = [preferred, model_eff]
                .into_iter()
                .flatten()
                .find(|e| *e == "default" || opts.iter().any(|o| o.as_str() == Some(*e)));
            if let Some(hit) = chosen {
                Some(json!(hit))
            } else if opts.is_empty() {
                Some(json!("default"))
            } else if preferred.is_some() || model_eff.is_some() {
                let fallback = if opts.iter().any(|o| o == "medium") {
                    "medium"
                } else {
                    opts[0].as_str().unwrap_or("default")
                };
                Some(json!(fallback))
            } else {
                None
            }
        } else {
            effort
        }
    } else {
        effort
    };
    let mut parameters = candidate["parameters"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    if let Some(eff) = resolved_effort {
        parameters.insert("reasoningEffort".into(), eff);
    }
    let model = candidate["providerId"].as_str().map(|pid| {
        json!({
            "providerId": pid,
            "modelId": candidate["modelId"],
        })
    });
    let notice = unsupported_effort.then_some("effort-unsupported");
    (model, Some(Value::Object(parameters)), notice)
}

async fn populate_task_draft_start_model(
    host: &Rc<Host>,
    source: &str,
    scope: &ResolvedScope,
    payload: &mut Value,
) -> Result<Option<&'static str>> {
    if payload.get("model").is_some() {
        return Ok(None);
    }
    let Ok(models_result) =
        shared_rpc(host, &scope.canonical_id, "areal/model/list", json!({})).await
    else {
        return Ok(None);
    };
    let models = models_result["data"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let last_accepted = &models_result["lastAcceptedModel"];
    let (model, parameters, notice) =
        resolve_new_conversation_model_from_catalog(&models, last_accepted);
    if model
        .as_ref()
        .and_then(|m| m.get("providerId"))
        .and_then(Value::as_str)
        == Some("areal_openai")
    {
        host.ensure_subscription_for_project(source, &scope.canonical_id)
            .await?;
    }
    if let Some(model) = model {
        payload["model"] = model;
    }
    if let Some(params) = parameters {
        payload["parameters"] = params;
    }
    Ok(notice)
}

async fn run_task_operation(
    host: &Rc<Host>,
    principal: &str,
    source: &str,
    operation: &str,
    request: &Value,
) -> Result<Value> {
    let reading = TASK_READ_OPS.contains(&operation);
    let scope = resolve_project_scope(host, source, request, !reading, false).await?;
    let mut payload = request.clone();
    if let Some(obj) = payload.as_object_mut() {
        obj.remove("logicalProjectId");
        obj.insert("sourceId".into(), json!(source));
        obj.insert("executionProjectId".into(), json!(scope.canonical_id));
    }
    let is_draft = operation.starts_with("taskDraft");
    let mut model_notice: Option<&'static str> = None;
    if is_draft {
        payload["projectId"] = json!(scope.logical);
        if operation == "taskDraftStart" {
            super::session_commands::ensure_project(host, &scope.canonical_id).await?;
            model_notice =
                populate_task_draft_start_model(host, source, &scope, &mut payload).await?;
        }
        if operation == "taskDraftSend" && payload.get("input").is_none() {
            let text = request.get("text").and_then(Value::as_str).unwrap_or("");
            let input =
                rich_message_input_with_command(text, request, false).context("INVALID_PARAMS")?;
            if let Some(obj) = payload.as_object_mut() {
                obj.insert("input".into(), serde_json::to_value(input)?);
                for key in ["text", "attachments", "mcpContent", "conversationQuotes"] {
                    obj.remove(key);
                }
            }
        }
    }
    if reading {
        return super::task_catalog::manage_read(host, &payload).await;
    }
    if payload.get("requestId").is_none()
        && !matches!(operation, "taskDraftStart" | "taskDraftConfirm")
    {
        payload["requestId"] = json!(uuid::Uuid::new_v4().to_string());
    }
    let mut value = super::task_catalog::native_command(host, principal, &payload).await?;
    if is_draft {
        if let Some(tid) = value.get("threadId").and_then(Value::as_str) {
            record_thread_owner(&scope.home, &scope.alias, tid);
            host.changed();
        }
        if let Some(notice) = model_notice
            && value.is_object()
        {
            value["modelNotice"] = json!(notice);
        }
    }
    Ok(value)
}

async fn plugin_readiness(
    host: &Host,
    _source: &str,
    scope: &ResolvedScope,
    request: &Value,
) -> Result<Value> {
    let id = request
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| crate::wire::error("COMMAND_FAILED", "Missing installed plugin snapshot"))?;
    let expected_digest = request
        .get("expectedDigest")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| crate::wire::error("COMMAND_FAILED", "Missing installed plugin snapshot"))?;

    let detail = shared_rpc(
        host,
        &scope.canonical_id,
        "areal/plugin/read",
        json!({ "id": id }),
    )
    .await?;
    if detail["id"].as_str() != Some(id)
        || detail["installed"] != true
        || detail["installedDigest"].as_str() != Some(expected_digest)
    {
        return Err(crate::wire::error(
            "COMMAND_FAILED",
            "Installed plugin snapshot changed; refresh plugin details",
        ));
    }
    if detail["enabled"] != true {
        return Err(crate::wire::error(
            "COMMAND_FAILED",
            "Plugin is disabled in this project",
        ));
    }

    let disabled_skills: BTreeSet<&str> = detail["componentChoices"]["disabledSkills"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let mut required_set: BTreeSet<String> = BTreeSet::new();
    for skill in detail["installedSkills"].as_array().into_iter().flatten() {
        let skipped = skill["id"]
            .as_str()
            .is_some_and(|sid| disabled_skills.contains(sid));
        if skipped {
            continue;
        }
        for tool in skill["requiredTools"].as_array().into_iter().flatten() {
            if let Some(name) = tool.as_str() {
                required_set.insert(name.to_owned());
            }
        }
    }

    let has_desktop_owner = host.clients.borrow().values().any(|pid| pid.is_some());
    let mut deployed = BTreeSet::new();
    if has_desktop_owner {
        let caps = core_capabilities(host, &scope.canonical_id).await?;
        let supports_browser = has_method(&caps, "areal/thread/observe")
            && has_method(&caps, "areal/thread/tools/attach")
            && caps["features"]["browserToolAttachment"] == true
            && caps["browserToolBundles"]
                .as_array()
                .is_some_and(|rows| rows.iter().any(|b| b["bundleId"] == "areal.browser.v1"));
        if supports_browser {
            deployed.insert("browser_v1");
        }
    }

    let required_tools: Vec<String> = required_set.into_iter().collect();
    let missing_tools: Vec<String> = required_tools
        .iter()
        .filter(|name| !deployed.contains(name.as_str()))
        .cloned()
        .collect();
    Ok(json!({
        "pluginId": detail["id"],
        "installedDigest": detail["installedDigest"],
        "requiredTools": required_tools,
        "missingTools": missing_tools,
        "available": missing_tools.is_empty(),
    }))
}

async fn plugin_user_config_save(
    host: &Rc<Host>,
    source: &str,
    scope: &ResolvedScope,
    request: &Value,
    req_id: &str,
    gate: &Mutex<()>,
) -> Result<Value> {
    let has_secrets = request.get("secrets").is_some();
    if !has_secrets {
        let mut wire = pick_fields(
            request,
            &[
                "id",
                "expectedRevision",
                "expectedDigest",
                "values",
                "clearKeys",
            ],
        );
        wire["requestId"] = json!(req_id);
        let result = workbench_submissions::submit_shared(
            host,
            &scope.canonical_id,
            "areal/plugin/userConfig/set",
            wire,
            true,
        )
        .await?;
        host.changed();
        return Ok(result);
    }

    let id = request["id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .context("INVALID_PARAMS")?;
    let expected_digest = request["expectedDigest"]
        .as_str()
        .filter(|s| !s.is_empty())
        .context("INVALID_PARAMS")?;
    let expected_revision = request["expectedRevision"]
        .as_u64()
        .context("INVALID_PARAMS")?;
    let raw_values = request["values"].as_object().context("INVALID_PARAMS")?;
    let raw_secrets = request["secrets"].as_object().context("INVALID_PARAMS")?;
    let clear_keys: Vec<String> = match request.get("clearKeys") {
        None => Vec::new(),
        Some(val) => serde_json::from_value(val.clone()).context("INVALID_PARAMS")?,
    };

    let detail = shared_rpc(
        host,
        &scope.canonical_id,
        "areal/plugin/read",
        json!({ "id": id }),
    )
    .await?;
    if detail["installedDigest"].as_str() != Some(expected_digest)
        || detail["revision"].as_u64() != Some(expected_revision)
    {
        return Err(crate::wire::error(
            "COMMAND_FAILED",
            "插件快照或配置版本已变化，请刷新后保存",
        ));
    }

    let fields = detail["userConfiguration"]["fields"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let total_updates = raw_values.len() + raw_secrets.len() + clear_keys.len();
    let mut unique_updates = BTreeSet::new();
    for key in raw_values
        .keys()
        .chain(raw_secrets.keys())
        .chain(clear_keys.iter())
    {
        if !fields.contains_key(key) {
            return Err(crate::wire::error(
                "COMMAND_FAILED",
                "插件配置字段无效或重复",
            ));
        }
        unique_updates.insert(key);
    }
    if unique_updates.len() != total_updates {
        return Err(crate::wire::error(
            "COMMAND_FAILED",
            "插件配置字段无效或重复",
        ));
    }
    for (key, value) in raw_values {
        let def = &fields[key]["definition"];
        let kind = value["kind"].as_str().unwrap_or("");
        if def["sensitive"] == true || def["type"].as_str() != Some(kind) {
            return Err(crate::wire::error(
                "COMMAND_FAILED",
                "插件普通配置与字段定义不匹配",
            ));
        }
    }
    for (key, secret) in raw_secrets {
        let def = &fields[key]["definition"];
        if def["sensitive"] != true
            || def["type"] != "string"
            || !secret.as_str().is_some_and(|s| !s.is_empty())
        {
            return Err(crate::wire::error(
                "COMMAND_FAILED",
                "插件敏感配置与字段定义不匹配",
            ));
        }
    }

    let _guard = gate.lock().await;
    let mut values = raw_values.clone();
    let mut credentials = BTreeMap::new();
    for (key, secret) in raw_secrets {
        let raw_secret = secret.as_str().unwrap_or("");
        let (short_ref, secret_val) =
            save_plugin_credential(host, source, raw_secret, false).await?;
        credentials.insert(short_ref.clone(), secret_val);
        values.insert(
            key.clone(),
            json!({ "kind": "secretRef", "value": short_ref }),
        );
    }
    let reload_deferred = if credentials.is_empty() {
        false
    } else {
        register_plugin_credentials(host, source, &scope.canonical_id, &credentials).await?
    };

    let mut wire = json!({
        "id": id,
        "expectedRevision": expected_revision,
        "expectedDigest": expected_digest,
        "values": values,
        "requestId": req_id,
    });
    if !clear_keys.is_empty() {
        wire["clearKeys"] = json!(clear_keys);
    }
    let mut result = workbench_submissions::submit_shared(
        host,
        &scope.canonical_id,
        "areal/plugin/userConfig/set",
        wire,
        true,
    )
    .await?;
    host.changed();
    if reload_deferred && let Some(obj) = result.as_object_mut() {
        obj.insert("reloadDeferred".into(), json!(true));
    }
    Ok(result)
}

async fn plugin_auth_credential(
    host: &Rc<Host>,
    source: &str,
    scope: &ResolvedScope,
    request: &Value,
    req_id: &str,
    gate: &Mutex<()>,
) -> Result<Value> {
    let id = request["id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .context("INVALID_PARAMS")?;
    let server = request["server"]
        .as_str()
        .filter(|s| !s.is_empty())
        .context("INVALID_PARAMS")?;
    let expected_digest = request["expectedDigest"]
        .as_str()
        .filter(|s| !s.is_empty())
        .context("INVALID_PARAMS")?;

    let list = shared_rpc(
        host,
        &scope.canonical_id,
        "areal/plugin/mcp/list",
        json!({}),
    )
    .await?;
    let row = list["data"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|item| item["pluginId"].as_str() == Some(id))
        })
        .ok_or_else(|| crate::wire::error("COMMAND_FAILED", "插件服务器或已安装摘要已变化"))?;
    let has_server = row["servers"].as_array().is_some_and(|servers| {
        servers
            .iter()
            .any(|s| s["serverId"].as_str() == Some(server))
    });
    if row["installedDigest"].as_str() != Some(expected_digest) || !has_server {
        return Err(crate::wire::error(
            "COMMAND_FAILED",
            "插件服务器或已安装摘要已变化",
        ));
    }
    if matches!(row["state"].as_str(), Some("connected" | "partial")) {
        return Err(crate::wire::error(
            "COMMAND_FAILED",
            "请先断开插件，再更改认证配置",
        ));
    }

    let config_src = request.get("configuration").and_then(Value::as_object);
    let mut configuration = serde_json::Map::new();
    if let Some(src) = config_src {
        for key in [
            "clientSecretRef",
            "privateKeyRef",
            "privateKeyId",
            "clientMetadataUrl",
            "apiKeyRef",
            "callbackUrl",
        ] {
            if let Some(v) = src.get(key) {
                configuration.insert(key.to_owned(), v.clone());
            }
        }
    }
    let cred_values = match request.get("credentials") {
        None => serde_json::Map::new(),
        Some(v) => v
            .as_object()
            .ok_or_else(|| crate::wire::error("COMMAND_FAILED", "认证凭据字段无效"))?
            .clone(),
    };
    if cred_values
        .keys()
        .any(|k| !matches!(k.as_str(), "clientSecret" | "privateKeyPem" | "apiKey"))
    {
        return Err(crate::wire::error("COMMAND_FAILED", "认证凭据字段无效"));
    }

    let _guard = gate.lock().await;
    let mut credentials = BTreeMap::new();
    for (field, cfg_ref, private_key) in [
        ("clientSecret", "clientSecretRef", false),
        ("privateKeyPem", "privateKeyRef", true),
        ("apiKey", "apiKeyRef", false),
    ] {
        let Some(raw_val) = cred_values.get(field) else {
            continue;
        };
        if raw_val.as_str() == Some("") {
            continue;
        }
        let raw_str = raw_val
            .as_str()
            .ok_or_else(|| crate::wire::error("COMMAND_FAILED", "凭据格式无效"))?;
        let (short_ref, secret_val) =
            save_plugin_credential(host, source, raw_str, private_key).await?;
        configuration.insert(cfg_ref.to_owned(), json!(short_ref));
        credentials.insert(short_ref, secret_val);
    }
    if !credentials.is_empty() {
        register_plugin_credentials(host, source, &scope.canonical_id, &credentials).await?;
    }
    let result = workbench_submissions::submit_shared(
        host,
        &scope.canonical_id,
        "areal/plugin/auth/configure",
        json!({
            "id": id,
            "server": server,
            "expectedDigest": expected_digest,
            "configuration": configuration,
            "requestId": req_id,
        }),
        true,
    )
    .await?;
    host.changed();
    Ok(result)
}

async fn process_rpc(
    host: &Rc<Host>,
    project: &str,
    lease: Option<&str>,
    method: &str,
    params: Value,
) -> Result<Value> {
    if let Some(lease) = lease {
        let response = host
            .schedules
            .connections
            .workbench_request(host, project, lease, method, params)
            .await?;
        if let Some(error) = response.get("error") {
            return Err(super::schedule_connection::RpcFailure(error.clone()).into());
        }
        return response.get("result").cloned().context("INVALID_RESPONSE");
    }
    shared_rpc(host, project, method, params).await
}

impl ManageService {
    pub(super) async fn read_rpc(
        &self,
        host: &Rc<Host>,
        source: &str,
        params: Value,
    ) -> Result<Value> {
        self.execute(host, "local", source, &params, None, true)
            .await
    }

    pub(super) async fn command_rpc(
        &self,
        host: &Rc<Host>,
        source: &str,
        command_id: &str,
        params: Value,
    ) -> Result<Value> {
        self.execute(host, "local", source, &params, Some(command_id), true)
            .await
    }

    pub(super) async fn desktop_command(
        &self,
        host: &Rc<Host>,
        principal: &str,
        source: &str,
        request: &Value,
    ) -> Result<Value> {
        self.execute(host, principal, source, request, None, false)
            .await
    }

    async fn execute(
        &self,
        host: &Rc<Host>,
        principal: &str,
        source: &str,
        request: &Value,
        command_id: Option<&str>,
        from_manage_rpc: bool,
    ) -> Result<Value> {
        let operation = request["operation"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| crate::wire::error("COMMAND_FAILED", "管理请求结构无效"))?;

        if matches!(operation, "pluginStoreSnapshot" | "pluginStoreDoctor") {
            return execute_plugin_store_snapshot_or_doctor(host, source, operation, request).await;
        }
        if is_plugin_store_op(operation) {
            let (reading, normalized) = validate_plugin_store_op(host, source, operation, request)?;
            return super::plugins::request(
                host,
                if reading {
                    "plugins.read"
                } else {
                    "plugins.command"
                },
                &normalized,
            )
            .await;
        }
        if TASK_READ_OPS.contains(&operation) || TASK_WRITE_OPS.contains(&operation) {
            return run_task_operation(host, principal, source, operation, request).await;
        }

        if operation == "pluginReadiness" {
            let _ = request
                .get("id")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| {
                    crate::wire::error("COMMAND_FAILED", "Missing installed plugin snapshot")
                })?;
            let _ = request
                .get("expectedDigest")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| {
                    crate::wire::error("COMMAND_FAILED", "Missing installed plugin snapshot")
                })?;
        }

        let is_mutation = !is_read_operation(operation);
        let scope = resolve_project_scope(host, source, request, is_mutation, true).await?;

        if is_mutation
            && !CLEANUP_OPS.contains(&operation)
            && ["threadId", "parentThreadId", "sourceThreadId"]
                .iter()
                .any(|f| request[f].as_str().is_some_and(|s| !s.is_empty()))
        {
            host.schedules
                .connections
                .workbench_admit(host, &scope.canonical_id, None, "manage", request)
                .await?;
        }

        if operation.starts_with("goal")
            && let Some(tid) = request["threadId"].as_str().filter(|s| !s.is_empty())
        {
            let thread_resp = shared_rpc(
                host,
                &scope.canonical_id,
                "thread/read",
                json!({ "threadId": tid, "includeTurns": false }),
            )
            .await?;
            let is_task_draft =
                thread_resp["thread"]["desktop"]["configuration"]["options"]["appendInstructions"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("AREAL_TASK_DRAFT_V1\n"));
            if is_task_draft {
                return Err(crate::wire::error(
                    "COMMAND_FAILED",
                    "任务管理会话不执行目标；请在会话中描述要调整的定时任务。",
                ));
            }
        }

        if let Some((method, fields)) = direct_read_spec(operation) {
            let result = shared_rpc(
                host,
                &scope.canonical_id,
                method,
                pick_fields(request, fields),
            )
            .await?;
            return match operation {
                "workgroup" | "workgroupWait" => format_workgroup_result(result, from_manage_rpc),
                _ => Ok(result),
            };
        }

        match operation {
            "pluginCapabilities" => {
                let caps = core_capabilities(host, &scope.canonical_id).await?;
                Ok(json!({ "enabled": has_method(&caps, "areal/plugin/list") }))
            }
            "workgroupCapabilities" => {
                let caps = core_capabilities(host, &scope.canonical_id).await?;
                Ok(json!({ "enabled": has_method(&caps, "areal/workgroup/start") }))
            }
            "pluginReadiness" => plugin_readiness(host, source, &scope, request).await,
            "workgroupArtifactStatus" | "workgroupApplyArtifact" => {
                self.workgroup_artifact_file(
                    host,
                    &scope,
                    request,
                    operation == "workgroupApplyArtifact",
                )
                .await
            }
            "pluginSubmission" => self.plugin_submission(host, &scope, request).await,
            "workgroupSubmission" => self.workgroup_submission(host, &scope, request).await,
            "agentSubmission" => self.agent_submission(host, &scope, request).await,
            "processSubmission" => {
                self.process_submission(host, source, &scope, request, None)
                    .await
            }
            "pluginAuth" => {
                let mut params = pick_fields(request, &["id", "server"]);
                params["operation"] = request["authOperation"].clone();
                shared_rpc(host, &scope.canonical_id, "areal/plugin/auth", params).await
            }
            "mcpExtensionCall" => {
                shared_rpc(
                    host,
                    &scope.canonical_id,
                    "areal/mcp/extension/call",
                    pick_fields(
                        request,
                        &[
                            "threadId",
                            "serverId",
                            "expectedGeneration",
                            "kind",
                            "arguments",
                            "requestId",
                        ],
                    ),
                )
                .await
            }
            "executionCancel" => {
                shared_rpc(
                    host,
                    &scope.canonical_id,
                    "areal/execution/cancel",
                    pick_fields(request, &["parentThreadId", "executionId", "mode"]),
                )
                .await
            }
            "executionApply" => {
                shared_rpc(
                    host,
                    &scope.canonical_id,
                    "areal/execution/apply",
                    pick_fields(request, &["parentThreadId", "executionId"]),
                )
                .await
            }
            "serverDrain" => {
                shared_rpc(
                    host,
                    &scope.canonical_id,
                    "areal/server/drain",
                    json!({ "strategy": "ifIdle", "timeoutMs": 30_000 }),
                )
                .await
            }
            "serverGc" => shared_rpc(host, &scope.canonical_id, "areal/server/gc", json!({})).await,
            "workgroupCancel" => {
                let result = shared_rpc(
                    host,
                    &scope.canonical_id,
                    "areal/workgroup/cancel",
                    pick_fields(request, &["id"]),
                )
                .await?;
                format_workgroup_result(result, from_manage_rpc)
            }
            "closeResources" => {
                let tid = non_empty_text(
                    request.get("threadId"),
                    "COMMAND_FAILED",
                    "缺少资源所属会话",
                )?;
                shared_rpc(
                    host,
                    &scope.canonical_id,
                    "areal/thread/closeResources",
                    json!({ "threadId": tid }),
                )
                .await
            }
            "planUpdate" => {
                shared_rpc(
                    host,
                    &scope.canonical_id,
                    "areal/plan/update",
                    pick_fields(request, &["threadId", "expectedRevision", "steps"]),
                )
                .await
            }
            "toolAcknowledge" => {
                let tid = non_empty_text(
                    request.get("threadId"),
                    "COMMAND_FAILED",
                    "缺少原会话或执行项",
                )?;
                let item_id = non_empty_text(
                    request.get("itemId"),
                    "COMMAND_FAILED",
                    "缺少原会话或执行项",
                )?;
                let inspection = request
                    .get("inspection")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty() && s.len() <= 1024)
                    .ok_or_else(|| {
                        crate::wire::error("COMMAND_FAILED", "核查说明应包含 1–1024 个 UTF-8 字节")
                    })?;
                shared_rpc(
                    host,
                    &scope.canonical_id,
                    "areal/tool/acknowledge",
                    json!({ "threadId": tid, "itemId": item_id, "inspection": inspection }),
                )
                .await?;
                host.changed();
                Ok(json!({}))
            }
            "contextCompact" => {
                let result = shared_rpc(
                    host,
                    &scope.canonical_id,
                    "areal/context/compact",
                    pick_fields(request, &["threadId"]),
                )
                .await?;
                host.changed();
                Ok(result)
            }
            "permissionsForget" => {
                ensure!(
                    request.get("project").is_some_and(Value::is_boolean),
                    crate::wire::error("COMMAND_FAILED", "请选择撤销授权的作用域")
                );
                shared_rpc(
                    host,
                    &scope.canonical_id,
                    "areal/permissions/forget",
                    pick_fields(request, &["threadId", "project"]),
                )
                .await
            }
            "providerProbe" => {
                shared_rpc(
                    host,
                    &scope.canonical_id,
                    "areal/provider/probe",
                    pick_fields(request, &["id", "model"]),
                )
                .await
            }
            _ => {
                self.execute_journaled_mutation(
                    host,
                    source,
                    &scope,
                    operation,
                    request,
                    command_id,
                    from_manage_rpc,
                )
                .await
            }
        }
    }

    async fn execute_journaled_mutation(
        &self,
        host: &Rc<Host>,
        source: &str,
        scope: &ResolvedScope,
        operation: &str,
        request: &Value,
        command_id: Option<&str>,
        from_manage_rpc: bool,
    ) -> Result<Value> {
        let req_id = match request.get("requestId") {
            Some(v) => uuid_str(Some(v))?.to_owned(),
            None => match command_id {
                Some(id) => uuid_str(Some(&json!(id)))?.to_owned(),
                None => optional_uuid_or_new(None)?,
            },
        };

        if matches!(
            operation,
            "workgroupStart" | "workflowStart" | "workgroupRevise"
        ) {
            let (method, fields): (&str, &[&str]) = match operation {
                "workgroupStart" => ("areal/workgroup/start", &["plan", "workers", "admission"]),
                "workflowStart" => (
                    "areal/workflow/start",
                    &["workflow", "workers", "admission"],
                ),
                "workgroupRevise" => (
                    "areal/workgroup/revise",
                    &["id", "expectedRevision", "plan"],
                ),
                _ => unreachable!(),
            };
            let mut wire = pick_fields(request, fields);
            wire["requestId"] = json!(req_id);
            let result = workbench_submissions::submit_shared(
                host,
                &scope.canonical_id,
                method,
                wire,
                false,
            )
            .await?;
            host.changed();
            return format_workgroup_result(result, from_manage_rpc);
        }

        if operation == "agentSpawn" {
            let parent_tid = non_empty_text(
                request.get("parentThreadId"),
                "COMMAND_FAILED",
                "缺少父任务",
            )?;
            let prompt = request
                .get("prompt")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| crate::wire::error("COMMAND_FAILED", "请输入子任务指令"))?;
            let mut wire = pick_fields(
                request,
                &[
                    "agentProfile",
                    "model",
                    "instructions",
                    "skills",
                    "toolAllowlist",
                ],
            );
            wire["threadId"] = json!(parent_tid);
            wire["parentThreadId"] = json!(parent_tid);
            wire["input"] = json!([{ "type": "text", "text": prompt }]);
            wire["workspaceMode"] = json!("sharedReadOnly");
            wire["requestId"] = json!(req_id);
            let result = workbench_submissions::submit_shared(
                host,
                &scope.canonical_id,
                "areal/agent/spawn",
                wire,
                true,
            )
            .await?;
            let spawned_tid = result["threadId"]
                .as_str()
                .ok_or_else(|| crate::wire::error("COMMAND_FAILED", "子任务受理身份无法确认"))?;
            record_thread_owner(&scope.home, &scope.alias, spawned_tid);
            host.changed();
            return Ok(result);
        }

        if operation == "pluginUserConfigSave" {
            return plugin_user_config_save(
                host,
                source,
                scope,
                request,
                &req_id,
                &self.credential_gate,
            )
            .await;
        }
        if operation == "pluginAuthCredential" {
            return plugin_auth_credential(
                host,
                source,
                scope,
                request,
                &req_id,
                &self.credential_gate,
            )
            .await;
        }

        let Some((method, fields)) = journaled_mutation_spec(operation) else {
            return Err(crate::wire::error("COMMAND_FAILED", "不支持的管理操作"));
        };

        let is_goal = operation.starts_with("goal");
        if is_goal {
            validate_goal_fields(operation, request)?;
            if matches!(operation, "goalCreate" | "goalResume") {
                let tid = request["threadId"].as_str().unwrap_or("");
                refresh_goal_transport(host, source, &scope.canonical_id, tid).await?;
            }
        }

        let mut terminal_shell: Option<String> = None;
        let mut wire = pick_fields(request, fields);
        if operation == "processStart" {
            if let Some(flag) = request.get("terminal")
                && !flag.is_boolean()
            {
                return Err(crate::wire::error("COMMAND_FAILED", "无效终端启动标识"));
            }
            if request.get("terminal") == Some(&json!(true)) {
                if request.get("argv").is_some() || request.get("tty") != Some(&json!(true)) {
                    return Err(crate::wire::error(
                        "COMMAND_FAILED",
                        "登录终端需要 tty，且不能同时指定 argv",
                    ));
                }
                let (shell, argv) = login_terminal_command()?;
                terminal_shell = Some(shell);
                wire["argv"] = json!(argv);
            }
        }
        wire["requestId"] = json!(req_id);

        let remember_outcome =
            method.starts_with("areal/plugin/") || method == "areal/hook/acknowledge";
        let result = workbench_submissions::submit_shared(
            host,
            &scope.canonical_id,
            method,
            wire,
            remember_outcome,
        )
        .await?;

        if operation == "pluginSetup"
            && let Some(tid) = result["thread"]["id"].as_str()
        {
            record_thread_owner(&scope.home, &scope.alias, tid);
        }
        host.changed();

        let Some(shell) = terminal_shell else {
            return Ok(result);
        };
        let mut out = result
            .as_object()
            .cloned()
            .ok_or_else(|| crate::wire::error("COMMAND_FAILED", "终端受理结果结构无效"))?;
        out.insert("shell".into(), json!(shell));
        let presentation = resolve_terminal_presentation(&scope.home, host, source).await;
        if let Some(map) = presentation.as_object() {
            for (k, v) in map {
                out.insert(k.clone(), v.clone());
            }
        }
        Ok(Value::Object(out))
    }

    async fn workgroup_artifact_file(
        &self,
        host: &Host,
        scope: &ResolvedScope,
        request: &Value,
        apply: bool,
    ) -> Result<Value> {
        let id = non_empty_text(request.get("id"), "INVALID_PARAMS", "INVALID_PARAMS")?;
        let path = non_empty_text(request.get("path"), "COMMAND_FAILED", "缺少产物文件或版本")?;
        let head = non_empty_text(request.get("head"), "COMMAND_FAILED", "缺少产物文件或版本")?;
        let real_root = scope
            .workspace
            .canonicalize()
            .unwrap_or_else(|_| scope.workspace.clone());
        let key = (real_root, path.to_owned());

        loop {
            let notify = {
                let active = self.applying_artifacts.borrow();
                if !active.contains(&key) {
                    None
                } else {
                    Some(self.artifact_notify.notified())
                }
            };
            match notify {
                Some(wait) => wait.await,
                None => break,
            }
        }

        struct LockGuard<'a> {
            set: &'a RefCell<BTreeSet<(PathBuf, String)>>,
            notify: &'a Notify,
            key: (PathBuf, String),
        }
        impl Drop for LockGuard<'_> {
            fn drop(&mut self) {
                self.set.borrow_mut().remove(&self.key);
                self.notify.notify_waiters();
            }
        }
        let _lock = if apply {
            self.applying_artifacts.borrow_mut().insert(key.clone());
            Some(LockGuard {
                set: &self.applying_artifacts,
                notify: &self.artifact_notify,
                key,
            })
        } else {
            None
        };

        let first = shared_rpc(
            host,
            &scope.canonical_id,
            "areal/workgroup/artifact",
            json!({ "id": id, "path": path, "offset": 0 }),
        )
        .await?;
        let meta = parse_artifact_page_meta(&first, head, path)?;
        if !apply {
            return artifact_file_state(&scope.workspace, &meta);
        }

        use base64::{Engine, engine::general_purpose::STANDARD};
        let mut collected = Vec::new();
        let mut offset = 0usize;
        let mut page = first;
        loop {
            let page_meta = parse_artifact_page_meta(&page, head, path)?;
            if page_meta.exists != meta.exists
                || page_meta.bytes != meta.bytes
                || page_meta.base_sha256 != meta.base_sha256
                || page_meta.sha256 != meta.sha256
                || page_meta.executable != meta.executable
                || page["offset"].as_u64() != Some(offset as u64)
            {
                return Err(crate::wire::error(
                    "COMMAND_FAILED",
                    "产物分块版本不一致，未应用。",
                ));
            }
            let b64 = page["dataBase64"]
                .as_str()
                .ok_or_else(|| crate::wire::error("COMMAND_FAILED", "产物分块无效，未应用。"))?;
            let chunk = STANDARD
                .decode(b64.as_bytes())
                .map_err(|_| crate::wire::error("COMMAND_FAILED", "产物分块无效，未应用。"))?;
            let next_offset = offset + chunk.len();
            if chunk.len() > 4096
                || next_offset > meta.bytes
                || page["nextOffset"].as_u64() != Some(next_offset as u64)
                || page["complete"].as_bool() != Some(next_offset == meta.bytes)
            {
                return Err(crate::wire::error(
                    "COMMAND_FAILED",
                    "产物分块无效，未应用。",
                ));
            }
            collected.extend_from_slice(&chunk);
            offset = next_offset;
            if page["complete"] == true {
                break;
            }
            if chunk.is_empty() {
                return Err(crate::wire::error(
                    "COMMAND_FAILED",
                    "产物读取没有前进，未应用。",
                ));
            }
            page = shared_rpc(
                host,
                &scope.canonical_id,
                "areal/workgroup/artifact",
                json!({ "id": id, "path": path, "offset": offset }),
            )
            .await?;
        }
        apply_verified_artifact(&scope.workspace, &meta, &collected)
    }

    async fn plugin_submission(
        &self,
        host: &Rc<Host>,
        scope: &ResolvedScope,
        request: &Value,
    ) -> Result<Value> {
        let mutation = request
            .get("mutation")
            .and_then(Value::as_str)
            .filter(|m| {
                matches!(
                    *m,
                    "pluginArchiveImport"
                        | "pluginConnection"
                        | "pluginHooksConfigure"
                        | "hookAcknowledge"
                        | "pluginAuthConfigure"
                        | "pluginComponentConfigure"
                        | "pluginSetup"
                        | "pluginUserConfigSave"
                        | "pluginDevelopmentLink"
                        | "pluginDevelopmentUnlink"
                )
            })
            .ok_or_else(|| crate::wire::error("COMMAND_FAILED", "缺少原插件提交标识"))?;
        let req_id = request
            .get("requestId")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| crate::wire::error("COMMAND_FAILED", "缺少原插件提交标识"))?;
        let (method, _) = journaled_mutation_spec(mutation)
            .ok_or_else(|| crate::wire::error("COMMAND_FAILED", "缺少原插件提交标识"))?;
        let mut params = json!({ "requestId": req_id });
        if let Some(tid) = request.get("threadId").and_then(Value::as_str) {
            params["threadId"] = json!(tid);
        }
        let receipt =
            workbench_submissions::reconcile_shared(host, &scope.canonical_id, method, params)
                .await?;
        if receipt["confirmed"] == true
            && receipt.get("error").is_none()
            && mutation == "pluginSetup"
            && let Some(tid) = receipt["result"]["thread"]["id"].as_str()
        {
            record_thread_owner(&scope.home, &scope.alias, tid);
        }
        host.changed();
        Ok(receipt)
    }

    async fn workgroup_submission(
        &self,
        host: &Rc<Host>,
        scope: &ResolvedScope,
        request: &Value,
    ) -> Result<Value> {
        let req_id = non_empty_text(request.get("requestId"), "COMMAND_FAILED", "缺少原提交标识")?;
        let outcomes =
            workbench_submissions::reconcile_project(host, &scope.canonical_id, Some(req_id))
                .await?;
        let Some(outcome) = outcomes.get(req_id) else {
            return Ok(json!({ "confirmed": false }));
        };
        if outcome["accepted"] != true
            || !outcome["workgroupId"].is_string()
            || outcome["planRevision"].as_u64().is_none()
        {
            return Ok(json!({ "confirmed": false }));
        }
        let mut out = outcome.as_object().cloned().unwrap_or_default();
        out.insert("confirmed".into(), json!(true));
        Ok(Value::Object(out))
    }

    async fn agent_submission(
        &self,
        host: &Rc<Host>,
        scope: &ResolvedScope,
        request: &Value,
    ) -> Result<Value> {
        let parent_tid = non_empty_text(
            request.get("parentThreadId"),
            "COMMAND_FAILED",
            "缺少原创建请求标识或父任务",
        )?;
        let req_id = non_empty_text(
            request.get("requestId"),
            "COMMAND_FAILED",
            "缺少原创建请求标识或父任务",
        )?;
        if let Ok((_, snapshot)) = host.journal.native_snapshot(&scope.canonical_id)
            && let Some(pending) = snapshot["pending"].as_array().and_then(|rows| {
                rows.iter()
                    .find(|r| r["operationId"] == req_id || r["params"]["requestId"] == req_id)
            })
            && (pending["method"] != "areal/agent/spawn"
                || pending["params"]["parentThreadId"].as_str() != Some(parent_tid))
        {
            return Ok(json!({ "confirmed": false }));
        }
        let outcomes =
            workbench_submissions::reconcile_project(host, &scope.canonical_id, Some(req_id))
                .await?;
        let Some(outcome) = outcomes.get(req_id) else {
            return Ok(json!({ "confirmed": false }));
        };
        if outcome["method"] != "areal/agent/spawn"
            || outcome["accepted"] != true
            || outcome["parentThreadId"].as_str() != Some(parent_tid)
            || !outcome["threadId"].is_string()
            || !outcome["turnId"].is_string()
        {
            return Ok(json!({ "confirmed": false }));
        }
        if let Some(tid) = outcome["threadId"].as_str() {
            record_thread_owner(&scope.home, &scope.alias, tid);
        }
        let mut out = outcome.as_object().cloned().unwrap_or_default();
        out.insert("confirmed".into(), json!(true));
        Ok(Value::Object(out))
    }

    pub(super) async fn terminal_command(
        &self,
        host: &Rc<Host>,
        source: &str,
        scope: &ResolvedScope,
        lease: &str,
        request: &Value,
    ) -> Result<Value> {
        let operation = request["operation"].as_str().context("INVALID_PARAMS")?;
        if operation == "processSubmission" {
            return self
                .process_submission(host, source, scope, request, Some(lease))
                .await;
        }
        if let Some((method, fields)) = direct_read_spec(operation) {
            return process_rpc(
                host,
                &scope.canonical_id,
                Some(lease),
                method,
                pick_fields(request, fields),
            )
            .await;
        }
        let (method, fields) = journaled_mutation_spec(operation).context("INVALID_PARAMS")?;
        let mut params = pick_fields(request, fields);
        let request_id = request["requestId"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        crate::wire::request_id(&request_id)?;
        params["requestId"] = json!(request_id);
        let shell = if operation == "processStart" && request["terminal"] == true {
            ensure!(
                request.get("argv").is_none() && request["tty"] == true,
                "INVALID_PARAMS"
            );
            let (shell, argv) = login_terminal_command()?;
            params["argv"] = json!(argv);
            Some(shell)
        } else {
            None
        };
        if operation == "processStart" {
            // GUI 的 turn/thread 只决定页面回收时机，Core 资源始终归原窗口连接。
            params["lifetime"] = json!("connection");
        }
        let response = workbench_submissions::submit(
            host,
            &scope.canonical_id,
            lease,
            method,
            params,
            true,
            false,
        )
        .await;
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                if workbench_submissions::find(host, &scope.canonical_id, &request_id)?
                    .is_some_and(|entry| entry.get("status").is_none())
                {
                    anyhow::bail!("SUBMISSION_UNKNOWN");
                }
                return Err(error);
            }
        };
        if let Some(error) = response.get("error") {
            if matches!(
                error["data"]["outcome"]["kind"].as_str(),
                Some("rejected" | "noMutation")
            ) {
                return Err(crate::wire::error(
                    "COMMAND_FAILED",
                    error["message"]
                        .as_str()
                        .unwrap_or("Core rejected terminal operation")
                        .chars()
                        .take(512)
                        .collect::<String>(),
                ));
            }
            anyhow::bail!("SUBMISSION_UNKNOWN");
        }
        let mut result = response
            .get("result")
            .cloned()
            .context("INVALID_RESPONSE")?;
        if let Some(shell) = shell {
            result["shell"] = json!(shell);
            let presentation = resolve_terminal_presentation(&scope.home, host, source).await;
            if let Some(fields) = presentation.as_object() {
                for (key, value) in fields {
                    result[key] = value.clone();
                }
            }
        }
        host.changed();
        Ok(result)
    }

    async fn process_submission(
        &self,
        host: &Rc<Host>,
        source: &str,
        scope: &ResolvedScope,
        request: &Value,
        lease: Option<&str>,
    ) -> Result<Value> {
        let thread_id = request
            .get("threadId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| crate::wire::error("COMMAND_FAILED", "缺少原终端请求标识或任务"))?;
        let req_id = request
            .get("requestId")
            .and_then(Value::as_str)
            .filter(|s| {
                s.len() == 36
                    && s.bytes()
                        .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'-'))
            })
            .ok_or_else(|| crate::wire::error("COMMAND_FAILED", "缺少原终端请求标识或任务"))?;
        if uuid::Uuid::parse_str(req_id).is_err() {
            return Err(crate::wire::error(
                "COMMAND_FAILED",
                "缺少原终端请求标识或任务",
            ));
        }

        if let Ok((_, snapshot)) = host.journal.native_snapshot(&scope.canonical_id)
            && let Some(pending) = snapshot["pending"].as_array().and_then(|rows| {
                rows.iter()
                    .find(|r| r["operationId"] == req_id || r["params"]["requestId"] == req_id)
            })
            && (pending["method"] != "areal/process/start"
                || pending["params"]["threadId"].as_str() != Some(thread_id))
        {
            return Ok(json!({ "confirmed": false }));
        }

        let identity = json!({ "requestId": req_id, "threadId": thread_id });
        let receipt = if let Some(lease) = lease {
            workbench_submissions::reconcile(
                host,
                &scope.canonical_id,
                lease,
                "areal/process/start",
                identity,
            )
            .await?
        } else {
            workbench_submissions::reconcile_shared(
                host,
                &scope.canonical_id,
                "areal/process/start",
                identity,
            )
            .await?
        };
        let result_val = if receipt["confirmed"] == true {
            if receipt.get("error").is_some() {
                return Ok(json!({ "confirmed": false }));
            }
            receipt["result"].clone()
        } else {
            let direct = process_rpc(
                host,
                &scope.canonical_id,
                lease,
                "areal/request/read",
                json!({ "requestId": req_id, "threadId": thread_id }),
            )
            .await;
            let Ok(read_res) = direct else {
                return Ok(json!({ "confirmed": false }));
            };
            let matched = read_res["data"].as_array().and_then(|rows| {
                rows.iter().find(|row| {
                    row["requestId"] == req_id
                        && row["method"] == "areal/process/start"
                        && row["status"] == "completed"
                })
            });
            match matched.and_then(|r| r.get("result")) {
                Some(res) => res.clone(),
                None => return Ok(json!({ "confirmed": false })),
            }
        };

        let Some(proc_id) = result_val["id"].as_str() else {
            return Ok(json!({ "confirmed": false }));
        };
        let processes = process_rpc(
            host,
            &scope.canonical_id,
            lease,
            "areal/process/list",
            json!({ "threadId": thread_id }),
        )
        .await?;
        let Some(process) = processes["data"].as_array().and_then(|rows| {
            rows.iter()
                .find(|item| item["id"].as_str() == Some(proc_id))
        }) else {
            return Ok(json!({ "confirmed": false }));
        };
        let has_handle = process.get("processId").is_some_and(|v| !v.is_null());
        let cleanup_confirmed = process["cleanupConfirmed"] == true;
        if !has_handle && !cleanup_confirmed {
            return Ok(json!({ "confirmed": false }));
        }
        if !cleanup_confirmed {
            process_rpc(
                host,
                &scope.canonical_id,
                lease,
                "areal/process/get",
                json!({ "threadId": thread_id, "id": proc_id }),
            )
            .await?;
        }
        let mut combined = result_val.as_object().cloned().unwrap_or_default();
        combined.insert("argv".into(), process["argv"].clone());
        combined.insert("closed".into(), json!(cleanup_confirmed));
        let controls = process["inputs"].as_array().map(|a| a.len()).unwrap_or(0);
        combined.insert("controls".into(), json!(controls));
        if let Some(shell) = shell_from_managed_argv(&process["argv"]) {
            combined.insert("shell".into(), json!(shell));
        }
        let presentation = resolve_terminal_presentation(&scope.home, host, source).await;
        if let Some(map) = presentation.as_object() {
            for (k, v) in map {
                combined.insert(k.clone(), v.clone());
            }
        }
        Ok(json!({
            "confirmed": true,
            "result": Value::Object(combined),
        }))
    }
}

#[cfg(test)]
#[path = "manage_service_tests.rs"]
mod tests;
