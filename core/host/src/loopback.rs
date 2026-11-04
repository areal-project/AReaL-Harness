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
use http_body_util::Full;
use hyper::{Request, Response, body::Incoming, service::service_fn};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    convert::Infallible,
    io::Read,
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

const METHODS: &[&str] = &["host.status"];
const TTL: Duration = Duration::from_secs(30);
const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_TICKETS: usize = 64;
const MAX_CONNECTIONS: usize = 32;
const ELECTRON_ORIGIN: &str = "areal-ui://app";
type Socket = WebSocketStream<TokioIo<hyper::upgrade::Upgraded>>;

struct Ticket {
    origin: String,
    generation: String,
    deadline: Instant,
}
#[derive(Default)]
pub(super) struct Loopback {
    endpoint: RefCell<Option<LoopbackEndpoint>>,
    tickets: RefCell<BTreeMap<String, Ticket>>,
}
impl Loopback {
    pub(super) fn ticket(&self, input: LocalWebTicketParams) -> Result<LocalWebTicketResult> {
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
        })
    }
    fn consume(&self, secret: &str, origin: &str, generation: &str) -> Result<()> {
        ensure!(secret.len() == 64, "authentication failed");
        let key = storage::digest(secret.as_bytes());
        let mut tickets = self.tickets.borrow_mut();
        let ticket = tickets.get(&key).context("authentication failed")?;
        ensure!(
            ticket.deadline > Instant::now()
                && ticket.origin == origin
                && ticket.generation == generation,
            "authentication failed"
        );
        tickets.remove(&key);
        Ok(())
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
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let authority = listener.local_addr()?.to_string();
        let endpoint = LoopbackEndpoint {
            version: VERSION.into(),
            host_id: host.identity.host_id.clone(),
            generation: host.identity.generation.clone(),
            origin: format!("http://{authority}"),
            websocket_url: format!("ws://{authority}/host/socket"),
        };
        storage::write(&path, &endpoint)?;
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
    let service = service_fn(move |mut request: Request<Incoming>| {
        let valid = request.uri().path() == "/host/socket"
            && request.uri().query().is_none()
            && request.uri().authority().is_none()
            && request.headers().get_all("host").iter().count() == 1
            && request.headers().get("host").and_then(|v| v.to_str().ok())
                == Some(authority.as_str())
            && request.headers().get_all("origin").iter().count() == 1;
        let origin = request
            .headers()
            .get("origin")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned();
        let valid = valid && (origin == ELECTRON_ORIGIN || origin == endpoint.origin);
        let mut handshake = Request::builder()
            .method(request.method())
            .uri(request.uri())
            .version(request.version())
            .body(())
            .unwrap();
        *handshake.headers_mut() = request.headers().clone();
        let response = if valid {
            tokio_tungstenite::tungstenite::handshake::server::create_response(&handshake).ok()
        } else {
            None
        };
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
        async move { Ok::<_, Infallible>(response) }
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
    host.loopback
        .consume(&hello.ticket, &origin, &hello.expected_generation)?;
    let result = protocol::LoopbackHelloResult {
        version: VERSION.into(),
        host_id: host.identity.host_id.clone(),
        generation: host.identity.generation.clone(),
        executable_version: host.identity.executable_version.clone(),
        capabilities: Vec::new(),
        methods: vec![protocol::LoopbackHelloResultFieldMethodsItem::Value1],
        transport: protocol::LoopbackHelloResultFieldTransport::Value1,
        scopes: vec![protocol::LoopbackHelloResultFieldScopesItem::Value1],
        limits: protocol::LoopbackLimits {
            max_frame_bytes: wire::MAX_FRAME as i64,
        },
    };
    send(
        &mut socket,
        &json!({"version":VERSION,"id":request.id,"result":result}),
    )
    .await?;
    while let Some(message) = socket.next().await {
        match message? {
            Message::Text(bytes) => {
                let request: wire::Request = serde_json::from_str(&bytes)?;
                ensure!(request.id.len() <= 256, "invalid request");
                let result = if request.version != VERSION {
                    Err(wire::error("unsupportedVersion", "Host requires version 1"))
                } else if request.id.is_empty() {
                    Err(wire::error("invalidRequest", "id must be nonempty"))
                } else if !METHODS.contains(&request.method.as_str()) {
                    Err(wire::error(
                        "methodNotFound",
                        "method is not available on this connection",
                    ))
                } else {
                    host.dispatch(&request.method, request.params).await
                };
                let response = match result {
                    Ok(value) => json!({"version":VERSION,"id":request.id,"result":value}),
                    Err(error) => {
                        let code = error
                            .downcast_ref::<wire::Error>()
                            .map(|error| error.code)
                            .unwrap_or(if error.downcast_ref::<serde_json::Error>().is_some() {
                                "invalidRequest"
                            } else {
                                "internalError"
                            });
                        json!({"version":VERSION,"id":request.id,"error":{"code":code,"message":"Host request failed"}})
                    }
                };
                send(&mut socket, &response).await?;
            }
            Message::Ping(_) => {
                tokio::time::timeout(TIMEOUT, socket.flush()).await??;
            }
            Message::Pong(_) => {}
            _ => break,
        }
    }
    Ok(())
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
    async fn restart_closes_old_connections_replaces_endpoint_and_invalidates_tickets() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let mut fixture = Fixture::start().await;
                let client = fixture.client().await;
                let unused = client.web_ticket(ELECTRON_ORIGIN).await.unwrap();
                let active = client.web_ticket(ELECTRON_ORIGIN).await.unwrap();
                let mut socket = authenticate(&active).await;
                let root = fixture._root.clone();
                let path = fixture.host.home.join("host/endpoint.json");
                fixture.tasks.shutdown().await;
                assert!(!path.exists());
                closed(&mut socket).await;
                drop(fixture);
                let restarted = Fixture::start_in(root).await;
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
