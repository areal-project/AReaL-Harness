//! 显式启用的 Responses WebSocket：只复用已完整结束的同 Turn 连接。
use super::*;
use futures_util::SinkExt;
use std::{collections::HashMap, sync::Arc, time::Instant};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{Message as WsMessage, client::IntoClientRequest},
};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
type Owner = (String, String);
const MAX_SESSIONS: usize = 16;
const MAX_POOL_BYTES: usize = 32 * 1024 * 1024;
const IDLE: Duration = Duration::from_secs(120);

pub(super) struct Cached {
    socket: Socket,
    request: Value,
    output: Vec<Value>,
    response_id: String,
    touched: Instant,
    bytes: usize,
}
#[derive(Default)]
pub(super) struct Pool {
    entries: HashMap<Owner, Cached>,
}
impl Pool {
    fn insert(&mut self, key: Owner, cached: Cached) {
        self.entries.retain(|_, v| v.touched.elapsed() < IDLE);
        if cached.bytes > MAX_POOL_BYTES {
            return;
        }
        self.entries.insert(key, cached);
        while self.entries.len() > MAX_SESSIONS
            || self.entries.values().map(|v| v.bytes).sum::<usize>() > MAX_POOL_BYTES
        {
            let key = self
                .entries
                .iter()
                .min_by_key(|(_, v)| v.touched)
                .map(|(k, _)| k.clone());
            if let Some(key) = key {
                self.entries.remove(&key);
            } else {
                break;
            }
        }
    }
}

fn comparable(item: &Value) -> Value {
    let mut item = item.clone();
    if item["role"] == "assistant" && item.get("content").is_some() {
        if let Some(object) = item.as_object_mut() {
            object.remove("id");
            object.remove("status");
            if object.get("type").is_some_and(|v| v == "message") {
                object.remove("type");
            }
        }
        if let Some(parts) = item["content"].as_array_mut() {
            for part in parts {
                if part["annotations"].as_array().is_some_and(Vec::is_empty) {
                    part.as_object_mut().unwrap().remove("annotations");
                }
            }
        }
    }
    item
}

fn continuation(previous: &Value, output: &[Value], current: &Value) -> Option<Vec<Value>> {
    let mut old = previous.clone();
    let mut new = current.clone();
    old.as_object_mut()?.remove("input");
    new.as_object_mut()?.remove("input");
    if old != new {
        return None;
    }
    let old_input = previous["input"].as_array()?;
    let current_input = current["input"].as_array()?;
    let length = old_input.len().checked_add(output.len())?;
    if length > current_input.len() {
        return None;
    }
    if !old_input
        .iter()
        .chain(output)
        .zip(current_input)
        .all(|(a, b)| comparable(a) == comparable(b))
    {
        return None;
    }
    Some(current_input[length..].to_vec())
}

struct Inflight {
    socket: Option<Socket>,
    request: Value,
    output: Vec<Value>,
    response_id: Option<String>,
    decoder: Decoder,
    queue: VecDeque<ModelEvent>,
    complete: bool,
    failed: bool,
    owner: Option<Owner>,
    pool: Arc<tokio::sync::Mutex<Pool>>,
    audit: audit::Audit,
}

impl HttpModel {
    pub(super) async fn websocket_stream(
        &self,
        body: Value,
        purpose: RequestPurpose,
        limits: ToolCallLimits,
    ) -> Result<ModelStream> {
        let owner = REQUEST_OWNER.try_with(Clone::clone).ok();
        // 摘要不共享求解连接；池只属于此模型实例，凭据变更会重建模型。
        let reuse_owner = owner.filter(|_| purpose == RequestPurpose::Solve);
        let cached = if let Some(key) = &reuse_owner {
            let mut pool = self.websocket_pool.lock().await;
            pool.entries.retain(|_, v| v.touched.elapsed() < IDLE);
            pool.entries.remove(key)
        } else {
            None
        };
        // 不同网关对无 previous_response_id 的同连接请求有隐式追加行为。
        // 不能续接时必须关闭旧连接，用新连接发送完整输入，避免历史重复。
        let cached = cached.and_then(|cached| {
            continuation(&cached.request, &cached.output, &body).map(|delta| (cached, delta))
        });
        let mut wire = body.clone();
        wire.as_object_mut().unwrap().remove("stream");
        wire["type"] = json!("response.create");
        let cached_socket = cached.map(|(cached, delta)| {
            wire["input"] = json!(delta);
            wire["previous_response_id"] = json!(cached.response_id);
            cached.socket
        });
        // 先检查实际发送封套；超限时连握手请求也不发出。
        let encoded = self.encode_request(&wire, purpose)?;
        let mut audit = audit::Audit::new(self.audit_directory.as_deref(), &body, purpose);
        audit.value["transport"] = json!("responses-websocket");
        audit.value["incremental"] = json!(wire.get("previous_response_id").is_some());
        audit.value["wireInputItems"] = json!(wire["input"].as_array().map_or(0, Vec::len));
        audit.value["wireBodyBytes"] = json!(encoded.len());
        let socket = if let Some(socket) = cached_socket {
            socket
        } else {
            let mut url = reqwest::Url::parse(&self.endpoint)?;
            let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
            url.set_scheme(scheme)
                .map_err(|_| anyhow::anyhow!("invalid WebSocket scheme"))?;
            let mut request = url.as_str().into_client_request()?;
            request.headers_mut().insert(
                "OpenAI-Beta",
                "responses_websockets=2026-02-06".parse().unwrap(),
            );
            // 与 Codex 的 Responses 会话标识一致；只发送 Core 生成的身份，不推断后端路由。
            if let Some((thread, _)) = &reuse_owner {
                let value = thread
                    .parse()
                    .map_err(|_| anyhow::anyhow!("invalid thread identity header"))?;
                request.headers_mut().insert("session-id", value);
                request.headers_mut().insert(
                    "thread-id",
                    thread
                        .parse()
                        .map_err(|_| anyhow::anyhow!("invalid thread identity header"))?,
                );
            }
            if let Some(key) = &self.key {
                request.headers_mut().insert(
                    "Authorization",
                    format!("Bearer {key}")
                        .parse()
                        .map_err(|_| anyhow::anyhow!("invalid model credential"))?,
                );
            }
            // 明确选择本连接的 crypto provider；workspace 同时链接 ring/aws-lc，不能依赖全局推断。
            let connector = if scheme == "wss" {
                let certificates = rustls_native_certs::load_native_certs();
                let mut roots = rustls::RootCertStore::empty();
                roots.add_parsable_certificates(certificates.certs);
                anyhow::ensure!(!roots.is_empty(), "no system TLS trust roots available");
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
            let result = tokio::time::timeout(
                Duration::from_secs(10),
                tokio_tungstenite::connect_async_tls_with_config(
                    request,
                    Some({
                        let mut config =
                            tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
                        config.max_message_size = Some(MAX_SSE_BYTES);
                        config.max_frame_size = Some(MAX_SSE_BYTES);
                        config
                    }),
                    false,
                    connector,
                ),
            )
            .await;
            match result {
                Ok(Ok((socket, response))) => {
                    audit.value["httpStatus"] = json!(response.status().as_u16());
                    socket
                }
                Ok(Err(tokio_tungstenite::tungstenite::Error::Http(response))) => {
                    let status = reqwest::StatusCode::from_u16(response.status().as_u16()).unwrap();
                    audit.value["httpStatus"] = json!(status.as_u16());
                    audit.value["outcome"] = json!("failed");
                    audit.value["error"] = json!("websocket handshake rejected");
                    let error: anyhow::Error = match status {
                        reqwest::StatusCode::REQUEST_TIMEOUT => {
                            ModelFailure::ResponseTimeout.into()
                        }
                        reqwest::StatusCode::TOO_MANY_REQUESTS => ModelFailure::RateLimited.into(),
                        s if s.is_server_error() => ModelFailure::Unavailable.into(),
                        _ => HttpFailure {
                            status,
                            detail: None,
                        }
                        .into(),
                    };
                    audit.value["terminalOutcome"] = json!(terminal_outcome(&error));
                    return Err(error);
                }
                _ => {
                    audit.value["outcome"] = json!("failed");
                    audit.value["error"] = json!("websocket handshake failed");
                    return Err(ModelFailure::Transport.into());
                }
            }
        };
        audit.value["httpAttempts"] = json!(1);
        let mut socket = socket;
        // 发送失败也可能已被接收；不在此处降级 HTTP 或重放。
        if socket
            .send(WsMessage::Text(String::from_utf8(encoded)?.into()))
            .await
            .is_err()
        {
            audit.value["outcome"] = json!("failed");
            audit.value["error"] = json!("websocket send failed");
            return Err(ModelFailure::Transport.into());
        }
        let state = Inflight {
            socket: Some(socket),
            request: body,
            output: Vec::new(),
            response_id: None,
            decoder: Decoder::Responses(ResponsesDecoder::new(limits)),
            queue: VecDeque::new(),
            complete: false,
            failed: false,
            owner: reuse_owner,
            pool: self.websocket_pool.clone(),
            audit,
        };
        Ok(Box::pin(futures_util::stream::unfold(
            state,
            |mut state| async move {
                loop {
                    if let Some(event) = state.queue.pop_front() {
                        if let ModelEvent::Usage(usage) = &event {
                            let mut total: ModelUsage =
                                serde_json::from_value(state.audit.value["usage"].clone())
                                    .unwrap_or_default();
                            total.add_assign(usage);
                            state.audit.value["usage"] = json!(total);
                            state.audit.value["usageObserved"] = json!(true);
                        }
                        if matches!(&event,ModelEvent::TextDelta(t) if !t.is_empty()) {
                            state.audit.mark_first("timeToFirstTextDeltaMs");
                        }
                        if matches!(&event,ModelEvent::ReasoningDelta{delta,..} if !delta.is_empty())
                        {
                            state.audit.mark_first("timeToFirstReasoningDeltaMs");
                        }
                        return Some((Ok(event), state));
                    }
                    if state.failed {
                        return None;
                    }
                    if let Some(error) = state.decoder.take_pending_error() {
                        state.failed = true;
                        state.socket.take();
                        state.audit.value["outcome"] = json!("failed");
                        state.audit.value["terminalOutcome"] = json!(terminal_outcome(&error));
                        return Some((Err(error), state));
                    }
                    if state.complete {
                        state.audit.value["outcome"] = json!("completed");
                        if let (Some(owner), Some(response_id), Some(socket)) = (
                            state.owner.take(),
                            state.response_id.take(),
                            state.socket.take(),
                        ) {
                            let bytes = state.request.to_string().len()
                                + serde_json::to_vec(&state.output).map_or(0, |v| v.len());
                            // 无后续请求时也释放空闲连接；定时器只持有弱引用。
                            let weak_pool = Arc::downgrade(&state.pool);
                            let expire_owner = owner.clone();
                            tokio::spawn(async move {
                                tokio::time::sleep(IDLE).await;
                                if let Some(pool) = weak_pool.upgrade() {
                                    let mut pool = pool.lock().await;
                                    if pool
                                        .entries
                                        .get(&expire_owner)
                                        .is_some_and(|entry| entry.touched.elapsed() >= IDLE)
                                    {
                                        pool.entries.remove(&expire_owner);
                                    }
                                }
                            });
                            state.pool.lock().await.insert(
                                owner,
                                Cached {
                                    socket,
                                    request: state.request.clone(),
                                    output: state.output.clone(),
                                    response_id,
                                    touched: Instant::now(),
                                    bytes,
                                },
                            );
                        }
                        return None;
                    }
                    let result: Result<Vec<ModelEvent>> = async {
                        let message = state
                            .socket
                            .as_mut()
                            .unwrap()
                            .next()
                            .await
                            .ok_or(ModelFailure::Incomplete)?
                            .map_err(|_| ModelFailure::Transport)?;
                        let text = match message {
                            WsMessage::Text(text) => text.to_string(),
                            WsMessage::Ping(_) | WsMessage::Pong(_) => {
                                return Ok(vec![ModelEvent::Activity]);
                            }
                            WsMessage::Close(_) => return Err(ModelFailure::Incomplete.into()),
                            _ => bail!("unexpected Responses WebSocket frame"),
                        };
                        state.audit.mark_first("timeToFirstResponseBytesMs");
                        anyhow::ensure!(
                            text.len() <= MAX_SSE_BYTES,
                            "WebSocket frame exceeds budget"
                        );
                        let event: Value = serde_json::from_str(&text)
                            .context("invalid Responses WebSocket JSON")?;
                        let is_complete = event["type"] == "response.completed";
                        if event["type"] == "response.output_item.done" {
                            anyhow::ensure!(
                                state
                                    .output
                                    .iter()
                                    .map(|v| v.to_string().len())
                                    .sum::<usize>()
                                    + event["item"].to_string().len()
                                    <= MAX_SSE_BYTES,
                                "WebSocket response output exceeds budget"
                            );
                            state.output.push(event["item"].clone());
                        }
                        let mut events =
                            state.decoder.feed(format!("data: {text}\n\n").as_bytes())?;
                        state.audit.value["usageDetails"] = state.decoder.usage_details();
                        if is_complete {
                            events.extend(state.decoder.finish()?);
                            state.response_id = event["response"]["id"]
                                .as_str()
                                .filter(|id| {
                                    !id.is_empty()
                                        && id.len() <= 256
                                        && id.bytes().all(|b| {
                                            b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
                                        })
                                })
                                .map(str::to_owned);
                            if let Some(output) = event["response"]["output"]
                                .as_array()
                                .filter(|items| !items.is_empty())
                            {
                                state.output = output.clone();
                            } else {
                                // 没有完整输出基线时不能发送 delta，否则会重复回放已生成文本。
                                state.response_id = None;
                            }
                            state.complete = true;
                        }
                        if events.is_empty() {
                            events.push(ModelEvent::Activity);
                        }
                        Ok(events)
                    }
                    .await;
                    match result {
                        Ok(events) => state.queue.extend(events),
                        Err(error) => {
                            state.failed = true;
                            state.socket.take();
                            state.audit.value["outcome"] = json!("failed");
                            state.audit.value["error"] = json!("responses websocket failed");
                            state.audit.value["terminalOutcome"] = json!(terminal_outcome(&error));
                            return Some((Err(error), state));
                        }
                    }
                }
            },
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, extract::ws::WebSocketUpgrade, routing::get};
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn continuation_requires_output_prefix_and_all_request_properties() {
        let old = json!({"model":"fixture","input":[{"role":"user","content":"task"}],"tools":[{"name":"write"}],"reasoning":{"effort":"low"}});
        let output = vec![
            json!({"type":"message","id":"msg_1","status":"completed","role":"assistant","content":[{"type":"output_text","text":"done","annotations":[]}]}),
        ];
        let mut new = old.clone();
        new["input"].as_array_mut().unwrap().extend([
            json!({"role":"assistant","content":[{"type":"output_text","text":"done"}]}),
            json!({"role":"user","content":"next"}),
        ]);
        assert_eq!(continuation(&old, &output, &new).unwrap().len(), 1);
        for key in ["model", "tools", "reasoning", "new_parameter"] {
            let mut changed = new.clone();
            changed[key] = json!("different");
            assert!(continuation(&old, &output, &changed).is_none());
        }
        new["input"][1]["content"][0]["text"] = json!("rewritten");
        assert!(continuation(&old, &output, &new).is_none());
    }

    async fn fixture() -> (
        String,
        tokio::sync::mpsc::UnboundedReceiver<Value>,
        Arc<AtomicUsize>,
        tokio::task::JoinHandle<()>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let connections = Arc::new(AtomicUsize::new(0));
        let counter = connections.clone();
        let app=Router::new().route("/responses",get(move |headers: axum::http::HeaderMap, ws:WebSocketUpgrade| {
            let tx=tx.clone();let counter=counter.clone();
            async move { ws.on_upgrade(move |mut socket| async move {
                let connection=counter.fetch_add(1,Ordering::SeqCst);
                while let Some(Ok(axum::extract::ws::Message::Text(text)))=socket.recv().await {
                    let mut request:Value=serde_json::from_str(&text).unwrap();request["connection"]=json!(connection);request["sessionHeader"]=json!(headers.get("session-id").and_then(|h|h.to_str().ok()));tx.send(request.clone()).unwrap();
                    if request["model"]=="hang" { while socket.recv().await.is_some() {} return; }
                    if request["model"]=="disconnect" { return; }
                    if request["model"]=="incomplete" {
                        socket.send(axum::extract::ws::Message::Text(json!({"type":"response.incomplete","response":{"id":"resp_partial","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":9,"output_tokens":2}}}).to_string().into())).await.unwrap();continue;
                    }
                    let output=json!({"type":"message","id":"msg_fixture","status":"completed","role":"assistant","content":[{"type":"output_text","text":"ok","annotations":[]}]});
                    for event in [json!({"type":"response.output_text.delta","delta":"ok"}),json!({"type":"response.completed","response":{"id":"resp_fixture","status":"completed","output":if request["model"]=="missing-output" {json!(null)} else {json!([output])},"usage":{"input_tokens":10,"input_tokens_details":{"cached_tokens":8},"output_tokens":1}}})] {
                        socket.send(axum::extract::ws::Message::Text(event.to_string().into())).await.unwrap();
                    }
                }
            }) }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{address}/responses"), rx, connections, task)
    }
    async fn run(
        model: &HttpModel,
        owner: (&str, &str),
        messages: Vec<Message>,
    ) -> Vec<Result<ModelEvent>> {
        REQUEST_OWNER
            .scope((owner.0.into(), owner.1.into()), async {
                model
                    .chat(messages, vec![])
                    .await
                    .unwrap()
                    .collect::<Vec<_>>()
                    .await
            })
            .await
    }
    fn model(endpoint: String, name: &str) -> HttpModel {
        HttpModel::with_protocol(endpoint, name.into(), None, ModelProtocol::Responses)
            .unwrap()
            .with_options(ModelOptions {
                responses_websocket: true,
                ..Default::default()
            })
            .unwrap()
    }

    #[tokio::test]
    async fn same_turn_uses_delta_other_turns_and_parameter_changes_use_full_input() {
        let (endpoint, mut rx, connections, server) = fixture().await;
        let data = tempfile::tempdir().unwrap();
        let model = model(endpoint, "fixture").with_audit_directory(data.path().into());
        let mut history = vec![Message::text("user", "first")];
        assert!(
            run(&model, ("thread", "turn"), history.clone())
                .await
                .iter()
                .all(Result::is_ok)
        );
        let first = rx.recv().await.unwrap();
        assert!(first.get("previous_response_id").is_none());
        assert_eq!(first["sessionHeader"], "thread");
        history.extend([
            Message::text("assistant", "ok"),
            Message::text("user", "next"),
        ]);
        assert!(
            run(&model, ("thread", "turn"), history.clone())
                .await
                .iter()
                .all(Result::is_ok)
        );
        let second = rx.recv().await.unwrap();
        assert_eq!(second["previous_response_id"], "resp_fixture");
        assert_eq!(second["input"].as_array().unwrap().len(), 1);
        assert_eq!(first["connection"], second["connection"]);
        let changed = model.clone().with_temperature(Some(0.5)).unwrap();
        history.extend([
            Message::text("assistant", "ok"),
            Message::text("user", "third"),
        ]);
        assert!(
            run(&changed, ("thread", "turn"), history.clone())
                .await
                .iter()
                .all(Result::is_ok)
        );
        let third = rx.recv().await.unwrap();
        assert!(third.get("previous_response_id").is_none());
        assert_eq!(third["input"].as_array().unwrap().len(), 5);
        assert_ne!(third["connection"], second["connection"]);
        assert!(
            run(&model, ("thread", "other-turn"), history)
                .await
                .iter()
                .all(Result::is_ok)
        );
        let fourth = rx.recv().await.unwrap();
        assert!(fourth.get("previous_response_id").is_none());
        assert_ne!(fourth["connection"], first["connection"]);
        assert_eq!(connections.load(Ordering::SeqCst), 3);
        let rows: Vec<Value> = std::fs::read_to_string(data.path().join("requests.jsonl"))
            .unwrap()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect();
        assert_eq!(rows[1]["incremental"], true);
        assert!(rows.iter().all(|v| v["usageObserved"] == true));
        server.abort();
    }

    #[tokio::test]
    async fn byte_budget_checks_delta_and_rejects_full_fallback_before_connecting() {
        let (endpoint, mut rx, connections, server) = fixture().await;
        let model = model(endpoint, "fixture")
            .with_options(ModelOptions {
                responses_websocket: true,
                max_request_bytes: 1024,
                ..Default::default()
            })
            .unwrap();
        let mut history = vec![Message::text("user", "x".repeat(600))];
        assert!(
            run(&model, ("thread", "turn"), history.clone())
                .await
                .iter()
                .all(Result::is_ok)
        );
        rx.recv().await.unwrap();
        history.extend([
            Message::text("assistant", "ok"),
            Message::text("user", "y".repeat(600)),
        ]);
        assert!(
            run(&model, ("thread", "turn"), history.clone())
                .await
                .iter()
                .all(Result::is_ok)
        );
        let delta = rx.recv().await.unwrap();
        assert_eq!(delta["previous_response_id"], "resp_fixture");
        assert_eq!(delta["input"].as_array().unwrap().len(), 1);
        let result = REQUEST_OWNER
            .scope(
                ("thread".into(), "other-turn".into()),
                model.chat(history, vec![]),
            )
            .await;
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("oversized fallback was sent"),
        };
        let outcome = terminal_outcome(&error).unwrap();
        assert_eq!(outcome.code, "MODEL_REQUEST_TOO_LARGE");
        assert_eq!(
            outcome.details.as_ref().unwrap()["stage"],
            "serialized_request"
        );
        assert_eq!(outcome.details.unwrap()["requestSent"], false);
        assert_eq!(connections.load(Ordering::SeqCst), 1);
        assert!(rx.try_recv().is_err());
        server.abort();
    }

    #[tokio::test]
    async fn incomplete_disconnect_and_cancel_never_reuse_or_implicitly_replay() {
        let (endpoint, mut rx, connections, server) = fixture().await;
        for name in ["incomplete", "disconnect"] {
            let model = model(endpoint.clone(), name);
            let events = run(&model, (name, "turn"), vec![Message::text("user", "first")]).await;
            assert!(events.iter().any(Result::is_err));
            if name == "incomplete" {
                assert!(events.iter().any(|e| matches!(e, Ok(ModelEvent::Usage(_)))));
            }
            assert!(model.websocket_pool.lock().await.entries.is_empty());
            rx.recv().await.unwrap();
            assert!(rx.try_recv().is_err());
        }
        let missing = model(endpoint.clone(), "missing-output");
        assert!(
            run(
                &missing,
                ("missing", "turn"),
                vec![Message::text("user", "first")]
            )
            .await
            .iter()
            .all(Result::is_ok)
        );
        rx.recv().await.unwrap();
        assert!(missing.websocket_pool.lock().await.entries.is_empty());
        let hanging = model(endpoint.clone(), "hang");
        let stream = REQUEST_OWNER
            .scope(
                ("cancel".into(), "turn".into()),
                hanging.chat(vec![Message::text("user", "first")], vec![]),
            )
            .await
            .unwrap();
        rx.recv().await.unwrap();
        drop(stream);
        assert!(hanging.websocket_pool.lock().await.entries.is_empty());
        let fresh = model(endpoint, "fixture");
        assert!(
            run(
                &fresh,
                ("cancel", "turn"),
                vec![Message::text("user", "new")]
            )
            .await
            .iter()
            .all(Result::is_ok)
        );
        assert!(
            rx.recv()
                .await
                .unwrap()
                .get("previous_response_id")
                .is_none()
        );
        assert_eq!(connections.load(Ordering::SeqCst), 5);
        server.abort();
    }
}

#[cfg(test)]
mod rejection_tests {
    use super::*;
    use axum::{Router, routing::get};
    #[tokio::test]
    async fn authentication_rejection_is_not_retried_as_transport_failure() {
        let app = Router::new().route("/", get(|| async { axum::http::StatusCode::UNAUTHORIZED }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let model = HttpModel::with_protocol(
            format!("http://{addr}/"),
            "fixture".into(),
            Some("private-test-key".into()),
            ModelProtocol::Responses,
        )
        .unwrap()
        .with_options(ModelOptions {
            responses_websocket: true,
            ..Default::default()
        })
        .unwrap();
        let error = model
            .chat(vec![Message::text("user", "private prompt")], vec![])
            .await
            .err()
            .expect("must reject");
        assert!(!is_network_error(&error));
        assert_eq!(
            terminal_outcome(&error).unwrap().details.unwrap()["httpStatus"],
            401
        );
        assert!(!error.to_string().contains("private"));
        server.abort();
    }
}

#[cfg(test)]
mod expiry_tests {
    use super::*;
    use axum::{Router, extract::ws::WebSocketUpgrade, routing::get};
    #[tokio::test]
    async fn inherited_connections_are_evicted_after_idle_timeout() {
        let app = Router::new().route(
            "/",
            get(|ws: WebSocketUpgrade| async {
                ws.on_upgrade(|mut socket| async move { while socket.recv().await.is_some() {} })
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/"))
            .await
            .unwrap();
        let mut pool = Pool::default();
        pool.entries.insert(
            ("old".into(), "turn".into()),
            Cached {
                socket,
                request: json!({}),
                output: vec![],
                response_id: "resp_old".into(),
                touched: Instant::now() - IDLE - Duration::from_secs(1),
                bytes: 2,
            },
        );
        let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/"))
            .await
            .unwrap();
        pool.insert(
            ("new".into(), "turn".into()),
            Cached {
                socket,
                request: json!({}),
                output: vec![],
                response_id: "resp_new".into(),
                touched: Instant::now(),
                bytes: 2,
            },
        );
        assert_eq!(pool.entries.len(), 1);
        assert!(pool.entries.contains_key(&("new".into(), "turn".into())));
        drop(pool);
        server.abort();
    }
}
