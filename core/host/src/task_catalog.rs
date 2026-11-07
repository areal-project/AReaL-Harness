//! 跨项目任务目录只聚合 Core 读模型；停止项目的 published 快照不代表实时执行状态。
use super::{Ensure, Host};
use anyhow::{Context, Result, bail, ensure};
use areal_local_service::storage;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    rc::Rc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
#[derive(Debug)]
struct CatalogRequiresCore(&'static str);
impl std::fmt::Display for CatalogRequiresCore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "任务目录需要启动原工作区完成迁移或检查：{}", self.0)
    }
}
impl std::error::Error for CatalogRequiresCore {}

fn requires_core_reason(catalog: &Value) -> Result<&'static str> {
    match catalog["reason"].as_str() {
        Some("unbound") => Ok("unbound"),
        Some("legacyFormat") => Ok("legacyFormat"),
        Some("readBudgetExceeded") => Ok("readBudgetExceeded"),
        _ => bail!("INVALID_RESPONSE"),
    }
}
fn require_published_catalog(catalog: &Value) -> Result<()> {
    if catalog["kind"] == "requiresCore" {
        return Err(CatalogRequiresCore(requires_core_reason(catalog)?).into());
    }
    Ok(())
}
fn catalog_error_message(error: &anyhow::Error) -> String {
    // 仅公开目录合同中的有限原因，不把进程 stderr 或传输错误带给客户端。
    error
        .downcast_ref::<CatalogRequiresCore>()
        .map(ToString::to_string)
        .unwrap_or_else(|| "任务目录暂不可用，尚不能确认实时状态".into())
}
#[derive(Clone)]
struct Owner {
    id: String,
    public: String,
    execution: Option<String>,
    name: String,
    independent: bool,
}
async fn owners(host: &Host, params: &Value) -> Result<Vec<Owner>> {
    let view = host.read_models.shell(host).await?;
    let native_projects =
        super::worktree_catalog::saved_projects(&host.home.join("workbench/native"))?;
    let source = params["sourceId"]
        .as_str()
        .filter(|source| *source != "host");
    let public_id = |project: &crate::shell::ShellProject| {
        project
            .alias
            .as_ref()
            .filter(|alias| Some(alias.source_id.as_str()) == source)
            .map(|alias| alias.project_id.clone())
            .unwrap_or_else(|| project.project_id.clone())
    };
    let mut result = Vec::new();
    for project in &view.projects {
        if source.is_some()
            && !project
                .alias
                .as_ref()
                .is_some_and(|alias| Some(alias.source_id.as_str()) == source)
        {
            continue;
        }
        let logical_id = project
            .logical_project_id
            .as_deref()
            .or_else(|| {
                native_projects
                    .iter()
                    .find(|row| row["id"] == project.project_id)
                    .and_then(|row| row["logicalProjectId"].as_str())
            })
            .unwrap_or(&project.project_id);
        let logical = view
            .projects
            .iter()
            .find(|entry| entry.project_id == logical_id)
            .context("RESOURCE_UNAVAILABLE")?;
        let public = public_id(logical);
        let execution = (logical_id != project.project_id).then(|| public_id(project));
        if params["projectId"]
            .as_str()
            .is_some_and(|id| id != public && id != public_id(project) && id != project.project_id)
        {
            continue;
        }
        let title = logical.alias.as_ref().and_then(|alias| {
            view.navigation
                .iter()
                .find(|nav| nav.source_id == alias.source_id)
                .and_then(|nav| nav.projects.get(&alias.project_id))
                .and_then(|meta| meta.title.clone())
        });
        result.push(Owner {
            id: project.project_id.clone(),
            public,
            execution,
            name: title.unwrap_or_else(|| {
                if logical.projectless {
                    "独立任务".into()
                } else {
                    logical
                        .workspace
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned()
                }
            }),
            independent: logical.projectless
                || native_projects
                    .iter()
                    .any(|row| row["id"] == logical.project_id && row["projectless"] == true),
        });
    }
    ensure!(
        params["projectId"].is_null() || !result.is_empty(),
        "RESOURCE_UNAVAILABLE"
    );
    Ok(result)
}
fn owner_home(host: &Host, params: &Value) -> Result<std::path::PathBuf> {
    super::library_store::source_home(host, params["sourceId"].as_str().unwrap_or("host"))
}
fn owner_file(home: &std::path::Path, project: &str) -> Result<std::path::PathBuf> {
    ensure!(
        !project.is_empty()
            && project.len() <= 512
            && project
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')),
        "TASK_WORKSPACE_UNAVAILABLE"
    );
    Ok(home.join("task-owners").join(format!("{project}.json")))
}
fn owner_records(home: &std::path::Path) -> Result<BTreeMap<String, Vec<Value>>> {
    let directory = home.join("task-owners");
    let mut result = BTreeMap::new();
    if !directory.try_exists()? {
        return Ok(result);
    }
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let project = path
            .file_stem()
            .and_then(|x| x.to_str())
            .context("TASK_WORKSPACE_UNAVAILABLE")?;
        ensure!(
            owner_file(home, project)? == path,
            "TASK_WORKSPACE_UNAVAILABLE"
        );
        let rows: Vec<Value> = storage::read(&path)?;
        ensure!(
            rows.len() <= 65536 && result.len() < 65536,
            "LIMIT_EXCEEDED"
        );
        let rows = rows
            .into_iter()
            .map(|row| {
                let value = if row.is_string() {
                    json!({"id":row})
                } else {
                    row
                };
                ensure!(
                    value["id"]
                        .as_str()
                        .is_some_and(|s| !s.is_empty() && s.len() <= 512 && !s.contains('\0'))
                        && value.get("threadId").is_none_or(|v| v
                            .as_str()
                            .is_some_and(|s| !s.is_empty() && s.len() <= 512 && !s.contains('\0')))
                        && value.get("ambiguous").is_none_or(Value::is_boolean),
                    "TASK_WORKSPACE_UNAVAILABLE"
                );
                Ok(value)
            })
            .collect::<Result<Vec<_>>>()?;
        result.insert(project.into(), rows);
    }
    Ok(result)
}
fn remember_owner(host: &Host, params: &Value, project: &str, tasks: &[Value]) -> Result<()> {
    let source = params["sourceId"].as_str().unwrap_or("host");
    if source != "host"
        && !host.gateway.workbench.rust_domain("tasks-rust", source)
        && !host.gateway.workbench.rust_domain("execution-rust", source)
    {
        // 读取仍可用，归属索引只交给当前领域开关指定的唯一写者。
        return Ok(());
    }
    let home = owner_home(host, params)?;
    let file = owner_file(&home, project)?;
    let mut records: Vec<Value> = storage::read_optional(&file)?.unwrap_or_default();
    for task in tasks {
        let id = task.get("taskId").unwrap_or(&task["id"]);
        if !id.is_string() {
            continue;
        }
        let index = records.iter().position(|row| row == id || row["id"] == *id);
        let previous = index
            .map(|index| records[index].clone())
            .unwrap_or(Value::Null);
        let mut record = json!({"id":id});
        if let Some(thread) = task["threadId"]
            .as_str()
            .or_else(|| previous["threadId"].as_str())
        {
            record["threadId"] = json!(thread);
        }
        if previous["ambiguous"] == true
            || (previous["threadId"].is_string()
                && task["threadId"].is_string()
                && previous["threadId"] != task["threadId"])
        {
            record["ambiguous"] = json!(true);
        }
        if let Some(index) = index {
            records[index] = record;
        } else {
            records.push(record);
        }
    }
    ensure!(records.len() <= 65536, "LIMIT_EXCEEDED");
    storage::private_dir(file.parent().unwrap())?;
    storage::write(&file, &records)
}

/// 归属索引只提供原身份约束；没有唯一证据时逐候选向 Core 核对，离线不等于不存在。
pub(super) async fn owner_read(host: &Rc<Host>, params: &Value) -> Result<Value> {
    let task = params["taskId"].as_str().context("INVALID_PARAMS")?;
    ensure!(
        !task.is_empty() && task.len() <= 512 && !task.contains('\0'),
        "INVALID_PARAMS"
    );
    let candidates = owners(host, params).await?;
    let home = owner_home(host, params)?;
    let records = owner_records(&home)?;
    let indexed: Vec<_> = records
        .iter()
        .filter_map(|(project, rows)| rows.iter().find(|r| r["id"] == task).map(|r| (project, r)))
        .collect();
    ensure!(indexed.len() <= 1, "TASK_WORKSPACE_UNAVAILABLE");
    let selected: Vec<_> = if let Some((project, record)) = indexed.first() {
        ensure!(record["ambiguous"] != true, "TASK_WORKSPACE_UNAVAILABLE");
        let owner = candidates
            .iter()
            .find(|o| o.execution.as_deref().unwrap_or(&o.public) == project.as_str())
            .context("TASK_WORKSPACE_UNAVAILABLE")?;
        if params["execution"] != true && record["threadId"].is_string() {
            return Ok(json!({"projectId":project,"threadId":record["threadId"]}));
        }
        vec![owner]
    } else {
        candidates.iter().collect()
    };
    let found = tokio::time::timeout(Duration::from_secs(5), async {
        let mut found = Vec::new();
        for owner in selected {
            ensure_project(host, &owner.id).await?;
            match rpc(host, &owner.id, "areal/task/read", json!({"taskId":task})).await {
                Ok(value) => {
                    ensure!(value["id"] == task, "TASK_WORKSPACE_UNAVAILABLE");
                    found.push((owner, value));
                }
                Err(error)
                    if error
                        .downcast_ref::<super::schedule_connection::RpcFailure>()
                        .is_some_and(|failure| failure.0["code"] == -32004) => {}
                Err(_) => bail!("TASK_WORKSPACE_UNAVAILABLE"),
            }
        }
        Ok::<_, anyhow::Error>(found)
    })
    .await
    .context("TASK_WORKSPACE_UNAVAILABLE")??;
    ensure!(found.len() == 1, "TASK_WORKSPACE_UNAVAILABLE");
    let (owner, value) = &found[0];
    let alias = owner.execution.as_deref().unwrap_or(&owner.public);
    ensure!(
        owners(host, params)
            .await?
            .iter()
            .any(|current| current.id == owner.id
                && current.execution.as_deref().unwrap_or(&current.public) == alias),
        "TASK_WORKSPACE_UNAVAILABLE"
    );
    remember_owner(host, params, alias, std::slice::from_ref(value))?;
    let latest = owner_records(&home)?;
    let matches: Vec<_> = latest
        .iter()
        .flat_map(|(p, rows)| {
            rows.iter()
                .filter(move |r| r["id"] == task)
                .map(move |r| (p, r))
        })
        .collect();
    ensure!(
        matches.len() == 1 && matches[0].0 == alias && matches[0].1["ambiguous"] != true,
        "TASK_WORKSPACE_UNAVAILABLE"
    );
    let mut result = json!({"projectId":alias});
    if value["threadId"].is_string() {
        result["threadId"] = value["threadId"].clone();
    }
    if params["execution"] == true {
        result["mode"] = value["mode"].clone();
    }
    Ok(result)
}

pub(super) async fn resolve_project(host: &Host, params: &Value) -> Result<String> {
    let requested = params["executionProjectId"]
        .as_str()
        .or_else(|| params["projectId"].as_str())
        .context("INVALID_PARAMS")?;
    let candidates = owners(host, params).await?;
    let selected: Vec<_> = candidates
        .iter()
        .filter(|owner| {
            owner.id == requested
                || owner.execution.as_deref().unwrap_or(&owner.public) == requested
        })
        .collect();
    ensure!(selected.len() == 1, "RESOURCE_UNAVAILABLE");
    Ok(selected[0].id.clone())
}
pub(super) async fn rpc(host: &Host, id: &str, method: &str, params: Value) -> Result<Value> {
    let scope = host.schedules.connections.shared_identity(host, id)?;
    host.schedules
        .connections
        .remote_request(host, id, (&scope.0, &scope.1, &scope.2), method, params)
        .await
}
async fn ensure_project(host: &Host, id: &str) -> Result<()> {
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
    .context("scheduleHostUnavailable")?
}
async fn published(host: &Host, id: &str, source_thread: Option<&str>) -> Result<Value> {
    let registration = host
        .slots
        .borrow()
        .get(id)
        .context("RESOURCE_UNAVAILABLE")?
        .registration
        .clone();
    let (target, bound) =
        areal_local_service::catalog_target(&registration.workspace, &registration.data_dir)?;
    let catalog = if bound {
        serde_json::to_value(areal_engine::read_published_task_catalog(
            &target.data_dir,
            source_thread,
            1024,
        )?)?
    } else {
        json!({"kind":"requiresCore","reason":"unbound"})
    };
    ensure!(
        matches!(
            catalog["kind"].as_str(),
            Some("snapshot" | "empty" | "requiresCore")
        ),
        "TASK_CATALOG_READ_FAILED"
    );
    Ok(catalog)
}
/// 冷目录读取共用原 published 校验，不取得或启动 Core 连接。
pub(super) async fn preview(host: &Rc<Host>, params: &Value) -> Result<Value> {
    let project = resolve_project(host, params).await?;
    let limit = params["limit"].as_u64().context("INVALID_PARAMS")? as usize;
    ensure!((1..=1024).contains(&limit), "INVALID_PARAMS");
    let source = params["sourceThreadId"].as_str();
    let catalog = published(host, &project, source).await?;
    let kind = catalog["kind"].as_str().context("INVALID_RESPONSE")?;
    if kind == "empty" || kind == "requiresCore" {
        let mut coverage = json!({"kind":kind});
        if kind == "requiresCore" {
            coverage["reason"] = json!(requires_core_reason(&catalog)?);
        }
        return Ok(json!({"data":[],"hasMore":false,"coverage":coverage,"readAt":now()}));
    }
    ensure!(
        kind == "snapshot"
            && catalog["rootDigest"].as_str().is_some_and(|s| s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
            && catalog["hasMore"].is_boolean(),
        "INVALID_RESPONSE"
    );
    let rows = catalog["data"].as_array().context("INVALID_RESPONSE")?;
    ensure!(rows.len() <= 1024, "LIMIT_EXCEEDED");
    for row in rows {
        let _: areal_protocol::tasks::TaskDirectoryRow = serde_json::from_value(row.clone())?;
        ensure!(
            row["mode"] == "scheduled" && source.is_none_or(|id| row["sourceThreadId"] == id),
            "INVALID_RESPONSE"
        );
    }
    Ok(
        json!({"data":rows.iter().take(limit).collect::<Vec<_>>(),"hasMore":catalog["hasMore"]==true || rows.len()>limit,"coverage":{"kind":"snapshot"},"readAt":now()}),
    )
}

async fn directory(host: &Host, id: &str) -> Result<Value> {
    let scope = host.schedules.connections.shared_identity(host, id)?;
    let mut cursor: Option<String> = None;
    let mut revision = None;
    let mut generation = None;
    let mut data = Vec::new();
    let mut cursors = BTreeSet::new();
    loop {
        let mut query = json!({"limit":100});
        if let Some(cursor) = &cursor {
            query["cursor"] = json!(cursor);
        }
        let page = rpc(host, id, "areal/task/directory/list", query).await?;
        ensure!(
            host.schedules.connections.shared_identity(host, id)? == scope,
            "RESYNC_REQUIRED"
        );
        if let Some(previous) = &revision {
            ensure!(previous == &page["revision"], "RESYNC_REQUIRED");
        }
        if let Some(previous) = &generation {
            ensure!(previous == &page["generation"], "RESYNC_REQUIRED");
        }
        revision = Some(page["revision"].clone());
        generation = Some(page["generation"].clone());
        let rows = page["data"].as_array().context("INVALID_RESPONSE")?;
        ensure!(
            rows.len() <= 100 && data.len() + rows.len() <= 1024,
            "LIMIT_EXCEEDED"
        );
        data.extend(rows.iter().cloned());
        match page["nextCursor"].as_str() {
            None => return Ok(json!({"data":data,"revision":revision,"generation":generation})),
            Some(next) => {
                ensure!(
                    cursors.insert(next.to_owned()) && cursors.len() <= 1024,
                    "INVALID_RESPONSE"
                );
                cursor = Some(next.into());
            }
        }
    }
}
fn connection_generation(host: &Host, project: &str, connection: &str) -> Result<u64> {
    let mut generations = host.schedules.task_connections.borrow_mut();
    let entry = generations
        .entry(project.into())
        .or_insert_with(|| (connection.into(), 1));
    if entry.0 != connection {
        entry.0 = connection.into();
        entry.1 = entry
            .1
            .checked_add(1)
            .context("task connection generation exhausted")?;
    }
    Ok(entry.1)
}
fn scoped(mut row: Value, owner: &Owner) -> Value {
    row["projectId"] = json!(owner.public);
    row["projectName"] = json!(owner.name);
    row["scope"] = json!(if owner.independent {
        "independent"
    } else {
        "project"
    });
    if let Some(execution) = &owner.execution {
        row["executionProjectId"] = json!(execution);
    }
    row
}
/// list/preview/observe 从不唤醒停止的 Core；已连接项目在 observe 时注册目录观察。
pub(super) async fn read(host: &Rc<Host>, params: &Value) -> Result<Value> {
    let operation = params["operation"].as_str().unwrap_or("list");
    if operation == "receipt" {
        return native_receipt(host, "local", params).await;
    }
    if !matches!(operation, "list" | "preview" | "observe" | "inbox") {
        return manage_read(host, params).await;
    }
    let limit = params["limit"].as_u64().unwrap_or(30) as usize;
    ensure!((1..=1024).contains(&limit), "INVALID_PARAMS");
    let source_thread = params["sourceThreadId"].as_str();
    let mut data = Vec::new();
    let mut errors = Vec::new();
    let mut owner_states = BTreeMap::<String, Value>::new();
    let mut has_more = false;
    for owner in owners(host, params).await? {
        let result:Result<(Vec<Value>,bool,Value)>=async{
            let live=operation!="preview"&&host.schedules.connections.shared_identity(host,&owner.id).is_ok();
            if live{
                if operation=="observe"{watch_owner(host,&owner.id).await?;}
                let scope=host.schedules.connections.shared_identity(host,&owner.id)?;
                let value=if operation=="inbox"{rpc(host,&owner.id,"areal/inbox/list",json!({"limit":limit.min(100)})).await?}else{directory(host,&owner.id).await?};
                if operation=="observe" {
                    super::library_service::record_scheduled_baseline(host,&owner.id,value["data"].as_array().context("INVALID_RESPONSE")?).await?;
                    ensure!(host.schedules.connections.shared_identity(host,&owner.id)?==scope,"RESYNC_REQUIRED");
                }
                remember_owner(host,params,owner.execution.as_deref().unwrap_or(&owner.public),value["data"].as_array().context("INVALID_RESPONSE")?)?;
                let rows=value["data"].as_array().context("INVALID_RESPONSE")?.iter().filter(|row|operation=="inbox"||(row["mode"]=="scheduled"&&(row["deletedAt"].is_null()||row["hasUnsettledWork"]==true)&&source_thread.is_none_or(|thread|row["sourceThreadId"]==thread))).cloned().collect();
                let scope=host.schedules.connections.shared_identity(host,&owner.id)?;
                Ok((rows,value["hasMore"]==true||value["nextCursor"].is_string(),json!({"projectId":owner.public,"status":"ready","source":"live","coverage":{"kind":"complete"},"readAt":now(),"connectionGeneration":connection_generation(host,&owner.id,&scope.2)?})))
            }else{ensure!(operation!="inbox","TASK_CATALOG_READ_FAILED");let value=published(host,&owner.id,source_thread).await?;require_published_catalog(&value)?;Ok((value["data"].as_array().cloned().unwrap_or_default(),value["hasMore"]==true,json!({"projectId":owner.public,"status":"unobserved","source":"published","coverage":{"kind":value["kind"]},"readAt":now()})))}
        }.await;
        match result {
            Ok((rows, more, state)) => {
                if operation != "inbox" {
                    if let Some(slot) = host.slots.borrow().get(&owner.id) {
                        host.schedules
                            .task_rows
                            .borrow_mut()
                            .insert(owner.id.clone(), (slot.registration.clone(), rows.clone()));
                    }
                }
                has_more |= more || rows.len() > limit;
                data.extend(rows.into_iter().take(limit).map(|row| scoped(row, &owner)));
                let previous = owner_states.get(&owner.public);
                if previous.is_none()
                    || (previous.unwrap()["status"] != "error" && state["status"] == "unobserved")
                {
                    owner_states.insert(owner.public, state);
                }
            }
            Err(error) => {
                if operation != "inbox" {
                    let cached = host.schedules.task_rows.borrow().get(&owner.id).cloned();
                    if let Some((registration, rows)) = cached {
                        if host
                            .slots
                            .borrow()
                            .get(&owner.id)
                            .is_some_and(|slot| slot.registration == registration)
                        {
                            data.extend(
                                rows.into_iter()
                                    .filter(|row| {
                                        source_thread
                                            .is_none_or(|thread| row["sourceThreadId"] == thread)
                                    })
                                    .take(limit)
                                    .map(|row| scoped(row, &owner)),
                            );
                        }
                    }
                }
                owner_states.insert(
                    owner.public.clone(),
                    json!({"projectId":owner.public,"status":"error"}),
                );
                errors.push(json!({"projectId":owner.public,"code":"TASK_CATALOG_READ_FAILED","message":catalog_error_message(&error)}));
            }
        }
    }
    let mut result = json!({"data":data,"errors":errors,"hasMore":has_more,"owners":owner_states.into_values().collect::<Vec<_>>()});
    for key in ["projectId", "requestId", "viewEpoch"] {
        if let Some(field) = params.get(key) {
            result[key] = field.clone();
        }
    }
    if operation == "preview" {
        result["source"] = json!("published");
        result["executionState"] = json!("unobserved");
    }
    Ok(result)
}
pub(super) fn mutation(operation: &str) -> Option<&'static str> {
    Some(match operation {
        "taskDraftStart" | "taskDraftSend" | "taskDraftConfirm" => "areal/task/draft",
        "taskCreate" => "areal/task/create",
        "taskUpdate" => "areal/task/update",
        "taskRunNow" => "areal/task/runNow",
        "taskPause" => "areal/task/pause",
        "taskResume" => "areal/task/resume",
        "taskCancel" => "areal/task/cancel",
        "taskDelete" => "areal/task/delete",
        "taskStopRun" => "areal/task/stopRun",
        "taskResumeRun" => "areal/task/resumeRun",
        "taskReply" => "areal/channel/reply",
        _ => return None,
    })
}
fn mutation_params(operation: &str, mut params: Value) -> Result<Value> {
    let object = params.as_object_mut().context("INVALID_PARAMS")?;
    for field in [
        "sourceId",
        "projectId",
        "executionProjectId",
        "logicalProjectId",
    ] {
        object.remove(field);
    }
    if !operation.starts_with("taskDraft") {
        object.remove("operation");
        object.remove("cwd");
        // 桌面解析任务归属时附加执行锚点；只有创建任务将它作为 Core 参数。
        if operation != "taskCreate" {
            object.remove("threadId");
        }
    }
    macro_rules! normalized {
        ($ty:ty) => {
            serde_json::to_value(serde_json::from_value::<$ty>(params).context("INVALID_PARAMS")?)
                .context("INVALID_PARAMS")
        };
    }
    match operation {
        "taskDraftStart" | "taskDraftSend" | "taskDraftConfirm" => {
            normalized!(areal_protocol::tasks::TaskDraftRequest)
        }
        "taskCreate" => normalized!(areal_protocol::tasks::TaskCreate),
        "taskUpdate" => normalized!(areal_protocol::tasks::TaskUpdate),
        "taskRunNow" => normalized!(areal_protocol::tasks::TaskRunNow),
        "taskReply" => normalized!(areal_protocol::tasks::ChannelReply),
        _ => normalized!(areal_protocol::tasks::TaskControl),
    }
}
fn command_cwd(host: &Host, project: &str, params: &Value) -> Result<std::path::PathBuf> {
    let registration = host
        .slots
        .borrow()
        .get(project)
        .context("RESOURCE_UNAVAILABLE")?
        .registration
        .clone();
    let cwd = params["cwd"]
        .as_str()
        .map(std::path::PathBuf::from)
        .unwrap_or(registration.workspace.clone())
        .canonicalize()?;
    ensure!(
        cwd.starts_with(registration.workspace.canonicalize()?) && cwd.is_dir(),
        "INVALID_PARAMS"
    );
    Ok(cwd)
}
fn task_thread_cwd(
    root: &std::path::Path,
    params: &Value,
    rows: &[Value],
) -> Result<(std::path::PathBuf, bool)> {
    let root = root.canonicalize()?;
    let scratch = rows.iter().any(|row| {
        row["projectless"] == true
            && row["projectlessRequestId"] == "00000000-0000-4000-a000-5c4a7c400001"
            && row["root"].as_str().is_some_and(|path| {
                std::path::Path::new(path)
                    .canonicalize()
                    .is_ok_and(|path| path == root)
            })
    });
    let cwd = match params["cwd"].as_str() {
        Some(cwd) => std::path::PathBuf::from(cwd),
        None if scratch => {
            // 共用 Scratch 的任务始终使用独立子目录，省略路径时沿用原请求身份。
            let request = params["requestId"].as_str().context("INVALID_PARAMS")?;
            root.join(
                uuid::Uuid::parse_str(request)
                    .context("INVALID_PARAMS")?
                    .to_string(),
            )
        }
        None => return Ok((root, false)),
    };
    if cwd == root {
        ensure!(!scratch, "INVALID_PARAMS");
        return Ok((root, false));
    }
    if scratch {
        let name = cwd
            .file_name()
            .and_then(|name| name.to_str())
            .context("INVALID_PARAMS")?;
        ensure!(
            cwd.parent() == Some(root.as_path())
                && !name.starts_with('.')
                && name.encode_utf16().count() <= 128
                && !name.contains(['/', '\\'])
                && root.join(name) == cwd,
            "INVALID_PARAMS"
        );
        return Ok((cwd.to_path_buf(), true));
    }
    let cwd = cwd.canonicalize()?;
    ensure!(cwd.starts_with(&root) && cwd.is_dir(), "INVALID_PARAMS");
    Ok((cwd, false))
}

pub(super) async fn command(host: &Rc<Host>, params: &Value) -> Result<Value> {
    let operation = params["operation"].as_str().context("INVALID_PARAMS")?;
    let method = mutation(operation).context("INVALID_PARAMS")?;
    let project = resolve_project(host, params).await?;
    ensure_project(host, &project).await?;
    let mut native = params.clone();
    if method == "areal/task/draft" {
        if operation == "taskDraftStart" {
            native["cwd"] = json!(command_cwd(host, &project, params)?);
        }
        let native = mutation_params(operation, native)?;
        let result = rpc(host, &project, method, native).await?;
        host.changed();
        return Ok(result);
    }
    if operation == "taskCreate" && native["threadId"].is_null() {
        let request = native["requestId"].as_str().context("INVALID_PARAMS")?;
        let root = host
            .slots
            .borrow()
            .get(&project)
            .context("RESOURCE_UNAVAILABLE")?
            .registration
            .workspace
            .clone();
        let rows = super::worktree_catalog::saved_projects(&owner_home(host, params)?)?;
        let (cwd, prepare) = task_thread_cwd(&root, params, &rows)?;
        let mut start = json!({"requestId":execution_request_id(request),"cwd":cwd});
        if prepare {
            let capabilities = rpc(host, &project, "areal/capabilities", json!({})).await?;
            ensure!(
                capabilities["features"]["taskDirectoryPreparation"] == true,
                "CAPABILITY_UNAVAILABLE"
            );
            start["prepareTaskDirectory"] = json!(true);
        }
        let started = rpc(host, &project, "areal/thread/start", start).await?;
        native["threadId"] = started["thread"]["id"].clone();
        ensure!(native["threadId"].is_string(), "INVALID_RESPONSE");
    }
    let mut value = rpc(host, &project, method, mutation_params(operation, native)?).await?;
    if operation == "taskReply" {
        value["questionId"] = params["questionId"].clone();
    }
    host.changed();
    Ok(value)
}
fn execution_request_id(request: &str) -> String {
    let hex = storage::digest(format!("AREAL_TASK_EXECUTION_V1:{request}").as_bytes());
    format!(
        "{}-{}-4{}-a{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[13..16],
        &hex[17..20],
        &hex[20..32]
    )
}
/// 仅 Core 明确保证没有变更时，才能把原请求从未知状态结算为拒绝。
pub(super) fn definitive_task_rejection(error: &anyhow::Error) -> Option<Value> {
    let failure = error.downcast_ref::<super::schedule_connection::RpcFailure>()?;
    let kind = failure.0["data"]["outcome"]["kind"].as_str()?;
    if !matches!(kind, "rejected" | "noMutation") {
        return None;
    }
    let code = failure.0.get("code")?.clone();
    if !(code.as_i64().is_some()
        || code.as_str().is_some_and(|code| {
            !code.is_empty()
                && code.len() <= 64
                && code
                    .bytes()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
        }))
    {
        return None;
    }
    Some(
        json!({"code":code,"message":"Core rejected task request","data":{"outcome":{"kind":kind}}}),
    )
}
#[derive(Debug)]
pub(super) struct TaskRejection(pub Value);
impl std::fmt::Display for TaskRejection {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output.write_str("Core rejected task request")
    }
}
impl std::error::Error for TaskRejection {}
pub(super) fn task_rejection_response(error: &anyhow::Error) -> Option<Value> {
    let rejected = &error.downcast_ref::<TaskRejection>()?.0;
    let mut result = json!({"code":"TASK_REJECTED","message":"Core rejected task request","coreError":{"code":rejected["code"],"message":"Core rejected task request","data":{"outcome":rejected["data"]["outcome"]}}});
    if rejected["code"].as_i64().is_some() {
        result["coreCode"] = rejected["code"].clone();
    }
    Some(result)
}
/// 本机 CLI 也进入 Host journal；响应丢失后只核对原 Core receipt，不重新 dispatch。
pub(super) async fn native_command(
    host: &Rc<Host>,
    principal: &str,
    params: &Value,
) -> Result<Value> {
    let mut bound = params.clone();
    if bound["requestId"].is_null() {
        match bound["operation"].as_str() {
            Some("taskDraftStart") => bound["requestId"] = bound["draftId"].clone(),
            Some("taskDraftConfirm") => {
                let thread = bound["threadId"].as_str().context("INVALID_PARAMS")?;
                let turn = bound["turnId"].as_str().context("INVALID_PARAMS")?;
                let hex = storage::digest(
                    format!("AREAL_TASK_DRAFT_V1:{thread}:draft-confirm:{turn}").as_bytes(),
                );
                bound["requestId"] = json!(format!(
                    "{}-{}-4{}-a{}-{}",
                    &hex[..8],
                    &hex[8..12],
                    &hex[13..16],
                    &hex[17..20],
                    &hex[20..32]
                ));
            }
            _ => {}
        }
    }
    let project = resolve_project(host, &bound).await?;
    if bound["operation"] == "taskDraftStart" {
        bound["cwd"] = json!(command_cwd(host, &project, &bound)?);
    }
    let params = &bound;
    let request = params["requestId"].as_str().context("INVALID_PARAMS")?;
    crate::wire::request_id(request)?;
    let operation = params["operation"].as_str().context("INVALID_PARAMS")?;
    let method = mutation(operation).context("INVALID_PARAMS")?;
    let digest = storage::digest(&serde_json::to_vec(&json!([
        "tasks.command",
        principal,
        project,
        params
    ]))?);
    let scope = format!("tasks-{}", storage::digest(principal.as_bytes()));
    let (revision, mut snapshot) = host.journal.native_snapshot(&scope)?;
    if let Some(original) = snapshot["outcomes"].get(request) {
        ensure!(original["semanticDigest"] == digest, "COMMAND_CONFLICT");
        if let Some(error) = original.get("error") {
            return Err(TaskRejection(error.clone()).into());
        }
        return Ok(original["receipt"].clone());
    }
    if let Some(original) = snapshot["pending"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["requestId"] == request)
    {
        ensure!(original["semanticDigest"] == digest, "COMMAND_CONFLICT");
        bail!("SUBMISSION_UNKNOWN");
    }
    host.admission()?;
    snapshot["pending"].as_array_mut().unwrap().push(json!({"requestId":request,"operationId":request,"method":method,"params":params,"semanticDigest":digest}));
    host.journal.native_replace(&scope, revision, snapshot)?;
    let result = command(host, params).await;
    let rejection = result.as_ref().err().and_then(definitive_task_rejection);
    if result.is_err() && rejection.is_none() {
        return result;
    }
    let (revision, mut snapshot) = host.journal.native_snapshot(&scope)?;
    snapshot["pending"]
        .as_array_mut()
        .unwrap()
        .retain(|entry| entry["requestId"] != request);
    snapshot["outcomes"][request] = if let Some(error) = &rejection {
        json!({"requestId":request,"method":"tasks.command","coreMethod":method,"sourceId":params["sourceId"],"semanticDigest":digest,"error":error})
    } else {
        json!({"method":"tasks.command","semanticDigest":digest,"receipt":result.as_ref().unwrap()})
    };
    host.journal.native_replace(&scope, revision, snapshot)?;
    if let Some(error) = rejection {
        return Err(TaskRejection(error).into());
    }
    result
}
pub(super) async fn manage_read(host: &Rc<Host>, params: &Value) -> Result<Value> {
    let operation = params["operation"].as_str().context("INVALID_PARAMS")?;
    let project = resolve_project(host, params).await?;
    if matches!(operation, "taskWatch" | "taskUnwatch") {
        let view = params["viewId"]
            .as_str()
            .filter(|view| !view.is_empty() && view.len() <= 128)
            .context("INVALID_PARAMS")?
            .to_owned();
        let _gate = host.schedules.task_views_gate.lock().await;
        if operation == "taskUnwatch" {
            let previous = host
                .schedules
                .task_views
                .borrow_mut()
                .remove(&(project.clone(), view));
            if let Some((connection, task)) = previous {
                let shared = host.schedules.task_views.borrow().iter().any(
                    |((owner, _), (current, target))| {
                        owner == &project && current == &connection && target == &task
                    },
                );
                if !shared
                    && host
                        .schedules
                        .connections
                        .shared_identity(host, &project)
                        .is_ok_and(|scope| scope.2 == connection)
                {
                    rpc(
                        host,
                        &project,
                        "areal/task/unsubscribe",
                        json!({"taskId":task}),
                    )
                    .await?;
                }
            }
            return Ok(json!({"removed":true}));
        }
        ensure_project(host, &project).await?;
        let scope = host.schedules.connections.shared_identity(host, &project)?;
        let task = params["taskId"]
            .as_str()
            .context("INVALID_PARAMS")?
            .to_owned();
        let value = rpc(
            host,
            &project,
            "areal/task/subscribe",
            json!({"taskId":task}),
        )
        .await?;
        let previous = host
            .schedules
            .task_views
            .borrow_mut()
            .insert((project.clone(), view), (scope.2.clone(), task.clone()));
        if let Some((connection, previous)) = previous {
            let shared =
                host.schedules
                    .task_views
                    .borrow()
                    .iter()
                    .any(|((owner, _), (current, target))| {
                        owner == &project && current == &connection && target == &previous
                    });
            if previous != task && connection == scope.2 && !shared {
                rpc(
                    host,
                    &project,
                    "areal/task/unsubscribe",
                    json!({"taskId":previous}),
                )
                .await?;
            }
        }
        return Ok(value);
    }
    ensure_project(host, &project).await?;
    if operation == "taskHistoryCapabilities" {
        let capabilities = rpc(host, &project, "areal/capabilities", json!({})).await?;
        let supports = |method: &str| {
            capabilities["methods"]
                .as_array()
                .is_some_and(|methods| methods.iter().any(|candidate| candidate == method))
        };
        return Ok(
            json!({"enabled":supports("areal/task/runs/list")&&supports("areal/task/run/read"),"runNow":supports("areal/task/runNow")}),
        );
    }
    let method = match operation {
        "taskDraftRead" | "taskDraftHistory" => "areal/task/draft",
        "task" => "areal/task/read",
        "tasks" => "areal/task/list",
        "taskInbox" => "areal/inbox/list",
        "taskChannel" => "areal/channel/read",
        "taskRuns" => "areal/task/runs/list",
        "taskRun" => "areal/task/run/read",
        "taskSchedulePreview" => "areal/task/schedule/preview",
        "taskScheduleContext" => "areal/task/schedule/context",
        _ => bail!("INVALID_PARAMS"),
    };
    let query = read_params(method, params);
    rpc(host, &project, method, query).await
}

fn read_params(method: &str, params: &Value) -> Value {
    let fields: &[&str] = match method {
        "areal/task/read" => &["taskId"],
        "areal/task/list" | "areal/inbox/list" => &["after", "limit"],
        "areal/channel/read" => &["taskId", "afterSequence", "limit"],
        "areal/task/runs/list" => &["taskId", "cursor", "limit"],
        "areal/task/run/read" => &["taskId", "runId"],
        "areal/task/schedule/preview" => &["schedule", "from", "count"],
        "areal/task/schedule/context" => &["timeZone"],
        _ => &[],
    };
    if method != "areal/task/draft" {
        return Value::Object(
            fields
                .iter()
                .filter_map(|field| {
                    params
                        .get(*field)
                        .map(|value| ((*field).into(), value.clone()))
                })
                .collect(),
        );
    }
    let mut query = params.clone();
    for field in [
        "sourceId",
        "projectId",
        "executionProjectId",
        "logicalProjectId",
        "viewId",
    ] {
        query.as_object_mut().unwrap().remove(field);
    }
    query
}

pub(super) async fn native_receipt(
    host: &Rc<Host>,
    principal: &str,
    params: &Value,
) -> Result<Value> {
    let request = params["requestId"].as_str().context("INVALID_PARAMS")?;
    crate::wire::request_id(request)?;
    let scope = format!("tasks-{}", storage::digest(principal.as_bytes()));
    let (_, snapshot) = host.journal.native_snapshot(&scope)?;
    if let Some(original) = snapshot["outcomes"].get(request) {
        if let Some(error) = original.get("error") {
            return Err(TaskRejection(error.clone()).into());
        }
        return Ok(
            json!({"requestId":request,"submissionUnknown":false,"receipt":original["receipt"]}),
        );
    }
    let Some(original) = snapshot["pending"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["requestId"] == request)
    else {
        return Ok(json!({"requestId":request,"submissionUnknown":true}));
    };
    let original_params = &original["params"];
    let project = resolve_project(host, original_params).await?;
    ensure!(resolve_project(host, params).await? == project, "FORBIDDEN");
    let receipts = rpc(
        host,
        &project,
        "areal/request/read",
        json!({"requestId":request}),
    )
    .await?;
    let mut native = original_params.clone();
    if original["method"] == "areal/task/create" && native["threadId"].is_null() {
        let prelude = rpc(
            host,
            &project,
            "areal/request/read",
            json!({"requestId":execution_request_id(request)}),
        )
        .await?;
        let Some(thread) = prelude["data"]
            .as_array()
            .and_then(|rows| {
                rows.iter().find(|row| {
                    row["method"] == "areal/thread/start"
                        && row["status"] == "completed"
                        && row["identity"] == "desktop-owner"
                })
            })
            .and_then(|row| row["threadId"].as_str())
        else {
            return Ok(json!({"requestId":request,"submissionUnknown":true}));
        };
        native["threadId"] = json!(thread);
    }
    let native = mutation_params(
        original_params["operation"]
            .as_str()
            .context("INVALID_PARAMS")?,
        native,
    )?;
    let digest = storage::digest(&serde_json::to_vec(&native)?);
    let receipt = receipts["data"].as_array().and_then(|rows| {
        rows.iter().find(|row| {
            row["requestId"] == request
                && row["method"] == original["method"]
                && row["identity"] == "desktop-owner"
                && row["digest"] == digest
                && row["status"] == "completed"
        })
    });
    let Some(receipt) = receipt.and_then(|receipt| receipt.get("result")) else {
        return Ok(json!({"requestId":request,"submissionUnknown":true}));
    };
    let mut receipt = receipt.clone();
    if original_params["operation"] == "taskReply" {
        receipt["questionId"] = original_params["questionId"].clone();
    }
    let (revision, mut latest) = host.journal.native_snapshot(&scope)?;
    latest["pending"]
        .as_array_mut()
        .unwrap()
        .retain(|entry| entry["requestId"] != request);
    latest["outcomes"][request] = json!({"method":"tasks.command","semanticDigest":original["semanticDigest"],"receipt":receipt});
    host.journal.native_replace(&scope, revision, latest)?;
    Ok(json!({"requestId":request,"submissionUnknown":false,"receipt":receipt}))
}
async fn watch_owner(host: &Host, project: &str) -> Result<Value> {
    let scope = host.schedules.connections.shared_identity(host, project)?;
    if let Some((connection, barrier)) = host.schedules.task_watches.borrow().get(project) {
        if connection == &scope.2 {
            return Ok(barrier.clone());
        }
    }
    let barrier = rpc(host, project, "areal/owner/watch", json!({})).await?;
    ensure!(
        host.schedules.connections.shared_identity(host, project)? == scope,
        "RESYNC_REQUIRED"
    );
    ensure!(
        barrier["generation"].is_string() && barrier["sequence"].as_u64().is_some(),
        "INVALID_RESPONSE"
    );
    let mut watches = host.schedules.task_watches.borrow_mut();
    if let Some((connection, latest)) = watches.get(project) {
        if connection == &scope.2
            && latest["generation"] == barrier["generation"]
            && latest["sequence"].as_u64() > barrier["sequence"].as_u64()
        {
            return Ok(barrier);
        }
    }
    watches.insert(project.into(), (scope.2, barrier.clone()));
    Ok(barrier)
}

/// 连接已安装后由资料库独立取基线，不依赖任务领域迁移开关。
pub(super) async fn library_baseline(
    host: &Rc<Host>,
    project: &str,
    connection: &str,
) -> Result<()> {
    let scope = host.schedules.connections.shared_identity(host, project)?;
    ensure!(scope.2 == connection, "RESYNC_REQUIRED");
    let value = directory(host, project).await?;
    ensure!(
        host.schedules.connections.shared_identity(host, project)? == scope,
        "RESYNC_REQUIRED"
    );
    super::library_service::record_scheduled_baseline(
        host,
        project,
        value["data"].as_array().context("INVALID_RESPONSE")?,
    )
    .await?;
    ensure!(
        host.schedules.connections.shared_identity(host, project)? == scope,
        "RESYNC_REQUIRED"
    );
    Ok(())
}

/// 私有页面投影读取完整有界目录；公开分页上限不随内部通知观察扩大。
pub(super) async fn observe(host: &Rc<Host>, params: &Value) -> Result<Value> {
    let project = resolve_project(host, params).await?;
    // 私有通知投影只跟随 Host 已有连接；停止期间的在途读不能重新启动项目。
    let scope = host.schedules.connections.shared_identity(host, &project)?;
    let barrier = watch_owner(host, &project).await?;
    let value = directory(host, &project).await?;
    let group = owners(host, params).await?;
    let owner = group
        .iter()
        .find(|owner| owner.id == project)
        .context("TASK_WORKSPACE_UNAVAILABLE")?;
    remember_owner(
        host,
        params,
        owner.execution.as_deref().unwrap_or(&owner.public),
        value["data"].as_array().context("INVALID_RESPONSE")?,
    )?;
    ensure!(
        host.schedules.connections.shared_identity(host, &project)? == scope,
        "RESYNC_REQUIRED"
    );
    ensure!(
        value["generation"] == barrier["generation"],
        "RESYNC_REQUIRED"
    );
    super::library_service::record_scheduled_baseline(
        host,
        &project,
        value["data"].as_array().context("INVALID_RESPONSE")?,
    )
    .await?;
    ensure!(
        host.schedules.connections.shared_identity(host, &project)? == scope,
        "RESYNC_REQUIRED"
    );
    Ok(
        json!({"projectId":params["projectId"],"generation":barrier["generation"],"sequence":barrier["sequence"],
        "connectionId":scope.2,"connectionGeneration":connection_generation(host,&project,&scope.2)?,"data":value["data"],"readAt":now()}),
    )
}

/// Core 原连接身份必须随事件传入；换代后的旧连接不能污染新观察或发送事实。
pub(super) fn accept_event(
    host: &Host,
    project: &str,
    connection: &str,
    event: &Value,
) -> Option<Value> {
    let method = event["method"].as_str()?;
    if !matches!(
        method,
        "areal/owner/invalidated"
            | "areal/owner/resetRequired"
            | "areal/task/updated"
            | "host/connectionReady"
    ) {
        return None;
    }
    let scope = host
        .schedules
        .connections
        .shared_identity(host, project)
        .ok()?;
    if scope.2 != connection {
        return None;
    }
    let params = &event["params"];
    if matches!(method, "areal/owner/resetRequired" | "host/connectionReady") {
        host.schedules.task_watches.borrow_mut().remove(project);
    } else if method == "areal/owner/invalidated" {
        let sequence = params["sequence"].as_u64()?;
        let generation = params["generation"].as_str()?;
        host.schedules.task_watches.borrow_mut().insert(
            project.into(),
            (
                connection.into(),
                json!({"generation":generation,"sequence":sequence}),
            ),
        );
    }
    Some(
        json!({"projectId":project,"connectionId":connection,"connectionGeneration":connection_generation(host,project,connection).ok()?,"method":method,"params":params}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn task_rejection_requires_explicit_no_mutation_and_safe_code() {
        for failure in [
            json!({"code":-32009}),
            json!({"code":-32009,"data":{"outcome":{"kind":"unknown"}}}),
            json!({"code":"sensitive detail","data":{"outcome":{"kind":"rejected"}}}),
        ] {
            let error: anyhow::Error =
                super::super::schedule_connection::RpcFailure(failure).into();
            assert!(definitive_task_rejection(&error).is_none());
        }
        let error: anyhow::Error = super::super::schedule_connection::RpcFailure(
            json!({"code":-32602,"message":"private","data":{"outcome":{"kind":"noMutation"}}}),
        )
        .into();
        assert_eq!(
            definitive_task_rejection(&error).unwrap(),
            json!({"code":-32602,"message":"Core rejected task request","data":{"outcome":{"kind":"noMutation"}}})
        );
    }
    #[tokio::test(flavor = "current_thread")]
    async fn core_rejection_is_settled_and_original_request_is_never_redispatched() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;
        tokio::task::LocalSet::new().run_until(async {
            let root = tempfile::tempdir().unwrap();
            let host = Rc::new(super::super::schedules::tests::fixture(root.path()));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let registration = host.slots.borrow()["project"].registration.clone();
            let service = areal_protocol::service::Service {
                identity: areal_protocol::service::Identity { protocol_version: 1, service_id: "fixture".into(), generation: "first".into(), workspace: registration.workspace, data_dir: registration.data_dir, config_fingerprint: "fixture".into() },
                owner: Some(host.owner()), endpoint: format!("ws://{}/", listener.local_addr().unwrap()), web_url: String::new(), auth_file: host.home.join("core-auth.json"), log_file: host.home.join("core.log"), host_pid: 1, core_pid: 2, state: areal_protocol::service::State::Ready,
            };
            storage::write(&service.auth_file, &json!({"principals":[{"id":"desktop-owner","token":"fixture-owner-token"}]})).unwrap();
            let gate = host.slots.borrow()["project"].gate.clone();
            let _guard = gate.write().await;
            { let mut slots = host.slots.borrow_mut(); let slot = slots.get_mut("project").unwrap(); slot.service = Some(service.clone()); slot.state = "ready".into();
              let (writer, lifetime) = areal_local_service::OwnerLifetime::pair().unwrap(); slot.writer = Some(writer); slot.lifetime = Some(Rc::new(lifetime)); }
            let count = Rc::new(std::cell::Cell::new(0));
            let observed = count.clone();
            let server = tokio::task::spawn_local(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                while let Some(Ok(Message::Text(text))) = socket.next().await {
                    let call: Value = serde_json::from_str(&text).unwrap();
                    if call["method"] == "initialized" { continue; }
                    let response = if call["method"] == "initialize" { json!({"id":call["id"],"result":{}}) } else if matches!(call["method"].as_str(), Some("areal/conversation/list" | "areal/work/overview")) {
                        json!({"id":call["id"],"result":{"data":[],"nextCursor":null}})
                    } else {
                        assert_eq!(call["method"], "areal/task/stopRun"); observed.set(observed.get()+1);
                        if call["params"]["taskId"] == "lost" { break; }
                        json!({"id":call["id"],"error":{"code":-32009,"message":"revision conflict","data":{"outcome":{"kind":"rejected"}}}})
                    };
                    socket.send(Message::Text(response.to_string().into())).await.unwrap();
                }
            });
            let close = host.schedules.connections.connect_test_core(host.clone(), "project", service).await.unwrap();
            assert!(host.schedules.connections.shared_identity(&host, "project").is_ok());
            let request = uuid::Uuid::new_v4().to_string();
            let params = json!({"sourceId":"host","projectId":"project","operation":"taskStopRun","requestId":request,"taskId":"task","expectedRevision":9,"expectedRunId":"run"});
            for attempt in 0..2 {
                let error = native_command(&host, "local", &params).await.unwrap_err();
                let failure = error.downcast_ref::<TaskRejection>()
                    .unwrap_or_else(|| panic!("attempt {attempt}: {error}; dispatches {}", count.get()));
                assert_eq!(failure.0["code"], -32009);
                assert_eq!(failure.0["data"]["outcome"]["kind"], "rejected");
            }
            assert_eq!(count.get(), 1);
            let mut changed = params.clone(); changed["expectedRevision"] = json!(10);
            assert_eq!(native_command(&host, "local", &changed).await.unwrap_err().to_string(), "COMMAND_CONFLICT");
            let error = native_receipt(&host, "local", &params).await.unwrap_err();
            assert_eq!(error.downcast_ref::<TaskRejection>().unwrap().0["code"], -32009);
            let lost_id = uuid::Uuid::new_v4().to_string();
            let mut lost = params.clone(); lost["requestId"] = json!(lost_id); lost["taskId"] = json!("lost");
            assert!(native_command(&host, "local", &lost).await.is_err());
            assert_eq!(native_command(&host, "local", &lost).await.unwrap_err().to_string(), "SUBMISSION_UNKNOWN");
            assert_eq!(count.get(), 2);
            let scope = format!("tasks-{}", storage::digest(b"local"));
            let (_, snapshot) = host.journal.native_snapshot(&scope).unwrap();
            assert!(snapshot["pending"].as_array().unwrap().iter().any(|row| row["requestId"] == lost_id));
            close(); server.abort();
        }).await;
    }
    #[test]
    fn task_read_uses_core_target_after_desktop_owner_routing() {
        let input = json!({"sourceId":"source","projectId":"project","executionProjectId":"project","operation":"task","taskId":"task","threadId":"owner-thread"});
        let query = read_params("areal/task/read", &input);
        let target: areal_protocol::tasks::TaskTarget = serde_json::from_value(query).unwrap();
        assert_eq!(target.task_id, "task");
        let channel = read_params(
            "areal/channel/read",
            &json!({"taskId":"task","threadId":"owner-thread","afterSequence":4,"limit":10}),
        );
        let channel: areal_protocol::tasks::ChannelRead = serde_json::from_value(channel).unwrap();
        assert_eq!(
            (
                channel.task_id.as_str(),
                channel.after_sequence,
                channel.limit
            ),
            ("task", Some(4), Some(10))
        );
    }
    #[test]
    fn scheduled_task_directory_requires_reserved_source_owner() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let target = root.join("scheduled-task");
        let params = json!({"cwd":target});
        let ordinary = json!({"root":root,"projectless":true,"projectlessRequestId":"ordinary"});
        assert!(task_thread_cwd(&root, &params, &[ordinary]).is_err());
        let scratch = json!({"root":root,"projectless":true,"projectlessRequestId":"00000000-0000-4000-a000-5c4a7c400001"});
        assert_eq!(
            task_thread_cwd(&root, &params, &[scratch.clone()]).unwrap(),
            (target.clone(), true)
        );
        assert!(
            !target.exists(),
            "Host validates but never creates the directory"
        );
        let request = "2dd38d32-36de-469b-951a-15caad2ed810";
        assert_eq!(
            task_thread_cwd(&root, &json!({"requestId":request}), &[scratch.clone()]).unwrap(),
            (root.join(request), true)
        );
        assert!(task_thread_cwd(&root, &json!({"cwd":root}), &[scratch.clone()]).is_err());
        assert!(
            task_thread_cwd(&root, &json!({"requestId":"../escape"}), &[scratch.clone()]).is_err()
        );
        for cwd in [
            root.join("../escape"),
            root.join("nested/child"),
            root.join(".hidden"),
        ] {
            assert!(task_thread_cwd(&root, &json!({"cwd":cwd}), &[scratch.clone()]).is_err());
        }
        assert_eq!(
            task_thread_cwd(&root, &json!({}), &[]).unwrap(),
            (root, false)
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn passive_task_observation_never_restarts_a_stopped_project() {
        let root = tempfile::tempdir().unwrap();
        let host = Rc::new(super::super::schedules::tests::fixture(root.path()));
        host.schedules.suppress("project", true).unwrap();
        host.slots.borrow_mut().get_mut("project").unwrap().state = "stopped".into();
        let params = json!({"sourceId":"host","projectId":"project"});
        assert_eq!(resolve_project(&host, &params).await.unwrap(), "project");
        let error = observe(&host, &params).await.unwrap_err();
        assert_eq!(
            error.downcast_ref::<crate::wire::Error>().unwrap().code,
            "scheduleHostUnavailable"
        );
        assert!(host.schedules.suppressed("project"));
        assert_eq!(host.slots.borrow()["project"].state, "stopped");
        assert_eq!(
            std::fs::read_dir(host.home.join("host/operations"))
                .unwrap()
                .count(),
            0,
            "被动基线不得受理 project.ensure"
        );
        assert!(
            !host.slots.borrow()["project"]
                .registration
                .data_dir
                .exists()
        );
    }
    #[tokio::test(flavor = "current_thread")]
    async fn stopped_observe_reads_published_catalog_without_waking_core() {
        let root = tempfile::tempdir().unwrap();
        let host = Rc::new(super::super::schedules::tests::fixture(root.path()));
        let registration = host.slots.borrow()["project"].registration.clone();
        storage::private_dir(&registration.data_dir).unwrap();
        storage::write(
            &registration.data_dir.join("service-workspace"),
            &registration.workspace.canonicalize().unwrap(),
        )
        .unwrap();
        host.slots.borrow_mut().get_mut("project").unwrap().state = "stopped".into();
        let result = read(
            &host,
            &json!({"sourceId":"host","projectId":"project","operation":"observe"}),
        )
        .await
        .unwrap();
        assert_eq!(result["data"], json!([]));
        assert_eq!(result["owners"][0]["source"], "published");
        assert_eq!(result["owners"][0]["status"], "unobserved");
        assert_eq!(result["owners"][0]["coverage"]["kind"], "empty");
        assert_eq!(host.slots.borrow()["project"].state, "stopped");
        assert_eq!(
            std::fs::read_dir(host.home.join("host/operations"))
                .unwrap()
                .count(),
            0
        );
    }
    #[test]
    fn published_catalog_keeps_bounded_migration_diagnostics() {
        for reason in ["unbound", "legacyFormat", "readBudgetExceeded"] {
            let error = require_published_catalog(&json!({"kind":"requiresCore","reason":reason}))
                .unwrap_err();
            assert_eq!(
                catalog_error_message(&error),
                format!("任务目录需要启动原工作区完成迁移或检查：{reason}")
            );
        }
        let error = require_published_catalog(
            &json!({"kind":"requiresCore","reason":"unregistered-secret"}),
        )
        .unwrap_err();
        assert_eq!(
            catalog_error_message(&error),
            "任务目录暂不可用，尚不能确认实时状态"
        );
        assert!(require_published_catalog(&json!({"kind":"snapshot"})).is_ok());
    }
    #[test]
    fn owner_index_keeps_removed_hosts_and_legacy_identity_constraints() {
        let home = tempfile::tempdir().unwrap();
        let directory = home.path().join("task-owners");
        storage::private_dir(&directory).unwrap();
        storage::write(&directory.join("old-owner.json"), &json!(["legacy-task",{"id":"anchored-task","threadId":"original-thread","ambiguous":true}])).unwrap();
        storage::write(
            &directory.join("other-owner.json"),
            &json!([{"id":"legacy-task"}]),
        )
        .unwrap();
        let records = owner_records(home.path()).unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records["old-owner"][0], json!({"id":"legacy-task"}));
        assert_eq!(records["old-owner"][1]["threadId"], "original-thread");
        assert_eq!(records["old-owner"][1]["ambiguous"], true);
        assert!(
            records
                .values()
                .all(|rows| rows.iter().any(|row| row["id"] == "legacy-task"))
        );
        assert!(owner_file(home.path(), "../other-owner").is_err());
    }

    #[test]
    fn native_controls_preserve_identity_and_reject_extra_core_parameters() {
        let input = json!({"sourceId":"host","projectId":"p","logicalProjectId":"logical","executionProjectId":"execution","operation":"taskStopRun","threadId":"owner-thread","requestId":"11111111-1111-4111-8111-111111111111","taskId":"t","expectedRevision":2,"expectedRunId":"r"});
        assert_eq!(
            mutation_params("taskStopRun", input.clone()).unwrap(),
            json!({"requestId":"11111111-1111-4111-8111-111111111111","taskId":"t","expectedRevision":2,"expectedRunId":"r"})
        );
        for operation in [
            "taskPause",
            "taskResume",
            "taskCancel",
            "taskDelete",
            "taskResumeRun",
        ] {
            let mut routed = input.clone();
            routed["operation"] = json!(operation);
            let native = mutation_params(operation, routed).unwrap();
            assert!(native.get("threadId").is_none());
            assert_eq!(native["taskId"], "t");
            assert_eq!(native["expectedRunId"], "r");
        }
        let mut illegal = input;
        illegal["providerSecret"] = json!("unregistered");
        assert!(mutation_params("taskStopRun", illegal).is_err());
    }
    #[test]
    fn desktop_draft_start_strips_routing_and_preserves_core_identity() {
        let request = "86c4e608-6b00-49b9-a6bc-f753977c612d";
        let input = json!({"sourceId":"source","projectId":"logical","logicalProjectId":"logical","executionProjectId":"execution","operation":"taskDraftStart","draftId":request,"requestId":request,"cwd":"/isolated/workspace","timeZone":"Asia/Shanghai","parameters":{"maxOutputTokens":16384,"reasoningEffort":null,"temperature":null}});
        let native = mutation_params("taskDraftStart", input.clone()).unwrap();
        let decoded: areal_protocol::tasks::TaskDraftRequest =
            serde_json::from_value(native.clone()).unwrap();
        assert_eq!(decoded.draft_id.as_deref(), Some(request));
        assert_eq!(decoded.request_id.as_deref(), Some(request));
        assert_eq!(decoded.cwd.as_deref(), Some("/isolated/workspace"));
        assert_eq!(decoded.time_zone.as_deref(), Some("Asia/Shanghai"));
        assert_eq!(native["parameters"]["maxOutputTokens"], 16384);
        for field in [
            "sourceId",
            "projectId",
            "logicalProjectId",
            "executionProjectId",
        ] {
            assert!(native.get(field).is_none());
        }
        let mut unknown = input;
        unknown["providerSecret"] = json!("unregistered");
        assert!(mutation_params("taskDraftStart", unknown).is_err());
    }
    #[test]
    fn execution_prelude_identity_matches_desktop() {
        assert_eq!(
            execution_request_id("11111111-1111-4111-8111-111111111111"),
            "1945967b-a01b-49fa-a055-13479571cd54"
        );
    }
}
