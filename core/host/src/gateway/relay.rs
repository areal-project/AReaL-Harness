//! 单代 Relay socket 拥有路由、限额和发送时钟。授权仍由 LocalSet 上的 Host 提供。
use super::relay_codec;
use anyhow::{Context, Result, bail, ensure};
use futures_util::{
    SinkExt, StreamExt,
    io::{AsyncRead, AsyncWrite},
    task::AtomicWaker,
};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::{BTreeMap, VecDeque},
    io,
    pin::Pin,
    rc::Rc,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    task::{Context as TaskContext, Poll},
    time::Duration,
};
use tokio::{
    sync::{Notify, mpsc},
    time::Instant,
};
use tokio_tungstenite::{
    connect_async_tls_with_config,
    tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig},
};

const CHANNELS: usize = 16;
const SEND_BYTES: usize = 1024 * 1024;
const RECEIVE_BYTES: usize = 2 * 1024 * 1024;
const HOST_BYTES: usize = 8 * 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(15);

pub(crate) struct RelayConfig {
    pub(crate) url: String,
    pub(crate) room: String,
    pub(crate) capability: String,
    /// 仅本机 Relay 的环回连接保留公开 authority。
    pub(crate) local_host: Option<String>,
}

pub(crate) enum RelayEvent {
    Ready {
        generation: u64,
        push: bool,
    },
    Channel {
        generation: u64,
        id: String,
        stream: RelayStream,
    },
    Disconnected {
        generation: u64,
        reason: String,
        retry: bool,
    },
    PushUnregistered(String),
    PushDropped,
}

#[derive(Default)]
pub(crate) struct Counters {
    send: AtomicUsize,
    receive: AtomicUsize,
    changed: Notify,
}
impl Counters {
    fn reserve(&self, counter: &AtomicUsize, bytes: usize) -> bool {
        let mut current = counter.load(Ordering::SeqCst);
        loop {
            let Some(next) = current
                .checked_add(bytes)
                .filter(|next| *next <= HOST_BYTES)
            else {
                return false;
            };
            match counter.compare_exchange_weak(current, next, Ordering::SeqCst, Ordering::SeqCst) {
                Ok(_) => return true,
                Err(observed) => current = observed,
            }
        }
    }
    pub(crate) fn reserve_send(&self, bytes: usize) -> bool {
        self.reserve(&self.send, bytes)
    }
    pub(crate) fn reserve_receive(&self, bytes: usize) -> bool {
        self.reserve(&self.receive, bytes)
    }
    pub(crate) fn release_send(&self, bytes: usize) {
        self.send.fetch_sub(bytes, Ordering::SeqCst);
        self.changed.notify_one();
    }
    pub(crate) fn release_receive(&self, bytes: usize) {
        self.receive.fetch_sub(bytes, Ordering::SeqCst);
    }
}
struct Job {
    bytes: Vec<u8>,
    offset: usize,
    size: usize,
}
#[derive(Clone, Copy)]
enum Phase {
    Open,
    Closing(Instant),
    Closed,
}
struct Endpoint {
    phase: Phase,
    input: VecDeque<Vec<u8>>,
    input_offset: usize,
    input_bytes: usize,
    output: VecDeque<Job>,
    output_bytes: usize,
    reader: AtomicWaker,
    closer: AtomicWaker,
}
impl Endpoint {
    fn close(&mut self, counters: &Counters, discard_input: bool) {
        self.phase = Phase::Closed;
        counters.send.fetch_sub(self.output_bytes, Ordering::SeqCst);
        self.output.clear();
        self.output_bytes = 0;
        if discard_input {
            counters
                .receive
                .fetch_sub(self.input_bytes, Ordering::SeqCst);
            self.input.clear();
            self.input_bytes = 0;
            self.input_offset = 0;
        }
        self.reader.wake();
        self.closer.wake();
    }
}

/// Noise 可移动其字节流，Host 的授权闭包和 socket owner 始终留在 LocalSet。
pub(crate) struct RelayStream {
    endpoint: Arc<Mutex<Endpoint>>,
    counters: Arc<Counters>,
    chunk_bytes: usize,
}
impl AsyncRead for RelayStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        bytes: &mut [u8],
    ) -> Poll<io::Result<usize>> {
        let mut endpoint = self.endpoint.lock().unwrap();
        if bytes.is_empty() {
            return Poll::Ready(Ok(0));
        }
        if let Some(input) = endpoint.input.front() {
            let count = bytes.len().min(input.len() - endpoint.input_offset);
            bytes[..count]
                .copy_from_slice(&input[endpoint.input_offset..endpoint.input_offset + count]);
            endpoint.input_offset += count;
            endpoint.input_bytes -= count;
            self.counters.receive.fetch_sub(count, Ordering::SeqCst);
            if endpoint.input_offset == endpoint.input.front().unwrap().len() {
                endpoint.input.pop_front();
                endpoint.input_offset = 0;
            }
            return Poll::Ready(Ok(count));
        }
        if matches!(endpoint.phase, Phase::Closed) {
            return Poll::Ready(Ok(0));
        }
        endpoint.reader.register(cx.waker());
        Poll::Pending
    }
}
impl AsyncWrite for RelayStream {
    fn poll_write(
        self: Pin<&mut Self>,
        _: &mut TaskContext<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        let mut endpoint = self.endpoint.lock().unwrap();
        if !matches!(endpoint.phase, Phase::Open) {
            return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
        }
        if bytes.is_empty() {
            return Poll::Ready(Ok(0));
        }
        let size = bytes.len().div_ceil(3) * 4 + bytes.len().div_ceil(self.chunk_bytes) * 128;
        if size + endpoint.output_bytes > SEND_BYTES
            || size + self.counters.send.load(Ordering::SeqCst) > HOST_BYTES
        {
            endpoint.close(&self.counters, true);
            self.counters.changed.notify_one();
            return Poll::Ready(Err(io::Error::other("通道发送缓冲已满")));
        }
        endpoint.output_bytes += size;
        self.counters.send.fetch_add(size, Ordering::SeqCst);
        endpoint.output.push_back(Job {
            bytes: bytes.to_vec(),
            offset: 0,
            size,
        });
        self.counters.changed.notify_one();
        Poll::Ready(Ok(bytes.len()))
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_close(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        let mut endpoint = self.endpoint.lock().unwrap();
        if matches!(endpoint.phase, Phase::Open) {
            endpoint.phase = Phase::Closing(Instant::now() + DEADLINE);
            self.counters.changed.notify_one();
        }
        if matches!(endpoint.phase, Phase::Closed) {
            return Poll::Ready(Ok(()));
        }
        endpoint.closer.register(cx.waker());
        Poll::Pending
    }
}
impl Drop for RelayStream {
    fn drop(&mut self) {
        self.endpoint.lock().unwrap().close(&self.counters, true);
        self.counters.changed.notify_one();
    }
}

struct Control {
    key: String,
    text: String,
    authorized: Option<Rc<dyn Fn() -> bool>>,
}
struct LocalState {
    generation: u64,
    stopped: bool,
    ready: bool,
    push: bool,
    max_frame_bytes: usize,
    channels: BTreeMap<String, Arc<Mutex<Endpoint>>>,
    controls: VecDeque<Control>,
}
impl LocalState {
    fn remove_control(&mut self, key: &str, counters: &Counters) {
        if let Some(index) = self.controls.iter().position(|control| control.key == key) {
            let control = self.controls.remove(index).unwrap();
            counters
                .send
                .fetch_sub(control.text.len(), Ordering::SeqCst);
        }
    }
    fn clear(&mut self, counters: &Counters) {
        self.ready = false;
        self.push = false;
        for endpoint in self.channels.values() {
            endpoint.lock().unwrap().close(counters, true);
        }
        self.channels.clear();
        for control in self.controls.drain(..) {
            counters
                .send
                .fetch_sub(control.text.len(), Ordering::SeqCst);
        }
    }
    fn close_control(&mut self, id: &str, counters: &Counters) -> Result<()> {
        if self.controls.iter().any(|control| control.key == id) {
            return Ok(());
        }
        if self.controls.len() >= CHANNELS * 2 {
            let push = self
                .controls
                .iter()
                .find(|control| control.authorized.is_some())
                .map(|control| control.key.clone());
            let Some(push) = push else {
                bail!("Relay 控制缓冲已满")
            };
            self.remove_control(&push, counters);
        }
        let text = json!({"type":"close","channel":id}).to_string();
        counters.send.fetch_add(text.len(), Ordering::SeqCst);
        self.controls.push_back(Control {
            key: id.to_owned(),
            text,
            authorized: None,
        });
        Ok(())
    }
}

#[derive(Clone)]
pub(crate) struct RelayHandle {
    local: Rc<RefCell<LocalState>>,
    counters: Arc<Counters>,
}
impl RelayHandle {
    pub(crate) fn stop(&self) {
        let mut state = self.local.borrow_mut();
        state.stopped = true;
        state.generation += 1;
        state.clear(&self.counters);
        self.counters.changed.notify_one();
    }
    pub(crate) fn reconnect(&self) {
        let mut state = self.local.borrow_mut();
        state.generation += 1;
        state.clear(&self.counters);
        self.counters.changed.notify_one();
    }
    pub(crate) fn abort(&self, generation: u64, id: &str) {
        let state = self.local.borrow();
        if state.generation != generation {
            return;
        }
        if let Some(endpoint) = state.channels.get(id) {
            endpoint.lock().unwrap().close(&self.counters, true);
        }
        self.counters.changed.notify_one();
    }
    /// value 是 Host 已生成的 push 消息；发送时仍须重新检查当前授权。
    pub(crate) fn try_push(&self, value: Value, authorized: Rc<dyn Fn() -> bool>) -> bool {
        let mut state = self.local.borrow_mut();
        let text = value.to_string();
        if !state.ready
            || !state.push
            || !authorized()
            || value["type"] != "push"
            || !value["target"].as_object().is_some_and(|target| {
                target.values().all(|value| {
                    value
                        .as_str()
                        .is_some_and(|value| !value.is_empty() && value.len() <= 256)
                })
            })
            || text.len() > state.max_frame_bytes
            || state
                .controls
                .iter()
                .filter(|control| control.authorized.is_some())
                .count()
                >= CHANNELS
            || state.controls.len() >= CHANNELS * 2
            || self.counters.send.load(Ordering::SeqCst) + text.len() > HOST_BYTES
        {
            return false;
        }
        let key = format!(
            "push:{}:{}",
            value["token"].as_str().unwrap_or_default(),
            value["collapseId"].as_str().unwrap_or_default()
        );
        state.remove_control(&key, &self.counters);
        self.counters.send.fetch_add(text.len(), Ordering::SeqCst);
        state.controls.push_back(Control {
            key,
            text,
            authorized: Some(authorized),
        });
        self.counters.changed.notify_one();
        true
    }
}

struct Budget {
    chunk_bytes: usize,
    frame_interval: Duration,
    bytes_per_second: f64,
    next_send: Instant,
}
impl Budget {
    fn from_ready(value: &Value) -> Result<Self> {
        let limits = &value["limits"];
        let frames = limits["framesPerSecond"]
            .as_f64()
            .context("Relay 未声明传输限额")?;
        let heartbeat = limits["heartbeatIntervalMs"]
            .as_f64()
            .context("Relay heartbeat")?;
        let data_frames = frames - (1000.0 / heartbeat).ceil() - 2.0;
        let bytes = limits["bytesPerSecond"].as_f64().context("Relay bytes")?;
        let envelope = limits["maxFrameBytes"]
            .as_f64()
            .context("Relay frame")?
            .min((bytes / 4.0).floor());
        ensure!(data_frames > 0.0 && envelope >= 132.0, "Relay 限额不足");
        let chunk_bytes = relay_codec::DATA_BYTES.min(((envelope as usize - 128) / 4) * 3);
        ensure!(chunk_bytes > 0, "Relay 限额不足");
        Ok(Self {
            chunk_bytes,
            frame_interval: Duration::from_secs_f64(1.0 / data_frames),
            bytes_per_second: bytes * 0.75,
            next_send: Instant::now() + Duration::from_millis(1050),
        })
    }
    fn sent(&mut self, size: usize) {
        self.next_send = Instant::now()
            + self
                .frame_interval
                .max(Duration::from_secs_f64(size as f64 / self.bytes_per_second));
    }
}

pub(crate) struct RelayOwner {
    config: RelayConfig,
    handle: RelayHandle,
    events: mpsc::Sender<RelayEvent>,
}
impl RelayOwner {
    pub(crate) fn new(config: RelayConfig) -> (Self, RelayHandle, mpsc::Receiver<RelayEvent>) {
        Self::with_counters(config, Arc::new(Counters::default()))
    }
    pub(crate) fn with_counters(
        config: RelayConfig,
        counters: Arc<Counters>,
    ) -> (Self, RelayHandle, mpsc::Receiver<RelayEvent>) {
        let handle = RelayHandle {
            local: Rc::new(RefCell::new(LocalState {
                generation: 0,
                stopped: false,
                ready: false,
                push: false,
                max_frame_bytes: 0,
                channels: BTreeMap::new(),
                controls: VecDeque::new(),
            })),
            counters,
        };
        let (events, receiver) = mpsc::channel(32);
        (
            Self {
                config,
                handle: handle.clone(),
                events,
            },
            handle,
            receiver,
        )
    }
    fn current(&self, generation: u64) -> bool {
        let state = self.handle.local.borrow();
        !state.stopped && state.generation == generation
    }
    pub(crate) async fn run(self) {
        loop {
            let generation = {
                let mut state = self.handle.local.borrow_mut();
                if state.stopped || self.events.is_closed() {
                    state.clear(&self.handle.counters);
                    return;
                }
                state.generation += 1;
                state.generation
            };
            let outcome = self.connection(generation).await;
            let reason = match &outcome {
                Ok(reason) => (*reason).to_owned(),
                Err(error) => format!("{error:#}"),
            };
            let retry = !matches!(outcome, Ok("REPLACED" | "UNSUPPORTED"));
            self.handle.local.borrow_mut().clear(&self.handle.counters);
            let _ = self.events.try_send(RelayEvent::Disconnected {
                generation,
                reason,
                retry,
            });
            if self.handle.local.borrow().stopped || self.events.is_closed() || !retry {
                return;
            }
            if self.current(generation) {
                tokio::select! { _ = tokio::time::sleep(Duration::from_secs(3)) => {}, _ = self.handle.counters.changed.notified() => {}, _ = self.events.closed() => return }
            }
        }
    }
    async fn send<S>(
        &self,
        generation: u64,
        socket: &mut tokio_tungstenite::WebSocketStream<S>,
        text: String,
    ) -> Result<bool>
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        if !self.current(generation) {
            return Ok(false);
        }
        let sending = socket.send(Message::Text(text.into()));
        tokio::pin!(sending);
        loop {
            let close_at = self
                .handle
                .local
                .borrow()
                .channels
                .values()
                .filter_map(|endpoint| match endpoint.lock().unwrap().phase {
                    Phase::Closing(at) => Some(at),
                    _ => None,
                })
                .min();
            tokio::select! { biased;
                _ = self.events.closed() => return Ok(false),
                _ = self.handle.counters.changed.notified() => {
                    if !self.current(generation) { return Ok(false); }
                    self.reap()?;
                },
                _ = async { match close_at { Some(at) => tokio::time::sleep_until(at).await, None => std::future::pending().await } } => self.reap()?,
                result = &mut sending => { result?; return Ok(true); },
            }
        }
    }
    async fn send_frame<S>(
        &self,
        generation: u64,
        socket: &mut tokio_tungstenite::WebSocketStream<S>,
        frame: &Frame,
    ) -> Result<bool>
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        if !self.send(generation, socket, frame.text.clone()).await? {
            return Ok(false);
        }
        if frame.control {
            let mut state = self.handle.local.borrow_mut();
            if state
                .controls
                .iter()
                .any(|control| control.key == frame.key && control.text == frame.text)
            {
                state.remove_control(&frame.key, &self.handle.counters);
            }
        }
        Ok(true)
    }
    async fn connection(&self, generation: u64) -> Result<&'static str> {
        let mut request = self.config.url.as_str().into_client_request()?;
        let uri = request.uri();
        if let Some(host) = &self.config.local_host {
            ensure!(
                uri.scheme_str() == Some("ws") && uri.host() == Some("127.0.0.1"),
                "本机 Relay 必须使用环回地址"
            );
            request.headers_mut().insert("Host", host.parse()?);
        } else {
            ensure!(uri.scheme_str() == Some("wss"), "Relay 必须使用 WSS");
        }
        request
            .headers_mut()
            .insert("X-Areal-Relay-Capabilities", "push".parse()?);
        let config = WebSocketConfig::default()
            .max_message_size(Some(relay_codec::FRAME_BYTES))
            .max_frame_size(Some(relay_codec::FRAME_BYTES))
            .write_buffer_size(0)
            .max_write_buffer_size(SEND_BYTES);
        // 与模型 WebSocket 使用相同的连接级 provider；完整二进制同时链接 ring 和 aws-lc。
        let connector = if request.uri().scheme_str() == Some("wss") {
            let certificates = rustls_native_certs::load_native_certs();
            let mut roots = rustls::RootCertStore::empty();
            roots.add_parsable_certificates(certificates.certs);
            ensure!(!roots.is_empty(), "no system TLS trust roots available");
            let config = rustls::ClientConfig::builder_with_provider(Arc::new(
                rustls::crypto::ring::default_provider(),
            ))
            .with_safe_default_protocol_versions()?
            .with_root_certificates(roots)
            .with_no_client_auth();
            Some(tokio_tungstenite::Connector::Rustls(Arc::new(config)))
        } else {
            None
        };
        let deadline = Instant::now() + DEADLINE;
        let connect = tokio::time::timeout_at(
            deadline,
            connect_async_tls_with_config(request, Some(config), false, connector),
        );
        tokio::pin!(connect);
        let (mut socket, _) = loop {
            tokio::select! { biased;
                _ = self.events.closed() => return Ok("CANCELLED"),
                _ = self.handle.counters.changed.notified() => { if !self.current(generation) { return Ok("CANCELLED"); } },
                result = &mut connect => break result.context("Relay 连接超时")??,
            }
        };
        let registration = json!({"protocol":"areal.relay.v1","role":"host","room":self.config.room,"capability":self.config.capability}).to_string();
        if !tokio::time::timeout_at(deadline, self.send(generation, &mut socket, registration))
            .await
            .context("Relay 注册超时")??
        {
            return Ok("CANCELLED");
        }
        let mut budget: Option<Budget> = None;
        let mut previous = String::new();
        let mut last_control = false;
        loop {
            if !self.current(generation) {
                return Ok("CANCELLED");
            }
            if budget.is_some() {
                self.reap()?;
            }
            let next = if let Some(budget) = &budget {
                let state = self.handle.local.borrow();
                let pending = !state.controls.is_empty()
                    || state
                        .channels
                        .values()
                        .any(|endpoint| !endpoint.lock().unwrap().output.is_empty());
                let closing = state
                    .channels
                    .values()
                    .filter_map(|endpoint| match endpoint.lock().unwrap().phase {
                        Phase::Closing(at) => Some(at),
                        _ => None,
                    })
                    .min();
                match (pending, closing) {
                    (true, Some(at)) => budget.next_send.min(at),
                    (true, None) => budget.next_send,
                    (false, Some(at)) => at,
                    (false, None) => Instant::now() + Duration::from_secs(86400),
                }
            } else {
                deadline
            };
            tokio::select! { biased;
                _ = self.events.closed() => return Ok("CANCELLED"),
                _ = self.handle.counters.changed.notified() => {},
                incoming = socket.next() => {
                    let Some(incoming) = incoming else { return Ok("UNAVAILABLE"); };
                    let incoming = incoming?;
                    if matches!(incoming, Message::Ping(_) | Message::Pong(_)) { continue; }
                    if matches!(incoming, Message::Close(_)) { return Ok("UNAVAILABLE"); }
                    let text = match incoming { Message::Text(text) => text, _ if budget.is_none() => return Ok("UNSUPPORTED"), _ => bail!("Relay 帧无效") };
                    let message = match relay_codec::decode_message(&text, false) { Ok(message) => message.into_value(), Err(error) => { if budget.is_none() { return Ok("UNSUPPORTED"); } return Err(error); } };
                    if message["type"] == "error" {
                        let code = message["code"].as_str().unwrap();
                        if code == "REPLACED" { return Ok("REPLACED"); }
                        if budget.is_none() { bail!("Relay {code}"); }
                        if matches!(code, "LIMIT_EXCEEDED" | "UNAVAILABLE") { let _ = self.events.try_send(RelayEvent::PushDropped); }
                        continue;
                    }
                    if budget.is_none() {
                        if message["type"] != "ready" || message.get("channel").is_some() { return Ok("UNSUPPORTED"); }
                        let configured = match Budget::from_ready(&message) { Ok(budget) => budget, Err(_) => return Ok("UNSUPPORTED") };
                        let push = message["push"] == true;
                        {
                            let mut state = self.handle.local.borrow_mut();
                            state.ready = true;
                            state.push = push;
                            state.max_frame_bytes = (message["limits"]["maxFrameBytes"].as_u64().unwrap() as usize).min((message["limits"]["bytesPerSecond"].as_u64().unwrap() / 4) as usize);
                        }
                        self.events.try_send(RelayEvent::Ready { generation, push }).context("Relay event 缓冲已满")?;
                        budget = Some(configured);
                        continue;
                    }
                    self.receive(generation, &message, budget.as_ref().unwrap().chunk_bytes)?;
                },
                _ = tokio::time::sleep_until(next) => {
                    let Some(budget) = budget.as_mut() else { bail!("Relay ready 超时") };
                    self.reap()?;
                    if Instant::now() < budget.next_send { continue; }
                    let Some(frame) = self.frame(budget.chunk_bytes, &previous, last_control)? else { continue; };
                    if !self.send_frame(generation, &mut socket, &frame).await? { return Ok("CANCELLED"); }
                    budget.sent(frame.text.len());
                    last_control = frame.control;
                    if !frame.control {
                        previous = frame.key;
                        if let Some(endpoint) = self.handle.local.borrow().channels.get(&previous) {
                            let mut endpoint = endpoint.lock().unwrap();
                            if let Some(job) = endpoint.output.front_mut() {
                                job.offset += frame.bytes;
                                if job.offset == job.bytes.len() {
                                    let size = endpoint.output.pop_front().unwrap().size;
                                    endpoint.output_bytes -= size;
                                    self.handle.counters.send.fetch_sub(size, Ordering::SeqCst);
                                }
                            }
                        }
                    }
                },
            }
        }
    }
    fn reap(&self) -> Result<()> {
        let mut state = self.handle.local.borrow_mut();
        let finished: Vec<_> = state
            .channels
            .iter()
            .filter_map(|(id, endpoint)| {
                let endpoint = endpoint.lock().unwrap();
                match endpoint.phase {
                    Phase::Closed => Some(id.clone()),
                    Phase::Closing(at) if endpoint.output.is_empty() || Instant::now() >= at => {
                        Some(id.clone())
                    }
                    _ => None,
                }
            })
            .collect();
        for id in finished {
            state
                .channels
                .remove(&id)
                .unwrap()
                .lock()
                .unwrap()
                .close(&self.handle.counters, false);
            state.close_control(&id, &self.handle.counters)?;
        }
        Ok(())
    }
    fn receive(&self, generation: u64, message: &Value, chunk_bytes: usize) -> Result<()> {
        let mut state = self.handle.local.borrow_mut();
        let id = message["channel"].as_str().unwrap_or_default();
        match message["type"].as_str() {
            Some("open") => {
                ensure!(!state.channels.contains_key(id), "Relay 通道重复");
                if state.channels.len() >= CHANNELS {
                    return state.close_control(id, &self.handle.counters);
                }
                let endpoint = Arc::new(Mutex::new(Endpoint {
                    phase: Phase::Open,
                    input: VecDeque::new(),
                    input_offset: 0,
                    input_bytes: 0,
                    output: VecDeque::new(),
                    output_bytes: 0,
                    reader: AtomicWaker::new(),
                    closer: AtomicWaker::new(),
                }));
                state.channels.insert(id.to_owned(), endpoint.clone());
                let stream = RelayStream {
                    endpoint,
                    counters: self.handle.counters.clone(),
                    chunk_bytes,
                };
                if self
                    .events
                    .try_send(RelayEvent::Channel {
                        generation,
                        id: id.to_owned(),
                        stream,
                    })
                    .is_err()
                {
                    state
                        .channels
                        .remove(id)
                        .unwrap()
                        .lock()
                        .unwrap()
                        .close(&self.handle.counters, true);
                    state.close_control(id, &self.handle.counters)?;
                }
            }
            Some("data") => {
                if let Some(endpoint) = state.channels.get(id) {
                    let mut endpoint = endpoint.lock().unwrap();
                    if matches!(endpoint.phase, Phase::Open) {
                        match relay_codec::decode_data(message["data"].as_str().unwrap()) {
                            Ok(bytes)
                                if bytes.len() + endpoint.input_bytes <= RECEIVE_BYTES
                                    && bytes.len()
                                        + self.handle.counters.receive.load(Ordering::SeqCst)
                                        <= HOST_BYTES =>
                            {
                                endpoint.input_bytes += bytes.len();
                                self.handle
                                    .counters
                                    .receive
                                    .fetch_add(bytes.len(), Ordering::SeqCst);
                                endpoint.input.push_back(bytes);
                                endpoint.reader.wake();
                            }
                            _ => endpoint.close(&self.handle.counters, true),
                        }
                    }
                }
            }
            Some("close") => {
                state.remove_control(id, &self.handle.counters);
                if let Some(endpoint) = state.channels.remove(id) {
                    endpoint.lock().unwrap().close(&self.handle.counters, false);
                }
            }
            Some("pushResult") => {
                self.events
                    .try_send(RelayEvent::PushUnregistered(
                        message["token"].as_str().unwrap().to_owned(),
                    ))
                    .context("Relay event 缓冲已满")?;
            }
            _ => bail!("Relay 帧无效"),
        }
        Ok(())
    }
    fn frame(
        &self,
        chunk_bytes: usize,
        previous: &str,
        last_control: bool,
    ) -> Result<Option<Frame>> {
        let mut state = self.handle.local.borrow_mut();
        while state.controls.front().is_some_and(|control| {
            control
                .authorized
                .as_ref()
                .is_some_and(|authorized| !authorized())
        }) {
            let key = state.controls.front().unwrap().key.clone();
            state.remove_control(&key, &self.handle.counters);
        }
        let data: Vec<_> = state
            .channels
            .iter()
            .filter(|(_, endpoint)| !endpoint.lock().unwrap().output.is_empty())
            .map(|(id, endpoint)| (id.clone(), endpoint.clone()))
            .collect();
        if !state.controls.is_empty() && (data.is_empty() || !last_control) {
            let control = state.controls.front().unwrap();
            return Ok(Some(Frame {
                key: control.key.clone(),
                text: control.text.clone(),
                bytes: 0,
                control: true,
            }));
        }
        if data.is_empty() {
            return Ok(None);
        }
        let index = data
            .iter()
            .position(|(id, _)| id == previous)
            .map(|index| (index + 1) % data.len())
            .unwrap_or(0);
        let (id, endpoint) = &data[index];
        let endpoint = endpoint.lock().unwrap();
        let job = endpoint.output.front().unwrap();
        let bytes = &job.bytes[job.offset..(job.offset + chunk_bytes).min(job.bytes.len())];
        Ok(Some(Frame {
            key: id.clone(),
            text: relay_codec::encode_data(id, bytes)?,
            bytes: bytes.len(),
            control: false,
        }))
    }
}
struct Frame {
    key: String,
    text: String,
    bytes: usize,
    control: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::io::{AsyncReadExt, AsyncWriteExt};
    const ID: &str = "11111111-1111-4111-8111-111111111111";
    fn owner() -> (RelayOwner, RelayHandle, mpsc::Receiver<RelayEvent>) {
        RelayOwner::new(RelayConfig {
            url: "wss://localhost/remote/socket".into(),
            room: "r".into(),
            capability: "c".into(),
            local_host: None,
        })
    }
    async fn channel(owner: &RelayOwner, events: &mut mpsc::Receiver<RelayEvent>) -> RelayStream {
        owner
            .receive(1, &json!({"type":"open","channel":ID}), 1024)
            .unwrap();
        match events.recv().await.unwrap() {
            RelayEvent::Channel { stream, .. } => stream,
            _ => panic!("channel event"),
        }
    }
    fn ready() -> Value {
        json!({"type":"ready","limits":{"framesPerSecond":12,"bytesPerSecond":65536,"maxFrameBytes":16384,"heartbeatIntervalMs":500}})
    }
    #[test]
    fn ready_budget_reserves_pong_control_and_registration_window() {
        let before = Instant::now();
        let budget = Budget::from_ready(&ready()).unwrap();
        assert_eq!(budget.chunk_bytes, 12192);
        assert_eq!(budget.frame_interval, Duration::from_millis(125));
        assert_eq!(budget.bytes_per_second, 49152.0);
        assert!(budget.next_send >= before + Duration::from_millis(1050));
        let mut impossible = ready();
        impossible["limits"]["framesPerSecond"] = json!(4);
        assert!(Budget::from_ready(&impossible).is_err());
        impossible = ready();
        impossible["limits"]["bytesPerSecond"] = json!(512);
        assert!(Budget::from_ready(&impossible).is_err());
    }
    #[tokio::test]
    async fn bounded_endpoint_overflow_closes_only_that_channel_and_releases_bytes() {
        let (owner, handle, mut events) = owner();
        let mut stream = channel(&owner, &mut events).await;
        stream.write_all(&vec![7; 128 * 1024]).await.unwrap();
        assert!(handle.counters.send.load(Ordering::SeqCst) > 128 * 1024);
        assert!(stream.write_all(&vec![7; SEND_BYTES]).await.is_err());
        assert_eq!(handle.counters.send.load(Ordering::SeqCst), 0);
        owner.reap().unwrap();
        let frame = owner.frame(1024, "", false).unwrap().unwrap();
        assert!(frame.control);
        assert_eq!(frame.key, ID);
        assert_eq!(owner.handle.local.borrow().channels.len(), 0);
        let healthy = channel(&owner, &mut events).await;
        assert!(matches!(
            healthy.endpoint.lock().unwrap().phase,
            Phase::Open
        ));
    }
    #[tokio::test]
    async fn foreign_or_invalid_data_cannot_disconnect_a_healthy_channel() {
        let (owner, handle, mut events) = owner();
        let mut stream = channel(&owner, &mut events).await;
        owner
            .receive(
                1,
                &json!({"type":"data","channel":"foreign","data":"Zh=="}),
                1024,
            )
            .unwrap();
        owner
            .receive(1, &json!({"type":"data","channel":ID,"data":"Zg=="}), 1024)
            .unwrap();
        let mut bytes = [0];
        stream.read_exact(&mut bytes).await.unwrap();
        assert_eq!(&bytes, b"f");
        owner
            .receive(1, &json!({"type":"data","channel":ID,"data":"Zh=="}), 1024)
            .unwrap();
        assert_eq!(stream.read(&mut bytes).await.unwrap(), 0);
        assert_eq!(handle.counters.receive.load(Ordering::SeqCst), 0);
        owner.reap().unwrap();
        assert_eq!(owner.frame(1024, "", false).unwrap().unwrap().key, ID);
    }
    #[tokio::test]
    async fn accepted_close_waits_for_queue_and_abort_invalidates_old_stream() {
        let (owner, handle, mut events) = owner();
        handle.local.borrow_mut().generation = 1;
        let mut stream = channel(&owner, &mut events).await;
        stream.write_all(b"accepted").await.unwrap();
        {
            let close = stream.close();
            tokio::pin!(close);
            assert!(futures_util::poll!(close).is_pending());
        }
        assert!(stream.write_all(b"late").await.is_err());
        let frame = owner.frame(1024, "", false).unwrap().unwrap();
        assert!(!frame.control);
        handle.reconnect();
        assert!(stream.write_all(b"old-generation").await.is_err());
        assert_eq!(handle.counters.send.load(Ordering::SeqCst), 0);
        handle.abort(1, ID);
        assert!(owner.frame(1024, "", false).unwrap().is_none());
    }
    #[test]
    fn guarded_push_is_deduplicated_rechecked_and_yields_control_capacity() {
        let (owner, handle, _events) = owner();
        {
            let mut state = handle.local.borrow_mut();
            state.ready = true;
            state.push = true;
            state.max_frame_bytes = 16384;
        }
        let authorized = Rc::new(std::cell::Cell::new(true));
        let push = json!({"type":"push","token":"a".repeat(64),"collapseId":"test","target":{"projectId":"project"}});
        let guard = {
            let authorized = authorized.clone();
            Rc::new(move || authorized.get()) as Rc<dyn Fn() -> bool>
        };
        assert!(handle.try_push(push.clone(), guard.clone()));
        assert!(handle.try_push(push, guard));
        assert_eq!(handle.local.borrow().controls.len(), 1);
        authorized.set(false);
        assert!(owner.frame(1024, "", false).unwrap().is_none());
        assert_eq!(handle.counters.send.load(Ordering::SeqCst), 0);
        {
            let mut state = handle.local.borrow_mut();
            for index in 0..32 {
                state
                    .close_control(&format!("closed-{index}"), &handle.counters)
                    .unwrap();
            }
            assert!(state.close_control("overflow", &handle.counters).is_err());
        }
        handle.stop();
        assert_eq!(handle.counters.send.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn connection_and_event_metadata_stays_bounded() {
        let (owner, handle, mut events) = owner();
        let mut streams = Vec::new();
        for index in 0..16 {
            let id = format!("{index:08x}-1111-4111-8111-111111111111");
            owner
                .receive(1, &json!({"type":"open","channel":id}), 1024)
                .unwrap();
            if let RelayEvent::Channel { stream, .. } = events.recv().await.unwrap() {
                streams.push(stream);
            }
        }
        owner
            .receive(1, &json!({"type":"open","channel":ID}), 1024)
            .unwrap();
        assert_eq!(handle.local.borrow().channels.len(), 16);
        assert_eq!(handle.local.borrow().controls.len(), 1);
        handle.stop();
        assert_eq!(handle.counters.send.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn local_protocol_owner_preserves_authority_push_guard_and_flush_close() {
        tokio::task::LocalSet::new().run_until(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let peer = tokio::task::spawn_local(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_hdr_async(stream, |request: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
                    assert_eq!(request.headers()["Host"], "192.168.1.2:7890");
                    assert_eq!(request.headers()["X-Areal-Relay-Capabilities"], "push");
                    assert!(!request.headers().contains_key("Origin"));
                    Ok(response)
                }).await.unwrap();
                let registration = socket.next().await.unwrap().unwrap();
                let registration: Value = serde_json::from_str(registration.to_text().unwrap()).unwrap();
                assert_eq!(registration, json!({"protocol":"areal.relay.v1","role":"host","room":"r","capability":"c"}));
                let mut configured = ready();
                configured["push"] = json!(true);
                socket.send(Message::Text(configured.to_string().into())).await.unwrap();
                socket.send(Message::Text(json!({"type":"open","channel":ID}).to_string().into())).await.unwrap();
                let mut data = Vec::new();
                let mut pushes = Vec::new();
                while let Some(message) = socket.next().await {
                    let message = message.unwrap();
                    let value: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
                    match value["type"].as_str().unwrap() {
                        "data" => data.extend(relay_codec::decode_data(value["data"].as_str().unwrap()).unwrap()),
                        "push" => {
                            pushes.push(value["collapseId"].as_str().unwrap().to_owned());
                            socket.send(Message::Text(json!({"type":"pushResult","token":"a".repeat(64),"status":"unregistered"}).to_string().into())).await.unwrap();
                        },
                        "close" => break,
                        _ => panic!("unexpected frame"),
                    }
                }
                assert_eq!(data, b"accepted before close");
                assert_eq!(pushes, ["authorized"]);
                socket.send(Message::Text(json!({"type":"error","code":"REPLACED"}).to_string().into())).await.unwrap();
            });
            let (owner, handle, mut events) = RelayOwner::new(RelayConfig { url: format!("ws://127.0.0.1:{port}/remote/socket"), room: "r".into(), capability: "c".into(), local_host: Some("192.168.1.2:7890".into()) });
            let owner = tokio::task::spawn_local(owner.run());
            let generation = match events.recv().await.unwrap() {
                RelayEvent::Ready { generation, push } => { assert!(push); generation },
                _ => panic!("ready"),
            };
            let mut stream = match events.recv().await.unwrap() {
                RelayEvent::Channel { generation: channel_generation, id, stream } => { assert_eq!(channel_generation, generation); assert_eq!(id, ID); stream },
                _ => panic!("channel"),
            };
            let authorized = Rc::new(std::cell::Cell::new(true));
            let guard = { let authorized = authorized.clone(); Rc::new(move || authorized.get()) as Rc<dyn Fn() -> bool> };
            let push = |collapse| json!({"type":"push","token":"a".repeat(64),"collapseId":collapse,"target":{"projectId":"project"}});
            assert!(handle.try_push(push("revoked"), guard));
            authorized.set(false);
            assert!(handle.try_push(push("authorized"), Rc::new(|| true)));
            stream.write_all(b"accepted before close").await.unwrap();
            stream.close().await.unwrap();
            let mut unregistered = false;
            loop {
                match events.recv().await.unwrap() {
                    RelayEvent::PushUnregistered(token) => { assert_eq!(token, "a".repeat(64)); unregistered = true; },
                    RelayEvent::Disconnected { generation: ended, reason, retry } => { assert_eq!(ended, generation); assert_eq!(reason, "REPLACED"); assert!(!retry); break; },
                    _ => panic!("unexpected event"),
                }
            }
            assert!(unregistered);
            owner.await.unwrap();
            peer.await.unwrap();
            assert_eq!(handle.counters.send.load(Ordering::SeqCst), 0);
        }).await;
    }
    #[tokio::test]
    async fn binary_ready_is_terminal_and_receiver_drop_cancels_connect() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let port = listener.local_addr().unwrap().port();
                let peer = tokio::task::spawn_local(async move {
                    let (stream, _) = listener.accept().await.unwrap();
                    let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                    socket.next().await.unwrap().unwrap();
                    socket
                        .send(Message::Binary(b"invalid".to_vec().into()))
                        .await
                        .unwrap();
                    assert!(socket.next().await.is_none_or(|result| result.is_err()));
                });
                let (owner, handle, mut events) = RelayOwner::new(RelayConfig {
                    url: format!("ws://127.0.0.1:{port}/remote/socket"),
                    room: "r".into(),
                    capability: "c".into(),
                    local_host: Some(format!("localhost:{port}")),
                });
                let owner = tokio::task::spawn_local(owner.run());
                match events.recv().await.unwrap() {
                    RelayEvent::Disconnected { reason, retry, .. } => {
                        assert_eq!(reason, "UNSUPPORTED");
                        assert!(!retry);
                    }
                    _ => panic!("unsupported budget"),
                }
                owner.await.unwrap();
                peer.await.unwrap();
                assert!(!handle.local.borrow().ready);
                let (owner, _handle, events) = super::tests::owner();
                drop(events);
                tokio::time::timeout(Duration::from_secs(1), owner.run())
                    .await
                    .unwrap();
            })
            .await;
    }
    #[tokio::test]
    async fn pending_socket_send_is_cancelled_before_old_generation_can_flush() {
        for reconnect in [false, true] {
            let (owner, handle, _events) = owner();
            handle.local.borrow_mut().generation = 1;
            let (local, mut peer) = tokio::io::duplex(64);
            let mut socket = tokio_tungstenite::WebSocketStream::from_raw_socket(
                local,
                tokio_tungstenite::tungstenite::protocol::Role::Client,
                None,
            )
            .await;
            {
                let sending = owner.send(1, &mut socket, "x".repeat(16 * 1024));
                tokio::pin!(sending);
                assert!(futures_util::poll!(sending.as_mut()).is_pending());
                if reconnect {
                    handle.reconnect();
                } else {
                    handle.stop();
                }
                assert!(
                    !tokio::time::timeout(Duration::from_secs(1), sending)
                        .await
                        .unwrap()
                        .unwrap()
                );
            }
            drop(socket);
            let mut accepted = Vec::new();
            tokio::io::AsyncReadExt::read_to_end(&mut peer, &mut accepted)
                .await
                .unwrap();
            assert!(accepted.len() <= 64);
        }
    }
    #[tokio::test]
    async fn blocked_push_completion_preserves_and_sends_newer_same_key_payload() {
        let (owner, handle, _events) = owner();
        {
            let mut state = handle.local.borrow_mut();
            state.generation = 1;
            state.ready = true;
            state.push = true;
            state.max_frame_bytes = 16384;
        }
        let push = |count| json!({"type":"push","token":"a".repeat(64),"collapseId":"same-key","count":count,"target":{"projectId":"project"}});
        assert!(handle.try_push(push(1), Rc::new(|| true)));
        let first = owner.frame(1024, "", false).unwrap().unwrap();
        let (local, remote) = tokio::io::duplex(64);
        let mut socket = tokio_tungstenite::WebSocketStream::from_raw_socket(
            local,
            tokio_tungstenite::tungstenite::protocol::Role::Client,
            None,
        )
        .await;
        let mut peer = tokio_tungstenite::WebSocketStream::from_raw_socket(
            remote,
            tokio_tungstenite::tungstenite::protocol::Role::Server,
            None,
        )
        .await;
        {
            let sending = owner.send_frame(1, &mut socket, &first);
            tokio::pin!(sending);
            assert!(futures_util::poll!(sending.as_mut()).is_pending());
            assert!(handle.try_push(push(2), Rc::new(|| true)));
            let (sent, received) = tokio::join!(sending, peer.next());
            assert!(sent.unwrap());
            let received: Value =
                serde_json::from_str(received.unwrap().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(received["count"], 1);
        }
        let replacement = owner
            .frame(1024, "", true)
            .unwrap()
            .expect("newer same-key push must survive the old blocked send completion");
        assert_eq!(
            handle.counters.send.load(Ordering::SeqCst),
            replacement.text.len()
        );
        let (sent, received) =
            tokio::join!(owner.send_frame(1, &mut socket, &replacement), peer.next());
        assert!(sent.unwrap());
        let received: Value =
            serde_json::from_str(received.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(received["count"], 2);
        assert!(owner.frame(1024, "", true).unwrap().is_none());
        assert_eq!(handle.counters.send.load(Ordering::SeqCst), 0);
    }
}
