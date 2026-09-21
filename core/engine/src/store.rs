use anyhow::{Context, Result, bail};
use areal_protocol::{
    Item, MediaRef, Thread, ThreadStatus, ToolOutcome, ToolStatus, TurnError, TurnStatus,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::Semaphore;

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
        Ok(Self {
            root,
            _lock: lock,
            io: Arc::new(Semaphore::new(8)),
            blob_write: Arc::new(tokio::sync::Mutex::new(())),
        })
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
            if std::fs::metadata(&path)?.len() > max_bytes as u64 {
                bail!(
                    "stored thread exceeds configured history limit: {}",
                    path.display()
                );
            }
            let mut record: Record = serde_json::from_slice(&std::fs::read(&path)?)
                .with_context(|| format!("invalid session: {}", path.display()))?;
            if !matches!(record.version, 1..=6)
                || path.file_stem().and_then(|s| s.to_str()) != Some(&record.thread.id)
                || uuid::Uuid::parse_str(&record.thread.id).is_err()
            {
                bail!("unsupported or inconsistent session: {}", path.display());
            }
            let mut repaired = false;
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
                        turn.error = Some(TurnError {
                            message: "recovered an UNKNOWN tool outcome; inspection is required"
                                .into(),
                        });
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
        Ok(serde_json::from_slice::<Record>(&bytes)?.thread)
    }
    pub(crate) async fn collect_blobs(&self) -> Result<serde_json::Value> {
        let serial = self.blob_write.clone().lock_owned().await;
        let root = self.root.clone();
        tokio::task::spawn_blocking(move||->Result<_>{
            let _serial=serial;let mut keep=std::collections::BTreeSet::<String>::new();
            fn visit(v:&serde_json::Value,keep:&mut std::collections::BTreeSet<String>){match v{serde_json::Value::String(s)=>{if let Some(id)=s.strip_prefix("areal://blob/"){keep.insert(id.into());}},serde_json::Value::Array(v)=>{for x in v{visit(x,keep);}},serde_json::Value::Object(v)=>{for x in v.values(){visit(x,keep);}},_=>{}}}
            for e in std::fs::read_dir(&root)?{let p=e?.path();if p.extension().and_then(|s|s.to_str())==Some("json"){let record:Record=serde_json::from_slice(&std::fs::read(p)?)?;visit(&serde_json::to_value(record.thread)?,&mut keep);}}
            let mut deleted=0;let mut reclaimed=0;let mut retained=0;
            for e in std::fs::read_dir(root.join("blobs"))?{let e=e?;let name=e.file_name().to_string_lossy().into_owned();if name.len()!=64||!name.bytes().all(|c|c.is_ascii_hexdigit())||!e.file_type()?.is_file(){continue;}
if keep.contains(&name){retained+=e.metadata()?.len();}else{reclaimed+=e.metadata()?.len();std::fs::remove_file(e.path())?;deleted+=1;}}
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

    pub async fn save(&self, thread: &Thread) -> Result<()> {
        let permit = self.io.clone().acquire_owned().await?;
        let root = self.root.clone();
        let thread = thread.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            atomic_write(&root, &thread)
        })
        .await??;
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
            use std::io::Write;
            let _permit = permit;
            std::fs::create_dir_all(&directory)?;
            let mut file = tempfile::NamedTempFile::new_in(&directory)?;
            serde_json::to_writer(&mut file, &value)?;
            file.flush()?;
            file.as_file().sync_all()?;
            file.persist(directory.join(format!("{}.json", uuid::Uuid::new_v4())))?;
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

fn atomic_write(root: &Path, thread: &Thread) -> Result<()> {
    use std::io::Write;
    let path = root.join(format!("{}.json", thread.id));
    let mut file = tempfile::NamedTempFile::new_in(root)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    serde_json::to_writer(
        &mut file,
        &Record {
            version: 6,
            thread: thread.clone(),
        },
    )?;
    file.flush()?;
    file.as_file().sync_all()?;
    file.persist(path)?;
    #[cfg(unix)]
    File::open(root)?.sync_all()?;
    Ok(())
}

fn atomic_write_blob(root: &Path, mime_type: String, bytes: Vec<u8>) -> Result<MediaRef> {
    use std::io::Write;
    let id = format!("{:x}", Sha256::digest(&bytes));
    let directory = root.join("blobs");
    let path = directory.join(&id);
    if !path.exists() {
        let mut total = bytes.len() as u64;
        let mut count = 0;
        for entry in std::fs::read_dir(&directory)? {
            let metadata = entry?.metadata()?;
            total = total.saturating_add(metadata.len());
            count += 1;
            anyhow::ensure!(
                total <= 512 * 1024 * 1024 && count < 16384,
                "Blob storage budget exhausted (512 MiB / 16384 files); drain before garbage collection"
            );
        }
        let temporary = directory.join(format!("{id}.{}.tmp", uuid::Uuid::new_v4()));
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(&bytes)?;
        file.flush()?;
        file.sync_all()?;
        if path.exists() {
            std::fs::remove_file(temporary)?;
        } else {
            std::fs::rename(temporary, &path)?;
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
}
