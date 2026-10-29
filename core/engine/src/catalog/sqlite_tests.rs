use super::*;

#[tokio::test]
async fn concurrent_registration_and_reads_never_omit_published_sessions() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    for backend in [SessionCatalog::Memory, SessionCatalog::Sqlite] {
        let root = tempfile::tempdir().unwrap();
        let engine = open(root.path(), backend);
        let published = Arc::new(AtomicUsize::new(0));
        let mut readers = Vec::new();
        for _ in 0..4 {
            let engine = engine.clone();
            let published = published.clone();
            readers.push(tokio::spawn(async move {
                for _ in 0..100 {
                    let minimum = published.load(Ordering::Acquire);
                    let (rows, cursor) = engine.list_by_created(None, 100, |_| true).await.unwrap();
                    assert!(rows.len() >= minimum);
                    assert!(cursor.is_none());
                    let unique: BTreeSet<_> = rows.iter().map(|row| &row.id).collect();
                    assert_eq!(unique.len(), rows.len());
                    tokio::task::yield_now().await;
                }
            }));
        }
        for count in 1..=32 {
            engine.create("/workspace".into()).await.unwrap();
            published.store(count, Ordering::Release);
        }
        for reader in readers {
            reader.await.unwrap();
        }
        engine.flush_catalog().await;
        assert_eq!(
            engine
                .list_by_created(None, 100, |_| true)
                .await
                .unwrap()
                .0
                .len(),
            32
        );
        if backend == SessionCatalog::Sqlite {
            let metrics = engine.catalog_metrics().await;
            assert_eq!(metrics["active"], "sqlite");
            assert_eq!(metrics["sqlite"]["errors"], 0);
            assert_eq!(metrics["sqlite"]["rowsWritten"], 32);
            assert!(metrics["sqlite"]["readHits"].as_u64().unwrap() > 0);
        }
        engine.shutdown().await;
    }
}

fn open(root: &Path, backend: SessionCatalog) -> Arc<Engine> {
    let model = model::ChatModel::new("http://127.0.0.1:9".into(), "fixture".into(), None).unwrap();
    Engine::open(
        root,
        Arc::new(model),
        Limits {
            session_catalog: backend,
            ..Default::default()
        },
    )
    .unwrap()
}

#[tokio::test]
async fn warm_reuse_and_stale_cache_rebuild_preserve_fact_records() {
    let root = tempfile::tempdir().unwrap();
    let engine = open(root.path(), SessionCatalog::Memory);
    let a = engine.create("/workspace".into()).await.unwrap();
    let b = engine.create("/workspace".into()).await.unwrap();
    engine.shutdown().await;
    drop(engine);
    assert!(!root.path().join("catalog").exists());
    let facts: Vec<_> = [&a.id, &b.id]
        .map(|id| {
            let path = root.path().join(format!("{id}.json"));
            (path.clone(), std::fs::read(path).unwrap())
        })
        .into();
    let engine = open(root.path(), SessionCatalog::Sqlite);
    assert_eq!(
        engine
            .list_by_created(None, 100, |_| true)
            .await
            .unwrap()
            .0
            .len(),
        2
    );
    assert_eq!(engine.catalog_metrics().await["active"], "sqlite");
    assert!(
        engine.catalog_metrics().await["sqlite"]["readHits"]
            .as_u64()
            .unwrap()
            > 0
    );
    engine.shutdown().await;
    drop(engine);

    let engine = open(root.path(), SessionCatalog::Sqlite);
    assert_eq!(engine.catalog_metrics().await["sqlite"]["reused"], true);
    engine.shutdown().await;
    drop(engine);
    let path = root.path().join("catalog/index.sqlite3");
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute("DELETE FROM entries WHERE id=?1", [&a.id])
        .unwrap();
    connection
        .execute("INSERT INTO entries VALUES('ghost',0)", [])
        .unwrap();
    drop(connection);
    let engine = open(root.path(), SessionCatalog::Sqlite);
    assert_eq!(engine.catalog_metrics().await["sqlite"]["reused"], false);
    let rows = engine.list(None, 100, None).await.unwrap().0;
    assert_eq!(
        rows.iter()
            .map(|row| row.id.clone())
            .collect::<BTreeSet<_>>(),
        [a.id, b.id].into()
    );
    for (path, bytes) in facts {
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
    engine.shutdown().await;
}

#[tokio::test]
async fn corrupt_index_is_preserved_and_rebuilt_from_files() {
    let root = tempfile::tempdir().unwrap();
    let engine = open(root.path(), SessionCatalog::Memory);
    let thread = engine.create("/workspace".into()).await.unwrap();
    engine.shutdown().await;
    drop(engine);
    std::fs::create_dir(root.path().join("catalog")).unwrap();
    std::fs::write(
        root.path().join("catalog/index.sqlite3"),
        b"corrupt-cache-fixture",
    )
    .unwrap();
    let engine = open(root.path(), SessionCatalog::Sqlite);
    assert_eq!(
        engine.list(None, 10, None).await.unwrap().0[0].id,
        thread.id
    );
    assert_eq!(engine.catalog_metrics().await["active"], "sqlite");
    let saved = std::fs::read_dir(root.path().join("catalog"))
        .unwrap()
        .flatten()
        .find(|entry| entry.file_name().to_string_lossy().starts_with("rejected-"))
        .unwrap();
    assert_eq!(
        std::fs::read(saved.path().join("index.sqlite3")).unwrap(),
        b"corrupt-cache-fixture"
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn unavailable_database_writer_does_not_fail_fact_creation_or_reads() {
    let root = tempfile::tempdir().unwrap();
    let engine = open(root.path(), SessionCatalog::Sqlite);
    assert!(
        engine
            .list_by_created(None, 10, |_| true)
            .await
            .unwrap()
            .0
            .is_empty()
    );
    let external = rusqlite::Connection::open(root.path().join("catalog/index.sqlite3")).unwrap();
    external.execute_batch("BEGIN IMMEDIATE").unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    engine.flush_catalog().await;
    assert_eq!(engine.catalog_metrics().await["sqlite"]["disabled"], true);
    assert_eq!(
        engine.list_by_created(None, 10, |_| true).await.unwrap().0[0].id,
        thread.id
    );
    assert!(root.path().join(format!("{}.json", thread.id)).is_file());
    external.execute_batch("ROLLBACK").unwrap();
    drop(external);
    engine.shutdown().await;
    drop(engine);
    let restored = open(root.path(), SessionCatalog::Sqlite);
    assert_eq!(
        restored.list(None, 10, None).await.unwrap().0[0].id,
        thread.id
    );
    assert_eq!(restored.catalog_metrics().await["active"], "sqlite");
    restored.shutdown().await;
}

#[tokio::test]
async fn full_index_queue_keeps_fact_commits_and_complete_directory_available() {
    let root = tempfile::tempdir().unwrap();
    let engine = open(root.path(), SessionCatalog::Sqlite);
    let index = engine.threads.read().await.sqlite.clone().unwrap();
    let resume = index.hold_writer().await;
    let mut expected = BTreeSet::new();
    for _ in 0..32 {
        expected.insert(engine.create("/workspace".into()).await.unwrap().id);
    }
    let rows = engine.list_by_created(None, 100, |_| true).await.unwrap().0;
    assert_eq!(
        rows.into_iter().map(|row| row.id).collect::<BTreeSet<_>>(),
        expected
    );
    assert_eq!(engine.catalog_metrics().await["active"], "sqlite");
    assert!(
        engine.catalog_metrics().await["sqlite"]["fallbacks"]
            .as_u64()
            .unwrap()
            > 0
    );
    for _ in 32..140 {
        expected.insert(engine.create("/workspace".into()).await.unwrap().id);
    }
    assert_eq!(engine.catalog_metrics().await["active"], "memory");
    let mut seen = BTreeSet::new();
    let mut next = None;
    loop {
        let (rows, cursor) = engine.list(next.as_deref(), 100, None).await.unwrap();
        seen.extend(rows.into_iter().map(|row| row.id));
        next = cursor;
        if next.is_none() {
            break;
        }
    }
    assert_eq!(seen, expected);
    drop(resume);
    engine.shutdown().await;
    drop(engine);
    let restored = open(root.path(), SessionCatalog::Sqlite);
    let mut next = None;
    let mut seen = BTreeSet::new();
    loop {
        let (rows, cursor) = restored.list(next.as_deref(), 100, None).await.unwrap();
        seen.extend(rows.into_iter().map(|row| row.id));
        next = cursor;
        if next.is_none() {
            break;
        }
    }
    assert_eq!(seen, expected);
    assert_eq!(restored.catalog_metrics().await["active"], "sqlite");
    restored.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn cache_symlinks_cannot_modify_unrelated_files() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let protected = other.path().join("keep.txt");
    std::fs::write(&protected, "private unrelated contents").unwrap();
    std::fs::create_dir(root.path().join("catalog")).unwrap();
    symlink(&protected, root.path().join("catalog/index.sqlite3")).unwrap();
    let engine = open(root.path(), SessionCatalog::Sqlite);
    assert_eq!(engine.catalog_metrics().await["active"], "memory");
    let thread = engine.create("/workspace".into()).await.unwrap();
    assert_eq!(
        engine.list(None, 100, None).await.unwrap().0[0].id,
        thread.id
    );
    assert_eq!(
        std::fs::read_to_string(protected).unwrap(),
        "private unrelated contents"
    );
    engine.shutdown().await;
}
