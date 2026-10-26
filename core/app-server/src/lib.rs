pub mod auth;
mod browser_auth;
mod codex_plugins;
pub mod configuration;
mod delegations;
mod desktop;
mod dynamic_tools;
mod plugin_runtime;
mod processes;
mod workgroups;
use areal_engine::{Engine, Error};
mod task_mode;
use areal_protocol::{Input, MAX_FRAME_BYTES, MAX_RESPONSE_BYTES, RpcError, response};
use axum::{
    Router,
    body::Body,
    extract::{
        DefaultBodyLimit, Extension, Path, Query, State, WebSocketUpgrade,
        ws::{CloseFrame, Message, WebSocket},
    },
    http::{HeaderMap, StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    sync::Arc,
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::{Mutex, broadcast, mpsc},
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use tracing::{Instrument, info_span};

pub fn router(engine: Arc<Engine>) -> Router {
    configured_router(engine, None, None, None, None)
}
fn configured_router(
    engine: Arc<Engine>,
    browser_origin: Option<String>,
    authentication: Option<auth::Authentication>,
    service: Option<areal_protocol::service::Identity>,
    configuration: Option<Arc<dyn configuration::ModelConfigurationControl>>,
) -> Router {
    engine.start_task_scheduler();
    let authentication = authentication.map(|auth| {
        browser_auth::BrowserAuth::new(auth, browser_origin.as_deref().unwrap_or_default())
    });
    Router::new()
        .route("/", get(upgrade))
        .route("/ui", get(|| async {
            ([("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"), ("x-content-type-options", "nosniff"), ("referrer-policy", "no-referrer")], Html(include_str!("../../../clients/web/index.html")))
        }))
        .route("/ui/app.js", get(|| async { ([("content-type", "text/javascript; charset=utf-8"), ("x-content-type-options", "nosniff")], include_str!("../../../clients/web/app.js")) }))
        .route("/ui/style.css", get(|| async { ([("content-type", "text/css; charset=utf-8"), ("x-content-type-options", "nosniff")], concat!(include_str!("../../../design/tokens/focus.css"), "\n", include_str!("../../../clients/web/style.css"))) }))
        .route("/areal/auth/session", axum::routing::post(browser_auth::session))
        .route("/areal/auth/bootstrap", axum::routing::post(browser_auth::bootstrap))
        .route("/areal/auth/bootstrap/exchange", axum::routing::post(browser_auth::exchange).layer(DefaultBodyLimit::max(1024)))
        .route("/healthz", get(|| async { "ok" }))
        .route("/areal/service", get(service_identity))
        .route("/areal/blobs/{id}", get(read_blob))
        .route("/areal/blobs", axum::routing::post(upload_blob).layer(DefaultBodyLimit::max(16 * 1024 * 1024)))
        .route(
            "/readyz",
            get(|State(engine): State<Arc<Engine>>| async move {
                if engine.is_closed() {
                    StatusCode::SERVICE_UNAVAILABLE
                } else {
                    StatusCode::OK
                }
            }),
        )
        .layer(Extension(authentication))
        .layer(Extension(browser_origin))
        .layer(Extension(service))
        .layer(Extension(configuration))
        .with_state(engine)
}

async fn service_identity(
    Extension(authentication): Extension<Option<browser_auth::BrowserAuth>>,
    Extension(service): Extension<Option<areal_protocol::service::Identity>>,
    Extension(browser_origin): Extension<Option<String>>,
    headers: HeaderMap,
) -> Response {
    if headers
        .get("origin")
        .is_some_and(|value| value.to_str().ok() != browser_origin.as_deref())
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(principal) = authentication.and_then(|auth| auth.authenticate(&headers)) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if !principal.allows(auth::Permission::Observe) {
        return StatusCode::FORBIDDEN.into_response();
    }
    match service {
        Some(identity) => axum::Json(identity).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BlobQuery {
    thread_id: Option<String>,
    call_id: Option<String>,
    host_generation: Option<String>,
}
async fn read_blob(
    State(engine): State<Arc<Engine>>,
    Extension(authentication): Extension<Option<browser_auth::BrowserAuth>>,
    headers: HeaderMap,
    Query(query): Query<BlobQuery>,
    Path(id): Path<String>,
) -> Response {
    let bytes = if let Some(authentication) = authentication {
        let Some(principal) = authentication.authenticate(&headers) else {
            return StatusCode::UNAUTHORIZED.into_response();
        };
        let Some(thread_id) = query.thread_id else {
            return StatusCode::BAD_REQUEST.into_response();
        };
        if !principal.allows(auth::Permission::Observe) || !principal.sees(&thread_id) {
            return StatusCode::FORBIDDEN.into_response();
        }
        engine.thread_blob(&thread_id, &id).await
    } else {
        engine.read_blob(&id).await
    };
    match bytes {
        Ok(bytes) => Response::builder()
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .header(header::CACHE_CONTROL, "private, immutable")
            .header("x-content-type-options", "nosniff")
            .body(Body::from(bytes))
            .unwrap(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}
async fn upload_blob(
    State(engine): State<Arc<Engine>>,
    Extension(authentication): Extension<Option<browser_auth::BrowserAuth>>,
    Extension(browser_origin): Extension<Option<String>>,
    headers: HeaderMap,
    Query(query): Query<BlobQuery>,
    bytes: axum::body::Bytes,
) -> Response {
    if headers
        .get("origin")
        .is_some_and(|origin| origin.to_str().ok() != browser_origin.as_deref())
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let principal = match authentication {
        Some(auth) => match auth.authenticate(&headers) {
            Some(p) => p,
            None => return StatusCode::UNAUTHORIZED.into_response(),
        },
        None => auth::Principal::embedded(),
    };
    let Some(thread_id) = query.thread_id else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let call = match (query.call_id, query.host_generation) {
        (Some(call), Some(generation)) => Some((call, generation)),
        (None, None) => None,
        _ => return StatusCode::BAD_REQUEST.into_response(),
    };
    if !principal.sees(&thread_id)
        || !principal.allows(if call.is_some() {
            auth::Permission::Tools
        } else {
            auth::Permission::Interact
        })
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(mime) = headers
        .get(header::CONTENT_TYPE)
        .and_then(|s| s.to_str().ok())
    else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    match engine
        .upload_blob(
            thread_id,
            principal.id.clone(),
            call,
            mime.into(),
            bytes.to_vec(),
        )
        .await
    {
        Ok(media) => (StatusCode::CREATED, axum::Json(media)).into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({"error":map_error(error)})),
        )
            .into_response(),
    }
}

pub async fn serve(
    listener: TcpListener,
    engine: Arc<Engine>,
    stop: CancellationToken,
) -> anyhow::Result<()> {
    serve_authenticated(listener, engine, stop, None).await
}

/// 嵌入式调用方须显式选择认证；产品 server 总是传入启动器身份。
pub async fn serve_authenticated(
    listener: TcpListener,
    engine: Arc<Engine>,
    stop: CancellationToken,
    authentication: Option<auth::Authentication>,
) -> anyhow::Result<()> {
    serve_service(listener, engine, stop, authentication, None).await
}

pub async fn serve_service(
    listener: TcpListener,
    engine: Arc<Engine>,
    stop: CancellationToken,
    authentication: Option<auth::Authentication>,
    identity: Option<areal_protocol::service::Identity>,
) -> anyhow::Result<()> {
    serve_service_with_configuration(listener, engine, stop, authentication, identity, None).await
}

pub async fn serve_service_with_configuration(
    listener: TcpListener,
    engine: Arc<Engine>,
    stop: CancellationToken,
    authentication: Option<auth::Authentication>,
    identity: Option<areal_protocol::service::Identity>,
    configuration: Option<Arc<dyn configuration::ModelConfigurationControl>>,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        listener.local_addr()?.ip().is_loopback(),
        "Core listener must bind to loopback"
    );
    let origin = format!("http://{}", listener.local_addr()?);
    axum::serve(
        listener,
        configured_router(
            engine,
            Some(origin),
            authentication,
            identity,
            configuration,
        ),
    )
    .with_graceful_shutdown(stop.cancelled_owned())
    .await?;
    Ok(())
}

async fn upgrade(
    State(engine): State<Arc<Engine>>,
    Extension(configuration): Extension<Option<Arc<dyn configuration::ModelConfigurationControl>>>,
    Extension(browser_origin): Extension<Option<String>>,
    Extension(authentication): Extension<Option<browser_auth::BrowserAuth>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    if let Some(origin) = headers.get("origin")
        && (origin.to_str().ok() != browser_origin.as_deref() || browser_origin.is_none())
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let (principal, expires) = match authentication {
        Some(authentication) => match authentication.connection(&headers) {
            Some(principal) => principal,
            None => return StatusCode::UNAUTHORIZED.into_response(),
        },
        None => (auth::Principal::embedded(), None),
    };
    ws.max_message_size(MAX_FRAME_BYTES)
        .max_frame_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| connection(socket, engine, principal, expires, configuration))
        .into_response()
}

struct Connection {
    configuration: Option<Arc<dyn configuration::ModelConfigurationControl>>,
    principal: Arc<auth::Principal>,
    tool_host: Arc<dynamic_tools::ToolHost>,
    initialized: bool,
    experimental_api: bool,
    ready: bool,
    subscriptions: HashMap<String, CancellationToken>,
    suppressed: HashSet<String>,
    tx: mpsc::Sender<Outbound>,
    stop: CancellationToken,
    tasks: TaskTracker,
    delivery: Arc<Mutex<()>>,
    rpc_permits: Arc<tokio::sync::Semaphore>,
}

enum Outbound {
    Message(Value),
    Observation {
        value: Value,
        subscription: CancellationToken,
    },
    Event {
        value: Value,
        subscription: CancellationToken,
    },
}

#[derive(Default)]
struct BoundedJson {
    bytes: Vec<u8>,
}

impl std::io::Write for BoundedJson {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > MAX_RESPONSE_BYTES - self.bytes.len() {
            return Err(std::io::Error::other("response exceeds byte limit"));
        }
        let length = self.bytes.len() + bytes.len();
        if length > self.bytes.capacity() {
            let capacity = length
                .max(self.bytes.capacity().saturating_mul(2))
                .min(MAX_RESPONSE_BYTES);
            self.bytes.reserve_exact(capacity - self.bytes.len());
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn encode_outbound(value: &Value) -> Option<String> {
    let mut output = BoundedJson::default();
    serde_json::to_writer(&mut output, value).ok()?;
    String::from_utf8(output.bytes).ok()
}

async fn connection(
    socket: WebSocket,
    engine: Arc<Engine>,
    principal: Arc<auth::Principal>,
    expires: Option<tokio::time::Instant>,
    configuration: Option<Arc<dyn configuration::ModelConfigurationControl>>,
) {
    let expired = async move {
        match expires {
            Some(deadline) => tokio::time::sleep_until(deadline).await,
            None => std::future::pending::<()>().await,
        }
    };
    tokio::pin!(expired);
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Outbound>(256);
    let stop = CancellationToken::new();
    let writer_stop = stop.clone();
    let writer = tokio::spawn(async move {
        loop {
            let outbound = tokio::select! { biased; _ = writer_stop.cancelled() => break, value = rx.recv() => value };
            let Some(outbound) = outbound else {
                break;
            };
            let (value, observation) = match outbound {
                Outbound::Message(value) => (value, None),
                Outbound::Observation {
                    value,
                    subscription,
                } => (value, Some(subscription)),
                Outbound::Event {
                    value,
                    subscription,
                } => {
                    if subscription.is_cancelled() {
                        continue;
                    }
                    (value, None)
                }
            };
            let text = encode_outbound(&value).or_else(|| {
                if let Some(subscription) = observation {
                    subscription.cancel();
                }
                let id = value.get("id").filter(|_| value.get("method").is_none())?;
                encode_outbound(&response(
                    id.clone(),
                    Err(RpcError {
                        code: -32001,
                        message: "Core response exceeds the supported loading size".into(),
                        data: Some(json!({
                            "reason": "RESPONSE_TOO_LARGE",
                            "limitBytes": MAX_RESPONSE_BYTES,
                            "retryable": false,
                            "delivery": "resultUnavailable",
                        })),
                    }),
                ))
            });
            let message = match text {
                Some(text) => Message::Text(text.into()),
                None => Message::Close(Some(CloseFrame {
                    code: 1009,
                    reason: "RESPONSE_TOO_LARGE".into(),
                })),
            };
            let closing = matches!(&message, Message::Close(_));
            match tokio::time::timeout(Duration::from_secs(5), sink.send(message)).await {
                Ok(Ok(())) if !closing => {}
                _ => {
                    writer_stop.cancel();
                    break;
                }
            }
        }
        let _ = tokio::time::timeout(Duration::from_secs(1), sink.close()).await;
    });
    let mut conn = Connection {
        configuration,
        tool_host: dynamic_tools::ToolHost::authenticated(
            tx.clone(),
            stop.clone(),
            principal.id.clone(),
        ),
        principal,
        initialized: false,
        experimental_api: false,
        ready: false,
        subscriptions: HashMap::new(),
        suppressed: HashSet::new(),
        tx,
        stop: stop.clone(),
        tasks: TaskTracker::new(),
        delivery: Arc::new(Mutex::new(())),
        rpc_permits: Arc::new(tokio::sync::Semaphore::new(16)),
    };
    loop {
        let message = tokio::select! { biased; _ = stop.cancelled() => break, _ = &mut expired => break, message = stream.next() => message };
        let Some(Ok(message)) = message else {
            break;
        };
        let Message::Text(text) = message else {
            if matches!(message, Message::Close(_)) {
                break;
            }
            continue;
        };
        let request: Value = match serde_json::from_str(&text) {
            Ok(request) => request,
            Err(_) => {
                conn.send(response(
                    Value::Null,
                    Err(RpcError {
                        code: -32700,
                        message: "Parse error".into(),
                        data: Some(json!({"reason":"REQUEST_REJECTED","outcome":{"kind":"rejected"},"recovery":{"kind":"none"}})),
                    }),
                ));
                continue;
            }
        };
        let id = request.get("id").cloned();
        if request.is_object() && request.get("method").is_none() && id.is_some() {
            conn.tool_host.respond(request);
            continue;
        }
        if !request.is_object()
            || request["method"].as_str().is_none()
            || id
                .as_ref()
                .is_some_and(|id| !(id.is_string() || id.is_i64() || id.is_u64()))
        {
            conn.send(response(
                Value::Null,
                Err(RpcError {
                    code: -32600,
                    message: "Invalid request".into(),
                    data: Some(json!({"reason":"REQUEST_REJECTED","outcome":{"kind":"rejected"},"recovery":{"kind":"none"}})),
                }),
            ));
            continue;
        }
        let method = request["method"].as_str().unwrap();
        if id.is_none() {
            if method == "initialized" && conn.initialized {
                conn.ready = true;
            }
            continue;
        }
        let params = request
            .get("params")
            .filter(|p| !p.is_null())
            .cloned()
            .unwrap_or(json!({}));
        if !conn.principal.token.is_empty()
            && params
                .get("input")
                .and_then(Value::as_array)
                .is_some_and(|input| {
                    input
                        .iter()
                        .any(|v| matches!(v["type"].as_str(), Some("localImage" | "localAudio")))
                })
        {
            conn.send(response(id.unwrap(),Err(RpcError::invalid("authenticated clients must upload media; host filesystem paths are not accepted"))));
            continue;
        }
        // Native selection imports require the authenticated desktop host.
        if matches!(
            method,
            "areal/mcp/form/resource/prepare" | "areal/mcp/form/resource/stage"
        ) && (conn.principal.id != "desktop-owner" || conn.principal.token.is_empty())
        {
            conn.send(response(
                id.unwrap(),
                Err(RpcError {
                    code: -32003,
                    message: "authenticated native selection host required".into(),
                    data: Some(json!({"reason":"REQUEST_REJECTED","outcome":{"kind":"rejected"},"recovery":{"kind":"none"}})),
                }),
            ));
            continue;
        }
        if !conn.principal.token.is_empty()
            && conn.principal.id != "desktop-owner"
            && ((method == "areal/mcp/app/open" && params["fileResource"].is_object())
                || (method == "areal/mcp/app/request"
                    && params["request"]["method"] == "ui/host-file"))
        {
            conn.send(response(
                id.unwrap(),
                Err(RpcError {
                    code: -32003,
                    message: "trusted desktop file host required".into(),
                    data: Some(json!({"reason":"REQUEST_REJECTED","outcome":{"kind":"rejected"},"recovery":{"kind":"none"}})),
                }),
            ));
            continue;
        }
        let project_permission = (method == "areal/interaction/respond"
            && params["decision"] == "allowProject")
            || method.starts_with("areal/permissions/")
            || method.starts_with("areal/plugin/")
            || method.starts_with("areal/marketplace/")
            || codex_plugins::METHODS.contains(&method)
            || plugin_runtime::METHODS.contains(&method);
        if (method.starts_with("areal/mcp/app/tools/")
            && !conn.principal.allows(auth::Permission::Tools))
            || (project_permission
                && (!conn.principal.allows(auth::Permission::Manage)
                    || conn.principal.thread_ids.is_some()))
            || !conn.principal.allows(auth::permission(method))
            || ["threadId", "parentThreadId", "sourceThreadId"]
                .iter()
                .any(|key| {
                    params
                        .get(key)
                        .and_then(Value::as_str)
                        .is_some_and(|thread| !conn.principal.sees(thread))
                })
        {
            conn.send(response(
                id.unwrap(),
                Err(RpcError {
                    code: -32003,
                    message: "permission denied".into(),
                    data: Some(json!({"reason":"REQUEST_REJECTED","outcome":{"kind":"rejected"},"recovery":{"kind":"none"}})),
                }),
            ));
            continue;
        }
        if method == "plugin/search" && !conn.experimental_api {
            conn.send(response(
                id.unwrap(),
                Err(RpcError {
                    code: -32600,
                    message: "plugin/search requires experimentalApi capability".into(),
                    data: Some(json!({"reason":"REQUEST_REJECTED","outcome":{"kind":"rejected"},"recovery":{"kind":"none"}})),
                }),
            ));
            continue;
        }
        if conn.principal.thread_ids.is_some()
            && (method == "thread/start"
                || method == "areal/thread/start"
                || method == "areal/thread/fork"
                || method == "areal/side/start"
                || method == "areal/side/create"
                || method.starts_with("areal/workgroup/")
                || method.starts_with("areal/workflow/start"))
        {
            conn.send(response(
                id.unwrap(),
                Err(RpcError {
                    code: -32010,
                    message: "scoped principals cannot create conversations".into(),
                    data: Some(json!({"reason":"SCOPED_PRINCIPAL_UNSUPPORTED","retryable":false,"outcome":{"kind":"rejected"},"recovery":{"kind":"none"}})),
                }),
            ));
            continue;
        }
        // Long waits and snapshot creation must not block cancellation/steering
        // on this same WebSocket. Bound independently from subscriptions.
        if conn.ready
            && (method.starts_with("areal/execution/")
                || method == "areal/agent/delegate"
                || method.starts_with("areal/workgroup/")
                || processes::METHODS.contains(&method)
                || method == "areal/provider/probe"
                || method.starts_with("areal/workflow/")
                || codex_plugins::METHODS.contains(&method)
                || plugin_runtime::METHODS.contains(&method)
                || method.starts_with("areal/plugin/")
                || method.starts_with("areal/marketplace/")
                || method.starts_with("areal/mcp/")
                || method.starts_with("areal/server/")
                || method == "areal/agent/wait"
                || method == "areal/context/compact"
                || matches!(
                    method,
                    "areal/thread/fork"
                        | "areal/side/start"
                        | "areal/side/create"
                        | "areal/side/close"
                        | "areal/conversation/history"
                        | "areal/side/context/read"
                        | "areal/genUi/source"
                        | "turn/interrupt"
                        | "turn/steer"
                        | "areal/queue/steer"
                ))
        {
            let control = matches!(
                method,
                "areal/execution/cancel"
                    | "areal/execution/read"
                    | "areal/execution/list"
                    | "areal/workgroup/cancel"
                    | "areal/workgroup/read"
                    | "areal/workgroup/list"
                    | "areal/workgroup/policy"
                    | "areal/process/terminate"
                    | "areal/process/get"
                    | "areal/process/list"
                    | "areal/server/status"
                    | "areal/server/modelConfiguration/read"
                    | "areal/mcp/list"
                    | "areal/mcp/read"
                    | "areal/mcp/disconnect"
                    | "turn/interrupt"
                    | "areal/side/close"
                    | "areal/mcp/forms/list"
                    | "areal/mcp/form/respond"
                    | "areal/mcp/form/resource/prepare"
                    | "areal/mcp/form/resource/stage"
                    | "areal/mcp/form/resource/release"
                    | "areal/mcp/app/tools/resolve"
                    | "areal/mcp/app/tools/revoke"
                    | "areal/mcp/app/close"
                    | "areal/plugin/hooks/configure"
            );
            if !control && conn.rpc_permits.available_permits() <= 4 {
                conn.send(response(
                    id.unwrap(),
                    Err(RpcError::invalid(
                        "workgroup execution/wait capacity reached; control slots are reserved",
                    )),
                ));
                continue;
            }
            let Ok(permit) = conn.rpc_permits.clone().try_acquire_owned() else {
                conn.send(response(
                    id.unwrap(),
                    Err(RpcError::invalid("too many in-flight workgroup requests")),
                ));
                continue;
            };
            let method = method.to_owned();
            let identity = conn.principal.id.clone();
            let tool_host = conn.tool_host.clone();
            let principal = conn.principal.clone();
            let configuration = conn.configuration.clone();
            let engine = engine.clone();
            let tx = conn.tx.clone();
            let stop = conn.stop.clone();
            let id = id.unwrap();
            conn.tasks.spawn(async move {
                let _permit = permit;
                let durable_derivation = matches!(
                    method.as_str(),
                    "areal/thread/fork"
                        | "areal/side/start"
                        | "areal/side/create"
                        | "areal/side/close"
                );
                let dispatch = async {
                    check_side_policy(&engine, &method, &params).await?;
                    if configuration::METHODS.contains(&method.as_str()) {
                        configuration::dispatch(configuration, &principal, &method, params).await
                    } else if method == "turn/interrupt" {
                        interrupt(&engine, params).await
                    } else if method == "turn/steer" {
                        steer_request(&engine, &identity, params).await
                    } else if method == "areal/side/create" {
                        let host = (principal.id == "desktop-owner"
                            && principal.allows(auth::Permission::Interact)
                            && principal.allows(auth::Permission::Tools)
                            && principal.thread_ids.is_none())
                        .then_some(tool_host as Arc<dyn areal_engine::tools::DynamicToolHost>);
                        desktop::create_side(&engine, &identity, params, host).await
                    } else if plugin_runtime::METHODS.contains(&method.as_str()) {
                        plugin_runtime::dispatch(&engine, &identity, tool_host, &method, params)
                            .await
                    } else if codex_plugins::METHODS.contains(&method.as_str()) {
                        codex_plugins::dispatch(&engine, &identity, &method, params).await
                    } else if delegations::METHODS.contains(&method.as_str()) {
                        delegations::dispatch(&engine, &method, params).await
                    } else if processes::METHODS.contains(&method.as_str()) {
                        processes::dispatch(&engine, &identity, &method, params).await
                    } else if desktop::METHODS.contains(&method.as_str()) {
                        desktop::dispatch_with_budget(
                            &engine,
                            &identity,
                            &method,
                            params,
                            response_overhead(&id),
                        )
                        .await
                    } else {
                        workgroups::dispatch(engine, &identity, &method, params).await
                    }
                };
                // 已通过容量检查的派生写入必须进入 Core 的持久受理门；响应丢失不撤销它。
                let result = if durable_derivation {
                    dispatch.await
                } else {
                    tokio::select! { biased; _=stop.cancelled()=>return, value=dispatch=>value }
                };
                if tx
                    .try_send(Outbound::Message(response(id, result)))
                    .is_err()
                {
                    stop.cancel();
                }
            });
            continue;
        }
        if let Err(error) = check_side_policy(&engine, method, &params).await {
            conn.send(response(id.unwrap(), Err(error)));
            continue;
        }
        let delivery = conn.delivery.clone();
        let _delivery = delivery.lock().await;
        let result = conn
            .dispatch_response(
                &engine,
                method,
                params,
                response_overhead(id.as_ref().unwrap()),
            )
            .instrument(info_span!(
                "rpc.request",
                rpc.system = "jsonrpc",
                rpc.method = method
            ))
            .await;
        let observation = if matches!(method, "thread/resume" | "areal/thread/observe") {
            result
                .as_ref()
                .ok()
                .and_then(|result| result["thread"]["id"].as_str())
                .and_then(|id| conn.subscriptions.get(id))
                .cloned()
        } else {
            None
        };
        let value = response(id.unwrap(), result);
        if let Some(subscription) = observation {
            if conn
                .tx
                .try_send(Outbound::Observation {
                    value,
                    subscription,
                })
                .is_err()
            {
                conn.stop.cancel();
            }
        } else {
            conn.send(value);
        }
    }
    stop.cancel();
    conn.tasks.close();
    conn.tasks.wait().await;
    let _ = writer.await;
}

// Side 策略仍在调用 Core 前验证；已允许的方法无需读取目标状态锁。
async fn check_side_policy(engine: &Engine, method: &str, params: &Value) -> Result<(), RpcError> {
    if !matches!(
        method,
        "thread/read"
            | "thread/resume"
            | "areal/thread/observe"
            | "turn/start"
            | "areal/turn/start"
            | "turn/interrupt"
            | "areal/side/context/read"
            | "areal/genUi/source"
            | "areal/conversation/history"
            | "areal/tool/acknowledge"
            | "areal/context/read"
            | "areal/thread/configure"
            | "areal/thread/prediction"
            | "areal/thread/archive"
            | "areal/conversation/unarchive"
            | "areal/request/read"
    ) && let Some(thread_id) = params
        .get("threadId")
        .or_else(|| params.get("parentThreadId"))
        .and_then(Value::as_str)
        && engine
            .read(thread_id, false)
            .await
            .is_ok_and(|thread| thread.is_read_only_side())
    {
        return Err(RpcError {
            code: -32010,
            message: "Side conversations cannot use this method".into(),
            data: Some(
                json!({"reason":"SIDE_POLICY_VIOLATION","retryable":false,"outcome":{"kind":"rejected"},"recovery":{"kind":"none"}}),
            ),
        });
    }
    Ok(())
}
async fn interrupt(engine: &Arc<Engine>, params: Value) -> Result<Value, RpcError> {
    let p: areal_protocol::desktop::TurnInterrupt = parse(params)?;
    engine
        .interrupt_guarded(&p.thread_id, &p.turn_id, p.admission_guard)
        .await
        .map_err(control_mutation_error)
        .map_err(map_error)?;
    Ok(json!({}))
}

impl Connection {
    async fn conversation_list(&self, engine: &Engine, params: Value) -> Result<Value, RpcError> {
        let p: ConversationList = parse(params)?;
        let view = p.view.as_deref().unwrap_or("main");
        if !matches!(view, "main" | "side" | "all") {
            return Err(RpcError::invalid("view must be main, side or all"));
        }
        let limit = p.limit.unwrap_or(30);
        if !(1..=100).contains(&limit) {
            return Err(RpcError::invalid("limit must be 1..100"));
        }
        if p.source_thread_id.is_some() && view == "main" {
            return Err(RpcError::invalid(
                "sourceThreadId requires side or all view",
            ));
        }
        if let Some(source) = &p.source_thread_id
            && !self.principal.sees(source)
        {
            return Err(RpcError {
                code: -32003,
                message: "permission denied".into(),
                data: None,
            });
        }
        let filter = format!(
            "{}\0{}\0{}\0{}",
            self.principal.id,
            view,
            p.source_thread_id.as_deref().unwrap_or(""),
            p.include_archived.unwrap_or(false)
        );
        let digest = format!("{:x}", Sha256::digest(filter.as_bytes()));
        let after: Option<(i64, String)> = p
            .cursor
            .as_deref()
            .map(|cursor| {
                let bytes = URL_SAFE_NO_PAD
                    .decode(cursor)
                    .map_err(|_| RpcError::invalid("invalid conversation cursor"))?;
                let saved: ConversationCursor = serde_json::from_slice(&bytes)
                    .map_err(|_| RpcError::invalid("invalid conversation cursor"))?;
                if saved.filter != digest {
                    return Err(RpcError::invalid(
                        "conversation cursor does not match filter or identity",
                    ));
                }
                Ok((saved.created_at, saved.id))
            })
            .transpose()?;
        let mut data = Vec::new();
        let mut cursor = None;
        loop {
            let (page, next) = engine
                .list(cursor.as_deref(), 100, None)
                .await
                .map_err(map_error)?;
            data.extend(page.into_iter().filter(|thread| {
                self.principal.sees(&thread.id)
                    && (p.include_archived.unwrap_or(false)
                        || !thread.desktop.as_ref().is_some_and(|d| d.archived))
                    && match view {
                        "main" => {
                            thread.parent_thread_id.is_none()
                                && !thread.is_side()
                                && !matches!(
                                    thread.source.as_str(),
                                    "nativeTaskAgent" | "nativeResearchAgent"
                                )
                        }
                        "side" => thread.is_side(),
                        _ => true,
                    }
                    && p.source_thread_id
                        .as_ref()
                        .is_none_or(|source| match &thread.conversation {
                            Some(areal_protocol::Conversation::Side { origin, .. })
                            | Some(areal_protocol::Conversation::Fork { origin, .. }) => {
                                &origin.source_thread_id == source
                            }
                            _ => false,
                        })
            }));
            match next {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        data.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
        if let Some(after) = after {
            data.retain(|thread| (thread.created_at, thread.id.clone()) > after);
        }
        let has_more = data.len() > limit;
        data.truncate(limit);
        let next_cursor = if has_more {
            data.last().map(|thread| {
                URL_SAFE_NO_PAD.encode(
                    serde_json::to_vec(&ConversationCursor {
                        filter: digest,
                        created_at: thread.created_at,
                        id: thread.id.clone(),
                    })
                    .expect("cursor serializes"),
                )
            })
        } else {
            None
        };
        Ok(json!({"data":data,"nextCursor":next_cursor}))
    }
    fn send(&self, value: Value) {
        if value["method"]
            .as_str()
            .is_some_and(|m| self.suppressed.contains(m))
        {
            return;
        }
        // 丢失协议消息后不能继续伪装为完整流；关闭连接，由客户端重新读取历史。
        if self.tx.try_send(Outbound::Message(value)).is_err() {
            self.stop.cancel();
        }
    }
    async fn subscribe(&mut self, engine: &Engine, id: &str) -> Result<(), RpcError> {
        if self.subscriptions.contains_key(id) {
            return Ok(());
        }
        if self.subscriptions.len() >= 128 {
            return Err(RpcError {
                code: -32001,
                message: "subscription limit reached; use areal/subscription/remove".into(),
                data: None,
            });
        }
        let events = engine.subscribe(id).await.map_err(map_error)?;
        self.forward(id, events);
        Ok(())
    }
    fn forward(&mut self, id: &str, events: broadcast::Receiver<Value>) {
        self.forward_authorized(id, events, None);
    }
    fn forward_authorized(
        &mut self,
        id: &str,
        mut events: broadcast::Receiver<Value>,
        task_engine: Option<std::sync::Weak<Engine>>,
    ) {
        let task_filter = id.strip_prefix("task:").map(str::to_owned);
        let principal = self.principal.clone();
        let subscription = self.stop.child_token();
        if let Some(old) = self
            .subscriptions
            .insert(id.to_owned(), subscription.clone())
        {
            old.cancel();
        }
        let tx = self.tx.clone();
        let stop = self.stop.clone();
        let suppressed = self.suppressed.clone();
        let delivery = self.delivery.clone();
        self.tasks.spawn(async move {
            loop {
                let event = tokio::select! { biased; _ = subscription.cancelled() => break, event = events.recv() => event };
                match event {
                    Ok(event) => {
                        if task_filter.as_ref().is_some_and(|id| event["params"]["taskId"].as_str()!=Some(id)) { continue; }
                        if let Some(task_id)=&task_filter {
                            let Some(engine)=task_engine.as_ref().and_then(|weak|weak.upgrade()) else {subscription.cancel();break;};
                            if !engine.task_visible(task_id,principal.thread_ids.as_ref()).await.unwrap_or(false) {subscription.cancel();break;}
                        }
                        if event["method"].as_str().is_some_and(|m| suppressed.contains(m)) { continue; }
                        let _delivery = delivery.lock().await;
                        if subscription.is_cancelled() { break; }
                        if tx.try_send(Outbound::Event { value: event, subscription: subscription.clone() }).is_err() { stop.cancel(); break; }
                    }
                    Err(_) => { stop.cancel(); break; }
                }
            }
        });
    }
    #[cfg(test)]
    async fn dispatch(
        &mut self,
        engine: &Arc<Engine>,
        method: &str,
        params: Value,
    ) -> Result<Value, RpcError> {
        self.dispatch_response(engine, method, params, 0).await
    }
    async fn dispatch_response(
        &mut self,
        engine: &Arc<Engine>,
        method: &str,
        params: Value,
        response_overhead: usize,
    ) -> Result<Value, RpcError> {
        if method == "initialize" {
            if self.initialized {
                return Err(RpcError::invalid("Already initialized"));
            }
            let p: Initialize = parse(params)?;
            if p.client_info.name.is_empty() || p.client_info.version.is_empty() {
                return Err(RpcError::invalid("client name and version required"));
            }
            if let Some(c) = p.capabilities {
                self.experimental_api = c.experimental_api;
                self.suppressed = c
                    .opt_out_notification_methods
                    .unwrap_or_default()
                    .into_iter()
                    .collect();
            }
            self.initialized = true;
            return Ok(
                json!({"userAgent": "areal-core/0.1.0", "platformFamily": std::env::consts::FAMILY,
                "platformOs": std::env::consts::OS, "codexHome": engine.data_dir()}),
            );
        }
        if !self.ready {
            return Err(rejected(
                RpcError::invalid("Not initialized"),
                "NOT_INITIALIZED",
            ));
        }
        if method == "areal/work/overview" {
            return engine
                .work_overview(self.principal.thread_ids.as_ref(), parse(params)?)
                .await
                .map(|page| json!(page))
                .map_err(map_error);
        }
        if method == "areal/task/host/ready" {
            if !params.as_object().is_some_and(|p| p.is_empty()) {
                return Err(RpcError::invalid("expected empty host readiness request"));
            }
            if self.principal.thread_ids.is_some()
                || !self.principal.allows(auth::Permission::Manage)
                || !self.principal.allows(auth::Permission::Tools)
            {
                return Err(RpcError {
                    code: -32003,
                    message: "unrestricted desktop host permission required".into(),
                    data: None,
                });
            }
            engine
                .register_schedule_host(self.tool_host.clone())
                .await
                .map_err(map_error)?;
            return Ok(json!({"ready":true}));
        }
        if task_mode::METHODS.contains(&method) {
            if matches!(method, "areal/task/subscribe" | "areal/task/unsubscribe") {
                let p: areal_protocol::tasks::TaskTarget = parse(params)?;
                task_mode::authorize(engine, &self.principal, &p.task_id).await?;
                let key = format!("task:{}", p.task_id);
                if method == "areal/task/unsubscribe" {
                    if let Some(token) = self.subscriptions.remove(&key) {
                        token.cancel();
                    }
                    return Ok(json!({"removed":true}));
                }
                if !self.subscriptions.contains_key(&key) && self.subscriptions.len() >= 128 {
                    return Err(RpcError::invalid("subscription limit reached"));
                }
                let (snapshot, events) = engine
                    .task_snapshot_and_subscribe_for_threads(
                        &p.task_id,
                        self.principal.thread_ids.as_ref(),
                    )
                    .await
                    .map_err(map_error)?;
                if !engine
                    .task_visible(&p.task_id, self.principal.thread_ids.as_ref())
                    .await
                    .map_err(map_error)?
                {
                    return Err(RpcError {
                        code: -32003,
                        message: "task permission changed".into(),
                        data: None,
                    });
                }
                self.forward_authorized(&key, events, Some(Arc::downgrade(engine)));
                return Ok(snapshot);
            }
            return task_mode::dispatch(engine, &self.principal, method, params).await;
        }
        if configuration::METHODS.contains(&method) {
            return configuration::dispatch(
                self.configuration.clone(),
                &self.principal,
                method,
                params,
            )
            .await;
        }
        if method == "areal/conversation/list" {
            return self.conversation_list(engine, params).await;
        }
        if plugin_runtime::METHODS.contains(&method) {
            if method.starts_with("areal/mcp/app/tools/")
                && (!self.principal.allows(auth::Permission::Manage)
                    || !self.principal.allows(auth::Permission::Tools)
                    || self.principal.thread_ids.is_some())
            {
                return Err(RpcError {
                    code: -32003,
                    message: "unrestricted Manage and Tools permissions required".into(),
                    data: Some(
                        json!({"reason":"PERMISSION_DENIED","outcome":{"kind":"rejected"},"recovery":{"kind":"none"}}),
                    ),
                });
            }
            return plugin_runtime::dispatch(
                engine,
                &self.principal.id,
                self.tool_host.clone(),
                method,
                params,
            )
            .await;
        }
        if codex_plugins::METHODS.contains(&method) {
            return codex_plugins::dispatch(engine, &self.principal.id, method, params).await;
        }
        if method == "areal/request/read" && params.get("taskId").is_some() {
            return engine
                .task_run_now_receipt_for_threads(
                    &self.principal.id,
                    parse(params)?,
                    self.principal.thread_ids.as_ref(),
                )
                .await
                .map_err(map_error);
        }
        if desktop::METHODS.contains(&method) && method != "areal/thread/start" {
            if matches!(method, "areal/turn/start" | "areal/turn/enqueue") {
                let p: areal_protocol::desktop::TurnStart = parse(params.clone())?;
                self.subscribe(engine, &p.thread_id).await?;
            }
            if method == "areal/turn/submit" {
                let p: areal_protocol::desktop::TurnSubmit = parse(params.clone())?;
                self.subscribe(engine, &p.thread_id).await?;
            }
            let scoped_request_search =
                method == "areal/request/read" && self.principal.thread_ids.is_some();
            let mut result = desktop::dispatch_with_budget(
                engine,
                &self.principal.id,
                method,
                params,
                response_overhead,
            )
            .await?;
            if scoped_request_search
                && let Some(data) = result.get_mut("data").and_then(Value::as_array_mut)
            {
                let visible_tasks: std::collections::HashSet<String> = engine
                    .task_list_for_threads(self.principal.thread_ids.as_ref())
                    .await
                    .map_err(map_error)?
                    .into_iter()
                    .map(|task| task.id)
                    .collect();
                data.retain(|entry| {
                    if let Some(task_id) = entry["taskId"].as_str() {
                        visible_tasks.contains(task_id)
                    } else {
                        entry["threadId"]
                            .as_str()
                            .is_some_and(|id| self.principal.sees(id))
                    }
                });
            }
            return Ok(result);
        }
        match method {
            "areal/thread/tools/attach" => {
                if self.principal.id != "desktop-owner"
                    || !self.principal.allows(auth::Permission::Interact)
                    || !self.principal.allows(auth::Permission::Tools)
                    || self.principal.thread_ids.is_some()
                {
                    return Err(RpcError {
                        code: -32003,
                        message: "trusted desktop tool host required".into(),
                        data: None,
                    });
                }
                let request: areal_protocol::desktop::AttachBrowserTools = parse(params)?;
                engine
                    .attach_browser_tools(
                        self.principal.id.clone(),
                        request,
                        self.tool_host.clone(),
                    )
                    .await
                    .map_err(map_error)
            }
            "areal/thread/start" => {
                let p: areal_protocol::desktop::ThreadStart = parse(params)?;
                if self.subscriptions.len() >= 128 {
                    return Err(RpcError {
                        code: -32001,
                        message:
                            "subscription limit reached; unsubscribe before creating another thread"
                                .into(),
                        data: None,
                    });
                }
                if !p.dynamic_tools.is_empty() && !self.principal.allows(auth::Permission::Tools) {
                    return Err(RpcError {
                        code: -32003,
                        message: "tool host permission required".into(),
                        data: None,
                    });
                }
                let thread = engine
                    .create_configured(self.principal.id.clone(), p, self.tool_host.clone())
                    .await
                    .map_err(map_error)?;
                self.subscribe(engine, &thread.id).await?;
                self.send(areal_protocol::notification(
                    "thread/started",
                    json!({"thread":thread}),
                ));
                Ok(thread_result(engine, thread))
            }
            "areal/capabilities" => {
                use areal_protocol::desktop::{
                    API_VERSION, METHODS, NOTIFICATIONS, SERVER_REQUESTS,
                };
                let p: areal_protocol::desktop::CapabilitiesRequest = parse(params)?;
                if p.api_version
                    .as_deref()
                    .is_some_and(|version| version != API_VERSION)
                {
                    return Err(RpcError::invalid("unsupported AReaL API version"));
                }
                let mut methods = METHODS.to_vec();
                let can_attach_browser = self.principal.id == "desktop-owner"
                    && self.principal.allows(auth::Permission::Interact)
                    && self.principal.allows(auth::Permission::Tools)
                    && self.principal.thread_ids.is_none();
                if !can_attach_browser {
                    methods.retain(|method| *method != "areal/thread/tools/attach");
                }
                if self.configuration.is_some() && configuration::authorized(&self.principal) {
                    methods.extend_from_slice(configuration::METHODS);
                }
                methods.extend_from_slice(desktop::METHODS);
                methods.extend_from_slice(codex_plugins::METHODS);
                methods.extend_from_slice(plugin_runtime::METHODS);
                methods.extend_from_slice(task_mode::METHODS);
                methods.extend_from_slice(&additional_methods::METHODS[..2]);
                if !engine.runtime_capabilities().is_null() {
                    methods.extend_from_slice(processes::METHODS);
                }
                if engine.workgroups().is_ok() {
                    methods.extend_from_slice(&additional_methods::METHODS[2..]);
                }
                let semantics = methods
                    .iter()
                    .map(|method| {
                        method_semantics(method)
                            .map(|semantics| ((*method).to_owned(), semantics))
                            .ok_or_else(|| RpcError {
                                code: -32603,
                                message: format!("Missing method semantics for {method}"),
                                data: None,
                            })
                    })
                    .collect::<Result<std::collections::BTreeMap<_, _>, _>>()?;
                let mut notifications = NOTIFICATIONS.to_vec();
                notifications.extend([
                    "areal/mcp/app/tools/pending",
                    "areal/mcp/app/tools/cancelled",
                ]);
                let mut capabilities = json!({"apiVersion": API_VERSION, "methods": methods, "methodSemantics":semantics,
                    "notifications": notifications, "serverRequests":SERVER_REQUESTS,
                    "browserToolBundles":if can_attach_browser {json!([{"bundleId":areal_protocol::desktop::BROWSER_V1_BUNDLE,
                        "definition":areal_protocol::desktop::browser_v1_tool()}])} else {json!([])},
                    "features":json!({"operationOutcomes":true,"taskRequestReceipts":true,"atomicConfigureReceipt":true,"conversationDerivationV1":json!({"preview":false,"methods":["areal/thread/fork","areal/side/start","areal/conversation/list","areal/conversation/history","areal/conversation/unarchive","areal/side/context/read"],"limits":engine.conversation_derivation_limits(),"forkBoundaries":["after","before"],"workspaceModes":["sharedCurrent"],"sideWorkspaceAccess":if engine.side_workspace_read_available() {json!(["none","readOnly"])} else {json!(["none"])},"historyBytes":engine.fork_snapshot_limit()}),"subscriptionRemoval":true,"atomicResume":true,"atomicObserve":true,"atomicObserveOwnership":true,"browserToolAttachment":can_attach_browser,
                        "ordinaryTurnSubmit":true,"editLastMessage":true,"turnStartAdmissionGuard":true,"turnEnqueueAdmissionGuard":true,"turnInterruptAdmissionGuard":true,"threadStartAdmissionGuard":true,"taskPauseRunGuard":true,"taskModes":true,"taskChannels":true,"asyncQuestions":true,"headlessInteractions":true,"goals":true,"dynamicTools":true,"mediaOutput":true,"durableSubmissionDeduplication":true,"profiles":true,"skills":true,"plans":true,"interactions":true,"queue":true,"providerConfiguration":true,"modelReset":true,"toolMedia":true,"blobUpload":true}),
                    "limits":{"frameBytes":MAX_FRAME_BYTES,"responseBytes":MAX_RESPONSE_BYTES,"subscriptions":128,"sendQueue":256,"threadEventWindow":128},
                    "runtime":engine.runtime_capabilities()});
                capabilities["features"]["sideExecutableV2"] = json!(true);
                capabilities["desktopToolBundles"] = if can_attach_browser {
                    json!([{ "bundleId":areal_protocol::desktop::COMPUTER_V1_BUNDLE,
                        "definition":areal_protocol::desktop::computer_v1_tool() }])
                } else {
                    json!([])
                };
                capabilities["features"]["computerToolAttachment"] = json!(can_attach_browser);
                capabilities["features"]["computerToolPreparation"] = json!(can_attach_browser);
                capabilities["features"]["externalCua"] = json!(can_attach_browser);
                capabilities["features"]["mcpPageToolsV1"] =
                    json!({"version":1,"kinds":["getSelection","applyPatch"]});
                capabilities["features"]["permissionPresets"] =
                    json!(engine.permission_presets_available());
                capabilities["features"]["permissionFullAccess"] =
                    json!(engine.permission_full_access_available());
                capabilities["features"]["taskRunHistory"] = json!(true);
                capabilities["features"]["automaticSessionName"] = json!(true);
                capabilities["features"]["boundedObservation"] = json!(true);
                capabilities["features"]["boundedResume"] = json!(true);
                capabilities["features"]["boundedHistory"] = json!(true);
                Ok(capabilities)
            }
            "areal/subscription/remove" => {
                let p: areal_protocol::desktop::RemoveSubscriptions = parse(params)?;
                if p.thread_ids.len() > areal_protocol::desktop::MAX_SUBSCRIPTIONS {
                    return Err(RpcError::invalid("at most 128 thread IDs per removal"));
                }
                for id in p.thread_ids {
                    if let Some(subscription) = self.subscriptions.remove(&id) {
                        subscription.cancel();
                    }
                }
                Ok(json!({"subscriptionCount":self.subscriptions.len()}))
            }
            "model/list" => {
                let _: ModelList = parse(params)?;
                let catalog = engine.model_catalog().await;
                let data:Vec<_>=catalog["data"].as_array().unwrap().iter().map(|model|{
                    let name=model["modelId"].as_str().unwrap();let default=model["providerId"].is_null();
                    let mut value=json!({"id":if default{name.into()}else{format!("{}:{name}",model["providerId"].as_str().unwrap())},"model":name,"displayName":name,"description":"Configured API model","hidden":false,"isDefault":default,"defaultReasoningEffort":"none","supportedReasoningEfforts":[],"inputModalities":model["input"].as_array().unwrap().iter().filter(|v|**v!="file").collect::<Vec<_>>(),"arealCapabilities":{"providerId":model["providerId"],"providerRevision":model["providerRevision"],"inputModalities":model["input"],"outputModalities":model["output"]}});
                    if default{let caps=value["arealCapabilities"].as_object_mut().unwrap();caps.remove("providerId");caps.remove("providerRevision");}value
                }).collect();
                Ok(json!({"data":data,"nextCursor":null}))
            }
            "thread/start" => {
                let p: ThreadStart = parse(params)?;
                if self.subscriptions.len() >= 128 {
                    return Err(RpcError {
                        code: -32001,
                        message: "subscription limit reached; use areal/subscription/remove".into(),
                        data: None,
                    });
                }
                if !p.dynamic_tools.is_empty() && !self.principal.allows(auth::Permission::Tools) {
                    return Err(RpcError {
                        code: -32003,
                        message: "tool host permission required".into(),
                        data: None,
                    });
                }
                validate_model(engine, p.model.as_deref())?;
                let cwd = p.cwd.unwrap_or_else(|| engine.default_cwd());
                let thread = engine
                    .create_with_tools(cwd, p.dynamic_tools, self.tool_host.clone())
                    .await
                    .map_err(map_error)?;
                self.subscribe(engine, &thread.id).await?;
                self.send(areal_protocol::notification(
                    "thread/started",
                    json!({"thread": thread}),
                ));
                Ok(thread_result(engine, thread))
            }
            "thread/resume" => {
                let p: areal_protocol::desktop::ObserveThread = parse(params)?;
                let budget = match p.mode {
                    Some(areal_protocol::desktop::ObservationMode::Bounded) => {
                        Some(bounded_history_budget(p.max_bytes, response_overhead)?)
                    }
                    None if p.max_bytes.is_some() => {
                        return Err(RpcError::invalid("maxBytes requires mode bounded"));
                    }
                    None => None,
                };
                if !self.subscriptions.contains_key(&p.thread_id) && self.subscriptions.len() >= 128
                {
                    return Err(RpcError {
                        code: -32001,
                        message: "subscription limit reached".into(),
                        data: None,
                    });
                }
                if self.principal.allows(auth::Permission::Tools) {
                    engine
                        .bind_tool_host(&p.thread_id, self.tool_host.clone())
                        .await
                        .map_err(map_error)?;
                }
                if let Some(budget) = budget {
                    let (result, events) = engine
                        .snapshot_and_subscribe_bounded(
                            &p.thread_id,
                            &self.principal.id,
                            self.principal.thread_ids.as_ref(),
                            budget,
                            thread_metadata(engine, ""),
                        )
                        .await
                        .map_err(map_error)?;
                    self.forward(&p.thread_id, events);
                    return Ok(result);
                }
                let (thread, events) = engine
                    .snapshot_and_subscribe(&p.thread_id)
                    .await
                    .map_err(map_error)?;
                self.forward(&p.thread_id, events);
                Ok(thread_result(engine, thread))
            }
            "areal/thread/observe" => {
                let p: areal_protocol::desktop::ObserveThread = parse(params)?;
                if !self.subscriptions.contains_key(&p.thread_id) && self.subscriptions.len() >= 128
                {
                    return Err(RpcError {
                        code: -32001,
                        message: "subscription limit reached".into(),
                        data: None,
                    });
                }
                if p.mode == Some(areal_protocol::desktop::ObservationMode::Bounded) {
                    let budget = bounded_history_budget(p.max_bytes, response_overhead)?;
                    let (result, events) = engine
                        .snapshot_and_subscribe_bounded(
                            &p.thread_id,
                            &self.principal.id,
                            self.principal.thread_ids.as_ref(),
                            budget,
                            thread_metadata(engine, ""),
                        )
                        .await
                        .map_err(map_error)?;
                    self.forward(&p.thread_id, events);
                    return Ok(result);
                }
                if p.mode.is_some() || p.max_bytes.is_some() {
                    return Err(RpcError::invalid("maxBytes requires mode bounded"));
                }
                let (thread, ownership, events) = engine
                    .snapshot_and_subscribe_with_ownership(
                        &p.thread_id,
                        self.principal.thread_ids.as_ref(),
                    )
                    .await
                    .map_err(map_error)?;
                self.forward(&p.thread_id, events);
                let mut result = thread_result(engine, thread);
                result["ownership"] = json!(ownership);
                Ok(result)
            }
            "thread/read" => {
                let p: ThreadRead = parse(params)?;
                Ok(
                    json!({"thread":engine.read(&p.thread_id, p.include_turns).await.map_err(map_error)?}),
                )
            }
            "thread/list" | "areal/agent/list" => {
                let p: ThreadList = parse(params)?;
                if method == "thread/list" && p.parent_thread_id.is_some() {
                    return Err(RpcError::invalid(
                        "use areal/agent/list for parent filtering",
                    ));
                }
                let (mut data, cursor) = engine
                    .list(
                        p.cursor.as_deref(),
                        p.limit.unwrap_or(30),
                        p.parent_thread_id.as_deref(),
                    )
                    .await
                    .map_err(map_error)?;
                data.retain(|thread| self.principal.sees(&thread.id) && !thread.is_side());
                Ok(json!({"data":data,"nextCursor":cursor}))
            }
            "turn/start" => {
                let p: TurnStart = parse(params)?;
                self.subscribe(engine, &p.thread_id).await?;
                Ok(json!({"turn":engine.start(&p.thread_id,p.input).await.map_err(map_error)?}))
            }
            "turn/steer" => steer_request(engine, &self.principal.id, params).await,
            "turn/interrupt" => interrupt(engine, params).await,
            "areal/agent/spawn" => {
                let p: areal_protocol::desktop::AgentSpawn = parse(params)?;
                engine.spawn_agent(p).await.map_err(map_error)
            }
            "areal/tool/acknowledge" => {
                #[derive(serde::Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Acknowledge {
                    thread_id: String,
                    item_id: String,
                    inspection: String,
                }
                let p: Acknowledge = parse(params)?;
                engine
                    .acknowledge_tool(p.thread_id, p.item_id, p.inspection)
                    .await
                    .map_err(map_error)?;
                Ok(json!({}))
            }
            _ => Err(RpcError::method()),
        }
    }
}

fn validate_model(engine: &Engine, model: Option<&str>) -> Result<(), RpcError> {
    if model.is_some_and(|m| m != engine.model_name()) {
        return Err(RpcError::invalid("unknown model"));
    }
    Ok(())
}
fn response_overhead(id: &Value) -> usize {
    serde_json::to_vec(&response(id.clone(), Ok(Value::Null)))
        .unwrap()
        .len()
        - 4
}
fn bounded_history_budget(max_bytes: Option<usize>, overhead: usize) -> Result<usize, RpcError> {
    let requested = max_bytes.unwrap_or(areal_protocol::desktop::DEFAULT_HISTORY_PAGE_BYTES);
    if !(1..=areal_protocol::desktop::MAX_HISTORY_PAGE_BYTES).contains(&requested) {
        return Err(RpcError::invalid("maxBytes must be 1..1048576"));
    }
    requested.checked_sub(overhead).ok_or_else(|| RpcError {
        code: -32012, message: "History page budget too small".into(),
        data: Some(json!({"reason":"HISTORY_BUDGET_TOO_SMALL","retryable":false,"outcome":{"kind":"noMutation"},"recovery":{"kind":"none"}})),
    })
}
fn thread_metadata(engine: &Engine, cwd: &str) -> Value {
    json!({"cwd":cwd,"model":engine.model_name(),"modelProvider":engine.model_provider(),
        "approvalPolicy":if engine.permission_config().mode.requires_approval() { "on-request" } else { "never" },"permissionMode":engine.permission_config().mode,"approvalsReviewer":"user","sandbox":engine.sandbox(),"reasoningEffort":null})
}
fn thread_result(engine: &Engine, thread: areal_protocol::Thread) -> Value {
    let mut result = thread_metadata(engine, &thread.cwd);
    result["thread"] = json!(thread);
    result
}
fn parse<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, RpcError> {
    serde_json::from_value(value)
        .map_err(|e| rejected(RpcError::invalid(e.to_string()), "INVALID_REQUEST"))
}
fn rejected(mut error: RpcError, reason: &str) -> RpcError {
    let mut data = match error.data.take() {
        Some(Value::Object(data)) => data,
        _ => serde_json::Map::new(),
    };
    data.entry("reason").or_insert_with(|| json!(reason));
    data.insert(
        "outcome".into(),
        json!(areal_protocol::desktop::FailureOutcome::Rejected),
    );
    data.insert(
        "recovery".into(),
        json!(areal_protocol::desktop::Recovery::None),
    );
    error.data = Some(Value::Object(data));
    error
}

mod additional_methods {
    areal_protocol::method_catalog! {
        "areal/work/overview" => Read;
        "areal/task/host/ready" => Subscription;
        "areal/workgroup/policy" => Read;
        "areal/workgroup/start" => Mutation;
        "areal/workgroup/list" => Read;
        "areal/workgroup/read" => Read;
        "areal/workgroup/wait" => Read;
        "areal/workgroup/cancel" => Mutation;
        "areal/workgroup/revise" => Mutation;
        "areal/workgroup/artifact" => Read;
    }
}

fn method_semantics(method: &str) -> Option<areal_protocol::desktop::MethodSemantics> {
    areal_protocol::desktop::method_semantics(method)
        .or_else(|| desktop::method_semantics(method))
        .or_else(|| configuration::method_semantics(method))
        .or_else(|| task_mode::method_semantics(method))
        .or_else(|| processes::method_semantics(method))
        .or_else(|| codex_plugins::method_semantics(method))
        .or_else(|| plugin_runtime::method_semantics(method))
        .or_else(|| additional_methods::method_semantics(method))
}

fn atomic_mutation_error(error: Error) -> Error {
    match error {
        Error::Storage(_) | Error::OperationOutcome(_) | Error::Rejected(_) => error,
        error => Error::Rejected(Box::new(error)),
    }
}

// These controls validate under their owner lock before persisting. Capacity or
// storage failure can follow a partial write (or cancellation), so keep it unknown.
fn control_mutation_error(error: Error) -> Error {
    match error {
        Error::Conflict | Error::NotFound | Error::Invalid(_) | Error::Closed => {
            Error::Rejected(Box::new(error))
        }
        error => error,
    }
}

fn map_error(error: Error) -> RpcError {
    if let Error::Rejected(error) = error {
        return rejected(map_error(*error), "REQUEST_REJECTED");
    }
    if let Error::HistoryRead {
        reason,
        thread_id,
        restart_cursor,
    } = &error
    {
        return RpcError {
            code: -32012,
            message: "History view requires a fresh bounded read".into(),
            data: Some(
                json!({"reason":reason,"threadId":thread_id,"view":"own","reset":*reason == "HISTORY_CURSOR_STALE","restartCursor":restart_cursor,"retryable":false,"outcome":{"kind":"noMutation"},"recovery":{"kind":"none"}}),
            ),
        };
    }
    if let Error::OperationOutcome(failure) = &error {
        return RpcError {
            code: -32011,
            message: "Operation outcome requires reconciliation".into(),
            data: Some(json!(failure)),
        };
    }
    if let Error::Invalid(reason) = &error
        && let Some(code) = [
            "CREDENTIAL_UNAVAILABLE",
            "MODEL_CREDENTIAL_UNAVAILABLE",
            "UNSUPPORTED_PROFILE",
        ]
        .into_iter()
        .find(|code| reason == code || reason.starts_with(&format!("{code}:")))
    {
        return rejected(RpcError::invalid(error.to_string()), code);
    }
    if matches!(&error,Error::Invalid(reason) if reason=="TASK_PERMISSION_DENIED") {
        return RpcError {
            code: -32003,
            message: "task permission denied".into(),
            data: Some(
                json!({"reason":"PERMISSION_DENIED","outcome":{"kind":"rejected"},"recovery":{"kind":"none"}}),
            ),
        };
    }
    if matches!(&error, Error::Invalid(reason) if reason == "SIDE_POLICY_VIOLATION") {
        return RpcError {
            code: -32010,
            message: "SIDE_POLICY_VIOLATION".into(),
            data: Some(
                json!({"reason":"SIDE_POLICY_VIOLATION","retryable":false,"outcome":{"kind":"rejected"},"recovery":{"kind":"none"}}),
            ),
        };
    }
    let data = match &error {
        Error::Exhausted(reason)
            if reason.starts_with("task hot-state capacity")
                || reason.starts_with("task preparation capacity") =>
        {
            Some(
                json!({"reason":"taskHotStateCapacity","resource":"taskHotState","recovery":"settleOrCancelExistingWork","retryable":false}),
            )
        }
        Error::Storage(reason) if reason.contains("Task persistence requires restart") => Some(
            json!({"reason":"taskStorageRecoveryRequired","resource":"taskStorage","recovery":"restartCore","retryable":false}),
        ),
        _ => None,
    };
    let code = match &error {
        Error::Invalid(_) => -32602,
        Error::NotFound => -32004,
        Error::Conflict => -32009,
        Error::Exhausted(_) => -32001,
        Error::Closed => -32000,
        Error::Storage(_)
        | Error::OperationOutcome(_)
        | Error::Rejected(_)
        | Error::HistoryRead { .. } => -32603,
    };
    RpcError {
        code,
        message: error.to_string(),
        data,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Initialize {
    client_info: ClientInfo,
    capabilities: Option<Capabilities>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClientInfo {
    name: String,
    version: String,
    #[serde(rename = "title")]
    _title: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Capabilities {
    opt_out_notification_methods: Option<Vec<String>>,
    #[serde(default, rename = "experimentalApi")]
    experimental_api: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThreadStart {
    #[serde(default)]
    dynamic_tools: Vec<areal_protocol::ToolDefinition>,
    cwd: Option<String>,
    model: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThreadId {
    thread_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThreadRead {
    thread_id: String,
    #[serde(default)]
    include_turns: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThreadList {
    cursor: Option<String>,
    limit: Option<usize>,
    parent_thread_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConversationList {
    view: Option<String>,
    source_thread_id: Option<String>,
    include_archived: Option<bool>,
    limit: Option<usize>,
    cursor: Option<String>,
}
#[derive(serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConversationCursor {
    filter: String,
    created_at: i64,
    id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelList {}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TurnStart {
    thread_id: String,
    input: Vec<Input>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Steer {
    request_id: Option<String>,
    thread_id: String,
    expected_turn_id: String,
    input: Vec<Input>,
}
pub fn local_address(value: &str) -> anyhow::Result<SocketAddr> {
    let address: SocketAddr = value.parse()?;
    anyhow::ensure!(address.ip().is_loopback(), "listener must bind to loopback");
    Ok(address)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn desktop_registered_methods_have_dispatch_routes() {
        let dir = tempfile::tempdir().unwrap();
        let model =
            areal_engine::model::ChatModel::new("http://127.0.0.1:9".into(), "unused".into(), None)
                .unwrap();
        let engine =
            Engine::open(dir.path(), Arc::new(model), areal_engine::Limits::default()).unwrap();
        let (tx, _rx) = mpsc::channel(1);
        let stop = CancellationToken::new();
        let mut conn = Connection {
            configuration: None,
            principal: auth::Principal::embedded(),
            tool_host: dynamic_tools::ToolHost::new(tx.clone(), stop.clone()),
            initialized: true,
            experimental_api: false,
            ready: true,
            subscriptions: HashMap::new(),
            suppressed: HashSet::new(),
            tx,
            stop,
            tasks: TaskTracker::new(),
            delivery: Arc::new(Mutex::new(())),
            rpc_permits: Arc::new(tokio::sync::Semaphore::new(16)),
        };
        let mut seen = HashSet::new();
        for &method in desktop::METHODS {
            assert!(seen.insert(method), "duplicate registered method: {method}");
            // 非对象参数在读取或变更状态前被拒绝；缺失路由则返回 -32601。
            // 经连接层调用，同时覆盖由该层单独接管的 areal/thread/start。
            let error = conn
                .dispatch(&engine, method, Value::Null)
                .await
                .unwrap_err();
            assert_eq!(
                error.code, -32602,
                "registered method has no parameter route: {method}"
            );
        }
        assert!(engine.list(None, 100, None).await.unwrap().0.is_empty());
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn slow_subscription_closes_connection_instead_of_dropping_events() {
        let (tx, _unread) = mpsc::channel(1);
        let stop = CancellationToken::new();
        let mut conn = Connection {
            configuration: None,
            principal: auth::Principal::embedded(),
            tool_host: dynamic_tools::ToolHost::new(tx.clone(), stop.clone()),
            initialized: true,
            experimental_api: false,
            ready: true,
            subscriptions: HashMap::new(),
            suppressed: HashSet::new(),
            tx,
            stop: stop.clone(),
            tasks: TaskTracker::new(),
            delivery: Arc::new(Mutex::new(())),
            rpc_permits: Arc::new(tokio::sync::Semaphore::new(16)),
        };
        let (events, receiver) = broadcast::channel(8);
        conn.forward("test", receiver);
        events
            .send(json!({"method":"item/agentMessage/delta","params":{"delta":"first"}}))
            .unwrap();
        events
            .send(json!({"method":"item/agentMessage/delta","params":{"delta":"second"}}))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), stop.cancelled())
            .await
            .unwrap();
        conn.tasks.close();
        conn.tasks.wait().await;
    }

    #[tokio::test]
    async fn subscription_limit_rejection_does_not_create_an_orphan_thread() {
        let dir = tempfile::tempdir().unwrap();
        let model =
            areal_engine::model::ChatModel::new("http://127.0.0.1:9".into(), "unused".into(), None)
                .unwrap();
        let engine =
            Engine::open(dir.path(), Arc::new(model), areal_engine::Limits::default()).unwrap();
        let (tx, _rx) = mpsc::channel(1);
        let stop = CancellationToken::new();
        let mut conn = Connection {
            configuration: None,
            principal: auth::Principal::embedded(),
            tool_host: dynamic_tools::ToolHost::new(tx.clone(), stop.clone()),
            initialized: true,
            experimental_api: false,
            ready: true,
            subscriptions: (0..128)
                .map(|n| (n.to_string(), CancellationToken::new()))
                .collect(),
            suppressed: HashSet::new(),
            tx,
            stop,
            tasks: TaskTracker::new(),
            delivery: Arc::new(Mutex::new(())),
            rpc_permits: Arc::new(tokio::sync::Semaphore::new(16)),
        };
        assert_eq!(
            conn.dispatch(&engine, "thread/start", json!({}))
                .await
                .unwrap_err()
                .code,
            -32001
        );
        assert!(engine.list(None, 100, None).await.unwrap().0.is_empty());
        engine.shutdown().await;
    }
}

#[cfg(test)]
mod rpc_isolation_tests;

// Steer can wait for hook elicitation; it needs no mutable Connection state.
async fn steer_request(
    engine: &Arc<Engine>,
    identity: &str,
    params: Value,
) -> Result<Value, RpcError> {
    let p: Steer = parse(params)?;
    if let Some(request) = p.request_id {
        let parameters =
            json!({"threadId":p.thread_id,"expectedTurnId":p.expected_turn_id,"input":p.input});
        let reply = engine
            .management_submission(
                identity.to_owned(),
                request,
                "turn/steer".into(),
                parameters,
                move |engine| async move {
                    match engine
                        .steer(&p.thread_id, &p.expected_turn_id, p.input)
                        .await
                    {
                        Ok(()) => json!({"result":{"turnId":p.expected_turn_id}}),
                        Err(error) => json!({"error":map_error(error)}),
                    }
                },
            )
            .await
            .map_err(map_error)?;
        if let Some(error) = reply.get("error") {
            return Err(RpcError {
                code: error["code"].as_i64().unwrap_or(-32602),
                message: error["message"].as_str().unwrap_or("steer rejected").into(),
                data: error.get("data").cloned(),
            });
        }
        return Ok(reply["result"].clone());
    }
    engine
        .steer(&p.thread_id, &p.expected_turn_id, p.input)
        .await
        .map_err(map_error)?;
    Ok(json!({"turnId":p.expected_turn_id}))
}
