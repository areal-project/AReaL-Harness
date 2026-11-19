//! 面向 EnvArena `app-server` 的异步 WebSocket JSON-RPC 客户端。
//! 独立于本机项目 10s 连接超时，默认支持最高 180s 冷启动握手，并严格区分 RPC 拒绝与传输未知错误。
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fmt,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};

/// EnvArena 文档声明冷启动最长可达 3 分钟。
pub(crate) const DEFAULT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(180);
pub(crate) const DEFAULT_RPC_TIMEOUT: Duration = Duration::from_secs(60);
const OUTGOING_CAPACITY: usize = 256;
const NOTIFICATION_CAPACITY: usize = 512;

#[derive(Clone, Debug)]
pub(crate) struct ArenaNotification {
    pub method: String,
    pub params: Value,
}

#[derive(Debug)]
pub(crate) enum ArenaError {
    /// 远端 Core 返回的确定性 JSON-RPC 业务错误（包含准入拒绝、参数错误等）。
    Rpc { code: i64, message: String },
    /// 握手失败、超时或连接中断；对于写操作必须按 UNKNOWN 处理，不得盲目重放。
    Transport(String),
}

impl ArenaError {
    pub(crate) fn is_transport(&self) -> bool {
        matches!(self, Self::Transport(_))
    }

    pub(crate) fn is_rpc(&self) -> bool {
        matches!(self, Self::Rpc { .. })
    }
}

impl fmt::Display for ArenaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Rpc { code, message, .. } => write!(f, "RPC error ({code}): {message}"),
            Self::Transport(message) => write!(f, "Arena transport error: {message}"),
        }
    }
}

impl std::error::Error for ArenaError {}

type PendingMap = Arc<Mutex<BTreeMap<u64, oneshot::Sender<Result<Value, ArenaError>>>>>;

#[derive(Clone)]
pub(crate) struct ArenaConnection {
    connection_id: String,
    outgoing: mpsc::Sender<String>,
    pending: PendingMap,
    next_id: Arc<AtomicU64>,
    closed: Arc<AtomicBool>,
    draining: Arc<AtomicBool>,
    notifications: broadcast::Sender<ArenaNotification>,
    capabilities: Arc<Value>,
}

impl ArenaConnection {
    pub(crate) async fn connect(
        ws_url: &str,
        bearer_token: &str,
        handshake_timeout: Duration,
    ) -> Result<Self, ArenaError> {
        // 完整二进制同时链接 ring 和 aws-lc，wss:// 必须显式传入连接级 Rustls provider，避免进程默认 provider 冲突。
        let connector = if ws_url.starts_with("wss://") {
            let certificates = rustls_native_certs::load_native_certs();
            let mut roots = rustls::RootCertStore::empty();
            roots.add_parsable_certificates(certificates.certs);
            if roots.is_empty() {
                return Err(ArenaError::Transport(
                    "no system TLS trust roots available".into(),
                ));
            }
            let config = rustls::ClientConfig::builder_with_provider(Arc::new(
                rustls::crypto::ring::default_provider(),
            ))
            .with_safe_default_protocol_versions()
            .map_err(|err| ArenaError::Transport(format!("TLS config failed: {err}")))?
            .with_root_certificates(roots)
            .with_no_client_auth();
            Some(tokio_tungstenite::Connector::Rustls(Arc::new(config)))
        } else {
            None
        };

        let deadline = tokio::time::Instant::now() + handshake_timeout;
        let mut backoff = Duration::from_secs(2);
        let socket = loop {
            let mut request = ws_url
                .into_client_request()
                .map_err(|err| ArenaError::Transport(format!("invalid WebSocket URL: {err}")))?;
            let header_value = format!("Bearer {bearer_token}")
                .parse()
                .map_err(|_| ArenaError::Transport("invalid Arena authorization header".into()))?;
            request.headers_mut().insert("authorization", header_value);

            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(ArenaError::Transport("Arena sandbox wake timed out".into()));
            }
            let attempt = tokio::time::timeout(
                remaining,
                tokio_tungstenite::connect_async_tls_with_config(
                    request,
                    None,
                    false,
                    connector.clone(),
                ),
            )
            .await
            .map_err(|_| ArenaError::Transport("Arena sandbox wake timed out".into()))?;

            match attempt {
                Ok((socket, _)) => break socket,
                Err(tokio_tungstenite::tungstenite::Error::Http(resp)) => {
                    let status = resp.status();
                    let body = resp
                        .body()
                        .as_deref()
                        .and_then(|bytes| std::str::from_utf8(bytes).ok())
                        .map(|s| s.trim().chars().take(256).collect::<String>())
                        .filter(|s| !s.is_empty());
                    // 网关在沙箱冷启动/回收交界期可能返回 409/502/503/504，在总唤醒预算内退避重试；
                    // 但明确要求 reconciliation 的 409 属于不可自动恢复的沙箱状态，应快速暴露给用户。
                    let non_retryable_409 = status.as_u16() == 409
                        && body.as_deref().is_some_and(|b| {
                            b.to_ascii_lowercase().contains("reconciliation required")
                        });
                    let retryable =
                        !non_retryable_409 && matches!(status.as_u16(), 409 | 502 | 503 | 504);
                    let now = tokio::time::Instant::now();
                    if retryable && now + backoff < deadline {
                        tokio::time::sleep(backoff).await;
                        backoff = (backoff * 2).min(Duration::from_secs(5));
                        continue;
                    }
                    let detail = match body {
                        Some(text) => format!("HTTP {status}: {text}"),
                        None => format!("HTTP {status}"),
                    };
                    return Err(ArenaError::Transport(format!(
                        "Arena connect failed: {detail}"
                    )));
                }
                Err(err) => {
                    return Err(ArenaError::Transport(format!(
                        "Arena connect failed: {err}"
                    )));
                }
            }
        };

        let (outgoing_tx, mut outgoing_rx) = mpsc::channel::<String>(OUTGOING_CAPACITY);
        let pending: PendingMap = Arc::new(Mutex::new(BTreeMap::new()));
        let closed = Arc::new(AtomicBool::new(false));
        let draining = Arc::new(AtomicBool::new(false));
        let (notifications_tx, _) = broadcast::channel::<ArenaNotification>(NOTIFICATION_CAPACITY);

        let driver_pending = pending.clone();
        let driver_closed = closed.clone();
        let driver_draining = draining.clone();
        let driver_notifications = notifications_tx.clone();
        let driver_outgoing = outgoing_tx.clone();

        tokio::spawn(async move {
            let (mut writer, mut reader) = socket.split();
            let close_reason: &str = loop {
                tokio::select! {
                    outgoing = outgoing_rx.recv() => {
                        let Some(frame) = outgoing else {
                            let _ = writer.send(Message::Close(None)).await;
                            break "closed_by_host";
                        };
                        if writer.send(Message::Text(frame.into())).await.is_err() {
                            break "socket_write_error";
                        }
                    }
                    incoming = reader.next() => {
                        let Some(frame) = incoming else {
                            break "socket_eof";
                        };
                        let Ok(message) = frame else {
                            break "socket_read_error";
                        };
                        match message {
                            Message::Text(text) => {
                                // app-server 协议允许单帧内以换行分隔多条 JSONL 消息。
                                for line in text.split('\n').map(str::trim).filter(|l| !l.is_empty()) {
                                    let Ok(value) = serde_json::from_str::<Value>(line) else {
                                        continue;
                                    };
                                    handle_incoming_frame(
                                        value,
                                        &driver_pending,
                                        &driver_draining,
                                        &driver_notifications,
                                        &driver_outgoing,
                                    );
                                }
                            }
                            Message::Ping(payload) => {
                                let _ = writer.send(Message::Pong(payload)).await;
                            }
                            Message::Close(_) => {
                                break "remote_closed";
                            }
                            _ => {}
                        }
                    }
                }
            };
            driver_closed.store(true, Ordering::SeqCst);
            let mut map = driver_pending.lock().unwrap();
            let waiters: Vec<_> = std::mem::take(&mut *map).into_values().collect();
            drop(map);
            for tx in waiters {
                let _ = tx.send(Err(ArenaError::Transport(format!(
                    "Arena connection closed ({close_reason})"
                ))));
            }
            let _ = driver_notifications.send(ArenaNotification {
                method: "host/connectionClosed".into(),
                params: json!({
                    "reason": close_reason,
                    "draining": driver_draining.load(Ordering::SeqCst),
                }),
            });
        });

        let mut conn = Self {
            connection_id: uuid::Uuid::new_v4().to_string(),
            outgoing: outgoing_tx,
            pending,
            next_id: Arc::new(AtomicU64::new(1)),
            closed,
            draining,
            notifications: notifications_tx,
            capabilities: Arc::new(Value::Null),
        };

        // 1. JSON-RPC initialize + initialized 握手
        let _init = conn
            .request_with_timeout(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": "areal-host-bots",
                        "version": env!("CARGO_PKG_VERSION"),
                    }
                }),
                DEFAULT_RPC_TIMEOUT,
            )
            .await?;
        conn.notify("initialized", json!({})).await?;

        // 2. 探测能力表
        let capabilities = conn
            .request_with_timeout(
                "areal/capabilities",
                json!({ "apiVersion": "areal.core.v1" }),
                DEFAULT_RPC_TIMEOUT,
            )
            .await?;
        if capabilities["apiVersion"] != "areal.core.v1" || !capabilities["methods"].is_array() {
            conn.close();
            return Err(ArenaError::Transport(
                "Remote app-server is incompatible with areal.core.v1".into(),
            ));
        }
        conn.capabilities = Arc::new(capabilities);
        Ok(conn)
    }

    pub(crate) fn connection_id(&self) -> &str {
        &self.connection_id
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    pub(crate) fn is_draining(&self) -> bool {
        self.draining.load(Ordering::SeqCst)
    }

    pub(crate) fn supports_method(&self, method: &str) -> bool {
        self.capabilities["methods"]
            .as_array()
            .is_some_and(|list| list.iter().any(|item| item.as_str() == Some(method)))
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<ArenaNotification> {
        self.notifications.subscribe()
    }

    pub(crate) fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let mut map = self.pending.lock().unwrap();
        let waiters: Vec<_> = std::mem::take(&mut *map).into_values().collect();
        drop(map);
        for tx in waiters {
            let _ = tx.send(Err(ArenaError::Transport("Arena connection closed".into())));
        }
    }

    pub(crate) async fn notify(&self, method: &str, params: Value) -> Result<(), ArenaError> {
        if self.is_closed() {
            return Err(ArenaError::Transport("Arena connection is closed".into()));
        }
        let frame = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        })
        .to_string();
        self.outgoing
            .send(frame)
            .await
            .map_err(|_| ArenaError::Transport("Arena connection send channel closed".into()))
    }

    pub(crate) async fn request(&self, method: &str, params: Value) -> Result<Value, ArenaError> {
        self.request_with_timeout(method, params, DEFAULT_RPC_TIMEOUT)
            .await
    }

    pub(crate) async fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, ArenaError> {
        if self.is_closed() {
            return Err(ArenaError::Transport("Arena connection is closed".into()));
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        {
            let mut map = self.pending.lock().unwrap();
            if self.is_closed() {
                return Err(ArenaError::Transport("Arena connection is closed".into()));
            }
            map.insert(id, tx);
        }
        let frame = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        })
        .to_string();
        if self.outgoing.send(frame).await.is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err(ArenaError::Transport(
                "Arena connection closed while sending request".into(),
            ));
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(ArenaError::Transport(
                "Arena connection dropped before response".into(),
            )),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(ArenaError::Transport(format!(
                    "Arena RPC timed out for {method}"
                )))
            }
        }
    }
}

fn handle_incoming_frame(
    value: Value,
    pending: &PendingMap,
    draining: &Arc<AtomicBool>,
    notifications: &broadcast::Sender<ArenaNotification>,
    outgoing: &mpsc::Sender<String>,
) {
    // 1. 响应帧（有 id 且无 method）
    if value.get("method").is_none()
        && let Some(id_val) = value.get("id")
        && let Some(id) = id_val.as_u64()
    {
        if let Some(tx) = pending.lock().unwrap().remove(&id) {
            let result = if let Some(err) = value.get("error") {
                Err(ArenaError::Rpc {
                    code: err["code"].as_i64().unwrap_or(-32000),
                    message: err["message"]
                        .as_str()
                        .unwrap_or("Unknown RPC error")
                        .to_owned(),
                })
            } else {
                Ok(value.get("result").cloned().unwrap_or(Value::Null))
            };
            let _ = tx.send(result);
        }
        return;
    }

    // 2. 服务端回调请求（同时有 id 和 method，例如未支持的桌面准备请求）
    if let Some(method) = value["method"].as_str() {
        if let Some(id) = value.get("id") {
            let response = json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {
                    "code": -32601,
                    "message": format!("Bot host does not handle server request {method}"),
                }
            })
            .to_string();
            let _ = outgoing.try_send(response);
            return;
        }
        if method == "areal/server/draining" {
            draining.store(true, Ordering::SeqCst);
        }
        let _ = notifications.send(ArenaNotification {
            method: method.to_owned(),
            params: value.get("params").cloned().unwrap_or(Value::Null),
        });
    }
}
