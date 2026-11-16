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
struct Checked {
    stamp: Value,
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
fn stamp(host: &Host, source: &str, snapshot: &Value, targets: &[Target]) -> Result<Value> {
    Ok(
        json!({"source":source,"catalog":snapshot,"credentials":host.migration.vault.provider_stamp(source)?,
        "environment":storage::digest(&serde_json::to_vec(&host.gateway.workbench.environment_credentials(source))?),
        "projects":targets.iter().map(|target| json!([target.id,target.alias,target.root,target.running,target.identity,
            host.schedules.connections.model_catalog_revision(host, &target.id).ok()])).collect::<Vec<_>>()}),
    )
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
fn credentials_ready(proof: &Value, snapshot: &Value) -> bool {
    snapshot["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|provider| provider["enabled"] == true)
        .all(|provider| {
            let id = provider["id"].as_str().unwrap_or("");
            !provider["apiKeyEnv"].is_string()
                || (snapshot["credentialStates"][id] == "available"
                    && proof["credentialStates"][id] == "available")
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
        if request["operation"] == "apply"
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
        let stamp = stamp(host, source, &catalog, &targets(host, source)?)?;
        let checked = self.checked.borrow();
        let current = checked.as_ref().filter(|checked| checked.stamp == stamp);
        Ok(storage::digest(&serde_json::to_vec(&json!([
            stamp,
            current.map(|checked| json!([checked.snapshot, checked.errors, checked.proofs]))
        ]))?))
    }
    pub(super) fn read(self: &Rc<Self>, host: &Rc<Host>, source: &str) -> Result<Value> {
        let options = host.gateway.workbench.utility_options(source)?;
        super::provider_config::import_saved_configuration(host, source, &options)?;
        let catalog = workbench_utility::models_catalog(host, source, &options)?;
        let targets = targets(host, source)?;
        let stamp = stamp(host, source, &catalog, &targets)?;
        let checked = self.checked.borrow();
        let current = checked.as_ref().filter(|checked| checked.stamp == stamp);
        let mut snapshot = current
            .map(|checked| checked.snapshot.clone())
            .unwrap_or_else(|| catalog.clone());
        let revision = snapshot["revision"]
            .as_str()
            .context("INVALID_RESPONSE")?
            .to_owned();
        let projects: Vec<_> = targets.iter().map(|target| {
            let proof = current.and_then(|checked| checked.proofs.get(&target.id));
            let applied = proof.is_some_and(|proof| {
                proof["applied"]["revision"] == revision && credentials_ready(proof, &snapshot)
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
            if !applied && let Some(state) = proof.and_then(|proof|proof.get("modelApplication"))
                && state["revision"] == revision
                && matches!(state["kind"].as_str(),Some("unknown"|"deferred"|"failed")) {
                application = state.clone();
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
        snapshot["credentialErrors"] = current
            .map(|checked| checked.errors.clone())
            .unwrap_or_else(|| json!({}));
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
        let refresh = current.is_none_or(|checked| checked.at.elapsed() >= Duration::from_secs(1));
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
                if let Ok(Ok(checked)) = result {
                    *this.checked.borrow_mut() = Some(checked);
                    host.changed();
                }
                this.checking.set(false);
                // 等待期间的新配置不能丢掉检查机会；只继续读取，不重试任何写入。
                if let Ok(options) = host.gateway.workbench.utility_options(&source)
                    && let Ok(catalog) = workbench_utility::models_catalog(&host, &source, &options)
                    && let Ok(targets) = self::targets(&host, &source)
                    && let Ok(current) = self::stamp(&host, &source, &catalog, &targets)
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
            if error == "storageLocked" || error == "migrationPending" {
                errors[provider["id"].as_str().context("INVALID_RESPONSE")?] = error.clone();
            }
        }
    }
    let mut proofs = BTreeMap::new();
    let results = futures_util::future::join_all(
        targets
            .iter()
            .filter_map(|target| target.identity.as_ref().map(|identity| (target, identity)))
            .map(|(target, (service, generation, connection))| async move {
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
                (target.id.clone(), service, generation, result)
            }),
    )
    .await;
    for (id, service, generation, result) in results {
        if let Ok(Ok(mut proof)) = result
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
            proofs.insert(id, proof);
        }
    }
    let options = host.gateway.workbench.utility_options(source)?;
    let catalog = workbench_utility::models_catalog(host, source, &options)?;
    ensure!(
        stamp(host, source, &catalog, &self::targets(host, source)?)? == original,
        "RESYNC_REQUIRED"
    );
    ensure!(
        snapshot["revision"] == catalog["revision"],
        "RESYNC_REQUIRED"
    );
    Ok(Checked {
        stamp: original,
        snapshot,
        errors,
        proofs,
        at: Instant::now(),
    })
}
