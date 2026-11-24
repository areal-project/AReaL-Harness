use crate::{
    migration::Migration,
    wire::{self, error},
};
use anyhow::{Context, Result, ensure};
use areal_local_service::storage;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    fs::OpenOptions,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

const SECRETS_FORMAT_VERSION: u64 = 2;
/// 覆盖 1 MiB Host 帧与 4096 条 pushCommands 封装开销的对称读取上限。
const MAX_REMOTE_SETTINGS_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    source_id: String,
    revision: u64,
    entry_id: String,
    /// 记录 entry_id 指向密文的实际格式：None 为旧版完整配置密文，Some(2) 为纯凭据 SecretsEnvelope v2。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    secrets_format: Option<u64>,
    /// 非敏感手机连接配置（开关、本机地址、Relay 列表、设备授权元数据、网络配置等）。
    /// 拆离后，纯非敏感变更仅原子写 host/remote-state.json，不再触发 credential-io / Keychain。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    settings: Option<Value>,
    allowed_projects: Vec<String>,
    #[serde(default)]
    receipt: Option<Value>,
}

/// 仅存放真正敏感的手机连接凭据，加密落盘在 host/vault-sealed/<entryId>.bin。
/// 任何敏感字段都绝不回落到明文 settings；缺少稳定键或出现重复键的条目按位置索引留在加密侧。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteSecrets {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    identity: Option<Value>,
    /// 仅当顶层 capability 无法由唯一 room 对应值推导（或为非字符串）时保留。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    capability: Option<Value>,
    #[serde(default, skip_serializing_if = "is_false")]
    top_capability_from_room: bool,
    /// 唯一 room（稳定 64-hex 标识）索引的 Relay capability；切换网卡/LAN IP 或 relayUse 切档时不变。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    relay_capabilities: BTreeMap<String, String>,
    /// 兜底：缺失/重复 room 或非字符串 capability 的 profile 按数组下标原位保存在加密侧。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    relay_profile_capabilities: BTreeMap<usize, Value>,
    /// 唯一 devicePeerId 索引的设备推送凭据（如 APNs token）。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    device_push: BTreeMap<String, Value>,
    /// 兜底：缺失或重复 devicePeerId 的 grant 按数组下标原位保存在加密侧，避免串用或泄漏明文。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    device_push_by_index: BTreeMap<usize, Value>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretsEnvelope {
    format_version: u64,
    #[serde(flatten)]
    secrets: RemoteSecrets,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl RemoteSecrets {
    fn is_empty(&self) -> bool {
        self.identity.is_none()
            && self.capability.is_none()
            && !self.top_capability_from_room
            && self.relay_capabilities.is_empty()
            && self.relay_profile_capabilities.is_empty()
            && self.device_push.is_empty()
            && self.device_push_by_index.is_empty()
    }

    fn to_vault_value(&self) -> Value {
        serde_json::to_value(SecretsEnvelope {
            format_version: SECRETS_FORMAT_VERSION,
            secrets: self.clone(),
        })
        .expect("serializable remote secrets envelope")
    }

    /// 严格按状态元数据声明的格式解析密文，不凭密文内字段猜测格式。
    fn from_vault_value(raw: &Value, format: Option<u64>) -> Result<Self> {
        match format {
            Some(SECRETS_FORMAT_VERSION) => {
                let envelope: SecretsEnvelope = serde_json::from_value(raw.clone())?;
                ensure!(
                    envelope.format_version == SECRETS_FORMAT_VERSION,
                    "unexpected remote secrets format version"
                );
                Ok(envelope.secrets)
            }
            None => {
                let (_, secrets) = split_config(raw);
                Ok(secrets)
            }
            Some(other) => anyhow::bail!("unsupported remote secrets format version: {other}"),
        }
    }
}

fn read_private_json_bounded<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file()
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.permissions().mode() & 0o077 == 0,
        "remote settings file must be a regular 0600 file owned by current user"
    );
    ensure!(
        metadata.len() <= MAX_REMOTE_SETTINGS_BYTES,
        "remote settings file exceeds size limit"
    );
    let mut bytes = Vec::new();
    file.by_ref()
        .take(MAX_REMOTE_SETTINGS_BYTES + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_REMOTE_SETTINGS_BYTES,
        "remote settings file exceeds size limit"
    );
    Ok(Some(serde_json::from_slice(&bytes)?))
}

fn canonical_json(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let sorted: BTreeMap<String, Value> = map
                .iter()
                .map(|(k, v)| (k.clone(), canonical_json(v)))
                .collect();
            Value::Object(sorted.into_iter().collect())
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical_json).collect()),
        _ => value.clone(),
    }
}

fn config_digest(config: &Value) -> String {
    let bytes = serde_json::to_vec(&canonical_json(config)).expect("serializable remote config");
    storage::digest(&bytes)
}

/// 将完整 Remote config 拆分为（非敏感 settings，敏感 secrets）。
/// 所有敏感字段无条件剥离出 settings，绝不回落到明文；重复键或缺失键的敏感值按位置索引保存在加密侧。
fn split_config(config: &Value) -> (Value, RemoteSecrets) {
    let mut settings = config.clone();
    let mut secrets = RemoteSecrets::default();
    let Some(root) = settings.as_object_mut() else {
        return (settings, secrets);
    };
    if let Some(identity) = root.remove("identity") {
        secrets.identity = Some(identity);
    }
    if let Some(profiles) = root.get_mut("relayProfiles").and_then(Value::as_array_mut) {
        let mut room_counts: HashMap<String, usize> = HashMap::new();
        for profile in profiles.iter() {
            if let Some(room) = profile
                .get("room")
                .and_then(Value::as_str)
                .filter(|room| !room.is_empty())
            {
                *room_counts.entry(room.to_owned()).or_insert(0) += 1;
            }
        }
        for (idx, profile) in profiles.iter_mut().enumerate() {
            if let Some(obj) = profile.as_object_mut()
                && let Some(cap_val) = obj.remove("capability")
            {
                let unique_room = obj
                    .get("room")
                    .and_then(Value::as_str)
                    .filter(|room| !room.is_empty())
                    .filter(|room| room_counts.get(*room).copied() == Some(1));
                if let (Some(room), Some(cap)) = (unique_room, cap_val.as_str()) {
                    secrets
                        .relay_capabilities
                        .insert(room.to_owned(), cap.to_owned());
                } else {
                    secrets.relay_profile_capabilities.insert(idx, cap_val);
                }
            }
        }
    }
    if let Some(cap_val) = root.remove("capability") {
        let matches_room = cap_val.as_str().is_some_and(|cap| {
            root.get("room")
                .and_then(Value::as_str)
                .and_then(|room| secrets.relay_capabilities.get(room))
                .is_some_and(|stored| stored == cap)
        });
        if matches_room {
            secrets.top_capability_from_room = true;
        } else {
            secrets.capability = Some(cap_val);
        }
    }
    if let Some(grants) = root.get_mut("deviceGrants").and_then(Value::as_array_mut) {
        let mut peer_counts: HashMap<String, usize> = HashMap::new();
        for grant in grants.iter() {
            if let Some(peer) = grant
                .get("devicePeerId")
                .and_then(Value::as_str)
                .filter(|peer| !peer.is_empty())
            {
                *peer_counts.entry(peer.to_owned()).or_insert(0) += 1;
            }
        }
        for (idx, grant) in grants.iter_mut().enumerate() {
            if let Some(obj) = grant.as_object_mut()
                && let Some(push) = obj.remove("push")
            {
                let unique_peer = obj
                    .get("devicePeerId")
                    .and_then(Value::as_str)
                    .filter(|peer| !peer.is_empty())
                    .filter(|peer| peer_counts.get(*peer).copied() == Some(1));
                if let Some(peer) = unique_peer {
                    secrets.device_push.insert(peer.to_owned(), push);
                } else {
                    secrets.device_push_by_index.insert(idx, push);
                }
            }
        }
    }
    (settings, secrets)
}

/// 将非敏感 settings 与加密 secrets 无损合并为完整 Remote config。
fn merge_config(settings: &Value, secrets: &RemoteSecrets) -> Value {
    let mut merged = settings.clone();
    let Some(root) = merged.as_object_mut() else {
        return merged;
    };
    if let Some(identity) = &secrets.identity {
        root.insert("identity".into(), identity.clone());
    }
    if let Some(profiles) = root.get_mut("relayProfiles").and_then(Value::as_array_mut) {
        for (idx, profile) in profiles.iter_mut().enumerate() {
            if let Some(obj) = profile.as_object_mut() {
                if let Some(cap) = secrets.relay_profile_capabilities.get(&idx) {
                    obj.insert("capability".into(), cap.clone());
                } else if let Some(cap) = obj
                    .get("room")
                    .and_then(Value::as_str)
                    .and_then(|room| secrets.relay_capabilities.get(room))
                {
                    obj.insert("capability".into(), json!(cap));
                }
            }
        }
    }
    if secrets.top_capability_from_room {
        if let Some(cap) = root
            .get("room")
            .and_then(Value::as_str)
            .and_then(|room| secrets.relay_capabilities.get(room))
        {
            root.insert("capability".into(), json!(cap));
        }
    } else if let Some(cap) = &secrets.capability {
        root.insert("capability".into(), cap.clone());
    }
    if let Some(grants) = root.get_mut("deviceGrants").and_then(Value::as_array_mut) {
        for (idx, grant) in grants.iter_mut().enumerate() {
            if let Some(obj) = grant.as_object_mut() {
                if let Some(push) = secrets.device_push_by_index.get(&idx) {
                    obj.insert("push".into(), push.clone());
                } else if let Some(peer) = obj.get("devicePeerId").and_then(Value::as_str)
                    && let Some(push) = secrets.device_push.get(peer)
                {
                    obj.insert("push".into(), push.clone());
                }
            }
        }
    }
    merged
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

pub(crate) fn remote_credential_error(cause: anyhow::Error) -> anyhow::Error {
    #[cfg(target_os = "macos")]
    if cause.is::<crate::credential_io::EnvelopeInvalid>() {
        return error(
            "remoteCredentialUnreadable",
            "Saved mobile connection credentials could not be decrypted",
        );
    }
    cause
}

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
    secrets: RemoteSecrets,
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
            .map_err(remote_credential_error)
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
        if let Some(state) = storage::read_json::<State>(&remote.path())?
            && let Some(receipt) = state.receipt.filter(|value| value["requestId"] == id)
        {
            return Ok(Some(receipt));
        }
        storage::read_json(
            &home
                .join("host/remote-operations")
                .join(format!("{id}.json")),
        )
    }
    pub fn selected_source(home: &Path) -> Result<Option<String>> {
        if let Some(state) = storage::read_json::<State>(&home.join("host/remote-state.json"))? {
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
    fn pending_settings_path(&self, entry_id: &str) -> Result<PathBuf> {
        wire::request_id(entry_id)?;
        Ok(self
            .home
            .join("host/remote-settings-pending")
            .join(format!("{entry_id}.json")))
    }
    fn save_pending_settings(&self, entry_id: &str, settings: &Value) -> Result<String> {
        let dir = self.home.join("host/remote-settings-pending");
        storage::private_dir(&dir)?;
        std::fs::File::open(self.home.join("host"))?.sync_all()?;
        let path = self.pending_settings_path(entry_id)?;
        storage::write(&path, settings)?;
        Ok(config_digest(settings))
    }
    fn remove_pending_settings(&self, entry_id: &str) {
        if let Ok(path) = self.pending_settings_path(entry_id) {
            let _ = std::fs::remove_file(path);
        }
    }
    fn state(&self, migration: &impl Credentials) -> Result<Option<State>> {
        if let Some(state) = storage::read_json(&self.path())? {
            return Ok(Some(state));
        }
        let Some((source_id, entry_id, allowed_projects)) = migration.remote_seed()? else {
            return Ok(None);
        };
        let state = State {
            source_id,
            revision: 1,
            entry_id,
            secrets_format: None,
            settings: None,
            allowed_projects,
            receipt: None,
        };
        storage::write(&self.path(), &state)?;
        Ok(Some(state))
    }
    fn load_config_and_secrets(
        &self,
        state: &State,
        migration: &impl Credentials,
    ) -> Result<(Value, RemoteSecrets)> {
        if let Some(settings) = &state.settings {
            if state.entry_id.is_empty() {
                return Ok((settings.clone(), RemoteSecrets::default()));
            }
            let raw = migration
                .vault()
                .read(&state.entry_id)?
                .context("missing Remote vault entry")?;
            let secrets = RemoteSecrets::from_vault_value(&raw, state.secrets_format)?;
            return Ok((merge_config(settings, &secrets), secrets));
        }
        let raw = migration
            .vault()
            .read(&state.entry_id)?
            .context("missing Remote vault entry")?;
        let secrets = RemoteSecrets::from_vault_value(&raw, state.secrets_format)?;
        Ok((raw, secrets))
    }
    fn current_secrets(
        &self,
        state: &State,
        migration: &impl Credentials,
    ) -> Result<RemoteSecrets> {
        {
            let projection = self.projection.lock().unwrap();
            if let Some(loaded) = projection.as_ref()
                && Self::same_state(&loaded.state, state)
            {
                return Ok(loaded.secrets.clone());
            }
        }
        if state.entry_id.is_empty() {
            return Ok(RemoteSecrets::default());
        }
        let raw = migration
            .vault()
            .read(&state.entry_id)?
            .context("missing Remote vault entry")?;
        RemoteSecrets::from_vault_value(&raw, state.secrets_format)
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
            && left.secrets_format == right.secrets_format
    }
    fn publish_read(&self, state: &State, config: Value, secrets: RemoteSecrets) -> Result<Value> {
        let mut projection = self.projection.lock().unwrap();
        let durable = storage::read_json::<State>(&self.path())?;
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
            secrets,
        });
        Ok(value)
    }
    fn commit_state(&self, state: &State, config: Value, secrets: RemoteSecrets) -> Result<()> {
        // Keychain I/O 已完成（或纯非敏感更新无需 Keychain）；短临界区让持久化与同步授权投影同时对读者生效。
        let mut projection = self.projection.lock().unwrap();
        storage::write(&self.path(), state)?;
        *projection = Some(Projection {
            state: state.clone(),
            config,
            secrets,
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
        let durable = storage::read_json::<State>(&self.path())?;
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
        storage::read_json(&self.home.join("host/remote-gateway.json"))
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
        let (config, secrets) = self.load_config_and_secrets(&state, migration)?;
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
        self.publish_read(&state, config, secrets)?;
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
                let (current, secrets) = self.load_config_and_secrets(&state, migration)?;
                self.publish_read(&state, current, secrets)
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
                        let digest = config_digest(&input.config);
                        if previous["sourceId"] != input.source_id
                            || previous["previousRevision"] != input.expected_revision
                        {
                            return Err(error(
                                "requestConflict",
                                "Remote operation parameters differ",
                            ));
                        }
                        if let Some(prev_digest) =
                            previous.get("configDigest").and_then(Value::as_str)
                        {
                            if prev_digest != digest {
                                return Err(error(
                                    "requestConflict",
                                    "Remote operation parameters differ",
                                ));
                            }
                            return Ok(previous);
                        }
                        if previous["state"] != "completed" {
                            return Ok(previous);
                        }
                        if migration
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
                    secrets_format: None,
                    settings: None,
                    allowed_projects: Vec::new(),
                    receipt: None,
                });
                if state.source_id != input.source_id {
                    return Err(error("migrationConflict", "Remote source does not match"));
                }
                if state.revision != input.expected_revision {
                    return Err(error("revisionConflict", "Remote revision changed"));
                }
                let current_secrets = if state.revision != 0 {
                    self.current_secrets(&state, migration)?
                } else {
                    RemoteSecrets::default()
                };
                let (next_settings, next_secrets) = split_config(&input.config);
                if current_secrets.identity.is_some()
                    && current_secrets.identity != next_secrets.identity
                {
                    return Err(error(
                        "migrationConflict",
                        "Remote Noise identity is immutable",
                    ));
                }
                validate(&input.config, projects)
                    .map_err(|reason| error("invalidRequest", reason.to_string()))?;
                ensure!(
                    merge_config(&next_settings, &next_secrets) == input.config,
                    error("invalidRequest", "Remote configuration split mismatch")
                );
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
                let digest = config_digest(&input.config);
                let secrets_changed = (state.revision == 0 && !next_secrets.is_empty())
                    || (state.revision != 0 && next_secrets != current_secrets);
                if !secrets_changed {
                    // 纯非敏感配置变更：直接原子写 host/remote-state.json，不触发 credential-io / Keychain，
                    // 也不生成新的 vault-sealed 文件；沿用原有 entry_id 与 secrets_format。
                    state.revision += 1;
                    state.settings = Some(next_settings);
                    let mut receipt = json!({"requestId":input.request_id,"method":"remote.replace","sourceId":state.source_id,"previousRevision":input.expected_revision,"revision":state.revision,"entryId":state.entry_id,"configDigest":digest,"state":"completed"});
                    if let Some(control_digest) = input.control_digest {
                        receipt["controlDigest"] = json!(control_digest);
                    }
                    state.receipt = Some(receipt.clone());
                    self.commit_state(&state, input.config, next_secrets)?;
                    self.save_receipt(&receipt)?;
                    return Ok(receipt);
                }
                let entry_id = uuid::Uuid::new_v4().to_string();
                // 待提交 settings 单独落盘，避免回执 JSON 超过 storage::read 的 256 KiB 上限阻断恢复。
                let settings_digest = self.save_pending_settings(&entry_id, &next_settings)?;
                let mut pending = json!({"requestId":input.request_id,"method":"remote.replace","sourceId":state.source_id,"previousRevision":input.expected_revision,"entryId":entry_id,"secretsFormat":SECRETS_FORMAT_VERSION,"settingsRef":entry_id,"settingsDigest":settings_digest,"configDigest":digest,"allowedProjects":state.allowed_projects,"state":"acceptedPending"});
                if let Some(control_digest) = &input.control_digest {
                    pending["controlDigest"] = json!(control_digest);
                }
                self.save_receipt(&pending)?;
                migration
                    .vault()
                    .write(&entry_id, &next_secrets.to_vault_value())?;
                state.revision += 1;
                state.entry_id = entry_id.clone();
                state.secrets_format = Some(SECRETS_FORMAT_VERSION);
                state.settings = Some(next_settings);
                let mut receipt = json!({"requestId":input.request_id,"method":"remote.replace","sourceId":state.source_id,"previousRevision":input.expected_revision,"revision":state.revision,"entryId":entry_id,"secretsFormat":SECRETS_FORMAT_VERSION,"configDigest":digest,"state":"completed"});
                if let Some(control_digest) = input.control_digest {
                    receipt["controlDigest"] = json!(control_digest);
                }
                state.receipt = Some(receipt.clone());
                self.commit_state(&state, input.config, next_secrets)?;
                self.save_receipt(&receipt)?;
                self.remove_pending_settings(&entry_id);
                Ok(receipt)
            }
            _ => Err(error("methodNotFound", "unknown Remote state method")),
        }
    }
    fn save_receipt(&self, receipt: &Value) -> Result<()> {
        let path = self.home.join("host/remote-operations").join(format!(
            "{}.json",
            receipt["requestId"]
                .as_str()
                .context("missing Remote requestId")?
        ));
        if storage::read_json::<Value>(&path).ok().flatten().as_ref() == Some(receipt) {
            return Ok(());
        }
        storage::private_dir(&self.home.join("host/remote-operations"))?;
        std::fs::File::open(self.home.join("host"))?.sync_all()?;
        storage::write(&path, receipt)
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
                    secrets_format: state.secrets_format,
                    settings: state.settings.clone(),
                    allowed_projects: state.allowed_projects.clone(),
                    receipt: None,
                })
                .unwrap_or_else(|| State {
                    source_id: receipt["sourceId"].as_str().unwrap_or_default().into(),
                    revision: 0,
                    entry_id: String::new(),
                    secrets_format: None,
                    settings: None,
                    allowed_projects: Vec::new(),
                    receipt: None,
                });
            let settings_ref = receipt
                .get("settingsRef")
                .and_then(Value::as_str)
                .map(str::to_owned);
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
                if let Some(reference) = &settings_ref {
                    self.remove_pending_settings(reference);
                }
                continue;
            }
            let raw = value.context("missing pending Remote value")?;
            let pending_format = receipt.get("secretsFormat").and_then(Value::as_u64);
            let (next_settings, next_secrets, merged) = if let Some(reference) = &settings_ref {
                let pending_path = self.pending_settings_path(reference)?;
                let pending_settings: Value = read_private_json_bounded(&pending_path)?
                    .context("missing pending Remote settings file")?;
                if let Some(expected) = receipt.get("settingsDigest").and_then(Value::as_str) {
                    ensure!(
                        config_digest(&pending_settings) == expected,
                        "pending Remote settings digest mismatch"
                    );
                }
                let secrets = RemoteSecrets::from_vault_value(&raw, pending_format)?;
                let merged = merge_config(&pending_settings, &secrets);
                if let Some(expected_config) = receipt.get("configDigest").and_then(Value::as_str) {
                    ensure!(
                        config_digest(&merged) == expected_config,
                        "pending Remote merged config digest mismatch"
                    );
                }
                (pending_settings, secrets, merged)
            } else {
                let (settings, secrets) = split_config(&raw);
                (settings, secrets, raw)
            };
            if let Some(projects) = receipt.get("allowedProjects") {
                next.allowed_projects = serde_json::from_value(projects.clone())?;
            }
            validate(&merged, &next.allowed_projects)?;
            if next.revision != 0 {
                let current = self.current_secrets(&next, migration)?;
                ensure!(
                    current.identity.is_none() || current.identity == next_secrets.identity,
                    "pending Remote identity differs"
                );
            }
            next.revision += 1;
            next.entry_id = entry_id;
            next.secrets_format = pending_format;
            next.settings = Some(next_settings);
            receipt["state"] = json!("completed");
            receipt["revision"] = json!(next.revision);
            if receipt.get("configDigest").is_none() {
                receipt["configDigest"] = json!(config_digest(&merged));
            }
            next.receipt = Some(receipt.clone());
            self.commit_state(&next, merged, next_secrets)?;
            self.save_receipt(&receipt)?;
            if let Some(reference) = &settings_ref {
                self.remove_pending_settings(reference);
            }
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
        if let Some(state) = storage::read_json::<State>(&self.path())?
            && let Some(receipt) = state.receipt
            && receipt["requestId"] == id
        {
            self.save_receipt(&receipt)?;
            return Ok(Some(receipt));
        }
        storage::read_json(
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
                        if project != "*" && !projects.iter().any(|id| id == project) {
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
                .commit_state(
                    &changed,
                    json!({"identity":"unpublished"}),
                    RemoteSecrets {
                        identity: Some(json!("unpublished")),
                        ..RemoteSecrets::default()
                    }
                )
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
                secrets_format: None,
                settings: None,
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

    #[test]
    fn split_and_merge_is_lossless_and_keeps_secrets_out_of_settings() {
        let local_room = "a".repeat(64);
        let ext_room = "b".repeat(64);
        let original = json!({
            "schemaVersion": 2,
            "identity": "secret-noise-keypair",
            "enabled": true,
            "directEnabled": false,
            "relay": "http://192.168.1.39:47820",
            "room": local_room,
            "capability": "secret-local-cap",
            "relayProtocol": "areal.remote.v2",
            "relayLocal": { "enabled": true, "origin": "http://192.168.1.39:47820", "port": 47820 },
            "relayProfiles": [
                { "origin": "http://192.168.1.39:47820", "kind": "local", "room": "a".repeat(64), "capability": "secret-local-cap" },
                { "origin": "https://relay.example.org", "kind": "external", "room": "b".repeat(64), "capability": "secret-ext-cap" }
            ],
            "deviceGrants": [
                {
                    "devicePeerId": "phone-1",
                    "displayName": "iPhone",
                    "projectIds": ["p1"],
                    "capabilities": ["observe"],
                    "revision": 1,
                    "status": "active",
                    "push": { "platform": "apns", "token": "deadbeef", "environment": "production" }
                },
                {
                    "devicePeerId": "phone-2",
                    "displayName": "iPad",
                    "projectIds": ["p1"],
                    "capabilities": ["observe"],
                    "revision": 1,
                    "status": "active"
                }
            ],
            "network": { "kind": null, "visibility": null }
        });

        let (settings, secrets) = split_config(&original);
        let settings_text = serde_json::to_string(&settings).unwrap();
        assert!(!settings_text.contains("secret-noise-keypair"));
        assert!(!settings_text.contains("secret-local-cap"));
        assert!(!settings_text.contains("secret-ext-cap"));
        assert!(!settings_text.contains("deadbeef"));
        assert_eq!(merge_config(&settings, &secrets), original);

        // 切换 LAN IP 或通过 relayUse 切到已登记的外部 Relay，都不应改变 secrets。
        let mut switched_ip = original.clone();
        switched_ip["relay"] = json!("http://10.0.0.8:47820");
        switched_ip["relayLocal"]["origin"] = json!("http://10.0.0.8:47820");
        switched_ip["relayProfiles"][0]["origin"] = json!("http://10.0.0.8:47820");
        let (switched_settings, switched_secrets) = split_config(&switched_ip);
        assert_eq!(switched_secrets, secrets);
        assert_eq!(
            merge_config(&switched_settings, &switched_secrets),
            switched_ip
        );

        let mut switched_profile = original.clone();
        switched_profile["relay"] = json!("https://relay.example.org");
        switched_profile["room"] = json!(ext_room);
        switched_profile["capability"] = json!("secret-ext-cap");
        let (profile_settings, profile_secrets) = split_config(&switched_profile);
        assert_eq!(profile_secrets, secrets);
        assert_eq!(
            merge_config(&profile_settings, &profile_secrets),
            switched_profile
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn non_secret_updates_skip_vault_io_and_keep_vault_and_state_strictly_separated() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let root = tempfile::tempdir().unwrap();
        let home = root.path();
        let mut migration = Migration::new(home).unwrap();
        migration.vault = crate::vault::Vault::isolated_files(home);
        let vault_writes = Arc::new(AtomicUsize::new(0));
        let counter = vault_writes.clone();
        migration.vault.before_write = Some(Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        }));
        let remote = RemoteState::new(home);
        let room = "c".repeat(64);
        let initial = json!({
            "schemaVersion": 2,
            "identity": "secret-identity-key",
            "enabled": true,
            "directEnabled": false,
            "relay": "http://192.168.1.10:47820",
            "room": room,
            "capability": "secret-local-cap",
            "relayProtocol": "areal.remote.v2",
            "relayLocal": { "enabled": true, "origin": "http://192.168.1.10:47820", "port": 47820 },
            "relayProfiles": [
                { "origin": "http://192.168.1.10:47820", "kind": "local", "room": "c".repeat(64), "capability": "secret-local-cap" }
            ],
            "deviceGrants": []
        });
        let first = remote
            .dispatch_async(
                "remote.replace",
                json!({
                    "requestId": uuid::Uuid::new_v4().to_string(),
                    "expectedGeneration": "gen-1",
                    "expectedRevision": 0,
                    "sourceId": "source",
                    "config": initial
                }),
                "fixture",
                "gen-1",
                &migration,
                &[],
            )
            .await
            .unwrap();
        assert_eq!(vault_writes.load(Ordering::SeqCst), 1);
        let entry_id = first["entryId"].as_str().unwrap().to_owned();

        // 校验落盘边界：remote-state.json 绝不含敏感凭据；vault-sealed 绝不含非敏感开关。
        let state_disk = std::fs::read_to_string(home.join("host/remote-state.json")).unwrap();
        assert!(!state_disk.contains("secret-identity-key"));
        assert!(!state_disk.contains("secret-local-cap"));
        assert!(state_disk.contains("192.168.1.10:47820"));
        let vault_blob = migration.vault.read(&entry_id).unwrap().unwrap();
        assert_eq!(vault_blob["formatVersion"], 2);
        assert!(vault_blob.get("enabled").is_none());
        assert!(vault_blob.get("relayLocal").is_none());
        assert_eq!(vault_blob["identity"], "secret-identity-key");

        // 即使此时 Keychain/Vault 处于锁定态，纯非敏感变更（关闭开关 + 切换 LAN IP + 重开）也绝不触碰 Vault！
        migration.vault.locked.set(true);
        let mut toggled = initial.clone();
        toggled["enabled"] = json!(false);
        toggled["relayLocal"]["enabled"] = json!(false);
        toggled["relay"] = json!("http://10.0.0.9:47820");
        toggled["relayLocal"]["origin"] = json!("http://10.0.0.9:47820");
        toggled["relayProfiles"][0]["origin"] = json!("http://10.0.0.9:47820");
        let second_req = uuid::Uuid::new_v4().to_string();
        let second = remote
            .dispatch_async(
                "remote.replace",
                json!({
                    "requestId": second_req,
                    "expectedGeneration": "gen-1",
                    "expectedRevision": 1,
                    "sourceId": "source",
                    "config": toggled
                }),
                "fixture",
                "gen-1",
                &migration,
                &[],
            )
            .await
            .unwrap();
        assert_eq!(second["state"], "completed");
        assert_eq!(second["revision"], 2);
        assert_eq!(
            second["entryId"], entry_id,
            "entryId must stay unchanged on non-secret write"
        );
        assert_eq!(
            vault_writes.load(Ordering::SeqCst),
            1,
            "zero extra vault writes"
        );

        // 幂等重放同样不触碰 Vault。
        let replayed = remote
            .dispatch_async(
                "remote.replace",
                json!({
                    "requestId": second_req,
                    "expectedGeneration": "gen-1",
                    "expectedRevision": 1,
                    "sourceId": "source",
                    "config": toggled
                }),
                "fixture",
                "gen-1",
                &migration,
                &[],
            )
            .await
            .unwrap();
        assert_eq!(replayed, second);

        // 冷重启 Host 后解锁 Vault：必须读回最新 settings + 原加密 secrets 的完整合并结果。
        migration.vault.locked.set(false);
        let restarted = RemoteState::new(home);
        let loaded = restarted.snapshot_async(&migration).await.unwrap();
        assert_eq!(loaded["revision"], 2);
        assert_eq!(loaded["config"], toggled);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn combined_vault_blob_upgrades_cleanly_without_extra_vault_write() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let root = tempfile::tempdir().unwrap();
        let home = root.path();
        storage::private_dir(&home.join("host")).unwrap();
        let mut migration = Migration::new(home).unwrap();
        migration.vault = crate::vault::Vault::isolated_files(home);
        let prior_entry = uuid::Uuid::new_v4().to_string();
        let prior_config = json!({
            "schemaVersion": 2,
            "identity": "prior-noise-key",
            "enabled": false,
            "directEnabled": false,
            "relay": "http://192.168.1.2:47820",
            "room": "d".repeat(64),
            "capability": "prior-cap",
            "relayProtocol": "areal.remote.v2",
            "relayLocal": { "enabled": false, "origin": "http://192.168.1.2:47820", "port": 47820 },
            "relayProfiles": [
                { "origin": "http://192.168.1.2:47820", "kind": "local", "room": "d".repeat(64), "capability": "prior-cap" }
            ],
            "deviceGrants": []
        });
        migration.vault.write(&prior_entry, &prior_config).unwrap();
        // 模拟旧版无 settings 字段的 remote-state.json。
        storage::write(
            &home.join("host/remote-state.json"),
            &State {
                source_id: "source".into(),
                revision: 5,
                entry_id: prior_entry.clone(),
                secrets_format: None,
                settings: None,
                allowed_projects: Vec::new(),
                receipt: None,
            },
        )
        .unwrap();

        let vault_writes = Arc::new(AtomicUsize::new(0));
        let counter = vault_writes.clone();
        migration.vault.before_write = Some(Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        }));

        let remote = RemoteState::new(home);
        let loaded = remote.snapshot_async(&migration).await.unwrap();
        assert_eq!(loaded["config"], prior_config);

        // 升级后首次开启内网连接（仅改非敏感开关与 LAN IP）：零次 vault.write！
        let mut next = prior_config.clone();
        next["enabled"] = json!(true);
        next["relayLocal"]["enabled"] = json!(true);
        next["relay"] = json!("http://192.168.1.99:47820");
        next["relayLocal"]["origin"] = json!("http://192.168.1.99:47820");
        next["relayProfiles"][0]["origin"] = json!("http://192.168.1.99:47820");
        let receipt = remote
            .dispatch_async(
                "remote.replace",
                json!({
                    "requestId": uuid::Uuid::new_v4().to_string(),
                    "expectedGeneration": "gen-2",
                    "expectedRevision": 5,
                    "sourceId": "source",
                    "config": next
                }),
                "fixture",
                "gen-2",
                &migration,
                &[],
            )
            .await
            .unwrap();
        assert_eq!(receipt["revision"], 6);
        assert_eq!(receipt["entryId"], prior_entry);
        assert_eq!(vault_writes.load(Ordering::SeqCst), 0);

        // 重启后再冷读：即使旧 vault 密文里还写着 enabled: false，合并结果必须以新 settings 为准！
        let restarted = RemoteState::new(home);
        let reloaded = restarted.snapshot_async(&migration).await.unwrap();
        assert_eq!(reloaded["revision"], 6);
        assert_eq!(reloaded["config"], next);
    }

    #[test]
    fn unindexable_and_duplicate_key_secrets_stay_encrypted_without_cross_talk() {
        let config = json!({
            "identity": "secret-id",
            "capability": 42,
            "relayProfiles": [
                { "kind": "local", "capability": "unkeyed-profile-cap" },
                { "origin": "http://192.168.1.1:47820", "room": "dup-room", "capability": "cap-one" },
                { "origin": "http://192.168.1.2:47820", "room": "dup-room", "capability": "cap-two" }
            ],
            "deviceGrants": [
                { "displayName": "anon", "push": { "token": "anon-push-token" } },
                { "devicePeerId": "dup-peer", "status": "active", "push": { "token": "dup-push-token" } },
                { "devicePeerId": "dup-peer", "status": "revoked" }
            ]
        });
        let (settings, secrets) = split_config(&config);
        let plain = serde_json::to_string(&settings).unwrap();
        assert!(!plain.contains("secret-id"));
        assert!(!plain.contains("unkeyed-profile-cap"));
        assert!(!plain.contains("cap-one"));
        assert!(!plain.contains("cap-two"));
        assert!(!plain.contains("anon-push-token"));
        assert!(!plain.contains("dup-push-token"));
        assert!(settings.get("capability").is_none());
        let merged = merge_config(&settings, &secrets);
        assert_eq!(merged, config);
        assert!(merged["deviceGrants"][2].get("push").is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn oversized_pending_settings_over_256kib_recovers_before_and_after_vault_and_rejects_blocked_conflict()
     {
        for after_vault in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let home = root.path();
            storage::private_dir(&home.join("host")).unwrap();
            let mut migration = Migration::new(home).unwrap();
            migration.vault = crate::vault::Vault::isolated_files(home);
            let remote = RemoteState::new(home);
            let big_commands: Vec<Value> = (0..2200)
                .map(|i| {
                    json!({
                        "devicePeerId": "peer-a",
                        "commandId": format!("00000000-0000-0000-0000-{i:012}"),
                        "method": "device.push.register",
                        "semanticDigest": "e".repeat(64),
                        "registered": true
                    })
                })
                .collect();
            let config = json!({
                "schemaVersion": 2,
                "identity": "oversized-noise-key",
                "enabled": true,
                "pushCommands": big_commands,
                "deviceGrants": []
            });
            let (settings, secrets) = split_config(&config);
            assert!(
                serde_json::to_vec(&settings).unwrap().len() > 260 * 1024,
                "fixture must exceed 256 KiB storage::read cap"
            );
            let request_id = uuid::Uuid::new_v4().to_string();
            let entry_id = uuid::Uuid::new_v4().to_string();
            let settings_digest = remote.save_pending_settings(&entry_id, &settings).unwrap();
            let digest = config_digest(&config);
            remote
                .save_receipt(&json!({
                    "requestId": request_id,
                    "method": "remote.replace",
                    "sourceId": "source",
                    "previousRevision": 0,
                    "entryId": entry_id,
                    "secretsFormat": SECRETS_FORMAT_VERSION,
                    "settingsRef": entry_id,
                    "settingsDigest": settings_digest,
                    "configDigest": digest,
                    "allowedProjects": [],
                    "state": "acceptedPending"
                }))
                .unwrap();
            if after_vault {
                migration
                    .vault
                    .write(&entry_id, &secrets.to_vault_value())
                    .unwrap();
            }

            let restarted = RemoteState::new(home);
            let settled = restarted
                .operation_async(&request_id, &migration)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                settled["state"],
                if after_vault { "completed" } else { "blocked" }
            );
            assert!(
                !restarted.pending_settings_path(&entry_id).unwrap().exists(),
                "pending settings file must be cleaned up after settlement"
            );
            if after_vault {
                let loaded = restarted.snapshot_async(&migration).await.unwrap();
                assert_eq!(loaded["revision"], 1);
                assert_eq!(loaded["config"], config);
            } else {
                // blocked 回执重放不同 config 时，必须按 configDigest 拒绝冲突。
                let mut mutated = config.clone();
                mutated["enabled"] = json!(false);
                let conflict = restarted
                    .dispatch_async(
                        "remote.replace",
                        json!({
                            "requestId": request_id,
                            "expectedGeneration": "gen",
                            "expectedRevision": 0,
                            "sourceId": "source",
                            "config": mutated
                        }),
                        "fixture",
                        "gen",
                        &migration,
                        &[],
                    )
                    .await
                    .unwrap_err();
                assert!(conflict.to_string().contains("requestConflict"));
            }
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn prior_config_containing_format_version_2_is_not_misread_as_secrets_envelope() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path();
        storage::private_dir(&home.join("host")).unwrap();
        let mut migration = Migration::new(home).unwrap();
        migration.vault = crate::vault::Vault::isolated_files(home);
        let prior_entry = uuid::Uuid::new_v4().to_string();
        let prior_config = json!({
            "formatVersion": 2,
            "identity": "prior-v2-field-noise",
            "enabled": false,
            "room": "f".repeat(64),
            "capability": "prior-v2-field-cap",
            "relayProfiles": [
                { "origin": "http://192.168.1.5:47820", "kind": "local", "room": "f".repeat(64), "capability": "prior-v2-field-cap" }
            ],
            "deviceGrants": []
        });
        migration.vault.write(&prior_entry, &prior_config).unwrap();
        storage::write(
            &home.join("host/remote-state.json"),
            &State {
                source_id: "source".into(),
                revision: 2,
                entry_id: prior_entry.clone(),
                secrets_format: None,
                settings: None,
                allowed_projects: Vec::new(),
                receipt: None,
            },
        )
        .unwrap();

        let remote = RemoteState::new(home);
        let loaded = remote.snapshot_async(&migration).await.unwrap();
        assert_eq!(loaded["config"], prior_config);

        // 首次非敏感写复用旧 entry_id（secrets_format 保持 None），冷重启后仍能无损还原凭据。
        let mut toggled = prior_config.clone();
        toggled["enabled"] = json!(true);
        remote
            .dispatch_async(
                "remote.replace",
                json!({
                    "requestId": uuid::Uuid::new_v4().to_string(),
                    "expectedGeneration": "gen",
                    "expectedRevision": 2,
                    "sourceId": "source",
                    "config": toggled
                }),
                "fixture",
                "gen",
                &migration,
                &[],
            )
            .await
            .unwrap();
        let restarted = RemoteState::new(home);
        let reloaded = restarted.snapshot_async(&migration).await.unwrap();
        assert_eq!(reloaded["revision"], 3);
        assert_eq!(reloaded["config"], toggled);
    }
}
