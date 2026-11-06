use super::*;
use serde::Serialize;
use std::{cell::Cell, collections::BTreeSet, time::Instant};

pub(super) fn bindings(host: &Host, source: &str) -> Result<Vec<(String, String)>> {
    let current = host
        .slots
        .borrow()
        .values()
        .map(|slot| slot.registration.clone())
        .collect::<Vec<_>>();
    host.migration.remote_bindings(source, &current)
}
fn replace(
    host: &Host,
    snapshot: &Value,
    config: Value,
    id: String,
    digest: Option<String>,
) -> Result<()> {
    host.admission()?;
    let source = snapshot["sourceId"]
        .as_str()
        .context("RESOURCE_UNAVAILABLE")?;
    let current = host
        .slots
        .borrow()
        .values()
        .map(|slot| slot.registration.clone())
        .collect::<Vec<_>>();
    let projects = host.migration.remote_projects(source, &current)?;
    let receipt = host.remote.dispatch("remote.gateway.replace", json!({"requestId":id,"expectedGeneration":host.identity.generation,"expectedRevision":snapshot["revision"],"sourceId":source,"config":config,"controlDigest":digest}), "native-gateway-push", &host.identity.generation, &host.migration, &projects)?;
    ensure!(receipt["state"] == "completed", "CORE_UNAVAILABLE");
    host.changed();
    Ok(())
}
fn operation_id(source: &str, peer: &str, command: &str) -> String {
    let hash = storage::digest(
        &serde_json::to_vec(&json!(["device-push", source, peer, command])).unwrap(),
    );
    uuid::Uuid::parse_str(&hash[..32]).unwrap().to_string()
}
pub(super) fn device_command(host: &Host, peer: &str, request: &Value) -> Result<Value> {
    let method = request["method"].as_str().unwrap();
    let read = method == "command.read";
    ensure!(
        !read || request.get("commandId").is_none(),
        "INVALID_PARAMS"
    );
    let params = &request["params"];
    let original = if read {
        &params["commandId"]
    } else {
        &request["commandId"]
    };
    let raw_id = original.as_str().context("INVALID_PARAMS")?;
    ensure!(raw_id.len() == 36, "INVALID_PARAMS");
    let id = uuid::Uuid::parse_str(raw_id)
        .context("INVALID_PARAMS")?
        .to_string();
    let register = method == "device.push.register";
    let keys: &[&str] = if read {
        &["commandId"]
    } else if register {
        &["platform", "token", "environment"]
    } else {
        &[]
    };
    ensure!(
        params
            .as_object()
            .is_some_and(|p| p.keys().all(|key| keys.contains(&key.as_str()))),
        "INVALID_PARAMS"
    );
    let push = if register {
        let token = params["token"]
            .as_str()
            .filter(|token| {
                (64..=200).contains(&token.len())
                    && token.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
            .context("INVALID_PARAMS")?;
        ensure!(
            params["platform"] == "apns"
                && matches!(
                    params["environment"].as_str(),
                    Some("production" | "development")
                ),
            "INVALID_PARAMS"
        );
        Some(
            json!({"platform":"apns","token":token.to_lowercase(),"environment":params["environment"]}),
        )
    } else {
        None
    };
    #[derive(Serialize)]
    struct Registration<'a> {
        platform: &'a str,
        token: &'a str,
        environment: &'a str,
    }
    #[derive(Serialize)]
    struct Intent<'a, T> {
        method: &'a str,
        params: T,
    }
    let digest = if let Some(push) = &push {
        storage::digest(&serde_json::to_vec(&Intent {
            method,
            params: Registration {
                platform: "apns",
                token: push["token"].as_str().unwrap(),
                environment: push["environment"].as_str().unwrap(),
            },
        })?)
    } else {
        storage::digest(&serde_json::to_vec(&Intent {
            method,
            params: serde_json::Map::<String, Value>::new(),
        })?)
    };
    let snapshot = host.remote.snapshot(&host.migration)?;
    let mut config = snapshot["config"].clone();
    grant(&config, peer).context("GRANT_CHANGED")?;
    let commands = config["pushCommands"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let original = commands
        .iter()
        .find(|row| row["devicePeerId"] == peer && row["commandId"] == id);
    if read {
        return Ok(match original {
            Some(row) => {
                json!({"commandId":id,"method":row["method"],"admissionState":"accepted","submissionUnknown":false,"receipt":{"registered":row["registered"]}})
            }
            None => json!({"commandId":id,"admissionState":"notFound","submissionUnknown":true}),
        });
    }
    if let Some(row) = original {
        ensure!(row["semanticDigest"] == digest, "COMMAND_CONFLICT");
        return Ok(json!({"registered":row["registered"]}));
    }
    let source = snapshot["sourceId"]
        .as_str()
        .context("RESOURCE_UNAVAILABLE")?;
    let operation = operation_id(source, peer, &id);
    if let Some(previous) = host.remote.operation(&operation, &host.migration)? {
        ensure!(previous["controlDigest"] == digest, "COMMAND_CONFLICT");
        anyhow::bail!("CORE_UNAVAILABLE");
    }
    ensure!(
        !register || host.gateway.push_supported.get(),
        "RESOURCE_UNAVAILABLE"
    );
    ensure!(commands.len() < 4096, "CAPACITY_EXCEEDED");
    for row in config["deviceGrants"]
        .as_array_mut()
        .context("GRANT_CHANGED")?
    {
        if row["devicePeerId"] == peer {
            if let Some(push) = push.clone() {
                row["push"] = push;
            } else {
                row.as_object_mut().unwrap().remove("push");
            }
        }
    }
    let mut commands = commands;
    commands.push(json!({"devicePeerId":peer,"commandId":id,"method":method,"semanticDigest":digest,"registered":register}));
    config["pushCommands"] = json!(commands);
    replace(host, &snapshot, config, operation, Some(digest))?;
    Ok(json!({"registered":register}))
}
pub(super) fn unregister_token(host: &Host, token: &str) -> Result<()> {
    let snapshot = host.remote.snapshot(&host.migration)?;
    let mut config = snapshot["config"].clone();
    let mut changed = false;
    for grant in config["deviceGrants"]
        .as_array_mut()
        .context("invalid grants")?
    {
        if grant["push"]["token"] == token {
            grant.as_object_mut().unwrap().remove("push");
            changed = true;
        }
    }
    if changed {
        replace(
            host,
            &snapshot,
            config,
            uuid::Uuid::new_v4().to_string(),
            None,
        )?;
    }
    Ok(())
}
#[derive(Default)]
pub(super) struct Attention {
    projects: BTreeMap<String, Project>,
}
struct Project {
    epoch: (String, String, String),
    seen: BTreeSet<String>,
    scan: BTreeSet<String>,
    cursor: Option<String>,
    initialized: bool,
    summaries_complete: bool,
    window: Option<(Instant, String, u64)>,
}
pub(super) struct ScanSlot(pub Rc<Cell<bool>>);
impl Drop for ScanSlot {
    fn drop(&mut self) {
        self.0.set(false);
    }
}
fn eligible(
    host: &Host,
    snapshot: &Value,
    alias: &str,
    peer: &str,
    revision: &Value,
    push: &Value,
    capability: &str,
) -> bool {
    host.gateway.push_supported.get()
        && grant(&snapshot["config"], peer).is_some_and(|grant| {
            grant["revision"] == *revision
                && grant["push"] == *push
                && grant["projectIds"]
                    .as_array()
                    .is_some_and(|ids| ids.iter().any(|id| id == alias))
                && grant["capabilities"]
                    .as_array()
                    .is_some_and(|caps| caps.iter().any(|cap| cap == capability))
                && !host.gateway.active.borrow().values().any(|active| {
                    active.peer == peer
                        && active.revision == *revision
                        && active.transport == transport_key(&snapshot["config"], active.kind)
                })
        })
}
impl Attention {
    pub(super) async fn tick(
        &mut self,
        host: Rc<Host>,
        handle: RelayHandle,
        transport: String,
        generation: String,
    ) -> Result<()> {
        let snapshot = host.remote.snapshot(&host.migration)?;
        let source = snapshot["sourceId"]
            .as_str()
            .context("missing source")?
            .to_owned();
        let mut active = BTreeSet::new();
        for (project, alias) in bindings(&host, &source)? {
            let grants = snapshot["config"]["deviceGrants"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|grant| {
                    grant["status"] == "active"
                        && grant["push"].is_object()
                        && grant["projectIds"]
                            .as_array()
                            .is_some_and(|ids| ids.iter().any(|id| id == &alias))
                        && grant["capabilities"].as_array().is_some_and(|caps| {
                            ["observe", "answer"]
                                .iter()
                                .all(|key| caps.iter().any(|cap| cap == key))
                        })
                })
                .cloned()
                .collect::<Vec<_>>();
            if grants.is_empty() {
                continue;
            }
            let Ok(epoch) = host.schedules.connections.shared_identity(&host, &project) else {
                continue;
            };
            active.insert(project.clone());
            let state = self
                .projects
                .entry(project.clone())
                .or_insert_with(|| Project {
                    epoch: epoch.clone(),
                    seen: BTreeSet::new(),
                    scan: BTreeSet::new(),
                    cursor: None,
                    initialized: false,
                    summaries_complete: true,
                    window: None,
                });
            if state.epoch != epoch {
                *state = Project {
                    epoch: epoch.clone(),
                    seen: BTreeSet::new(),
                    scan: BTreeSet::new(),
                    cursor: None,
                    initialized: false,
                    summaries_complete: true,
                    window: None,
                };
            }
            let result: Result<()> = async {
                for _ in 0..8 {
                    let mut params=json!({});
                    if let Some(cursor)=&state.cursor {params["cursor"]=json!(cursor);}
                    let page=session::overview::read_attention(&params,100,|query|host.schedules.connections.remote_request(&host, &project, (&epoch.0, &epoch.1, &epoch.2), "areal/work/overview", query)).await?;
                    state.summaries_complete &= page["summariesComplete"]==true;
                    for row in page["data"].as_array().context("invalid attention page")? {
                        if !matches!(row["kind"].as_str(),Some("approval"|"syncQuestion"|"asyncQuestion")) {continue;}
                        let Some(reference)=row["attentionRef"].as_str() else {continue;};
                        if state.scan.len()>=4096 || state.seen.len()>=4096 {continue;}
                        state.scan.insert(reference.to_owned());
                        if !state.initialized || !state.seen.insert(reference.to_owned()) {continue;}
                        if state.window.as_ref().is_none_or(|window|window.0.elapsed()>=Duration::from_secs(30)) {state.window=Some((Instant::now(),uuid::Uuid::new_v4().to_string(),0));}
                        let window=state.window.as_mut().unwrap();window.2+=1;
                        for grant in &grants {
                            let push=&grant["push"];
                            let mut target=json!({"projectId":alias,"attentionRef":reference});
                            if let Some(thread)=row["threadId"].as_str() {target["threadId"]=json!(thread);}
                            let message=json!({"type":"push","token":push["token"],"environment":push["environment"],"collapseId":window.1,"kind":"attention","count":window.2,"target":target});
                            let route=Route {source:source.clone(),project:project.clone(),alias:alias.clone(),epoch:epoch.clone(),transport:transport.clone(),generation:generation.clone()};
                            route.publish(&host,&handle,grant,message,"answer");
                        }
                    }
                    state.cursor=page["nextCursor"].as_str().map(str::to_owned);
                    if page["complete"]==true {
                        state.seen.extend(std::mem::take(&mut state.scan));
                        state.initialized |= state.summaries_complete;state.summaries_complete=true;break;
                    }
                }
                Ok(())
            }.await;
            if result.is_err() {
                self.projects.remove(&project);
            }
        }
        self.projects.retain(|project, _| active.contains(project));
        Ok(())
    }
}

#[derive(Clone)]
struct Route {
    source: String,
    project: String,
    alias: String,
    epoch: (String, String, String),
    transport: String,
    generation: String,
}
impl Route {
    fn recipient(&self, host: &Host, peer: &str) -> Result<Option<Value>> {
        ensure!(
            host.gateway.current(&self.generation)
                && host
                    .schedules
                    .connections
                    .shared_identity(host, &self.project)?
                    == self.epoch,
            "RESYNC_REQUIRED"
        );
        let snapshot = host.remote.snapshot(&host.migration)?;
        ensure!(
            snapshot["sourceId"] == self.source
                && transport_key(&snapshot["config"], TransportKind::Relay) == self.transport
                && bindings(host, &self.source)?
                    .iter()
                    .any(|binding| binding == &(self.project.clone(), self.alias.clone())),
            "RESYNC_REQUIRED"
        );
        Ok(grant(&snapshot["config"], peer).filter(|grant| {
            grant["push"].is_object()
                && grant["projectIds"]
                    .as_array()
                    .is_some_and(|ids| ids.iter().any(|id| id == &self.alias))
        }))
    }
    fn publish(
        &self,
        host: &Rc<Host>,
        handle: &RelayHandle,
        grant: &Value,
        message: Value,
        capability: &'static str,
    ) {
        let weak = Rc::downgrade(host);
        let route = self.clone();
        let peer = grant["devicePeerId"].as_str().unwrap().to_owned();
        let revision = grant["revision"].clone();
        let push = grant["push"].clone();
        let authorized = Rc::new(move || {
            weak.upgrade().is_some_and(|host| {
                host.gateway.current(&route.generation)
                    && host
                        .schedules
                        .connections
                        .shared_identity(&host, &route.project)
                        .ok()
                        .as_ref()
                        == Some(&route.epoch)
                    && host
                        .remote
                        .snapshot(&host.migration)
                        .ok()
                        .is_some_and(|snapshot| {
                            snapshot["sourceId"] == route.source
                                && transport_key(&snapshot["config"], TransportKind::Relay)
                                    == route.transport
                                && bindings(&host, &route.source).ok().is_some_and(|bindings| {
                                    bindings.iter().any(|binding| {
                                        binding == &(route.project.clone(), route.alias.clone())
                                    })
                                })
                                && eligible(
                                    &host,
                                    &snapshot,
                                    &route.alias,
                                    &peer,
                                    &revision,
                                    &push,
                                    capability,
                                )
                        })
            })
        });
        if authorized() && !handle.try_push(message, authorized) {
            *host.gateway.push_diagnostic.borrow_mut() = "push-unavailable".into();
        }
    }
}
pub(super) struct CompletionSeed {
    pub native: Value,
    pub barrier: u64,
    pub observation: crate::server::schedule_connection::CoreObservation,
    pub scope: (String, String, String),
}
pub(super) struct Completion {
    project: String,
    alias: String,
    record: Value,
    baseline: bool,
    seed: Option<CompletionSeed>,
}
fn completion_key(record: &Value) -> String {
    serde_json::to_string(&json!([
        record["remote"]["projectId"],
        record["remote"]["devicePeerId"],
        record["remote"]["commandId"]
    ]))
    .unwrap()
}
pub(super) struct Sending {
    keys: Rc<RefCell<BTreeSet<String>>>,
    key: String,
}
impl Drop for Sending {
    fn drop(&mut self) {
        self.keys.borrow_mut().remove(&self.key);
    }
}
pub(super) fn sending(host: &Host, record: &Value) -> Sending {
    let key = completion_key(record);
    host.gateway.sending.borrow_mut().insert(key.clone());
    Sending {
        keys: host.gateway.sending.clone(),
        key,
    }
}
pub(super) fn awaiting(host: &Host, record: &Value) -> bool {
    host.gateway
        .sending
        .borrow()
        .contains(&completion_key(record))
}
pub(super) fn track(host: &Host, project: &str, alias: &str, record: &Value, baseline: bool) {
    track_seed(host, project, alias, record, baseline, None);
}
pub(super) fn track_seed(
    host: &Host,
    project: &str,
    alias: &str,
    record: &Value,
    baseline: bool,
    seed: Option<CompletionSeed>,
) {
    if !host.gateway.push_supported.get()
        || record["admissionState"] != "accepted"
        || record["remote"]["method"] != "session.send"
    {
        return;
    }
    let key = completion_key(record);
    let baseline = baseline && !awaiting(host, record);
    let mut pending = host.gateway.completions.borrow_mut();
    if let Some(previous) = pending.get_mut(&key) {
        previous.baseline &= baseline;
        if previous.seed.is_none() {
            previous.seed = seed;
        }
        return;
    }
    if pending.len() >= 8192 {
        *host.gateway.push_diagnostic.borrow_mut() = "push-watch-capacity".into();
        return;
    }
    pending.insert(
        key,
        Completion {
            project: project.into(),
            alias: alias.into(),
            record: record.clone(),
            baseline,
            seed,
        },
    );
    host.gateway.completion_changed.notify_one();
}
pub(super) async fn historical(host: &Rc<Host>) {
    let Ok(snapshot) = host.remote.snapshot(&host.migration) else {
        return;
    };
    let Some(source) = snapshot["sourceId"].as_str() else {
        return;
    };
    let Ok(bindings) = bindings(host, source) else {
        return;
    };
    for (project, alias) in bindings {
        if host
            .schedules
            .connections
            .shared_identity(host, &project)
            .is_err()
            || !snapshot["config"]["deviceGrants"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|grant| {
                    grant["status"] == "active"
                        && grant["push"].is_object()
                        && grant["projectIds"]
                            .as_array()
                            .is_some_and(|ids| ids.iter().any(|id| id == &alias))
                        && grant["capabilities"]
                            .as_array()
                            .is_some_and(|caps| caps.iter().any(|cap| cap == "observe"))
                })
        {
            continue;
        }
        let Ok((_, journal)) = host.journal.native_snapshot(&project) else {
            continue;
        };
        for record in journal["outcomes"]
            .as_object()
            .into_iter()
            .flat_map(|rows| rows.values())
        {
            let record = if legacy::is_legacy(record) {
                legacy::recover(host, source, &project, &alias, record).await
            } else {
                record.clone()
            };
            if !legacy::is_legacy(&record)
                || legacy::observed_store(host, source, &project, &alias, &record).is_ok()
            {
                track(host, &project, &alias, &record, true);
            }
        }
    }
}
pub(super) fn start_completions(host: &Rc<Host>, running: &mut Running) {
    let pending = std::mem::take(&mut *host.gateway.completions.borrow_mut());
    for (key, completion) in pending {
        if running.commands.contains(&key) {
            continue;
        }
        if running.commands.len() >= 8192 {
            *host.gateway.push_diagnostic.borrow_mut() = "push-watch-capacity".into();
            continue;
        }
        let Ok(snapshot) = host.remote.snapshot(&host.migration) else {
            continue;
        };
        let Some(peer) = completion.record["remote"]["devicePeerId"].as_str() else {
            continue;
        };
        let Some(grant) = grant(&snapshot["config"], peer) else {
            continue;
        };
        if !grant["push"].is_object()
            || completion.record["remote"]["hostId"] != running.identity.peer().to_string()
            || completion.record["remote"]["projectId"] != completion.alias
            || !grant["projectIds"]
                .as_array()
                .is_some_and(|ids| ids.iter().any(|id| id == &completion.alias))
        {
            continue;
        }
        let Ok(epoch) = host
            .schedules
            .connections
            .shared_identity(host, &completion.project)
        else {
            continue;
        };
        let Some(source) = snapshot["sourceId"].as_str() else {
            continue;
        };
        let route = Route {
            source: source.into(),
            project: completion.project.clone(),
            alias: completion.alias.clone(),
            epoch,
            transport: running.transport.clone(),
            generation: host.gateway.generation.borrow().clone(),
        };
        running.commands.insert(key.clone());
        let host = host.clone();
        let handle = running.handle.clone();
        running.tasks.spawn_local(async move {
            if completion
                .run(host.clone(), handle, route, key)
                .await
                .is_err()
            {
                *host.gateway.push_diagnostic.borrow_mut() = "push-watch-unavailable".into();
            }
        });
    }
}
enum CompletionState {
    Pending,
    Terminal(String),
    Unavailable,
}
impl Completion {
    fn state(&self, native: &Value) -> CompletionState {
        let thread = &native["thread"];
        if thread["id"] != self.record["threadId"] {
            return CompletionState::Unavailable;
        }
        let mut turn = self.record["turnId"].as_str();
        if let Some(queue) = self.record["receipt"]["queueItemId"].as_str() {
            let Some(item) = thread["desktop"]["queue"]["items"]
                .as_array()
                .and_then(|items| items.iter().find(|item| item["id"] == queue))
            else {
                return CompletionState::Unavailable;
            };
            turn = item["turnId"].as_str();
            if turn.is_none()
                && matches!(
                    item["status"].as_str(),
                    Some("removed" | "failed" | "cancelled")
                )
            {
                return CompletionState::Unavailable;
            }
            if turn.is_none() {
                return CompletionState::Pending;
            }
            if matches!(
                item["status"].as_str(),
                Some("completed" | "failed" | "interrupted" | "cancelled")
            ) {
                return CompletionState::Terminal(item["status"].as_str().unwrap().into());
            }
        }
        let Some(turn) = turn else {
            return CompletionState::Unavailable;
        };
        let Some(turn) = thread["turns"]
            .as_array()
            .and_then(|turns| turns.iter().find(|item| item["id"] == turn))
        else {
            return CompletionState::Unavailable;
        };
        match turn["status"].as_str() {
            Some(status @ ("completed" | "failed" | "interrupted" | "cancelled")) => {
                CompletionState::Terminal(status.into())
            }
            _ => CompletionState::Pending,
        }
    }
    async fn run(
        mut self,
        host: Rc<Host>,
        handle: RelayHandle,
        route: Route,
        key: String,
    ) -> Result<()> {
        let thread = self.record["threadId"]
            .as_str()
            .context("missing original thread")?;
        let peer = self.record["remote"]["devicePeerId"]
            .as_str()
            .context("missing original peer")?;
        let mut changes = host.changes.subscribe();
        let (mut native, mut barrier, mut observation) = if let Some(seed) = self.seed.take() {
            ensure!(
                seed.scope == route.epoch && seed.observation.current(&host),
                "RESYNC_REQUIRED"
            );
            (seed.native, seed.barrier, seed.observation)
        } else {
            host.schedules
                .connections
                .remote_observe(&host, &self.project, &route.epoch.1, thread)
                .await?
        };
        let capabilities = host
            .schedules
            .connections
            .remote_request(
                &host,
                &self.project,
                (&route.epoch.0, &route.epoch.1, &route.epoch.2),
                "areal/capabilities",
                json!({}),
            )
            .await?;
        let binding = &capabilities["features"]["threadCreationJournal"]["binding"];
        if legacy::is_legacy(&self.record) {
            let store = legacy::observed_store(
                &host,
                &route.source,
                &self.project,
                &self.alias,
                &self.record,
            )?;
            ensure!(
                store.service_id == route.epoch.0
                    && binding["identity"] == store.identity
                    && binding["journalEpoch"] == store.journal_epoch,
                "RESYNC_REQUIRED"
            );
        } else {
            let original = &self.record["coreScope"]["storeBinding"];
            ensure!(
                self.record["coreScope"]["serviceId"] == route.epoch.0
                    && original["identity"].is_string()
                    && original["journalEpoch"].is_string()
                    && binding["identity"] == original["identity"]
                    && binding["journalEpoch"] == original["journalEpoch"],
                "RESYNC_REQUIRED"
            );
        }
        let mut initial = true;
        loop {
            ensure!(
                observation.current(&host) && host.gateway.current(&route.generation),
                "RESYNC_REQUIRED"
            );
            let Some(grant) = route.recipient(&host, peer)? else {
                return Ok(());
            };
            match self.state(&native) {
                CompletionState::Terminal(status) => {
                    if initial && self.baseline {
                        return Ok(());
                    }
                    let push = &grant["push"];
                    let message = json!({"type":"push","token":push["token"],"environment":push["environment"],"collapseId":storage::digest(key.as_bytes()),"kind":if status=="completed" {"turnCompleted"} else {"turnFailed"},"count":1,"target":{"projectId":self.alias,"threadId":thread}});
                    route.publish(&host, &handle, &grant, message, "observe");
                    return Ok(());
                }
                CompletionState::Unavailable => {
                    *host.gateway.push_diagnostic.borrow_mut() = "push-turn-unavailable".into();
                    return Ok(());
                }
                CompletionState::Pending => {}
            }
            loop {
                let event = tokio::select! {
                    event=observation.events.recv()=>event?,
                    changed=changes.changed()=> {
                        changed?;
                        if route.recipient(&host,peer)?.is_none() {return Ok(());}
                        continue;
                    }
                };
                if event.sequence <= barrier {
                    continue;
                }
                let params = &event.value["params"];
                if params
                    .get("threadId")
                    .or_else(|| params["thread"].get("id"))
                    .or_else(|| params["interaction"].get("threadId"))
                    .and_then(Value::as_str)
                    == Some(thread)
                {
                    break;
                }
            }
            (native, barrier) = observation.snapshot(&host).await?;
            initial = false;
        }
    }
}
