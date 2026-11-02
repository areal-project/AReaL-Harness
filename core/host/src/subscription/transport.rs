use super::{
    AccessToken, SourceSubscription, adapters,
    network::{Failure, Result, bounded, now_ms, response_error},
};
use bytes::Bytes;
use futures_util::StreamExt;
use http_body_util::{BodyExt, Full, StreamBody, combinators::UnsyncBoxBody};
use hyper::{
    Request, Response, StatusCode,
    body::{Frame, Incoming},
    service::service_fn,
};
use hyper_util::rt::TokioIo;
use reqwest::header::HeaderMap;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    convert::Infallible,
    rc::Rc,
    time::Duration,
};
use subtle::ConstantTimeEq;
use tokio::{
    net::TcpListener,
    sync::{mpsc, watch},
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub(super) struct Catalog {
    pub(super) models: Vec<Value>,
    hints: BTreeMap<String, Value>,
    pub(super) expires: u64,
    loading: Option<watch::Receiver<Option<Result<Vec<Value>>>>>,
}
fn parse_catalog(data: Value, access: &str) -> Result<Catalog> {
    let models = data["models"]
        .as_array()
        .ok_or_else(|| Failure::new("invalid_response", "catalog"))?;
    let mut seen = BTreeSet::new();
    let mut catalog = Catalog::default();
    for model in models {
        let Some(slug) = model["slug"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 256 && !s.contains(access))
        else {
            continue;
        };
        if model["visibility"] != "list" || !seen.insert(slug.to_owned()) {
            continue;
        }
        let mut value = json!({"id":slug,"name":model["display_name"].as_str().filter(|s|s.len()<=256 && !s.contains(access)).unwrap_or(slug),"source":"account"});
        if let Some(levels) = model["supported_reasoning_levels"].as_array() {
            let mut seen = BTreeSet::new();
            value["reasoningEffortOptions"] = json!(
                levels
                    .iter()
                    .filter_map(|level| level["effort"].as_str())
                    .filter(|effort| matches!(
                        *effort,
                        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
                    ) && seen.insert((*effort).to_owned()))
                    .collect::<Vec<_>>()
            );
        }
        if let Some(size) = model["context_window"]
            .as_u64()
            .filter(|size| *size > 0 && *size <= 2_000_000)
        {
            value["parameters"] = json!({"contextWindowTokens":size});
        }
        catalog.hints.insert(slug.into(), adapters::hints(model));
        catalog.models.push(value);
        if catalog.models.len() == 256 {
            break;
        }
    }
    catalog.expires = now_ms() + 30_000;
    Ok(catalog)
}
impl SourceSubscription {
    pub(super) async fn discover(self: &Rc<Self>, force: bool) -> Result<Vec<Value>> {
        let (epoch, cancel) = self.epoch();
        self.check_epoch(epoch)?;
        if !force && self.state.borrow().catalog.expires > now_ms() {
            return Ok(self.state.borrow().catalog.models.clone());
        }
        let loading = self.state.borrow().catalog.loading.clone();
        let mut receiver = if let Some(receiver) = loading {
            receiver
        } else {
            let (sender, receiver) = watch::channel(None);
            self.state.borrow_mut().catalog.loading = Some(receiver.clone());
            let source = self.clone();
            let lifetime = cancel.clone();
            self.track(tokio::task::spawn_local(async move {
                let result=tokio::select! {_=lifetime.cancelled()=>Err(Failure::new("account_changed","catalog")), _=source.lifetime.cancelled()=>Err(Failure::new("cancelled","catalog")), result=source.load_catalog(epoch)=>result};
                if source.state.borrow().epoch==epoch {
                    let mut state=source.state.borrow_mut();
                    state.catalog.loading=None;
                    if let Err(failure)=&result {state.catalog=Catalog::default();state.failure=Some(failure.clone());}
                }
                sender.send_replace(Some(result));
            }));
            receiver
        };
        loop {
            if let Some(result) = receiver.borrow().clone() {
                self.check_epoch(epoch)?;
                return result;
            }
            tokio::select! {_=cancel.cancelled()=>return Err(Failure::new("account_changed","catalog")), changed=receiver.changed()=>if changed.is_err() {return Err(Failure::new("cancelled","catalog"));}}
        }
    }
    async fn load_catalog(self: &Rc<Self>, epoch: u64) -> Result<Vec<Value>> {
        let (_, cancel) = self.epoch();
        let mut access = self.access_token(&cancel, false, None).await?;
        let network = self.network.borrow().clone();
        let send = |access: &AccessToken| {
            network
                .request(
                    reqwest::Method::GET,
                    "https://api.openai.com/v1/models",
                    "catalog",
                )
                .map(|request| {
                    request
                        .bearer_auth(&access.0)
                        .timeout(Duration::from_secs(30))
                })
        };
        let mut response = send(&access)?
            .send()
            .await
            .map_err(|_| Failure::new("network_error", "catalog"))?;
        if response.status() == 401 {
            let failure = response_error(response, "catalog", &[&access.0]).await;
            if !matches!(failure.code.as_str(), "invalid_token" | "token_expired") {
                return Err(failure);
            }
            access = self.access_token(&cancel, true, Some(access.0)).await?;
            response = send(&access)?
                .send()
                .await
                .map_err(|_| Failure::new("network_error", "catalog"))?;
        }
        if !response.status().is_success() {
            return Err(response_error(response, "catalog", &[&access.0]).await);
        }
        let data = serde_json::from_slice(&bounded(response, 1_048_576, "catalog").await?)
            .map_err(|_| Failure::new("invalid_response", "catalog"))?;
        let catalog = parse_catalog(data, &access.0)?;
        self.check_epoch(epoch)?;
        let models = catalog.models.clone();
        self.state.borrow_mut().catalog = catalog;
        if self
            .state
            .borrow()
            .failure
            .as_ref()
            .is_some_and(|f| f.phase == "catalog")
        {
            self.state.borrow_mut().failure = None;
        }
        Ok(models)
    }
}

type Body = UnsyncBoxBody<Bytes, Failure>;
fn full(status: u16, value: Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(
            Full::new(Bytes::from(serde_json::to_vec(&value).unwrap()))
                .map_err(|never: Infallible| match never {})
                .boxed_unsync(),
        )
        .unwrap()
}
fn deny(status: u16, message: &str) -> Response<Body> {
    full(status, json!({"error":{"message":message}}))
}
fn failed(status: u16, failure: &Failure) -> Response<Body> {
    let mut diagnostic = failure.diagnostic();
    diagnostic["message"] = json!(failure.message());
    full(status, json!({"error":diagnostic}))
}

#[derive(Clone)]
pub(super) struct Listener {
    pub(super) endpoint: String,
    pub(super) port: u16,
}
pub(super) async fn listen(source: Rc<SourceSubscription>) -> Result<Listener> {
    let (revision, mut saved) = source
        .migration
        .vault
        .subscription_transport(&source.source, &source.migration)
        .map_err(Failure::storage)?;
    let token = saved["token"]
        .as_str()
        .filter(|token| !token.is_empty())
        .ok_or_else(|| Failure::new("credential_invalid", "transport"))?
        .to_owned();
    let port = saved["port"]
        .as_u64()
        .filter(|port| *port <= u16::MAX as u64)
        .ok_or_else(|| Failure::new("credential_invalid", "transport"))? as u16;
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .map_err(|_| Failure::new("network_error", "transport"))?;
    let port = listener.local_addr().unwrap().port();
    saved["port"] = json!(port);
    let receipt = source
        .migration
        .vault
        .replace_subscription_transport(
            &source.source,
            &uuid::Uuid::new_v4().to_string(),
            revision,
            saved,
            &source.migration,
        )
        .map_err(Failure::storage)?;
    if receipt["state"] != "completed" {
        return Err(Failure::new("storage_locked", "transport"));
    }
    let owner = source.clone();
    source.track(tokio::task::spawn_local(async move {
        loop {
            let connection=tokio::select! {_=owner.lifetime.cancelled()=>break, result=listener.accept()=>result};
            let Ok((socket,_))=connection else {break;};
            let account=owner.clone();let connection_owner=owner.clone();let token=token.clone();
            owner.track(tokio::task::spawn_local(async move {
                let service=service_fn(move |request|handle(account.clone(),token.clone(),request));
                tokio::select! {_=connection_owner.lifetime.cancelled()=>{}, _=hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(socket),service)=>{}}
            }));
        }
    }));
    Ok(Listener {
        endpoint: format!("http://127.0.0.1:{port}/responses"),
        port,
    })
}
async fn handle(
    source: Rc<SourceSubscription>,
    token: String,
    request: Request<Incoming>,
) -> std::result::Result<Response<Body>, Infallible> {
    let expected = format!("Bearer {token}");
    let actual = request
        .headers()
        .get("authorization")
        .map(|h| h.as_bytes())
        .unwrap_or_default();
    if request.method() != hyper::Method::POST
        || request.uri().to_string() != "/responses"
        || request.headers().contains_key("origin")
        || actual.len() != expected.len()
        || !bool::from(actual.ct_eq(expected.as_bytes()))
    {
        return Ok(deny(403, "Subscription transport denied"));
    }
    let (epoch, epoch_cancel) = source.epoch();
    let cancel = CancellationToken::new();
    let guard = cancel.clone().drop_guard();
    let headers = request.headers().clone();
    let result = tokio::select! {_=epoch_cancel.cancelled()=>Err(Failure::new("account_changed","transport")), _=source.lifetime.cancelled()=>Err(Failure::new("cancelled","transport")), result=forward(source.clone(),request,&headers,epoch,&cancel)=>result};
    let response = match result {
        Ok(response) => response,
        Err(failure) => {
            if source.state.borrow().epoch == epoch
                && !matches!(failure.code.as_str(), "cancelled" | "account_changed")
            {
                source.state.borrow_mut().failure = Some(failure.clone());
            }
            failed(
                if failure.state() == "reauth_required" {
                    401
                } else if failure.state() == "storage_locked" {
                    503
                } else {
                    502
                },
                &failure,
            )
        }
    };
    guard.disarm();
    Ok(response)
}
async fn forward(
    source: Rc<SourceSubscription>,
    request: Request<Incoming>,
    headers: &HeaderMap,
    epoch: u64,
    cancel: &CancellationToken,
) -> Result<Response<Body>> {
    let mut incoming = request.into_body();
    let mut raw = Vec::new();
    while let Some(frame) = incoming.frame().await {
        let frame = frame.map_err(|_| Failure::new("cancelled", "transport"))?;
        if let Ok(bytes) = frame.into_data() {
            if raw.len().saturating_add(bytes.len()) > 16 * 1024 * 1024 {
                return Ok(deny(413, "Request too large"));
            }
            raw.extend_from_slice(&bytes);
        }
    }
    let raw: Value = match serde_json::from_slice(&raw) {
        Ok(value) => value,
        Err(_) => return Ok(deny(400, "Invalid subscription request")),
    };
    let model = raw["model"].as_str().unwrap_or("");
    let hints = source
        .state
        .borrow()
        .catalog
        .hints
        .get(model)
        .cloned()
        .unwrap_or(json!({}));
    let body = match adapters::encode(&raw, &hints) {
        Ok(value) => value,
        Err(_) => return Ok(deny(400, "Invalid subscription request")),
    };
    if !source
        .state
        .borrow()
        .catalog
        .models
        .iter()
        .any(|m| m["id"] == model)
    {
        return Ok(deny(400, "Unknown subscription model"));
    }
    let access = source.access_token(cancel, false, None).await?;
    source.check_epoch(epoch)?;
    let affinity = source
        .state
        .borrow_mut()
        .affinity
        .begin(headers, model, epoch, now_ms());
    let network = source.network.borrow().clone();
    let mut upstream = network
        .request(
            reqwest::Method::POST,
            "https://api.openai.com/v1/responses",
            "transport",
        )?
        .bearer_auth(&access.0)
        .header("content-type", "application/json")
        .header("accept", "text/event-stream")
        .json(&body);
    if let Some(affinity) = &affinity {
        upstream = upstream.headers(affinity.headers.clone());
    }
    // 推理请求受理情况没有权威回执，401 也只允许发送这一次。
    let response = upstream
        .send()
        .await
        .map_err(|_| Failure::new("network_error", "transport"))?;
    source.check_epoch(epoch)?;
    if let Some(affinity) = &affinity {
        source.state.borrow_mut().affinity.capture(
            affinity,
            response.headers(),
            response.status().is_success(),
        );
    }
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let failure = response_error(response, "admission", &[&access.0]).await;
        source.state.borrow_mut().failure = Some(failure.clone());
        return Ok(failed(status, &failure));
    }
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .filter(|v| !v.is_empty());
    if content_type.is_some_and(|v| {
        !v.split(';')
            .next()
            .unwrap_or("")
            .trim()
            .eq_ignore_ascii_case("text/event-stream")
    }) {
        return Err(Failure::new("invalid_response", "transport"));
    }
    let needs_proof = content_type.is_none();
    let mut stream = response.bytes_stream();
    let mut prefix = Vec::new();
    if needs_proof {
        let mut inspected = Vec::new();
        loop {
            let chunk = stream
                .next()
                .await
                .ok_or_else(|| Failure::new("invalid_response", "transport"))?
                .map_err(|_| Failure::new("network_error", "transport"))?;
            inspected.extend_from_slice(&chunk[..chunk.len().min(65536 - inspected.len())]);
            prefix.push(chunk);
            match proof(&inspected) {
                Some(true) => break,
                Some(false) => return Err(Failure::new("invalid_response", "transport")),
                None => {}
            }
            if inspected.len() >= 65536 {
                return Err(Failure::new("invalid_response", "transport"));
            }
        }
    }
    source.check_epoch(epoch)?;
    source.state.borrow_mut().failure = None;
    let (sender, receiver) = mpsc::channel::<Result<Frame<Bytes>>>(8);
    let (_, epoch_cancel) = source.epoch();
    let owner = source.clone();
    let cancelled = cancel.clone();
    source.track(tokio::task::spawn_local(async move {
        let work=async {
            for bytes in prefix {sender.send(Ok(Frame::data(bytes))).await.map_err(|_|())?;}
            while let Some(bytes)=stream.next().await {
                match bytes {
                    Ok(bytes)=>sender.send(Ok(Frame::data(bytes))).await.map_err(|_|())?,
                    Err(_)=>{let _=sender.send(Err(Failure::new("network_error","transport"))).await;break;}
                }
            }
            Ok::<_,()>(())
        };
        tokio::select! {_=owner.lifetime.cancelled()=>{},_=epoch_cancel.cancelled()=>{},_=cancelled.cancelled()=>{},_=sender.closed()=>{},_=work=>{}}
    }));
    let (_, epoch_cancel) = source.epoch();
    let lifetime = source.lifetime.clone();
    let output = futures_util::stream::unfold(
        (receiver, epoch_cancel, lifetime),
        |(mut receiver, epoch_cancel, lifetime)| async {
            let item = tokio::select! {
                biased;
                _ = epoch_cancel.cancelled() => Some(Err(Failure::new("account_changed", "transport"))),
                _ = lifetime.cancelled() => Some(Err(Failure::new("cancelled", "transport"))),
                item = receiver.recv() => item,
            };
            item.map(|item| (item, (receiver, epoch_cancel, lifetime)))
        },
    );
    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-store");
    if !raw["max_output_tokens"].is_null() {
        response = response.header(
            "x-areal-provider-adjustments",
            "max_output_tokens:core_budget_only",
        );
    }
    Ok(response
        .body(StreamBody::new(output).boxed_unsync())
        .unwrap())
}
fn proof(bytes: &[u8]) -> Option<bool> {
    for line in bytes
        .split_inclusive(|b| *b == b'\n')
        .filter(|line| line.ends_with(b"\n"))
    {
        let line = line.strip_suffix(b"\n").unwrap();
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if let Some(event) = line.strip_prefix(b"event:") {
            let event = event.strip_prefix(b" ").unwrap_or(event);
            if event == b"error"
                || event.strip_prefix(b"response.").is_some_and(|suffix| {
                    !suffix.is_empty()
                        && suffix
                            .iter()
                            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(b))
                })
            {
                return Some(true);
            }
        }
        if let Some(data) = line.strip_prefix(b"data:") {
            return Some(
                serde_json::from_slice::<Value>(data)
                    .ok()
                    .and_then(|v| {
                        v["type"]
                            .as_str()
                            .map(|s| s == "error" || s.starts_with("response."))
                    })
                    .unwrap_or(false),
            );
        }
    }
    None
}

#[test]
fn original_js_catalog_oracle_and_stream_proof_bounds() {
    let corpus: Value = serde_json::from_str(include_str!("fixtures/catalog.json")).unwrap();
    let catalog =
        parse_catalog(corpus["input"].clone(), corpus["access"].as_str().unwrap()).unwrap();
    assert_eq!(catalog.models, corpus["output"].as_array().unwrap().clone());
    assert_eq!(
        serde_json::to_value(catalog.hints).unwrap(),
        corpus["hints"]
    );
    assert_eq!(proof(b"event: response.output_text.delta\r\n"), Some(true));
    assert_eq!(
        proof(b"data: {\"type\":\"response.completed\"}\n"),
        Some(true)
    );
    assert_eq!(proof(b"data: [DONE]\n"), Some(false));
    assert_eq!(proof(b"event: response.created"), None);
}
