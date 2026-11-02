#[path = "observer.rs"]
mod observer;
#[path = "overview.rs"]
mod overview;
#[path = "projection.rs"]
mod projection;
use super::wire;
use crate::server::{Host, gateway_owner};
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use hmac::{Hmac, Mac};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    rc::Rc,
    time::{Duration, Instant},
};

const METHODS: &[&str] = &[
    "host.describe",
    "project.list",
    "task.read",
    "attention.read",
    "interaction.respond",
    "command.read",
    "review.read",
    "session.open",
    "session.history",
    "session.body",
    "subscription.close",
    "work.list",
    "attention.list",
];

pub(crate) struct Session {
    pub(crate) host: Rc<Host>,
    pub(crate) peer: String,
    pub(crate) grant: Value,
    pub(crate) generation: String,
    pub(crate) connection: String,
    pub(crate) host_peer: String,
    transport: String,
    kind: gateway_owner::TransportKind,
    source_id: String,
    viewer: Option<observer::Viewer>,
    token_key: [u8; 32],
}
struct SessionSlot {
    host: Rc<Host>,
    peer: Option<String>,
    pending: bool,
    connection: Option<String>,
}
impl Drop for SessionSlot {
    fn drop(&mut self) {
        if self.pending {
            self.host
                .gateway
                .pending
                .set(self.host.gateway.pending.get() - 1);
        }
        if let Some(connection) = &self.connection {
            self.host.gateway.active.borrow_mut().remove(connection);
        }
        if let Some(peer) = &self.peer {
            let mut peers = self.host.gateway.peers.borrow_mut();
            if let Some(count) = peers.get_mut(peer) {
                *count -= 1;
                if *count == 0 {
                    peers.remove(peer);
                }
            }
        }
    }
}
struct RequestMessage {
    bytes: Vec<u8>,
    counters: std::sync::Arc<crate::gateway::relay::Counters>,
}
impl Drop for RequestMessage {
    fn drop(&mut self) {
        self.counters.release_receive(self.bytes.len());
    }
}
struct PairSlot {
    host: Rc<Host>,
    peer: String,
    id: String,
}
impl Drop for PairSlot {
    fn drop(&mut self) {
        if self
            .host
            .gateway
            .pairs
            .borrow()
            .get(&self.peer)
            .is_some_and(|pair| pair.id == self.id)
        {
            self.host.gateway.pairs.borrow_mut().remove(&self.peer);
        }
    }
}
fn exact(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|object| object.keys().all(|key| keys.contains(&key.as_str())))
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .context("INVALID_PARAMS")
}
fn fail(code: &str) -> anyhow::Error {
    anyhow::anyhow!("{code}")
}
impl Session {
    pub(crate) async fn run<S>(
        host: Rc<Host>,
        stream: S,
        identity: Rc<wire::Identity>,
        admission: gateway_owner::Admission,
    ) -> Result<()>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        ensure!(
            host.gateway.pending.get() < 8
                && host.gateway.pending.get() + host.gateway.active.borrow().len() < 16,
            "LIMIT_EXCEEDED"
        );
        host.gateway.pending.set(host.gateway.pending.get() + 1);
        let mut slot = SessionSlot {
            host: host.clone(),
            peer: None,
            pending: true,
            connection: None,
        };
        let channel =
            wire::authenticate(stream, &identity, None, wire::WireLimits::default()).await?;
        let peer = channel.peer.to_string();
        let count = host.gateway.peers.borrow().get(&peer).copied().unwrap_or(0);
        ensure!(count < 2, "LIMIT_EXCEEDED");
        host.gateway
            .peers
            .borrow_mut()
            .insert(peer.clone(), count + 1);
        slot.peer = Some(peer.clone());
        let counters = host.gateway.counters.clone();
        let limits = channel.limits;
        let (mut reader, writer) = futures_util::io::AsyncReadExt::split(channel.stream);
        let (incoming, requests) = tokio::sync::mpsc::channel(1);
        // 读取所有者贯穿 hello、等待配对与通知派发，任何控制事件都不能截断正在读取的消息。
        let reading = async move {
            while let Some(bytes) = wire::read_json(&mut reader, limits).await? {
                ensure!(counters.reserve_receive(bytes.len()), "LIMIT_EXCEEDED");
                let message = RequestMessage {
                    bytes,
                    counters: counters.clone(),
                };
                if incoming.send(message).await.is_err() {
                    return Ok::<(), anyhow::Error>(());
                }
            }
            Ok(())
        };
        let app = Self::app(
            host, identity, peer, limits, requests, writer, &mut slot, admission,
        );
        tokio::pin!(reading, app);
        tokio::select! {
            result = &mut app => result,
            result = &mut reading => { let application = app.await; result?; application }
        }
    }
    async fn app<W>(
        host: Rc<Host>,
        identity: Rc<wire::Identity>,
        peer: String,
        limits: wire::WireLimits,
        mut requests: tokio::sync::mpsc::Receiver<RequestMessage>,
        mut writer: W,
        slot: &mut SessionSlot,
        admission: gateway_owner::Admission,
    ) -> Result<()>
    where
        W: AsyncWrite + Unpin,
    {
        let first = tokio::time::timeout(Duration::from_secs(15), requests.recv())
            .await?
            .context("hello missing")?;
        let hello: Value = serde_json::from_slice(&first.bytes)?;
        drop(first);
        let valid = exact(
            &hello,
            &[
                "method",
                "apiVersion",
                "clientVersion",
                "displayName",
                "clientKind",
                "inviteSecret",
            ],
        ) && hello["method"] == "hello"
            && hello["displayName"]
                .as_str()
                .is_some_and(|name| !name.trim().is_empty() && name.chars().count() <= 80)
            && hello["clientVersion"]
                .as_str()
                .is_some_and(|version| version.chars().count() <= 80)
            && hello
                .get("clientKind")
                .is_none_or(|kind| matches!(kind.as_str(), Some("web" | "ios" | "android")));
        if !valid {
            return Self::reject_hello(&mut writer, limits, "INVALID_PARAMS").await;
        }
        if hello["apiVersion"] != "areal.remote.v2" {
            return Self::reject_hello(&mut writer, limits, "PROTOCOL_UNSUPPORTED").await;
        }
        let mut config = host.remote.snapshot(&host.migration)?;
        ensure!(
            gateway_owner::transport_key(&config["config"], admission.kind) == admission.transport
                && host.gateway.current(&admission.generation),
            "RESYNC_REQUIRED"
        );
        if hello.get("inviteSecret").is_some() {
            let pair = match host.gateway.claim(&peer, &hello, &config["config"]) {
                Ok(pair) => pair,
                Err(error) => {
                    return Self::reject_hello(&mut writer, limits, &error.to_string()).await;
                }
            };
            let _pair_slot = PairSlot {
                host: host.clone(),
                peer: peer.clone(),
                id: pair.id.clone(),
            };
            wire::write_json(
                &mut writer,
                &serde_json::to_vec(&json!({"event":"pairing","fingerprint":peer}))?,
                limits,
            )
            .await?;
            loop {
                if let Some(code) = pair.rejected.get() {
                    return Self::reject_hello(&mut writer, limits, code).await;
                }
                config = host.remote.snapshot(&host.migration)?;
                if gateway_owner::grant(&config["config"], &peer).is_some_and(|grant| {
                    grant["revision"]
                        .as_u64()
                        .is_some_and(|revision| revision > pair.previous_revision)
                }) {
                    break;
                }
                if pair.expires_at <= gateway_owner::now_ms() {
                    return Self::reject_hello(&mut writer, limits, "PAIRING_EXPIRED").await;
                }
                tokio::select! {
                    _=pair.signal.notified()=>{},
                    packet=requests.recv()=>{if packet.is_none(){return Ok(());}return Self::reject_hello(&mut writer,limits,"INVALID_PARAMS").await;},
                    _=tokio::time::sleep(Duration::from_millis(pair.expires_at.saturating_sub(gateway_owner::now_ms())))=>{},
                }
            }
        }
        ensure!(
            gateway_owner::transport_key(&config["config"], admission.kind) == admission.transport,
            "RESYNC_REQUIRED"
        );
        let Some(grant) = gateway_owner::grant(&config["config"], &peer) else {
            return Self::reject_hello(&mut writer, limits, "FORBIDDEN").await;
        };
        host.gateway.pending.set(host.gateway.pending.get() - 1);
        slot.pending = false;
        let mut token_key = [0; 32];
        std::io::Read::read_exact(&mut std::fs::File::open("/dev/urandom")?, &mut token_key)?;
        let mut session = Self {
            host,
            peer,
            grant,
            generation: admission.generation,
            connection: uuid::Uuid::new_v4().to_string(),
            host_peer: identity.peer().to_string(),
            token_key,
            viewer: None,
            transport: admission.transport,
            kind: admission.kind,
            source_id: config["sourceId"]
                .as_str()
                .context("RESYNC_REQUIRED")?
                .into(),
        };
        slot.connection = Some(session.connection.clone());
        session.host.gateway.active.borrow_mut().insert(
            session.connection.clone(),
            gateway_owner::ActiveSession {
                peer: session.peer.clone(),
                kind: session.kind,
                revision: session.grant["revision"].clone(),
                transport: session.transport.clone(),
                close: admission.close,
            },
        );
        let ready = session.describe(true);
        wire::write_json(&mut writer, &serde_json::to_vec(&ready)?, limits).await?;
        let mut window = Instant::now();
        let mut reads = 0u32;
        let mut writes = 10f64;
        let mut refilled = Instant::now();
        loop {
            enum Incoming {
                Request(Option<RequestMessage>),
                Event(Result<crate::server::schedule_connection::CoreEvent>),
            }
            let incoming = tokio::select! {
                request = requests.recv() => Incoming::Request(request),
                event = session.next_event() => Incoming::Event(event),
            };
            let bytes = match incoming {
                Incoming::Request(bytes) => bytes,
                Incoming::Event(event) => {
                    let update = match event {
                        Ok(event) => session.event(event).await,
                        Err(error) => Err(error),
                    };
                    let value = match update {
                        Ok(value) => value,
                        Err(error) => session.invalidate_session(&error),
                    };
                    if let Some(value) = value {
                        wire::write_json(&mut writer, &serde_json::to_vec(&value)?, limits).await?;
                    }
                    continue;
                }
            };
            let Some(bytes) = bytes else {
                return Ok(());
            };
            let request: Value = serde_json::from_slice(&bytes.bytes)?;
            drop(bytes);
            if window.elapsed() >= Duration::from_secs(1) {
                window = Instant::now();
                reads = 0;
            }
            reads += 1;
            let result = if reads > 20 {
                Err(fail("LIMIT_EXCEEDED"))
            } else if request["method"] == "interaction.respond" {
                writes = (writes + refilled.elapsed().as_secs_f64() * 5.0).min(10.0);
                refilled = Instant::now();
                if writes < 1.0 {
                    Err(fail("LIMIT_EXCEEDED"))
                } else {
                    writes -= 1.0;
                    session.request(&request).await
                }
            } else {
                session.request(&request).await
            };
            let response = match result {
                Ok(result) => json!({"id":request["id"],"result":result}),
                Err(error) => {
                    let message = error.to_string();
                    let code = match message.as_str() {
                        "INVALID_PARAMS"
                        | "FORBIDDEN"
                        | "GRANT_CHANGED"
                        | "RESYNC_REQUIRED"
                        | "REVIEW_INCOMPLETE"
                        | "TARGET_CHANGED"
                        | "COMMAND_CONFLICT"
                        | "RESOURCE_UNAVAILABLE"
                        | "LIMIT_EXCEEDED" => message.as_str(),
                        _ => "CORE_UNAVAILABLE",
                    };
                    json!({"id":request["id"],"error":{"code":code,"message":"请求暂不可用，请重新读取原状态"}})
                }
            };
            wire::write_json(&mut writer, &serde_json::to_vec(&response)?, limits).await?;
        }
    }
    async fn reject_hello<W: AsyncWrite + Unpin>(
        writer: &mut W,
        limits: wire::WireLimits,
        code: &str,
    ) -> Result<()> {
        let code = match code {
            "INVALID_PARAMS"
            | "PROTOCOL_UNSUPPORTED"
            | "PAIRING_CANCELLED"
            | "PAIRING_USED"
            | "PAIRING_EXPIRED" => code,
            _ => "FORBIDDEN",
        };
        let message = match code {
            "PROTOCOL_UNSUPPORTED" => "请更新远程客户端",
            "PAIRING_USED" => "邀请已使用或取消",
            "PAIRING_EXPIRED" => "邀请已过期",
            "PAIRING_CANCELLED" => "配对已取消",
            "FORBIDDEN" => "设备未获授权",
            _ => "无效的连接请求",
        };
        wire::write_json(
            writer,
            &serde_json::to_vec(&json!({"error":{"code":code,"message":message}}))?,
            limits,
        )
        .await?;
        writer.close().await?;
        Ok(())
    }
    fn describe(&self, ready: bool) -> Value {
        let limits: [(&str, u64); 44] = [
            ("applicationMessageBytes", 256 * 1024),
            ("transportFrameBytes", 512 * 1024),
            ("receiveBufferedBytes", 2 * 1024 * 1024),
            ("sendBufferedBytes", 2 * 1024 * 1024),
            ("sendPlaintextBufferedBytes", 1024 * 1024),
            ("sendTransportBufferedBytes", 1024 * 1024),
            ("activeHostConnections", 16),
            ("hostReceiveBufferedBytes", 8 * 1024 * 1024),
            ("hostSendBufferedBytes", 8 * 1024 * 1024),
            ("activeDeviceConnections", 2),
            ("readRequestsPerSecond", 20),
            ("writeRequestsPerSecond", 5),
            ("writeBurst", 10),
            ("pendingHandshakes", 8),
            ("helloDeadlineMs", 15000),
            ("heartbeatIntervalMs", 15000),
            ("heartbeatTimeoutMs", 45000),
            ("projectPageDefault", 30),
            ("projectPageMaximum", 100),
            ("overviewPageDefault", 30),
            ("overviewPageMaximum", 100),
            ("overviewPageBytes", 128 * 1024),
            ("observerConnections", 16),
            ("observerSubscriptions", 16),
            ("observerPendingRequests", 16),
            ("sessionItems", 100),
            ("sessionPreviewBytes", 1024),
            ("nativeHistoryBytes", 4 * 1024 * 1024),
            ("sessionBodyPageBytes", 32 * 1024),
            ("reviewPageBytes", 16 * 1024),
            ("reviewBodyBytes", 4 * 1024 * 1024),
            ("artifactBytes", 16 * 1024 * 1024),
            ("artifactChunkBytes", 48 * 1024),
            ("interactionPageBytes", 16 * 1024),
            ("interactionQuestions", 8),
            ("interactionAnswerBytes", 4096),
            ("taskQuestionPages", 8),
            ("taskQuestionBytes", 32 * 1024),
            ("taskQuestions", 8),
            ("taskAnswerBytes", 4096),
            ("commandTextBytes", 64 * 1024),
            ("commandJournalEntries", 4096),
            ("commandPendingBytes", 72 * 1024),
            ("commandOutcomeBytes", 4096),
        ];
        let limits = Value::Object(
            limits
                .into_iter()
                .map(|(key, value)| (key.to_owned(), json!(value)))
                .collect(),
        );
        let mut value = json!({"apiVersion":"areal.remote.v2","hostId":self.host_peer,"gatewayGeneration":self.generation,"connectionId":self.connection,"grantRevision":self.grant["revision"],"capabilities":self.grant["capabilities"],"methods":METHODS,"limits":limits});
        if ready {
            value["event"] = json!("ready");
        }
        value
    }
    fn authorize(&self, project: Option<&str>, capability: &str) -> Result<()> {
        let snapshot = self.host.remote.snapshot(&self.host.migration)?;
        ensure!(
            gateway_owner::transport_key(&snapshot["config"], self.kind) == self.transport,
            "RESYNC_REQUIRED"
        );
        let current =
            gateway_owner::grant(&snapshot["config"], &self.peer).context("GRANT_CHANGED")?;
        ensure!(
            current["revision"] == self.grant["revision"],
            "GRANT_CHANGED"
        );
        ensure!(
            self.host.gateway.current(&self.generation),
            "RESYNC_REQUIRED"
        );
        ensure!(
            current["capabilities"]
                .as_array()
                .is_some_and(|c| c.iter().any(|c| c == capability)),
            "FORBIDDEN"
        );
        if let Some(project) = project {
            ensure!(
                current["projectIds"]
                    .as_array()
                    .is_some_and(|ids| ids.iter().any(|id| id == project)),
                "FORBIDDEN"
            );
        }
        Ok(())
    }
    fn bindings(&self) -> Result<Vec<(String, String)>> {
        let current = self
            .host
            .slots
            .borrow()
            .values()
            .map(|slot| slot.registration.clone())
            .collect::<Vec<_>>();
        self.host
            .migration
            .remote_bindings(&self.source_id, &current)
    }
    fn project_id(&self, alias: &str) -> Result<String> {
        self.bindings()?
            .into_iter()
            .find(|(_, candidate)| candidate == alias)
            .map(|(id, _)| id)
            .filter(|id| self.host.slots.borrow().contains_key(id))
            .context("FORBIDDEN")
    }
    fn project(&self, alias: &str) -> Result<(String, String)> {
        let id = self.project_id(alias)?;
        let slots = self.host.slots.borrow();
        let slot = slots.get(&id).context("FORBIDDEN")?;
        let service = slot
            .service
            .as_ref()
            .filter(|_| slot.state == "ready")
            .context("CORE_UNAVAILABLE")?;
        Ok((id, service.identity.generation.clone()))
    }
    async fn rpc(
        &self,
        alias: &str,
        generation: &str,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        self.authorize(Some(alias), "observe")?;
        let (id, current) = self.project(alias)?;
        ensure!(current == generation, "RESYNC_REQUIRED");
        let (service_id, current, connection_id) = self
            .host
            .schedules
            .connections
            .shared_identity(&self.host, &id)?;
        ensure!(current == generation, "RESYNC_REQUIRED");
        let result = self
            .host
            .schedules
            .connections
            .remote_request(
                &self.host,
                &id,
                &service_id,
                generation,
                &connection_id,
                method,
                params,
            )
            .await?;
        self.authorize(Some(alias), "observe")?;
        ensure!(self.project(alias)?.1 == generation, "RESYNC_REQUIRED");
        ensure!(
            serde_json::to_vec(&result)?.len() <= 4 * 1024 * 1024,
            "RESOURCE_UNAVAILABLE"
        );
        Ok(result)
    }
    fn seal(&mut self, scope: String, offset: usize) -> Result<String> {
        let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&(scope, offset))?);
        let mut mac = Hmac::<sha2::Sha256>::new_from_slice(&self.token_key)?;
        mac.update(body.as_bytes());
        Ok(format!(
            "{body}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        ))
    }
    fn offset(&self, token: Option<&Value>, scope: &str) -> Result<usize> {
        let Some(token) = token else {
            return Ok(0);
        };
        let token = token
            .as_str()
            .filter(|token| token.len() <= 2048)
            .context("TARGET_CHANGED")?;
        let (body, signature) = token.split_once('.').context("TARGET_CHANGED")?;
        let mut mac = Hmac::<sha2::Sha256>::new_from_slice(&self.token_key)?;
        mac.update(body.as_bytes());
        mac.verify_slice(
            &URL_SAFE_NO_PAD
                .decode(signature)
                .map_err(|_| fail("TARGET_CHANGED"))?,
        )
        .map_err(|_| fail("TARGET_CHANGED"))?;
        let (current, offset): (String, usize) = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(body)
                .map_err(|_| fail("TARGET_CHANGED"))?,
        )
        .map_err(|_| fail("TARGET_CHANGED"))?;
        ensure!(current == scope, "TARGET_CHANGED");
        Ok(offset)
    }
    fn scope(&self, project: &str, generation: &str, target: &Value, body: &str) -> String {
        let epoch = self.project(project).ok().and_then(|(id, _)| {
            self.host
                .schedules
                .connections
                .shared_identity(&self.host, &id)
                .ok()
        });
        areal_local_service::storage::digest(
            serde_json::to_string(&json!([
                self.peer,
                self.connection,
                self.grant["revision"],
                self.generation,
                project,
                generation,
                epoch,
                target,
                body
            ]))
            .unwrap()
            .as_bytes(),
        )
    }
    async fn interaction(&self, project: &str, generation: &str, params: &Value) -> Result<Value> {
        let thread = text(params, "threadId")?;
        text(params, "turnId")?;
        text(params, "interactionId")?;
        let result = self
            .rpc(
                project,
                generation,
                "areal/interaction/list",
                json!({"threadId":thread}),
            )
            .await?;
        result["data"]
            .as_array()
            .and_then(|items| {
                items.iter().find(|item| {
                    item["threadId"] == params["threadId"]
                        && item["turnId"] == params["turnId"]
                        && item["requestId"] == params["interactionId"]
                })
            })
            .cloned()
            .context("TARGET_CHANGED")
    }
    fn interaction_body(item: &Value) -> Value {
        json!({"tool":item["tool"],"generation":item["generation"],"effectiveArguments":item["effectiveArguments"],"effectivePermissions":item["effectivePermissions"],"questions":item.get("questions").cloned().unwrap_or(json!([]))})
    }
    async fn request(&mut self, request: &Value) -> Result<Value> {
        ensure!(
            exact(request, &["id", "method", "context", "params", "commandId"])
                && request["id"]
                    .as_str()
                    .is_some_and(|id| !id.is_empty() && id.len() <= 64),
            "INVALID_PARAMS"
        );
        let method = text(request, "method")?;
        let params = &request["params"];
        ensure!(params.is_object(), "INVALID_PARAMS");
        self.authorize(None, "observe")?;
        if method == "host.describe" {
            ensure!(
                request.get("context").is_none() && exact(params, &[]),
                "INVALID_PARAMS"
            );
            return Ok(self.describe(false));
        }
        if method == "project.list" {
            ensure!(
                exact(params, &["limit", "cursor"])
                    && request
                        .get("context")
                        .is_none_or(|c| exact(c, &["projectId"])),
                "INVALID_PARAMS"
            );
            let limit = params
                .get("limit")
                .map(|n| n.as_u64().context("INVALID_PARAMS"))
                .transpose()?
                .unwrap_or(30);
            ensure!((1..=100).contains(&limit), "INVALID_PARAMS");
            let offset = params
                .get("cursor")
                .map(|c| {
                    c.as_str()
                        .context("INVALID_PARAMS")?
                        .parse::<usize>()
                        .map_err(|_| fail("INVALID_PARAMS"))
                })
                .transpose()?
                .unwrap_or(0);
            let aliases = self
                .bindings()?
                .into_iter()
                .collect::<std::collections::BTreeMap<_, _>>();
            let projects: Vec<_> = self.host.slots.borrow().values().filter_map(|slot| {
                let alias = aliases.get(&slot.registration.project_id)?;
                self.grant["projectIds"].as_array()?.iter().any(|id| id == alias).then(|| json!({"projectId":alias,"name":slot.registration.workspace.file_name().unwrap_or_default().to_string_lossy(),"connectionState":if slot.state=="ready" {"online"} else {"offline"},"serviceGeneration":slot.service.as_ref().map(|s|s.identity.generation.clone())}))
            }).collect();
            ensure!(offset <= projects.len(), "INVALID_PARAMS");
            let end = projects.len().min(offset + limit as usize);
            return Ok(
                json!({"projects":projects[offset..end],"nextCursor":(end<projects.len()).then(||end.to_string())}),
            );
        }
        let project = text(&request["context"], "projectId")?.to_owned();
        self.authorize(Some(&project), "observe")?;
        if method == "command.read" {
            return self.command_read(&project, params).await;
        }
        if method == "subscription.close" {
            return self.close_session(&project, params);
        }
        let (_, generation) = self.project(&project)?;
        match method {
            "work.list" | "attention.list" => {
                self.overview(&project, &generation, method, params).await
            }
            "session.open" => self.open_session(&project, &generation, params).await,
            "session.history" => self.session_history(&project, &generation, params).await,
            "session.body" => self.session_body(&project, &generation, params).await,
            "task.read" => {
                ensure!(exact(params, &["taskId", "runId"]), "INVALID_PARAMS");
                let task_id = text(params, "taskId")?;
                let task = self
                    .rpc(
                        &project,
                        &generation,
                        "areal/task/read",
                        json!({"taskId":task_id}),
                    )
                    .await?;
                let run = task["runs"]
                    .as_array()
                    .and_then(|runs| runs.iter().find(|run| run["id"] == params["runId"]));
                let workers = run
                    .and_then(|run| run["workers"].as_array())
                    .is_some_and(|workers| workers.iter().all(|w| w["settled"] == true));
                let status = run
                    .map(|run| run["status"].clone())
                    .unwrap_or(json!("unavailable"));
                Ok(
                    json!({"taskId":task["id"],"runId":params["runId"],"revision":task["revision"],"taskPaused":task["paused"]==true,"taskCancelled":task["cancelled"]==true,"currentRunId":task["runs"].as_array().and_then(|runs|runs.last()).map(|run|run["id"].clone()),"runStatus":status,"reason":run.and_then(|run|run["reason"].as_str()),"workersSettled":workers,"settled":task["paused"]==true && workers && matches!(status.as_str(),Some("paused"|"completed"|"failed"|"cancelled")),"provesCommandAdmission":false,"projectId":project,"serviceGeneration":generation,"available":params["runId"].is_string() && task["runs"].as_array().and_then(|runs|runs.last()).is_some_and(|run|run["id"]==params["runId"]) && task["paused"]!=true && task["cancelled"]!=true}),
                )
            }
            "attention.read" => self.attention_read(&project, &generation, params).await,
            "interaction.respond" => self.respond(&project, &generation, request).await,
            "review.read" => self.review(&project, &generation, params).await,
            _ => Err(fail("INVALID_PARAMS")),
        }
    }
    async fn attention_read(
        &mut self,
        project: &str,
        generation: &str,
        params: &Value,
    ) -> Result<Value> {
        ensure!(
            exact(params, &["threadId", "turnId", "interactionId", "cursor"]),
            "INVALID_PARAMS"
        );
        let item = self.interaction(project, generation, params).await?;
        let review = Self::interaction_body(&item);
        let body = serde_json::to_string(&review)?;
        let target = json!({"threadId":params["threadId"],"turnId":params["turnId"],"interactionId":params["interactionId"],"kind":item["kind"],"argumentsDigest":item["argumentsDigest"],"expiresAt":item["expiresAt"]});
        let scope = self.scope(project, generation, &target, &body);
        let offset = self.offset(params.get("cursor"), &scope)?;
        ensure!(offset < body.len() || offset == 0, "INVALID_PARAMS");
        let mut end = (offset + 16384).min(body.len());
        while !body.is_char_boundary(end) {
            end -= 1;
        }
        let complete = end == body.len();
        let next = if complete {
            None
        } else {
            Some(self.seal(scope.clone(), end)?)
        };
        let token = if complete {
            Some(self.seal(scope, body.len())?)
        } else {
            None
        };
        let mut result = json!({"projectId":project,"serviceGeneration":generation,"threadId":params["threadId"],"turnId":params["turnId"],"interactionId":params["interactionId"],"kind":if item["kind"]=="question" {"syncQuestion"} else {"approval"},"status":item["status"],"expiresAt":item["expiresAt"],"argumentsDigest":item["argumentsDigest"],"review":{"encoding":"json-utf8","offset":offset,"totalBytes":body.len(),"chunk":&body[offset..end]},"complete":complete,"nextCursor":next,"reviewToken":token});
        if complete && offset == 0 {
            result
                .as_object_mut()
                .unwrap()
                .extend(review.as_object().unwrap().clone());
        }
        Ok(result)
    }
    fn command_record(&self, project: &str, command: &str) -> Result<Option<Value>> {
        let id = self.project_id(project)?;
        let (_, snapshot) = self.host.journal.native_snapshot(&id)?;
        let entries = snapshot["pending"]
            .as_array()
            .context("RESOURCE_UNAVAILABLE")?
            .iter()
            .chain(
                snapshot["outcomes"]
                    .as_object()
                    .context("RESOURCE_UNAVAILABLE")?
                    .values(),
            );
        Ok(entries
            .filter(|entry| {
                entry["remote"]["hostId"] == self.host_peer
                    && entry["remote"]["devicePeerId"] == self.peer
                    && entry["remote"]["projectId"] == project
                    && entry["remote"]["commandId"]
                        .as_str()
                        .is_some_and(|id| id.eq_ignore_ascii_case(command))
            })
            .next()
            .cloned())
    }
    fn command_view(record: Option<&Value>, command: &str) -> Value {
        let Some(record) = record else {
            return json!({"commandId":command,"admissionState":"notFound","submissionUnknown":true});
        };
        let mut result = json!({"commandId":command,"method":record["remote"]["method"],"target":record["remote"]["target"],"operationId":record["operationId"],"admissionState":record.get("admissionState").cloned().unwrap_or(json!("unknown")),"submissionUnknown":record.get("admissionState").is_none()});
        for key in ["threadId", "turnId", "receipt"] {
            if let Some(value) = record.get(key) {
                result[key] = value.clone();
            }
        }
        if let Some(error) = record.get("error") {
            let core = error["code"].as_i64();
            let code = match core {
                Some(-32009) => "TARGET_CHANGED",
                Some(-32001) => "CAPACITY_EXCEEDED",
                Some(-32602) => "INVALID_PARAMS",
                _ => "CORE_UNAVAILABLE",
            };
            result["error"] = json!({"code":code,"message":"命令未受理，请刷新状态后检查草稿"});
            if let Some(core) = core {
                result["error"]["coreCode"] = json!(core);
            }
        }
        result
    }
    async fn command_read(&self, project: &str, params: &Value) -> Result<Value> {
        ensure!(exact(params, &["commandId"]), "INVALID_PARAMS");
        let command = text(params, "commandId")?;
        uuid::Uuid::parse_str(command).map_err(|_| fail("INVALID_PARAMS"))?;
        let record = self.command_record(project, command)?;
        self.authorize(
            Some(project),
            record
                .as_ref()
                .and_then(|r| r["remote"]["capability"].as_str())
                .unwrap_or("observe"),
        )?;
        self.command_result(project, record.as_ref(), command).await
    }
    async fn command_result(
        &self,
        project: &str,
        record: Option<&Value>,
        command: &str,
    ) -> Result<Value> {
        let mut result = Self::command_view(record, command);
        if let Some(record) = record {
            if record["remote"]["method"] == "interaction.respond" {
                let target = &record["remote"]["target"];
                let observed = match self.project(project) {
                    Ok((_, generation)) => {
                        self.interaction(project, &generation, target).await.ok()
                    }
                    Err(_) => None,
                };
                result["observedState"] = match observed {
                    Some(item) => {
                        json!({"source":"interaction.read","status":item["status"],"expiresAt":item["expiresAt"],"threadId":target["threadId"],"turnId":target["turnId"],"interactionId":target["interactionId"],"provesCommandAdmission":false})
                    }
                    None => {
                        json!({"source":"interaction.read","status":"unavailable","provesCommandAdmission":false})
                    }
                };
            }
            self.authorize(
                Some(project),
                record["remote"]["capability"].as_str().unwrap_or("observe"),
            )?;
        }
        Ok(result)
    }
    async fn respond(&mut self, project: &str, generation: &str, request: &Value) -> Result<Value> {
        let params = &request["params"];
        ensure!(
            exact(
                params,
                &[
                    "threadId",
                    "turnId",
                    "interactionId",
                    "argumentsDigest",
                    "decision",
                    "answers",
                    "reviewToken"
                ]
            ) && exact(
                &request["context"],
                &[
                    "projectId",
                    "gatewayGeneration",
                    "grantRevision",
                    "serviceGeneration"
                ]
            ),
            "INVALID_PARAMS"
        );
        let command = text(request, "commandId")?.to_ascii_lowercase();
        uuid::Uuid::parse_str(&command).map_err(|_| fail("INVALID_PARAMS"))?;
        text(params, "threadId")?;
        text(params, "turnId")?;
        text(params, "interactionId")?;
        let capability = "answer";
        self.authorize(Some(project), capability)?;
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Semantic<'a> {
            method: &'a str,
            thread_id: &'a Value,
            turn_id: &'a Value,
            interaction_id: &'a Value,
            #[serde(skip_serializing_if = "Option::is_none")]
            arguments_digest: Option<&'a Value>,
            #[serde(skip_serializing_if = "Option::is_none")]
            decision: Option<&'a Value>,
            #[serde(skip_serializing_if = "Option::is_none")]
            answers: Option<&'a Value>,
        }
        let semantic = Semantic {
            method: "interaction.respond",
            thread_id: &params["threadId"],
            turn_id: &params["turnId"],
            interaction_id: &params["interactionId"],
            arguments_digest: params.get("argumentsDigest"),
            decision: params.get("decision"),
            answers: params.get("answers"),
        };
        let digest = areal_local_service::storage::digest(&serde_json::to_vec(&semantic)?);
        if let Some(record) = self.command_record(project, &command)? {
            ensure!(
                record["remote"]["semanticDigest"] == digest,
                "COMMAND_CONFLICT"
            );
            return self.command_result(project, Some(&record), &command).await;
        }
        ensure!(
            request["context"]["gatewayGeneration"] == self.generation
                && request["context"]["grantRevision"] == self.grant["revision"]
                && request["context"]["serviceGeneration"] == generation,
            "RESYNC_REQUIRED"
        );
        let item = self.interaction(project, generation, params).await?;
        ensure!(
            item["status"] == "pending"
                && item["expiresAt"].as_i64().is_some_and(|at| at
                    > std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs() as i64),
            "TARGET_CHANGED"
        );
        if params["decision"] != "deny" {
            let body = serde_json::to_string(&Self::interaction_body(&item))?;
            let target = json!({"threadId":params["threadId"],"turnId":params["turnId"],"interactionId":params["interactionId"],"kind":item["kind"],"argumentsDigest":item["argumentsDigest"],"expiresAt":item["expiresAt"]});
            let scope = self.scope(project, generation, &target, &body);
            ensure!(
                params.get("reviewToken").is_some()
                    && self.offset(params.get("reviewToken"), &scope)? == body.len(),
                "REVIEW_INCOMPLETE"
            );
        }
        let mut native = json!({"threadId":params["threadId"],"turnId":params["turnId"],"requestId":params["interactionId"]});
        if item["kind"] == "approval" {
            ensure!(
                matches!(params["decision"].as_str(), Some("allowOnce" | "deny"))
                    && params["argumentsDigest"] == item["argumentsDigest"]
                    && params.get("answers").is_none(),
                "INVALID_PARAMS"
            );
            native["decision"] = params["decision"].clone();
            native["argumentsDigest"] = params["argumentsDigest"].clone();
        } else {
            ensure!(
                params.get("decision").is_none()
                    && params.get("argumentsDigest").is_none()
                    && params["answers"]
                        .as_object()
                        .is_some_and(|answers| !answers.is_empty()
                            && answers.len() <= 8
                            && answers.values().all(|v| v
                                .as_str()
                                .is_some_and(|s| !s.trim().is_empty() && s.len() <= 4096))),
                "INVALID_PARAMS"
            );
            native["answers"] = params["answers"].clone();
        }
        let (id, _) = self.project(project)?;
        let (revision, mut snapshot) = self.host.journal.native_snapshot(&id)?;
        ensure!(
            snapshot["pending"].as_array().unwrap().len()
                + snapshot["outcomes"].as_object().unwrap().len()
                < 4096,
            "RESOURCE_UNAVAILABLE"
        );
        let operation = uuid::Uuid::new_v4().to_string();
        let mut target = json!({"threadId":params["threadId"],"turnId":params["turnId"],"interactionId":params["interactionId"]});
        if let Some(value) = params.get("argumentsDigest") {
            target["argumentsDigest"] = value.clone();
        }
        let record = json!({"method":"areal/interaction/respond","operationId":operation,"params":native,"threadId":params["threadId"],"turnId":params["turnId"],"remote":{"hostId":self.host_peer,"devicePeerId":self.peer,"projectId":project,"commandId":command,"method":"interaction.respond","capability":capability,"admittedGrantRevision":self.grant["revision"],"semanticDigest":digest,"target":target}});
        self.authorize(Some(project), capability)?;
        ensure!(self.project(project)?.1 == generation, "RESYNC_REQUIRED");
        snapshot["pending"]
            .as_array_mut()
            .unwrap()
            .push(record.clone());
        self.host.journal.native_replace(&id, revision, snapshot)?;
        let (service_id, current, connection_id) = self
            .host
            .schedules
            .connections
            .shared_identity(&self.host, &id)?;
        self.authorize(Some(project), capability)?;
        ensure!(current == generation, "RESYNC_REQUIRED");
        let result = self
            .host
            .schedules
            .connections
            .remote_request(
                &self.host,
                &id,
                &service_id,
                generation,
                &connection_id,
                "areal/interaction/respond",
                native,
            )
            .await;
        // 未得到权威回应时保留原 pending；查询只能返回原关联，不能再次派发。
        let mut settled = record.clone();
        match result {
            Ok(receipt) => {
                settled["admissionState"] = json!("accepted");
                settled["receipt"] = receipt;
            }
            Err(error) => {
                let definitive = error
                    .downcast_ref::<crate::server::schedule_connection::RpcFailure>()
                    .filter(|failure| {
                        failure.0["code"]
                            .as_i64()
                            .is_some_and(|code| code != -32603)
                    });
                let Some(failure) = definitive else {
                    return self.command_result(project, Some(&record), &command).await;
                };
                settled["admissionState"] = json!("rejected");
                settled["error"] = failure.0.clone();
            }
        }
        settled["accepted"] = json!(settled["admissionState"] == "accepted");
        settled.as_object_mut().unwrap().remove("params");
        let (revision, mut snapshot) = self.host.journal.native_snapshot(&id)?;
        snapshot["pending"]
            .as_array_mut()
            .unwrap()
            .retain(|entry| entry["operationId"] != operation);
        snapshot["outcomes"][&operation] = settled.clone();
        self.host.journal.native_replace(&id, revision, snapshot)?;
        self.authorize(Some(project), capability)?;
        self.command_result(project, Some(&settled), &command).await
    }
    async fn review(&mut self, project: &str, generation: &str, params: &Value) -> Result<Value> {
        self.authorize(Some(project), "review")?;
        ensure!(
            exact(params, &["threadId", "turnId", "itemId", "cursor", "limit"]),
            "INVALID_PARAMS"
        );
        let thread_id = text(params, "threadId")?;
        let turn_id = text(params, "turnId")?;
        let response = self
            .rpc(
                project,
                generation,
                "thread/read",
                json!({"threadId":thread_id,"includeTurns":true}),
            )
            .await?;
        let thread = &response["thread"];
        let turn = thread["turns"]
            .as_array()
            .and_then(|turns| turns.iter().find(|turn| turn["id"] == turn_id))
            .context("RESOURCE_UNAVAILABLE")?;
        let items = turn["items"].as_array().context("RESOURCE_UNAVAILABLE")?;
        if let Some(id) = params.get("itemId") {
            ensure!(
                id.is_string() && items.iter().filter(|i| i["id"] == *id).count() == 1,
                "RESOURCE_UNAVAILABLE"
            );
        }
        let result:Vec<_>=items.iter().filter(|item|params.get("itemId").is_none_or(|id|item["id"]==*id)).filter(|i|matches!(i["type"].as_str(),Some("agentMessage"|"dynamicToolCall"))).map(|i|{
            let text=if i["type"]=="agentMessage"{i["text"].as_str().unwrap_or_default().to_owned()}else{i["contentItems"].as_array().map(|c|c.iter().filter(|c|matches!(c["type"].as_str(),Some("inputText"|"text"))).filter_map(|c|c["text"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default()};
            json!({"itemId":i["id"],"type":i["type"],"phase":i["phase"],"status":i["status"],"success":i["success"],"executionOutcome":i["execution"]["outcome"],"text":text})
        }).collect();
        let body = serde_json::to_string(
            &json!({"threadId":thread["id"],"turnId":turn["id"],"itemId":params["itemId"],"turnStatus":turn["status"],"error":turn["error"],"partial":turn["status"]!="completed","taskRunStatus":null,"notice":"原 Turn 输出；文本可读不代表成功。Task Run 状态需单独查看 Task，不能由此 Turn 推断。","result":result,"diff":{"state":"unavailable","notice":"此 Turn/Item 无法重建完整历史版本；不会使用当前工作区替代。"},"artifactNotice":"最多列出 16 个具有原 Turn/Item 原生归属且不超过 16 MiB 的 PNG/JPEG/GIF/WebP；超出列表、动画或其他制品请在桌面查看。"}),
        )?;
        ensure!(body.len() <= 4 * 1024 * 1024, "RESOURCE_UNAVAILABLE");
        let target = json!({"threadId":thread_id,"turnId":turn_id,"itemId":params["itemId"]});
        let scope = self.scope(project, generation, &target, &body);
        let offset = self.offset(params.get("cursor"), &scope)?;
        ensure!(offset < body.len() || offset == 0, "INVALID_PARAMS");
        let limit = params
            .get("limit")
            .map(|n| n.as_u64().context("INVALID_PARAMS"))
            .transpose()?
            .unwrap_or(16384) as usize;
        ensure!((1..=16384).contains(&limit), "INVALID_PARAMS");
        let mut end = (offset + limit).min(body.len());
        while !body.is_char_boundary(end) {
            end -= 1;
        }
        ensure!(end > offset || end == body.len(), "INVALID_PARAMS");
        let next = if end < body.len() {
            Some(self.seal(scope, end)?)
        } else {
            None
        };
        self.authorize(Some(project), "review")?;
        Ok(
            json!({"artifacts":[],"projectId":project,"threadId":thread_id,"turnId":turn_id,"itemId":params["itemId"],"connectionId":self.connection,"gatewayGeneration":self.generation,"serviceGeneration":generation,"review":{"encoding":"json-utf8","offset":offset,"totalBytes":body.len(),"chunk":&body[offset..end]},"nextCursor":next}),
        )
    }
}
