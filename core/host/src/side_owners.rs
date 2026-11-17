use super::{Host, session_commands};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    rc::Rc,
};
use tokio::sync::Notify;

#[derive(Clone)]
struct SideEntry {
    request_id: String,
    project_id: String,
    source_thread_id: String,
    thread_id: Option<String>,
    close_request_id: Option<String>,
}

#[derive(Clone)]
enum SettledResult {
    Ok(Value),
    Wire { code: &'static str, message: String },
    Error(String),
}

struct ActiveSettlement {
    done: Notify,
    result: RefCell<Option<SettledResult>>,
}

struct SideOwner {
    closing: Cell<bool>,
    entries: RefCell<Vec<SideEntry>>,
    inflight: Cell<usize>,
    inflight_done: Notify,
    closed: RefCell<Vec<Value>>,
    settlement: RefCell<Option<Rc<ActiveSettlement>>>,
}

impl SideOwner {
    fn new() -> Self {
        Self {
            closing: Cell::new(false),
            entries: RefCell::new(Vec::new()),
            inflight: Cell::new(0),
            inflight_done: Notify::new(),
            closed: RefCell::new(Vec::new()),
            settlement: RefCell::new(None),
        }
    }
}

struct InflightGuard(Rc<SideOwner>);
impl Drop for InflightGuard {
    fn drop(&mut self) {
        let next = self.0.inflight.get().saturating_sub(1);
        self.0.inflight.set(next);
        if next == 0 {
            self.0.inflight_done.notify_waiters();
        }
    }
}

/// 每个桌面或网页连接名下的可执行 Side Chat 生命周期登记，断连或关窗时自动收敛清理。
#[derive(Default)]
pub(super) struct SideWindowOwners {
    owners: RefCell<BTreeMap<String, Rc<SideOwner>>>,
}

impl SideWindowOwners {
    fn owner(&self, connection: &str) -> Rc<SideOwner> {
        self.owners
            .borrow_mut()
            .entry(connection.to_owned())
            .or_insert_with(|| Rc::new(SideOwner::new()))
            .clone()
    }

    pub(super) async fn command(
        &self,
        host: &Rc<Host>,
        source: &str,
        connection: &str,
        params: &Value,
    ) -> Result<Value> {
        ensure!(!connection.is_empty(), "INVALID_PARAMS");
        let object = params.as_object().context("INVALID_PARAMS")?;
        let operation = object
            .get("operation")
            .and_then(Value::as_str)
            .context("INVALID_PARAMS")?;
        let owner = self.owner(connection);

        if operation == "openOwned" {
            ensure!(object.len() == 1, "INVALID_PARAMS");
            if owner.inflight.get() > 0
                || !owner.entries.borrow().is_empty()
                || owner.settlement.borrow().is_some()
            {
                return Err(crate::wire::error("COMMAND_FAILED", "窗口资源仍在结算"));
            }
            owner.closing.set(false);
            owner.closed.borrow_mut().clear();
            return Ok(json!({"settled": true, "connection": connection}));
        }

        if operation == "closeOwned" {
            ensure!(object.len() == 1, "INVALID_PARAMS");
            return self
                .close_owned(host, Some(source), connection, &owner)
                .await;
        }

        if matches!(operation, "create" | "close" | "recover") && owner.closing.get() {
            return Err(crate::wire::error("COMMAND_FAILED", "窗口正在关闭"));
        }

        let request_id = params.get("requestId").and_then(Value::as_str);
        let project_id = params.get("projectId").and_then(Value::as_str);
        let source_thread_id = params.get("sourceThreadId").and_then(Value::as_str);
        let thread_id = params.get("threadId").and_then(Value::as_str);

        let create = operation == "create";
        let mut tracked_id: Option<String> = None;

        if create {
            let (Some(req_id), Some(proj_id), Some(src_id)) =
                (request_id, project_id, source_thread_id)
            else {
                return Err(crate::wire::error(
                    "COMMAND_FAILED",
                    "无效 Side Chat 创建身份",
                ));
            };
            let mut entries = owner.entries.borrow_mut();
            if let Some(existing) = entries.iter().find(|item| item.request_id == req_id) {
                ensure!(
                    existing.project_id == proj_id && existing.source_thread_id == src_id,
                    "COMMAND_CONFLICT"
                );
            } else {
                entries.push(SideEntry {
                    request_id: req_id.to_owned(),
                    project_id: proj_id.to_owned(),
                    source_thread_id: src_id.to_owned(),
                    thread_id: None,
                    close_request_id: None,
                });
            }
            tracked_id = Some(req_id.to_owned());
        } else if operation == "recover"
            && let Some(req_id) = request_id
        {
            if owner
                .entries
                .borrow()
                .iter()
                .any(|item| item.request_id == req_id)
            {
                tracked_id = Some(req_id.to_owned());
            }
        } else if operation == "close" {
            let mut entries = owner.entries.borrow_mut();
            if thread_id.is_some()
                && let Some(entry) = entries.iter_mut().find(|item| {
                    Some(item.project_id.as_str()) == project_id
                        && item.thread_id.as_deref() == thread_id
                })
            {
                let req_id = request_id.context("INVALID_PARAMS")?;
                if entry
                    .close_request_id
                    .as_deref()
                    .is_some_and(|existing| existing != req_id)
                {
                    bail!("COMMAND_CONFLICT");
                }
                entry
                    .close_request_id
                    .get_or_insert_with(|| req_id.to_owned());
                tracked_id = Some(entry.request_id.clone());
            }
        }

        let track_inflight =
            create || (tracked_id.is_some() && matches!(operation, "recover" | "close"));
        let _guard = if track_inflight {
            owner.inflight.set(owner.inflight.get() + 1);
            Some(InflightGuard(owner.clone()))
        } else {
            None
        };

        let result = session_commands::side(host, source, params).await;
        match result {
            Ok(value) => {
                if let Some(entry_key) = tracked_id.as_deref() {
                    if !(operation == "recover" && value["confirmed"] == false) {
                        let expected_thread = if operation == "close"
                            || (operation == "recover" && params["method"] == "areal/side/close")
                        {
                            owner
                                .entries
                                .borrow()
                                .iter()
                                .find(|item| item.request_id == entry_key)
                                .and_then(|item| item.thread_id.clone())
                        } else {
                            None
                        };
                        check_admission(&value, request_id, expected_thread.as_deref())?;
                    }
                    let mut entries = owner.entries.borrow_mut();
                    if operation == "recover"
                        && params["method"] == "areal/side/create"
                        && value["confirmed"] == true
                        && (value["status"] == "failed" || value["accepted"] == false)
                    {
                        entries.retain(|item| item.request_id != entry_key);
                    } else {
                        if (create || operation == "recover")
                            && let Some(tid) = value["threadId"].as_str()
                            && let Some(entry) =
                                entries.iter_mut().find(|item| item.request_id == entry_key)
                        {
                            entry.thread_id = Some(tid.to_owned());
                        }
                        if (operation == "close"
                            || (operation == "recover" && params["method"] == "areal/side/close"))
                            && value["cleanupConfirmed"] == true
                        {
                            entries.retain(|item| item.request_id != entry_key);
                        }
                    }
                }
                Ok(value)
            }
            Err(error) => {
                if let Some(entry_key) = tracked_id.as_deref()
                    && is_definite_rejection(&error)
                {
                    let mut entries = owner.entries.borrow_mut();
                    if create {
                        entries.retain(|item| item.request_id != entry_key);
                    } else if operation == "close"
                        && let Some(entry) =
                            entries.iter_mut().find(|item| item.request_id == entry_key)
                    {
                        entry.close_request_id = None;
                    }
                }
                Err(error)
            }
        }
    }

    async fn close_owned(
        &self,
        host: &Rc<Host>,
        source: Option<&str>,
        connection: &str,
        owner: &Rc<SideOwner>,
    ) -> Result<Value> {
        if let Some(active) = owner.settlement.borrow().clone() {
            loop {
                let notified = active.done.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if let Some(settled) = active.result.borrow().clone() {
                    return unwrap_settled(settled);
                }
                notified.await;
            }
        }
        let active = Rc::new(ActiveSettlement {
            done: Notify::new(),
            result: RefCell::new(None),
        });
        *owner.settlement.borrow_mut() = Some(active.clone());
        let outcome = self.close_pass(host, source, connection, owner).await;
        let snapshot = match &outcome {
            Ok(value) => SettledResult::Ok(value.clone()),
            Err(error) => {
                if let Some(wire) = error.downcast_ref::<crate::wire::Error>() {
                    SettledResult::Wire {
                        code: wire.code,
                        message: wire.message.clone(),
                    }
                } else {
                    SettledResult::Error(error.to_string())
                }
            }
        };
        *active.result.borrow_mut() = Some(snapshot);
        active.done.notify_waiters();
        let clear = owner
            .settlement
            .borrow()
            .as_ref()
            .is_some_and(|current| Rc::ptr_eq(current, &active));
        if clear {
            owner.settlement.borrow_mut().take();
        }
        outcome
    }

    async fn close_pass(
        &self,
        host: &Rc<Host>,
        source: Option<&str>,
        connection: &str,
        owner: &Rc<SideOwner>,
    ) -> Result<Value> {
        owner.closing.set(true);
        while owner.inflight.get() > 0 {
            let notified = owner.inflight_done.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if owner.inflight.get() == 0 {
                break;
            }
            notified.await;
        }
        let resolved_source = if let Some(source) = source {
            Some(source.to_owned())
        } else if !owner.entries.borrow().is_empty() {
            host.gateway.workbench.restore_source(host)?;
            host.gateway.workbench.active_source()
        } else {
            None
        };
        loop {
            let Some(mut entry) = owner.entries.borrow().first().cloned() else {
                break;
            };
            let source = resolved_source
                .as_deref()
                .context("CAPABILITY_UNAVAILABLE")?;
            if entry.thread_id.is_none() {
                let original = session_commands::side(
                    host,
                    source,
                    &json!({
                        "operation": "recover",
                        "method": "areal/side/create",
                        "projectId": entry.project_id,
                        "sourceThreadId": entry.source_thread_id,
                        "requestId": entry.request_id,
                    }),
                )
                .await?;
                if original["confirmed"] == true {
                    check_admission(&original, Some(&entry.request_id), None)?;
                }
                if original["confirmed"] == true
                    && original["requestId"] == entry.request_id
                    && (original["status"] == "failed" || original["accepted"] == false)
                {
                    owner
                        .entries
                        .borrow_mut()
                        .retain(|item| item.request_id != entry.request_id);
                    continue;
                }
                let Some(tid) = original["threadId"].as_str().filter(|_| {
                    original["confirmed"] == true && original["requestId"] == entry.request_id
                }) else {
                    return Err(crate::wire::error(
                        "COMMAND_FAILED",
                        "Side Chat 创建结果待核对；原请求不会重发",
                    ));
                };
                entry.thread_id = Some(tid.to_owned());
                if let Some(stored) = owner
                    .entries
                    .borrow_mut()
                    .iter_mut()
                    .find(|item| item.request_id == entry.request_id)
                {
                    stored.thread_id = entry.thread_id.clone();
                }
            }
            let thread_id = entry
                .thread_id
                .clone()
                .context("Side Chat 创建结果待核对；原请求不会重发")?;
            let recovery = entry.close_request_id.is_some();
            let close_request_id = entry
                .close_request_id
                .clone()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            if !recovery
                && let Some(stored) = owner
                    .entries
                    .borrow_mut()
                    .iter_mut()
                    .find(|item| item.request_id == entry.request_id)
            {
                stored.close_request_id = Some(close_request_id.clone());
            }
            let result = session_commands::side(
                host,
                source,
                &if recovery {
                    json!({
                        "operation": "recover",
                        "method": "areal/side/close",
                        "projectId": entry.project_id,
                        "threadId": thread_id,
                        "requestId": close_request_id,
                    })
                } else {
                    json!({
                        "operation": "close",
                        "projectId": entry.project_id,
                        "threadId": thread_id,
                        "requestId": close_request_id,
                    })
                },
            )
            .await?;
            if result["confirmed"] != false {
                check_admission(&result, Some(&close_request_id), Some(&thread_id))?;
            }
            if result["cleanupConfirmed"] != true {
                return Err(crate::wire::error(
                    "COMMAND_FAILED",
                    "Side Chat 清理仍待核对；原请求不会重发",
                ));
            }
            owner.closed.borrow_mut().push(json!({
                "projectId": entry.project_id,
                "threadId": thread_id,
                "requestId": close_request_id,
            }));
            owner
                .entries
                .borrow_mut()
                .retain(|item| item.request_id != entry.request_id);
        }
        Ok(json!({
            "settled": true,
            "connection": connection,
            "closed": owner.closed.borrow().clone(),
        }))
    }

    pub(super) fn disconnect(&self, host: &Rc<Host>, connection: &str) {
        let Some(owner) = self.owners.borrow().get(connection).cloned() else {
            return;
        };
        if owner.entries.borrow().is_empty()
            && owner.inflight.get() == 0
            && owner.settlement.borrow().is_none()
        {
            self.owners.borrow_mut().remove(connection);
            return;
        }
        let host = Rc::clone(host);
        let connection = connection.to_owned();
        tokio::task::spawn_local(async move {
            let owners = &host.gateway.workbench.side_owners;
            let _ = owners.close_owned(&host, None, &connection, &owner).await;
            if owner.entries.borrow().is_empty()
                && owner.inflight.get() == 0
                && owner.settlement.borrow().is_none()
            {
                owners.owners.borrow_mut().remove(&connection);
            }
        });
    }
}

fn check_admission(
    result: &Value,
    expected_request: Option<&str>,
    expected_thread: Option<&str>,
) -> Result<()> {
    ensure!(result.is_object(), "INVALID_RESPONSE");
    if let Some(expected) = expected_request {
        ensure!(
            result["requestId"].as_str() == Some(expected),
            "INVALID_RESPONSE"
        );
    }
    if let Some(expected) = expected_thread {
        let actual = result["threadId"]
            .as_str()
            .or_else(|| result["thread"]["id"].as_str());
        ensure!(actual == Some(expected), "INVALID_RESPONSE");
    }
    Ok(())
}

fn is_definite_rejection(error: &anyhow::Error) -> bool {
    if let Some(wire) = error.downcast_ref::<crate::wire::Error>() {
        return !matches!(wire.code, "CAPABILITY_UNAVAILABLE" | "CORE_UNAVAILABLE");
    }
    super::gateway_owner::settled_failure(&error.to_string())
}

fn unwrap_settled(settled: SettledResult) -> Result<Value> {
    match settled {
        SettledResult::Ok(value) => Ok(value),
        SettledResult::Wire { code, message } => Err(crate::wire::error(code, message)),
        SettledResult::Error(message) => Err(anyhow::anyhow!("{message}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::workbench_route::desktop_command;
    use futures_util::{SinkExt, StreamExt};
    use std::{path::Path, time::Duration};
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
        let alias = "0123456789abcdef01234567".to_owned();
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

    async fn start_mock_core(
        host: &Rc<Host>,
        workspace: &Path,
        closed_threads: Rc<RefCell<Vec<String>>>,
    ) -> (Box<dyn Fn()>, tokio::task::JoinHandle<()>) {
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
        let ws = workspace.to_path_buf();
        let next_side = Rc::new(Cell::new(0usize));
        let server = tokio::task::spawn_local(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            while let Some(Ok(Message::Text(text))) = socket.next().await {
                let call: Value = serde_json::from_str(&text).unwrap();
                if call.get("id").is_none() {
                    continue;
                }
                let method = call["method"].as_str().unwrap();
                let params = &call["params"];
                let result = match method {
                    "initialize" => json!({}),
                    "areal/capabilities" => json!({
                        "apiVersion": "areal.core.v1",
                        "methods": [
                            "areal/side/start",
                            "areal/side/create",
                            "areal/side/close",
                            "areal/request/read",
                            "thread/read"
                        ],
                        "features": {
                            "sideExecutableV2": true,
                            "threadCreationJournal": {
                                "binding": { "identity": "store-1", "journalEpoch": "epoch-1" }
                            }
                        },
                        "methodSemantics": {
                            "areal/side/create": { "effect": "mutation", "receipt": "thread" },
                            "areal/side/close": { "effect": "mutation", "receipt": "thread" }
                        }
                    }),
                    "areal/task/list" => json!({ "data": [], "nextCursor": null }),
                    "thread/read" => json!({
                        "thread": {
                            "id": params["threadId"],
                            "sessionId": "session-1",
                            "cwd": ws,
                            "conversation": { "kind": "ordinary" },
                            "turns": [],
                            "desktop": { "configuration": { "revision": 1, "options": {} } }
                        }
                    }),
                    "areal/side/create" => {
                        let idx = next_side.get() + 1;
                        next_side.set(idx);
                        let tid = format!("side-exec-{idx}");
                        json!({
                            "requestId": params["requestId"],
                            "thread": { "id": tid },
                            "turn": Value::Null
                        })
                    }
                    "areal/side/close" => {
                        let tid = params["threadId"].as_str().unwrap().to_owned();
                        closed_threads.borrow_mut().push(tid.clone());
                        json!({
                            "requestId": params["requestId"],
                            "threadId": tid,
                            "accepted": true,
                            "cleanupConfirmed": true
                        })
                    }
                    other => panic!("unexpected mock Core method: {other}"),
                };
                socket
                    .send(Message::Text(
                        json!({"id": call["id"], "result": result})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
            }
        });
        let close = host
            .schedules
            .connections
            .connect_test_core(host.clone(), "project", service)
            .await
            .unwrap();
        (close, server)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn side_owners_lifecycle_conflict_and_disconnect_cleanup() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let base = root.path().canonicalize().unwrap();
                let (host, _source, alias, workspace) = test_host(&base);
                let closed_threads = Rc::new(RefCell::new(Vec::new()));
                let (close_core, server) =
                    start_mock_core(&host, &workspace, closed_threads.clone()).await;

                let req1 = uuid::Uuid::new_v4().to_string();
                let created1 = desktop_command(
                    &host,
                    "local",
                    "conn-a",
                    &json!({
                        "method": "desktop.command",
                        "params": {
                            "command": "side",
                            "request": {
                                "projectId": alias,
                                "operation": "create",
                                "sourceThreadId": "source-1",
                                "requestId": req1,
                            }
                        }
                    }),
                )
                .await
                .unwrap();
                assert_eq!(created1["threadId"], "side-exec-1");

                // 同一 requestId 若绑定参数不同，必须报 COMMAND_CONFLICT。
                let conflict = desktop_command(
                    &host,
                    "local",
                    "conn-a",
                    &json!({
                        "method": "desktop.command",
                        "params": {
                            "command": "side",
                            "request": {
                                "projectId": alias,
                                "operation": "create",
                                "sourceThreadId": "other-source",
                                "requestId": req1,
                            }
                        }
                    }),
                )
                .await
                .unwrap_err();
                assert_eq!(conflict.to_string(), "COMMAND_CONFLICT");

                // 尚有未关闭 Side 时不能 openOwned。
                let blocked_open = desktop_command(
                    &host,
                    "local",
                    "conn-a",
                    &json!({
                        "method": "desktop.command",
                        "params": {
                            "command": "side",
                            "request": { "operation": "openOwned" }
                        }
                    }),
                )
                .await
                .unwrap_err();
                assert_eq!(
                    blocked_open
                        .downcast_ref::<crate::wire::Error>()
                        .map(|e| e.code),
                    Some("COMMAND_FAILED")
                );

                // 另一条连接新建的 Side 不会因 conn-a 关闭或断开而被误关。
                let req2 = uuid::Uuid::new_v4().to_string();
                let created2 = desktop_command(
                    &host,
                    "local",
                    "conn-b",
                    &json!({
                        "method": "desktop.command",
                        "params": {
                            "command": "side",
                            "request": {
                                "projectId": alias,
                                "operation": "create",
                                "sourceThreadId": "source-1",
                                "requestId": req2,
                            }
                        }
                    }),
                )
                .await
                .unwrap();
                assert_eq!(created2["threadId"], "side-exec-2");

                let settled = desktop_command(
                    &host,
                    "local",
                    "conn-a",
                    &json!({
                        "method": "desktop.command",
                        "params": {
                            "command": "side",
                            "request": { "operation": "closeOwned" }
                        }
                    }),
                )
                .await
                .unwrap();
                assert_eq!(settled["settled"], true);
                assert_eq!(settled["connection"], "conn-a");
                assert_eq!(settled["closed"].as_array().unwrap().len(), 1);
                assert_eq!(settled["closed"][0]["threadId"], "side-exec-1");
                assert_eq!(closed_threads.borrow().as_slice(), &["side-exec-1"]);

                // 关闭结算完成后可以重新 openOwned。
                let reopened = desktop_command(
                    &host,
                    "local",
                    "conn-a",
                    &json!({
                        "method": "desktop.command",
                        "params": {
                            "command": "side",
                            "request": { "operation": "openOwned" }
                        }
                    }),
                )
                .await
                .unwrap();
                assert_eq!(reopened, json!({ "settled": true, "connection": "conn-a" }));

                // conn-b 断开时自动回收其名下的 side-exec-2。
                host.gateway
                    .workbench
                    .disconnect_connection(&host, "conn-b");
                tokio::time::timeout(Duration::from_secs(2), async {
                    loop {
                        if closed_threads.borrow().as_slice() == ["side-exec-1", "side-exec-2"] {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await
                .unwrap();
                assert!(!host.gateway.workbench.has_running_backend());

                close_core();
                server.abort();
            })
            .await;
    }
}
