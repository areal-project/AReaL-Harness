//! 供应商设置目录由 Host 读取；凭据和在线应用证明只在后台核验。
use super::{Host, workbench_utility};
use anyhow::{Context, Result, ensure};
use areal_local_service::storage;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    rc::Rc,
    time::{Duration, Instant},
};

#[derive(Default)]
pub(super) struct Providers {
    checked: RefCell<Option<Checked>>,
    checking: Cell<bool>,
    writing: tokio::sync::Mutex<()>,
}
impl Providers {
    pub(super) fn updating(&self) -> bool {
        self.writing.try_lock().is_err()
    }
}
struct Checked {
    stamp: Value,
    execution: Value,
    project_executions: BTreeMap<String, Value>,
    snapshot: Value,
    errors: Value,
    proofs: BTreeMap<String, Value>,
    at: Instant,
}
#[derive(Clone)]
struct Target {
    id: String,
    alias: String,
    root: Value,
    running: bool,
    identity: Option<(String, String, String)>,
}
fn targets(host: &Host, source: &str) -> Result<Vec<Target>> {
    let home = super::library_store::source_home(host, source)?;
    let profile = host.migration.source_profile(source)?;
    let mut targets: BTreeMap<_, _> = super::worktree_catalog::saved_projects(&home)?
        .into_iter()
        .map(|row| {
            let alias = row["id"].as_str().unwrap().to_owned();
            (
                alias.clone(),
                Target {
                    id: String::new(),
                    alias,
                    root: row["root"].clone(),
                    running: false,
                    identity: None,
                },
            )
        })
        .collect();
    let registrations: Vec<_> = host
        .slots
        .borrow()
        .values()
        .map(|slot| (slot.registration.clone(), slot.state.clone()))
        .collect();
    let aliases: BTreeMap<_, _> = host
        .migration
        .remote_bindings(
            source,
            &registrations
                .iter()
                .map(|(registration, _)| registration.clone())
                .collect::<Vec<_>>(),
        )?
        .into_iter()
        .collect();
    for (registration, state) in registrations {
        let owned = match &registration.source {
            crate::ProjectSource::Gui { profile: owner, .. } if *owner == profile => true,
            _ if host.project_uses_shared_config(&registration)
                && host
                    .migration
                    .shared_credential_source(&registration, true)?
                    .as_deref()
                    == Some(source) =>
            {
                true
            }
            _ => false,
        };
        if !owned {
            continue;
        }
        let id = registration.project_id;
        let alias = aliases.get(&id).context("RESOURCE_UNAVAILABLE")?.clone();
        targets.insert(
            alias.clone(),
            Target {
                identity: host.schedules.connections.shared_identity(host, &id).ok(),
                id,
                alias,
                root: json!(registration.workspace),
                running: !matches!(state.as_str(), "stopped" | "registered"),
            },
        );
    }
    Ok(targets.into_values().collect())
}
fn stamp(host: &Host, source: &str, snapshot: &Value) -> Result<Value> {
    Ok(
        json!({"source":source,"catalog":snapshot,"credentials":host.migration.vault.provider_stamp(source)?,
        "environment":storage::digest(&serde_json::to_vec(&host.gateway.workbench.environment_credentials(source))?)}),
    )
}
fn model_version_prefix(catalog_revision: &str) -> &str {
    // model_catalog_revision 格式为 connectionId:modelRevision:catalogPublished:applicationRevision；
    // 前两段唯一标识本连接上 Core 已应用的模型配置版本，不随异步目录缓存或 applied 状态发布抖动。
    let mut parts = catalog_revision.splitn(3, ':');
    match (parts.next(), parts.next()) {
        (Some(connection), Some(model_revision)) => {
            &catalog_revision[..connection.len() + 1 + model_revision.len()]
        }
        _ => catalog_revision,
    }
}
fn project_proof_version(host: &Host, target: &Target) -> Value {
    json!([
        target.id,
        target.running,
        target
            .identity
            .as_ref()
            .map(|(service, generation, _)| (service, generation)),
        host.schedules
            .connections
            .model_catalog_revision(host, &target.id)
            .ok()
            .map(|revision| model_version_prefix(&revision).to_owned()),
    ])
}
fn project_execution_stamp(host: &Host, target: &Target) -> Value {
    json!([
        target.id,
        target.alias,
        target.root,
        target.running,
        target
            .identity
            .as_ref()
            .map(|(service, generation, _)| (service, generation)),
        host.schedules
            .connections
            .model_catalog_revision(host, &target.id)
            .ok(),
        host.schedules
            .connections
            .model_application(host, &target.id)
            .ok()
    ])
}
fn project_execution_stamps(host: &Host, targets: &[Target]) -> BTreeMap<String, Value> {
    targets
        .iter()
        .filter(|target| !target.id.is_empty())
        .map(|target| (target.id.clone(), project_proof_version(host, target)))
        .collect()
}
fn execution_stamp(host: &Host, targets: &[Target]) -> Value {
    json!(
        targets
            .iter()
            .map(|target| project_execution_stamp(host, target))
            .collect::<Vec<_>>()
    )
}
fn reusable_proof<'a>(
    checked: &'a Checked,
    target_id: &str,
    project_execution: &Value,
) -> Option<&'a Value> {
    // 只有同一项目的执行版本与采样时一致才复用证明，防止同代际切走配置后旧证明误标已应用。
    (checked.project_executions.get(target_id) == Some(project_execution))
        .then(|| checked.proofs.get(target_id))
        .flatten()
}
fn reusable_proofs<'a>(
    checked: &'a Checked,
    project_executions: &'a BTreeMap<String, Value>,
) -> BTreeMap<&'a str, &'a Value> {
    project_executions
        .iter()
        .filter_map(|(id, execution)| {
            reusable_proof(checked, id, execution).map(|proof| (id.as_str(), proof))
        })
        .collect()
}
fn projection_revision(
    stamp: &Value,
    execution: &Value,
    project_executions: &BTreeMap<String, Value>,
    checked: Option<&Checked>,
) -> Result<String> {
    // 版本必须反映 read() 实际可用的证明；同内容证明重新有效时也要唤醒客户端重读。
    Ok(storage::digest(&serde_json::to_vec(&json!([
        stamp,
        execution,
        checked.map(|checked| json!([
            checked.snapshot,
            checked.errors,
            reusable_proofs(checked, project_executions)
        ]))
    ]))?))
}
pub(super) fn base_url(endpoint: &str) -> String {
    let value = endpoint.strip_suffix('/').unwrap_or(endpoint);
    value
        .strip_suffix("/responses")
        .or_else(|| value.strip_suffix("/chat/completions"))
        .unwrap_or(endpoint)
        .to_owned()
}
fn connection(provider: &Value, sources: &Value, definitions: &[Value]) -> Result<Value> {
    let base = base_url(provider["endpoint"].as_str().context("INVALID_RESPONSE")?);
    let protocol = if provider["protocol"] == "chat-completions" {
        "chatCompletions"
    } else {
        provider["protocol"].as_str().context("INVALID_RESPONSE")?
    };
    let preset = definitions
        .iter()
        .find(|item| {
            item["kind"] == "api"
                && item["baseUrl"] == base
                && item["protocols"]
                    .as_array()
                    .is_some_and(|values| values.iter().any(|value| value == protocol))
        })
        .or_else(|| {
            definitions
                .iter()
                .find(|item| item["id"] == "custom-compatible")
        })
        .context("missing provider definition")?;
    let region = preset["regions"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["baseUrl"] == base))
        .map(|row| row["id"].clone())
        .unwrap_or(Value::Null);
    Ok(
        json!({"definitionId":preset["id"],"connectionId":provider["id"],"billing":preset["billing"],
        "authentication":if provider["apiKeyEnv"].is_string(){"apiKey"}else{"none"},
        "credentialSource":sources[provider["id"].as_str().context("INVALID_RESPONSE")?].as_str().unwrap_or("none"),
        "region":region,"discovery":preset["discovery"],"capabilityDefaults":preset["capabilityDefaults"]}),
    )
}
fn credentials_ready(proof: &Value, snapshot: &Value, errors: &Value) -> bool {
    let default_provider = snapshot["defaultModel"]["providerId"].as_str();
    snapshot["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|provider| provider["enabled"] == true)
        .all(|provider| {
            let id = provider["id"].as_str().unwrap_or("");
            if !provider["apiKeyEnv"].is_string() {
                return true;
            }
            if errors.get(id).is_some_and(|error| !error.is_null()) {
                return false;
            }
            if snapshot["credentialStates"][id] == "unavailable" {
                return default_provider != Some(id);
            }
            snapshot["credentialStates"][id] == "available"
                && proof["credentialStates"][id] == "available"
        })
}
impl Providers {
    pub(super) async fn write(
        self: &Rc<Self>,
        host: &Rc<Host>,
        source: &str,
        command: &str,
        request: &Value,
    ) -> Result<Value> {
        let _guard = self.writing.lock().await;
        let target = super::provider_config::write(host, source, command, request).await?;
        if matches!(request["operation"].as_str(), Some("save" | "apply"))
            || request["operation"]
                .as_str()
                .is_some_and(|op| op.ends_with("AndApply"))
        {
            for target_project in targets(host, source)?
                .iter()
                .filter(|target| !target.id.is_empty())
            {
                host.schedules.connections.request_model_application(
                    host,
                    &target_project.id,
                    source,
                    command,
                    &target,
                )?;
            }
        }
        self.read(host, source)
    }
    pub(super) fn revision(&self, host: &Host, source: &str) -> Result<String> {
        let options = host.gateway.workbench.utility_options(source)?;
        let catalog = workbench_utility::models_catalog(host, source, &options)?;
        let targets = targets(host, source)?;
        let stamp = stamp(host, source, &catalog)?;
        let execution = execution_stamp(host, &targets);
        let project_executions = project_execution_stamps(host, &targets);
        let checked = self.checked.borrow();
        let current = checked.as_ref().filter(|checked| checked.stamp == stamp);
        projection_revision(&stamp, &execution, &project_executions, current)
    }
    pub(super) fn read(self: &Rc<Self>, host: &Rc<Host>, source: &str) -> Result<Value> {
        let options = host.gateway.workbench.utility_options(source)?;
        super::provider_config::import_saved_configuration(host, source, &options)?;
        let catalog = workbench_utility::models_catalog(host, source, &options)?;
        let targets = targets(host, source)?;
        let stamp = stamp(host, source, &catalog)?;
        let execution = execution_stamp(host, &targets);
        let project_executions = project_execution_stamps(host, &targets);
        let checked = self.checked.borrow();
        let current = checked.as_ref().filter(|checked| checked.stamp == stamp);
        let proof_current = current.filter(|checked| checked.execution == execution);
        let mut snapshot = current
            .map(|checked| checked.snapshot.clone())
            .unwrap_or_else(|| catalog.clone());
        let errors = current
            .map(|checked| checked.errors.clone())
            .unwrap_or_else(|| json!({}));
        let revision = snapshot["revision"]
            .as_str()
            .context("INVALID_RESPONSE")?
            .to_owned();
        let projects: Vec<_> = targets.iter().map(|target| {
            let proof = current.and_then(|checked| {
                project_executions
                    .get(&target.id)
                    .and_then(|project_execution| {
                        reusable_proof(checked, &target.id, project_execution)
                    })
            });
            let applied = proof.is_some_and(|proof| {
                proof["applied"]["revision"] == revision
                    && credentials_ready(proof, &snapshot, &errors)
            });
            let kind = if applied {
                "applied"
            } else if target.identity.is_some() && proof.is_none() {
                "unknown"
            } else if target.running {
                "deferred"
            } else {
                "saved"
            };
            let mut application = json!({"kind":kind,"revision":revision});
            if kind == "deferred" {
                application["reason"] = json!(if target.identity.is_some() { "busy" } else { "disconnected" });
            }
            if !applied {
                let live_state = host
                    .schedules
                    .connections
                    .model_application(host, &target.id)
                    .ok();
                let state = live_state
                    .as_ref()
                    .or_else(|| proof.and_then(|proof| proof.get("modelApplication")));
                if let Some(state) = state
                    && state["revision"] == revision
                    && matches!(state["kind"].as_str(), Some("unknown" | "deferred" | "failed"))
                {
                    application = state.clone();
                }
            }
            json!({"projectId":target.alias,"root":target.root,"connected":target.identity.is_some(),
                "applied":applied,"error":application.get("message").cloned().unwrap_or(Value::Null),"application":application})
        }).collect();
        snapshot["application"] = ["failed", "unknown", "deferred"].iter().find_map(|kind| {
            projects.iter().find(|row| row["application"]["kind"] == *kind)
                .map(|row| row["application"].clone())
        }).unwrap_or_else(|| json!({"kind":if projects.iter().any(|row| row["applied"] == true) {"applied"} else {"saved"},
            "revision":revision}));
        snapshot["pendingApply"] = json!(projects.iter().any(|row| {
            matches!(
                row["application"]["kind"].as_str(),
                Some("deferred" | "unknown")
            )
        }));
        snapshot["projects"] = json!(projects);
        snapshot["credentialErrors"] = errors;
        snapshot["refreshing"] = json!(current.is_none());
        let definitions: Vec<Value> = serde_json::from_str(include_str!(
            "../../../schemas/provider-config/definitions.json"
        ))?;
        let sources = snapshot["credentialSources"].clone();
        for provider in snapshot["data"]
            .as_array_mut()
            .context("INVALID_RESPONSE")?
        {
            provider["connection"] = connection(provider, &sources, &definitions)?;
            provider["baseUrl"] = json!(base_url(
                provider["endpoint"].as_str().context("INVALID_RESPONSE")?
            ));
            if provider["protocol"] == "chat-completions" {
                provider["protocol"] = json!("chatCompletions");
            }
        }
        snapshot["definitions"] = json!(definitions);
        let refresh =
            proof_current.is_none_or(|checked| checked.at.elapsed() >= Duration::from_secs(30));
        drop(checked);
        if refresh && !self.checking.replace(true) {
            let this = self.clone();
            let host = host.clone();
            let source = source.to_owned();
            tokio::task::spawn_local(async move {
                let result = tokio::time::timeout(
                    Duration::from_secs(10),
                    check(&host, &source, &targets, stamp.clone()),
                )
                .await;
                let checked = match result {
                    Ok(Ok(checked)) => checked,
                    _ => {
                        // 检查失败是可见终态；保留配置与原写入事实，不伪造已应用或无限 checking。
                        let mut snapshot = catalog;
                        let mut errors = json!({});
                        if let Some(states) = snapshot["credentialStates"].as_object_mut() {
                            for (id, state) in states {
                                if *state == "checking" {
                                    *state = json!("unavailable");
                                    errors[id] = json!("checkUnavailable");
                                }
                            }
                        }
                        Checked {
                            stamp: stamp.clone(),
                            execution: execution.clone(),
                            project_executions: BTreeMap::new(),
                            snapshot,
                            errors,
                            proofs: BTreeMap::new(),
                            at: Instant::now(),
                        }
                    }
                };
                *this.checked.borrow_mut() = Some(checked);
                host.changed();
                this.checking.set(false);
                // 等待期间的新配置不能丢掉检查机会；只继续读取，不重试任何写入。
                if let Ok(options) = host.gateway.workbench.utility_options(&source)
                    && let Ok(catalog) = workbench_utility::models_catalog(&host, &source, &options)
                    && let Ok(current) = self::stamp(&host, &source, &catalog)
                    && current != stamp
                {
                    let _ = this.read(&host, &source);
                }
            });
        }
        serde_json::from_value::<areal_protocol::host::WorkbenchProviderStatus>(snapshot.clone())
            .context("INVALID_RESPONSE")?;
        Ok(snapshot)
    }
}
async fn check(
    host: &Rc<Host>,
    source: &str,
    targets: &[Target],
    original: Value,
) -> Result<Checked> {
    let value = workbench_utility::execute(host, source, json!({"operation":"modelsRead"})).await?;
    let snapshot = value["snapshot"].clone();
    let mut errors = json!({});
    for provider in snapshot["data"].as_array().context("INVALID_RESPONSE")? {
        if let Some(reference) = provider["apiKeyEnv"].as_str() {
            let error = &value["credentials"]["errors"][reference];
            if matches!(
                error.as_str(),
                Some(
                    "storageLocked"
                        | "storageMissing"
                        | "storageAuthorizationRequired"
                        | "migrationPending"
                )
            ) {
                errors[provider["id"].as_str().context("INVALID_RESPONSE")?] = error.clone();
            }
        }
    }
    let before_execution = execution_stamp(host, targets);
    let mut proofs = BTreeMap::new();
    let mut project_executions = BTreeMap::new();
    let results = futures_util::future::join_all(
        targets
            .iter()
            .filter_map(|target| target.identity.as_ref().map(|identity| (target, identity)))
            .map(|(target, (service, generation, connection))| async move {
                let before_project_execution = project_proof_version(host, target);
                let result = tokio::time::timeout(
                    Duration::from_secs(2),
                    host.schedules.connections.remote_request(
                        host,
                        &target.id,
                        (service, generation, connection),
                        "areal/server/modelConfiguration/read",
                        json!({"expectedGeneration":generation}),
                    ),
                )
                .await;
                (
                    target,
                    service,
                    generation,
                    before_project_execution,
                    result,
                )
            }),
    )
    .await;
    for (target, service, generation, before_project_execution, result) in results {
        let id = target.id.clone();
        let after_project_execution = project_proof_version(host, target);
        if before_project_execution == after_project_execution
            && let Ok(Ok(mut proof)) = result
            && proof["serviceId"] == *service
            && proof["generation"] == *generation
            && serde_json::from_value::<areal_protocol::desktop::AppliedModelConfiguration>(
                proof["applied"].clone(),
            )
            .is_ok()
            && serde_json::from_value::<BTreeMap<String, String>>(proof["credentialStates"].clone())
                .is_ok()
            && proof["modelRevision"].is_string()
        {
            proof["modelApplication"] = host
                .schedules
                .connections
                .model_application(host, &id)
                .unwrap_or(Value::Null);
            project_executions.insert(id.clone(), after_project_execution);
            proofs.insert(id, proof);
        }
    }
    let options = host.gateway.workbench.utility_options(source)?;
    let catalog = workbench_utility::models_catalog(host, source, &options)?;
    ensure!(
        stamp(host, source, &catalog)? == original,
        "RESYNC_REQUIRED"
    );
    ensure!(
        snapshot["revision"] == catalog["revision"],
        "RESYNC_REQUIRED"
    );
    Ok(Checked {
        stamp: original,
        // 记录采样前的执行版本：若采样期间 Core 应用推进，下次读取会立刻再核验新版本而非缓存空证明 30 秒。
        execution: before_execution,
        project_executions,
        snapshot,
        errors,
        proofs,
        at: Instant::now(),
    })
}

#[cfg(test)]
#[test]
fn credential_check_stamp_survives_transport_reconnection() {
    let root = tempfile::tempdir().unwrap();
    let host = super::schedules::tests::fixture(root.path());
    let source = uuid::Uuid::new_v4().to_string();
    let mut targets = vec![Target {
        id: "project".into(),
        alias: "alias".into(),
        root: json!("fixture"),
        running: true,
        identity: Some((
            "service".into(),
            "generation".into(),
            "connection-one".into(),
        )),
    }];
    let first = stamp(&host, &source, &json!({"revision":"config-one"})).unwrap();
    let execution = execution_stamp(&host, &targets);
    targets[0].identity.as_mut().unwrap().2 = "connection-two".into();
    assert_eq!(
        stamp(&host, &source, &json!({"revision":"config-one"})).unwrap(),
        first,
        "transport identity must not invalidate a credential check"
    );
    assert_eq!(execution_stamp(&host, &targets), execution);
}

#[cfg(test)]
#[test]
fn provider_revision_publishes_same_proof_when_it_becomes_current() {
    let stamp = json!({"revision":"saved-config"});
    let current_exec = json!({"generation":"core","catalog":2});
    let stale_exec = json!({"generation":"core","catalog":1});
    let current_map = BTreeMap::from([("project".into(), current_exec.clone())]);
    let mut checked = Checked {
        stamp: stamp.clone(),
        execution: json!([stale_exec.clone()]),
        project_executions: BTreeMap::from([("project".into(), stale_exec)]),
        snapshot: json!({"revision":"saved-config"}),
        errors: json!({}),
        proofs: BTreeMap::from([(
            "project".into(),
            json!({"applied":{"revision":"saved-config"}}),
        )]),
        at: Instant::now(),
    };
    assert!(reusable_proof(&checked, "project", &current_exec).is_none());
    let unknown = projection_revision(
        &stamp,
        &json!([current_exec.clone()]),
        &current_map,
        Some(&checked),
    )
    .unwrap();
    checked.execution = json!([current_exec.clone()]);
    checked
        .project_executions
        .insert("project".into(), current_exec.clone());
    assert!(reusable_proof(&checked, "project", &current_exec).is_some());
    let applied =
        projection_revision(&stamp, &json!([current_exec]), &current_map, Some(&checked)).unwrap();
    assert_ne!(
        unknown, applied,
        "restoring the same proof must notify clients after an unknown projection"
    );
}
