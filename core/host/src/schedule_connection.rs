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
struct PendingReply {
    reply: oneshot::Sender<Result<CoreReply>>,
    snapshot_thread: Option<String>,
    snapshot_lease: Option<String>,
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
        drop(observed);
        if !self
            .session
            .workbench_observed
            .borrow()
            .contains_key(&self.thread_id)
        {
            self.session
                .remove_subscriptions(vec![self.thread_id.clone()]);
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
    /// 共享连接上的任务更新计数；连接换代后值随连接 ID 一起变化。
    pub(super) fn task_revision(&self, host: &Host, id: &str) -> Result<String> {
        let sessions = self.sessions.borrow();
        let session = sessions.get(id).ok_or_else(unavailable)?;
        ensure!(session.shared_current(host), unavailable());
        Ok(format!(
            "{}:{}",
            session.connection_id,
            session.task_revision.get()
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
    /// 插件登记由 Host 写入后，让在线的项目 Core 立即重读：撤销已卸载或停用插件的连接与技能。
    /// 不在线的 Core 下次启动或下一轮开始时自己会读到，这里尽力而为。
    pub(super) async fn refresh_plugins(&self, host: &Host) {
        let sessions: Vec<_> = self
            .sessions
            .borrow()
            .values()
            .filter(|session| session.shared_current(host))
            .cloned()
            .collect();
        for session in sessions {
            if let Err(error) = session.request("areal/plugin/list", json!({})).await {
                eprintln!(
                    "plugin refresh skipped for project {}: {error:#}",
                    session.project_id
                );
            }
        }
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
    if host.gateway.workbench.active_source().is_some() {
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
    if value["method"] == "areal/task/updated" {
        connection
            .task_revision
            .set(connection.task_revision.get() + 1);
        if connection.terminal
            && let Some(shared) = host
                .schedules
                .connections
                .sessions
                .borrow()
                .get(&connection.project_id)
        {
            shared.task_revision.set(shared.task_revision.get() + 1);
        }
    }
    if changes_shell(&value) {
        connection
            .shell_revision
            .set(connection.shell_revision.get() + 1);
        if connection.terminal
            && let Some(shared) = host
                .schedules
                .connections
                .sessions
                .borrow()
                .get(&connection.project_id)
        {
            shared.shell_revision.set(shared.shell_revision.get() + 1);
        }
        host.changed();
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
    let current_turn = matches!(
        value["method"].as_str(),
        Some("turn/started" | "turn/completed")
    ) && connection.shared_current(host)
        && host
            .schedules
            .connections
            .sessions
            .borrow()
            .get(&connection.project_id)
            .is_some_and(|current| Rc::ptr_eq(current, connection));
    if current_turn && value["method"] == "turn/started" {
        if let (Some(thread), Some(turn)) = (
            value["params"]["threadId"].as_str(),
            value["params"]["turn"]["id"].as_str(),
        ) {
            connection.observe_running(thread, turn);
        }
    }
    if current_turn && value["method"] == "turn/completed" {
        // Core 先结算再发终态；这里只唤醒原生命周期权威重读，不把通知直接当作停止回执。
        if let Some(thread) = value["params"]["threadId"].as_str() {
            if let Some(progress) = connection.observed_progress.borrow_mut().get_mut(thread) {
                if value["params"]["turn"]["id"] == progress.turn {
                    progress.terminal_hinted = true;
                }
            }
        }
        host.changed();
    }
    if super::library_service::core_event(host, &connection.project_id, &value).is_err() {
        eprintln!("Host library Core event update failed");
    } else if current_turn && value["method"] == "turn/completed" {
        if let Some(thread) = value["params"]["threadId"].as_str() {
            let terminal = connection
                .observed_progress
                .borrow()
                .get(thread)
                .is_some_and(|progress| value["params"]["turn"]["id"] == progress.turn);
            if terminal {
                connection.observed_progress.borrow_mut().remove(thread);
            }
        }
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

struct ObservedProgress {
    turn: String,
    terminal_hinted: bool,
}

struct CoreSession {
    project_id: String,
    connection_id: String,
    service: Service,
    outgoing: mpsc::Sender<Value>,
    pending: RefCell<BTreeMap<String, PendingReply>>,
    observed_progress: RefCell<BTreeMap<String, ObservedProgress>>,
    sequence: Cell<u64>,
    closed: Cell<bool>,
    ready: Cell<bool>,
    events: broadcast::Sender<CoreEvent>,
    event_sequence: Cell<u64>,
    shell_revision: Cell<u64>,
    task_revision: Cell<u64>,
    observed: RefCell<BTreeMap<String, usize>>,
    workbench_observed: RefCell<BTreeMap<String, (String, u64)>>,
    workbench_claim_sequence: Cell<u64>,
    workbench_creations: Cell<usize>,
    deferred_removals: RefCell<BTreeSet<String>>,
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
    fn defer_removals(&self, threads: Vec<String>) -> Vec<String> {
        if self.workbench_creations.get() == 0 {
            return threads;
        }
        let mut deferred = self.deferred_removals.borrow_mut();
        deferred.extend(threads);
        if deferred.len() > areal_protocol::desktop::MAX_SUBSCRIPTIONS {
            drop(deferred);
            self.close();
        }
        Vec::new()
    }
    fn remove_subscriptions(&self, threads: Vec<String>) {
        let threads = self.defer_removals(threads);
        if threads.is_empty() {
            return;
        }
        let sequence = self.sequence.get() + 1;
        self.sequence.set(sequence);
        if self.outgoing.try_send(json!({"id":format!("host-{sequence}"),"method":"areal/subscription/remove","params":{"threadIds":threads}})).is_err() {
            self.close();
        }
    }
    fn release_workbench(&self, lease: &str) {
        let mut owned = self.workbench_observed.borrow_mut();
        let threads: Vec<_> = owned
            .iter()
            .filter(|(_, (owner, _))| owner.as_str() == lease)
            .map(|(thread, _)| thread.clone())
            .collect();
        for thread in &threads {
            owned.remove(thread);
        }
        drop(owned);
        let observed = self.observed.borrow();
        self.remove_subscriptions(
            threads
                .into_iter()
                .filter(|thread| !observed.contains_key(thread))
                .collect(),
        );
    }
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
        self.observed_progress.borrow_mut().clear();
        for (_, reply) in std::mem::take(&mut *self.pending.borrow_mut()) {
            let _ = reply.reply.send(Err(unavailable()));
        }
        self.refresh.notify_one();
    }
    fn close(&self) {
        self.invalidate();
        if let Some(driver) = self.driver.borrow_mut().take() {
            driver.abort();
        }
    }
    fn observe_running(&self, thread: &str, turn: &str) {
        let mut progress = self.observed_progress.borrow_mut();
        if progress
            .get(thread)
            .is_none_or(|previous| previous.turn != turn)
        {
            progress.insert(
                thread.into(),
                ObservedProgress {
                    turn: turn.into(),
                    terminal_hinted: false,
                },
            );
        }
    }

    fn snapshot_progress(
        &self,
        host: &Rc<Host>,
        thread: &str,
        snapshot: &Value,
        lease: Option<&str>,
    ) -> Result<()> {
        if self.terminal {
            return Ok(());
        }
        ensure!(
            self.shared_current(host)
                && host
                    .schedules
                    .connections
                    .sessions
                    .borrow()
                    .get(&self.project_id)
                    .is_some_and(|current| std::ptr::eq(current.as_ref(), self)),
            unavailable()
        );
        ensure!(
            self.workbench_lease.borrow().as_deref() == lease,
            unavailable()
        );
        ensure!(snapshot["thread"]["id"] == thread, "INVALID_RESPONSE");
        if let Some(source) = host.gateway.workbench.active_source() {
            super::library_store::source_home(host, &source)?;
        }
        for turn in snapshot["thread"]["turns"].as_array().into_iter().flatten() {
            let Some(id) = turn["id"].as_str() else {
                continue;
            };
            let progressing = self
                .observed_progress
                .borrow()
                .get(thread)
                .is_some_and(|previous| previous.turn == id);
            match turn["status"].as_str() {
                Some("inProgress") => {
                    self.observe_running(thread, id);
                }
                Some("completed" | "failed" | "interrupted") if progressing => {
                    // 与旧页面投影相同：只补已见执行中的轮次，不把首次历史快照标成新完成。
                    let first_hint = {
                        let mut progress = self.observed_progress.borrow_mut();
                        let progress = progress.get_mut(thread).unwrap();
                        let first_hint = !progress.terminal_hinted;
                        progress.terminal_hinted = true;
                        first_hint
                    };
                    match super::library_service::record_thread_activity(
                        host,
                        &self.project_id,
                        thread,
                        Some(id),
                    ) {
                        Ok(()) => {
                            self.observed_progress.borrow_mut().remove(thread);
                        }
                        Err(_) if first_hint => {
                            eprintln!("Host library snapshot completion update failed")
                        }
                        Err(_) => {}
                    }
                    if first_hint {
                        host.changed();
                    }
                }
                _ => {}
            }
        }
        Ok(())
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
        let snapshot_thread = matches!(method, "areal/thread/observe" | "thread/resume")
            .then(|| params["threadId"].as_str().map(str::to_owned))
            .flatten();
        self.pending.borrow_mut().insert(
            id.clone(),
            PendingReply {
                reply: sender,
                snapshot_thread,
                snapshot_lease: self.workbench_lease.borrow().clone(),
            },
        );
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
        observed_progress: RefCell::new(BTreeMap::new()),
        sequence: Cell::new(0),
        closed: Cell::new(false),
        ready: Cell::new(false),
        events: broadcast::channel(16).0,
        event_sequence: Cell::new(0),
        shell_revision: Cell::new(0),
        task_revision: Cell::new(0),
        observed: RefCell::new(BTreeMap::new()),
        workbench_observed: RefCell::new(BTreeMap::new()),
        workbench_claim_sequence: Cell::new(0),
        workbench_creations: Cell::new(0),
        deferred_removals: RefCell::new(BTreeSet::new()),
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
                                    let result = result.and_then(|result| {
                                        if let Some(thread) = reply.snapshot_thread.as_deref() {
                                            connection.snapshot_progress(&host, thread, &result.value, reply.snapshot_lease.as_deref())?;
                                        }
                                        Ok(result)
                                    });
                                    let _ = reply.reply.send(result);
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
        scope: None,
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
    if params["intent"] == "resume" || params["intent"] == "create" {
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
            host.changed();
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
        let capabilities = session.request("areal/capabilities", json!({})).await?;
        session.require_current(&host)?;
        let ready = if matches!(&registration.source, crate::ProjectSource::Gui { .. })
            && capabilities["features"]["taskPrepareCreate"] == true
        {
            json!({"prepareCreate":true})
        } else {
            json!({})
        };
        session.request("areal/task/host/ready", ready).await?;
        session.require_current(&host)?;
        session.ready.set(true);
        host.schedules.preparation_result(&id, Ok(()))?;
        host.schedules
            .connections
            .sessions
            .borrow_mut()
            .insert(id.clone(), session.clone());
        host.schedules.connections.changed.notify_waiters();
        host.changed();
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
                    host.changed();
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
#[path = "schedule_connection_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "schedule_connection_recovery_tests.rs"]
mod recovery_tests;
