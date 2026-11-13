//! 本机Main附件复用同一Core租约；订阅断开撤销工具宿主与专用连接。
use super::*;
fn exact(value: &Value, keys: &[&str]) -> Result<()> {
    ensure!(
        value
            .as_object()
            .is_some_and(|object| object.keys().all(|key| keys.contains(&key.as_str()))),
        "INVALID_PARAMS"
    );
    Ok(())
}

pub(super) struct Frontend {
    connection: String,
    source: String,
    options: Value,
    events: mpsc::Sender<Value>,
    leases: BTreeMap<String, String>,
    callbacks: BTreeMap<String, oneshot::Sender<Result<Value>>>,
}
impl Connections {
    pub(super) fn frontend_owns(&self, lease: &str) -> bool {
        self.frontends
            .borrow()
            .values()
            .any(|frontend| frontend.leases.contains_key(lease))
    }
    pub(crate) fn frontend_subscribe(
        &self,
        host: &Host,
        connection: &str,
        source: &str,
        options: Value,
    ) -> Result<(Value, mpsc::Receiver<Value>)> {
        ensure!(
            !host.gateway.workbench.backend_has_source(source),
            "COMMAND_CONFLICT"
        );
        let options = super::super::workbench_route::frontend_options(host, source, options)?;
        ensure!(self.frontends.borrow().len() < 16, "CAPACITY_EXCEEDED");
        ensure!(
            !self
                .frontends
                .borrow()
                .values()
                .any(|frontend| frontend.source == source),
            "COMMAND_CONFLICT"
        );
        let id = uuid::Uuid::new_v4().to_string();
        let (events, receiver) = mpsc::channel(64);
        self.frontends.borrow_mut().insert(
            id.clone(),
            Frontend {
                connection: connection.into(),
                source: source.into(),
                options,
                events,
                leases: BTreeMap::new(),
                callbacks: BTreeMap::new(),
            },
        );
        Ok((json!({"attachmentId":id}), receiver))
    }
    pub(crate) fn frontend_disconnect(&self, connection: &str) {
        let ids = self
            .frontends
            .borrow()
            .iter()
            .filter(|(_, frontend)| frontend.connection == connection)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            if let Some(frontend) = self.frontends.borrow_mut().remove(&id) {
                for (lease, project) in frontend.leases {
                    let session = self.terminals.borrow_mut().remove(&lease).or_else(|| {
                        self.sessions
                            .borrow()
                            .get(&project)
                            .filter(|session| {
                                session.workbench_lease.borrow().as_deref() == Some(&lease)
                            })
                            .cloned()
                    });
                    if let Some(session) = session {
                        session.close();
                    }
                }
            }
        }
    }
    pub(crate) fn frontend_event(&self, project: &str, lease: &str, event: &Value) -> bool {
        let selected = self
            .frontends
            .borrow()
            .iter()
            .find(|(_, frontend)| frontend.leases.get(lease).is_some_and(|id| id == project))
            .map(|(id, frontend)| {
                (
                    id.clone(),
                    frontend.connection.clone(),
                    frontend.events.clone(),
                )
            });
        let Some((attachment, connection, sender)) = selected else {
            return false;
        };
        let mut event = event.clone();
        event["event"] = json!("core.event");
        event["projectId"] = json!(project);
        event["lease"] = json!(lease);
        if sender
            .try_send(json!({"attachmentId":attachment,"event":event}))
            .is_err()
        {
            self.frontend_disconnect(&connection);
        }
        true
    }
    pub(crate) async fn frontend_callback(
        &self,
        project: &str,
        lease: &str,
        method: &str,
        params: &Value,
        core_request_id: &Value,
    ) -> Option<Result<Value>> {
        let selected = self
            .frontends
            .borrow()
            .iter()
            .find(|(_, frontend)| frontend.leases.get(lease).is_some_and(|id| id == project))
            .map(|(id, frontend)| (id.clone(), frontend.events.clone()));
        let (attachment, sender) = selected?;
        let request = uuid::Uuid::new_v4().to_string();
        let (send, receive) = oneshot::channel();
        {
            let mut frontends = self.frontends.borrow_mut();
            let frontend = frontends.get_mut(&attachment)?;
            if frontend.callbacks.len() >= 64 {
                return Some(Err(unavailable()));
            }
            frontend.callbacks.insert(request.clone(), send);
        }
        let event = json!({"attachmentId":attachment,"event":{"event":"core.callback","requestId":request,"coreRequestId":core_request_id,"projectId":project,"lease":lease,"method":method,"params":params}});
        let sent = sender.send(event).await;
        let result = if sent.is_err() {
            Err(unavailable())
        } else {
            match tokio::time::timeout(Duration::from_secs(62), receive).await {
                Ok(Ok(result)) => result,
                _ => Err(unavailable()),
            }
        };
        if let Some(frontend) = self.frontends.borrow_mut().get_mut(&attachment) {
            frontend.callbacks.remove(&request);
        }
        Some(result)
    }
    pub(crate) fn frontend_reply(&self, params: &Value) -> Result<Value> {
        exact(params, &["attachmentId", "requestId", "result", "error"])?;
        ensure!(
            params.get("result").is_some() != params.get("error").is_some(),
            "INVALID_PARAMS"
        );
        if let Some(error) = params.get("error") {
            exact(error, &["message"])?;
            ensure!(error["message"].is_string(), "INVALID_PARAMS");
        }
        let id = params["attachmentId"].as_str().context("INVALID_PARAMS")?;
        let request = params["requestId"].as_str().context("INVALID_PARAMS")?;
        let send = self
            .frontends
            .borrow_mut()
            .get_mut(id)
            .context("FORBIDDEN")?
            .callbacks
            .remove(request);
        let received = send.is_some();
        if let Some(send) = send {
            let reply = if params.get("error").is_some() {
                Err(unavailable())
            } else {
                Ok(params["result"].clone())
            };
            let _ = send.send(reply);
        }
        Ok(json!({"received":received}))
    }
    pub(crate) async fn frontend_call(&self, host: &Rc<Host>, params: &Value) -> Result<Value> {
        exact(params, &["attachmentId", "call", "params"])?;
        let attachment = params["attachmentId"].as_str().context("INVALID_PARAMS")?;
        let call = params["call"].as_str().context("INVALID_PARAMS")?;
        let source = self
            .frontends
            .borrow()
            .get(attachment)
            .context("FORBIDDEN")?
            .source
            .clone();
        host.migration.source_profile(&source)?;
        let input = &params["params"];
        match call {
            "core.attach" => exact(input, &["sourceId", "projectId", "scope"])?,
            "core.blob" => {
                if input["operation"] == "read" {
                    exact(
                        input,
                        &[
                            "sourceId",
                            "projectId",
                            "lease",
                            "operation",
                            "threadId",
                            "uri",
                        ],
                    )?;
                } else {
                    exact(
                        input,
                        &[
                            "sourceId",
                            "projectId",
                            "lease",
                            "operation",
                            "threadId",
                            "mime",
                            "base64",
                            "callId",
                            "hostGeneration",
                        ],
                    )?;
                }
            }
            "core.media" => exact(
                input,
                &[
                    "sourceId",
                    "projectId",
                    "lease",
                    "threadId",
                    "turnId",
                    "itemId",
                    "uri",
                    "offset",
                    "length",
                ],
            )?,
            "core.request" => exact(
                input,
                &["sourceId", "projectId", "lease", "method", "params"],
            )?,
            "core.detach" => exact(input, &["sourceId", "projectId", "lease"])?,
            "execution.admit" => {
                exact(
                    input,
                    &["sourceId", "projectId", "lease", "name", "request"],
                )?;
                exact(
                    &input["request"],
                    &[
                        "operation",
                        "threadId",
                        "parentThreadId",
                        "sourceThreadId",
                        "taskId",
                        "expectedTurnId",
                        "mode",
                    ],
                )?;
            }
            "tasks.preview" => exact(input, &["projectId", "limit", "sourceThreadId"])?,
            "cloud.attach" => exact(input, &["sourceId", "baseURL", "token"])?,
            "workbench.utility" => {
                exact(input, &["operation", "document", "projectId", "pluginId"])?
            }
            _ => anyhow::bail!("FORBIDDEN"),
        }
        ensure!(
            input.get("sourceId").is_none_or(|id| id == &source),
            "FORBIDDEN"
        );
        if call == "workbench.utility" {
            let options = self
                .frontends
                .borrow()
                .get(attachment)
                .context("FORBIDDEN")?
                .options
                .clone();
            return super::super::workbench_utility::execute_with_options(
                host,
                &source,
                input.clone(),
                options,
            )
            .await;
        }
        if call == "tasks.preview" {
            let mut params = input.clone();
            params["sourceId"] = json!(source);
            return super::super::task_catalog::preview(host, &params).await;
        }
        if call == "cloud.attach" {
            let value = self.workbench_cloud_attach(host, &source, input).await?;
            let lease = value["lease"].as_str().context("INVALID_RESPONSE")?;
            let project = value["projectId"].as_str().context("INVALID_RESPONSE")?;
            if let Some(frontend) = self.frontends.borrow_mut().get_mut(attachment) {
                frontend.leases.insert(lease.into(), project.into());
            } else {
                self.workbench_detach(host, project, lease)?;
                anyhow::bail!("FORBIDDEN");
            }
            return Ok(value);
        }
        let project = input["projectId"].as_str().context("INVALID_PARAMS")?;
        let remote = input["lease"]
            .as_str()
            .is_some_and(|lease| self.workbench_remote(&source, project, lease));
        if !remote {
            super::super::workbench_route::backend_project_alias(host, &source, project)?;
        }
        if call == "core.attach" {
            let value = if input["scope"].is_null() {
                self.workbench_desktop_attach(host, project).await?
            } else {
                self.workbench_attach(host, project, input["scope"].as_str())
                    .await?
            };
            let lease = value["lease"].as_str().context("INVALID_RESPONSE")?;
            let mut frontends = self.frontends.borrow_mut();
            if let Some(frontend) = frontends.get_mut(attachment) {
                frontend.leases.insert(lease.into(), project.into());
            } else {
                drop(frontends);
                self.workbench_detach(host, project, lease)?;
                anyhow::bail!("FORBIDDEN");
            }
            return Ok(value);
        }
        let lease = input["lease"].as_str().context("INVALID_PARAMS")?;
        ensure!(
            self.frontends
                .borrow()
                .get(attachment)
                .is_some_and(|frontend| frontend.leases.get(lease).is_some_and(|id| id == project)),
            "FORBIDDEN"
        );
        match call {
            "core.detach" => {
                let result = self.workbench_detach(host, project, lease)?;
                self.frontends
                    .borrow_mut()
                    .get_mut(attachment)
                    .context("FORBIDDEN")?
                    .leases
                    .remove(lease);
                Ok(result)
            }
            "core.blob" => self.workbench_blob(host, project, lease, input).await,
            "core.media" => self.workbench_media(host, project, lease, input).await,
            "core.request" => {
                self.workbench_request(
                    host,
                    project,
                    lease,
                    input["method"].as_str().context("INVALID_PARAMS")?,
                    input["params"].clone(),
                )
                .await
            }
            "execution.admit" => {
                self.workbench_admit(
                    host,
                    project,
                    Some(lease),
                    input["name"].as_str().context("INVALID_PARAMS")?,
                    &input["request"],
                )
                .await
            }
            _ => anyhow::bail!("FORBIDDEN"),
        }
    }
}

impl Connections {
    pub(crate) fn frontend_close_terminals(&self, host: &Host, source: &str) -> Result<Value> {
        host.migration.source_profile(source)?;
        let mut leases = Vec::new();
        for (lease, session) in self.terminals.borrow().iter() {
            if !session.terminal
                || session.desktop.get()
                || session.observer.get()
                || session.remote_source.is_some()
            {
                continue;
            }
            let registration = host
                .slots
                .borrow()
                .get(&session.project_id)
                .map(|slot| slot.registration.clone());
            if let Some(registration) = registration
                && host.migration.credential_source(&registration)?.as_deref() == Some(source)
            {
                leases.push((lease.clone(), session.project_id.clone()));
            }
        }
        let closed = !leases.is_empty();
        for (lease, project) in leases {
            self.workbench_detach(host, &project, &lease)?;
        }
        Ok(json!({"closed":closed}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::net::{TcpListener, UnixStream};
    use tokio_tungstenite::tungstenite::Message;
    async fn host_socket(
        host: Rc<Host>,
    ) -> (
        BufReader<tokio::net::unix::OwnedReadHalf>,
        tokio::net::unix::OwnedWriteHalf,
    ) {
        let (client, server) = UnixStream::pair().unwrap();
        let token = host.token.clone();
        tokio::task::spawn_local(async move {
            let _ = super::super::super::connection_loop(host, server).await;
        });
        let (reader, mut writer) = client.into_split();
        let mut reader = BufReader::new(reader);
        crate::wire::write(&mut writer,&json!({"version":1,"id":"hello","method":"hello","params":{"protocolVersions":[1],"capabilities":[],"authToken":token}})).await.unwrap();
        assert!(crate::wire::read(&mut reader).await.unwrap().unwrap()["result"].is_object());
        (reader, writer)
    }
    async fn send(
        writer: &mut tokio::net::unix::OwnedWriteHalf,
        id: &str,
        method: &str,
        params: Value,
    ) {
        crate::wire::write(
            writer,
            &json!({"version":1,"id":id,"method":method,"params":params}),
        )
        .await
        .unwrap();
    }
    #[tokio::test(flavor = "current_thread")]
    async fn native_main_uses_independent_callback_socket_and_revokes_original_lease() {
        tokio::task::LocalSet::new().run_until(async {
            tokio::time::timeout(Duration::from_secs(10),async {
                let root=tempfile::tempdir().unwrap();let mut host=super::super::super::schedules::tests::fixture(root.path());
                Rc::get_mut(&mut host.migration).unwrap().vault=crate::vault::Vault::isolated_files(&host.home);
                host.bin=root.path().join("resources/core/bin");storage::private_dir(&host.bin).unwrap();
                std::fs::write(host.bin.join("areal"),b"fixture").unwrap();std::fs::write(root.path().join("resources/app.asar"),b"fixture").unwrap();
                let source=crate::migration::Source{profile:root.path().join("profile"),core_home:root.path().join("gui-core"),legacy_service_home:root.path().join("gui-services")};
                for path in [&source.profile,&source.core_home,&source.legacy_service_home]{storage::private_dir(path).unwrap();}
                storage::write(&source.core_home.join("projects.json"),&json!([])).unwrap();host.migration.attach(source.clone(),"fixture",None).unwrap();
                let imported=host.migration.import(serde_json::from_value(json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":host.identity.generation,"source":source})).unwrap(),"fixture",&[],&host.journal).unwrap();assert_eq!(imported["kind"],"ready");
                let source_id=host.migration.source(source.clone(),&[]).unwrap()["sourceId"].as_str().unwrap().to_owned();
                let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
                let registration=host.slots.borrow()["project"].registration.clone();
                let service=Service{identity:areal_protocol::service::Identity{protocol_version:1,service_id:"fixture-core".into(),generation:"generation".into(),workspace:registration.workspace,data_dir:registration.data_dir,config_fingerprint:"fixture".into()},owner:Some(host.owner()),endpoint:format!("ws://{}/",listener.local_addr().unwrap()),web_url:String::new(),auth_file:root.path().join("auth.json"),log_file:root.path().join("core.log"),host_pid:1,core_pid:2,state:State::Ready};
                storage::write(&service.auth_file,&json!({"principals":[{"id":"desktop-owner","token":"fixture-token"}]})).unwrap();
                {let mut slots=host.slots.borrow_mut();let slot=slots.get_mut("project").unwrap();slot.state="ready".into();slot.service=Some(service.clone());}
                let host=Rc::new(host);
                let core=tokio::task::spawn_local(async move {
                    let mut connections=tokio::task::JoinSet::new();
                    for index in 0..2 {
                        let (stream,_)=listener.accept().await.unwrap();
                        connections.spawn_local(async move {
                            let mut socket=tokio_tungstenite::accept_async(stream).await.unwrap();let mut original=Value::Null;
                            while let Some(Ok(Message::Text(text)))=socket.next().await {
                                let frame:Value=serde_json::from_str(&text).unwrap();if frame["method"]=="initialized"{continue;}
                                if frame["method"]=="initialize" {socket.send(Message::Text(json!({"id":frame["id"],"result":{}}).to_string().into())).await.unwrap();}
                                else if index==0 {socket.send(Message::Text(json!({"id":frame["id"],"result":{"alive":true}}).to_string().into())).await.unwrap();}
                                else if frame["method"]=="areal/server/status" {original=frame["id"].clone();socket.send(Message::Text(json!({"id":17,"method":"item/tool/call","params":{"tool":"js"}}).to_string().into())).await.unwrap();}
                                else {assert_eq!(frame["id"],17);assert_eq!(frame["result"],json!({"handled":true}));socket.send(Message::Text(json!({"id":original,"result":{"alive":true}}).to_string().into())).await.unwrap();}
                            }
                        });
                    }
                    while let Some(result)=connections.join_next().await{result.unwrap();}
                });
                let shared=connect(host.clone(),"project",service.clone()).await.unwrap();host.schedules.connections.sessions.borrow_mut().insert("project".into(),shared.clone());
                let session=connect_owned(host.clone(),"project",service,true).await.unwrap();session.desktop.set(true);
                let lease=uuid::Uuid::new_v4().to_string();*session.workbench_lease.borrow_mut()=Some(lease.clone());host.schedules.connections.terminals.borrow_mut().insert(lease.clone(),session.clone());
                let (mut events,mut event_writer)=host_socket(host.clone()).await;
                send(&mut event_writer,"subscribe","desktop.core.subscribe",json!({"sourceId":source_id,"options":{"binary":host.bin.join("areal"),"home":source.core_home,"guiProfile":source.profile,"hostHome":host.home}})).await;
                let subscribed=crate::wire::read(&mut events).await.unwrap().unwrap();assert!(subscribed.get("error").is_none(),"{subscribed}");let attachment=subscribed["result"]["attachmentId"].as_str().unwrap().to_owned();host.schedules.connections.frontends.borrow_mut().get_mut(&attachment).unwrap().leases.insert(lease.clone(),"project".into());
                let (mut calls,mut call_writer)=host_socket(host.clone()).await;let (mut replies,mut reply_writer)=host_socket(host.clone()).await;
                send(&mut call_writer,"call","desktop.core.call",json!({"attachmentId":attachment,"call":"core.request","params":{"sourceId":source_id,"projectId":"project","lease":lease,"method":"areal/server/status","params":{}}})).await;
                let event=crate::wire::read(&mut events).await.unwrap().unwrap();assert_eq!(event["method"],"desktop.core.event");assert_eq!(event["params"]["event"]["coreRequestId"],17);
                send(&mut reply_writer,"reply","desktop.core.callback",json!({"attachmentId":attachment,"requestId":event["params"]["event"]["requestId"],"result":{"handled":true}})).await;
                assert_eq!(crate::wire::read(&mut replies).await.unwrap().unwrap()["result"]["received"],true);
                assert_eq!(crate::wire::read(&mut calls).await.unwrap().unwrap()["result"]["result"]["alive"],true);
                host.schedules.connections.workbench_close_terminals();
                assert!(!session.closed.get(),"backend cleanup cannot revoke an independent Main attachment");
                assert!(!shared.closed.get());
                let mut closed_events=session.events.subscribe();
                event_writer.shutdown().await.unwrap();drop(events);drop(event_writer);
                // 连接owner撤销经原服务事件，不能用超时重试证明关闭。
                loop {if closed_events.recv().await.unwrap().value["method"]=="host/connectionClosed"{break;}}
                assert!(host.schedules.connections.frontends.borrow().is_empty());
                assert_eq!(shared.request("areal/server/status",json!({})).await.unwrap()["alive"],true);
                assert!(!shared.closed.get());shared.close();core.await.unwrap();drop(call_writer);drop(reply_writer);
            }).await.unwrap();
        }).await;
    }
}
