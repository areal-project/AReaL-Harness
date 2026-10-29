//! SQLite 只保存不可变目录键；失败、积压和代际不符均回退到现有内存目录。
use super::CatalogCursor;
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, ErrorCode, OpenFlags, params};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicI64, AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};

const QUEUE: usize = 128;
const READERS: usize = 2;
const READ_DEADLINE: Duration = Duration::from_millis(250);
const CONTROL_DEADLINE: Duration = Duration::from_secs(1);
const APPLICATION_ID: i64 = 0x4152_4c43;
pub(super) type Key = (String, i64);

#[derive(Default)]
struct Shared {
    disabled: AtomicBool,
    closed: AtomicBool,
    applied: AtomicI64,
    reads: AtomicU64,
    hits: AtomicU64,
    fallbacks: AtomicU64,
    stale: AtomicU64,
    errors: AtomicU64,
    overflows: AtomicU64,
    batches: AtomicU64,
    writes: AtomicU64,
}

impl Shared {
    fn fail(&self, reason: &'static str) {
        self.errors.fetch_add(1, Ordering::Relaxed);
        if !self.disabled.swap(true, Ordering::AcqRel) {
            tracing::warn!(target: "areal::catalog", reason, "SQLite catalog disabled; using memory directory");
        }
    }
}

struct Mutation {
    epoch: i64,
    id: String,
    created_at: Option<i64>,
}

enum Write {
    Change(Mutation),
    Flush(oneshot::Sender<()>),
    Stop(oneshot::Sender<()>),
    #[cfg(test)]
    Hold(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>),
}

struct Query {
    epoch: i64,
    cursor: CatalogCursor,
    limit: usize,
    allowed: Option<Arc<str>>,
    reply: oneshot::Sender<Option<Vec<Key>>>,
}

enum Read {
    Page(Query),
    Stop(oneshot::Sender<()>),
    #[cfg(test)]
    Hold(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>),
}

pub(super) struct Index {
    writer: mpsc::Sender<Write>,
    readers: Vec<mpsc::Sender<Read>>,
    shared: Arc<Shared>,
    next_reader: AtomicUsize,
    path: PathBuf,
    reused: bool,
    rebuilt: usize,
}

impl Index {
    pub(super) fn open(root: &Path, keys: &[Key]) -> Result<Arc<Self>> {
        let directory = root.join("catalog");
        private_directory(&directory)?;
        // macOS 的 /var、/tmp 本身可为系统链接；只在核对缓存目录后使用物理路径。
        let directory = directory.canonicalize()?;
        let path = directory.join("index.sqlite3");
        let (connection, reused) = match initialize(&path, keys) {
            Ok(result) => result,
            Err(error) if disposable_error(&error) => {
                // 保留损坏或不属于本格式的文件；不删除事实文件，也不覆盖未知内容。
                let rejected = directory.join(format!("rejected-{}", uuid::Uuid::new_v4()));
                private_directory(&rejected)?;
                for source in cache_files(&path) {
                    if source.exists() {
                        safe_file(&source)?;
                        fs::rename(&source, rejected.join(source.file_name().unwrap()))?;
                    }
                }
                initialize(&path, keys).context("rebuild catalog cache")?
            }
            Err(error) => return Err(error),
        };
        let shared = Arc::new(Shared::default());
        let mut readers = Vec::with_capacity(READERS);
        for number in 0..READERS {
            let reader = Connection::open_with_flags(
                &path,
                OpenFlags::SQLITE_OPEN_READ_ONLY
                    | OpenFlags::SQLITE_OPEN_NO_MUTEX
                    | OpenFlags::SQLITE_OPEN_NOFOLLOW,
            )?;
            reader.busy_timeout(Duration::ZERO)?;
            reader.execute_batch(
                "PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA cache_size=-1024;",
            )?;
            let (sender, receiver) = mpsc::channel(QUEUE);
            let state = shared.clone();
            std::thread::Builder::new()
                .name(format!("catalog-read-{number}"))
                .spawn(move || read_loop(reader, receiver, state))?;
            readers.push(sender);
        }
        let (writer, receiver) = mpsc::channel(QUEUE);
        let state = shared.clone();
        std::thread::Builder::new()
            .name("catalog-write".into())
            .spawn(move || write_loop(connection, receiver, state))?;
        Ok(Arc::new(Self {
            writer,
            readers,
            shared,
            next_reader: AtomicUsize::new(0),
            path,
            reused,
            rebuilt: if reused { 0 } else { keys.len() },
        }))
    }

    pub(super) fn change(&self, epoch: i64, id: String, created_at: Option<i64>) {
        if self.disabled() {
            return;
        }
        if self
            .writer
            .try_send(Write::Change(Mutation {
                epoch,
                id,
                created_at,
            }))
            .is_err()
        {
            self.shared.overflows.fetch_add(1, Ordering::Relaxed);
            // 丢失索引事件以后不能继续声称目录完整；事实提交不受缓存队列影响。
            self.shared.fail("writer_queue_unavailable");
        }
    }

    pub(super) fn disabled(&self) -> bool {
        self.shared.disabled.load(Ordering::Acquire) || self.shared.closed.load(Ordering::Acquire)
    }

    pub(super) async fn page(
        &self,
        epoch: i64,
        cursor: CatalogCursor,
        limit: usize,
        allowed: Option<Arc<str>>,
    ) -> Option<Vec<Key>> {
        if self.disabled() || self.shared.applied.load(Ordering::Acquire) != epoch {
            self.shared.stale.fetch_add(1, Ordering::Relaxed);
            return None;
        }
        let (reply, result) = oneshot::channel();
        let index = self.next_reader.fetch_add(1, Ordering::Relaxed) % self.readers.len();
        if self.readers[index]
            .try_send(Read::Page(Query {
                epoch,
                cursor,
                limit,
                allowed,
                reply,
            }))
            .is_err()
        {
            return None;
        }
        match tokio::time::timeout(READ_DEADLINE, result).await {
            Ok(result) => result.ok().flatten(),
            Err(_) => {
                self.shared.fail("read_deadline");
                None
            }
        }
    }

    pub(super) fn hit(&self) {
        self.shared.hits.fetch_add(1, Ordering::Relaxed);
    }

    pub(super) fn fallback(&self) {
        self.shared.fallbacks.fetch_add(1, Ordering::Relaxed);
    }

    pub(super) fn invalid_contents(&self) {
        self.shared.fail("index_contents_mismatch");
    }

    pub(super) async fn flush(&self) {
        if self.shared.closed.load(Ordering::Acquire) {
            return;
        }
        let (reply, result) = oneshot::channel();
        if tokio::time::timeout(CONTROL_DEADLINE, async {
            if self.writer.send(Write::Flush(reply)).await.is_ok() {
                let _ = result.await;
            }
        })
        .await
        .is_err()
        {
            self.shared.fail("flush_deadline");
        }
    }

    pub(super) async fn shutdown(&self) {
        if self.shared.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        for reader in &self.readers {
            let (reply, result) = oneshot::channel();
            if tokio::time::timeout(CONTROL_DEADLINE, async {
                if reader.send(Read::Stop(reply)).await.is_ok() {
                    let _ = result.await;
                }
            })
            .await
            .is_err()
            {
                self.shared.fail("reader_stop_deadline");
            }
        }
        let (reply, result) = oneshot::channel();
        if tokio::time::timeout(CONTROL_DEADLINE, async {
            if self.writer.send(Write::Stop(reply)).await.is_ok() {
                let _ = result.await;
            }
        })
        .await
        .is_err()
        {
            self.shared.fail("writer_stop_deadline");
        }
    }

    #[cfg(test)]
    pub(super) async fn hold_writer(&self) -> std::sync::mpsc::Sender<()> {
        let (entered, wait) = std::sync::mpsc::channel();
        let (release, resume) = std::sync::mpsc::channel();
        assert!(self.writer.send(Write::Hold(entered, resume)).await.is_ok());
        wait.recv_timeout(Duration::from_secs(2)).unwrap();
        release
    }

    pub(super) fn metrics(&self) -> Value {
        let s = &self.shared;
        json!({"disabled":self.disabled(),"reused":self.reused,"rebuiltRows":self.rebuilt,
            "appliedEpoch":s.applied.load(Ordering::Acquire),
            "readRequests":s.reads.load(Ordering::Relaxed),"readHits":s.hits.load(Ordering::Relaxed),
            "fallbacks":s.fallbacks.load(Ordering::Relaxed),"stale":s.stale.load(Ordering::Relaxed),
            "errors":s.errors.load(Ordering::Relaxed),"queueOverflows":s.overflows.load(Ordering::Relaxed),
            "writeBatches":s.batches.load(Ordering::Relaxed),"rowsWritten":s.writes.load(Ordering::Relaxed),
            "databaseBytes":fs::metadata(&self.path).map_or(0, |m| m.len()),
            "walBytes":fs::metadata(self.path.with_extension("sqlite3-wal")).map_or(0, |m| m.len()),
            "sqliteVersion":rusqlite::version()})
    }
}

#[derive(Debug, thiserror::Error)]
#[error("catalog cache identity or schema is incompatible")]
struct InvalidCache;

fn disposable_error(error: &anyhow::Error) -> bool {
    error.downcast_ref::<InvalidCache>().is_some()
        || error.downcast_ref::<rusqlite::Error>().is_some_and(|error| matches!(error,
            rusqlite::Error::SqliteFailure(code, _) if matches!(code.code, ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase)))
}

fn private_directory(path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            ensure!(
                fs::symlink_metadata(path)?.file_type().is_dir(),
                "catalog cache directory is not a real directory"
            );
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

fn safe_file(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            ensure!(
                metadata.file_type().is_file(),
                "catalog cache is not a regular file"
            );
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                ensure!(metadata.nlink() == 1, "catalog cache has multiple links");
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn cache_files(path: &Path) -> [PathBuf; 3] {
    [
        path.to_owned(),
        path.with_extension("sqlite3-wal"),
        path.with_extension("sqlite3-shm"),
    ]
}

fn initialize(path: &Path, keys: &[Key]) -> Result<(Connection, bool)> {
    for path in cache_files(path) {
        safe_file(&path)?;
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let created = match options.open(path) {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
        Err(error) => return Err(error.into()),
    };
    let mut connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    connection.busy_timeout(Duration::ZERO)?;
    let application: i64 =
        connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if !created && (application != APPLICATION_ID || version != 1) {
        return Err(InvalidCache.into());
    }
    connection.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-2048;")?;
    if created {
        connection.pragma_update(None, "application_id", APPLICATION_ID)?;
        connection.execute_batch("CREATE TABLE entries(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL) WITHOUT ROWID;
            CREATE INDEX entries_created ON entries(created_at,id);
            CREATE TABLE version(singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch INTEGER NOT NULL);
            INSERT INTO version VALUES(1,0); PRAGMA user_version=1;")?;
    }
    let existing: Vec<Key> = connection
        .prepare("SELECT id,created_at FROM entries ORDER BY id")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let matches = existing == keys;
    let reused = !created && matches;
    let transaction = connection.transaction()?;
    if !matches {
        transaction.execute("DELETE FROM entries", [])?;
        let mut insert = transaction.prepare("INSERT INTO entries(id,created_at) VALUES(?1,?2)")?;
        for (id, created_at) in keys {
            insert.execute(params![id, created_at])?;
        }
    }
    if transaction.execute("UPDATE version SET epoch=0 WHERE singleton=1", [])? != 1 {
        return Err(InvalidCache.into());
    }
    transaction.commit()?;
    Ok((connection, reused))
}

fn read_loop(mut connection: Connection, mut receiver: mpsc::Receiver<Read>, shared: Arc<Shared>) {
    while let Some(job) = receiver.blocking_recv() {
        match job {
            #[cfg(test)]
            Read::Hold(entered, release) => {
                let _ = entered.send(());
                let _ = release.recv();
            }
            Read::Stop(reply) => {
                drop(connection);
                let _ = reply.send(());
                return;
            }
            Read::Page(job) => {
                shared.reads.fetch_add(1, Ordering::Relaxed);
                let result = if shared.disabled.load(Ordering::Acquire) {
                    Ok(None)
                } else {
                    query(&mut connection, &job)
                };
                let result = match result {
                    Ok(result) => result,
                    Err(_) => {
                        shared.fail("read_failed");
                        None
                    }
                };
                let _ = job.reply.send(result);
            }
        }
    }
}

fn query(connection: &mut Connection, query: &Query) -> Result<Option<Vec<Key>>> {
    let transaction = connection.transaction()?;
    let epoch: i64 =
        transaction.query_row("SELECT epoch FROM version WHERE singleton=1", [], |row| {
            row.get(0)
        })?;
    if epoch != query.epoch {
        return Ok(None);
    }
    let (condition, sort, at, id): (&str, &str, Option<i64>, Option<&str>) = match &query.cursor {
        CatalogCursor::Id(after) => (
            if after.is_some() { "id>?1" } else { "1" },
            "id",
            None,
            after.as_deref(),
        ),
        CatalogCursor::Created(after) => (
            if after.is_some() {
                "(created_at,id)>(?2,?1)"
            } else {
                "1"
            },
            "created_at,id",
            after.as_ref().map(|key| key.0),
            after.as_ref().map(|key| key.1.as_str()),
        ),
    };
    let visibility = if query.allowed.is_some() {
        " AND id IN (SELECT value FROM json_each(?3))"
    } else {
        ""
    };
    // 只有固定片段参与拼接，所有游标与授权 ID 都通过参数绑定。
    let sql = format!(
        "SELECT id,created_at FROM entries WHERE {condition}{visibility} ORDER BY {sort} LIMIT ?4"
    );
    let mut statement = transaction.prepare_cached(&sql)?;
    // 显式编号保留各分支参数位置；未出现的低位编号在 SQLite 中仍可绑定。
    let rows = statement
        .query_map(
            params![
                id,
                at,
                query.allowed.as_deref(),
                i64::try_from(query.limit)?
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?
        .collect::<rusqlite::Result<Vec<Key>>>()?;
    drop(statement);
    transaction.commit()?;
    Ok(Some(rows))
}

fn write_loop(
    mut connection: Connection,
    mut receiver: mpsc::Receiver<Write>,
    shared: Arc<Shared>,
) {
    let mut deferred = None;
    loop {
        let Some(job) = deferred.take().or_else(|| receiver.blocking_recv()) else {
            return;
        };
        match job {
            Write::Stop(reply) => {
                drop(connection);
                let _ = reply.send(());
                return;
            }
            Write::Flush(reply) => {
                let _ = reply.send(());
            }
            #[cfg(test)]
            Write::Hold(entered, release) => {
                let _ = entered.send(());
                let _ = release.recv();
            }
            Write::Change(first) => {
                let mut batch = vec![first];
                while batch.len() < QUEUE {
                    match receiver.try_recv() {
                        Ok(Write::Change(change)) => batch.push(change),
                        Ok(other) => {
                            deferred = Some(other);
                            break;
                        }
                        Err(_) => break,
                    }
                }
                if shared.disabled.load(Ordering::Acquire) {
                    continue;
                }
                let epoch = batch.last().unwrap().epoch;
                let latest: BTreeMap<_, _> = batch
                    .into_iter()
                    .map(|change| (change.id, change.created_at))
                    .collect();
                let result = apply(&mut connection, epoch, &latest);
                match result {
                    Ok(()) => {
                        shared.batches.fetch_add(1, Ordering::Relaxed);
                        shared
                            .writes
                            .fetch_add(latest.len() as u64, Ordering::Relaxed);
                        shared.applied.store(epoch, Ordering::Release);
                    }
                    Err(_) => shared.fail("write_failed"),
                }
            }
        }
    }
}

fn apply(
    connection: &mut Connection,
    epoch: i64,
    changes: &BTreeMap<String, Option<i64>>,
) -> Result<()> {
    let transaction = connection.transaction()?;
    {
        let mut insert = transaction.prepare_cached("INSERT INTO entries(id,created_at) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at")?;
        let mut remove = transaction.prepare_cached("DELETE FROM entries WHERE id=?1")?;
        for (id, created_at) in changes {
            if let Some(created_at) = created_at {
                insert.execute(params![id, created_at])?;
            } else {
                remove.execute([id])?;
            }
        }
    }
    ensure!(
        transaction.execute("UPDATE version SET epoch=?1 WHERE singleton=1", [epoch])? == 1,
        "catalog generation missing"
    );
    transaction.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_stalled_cache_read_has_a_deadline_and_releases_shutdown() {
        let root = tempfile::tempdir().unwrap();
        let index = Index::open(root.path(), &[("one".into(), 7)]).unwrap();
        let mut releases = Vec::new();
        for reader in &index.readers {
            let (entered, wait) = std::sync::mpsc::channel();
            let (release, resume) = std::sync::mpsc::channel();
            assert!(reader.send(Read::Hold(entered, resume)).await.is_ok());
            wait.recv_timeout(Duration::from_secs(2)).unwrap();
            releases.push(release);
        }
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            index.page(0, CatalogCursor::Created(None), 100, None),
        )
        .await
        .unwrap();
        assert!(result.is_none());
        assert!(index.disabled());
        drop(releases);
        index.shutdown().await;
    }

    #[tokio::test]
    async fn query_parameters_and_covering_indexes_preserve_cursor_semantics() {
        let root = tempfile::tempdir().unwrap();
        let index = Index::open(
            root.path(),
            &[("a".into(), 7), ("b".into(), 7), ("c".into(), 8)],
        )
        .unwrap();
        let rows = index
            .page(
                0,
                CatalogCursor::Created(Some((7, "a".into()))),
                100,
                Some(Arc::from("[\"b\",\"c\",\"'; DROP TABLE entries;--\"]")),
            )
            .await
            .unwrap();
        assert_eq!(rows, [("b".into(), 7), ("c".into(), 8)]);
        let connection = Connection::open(&index.path).unwrap();
        let details = connection.prepare("EXPLAIN QUERY PLAN SELECT id,created_at FROM entries WHERE (created_at,id)>(7,'a') ORDER BY created_at,id LIMIT 100").unwrap()
            .query_map([], |row| row.get::<_,String>(3)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap().join(" ");
        assert!(details.contains("entries_created"), "{details}");
        assert_eq!(
            index
                .page(0, CatalogCursor::Id(None), 100, None)
                .await
                .unwrap()
                .len(),
            3
        );
        drop(connection);
        index.shutdown().await;
    }
}
