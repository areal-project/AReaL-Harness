//! 远端 Core 拥有消息与执行；Host 只保存原 Cloud 绑定、提交回执及可重建连接。
use super::{Host, library_store, workbench_submissions, worktree_catalog};
use anyhow::{Context, Result, ensure};
use areal_local_service::storage;
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    path::Path,
    rc::{Rc, Weak},
};
use tokio::sync::Mutex;

#[derive(Clone)]
pub(super) struct Scope {
    pub project: String,
    pub lease: String,
    pub identity: (String, String, String),
}
#[derive(Default)]
pub(super) struct CloudSessions {
    gates: RefCell<BTreeMap<String, Weak<Mutex<()>>>>,
    live: RefCell<BTreeMap<String, Scope>>,
}
fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 512 && !value.contains('\0'))
        .context("INVALID_PARAMS")
}
fn timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn records(home: &Path) -> Result<Vec<Value>> {
    let Some(bytes) = storage::read_bytes(&home.join("cloud-sessions.json"))? else {
        return Ok(vec![]);
    };
    ensure!(
        bytes.len() <= 8 * 1024 * 1024,
        "Cloud session index exceeds limit"
    );
    let rows: Vec<Value> = serde_json::from_slice(&bytes)?;
    ensure!(rows.len() <= 65536, "Cloud session index exceeds limit");
    Ok(rows)
}
fn virtual_id(source: &str, id: &str) -> String {
    format!("cloud-session:{source}:{id}")
}
fn parts(id: &str) -> Result<(&str, &str)> {
    let (source, id) = id
        .strip_prefix("cloud-session:")
        .and_then(|value| value.split_once(':'))
        .context("FORBIDDEN")?;
    crate::wire::request_id(source)?;
    crate::wire::request_id(id)?;
    Ok((source, id))
}
fn core_result(response: Value) -> Result<Value> {
    if let Some(error) = response.get("error") {
        return Err(super::schedule_connection::RpcFailure(error.clone()).into());
    }
    response.get("result").cloned().context("INVALID_RESPONSE")
}
impl CloudSessions {
    fn gate(&self, id: &str) -> Rc<Mutex<()>> {
        let mut gates = self.gates.borrow_mut();
        gates.retain(|_, value| value.strong_count() > 0);
        if let Some(gate) = gates.get(id).and_then(Weak::upgrade) {
            return gate;
        }
        let gate = Rc::new(Mutex::new(()));
        gates.insert(id.into(), Rc::downgrade(&gate));
        gate
    }
    fn record(&self, host: &Host, source: &str, id: &str) -> Result<Value> {
        let rows = records(&library_store::source_home(host, source)?)?;
        let mut matching = rows.into_iter().filter(|row| row["id"] == id);
        let row = matching.next().context("未知 Cloud 会话")?;
        ensure!(matching.next().is_none(), "Cloud session identity conflict");
        Ok(row)
    }
    fn edit(
        &self,
        host: &Host,
        source: &str,
        id: &str,
        change: impl FnOnce(&mut Value) -> Result<()>,
    ) -> Result<Value> {
        let home = library_store::source_home(host, source)?;
        let mut rows = records(&home)?;
        let mut matching = rows.iter_mut().filter(|row| row["id"] == id);
        let row = matching.next().context("未知 Cloud 会话")?;
        change(row)?;
        let result = row.clone();
        ensure!(matching.next().is_none(), "Cloud session identity conflict");
        storage::write(&home.join("cloud-sessions.json"), &rows)?;
        host.changed();
        Ok(result)
    }
    pub(super) fn is_virtual(id: &str) -> bool {
        parts(id).is_ok()
    }
    pub(super) fn owner(&self, host: &Host, id: &str) -> Result<(String, String, String)> {
        let (source, record) = parts(id)?;
        let row = self.record(host, source, record)?;
        let alias = required(&row, "projectId")?;
        let logical = worktree_catalog::project(host, source, alias)?;
        Ok((source.into(), logical.project_id, alias.into()))
    }
    pub(super) fn bound_thread(&self, host: &Host, id: &str, thread: &str) -> Result<()> {
        let (source, record) = parts(id)?;
        let row = self.record(host, source, record)?;
        ensure!(row["binding"]["threadId"] == thread, "FORBIDDEN");
        Ok(())
    }
    pub(super) async fn request(
        &self,
        host: &Host,
        id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        self.owner(host, id)?;
        if let Some(thread) = params["threadId"].as_str() {
            self.bound_thread(host, id, thread)?;
        }
        let scope = self.scope(host, id)?;
        self.rpc(host, &scope, method, params).await
    }

    pub(super) fn scope(&self, host: &Host, id: &str) -> Result<Scope> {
        let scope = self
            .live
            .borrow()
            .get(id)
            .cloned()
            .context("Cloud 连接尚未恢复")?;
        ensure!(
            host.schedules
                .connections
                .workbench_identity(host, &scope.project, &scope.lease)?
                == scope.identity,
            "RESYNC_REQUIRED"
        );
        Ok(scope)
    }
    pub(super) fn close_all(&self, host: &Host) {
        let scopes = std::mem::take(&mut *self.live.borrow_mut());
        for scope in scopes.into_values() {
            let _ = host
                .schedules
                .connections
                .workbench_detach(host, &scope.project, &scope.lease);
        }
        host.changed();
    }
    pub(super) async fn activate(&self, host: &Rc<Host>, id: &str) -> Result<Scope> {
        self.owner(host, id)?;
        let (source, record) = parts(id)?;
        let gate = self.gate(id);
        let _guard = gate.lock().await;
        let row = self.record(host, source, record)?;
        required(&row["binding"], "threadId")?;
        self.connect(host, source, &row, false).await
    }
    async fn connect(
        &self,
        host: &Rc<Host>,
        source: &str,
        row: &Value,
        reconnect: bool,
    ) -> Result<Scope> {
        let id = required(row, "id")?;
        let project = virtual_id(source, id);
        if !reconnect {
            if let Ok(scope) = self.scope(host, &project) {
                return Ok(scope);
            }
        }
        if let Some(previous) = self.live.borrow_mut().remove(&project) {
            let _ = host.schedules.connections.workbench_detach(
                host,
                &previous.project,
                &previous.lease,
            );
        }
        ensure!(
            !row["binding"]["sessionId"]
                .as_str()
                .is_some_and(|id| id.starts_with("ses_")),
            "此旧 Cloud 会话需使用原客户端打开"
        );
        let base = required(&row["binding"], "baseURL")?;
        let attached = host
            .gateway
            .workbench
            .cloud
            .attach_owned(host, source, &project, &json!({"baseURL":base}))
            .await?;
        let lease = required(&attached, "lease")?.to_owned();
        let identity = host
            .schedules
            .connections
            .workbench_identity(host, &project, &lease)?;
        let scope = Scope {
            project: project.clone(),
            lease,
            identity,
        };
        self.live.borrow_mut().insert(project, scope.clone());
        host.changed();
        Ok(scope)
    }
    async fn rpc(&self, host: &Host, scope: &Scope, method: &str, params: Value) -> Result<Value> {
        ensure!(
            host.schedules
                .connections
                .workbench_identity(host, &scope.project, &scope.lease)?
                == scope.identity,
            "RESYNC_REQUIRED"
        );
        core_result(
            host.schedules
                .connections
                .workbench_request(host, &scope.project, &scope.lease, method, params)
                .await?,
        )
    }
    async fn submit(
        &self,
        host: &Rc<Host>,
        scope: &Scope,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        core_result(
            workbench_submissions::submit(
                host,
                &scope.project,
                &scope.lease,
                method,
                params,
                true,
                false,
            )
            .await?,
        )
    }
    pub(super) fn catalog(
        &self,
        host: &Host,
        sources: &[crate::shell::NavigationSource],
    ) -> Result<Vec<crate::shell::ShellProject>> {
        use crate::shell::{Attention, ShellProject, Summaries};
        let mut projects = Vec::new();
        for source in sources {
            let rows = match records(&source.core_home) {
                Ok(rows) => rows,
                Err(_) => {
                    eprintln!(
                        "Host Cloud index unavailable: sourceId={}",
                        source.source_id
                    );
                    continue;
                }
            };
            for row in rows {
                let (Some(id), Some(alias), Some(thread)) = (
                    row["id"].as_str(),
                    row["projectId"].as_str(),
                    row["binding"]["threadId"].as_str(),
                ) else {
                    continue;
                };
                if crate::wire::request_id(id).is_err() {
                    continue;
                }
                let Ok(logical) = worktree_catalog::project(host, &source.source_id, alias) else {
                    continue;
                };
                let project = virtual_id(&source.source_id, id);
                let live = self.scope(host, &project).ok();
                let connected = live.is_some();
                let summary = serde_json::from_value(
                    json!({"id":thread,"name":row["title"].as_str().unwrap_or("Cloud"),"preview":row["title"].as_str().unwrap_or("Cloud"),"createdAt":row.get("createdAt"),"updatedAt":row.get("updatedAt").or_else(||row.get("createdAt")),"desktop":{"archived":false},"cloud":{"sessionId":id,"connected":connected,"error":if connected {Value::Null}else{json!("Cloud 尚未连接，请重新连接以读取远端历史")}}}),
                )?;
                let items = vec![summary];
                projects.push(ShellProject {
                    project_id: project,
                    alias: Some(crate::shell::ProjectAlias {
                        source_id: source.source_id.clone(),
                        project_id: id.into(),
                    }),
                    logical_project_id: Some(logical.project_id),
                    worktree: None,
                    projectless: false,
                    workspace: row["binding"]["cwd"]
                        .as_str()
                        .map(std::path::PathBuf::from)
                        .unwrap_or_else(|| format!("cloud://{id}").into()),
                    state: if connected { "ready" } else { "unavailable" }.into(),
                    service_generation: live.map(|scope| scope.identity.1),
                    summaries: if connected {
                        Summaries::Fresh { items }
                    } else {
                        Summaries::Cached { items }
                    },
                    attention: Attention::Unknown,
                    task_revision: None,
                    model_catalog_revision: None,
                });
            }
        }
        Ok(projects)
    }

    pub(super) async fn command(
        &self,
        host: &Rc<Host>,
        source: &str,
        request: &Value,
    ) -> Result<Value> {
        let _: areal_protocol::host::LocalDesktopCloudSessionParams =
            serde_json::from_value(request.clone()).context("INVALID_PARAMS")?;
        host.admission()?;
        let alias = required(request, "projectId")?;
        let _logical = worktree_catalog::project(host, source, alias)?;
        let home = library_store::source_home(host, source)?;
        let operation = required(request, "operation")?;
        let id = if operation == "create" {
            let id = required(request, "requestId")?;
            crate::wire::request_id(id)?;
            id.to_owned()
        } else {
            let thread = required(request, "threadId")?;
            let rows = records(&home)?;
            let mut matching = rows
                .iter()
                .filter(|row| row["projectId"] == alias && row["binding"]["threadId"] == thread);
            let row = matching.next().context("未知 Cloud 会话")?;
            ensure!(matching.next().is_none(), "Cloud session identity conflict");
            required(row, "id")?.to_owned()
        };
        let gate = self.gate(&virtual_id(source, &id));
        let _guard = gate.lock().await;
        if operation == "create" && !records(&home)?.iter().any(|row| row["id"] == id) {
            let settings = host
                .gateway
                .workbench
                .cloud
                .settings(host, source, &json!({"operation":"status"}))
                .await?;
            ensure!(
                settings["tokenConfigured"] == true,
                "请先配置 Cloud 地址和 token"
            );
            let base = format!("{}/{id}/", required(&settings, "baseURL")?);
            let mut rows = records(&home)?;
            ensure!(!rows.iter().any(|row| row["id"] == id), "COMMAND_CONFLICT");
            rows.push(json!({"id":id,"projectId":alias,"title":"Cloud","createdAt":timestamp(),"nativeAdmission":true,"binding":{"baseURL":base,"workspace":id,"createId":id,"threadRequestId":id}}));
            storage::write(&home.join("cloud-sessions.json"), &rows)?;
            host.changed();
        }
        let row = self.record(host, source, &id)?;
        ensure!(row["projectId"] == alias, "COMMAND_CONFLICT");
        if operation == "create" {
            if let Some(thread) = row["binding"]["threadId"].as_str() {
                return Ok(json!({"threadId":thread,"sessionId":id}));
            }
            ensure!(
                row["nativeAdmission"] == true,
                "SUBMISSION_UNKNOWN: 原 Cloud 创建结果待核对，不会重新创建"
            );
            let scope = self.connect(host, source, &row, false).await?;
            let original_id = required(&row["binding"], "threadRequestId")?;
            let created =
                if workbench_submissions::find(host, &scope.project, original_id)?.is_some() {
                    let original = workbench_submissions::reconcile(
                        host,
                        &scope.project,
                        &scope.lease,
                        "areal/thread/start",
                        json!({"requestId":original_id}),
                    )
                    .await?;
                    ensure!(
                        original["confirmed"] == true
                            && original["error"].is_null()
                            && original["result"].is_object(),
                        "SUBMISSION_UNKNOWN"
                    );
                    original["result"].clone()
                } else {
                    let profiles = self
                        .rpc(host, &scope, "areal/profile/list", json!({}))
                        .await?;
                    let profiles = profiles["data"]
                        .as_array()
                        .context("Invalid Cloud Profile catalog")?;
                    ensure!(
                        profiles.len() <= 1,
                        "远端存在多个 Agent Profile，请配置唯一默认运行包"
                    );
                    let caps = self
                        .rpc(
                            host,
                            &scope,
                            "areal/capabilities",
                            json!({"apiVersion":"areal.core.v1"}),
                        )
                        .await?;
                    let mut params = json!({"requestId":original_id});
                    if let Some(profile) = profiles.first() {
                        params["agentProfile"] =
                            json!({"id":profile["id"],"revision":profile["revision"]});
                    }
                    if !caps["features"]["threadCreationJournal"]["binding"].is_null() {
                        params["creationAdmission"] =
                            caps["features"]["threadCreationJournal"]["binding"].clone();
                    }
                    self.submit(host, &scope, "areal/thread/start", params)
                        .await?
                };
            let thread = required(&created["thread"], "id")?.to_owned();
            self.edit(host, source, &id, |current| {
                ensure!(
                    current["binding"]["baseURL"] == row["binding"]["baseURL"]
                        && current["binding"]["threadRequestId"]
                            == row["binding"]["threadRequestId"],
                    "TARGET_CHANGED"
                );
                if let Some(original) = current["binding"]["threadId"].as_str() {
                    ensure!(original == thread, "COMMAND_CONFLICT");
                }
                current["binding"]["threadId"] = json!(thread);
                if let Some(cwd) = created["thread"].get("cwd") {
                    current["binding"]["cwd"] = cwd.clone();
                }
                Ok(())
            })?;
            return Ok(json!({"threadId":thread,"sessionId":id}));
        }
        let scope = self
            .connect(host, source, &row, operation == "reconnect")
            .await?;
        let thread = required(&row["binding"], "threadId")?;
        let observed = self
            .rpc(
                host,
                &scope,
                "thread/read",
                json!({"threadId":thread,"includeTurns":true}),
            )
            .await?;
        ensure!(observed["thread"]["id"] == thread, "TARGET_CHANGED");
        if let Some(cwd) = observed["thread"]["cwd"].as_str() {
            if row["binding"]["cwd"] != cwd {
                self.edit(host, source, &id, |row| {
                    row["binding"]["cwd"] = json!(cwd);
                    Ok(())
                })?;
            }
        }
        if matches!(operation, "open" | "reconnect") {
            return Ok(json!({"projects":[]}));
        }
        if operation == "send" {
            ensure!(
                !observed["thread"]["turns"]
                    .as_array()
                    .is_some_and(|turns| turns.iter().any(|turn| turn["status"] == "inProgress")),
                "请等待当前 Cloud 查询完成"
            );
            let text = request["text"].as_str().context("INVALID_PARAMS")?;
            let input =
                super::gateway_owner::rich_message_input_with_command(text, request, false)?;
            let request_id = uuid::Uuid::new_v4().to_string();
            let result = self
                .submit(
                    host,
                    &scope,
                    "areal/turn/start",
                    json!({"requestId":request_id,"threadId":thread,"input":input}),
                )
                .await?;
            ensure!(
                result["turn"]["id"].is_string() || result["queueRevision"].is_u64(),
                "SUBMISSION_UNKNOWN"
            );
            self.edit(host, source, &id, |row| {
                row["updatedAt"] = json!(timestamp());
                if row["title"] == "Cloud" {
                    row["title"] = json!(format!(
                        "Cloud · {}",
                        text.trim().chars().take(60).collect::<String>()
                    ));
                }
                Ok(())
            })?;
            return Ok(result);
        }
        ensure!(operation == "stop", "INVALID_PARAMS");
        self.submit(host,&scope,"turn/interrupt",json!({"requestId":uuid::Uuid::new_v4().to_string(),"threadId":thread,"turnId":required(request,"turnId")?})).await
    }
}
