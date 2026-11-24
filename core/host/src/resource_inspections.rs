//! 状态检查只读当前共享Core；凭据、进程参数和正文不进入外壳投影。
use super::{Host, session_commands::shared_rpc};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeSet, rc::Rc};

#[derive(Deserialize, Serialize)]
struct Reason {
    code: String,
    count: u64,
}
#[derive(Deserialize, Serialize)]
struct Decision {
    allowed: bool,
    reasons: Vec<Reason>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Lifecycle {
    version: u32,
    admission: String,
    if_idle: Decision,
    settled: Decision,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveTurn {
    thread_id: String,
    turn_id: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Queue {
    thread_id: String,
    paused: bool,
    pending: u64,
    running: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    lifecycle: Lifecycle,
    resources: Vec<Value>,
    active_turns: Vec<ActiveTurn>,
    active_goals: Vec<String>,
    active_tasks: u64,
    pending_queue_items: u64,
    unresolved_tools: Vec<Value>,
    compactions: Vec<Value>,
    workgroups: Vec<Value>,
    runtime: Option<Value>,
    queues: Vec<Queue>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Process {
    id: String,
    runtime_epoch: String,
    state: String,
    argv: Vec<String>,
    cleanup_confirmed: bool,
}
#[derive(Deserialize)]
struct Processes {
    data: Vec<Process>,
}
#[derive(Deserialize)]
struct Run {
    status: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Task {
    id: String,
    thread_id: String,
    mode: String,
    objective: Option<String>,
    paused: bool,
    #[serde(default)]
    cancelled: bool,
    next_run_at: Option<i64>,
    runs: Vec<Run>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tasks {
    data: Vec<Task>,
    next_cursor: Option<String>,
}
#[derive(Deserialize, Serialize)]
struct Goal {
    status: String,
    objective: Option<String>,
}
#[derive(Deserialize)]
struct GoalResponse {
    goal: Option<Goal>,
}

async fn inspect(host: &Host, canonical: &str, alias: &str, include_tasks: bool) -> Result<Value> {
    let original = host
        .schedules
        .connections
        .shared_identity(host, canonical)?;
    let status: Status = serde_json::from_value(
        shared_rpc(host, canonical, "areal/server/status", json!({})).await?,
    )
    .context("RESOURCE_OBSERVATION_INVALID")?;
    ensure!(
        status.lifecycle.version == 1,
        "RESOURCE_OBSERVATION_INVALID"
    );
    let epoch = status.runtime.as_ref().and_then(|runtime| {
        runtime["runtimeEpoch"]
            .as_str()
            .or_else(|| runtime["epoch"].as_str())
    });
    let threads = status
        .resources
        .iter()
        .filter_map(|resource| resource["threadId"].as_str())
        .collect::<BTreeSet<_>>();
    let mut resources = Vec::new();
    for thread in threads {
        let processes: Processes = serde_json::from_value(
            shared_rpc(
                host,
                canonical,
                "areal/process/list",
                json!({"threadId":thread}),
            )
            .await?,
        )
        .context("RESOURCE_OBSERVATION_INVALID")?;
        for process in processes
            .data
            .into_iter()
            .filter(|process| !process.cleanup_confirmed)
        {
            resources.push(json!({"projectId":alias,"threadId":thread,"id":process.id,"epoch":process.runtime_epoch,"state":process.state,"executable":process.argv.first().map(String::as_str).unwrap_or(""),"stale":epoch.is_some_and(|epoch|epoch!=process.runtime_epoch)}));
        }
    }
    let mut tasks = Vec::new();
    let mut goals = Vec::new();
    let mut seen = BTreeSet::new();
    let mut after: Option<String> = None;
    if include_tasks {
        loop {
            let mut params = json!({"limit":100});
            if let Some(cursor) = &after {
                params["after"] = json!(cursor);
            }
            let page: Tasks = serde_json::from_value(
                shared_rpc(host, canonical, "areal/task/list", params).await?,
            )
            .context("RESOURCE_OBSERVATION_INVALID")?;
            for task in page.data {
                ensure!(tasks.len() + goals.len() < 65536, "LIMIT_EXCEEDED");
                if task.mode == "foreground" {
                    let goal: GoalResponse = serde_json::from_value(
                        shared_rpc(
                            host,
                            canonical,
                            "areal/goal/get",
                            json!({"threadId":task.thread_id}),
                        )
                        .await?,
                    )
                    .context("RESOURCE_OBSERVATION_INVALID")?;
                    if let Some(goal) = goal
                        .goal
                        .filter(|goal| !matches!(goal.status.as_str(), "completed" | "cancelled"))
                    {
                        goals.push(json!({"threadId":task.thread_id,"status":goal.status,"objective":goal.objective}));
                    }
                } else if !task.cancelled {
                    tasks.push(json!({"id":task.id,"threadId":task.thread_id,"mode":task.mode,"objective":task.objective,"paused":task.paused,"nextRunAt":task.next_run_at,"running":task.runs.iter().any(|run|run.status=="running")}));
                }
            }
            after = page.next_cursor;
            let Some(cursor) = &after else {
                break;
            };
            ensure!(
                !cursor.is_empty() && seen.len() < 65536 && seen.insert(cursor.clone()),
                "RESOURCE_OBSERVATION_INVALID"
            );
        }
    }
    ensure!(
        host.schedules
            .connections
            .shared_identity(host, canonical)?
            == original,
        "RESYNC_REQUIRED"
    );
    let mut value = json!({"observation":"known","serviceId":original.0,"generation":original.1,
        "restartSafe":status.lifecycle.if_idle.allowed,"lifecycle":status.lifecycle,"resources":resources,
        "activeTurns":status.active_turns.len(),"activeThreads":status.active_turns,"goalThreads":status.active_goals,
        "activeTasks":status.active_tasks,"waitingMessages":status.pending_queue_items,"queues":status.queues,
        "unresolvedTools":status.unresolved_tools.len(),"compactions":status.compactions.len(),
        "workgroups":status.workgroups.iter().filter(|group|group["status"]=="running" || group["cleanupConfirmed"]!=true).count()});
    if include_tasks {
        value["tasks"] = json!(tasks);
        value["goals"] = json!(goals);
    }
    Ok(value)
}

fn creation_request(entry: &Value) -> Option<&str> {
    let id = entry["params"]["requestId"].as_str()?;
    (entry["method"] == "areal/thread/start"
        && entry["params"]["threadId"].is_null()
        && entry["params"]["taskId"].is_null()
        && uuid::Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id)
        && entry.get("operation").is_none_or(|original| {
            original["requestId"] == id
                && original["method"] == "areal/thread/start"
                && original["target"]["kind"] == "project"
        }))
    .then_some(id)
}

pub(super) async fn read(host: &Rc<Host>, source: &str, request: &Value) -> Result<Value> {
    host.migration.source_profile(source)?;
    // 停机导入保留的待决记录只能在诊断读取，不能重新加入运行 journal 或阻塞后台。
    let mut archived = if request["operation"] == "status" {
        host.migration.archived_pending_creations(source)?
    } else {
        Default::default()
    };
    let include_tasks = request["includeTasks"]
        .as_bool()
        .unwrap_or(request["operation"] == "status");
    let bindings = host
        .migration
        .remote_bindings(source, &host.registrations())?;
    let mut rows = Vec::new();
    let mut safe = true;
    for (canonical, alias) in bindings {
        let (root, state, stable) = {
            let slots = host.slots.borrow();
            let slot = slots.get(&canonical).context("RESOURCE_UNAVAILABLE")?;
            (
                slot.registration.workspace.clone(),
                slot.state.clone(),
                !slot.uncertain_start && slot.migration.is_none(),
            )
        };
        let pending = host.journal.pending_read(&canonical)?;
        let mut row = if stable && state == "ready" {
            let budget =
                std::time::Duration::from_secs(if request["purpose"] == "quit" { 5 } else { 30 });
            match tokio::time::timeout(budget, inspect(host, &canonical, &alias, include_tasks))
                .await
            {
                Ok(Ok(value)) => value,
                _ => json!({"observation":"unavailable"}),
            }
        } else {
            json!({"observation":"unavailable"})
        };
        row["projectId"] = json!(alias);
        row["root"] = json!(root);
        row["started"] = json!(state == "ready");
        let mut creations = BTreeSet::new();
        let mut requests = Vec::new();
        for entry in &pending {
            let mut request = json!({"awaitingResponse":false});
            if let Some(thread) = entry["params"]["threadId"].as_str() {
                request["threadId"] = json!(thread);
            }
            if let Some(id) = creation_request(entry) {
                request["creationRequestId"] = json!(id);
                creations.insert(id.to_owned());
            }
            requests.push(request);
        }
        if let Some(entries) = archived.remove(&canonical) {
            requests.extend(
                entries
                    .iter()
                    .filter_map(creation_request)
                    .filter(|&id| creations.insert(id.to_owned()))
                    .map(|id| json!({"awaitingResponse":false,"creationRequestId":id})),
            );
        }
        row["pendingRequests"] = json!(requests);
        safe &= pending.is_empty()
            && ((stable && state == "stopped") || row["lifecycle"]["ifIdle"]["allowed"] == true)
            && !row["tasks"]
                .as_array()
                .is_some_and(|tasks| tasks.iter().any(|task| task["paused"] != true));
        rows.push(row);
    }
    host.migration.source_profile(source)?;
    if request["operation"] == "inspect" {
        return Ok(json!(rows));
    }
    let activity = host.activity().await;
    let idle = activity.complete
        && activity.projects.iter().all(|project| {
            matches!(
                project,
                crate::ProjectActivity::Observed {
                    idle_allowed: true,
                    ..
                }
            )
        });
    let updating = host.gateway.workbench.provider_updating();
    let remote_unsettled = super::remote_commands::unresolved(host, source).await;
    let starting = host
        .slots
        .borrow()
        .values()
        .filter(|slot| matches!(slot.state.as_str(), "starting" | "stopping"))
        .count();
    Ok(
        json!({"canStop":safe && idle && !updating && !remote_unsettled && starting==0,"connected":true,"busy":!idle || updating || remote_unsettled || starting>0,"starting":starting,"providerUpdating":updating,
        "projects":rows.into_iter().map(|mut row|{let object=row.as_object_mut().unwrap();object.remove("serviceId");object.remove("generation");object.remove("lifecycle");row}).collect::<Vec<_>>()}),
    )
}
