use super::*;
use crate::gateway::{
    relay::{RelayConfig, RelayEvent, RelayHandle, RelayOwner},
    wire,
};
use tokio::task::JoinSet;
#[path = "control.rs"]
mod control;
#[path = "enrollment.rs"]
mod enrollment;
#[path = "legacy.rs"]
mod legacy;
#[path = "push.rs"]
mod push;
#[path = "session.rs"]
mod session;

#[derive(Default)]
pub(super) struct Gateway {
    generation: RefCell<String>,
    status: RefCell<Value>,
    pub pending: std::cell::Cell<usize>,
    pub peers: RefCell<BTreeMap<String, usize>>,
    active: RefCell<BTreeMap<String, ActiveSession>>,
    last_seen: RefCell<BTreeMap<String, u64>>,
    invite: RefCell<Option<Invite>>,
    pairs: RefCell<BTreeMap<String, PendingPair>>,
    counters: Arc<crate::gateway::relay::Counters>,
    direct: RefCell<Option<crate::gateway::direct::DirectHandle>>,
    prepared_direct: RefCell<Option<DirectRunning>>,
    direct_error: RefCell<String>,
    push_supported: std::cell::Cell<bool>,
    push_diagnostic: RefCell<String>,
    completions: RefCell<BTreeMap<String, push::Completion>>,
    completion_changed: Notify,
    sending: Rc<RefCell<std::collections::BTreeSet<String>>>,
}
struct Invite {
    request_id: String,
    digest: String,
    secret: String,
    expires_at: u64,
    transport: String,
}
#[derive(Clone)]
struct PendingPair {
    id: String,
    name: String,
    client_kind: Option<String>,
    expires_at: u64,
    previous_revision: u64,
    signal: Rc<Notify>,
    rejected: Rc<std::cell::Cell<Option<&'static str>>>,
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
#[derive(Clone, Copy)]
pub(super) enum TransportKind {
    Relay,
    Direct,
}
pub(super) struct Admission {
    generation: String,
    kind: TransportKind,
    transport: String,
    close: Rc<dyn Fn()>,
}
struct ActiveSession {
    peer: String,
    kind: TransportKind,
    revision: Value,
    transport: String,
    close: Rc<dyn Fn()>,
}
pub(super) fn transport_key(config: &Value, kind: TransportKind) -> String {
    let fields: &[&str] = match kind {
        TransportKind::Relay => &[
            "identity",
            "enabled",
            "relay",
            "relayProtocol",
            "room",
            "capability",
            "relayLocal",
        ],
        TransportKind::Direct => &["identity", "directEnabled", "directPort", "network"],
    };
    let transport = fields
        .iter()
        .filter_map(|key| {
            config
                .get(*key)
                .map(|value| ((*key).to_owned(), value.clone()))
        })
        .collect::<serde_json::Map<_, _>>();
    storage::digest(&serde_json::to_vec(&transport).unwrap())
}
impl Gateway {
    pub fn current(&self, generation: &str) -> bool {
        self.generation.borrow().as_str() == generation
    }
    pub fn status(&self) -> Value {
        let mut status = self.status.borrow().clone();
        if let Some(status) = status.as_object_mut() {
            status.insert("pushSupported".into(), json!(self.push_supported.get()));
            status.insert(
                "pushDiagnostic".into(),
                json!(self.push_diagnostic.borrow().as_str()),
            );
        }
        status
    }
    fn cancel_pair(&self) {
        *self.invite.borrow_mut() = None;
        for pair in self.pairs.borrow().values() {
            pair.rejected.set(Some("PAIRING_CANCELLED"));
            pair.signal.notify_one();
        }
    }
    fn claim(&self, peer: &str, hello: &Value, config: &Value) -> Result<PendingPair> {
        use subtle::ConstantTimeEq;
        let mut active = self.invite.borrow_mut();
        let invite = active.as_ref().context("PAIRING_USED")?;
        ensure!(invite.expires_at > now_ms(), "PAIRING_EXPIRED");
        let secret = hello["inviteSecret"]
            .as_str()
            .filter(|secret| {
                secret.len() == 64
                    && secret
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            })
            .context("FORBIDDEN")?;
        ensure!(
            bool::from(secret.as_bytes().ct_eq(invite.secret.as_bytes())),
            "FORBIDDEN"
        );
        let pair = PendingPair {
            id: uuid::Uuid::new_v4().to_string(),
            name: hello["displayName"].as_str().unwrap().into(),
            client_kind: hello["clientKind"].as_str().map(str::to_owned),
            expires_at: invite.expires_at,
            previous_revision: config["deviceGrants"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|grant| grant["devicePeerId"] == peer)
                .and_then(|grant| grant["revision"].as_u64())
                .unwrap_or(0),
            signal: Rc::new(Notify::new()),
            rejected: Rc::new(std::cell::Cell::new(None)),
        };
        *active = None;
        self.pairs.borrow_mut().insert(peer.into(), pair.clone());
        Ok(pair)
    }
    pub fn refresh_config(&self, config: &Value) {
        for active in self.active.borrow().values() {
            if active.transport != transport_key(config, active.kind)
                || grant(config, &active.peer)
                    .is_none_or(|grant| grant["revision"] != active.revision)
            {
                (active.close)();
            }
        }
        for pair in self.pairs.borrow().values() {
            pair.signal.notify_one();
        }
    }
}
pub(super) fn grant(config: &Value, peer: &str) -> Option<Value> {
    config["deviceGrants"]
        .as_array()?
        .iter()
        .find(|grant| {
            grant["devicePeerId"] == peer
                && grant["status"] == "active"
                && grant["projectIds"].is_array()
                && grant["capabilities"]
                    .as_array()
                    .is_some_and(|caps| caps.iter().any(|cap| cap == "observe"))
        })
        .cloned()
}
fn relay(config: &Value) -> Result<Option<RelayConfig>> {
    if config["enabled"] != true {
        return Ok(None);
    }
    ensure!(
        config["relayProtocol"] == "areal.remote.v2",
        "unsupported Relay protocol"
    );
    let mut origin = url::Url::parse(
        config["relay"]
            .as_str()
            .context("Remote Relay origin missing")?,
    )?;
    ensure!(
        origin.username().is_empty()
            && origin.password().is_none()
            && origin.query().is_none()
            && origin.fragment().is_none()
            && origin.path() == "/",
        "invalid Relay origin"
    );
    ensure!(origin.scheme() == "https", "Relay requires HTTPS");
    origin
        .set_scheme("wss")
        .map_err(|_| anyhow::anyhow!("Relay scheme"))?;
    origin.set_path("/remote/socket");
    Ok(Some(RelayConfig {
        url: origin.to_string(),
        room: config["room"]
            .as_str()
            .context("Relay room missing")?
            .into(),
        capability: config["capability"]
            .as_str()
            .context("Relay capability missing")?
            .into(),
        local_host: None,
    }))
}
struct Running {
    handle: RelayHandle,
    tasks: JoinSet<()>,
    events: tokio::sync::mpsc::Receiver<RelayEvent>,
    identity: Rc<wire::Identity>,
    transport: String,
    attention: Rc<Mutex<push::Attention>>,
    scanning: Rc<std::cell::Cell<bool>>,
    last_scan: std::time::Instant,
    commands: std::collections::BTreeSet<String>,
}
impl Drop for Running {
    fn drop(&mut self) {
        self.handle.stop();
        self.tasks.abort_all();
    }
}
async fn run_relay(host: Rc<Host>) {
    let mut running: Option<Running> = None;
    let mut terminal_transport = None;
    let mut observed_revision = None;
    loop {
        let previous_status = host.gateway.status();
        let snapshot = host.remote.snapshot(&host.migration);
        let desired = snapshot
            .as_ref()
            .ok()
            .filter(|_| host.remote.native_owner().ok().flatten().is_some());
        let transport =
            desired.map(|snapshot| transport_key(&snapshot["config"], TransportKind::Relay));
        if let Some(snapshot) = desired {
            if host.gateway.generation.borrow().is_empty() {
                *host.gateway.generation.borrow_mut() = uuid::Uuid::new_v4().to_string();
            }
            if observed_revision != snapshot["revision"].as_u64() {
                host.gateway.refresh_config(&snapshot["config"]);
                observed_revision = snapshot["revision"].as_u64();
            }
        }
        if snapshot.is_err() && host.remote.native_owner().ok().flatten().is_some() {
            *host.gateway.status.borrow_mut() =
                json!({"owner":"native","connected":false,"state":"unavailable"});
        }
        if running
            .as_ref()
            .is_some_and(|running| Some(&running.transport) != transport.as_ref())
        {
            running = None;
            host.gateway.push_supported.set(false);
        }
        if running.is_none() && terminal_transport != transport {
            if let Some(snapshot) = desired {
                let config = &snapshot["config"];
                let startup = (|| -> Result<_> {
                    let Some(configured) = relay(config)? else {
                        return Ok(None);
                    };
                    let identity = Rc::new(wire::Identity::from_base64(
                        config["identity"]
                            .as_str()
                            .context("Remote identity missing")?,
                    )?);
                    let (owner, handle, events) =
                        RelayOwner::with_counters(configured, host.gateway.counters.clone());
                    let mut tasks = JoinSet::new();
                    tasks.spawn_local(owner.run());
                    Ok(Some(Running {
                        handle,
                        tasks,
                        events,
                        identity,
                        transport: transport_key(config, TransportKind::Relay),
                        attention: Rc::new(Mutex::new(push::Attention::default())),
                        scanning: Rc::new(std::cell::Cell::new(false)),
                        last_scan: std::time::Instant::now() - Duration::from_secs(5),
                        commands: std::collections::BTreeSet::new(),
                    }))
                })();
                match startup {
                    Ok(next) => {
                        running = next;

                        *host.gateway.status.borrow_mut() = json!({"owner":"native","connected":false,"state":if running.is_some(){"connecting"}else{"disabled"}});
                    }
                    Err(_) => {
                        *host.gateway.status.borrow_mut() =
                            json!({"owner":"native","connected":false,"state":"unavailable"});
                    }
                }
            }
        }
        let event = async {
            match &mut running {
                Some(running) => running.events.recv().await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            event=event=>{
                let Some(event)=event else{running=None;host.gateway.push_supported.set(false);continue;};
                match event{
                    RelayEvent::Ready{push,..}=>{host.gateway.push_supported.set(push);*host.gateway.status.borrow_mut()=json!({"owner":"native","connected":true,"state":"ready"});},
                    RelayEvent::Channel{generation: relay_generation, id, stream}=>{
                        let current=running.as_mut().unwrap();
                        let host=host.clone();let identity=current.identity.clone();let generation=host.gateway.generation.borrow().clone();
                        let handle = current.handle.clone();
                        let close = Rc::new(move || handle.abort(relay_generation, &id));
                        let admission = Admission { generation, kind:TransportKind::Relay, transport:current.transport.clone(), close };
                        current.tasks.spawn_local(async move{let _=session::Session::run(host,stream,identity,admission).await;});
                    },
                    RelayEvent::Disconnected{retry,..}=>{host.gateway.push_supported.set(false);if !retry {terminal_transport = running.as_ref().map(|running| running.transport.clone());} *host.gateway.status.borrow_mut()=json!({"owner":"native","connected":false,"state":if retry{"reconnecting"}else{"unavailable"}});},
                    RelayEvent::PushUnregistered(token)=>{if push::unregister_token(&host,&token).is_err(){*host.gateway.push_diagnostic.borrow_mut()="push-unregister-unavailable".into();}},
                    RelayEvent::PushDropped=>{*host.gateway.push_diagnostic.borrow_mut()="push-dropped".into();},
                }
            },
            _=tokio::time::sleep(Duration::from_millis(250))=>{},
            _=host.gateway.completion_changed.notified()=>{},
        }
        if host.gateway.status() != previous_status {
            host.changed();
        }
        if let Some(running) = &mut running {
            if host.gateway.push_supported.get()
                && !running.scanning.get()
                && running.last_scan.elapsed() >= Duration::from_secs(5)
            {
                running.last_scan = std::time::Instant::now();
                running.scanning.set(true);
                let slot = push::ScanSlot(running.scanning.clone());
                let attention = running.attention.clone();
                let host = host.clone();
                let handle = running.handle.clone();
                let transport = running.transport.clone();
                let generation = host.gateway.generation.borrow().clone();
                running.tasks.spawn_local(async move {
                    let _slot = slot;
                    push::historical(&host).await;
                    if attention
                        .lock()
                        .await
                        .tick(host.clone(), handle, transport, generation)
                        .await
                        .is_err()
                    {
                        *host.gateway.push_diagnostic.borrow_mut() = "push-scan-unavailable".into();
                    }
                });
            }
            push::start_completions(&host, running);
            while running.tasks.try_join_next().is_some() {}
        }
    }
}

struct DirectRunning {
    owner: Option<crate::gateway::direct::DirectOwner>,
    handle: crate::gateway::direct::DirectHandle,
    events: tokio::sync::mpsc::Receiver<crate::gateway::direct::DirectEvent>,
    identity: Rc<wire::Identity>,
    transport: String,
    tasks: JoinSet<()>,
}
impl Drop for DirectRunning {
    fn drop(&mut self) {
        self.handle.stop();
        self.tasks.abort_all();
    }
}
async fn prepare_direct(
    host: Rc<Host>,
    config: &Value,
    root: &std::path::Path,
) -> Result<DirectRunning> {
    use crate::gateway::direct::{Assets, DirectOwner};
    let assets = Rc::new(Assets::load(root)?);
    let port = config
        .get("directPort")
        .map(|port| {
            port.as_u64()
                .filter(|port| *port <= 65535)
                .context("invalid Direct port")
        })
        .transpose()?
        .unwrap_or(0) as u16;
    let identity = Rc::new(wire::Identity::from_base64(
        config["identity"]
            .as_str()
            .context("Remote identity missing")?,
    )?);
    let external = if config["network"]["kind"] == "organization" {
        config["network"]["publicOrigin"]
            .as_str()
            .map(str::to_owned)
    } else {
        None
    };
    let weak = Rc::downgrade(&host);
    let admit = Rc::new(move || {
        weak.upgrade().is_some_and(|host| {
            host.admission().is_ok()
                && host.gateway.pending.get() < 8
                && host.gateway.pending.get() + host.gateway.active.borrow().len() < 16
        })
    });
    let (owner, handle, events) =
        DirectOwner::bind(port, assets, external, host.gateway.counters.clone(), admit).await?;
    Ok(DirectRunning {
        owner: Some(owner),
        handle,
        events,
        identity,
        transport: transport_key(config, TransportKind::Direct),
        tasks: JoinSet::new(),
    })
}
fn asset_root(host: &Host) -> Result<PathBuf> {
    host.remote
        .native_owner()?
        .and_then(|receipt| receipt["assetRoot"].as_str().map(PathBuf::from))
        .context("Remote assets are missing")
}
async fn run_direct(host: Rc<Host>) {
    let mut running: Option<DirectRunning> = None;
    let mut attempted = None;
    loop {
        let snapshot = host
            .remote
            .snapshot(&host.migration)
            .ok()
            .filter(|_| host.remote.native_owner().ok().flatten().is_some());
        let desired = snapshot
            .as_ref()
            .filter(|snapshot| snapshot["config"]["directEnabled"] == true);
        let transport =
            desired.map(|snapshot| transport_key(&snapshot["config"], TransportKind::Direct));
        if running
            .as_ref()
            .is_some_and(|running| Some(&running.transport) != transport.as_ref())
        {
            if let Some(mut previous) = running.take() {
                previous.handle.stop();
                previous.tasks.abort_all();
                while previous.tasks.join_next().await.is_some() {}
            }
            *host.gateway.direct.borrow_mut() = None;
            host.changed();
        }
        let prepared = host.gateway.prepared_direct.borrow_mut().take();
        if let Some(prepared) = prepared {
            if Some(&prepared.transport) == transport.as_ref() {
                running = Some(prepared);
                attempted = transport.clone();
            }
        }
        if running.is_none() && attempted != transport {
            attempted = transport.clone();
            if let Some(snapshot) = desired {
                let next = match asset_root(&host) {
                    Ok(root) => prepare_direct(host.clone(), &snapshot["config"], &root).await,
                    Err(error) => Err(error),
                };
                match next {
                    Ok(next) => {
                        running = Some(next);
                        host.gateway.direct_error.borrow_mut().clear();
                    }
                    Err(_) => {
                        *host.gateway.direct_error.borrow_mut() = "本机入口暂不可用".into();
                        host.changed();
                    }
                }
            }
        }
        if let Some(current) = &mut running {
            if let Some(owner) = current.owner.take() {
                *host.gateway.direct.borrow_mut() = Some(current.handle.clone());
                host.gateway.direct_error.borrow_mut().clear();
                current.tasks.spawn_local(owner.run());
                host.changed();
            }
        }
        tokio::select! {
            event = async { match &mut running { Some(current) => current.events.recv().await, None => std::future::pending().await } } => {
                let Some(crate::gateway::direct::DirectEvent::Channel {stream,close}) = event else { running=None; *host.gateway.direct.borrow_mut()=None;host.changed();continue; };
                let current = running.as_mut().unwrap();
                let admission = Admission { generation:host.gateway.generation.borrow().clone(),kind:TransportKind::Direct,transport:current.transport.clone(),close };
                let host=host.clone();let identity=current.identity.clone();
                current.tasks.spawn_local(async move { let _=session::Session::run(host,stream,identity,admission).await; });
            },
            _ = tokio::time::sleep(Duration::from_millis(250)) => {},
        }
        if let Some(current) = &mut running {
            while current.tasks.try_join_next().is_some() {}
        }
    }
}
pub(super) async fn run(host: Rc<Host>) {
    tokio::join!(run_relay(host.clone()), run_direct(host));
}
