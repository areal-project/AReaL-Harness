//! 后台提交复用 Host journal 的准入/结算事务；Core 仍拥有操作与原始回执。
use super::*;
use areal_protocol::submissions::ExpectedSubmission;
use serde::de::DeserializeOwned;

pub(super) const METHODS: &[&str] = &[
    "areal/agent/delegate",
    "areal/agent/spawn",
    "areal/blob/release",
    "areal/channel/reply",
    "areal/context/compact",
    "areal/conversation/unarchive",
    "areal/execution/apply",
    "areal/execution/cancel",
    "areal/goal/clear",
    "areal/goal/create",
    "areal/goal/pause",
    "areal/goal/resume",
    "areal/goal/update",
    "areal/hook/acknowledge",
    "areal/interaction/respond",
    "areal/mcp/app/close",
    "areal/mcp/app/open",
    "areal/mcp/app/openFromResult",
    "areal/mcp/app/request",
    "areal/mcp/app/tools/register",
    "areal/mcp/app/tools/revoke",
    "areal/mcp/extension/call",
    "areal/mcp/form/preview",
    "areal/mcp/form/resource/prepare",
    "areal/mcp/form/resource/release",
    "areal/mcp/form/resource/stage",
    "areal/mcp/form/respond",
    "areal/permissions/forget",
    "areal/plan/update",
    "areal/plugin/auth",
    "areal/plugin/auth/configure",
    "areal/plugin/component/configure",
    "areal/plugin/connection",
    "areal/plugin/connector/configure",
    "areal/plugin/development/link",
    "areal/plugin/development/unlink",
    "areal/plugin/hooks/configure",
    "areal/plugin/importArchive",
    "areal/plugin/setup",
    "areal/plugin/userConfig/set",
    "areal/process/acknowledgeCleanup",
    "areal/process/closeStdin",
    "areal/process/resize",
    "areal/process/start",
    "areal/process/terminate",
    "areal/process/write",
    "areal/provider/probe",
    "areal/provider/remove",
    "areal/provider/upsert",
    "areal/queue/pause",
    "areal/queue/remove",
    "areal/queue/reorder",
    "areal/queue/resume",
    "areal/queue/steer",
    "areal/queue/update",
    "areal/server/drain",
    "areal/server/gc",
    "areal/server/modelConfiguration/apply",
    "areal/side/close",
    "areal/side/create",
    "areal/side/start",
    "areal/task/cancel",
    "areal/task/create",
    "areal/task/delete",
    "areal/task/pause",
    "areal/task/resume",
    "areal/task/resumeRun",
    "areal/task/runNow",
    "areal/task/stopRun",
    "areal/task/update",
    "areal/thread/archive",
    "areal/thread/closeResources",
    "areal/thread/configure",
    "areal/thread/fork",
    "areal/thread/prediction",
    "areal/thread/start",
    "areal/thread/tools/attach",
    "areal/tool/acknowledge",
    "areal/turn/enqueue",
    "areal/turn/start",
    "areal/turn/submit",
    "areal/workflow/start",
    "areal/workgroup/cancel",
    "areal/workgroup/revise",
    "areal/workgroup/start",
    "thread/start",
    "turn/interrupt",
    "turn/start",
    "turn/steer",
];

fn digest<T: DeserializeOwned + serde::Serialize>(params: &Value) -> Option<String> {
    let typed: T = serde_json::from_value(params.clone()).ok()?;
    Some(areal_local_service::storage::digest(
        &serde_json::to_vec(&typed).ok()?,
    ))
}
fn request_digest(method: &str, params: &Value, caps: &Value) -> Option<String> {
    use areal_protocol::{desktop as d, tasks as t};
    match method {
        "areal/thread/start" => digest::<d::ThreadStart>(params),
        "areal/turn/start" | "areal/turn/enqueue" => digest::<d::TurnStart>(params),
        "areal/turn/submit" => digest::<d::TurnSubmit>(params),
        "areal/thread/configure" => digest::<d::ConfigureThread>(params),
        "areal/thread/fork" => digest::<d::ForkThread>(params),
        "areal/side/start" => digest::<d::SideStart>(params),
        "areal/side/create" => digest::<d::SideCreate>(params),
        "areal/side/close" => digest::<d::SideClose>(params),
        "areal/queue/steer" => digest::<d::QueueSteer>(params),
        "areal/process/start" => digest::<d::ProcessStart>(params),
        "areal/process/write"
        | "areal/process/resize"
        | "areal/process/closeStdin"
        | "areal/process/terminate" => Some(areal_local_service::storage::digest(
            &serde_json::to_vec(&json!({"id":params["id"],
                "action":method.rsplit('/').next()?,"arguments":params}))
            .ok()?,
        )),
        "turn/steer" => {
            let input: Vec<areal_protocol::Input> =
                serde_json::from_value(params["input"].clone()).ok()?;
            Some(areal_local_service::storage::digest(
                &serde_json::to_vec(&json!({"threadId":params["threadId"],
                "expectedTurnId":params["expectedTurnId"],"input":input}))
                .ok()?,
            ))
        }
        "areal/task/create" => digest::<t::TaskCreate>(params),
        "areal/task/update" => digest::<t::TaskUpdate>(params),
        "areal/task/pause" | "areal/task/resume" | "areal/task/cancel" | "areal/task/delete" => {
            digest::<t::TaskControl>(params)
        }
        "areal/task/runNow" => digest::<t::TaskRunNow>(params),
        "areal/channel/reply" => digest::<t::ChannelReply>(params),
        _ if caps["methodSemantics"][method]["receipt"] == "management" => {
            let mut params = params.clone();
            params.as_object_mut()?.remove("requestId");
            Some(areal_local_service::storage::digest(
                &serde_json::to_vec(&params).ok()?,
            ))
        }
        _ => None,
    }
}
fn semantic(method: &str, params: &Value) -> Result<String> {
    Ok(areal_local_service::storage::digest(&serde_json::to_vec(
        &json!([method, params]),
    )?))
}
fn request_id(params: &Value) -> Result<&str> {
    let id = params["requestId"].as_str().context("INVALID_PARAMS")?;
    uuid::Uuid::parse_str(id).context("INVALID_PARAMS")?;
    Ok(id)
}
fn entry_id(entry: &Value) -> Option<&str> {
    entry["operationId"]
        .as_str()
        .or_else(|| entry["params"]["requestId"].as_str())
}
fn find(host: &Host, project: &str, id: &str) -> Result<Option<Value>> {
    let (_, snapshot) = host.journal.native_snapshot(project)?;
    Ok(snapshot["outcomes"].get(id).cloned().or_else(|| {
        snapshot["pending"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| entry_id(row) == Some(id))
            .cloned()
    }))
}
async fn rpc(
    host: &Host,
    project: &str,
    lease: &str,
    method: &str,
    params: Value,
) -> Result<Value> {
    host.schedules
        .connections
        .workbench_request(host, project, lease, method, params)
        .await
}
async fn capabilities(host: &Host, project: &str, lease: &str) -> Result<Value> {
    let response = rpc(
        host,
        project,
        lease,
        "areal/capabilities",
        json!({"apiVersion":"areal.core.v1"}),
    )
    .await?;
    ensure!(
        response.get("error").is_none() && response["result"]["methodSemantics"].is_object(),
        "CORE_INCOMPATIBLE"
    );
    Ok(response["result"].clone())
}
fn wire_params(method: &str, params: &Value) -> Value {
    let mut wire = params.clone();
    wire.as_object_mut().unwrap().remove("previousItems");
    if method == "areal/agent/spawn" {
        wire.as_object_mut().unwrap().remove("threadId");
        wire.as_object_mut().unwrap().remove("requestId");
    }
    wire
}
fn result_of(receipt: &Value) -> Value {
    receipt
        .get("result")
        .cloned()
        .or_else(|| receipt["response"].get("result").cloned())
        .unwrap_or(Value::Null)
}
fn failed(receipt: &Value) -> bool {
    receipt["status"] == "failed"
        || receipt["response"].get("error").is_some()
        || receipt.get("error").is_some()
}
fn outcome(entry: &Value, receipt: &Value) -> Value {
    let result = result_of(receipt);
    let failure = receipt
        .get("error")
        .or_else(|| receipt["response"].get("error"));
    let mut operation = receipt
        .get("operation")
        .cloned()
        .unwrap_or_else(|| entry["operation"].clone());
    let thread = if entry["method"] == "areal/agent/spawn" {
        result.get("threadId")
    } else {
        entry["params"]
            .get("threadId")
            .or_else(|| receipt.get("threadId"))
            .or_else(|| result.get("threadId"))
            .or_else(|| result["thread"].get("id"))
    };
    let task = entry["params"]
        .get("taskId")
        .or_else(|| receipt.get("taskId"))
        .or_else(|| {
            if entry["method"]
                .as_str()
                .is_some_and(|method| method.starts_with("areal/task/"))
            {
                result.get("id")
            } else {
                None
            }
        });
    if matches!(
        entry["method"].as_str(),
        Some("areal/thread/start" | "areal/thread/fork" | "areal/side/start" | "areal/side/create")
    ) {
        if let Some(id) = thread {
            operation["target"] = json!({"kind":"thread","threadId":id});
        }
    } else if entry["method"] == "areal/task/create"
        && let Some(id) = task
    {
        operation["target"] = json!({"kind":"task","taskId":id});
    }
    let mut value = json!({"accepted":receipt["accepted"]!=false,"status":if failed(receipt){"failed"}else{"completed"},"operation":operation,
        "method":entry["method"],"rustOwner":true,"rustSemantic":entry["rustSemantic"],"coreScope":entry["coreScope"]});
    if receipt["accepted"] == false {
        value["admissionState"] = json!("notAdmitted");
    }
    if let Some(id) = thread {
        value["threadId"] = id.clone();
    }
    if let Some(id) = task {
        value["taskId"] = id.clone();
    }
    if let Some(id) = result.get("turnId").or_else(|| result["turn"].get("id")) {
        value["turnId"] = id.clone();
    }
    for field in ["sourceThreadId", "parentThreadId"] {
        if let Some(id) = entry["params"].get(field) {
            value[field] = id.clone();
        }
    }
    if entry["method"] == "turn/steer"
        && let Some(input) = entry["params"].get("input")
    {
        value["input"] = input.clone();
    }
    if entry["method"] == "areal/side/close" {
        value["cleanupConfirmed"] = json!(result["cleanupConfirmed"] == true);
    }
    if matches!(
        entry["method"].as_str(),
        Some("areal/workgroup/start" | "areal/workgroup/revise" | "areal/workflow/start")
    ) && result["id"].is_string()
    {
        value["workgroupId"] = result["id"].clone();
        value["planRevision"] = receipt
            .get("planRevision")
            .cloned()
            .unwrap_or_else(|| result["record"]["planRevision"].clone());
    }
    if entry["params"]["creationAdmission"].is_object() {
        value["creationAdmission"] = entry["params"]["creationAdmission"].clone();
    }
    if let Some(digest) = entry.get("digest") {
        value["digest"] = digest.clone();
    }
    if let Some(error) = failure {
        value["error"] = json!({"code":error["code"],"message":"Core operation failed"});
        value["message"] = json!("Core operation failed");
    }
    if matches!(
        entry["method"].as_str(),
        Some(
            "areal/queue/update"
                | "areal/queue/pause"
                | "areal/queue/resume"
                | "areal/queue/remove"
                | "areal/queue/reorder"
        )
    ) && result["revision"].is_u64()
    {
        value["result"] = json!({"revision":result["revision"]});
    }
    value
}
fn read_result(entry: &Value) -> Value {
    if entry.get("status").is_none() {
        return json!({"confirmed":false,"state":"unconfirmed"});
    }
    let mut value = json!({"confirmed":true,"accepted":entry["accepted"]!=false,"status":entry["status"],"operation":entry["operation"]});
    if let Some(error) = entry.get("error") {
        value["error"] = error.clone();
        value["message"] = error["message"].clone();
    } else {
        value["result"] = entry["result"].clone();
    }
    value
}
async fn original_receipt(
    host: &Host,
    project: &str,
    lease: &str,
    entry: &Value,
    caps: &Value,
) -> Result<Option<Value>> {
    let method = entry["method"].as_str().context("INVALID_PARAMS")?;
    if entry.get("coreScope").is_some() {
        let binding = &caps["features"]["threadCreationJournal"]["binding"];
        let original = &entry["coreScope"]["storeBinding"];
        ensure!(
            binding["identity"].is_string()
                && binding["identity"] == original["identity"]
                && binding["journalEpoch"] == original["journalEpoch"],
            "RESYNC_REQUIRED"
        );
    }
    if method == "areal/workgroup/revise" {
        let response = rpc(
            host,
            project,
            lease,
            "areal/workgroup/read",
            json!({"id":entry["params"]["id"]}),
        )
        .await?;
        if let Some(revision) = response["result"]["record"]["revisions"]
            [entry["params"]["requestId"]
                .as_str()
                .context("INVALID_PARAMS")?]["planRevision"]
            .as_u64()
            && entry["params"]["expectedRevision"]
                .as_u64()
                .and_then(|value| value.checked_add(1))
                == Some(revision)
        {
            return Ok(Some(
                json!({"accepted":true,"status":"completed","planRevision":revision,"result":response["result"]}),
            ));
        }
        return Ok(None);
    }
    let family = caps["methodSemantics"][method]["receipt"].as_str();
    let thread = if family == Some("thread") {
        entry["params"]["threadId"].as_str()
    } else {
        None
    };
    let mut params = json!({"requestId":entry["params"]["requestId"]});
    if let Some(thread) = thread {
        params["threadId"] = json!(thread);
    }
    if method == "areal/thread/start" && entry["params"]["creationAdmission"].is_object() {
        params["creationAdmission"] = entry["params"]["creationAdmission"].clone();
    }
    let response = rpc(host, project, lease, "areal/request/read", params).await?;
    if response.get("error").is_some() {
        return Ok(None);
    }
    let expected = ExpectedSubmission {
        method: method.into(),
        params: entry["params"].clone(),
        operation: Some(entry["operation"].clone()),
        digest: entry["digest"].as_str().map(str::to_owned),
        identity: entry["coreScope"]["storeBinding"]["identity"]
            .as_str()
            .map(str::to_owned),
        strict: false,
    };
    let receipt = areal_protocol::submissions::reconcile(
        &expected,
        &response["result"],
        &caps["features"]["threadCreationJournal"]["binding"],
        thread,
    );
    if matches!(
        method,
        "areal/process/write"
            | "areal/process/resize"
            | "areal/process/closeStdin"
            | "areal/process/terminate"
    ) {
        if let Some(receipt) = receipt {
            if failed(&receipt) {
                return Ok(Some(receipt));
            }
            let result = result_of(&receipt);
            let Some(operation) = result["operationId"].as_str() else {
                return Ok(None);
            };
            let processes = rpc(
                host,
                project,
                lease,
                "areal/process/list",
                json!({"threadId":entry["params"]["threadId"]}),
            )
            .await?;
            let input = processes["result"]["data"]
                .as_array()
                .and_then(|rows| {
                    rows.iter().find(|row| {
                        (entry["params"].get("id").is_none_or(|id| row["id"] == *id))
                            && row["inputs"].as_array().is_some_and(|inputs| {
                                inputs.iter().any(|input| input["operationId"] == operation)
                            })
                    })
                })
                .and_then(|process| process["inputs"].as_array())
                .and_then(|inputs| {
                    inputs
                        .iter()
                        .find(|input| input["operationId"] == operation)
                });
            if input.is_some_and(|input| input["outcome"] == "succeeded") {
                return Ok(Some(receipt));
            }
            if input.is_some_and(|input| input["outcome"] == "failed") {
                let mut receipt = receipt;
                receipt["status"] = json!("failed");
                receipt["error"] = json!({"message":"Terminal operation failed"});
                return Ok(Some(receipt));
            }
            return Ok(None);
        }
        return Ok(None);
    }
    Ok(receipt)
}

fn error_from_receipt(receipt: &Value, operation: &Value) -> Value {
    let mut error = receipt
        .get("error")
        .cloned()
        .or_else(|| receipt["response"].get("error").cloned())
        .unwrap_or(json!({"code":-32011,"message":"Core operation failed"}));
    if !error["code"].is_number() {
        error["code"] = json!(-32011);
    }
    if receipt["accepted"] == false {
        if !error["data"].is_object() {
            error["data"] = json!({});
        }
        error["data"]["outcome"] = json!({"kind":"rejected"});
        error["data"]["recovery"] = json!({"kind":"none"});
    } else if error["data"]["outcome"].is_null() {
        if !error["data"].is_object() {
            error["data"] = json!({});
        }
        error["data"]["outcome"] = json!({"kind":"admitted","operation":operation});
        error["data"]["recovery"] = json!({"kind":"queryOriginal"});
    }
    error
}

pub(super) async fn reconcile(
    host: &Rc<Host>,
    project: &str,
    lease: &str,
    method: &str,
    params: Value,
) -> Result<Value> {
    ensure!(METHODS.contains(&method), "FORBIDDEN");
    let id = request_id(&params)?;
    let Some(entry) = find(host, project, id)? else {
        return Ok(json!({"confirmed":false,"state":"unconfirmed"}));
    };
    ensure!(entry["method"] == method, "COMMAND_CONFLICT");
    let settled = entry.get("status").is_some();
    if entry["rustOwner"] != true {
        return Ok(json!({"confirmed":false,"state":"unconfirmed"}));
    }
    let mut original = entry.clone();
    if entry["params"].is_object() {
        for (key, value) in params.as_object().context("INVALID_PARAMS")? {
            if let Some(bound) = entry["params"].get(key) {
                ensure!(bound == value, "COMMAND_CONFLICT");
            }
        }
    } else {
        let identity_only = params
            .as_object()
            .context("INVALID_PARAMS")?
            .keys()
            .all(|key| {
                matches!(
                    key.as_str(),
                    "requestId"
                        | "threadId"
                        | "taskId"
                        | "sourceThreadId"
                        | "parentThreadId"
                        | "id"
                )
            });
        ensure!(
            identity_only || entry["rustSemantic"] == semantic(method, &params)?,
            "COMMAND_CONFLICT"
        );
        let mut bound = params;
        for field in ["threadId", "taskId", "sourceThreadId", "parentThreadId"] {
            if let Some(id) = entry.get(field) {
                if let Some(supplied) = bound.get(field) {
                    ensure!(supplied == id, "COMMAND_CONFLICT");
                }
                if method != "areal/thread/start" {
                    bound[field] = id.clone();
                }
            }
        }
        if let Some(binding) = entry.get("creationAdmission") {
            bound["creationAdmission"] = binding.clone();
            bound.as_object_mut().unwrap().remove("threadId");
        }
        if method == "areal/workgroup/revise" {
            bound["id"] = entry["workgroupId"].clone();
            if let Some(revision) = entry["planRevision"]
                .as_u64()
                .and_then(|revision| revision.checked_sub(1))
            {
                bound["expectedRevision"] = json!(revision);
            }
        }
        original["params"] = bound;
    }
    let caps = capabilities(host, project, lease).await?;
    let Some(receipt) = original_receipt(host, project, lease, &original, &caps).await? else {
        return Ok(if settled {
            read_result(&entry)
        } else {
            json!({"confirmed":false,"state":"unconfirmed"})
        });
    };
    if !matches!(receipt["status"].as_str(), Some("completed" | "failed"))
        && receipt.get("result").is_none()
        && receipt.get("response").is_none()
    {
        return Ok(json!({"confirmed":false,"state":receipt["status"]}));
    }
    let mut result = outcome(&original, &receipt);
    if !settled {
        host.journal
            .native_finish(project, &entry, Some(result.clone()))?;
        host.changed();
    }
    // 结果正文只在本次读取返回，Host journal 只保存可重建的关联投影。
    result["result"] = result_of(&receipt);
    if let Some(error) = receipt
        .get("error")
        .or_else(|| receipt["response"].get("error"))
    {
        result["error"] = error.clone();
    }
    Ok(read_result(&result))
}

pub(super) async fn submit(
    host: &Rc<Host>,
    project: &str,
    lease: &str,
    method: &str,
    params: Value,
    remember: bool,
) -> Result<Value> {
    ensure!(METHODS.contains(&method) && params.is_object(), "FORBIDDEN");
    host.schedules
        .connections
        .workbench_validate(host, project, lease, method, &params)?;
    let id = request_id(&params)?.to_owned();
    let semantic = semantic(method, &params)?;
    if let Some(entry) = find(host, project, &id)? {
        ensure!(
            entry["method"] == method
                && (entry["rustSemantic"] == semantic
                    || (entry["rustSemantic"].is_null() && entry["params"] == params)),
            "COMMAND_CONFLICT"
        );
        let result = reconcile(host, project, lease, method, params).await?;
        if result["confirmed"] != true {
            return Ok(
                json!({"error":{"code":-32011,"message":"原提交结果未知，不会重放","data":{"outcome":{"kind":"unconfirmed","operation":entry["operation"]},"recovery":{"kind":"queryOriginal"},"requestId":id}}}),
            );
        }
        // 已结算的关联事实不等于原结果正文仍可读取，不能伪造成功返回值。
        if result.get("error").is_none() && result["result"].is_null() {
            return Ok(
                json!({"error":{"code":-32011,"message":"原提交已受理，结果正文暂不可读","data":{"outcome":{"kind":"admitted","operation":entry["operation"]},"recovery":{"kind":"queryOriginal"},"requestId":id}},"sequence":0}),
            );
        }
        return Ok(if let Some(error) = result.get("error") {
            json!({"error":error_from_receipt(&json!({"error":error,"accepted":result["accepted"]}),&entry["operation"]),"sequence":0})
        } else {
            json!({"result":result["result"],"sequence":0})
        });
    }
    let caps = capabilities(host, project, lease).await?;
    ensure!(
        caps["methodSemantics"][method]["effect"] == "mutation",
        "FORBIDDEN"
    );
    host.schedules
        .connections
        .workbench_core_admit(host, project, Some(lease), method, &params)
        .await?;
    let scope = host
        .schedules
        .connections
        .workbench_identity(host, project, lease)?;
    let wire = wire_params(method, &params);
    let expected = ExpectedSubmission {
        method: method.into(),
        params: params.clone(),
        operation: None,
        digest: None,
        identity: None,
        strict: false,
    };
    let mut entry = json!({"method":method,"params":params,"operation":expected.operation(),"rustOwner":true,"rustSemantic":semantic,
        "coreScope":{"serviceId":scope.0,"generation":scope.1,"connectionId":scope.2,"storeBinding":caps["features"]["threadCreationJournal"]["binding"]}});
    if let Some(digest) = request_digest(method, &wire, &caps) {
        entry["digest"] = json!(digest);
    }
    host.admission()?;
    let (revision, snapshot) = host.journal.native_snapshot(project)?;
    host.journal
        .native_admit(project, revision, snapshot, entry.clone(), true)?;
    host.changed();
    let response = rpc(host, project, lease, method, wire).await;
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            if let Ok(Some(receipt)) = original_receipt(host, project, lease, &entry, &caps).await
                && (matches!(receipt["status"].as_str(), Some("completed" | "failed"))
                    || receipt.get("result").is_some())
            {
                let settled = outcome(&entry, &receipt);
                host.journal.native_finish(project, &entry, Some(settled))?;
                return Ok(if failed(&receipt) {
                    json!({"error":error_from_receipt(&receipt,&entry["operation"]),"sequence":0})
                } else {
                    json!({"result":result_of(&receipt),"sequence":0})
                });
            }
            return Err(error);
        }
    };
    if let Some(error) = response.get("error") {
        if matches!(
            error["data"]["outcome"]["kind"].as_str(),
            Some("rejected" | "noMutation")
        ) {
            host.journal.native_finish(project, &entry, None)?;
        }
        return Ok(response);
    }
    let result = response.get("result").context("INVALID_RESPONSE")?;
    let remember = remember
        || matches!(
            method,
            "areal/workgroup/start" | "areal/workgroup/revise" | "areal/workflow/start"
        );
    let receipt = json!({"accepted":true,"status":"completed","result":result});
    host.journal
        .native_finish(project, &entry, remember.then(|| outcome(&entry, &receipt)))?;
    host.changed();
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journal_outcome_keeps_associations_without_result_or_error_body() {
        let entry = json!({"method":"areal/turn/submit","params":{"requestId":"original","threadId":"thread","input":[{"text":"private input"}]},
            "operation":{"method":"areal/turn/submit","requestId":"original","target":{"kind":"thread","threadId":"thread"}},"rustSemantic":"digest","coreScope":{"storeBinding":{"identity":"identity"}}});
        let receipt = json!({"accepted":true,"status":"completed","result":{"threadId":"thread","turnId":"turn","privateBody":"secret"}});
        let projected = outcome(&entry, &receipt);
        assert_eq!(projected["threadId"], "thread");
        assert_eq!(projected["turnId"], "turn");
        assert_eq!(projected["rustSemantic"], "digest");
        assert!(projected.get("params").is_none());
        assert!(projected.get("result").is_none());
        let failed = outcome(
            &entry,
            &json!({"accepted":true,"status":"failed","error":{"code":-1,"message":"credential contents","data":{"secret":"value"}}}),
        );
        assert_eq!(
            failed["error"],
            json!({"code":-1,"message":"Core operation failed"})
        );
        assert_eq!(failed["accepted"], true);
    }

    #[test]
    fn only_independent_negative_receipt_becomes_definite_rejection() {
        let operation = json!({"method":"areal/thread/start","requestId":"original","target":{"kind":"project"}});
        let admitted = error_from_receipt(
            &json!({"accepted":true,"error":{"message":"failed"}}),
            &operation,
        );
        assert_eq!(admitted["data"]["outcome"]["kind"], "admitted");
        assert_eq!(admitted["data"]["recovery"]["kind"], "queryOriginal");
        let rejected = error_from_receipt(
            &json!({"accepted":false,"error":{"message":"absent with proof"}}),
            &operation,
        );
        assert_eq!(rejected["data"]["outcome"]["kind"], "rejected");
        assert_eq!(rejected["data"]["recovery"]["kind"], "none");
    }
}
