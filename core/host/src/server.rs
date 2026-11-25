#[path = "analytics.rs"]
mod analytics;
#[path = "bots.rs"]
pub(crate) mod bots;
#[path = "cloud.rs"]
mod cloud;
#[path = "cloud_sessions.rs"]
mod cloud_sessions;
#[path = "conversation_media.rs"]
pub(crate) mod conversation_media;
#[path = "conversation_read.rs"]
mod conversation_read;
#[path = "execution_preparation.rs"]
mod execution_preparation;
#[path = "feedback.rs"]
mod feedback;
#[path = "feedback_context.rs"]
mod feedback_context;
#[path = "frontend_notices.rs"]
mod frontend_notices;
#[path = "gateway/owner.rs"]
mod gateway_owner;
#[path = "gui_project.rs"]
mod gui_project;
#[path = "idle.rs"]
mod idle;
#[path = "library_commands.rs"]
mod library_commands;
#[path = "library_service.rs"]
mod library_service;
#[path = "library_store.rs"]
mod library_store;
#[path = "loopback.rs"]
mod loopback;
#[path = "manage_service.rs"]
mod manage_service;
#[path = "plugins.rs"]
mod plugins;
#[path = "power.rs"]
mod power;
#[path = "projectless.rs"]
mod projectless;
#[path = "provider_catalog.rs"]
mod provider_catalog;
#[path = "provider_config.rs"]
mod provider_config;
#[path = "provider_probe.rs"]
mod provider_probe;
#[path = "remote_commands.rs"]
mod remote_commands;
#[path = "resource_inspections.rs"]
mod resource_inspections;
#[path = "resources.rs"]
mod resources;
#[path = "schedule_connection.rs"]
mod schedule_connection;
#[path = "schedules.rs"]
mod schedules;
#[path = "session_commands.rs"]
mod session_commands;
#[path = "shell_subscription.rs"]
mod shell_subscription;
#[path = "side_owners.rs"]
mod side_owners;
#[path = "space/import.rs"]
mod space_import;
#[path = "subscription/host.rs"]
mod subscriptions;
#[path = "task_catalog.rs"]
mod task_catalog;
#[path = "trajectory.rs"]
mod trajectory;
#[path = "updates.rs"]
pub(crate) mod updates;
#[cfg(test)]
#[path = "vault_liveness_tests.rs"]
mod vault_liveness_tests;
#[path = "workbench_lifecycle.rs"]
mod workbench_lifecycle;

#[path = "workbench_route.rs"]
mod workbench_route;
#[path = "workbench_submissions.rs"]
mod workbench_submissions;
#[path = "workbench_utility.rs"]
mod workbench_utility;
#[path = "workspace_ops.rs"]
mod workspace_ops;
#[path = "worktree_catalog.rs"]
mod worktree_catalog;
use crate::{
    Activity, CAPABILITIES, HostIdentity, HostStatus, LaunchInputs, OpenResult, ProjectActivity,
    ProjectRegistration, ProjectStatus, StopStrategy, VERSION, launch,
    wire::{self, error},
};
use anyhow::{Context, Result, ensure};
use areal_local_service::{LifetimeWriter, OwnerLifetime, storage};
use areal_protocol::service::{Owner, Service, State, StopOperation, StopOperationState};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::PathBuf,
    rc::Rc,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::BufReader,
    net::{UnixListener, UnixStream},
    sync::{Mutex, Notify, OwnedRwLockWriteGuard, RwLock, watch},
};

const DESKTOP_CORE_MAX_FRAME: usize = 64 * 1024 * 1024;

pub struct RunOptions {
    pub home: PathBuf,
    pub bin_dir: PathBuf,
}
impl RunOptions {
    pub fn current() -> Result<Self> {
        Ok(Self {
            home: areal_local_service::raw_home()?,
            bin_dir: std::env::current_exe()?
                .canonicalize()?
                .parent()
                .context("binary directory")?
                .into(),
        })
    }
}
pub enum HostExit {
    Stopped,
    AlreadyRunning,
}
impl HostExit {
    pub fn code(&self) -> i32 {
        match self {
            Self::AlreadyRunning if cfg!(target_os = "linux") => 73,
            _ => 0,
        }
    }
}
#[derive(Clone)]
struct LiveEnsure {
    request_id: String,
    admitted: Rc<std::cell::Cell<bool>>,
    done: Rc<watch::Sender<bool>>,
}

struct LiveEnsureGuard {
    host: Rc<Host>,
    project_id: String,
    entry: LiveEnsure,
}
impl Drop for LiveEnsureGuard {
    fn drop(&mut self) {
        if let Some(slot) = self.host.slots.borrow_mut().get_mut(&self.project_id)
            && slot
                .live_ensure
                .as_ref()
                .is_some_and(|current| Rc::ptr_eq(&current.done, &self.entry.done))
        {
            slot.live_ensure = None;
        }
        let _ = self.entry.done.send(true);
    }
}

struct ScopedLiveEnsureGuard<'a> {
    host: &'a Host,
    project_id: String,
    entry: LiveEnsure,
}
impl Drop for ScopedLiveEnsureGuard<'_> {
    fn drop(&mut self) {
        if let Some(slot) = self.host.slots.borrow_mut().get_mut(&self.project_id)
            && slot
                .live_ensure
                .as_ref()
                .is_some_and(|current| Rc::ptr_eq(&current.done, &self.entry.done))
        {
            slot.live_ensure = None;
        }
        let _ = self.entry.done.send(true);
    }
}

#[derive(Clone)]
pub(super) struct LiveIdleStop {
    pub(super) request_id: String,
    pub(super) service_generation: String,
    pub(super) done: Rc<watch::Sender<bool>>,
}

struct ScopedLiveIdleStopGuard<'a> {
    host: &'a Host,
    project_id: String,
    entry: LiveIdleStop,
}
impl Drop for ScopedLiveIdleStopGuard<'_> {
    fn drop(&mut self) {
        if let Some(slot) = self.host.slots.borrow_mut().get_mut(&self.project_id)
            && slot
                .live_idle_stop
                .as_ref()
                .is_some_and(|current| Rc::ptr_eq(&current.done, &self.entry.done))
        {
            slot.live_idle_stop = None;
        }
        let _ = self.entry.done.send(true);
    }
}

pub(super) enum ActivationOutcome {
    Ready {
        service_generation: String,
        activation_id: Option<String>,
    },
    Pending {
        activation_id: Option<String>,
        reason: &'static str,
    },
    Blocked {
        activation_id: Option<String>,
        reason: &'static str,
    },
}

async fn wait_watch_true(tx: &watch::Sender<bool>, deadline: tokio::time::Instant) -> bool {
    let mut rx = tx.subscribe();
    if *rx.borrow() {
        return true;
    }
    tokio::time::timeout_at(deadline, async {
        while !*rx.borrow() {
            if rx.changed().await.is_err() {
                return true;
            }
        }
        true
    })
    .await
    .unwrap_or(false)
}

struct Slot {
    idle: idle::IdleWindow,
    registration: ProjectRegistration,
    // 状态与活动观察可以并行；激活、停止和凭据切换仍需独占项目。
    gate: Arc<RwLock<()>>,
    writer: Option<LifetimeWriter>,
    uncertain_start: bool,
    lifetime: Option<Rc<OwnerLifetime>>,
    state: String,
    service: Option<Service>,
    migration: Option<Value>,
    credentials: BTreeMap<String, String>,
    imported_credentials: BTreeSet<String>,
    live_ensure: Option<LiveEnsure>,
    live_idle_stop: Option<LiveIdleStop>,
    probe_failures: u8,
}
struct Host {
    clients: RefCell<BTreeMap<String, Option<u32>>>,
    home: PathBuf,
    bin: PathBuf,
    identity: HostIdentity,
    token: String,
    slots: RefCell<BTreeMap<String, Slot>>,
    stop: RefCell<Option<Value>>,
    host_stop_gate: Mutex<()>,
    changes: watch::Sender<u64>,
    exit: Notify,
    migration: Rc<crate::migration::Migration>,
    journal: crate::journal::Journal,
    remote: crate::remote_state::RemoteState,
    gateway: gateway_owner::Gateway,
    subscriptions: subscriptions::Subscriptions,
    schedules: schedules::Schedules,
    bots: bots::Bots,
    power: power::Power,
    loopback: loopback::Loopback,
    read_models: shell_subscription::ReadModels,
}
impl Slot {
    fn imported(registration: ProjectRegistration) -> Self {
        Self {
            idle: Default::default(),
            registration,
            gate: Arc::new(RwLock::new(())),
            writer: None,
            uncertain_start: false,
            lifetime: None,
            state: "stopped".into(),
            service: None,
            migration: None,
            credentials: BTreeMap::new(),
            imported_credentials: BTreeSet::new(),
            live_ensure: None,
            live_idle_stop: None,
            probe_failures: 0,
        }
    }
}
struct ConnectionGuard {
    host: Rc<Host>,
    id: String,
    socket: std::os::fd::RawFd,
}
impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.host.clients.borrow_mut().remove(&self.id);
        self.host.changed();
        self.host
            .schedules
            .connections
            .frontend_disconnect(&self.id);
        self.host
            .gateway
            .workbench
            .disconnect_connection(&self.host, &self.id);
        self.host.migration.disconnect(&self.id);
        let _ = self.host.journal.disconnect(&self.id);
        self.host.remote.disconnect(&self.id);
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Operation {
    digest: String,
    receipt: Value,
    #[serde(default)]
    evidence: Value,
}
/// Host 操作回执的状态机。落盘仍是 receipt 里的 `state` 字符串，这里只给读写一个类型。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ReceiptState {
    AcceptedPending,
    AdmissionUnknown,
    SettlementIncomplete,
    /// 只用于 host.stop 汇总：部分目标已完成。
    Partial,
    Blocked,
    Completed,
}
impl ReceiptState {
    /// 读不出或不认识的状态返回 None，调用方一律按未结算处理。
    fn of(receipt: &Value) -> Option<Self> {
        Self::deserialize(&receipt["state"]).ok()
    }
    fn settled(state: Option<Self>) -> bool {
        matches!(state, Some(Self::Completed | Self::Blocked))
    }
    fn is(receipt: &Value, state: Self) -> bool {
        Self::of(receipt) == Some(state)
    }
}
impl Operation {
    /// 只有自己和全部停止目标都已结算才算结算；状态未知一律当未结算保留。
    fn settled(&self) -> bool {
        let done = |receipt: &Value| ReceiptState::settled(ReceiptState::of(receipt));
        done(&self.receipt)
            && self.evidence["schedulingIntentPending"] != true
            && self.receipt["projects"]
                .as_array()
                .is_none_or(|targets| targets.iter().all(|target| done(&target["receipt"])))
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Hello {
    protocol_versions: Vec<u32>,
    capabilities: Vec<String>,
    auth_token: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Register {
    #[serde(default)]
    bind_existing: bool,
    request_id: String,
    expected_generation: String,
    registration: ProjectRegistration,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ensure {
    #[serde(default)]
    no_auto_restart: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    resume_scheduling: bool,
    request_id: String,
    expected_generation: String,
    project_id: String,
    #[serde(default)]
    launch_inputs: Option<LaunchInputs>,
    #[serde(default, skip_serializing)]
    credentials: BTreeMap<String, String>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stop {
    request_id: String,
    expected_generation: String,
    strategy: StopStrategy,
    #[serde(default = "default_true", skip_serializing_if = "is_true")]
    suppress_scheduling: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    service_generation: Option<String>,
}
fn default_true() -> bool {
    true
}
fn is_true(value: &bool) -> bool {
    *value
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OperationQuery {
    request_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

pub async fn run(options: RunOptions) -> Result<HostExit> {
    tokio::task::LocalSet::new()
        .run_until(run_local(options))
        .await
}
pub async fn run_managed(options: RunOptions) -> Result<HostExit> {
    tokio::task::LocalSet::new()
        .run_until(run_local_mode(options, true, false))
        .await
}
async fn run_local(options: RunOptions) -> Result<HostExit> {
    run_local_mode(options, false, false).await
}
pub(crate) async fn run_local_mode(
    options: RunOptions,
    managed: bool,
    wait_for_lock: bool,
) -> Result<HostExit> {
    let home = storage::prepare_host_home(&options.home)?;
    let Some(lock) = crate::service_run::acquire_host_lock(&home, wait_for_lock).await? else {
        return Ok(HostExit::AlreadyRunning);
    };
    let lock = Arc::new(lock);
    let directory = home.join("host");
    storage::private_dir(&directory)?;
    let Some(delay) = crate::service_run::ServiceRun::prepare(&home, managed)? else {
        return Ok(HostExit::Stopped);
    };
    tokio::time::sleep(delay).await;
    for sub in ["operations", "projects", "launch"] {
        storage::private_dir(&directory.join(sub))?;
    }
    let host_id = storage::read_optional::<String>(&directory.join("identity.json"))?
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    storage::write(&directory.join("identity.json"), &host_id)?;
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let socket = storage::control_socket(&directory)?;
    storage::private_dir(socket.parent().unwrap())?;
    if let Ok(meta) = std::fs::symlink_metadata(&socket) {
        ensure!(
            std::os::unix::fs::FileTypeExt::is_socket(&meta.file_type())
                && meta.uid() == unsafe { libc::geteuid() },
            "invalid previous host socket"
        );
        std::fs::remove_file(&socket)?;
    }
    let listener = UnixListener::bind(&socket)?;
    let bound = crate::service_run::socket_identity(&socket)?;
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
    let identity = HostIdentity {
        version: VERSION,
        host_id,
        generation: uuid::Uuid::new_v4().to_string(),
        socket_path: socket.clone(),
        auth_file: directory.join("auth.json"),
        pid: std::process::id(),
        executable_version: env!("CARGO_PKG_VERSION").into(),
        executable_digest: Some(storage::digest(&std::fs::read(std::env::current_exe()?)?)),
    };
    storage::write(&identity.auth_file, &token)?;
    let mut slots = BTreeMap::new();
    for path in storage::json_records(&directory.join("projects"), true)? {
        let registration: ProjectRegistration = storage::read(&path)?;
        slots.insert(
            registration.project_id.clone(),
            Slot::imported(registration),
        );
    }
    let mut migration = crate::migration::Migration::new(&home)?;
    migration.vault.hold_owner(lock.clone(), &identity, &token);
    for registration in migration.published()? {
        if slots
            .get(&registration.project_id)
            .is_some_and(|s| s.registration != registration)
        {
            return Err(error(
                "migrationConflict",
                "committed import conflicts with project registry",
            ));
        }
        slots
            .entry(registration.project_id.clone())
            .or_insert_with(|| Slot::imported(registration));
    }
    let journal = crate::journal::Journal::new(&home)?;
    let remote = crate::remote_state::RemoteState::new(&home);
    let stop: Option<Value> = storage::read_optional(&directory.join("stop.json"))?;
    let stop =
        stop.filter(|v| !ReceiptState::is(v, ReceiptState::Completed) && !settled_refusal(v));
    let (changes, _) = watch::channel(0);
    let host = Rc::new(Host {
        schedules: schedules::Schedules::load(&home)?,
        bots: bots::Bots::load(&home)?,
        home,
        bin: options.bin_dir.canonicalize()?,
        identity,
        token,
        slots: RefCell::new(slots),
        stop: RefCell::new(stop),
        host_stop_gate: Mutex::new(()),
        clients: Default::default(),
        changes,
        exit: Notify::new(),
        migration: migration.into(),
        journal,
        remote,
        gateway: gateway_owner::Gateway::default(),
        subscriptions: subscriptions::Subscriptions::default(),
        power: power::Power::default(),
        read_models: Default::default(),
        loopback: loopback::Loopback::default(),
    });
    let interrupted_stop = host
        .stop
        .borrow()
        .as_ref()
        .and_then(|receipt| receipt["requestId"].as_str())
        .map(str::to_owned);
    if let Some(request_id) = interrupted_stop
        && host
            .receipt(&request_id)?
            .is_some_and(|record| record.receipt["preparationPending"] == true)
    {
        // 新进程已持有 Host 锁；仅结算原准备中断，不重放停止或放行已派发的 UNKNOWN。
        host.reconcile(&request_id).await?;
    }
    let registrations = host.registrations();
    host.schedules.import(&host.migration, &registrations)?;
    plugins::import(&host, &registrations);
    for path in storage::json_records(&directory.join("operations"), true)? {
        let record: Operation = storage::read(&path)?;
        if record.evidence["schedulingIntentPending"] == true {
            host.apply_scheduling_intent(
                record.receipt["requestId"]
                    .as_str()
                    .context("missing scheduling request identity")?,
            )?;
        } else if record.settled() && storage::past_retention(&path)? {
            std::fs::remove_file(&path)?;
        }
    }
    host.subscriptions.restoring.set(true);
    let restoring_subscriptions = host.restore_subscriptions();
    tokio::pin!(restoring_subscriptions);
    let mut restoring = true;
    let mut loopback = loopback::bind(
        host.clone(),
        std::env::var_os("AREAL_HOST_WEBSOCKET").is_none_or(|value| value != "0"),
    )
    .await?;
    storage::write(&directory.join("host.json"), &host.identity)?;
    host.settle_update_start()?;
    let scheduler = schedules::run(host.clone());
    let connections = schedule_connection::run(host.clone());
    let gateway = gateway_owner::run(host.clone());
    let subscriptions = host.run_subscriptions();
    let power = power::run(host.clone());
    // 生命周期巡检持有停止操作 future；堆上固定，避免把完整清理状态机叠进 Host 主循环栈。
    let idle = Box::pin(idle::run(host.clone()));
    let release = Box::pin(idle::release_unused(host.clone()));
    let read_models = Box::pin(shell_subscription::run(host.clone()));
    let discovery = crate::service_run::until_discovery_lost(&host.home, &host.identity.generation);
    tokio::pin!(scheduler, connections, gateway);
    tokio::pin!(subscriptions, power, discovery, idle, release, read_models);
    let orphaned = loop {
        tokio::select! {
            _=host.exit.notified()=>break false,
            _=&mut discovery=>break true,
            result=&mut restoring_subscriptions, if restoring=> {
                result?;
                restoring = false;
                host.subscriptions.restoring.set(false);
            },
            result=loopback.run()=>{result?;unreachable!("loopback listener lives with Host")},
            _=&mut scheduler=>unreachable!("scheduler lifetime is the Host lifetime"),
            _=&mut connections=>unreachable!("schedule connections live with the Host"),
            _=&mut gateway=>unreachable!("Gateway lives with the Host"),
            _=&mut subscriptions=>unreachable!("subscription owners live with the Host"),
            _=&mut power=>unreachable!("power protection lives with the Host"),
            _=&mut idle=>unreachable!("idle collection lives with the Host"),
            _=&mut release=>unreachable!("release policy lives with the Host"),
            _=&mut read_models=>unreachable!("read projections live with the Host"),
            connection=listener.accept()=> {let (stream,_)=connection?;let host=host.clone();tokio::task::spawn_local(async move {let _=connection_loop(host,stream).await;});}
        }
    };
    drop(loopback);
    host.gateway.workbench.cloud.sessions.close_all(&host);
    host.gateway.workbench.stop().await;
    host.close_subscriptions().await;
    host.power.close().await;
    // 系统凭据调用可能仍在等待用户；不能先释放 Host 锁而允许第二写者启动。
    host.migration.vault.close().await;
    if orphaned {
        crate::service_run::remove_own_socket(&socket, bound);
        return Ok(HostExit::Stopped);
    }
    std::fs::remove_file(socket)?;
    std::fs::remove_file(directory.join("host.json"))?;
    crate::service_run::ServiceRun::finish(&host.home)?;
    host.exec_update(managed)?;
    drop(lock);
    Ok(HostExit::Stopped)
}
async fn write_local_frame(
    writer: &mut (impl tokio::io::AsyncWrite + Unpin),
    value: &Value,
    limit: usize,
) -> Result<()> {
    use tokio::io::AsyncWriteExt;
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    ensure!(bytes.len() <= limit, "frame exceeds negotiated limit");
    writer.write_all(&bytes).await?;
    Ok(())
}

async fn connection_loop(host: Rc<Host>, stream: UnixStream) -> Result<()> {
    let credentials = stream.peer_cred()?;
    ensure!(
        credentials.uid() == unsafe { libc::geteuid() },
        "unauthorized peer"
    );
    let socket = std::os::fd::AsRawFd::as_raw_fd(&stream);
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let value = tokio::time::timeout(Duration::from_secs(10), wire::read(&mut reader))
        .await??
        .context("hello required")?;
    let request: wire::Request = serde_json::from_value(value)?;
    ensure!(
        request.version == VERSION && !request.id.is_empty() && request.method == "hello",
        "hello required"
    );
    let hello: Hello = serde_json::from_value(request.params)?;
    ensure!(hello.auth_token == host.token, "unauthorized");
    let response = if hello.protocol_versions.contains(&VERSION) {
        json!({"version":VERSION,"id":request.id,"result":areal_protocol::host::LocalHelloResult { version: VERSION.into(), host_id: host.identity.host_id.clone(), generation: host.identity.generation.clone(), capabilities: CAPABILITIES.iter().map(|value| (*value).to_owned()).collect(), executable_version: host.identity.executable_version.clone(), executable_digest: host.identity.executable_digest.clone() }})
    } else {
        json!({"version":VERSION,"id":request.id,"error":{"code":"versionMismatch","message":"Host requires protocol version 1"}})
    };
    wire::write(&mut writer, &response).await?;
    if !hello.protocol_versions.contains(&VERSION) {
        return Ok(());
    }
    let desktop_core = hello
        .capabilities
        .iter()
        .any(|capability| capability == "desktopCore");
    let frame_limit = if desktop_core {
        DESKTOP_CORE_MAX_FRAME
    } else {
        wire::MAX_FRAME
    };
    let connection = ConnectionGuard {
        host: host.clone(),
        id: uuid::Uuid::new_v4().to_string(),
        socket,
    };
    host.clients.borrow_mut().insert(
        connection.id.clone(),
        credentials.pid().and_then(|pid| u32::try_from(pid).ok()),
    );
    let mut subscription: Option<(String, u64)> = None;
    let mut changes = host.changes.subscribe();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let mut previous = Value::Null;
    let mut gateway_subscription: Option<(String, String, u64, Value)> = None;
    let mut frontend_events: Option<tokio::sync::mpsc::Receiver<Value>> = None;
    let mut frame_bytes = Vec::new();
    let (credential_results, mut credential_responses) =
        tokio::sync::mpsc::unbounded_channel::<Value>();
    let mut credential_requests = 0usize;
    loop {
        tokio::select! {
            response=credential_responses.recv(), if credential_requests > 0 => {
                credential_requests -= 1;
                write_local_frame(&mut writer,&response.context("credential response task ended")?,frame_limit).await?;
            },
            value=wire::read_buffered_limit(&mut reader,&mut frame_bytes,frame_limit)=> {
                let Some(value)=value? else {return Ok(());};
                let request:wire::Request=serde_json::from_value(value)?;
                if request.version == VERSION && !request.id.is_empty() && request.method == "gui.importSecret" {
                    let admitted = (|| -> Result<crate::migration::ImportSecret> {
                        host.validate_client_state(&request.method, &request.params)?;
                        let input: crate::migration::ImportSecret = serde_json::from_value(request.params)?;
                        host.generation(&input.expected_generation)?;
                        Ok(input)
                    })();
                    match admitted {
                        Ok(input) => {
                            let owned = host.clone();
                            let connection_id = connection.id.clone();
                            let mut task = Box::pin(async move {
                                let result = owned.migration.import_secret_async(input, &connection_id).await;
                                owned.changed();
                                match result { Ok(value) => json!({"version":VERSION,"id":request.id,"result":value}), Err(error) => json!({"version":VERSION,"id":request.id,"error":local_command_error(&error)}) }
                            });
                            // 先完成槽准入再读取下一帧；重复请求直接返回原 pending，不积累等待任务。
                            match futures_util::poll!(task.as_mut()) {
                                std::task::Poll::Ready(response) => write_local_frame(&mut writer,&response,frame_limit).await?,
                                std::task::Poll::Pending => {
                                    credential_requests += 1;
                                    let responses = credential_results.clone();
                                    // 断连不取消已受理的独立槽；Host 持有原回执直到结算。
                                    tokio::task::spawn_local(async move { let _ = responses.send(task.await); });
                                }
                            }
                        }
                        Err(error) => write_local_frame(&mut writer,&json!({"version":VERSION,"id":request.id,"error":local_command_error(&error)}),frame_limit).await?,
                    }
                    continue;
                }
                let result=if request.version!=VERSION {Err(error("unsupportedVersion","Host requires version 1"))} else if request.id.is_empty() {Err(error("invalidRequest","id must be nonempty"))} else if request.method=="host.subscribe" {serde_json::from_value::<Empty>(request.params).map_err(anyhow::Error::from)?;let id=uuid::Uuid::new_v4().to_string();subscription=Some((id.clone(),0));let status=host.status().await;previous=serde_json::to_value(&status)?;Ok(json!({"subscriptionId":id,"generation":host.identity.generation,"sequence":0,"status":status}))} else if request.method=="remote.gateway.subscribe" {
                    #[derive(Deserialize)]
                    #[serde(rename_all="camelCase",deny_unknown_fields)]
                    struct Query { source_id:String }
                    let input:Query=serde_json::from_value(request.params)?;

                    async {
                        ensure!(gateway_subscription.as_ref().is_none_or(|(source,_,_,_)|source==&input.source_id),error("sourceNotFound","connection already subscribes to another Remote source"));
                        let state=host.gateway_state_async(&input.source_id).await?;
                        let id=uuid::Uuid::new_v4().to_string();
                        gateway_subscription=Some((input.source_id,id.clone(),0,state.clone()));
                        Ok(json!({"subscriptionId":id,"generation":host.identity.generation,"sequence":0,"state":state}))
                    }.await
                } else if request.method=="desktop.core.subscribe" {
                    ensure!(frontend_events.is_none(),error("invalidRequest","desktop attachment already exists"));
                    let input:areal_protocol::host::LocalDesktopCoreSubscribeParams=serde_json::from_value(request.params)?;
                    let (result,events)=host.schedules.connections.frontend_subscribe(&host,&connection.id,&input.source_id,serde_json::to_value(input.options)?,input.environment_credentials.map(|values|values.additional_properties))?;
                    frontend_events=Some(events);
                    let projects=host.slots.borrow().iter().filter(|(_,slot)|slot.state=="ready").map(|(id,_)|id.clone()).collect::<Vec<_>>();
                    for project in projects {host.schedules.connections.frontend_project_ready(&host,&project);}
                    Ok(result)
                } else {host.dispatch_connection(&request.method,request.params,&connection).await};
                let response=match result {Ok(value)=>json!({"version":VERSION,"id":request.id,"result":value}),Err(e)=>json!({"version":VERSION,"id":request.id,"error":local_command_error(&e)})};
                let sent=write_local_frame(&mut writer,&response,frame_limit).await;
                if host.stop.borrow().as_ref().is_some_and(|v| ReceiptState::is(v, ReceiptState::Completed)) {host.exit.notify_one();}
                sent?;
            },
            event=async {frontend_events.as_mut().unwrap().recv().await}, if frontend_events.is_some()=> {
                let event=event.context("desktop attachment closed")?;
                write_local_frame(&mut writer,&json!({"version":VERSION,"method":"desktop.core.event","params":event}),frame_limit).await?;
            },
            _=changes.changed(),if subscription.is_some() || gateway_subscription.is_some()=>{},
            _=tick.tick(),if subscription.is_some() || gateway_subscription.is_some()=>{}
        }
        if let Some((id, sequence)) = &mut subscription {
            let status = serde_json::to_value(host.status().await)?;
            if status != previous {
                *sequence += 1;
                wire::write(&mut writer,&json!({"version":VERSION,"method":"host.statusChanged","params":{"subscriptionId":id,"generation":host.identity.generation,"sequence":sequence,"status":status}})).await?;
                previous = status;
            }
        }
        if let Some((source, id, sequence, previous)) = &mut gateway_subscription {
            let state = host.gateway_state(source)?;
            if state != *previous {
                *sequence += 1;
                wire::write(&mut writer,&json!({"version":VERSION,"method":"remote.gateway.stateChanged","params":{"subscriptionId":id,"generation":host.identity.generation,"sequence":sequence,"state":state}})).await?;
                *previous = state;
            }
        }
    }
}

fn local_command_error(error: &anyhow::Error) -> Value {
    if let Some(rejected) = task_catalog::task_rejection_response(error) {
        return rejected;
    }
    let code = error
        .downcast_ref::<wire::Error>()
        .map(|error| error.code)
        .unwrap_or(if error.downcast_ref::<serde_json::Error>().is_some() {
            "invalidRequest"
        } else {
            "internalError"
        });
    json!({"code":code,"message":format!("{error:#}")})
}
impl Host {
    fn registrations(&self) -> Vec<ProjectRegistration> {
        self.slots
            .borrow()
            .values()
            .map(|slot| slot.registration.clone())
            .collect()
    }

    fn intent_digest(
        &self,
        method: &str,
        source_id: &str,
        request_id: &str,
        value: &Value,
    ) -> Result<String> {
        use hmac::{Hmac, Mac};
        let mut mac = Hmac::<sha2::Sha256>::new_from_slice(self.token.as_bytes())?;
        mac.update(&serde_json::to_vec(&json!([
            "areal.host.intent.v1",
            method,
            source_id,
            request_id
        ]))?);
        mac.update(&[0]);
        mac.update(&serde_json::to_vec(value)?);
        Ok(mac
            .finalize()
            .into_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect())
    }
    fn client_operation(&self, id: &str) -> Result<Option<Value>> {
        if let Some(receipt) = self.migration.operation(id)? {
            return Ok(Some(receipt));
        }
        if let Some(receipt) = self.journal.operation(id)? {
            return Ok(Some(receipt));
        }
        if let Some(receipt) = crate::vault::Vault::operation_offline(&self.home, id)? {
            return Ok(Some(receipt));
        }
        if let Some(receipt) = crate::remote_state::RemoteState::operation_offline(&self.home, id)?
        {
            return Ok(Some(receipt));
        }
        self.subscription_operation(id)
    }
    fn validate_client_state(&self, method: &str, params: &Value) -> Result<()> {
        if let Some(id) = params.get("requestId").and_then(Value::as_str) {
            wire::request_id(id)?;
            self.admission()?;
            self.generation(
                params["expectedGeneration"]
                    .as_str()
                    .ok_or_else(|| error("invalidRequest", "expectedGeneration is required"))?,
            )?;
            if self.receipt(id)?.is_some() {
                return Err(error(
                    "requestConflict",
                    "requestId belongs to a Host lifecycle operation",
                ));
            }
            if let Some(receipt) = self.client_operation(id)? {
                let same = receipt["method"] == method
                    || (method == "gui.retirementConfirm"
                        && receipt["method"] == "gui.retirementPrepare")
                    || (method.starts_with("journal.")
                        && receipt["method"]
                            .as_str()
                            .is_some_and(|m| m.starts_with("journal.")));
                if !same {
                    return Err(error(
                        "requestConflict",
                        "requestId belongs to a different domain operation",
                    ));
                }
            }
        }
        Ok(())
    }
    fn client_state(
        &self,
        method: &str,
        params: Value,
        connection: &ConnectionGuard,
    ) -> Result<Value> {
        self.validate_client_state(method, &params)?;
        match method {
            "gui.source" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Query {
                    source: crate::migration::Source,
                }
                let input: Query = serde_json::from_value(params)?;
                let registrations = self.registrations();
                self.migration.source(input.source, &registrations)
            }
            "gui.attachSource" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Attach {
                    source: crate::migration::Source,
                }
                let input: Attach = serde_json::from_value(params)?;
                self.migration
                    .attach(input.source, &connection.id, Some(connection.socket))
            }
            "gui.import" => {
                let input: crate::migration::Import = serde_json::from_value(params)?;
                self.generation(&input.expected_generation)?;
                let existing = self.registrations();
                let result =
                    self.migration
                        .import(input, &connection.id, &existing, &self.journal)?;
                for registration in self.migration.published()? {
                    let mut slots = self.slots.borrow_mut();
                    if slots
                        .get(&registration.project_id)
                        .is_some_and(|s| s.registration != registration)
                    {
                        return Err(error(
                            "migrationConflict",
                            "committed import conflicts with current registration",
                        ));
                    }
                    slots
                        .entry(registration.project_id.clone())
                        .or_insert_with(|| Slot::imported(registration));
                }
                self.schedules
                    .import(&self.migration, &self.registrations())?;
                self.schedules.wake.notify_one();
                self.changed();
                Ok(result)
            }
            "gui.importStatus" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Query {
                    migration_id: String,
                }
                self.migration
                    .status(&serde_json::from_value::<Query>(params)?.migration_id)
            }
            #[cfg(test)]
            "gui.importSecret" => {
                let input: crate::migration::ImportSecret = serde_json::from_value(params)?;
                self.generation(&input.expected_generation)?;
                self.migration.import_secret(input, &connection.id)
            }
            "gui.retirementPrepare" => {
                let input: crate::migration::retirement::Prepare = serde_json::from_value(params)?;
                self.generation(&input.expected_generation)?;
                self.migration.retirement_prepare(input, &connection.id)
            }
            "gui.retirementConfirm" => {
                let input: crate::migration::retirement::Confirm = serde_json::from_value(params)?;
                self.generation(&input.expected_generation)?;
                self.migration.retirement_confirm(input, &connection.id)
            }
            "gui.retirementStatus" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Query {
                    migration_id: String,
                }
                self.migration
                    .retirement_status(&serde_json::from_value::<Query>(params)?.migration_id)
            }
            "journal.read" | "journal.prepare" | "journal.commit" => {
                let project = if method == "journal.commit" {
                    self.journal.project_for_slot(
                        params["requestId"]
                            .as_str()
                            .context("requestId is required")?,
                        params["slotId"].as_str().context("slotId is required")?,
                    )?
                } else {
                    Some(
                        params["projectId"]
                            .as_str()
                            .ok_or_else(|| error("invalidRequest", "projectId is required"))?
                            .to_owned(),
                    )
                };
                if let Some(id) = project {
                    if !self.slots.borrow().contains_key(&id) {
                        return Err(error("projectNotFound", "project is not published"));
                    }
                    if self.migration.unpublished_reserved(&id)? {
                        return Err(error(
                            "migrationPending",
                            "project is reserved by an unpublished GUI import",
                        ));
                    }
                }
                self.journal.dispatch(method, params, &connection.id)
            }
            "vault.read" | "vault.replace" => self.migration.vault.dispatch(
                method,
                params,
                &self.identity.generation,
                &self.migration,
            ),
            "remote.gateway.state" => {
                let source = params["sourceId"]
                    .as_str()
                    .context("missing Remote source")?;
                self.gateway_state(source)
            }
            "remote.gateway.status" => {
                ensure!(params == json!({}), "invalid gateway status parameters");
                Ok(self.gateway.status())
            }
            "remote.gateway.handoff" => {
                self.remote.handoff(params, &self.identity, &self.migration)
            }
            "remote.read" | "remote.replace" | "remote.gateway.replace" | "remote.acquire" => {
                let projects = if method == "remote.read" {
                    Vec::new()
                } else {
                    let source = params["sourceId"]
                        .as_str()
                        .ok_or_else(|| error("invalidRequest", "sourceId is required"))?;
                    let current = self.registrations();
                    self.migration.remote_projects(source, &current)?
                };
                let result = self.remote.dispatch(
                    method,
                    params,
                    &connection.id,
                    &self.identity.generation,
                    &self.migration,
                    &projects,
                )?;
                if method == "remote.gateway.replace" {
                    let snapshot = self.remote.snapshot(&self.migration)?;
                    self.gateway.refresh_config(&snapshot["config"]);
                }
                Ok(result)
            }
            _ => Err(error("methodNotFound", "unknown Host client-state method")),
        }
    }
    fn apply_scheduling_intent(&self, id: &str) -> Result<()> {
        let mut record = self.receipt(id)?.context("missing scheduling operation")?;
        if record.evidence["schedulingIntentPending"] != true {
            return Ok(());
        }
        let project = record.receipt["projectId"]
            .as_str()
            .context("missing scheduling project")?;
        let suppressed = record.evidence["scheduleActivationSuppressed"]
            .as_bool()
            .context("missing scheduling intent")?;
        self.schedules.suppress(project, suppressed)?;
        record.evidence["schedulingIntentPending"] = json!(false);
        storage::write(&wire::operation_path(&self.home, id), &record)
    }
    fn changed(&self) {
        self.changes.send_modify(|sequence| *sequence += 1);
    }
    fn owner(&self) -> Owner {
        Owner::Host {
            host_id: self.identity.host_id.clone(),
            generation: self.identity.generation.clone(),
        }
    }
    fn gate(&self, id: &str) -> Result<Arc<RwLock<()>>> {
        self.slots
            .borrow()
            .get(id)
            .map(|s| s.gate.clone())
            .ok_or_else(|| error("projectNotFound", "unknown projectId"))
    }
    fn generation(&self, generation: &str) -> Result<()> {
        if generation != self.identity.generation {
            return Err(error("generationMismatch", "Host generation changed"));
        }
        Ok(())
    }
    fn admission(&self) -> Result<()> {
        if self.stop.borrow().is_some() {
            return Err(error(
                "stopInProgress",
                "Host stop intent prevents activation",
            ));
        }
        Ok(())
    }
    fn service_id(registration: &ProjectRegistration) -> String {
        storage::digest(registration.data_dir.as_os_str().as_encoded_bytes())[..24].into()
    }
    fn record_path(&self, id: &str) -> PathBuf {
        self.home
            .join("host/projects")
            .join(format!("{}.json", storage::digest(id.as_bytes())))
    }
    fn receipt(&self, id: &str) -> Result<Option<Operation>> {
        let mut record: Option<Operation> =
            storage::read_optional(&wire::operation_path(&self.home, id))?;
        if let Some(record) = &mut record
            && record.receipt["method"] == "host.stop"
            && !record.receipt["projects"].is_array()
        {
            record.receipt = crate::restore_host_stop(
                record.receipt.clone(),
                storage::read_optional(&self.home.join("host/stop.json"))?,
            );
        }
        Ok(record)
    }
    fn save(&self, id: &str, digest: &str, receipt: &Value) -> Result<()> {
        storage::write(
            &wire::operation_path(&self.home, id),
            &Operation {
                digest: digest.into(),
                receipt: receipt.clone(),
                evidence: self
                    .receipt(id)?
                    .map(|record| record.evidence)
                    .unwrap_or(Value::Null),
            },
        )
    }
    fn accepted(
        &self,
        id: &str,
        method: &str,
        params: &impl Serialize,
        project_id: &str,
    ) -> Result<(String, Option<Value>)> {
        wire::request_id(id)?;
        if self.client_operation(id)?.is_some() {
            return Err(error(
                "requestConflict",
                "requestId belongs to a client-state operation",
            ));
        }
        let digest = storage::digest(&serde_json::to_vec(
            &json!({"method":method,"params":params}),
        )?);
        if let Some(operation) = self.receipt(id)? {
            if operation.digest != digest {
                return Err(error(
                    "requestConflict",
                    "requestId already binds different parameters",
                ));
            }
            return Ok((digest, Some(operation.receipt)));
        }
        let mut receipt = json!({"version":VERSION,"requestId":id,"method":method,"hostId":self.identity.host_id,"generation":self.identity.generation,"projectId":project_id,"state":"acceptedPending"});
        if method == "host.stop" {
            receipt["strategy"] = serde_json::to_value(params)?["strategy"].clone();
            receipt["projects"] = json!([]);
            receipt["preparationPending"] = json!(true);
        }
        let evidence = if method == "projects.register" {
            let value = serde_json::to_value(params)?;
            json!({"registration":value["registration"],"created":!self.slots.borrow().contains_key(project_id),"bindExisting":value["bindExisting"]})
        } else if (method == "project.stop"
            && serde_json::to_value(params)?["suppressScheduling"] != false)
            || (method == "project.ensure"
                && serde_json::to_value(params)?["resumeScheduling"] == true)
        {
            json!({"schedulingIntentPending":true,"scheduleActivationSuppressed":method=="project.stop"})
        } else {
            Value::Null
        };
        storage::write(
            &wire::operation_path(&self.home, id),
            &Operation {
                digest: digest.clone(),
                receipt,
                evidence,
            },
        )?;
        Ok((digest, None))
    }
    async fn status(&self) -> HostStatus {
        let ids: Vec<_> = self.slots.borrow().keys().cloned().collect();
        for id in ids {
            self.project_status(&id).await;
        }
        self.status_snapshot()
    }
    fn status_snapshot(&self) -> HostStatus {
        let ids: Vec<_> = self.slots.borrow().keys().cloned().collect();
        let mut projects: Vec<_> = ids
            .iter()
            .map(|id| self.project_status_snapshot(id))
            .collect();
        for (registration, migration_id) in self.migration.pending_projects().unwrap_or_default() {
            if projects
                .iter()
                .any(|p| p.registration.project_id == registration.project_id)
            {
                continue;
            }
            projects.push(ProjectStatus {
                registration,
                state: "legacyPending".into(),
                service: None,
                uses_shared_model_config: true,
                schedule_activation_suppressed: true,
                schedule_activation_error: Some("migrationPending".into()),
                migration: Some(json!({"phase":"legacyPending","migrationId":migration_id})),
            });
        }
        let stop = self.stop.borrow();
        HostStatus {
            host_id: self.identity.host_id.clone(),
            generation: self.identity.generation.clone(),
            state: if stop
                .as_ref()
                .is_some_and(|s| ReceiptState::is(s, ReceiptState::Completed))
            {
                "stopped"
            } else if stop.is_some() {
                "stopping"
            } else {
                "running"
            }
            .into(),
            projects,
            restart_pending: updates::restart_pending(&self.home).unwrap_or(true),
            stop_intent: stop.is_some(),
            capabilities: CAPABILITIES.iter().map(|s| (*s).into()).collect(),
        }
    }
    async fn activity(&self) -> Activity {
        let ids: Vec<_> = self.slots.borrow().keys().cloned().collect();
        let mut result = Activity {
            complete: true,
            projects: Vec::new(),
            total_active_tasks: 0,
        };
        for id in ids {
            let gate = self.slots.borrow()[&id].gate.clone();
            let acquired = std::cell::Cell::new(false);
            let observed = tokio::time::timeout(Duration::from_secs(3), async {
                // 短配置同步可能正在排队写锁；等它结算后重取权威身份，锁等待共用原观察预算。
                let _guard = gate.read().await;
                acquired.set(true);
                let (registration, supervised, known_service, stable) = {
                    let slots = self.slots.borrow();
                    let slot = &slots[&id];
                    (
                        slot.registration.clone(),
                        slot.writer.is_some(),
                        slot.service.clone(),
                        !slot.uncertain_start && slot.migration.is_none(),
                    )
                };
                if !stable {
                    eprintln!("Host activity unavailable: projectId={id} stage=hostLifecycleState");
                    return None;
                }
                match crate::activity::observe(
                    &self.home,
                    &registration,
                    &self.owner(),
                    supervised,
                    known_service.as_ref(),
                )
                .await
                {
                    Ok(activity) => Some(activity),
                    Err(cause) => {
                        eprintln!(
                            "Host activity unavailable: projectId={id} stage={}",
                            crate::activity::failure_stage(&cause)
                        );
                        None
                    }
                }
            })
            .await
            .unwrap_or_else(|_| {
                let stage = if acquired.get() {
                    "observationBudget"
                } else {
                    "hostLifecycleGate"
                };
                eprintln!("Host activity unavailable: projectId={id} stage={stage}");
                None
            });
            let observed = observed.filter(|activity| {
                let ProjectActivity::Observed { active_tasks, .. } = activity else {
                    return false;
                };
                if let Some(total) = result.total_active_tasks.checked_add(*active_tasks) {
                    result.total_active_tasks = total;
                    true
                } else {
                    false
                }
            });
            result.complete &= observed.is_some();
            result
                .projects
                .push(observed.unwrap_or(ProjectActivity::Unavailable { project_id: id }));
        }
        result
    }
    fn uses_shared_host_config(&self, inputs: &LaunchInputs) -> bool {
        let shared = self.home.join("config.toml");
        inputs.config_home == self.home
            && inputs.config_path.as_deref().is_none_or(|p| p == shared)
            && inputs.options.config.as_deref().is_none_or(|p| p == shared)
    }
    fn project_uses_shared_config(&self, registration: &ProjectRegistration) -> bool {
        let path = self
            .home
            .join("host/launch")
            .join(storage::digest(registration.project_id.as_bytes()))
            .join("inputs.json");
        match storage::read_optional::<LaunchInputs>(&path) {
            Ok(Some(inputs)) if matches!(registration.source, crate::ProjectSource::Gui { .. }) => {
                let shared = self.home.join("config.toml");
                inputs.config_path.as_deref().is_none_or(|p| p == shared)
                    && inputs.options.config.as_deref().is_none_or(|p| p == shared)
            }
            Ok(Some(inputs)) => self.uses_shared_host_config(&inputs),
            Ok(None) => matches!(registration.source, crate::ProjectSource::Gui { .. }),
            Err(_) => false,
        }
    }
    async fn project_status(&self, id: &str) -> ProjectStatus {
        let (registration, gate) = {
            let slots = self.slots.borrow();
            let s = &slots[id];
            (s.registration.clone(), s.gate.clone())
        };
        if let Ok(_guard) = tokio::time::timeout(Duration::from_millis(500), gate.read()).await {
            let instance = Self::service_id(&registration);
            let observed = tokio::time::timeout(
                Duration::from_millis(500),
                areal_local_service::status(&self.home, &instance),
            )
            .await;
            if let Ok(Ok(service)) = observed {
                let mut slots = self.slots.borrow_mut();
                let slot = slots.get_mut(id).unwrap();
                slot.probe_failures = 0;
                slot.state = match service.state {
                    State::Ready
                        if service.owner.as_ref() == Some(&self.owner())
                            && slot.writer.is_some() =>
                    {
                        "ready"
                    }
                    State::Ready if service.owner.is_none() => "legacyPending",
                    State::Ready => "unavailable",
                    State::Stopped => "stopped",
                    State::Stopping => "stopping",
                    State::Unavailable => "unavailable",
                }
                .into();
                slot.service = Some(service);
            } else {
                // 探测失败只代表本次观察没有完成；执行身份由服务回执与连接自身确认。
                let reason = if observed.is_err() {
                    "timeout"
                } else {
                    "probe_error"
                };
                let connection_observation = if observed.is_err() {
                    self.schedules.connections.observation_state(self, id)
                } else {
                    schedule_connection::ConnectionObservation::Closed
                };
                let mut slots = self.slots.borrow_mut();
                let slot = slots.get_mut(id).unwrap();
                slot.probe_failures = slot.probe_failures.saturating_add(1);
                let supervised = slot.writer.is_some()
                    && slot
                        .service
                        .as_ref()
                        .is_some_and(|service| service.owner.as_ref() == Some(&self.owner()));
                // 已有存活实时连接时保留 ready；尚未建连前给予有限次瞬态超时宽限（< 3 次）；原连接已关闭则立即撤销 ready。
                let transient_timeout_protected = observed.is_err()
                    && supervised
                    && !slot.uncertain_start
                    && match connection_observation {
                        schedule_connection::ConnectionObservation::Live => true,
                        schedule_connection::ConnectionObservation::NeverConnected => {
                            slot.probe_failures < 3
                        }
                        schedule_connection::ConnectionObservation::Closed => false,
                    };
                if slot.state == "ready" && !transient_timeout_protected {
                    slot.state = "unavailable".into();
                }
                if slot.service.is_some() {
                    eprintln!(
                        "Host service observation incomplete: project={id} reason={reason} consecutive={}",
                        slot.probe_failures
                    );
                }
            }
        }
        self.project_status_snapshot(id)
    }
    fn project_status_snapshot(&self, id: &str) -> ProjectStatus {
        let slots = self.slots.borrow();
        let slot = &slots[id];
        let registration = slot.registration.clone();
        ProjectStatus {uses_shared_model_config:self.project_uses_shared_config(&registration),schedule_activation_suppressed:self.schedules.suppressed(id),schedule_activation_error:self.schedules.error(id),registration,state:slot.state.clone(),service:slot.service.clone().filter(|s|s.owner.as_ref()==Some(&self.owner()) && slot.writer.is_some() && slot.state=="ready"),migration:slot.migration.clone().or_else(||slot.service.as_ref().filter(|s|s.owner.is_none() && s.state==State::Ready).map(|s|json!({"serviceId":s.identity.service_id,"generation":s.identity.generation,"phase":"legacyPending"})))}
    }
    async fn dispatch_connection(
        self: &Rc<Self>,
        method: &str,
        params: Value,
        connection: &ConnectionGuard,
    ) -> Result<Value> {
        if method == "lifecycle.read" {
            let input: areal_protocol::host::LocalLifecycleReadParams =
                serde_json::from_value(params.clone()).context("INVALID_PARAMS")?;
            let profile = std::fs::canonicalize(&input.profile)?;
            let source = self
                .migration
                .navigation_source_id(&profile)?
                .context("FORBIDDEN")?;
            let operation = params["operation"].as_str().context("INVALID_PARAMS")?;
            return Box::pin(workbench_lifecycle::read_request(
                self, &source, operation, &params,
            ))
            .await;
        }
        if method == "desktop.core.terminals.close" {
            ensure!(
                params.as_object().is_some_and(|params| params.len() == 1),
                "INVALID_PARAMS"
            );
            return self.schedules.connections.frontend_close_terminals(
                self,
                params["sourceId"].as_str().context("INVALID_PARAMS")?,
            );
        }
        if method == "desktop.core.call" {
            return self
                .schedules
                .connections
                .frontend_call(self, &params)
                .await;
        }
        if method == "desktop.command" {
            let input = serde_json::from_value(params).context("INVALID_PARAMS")?;
            return self
                .schedules
                .connections
                .frontend_desktop_command(self, input)
                .await;
        }
        if method == "desktop.core.callback" {
            return self.schedules.connections.frontend_reply(&params);
        }
        if method == "tasks.read" {
            serde_json::from_value::<areal_protocol::host::LocalTasksReadParams>(params.clone())?;
            return task_catalog::read(self, "local", &params).await;
        }
        if method == "tasks.command" {
            serde_json::from_value::<areal_protocol::host::LocalTasksCommandParams>(
                params.clone(),
            )?;
            return task_catalog::native_command(self, "local", &params).await;
        }
        if method == "worktree.read" {
            serde_json::from_value::<areal_protocol::host::LocalWorktreeReadParams>(
                params.clone(),
            )?;
            let source = params["sourceId"].as_str().unwrap_or("host").to_owned();
            return worktree_catalog::read(self, &source, params).await;
        }
        if method == "worktree.command" {
            serde_json::from_value::<areal_protocol::host::LocalWorktreeCommandParams>(
                params.clone(),
            )?;
            return workbench_route::backend_command(self,"local",&json!({"method":method,"commandId":params["commandId"],"params":params["request"]})).await;
        }
        if bots::METHODS.contains(&method) {
            return bots::request(self, method, &params).await;
        }
        if method == "backend.credentialNames" {
            serde_json::from_value::<areal_protocol::host::LocalBackendEnsureParams>(
                params.clone(),
            )?;
            return self
                .gateway
                .workbench
                .credential_names(self, serde_json::from_value(params)?);
        }
        if method == "backend.status" {
            serde_json::from_value::<Empty>(params)?;
            // 升级客户端用同一查询区分持有旧子进程的上一代 Host。
            return Ok(json!({
                "hostId": self.identity.host_id,
                "generation": self.identity.generation,
                "owned": false,
                "service": null,
            }));
        }
        if method == "web.ticket" {
            let input: areal_protocol::host::LocalWebTicketParams = serde_json::from_value(params)?;
            let gui = input.origin == "areal-ui://app" && input.profile.is_some();
            let preferred = input
                .profile
                .as_deref()
                .map(|profile| {
                    self.migration
                        .navigation_source_id(std::path::Path::new(profile))
                })
                .transpose()?
                .flatten();
            let mut ticket = self.loopback.ticket(input)?;
            if gui {
                self.retain_for_gui()?;
            }
            ticket.preferred_source_id = preferred;
            return Ok(serde_json::to_value(ticket)?);
        }
        if method == "web.endpoint" {
            ensure!(
                params.as_object().is_some_and(|params| params.is_empty()),
                wire::error("invalidRequest", "endpoint takes no arguments")
            );
            return Ok(serde_json::to_value(self.loopback.endpoint()?)?);
        }
        if method == "web.approve" {
            return self.loopback.approve(self, params);
        }
        if method == "web.devices" {
            ensure!(
                params.as_object().is_some_and(|params| params.is_empty()),
                wire::error("invalidRequest", "devices takes no arguments")
            );
            return self.loopback.devices();
        }
        if method == "web.revoke" {
            return self.loopback.revoke(self, params);
        }
        if method == "remote.gateway.state" {
            self.validate_client_state(method, &params)?;
            let source = params["sourceId"]
                .as_str()
                .context("missing Remote source")?;
            return self.gateway_state_async(source).await;
        }
        if method == "remote.gateway.control" {
            return connection.host.gateway_control(params).await;
        }
        if method.starts_with("subscription.") {
            return self.subscription_dispatch(method, params, connection).await;
        }
        if matches!(
            method,
            "remote.read"
                | "remote.replace"
                | "remote.gateway.replace"
                | "remote.acquire"
                | "remote.gateway.handoff"
        ) {
            self.validate_client_state(method, &params)?;
            if method == "remote.gateway.handoff" {
                return self
                    .remote
                    .handoff_async(params, &self.identity, &self.migration)
                    .await;
            }
            let projects = if method == "remote.read" {
                Vec::new()
            } else {
                let source = params["sourceId"]
                    .as_str()
                    .ok_or_else(|| error("invalidRequest", "sourceId is required"))?;
                let current = self.registrations();
                self.migration.remote_projects(source, &current)?
            };
            let result = self
                .remote
                .dispatch_async(
                    method,
                    params,
                    &connection.id,
                    &self.identity.generation,
                    &self.migration,
                    &projects,
                )
                .await?;
            if method == "remote.gateway.replace" {
                let snapshot = self.remote.snapshot_async(&self.migration).await?;
                self.gateway.refresh_config(&snapshot["config"]);
            }
            return Ok(result);
        }
        if method == "gui.importSecret" {
            self.validate_client_state(method, &params)?;
            let input: crate::migration::ImportSecret = serde_json::from_value(params)?;
            self.generation(&input.expected_generation)?;
            let result = self
                .migration
                .import_secret_async(input, &connection.id)
                .await?;
            self.changed();
            return Ok(result);
        }
        if method == "vault.read" || method == "vault.replace" {
            self.validate_client_state(method, &params)?;
            return self
                .migration
                .vault
                .dispatch_async(method, params, &self.identity.generation, &self.migration)
                .await;
        }
        if method.starts_with("gui.")
            || method.starts_with("journal.")
            || method.starts_with("vault.")
            || method.starts_with("remote.")
        {
            return self.client_state(method, params, connection);
        }
        self.dispatch(method, params).await
    }
    async fn dispatch(&self, method: &str, params: Value) -> Result<Value> {
        match method {
            "providers.revealKey" => {
                provider_config::reveal_key(self, serde_json::from_value(params)?).await
            }
            "recovery.importProvider" => self.import_provider(serde_json::from_value(params)?),
            "recovery.history" => {
                crate::space::history::for_host(&self.home, serde_json::from_value(params)?).await
            }
            "recovery.inspect" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Inspect {
                    space_id: Option<String>,
                }
                let input: Inspect = serde_json::from_value(params)?;
                crate::space::inspect_for_host(&self.home, input.space_id.as_deref())
            }
            "host.status" => {
                serde_json::from_value::<Empty>(params)?;
                Ok(serde_json::to_value(self.status().await)?)
            }
            "host.activity" => {
                serde_json::from_value::<Empty>(params)?;
                Ok(serde_json::to_value(self.activity().await)?)
            }
            "host.power" => {
                let query: power::Query = serde_json::from_value(params)?;
                self.refresh_power().await?;
                serde_json::to_value(self.power.view(&query.source_id)?).map_err(Into::into)
            }
            "projects.list" => {
                serde_json::from_value::<Empty>(params)?;
                Ok(
                    json!({"projects":self.slots.borrow().values().map(|s|s.registration.clone()).collect::<Vec<_>>()}),
                )
            }
            "projects.register" => self.register(serde_json::from_value(params)?).await,
            "project.ensure" => self.ensure(serde_json::from_value(params)?).await,
            "project.stop" => self.stop_project(serde_json::from_value(params)?).await,
            "host.stop" => self.stop_host(serde_json::from_value(params)?).await,
            "host.release" => self.release_when_unused(serde_json::from_value(params)?),
            "host.operation" => {
                let query: OperationQuery = serde_json::from_value(params)?;
                wire::request_id(&query.request_id)?;
                if self
                    .receipt(&query.request_id)?
                    .is_some_and(|record| record.receipt["method"] == "host.update")
                {
                    return Ok(
                        json!({"operation":self.reconcile_update(&query.request_id).await?}),
                    );
                }
                if let Some(operation) = self.migration.operation_async(&query.request_id).await? {
                    return Ok(json!({"operation":operation}));
                }
                Ok(
                    json!({"operation":match self.migration.vault.operation_async(&query.request_id, &self.migration).await? {
                        Some(receipt) => Some(receipt),
                        None => match self.remote.operation_async(&query.request_id, &self.migration).await? {
                            Some(receipt) => Some(receipt),
                            None => match self.client_operation(&query.request_id)? { Some(receipt) => Some(receipt), None => self.reconcile(&query.request_id).await? }
                        }
                    }}),
                )
            }
            "host.updateStatus" => {
                serde_json::from_value::<Empty>(params)?;
                self.update_status()
            }
            "host.update" => self.update(serde_json::from_value(params)?).await,
            _ => Err(error("methodNotFound", "unknown Host method")),
        }
    }
    async fn register(&self, mut input: Register) -> Result<Value> {
        self.generation(&input.expected_generation)?;
        self.admission()?;
        wire::request_id(&input.request_id)?;
        let r = &mut input.registration;
        ensure!(
            !r.project_id.is_empty() && r.project_id.len() <= 256,
            "invalidRequest: projectId must contain 1..256 bytes"
        );
        ensure!(
            r.workspace.is_absolute() && r.data_dir.is_absolute(),
            "invalidRequest: registration paths must be absolute"
        );
        r.workspace = r.workspace.canonicalize()?;
        r.data_dir = storage::canonical_pending(&r.data_dir)?;
        ensure!(
            r.workspace.is_dir()
                && !r.data_dir.starts_with(&r.workspace)
                && !self.home.starts_with(&r.workspace),
            "invalidRequest: state must be outside workspace"
        );
        crate::space::validate_workspace(&self.home, &r.workspace)?;
        self.migration
            .validate_registration(r, &self.registrations())?;
        ensure!(
            !input.bind_existing || input.registration.default_binding,
            "invalidRequest: bindExisting requires defaultBinding"
        );
        let (digest, previous) = self.accepted(
            &input.request_id,
            "projects.register",
            &input,
            &input.registration.project_id,
        )?;
        if let Some(previous) = previous {
            return previous_result(previous);
        }
        let r = input.registration;
        if self.migration.reserved(&r)? {
            return self.finish_mutation(
                &input.request_id,
                &digest,
                Err(error(
                    "migrationConflict",
                    "project ID or Store is reserved by a GUI import",
                )),
            );
        }
        if input.bind_existing {
            let conflict = {
                let slots = self.slots.borrow();
                slots.values().any(|slot| {
                    slot.registration.project_id != r.project_id
                        && (slot.registration.data_dir == r.data_dir
                            || (slot.registration.workspace == r.workspace
                                && slot.registration.default_binding))
                })
            };
            if conflict {
                return self.finish_mutation(
                    &input.request_id,
                    &digest,
                    Err(error(
                        "defaultBindingConflict",
                        "binding conflicts with another registered project",
                    )),
                );
            }
            let previous = self
                .slots
                .borrow()
                .get(&r.project_id)
                .map(|slot| slot.registration.clone());
            if previous.as_ref().is_some_and(|old| {
                old.workspace != r.workspace || old.data_dir != r.data_dir || old.source != r.source
            }) {
                return self.finish_mutation(
                    &input.request_id,
                    &digest,
                    Err(error(
                        "projectConflict",
                        "projectId already has another binding",
                    )),
                );
            }
            {
                let binding = async {
                    std::fs::create_dir_all(&r.data_dir)?;
                    areal_local_service::bind(&self.home, &r.workspace, &r.data_dir).await?;
                    Ok::<(), anyhow::Error>(())
                }
                .await;
                if let Err(error) = binding {
                    return self.finish_mutation(&input.request_id, &digest, Err(error));
                }
            }
        }
        let outcome = (|| {
            let mut slots = self.slots.borrow_mut();
            let created = !slots.contains_key(&r.project_id);
            if let Some(slot) = slots.get(&r.project_id) {
                if slot.registration.workspace != r.workspace
                    || slot.registration.data_dir != r.data_dir
                    || slot.registration.source != r.source
                {
                    return Err(error(
                        "projectConflict",
                        "projectId already has another binding",
                    ));
                }
                if slot.registration == r {
                    return Ok(json!({"registration":r,"created":false}));
                }
            }
            for slot in slots.values() {
                let other = &slot.registration;
                if other.project_id == r.project_id {
                    continue;
                }
                if other.data_dir == r.data_dir {
                    return Err(error("dataDirConflict", "dataDir already registered"));
                }
                if r.default_binding && other.default_binding && other.workspace == r.workspace {
                    return Err(error(
                        "defaultBindingConflict",
                        "workspace already has a default binding",
                    ));
                }
            }
            storage::write(&self.record_path(&r.project_id), &r)?;
            if let Some(slot) = slots.get_mut(&r.project_id) {
                slot.registration = r.clone();
                return Ok(json!({"registration":r,"created":false}));
            }
            slots.insert(r.project_id.clone(), Slot::imported(r.clone()));
            Ok(json!({"registration":r,"created":created}))
        })();
        let result = self.finish_mutation(&input.request_id, &digest, outcome);
        self.schedules.wake.notify_one();
        result
    }
    fn finish_mutation(&self, id: &str, digest: &str, outcome: Result<Value>) -> Result<Value> {
        let mut receipt = self
            .receipt(id)?
            .context("missing accepted operation")?
            .receipt;
        match outcome {
            Ok(result) => {
                receipt["state"] = json!(ReceiptState::Completed);
                receipt["result"] = result.clone();
                self.save(id, digest, &receipt)?;
                self.changed();
                Ok(result)
            }
            Err(e) => {
                let uncertain = e.downcast_ref::<std::io::Error>().is_some()
                    || receipt["method"] == "project.ensure"
                        && receipt["projectId"].as_str().is_some_and(|id| {
                            self.slots.borrow().get(id).is_some_and(|slot| {
                                slot.uncertain_start
                                    || slot
                                        .migration
                                        .as_ref()
                                        .is_some_and(|m| m["phase"] == "draining")
                            })
                        });
                receipt["state"] = json!(if uncertain {
                    "admissionUnknown"
                } else {
                    "blocked"
                });
                receipt["error"] = json!({"code":e.downcast_ref::<wire::Error>().map(|e|e.code).unwrap_or("internalError"),"message":format!("{e:#}")});
                self.save(id, digest, &receipt)?;
                self.changed();
                Err(e)
            }
        }
    }
    async fn ensure(&self, input: Ensure) -> Result<Value> {
        let id = input.project_id.clone();
        let result = self.ensure_cause(input, false).await?;
        if let Some(generation) = result["service"]["generation"].as_str()
            && !self.schedules.suppressed(&id)
            && !self.schedules.import_blocked(&id)
        {
            self.schedules
                .connections
                .ready(self, &id, generation)
                .await?;
        }
        Ok(result)
    }
    async fn ensure_cause(&self, input: Ensure, scheduled: bool) -> Result<Value> {
        self.ensure_generation(input, scheduled, None).await
    }
    fn install_live_ensure(
        self: &Rc<Self>,
        project_id: &str,
        request_id: &str,
    ) -> Result<LiveEnsureGuard> {
        let mut slots = self.slots.borrow_mut();
        let slot = slots
            .get_mut(project_id)
            .ok_or_else(|| error("projectNotFound", "unknown projectId"))?;
        let (done, _) = watch::channel(false);
        let entry = LiveEnsure {
            request_id: request_id.to_owned(),
            admitted: Rc::new(std::cell::Cell::new(false)),
            done: Rc::new(done),
        };
        slot.live_ensure = Some(entry.clone());
        Ok(LiveEnsureGuard {
            host: self.clone(),
            project_id: project_id.to_owned(),
            entry,
        })
    }
    fn install_scoped_live_ensure(
        &self,
        project_id: &str,
        request_id: &str,
    ) -> Option<ScopedLiveEnsureGuard<'_>> {
        let mut slots = self.slots.borrow_mut();
        let slot = slots.get_mut(project_id)?;
        let (done, _) = watch::channel(false);
        let entry = LiveEnsure {
            request_id: request_id.to_owned(),
            admitted: Rc::new(std::cell::Cell::new(true)),
            done: Rc::new(done),
        };
        slot.live_ensure = Some(entry.clone());
        Some(ScopedLiveEnsureGuard {
            host: self,
            project_id: project_id.to_owned(),
            entry,
        })
    }
    fn install_live_idle_stop(
        &self,
        project_id: &str,
        request_id: &str,
        service_generation: &str,
    ) -> Option<ScopedLiveIdleStopGuard<'_>> {
        let mut slots = self.slots.borrow_mut();
        let slot = slots.get_mut(project_id)?;
        let (done, _) = watch::channel(false);
        let entry = LiveIdleStop {
            request_id: request_id.to_owned(),
            service_generation: service_generation.to_owned(),
            done: Rc::new(done),
        };
        slot.live_idle_stop = Some(entry.clone());
        Some(ScopedLiveIdleStopGuard {
            host: self,
            project_id: project_id.to_owned(),
            entry,
        })
    }
    fn ready_generation(&self, id: &str) -> Option<String> {
        let slots = self.slots.borrow();
        let slot = slots.get(id)?;
        if slot.state != "ready" || slot.uncertain_start {
            return None;
        }
        slot.service
            .as_ref()
            .map(|service| service.identity.generation.clone())
    }
    async fn finish_activation_receipt(
        &self,
        id: &str,
        activation: &str,
        receipt: &Value,
        deadline: tokio::time::Instant,
    ) -> Result<ActivationOutcome> {
        if self.schedules.suppressed(id) {
            return Ok(ActivationOutcome::Blocked {
                activation_id: Some(activation.to_owned()),
                reason: "explicitlyStopped",
            });
        }
        if receipt["state"] == "completed"
            && let Some(generation) = self.ready_generation(id)
        {
            let connected = self
                .schedules
                .connections
                .ready_until(self, id, &generation, deadline)
                .await;
            if self.schedules.suppressed(id) {
                return Ok(ActivationOutcome::Blocked {
                    activation_id: Some(activation.to_owned()),
                    reason: "explicitlyStopped",
                });
            }
            if connected.is_ok()
                && self.ready_generation(id).as_deref() == Some(generation.as_str())
            {
                return Ok(ActivationOutcome::Ready {
                    service_generation: generation,
                    activation_id: Some(activation.to_owned()),
                });
            }
            return Ok(ActivationOutcome::Pending {
                activation_id: Some(activation.to_owned()),
                reason: "activationIncomplete",
            });
        }
        let blocked = receipt["state"] == "blocked" || receipt["state"] == "completed";
        Ok(if blocked {
            ActivationOutcome::Blocked {
                activation_id: Some(activation.to_owned()),
                reason: "activationIncomplete",
            }
        } else {
            ActivationOutcome::Pending {
                activation_id: Some(activation.to_owned()),
                reason: "activationIncomplete",
            }
        })
    }
    pub(super) async fn wait_live_ensure_if_any(
        &self,
        id: &str,
        deadline: tokio::time::Instant,
    ) -> Result<Option<(String, bool, bool)>> {
        let live = {
            self.slots
                .borrow()
                .get(id)
                .and_then(|slot| slot.live_ensure.clone())
        };
        let Some(live) = live else {
            return Ok(None);
        };
        let finished = wait_watch_true(&live.done, deadline).await;
        let admitted = live.admitted.get() || self.receipt(&live.request_id)?.is_some();
        Ok(Some((live.request_id, finished, admitted)))
    }
    /// 规范普通唤醒入口：合并同项目在途启动、等待已有代际共享连接、并在安全边界内衔接 `ifIdle` 休眠。
    /// 显式恢复调度与崩溃遗留的 UNKNOWN 回执仍严格按原回执语义处理，绝不重放未知启动。
    pub(super) async fn activate_project_normal(
        self: &Rc<Self>,
        id: &str,
        deadline: tokio::time::Instant,
    ) -> Result<ActivationOutcome> {
        const MAX_ROUNDS: usize = 4;
        for _ in 0..MAX_ROUNDS {
            self.admission()?;
            if self.schedules.suppressed(id) {
                return Ok(ActivationOutcome::Blocked {
                    activation_id: None,
                    reason: "explicitlyStopped",
                });
            }
            // 仅对活跃的 `ifIdle` 自动休眠等待交接；调度资源刷新等其他停止不抢占。
            // 先在同步块内拷贝句柄并释放 slots 借用，避免 `if let` 临时 Ref 跨越 `.await`。
            let idle_stop = if schedule_connection::refresh_path(self, id).exists() {
                None
            } else {
                self.slots.borrow().get(id).and_then(|slot| {
                    let stop = slot.live_idle_stop.as_ref()?;
                    let same_generation = slot.service.as_ref().is_none_or(|service| {
                        service.identity.generation == stop.service_generation
                    });
                    same_generation.then(|| stop.clone())
                })
            };
            if let Some(idle_stop) = idle_stop {
                if !wait_watch_true(&idle_stop.done, deadline).await {
                    return Ok(ActivationOutcome::Pending {
                        activation_id: None,
                        reason: "activationIncomplete",
                    });
                }
                self.admission()?;
                if self.schedules.suppressed(id) {
                    return Ok(ActivationOutcome::Blocked {
                        activation_id: None,
                        reason: "explicitlyStopped",
                    });
                }
                if let Some(receipt) = self.reconcile(&idle_stop.request_id).await?
                    && !ReceiptState::settled(ReceiptState::of(&receipt))
                {
                    return Ok(ActivationOutcome::Pending {
                        activation_id: None,
                        reason: "activationIncomplete",
                    });
                }
                continue;
            }
            if let Some((request_id, finished, admitted)) =
                self.wait_live_ensure_if_any(id, deadline).await?
            {
                if !finished {
                    return Ok(ActivationOutcome::Pending {
                        activation_id: admitted.then_some(request_id),
                        reason: "activationIncomplete",
                    });
                }
                self.admission()?;
                if self.schedules.suppressed(id) {
                    return Ok(ActivationOutcome::Blocked {
                        activation_id: admitted.then_some(request_id),
                        reason: "explicitlyStopped",
                    });
                }
                if let Some(record) = self.receipt(&request_id)? {
                    return self
                        .finish_activation_receipt(id, &request_id, &record.receipt, deadline)
                        .await;
                }
                continue;
            }
            if let Some(generation) = self.ready_generation(id) {
                let connected = self
                    .schedules
                    .connections
                    .ready_until(self, id, &generation, deadline)
                    .await;
                if self.schedules.suppressed(id) {
                    return Ok(ActivationOutcome::Blocked {
                        activation_id: None,
                        reason: "explicitlyStopped",
                    });
                }
                if connected.is_ok()
                    && self.ready_generation(id).as_deref() == Some(generation.as_str())
                {
                    return Ok(ActivationOutcome::Ready {
                        service_generation: generation,
                        activation_id: None,
                    });
                }
                let can_handoff = tokio::time::Instant::now() < deadline
                    && self.admission().is_ok()
                    && !schedule_connection::refresh_path(self, id).exists()
                    && self.slots.borrow().get(id).is_some_and(|slot| {
                        slot.live_idle_stop.is_some()
                            || slot.state == "stopped"
                            || (slot.state == "ready"
                                && slot.service.as_ref().is_some_and(|service| {
                                    service.identity.generation != generation
                                }))
                    });
                if can_handoff {
                    continue;
                }
                return Ok(ActivationOutcome::Pending {
                    activation_id: None,
                    reason: "activationIncomplete",
                });
            }
            // 启动是 Host 拥有的幂等资源操作。崩溃遗留或无活跃任务的未决回执只核对原 ensure，不重放未知启动。
            for path in storage::json_records(&self.home.join("host/operations"), false)? {
                let record: Operation = storage::read(&path)?;
                if record.receipt["method"] == "project.ensure"
                    && record.receipt["projectId"] == id
                    && !record.settled()
                {
                    let request = record.receipt["requestId"]
                        .as_str()
                        .context("CORE_UNAVAILABLE")?;
                    let receipt = self.reconcile(request).await?.context("CORE_UNAVAILABLE")?;
                    return self
                        .finish_activation_receipt(id, request, &receipt, deadline)
                        .await;
                }
            }
            // 单线程 LocalSet 内同步登记活跃启动，覆盖“等待准入”与“已准入执行”两个阶段，避免并发重复受理。
            let activation = uuid::Uuid::new_v4().to_string();
            let live_guard = self.install_live_ensure(id, &activation)?;
            let live_entry = live_guard.entry.clone();
            let run = self.ensure_from_gateway_tracked(
                Ensure {
                    request_id: activation.clone(),
                    expected_generation: self.identity.generation.clone(),
                    project_id: id.to_owned(),
                    launch_inputs: None,
                    credentials: Default::default(),
                    no_auto_restart: false,
                    resume_scheduling: false,
                },
                Some(live_guard),
            );
            let outcome = match tokio::time::timeout_at(deadline, run).await {
                Ok(result) => result,
                Err(_) => {
                    let admitted =
                        live_entry.admitted.get() || self.receipt(&activation)?.is_some();
                    return Ok(ActivationOutcome::Pending {
                        activation_id: admitted.then_some(activation),
                        reason: "activationIncomplete",
                    });
                }
            };
            if let Some(record) = self.receipt(&activation)? {
                return self
                    .finish_activation_receipt(id, &activation, &record.receipt, deadline)
                    .await;
            }
            outcome?;
            anyhow::bail!("CORE_UNAVAILABLE");
        }
        Ok(ActivationOutcome::Pending {
            activation_id: None,
            reason: "activationIncomplete",
        })
    }
    async fn ensure_from_gateway_tracked(
        self: &Rc<Self>,
        input: Ensure,
        live: Option<LiveEnsureGuard>,
    ) -> Result<Value> {
        let live = match live {
            Some(guard) => Some(guard),
            None => self
                .install_live_ensure(&input.project_id, &input.request_id)
                .ok(),
        };
        let (guard, digest, previous) = self
            .admit_ensure(&input, true, None, live.as_ref().map(|g| &g.entry))
            .await?;
        if let Some(previous) = previous {
            return previous_result(previous);
        }
        // 受理之后由 Host 持有原项目锁、活跃启动登记和回执。Renderer 重载只撤回等待结果的连接。
        let host = self.clone();
        tokio::task::spawn_local(async move {
            let _guard = guard;
            let _live = live;
            host.finish_ensure(&input, true, &digest).await
        })
        .await
        .context("project activation task failed")?
    }
    async fn ensure_generation(
        &self,
        input: Ensure,
        scheduled: bool,
        service_generation: Option<&str>,
    ) -> Result<Value> {
        let (_guard, digest, previous) = self
            .admit_ensure(&input, scheduled, service_generation, None)
            .await?;
        if let Some(previous) = previous {
            return previous_result(previous);
        }
        let _live = self.install_scoped_live_ensure(&input.project_id, &input.request_id);
        self.finish_ensure(&input, scheduled, &digest).await
    }
    async fn admit_ensure(
        &self,
        input: &Ensure,
        scheduled: bool,
        service_generation: Option<&str>,
        live: Option<&LiveEnsure>,
    ) -> Result<(OwnedRwLockWriteGuard<()>, String, Option<Value>)> {
        self.generation(&input.expected_generation)?;
        self.admission()?;
        let guard = self.gate(&input.project_id)?.write_owned().await;
        self.admission()?;
        if let Some(generation) = service_generation {
            let instance = Self::service_id(&self.slots.borrow()[&input.project_id].registration);
            let service = areal_local_service::status(&self.home, &instance).await?;
            ensure!(
                service.identity.generation == generation && service.state == State::Stopped,
                error(
                    "scheduleResourcesChanged",
                    "original Core must be stopped before schedule resources are applied"
                )
            );
        }
        if scheduled && self.schedules.suppressed(&input.project_id) {
            return Err(error(
                "schedulingSuppressed",
                "project scheduling was stopped",
            ));
        }
        if scheduled && self.schedules.import_blocked(&input.project_id) {
            return Err(error(
                "scheduleImportUnavailable",
                "legacy scheduling import is unresolved",
            ));
        }
        if scheduled {
            self.migration.assert_scheduling_available(
                &self.slots.borrow()[&input.project_id].registration,
            )?;
        }
        self.check_pending(&input.project_id, &input.request_id)
            .await?;
        let (digest, previous) = self.accepted(
            &input.request_id,
            "project.ensure",
            input,
            &input.project_id,
        )?;
        if let Some(live) = live {
            live.admitted.set(true);
        }
        self.apply_scheduling_intent(&input.request_id)?;
        Ok((guard, digest, previous))
    }
    async fn finish_ensure(&self, input: &Ensure, scheduled: bool, digest: &str) -> Result<Value> {
        let result = self.ensure_inner(input).await;
        if result.is_err() {
            self.slots
                .borrow_mut()
                .get_mut(&input.project_id)
                .unwrap()
                .state = "unavailable".into();
        }
        let result = self.finish_mutation(&input.request_id, digest, result);
        if !scheduled && input.launch_inputs.is_some() {
            self.schedules.wake.notify_one();
        }
        result
    }
    fn begin_project_activation(
        &self,
        project: &str,
        fingerprint: &str,
        current: Option<&Service>,
        model_catalog_managed: bool,
    ) {
        {
            let mut slots = self.slots.borrow_mut();
            let slot = slots.get_mut(project).unwrap();
            // 重复确认同一已运行服务不能撤销它的共享连接；实际启动和配置变化仍进入 starting。
            let reusing_ready = current.is_some_and(|service| {
                service.state == State::Ready
                    && service.owner.as_ref() == Some(&self.owner())
                    && service.identity.config_fingerprint == fingerprint
                    && slot.state == "ready"
                    && !slot.uncertain_start
                    && slot.writer.is_some()
                    && slot.service.as_ref().is_some_and(|previous| {
                        previous.identity == service.identity && previous.owner == service.owner
                    })
            });
            // 托管模型的同配置复用不会进入模型热更新超时重启；真正启动仍在 before_launch 设置围栏。
            slot.uncertain_start = !reusing_ready || !model_catalog_managed;
            if !reusing_ready {
                slot.idle.reset();
                slot.state = "starting".into();
            }
        }
        self.changed();
    }
    async fn ensure_inner(&self, input: &Ensure) -> Result<Value> {
        if self.migration.unpublished_reserved(&input.project_id)? {
            return Err(error(
                "migrationBlocked",
                "project is reserved by an unpublished GUI import",
            ));
        }
        let registration = self.slots.borrow()[&input.project_id].registration.clone();
        crate::space::validate_workspace(&self.home, &registration.workspace)?;
        let saved_path = self
            .home
            .join("host/launch")
            .join(storage::digest(input.project_id.as_bytes()))
            .join("inputs.json");
        let (mut inputs, using_saved_inputs) = match &input.launch_inputs {
            Some(v) => (v.clone(), false),
            None => match storage::read_optional(&saved_path)? {
                Some(inputs) => (inputs, true),
                None => (
                    gui_project::missing_inputs(self, &registration).await?,
                    false,
                ),
            },
        };
        let uses_shared_host_config = self.uses_shared_host_config(&inputs);
        if uses_shared_host_config && self.home.join("config.toml").exists() {
            let (config, _) = areal_config::load_service_config(&areal_config::ConfigInputs {
                cwd: inputs.cwd.clone(),
                homedir: inputs.homedir.clone(),
                config_file: Some(self.home.join("config.toml")),
                overrides: areal_config::ConfigOverrides {
                    data_dir: Some(registration.data_dir.clone()),
                    ..Default::default()
                },
                ..Default::default()
            })?;
            for name in config.model.api_key_env.iter().chain(
                config
                    .model_catalog
                    .iter()
                    .filter_map(|provider| provider.api_key_env.as_ref()),
            ) {
                if name.starts_with("AREAL_CREDENTIAL_") && !inputs.credential_names.contains(name)
                {
                    inputs.credential_names.push(name.clone());
                }
            }
        } else if matches!(registration.source, crate::ProjectSource::Gui { .. }) {
            let mut cfg_inputs = launch::config_inputs(&self.home, &inputs, &BTreeMap::new());
            cfg_inputs.overrides.data_dir = Some(registration.data_dir.clone());
            if let Ok((config, _)) = areal_config::load_service_config(&cfg_inputs) {
                for name in config.model.api_key_env.iter().chain(
                    config
                        .model_catalog
                        .iter()
                        .filter_map(|provider| provider.api_key_env.as_ref()),
                ) {
                    if name.starts_with("AREAL_CREDENTIAL_")
                        && !inputs.credential_names.contains(name)
                    {
                        inputs.credential_names.push(name.clone());
                    }
                }
            }
        }
        let credential_source = self
            .migration
            .shared_credential_source(&registration, uses_shared_host_config)?;
        if let crate::ProjectSource::Gui { .. } = registration.source
            && let Some(source) = &credential_source
        {
            let network = self.gateway.workbench.model_network(self, source).await?;
            crate::network::apply_model_proxy(network, &mut inputs.environment);
        }
        let environment_credentials = self.gateway.workbench.project_environment_credentials(
            &registration,
            credential_source.as_deref(),
            &mut inputs.credential_names,
        );
        if let Some(source) = &credential_source
            && self.migration.vault.subscription_owner(source)?.is_some()
            && !inputs
                .credential_names
                .iter()
                .any(|name| name == "AREAL_CREDENTIAL_areal_openai")
        {
            inputs
                .credential_names
                .push("AREAL_CREDENTIAL_areal_openai".into());
        }
        launch::validate(&inputs, &registration)?;
        ensure!(
            input
                .credentials
                .keys()
                .all(|k| inputs.credential_names.contains(k)),
            "invalidRequest: credentials must be named by launch inputs"
        );

        let mut deferred_credentials = BTreeSet::new();
        let mut imported_credentials = BTreeMap::new();
        let mut pending_credentials = Vec::new();
        for name in &inputs.credential_names {
            if let Some(source) = &credential_source
                && name.starts_with("AREAL_CREDENTIAL_")
            {
                let credential_slot = if name == "AREAL_CREDENTIAL_areal_openai" {
                    crate::vault::Slot::SubscriptionTransport {
                        source_id: source.clone(),
                    }
                } else {
                    crate::vault::Slot::ProviderCredential {
                        source_id: source.clone(),
                        reference: name.clone(),
                    }
                };
                if self.migration.vault.slot_in_flight(&credential_slot) {
                    deferred_credentials.insert(name.clone());
                    continue;
                }
                pending_credentials.push((source.clone(), name.clone()));
            }
        }
        // 多服务凭证并发读取，避免冷启动时受串行 Keychain 往返累加拖慢。
        let credential_results =
            futures_util::future::join_all(pending_credentials.into_iter().map(
                |(source, name)| async move {
                    let outcome = self
                        .migration
                        .credential_for_source_async(&source, &name)
                        .await;
                    (name, outcome)
                },
            ))
            .await;
        for (name, outcome) in credential_results {
            let credential = match outcome {
                Ok(value) => value,
                Err(cause)
                    if cause
                        .downcast_ref::<wire::Error>()
                        .is_some_and(|error| error.code == "migrationPending") =>
                {
                    deferred_credentials.insert(name);
                    continue;
                }
                Err(cause)
                    if cause.downcast_ref::<wire::Error>().is_some_and(|error| {
                        matches!(
                            error.code,
                            "storageLocked" | "storageMissing" | "storageAuthorizationRequired"
                        )
                    }) =>
                {
                    eprintln!("Host project credential unavailable: {cause}");
                    None
                }
                Err(cause) => return Err(cause),
            };
            imported_credentials.insert(name, credential);
        }
        for (name, value) in environment_credentials {
            imported_credentials.insert(name, Some(value));
        }
        let credentials = {
            let mut slots = self.slots.borrow_mut();
            let slot = slots.get_mut(&input.project_id).unwrap();
            for name in std::mem::take(&mut slot.imported_credentials) {
                if deferred_credentials.contains(&name) {
                    slot.imported_credentials.insert(name);
                } else {
                    slot.credentials.remove(&name);
                }
            }
            slot.credentials.extend(
                input
                    .credentials
                    .iter()
                    .filter(|(name, _)| !deferred_credentials.contains(*name))
                    .map(|(name, value)| (name.clone(), value.clone())),
            );
            for (name, value) in imported_credentials {
                if let Some(value) = value {
                    slot.imported_credentials.insert(name.clone());
                    slot.credentials.insert(name, value);
                } else {
                    slot.credentials.remove(&name);
                }
            }
            slot.credentials
                .iter()
                .filter(|(name, _)| !deferred_credentials.contains(*name))
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect()
        };
        // 在途或迁移中凭据只从本次启动投影暂缓，历史启动不清除缓存或改写原回执。
        inputs
            .credential_names
            .retain(|name| !deferred_credentials.contains(name));
        let service_id = Self::service_id(&registration);
        let directory = storage::registry(&self.home, &service_id)?;
        let previous = storage::read_optional::<Service>(&directory.join("service.json"))?;
        let current = if previous.is_some() {
            let service = areal_local_service::status(&self.home, &service_id)
                .await
                .map_err(|cause| {
                    error(
                        "migrationBlocked",
                        format!(
                            "cannot inspect existing service {service_id} before activation: {cause:#}",
                        ),
                    )
                })?;
            Some(service)
        } else {
            None
        };
        // 只给下一代 Core 使用当前网络和工具设置；继续复用运行中代际的原始启动输入。
        if using_saved_inputs
            && current
                .as_ref()
                .is_none_or(|service| service.state == State::Stopped)
        {
            gui_project::refresh_saved_configuration(self, &registration, &mut inputs).await?;
        }
        let (mut spec, _) =
            launch::prepare(&self.home, &self.bin, &registration, &inputs, &credentials)?;
        let mut journal = self
            .receipt(&input.request_id)?
            .context("missing activation receipt")?;
        journal.evidence = json!({"serviceId":spec.service_id,"fingerprint":spec.fingerprint,"owner":self.owner(),"registration":registration,"previousService":previous,"components":spec.components});
        storage::write(
            &wire::operation_path(&self.home, &input.request_id),
            &journal,
        )?;
        let mut prior_boot_activation = false;
        if let Some(previous) = current.as_ref().filter(|s| {
            s.owner.as_ref() != Some(&self.owner())
                && s.state != State::Ready
                && s.state != State::Stopping
        }) {
            match self.cleanup_proof(previous).await {
                Ok(()) => {}
                Err(cause)
                    if cause
                        .downcast_ref::<wire::Error>()
                        .is_some_and(|e| e.code == "migrationBlocked")
                        && previous.state == State::Stopped
                        && matches!(previous.owner, Some(Owner::Host { .. })) =>
                {
                    prior_boot_activation = true;
                }
                Err(cause) => return Err(cause),
            }
        }
        if let Some(service) = current
            .as_ref()
            .filter(|s| s.state == State::Ready || s.state == State::Stopping)
        {
            if service.owner.is_none() {
                let migration_id = uuid::Uuid::new_v4().to_string();
                let migration = json!({"serviceId":service.identity.service_id,"generation":service.identity.generation,"phase":"draining","requestId":migration_id});
                {
                    let mut slots = self.slots.borrow_mut();
                    let slot = slots.get_mut(&input.project_id).unwrap();
                    slot.migration = Some(migration.clone());
                    slot.service = Some(service.clone());
                    slot.state = "legacyPending".into();
                }
                let mut operation = self.receipt(&input.request_id)?.unwrap();
                operation.receipt["migration"] = migration;
                self.save(&input.request_id, &operation.digest, &operation.receipt)?;
                let stopped = areal_local_service::stop_operation(
                    &self.home,
                    &spec.service_id,
                    &service.identity.generation,
                    &migration_id,
                    false,
                )
                .await?;
                let stopped = self
                    .wait_stop(
                        &spec.service_id,
                        &service.identity.generation,
                        &migration_id,
                        stopped,
                    )
                    .await?;
                let phase = if stopped.state == StopOperationState::Blocked {
                    "legacyPending"
                } else if stopped.state == StopOperationState::Completed {
                    "oldStopped"
                } else {
                    "draining"
                };
                self.slots
                    .borrow_mut()
                    .get_mut(&input.project_id)
                    .unwrap()
                    .migration
                    .as_mut()
                    .unwrap()["phase"] = json!(phase);
                let mut journal = self.receipt(&input.request_id)?.unwrap();
                journal.receipt["migration"]["phase"] = json!(phase);
                journal.receipt["migration"]["receipt"] = serde_json::to_value(&stopped)?;
                self.save(&input.request_id, &journal.digest, &journal.receipt)?;
                if stopped.state != StopOperationState::Completed {
                    let slots = self.slots.borrow();
                    let slot = &slots[&input.project_id];
                    return Ok(serde_json::to_value(OpenResult {
                        project: ProjectStatus {
                            uses_shared_model_config: uses_shared_host_config,
                            schedule_activation_suppressed: self
                                .schedules
                                .suppressed(&input.project_id),
                            schedule_activation_error: self.schedules.error(&input.project_id),
                            registration: registration.clone(),
                            state: "legacyPending".into(),
                            service: None,
                            migration: slot.migration.clone(),
                        },
                        service: None,
                    })?);
                }
            } else if service.owner.as_ref() != Some(&self.owner()) {
                return Err(error(
                    "migrationBlocked",
                    "previous lifecycle owner has not completed cleanup",
                ));
            }
        }
        spec.owner = Some(self.owner());
        self.begin_project_activation(
            &input.project_id,
            &spec.fingerprint,
            current.as_ref(),
            spec.model_catalog_managed,
        );
        let lifetime = {
            let mut slots = self.slots.borrow_mut();
            let slot = slots.get_mut(&input.project_id).unwrap();
            if let Some(lifetime) = &slot.lifetime {
                lifetime.clone()
            } else {
                let (writer, lifetime) = OwnerLifetime::pair()?;
                let lifetime = Rc::new(lifetime);
                slot.writer = Some(writer);
                slot.lifetime = Some(lifetime.clone());
                lifetime
            }
        };
        let activation_checked = std::cell::Cell::new(false);
        let before_launch = || -> Result<()> {
            self.slots
                .borrow_mut()
                .get_mut(&input.project_id)
                .unwrap()
                .uncertain_start = true;
            if !prior_boot_activation {
                activation_checked.set(true);
                return Ok(());
            }
            let previous = previous
                .as_ref()
                .context("missing original service descriptor")?;
            crate::migration::prior_boot::host_activation(
                &self.home,
                &registration,
                previous,
                &self.owner(),
                |proof| {
                    let mut record = self
                        .receipt(&input.request_id)?
                        .context("missing activation receipt")?;
                    record.evidence["priorBootAdoption"] = proof;
                    record.evidence["scheduleActivationSuppressed"] = json!(true);
                    record.evidence["schedulingIntentPending"] = json!(true);
                    storage::write(
                        &wire::operation_path(&self.home, &input.request_id),
                        &record,
                    )?;
                    self.apply_scheduling_intent(&input.request_id)
                },
            )
            .map_err(|cause| {
                error(
                    "migrationBlocked",
                    format!("prior-boot activation is unconfirmed: {cause:#}"),
                )
            })?;
            activation_checked.set(true);
            Ok(())
        };
        let result = areal_local_service::ensure_with_lifetime_checked(
            &spec,
            &lifetime,
            input.no_auto_restart,
            &before_launch,
        )
        .await;
        if !activation_checked.get()
            && current
                .as_ref()
                .is_none_or(|previous| previous.state != State::Ready)
        {
            // 启动前校验在任何进程停止或启动之前拒绝；不能把确定拒绝变为 UNKNOWN。
            self.slots
                .borrow_mut()
                .get_mut(&input.project_id)
                .unwrap()
                .uncertain_start = false;
        }
        if result.is_err()
            && let Ok(service) = areal_local_service::status(&self.home, &spec.service_id).await
        {
            let mut slots = self.slots.borrow_mut();
            let slot = slots.get_mut(&input.project_id).unwrap();
            if service.state == State::Ready
                && slot
                    .service
                    .as_ref()
                    .is_some_and(|previous| previous.identity == service.identity)
            {
                slot.uncertain_start = false;
            }
        }
        let service = result?;
        ensure!(
            service.owner.as_ref() == Some(&self.owner()),
            "invalid Host owner after launch"
        );
        let project = ProjectStatus {
            uses_shared_model_config: uses_shared_host_config,
            schedule_activation_suppressed: self.schedules.suppressed(&input.project_id),
            schedule_activation_error: self.schedules.error(&input.project_id),
            registration,
            state: "ready".into(),
            service: Some(service.clone()),
            migration: None,
        };
        {
            let mut slots = self.slots.borrow_mut();
            let slot = slots.get_mut(&input.project_id).unwrap();
            slot.service = Some(service.clone());
            slot.state = "ready".into();
            slot.uncertain_start = false;
            slot.migration = None;
        }
        Ok(serde_json::to_value(OpenResult {
            project,
            service: Some(service),
        })?)
    }
    async fn cleanup_proof(&self, service: &Service) -> Result<()> {
        ensure!(
            service.state == State::Stopped,
            "migrationBlocked: original generation still holds lifecycle locks"
        );
        let directory = storage::registry(&self.home, &service.identity.service_id)?;
        if let Some(proof) =
            storage::read_optional::<storage::CleanupReceipt>(&directory.join("cleanup.json"))?
            && proof.version == VERSION
            && proof.identity == service.identity
            && proof.owner == service.owner
            && proof.cleanup_confirmed
        {
            return Ok(());
        }
        if let Some(proof) =
            storage::read_optional::<storage::CrashReceipt>(&directory.join("crash.json"))?
            && proof.identity == service.identity
            && proof.cleanup_confirmed
        {
            return Ok(());
        }
        for path in storage::json_records(&directory.join("operations"), false)? {
            let receipt: storage::StopReceipt = storage::read(&path)?;
            if receipt.service.identity == service.identity
                && receipt.cleanup_confirmed
                && let Some(operation) = areal_local_service::operation(
                    &self.home,
                    &service.identity.service_id,
                    &service.identity.generation,
                    &receipt.operation.request_id,
                )
                .await?
                && operation.state == StopOperationState::Completed
            {
                return Ok(());
            }
        }
        Err(error(
            "migrationBlocked",
            "original generation has no confirmed Runtime cleanup receipt",
        ))
    }
    async fn find_pending_blocker(&self, project_id: &str, current: &str) -> Result<Option<Value>> {
        for path in storage::json_records(&self.home.join("host/operations"), false)? {
            let record: Operation = storage::read(&path)?;
            if record.receipt["requestId"] != current
                && record.receipt["projects"]
                    .as_array()
                    .is_some_and(|targets| {
                        targets.iter().any(|target| {
                            target["projectId"] == project_id
                                && !ReceiptState::settled(ReceiptState::of(&target["receipt"]))
                        })
                    })
            {
                return Ok(Some(json!({
                    "projectId": project_id,
                    "requestId": record.receipt["requestId"],
                    "state": record.receipt["state"],
                    "reason": "an earlier Host stop target must be reconciled before changing project lifecycle",
                })));
            }
            if record.receipt["requestId"] == current || record.receipt["projectId"] != project_id {
                continue;
            }
            if matches!(
                ReceiptState::of(&record.receipt),
                Some(
                    ReceiptState::AcceptedPending
                        | ReceiptState::AdmissionUnknown
                        | ReceiptState::SettlementIncomplete
                )
            ) {
                return Ok(Some(json!({
                    "projectId": project_id,
                    "requestId": record.receipt["requestId"],
                    "state": record.receipt["state"],
                    "serviceId": record.receipt["serviceId"],
                    "serviceGeneration": record.receipt["serviceGeneration"],
                    "reason": "an earlier project operation must be reconciled before activation",
                })));
            }
            if let Some(migration) = record.receipt.get("migration")
                && migration["phase"] == "draining"
            {
                return Ok(Some(json!({
                    "projectId": project_id,
                    "requestId": record.receipt["requestId"],
                    "state": "draining",
                    "reason": "legacy drain must be reconciled before activation",
                })));
            }
        }
        Ok(None)
    }
    /// 在调用方已持有该项目 gate 写锁的前提下，核对旧单项目停止回执是否已有权威服务回执。
    async fn reconcile_pending_blockers_locked(
        &self,
        project_id: &str,
        current: &str,
    ) -> Result<()> {
        for path in storage::json_records(&self.home.join("host/operations"), false)? {
            let mut record: Operation = storage::read(&path)?;
            if record.receipt["requestId"] == current
                || record.receipt["projectId"] != project_id
                || record.receipt["projects"].is_array()
            {
                continue;
            }
            if !matches!(
                ReceiptState::of(&record.receipt),
                Some(
                    ReceiptState::AcceptedPending
                        | ReceiptState::AdmissionUnknown
                        | ReceiptState::SettlementIncomplete
                )
            ) {
                continue;
            }
            let (Some(req_id), Some(instance), Some(generation)) = (
                record.receipt["requestId"].as_str().map(str::to_owned),
                record.receipt["serviceId"].as_str().map(str::to_owned),
                record.receipt["serviceGeneration"]
                    .as_str()
                    .map(str::to_owned),
            ) else {
                continue;
            };
            let Ok(strategy) =
                serde_json::from_value::<StopStrategy>(record.receipt["strategy"].clone())
            else {
                continue;
            };
            if let Some(op) =
                areal_local_service::operation(&self.home, &instance, &generation, &req_id).await?
                && op.request_id == req_id
                && op.service_id == instance
                && op.generation == generation
                && op.cancel == strategy.cancel()
            {
                record.receipt = stop_receipt(project_id, strategy, &op);
                self.save(&req_id, &record.digest, &record.receipt)?;
            }
        }
        Ok(())
    }
    async fn check_pending(&self, project_id: &str, current: &str) -> Result<()> {
        if let Some(blocker) = self.find_pending_blocker(project_id, current).await? {
            let reason = blocker["reason"]
                .as_str()
                .unwrap_or("an earlier project operation must be reconciled before activation");
            let req = blocker["requestId"].as_str().unwrap_or("unknown");
            return Err(error(
                "admissionUnknown",
                format!("{reason} (project {project_id}, requestId {req})"),
            ));
        }
        Ok(())
    }
    async fn wait_stop(
        &self,
        id: &str,
        generation: &str,
        request: &str,
        mut operation: StopOperation,
    ) -> Result<StopOperation> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(70);
        while operation.state == StopOperationState::AcceptedPending
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if let Some(current) =
                areal_local_service::operation(&self.home, id, generation, request).await?
            {
                operation = current;
            }
        }
        Ok(operation)
    }
    async fn stop_target(
        &self,
        project_id: &str,
        service: &Service,
        request_id: &str,
        strategy: StopStrategy,
    ) -> Value {
        self.slots.borrow_mut().get_mut(project_id).unwrap().state = "stopping".into();
        self.changed();
        self.schedules.connections.changed.notify_waiters();
        let operation = areal_local_service::stop_operation(
            &self.home,
            &service.identity.service_id,
            &service.identity.generation,
            request_id,
            strategy.cancel(),
        )
        .await;
        let operation = match operation {
            Ok(op) => {
                self.wait_stop(
                    &service.identity.service_id,
                    &service.identity.generation,
                    request_id,
                    op,
                )
                .await
            }
            Err(e) => Err(e),
        };
        let receipt = match operation {
            Ok(op) => stop_receipt(project_id, strategy, &op),
            Err(err) if areal_local_service::is_stop_not_dispatched(&err) => {
                json!({"version":VERSION,"requestId":request_id,"projectId":project_id,"serviceId":service.identity.service_id,"serviceGeneration":service.identity.generation,"strategy":strategy,"state":"blocked","message":format!("{err:#}")})
            }
            Err(_) => {
                json!({"version":VERSION,"requestId":request_id,"projectId":project_id,"serviceId":service.identity.service_id,"serviceGeneration":service.identity.generation,"strategy":strategy,"state":"admissionUnknown","message":"Read the original operation to reconcile admission"})
            }
        };
        if ReceiptState::is(&receipt, ReceiptState::Blocked) {
            self.slots.borrow_mut().get_mut(project_id).unwrap().state = "ready".into();
        }
        if ReceiptState::is(&receipt, ReceiptState::Completed) {
            let mut slots = self.slots.borrow_mut();
            let slot = slots.get_mut(project_id).unwrap();
            slot.writer = None;
            slot.lifetime = None;
            slot.state = "stopped".into();
            slot.service = None;
        }
        self.changed();
        self.schedules.connections.changed.notify_waiters();
        receipt
    }
    async fn stop_project(&self, input: Stop) -> Result<Value> {
        self.generation(&input.expected_generation)?;
        let id = input
            .project_id
            .as_deref()
            .ok_or_else(|| error("invalidRequest", "projectId required"))?;
        let gate = self.gate(id)?;
        let _guard = gate.write().await;
        if self.receipt(&input.request_id)?.is_some() {
            self.accepted(&input.request_id, "project.stop", &input, id)?;
            self.apply_scheduling_intent(&input.request_id)?;
            drop(_guard);
            return self
                .reconcile(&input.request_id)
                .await?
                .context("missing operation");
        }
        self.admission()?;
        self.reconcile_pending_blockers_locked(id, &input.request_id)
            .await?;
        self.check_pending(id, &input.request_id).await?;
        let instance = Self::service_id(&self.slots.borrow()[id].registration);
        let service = areal_local_service::status(&self.home, &instance).await?;
        if input.service_generation.as_deref() != Some(&service.identity.generation) {
            return Err(error("generationMismatch", "service generation changed"));
        }
        self.admission()?;
        let _live_idle_stop = (matches!(input.strategy, StopStrategy::IfIdle)
            && !input.suppress_scheduling)
            .then(|| {
                self.install_live_idle_stop(id, &input.request_id, &service.identity.generation)
            })
            .flatten();
        let already_stopped = !input.suppress_scheduling
            && service.state == State::Stopped
            && areal_local_service::operation(
                &self.home,
                &service.identity.service_id,
                &service.identity.generation,
                &input.request_id,
            )
            .await?
            .is_none();
        if already_stopped {
            self.cleanup_proof(&service).await?;
        }
        let (digest, _) = self.accepted(&input.request_id, "project.stop", &input, id)?;
        self.apply_scheduling_intent(&input.request_id)?;
        let pending = json!({"version":VERSION,"requestId":input.request_id,"projectId":id,"serviceId":service.identity.service_id,"serviceGeneration":service.identity.generation,"strategy":input.strategy,"state":"acceptedPending"});
        self.save(&input.request_id, &digest, &pending)?;
        let receipt = if already_stopped {
            let mut slots = self.slots.borrow_mut();
            let slot = slots.get_mut(id).unwrap();
            slot.writer = None;
            slot.lifetime = None;
            slot.service = None;
            slot.state = "stopped".into();
            json!({"version":VERSION,"requestId":input.request_id,"projectId":id,"serviceId":service.identity.service_id,"serviceGeneration":service.identity.generation,"strategy":input.strategy,"state":"completed"})
        } else {
            self.stop_target(id, &service, &input.request_id, input.strategy)
                .await
        };
        self.save(&input.request_id, &digest, &receipt)?;
        Ok(receipt)
    }
    async fn stop_host(&self, input: Stop) -> Result<Value> {
        let _host_guard = self.host_stop_gate.lock().await;
        self.generation(&input.expected_generation)?;
        ensure!(
            self.reserved_update_stop()?
                .is_none_or(|id| id == input.request_id),
            error(
                "stopInProgress",
                "reconcile the original controlled update before a new stop"
            )
        );
        if input.project_id.is_some() || input.service_generation.is_some() {
            return Err(error(
                "invalidRequest",
                "host.stop does not accept project identity",
            ));
        }
        if self.receipt(&input.request_id)?.is_some() {
            self.accepted(&input.request_id, "host.stop", &input, "")?;
            drop(_host_guard);
            return self
                .reconcile(&input.request_id)
                .await?
                .context("missing stop operation");
        }
        self.stop_host_new(input).await
    }
    async fn stop_host_new(&self, input: Stop) -> Result<Value> {
        if let Some(existing) = self.stop.borrow().as_ref() {
            if !matches!(
                ReceiptState::of(existing),
                Some(
                    ReceiptState::Blocked
                        | ReceiptState::Partial
                        | ReceiptState::SettlementIncomplete
                )
            ) {
                return Err(error(
                    "stopInProgress",
                    "reconcile existing stop before new intent",
                ));
            }
            if existing["projects"].as_array().is_some_and(|targets| {
                targets.iter().any(|t| {
                    matches!(
                        ReceiptState::of(&t["receipt"]),
                        Some(ReceiptState::AdmissionUnknown | ReceiptState::AcceptedPending)
                    )
                })
            }) {
                return Err(error(
                    "stopInProgress",
                    "previous target admission is unresolved",
                ));
            }
        }
        let projects: Vec<_> = self.slots.borrow().keys().cloned().collect();
        for id in &projects {
            if self
                .find_pending_blocker(id, &input.request_id)
                .await?
                .is_some()
            {
                // 活跃的激活操作也先记 pending；等原操作释放锁后再区分完成与遗留 UNKNOWN。
                let _guard = self.gate(id)?.write_owned().await;
                self.reconcile_pending_blockers_locked(id, &input.request_id)
                    .await?;
                self.check_pending(id, &input.request_id).await?;
            }
        }
        let (digest, _) = self.accepted(&input.request_id, "host.stop", &input, "")?;
        let mut receipt = json!({"version":VERSION,"requestId":input.request_id,"hostId":self.identity.host_id,"generation":self.identity.generation,"strategy":input.strategy,"state":"acceptedPending","projects":[],"localRelay":{"state":"acceptedPending"}});
        receipt["preparationPending"] = json!(true);
        self.save_host_stop(&input.request_id, &digest, &receipt)?;
        *self.stop.borrow_mut() = Some(receipt.clone());
        self.gateway.local_relay.quiesce(true);
        self.changed();
        let ids: Vec<_> = self.slots.borrow().keys().cloned().collect();
        let mut guards = Vec::new();
        for id in &ids {
            eprintln!("Host stop preparation: acquiring project gate {id}");
            guards.push(self.gate(id)?.write_owned().await);
        }
        eprintln!("Host stop preparation: project gates acquired");
        for id in &ids {
            self.reconcile_pending_blockers_locked(id, &input.request_id)
                .await?;
            self.check_pending(id, &input.request_id).await?;
        }
        let mut services = Vec::new();
        for id in ids {
            eprintln!("Host stop preparation: reading service {id}");
            let instance = Self::service_id(&self.slots.borrow()[&id].registration);
            let service = match areal_local_service::status(&self.home, &instance).await {
                Ok(service) => Some(service),
                Err(_) => storage::read_optional::<Service>(
                    &storage::registry(&self.home, &instance)?.join("service.json"),
                )?,
            };
            eprintln!("Host stop preparation: service read {id}");
            if let Some(service) = service {
                if service.state != State::Stopped || self.cleanup_proof(&service).await.is_err() {
                    receipt["projects"].as_array_mut().unwrap().push(json!({"projectId":id,"serviceId":instance,"serviceGeneration":service.identity.generation,"requestId":uuid::Uuid::new_v4().to_string(),"dispatch":"notStarted"}));
                    services.push(service);
                }
            } else if self.slots.borrow()[&id].writer.is_some() {
                receipt["state"] = json!(ReceiptState::SettlementIncomplete);
                self.save_host_stop(&input.request_id, &digest, &receipt)?;
                return Ok(receipt);
            }
        }
        receipt
            .as_object_mut()
            .unwrap()
            .remove("preparationPending");
        self.save_host_stop(&input.request_id, &digest, &receipt)?;
        for (i, service) in services.iter().enumerate() {
            receipt["projects"][i]["dispatch"] = json!("started");
            self.save_host_stop(&input.request_id, &digest, &receipt)?;
            let id = receipt["projects"][i]["projectId"]
                .as_str()
                .unwrap()
                .to_owned();
            let request = receipt["projects"][i]["requestId"]
                .as_str()
                .unwrap()
                .to_owned();
            receipt["projects"][i]["receipt"] = self
                .stop_target(&id, service, &request, input.strategy)
                .await;
            receipt["state"] = json!(aggregate(&receipt));
            self.save_host_stop(&input.request_id, &digest, &receipt)?;
        }
        self.settle_local_relay(&mut receipt).await;
        receipt["state"] = json!(aggregate(&receipt));
        self.save_host_stop(&input.request_id, &digest, &receipt)?;
        Ok(receipt)
    }
    async fn settle_local_relay(&self, receipt: &mut Value) {
        if receipt.get("localRelay").is_none()
            || ReceiptState::is(&receipt["localRelay"], ReceiptState::Completed)
        {
            return;
        }
        if receipt["hostId"] != self.identity.host_id
            || receipt["generation"] != self.identity.generation
        {
            receipt["localRelay"]["state"] = json!(ReceiptState::SettlementIncomplete);
            return;
        }
        if !receipt["projects"].as_array().is_some_and(|targets| {
            targets
                .iter()
                .all(|target| ReceiptState::is(&target["receipt"], ReceiptState::Completed))
        }) {
            return;
        }
        receipt["localRelay"]["state"] = json!(if self.gateway.local_relay.stop().await.is_ok() {
            "completed"
        } else {
            "settlementIncomplete"
        });
    }
    fn save_host_stop(&self, id: &str, digest: &str, receipt: &Value) -> Result<()> {
        self.save(id, digest, receipt)?;
        storage::write(&self.home.join("host/stop.json"), receipt)?;
        *self.stop.borrow_mut() = (!settled_refusal(receipt)).then(|| receipt.clone());
        self.gateway.local_relay.quiesce(!settled_refusal(receipt));
        self.changed();
        Ok(())
    }
    async fn reconcile(&self, id: &str) -> Result<Option<Value>> {
        if self
            .receipt(id)?
            .is_some_and(|r| r.receipt["method"] == "recovery.importProvider")
        {
            return self.reconcile_provider_import(id);
        }
        let Some(mut record) = self.receipt(id)? else {
            return Ok(None);
        };
        if record.receipt["preparationInterrupted"] == true && settled_refusal(&record.receipt) {
            return Ok(Some(record.receipt));
        }
        let _host_guard =
            if record.receipt["projects"].is_array() || record.receipt["method"] == "host.stop" {
                match self.host_stop_gate.try_lock() {
                    Ok(guard) => Some(guard),
                    Err(_) => return Ok(Some(record.receipt)),
                }
            } else {
                None
            };
        if record.receipt["preparationPending"] == true {
            // 已获得原停止锁且尚未派发任何目标，原准备已中断；拒绝原请求，不重放停止。
            let strategy = record.receipt["strategy"].clone();
            for target in record.receipt["projects"].as_array_mut().unwrap() {
                ensure!(
                    target["dispatch"] == "notStarted",
                    "stop preparation contains a dispatched target"
                );
                target["receipt"] = json!({"version":VERSION,"requestId":target["requestId"],"projectId":target["projectId"],"serviceId":target["serviceId"],"serviceGeneration":target["serviceGeneration"],"strategy":strategy,"state":"blocked"});
            }
            record.receipt["state"] = json!(ReceiptState::Blocked);
            record.receipt["preparationInterrupted"] = json!(true);
            record
                .receipt
                .as_object_mut()
                .unwrap()
                .remove("preparationPending");
            let current = self
                .stop
                .borrow()
                .as_ref()
                .is_some_and(|stop| stop["requestId"] == id);
            if current {
                self.save_host_stop(id, &record.digest, &record.receipt)?;
            } else {
                self.save(id, &record.digest, &record.receipt)?;
            }
            return Ok(Some(record.receipt));
        }
        let project_ids: std::collections::BTreeSet<_> = record.receipt["projectId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .into_iter()
            .chain(
                record.receipt["projects"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|target| target["projectId"].as_str()),
            )
            .map(str::to_owned)
            .collect();
        let mut guards = Vec::new();
        let mut observations = Vec::new();
        for project_id in project_ids {
            if let Ok(gate) = self.gate(&project_id) {
                // 激活回执只核对已发布状态与清理证明，与普通状态读者共享；
                // 真正的激活或停止仍持写锁，未退出时不能提前结算。
                if record.receipt["method"] == "project.ensure" {
                    match gate.try_read_owned() {
                        Ok(guard) => observations.push(guard),
                        Err(_) => return Ok(Some(record.receipt)),
                    }
                } else {
                    match gate.try_write_owned() {
                        Ok(guard) => guards.push(guard),
                        Err(_) => return Ok(Some(record.receipt)),
                    }
                }
            }
        }
        if matches!(
            ReceiptState::of(&record.receipt),
            Some(ReceiptState::AcceptedPending | ReceiptState::AdmissionUnknown)
        ) {
            if record.receipt["method"] == "projects.register" {
                if let Some(expected) = record.evidence.get("registration") {
                    let expected: ProjectRegistration = serde_json::from_value(expected.clone())?;
                    let binding_confirmed = if record.evidence["bindExisting"] == true {
                        let mapping = self.home.join("workspaces").join(format!(
                            "{}.json",
                            storage::digest(expected.workspace.as_os_str().as_encoded_bytes())
                        ));
                        storage::read_optional::<PathBuf>(&mapping)?.as_ref()
                            == Some(&expected.data_dir)
                            && storage::read_optional::<PathBuf>(
                                &expected.data_dir.join("service-workspace"),
                            )?
                            .as_ref()
                                == Some(&expected.workspace)
                    } else {
                        true
                    };
                    if binding_confirmed
                        && storage::read_optional::<ProjectRegistration>(
                            &self.record_path(&expected.project_id),
                        )?
                        .as_ref()
                            == Some(&expected)
                    {
                        record.receipt["state"] = json!(ReceiptState::Completed);
                        record.receipt["result"] =
                            json!({"registration":expected,"created":record.evidence["created"]});
                        self.save(id, &record.digest, &record.receipt)?;
                    }
                }
            } else if record.receipt["method"] == "project.ensure"
                && let Some(instance) = record.evidence["serviceId"].as_str()
                && let Ok(service) = areal_local_service::status(&self.home, instance).await
            {
                let expected_owner: Owner =
                    serde_json::from_value(record.evidence["owner"].clone())?;
                let registration: ProjectRegistration =
                    serde_json::from_value(record.evidence["registration"].clone())?;
                if service.owner.as_ref() == Some(&expected_owner)
                    && service.identity.workspace == registration.workspace
                    && service.identity.data_dir == registration.data_dir
                {
                    let previous: Option<Service> = record
                        .evidence
                        .get("previousService")
                        .cloned()
                        .map(serde_json::from_value)
                        .transpose()?
                        .flatten();
                    let fingerprint_matches = service.identity.config_fingerprint
                        == record.evidence["fingerprint"].as_str().unwrap_or("");
                    let new_generation = fingerprint_matches
                        && record.evidence.get("previousService").is_some()
                        && previous.as_ref().is_none_or(|old| {
                            old.identity.generation != service.identity.generation
                        });
                    let previous_ready = previous.as_ref().is_some_and(|old| {
                        old.state == State::Ready
                            && old.identity == service.identity
                            && old.owner == service.owner
                    });
                    let configuration_matches = record.evidence.get("components").is_some()
                        && storage::read_optional::<Value>(
                            &storage::registry(&self.home, instance)?.join("components.json"),
                        )?
                        .as_ref()
                            == record.evidence.get("components");
                    if service.state == State::Ready
                        && fingerprint_matches
                        && configuration_matches
                        && (new_generation || previous_ready)
                    {
                        record.receipt["state"] = json!(ReceiptState::Completed);
                        record.receipt["result"] = serde_json::to_value(OpenResult {
                            project: ProjectStatus {
                                uses_shared_model_config: self
                                    .project_uses_shared_config(&registration),
                                schedule_activation_suppressed: self
                                    .schedules
                                    .suppressed(&registration.project_id),
                                schedule_activation_error: self
                                    .schedules
                                    .error(&registration.project_id),
                                registration,
                                state: "ready".into(),
                                service: Some(service.clone()),
                                migration: None,
                            },
                            service: Some(service),
                        })?;
                        self.save(id, &record.digest, &record.receipt)?;
                    } else if service.state == State::Stopped
                        && (new_generation || previous_ready)
                        && self.cleanup_proof(&service).await.is_ok()
                    {
                        record.receipt["state"] = json!(ReceiptState::Blocked);
                        record.receipt["error"] = json!({"code":"activationInterrupted","message":"Original generation cleanup is confirmed; explicit activation may start a new request"});
                        self.save(id, &record.digest, &record.receipt)?;
                    }
                }
            }
        }
        if let Some(migration) = record.receipt.get("migration").cloned()
            && migration["phase"] == "draining"
            && let Some(operation) = areal_local_service::operation(
                &self.home,
                migration["serviceId"]
                    .as_str()
                    .context("migration serviceId")?,
                migration["generation"]
                    .as_str()
                    .context("migration generation")?,
                migration["requestId"]
                    .as_str()
                    .context("migration requestId")?,
            )
            .await?
        {
            record.receipt["migration"]["receipt"] = serde_json::to_value(&operation)?;
            if operation.state == StopOperationState::Completed {
                record.receipt["migration"]["phase"] = json!("oldStopped");
                record.receipt["state"] = json!(ReceiptState::Blocked);
            }
            if operation.state == StopOperationState::Blocked {
                record.receipt["migration"]["phase"] = json!("legacyPending");
                record.receipt["state"] = json!(ReceiptState::Blocked);
            }
            self.save(id, &record.digest, &record.receipt)?;
        }
        if record.receipt["projects"].is_array() {
            let strategy: StopStrategy =
                serde_json::from_value(record.receipt["strategy"].clone())?;
            for target in record.receipt["projects"].as_array_mut().unwrap() {
                if target["dispatch"] == "started"
                    && !ReceiptState::is(&target["receipt"], ReceiptState::Completed)
                {
                    let operation = areal_local_service::operation(
                        &self.home,
                        target["serviceId"].as_str().unwrap(),
                        target["serviceGeneration"].as_str().unwrap(),
                        target["requestId"].as_str().unwrap(),
                    )
                    .await?;
                    if let Some(operation) = operation {
                        target["receipt"] = stop_receipt(
                            target["projectId"].as_str().unwrap(),
                            strategy,
                            &operation,
                        );
                    } else {
                        target["receipt"] = json!({"version":VERSION,"requestId":target["requestId"],"projectId":target["projectId"],"serviceId":target["serviceId"],"serviceGeneration":target["serviceGeneration"],"strategy":strategy,"state":"admissionUnknown"});
                    }
                }
            }
            self.settle_local_relay(&mut record.receipt).await;
            if record.receipt["projects"].is_array() {
                record.receipt["state"] = json!(aggregate(&record.receipt));
            }
            let current = self
                .stop
                .borrow()
                .as_ref()
                .is_some_and(|stop| stop["requestId"] == id);
            if current {
                self.save_host_stop(id, &record.digest, &record.receipt)?;
            } else {
                self.save(id, &record.digest, &record.receipt)?;
            }
        } else if let (Some(instance), Some(generation), Some(project)) = (
            record.receipt["serviceId"].as_str(),
            record.receipt["serviceGeneration"].as_str(),
            record.receipt["projectId"].as_str(),
        ) && let Some(operation) =
            areal_local_service::operation(&self.home, instance, generation, id).await?
        {
            let strategy = serde_json::from_value(record.receipt["strategy"].clone())?;
            record.receipt = stop_receipt(project, strategy, &operation);
            self.save(id, &record.digest, &record.receipt)?;
        }
        Ok(Some(record.receipt))
    }
}
fn previous_result(receipt: Value) -> Result<Value> {
    if let Some(result) = receipt.get("result") {
        return Ok(result.clone());
    }
    Err(error(
        "admissionUnknown",
        "operation has no completed result; query host.operation with the original requestId",
    ))
}
fn stop_receipt(project: &str, strategy: StopStrategy, operation: &StopOperation) -> Value {
    let mut value = json!({"version":VERSION,"requestId":operation.request_id,"projectId":project,"serviceId":operation.service_id,"serviceGeneration":operation.generation,"strategy":strategy,"state":operation.state});
    if let Some(message) = &operation.message {
        value["message"] = json!(message);
    }
    if let Some(lifecycle) = &operation.lifecycle {
        value["lifecycle"] = lifecycle.clone();
    }
    value
}
pub(crate) fn settled_refusal(receipt: &Value) -> bool {
    let Some(targets) = receipt["projects"].as_array() else {
        return false;
    };
    if ReceiptState::is(receipt, ReceiptState::Blocked)
        && receipt["preparationInterrupted"] == true
        && targets.iter().all(|target| {
            target["dispatch"] == "notStarted"
                && ReceiptState::is(&target["receipt"], ReceiptState::Blocked)
        })
    {
        return true;
    }
    matches!(
        ReceiptState::of(receipt),
        Some(ReceiptState::Blocked | ReceiptState::Partial)
    ) && targets
        .iter()
        .any(|target| ReceiptState::is(&target["receipt"], ReceiptState::Blocked))
        && targets.iter().all(|target| {
            target["dispatch"] == "started"
                && ReceiptState::settled(ReceiptState::of(&target["receipt"]))
        })
}
fn aggregate(receipt: &Value) -> ReceiptState {
    use ReceiptState::*;
    let targets: Vec<_> = receipt["projects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| ReceiptState::of(&t["receipt"]))
        .collect();
    let all_completed = targets.iter().all(|state| *state == Some(Completed));
    if all_completed && let Some(relay) = receipt.get("localRelay") {
        return match ReceiptState::of(relay) {
            Some(Completed) => Completed,
            Some(SettlementIncomplete) => SettlementIncomplete,
            _ => AcceptedPending,
        };
    }
    if all_completed {
        return Completed;
    }
    if targets.contains(&Some(Completed)) {
        return Partial;
    }
    [
        AdmissionUnknown,
        SettlementIncomplete,
        AcceptedPending,
        Blocked,
    ]
    .into_iter()
    .find(|state| targets.contains(&Some(*state)))
    .unwrap_or(AcceptedPending)
}

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;
