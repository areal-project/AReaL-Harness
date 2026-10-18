use anyhow::{Context, Result, bail};
use areal_protocol::{Item, MediaRef, Thread, ThreadStatus, ToolOutcome, ToolStatus, TurnStatus};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::Semaphore;
mod archive;

// 持久化版本与服务状态必须一致，避免客户端误判可恢复的数据格式。
pub(crate) const STATE_VERSION: u32 = 14;

#[derive(Clone, Serialize, Deserialize)]
pub struct Record {
    pub version: u32,
    pub thread: Thread,
}

pub struct Store {
    root: PathBuf,
    _lock: File,
    io: Arc<Semaphore>,
    blob_write: Arc<tokio::sync::Mutex<()>>,
    #[cfg(test)]
    fork_fault: std::sync::Mutex<Option<ForkFault>>,
}

#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ForkFault {
    BeforeSnapshot,
    AfterSnapshot,
    AfterTarget,
    AfterPersistError,
}

impl Store {
    pub fn open(root: &Path) -> Result<Self> {
        std::fs::create_dir_all(root)?;
        let root = root.canonicalize()?;
        std::fs::create_dir_all(root.join("blobs"))?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join("owner.lock"))?;
        fs2::FileExt::try_lock_exclusive(&lock).context("another Core owns the data directory")?;
        // 独占 Store 后才移除崩溃遗留的原子写临时文件，不能与旧 Core 的写入竞争。
        cleanup_temps(&root)?;
        Ok(Self {
            root,
            _lock: lock,
            io: Arc::new(Semaphore::new(8)),
            blob_write: Arc::new(tokio::sync::Mutex::new(())),
            #[cfg(test)]
            fork_fault: std::sync::Mutex::new(None),
        })
    }
    #[cfg(test)]
    pub(crate) fn set_fork_fault(&self, fault: ForkFault) {
        *self.fork_fault.lock().unwrap() = Some(fault);
    }
    #[cfg(test)]
    pub(crate) fn check_fork_fault(&self, stage: ForkFault) -> crate::Result<()> {
        let mut fault = self.fork_fault.lock().unwrap();
        if *fault == Some(stage) {
            *fault = None;
            return Err(crate::Error::Storage(
                "injected fork persistence fault".into(),
            ));
        }
        Ok(())
    }
    pub fn root(&self) -> &Path {
        &self.root
    }

    #[cfg(test)]
    pub(crate) async fn pause_writes(&self) -> tokio::sync::OwnedSemaphorePermit {
        self.io.clone().acquire_many_owned(8).await.unwrap()
    }

    pub fn load(&self, max_threads: usize, max_bytes: usize) -> Result<Vec<Thread>> {
        let mut threads = Vec::new();
        for entry in std::fs::read_dir(&self.root)? {
            let path = entry?.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            if threads.len() >= max_threads {
                bail!("stored thread count exceeds configured limit");
            }
            if max_bytes > 0 && std::fs::metadata(&path)?.len() > max_bytes as u64 {
                bail!(
                    "stored thread exceeds configured history limit: {}",
                    path.display()
                );
            }
            let mut record: Record = serde_json::from_slice(&std::fs::read(&path)?)
                .with_context(|| format!("invalid session: {}", path.display()))?;
            anyhow::ensure!(
                max_bytes == 0
                    || record
                        .thread
                        .history_archive
                        .as_ref()
                        .map_or(0, |a| a.bytes)
                        .saturating_add(match &record.thread.conversation {
                            Some(areal_protocol::Conversation::Fork { history_seed, .. }) =>
                                history_seed.logical_bytes as u64,
                            Some(areal_protocol::Conversation::Side {
                                reference_snapshot, ..
                            }) => reference_snapshot.logical_bytes as u64,
                            _ => 0,
                        })
                        .saturating_add(std::fs::metadata(&path)?.len())
                        <= max_bytes as u64,
                "stored thread exceeds configured history limit"
            );
            if !matches!(record.version, 1..=STATE_VERSION)
                || path.file_stem().and_then(|s| s.to_str()) != Some(&record.thread.id)
                || uuid::Uuid::parse_str(&record.thread.id).is_err()
            {
                bail!("unsupported or inconsistent session: {}", path.display());
            }
            if let Some(reference) = &record.thread.history_archive {
                archive::read_segment(&self.root, &reference.head)?;
            }
            if let Some(areal_protocol::Conversation::Fork {
                version,
                origin,
                history_seed,
                ..
            }) = &record.thread.conversation
            {
                anyhow::ensure!(
                    *version == 1 && record.version >= 14,
                    "unsupported fork conversation version"
                );
                anyhow::ensure!(
                    origin.snapshot_id == history_seed.snapshot_id,
                    "fork snapshot reference mismatch"
                );
                let segment = archive::read_segment(&self.root, &history_seed.snapshot_id)?;
                anyhow::ensure!(
                    segment.previous.is_none(),
                    "fork snapshot contains archive chain"
                );
                anyhow::ensure!(
                    std::fs::metadata(self.root.join("history").join(&history_seed.snapshot_id))?
                        .len()
                        == history_seed.logical_bytes as u64,
                    "fork snapshot size mismatch"
                );
                anyhow::ensure!(
                    segment.turns.len() == history_seed.turn_count
                        && segment
                            .turns
                            .iter()
                            .map(|turn| turn.items.len())
                            .sum::<usize>()
                            == history_seed.item_count,
                    "fork snapshot manifest mismatch"
                );
                anyhow::ensure!(
                    segment.source_thread_ids.len() == segment.turns.len()
                        && segment
                            .source_thread_ids
                            .iter()
                            .all(|id| uuid::Uuid::parse_str(id).is_ok()),
                    "fork snapshot provenance mismatch"
                );
                if origin.boundary == "after" {
                    anyhow::ensure!(
                        segment
                            .turns
                            .last()
                            .is_some_and(|turn| turn.id == origin.source_turn_id),
                        "fork snapshot anchor mismatch"
                    );
                }
            }
            if let Some(areal_protocol::Conversation::Side {
                version,
                origin,
                reference_snapshot,
                policy,
                ..
            }) = &record.thread.conversation
            {
                anyhow::ensure!(
                    *version == 1
                        && record.version >= 14
                        && policy.kind == "sideReadOnlyV1"
                        && matches!(policy.workspace_access.as_str(), "none" | "readOnly"),
                    "unsupported Side policy"
                );
                anyhow::ensure!(
                    record.thread.parent_thread_id.is_none()
                        && record.thread.session_id == record.thread.id
                        && record.thread.goal_owner.is_none()
                        && record.thread.goals.is_empty()
                        && record.thread.dynamic_tools.is_empty(),
                    "Side execution authority mismatch"
                );
                anyhow::ensure!(
                    record
                        .thread
                        .desktop
                        .as_ref()
                        .is_some_and(|d| d.queue.items.is_empty()
                            && d.processes.is_empty()
                            && d.configuration.read_only
                            && d.configuration
                                .tool_allowlist
                                .as_ref()
                                .is_some_and(|tools| {
                                    tools.iter().any(|name| name == "side_context_read")
                                        && tools.iter().all(|name| {
                                            name == "side_context_read"
                                                || (policy.workspace_access == "readOnly"
                                                    && crate::tools::side_file_tool(
                                                        name,
                                                        &crate::tools::registry::Backend::Builtin,
                                                    ))
                                        })
                                })),
                    "Side configuration authority mismatch"
                );
                anyhow::ensure!(
                    origin.snapshot_id == reference_snapshot.snapshot_id,
                    "Side snapshot reference mismatch"
                );
                let segment = archive::read_segment(&self.root, &reference_snapshot.snapshot_id)?;
                anyhow::ensure!(
                    segment.previous.is_none()
                        && segment.turns.len() == reference_snapshot.turn_count
                        && segment.turns.iter().map(|t| t.items.len()).sum::<usize>()
                            == reference_snapshot.item_count
                        && segment.source_thread_ids.len() == segment.turns.len(),
                    "Side snapshot manifest mismatch"
                );
                anyhow::ensure!(
                    std::fs::metadata(
                        self.root
                            .join("history")
                            .join(&reference_snapshot.snapshot_id)
                    )?
                    .len()
                        == reference_snapshot.logical_bytes as u64,
                    "Side snapshot size mismatch"
                );
            }
            let mut repaired = false;
            if let Some(goal) = &mut record.thread.goals.goal {
                if goal.status == areal_protocol::goals::GoalStatus::Active
                    || goal
                        .rsi
                        .as_ref()
                        .is_some_and(|r| r.phase == areal_protocol::goals::RsiPhase::Running)
                {
                    goal.status = areal_protocol::goals::GoalStatus::Paused;
                    goal.reason = Some("serverRestarted".into());
                    goal.usage.accounting_complete = false;
                    goal.report_turn_id = None;
                    record.thread.goals.revision += 1;
                    record.thread.goals.event_sequence += 1;
                    repaired = true;
                }
                goal.active_turn_id = None;
                goal.settling = false;
                goal.waiting_for_input = false;
                goal.waiting_for_agents = false;
                goal.waiting_for_capacity = false;
            }
            for turn in &mut record.thread.turns {
                if turn.status == TurnStatus::InProgress {
                    turn.status = TurnStatus::Interrupted;
                    repaired = true;
                }
                for item in &mut turn.items {
                    if let Item::DynamicToolCall {
                        execution,
                        status,
                        success,
                        content_items,
                        ..
                    } = item
                    {
                        let mut recovered_plugin = false;
                        if let Some(plugin) = &mut execution.plugin {
                            for operation in &mut plugin.operations {
                                if operation.outcome == ToolOutcome::Running {
                                    operation.outcome = ToolOutcome::Unknown;
                                    recovered_plugin = true;
                                }
                            }
                        }
                        let mut recovered_hook = false;
                        for hook in &mut execution.hooks {
                            if hook.outcome == ToolOutcome::Running {
                                hook.outcome = ToolOutcome::Unknown;
                                recovered_hook = true;
                            }
                        }
                        if execution.outcome != ToolOutcome::Running
                            && !recovered_hook
                            && !recovered_plugin
                        {
                            continue;
                        }
                        if execution.outcome == ToolOutcome::Running || recovered_plugin {
                            execution.outcome = ToolOutcome::Unknown;
                            *status = ToolStatus::Failed;
                            *success = Some(false);
                            *content_items = Some(vec![
                                serde_json::json!({"type":"inputText","text":"UNKNOWN: Core restarted before the tool result was confirmed; inspect the workspace; do not replay"}),
                            ]);
                        }
                        turn.status = TurnStatus::Failed;
                        turn.error = Some(crate::outcome::infrastructure(
                            "recovered an UNKNOWN tool outcome; inspection is required",
                            "core_recovery",
                            "unknown_tool_outcome",
                        ));
                        repaired = true;
                    }
                }
            }
            if let Some(data) = &mut record.thread.desktop {
                for process in &mut data.processes {
                    if !process.cleanup_confirmed {
                        process.state = "unknown".into();
                        process.error = Some(
                            "Core restarted; old Runtime resources cannot be recovered".into(),
                        );
                        repaired = true;
                    }
                    for input in &mut process.inputs {
                        if input.outcome == "running" {
                            input.outcome = "unknown".into();
                            repaired = true;
                        }
                    }
                }
                for interaction in &mut data.interactions {
                    if interaction.status == "pending" {
                        interaction.status = "expired".into();
                        data.interaction_revision += 1;
                        repaired = true;
                    }
                }
                if data
                    .queue
                    .items
                    .iter()
                    .any(|item| matches!(item.status.as_str(), "pending" | "running"))
                {
                    data.queue.paused = true;
                    data.queue.pause_reason =
                        Some("Core restarted; inspect execution and explicitly resume".into());
                    data.queue.revision += 1;
                    for item in &mut data.queue.items {
                        if item.status == "running" {
                            item.status = "interrupted".into();
                        }
                    }
                    repaired = true;
                }
            }
            record.thread.status = ThreadStatus::Idle;
            if repaired {
                atomic_write(&self.root, &record.thread)?;
            }
            if record.thread.desktop.as_ref().is_some_and(|d| d.archived) {
                record.thread.turns.clear();
                record.thread.context_checkpoint = None;
            }
            threads.push(record.thread);
        }
        Ok(threads)
    }

    pub(crate) async fn read_thread(&self, id: &str) -> Result<Thread> {
        anyhow::ensure!(uuid::Uuid::parse_str(id).is_ok(), "invalid thread ID");
        let bytes = tokio::fs::read(self.root.join(format!("{id}.json"))).await?;
        self.hydrate(serde_json::from_slice::<Record>(&bytes)?.thread)
            .await
    }
    pub(crate) async fn collect_blobs(&self) -> Result<serde_json::Value> {
        let serial = self.blob_write.clone().lock_owned().await;
        let root = self.root.clone();
        tokio::task::spawn_blocking(move||->Result<_>{
            let _serial=serial;let mut keep=std::collections::BTreeSet::<String>::new();
            let mut history = std::collections::BTreeSet::new();
            fn visit(v:&serde_json::Value,keep:&mut std::collections::BTreeSet<String>){match v{serde_json::Value::String(s)=>{if let Some(id)=s.strip_prefix("areal://blob/"){keep.insert(id.into());}},serde_json::Value::Array(v)=>{for x in v{visit(x,keep);}},serde_json::Value::Object(v)=>{for x in v.values(){visit(x,keep);}},_=>{}}}
            for e in std::fs::read_dir(&root)?{let p=e?.path();if p.extension().and_then(|s|s.to_str())==Some("json"){let record:Record=serde_json::from_slice(&std::fs::read(p)?)?;visit(&serde_json::to_value(&record.thread)?,&mut keep);
                archive::visit_segments(&root, record.thread.history_archive, &mut history, |turns| { visit(&serde_json::to_value(turns)?, &mut keep); Ok(()) })?;
                if let Some(areal_protocol::Conversation::Fork { history_seed, .. }) = &record.thread.conversation {
                    history.insert(history_seed.snapshot_id.clone());
                    let turns = archive::read_segment(&root, &history_seed.snapshot_id)?.turns;
                    visit(&serde_json::to_value(turns)?, &mut keep);
                }
                if let Some(areal_protocol::Conversation::Side { reference_snapshot, .. }) = &record.thread.conversation {
                    history.insert(reference_snapshot.snapshot_id.clone());
                    let turns = archive::read_segment(&root, &reference_snapshot.snapshot_id)?.turns;
                    visit(&serde_json::to_value(turns)?, &mut keep);
                }
            }}
            let mut deleted=0;let mut reclaimed=0;let mut retained=0;
            for e in std::fs::read_dir(root.join("blobs"))?{let e=e?;let name=e.file_name().to_string_lossy().into_owned();if name.len()!=64||!name.bytes().all(|c|c.is_ascii_hexdigit())||!e.file_type()?.is_file(){continue;}
if keep.contains(&name){retained+=e.metadata()?.len();}else{reclaimed+=e.metadata()?.len();std::fs::remove_file(e.path())?;deleted+=1;}}
            if root.join("history").exists() {
                for entry in std::fs::read_dir(root.join("history"))? {
                    let entry = entry?;
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name.len() == 64 && name.bytes().all(|b| b.is_ascii_hexdigit()) && entry.file_type()?.is_file() && !history.contains(&name) {
                        std::fs::remove_file(entry.path())?;
                    }
                }
                File::open(root.join("history"))?.sync_all()?;
            }
            File::open(root.join("blobs"))?.sync_all()?;
            Ok(serde_json::json!({"deletedBlobs":deleted,"reclaimedBytes":reclaimed,"retainedBytes":retained}))
        }).await?
    }

    pub(crate) async fn save_metadata(&self, name: &str, value: &impl Serialize) -> Result<()> {
        let bytes = serde_json::to_vec(value)?;
        let root = self.root.join("desktop");
        let name = name.to_owned();
        tokio::task::spawn_blocking(move || atomic_metadata(&root, &name, &bytes)).await?
    }
    pub(crate) fn save_metadata_sync(&self, name: &str, value: &impl Serialize) -> Result<()> {
        atomic_metadata(
            &self.root.join("desktop"),
            name,
            &serde_json::to_vec(value)?,
        )
    }

    pub(crate) async fn save_encoded(&self, id: &str, bytes: Vec<u8>) -> Result<()> {
        let queued = std::time::Instant::now();
        let permit = self.io.clone().acquire_owned().await?;
        let root = self.root.clone();
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            tracing::debug!(target: "areal::persistence", thread_id = %id,
                queue_ms = queued.elapsed().as_secs_f64() * 1000.0, "thread write admitted");
            atomic_write_encoded(&root, &id, &bytes)
        })
        .await??;
        #[cfg(test)]
        self.check_fork_fault(ForkFault::AfterPersistError)
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        Ok(())
    }

    pub async fn save_blob(&self, mime_type: String, bytes: Vec<u8>) -> Result<MediaRef> {
        let serial = self.blob_write.clone().lock_owned().await;
        let permit = self.io.clone().acquire_owned().await?;
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let _serial = serial;
            atomic_write_blob(&root, mime_type, bytes)
        })
        .await?
    }

    pub async fn read_blob(&self, id: &str) -> Result<Vec<u8>> {
        Ok(tokio::fs::read(self.blob_path(id)?).await?)
    }

    /// Diagnostics are outside replayable thread history and contain no headers.
    pub async fn save_audit(&self, value: serde_json::Value) -> Result<()> {
        let permit = self.io.clone().acquire_owned().await?;
        let directory = self.root.join("audit");
        tokio::task::spawn_blocking(move || -> Result<()> {
            let _permit = permit;
            let _gate = crate::diagnostics::lock(&directory)?;
            crate::diagnostics::atomic_write(
                &directory,
                &directory.join(format!("{}.json", uuid::Uuid::new_v4())),
                &crate::diagnostics::encode(&value),
            )?;
            // 非权威审计按容量回收；锁内完成发布和清理，不能与并发写入竞争。
            crate::diagnostics::prune(
                &directory,
                crate::diagnostics::CORE_AUDIT,
                std::time::SystemTime::now(),
                |_| Ok(false),
            )?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    pub(crate) fn blob_path(&self, id: &str) -> Result<PathBuf> {
        if id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            bail!("invalid blob id");
        }
        Ok(self.root.join("blobs").join(id))
    }
}

pub(crate) fn encode(thread: &Thread) -> Result<Vec<u8>> {
    #[derive(Serialize)]
    struct BorrowedRecord<'a> {
        version: u32,
        thread: &'a Thread,
    }
    Ok(serde_json::to_vec(&BorrowedRecord {
        version: STATE_VERSION,
        thread,
    })?)
}

fn atomic_write(root: &Path, thread: &Thread) -> Result<()> {
    atomic_write_encoded(root, &thread.id, &encode(thread)?)
}

fn atomic_write_encoded(root: &Path, id: &str, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let started = std::time::Instant::now();
    let path = root.join(format!("{id}.json"));
    let mut file = tempfile::NamedTempFile::new_in(root)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(bytes)?;
    file.flush()?;
    let write_ms = started.elapsed().as_secs_f64() * 1000.0;
    let syncing = std::time::Instant::now();
    file.as_file().sync_all()?;
    file.persist(path)?;
    #[cfg(unix)]
    File::open(root)?.sync_all()?;
    tracing::debug!(target: "areal::persistence", thread_id = %id, bytes = bytes.len(),
        write_ms, sync_ms = syncing.elapsed().as_secs_f64() * 1000.0, "thread durably committed");
    Ok(())
}

fn atomic_write_blob(root: &Path, mime_type: String, bytes: Vec<u8>) -> Result<MediaRef> {
    use std::io::Write;
    let id = format!("{:x}", Sha256::digest(&bytes));
    let directory = root.join("blobs");
    let path = directory.join(&id);
    if !path.exists() {
        let mut file = tempfile::Builder::new()
            .prefix(&format!("{id}."))
            .suffix(".tmp")
            .tempfile_in(&directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(&bytes)?;
        file.flush()?;
        file.as_file().sync_all()?;
        if path.exists() {
            drop(file);
        } else {
            file.persist(&path)?;
        }
        #[cfg(unix)]
        File::open(&directory)?.sync_all()?;
    }
    Ok(MediaRef {
        uri: format!("areal://blob/{id}"),
        mime_type,
        size_bytes: bytes.len() as u64,
    })
}

fn cleanup_temps(root: &Path) -> Result<()> {
    for relative in [
        "",
        "blobs",
        "history",
        "goals",
        "goals/requests",
        "desktop",
        "security",
    ] {
        // 逐级检查，避免 goals 是符号链接时经由 goals/requests 清理外部目录。
        let mut current = root.to_path_buf();
        let mut safe = true;
        for component in Path::new(relative).components() {
            current.push(component);
            if !std::fs::symlink_metadata(&current)
                .is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink())
            {
                safe = false;
                break;
            }
        }
        if !safe {
            continue;
        }
        let directory = root.join(relative);
        let metadata = match std::fs::symlink_metadata(&directory) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            continue;
        }
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let blob_temp = relative == "blobs"
                && name.ends_with(".tmp")
                && name
                    .split('.')
                    .next()
                    .is_some_and(|id| id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()));
            if entry.file_type()?.is_file() && (name.starts_with(".tmp") || blob_temp) {
                std::fs::remove_file(entry.path())?;
            }
        }
    }
    Ok(())
}

fn atomic_metadata(root: &Path, name: &str, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    std::fs::create_dir_all(root)?;
    let mut file = tempfile::NamedTempFile::new_in(root)?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    file.persist(root.join(format!("{name}.json")))?;
    #[cfg(unix)]
    File::open(root)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovered_plugin_operations_preserve_facts_and_block_replay() {
        for outcome in ["running", "succeeded"] {
            let directory = tempfile::tempdir().unwrap();
            let id = uuid::Uuid::new_v4().to_string();
            let operation = |outcome| serde_json::json!({"operationId":format!("op-{outcome}"),"kind":"write","path":"workspace://repo/src/a","requestSha256":"digest","outcome":outcome,"result":null});
            let execution = serde_json::json!({"backend":"plugin","runtimeEpoch":"epoch","scopeId":"turn-scope","operationId":"call-op","outcome":outcome,
                "plugin":{"pluginId":"editor","generation":"editor:1","scopeId":"call-scope","operations":[operation("succeeded"),operation("running")]}});
            let item = serde_json::json!({"type":"dynamicToolCall","id":"item","callId":"call","tool":"editor","arguments":{},"status":"completed","success":true,"contentItems":[],"execution":execution});
            let turn =
                serde_json::json!({"id":"turn","status":"completed","error":null,"items":[item]});
            let thread = serde_json::json!({"id":id,"sessionId":id,"parentThreadId":null,"preview":"plugin","modelProvider":"test","createdAt":0,"updatedAt":0,"status":{"type":"idle"},"cwd":"/tmp","cliVersion":"test","source":"appServer","ephemeral":false,"turns":[turn]});
            let record = serde_json::json!({"version":5,"thread":thread});
            let file = directory.path().join(format!("{id}.json"));
            std::fs::write(&file, serde_json::to_vec(&record).unwrap()).unwrap();
            let store = Store::open(directory.path()).unwrap();
            let threads = store.load(10, 1024 * 1024).unwrap();
            assert_eq!(threads[0].turns[0].status, TurnStatus::Failed);
            let Item::DynamicToolCall {
                execution, success, ..
            } = &threads[0].turns[0].items[0]
            else {
                panic!()
            };
            assert_eq!(execution.outcome, ToolOutcome::Unknown);
            assert_eq!(*success, Some(false));
            let operations = &execution.plugin.as_ref().unwrap().operations;
            assert_eq!(operations[0].outcome, ToolOutcome::Succeeded);
            assert_eq!(operations[1].outcome, ToolOutcome::Unknown);
            let stored: serde_json::Value =
                serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
            assert_eq!(
                stored["thread"]["turns"][0]["items"][0]["execution"]["outcome"],
                "unknown"
            );
        }
    }

    #[tokio::test]
    async fn concurrent_identical_blobs_are_content_addressed() {
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(directory.path()).unwrap());
        let first = store.save_blob("image/png".into(), b"same".to_vec());
        let second = store.save_blob("image/png".into(), b"same".to_vec());
        let (first, second) = tokio::join!(first, second);
        let first = first.unwrap();
        let second = second.unwrap();
        assert_eq!(first.uri, second.uri);
        let id = first.uri.strip_prefix("areal://blob/").unwrap();
        assert_eq!(store.read_blob(id).await.unwrap(), b"same");
        assert!(
            std::fs::read_dir(directory.path().join("blobs"))
                .unwrap()
                .all(|entry| !entry.unwrap().path().to_string_lossy().ends_with(".tmp"))
        );
    }
    #[test]
    fn crash_temps_require_store_ownership_and_preserve_authority() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let store = Store::open(root).unwrap();
        let staging = root.join(".tmpcrashed");
        std::fs::write(&staging, b"partial").unwrap();
        assert!(Store::open(root).is_err());
        assert!(staging.exists());
        drop(store);
        std::fs::write(root.join("goal.json"), b"keep").unwrap();
        std::fs::create_dir_all(root.join("goals/requests")).unwrap();
        std::fs::write(root.join("goals/requests/.tmpcrashed"), b"partial").unwrap();
        let _store = Store::open(root).unwrap();
        assert!(!staging.exists() && !root.join("goals/requests/.tmpcrashed").exists());
        assert!(root.join("goal.json").exists());
    }

    #[test]
    fn crash_cleanup_does_not_follow_parent_symlinks() {
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(outside.path().join("requests")).unwrap();
        let sentinel = outside.path().join("requests/.tmpkeep");
        std::fs::write(&sentinel, b"keep").unwrap();
        std::os::unix::fs::symlink(outside.path(), directory.path().join("goals")).unwrap();
        cleanup_temps(directory.path()).unwrap();
        assert!(sentinel.exists());
    }
}
