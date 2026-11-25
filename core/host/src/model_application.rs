//! 配置意图与执行应用分开结算；每个共享 Core 连接只处理自身代际。
use super::*;

#[derive(Default)]
pub(super) struct State {
    pub(super) revision: Cell<u64>,
    value: RefCell<Value>,
    settled: RefCell<Option<Value>>,
    retry: RefCell<Option<(Value, tokio::time::Instant)>>,
}
impl State {
    pub(super) fn read(&self) -> Value {
        self.value.borrow().clone()
    }
    fn publish(&self, host: &Host, value: Value) {
        if *self.value.borrow() != value {
            *self.value.borrow_mut() = value;
            self.revision.set(self.revision.get() + 1);
            host.changed();
        }
    }
}

fn scope(project: &str) -> String {
    // 复用同一 Journal 的独立命令范围，配置 UNKNOWN 不占用会话的提交队列。
    format!(
        "model-configuration-{}",
        storage::digest(project.as_bytes())
    )
}
fn bound(record: &Value, session: &CoreSession) -> bool {
    record["modelConfiguration"]["serviceId"] == session.service.identity.service_id
        && record["modelConfiguration"]["generation"] == session.service.identity.generation
}
async fn request(session: &CoreSession, method: &str, params: Value) -> Result<Value> {
    tokio::time::timeout(Duration::from_secs(10), session.request(method, params))
        .await
        .map_err(|_| unavailable())?
}
fn valid_proof(session: &CoreSession, proof: &Value) -> Result<()> {
    ensure!(
        proof["serviceId"] == session.service.identity.service_id
            && proof["generation"] == session.service.identity.generation,
        unavailable()
    );
    serde_json::from_value::<areal_protocol::desktop::AppliedModelConfiguration>(
        proof["applied"].clone(),
    )?;
    ensure!(proof["modelRevision"].is_string(), unavailable());
    serde_json::from_value::<BTreeMap<String, String>>(proof["credentialStates"].clone())?;
    Ok(())
}

async fn reconcile_original(host: &Host, session: &CoreSession, record: &Value) -> Result<bool> {
    let id = record["params"]["requestId"]
        .as_str()
        .context("original model application request is required")?;
    let proof = request(
        session,
        "areal/server/modelConfiguration/read",
        json!({
            "expectedGeneration":session.service.identity.generation,"requestId":id
        }),
    )
    .await?;
    session.require_current(host)?;
    valid_proof(session, &proof)?;
    let operation = &proof["operation"];
    ensure!(operation["requestId"] == id, unavailable());
    let response = match operation["state"].as_str() {
        Some("applied") => {
            let result = &operation["result"];
            valid_proof(session, result)?;
            ensure!(
                result["applied"]["revision"] == record["params"]["targetRevision"]
                    && result["applied"]["sequence"].as_u64()
                        == record["params"]["expectedApplied"]["sequence"]
                            .as_u64()
                            .and_then(|n| n.checked_add(1)),
                unavailable()
            );
            json!({"result":result})
        }
        Some("rejected") if operation["error"].is_object() => json!({"error":operation["error"]}),
        _ => return Ok(false),
    };
    let mut outcome = record.clone();
    outcome["response"] = response;
    outcome["status"] = json!("completed");
    host.journal
        .native_finish(&scope(&session.project_id), record, Some(outcome))?;
    Ok(true)
}

pub(super) fn intent(
    host: &Host,
    project: &str,
    source: &str,
    command: &str,
    target: &str,
) -> Result<()> {
    host.admission()?;
    ensure!(
        host.slots.borrow().contains_key(project),
        "PROJECT_NOT_FOUND"
    );
    let journal_scope = scope(project);
    let params = json!({"requestId":command,"sourceId":source,"targetRevision":target});
    let (revision, mut snapshot) = host.journal.native_snapshot(&journal_scope)?;
    if let Some(original) = snapshot["outcomes"].get(command) {
        ensure!(
            original["method"] == "host/modelConfiguration/intent" && original["params"] == params,
            "COMMAND_CONFLICT"
        );
        return Ok(());
    }
    let entry = json!({"method":"host/modelConfiguration/intent","params":params,"operationId":command,
        "rustOwner":true,"status":"completed","intentRevision":revision.checked_add(1).context("journal revision exhausted")?});
    host.journal
        .native_preflight(&journal_scope, &entry, false)?;
    snapshot["outcomes"][command] = entry;
    host.journal
        .native_replace(&journal_scope, revision, snapshot)?;
    host.changed();
    Ok(())
}

struct Desired {
    source: String,
    document: areal_config::models::ModelConfiguration,
    stamp: Value,
}
fn desired(host: &Host, session: &CoreSession) -> Result<Option<Desired>> {
    let registration = host.slots.borrow()[&session.project_id]
        .registration
        .clone();
    let mut launch = inputs(host, &session.project_id)?;
    let Some(source) = host
        .migration
        .shared_credential_source(&registration, host.uses_shared_host_config(&launch))?
    else {
        return Ok(None);
    };
    let credentials = host.gateway.workbench.project_environment_credentials(
        &registration,
        Some(&source),
        &mut launch.credential_names,
    );
    let mut config = crate::launch::config_inputs(&host.home, &launch, &credentials);
    let references = host
        .migration
        .vault
        .provider_references(&source)?
        .into_iter()
        .collect::<Vec<_>>();
    for reference in &references {
        config.env.remove(std::ffi::OsStr::new(reference));
    }
    let document = areal_config::models::read(&config, &references)?;
    let (_, journal) = host.journal.native_snapshot(&scope(&session.project_id))?;
    let intent = journal["outcomes"]
        .as_object()
        .context("invalid model application outcomes")?
        .values()
        .filter(|entry| {
            entry["method"] == "host/modelConfiguration/intent"
                && entry["params"]["sourceId"] == source
                && entry["params"]["targetRevision"] == document.revision
        })
        .max_by_key(|entry| entry["intentRevision"].as_u64().unwrap_or(0))
        .map(|entry| entry["params"]["requestId"].clone());
    let stamp = json!({"revision":document.revision,"credentials":host.migration.vault.provider_stamp(&source)?,
        "models":session.model_revision.get(),"intent":intent});
    Ok(Some(Desired {
        source,
        document,
        stamp,
    }))
}

async fn pass(host: &Rc<Host>, session: &Rc<CoreSession>) -> Result<()> {
    session.require_current(host)?;
    let Some(desired) = desired(host, session)? else {
        return Ok(());
    };
    let target = &desired.document.revision;
    if session
        .model_application
        .retry
        .borrow()
        .as_ref()
        .is_some_and(|(stamp, at)| {
            *stamp == desired.stamp && at.elapsed() < Duration::from_secs(30)
        })
    {
        return Ok(());
    }
    session.model_application.retry.borrow_mut().take();
    let journal_scope = scope(&session.project_id);
    let (_, snapshot) = host.journal.native_snapshot(&journal_scope)?;
    for record in snapshot["pending"]
        .as_array()
        .context("invalid model application journal")?
    {
        if bound(record, session) {
            // 只查原请求；原 Core 已换代的记录保留 UNKNOWN，不向新 Core 猜测其结果。
            let _ = reconcile_original(host, session, record).await?;
        }
    }
    if session.model_application.settled.borrow().as_ref() == Some(&desired.stamp)
        && matches!(
            session.model_application.read()["kind"].as_str(),
            Some("applied" | "failed")
        )
    {
        return Ok(());
    }
    session.require_current(host)?;
    let proof = request(
        session,
        "areal/server/modelConfiguration/read",
        json!({"expectedGeneration":session.service.identity.generation}),
    )
    .await?;
    session.require_current(host)?;
    valid_proof(session, &proof)?;
    let (_, snapshot) = host.journal.native_snapshot(&journal_scope)?;
    if snapshot["pending"]
        .as_array()
        .unwrap()
        .iter()
        .any(|record| bound(record, session) && record["params"]["targetRevision"] == *target)
    {
        session
            .model_application
            .publish(host, json!({"kind":"unknown","revision":target}));
        return Ok(());
    }
    if snapshot["outcomes"]
        .as_object()
        .unwrap()
        .values()
        .any(|record| {
            bound(record, session)
                && record["params"]["targetRevision"] == *target
                && record["params"]["expectedApplied"] == proof["applied"]
                && record["modelConfiguration"]["inputs"] == desired.stamp
                && record["response"]["error"].is_object()
                && record["response"]["error"]["data"]["reason"] != "MODEL_CONFIGURATION_BUSY"
        })
    {
        session.model_application.publish(host, json!({"kind":"failed","revision":target,"message":"Core 未能应用模型配置，请检查配置或重新连接该项目。"}));
        return Ok(());
    }
    let mut credentials = BTreeMap::new();
    for provider in desired
        .document
        .data
        .iter()
        .filter(|provider| provider.enabled)
    {
        let Some(reference) = &provider.api_key_env else {
            continue;
        };
        if !matches!(
            desired.document.credential_sources.get(&provider.id),
            Some(areal_config::models::CredentialSource::Stored)
        ) {
            continue;
        }
        let stored = host.migration.vault.dispatch_async("vault.read", json!({"slot":{
            "kind":"providerCredential","sourceId":desired.source,"reference":reference},"interactionAllowed":false}),
            &host.identity.generation,&host.migration).await?;
        let key = stored["value"]
            .as_str()
            .filter(|key| !key.is_empty())
            .context("provider credential unavailable")?;
        credentials.insert(reference.clone(), key.to_owned());
    }
    session.require_current(host)?;
    ensure!(
        self::desired(host, session)?.is_some_and(|current| current.stamp == desired.stamp),
        "RESYNC_REQUIRED"
    );
    let default_provider = desired
        .document
        .default_model
        .as_ref()
        .map(|model| model.provider_id.as_str());
    let credentials_synced = |proof: &Value| {
        desired
            .document
            .data
            .iter()
            .filter(|provider| provider.enabled)
            .all(|provider| {
                let expected_available = provider.api_key_env.is_some()
                    && (default_provider == Some(provider.id.as_str())
                        || matches!(
                            desired.document.credential_sources.get(&provider.id),
                            Some(areal_config::models::CredentialSource::Stored)
                        )
                        || matches!(
                            desired.document.credential_states.get(&provider.id),
                            Some(areal_config::models::CredentialState::Available)
                        ));
                !expected_available || proof["credentialStates"][&provider.id] == "available"
            })
    };
    let ready = credentials_synced(&proof);
    if proof["applied"]["revision"] == *target && ready {
        *session.model_application.settled.borrow_mut() = Some(desired.stamp.clone());
        session
            .model_application
            .publish(host, json!({"kind":"applied","revision":target}));
        return Ok(());
    }
    if desired
        .document
        .data
        .iter()
        .filter(|provider| provider.enabled)
        .any(|provider| {
            provider.api_key_env.is_some()
                && matches!(
                    desired.document.credential_states.get(&provider.id),
                    Some(areal_config::models::CredentialState::Available)
                )
                && proof["credentialStates"][&provider.id] != "available"
                && !matches!(
                    desired.document.credential_sources.get(&provider.id),
                    Some(areal_config::models::CredentialSource::Stored)
                )
        })
    {
        session.model_application.publish(
            host,
            json!({"kind":"failed","revision":target,
            "message":"Core 尚未取得配置所需的环境凭据，请检查配置并重新连接该项目。"}),
        );
        return Ok(());
    }
    let status = request(session, "areal/server/status", json!({})).await?;
    session.require_current(host)?;
    if status["restartSafe"] != true {
        session.model_application.publish(
            host,
            json!({"kind":"deferred","revision":target,"reason":"busy"}),
        );
        return Ok(());
    }
    ensure!(
        self::desired(host, session)?.is_some_and(|current| current.stamp == desired.stamp),
        "RESYNC_REQUIRED"
    );
    let id = uuid::Uuid::new_v4().to_string();
    let params = json!({"requestId":id,"expectedGeneration":session.service.identity.generation,
        "expectedApplied":proof["applied"],"targetRevision":target});
    let entry = json!({"method":"areal/server/modelConfiguration/apply","params":params,"operationId":id,"rustOwner":true,
        "modelConfiguration":{"sourceId":desired.source,"serviceId":session.service.identity.service_id,
            "generation":session.service.identity.generation,"connectionId":session.connection_id,"inputs":desired.stamp}});
    let (revision, snapshot) = host.journal.native_snapshot(&journal_scope)?;
    host.journal
        .native_admit(&journal_scope, revision, snapshot, entry.clone(), false)?;
    let mut params = params;
    params["credentials"] = serde_json::to_value(credentials)?;
    let _ = request(session, "areal/server/modelConfiguration/apply", params).await;
    session.require_current(host)?;
    let settled = reconcile_original(host, session, &entry).await?;
    let (_, snapshot) = host.journal.native_snapshot(&journal_scope)?;
    let outcome = &snapshot["outcomes"][&id];
    let value = if !settled {
        json!({"kind":"unknown","revision":target})
    } else if outcome["response"].get("result").is_some() {
        let proof = &outcome["response"]["result"];
        let ready = credentials_synced(proof);
        if ready {
            *session.model_application.settled.borrow_mut() = Some(desired.stamp.clone());
            json!({"kind":"applied","revision":target})
        } else {
            *session.model_application.settled.borrow_mut() = Some(desired.stamp.clone());
            json!({"kind":"failed","revision":target,"message":"配置已载入，但 Core 尚未确认供应商凭据可用。"})
        }
    } else if outcome["response"]["error"]["data"]["reason"] == "MODEL_CONFIGURATION_BUSY" {
        json!({"kind":"deferred","revision":target,"reason":"busy"})
    } else {
        json!({"kind":"failed","revision":target,"message":"Core 未能应用模型配置，请检查配置或重新连接该项目。"})
    };
    session.model_application.publish(host, value);
    Ok(())
}

pub(super) async fn run(host: Rc<Host>, session: Rc<CoreSession>) {
    let mut changes = host.changes.subscribe();
    loop {
        if !session.current(&host) {
            return;
        }
        if let Err(error) = pass(&host, &session).await {
            if error.to_string() == "RESYNC_REQUIRED" {
                continue;
            }
            if session.current(&host)
                && let Ok(Some(current)) = desired(&host, &session)
            {
                session.model_application.publish(
                    &host,
                    json!({"kind":"unknown","revision":current.document.revision}),
                );
                *session.model_application.retry.borrow_mut() =
                    Some((current.stamp, tokio::time::Instant::now()));
            }
        }
        tokio::select! {
            _ = changes.changed() => {},
            _ = tokio::time::sleep(Duration::from_secs(5)) => {},
        }
    }
}

#[cfg(test)]
#[path = "model_application_tests.rs"]
mod tests;
