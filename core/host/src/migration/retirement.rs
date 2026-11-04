use super::*;
use serde::de::{MapAccess, Visitor};
use serde_json::value::RawValue;

struct Fields(Vec<(String, Box<RawValue>)>);
impl<'de> Deserialize<'de> for Fields {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct Object;
        impl<'de> Visitor<'de> for Object {
            type Value = Fields;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("an object with unique keys")
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<Fields, A::Error> {
                let mut fields = Vec::new();
                let mut names = BTreeSet::new();
                while let Some(key) = map.next_key::<String>()? {
                    if !names.insert(key.clone()) {
                        return Err(serde::de::Error::custom("duplicate object key"));
                    }
                    fields.push((key, map.next_value()?));
                }
                Ok(Fields(fields))
            }
        }
        deserializer.deserialize_map(Object)
    }
}
impl Fields {
    fn get(&self, key: &str) -> Option<&RawValue> {
        self.0
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, v)| v.as_ref())
    }
    fn required(&self, key: &str) -> Result<&RawValue> {
        self.get(key)
            .ok_or_else(|| error("unsupportedSourceShape", format!("missing {key}")))
    }
    fn remove(&mut self, key: &str) {
        self.0.retain(|(name, _)| name != key);
    }
    fn replace(&mut self, key: &str, value: String) -> Result<()> {
        let field = self
            .0
            .iter_mut()
            .find(|(name, _)| name == key)
            .context("missing fixed field")?;
        field.1 = RawValue::from_string(value)?;
        Ok(())
    }
    fn encode(&self) -> Result<String> {
        let members = self
            .0
            .iter()
            .map(|(key, value)| Ok(format!("{}:{}", serde_json::to_string(key)?, value.get())))
            .collect::<Result<Vec<_>>>()?;
        Ok(format!("{{{}}}", members.join(",")))
    }
}

fn unique_values(raw: &RawValue, depth: usize) -> Result<()> {
    ensure!(depth < 128, "JSON nesting exceeds supported source shape");
    match raw.get().as_bytes().first() {
        Some(b'{') => {
            let object: Fields = serde_json::from_str(raw.get())?;
            for (_, value) in object.0 {
                unique_values(&value, depth + 1)?;
            }
        }
        Some(b'[') => {
            for value in serde_json::from_str::<Vec<Box<RawValue>>>(raw.get())? {
                unique_values(&value, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}
fn text(raw: &RawValue) -> Result<String> {
    Ok(serde_json::from_str(raw.get())?)
}
fn sanitized(file: &OriginalFile, secrets: &[&Secret], bytes: &[u8]) -> Result<Vec<u8>> {
    let sanitize = || -> Result<Vec<u8>> {
        let raw: Box<RawValue> = serde_json::from_slice(bytes)?;
        unique_values(&raw, 0)?;
        let mut object: Fields = serde_json::from_str(raw.get())?;
        ensure!(
            object.get("version").is_none() && object.get("schemaVersion").is_none(),
            "explicit source schema is unsupported"
        );
        match file.role.as_str() {
            "providerCredentials" => {
                let mut keys: Fields = serde_json::from_str(object.required("keys")?.get())?;
                for secret in secrets {
                    let vault::Slot::ProviderCredential { reference, .. } = &secret.slot else {
                        anyhow::bail!("invalid provider manifest slot")
                    };
                    text(keys.required(reference)?)?;
                    keys.remove(reference);
                }
                ensure!(
                    keys.0.is_empty(),
                    "provider keys are not covered by manifest"
                );
                object.replace("keys", keys.encode()?)?;
            }
            "providers" => {
                let providers: Vec<Box<RawValue>> =
                    serde_json::from_str(object.required("data")?.get())?;
                let mut output = Vec::new();
                let mut covered = BTreeSet::new();
                for provider in providers {
                    let mut fields: Fields = serde_json::from_str(provider.get())?;
                    let id = text(fields.required("id")?)?;
                    if let Some(value) = fields.get("secret") {
                        let value = text(value)?;
                        if !value.is_empty() {
                            let reference = format!("AREAL_CREDENTIAL_{id}");
                            ensure!(secrets.iter().any(|s| matches!(&s.slot, vault::Slot::ProviderCredential { reference: r, .. } if *r == reference)), "provider secret is not covered by manifest");
                            ensure!(
                                covered.insert(reference),
                                "duplicate provider credential ID"
                            );
                            fields.remove("secret");
                        }
                    }
                    output.push(fields.encode()?);
                }
                ensure!(
                    covered.len() == secrets.len(),
                    "provider manifest secret is missing"
                );
                object.replace("data", format!("[{}]", output.join(",")))?;
            }
            "subscriptionAccount" => {
                ensure!(
                    secrets.len() == 1 && !text(object.required("secret")?)?.is_empty(),
                    "invalid subscription secret"
                );
                object.remove("secret");
            }
            "subscriptionTransport" => {
                ensure!(secrets.len() == 1, "invalid transport manifest");
                text(object.required("token")?)?;
                let _: u64 = serde_json::from_str(object.required("port")?.get())?;
                object.remove("token");
            }
            "remote" => {
                ensure!(secrets.len() == 1, "invalid Remote manifest");
                text(object.required("encrypted")?)?;
                object.remove("encrypted");
            }
            _ => anyhow::bail!("unsupported secret role"),
        }
        Ok(object.encode()?.into_bytes())
    };
    sanitize().map_err(|_| {
        error(
            "unsupportedSourceShape",
            format!(
                "cannot retire {} without preserving its values",
                file.relative_name
            ),
        )
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Prepare {
    pub request_id: String,
    pub migration_id: String,
    pub expected_generation: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Confirm {
    pub request_id: String,
    pub migration_id: String,
    pub plan_id: String,
    pub expected_generation: String,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum Site {
    Source,
    Backup,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    site: Site,
    relative_name: String,
    backup_id: String,
    before_digest: String,
    after_digest: String,
    byte_length: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Item {
    target: Target,
    derived_from_original: bool,
    applied: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Plan {
    request_id: String,
    migration_id: String,
    source_id: String,
    manifest_digest: String,
    committed_bundle_digest: String,
    plan_id: String,
    completed: bool,
    items: Vec<Item>,
}
impl Plan {
    fn progress(&self, with_target: bool) -> Value {
        let next = with_target
            .then(|| {
                self.items
                    .iter()
                    .find(|item| !item.applied)
                    .map(|item| &item.target)
            })
            .flatten();
        json!({"requestId":self.request_id,"migrationId":self.migration_id,"planId":self.plan_id,"state":if self.completed {"completed"} else {"applying"},"next":next})
    }
}
impl Migration {
    pub(super) fn credential_metadata(&self, record: &Record) -> Result<Value> {
        let mut references = self.vault.provider_references(&record.source_id)?;
        for secret in &record.secrets {
            if let vault::Slot::ProviderCredential { reference, .. } = &secret.slot {
                references.insert(reference.clone());
            }
        }
        let plan = self.retirement_plan(&record.request_id)?;
        let mut result = json!({"references":references,"migratedConfigPaths":[]});
        for name in ["provider-credentials.json", "providers.json"] {
            let file = record
                .originals
                .iter()
                .find(|f| f.relative_name == name)
                .context("missing credential manifest")?;
            let Original::Bytes {
                backup_id, sha256, ..
            } = &file.original
            else {
                continue;
            };
            let bytes = read_bytes(
                &self
                    .directory(&record.request_id)?
                    .join("backups")
                    .join(format!("{backup_id}.bytes")),
            )?
            .context("missing credential metadata backup")?;
            let digest = storage::digest(&bytes);
            let retired = plan
                .as_ref()
                .and_then(|p| {
                    p.items.iter().find(|item| {
                        item.target.site == Site::Backup
                            && item.target.backup_id == *backup_id
                            && item.target.before_digest == *sha256
                    })
                })
                .is_some_and(|item| item.target.after_digest == digest);
            ensure!(
                digest == *sha256 || retired,
                "credential metadata backup digest mismatch"
            );
            let mut value: Value = serde_json::from_slice(&bytes)?;
            if name == "provider-credentials.json" {
                result["migratedConfigPaths"] = value.get("migrated").cloned().unwrap_or(json!([]));
                continue;
            }
            if let Some(providers) = value.get_mut("data").and_then(Value::as_array_mut) {
                for provider in providers {
                    if let Some(object) = provider.as_object_mut() {
                        object.remove("secret");
                        object.remove("apiKeyEnv");
                        if let Some(id) = object.get("id").and_then(Value::as_str) {
                            let reference = format!("AREAL_CREDENTIAL_{id}");
                            if record.secrets.iter().any(|secret| secret.relative_name == name
                                && matches!(&secret.slot, vault::Slot::ProviderCredential { reference: r, .. } if *r == reference)) {
                                object.insert("apiKeyEnv".into(), json!(reference));
                            }
                        }
                    }
                }
            }
            result["legacyProviders"] = value;
        }
        Ok(result)
    }
    fn retirement_path(&self, migration: &str) -> Result<PathBuf> {
        Ok(self.directory(migration)?.join("retirement.json"))
    }
    fn retirement_plan(&self, migration: &str) -> Result<Option<Plan>> {
        read_optional(&self.retirement_path(migration)?)
    }
    fn save_retirement(&self, plan: &Plan) -> Result<()> {
        storage::write(&self.retirement_path(&plan.migration_id)?, plan)
    }
    pub fn retirement_status(&self, migration: &str) -> Result<Value> {
        Ok(self
            .retirement_plan(migration)?
            .map(|plan| plan.progress(false))
            .unwrap_or(Value::Null))
    }
    pub(super) fn retirement_operation(
        &self,
        record: &Record,
        request: &str,
    ) -> Result<Option<Value>> {
        Ok(self.retirement_plan(&record.request_id)?.filter(|plan| plan.request_id == request).map(|plan| json!({"requestId":request,"method":"gui.retirementPrepare","state":if plan.completed {"completed"} else {"acceptedPending"},"result":plan.progress(false)})))
    }
    fn retirement_guard(&self, record: &Record, connection: &str) -> Result<Commit> {
        let commit = self.committed(record)?.ok_or_else(|| {
            error(
                "migrationNotCommitted",
                "retirement requires the original committed import",
            )
        })?;
        if !self.guarded(record, connection) {
            return Err(error(
                "sourceGuardRequired",
                "retirement requires the attached source connection",
            ));
        }
        Ok(commit)
    }
    fn retirement_entries(&self, record: &Record) -> Result<()> {
        for secret in &record.secrets {
            let receipt = record
                .vault_receipts
                .iter()
                .find(|receipt| {
                    receipt.state == "completed"
                        && receipt.slot == secret.slot
                        && receipt.source_digest == secret.source_digest
                        && receipt.entry_id == secret.entry_id
                })
                .ok_or_else(|| {
                    error(
                        "storageMissing",
                        "original completed vault receipt is missing",
                    )
                })?;
            if self
                .vault
                .read_without_interaction(&receipt.entry_id)?
                .is_none()
            {
                return Err(error("storageMissing", "original vault entry is missing"));
            }
        }
        Ok(())
    }
    fn retirement_fences(&self, record: &Record) -> Result<()> {
        for name in &record.fences {
            let file = record
                .originals
                .iter()
                .find(|file| file.relative_name == *name)
                .context("fence is absent from manifest")?;
            if read_bytes(&record.source.core_home.join(name))?.as_deref()
                != Some(self.fence_bytes(record, file)?.as_slice())
            {
                return Err(error("sourceChanged", "permanent source fence changed"));
            }
        }
        Ok(())
    }
    fn retirement_target_path(&self, record: &Record, target: &Target) -> Result<PathBuf> {
        wire::request_id(&target.backup_id)?;
        ensure!(
            matches!(
                target.relative_name.as_str(),
                "provider-credentials.json"
                    | "providers.json"
                    | "openai-subscription.json"
                    | "subscription-transport.json"
                    | "remote.json"
            ),
            "invalid retirement target name"
        );
        let parent = match target.site {
            Site::Source => {
                ensure!(
                    target.relative_name != "provider-credentials.json",
                    "provider source must remain fenced"
                );
                record.source.core_home.clone()
            }
            Site::Backup => self.directory(&record.request_id)?.join("backups"),
        };
        let metadata = std::fs::symlink_metadata(&parent)?;
        ensure!(
            metadata.is_dir()
                && !metadata.file_type().is_symlink()
                && metadata.uid() == unsafe { libc::geteuid() },
            "invalid retirement target directory"
        );
        Ok(match target.site {
            Site::Source => parent.join(&target.relative_name),
            Site::Backup => parent.join(format!("{}.bytes", target.backup_id)),
        })
    }
    fn retirement_target_digest(
        &self,
        record: &Record,
        target: &Target,
        sync_after: bool,
    ) -> Result<String> {
        let read = || -> Result<String> {
            let path = self.retirement_target_path(record, target)?;
            let parent = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
                .open(path.parent().context("missing retirement target parent")?)?;
            let metadata = parent.metadata()?;
            ensure!(
                metadata.is_dir() && metadata.uid() == unsafe { libc::geteuid() },
                "invalid retirement target parent"
            );
            let mut file = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&path)?;
            let metadata = file.metadata()?;
            ensure!(
                metadata.is_file()
                    && metadata.uid() == unsafe { libc::geteuid() }
                    && metadata.mode() & 0o077 == 0,
                "retirement target must be a private regular file owned by current user"
            );
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)?;
            let digest = storage::digest(&bytes);
            if sync_after && digest == target.after_digest {
                // GUI 可能已 rename，却在目录落盘前退出；回执必须晚于字节和目录项落盘。
                file.sync_all()?;
                parent.sync_all()?;
            }
            Ok(digest)
        };
        read().map_err(|_| {
            error(
                "sourceChanged",
                "retirement target changed, is missing or has unsafe ownership or permissions",
            )
        })
    }
    fn reconcile_retirement(&self, record: &Record, plan: &mut Plan) -> Result<()> {
        self.retirement_fences(record)?;
        for item in &mut plan.items {
            let digest = self.retirement_target_digest(record, &item.target, !item.applied)?;
            if digest == item.target.after_digest {
                item.applied = true;
            } else if digest != item.target.before_digest || item.applied {
                return Err(error(
                    "sourceChanged",
                    "retirement target does not match its durable plan",
                ));
            }
        }
        plan.completed = plan.items.iter().all(|item| item.applied);
        Ok(())
    }
    fn retirement_binding(
        &self,
        record: &Record,
        commit: &Commit,
        plan: &Plan,
        request: &str,
    ) -> Result<()> {
        if plan.request_id != request
            || plan.migration_id != record.request_id
            || plan.source_id != record.source_id
            || plan.manifest_digest != record.manifest_digest
            || plan.committed_bundle_digest != commit.bundle_digest
        {
            return Err(error(
                "requestConflict",
                "retirement request does not match the original plan",
            ));
        }
        Ok(())
    }
    pub fn retirement_prepare(&self, input: Prepare, connection: &str) -> Result<Value> {
        wire::request_id(&input.request_id)?;
        let record = self.read(&input.migration_id)?;
        if let Some(mut plan) = self.retirement_plan(&input.migration_id)? {
            let commit = self
                .committed(&record)?
                .context("retirement import is not committed")?;
            self.retirement_binding(&record, &commit, &plan, &input.request_id)?;
            if plan.completed {
                return Ok(plan.progress(false));
            }
            self.retirement_guard(&record, connection)?;
            self.reconcile_retirement(&record, &mut plan)?;
            if !plan.completed {
                self.retirement_entries(&record)?;
            }
            self.save_retirement(&plan)?;
            return Ok(plan.progress(true));
        }
        if self.operation(&input.request_id)?.is_some() {
            return Err(error(
                "requestConflict",
                "requestId already belongs to another operation",
            ));
        }
        let commit = self.retirement_guard(&record, connection)?;
        self.retirement_fences(&record)?;
        self.retirement_entries(&record)?;
        let mut plan = Plan {
            request_id: input.request_id,
            migration_id: record.request_id.clone(),
            source_id: record.source_id.clone(),
            manifest_digest: record.manifest_digest.clone(),
            committed_bundle_digest: commit.bundle_digest,
            plan_id: uuid::Uuid::new_v4().to_string(),
            completed: false,
            items: Vec::new(),
        };
        let mut derivatives = Vec::new();
        for file in &record.originals {
            let secrets: Vec<_> = record
                .secrets
                .iter()
                .filter(|secret| secret.relative_name == file.relative_name)
                .collect();
            if secrets.is_empty() {
                continue;
            }
            let Original::Bytes {
                sha256, backup_id, ..
            } = &file.original
            else {
                return Err(error("storageMissing", "secret original backup is missing"));
            };
            wire::request_id(backup_id)?;
            let backup = self
                .directory(&record.request_id)?
                .join("backups")
                .join(format!("{backup_id}.bytes"));
            let bytes = read_bytes(&backup)?.context("original retirement backup is missing")?;
            if storage::digest(&bytes) != *sha256 {
                return Err(error(
                    "sourceChanged",
                    "original retirement backup digest changed",
                ));
            }
            let output = sanitized(file, &secrets, &bytes)?;
            let target = Target {
                site: Site::Backup,
                relative_name: file.relative_name.clone(),
                backup_id: backup_id.clone(),
                before_digest: sha256.clone(),
                after_digest: storage::digest(&output),
                byte_length: output.len() as u64,
            };
            if file.role != "providerCredentials" {
                plan.items.push(Item {
                    target: Target {
                        site: Site::Source,
                        ..target.clone()
                    },
                    derived_from_original: true,
                    applied: false,
                });
            }
            plan.items.push(Item {
                target,
                derived_from_original: true,
                applied: false,
            });
            derivatives.push((backup_id, output));
        }
        plan.items
            .sort_by_key(|item| item.target.site == Site::Backup);
        self.reconcile_retirement(&record, &mut plan)?;
        let parent = self.directory(&record.request_id)?.join("retirement");
        storage::private_dir(&parent)?;
        let directory = parent.join(&plan.plan_id);
        storage::private_dir(&directory)?;
        for (backup_id, bytes) in derivatives {
            atomic_bytes(&directory.join(format!("{backup_id}.bytes")), &bytes)?;
        }
        File::open(&parent)?.sync_all()?;
        File::open(self.directory(&record.request_id)?)?.sync_all()?;
        if !self.guarded(&record, connection) {
            return Err(error(
                "sourceGuardRequired",
                "source connection closed before retirement preparation",
            ));
        }
        self.save_retirement(&plan)?;
        Ok(plan.progress(true))
    }
    pub fn retirement_confirm(&self, input: Confirm, connection: &str) -> Result<Value> {
        wire::request_id(&input.request_id)?;
        wire::request_id(&input.plan_id)?;
        let record = self.read(&input.migration_id)?;
        let mut plan = self
            .retirement_plan(&input.migration_id)?
            .ok_or_else(|| error("retirementNotFound", "retirement plan is missing"))?;
        let commit = self
            .committed(&record)?
            .context("retirement import is not committed")?;
        self.retirement_binding(&record, &commit, &plan, &input.request_id)?;
        if plan.plan_id != input.plan_id {
            return Err(error("requestConflict", "retirement planId changed"));
        }
        if plan.completed {
            return Ok(plan.progress(false));
        }
        self.retirement_guard(&record, connection)?;
        self.reconcile_retirement(&record, &mut plan)?;
        self.save_retirement(&plan)?;
        Ok(plan.progress(false))
    }
}

#[cfg(test)]
mod tests;
