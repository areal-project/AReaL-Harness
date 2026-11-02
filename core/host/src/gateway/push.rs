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
                    .is_some_and(|caps| caps.iter().any(|cap| cap == "answer"))
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
                    let page=session::overview::read_attention(&params,100,|query|host.schedules.connections.remote_request(&host,&project,&epoch.0,&epoch.1,&epoch.2,"areal/work/overview",query)).await?;
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
                            let peer=grant["devicePeerId"].as_str().context("invalid peer")?.to_owned();
                            let revision=grant["revision"].clone();let push=grant["push"].clone();
                            let mut target=json!({"projectId":alias,"attentionRef":reference});
                            if let Some(thread)=row["threadId"].as_str() {target["threadId"]=json!(thread);}
                            let message=json!({"type":"push","token":push["token"],"environment":push["environment"],"collapseId":window.1,"kind":"attention","count":window.2,"target":target});
                            let weak=Rc::downgrade(&host);let source=source.clone();let project=project.clone();let alias=alias.clone();let epoch=epoch.clone();let transport=transport.clone();let generation=generation.clone();
                            let authorized=Rc::new(move || weak.upgrade().is_some_and(|host| {
                                host.gateway.current(&generation)
                                && host.schedules.connections.shared_identity(&host,&project).ok().as_ref()==Some(&epoch)
                                && host.remote.snapshot(&host.migration).ok().is_some_and(|snapshot|snapshot["sourceId"]==source && transport_key(&snapshot["config"],TransportKind::Relay)==transport
                                    && bindings(&host,&source).ok().is_some_and(|bindings|bindings.iter().any(|binding|binding==&(project.clone(),alias.clone())))
                                    && eligible(&host,&snapshot,&alias,&peer,&revision,&push))
                            }));
                            if !handle.try_push(message,authorized) { *host.gateway.push_diagnostic.borrow_mut()="push-unavailable".into(); }
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
