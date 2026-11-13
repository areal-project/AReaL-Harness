#[path = "web_http.rs"]
mod http;
use super::Host;
use crate::{VERSION, wire};
use anyhow::{Context, Result, ensure};
use areal_local_service::storage;
use areal_protocol::host as protocol;
use areal_protocol::host::{
    LocalWebTicketParams, LocalWebTicketResult, LoopbackEndpoint, LoopbackHelloParams,
};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::{BodyExt, Full, Limited};
use hyper::{Request, Response, body::Incoming, service::service_fn};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    convert::Infallible,
    io::Read,
    path::{Path, PathBuf},
    rc::Rc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::oneshot,
    task::JoinSet,
    time::Instant,
};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{
        Message,
        protocol::{Role, WebSocketConfig},
    },
};

const METHODS: &[&str] = &[
    "host.status",
    "shell.subscribe",
    "shell.unsubscribe",
    "session.open",
    "session.watch",
    "session.openPersisted",
    "session.history",
    "subscription.close",
    "artifact.read",
];
// 桌面票据连接协商 gui-write-v1 后可用；沿用远程封装，由 Gateway 的本机主体执行。
const WRITE_METHODS: &[&str] = &[
    "session.create",
    "session.send",
    "session.control",
    "turn.stop",
    "interaction.respond",
    "task.pause",
    "task.question.reply",
    "task.read",
    "task.question.read",
    "review.read",
    "attention.read",
    "project.models",
    "command.read",
    "attachment.upload",
    "analytics.activity",
    "analytics.import",
    "analytics.read",
    "analytics.sync",
    "library.command",
    "worktree.read",
    "tasks.read",
    "trajectory.read",
    "trajectory.command",
    "feedback.read",
    "feedback.command",
    "manage.read",
    "manage.command",
    "providers.read",
    "providers.command",
    "plugins.read",
    "plugins.command",
    "worktree.command",
    "pages.command",
    "pages.resource",
    "desktop.command",
];
const TTL: Duration = Duration::from_secs(30);
const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_TICKETS: usize = 64;
const MAX_CONNECTIONS: usize = 32;
const MAX_WATCHED: usize = 4;
const ELECTRON_ORIGIN: &str = "areal-ui://app";
type Socket = WebSocketStream<TokioIo<hyper::upgrade::Upgraded>>;
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserBinding {
    host_id: String,
    port: u16,
}

fn ui_root(bin: &Path) -> Option<PathBuf> {
    [
        bin.join("../../areal-gui"),
        bin.join("../share/areal-gui"),
        bin.join("../../clients/gui/renderer/dist"),
    ]
    .into_iter()
    .find_map(|candidate| {
        let root = candidate.canonicalize().ok()?;
        root.join("index.html").is_file().then_some(root)
    })
}

struct Ticket {
    device_id: Option<String>,
    origin: String,
    generation: String,
    deadline: Instant,
}
struct PageConnection {
    host: Rc<Host>,
    connection: String,
}
impl Drop for PageConnection {
    fn drop(&mut self) {
        self.host
            .gateway
            .workbench
            .disconnect_pages(&self.connection);
    }
}
#[derive(Default)]
pub(super) struct Loopback {
    endpoint: RefCell<Option<LoopbackEndpoint>>,
    tickets: RefCell<BTreeMap<String, Ticket>>,
    browser: RefCell<Option<crate::browser_auth::BrowserAuth>>,
    ui_root: RefCell<Option<PathBuf>>,
}
impl Loopback {
    pub(super) fn page_proxy_url(&self) -> Result<String> {
        Ok(format!(
            "{}/host/pages/proxy",
            self.endpoint
                .borrow()
                .as_ref()
                .context("CAPABILITY_UNAVAILABLE")?
                .origin
        ))
    }
    pub(super) fn ticket(&self, input: LocalWebTicketParams) -> Result<LocalWebTicketResult> {
        self.mint_ticket(input, None)
    }
    fn mint_ticket(
        &self,
        input: LocalWebTicketParams,
        device_id: Option<String>,
    ) -> Result<LocalWebTicketResult> {
        let endpoint = self.endpoint.borrow();
        let endpoint = endpoint
            .as_ref()
            .ok_or_else(|| wire::error("unavailable", "loopback transport is disabled"))?;
        ensure!(
            input.expected_generation == endpoint.generation,
            wire::error("generationMismatch", "Host generation changed")
        );
        ensure!(
            input.origin == ELECTRON_ORIGIN || input.origin == endpoint.origin,
            wire::error("invalidOrigin", "origin is not allowed")
        );
        let mut tickets = self.tickets.borrow_mut();
        tickets.retain(|_, ticket| ticket.deadline > Instant::now());
        ensure!(
            tickets.len() < MAX_TICKETS,
            wire::error("resourceLimit", "too many pending tickets")
        );
        let mut random = [0u8; 32];
        std::fs::File::open("/dev/urandom")?.read_exact(&mut random)?;
        let ticket = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        tickets.insert(
            storage::digest(ticket.as_bytes()),
            Ticket {
                device_id,
                origin: input.origin.clone(),
                generation: endpoint.generation.clone(),
                deadline: Instant::now() + TTL,
            },
        );
        Ok(LocalWebTicketResult {
            version: VERSION.into(),
            host_id: endpoint.host_id.clone(),
            generation: endpoint.generation.clone(),
            origin: input.origin,
            websocket_url: endpoint.websocket_url.clone(),
            ticket,
            expires_at: (SystemTime::now().duration_since(UNIX_EPOCH)? + TTL).as_millis() as u64,
            preferred_source_id: None,
        })
    }
    pub(super) fn endpoint(&self) -> Result<LoopbackEndpoint> {
        self.endpoint
            .borrow()
            .clone()
            .context("loopback unavailable")
    }
    pub(super) fn approve(&self, host: &Host, params: Value) -> Result<Value> {
        let input: protocol::LocalWebApproveParams = serde_json::from_value(params.clone())?;
        ensure!(
            input.expected_generation == host.identity.generation,
            wire::error("generationMismatch", "Host generation changed")
        );
        self.browser
            .borrow_mut()
            .as_mut()
            .context("loopback unavailable")?
            .approve(&input.request_id, &params["scopes"])
    }
    pub(super) fn devices(&self) -> Result<Value> {
        Ok(self
            .browser
            .borrow()
            .as_ref()
            .context("loopback unavailable")?
            .devices())
    }
    pub(super) fn revoke(&self, host: &Host, params: Value) -> Result<Value> {
        let input: protocol::LocalWebRevokeParams = serde_json::from_value(params)?;
        ensure!(
            input.expected_generation == host.identity.generation,
            wire::error("generationMismatch", "Host generation changed")
        );
        let result = self
            .browser
            .borrow_mut()
            .as_mut()
            .context("loopback unavailable")?
            .revoke(&input.device_id)?;
        self.tickets
            .borrow_mut()
            .retain(|_, ticket| ticket.device_id.as_deref() != Some(input.device_id.as_str()));
        host.changed();
        Ok(result)
    }
    pub(crate) fn browser_permits(&self, device_id: &str, capability: &str) -> bool {
        self.browser
            .borrow()
            .as_ref()
            .is_some_and(|auth| auth.permits(device_id, capability))
    }
    fn browser_method_permitted(&self, device_id: &str, method: &str) -> bool {
        let capability = match method {
            "session.create" | "session.send" | "session.control" | "attachment.upload" => "submit",
            "turn.stop" => "interrupt",
            "interaction.respond" | "task.question.reply" => "answer",
            "task.pause" => "pauseTask",
            "library.command" | "analytics.import" | "worktree.read" | "worktree.command"
            | "tasks.read" | "trajectory.read" | "trajectory.command" | "feedback.read"
            | "feedback.command" | "manage.read" | "manage.command" | "providers.read"
            | "providers.command" | "plugins.read" | "plugins.command" | "pages.command"
            | "pages.resource" | "desktop.command" => "manage",
            _ if WRITE_METHODS.contains(&method) => "observe",
            _ => return false,
        };
        self.browser_permits(device_id, capability)
    }
    fn browser_scopes(&self, device_id: &str) -> Result<Value> {
        self.browser
            .borrow()
            .as_ref()
            .and_then(|auth| auth.scopes(device_id))
            .context("FORBIDDEN")
    }
    fn current(&self, device_id: Option<&str>) -> bool {
        device_id.is_none_or(|id| {
            self.browser
                .borrow()
                .as_ref()
                .is_some_and(|auth| auth.current(id))
        })
    }
    fn consume(&self, secret: &str, origin: &str, generation: &str) -> Result<Option<String>> {
        ensure!(secret.len() == 64, "authentication failed");
        let key = storage::digest(secret.as_bytes());
        let mut tickets = self.tickets.borrow_mut();
        let ticket = tickets.get(&key).context("authentication failed")?;
        ensure!(
            ticket.deadline > Instant::now()
                && ticket.origin == origin
                && ticket.generation == generation
                && self.current(ticket.device_id.as_deref()),
            "authentication failed"
        );
        Ok(tickets.remove(&key).unwrap().device_id)
    }
}

pub(super) struct Listener {
    host: Rc<Host>,
    listener: Option<TcpListener>,
    connections: JoinSet<()>,
}
impl Drop for Listener {
    fn drop(&mut self) {
        self.connections.abort_all();
        self.host.loopback.tickets.borrow_mut().clear();
        self.host.loopback.endpoint.borrow_mut().take();
        self.host.loopback.browser.borrow_mut().take();
        self.host.loopback.ui_root.borrow_mut().take();
        let path = self.host.home.join("host/endpoint.json");
        if storage::read_optional::<LoopbackEndpoint>(&path)
            .ok()
            .flatten()
            .is_some_and(|endpoint| endpoint.generation == self.host.identity.generation)
        {
            let _ = std::fs::remove_file(path);
        }
    }
}
pub(super) async fn bind(host: Rc<Host>, enabled: bool) -> Result<Listener> {
    let path = host.home.join("host/endpoint.json");
    // host.lock 在整个监听器生命周期中保持持有，旧代描述不会与新代并发写入。
    if storage::read_optional::<LoopbackEndpoint>(&path)?.is_some() {
        std::fs::remove_file(&path)?;
    }
    let listener = if enabled {
        let previous: Option<BrowserBinding> =
            storage::read_optional(&host.home.join("host/web-bind.json"))?;
        let port = previous
            .filter(|binding| binding.host_id == host.identity.host_id)
            .map_or(0, |binding| binding.port);
        let listener = match TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await {
            Ok(listener) => listener,
            Err(error) if port != 0 && error.kind() == std::io::ErrorKind::AddrInUse => {
                TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?
            }
            Err(error) => return Err(error.into()),
        };
        let authority = listener.local_addr()?.to_string();
        storage::write(
            &host.home.join("host/web-bind.json"),
            &BrowserBinding {
                host_id: host.identity.host_id.clone(),
                port: listener.local_addr()?.port(),
            },
        )?;
        let endpoint = LoopbackEndpoint {
            version: VERSION.into(),
            host_id: host.identity.host_id.clone(),
            generation: host.identity.generation.clone(),
            origin: format!("http://{authority}"),
            websocket_url: format!("ws://{authority}/host/socket"),
        };
        storage::write(&path, &endpoint)?;
        *host.loopback.browser.borrow_mut() = Some(crate::browser_auth::BrowserAuth::new(
            &host.home,
            &host.identity.host_id,
        )?);
        *host.loopback.ui_root.borrow_mut() = ui_root(&host.bin);
        *host.loopback.endpoint.borrow_mut() = Some(endpoint);
        Some(listener)
    } else {
        None
    };
    Ok(Listener {
        host,
        listener,
        connections: JoinSet::new(),
    })
}
impl Listener {
    pub(super) async fn run(&mut self) -> Result<()> {
        let Some(listener) = &self.listener else {
            return std::future::pending().await;
        };
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let (stream, peer) = accepted?;
                    while self.connections.try_join_next().is_some() {}
                    if !peer.ip().is_loopback() || self.connections.len() >= MAX_CONNECTIONS { continue; }
                    let host = self.host.clone();
                    self.connections.spawn_local(async move { let _ = connection(host, stream).await; });
                }
                _ = self.connections.join_next(), if !self.connections.is_empty() => {}
            }
        }
    }
}
async fn connection(host: Rc<Host>, stream: TcpStream) -> Result<()> {
    let endpoint = host
        .loopback
        .endpoint
        .borrow()
        .clone()
        .context("loopback disabled")?;
    let authority = endpoint
        .origin
        .strip_prefix("http://")
        .context("loopback authority")?
        .to_owned();
    let (sender, receiver) = oneshot::channel();
    let sender = Rc::new(RefCell::new(Some(sender)));
    let http_host = host.clone();
    let service = service_fn(move |mut request: Request<Incoming>| {
        let authority = authority.clone();
        let endpoint = endpoint.clone();
        let sender = sender.clone();
        let host = http_host.clone();
        async move {
            let valid = request.uri().query().is_none()
                && request.uri().authority().is_none()
                && request.headers().get_all("host").iter().count() == 1
                && request.headers().get("host").and_then(|v| v.to_str().ok())
                    == Some(authority.as_str());
            if !valid {
                return Ok::<_, Infallible>(
                    Response::builder()
                        .status(403)
                        .body(Full::new(Bytes::new()))
                        .unwrap(),
                );
            }
            if request.uri().path() != "/host/socket" {
                return Ok(http::request(&host, &endpoint, request).await);
            }
            let origin = request
                .headers()
                .get("origin")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_owned();
            let valid = request.headers().get_all("origin").iter().count() == 1
                && (origin == ELECTRON_ORIGIN || origin == endpoint.origin);
            let mut handshake = Request::builder()
                .method(request.method())
                .uri(request.uri())
                .version(request.version())
                .body(())
                .unwrap();
            *handshake.headers_mut() = request.headers().clone();
            let response = valid
                .then(|| {
                    tokio_tungstenite::tungstenite::handshake::server::create_response(&handshake)
                        .ok()
                })
                .flatten();
            let response =
                if let (Some(response), Some(sender)) = (response, sender.borrow_mut().take()) {
                    let _ = sender.send((hyper::upgrade::on(&mut request), origin));
                    response.map(|_| Full::new(Bytes::new()))
                } else {
                    Response::builder()
                        .status(403)
                        .body(Full::new(Bytes::new()))
                        .unwrap()
                };
            Ok(response)
        }
    });
    tokio::time::timeout(
        TIMEOUT,
        hyper::server::conn::http1::Builder::new()
            .timer(TokioTimer::new())
            .header_read_timeout(TIMEOUT)
            .max_buf_size(8192)
            .serve_connection(TokioIo::new(stream), service)
            .with_upgrades(),
    )
    .await??;
    let (upgrade, origin) = receiver.await.context("upgrade rejected")?;
    let upgraded = tokio::time::timeout(TIMEOUT, upgrade).await??;
    let config = WebSocketConfig::default()
        .max_message_size(Some(wire::MAX_FRAME))
        .max_frame_size(Some(wire::MAX_FRAME))
        .write_buffer_size(0)
        .max_write_buffer_size(wire::MAX_FRAME + 1024);
    let mut socket =
        WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, Some(config)).await;
    let first = tokio::time::timeout(TIMEOUT, socket.next())
        .await?
        .context("hello required")??;
    let Message::Text(bytes) = first else {
        anyhow::bail!("hello required");
    };
    let request: wire::Request = serde_json::from_str(&bytes)?;
    ensure!(
        request.version == VERSION
            && !request.id.is_empty()
            && request.id.len() <= 256
            && request.method == "hello",
        "hello required"
    );
    let hello: LoopbackHelloParams = serde_json::from_value(request.params)?;
    ensure!(
        hello.expected_generation == host.identity.generation
            && hello.protocol_versions.contains(&u64::from(VERSION))
            && hello
                .protocol_versions
                .iter()
                .all(|v| *v <= u32::MAX.into()),
        "authentication failed"
    );
    let mut changes = host.changes.subscribe();
    let device_id = host
        .loopback
        .consume(&hello.ticket, &origin, &hello.expected_generation)?;
    let negotiated = hello
        .capabilities
        .iter()
        .any(|capability| capability == "gui-read-v1");
    let persisted_history = negotiated
        && hello
            .capabilities
            .iter()
            .any(|capability| capability == "persistedHistoryV1");
    let connection_id = uuid::Uuid::new_v4().to_string();
    let _pages = PageConnection {
        host: host.clone(),
        connection: connection_id.clone(),
    };
    let mut page_events = host.gateway.workbench.page_events();
    // 写能力同时要求协议协商和本机用户明确授予的范围；旧浏览器仍只有 observe。
    let mut writer = (negotiated
        && device_id.as_ref().is_none_or(|id| {
            ["submit", "review", "manage"]
                .iter()
                .any(|capability| host.loopback.browser_permits(id, capability))
        })
        && hello
            .capabilities
            .iter()
            .any(|capability| capability == "gui-write-v1"))
    .then(|| match &device_id {
        Some(id) => super::gateway_owner::LocalSession::browser(
            host.clone(),
            connection_id.clone(),
            id.clone(),
        ),
        None => super::gateway_owner::LocalSession::new(host.clone(), connection_id.clone()),
    })
    .transpose()?;
    let result = protocol::LoopbackHelloResult {
        version: VERSION.into(),
        host_id: host.identity.host_id.clone(),
        generation: host.identity.generation.clone(),
        executable_version: host.identity.executable_version.clone(),
        capabilities: Vec::new(),
        methods: if negotiated {
            METHODS
                .iter()
                .filter(|method| **method != "session.openPersisted" || persisted_history)
                .map(|method| (*method).into())
                .collect()
        } else {
            vec!["host.status".into()]
        },
        transport: protocol::LoopbackHelloResultFieldTransport::Value1,
        scopes: vec![protocol::LoopbackHelloResultFieldScopesItem::Value1],
        limits: protocol::LoopbackLimits {
            max_frame_bytes: wire::MAX_FRAME as i64,
        },
        connection_id: negotiated.then(|| connection_id.clone()),
        gateway_generation: negotiated.then(|| host.identity.generation.clone()),
        negotiated_capabilities: negotiated.then(|| {
            let mut capabilities =
                vec![protocol::LoopbackHelloResultFieldNegotiatedCapabilitiesItem::Value1];
            if writer.is_some() {
                capabilities
                    .push(protocol::LoopbackHelloResultFieldNegotiatedCapabilitiesItem::Value2);
            }
            if persisted_history {
                capabilities
                    .push(protocol::LoopbackHelloResultFieldNegotiatedCapabilitiesItem::Value3);
            }
            capabilities
        }),
        write_methods: None,
        write_limits: None,
    };
    let mut result = serde_json::to_value(result)?;
    if let Some(device) = &device_id {
        result["scopes"] = host.loopback.browser_scopes(device)?;
    }
    if writer.is_some() {
        result["writeMethods"] = json!(
            WRITE_METHODS
                .iter()
                .filter(|method| device_id
                    .as_ref()
                    .is_none_or(|device| host.loopback.browser_method_permitted(device, method)))
                .collect::<Vec<_>>()
        );
        result["writeLimits"] = super::gateway_owner::write_limits();
    }
    send(
        &mut socket,
        &json!({"version":VERSION,"id":request.id,"result":result}),
    )
    .await?;
    let mut shell: Option<super::shell_subscription::Subscription> = None;
    let mut reader: Option<super::conversation_read::ConversationReader> = None;
    // 选中会话之外的附加观察（侧边讨论、任务运行对话），各自独立订阅，选中会话切换不影响它们。
    let mut watched: Vec<super::conversation_read::ConversationReader> = Vec::new();
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            event = page_events.recv() => {
                let event = match event {
                    Ok(event) => event,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(error) => return Err(error).context("page event stream interrupted"),
                };
                if event["connection"] != connection_id { continue; }
                ensure!(host.loopback.current(device_id.as_deref()), "authentication failed");
                if let Some(device) = &device_id {
                    ensure!(host.loopback.browser_permits(device, "manage"), "FORBIDDEN");
                }
                send(&mut socket, &json!({"version":VERSION,"method":"pages.event","params":{
                    "event":"pages.event","connectionId":connection_id,
                    "gatewayGeneration":host.identity.generation,
                    "token":event["token"],"notification":event["notification"]
                }})).await?;
            }
            message = socket.next() => {
                let Some(message) = message else { break; };
                match message? {
                    Message::Text(bytes) => {
                        ensure!(host.loopback.current(device_id.as_deref()), "authentication failed");
                        let raw: Value = serde_json::from_str(&bytes)?;
                        if let Some(local) = writer.as_mut().filter(|_| raw["method"].as_str().is_some_and(|method| WRITE_METHODS.contains(&method))) {
                            let id = raw["id"].as_str().filter(|id| !id.is_empty() && id.len() <= 64).context("invalid request")?.to_owned();
                            let result = async {
                                ensure!(raw["version"] == VERSION, wire::error("unsupportedVersion","Host requires version 1"));
                                let object = raw.as_object().context("INVALID_PARAMS")?;
                                ensure!(object.keys().all(|key| matches!(key.as_str(), "version"|"id"|"method"|"params"|"context"|"commandId")), "INVALID_PARAMS");
                                if let Some(device) = &device_id {
                                    ensure!(host.loopback.browser_method_permitted(device, raw["method"].as_str().unwrap_or_default()), "FORBIDDEN");
                                }
                                let mut envelope = raw.clone();
                                envelope.as_object_mut().unwrap().remove("version");
                                local.request(&envelope).await
                            }.await;
                            ensure!(host.loopback.current(device_id.as_deref()), "authentication failed");
                            let response=match result {
                                Ok(value)=>json!({"version":VERSION,"id":id,"result":value}),
                                Err(error)=>{
                                    json!({"version":VERSION,"id":id,"error":loopback_error(&raw, &error)})
                                },
                            };
                            send(&mut socket,&response).await?;
                            continue;
                        }
                        if let (None, Some(id)) = (writer.as_ref(), raw["method"].as_str().filter(|method| WRITE_METHODS.contains(method)).and(raw["id"].as_str())) {
                            send(&mut socket,&json!({"version":VERSION,"id":id,"error":read_error(&wire::error("methodNotFound","method is not available on this connection"))})).await?;
                            continue;
                        }
                        let input: ReadRequest = serde_json::from_value(raw)?;
                        ensure!(input.id.len() <= 256, "invalid request");
                        let result: Result<Value> = async {
                            ensure!(input.version == VERSION, wire::error("unsupportedVersion","Host requires version 1"));
                            ensure!(!input.id.is_empty(), wire::error("invalidRequest","id must be nonempty"));
                            ensure!(METHODS.contains(&input.method.as_str()) && (negotiated || input.method == "host.status"), wire::error("methodNotFound","method is not available on this connection"));
                            match input.method.as_str() {
                                "host.status" => { ensure!(input.context.is_none() && input.params.as_object().is_some_and(|params|params.is_empty()), wire::error("invalidRequest","status takes no arguments")); host.dispatch("host.status",input.params).await },
                                "shell.subscribe" => {
                                    ensure!(input.context.is_none() && input.params.as_object().is_some_and(|params|params.is_empty()), "INVALID_PARAMS");
                                    let (subscription,value) = super::shell_subscription::Subscription::open(&host,&connection_id).await?;
                                    shell=Some(subscription); Ok(value)
                                }
                                "shell.unsubscribe" => {
                                    ensure!(input.context.is_none(), "INVALID_PARAMS");
                                    let params: protocol::ReadSubscriptionParams = serde_json::from_value(input.params)?;
                                    let closed=shell.as_ref().is_some_and(|sub|sub.id()==params.subscription_id);
                                    if closed {shell=None;}
                                    Ok(json!({"closed":closed}))
                                }
                                "session.openPersisted" => {
                                    ensure!(persisted_history, wire::error("methodNotFound", "persisted history was not negotiated"));
                                    let context=input.context.context("INVALID_PARAMS")?;
                                    let params: protocol::ConversationOpenParams=serde_json::from_value(input.params)?;
                                    reader=None;
                                    let (opened,value)=super::conversation_read::ConversationReader::open_persisted(&host,&context.project_id,context.service_generation.as_deref(),&params.thread_id).await?;
                                    reader=Some(opened); Ok(keys(&host,&connection_id,value))
                                }
                                "session.open" => {
                                    let context=input.context.context("INVALID_PARAMS")?;
                                    let generation=context.service_generation.context("INVALID_PARAMS")?;
                                    let params: protocol::ConversationOpenParams=serde_json::from_value(input.params)?;
                                    reader=None;
                                    let (opened,value)=super::conversation_read::ConversationReader::open(&host,&context.project_id,&generation,&params.thread_id).await?;
                                    reader=Some(opened); Ok(keys(&host,&connection_id,value))
                                }
                                "session.watch" => {
                                    let context=input.context.context("INVALID_PARAMS")?;
                                    let generation=context.service_generation.context("INVALID_PARAMS")?;
                                    let params: protocol::ConversationOpenParams=serde_json::from_value(input.params)?;
                                    ensure!(watched.len() < MAX_WATCHED, wire::error("LIMIT_EXCEEDED","close another watched conversation first"));
                                    let (opened,value)=super::conversation_read::ConversationReader::open(&host,&context.project_id,&generation,&params.thread_id).await?;
                                    watched.push(opened); Ok(keys(&host,&connection_id,value))
                                }
                                "session.history" | "artifact.read" => {
                                    let context=input.context.context("INVALID_PARAMS")?;
                                    let subscription=input.params.get("subscriptionId").and_then(Value::as_str);
                                    let active=match watched.iter_mut().find(|value|Some(value.subscription())==subscription) {
                                        Some(value)=>value,
                                        None=>reader.as_mut().context("RESYNC_REQUIRED")?,
                                    };
                                    ensure!(active.project()==context.project_id && context.service_generation.as_deref()==Some(active.generation()), "RESYNC_REQUIRED");
                                    let value=if input.method=="session.history" {
                                        active.history(&host,serde_json::from_value(input.params)?).await?
                                    } else {active.media(&host,&input.params).await?};
                                    Ok(keys(&host,&connection_id,value))
                                }
                                "subscription.close" => {
                                    let context=input.context.context("INVALID_PARAMS")?;
                                    let params: protocol::ReadSubscriptionParams=serde_json::from_value(input.params)?;
                                    if let Some(index)=watched.iter().position(|value|value.subscription()==params.subscription_id) {
                                        ensure!(watched[index].project()==context.project_id, "FORBIDDEN");
                                        watched.remove(index);
                                        return Ok(json!({"closed":true}));
                                    }
                                    if let Some(active)=&reader {ensure!(active.project()==context.project_id, "FORBIDDEN");}
                                    let closed=reader.as_ref().is_some_and(|active|active.subscription()==params.subscription_id);
                                    if closed {reader=None;}
                                    Ok(json!({"closed":closed}))
                                }
                                _=>unreachable!(),
                            }
                        }.await;
                        ensure!(host.loopback.current(device_id.as_deref()), "authentication failed");
                        let response=match result {
                            Ok(value)=>json!({"version":VERSION,"id":input.id,"result":value}),
                            Err(error)=>json!({"version":VERSION,"id":input.id,"error":read_error(&error)}),
                        };
                        send(&mut socket,&response).await?;
                    }
                    Message::Ping(_)=>{tokio::time::timeout(TIMEOUT,socket.flush()).await??;}
                    Message::Pong(_)=>{},
                    _=>break,
                }
            }
            event=async {match reader.as_mut(){Some(reader)=>reader.next_event().await,None=>std::future::pending().await}} => {
                let active=reader.as_mut().unwrap();
                let outcome=match event {Ok(event)=>active.event(&host,event).await,Err(error)=>Err(error)};
                ensure!(host.loopback.current(device_id.as_deref()), "authentication failed");
                match outcome {
                    Ok(Some(event))=>notify(&mut socket,keys(&host,&connection_id,event)).await?,
                    Ok(None)=>{},
                    Err(error)=>{
                        let value=keys(&host,&connection_id,active.invalidated(&error));
                        reader=None;
                        notify(&mut socket,value).await?;
                    }
                }
            }
            (event,index)=next_watched(&mut watched), if !watched.is_empty() => {
                let active=&mut watched[index];
                let outcome=match event {Ok(event)=>active.event(&host,event).await,Err(error)=>Err(error)};
                ensure!(host.loopback.current(device_id.as_deref()), "authentication failed");
                match outcome {
                    Ok(Some(event))=>notify(&mut socket,keys(&host,&connection_id,event)).await?,
                    Ok(None)=>{},
                    Err(error)=>{
                        let value=keys(&host,&connection_id,watched.remove(index).invalidated(&error));
                        notify(&mut socket,value).await?;
                    }
                }
            }
            _=tick.tick(), if shell.is_some()=>{
                let active=shell.as_mut().unwrap();
                let refreshed = active.refresh(&host).await;
                ensure!(host.loopback.current(device_id.as_deref()), "authentication failed");
                match refreshed {
                    Ok(Some(event))=>notify(&mut socket,event).await?,
                    Ok(None)=>{},
                    Err(error)=>{
                        let mut event=active.invalidated();
                        event["error"]=read_error(&error);
                        shell=None;
                        notify(&mut socket,event).await?;
                    }
                }
            }
            _=changes.changed()=>{
                if !host.loopback.current(device_id.as_deref()) { break; }
                if let Some(active)=&reader
                    && !active.current(&host) {
                        let event=keys(&host,&connection_id,active.invalidated(&anyhow::anyhow!("RESYNC_REQUIRED")));
                        reader=None;
                        notify(&mut socket,event).await?;
                    }
                while let Some(index)=watched.iter().position(|value|!value.current(&host)) {
                    let event=keys(&host,&connection_id,watched.remove(index).invalidated(&anyhow::anyhow!("RESYNC_REQUIRED")));
                    notify(&mut socket,event).await?;
                }
                if let Some(active)=shell.as_mut() {
                    let refreshed = active.refresh(&host).await;
                    ensure!(host.loopback.current(device_id.as_deref()), "authentication failed");
                    match refreshed {
                        Ok(Some(event))=>notify(&mut socket,event).await?,
                        Ok(None)=>{},
                        Err(error)=>{
                            let mut event=active.invalidated();
                            event["error"]=read_error(&error);
                            shell=None;
                            notify(&mut socket,event).await?;
                        }
                    }
                }
            }
        }
    }
    Ok(())
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadContext {
    project_id: String,
    service_generation: Option<String>,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadRequest {
    version: u32,
    id: String,
    method: String,
    params: Value,
    context: Option<ReadContext>,
}
/// 等任一附加观察的下一条 Core 事件；广播接收可安全取消，未选中的不会丢事件。
async fn next_watched(
    watched: &mut [super::conversation_read::ConversationReader],
) -> (Result<super::schedule_connection::CoreEvent>, usize) {
    let (event, index, _) = futures_util::future::select_all(
        watched
            .iter_mut()
            .map(|reader| Box::pin(reader.next_event())),
    )
    .await;
    (event, index)
}

fn keys(host: &Host, connection: &str, mut value: Value) -> Value {
    value["connectionId"] = json!(connection);
    value["gatewayGeneration"] = json!(host.identity.generation);
    value
}
fn loopback_error(request: &Value, error: &anyhow::Error) -> Value {
    if let Some(mut result) = super::task_catalog::task_rejection_response(error) {
        result["submissionUnknown"] = json!(false);
        if let Some(command) = request.get("commandId") {
            result["commandId"] = command.clone();
        }
        return result;
    }
    let message = error.to_string();
    let code = error
        .downcast_ref::<wire::Error>()
        .map(|error| error.code)
        .unwrap_or_else(|| super::gateway_owner::error_code(&message));
    let mut value = json!({"code":code,"message":"Host command failed"});
    // Host 自己写的错误说明可以给界面看；其余原因可能带内部细节，只给代码。
    if let Some(error) = error.downcast_ref::<wire::Error>() {
        value["message"] = json!(error.message);
    }
    if matches!(
        request["method"].as_str(),
        Some(
            "library.command"
                | "worktree.command"
                | "trajectory.command"
                | "feedback.command"
                | "manage.command"
                | "providers.command"
                | "plugins.command"
                | "analytics.import"
        )
    ) {
        value["commandId"] = request["commandId"].clone();
        value["submissionUnknown"] = json!(
            !(super::gateway_owner::settled_failure(code) || code == "CAPABILITY_UNAVAILABLE")
        );
    } else if request["method"] == "providers.read" {
        value["submissionUnknown"] = json!(false);
    }
    value
}

fn read_error(error: &anyhow::Error) -> Value {
    let code = error
        .downcast_ref::<wire::Error>()
        .map(|error| error.code)
        .unwrap_or_else(|| match error.to_string().as_str() {
            _ if error.downcast_ref::<serde_json::Error>().is_some() => "INVALID_PARAMS",
            "INVALID_PARAMS" => "INVALID_PARAMS",
            "FORBIDDEN" => "FORBIDDEN",
            "RESYNC_REQUIRED" => "RESYNC_REQUIRED",
            "RESOURCE_UNAVAILABLE" => "RESOURCE_UNAVAILABLE",
            _ => "CORE_UNAVAILABLE",
        });
    let mut value = json!({"code":code,"message":"Host read request failed"});
    if let Some(native) = error.downcast_ref::<super::schedule_connection::RpcFailure>() {
        value["coreError"] = native.0.clone();
    }
    value
}
async fn notify(socket: &mut Socket, event: Value) -> Result<()> {
    let method = event["event"].as_str().context("invalid event")?;
    send(
        socket,
        &json!({"version":VERSION,"method":method,"params":event}),
    )
    .await
}

async fn send(socket: &mut Socket, value: &Value) -> Result<()> {
    let bytes = serde_json::to_string(value)?;
    ensure!(
        bytes.len() <= wire::MAX_FRAME,
        "response exceeds frame limit"
    );
    tokio::time::timeout(TIMEOUT, socket.send(Message::Text(bytes.into()))).await??;
    Ok(())
}

#[cfg(test)]
#[path = "loopback_tests.rs"]
mod tests;
