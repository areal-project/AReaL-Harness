#[path = "gateway/owner.rs"]
mod gateway_owner;
#[path = "power.rs"]
mod power;
#[path = "schedule_connection.rs"]
mod schedule_connection;
#[path = "schedules.rs"]
mod schedules;
#[path = "subscription/host.rs"]
mod subscriptions;
#[path = "updates.rs"]
pub(crate) mod updates;
use crate::{
    Activity, CAPABILITIES, HostIdentity, HostStatus, LaunchInputs, OpenResult, ProjectActivity,
    ProjectRegistration, ProjectStatus, StopStrategy, VERSION, launch,
    wire::{self, error},
};
use anyhow::{Context, Result, ensure};
use areal_local_service::{LifetimeWriter, OwnerLifetime, storage};
use areal_protocol::service::{Owner, Service, State, StopOperation, StopOperationState};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::PathBuf,
    rc::Rc,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::BufReader,
    net::{UnixListener, UnixStream},
    sync::{Mutex, Notify, watch},
};

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
struct Slot {
    registration: ProjectRegistration,
    gate: Arc<Mutex<()>>,
    writer: Option<LifetimeWriter>,
    uncertain_start: bool,
    lifetime: Option<Rc<OwnerLifetime>>,
    state: String,
    service: Option<Service>,
    migration: Option<Value>,
    credentials: BTreeMap<String, String>,
}
struct Host {
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
    power: power::Power,
}
impl Slot {
    fn imported(registration: ProjectRegistration) -> Self {
        Self {
            registration,
            gate: Arc::new(Mutex::new(())),
            writer: None,
            uncertain_start: false,
            lifetime: None,
            state: "stopped".into(),
            service: None,
            migration: None,
            credentials: BTreeMap::new(),
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
        .run_until(run_local_mode(options, true))
        .await
}
async fn run_local(options: RunOptions) -> Result<HostExit> {
    run_local_mode(options, false).await
}
async fn run_local_mode(options: RunOptions, managed: bool) -> Result<HostExit> {
    let home = storage::prepare_host_home(&options.home)?;
    let lock = storage::open_private(&home.join("host.lock"), true)?;
    match lock.try_lock_exclusive() {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
            return Ok(HostExit::AlreadyRunning);
        }
        Err(e) => return Err(e.into()),
    }
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
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
    let identity = HostIdentity {
        version: VERSION,
        host_id,
        generation: uuid::Uuid::new_v4().to_string(),
        socket_path: socket.clone(),
        auth_file: directory.join("auth.json"),
        pid: std::process::id(),
        executable_version: env!("CARGO_PKG_VERSION").into(),
    };
    storage::write(&identity.auth_file, &token)?;
    let mut slots = BTreeMap::new();
    for entry in std::fs::read_dir(directory.join("projects"))? {
        let path = entry?.path();
        if path.extension().is_some_and(|v| v == "json") {
            let registration: ProjectRegistration = storage::read(&path)?;
            slots.insert(
                registration.project_id.clone(),
                Slot {
                    registration,
                    gate: Arc::new(Mutex::new(())),
                    writer: None,
                    uncertain_start: false,
                    lifetime: None,
                    state: "stopped".into(),
                    service: None,
                    migration: None,
                    credentials: BTreeMap::new(),
                },
            );
        }
    }
    let migration = crate::migration::Migration::new(&home)?;
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
    let stop = stop.filter(|v| v["state"] != "completed" && !settled_refusal(v));
    let (changes, _) = watch::channel(0);
    let host = Rc::new(Host {
        schedules: schedules::Schedules::load(&home)?,
        home,
        bin: options.bin_dir.canonicalize()?,
        identity,
        token,
        slots: RefCell::new(slots),
        stop: RefCell::new(stop),
        host_stop_gate: Mutex::new(()),
        changes,
        exit: Notify::new(),
        migration: migration.into(),
        journal,
        remote,
        gateway: gateway_owner::Gateway::default(),
        subscriptions: subscriptions::Subscriptions::default(),
        power: power::Power::default(),
    });
    host.schedules.import(
        &host.migration,
        &host
            .slots
            .borrow()
            .values()
            .map(|slot| slot.registration.clone())
            .collect::<Vec<_>>(),
    )?;
    for entry in std::fs::read_dir(directory.join("operations"))? {
        let path = entry?.path();
        if path.extension().is_none_or(|extension| extension != "json") {
            continue;
        }
        let record: Operation = storage::read(&path)?;
        if record.evidence["schedulingIntentPending"] == true {
            host.apply_scheduling_intent(
                record.receipt["requestId"]
                    .as_str()
                    .context("missing scheduling request identity")?,
            )?;
        }
    }
    host.restore_subscriptions().await?;
    storage::write(&directory.join("host.json"), &host.identity)?;
    host.settle_update_start()?;
    let scheduler = schedules::run(host.clone());
    tokio::pin!(scheduler);
    let connections = schedule_connection::run(host.clone());
    tokio::pin!(connections);
    let gateway = gateway_owner::run(host.clone());
    tokio::pin!(gateway);
    let subscriptions = host.run_subscriptions();
    tokio::pin!(subscriptions);
    let power = power::run(host.clone());
    tokio::pin!(power);
    loop {
        tokio::select! {
            _=host.exit.notified()=>break,
            _=&mut scheduler=>unreachable!("scheduler lifetime is the Host lifetime"),
            _=&mut connections=>unreachable!("schedule connections live with the Host"),
            _=&mut gateway=>unreachable!("Gateway lives with the Host"),
            _=&mut subscriptions=>unreachable!("subscription owners live with the Host"),
            _=&mut power=>unreachable!("power protection lives with the Host"),
            connection=listener.accept()=> {let (stream,_)=connection?;let host=host.clone();tokio::task::spawn_local(async move {let _=connection_loop(host,stream).await;});}
        }
    }
    host.close_subscriptions().await;
    host.power.close().await;
    std::fs::remove_file(socket)?;
    std::fs::remove_file(directory.join("host.json"))?;
    crate::service_run::ServiceRun::finish(&host.home)?;
    host.exec_update(managed)?;
    drop(lock);
    Ok(HostExit::Stopped)
}
async fn connection_loop(host: Rc<Host>, stream: UnixStream) -> Result<()> {
    ensure!(
        stream.peer_cred()?.uid() == unsafe { libc::geteuid() },
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
        json!({"version":VERSION,"id":request.id,"result":{"version":VERSION,"hostId":host.identity.host_id,"generation":host.identity.generation,"capabilities":CAPABILITIES,"executableVersion":host.identity.executable_version}})
    } else {
        json!({"version":VERSION,"id":request.id,"error":{"code":"versionMismatch","message":"Host requires protocol version 1"}})
    };
    wire::write(&mut writer, &response).await?;
    if !hello.protocol_versions.contains(&VERSION) {
        return Ok(());
    }
    let _ = hello.capabilities;
    let connection = ConnectionGuard {
        host: host.clone(),
        id: uuid::Uuid::new_v4().to_string(),
        socket,
    };
    let mut subscription: Option<(String, u64)> = None;
    let mut changes = host.changes.subscribe();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let mut previous = Value::Null;
    let mut gateway_subscription: Option<(String, String, u64, Value)> = None;
    let mut frame_bytes = Vec::new();
    loop {
        tokio::select! {
            value=wire::read_buffered(&mut reader,&mut frame_bytes)=> {
                let Some(value)=value? else {return Ok(());};
                let request:wire::Request=serde_json::from_value(value)?;
                let result=if request.version!=VERSION {Err(error("unsupportedVersion","Host requires version 1"))} else if request.id.is_empty() {Err(error("invalidRequest","id must be nonempty"))} else if request.method=="host.subscribe" {serde_json::from_value::<Empty>(request.params).map_err(anyhow::Error::from)?;let id=uuid::Uuid::new_v4().to_string();subscription=Some((id.clone(),0));let status=host.status().await;previous=serde_json::to_value(&status)?;Ok(json!({"subscriptionId":id,"generation":host.identity.generation,"sequence":0,"status":status}))} else if request.method=="remote.gateway.subscribe" {
                    #[derive(Deserialize)]
                    #[serde(rename_all="camelCase",deny_unknown_fields)]
                    struct Query { source_id:String }
                    let input:Query=serde_json::from_value(request.params)?;
                    let result=(|| -> Result<Value> {
                        ensure!(gateway_subscription.as_ref().is_none_or(|(source,_,_,_)|source==&input.source_id),error("sourceNotFound","connection already subscribes to another Remote source"));
                        let state=host.gateway_state(&input.source_id)?;
                        let id=uuid::Uuid::new_v4().to_string();
                        gateway_subscription=Some((input.source_id,id.clone(),0,state.clone()));
                        Ok(json!({"subscriptionId":id,"generation":host.identity.generation,"sequence":0,"state":state}))
                    })();
                    result
                } else {host.dispatch_connection(&request.method,request.params,&connection).await};
                let response=match result {Ok(value)=>json!({"version":VERSION,"id":request.id,"result":value}),Err(e)=>{let code=e.downcast_ref::<wire::Error>().map(|e|e.code).unwrap_or(if e.downcast_ref::<serde_json::Error>().is_some(){"invalidRequest"}else{"internalError"});json!({"version":VERSION,"id":request.id,"error":{"code":code,"message":e.to_string()}})}};
                let sent=wire::write(&mut writer,&response).await;
                if host.stop.borrow().as_ref().is_some_and(|v|v["state"]=="completed") {host.exit.notify_one();}
                sent?;
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
impl Host {
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
        if let Some(receipt) = self.migration.vault.operation(id, &self.migration)? {
            return Ok(Some(receipt));
        }
        if let Some(receipt) = self.remote.operation(id, &self.migration)? {
            return Ok(Some(receipt));
        }
        self.subscription_operation(id)
    }
    fn client_state(
        &self,
        method: &str,
        params: Value,
        connection: &ConnectionGuard,
    ) -> Result<Value> {
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
        match method {
            "gui.source" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Query {
                    source: crate::migration::Source,
                }
                let input: Query = serde_json::from_value(params)?;
                let registrations = self
                    .slots
                    .borrow()
                    .values()
                    .map(|slot| slot.registration.clone())
                    .collect::<Vec<_>>();
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
                let existing = self
                    .slots
                    .borrow()
                    .values()
                    .map(|s| s.registration.clone())
                    .collect::<Vec<_>>();
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
                self.schedules.import(
                    &self.migration,
                    &self
                        .slots
                        .borrow()
                        .values()
                        .map(|slot| slot.registration.clone())
                        .collect::<Vec<_>>(),
                )?;
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
                    let current: Vec<_> = self
                        .slots
                        .borrow()
                        .values()
                        .map(|slot| slot.registration.clone())
                        .collect();
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
    fn gate(&self, id: &str) -> Result<Arc<Mutex<()>>> {
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
        storage::read_optional(&wire::operation_path(&self.home, id))
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
        let receipt = json!({"version":VERSION,"requestId":id,"method":method,"hostId":self.identity.host_id,"generation":self.identity.generation,"projectId":project_id,"state":"acceptedPending"});
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
        let mut projects = Vec::new();
        for id in ids {
            projects.push(self.project_status(&id).await);
        }
        let stop = self.stop.borrow();
        HostStatus {
            host_id: self.identity.host_id.clone(),
            generation: self.identity.generation.clone(),
            state: if stop.as_ref().is_some_and(|s| s["state"] == "completed") {
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
            let (registration, gate, supervised, known_service) = {
                let slots = self.slots.borrow();
                let slot = &slots[&id];
                (
                    slot.registration.clone(),
                    slot.gate.clone(),
                    slot.writer.is_some(),
                    slot.service.clone(),
                )
            };
            let observed = match gate.try_lock() {
                Ok(_guard) => {
                    let stable = {
                        let slots = self.slots.borrow();
                        !slots[&id].uncertain_start && slots[&id].migration.is_none()
                    };
                    if stable {
                        tokio::time::timeout(
                            Duration::from_secs(3),
                            crate::activity::observe(
                                &self.home,
                                &registration,
                                &self.owner(),
                                supervised,
                                known_service.as_ref(),
                            ),
                        )
                        .await
                        .ok()
                        .and_then(Result::ok)
                    } else {
                        None
                    }
                }
                Err(_) => None,
            };
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
    async fn project_status(&self, id: &str) -> ProjectStatus {
        let (registration, gate) = {
            let slots = self.slots.borrow();
            let s = &slots[id];
            (s.registration.clone(), s.gate.clone())
        };
        if let Ok(_guard) = gate.try_lock() {
            let instance = Self::service_id(&registration);
            if let Ok(Ok(service)) = tokio::time::timeout(
                Duration::from_millis(500),
                areal_local_service::status(&self.home, &instance),
            )
            .await
            {
                let mut slots = self.slots.borrow_mut();
                let slot = slots.get_mut(id).unwrap();
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
                let mut slots = self.slots.borrow_mut();
                let slot = slots.get_mut(id).unwrap();
                if slot.service.is_some() || slot.writer.is_some() {
                    slot.state = "unavailable".into();
                }
            }
        }
        let slots = self.slots.borrow();
        let slot = &slots[id];
        ProjectStatus {schedule_activation_suppressed:self.schedules.suppressed(id),schedule_activation_error:self.schedules.error(id),registration,state:slot.state.clone(),service:slot.service.clone().filter(|s|s.owner.as_ref()==Some(&self.owner()) && slot.writer.is_some() && slot.state=="ready"),migration:slot.migration.clone().or_else(||slot.service.as_ref().filter(|s|s.owner.is_none() && s.state==State::Ready).map(|s|json!({"serviceId":s.identity.service_id,"generation":s.identity.generation,"phase":"legacyPending"})))}
    }
    async fn dispatch_connection(
        &self,
        method: &str,
        params: Value,
        connection: &ConnectionGuard,
    ) -> Result<Value> {
        if method == "remote.gateway.control" {
            return connection.host.gateway_control(params).await;
        }
        if method.starts_with("subscription.") {
            return self.subscription_dispatch(method, params, connection).await;
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
                Ok(
                    json!({"operation":match self.client_operation(&query.request_id)? { Some(receipt) => Some(receipt), None => self.reconcile(&query.request_id).await? }}),
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
        self.migration.validate_registration(
            r,
            &self
                .slots
                .borrow()
                .values()
                .map(|slot| slot.registration.clone())
                .collect::<Vec<_>>(),
        )?;
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
            slots.insert(
                r.project_id.clone(),
                Slot {
                    registration: r.clone(),
                    gate: Arc::new(Mutex::new(())),
                    writer: None,
                    uncertain_start: false,
                    lifetime: None,
                    state: "stopped".into(),
                    service: None,
                    migration: None,
                    credentials: BTreeMap::new(),
                },
            );
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
                receipt["state"] = json!("completed");
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
                receipt["error"] = json!({"code":e.downcast_ref::<wire::Error>().map(|e|e.code).unwrap_or("internalError"),"message":e.to_string()});
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
    async fn ensure_generation(
        &self,
        input: Ensure,
        scheduled: bool,
        service_generation: Option<&str>,
    ) -> Result<Value> {
        self.generation(&input.expected_generation)?;
        self.admission()?;
        let gate = self.gate(&input.project_id)?;
        let _guard = gate.lock().await;
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
            &input,
            &input.project_id,
        )?;
        if let Some(previous) = previous {
            self.apply_scheduling_intent(&input.request_id)?;
            return previous_result(previous);
        }
        self.apply_scheduling_intent(&input.request_id)?;
        let result = self.ensure_inner(&input).await;
        if result.is_err() {
            self.slots
                .borrow_mut()
                .get_mut(&input.project_id)
                .unwrap()
                .state = "unavailable".into();
        }
        let result = self.finish_mutation(&input.request_id, &digest, result);
        if !scheduled && input.launch_inputs.is_some() {
            self.schedules.wake.notify_one();
        }
        result
    }
    async fn ensure_inner(&self, input: &Ensure) -> Result<Value> {
        if self.migration.unpublished_reserved(&input.project_id)? {
            return Err(error(
                "migrationBlocked",
                "project is reserved by an unpublished GUI import",
            ));
        }
        let registration = self.slots.borrow()[&input.project_id].registration.clone();
        let saved_path = self
            .home
            .join("host/launch")
            .join(storage::digest(input.project_id.as_bytes()))
            .join("inputs.json");
        let mut inputs = match &input.launch_inputs {
            Some(v) => v.clone(),
            None => storage::read_optional(&saved_path)?.ok_or_else(|| {
                error(
                    "configurationConflict",
                    "first activation requires launchInputs",
                )
            })?,
        };
        if let Some(source) = self.migration.credential_source(&registration)? {
            if self.migration.vault.subscription_owner(&source)?.is_some()
                && !inputs
                    .credential_names
                    .iter()
                    .any(|name| name == "AREAL_CREDENTIAL_areal_openai")
            {
                inputs
                    .credential_names
                    .push("AREAL_CREDENTIAL_areal_openai".into());
            }
        }
        launch::validate(&inputs, &registration)?;
        ensure!(
            input
                .credentials
                .keys()
                .all(|k| inputs.credential_names.contains(k)),
            "invalidRequest: credentials must be named by launch inputs"
        );
        let imported_source = self.migration.credential_source(&registration)?.is_some();
        let mut imported_credentials = BTreeMap::new();
        for name in &inputs.credential_names {
            if imported_source && name.starts_with("AREAL_CREDENTIAL_") {
                imported_credentials.insert(
                    name.clone(),
                    self.migration.credential(&registration, name)?,
                );
            }
        }
        let credentials = {
            let mut slots = self.slots.borrow_mut();
            let slot = slots.get_mut(&input.project_id).unwrap();
            slot.credentials.extend(input.credentials.clone());
            for (name, value) in imported_credentials {
                if let Some(value) = value {
                    slot.credentials.insert(name, value);
                } else {
                    slot.credentials.remove(&name);
                }
            }
            slot.credentials.clone()
        };
        let (mut spec, _) =
            launch::prepare(&self.home, &self.bin, &registration, &inputs, &credentials)?;
        let mut journal = self
            .receipt(&input.request_id)?
            .context("missing activation receipt")?;
        let previous = storage::read_optional::<Service>(&spec.directory()?.join("service.json"))?;
        journal.evidence = json!({"serviceId":spec.service_id,"fingerprint":spec.fingerprint,"owner":self.owner(),"registration":registration,"previousService":previous,"components":spec.components});
        storage::write(
            &wire::operation_path(&self.home, &input.request_id),
            &journal,
        )?;
        let current = if previous.is_some() {
            let service = areal_local_service::status(&self.home, &spec.service_id)
                .await
                .map_err(|cause| {
                    error(
                        "migrationBlocked",
                        format!(
                            "cannot inspect existing service {} before activation: {cause:#}",
                            spec.service_id
                        ),
                    )
                })?;
            Some(service)
        } else {
            None
        };
        if let Some(previous) = current.as_ref().filter(|s| {
            s.owner.as_ref() != Some(&self.owner())
                && s.state != State::Ready
                && s.state != State::Stopping
        }) {
            self.cleanup_proof(previous).await?;
        }
        if let Some(service) =
            current.filter(|s| s.state == State::Ready || s.state == State::Stopping)
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
        {
            let mut slots = self.slots.borrow_mut();
            let slot = slots.get_mut(&input.project_id).unwrap();
            slot.state = "starting".into();
        }
        self.changed();
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
        self.slots
            .borrow_mut()
            .get_mut(&input.project_id)
            .unwrap()
            .uncertain_start = true;
        let result =
            areal_local_service::ensure_with_lifetime(&spec, &lifetime, input.no_auto_restart)
                .await;
        if result.is_err() {
            if let Ok(service) = areal_local_service::status(&self.home, &spec.service_id).await {
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
        }
        let service = result?;
        ensure!(
            service.owner.as_ref() == Some(&self.owner()),
            "invalid Host owner after launch"
        );
        let project = ProjectStatus {
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
        {
            if proof.version == VERSION
                && proof.identity == service.identity
                && proof.owner == service.owner
                && proof.cleanup_confirmed
            {
                return Ok(());
            }
        }
        if let Some(proof) =
            storage::read_optional::<storage::CrashReceipt>(&directory.join("crash.json"))?
        {
            if proof.identity == service.identity && proof.cleanup_confirmed {
                return Ok(());
            }
        }
        let operations = directory.join("operations");
        if operations.is_dir() {
            for entry in std::fs::read_dir(operations)? {
                let receipt: storage::StopReceipt = storage::read(&entry?.path())?;
                if receipt.service.identity == service.identity && receipt.cleanup_confirmed {
                    if let Some(operation) = areal_local_service::operation(
                        &self.home,
                        &service.identity.service_id,
                        &service.identity.generation,
                        &receipt.operation.request_id,
                    )
                    .await?
                    {
                        if operation.state == StopOperationState::Completed {
                            return Ok(());
                        }
                    }
                }
            }
        }
        Err(error(
            "migrationBlocked",
            "original generation has no confirmed Runtime cleanup receipt",
        ))
    }
    async fn check_pending(&self, project_id: &str, current: &str) -> Result<()> {
        for entry in std::fs::read_dir(self.home.join("host/operations"))? {
            let record: Operation = storage::read(&entry?.path())?;
            if record.receipt["requestId"] != current
                && record.receipt["projects"]
                    .as_array()
                    .is_some_and(|targets| {
                        targets.iter().any(|target| {
                            target["projectId"] == project_id
                                && !matches!(
                                    target["receipt"]["state"].as_str(),
                                    Some("completed" | "blocked")
                                )
                        })
                    })
            {
                return Err(error(
                    "admissionUnknown",
                    "an earlier Host stop target must be reconciled before changing project lifecycle",
                ));
            }
            if record.receipt["requestId"] == current || record.receipt["projectId"] != project_id {
                continue;
            }
            let state = record.receipt["state"].as_str().unwrap_or("");
            if matches!(
                state,
                "acceptedPending" | "admissionUnknown" | "settlementIncomplete"
            ) {
                return Err(error(
                    "admissionUnknown",
                    "an earlier project operation must be reconciled before activation",
                ));
            }
            if let Some(migration) = record.receipt.get("migration") {
                if migration["phase"] == "draining" {
                    return Err(error(
                        "admissionUnknown",
                        "legacy drain must be reconciled before activation",
                    ));
                }
            }
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
            Err(_) => {
                json!({"version":VERSION,"requestId":request_id,"projectId":project_id,"serviceId":service.identity.service_id,"serviceGeneration":service.identity.generation,"strategy":strategy,"state":"admissionUnknown","message":"Read the original operation to reconcile admission"})
            }
        };
        if receipt["state"] == "blocked" {
            self.slots.borrow_mut().get_mut(project_id).unwrap().state = "ready".into();
        }
        if receipt["state"] == "completed" {
            let mut slots = self.slots.borrow_mut();
            let slot = slots.get_mut(project_id).unwrap();
            slot.writer = None;
            slot.lifetime = None;
            slot.state = "stopped".into();
            slot.service = None;
        }
        self.changed();
        receipt
    }
    async fn stop_project(&self, input: Stop) -> Result<Value> {
        self.generation(&input.expected_generation)?;
        let id = input
            .project_id
            .as_deref()
            .ok_or_else(|| error("invalidRequest", "projectId required"))?;
        let gate = self.gate(id)?;
        let _guard = gate.lock().await;
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
        self.check_pending(id, &input.request_id).await?;
        let instance = Self::service_id(&self.slots.borrow()[id].registration);
        let service = areal_local_service::status(&self.home, &instance).await?;
        if input.service_generation.as_deref() != Some(&service.identity.generation) {
            return Err(error("generationMismatch", "service generation changed"));
        }
        self.admission()?;
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
                existing["state"].as_str(),
                Some("blocked" | "partial" | "settlementIncomplete")
            ) {
                return Err(error(
                    "stopInProgress",
                    "reconcile existing stop before new intent",
                ));
            }
            if existing["projects"].as_array().is_some_and(|targets| {
                targets.iter().any(|t| {
                    matches!(
                        t["receipt"]["state"].as_str(),
                        Some("admissionUnknown" | "acceptedPending")
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
            self.check_pending(id, &input.request_id).await?;
        }
        let (digest, _) = self.accepted(&input.request_id, "host.stop", &input, "")?;
        let mut receipt = json!({"version":VERSION,"requestId":input.request_id,"hostId":self.identity.host_id,"generation":self.identity.generation,"strategy":input.strategy,"state":"acceptedPending","projects":[],"localRelay":{"state":"acceptedPending"}});
        storage::write(&self.home.join("host/stop.json"), &receipt)?;
        *self.stop.borrow_mut() = Some(receipt.clone());
        self.gateway.local_relay.quiesce(true);
        self.changed();
        let ids: Vec<_> = self.slots.borrow().keys().cloned().collect();
        let mut guards = Vec::new();
        for id in &ids {
            guards.push(self.gate(id)?.lock_owned().await);
        }
        for id in &ids {
            self.check_pending(id, &input.request_id).await?;
        }
        let mut services = Vec::new();
        for id in ids {
            let instance = Self::service_id(&self.slots.borrow()[&id].registration);
            let service = match areal_local_service::status(&self.home, &instance).await {
                Ok(service) => Some(service),
                Err(_) => storage::read_optional::<Service>(
                    &storage::registry(&self.home, &instance)?.join("service.json"),
                )?,
            };
            if let Some(service) = service {
                if service.state != State::Stopped || self.cleanup_proof(&service).await.is_err() {
                    receipt["projects"].as_array_mut().unwrap().push(json!({"projectId":id,"serviceId":instance,"serviceGeneration":service.identity.generation,"requestId":uuid::Uuid::new_v4().to_string(),"dispatch":"notStarted"}));
                    services.push(service);
                }
            } else if self.slots.borrow()[&id].writer.is_some() {
                receipt["state"] = json!("settlementIncomplete");
                self.save_host_stop(&input.request_id, &digest, &receipt)?;
                return Ok(receipt);
            }
        }
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
        if receipt.get("localRelay").is_none() || receipt["localRelay"]["state"] == "completed" {
            return;
        }
        if receipt["hostId"] != self.identity.host_id
            || receipt["generation"] != self.identity.generation
        {
            receipt["localRelay"]["state"] = json!("settlementIncomplete");
            return;
        }
        if !receipt["projects"].as_array().is_some_and(|targets| {
            targets
                .iter()
                .all(|target| target["receipt"]["state"] == "completed")
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
        let Some(mut record) = self.receipt(id)? else {
            return Ok(None);
        };
        let _host_guard =
            if record.receipt["projects"].is_array() || record.receipt["method"] == "host.stop" {
                match self.host_stop_gate.try_lock() {
                    Ok(guard) => Some(guard),
                    Err(_) => return Ok(Some(record.receipt)),
                }
            } else {
                None
            };
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
        for project_id in project_ids {
            if let Ok(gate) = self.gate(&project_id) {
                match gate.try_lock_owned() {
                    Ok(guard) => guards.push(guard),
                    Err(_) => return Ok(Some(record.receipt)),
                }
            }
        }
        if matches!(
            record.receipt["state"].as_str(),
            Some("acceptedPending" | "admissionUnknown")
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
                        record.receipt["state"] = json!("completed");
                        record.receipt["result"] =
                            json!({"registration":expected,"created":record.evidence["created"]});
                        self.save(id, &record.digest, &record.receipt)?;
                    }
                }
            } else if record.receipt["method"] == "project.ensure" {
                if let Some(instance) = record.evidence["serviceId"].as_str() {
                    if let Ok(service) = areal_local_service::status(&self.home, instance).await {
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
                                    &storage::registry(&self.home, instance)?
                                        .join("components.json"),
                                )?
                                .as_ref()
                                    == record.evidence.get("components");
                            if service.state == State::Ready
                                && fingerprint_matches
                                && configuration_matches
                                && (new_generation || previous_ready)
                            {
                                record.receipt["state"] = json!("completed");
                                record.receipt["result"] = serde_json::to_value(OpenResult {
                                    project: ProjectStatus {
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
                                record.receipt["state"] = json!("blocked");
                                record.receipt["error"] = json!({"code":"activationInterrupted","message":"Original generation cleanup is confirmed; explicit activation may start a new request"});
                                self.save(id, &record.digest, &record.receipt)?;
                            }
                        }
                    }
                }
            }
        }
        if let Some(migration) = record.receipt.get("migration").cloned() {
            if migration["phase"] == "draining" {
                if let Some(operation) = areal_local_service::operation(
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
                        record.receipt["state"] = json!("blocked");
                    }
                    if operation.state == StopOperationState::Blocked {
                        record.receipt["migration"]["phase"] = json!("legacyPending");
                        record.receipt["state"] = json!("blocked");
                    }
                    self.save(id, &record.digest, &record.receipt)?;
                }
            }
        }
        if record.receipt["projects"].is_array() {
            let strategy: StopStrategy =
                serde_json::from_value(record.receipt["strategy"].clone())?;
            for target in record.receipt["projects"].as_array_mut().unwrap() {
                if target["dispatch"] == "started" && target["receipt"]["state"] != "completed" {
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
        ) {
            if let Some(operation) =
                areal_local_service::operation(&self.home, instance, generation, id).await?
            {
                let strategy = serde_json::from_value(record.receipt["strategy"].clone())?;
                record.receipt = stop_receipt(project, strategy, &operation);
                self.save(id, &record.digest, &record.receipt)?;
            }
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
    matches!(receipt["state"].as_str(), Some("blocked" | "partial"))
        && targets
            .iter()
            .any(|target| target["receipt"]["state"] == "blocked")
        && targets.iter().all(|target| {
            target["dispatch"] == "started"
                && matches!(
                    target["receipt"]["state"].as_str(),
                    Some("completed" | "blocked")
                )
        })
}
fn aggregate(receipt: &Value) -> &'static str {
    let targets = receipt["projects"].as_array().unwrap();
    if targets.iter().all(|t| t["receipt"]["state"] == "completed") {
        if let Some(relay) = receipt.get("localRelay") {
            return match relay["state"].as_str() {
                Some("completed") => "completed",
                Some("settlementIncomplete") => "settlementIncomplete",
                _ => "acceptedPending",
            };
        }
    }
    if targets.iter().all(|t| t["receipt"]["state"] == "completed") {
        return "completed";
    }
    if targets.iter().any(|t| t["receipt"]["state"] == "completed") {
        return "partial";
    }
    for state in [
        "admissionUnknown",
        "settlementIncomplete",
        "acceptedPending",
        "blocked",
    ] {
        if targets.iter().any(|t| t["receipt"]["state"] == state) {
            return state;
        }
    }
    "acceptedPending"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Client, ProjectSource};

    #[tokio::test(flavor = "current_thread")]
    async fn authenticated_activity_is_read_only_and_keeps_unknown_projects_incomplete() {
        tokio::task::LocalSet::new().run_until(async {
            let root = tempfile::tempdir().unwrap();
            let base = root.path().canonicalize().unwrap();
            let home = base.join("home");
            let workspace = base.join("workspace");
            std::fs::create_dir(&workspace).unwrap();
            let task = tokio::task::spawn_local(run_local(RunOptions { home: home.clone(), bin_dir: base.clone() }));
            let client = loop {
                if let Ok(client) = Client::connect_at(home.clone()).await { break client; }
                tokio::task::yield_now().await;
            };
            assert!(client.status().await.unwrap().capabilities.iter().any(|capability| capability == "activity"));
            assert_eq!(client.activity().await.unwrap(), Activity { complete: true, projects: vec![], total_active_tasks: 0 });
            let registration = ProjectRegistration { project_id: "cli-project".into(), workspace: workspace.clone(), data_dir: base.join("unstarted-data"), source: ProjectSource::Cli, default_binding: false };
            client.register(&uuid::Uuid::new_v4().to_string(), registration.clone()).await.unwrap();
            let directory = storage::registry(&home, &Host::service_id(&registration)).unwrap();
            assert!(!directory.exists());
            assert!(!registration.data_dir.exists());
            let idle = ProjectActivity::Observed { project_id: registration.project_id.clone(), active_tasks: 0, active_turns: 0, active_goals: 0, pending_queue_items: 0, idle_allowed: true };
            assert_eq!(client.activity().await.unwrap(), Activity { complete: true, projects: vec![idle.clone()], total_active_tasks: 0 });
            assert!(!directory.exists());
            assert!(!registration.data_dir.exists());
            storage::private_dir(&registration.data_dir).unwrap();
            let locked = storage::open_private(&registration.data_dir.join("owner.lock"), true).unwrap();
            locked.try_lock_exclusive().unwrap();
            let unavailable = Activity { complete: false, projects: vec![ProjectActivity::Unavailable { project_id: registration.project_id.clone() }], total_active_tasks: 0 };
            assert_eq!(client.activity().await.unwrap(), unavailable);
            assert!(!directory.exists());
            assert!(!registration.data_dir.join("service.lock").exists());
            drop(locked);
            storage::private_dir(&directory).unwrap();
            let service: Service = serde_json::from_value(json!({"protocolVersion":1,"serviceId":Host::service_id(&registration),"generation":uuid::Uuid::new_v4().to_string(),"workspace":workspace,"dataDir":registration.data_dir,"configFingerprint":"fixture","endpoint":"ws://127.0.0.1:1","webUrl":"http://127.0.0.1:1","authFile":directory.join("auth.json"),"logFile":directory.join("host.log"),"hostPid":1,"corePid":1,"state":"stopped"})).unwrap();
            storage::write(&directory.join("service.json"), &service).unwrap();
            let original = std::fs::read(directory.join("service.json")).unwrap();
            assert_eq!(client.activity().await.unwrap(), unavailable);
            let mut cleanup = storage::CleanupReceipt { version: 1, identity: service.identity.clone(), owner: service.owner.clone(), components: BTreeMap::new(), cleanup_confirmed: true };
            cleanup.identity.generation = "other-generation".into();
            storage::write(&directory.join("cleanup.json"), &cleanup).unwrap();
            assert_eq!(client.activity().await.unwrap(), unavailable);
            cleanup.identity = service.identity.clone();
            storage::write(&directory.join("cleanup.json"), &cleanup).unwrap();
            assert_eq!(client.activity().await.unwrap(), Activity { complete: true, projects: vec![idle], total_active_tasks: 0 });
            assert_eq!(std::fs::read(directory.join("service.json")).unwrap(), original);
            assert!(!directory.join("start.lock").exists());
            assert!(!registration.data_dir.join("service.lock").exists());
            let mut connection = BufReader::new(UnixStream::connect(&client.identity().socket_path).await.unwrap());
            let token: String = storage::read(&client.identity().auth_file).unwrap();
            wire::write(connection.get_mut(), &json!({"version":1,"id":"hello","method":"hello","params":{"protocolVersions":[1],"capabilities":["activity"],"authToken":token}})).await.unwrap();
            assert!(wire::read(&mut connection).await.unwrap().unwrap().get("result").is_some());
            wire::write(connection.get_mut(), &json!({"version":1,"id":"invalid","method":"host.activity","params":{"projectId":"cli-project"}})).await.unwrap();
            assert!(wire::read(&mut connection).await.unwrap().unwrap().get("error").is_some());
            drop(connection);
            let other = ProjectRegistration { project_id: "other-project".into(), workspace: registration.workspace.clone(), data_dir: base.join("other-data"), source: ProjectSource::Cli, default_binding: false };
            client.register(&uuid::Uuid::new_v4().to_string(), other.clone()).await.unwrap();
            assert_eq!(client.activity().await.unwrap().projects.len(), 2);
            storage::private_dir(&other.data_dir).unwrap();
            let locked = storage::open_private(&other.data_dir.join("owner.lock"), true).unwrap();
            locked.try_lock_exclusive().unwrap();
            let partial = client.activity().await.unwrap();
            assert!(!partial.complete);
            assert_eq!(partial.total_active_tasks, 0);
            assert!(matches!(&partial.projects[0], ProjectActivity::Observed { project_id, idle_allowed: true, .. } if project_id == &registration.project_id));
            assert_eq!(partial.projects[1], ProjectActivity::Unavailable { project_id: other.project_id.clone() });
            assert!(!other.data_dir.join("service.lock").exists());
            drop(locked);
            let launch_inputs = home.join("host/launch").join(storage::digest(other.project_id.as_bytes())).join("inputs.json");
            storage::private_dir(launch_inputs.parent().unwrap()).unwrap();
            storage::write(&launch_inputs, &json!({"previousActivation":true})).unwrap();
            assert_eq!(client.activity().await.unwrap(), partial);
            task.abort();
            assert!(matches!(task.await, Err(error) if error.is_cancelled()));
        }).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn unpublished_cli_import_blocks_journal_read_prepare_and_bound_commit() {
        use std::os::fd::AsRawFd;
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let home = base.join("home");
        let core = base.join("core");
        let workspace = base.join("workspace");
        let project = "a".repeat(24);
        let data = core.join(&project).join("state");
        for path in [
            &home,
            &home.join("host/operations"),
            &home.join("host/projects"),
            &core,
            &workspace,
            &data,
        ] {
            storage::private_dir(path).unwrap();
        }
        let registration = ProjectRegistration {
            project_id: project.clone(),
            workspace: workspace.clone(),
            data_dir: data.clone(),
            source: ProjectSource::Cli,
            default_binding: true,
        };
        let journal = crate::journal::Journal::new(&home).unwrap();
        let initial = json!({"version":1,"pending":[],"outcomes":{}});
        journal.initialize(&project, initial.clone()).unwrap();
        let bytes = serde_json::to_vec(&initial).unwrap();
        let request = uuid::Uuid::new_v4().to_string();
        let prepare = json!({"requestId":request,"expectedGeneration":"generation","projectId":project,"expectedRevision":0,"sha256":storage::digest(&bytes),"byteLength":bytes.len()});
        let slot = journal
            .dispatch("journal.prepare", prepare.clone(), "connection")
            .unwrap();
        std::fs::write(slot["writePath"].as_str().unwrap(), bytes).unwrap();
        storage::write(
            &core.join("projects.json"),
            &json!([{"id":project,"root":workspace}]),
        )
        .unwrap();
        let lock = storage::open_private(&data.join("owner.lock"), true).unwrap();
        lock.try_lock_exclusive().unwrap();
        let (changes, _) = watch::channel(0);
        let mut migration = crate::migration::Migration::new(&home).unwrap();
        migration.vault = crate::vault::Vault::isolated_files(&home);
        let host = Rc::new(Host {
            home: home.clone(),
            bin: base.clone(),
            identity: HostIdentity {
                version: 1,
                host_id: uuid::Uuid::new_v4().to_string(),
                generation: "generation".into(),
                socket_path: home.join("socket"),
                auth_file: home.join("auth"),
                pid: std::process::id(),
                executable_version: "fixture".into(),
            },
            token: "fixture".into(),
            slots: RefCell::new(BTreeMap::from([(
                project.clone(),
                Slot::imported(registration),
            )])),
            stop: RefCell::new(None),
            host_stop_gate: Mutex::new(()),
            changes,
            exit: Notify::new(),
            migration: migration.into(),
            journal,
            remote: crate::remote_state::RemoteState::new(&home),
            gateway: gateway_owner::Gateway::default(),
            subscriptions: subscriptions::Subscriptions::default(),
            power: power::Power::default(),
            schedules: schedules::Schedules::load(&home).unwrap(),
        });
        let (socket, _peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let connection = ConnectionGuard {
            host: host.clone(),
            id: "connection".into(),
            socket: socket.as_raw_fd(),
        };
        let source = json!({"profile":base.join("profile"),"coreHome":core,"legacyServiceHome":base.join("legacy")});
        assert!(
            host.client_state("gui.source", json!({"source":source}), &connection)
                .unwrap()
                .is_null()
        );
        host.client_state("gui.attachSource", json!({"source":source}), &connection)
            .unwrap();
        let result = host.client_state("gui.import",json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":"generation","source":source}),&connection).unwrap();
        assert_eq!(result["kind"], "legacyPending");
        for (method, params) in [
            ("journal.read", json!({"projectId":project})),
            ("journal.prepare", prepare),
            (
                "journal.commit",
                json!({"requestId":request,"expectedGeneration":"generation","slotId":slot["slotId"]}),
            ),
        ] {
            let error = host.client_state(method, params, &connection).unwrap_err();
            assert!(
                error.to_string().contains("migrationPending"),
                "{method}: {error:#}"
            );
        }
        drop(lock);
        let ready = host.client_state("gui.import", json!({"requestId":result["requestId"],"expectedGeneration":"generation","source":source}), &connection).unwrap();
        assert_eq!(ready["kind"], "ready");
        let original_source = host
            .client_state("gui.source", json!({"source":source}), &connection)
            .unwrap();
        assert_eq!(
            original_source["bindings"][0]["registration"]["source"]["kind"],
            "cli"
        );
        let alias = "b".repeat(24);
        let gui_registration = ProjectRegistration {
            project_id: "new-gui-project".into(),
            workspace: workspace.clone(),
            data_dir: core.join(&alias).join("state"),
            source: ProjectSource::Gui {
                profile: base.join("profile"),
                legacy_project_id: alias.clone(),
            },
            default_binding: false,
        };
        let gui_request = uuid::Uuid::new_v4().to_string();
        let registered = host
            .register(Register {
                request_id: gui_request.clone(),
                expected_generation: "generation".into(),
                registration: gui_registration.clone(),
                bind_existing: false,
            })
            .await
            .unwrap();
        assert_eq!(registered["created"], true);
        assert_eq!(
            host.register(Register {
                request_id: gui_request.clone(),
                expected_generation: "generation".into(),
                registration: gui_registration.clone(),
                bind_existing: false
            })
            .await
            .unwrap(),
            registered
        );
        assert_eq!(
            host.receipt(&gui_request).unwrap().unwrap().receipt["state"],
            "completed"
        );
        let mut alias_conflict = gui_registration.clone();
        alias_conflict.project_id = "alias-rebound".into();
        let mut path_conflict = gui_registration.clone();
        path_conflict.data_dir = base.join("incorrect-store");
        let mut unknown_source = gui_registration.clone();
        unknown_source.source = ProjectSource::Gui {
            profile: base.join("unknown-profile"),
            legacy_project_id: alias.clone(),
        };
        let mut invalid_alias = gui_registration.clone();
        invalid_alias.source = ProjectSource::Gui {
            profile: base.join("profile"),
            legacy_project_id: "../invalid".into(),
        };
        let mut imported_alias = gui_registration.clone();
        imported_alias.source = ProjectSource::Gui {
            profile: base.join("profile"),
            legacy_project_id: project.clone(),
        };
        for (registration, code) in [
            (alias_conflict, "aliasConflict"),
            (path_conflict, "invalidRequest"),
            (unknown_source, "sourceNotFound"),
            (invalid_alias, "invalidRequest"),
            (imported_alias, "aliasConflict"),
        ] {
            let error = host
                .register(Register {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    expected_generation: "generation".into(),
                    registration: registration.clone(),
                    bind_existing: false,
                })
                .await
                .unwrap_err();
            assert!(error.to_string().contains(code), "{code}: {error:#}");
            assert!(
                host.register(Register {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    expected_generation: "stale".into(),
                    registration,
                    bind_existing: false
                })
                .await
                .unwrap_err()
                .to_string()
                .contains("generationMismatch")
            );
        }
        assert_eq!(host.slots.borrow().len(), 2);
        let view = host
            .client_state("gui.source", json!({"source":source}), &connection)
            .unwrap();
        assert_eq!(view["bindings"].as_array().unwrap().len(), 2);
        assert_eq!(view["bindings"][0], original_source["bindings"][0]);
        assert_eq!(
            view["bindings"][1]["registration"],
            serde_json::to_value(&gui_registration).unwrap()
        );
        assert_eq!(
            view["bindings"][1]["scratchDir"],
            core.join(&alias).join("scratch").to_str().unwrap()
        );
        let persisted: ProjectRegistration =
            storage::read(&host.record_path(&gui_registration.project_id)).unwrap();
        let restarted = crate::migration::Migration::new(&home).unwrap();
        let restarted_view = restarted
            .source(
                serde_json::from_value(source.clone()).unwrap(),
                &[persisted],
            )
            .unwrap();
        assert_eq!(restarted_view, view);
        assert_eq!(
            restarted.credential_source(&gui_registration).unwrap(),
            Some(view["sourceId"].as_str().unwrap().to_owned())
        );
        let retirement_id = uuid::Uuid::new_v4().to_string();
        let retirement_params = json!({"requestId":retirement_id,"migrationId":result["requestId"],"expectedGeneration":"generation"});
        let mut stale = retirement_params.clone();
        stale["expectedGeneration"] = json!("stale-generation");
        assert!(
            host.client_state("gui.retirementPrepare", stale, &connection)
                .unwrap_err()
                .to_string()
                .contains("generationMismatch")
        );
        assert!(
            host.client_state(
                "gui.retirementStatus",
                json!({"migrationId":result["requestId"]}),
                &connection
            )
            .unwrap()
            .is_null()
        );
        let retirement = host
            .client_state("gui.retirementPrepare", retirement_params, &connection)
            .unwrap();
        assert_eq!(retirement["state"], "completed");
        let confirm = json!({"requestId":retirement_id,"migrationId":result["requestId"],"planId":retirement["planId"],"expectedGeneration":"generation"});
        assert_eq!(
            host.client_state("gui.retirementConfirm", confirm.clone(), &connection)
                .unwrap(),
            retirement
        );
        let mut stale = confirm;
        stale["expectedGeneration"] = json!("stale-generation");
        assert!(
            host.client_state("gui.retirementConfirm", stale, &connection)
                .unwrap_err()
                .to_string()
                .contains("generationMismatch")
        );
        assert_eq!(
            host.client_operation(&retirement_id).unwrap().unwrap()["method"],
            "gui.retirementPrepare"
        );
        let vault_slot =
            json!({"kind":"subscriptionTransport","sourceId":ready["receipt"]["sourceId"]});
        assert_eq!(
            host.client_state("vault.read", json!({"slot":vault_slot}), &connection)
                .unwrap(),
            json!({"revision":0,"value":null})
        );
        let vault_id = uuid::Uuid::new_v4().to_string();
        let receipt = host.client_state("vault.replace",json!({"requestId":vault_id,"expectedGeneration":"generation","slot":vault_slot,"expectedRevision":0,"value":{"token":"isolated-dummy","port":1234}}),&connection).unwrap();
        assert_eq!(receipt["state"], "completed");
        assert_eq!(host.client_operation(&vault_id).unwrap().unwrap(), receipt);
        assert!(
            host.client_state(
                "remote.replace",
                json!({"requestId":vault_id,"expectedGeneration":"generation"}),
                &connection
            )
            .unwrap_err()
            .to_string()
            .contains("requestConflict")
        );
        assert!(host.client_state("vault.replace",json!({"requestId":result["requestId"],"expectedGeneration":"generation","slot":vault_slot,"expectedRevision":1,"value":null}),&connection).unwrap_err().to_string().contains("requestConflict"));
        let reference = "AREAL_CREDENTIAL_key";
        let credential_slot = json!({"kind":"providerCredential","sourceId":ready["receipt"]["sourceId"],"reference":reference});
        host.client_state("vault.replace",json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":"generation","slot":credential_slot,"expectedRevision":0,"value":"vault-secret"}),&connection).unwrap();
        let config_home = base.join("config");
        storage::private_dir(&config_home).unwrap();
        for name in [
            "areal",
            "areal-runtime",
            "areal-runtime-fs",
            "areal-runtime-reaper",
        ] {
            std::fs::write(base.join(name), "fixture").unwrap();
        }
        let input = Ensure {
            request_id: uuid::Uuid::new_v4().to_string(),
            expected_generation: "generation".into(),
            project_id: project.clone(),
            no_auto_restart: false,
            resume_scheduling: false,
            launch_inputs: Some(LaunchInputs {
                workspace: workspace.clone(),
                cwd: workspace,
                config_home,
                homedir: Some(base.join("isolated-home")),
                config_path: None,
                deployment_path: None,
                schedule_preparation: None,
                environment: BTreeMap::new(),
                credential_names: vec![reference.into(), "OPENAI_API_KEY".into()],
                options: areal_local_service::LocalArgs {
                    api_key_env: Some(reference.into()),
                    ..Default::default()
                },
            }),
            credentials: BTreeMap::from([
                (reference.into(), "stale-client-secret".into()),
                ("OPENAI_API_KEY".into(), "run-scoped-secret".into()),
            ]),
        };
        let first = host.ensure_inner(&input).await.unwrap_err();
        assert!(
            first.to_string().contains("missing activation receipt"),
            "{first:#}"
        );
        assert_eq!(
            host.slots.borrow()[&project].credentials[reference],
            "vault-secret"
        );
        let gui_input = Ensure {
            project_id: gui_registration.project_id.clone(),
            ..input.clone()
        };
        let gui_error = host.ensure_inner(&gui_input).await.unwrap_err();
        assert!(
            gui_error.to_string().contains("missing activation receipt"),
            "{gui_error:#}"
        );
        assert_eq!(
            host.slots.borrow()[&gui_registration.project_id].credentials[reference],
            "vault-secret"
        );
        host.client_state("vault.replace",json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":"generation","slot":credential_slot,"expectedRevision":1,"value":null}),&connection).unwrap();
        assert!(
            host.ensure_inner(&gui_input)
                .await
                .unwrap_err()
                .to_string()
                .contains("credentialsRequired")
        );
        assert!(
            !host.slots.borrow()[&gui_registration.project_id]
                .credentials
                .contains_key(reference)
        );
        assert!(
            host.ensure_inner(&input)
                .await
                .unwrap_err()
                .to_string()
                .contains("credentialsRequired")
        );
        assert!(
            !host.slots.borrow()[&project]
                .credentials
                .contains_key(reference),
            "revoked secret must be removed from the same Host cache"
        );
        assert_eq!(
            host.slots.borrow()[&project].credentials["OPENAI_API_KEY"],
            "run-scoped-secret"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn activation_preserves_status_errors_without_attempting_launch() {
        tokio::task::LocalSet::new().run_until(async {
            let root = tempfile::tempdir().unwrap();
            let root = root.path().canonicalize().unwrap();
            let home = root.join("home");
            let workspace = root.join("workspace");
            let bin = root.join("bin");
            std::fs::create_dir(&workspace).unwrap();
            std::fs::create_dir(&bin).unwrap();
            for name in ["areal", "areal-runtime", "areal-runtime-fs", "areal-runtime-reaper"] {
                std::fs::write(bin.join(name), "not executable").unwrap();
            }
            let task = tokio::task::spawn_local(run_local(RunOptions { home: home.clone(), bin_dir: bin }));
            let client = loop {
                if let Ok(client) = Client::connect_at(home.clone()).await { break client; }
                tokio::task::yield_now().await;
            };
            let registration = ProjectRegistration { project_id: "status-error".into(), workspace: workspace.clone(), data_dir: root.join("data"), source: ProjectSource::Cli, default_binding: false };
            client.register(&uuid::Uuid::new_v4().to_string(), registration.clone()).await.unwrap();
            let instance = Host::service_id(&registration);
            let directory = storage::registry(&home, &instance).unwrap();
            storage::private_dir(&directory).unwrap();
            let service: Service = serde_json::from_value(json!({"protocolVersion":0,"serviceId":instance,"generation":uuid::Uuid::new_v4().to_string(),"workspace":workspace,"dataDir":registration.data_dir,"configFingerprint":"fixture","endpoint":"ws://127.0.0.1:1","webUrl":"http://127.0.0.1:1","authFile":directory.join("auth.json"),"logFile":directory.join("host.log"),"hostPid":1,"corePid":1,"state":"ready"})).unwrap();
            storage::write(&directory.join("service.json"), &service).unwrap();
            let inputs = LaunchInputs { config_home: home.clone(), workspace: workspace.clone(), cwd: workspace, homedir: None, config_path: None, deployment_path: None, schedule_preparation: None, environment: BTreeMap::new(), credential_names: vec![], options: Default::default() };
            let request = uuid::Uuid::new_v4().to_string();
            let error = client.ensure(&request, &registration.project_id, Some(inputs), BTreeMap::new()).await.unwrap_err();
            assert!(format!("{error:#}").contains("cannot inspect existing service"), "{error:#}");
            assert!(format!("{error:#}").contains("invalid service record"), "{error:#}");
            assert_eq!(client.operation(&request).await.unwrap().unwrap()["state"], "blocked");
            assert_eq!(storage::read::<Service>(&directory.join("service.json")).unwrap().identity, service.identity);
            assert!(!directory.join("launch.json").exists());
            task.abort();
            assert!(matches!(task.await, Err(error) if error.is_cancelled()));
        }).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn authenticated_registry_receipts_survive_restart_without_activation() {
        tokio::task::LocalSet::new().run_until(async {
            let root=tempfile::tempdir().unwrap();let home=root.path().join("home");let workspace=root.path().join("workspace");std::fs::create_dir(&workspace).unwrap();
            let bin=std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
            let task=tokio::task::spawn_local(run_local(RunOptions {home:home.clone(),bin_dir:bin.clone()}));
            let client=loop {if let Ok(client)=Client::connect_at(home.clone()).await {break client;}tokio::task::yield_now().await;};
            let run_record=std::fs::read(home.join("host/service-run.json")).unwrap();
            assert!(matches!(run_local(RunOptions {home:home.clone(),bin_dir:bin.clone()}).await.unwrap(),HostExit::AlreadyRunning));
            assert!(matches!(run_local_mode(RunOptions {home:home.clone(),bin_dir:bin.clone()},true).await.unwrap(),HostExit::AlreadyRunning));
            assert_eq!(std::fs::read(home.join("host/service-run.json")).unwrap(),run_record);
            let identity=client.identity().clone();assert!(client.status().await.unwrap().projects.is_empty());
            let mut bad=BufReader::new(UnixStream::connect(&identity.socket_path).await.unwrap());
            wire::write(bad.get_mut(),&json!({"version":1,"id":"bad","method":"hello","params":{"protocolVersions":[1],"capabilities":[],"authToken":"wrong"}})).await.unwrap();
            assert!(wire::read(&mut bad).await.unwrap().is_none());
            let mut subscription=client.subscribe().await.unwrap();
            let id=uuid::Uuid::new_v4().to_string();let registration=ProjectRegistration {project_id:"test-project".into(),workspace:workspace.canonicalize().unwrap(),data_dir:storage::canonical_pending(&root.path().join("data")).unwrap(),source:ProjectSource::Cli,default_binding:true};
            assert_eq!(client.register(&id,registration.clone()).await.unwrap(),registration);
            let journal_record = home.join("host/journals/records").join(format!("{}.json", storage::digest(registration.project_id.as_bytes())));
            assert!(!journal_record.exists());
            assert!(crate::operation_offline(&home, &uuid::Uuid::new_v4().to_string()).unwrap().is_none());
            assert!(!journal_record.exists());
            let mut journal_connection = BufReader::new(UnixStream::connect(&identity.socket_path).await.unwrap());
            let auth: String = storage::read(&identity.auth_file).unwrap();
            wire::write(journal_connection.get_mut(), &json!({"version":1,"id":"hello-journal","method":"hello","params":{"protocolVersions":[1],"capabilities":["submissionJournal"],"authToken":auth}})).await.unwrap();
            assert!(wire::read(&mut journal_connection).await.unwrap().unwrap().get("result").is_some());
            wire::write(journal_connection.get_mut(), &json!({"version":1,"id":"missing-journal","method":"journal.read","params":{"projectId":"missing"}})).await.unwrap();
            assert_eq!(wire::read(&mut journal_connection).await.unwrap().unwrap()["error"]["code"], "projectNotFound");
            for (method, params) in [
                ("journal.read", json!({"projectId":registration.project_id,"unexpected":true})),
                ("journal.prepare", json!({"projectId":registration.project_id,"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":identity.generation})),
                ("journal.prepare", json!({"projectId":registration.project_id,"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":identity.generation,"expectedRevision":0,"sha256":"invalid","byteLength":1})),
            ] {
                wire::write(journal_connection.get_mut(), &json!({"version":1,"id":"invalid-journal","method":method,"params":params})).await.unwrap();
                assert!(wire::read(&mut journal_connection).await.unwrap().unwrap().get("error").is_some());
                assert!(!journal_record.exists(), "invalid journal request must not initialize storage");
            }
            wire::write(journal_connection.get_mut(), &json!({"version":1,"id":"read-journal","method":"journal.read","params":{"projectId":registration.project_id}})).await.unwrap();
            let read = wire::read(&mut journal_connection).await.unwrap().unwrap();
            assert_eq!(read["result"]["revision"], 0);
            let snapshot: Value = storage::read(PathBuf::from(read["result"]["snapshotPath"].as_str().unwrap()).as_path()).unwrap();
            assert_eq!(snapshot, json!({"version":1,"pending":[],"outcomes":{}}));
            let prepare_request = uuid::Uuid::new_v4().to_string();
            let snapshot_bytes = serde_json::to_vec(&snapshot).unwrap();
            wire::write(journal_connection.get_mut(), &json!({"version":1,"id":"prepare-journal","method":"journal.prepare","params":{"requestId":prepare_request,"expectedGeneration":identity.generation,"projectId":registration.project_id,"expectedRevision":0,"sha256":storage::digest(&snapshot_bytes),"byteLength":snapshot_bytes.len()}})).await.unwrap();
            assert!(wire::read(&mut journal_connection).await.unwrap().unwrap()["result"]["slotId"].is_string());
            assert!(journal_record.exists());
            drop(journal_connection);
            assert_eq!(client.register(&id,registration.clone()).await.unwrap(),registration);
            let mut changed=registration.clone();changed.data_dir=root.path().join("different");assert!(format!("{:#}",client.register(&id,changed).await.unwrap_err()).contains("requestConflict"));
            let event=tokio::time::timeout(Duration::from_secs(3),subscription.next()).await.unwrap().unwrap().unwrap();assert_eq!(event["method"],"host.statusChanged");assert_eq!(event["params"]["sequence"],1);
            let path=wire::operation_path(&home,&id);let mut interrupted:Operation=storage::read(&path).unwrap();interrupted.receipt["state"]=json!("acceptedPending");interrupted.receipt.as_object_mut().unwrap().remove("result");storage::write(&path,&interrupted).unwrap();
            let receipt=client.operation(&id).await.unwrap().unwrap();assert_eq!(receipt["state"],"completed");assert_eq!(client.status().await.unwrap().projects[0].state,"stopped");
            assert!(client.reconnect("test-project").await.is_err());
            let mut nondefault=registration.clone();nondefault.default_binding=false;client.register(&uuid::Uuid::new_v4().to_string(),nondefault).await.unwrap();
            client.bind_registration(&uuid::Uuid::new_v4().to_string(),registration.clone()).await.unwrap();
            assert!(client.list().await.unwrap()[0].default_binding);
            let mapping=home.join("workspaces").join(format!("{}.json",storage::digest(registration.workspace.as_os_str().as_encoded_bytes())));assert_eq!(storage::read::<PathBuf>(&mapping).unwrap(),registration.data_dir);

            let stop_id=uuid::Uuid::new_v4().to_string();let stop=client.stop(&stop_id,&identity.generation,StopStrategy::IfIdle).await.unwrap();assert_eq!(stop["state"],"completed");assert!(matches!(task.await.unwrap().unwrap(),HostExit::Stopped));
            assert!(!home.join("host/host.json").exists());
            let stopped_record=std::fs::read(home.join("host/stop.json")).unwrap();
            assert!(matches!(run_local_mode(RunOptions {home:home.clone(),bin_dir:bin.clone()},true).await.unwrap(),HostExit::Stopped));
            assert!(!home.join("host/host.json").exists());
            assert_eq!(std::fs::read(home.join("host/stop.json")).unwrap(),stopped_record);
            let offline=crate::offline_service_status(&home).unwrap();
            assert_eq!(offline["state"],"stopped");
            assert_eq!(offline["stopIntent"],true);
            assert_eq!(storage::read::<String>(&home.join("host/identity.json")).unwrap(),identity.host_id);
            assert_eq!(crate::operation_offline(&home,&id).unwrap().unwrap(),receipt);
            let restarted=tokio::task::spawn_local(run_local(RunOptions {home:home.clone(),bin_dir:bin}));
            let next=loop {if let Ok(client)=Client::connect_at(home.clone()).await {break client;}tokio::task::yield_now().await;};
            assert_eq!(next.identity().host_id,identity.host_id);assert_ne!(next.identity().generation,identity.generation);assert_eq!(next.list().await.unwrap(),vec![registration]);assert_eq!(next.operation(&id).await.unwrap().unwrap(),receipt);assert_eq!(next.operation(&stop_id).await.unwrap().unwrap()["state"],"completed");assert_eq!(next.status().await.unwrap().state,"running");
            next.stop(&uuid::Uuid::new_v4().to_string(),&next.identity().generation,StopStrategy::IfIdle).await.unwrap();restarted.await.unwrap().unwrap();
        }).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn interrupted_activation_requires_evidence_and_blocks_new_stop_ids() {
        tokio::task::LocalSet::new().run_until(async {
            let root=tempfile::tempdir().unwrap();let home=root.path().canonicalize().unwrap().join("home");let workspace=root.path().join("workspace");std::fs::create_dir(&workspace).unwrap();
            let task=tokio::task::spawn_local(run_local(RunOptions {home:home.clone(),bin_dir:std::env::current_exe().unwrap().parent().unwrap().into()}));
            let client=loop {if let Ok(client)=Client::connect_at(home.clone()).await {break client;}tokio::task::yield_now().await;};
            let registration=ProjectRegistration {project_id:"interrupted".into(),workspace:workspace.canonicalize().unwrap(),data_dir:home.join("data"),source:ProjectSource::Cli,default_binding:false};
            client.register(&uuid::Uuid::new_v4().to_string(),registration.clone()).await.unwrap();
            let request=uuid::Uuid::new_v4().to_string();let instance=Host::service_id(&registration);let owner=Owner::Host {host_id:client.identity().host_id.clone(),generation:uuid::Uuid::new_v4().to_string()};
            let record=Operation {digest:"fixture".into(),receipt:json!({"version":1,"requestId":request,"method":"project.ensure","hostId":client.identity().host_id,"generation":client.identity().generation,"projectId":registration.project_id,"state":"acceptedPending"}),evidence:json!({"serviceId":instance,"fingerprint":"fixture","owner":owner,"registration":registration,"previousService":null})};storage::write(&wire::operation_path(&home,&request),&record).unwrap();
            assert_eq!(client.operation(&request).await.unwrap().unwrap()["state"],"acceptedPending");
            let new_stop=uuid::Uuid::new_v4().to_string();let error=client.stop_project(&new_stop,&registration.project_id,"old",StopStrategy::Cancel).await.unwrap_err();assert!(format!("{error:#}").contains("admissionUnknown"));assert!(client.operation(&new_stop).await.unwrap().is_none());
            let new_host_stop=uuid::Uuid::new_v4().to_string();assert!(client.stop(&new_host_stop,&client.identity().generation,StopStrategy::Cancel).await.is_err());assert!(client.operation(&new_host_stop).await.unwrap().is_none());
            let directory=storage::registry(&home,&instance).unwrap();storage::private_dir(&directory).unwrap();storage::private_dir(&registration.data_dir).unwrap();
            let service:Service=serde_json::from_value(json!({"protocolVersion":1,"serviceId":instance,"generation":uuid::Uuid::new_v4().to_string(),"workspace":registration.workspace,"dataDir":registration.data_dir,"configFingerprint":"fixture","owner":owner,"endpoint":"http://127.0.0.1:1","webUrl":"http://127.0.0.1:1","authFile":directory.join("auth.json"),"logFile":directory.join("host.log"),"hostPid":1,"corePid":1,"state":"stopped"})).unwrap();storage::write(&directory.join("service.json"),&service).unwrap();storage::write(&directory.join("crash.json"),&storage::CrashReceipt {version:1,unexpected_core_exit:true,identity:service.identity.clone(),owner:service.owner.clone(),components:BTreeMap::new(),cleanup_confirmed:true}).unwrap();
            let mut interrupted:Operation=storage::read(&wire::operation_path(&home,&request)).unwrap();interrupted.evidence["previousService"]=serde_json::to_value(&service).unwrap();storage::write(&wire::operation_path(&home,&request),&interrupted).unwrap();
            assert_eq!(client.operation(&request).await.unwrap().unwrap()["state"],"acceptedPending");
            let mut successor=service.clone();successor.identity.generation=uuid::Uuid::new_v4().to_string();storage::write(&directory.join("service.json"),&successor).unwrap();storage::write(&directory.join("crash.json"),&storage::CrashReceipt {version:1,unexpected_core_exit:true,identity:successor.identity.clone(),owner:successor.owner.clone(),components:BTreeMap::new(),cleanup_confirmed:true}).unwrap();
            assert_eq!(client.operation(&request).await.unwrap().unwrap()["state"],"blocked");
            let stop=client.stop(&uuid::Uuid::new_v4().to_string(),&client.identity().generation,StopStrategy::IfIdle).await.unwrap();assert_eq!(stop["state"],"completed");assert!(matches!(task.await.unwrap().unwrap(),HostExit::Stopped));
        }).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn interrupted_ready_activation_settles_only_after_exact_cleanup_and_lock_release() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let mut settled = Vec::new();
                for fingerprint in ["original-config", "replacement-config"] {
                    let root = tempfile::tempdir().unwrap();
                    let home = root.path().canonicalize().unwrap().join("home");
                    let workspace = root.path().join("workspace");
                    std::fs::create_dir(&workspace).unwrap();
                    let task = tokio::task::spawn_local(run_local(RunOptions {
                        home: home.clone(),
                        bin_dir: std::env::current_exe().unwrap().parent().unwrap().into(),
                    }));
                    let client = loop {
                        if let Ok(client) = Client::connect_at(home.clone()).await {
                            break client;
                        }
                        tokio::task::yield_now().await;
                    };
                    let registration = ProjectRegistration {
                        project_id: "interrupted-ready".into(),
                        workspace: workspace.canonicalize().unwrap(),
                        data_dir: home.join("data"),
                        source: ProjectSource::Cli,
                        default_binding: false,
                    };
                    client
                        .register(&uuid::Uuid::new_v4().to_string(), registration.clone())
                        .await
                        .unwrap();
                    let instance = Host::service_id(&registration);
                    let directory = storage::registry(&home, &instance).unwrap();
                    storage::private_dir(&directory).unwrap();
                    storage::private_dir(&registration.data_dir).unwrap();
                    let owner = Owner::Host {
                        host_id: client.identity().host_id.clone(),
                        generation: uuid::Uuid::new_v4().to_string(),
                    };
                    let previous: Service = serde_json::from_value(json!({
                        "protocolVersion": 1,
                        "serviceId": instance,
                        "generation": uuid::Uuid::new_v4().to_string(),
                        "workspace": registration.workspace,
                        "dataDir": registration.data_dir,
                        "configFingerprint": "original-config",
                        "owner": owner,
                        "endpoint": "http://127.0.0.1:1",
                        "webUrl": "http://127.0.0.1:1",
                        "authFile": directory.join("auth.json"),
                        "logFile": directory.join("host.log"),
                        "hostPid": 1,
                        "corePid": 1,
                        "state": "ready"
                    }))
                    .unwrap();
                    let mut stopped = previous.clone();
                    stopped.state = State::Stopped;
                    storage::write(&directory.join("service.json"), &stopped).unwrap();
                    let request = uuid::Uuid::new_v4().to_string();
                    let record = Operation {
                        digest: "fixture".into(),
                        receipt: json!({
                            "version": 1,
                            "requestId": request,
                            "method": "project.ensure",
                            "hostId": client.identity().host_id,
                            "generation": client.identity().generation,
                            "projectId": registration.project_id,
                            "state": "acceptedPending"
                        }),
                        evidence: json!({
                            "serviceId": instance,
                            "fingerprint": fingerprint,
                            "owner": owner,
                            "registration": registration,
                            "previousService": previous
                        }),
                    };
                    storage::write(&wire::operation_path(&home, &request), &record).unwrap();
                    assert_eq!(
                        client.operation(&request).await.unwrap().unwrap()["state"],
                        "acceptedPending"
                    );

                    let mut proof = storage::CrashReceipt {
                        version: 1,
                        unexpected_core_exit: true,
                        identity: stopped.identity.clone(),
                        owner: stopped.owner.clone(),
                        components: BTreeMap::new(),
                        cleanup_confirmed: true,
                    };
                    proof.identity.generation = uuid::Uuid::new_v4().to_string();
                    storage::write(&directory.join("crash.json"), &proof).unwrap();
                    assert_eq!(
                        client.operation(&request).await.unwrap().unwrap()["state"],
                        "acceptedPending"
                    );
                    proof.identity = stopped.identity.clone();
                    storage::write(&directory.join("crash.json"), &proof).unwrap();
                    for lock in ["service.lock", "owner.lock"] {
                        let held =
                            storage::open_private(&registration.data_dir.join(lock), true).unwrap();
                        held.try_lock_exclusive().unwrap();
                        assert_eq!(
                            client.operation(&request).await.unwrap().unwrap()["state"],
                            "acceptedPending",
                            "{fingerprint} with {lock} held"
                        );
                        drop(held);
                    }

                    let receipt = client.operation(&request).await.unwrap().unwrap();
                    settled.push((
                        fingerprint,
                        receipt["state"].clone(),
                        receipt["error"]["code"].clone(),
                    ));
                    assert_eq!(client.operation(&request).await.unwrap().unwrap(), receipt);
                    assert_eq!(
                        storage::read::<Value>(&directory.join("service.json")).unwrap(),
                        serde_json::to_value(&stopped).unwrap()
                    );
                    assert!(!directory.join("launch.json").exists());
                    task.abort();
                    assert!(matches!(task.await, Err(error) if error.is_cancelled()));
                }
                assert_eq!(
                    settled,
                    vec![
                        (
                            "original-config",
                            json!("blocked"),
                            json!("activationInterrupted")
                        ),
                        (
                            "replacement-config",
                            json!("blocked"),
                            json!("activationInterrupted")
                        ),
                    ]
                );
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stop_barrier_closes_pre_admission_awaits_and_reconciliation_observes_busy_slots() {
        tokio::task::LocalSet::new().run_until(async {
            let root=tempfile::tempdir().unwrap();let home=root.path().canonicalize().unwrap().join("home");
            for path in [&home,&home.join("host/operations"),&home.join("host/projects")] {storage::private_dir(path).unwrap();}
            let workspace=root.path().join("workspace");std::fs::create_dir(&workspace).unwrap();let workspace=workspace.canonicalize().unwrap();
            let mut slots=BTreeMap::new();
            for id in ["a","b","c"] {slots.insert(id.into(),Slot {registration:ProjectRegistration {project_id:id.into(),workspace:workspace.clone(),data_dir:home.join(id),source:ProjectSource::Cli,default_binding:false},gate:Arc::new(Mutex::new(())),writer:None,uncertain_start:false,lifetime:None,state:"stopped".into(),service:None,migration:None,credentials:BTreeMap::new()});}
            let (changes,_)=watch::channel(0);let host=Rc::new(Host {home:home.clone(),bin:root.path().into(),identity:HostIdentity {version:1,host_id:uuid::Uuid::new_v4().to_string(),generation:uuid::Uuid::new_v4().to_string(),socket_path:home.join("control.sock"),auth_file:home.join("auth.json"),pid:std::process::id(),executable_version:"fixture".into()},token:"fixture".into(),slots:RefCell::new(slots),stop:RefCell::new(None),host_stop_gate:Mutex::new(()),changes,exit:Notify::new(),migration:crate::migration::Migration::new(&home).unwrap().into(),gateway:gateway_owner::Gateway::default(),subscriptions:subscriptions::Subscriptions::default(),power:power::Power::default(),journal:crate::journal::Journal::new(&home).unwrap(),remote:crate::remote_state::RemoteState::new(&home),schedules:schedules::Schedules::load(&home).unwrap()});
            let registration=host.slots.borrow()["b"].registration.clone();storage::private_dir(&registration.data_dir).unwrap();let instance=Host::service_id(&registration);let directory=storage::registry(&home,&instance).unwrap();storage::private_dir(&directory).unwrap();
            let service:Service=serde_json::from_value(json!({"protocolVersion":1,"serviceId":instance,"generation":uuid::Uuid::new_v4().to_string(),"workspace":workspace,"dataDir":registration.data_dir,"configFingerprint":"fixture","owner":host.owner(),"endpoint":"http://127.0.0.1:1","webUrl":"http://127.0.0.1:1","authFile":directory.join("auth.json"),"logFile":directory.join("host.log"),"hostPid":1,"corePid":1,"state":"stopped"})).unwrap();storage::write(&directory.join("service.json"),&service).unwrap();storage::write(&directory.join("crash.json"),&storage::CrashReceipt {version:1,unexpected_core_exit:true,identity:service.identity.clone(),owner:service.owner.clone(),components:BTreeMap::new(),cleanup_confirmed:true}).unwrap();
            let activation=uuid::Uuid::new_v4().to_string();let record=Operation {digest:"fixture".into(),receipt:json!({"version":1,"requestId":activation,"method":"project.ensure","projectId":"b","state":"acceptedPending"}),evidence:json!({"serviceId":instance,"fingerprint":"fixture","owner":host.owner(),"registration":registration,"previousService":null})};storage::write(&wire::operation_path(&home,&activation),&record).unwrap();
            let held_b=host.gate("b").unwrap().lock_owned().await;
            assert_eq!(host.reconcile(&activation).await.unwrap().unwrap()["state"],"acceptedPending");assert_eq!(host.receipt(&activation).unwrap().unwrap().receipt["state"],"acceptedPending");drop(held_b);
            assert_eq!(host.reconcile(&activation).await.unwrap().unwrap()["state"],"blocked");
            let held_a=host.gate("a").unwrap().lock_owned().await;let startup=storage::open_private(&directory.join("start.lock"),true).unwrap();startup.try_lock_exclusive().unwrap();
            let project_request=uuid::Uuid::new_v4().to_string();let project_host=host.clone();let project_input=Stop {suppress_scheduling:true,request_id:project_request.clone(),expected_generation:host.identity.generation.clone(),strategy:StopStrategy::Cancel,project_id:Some("b".into()),service_generation:Some(service.identity.generation.clone())};
            let stopping_project=tokio::task::spawn_local(async move {project_host.stop_project(project_input).await});
            loop {if host.gate("b").unwrap().try_lock().is_err(){break;}tokio::task::yield_now().await;}
            let host_request=uuid::Uuid::new_v4().to_string();let stopping_host=host.clone();let host_input=Stop {suppress_scheduling:true,request_id:host_request.clone(),expected_generation:host.identity.generation.clone(),strategy:StopStrategy::Cancel,project_id:None,service_generation:None};
            let stopping=tokio::task::spawn_local(async move {stopping_host.stop_host(host_input).await});
            loop {if host.stop.borrow().is_some(){break;}tokio::task::yield_now().await;}
            let original=host.receipt(&host_request).unwrap().unwrap().receipt;assert_eq!(host.reconcile(&host_request).await.unwrap().unwrap(),original);
            let request=uuid::Uuid::new_v4().to_string();let error=host.stop_project(Stop {suppress_scheduling:true,request_id:request.clone(),expected_generation:host.identity.generation.clone(),strategy:StopStrategy::Cancel,project_id:Some("c".into()),service_generation:Some("unused".into())}).await.unwrap_err();assert!(error.to_string().contains("stopInProgress"));assert!(host.receipt(&request).unwrap().is_none());
            drop(startup);assert!(stopping_project.await.unwrap().unwrap_err().to_string().contains("stopInProgress"));assert!(host.receipt(&project_request).unwrap().is_none());drop(held_a);
            assert_eq!(stopping.await.unwrap().unwrap()["state"],"completed");
        }).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn settled_refusals_release_admission_live_and_after_restart_but_unknown_does_not() {
        tokio::task::LocalSet::new().run_until(async {
            for (states,expected,released) in [
                (vec![Some(StopOperationState::Blocked)],"blocked",true),
                (vec![Some(StopOperationState::Completed),Some(StopOperationState::Blocked)],"partial",true),
                (vec![Some(StopOperationState::Blocked),None],"admissionUnknown",false),
            ] {
                let root=tempfile::tempdir().unwrap();let home=root.path().canonicalize().unwrap().join("home");
                storage::private_dir(&home).unwrap();storage::private_dir(&home.join("host/operations")).unwrap();
                let request=uuid::Uuid::new_v4().to_string();let mut targets=Vec::new();
                for (index,state) in states.into_iter().enumerate() {
                    let instance=format!("{index:024x}");let child=uuid::Uuid::new_v4().to_string();let generation=uuid::Uuid::new_v4().to_string();
                    let directory=storage::registry(&home,&instance).unwrap();storage::private_dir(&directory).unwrap();
                    if let Some(state)=state {
                        let service:Service=serde_json::from_value(json!({"protocolVersion":1,"serviceId":instance,"generation":generation,"workspace":root.path(),"dataDir":root.path().join(format!("data-{index}")),"configFingerprint":"fixture","endpoint":"http://127.0.0.1:1","webUrl":"http://127.0.0.1:1","authFile":directory.join("auth.json"),"logFile":directory.join("host.log"),"hostPid":1,"corePid":1,"state":"stopped"})).unwrap();
                        storage::write_stop_receipt(&directory,&storage::StopReceipt {operation:StopOperation {version:1,request_id:child.clone(),service_id:instance.clone(),generation:generation.clone(),cancel:false,state,message:None,lifecycle:None},service,cleanup_confirmed:state==StopOperationState::Completed}).unwrap();
                    }
                    targets.push(json!({"projectId":format!("old-{index}"),"serviceId":instance,"serviceGeneration":generation,"requestId":child,"dispatch":"started","receipt":{"state":"admissionUnknown"}}));
                }
                let receipt=json!({"version":1,"requestId":request,"hostId":uuid::Uuid::new_v4().to_string(),"generation":uuid::Uuid::new_v4().to_string(),"strategy":"ifIdle","state":"admissionUnknown","projects":targets});
                storage::write(&home.join("host/stop.json"),&receipt).unwrap();storage::write(&wire::operation_path(&home,&request),&Operation {digest:"fixture".into(),receipt,evidence:Value::Null}).unwrap();
                let workspace=root.path().join("workspace");std::fs::create_dir(&workspace).unwrap();
                let registration=ProjectRegistration {project_id:"new-project".into(),workspace:workspace.canonicalize().unwrap(),data_dir:home.join("new-data"),source:ProjectSource::Cli,default_binding:false};
                let bin=std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
                let task=tokio::task::spawn_local(run_local(RunOptions {home:home.clone(),bin_dir:bin.clone()}));
                let client=loop {if let Ok(client)=Client::connect_at(home.clone()).await {break client;}if task.is_finished(){panic!("Host exited before connection: {:?}",task.await.unwrap().err());}tokio::task::yield_now().await;};
                assert!(client.status().await.unwrap().stop_intent);
                assert!(client.register(&uuid::Uuid::new_v4().to_string(),registration.clone()).await.is_err());
                let observed=client.operation(&request).await.unwrap().unwrap();assert_eq!(observed["state"],expected);
                assert_eq!(client.status().await.unwrap().stop_intent,!released);
                assert_eq!(client.register(&uuid::Uuid::new_v4().to_string(),registration.clone()).await.is_ok(),released);
                task.abort();assert!(task.await.is_err_and(|error|error.is_cancelled()));
                // 并行用例的 fork 可能短暂继承 CLOEXEC 锁，重启前先证明锁已实际释放。
                let lock=storage::open_private(&home.join("host.lock"),false).unwrap();
                let deadline=tokio::time::Instant::now()+Duration::from_secs(2);
                loop {
                    match lock.try_lock_exclusive() {
                        Ok(())=>{FileExt::unlock(&lock).unwrap();break;},
                        Err(error) if error.kind()==std::io::ErrorKind::WouldBlock=>{},
                        Err(error)=>panic!("Host lock inspection failed: {error}"),
                    }
                    assert!(tokio::time::Instant::now()<deadline,"Host lock remained held after owner exit");
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
                drop(lock);
                let task=tokio::task::spawn_local(run_local(RunOptions {home:home.clone(),bin_dir:bin}));
                let client=loop {if let Ok(client)=Client::connect_at(home.clone()).await {break client;}if task.is_finished(){panic!("Host exited before connection: {:?}",task.await.unwrap().err());}tokio::task::yield_now().await;};
                assert_eq!(client.status().await.unwrap().stop_intent,!released);
                assert_eq!(client.operation(&request).await.unwrap().unwrap()["state"],expected);
                assert_eq!(client.register(&uuid::Uuid::new_v4().to_string(),registration).await.is_ok(),released);
                assert_eq!(crate::operation_offline(&home,&request).unwrap().unwrap()["state"],expected);
                task.abort();assert!(task.await.is_err_and(|error|error.is_cancelled()));
            }
        }).await;
    }

    #[test]
    fn aggregate_keeps_unknown_and_partial_targets_distinct() {
        for state in ["acceptedPending", "settlementIncomplete", "completed"] {
            assert_eq!(
                aggregate(
                    &json!({"projects":[{"receipt":{"state":"completed"}}],"localRelay":{"state":state}})
                ),
                state
            );
        }
        assert_eq!(
            aggregate(
                &json!({"projects":[{"receipt":{"state":"blocked"}}],"localRelay":{"state":"acceptedPending"}})
            ),
            "blocked"
        );
        assert_eq!(
            aggregate(
                &json!({"projects":[{"receipt":{"state":"completed"}},{"dispatch":"notStarted"}]})
            ),
            "partial"
        );
        assert_eq!(
            aggregate(
                &json!({"projects":[{"receipt":{"state":"admissionUnknown"}},{"receipt":{"state":"blocked"}}]})
            ),
            "admissionUnknown"
        );
    }

    #[tokio::test]
    async fn restored_host_does_not_settle_an_old_relay_without_original_exit_evidence() {
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().canonicalize().unwrap();
        let (changes, _) = watch::channel(0);
        let host = Host {
            home: home.clone(),
            bin: home.clone(),
            identity: HostIdentity {
                version: VERSION,
                host_id: "same-host".into(),
                generation: "replacement-generation".into(),
                socket_path: home.join("socket"),
                auth_file: home.join("auth"),
                pid: std::process::id(),
                executable_version: "fixture".into(),
            },
            token: "fixture".into(),
            slots: RefCell::new(BTreeMap::new()),
            stop: RefCell::new(None),
            host_stop_gate: Mutex::new(()),
            changes,
            exit: Notify::new(),
            migration: crate::migration::Migration::new(&home).unwrap().into(),
            journal: crate::journal::Journal::new(&home).unwrap(),
            remote: crate::remote_state::RemoteState::new(&home),
            gateway: gateway_owner::Gateway::default(),
            subscriptions: subscriptions::Subscriptions::default(),
            schedules: schedules::Schedules::load(&home).unwrap(),
            power: power::Power::default(),
        };
        let mut original = json!({"requestId":"original-stop","hostId":"same-host","generation":"original-generation","projects":[],"localRelay":{"state":"acceptedPending"}});
        host.settle_local_relay(&mut original).await;
        assert_eq!(original["localRelay"]["state"], "settlementIncomplete");
        assert_eq!(aggregate(&original), "settlementIncomplete");
        let mut completed = original.clone();
        completed["localRelay"]["state"] = json!("completed");
        host.settle_local_relay(&mut completed).await;
        assert_eq!(completed["localRelay"]["state"], "completed");
        let mut current = original.clone();
        current["generation"] = json!(host.identity.generation);
        host.settle_local_relay(&mut current).await;
        assert_eq!(current["localRelay"]["state"], "completed");
    }
}
