use crate::wire::{error, request_id};
use anyhow::{Context, Result, ensure};
use areal_local_service::storage;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    version: u32,
    pending: Vec<Value>,
    outcomes: BTreeMap<String, Value>,
}

impl Snapshot {
    fn parse(value: Value) -> Result<Self> {
        let value: Self = serde_json::from_value(value)
            .map_err(|_| error("invalidJournal", "expected version, pending, and outcomes"))?;
        value.validate()?;
        Ok(value)
    }

    fn validate(&self) -> Result<()> {
        ensure!(self.version == 1, "unsupported journal version");
        for entry in &self.pending {
            ensure!(
                entry["method"].is_string() && entry["params"].is_object(),
                "invalid pending submission"
            );
        }
        ensure!(
            self.outcomes.values().all(Value::is_object),
            "invalid submission outcomes"
        );
        Ok(())
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Prepared {
    request_id: String,
    project_id: String,
    expected_revision: u64,
    sha256: String,
    byte_length: u64,
    slot_id: String,
    epoch: String,
    connection_id: String,
    write_path: PathBuf,
    receipt: Value,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    project_id: String,
    revision: u64,
    initial_digest: String,
    snapshot: Snapshot,
    last_operation: Option<Prepared>,
}

pub(crate) struct Journal {
    root: PathBuf,
    epoch: String,
    reads: RefCell<BTreeMap<String, Vec<PathBuf>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Prepare {
    request_id: String,
    expected_generation: String,
    project_id: String,
    expected_revision: u64,
    sha256: String,
    byte_length: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Commit {
    request_id: String,
    expected_generation: String,
    slot_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadRequest {
    project_id: String,
}

impl Journal {
    pub(crate) fn operation_offline(home: &Path, id: &str) -> Result<Option<Value>> {
        request_id(id)?;
        let journal = Self {
            root: home.join("host/journals"),
            epoch: String::new(),
            reads: RefCell::new(BTreeMap::new()),
        };
        let Some(operation) = journal.prepared(id)? else {
            let directory = journal.root.join("records");
            if directory.try_exists()? {
                for entry in std::fs::read_dir(directory)? {
                    let record: Record = read_large(&entry?.path())?;
                    if let Some(committed) =
                        record.last_operation.filter(|value| value.request_id == id)
                    {
                        return Ok(Some(committed.receipt));
                    }
                }
            }
            return Ok(None);
        };
        let record: Record = read_large(&journal.record_path(&operation.project_id)?)?;
        ensure!(
            record.project_id == operation.project_id,
            "journal project identity mismatch"
        );
        if let Some(committed) = record.last_operation.filter(|value| value.request_id == id) {
            return Ok(Some(committed.receipt));
        }
        Ok(Some(operation.receipt))
    }
    pub(crate) fn new(home: &Path) -> Result<Self> {
        let root = home.join("host/journals");
        for path in [
            &root,
            &root.join("records"),
            &root.join("operations"),
            &root.join("transfers"),
        ] {
            storage::private_dir(path)?;
            File::open(path.parent().context("journal directory parent")?)?.sync_all()?;
        }
        let journal = Self {
            root,
            epoch: uuid::Uuid::new_v4().to_string(),
            reads: RefCell::new(BTreeMap::new()),
        };
        for entry in std::fs::read_dir(journal.root.join("records"))? {
            let record: Record = read_large(&entry?.path())?;
            journal.recover(&record)?;
        }
        for entry in std::fs::read_dir(journal.root.join("operations"))? {
            let operation: Prepared = storage::read(&entry?.path())?;
            if operation.receipt["state"] == "prepared" {
                journal.expire(operation)?;
            }
        }
        Ok(journal)
    }

    pub(crate) fn initialize(&self, project_id: &str, snapshot: Value) -> Result<()> {
        let snapshot = Snapshot::parse(snapshot)?;
        let digest = storage::digest(&serde_json::to_vec(&snapshot)?);
        let path = self.record_path(project_id)?;
        if path.exists() {
            let record = self.load(project_id)?;
            ensure!(
                record.initial_digest == digest,
                "migrationConflict: imported journal differs from original snapshot"
            );
            return Ok(());
        }
        storage::write(
            &path,
            &Record {
                project_id: project_id.into(),
                revision: 0,
                initial_digest: digest,
                snapshot,
                last_operation: None,
            },
        )
    }

    fn ensure_empty(&self, project_id: &str) -> Result<()> {
        match std::fs::symlink_metadata(self.record_path(project_id)?) {
            Ok(_) => {
                self.load(project_id)?;
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.initialize(project_id, json!({"version":1,"pending":[],"outcomes":{}}))
            }
            Err(error) => Err(error.into()),
        }
    }

    pub(crate) fn native_snapshot(&self, project_id: &str) -> Result<(u64, Value)> {
        self.ensure_empty(project_id)?;
        let record = self.load(project_id)?;
        Ok((record.revision, serde_json::to_value(record.snapshot)?))
    }
    pub(crate) fn native_replace(
        &self,
        project_id: &str,
        expected_revision: u64,
        snapshot: Value,
    ) -> Result<()> {
        let mut record = self.load(project_id)?;
        ensure!(
            record.revision == expected_revision,
            error("revisionConflict", "journal revision changed")
        );
        let next = Snapshot::parse(snapshot)?;
        preserve_pending_identity(&record.snapshot, &next)?;
        record.snapshot = next;
        record.revision = record
            .revision
            .checked_add(1)
            .context("journal revision exhausted")?;
        storage::write(&self.record_path(project_id)?, &record)
    }

    pub(crate) fn dispatch(
        &self,
        method: &str,
        params: Value,
        connection_id: &str,
    ) -> Result<Value> {
        match method {
            "journal.read" => {
                let request: ReadRequest = serde_json::from_value(params)?;
                self.read(&request.project_id, connection_id)
            }
            "journal.prepare" => self.prepare(serde_json::from_value(params)?, connection_id),
            "journal.commit" => self.commit(serde_json::from_value(params)?, connection_id),
            _ => Err(error("methodNotFound", "unknown journal method")),
        }
    }

    pub(crate) fn operation(&self, id: &str) -> Result<Option<Value>> {
        request_id(id)?;
        let Some(operation) = self.prepared(id)? else {
            return Ok(None);
        };
        let record = self.load(&operation.project_id)?;
        self.recover(&record)?;
        Ok(self.prepared(id)?.map(|value| value.receipt))
    }

    pub(crate) fn project_for_slot(&self, id: &str, slot_id: &str) -> Result<Option<String>> {
        request_id(id)?;
        let Some(operation) = self.prepared(id)? else {
            return Ok(None);
        };
        if operation.slot_id != slot_id {
            return Err(error(
                "requestConflict",
                "journal slot differs from original operation",
            ));
        }
        Ok(Some(operation.project_id))
    }

    pub(crate) fn disconnect(&self, connection_id: &str) -> Result<()> {
        for entry in std::fs::read_dir(self.root.join("operations"))? {
            let operation: Prepared = storage::read(&entry?.path())?;
            if operation.epoch == self.epoch
                && operation.connection_id == connection_id
                && operation.receipt["state"] == "prepared"
            {
                let record = self.load(&operation.project_id)?;
                self.recover(&record)?;
                if let Some(current) = self.prepared(&operation.request_id)?
                    && current.receipt["state"] == "prepared"
                {
                    self.expire(current)?;
                }
            }
        }
        if let Some(paths) = self.reads.borrow_mut().remove(connection_id) {
            for path in paths {
                remove_transfer(&path)?;
            }
        }
        Ok(())
    }

    fn record_path(&self, project_id: &str) -> Result<PathBuf> {
        ensure!(
            !project_id.is_empty() && project_id.len() <= 256,
            "invalid projectId"
        );
        Ok(self
            .root
            .join("records")
            .join(format!("{}.json", storage::digest(project_id.as_bytes()))))
    }
    fn operation_path(&self, id: &str) -> PathBuf {
        self.root
            .join("operations")
            .join(format!("{}.json", storage::digest(id.as_bytes())))
    }
    fn prepared(&self, id: &str) -> Result<Option<Prepared>> {
        storage::read_optional(&self.operation_path(id))
    }
    fn load(&self, project_id: &str) -> Result<Record> {
        let record: Record = read_large(&self.record_path(project_id)?)?;
        ensure!(
            record.project_id == project_id,
            "journal project identity mismatch"
        );
        record.snapshot.validate()?;
        self.recover(&record)?;
        Ok(record)
    }
    fn recover(&self, record: &Record) -> Result<()> {
        if let Some(operation) = &record.last_operation {
            let current = self.prepared(&operation.request_id)?;
            if current.as_ref().map(|v| &v.receipt) != Some(&operation.receipt) {
                File::open(self.record_path(&record.project_id)?)?.sync_all()?;
                File::open(self.root.join("records"))?.sync_all()?;
                storage::write(&self.operation_path(&operation.request_id), operation)?;
            }
            File::open(self.operation_path(&operation.request_id))?.sync_all()?;
            File::open(self.root.join("operations"))?.sync_all()?;
        }
        Ok(())
    }
    fn transfer(&self, connection_id: &str, name: &str) -> Result<PathBuf> {
        let epoch = self.root.join("transfers").join(&self.epoch);
        storage::private_dir(&epoch)?;
        File::open(self.root.join("transfers"))?.sync_all()?;
        let directory = epoch.join(storage::digest(connection_id.as_bytes()));
        storage::private_dir(&directory)?;
        File::open(&epoch)?.sync_all()?;
        Ok(directory.join(name))
    }
    fn read(&self, project_id: &str, connection_id: &str) -> Result<Value> {
        self.ensure_empty(project_id)?;
        let record = self.load(project_id)?;
        let path = self.transfer(
            connection_id,
            &format!("read-{}.json", uuid::Uuid::new_v4()),
        )?;
        storage::write(&path, &record.snapshot)?;
        let bytes = std::fs::read(&path)?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o400))?;
        self.reads
            .borrow_mut()
            .entry(connection_id.into())
            .or_default()
            .push(path.clone());
        Ok(
            json!({"projectId":project_id,"revision":record.revision,"sha256":storage::digest(&bytes),"byteLength":bytes.len(),"snapshotPath":path}),
        )
    }
    fn prepare(&self, request: Prepare, connection_id: &str) -> Result<Value> {
        request_id(&request.request_id)?;
        ensure!(
            !request.expected_generation.is_empty(),
            "expectedGeneration required"
        );
        ensure!(
            request.sha256.len() == 64
                && request
                    .sha256
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                && request.byte_length > 0
                && request.byte_length < usize::MAX as u64,
            "invalid journal digest or length"
        );
        if let Some(old) = self.prepared(&request.request_id)? {
            if old.project_id != request.project_id
                || old.expected_revision != request.expected_revision
                || old.sha256 != request.sha256
                || old.byte_length != request.byte_length
            {
                return Err(error(
                    "requestConflict",
                    "journal requestId already has different inputs",
                ));
            }
            self.load(&request.project_id)?;
            return Ok(self
                .prepared(&request.request_id)?
                .context("original journal operation is missing")?
                .receipt);
        }
        self.ensure_empty(&request.project_id)?;
        let record = self.load(&request.project_id)?;
        let slot_id = uuid::Uuid::new_v4().to_string();
        let path = self.transfer(connection_id, &format!("{slot_id}.json"))?;
        let receipt = if record.revision == request.expected_revision {
            storage::open_private(&path, true)?.sync_all()?;
            File::open(path.parent().unwrap())?.sync_all()?;
            json!({"requestId":request.request_id,"projectId":request.project_id,"method":"journal.prepare","state":"prepared","slotId":slot_id,"writePath":path})
        } else {
            json!({"requestId":request.request_id,"projectId":request.project_id,"method":"journal.commit","state":"blocked","error":{"code":"revisionConflict","revision":record.revision}})
        };
        let operation = Prepared {
            request_id: request.request_id,
            project_id: request.project_id,
            expected_revision: request.expected_revision,
            sha256: request.sha256,
            byte_length: request.byte_length,
            slot_id,
            epoch: self.epoch.clone(),
            connection_id: connection_id.into(),
            write_path: path,
            receipt: receipt.clone(),
        };
        storage::write(&self.operation_path(&operation.request_id), &operation)?;
        Ok(receipt)
    }
    fn commit(&self, request: Commit, connection_id: &str) -> Result<Value> {
        request_id(&request.request_id)?;
        ensure!(
            !request.expected_generation.is_empty(),
            "expectedGeneration required"
        );
        let mut operation = self
            .prepared(&request.request_id)?
            .ok_or_else(|| error("slotNotFound", "journal slot does not exist"))?;
        if operation.slot_id != request.slot_id {
            return Err(error(
                "requestConflict",
                "journal slot differs from original operation",
            ));
        }
        let record = self.load(&operation.project_id)?;
        operation = self
            .prepared(&request.request_id)?
            .context("journal operation disappeared")?;
        if operation.receipt["state"] != "prepared" {
            return Ok(operation.receipt);
        }
        if operation.epoch != self.epoch || operation.connection_id != connection_id {
            return Err(error(
                "slotOwnerMismatch",
                "journal slot belongs to another connection",
            ));
        }
        if record.revision != operation.expected_revision {
            operation.receipt = json!({"requestId":operation.request_id,"projectId":operation.project_id,"method":"journal.commit","state":"blocked","error":{"code":"revisionConflict","revision":record.revision}});
            storage::write(&self.operation_path(&operation.request_id), &operation)?;
            remove_transfer(&operation.write_path)?;
            return Ok(operation.receipt);
        }
        let file = open_read(&operation.write_path)?;
        ensure!(
            file.metadata()?.len() == operation.byte_length,
            "journal slot length changed"
        );
        let mut bytes = Vec::new();
        file.take(operation.byte_length + 1)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 == operation.byte_length
                && storage::digest(&bytes) == operation.sha256,
            "journal slot digest changed"
        );
        let snapshot = Snapshot::parse(serde_json::from_slice(&bytes)?)?;
        preserve_pending_identity(&record.snapshot, &snapshot)?;
        let revision = record
            .revision
            .checked_add(1)
            .context("journal revision exhausted")?;
        operation.receipt = json!({"requestId":operation.request_id,"projectId":operation.project_id,"revision":revision,"sha256":operation.sha256,"method":"journal.commit","state":"completed"});
        let next = Record {
            revision,
            snapshot,
            last_operation: Some(operation.clone()),
            ..record
        };
        storage::write(&self.record_path(&operation.project_id)?, &next)?;
        storage::write(&self.operation_path(&operation.request_id), &operation)?;
        remove_transfer(&operation.write_path)?;
        Ok(operation.receipt)
    }
    fn expire(&self, mut operation: Prepared) -> Result<()> {
        operation.receipt = json!({"requestId":operation.request_id,"projectId":operation.project_id,"method":"journal.commit","state":"blocked","error":{"code":"slotExpired"}});
        storage::write(&self.operation_path(&operation.request_id), &operation)?;
        remove_transfer(&operation.write_path)
    }
}

fn preserve_pending_identity(before: &Snapshot, after: &Snapshot) -> Result<()> {
    fn key(entry: &Value) -> Option<&str> {
        if entry["method"] == "areal/interaction/respond" {
            entry["operationId"]
                .as_str()
                .or(entry["params"]["requestId"].as_str())
        } else {
            entry["params"]["requestId"]
                .as_str()
                .or(entry["operationId"].as_str())
        }
    }
    let identities: BTreeMap<_, _> = before
        .pending
        .iter()
        .filter_map(|entry| key(entry).map(|key| (key, entry)))
        .collect();
    for next in &after.pending {
        if let Some(previous) = key(next).and_then(|key| identities.get(key)) {
            ensure!(
                previous["method"] == next["method"]
                    && previous["params"] == next["params"]
                    && previous["operationId"] == next["operationId"]
                    && previous["operation"] == next["operation"]
                    && previous["remote"] == next["remote"],
                "journal pending request identity cannot change"
            );
        }
    }
    Ok(())
}
fn open_read(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file()
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.permissions().mode() & 0o077 == 0,
        "journal file must be private and owned by current UID"
    );
    Ok(file)
}
fn read_large<T: DeserializeOwned>(path: &Path) -> Result<T> {
    Ok(serde_json::from_reader(open_read(path)?)?)
}
fn remove_transfer(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn interaction_target_does_not_alias_command_identity() {
        let mut before = super::Snapshot {
            version: 1,
            pending: vec![serde_json::json!({
                "method":"areal/interaction/respond",
                "operationId":"first",
                "params":{"requestId":"interaction","decision":"allowOnce"},
                "remote":{"devicePeerId":"first"}
            })],
            outcomes: Default::default(),
        };
        let mut after = before.clone();
        let mut second = before.pending[0].clone();
        second["operationId"] = serde_json::json!("second");
        second["remote"]["devicePeerId"] = serde_json::json!("second");
        after.pending.push(second);
        assert!(super::preserve_pending_identity(&before, &after).is_ok());
        after.pending[0]["params"]["decision"] = serde_json::json!("deny");
        assert!(super::preserve_pending_identity(&before, &after).is_err());
        before.pending[0]["method"] = serde_json::json!("areal/turn/start");
        let mut ordinary = before.clone();
        ordinary.pending[0]["operationId"] = serde_json::json!("replacement");
        assert!(super::preserve_pending_identity(&before, &ordinary).is_err());
    }

    use super::*;

    fn snapshot(text: &str) -> Value {
        json!({"version":1,"pending":[{"method":"areal/thread/start","params":{"requestId":"original-core-id","input":[{"type":"text","text":text}]},"createdAt":"original-time","remote":{"opaque":"preserved"}}],"outcomes":{"old":{"accepted":true,"threadId":"old-thread"}}})
    }
    fn prepare(journal: &Journal, connection: &str, revision: u64, value: Value) -> Value {
        let bytes = serde_json::to_vec(&value).unwrap();
        let receipt = journal.dispatch("journal.prepare", json!({
            "requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":"generation",
            "projectId":"project","expectedRevision":revision,"sha256":storage::digest(&bytes),"byteLength":bytes.len()
        }), connection).unwrap();
        if receipt["state"] == "prepared" {
            std::fs::write(receipt["writePath"].as_str().unwrap(), &bytes).unwrap();
        }
        receipt
    }
    fn commit(journal: &Journal, connection: &str, prepared: &Value) -> Result<Value> {
        journal.dispatch("journal.commit", json!({
            "requestId":prepared["requestId"],"expectedGeneration":"generation","slotId":prepared["slotId"]
        }), connection)
    }
    fn read(journal: &Journal, connection: &str) -> (Value, Value) {
        let result = journal
            .dispatch("journal.read", json!({"projectId":"project"}), connection)
            .unwrap();
        let bytes = std::fs::read(result["snapshotPath"].as_str().unwrap()).unwrap();
        assert_eq!(storage::digest(&bytes), result["sha256"]);
        assert_eq!(bytes.len() as u64, result["byteLength"]);
        (result, serde_json::from_slice(&bytes).unwrap())
    }

    #[test]
    fn ensure_empty_allows_first_read_or_prepare_and_preserves_committed_record() {
        for read_first in [true, false] {
            let root = tempfile::tempdir().unwrap();
            let journal = Journal::new(root.path()).unwrap();
            journal.ensure_empty("project").unwrap();
            if read_first {
                let (descriptor, value) = read(&journal, "client");
                assert_eq!(descriptor["revision"], 0);
                assert_eq!(value, json!({"version":1,"pending":[],"outcomes":{}}));
            }
            let next = snapshot("first submission");
            let prepared = prepare(&journal, "client", 0, next.clone());
            assert_eq!(prepared["state"], "prepared");
            let operation_path = journal.operation_path(prepared["requestId"].as_str().unwrap());
            let operation_bytes = std::fs::read(&operation_path).unwrap();
            journal.ensure_empty("project").unwrap();
            assert_eq!(std::fs::read(&operation_path).unwrap(), operation_bytes);
            assert_eq!(
                commit(&journal, "client", &prepared).unwrap()["revision"],
                1
            );
            let path = journal.record_path("project").unwrap();
            let committed = std::fs::read(&path).unwrap();
            journal.ensure_empty("project").unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), committed);
            assert_eq!(read(&journal, "observer").1, next);
        }
    }

    #[test]
    fn ensure_empty_rejects_corrupt_foreign_and_untrusted_records_without_resetting() {
        let root = tempfile::tempdir().unwrap();
        let journal = Journal::new(root.path()).unwrap();
        let path = journal.record_path("project").unwrap();
        let invalid_snapshots = [
            json!({"version":2,"pending":[],"outcomes":{}}),
            json!({"version":1,"pending":[{"params":{}}],"outcomes":{}}),
            json!({"version":1,"pending":[],"outcomes":{"bad":false}}),
        ];
        let mut records = vec![b"{broken journal".to_vec()];
        records.push(
            serde_json::to_vec(&json!({
                "projectId":"foreign","revision":7,"initialDigest":"imported",
                "snapshot":{"version":1,"pending":[],"outcomes":{}},"lastOperation":null
            }))
            .unwrap(),
        );
        records.extend(invalid_snapshots.into_iter().map(|snapshot| {
            serde_json::to_vec(&json!({
                "projectId":"project","revision":7,"initialDigest":"imported",
                "snapshot":snapshot,"lastOperation":null
            }))
            .unwrap()
        }));
        for bytes in records {
            std::fs::write(&path, &bytes).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            assert!(journal.ensure_empty("project").is_err());
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
        std::fs::remove_file(&path).unwrap();
        let missing = root.path().join("missing-target");
        std::os::unix::fs::symlink(&missing, &path).unwrap();
        assert!(journal.ensure_empty("project").is_err());
        assert_eq!(std::fs::read_link(&path).unwrap(), missing);
        assert!(!missing.exists());
        std::fs::remove_file(&path).unwrap();
        journal.ensure_empty("project").unwrap();
        let bytes = std::fs::read(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(journal.ensure_empty("project").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }

    #[test]
    fn snapshot_larger_than_frame_preserves_original_pending_and_cas_updates() {
        let root = tempfile::tempdir().unwrap();
        let journal = Journal::new(root.path()).unwrap();
        let original = snapshot(&"x".repeat(2 * 1024 * 1024));
        journal.initialize("project", original.clone()).unwrap();
        let path = journal.record_path("project").unwrap();
        let imported = std::fs::read(&path).unwrap();
        journal.ensure_empty("project").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), imported);
        let (descriptor, initial) = read(&journal, "first");
        assert!(descriptor["byteLength"].as_u64().unwrap() > crate::wire::MAX_FRAME as u64);
        assert_eq!(initial, original);
        let mut next = original.clone();
        next["outcomes"]["new"] = json!({"accepted":true,"threadId":"new-thread"});
        let first = prepare(&journal, "first", 0, next.clone());
        let second = prepare(&journal, "second", 0, original.clone());
        let done = commit(&journal, "first", &first).unwrap();
        assert_eq!(done["state"], "completed");
        assert_eq!(done["revision"], 1);
        let committed = std::fs::read(&path).unwrap();
        journal.ensure_empty("project").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), committed);
        assert_eq!(
            commit(&journal, "second", &second).unwrap()["error"]["code"],
            "revisionConflict"
        );
        assert_eq!(commit(&journal, "first", &first).unwrap(), done);
        assert_eq!(
            journal
                .operation(first["requestId"].as_str().unwrap())
                .unwrap(),
            Some(done)
        );
        assert_eq!(read(&journal, "second").1, next);
        journal.initialize("project", original).unwrap();
        assert_eq!(read(&journal, "second").0["revision"], 1);
        assert!(
            journal
                .initialize("project", snapshot("different import"))
                .is_err()
        );
        journal.disconnect("first").unwrap();
        journal.disconnect("second").unwrap();
        assert!(!Path::new(descriptor["snapshotPath"].as_str().unwrap()).exists());
    }

    #[test]
    fn committed_record_recovers_lost_receipt_before_next_write_and_expires_uncommitted_slots() {
        let root = tempfile::tempdir().unwrap();
        let journal = Journal::new(root.path()).unwrap();
        journal.initialize("project", snapshot("original")).unwrap();
        let mut changed = snapshot("original");
        changed["outcomes"]["added"] = json!({"accepted":true});
        let prepared = prepare(&journal, "client", 0, changed.clone());
        let unused = prepare(&journal, "other", 0, snapshot("original"));
        let receipt = commit(&journal, "client", &prepared).unwrap();
        let request = prepared["requestId"].as_str().unwrap();
        std::fs::remove_file(journal.operation_path(request)).unwrap();
        assert_eq!(
            crate::operation_offline(root.path(), request).unwrap(),
            Some(receipt.clone())
        );
        assert!(
            !journal.operation_path(request).exists(),
            "offline lookup must not repair receipt files"
        );
        assert_eq!(
            crate::operation_offline(root.path(), unused["requestId"].as_str().unwrap())
                .unwrap()
                .unwrap()["state"],
            "prepared",
            "offline lookup cannot expire a connection-owned slot"
        );
        journal.ensure_empty("project").unwrap();
        assert_eq!(journal.operation(request).unwrap(), Some(receipt.clone()));
        assert_eq!(
            journal
                .operation(unused["requestId"].as_str().unwrap())
                .unwrap()
                .unwrap()["state"],
            "prepared"
        );
        drop(journal);
        let restarted = Journal::new(root.path()).unwrap();
        assert_eq!(restarted.operation(request).unwrap(), Some(receipt));
        assert_eq!(read(&restarted, "reconnected").1, changed);
        assert_eq!(
            restarted
                .operation(unused["requestId"].as_str().unwrap())
                .unwrap()
                .unwrap()["error"]["code"],
            "slotExpired"
        );
        let next = prepare(&restarted, "reconnected", 1, snapshot("original"));
        assert_eq!(
            commit(&restarted, "reconnected", &next).unwrap()["revision"],
            2
        );
        assert_eq!(
            restarted.operation(request).unwrap().unwrap()["revision"],
            1
        );
    }

    #[test]
    fn changed_identity_foreign_connection_and_untrusted_transfer_cannot_commit() {
        let root = tempfile::tempdir().unwrap();
        let journal = Journal::new(root.path()).unwrap();
        journal.initialize("project", snapshot("original")).unwrap();
        let changed = prepare(&journal, "owner", 0, snapshot("changed original request"));
        assert!(
            commit(&journal, "owner", &changed)
                .unwrap_err()
                .to_string()
                .contains("identity")
        );
        let valid = prepare(&journal, "owner", 0, snapshot("original"));
        assert!(
            commit(&journal, "other", &valid)
                .unwrap_err()
                .to_string()
                .contains("slotOwnerMismatch")
        );
        let path = Path::new(valid["writePath"].as_str().unwrap());
        let target = root.path().join("external");
        std::fs::write(&target, serde_json::to_vec(&snapshot("original")).unwrap()).unwrap();
        std::fs::remove_file(path).unwrap();
        std::os::unix::fs::symlink(&target, path).unwrap();
        assert!(commit(&journal, "owner", &valid).is_err());
        assert_eq!(read(&journal, "observer").0["revision"], 0);
        journal.disconnect("owner").unwrap();
        assert!(target.exists());
        assert_eq!(
            journal
                .operation(valid["requestId"].as_str().unwrap())
                .unwrap()
                .unwrap()["error"]["code"],
            "slotExpired"
        );
    }
}
