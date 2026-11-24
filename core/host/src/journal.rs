use crate::wire::{error, request_id};
use anyhow::{Context, Result, ensure};
use areal_local_service::storage;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::{BufReader, Read},
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

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    project_id: String,
    revision: u64,
    initial_digest: String,
    snapshot: Snapshot,
    last_operation: Option<Prepared>,
    /// 每条已结算回执首次落盘的 Unix 秒；只供回收排序，不随快照返回给客户端。
    #[serde(default)]
    settled_at: BTreeMap<String, u64>,
}

/// 单个日志范围内待决与已结算记录的硬上限；回收保证正常使用不会触达。
pub(crate) const CAPACITY: usize = 4096;
/// 超过软阈值时回收最旧的已结算回执，降到目标值为止。
const RECLAIM_THRESHOLD: usize = 3072;
const RECLAIM_TARGET: usize = 2048;
/// 单条回执体积较大（如 library.command 内嵌完整项目库快照）时，仅按条数回收会让单文件
/// 膨胀到十余 MB 并阻塞单线程 Host 主循环；超过字节软预算时同样回收已满保留期的最旧回执。
const RECLAIM_BYTES_THRESHOLD: usize = 1024 * 1024;
const RECLAIM_BYTES_TARGET: usize = 512 * 1024;
/// 结算后至少保留一天，保证同一 commandId 的重试仍得到原回执而不是被当成新命令。
const RECLAIM_MIN_AGE_SECS: u64 = storage::SETTLED_RECEIPT_RETENTION.as_secs();

struct ByteCounter(usize);

impl std::io::Write for ByteCounter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0 = self.0.saturating_add(buf.len());
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn outcome_entry_bytes(id: &str, value: &Value) -> usize {
    let mut counter = ByteCounter(id.len().saturating_add(6));
    let _ = serde_json::to_writer(&mut counter, value);
    counter.0
}

pub(crate) fn has_capacity(snapshot: &Value) -> bool {
    snapshot["pending"].as_array().map_or(0, Vec::len)
        + snapshot["outcomes"]
            .as_object()
            .map_or(0, |rows| rows.len())
        < CAPACITY
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

/// 这些回执是长期授权事实而不只是去重记录，删除会改变行为，永不回收。
fn retained_forever(outcome: &Value) -> bool {
    let remote = &outcome["remote"];
    remote["method"] == "session.control" && remote["target"]["operation"] == "goalCreate"
}

/// 旧版 JS 远程网关写下的远程行没有 nativeDigest 与 coreScope。升级不迁移在途工作，
/// 这些行在新版没有任何读者；目标创建回执是长期授权事实，仍然保留。
fn legacy_remote(record: &Value) -> bool {
    matches!(
        record["remote"]["method"].as_str(),
        Some("session.send" | "session.control" | "task.pause" | "task.question.reply")
    ) && record.get("nativeDigest").is_none()
        && record.get("coreScope").is_none()
}

fn drop_legacy_remote(snapshot: &mut Snapshot) {
    snapshot.pending.retain(|entry| !legacy_remote(entry));
    snapshot
        .outcomes
        .retain(|_, outcome| !legacy_remote(outcome) || retained_forever(outcome));
}

/// 记录新结算回执的时间，并在超过条数或字节软阈值时按结算时间从旧到新回收。
/// 仍被待决行引用、未满最短保留时间或长期授权类的回执不回收。
fn reclaim(record: &mut Record, now: u64) {
    let outcomes = &mut record.snapshot.outcomes;
    record.settled_at.retain(|id, _| outcomes.contains_key(id));
    for id in outcomes.keys() {
        record.settled_at.entry(id.clone()).or_insert(now);
    }
    let pending = &record.snapshot.pending;
    let total = pending.len() + outcomes.len();
    let entry_bytes: BTreeMap<String, usize> = outcomes
        .iter()
        .map(|(id, value)| (id.clone(), outcome_entry_bytes(id, value)))
        .collect();
    let total_bytes: usize = entry_bytes.values().copied().sum();
    let count_exceeded = total > RECLAIM_THRESHOLD;
    let bytes_exceeded = total_bytes > RECLAIM_BYTES_THRESHOLD;
    if !count_exceeded && !bytes_exceeded {
        return;
    }
    let referenced: std::collections::BTreeSet<&str> =
        pending.iter().filter_map(submission_id).collect();
    let mut candidates: Vec<(u64, String, usize)> = record
        .settled_at
        .iter()
        .filter(|(id, at)| {
            now.saturating_sub(**at) >= RECLAIM_MIN_AGE_SECS
                && !referenced.contains(id.as_str())
                && !outcomes.get(*id).is_some_and(retained_forever)
        })
        .map(|(id, at)| (*at, id.clone(), entry_bytes.get(id).copied().unwrap_or(0)))
        .collect();
    candidates.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    let mut remaining_count = total;
    let mut remaining_bytes = total_bytes;
    for (_, id, bytes) in candidates {
        let count_done = !count_exceeded || remaining_count <= RECLAIM_TARGET;
        let bytes_done = !bytes_exceeded || remaining_bytes <= RECLAIM_BYTES_TARGET;
        if count_done && bytes_done {
            break;
        }
        if outcomes.remove(&id).is_some() {
            record.settled_at.remove(&id);
            remaining_count = remaining_count.saturating_sub(1);
            remaining_bytes = remaining_bytes.saturating_sub(bytes);
        }
    }
}

#[cfg(test)]
thread_local! {
    /// 测试注入：项目记录写入失败，替代改目录权限（root 下改权限不生效）。
    pub(crate) static FAIL_RECORD_WRITES: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn write_record_with_stamp<T: Serialize>(path: &Path, value: &T) -> Result<Option<RecordStamp>> {
    #[cfg(test)]
    if FAIL_RECORD_WRITES.with(std::cell::Cell::get) {
        return Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied).into());
    }
    let metadata = storage::write_returning_metadata(path, value)?;
    Ok(metadata
        .as_ref()
        .and_then(|meta| record_stamp_metadata(meta).ok()))
}

type RecordStamp = [u64; 9];
fn record_stamp_metadata(metadata: &std::fs::Metadata) -> Result<RecordStamp> {
    ensure!(
        metadata.is_file()
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.permissions().mode() & 0o077 == 0,
        "journal file must be private and owned by current UID"
    );
    Ok([
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        metadata.mtime() as u64,
        metadata.mtime_nsec() as u64,
        metadata.ctime() as u64,
        metadata.ctime_nsec() as u64,
        metadata.mode() as u64,
        metadata.uid() as u64,
    ])
}
fn record_stamp(path: &Path) -> Result<RecordStamp> {
    record_stamp_metadata(&std::fs::symlink_metadata(path)?)
}

pub(crate) struct Journal {
    root: PathBuf,
    epoch: String,
    reads: RefCell<BTreeMap<String, Vec<PathBuf>>>,
    records: RefCell<BTreeMap<String, (RecordStamp, Record)>>,
    /// 只读诊断投影缓存（供 pending_read 复用）；不触发恢复或旧行清理，与 records 独立失效。
    pending_cache: RefCell<BTreeMap<String, (RecordStamp, Vec<Value>)>>,
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

fn submission_id(entry: &Value) -> Option<&str> {
    entry["operationId"]
        .as_str()
        .or_else(|| entry["params"]["requestId"].as_str())
}

impl Journal {
    pub(crate) fn operation_offline(home: &Path, id: &str) -> Result<Option<Value>> {
        request_id(id)?;
        let journal = Self {
            root: home.join("host/journals"),
            epoch: String::new(),
            reads: RefCell::new(BTreeMap::new()),
            records: RefCell::new(BTreeMap::new()),
            pending_cache: RefCell::new(BTreeMap::new()),
        };
        let Some(operation) = journal.prepared(id)? else {
            let directory = journal.root.join("records");
            for path in storage::json_records(&directory, false)? {
                let record: Record = read_large(&path)?;
                if let Some(committed) =
                    record.last_operation.filter(|value| value.request_id == id)
                {
                    return Ok(Some(committed.receipt));
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
            records: RefCell::new(BTreeMap::new()),
            pending_cache: RefCell::new(BTreeMap::new()),
        };
        for path in storage::json_records(&journal.root.join("records"), true)? {
            let record: Record = read_large(&path)?;
            journal.recover(&record)?;
        }
        for path in storage::json_records(&journal.root.join("operations"), true)? {
            let operation: Prepared = storage::read(&path)?;
            if operation.receipt["state"] == "prepared" {
                journal.expire(operation)?;
            } else if storage::past_retention(&path)? {
                std::fs::remove_file(&path)?;
            }
        }
        Ok(journal)
    }

    /// 停机导入：只带入已结算回执。旧版待决行属于在途工作，不迁移。
    pub(crate) fn import(&self, project_id: &str, outcomes: Value) -> Result<()> {
        let mut snapshot = Snapshot::parse(json!({"version":1,"pending":[],"outcomes":outcomes}))?;
        drop_legacy_remote(&mut snapshot);
        self.initialize(project_id, serde_json::to_value(&snapshot)?)
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
        self.store_record_cold(
            &path,
            &Record {
                project_id: project_id.into(),
                revision: 0,
                initial_digest: digest,
                snapshot,
                last_operation: None,
                settled_at: BTreeMap::new(),
            },
        )
    }

    fn ensure_empty(&self, project_id: &str) -> Result<()> {
        match std::fs::symlink_metadata(self.record_path(project_id)?) {
            Ok(_) => self.with_record(project_id, |_| ()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.initialize(project_id, json!({"version":1,"pending":[],"outcomes":{}}))
            }
            Err(error) => Err(error.into()),
        }
    }

    pub(crate) fn native_snapshot(&self, project_id: &str) -> Result<(u64, Value)> {
        self.ensure_empty(project_id)?;
        self.with_record(project_id, |record| {
            Ok((record.revision, serde_json::to_value(&record.snapshot)?))
        })?
    }

    pub(crate) fn native_receipt(&self, project: &str, command: &str) -> Result<Option<Value>> {
        self.ensure_empty(project)?;
        self.with_record(project, |record| {
            record.snapshot.outcomes.get(command).cloned().or_else(|| {
                record
                    .snapshot
                    .pending
                    .iter()
                    .find(|row| row["requestId"] == command)
                    .map(|row| row["result"].clone())
            })
        })
    }
    pub(crate) fn pending_read(&self, project_id: &str) -> Result<Vec<Value>> {
        let path = self.record_path(project_id)?;
        let metadata = match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.pending_cache.borrow_mut().remove(project_id);
                return Ok(Vec::new());
            }
            other => other?,
        };
        let stamp = record_stamp_metadata(&metadata)?;
        if let Some((cached_stamp, pending)) = self.pending_cache.borrow().get(project_id)
            && *cached_stamp == stamp
        {
            return Ok(pending.clone());
        }
        self.pending_cache.borrow_mut().remove(project_id);
        let (opened_stamp, record): (RecordStamp, Record) = read_large_with_stamp(&path)?;
        ensure!(
            record.project_id == project_id,
            "journal project identity mismatch"
        );
        record.snapshot.validate()?;
        let pending: Vec<Value> = record
            .snapshot
            .pending
            .into_iter()
            .filter(|entry| {
                !submission_id(entry).is_some_and(|id| record.snapshot.outcomes.contains_key(id))
            })
            .collect();
        self.pending_cache
            .borrow_mut()
            .insert(project_id.into(), (opened_stamp, pending.clone()));
        Ok(pending)
    }
    pub(crate) fn native_replace(
        &self,
        project_id: &str,
        expected_revision: u64,
        snapshot: Value,
    ) -> Result<()> {
        let (_, mut record) = self.take_record(project_id)?;
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
        reclaim(&mut record, now_secs());
        let path = self.record_path(project_id)?;
        self.store_record_owned(&path, record)
    }

    /// Workbench 命令原地准入：直接操作缓存/落盘中的 `Record`，避免整库 `Value` 往返拷贝；
    /// 若同一 `commandId` 已存在（已结算或已待决），原样返回既有回执交由调用方校验摘要。
    pub(crate) fn native_admit_workbench(
        &self,
        project_id: &str,
        command: &str,
        method: &str,
        unknown_result: Value,
    ) -> Result<Option<Value>> {
        self.ensure_empty(project_id)?;
        let (stamp, mut record) = self.take_record(project_id)?;
        if let Some(existing) = record.snapshot.outcomes.get(command).cloned().or_else(|| {
            record
                .snapshot
                .pending
                .iter()
                .find(|row| row["requestId"] == command)
                .map(|row| row["result"].clone())
        }) {
            if let Some(stamp) = stamp {
                self.records
                    .borrow_mut()
                    .insert(project_id.into(), (stamp, record));
            }
            return Ok(Some(existing));
        }
        let now = now_secs();
        reclaim(&mut record, now);
        ensure!(
            record.snapshot.pending.len() + record.snapshot.outcomes.len() < CAPACITY,
            "CAPACITY_EXCEEDED"
        );
        // 未知操作只按摘要查询，永不重放；不持久化可能含供应商凭据的请求参数。
        record.snapshot.pending.push(json!({
            "requestId": command,
            "operationId": command,
            "method": method,
            "params": {},
            "result": unknown_result
        }));
        record.revision = record
            .revision
            .checked_add(1)
            .context("journal revision exhausted")?;
        let path = self.record_path(project_id)?;
        self.store_record_owned(&path, record)?;
        Ok(None)
    }

    /// Workbench 命令原地结算：在 `await` 后读取最新记录，仅结算匹配的待决行（校验方法与语义摘要），
    /// 若已由同 ID 并发结算则校验一致性并返回原回执，不覆盖原结果。
    pub(crate) fn native_settle_workbench(
        &self,
        project_id: &str,
        command: &str,
        method: &str,
        digest: &str,
        receipt: Value,
    ) -> Result<Value> {
        self.ensure_empty(project_id)?;
        let (stamp, mut record) = self.take_record(project_id)?;
        if let Some(previous) = record.snapshot.outcomes.get(command).cloned() {
            ensure!(
                previous["method"] == method && previous["semanticDigest"] == digest,
                "COMMAND_CONFLICT"
            );
            if let Some(stamp) = stamp {
                self.records
                    .borrow_mut()
                    .insert(project_id.into(), (stamp, record));
            }
            return Ok(previous);
        }
        let Some(original) = record
            .snapshot
            .pending
            .iter()
            .find(|row| row["requestId"] == command)
        else {
            if let Some(stamp) = stamp {
                self.records
                    .borrow_mut()
                    .insert(project_id.into(), (stamp, record));
            }
            return Err(anyhow::anyhow!("SUBMISSION_UNKNOWN"));
        };
        if original["method"] != method || original["result"]["semanticDigest"] != digest {
            if let Some(stamp) = stamp {
                self.records
                    .borrow_mut()
                    .insert(project_id.into(), (stamp, record));
            }
            return Err(anyhow::anyhow!("COMMAND_CONFLICT"));
        }
        record
            .snapshot
            .pending
            .retain(|row| row["requestId"] != command);
        record
            .snapshot
            .outcomes
            .insert(command.into(), receipt.clone());
        record.revision = record
            .revision
            .checked_add(1)
            .context("journal revision exhausted")?;
        reclaim(&mut record, now_secs());
        let path = self.record_path(project_id)?;
        self.store_record_owned(&path, record)?;
        Ok(receipt)
    }

    /// 准入与结算共用同一快照事务；调用方只负责授权与方法特有的权威前置条件。
    pub(crate) fn native_preflight(
        &self,
        project: &str,
        entry: &Value,
        block_target: bool,
    ) -> Result<()> {
        let (_, snapshot) = self.native_snapshot(project)?;
        check_admission(&snapshot, entry, block_target)
    }

    pub(crate) fn native_admit(
        &self,
        project: &str,
        revision: u64,
        mut snapshot: Value,
        entry: Value,
        block_target: bool,
    ) -> Result<()> {
        check_admission(&snapshot, &entry, block_target)?;
        snapshot["pending"].as_array_mut().unwrap().push(entry);
        self.native_replace(project, revision, snapshot)
    }

    pub(crate) fn native_finish(
        &self,
        project: &str,
        entry: &Value,
        outcome: Option<Value>,
    ) -> Result<Value> {
        let id = submission_id(entry).context("INVALID_PARAMS")?;
        self.ensure_empty(project)?;
        let (stamp, mut record) = self.take_record(project)?;
        if let Some(previous) = record.snapshot.outcomes.get(id).cloned() {
            if let Some(stamp) = stamp {
                self.records
                    .borrow_mut()
                    .insert(project.into(), (stamp, record));
            }
            return Ok(previous);
        }
        let Some(original) = record
            .snapshot
            .pending
            .iter()
            .find(|row| submission_id(row) == Some(id))
        else {
            if let Some(stamp) = stamp {
                self.records
                    .borrow_mut()
                    .insert(project.into(), (stamp, record));
            }
            return Err(anyhow::anyhow!("SUBMISSION_UNKNOWN"));
        };
        if original["method"] != entry["method"] || original["params"] != entry["params"] {
            if let Some(stamp) = stamp {
                self.records
                    .borrow_mut()
                    .insert(project.into(), (stamp, record));
            }
            return Err(anyhow::anyhow!("COMMAND_CONFLICT"));
        }
        record
            .snapshot
            .pending
            .retain(|row| submission_id(row) != Some(id));
        if let Some(outcome) = &outcome {
            record.snapshot.outcomes.insert(id.into(), outcome.clone());
        }
        record.revision = record
            .revision
            .checked_add(1)
            .context("journal revision exhausted")?;
        reclaim(&mut record, now_secs());
        let path = self.record_path(project)?;
        self.store_record_owned(&path, record)?;
        Ok(outcome.unwrap_or(Value::Null))
    }

    pub(crate) fn native_dismiss(&self, project: &str, id: &str) -> Result<()> {
        self.ensure_empty(project)?;
        let (stamp, mut record) = self.take_record(project)?;
        if record
            .snapshot
            .outcomes
            .get(id)
            .is_some_and(|outcome| outcome["remote"].is_object())
        {
            if let Some(stamp) = stamp {
                self.records
                    .borrow_mut()
                    .insert(project.into(), (stamp, record));
            }
            return Ok(());
        }
        record.snapshot.outcomes.remove(id);
        record.revision = record
            .revision
            .checked_add(1)
            .context("journal revision exhausted")?;
        reclaim(&mut record, now_secs());
        let path = self.record_path(project)?;
        self.store_record_owned(&path, record)
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
        for path in storage::json_records(&self.root.join("operations"), false)? {
            let operation: Prepared = storage::read(&path)?;
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
    /// 冷落盘：写入前失效两份缓存且写后不回填；用于初始化导入与带 `last_operation` 的两阶段提交，
    /// 确保外部导入仍走首次时间戳归一化，且 `journal.commit` 后续独立回执文件写失败时下次读取必执行 `recover()`。
    fn store_record_cold(&self, path: &Path, record: &Record) -> Result<()> {
        self.records.borrow_mut().remove(&record.project_id);
        self.pending_cache.borrow_mut().remove(&record.project_id);
        let _ = write_record_with_stamp(path, record)?;
        Ok(())
    }
    /// 受保护写穿落盘：I/O 前先失效缓存，写失败保持未缓存；仅在无 `last_operation` 且取得已落盘句柄印记时
    /// 将所有权直接移回内存缓存，避免下一次读写重新解析整个文件。
    fn store_record_owned(&self, path: &Path, record: Record) -> Result<()> {
        self.records.borrow_mut().remove(&record.project_id);
        self.pending_cache.borrow_mut().remove(&record.project_id);
        let stamp = write_record_with_stamp(path, &record)?;
        if record.last_operation.is_none()
            && let Some(stamp) = stamp
        {
            self.records
                .borrow_mut()
                .insert(record.project_id.clone(), (stamp, record));
        }
        Ok(())
    }
    fn load_from_disk(&self, project_id: &str, path: &Path) -> Result<(RecordStamp, Record)> {
        let (opened_stamp, mut record): (RecordStamp, Record) = read_large_with_stamp(path)?;
        ensure!(
            record.project_id == project_id,
            "journal project identity mismatch"
        );
        record.snapshot.validate()?;
        self.recover(&record)?;
        drop_legacy_remote(&mut record.snapshot);
        if record.settled_at.is_empty() {
            for id in record.snapshot.outcomes.keys() {
                record.settled_at.insert(id.clone(), 0);
            }
        }
        reclaim(&mut record, now_secs());
        Ok((opened_stamp, record))
    }
    fn take_record(&self, project_id: &str) -> Result<(Option<RecordStamp>, Record)> {
        let path = self.record_path(project_id)?;
        let stamp = record_stamp(&path)?;
        let hit = self
            .records
            .borrow()
            .get(project_id)
            .is_some_and(|(cached_stamp, _)| *cached_stamp == stamp);
        if hit {
            let (cached_stamp, record) = self
                .records
                .borrow_mut()
                .remove(project_id)
                .expect("checked cached journal record");
            return Ok((Some(cached_stamp), record));
        }
        self.records.borrow_mut().remove(project_id);
        let (opened_stamp, record) = self.load_from_disk(project_id, &path)?;
        Ok((Some(opened_stamp), record))
    }
    fn load(&self, project_id: &str) -> Result<Record> {
        self.with_record(project_id, Clone::clone)
    }
    fn with_record<T>(&self, project_id: &str, read: impl FnOnce(&Record) -> T) -> Result<T> {
        let path = self.record_path(project_id)?;
        let stamp = record_stamp(&path)?;
        {
            let mut cache = self.records.borrow_mut();
            if let Some((cached_stamp, record)) = cache.get_mut(project_id)
                && *cached_stamp == stamp
            {
                // 已满缓存记录跨过 24 小时保留期后需先回收，避免持续误报容量耗尽。
                if record.snapshot.pending.len() + record.snapshot.outcomes.len() >= CAPACITY {
                    reclaim(record, now_secs());
                }
                return Ok(read(record));
            }
            cache.remove(project_id);
        }
        let (opened_stamp, record) = self.load_from_disk(project_id, &path)?;
        let result = read(&record);
        self.records
            .borrow_mut()
            .insert(project_id.into(), (opened_stamp, record));
        Ok(result)
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
        let mut snapshot = Snapshot::parse(serde_json::from_slice(&bytes)?)?;
        preserve_native_entries(&record.snapshot, &mut snapshot)?;
        preserve_pending_identity(&record.snapshot, &snapshot)?;
        let revision = record
            .revision
            .checked_add(1)
            .context("journal revision exhausted")?;
        operation.receipt = json!({"requestId":operation.request_id,"projectId":operation.project_id,"revision":revision,"sha256":operation.sha256,"method":"journal.commit","state":"completed"});
        let mut next = Record {
            revision,
            snapshot,
            last_operation: Some(operation.clone()),
            ..record
        };
        reclaim(&mut next, now_secs());
        self.store_record_cold(&self.record_path(&operation.project_id)?, &next)?;
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

fn check_admission(snapshot: &Value, entry: &Value, block_target: bool) -> Result<()> {
    let key = submission_id(entry).context("INVALID_PARAMS")?;
    let pending = snapshot["pending"].as_array().context("INVALID_PARAMS")?;
    let outcomes = snapshot["outcomes"].as_object().context("INVALID_PARAMS")?;
    ensure!(has_capacity(snapshot), "CAPACITY_EXCEEDED");
    ensure!(
        !outcomes.contains_key(key) && !pending.iter().any(|row| submission_id(row) == Some(key)),
        "COMMAND_CONFLICT"
    );
    if block_target {
        let params = &entry["params"];
        let target = params
            .get("taskId")
            .filter(|id| id.as_str().is_some_and(|id| !id.is_empty()))
            .map(|id| ("taskId", id))
            .or_else(|| {
                params
                    .get("threadId")
                    .filter(|id| id.as_str().is_some_and(|id| !id.is_empty()))
                    .map(|id| ("threadId", id))
            });
        ensure!(
            !pending.iter().any(|row| {
                let settled = row["remote"].is_object()
                    && submission_id(row).is_some_and(|id| {
                        outcomes
                            .get(id)
                            .is_some_and(|outcome| outcome["remote"].is_object())
                    });
                if settled || areal_protocol::submissions::remote_control(row) {
                    return false;
                }
                // Core 在 Thread 锁内保证这两种写入只在空闲时发生；steer 只能作用于
                // 原活动轮次。保留它的未决回执，同时允许空闲态的工具准备和新轮次。
                let requires_idle = match entry["method"].as_str() {
                    Some("areal/thread/tools/attach") => true,
                    Some("areal/turn/start") => params["admissionGuard"]["ordinarySession"] == true,
                    _ => false,
                };
                if requires_idle
                    && row["method"] == "areal/queue/steer"
                    && row["params"]["expectedTurnId"]
                        .as_str()
                        .is_some_and(|id| !id.is_empty())
                    && row["params"]["queueItemId"]
                        .as_str()
                        .is_some_and(|id| !id.is_empty())
                {
                    return false;
                }
                if matches!(
                    entry["method"].as_str(),
                    Some("areal/thread/fork" | "areal/side/start" | "areal/side/create")
                ) {
                    return row["method"] == entry["method"]
                        && row["params"]["sourceThreadId"] == params["sourceThreadId"];
                }
                target.is_some_and(|(field, id)| !id.is_null() && row["params"][field] == *id)
            }),
            "SUBMISSION_UNKNOWN"
        );
    }
    Ok(())
}

fn preserve_native_entries(before: &Snapshot, after: &mut Snapshot) -> Result<()> {
    for original in before
        .pending
        .iter()
        .filter(|entry| entry["rustOwner"] == true)
    {
        ensure!(
            after.pending.iter().any(|entry| entry == original),
            "Host-owned pending submission cannot be changed by a client snapshot"
        );
    }
    for (id, original) in before
        .outcomes
        .iter()
        .filter(|(_, entry)| entry["rustOwner"] == true)
    {
        let next = after
            .outcomes
            .get_mut(id)
            .context("Host-owned outcome requires execution.dismiss")?;
        let fields = next.as_object_mut().context("invalid outcome projection")?;
        let original = original.as_object().context("invalid Host outcome")?;
        // 旧任务草稿仅追加自己的投影注记，不能接管提交的受理事实与原身份。
        for (key, value) in original {
            if let Some(next) = fields.get(key) {
                ensure!(next == value, "Host-owned outcome identity cannot change");
            }
            fields.insert(key.clone(), value.clone());
        }
        ensure!(
            fields.iter().all(|(key, value)| original.contains_key(key)
                || (matches!(
                    key.as_str(),
                    "draftThreadId" | "taskDraftMessage" | "taskDraftError"
                ) && value.is_string())),
            "unsupported Host outcome annotation"
        );
    }
    Ok(())
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
fn open_read_with_stamp(path: &Path) -> Result<(File, RecordStamp)> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    let stamp = record_stamp_metadata(&file.metadata()?)?;
    Ok((file, stamp))
}
fn open_read(path: &Path) -> Result<File> {
    Ok(open_read_with_stamp(path)?.0)
}
#[cfg(test)]
thread_local! { static RECORD_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }
fn read_large_with_stamp<T: DeserializeOwned>(path: &Path) -> Result<(RecordStamp, T)> {
    #[cfg(test)]
    RECORD_READS.with(|count| count.set(count.get() + 1));
    let (file, stamp) = open_read_with_stamp(path)?;
    Ok((stamp, serde_json::from_reader(BufReader::new(file))?))
}
fn read_large<T: DeserializeOwned>(path: &Path) -> Result<T> {
    Ok(read_large_with_stamp(path)?.1)
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
    #[test]
    fn import_keeps_settled_receipts_and_drops_legacy_remote_rows() {
        let root = tempfile::tempdir().unwrap();
        let journal = Journal::new(root.path()).unwrap();
        journal
            .import(
                "project",
                json!({
                    "local":{"accepted":true,"threadId":"thread"},
                    "legacy-send":{"accepted":true,"remote":{"method":"session.send"}},
                    "legacy-goal":{"accepted":true,"remote":{"method":"session.control","target":{"operation":"goalCreate"}}},
                    "native-send":{"accepted":true,"nativeDigest":"digest","remote":{"method":"session.send"}},
                }),
            )
            .unwrap();
        let (_, snapshot) = journal.native_snapshot("project").unwrap();
        assert_eq!(snapshot["pending"], json!([]));
        let kept: Vec<_> = snapshot["outcomes"].as_object().unwrap().keys().collect();
        assert_eq!(kept, ["legacy-goal", "local", "native-send"]);
    }
    #[test]
    fn unresolved_steer_preserves_idle_tool_preparation_but_still_guards_queue_edits() {
        let queued = json!({"method":"areal/queue/steer","params":{
            "requestId":"old","threadId":"thread","queueItemId":"item","expectedTurnId":"turn"
        }});
        let mut snapshot = json!({"pending":[queued],"outcomes":{}});
        let attach = json!({"method":"areal/thread/tools/attach","params":{
            "requestId":"attach","threadId":"thread","expectedToolsetRevision":1,
            "bundleId":"areal.browser.v1"
        }});
        assert!(check_admission(&snapshot, &attach, true).is_ok());
        let edit = json!({"method":"areal/queue/update","params":{
            "requestId":"edit","threadId":"thread","queueItemId":"item"
        }});
        assert!(check_admission(&snapshot, &edit, true).is_err());
        snapshot["pending"][0]["method"] = json!("areal/turn/start");
        assert!(check_admission(&snapshot, &attach, true).is_err());
    }

    #[test]
    fn native_admission_is_cas_bound_and_settlement_keeps_original_outcome() {
        let root = tempfile::tempdir().unwrap();
        let journal = Journal::new(root.path()).unwrap();
        let (revision, snapshot) = journal.native_snapshot("project").unwrap();
        let entry = json!({"method":"areal/turn/submit","params":{"requestId":"one","threadId":"thread"},"rustOwner":true});
        journal
            .native_admit("project", revision, snapshot.clone(), entry.clone(), true)
            .unwrap();
        assert!(journal.native_admit("project", revision, snapshot, json!({"method":"areal/turn/submit","params":{"requestId":"two","threadId":"other"}}), true).is_err());
        let (revision, snapshot) = journal.native_snapshot("project").unwrap();
        let conflict =
            json!({"method":"areal/turn/submit","params":{"requestId":"two","threadId":"thread"}});
        assert!(
            journal
                .native_admit("project", revision, snapshot, conflict, true)
                .unwrap_err()
                .to_string()
                .contains("SUBMISSION_UNKNOWN")
        );
        let mut altered = entry.clone();
        altered["params"]["threadId"] = json!("other");
        assert!(journal.native_finish("project", &altered, None).is_err());
        let outcome = json!({"rustOwner":true,"method":"areal/turn/submit","accepted":true,"status":"completed","threadId":"thread"});
        assert_eq!(
            journal
                .native_finish("project", &entry, Some(outcome.clone()))
                .unwrap(),
            outcome
        );
        assert_eq!(
            journal
                .native_finish("project", &entry, Some(json!({"status":"failed"})))
                .unwrap(),
            outcome
        );
        assert!(
            journal.native_snapshot("project").unwrap().1["pending"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    fn outcomes(count: usize) -> BTreeMap<String, Value> {
        (0..count)
            .map(|index| (format!("done-{index:05}"), json!({"accepted":true})))
            .collect()
    }

    #[test]
    fn reclaim_keeps_recent_referenced_and_goal_control_receipts() {
        let now = 10 * RECLAIM_MIN_AGE_SECS;
        let mut snapshot = Snapshot {
            version: 1,
            pending: vec![
                json!({"method":"areal/turn/submit","params":{"requestId":"done-00000"}}),
            ],
            outcomes: outcomes(CAPACITY),
        };
        snapshot.outcomes.insert(
            "goal".into(),
            json!({"remote":{"method":"session.control","target":{"operation":"goalCreate"}},"admissionState":"accepted"}),
        );
        let mut settled_at: BTreeMap<String, u64> =
            snapshot.outcomes.keys().map(|id| (id.clone(), 0)).collect();
        // 最新的 100 条仍在最短保留期内。
        for index in CAPACITY - 100..CAPACITY {
            settled_at.insert(format!("done-{index:05}"), now - 60);
        }
        let mut record = Record {
            project_id: "project".into(),
            revision: 0,
            initial_digest: String::new(),
            snapshot,
            last_operation: None,
            settled_at,
        };
        reclaim(&mut record, now);
        let kept = &record.snapshot.outcomes;
        assert_eq!(record.snapshot.pending.len() + kept.len(), RECLAIM_TARGET);
        assert!(kept.contains_key("goal") && kept.contains_key("done-00000"));
        assert!(
            (CAPACITY - 100..CAPACITY).all(|index| kept.contains_key(&format!("done-{index:05}")))
        );
        assert!(!kept.contains_key("done-00001"));
        assert_eq!(record.settled_at.len(), kept.len());

        // 全部在最短保留期内时一条都不回收，同一 commandId 仍能命中原回执。
        let mut fresh = Record {
            settled_at: BTreeMap::new(),
            snapshot: Snapshot {
                version: 1,
                pending: vec![],
                outcomes: outcomes(RECLAIM_THRESHOLD + 10),
            },
            ..record
        };
        reclaim(&mut fresh, now);
        assert_eq!(fresh.snapshot.outcomes.len(), RECLAIM_THRESHOLD + 10);
        assert!(fresh.settled_at.values().all(|at| *at == now));
    }

    #[test]
    fn full_journal_from_previous_release_admits_after_reclaim() {
        let root = tempfile::tempdir().unwrap();
        let journal = Journal::new(root.path()).unwrap();
        journal.native_snapshot("project").unwrap();
        // 模拟升级前写满且没有结算时间字段的记录。
        let path = journal.record_path("project").unwrap();
        let mut legacy: Value = read_large(&path).unwrap();
        legacy["snapshot"]["outcomes"] = serde_json::to_value(outcomes(CAPACITY)).unwrap();
        legacy.as_object_mut().unwrap().remove("settledAt");
        storage::write(&path, &legacy).unwrap();

        let (revision, snapshot) = journal.native_snapshot("project").unwrap();
        assert_eq!(
            snapshot["outcomes"].as_object().unwrap().len(),
            RECLAIM_TARGET
        );
        let entry =
            json!({"method":"areal/turn/submit","params":{"requestId":"next","threadId":"thread"}});
        journal
            .native_admit("project", revision, snapshot, entry.clone(), true)
            .unwrap();
        journal
            .native_finish("project", &entry, Some(json!({"accepted":true})))
            .unwrap();
        let stored: Value = read_large(&path).unwrap();
        assert_eq!(
            stored["snapshot"]["outcomes"].as_object().unwrap().len(),
            RECLAIM_TARGET + 1
        );
        assert!(stored["settledAt"]["next"].as_u64().unwrap() > 0);
        // 刚结算的回执在保留期内，重复结算返回原回执。
        assert_eq!(
            journal
                .native_finish("project", &entry, Some(json!({"accepted":false})))
                .unwrap(),
            json!({"accepted":true})
        );
    }

    #[test]
    fn client_snapshot_cannot_remove_or_rebind_rust_owned_facts() {
        let pending = json!({"method":"areal/turn/submit","params":{"requestId":"one","threadId":"thread"},"rustOwner":true});
        let original = Snapshot::parse(json!({"version":1,"pending":[pending],"outcomes":{"done":{"rustOwner":true,"accepted":true,"threadId":"thread"}}})).unwrap();
        let mut removed = original.clone();
        removed.pending.clear();
        assert!(preserve_native_entries(&original, &mut removed).is_err());
        let mut altered = original.clone();
        altered.outcomes.get_mut("done").unwrap()["threadId"] = json!("other");
        assert!(preserve_native_entries(&original, &mut altered).is_err());
        let mut annotated = original.clone();
        annotated.outcomes.get_mut("done").unwrap()["taskDraftMessage"] = json!("projection");
        assert!(preserve_native_entries(&original, &mut annotated).is_ok());
        annotated.outcomes.remove("done");
        assert!(preserve_native_entries(&original, &mut annotated).is_err());
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
    fn restart_ignores_interrupted_atomic_writes_but_rejects_corrupt_records() {
        let root = tempfile::tempdir().unwrap();
        let journal = Journal::new(root.path()).unwrap();
        let mut leftovers = Vec::new();
        for directory in ["records", "operations"] {
            let path = journal.root.join(directory).join(".tmpAbC123");
            std::fs::write(&path, b"{\"projectId\":").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            leftovers.push(path);
        }
        drop(journal);
        let journal = Journal::new(root.path()).unwrap();
        assert!(leftovers.iter().all(|path| !path.exists()));
        journal.disconnect("connection").unwrap();
        let corrupt = journal
            .root
            .join("operations")
            .join(format!("{}.json", "a".repeat(64)));
        std::fs::write(&corrupt, b"{\"projectId\":").unwrap();
        std::fs::set_permissions(&corrupt, std::fs::Permissions::from_mode(0o600)).unwrap();
        drop(journal);
        assert!(Journal::new(root.path()).is_err());
    }

    #[test]
    fn restart_reclaims_settled_operations_past_retention() {
        let root = tempfile::tempdir().unwrap();
        let journal = Journal::new(root.path()).unwrap();
        let write = |id: &str, age: u64| {
            let operation = json!({
                "requestId":id,"projectId":"project","expectedRevision":0,"sha256":"x",
                "byteLength":0,"slotId":"slot","epoch":"old","connectionId":"c",
                "writePath":root.path().join("gone"),
                "receipt":{"requestId":id,"method":"journal.commit","state":"completed"}
            });
            let path = journal.operation_path(id);
            storage::write(&path, &operation).unwrap();
            let at = std::time::SystemTime::now() - std::time::Duration::from_secs(age);
            File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(at)
                .unwrap();
            path
        };
        let old = write("old", RECLAIM_MIN_AGE_SECS + 60);
        let recent = write("recent", RECLAIM_MIN_AGE_SECS - 60);
        drop(journal);
        Journal::new(root.path()).unwrap();
        assert!(!old.exists());
        assert!(recent.exists());
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

#[cfg(test)]
#[test]
fn owned_journal_reads_do_not_reparse_accumulated_history() {
    let root = tempfile::tempdir().unwrap();
    let journal = Journal::new(root.path()).unwrap();
    let outcomes: BTreeMap<String, Value> = (0..615)
        .map(|index| (index.to_string(), json!({"payload":"x".repeat(3800)})))
        .collect();
    journal
        .initialize(
            "project",
            json!({"version":1,"pending":[],"outcomes":outcomes}),
        )
        .unwrap();
    journal.native_snapshot("project").unwrap();
    let before = RECORD_READS.with(std::cell::Cell::get);
    for _ in 0..3 {
        let (_, snapshot) = journal.native_snapshot("project").unwrap();
        assert_eq!(
            snapshot["outcomes"]["614"]["payload"]
                .as_str()
                .unwrap()
                .len(),
            3800
        );
    }
    assert_eq!(
        RECORD_READS.with(std::cell::Cell::get),
        before,
        "single-owner reads must not reopen and parse accumulated receipts"
    );
}

#[cfg(test)]
#[test]
fn byte_budget_reclaim_shrinks_oversized_journal_while_preserving_protected_receipts() {
    let root = tempfile::tempdir().unwrap();
    let journal = Journal::new(root.path()).unwrap();
    let project = "workbench-oversized";
    journal.native_snapshot(project).unwrap();
    let path = journal.record_path(project).unwrap();

    let now = now_secs();
    let old = now.saturating_sub(RECLAIM_MIN_AGE_SECS + 120);
    let recent = now.saturating_sub(60);
    let payload = "x".repeat(6500);
    let mut outcomes_map = BTreeMap::new();
    let mut settled_at = BTreeMap::new();
    // 260 条超期大回执（~1.7 MiB），远低于条数阈值 3072，但超过 1 MiB 字节软上限。
    for index in 0..260 {
        let id = format!("old-{index:04}");
        outcomes_map.insert(
            id.clone(),
            json!({"method":"library.command","receipt":{"blob":payload}}),
        );
        settled_at.insert(id, old + index as u64);
    }
    // 受保护的三类回执：长期授权 goalCreate、被 pending 引用的旧回执、以及 24h 内的新回执。
    outcomes_map.insert(
        "goal-old".into(),
        json!({"remote":{"method":"session.control","target":{"operation":"goalCreate"}},"blob":payload}),
    );
    settled_at.insert("goal-old".into(), old);
    outcomes_map.insert(
        "referenced-old".into(),
        json!({"method":"library.command","receipt":{"blob":payload}}),
    );
    settled_at.insert("referenced-old".into(), old);
    for index in 0..10 {
        let id = format!("recent-{index:02}");
        outcomes_map.insert(
            id.clone(),
            json!({"method":"library.command","receipt":{"blob":payload}}),
        );
        settled_at.insert(id, recent);
    }
    let mut pending = vec![json!({
        "requestId":"referenced-old","operationId":"referenced-old",
        "method":"library.command","params":{}
    })];
    for index in 0..13 {
        let id = format!("pending-provider-{index:02}");
        pending.push(json!({
            "requestId":id,"operationId":id,"method":"providers.command","params":{},
            "result":{"commandId":id,"method":"providers.command","admissionState":"accepted","submissionUnknown":true,"semanticDigest":"prov"}
        }));
    }
    let seeded = Record {
        project_id: project.into(),
        revision: 10,
        initial_digest: String::new(),
        snapshot: Snapshot {
            version: 1,
            pending,
            outcomes: outcomes_map,
        },
        last_operation: None,
        settled_at,
    };
    storage::write(&path, &seeded).unwrap();
    let before_len = std::fs::metadata(&path).unwrap().len();
    assert!(before_len > RECLAIM_BYTES_THRESHOLD as u64);

    // 首次正常 Workbench 写入会触发按字节回收并写穿回填缓存，后续读/结算均不再重读磁盘。
    let unknown = json!({"commandId":"cmd-1","method":"library.command","admissionState":"accepted","submissionUnknown":true,"semanticDigest":"d1"});
    assert!(
        journal
            .native_admit_workbench(project, "cmd-1", "library.command", unknown.clone())
            .unwrap()
            .is_none()
    );
    let after_admit_len = std::fs::metadata(&path).unwrap().len();
    assert!(
        after_admit_len < RECLAIM_BYTES_THRESHOLD as u64,
        "oversized expired journal should shrink on durable mutation, got {after_admit_len}"
    );

    let reads_after_admit = RECORD_READS.with(std::cell::Cell::get);
    // 同一 commandId 并发重复到达，直接命中缓存里的待决回执，且零磁盘重读。
    assert_eq!(
        journal
            .native_admit_workbench(project, "cmd-1", "library.command", unknown)
            .unwrap(),
        Some(
            json!({"commandId":"cmd-1","method":"library.command","admissionState":"accepted","submissionUnknown":true,"semanticDigest":"d1"})
        )
    );
    // 结算时摘要不匹配被拒绝；匹配摘要正常结算且不触发额外磁盘解析。
    let final_receipt = json!({"commandId":"cmd-1","method":"library.command","admissionState":"accepted","submissionUnknown":false,"semanticDigest":"d1","receipt":{"ok":true}});
    assert!(
        journal
            .native_settle_workbench(
                project,
                "cmd-1",
                "library.command",
                "wrong-digest",
                final_receipt.clone()
            )
            .is_err()
    );
    assert_eq!(
        journal
            .native_settle_workbench(
                project,
                "cmd-1",
                "library.command",
                "d1",
                final_receipt.clone()
            )
            .unwrap(),
        final_receipt
    );
    // 重复结算返回原回执且不覆盖。
    assert_eq!(
        journal
            .native_settle_workbench(
                project,
                "cmd-1",
                "library.command",
                "d1",
                json!({"commandId":"cmd-1","method":"library.command","semanticDigest":"d1","receipt":{"ok":false}})
            )
            .unwrap(),
        final_receipt
    );
    assert_eq!(
        journal.native_receipt(project, "cmd-1").unwrap(),
        Some(final_receipt)
    );
    assert_eq!(
        RECORD_READS.with(std::cell::Cell::get),
        reads_after_admit,
        "write-through native cache should avoid reparsing across admit/settle/receipt"
    );

    // 校验落盘结果：受保护回执全部保留，最旧超期回执被回收，settled_at 与 outcomes 同步。
    let stored: Record = read_large(&path).unwrap();
    assert!(stored.snapshot.outcomes.contains_key("goal-old"));
    assert!(stored.snapshot.outcomes.contains_key("referenced-old"));
    assert!(stored.snapshot.outcomes.contains_key("cmd-1"));
    assert!(
        (0..10).all(|i| stored
            .snapshot
            .outcomes
            .contains_key(&format!("recent-{i:02}"))),
        "recent receipts within 24h must never be evicted"
    );
    assert!(!stored.snapshot.outcomes.contains_key("old-0000"));
    assert_eq!(stored.settled_at.len(), stored.snapshot.outcomes.len());

    // 若 24h 内的新回执本身就超过字节目标，一条也不得回收。
    let mut all_recent = Record {
        project_id: "recent-heavy".into(),
        revision: 0,
        initial_digest: String::new(),
        snapshot: Snapshot {
            version: 1,
            pending: vec![],
            outcomes: (0..180)
                .map(|i| (format!("fresh-{i:03}"), json!({"blob":payload})))
                .collect(),
        },
        last_operation: None,
        settled_at: (0..180)
            .map(|i| (format!("fresh-{i:03}"), recent))
            .collect(),
    };
    reclaim(&mut all_recent, now);
    assert_eq!(all_recent.snapshot.outcomes.len(), 180);
}

#[cfg(test)]
#[test]
fn pending_read_caches_read_only_and_write_failures_or_commit_last_op_stay_recoverable() {
    let root = tempfile::tempdir().unwrap();
    let journal = Journal::new(root.path()).unwrap();

    // 缺失记录返回空。
    assert!(journal.pending_read("missing").unwrap().is_empty());

    // 构造含旧版远程 pending 行的记录，确认 pending_read 既走缓存又不会静默丢弃旧行。
    let project = "diag-project";
    let path = journal.record_path(project).unwrap();
    let legacy_row = json!({
        "method":"areal/turn/start",
        "params":{"requestId":"legacy-1"},
        "remote":{"method":"session.send","commandId":"legacy-1"}
    });
    let seeded = Record {
        project_id: project.into(),
        revision: 1,
        initial_digest: String::new(),
        snapshot: Snapshot {
            version: 1,
            pending: vec![legacy_row.clone()],
            outcomes: BTreeMap::new(),
        },
        last_operation: None,
        settled_at: BTreeMap::new(),
    };
    storage::write(&path, &seeded).unwrap();
    let reads_before = RECORD_READS.with(std::cell::Cell::get);
    assert_eq!(
        journal.pending_read(project).unwrap(),
        vec![legacy_row.clone()]
    );
    assert_eq!(RECORD_READS.with(std::cell::Cell::get), reads_before + 1);
    assert_eq!(journal.pending_read(project).unwrap(), vec![legacy_row]);
    assert_eq!(
        RECORD_READS.with(std::cell::Cell::get),
        reads_before + 1,
        "warm pending_read must hit read-only cache without reparsing"
    );

    // 磁盘被外部损坏时，pending_read 必须报错而不是返回缓存或空。
    std::fs::write(&path, b"{corrupt").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(journal.pending_read(project).is_err());

    // 写前注入 FAIL_RECORD_WRITES：不污染缓存、不改磁盘，恢复后读取仍准确。
    let wb = "workbench-fault";
    let unknown = json!({"commandId":"c1","method":"library.command","admissionState":"accepted","submissionUnknown":true,"semanticDigest":"d1"});
    journal
        .native_admit_workbench(wb, "c1", "library.command", unknown.clone())
        .unwrap();
    FAIL_RECORD_WRITES.with(|flag| flag.set(true));
    let failed = journal.native_admit_workbench(
        wb,
        "c2",
        "library.command",
        json!({"commandId":"c2","method":"library.command","admissionState":"accepted","submissionUnknown":true,"semanticDigest":"d2"}),
    );
    FAIL_RECORD_WRITES.with(|flag| flag.set(false));
    assert!(failed.is_err());
    assert!(journal.native_receipt(wb, "c2").unwrap().is_none());
    assert_eq!(journal.native_receipt(wb, "c1").unwrap(), Some(unknown));

    // 两阶段 journal.commit 写主记录后若独立回执文件丢失，不能因写穿缓存跳过 recover()。
    let two_phase = "two-phase";
    journal
        .initialize(two_phase, json!({"version":1,"pending":[],"outcomes":{}}))
        .unwrap();
    let next = json!({"version":1,"pending":[],"outcomes":{"done":{"accepted":true}}});
    let bytes = serde_json::to_vec(&next).unwrap();
    let req_id = uuid::Uuid::new_v4().to_string();
    let prepared = journal
        .dispatch(
            "journal.prepare",
            json!({
                "requestId":req_id,"expectedGeneration":"g","projectId":two_phase,
                "expectedRevision":0,"sha256":storage::digest(&bytes),"byteLength":bytes.len()
            }),
            "conn",
        )
        .unwrap();
    std::fs::write(prepared["writePath"].as_str().unwrap(), &bytes).unwrap();
    let committed = journal
        .dispatch(
            "journal.commit",
            json!({"requestId":req_id,"expectedGeneration":"g","slotId":prepared["slotId"]}),
            "conn",
        )
        .unwrap();
    assert_eq!(committed["state"], "completed");
    // 模拟主记录落盘后独立回执仍停留在 prepared，验证重试 commit 不会误报 revisionConflict。
    let op_path = journal.operation_path(&req_id);
    let mut op: Prepared = storage::read(&op_path).unwrap();
    op.receipt = prepared.clone();
    storage::write(&op_path, &op).unwrap();
    let retried = journal
        .dispatch(
            "journal.commit",
            json!({"requestId":req_id,"expectedGeneration":"g","slotId":prepared["slotId"]}),
            "conn",
        )
        .unwrap();
    assert_eq!(retried, committed);
}
