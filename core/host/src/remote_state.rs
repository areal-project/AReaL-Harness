use crate::{
    migration::{self, Migration},
    wire::{self, error},
};
use anyhow::{Context, Result, ensure};
use areal_local_service::storage;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    source_id: String,
    revision: u64,
    entry_id: String,
    allowed_projects: Vec<String>,
    #[serde(default)]
    receipt: Option<Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Replace {
    request_id: String,
    expected_generation: String,
    expected_revision: u64,
    source_id: String,
    config: Value,
    #[serde(default)]
    control_digest: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Acquire {
    source_id: String,
}
type Seed = Option<(String, String, Vec<String>)>;
pub(crate) trait Credentials {
    fn vault(&self) -> &crate::vault::Vault;
    fn remote_seed(&self) -> Result<Seed>;
}
impl Credentials for Migration {
    fn vault(&self) -> &crate::vault::Vault {
        &self.vault
    }
    fn remote_seed(&self) -> Result<Seed> {
        Migration::remote_seed(self)
    }
}
impl Credentials for std::rc::Rc<Migration> {
    fn vault(&self) -> &crate::vault::Vault {
        &self.vault
    }
    fn remote_seed(&self) -> Result<Seed> {
        Migration::remote_seed(self)
    }
}
struct CredentialSnapshot {
    vault: crate::vault::Vault,
    seed: Seed,
}
impl Credentials for CredentialSnapshot {
    fn vault(&self) -> &crate::vault::Vault {
        &self.vault
    }
    fn remote_seed(&self) -> Result<Seed> {
        Ok(self.seed.clone())
    }
}
struct Projection {
    state: State,
    config: Value,
}
#[derive(Clone)]
pub(crate) struct RemoteState {
    home: PathBuf,
    lease: Arc<Mutex<Option<(String, String)>>>,
    projection: Arc<Mutex<Option<Projection>>>,
}
impl RemoteState {
    async fn run<T: Send + 'static>(
        &self,
        migration: &Migration,
        request_id: Option<String>,
        work: impl FnOnce(Self, CredentialSnapshot) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        // 只复制已提交的迁移种子；Migration 的源锁与租约仍由 Host 持有。
        let seed = migration.remote_seed()?;
        let remote = self.clone();
        migration
            .vault
            .run(
                json!({"slot":{"kind":"remoteIdentity"},"requestId":request_id}),
                move |vault| work(remote, CredentialSnapshot { vault, seed }),
            )
            .await
    }
    pub(crate) async fn dispatch_async(
        &self,
        method: &str,
        params: Value,
        connection: &str,
        generation: &str,
        migration: &Migration,
        projects: &[String],
    ) -> Result<Value> {
        let request = params["requestId"].as_str().map(str::to_owned);
        let method = method.to_owned();
        let connection = connection.to_owned();
        let generation = generation.to_owned();
        let projects = projects.to_vec();
        self.run(migration, request, move |remote, credentials| {
            remote.dispatch(
                &method,
                params,
                &connection,
                &generation,
                &credentials,
                &projects,
            )
        })
        .await
    }
    pub(crate) async fn snapshot_async(&self, migration: &Migration) -> Result<Value> {
        if let Ok(snapshot) = self.snapshot(migration) {
            return Ok(snapshot);
        }
        self.dispatch_async(
            "remote.read",
            json!({}),
            "native-gateway",
            "",
            migration,
            &[],
        )
        .await
    }
    pub(crate) async fn handoff_async(
        &self,
        params: Value,
        identity: &crate::HostIdentity,
        migration: &Migration,
    ) -> Result<Value> {
        let request = params["requestId"].as_str().map(str::to_owned);
        let identity = identity.clone();
        self.run(migration, request, move |remote, credentials| {
            remote.handoff(params, &identity, &credentials)
        })
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
            || migration
                .vault
                .slot_in_flight(&crate::vault::Slot::RemoteIdentity)
        {
            return Ok(Some(receipt));
        }
        let id = id.to_owned();
        self.run(migration, None, move |remote, credentials| {
            remote.operation(&id, &credentials)
        })
        .await
    }
    pub(crate) fn operation_offline(home: &Path, id: &str) -> Result<Option<Value>> {
        wire::request_id(id)?;
        let remote = Self::new(home);
        if let Some(receipt) = remote.native_owner()?
            && receipt["requestId"] == id
        {
            return Ok(Some(receipt));
        }
        if let Some(state) = migration::read_optional::<State>(&remote.path())?
            && let Some(receipt) = state.receipt.filter(|value| value["requestId"] == id)
        {
            return Ok(Some(receipt));
        }
        migration::read_optional(
            &home
                .join("host/remote-operations")
                .join(format!("{id}.json")),
        )
    }
    pub fn selected_source(home: &Path) -> Result<Option<String>> {
        if let Some(state) =
            migration::read_optional::<State>(&home.join("host/remote-state.json"))?
        {
            return Ok(Some(state.source_id));
        }
        for path in storage::json_records(&home.join("host/remote-operations"), false)? {
            let receipt: Value = storage::read(&path)?;
            if receipt["state"] == "acceptedPending" {
                return Ok(Some(
                    receipt["sourceId"]
                        .as_str()
                        .context("missing pending Remote source")?
                        .to_owned(),
                ));
            }
        }
        Ok(None)
    }
    pub fn new(home: &Path) -> Self {
        Self {
            home: home.into(),
            lease: Arc::new(Mutex::new(None)),
            projection: Arc::new(Mutex::new(None)),
        }
    }
    fn path(&self) -> PathBuf {
        self.home.join("host/remote-state.json")
    }
    fn state(&self, migration: &impl Credentials) -> Result<Option<State>> {
        if let Some(state) = migration::read_optional(&self.path())? {
            return Ok(Some(state));
        }
        let Some((source_id, entry_id, allowed_projects)) = migration.remote_seed()? else {
            return Ok(None);
        };
        let state = State {
            source_id,
            revision: 1,
            entry_id,
            allowed_projects,
            receipt: None,
        };
        storage::write(&self.path(), &state)?;
        Ok(Some(state))
    }
    pub(crate) fn save_control_receipt(
        &self,
        id: &str,
        source_id: &str,
        identity: &crate::HostIdentity,
        digest: &str,
    ) -> Result<()> {
        wire::request_id(id)?;
        self.save_receipt(&json!({"requestId":id,"method":"remote.gateway.control","sourceId":source_id,"hostId":identity.host_id,"generation":identity.generation,"controlDigest":digest,"state":"completed","ephemeral":true}))
    }
    fn project(&self, state: &State, config: Value) -> Result<Value> {
        Ok(
            json!({"revision":state.revision,"sourceId":state.source_id,"config":config,"owner":if self.native_owner()?.is_some(){"native"}else{"legacy"}}),
        )
    }
    fn same_state(left: &State, right: &State) -> bool {
        left.source_id == right.source_id
            && left.revision == right.revision
            && left.entry_id == right.entry_id
    }
    fn publish_read(&self, state: &State, config: Value) -> Result<Value> {
        let mut projection = self.projection.lock().unwrap();
        let durable = migration::read_optional::<State>(&self.path())?;
        ensure!(
            durable
                .as_ref()
                .is_some_and(|current| Self::same_state(current, state)),
            error(
                "revisionConflict",
                "Remote state changed while loading credentials"
            )
        );
        let value = self.project(state, config.clone())?;
        *projection = Some(Projection {
            state: state.clone(),
            config,
        });
        Ok(value)
    }
    fn commit_state(&self, state: &State, config: Value) -> Result<()> {
        // Keychain I/O 已完成；短临界区让撤销持久化和同步授权投影同时对读者生效。
        let mut projection = self.projection.lock().unwrap();
        storage::write(&self.path(), state)?;
        *projection = Some(Projection {
            state: state.clone(),
            config,
        });
        Ok(())
    }
    pub(crate) fn snapshot(&self, _migration: &impl Credentials) -> Result<Value> {
        let projection = self.projection.lock().unwrap();
        let loaded = projection.as_ref().ok_or_else(|| {
            error(
                "remoteStateUnavailable",
                "Remote configuration has not been loaded",
            )
        })?;
        let durable = migration::read_optional::<State>(&self.path())?;
        ensure!(
            durable
                .as_ref()
                .is_some_and(|current| Self::same_state(current, &loaded.state)),
            error(
                "remoteStateUnavailable",
                "Remote configuration changed outside its owner"
            )
        );
        self.project(&loaded.state, loaded.config.clone())
    }
    pub(crate) fn native_owner(&self) -> Result<Option<Value>> {
        migration::read_optional(&self.home.join("host/remote-gateway.json"))
    }
    pub(crate) fn handoff(
        &self,
        params: Value,
        identity: &crate::HostIdentity,
        migration: &impl Credentials,
    ) -> Result<Value> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Handoff {
            request_id: String,
            expected_generation: String,
            source_id: String,
            expected_revision: u64,
            #[serde(default)]
            asset_root: Option<PathBuf>,
        }
        let input: Handoff = serde_json::from_value(params)?;
        wire::request_id(&input.request_id)?;
        ensure!(
            input.expected_generation == identity.generation,
            error("generationMismatch", "Host generation changed")
        );
        if let Some(receipt) = self.native_owner()? {
            ensure!(
                receipt["requestId"] == input.request_id
                    && receipt["sourceId"] == input.source_id
                    && receipt["revision"] == input.expected_revision,
                error(
                    "requestConflict",
                    "Gateway ownership is already transferred"
                )
            );
            return Ok(receipt);
        }
        self.recover(migration)?;
        let state = self
            .state(migration)?
            .context("Remote configuration is missing")?;
        ensure!(
            state.source_id == input.source_id && state.revision == input.expected_revision,
            error("revisionConflict", "Remote source or revision changed")
        );
        ensure!(
            self.lease.lock().unwrap().is_none(),
            error("remoteBusy", "Legacy Gateway has not drained")
        );
        let config = migration
            .vault()
            .read(&state.entry_id)?
            .context("Remote configuration is missing")?;
        crate::gateway::wire::Identity::from_base64(
            config["identity"]
                .as_str()
                .context("Remote identity is missing")?,
        )?;
        let asset_root = input
            .asset_root
            .map(|root| root.canonicalize())
            .transpose()?;
        if let Some(root) = &asset_root {
            ensure!(
                root.is_dir() && root.join("remote-assets.json").is_file(),
                error("invalidRequest", "Remote assets are missing")
            );
        }
        let mut receipt = json!({"requestId":input.request_id,"method":"remote.gateway.handoff","sourceId":input.source_id,"revision":state.revision,"state":"completed","owner":"native","hostId":identity.host_id,"generation":identity.generation});
        if let Some(root) = asset_root {
            receipt["assetRoot"] = json!(root);
        }
        storage::write(&self.home.join("host/remote-gateway.json"), &receipt)?;
        self.publish_read(&state, config)?;
        Ok(receipt)
    }
    pub fn dispatch(
        &self,
        method: &str,
        params: Value,
        connection: &str,
        generation: &str,
        migration: &impl Credentials,
        projects: &[String],
    ) -> Result<Value> {
        self.dispatch_inner(
            method,
            params,
            (connection, generation),
            migration,
            projects,
            false,
        )
    }
    pub(crate) fn begin_enrollment(
        &self,
        id: &str,
        source: &str,
        identity: &crate::HostIdentity,
        digest: &str,
        revision: u64,
    ) -> Result<()> {
        wire::request_id(id)?;
        self.save_receipt(&json!({"requestId":id,"method":"remote.gateway.control","ephemeral":true,"sourceId":source,"hostId":identity.host_id,"generation":identity.generation,"previousRevision":revision,"controlDigest":digest,"state":"outcomeUnknown"}))
    }
    pub(crate) fn reject_enrollment(&self, id: &str) -> Result<()> {
        wire::request_id(id)?;
        let mut receipt: Value = storage::read(
            &self
                .home
                .join("host/remote-operations")
                .join(format!("{id}.json")),
        )?;
        ensure!(
            receipt["method"] == "remote.gateway.control" && receipt["state"] == "outcomeUnknown",
            "invalid enrollment intent"
        );
        receipt["state"] = json!("blocked");
        receipt["error"] =
            json!({"code":"enrollment-failed","message":"Relay rejected enrollment"});
        self.save_receipt(&receipt)
    }
    pub(crate) fn commit_enrollment(
        &self,
        params: Value,
        generation: &str,
        migration: &impl Credentials,
        projects: &[String],
    ) -> Result<Value> {
        self.dispatch_inner(
            "remote.gateway.replace",
            params,
            ("native-gateway-control", generation),
            migration,
            projects,
            true,
        )
    }
    fn dispatch_inner(
        &self,
        method: &str,
        params: Value,
        (connection, generation): (&str, &str),
        migration: &impl Credentials,
        projects: &[String],
        enrollment: bool,
    ) -> Result<Value> {
        let native = self.native_owner()?.is_some();
        if method == "remote.gateway.replace" && !native {
            return Err(error(
                "nativeGatewayRequired",
                "Gateway handoff is required",
            ));
        }
        if method != "remote.read" && method != "remote.gateway.replace" && native {
            return Err(error(
                "nativeGatewayOwned",
                "Remote Gateway is owned by the Host",
            ));
        }
        self.recover(migration)?;
        let state = self.state(migration)?;
        let method = if method == "remote.gateway.replace" {
            "remote.replace"
        } else {
            method
        };
        match method {
            "remote.read" => {
                ensure!(params == json!({}), "invalid remote.read parameters");
                let Some(state) = state else {
                    return Ok(json!({"revision":0,"sourceId":null,"config":null}));
                };
                let current = migration
                    .vault()
                    .read(&state.entry_id)?
                    .context("missing Remote vault entry")?;
                self.publish_read(&state, current)
            }
            "remote.acquire" => {
                let input: Acquire = serde_json::from_value(params)?;
                if state
                    .as_ref()
                    .is_some_and(|state| input.source_id != state.source_id)
                {
                    return Err(error("migrationConflict", "Remote source does not match"));
                }
                if self
                    .lease
                    .lock()
                    .unwrap()
                    .as_ref()
                    .is_some_and(|(owner, _)| owner != connection)
                {
                    return Err(error(
                        "remoteBusy",
                        "Remote execution lease is already held",
                    ));
                }
                let lease_id = self
                    .lease
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|(_, id)| id.clone())
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                *self.lease.lock().unwrap() = Some((connection.into(), lease_id.clone()));
                Ok(json!({"leaseId":lease_id,"sourceId":input.source_id}))
            }
            "remote.replace" => {
                let input: Replace = serde_json::from_value(params)?;
                wire::request_id(&input.request_id)?;
                if input.expected_generation != generation {
                    return Err(error("generationMismatch", "Host generation changed"));
                }
                if let Some(previous) = self.operation(&input.request_id, migration)? {
                    if enrollment {
                        ensure!(
                            previous["method"] == "remote.gateway.control"
                                && previous["state"] == "outcomeUnknown"
                                && previous["ephemeral"] == true
                                && previous["generation"] == generation
                                && previous["sourceId"] == input.source_id
                                && previous["previousRevision"] == input.expected_revision
                                && previous["controlDigest"].as_str()
                                    == input.control_digest.as_deref(),
                            error("requestConflict", "original enrollment intent differs")
                        );
                    } else {
                        ensure!(
                            previous["method"] == "remote.replace",
                            error("requestConflict", "Remote operation method differs")
                        );
                        ensure!(
                            previous.get("controlDigest").and_then(Value::as_str)
                                == input.control_digest.as_deref(),
                            error("requestConflict", "Remote operation control differs")
                        );
                        if previous["state"] != "completed" {
                            if previous["sourceId"] != input.source_id
                                || previous["previousRevision"] != input.expected_revision
                            {
                                return Err(error(
                                    "requestConflict",
                                    "Remote operation parameters differ",
                                ));
                            }
                            return Ok(previous);
                        }
                        if previous["sourceId"] != input.source_id
                            || previous["previousRevision"] != input.expected_revision
                            || migration
                                .vault()
                                .read(
                                    previous["entryId"]
                                        .as_str()
                                        .context("missing operation entry")?,
                                )?
                                .as_ref()
                                != Some(&input.config)
                        {
                            return Err(error(
                                "requestConflict",
                                "Remote operation parameters differ",
                            ));
                        }
                        return Ok(previous);
                    }
                } else {
                    ensure!(
                        !enrollment,
                        error("requestConflict", "original enrollment intent is missing")
                    );
                }
                let mut state = state.unwrap_or_else(|| State {
                    source_id: input.source_id.clone(),
                    revision: 0,
                    entry_id: String::new(),
                    allowed_projects: Vec::new(),
                    receipt: None,
                });
                if state.source_id != input.source_id {
                    return Err(error("migrationConflict", "Remote source does not match"));
                }
                if state.revision != input.expected_revision {
                    return Err(error("revisionConflict", "Remote revision changed"));
                }
                if state.revision != 0 {
                    let current = migration
                        .vault()
                        .read(&state.entry_id)?
                        .context("missing Remote vault entry")?;
                    if current.get("identity").is_some()
                        && current["identity"] != input.config["identity"]
                    {
                        return Err(error(
                            "migrationConflict",
                            "Remote Noise identity is immutable",
                        ));
                    }
                }
                validate(&input.config, projects)
                    .map_err(|reason| error("invalidRequest", reason.to_string()))?;
                state.allowed_projects = projects.to_vec();
                if let Some(receipt) = &state.receipt {
                    self.save_receipt(receipt)?;
                }
                for path in storage::json_records(&self.home.join("host/remote-operations"), false)?
                {
                    let receipt: Value = storage::read(&path)?;
                    if receipt["state"] == "acceptedPending" {
                        return Err(error(
                            "operationPending",
                            "an earlier Remote replacement has not settled",
                        ));
                    }
                }
                let entry_id = uuid::Uuid::new_v4().to_string();
                let mut pending = json!({"requestId":input.request_id,"method":"remote.replace","sourceId":state.source_id,"previousRevision":input.expected_revision,"entryId":entry_id,"allowedProjects":state.allowed_projects,"state":"acceptedPending"});
                if let Some(digest) = &input.control_digest {
                    pending["controlDigest"] = json!(digest);
                }
                self.save_receipt(&pending)?;
                migration.vault().write(&entry_id, &input.config)?;
                state.revision += 1;
                state.entry_id = entry_id.clone();
                let mut receipt = json!({"requestId":input.request_id,"method":"remote.replace","sourceId":state.source_id,"previousRevision":input.expected_revision,"revision":state.revision,"entryId":entry_id,"state":"completed"});
                if let Some(digest) = input.control_digest {
                    receipt["controlDigest"] = json!(digest);
                }
                state.receipt = Some(receipt.clone());
                self.commit_state(&state, input.config)?;
                self.save_receipt(&receipt)?;
                Ok(receipt)
            }
            _ => Err(error("methodNotFound", "unknown Remote state method")),
        }
    }
    fn save_receipt(&self, receipt: &Value) -> Result<()> {
        storage::private_dir(&self.home.join("host/remote-operations"))?;
        std::fs::File::open(self.home.join("host"))?.sync_all()?;
        storage::write(
            &self.home.join("host/remote-operations").join(format!(
                "{}.json",
                receipt["requestId"]
                    .as_str()
                    .context("missing Remote requestId")?
            )),
            receipt,
        )
    }
    fn recover(&self, migration: &impl Credentials) -> Result<()> {
        migration.vault().idle()?;
        let mut state = self.state(migration)?;
        if let Some(receipt) = state.as_ref().and_then(|state| state.receipt.as_ref()) {
            self.save_receipt(receipt)?;
        }
        for path in storage::json_records(&self.home.join("host/remote-operations"), true)? {
            let mut receipt: Value = storage::read(&path)?;
            if receipt["state"] != "acceptedPending" {
                continue;
            }
            let entry_id = receipt["entryId"]
                .as_str()
                .context("missing pending Remote entry")?
                .to_owned();
            let value = migration.vault().read(&entry_id)?;
            let mut next = state
                .as_ref()
                .map(|state| State {
                    source_id: state.source_id.clone(),
                    revision: state.revision,
                    entry_id: state.entry_id.clone(),
                    allowed_projects: state.allowed_projects.clone(),
                    receipt: None,
                })
                .unwrap_or_else(|| State {
                    source_id: receipt["sourceId"].as_str().unwrap_or_default().into(),
                    revision: 0,
                    entry_id: String::new(),
                    allowed_projects: Vec::new(),
                    receipt: None,
                });
            let failure = if receipt["sourceId"] != next.source_id
                || receipt["previousRevision"] != next.revision
            {
                Some((
                    "revisionConflict",
                    "Remote revision changed before recovery",
                ))
            } else if value.is_none() {
                Some((
                    "storageWriteNotApplied",
                    "Remote vault entry was not written",
                ))
            } else {
                None
            };
            if let Some((code, message)) = failure {
                receipt["state"] = json!("blocked");
                receipt["error"] = json!({"code":code,"message":message});
                self.save_receipt(&receipt)?;
                continue;
            }
            let value = value.context("missing pending Remote value")?;
            if let Some(projects) = receipt.get("allowedProjects") {
                next.allowed_projects = serde_json::from_value(projects.clone())?;
            }
            validate(&value, &next.allowed_projects)?;
            if next.revision != 0 {
                let current = migration
                    .vault()
                    .read(&next.entry_id)?
                    .context("missing Remote vault entry")?;
                ensure!(
                    current.get("identity").is_none() || current["identity"] == value["identity"],
                    "pending Remote identity differs"
                );
            }
            next.revision += 1;
            next.entry_id = entry_id;
            receipt["state"] = json!("completed");
            receipt["revision"] = json!(next.revision);
            next.receipt = Some(receipt.clone());
            self.commit_state(&next, value)?;
            self.save_receipt(&receipt)?;
            state = Some(next);
        }
        Ok(())
    }
    pub fn operation(&self, id: &str, migration: &impl Credentials) -> Result<Option<Value>> {
        wire::request_id(id)?;
        if migration
            .vault()
            .recovery_blocked(&crate::vault::Slot::RemoteIdentity)
        {
            return Self::operation_offline(&self.home, id);
        }
        if let Some(receipt) = self.native_owner()?
            && receipt["requestId"] == id
        {
            return Ok(Some(receipt));
        }
        self.recover(migration)?;
        if let Some(state) = migration::read_optional::<State>(&self.path())?
            && let Some(receipt) = state.receipt
            && receipt["requestId"] == id
        {
            self.save_receipt(&receipt)?;
            return Ok(Some(receipt));
        }
        migration::read_optional(
            &self
                .home
                .join("host/remote-operations")
                .join(format!("{id}.json")),
        )
    }
    pub fn disconnect(&self, connection: &str) {
        if self
            .lease
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|(owner, _)| owner == connection)
        {
            *self.lease.lock().unwrap() = None;
        }
    }
}
pub(crate) fn validate(config: &Value, projects: &[String]) -> Result<()> {
    ensure!(config.is_object(), "Remote configuration must be an object");
    if let Some(identity) = config.get("identity") {
        ensure!(
            identity.as_str().is_some_and(|id| !id.is_empty()),
            "invalid Remote identity"
        );
    }
    for (list, key) in [("deviceGrants", "projectIds"), ("devices", "projects")] {
        if let Some(grants) = config.get(list) {
            for grant in grants.as_array().context("invalid Remote grants")? {
                if let Some(scope) = grant.get(key) {
                    for project in scope.as_array().context("invalid Remote scope")? {
                        let project = project.as_str().context("invalid Remote project alias")?;
                        if !projects.iter().any(|id| id == project) {
                            return Err(error(
                                "migrationConflict",
                                "Remote grant references an unknown source project",
                            ));
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn committed_projection_requires_cold_load_and_rejects_unpublished_state() {
        let root = tempfile::tempdir().unwrap();
        let mut migration = Migration::new(root.path()).unwrap();
        migration.vault = crate::vault::Vault::isolated_files(root.path());
        let remote = RemoteState::new(root.path());
        let config = json!({"identity":"synthetic","deviceGrants":[{"devicePeerId":"a","status":"active","revision":1}]});
        remote.dispatch_async("remote.replace", json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":"generation","sourceId":"source","expectedRevision":0,"config":config}), "fixture", "generation", &migration, &[]).await.unwrap();
        let restored = RemoteState::new(root.path());
        assert!(
            restored.snapshot(&migration).is_err(),
            "cold state must not authorize before credential recovery"
        );
        migration.vault.locked.set(true);
        assert!(restored.snapshot_async(&migration).await.is_err());
        assert!(restored.snapshot(&migration).is_err());
        // 已提交且已加载的授权不因另一个凭据调用的锁状态被撤销。
        assert_eq!(remote.snapshot(&migration).unwrap()["config"], config);
        migration.vault.locked.set(false);
        assert_eq!(
            restored.snapshot_async(&migration).await.unwrap()["config"],
            config
        );
        let original: State = storage::read(&remote.path()).unwrap();
        let mut changed = original.clone();
        changed.revision += 1;
        let backup = root.path().join("original-state.json");
        std::fs::rename(remote.path(), &backup).unwrap();
        std::fs::create_dir(remote.path()).unwrap();
        assert!(
            remote
                .commit_state(&changed, json!({"identity":"unpublished"}))
                .is_err()
        );
        assert!(remote.snapshot(&migration).is_err());
        std::fs::remove_dir(remote.path()).unwrap();
        std::fs::rename(backup, remote.path()).unwrap();
        assert_eq!(
            remote.snapshot(&migration).unwrap()["config"],
            config,
            "failed persistence published new grants"
        );
        storage::write(&remote.path(), &changed).unwrap();
        assert!(
            remote.snapshot(&migration).is_err(),
            "mismatched durable revision must fail closed"
        );
    }

    #[test]
    fn fresh_configuration_requires_one_executor_and_preserves_identity() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path();
        let mut migration = Migration::new(home).unwrap();
        let remote = RemoteState::new(home);
        let read = remote
            .dispatch(
                "remote.read",
                json!({}),
                "one",
                "generation",
                &migration,
                &[],
            )
            .unwrap();
        assert_eq!(read, json!({"revision":0,"sourceId":null,"config":null}));
        assert!(!remote.path().exists());
        migration.vault = crate::vault::Vault::isolated_files(home);
        let params = json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":"generation","expectedRevision":0,"sourceId":"source","config":{"identity":"fixture-noise","devices":[]}});
        remote
            .dispatch(
                "remote.acquire",
                json!({"sourceId":"source"}),
                "one",
                "generation",
                &migration,
                &[],
            )
            .unwrap();
        assert!(
            remote
                .dispatch(
                    "remote.acquire",
                    json!({"sourceId":"source"}),
                    "two",
                    "generation",
                    &migration,
                    &[]
                )
                .unwrap_err()
                .to_string()
                .contains("remoteBusy")
        );
        let receipt = remote
            .dispatch(
                "remote.replace",
                params,
                "configuration-client",
                "generation",
                &migration,
                &[],
            )
            .unwrap();
        assert_eq!(receipt["revision"], 1);
        remote.disconnect("one");
        assert!(
            remote
                .dispatch(
                    "remote.acquire",
                    json!({"sourceId":"other-source"}),
                    "two",
                    "generation",
                    &migration,
                    &[]
                )
                .unwrap_err()
                .to_string()
                .contains("migrationConflict")
        );
        remote
            .dispatch(
                "remote.acquire",
                json!({"sourceId":"source"}),
                "two",
                "generation",
                &migration,
                &[],
            )
            .unwrap();
        let change = json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":"generation","expectedRevision":1,"sourceId":"source","config":{"identity":"different-noise","devices":[]}});
        assert!(
            remote
                .dispatch(
                    "remote.replace",
                    change,
                    "two",
                    "generation",
                    &migration,
                    &[]
                )
                .unwrap_err()
                .to_string()
                .contains("immutable")
        );
    }

    #[test]
    fn interrupted_first_configuration_recovers_only_original_entry() {
        for after_vault in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let home = root.path();
            let mut migration = Migration::new(home).unwrap();
            migration.vault = crate::vault::Vault::isolated_files(home);
            let remote = RemoteState::new(home);
            let request_id = uuid::Uuid::new_v4().to_string();
            let entry_id = uuid::Uuid::new_v4().to_string();
            let config = json!({"identity":"original-noise","deviceGrants":[{"projectIds":["new-gui","cli-stable"]}]});
            remote.save_receipt(&json!({"requestId":request_id,"method":"remote.replace","sourceId":"source","previousRevision":0,"entryId":entry_id,"allowedProjects":["new-gui","cli-stable"],"state":"acceptedPending"})).unwrap();
            assert_eq!(
                RemoteState::selected_source(home).unwrap(),
                Some("source".into())
            );
            if after_vault {
                migration.vault().write(&entry_id, &config).unwrap();
            }
            let restarted = RemoteState::new(home);
            let receipt = restarted
                .operation(&request_id, &migration)
                .unwrap()
                .unwrap();
            assert_eq!(
                receipt["state"],
                if after_vault { "completed" } else { "blocked" }
            );
            let read = restarted
                .dispatch(
                    "remote.read",
                    json!({}),
                    "one",
                    "new-generation",
                    &migration,
                    &[],
                )
                .unwrap();
            assert_eq!(read["revision"], u64::from(after_vault));
            assert_eq!(
                read["config"],
                if after_vault { config } else { Value::Null }
            );
            assert_eq!(
                restarted
                    .operation(&request_id, &migration)
                    .unwrap()
                    .unwrap(),
                receipt
            );
        }
    }

    #[test]
    fn interrupted_replace_settles_original_id_without_replaying_vault_write() {
        for window in ["beforeVault", "afterVault", "afterState", "afterLogout"] {
            let root = tempfile::tempdir().unwrap();
            let home = root.path();
            storage::private_dir(&home.join("host")).unwrap();
            let mut migration = Migration::new(home).unwrap();
            migration.vault = crate::vault::Vault::isolated_files(home);
            let remote = RemoteState::new(home);
            let original_entry = uuid::Uuid::new_v4().to_string();
            migration
                .vault()
                .write(
                    &original_entry,
                    &json!({"identity":"dummy-noise", "deviceGrants":[]}),
                )
                .unwrap();
            let request = uuid::Uuid::new_v4().to_string();
            let pending_entry = uuid::Uuid::new_v4().to_string();
            let proposed = json!({"identity":"dummy-noise", "relayEnabled":true,"deviceGrants":[{"projectIds":["project"]}]});
            let mut state = State {
                source_id: "source".into(),
                revision: 1,
                entry_id: original_entry,
                allowed_projects: vec!["project".into()],
                receipt: None,
            };
            let pending = json!({"requestId":request,"method":"remote.replace","sourceId":"source","previousRevision":1,"entryId":pending_entry,"state":"acceptedPending"});
            remote.save_receipt(&pending).unwrap();
            if window != "beforeVault" {
                migration.vault().write(&pending_entry, &proposed).unwrap();
            }
            if window == "afterState" {
                let mut completed = pending.clone();
                completed["state"] = json!("completed");
                completed["revision"] = json!(2);
                state.revision = 2;
                state.entry_id = pending_entry.clone();
                state.receipt = Some(completed);
            }
            if window == "afterLogout" {
                state.revision = 3;
                state.entry_id = uuid::Uuid::new_v4().to_string();
                migration
                    .vault()
                    .write(
                        &state.entry_id,
                        &json!({"identity":"dummy-noise","deviceGrants":[]}),
                    )
                    .unwrap();
            }
            storage::write(&remote.path(), &state).unwrap();
            let offline = crate::operation_offline(home, &request).unwrap().unwrap();
            assert_eq!(
                offline["state"],
                if window == "afterState" {
                    "completed"
                } else {
                    "acceptedPending"
                },
                "offline lookup uses metadata only at {window}"
            );
            let stored: Value = storage::read(
                &home
                    .join("host/remote-operations")
                    .join(format!("{request}.json")),
            )
            .unwrap();
            assert_eq!(stored, pending);
            let restarted = RemoteState::new(home);
            let receipt = restarted.operation(&request, &migration).unwrap().unwrap();
            let applied = matches!(window, "afterVault" | "afterState");
            assert_eq!(
                receipt["state"],
                if applied { "completed" } else { "blocked" },
                "{window}"
            );
            let read = restarted
                .dispatch(
                    "remote.read",
                    json!({}),
                    "connection",
                    "generation",
                    &migration,
                    &["project".into()],
                )
                .unwrap();
            assert_eq!(read["revision"], if applied { 2 } else { state.revision });
            assert_eq!(
                read["config"]["deviceGrants"].as_array().unwrap().len(),
                usize::from(applied)
            );
            assert_eq!(
                migration.vault().read(&pending_entry).unwrap().is_some(),
                window != "beforeVault"
            );
            let replay = restarted.dispatch("remote.replace",json!({"requestId":request,"expectedGeneration":"generation","expectedRevision":1,"sourceId":"source","config":proposed}),"connection","generation",&migration, &["project".into()]).unwrap();
            assert_eq!(replay, receipt);
            restarted
                .dispatch(
                    "remote.acquire",
                    json!({"sourceId":"source"}),
                    "connection",
                    "generation",
                    &migration,
                    &["project".into()],
                )
                .unwrap();
            let next = restarted.dispatch("remote.replace",json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":"generation","expectedRevision":read["revision"],"sourceId":"source","config":{"identity":"dummy-noise","deviceGrants":[]}}),"connection","generation",&migration, &["project".into()]).unwrap();
            assert_eq!(
                next["state"], "completed",
                "settled failure must not permanently block new commands"
            );
        }
    }
}
