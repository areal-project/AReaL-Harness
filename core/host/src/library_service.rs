//! Host 资料库入口：依赖只读快照，整理和事件更新共用同步单写事务。
use super::{
    Ensure, Host,
    library_commands::{self, ContextView},
    library_store, worktree_catalog,
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{collections::BTreeMap, rc::Rc};

fn bindings(host: &Host, source: &str) -> Result<Vec<(String, String)>> {
    let registrations: Vec<_> = host
        .slots
        .borrow()
        .values()
        .map(|s| s.registration.clone())
        .collect();
    host.migration.remote_bindings(source, &registrations)
}
async fn rpc(host: &Host, project: &str, method: &str, params: Value) -> Result<Value> {
    let scope = host.schedules.connections.shared_identity(host, project)?;
    host.schedules
        .connections
        .remote_request(
            host,
            project,
            (&scope.0, &scope.1, &scope.2),
            method,
            params,
        )
        .await
}
async fn summaries(host: &Host, project: &str) -> Result<Vec<Value>> {
    let mut rows = Vec::new();
    let mut cursor = Value::Null;
    let mut cursors = Vec::new();
    loop {
        let result = rpc(
            host,
            project,
            "thread/list",
            json!({"limit":200,"cursor":cursor}),
        )
        .await?;
        rows.extend(
            result["data"]
                .as_array()
                .context("INVALID_RESPONSE")?
                .iter()
                .cloned(),
        );
        ensure!(rows.len() <= 65536, "LIMIT_EXCEEDED");
        cursor = result["nextCursor"].clone();
        if cursor.is_null() {
            ensure!(result["complete"] != false, "RESYNC_REQUIRED");
            break;
        }
        ensure!(
            cursor.is_string() && !cursors.contains(&cursor),
            "RESYNC_REQUIRED"
        );
        cursors.push(cursor.clone());
    }
    Ok(rows)
}

pub(super) async fn command(host: &Rc<Host>, source: &str, params: Value) -> Result<Value> {
    ensure!(
        host.gateway.workbench.rust_domain("library-rust", source),
        "CAPABILITY_UNAVAILABLE"
    );
    let home = library_store::source_home(host, source)?;
    let projects = worktree_catalog::saved_projects(&home)?;
    let aliases = bindings(host, source)?;
    let private = host.gateway.workbench.library_dependencies(source).await?;
    let current = library_store::read_source(host, source)?;
    let mut context = ContextView {
        projects,
        ..Default::default()
    };
    let shell = host.read_models.shell(host).await?;
    for project in &context.projects {
        let id = project["id"].as_str().context("INVALID_RESPONSE")?;
        let mut ids = Vec::new();
        for owner in worktree_catalog::owners(&home, id)? {
            let owner = owner["id"].as_str().context("INVALID_RESPONSE")?;
            let live = shell.projects.iter().find(|p| {
                p.alias
                    .as_ref()
                    .is_some_and(|a| a.source_id == source && a.project_id == owner)
            });
            let data = match live.map(|p| &p.summaries) {
                Some(crate::shell::Summaries::Fresh { items }) => {
                    items.iter().map(|s| s.id.clone()).collect()
                }
                _ => current["projects"][owner]["navigationSummaries"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|s| s["id"].as_str().map(str::to_owned))
                    .collect::<Vec<_>>(),
            };
            ids.extend(data);
        }
        if ids.is_empty() {
            let prefix = format!("{id}:");
            ids.extend(
                current["threads"]
                    .as_object()
                    .unwrap()
                    .keys()
                    .filter_map(|k| k.strip_prefix(&prefix).map(str::to_owned)),
            );
        }
        context.summaries.insert(id.to_owned(), ids);
    }
    for cloud in private["cloudThreads"]
        .as_array()
        .context("INVALID_RESPONSE")?
    {
        context.readable.push((
            cloud["projectId"]
                .as_str()
                .context("INVALID_RESPONSE")?
                .into(),
            cloud["threadId"]
                .as_str()
                .context("INVALID_RESPONSE")?
                .into(),
        ));
    }
    if params["operation"] == "readThread" {
        if let (Some(project), Some(thread)) =
            (params["projectId"].as_str(), params["threadId"].as_str())
        {
            if let Some((canonical, _)) = aliases.iter().find(|(_, alias)| alias == project) {
                if rpc(
                    host,
                    canonical,
                    "thread/read",
                    json!({"threadId":thread,"includeTurns":false}),
                )
                .await
                .is_ok()
                {
                    context.readable.push((project.into(), thread.into()));
                }
            }
        }
    }
    if params["operation"] == "hideProject" && params["hidden"] == true {
        for owner in worktree_catalog::owners(
            &home,
            params["projectId"].as_str().context("INVALID_PARAMS")?,
        )? {
            let id = owner["id"].as_str().context("INVALID_RESPONSE")?;
            ensure!(
                !private["pendingProjects"]
                    .as_array()
                    .context("INVALID_RESPONSE")?
                    .iter()
                    .any(|p| p == id),
                "工作区仍有活动任务或排队消息，请先处理后再移出侧边栏"
            );
            let canonical = &aliases
                .iter()
                .find(|(_, alias)| alias == id)
                .context("RESOURCE_UNAVAILABLE")?
                .0;
            host.ensure(Ensure {
                request_id: uuid::Uuid::new_v4().to_string(),
                expected_generation: host.identity.generation.clone(),
                project_id: canonical.clone(),
                no_auto_restart: false,
                resume_scheduling: false,
                launch_inputs: None,
                credentials: BTreeMap::new(),
            })
            .await?;
            for summary in summaries(host, canonical).await? {
                let result = rpc(
                    host,
                    canonical,
                    "thread/read",
                    json!({"threadId":summary["id"],"includeTurns":true}),
                )
                .await?;
                let thread = &result["thread"];
                ensure!(
                    !thread["turns"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|t| t["status"] == "inProgress")
                        && !thread["desktop"]["queue"]["items"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .any(|i| i["status"] == "pending" || i["status"] == "running"),
                    "工作区仍有活动任务或排队消息，请先处理后再移出侧边栏"
                );
            }
        }
    }
    ensure!(
        host.gateway.workbench.rust_domain("library-rust", source),
        "RESYNC_REQUIRED"
    );
    let value = library_store::change(host, source, |state| {
        library_commands::apply(state, &params, &context)
    })?;
    host.gateway.workbench.library_changed().await;
    Ok(value)
}

pub(super) fn record_summaries(
    host: &Host,
    source: &str,
    alias: &str,
    summaries: &[Value],
) -> Result<()> {
    let rows: Vec<_> = summaries.iter().map(|summary| {
        let mut row = json!({"id":summary["id"],"desktop":{"archived":summary["desktop"]["archived"]==true}});
        for key in ["parentThreadId","name","preview"] { if summary[key].is_string() { row[key] = summary[key].clone(); } }
        for key in ["createdAt","updatedAt"] { if summary[key].is_number() { row[key] = summary[key].clone(); } }
        if summary["conversation"]["kind"].is_string() { row["conversation"] = json!({"kind":summary["conversation"]["kind"]}); }
        row
    }).collect();
    library_store::change(host, source, |state| {
        let meta = state["projects"]
            .as_object_mut()
            .unwrap()
            .entry(alias)
            .or_insert_with(|| json!({}));
        meta["navigationSummaries"] = json!(rows);
        Ok(())
    })?;
    Ok(())
}

pub(super) fn core_event(host: &Rc<Host>, project: &str, event: &Value) -> Result<()> {
    if event["method"] == "areal/task/updated" {
        if host.gateway.workbench.rust_source("library-rust").is_none() {
            return Ok(());
        }
        let host = host.clone();
        let project = project.to_owned();
        let task_id = event["params"]["taskId"].clone();
        tokio::task::spawn_local(async move {
            let result: Result<()> = async {
                let task = rpc(
                    &host,
                    &project,
                    "areal/task/read",
                    json!({"taskId":task_id}),
                )
                .await?;
                record_scheduled(&host, &project, &task).await
            }
            .await;
            if result.is_err() {
                eprintln!("Host library scheduled observation failed");
            }
        });
        return Ok(());
    }
    let method = event["method"].as_str().unwrap_or("");
    if !["thread/started", "turn/started", "turn/completed"].contains(&method) {
        return Ok(());
    }
    let params = &event["params"];
    let Some(thread) = params["threadId"]
        .as_str()
        .or_else(|| params["thread"]["id"].as_str())
    else {
        return Ok(());
    };
    let completion = (method == "turn/completed")
        .then(|| {
            params["turn"]["id"]
                .as_str()
                .or_else(|| params["turnId"].as_str())
        })
        .flatten();
    record_thread_activity(host, project, thread, completion)
}

pub(super) fn record_thread_activity(
    host: &Rc<Host>,
    project: &str,
    thread: &str,
    completion: Option<&str>,
) -> Result<()> {
    let Some(source) = host.gateway.workbench.rust_source("library-rust") else {
        return Ok(());
    };
    let aliases = bindings(host, &source)?;
    let Some((_, alias)) = aliases.iter().find(|(canonical, _)| canonical == project) else {
        return Ok(());
    };
    let home = library_store::source_home(host, &source)?;
    let projects = worktree_catalog::saved_projects(&home)?;
    let logical = projects
        .iter()
        .find(|p| p["id"] == *alias)
        .and_then(|p| p["logicalProjectId"].as_str())
        .unwrap_or(alias);
    library_store::change(host, &source, |state| {
        let meta = state["projects"]
            .as_object_mut()
            .unwrap()
            .entry(logical)
            .or_insert_with(|| json!({}));
        let mut order = vec![json!(thread)];
        order.extend(
            meta["threadOrder"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|id| *id != thread)
                .cloned(),
        );
        meta["threadOrder"] = json!(order);
        if let Some(completion) = completion {
            let meta = state["threads"]
                .as_object_mut()
                .unwrap()
                .entry(format!("{logical}:{thread}"))
                .or_insert_with(|| json!({}));
            if meta["completionId"] != completion {
                meta["completionId"] = json!(completion);
                meta["unread"] = json!(true);
            }
        }
        Ok(())
    })?;
    let host = host.clone();
    let canonical = project.to_owned();
    let alias = alias.clone();
    let thread = thread.to_owned();
    tokio::task::spawn_local(async move {
        let result: Result<()> = async {
            let reply = rpc(
                &host,
                &canonical,
                "thread/read",
                json!({"threadId":thread,"includeTurns":false}),
            )
            .await?;
            ensure!(
                host.gateway.workbench.rust_domain("library-rust", &source),
                "RESYNC_REQUIRED"
            );
            let current = library_store::read_source(&host, &source)?;
            let mut rows = current["projects"][&alias]["navigationSummaries"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            rows.retain(|s| s["id"] != thread);
            rows.push(reply["thread"].clone());
            record_summaries(&host, &source, &alias, &rows)?;
            host.gateway.workbench.library_changed().await;
            Ok(())
        }
        .await;
        if result.is_err() {
            eprintln!("Host library summary observation failed");
        }
    });
    Ok(())
}

pub(super) async fn record_scheduled_baseline(
    host: &Rc<Host>,
    project: &str,
    rows: &[Value],
) -> Result<()> {
    if host.gateway.workbench.rust_source("library-rust").is_none() {
        return Ok(());
    }
    for row in rows.iter().filter(|row| row["mode"] == "scheduled") {
        let task = rpc(
            host,
            project,
            "areal/task/read",
            json!({"taskId":row["id"]}),
        )
        .await?;
        record_scheduled(host, project, &task).await?;
    }
    Ok(())
}

async fn record_scheduled(host: &Rc<Host>, project: &str, task: &Value) -> Result<()> {
    if task["mode"] != "scheduled" {
        return Ok(());
    }
    let Some(source) = host.gateway.workbench.rust_source("library-rust") else {
        return Ok(());
    };
    let aliases = bindings(host, &source)?;
    let Some((_, alias)) = aliases.iter().find(|(canonical, _)| canonical == project) else {
        return Ok(());
    };
    let home = library_store::source_home(host, &source)?;
    let projects = worktree_catalog::saved_projects(&home)?;
    let logical = projects
        .iter()
        .find(|p| p["id"] == *alias)
        .and_then(|p| p["logicalProjectId"].as_str())
        .unwrap_or(alias);
    for run in task["runs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|run| run["status"] == "completed")
    {
        let Some(thread) = run["threadId"].as_str() else {
            continue;
        };
        let key = format!("{logical}:{thread}");
        if library_store::read_source(host, &source)?["threads"][&key]["scheduledCompletionId"]
            == run["id"]
        {
            continue;
        }
        let reply = rpc(
            host,
            project,
            "thread/read",
            json!({"threadId":thread,"includeTurns":true}),
        )
        .await?;
        let completion = reply["thread"]["turns"]
            .as_array()
            .into_iter()
            .flatten()
            .rev()
            .find(|turn| turn["status"] == "completed")
            .and_then(|turn| turn["id"].as_str());
        let Some(completion) = completion else {
            continue;
        };
        ensure!(
            host.gateway.workbench.rust_domain("library-rust", &source),
            "RESYNC_REQUIRED"
        );
        library_store::change(host, &source, |state| {
            let meta = state["threads"]
                .as_object_mut()
                .unwrap()
                .entry(key.clone())
                .or_insert_with(|| json!({}));
            if meta["scheduledCompletionId"] == run["id"] {
                return Ok(());
            }
            meta["scheduledCompletionId"] = run["id"].clone();
            if meta["completionId"] != completion {
                meta["completionId"] = json!(completion);
                meta["unread"] = json!(true);
            }
            Ok(())
        })?;
    }
    host.gateway.workbench.library_changed().await;
    Ok(())
}

/// 桌面设置由原页面宿主校验，Host 只对有界字段作 CAS；不解释或重写其值。
pub(super) fn patch(host: &Host, source: &str, input: &Value) -> Result<Value> {
    let patches = input["patches"].as_array().context("INVALID_PARAMS")?;
    ensure!(patches.len() <= 256, "LIMIT_EXCEEDED");
    library_store::change(host, source, |state| {
        for patch in patches {
            let path = patch["path"].as_array().context("INVALID_PARAMS")?;
            ensure!(path.iter().all(Value::is_string), "INVALID_PARAMS");
            let field = path
                .first()
                .and_then(Value::as_str)
                .context("INVALID_PARAMS")?;
            let key = path
                .last()
                .and_then(Value::as_str)
                .context("INVALID_PARAMS")?;
            let target = if field == "settings" && path.len() == 2 {
                ensure!(
                    [
                        "snapShot",
                        "busyEnter",
                        "turnNotifications",
                        "permissionNotifications",
                        "questionNotifications",
                        "notificationSound",
                        "preventSleep",
                        "showInMenuBar",
                        "betaUpdates",
                        "fileOpenTarget",
                        "terminalInheritSystemProfile",
                        "hardwareAcceleration",
                        "taskNotifications",
                        "computerControlEnabled",
                        "computerControlShowEntry",
                        "computerControlProvider",
                        "browserLinkTarget",
                        "browserLocalTarget",
                        "browserFullAddress",
                        "terminalFontFamily",
                        "httpProxy",
                        "httpProxyNoProxy",
                        "httpProxyCaCertPath",
                        "computerControlExecutable",
                        "blockPrivatePreviewNetworks",
                        "projectlessDirectory",
                        "worktrees",
                        "worktreeRevision"
                    ]
                    .contains(&key),
                    "FORBIDDEN"
                );
                &mut state["settings"]
            } else {
                ensure!(
                    field == "projects"
                        && path.len() == 3
                        && ["worktreeEnvironments", "worktreeEnvironmentRevision"].contains(&key),
                    "FORBIDDEN"
                );
                state["projects"]
                    .as_object_mut()
                    .unwrap()
                    .entry(path[1].as_str().unwrap())
                    .or_insert_with(|| json!({}))
            };
            ensure!(
                target[key] == patch["before"],
                crate::wire::error("conflict", "library changed since it was read")
            );
            target[key] = patch.get("after").context("INVALID_PARAMS")?.clone();
        }
        Ok(())
    })
}
