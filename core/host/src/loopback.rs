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
    "worktree.command",
    "pages.command",
    "pages.resource",
    "desktop.command",
];
const TTL: Duration = Duration::from_secs(30);
const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_TICKETS: usize = 64;
const MAX_CONNECTIONS: usize = 32;
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
            | "providers.command" | "pages.command" | "pages.resource" | "desktop.command" => {
                "manage"
            }
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
            METHODS.iter().map(|method| (*method).into()).collect()
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
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            event = page_events.recv() => {
                let event = event.context("page event stream interrupted")?;
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
                                    let message=error.to_string();
                                    let code=error.downcast_ref::<wire::Error>().map(|error|error.code).unwrap_or_else(||super::gateway_owner::error_code(&message));
                                    let mut response = json!({"version":VERSION,"id":id,"error":{"code":code,"message":"Host command failed"}});
                                    if code == "COMMAND_FAILED" && let Some(error) = error.downcast_ref::<wire::Error>() {
                                        response["error"]["message"] = json!(error.message);
                                    }
                                    if matches!(raw["method"].as_str(), Some("library.command" | "worktree.command" | "trajectory.command" | "feedback.command" | "manage.command"
                | "providers.read"
                | "providers.command")) {
                                        response["error"]["commandId"] = raw["commandId"].clone();
                                        response["error"]["submissionUnknown"] = json!(!matches!(code,
                                            "FORBIDDEN" | "INVALID_PARAMS" | "COMMAND_CONFLICT" | "CAPABILITY_UNAVAILABLE" | "LIMIT_EXCEEDED"));
                                    }
                                    response
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
                                "session.open" => {
                                    let context=input.context.context("INVALID_PARAMS")?;
                                    let generation=context.service_generation.context("INVALID_PARAMS")?;
                                    let params: protocol::ConversationOpenParams=serde_json::from_value(input.params)?;
                                    reader=None;
                                    let (opened,value)=super::conversation_read::ConversationReader::open(&host,&context.project_id,&generation,&params.thread_id).await?;
                                    reader=Some(opened); Ok(keys(&host,&connection_id,value))
                                }
                                "session.history" | "artifact.read" => {
                                    let context=input.context.context("INVALID_PARAMS")?;
                                    let active=reader.as_mut().context("RESYNC_REQUIRED")?;
                                    ensure!(active.project()==context.project_id && context.service_generation.as_deref()==Some(active.generation()), "RESYNC_REQUIRED");
                                    let value=if input.method=="session.history" {
                                        active.history(&host,serde_json::from_value(input.params)?).await?
                                    } else {active.media(&host,&input.params).await?};
                                    Ok(keys(&host,&connection_id,value))
                                }
                                "subscription.close" => {
                                    let context=input.context.context("INVALID_PARAMS")?;
                                    let params: protocol::ReadSubscriptionParams=serde_json::from_value(input.params)?;
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
fn keys(host: &Host, connection: &str, mut value: Value) -> Value {
    value["connectionId"] = json!(connection);
    value["gatewayGeneration"] = json!(host.identity.generation);
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
mod tests {
    use super::*;
    use crate::{Client, HostIdentity};
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use ring::{
        rand::SystemRandom,
        signature::{self, KeyPair},
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::{
        net::UnixListener,
        sync::{Mutex, Notify, watch},
    };
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    struct Fixture {
        _root: Rc<tempfile::TempDir>,
        host: Rc<Host>,
        tasks: JoinSet<()>,
    }
    impl Fixture {
        async fn start() -> Self {
            Self::start_in(Rc::new(tempfile::tempdir().unwrap())).await
        }
        async fn start_in(root: Rc<tempfile::TempDir>) -> Self {
            let home = root.path().canonicalize().unwrap().join("home");
            storage::private_dir(&home).unwrap();
            storage::private_dir(&home.join("host")).unwrap();
            storage::private_dir(&home.join("host/operations")).unwrap();
            let socket = storage::control_socket(&home.join("host")).unwrap();
            storage::private_dir(socket.parent().unwrap()).unwrap();
            if socket.exists() {
                std::fs::remove_file(&socket).unwrap();
            }
            let unix = UnixListener::bind(&socket).unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).unwrap();
            let (changes, _) = watch::channel(0);
            let mut migration = crate::migration::Migration::new(&home).unwrap();
            migration.vault = crate::vault::Vault::isolated_files(&home);
            let host = Rc::new(Host {
                identity: HostIdentity {
                    version: VERSION,
                    host_id: storage::read_optional(&home.join("host/identity.json"))
                        .unwrap()
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                    generation: uuid::Uuid::new_v4().to_string(),
                    socket_path: socket,
                    auth_file: home.join("host/auth.json"),
                    pid: std::process::id(),
                    executable_version: "fixture".into(),
                },
                bin: home.clone(),
                token: "isolated-auth-fixture".into(),
                slots: RefCell::new(BTreeMap::new()),
                stop: RefCell::new(None),
                host_stop_gate: Mutex::new(()),
                changes,
                exit: Notify::new(),
                migration: migration.into(),
                journal: crate::journal::Journal::new(&home).unwrap(),
                remote: crate::remote_state::RemoteState::new(&home),
                gateway: super::super::gateway_owner::Gateway::default(),
                subscriptions: super::super::subscriptions::Subscriptions::default(),
                schedules: super::super::schedules::Schedules::load(&home).unwrap(),
                power: super::super::power::Power::default(),
                read_models: Default::default(),
                loopback: Loopback::default(),
                home,
            });
            storage::write(
                &host.home.join("host/identity.json"),
                &host.identity.host_id,
            )
            .unwrap();
            storage::write(&host.identity.auth_file, &host.token).unwrap();
            storage::write(&host.home.join("host/host.json"), &host.identity).unwrap();
            let mut listener = bind(host.clone(), true).await.unwrap();
            let mut tasks = JoinSet::new();
            tasks.spawn_local(async move {
                listener.run().await.unwrap();
            });
            let owner = host.clone();
            tasks.spawn_local(async move {
                let mut connections = JoinSet::new();
                loop { tokio::select! {
                    accepted = unix.accept() => { let (stream, _) = accepted.unwrap(); let host = owner.clone(); connections.spawn_local(async move { let _ = super::super::connection_loop(host, stream).await; }); }
                    _ = connections.join_next(), if !connections.is_empty() => {}
                } }
            });
            Self {
                _root: root,
                host,
                tasks,
            }
        }
        async fn client(&self) -> Client {
            Client::connect_at(self.host.home.clone()).await.unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.tasks.abort_all();
        }
    }

    type ClientSocket = WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;
    async fn connect(ticket: &LocalWebTicketResult, origin: &str) -> ClientSocket {
        let mut request = ticket.websocket_url.clone().into_client_request().unwrap();
        request
            .headers_mut()
            .insert("origin", origin.parse().unwrap());
        tokio_tungstenite::connect_async(request).await.unwrap().0
    }
    fn hello(ticket: &LocalWebTicketResult) -> Value {
        json!({"version":1,"id":"hello","method":"hello","params":{"protocolVersions":[1],"capabilities":[],"ticket":ticket.ticket,"expectedGeneration":ticket.generation}})
    }
    async fn write(socket: &mut ClientSocket, value: Value) {
        socket
            .send(Message::Text(value.to_string().into()))
            .await
            .unwrap();
    }
    async fn read(socket: &mut ClientSocket) -> Value {
        let message = tokio::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        serde_json::from_str(message.to_text().unwrap()).unwrap()
    }
    async fn closed(socket: &mut ClientSocket) {
        let message = tokio::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap();
        assert!(matches!(
            message,
            None | Some(Err(_)) | Some(Ok(Message::Close(_)))
        ));
    }
    async fn authenticate(ticket: &LocalWebTicketResult) -> ClientSocket {
        let mut socket = connect(ticket, &ticket.origin).await;
        write(&mut socket, hello(ticket)).await;
        assert_eq!(
            read(&mut socket).await["result"]["generation"],
            ticket.generation
        );
        socket
    }

    fn browser_key() -> signature::EcdsaKeyPair {
        let random = SystemRandom::new();
        let pkcs8 = signature::EcdsaKeyPair::generate_pkcs8(
            &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            &random,
        )
        .unwrap();
        signature::EcdsaKeyPair::from_pkcs8(
            &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            pkcs8.as_ref(),
            &random,
        )
        .unwrap()
    }
    fn browser_params(key: &signature::EcdsaKeyPair) -> Value {
        json!({"publicKey":URL_SAFE_NO_PAD.encode(key.public_key().as_ref())})
    }
    fn browser_proof(key: &signature::EcdsaKeyPair, challenge: &Value, origin: &str) -> Value {
        let message = format!(
            "{}\n{}\n{}",
            challenge["hostId"].as_str().unwrap(),
            challenge["nonce"].as_str().unwrap(),
            origin
        );
        let signature = key.sign(&SystemRandom::new(), message.as_bytes()).unwrap();
        json!({"publicKey":browser_params(key)["publicKey"],"nonce":challenge["nonce"],"signature":URL_SAFE_NO_PAD.encode(signature.as_ref())})
    }
    async fn browser_post(
        endpoint: &LoopbackEndpoint,
        origin: &str,
        path: &str,
        params: Value,
    ) -> (u16, Value) {
        let authority = endpoint.origin.strip_prefix("http://").unwrap();
        let mut stream = TcpStream::connect(authority).await.unwrap();
        let body = params.to_string();
        let request = format!(
            "POST /host/auth/{path} HTTP/1.1\r\nHost: {authority}\r\nOrigin: {origin}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut response))
            .await
            .unwrap()
            .unwrap();
        let text = std::str::from_utf8(&response).unwrap();
        let (headers, body) = text.split_once("\r\n\r\n").unwrap();
        let status = headers.split_whitespace().nth(1).unwrap().parse().unwrap();
        (status, serde_json::from_str(body).unwrap_or(Value::Null))
    }
    async fn approve_browser(fixture: &Fixture, key: &signature::EcdsaKeyPair) -> String {
        let endpoint = fixture.host.loopback.endpoint().unwrap();
        let (status, pending) = browser_post(
            &endpoint,
            &endpoint.origin,
            "challenge",
            browser_params(key),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(pending["state"], "pending");
        fixture
            .client()
            .await
            .approve_browser(pending["requestId"].as_str().unwrap())
            .await
            .unwrap()
            .device_id
    }
    async fn browser_ticket(
        fixture: &Fixture,
        key: &signature::EcdsaKeyPair,
    ) -> LocalWebTicketResult {
        let endpoint = fixture.host.loopback.endpoint().unwrap();
        let (status, challenge) = browser_post(
            &endpoint,
            &endpoint.origin,
            "challenge",
            browser_params(key),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(challenge["state"], "challenge");
        let (status, ticket) = browser_post(
            &endpoint,
            &endpoint.origin,
            "ticket",
            browser_proof(key, &challenge, &endpoint.origin),
        )
        .await;
        assert_eq!(status, 200);
        serde_json::from_value(ticket).unwrap()
    }

    #[tokio::test(flavor = "current_thread")]
    async fn browser_revoke_invalidates_unused_tickets_active_connections_and_persisted_grants() {
        tokio::task::LocalSet::new().run_until(async {
            let mut fixture = Fixture::start().await;
            let key = browser_key();
            let device_id = approve_browser(&fixture, &key).await;
            let devices = serde_json::to_value(fixture.client().await.browser_devices().await.unwrap()).unwrap();
            assert_eq!(devices["devices"].as_array().unwrap().len(), 1);
            assert_eq!(devices["devices"][0]["deviceId"], device_id);
            assert_eq!(devices["devices"][0]["scopes"], json!(["observe"]));
            assert_eq!(devices["devices"][0]["fingerprint"], storage::digest(key.public_key().as_ref()));
            let unused = browser_ticket(&fixture, &key).await;
            let active = browser_ticket(&fixture, &key).await;
            let mut socket = authenticate(&active).await;
            write(&mut socket, json!({"version":1,"id":"devices","method":"web.devices","params":{}})).await;
            assert_eq!(read(&mut socket).await["error"]["code"], "methodNotFound");
            write(&mut socket, json!({"version":1,"id":"revoke","method":"web.revoke","params":{"deviceId":device_id,"expectedGeneration":active.generation}})).await;
            assert_eq!(read(&mut socket).await["error"]["code"], "methodNotFound");
            let receipt = fixture.client().await.revoke_browser(&device_id).await.unwrap();
            assert_eq!(receipt.device_id, device_id);
            assert!(receipt.revoked);
            closed(&mut socket).await;
            let mut unused_socket = connect(&unused, &unused.origin).await;
            write(&mut unused_socket, hello(&unused)).await;
            closed(&mut unused_socket).await;
            assert!(fixture.client().await.revoke_browser(&device_id).await.unwrap().revoked);
            assert!(fixture.client().await.browser_devices().await.unwrap().devices.is_empty());
            let root = fixture._root.clone();
            fixture.tasks.shutdown().await;
            drop(fixture);
            let restarted = Fixture::start_in(root).await;
            assert!(restarted.client().await.browser_devices().await.unwrap().devices.is_empty());
            let endpoint = restarted.host.loopback.endpoint().unwrap();
            let (status, pending) = browser_post(&endpoint, &endpoint.origin, "challenge", browser_params(&key)).await;
            assert_eq!(status, 200);
            assert_eq!(pending["state"], "pending");
        }).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ticket_is_single_use_and_origin_generation_and_expiry_bound() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let fixture = Fixture::start().await;
                let client = fixture.client().await;
                let ticket = client.web_ticket(ELECTRON_ORIGIN).await.unwrap();
                let own_origin = fixture
                    .host
                    .loopback
                    .endpoint
                    .borrow()
                    .as_ref()
                    .unwrap()
                    .origin
                    .clone();
                let mut wrong_origin = connect(&ticket, &own_origin).await;
                write(&mut wrong_origin, hello(&ticket)).await;
                closed(&mut wrong_origin).await;
                let mut wrong_generation = connect(&ticket, ELECTRON_ORIGIN).await;
                let mut input = hello(&ticket);
                input["params"]["expectedGeneration"] = json!("previous-generation");
                write(&mut wrong_generation, input).await;
                closed(&mut wrong_generation).await;
                let _first = authenticate(&ticket).await;
                let mut replay = connect(&ticket, ELECTRON_ORIGIN).await;
                write(&mut replay, hello(&ticket)).await;
                closed(&mut replay).await;
                let expired = client.web_ticket(ELECTRON_ORIGIN).await.unwrap();
                fixture
                    .host
                    .loopback
                    .tickets
                    .borrow_mut()
                    .get_mut(&storage::digest(expired.ticket.as_bytes()))
                    .unwrap()
                    .deadline = Instant::now() - Duration::from_secs(1);
                let mut socket = connect(&expired, ELECTRON_ORIGIN).await;
                write(&mut socket, hello(&expired)).await;
                closed(&mut socket).await;
                let own_ticket = client.web_ticket(&own_origin).await.unwrap();
                let _own_socket = authenticate(&own_ticket).await;
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn upgrade_rejects_untrusted_origin_authority_query_and_large_headers() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let fixture = Fixture::start().await;
                let ticket = fixture
                    .client()
                    .await
                    .web_ticket(ELECTRON_ORIGIN)
                    .await
                    .unwrap();
                for origin in [
                    None,
                    Some("null"),
                    Some("https://untrusted.invalid"),
                    Some("areal-ui://app.evil"),
                ] {
                    let mut request = ticket.websocket_url.clone().into_client_request().unwrap();
                    if let Some(origin) = origin {
                        request
                            .headers_mut()
                            .insert("origin", origin.parse().unwrap());
                    }
                    assert!(tokio_tungstenite::connect_async(request).await.is_err());
                }
                for field in ["host", "query", "duplicate-origin", "large-header"] {
                    let url = if field == "query" {
                        format!("{}?unexpected=1", ticket.websocket_url)
                    } else {
                        ticket.websocket_url.clone()
                    };
                    let mut request = url.into_client_request().unwrap();
                    request
                        .headers_mut()
                        .insert("origin", ELECTRON_ORIGIN.parse().unwrap());
                    match field {
                        "host" => {
                            request
                                .headers_mut()
                                .insert("host", "attacker.invalid".parse().unwrap());
                        }
                        "duplicate-origin" => {
                            request
                                .headers_mut()
                                .append("origin", ELECTRON_ORIGIN.parse().unwrap());
                        }
                        "large-header" => {
                            request
                                .headers_mut()
                                .insert("x-padding", "x".repeat(9000).parse().unwrap());
                        }
                        _ => {}
                    }
                    assert!(
                        tokio_tungstenite::connect_async(request).await.is_err(),
                        "{field}"
                    );
                }
                let _valid = authenticate(&ticket).await;
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn unauthenticated_business_and_non_negotiated_methods_are_rejected() {
        tokio::task::LocalSet::new().run_until(async {
            let fixture = Fixture::start().await;
            let client = fixture.client().await;
            let ticket = client.web_ticket(ELECTRON_ORIGIN).await.unwrap();
            let mut socket = connect(&ticket, ELECTRON_ORIGIN).await;
            write(&mut socket, json!({"version":1,"id":"early","method":"host.status","params":{}})).await;
            closed(&mut socket).await;
            let mut socket = authenticate(&ticket).await;
            for method in ["web.ticket", "host.stop", "projects.list", "gui.attachSource"] {
                write(&mut socket, json!({"version":1,"id":"forbidden","method":method,"params":{}})).await;
                assert_eq!(read(&mut socket).await["error"]["code"], "methodNotFound");
            }
            write(&mut socket, json!({"version":1,"id":"invalid","method":"host.status","params":{"extra":true}})).await;
            assert_eq!(read(&mut socket).await["error"]["code"], "invalidRequest");
            write(&mut socket, json!({"version":1,"id":"status","method":"host.status","params":{}})).await;
            assert_eq!(read(&mut socket).await["result"]["hostId"], ticket.host_id);
            for frame in [
                json!({"version":1,"id":"early","method":"web.ticket","params":{"origin":ELECTRON_ORIGIN,"expectedGeneration":ticket.generation}}),
                json!({"version":1,"id":"hello","method":"hello","params":{"protocolVersions":[1],"capabilities":[],"authToken":"wrong"}}),
                json!({"version":1,"id":"hello","method":"hello","params":{"protocolVersions":[1],"capabilities":[],"authToken":fixture.host.token,"ticket":"unknown-field"}}),
            ] {
                let stream = tokio::net::UnixStream::connect(&fixture.host.identity.socket_path).await.unwrap();
                let mut stream = tokio::io::BufReader::new(stream);
                wire::write(stream.get_mut(), &frame).await.unwrap();
                assert!(tokio::time::timeout(Duration::from_secs(2), wire::read(&mut stream)).await.unwrap().unwrap().is_none());
            }
            assert_eq!(fixture.client().await.status().await.unwrap().host_id, ticket.host_id);
        }).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn page_events_are_delivered_only_to_the_authenticated_connection() {
        tokio::task::LocalSet::new().run_until(async {
            let fixture = Fixture::start().await;
            let client = fixture.client().await;
            let mut sockets = Vec::new();
            for _ in 0..2 {
                let ticket = client.web_ticket(ELECTRON_ORIGIN).await.unwrap();
                let mut socket = connect(&ticket, ELECTRON_ORIGIN).await;
                write(&mut socket, json!({"version":1,"id":"hello","method":"hello","params":{
                    "protocolVersions":[1],"capabilities":["gui-read-v1","gui-write-v1"],
                    "ticket":ticket.ticket,"expectedGeneration":ticket.generation
                }})).await;
                let hello = read(&mut socket).await["result"].clone();
                sockets.push((socket, hello["connectionId"].clone()));
            }
            let (mut second, _) = sockets.pop().unwrap();
            let (mut first, owner) = sockets.pop().unwrap();
            super::super::workbench_route::reverse(&fixture.host)("pages.event".into(), json!({
                "connection":owner,"token":"page-token","notification":{"jsonrpc":"2.0","method":"ui/notifications/closed"}
            })).await.unwrap();
            let event = read(&mut first).await;
            assert_eq!(event["method"], "pages.event");
            assert_eq!(event["params"]["connectionId"], owner);
            write(&mut second, json!({"version":1,"id":"barrier","method":"host.status","params":{}})).await;
            assert_eq!(read(&mut second).await["id"], "barrier");
        }).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn only_desktop_tickets_negotiate_local_writes() {
        tokio::task::LocalSet::new().run_until(async {
            let fixture = Fixture::start().await;
            let client = fixture.client().await;
            let ticket = client.web_ticket(ELECTRON_ORIGIN).await.unwrap();
            let mut socket = connect(&ticket, ELECTRON_ORIGIN).await;
            write(&mut socket, json!({"version":1,"id":"hello","method":"hello","params":{"protocolVersions":[1],"capabilities":["gui-read-v1","gui-write-v1"],"ticket":ticket.ticket,"expectedGeneration":ticket.generation}})).await;
            let hello = read(&mut socket).await["result"].clone();
            assert_eq!(hello["negotiatedCapabilities"], json!(["gui-read-v1", "gui-write-v1"]));
            assert_eq!(hello["writeMethods"], json!(WRITE_METHODS));
            assert_eq!(hello["writeLimits"], super::super::gateway_owner::write_limits());
            write(&mut socket, json!({"version":1,"id":"read","method":"command.read","params":{"commandId":uuid::Uuid::new_v4().to_string()},"context":{"projectId":"missing"}})).await;
            assert_eq!(read(&mut socket).await["error"]["code"], "FORBIDDEN");
            write(&mut socket, json!({"version":1,"id":"x".repeat(65),"method":"command.read","params":{}})).await;
            closed(&mut socket).await;

            let key = browser_key();
            approve_browser(&fixture, &key).await;
            let browser = browser_ticket(&fixture, &key).await;
            let endpoint = fixture.host.loopback.endpoint().unwrap();
            let mut socket = connect(&browser, &endpoint.origin).await;
            write(&mut socket, json!({"version":1,"id":"hello","method":"hello","params":{"protocolVersions":[1],"capabilities":["gui-read-v1","gui-write-v1"],"ticket":browser.ticket,"expectedGeneration":browser.generation}})).await;
            let hello = read(&mut socket).await["result"].clone();
            assert_eq!(hello["negotiatedCapabilities"], json!(["gui-read-v1"]));
            assert!(hello.get("writeMethods").is_none() && hello.get("writeLimits").is_none());
            write(&mut socket, json!({"version":1,"id":"send","method":"session.send","params":{},"context":{"projectId":"p"},"commandId":uuid::Uuid::new_v4().to_string()})).await;
            assert_eq!(read(&mut socket).await["error"]["code"], "methodNotFound");
        }).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn browser_write_scopes_are_explicit_enforced_and_revocable() {
        tokio::task::LocalSet::new().run_until(async {
            let fixture = Fixture::start().await;
            let endpoint = fixture.host.loopback.endpoint().unwrap();
            for scope in ["submit", "approve", "manage"] {
                let key = browser_key();
                let (_, pending) = browser_post(&endpoint, &endpoint.origin, "challenge", browser_params(&key)).await;
                // 授权仍通过本机认证控制通道；网页不能给自己增加范围。
                let grant = fixture.client().await.approve_browser_with_scopes(pending["requestId"].as_str().unwrap(), &["observe", scope]).await.unwrap();
                let ticket = browser_ticket(&fixture, &key).await;
                let mut socket = connect(&ticket, &endpoint.origin).await;
                write(&mut socket, json!({"version":1,"id":"hello","method":"hello","params":{"protocolVersions":[1],"capabilities":["gui-read-v1","gui-write-v1"],"ticket":ticket.ticket,"expectedGeneration":ticket.generation}})).await;
                let hello = read(&mut socket).await["result"].clone();
                assert_eq!(hello["scopes"], json!(["observe", scope]));
                let methods = hello["writeMethods"].as_array().unwrap();
                assert_eq!(methods.contains(&json!("library.command")), scope == "manage");
                for method in ["worktree.read", "tasks.read", "trajectory.read", "trajectory.command", "feedback.read", "feedback.command", "manage.read", "manage.command", "providers.read", "providers.command"] {
                    assert_eq!(methods.contains(&json!(method)), scope == "manage");
                }
                assert_eq!(methods.contains(&json!("session.send")), scope == "submit");
                assert_eq!(methods.contains(&json!("interaction.respond")), scope == "approve");
                write(&mut socket, json!({"version":1,"id":"write","method":"library.command","params":{"sourceId":"fixture","operation":"createSection","title":"fixture"},"commandId":uuid::Uuid::new_v4().to_string()})).await;
                let error = read(&mut socket).await["error"].clone();
                assert_eq!(error["code"], if scope == "manage" { "CAPABILITY_UNAVAILABLE" } else { "FORBIDDEN" });
                assert_eq!(error["submissionUnknown"], false);
                for operation in ["open", "request"] {
                    write(&mut socket, json!({"version":1,"id":"page","method":"pages.command","params":{"operation":operation}})).await;
                    assert_eq!(read(&mut socket).await["error"]["code"], "FORBIDDEN");
                }
                fixture.client().await.revoke_browser(&grant.device_id).await.unwrap();
                write(&mut socket, json!({"version":1,"id":"revoked","method":"host.status","params":{}})).await;
                closed(&mut socket).await;
            }
        }).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn public_page_proxy_is_static_and_sandboxed_without_exposing_resources() {
        tokio::task::LocalSet::new().run_until(async {
            let fixture = Fixture::start().await;
            let endpoint = fixture.host.loopback.endpoint().unwrap();
            let authority = endpoint.origin.strip_prefix("http://").unwrap();
            for path in ["/host/pages/proxy", "/host/pages/private-page/view", "/host/pages/proxy?token=private"] {
                let mut stream = TcpStream::connect(authority).await.unwrap();
                stream.write_all(format!("GET {path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
                let mut bytes = Vec::new();
                tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut bytes)).await.unwrap().unwrap();
                let text = std::str::from_utf8(&bytes).unwrap();
                let (headers, body) = text.split_once("\r\n\r\n").unwrap();
                if path == "/host/pages/proxy" {
                    assert!(headers.starts_with("HTTP/1.1 200"));
                    assert!(headers.contains("sandbox allow-scripts"));
                    assert!(!headers.contains("allow-same-origin"));
                    assert_eq!(body, include_str!("page_proxy.html"));
                    assert!(!body.contains("areal-ui://"));
                } else {
                    assert!(!headers.starts_with("HTTP/1.1 200"));
                    assert!(!body.contains("private"));
                }
            }
        }).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn tickets_frames_and_connections_have_bounded_capacity() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let fixture = Fixture::start().await;
                let client = fixture.client().await;
                let ticket = client.web_ticket(ELECTRON_ORIGIN).await.unwrap();
                for _ in 1..MAX_TICKETS {
                    client.web_ticket(ELECTRON_ORIGIN).await.unwrap();
                }
                assert!(
                    client
                        .web_ticket(ELECTRON_ORIGIN)
                        .await
                        .unwrap_err()
                        .to_string()
                        .contains("resourceLimit")
                );
                let mut socket = authenticate(&ticket).await;
                let next = client.web_ticket(ELECTRON_ORIGIN).await.unwrap();
                let _ = socket
                    .send(Message::Text(" ".repeat(wire::MAX_FRAME + 1).into()))
                    .await;
                closed(&mut socket).await;
                let mut connections = Vec::new();
                for _ in 0..MAX_CONNECTIONS {
                    connections.push(connect(&next, ELECTRON_ORIGIN).await);
                }
                let mut request = next.websocket_url.clone().into_client_request().unwrap();
                request
                    .headers_mut()
                    .insert("origin", ELECTRON_ORIGIN.parse().unwrap());
                assert!(
                    tokio::time::timeout(
                        Duration::from_secs(2),
                        tokio_tungstenite::connect_async(request)
                    )
                    .await
                    .unwrap()
                    .is_err()
                );
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn restart_preserves_browser_origin_and_port_collision_rejects_old_origin_credentials() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let mut fixture = Fixture::start().await;
                let client = fixture.client().await;
                let key = browser_key();
                let device_id = approve_browser(&fixture, &key).await;
                let original_endpoint = fixture.host.loopback.endpoint().unwrap();
                let unused = client.web_ticket(ELECTRON_ORIGIN).await.unwrap();
                let active = client.web_ticket(ELECTRON_ORIGIN).await.unwrap();
                let mut socket = authenticate(&active).await;
                let root = fixture._root.clone();
                let path = fixture.host.home.join("host/endpoint.json");
                fixture.tasks.shutdown().await;
                assert!(!path.exists());
                closed(&mut socket).await;
                drop(fixture);
                let mut restarted = Fixture::start_in(root).await;
                let endpoint = restarted.host.loopback.endpoint().unwrap();
                assert_eq!(endpoint.origin, original_endpoint.origin);
                assert_eq!(
                    restarted
                        .client()
                        .await
                        .browser_devices()
                        .await
                        .unwrap()
                        .devices[0]
                        .device_id,
                    device_id
                );
                let browser = browser_ticket(&restarted, &key).await;
                let mut browser_socket = authenticate(&browser).await;
                let fresh = restarted
                    .client()
                    .await
                    .web_ticket(ELECTRON_ORIGIN)
                    .await
                    .unwrap();
                assert_eq!(fresh.host_id, unused.host_id);
                assert_ne!(fresh.generation, unused.generation);
                let mut socket = connect(&fresh, ELECTRON_ORIGIN).await;
                let mut old = hello(&unused);
                old["params"]["expectedGeneration"] = json!(fresh.generation);
                write(&mut socket, old).await;
                closed(&mut socket).await;
                let _valid = authenticate(&fresh).await;
                let (status, challenge) = browser_post(
                    &endpoint,
                    &endpoint.origin,
                    "challenge",
                    browser_params(&key),
                )
                .await;
                assert_eq!(status, 200);
                let old_proof = browser_proof(&key, &challenge, &endpoint.origin);
                let unused_browser = browser_ticket(&restarted, &key).await;
                let root = restarted._root.clone();
                restarted.tasks.shutdown().await;
                closed(&mut browser_socket).await;
                drop(restarted);
                let blocker = TcpListener::bind(endpoint.origin.strip_prefix("http://").unwrap())
                    .await
                    .unwrap();
                let moved = Fixture::start_in(root).await;
                let moved_endpoint = moved.host.loopback.endpoint().unwrap();
                assert_ne!(moved_endpoint.origin, endpoint.origin);
                assert_eq!(moved_endpoint.host_id, endpoint.host_id);
                assert_ne!(moved_endpoint.generation, endpoint.generation);
                let mut old_origin_request = moved_endpoint
                    .websocket_url
                    .clone()
                    .into_client_request()
                    .unwrap();
                old_origin_request
                    .headers_mut()
                    .insert("origin", endpoint.origin.parse().unwrap());
                assert!(
                    tokio_tungstenite::connect_async(old_origin_request)
                        .await
                        .is_err()
                );
                let (status, error) =
                    browser_post(&moved_endpoint, &moved_endpoint.origin, "ticket", old_proof)
                        .await;
                assert_eq!(status, 403);
                assert_eq!(error, json!({"error":"authentication failed"}));
                let mut stale = unused_browser.clone();
                stale.origin = moved_endpoint.origin.clone();
                stale.websocket_url = moved_endpoint.websocket_url.clone();
                stale.generation = moved_endpoint.generation.clone();
                let mut stale_socket = connect(&stale, &stale.origin).await;
                write(&mut stale_socket, hello(&stale)).await;
                closed(&mut stale_socket).await;
                let new_ticket = browser_ticket(&moved, &key).await;
                let _new_socket = authenticate(&new_ticket).await;
                assert_eq!(
                    moved
                        .client()
                        .await
                        .browser_devices()
                        .await
                        .unwrap()
                        .devices[0]
                        .device_id,
                    device_id
                );
                drop(blocker);
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn authenticated_unix_ticket_connects_to_real_loopback_status() {
        tokio::task::LocalSet::new().run_until(async {
            let fixture = Fixture::start().await;
            let client = fixture.client().await;
            let ticket = client.web_ticket(ELECTRON_ORIGIN).await.unwrap();
            let endpoint: LoopbackEndpoint = storage::read(&fixture.host.home.join("host/endpoint.json")).unwrap();
            assert_eq!(endpoint.websocket_url, ticket.websocket_url);
            assert_eq!(endpoint.generation, client.identity().generation);
            let mut request = ticket.websocket_url.clone().into_client_request().unwrap();
            request.headers_mut().insert("origin", ELECTRON_ORIGIN.parse().unwrap());
            let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
            socket.send(Message::Text(json!({"version":1,"id":"hello","method":"hello","params":{"protocolVersions":[1],"capabilities":[],"ticket":ticket.ticket,"expectedGeneration":ticket.generation}}).to_string().into())).await.unwrap();
            let hello: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(hello["result"]["hostId"], client.identity().host_id);
            assert_eq!(hello["result"]["methods"], json!(["host.status"]));
            socket.send(Message::Text(json!({"version":1,"id":"status","method":"host.status","params":{}}).to_string().into())).await.unwrap();
            let response: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(response["result"], serde_json::to_value(client.status().await.unwrap()).unwrap());
            let typed: areal_protocol::host::LocalHostStatusResult = serde_json::from_value(response["result"].clone()).unwrap();
            assert_eq!(serde_json::to_value(typed).unwrap(), response["result"]);
        }).await;
    }
}
