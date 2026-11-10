//! 后台只经 Host 的已鉴权连接访问 Core；页面宿主只有连接租约与可重建投影。
use super::*;

const WORKBENCH_METHODS: &[&str] = &[
    "areal/task/draft",
    "areal/worktree/read",
    "areal/worktree/command",
    "areal/capabilities",
    "areal/agent/delegate",
    "areal/agent/list",
    "areal/agent/spawn",
    "areal/agent/wait",
    "areal/blob/release",
    "areal/channel/read",
    "areal/channel/reply",
    "areal/context/compact",
    "areal/context/read",
    "areal/conversation/history",
    "areal/conversation/list",
    "areal/conversation/unarchive",
    "areal/execution/apply",
    "areal/execution/artifact",
    "areal/execution/cancel",
    "areal/execution/list",
    "areal/execution/read",
    "areal/execution/trace",
    "areal/execution/traceResult",
    "areal/execution/wait",
    "areal/genUi/source",
    "areal/goal/clear",
    "areal/goal/create",
    "areal/goal/get",
    "areal/goal/pause",
    "areal/goal/resume",
    "areal/goal/update",
    "areal/hook/acknowledge",
    "areal/inbox/list",
    "areal/interaction/list",
    "areal/interaction/respond",
    "areal/mcp/app/close",
    "areal/mcp/app/open",
    "areal/mcp/app/openFromResult",
    "areal/mcp/app/request",
    "areal/mcp/app/tools/register",
    "areal/mcp/app/tools/revoke",
    "areal/mcp/apps/list",
    "areal/mcp/extension/call",
    "areal/mcp/form/preview",
    "areal/mcp/form/resource/prepare",
    "areal/mcp/form/resource/release",
    "areal/mcp/form/resource/stage",
    "areal/mcp/form/respond",
    "areal/mcp/forms/list",
    "areal/mcp/tool/result",
    "areal/model/list",
    "areal/owner/unwatch",
    "areal/owner/watch",
    "areal/permissions/forget",
    "areal/permissions/read",
    "areal/plan/read",
    "areal/plan/update",
    "areal/plugin/auth",
    "areal/plugin/auth/configure",
    "areal/plugin/component/configure",
    "areal/plugin/components",
    "areal/plugin/connection",
    "areal/plugin/connector/configure",
    "areal/plugin/development/link",
    "areal/plugin/development/unlink",
    "areal/plugin/hooks/configure",
    "areal/plugin/hooks/list",
    "areal/plugin/importArchive",
    "areal/plugin/list",
    "areal/plugin/mcp/list",
    "areal/plugin/read",
    "areal/plugin/setup",
    "areal/plugin/userConfig/set",
    "areal/process/acknowledgeCleanup",
    "areal/process/closeStdin",
    "areal/process/get",
    "areal/process/list",
    "areal/process/read",
    "areal/process/resize",
    "areal/process/start",
    "areal/process/terminate",
    "areal/process/wait",
    "areal/process/write",
    "areal/profile/list",
    "areal/profile/read",
    "areal/provider/list",
    "areal/provider/probe",
    "areal/provider/remove",
    "areal/provider/upsert",
    "areal/queue/list",
    "areal/queue/pause",
    "areal/queue/remove",
    "areal/queue/reorder",
    "areal/queue/resume",
    "areal/queue/steer",
    "areal/queue/update",
    "areal/request/read",
    "areal/server/drain",
    "areal/server/gc",
    "areal/server/modelConfiguration/apply",
    "areal/server/modelConfiguration/read",
    "areal/server/status",
    "areal/side/close",
    "areal/side/context/read",
    "areal/side/create",
    "areal/side/start",
    "areal/skill/list",
    "areal/skill/read",
    "areal/subscription/remove",
    "areal/task/attention/read",
    "areal/task/cancel",
    "areal/task/create",
    "areal/task/delete",
    "areal/task/directory/list",
    "areal/task/directory/read",
    "areal/task/list",
    "areal/task/pause",
    "areal/task/read",
    "areal/task/resume",
    "areal/task/resumeRun",
    "areal/task/run/read",
    "areal/task/runNow",
    "areal/task/runs/list",
    "areal/task/schedule/context",
    "areal/task/schedule/preview",
    "areal/task/stopRun",
    "areal/task/subscribe",
    "areal/task/tools/ready",
    "areal/task/unsubscribe",
    "areal/task/update",
    "areal/thread/archive",
    "areal/thread/closeResources",
    "areal/thread/configure",
    "areal/thread/fork",
    "areal/thread/inspect",
    "areal/thread/observe",
    "areal/thread/prediction",
    "areal/thread/start",
    "areal/thread/tools/attach",
    "areal/tool/acknowledge",
    "areal/turn/enqueue",
    "areal/turn/start",
    "areal/turn/submit",
    "areal/work/overview",
    "areal/workflow/list",
    "areal/workflow/read",
    "areal/workflow/start",
    "areal/workgroup/artifact",
    "areal/workgroup/cancel",
    "areal/workgroup/list",
    "areal/workgroup/policy",
    "areal/workgroup/read",
    "areal/workgroup/revise",
    "areal/workgroup/start",
    "areal/workgroup/wait",
    "thread/list",
    "thread/read",
    "thread/resume",
    "thread/start",
    "turn/interrupt",
    "turn/start",
    "turn/steer",
];

const TERMINAL_METHODS: &[&str] = &[
    "areal/capabilities",
    "areal/process/start",
    "areal/process/list",
    "areal/process/get",
    "areal/process/read",
    "areal/process/write",
    "areal/process/resize",
    "areal/process/closeStdin",
    "areal/process/terminate",
    "areal/process/wait",
    "areal/request/read",
];

struct TerminalPermit<'a>(&'a Cell<usize>);
impl Drop for TerminalPermit<'_> {
    fn drop(&mut self) {
        self.0.set(self.0.get() - 1);
    }
}
struct AttachGuard(Option<Rc<CoreSession>>);
impl Drop for AttachGuard {
    fn drop(&mut self) {
        if let Some(session) = self.0.take() {
            session.close();
        }
    }
}
struct CreationGuard<'a>(&'a CoreSession);
impl Drop for CreationGuard<'_> {
    fn drop(&mut self) {
        let session = self.0;
        session
            .workbench_creations
            .set(session.workbench_creations.get() - 1);
        if session.workbench_creations.get() != 0 {
            return;
        }
        let deferred = std::mem::take(&mut *session.deferred_removals.borrow_mut());
        let host = session.observed.borrow();
        let workbench = session.workbench_observed.borrow();
        let threads = deferred
            .into_iter()
            .filter(|thread| !host.contains_key(thread) && !workbench.contains_key(thread))
            .collect();
        session.remove_subscriptions(threads);
    }
}

impl Connections {
    pub(crate) fn workbench_validate(
        &self,
        host: &Host,
        id: &str,
        lease: &str,
        method: &str,
        params: &Value,
    ) -> Result<()> {
        ensure!(WORKBENCH_METHODS.contains(&method), "FORBIDDEN");
        ensure!(params.is_object(), "INVALID_PARAMS");
        let session = self.workbench_session(host, id, lease)?;
        if session.remote_source.is_some() || session.desktop.get() {
            return Ok(());
        }
        if session.observer.get() {
            ensure!(
                [
                    "areal/capabilities",
                    "areal/thread/observe",
                    "thread/read",
                    "areal/subscription/remove",
                    "areal/interaction/list",
                    "areal/task/read",
                    "areal/channel/read"
                ]
                .contains(&method),
                "FORBIDDEN"
            );
        } else if session.terminal {
            ensure!(TERMINAL_METHODS.contains(&method), "FORBIDDEN");
            if method == "areal/process/start" {
                ensure!(params["lifetime"] == "connection", "INVALID_PARAMS");
            }
        }
        Ok(())
    }

    fn workbench_session(&self, host: &Host, id: &str, lease: &str) -> Result<Rc<CoreSession>> {
        let terminal = self.terminals.borrow().get(lease).cloned();
        let session = terminal
            .or_else(|| self.sessions.borrow().get(id).cloned())
            .ok_or_else(unavailable)?;
        ensure!(
            session.project_id == id
                && session.shared_current(host)
                && session.workbench_lease.borrow().as_deref() == Some(lease),
            unavailable()
        );
        Ok(session)
    }

    pub(crate) fn workbench_identity(
        &self,
        host: &Host,
        id: &str,
        lease: &str,
    ) -> Result<(String, String, String)> {
        let session = self.workbench_session(host, id, lease)?;
        Ok((
            session.service.identity.service_id.clone(),
            session.service.identity.generation.clone(),
            session.connection_id.clone(),
        ))
    }

    pub(crate) fn workbench_close_terminals(&self) {
        self.terminal_epoch
            .set(self.terminal_epoch.get().wrapping_add(1));
        let leases = self
            .terminals
            .borrow()
            .keys()
            .filter(|lease| !self.frontend_owns(lease))
            .cloned()
            .collect::<Vec<_>>();
        for lease in leases {
            if let Some(session) = self.terminals.borrow_mut().remove(&lease) {
                session.close();
            }
        }
    }

    pub(crate) async fn workbench_attach(
        &self,
        host: &Rc<Host>,
        id: &str,
        scope: Option<&str>,
    ) -> Result<Value> {
        self.attach_session(host, id, scope, false).await
    }
    pub(crate) async fn workbench_desktop_attach(
        &self,
        host: &Rc<Host>,
        id: &str,
    ) -> Result<Value> {
        self.attach_session(host, id, None, true).await
    }
    async fn attach_session(
        &self,
        host: &Rc<Host>,
        id: &str,
        scope: Option<&str>,
        desktop: bool,
    ) -> Result<Value> {
        ensure!(
            scope.is_none() || matches!(scope, Some("terminal" | "observer")),
            "INVALID_PARAMS"
        );
        let terminal_epoch = self.terminal_epoch.get();
        let _permit = if scope.is_some() || desktop {
            self.terminals
                .borrow_mut()
                .retain(|_, session| !session.closed.get());
            ensure!(
                self.terminals.borrow().len() + self.terminal_connecting.get() < 64,
                "CAPACITY_EXCEEDED"
            );
            self.terminal_connecting
                .set(self.terminal_connecting.get() + 1);
            Some(TerminalPermit(&self.terminal_connecting))
        } else {
            None
        };
        // 已受理的启动与配置变更持有同一写锁；投影等它结算，不把中途 starting 当成失连。
        let (state, service) = {
            let gate = host.gate(id)?;
            let _startup = gate.read().await;
            host.admission()?;
            let slots = host.slots.borrow();
            let slot = slots.get(id).context("RESOURCE_UNAVAILABLE")?;
            (
                slot.state.clone(),
                slot.service.clone().filter(|service| {
                    slot.state == "ready"
                        && slot.writer.is_some()
                        && service.owner.as_ref() == Some(&host.owner())
                }),
            )
        };
        if service.is_none() {
            eprintln!(
                "Host Core attach unavailable: projectId={id} stage=service state={}",
                state
            );
        }
        let service = service.context("Core project is unavailable")?;
        let session = if scope.is_some() || desktop {
            self.terminals
                .borrow_mut()
                .retain(|_, session| !session.closed.get());
            ensure!(self.terminals.borrow().len() < 64, "CAPACITY_EXCEEDED");
            let session = connect_owned(host.clone(), id, service, true).await?;
            session.observer.set(scope == Some("observer"));
            session.desktop.set(desktop);
            session.ready.set(true);
            session
        } else {
            self.ready(host, id, &service.identity.generation)
                .await
                .map_err(|cause| {
                    eprintln!("Host Core attach unavailable: projectId={id} stage=sharedReady");
                    cause
                })?;
            self.sessions
                .borrow()
                .get(id)
                .cloned()
                .ok_or_else(unavailable)?
        };
        let mut guard = AttachGuard((scope.is_some() || desktop).then(|| session.clone()));
        // 等共享准备时不阻塞恢复的写锁；授租的短握手则与下一次生命周期变更互斥。
        let gate = host.gate(id)?;
        let _attachment = gate.read().await;
        ensure!(session.shared_current(host), unavailable());
        let capabilities = session
            .request("areal/capabilities", json!({"apiVersion":"areal.core.v1"}))
            .await
            .map_err(|cause| {
                eprintln!("Host Core attach unavailable: projectId={id} stage=capabilities");
                cause
            })?;
        ensure!(session.shared_current(host), unavailable());
        if scope.is_some() || desktop {
            ensure!(self.terminal_epoch.get() == terminal_epoch, unavailable());
            if scope == Some("terminal") {
                ensure!(
                    capabilities["features"]["connectionProcesses"] == true,
                    "CORE_INCOMPATIBLE"
                );
            }
        }
        let lease = uuid::Uuid::new_v4().to_string();
        if let Some(previous) = session.workbench_lease.borrow().as_deref() {
            session.release_workbench(previous);
        }
        *session.workbench_lease.borrow_mut() = Some(lease.clone());
        if scope.is_some() || desktop {
            ensure!(self.terminals.borrow().len() < 64, "CAPACITY_EXCEEDED");
            self.terminals
                .borrow_mut()
                .insert(lease.clone(), session.clone());
        }
        guard.0 = None;
        Ok(
            json!({"lease":lease,"coreInstanceId":session.service.identity.service_id,
            "coreGeneration":session.service.identity.generation,"connectionId":session.connection_id,
            "capabilities":capabilities}),
        )
    }

    pub(crate) async fn workbench_request(
        &self,
        host: &Host,
        id: &str,
        lease: &str,
        method: &str,
        mut params: Value,
    ) -> Result<Value> {
        self.workbench_validate(host, id, lease, method, &params)?;
        let session = self.workbench_session(host, id, lease)?;
        let invalid_observation_budget = matches!(method, "areal/thread/observe" | "thread/resume")
            && serde_json::from_value::<areal_protocol::desktop::ObserveThread>(params.clone())
                .is_ok_and(|request| match (request.mode, request.max_bytes) {
                    (None, Some(_)) => true,
                    (Some(_), Some(bytes)) => {
                        !(1..=areal_protocol::desktop::MAX_HISTORY_PAGE_BYTES).contains(&bytes)
                    }
                    _ => false,
                });
        let mut claim = None;
        if !session.terminal {
            if matches!(
                method,
                "areal/thread/observe"
                    | "thread/resume"
                    | "turn/start"
                    | "areal/turn/start"
                    | "areal/turn/enqueue"
                    | "areal/turn/submit"
            ) {
                if let Some(thread) = params["threadId"].as_str() {
                    let sequence = session.workbench_claim_sequence.get() + 1;
                    session.workbench_claim_sequence.set(sequence);
                    let previous = session
                        .workbench_observed
                        .borrow_mut()
                        .insert(thread.into(), (lease.into(), sequence));
                    if previous.is_none() {
                        claim = Some((thread.to_owned(), sequence));
                    }
                }
            } else if method == "areal/subscription/remove" {
                if let Ok(request) = serde_json::from_value::<
                    areal_protocol::desktop::RemoveSubscriptions,
                >(params.clone())
                {
                    if request.thread_ids.len() <= areal_protocol::desktop::MAX_SUBSCRIPTIONS {
                        let mut owned = session.workbench_observed.borrow_mut();
                        let observed = session.observed.borrow();
                        let mut removable = Vec::new();
                        for thread in request.thread_ids {
                            if owned.get(&thread).is_some_and(|(owner, _)| owner == lease) {
                                owned.remove(&thread);
                                if !observed.contains_key(&thread) {
                                    removable.push(thread);
                                }
                            }
                        }
                        params["threadIds"] = json!(session.defer_removals(removable));
                    }
                }
            }
        }
        let _creation =
            if !session.terminal && matches!(method, "thread/start" | "areal/thread/start") {
                session
                    .workbench_creations
                    .set(session.workbench_creations.get() + 1);
                Some(CreationGuard(&session))
            } else {
                None
            };
        let result = session.request_with_barrier(method, params).await;
        ensure!(
            session.shared_current(host)
                && session.workbench_lease.borrow().as_deref() == Some(lease),
            unavailable()
        );
        // Core 的原始错误保留回执/准入事实；传输失败仍然是未知，不能伪装成确定拒绝。
        match result {
            Ok(result) => {
                if !session.terminal && matches!(method, "thread/start" | "areal/thread/start") {
                    if let Some(thread) = result.value["thread"]["id"].as_str() {
                        session.workbench_observed.borrow_mut().insert(
                            thread.into(),
                            (lease.into(), session.workbench_claim_sequence.get() + 1),
                        );
                        session
                            .workbench_claim_sequence
                            .set(session.workbench_claim_sequence.get() + 1);
                    }
                }
                if matches!(
                    method,
                    "areal/thread/archive"
                        | "areal/conversation/unarchive"
                        | "areal/thread/configure"
                        | "thread/start"
                        | "areal/thread/start"
                        | "areal/thread/fork"
                        | "thread/fork"
                ) {
                    session.shell_revision.set(session.shell_revision.get() + 1);
                    if let Some(shared) = self.sessions.borrow().get(id) {
                        shared.shell_revision.set(shared.shell_revision.get() + 1);
                    }
                    host.changed();
                }
                Ok(json!({"result":result.value,"sequence":result.sequence}))
            }
            Err(error) => match error.downcast_ref::<RpcFailure>() {
                Some(error) => {
                    if invalid_observation_budget && error.0["code"] == -32602 {
                        if let Some((thread, sequence)) = claim {
                            let mut owned = session.workbench_observed.borrow_mut();
                            if owned.get(&thread).is_some_and(|(owner, current)| {
                                owner == lease && *current == sequence
                            }) {
                                owned.remove(&thread);
                                drop(owned);
                                if !session.observed.borrow().contains_key(&thread) {
                                    session.remove_subscriptions(vec![thread]);
                                }
                            }
                        }
                    }
                    Ok(json!({"error":error.0}))
                }
                None => Err(error),
            },
        }
    }

    pub(crate) fn workbench_detach(&self, host: &Host, id: &str, lease: &str) -> Result<Value> {
        let terminal = self.terminals.borrow().get(lease).cloned();
        if let Some(session) = terminal {
            ensure!(session.project_id == id, "FORBIDDEN");
            self.terminals.borrow_mut().remove(lease);
            session.close();
            return Ok(json!({"closed":true}));
        }
        let session = self.workbench_session(host, id, lease).ok();
        let closed = session.is_some();
        if let Some(session) = session {
            // 投影只拥有租约；共享 socket 的建立与关闭仍由 Host 项目监督负责。
            session.release_workbench(lease);
            session.workbench_lease.borrow_mut().take();
        }
        self.terminals.borrow_mut().remove(lease);
        Ok(json!({"closed":closed}))
    }
}

struct CommandAdmission<'a> {
    host: &'a Host,
    connection: &'a CoreSession,
}
fn admission_diagnostic(project: &str, stage: &str, cause: &anyhow::Error) {
    // 只记录边界和错误分类；请求正文、租约及凭据不能进入诊断。
    let wire = cause.downcast_ref::<crate::wire::Error>();
    let rpc = cause.downcast_ref::<super::RpcFailure>();
    let code = wire.map(|error| error.code).unwrap_or("unclassified");
    let reason = wire
        .filter(|error| error.code == "scheduleWorkspaceRequired")
        .map(|error| error.message.as_str())
        .unwrap_or("");
    eprintln!(
        "Host workspace admission failed: projectId={project} stage={stage} code={code} rpcCode={} ioKind={:?} jsonCategory={:?} reason={reason}",
        rpc.map(|error| &error.0["code"]).unwrap_or(&Value::Null),
        cause
            .downcast_ref::<std::io::Error>()
            .map(std::io::Error::kind),
        cause
            .downcast_ref::<serde_json::Error>()
            .map(serde_json::Error::classify),
    );
}
impl AdmissionRpc for CommandAdmission<'_> {
    async fn request(&self, id: &str, method: &str, params: Value) -> Result<Value> {
        ensure!(self.connection.shared_current(self.host), unavailable());
        let result = if id == self.connection.project_id {
            self.connection
                .request(method, params)
                .await
                .map_err(|cause| {
                    admission_diagnostic(id, method, &cause);
                    cause
                })?
        } else {
            let scope = self
                .host
                .schedules
                .connections
                .shared_identity(self.host, id)?;
            self.host
                .schedules
                .connections
                .remote_request(
                    self.host,
                    id,
                    (&scope.0, &scope.1, &scope.2),
                    method,
                    params,
                )
                .await?
        };
        ensure!(self.connection.shared_current(self.host), unavailable());
        Ok(result)
    }
}
impl Connections {
    pub(crate) async fn workbench_admit(
        &self,
        host: &Host,
        id: &str,
        lease: Option<&str>,
        name: &str,
        params: &Value,
    ) -> Result<Value> {
        let session = if let Some(lease) = lease {
            self.workbench_session(host, id, lease).map_err(|cause| {
                admission_diagnostic(id, "lease", &cause);
                cause
            })?
        } else {
            self.sessions
                .borrow()
                .get(id)
                .cloned()
                .ok_or_else(unavailable)?
        };
        if !session.shared_current(host) {
            let cause = unavailable();
            admission_diagnostic(id, "current", &cause);
            return Err(cause);
        }
        let registrations = host
            .slots
            .borrow()
            .values()
            .map(|slot| slot.registration.clone())
            .collect::<Vec<_>>();
        let peers = registrations
            .into_iter()
            .map(|registration| admission_project(host, registration))
            .collect::<Result<Vec<_>>>()?;
        let project = peers
            .iter()
            .find(|project| project.registration.project_id == id)
            .context("admission project missing")?;
        schedule_admission::command(
            project,
            &peers,
            name,
            params,
            &CommandAdmission {
                host,
                connection: &session,
            },
        )
        .await
        .map_err(|cause| {
            eprintln!(
                "Host workspace admission connection: projectId={id} coreGeneration={} connectionId={}",
                session.service.identity.generation, session.connection_id
            );
            admission_diagnostic(id, "policy", &cause);
            cause
        })?;
        ensure!(session.shared_current(host), unavailable());
        Ok(json!({"admitted":true}))
    }

    pub(crate) async fn workbench_core_admit(
        &self,
        host: &Host,
        id: &str,
        lease: Option<&str>,
        method: &str,
        params: &Value,
    ) -> Result<()> {
        let Some((name, request)) = core_admission_command(method, params) else {
            return Ok(());
        };
        self.workbench_admit(host, id, lease, name, &request)
            .await?;
        Ok(())
    }
}

impl Connections {
    pub(crate) fn workbench_remote(&self, source: &str, id: &str, lease: &str) -> bool {
        self.terminals.borrow().get(lease).is_some_and(|session| {
            session.project_id == id && session.remote_source.as_deref() == Some(source)
        })
    }
    pub(crate) async fn workbench_cloud_attach(
        &self,
        host: &Rc<Host>,
        source: &str,
        params: &Value,
    ) -> Result<Value> {
        host.migration.source_profile(source)?;
        let url = params["baseURL"].as_str().context("INVALID_PARAMS")?;
        let url = url::Url::parse(url)?;
        ensure!(
            matches!(url.scheme(), "ws" | "wss")
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none(),
            "INVALID_PARAMS"
        );
        let token = params["token"]
            .as_str()
            .filter(|token| {
                !token.is_empty() && token.len() <= 16384 && !token.contains(['\r', '\n'])
            })
            .context("INVALID_PARAMS")?;
        self.terminals
            .borrow_mut()
            .retain(|_, session| !session.closed.get());
        ensure!(
            self.terminals.borrow().len() + self.terminal_connecting.get() < 64,
            "CAPACITY_EXCEEDED"
        );
        self.terminal_connecting
            .set(self.terminal_connecting.get() + 1);
        let _permit = TerminalPermit(&self.terminal_connecting);
        let epoch = self.terminal_epoch.get();
        let lease = uuid::Uuid::new_v4().to_string();
        let project = format!("cloud:{lease}");
        let service = Service {
            identity: areal_protocol::service::Identity {
                protocol_version: 1,
                service_id: lease.clone(),
                generation: lease.clone(),
                workspace: host.home.clone(),
                data_dir: host.home.clone(),
                config_fingerprint: storage::digest(url.as_str().as_bytes()),
            },
            owner: None,
            endpoint: url.to_string(),
            web_url: String::new(),
            auth_file: host.home.join("unused-cloud-auth"),
            log_file: host.home.join("unused-cloud-log"),
            host_pid: 0,
            core_pid: 0,
            state: State::Ready,
        };
        let session = connect_authorized(
            host.clone(),
            &project,
            service,
            true,
            token.into(),
            Some(source.into()),
        )
        .await?;
        let mut guard = AttachGuard(Some(session.clone()));
        let capabilities = session
            .request("areal/capabilities", json!({"apiVersion":"areal.core.v1"}))
            .await?;
        ensure!(
            self.terminal_epoch.get() == epoch
                && capabilities["apiVersion"] == "areal.core.v1"
                && capabilities["methods"].is_array(),
            "CORE_INCOMPATIBLE"
        );
        *session.workbench_lease.borrow_mut() = Some(lease.clone());
        session.ready.set(true);
        let result = json!({"projectId":project,"lease":lease,"coreInstanceId":session.service.identity.service_id,"coreGeneration":session.service.identity.generation,"connectionId":session.connection_id,"capabilities":capabilities});
        self.terminals.borrow_mut().insert(lease, session);
        guard.0 = None;
        Ok(result)
    }
}

impl Connections {
    pub(crate) async fn workbench_media(
        &self,
        host: &Host,
        id: &str,
        lease: &str,
        params: &Value,
    ) -> Result<Value> {
        let session = self.workbench_session(host, id, lease)?;
        ensure!(session.remote_source.is_none(), "FORBIDDEN");
        let thread = params["threadId"].as_str().context("INVALID_PARAMS")?;
        let requested = super::super::conversation_media::MediaParams {
            view: String::new(),
            thread_id: thread.into(),
            subscription_id: String::new(),
            service_generation: session.service.identity.generation.clone(),
            source_thread_id: None,
            turn_id: params["turnId"].as_str().context("INVALID_PARAMS")?.into(),
            item_id: params["itemId"].as_str().context("INVALID_PARAMS")?.into(),
            uri: params["uri"].as_str().context("INVALID_PARAMS")?.into(),
            offset: None,
            length: None,
        };
        let snapshot = session
            .request(
                "thread/read",
                json!({"threadId":thread,"includeTurns":true}),
            )
            .await?;
        let reference = super::super::conversation_media::snapshot_references(&snapshot)
            .into_iter()
            .find(|reference| reference.matches(&requested))
            .context("RESOURCE_UNAVAILABLE")?;
        let cache =
            super::super::conversation_media::fetch(&session.service, thread, reference, || {
                ensure!(session.shared_current(host), unavailable());
                Ok(())
            })
            .await?;
        let after = session
            .request(
                "thread/read",
                json!({"threadId":thread,"includeTurns":true}),
            )
            .await?;
        ensure!(
            session.shared_current(host)
                && super::super::conversation_media::snapshot_references(&after)
                    .iter()
                    .any(|reference| reference.matches(&requested)),
            "RESOURCE_UNAVAILABLE"
        );
        let offset = params["offset"]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .context("INVALID_PARAMS")?;
        let length = params["length"]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .context("INVALID_PARAMS")?;
        cache.chunk(offset, length)
    }
}

impl Connections {
    pub(crate) async fn workbench_blob(
        &self,
        host: &Host,
        id: &str,
        lease: &str,
        params: &Value,
    ) -> Result<Value> {
        use base64::Engine;
        let session = self.workbench_session(host, id, lease)?;
        if let Some(token) = &session.remote_token {
            return super::super::conversation_media::remote_blob(
                &session.service.endpoint,
                token,
                params,
                || {
                    ensure!(session.shared_current(host), unavailable());
                    Ok(())
                },
            )
            .await;
        }
        let thread = params["threadId"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 512)
            .context("INVALID_PARAMS")?;
        match params["operation"].as_str() {
            Some("read") => {
                super::super::conversation_media::read_blob(
                    &session.service,
                    thread,
                    params["uri"].as_str().context("INVALID_PARAMS")?,
                    || {
                        ensure!(session.shared_current(host), unavailable());
                        Ok(())
                    },
                )
                .await
            }
            Some("upload") => {
                ensure!(!session.observer.get(), "FORBIDDEN");
                let encoded = params["base64"]
                    .as_str()
                    .filter(|value| value.len() <= 22_369_624)
                    .context("INVALID_PARAMS")?;
                let bytes = base64::engine::general_purpose::STANDARD.decode(encoded)?;
                ensure!(
                    base64::engine::general_purpose::STANDARD.encode(&bytes) == encoded,
                    "INVALID_PARAMS"
                );
                let result = super::super::conversation_media::upload_owned(
                    &session.service,
                    thread,
                    params["mime"].as_str().context("INVALID_PARAMS")?,
                    bytes,
                    params["callId"].as_str(),
                    params["hostGeneration"].as_str(),
                )
                .await?;
                ensure!(session.shared_current(host), unavailable());
                Ok(result)
            }
            _ => anyhow::bail!("INVALID_PARAMS"),
        }
    }
}

fn core_admission_command(method: &str, params: &Value) -> Option<(&'static str, Value)> {
    let (name, operation) = match method {
        "areal/turn/submit" if params["intent"]["type"] == "continue" => ("continue", None),
        "areal/turn/submit" if params["intent"]["type"] == "edit" => ("editMessage", None),
        "areal/turn/start" | "areal/turn/enqueue" | "areal/turn/submit" | "turn/start" => {
            ("send", None)
        }
        "turn/steer" => ("steer", None),
        "areal/thread/fork" => ("fork", None),
        "areal/interaction/respond" => ("respond", None),
        "areal/queue/update"
        | "areal/queue/reorder"
        | "areal/queue/resume"
        | "areal/queue/steer" => ("queueEdit", None),
        "areal/task/runNow" => ("manage", Some("taskRunNow")),
        "areal/task/resume" => ("manage", Some("taskResume")),
        "areal/task/resumeRun" => ("manage", Some("taskResumeRun")),
        "areal/task/update" => ("manage", Some("taskUpdate")),
        "areal/channel/reply" => ("manage", Some("taskReply")),
        "areal/thread/start"
        | "thread/start"
        | "areal/thread/configure"
        | "areal/thread/prediction"
        | "areal/side/start"
        | "areal/side/close"
        | "areal/process/terminate"
        | "areal/goal/pause"
        | "areal/goal/clear"
        | "areal/thread/closeResources"
        | "areal/workgroup/cancel"
        | "areal/execution/cancel"
        | "areal/tool/acknowledge"
        | "areal/hook/acknowledge"
        | "areal/server/drain"
        | "areal/mcp/app/close"
        | "turn/interrupt"
        | "areal/task/pause"
        | "areal/task/cancel"
        | "areal/task/delete"
        | "areal/task/stopRun" => return None,
        _ if params["threadId"].is_string()
            || params["parentThreadId"].is_string()
            || params["sourceThreadId"].is_string() =>
        {
            ("manage", None)
        }
        _ => return None,
    };
    let mut request = params.clone();
    if let Some(operation) = operation {
        request["operation"] = json!(operation);
    }
    if name == "continue" {
        request["expectedTurnId"] = params["intent"]["expectedTurnId"].clone();
    }
    Some((name, request))
}
#[cfg(test)]
mod admission_translation_tests {
    use super::*;
    #[test]
    fn turn_submit_keeps_continue_turn_identity_and_edit_intent() {
        let input = json!({"threadId":"coordinator","intent":{"type":"continue","expectedTurnId":"original-turn"}});
        let (name, request) = core_admission_command("areal/turn/submit", &input).unwrap();
        assert_eq!(name, "continue");
        assert_eq!(request["expectedTurnId"], "original-turn");
        let (name,request)=core_admission_command("areal/turn/submit",&json!({"threadId":"thread","intent":{"type":"edit","expectedTurnId":"old","itemId":"item"}})).unwrap();
        assert_eq!(name, "editMessage");
        assert!(request.get("expectedTurnId").is_none());
        assert_eq!(
            core_admission_command(
                "areal/turn/submit",
                &json!({"threadId":"thread","intent":{"type":"message"}})
            )
            .unwrap()
            .0,
            "send"
        );
    }
}
