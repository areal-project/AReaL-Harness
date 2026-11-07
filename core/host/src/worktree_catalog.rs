//! Host 的跨项目工作树目录。项目内 Git 副作用由 Core 实现，资料库写入复用 Host 单写事务。
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{collections::BTreeSet, path::Path};

/// 直接读取既有项目登记，不维护第二份逻辑项目/执行项目映射。
pub(super) fn saved_projects(home: &Path) -> Result<Vec<Value>> {
    let Some(bytes) = crate::migration::read_bytes(&home.join("projects.json"))? else {
        return Ok(Vec::new());
    };
    ensure!(bytes.len() <= 8 * 1024 * 1024, "LIMIT_EXCEEDED");
    let rows: Vec<Value> = serde_json::from_slice(&bytes).context("invalid project directory")?;
    ensure!(rows.len() <= 65536, "LIMIT_EXCEEDED");
    let mut ids = BTreeSet::new();
    for row in &rows {
        let id = row["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .context("invalid project id")?;
        ensure!(ids.insert(id), "duplicate project id");
        ensure!(
            row["root"]
                .as_str()
                .is_some_and(|root| Path::new(root).is_absolute()),
            "invalid project root"
        );
        ensure!(
            row.get("logicalProjectId").is_none_or(Value::is_string),
            "invalid logical project id"
        );
        ensure!(
            row.get("projectless").is_none_or(Value::is_boolean),
            "invalid projectless flag"
        );
    }
    Ok(rows)
}

pub(super) fn owners(home: &Path, logical_id: &str) -> Result<Vec<Value>> {
    Ok(saved_projects(home)?.iter().filter(|row|row["id"]==logical_id||row["logicalProjectId"]==logical_id)
        .map(|row|json!({"id":row["id"],"root":row["root"],"logicalProjectId":row.get("logicalProjectId"),"projectless":row["projectless"]==true,"worktreeRequestId":row.get("worktreeRequestId")})).collect())
}

/// 只读旧生命周期记录，UNKNOWN 不触发重放。
pub(super) fn operations(home: &Path) -> Result<Vec<Value>> {
    let directory = home.join("worktree-requests");
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut rows = Vec::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let Some(id) = name.to_str().and_then(|name| name.strip_suffix(".json")) else {
            continue;
        };
        if uuid::Uuid::parse_str(id).is_err() {
            continue;
        }
        let bytes =
            crate::migration::read_bytes(&entry.path())?.context("worktree record disappeared")?;
        ensure!(bytes.len() <= 1024 * 1024, "LIMIT_EXCEEDED");
        let row: Value = serde_json::from_slice(&bytes)?;
        ensure!(
            row["requestId"] == id && row["projectId"].is_string() && row["state"].is_string(),
            "invalid worktree record"
        );
        rows.push(row);
        ensure!(rows.len() <= 65536, "LIMIT_EXCEEDED");
    }
    rows.sort_by(|a, b| a["requestId"].as_str().cmp(&b["requestId"].as_str()));
    Ok(rows)
}

use super::{Ensure, Host, Register};
use crate::{LaunchInputs, ProjectRegistration, ProjectSource};
use areal_local_service::storage;
use std::{collections::BTreeMap, path::PathBuf, rc::Rc};

fn library(home: &Path) -> Result<Value> {
    Ok(
        match crate::migration::read_bytes(&home.join("library.json"))? {
            Some(bytes) => serde_json::from_slice(&bytes)?,
            None => {
                json!({"projects":{},"threads":{},"settings":{},"projectOrder":[],"sections":[],"sidebarThreadOrder":[],"sidebarRevision":0})
            }
        },
    )
}
fn settings(value: &Value) -> Value {
    let mut settings = json!({"worktreeRoot":"","branchPrefix":"areal","fetchBeforeCreate":false,"autoCleanup":false,"keepCount":10});
    if let Some(saved) = value["settings"]["worktrees"].as_object() {
        settings.as_object_mut().unwrap().extend(saved.clone());
    }
    settings
}
fn environment_store(value: &Value, id: &str) -> Value {
    json!({"environments":value["projects"][id].get("worktreeEnvironments").cloned().unwrap_or(json!([])),
        "environmentRevision":value["projects"][id]["worktreeEnvironmentRevision"].as_u64().unwrap_or(0)})
}
fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .filter(|text| {
            !text.is_empty() && text.len() <= 4096 && !text.chars().any(char::is_control)
        })
        .context("INVALID_PARAMS")
}
fn stable_id(value: &str) -> String {
    let hash = storage::digest(value.as_bytes());
    format!(
        "{}-{}-4{}-a{}-{}",
        &hash[..8],
        &hash[8..12],
        &hash[13..16],
        &hash[17..20],
        &hash[20..32]
    )
}
fn source_projects(host: &Host, source: &str, home: &Path) -> Result<Vec<Value>> {
    let mut saved = saved_projects(home)?;
    if source == "host" {
        for slot in host.slots.borrow().values() {
            if !matches!(slot.registration.source, ProjectSource::Cli) {
                continue;
            }
            if !saved
                .iter()
                .any(|row| row["id"] == slot.registration.project_id)
            {
                saved.push(
                    json!({"id":slot.registration.project_id,"root":slot.registration.workspace}),
                );
            }
        }
    }
    Ok(saved)
}

fn merge_project_metadata(home: &Path, incoming: Value) -> Result<Value> {
    let id = required(&incoming, "id")?;
    let root = required(&incoming, "root")?;
    let mut rows = saved_projects(home)?;
    if let Some(existing) = rows.iter().find(|row| row["id"] == id) {
        ensure!(existing["root"] == root, "project alias cannot be rebound");
        if let Some(logical) = incoming.get("logicalProjectId") {
            ensure!(
                existing.get("logicalProjectId") == Some(logical),
                "worktree directory belongs to another logical project"
            );
        }
        return Ok(existing.clone());
    }
    rows.push(incoming.clone());
    storage::private_dir(home)?;
    crate::migration::atomic_bytes(&home.join("projects.json"), &serde_json::to_vec(&rows)?)?;
    Ok(incoming)
}

pub(super) async fn add_project(host: &Rc<Host>, source: &str, params: Value) -> Result<Value> {
    host.admission()?;
    ensure!(source != "host", "FORBIDDEN");
    let root = PathBuf::from(required(&params, "root")?).canonicalize()?;
    ensure!(root.is_dir(), "project root is not a directory");
    let alias = storage::digest(root.to_string_lossy().as_bytes())[..24].to_owned();
    let home = super::library_store::source_home(host, source)?;
    let profile = host.migration.source_profile(source)?;
    let mut row = json!({"id":alias,"root":root});
    for field in ["worktreeResources", "projectlessRequestId"] {
        if let Some(value) = params.get(field) {
            uuid::Uuid::parse_str(value.as_str().context("INVALID_PARAMS")?)?;
            row[field] = value.clone();
        }
    }
    if params.get("projectlessRequestId").is_some() {
        row["projectless"] = json!(true);
    }
    let project_id = stable_id(&format!("{source}:{alias}"));
    let default_binding = !host.slots.borrow().values().any(|slot| {
        slot.registration.workspace == root
            && slot.registration.default_binding
            && slot.registration.project_id != project_id
    });
    let registrations: Vec<_> = host
        .slots
        .borrow()
        .values()
        .map(|slot| slot.registration.clone())
        .collect();
    let matching: Vec<_> = host
        .migration
        .remote_bindings(source, &registrations)?
        .into_iter()
        .filter(|(_, name)| name == &alias)
        .collect();
    ensure!(matching.len() <= 1, "RESOURCE_UNAVAILABLE");
    if let Some((existing_id, _)) = matching.first() {
        let existing = registrations
            .iter()
            .find(|registration| &registration.project_id == existing_id)
            .context("RESOURCE_UNAVAILABLE")?;
        ensure!(
            existing.workspace == root,
            "project alias cannot be rebound"
        );
    } else {
        host.register(Register {
            bind_existing: false,
            request_id: stable_id(&format!("{source}:register:{alias}")),
            expected_generation: host.identity.generation.clone(),
            registration: ProjectRegistration {
                project_id,
                workspace: root,
                data_dir: home.join(&alias).join("state"),
                source: ProjectSource::Gui {
                    profile,
                    legacy_project_id: alias.clone(),
                },
                default_binding,
            },
        })
        .await?;
    }
    // 受理登记可 await；整表合并必须在它之后同步读最新文件，不能回写调用方旧快照。
    merge_project_metadata(&home, row)?;
    host.changed();
    Ok(json!({"projectId":alias}))
}
fn project(host: &Host, source: &str, alias: &str) -> Result<ProjectRegistration> {
    if source == "host" {
        return host
            .slots
            .borrow()
            .get(alias)
            .map(|slot| slot.registration.clone())
            .context("RESOURCE_UNAVAILABLE");
    }
    let registrations: Vec<_> = host
        .slots
        .borrow()
        .values()
        .map(|slot| slot.registration.clone())
        .collect();
    let matches: Vec<_> = host
        .migration
        .remote_bindings(source, &registrations)?
        .into_iter()
        .filter(|(_, name)| name == alias)
        .collect();
    ensure!(matches.len() == 1, "RESOURCE_UNAVAILABLE");
    registrations
        .into_iter()
        .find(|registration| registration.project_id == matches[0].0)
        .context("RESOURCE_UNAVAILABLE")
}
async fn request(host: &Rc<Host>, id: &str, method: &str, params: Value) -> Result<Value> {
    let connections = &host.schedules.connections;
    if connections.shared_identity(host, id).is_err() {
        host.ensure(Ensure {
            no_auto_restart: false,
            resume_scheduling: false,
            request_id: uuid::Uuid::new_v4().to_string(),
            expected_generation: host.identity.generation.clone(),
            project_id: id.into(),
            launch_inputs: None,
            credentials: BTreeMap::new(),
        })
        .await?;
    }
    let scope = connections.shared_identity(host, id)?;
    connections
        .remote_request(host, id, (&scope.0, &scope.1, &scope.2), method, params)
        .await
}
fn persist(home: &Path, value: &mut Value) -> Result<()> {
    let id = uuid::Uuid::parse_str(required(value, "requestId")?)?.to_string();
    let directory = home.join("worktree-requests");
    storage::private_dir(&directory)?;
    let path = directory.join(format!("{id}.json"));
    let current = crate::migration::read_bytes(&path)?
        .map(|bytes| serde_json::from_slice::<Value>(&bytes))
        .transpose()?;
    let expected = value["recordRevision"].as_u64().unwrap_or(0);
    let actual = current
        .as_ref()
        .and_then(|row| row["recordRevision"].as_u64())
        .unwrap_or(0);
    ensure!(
        expected == actual,
        "WORKTREE_RECORD_CONFLICT: original lifecycle changed; observe the original request"
    );
    value["recordRevision"] = json!(
        expected
            .checked_add(1)
            .context("worktree record revision exhausted")?
    );
    crate::migration::atomic_bytes(&path, &serde_json::to_vec(value)?)
}

fn record(home: &Path, id: &str, logical: &str) -> Result<Value> {
    let id = uuid::Uuid::parse_str(id)?.to_string();
    let path = home.join("worktree-requests").join(format!("{id}.json"));
    let value: Value = serde_json::from_slice(
        &crate::migration::read_bytes(&path)?.context("RESOURCE_UNAVAILABLE")?,
    )?;
    ensure!(value["projectId"] == logical, "FORBIDDEN");
    Ok(value)
}
fn event(value: &mut Value, state: &str) {
    value["state"] = json!(state);
    if !value["events"].is_array() {
        value["events"] = json!([]);
    }
    let id = value["requestId"].as_str().unwrap_or_default().to_owned();
    let rows = value["events"].as_array_mut().unwrap();
    rows.push(json!({"id":format!("{id}:{}",rows.len()),"state":state,"time":timestamp()}));
}
fn timestamp() -> String {
    chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now())
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn initial_checkout(value: &mut Value) {
    // 旧 checkout 只在 record 保存时间；首次纳入 Host 不能改变既有自动清理排序。
    if value["kind"] == "checkout" {
        value.as_object_mut().unwrap().remove("createdAt");
    }
}
fn cancel_transition(value: &mut Value) {
    let created = matches!(value["state"].as_str(), Some("created" | "failed"));
    event(value, "cancelled");
    if created {
        value["message"] = json!("创建已取消，目录保留");
        value["events"].as_array_mut().unwrap().last_mut().unwrap()["message"] =
            json!("创建已取消，目录保留");
    }
}
fn begin_cancel(value: &mut Value) -> bool {
    if value["state"] == "ready" {
        value["cancelResult"] = json!("tooLate");
        return false;
    }
    if value["state"] == "cancelled" {
        return false;
    }
    value["intent"] = json!("cancel");
    if value["state"] != "failed"
        || !matches!(
            value["setup"]["status"].as_str(),
            Some("running" | "unknown")
        )
    {
        cancel_transition(value);
    }
    true
}
fn open_record(value: &mut Value, execution: &str) {
    value["executionProjectId"] = json!(execution);
    value["kind"] = json!("thread");
    value["sourceRoot"] = value["record"]["target"].clone();
}

pub(super) async fn read(host: &Rc<Host>, source: &str, mut params: Value) -> Result<Value> {
    if let Some(object) = params.as_object_mut() {
        object.remove("sourceId");
    }
    let home = super::library_store::source_home(host, source)?;
    let library = library(&home)?;
    let rows = source_projects(host, source, &home)?;
    let default_root = host.home.join("worktrees");
    match required(&params, "operation")? {
        "worktreeList" => {
            let projects:Vec<_>=rows.iter().filter(|row|row.get("logicalProjectId").is_none_or(Value::is_null)).map(|row| {
                let id=row["id"].as_str().unwrap(); let mut project=json!({"id":id,"root":row["root"],"name":library["projects"][id].get("name").cloned().unwrap_or_else(||json!(Path::new(row["root"].as_str().unwrap()).file_name().unwrap_or_default().to_string_lossy()))});
                project.as_object_mut().unwrap().extend(environment_store(&library,id).as_object().unwrap().clone()); project
            }).collect();
            let worktrees: Vec<_> = operations(&home)?
                .into_iter()
                .filter(|row| row.get("record").is_some())
                .map(|mut row| {
                    row["directory"] = row["record"]["directory"].clone();
                    row["branch"] = row["record"]["branch"].clone();
                    row["deleted"] = json!(row["deleted"] == true);
                    row
                })
                .collect();
            Ok(
                json!({"settings":settings(&library),"defaultRoot":default_root,"revision":library["settings"]["worktreeRevision"].as_u64().unwrap_or(0),"projects":projects,"worktrees":worktrees}),
            )
        }
        "worktreeRead" => {
            let logical = required(&params, "projectId")?;
            let id = required(&params, "requestId")?;
            let canonical = uuid::Uuid::parse_str(id)?.to_string();
            if !home
                .join("worktree-requests")
                .join(format!("{canonical}.json"))
                .try_exists()?
            {
                return Ok(json!({"state":"missing"}));
            }
            let mut value = record(&home, id, logical)?;
            if matches!(
                value["setup"]["status"].as_str(),
                Some("running" | "unknown")
            ) {
                let script = value["setup"]["script"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                let request = value["setup"]["requestId"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                let _ = environment_attempt(
                    host, source, &home, &mut value, "setup", &script, None, &request, true,
                )
                .await?;
            }
            let git_unknown = matches!(value["state"].as_str(), Some("creating" | "unknown"))
                && value.get("bindingParams").is_none()
                && value.get("setup").is_none();
            if git_unknown
                || matches!(
                    value["deletion"]["status"].as_str(),
                    Some("running" | "unknown")
                )
            {
                let source_project = project(host, source, logical)?;
                if let Ok(observed) = request(
                    host,
                    &source_project.project_id,
                    "areal/worktree/read",
                    json!({"operation":"worktreeRead","requestId":id}),
                )
                .await
                {
                    if (git_unknown && observed["state"] == "created")
                        || observed["deleted"] == true
                    {
                        for key in [
                            "state",
                            "record",
                            "message",
                            "events",
                            "deleted",
                            "deletedAt",
                        ] {
                            if let Some(field) = observed.get(key) {
                                value[key] = field.clone();
                            }
                        }
                        if let Some(fields) = observed["deletion"].as_object() {
                            if !value["deletion"].is_object() {
                                value["deletion"] = json!({});
                            }
                            value["deletion"]
                                .as_object_mut()
                                .unwrap()
                                .extend(fields.clone());
                        }
                        persist(&home, &mut value)?;
                        host.changed();
                    }
                }
            }
            Ok(value)
        }
        "worktreeOptions" => {
            let alias = required(&params, "projectId")?.to_owned();
            let project = project(host, source, &alias)?;
            let mut value =
                request(host, &project.project_id, "areal/worktree/read", params).await?;
            value["settings"] = settings(&library);
            value["defaultRoot"] = json!(default_root);
            value.as_object_mut().context("INVALID_RESPONSE")?.extend(
                environment_store(&library, &alias)
                    .as_object()
                    .unwrap()
                    .clone(),
            );
            Ok(value)
        }
        _ => anyhow::bail!("INVALID_PARAMS"),
    }
}

pub(super) fn validate_admission(host: &Host, source: &str, params: &Value) -> Result<()> {
    if source != "host"
        || params["operation"] != "worktreeOpen"
        || params.get("agentProfile").is_some()
    {
        return Ok(());
    }
    let home = super::library_store::source_home(host, source)?;
    let creation =
        required(params, "worktreeRequestId").or_else(|_| required(params, "requestId"))?;
    let value = record(&home, creation, required(params, "projectId")?)?;
    if value["state"] == "ready" {
        return Ok(());
    }
    if !platform_script(&value["environment"]["setup"])?.is_empty()
        || !platform_script(&value["environment"]["cleanup"])?.is_empty()
        || value["environment"]["actions"]
            .as_array()
            .is_some_and(|actions| !actions.is_empty())
    {
        return Err(crate::wire::error(
            "ENVIRONMENT_PROFILE_REQUIRED",
            "worktree environment processes require an explicit authorized --agent id@revision and trusted --allow-concurrent-writes launch configuration",
        ));
    }
    Ok(())
}

pub(super) async fn command(host: &Rc<Host>, source: &str, mut params: Value) -> Result<Value> {
    host.admission()?;
    let home = super::library_store::source_home(host, source)?;
    let operation = required(&params, "operation")?.to_owned();
    if operation == "worktreeSettings" || operation.starts_with("worktreeEnvironment") {
        let value =
            super::library_store::change(host, source, |state| preference_change(state, &params))?;
        return Ok(if operation == "worktreeSettings" {
            settings(&value)
        } else {
            environment_store(&value, required(&params, "projectId")?)
        });
    }
    let alias = required(&params, "projectId")?.to_owned();
    let source_project = project(host, source, &alias)?;
    let id = uuid::Uuid::parse_str(required(&params, "requestId")?)?.to_string();
    match operation.as_str() {
        "worktreeCreate" => {
            let library = library(&home)?;
            let mut parameters = json!({"source":params["source"].as_str().unwrap_or("head")});
            for key in ["sourceRoot", "worktreeRoot", "branch", "branchPrefix"] {
                if let Some(value) = params.get(key) {
                    parameters[key] = value.clone();
                }
            }
            if params["source"] == "branch" {
                if let Some(value) = params.get("ref") {
                    parameters["ref"] = value.clone();
                }
            }
            if let Ok(original) = record(&home, &id, &alias) {
                ensure!(original["parameters"] == parameters, "COMMAND_CONFLICT");
                return Ok(original);
            }
            let selected_environment = if let Some(id) = params["environmentId"].as_str() {
                Some(
                    library["projects"][&alias]["worktreeEnvironments"]
                        .as_array()
                        .context("environment unavailable")?
                        .iter()
                        .find(|environment| environment["id"] == id)
                        .context("environment unavailable")?
                        .clone(),
                )
            } else {
                None
            };
            let environment_revision = library["projects"][&alias]["worktreeEnvironmentRevision"]
                .as_u64()
                .unwrap_or(0);
            let configured = settings(&library);
            for key in ["branchPrefix", "fetchBeforeCreate"] {
                if params.get(key).is_none() {
                    params[key] = configured[key].clone();
                }
            }
            if params["worktreeRoot"].as_str().is_none_or(str::is_empty) {
                let base = configured["worktreeRoot"]
                    .as_str()
                    .filter(|root| !root.is_empty())
                    .map(PathBuf::from)
                    .unwrap_or_else(|| host.home.join("worktrees"));
                let name = source_project
                    .workspace
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .chars()
                    .map(|c| {
                        if c.is_ascii_alphanumeric() || matches!(c, '_' | '-') {
                            c
                        } else {
                            '-'
                        }
                    })
                    .take(60)
                    .collect::<String>();
                params["worktreeRoot"] = json!(base.join(format!(
                    "{}-{}",
                    if name.is_empty() { "project" } else { &name },
                    &storage::digest(source_project.workspace.to_string_lossy().as_bytes())[..12]
                )));
            }
            params.as_object_mut().unwrap().remove("sourceId");
            let mut value = request(
                host,
                &source_project.project_id,
                "areal/worktree/command",
                params,
            )
            .await?;
            ensure!(
                value["requestId"] == id && value["projectId"] == alias,
                "INVALID_RESPONSE"
            );
            value["parameters"] = parameters;
            if let Some(environment) = selected_environment {
                value["environment"] = environment;
                value["environmentRevision"] = json!(environment_revision);
            }
            initial_checkout(&mut value);
            persist(&home, &mut value)?;
            host.changed();
            Ok(value)
        }
        "worktreeCancel" => {
            let creation = required(&params, "worktreeRequestId")
                .or_else(|_| required(&params, "requestId"))?;
            let mut value = record(&home, creation, &alias)?;
            if !begin_cancel(&mut value) {
                return Ok(value);
            }
            if value["setup"]["status"] == "running" || value["setup"]["status"] == "unknown" {
                if let (Some(execution), Some(thread), Some(process)) = (
                    value["executionProjectId"].as_str().map(str::to_owned),
                    value["threadId"].as_str().map(str::to_owned),
                    value["setup"]["processId"].as_str().map(str::to_owned),
                ) {
                    let target = project(host, source, &execution)?;
                    value["setup"]["terminateRequestId"] = json!(id);
                    persist(&home, &mut value)?;
                    let _ = request(
                        host,
                        &target.project_id,
                        "areal/process/terminate",
                        json!({"requestId":id,"threadId":thread,"id":process}),
                    )
                    .await;
                }
            }
            persist(&home, &mut value)?;
            host.changed();
            Ok(value)
        }
        "worktreeOpen" => {
            let creation = required(&params, "worktreeRequestId")
                .or_else(|_| required(&params, "requestId"))?;
            let mut value = record(&home, creation, &alias)?;
            if value["state"] == "ready" {
                return Ok(
                    json!({"projectId":alias,"threadId":value["threadId"],"root":value["record"]["directory"]}),
                );
            }
            ensure!(value["state"] == "created", "SUBMISSION_UNKNOWN");
            let target = register_target(host, source, &alias, &home, &mut value, &id).await?;
            let root = PathBuf::from(required(&target, "root")?);
            let mut binding = json!({"requestId":creation,"cwd":root,"dynamicTools":[]});
            if let Some(profile) = params.get("agentProfile") {
                let reference: areal_protocol::desktop::VersionRef =
                    serde_json::from_value(profile.clone())?;
                binding["agentProfile"] = serde_json::to_value(reference)?;
            }
            let result = bind_thread_target(host, source, &alias, creation, binding).await?;
            let mut finished = record(&home, creation, &alias)?;
            if finished["state"] != "ready" {
                return Ok(finished);
            }
            finished["parameters"] = json!({});
            persist(&home, &mut finished)?;
            Ok(
                json!({"projectId":alias,"root":root,"threadId":result["threadId"],"requestId":creation}),
            )
        }

        "worktreeDelete" => {
            let creation = required(&params, "worktreeRequestId")?.to_owned();
            let mut value = record(&home, &creation, &alias)?;
            if value["deleted"] == true {
                return Ok(value);
            }
            ensure!(
                value["usesSource"] != true && value["executionProjectId"] != value["projectId"],
                "cannot delete source workspace"
            );
            if let Some(original) = value.get("deletion") {
                if original["requestId"] == id
                    || matches!(original["status"].as_str(), Some("running" | "unknown"))
                {
                    return Ok(value);
                }
            }
            value["deletion"] = json!({"requestId":id,"status":"running","blockers":[],"stopRequestId":stable_id(&format!("{id}:stop"))});
            persist(&home, &mut value)?;
            let mut dispatched = false;
            let outcome = async {
                request(host,&source_project.project_id,"areal/worktree/read",json!({"operation":"worktreeInspect","requestId":creation,"legacyOperation":value,"allowDirty":true})).await?;
                if let Some(execution_alias) = value["executionProjectId"].as_str().map(str::to_owned) {
                    let execution = project(host, source, &execution_alias)?;
                    let status = request(
                        host,
                        &execution.project_id,
                        "areal/server/status",
                        json!({}),
                    )
                    .await?;
                    for key in [
                        "activeTurns",
                        "resources",
                        "unresolvedTools",
                        "activeGoals",
                        "compactions",
                        "workgroups",
                    ] {
                        ensure!(
                            status[key].as_array().is_some_and(Vec::is_empty),
                            "worktree has active or unconfirmed resources"
                        );
                    }
                    ensure!(
                        status["activeTasks"] == 0 && status["pendingQueueItems"] == 0,
                        "worktree has active tasks or queued messages"
                    );
                    let (_, journal) = host.journal.native_snapshot(&execution.project_id)?;
                    ensure!(
                        journal["pending"].as_array().is_some_and(Vec::is_empty),
                        "worktree has unconfirmed submissions"
                    );
                    let mut after = Value::Null;
                    for page in 0..1000 {
                        let mut args = json!({"limit":100});
                        if !after.is_null() {
                            args["after"] = after.clone();
                        }
                        let tasks =
                            request(host, &execution.project_id, "areal/task/list", args).await?;
                        ensure!(
                            tasks["data"].as_array().is_some_and(|rows| rows.iter().all(
                                |task| matches!(
                                    task.get("status")
                                        .or_else(|| task.get("state"))
                                        .and_then(Value::as_str),
                                    Some("completed" | "cancelled" | "failed")
                                )
                            )),
                            "worktree has unfinished tasks"
                        );
                        let next = tasks
                            .get("nextCursor")
                            .context("task pagination unavailable")?;
                        if next.is_null() {
                            break;
                        }
                        ensure!(*next != after && page < 999, "incomplete task catalog");
                        after = next.clone();
                    }
                    let cleanup = platform_script(&value["environment"]["cleanup"])?;
                    if !cleanup.is_empty() {
                        let attempt = environment_attempt(
                            host,
                            source,
                            &home,
                            &mut value,
                            "cleanup",
                            &cleanup,
                            None,
                            &stable_id(&format!("{id}:cleanup")),
                            false,
                        )
                        .await?;
                        ensure!(
                            attempt["status"] == "succeeded",
                            "worktree cleanup remains unconfirmed"
                        );
                    }
                    let status_after = request(
                        host,
                        &execution.project_id,
                        "areal/server/status",
                        json!({}),
                    )
                    .await?;
                    for key in [
                        "activeTurns",
                        "resources",
                        "unresolvedTools",
                        "activeGoals",
                        "compactions",
                        "workgroups",
                    ] {
                        ensure!(
                            status_after[key].as_array().is_some_and(Vec::is_empty),
                            "worktree has active or unconfirmed resources after cleanup"
                        );
                    }
                    ensure!(
                        status_after["activeTasks"] == 0 && status_after["pendingQueueItems"] == 0,
                        "worktree has tasks or queued messages after cleanup"
                    );
                    let service = host
                        .slots
                        .borrow()
                        .get(&execution.project_id)
                        .and_then(|slot| slot.service.clone())
                        .context("RESOURCE_UNAVAILABLE")?;
                    let desktop_generation = deletion_generation(host, source).await?;
                    let stop_id = stable_id(&format!("{id}:stop"));
                    let mut target = json!({"projectId":execution_alias,"serviceId":service.identity.service_id,"generation":service.identity.generation,"dataDir":execution.data_dir,"requestId":stop_id,"phase":"acceptedPending"});
                    dispatched = true;
                    let operation = host
                        .stop_project(super::Stop {
                            request_id: stop_id.clone(),
                            expected_generation: host.identity.generation.clone(),
                            strategy: crate::StopStrategy::IfIdle,
                            suppress_scheduling: true,
                            project_id: Some(execution.project_id.clone()),
                            service_generation: Some(service.identity.generation),
                        })
                        .await?;
                    dispatched = false;
                    ensure!(operation["projectId"] == execution.project_id, "LIFECYCLE_RECEIPT_INVALID");
                    super::workbench_lifecycle::host_receipt(&mut target, &operation, false)?;
                    let receipt = deletion_stop_receipt(&stop_id, &desktop_generation, &host.home, target)?;
                    value["deletion"]["stopReceipt"] = receipt.clone();
                    persist(&home, &mut value)?;
                    ensure!(
                        receipt["phase"] == "completed",
                        "worktree Core stop remains unconfirmed"
                    );
                }
                params["legacyOperation"] = value.clone();
                dispatched = true;
                let observed = request(
                    host,
                    &source_project.project_id,
                    "areal/worktree/command",
                    params,
                )
                .await?;
                dispatched = false;
                for key in ["deleted", "deletedAt"] {
                    if let Some(field) = observed.get(key) {
                        value[key] = field.clone();
                    }
                }
                if let Some(deletion) = observed["deletion"].as_object() {
                    value["deletion"]
                        .as_object_mut()
                        .unwrap()
                        .extend(deletion.clone());
                }
                Ok::<(), anyhow::Error>(())
            }
            .await;
            if let Err(error) = outcome {
                let uncertain = dispatched
                    || value["cleanup"]["status"] == "unknown"
                    || value["deletion"]["stopReceipt"]
                        .get("phase")
                        .is_some_and(|state| state != "completed")
                    || error.to_string().contains("SUBMISSION_UNKNOWN");
                value["deletion"]["status"] = json!(if uncertain { "unknown" } else { "blocked" });
                value["deletion"]["blockers"] = json!([error.to_string()]);
            }
            persist(&home, &mut value)?;
            host.changed();
            Ok(value)
        }
        "worktreeAction" => {
            let creation = required(&params, "worktreeRequestId")?;
            let mut value = record(&home, creation, &alias)?;
            ensure!(
                value["state"] == "ready" && value["deleted"] != true,
                "worktree environment unavailable"
            );
            let action = required(&params, "actionId")?;
            let definition = value["environment"]["actions"]
                .as_array()
                .context("environment actions unavailable")?
                .iter()
                .find(|item| item["id"] == action)
                .context("environment action unavailable")?
                .clone();
            let script = platform_script(&definition["script"])?;
            ensure!(
                !script.is_empty(),
                "environment action unavailable on this platform"
            );
            environment_attempt(
                host,
                source,
                &home,
                &mut value,
                "actions",
                &script,
                Some(action),
                &id,
                false,
            )
            .await
        }
        _ => anyhow::bail!("unsupported worktree operation"),
    }
}

fn preference_change(state: &mut Value, params: &Value) -> Result<()> {
    if !state["settings"].is_object() {
        state["settings"] = json!({});
    }
    match required(params, "operation")? {
        "worktreeSettings" => {
            let revision = state["settings"]["worktreeRevision"].as_u64().unwrap_or(0);
            ensure!(
                params
                    .get("expectedRevision")
                    .is_none_or(|value| value.as_u64() == Some(revision)),
                "settings revision conflict"
            );
            let root = params["worktreeRoot"]
                .as_str()
                .context("invalid worktree root")?;
            ensure!(
                root.is_empty()
                    || (Path::new(root).is_absolute()
                        && !Path::new(root).components().any(|part| matches!(
                            part,
                            std::path::Component::ParentDir | std::path::Component::CurDir
                        ))),
                "invalid worktree root"
            );
            if !root.is_empty() {
                safe_parents(Path::new(root))?;
            }
            let prefix = required(params, "branchPrefix")?;
            ensure!(
                prefix.len() <= 120
                    && !prefix.starts_with('-')
                    && !prefix.contains("..")
                    && !prefix.ends_with('/')
                    && !prefix.contains("//")
                    && prefix
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/')),
                "invalid branch prefix"
            );
            let mut next = settings(state);
            for key in [
                "worktreeRoot",
                "branchPrefix",
                "fetchBeforeCreate",
                "autoCleanup",
                "keepCount",
            ] {
                if let Some(value) = params.get(key) {
                    next[key] = value.clone();
                }
            }
            ensure!(
                next["fetchBeforeCreate"].is_boolean()
                    && next["autoCleanup"].is_boolean()
                    && next["keepCount"]
                        .as_u64()
                        .is_some_and(|n| (1..=1000).contains(&n)),
                "invalid worktree settings"
            );
            state["settings"]["worktrees"] = next;
            state["settings"]["worktreeRevision"] = json!(revision + 1);
        }
        "worktreeEnvironmentSave" | "worktreeEnvironmentDelete" => {
            let id = required(params, "projectId")?;
            if !state["projects"].is_object() {
                state["projects"] = json!({});
            }
            if !state["projects"][id].is_object() {
                state["projects"][id] = json!({});
            }
            let meta = &mut state["projects"][id];
            let revision = meta["worktreeEnvironmentRevision"].as_u64().unwrap_or(0);
            ensure!(
                params["expectedRevision"].as_u64() == Some(revision),
                "environment revision conflict"
            );
            let remove = params["operation"] == "worktreeEnvironmentDelete";
            let environment = &params["environment"];
            let environment_id = if remove {
                required(params, "environmentId")?
            } else {
                required(environment, "id")?
            };
            if !remove {
                required(environment, "name")?;
                for key in ["setup", "cleanup"] {
                    validate_script(&environment[key])?;
                }
                let actions = environment["actions"]
                    .as_array()
                    .context("invalid environment actions")?;
                ensure!(actions.len() <= 100, "too many environment actions");
                let mut ids = BTreeSet::new();
                for action in actions {
                    ensure!(ids.insert(required(action, "id")?), "duplicate action id");
                    required(action, "name")?;
                    validate_script(&action["script"])?;
                }
            }
            let mut environments = meta["worktreeEnvironments"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            environments.retain(|row| row["id"] != environment_id);
            if !remove {
                environments.push(environment.clone());
            }
            meta["worktreeEnvironments"] = json!(environments);
            meta["worktreeEnvironmentRevision"] = json!(revision + 1);
        }
        _ => anyhow::bail!("INVALID_PARAMS"),
    }
    Ok(())
}
fn validate_script(value: &Value) -> Result<()> {
    let object = value.as_object().context("invalid environment script")?;
    ensure!(
        object
            .keys()
            .all(|key| matches!(key.as_str(), "default" | "macos" | "linux"))
            && value["default"].is_string(),
        "invalid environment script"
    );
    ensure!(
        object.values().all(|value| value
            .as_str()
            .is_some_and(|text| text.len() <= 65536 && !text.contains('\0'))),
        "invalid environment script"
    );
    Ok(())
}

async fn deletion_generation(host: &Rc<Host>, source: &str) -> Result<String> {
    if source == "host" {
        return Ok(host.identity.generation.clone());
    }
    if host.gateway.workbench.rust_domain("execution-rust", source) {
        return super::workbench_lifecycle::current_generation(source)
            .context("CAPABILITY_UNAVAILABLE");
    }
    let owner = host
        .gateway
        .workbench
        .worktree_backend_identity(source)
        .context("CAPABILITY_UNAVAILABLE")?;
    let dependencies = host
        .gateway
        .workbench
        .backend_private("lifecycle.dependencies", json!({}))
        .await?;
    ensure!(
        host.gateway
            .workbench
            .worktree_backend_identity(source)
            .as_ref()
            == Some(&owner),
        "RESYNC_REQUIRED"
    );
    let generation = required(&dependencies, "lifecycleGeneration")?;
    uuid::Uuid::parse_str(generation).context("LIFECYCLE_RECEIPT_INVALID")?;
    Ok(generation.to_owned())
}

fn deletion_stop_receipt(
    request: &str,
    generation: &str,
    home: &Path,
    target: Value,
) -> Result<Value> {
    let value = json!({"version":1,"requestId":request,"desktopGeneration":generation,"kind":"stopProject","mode":"ifIdle","targets":[target.clone()],"phase":target["phase"],"desktopExit":"notRequested","sharedHost":true,"harnessHome":home});
    serde_json::from_value::<areal_protocol::host::WorkbenchLifecycleReceipt>(value.clone())
        .context("LIFECYCLE_RECEIPT_INVALID")?;
    Ok(value)
}

fn platform_script(value: &Value) -> Result<String> {
    if value.is_null() {
        return Ok(String::new());
    }
    validate_script(value)?;
    let platform = if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    Ok(value[platform]
        .as_str()
        .filter(|script| !script.trim().is_empty())
        .or_else(|| value["default"].as_str())
        .unwrap_or_default()
        .to_owned())
}
fn attempt_slot<'a>(value: &'a mut Value, slot: &str, id: &str) -> &'a mut Value {
    if slot == "actions" {
        if !value["actions"].is_object() {
            value["actions"] = json!({});
        }
        &mut value["actions"][id]
    } else {
        &mut value[slot]
    }
}
async fn environment_attempt(
    host: &Rc<Host>,
    source: &str,
    home: &Path,
    value: &mut Value,
    slot: &str,
    script: &str,
    action: Option<&str>,
    id: &str,
    observe_only: bool,
) -> Result<Value> {
    let execution_alias = required(value, "executionProjectId")?.to_owned();
    let thread = required(value, "threadId")?.to_owned();
    let execution = project(host, source, &execution_alias)?;
    let mut attempt = attempt_slot(value, slot, id).clone();
    if matches!(
        attempt["status"].as_str(),
        Some("succeeded" | "failed" | "cancelled")
    ) {
        return Ok(attempt);
    }
    if !attempt.is_object() {
        ensure!(!observe_only, "SUBMISSION_UNKNOWN");
        attempt = json!({"requestId":id,"kind":if slot=="actions"{"action"}else{slot},"script":script,"status":"running","startedAt":timestamp(),"timeoutMs":600000,"output":""});
        if let Some(action) = action {
            attempt["actionId"] = json!(action);
        }
        *attempt_slot(value, slot, id) = attempt.clone();
        persist(home, value)?;
        let source_project = project(host, source, required(value, "projectId")?)?;
        let argv = json!([
            "/usr/bin/env",
            format!(
                "AREAL_WORKTREE_PATH={}",
                required(&value["record"], "directory")?
            ),
            format!("AREAL_PROJECT_PATH={}", source_project.workspace.display()),
            format!(
                "AREAL_WORKTREE_BRANCH={}",
                required(&value["record"], "branch")?
            ),
            "/bin/sh",
            "-c",
            script
        ]);
        match request(host,&execution.project_id,"areal/process/start",json!({"requestId":id,"threadId":thread,"lifetime":"thread","cwd":execution.workspace,"argv":argv,"timeoutMs":600000})).await {
            Ok(receipt)=>{attempt["processId"]=receipt["id"].clone();attempt["receipt"]=receipt;},
            Err(error)=>{
                if let Some(failure) = error.downcast_ref::<crate::server::schedule_connection::RpcFailure>().filter(|failure| matches!(failure.0["data"]["outcome"]["kind"].as_str(), Some("rejected" | "noMutation"))) {
                    attempt["status"]=json!("failed");
                    attempt["admissionState"]=json!("rejected");
                    attempt["error"]=failure.0.clone();
                    attempt["finishedAt"]=json!(timestamp());
                    *attempt_slot(value, slot, id)=attempt.clone();
                    if slot == "setup" { event(value,"failed"); }
                    persist(home,value)?;
                    host.changed();
                    return Ok(attempt);
                }
                if let Some(failure) = error.downcast_ref::<crate::server::schedule_connection::RpcFailure>() {
                    attempt["error"] = failure.0.clone();
                }
                attempt["status"]=json!("unknown");attempt["message"]=json!(error.to_string());
            },
        }
        *attempt_slot(value, slot, id) = attempt.clone();
        persist(home, value)?;
    }
    if attempt["processId"].as_str().is_none() {
        let receipts = request(
            host,
            &execution.project_id,
            "areal/request/read",
            json!({"threadId":thread,"requestId":id}),
        )
        .await?;
        if let Some(receipt) = receipt_result(&receipts, id, "areal/process/start", Some(&thread)) {
            if receipt["id"].is_string() {
                attempt["processId"] = receipt["id"].clone();
                attempt["receipt"] = receipt;
                attempt["status"] = json!("running");
            }
        }
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(615000);
    if let Some(process) = attempt["processId"].as_str().map(str::to_owned) {
        loop {
            let target = json!({"threadId":thread,"id":process});
            let observed = request(
                host,
                &execution.project_id,
                "areal/process/get",
                target.clone(),
            )
            .await?;
            let output=request(host,&execution.project_id,"areal/process/read",json!({"threadId":thread,"id":process,"after":attempt.get("cursor"),"maxBytes":65536,"waitMs":0})).await?;
            let mut text = attempt["output"].as_str().unwrap_or_default().to_owned();
            if let Some(chunks) = output["chunks"].as_array() {
                use base64::Engine;
                for chunk in chunks {
                    if let Some(bytes) = chunk["dataBase64"].as_str() {
                        text.push_str(&String::from_utf8_lossy(
                            &base64::engine::general_purpose::STANDARD.decode(bytes)?,
                        ));
                    }
                }
            }
            let truncated = text.len() > 65536;
            if truncated {
                let mut start = text.len() - 65536;
                while !text.is_char_boundary(start) {
                    start += 1;
                }
                text = text[start..].to_owned();
            }
            attempt["output"] = json!(text);
            attempt["cursor"] = output["nextCursor"].clone();
            attempt["outputTruncated"] = json!(
                attempt["outputTruncated"] == true
                    || truncated
                    || output["gap"] == true
                    || output["truncated"] == true
            );
            attempt["runtime"] = observed["runtime"].clone();
            attempt["managed"] = observed["process"].clone();
            if observed["runtime"]["state"] == "exited"
                && observed["runtime"]["cleanupConfirmed"] == true
            {
                if !observe_only && observed["process"]["cleanupConfirmed"] != true {
                    let close = stable_id(&format!("{id}:close"));
                    attempt["closeRequestId"] = json!(close);
                    *attempt_slot(value, slot, id) = attempt.clone();
                    persist(home, value)?;
                    let _ = request(
                        host,
                        &execution.project_id,
                        "areal/process/terminate",
                        json!({"threadId":thread,"id":process,"requestId":close}),
                    )
                    .await;
                    let closed =
                        request(host, &execution.project_id, "areal/process/get", target).await?;
                    attempt["managed"] = closed["process"].clone();
                }
                attempt["status"] = json!(if attempt["managed"]["cleanupConfirmed"] != true {
                    "unknown"
                } else if value["intent"] == "cancel" && slot == "setup" {
                    "cancelled"
                } else if observed["runtime"]["exitCode"] == 0
                    && observed["runtime"]["stopReason"].is_null()
                {
                    "succeeded"
                } else {
                    "failed"
                });
                attempt["finishedAt"] = json!(timestamp());
                attempt["exitCode"] = observed["runtime"]["exitCode"].clone();
            } else if observed["runtime"]["state"] == "unknown"
                || observed["process"]["state"] == "unknown"
            {
                attempt["status"] = json!("unknown");
            }
            *attempt_slot(value, slot, id) = attempt.clone();
            if slot == "setup"
                && matches!(
                    attempt["status"].as_str(),
                    Some("succeeded" | "failed" | "cancelled")
                )
            {
                event(
                    value,
                    if attempt["status"] == "succeeded" {
                        "ready"
                    } else if attempt["status"] == "cancelled" {
                        "cancelled"
                    } else {
                        "failed"
                    },
                );
            }
            persist(home, value)?;
            host.changed();
            if slot == "setup" && attempt["status"] == "succeeded" {
                host.gateway
                    .workbench
                    .schedule_worktree_cleanup(host, source);
            }
            if observe_only
                || matches!(
                    attempt["status"].as_str(),
                    Some("succeeded" | "failed" | "cancelled" | "unknown")
                )
            {
                break;
            }
            if std::time::Instant::now() >= deadline {
                attempt["status"] = json!("unknown");
                attempt["message"] = json!("环境脚本超时后的清理结果尚未确认");
                *attempt_slot(value, slot, id) = attempt.clone();
                persist(home, value)?;
                break;
            }
            request(
                host,
                &execution.project_id,
                "areal/process/wait",
                json!({"threadId":thread,"id":process,"timeoutMs":30000}),
            )
            .await?;
        }
    }
    Ok(attempt)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn thread_checkout_empty_options_match_legacy_defaults() {
        let empty = json!({"mode":"worktree","sourceRoot":"","ref":"","branch":"","worktreeRoot":"","environmentId":""});
        assert_eq!(
            thread_checkout_params("project", "request", &empty).unwrap(),
            json!({"operation":"worktreeCreate","projectId":"project","requestId":"request","source":"head"})
        );
        let mut selected = empty;
        selected["ref"] = json!("release/acceptance");
        selected["environmentId"] = json!("acceptance");
        let params = thread_checkout_params("project", "request", &selected).unwrap();
        assert_eq!(params["source"], "branch");
        assert_eq!(params["ref"], "release/acceptance");
        assert_eq!(params["environmentId"], "acceptance");
        assert!(
            params.get("branch").is_none(),
            "UI空分支必须让Core使用配置前缀生成原request分支"
        );
        assert!(params.get("worktreeRoot").is_none());
        selected["branch"] = json!("feature/explicit");
        selected["worktreeRoot"] = json!("/isolated/trees");
        let params = thread_checkout_params("project", "request", &selected).unwrap();
        assert_eq!(params["branch"], "feature/explicit");
        assert_eq!(params["worktreeRoot"], "/isolated/trees");
        selected["branch"] = json!(" ");
        assert_eq!(
            thread_checkout_params("project", "request", &selected).unwrap()["branch"],
            " ",
            "不修正或放宽显式无效分支"
        );
        selected["branch"] = json!(42);
        assert!(thread_checkout_params("project", "request", &selected).is_err());
    }
    #[test]
    fn checkout_receipt_keeps_legacy_fields_and_cleanup_order() {
        let mut checkout = json!({"kind":"checkout","requestId":"checkout","projectId":"source","parameters":{},"state":"created","createdAt":"2030-01-01T00:00:00.000Z","record":{"createdAt":"2030-01-01T00:00:00.000Z","target":"/source","directory":"/checkout"},"events":[{"id":"checkout:0","state":"created","time":"2030-01-01T00:00:00.000Z"}],"recordRevision":1});
        initial_checkout(&mut checkout);
        assert!(checkout.get("createdAt").is_none());
        assert_eq!(checkout["record"]["createdAt"], "2030-01-01T00:00:00.000Z");
        assert_eq!(checkout["recordRevision"], 1);
        let mut retained = vec![
            json!({"requestId":"thread","createdAt":"2020-01-01T00:00:00.000Z"}),
            checkout.clone(),
        ];
        retained.sort_by(|a, b| a["createdAt"].as_str().cmp(&b["createdAt"].as_str()));
        assert_eq!(
            retained[0]["requestId"], "checkout",
            "旧 checkout 缺省时间不能变成比现有 thread 更新"
        );
        cancel_transition(&mut checkout);
        assert_eq!(checkout["message"], "创建已取消，目录保留");
        assert_eq!(checkout["events"][1]["message"], checkout["message"]);
        assert_eq!(checkout["events"][0]["state"], "created");
        open_record(&mut checkout, "execution");
        assert_eq!(checkout["sourceRoot"], "/source");
        assert_ne!(checkout["sourceRoot"], checkout["record"]["directory"]);
        assert_eq!(checkout["kind"], "thread");
        assert_eq!(checkout["executionProjectId"], "execution");
        let mut thread = json!({"kind":"thread","createdAt":"2020-01-01T00:00:00.000Z"});
        initial_checkout(&mut thread);
        assert_eq!(thread["createdAt"], "2020-01-01T00:00:00.000Z");
    }
    #[test]
    fn cancellation_terminal_states_match_legacy_oracle() {
        for state in ["created", "failed"] {
            let original = json!({"state":state,"requestId":"request","recordRevision":7,"events":[{"state":state,"id":"request:0","time":"original"}]});
            let mut value = original.clone();
            assert!(begin_cancel(&mut value));
            assert_eq!(value["state"], "cancelled");
            assert_eq!(value["intent"], "cancel");
            assert_eq!(value["message"], "创建已取消，目录保留");
            assert_eq!(value["events"][0], original["events"][0]);
            assert_eq!(value["events"][1]["message"], value["message"]);
            assert_eq!(value["recordRevision"], 7);
        }
        let original = json!({"state":"ready","intent":"continue","recordRevision":7,"events":[]});
        let mut ready = original.clone();
        assert!(!begin_cancel(&mut ready));
        ready.as_object_mut().unwrap().remove("cancelResult");
        assert_eq!(ready, original, "太晚取消不得持久修改 intent 或日志");
        let mut ready = original;
        assert!(!begin_cancel(&mut ready));
        assert_eq!(ready["cancelResult"], "tooLate");
        let original =
            json!({"state":"cancelled","intent":"cancel","recordRevision":7,"events":[]});
        let mut cancelled = original.clone();
        assert!(!begin_cancel(&mut cancelled));
        assert_eq!(cancelled, original);
        let mut active = json!({"state":"failed","setup":{"status":"running"},"events":[]});
        assert!(begin_cancel(&mut active));
        assert_eq!(active["state"], "failed", "活动 setup 仍须走原进程终止确认");
        assert_eq!(active["events"], json!([]));
    }
    #[test]
    fn deletion_receipt_survives_desktop_restart_and_keeps_unknown_phase() {
        let request = "11111111-1111-4111-8111-111111111111";
        let node = std::env::var_os("AREAL_GUI_NODE_BIN").unwrap_or_else(|| "node".into());
        for (state, phase) in [
            ("completed", "completed"),
            ("admissionUnknown", "admissionUnconfirmed"),
        ] {
            let home = tempfile::tempdir().unwrap();
            let operation = json!({"version":1,"projectId":"canonical","requestId":request,"serviceId":"core","serviceGeneration":"generation","strategy":"ifIdle","state":state});
            let mut target = json!({"projectId":"execution-alias","requestId":request,"serviceId":"core","generation":"generation","dataDir":home.path().join("execution/state")});
            super::super::workbench_lifecycle::host_receipt(&mut target, &operation, false)
                .unwrap();
            let receipt =
                deletion_stop_receipt(request, "desktop-owner", home.path(), target).unwrap();
            assert_eq!(receipt["phase"], phase);
            assert_eq!(
                receipt["targets"][0]["dataDir"],
                json!(home.path().join("execution/state"))
            );
            assert_eq!(receipt["targets"][0]["hostReceipt"]["requestId"], request);
            assert_eq!(
                receipt["targets"][0]["hostReceipt"]["serviceGeneration"],
                "generation"
            );
            let mut value = json!({"kind":"thread","requestId":request,"projectId":"logical","parameters":{},"state":"ready","deletion":{"requestId":request,"status":if state=="completed"{"succeeded"}else{"unknown"},"stopRequestId":request,"stopReceipt":receipt}});
            persist(home.path(), &mut value).unwrap();
            let path = home
                .path()
                .join("worktree-requests")
                .join(format!("{request}.json"));
            assert_eq!(
                record(home.path(), request, "logical").unwrap()["deletion"]["stopReceipt"]["phase"],
                phase
            );
            let result = std::process::Command::new(&node).current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
                .arg("-e").arg("const fs=require('node:fs');const {readOperation}=require('./clients/gui/packages/workbench/client/desktop-contract/workspace-worktrees.cjs');readOperation(JSON.parse(fs.readFileSync(process.argv[1],'utf8')));").arg(path).output();
            match result {
                Ok(output) => assert!(
                    output.status.success(),
                    "desktop decoder rejected persisted {phase}: {}",
                    String::from_utf8_lossy(&output.stderr)
                ),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => eprintln!(
                    "desktop decoder not run: Node unavailable; Rust receipt schema/persistence checked"
                ),
                Err(error) => panic!("desktop decoder failed: {error}"),
            }
            let mut changed = operation;
            changed["serviceGeneration"] = json!("different");
            let mut target = json!({"projectId":"execution-alias","requestId":request,"serviceId":"core","generation":"generation"});
            assert!(
                super::super::workbench_lifecycle::host_receipt(&mut target, &changed, false)
                    .is_err()
            );
        }
    }
    #[test]
    fn worktree_target_keeps_host_connection_preparation_and_rebinds_managed_resources() {
        let fixture = tempfile::tempdir().unwrap();
        let home = fixture.path().join("gui");
        let root = fixture.path().join("checkout");
        let data = home.join("execution/state");
        let profile = json!({"id":"fixture","revision":"v1"});
        let template = LaunchInputs {
            workspace: fixture.path().join("source"),
            cwd: fixture.path().join("source"),
            config_home: home.clone(),
            homedir: None,
            config_path: None,
            deployment_path: None,
            schedule_preparation: Some(crate::SchedulePreparation::External {
                default_profile: Some(profile.clone()),
            }),
            environment: BTreeMap::new(),
            credential_names: vec![],
            options: Default::default(),
        };
        let target =
            target_launch_inputs(template.clone(), &root, &data, &home, "execution").unwrap();
        assert!(
            matches!(target.schedule_preparation, Some(crate::SchedulePreparation::External { default_profile: Some(value) }) if value == profile)
        );
        assert_eq!(target.workspace, root);
        assert_eq!(target.options.data_dir.as_deref(), Some(data.as_path()));
        assert!(target.options.scratch.unwrap().is_dir());
        let mut managed = template;
        managed.schedule_preparation = Some(crate::SchedulePreparation::Managed {
            resource_state_path: home.join("resource-state.json"),
            user_managed_skills_root: home.join("user-skills"),
            project_managed_skills_root: home.join("resources/source/skills"),
            project_resource_scope: "source".into(),
            default_profile: profile.clone(),
        });
        let target = target_launch_inputs(managed, &root, &data, &home, "execution").unwrap();
        let Some(crate::SchedulePreparation::Managed {
            resource_state_path,
            user_managed_skills_root,
            project_managed_skills_root,
            project_resource_scope,
            default_profile,
        }) = target.schedule_preparation
        else {
            panic!("GUI preparation must remain configured")
        };
        assert_eq!(resource_state_path, home.join("resource-state.json"));
        assert_eq!(user_managed_skills_root, home.join("user-skills"));
        assert_eq!(
            project_managed_skills_root,
            home.join("resources/execution/skills")
        );
        assert_eq!(project_resource_scope, "execution");
        assert_eq!(default_profile, profile);
    }
    #[test]
    fn project_metadata_add_merges_current_owners_and_keeps_unknown_fields() {
        let home = tempfile::tempdir().unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let original = json!({"id":"worktree","root":"/tree","logicalProjectId":"source","worktreeRequestId":"creation","futureField":{"keep":true}});
        std::fs::write(
            home.path().join("projects.json"),
            serde_json::to_vec(&json!([original])).unwrap(),
        )
        .unwrap();
        merge_project_metadata(home.path(), json!({"id":"ordinary","root":"/new","projectless":true,"projectlessRequestId":"new-request"})).unwrap();
        let rows = saved_projects(home.path()).unwrap();
        assert_eq!(
            rows,
            vec![
                original.clone(),
                json!({"id":"ordinary","root":"/new","projectless":true,"projectlessRequestId":"new-request"})
            ]
        );
        assert_eq!(
            merge_project_metadata(home.path(), json!({"id":"worktree","root":"/tree"})).unwrap(),
            original
        );
        assert!(
            merge_project_metadata(home.path(), json!({"id":"worktree","root":"/other"})).is_err()
        );
        assert_eq!(saved_projects(home.path()).unwrap(), rows);
    }
    #[test]
    fn owners_preserve_logical_grouping_without_a_backend_process() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join("projects.json"),serde_json::to_vec(&json!([
            {"id":"logical","root":"/repository"},
            {"id":"execution","root":"/worktree","logicalProjectId":"logical","worktreeRequestId":"creation"},
            {"id":"other","root":"/other"}
        ])).unwrap()).unwrap();
        let rows = owners(home.path(), "logical").unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["id"], "logical");
        assert_eq!(rows[1]["id"], "execution");
        assert_eq!(owners(home.path(), "execution").unwrap().len(), 1);
    }
    #[test]
    fn stale_lifecycle_snapshot_cannot_overwrite_a_cancel_intent() {
        let home = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let mut current = json!({"kind":"checkout","requestId":id,"projectId":"p","parameters":{},"state":"created","events":[]});
        persist(home.path(), &mut current).unwrap();
        let mut stale = current.clone();
        current["intent"] = json!("cancel");
        persist(home.path(), &mut current).unwrap();
        stale["state"] = json!("ready");
        assert!(persist(home.path(), &mut stale).is_err());
        let observed = record(home.path(), &id, "p").unwrap();
        assert_eq!(observed["intent"], "cancel");
        assert_eq!(observed["state"], "created");
        assert_eq!(observed["recordRevision"], 2);
    }
    #[test]
    fn worktree_preferences_keep_unrelated_desktop_settings_and_use_revisions() {
        let mut state = json!({"projects":{},"settings":{"httpProxy":"preserve","hardwareAcceleration":false,"worktreeRevision":3}});
        preference_change(&mut state,&json!({"operation":"worktreeSettings","worktreeRoot":"/isolated/trees","branchPrefix":"fixture","expectedRevision":3})).unwrap();
        assert_eq!(state["settings"]["httpProxy"], "preserve");
        assert_eq!(state["settings"]["hardwareAcceleration"], false);
        assert_eq!(state["settings"]["worktreeRevision"], 4);
        assert!(preference_change(&mut state,&json!({"operation":"worktreeSettings","worktreeRoot":"/isolated/trees","branchPrefix":"fixture","expectedRevision":3})).is_err());
        preference_change(&mut state,&json!({"operation":"worktreeEnvironmentSave","projectId":"p","expectedRevision":0,"environment":{"id":"env","name":"Environment","setup":{"default":"echo setup"},"cleanup":{"default":""},"actions":[]}})).unwrap();
        assert_eq!(state["projects"]["p"]["worktreeEnvironmentRevision"], 1);
        assert_eq!(
            state["projects"]["p"]["worktreeEnvironments"][0]["id"],
            "env"
        );
    }
}

async fn register_target(
    host: &Rc<Host>,
    source: &str,
    alias: &str,
    home: &Path,
    value: &mut Value,
    id: &str,
) -> Result<Value> {
    let source_project = project(host, source, alias)?;
    let creation = required(value, "requestId")?.to_owned();
    let root = PathBuf::from(
        required(&value["record"], "cwd").or_else(|_| required(&value["record"], "directory"))?,
    )
    .canonicalize()?;
    let execution_alias = storage::digest(root.to_string_lossy().as_bytes())[..24].to_owned();
    let execution_id = if source == "host" {
        stable_id(&format!("host:{execution_alias}"))
    } else {
        stable_id(&format!("{source}:{execution_alias}"))
    };
    let data_dir = if source == "host" {
        host.home.join("projects").join(&execution_id).join("state")
    } else {
        home.join(&execution_alias).join("state")
    };
    let registration = ProjectRegistration {
        project_id: execution_id.clone(),
        workspace: root.clone(),
        data_dir,
        source: match &source_project.source {
            ProjectSource::Gui { profile, .. } => ProjectSource::Gui {
                profile: profile.clone(),
                legacy_project_id: execution_alias.clone(),
            },
            ProjectSource::Cli => ProjectSource::Cli,
        },
        default_binding: !host.slots.borrow().values().any(|slot| {
            slot.registration.workspace == root
                && slot.registration.project_id != execution_id
                && slot.registration.default_binding
        }),
    };
    let saved_alias = if source == "host" {
        execution_id.as_str()
    } else {
        execution_alias.as_str()
    };
    let existing_rows = saved_projects(home)?;
    if let Some(existing) = existing_rows.iter().find(|row| row["id"] == saved_alias) {
        ensure!(
            existing["root"] == root.to_string_lossy().as_ref()
                && existing["logicalProjectId"] == alias,
            "worktree directory belongs to another logical project"
        );
    }
    let target_data = registration.data_dir.clone();
    host.register(Register {
        bind_existing: false,
        request_id: stable_id(&format!("{source}:register:{execution_alias}")),
        expected_generation: host.identity.generation.clone(),
        registration,
    })
    .await?;
    let template_path = host
        .home
        .join("host/launch")
        .join(storage::digest(source_project.project_id.as_bytes()))
        .join("inputs.json");
    let launch: LaunchInputs = storage::read(&template_path)?;
    let launch = target_launch_inputs(launch, &root, &target_data, home, &execution_alias)?;
    let credentials = host
        .slots
        .borrow()
        .get(&source_project.project_id)
        .map(|slot| slot.credentials.clone())
        .unwrap_or_default();
    host.ensure(Ensure {
        no_auto_restart: false,
        resume_scheduling: false,
        request_id: stable_id(&format!("{id}:ensure")),
        expected_generation: host.identity.generation.clone(),
        project_id: execution_id.clone(),
        launch_inputs: Some(launch),
        credentials,
    })
    .await?;
    let mut rows = source_projects(host, source, home)?;
    let saved_alias = if source == "host" {
        execution_id.as_str()
    } else {
        execution_alias.as_str()
    };
    if let Some(row) = rows.iter_mut().find(|row| row["id"] == saved_alias) {
        row["logicalProjectId"] = json!(alias);
        row["worktreeRequestId"] = json!(creation);
    } else {
        rows.push(json!({"id":saved_alias,"root":root,"logicalProjectId":alias,"worktreeRequestId":creation}));
    }
    storage::private_dir(home)?;
    crate::migration::atomic_bytes(&home.join("projects.json"), &serde_json::to_vec(&rows)?)?;
    open_record(value, saved_alias);
    freeze_prepared_core(host, source, &execution_id, value)?;
    persist(home, value)?;

    Ok(json!({"projectId":execution_id,"alias":saved_alias,"root":root,"requestId":creation}))
}

fn target_launch_inputs(
    mut launch: LaunchInputs,
    root: &Path,
    target_data: &Path,
    home: &Path,
    alias: &str,
) -> Result<LaunchInputs> {
    launch.workspace = root.to_owned();
    launch.cwd = root.to_owned();
    launch.options.workspace = Some(root.to_owned());
    launch.options.data_dir = Some(target_data.to_owned());
    launch.options.scratch = Some(
        target_data
            .parent()
            .context("target state parent missing")?
            .join("scratch"),
    );
    storage::private_dir(
        launch
            .options
            .scratch
            .as_ref()
            .context("target scratch missing")?,
    )?;
    // 调度准备也是 Host 共享连接的合同；只重绑项目资源，不丢弃可信的来源配置。
    if let Some(crate::SchedulePreparation::Managed {
        project_managed_skills_root,
        project_resource_scope,
        ..
    }) = &mut launch.schedule_preparation
    {
        *project_managed_skills_root = home.join("resources").join(alias).join("skills");
        *project_resource_scope = alias.to_owned();
    }
    Ok(launch)
}

fn freeze_prepared_core(
    host: &Rc<Host>,
    source: &str,
    execution: &str,
    value: &mut Value,
) -> Result<()> {
    let scope = host
        .schedules
        .connections
        .shared_identity(host, execution)?;
    let backend = if source == "host" {
        Value::Null
    } else {
        host.gateway
            .workbench
            .worktree_backend_identity(source)
            .context("CAPABILITY_UNAVAILABLE")?
    };
    value["preparedCore"] = json!({"projectId":execution,"instanceId":scope.0,"generation":scope.1,"connectionId":scope.2,"backend":backend});
    Ok(())
}
fn prepared_core(host: &Rc<Host>, source: &str, value: &Value) -> Result<(String, String, String)> {
    let expected = &value["preparedCore"];
    let execution = project(host, source, required(value, "executionProjectId")?)?;
    ensure!(
        expected["projectId"] == execution.project_id,
        "RESYNC_REQUIRED"
    );
    let scope = host
        .schedules
        .connections
        .shared_identity(host, &execution.project_id)?;
    ensure!(
        expected["instanceId"] == scope.0
            && expected["generation"] == scope.1
            && expected["connectionId"] == scope.2,
        "RESYNC_REQUIRED"
    );
    if source != "host" {
        ensure!(
            host.gateway
                .workbench
                .worktree_backend_identity(source)
                .as_ref()
                == Some(&expected["backend"]),
            "RESYNC_REQUIRED"
        );
    }
    Ok(scope)
}
pub(super) fn validate_private_binding(
    host: &Rc<Host>,
    source: &str,
    params: &Value,
) -> Result<()> {
    let logical = required(params, "projectId")?;
    let id = required(params, "requestId")?;
    let value = record(
        &super::library_store::source_home(host, source)?,
        id,
        logical,
    )?;
    let expected = &value["preparedCore"];
    let scope = prepared_core(host, source, &value)?;
    ensure!(
        params["executionProjectId"] == expected["projectId"]
            && params["coreInstanceId"] == scope.0
            && params["coreGeneration"] == scope.1,
        "RESYNC_REQUIRED"
    );
    Ok(())
}

fn thread_signature(request: &Value) -> Value {
    let mut signature = json!({});
    for key in [
        "worktree",
        "model",
        "parameters",
        "options",
        "profile",
        "browserEnabled",
    ] {
        if let Some(value) = request.get(key) {
            signature[key] = value.clone();
        }
    }
    signature
}

fn thread_checkout_params(logical: &str, id: &str, worktree: &Value) -> Result<Value> {
    let mut params =
        json!({"operation":"worktreeCreate","projectId":logical,"requestId":id,"source":"head"});
    // 旧 thread 准备把空可选字符串按 || undefined 省略；公共 Core create 仍严格校验显式值。
    for key in [
        "sourceRoot",
        "ref",
        "branch",
        "worktreeRoot",
        "environmentId",
    ] {
        if let Some(value) = worktree.get(key) {
            let text = value.as_str().context("INVALID_PARAMS")?;
            if !text.is_empty() {
                params[key] = value.clone();
            }
        }
    }
    if params.get("ref").is_some() {
        params["source"] = json!("branch");
    }
    Ok(params)
}
/// 只准备归属与目录，不执行会话创建；供应商和页面工具仍由原 JS 宿主准备。
pub(super) async fn prepare_thread_target(
    host: &Rc<Host>,
    source: &str,
    logical: &str,
    input: Value,
) -> Result<Value> {
    host.admission()?;
    let home = super::library_store::source_home(host, source)?;
    let id = uuid::Uuid::parse_str(required(&input, "requestId")?)?.to_string();
    let signature = thread_signature(&input);
    let mut value = match record(&home, &id, logical) {
        Ok(value) => {
            ensure!(
                value["kind"] == "thread" && value["parameters"] == signature,
                "COMMAND_CONFLICT"
            );
            ensure!(
                !matches!(
                    value["state"].as_str(),
                    Some("failed" | "cancelled" | "unknown" | "creating")
                ),
                "SUBMISSION_UNKNOWN"
            );
            value
        }
        Err(error) => {
            let file = home.join("worktree-requests").join(format!("{id}.json"));
            if file.try_exists()? {
                return Err(error);
            }
            if input["worktree"]["mode"] == "worktree" {
                let params = thread_checkout_params(logical, &id, &input["worktree"])?;
                let mut value = command(host, source, params).await?;
                ensure!(value["state"] == "created", "SUBMISSION_UNKNOWN");
                value["kind"] = json!("thread");
                value["createdAt"] = value["record"]["createdAt"].clone();
                value["parameters"] = signature.clone();
                value["intent"] = json!("continue");
                value["usesSource"] = json!(false);
                persist(&home, &mut value)?;
                value
            } else {
                ensure!(
                    input["worktree"].get("environmentId").is_none(),
                    "environment scripts require an isolated worktree"
                );
                let mut value = json!({"kind":"thread","requestId":id,"projectId":logical,"parameters":signature,"state":"created","executionProjectId":logical,"usesSource":true,"intent":"continue","events":[],"createdAt":timestamp()});
                persist(&home, &mut value)?;
                value
            }
        }
    };
    if matches!(value["state"].as_str(), Some("binding" | "settingUp")) {
        let observed = read_thread_target(host, source, logical, input.clone()).await?;
        ensure!(observed["state"] == "ready", "SUBMISSION_UNKNOWN");
        value = record(&home, &id, logical)?;
    }
    if value["state"] == "ready" {
        let alias = required(&value, "executionProjectId")?;
        let execution = project(host, source, alias)?;
        return Ok(
            json!({"projectId":execution.project_id,"alias":alias,"root":execution.workspace,"requestId":id,"threadId":value["threadId"]}),
        );
    }
    if value["usesSource"] == true {
        let registration = project(host, source, logical)?;
        let _ = request(
            host,
            &registration.project_id,
            "areal/server/status",
            json!({}),
        )
        .await?;
        freeze_prepared_core(host, source, &registration.project_id, &mut value)?;
        persist(&home, &mut value)?;
        return Ok(
            json!({"projectId":registration.project_id,"alias":logical,"root":registration.workspace,"requestId":id}),
        );
    }
    register_target(host, source, logical, &home, &mut value, &id).await
}
fn receipt_result(receipts: &Value, id: &str, method: &str, thread: Option<&str>) -> Option<Value> {
    let mut matches = receipts["data"].as_array()?.iter().filter(|row| {
        row["requestId"] == id
            && row["method"] == method
            && thread.is_none_or(|thread| row["threadId"] == thread)
    });
    let receipt = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    receipt
        .get("result")
        .or_else(|| receipt["response"].get("result"))
        .cloned()
}
pub(super) async fn bind_thread_target(
    host: &Rc<Host>,
    source: &str,
    logical: &str,
    id: &str,
    mut core_params: Value,
) -> Result<Value> {
    let home = super::library_store::source_home(host, source)?;
    let mut value = record(&home, id, logical)?;
    if value["state"] == "ready" {
        return Ok(json!({"threadId":value["threadId"],"requestId":id}));
    }
    ensure!(
        value["intent"] != "cancel" && value["deleted"] != true,
        "worktree creation cancelled"
    );
    let alias = required(&value, "executionProjectId")?.to_owned();
    let execution = project(host, source, &alias)?;
    ensure!(core_params["requestId"] == id, "INVALID_PARAMS");
    ensure!(
        core_params
            .get("cwd")
            .is_none_or(|cwd| cwd == execution.workspace.to_string_lossy().as_ref()),
        "worktree cwd changed"
    );
    core_params["cwd"] = json!(execution.workspace);
    let recovered = value["state"] == "binding" || value["state"] == "settingUp";
    if let Some(original) = value.get("bindingParams") {
        ensure!(*original == core_params, "COMMAND_CONFLICT");
    }
    let reply = if recovered {
        let receipts = request(
            host,
            &execution.project_id,
            "areal/request/read",
            json!({"requestId":id}),
        )
        .await?;
        receipt_result(&receipts, id, "areal/thread/start", None).context("SUBMISSION_UNKNOWN")?
    } else {
        ensure!(value["state"] == "created", "SUBMISSION_UNKNOWN");
        host.admission()?;
        let scope = prepared_core(host, source, &value)?;
        value["bindingParams"] = core_params.clone();
        event(&mut value, "binding");
        persist(&home, &mut value)?;
        let started = host
            .schedules
            .connections
            .remote_request(
                host,
                &execution.project_id,
                (&scope.0, &scope.1, &scope.2),
                "areal/thread/start",
                core_params,
            )
            .await;
        match started {
            Ok(reply) => reply,
            Err(error) => {
                if let Some(failure) = error
                    .downcast_ref::<crate::server::schedule_connection::RpcFailure>()
                    .filter(|failure| {
                        matches!(
                            failure.0["data"]["outcome"]["kind"].as_str(),
                            Some("rejected" | "noMutation")
                        )
                    })
                {
                    value["bindingAdmissionState"] = json!("rejected");
                    value["bindingError"] = failure.0.clone();
                    event(&mut value, "failed");
                    persist(&home, &mut value)?;
                    host.changed();
                    return Ok(
                        json!({"state":"failed","admissionState":"rejected","error":failure.0,"requestId":id}),
                    );
                }
                return Err(error);
            }
        }
    };
    let thread = reply["thread"]["id"]
        .as_str()
        .or_else(|| reply["threadId"].as_str())
        .context("INVALID_RESPONSE")?
        .to_owned();
    value["threadId"] = json!(thread);
    let script = platform_script(&value["environment"]["setup"])?;
    if script.is_empty() {
        event(&mut value, "ready");
        persist(&home, &mut value)?;
    } else {
        if recovered && value.get("setup").is_none() {
            event(&mut value, "unknown");
            persist(&home, &mut value)?;
            anyhow::bail!("SUBMISSION_UNKNOWN");
        }
        event(&mut value, "settingUp");
        persist(&home, &mut value)?;
        let attempt = environment_attempt(
            host,
            source,
            &home,
            &mut value,
            "setup",
            &script,
            None,
            &stable_id(&format!("{id}:setup")),
            recovered,
        )
        .await?;
        if matches!(attempt["status"].as_str(), Some("failed" | "cancelled")) {
            return Ok(
                json!({"threadId":thread,"requestId":id,"state":value["state"],"setup":attempt}),
            );
        }
        ensure!(
            attempt["status"] == "succeeded",
            "worktree setup remains unconfirmed"
        );
    }
    host.changed();
    host.gateway
        .workbench
        .schedule_worktree_cleanup(host, source);
    Ok(json!({"threadId":thread,"requestId":id}))
}

pub(super) async fn read_thread_target(
    host: &Rc<Host>,
    source: &str,
    logical: &str,
    input: Value,
) -> Result<Value> {
    let home = super::library_store::source_home(host, source)?;
    let id = uuid::Uuid::parse_str(required(&input, "requestId")?)?.to_string();
    let mut value = match record(&home, &id, logical) {
        Ok(value) => value,
        Err(_) => return Ok(json!({"state":"unknown"})),
    };
    if value["kind"] != "thread" || value["parameters"] != thread_signature(&input) {
        return Ok(json!({"state":"unknown"}));
    }
    if matches!(value["state"].as_str(), Some("binding" | "settingUp")) {
        if let Some(params) = value.get("bindingParams").cloned() {
            let _ = bind_thread_target(host, source, logical, &id, params).await;
            value = record(&home, &id, logical)?;
        }
    }
    Ok(
        if value["state"] == "ready"
            && value["threadId"].is_string()
            && value["executionProjectId"].is_string()
        {
            json!({"state":"ready","requestId":id,"threadId":value["threadId"],"executionProjectId":value["executionProjectId"]})
        } else if matches!(value["state"].as_str(), Some("failed" | "cancelled")) {
            json!({"state":"rejected","requestId":id,"message":value.get("message").cloned().unwrap_or(json!("Creation rejected"))})
        } else {
            json!({"state":"unknown"})
        },
    )
}
pub(super) async fn auto_cleanup(host: &Rc<Host>, source: &str) -> Result<()> {
    host.admission()?;
    let home = super::library_store::source_home(host, source)?;
    let library = library(&home)?;
    let config = settings(&library);
    if config["autoCleanup"] != true {
        return Ok(());
    }
    let mut retained: Vec<_> = operations(&home)?
        .into_iter()
        .filter(|value| value.get("record").is_some() && value["deleted"] != true)
        .collect();
    let mut excess = retained
        .len()
        .saturating_sub(config["keepCount"].as_u64().unwrap_or(10) as usize);
    retained.sort_by(|a, b| a["createdAt"].as_str().cmp(&b["createdAt"].as_str()));
    for value in retained {
        if excess == 0 {
            break;
        }
        let logical = required(&value, "projectId")?;
        if library["projects"][logical]["pinned"] == true
            || value.get("deletion").is_some()
            || !matches!(
                value["state"].as_str(),
                Some("ready" | "created" | "cancelled" | "failed")
            )
        {
            continue;
        }
        if value.get("threadId").is_some() {
            let Some(execution) = value["executionProjectId"].as_str() else {
                continue;
            };
            let Some(summaries) = library["projects"][execution]["navigationSummaries"].as_array()
            else {
                continue;
            };
            if summaries.is_empty()||!summaries.iter().all(|thread|thread["desktop"]["archived"]==true&&library["threads"][format!("{logical}:{}",thread["id"].as_str().unwrap_or_default())]["pinned"]!=true){continue;}
        }
        let removed=command(host,source,json!({"operation":"worktreeDelete","projectId":logical,"requestId":uuid::Uuid::new_v4().to_string(),"worktreeRequestId":value["requestId"],"automatic":true})).await;
        if removed.is_ok_and(|result| result["deleted"] == true) {
            excess -= 1;
        }
    }
    Ok(())
}

fn safe_parents(path: &Path) -> Result<()> {
    let mut cursor = PathBuf::new();
    for part in path.components() {
        cursor.push(part);
        match std::fs::symlink_metadata(&cursor) {
            Ok(meta) => ensure!(
                meta.is_dir() && !meta.file_type().is_symlink(),
                "worktree root traverses a link or file"
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}
