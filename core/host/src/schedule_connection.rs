use super::*;
#[path = "workbench_core.rs"]
mod workbench_core;
#[path = "workbench_frontend.rs"]
mod workbench_frontend;
use crate::schedule_admission::{self, AdmissionProject, AdmissionRpc};
use crate::schedule_resources::{self, PreparedResources};
use futures_util::{SinkExt, StreamExt};
use std::cell::Cell;
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::task::{AbortHandle, JoinSet};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};

#[derive(Debug)]
pub(super) struct RpcFailure(pub Value);
impl std::fmt::Display for RpcFailure {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output.write_str("Core request failed")
    }
}
impl std::error::Error for RpcFailure {}

#[derive(Clone)]
pub(super) struct CoreEvent {
    pub sequence: u64,
    pub value: Value,
}
struct CoreReply {
    value: Value,
    sequence: u64,
}
pub(super) struct CoreObservation {
    pub events: broadcast::Receiver<CoreEvent>,
    session: Rc<CoreSession>,
    thread_id: String,
    options: areal_protocol::desktop::ObserveThread,
}
impl CoreObservation {
    pub(super) fn service(&self) -> &Service {
        &self.session.service
    }
    pub fn current(&self, host: &Host) -> bool {
        self.session.shared_current(host)
    }
    pub fn features(&self) -> Value {
        self.session.capabilities.borrow()["features"].clone()
    }
    pub async fn snapshot(&self, host: &Host) -> Result<(Value, u64)> {
        ensure!(self.session.shared_current(host), unavailable());
        let reply = self
            .session
            .request_with_barrier("areal/thread/observe", serde_json::to_value(&self.options)?)
            .await;
        ensure!(self.session.shared_current(host), unavailable());
        let reply = reply?;
        Ok((reply.value, reply.sequence))
    }
    pub async fn history(
        &self,
        host: &Host,
        view: &str,
        cursor: Option<&str>,
        max_bytes: usize,
    ) -> Result<Value> {
        ensure!(self.session.shared_current(host), unavailable());
        let result = self.session.request("areal/conversation/history", json!({
            "threadId": self.thread_id, "view": view, "cursor": cursor, "maxBytes": max_bytes
        })).await;
        ensure!(self.session.shared_current(host), unavailable());
        result
    }
}
impl Drop for CoreObservation {
    fn drop(&mut self) {
        let mut observed = self.session.observed.borrow_mut();
        let Some(count) = observed.get_mut(&self.thread_id) else {
            return;
        };
        *count -= 1;
        if *count != 0 {
            return;
        }
        observed.remove(&self.thread_id);
        let sequence = self.session.sequence.get() + 1;
        self.session.sequence.set(sequence);
        if self.session.outgoing.try_send(json!({"id":format!("host-{sequence}"),"method":"areal/subscription/remove","params":{"threadIds":[self.thread_id]}})).is_err() {
            self.session.close();
        }
    }
}

const MAX_PENDING: usize = 64;

pub(super) struct Connections {
    sessions: RefCell<BTreeMap<String, Rc<CoreSession>>>,
    terminals: RefCell<BTreeMap<String, Rc<CoreSession>>>,
    terminal_connecting: Cell<usize>,
    terminal_epoch: Cell<u64>,
    frontends: RefCell<BTreeMap<String, workbench_frontend::Frontend>>,
    pub changed: Notify,
}
impl Default for Connections {
    fn default() -> Self {
        Self {
            sessions: RefCell::new(BTreeMap::new()),
            terminals: RefCell::new(BTreeMap::new()),
            terminal_connecting: Cell::new(0),
            terminal_epoch: Cell::new(0),
            frontends: RefCell::new(BTreeMap::new()),
            changed: Notify::new(),
        }
    }
}
impl Connections {
    #[cfg(test)]
    pub(super) async fn connect_test_core(
        &self,
        host: Rc<Host>,
        id: &str,
        service: Service,
    ) -> Result<Box<dyn Fn()>> {
        let session = connect(host, id, service).await?;
        session.ready.set(true);
        if let Some(previous) = self
            .sessions
            .borrow_mut()
            .insert(id.into(), session.clone())
        {
            previous.close();
        }
        Ok(Box::new(move || session.close()))
    }

    pub(super) fn shared_identity(
        &self,
        host: &Host,
        id: &str,
    ) -> Result<(String, String, String)> {
        let session = self
            .sessions
            .borrow()
            .get(id)
            .cloned()
            .ok_or_else(unavailable)?;
        ensure!(session.shared_current(host), unavailable());
        Ok((
            session.service.identity.service_id.clone(),
            session.service.identity.generation.clone(),
            session.connection_id.clone(),
        ))
    }
    pub(super) fn shell_revision(&self, host: &Host, id: &str) -> Result<(String, String, u64)> {
        let sessions = self.sessions.borrow();
        let session = sessions.get(id).ok_or_else(unavailable)?;
        ensure!(session.shared_current(host), unavailable());
        Ok((
            session.connection_id.clone(),
            session.service.identity.generation.clone(),
            session.shell_revision.get(),
        ))
    }
    pub(super) async fn remote_request(
        &self,
        host: &Host,
        id: &str,
        (service_id, generation, connection_id): (&str, &str, &str),
        method: &str,
        params: Value,
    ) -> Result<Value> {
        let session = self
            .sessions
            .borrow()
            .get(id)
            .cloned()
            .ok_or_else(unavailable)?;
        ensure!(
            session.shared_current(host)
                && session.service.identity.service_id == service_id
                && session.service.identity.generation == generation
                && session.connection_id == connection_id,
            unavailable()
        );
        let result = session.request(method, params).await?;
        ensure!(session.shared_current(host), unavailable());
        ensure!(
            session.service.identity.generation == generation,
            unavailable()
        );
        Ok(result)
    }
    pub(super) async fn remote_observe(
        &self,
        host: &Host,
        id: &str,
        generation: &str,
        thread_id: &str,
    ) -> Result<(Value, u64, CoreObservation)> {
        self.observe(
            host,
            id,
            generation,
            areal_protocol::desktop::ObserveThread {
                thread_id: thread_id.into(),
                mode: None,
                max_bytes: None,
            },
        )
        .await
    }
    pub(super) async fn conversation_observe(
        &self,
        host: &Host,
        id: &str,
        generation: &str,
        thread_id: &str,
        max_bytes: usize,
    ) -> Result<(Value, u64, CoreObservation)> {
        self.observe(
            host,
            id,
            generation,
            areal_protocol::desktop::ObserveThread {
                thread_id: thread_id.into(),
                mode: Some(areal_protocol::desktop::ObservationMode::Conversation),
                max_bytes: Some(max_bytes),
            },
        )
        .await
    }
    async fn observe(
        &self,
        host: &Host,
        id: &str,
        generation: &str,
        options: areal_protocol::desktop::ObserveThread,
    ) -> Result<(Value, u64, CoreObservation)> {
        let session = self
            .sessions
            .borrow()
            .get(id)
            .cloned()
            .ok_or_else(unavailable)?;
        ensure!(
            session.shared_current(host) && session.service.identity.generation == generation,
            unavailable()
        );
        if options.mode.is_some() {
            let capabilities = session
                .conversation_capabilities
                .get_or_try_init(|| async {
                    session.request("areal/capabilities", json!({})).await
                })
                .await?;
            ensure!(session.shared_current(host), unavailable());
            ensure!(
                capabilities["features"]["conversationObservation"] == true,
                "CORE_INCOMPATIBLE"
            );
        }
        let events = session.events.subscribe();
        *session
            .observed
            .borrow_mut()
            .entry(options.thread_id.clone())
            .or_default() += 1;
        let observation = CoreObservation {
            events,
            session: session.clone(),
            thread_id: options.thread_id.clone(),
            options,
        };
        let (value, sequence) = observation.snapshot(host).await?;
        Ok((value, sequence, observation))
    }
    pub async fn ready(&self, host: &Host, id: &str, generation: &str) -> Result<()> {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let changed = self.changed.notified();
                if self.sessions.borrow().get(id).is_some_and(|session| {
                    session.service.identity.generation == generation
                        && session.ready.get()
                        && session.current(host)
                }) {
                    return Ok(());
                }
                host.admission()?;
                if host.schedules.suppressed(id) || host.schedules.import_blocked(id) {
                    return Ok(());
                }
                ensure!(
                    host.slots
                        .borrow()
                        .get(id)
                        .and_then(|slot| slot.service.as_ref())
                        .is_some_and(|service| service.identity.generation == generation),
                    unavailable()
                );
                changed.await;
            }
        })
        .await
        .map_err(|_| unavailable())?
    }
}
fn unavailable() -> anyhow::Error {
    error(
        "scheduleHostUnavailable",
        "scheduled preparation connection is unavailable",
    )
}

fn task_connection_ready(host: &Rc<Host>, session: &Rc<CoreSession>) {
    if host.gateway.workbench.rust_source("library-rust").is_some() {
        let host = host.clone();
        let project = session.project_id.clone();
        let connection = session.connection_id.clone();
        // ready 在共享连接安装后调用；异步读取不能占住安装/通知的同步路径。
        tokio::task::spawn_local(async move {
            if super::task_catalog::library_baseline(&host, &project, &connection)
                .await
                .is_err()
            {
                eprintln!("Host library scheduled baseline failed");
            }
        });
    }
    if let Some(body) = super::task_catalog::accept_event(
        host,
        &session.project_id,
        &session.connection_id,
        &json!({"method":"host/connectionReady","params":{}}),
    ) {
        host.gateway
            .workbench
            .tasks_event(host, &session.project_id, body);
    }
}

fn emit_workbench_event(host: &Host, project: &str, lease: &str, event: &Value) {
    if !host
        .schedules
        .connections
        .frontend_event(project, lease, event)
    {
        host.gateway
            .workbench
            .backend_core_event(project, lease, event);
    }
}

fn publish_event(host: &Rc<Host>, connection: &Rc<CoreSession>, value: Value) {
    if changes_shell(&value) {
        connection
            .shell_revision
            .set(connection.shell_revision.get() + 1);
    }
    let sequence = connection.event_sequence.get() + 1;
    connection.event_sequence.set(sequence);
    if connection.terminal {
        if connection.observer.get()
            || connection.desktop.get()
            || connection.remote_source.is_some()
        {
            if let Some(lease) = connection.workbench_lease.borrow().as_deref() {
                let mut event = value;
                event["sequence"] = json!(sequence);
                emit_workbench_event(&host, &connection.project_id, lease, &event);
            }
        }
        return;
    }
    if super::library_service::core_event(host, &connection.project_id, &value).is_err() {
        eprintln!("Host library Core event update failed");
    }
    if let Some(body) = super::task_catalog::accept_event(
        host,
        &connection.project_id,
        &connection.connection_id,
        &value,
    ) {
        host.gateway
            .workbench
            .tasks_event(host, &connection.project_id, body);
    }
    host.gateway
        .workbench
        .core_event(&connection.project_id, &value);
    if let Some(lease) = connection.workbench_lease.borrow().as_deref() {
        let mut event = value.clone();
        event["sequence"] = json!(sequence);
        emit_workbench_event(host, &connection.project_id, lease, &event);
    }
    let _ = connection.events.send(CoreEvent { sequence, value });
}

fn changes_shell(event: &Value) -> bool {
    matches!(
        event["method"].as_str(),
        Some(
            "thread/started"
                | "turn/started"
                | "turn/completed"
                | "areal/thread/configured"
                | "areal/thread/edited"
                | "areal/thread/archived"
                | "areal/thread/unarchived"
                | "areal/task/updated"
                | "areal/queue/updated"
                | "areal/interaction/requested"
                | "areal/interaction/resolved"
                | "areal/goal/updated"
                | "areal/goal/cleared"
        )
    )
}

struct CoreSession {
    project_id: String,
    connection_id: String,
    service: Service,
    outgoing: mpsc::Sender<Value>,
    pending: RefCell<BTreeMap<String, oneshot::Sender<Result<CoreReply>>>>,
    sequence: Cell<u64>,
    closed: Cell<bool>,
    ready: Cell<bool>,
    events: broadcast::Sender<CoreEvent>,
    event_sequence: Cell<u64>,
    shell_revision: Cell<u64>,
    observed: RefCell<BTreeMap<String, usize>>,
    capabilities: RefCell<Value>,
    workbench_lease: RefCell<Option<String>>,
    terminal: bool,
    observer: Cell<bool>,
    desktop: Cell<bool>,
    remote_source: Option<String>,
    remote_token: Option<String>,
    conversation_capabilities: tokio::sync::OnceCell<Value>,
    refresh: Notify,
    refresh_requested: Cell<bool>,
    driver: RefCell<Option<AbortHandle>>,
}
impl CoreSession {
    fn current(&self, host: &Host) -> bool {
        self.shared_current(host)
            && !host.schedules.suppressed(&self.project_id)
            && !host.schedules.import_blocked(&self.project_id)
    }
    fn shared_current(&self, host: &Host) -> bool {
        !self.closed.get()
            && host.admission().is_ok()
            && (self.remote_source.is_some()
                || host
                    .slots
                    .borrow()
                    .get(&self.project_id)
                    .is_some_and(|slot| {
                        slot.state == "ready"
                            && slot
                                .service
                                .as_ref()
                                .is_some_and(|service| service.identity == self.service.identity)
                    }))
    }
    fn require_current(&self, host: &Host) -> Result<()> {
        ensure!(self.current(host), unavailable());
        Ok(())
    }
    fn invalidate(&self) {
        if self.closed.replace(true) {
            return;
        }
        let sequence = self.event_sequence.get() + 1;
        self.event_sequence.set(sequence);
        let _ = self.events.send(CoreEvent {
            sequence,
            value: json!({"method":"host/connectionClosed","params":{}}),
        });
        self.ready.set(false);
        for (_, reply) in std::mem::take(&mut *self.pending.borrow_mut()) {
            let _ = reply.send(Err(unavailable()));
        }
        self.refresh.notify_one();
    }
    fn close(&self) {
        self.invalidate();
        if let Some(driver) = self.driver.borrow_mut().take() {
            driver.abort();
        }
    }
    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        Ok(self.request_with_barrier(method, params).await?.value)
    }
    async fn request_with_barrier(&self, method: &str, params: Value) -> Result<CoreReply> {
        ensure!(
            !self.closed.get() && self.pending.borrow().len() < MAX_PENDING,
            unavailable()
        );
        let sequence = self.sequence.get() + 1;
        self.sequence.set(sequence);
        let id = format!("host-{sequence}");
        let (sender, receiver) = oneshot::channel();
        self.pending.borrow_mut().insert(id.clone(), sender);
        let _pending = Pending {
            session: self,
            id: id.clone(),
        };
        tokio::time::timeout(Duration::from_secs(62), async {
            self.outgoing
                .try_send(json!({"id":id,"method":method,"params":params}))
                .map_err(|_| unavailable())?;
            receiver.await.map_err(|_| unavailable())?
        })
        .await
        .map_err(|_| unavailable())?
    }
}
struct Pending<'a> {
    session: &'a CoreSession,
    id: String,
}
impl Drop for Pending<'_> {
    fn drop(&mut self) {
        self.session.pending.borrow_mut().remove(&self.id);
    }
}
struct SessionGuard(Rc<CoreSession>);
impl Drop for SessionGuard {
    fn drop(&mut self) {
        self.0.close();
    }
}
struct DriverGuard(Rc<CoreSession>, std::rc::Weak<Host>);
impl Drop for DriverGuard {
    fn drop(&mut self) {
        self.0.invalidate();
        if let Some(host) = self.1.upgrade() {
            if let Some(lease) = self.0.workbench_lease.borrow().as_deref() {
                emit_workbench_event(
                    &host,
                    &self.0.project_id,
                    lease,
                    &json!({"method":"host/connectionClosed","params":{}}),
                );
            }
        }
    }
}

async fn connect(host: Rc<Host>, id: &str, service: Service) -> Result<Rc<CoreSession>> {
    connect_owned(host, id, service, false).await
}

async fn connect_owned(
    host: Rc<Host>,
    id: &str,
    service: Service,
    terminal: bool,
) -> Result<Rc<CoreSession>> {
    let auth: Value = storage::read(&service.auth_file)?;
    let principal = auth["principals"]
        .as_array()
        .and_then(|principals| {
            principals
                .iter()
                .find(|principal| principal["id"] == "desktop-owner")
        })
        .context("schedule host requires the desktop-owner principal")?;
    let token = principal["token"]
        .as_str()
        .filter(|token| !token.is_empty())
        .context("schedule host principal has no token")?;
    connect_authorized(host, id, service, terminal, token.to_owned(), None).await
}
async fn connect_authorized(
    host: Rc<Host>,
    id: &str,
    service: Service,
    terminal: bool,
    token: String,
    remote_source: Option<String>,
) -> Result<Rc<CoreSession>> {
    let mut request = service.endpoint.as_str().into_client_request()?;
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {token}").parse()?);
    let (socket, _) = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::connect_async(request),
    )
    .await??;
    let (outgoing, mut messages) = mpsc::channel::<Value>(MAX_PENDING);
    let session = Rc::new(CoreSession {
        project_id: id.into(),
        connection_id: uuid::Uuid::new_v4().to_string(),
        service,
        outgoing,
        pending: RefCell::new(BTreeMap::new()),
        sequence: Cell::new(0),
        closed: Cell::new(false),
        ready: Cell::new(false),
        events: broadcast::channel(16).0,
        event_sequence: Cell::new(0),
        shell_revision: Cell::new(0),
        observed: RefCell::new(BTreeMap::new()),
        capabilities: RefCell::new(Value::Null),
        workbench_lease: RefCell::new(None),
        terminal,
        observer: Cell::new(false),
        desktop: Cell::new(false),
        remote_token: remote_source.as_ref().map(|_| token.clone()),
        remote_source,
        conversation_capabilities: tokio::sync::OnceCell::new(),
        refresh: Notify::new(),
        refresh_requested: Cell::new(false),
        driver: RefCell::new(None),
    });
    let connection = session.clone();
    let driver = tokio::task::spawn_local(async move {
        let _guard = DriverGuard(connection.clone(), Rc::downgrade(&host));
        let (mut writer, mut reader) = socket.split();
        let mut callbacks = JoinSet::new();
        loop {
            tokio::select! {
                outgoing = messages.recv() => {
                    let Some(value) = outgoing else { break; };
                    if writer.send(Message::Text(value.to_string().into())).await.is_err() { break; }
                }
                incoming = reader.next() => {
                    let Some(Ok(message)) = incoming else { break; };
                    match message {
                        Message::Text(text) => {
                            let Ok(value) = serde_json::from_str::<Value>(&text) else { break; };
                            if let Some(method) = value["method"].as_str() {
                                if value.get("id").is_none() { publish_event(&host, &connection, value); continue; }
                                if callbacks.len() >= MAX_PENDING { break; }
                                let host = host.clone();
                                let connection = connection.clone();
                                let method = method.to_owned();
                                callbacks.spawn_local(async move {
                                    let result = callback(&host, &connection, &method, &value["params"], &value["id"]).await.and_then(|result| { if method == "areal/host/status" { ensure!(connection.shared_current(&host), unavailable()); } else { connection.require_current(&host)?; } Ok(result) });
                                    let response = match result {
                                        Ok(result) => json!({"id":value["id"],"result":result}),
                                        Err(_) => json!({"id":value["id"],"error":{"code":-32001,"message":"Host scheduled preparation or desktop tool unavailable"}}),
                                    };
                                    if connection.outgoing.try_send(response).is_err() { connection.close(); }
                                });
                            } else if let Some(id) = value["id"].as_str()
                                && let Some(reply) = connection.pending.borrow_mut().remove(id) {
                                    let result = if let Some(error) = value.get("error") { Err(RpcFailure(error.clone()).into()) } else { value.get("result").cloned().map(|value| CoreReply { value, sequence: connection.event_sequence.get() }).ok_or_else(unavailable) };
                                    let _ = reply.send(result);
                                }
                        }
                        Message::Ping(bytes) => if writer.send(Message::Pong(bytes)).await.is_err() { break; },
                        Message::Close(_) => break,
                        _ => {}
                    }
                }
                _ = callbacks.join_next(), if !callbacks.is_empty() => {}
            }
        }
    });
    *session.driver.borrow_mut() = Some(driver.abort_handle());
    let initialized = session.request("initialize", json!({"clientInfo":{"name":"areal_host_scheduler","version":env!("CARGO_PKG_VERSION")}})).await;
    match initialized {
        Ok(value) => *session.capabilities.borrow_mut() = value["capabilities"].clone(),
        Err(cause) => {
            session.close();
            return Err(cause);
        }
    }
    session
        .outgoing
        .send(json!({"method":"initialized"}))
        .await
        .map_err(|_| unavailable())?;
    Ok(session)
}

pub(super) fn inputs(host: &Host, id: &str) -> Result<LaunchInputs> {
    storage::read(
        &host
            .home
            .join("host/launch")
            .join(storage::digest(id.as_bytes()))
            .join("inputs.json"),
    )
}
fn admission_project(host: &Host, registration: ProjectRegistration) -> Result<AdmissionProject> {
    let (metadata_home, legacy_project_id) = host
        .migration
        .scheduling_metadata(&registration)?
        .unwrap_or_else(|| (host.home.clone(), registration.project_id.clone()));
    Ok(AdmissionProject {
        registration,
        metadata_home,
        legacy_project_id,
    })
}
struct Admission<'a> {
    host: &'a Host,
    connection: &'a CoreSession,
}
impl AdmissionRpc for Admission<'_> {
    async fn request(&self, project_id: &str, method: &str, params: Value) -> Result<Value> {
        self.connection.require_current(self.host)?;
        let result = if project_id == self.connection.project_id {
            self.connection.request(method, params).await?
        } else {
            let status = self.host.project_status(project_id).await;
            let service = status
                .service
                .context("peer project is unavailable for schedule admission")?;
            areal_local_service::rpc(&service, method, params).await?
        };
        self.connection.require_current(self.host)?;
        Ok(result)
    }
}
async fn callback(
    host: &Host,
    connection: &CoreSession,
    method: &str,
    params: &Value,
    request_id: &Value,
) -> Result<Value> {
    ensure!(connection.remote_source.is_none(), unavailable());
    if method == "areal/host/status" {
        ensure!(connection.shared_current(host), unavailable());
        ensure!(
            params.as_object().is_some_and(|p| p.is_empty()),
            "expected empty Host status request"
        );
        let status = host.update_status()?;
        return Ok(serde_json::to_value(
            areal_protocol::desktop::HostUpdateStatus {
                host_id: host.identity.host_id.clone(),
                generation: host.identity.generation.clone(),
                executable_version: host.identity.executable_version.clone(),
                capabilities: vec!["updates".into()],
                restart_pending: status["restartPending"] == true,
                target_version: status["targetVersion"].as_str().map(str::to_owned),
            },
        )?);
    }
    connection.require_current(host)?;
    if matches!(
        method,
        "item/tool/call"
            | "areal/browser/prepare"
            | "areal/computer/prepare"
            | "areal/cua/turnEnded"
    ) {
        let lease = connection
            .workbench_lease
            .borrow()
            .clone()
            .context("desktop tool host unavailable")?;
        if let Some(result) = host
            .schedules
            .connections
            .frontend_callback(&connection.project_id, &lease, method, params, request_id)
            .await
        {
            return result;
        }
        return host
            .gateway
            .workbench
            .backend_core_callback(&connection.project_id, &lease, method, params, request_id)
            .await;
    }
    ensure!(method == "areal/task/prepare", unavailable());
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
        .find(|project| project.registration.project_id == connection.project_id)
        .context("schedule project missing")?;
    schedule_admission::prepare(project, &peers, params, &Admission { host, connection }).await?;
    connection.require_current(host)?;
    if params["intent"] == "resume" {
        return Ok(json!({}));
    }
    let inputs = inputs(host, &connection.project_id)?;
    let mut result = json!({"dynamicTools":[]});
    match &inputs.schedule_preparation {
        Some(crate::SchedulePreparation::External {
            default_profile: None,
        }) if inputs.deployment_path.is_none() => {}
        Some(_) => {
            let prepared =
                schedule_resources::materialize(&host.home, &project.registration, &inputs)?;
            if let Some(profile) = prepared.profile {
                let profiles = connection.request("areal/profile/list", json!({})).await?;
                connection.require_current(host)?;
                let available = profiles["data"].as_array().is_some_and(|profiles| {
                    profiles.iter().any(|value| {
                        value["id"] == profile["id"] && value["revision"] == profile["revision"]
                    })
                });
                if !available {
                    ensure!(
                        prepared.fingerprint != "external",
                        error(
                            "configurationConflict",
                            "configured schedule profile is unavailable"
                        )
                    );
                    connection.refresh_requested.set(true);
                    connection.refresh.notify_one();
                    // 旧连接关闭由 Core 保留原 queued Run，错误响应会把该 Run 结算为 blocked。
                    return std::future::pending().await;
                }
                result["agentProfile"] = profile;
            }
        }
        None => {
            ensure!(
                matches!(project.registration.source, crate::ProjectSource::Cli),
                error(
                    "configurationConflict",
                    "GUI schedule preparation inputs are missing"
                )
            );
        }
    }
    let models = connection.request("areal/model/list", json!({})).await?;
    connection.require_current(host)?;
    let model = models["data"]
        .as_array()
        .and_then(|models| models.iter().find(|model| model["isDefault"] == true))
        .context("schedule default model is unavailable")?;
    if model["providerId"].is_string() {
        result["model"] = json!({"providerId":model["providerId"],"modelId":model["modelId"]});
    }
    if model["parameters"].is_object() {
        result["parameters"] = model["parameters"].clone();
    }
    Ok(result)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Refresh {
    request_id: String,
    stop_request_id: String,
    previous_generation: String,
    drained: bool,
    submitted: std::collections::BTreeSet<String>,
    inputs: LaunchInputs,
    mcp: Vec<String>,
    plugins: Vec<Value>,
}
pub(super) fn refresh_path(host: &Host, id: &str) -> PathBuf {
    host.home
        .join("host/launch")
        .join(storage::digest(id.as_bytes()))
        .join("schedule-refresh.json")
}
pub(super) async fn activation_pending(host: &Host, id: &str) -> Result<bool> {
    let Some(refresh): Option<Refresh> = storage::read_optional(&refresh_path(host, id))? else {
        return Ok(false);
    };
    Ok(host
        .reconcile(&refresh.request_id)
        .await?
        .is_none_or(|receipt| receipt["state"] != "completed"))
}

async fn capture_refresh(host: &Host, session: &CoreSession) -> Result<Refresh> {
    session.require_current(host)?;
    let mut inputs = inputs(host, &session.project_id)?;
    let registration = host.slots.borrow()[&session.project_id]
        .registration
        .clone();
    let PreparedResources {
        deployment_path, ..
    } = schedule_resources::materialize(&host.home, &registration, &inputs)?;
    ensure!(
        session.request("areal/server/status", json!({})).await?["restartSafe"] == true,
        unavailable()
    );
    let connected = session.request("areal/mcp/list", json!({})).await?;
    let plugins = session.request("areal/plugin/mcp/list", json!({})).await?;
    session.require_current(host)?;
    inputs.deployment_path = Some(deployment_path);
    let refresh = Refresh {
        request_id: uuid::Uuid::new_v4().to_string(),
        stop_request_id: uuid::Uuid::new_v4().to_string(),
        previous_generation: session.service.identity.generation.clone(),
        drained: false,
        submitted: Default::default(),
        inputs,
        mcp: connected["data"]
            .as_array()
            .context("invalid MCP snapshot")?
            .iter()
            .filter(|row| matches!(row["state"].as_str(), Some("connected" | "stale")))
            .map(|row| {
                row["id"]
                    .as_str()
                    .context("invalid MCP identity")
                    .map(str::to_owned)
            })
            .collect::<Result<_>>()?,
        plugins: plugins["data"]
            .as_array()
            .context("invalid plugin snapshot")?
            .iter()
            .filter(|row| {
                row["trusted"] == true
                    && matches!(row["state"].as_str(), Some("connected" | "partial"))
            })
            .map(|row| json!({"pluginId":row["pluginId"],"installedDigest":row["installedDigest"]}))
            .collect(),
    };
    storage::write(&refresh_path(host, &session.project_id), &refresh)?;
    ensure!(
        session
            .request(
                "areal/server/drain",
                json!({"strategy":"wait","timeoutMs":5000})
            )
            .await?["restartSafe"]
            == true,
        unavailable()
    );
    session.require_current(host)?;
    let mut refresh = refresh;
    refresh.drained = true;
    storage::write(&refresh_path(host, &session.project_id), &refresh)?;
    Ok(refresh)
}
async fn restart(host: &Host, id: &str, refresh: &mut Refresh) -> Result<()> {
    if let Some(receipt) = host.reconcile(&refresh.request_id).await? {
        ensure!(
            receipt["state"] == "completed",
            error(
                "scheduleAdmissionUnknown",
                "reconcile original schedule resource activation"
            )
        );
        ensure!(
            host.project_status(id).await.service.is_some(),
            unavailable()
        );
        return Ok(());
    }
    if !refresh.drained {
        host.admission()?;
        ensure!(!host.schedules.suppressed(id), unavailable());
        let instance = Host::service_id(&host.slots.borrow()[id].registration);
        let service = areal_local_service::status(&host.home, &instance).await?;
        ensure!(
            service.identity.generation == refresh.previous_generation,
            unavailable()
        );
        match service.state {
            State::Ready => {
                ensure!(
                    areal_local_service::rpc(
                        &service,
                        "areal/server/drain",
                        json!({"strategy":"wait","timeoutMs":5000})
                    )
                    .await?["restartSafe"]
                        == true,
                    unavailable()
                );
            }
            State::Stopped => host.cleanup_proof(&service).await?,
            _ => return Err(unavailable()),
        }
        refresh.drained = true;
        storage::write(&refresh_path(host, id), refresh)?;
    }
    let stopped = match host.reconcile(&refresh.stop_request_id).await? {
        Some(receipt) => receipt,
        None => {
            host.stop_project(Stop {
                request_id: refresh.stop_request_id.clone(),
                expected_generation: host.identity.generation.clone(),
                strategy: StopStrategy::Cancel,
                suppress_scheduling: false,
                project_id: Some(id.into()),
                service_generation: Some(refresh.previous_generation.clone()),
            })
            .await?
        }
    };
    ensure!(
        stopped["state"] == "completed",
        error(
            "scheduleAdmissionUnknown",
            "reconcile original schedule resource stop"
        )
    );
    host.ensure_generation(
        Ensure {
            request_id: refresh.request_id.clone(),
            expected_generation: host.identity.generation.clone(),
            project_id: id.into(),
            no_auto_restart: false,
            resume_scheduling: false,
            launch_inputs: Some(refresh.inputs.clone()),
            credentials: BTreeMap::new(),
        },
        true,
        Some(&refresh.previous_generation),
    )
    .await?;
    Ok(())
}
async fn restore_mutation(
    host: &Host,
    session: &CoreSession,
    refresh: &mut Refresh,
    method: &str,
    params: Value,
) -> Result<Value> {
    let request_id = params["requestId"]
        .as_str()
        .context("restore request identity missing")?;
    let receipts = session
        .request("areal/request/read", json!({"requestId":request_id}))
        .await?;
    let records = receipts["data"]
        .as_array()
        .context("restore receipt coverage unavailable")?;
    if let Some(receipt) = records
        .iter()
        .find(|receipt| receipt["operation"]["method"] == method)
    {
        ensure!(
            receipt["status"] == "completed",
            error(
                "scheduleRestoreUnknown",
                "original resource restore must be reconciled"
            )
        );
        return receipt
            .get("result")
            .cloned()
            .context("restore result unavailable");
    }
    ensure!(
        !refresh.submitted.contains(request_id),
        error(
            "scheduleRestoreUnknown",
            "original resource restore has no conclusive receipt"
        )
    );
    refresh.submitted.insert(request_id.to_owned());
    storage::write(&refresh_path(host, &session.project_id), refresh)?;
    session.request(method, params).await
}

async fn restore(host: &Host, session: &CoreSession, refresh: &mut Refresh) -> Result<()> {
    for request_id in &refresh.submitted {
        let receipts = session
            .request("areal/request/read", json!({"requestId":request_id}))
            .await?;
        ensure!(
            receipts["data"]
                .as_array()
                .is_some_and(|rows| rows.len() == 1 && rows[0]["status"] == "completed"),
            error(
                "scheduleRestoreUnknown",
                "original resource restore must be reconciled before reconnecting"
            )
        );
        session.require_current(host)?;
    }
    let current = session.request("areal/mcp/list", json!({})).await?;
    for (index, id) in refresh.mcp.clone().iter().enumerate() {
        let row = current["data"]
            .as_array()
            .and_then(|rows| rows.iter().find(|row| row["id"] == *id))
            .context("scheduled MCP configuration missing after restart")?;
        restore_mutation(host, session, refresh, "areal/mcp/connect", json!({"requestId":format!("{}-{}-mcp-{index}", refresh.request_id, session.service.identity.generation),"id":id,"expectedRevision":row["revision"]})).await?;
        let restored = session.request("areal/mcp/list", json!({})).await?;
        session.require_current(host)?;
        ensure!(
            restored["data"]
                .as_array()
                .is_some_and(|rows| rows.iter().any(|row| row["id"] == *id
                    && matches!(row["state"].as_str(), Some("connected" | "stale")))),
            error("scheduleRestoreFailed", "MCP connection did not restore")
        );
    }
    for (index, plugin) in refresh.plugins.clone().iter().enumerate() {
        restore_mutation(host, session, refresh, "areal/plugin/connection", json!({"requestId":format!("{}-{}-plugin-{index}", refresh.request_id, session.service.identity.generation),"id":plugin["pluginId"],"expectedDigest":plugin["installedDigest"],"connect":true})).await?;
        let restored = session.request("areal/plugin/mcp/list", json!({})).await?;
        session.require_current(host)?;
        ensure!(
            restored["data"]
                .as_array()
                .is_some_and(
                    |rows| rows.iter().any(|row| row["pluginId"] == plugin["pluginId"]
                        && row["installedDigest"] == plugin["installedDigest"]
                        && row["trusted"] == true
                        && matches!(row["state"].as_str(), Some("connected" | "partial")))
                ),
            error("scheduleRestoreFailed", "plugin connection did not restore")
        );
    }
    Ok(())
}

async fn project(host: Rc<Host>, id: String) -> Result<()> {
    let preparation = !host.schedules.suppressed(&id) && !host.schedules.import_blocked(&id);
    let registration = host.slots.borrow()[&id].registration.clone();
    ensure!(
        !preparation
            || matches!(registration.source, crate::ProjectSource::Cli)
            || inputs(&host, &id)?.schedule_preparation.is_some(),
        error(
            "configurationConflict",
            "GUI schedule preparation inputs are missing"
        )
    );
    let mut refresh: Option<Refresh> = storage::read_optional(&refresh_path(&host, &id))?;
    loop {
        if preparation && let Some(refresh) = &mut refresh {
            restart(&host, &id, refresh).await?;
        }
        host.admission()?;
        ensure!(
            preparation == (!host.schedules.suppressed(&id) && !host.schedules.import_blocked(&id)),
            unavailable()
        );
        let status = host.project_status(&id).await;
        let service = status.service.context("scheduled Core unavailable")?;
        let session = connect(host.clone(), &id, service).await?;
        let _guard = SessionGuard(session.clone());
        if !preparation {
            host.schedules
                .connections
                .sessions
                .borrow_mut()
                .insert(id.clone(), session.clone());
            host.schedules.connections.changed.notify_waiters();
            task_connection_ready(&host, &session);
            let mut changes = host.changes.subscribe();
            loop {
                ensure!(
                    session.shared_current(&host)
                        && (host.schedules.suppressed(&id) || host.schedules.import_blocked(&id)),
                    unavailable()
                );
                tokio::select! {
                    _ = session.refresh.notified() => {},
                    _ = changes.changed() => {},
                    _ = tokio::time::sleep(Duration::from_secs(1)) => {},
                }
            }
        }
        if let Some(refresh) = &mut refresh {
            restore(&host, &session, refresh).await?;
            session.require_current(&host)?;
            std::fs::remove_file(refresh_path(&host, &id))?;
        }
        session.require_current(&host)?;
        session.request("areal/task/host/ready", json!({})).await?;
        session.require_current(&host)?;
        session.ready.set(true);
        host.schedules.preparation_result(&id, Ok(()))?;
        host.changed();
        host.schedules
            .connections
            .sessions
            .borrow_mut()
            .insert(id.clone(), session.clone());
        host.schedules.connections.changed.notify_waiters();
        task_connection_ready(&host, &session);
        let mut changes = host.changes.subscribe();
        loop {
            if !session.current(&host) {
                return Err(unavailable());
            }
            if session.refresh_requested.replace(false) {
                // 回调等待旧连接关闭，重启由项目连接任务完成，不随旧 socket 取消。
                refresh = Some(capture_refresh(&host, &session).await?);
                break;
            }
            tokio::select! {
                _ = session.refresh.notified() => {},
                _ = changes.changed() => {},
                _ = tokio::time::sleep(Duration::from_secs(1)) => {},
            }
        }
        session.close();
    }
}

pub(super) async fn run(host: Rc<Host>) {
    let mut workers = JoinSet::new();
    let mut active = std::collections::BTreeSet::new();
    let mut retry = BTreeMap::new();
    let mut changes = host.changes.subscribe();
    loop {
        let projects = host
            .slots
            .borrow()
            .iter()
            .filter(|(id, slot)| {
                let owned_retry = slot.state == "unavailable"
                    && !slot.uncertain_start
                    && slot.writer.is_some()
                    && slot
                        .service
                        .as_ref()
                        .is_some_and(|service| service.owner.as_ref() == Some(&host.owner()));
                (slot.state == "ready" || owned_retry || refresh_path(&host, id).exists())
                    && !active.contains(*id)
                    && retry
                        .get(*id)
                        .is_none_or(|deadline| std::time::Instant::now() >= *deadline)
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in projects {
            active.insert(id.clone());
            let host = host.clone();
            workers.spawn_local(async move {
                let result = project(host, id.clone()).await;
                (id, result)
            });
        }
        tokio::select! {
            result = workers.join_next(), if !workers.is_empty() => {
                if let Some(Ok((id, result))) = result {
                    active.remove(&id);
                    retry.insert(id.clone(), std::time::Instant::now() + Duration::from_secs(5));
                    host.schedules.connections.sessions.borrow_mut().remove(&id);
                    host.schedules.connections.changed.notify_waiters();
                    let _ = host.schedules.preparation_result(&id, result);
                    host.schedules.wake.notify_one();
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            },
            _ = changes.changed() => {},
            _ = tokio::time::sleep(Duration::from_secs(1)) => {},
        }
    }
}

#[cfg(test)]
mod tests {
    struct ScheduleHeaders;
    impl tokio_tungstenite::tungstenite::handshake::server::Callback for ScheduleHeaders {
        fn on_request(
            self,
            request: &tokio_tungstenite::tungstenite::handshake::server::Request,
            response: tokio_tungstenite::tungstenite::handshake::server::Response,
        ) -> Result<
            tokio_tungstenite::tungstenite::handshake::server::Response,
            tokio_tungstenite::tungstenite::handshake::server::ErrorResponse,
        > {
            assert_eq!(
                request.headers()["authorization"],
                "Bearer fixture-owner-token"
            );
            Ok(response)
        }
    }

    use super::*;
    use tokio::net::TcpListener;
    use tokio_tungstenite::WebSocketStream;

    async fn receive(socket: &mut WebSocketStream<tokio::net::TcpStream>) -> Value {
        loop {
            if let Message::Text(text) = socket.next().await.unwrap().unwrap() {
                let value: Value = serde_json::from_str(&text).unwrap();
                if value["method"] != "initialized" {
                    return value;
                }
            }
        }
    }
    async fn send(socket: &mut WebSocketStream<tokio::net::TcpStream>, value: Value) {
        socket
            .send(Message::Text(value.to_string().into()))
            .await
            .unwrap();
    }
    fn service(host: &Host, endpoint: String) -> Service {
        let registration = host.slots.borrow()["project"].registration.clone();
        let service = Service {
            identity: areal_protocol::service::Identity {
                protocol_version: 1,
                service_id: "fixture".into(),
                generation: "first".into(),
                workspace: registration.workspace,
                data_dir: registration.data_dir,
                config_fingerprint: "fixture".into(),
            },
            owner: Some(host.owner()),
            endpoint,
            web_url: String::new(),
            auth_file: host.home.join("core-auth.json"),
            log_file: host.home.join("core.log"),
            host_pid: 1,
            core_pid: 2,
            state: State::Ready,
        };
        storage::write(&service.auth_file, &json!({"principals":[{"id":"observer","token":"wrong-token"},{"id":"desktop-owner","token":"fixture-owner-token"}]})).unwrap();
        let mut slots = host.slots.borrow_mut();
        let slot = slots.get_mut("project").unwrap();
        slot.service = Some(service.clone());
        slot.state = "ready".into();
        service
    }

    #[tokio::test(flavor = "current_thread")]
    async fn terminal_detach_closes_only_its_original_core_socket() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let host = Rc::new(super::super::schedules::tests::fixture(root.path()));
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let service = service(&host, format!("ws://{}/", listener.local_addr().unwrap()));
                let server = tokio::task::spawn_local(async move {
                    let mut sockets = Vec::new();
                    for _ in 0..2 {
                        let (stream, _) = listener.accept().await.unwrap();
                        let mut socket =
                            tokio_tungstenite::accept_hdr_async(stream, ScheduleHeaders)
                                .await
                                .unwrap();
                        let initialize = receive(&mut socket).await;
                        send(&mut socket, json!({"id":initialize["id"],"result":{}})).await;
                        sockets.push(socket);
                    }
                    let mut terminal = sockets.pop().unwrap();
                    // 原Core连接关闭是connectionProcesses既有清理的触发点。
                    while let Some(message) = terminal.next().await {
                        if message.is_err() || matches!(message, Ok(Message::Close(_))) {
                            break;
                        }
                    }
                    let mut primary = sockets.pop().unwrap();
                    let request = receive(&mut primary).await;
                    assert_eq!(request["method"], "areal/server/status");
                    send(
                        &mut primary,
                        json!({"id":request["id"],"result":{"alive":true}}),
                    )
                    .await;
                });
                let primary = connect(host.clone(), "project", service.clone())
                    .await
                    .unwrap();
                let terminal = connect_owned(host.clone(), "project", service, true)
                    .await
                    .unwrap();
                *primary.workbench_lease.borrow_mut() = Some("primary".into());
                *terminal.workbench_lease.borrow_mut() = Some("terminal".into());
                host.schedules
                    .connections
                    .sessions
                    .borrow_mut()
                    .insert("project".into(), primary.clone());
                host.schedules
                    .connections
                    .terminals
                    .borrow_mut()
                    .insert("terminal".into(), terminal.clone());
                assert_eq!(
                    host.schedules
                        .connections
                        .workbench_detach(&host, "project", "terminal")
                        .unwrap()["closed"],
                    true
                );
                assert!(terminal.closed.get());
                assert!(!primary.closed.get());
                assert_eq!(
                    primary
                        .request("areal/server/status", json!({}))
                        .await
                        .unwrap()["alive"],
                    true
                );
                server.await.unwrap();
                primary.close();
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn authenticated_socket_multiplexes_nested_prepare_reads_and_rejects_desktop_tools() {
        tokio::task::LocalSet::new().run_until(async {
            let root = tempfile::tempdir().unwrap();
            let host = Rc::new(super::super::schedules::tests::fixture(root.path()));
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let service = service(&host, format!("ws://{}/", listener.local_addr().unwrap()));
            let server = tokio::task::spawn_local(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_hdr_async(stream, ScheduleHeaders).await.unwrap();
                let initialize = receive(&mut socket).await;
                assert_eq!(initialize["method"], "initialize");
                send(&mut socket, json!({"id":initialize["id"],"result":{}})).await;
                let first = receive(&mut socket).await;
                let second = receive(&mut socket).await;
                send(&mut socket, json!({"id":1,"method":"areal/task/prepare","params":{"taskId":"task","runId":"run","threadId":"anchor","intent":"start"}})).await;
                let nested = receive(&mut socket).await;
                assert_eq!(nested["method"], "areal/task/read");
                send(&mut socket, json!({"id":nested["id"],"result":{}})).await;
                let preparation = receive(&mut socket).await;
                assert_eq!(preparation["id"], 1);
                assert!(preparation.get("error").is_some());
                send(&mut socket, json!({"id":2,"method":"item/tool/call","params":{"tool":"js"}})).await;
                let tool = receive(&mut socket).await;
                assert_eq!(tool["id"], 2);
                assert!(tool.get("error").is_some());
                send(&mut socket, json!({"id":second["id"],"result":"second"})).await;
                send(&mut socket, json!({"id":first["id"],"result":"first"})).await;
                let pending = receive(&mut socket).await;
                assert_eq!(pending["method"], "waiting");
                socket.close(None).await.unwrap();
            });
            let session = connect(host, "project", service).await.unwrap();
            let (first, second) = tokio::join!(session.request("first", json!({})), session.request("second", json!({})));
            assert_eq!(first.unwrap(), "first");
            assert_eq!(second.unwrap(), "second");
            assert!(session.request("waiting", json!({})).await.is_err());
            assert!(session.pending.borrow().is_empty());
            assert!(session.closed.get());
            server.await.unwrap();
            session.close();
        }).await;
    }
    #[tokio::test(flavor = "current_thread")]
    async fn refresh_records_drain_and_original_maintenance_stop_before_activation() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let host = Rc::new(super::super::schedules::tests::fixture(root.path()));
                let registration = host.slots.borrow()["project"].registration.clone();
                storage::private_dir(&registration.data_dir).unwrap();
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let mut service =
                    service(&host, format!("ws://{}/", listener.local_addr().unwrap()));
                service.identity.service_id = Host::service_id(&registration);
                host.slots.borrow_mut().get_mut("project").unwrap().service = Some(service.clone());
                let directory =
                    storage::registry(&host.home, &service.identity.service_id).unwrap();
                storage::private_dir(&directory).unwrap();
                storage::write(&directory.join("service.json"), &service).unwrap();
                let deployment = host.home.join("deployment.json");
                storage::write(&deployment, &json!({"profiles":[]})).unwrap();
                let inputs = LaunchInputs {
                    workspace: registration.workspace.clone(),
                    cwd: registration.workspace,
                    config_home: host.home.clone(),
                    homedir: None,
                    config_path: None,
                    deployment_path: Some(deployment),
                    schedule_preparation: Some(crate::SchedulePreparation::External {
                        default_profile: None,
                    }),
                    environment: BTreeMap::new(),
                    credential_names: vec![],
                    options: Default::default(),
                };
                let path = refresh_path(&host, "project");
                storage::private_dir(path.parent().unwrap()).unwrap();
                storage::write(&path.parent().unwrap().join("inputs.json"), &inputs).unwrap();
                let observed_host = host.clone();
                let server = tokio::task::spawn_local(async move {
                    let (stream, _) = listener.accept().await.unwrap();
                    let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                    for method in [
                        "initialize",
                        "areal/server/status",
                        "areal/mcp/list",
                        "areal/plugin/mcp/list",
                        "areal/server/drain",
                    ] {
                        let request = receive(&mut socket).await;
                        assert_eq!(request["method"], method);
                        let result = match method {
                            "areal/server/status" => json!({"restartSafe":true}),
                            "areal/mcp/list" | "areal/plugin/mcp/list" => json!({"data":[]}),
                            "areal/server/drain" => {
                                assert_eq!(
                                    request["params"],
                                    json!({"strategy":"wait","timeoutMs":5000})
                                );
                                let captured: Refresh =
                                    storage::read(&refresh_path(&observed_host, "project"))
                                        .unwrap();
                                assert!(!captured.drained);
                                assert!(
                                    observed_host
                                        .receipt(&captured.stop_request_id)
                                        .unwrap()
                                        .is_none()
                                );
                                assert!(
                                    observed_host
                                        .receipt(&captured.request_id)
                                        .unwrap()
                                        .is_none()
                                );
                                json!({"restartSafe":true})
                            }
                            _ => json!({}),
                        };
                        send(&mut socket, json!({"id":request["id"],"result":result})).await;
                    }
                    let _ = socket.next().await;
                });
                let session = connect(host.clone(), "project", service.clone())
                    .await
                    .unwrap();
                let mut refresh = capture_refresh(&host, &session).await.unwrap();
                assert!(refresh.drained);
                session.close();
                server.await.unwrap();
                storage::write_stop_receipt(
                    &directory,
                    &storage::StopReceipt {
                        operation: StopOperation {
                            version: 1,
                            request_id: refresh.stop_request_id.clone(),
                            service_id: service.identity.service_id.clone(),
                            generation: service.identity.generation.clone(),
                            cancel: true,
                            state: StopOperationState::Blocked,
                            message: Some("fixture stop refused".into()),
                            lifecycle: None,
                        },
                        service,
                        cleanup_confirmed: false,
                    },
                )
                .unwrap();
                assert!(restart(&host, "project", &mut refresh).await.is_err());
                assert!(!host.schedules.suppressed("project"));
                let stop = host.receipt(&refresh.stop_request_id).unwrap().unwrap();
                assert_eq!(stop.receipt["state"], "blocked");
                assert_eq!(stop.receipt["strategy"], "cancel");
                assert_eq!(
                    stop.receipt["serviceGeneration"],
                    refresh.previous_generation
                );
                assert!(host.receipt(&refresh.request_id).unwrap().is_none());
                let before =
                    std::fs::read(wire::operation_path(&host.home, &refresh.stop_request_id))
                        .unwrap();
                assert!(restart(&host, "project", &mut refresh).await.is_err());
                assert_eq!(
                    std::fs::read(wire::operation_path(&host.home, &refresh.stop_request_id))
                        .unwrap(),
                    before
                );
                assert!(host.receipt(&refresh.request_id).unwrap().is_none());
            })
            .await;
    }
    #[tokio::test(flavor = "current_thread")]
    async fn cold_slot_refresh_requires_exact_stopped_generation_cleanup_before_original_stop() {
        let root = tempfile::tempdir().unwrap();
        let host = super::super::schedules::tests::fixture(root.path());
        let registration = host.slots.borrow()["project"].registration.clone();
        storage::private_dir(&registration.data_dir).unwrap();
        let mut original = service(&host, "ws://127.0.0.1:1/".into());
        original.identity.service_id = Host::service_id(&registration);
        original.owner = Some(Owner::Host {
            host_id: host.identity.host_id.clone(),
            generation: "previous-host".into(),
        });
        let directory = storage::registry(&host.home, &original.identity.service_id).unwrap();
        storage::private_dir(&directory).unwrap();
        storage::write(&directory.join("service.json"), &original).unwrap();
        host.slots.borrow_mut().get_mut("project").unwrap().service = None;
        let mut refresh = Refresh {
            request_id: uuid::Uuid::new_v4().to_string(),
            stop_request_id: uuid::Uuid::new_v4().to_string(),
            previous_generation: original.identity.generation.clone(),
            drained: false,
            submitted: Default::default(),
            mcp: vec![],
            plugins: vec![],
            inputs: LaunchInputs {
                workspace: registration.workspace.clone(),
                cwd: registration.workspace,
                config_home: host.home.clone(),
                homedir: None,
                config_path: None,
                deployment_path: None,
                schedule_preparation: None,
                environment: BTreeMap::new(),
                credential_names: vec![],
                options: Default::default(),
            },
        };
        let path = refresh_path(&host, "project");
        storage::private_dir(path.parent().unwrap()).unwrap();
        storage::write(&path, &refresh).unwrap();
        assert!(restart(&host, "project", &mut refresh).await.is_err());
        assert!(!refresh.drained);
        assert!(host.receipt(&refresh.stop_request_id).unwrap().is_none());
        storage::write(
            &directory.join("cleanup.json"),
            &storage::CleanupReceipt {
                version: VERSION,
                identity: original.identity.clone(),
                owner: original.owner.clone(),
                components: BTreeMap::new(),
                cleanup_confirmed: true,
            },
        )
        .unwrap();
        let mut successor = original.clone();
        successor.identity.generation = "successor".into();
        storage::write(&directory.join("service.json"), &successor).unwrap();
        assert!(restart(&host, "project", &mut refresh).await.is_err());
        assert!(!refresh.drained);
        assert!(host.receipt(&refresh.stop_request_id).unwrap().is_none());
        storage::write(&directory.join("service.json"), &original).unwrap();
        assert!(restart(&host, "project", &mut refresh).await.is_err());
        assert!(refresh.drained);
        let stop = host.receipt(&refresh.stop_request_id).unwrap().unwrap();
        assert_eq!(stop.receipt["state"], "completed");
        assert_eq!(
            stop.receipt["serviceGeneration"],
            original.identity.generation
        );
        assert!(!host.schedules.suppressed("project"));
        assert!(host.receipt(&refresh.request_id).unwrap().is_some());
        assert!(activation_pending(&host, "project").await.unwrap());
        let mut completed = host.receipt(&refresh.request_id).unwrap().unwrap();
        completed.receipt["state"] = json!("completed");
        completed.receipt["result"] = json!({"service":original});
        storage::write(
            &wire::operation_path(&host.home, &refresh.request_id),
            &completed,
        )
        .unwrap();
        host.slots.borrow_mut().get_mut("project").unwrap().service = None;
        let original_receipt =
            std::fs::read(wire::operation_path(&host.home, &refresh.request_id)).unwrap();
        assert!(!activation_pending(&host, "project").await.unwrap());
        assert!(restart(&host, "project", &mut refresh).await.is_err());
        assert_eq!(
            std::fs::read(wire::operation_path(&host.home, &refresh.request_id)).unwrap(),
            original_receipt
        );
        assert!(refresh_path(&host, "project").exists());
    }
    #[tokio::test(flavor = "current_thread")]
    async fn restore_reconciles_old_generation_receipt_but_requires_current_live_connection() {
        tokio::task::LocalSet::new().run_until(async {
            let root = tempfile::tempdir().unwrap();
            let host = Rc::new(super::super::schedules::tests::fixture(root.path()));
            let registration = host.slots.borrow()["project"].registration.clone();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let service = service(&host, format!("ws://{}/", listener.local_addr().unwrap()));
            let old_request = "refresh-old-mcp-0".to_owned();
            let mut refresh = Refresh {
                request_id: "refresh".into(), stop_request_id: "stop".into(), previous_generation: "old".into(), drained: true,
                submitted: [old_request.clone()].into(), mcp: vec!["fixture".into()], plugins: vec![],
                inputs: LaunchInputs { workspace: registration.workspace.clone(), cwd: registration.workspace, config_home: host.home.clone(), homedir: None, config_path: None, deployment_path: None, schedule_preparation: None, environment: BTreeMap::new(), credential_names: vec![], options: Default::default() },
            };
            storage::private_dir(refresh_path(&host, "project").parent().unwrap()).unwrap();
            let server = tokio::task::spawn_local(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                let initialize = receive(&mut socket).await;
                send(&mut socket, json!({"id":initialize["id"],"result":{}})).await;
                let old = receive(&mut socket).await;
                assert_eq!(old["method"], "areal/request/read");
                assert_eq!(old["params"]["requestId"], old_request);
                send(&mut socket, json!({"id":old["id"],"result":{"data":[{"status":"completed"}]}})).await;
                let listing = receive(&mut socket).await;
                assert_eq!(listing["method"], "areal/mcp/list");
                send(&mut socket, json!({"id":listing["id"],"result":{"data":[{"id":"fixture","revision":1,"state":"disconnected"}]}})).await;
                let lookup = receive(&mut socket).await;
                assert_eq!(lookup["method"], "areal/request/read");
                assert_eq!(lookup["params"]["requestId"], "refresh-first-mcp-0");
                send(&mut socket, json!({"id":lookup["id"],"result":{"data":[]}})).await;
                let mutation = receive(&mut socket).await;
                assert_eq!(mutation["method"], "areal/mcp/connect");
                assert_eq!(mutation["params"]["requestId"], "refresh-first-mcp-0");
                send(&mut socket, json!({"id":mutation["id"],"result":{"data":[{"id":"fixture","state":"connected"}]}})).await;
                let current = receive(&mut socket).await;
                assert_eq!(current["method"], "areal/mcp/list");
                send(&mut socket, json!({"id":current["id"],"result":{"data":[{"id":"fixture","state":"disconnected"}]}})).await;
                let _ = socket.next().await;
            });
            let session = connect(host.clone(), "project", service).await.unwrap();
            assert!(restore(&host, &session, &mut refresh).await.is_err());
            assert!(refresh.submitted.contains("refresh-old-mcp-0"));
            assert!(refresh.submitted.contains("refresh-first-mcp-0"));
            assert!(refresh_path(&host, "project").exists());
            session.close();
            server.await.unwrap();
        }).await;
    }
}

#[cfg(test)]
#[path = "schedule_connection_recovery_tests.rs"]
mod recovery_tests;
