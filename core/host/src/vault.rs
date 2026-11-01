use crate::{
    migration::Migration,
    wire::{self, error},
};
use anyhow::{Result, ensure};
use areal_local_service::storage;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

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

pub(crate) struct Vault {
    home: PathBuf,
    #[cfg(test)]
    isolated_files: bool,
    #[cfg(test)]
    locked: std::cell::Cell<bool>,
}
impl Vault {
    fn state_path(&self, slot: &Slot) -> Result<PathBuf> {
        Ok(self.home.join("host/vault-slots").join(format!(
            "{}.json",
            storage::digest(&serde_json::to_vec(slot)?)
        )))
    }
    fn state(&self, slot: &Slot, migration: &Migration) -> Result<SlotState> {
        let seed = migration.vault_seed(slot)?;
        if let Some(state) = crate::migration::read_optional::<SlotState>(&self.state_path(slot)?)?
        {
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
        if let Some(receipt) = &state.receipt {
            self.save_operation(receipt)?;
        }
        let directory = self.home.join("host/vault-operations");
        if !directory.is_dir() {
            return Ok(());
        }
        for entry in std::fs::read_dir(directory)? {
            let mut receipt: Value = storage::read(&entry?.path())?;
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
        let receipt = crate::migration::read_optional::<Value>(&self.operation_path(id))?;
        if receipt.is_none() {
            let directory = self.home.join("host/vault-slots");
            if directory.is_dir() {
                for entry in std::fs::read_dir(directory)? {
                    let state: SlotState = storage::read(&entry?.path())?;
                    if let Some(receipt) =
                        state.receipt.filter(|receipt| receipt["requestId"] == id)
                    {
                        self.save_operation(&receipt)?;
                        return Ok(Some(receipt));
                    }
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
        crate::migration::read_optional(&self.operation_path(id))
    }
    pub fn dispatch(
        &self,
        method: &str,
        params: Value,
        generation: &str,
        migration: &Migration,
    ) -> Result<Value> {
        if method == "vault.read" {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Read {
                slot: Slot,
            }
            let input: Read = serde_json::from_value(params)?;
            let mut state = self.state(&input.slot, migration)?;
            self.recover(&mut state)?;
            let value = match state.entry_id {
                Some(id) => self
                    .read(&id)?
                    .ok_or_else(|| error("storageMissing", "current vault entry is missing"))?,
                None => Value::Null,
            };
            return Ok(json!({"revision":state.revision,"value":value}));
        }
        if method != "vault.replace" {
            return Err(error("methodNotFound", "unknown vault method"));
        }
        let input: Replace = serde_json::from_value(params)?;
        wire::request_id(&input.request_id)?;
        if input.expected_generation != generation {
            return Err(error("generationMismatch", "Host generation changed"));
        }
        let mut state = self.state(&input.slot, migration)?;
        self.recover(&mut state)?;
        if let Some(previous) = self.operation(&input.request_id, migration)? {
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
    pub fn new(home: &Path) -> Self {
        Self {
            home: home.to_owned(),
            #[cfg(test)]
            isolated_files: false,
            #[cfg(test)]
            locked: std::cell::Cell::new(false),
        }
    }
    #[cfg(test)]
    pub fn isolated_files(home: &Path) -> Self {
        Self {
            home: home.to_owned(),
            isolated_files: true,
            locked: std::cell::Cell::new(false),
        }
    }
    pub fn write(&self, entry: &str, value: &Value) -> Result<()> {
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
        let bytes = serde_json::to_vec(value)?;
        #[cfg(test)]
        if self.isolated_files {
            return self.write_file(entry, value);
        }
        #[cfg(target_os = "macos")]
        security_framework::passwords::set_generic_password(&self.service(), entry, &bytes)
            .map_err(|_| error("storageLocked", "Host Keychain write failed"))?;
        #[cfg(not(target_os = "macos"))]
        {
            let _ = bytes;
            self.write_file(entry, value)?;
        }
        ensure!(
            self.read(entry)?.as_ref() == Some(value),
            "vault read-back verification failed"
        );
        Ok(())
    }
    pub fn read(&self, entry: &str) -> Result<Option<Value>> {
        crate::wire::request_id(entry)?;
        #[cfg(test)]
        if self.locked.get() {
            return Err(error("storageLocked", "isolated vault is locked"));
        }
        #[cfg(test)]
        if self.isolated_files {
            return crate::migration::read_optional(&self.path(entry));
        }
        #[cfg(target_os = "macos")]
        {
            match security_framework::passwords::get_generic_password(&self.service(), entry) {
                Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
                Err(e) if e.code() == -25300 => Ok(None),
                Err(_) => Err(error("storageLocked", "Host Keychain read failed")),
            }
        }
        #[cfg(not(target_os = "macos"))]
        crate::migration::read_optional(&self.path(entry))
    }
    #[cfg(target_os = "macos")]
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
            crate::migration::read_optional::<Value>(&self.path(entry))?.as_ref() == Some(value),
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
