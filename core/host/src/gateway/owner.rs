use super::*;
use crate::gateway::{
    relay::{RelayConfig, RelayEvent, RelayHandle, RelayOwner},
    wire,
};
use tokio::task::JoinSet;
#[path = "control.rs"]
mod control;
#[path = "session.rs"]
mod session;

#[derive(Default)]
pub(super) struct Gateway {
    generation: RefCell<String>,
    status: RefCell<Value>,
    pub pending: std::cell::Cell<usize>,
    pub peers: RefCell<BTreeMap<String, usize>>,
    active: RefCell<BTreeMap<String, ActiveSession>>,
    invite: RefCell<Option<Invite>>,
    pairs: RefCell<BTreeMap<String, PendingPair>>,
    counters: Arc<crate::gateway::relay::Counters>,
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
        self.status.borrow().clone()
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
}
impl Drop for Running {
    fn drop(&mut self) {
        self.handle.stop();
        self.tasks.abort_all();
    }
}
pub(super) async fn run(host: Rc<Host>) {
    let mut running: Option<Running> = None;
    let mut terminal_transport = None;
    let mut observed_revision = None;
    loop {
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
                let Some(event)=event else{running=None;continue;};
                match event{
                    RelayEvent::Ready{..}=>{*host.gateway.status.borrow_mut()=json!({"owner":"native","connected":true,"state":"ready"});},
                    RelayEvent::Channel{generation: relay_generation, id, stream}=>{
                        let current=running.as_mut().unwrap();
                        let host=host.clone();let identity=current.identity.clone();let generation=host.gateway.generation.borrow().clone();
                        let handle = current.handle.clone();
                        let close = Rc::new(move || handle.abort(relay_generation, &id));
                        let admission = Admission { generation, kind:TransportKind::Relay, transport:current.transport.clone(), close };
                        current.tasks.spawn_local(async move{let _=session::Session::run(host,stream,identity,admission).await;});
                    },
                    RelayEvent::Disconnected{retry,..}=>{if !retry {terminal_transport = running.as_ref().map(|running| running.transport.clone());} *host.gateway.status.borrow_mut()=json!({"owner":"native","connected":false,"state":if retry{"reconnecting"}else{"unavailable"}});},
                    RelayEvent::PushUnregistered(_)|RelayEvent::PushDropped=>{},
                }
            },
            _=tokio::time::sleep(Duration::from_millis(250))=>{},
        }
        if let Some(running) = &mut running {
            while running.tasks.try_join_next().is_some() {}
        }
    }
}
