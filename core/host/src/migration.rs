use crate::{
    ProjectRegistration, ProjectSource, vault,
    wire::{self, error},
};
use anyhow::{Context, Result, ensure};
use areal_local_service::storage;
use areal_protocol::service::{Service, StopOperationState};
use fs2::FileExt;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

mod prior_boot;
pub(crate) mod retirement;

pub(crate) const FENCE: &str = "AREAL_HOST_MIGRATED\n";
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Source {
    pub profile: PathBuf,
    pub core_home: PathBuf,
    pub legacy_service_home: PathBuf,
}
impl Source {
    fn canonical(mut self) -> Result<Self> {
        for path in [
            &mut self.profile,
            &mut self.core_home,
            &mut self.legacy_service_home,
        ] {
            if !path.is_absolute() {
                return Err(error("invalidRequest", "source paths must be absolute"));
            }
            *path = storage::canonical_pending(path)?;
        }
        if std::fs::symlink_metadata(self.core_home.join(".areal-test-copy.json")).is_ok() {
            return Err(error(
                "testCopySource",
                "development test copies cannot enter GUI source migration",
            ));
        }
        Ok(self)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Binding {
    pub alias: Alias,
    pub project_id: String,
    pub workspace: PathBuf,
    pub data_dir: PathBuf,
    pub scratch_dir: PathBuf,
    pub default_binding: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logical_alias: Option<Alias>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projectless_request_id: Option<String>,
    pub registration: ProjectRegistration,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Alias {
    pub profile: PathBuf,
    pub legacy_project_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct JournalSource {
    pub source_id: String,
    pub migration_id: String,
    pub manifest_digest: String,
    pub project_id: String,
    pub data_dir: PathBuf,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Original {
    Absent,
    Bytes {
        sha256: String,
        #[serde(rename = "byteLength")]
        byte_length: u64,
        #[serde(rename = "backupId")]
        backup_id: String,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OriginalFile {
    role: String,
    relative_name: String,
    original: Original,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Secret {
    slot: vault::Slot,
    source_digest: String,
    relative_name: String,
    read_path: PathBuf,
    entry_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum Phase {
    AwaitingSource,
    SecretsPending,
    LegacyPending,
    Fencing,
    Committed,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    request_id: String,
    #[serde(default)]
    request_aliases: Vec<String>,
    source_id: String,
    source: Source,
    phase: Phase,
    manifest_digest: String,
    bindings: Vec<Binding>,
    originals: Vec<OriginalFile>,
    secrets: Vec<Secret>,
    vault_receipts: Vec<vault::Receipt>,
    fences: Vec<String>,
    blockers: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    prior_boot_adoptions: Vec<prior_boot::Adoption>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Commit {
    bundle_digest: String,
    receipt: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Import {
    pub request_id: String,
    pub expected_generation: String,
    source: Source,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportSecret {
    pub request_id: String,
    pub expected_generation: String,
    migration_id: String,
    slot: vault::Slot,
    source_digest: String,
    value: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedProject {
    id: String,
    root: PathBuf,
    logical_project_id: Option<String>,
    worktree_request_id: Option<String>,
    projectless_request_id: Option<String>,
}

struct SourceGuard {
    connection: String,
    socket: Option<std::os::fd::RawFd>,
}

pub(crate) struct SchedulingImport {
    pub source_id: String,
    pub projects: BTreeSet<String>,
    pub suppressed: Result<BTreeSet<String>>,
}

pub(crate) struct Migration {
    home: PathBuf,
    guards: RefCell<BTreeMap<PathBuf, SourceGuard>>,
    pub vault: vault::Vault,
}
impl Migration {
    pub(crate) fn operation_offline(home: &Path, id: &str) -> Result<Option<Value>> {
        wire::request_id(id)?;
        if !home.join("host/imports").try_exists()? {
            return Ok(None);
        }
        let migration = Self {
            home: home.to_owned(),
            guards: RefCell::new(BTreeMap::new()),
            vault: vault::Vault::new(home),
        };
        for record in migration.records()? {
            if let Some(operation) = migration.retirement_operation(&record, id)? {
                return Ok(Some(operation));
            }
            if record.request_id == id || record.request_aliases.iter().any(|alias| alias == id) {
                return Ok(Some(json!({
                    "requestId":id,
                    "method":"gui.import",
                    "state":if migration.committed(&record)?.is_some() {"completed"} else {"acceptedPending"},
                    "result":migration.result(&record)?
                })));
            }
            if let Some(receipt) = record
                .vault_receipts
                .iter()
                .find(|receipt| receipt.request_id == id)
            {
                return Ok(Some(json!({
                    "requestId":id,"method":"gui.importSecret",
                    "state":receipt.state,"result":receipt
                })));
            }
        }
        Ok(None)
    }
    pub fn new(home: &Path) -> Result<Self> {
        storage::private_dir(&home.join("host/imports"))?;
        File::open(home.join("host"))?.sync_all()?;
        File::open(home)?.sync_all()?;
        Ok(Self {
            home: home.to_owned(),
            guards: RefCell::new(BTreeMap::new()),
            vault: vault::Vault::new(home),
        })
    }
    fn directory(&self, id: &str) -> Result<PathBuf> {
        wire::request_id(id)?;
        Ok(self.home.join("host/imports").join(id))
    }
    fn read(&self, id: &str) -> Result<Record> {
        read_optional(&self.directory(id)?.join("record.json"))?
            .ok_or_else(|| error("migrationNotFound", "unknown migrationId"))
    }
    fn save(&self, r: &Record) -> Result<()> {
        storage::write(&self.directory(&r.request_id)?.join("record.json"), r)
    }
    fn records(&self) -> Result<Vec<Record>> {
        let mut records = Vec::new();
        for entry in std::fs::read_dir(self.home.join("host/imports"))? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                if let Some(r) = read_optional(&entry.path().join("record.json"))? {
                    records.push(r);
                }
            }
        }
        Ok(records)
    }
    pub fn attach(
        &self,
        source: Source,
        connection: &str,
        socket: Option<std::os::fd::RawFd>,
    ) -> Result<Value> {
        let source = source.canonical()?;
        ensure!(source.core_home.is_dir(), "source Core home must exist");
        let mut guards = self.guards.borrow_mut();
        if guards
            .get(&source.core_home)
            .is_some_and(|owner| owner.connection != connection)
        {
            return Err(error(
                "sourceBusy",
                "another authenticated connection holds this source",
            ));
        }
        guards.insert(
            source.core_home.clone(),
            SourceGuard {
                connection: connection.into(),
                socket,
            },
        );
        Ok(json!({"sourceGuard":true,"source":source}))
    }
    pub fn disconnect(&self, connection: &str) {
        self.guards
            .borrow_mut()
            .retain(|_, owner| owner.connection != connection);
    }
    fn guarded(&self, r: &Record, connection: &str) -> bool {
        self.guards
            .borrow()
            .get(&r.source.core_home)
            .is_some_and(|owner| {
                if owner.connection != connection {
                    return false;
                }
                let Some(socket) = owner.socket else {
                    return cfg!(test);
                };
                let mut byte = 0u8;
                let result = unsafe {
                    libc::recv(
                        socket,
                        (&mut byte as *mut u8).cast(),
                        1,
                        libc::MSG_PEEK | libc::MSG_DONTWAIT,
                    )
                };
                result > 0
                    || (result < 0
                        && std::io::Error::last_os_error().kind() == std::io::ErrorKind::WouldBlock)
            })
    }
    pub fn status(&self, id: &str) -> Result<Value> {
        self.result(&self.read(id)?)
    }
    fn result(&self, r: &Record) -> Result<Value> {
        if let Some(commit) = self.committed(r)? {
            return Ok(
                json!({"kind":"ready","requestId":r.request_id,"migrationId":r.request_id,"phase":"committed","receipt":commit.receipt,"pendingSecrets":[]}),
            );
        }
        let secrets: Vec<_> = r
            .secrets
            .iter()
            .filter(|s| {
                !r.vault_receipts.iter().any(|receipt| {
                    receipt.slot == s.slot
                        && receipt.source_digest == s.source_digest
                        && receipt.state == "completed"
                })
            })
            .collect();
        Ok(
            json!({"kind":if r.phase==Phase::LegacyPending {"legacyPending"}else{"blocked"},"requestId":r.request_id,"migrationId":r.request_id,"sourceId":r.source_id,"phase":r.phase,"blockers":r.blockers,"pendingSecrets":secrets,"bindings":r.bindings,"manifestDigest":r.manifest_digest}),
        )
    }
    fn committed(&self, r: &Record) -> Result<Option<Commit>> {
        let commit: Option<Commit> =
            read_optional(&self.directory(&r.request_id)?.join("committed.json"))?;
        if let Some(commit) = &commit {
            ensure!(
                commit.bundle_digest == self.bundle_digest(r)?,
                "import commit digest mismatch"
            );
        }
        Ok(commit)
    }
    fn bundle_digest(&self, r: &Record) -> Result<String> {
        let mut bundle = json!({"source":r.source,"sourceId":r.source_id,"manifestDigest":r.manifest_digest,"bindings":r.bindings,"vaultReceipts":r.vault_receipts,"fences":r.fences});
        if !r.prior_boot_adoptions.is_empty() {
            bundle["priorBootAdoptions"] = serde_json::to_value(&r.prior_boot_adoptions)?;
        }
        Ok(storage::digest(&serde_json::to_vec(&bundle)?))
    }
    pub fn published(&self) -> Result<Vec<ProjectRegistration>> {
        let mut output = Vec::new();
        for r in self.records()? {
            if self.committed(&r)?.is_some() {
                output.extend(r.bindings.into_iter().map(|b| b.registration));
            }
        }
        Ok(output)
    }
    fn profile_source(&self, profile: &Path) -> Result<Record> {
        let mut selected = None;
        for record in self.records()? {
            if record.source.profile != profile || self.committed(&record)?.is_none() {
                continue;
            }
            if selected.is_some() {
                return Err(error(
                    "sourceConflict",
                    "GUI profile has multiple committed sources",
                ));
            }
            selected = Some(record);
        }
        selected.ok_or_else(|| error("sourceNotFound", "GUI profile has no committed source"))
    }
    pub fn source(&self, source: Source, current: &[ProjectRegistration]) -> Result<Value> {
        let source = source.canonical()?;
        let mut selected = None;
        let mut matching_profiles = 0;
        for record in self.records()? {
            if record.source.profile == source.profile && self.committed(&record)?.is_some() {
                matching_profiles += 1;
                if record.source == source {
                    selected = Some(record);
                }
            }
        }
        let Some(record) = selected else {
            return Ok(Value::Null);
        };
        if matching_profiles != 1 {
            return Err(error(
                "sourceConflict",
                "GUI profile has multiple committed sources",
            ));
        }
        let credentials = self.credential_metadata(&record)?;
        let mut bindings = record.bindings;
        for binding in &mut bindings {
            if let Some(registration) = current.iter().find(|r| r.project_id == binding.project_id)
            {
                binding.default_binding = registration.default_binding;
                binding.registration = registration.clone();
            }
        }
        for registration in current {
            let ProjectSource::Gui {
                profile,
                legacy_project_id,
            } = &registration.source
            else {
                continue;
            };
            if profile != &source.profile {
                continue;
            }
            if let Some(binding) = bindings
                .iter()
                .find(|b| b.alias.legacy_project_id == *legacy_project_id)
            {
                ensure!(
                    binding.project_id == registration.project_id,
                    "sourceConflict: GUI alias has another project binding"
                );
                continue;
            }
            bindings.push(Binding {
                alias: Alias {
                    profile: profile.clone(),
                    legacy_project_id: legacy_project_id.clone(),
                },
                project_id: registration.project_id.clone(),
                workspace: registration.workspace.clone(),
                data_dir: registration.data_dir.clone(),
                scratch_dir: storage::canonical_pending(
                    &source.core_home.join(legacy_project_id).join("scratch"),
                )?,
                default_binding: registration.default_binding,
                logical_alias: None,
                worktree_request_id: None,
                projectless_request_id: None,
                registration: registration.clone(),
            });
        }
        Ok(
            json!({"sourceId":record.source_id,"migrationId":record.request_id,"source":source,"bindings":bindings,"credentials":credentials}),
        )
    }
    pub fn validate_registration(
        &self,
        registration: &mut ProjectRegistration,
        current: &[ProjectRegistration],
    ) -> Result<()> {
        let ProjectSource::Gui {
            profile,
            legacy_project_id,
        } = &mut registration.source
        else {
            return Ok(());
        };
        ensure!(
            profile.is_absolute() && legacy_id(legacy_project_id),
            "invalidRequest: invalid GUI profile or legacyProjectId"
        );
        *profile = storage::canonical_pending(profile)?;
        let record = self.profile_source(profile)?;
        let original = record
            .bindings
            .iter()
            .find(|b| b.alias.legacy_project_id == *legacy_project_id);
        let original_conflict = original.is_some_and(|binding| {
            binding.project_id != registration.project_id
                || binding.workspace != registration.workspace
                || binding.data_dir != registration.data_dir
        });
        let current_conflict = current.iter().any(|other| {
            matches!(&other.source, ProjectSource::Gui { profile: p, legacy_project_id: id } if p == profile && id == legacy_project_id)
                && other.project_id != registration.project_id
        });
        if original_conflict || current_conflict {
            return Err(error(
                "aliasConflict",
                "GUI alias already binds another project",
            ));
        }
        if original.is_none() {
            let expected = storage::canonical_pending(
                &record
                    .source
                    .core_home
                    .join(legacy_project_id)
                    .join("state"),
            )?;
            ensure!(
                registration.data_dir == expected,
                "invalidRequest: GUI dataDir must match its source alias"
            );
        }
        Ok(())
    }
    pub fn unpublished_reserved(&self, project: &str) -> Result<bool> {
        for record in self.records()? {
            if record.bindings.iter().any(|b| b.project_id == project)
                && self.committed(&record)?.is_none()
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
    pub fn reserved(&self, registration: &ProjectRegistration) -> Result<bool> {
        Ok(self.records()?.iter().any(|r| {
            r.bindings.iter().any(|b| {
                b.project_id == registration.project_id || b.data_dir == registration.data_dir
            })
        }))
    }
    pub fn operation(&self, id: &str) -> Result<Option<Value>> {
        for mut r in self.records()? {
            if let Some(operation) = self.retirement_operation(&r, id)? {
                return Ok(Some(operation));
            }
            if r.request_id == id || r.request_aliases.iter().any(|alias| alias == id) {
                return Ok(Some(
                    json!({"requestId":id,"method":"gui.import","state":if self.committed(&r)?.is_some(){"completed"}else{"acceptedPending"},"result":self.result(&r)?}),
                ));
            }
            if let Some(index) = r.vault_receipts.iter().position(|v| v.request_id == id) {
                if r.vault_receipts[index].state != "completed"
                    && self
                        .vault
                        .read(&r.vault_receipts[index].entry_id)?
                        .is_some()
                {
                    r.vault_receipts[index].state = "completed".into();
                    self.save(&r)?;
                }
                let receipt = &r.vault_receipts[index];
                return Ok(Some(
                    json!({"requestId":id,"method":"gui.importSecret","state":receipt.state,"result":receipt}),
                ));
            }
        }
        Ok(None)
    }
    pub fn import(
        &self,
        input: Import,
        connection: &str,
        existing: &[ProjectRegistration],
        journal: &crate::journal::Journal,
    ) -> Result<Value> {
        wire::request_id(&input.request_id)?;
        let source = input.source.canonical()?;
        ensure!(source.core_home.is_dir(), "source Core home must exist");
        let directory = self.directory(&input.request_id)?;
        let mut record = if let Some(record) =
            read_optional::<Record>(&directory.join("record.json"))?
        {
            if record.source != source {
                return Err(error(
                    "requestConflict",
                    "migration requestId binds a different source",
                ));
            }
            record
        } else {
            for mut previous in self.records()? {
                if previous.request_aliases.contains(&input.request_id) && previous.source != source
                {
                    return Err(error(
                        "requestConflict",
                        "migration requestId binds a different source",
                    ));
                }
                if previous.source == source {
                    if !previous.request_aliases.contains(&input.request_id) {
                        previous.request_aliases.push(input.request_id.clone());
                        self.save(&previous)?;
                    }
                    return self.result(&previous);
                }
                if previous.source.profile == source.profile
                    || previous.source.core_home == source.core_home
                {
                    return Err(error(
                        "migrationConflict",
                        "source lineage differs from an existing migration",
                    ));
                }
            }
            storage::private_dir(&directory)?;
            storage::private_dir(&directory.join("backups"))?;
            File::open(&directory)?.sync_all()?;
            File::open(directory.parent().context("missing imports directory")?)?.sync_all()?;
            let record = Record {
                request_id: input.request_id,
                request_aliases: Vec::new(),
                source_id: uuid::Uuid::new_v4().to_string(),
                source,
                phase: Phase::AwaitingSource,
                manifest_digest: String::new(),
                bindings: Vec::new(),
                originals: Vec::new(),
                secrets: Vec::new(),
                vault_receipts: Vec::new(),
                fences: Vec::new(),
                blockers: Vec::new(),
                prior_boot_adoptions: Vec::new(),
            };
            self.save(&record)?;
            record
        };
        if self.committed(&record)?.is_some() {
            return self.result(&record);
        }
        if !self.guarded(&record, connection) {
            record.blockers = vec![
                json!({"code":"sourceGuardRequired","message":"Attach from the adapter holding the original singleton after freezing and flushing writers"}),
            ];
            self.save(&record)?;
            return self.result(&record);
        }
        if record.phase != Phase::Fencing {
            if !record.originals.is_empty() && !self.source_unchanged(&record)? {
                record.originals.clear();
                record.bindings.clear();
                record.secrets.clear();
                record.vault_receipts.clear();
                record.manifest_digest.clear();
                record.prior_boot_adoptions.clear();
            }
            if record.originals.is_empty() {
                self.snapshot(&mut record, existing)?;
                self.save(&record)?;
            }
            if record.secrets.iter().any(|s| {
                !record.vault_receipts.iter().any(|v| {
                    v.slot == s.slot && v.source_digest == s.source_digest && v.state == "completed"
                })
            }) {
                record.phase = Phase::SecretsPending;
                record.blockers = vec![
                    json!({"code":"credentialsRequired","message":"Import all manifest credential slots before handing off writers"}),
                ];
                self.save(&record)?;
                return self.result(&record);
            }
        }
        let (locks, adoptions) = match self.legacy_locks(&record) {
            Ok(evidence) => evidence,
            Err(e) => {
                record.blockers = vec![json!({"code":"legacyPending","message":e.to_string()})];
                if record.phase != Phase::Fencing {
                    record.phase = Phase::LegacyPending;
                }
                self.save(&record)?;
                return self.result(&record);
            }
        };
        record.prior_boot_adoptions = adoptions;
        self.save(&record)?;
        self.validate_bindings(&record, existing)?;
        self.check_remote(&record)?;
        if !self.guarded(&record, connection) {
            return Err(error("sourceGuardRequired", "source guard was released"));
        }
        self.verify_sources(&record)?;
        for path in [
            directory.join("backups"),
            directory.clone(),
            self.home.join("host/imports"),
            self.home.join("host"),
            self.home.clone(),
        ] {
            File::open(path)?.sync_all()?;
        }
        record.phase = Phase::Fencing;
        record.blockers.clear();
        self.save(&record)?;
        for name in std::iter::once("provider-credentials.json".to_owned())
            .chain(record.bindings.iter().flat_map(|b| {
                [
                    format!("{}-pending.json", b.alias.legacy_project_id),
                    format!("{}-outcomes.json", b.alias.legacy_project_id),
                ]
            }))
            .collect::<Vec<_>>()
        {
            if !self.guarded(&record, connection) {
                return Err(error(
                    "sourceGuardRequired",
                    "source connection closed during fencing",
                ));
            }
            let original = record
                .originals
                .iter()
                .find(|f| f.relative_name == name)
                .context("fence absent from manifest")?;
            let bytes = self.fence_bytes(&record, original)?;
            let path = record.source.core_home.join(&name);
            if read_bytes(&path)?.as_deref() != Some(bytes.as_slice()) {
                atomic_bytes(&path, &bytes)?;
            }
            if !record.fences.contains(&name) {
                record.fences.push(name);
                self.save(&record)?;
            }
        }
        self.verify_sources(&record)?;
        for binding in &record.bindings {
            let pending = self
                .original_json(
                    &record,
                    &format!("{}-pending.json", binding.alias.legacy_project_id),
                )?
                .unwrap_or_else(|| json!([]));
            let outcomes = self
                .original_json(
                    &record,
                    &format!("{}-outcomes.json", binding.alias.legacy_project_id),
                )?
                .unwrap_or_else(|| json!({}));
            ensure!(
                pending.is_array() && outcomes.is_object(),
                "invalid original journal shape"
            );
            journal.initialize(
                &binding.project_id,
                json!({"version":1,"pending":pending,"outcomes":outcomes}),
            )?;
        }
        if !self.guarded(&record, connection) {
            return Err(error(
                "sourceGuardRequired",
                "source connection closed before publication",
            ));
        }
        self.validate_bindings(&record, existing)?;
        for adoption in &record.prior_boot_adoptions {
            prior_boot::revalidate(&self.home, &record, adoption)?;
        }
        let mut receipt = json!({"requestId":record.request_id,"migrationId":record.request_id,"sourceId":record.source_id,"source":record.source,"manifestDigest":record.manifest_digest,"bindings":record.bindings,"vaultReceipts":record.vault_receipts,"fences":record.fences,"state":"completed","retirement":"pending","retainedClientData":["cloud.json"]});
        if !record.prior_boot_adoptions.is_empty() {
            receipt["priorBootAdoptions"] = serde_json::to_value(&record.prior_boot_adoptions)?;
        }
        let commit = Commit {
            bundle_digest: self.bundle_digest(&record)?,
            receipt,
        };
        storage::write(&directory.join("committed.json"), &commit)?;
        record.phase = Phase::Committed;
        self.save(&record)?;
        drop(locks);
        self.result(&record)
    }
    fn validate_bindings(&self, record: &Record, existing: &[ProjectRegistration]) -> Result<()> {
        let reserved = self
            .records()?
            .into_iter()
            .filter(|other| other.request_id != record.request_id)
            .flat_map(|other| {
                other
                    .bindings
                    .into_iter()
                    .map(|binding| binding.registration)
            })
            .collect::<Vec<_>>();
        for binding in &record.bindings {
            for other in existing.iter().chain(reserved.iter()) {
                if other == &binding.registration {
                    continue;
                }
                if other.project_id == binding.project_id || other.data_dir == binding.data_dir {
                    return Err(error(
                        "migrationConflict",
                        "project binding changed while import was pending",
                    ));
                }
                if binding.default_binding
                    && other.default_binding
                    && other.workspace == binding.workspace
                {
                    return Err(error(
                        "defaultBindingConflict",
                        "workspace already has a current or reserved default binding",
                    ));
                }
            }
        }
        Ok(())
    }
    fn fence_bytes(&self, r: &Record, file: &OriginalFile) -> Result<Vec<u8>> {
        let backup_id = match &file.original {
            Original::Absent => None,
            Original::Bytes { backup_id, .. } => Some(backup_id),
        };
        Ok(format!("{FENCE}{}\n",serde_json::to_string(&json!({"migrationId":r.request_id,"backupId":backup_id,"restore":"Use Host import recovery; do not restore legacy writers."}))?).into_bytes())
    }
    fn source_unchanged(&self, r: &Record) -> Result<bool> {
        for file in &r.originals {
            let bytes = read_bytes(&r.source.core_home.join(&file.relative_name))?;
            let matches = match (&file.original, bytes) {
                (Original::Absent, None) => true,
                (Original::Bytes { sha256, .. }, Some(bytes)) => storage::digest(&bytes) == *sha256,
                _ => false,
            };
            if !matches {
                return Ok(false);
            }
        }
        Ok(self.names(&r.source, &r.bindings)?
            == r.originals
                .iter()
                .map(|f| (f.role.clone(), f.relative_name.clone()))
                .collect::<Vec<_>>())
    }
    fn verify_sources(&self, r: &Record) -> Result<()> {
        for file in &r.originals {
            let bytes = read_bytes(&r.source.core_home.join(&file.relative_name))?;
            if r.phase == Phase::Fencing
                && matches!(
                    file.role.as_str(),
                    "providerCredentials" | "pending" | "outcomes"
                )
                && bytes.as_deref() == Some(self.fence_bytes(r, file)?.as_slice())
            {
                continue;
            }
            let matches = match (&file.original, bytes) {
                (Original::Absent, None) => true,
                (Original::Bytes { sha256, .. }, Some(bytes)) => storage::digest(&bytes) == *sha256,
                _ => false,
            };
            if !matches {
                return Err(error(
                    "sourceChanged",
                    "source bytes changed after the manifest was frozen",
                ));
            }
        }
        if self.names(&r.source, &r.bindings)?
            != r.originals
                .iter()
                .map(|f| (f.role.clone(), f.relative_name.clone()))
                .collect::<Vec<_>>()
        {
            return Err(error("sourceChanged", "source directory inventory changed"));
        }
        Ok(())
    }
    fn names(&self, source: &Source, bindings: &[Binding]) -> Result<Vec<(String, String)>> {
        let mut names = vec![
            ("registry", "projects.json"),
            ("providerCredentials", "provider-credentials.json"),
            ("providers", "providers.json"),
            ("subscriptionAccount", "openai-subscription.json"),
            ("subscriptionTransport", "subscription-transport.json"),
            ("remote", "remote.json"),
            ("projectlessDrafts", "projectless-drafts.json"),
            ("library", "library.json"),
        ]
        .into_iter()
        .map(|(a, b)| (a.to_owned(), b.to_owned()))
        .collect::<Vec<_>>();
        for binding in bindings {
            for (role, suffix) in [("pending", "pending"), ("outcomes", "outcomes")] {
                names.push((
                    role.into(),
                    format!("{}-{suffix}.json", binding.alias.legacy_project_id),
                ));
            }
        }
        for (role, directory) in [
            ("worktreeRequest", "worktree-requests"),
            ("threadOwners", "thread-owners"),
            ("taskOwners", "task-owners"),
            ("lifecycleOperation", "lifecycle-operations"),
        ] {
            let path = source.core_home.join(directory);
            if !path.exists() {
                continue;
            }
            let metadata = std::fs::symlink_metadata(&path)?;
            ensure!(
                metadata.is_dir() && metadata.uid() == unsafe { libc::geteuid() },
                "invalid source metadata directory"
            );
            for entry in std::fs::read_dir(path)? {
                let entry = entry?;
                let name = entry
                    .file_name()
                    .into_string()
                    .map_err(|_| error("invalidSource", "non-UTF8 metadata name"))?;
                if !name.ends_with(".json") {
                    continue;
                }
                let id = &name[..name.len() - 5];
                ensure!(
                    if role == "worktreeRequest" || role == "lifecycleOperation" {
                        uuid::Uuid::parse_str(id).is_ok()
                    } else {
                        legacy_id(id)
                    },
                    "invalid source metadata filename"
                );
                names.push((role.into(), format!("{directory}/{name}")));
            }
        }
        names.sort();
        Ok(names)
    }
    fn snapshot(&self, r: &mut Record, existing: &[ProjectRegistration]) -> Result<()> {
        let bytes = read_bytes(&r.source.core_home.join("projects.json"))?;
        let projects: Vec<SavedProject> = bytes
            .as_deref()
            .map(serde_json::from_slice)
            .transpose()?
            .unwrap_or_default();
        let ids = projects
            .iter()
            .map(|p| p.id.as_str())
            .collect::<BTreeSet<_>>();
        ensure!(
            ids.len() == projects.len() && ids.iter().all(|id| legacy_id(id)),
            "invalid or duplicate legacy project ID"
        );
        let mut used: BTreeSet<_> = existing.iter().map(|r| r.project_id.clone()).collect();
        let other = self
            .records()?
            .into_iter()
            .filter(|other| other.request_id != r.request_id)
            .flat_map(|r| r.bindings)
            .collect::<Vec<_>>();
        used.extend(other.iter().map(|b| b.project_id.clone()));
        for project in &projects {
            ensure!(
                project.root.is_absolute(),
                "legacy workspace must be absolute"
            );
            let workspace = project.root.canonicalize()?;
            let data_dir =
                storage::canonical_pending(&r.source.core_home.join(&project.id).join("state"))?;
            let scratch_dir =
                storage::canonical_pending(&r.source.core_home.join(&project.id).join("scratch"))?;
            ensure!(
                !data_dir.starts_with(&workspace) && !self.home.starts_with(&workspace),
                "source state must be outside workspace"
            );
            if other.iter().any(|b| b.data_dir == data_dir) {
                return Err(error(
                    "dataDirConflict",
                    "another source reserves the same Store",
                ));
            }
            if r.bindings.iter().any(|b| b.data_dir == data_dir) {
                return Err(error(
                    "dataDirConflict",
                    "two source projects point to the same Store",
                ));
            }
            let equivalent = existing.iter().find(|p| p.data_dir == data_dir);
            if equivalent.is_some_and(|p| {
                p.workspace != workspace || !matches!(p.source, ProjectSource::Cli)
            }) {
                return Err(error(
                    "dataDirConflict",
                    "Store has an incompatible source binding",
                ));
            }
            let project_id = equivalent.map(|p| p.project_id.clone()).unwrap_or_else(|| {
                if used.contains(&project.id) {
                    uuid::Uuid::new_v4().to_string()
                } else {
                    project.id.clone()
                }
            });
            used.insert(project_id.clone());
            let default_binding = equivalent.map(|p| p.default_binding).unwrap_or_else(|| {
                projects
                    .iter()
                    .filter(|p| p.root.canonicalize().ok().as_ref() == Some(&workspace))
                    .count()
                    == 1
                    && !existing
                        .iter()
                        .any(|p| p.workspace == workspace && p.default_binding)
                    && !other
                        .iter()
                        .any(|b| b.workspace == workspace && b.default_binding)
            });
            let alias = Alias {
                profile: r.source.profile.clone(),
                legacy_project_id: project.id.clone(),
            };
            let registration = equivalent.cloned().unwrap_or_else(|| ProjectRegistration {
                project_id: project_id.clone(),
                workspace: workspace.clone(),
                data_dir: data_dir.clone(),
                source: ProjectSource::Gui {
                    profile: r.source.profile.clone(),
                    legacy_project_id: project.id.clone(),
                },
                default_binding,
            });
            if let Some(id) = &project.logical_project_id {
                ensure!(ids.contains(id.as_str()), "logical project alias not found");
            }
            r.bindings.push(Binding {
                alias,
                project_id,
                workspace,
                data_dir,
                scratch_dir,
                default_binding,
                logical_alias: project.logical_project_id.as_ref().map(|id| Alias {
                    profile: r.source.profile.clone(),
                    legacy_project_id: id.clone(),
                }),
                worktree_request_id: project.worktree_request_id.clone(),
                projectless_request_id: project.projectless_request_id.clone(),
                registration,
            });
        }
        for (role, name) in self.names(&r.source, &r.bindings)? {
            let original = if let Some(bytes) = read_bytes(&r.source.core_home.join(&name))? {
                let backup_id = uuid::Uuid::new_v4().to_string();
                atomic_bytes(
                    &self
                        .directory(&r.request_id)?
                        .join("backups")
                        .join(format!("{backup_id}.bytes")),
                    &bytes,
                )?;
                Original::Bytes {
                    sha256: storage::digest(&bytes),
                    byte_length: bytes.len() as u64,
                    backup_id,
                }
            } else {
                Original::Absent
            };
            r.originals.push(OriginalFile {
                role,
                relative_name: name,
                original,
            });
        }
        let registry = r
            .originals
            .iter()
            .find(|f| f.relative_name == "projects.json")
            .context("missing registry manifest")?;
        ensure!(
            match (&registry.original, &bytes) {
                (Original::Absent, None) => true,
                (Original::Bytes { sha256, .. }, Some(bytes)) => *sha256 == storage::digest(bytes),
                _ => false,
            },
            "registry changed while planning import"
        );
        r.manifest_digest = storage::digest(&serde_json::to_vec(&r.originals)?);
        for file in &r.originals {
            let Original::Bytes {
                sha256, backup_id, ..
            } = &file.original
            else {
                continue;
            };
            let read_path = self
                .directory(&r.request_id)?
                .join("backups")
                .join(format!("{backup_id}.bytes"));
            let value: Value = serde_json::from_slice(
                &read_bytes(&read_path)?.context("missing original backup")?,
            )?;
            let mut slots = Vec::new();
            match file.role.as_str() {
                "providerCredentials" => {
                    let keys = value["keys"]
                        .as_object()
                        .context("invalid provider credential keys")?;
                    for (reference, ciphertext) in keys {
                        ensure!(
                            reference.starts_with("AREAL_CREDENTIAL_") && ciphertext.is_string(),
                            "invalid provider credential"
                        );
                        slots.push(vault::Slot::ProviderCredential {
                            source_id: r.source_id.clone(),
                            reference: reference.clone(),
                        });
                    }
                }
                "providers" => {
                    for provider in value["data"].as_array().context("invalid providers")? {
                        if provider
                            .get("secret")
                            .is_some_and(|s| s.as_str().is_some_and(|s| !s.is_empty()))
                        {
                            slots.push(vault::Slot::ProviderCredential {
                                source_id: r.source_id.clone(),
                                reference: format!(
                                    "AREAL_CREDENTIAL_{}",
                                    provider["id"].as_str().context("invalid provider ID")?
                                ),
                            });
                        }
                    }
                }
                "subscriptionAccount" => {
                    if value["secret"].as_str().is_some_and(|s| !s.is_empty()) {
                        slots.push(vault::Slot::SubscriptionAccount {
                            source_id: r.source_id.clone(),
                            provider_id: "openai".into(),
                        });
                    } else {
                        ensure!(
                            value.get("secret").is_some_and(|v| v.is_null() || v == ""),
                            "invalid subscription record"
                        );
                    }
                }
                "subscriptionTransport" => {
                    ensure!(
                        value["token"].is_string() && value["port"].is_u64(),
                        "invalid subscription transport"
                    );
                    slots.push(vault::Slot::SubscriptionTransport {
                        source_id: r.source_id.clone(),
                    });
                }
                "remote" => {
                    ensure!(value["encrypted"].is_string(), "invalid Remote source");
                    slots.push(vault::Slot::RemoteIdentity);
                }
                "pending" => ensure!(value.is_array(), "invalid pending journal"),
                "outcomes" => ensure!(value.is_object(), "invalid outcomes journal"),
                _ => {}
            }
            for slot in slots {
                r.secrets.push(Secret {
                    slot,
                    source_digest: sha256.clone(),
                    relative_name: file.relative_name.clone(),
                    read_path: read_path.clone(),
                    entry_id: uuid::Uuid::new_v4().to_string(),
                });
            }
        }
        self.verify_sources(r)?;
        Ok(())
    }
    fn original_json(&self, r: &Record, name: &str) -> Result<Option<Value>> {
        let file = r
            .originals
            .iter()
            .find(|f| f.relative_name == name)
            .context("missing manifest role")?;
        match &file.original {
            Original::Absent => Ok(None),
            Original::Bytes {
                backup_id, sha256, ..
            } => {
                let bytes = read_bytes(
                    &self
                        .directory(&r.request_id)?
                        .join("backups")
                        .join(format!("{backup_id}.bytes")),
                )?
                .context("missing backup")?;
                ensure!(storage::digest(&bytes) == *sha256, "backup digest mismatch");
                Ok(Some(serde_json::from_slice(&bytes)?))
            }
        }
    }
    pub fn import_secret(&self, input: ImportSecret, connection: &str) -> Result<Value> {
        wire::request_id(&input.request_id)?;
        let mut r = self.read(&input.migration_id)?;
        if !self.guarded(&r, connection) {
            return Err(error(
                "sourceGuardRequired",
                "secret import requires the attached source connection",
            ));
        }
        let secret = r
            .secrets
            .iter()
            .find(|s| s.slot == input.slot && s.source_digest == input.source_digest)
            .ok_or_else(|| error("invalidRequest", "secret slot is not in source manifest"))?
            .clone();
        if let Some(receipt) = r
            .vault_receipts
            .iter()
            .find(|v| v.request_id == input.request_id)
        {
            if receipt.slot != input.slot || receipt.source_digest != input.source_digest {
                return Err(error(
                    "requestConflict",
                    "secret requestId already binds different parameters",
                ));
            }
        } else if self.operation(&input.request_id)?.is_some() {
            return Err(error(
                "requestConflict",
                "requestId already belongs to another import operation",
            ));
        }
        match &input.slot {
            vault::Slot::ProviderCredential { .. } => ensure!(
                input.value.as_str().is_some_and(|s| !s.is_empty()),
                "invalid provider secret payload"
            ),
            _ => ensure!(
                input.value.is_object(),
                "credential slot requires the complete object payload"
            ),
        }
        for receipt in r.vault_receipts.iter().filter(|v| v.slot == input.slot) {
            if let Some(value) = self.vault.read(&receipt.entry_id)? {
                if value != input.value {
                    return Err(error(
                        "migrationConflict",
                        "same source credential reference contains different values",
                    ));
                }
            }
        }
        let mut receipt = r
            .vault_receipts
            .iter()
            .find(|v| v.slot == input.slot && v.source_digest == input.source_digest)
            .cloned()
            .unwrap_or_else(|| vault::Receipt {
                request_id: input.request_id,
                slot: input.slot,
                revision: 1,
                entry_id: secret.entry_id,
                source_digest: input.source_digest,
                state: "acceptedPending".into(),
            });
        if !r
            .vault_receipts
            .iter()
            .any(|v| v.request_id == receipt.request_id)
        {
            r.vault_receipts.push(receipt.clone());
            self.save(&r)?;
        }
        self.vault.write(&receipt.entry_id, &input.value)?;
        receipt.state = "completed".into();
        *r.vault_receipts
            .iter_mut()
            .find(|v| v.request_id == receipt.request_id)
            .context("missing prepared vault receipt")? = receipt.clone();
        self.save(&r)?;
        Ok(serde_json::to_value(receipt)?)
    }
    fn legacy_locks(&self, r: &Record) -> Result<(Vec<File>, Vec<prior_boot::Adoption>)> {
        let mut locks = Vec::new();
        let mut adoptions = Vec::new();
        for binding in &r.bindings {
            let service_id =
                storage::digest(binding.data_dir.as_os_str().as_encoded_bytes())[..24].to_owned();
            let directory = storage::registry(&r.source.legacy_service_home, &service_id)?;
            let descriptor: Option<Service> = read_optional(&directory.join("service.json"))?;
            if !binding.data_dir.exists() {
                storage::private_dir(&binding.data_dir)?;
            }
            for name in ["service.lock", "owner.lock"] {
                let file = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create(true)
                    .truncate(false)
                    .mode(0o600)
                    .custom_flags(libc::O_NOFOLLOW)
                    .open(binding.data_dir.join(name))?;
                ensure!(
                    file.metadata()?.is_file()
                        && file.metadata()?.uid() == unsafe { libc::geteuid() },
                    "invalid Store lock"
                );
                file.try_lock_exclusive()
                    .context("legacy Store or service still owns its lock")?;
                locks.push(file);
            }
            let Some(service) = descriptor else {
                let never_started = std::fs::read_dir(&binding.data_dir)?.all(|entry| {
                    entry.ok().is_some_and(|entry| {
                        matches!(
                            entry.file_name().to_str(),
                            Some("service.lock" | "owner.lock")
                        )
                    })
                });
                ensure!(
                    never_started,
                    "existing Store has no original service descriptor; cleanup cannot be inferred"
                );
                continue;
            };
            ensure!(
                service.identity.service_id == service_id
                    && service.identity.data_dir == binding.data_dir
                    && service.identity.workspace == binding.workspace,
                "legacy service identity differs from source binding"
            );
            if let Some(areal_protocol::service::Owner::Gui { profile, .. }) = &service.owner {
                ensure!(
                    *profile == r.source.profile,
                    "legacy GUI owner profile differs from source"
                );
            }
            let mut confirmed = false;
            if let Some(proof) =
                read_optional::<storage::CleanupReceipt>(&directory.join("cleanup.json"))?
            {
                confirmed = proof.version == 1
                    && proof.identity == service.identity
                    && proof.owner == service.owner
                    && proof.cleanup_confirmed;
            }
            if let Some(proof) =
                read_optional::<storage::CrashReceipt>(&directory.join("crash.json"))?
            {
                confirmed |= proof.version == 1
                    && proof.identity == service.identity
                    && proof.owner == service.owner
                    && proof.cleanup_confirmed;
            }
            let operations = directory.join("operations");
            if operations.is_dir() {
                for entry in std::fs::read_dir(operations)? {
                    let receipt: storage::StopReceipt = storage::read(&entry?.path())?;
                    confirmed |= receipt.service.identity == service.identity
                        && receipt.service.owner == service.owner
                        && receipt.operation.version == 1
                        && receipt.operation.service_id == service_id
                        && receipt.operation.generation == service.identity.generation
                        && matches!(
                            receipt.operation.state,
                            StopOperationState::AcceptedPending | StopOperationState::Completed
                        )
                        && receipt.cleanup_confirmed;
                }
            }
            if !confirmed {
                adoptions.push(prior_boot::observe(&self.home,r,binding,&directory,&service).context("original owner has no exact completed Runtime cleanup proof or eligible prior-boot adoption")?);
            }
        }
        Ok((locks, adoptions))
    }
    fn check_remote(&self, r: &Record) -> Result<()> {
        let current = r
            .vault_receipts
            .iter()
            .find(|v| v.slot == vault::Slot::RemoteIdentity);
        let Some(current) = current else {
            return Ok(());
        };
        if crate::remote_state::RemoteState::selected_source(&self.home)?
            .is_some_and(|source| source != r.source_id)
        {
            return Err(error(
                "migrationConflict",
                "Remote configuration belongs to another source",
            ));
        }
        let value = self
            .vault
            .read(&current.entry_id)?
            .context("missing imported Remote vault entry")?;
        crate::remote_state::validate(
            &value,
            &r.bindings
                .iter()
                .map(|b| b.alias.legacy_project_id.clone())
                .collect::<Vec<_>>(),
        )?;
        for other in self
            .records()?
            .iter()
            .filter(|other| other.request_id != r.request_id)
        {
            if let Some(receipt) = other
                .vault_receipts
                .iter()
                .find(|v| v.slot == vault::Slot::RemoteIdentity)
            {
                let previous = self
                    .vault
                    .read(&receipt.entry_id)?
                    .context("missing existing Remote vault entry")?;
                if previous["identity"] != value["identity"] || other.source_id != r.source_id {
                    return Err(error(
                        "migrationConflict",
                        "Remote identity or authorization source differs from the selected source",
                    ));
                }
            }
        }
        Ok(())
    }
    pub(crate) fn subscription_retired(&self, source_id: &str, migration_id: &str) -> Result<()> {
        wire::request_id(source_id)?;
        let record = self.read(migration_id)?;
        ensure!(
            record.source_id == source_id && self.committed(&record)?.is_some(),
            error(
                "sourceNotFound",
                "subscription source does not match committed migration"
            )
        );
        ensure!(
            self.retirement_status(migration_id)?["state"] == "completed",
            error("legacyPending", "legacy source retirement is incomplete")
        );
        Ok(())
    }
    pub fn remote_projects(
        &self,
        source_id: &str,
        current: &[ProjectRegistration],
    ) -> Result<Vec<String>> {
        Ok(self
            .remote_bindings(source_id, current)?
            .into_iter()
            .map(|(_, alias)| alias)
            .collect())
    }
    pub(crate) fn remote_bindings(
        &self,
        source_id: &str,
        current: &[ProjectRegistration],
    ) -> Result<Vec<(String, String)>> {
        let mut selected = None;
        for record in self.records()? {
            if record.source_id == source_id && self.committed(&record)?.is_some() {
                selected = Some(record);
                break;
            }
        }
        let record =
            selected.ok_or_else(|| error("sourceNotFound", "Remote source is not published"))?;
        let mut bindings: Vec<(String, String)> = record
            .bindings
            .iter()
            .map(|binding| {
                (
                    binding.project_id.clone(),
                    binding.alias.legacy_project_id.clone(),
                )
            })
            .collect();
        for registration in current {
            if let ProjectSource::Gui {
                profile,
                legacy_project_id,
            } = &registration.source
            {
                if profile == &record.source.profile
                    && !bindings
                        .iter()
                        .any(|(id, _)| id == &registration.project_id)
                {
                    bindings.push((registration.project_id.clone(), legacy_project_id.clone()));
                }
            }
        }
        let mut aliases: Vec<String> = bindings.iter().map(|(_, alias)| alias.clone()).collect();
        for registration in current {
            if !bindings
                .iter()
                .any(|(id, _)| id == &registration.project_id)
            {
                let alias = storage::digest(format!("host:{}", registration.project_id).as_bytes())
                    [..24]
                    .to_owned();
                ensure!(!aliases.contains(&alias), "Host project alias collision");
                aliases.push(alias.clone());
                bindings.push((registration.project_id.clone(), alias));
            }
        }
        Ok(bindings)
    }
    pub(crate) fn journal_source(
        &self,
        source: &str,
        project: &str,
        alias: &str,
        current: &[ProjectRegistration],
    ) -> Result<JournalSource> {
        ensure!(
            self.remote_bindings(source, current)?
                .iter()
                .any(|binding| binding.0 == project && binding.1 == alias),
            "Remote journal source binding differs"
        );
        let registration = current
            .iter()
            .find(|p| p.project_id == project)
            .context("Remote journal project is unavailable")?;
        for record in self.records()? {
            if record.source_id != source || self.committed(&record)?.is_none() {
                continue;
            }
            if let Some(binding) = record.bindings.iter().find(|b| b.project_id == project) {
                ensure!(
                    binding.registration == *registration,
                    "imported journal project changed"
                );
            }
            return Ok(JournalSource {
                source_id: source.into(),
                migration_id: record.request_id,
                manifest_digest: record.manifest_digest,
                project_id: project.into(),
                data_dir: registration.data_dir.clone(),
            });
        }
        anyhow::bail!("Remote journal source is unavailable")
    }
    pub fn remote_seed(&self) -> Result<Option<(String, String, Vec<String>)>> {
        for r in self.records()? {
            if self.committed(&r)?.is_some() {
                if let Some(receipt) = r
                    .vault_receipts
                    .iter()
                    .find(|v| v.slot == vault::Slot::RemoteIdentity)
                {
                    return Ok(Some((
                        r.source_id,
                        receipt.entry_id.clone(),
                        r.bindings
                            .iter()
                            .map(|b| b.alias.legacy_project_id.clone())
                            .collect(),
                    )));
                }
            }
        }
        Ok(None)
    }
    pub fn vault_seed(&self, slot: &vault::Slot) -> Result<Option<vault::Receipt>> {
        let source = slot.source_id()?;
        for record in self.records()? {
            if record.source_id == source && self.committed(&record)?.is_some() {
                return Ok(record
                    .vault_receipts
                    .into_iter()
                    .find(|receipt| receipt.slot == *slot && receipt.state == "completed"));
            }
        }
        Err(error("sourceNotFound", "vault source is not published"))
    }
    pub fn scheduling_metadata(
        &self,
        project: &ProjectRegistration,
    ) -> Result<Option<(PathBuf, String)>> {
        let mut owner = None;
        for record in self.records()? {
            if self.committed(&record)?.is_none() {
                continue;
            }
            if let Some(binding) = record
                .bindings
                .iter()
                .find(|binding| binding.project_id == project.project_id)
            {
                owner = Some((
                    record.source.core_home,
                    binding.alias.legacy_project_id.clone(),
                ));
                break;
            }
            if let ProjectSource::Gui {
                profile,
                legacy_project_id,
            } = &project.source
            {
                if *profile == record.source.profile {
                    owner = Some((record.source.core_home, legacy_project_id.clone()));
                }
            }
        }
        ensure!(
            owner.is_some() || matches!(project.source, ProjectSource::Cli),
            error("migrationBlocked", "GUI scheduling source is not published")
        );
        Ok(owner)
    }
    pub fn assert_scheduling_available(&self, project: &ProjectRegistration) -> Result<()> {
        let Some((home, alias)) = self.scheduling_metadata(project)? else {
            return Ok(());
        };
        let directory = home.join("worktree-requests");
        if !directory.try_exists()? {
            return Ok(());
        }
        let metadata = std::fs::symlink_metadata(&directory)?;
        ensure!(
            metadata.is_dir()
                && !metadata.file_type().is_symlink()
                && metadata.uid() == unsafe { libc::geteuid() },
            "invalid worktree metadata directory"
        );
        for entry in std::fs::read_dir(directory)? {
            let path = entry?.path();
            if path.extension().is_none_or(|extension| extension != "json") {
                continue;
            }
            let value: Value = read_optional(&path)?.context("worktree metadata disappeared")?;
            let id = value["executionProjectId"].as_str();
            if id != Some(alias.as_str()) && id != Some(project.project_id.as_str()) {
                continue;
            }
            if value["deleted"] == true
                || matches!(
                    value["deletion"]["status"].as_str(),
                    Some("running" | "unknown")
                )
            {
                return Err(error(
                    "scheduleWorktreeUnavailable",
                    "scheduled worktree is deleted or deletion is unresolved",
                ));
            }
        }
        Ok(())
    }
    pub fn scheduling_suppressed(
        &self,
        imported: &BTreeSet<String>,
        current: &[ProjectRegistration],
    ) -> Result<Vec<SchedulingImport>> {
        let mut sources = Vec::new();
        for record in self.records()? {
            if imported.contains(&record.source_id) || self.committed(&record)?.is_none() {
                continue;
            }
            let mut source_projects = record
                .bindings
                .iter()
                .map(|binding| binding.project_id.clone())
                .collect::<BTreeSet<_>>();
            source_projects.extend(
                current
                    .iter()
                    .filter(|project| match &project.source {
                        ProjectSource::Gui { profile, .. } => *profile == record.source.profile,
                        _ => false,
                    })
                    .map(|project| project.project_id.clone()),
            );
            let suppressed = (|| -> Result<BTreeSet<String>> {
                let mut operations = Vec::new();
                let originals = record
                    .originals
                    .iter()
                    .filter(|file| file.role == "lifecycleOperation")
                    .collect::<Vec<_>>();
                if !originals.is_empty() {
                    for file in originals {
                        if let Some(value) = self.original_json(&record, &file.relative_name)? {
                            operations.push(value);
                        }
                    }
                } else {
                    // H2 已提交来源的旧 manifest 没有 lifecycle 角色，只读取一次现存的停止意图。
                    let directory = record.source.core_home.join("lifecycle-operations");
                    if directory.try_exists()? {
                        let metadata = std::fs::symlink_metadata(&directory)?;
                        ensure!(
                            metadata.is_dir()
                                && !metadata.file_type().is_symlink()
                                && metadata.uid() == unsafe { libc::geteuid() },
                            "invalid lifecycle directory"
                        );
                        for entry in std::fs::read_dir(directory)? {
                            let entry = entry?;
                            let name = entry.file_name();
                            let Some(name) = name.to_str() else {
                                return Err(error("invalidSource", "invalid lifecycle filename"));
                            };
                            if !name.ends_with(".json") {
                                continue;
                            }
                            wire::request_id(&name[..name.len() - 5])?;
                            if let Some(bytes) = read_bytes(&entry.path())? {
                                operations.push(serde_json::from_slice(&bytes)?);
                            }
                        }
                    }
                }
                let mut projects = BTreeSet::new();
                for operation in operations {
                    ensure!(
                        operation["version"] == 1,
                        "unsupported lifecycle operation version"
                    );
                    let targets = operation["targets"]
                        .as_array()
                        .context("invalid lifecycle targets")?;
                    for target in targets {
                        if target["scheduleActivationSuppressed"] != true {
                            continue;
                        }
                        let id = target["projectId"]
                            .as_str()
                            .context("invalid lifecycle project identity")?;
                        if let Some(binding) = record.bindings.iter().find(|binding| {
                            binding.alias.legacy_project_id == id || binding.project_id == id
                        }) {
                            projects.insert(binding.project_id.clone());
                            continue;
                        }
                        let project = current.iter().find(|project| match &project.source {
                            ProjectSource::Gui {
                                profile,
                                legacy_project_id,
                            } => {
                                *profile == record.source.profile
                                    && (legacy_project_id == id || project.project_id == id)
                            }
                            _ => false,
                        });
                        if let Some(project) = project {
                            projects.insert(project.project_id.clone());
                        }
                    }
                }
                Ok(projects)
            })();
            sources.push(SchedulingImport {
                source_id: record.source_id,
                projects: source_projects,
                suppressed,
            });
        }
        Ok(sources)
    }
    pub fn credential_source(&self, project: &ProjectRegistration) -> Result<Option<String>> {
        for r in self.records()? {
            if self.committed(&r)?.is_some()
                && r.bindings
                    .iter()
                    .any(|b| b.project_id == project.project_id)
            {
                return Ok(Some(r.source_id));
            }
        }
        if let ProjectSource::Gui { profile, .. } = &project.source {
            return Ok(Some(self.profile_source(profile)?.source_id));
        }
        Ok(None)
    }
    pub(crate) fn navigation_sources(
        &self,
        current: &[ProjectRegistration],
    ) -> Result<Vec<crate::shell::NavigationSource>> {
        use crate::shell::{NavigationBinding, NavigationSource};
        let mut sources = Vec::new();
        let mut profiles = BTreeSet::new();
        let mut homes = BTreeSet::new();
        let mut source_ids = BTreeSet::new();
        for record in self.records()? {
            if self.committed(&record)?.is_none() {
                continue;
            }
            ensure!(
                profiles.insert(record.source.profile.clone())
                    && homes.insert(record.source.core_home.clone())
                    && source_ids.insert(record.source_id.clone()),
                "sourceConflict: navigation source is ambiguous"
            );
            let mut bindings = Vec::new();
            let mut aliases = BTreeSet::new();
            for registration in current {
                let binding = record
                    .bindings
                    .iter()
                    .find(|binding| binding.project_id == registration.project_id);
                let own_alias = match &registration.source {
                    ProjectSource::Gui {
                        profile,
                        legacy_project_id,
                    } if profile == &record.source.profile => Some(legacy_project_id.clone()),
                    _ => None,
                };
                if let (Some(binding), Some(alias)) = (binding, own_alias.as_ref()) {
                    ensure!(
                        binding.alias.legacy_project_id == *alias,
                        "sourceConflict: navigation alias changed"
                    );
                }
                let alias = binding
                    .map(|binding| binding.alias.legacy_project_id.clone())
                    .or_else(|| own_alias.clone())
                    .unwrap_or_else(|| {
                        storage::digest(format!("host:{}", registration.project_id).as_bytes())
                            [..24]
                            .to_owned()
                    });
                ensure!(
                    aliases.insert(alias.clone()),
                    "sourceConflict: navigation alias collision"
                );
                let logical_project_id = binding.and_then(|binding| binding.logical_alias.as_ref())
                    .map(|logical| {
                        current.iter().find(|candidate| {
                            record.bindings.iter().any(|binding| {
                                binding.project_id == candidate.project_id
                                    && binding.alias.profile == logical.profile
                                    && binding.alias.legacy_project_id == logical.legacy_project_id
                            }) || matches!(&candidate.source, ProjectSource::Gui { profile, legacy_project_id }
                                if profile == &logical.profile && legacy_project_id == &logical.legacy_project_id)
                        }).map(|candidate| candidate.project_id.clone())
                            .context("sourceConflict: logical navigation project is not registered")
                    }).transpose()?;
                bindings.push(NavigationBinding {
                    project_id: registration.project_id.clone(),
                    alias,
                    owned: binding.is_some() || own_alias.is_some(),
                    logical_project_id,
                    projectless: binding
                        .is_some_and(|binding| binding.projectless_request_id.is_some()),
                });
            }
            sources.push(NavigationSource {
                source_id: record.source_id,
                core_home: record.source.core_home,
                bindings,
            });
        }
        sources.sort_by(|a, b| a.source_id.cmp(&b.source_id));
        Ok(sources)
    }
    pub fn power_sources(&self) -> Result<BTreeMap<String, PathBuf>> {
        let mut sources = BTreeMap::new();
        for record in self.records()? {
            if self.committed(&record)?.is_some() {
                sources.insert(record.source_id, record.source.core_home);
            }
        }
        Ok(sources)
    }
    pub(crate) fn navigation_source_id(&self, profile: &Path) -> Result<Option<String>> {
        let mut selected = None;
        for record in self.records()? {
            if record.source.profile == profile && self.committed(&record)?.is_some() {
                ensure!(
                    selected.is_none(),
                    "sourceConflict: GUI profile has multiple navigation sources"
                );
                selected = Some(record.source_id);
            }
        }
        Ok(selected)
    }
    pub(crate) fn local_relay_home(&self, source: &str) -> Result<Option<PathBuf>> {
        for record in self.records()? {
            if record.source_id != source || self.committed(&record)?.is_none() {
                continue;
            }
            let store = record.source.core_home.join("relay-service/local");
            if !store.exists() {
                if let Some(receipt) = record
                    .vault_receipts
                    .iter()
                    .find(|receipt| receipt.slot == vault::Slot::RemoteIdentity)
                {
                    let original = self
                        .vault
                        .read(&receipt.entry_id)?
                        .context("original Remote vault entry missing")?;
                    ensure!(
                        !original["relayLocal"].is_object()
                            && !original["relayProfiles"]
                                .as_array()
                                .is_some_and(|profiles| profiles
                                    .iter()
                                    .any(|profile| profile["kind"] == "local")),
                        "original local Relay store is missing"
                    );
                }
                return Ok(None);
            }
            ensure!(
                store.canonicalize()? == store,
                "legacy Relay store path changed"
            );
            let original = record
                .originals
                .iter()
                .find(|file| file.relative_name == "provider-credentials.json")
                .context("legacy Relay source fence missing")?;
            ensure!(
                read_bytes(&record.source.core_home.join("provider-credentials.json"))?.as_deref()
                    == Some(self.fence_bytes(&record, original)?.as_slice()),
                "legacy Relay source fence changed"
            );
            return Ok(Some(record.source.core_home));
        }
        Ok(None)
    }
    pub fn credential(
        &self,
        project: &ProjectRegistration,
        reference: &str,
    ) -> Result<Option<String>> {
        if !reference.starts_with("AREAL_CREDENTIAL_") {
            return Ok(None);
        }
        let Some(source_id) = self.credential_source(project)? else {
            return Ok(None);
        };
        if reference == "AREAL_CREDENTIAL_areal_openai" {
            let result = self.vault.dispatch(
                "vault.read",
                json!({"slot":vault::Slot::SubscriptionTransport {source_id},"interactionAllowed":false}),
                "",
                self,
            )?;
            return Ok(result["value"]["token"].as_str().map(str::to_owned));
        }
        let result = self.vault.dispatch("vault.read", json!({"slot":vault::Slot::ProviderCredential {source_id, reference:reference.to_owned()},"interactionAllowed":false}), "", self)?;
        Ok(result["value"].as_str().map(str::to_owned))
    }
}
fn legacy_id(id: &str) -> bool {
    id.len() == 24
        && id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
pub(crate) fn read_bytes(path: &Path) -> Result<Option<Vec<u8>>> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path);
    let mut file = match file {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && metadata.uid() == unsafe { libc::geteuid() },
        "source must be a regular file owned by current user"
    );
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(Some(bytes))
}
pub(crate) fn read_optional<T: DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    read_bytes(path)?
        .map(|bytes| serde_json::from_slice(&bytes).map_err(Into::into))
        .transpose()
}
pub(crate) fn atomic_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("missing parent")?;
    let temporary = parent.join(format!(".host-{}.tmp", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    std::fs::rename(temporary, path)?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        _root: tempfile::TempDir,
        migration: Migration,
        journal: crate::journal::Journal,
        source: Source,
        request: String,
        ids: Vec<String>,
        original: Vec<u8>,
    }
    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let base = root.path().canonicalize().unwrap();
            let home = base.join("host");
            storage::private_dir(&home).unwrap();
            storage::private_dir(&home.join("host")).unwrap();
            let core = base.join("core");
            storage::private_dir(&core).unwrap();
            let profile = base.join("profile");
            storage::private_dir(&profile).unwrap();
            let workspace = base.join("workspace");
            std::fs::create_dir(&workspace).unwrap();
            let ids = vec!["a".repeat(24), "b".repeat(24)];
            let source = Source {
                profile,
                core_home: core.clone(),
                legacy_service_home: base.join("legacy"),
            };
            storage::write(&core.join("projects.json"),&json!([{"id":ids[0],"root":workspace},{"id":ids[1],"root":workspace,"logicalProjectId":ids[0]}])).unwrap();
            let original=b"[ {\"requestId\":\"original-request\",\"method\":\"areal/thread/create\",\"params\":{\"future\":true},\"operation\":\"create\",\"createdAt\":1,\"creationAdmission\":{\"identity\":\"original\",\"journalEpoch\":\"old\"},\"remote\":{\"commandId\":\"unchanged\"}} ]\n".to_vec();
            std::fs::write(core.join(format!("{}-pending.json", ids[0])), &original).unwrap();
            let mut migration = Migration::new(&home).unwrap();
            migration.vault = vault::Vault::isolated_files(&home);
            let journal = crate::journal::Journal::new(&home).unwrap();
            Self {
                _root: root,
                migration,
                journal,
                source,
                request: uuid::Uuid::new_v4().to_string(),
                ids,
                original,
            }
        }
        fn import(&self) -> Result<Value> {
            self.migration.import(
                Import {
                    request_id: self.request.clone(),
                    expected_generation: "fixture".into(),
                    source: self.source.clone(),
                },
                "connection",
                &[],
                &self.journal,
            )
        }
        fn attach(&self) {
            self.migration
                .attach(self.source.clone(), "connection", None)
                .unwrap();
        }
    }
    #[test]
    fn local_relay_requires_committed_source_and_exact_current_fence() {
        let f = Fixture::new();
        storage::private_dir(&f.source.core_home.join("relay-service/local")).unwrap();
        f.import().unwrap();
        let source = f.migration.read(&f.request).unwrap().source_id;
        assert!(f.migration.local_relay_home(&source).unwrap().is_none());
        f.attach();
        assert_eq!(f.import().unwrap()["kind"], "ready");
        assert_eq!(
            f.migration.local_relay_home(&source).unwrap(),
            Some(f.source.core_home.clone())
        );
        let fence = std::fs::read(f.source.core_home.join("provider-credentials.json")).unwrap();
        assert!(serde_json::from_slice::<Value>(&fence).is_err());
        std::fs::write(
            f.source.core_home.join("provider-credentials.json"),
            b"AREAL_HOST_MIGRATED\n{}",
        )
        .unwrap();
        assert!(f.migration.local_relay_home(&source).is_err());
    }
    #[test]
    fn missing_original_local_store_is_not_recreated_from_current_configuration() {
        for (original, missing) in [
            (json!({"relayLocal":{"enabled":false}}), true),
            (json!({"relayProfiles":[{"kind":"local"}]}), true),
            (json!({"enabled":false}), false),
        ] {
            let f = Fixture::new();
            storage::write(
                &f.source.core_home.join("remote.json"),
                &json!({"encrypted":"fixture-only"}),
            )
            .unwrap();
            f.attach();
            assert_eq!(f.import().unwrap()["phase"], "secretsPending");
            let record = f.migration.read(&f.request).unwrap();
            let secret = record
                .secrets
                .iter()
                .find(|secret| secret.slot == vault::Slot::RemoteIdentity)
                .unwrap();
            f.migration
                .import_secret(
                    ImportSecret {
                        request_id: uuid::Uuid::new_v4().to_string(),
                        expected_generation: "fixture".into(),
                        migration_id: f.request.clone(),
                        slot: secret.slot.clone(),
                        source_digest: secret.source_digest.clone(),
                        value: original,
                    },
                    "connection",
                )
                .unwrap();
            assert_eq!(f.import().unwrap()["kind"], "ready");
            assert_eq!(
                f.migration.local_relay_home(&record.source_id).is_err(),
                missing
            );
            assert!(!f.source.core_home.join("relay-service/local").exists());
        }
    }
    #[test]
    fn legacy_schedule_stop_import_uses_preserved_manifest_and_project_aliases() {
        let f = Fixture::new();
        let directory = f.source.core_home.join("lifecycle-operations");
        storage::private_dir(&directory).unwrap();
        let path = directory.join(format!("{}.json", uuid::Uuid::new_v4()));
        storage::write(&path,&json!({"version":1,"kind":"stopProject","targets":[{"projectId":f.ids[0],"scheduleActivationSuppressed":true},{"projectId":f.ids[1],"scheduleActivationSuppressed":false}]})).unwrap();
        f.attach();
        assert_eq!(f.import().unwrap()["kind"], "ready");
        storage::write(&path, &json!({"version":1,"targets":[]})).unwrap();
        let sources = f
            .migration
            .scheduling_suppressed(&BTreeSet::new(), &[])
            .unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(
            *sources[0].suppressed.as_ref().unwrap(),
            BTreeSet::from([f.ids[0].clone()])
        );
        assert!(
            f.migration
                .scheduling_suppressed(&BTreeSet::from([sources[0].source_id.clone()]), &[])
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn existing_h2_source_reads_legacy_schedule_stop_before_one_time_source_marker() {
        let f = Fixture::new();
        f.attach();
        assert_eq!(f.import().unwrap()["kind"], "ready");
        let directory = f.source.core_home.join("lifecycle-operations");
        storage::private_dir(&directory).unwrap();
        let path = directory.join(format!("{}.json", uuid::Uuid::new_v4()));
        storage::write(&path,&json!({"version":1,"kind":"stopProject","targets":[{"projectId":f.ids[1],"scheduleActivationSuppressed":true}]})).unwrap();
        let sources = f
            .migration
            .scheduling_suppressed(&BTreeSet::new(), &[])
            .unwrap();
        assert_eq!(
            *sources[0].suppressed.as_ref().unwrap(),
            BTreeSet::from([f.ids[1].clone()])
        );
        assert!(
            f.migration
                .scheduling_suppressed(&BTreeSet::from([sources[0].source_id.clone()]), &[])
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn scheduling_guards_current_source_aliases_and_live_worktree_deletion_state() {
        let f = Fixture::new();
        f.attach();
        assert_eq!(f.import().unwrap()["kind"], "ready");
        let mut project = f.migration.published().unwrap()[0].clone();
        project.project_id = "new-host-project".into();
        project.source = ProjectSource::Gui {
            profile: f.source.profile.clone(),
            legacy_project_id: "c".repeat(24),
        };
        let directory = f.source.core_home.join("lifecycle-operations");
        storage::private_dir(&directory).unwrap();
        storage::write(&directory.join(format!("{}.json",uuid::Uuid::new_v4())),&json!({"version":1,"targets":[{"projectId":"c".repeat(24),"scheduleActivationSuppressed":true}]})).unwrap();
        let sources = f
            .migration
            .scheduling_suppressed(&BTreeSet::new(), std::slice::from_ref(&project))
            .unwrap();
        assert_eq!(
            *sources[0].suppressed.as_ref().unwrap(),
            BTreeSet::from([project.project_id.clone()])
        );
        let directory = f.source.core_home.join("worktree-requests");
        storage::private_dir(&directory).unwrap();
        let path = directory.join(format!("{}.json", uuid::Uuid::new_v4()));
        for value in [
            json!({"executionProjectId":"c".repeat(24),"deletion":{"status":"running"}}),
            json!({"executionProjectId":"c".repeat(24),"deletion":{"status":"unknown"}}),
            json!({"executionProjectId":"c".repeat(24),"deleted":true}),
        ] {
            storage::write(&path, &value).unwrap();
            assert_eq!(
                f.migration
                    .assert_scheduling_available(&project)
                    .unwrap_err()
                    .downcast_ref::<wire::Error>()
                    .unwrap()
                    .code,
                "scheduleWorktreeUnavailable"
            );
        }
        storage::write(
            &path,
            &json!({"executionProjectId":"c".repeat(24),"deletion":{"status":"failed"}}),
        )
        .unwrap();
        assert!(f.migration.assert_scheduling_available(&project).is_ok());
    }

    #[test]
    fn remote_scopes_include_new_gui_aliases_and_stable_other_project_aliases() {
        let f = Fixture::new();
        f.attach();
        assert_eq!(f.import().unwrap()["kind"], "ready");
        let view = f.migration.source(f.source.clone(), &[]).unwrap();
        let source_id = view["sourceId"].as_str().unwrap();
        let mut projects = f.migration.published().unwrap();
        let mut gui = projects[0].clone();
        gui.project_id = "ordinary-gui".into();
        gui.source = ProjectSource::Gui {
            profile: f.source.profile.clone(),
            legacy_project_id: "new-gui-alias".into(),
        };
        projects.push(gui);
        let mut cli = projects[0].clone();
        cli.project_id = "ordinary-cli".into();
        cli.source = ProjectSource::Cli;
        projects.push(cli);
        let aliases = f.migration.remote_projects(source_id, &projects).unwrap();
        assert!(aliases.contains(&"new-gui-alias".into()));
        assert!(aliases.contains(&storage::digest(b"host:ordinary-cli")[..24].to_owned()));
        assert!(!aliases.contains(&storage::digest(b"host:ordinary-gui")[..24].to_owned()));
        assert!(
            f.migration
                .remote_projects("unpublished-source", &projects)
                .is_err()
        );
        assert!(
            crate::remote_state::validate(
                &json!({"deviceGrants":[{"projectIds":["unknown-alias"]}]}),
                &aliases
            )
            .is_err()
        );
    }

    #[test]
    fn navigation_sources_require_committed_sources_and_current_registrations() {
        let f = Fixture::new();
        assert!(f.migration.navigation_sources(&[]).unwrap().is_empty());
        f.attach();
        assert_eq!(f.import().unwrap()["kind"], "ready");
        let mut current = f.migration.published().unwrap();
        current.push(ProjectRegistration {
            project_id: "cli-project".into(),
            workspace: f.source.core_home.join("cli"),
            data_dir: f.source.core_home.join("cli-state"),
            source: ProjectSource::Cli,
            default_binding: true,
        });
        let sources = f.migration.navigation_sources(&current).unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].core_home, f.source.core_home);
        assert_eq!(sources[0].bindings[0].alias, f.ids[0]);
        assert!(sources[0].bindings[0].owned);
        assert_eq!(
            sources[0].bindings[1].logical_project_id.as_deref(),
            Some(current[0].project_id.as_str())
        );
        assert!(!sources[0].bindings[2].owned);
        assert_eq!(
            sources[0].bindings[2].alias,
            storage::digest(b"host:cli-project")[..24]
        );
        assert!(
            f.migration.navigation_sources(&[]).unwrap()[0]
                .bindings
                .is_empty()
        );
        let mut collision = current[0].clone();
        collision.project_id = "another-canonical-project".into();
        current.push(collision);
        assert!(f.migration.navigation_sources(&current).is_err());
        current.pop();
        let mut duplicate = f.migration.read(&f.request).unwrap();
        duplicate.request_id = uuid::Uuid::new_v4().to_string();
        duplicate.source_id = "conflicting-source".into();
        storage::private_dir(&f.migration.directory(&duplicate.request_id).unwrap()).unwrap();
        f.migration.save(&duplicate).unwrap();
        storage::write(
            &f.migration
                .directory(&duplicate.request_id)
                .unwrap()
                .join("committed.json"),
            &Commit {
                bundle_digest: f.migration.bundle_digest(&duplicate).unwrap(),
                receipt: json!({}),
            },
        )
        .unwrap();
        assert!(f.migration.navigation_sources(&current).is_err());
    }
    #[test]
    fn source_lookup_is_exact_read_only_and_registration_requires_unique_profile() {
        let f = Fixture::new();
        let mut missing = f.source.clone();
        missing.core_home = missing.core_home.with_file_name("not-created");
        assert!(f.migration.source(missing.clone(), &[]).unwrap().is_null());
        assert!(!missing.core_home.exists());
        f.attach();
        assert_eq!(f.import().unwrap()["kind"], "ready");
        f.migration.disconnect("connection");
        let view = f.migration.source(f.source.clone(), &[]).unwrap();
        assert_eq!(view["migrationId"], f.request);
        let mut current = f.migration.published().unwrap();
        current[0].default_binding = !current[0].default_binding;
        let current_view = f.migration.source(f.source.clone(), &current).unwrap();
        assert_eq!(
            current_view["bindings"][0]["registration"],
            serde_json::to_value(&current[0]).unwrap()
        );
        assert_eq!(
            current_view["bindings"][0]["defaultBinding"],
            current[0].default_binding
        );
        for field in [
            "alias",
            "workspace",
            "dataDir",
            "scratchDir",
            "logicalAlias",
            "worktreeRequestId",
            "projectlessRequestId",
        ] {
            assert_eq!(
                current_view["bindings"][0][field],
                view["bindings"][0][field]
            );
        }
        let mut wrong_home = f.source.clone();
        wrong_home.legacy_service_home = wrong_home.legacy_service_home.join("different");
        assert!(f.migration.source(wrong_home, &[]).unwrap().is_null());

        let profile_alias = f.source.profile.with_file_name("profile-link");
        std::os::unix::fs::symlink(&f.source.profile, &profile_alias).unwrap();
        let new_alias = "c".repeat(24);
        let mut registration = ProjectRegistration {
            project_id: "ordinary-gui".into(),
            workspace: f.source.core_home.parent().unwrap().join("workspace"),
            data_dir: f.source.core_home.join(&new_alias).join("state"),
            source: ProjectSource::Gui {
                profile: profile_alias,
                legacy_project_id: new_alias.clone(),
            },
            default_binding: false,
        };
        f.migration
            .validate_registration(&mut registration, &[])
            .unwrap();
        assert_eq!(
            registration.source,
            ProjectSource::Gui {
                profile: f.source.profile.clone(),
                legacy_project_id: new_alias
            }
        );
        assert_eq!(
            f.migration.credential_source(&registration).unwrap(),
            Some(view["sourceId"].as_str().unwrap().to_owned())
        );

        let mut duplicate = f.migration.read(&f.request).unwrap();
        duplicate.request_id = uuid::Uuid::new_v4().to_string();
        duplicate.source.core_home = missing.core_home;
        duplicate.source_id = "another-source".into();
        duplicate.bindings.clear();
        storage::private_dir(&f.migration.directory(&duplicate.request_id).unwrap()).unwrap();
        f.migration.save(&duplicate).unwrap();
        storage::write(
            &f.migration
                .directory(&duplicate.request_id)
                .unwrap()
                .join("committed.json"),
            &Commit {
                bundle_digest: f.migration.bundle_digest(&duplicate).unwrap(),
                receipt: json!({}),
            },
        )
        .unwrap();
        assert!(
            f.migration
                .validate_registration(&mut registration, &[])
                .unwrap_err()
                .to_string()
                .contains("sourceConflict")
        );
        assert!(
            f.migration
                .source(f.source.clone(), std::slice::from_ref(&registration))
                .unwrap_err()
                .to_string()
                .contains("sourceConflict")
        );
        assert!(
            f.migration
                .credential_source(&registration)
                .unwrap_err()
                .to_string()
                .contains("sourceConflict")
        );
    }
    #[test]
    fn repeated_source_request_has_durable_operation_alias() {
        let f = Fixture::new();
        f.attach();
        f.import().unwrap();
        let alias = uuid::Uuid::new_v4().to_string();
        let result = f
            .migration
            .import(
                Import {
                    request_id: alias.clone(),
                    expected_generation: "fixture".into(),
                    source: f.source.clone(),
                },
                "connection",
                &[],
                &f.journal,
            )
            .unwrap();
        let restarted = Migration::new(&f.migration.home).unwrap();
        let receipt = restarted
            .operation(&alias)
            .unwrap()
            .expect("accepted alias must be queryable");
        assert_eq!(receipt["requestId"], alias);
        assert_eq!(receipt["state"], "completed");
        assert_eq!(receipt["result"], result);
        assert_eq!(
            crate::operation_offline(&f.migration.home, &alias).unwrap(),
            Some(receipt)
        );
    }

    #[test]
    fn pending_default_plan_rechecks_current_cli_binding_before_fence() {
        let f = Fixture::new();
        let workspace = f.source.core_home.parent().unwrap().join("workspace");
        storage::write(
            &f.source.core_home.join("projects.json"),
            &json!([{ "id":f.ids[0], "root":workspace }]),
        )
        .unwrap();
        storage::write(
            &f.source.core_home.join("provider-credentials.json"),
            &json!({"keys":{"AREAL_CREDENTIAL_key":"cipher"}}),
        )
        .unwrap();
        f.attach();
        f.import().unwrap();
        let r = f.migration.read(&f.request).unwrap();
        assert!(r.bindings[0].default_binding);
        let secret = &r.secrets[0];
        f.migration
            .import_secret(
                ImportSecret {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    expected_generation: "fixture".into(),
                    migration_id: f.request.clone(),
                    slot: secret.slot.clone(),
                    source_digest: secret.source_digest.clone(),
                    value: json!("dummy"),
                },
                "connection",
            )
            .unwrap();
        let cli = ProjectRegistration {
            project_id: "new-cli".into(),
            workspace,
            data_dir: f.migration.home.join("cli-store"),
            source: ProjectSource::Cli,
            default_binding: true,
        };
        let result = f.migration.import(
            Import {
                request_id: f.request.clone(),
                expected_generation: "fixture".into(),
                source: f.source.clone(),
            },
            "connection",
            &[cli],
            &f.journal,
        );
        assert!(
            result.is_err(),
            "stale default plan must fail before fencing"
        );
        assert!(
            !std::fs::read(f.source.core_home.join("provider-credentials.json"))
                .unwrap()
                .starts_with(FENCE.as_bytes())
        );
        assert!(f.migration.published().unwrap().is_empty());
    }

    #[test]
    fn writer_handoff_preserves_bytes_and_two_store_aliases() {
        let f = Fixture::new();
        let blocked = f.import().unwrap();
        assert_eq!(blocked["phase"], "awaitingSource");
        assert!(f.migration.published().unwrap().is_empty());
        f.attach();
        let result = f.import().unwrap();
        assert_eq!(result["kind"], "ready");
        let r = f.migration.read(&f.request).unwrap();
        assert_eq!(r.bindings.len(), 2);
        for (binding, id) in r.bindings.iter().zip(&f.ids) {
            assert_eq!(&binding.project_id, id);
            assert_eq!(binding.data_dir, f.source.core_home.join(id).join("state"));
            assert!(!binding.default_binding);
        }
        assert_eq!(
            r.bindings[1]
                .logical_alias
                .as_ref()
                .unwrap()
                .legacy_project_id,
            f.ids[0]
        );
        for name in [
            "provider-credentials.json".to_owned(),
            format!("{}-pending.json", f.ids[0]),
            format!("{}-outcomes.json", f.ids[0]),
            format!("{}-pending.json", f.ids[1]),
            format!("{}-outcomes.json", f.ids[1]),
        ] {
            assert!(
                std::fs::read(f.source.core_home.join(name))
                    .unwrap()
                    .starts_with(FENCE.as_bytes())
            );
        }
        let original = r
            .originals
            .iter()
            .find(|o| o.relative_name == format!("{}-pending.json", f.ids[0]))
            .unwrap();
        let Original::Bytes { backup_id, .. } = &original.original else {
            panic!("missing backup")
        };
        assert_eq!(
            std::fs::read(
                f.migration
                    .directory(&f.request)
                    .unwrap()
                    .join("backups")
                    .join(format!("{backup_id}.bytes"))
            )
            .unwrap(),
            f.original
        );
        assert_eq!(f.migration.published().unwrap().len(), 2);
        assert_eq!(f.import().unwrap(), result);
        let restarted = Migration::new(&f.migration.home).unwrap();
        assert_eq!(restarted.published().unwrap().len(), 2);
        assert_eq!(restarted.status(&f.request).unwrap(), result);
    }
    #[test]
    fn secrets_require_guard_and_durable_receipt_before_fence() {
        let f = Fixture::new();
        storage::write(&f.source.core_home.join("provider-credentials.json"),&json!({"keys":{"AREAL_CREDENTIAL_disabled":"dummy-ciphertext"},"migrated":["unchanged"]})).unwrap();
        f.attach();
        let pending = f.import().unwrap();
        assert_eq!(pending["phase"], "secretsPending");
        assert!(f.migration.published().unwrap().is_empty());
        let r = f.migration.read(&f.request).unwrap();
        let secret = r.secrets.first().unwrap();
        let request = uuid::Uuid::new_v4().to_string();
        let input = || ImportSecret {
            request_id: request.clone(),
            expected_generation: "fixture".into(),
            migration_id: f.request.clone(),
            slot: secret.slot.clone(),
            source_digest: secret.source_digest.clone(),
            value: json!("dummy-secret"),
        };
        f.migration.disconnect("connection");
        assert!(f.migration.import_secret(input(), "connection").is_err());
        f.attach();
        let receipt = f.migration.import_secret(input(), "connection").unwrap();
        assert_eq!(receipt["state"], "completed");
        assert!(
            !serde_json::to_string(&f.migration.read(&f.request).unwrap())
                .unwrap()
                .contains("dummy-secret")
        );
        assert_eq!(
            f.migration.import_secret(input(), "connection").unwrap(),
            receipt
        );
        assert_eq!(f.import().unwrap()["kind"], "ready");
        assert_eq!(
            f.migration
                .credential(
                    &f.migration.published().unwrap()[0],
                    "AREAL_CREDENTIAL_disabled"
                )
                .unwrap(),
            Some("dummy-secret".into())
        );
    }
    #[test]
    fn partial_fence_recovers_original_plan_and_absent_journals() {
        let f = Fixture::new();
        f.attach();
        let mut r = Record {
            request_id: f.request.clone(),
            request_aliases: Vec::new(),
            source_id: uuid::Uuid::new_v4().to_string(),
            source: f.source.clone(),
            phase: Phase::AwaitingSource,
            manifest_digest: String::new(),
            bindings: vec![],
            originals: vec![],
            secrets: vec![],
            vault_receipts: vec![],
            fences: vec![],
            blockers: vec![],
            prior_boot_adoptions: vec![],
        };
        let directory = f.migration.directory(&f.request).unwrap();
        storage::private_dir(&directory).unwrap();
        storage::private_dir(&directory.join("backups")).unwrap();
        f.migration.snapshot(&mut r, &[]).unwrap();
        r.phase = Phase::Fencing;
        f.migration.save(&r).unwrap();
        let original = r
            .originals
            .iter()
            .find(|o| o.relative_name == "provider-credentials.json")
            .unwrap();
        atomic_bytes(
            &f.source.core_home.join("provider-credentials.json"),
            &f.migration.fence_bytes(&r, original).unwrap(),
        )
        .unwrap();
        assert!(f.migration.published().unwrap().is_empty());
        assert_eq!(f.import().unwrap()["kind"], "ready");
        assert_eq!(f.migration.read(&f.request).unwrap().fences.len(), 5);
    }
    #[test]
    fn changed_source_after_disconnect_takes_new_snapshot_without_restoring_old_bytes() {
        let f = Fixture::new();
        storage::write(
            &f.source.core_home.join("provider-credentials.json"),
            &json!({"keys":{"AREAL_CREDENTIAL_key":"cipher"}}),
        )
        .unwrap();
        f.attach();
        f.import().unwrap();
        f.migration.disconnect("connection");
        let newer=b"[{\"requestId\":\"new-original\",\"method\":\"areal/thread/create\",\"params\":{},\"operation\":\"create\",\"createdAt\":2}]";
        std::fs::write(
            f.source
                .core_home
                .join(format!("{}-pending.json", f.ids[0])),
            newer,
        )
        .unwrap();
        f.attach();
        f.import().unwrap();
        let r = f.migration.read(&f.request).unwrap();
        assert_eq!(
            f.migration
                .original_json(&r, &format!("{}-pending.json", f.ids[0]))
                .unwrap()
                .unwrap()[0]["requestId"],
            "new-original"
        );
        assert_eq!(
            std::fs::read(
                f.source
                    .core_home
                    .join(format!("{}-pending.json", f.ids[0]))
            )
            .unwrap(),
            newer
        );
    }
    #[test]
    fn locks_and_missing_original_cleanup_proof_prevent_publication() {
        let f = Fixture::new();
        let data = f.source.core_home.join(&f.ids[0]).join("state");
        storage::private_dir(&data).unwrap();
        let lock = storage::open_private(&data.join("owner.lock"), true).unwrap();
        lock.try_lock_exclusive().unwrap();
        f.attach();
        assert_eq!(f.import().unwrap()["kind"], "legacyPending");
        assert!(
            !f.source
                .core_home
                .join("provider-credentials.json")
                .exists()
        );
        drop(lock);
        storage::write(
            &data.join("existing-thread.json"),
            &json!({"thread":{"cwd":"unknown"}}),
        )
        .unwrap();
        assert_eq!(f.import().unwrap()["kind"], "legacyPending");
        assert!(f.migration.published().unwrap().is_empty());
    }
    #[test]
    fn development_test_copy_cannot_attach_or_enter_migration() {
        let f = Fixture::new();
        storage::write(
            &f.source.core_home.join(".areal-test-copy.json"),
            &json!({"testCopy":true,"sourceDigest":"source-snapshot"}),
        )
        .unwrap();
        assert!(
            f.migration
                .attach(f.source.clone(), "connection", None)
                .unwrap_err()
                .to_string()
                .contains("development test copies")
        );
        assert!(f.import().is_err());
        assert!(f.migration.records().unwrap().is_empty());
        assert!(f.migration.published().unwrap().is_empty());
        assert!(
            !f.source
                .core_home
                .join("provider-credentials.json")
                .exists()
        );
        assert_eq!(
            std::fs::read(
                f.source
                    .core_home
                    .join(format!("{}-pending.json", f.ids[0]))
            )
            .unwrap(),
            f.original
        );
    }
    #[test]
    fn manifest_rejects_path_traversal_and_symlink_source_files() {
        let f = Fixture::new();
        storage::write(
            &f.source.core_home.join("projects.json"),
            &json!([{"id":"../../outside","root":f.source.profile}]),
        )
        .unwrap();
        f.attach();
        assert!(f.import().is_err());
        let f = Fixture::new();
        std::os::unix::fs::symlink(
            f.source.core_home.join("projects.json"),
            f.source.core_home.join("provider-credentials.json"),
        )
        .unwrap();
        f.attach();
        assert!(f.import().is_err());
    }
    #[test]
    fn source_guard_checks_peer_eof_before_fencing() {
        use std::os::fd::AsRawFd;
        let f = Fixture::new();
        let (host, client) = std::os::unix::net::UnixStream::pair().unwrap();
        f.migration
            .attach(f.source.clone(), "connection", Some(host.as_raw_fd()))
            .unwrap();
        drop(client);
        assert_eq!(f.import().unwrap()["phase"], "awaitingSource");
        assert!(
            !f.source
                .core_home
                .join("provider-credentials.json")
                .exists()
        );
    }

    #[test]
    fn lost_vault_receipt_is_recovered_from_the_stable_entry() {
        let f = Fixture::new();
        storage::write(
            &f.source.core_home.join("provider-credentials.json"),
            &json!({"keys":{"AREAL_CREDENTIAL_key":"dummy-cipher"}}),
        )
        .unwrap();
        f.attach();
        f.import().unwrap();
        let mut r = f.migration.read(&f.request).unwrap();
        let secret = r.secrets.first().unwrap().clone();
        let id = uuid::Uuid::new_v4().to_string();
        r.vault_receipts.push(vault::Receipt {
            request_id: id.clone(),
            slot: secret.slot,
            revision: 1,
            entry_id: secret.entry_id.clone(),
            source_digest: secret.source_digest,
            state: "acceptedPending".into(),
        });
        f.migration.save(&r).unwrap();
        f.migration
            .vault
            .write(&secret.entry_id, &json!("isolated-dummy"))
            .unwrap();
        let record_path = f
            .migration
            .directory(&f.request)
            .unwrap()
            .join("record.json");
        let before = std::fs::read(&record_path).unwrap();
        assert_eq!(
            crate::operation_offline(&f.migration.home, &id)
                .unwrap()
                .unwrap()["state"],
            "acceptedPending",
            "offline lookup must not inspect secure storage or promote a pending import secret"
        );
        assert_eq!(std::fs::read(&record_path).unwrap(), before);
        assert_eq!(
            f.migration.operation(&id).unwrap().unwrap()["state"],
            "completed"
        );
        assert_eq!(f.import().unwrap()["kind"], "ready");
    }

    #[test]
    fn published_vault_seed_never_resets_replacement_or_revocation() {
        let f = Fixture::new();
        storage::write(
            &f.source.core_home.join("provider-credentials.json"),
            &json!({"keys":{"AREAL_CREDENTIAL_key":"dummy-cipher"}}),
        )
        .unwrap();
        f.attach();
        f.import().unwrap();
        let record = f.migration.read(&f.request).unwrap();
        let slot = record.secrets[0].slot.clone();
        assert!(
            f.migration
                .vault
                .dispatch("vault.read", json!({"slot":slot}), "fixture", &f.migration)
                .unwrap_err()
                .to_string()
                .contains("sourceNotFound")
        );
        f.migration
            .import_secret(
                ImportSecret {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    expected_generation: "fixture".into(),
                    migration_id: f.request.clone(),
                    slot: slot.clone(),
                    source_digest: record.secrets[0].source_digest.clone(),
                    value: json!("imported-secret"),
                },
                "connection",
            )
            .unwrap();
        assert!(
            f.migration
                .vault
                .dispatch("vault.read", json!({"slot":slot}), "fixture", &f.migration)
                .is_err(),
            "secret receipt alone does not publish the source"
        );
        assert_eq!(f.import().unwrap()["kind"], "ready");
        assert_eq!(
            f.migration
                .vault
                .dispatch("vault.read", json!({"slot":slot}), "fixture", &f.migration)
                .unwrap(),
            json!({"revision":1,"value":"imported-secret"})
        );
        for (revision, value) in [(1, json!("replacement-secret")), (2, Value::Null)] {
            let receipt = f.migration.vault.dispatch("vault.replace",json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":"fixture","slot":slot,"expectedRevision":revision,"value":value}),"fixture",&f.migration).unwrap();
            assert_eq!(receipt["revision"], revision + 1);
        }
        let mut restarted = Migration::new(&f.migration.home).unwrap();
        restarted.vault = vault::Vault::isolated_files(&f.migration.home);
        assert_eq!(
            restarted
                .vault
                .dispatch("vault.read", json!({"slot":slot}), "fixture", &restarted)
                .unwrap(),
            json!({"revision":3,"value":null})
        );
        assert_eq!(
            restarted
                .credential(&f.migration.published().unwrap()[0], "AREAL_CREDENTIAL_key")
                .unwrap(),
            None
        );
        assert_eq!(
            restarted
                .credential(&f.migration.published().unwrap()[0], "OPENAI_API_KEY")
                .unwrap(),
            None
        );
        assert_eq!(
            restarted.vault.read(&record.secrets[0].entry_id).unwrap(),
            Some(json!("imported-secret")),
            "immutable import evidence remains separate from current revision"
        );
    }

    #[test]
    fn collision_rebinds_id_without_recomputing_store_or_alias() {
        let f = Fixture::new();
        f.attach();
        let other = ProjectRegistration {
            project_id: f.ids[0].clone(),
            workspace: f.source.profile.clone(),
            data_dir: f.migration.home.join("other-store"),
            source: ProjectSource::Cli,
            default_binding: true,
        };
        let result = f
            .migration
            .import(
                Import {
                    request_id: f.request.clone(),
                    expected_generation: "fixture".into(),
                    source: f.source.clone(),
                },
                "connection",
                &[other],
                &f.journal,
            )
            .unwrap();
        assert_eq!(result["kind"], "ready");
        let record = f.migration.read(&f.request).unwrap();
        assert_ne!(record.bindings[0].project_id, f.ids[0]);
        assert_eq!(record.bindings[0].alias.legacy_project_id, f.ids[0]);
        assert_eq!(
            record.bindings[0].data_dir,
            f.source.core_home.join(&f.ids[0]).join("state")
        );
        let committed = f
            .migration
            .directory(&f.request)
            .unwrap()
            .join("committed.json");
        let mut receipt: Commit = read_optional(&committed).unwrap().unwrap();
        receipt.bundle_digest = "tampered".into();
        storage::write(&committed, &receipt).unwrap();
        assert!(f.migration.published().is_err());
    }

    #[cfg(target_os = "macos")]
    fn prior_boot_fixture() -> (Fixture, Service, PathBuf) {
        let f = Fixture::new();
        f.attach();
        let data = f.source.core_home.join(&f.ids[0]).join("state");
        storage::private_dir(&data).unwrap();
        let service_id = storage::digest(data.as_os_str().as_encoded_bytes())[..24].to_owned();
        let directory = storage::registry(&f.source.legacy_service_home, &service_id).unwrap();
        storage::private_dir(&directory).unwrap();
        let service:Service = serde_json::from_value(json!({"protocolVersion":1,"serviceId":service_id,"generation":uuid::Uuid::new_v4().to_string(),"workspace":f.source.core_home.parent().unwrap().join("workspace"),"dataDir":data,"configFingerprint":"original","owner":{"kind":"gui","appRunId":uuid::Uuid::new_v4().to_string(),"profile":f.source.profile},"endpoint":"http://127.0.0.1:1","webUrl":"http://127.0.0.1:1","authFile":directory.join("auth.json"),"logFile":directory.join("host.log"),"hostPid":500000000,"corePid":500000001,"state":"unavailable"})).unwrap();
        storage::write(&directory.join("service.json"), &service).unwrap();
        (f, service, directory)
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn prior_boot_legacy_import_preserves_unknown_and_original_operation() {
        let (f, _service, directory) = prior_boot_fixture();
        let original_descriptor = std::fs::read(directory.join("service.json")).unwrap();
        assert_eq!(f.import().unwrap()["kind"], "legacyPending");
        prior_boot::with_test_boot(10, || {
            let result = f.import().unwrap();
            assert_eq!(result["kind"], "ready");
            assert_eq!(
                f.migration
                    .read(&f.request)
                    .unwrap()
                    .prior_boot_adoptions
                    .len(),
                1
            );
            assert_eq!(
                std::fs::read(directory.join("service.json")).unwrap(),
                original_descriptor
            );
            assert!(!directory.join("cleanup.json").exists());
            assert!(!directory.join("crash.json").exists());
            let restarted = Migration::new(&f.migration.home).unwrap();
            assert_eq!(restarted.published().unwrap().len(), 2);
            assert_eq!(restarted.status(&f.request).unwrap(), result);
            assert_eq!(f.import().unwrap(), result);
            let read = f
                .journal
                .dispatch("journal.read", json!({"projectId":f.ids[0]}), "verify")
                .unwrap();
            let snapshot: Value = serde_json::from_slice(
                &std::fs::read(read["snapshotPath"].as_str().unwrap()).unwrap(),
            )
            .unwrap();
            assert_eq!(read["revision"], 0);
            assert_eq!(
                snapshot["pending"],
                serde_json::from_slice::<Value>(&f.original).unwrap()
            );
            assert_eq!(snapshot["outcomes"], json!({}));
        });
    }
    #[test]
    fn legacy_commit_digest_retains_the_original_formula_without_adoption() {
        let f = Fixture::new();
        f.attach();
        let result = f.import().unwrap();
        assert_eq!(result["kind"], "ready");
        let record = f.migration.read(&f.request).unwrap();
        assert!(record.prior_boot_adoptions.is_empty());
        assert!(
            serde_json::to_value(&record)
                .unwrap()
                .get("priorBootAdoptions")
                .is_none()
        );
        let expected = storage::digest(&serde_json::to_vec(&json!({"source":record.source,"sourceId":record.source_id,"manifestDigest":record.manifest_digest,"bindings":record.bindings,"vaultReceipts":record.vault_receipts,"fences":record.fences})).unwrap());
        assert_eq!(f.migration.bundle_digest(&record).unwrap(), expected);
        assert_eq!(
            Migration::new(&f.migration.home)
                .unwrap()
                .status(&f.request)
                .unwrap(),
            result
        );
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn prior_boot_adoption_rejects_live_boundary_wrong_owner_and_other_store_mapping() {
        for case in [
            "current-boot",
            "invalid-time",
            "ready",
            "owner",
            "symlink",
            "service-lock",
            "owner-lock",
            "other-mapping",
        ] {
            let (f, mut service, directory) = prior_boot_fixture();
            assert_eq!(f.import().unwrap()["kind"], "legacyPending");
            let mut held = None;
            match case {
                "ready" => {
                    service.state = areal_protocol::service::State::Ready;
                    storage::write(&directory.join("service.json"), &service).unwrap();
                }
                "owner" => {
                    service.owner = Some(areal_protocol::service::Owner::Gui {
                        app_run_id: uuid::Uuid::new_v4().to_string(),
                        profile: f.source.profile.join("other"),
                    });
                    storage::write(&directory.join("service.json"), &service).unwrap();
                }
                "symlink" => {
                    let other = directory.join("other.json");
                    std::fs::copy(directory.join("service.json"), &other).unwrap();
                    std::fs::remove_file(directory.join("service.json")).unwrap();
                    std::os::unix::fs::symlink(other, directory.join("service.json")).unwrap();
                }
                "service-lock" | "owner-lock" => {
                    let path = service.identity.data_dir.join(if case == "service-lock" {
                        "service.lock"
                    } else {
                        "owner.lock"
                    });
                    let file = storage::open_private(&path, false).unwrap();
                    file.try_lock_exclusive().unwrap();
                    held = Some(file);
                }
                "other-mapping" => {
                    let other =
                        storage::registry(&f.migration.home, "cccccccccccccccccccccccc").unwrap();
                    storage::private_dir(&other).unwrap();
                    service.identity.service_id = "cccccccccccccccccccccccc".into();
                    service.identity.generation = uuid::Uuid::new_v4().to_string();
                    storage::write(&other.join("service.json"), &service).unwrap();
                }
                _ => {}
            }
            prior_boot::with_test_boot(
                if case == "current-boot" {
                    -10
                } else if case == "invalid-time" {
                    -2_000_000_000
                } else {
                    10
                },
                || {
                    assert_eq!(f.import().unwrap()["kind"], "legacyPending", "{case}");
                    assert!(f.migration.published().unwrap().is_empty(), "{case}");
                    assert!(
                        f.migration
                            .read(&f.request)
                            .unwrap()
                            .prior_boot_adoptions
                            .is_empty(),
                        "{case}"
                    );
                    assert_eq!(
                        std::fs::read(
                            f.source
                                .core_home
                                .join(format!("{}-pending.json", f.ids[0]))
                        )
                        .unwrap(),
                        f.original,
                        "{case}"
                    );
                },
            );
            drop(held);
        }
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn prior_boot_revalidation_rejects_replaced_descriptor_and_runtime_tree_writes() {
        for copy_descriptor in [true, false] {
            let (f, service, directory) = prior_boot_fixture();
            let runtime_file = service.identity.data_dir.join("owned-state.json");
            std::fs::write(&runtime_file, b"original").unwrap();
            assert_eq!(f.import().unwrap()["kind"], "legacyPending");
            let record = f.migration.read(&f.request).unwrap();
            let binding = record
                .bindings
                .iter()
                .find(|binding| binding.alias.legacy_project_id == f.ids[0])
                .unwrap();
            prior_boot::with_test_boot(1, || {
                let adoption =
                    prior_boot::observe(&f.migration.home, &record, binding, &directory, &service)
                        .unwrap();
                std::thread::sleep(std::time::Duration::from_millis(1100));
                if copy_descriptor {
                    let descriptor = directory.join("service.json");
                    let modified = std::fs::metadata(&descriptor).unwrap().modified().unwrap();
                    let replacement = directory.join("replacement.json");
                    std::fs::copy(&descriptor, &replacement).unwrap();
                    File::options()
                        .write(true)
                        .open(&replacement)
                        .unwrap()
                        .set_times(std::fs::FileTimes::new().set_modified(modified))
                        .unwrap();
                    std::fs::rename(replacement, descriptor).unwrap();
                } else {
                    std::fs::write(&runtime_file, b"changed").unwrap();
                }
                assert!(prior_boot::revalidate(&f.migration.home, &record, &adoption).is_err());
                assert_eq!(f.import().unwrap()["kind"], "legacyPending");
                assert!(f.migration.published().unwrap().is_empty());
            });
        }
    }
    #[test]
    #[ignore = "只读旧 GUI metadata；必须显式指定 home/migration/IDs，不启动服务或写真实记录"]
    #[cfg(target_os = "macos")]
    fn inspect_authorized_prior_boot_legacy_adoption() {
        let home = PathBuf::from(
            std::env::var("AREAL_TEST_PRIOR_BOOT_HOME").expect("explicit test home is required"),
        );
        assert!(home.is_absolute());
        assert_eq!(home.canonicalize().unwrap(), home);
        let migration_id = std::env::var("AREAL_TEST_PRIOR_BOOT_MIGRATION")
            .expect("explicit migration ID is required");
        wire::request_id(&migration_id).unwrap();
        let selected = std::env::var("AREAL_TEST_PRIOR_BOOT_PROJECTS")
            .expect("explicit legacy IDs are required")
            .split(',')
            .map(str::to_owned)
            .collect::<BTreeSet<_>>();
        assert!(!selected.is_empty() && selected.iter().all(|id| legacy_id(id)));
        let migration = Migration {
            home: home.clone(),
            guards: RefCell::new(BTreeMap::new()),
            vault: vault::Vault::new(&home),
        };
        let path = home
            .join("host/imports")
            .join(migration_id)
            .join("record.json");
        let original_record = std::fs::read(&path).unwrap();
        let mut record: Record = serde_json::from_slice(&original_record).unwrap();
        record
            .bindings
            .retain(|binding| selected.contains(&binding.alias.legacy_project_id));
        assert_eq!(record.bindings.len(), selected.len());
        let mut before = Vec::new();
        for binding in &record.bindings {
            for name in ["service.lock", "owner.lock"] {
                assert!(binding.data_dir.join(name).is_file());
            }
            before.push(prior_boot::test_tree_digest(&binding.data_dir).unwrap());
        }
        let (locks, adoptions) = migration.legacy_locks(&record).unwrap();
        assert_eq!(adoptions.len(), selected.len());
        for (binding, original) in record.bindings.iter().zip(before) {
            assert_eq!(
                prior_boot::test_tree_digest(&binding.data_dir).unwrap(),
                original
            );
        }
        for adoption in &adoptions {
            prior_boot::revalidate(&home, &record, adoption).unwrap();
            let value = serde_json::to_value(adoption).unwrap();
            println!(
                "{}",
                json!({"legacyProjectId":value["legacyProjectId"],"reason":value["reason"],"descriptorSha256":value["descriptorSha256"],"file":value["file"],"storeTree":value["storeTree"],"boot":value["boot"],"originalGeneration":value["service"]["generation"],"originalState":value["service"]["state"],"owner":value["service"]["owner"]})
            );
        }
        assert_eq!(std::fs::read(path).unwrap(), original_record);
        drop(locks);
    }
    #[test]
    fn legacy_stop_cleanup_receipt_uses_public_completion_semantics() {
        for case in [
            "pending-cleaned",
            "completed",
            "cleanup-missing",
            "owner-changed",
            "generation-changed",
            "unsupported-version",
            "admission-unknown",
            "service-locked",
            "store-locked",
        ] {
            let f = Fixture::new();
            f.attach();
            let data = f.source.core_home.join(&f.ids[0]).join("state");
            storage::private_dir(&data).unwrap();
            let service_id = storage::digest(data.as_os_str().as_encoded_bytes())[..24].to_owned();
            let directory = storage::registry(&f.source.legacy_service_home, &service_id).unwrap();
            storage::private_dir(&directory).unwrap();
            let service: Service = serde_json::from_value(json!({
                "protocolVersion":1,"serviceId":service_id,"generation":uuid::Uuid::new_v4().to_string(),
                "workspace":f.source.core_home.parent().unwrap().join("workspace"),"dataDir":data,
                "configFingerprint":"legacy-v1","owner":{"kind":"gui","appRunId":uuid::Uuid::new_v4().to_string(),"profile":f.source.profile},
                "endpoint":"http://127.0.0.1:1","webUrl":"http://127.0.0.1:1",
                "authFile":directory.join("auth.json"),"logFile":directory.join("host.log"),
                "hostPid":std::process::id(),"corePid":std::process::id(),"state":"stopped"
            })).unwrap();
            storage::write(&directory.join("service.json"), &service).unwrap();
            let mut receipt = storage::StopReceipt {
                operation: areal_protocol::service::StopOperation {
                    version: 1,
                    request_id: uuid::Uuid::new_v4().to_string(),
                    service_id,
                    generation: service.identity.generation.clone(),
                    cancel: true,
                    state: if case == "completed" {
                        StopOperationState::Completed
                    } else if case == "admission-unknown" {
                        StopOperationState::AdmissionUnknown
                    } else {
                        StopOperationState::AcceptedPending
                    },
                    message: None,
                    lifecycle: None,
                },
                service,
                cleanup_confirmed: case != "cleanup-missing",
            };
            if case == "owner-changed" {
                receipt.service.owner = None;
            }
            if case == "generation-changed" {
                receipt.operation.generation = uuid::Uuid::new_v4().to_string();
            }
            if case == "unsupported-version" {
                receipt.operation.version = 2;
            }
            storage::write_stop_receipt(&directory, &receipt).unwrap();
            let receipt_path =
                storage::stop_receipt_path(&directory, &receipt.operation.request_id).unwrap();
            let original = std::fs::read(&receipt_path).unwrap();
            let _lock = match case {
                "service-locked" | "store-locked" => {
                    let name = if case == "service-locked" {
                        "service.lock"
                    } else {
                        "owner.lock"
                    };
                    let lock = storage::open_private(&data.join(name), true).unwrap();
                    lock.try_lock_exclusive().unwrap();
                    Some(lock)
                }
                _ => None,
            };
            let expected = if matches!(case, "pending-cleaned" | "completed") {
                "ready"
            } else {
                "legacyPending"
            };
            assert_eq!(f.import().unwrap()["kind"], expected, "{case}");
            assert_eq!(std::fs::read(&receipt_path).unwrap(), original, "{case}");
        }
    }
    #[test]
    fn cleanup_proof_must_match_original_owner_and_generation() {
        let f = Fixture::new();
        f.attach();
        let data = f.source.core_home.join(&f.ids[0]).join("state");
        storage::private_dir(&data).unwrap();
        let service_id = storage::digest(data.as_os_str().as_encoded_bytes())[..24].to_owned();
        let directory = storage::registry(&f.source.legacy_service_home, &service_id).unwrap();
        storage::private_dir(&directory).unwrap();
        let owner = areal_protocol::service::Owner::Gui {
            app_run_id: uuid::Uuid::new_v4().to_string(),
            profile: f.source.profile.clone(),
        };
        let workspace = f.source.core_home.parent().unwrap().join("workspace");
        let service:Service=serde_json::from_value(json!({"protocolVersion":1,"serviceId":service_id,"generation":uuid::Uuid::new_v4().to_string(),"workspace":workspace,"dataDir":data,"configFingerprint":"fixture","owner":owner,"endpoint":"http://127.0.0.1:1","webUrl":"http://127.0.0.1:1","authFile":directory.join("auth.json"),"logFile":directory.join("host.log"),"hostPid":1,"corePid":1,"state":"stopped"})).unwrap();
        storage::write(&directory.join("service.json"), &service).unwrap();
        let mut proof = storage::CleanupReceipt {
            version: 1,
            identity: service.identity.clone(),
            owner: None,
            components: BTreeMap::new(),
            cleanup_confirmed: true,
        };
        storage::write(&directory.join("cleanup.json"), &proof).unwrap();
        assert_eq!(f.import().unwrap()["kind"], "legacyPending");
        proof.owner = service.owner.clone();
        proof.identity.generation = uuid::Uuid::new_v4().to_string();
        storage::write(&directory.join("cleanup.json"), &proof).unwrap();
        assert_eq!(f.import().unwrap()["kind"], "legacyPending");
        proof.identity = service.identity;
        storage::write(&directory.join("cleanup.json"), &proof).unwrap();
        assert_eq!(f.import().unwrap()["kind"], "ready");
    }
}
