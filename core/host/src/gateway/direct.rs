use super::relay::Counters;
use anyhow::{Result, ensure};
use base64::Engine;
use bytes::Bytes;
use futures_util::{
    SinkExt, StreamExt,
    io::{AsyncRead, AsyncWrite},
    task::AtomicWaker,
};
use http_body_util::Full;
use hyper::{Request, Response, body::Incoming, service::service_fn};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::Deserialize;
use std::{
    cell::RefCell,
    collections::{BTreeMap, VecDeque},
    convert::Infallible,
    future::Future,
    io,
    path::Path,
    pin::Pin,
    rc::Rc,
    sync::{Arc, Mutex, Weak},
    task::{Context as TaskContext, Poll},
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::{Notify, mpsc},
    task::JoinSet,
    time::Instant,
};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{
        self, Message,
        protocol::{Role, WebSocketConfig},
    },
};
use tokio_util::sync::CancellationToken;

const FRAME: usize = 512 * 1024;
const SEND: usize = 1024 * 1024;
const RECEIVE: usize = 2 * 1024 * 1024;
const CLOSE: Duration = Duration::from_secs(15);
type Body = Full<Bytes>;
type Socket = WebSocketStream<TokioIo<hyper::upgrade::Upgraded>>;
type Writer = futures_util::stream::SplitSink<Socket, Message>;
type Sending = Pin<
    Box<dyn Future<Output = (Writer, std::result::Result<(), tungstenite::Error>, Sent)> + Send>,
>;

struct Asset {
    path: String,
    mime: hyper::header::HeaderValue,
    bytes: Bytes,
}
pub(crate) struct Assets {
    files: BTreeMap<String, Asset>,
}
impl Assets {
    pub(crate) fn load(root: &Path) -> Result<Self> {
        #[derive(Deserialize)]
        struct Entry {
            path: String,
            mime: String,
            sha256: String,
        }
        #[derive(Deserialize)]
        struct Manifest {
            schema: u32,
            entry: String,
            assets: Vec<Entry>,
            worker: Entry,
        }
        let manifest: Manifest =
            serde_json::from_slice(&std::fs::read(root.join("remote-assets.json"))?)?;
        ensure!(
            manifest.schema == 1
                && manifest.entry == "remote.html"
                && manifest.worker.path == "remote-sw.js",
            "Remote 静态清单无效"
        );
        let mut files = BTreeMap::new();
        for entry in manifest
            .assets
            .into_iter()
            .chain(std::iter::once(manifest.worker))
        {
            ensure!(
                valid_path(&entry.path)
                    && !entry.mime.contains(['\r', '\n'])
                    && entry.sha256.len() == 64
                    && entry
                        .sha256
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
                "Remote 静态资源无效"
            );
            let bytes = std::fs::read(root.join(&entry.path))?;
            ensure!(
                areal_local_service::storage::digest(&bytes) == entry.sha256,
                "Remote 静态资源版本不一致"
            );
            let key = format!("/{}", entry.path);
            ensure!(!files.contains_key(&key), "Remote 静态资源重复");
            files.insert(
                key,
                Asset {
                    path: entry.path,
                    mime: hyper::header::HeaderValue::from_str(&entry.mime)?,
                    bytes: Bytes::from(bytes),
                },
            );
        }
        ensure!(files.contains_key("/remote.html"), "Remote 静态入口缺失");
        Ok(Self { files })
    }
}
fn valid_path(path: &str) -> bool {
    let Some((stem, extension)) = path.rsplit_once('.') else {
        return false;
    };
    if extension.is_empty()
        || !extension.bytes().all(|b| b.is_ascii_alphanumeric())
        || path
            .split('/')
            .any(|s| s.is_empty() || matches!(s, "." | ".."))
    {
        return false;
    }
    stem.split('/').enumerate().all(|(index, segment)| {
        !segment.is_empty()
            && segment.bytes().all(|b| {
                b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || (index > 0 && b == b'.')
            })
    })
}

struct Job {
    id: u64,
    bytes: Vec<u8>,
    offset: usize,
    size: usize,
}
struct Endpoint {
    closed: bool,
    closing: Option<Instant>,
    sequence: u64,
    input: VecDeque<Vec<u8>>,
    offset: usize,
    input_bytes: usize,
    output: VecDeque<Job>,
    output_bytes: usize,
    reader: AtomicWaker,
    closer: AtomicWaker,
}
struct Channel {
    endpoint: Mutex<Endpoint>,
    counters: Arc<Counters>,
    changed: Notify,
    stop: CancellationToken,
}
impl Channel {
    fn new(counters: Arc<Counters>) -> Arc<Self> {
        Arc::new(Self {
            endpoint: Mutex::new(Endpoint {
                closed: false,
                closing: None,
                sequence: 0,
                input: VecDeque::new(),
                offset: 0,
                input_bytes: 0,
                output: VecDeque::new(),
                output_bytes: 0,
                reader: AtomicWaker::new(),
                closer: AtomicWaker::new(),
            }),
            counters,
            changed: Notify::new(),
            stop: CancellationToken::new(),
        })
    }
    fn close(&self) {
        let mut state = self.endpoint.lock().unwrap();
        if state.closed {
            return;
        }
        state.closed = true;
        self.counters.release_receive(state.input_bytes);
        self.counters.release_send(state.output_bytes);
        state.input_bytes = 0;
        state.output_bytes = 0;
        state.input.clear();
        state.output.clear();
        state.reader.wake();
        state.closer.wake();
        self.stop.cancel();
        self.changed.notify_one();
    }
    fn receive(&self, bytes: Vec<u8>) -> bool {
        if bytes.is_empty() {
            return true;
        }
        let mut state = self.endpoint.lock().unwrap();
        if state.closed
            || bytes.len() > RECEIVE.saturating_sub(state.input_bytes)
            || !self.counters.reserve_receive(bytes.len())
        {
            return false;
        }
        state.input_bytes += bytes.len();
        state.input.push_back(bytes);
        state.reader.wake();
        true
    }
}
pub(crate) struct DirectStream {
    channel: Arc<Channel>,
}
impl AsyncRead for DirectStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        bytes: &mut [u8],
    ) -> Poll<io::Result<usize>> {
        let mut state = self.channel.endpoint.lock().unwrap();
        if bytes.is_empty() {
            return Poll::Ready(Ok(0));
        }
        if let Some(input) = state.input.front() {
            let count = bytes.len().min(input.len() - state.offset);
            bytes[..count].copy_from_slice(&input[state.offset..state.offset + count]);
            state.offset += count;
            state.input_bytes -= count;
            self.channel.counters.release_receive(count);
            if state.offset == state.input.front().unwrap().len() {
                state.input.pop_front();
                state.offset = 0;
            }
            return Poll::Ready(Ok(count));
        }
        if state.closed {
            return Poll::Ready(Ok(0));
        }
        state.reader.register(cx.waker());
        Poll::Pending
    }
}
impl AsyncWrite for DirectStream {
    fn poll_write(
        self: Pin<&mut Self>,
        _: &mut TaskContext<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        let mut state = self.channel.endpoint.lock().unwrap();
        if state.closed || state.closing.is_some() {
            return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
        }
        if bytes.is_empty() {
            return Poll::Ready(Ok(0));
        }
        let Some(size) = bytes.len().checked_add(bytes.len().div_ceil(FRAME) * 14) else {
            return Poll::Ready(Err(io::ErrorKind::OutOfMemory.into()));
        };
        if size > SEND.saturating_sub(state.output_bytes)
            || !self.channel.counters.reserve_send(size)
        {
            drop(state);
            self.channel.close();
            return Poll::Ready(Err(io::Error::other("通道发送缓冲已满")));
        }
        state.sequence += 1;
        let id = state.sequence;
        state.output.push_back(Job {
            id,
            bytes: bytes.to_vec(),
            offset: 0,
            size,
        });
        state.output_bytes += size;
        self.channel.changed.notify_one();
        Poll::Ready(Ok(bytes.len()))
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_close(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        let mut state = self.channel.endpoint.lock().unwrap();
        if state.closed {
            return Poll::Ready(Ok(()));
        }
        state.closing.get_or_insert(Instant::now() + CLOSE);
        state.closer.register(cx.waker());
        self.channel.changed.notify_one();
        Poll::Pending
    }
}
impl Drop for DirectStream {
    fn drop(&mut self) {
        self.channel.close();
    }
}
struct Guard(Arc<Channel>);
impl Drop for Guard {
    fn drop(&mut self) {
        self.0.close();
    }
}
#[derive(Clone)]
enum Sent {
    Data {
        id: u64,
        offset: usize,
        count: usize,
        charge: usize,
    },
    Ping,
    Flush,
    Close,
}
async fn drive(socket: Socket, channel: Arc<Channel>, owner_stop: CancellationToken) {
    let _guard = Guard(channel.clone());
    let (writer, mut reader) = socket.split();
    let mut writer = Some(writer);
    let mut sending: Option<Sending> = None;
    let mut ping = false;
    let mut flush = false;
    let mut peer_closed = false;
    let mut last_pong = Instant::now();
    let mut heartbeat = tokio::time::interval_at(
        Instant::now() + Duration::from_secs(15),
        Duration::from_secs(15),
    );
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        let (closed, closing, job) = {
            let state = channel.endpoint.lock().unwrap();
            (
                state.closed,
                state.closing,
                state
                    .output
                    .front()
                    .filter(|_| sending.is_none())
                    .map(|job| {
                        let count = FRAME.min(job.bytes.len() - job.offset);
                        (
                            Message::Binary(Bytes::copy_from_slice(
                                &job.bytes[job.offset..job.offset + count],
                            )),
                            Sent::Data {
                                id: job.id,
                                offset: job.offset,
                                count,
                                charge: count + 14,
                            },
                        )
                    }),
            )
        };
        if closed || closing.is_some_and(|deadline| Instant::now() >= deadline) {
            break;
        }
        if sending.is_none() {
            let next = if peer_closed {
                Some((None, Sent::Close))
            } else if flush {
                flush = false;
                Some((None, Sent::Flush))
            } else if ping {
                ping = false;
                Some((Some(Message::Ping(Bytes::new())), Sent::Ping))
            } else if let Some(job) = job {
                Some((Some(job.0), job.1))
            } else if closing.is_some() {
                Some((Some(Message::Close(None)), Sent::Close))
            } else {
                None
            };
            if let Some((message, sent)) = next {
                let mut sink = writer.take().unwrap();
                sending = Some(Box::pin(async move {
                    let result = match message {
                        Some(message) => sink.send(message).await,
                        None => sink.flush().await,
                    };
                    (sink, result, sent)
                }));
            }
        }
        let deadline = closing.unwrap_or_else(|| Instant::now() + Duration::from_secs(86400));
        tokio::select! {
            biased;
            _ = owner_stop.cancelled() => break,
            _ = channel.stop.cancelled() => break,
            _ = tokio::time::sleep_until(deadline), if closing.is_some() => break,
            sent = async { match &mut sending { Some(sending) => sending.await, None => std::future::pending().await } } => {
                let (sink, result, sent) = sent; sending = None; writer = Some(sink);
                if result.is_err() { break; }
                if let Sent::Close = sent { break; }
                if let Sent::Data { id, offset, count, charge } = sent {
                    let mut state = channel.endpoint.lock().unwrap();
                    if state.output.front().is_some_and(|job| job.id == id && job.offset == offset) {
                        let job = state.output.front_mut().unwrap(); job.offset += count; job.size -= charge;
                        let complete = job.offset == job.bytes.len();
                        state.output_bytes -= charge; channel.counters.release_send(charge);
                        if complete { state.output.pop_front(); }
                    }
                }
            },
            incoming = reader.next(), if !peer_closed => match incoming {
                Some(Ok(Message::Binary(bytes))) => if bytes.len() > FRAME || !channel.receive(bytes.to_vec()) { break; },
                Some(Ok(Message::Pong(_))) => last_pong = Instant::now(),
                Some(Ok(Message::Ping(_))) => flush = true,
                Some(Ok(Message::Close(_))) => { peer_closed = true; let mut state = channel.endpoint.lock().unwrap(); state.closing.get_or_insert(Instant::now() + CLOSE); },
                Some(Ok(Message::Frame(_))) => {},
                _ => break,
            },
            _ = heartbeat.tick() => { if last_pong.elapsed() > Duration::from_secs(45) { break; } ping = true; },
            _ = channel.changed.notified() => {},
        }
    }
}

struct HandleState {
    origin: String,
    port: u16,
    stop: CancellationToken,
    channels: RefCell<Vec<Weak<Channel>>>,
}
#[derive(Clone)]
pub(crate) struct DirectHandle(Rc<HandleState>);
impl DirectHandle {
    pub(crate) fn origin(&self) -> &str {
        &self.0.origin
    }
    pub(crate) fn port(&self) -> u16 {
        self.0.port
    }
    pub(crate) fn stop(&self) {
        for channel in self.0.channels.borrow().iter().filter_map(Weak::upgrade) {
            channel.close();
        }
        self.0.stop.cancel();
    }
}
pub(crate) enum DirectEvent {
    Channel {
        stream: DirectStream,
        close: Rc<dyn Fn()>,
    },
}
pub(crate) struct DirectOwner {
    listener: TcpListener,
    assets: Rc<Assets>,
    external: Option<(String, String)>,
    counters: Arc<Counters>,
    admit: Rc<dyn Fn() -> bool>,
    handle: DirectHandle,
    events: mpsc::Sender<DirectEvent>,
}
impl Drop for DirectOwner {
    fn drop(&mut self) {
        self.handle.stop();
    }
}
impl DirectOwner {
    pub(crate) async fn bind(
        port: u16,
        assets: Rc<Assets>,
        external_origin: Option<String>,
        counters: Arc<Counters>,
        admit: Rc<dyn Fn() -> bool>,
    ) -> Result<(Self, DirectHandle, mpsc::Receiver<DirectEvent>)> {
        let external = external_origin
            .map(|origin| -> Result<_> {
                hyper::header::HeaderValue::from_str(&origin)?;
                let parsed = url::Url::parse(&origin)?;
                ensure!(
                    matches!(parsed.scheme(), "http" | "https")
                        && parsed.username().is_empty()
                        && parsed.password().is_none()
                        && parsed.query().is_none()
                        && parsed.fragment().is_none()
                        && parsed.path() == "/",
                    "Direct 外部来源无效"
                );
                let authority =
                    parsed[url::Position::BeforeHost..url::Position::AfterPort].to_owned();
                Ok((authority, origin))
            })
            .transpose()?;
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
        let port = listener.local_addr()?.port();
        let handle = DirectHandle(Rc::new(HandleState {
            origin: format!("http://127.0.0.1:{port}"),
            port,
            stop: CancellationToken::new(),
            channels: RefCell::new(Vec::new()),
        }));
        let (events, receiver) = mpsc::channel(32);
        Ok((
            Self {
                listener,
                assets,
                external,
                counters,
                admit,
                handle: handle.clone(),
                events,
            },
            handle,
            receiver,
        ))
    }
    pub(crate) async fn run(self) {
        let mut requests = JoinSet::new();
        loop {
            tokio::select! {
                biased;
                _ = self.handle.0.stop.cancelled() => break,
                connection = self.listener.accept() => {
                    let Ok((socket, _)) = connection else { break; };
                    let assets = self.assets.clone(); let external = self.external.clone(); let handle = self.handle.clone(); let counters = self.counters.clone(); let events = self.events.clone(); let admit = self.admit.clone();
                    requests.spawn_local(async move {
                        let stop = handle.0.stop.clone();
                        let service = service_fn(move |request| respond(request, assets.clone(), external.clone(), handle.clone(), counters.clone(), events.clone(), admit.clone()));
                        let connection = hyper::server::conn::http1::Builder::new().timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(15)).max_buf_size(16384).serve_connection(TokioIo::new(socket), service).with_upgrades();
                        tokio::select! { _ = stop.cancelled() => {}, _ = connection => {} }
                    });
                },
                _ = requests.join_next(), if !requests.is_empty() => {},
            }
        }
        self.handle.stop();
        requests.abort_all();
        while requests.join_next().await.is_some() {}
    }
}
fn empty(status: u16) -> Response<Body> {
    Response::builder()
        .status(status)
        .body(Full::new(Bytes::new()))
        .unwrap()
}
async fn respond(
    mut request: Request<Incoming>,
    assets: Rc<Assets>,
    external: Option<(String, String)>,
    handle: DirectHandle,
    counters: Arc<Counters>,
    events: mpsc::Sender<DirectEvent>,
    admit: Rc<dyn Fn() -> bool>,
) -> std::result::Result<Response<Body>, Infallible> {
    let host = request
        .headers()
        .get("host")
        .and_then(|value| value.to_str().ok());
    let loopback = url::Url::parse(handle.origin()).unwrap();
    let authority = &loopback[url::Position::BeforeHost..url::Position::AfterPort];
    let origin = if host == Some(authority) {
        Some(handle.origin().to_owned())
    } else {
        external
            .filter(|(authority, _)| host == Some(authority))
            .map(|(_, origin)| origin)
    };
    let Some(origin) = origin.filter(|_| !handle.0.stop.is_cancelled()) else {
        return Ok(empty(404));
    };
    if request.method() != hyper::Method::GET {
        return Ok(empty(404));
    }
    let path = request.uri().to_string();
    if path == "/remote/socket" {
        if request
            .headers()
            .get("origin")
            .and_then(|value| value.to_str().ok())
            != Some(origin.as_str())
            || !(admit)()
        {
            return Ok(empty(404));
        }
        let valid_key = request
            .headers()
            .get("sec-websocket-key")
            .and_then(|key| key.to_str().ok())
            .and_then(|key| base64::engine::general_purpose::STANDARD.decode(key).ok())
            .is_some_and(|key| key.len() == 16);
        if !valid_key {
            return Ok(empty(400));
        }
        let mut upgrade_request = Request::builder()
            .method(request.method())
            .uri(request.uri())
            .version(request.version())
            .body(())
            .unwrap();
        *upgrade_request.headers_mut() = request.headers().clone();
        let Ok(response) = tungstenite::handshake::server::create_response(&upgrade_request) else {
            return Ok(empty(400));
        };
        let upgrade = hyper::upgrade::on(&mut request);
        tokio::task::spawn_local(async move {
            let upgraded = tokio::select! {
                biased;
                _ = handle.0.stop.cancelled() => return,
                result = upgrade => match result { Ok(upgraded) => upgraded, Err(_) => return },
            };
            if handle.0.stop.is_cancelled() || !(admit)() {
                return;
            }
            let mut config = WebSocketConfig::default();
            config.max_message_size = Some(FRAME);
            config.max_frame_size = Some(FRAME);
            config.max_write_buffer_size = SEND;
            let socket = WebSocketStream::from_raw_socket(
                TokioIo::new(upgraded),
                Role::Server,
                Some(config),
            )
            .await;
            let channel = Channel::new(counters);
            {
                let mut channels = handle.0.channels.borrow_mut();
                channels.retain(|channel| channel.strong_count() > 0);
                channels.push(Arc::downgrade(&channel));
            }
            let close_channel = channel.clone();
            let event = DirectEvent::Channel {
                stream: DirectStream {
                    channel: channel.clone(),
                },
                close: Rc::new(move || close_channel.close()),
            };
            tokio::select! {
                biased;
                _ = handle.0.stop.cancelled() => return,
                _ = channel.stop.cancelled() => return,
                result = events.send(event) => if result.is_err() { return; },
            }
            drive(socket, channel, handle.0.stop.clone()).await;
        });
        let (parts, _) = response.into_parts();
        return Ok(Response::from_parts(parts, Full::new(Bytes::new())));
    }
    if let Some(asset) = assets
        .files
        .get(if path == "/" { "/remote.html" } else { &path })
    {
        let response = Response::builder().status(200).header("content-type", &asset.mime)
            .header("content-security-policy", format!("default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' blob:; font-src 'self'; manifest-src 'self'; worker-src 'self'; connect-src 'self' {}; base-uri 'none'; frame-ancestors 'none'", origin.replacen("http", "ws", 1)))
            .header("referrer-policy", "no-referrer").header("permissions-policy", "camera=(), microphone=(), geolocation=()")
            .header("x-content-type-options", "nosniff").header("cache-control", if asset.path.starts_with("assets/") { "public, max-age=31536000, immutable" } else if asset.path == "remote-sw.js" { "no-cache" } else { "no-store" });
        let response = if asset.path == "remote-sw.js" {
            response.header("service-worker-allowed", "/")
        } else {
            response
        };
        return Ok(response.body(Full::new(asset.bytes.clone())).unwrap());
    }
    if path == "/health" {
        return Ok(Response::builder()
            .status(200)
            .header("content-type", "application/json")
            .header("cache-control", "no-store")
            .body(Full::new(Bytes::from_static(b"{\"status\":\"ready\"}")))
            .unwrap());
    }
    Ok(empty(404))
}
