use crate::{
    migration::Migration,
    wire::{self, error},
};
use anyhow::{Result, ensure};
use areal_local_service::storage;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Slot {
    ProviderCredential {
        #[serde(rename = "sourceId")]
        source_id: String,
        reference: String,
    },
    SubscriptionAccount {
        #[serde(rename = "sourceId")]
        source_id: String,
        #[serde(rename = "providerId")]
        provider_id: String,
    },
    SubscriptionTransport {
        #[serde(rename = "sourceId")]
        source_id: String,
    },
    RemoteIdentity,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Receipt {
    pub request_id: String,
    pub slot: Slot,
    pub revision: u64,
    pub entry_id: String,
    pub source_digest: String,
    pub state: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SlotState {
    slot: Slot,
    revision: u64,
    entry_id: Option<String>,
    receipt: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Replace {
    request_id: String,
    expected_generation: String,
    slot: Slot,
    expected_revision: u64,
    value: Value,
}

impl Slot {
    pub fn source_id(&self) -> Result<&str> {
        let source = match self {
            Self::ProviderCredential {
                source_id,
                reference,
            } => {
                if !reference.starts_with("AREAL_CREDENTIAL_") {
                    return Err(error(
                        "invalidRequest",
                        "invalid provider credential reference",
                    ));
                }
                source_id
            }
            Self::SubscriptionAccount {
                source_id,
                provider_id,
            } => {
                if provider_id.is_empty() {
                    return Err(error("invalidRequest", "invalid subscription providerId"));
                }
                source_id
            }
            Self::SubscriptionTransport { source_id } => source_id,
            Self::RemoteIdentity => {
                return Err(error(
                    "remoteStateRequired",
                    "Remote identity is owned by remote.read and remote.replace",
                ));
            }
        };
        wire::request_id(source)?;
        Ok(source)
    }
}

#[derive(Clone)]
pub(crate) struct Vault {
    flight: Arc<Mutex<BTreeMap<String, Value>>>,
    worker: bool,
    closing: Arc<AtomicBool>,
    idle_notice: Arc<tokio::sync::Notify>,
    gates: Arc<Mutex<BTreeMap<String, Weak<tokio::sync::Mutex<()>>>>>,
    interaction_allowed: bool,
    home: PathBuf,
    owner: Arc<Mutex<Option<Arc<std::fs::File>>>>,
    #[cfg(target_os = "macos")]
    authority: Arc<Mutex<Option<crate::credential_io::Authority>>>,
    #[cfg(test)]
    isolated_files: bool,
    #[cfg(test)]
    pub(crate) locked: std::cell::Cell<bool>,
    #[cfg(test)]
    pub(crate) before_write: Option<std::sync::Arc<dyn Fn() + Send + Sync>>,
}
struct FlightGuard {
    flight: Arc<Mutex<BTreeMap<String, Value>>>,
    notice: Arc<tokio::sync::Notify>,
    id: String,
    _leases: Vec<tokio::sync::OwnedMutexGuard<()>>,
}
impl Drop for FlightGuard {
    fn drop(&mut self) {
        self.flight.lock().unwrap().remove(&self.id);
        self.notice.notify_one();
    }
}

impl Vault {
    pub(crate) fn hold_owner(
        &mut self,
        owner: Arc<std::fs::File>,
        _identity: &crate::HostIdentity,
        _token: &str,
    ) {
        #[cfg(target_os = "macos")]
        {
            *self.authority.lock().unwrap() =
                Some(crate::credential_io::Authority::new(_identity, _token));
        }
        // 异常退出或取消 Host future 时，尚未结束的系统调用仍持有同一把进程锁。
        *self.owner.lock().unwrap() = Some(owner);
    }
    pub(crate) fn idle(&self) -> Result<()> {
        if !self.worker
            && (self.closing.load(Ordering::Acquire) || !self.flight.lock().unwrap().is_empty())
        {
            return Err(error(
                "storageBusy",
                "Host credential operation is still in progress",
            ));
        }
        Ok(())
    }
    fn slot_key(value: &Value) -> Result<String> {
        let slot: Slot = serde_json::from_value(value.clone())?;
        Ok(format!(
            "slot:{}",
            storage::digest(&serde_json::to_vec(&slot)?)
        ))
    }
    pub(crate) fn recovery_blocked(&self, slot: &Slot) -> bool {
        !self.worker && self.slot_in_flight(slot)
    }
    pub(crate) fn import_in_flight(&self, intent: &Value) -> Result<bool> {
        let flight = self.flight.lock().unwrap();
        let Some(active) = flight
            .values()
            .find(|active| active["entryId"] == intent["entryId"])
        else {
            return Ok(false);
        };
        ensure!(
            active == intent,
            error(
                "requestConflict",
                "credential import is already in progress with different parameters"
            )
        );
        Ok(true)
    }
    pub(crate) fn slot_in_flight(&self, slot: &Slot) -> bool {
        let slot = serde_json::to_value(slot).expect("serializable vault slot");
        self.flight.lock().unwrap().values().any(|active| {
            active["slot"] == slot
                || active["slots"]
                    .as_array()
                    .is_some_and(|slots| slots.contains(&slot))
        })
    }
    pub(crate) async fn run<T: Send + 'static>(
        &self,
        intent: Value,
        work: impl FnOnce(Self) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let mut keys = Vec::new();
        if !intent["slot"].is_null() {
            keys.push(Self::slot_key(&intent["slot"])?);
        }
        if let Some(slots) = intent["slots"].as_array() {
            keys.extend(
                slots
                    .iter()
                    .map(Self::slot_key)
                    .collect::<Result<Vec<_>>>()?,
            );
        }
        if let Some(id) = intent["requestId"].as_str() {
            keys.push(format!("request:{id}"));
        }
        if let Some(entry) = intent["entryId"].as_str() {
            keys.push(format!("entry:{entry}"));
        }
        keys.sort();
        keys.dedup();
        let gates: Vec<_> = {
            let mut gates = self.gates.lock().unwrap();
            gates.retain(|_, gate| gate.strong_count() > 0);
            keys.into_iter()
                .map(|key| {
                    let gate = gates
                        .get(&key)
                        .and_then(Weak::upgrade)
                        .unwrap_or_else(|| Arc::new(tokio::sync::Mutex::new(())));
                    gates.insert(key, Arc::downgrade(&gate));
                    gate
                })
                .collect()
        };
        let mut leases = Vec::new();
        for gate in gates {
            leases.push(gate.lock_owned().await);
        }
        let guard = {
            let mut flight = self.flight.lock().unwrap();
            ensure!(
                !self.closing.load(Ordering::Acquire),
                error(
                    "storageBusy",
                    "Host credential operation is still in progress"
                )
            );
            let id = uuid::Uuid::new_v4().to_string();
            flight.insert(id.clone(), intent);
            FlightGuard {
                flight: self.flight.clone(),
                notice: self.idle_notice.clone(),
                id,
                _leases: leases,
            }
        };
        let mut worker = self.clone();
        worker.worker = true;
        // 生命周期归 Host 凭据事务；丢弃连接的等待者不会取消线程或提前释放准入。
        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            work(worker)
        })
        .await?
    }
    pub(crate) async fn close(&self) {
        self.closing.store(true, Ordering::Release);
        while !self.flight.lock().unwrap().is_empty() {
            self.idle_notice.notified().await;
        }
        self.owner.lock().unwrap().take();
    }
    pub(crate) async fn dispatch_async(
        &self,
        method: &str,
        params: Value,
        generation: &str,
        migration: &Migration,
    ) -> Result<Value> {
        if method == "vault.replace" {
            let input: Replace = serde_json::from_value(params.clone())?;
            wire::request_id(&input.request_id)?;
            ensure!(
                input.expected_generation == generation,
                error("generationMismatch", "Host generation changed")
            );
            let flight = self.flight.lock().unwrap();
            if let Some(active) = flight
                .values()
                .find(|active| active["requestId"] == input.request_id)
            {
                ensure!(
                    *active == params,
                    error(
                        "requestConflict",
                        "vault requestId binds different parameters"
                    )
                );
                return Self::operation_offline(&self.home, &input.request_id)?.ok_or_else(|| {
                    error(
                        "storageBusy",
                        "Host credential admission is still in progress",
                    )
                });
            }
        }
        let slot: Slot = serde_json::from_value(params["slot"].clone())?;
        let seed = migration.vault_seed(&slot)?;
        let method = method.to_owned();
        let generation = generation.to_owned();
        self.run(params.clone(), move |worker| {
            worker.dispatch_seed(&method, params, &generation, seed)
        })
        .await
    }
    pub(crate) async fn subscription_slot_async(
        &self,
        slot: Slot,
        migration: &Migration,
    ) -> Result<(u64, Value)> {
        let result = self
            .dispatch_async("vault.read", json!({"slot":slot}), "", migration)
            .await?;
        Ok((
            result["revision"].as_u64().unwrap(),
            result["value"].clone(),
        ))
    }
    pub(crate) async fn replace_subscription_transport_async(
        &self,
        source: &str,
        request_id: &str,
        expected_revision: u64,
        value: Value,
        migration: &Migration,
    ) -> Result<Value> {
        wire::request_id(request_id)?;
        let input = Replace {
            request_id: request_id.to_owned(),
            expected_generation: String::new(),
            slot: Slot::SubscriptionTransport {
                source_id: source.to_owned(),
            },
            expected_revision,
            value,
        };
        let seed = migration.vault_seed(&input.slot)?;
        let intent = json!({"requestId":request_id,"slot":input.slot,"expectedRevision":expected_revision,"value":input.value});
        self.run(intent, move |worker| worker.replace_seed(input, seed, true))
            .await
    }
    pub(crate) async fn read_async(&self, entry: &str) -> Result<Option<Value>> {
        let entry = entry.to_owned();
        self.run(json!({"entryId":entry}), move |worker| worker.read(&entry))
            .await
    }
    pub(crate) async fn operation_async(
        &self,
        id: &str,
        migration: &Migration,
    ) -> Result<Option<Value>> {
        let Some(receipt) = Self::operation_offline(&self.home, id)? else {
            return Ok(None);
        };
        if receipt["state"] != "acceptedPending"
            || self.flight.lock().unwrap().values().any(|active| {
                active["slot"] == receipt["slot"]
                    || active["slots"]
                        .as_array()
                        .is_some_and(|slots| slots.contains(&receipt["slot"]))
            })
        {
            return Ok(Some(receipt));
        }
        let slot: Slot = serde_json::from_value(receipt["slot"].clone())?;
        let seed = migration.vault_seed(&slot)?;
        let id = id.to_owned();
        self.run(json!({"slot":slot}), move |worker| {
            let mut state = worker.state_seed(&slot, seed)?;
            worker.recover(&mut state)?;
            Self::operation_offline(&worker.home, &id)
        })
        .await
    }
    pub(crate) async fn subscription_transport_is_current_async(
        &self,
        source: &str,
        revision: u64,
        entry: &str,
        migration: &Migration,
    ) -> Result<bool> {
        let slot = Slot::SubscriptionTransport {
            source_id: source.to_owned(),
        };
        let seed = migration.vault_seed(&slot)?;
        let entry = entry.to_owned();
        self.run(json!({"slot":slot}), move |worker| {
            let mut state = worker.state_seed(&slot, seed)?;
            worker.recover(&mut state)?;
            Ok(state.revision == revision && state.entry_id.as_deref() == Some(&entry))
        })
        .await
    }
    pub(crate) async fn claim_subscription_async(
        &self,
        source: &str,
        request: &str,
        account_revision: u64,
        transport_revision: u64,
        transport_entry: &str,
        migration: &Migration,
    ) -> Result<()> {
        wire::request_id(source)?;
        wire::request_id(request)?;
        let account = Slot::SubscriptionAccount {
            source_id: source.to_owned(),
            provider_id: "openai".into(),
        };
        let transport = Slot::SubscriptionTransport {
            source_id: source.to_owned(),
        };
        let account_seed = migration.vault_seed(&account)?;
        let transport_seed = migration.vault_seed(&transport)?;
        let source = source.to_owned();
        let request = request.to_owned();
        let transport_entry = transport_entry.to_owned();
        self.run(json!({"slots":[account,transport]}), move |worker| {
            let mut account = worker.state_seed(&account, account_seed)?;
            let mut transport = worker.state_seed(&transport, transport_seed)?;
            worker.recover(&mut account)?;
            worker.recover(&mut transport)?;
            ensure!(account.revision == account_revision && transport.revision == transport_revision
                && transport.entry_id.as_deref() == Some(&transport_entry)
                && worker.subscription_owner(&source)?.is_none(),
                error("revisionConflict", "subscription changed during handoff"));
            storage::private_dir(&worker.home.join("host/subscription-owners"))?;
            storage::write(&worker.home.join("host/subscription-owners").join(format!("{source}.json")),
                &json!({"owner":"nativeV1","sourceId":source,"requestId":request,"accountRevision":account_revision,"transportRevision":transport_revision}))
        }).await
    }
    pub(crate) fn provider_references(
        &self,
        source: &str,
    ) -> Result<std::collections::BTreeSet<String>> {
        let mut references = std::collections::BTreeSet::new();
        for path in storage::json_records(&self.home.join("host/vault-slots"), false)? {
            let state: SlotState = storage::read(&path)?;
            if let Slot::ProviderCredential {
                source_id,
                reference,
            } = state.slot
                && source_id == source
            {
                references.insert(reference);
            }
        }
        Ok(references)
    }
    pub(crate) fn operation_offline(home: &Path, id: &str) -> Result<Option<Value>> {
        wire::request_id(id)?;
        let vault = Self::new(home);
        let receipt: Option<Value> = storage::read_json(&vault.operation_path(id))?;
        if receipt
            .as_ref()
            .is_some_and(|value| value["state"] != "acceptedPending")
        {
            return Ok(receipt);
        }
        for path in storage::json_records(&home.join("host/vault-slots"), false)? {
            let state: SlotState = storage::read(&path)?;
            if let Some(committed) = state.receipt.filter(|value| value["requestId"] == id) {
                return Ok(Some(committed));
            }
        }
        Ok(receipt)
    }
    fn state_path(&self, slot: &Slot) -> Result<PathBuf> {
        Ok(self.home.join("host/vault-slots").join(format!(
            "{}.json",
            storage::digest(&serde_json::to_vec(slot)?)
        )))
    }
    fn state(&self, slot: &Slot, migration: &Migration) -> Result<SlotState> {
        self.idle()?;
        self.state_seed(slot, migration.vault_seed(slot)?)
    }
    fn state_seed(&self, slot: &Slot, seed: Option<Receipt>) -> Result<SlotState> {
        if let Some(state) = storage::read_json::<SlotState>(&self.state_path(slot)?)? {
            ensure!(state.slot == *slot, "vault slot metadata mismatch");
            return Ok(state);
        }
        let state = SlotState {
            slot: slot.clone(),
            revision: seed.as_ref().map_or(0, |r| r.revision),
            entry_id: seed.map(|r| r.entry_id),
            receipt: None,
        };
        self.save_state(&state)?;
        Ok(state)
    }
    fn save_state(&self, state: &SlotState) -> Result<()> {
        storage::private_dir(&self.home.join("host/vault-slots"))?;
        std::fs::File::open(self.home.join("host"))?.sync_all()?;
        storage::write(&self.state_path(&state.slot)?, state)
    }
    fn save_operation(&self, receipt: &Value) -> Result<()> {
        storage::private_dir(&self.home.join("host/vault-operations"))?;
        std::fs::File::open(self.home.join("host"))?.sync_all()?;
        let id = receipt["requestId"]
            .as_str()
            .ok_or_else(|| error("invalidRequest", "missing vault requestId"))?;
        wire::request_id(id)?;
        storage::write(&self.operation_path(id), receipt)
    }
    fn operation_path(&self, id: &str) -> PathBuf {
        self.home
            .join("host/vault-operations")
            .join(format!("{id}.json"))
    }
    fn recover(&self, state: &mut SlotState) -> Result<()> {
        self.idle()?;
        if let Some(receipt) = &state.receipt {
            let id = receipt["requestId"]
                .as_str()
                .ok_or_else(|| error("invalidRequest", "missing vault requestId"))?;
            wire::request_id(id)?;
            let path = self.operation_path(id);
            if !path.exists() || storage::read::<Value>(&path)? != *receipt {
                self.save_operation(receipt)?;
            }
        }
        for path in storage::json_records(&self.home.join("host/vault-operations"), false)? {
            let mut receipt: Value = storage::read(&path)?;
            if receipt["state"] != "acceptedPending"
                || receipt["slot"] != serde_json::to_value(&state.slot)?
            {
                continue;
            }
            let id = receipt["entryId"]
                .as_str()
                .ok_or_else(|| error("invalidRequest", "missing pending vault entryId"))?
                .to_owned();
            let value = self.read(&id)?;
            let failure = if receipt["previousRevision"] != state.revision {
                Some(("revisionConflict", "vault revision changed before recovery"))
            } else if value.is_none() {
                Some(("storageWriteNotApplied", "vault entry was not written"))
            } else {
                None
            };
            if let Some((code, message)) = failure {
                receipt["state"] = json!("blocked");
                receipt["error"] = json!({"code":code,"message":message});
                self.save_operation(&receipt)?;
                continue;
            }
            state.revision = state
                .revision
                .checked_add(1)
                .ok_or_else(|| error("revisionConflict", "vault revision exhausted"))?;
            state.entry_id = Some(id);
            receipt["state"] = json!("completed");
            receipt["revision"] = json!(state.revision);
            state.receipt = Some(receipt.clone());
            self.save_state(state)?;
            self.save_operation(&receipt)?;
        }
        Ok(())
    }
    pub fn operation(&self, id: &str, migration: &Migration) -> Result<Option<Value>> {
        wire::request_id(id)?;
        if !self.worker && !self.flight.lock().unwrap().is_empty() {
            return Self::operation_offline(&self.home, id);
        }
        let receipt = storage::read_json::<Value>(&self.operation_path(id))?;
        if receipt.is_none() {
            for path in storage::json_records(&self.home.join("host/vault-slots"), false)? {
                let state: SlotState = storage::read(&path)?;
                if let Some(receipt) = state.receipt.filter(|receipt| receipt["requestId"] == id) {
                    self.save_operation(&receipt)?;
                    return Ok(Some(receipt));
                }
            }
            return Ok(None);
        }
        let receipt = receipt.unwrap();
        if receipt["state"] != "acceptedPending" {
            return Ok(Some(receipt));
        }
        let slot: Slot = serde_json::from_value(receipt["slot"].clone())?;
        let mut state = self.state(&slot, migration)?;
        self.recover(&mut state)?;
        storage::read_json(&self.operation_path(id))
    }
    pub fn dispatch(
        &self,
        method: &str,
        params: Value,
        generation: &str,
        migration: &Migration,
    ) -> Result<Value> {
        self.idle()?;
        let slot: Slot = serde_json::from_value(params["slot"].clone())?;
        self.dispatch_seed(method, params, generation, migration.vault_seed(&slot)?)
    }
    fn dispatch_seed(
        &self,
        method: &str,
        params: Value,
        generation: &str,
        seed: Option<Receipt>,
    ) -> Result<Value> {
        if method == "vault.read" {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Read {
                slot: Slot,
                interaction_allowed: Option<bool>,
            }
            let input: Read = serde_json::from_value(params)?;
            let read = |vault: &Self| {
                let mut state = vault.state_seed(&input.slot, seed)?;
                vault.recover(&mut state)?;
                let value = match state.entry_id {
                    Some(id) => vault
                        .read(&id)?
                        .ok_or_else(|| error("storageMissing", "current vault entry is missing"))?,
                    None => Value::Null,
                };
                Ok(json!({"revision":state.revision,"value":value}))
            };
            return if input.interaction_allowed == Some(false) {
                self.without_interaction(read)
            } else {
                read(self)
            };
        }
        if method != "vault.replace" {
            return Err(error("methodNotFound", "unknown vault method"));
        }
        let input: Replace = serde_json::from_value(params)?;
        wire::request_id(&input.request_id)?;
        if input.expected_generation != generation {
            return Err(error("generationMismatch", "Host generation changed"));
        }
        self.replace_seed(input, seed, false)
    }
    fn replace(
        &self,
        input: Replace,
        migration: &Migration,
        native_subscription: bool,
    ) -> Result<Value> {
        self.idle()?;
        let seed = migration.vault_seed(&input.slot)?;
        self.replace_seed(input, seed, native_subscription)
    }
    fn replace_seed(
        &self,
        input: Replace,
        seed: Option<Receipt>,
        native_subscription: bool,
    ) -> Result<Value> {
        let mut state = self.state_seed(&input.slot, seed)?;
        self.recover(&mut state)?;
        if let Some(previous) = Self::operation_offline(&self.home, &input.request_id)? {
            if previous["slot"] != serde_json::to_value(&input.slot)?
                || previous["previousRevision"] != input.expected_revision
            {
                return Err(error(
                    "requestConflict",
                    "vault requestId binds different parameters",
                ));
            }
            let entry = previous["entryId"]
                .as_str()
                .ok_or_else(|| error("invalidRequest", "missing vault operation entryId"))?;
            let value = self.read(entry)?;
            if value.is_none() && previous["state"] == "completed" {
                return Err(error(
                    "storageMissing",
                    "completed vault operation entry is missing",
                ));
            }
            if value.is_some_and(|value| value != input.value) {
                return Err(error(
                    "requestConflict",
                    "vault requestId binds a different value",
                ));
            }
            return Ok(previous);
        }
        if !native_subscription {
            let source = match &input.slot {
                Slot::SubscriptionAccount {
                    source_id,
                    provider_id,
                } if provider_id == "openai" => Some(source_id),
                Slot::SubscriptionTransport { source_id } => Some(source_id),
                _ => None,
            };
            if let Some(source) = source
                && self.subscription_owner(source)?.is_some()
            {
                return Err(error(
                    "subscriptionOwnerRequired",
                    "subscription credentials are owned by the Host",
                ));
            }
        }
        if state.revision != input.expected_revision {
            return Err(error("revisionConflict", "vault revision changed"));
        }
        if !input.value.is_null() {
            match &input.slot {
                Slot::ProviderCredential { .. } => ensure!(
                    input.value.as_str().is_some_and(|s| !s.is_empty()),
                    "provider credential requires a nonempty string or null"
                ),
                _ => ensure!(
                    input.value.is_object(),
                    "subscription slot requires a complete object or null"
                ),
            }
        }
        let revision = state
            .revision
            .checked_add(1)
            .ok_or_else(|| error("revisionConflict", "vault revision exhausted"))?;
        let entry_id = uuid::Uuid::new_v4().to_string();
        let mut receipt = json!({"requestId":input.request_id,"method":"vault.replace","slot":input.slot,"previousRevision":input.expected_revision,"entryId":entry_id,"state":"acceptedPending"});
        self.save_operation(&receipt)?;
        self.write(&entry_id, &input.value)?;
        state.revision = revision;
        state.entry_id = Some(entry_id);
        receipt["revision"] = json!(revision);
        receipt["state"] = json!("completed");
        state.receipt = Some(receipt.clone());
        self.save_state(&state)?;
        self.save_operation(&receipt)?;
        Ok(receipt)
    }
    pub(crate) fn subscription_account(
        &self,
        source: &str,
        migration: &Migration,
    ) -> Result<(u64, Value)> {
        self.subscription_slot(
            &Slot::SubscriptionAccount {
                source_id: source.to_owned(),
                provider_id: "openai".into(),
            },
            migration,
        )
    }
    fn subscription_slot(&self, slot: &Slot, migration: &Migration) -> Result<(u64, Value)> {
        let mut state = self.state(slot, migration)?;
        self.recover(&mut state)?;
        let value = match state.entry_id {
            Some(id) => self
                .read(&id)?
                .ok_or_else(|| error("storageMissing", "current vault entry is missing"))?,
            None => Value::Null,
        };
        Ok((state.revision, value))
    }
    pub(crate) fn subscription_transport(
        &self,
        source: &str,
        migration: &Migration,
    ) -> Result<(u64, Value)> {
        self.subscription_slot(
            &Slot::SubscriptionTransport {
                source_id: source.to_owned(),
            },
            migration,
        )
    }
    #[cfg(test)]
    pub(crate) fn replace_subscription_transport(
        &self,
        source: &str,
        request_id: &str,
        expected_revision: u64,
        value: Value,
        migration: &Migration,
    ) -> Result<Value> {
        wire::request_id(request_id)?;
        self.replace(
            Replace {
                request_id: request_id.to_owned(),
                expected_generation: String::new(),
                slot: Slot::SubscriptionTransport {
                    source_id: source.to_owned(),
                },
                expected_revision,
                value,
            },
            migration,
            true,
        )
    }
    pub(crate) fn replace_subscription_account(
        &self,
        source: &str,
        request_id: &str,
        expected_revision: u64,
        value: Value,
        migration: &Migration,
    ) -> Result<Value> {
        wire::request_id(request_id)?;
        self.replace(
            Replace {
                request_id: request_id.to_owned(),
                expected_generation: String::new(),
                slot: Slot::SubscriptionAccount {
                    source_id: source.to_owned(),
                    provider_id: "openai".into(),
                },
                expected_revision,
                value,
            },
            migration,
            true,
        )
    }
    pub(crate) fn subscription_owner(&self, source: &str) -> Result<Option<Value>> {
        wire::request_id(source)?;
        storage::read_json(
            &self
                .home
                .join("host/subscription-owners")
                .join(format!("{source}.json")),
        )
    }
    pub fn new(home: &Path) -> Self {
        Self {
            home: home.to_owned(),
            owner: Arc::new(Mutex::new(None)),
            #[cfg(target_os = "macos")]
            authority: Arc::new(Mutex::new(None)),
            flight: Arc::new(Mutex::new(BTreeMap::new())),
            worker: false,
            closing: Arc::new(AtomicBool::new(false)),
            idle_notice: Arc::new(tokio::sync::Notify::new()),
            gates: Arc::new(Mutex::new(BTreeMap::new())),
            interaction_allowed: true,
            #[cfg(test)]
            isolated_files: false,
            #[cfg(test)]
            locked: std::cell::Cell::new(false),
            #[cfg(test)]
            before_write: None,
        }
    }
    #[cfg(test)]
    pub fn isolated_files(home: &Path) -> Self {
        Self {
            home: home.to_owned(),
            owner: Arc::new(Mutex::new(None)),
            #[cfg(target_os = "macos")]
            authority: Arc::new(Mutex::new(None)),
            flight: Arc::new(Mutex::new(BTreeMap::new())),
            worker: false,
            closing: Arc::new(AtomicBool::new(false)),
            idle_notice: Arc::new(tokio::sync::Notify::new()),
            gates: Arc::new(Mutex::new(BTreeMap::new())),
            interaction_allowed: true,
            isolated_files: true,
            locked: std::cell::Cell::new(false),
            #[cfg(test)]
            before_write: None,
        }
    }
    pub fn write(&self, entry: &str, value: &Value) -> Result<()> {
        self.idle()?;
        crate::wire::request_id(entry)?;
        if let Some(current) = self.read(entry)? {
            if current != *value {
                return Err(error(
                    "requestConflict",
                    "vault entry already contains a different value",
                ));
            }
            return Ok(());
        }
        #[cfg(test)]
        if let Some(before_write) = &self.before_write {
            before_write();
        }
        #[cfg(test)]
        if self.isolated_files {
            return self.write_file(entry, value);
        }
        #[cfg(target_os = "macos")]
        {
            let owner = self.owner.lock().unwrap().clone();
            let authority = self.authority.lock().unwrap().clone();
            crate::credential_io::execute(
                owner.as_deref(),
                authority.as_ref(),
                crate::credential_io::Request::Write {
                    entry: entry.to_owned(),
                    value: value.clone(),
                },
            )?;
        }
        #[cfg(not(target_os = "macos"))]
        {
            self.write_file(entry, value)?;
        }
        ensure!(
            self.read(entry)?.as_ref() == Some(value),
            "vault read-back verification failed"
        );
        Ok(())
    }
    pub(crate) fn read_without_interaction(&self, entry: &str) -> Result<Option<Value>> {
        self.without_interaction(|vault| vault.read(entry))
    }
    fn without_interaction<T>(&self, read: impl FnOnce(&Self) -> Result<T>) -> Result<T> {
        self.idle()?;
        let mut noninteractive = self.clone();
        noninteractive.interaction_allowed = false;
        read(&noninteractive)
    }
    pub fn read(&self, entry: &str) -> Result<Option<Value>> {
        self.idle()?;
        crate::wire::request_id(entry)?;
        #[cfg(test)]
        if self.locked.get() {
            return Err(error("storageLocked", "isolated vault is locked"));
        }
        #[cfg(test)]
        if self.isolated_files {
            return storage::read_json(&self.path(entry));
        }
        #[cfg(target_os = "macos")]
        {
            let owner = self.owner.lock().unwrap().clone();
            let authority = self.authority.lock().unwrap().clone();
            crate::credential_io::execute(
                owner.as_deref(),
                authority.as_ref(),
                crate::credential_io::Request::Read {
                    entry: entry.to_owned(),
                    interaction_allowed: self.interaction_allowed,
                },
            )
        }
        #[cfg(not(target_os = "macos"))]
        storage::read_json(&self.path(entry))
    }
    #[cfg(all(test, target_os = "macos"))]
    fn service(&self) -> String {
        format!(
            "org.areal.host.v1.{}",
            storage::digest(self.home.as_os_str().as_encoded_bytes())
        )
    }
    #[cfg(any(test, not(target_os = "macos")))]
    fn path(&self, entry: &str) -> PathBuf {
        self.home.join("host/vault").join(format!("{entry}.json"))
    }
    #[cfg(any(test, not(target_os = "macos")))]
    fn write_file(&self, entry: &str, value: &Value) -> Result<()> {
        storage::private_dir(&self.home.join("host/vault"))?;
        std::fs::File::open(self.home.join("host"))?.sync_all()?;
        storage::write(&self.path(entry), value)?;
        ensure!(
            storage::read_json::<Value>(&self.path(entry))?.as_ref() == Some(value),
            "vault read-back verification failed"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        journal::Journal,
        migration::{Import, Source},
    };

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "creates and removes one synthetic login Keychain item"]
    fn noninteractive_retirement_read_preserves_keychain_interaction_state() {
        use fs2::FileExt;
        use security_framework::os::macos::keychain::SecKeychain;
        let root = tempfile::tempdir().unwrap();
        let home = storage::prepare_host_home(root.path()).unwrap();
        storage::private_dir(&home.join("host/vault-operations")).unwrap();
        let owner = Arc::new(storage::open_private(&home.join("host.lock"), true).unwrap());
        owner.try_lock_exclusive().unwrap();
        let identity = crate::HostIdentity {
            version: crate::VERSION,
            host_id: uuid::Uuid::new_v4().to_string(),
            generation: uuid::Uuid::new_v4().to_string(),
            socket_path: home.join("socket"),
            auth_file: home.join("host/auth.json"),
            pid: std::process::id(),
            executable_version: "fixture".into(),
        };
        storage::write(&home.join("host/host.json"), &identity).unwrap();
        storage::write(&identity.auth_file, &"synthetic-auth").unwrap();
        let mut vault = Vault::new(&home);
        vault.hold_owner(owner, &identity, "synthetic-auth");
        let service = vault.service();
        let entry = uuid::Uuid::new_v4().to_string();
        storage::write(
            &home.join("host/vault-operations/fixture.json"),
            &json!({"entryId":entry,"state":"acceptedPending"}),
        )
        .unwrap();
        let before = SecKeychain::user_interaction_allowed().unwrap();
        let created = std::process::Command::new("/usr/bin/security")
            .args([
                "add-generic-password",
                "-s",
                &service,
                "-a",
                &entry,
                "-w",
                r#"{"synthetic":true}"#,
                "-T",
                "/usr/bin/security",
            ])
            .output()
            .unwrap();
        assert!(created.status.success(), "synthetic entry creation failed");
        let started = std::time::Instant::now();
        let result = vault.read_without_interaction(&entry);
        let elapsed = started.elapsed();
        let after = SecKeychain::user_interaction_allowed();
        let deleted = std::process::Command::new("/usr/bin/security")
            .args(["delete-generic-password", "-s", &service, "-a", &entry])
            .output()
            .unwrap();
        assert!(deleted.status.success(), "synthetic entry cleanup failed");
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "read waited: {elapsed:?}"
        );
        assert!(result.unwrap_err().to_string().contains("storageLocked"));
        assert_eq!(after.unwrap(), before);
        assert!(vault.read_without_interaction(&entry).unwrap().is_none());
        assert_eq!(SecKeychain::user_interaction_allowed().unwrap(), before);
    }

    struct Fixture {
        _root: tempfile::TempDir,
        migration: Migration,
        slot: Slot,
    }
    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let home = root.path().join("home");
            storage::private_dir(&home.join("host")).unwrap();
            let core = root.path().join("core");
            storage::private_dir(&core).unwrap();
            let profile = root.path().join("profile");
            storage::private_dir(&profile).unwrap();
            let workspace = root.path().join("workspace");
            std::fs::create_dir(&workspace).unwrap();
            storage::write(
                &core.join("projects.json"),
                &json!([{"id":"a".repeat(24),"root":workspace}]),
            )
            .unwrap();
            let source = Source {
                profile,
                core_home: core,
                legacy_service_home: root.path().join("legacy"),
            };
            let mut migration = Migration::new(&home).unwrap();
            migration.vault = Vault::isolated_files(&home);
            migration
                .attach(source.clone(), "connection", None)
                .unwrap();
            let imported = migration.import(serde_json::from_value::<Import>(json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":"generation","source":source})).unwrap(),"connection",&[],&Journal::new(&home).unwrap()).unwrap();
            assert_eq!(imported["kind"], "ready");
            let slot = Slot::SubscriptionAccount {
                source_id: imported["receipt"]["sourceId"].as_str().unwrap().into(),
                provider_id: "chatgpt".into(),
            };
            Self {
                _root: root,
                migration,
                slot,
            }
        }
        fn replace(&self, id: &str, revision: u64, value: Value) -> Result<Value> {
            self.migration.vault.dispatch("vault.replace",json!({"requestId":id,"expectedGeneration":"generation","slot":self.slot,"expectedRevision":revision,"value":value}),"generation",&self.migration)
        }
        fn read(&self) -> Result<Value> {
            self.migration.vault.dispatch(
                "vault.read",
                json!({"slot":self.slot}),
                "generation",
                &self.migration,
            )
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn blocked_subscription_write_does_not_block_another_provider_slot() {
        use std::time::Duration;
        let mut f = Fixture::new();
        let provider = Slot::ProviderCredential {
            source_id: f.slot.source_id().unwrap().into(),
            reference: "AREAL_CREDENTIAL_synthetic".into(),
        };
        f.migration.vault.dispatch("vault.replace", json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":"generation","slot":provider,"expectedRevision":0,"value":"synthetic"}), "generation", &f.migration).unwrap();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let barrier = Mutex::new(Some((entered_tx, release_rx)));
        f.migration.vault.before_write = Some(Arc::new(move || {
            if let Some((entered, release)) = barrier.lock().unwrap().take() {
                let _ = entered.send(());
                let _ = release.recv();
            }
        }));
        let id = uuid::Uuid::new_v4().to_string();
        let mut writing = Box::pin(f.migration.vault.dispatch_async("vault.replace", json!({"requestId":id,"expectedGeneration":"generation","slot":f.slot,"expectedRevision":0,"value":{"synthetic":true}}), "generation", &f.migration));
        tokio::select! {
            result=entered_rx=>result.unwrap(),
            result=&mut writing=>panic!("write ended before barrier: {result:?}"),
        }
        let other = tokio::time::timeout(
            Duration::from_secs(1),
            f.migration.vault.dispatch_async(
                "vault.read",
                json!({"slot":provider,"interactionAllowed":false}),
                "generation",
                &f.migration,
            ),
        )
        .await;
        let pending = f
            .migration
            .vault
            .operation_async(&id, &f.migration)
            .await
            .unwrap()
            .unwrap();
        release_tx.send(()).unwrap();
        let done = writing.await.unwrap();
        assert_eq!(pending["state"], "acceptedPending");
        assert_eq!(done["revision"], 1);
        assert_eq!(
            other
                .expect("subscription credential blocked an unrelated provider slot")
                .unwrap()["value"],
            "synthetic"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn remote_initialization_does_not_conflict_with_subscription_io() {
        let f = Fixture::new();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let vault = f.migration.vault.clone();
        let source = f.slot.source_id().unwrap().to_owned();
        let mut writing = Box::pin(vault.run(
            json!({"slot":{"kind":"subscriptionTransport","sourceId":source}}),
            move |_| {
                let _ = entered_tx.send(());
                release_rx.recv()?;
                Ok(())
            },
        ));
        tokio::select! {
            result = entered_rx => result.unwrap(),
            result = &mut writing => panic!("subscription ended before barrier: {result:?}"),
        }
        let remote = crate::remote_state::RemoteState::new(&f.migration.vault.home);
        let request = uuid::Uuid::new_v4().to_string();
        use base64::Engine;
        let noise = base64::engine::general_purpose::STANDARD.encode(
            libp2p_identity::Keypair::ed25519_from_bytes([7u8; 32])
                .unwrap()
                .to_protobuf_encoding()
                .unwrap(),
        );
        let identity = crate::HostIdentity {
            version: crate::VERSION,
            host_id: uuid::Uuid::new_v4().to_string(),
            generation: "generation".into(),
            pid: std::process::id(),
            socket_path: f.migration.vault.home.join("socket"),
            auth_file: f.migration.vault.home.join("auth"),
            executable_version: "fixture".into(),
        };
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let receipt = remote.dispatch_async("remote.replace", json!({"requestId":request,"expectedGeneration":"generation","expectedRevision":0,"sourceId":f.slot.source_id().unwrap(),"config":{"identity":noise,"devices":[]}}), "fixture", "generation", &f.migration, &[]).await?;
            let snapshot = remote.snapshot_async(&f.migration).await?;
            ensure!(snapshot["revision"] == 1 && receipt["state"] == "completed", "Remote write did not settle");
            remote.handoff_async(json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":"generation","sourceId":f.slot.source_id().unwrap(),"expectedRevision":1}), &identity, &f.migration).await
        }).await;
        release_tx.send(()).unwrap();
        writing.await.unwrap();
        assert_eq!(
            result.unwrap().unwrap()["owner"],
            "native",
            "订阅 I/O 不能阻止 Remote 初始化与 handoff"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn remote_write_survives_waiter_cancel_without_premature_recovery() {
        let mut f = Fixture::new();
        let provider_slot = Slot::ProviderCredential {
            source_id: f.slot.source_id().unwrap().into(),
            reference: "AREAL_CREDENTIAL_synthetic".into(),
        };
        f.migration.vault.dispatch("vault.replace", json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":"generation","slot":provider_slot,"expectedRevision":0,"value":"synthetic-provider"}), "generation", &f.migration).unwrap();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let entered_tx = Mutex::new(Some(entered_tx));
        let release_rx = Mutex::new(release_rx);
        f.migration.vault.before_write = Some(Arc::new(move || {
            if let Some(entered) = entered_tx.lock().unwrap().take() {
                let _ = entered.send(());
                release_rx.lock().unwrap().recv().unwrap();
            }
        }));
        let remote = crate::remote_state::RemoteState::new(&f.migration.vault.home);
        let request = uuid::Uuid::new_v4().to_string();
        let params = json!({"requestId":request,"expectedGeneration":"generation","expectedRevision":0,"sourceId":f.slot.source_id().unwrap(),"config":{"identity":"synthetic-noise","devices":[]}});
        let mut writing = Box::pin(remote.dispatch_async(
            "remote.replace",
            params.clone(),
            "fixture",
            "generation",
            &f.migration,
            &[],
        ));
        tokio::select! {
            result = entered_rx => result.unwrap(),
            result = &mut writing => panic!("Remote write ended before barrier: {result:?}"),
        }
        drop(writing);
        let pending = remote.operation_async(&request, &f.migration).await;
        let sync_pending = remote.operation(&request, &f.migration);
        let provider = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            f.migration.vault.dispatch_async(
                "vault.read",
                json!({"slot":provider_slot}),
                "generation",
                &f.migration,
            ),
        )
        .await;
        release_tx.send(()).unwrap();
        while f.migration.vault.slot_in_flight(&Slot::RemoteIdentity) {
            f.migration.vault.idle_notice.notified().await;
        }
        let done = remote
            .operation_async(&request, &f.migration)
            .await
            .unwrap()
            .unwrap();
        let repeated = remote
            .dispatch_async(
                "remote.replace",
                params,
                "fixture",
                "generation",
                &f.migration,
                &[],
            )
            .await
            .unwrap();
        assert_eq!(pending.unwrap().unwrap()["state"], "acceptedPending");
        assert_eq!(sync_pending.unwrap().unwrap()["state"], "acceptedPending");
        assert_eq!(provider.unwrap().unwrap()["value"], "synthetic-provider");
        assert_eq!(done["state"], "completed");
        assert_eq!(done["revision"], 1);
        assert_eq!(repeated, done);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancelled_waiter_keeps_host_lock_and_close_waits_for_credential_io() {
        use fs2::FileExt;
        use std::{future::Future, task::Poll, time::Duration};
        let root = tempfile::tempdir().unwrap();
        let owner_path = root.path().join("host.lock");
        let owner = Arc::new(storage::open_private(&owner_path, true).unwrap());
        owner.try_lock_exclusive().unwrap();
        let mut vault = Vault::isolated_files(root.path());
        vault.hold_owner(
            owner.clone(),
            &crate::HostIdentity {
                version: crate::VERSION,
                host_id: uuid::Uuid::new_v4().to_string(),
                generation: uuid::Uuid::new_v4().to_string(),
                socket_path: root.path().join("socket"),
                auth_file: root.path().join("auth"),
                pid: std::process::id(),
                executable_version: "fixture".into(),
            },
            "fixture",
        );
        let idle_notice = vault.idle_notice.clone();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let entry = uuid::Uuid::new_v4().to_string();
        let entry_path = vault.path(&entry);
        let mut work = Box::pin(vault.run(Value::Null, move |worker| {
            let _ = entered_tx.send(());
            release_rx.recv()?;
            worker.write(&entry, &json!({"synthetic":true}))
        }));
        tokio::time::timeout(Duration::from_secs(5), async {
            tokio::select! {
                result=entered_rx=>result.unwrap(),
                result=&mut work=>panic!("worker ended before its barrier: {result:?}"),
            }
        })
        .await
        .unwrap();
        let mut closing = Box::pin(vault.close());
        let pending = std::future::poll_fn(|context| {
            Poll::Ready(closing.as_mut().poll(context).is_pending())
        })
        .await;
        assert!(pending, "关闭不能提前释放仍在执行的凭据事务");
        drop(closing);
        assert!(vault.idle().is_err(), "关闭开始后不能准入另一写者");
        drop(work);
        drop(vault);
        drop(owner);
        let contender = storage::open_private(&owner_path, false).unwrap();
        assert_eq!(
            contender.try_lock_exclusive().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        release_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), idle_notice.notified())
            .await
            .unwrap();
        // 其他并行测试的 fork→exec 窗口会短暂保留 CLOEXEC fd，等待实际释放。
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match contender.try_lock_exclusive() {
                    Ok(()) => break,
                    Err(cause) if cause.kind() == std::io::ErrorKind::WouldBlock => {
                        tokio::task::yield_now().await;
                    }
                    Err(cause) => panic!("owner lock probe failed: {cause}"),
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(
            storage::read::<Value>(&entry_path).unwrap(),
            json!({"synthetic":true})
        );
    }

    #[test]
    fn completed_slot_read_does_not_rewrite_receipt() {
        use std::os::unix::fs::MetadataExt;
        let f = Fixture::new();
        let id = uuid::Uuid::new_v4().to_string();
        f.replace(&id, 0, json!({"token":"test"})).unwrap();
        let path = f.migration.vault.operation_path(&id);
        let before = std::fs::metadata(&path).unwrap();
        f.read().unwrap();
        let after = std::fs::metadata(&path).unwrap();
        assert_eq!(
            (before.ino(), before.mtime(), before.mtime_nsec()),
            (after.ino(), after.mtime(), after.mtime_nsec())
        );
    }

    #[test]
    fn noninteractive_slot_read_preserves_revision_across_lock_and_unlock() {
        let f = Fixture::new();
        let request = uuid::Uuid::new_v4().to_string();
        let completed = f
            .replace(&request, 0, json!({"token":"synthetic"}))
            .unwrap();
        f.migration.vault.locked.set(true);
        let error = f
            .migration
            .vault
            .dispatch(
                "vault.read",
                json!({"slot":f.slot,"interactionAllowed":false}),
                "generation",
                &f.migration,
            )
            .unwrap_err();
        assert!(error.to_string().contains("storageLocked"));
        f.migration.vault.locked.set(false);
        let current = f
            .migration
            .vault
            .dispatch(
                "vault.read",
                json!({"slot":f.slot,"interactionAllowed":false}),
                "generation",
                &f.migration,
            )
            .unwrap();
        assert_eq!(current["revision"], completed["revision"]);
        assert_eq!(current["value"], json!({"token":"synthetic"}));
    }

    #[test]
    fn account_refresh_logout_cas_and_restart_preserve_revocation() {
        let f = Fixture::new();
        assert_eq!(f.read().unwrap(), json!({"revision":0,"value":null}));
        let id = uuid::Uuid::new_v4().to_string();
        let account = json!({"accessToken":"secret-access","refreshToken":"secret-refresh","account":{"id":"account"}});
        let receipt = f.replace(&id, 0, account.clone()).unwrap();
        assert_eq!(receipt["revision"], 1);
        assert_eq!(f.replace(&id, 0, account.clone()).unwrap(), receipt);
        assert!(
            f.replace(&id, 0, json!({"accessToken":"different"}))
                .unwrap_err()
                .to_string()
                .contains("requestConflict")
        );
        let logout = f
            .replace(&uuid::Uuid::new_v4().to_string(), 1, Value::Null)
            .unwrap();
        assert_eq!(logout["revision"], 2);
        let refresh_id = uuid::Uuid::new_v4().to_string();
        assert!(
            f.replace(&refresh_id, 1, account)
                .unwrap_err()
                .to_string()
                .contains("revisionConflict")
        );
        assert!(
            f.migration
                .vault
                .operation(&refresh_id, &f.migration)
                .unwrap()
                .is_none()
        );
        let restarted = Vault::isolated_files(&f.migration.vault.home);
        assert_eq!(
            restarted
                .dispatch(
                    "vault.read",
                    json!({"slot":f.slot}),
                    "new-generation",
                    &f.migration
                )
                .unwrap(),
            json!({"revision":2,"value":null})
        );
        assert_eq!(
            restarted.operation(&id, &f.migration).unwrap().unwrap(),
            receipt
        );
        assert_ne!(receipt["entryId"], logout["entryId"]);
        for directory in ["vault-slots", "vault-operations"] {
            for file in std::fs::read_dir(restarted.home.join("host").join(directory)).unwrap() {
                let text = std::fs::read_to_string(file.unwrap().path()).unwrap();
                assert!(
                    !text.contains("secret-access")
                        && !text.contains("secret-refresh")
                        && !text.contains("accessToken")
                );
                assert!(
                    !text.contains(&storage::digest(b"secret-access"))
                        && !text.contains(&storage::digest(b"secret-refresh"))
                );
            }
        }
    }

    #[test]
    fn interrupted_replacement_queries_original_evidence_without_reexecution() {
        for window in ["beforeVault", "afterVault", "afterState", "afterLogout"] {
            let f = Fixture::new();
            let mut state = f.migration.vault.state(&f.slot, &f.migration).unwrap();
            let id = uuid::Uuid::new_v4().to_string();
            let entry = uuid::Uuid::new_v4().to_string();
            let pending = json!({"requestId":id,"method":"vault.replace","slot":f.slot,"previousRevision":0,"entryId":entry,"state":"acceptedPending"});
            f.migration.vault.save_operation(&pending).unwrap();
            let proposed = json!({"refreshToken":"isolated-secret"});
            if window != "beforeVault" {
                f.migration.vault.write(&entry, &proposed).unwrap();
            }
            if window == "afterState" {
                state.revision = 1;
                state.entry_id = Some(entry.clone());
                let mut completed = pending.clone();
                completed["state"] = json!("completed");
                completed["revision"] = json!(1);
                state.receipt = Some(completed);
            }
            if window == "afterLogout" {
                state.revision = 2;
                let revoked = uuid::Uuid::new_v4().to_string();
                f.migration.vault.write(&revoked, &Value::Null).unwrap();
                state.entry_id = Some(revoked);
            }
            f.migration.vault.save_state(&state).unwrap();
            let offline = crate::operation_offline(&f.migration.vault.home, &id)
                .unwrap()
                .unwrap();
            assert_eq!(
                offline["state"],
                if window == "afterState" {
                    "completed"
                } else {
                    "acceptedPending"
                },
                "offline lookup uses metadata only at {window}"
            );
            assert_eq!(
                storage::read::<Value>(&f.migration.vault.operation_path(&id)).unwrap(),
                pending
            );
            let restarted = Vault::isolated_files(&f.migration.vault.home);
            let receipt = restarted.operation(&id, &f.migration).unwrap().unwrap();
            let applied = matches!(window, "afterVault" | "afterState");
            assert_eq!(
                receipt["state"],
                if applied { "completed" } else { "blocked" },
                "{window}"
            );
            assert_eq!(
                f.read().unwrap()["revision"],
                if applied { 1 } else { state.revision }
            );
            assert_eq!(f.replace(&id, 0, proposed).unwrap(), receipt);
            assert_eq!(
                restarted.read(&entry).unwrap().is_some(),
                window != "beforeVault",
                "query must not write an absent entry"
            );
            assert_eq!(f.read().unwrap()["value"].is_null(), !applied);
        }
    }

    #[test]
    fn locked_pending_entry_stays_unknown_and_missing_entry_is_distinct() {
        let f = Fixture::new();
        let id = uuid::Uuid::new_v4().to_string();
        let entry = uuid::Uuid::new_v4().to_string();
        let pending = json!({"requestId":id,"method":"vault.replace","slot":f.slot,"previousRevision":0,"entryId":entry,"state":"acceptedPending"});
        f.migration.vault.save_operation(&pending).unwrap();
        f.migration.vault.locked.set(true);
        assert_eq!(
            crate::operation_offline(&f.migration.vault.home, &id).unwrap(),
            Some(pending.clone())
        );
        assert!(
            f.migration
                .vault
                .operation(&id, &f.migration)
                .unwrap_err()
                .to_string()
                .contains("storageLocked")
        );
        assert_eq!(
            storage::read::<Value>(&f.migration.vault.operation_path(&id)).unwrap(),
            pending
        );
        f.migration.vault.locked.set(false);
        let receipt = f
            .migration
            .vault
            .operation(&id, &f.migration)
            .unwrap()
            .unwrap();
        assert_eq!(receipt["error"]["code"], "storageWriteNotApplied");
        assert_eq!(
            f.replace(&id, 0, json!({"new":"payload"})).unwrap(),
            receipt
        );
        assert!(f.migration.vault.read(&entry).unwrap().is_none());
        let completed_id = uuid::Uuid::new_v4().to_string();
        let completed = f
            .replace(&completed_id, 0, json!({"refreshToken":"other"}))
            .unwrap();
        std::fs::remove_file(
            f.migration
                .vault
                .path(completed["entryId"].as_str().unwrap()),
        )
        .unwrap();
        assert!(f.read().unwrap_err().to_string().contains("storageMissing"));
        assert!(
            f.replace(&completed_id, 0, json!({"refreshToken":"other"}))
                .unwrap_err()
                .to_string()
                .contains("storageMissing")
        );
    }

    #[test]
    fn source_gate_remote_owner_request_conflicts_and_lost_receipt() {
        let f = Fixture::new();
        let unknown = Slot::SubscriptionTransport {
            source_id: uuid::Uuid::new_v4().to_string(),
        };
        assert!(
            f.migration
                .vault
                .dispatch(
                    "vault.read",
                    json!({"slot":unknown}),
                    "generation",
                    &f.migration
                )
                .unwrap_err()
                .to_string()
                .contains("sourceNotFound")
        );
        assert!(
            f.migration
                .vault
                .dispatch(
                    "vault.read",
                    json!({"slot":Slot::RemoteIdentity}),
                    "generation",
                    &f.migration
                )
                .unwrap_err()
                .to_string()
                .contains("remoteStateRequired")
        );
        let id = uuid::Uuid::new_v4().to_string();
        let receipt = f.replace(&id, 0, json!({"refreshToken":"dummy"})).unwrap();
        std::fs::remove_file(f.migration.vault.operation_path(&id)).unwrap();
        assert_eq!(
            f.migration
                .vault
                .operation(&id, &f.migration)
                .unwrap()
                .unwrap(),
            receipt
        );
        let other_slot = Slot::SubscriptionTransport {
            source_id: f.slot.source_id().unwrap().to_owned(),
        };
        assert!(f.migration.vault.dispatch("vault.replace",json!({"requestId":id,"expectedGeneration":"generation","slot":other_slot,"expectedRevision":0,"value":{}}),"generation",&f.migration).unwrap_err().to_string().contains("requestConflict"));
        assert!(
            f.replace(&id, 1, json!({"refreshToken":"dummy"}))
                .unwrap_err()
                .to_string()
                .contains("requestConflict")
        );
    }
}
