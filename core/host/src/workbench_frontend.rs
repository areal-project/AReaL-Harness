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
    browser_gates: BTreeMap<String, Rc<tokio::sync::Mutex<()>>>,
    callbacks: BTreeMap<String, oneshot::Sender<Result<Value>>>,
}
impl Connections {
    pub(crate) async fn frontend_browser_lease(
        &self,
        host: &Rc<Host>,
        source: &str,
        project: &str,
    ) -> Result<Option<String>> {
        let owner = {
            let mut frontends = self.frontends.borrow_mut();
            frontends
                .iter_mut()
                .find(|(_, frontend)| frontend.source == source)
                .map(|(id, frontend)| {
                    (
                        id.clone(),
                        frontend
                            .browser_gates
                            .entry(project.into())
                            .or_insert_with(|| Rc::new(tokio::sync::Mutex::new(())))
                            .clone(),
                    )
                })
        };
        let Some((attachment, gate)) = owner else {
            return Ok(None);
        };
        let _attach = gate.lock().await;
        let existing =
            {
                let frontends = self.frontends.borrow();
                let frontend = frontends
                    .get(&attachment)
                    .context("CAPABILITY_UNAVAILABLE")?;
                frontend
                    .leases
                    .iter()
                    .find(|(lease, id)| {
                        id.as_str() == project
                            && self.terminals.borrow().get(*lease).is_some_and(|session| {
                                session.desktop.get() && !session.closed.get()
                            })
                    })
                    .map(|(lease, _)| lease.clone())
            };
        if let Some(lease) = existing {
            self.workbench_identity(host, project, &lease)?;
            return Ok(Some(lease));
        }
        let value = self.workbench_desktop_attach(host, project).await?;
        let lease = value["lease"]
            .as_str()
            .context("INVALID_RESPONSE")?
            .to_owned();
        if let Some(frontend) = self.frontends.borrow_mut().get_mut(&attachment) {
            frontend.leases.insert(lease.clone(), project.into());
            return Ok(Some(lease));
        }
        self.workbench_detach(host, project, &lease)?;
        anyhow::bail!("CAPABILITY_UNAVAILABLE")
    }

    // 共享连接就绪和Main重连都发布同一专用租约，不能让两次异步attach抢占工具宿主。
    pub(crate) fn frontend_project_ready(&self, host: &Rc<Host>, project: &str) {
        let Some(source) = host.gateway.workbench.active_source() else {
            return;
        };
        if !self
            .frontends
            .borrow()
            .values()
            .any(|frontend| frontend.source == source)
            || super::super::workbench_route::backend_project_alias(host, &source, project).is_err()
        {
            return;
        }
        let host = host.clone();
        let project = project.to_owned();
        tokio::task::spawn_local(async move {
            if host
                .schedules
                .connections
                .frontend_publish_browser(&host, &source, &project)
                .await
                .is_err()
            {
                eprintln!("Host native browser scheduled tools unavailable");
            }
        });
    }

    async fn frontend_publish_browser(
        &self,
        host: &Rc<Host>,
        source: &str,
        project: &str,
    ) -> Result<()> {
        let Some(lease) = self.frontend_browser_lease(host, source, project).await? else {
            return Ok(());
        };
        let identity = self.workbench_identity(host, project, &lease)?;
        let session = self.workbench_session(host, project, &lease)?;
        let caps = session
            .request("areal/capabilities", json!({"apiVersion":"areal.core.v1"}))
            .await?;
        ensure!(
            self.workbench_identity(host, project, &lease)? == identity,
            "RESYNC_REQUIRED"
        );
        if caps["features"]["browserToolAttachment"] != true
            || !caps["browserToolBundles"]
                .as_array()
                .is_some_and(|bundles| {
                    bundles
                        .iter()
                        .any(|bundle| bundle["bundleId"] == "areal.browser.v1")
                })
        {
            return Ok(());
        }
        session
            .request(
                "areal/task/tools/ready",
                json!({"bundles":["areal.browser.v1"]}),
            )
            .await?;
        ensure!(
            self.workbench_identity(host, project, &lease)? == identity,
            "RESYNC_REQUIRED"
        );
        Ok(())
    }

    pub(crate) fn frontend_launch_options(&self, source: &str) -> Option<Value> {
        self.frontends
            .borrow()
            .values()
            .find(|frontend| frontend.source == source)
            .map(|frontend| frontend.options.clone())
    }

    pub(crate) fn frontend_owns(&self, lease: &str) -> bool {
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
        environment_credentials: Option<std::collections::BTreeMap<String, String>>,
    ) -> Result<(Value, mpsc::Receiver<Value>)> {
        ensure!(self.frontends.borrow().len() < 16, "CAPACITY_EXCEEDED");
        ensure!(
            self.frontends
                .borrow()
                .values()
                .all(|frontend| frontend.source != source),
            "COMMAND_CONFLICT"
        );
        let options = super::super::workbench_route::frontend_options(
            host,
            source,
            options,
            environment_credentials,
        )?;
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
                browser_gates: BTreeMap::new(),
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
        host: &Host,
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
            .map(|(id, frontend)| (id.clone(), frontend.source.clone(), frontend.events.clone()));
        let (attachment, source, sender) = selected?;
        let identity = match self.workbench_identity(host, project, lease) {
            Ok(identity) => identity,
            Err(error) => return Some(Err(error)),
        };
        let target = (|| -> Result<(String, std::path::PathBuf)> {
            let alias =
                super::super::workbench_route::backend_project_alias(host, &source, project)?;
            let home = super::super::library_store::source_home(host, &source)?;
            let rows = super::super::worktree_catalog::saved_projects(&home)?;
            let logical = rows
                .iter()
                .find(|row| row["id"] == alias)
                .and_then(|row| row["logicalProjectId"].as_str())
                .unwrap_or(&alias)
                .to_owned();
            let workspace = host
                .slots
                .borrow()
                .get(project)
                .context("RESOURCE_UNAVAILABLE")?
                .registration
                .workspace
                .clone();
            Ok((logical, workspace))
        })();
        let (logical, workspace) = match target {
            Ok(target) => target,
            Err(error) => return Some(Err(error)),
        };
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
        let event = json!({"attachmentId":attachment,"event":{"event":"core.callback","requestId":request,"coreRequestId":core_request_id,"projectId":project,"lease":lease,"coreInstanceId":identity.0,"coreGeneration":identity.1,"connectionId":identity.2,"sourceId":source,"guiProjectId":logical,"workspacePath":workspace,"method":method,"params":params}});
        let sent = sender.send(event).await;
        let deadline =
            if method == "item/tool/call" && params["arguments"]["operation"] == "command" {
                Duration::from_secs(128)
            } else {
                Duration::from_secs(62)
            };
        let result = if sent.is_err() {
            Err(unavailable())
        } else {
            match tokio::time::timeout(deadline, receive).await {
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
            "browser.scope" => exact(input, &["projectId", "threadId"])?,
            "resources.prepareCreator" => {
                let _: areal_protocol::host::LocalDesktopCreatorParams =
                    serde_json::from_value(input.clone()).context("INVALID_PARAMS")?;
            }
            "resources.command" => {
                let _: areal_protocol::host::LocalDesktopResourceParams =
                    serde_json::from_value(input.clone()).context("INVALID_PARAMS")?;
            }
            "projectless.command" => {
                exact(input, &["operation", "requestId", "directory", "path"])?
            }
            "worktree.project.add" => exact(
                input,
                &["root", "worktreeResources", "projectlessRequestId"],
            )?,
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
            "cloud.session" => {
                let _: areal_protocol::host::LocalDesktopCloudSessionParams =
                    serde_json::from_value(input.clone()).context("INVALID_PARAMS")?;
            }
            "cloud.settings" => {
                let _: areal_protocol::host::LocalDesktopCloudSettingsParams =
                    serde_json::from_value(input.clone()).context("INVALID_PARAMS")?;
            }
            "cloud.import" => {
                let _: areal_protocol::host::LocalDesktopCloudImportParams =
                    serde_json::from_value(input.clone()).context("INVALID_PARAMS")?;
            }
            "cloud.configured.attach" => exact(input, &["sourceId", "baseURL"])?,
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
        if call == "resources.prepareCreator" {
            return host
                .gateway
                .workbench
                .resources
                .prepare_creator(host, &source, input)
                .await;
        }
        if call == "resources.command" {
            return host
                .gateway
                .workbench
                .resources
                .command(host, &source, input)
                .await;
        }
        if call == "projectless.command" {
            return host
                .gateway
                .workbench
                .projectless
                .command(host, &source, input)
                .await;
        }
        if call == "worktree.project.add" {
            return super::super::worktree_catalog::add_project(host, &source, input.clone()).await;
        }
        if call == "browser.scope" {
            let thread = input["threadId"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 512 && !id.contains('\0'))
                .context("INVALID_PARAMS")?;
            let target = super::super::session_commands::resolve_project_scope(
                host, &source, input, false, true,
            )
            .await?;
            let lease = self
                .frontend_browser_lease(host, &source, &target.canonical_id)
                .await?
                .context("CAPABILITY_UNAVAILABLE")?;
            let identity = self.workbench_identity(host, &target.canonical_id, &lease)?;
            let session = self.workbench_session(host, &target.canonical_id, &lease)?;
            let value = session
                .request(
                    "thread/read",
                    json!({"threadId":thread,"includeTurns":false}),
                )
                .await?;
            ensure!(
                value["thread"]["id"] == thread && value["thread"]["desktop"]["archived"] != true,
                "RESOURCE_UNAVAILABLE"
            );
            let library = super::super::library_store::read_source(host, &source)?;
            ensure!(
                library["projects"][&target.logical]["hidden"] != true,
                "FORBIDDEN"
            );
            ensure!(
                self.workbench_identity(host, &target.canonical_id, &lease)? == identity,
                "RESYNC_REQUIRED"
            );
            return Ok(json!({"sourceId":source,"projectId":target.canonical_id,
                "guiProjectId":target.logical,"workspacePath":target.workspace,"threadId":thread,"lease":lease,
                "coreInstanceId":identity.0,"coreGeneration":identity.1,"connectionId":identity.2}));
        }
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
        if call == "cloud.session" {
            return Box::pin(
                host.gateway
                    .workbench
                    .cloud
                    .sessions
                    .command(host, &source, input),
            )
            .await;
        }
        if call == "cloud.settings" {
            return host
                .gateway
                .workbench
                .cloud
                .settings(host, &source, input)
                .await;
        }
        if call == "cloud.import" {
            return host
                .gateway
                .workbench
                .cloud
                .import(host, &source, input)
                .await;
        }
        if call == "cloud.attach" || call == "cloud.configured.attach" {
            let value = if call == "cloud.configured.attach" {
                host.gateway
                    .workbench
                    .cloud
                    .attach(host, &source, input)
                    .await?
            } else {
                self.workbench_cloud_attach(host, &source, input).await?
            };
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
                let lease = self
                    .frontend_browser_lease(host, &source, project)
                    .await?
                    .context("CAPABILITY_UNAVAILABLE")?;
                let (instance, generation, connection) =
                    self.workbench_identity(host, project, &lease)?;
                let session = self.workbench_session(host, project, &lease)?;
                let caps = session
                    .request("areal/capabilities", json!({"apiVersion":"areal.core.v1"}))
                    .await?;
                ensure!(
                    self.workbench_identity(host, project, &lease)?
                        == (instance.clone(), generation.clone(), connection.clone()),
                    "RESYNC_REQUIRED"
                );
                json!({"lease":lease,"coreInstanceId":instance,"coreGeneration":generation,"connectionId":connection,"capabilities":caps})
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
                {let mut slots=host.slots.borrow_mut();let slot=slots.get_mut("project").unwrap();slot.state="ready".into();slot.service=Some(service.clone());let (writer,lifetime)=areal_local_service::OwnerLifetime::pair().unwrap();slot.writer=Some(writer);slot.lifetime=Some(Rc::new(lifetime));}
                let host=Rc::new(host);
                let (published, published_ready)=oneshot::channel();
                let published=Rc::new(RefCell::new(Some(published)));
                let core=tokio::task::spawn_local(async move {
                    let mut connections=tokio::task::JoinSet::new();
                    for index in 0..2 {
                        let (stream,_)=listener.accept().await.unwrap();
                        let published=published.clone();
                        connections.spawn_local(async move {
                            let mut socket=tokio_tungstenite::accept_async(stream).await.unwrap();let mut original=Value::Null;
                            while let Some(Ok(Message::Text(text)))=socket.next().await {
                                let frame:Value=serde_json::from_str(&text).unwrap();if frame["method"]=="initialized"{continue;}
                                if frame["method"]=="initialize" {socket.send(Message::Text(json!({"id":frame["id"],"result":{}}).to_string().into())).await.unwrap();}
                                else if frame["method"]=="thread/read" {socket.send(Message::Text(json!({"id":frame["id"],"result":{"thread":{"id":frame["params"]["threadId"],"desktop":{"archived":frame["params"]["threadId"]=="archived"}}}}).to_string().into())).await.unwrap();}
                                else if index==0 {socket.send(Message::Text(json!({"id":frame["id"],"result":{"alive":true}}).to_string().into())).await.unwrap();}
                                else if frame["method"]=="areal/capabilities" {socket.send(Message::Text(json!({"id":frame["id"],"result":{"features":{"browserToolAttachment":true},"browserToolBundles":[{"bundleId":"areal.browser.v1"}]}}).to_string().into())).await.unwrap();}
                                else if frame["method"]=="areal/task/tools/ready" {assert_eq!(frame["params"]["bundles"],json!(["areal.browser.v1"]));socket.send(Message::Text(json!({"id":frame["id"],"result":{}}).to_string().into())).await.unwrap();if let Some(done)=published.borrow_mut().take(){done.send(()).unwrap();}}
                                else if frame["method"]=="areal/thread/start" {
                                    assert_eq!(frame["params"]["dynamicTools"][0]["name"],"browser_v1");
                                    socket.send(Message::Text(json!({"id":frame["id"],"result":{"thread":{"id":"browser-created"},"requestId":frame["params"]["requestId"]}}).to_string().into())).await.unwrap();
                                }
                                else if frame["method"]=="areal/server/status" {original=frame["id"].clone();socket.send(Message::Text(json!({"id":17,"method":"item/tool/call","params":{"tool":"js"}}).to_string().into())).await.unwrap();}
                                else {assert_eq!(frame["id"],17);assert_eq!(frame["result"],json!({"handled":true}));socket.send(Message::Text(json!({"id":original,"result":{"alive":true}}).to_string().into())).await.unwrap();}
                            }
                        });
                    }
                    while let Some(result)=connections.join_next().await{result.unwrap();}
                });
                let shared=connect(host.clone(),"project",service.clone()).await.unwrap();host.schedules.connections.sessions.borrow_mut().insert("project".into(),shared.clone());

                let execution_alias=super::super::super::workbench_route::backend_project_alias(&host,&source_id,"project").unwrap();
                storage::write(&source.core_home.join("projects.json"),&json!([{"id":execution_alias,"root":shared.service.identity.workspace}])).unwrap();
                host.gateway.workbench.set_test_source_and_options(&source_id,json!({}));
                let (mut events,mut event_writer)=host_socket(host.clone()).await;
                // 过渡：到 0.2.0 删；夹具沿用来源导入的旧目录身份。
                send(&mut event_writer,"subscribe","desktop.core.subscribe",json!({"sourceId":source_id,"options":{"binary":host.bin.join("areal"),"home":source.core_home,"guiProfile":source.profile,"hostHome":host.home,"harnessHome":source.legacy_service_home}})).await;
                let subscribed=crate::wire::read(&mut events).await.unwrap().unwrap();assert!(subscribed.get("error").is_none(),"{subscribed}");let attachment=subscribed["result"]["attachmentId"].as_str().unwrap().to_owned();host.schedules.connections.frontend_project_ready(&host,"project");
                let (one,two)=tokio::join!(host.schedules.connections.frontend_browser_lease(&host,&source_id,"project"),host.schedules.connections.frontend_browser_lease(&host,&source_id,"project"));
                let lease=one.unwrap().unwrap();assert_eq!(two.unwrap(),Some(lease.clone()));
                published_ready.await.unwrap();
                let session=host.schedules.connections.terminals.borrow()[&lease].clone();
                assert_eq!(host.schedules.connections.terminals.borrow().len(),1);
                let attached=host.schedules.connections.frontend_call(&host,&json!({"attachmentId":attachment,"call":"core.attach","params":{"sourceId":source_id,"projectId":"project"}})).await.unwrap();
                assert_eq!(attached["lease"],lease,"native attach and schedule publication must share the live tool host");
                let (mut calls,mut call_writer)=host_socket(host.clone()).await;let (mut replies,mut reply_writer)=host_socket(host.clone()).await;
                send(&mut call_writer,"call","desktop.core.call",json!({"attachmentId":attachment,"call":"core.request","params":{"sourceId":source_id,"projectId":"project","lease":lease,"method":"areal/server/status","params":{}}})).await;
                let event=crate::wire::read(&mut events).await.unwrap().unwrap();assert_eq!(event["method"],"desktop.core.event");assert_eq!(event["params"]["event"]["coreRequestId"],17);assert_eq!(event["params"]["event"]["coreInstanceId"],"fixture-core");assert_eq!(event["params"]["event"]["coreGeneration"],"generation");assert_eq!(event["params"]["event"]["connectionId"],session.connection_id);assert_eq!(event["params"]["event"]["sourceId"],source_id);assert_eq!(event["params"]["event"]["guiProjectId"],execution_alias);assert_eq!(event["params"]["event"]["workspacePath"],json!(session.service.identity.workspace));
                send(&mut reply_writer,"reply","desktop.core.callback",json!({"attachmentId":attachment,"requestId":event["params"]["event"]["requestId"],"result":{"handled":true}})).await;
                assert_eq!(crate::wire::read(&mut replies).await.unwrap().unwrap()["result"]["received"],true);
                assert_eq!(crate::wire::read(&mut calls).await.unwrap().unwrap()["result"]["result"]["alive"],true);
                let launch_dir=host.home.join("host/launch").join(storage::digest(b"project"));storage::private_dir(&launch_dir).unwrap();
                storage::write(&launch_dir.join("inputs.json"),&crate::LaunchInputs{workspace:shared.service.identity.workspace.clone(),cwd:shared.service.identity.workspace.clone(),config_home:root.path().to_owned(),homedir:None,config_path:None,deployment_path:None,schedule_preparation:None,environment:Default::default(),credential_names:Vec::new(),options:Default::default()}).unwrap();
                let creation=uuid::Uuid::new_v4().to_string();
                super::super::super::worktree_catalog::prepare_thread_target(&host,"host","project",json!({"requestId":creation})).await.unwrap();
                let created=super::super::super::worktree_catalog::bind_thread_target_with_lease(&host,"host","project",&creation,json!({"requestId":creation,"dynamicTools":[areal_protocol::desktop::browser_v1_tool()]}),Some(&lease)).await.unwrap();
                assert_eq!(created["threadId"],"browser-created","creation must use the original Main callback connection");
                storage::private_dir(&source.core_home.join("thread-owners")).unwrap();
                storage::write(&source.core_home.join("thread-owners").join(format!("{execution_alias}.json")),&json!(["browser-created","archived"])).unwrap();
                let scoped=host.schedules.connections.frontend_call(&host,&json!({"attachmentId":attachment,"call":"browser.scope","params":{"projectId":execution_alias,"threadId":"browser-created"}})).await.unwrap();
                assert_eq!(scoped["projectId"],"project");assert_eq!(scoped["guiProjectId"],execution_alias);assert_eq!(scoped["workspacePath"],json!(session.service.identity.workspace));assert_eq!(scoped["threadId"],"browser-created");assert_eq!(scoped["lease"],lease);
                assert!(host.schedules.connections.frontend_call(&host,&json!({"attachmentId":attachment,"call":"browser.scope","params":{"projectId":execution_alias,"threadId":"archived"}})).await.is_err());

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
