use super::*;
use crate::subscription::{
    SourceSubscription,
    network::{Network, NetworkInput},
};
use areal_protocol::desktop::Provider;
use serde::{Deserialize, Serialize};

#[derive(Default)]
pub(super) struct Subscriptions {
    sources: RefCell<BTreeMap<String, Rc<SourceSubscription>>>,
    unavailable: RefCell<BTreeMap<String, String>>,
    applied: RefCell<BTreeMap<String, Value>>,
    handoff_gate: Mutex<()>,
    pub(super) restoring: std::cell::Cell<bool>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Read {
    source_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Handoff {
    request_id: String,
    expected_generation: String,
    source_id: String,
    migration_id: String,
    expected_account_revision: u64,
    expected_transport_revision: u64,
    network: NetworkInput,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HandoffContext {
    source_id: String,
    migration_id: String,
    generation: String,
    transport_request_id: String,
    port_request_id: String,
    expected_account_revision: u64,
    expected_transport_revision: u64,
}

struct TransportProof {
    revision: u64,
    entry: String,
    record: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Command {
    request_id: String,
    expected_generation: String,
    source_id: String,
    expected_account_epoch: u64,
    action: Value,
}

impl Host {
    fn subscription_path(&self, id: &str) -> Result<PathBuf> {
        wire::request_id(id)?;
        Ok(self
            .home
            .join("host/subscription-operations")
            .join(format!("{id}.json")))
    }
    pub(super) fn subscription_operation(&self, id: &str) -> Result<Option<Value>> {
        Ok(
            storage::read_optional::<Value>(&self.subscription_path(id)?)?
                .map(|record| record["receipt"].clone()),
        )
    }
    fn subscription_save_operation(&self, id: &str, digest: &str, receipt: Value) -> Result<Value> {
        storage::private_dir(&self.home.join("host/subscription-operations"))?;
        let path = self.subscription_path(id)?;
        let mut record = storage::read_optional::<Value>(&path)?.unwrap_or_else(|| json!({}));
        let mut stored = receipt.clone();
        if stored["result"]["login"].is_object() {
            stored["result"]["login"] = Value::Null;
        }
        record["digest"] = json!(digest);
        record["receipt"] = stored;
        storage::write(&path, &record)?;
        Ok(receipt)
    }
    fn subscription_accept_operation(
        &self,
        id: &str,
        digest: &str,
        method: &str,
        context: Value,
    ) -> Result<Value> {
        let receipt = json!({"requestId":id,"method":method,"state":"acceptedPending"});
        storage::private_dir(&self.home.join("host/subscription-operations"))?;
        storage::write(
            &self.subscription_path(id)?,
            &json!({"digest":digest,"receipt":receipt,"acceptedReceipt":receipt,"context":context}),
        )?;
        Ok(receipt)
    }
    fn subscription_original(&self, id: &str, digest: &str) -> Result<Option<Value>> {
        let Some(record) = storage::read_optional::<Value>(&self.subscription_path(id)?)? else {
            return Ok(None);
        };
        ensure!(
            record["digest"] == digest,
            error("requestConflict", "subscription request parameters changed")
        );
        Ok(Some(record["receipt"].clone()))
    }
    fn native_subscription(&self, id: &str) -> Result<Rc<SourceSubscription>> {
        self.subscriptions
            .sources
            .borrow()
            .get(id)
            .cloned()
            .ok_or_else(|| {
                error(
                    "subscriptionUnavailable",
                    "native subscription source is unavailable",
                )
            })
    }
    pub(super) fn subscription_model_catalog(&self, id: &str) -> Result<Option<Value>> {
        let source = self.subscriptions.sources.borrow().get(id).cloned();
        let Some(source) = source else {
            ensure!(
                !self.subscriptions.unavailable.borrow().contains_key(id),
                error(
                    "subscriptionUnavailable",
                    "native subscription source is unavailable"
                )
            );
            return Ok(None);
        };
        let snapshot = source.snapshot()?;
        Ok(Some(
            json!({"accountEpoch":snapshot["accountEpoch"],"authenticated":snapshot["authenticated"],"availability":snapshot["availability"],"models":snapshot["models"]}),
        ))
    }
    async fn subscription_snapshot(&self, id: &str) -> Result<Value> {
        wire::request_id(id)?;
        let (account_revision, _) = self
            .migration
            .vault
            .subscription_slot_async(
                crate::vault::Slot::SubscriptionAccount {
                    source_id: id.to_owned(),
                    provider_id: "openai".into(),
                },
                &self.migration,
            )
            .await?;
        let (transport_revision, _) = self
            .migration
            .vault
            .subscription_slot_async(
                crate::vault::Slot::SubscriptionTransport {
                    source_id: id.to_owned(),
                },
                &self.migration,
            )
            .await?;
        let owner = self.migration.vault.subscription_owner(id)?;
        let source = self.subscriptions.sources.borrow().get(id).cloned();
        let mut snapshot = if let Some(source) = source {
            source.snapshot_async().await?
        } else {
            let mut value = SourceSubscription::stored_accounts_async(&self.migration, id).await?;
            value.as_object_mut().unwrap().extend(json!({"accountEpoch":0,"authenticated":false,"state":"storage_locked","availability":"unavailable","refreshing":false,"email":null,"planType":null,"models":[],"modelError":null,"diagnostic":null,"login":null,"error":null,"billing":"subscription","catalog":null,"endpoint":null}).as_object().unwrap().clone());
            value
        };
        snapshot["owner"] = json!(if owner.is_some() {
            "nativeV1"
        } else {
            "legacy"
        });
        snapshot["generation"] = json!(self.identity.generation);
        snapshot["sourceId"] = json!(id);
        snapshot["accountRevision"] = json!(account_revision);
        snapshot["transportRevision"] = json!(transport_revision);
        snapshot["applied"] = json!(*self.subscriptions.applied.borrow());
        Ok(snapshot)
    }
    pub(super) async fn subscription_dispatch(
        &self,
        method: &str,
        params: Value,
        connection: &ConnectionGuard,
    ) -> Result<Value> {
        self.admission()?;
        ensure!(
            !self.subscriptions.restoring.get(),
            error(
                "subscriptionUnavailable",
                "Host subscription recovery is still in progress"
            )
        );
        match method {
            "subscription.read" => {
                let input: Read = serde_json::from_value(params)?;
                self.subscription_snapshot(&input.source_id).await
            }
            "subscription.handoff" => {
                let input: Handoff = serde_json::from_value(params.clone())?;
                wire::request_id(&input.request_id)?;
                self.generation(&input.expected_generation)?;
                let digest =
                    self.intent_digest(method, &input.source_id, &input.request_id, &params)?;
                if let Some(receipt) = self.subscription_original(&input.request_id, &digest)? {
                    return Ok(receipt);
                }
                let _handoff = self.subscriptions.handoff_gate.lock().await;
                if let Some(receipt) = self.subscription_original(&input.request_id, &digest)? {
                    return Ok(receipt);
                }
                self.migration
                    .subscription_retired(&input.source_id, &input.migration_id)?;
                ensure!(
                    self.migration
                        .vault
                        .subscription_owner(&input.source_id)?
                        .is_none(),
                    error(
                        "subscriptionOwnerRequired",
                        "source already belongs to the native owner"
                    )
                );
                let (account_revision, _) = self
                    .migration
                    .vault
                    .subscription_slot_async(
                        crate::vault::Slot::SubscriptionAccount {
                            source_id: input.source_id.clone(),
                            provider_id: "openai".into(),
                        },
                        &self.migration,
                    )
                    .await?;
                let (transport_revision, mut transport) = self
                    .migration
                    .vault
                    .subscription_slot_async(
                        crate::vault::Slot::SubscriptionTransport {
                            source_id: input.source_id.clone(),
                        },
                        &self.migration,
                    )
                    .await?;
                ensure!(
                    account_revision == input.expected_account_revision
                        && transport_revision == input.expected_transport_revision,
                    error("revisionConflict", "subscription changed before handoff")
                );
                let network = Network::new(input.network.clone())?;
                if transport.is_null() {
                    transport = json!({"token":format!("{}{}",uuid::Uuid::new_v4().simple(),uuid::Uuid::new_v4().simple()),"port":0});
                }
                transport["network"] = serde_json::to_value(input.network)?;
                let context = HandoffContext {
                    source_id: input.source_id.clone(),
                    migration_id: input.migration_id,
                    generation: self.identity.generation.clone(),
                    transport_request_id: uuid::Uuid::new_v4().to_string(),
                    port_request_id: uuid::Uuid::new_v4().to_string(),
                    expected_account_revision: account_revision,
                    expected_transport_revision: transport_revision,
                };
                self.subscription_accept_operation(
                    &input.request_id,
                    &digest,
                    method,
                    serde_json::to_value(&context)?,
                )?;
                let saved = self
                    .migration
                    .vault
                    .replace_subscription_transport_async(
                        &input.source_id,
                        &context.transport_request_id,
                        transport_revision,
                        transport,
                        &self.migration,
                    )
                    .await?;
                ensure!(
                    saved["state"] == "completed",
                    error("storageLocked", "transport handoff write is not confirmed")
                );
                let source = SourceSubscription::load_async(
                    self.migration.clone(),
                    input.source_id.clone(),
                    network,
                )
                .await?;
                if let Err(error) = source
                    .start_with_port_request(Some(&context.port_request_id))
                    .await
                {
                    source.close().await;
                    return self.subscription_save_operation(&input.request_id,&digest,json!({"requestId":input.request_id,"method":method,"state":"blocked","error":{"code":"subscriptionUnavailable","message":error.to_string()}}));
                }
                if let Err(error) = self
                    .subscription_claim_handoff(&input.request_id, &context, &source)
                    .await
                {
                    source.close().await;
                    return Err(error);
                }
                self.subscriptions
                    .sources
                    .borrow_mut()
                    .insert(input.source_id.clone(), source.clone());
                let work = source.clone();
                tokio::task::spawn_local(async move {
                    let _ = work.refresh_catalog(false).await;
                });
                self.subscription_save_operation(&input.request_id,&digest,json!({"requestId":input.request_id,"method":method,"state":"completed","result":self.subscription_snapshot(&input.source_id).await?}))
            }
            "subscription.command" => {
                let input: Command = serde_json::from_value(params.clone())?;
                wire::request_id(&input.request_id)?;
                self.generation(&input.expected_generation)?;
                let digest =
                    self.intent_digest(method, &input.source_id, &input.request_id, &params)?;
                if let Some(receipt) = self.subscription_original(&input.request_id, &digest)? {
                    return Ok(receipt);
                }
                let source = self.native_subscription(&input.source_id)?;
                ensure!(
                    source.account_epoch() == input.expected_account_epoch,
                    error("accountChanged", "subscription account changed")
                );
                let receipt = self.subscription_accept_operation(
                    &input.request_id,
                    &digest,
                    method,
                    json!({"sourceId":input.source_id,"generation":self.identity.generation,"expectedAccountEpoch":input.expected_account_epoch,"action":input.action["kind"]}),
                )?;
                let host = connection.host.clone();
                tokio::task::spawn_local(async move {
                    let result = if input.action["kind"] == "begin" {
                        let command = source.command_gate.lock().await;
                        let authorization = source.begin_login(&input.action["target"]).await;
                        drop(command);
                        match authorization {
                            Ok(authorization) => match authorization.completion.await {
                                Ok(record) => {
                                    let _command = source.command_gate.lock().await;
                                    let ids = host
                                        .subscription_projects(&input.source_id)
                                        .unwrap_or_default();
                                    let gates = ids
                                        .iter()
                                        .filter_map(|id| {
                                            host.slots
                                                .borrow()
                                                .get(id)
                                                .map(|slot| slot.gate.clone())
                                        })
                                        .collect::<Vec<_>>();
                                    let mut locks = Vec::new();
                                    for gate in gates {
                                        locks.push(gate.write_owned().await);
                                    }
                                    let idle = host
                                        .subscription_idle(&input.source_id)
                                        .await
                                        .unwrap_or(false);
                                    let before = source.account_epoch();
                                    match source.finish_login(&authorization.id, record, idle) {
                                        Ok(()) => {
                                            drop(locks);
                                            if source.account_epoch() != before {
                                                let _ = source.refresh_catalog(false).await;
                                            }
                                            host.subscription_snapshot(&input.source_id).await
                                        }
                                        Err(error) => Err(error.into()),
                                    }
                                }
                                Err(failure) => {
                                    source.login_failed(&authorization.id, &failure);
                                    Err(failure.into())
                                }
                            },
                            Err(failure) => Err(failure.into()),
                        }
                    } else {
                        let _command = source.command_gate.lock().await;
                        host.subscription_action(
                            &input.source_id,
                            &source,
                            input.expected_account_epoch,
                            input.action,
                        )
                        .await
                    };
                    let receipt = match result {
                        Ok(value) => {
                            json!({"requestId":input.request_id,"method":"subscription.command","state":"completed","result":value})
                        }
                        Err(failure) => {
                            json!({"requestId":input.request_id,"method":"subscription.command","state":"blocked","error":{"code":"subscriptionUnavailable","message":failure.to_string()}})
                        }
                    };
                    let _ = host.subscription_save_operation(&input.request_id, &digest, receipt);
                });
                Ok(receipt)
            }
            _ => Err(error("methodNotFound", "unknown subscription method")),
        }
    }
    async fn subscription_action(
        &self,
        id: &str,
        source: &Rc<SourceSubscription>,
        epoch: u64,
        action: Value,
    ) -> Result<Value> {
        ensure!(
            source.account_epoch() == epoch,
            error("accountChanged", "subscription account changed")
        );
        match action["kind"].as_str() {
            Some("refreshCatalog") => {
                source.refresh_catalog(action["force"] == true).await?;
            }
            Some("cancel") => {
                source
                    .cancel_attempt(action["loginId"].as_str().context("loginId is required")?)?;
            }
            Some("probe") => {
                return Ok(source
                    .probe(action["model"].as_str().context("model is required")?)
                    .await?);
            }
            Some("logout" | "select" | "forget") => {
                let ids = self.subscription_projects(id)?;
                let gates = ids
                    .iter()
                    .map(|id| self.slots.borrow().get(id).unwrap().gate.clone())
                    .collect::<Vec<_>>();
                let mut locks = Vec::new();
                for gate in gates {
                    locks.push(gate.write_owned().await);
                }
                for project in &ids {
                    let live = self
                        .slots
                        .borrow()
                        .get(project)
                        .is_some_and(|slot| slot.service.is_some());
                    if !live {
                        continue;
                    }
                    let (service, generation, connection) =
                        self.schedules.connections.shared_identity(self, project)?;
                    let status = self
                        .schedules
                        .connections
                        .remote_request(
                            self,
                            project,
                            (&service, &generation, &connection),
                            "areal/server/status",
                            json!({}),
                        )
                        .await?;
                    ensure!(
                        status["restartSafe"] == true,
                        error(
                            "projectBusy",
                            "stop active tasks before changing the subscription account"
                        )
                    );
                }
                if action["kind"] == "logout" {
                    source.sign_out().await?;
                } else if action["kind"] == "forget" {
                    source.forget_registration()?;
                } else {
                    source
                        .select_account(
                            action["accountId"]
                                .as_str()
                                .context("accountId is required")?,
                        )
                        .await?;
                    source.refresh_catalog(false).await?;
                }
            }
            Some("configureNetwork") => {
                let input: NetworkInput = serde_json::from_value(action["network"].clone())?;
                Network::new(input.clone())?;
                let (revision, mut record) = self
                    .migration
                    .vault
                    .subscription_slot_async(
                        crate::vault::Slot::SubscriptionTransport {
                            source_id: id.to_owned(),
                        },
                        &self.migration,
                    )
                    .await?;
                ensure!(
                    action["expectedTransportRevision"] == revision,
                    error("revisionConflict", "subscription transport changed")
                );
                record["network"] = serde_json::to_value(input.clone())?;
                self.migration
                    .vault
                    .replace_subscription_transport_async(
                        id,
                        &uuid::Uuid::new_v4().to_string(),
                        revision,
                        record,
                        &self.migration,
                    )
                    .await?;
                source.network_input(input)?;
            }
            _ => {
                return Err(error(
                    "unsupportedCapability",
                    "subscription action is not available",
                ));
            }
        }
        self.subscription_snapshot(id).await
    }
    async fn subscription_idle(&self, source: &str) -> Result<bool> {
        for project in self.subscription_projects(source)? {
            let live = self
                .slots
                .borrow()
                .get(&project)
                .is_some_and(|slot| slot.service.is_some());
            if !live {
                continue;
            }
            let (service, generation, connection) =
                self.schedules.connections.shared_identity(self, &project)?;
            let status = self
                .schedules
                .connections
                .remote_request(
                    self,
                    &project,
                    (&service, &generation, &connection),
                    "areal/server/status",
                    json!({}),
                )
                .await?;
            if status["restartSafe"] != true {
                return Ok(false);
            }
        }
        Ok(true)
    }
    fn subscription_projects(&self, source: &str) -> Result<Vec<String>> {
        self.slots
            .borrow()
            .iter()
            .filter_map(
                |(id, slot)| match self.migration.credential_source(&slot.registration) {
                    Ok(Some(value)) if value == source => Some(Ok(id.clone())),
                    Ok(_) => None,
                    Err(error) => Some(Err(error)),
                },
            )
            .collect()
    }
    async fn subscription_transport_proof(
        &self,
        context: &HandoffContext,
    ) -> Result<TransportProof> {
        let read = async |request: &str, previous: u64| -> Result<TransportProof> {
            let receipt = self
                .migration
                .vault
                .operation_async(request, &self.migration)
                .await?
                .context("original subscription transport outcome is unknown")?;
            let revision = previous
                .checked_add(1)
                .context("vault revision exhausted")?;
            ensure!(
                receipt["requestId"] == request
                    && receipt["method"] == "vault.replace"
                    && receipt["state"] == "completed"
                    && receipt["slot"]
                        == json!({"kind":"subscriptionTransport","sourceId":context.source_id})
                    && receipt["previousRevision"] == previous
                    && receipt["revision"] == revision,
                "original subscription transport receipt does not prove the expected write"
            );
            let entry = receipt["entryId"]
                .as_str()
                .context("missing transport entry")?;
            let record = self
                .migration
                .vault
                .read_async(entry)
                .await?
                .context("missing transport entry")?;
            Ok(TransportProof {
                revision,
                entry: entry.into(),
                record,
            })
        };
        let first = read(
            &context.transport_request_id,
            context.expected_transport_revision,
        )
        .await?;
        if first.record["port"] != 0 {
            ensure!(
                first.record["port"]
                    .as_u64()
                    .is_some_and(|port| port > 0 && port <= u16::MAX as u64),
                "invalid original subscription port"
            );
            return Ok(first);
        }
        let bound = read(&context.port_request_id, first.revision).await?;
        let mut expected = first.record;
        expected["port"] = bound.record["port"].clone();
        ensure!(
            expected == bound.record
                && bound.record["port"]
                    .as_u64()
                    .is_some_and(|port| port > 0 && port <= u16::MAX as u64),
            "original port write changed the subscription transport"
        );
        Ok(bound)
    }
    async fn subscription_handoff_current(
        &self,
        context: &HandoffContext,
        proof: &TransportProof,
    ) -> Result<()> {
        self.migration
            .subscription_retired(&context.source_id, &context.migration_id)?;
        ensure!(
            self.migration
                .vault
                .subscription_owner(&context.source_id)?
                .is_none(),
            "subscription source already has an owner"
        );
        let (account, _) = self
            .migration
            .vault
            .subscription_slot_async(
                crate::vault::Slot::SubscriptionAccount {
                    source_id: context.source_id.clone(),
                    provider_id: "openai".into(),
                },
                &self.migration,
            )
            .await?;
        ensure!(
            account == context.expected_account_revision
                && self
                    .migration
                    .vault
                    .subscription_transport_is_current_async(
                        &context.source_id,
                        proof.revision,
                        &proof.entry,
                        &self.migration
                    )
                    .await?,
            "original subscription revisions or immutable entry changed"
        );
        Ok(())
    }
    async fn subscription_claim_handoff(
        &self,
        request: &str,
        context: &HandoffContext,
        source: &SourceSubscription,
    ) -> Result<()> {
        let proof = self.subscription_transport_proof(context).await?;
        self.subscription_handoff_current(context, &proof).await?;
        ensure!(
            source.bound_port().map(u64::from) == proof.record["port"].as_u64(),
            "bound subscription port differs from the original receipt"
        );
        // 凭据事务在同一个 worker 所有权下重新核验并认领，旧 writer 不能夹入新版本。
        self.migration
            .vault
            .claim_subscription_async(
                &context.source_id,
                request,
                context.expected_account_revision,
                proof.revision,
                &proof.entry,
                &self.migration,
            )
            .await
    }
    async fn resume_subscription_handoff(
        &self,
        request: &str,
        context: &HandoffContext,
    ) -> Result<Value> {
        let proof = self.subscription_transport_proof(context).await?;
        self.subscription_handoff_current(context, &proof).await?;
        let network = Network::new(serde_json::from_value(proof.record["network"].clone())?)?;
        let source = SourceSubscription::load_async(
            self.migration.clone(),
            context.source_id.clone(),
            network,
        )
        .await?;
        let restored = async {
            source.start().await?;
            self.subscription_claim_handoff(request, context, &source)
                .await?;
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if let Err(error) = restored {
            source.close().await;
            return Err(error);
        }
        self.subscriptions
            .sources
            .borrow_mut()
            .insert(context.source_id.clone(), source);
        self.subscription_snapshot(&context.source_id).await
    }
    pub(super) async fn restore_subscriptions(&self) -> Result<()> {
        let directory = self.home.join("host/subscription-owners");
        let mut owners = BTreeMap::new();
        if directory.exists() {
            for entry in std::fs::read_dir(directory)? {
                let marker: Value = storage::read(&entry?.path())?;
                let id = marker["sourceId"]
                    .as_str()
                    .context("invalid subscription owner source")?;
                wire::request_id(id)?;
                if let Some(request) = marker["requestId"].as_str() {
                    owners.insert(request.to_owned(), id.to_owned());
                }
                let restored = async {
                    let (_, record) = self
                        .migration
                        .vault
                        .subscription_slot_async(
                            crate::vault::Slot::SubscriptionTransport {
                                source_id: id.to_owned(),
                            },
                            &self.migration,
                        )
                        .await?;
                    let network = Network::new(serde_json::from_value(record["network"].clone())?)?;
                    let source =
                        SourceSubscription::load_async(self.migration.clone(), id.into(), network)
                            .await?;
                    source.start().await?;
                    Ok::<_, anyhow::Error>(source)
                }
                .await;
                match restored {
                    Ok(source) => {
                        self.subscriptions
                            .sources
                            .borrow_mut()
                            .insert(id.into(), source.clone());
                        tokio::task::spawn_local(async move {
                            let _ = source.refresh_catalog(false).await;
                        });
                    }
                    Err(error) => {
                        self.subscriptions
                            .unavailable
                            .borrow_mut()
                            .insert(id.into(), error.to_string());
                    }
                }
            }
        }
        self.recover_subscription_operations(&owners).await?;
        Ok(())
    }
    async fn recover_subscription_operations(
        &self,
        owners: &BTreeMap<String, String>,
    ) -> Result<()> {
        let directory = self.home.join("host/subscription-operations");
        if !directory.exists() {
            return Ok(());
        }
        for entry in std::fs::read_dir(directory)? {
            let path = entry?.path();
            let mut record: Value = storage::read(&path)?;
            if record["receipt"]["state"] != "acceptedPending"
                && !(record["receipt"]["method"] == "subscription.handoff"
                    && record["receipt"]["error"]["code"] == "outcomeUnknown")
            {
                continue;
            }
            let original = record
                .get("acceptedReceipt")
                .unwrap_or(&record["receipt"])
                .clone();
            let id = original["requestId"]
                .as_str()
                .context("missing subscription request")?;
            let expected_path = self.subscription_path(id)?;
            ensure!(path == expected_path, "invalid subscription operation path");
            let method = original["method"]
                .as_str()
                .context("missing subscription method")?;
            let source = record["context"]["sourceId"]
                .as_str()
                .or_else(|| owners.get(id).map(String::as_str));
            let mut evidence = json!({"generation":self.identity.generation});
            let result = if method == "subscription.handoff" {
                if let Some(source) = source.filter(|source| {
                    owners.get(id).map(String::as_str) == Some(*source)
                        && self.subscriptions.sources.borrow().contains_key(*source)
                }) {
                    evidence["ownerRequestId"] = json!(id);
                    Some(self.subscription_snapshot(source).await?)
                } else {
                    if let Ok(context) =
                        serde_json::from_value::<HandoffContext>(record["context"].clone())
                    {
                        match self.resume_subscription_handoff(id, &context).await {
                            Ok(snapshot) => {
                                evidence["transportRequestId"] =
                                    json!(context.transport_request_id);
                                evidence["portRequestId"] = json!(context.port_request_id);
                                evidence["outcome"] = json!("originalHandoffResumed");
                                record["acceptedReceipt"] = original.clone();
                                record["recovery"] = evidence;
                                record["receipt"] = json!({"requestId":id,"method":method,"state":"completed","result":snapshot});
                                storage::write(&path, &record)?;
                            }
                            Err(_) => {
                                evidence["outcome"] = json!("unknown");
                                record["recovery"] = evidence;
                                storage::write(&path, &record)?;
                            }
                        }
                        continue;
                    }
                    if let Some(request) = record["context"]["transportRequestId"].as_str() {
                        let receipt = self.migration.vault.operation(request, &self.migration);
                        match receipt {
                            Ok(Some(receipt)) if receipt["state"] != "acceptedPending" => {
                                evidence["transportReceipt"] = receipt;
                            }
                            _ => {
                                evidence["outcome"] = json!("unknown");
                                record["recovery"] = evidence;
                                storage::write(&path, &record)?;
                                continue;
                            }
                        }
                    } else {
                        evidence["outcome"] = json!("unknown");
                        record["recovery"] = evidence;
                        storage::write(&path, &record)?;
                        continue;
                    }
                    None
                }
            } else {
                ensure!(
                    method == "subscription.command",
                    "invalid subscription method"
                );
                None
            };
            // 重启只能确认已落盘的交接；当前快照不能证明旧命令是否产生过效果。
            record["acceptedReceipt"] = original.clone();
            record["recovery"] = evidence;
            record["receipt"] = match result {
                Some(result) => {
                    json!({"requestId":id,"method":method,"state":"completed","result":result})
                }
                None => {
                    json!({"requestId":id,"method":method,"state":"blocked","error":{"code":"outcomeUnknown","message":"Host restarted before the original subscription outcome was confirmed; inspect the current state without replaying the request"}})
                }
            };
            storage::write(&path, &record)?;
        }
        Ok(())
    }
    pub(super) async fn close_subscriptions(&self) {
        let sources = self
            .subscriptions
            .sources
            .borrow()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for source in sources {
            source.close().await;
        }
    }
    pub(super) async fn run_subscriptions(&self) {
        let mut tick = tokio::time::interval(Duration::from_millis(250));
        loop {
            tick.tick().await;
            let sources = self
                .subscriptions
                .sources
                .borrow()
                .iter()
                .map(|(id, source)| (id.clone(), source.clone()))
                .collect::<Vec<_>>();
            for (id, source) in sources {
                for project in self.subscription_projects(&id).unwrap_or_default() {
                    let _ = self.subscription_reconcile(&project, &source).await;
                }
            }
        }
    }
    async fn subscription_reconcile(
        &self,
        project: &str,
        source: &Rc<SourceSubscription>,
    ) -> Result<()> {
        let Some(gate) = self
            .slots
            .borrow()
            .get(project)
            .map(|slot| slot.gate.clone())
        else {
            return Ok(());
        };
        let _lock = gate.write().await;
        let (service, generation, connection) =
            self.schedules.connections.shared_identity(self, project)?;
        let epoch = source.account_epoch();
        let snapshot = source.snapshot()?;
        if !matches!(snapshot["state"].as_str(), Some("ready" | "signed_out"))
            || !snapshot["modelError"].is_null()
        {
            return Ok(());
        }
        self.subscription_pending(project, &service, &generation, &connection)
            .await?;
        let list = self
            .schedules
            .connections
            .remote_request(
                self,
                project,
                (&service, &generation, &connection),
                "areal/provider/list",
                json!({}),
            )
            .await?;
        let existing = list["data"]
            .as_array()
            .context("invalid Core provider list")?
            .iter()
            .find(|provider| provider["id"] == "areal_openai")
            .cloned();
        let models = snapshot["models"]
            .as_array()
            .context("invalid subscription models")?;
        let (method, mut params) = if !snapshot["authenticated"].as_bool().unwrap_or(false)
            || models.is_empty()
        {
            let Some(existing) = existing else {
                return Ok(());
            };
            (
                "areal/provider/remove",
                json!({"id":"areal_openai","expectedRevision":existing["revision"]}),
            )
        } else {
            let mut contexts = serde_json::Map::new();
            let mut capabilities = serde_json::Map::new();
            for model in models {
                let id = model["id"].as_str().context("invalid model id")?;
                if model["parameters"]["contextWindowTokens"].is_u64() {
                    contexts.insert(id.into(), model["parameters"].clone());
                }
                if model["reasoningEffortOptions"].is_array() {
                    capabilities.insert(id.into(),json!({"tools":true,"vision":true,"reasoning":true,"reasoningEffortOptions":model["reasoningEffortOptions"]}));
                }
            }
            let revision = existing
                .as_ref()
                .map(|provider| provider["revision"].clone())
                .unwrap_or(json!(0));
            let desired: Provider = serde_json::from_value(
                json!({"id":"areal_openai","revision":revision,"contextSource":"account","protocol":"responses","endpoint":snapshot["endpoint"],"credentialRef":"areal_openai","models":models.iter().map(|model|model["id"].clone()).collect::<Vec<_>>(),"modelParameters":contexts,"modelCapabilities":capabilities,"parameters":{}}),
            )?;
            let current = existing
                .map(|mut value| {
                    let fields = value.as_object_mut().context("invalid Core provider")?;
                    fields.remove("credentialState");
                    fields.remove("connectionState");
                    Ok::<Provider, anyhow::Error>(serde_json::from_value(value)?)
                })
                .transpose()?;
            let identical = current.as_ref() == Some(&desired);
            if identical {
                self.subscriptions.applied.borrow_mut().insert(project.into(),json!({"accountEpoch":epoch,"serviceId":service,"generation":generation,"connectionId":connection,"providerRevision":revision}));
                return Ok(());
            }
            (
                "areal/provider/upsert",
                json!({"provider":desired,"expectedRevision":revision}),
            )
        };
        ensure!(
            source.account_epoch() == epoch,
            error(
                "accountChanged",
                "subscription changed during reconciliation"
            )
        );
        let (revision, mut journal) = self.journal.native_snapshot(project)?;
        let failed = journal["outcomes"]
            .as_object()
            .context("invalid provider outcome journal")?
            .values()
            .any(|record| {
                if record["subscription"]["serviceId"] != service
                    || record["subscription"]["generation"] != generation
                    || record["method"] != method
                    || record["response"].get("error").is_none()
                {
                    return false;
                }
                let mut previous = record["params"].clone();
                if let Some(previous) = previous.as_object_mut() {
                    previous.remove("requestId");
                }
                previous == params
            });
        ensure!(
            !failed,
            error(
                "subscriptionProviderRejected",
                "the current Core has already rejected this subscription provider configuration"
            )
        );
        let request = uuid::Uuid::new_v4().to_string();
        params["requestId"] = json!(request);
        journal["pending"].as_array_mut().unwrap().push(json!({"method":method,"operationId":request,"params":params,"subscription":{"sourceId":source.source_id(),"accountEpoch":epoch,"serviceId":service,"generation":generation,"connectionId":connection}}));
        self.journal.native_replace(project, revision, journal)?;
        let _ = self
            .schedules
            .connections
            .remote_request(
                self,
                project,
                (&service, &generation, &connection),
                method,
                params,
            )
            .await;
        self.subscription_pending(project, &service, &generation, &connection)
            .await
    }
    async fn subscription_pending(
        &self,
        project: &str,
        service: &str,
        generation: &str,
        connection: &str,
    ) -> Result<()> {
        let (_, snapshot) = self.journal.native_snapshot(project)?;
        let pending = snapshot["pending"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|record| {
                (record["method"] == "areal/provider/upsert"
                    && record["params"]["provider"]["id"] == "areal_openai")
                    || (record["method"] == "areal/provider/remove"
                        && record["params"]["id"] == "areal_openai")
            })
            .cloned()
            .collect::<Vec<_>>();
        for record in pending {
            let request = record["params"]["requestId"]
                .as_str()
                .context("original provider requestId is required")?;
            let receipt = self
                .schedules
                .connections
                .remote_request(
                    self,
                    project,
                    (service, generation, connection),
                    "areal/request/read",
                    json!({"requestId":request}),
                )
                .await?;
            let mut parameters = record["params"].clone();
            parameters
                .as_object_mut()
                .context("invalid original provider params")?
                .remove("requestId");
            let digest = storage::digest(&serde_json::to_vec(&parameters)?);
            let matches = receipt["data"]
                .as_array()
                .context("invalid original Core receipt response")?
                .iter()
                .filter(|receipt| {
                    receipt["requestId"] == request
                        && receipt["method"] == record["method"]
                        && receipt["digest"] == digest
                        && receipt["operation"]["target"]["kind"] == "project"
                })
                .collect::<Vec<_>>();
            ensure!(
                matches.len() == 1
                    && matches[0]["state"] == "completed"
                    && matches[0]["response"].is_object(),
                error(
                    "submissionUnknown",
                    "original subscription provider receipt is unresolved"
                )
            );
            let original = matches[0].clone();
            let (revision, mut snapshot) = self.journal.native_snapshot(project)?;
            snapshot["pending"]
                .as_array_mut()
                .unwrap()
                .retain(|entry| entry["params"]["requestId"] != request);
            let mut settled = record.clone();
            settled["receipt"] = original.clone();
            settled["receiptLookup"] = receipt;
            settled["admissionState"] = json!("accepted");
            settled["response"] = original["response"].clone();
            snapshot["outcomes"][request] = settled;
            self.journal.native_replace(project, revision, snapshot)?;
            if original["response"].get("error").is_some() {
                return Err(error(
                    "subscriptionProviderRejected",
                    "original subscription provider request completed with an error",
                ));
            }
        }
        Ok(())
    }
}
