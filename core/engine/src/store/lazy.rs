//! 目录缓存不是提交点：先核对事实身份，失效时走原恢复，只有正文恢复后才能写快照。
use super::*;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

const CACHE_LIMIT: u64 = 256 * 1024 * 1024;
const ROW_LIMIT: usize = 4 * 1024 * 1024;
const APPLICATION: i64 = 0x4152_4c4d;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct Stamp {
    len: u64,
    dev: u64,
    ino: u64,
    modified: (i64, i64),
    changed: (i64, i64),
    mode: u32,
}

impl Stamp {
    fn read(path: &Path) -> Result<Self> {
        let metadata = std::fs::symlink_metadata(path)?;
        anyhow::ensure!(metadata.is_file(), "cache source must be a regular file");
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            anyhow::ensure!(metadata.nlink() == 1, "cache source must have one link");
            Ok(Self {
                len: metadata.len(),
                dev: metadata.dev(),
                ino: metadata.ino(),
                modified: (metadata.mtime(), metadata.mtime_nsec()),
                changed: (metadata.ctime(), metadata.ctime_nsec()),
                mode: metadata.mode(),
            })
        }
        #[cfg(not(unix))]
        anyhow::bail!("metadata cache identity is unsupported on this platform")
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Dependency {
    digest: String,
    stamp: Stamp,
}

#[derive(Clone, Serialize, Deserialize)]
struct Cached {
    id: String,
    stamp: Stamp,
    fact_hash: String,
    dependency: Option<Dependency>,
    activity_at: i64,
    metadata: String,
    checksum: String,
}

impl Cached {
    fn checksum(&self) -> Result<String> {
        Ok(format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                &self.id,
                &self.stamp,
                &self.fact_hash,
                &self.dependency,
                self.activity_at,
                &self.metadata,
            ))?)
        ))
    }
    fn valid(&self, root: &Path, stamp: &Stamp, max_bytes: usize) -> bool {
        self.stamp == *stamp
            && self.metadata.len() <= ROW_LIMIT
            && safe_digest(&self.fact_hash)
            && self.checksum().is_ok_and(|v| v == self.checksum)
            && self.thread().is_ok_and(|thread| {
                thread.id == self.id
                    && thread.turns.len() <= 1
                    && thread.turns.iter().all(|turn| turn.items.is_empty())
                    && thread.context_checkpoint.is_none()
                    && self.activity_at >= crate::catalog::latest_activity_at(&thread)
                    && eligible(&thread)
                    && (max_bytes == 0
                        || stamp
                            .len
                            .saturating_add(thread.history_archive.as_ref().map_or(0, |a| a.bytes))
                            <= max_bytes as u64)
                    && match (&thread.history_archive, &self.dependency) {
                        (None, None) => true,
                        (Some(reference), Some(dependency))
                            if reference.head == dependency.digest =>
                        {
                            safe_digest(&dependency.digest)
                                && Stamp::read(&root.join("history").join(&dependency.digest))
                                    .is_ok_and(|s| s == dependency.stamp)
                        }
                        _ => false,
                    }
            })
    }
    fn thread(&self) -> Result<Thread> {
        Ok(serde_json::from_str(&self.metadata)?)
    }
}

fn safe_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn restored_activity_at(thread: &Thread) -> i64 {
    // 归档在原恢复语义中不常驻正文；其空闲状态只观察 updated_at。
    if thread.desktop.as_ref().is_some_and(|d| d.archived) {
        thread.updated_at.max(0)
    } else {
        crate::catalog::latest_activity_at(thread)
    }
}

fn eligible(thread: &Thread) -> bool {
    thread.parent_thread_id.is_none() && thread.session_id == thread.id
        && thread.conversation.is_none() && thread.goal_owner.is_none() && thread.goals.is_empty()
        && matches!(thread.source.as_str(), "appServer" | "cli" | "exec")
        && thread.turns.iter().all(|turn| turn.status != TurnStatus::InProgress && turn.goal.is_none()
            && turn.items.iter().all(|item| !matches!(item, Item::DynamicToolCall {execution,..}
                if matches!(execution.outcome, ToolOutcome::Running | ToolOutcome::Unknown)
                    || execution.hooks.iter().any(|hook| matches!(hook.outcome, ToolOutcome::Running | ToolOutcome::Unknown))
                    || execution.plugin.as_ref().is_some_and(|plugin| plugin.operations.iter().any(|op| matches!(op.outcome, ToolOutcome::Running | ToolOutcome::Unknown))))))
        && !thread.desktop.as_ref().is_some_and(|d| {
            !d.processes.is_empty()
                || d.interactions.iter().any(|i| i.status == "pending")
                || d.queue.items.iter().any(|i| matches!(i.status.as_str(), "pending" | "running"))
                || (d.configuration.model.is_none() && d.configuration.default_model_revision.is_none()
                    && thread.turns.last().and_then(|t| t.configuration.as_ref()).is_some_and(|c| c.default_model_revision.is_some()))
        })
}

enum Content {
    Eager(Box<Thread>),
    Deferred(Box<Cached>),
}
pub(crate) struct RestoredSession {
    pub id: String,
    pub session_id: String,
    pub parent_thread_id: Option<String>,
    content: Content,
}

impl From<Thread> for RestoredSession {
    fn from(thread: Thread) -> Self {
        Self {
            id: thread.id.clone(),
            session_id: thread.session_id.clone(),
            parent_thread_id: thread.parent_thread_id.clone(),
            content: Content::Eager(Box::new(thread)),
        }
    }
}

impl RestoredSession {
    fn deferred(row: Cached) -> Self {
        Self {
            id: row.id.clone(),
            session_id: row.id.clone(),
            parent_thread_id: None,
            content: Content::Deferred(Box::new(row)),
        }
    }
    pub(crate) fn is_deferred(&self) -> bool {
        matches!(self.content, Content::Deferred(_))
    }
    pub(crate) fn deferred_activity_at(&self) -> Option<i64> {
        match &self.content {
            Content::Deferred(row) => Some(row.activity_at),
            Content::Eager(_) => None,
        }
    }
    pub(crate) fn into_thread(self) -> Result<Thread> {
        match self.content {
            Content::Eager(thread) => Ok(*thread),
            Content::Deferred(row) => row.thread(),
        }
    }
}

#[derive(Default)]
pub(super) struct LazyState {
    enabled: AtomicBool,
    sqlite: AtomicBool,
    pending: Mutex<BTreeMap<String, (Stamp, String, bool)>>,
    rejected: AtomicBool,
    parsed: AtomicU64,
    parsed_bytes: AtomicU64,
    cache_hits: AtomicU64,
    cache_errors: AtomicU64,
    materialized: AtomicU64,
}

fn source_key() -> &'static str {
    static KEY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    KEY.get_or_init(|| {
        let mut hash = Sha256::new();
        // 恢复与协议改变即失效，不把同一包版本下的旧派生投影当成新规则已验证的事实。
        for source in [
            include_bytes!("../store.rs").as_slice(),
            include_bytes!("lazy.rs").as_slice(),
            include_bytes!("../lib.rs").as_slice(),
            include_bytes!("../catalog.rs").as_slice(),
            include_bytes!("../default_model.rs").as_slice(),
            include_bytes!("../dormant.rs").as_slice(),
            include_bytes!("../tools/registry.rs").as_slice(),
            include_bytes!("archive.rs").as_slice(),
            include_bytes!("archive/own.rs").as_slice(),
            include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../Cargo.lock")).as_slice(),
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../protocol/src/tasks.rs"
            ))
            .as_slice(),
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../protocol/src/work.rs"
            ))
            .as_slice(),
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../protocol/src/delegation.rs"
            ))
            .as_slice(),
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../protocol/src/service.rs"
            ))
            .as_slice(),
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../protocol/src/lib.rs"
            ))
            .as_slice(),
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../protocol/src/desktop.rs"
            ))
            .as_slice(),
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../protocol/src/goals.rs"
            ))
            .as_slice(),
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../protocol/src/context.rs"
            ))
            .as_slice(),
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../protocol/src/plugin_runtime.rs"
            ))
            .as_slice(),
        ] {
            hash.update(source);
        }
        format!("{:x}", hash.finalize())
    })
}

impl Store {
    pub(crate) fn is_deferred(&self, id: &str) -> bool {
        self.lazy.enabled.load(Ordering::Relaxed)
            && self.lazy.pending.lock().unwrap().contains_key(id)
    }
    pub(crate) fn loading_metrics(&self) -> serde_json::Value {
        serde_json::json!({"lazy":self.lazy.enabled.load(Ordering::Relaxed),
            "metadataBackend":if !self.lazy.enabled.load(Ordering::Relaxed) { None } else if self.lazy.sqlite.load(Ordering::Relaxed) { Some("sqlite") } else { Some("json") },
            "deferredSessions":self.lazy.pending.lock().unwrap().len(),
            "factsParsed":self.lazy.parsed.load(Ordering::Relaxed),
            "factBytesParsed":self.lazy.parsed_bytes.load(Ordering::Relaxed),
            "cacheHits":self.lazy.cache_hits.load(Ordering::Relaxed),
            "cacheErrors":self.lazy.cache_errors.load(Ordering::Relaxed),
            "historyMaterializations":self.lazy.materialized.load(Ordering::Relaxed)})
    }
    pub(crate) fn count_parse(&self, bytes: usize) {
        self.lazy.parsed.fetch_add(1, Ordering::Relaxed);
        self.lazy
            .parsed_bytes
            .fetch_add(bytes as u64, Ordering::Relaxed);
    }
    pub(crate) fn load_catalog(
        &self,
        max_threads: usize,
        max_bytes: usize,
        sqlite: bool,
    ) -> Result<Vec<RestoredSession>> {
        self.lazy.enabled.store(true, Ordering::Relaxed);
        self.lazy.sqlite.store(sqlite, Ordering::Relaxed);
        let mut cache = match MetadataCache::open(&self.root, sqlite) {
            Ok(cache) => Some(cache),
            Err(error) => {
                self.cache_failure(&error);
                if disposable(&error) {
                    reject_cache(&self.root, sqlite)
                        .and_then(|_| MetadataCache::open(&self.root, sqlite))
                        .ok()
                } else {
                    None
                }
            }
        };
        let (mut rows, mut changed) = match cache.as_mut().map(|cache| cache.read(max_threads)) {
            Some(Ok(rows)) => (rows, false),
            Some(Err(error)) => {
                self.cache_failure(&error);
                // 格式损坏先保留；与数据库忙、权限错误不同，不能直接覆盖未知原字节。
                if disposable(&error) {
                    drop(cache.take());
                    match reject_cache(&self.root, sqlite)
                        .and_then(|_| MetadataCache::open(&self.root, sqlite))
                    {
                        Ok(rebuilt) => cache = Some(rebuilt),
                        Err(error) => self.cache_failure(&error),
                    }
                } else {
                    // 未知版本、权限或占用问题不构成可覆盖原缓存的授权。
                    drop(cache.take());
                }
                (BTreeMap::new(), true)
            }
            None => (BTreeMap::new(), true),
        };
        let original: BTreeSet<_> = rows.keys().cloned().collect();
        let mut updates = BTreeSet::new();
        let mut restored = Vec::new();
        for entry in std::fs::read_dir(&self.root)? {
            let path = entry?.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            anyhow::ensure!(
                restored.len() < max_threads,
                "stored thread count exceeds configured limit"
            );
            let id = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or_default();
            let stamp = Stamp::read(&path).ok();
            if let (Some(stamp), Some(row)) = (&stamp, rows.remove(id))
                && row.id == id
                && row.valid(&self.root, stamp, max_bytes)
            {
                self.lazy.cache_hits.fetch_add(1, Ordering::Relaxed);
                self.lazy.pending.lock().unwrap().insert(
                    row.id.clone(),
                    (row.stamp.clone(), row.fact_hash.clone(), true),
                );
                restored.push(RestoredSession::deferred(row));
                continue;
            }
            changed = true;
            updates.insert(id.to_owned());
            let mut digest = String::new();
            let mut thread = self.load_record(&path, max_bytes, Some(&mut digest), true)?;
            let stamp = Stamp::read(&path).ok();
            if eligible(&thread)
                && let Some(stamp) = stamp
            {
                let dependency = thread
                    .history_archive
                    .as_ref()
                    .map(|reference| {
                        Ok::<_, anyhow::Error>(Dependency {
                            digest: reference.head.clone(),
                            stamp: Stamp::read(&self.root.join("history").join(&reference.head))?,
                        })
                    })
                    .transpose();
                if let Ok(dependency) = dependency {
                    let mut projection = crate::catalog::metadata(&thread);
                    projection.history_archive = thread.history_archive.clone();
                    // 全局工作概览需要尾轮身份与状态；正文仍为空，不能用此投影写事实。
                    if !thread.desktop.as_ref().is_some_and(|d| d.archived)
                        && let Some(turn) = thread.turns.last()
                    {
                        projection.turns.push(areal_protocol::Turn {
                            id: turn.id.clone(),
                            items: Vec::new(),
                            status: turn.status.clone(),
                            error: turn.error.clone(),
                            interruption: turn.interruption.clone(),
                            continued_from_turn_id: turn.continued_from_turn_id.clone(),
                            started_at: turn.started_at,
                            completed_at: turn.completed_at,
                            duration_ms: turn.duration_ms,
                            goal: None,
                            instruction_snapshot: None,
                            instruction_attribution: None,
                            generation: None,
                            configuration: None,
                            usage: turn.usage.clone(),
                        });
                    }
                    let metadata = serde_json::to_string(&projection)?;
                    if metadata.len() <= ROW_LIMIT {
                        let mut row = Cached {
                            id: thread.id.clone(),
                            stamp,
                            fact_hash: digest,
                            dependency,
                            activity_at: restored_activity_at(&thread),
                            metadata,
                            checksum: String::new(),
                        };
                        row.checksum = row.checksum()?;
                        self.lazy.pending.lock().unwrap().insert(
                            row.id.clone(),
                            (row.stamp.clone(), row.fact_hash.clone(), false),
                        );
                        restored.push(RestoredSession::deferred(row));
                        continue;
                    }
                }
            }
            if thread.desktop.as_ref().is_some_and(|d| d.archived) {
                thread.turns.clear();
                thread.context_checkpoint = None;
            }
            restored.push(thread.into());
        }
        let desired: BTreeSet<_> = restored
            .iter()
            .filter(|r| r.is_deferred())
            .map(|r| r.id.clone())
            .collect();
        changed |= original != desired;
        if changed
            && let Some(cache) = cache.as_mut()
            && let Err(error) = cache.write(&restored, &updates)
        {
            self.cache_failure(&error);
        }
        Ok(restored)
    }
    fn cache_failure(&self, error: &anyhow::Error) {
        self.lazy.cache_errors.fetch_add(1, Ordering::Relaxed);
        tracing::warn!(target:"areal::catalog", %error, "metadata cache unavailable; facts remain authoritative");
    }
    pub(crate) async fn materialize(
        &self,
        id: &str,
        max_bytes: usize,
        activity_at: i64,
    ) -> Result<Thread> {
        let (stamp, digest, _) = self
            .lazy
            .pending
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .context("missing deferred source")?;
        let path = self.root.join(format!("{id}.json"));
        let id = id.to_owned();
        let permit = self.fork_reads.clone().acquire_owned().await?;
        let thread = tokio::task::spawn_blocking(move || -> Result<Thread> {
            let _permit = permit;
            anyhow::ensure!(
                Stamp::read(&path)? == stamp,
                "deferred facts changed; restart Core before using this session"
            );
            let bytes = std::fs::read(&path)?;
            anyhow::ensure!(
                Stamp::read(&path)? == stamp && format!("{:x}", Sha256::digest(&bytes)) == digest,
                "deferred facts identity mismatch"
            );
            let record: Record = serde_json::from_slice(&bytes)?;
            anyhow::ensure!(
                uuid::Uuid::parse_str(&id).is_ok() && eligible(&record.thread),
                "deferred facts require full recovery; restart Core"
            );
            anyhow::ensure!(
                max_bytes == 0
                    || (bytes.len() as u64)
                        .saturating_add(
                            record
                                .thread
                                .history_archive
                                .as_ref()
                                .map_or(0, |a| a.bytes)
                        )
                        .saturating_add(match &record.thread.conversation {
                            Some(areal_protocol::Conversation::Fork { history_seed, .. }) =>
                                history_seed.logical_bytes as u64,
                            Some(areal_protocol::Conversation::Side {
                                reference_snapshot, ..
                            }) => reference_snapshot.logical_bytes as u64,
                            _ => 0,
                        })
                        <= max_bytes as u64,
                "deferred session exceeds configured history limit"
            );
            anyhow::ensure!(
                (1..=STATE_VERSION).contains(&record.version) && record.thread.id == id,
                "deferred session identity mismatch"
            );
            anyhow::ensure!(
                restored_activity_at(&record.thread) == activity_at,
                "deferred activity differs from authoritative facts; restart Core"
            );
            Ok(record.thread)
        })
        .await??;
        Ok(thread)
    }
    pub(crate) fn materialized(&self, id: &str) {
        self.lazy.pending.lock().unwrap().remove(id);
        self.lazy.materialized.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) async fn reject_cached_projection(
        &self,
        id: &str,
        sqlite: bool,
        max_threads: usize,
    ) {
        let reused = self
            .lazy
            .pending
            .lock()
            .unwrap()
            .get(id)
            .is_some_and(|(_, _, reused)| *reused);
        if !reused || self.lazy.rejected.swap(true, Ordering::AcqRel) {
            return;
        }
        let root = self.root.clone();
        // 错投影必须在下次启动重新验证事实；先确认缓存格式，不能移动未知版本的数据。
        let result = tokio::task::spawn_blocking(move || -> Result<()> {
            let validated =
                MetadataCache::open(&root, sqlite).and_then(|mut cache| cache.read(max_threads));
            match validated {
                Ok(_) => reject_cache(&root, sqlite),
                Err(error) if disposable(&error) => reject_cache(&root, sqlite),
                Err(error) => Err(error),
            }
        })
        .await;
        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => self.cache_failure(&error),
            Err(error) => self.cache_failure(&error.into()),
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    version: u32,
    source: String,
    checksum: String,
    rows: Box<serde_json::value::RawValue>,
}

enum MetadataCache {
    Json(PathBuf),
    Sqlite(rusqlite::Connection),
}

#[derive(Debug)]
struct InvalidMetadataCache(&'static str);

impl std::fmt::Display for InvalidMetadataCache {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for InvalidMetadataCache {}

fn disposable(error: &anyhow::Error) -> bool {
    error.downcast_ref::<InvalidMetadataCache>().is_some()
        || error.downcast_ref::<serde_json::Error>().is_some()
        || error.downcast_ref::<rusqlite::Error>().is_some_and(|e| {
            matches!(e,
            rusqlite::Error::SqliteFailure(code, _) if matches!(code.code,
                rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase))
        })
        || error.to_string().contains("checksum mismatch")
}

fn reject_cache(root: &Path, sqlite: bool) -> Result<()> {
    let directory = root.join("catalog");
    anyhow::ensure!(
        std::fs::symlink_metadata(&directory)?.is_dir(),
        "invalid metadata cache directory"
    );
    let destination = directory.join(format!("rejected-metadata-{}", uuid::Uuid::new_v4()));
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&destination)?;
    let paths = if sqlite {
        vec![
            "metadata.sqlite3",
            "metadata.sqlite3-wal",
            "metadata.sqlite3-shm",
        ]
    } else {
        vec!["metadata.json"]
    };
    for name in paths {
        let path = directory.join(name);
        safe_file(&path)?;
        if path.exists() {
            std::fs::rename(&path, destination.join(name))?;
        }
    }
    Ok(())
}

fn safe_file(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            anyhow::ensure!(metadata.is_file(), "metadata cache must be a regular file");
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                anyhow::ensure!(metadata.nlink() == 1, "metadata cache must have one link");
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

impl MetadataCache {
    fn open(root: &Path, sqlite: bool) -> Result<Self> {
        let directory = root.join("catalog");
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        if let Err(error) = builder.create(&directory) {
            anyhow::ensure!(
                error.kind() == std::io::ErrorKind::AlreadyExists
                    && std::fs::symlink_metadata(&directory)?.is_dir(),
                "metadata cache directory is unavailable"
            );
        }
        let directory = directory.canonicalize()?;
        let path = directory.join(if sqlite {
            "metadata.sqlite3"
        } else {
            "metadata.json"
        });
        safe_file(&path)?;
        if !sqlite {
            return Ok(Self::Json(path));
        }
        for suffix in ["sqlite3-wal", "sqlite3-shm"] {
            safe_file(&path.with_extension(suffix))?;
        }
        let existing = path.exists();
        if !existing {
            let mut options = OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            options.open(&path)?;
        }
        let mut connection = rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
                | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW
                | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.busy_timeout(std::time::Duration::ZERO)?;
        connection.pragma_update(None, "trusted_schema", false)?;
        if existing {
            let application: i64 =
                connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
            let version: i64 =
                connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
            if version == 0 && application == APPLICATION {
                anyhow::bail!(InvalidMetadataCache(
                    "incomplete metadata cache initialization"
                ));
            }
            if version == 0 && application == 0 {
                let entries: i64 =
                    connection
                        .query_row("SELECT COUNT(*) FROM sqlite_schema", [], |row| row.get(0))?;
                // 空文件或空 schema 是初始化中断残片；外来表与未知版本仍原样保留。
                anyhow::ensure!(
                    entries != 0,
                    InvalidMetadataCache("incomplete metadata cache initialization")
                );
            }
            anyhow::ensure!(
                application == APPLICATION,
                "metadata cache identity mismatch"
            );
            anyhow::ensure!(version == 1, "unsupported metadata cache schema");
        }
        connection.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-1024;")?;
        if !existing {
            // 身份、schema 与版本同事务提交，避免中断后留下无法识别的半份目录。
            let transaction = connection.transaction()?;
            transaction.pragma_update(None, "application_id", APPLICATION)?;
            transaction.execute_batch("CREATE TABLE header(singleton INTEGER PRIMARY KEY CHECK(singleton=1),source TEXT NOT NULL); CREATE TABLE metadata(id TEXT PRIMARY KEY,body TEXT NOT NULL) WITHOUT ROWID; PRAGMA user_version=1;")?;
            transaction.commit()?;
        }
        Ok(Self::Sqlite(connection))
    }
    fn read(&mut self, max_threads: usize) -> Result<BTreeMap<String, Cached>> {
        let rows: Vec<Cached> = match self {
            Self::Json(path) => {
                if !path.exists() {
                    return Ok(BTreeMap::new());
                }
                anyhow::ensure!(
                    std::fs::metadata(&*path)?.len() <= CACHE_LIMIT,
                    "metadata cache exceeds bound"
                );
                let envelope: Envelope = serde_json::from_slice(&std::fs::read(&*path)?)?;
                anyhow::ensure!(envelope.version == 1, "unsupported metadata cache version");
                if envelope.source != source_key() {
                    return Ok(BTreeMap::new());
                }
                anyhow::ensure!(
                    format!("{:x}", Sha256::digest(envelope.rows.get().as_bytes()))
                        == envelope.checksum,
                    "metadata cache checksum mismatch"
                );
                serde_json::from_str(envelope.rows.get())?
            }
            Self::Sqlite(connection) => {
                use rusqlite::OptionalExtension;
                let source: Option<String> = connection
                    .query_row("SELECT source FROM header WHERE singleton=1", [], |row| {
                        row.get(0)
                    })
                    .optional()?;
                if source.as_deref() != Some(source_key()) {
                    return Ok(BTreeMap::new());
                }
                let mut result = Vec::new();
                let mut statement =
                    connection.prepare("SELECT body FROM metadata ORDER BY id LIMIT ?1")?;
                let mut cursor =
                    statement.query([i64::try_from(max_threads.saturating_add(1))?])?;
                while let Some(row) = cursor.next()? {
                    let body: String = row.get(0)?;
                    anyhow::ensure!(
                        body.len() <= ROW_LIMIT * 2 + 4096,
                        InvalidMetadataCache("metadata row exceeds bound")
                    );
                    result.push(serde_json::from_str(&body)?);
                }
                result
            }
        };
        anyhow::ensure!(
            rows.len() <= max_threads,
            InvalidMetadataCache("metadata cache row limit exceeded")
        );
        let count = rows.len();
        let rows: BTreeMap<_, _> = rows.into_iter().map(|row| (row.id.clone(), row)).collect();
        anyhow::ensure!(
            rows.len() == count,
            InvalidMetadataCache("duplicate metadata cache identity")
        );
        Ok(rows)
    }
    fn write(&mut self, sessions: &[RestoredSession], updates: &BTreeSet<String>) -> Result<()> {
        let rows: Vec<_> = sessions
            .iter()
            .filter_map(|s| match &s.content {
                Content::Deferred(row) => Some(row.as_ref()),
                _ => None,
            })
            .collect();
        match self {
            Self::Json(path) => {
                let encoded = serde_json::to_string(&rows)?;
                anyhow::ensure!(
                    encoded.len() as u64 <= CACHE_LIMIT,
                    "metadata cache exceeds bound"
                );
                let envelope = Envelope {
                    version: 1,
                    source: source_key().into(),
                    checksum: format!("{:x}", Sha256::digest(encoded.as_bytes())),
                    rows: serde_json::value::RawValue::from_string(encoded)?,
                };
                let bytes = serde_json::to_vec(&envelope)?;
                anyhow::ensure!(
                    bytes.len() as u64 <= CACHE_LIMIT,
                    "metadata cache exceeds bound"
                );
                let temporary =
                    path.with_file_name(format!(".metadata-{}.tmp", uuid::Uuid::new_v4()));
                let mut options = OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                use std::io::Write;
                let mut file = options.open(&temporary)?;
                if let Err(error) = file
                    .write_all(&bytes)
                    .and_then(|_| std::fs::rename(&temporary, &*path))
                {
                    let _ = std::fs::remove_file(&temporary);
                    return Err(error.into());
                }
            }
            Self::Sqlite(connection) => {
                use rusqlite::OptionalExtension;
                let source: Option<String> = connection
                    .query_row("SELECT source FROM header WHERE singleton=1", [], |row| {
                        row.get(0)
                    })
                    .optional()?;
                let reset = source.as_deref() != Some(source_key());
                let transaction = connection.transaction()?;
                if reset {
                    transaction.execute("DELETE FROM metadata", [])?;
                }
                let desired: BTreeSet<_> = rows.iter().map(|row| row.id.as_str()).collect();
                let old: Vec<String> = transaction
                    .prepare("SELECT id FROM metadata")?
                    .query_map([], |r| r.get(0))?
                    .collect::<rusqlite::Result<_>>()?;
                for id in old {
                    if !desired.contains(id.as_str()) {
                        transaction.execute("DELETE FROM metadata WHERE id=?1", [id])?;
                    }
                }
                for row in rows {
                    if reset || updates.contains(&row.id) {
                        transaction.execute("INSERT INTO metadata(id,body) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET body=excluded.body", rusqlite::params![row.id,serde_json::to_string(row)?])?;
                    }
                }
                transaction.execute("INSERT INTO header VALUES(1,?1) ON CONFLICT(singleton) DO UPDATE SET source=excluded.source", [source_key()])?;
                transaction.commit()?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
