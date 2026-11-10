//! 桌面生命周期聚合只在 Host 写回执；单项目停止继续复用原 Host 受理与清理证明。
use super::*;
use serde::Deserialize;
use std::{cell::RefCell, path::Path};

thread_local! {
    static GATES: RefCell<BTreeMap<PathBuf, Rc<Mutex<()>>>> = RefCell::default();
    static OWNERS: RefCell<BTreeMap<String, (String,String)>> = RefCell::default();
}
const KINDS: &[&str] = &[
    "stopDesktop",
    "updateDesktop",
    "stopProject",
    "updateProject",
    "interruptTurn",
];
const UNRESOLVED: &[&str] = &[
    "acceptedPending",
    "admissionUnconfirmed",
    "settlementIncomplete",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    request_id: String,
    kind: String,
    mode: String,
    expected_desktop_generation: String,
    expected_targets: Vec<Target>,
    thread_id: Option<String>,
    turn_id: Option<String>,
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    project_id: String,
    service_id: String,
    generation: String,
}

fn directory(host: &Host, source: &str) -> Result<PathBuf> {
    Ok(host
        .migration
        .power_sources()?
        .remove(source)
        .context("FORBIDDEN")?
        .join("lifecycle-operations"))
}
fn path(directory: &Path, request: &str) -> Result<PathBuf> {
    uuid::Uuid::parse_str(request).context("LIFECYCLE_INVALID_REQUEST")?;
    Ok(directory.join(format!("{request}.json")))
}
fn read(directory: &Path, request: &str) -> Result<Option<Value>> {
    let path = path(directory, request)?;
    let Some(bytes) = crate::migration::read_bytes(&path)? else {
        return Ok(None);
    };
    let value: Value = serde_json::from_slice(&bytes).context("LIFECYCLE_RECEIPT_INVALID")?;
    ensure!(
        value["version"] == 1 && value["requestId"] == request && value["targets"].is_array(),
        "LIFECYCLE_RECEIPT_INVALID"
    );
    Ok(Some(value))
}
fn records(directory: &Path) -> Result<Vec<Value>> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut records = Vec::new();
    for entry in entries {
        let entry = entry?;
        if let Some(name) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.strip_suffix(".json"))
        {
            ensure!(records.len() < 65536, "LIMIT_EXCEEDED");
            if let Some(record) = read(directory, name)? {
                records.push(record);
            }
        }
    }
    Ok(records)
}
fn store(host: &Host, directory: &Path, record: &Value) -> Result<()> {
    areal_local_service::storage::private_dir(directory)?;
    let id = record["requestId"]
        .as_str()
        .context("LIFECYCLE_RECEIPT_INVALID")?;
    let path = path(directory, id)?;
    let bytes = serde_json::to_vec(record)?;
    if crate::migration::read_bytes(&path)?.as_deref() == Some(bytes.as_slice()) {
        return Ok(());
    }
    crate::migration::atomic_bytes(&path, &bytes)?;
    host.changed();
    Ok(())
}
fn public_record(mut record: Value) -> Value {
    if let Some(object) = record.as_object_mut() {
        object.remove("rustOwner");
        object.remove("rustSemantic");
    }
    record
}
fn desktop(kind: &str) -> bool {
    matches!(kind, "stopDesktop" | "updateDesktop")
}
fn derive(record: &mut Value) {
    let phases: Vec<_> = record["targets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|target| {
            target["phase"]
                .as_str()
                .unwrap_or("settlementIncomplete")
                .to_owned()
        })
        .collect();
    record["phase"] = json!(if record.get("desktopError").is_some() {
        "settlementIncomplete"
    } else if phases.iter().all(|phase| phase == "completed") {
        if desktop(record["kind"].as_str().unwrap_or("")) {
            "acceptedPending"
        } else {
            "completed"
        }
    } else if phases.iter().any(|phase| phase != &phases[0]) {
        "partial"
    } else if phases[0] == "notAttempted" {
        "acceptedPending"
    } else {
        &phases[0]
    });
}
fn bindings(host: &Host, source: &str) -> Result<BTreeMap<String, String>> {
    let registrations: Vec<_> = host
        .slots
        .borrow()
        .values()
        .map(|slot| slot.registration.clone())
        .collect();
    let mut result = BTreeMap::new();
    for (canonical, alias) in host.migration.remote_bindings(source, &registrations)? {
        ensure!(result.insert(alias, canonical).is_none(), "RESYNC_REQUIRED");
    }
    Ok(result)
}
fn checked_target(
    host: &Host,
    bindings: &BTreeMap<String, String>,
    target: &Value,
) -> Result<String> {
    let alias = target["projectId"]
        .as_str()
        .context("LIFECYCLE_RECEIPT_INVALID")?;
    let canonical = bindings.get(alias).context("CONFIRMATION_STALE")?;
    let slots = host.slots.borrow();
    let service = slots
        .get(canonical)
        .and_then(|slot| slot.service.as_ref())
        .context("CONFIRMATION_STALE")?;
    ensure!(
        target["serviceId"] == service.identity.service_id
            && target["generation"] == service.identity.generation,
        "CONFIRMATION_STALE"
    );
    Ok(canonical.clone())
}
pub(super) fn current_generation(source: &str) -> Option<String> {
    OWNERS.with(|owners| owners.borrow().get(source).map(|owner| owner.1.clone()))
}
pub(super) fn host_receipt(target: &mut Value, operation: &Value, cancel: bool) -> Result<()> {
    ensure!(
        operation["version"] == 1
            && operation["requestId"] == target["requestId"]
            && operation["serviceId"] == target["serviceId"]
            && operation["serviceGeneration"] == target["generation"]
            && operation["strategy"] == if cancel { "cancel" } else { "ifIdle" },
        "LIFECYCLE_RECEIPT_INVALID"
    );
    let phase = operation["state"]
        .as_str()
        .context("LIFECYCLE_RECEIPT_INVALID")?;
    ensure!(
        matches!(
            phase,
            "acceptedPending"
                | "blocked"
                | "admissionUnknown"
                | "settlementIncomplete"
                | "completed"
        ),
        "LIFECYCLE_RECEIPT_INVALID"
    );
    let mut receipt = operation.clone();
    receipt["generation"] = target["generation"].clone();
    receipt["cancel"] = json!(cancel);
    target["hostReceipt"] = receipt;
    target["phase"] = json!(if phase == "admissionUnknown" {
        "admissionUnconfirmed"
    } else {
        phase
    });
    target.as_object_mut().unwrap().remove("error");
    Ok(())
}
async fn turn(
    host: &Host,
    canonical: &str,
    target: &Value,
    thread: &str,
    id: &str,
) -> Result<Option<Value>> {
    let scope = host
        .schedules
        .connections
        .shared_identity(host, canonical)?;
    ensure!(
        target["serviceId"] == scope.0 && target["generation"] == scope.1,
        "CONFIRMATION_STALE"
    );
    let result = host
        .schedules
        .connections
        .remote_request(
            host,
            canonical,
            (&scope.0, &scope.1, &scope.2),
            "thread/read",
            json!({"threadId":thread,"includeTurns":true}),
        )
        .await?;
    ensure!(
        result["thread"]["id"] == thread,
        "LIFECYCLE_RECEIPT_INVALID"
    );
    let turns = result["thread"]["turns"]
        .as_array()
        .context("LIFECYCLE_RECEIPT_INVALID")?;
    Ok(turns.iter().find(|turn| turn["id"] == id).cloned())
}
async fn settle(
    host: &Host,
    bindings: &BTreeMap<String, String>,
    record: &mut Value,
) -> Result<()> {
    let cancel = record["mode"] == "cancel";
    let interrupt = record["kind"] == "interruptTurn";
    let thread = record["threadId"].as_str().unwrap_or("").to_owned();
    let turn_id = record["turnId"].as_str().unwrap_or("").to_owned();
    for target in record["targets"].as_array_mut().unwrap() {
        if !UNRESOLVED.contains(&target["phase"].as_str().unwrap_or("")) {
            continue;
        }
        if interrupt {
            if let Ok(canonical) = checked_target(host, bindings, target)
                && let Some(turn) = turn(host, &canonical, target, &thread, &turn_id).await?
                && matches!(
                    turn["status"].as_str(),
                    Some("completed" | "failed" | "interrupted")
                )
            {
                target["phase"] = json!("completed");
                target.as_object_mut().unwrap().remove("error");
            }
        } else if let Some(operation) = host
            .reconcile(
                target["requestId"]
                    .as_str()
                    .context("LIFECYCLE_RECEIPT_INVALID")?,
            )
            .await?
        {
            host_receipt(target, &operation, cancel)?;
        }
    }
    derive(record);
    Ok(())
}

pub(super) async fn read_request(
    host: &Rc<Host>,
    source: &str,
    operation: &str,
    params: &Value,
) -> Result<Value> {
    let directory = directory(host, source)?;
    if operation == "snapshot" {
        let nonce = params["ownerNonce"]
            .as_str()
            .context("LIFECYCLE_INVALID_REQUEST")?;
        uuid::Uuid::parse_str(nonce).context("LIFECYCLE_INVALID_REQUEST")?;
        let generation = OWNERS.with(|owners| {
            let mut owners = owners.borrow_mut();
            let owner = owners
                .entry(source.into())
                .or_insert_with(|| (nonce.into(), uuid::Uuid::new_v4().to_string()));
            if owner.0 != nonce {
                *owner = (nonce.into(), uuid::Uuid::new_v4().to_string());
            }
            owner.1.clone()
        });
        let records = records(&directory)?;
        let owned: Vec<_> = records
            .iter()
            .filter(|record| record["rustOwner"] == true)
            .map(|record| record["requestId"].clone())
            .collect();
        return Ok(
            json!({"desktopGeneration":generation,"ownedRequestIds":owned,
            "records":records.into_iter().map(public_record).collect::<Vec<_>>()}),
        );
    }
    let id = params["requestId"]
        .as_str()
        .context("LIFECYCLE_INVALID_REQUEST")?;
    let Some(mut record) = read(&directory, id)? else {
        return Ok(Value::Null);
    };
    if operation == "reconcile" {
        let gate = GATES.with(|gates| {
            gates
                .borrow_mut()
                .entry(directory.clone())
                .or_default()
                .clone()
        });
        let _guard = gate.lock().await;
        record = read(&directory, id)?.context("LIFECYCLE_RECEIPT_INVALID")?;
        // 旧 JS 回执保留为历史事实，不把原 UNKNOWN 迁成可重放请求。
        if record["rustOwner"] == true {
            settle(host, &bindings(host, source)?, &mut record).await?;
            store(host, &directory, &record)?;
        }
    } else {
        ensure!(operation == "read", "INVALID_PARAMS");
    }
    Ok(public_record(record))
}

pub(super) async fn command(host: &Rc<Host>, source: &str, input: Value) -> Result<Value> {
    let request: Request = serde_json::from_value(input).context("LIFECYCLE_INVALID_REQUEST")?;
    uuid::Uuid::parse_str(&request.request_id).context("LIFECYCLE_INVALID_REQUEST")?;
    ensure!(
        KINDS.contains(&request.kind.as_str())
            && matches!(request.mode.as_str(), "ifIdle" | "cancel")
            && (desktop(&request.kind) || request.expected_targets.len() == 1)
            && request.expected_targets.len() <= 65536,
        "LIFECYCLE_INVALID_REQUEST"
    );
    if request.kind == "interruptTurn" {
        ensure!(
            request.mode == "cancel"
                && request
                    .thread_id
                    .as_ref()
                    .is_some_and(|id| !id.is_empty() && id.len() <= 256)
                && request
                    .turn_id
                    .as_ref()
                    .is_some_and(|id| !id.is_empty() && id.len() <= 256),
            "LIFECYCLE_INVALID_REQUEST"
        );
    }
    let directory = directory(host, source)?;
    let gate = GATES.with(|gates| {
        gates
            .borrow_mut()
            .entry(directory.clone())
            .or_default()
            .clone()
    });
    let _guard = gate.lock().await;
    let mut targets = request.expected_targets.clone();
    targets.sort();
    ensure!(
        targets
            .windows(2)
            .all(|pair| pair[0].project_id != pair[1].project_id),
        "LIFECYCLE_INVALID_REQUEST"
    );
    let semantic = json!({"requestId":request.request_id,"kind":request.kind,"mode":request.mode,
        "desktopGeneration":request.expected_desktop_generation,"targets":targets,
        "threadId":request.thread_id,"turnId":request.turn_id});
    if let Some(record) = read(&directory, &request.request_id)? {
        let original = if record.get("rustSemantic").is_some() {
            record["rustSemantic"].clone()
        } else {
            let identities: Vec<_> = record["targets"].as_array().context("LIFECYCLE_RECEIPT_INVALID")?.iter()
                .map(|target|json!({"projectId":target["projectId"],"serviceId":target["serviceId"],"generation":target["generation"]})).collect();
            let mut targets: Vec<Target> =
                serde_json::from_value(json!(identities)).context("LIFECYCLE_RECEIPT_INVALID")?;
            targets.sort();
            json!({"requestId":record["requestId"],"kind":record["kind"],"mode":record["mode"],
                "desktopGeneration":record["desktopGeneration"],"targets":targets,
                "threadId":record["threadId"],"turnId":record["turnId"]})
        };
        ensure!(original == semantic, "LIFECYCLE_REQUEST_CONFLICT");
        return Ok(public_record(record));
    }
    ensure!(
        OWNERS.with(|owners| owners
            .borrow()
            .get(source)
            .is_some_and(|owner| owner.1 == request.expected_desktop_generation)),
        "CONFIRMATION_STALE"
    );
    let bindings = bindings(host, source)?;
    for target in &targets {
        checked_target(host, &bindings, &serde_json::to_value(target)?)?;
    }
    if desktop(&request.kind) {
        let slots = host.slots.borrow();
        let mut current: Vec<Target> = bindings
            .iter()
            .filter_map(|(alias, canonical)| {
                let slot = slots.get(canonical)?;
                let service = slot.service.as_ref()?;
                (slot.state != "stopped").then(|| Target {
                    project_id: alias.clone(),
                    service_id: service.identity.service_id.clone(),
                    generation: service.identity.generation.clone(),
                })
            })
            .collect();
        current.sort();
        ensure!(current == targets, "CONFIRMATION_STALE");
    }
    for prior in records(&directory)? {
        if prior["rustOwner"] != true {
            continue;
        }
        ensure!(
            !prior["targets"]
                .as_array()
                .unwrap()
                .iter()
                .any(
                    |target| UNRESOLVED.contains(&target["phase"].as_str().unwrap_or(""))
                        && targets
                            .iter()
                            .any(|requested| target["projectId"] == requested.project_id)
                ),
            "LIFECYCLE_INCOMPLETE"
        );
    }
    if desktop(&request.kind) {
        let dependencies = host
            .gateway
            .workbench
            .backend_private("lifecycle.dependencies", json!({}))
            .await?;
        ensure!(
            dependencies["inflight"] == 0
                && dependencies["starting"] == 0
                && dependencies["providerUpdating"] == false
                && (request.kind != "updateDesktop"
                    || dependencies["clients"]
                        .as_u64()
                        .is_some_and(|count| count <= 1)),
            "LIFECYCLE_BLOCKED"
        );
    }
    // 停止的观察属于原命令，不能依赖界面的线程阅读订阅；先订阅再派发，避免漏掉快速终态。
    let mut observation = if request.kind == "interruptTurn" {
        let target = &targets[0];
        let (_, _, observation) = host
            .schedules
            .connections
            .conversation_observe(
                host,
                &bindings[&target.project_id],
                &target.generation,
                request.thread_id.as_deref().unwrap(),
                64 * 1024,
            )
            .await?;
        ensure!(
            observation.service().identity.service_id == target.service_id,
            "CONFIRMATION_STALE"
        );
        Some(observation)
    } else {
        None
    };
    let target_rows: Vec<_> = targets.iter().map(|target| {
        let canonical = &bindings[&target.project_id];
        let data_dir = host.slots.borrow()[canonical].registration.data_dir.clone();
        json!({"projectId":target.project_id,"serviceId":target.service_id,"generation":target.generation,
            "dataDir":data_dir,"requestId":uuid::Uuid::new_v4().to_string(),"phase":"notAttempted"})
    }).collect();
    let mut record = json!({"version":1,"requestId":request.request_id,"kind":request.kind,"mode":request.mode,
        "desktopGeneration":request.expected_desktop_generation,"targets":target_rows,"harnessHome":host.home,
        "sharedHost":true,"phase":"acceptedPending","desktopExit":"notRequested","rustOwner":true,"rustSemantic":semantic});
    if let Some(thread) = &request.thread_id {
        record["threadId"] = json!(thread);
    }
    if let Some(turn) = &request.turn_id {
        record["turnId"] = json!(turn);
    }
    store(host, &directory, &record)?;
    for index in 0..targets.len() {
        let target = record["targets"][index].clone();
        let canonical = checked_target(host, &bindings, &target)?;
        record["targets"][index]["phase"] = json!("acceptedPending");
        store(host, &directory, &record)?;
        let dispatched = if request.kind == "interruptTurn" {
            let thread_id = request.thread_id.as_deref().unwrap();
            let turn_id = request.turn_id.as_deref().unwrap();
            let scope = host
                .schedules
                .connections
                .shared_identity(host, &canonical)?;
            match turn(host, &canonical, &target, thread_id, turn_id).await {
                Ok(Some(turn)) if turn["status"] == "inProgress" => host
                    .schedules
                    .connections
                    .remote_request(
                        host,
                        &canonical,
                        (&scope.0, &scope.1, &scope.2),
                        "turn/interrupt",
                        json!({"threadId":thread_id,"turnId":turn_id}),
                    )
                    .await
                    .map(|_| Value::Null),
                _ => {
                    record["targets"][index]["phase"] = json!("blocked");
                    Ok(Value::Null)
                }
            }
        } else {
            host.stop_project(Stop {
                request_id: target["requestId"].as_str().unwrap().into(),
                expected_generation: host.identity.generation.clone(),
                strategy: if request.mode == "cancel" {
                    StopStrategy::Cancel
                } else {
                    StopStrategy::IfIdle
                },
                suppress_scheduling: request.kind == "stopProject",
                project_id: Some(canonical),
                service_generation: Some(targets[index].generation.clone()),
            })
            .await
        };
        match dispatched {
            Ok(operation) if !operation.is_null() => host_receipt(
                &mut record["targets"][index],
                &operation,
                request.mode == "cancel",
            )?,
            Ok(_) => {}
            Err(_) => record["targets"][index]["phase"] = json!("admissionUnconfirmed"),
        }
        derive(&mut record);
        store(host, &directory, &record)?;
    }
    // 等权威状态变化，不重复执行原写操作；超时仍保留未决事实供原 ID 核查。
    let mut changes = host.changes.subscribe();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        if let Err(cause) = settle(host, &bindings, &mut record).await {
            let classification =
                if let Some(cause) = cause.downcast_ref::<schedule_connection::RpcFailure>() {
                    json!({"kind":"coreRpc","code":cause.0["code"].as_i64()})
                } else if let Some(cause) = cause.downcast_ref::<wire::Error>() {
                    json!({"kind":"hostProtocol","code":cause.code})
                } else {
                    json!({"kind":"internal"})
                };
            eprintln!(
                "Host lifecycle: method={} stage=settleError classification={classification}",
                request.kind
            );
            break;
        }
        store(host, &directory, &record)?;
        if !record["targets"]
            .as_array()
            .unwrap()
            .iter()
            .any(|target| target["phase"] == "acceptedPending")
        {
            break;
        }
        let changed = async {
            let terminal = async {
                let Some(observation) = observation.as_mut() else {
                    return std::future::pending::<bool>().await;
                };
                loop {
                    match observation.events.recv().await {
                        Ok(event)
                            if event.value["method"] == "turn/completed"
                                && event.value["params"]["threadId"] == record["threadId"]
                                && event.value["params"]["turn"]["id"] == record["turnId"] =>
                        {
                            return true;
                        }
                        Ok(_) => {}
                        // 丢帧只要求重新核原权威状态，不从通知推断完成或重派停止。
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => return true,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => return false,
                    }
                }
            };
            tokio::select! {
                result = changes.changed() => result.is_ok(),
                result = terminal => result,
            }
        };
        let changed = tokio::time::timeout_at(deadline, changed).await;
        if !matches!(changed, Ok(true)) {
            break;
        }
    }
    if desktop(&request.kind)
        && record["targets"]
            .as_array()
            .unwrap()
            .iter()
            .all(|target| target["phase"] == "completed")
    {
        if host
            .gateway
            .workbench
            .backend_private("lifecycle.flush", json!({}))
            .await
            .is_ok()
        {
            record["desktopExit"] = json!("requested");
        } else {
            record["desktopError"] =
                json!({"code":"LIFECYCLE_RECEIPT_WRITE_FAILED","message":"后台写入尚未结算"});
        }
    }
    derive(&mut record);
    store(host, &directory, &record)?;
    Ok(public_record(record))
}
