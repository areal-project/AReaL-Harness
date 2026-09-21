pub mod auth;
mod desktop;
mod dynamic_tools;
mod processes;
mod workgroups;
use areal_engine::{Engine, Error};
use areal_protocol::{Input, MAX_FRAME_BYTES, RpcError, response};
use axum::{
    Router,
    body::Body,
    extract::{
        DefaultBodyLimit, Extension, Path, Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
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
    configured_router(engine, None, None)
}
fn configured_router(
    engine: Arc<Engine>,
    browser_origin: Option<String>,
    authentication: Option<auth::Authentication>,
) -> Router {
    Router::new()
        .route("/", get(upgrade))
        .route("/ui", get(|| async {
            ([("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"), ("x-content-type-options", "nosniff"), ("referrer-policy", "no-referrer")], Html(include_str!("../../../clients/web/index.html")))
        }))
        .route("/ui/app.js", get(|| async { ([("content-type", "text/javascript; charset=utf-8"), ("x-content-type-options", "nosniff")], include_str!("../../../clients/web/app.js")) }))
        .route("/ui/style.css", get(|| async { ([("content-type", "text/css; charset=utf-8"), ("x-content-type-options", "nosniff")], include_str!("../../../clients/web/style.css")) }))
        .route("/areal/auth/session", axum::routing::post(auth_session))
        .route("/healthz", get(|| async { "ok" }))
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
        .with_state(engine)
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
    Extension(authentication): Extension<Option<auth::Authentication>>,
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
    Extension(authentication): Extension<Option<auth::Authentication>>,
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
    anyhow::ensure!(
        listener.local_addr()?.ip().is_loopback(),
        "Core listener must bind to loopback"
    );
    let origin = format!("http://{}", listener.local_addr()?);
    axum::serve(
        listener,
        configured_router(engine, Some(origin), authentication),
    )
    .with_graceful_shutdown(stop.cancelled_owned())
    .await?;
    Ok(())
}

async fn auth_session(
    Extension(authentication): Extension<Option<auth::Authentication>>,
    Extension(browser_origin): Extension<Option<String>>,
    headers: HeaderMap,
) -> Response {
    if headers
        .get("origin")
        .is_some_and(|o| o.to_str().ok() != browser_origin.as_deref())
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    // 仅接受显式 Bearer 登录，不能利用现有 Cookie 重签会话。
    if !headers.contains_key("authorization") {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(principal) = authentication
        .as_ref()
        .and_then(|auth| auth.authenticate(&headers))
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    (
        [
            (
                header::SET_COOKIE,
                format!(
                    "areal_session={}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600",
                    principal.token
                ),
            ),
            (header::CACHE_CONTROL, "no-store".into()),
        ],
        StatusCode::NO_CONTENT,
    )
        .into_response()
}

async fn upgrade(
    State(engine): State<Arc<Engine>>,
    Extension(browser_origin): Extension<Option<String>>,
    Extension(authentication): Extension<Option<auth::Authentication>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    if let Some(origin) = headers.get("origin")
        && (origin.to_str().ok() != browser_origin.as_deref() || browser_origin.is_none())
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let principal = match authentication {
        Some(authentication) => match authentication.authenticate(&headers) {
            Some(principal) => principal,
            None => return StatusCode::UNAUTHORIZED.into_response(),
        },
        None => auth::Principal::embedded(),
    };
    ws.max_message_size(MAX_FRAME_BYTES)
        .max_frame_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| connection(socket, engine, principal))
        .into_response()
}

struct Connection {
    principal: Arc<auth::Principal>,
    tool_host: Arc<dynamic_tools::ToolHost>,
    initialized: bool,
    ready: bool,
    subscriptions: HashMap<String, CancellationToken>,
    suppressed: HashSet<String>,
    tx: mpsc::Sender<Value>,
    stop: CancellationToken,
    tasks: TaskTracker,
    delivery: Arc<Mutex<()>>,
    rpc_permits: Arc<tokio::sync::Semaphore>,
}

async fn connection(socket: WebSocket, engine: Arc<Engine>, principal: Arc<auth::Principal>) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Value>(256);
    let stop = CancellationToken::new();
    let writer_stop = stop.clone();
    let writer = tokio::spawn(async move {
        loop {
            let value = tokio::select! { biased; _ = writer_stop.cancelled() => break, value = rx.recv() => value };
            let Some(value) = value else {
                break;
            };
            match tokio::time::timeout(
                Duration::from_secs(5),
                sink.send(Message::Text(value.to_string().into())),
            )
            .await
            {
                Ok(Ok(())) => {}
                _ => {
                    writer_stop.cancel();
                    break;
                }
            }
        }
        let _ = tokio::time::timeout(Duration::from_secs(1), sink.close()).await;
    });
    let mut conn = Connection {
        tool_host: dynamic_tools::ToolHost::authenticated(
            tx.clone(),
            stop.clone(),
            principal.id.clone(),
        ),
        principal,
        initialized: false,
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
        let message = tokio::select! { biased; _ = stop.cancelled() => break, message = stream.next() => message };
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
        if !conn.principal.allows(auth::permission(method))
            || ["threadId", "parentThreadId"].iter().any(|key| {
                params
                    .get(key)
                    .and_then(Value::as_str)
                    .is_some_and(|thread| !conn.principal.sees(thread))
            })
            || (conn.principal.thread_ids.is_some()
                && (method == "thread/start"
                    || method == "areal/thread/start"
                    || method.starts_with("areal/workgroup/")
                    || method.starts_with("areal/workflow/start")))
        {
            conn.send(response(
                id.unwrap(),
                Err(RpcError {
                    code: -32003,
                    message: "permission denied".into(),
                }),
            ));
            continue;
        }
        // Long waits and snapshot creation must not block cancellation/steering
        // on this same WebSocket. Bound independently from subscriptions.
        if conn.ready
            && (method.starts_with("areal/workgroup/")
                || processes::METHODS.contains(&method)
                || method == "areal/provider/probe"
                || method.starts_with("areal/workflow/")
                || method.starts_with("areal/mcp/")
                || method.starts_with("areal/server/")
                || method == "areal/agent/wait"
                || method == "areal/context/compact")
        {
            let control = matches!(
                method,
                "areal/workgroup/cancel"
                    | "areal/workgroup/read"
                    | "areal/workgroup/list"
                    | "areal/workgroup/policy"
                    | "areal/process/terminate"
                    | "areal/process/get"
                    | "areal/process/list"
                    | "areal/server/status"
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
            let engine = engine.clone();
            let tx = conn.tx.clone();
            let stop = conn.stop.clone();
            let id = id.unwrap();
            conn.tasks.spawn(async move {
                let _permit = permit;
                let result = tokio::select! { biased; _=stop.cancelled()=>return,
                value=async { if processes::METHODS.contains(&method.as_str()) { processes::dispatch(&engine,&identity,&method,params).await } else if desktop::METHODS.contains(&method.as_str()) { desktop::dispatch(&engine,&identity,&method,params).await } else { workgroups::dispatch(engine,&identity,&method,params).await } }=>value };
                if tx.try_send(response(id, result)).is_err() {
                    stop.cancel();
                }
            });
            continue;
        }
        let delivery = conn.delivery.clone();
        let _delivery = delivery.lock().await;
        let result = conn
            .dispatch(&engine, method, params)
            .instrument(info_span!(
                "rpc.request",
                rpc.system = "jsonrpc",
                rpc.method = method
            ))
            .await;
        conn.send(response(id.unwrap(), result));
    }
    stop.cancel();
    conn.tasks.close();
    conn.tasks.wait().await;
    let _ = writer.await;
}

impl Connection {
    fn send(&self, value: Value) {
        if value["method"]
            .as_str()
            .is_some_and(|m| self.suppressed.contains(m))
        {
            return;
        }
        // 丢失协议消息后不能继续伪装为完整流；关闭连接，由客户端重新读取历史。
        if self.tx.try_send(value).is_err() {
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
            });
        }
        let events = engine.subscribe(id).await.map_err(map_error)?;
        self.forward(id, events);
        Ok(())
    }
    fn forward(&mut self, id: &str, mut events: broadcast::Receiver<Value>) {
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
                        if event["method"].as_str().is_some_and(|m| suppressed.contains(m)) { continue; }
                        let _delivery = delivery.lock().await;
                        if subscription.is_cancelled() { break; }
                        if tx.try_send(event).is_err() { stop.cancel(); break; }
                    }
                    Err(_) => { stop.cancel(); break; }
                }
            }
        });
    }
    async fn dispatch(
        &mut self,
        engine: &Arc<Engine>,
        method: &str,
        params: Value,
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
            return Err(RpcError::invalid("Not initialized"));
        }
        if desktop::METHODS.contains(&method) && method != "areal/thread/start" {
            if matches!(method, "areal/turn/start" | "areal/turn/enqueue") {
                let p: areal_protocol::desktop::TurnStart = parse(params.clone())?;
                self.subscribe(engine, &p.thread_id).await?;
            }
            return desktop::dispatch(engine, &self.principal.id, method, params).await;
        }
        match method {
            "areal/thread/start" => {
                let p: areal_protocol::desktop::ThreadStart = parse(params)?;
                if self.subscriptions.len() >= 128 {
                    return Err(RpcError {
                        code: -32001,
                        message:
                            "subscription limit reached; unsubscribe before creating another thread"
                                .into(),
                    });
                }
                if !p.dynamic_tools.is_empty() && !self.principal.allows(auth::Permission::Tools) {
                    return Err(RpcError {
                        code: -32003,
                        message: "tool host permission required".into(),
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
                use areal_protocol::desktop::{API_VERSION, METHODS, NOTIFICATIONS};
                let p: areal_protocol::desktop::CapabilitiesRequest = parse(params)?;
                if p.api_version
                    .as_deref()
                    .is_some_and(|version| version != API_VERSION)
                {
                    return Err(RpcError::invalid("unsupported AReaL API version"));
                }
                let mut methods = METHODS.to_vec();
                methods.extend_from_slice(desktop::METHODS);
                if !engine.runtime_capabilities().is_null() {
                    methods.extend_from_slice(processes::METHODS);
                }
                if engine.workgroups().is_ok() {
                    methods.extend([
                        "areal/workgroup/policy",
                        "areal/workgroup/start",
                        "areal/workgroup/list",
                        "areal/workgroup/read",
                        "areal/workgroup/wait",
                        "areal/workgroup/cancel",
                        "areal/workgroup/revise",
                        "areal/workgroup/artifact",
                    ]);
                }
                Ok(json!({"apiVersion": API_VERSION, "methods": methods,
                    "notifications": NOTIFICATIONS, "serverRequests":["item/tool/call"],
                    "features":{"subscriptionRemoval":true,"atomicResume":true,
                        "dynamicTools":true,"mediaOutput":true,"durableSubmissionDeduplication":true,"profiles":true,"skills":true,"plans":true,"interactions":true,"queue":true,"providerConfiguration":true,"modelReset":true,"toolMedia":true,"blobUpload":true},
                    "limits":{"frameBytes":MAX_FRAME_BYTES,"subscriptions":128,"sendQueue":256,"threadEventWindow":128},
                    "runtime":engine.runtime_capabilities()}))
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
                let catalog = engine.model_catalog();
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
                    });
                }
                if !p.dynamic_tools.is_empty() && !self.principal.allows(auth::Permission::Tools) {
                    return Err(RpcError {
                        code: -32003,
                        message: "tool host permission required".into(),
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
                let p: ThreadId = parse(params)?;
                if !self.subscriptions.contains_key(&p.thread_id) && self.subscriptions.len() >= 128
                {
                    return Err(RpcError {
                        code: -32001,
                        message: "subscription limit reached".into(),
                    });
                }
                if self.principal.allows(auth::Permission::Tools) {
                    engine
                        .bind_tool_host(&p.thread_id, self.tool_host.clone())
                        .await
                        .map_err(map_error)?;
                }
                let (thread, events) = engine
                    .snapshot_and_subscribe(&p.thread_id)
                    .await
                    .map_err(map_error)?;
                self.forward(&p.thread_id, events);
                Ok(thread_result(engine, thread))
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
                data.retain(|thread| self.principal.sees(&thread.id));
                Ok(json!({"data":data,"nextCursor":cursor}))
            }
            "turn/start" => {
                let p: TurnStart = parse(params)?;
                self.subscribe(engine, &p.thread_id).await?;
                Ok(json!({"turn":engine.start(&p.thread_id,p.input).await.map_err(map_error)?}))
            }
            "turn/steer" => {
                let p: Steer = parse(params)?;
                engine
                    .steer(&p.thread_id, &p.expected_turn_id, p.input)
                    .await
                    .map_err(map_error)?;
                Ok(json!({"turnId":p.expected_turn_id}))
            }
            "turn/interrupt" => {
                let p: Interrupt = parse(params)?;
                engine
                    .interrupt(&p.thread_id, &p.turn_id)
                    .await
                    .map_err(map_error)?;
                Ok(json!({}))
            }
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
fn thread_result(engine: &Engine, thread: areal_protocol::Thread) -> Value {
    json!({"cwd":thread.cwd,"thread":thread,"model":engine.model_name(),"modelProvider":engine.model_provider(),
        "approvalPolicy":"never","approvalsReviewer":"user","sandbox":engine.sandbox(),"reasoningEffort":null})
}
fn parse<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, RpcError> {
    serde_json::from_value(value).map_err(|e| RpcError::invalid(e.to_string()))
}
fn map_error(error: Error) -> RpcError {
    let code = match &error {
        Error::Invalid(_) => -32602,
        Error::NotFound => -32004,
        Error::Conflict => -32009,
        Error::Exhausted(_) => -32001,
        Error::Closed => -32000,
        Error::Storage(_) => -32603,
    };
    RpcError {
        code,
        message: error.to_string(),
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
    _experimental_api: bool,
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
    thread_id: String,
    expected_turn_id: String,
    input: Vec<Input>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Interrupt {
    thread_id: String,
    turn_id: String,
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
    async fn slow_subscription_closes_connection_instead_of_dropping_events() {
        let (tx, _unread) = mpsc::channel(1);
        let stop = CancellationToken::new();
        let mut conn = Connection {
            principal: auth::Principal::embedded(),
            tool_host: dynamic_tools::ToolHost::new(tx.clone(), stop.clone()),
            initialized: true,
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
            principal: auth::Principal::embedded(),
            tool_host: dynamic_tools::ToolHost::new(tx.clone(), stop.clone()),
            initialized: true,
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
