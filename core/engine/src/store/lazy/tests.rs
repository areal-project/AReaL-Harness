use super::*;
use crate::{Engine, Limits, SessionCatalog};
use areal_protocol::Input;

fn model() -> Arc<dyn crate::model::Model> {
    Arc::new(
        crate::model::ChatModel::new("http://127.0.0.1:9".into(), "fixture".into(), None).unwrap(),
    )
}

fn open(root: &Path, mode: SessionCatalog) -> Arc<Engine> {
    Engine::open(
        root,
        model(),
        Limits {
            session_catalog: mode,
            ..Default::default()
        },
    )
    .unwrap()
}

async fn fixture(count: usize, body: usize) -> (tempfile::TempDir, Vec<Thread>) {
    let root = tempfile::tempdir().unwrap();
    let engine = open(root.path(), SessionCatalog::Memory);
    let original = engine.create("/workspace".into()).await.unwrap();
    engine.shutdown().await;
    drop(engine);
    std::fs::remove_file(root.path().join(format!("{}.json", original.id))).unwrap();
    let mut result = Vec::new();
    for n in 1..=count {
        let mut thread = original.clone();
        thread.id = uuid::Uuid::from_u128(n as u128).to_string();
        thread.session_id = thread.id.clone();
        thread.name = Some(format!("Session {n}"));
        thread.turns = serde_json::from_value(serde_json::json!([{
            "id":format!("turn-{n}"),"status":"completed","error":null,
            "items":[{"id":format!("input-{n}"),"type":"userMessage","content":[{"type":"text","text":"original request"}]},
                {"id":format!("answer-{n}"),"type":"agentMessage","text":"雪🙂".repeat(body)}]
        }])).unwrap();
        std::fs::write(
            root.path().join(format!("{}.json", thread.id)),
            encode(&thread).unwrap(),
        )
        .unwrap();
        result.push(thread);
    }
    (root, result)
}

fn facts(root: &Path) -> BTreeMap<String, Vec<u8>> {
    std::fs::read_dir(root)
        .unwrap()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|s| s == "json"))
        .map(|e| {
            (
                e.file_name().into_string().unwrap(),
                std::fs::read(e.path()).unwrap(),
            )
        })
        .collect()
}

#[tokio::test]
async fn dormant_directory_preserves_metadata_overview_and_facts_then_loads_exact_history_once() {
    for mode in [SessionCatalog::MemoryLazy, SessionCatalog::SqliteLazy] {
        let (root, original) = fixture(3, 16384).await;
        let before = facts(root.path());
        let engine = open(root.path(), mode);
        assert_eq!(engine.store.loading_metrics()["deferredSessions"], 3);
        let (rows, cursor) = engine.list_by_created(None, 100, |_| true).await.unwrap();
        assert!(cursor.is_none());
        assert_eq!(rows.len(), 3);
        for thread in &original {
            let actual = engine.read(&thread.id, false).await.unwrap();
            assert_eq!(
                serde_json::to_value(actual).unwrap(),
                serde_json::to_value(crate::catalog::metadata(thread)).unwrap()
            );
        }
        let overview = engine
            .work_overview(None, Default::default())
            .await
            .unwrap();
        let overview = serde_json::to_value(overview).unwrap();
        assert_eq!(overview["data"][0]["execution"]["state"], "completed");
        assert_eq!(engine.store.loading_metrics()["historyMaterializations"], 0);
        assert_eq!(facts(root.path()), before);
        for filter in [
            crate::ConversationFilter {
                view: crate::ConversationView::Side,
                ..Default::default()
            },
            crate::ConversationFilter {
                view: crate::ConversationView::All,
                source_thread_id: Some(original[0].id.clone()),
                ..Default::default()
            },
        ] {
            assert!(
                engine
                    .list_conversations(None, 1, None, &filter)
                    .await
                    .unwrap()
                    .0
                    .is_empty()
            );
        }
        assert_eq!(engine.store.loading_metrics()["historyMaterializations"], 0);
        let mut readers = Vec::new();
        for _ in 0..8 {
            let engine = engine.clone();
            let id = original[0].id.clone();
            readers.push(tokio::spawn(async move {
                engine.read(&id, true).await.unwrap()
            }));
        }
        for reader in readers {
            let thread = reader.await.unwrap();
            assert_eq!(
                serde_json::to_value(thread).unwrap(),
                serde_json::to_value(&original[0]).unwrap()
            );
        }
        assert_eq!(engine.store.loading_metrics()["historyMaterializations"], 1);
        engine.shutdown().await;
        assert_eq!(engine.store.loading_metrics()["historyMaterializations"], 1);
        drop(engine);
        let engine = open(root.path(), mode);
        assert_eq!(engine.store.loading_metrics()["cacheHits"], 3);
        assert_eq!(engine.store.loading_metrics()["factsParsed"], 0);
        assert_eq!(facts(root.path()), before);
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn offline_change_same_length_and_restored_mtime_invalidates_only_changed_cache_row() {
    for mode in [SessionCatalog::MemoryLazy, SessionCatalog::SqliteLazy] {
        let (root, mut original) = fixture(3, 128).await;
        let engine = open(root.path(), mode);
        engine.shutdown().await;
        drop(engine);
        let path = root.path().join(format!("{}.json", original[0].id));
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        let before = std::fs::metadata(&path).unwrap().len();
        original[0].name = Some("Session 9".into());
        std::fs::write(&path, encode(&original[0]).unwrap()).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().len(), before);
        let engine = open(root.path(), mode);
        assert_eq!(engine.store.loading_metrics()["cacheHits"], 2);
        assert_eq!(engine.store.loading_metrics()["factsParsed"], 1);
        assert_eq!(
            engine.read(&original[0].id, false).await.unwrap().name,
            Some("Session 9".into())
        );
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn deferred_history_cannot_be_overwritten_and_external_change_never_reaches_execution() {
    for mode in [SessionCatalog::MemoryLazy, SessionCatalog::SqliteLazy] {
        let (root, original) = fixture(1, 512).await;
        let engine = open(root.path(), mode);
        let id = &original[0].id;
        let path = root.path().join(format!("{id}.json"));
        let before = std::fs::read(&path).unwrap();
        let metadata = engine.read(id, false).await.unwrap();
        assert!(engine.persist(&metadata).await.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let mut changed = original[0].clone();
        changed.name = Some("externally changed".into());
        std::fs::write(&path, encode(&changed).unwrap()).unwrap();
        assert!(
            engine
                .start(id, vec![Input::text("do not execute")])
                .await
                .is_err()
        );
        assert_eq!(
            serde_json::from_slice::<Record>(&std::fs::read(&path).unwrap())
                .unwrap()
                .thread
                .turns
                .len(),
            1
        );
        assert_eq!(engine.store.loading_metrics()["historyMaterializations"], 0);
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn corrupt_cache_is_preserved_rebuilt_and_never_rewrites_facts() {
    for mode in [SessionCatalog::MemoryLazy, SessionCatalog::SqliteLazy] {
        let (root, original) = fixture(2, 512).await;
        let engine = open(root.path(), mode);
        engine.shutdown().await;
        drop(engine);
        let before = facts(root.path());
        let name = if mode.is_sqlite() {
            "metadata.sqlite3"
        } else {
            "metadata.json"
        };
        std::fs::write(
            root.path().join("catalog").join(name),
            b"corrupt metadata fixture",
        )
        .unwrap();
        let engine = open(root.path(), mode);
        assert_eq!(engine.store.loading_metrics()["cacheHits"], 0);
        assert!(
            engine.store.loading_metrics()["cacheErrors"]
                .as_u64()
                .unwrap()
                > 0
        );
        assert_eq!(
            engine
                .read(&original[0].id, true)
                .await
                .unwrap()
                .turns
                .len(),
            1
        );
        assert_eq!(facts(root.path()), before);
        engine.shutdown().await;
        drop(engine);
        let engine = open(root.path(), mode);
        assert_eq!(engine.store.loading_metrics()["cacheHits"], 2);
        engine.shutdown().await;
        assert!(
            std::fs::read_dir(root.path().join("catalog"))
                .unwrap()
                .flatten()
                .any(|e| e
                    .file_name()
                    .to_string_lossy()
                    .starts_with("rejected-metadata-"))
        );
    }
}

#[tokio::test]
async fn drain_materializes_before_persistence_and_keeps_complete_turns() {
    for mode in [SessionCatalog::MemoryLazy, SessionCatalog::SqliteLazy] {
        let (root, mut original) = fixture(2, 1024).await;
        for expected in &mut original {
            expected.desktop = Some(Default::default());
            std::fs::write(
                root.path().join(format!("{}.json", expected.id)),
                encode(expected).unwrap(),
            )
            .unwrap();
        }
        let baseline = facts(root.path());
        let engine = open(root.path(), mode);
        engine.shutdown().await;
        assert_eq!(facts(root.path()), baseline);
        assert_eq!(
            engine.catalog_metrics().await["loading"]["historyMaterializations"],
            0
        );
        drop(engine);
        let engine = open(root.path(), mode);
        let warm = engine.catalog_metrics().await;
        assert_eq!(warm["loading"]["cacheHits"], original.len());
        engine.drain("cancel".into(), 5000).await.unwrap();
        for expected in &original {
            let saved: Record = serde_json::from_slice(
                &std::fs::read(root.path().join(format!("{}.json", expected.id))).unwrap(),
            )
            .unwrap();
            assert_eq!(
                serde_json::to_value(saved.thread.turns).unwrap(),
                serde_json::to_value(&expected.turns).unwrap()
            );
            let queue = &saved.thread.desktop.as_ref().unwrap().queue;
            assert!(queue.paused);
            assert_eq!(queue.pause_reason.as_deref(), Some("serverDraining"));
            assert_eq!(
                queue.revision,
                expected.desktop.as_ref().unwrap().queue.revision + 1
            );
        }
        engine.shutdown().await;
        drop(engine);
        let engine = open(root.path(), mode);
        let restarted = engine.catalog_metrics().await;
        for expected in &original {
            let restored = engine.read(&expected.id, true).await.unwrap();
            assert_eq!(
                serde_json::to_value(restored.turns).unwrap(),
                serde_json::to_value(&expected.turns).unwrap()
            );
            assert!(restored.desktop.unwrap().queue.paused);
        }
        eprintln!(
            "CATALOG_LIFECYCLE {}",
            serde_json::json!({"mode":mode,"plainShutdown":warm["loading"],"afterDrain":restarted["loading"]})
        );
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn cancelled_first_reader_leaves_metadata_dormant_and_next_reader_loads_complete_history() {
    for mode in [SessionCatalog::MemoryLazy, SessionCatalog::SqliteLazy] {
        let (root, original) = fixture(1, 2048).await;
        let engine = open(root.path(), mode);
        let held = engine
            .store
            .fork_reads
            .clone()
            .acquire_many_owned(2)
            .await
            .unwrap();
        let reader = {
            let engine = engine.clone();
            let id = original[0].id.clone();
            tokio::spawn(async move { engine.read(&id, true).await })
        };
        tokio::task::yield_now().await;
        reader.abort();
        assert!(reader.await.unwrap_err().is_cancelled());
        assert_eq!(engine.store.loading_metrics()["historyMaterializations"], 0);
        assert!(
            engine
                .read(&original[0].id, false)
                .await
                .unwrap()
                .turns
                .is_empty()
        );
        drop(held);
        assert_eq!(
            serde_json::to_value(engine.read(&original[0].id, true).await.unwrap()).unwrap(),
            serde_json::to_value(&original[0]).unwrap()
        );
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn changed_membership_and_lower_history_limit_use_authoritative_facts() {
    for mode in [SessionCatalog::MemoryLazy, SessionCatalog::SqliteLazy] {
        let (root, original) = fixture(3, 1024).await;
        let engine = open(root.path(), mode);
        engine.shutdown().await;
        drop(engine);
        std::fs::remove_file(root.path().join(format!("{}.json", original[0].id))).unwrap();
        let mut added = original[0].clone();
        added.id = uuid::Uuid::from_u128(4).to_string();
        added.session_id = added.id.clone();
        std::fs::write(
            root.path().join(format!("{}.json", added.id)),
            encode(&added).unwrap(),
        )
        .unwrap();
        let engine = open(root.path(), mode);
        assert_eq!(engine.store.loading_metrics()["cacheHits"], 2);
        assert_eq!(engine.store.loading_metrics()["factsParsed"], 1);
        assert!(engine.read(&original[0].id, false).await.is_err());
        assert_eq!(engine.list(None, 100, None).await.unwrap().0.len(), 3);
        engine.shutdown().await;
        drop(engine);
        let error = Engine::open(
            root.path(),
            model(),
            Limits {
                session_catalog: mode,
                max_history_bytes: 1024,
                ..Default::default()
            },
        )
        .err()
        .unwrap();
        assert!(error.to_string().contains("history limit"));
    }
}

#[tokio::test]
async fn unsettled_outcomes_children_and_goal_records_keep_eager_recovery() {
    for mode in [SessionCatalog::MemoryLazy, SessionCatalog::SqliteLazy] {
        let (root, mut original) = fixture(4, 128).await;
        original[1].parent_thread_id = Some(original[0].id.clone());
        original[1].session_id = original[0].id.clone();
        original[1].source = "nativeTaskAgent".into();
        original[2].goals.revision = 1;
        original[3].turns[0].status = TurnStatus::InProgress;
        original[3].turns[0].items.push(serde_json::from_value(serde_json::json!({
            "id":"unsettled","type":"dynamicToolCall","tool":"fixture","arguments":{},"status":"inProgress","success":null,"contentItems":null,"callId":"uncertain",
            "execution":{"runtimeEpoch":"old","scopeId":"scope","operationId":"operation","outcome":"running"}
        })).unwrap());
        for thread in &original {
            std::fs::write(
                root.path().join(format!("{}.json", thread.id)),
                encode(thread).unwrap(),
            )
            .unwrap();
        }
        let engine = open(root.path(), mode);
        assert_eq!(engine.store.loading_metrics()["deferredSessions"], 1);
        let recovered = engine.read(&original[3].id, true).await.unwrap();
        let Item::DynamicToolCall { execution, .. } = recovered.turns[0].items.last().unwrap()
        else {
            panic!("missing tool receipt")
        };
        assert_eq!(execution.outcome, ToolOutcome::Unknown);
        let status = engine.server_status().await;
        assert!(status.to_string().contains("unsettled"));
        engine.shutdown().await;
        drop(engine);
        let engine = open(root.path(), mode);
        assert_eq!(engine.store.loading_metrics()["cacheHits"], 1);
        assert_eq!(engine.store.loading_metrics()["deferredSessions"], 1);
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn unsupported_cache_versions_are_preserved_and_facts_still_load() {
    for mode in [SessionCatalog::MemoryLazy, SessionCatalog::SqliteLazy] {
        let (root, original) = fixture(1, 128).await;
        let engine = open(root.path(), mode);
        engine.shutdown().await;
        drop(engine);
        let path = root.path().join("catalog").join(if mode.is_sqlite() {
            "metadata.sqlite3"
        } else {
            "metadata.json"
        });
        if mode.is_sqlite() {
            let connection = rusqlite::Connection::open(&path).unwrap();
            connection.pragma_update(None, "user_version", 999).unwrap();
        } else {
            let mut value: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            value["version"] = 999.into();
            std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        }
        let before = std::fs::read(&path).unwrap();
        let engine = open(root.path(), mode);
        assert_eq!(engine.store.loading_metrics()["cacheHits"], 0);
        assert_eq!(
            engine
                .read(&original[0].id, true)
                .await
                .unwrap()
                .turns
                .len(),
            1
        );
        engine.shutdown().await;
        drop(engine);
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
}

#[tokio::test]
async fn a_self_consistent_but_wrong_metadata_cache_never_replaces_execution_history() {
    for mode in [SessionCatalog::MemoryLazy, SessionCatalog::SqliteLazy] {
        let (root, original) = fixture(1, 128).await;
        let engine = open(root.path(), mode);
        engine.shutdown().await;
        drop(engine);
        let mut cache = MetadataCache::open(root.path(), mode.is_sqlite()).unwrap();
        let mut rows = cache.read(100).unwrap();
        let row = rows.get_mut(&original[0].id).unwrap();
        let mut metadata = row.thread().unwrap();
        metadata.cwd = "/wrong-workspace".into();
        row.metadata = serde_json::to_string(&metadata).unwrap();
        row.checksum = row.checksum().unwrap();
        cache
            .write(
                &[RestoredSession::deferred(row.clone())],
                &BTreeSet::from([row.id.clone()]),
            )
            .unwrap();
        drop(cache);
        let before = facts(root.path());
        let engine = open(root.path(), mode);
        assert!(
            engine
                .start(&original[0].id, vec![Input::text("must not execute")])
                .await
                .is_err()
        );
        assert_eq!(engine.store.loading_metrics()["historyMaterializations"], 0);
        assert_eq!(facts(root.path()), before);
        engine.shutdown().await;
        drop(engine);
        let engine = open(root.path(), mode);
        assert_eq!(
            engine.read(&original[0].id, false).await.unwrap().cwd,
            original[0].cwd
        );
        assert_eq!(engine.store.loading_metrics()["cacheHits"], 0);
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn archived_history_is_validated_before_compaction_and_remains_readable() {
    for mode in [SessionCatalog::MemoryLazy, SessionCatalog::SqliteLazy] {
        let (root, mut original) = fixture(3, 128).await;
        for thread in &mut original[..2] {
            thread.desktop = Some(areal_protocol::desktop::DesktopState {
                archived: true,
                ..Default::default()
            });
        }
        original[1].turns[0].items.push(serde_json::from_value(serde_json::json!({
            "id":"old-unknown","type":"dynamicToolCall","tool":"fixture","arguments":{},"status":"failed","success":false,"contentItems":[],"callId":"uncertain",
            "execution":{"runtimeEpoch":"old","scopeId":"scope","operationId":"operation","outcome":"unknown"}
        })).unwrap());
        for thread in &original {
            std::fs::write(
                root.path().join(format!("{}.json", thread.id)),
                encode(thread).unwrap(),
            )
            .unwrap();
        }
        let before = facts(root.path());
        let baseline = open(root.path(), SessionCatalog::Memory);
        let overview = serde_json::to_value(
            baseline
                .work_overview(None, Default::default())
                .await
                .unwrap(),
        )
        .unwrap();
        baseline.shutdown().await;
        drop(baseline);
        for expected_hits in [0, 2] {
            let engine = open(root.path(), mode);
            assert_eq!(engine.store.loading_metrics()["deferredSessions"], 2);
            assert_eq!(engine.store.loading_metrics()["cacheHits"], expected_hits);
            assert_eq!(
                serde_json::to_value(
                    engine
                        .work_overview(None, Default::default())
                        .await
                        .unwrap()
                )
                .unwrap(),
                overview
            );
            for expected in &original[..2] {
                assert_eq!(
                    serde_json::to_value(engine.read(&expected.id, true).await.unwrap().turns)
                        .unwrap(),
                    serde_json::to_value(&expected.turns).unwrap()
                );
            }
            assert_eq!(facts(root.path()), before);
            engine.shutdown().await;
        }
    }
}

#[tokio::test]
async fn changed_archive_head_invalidates_warm_metadata_and_retains_integrity_failure() {
    for mode in [SessionCatalog::MemoryLazy, SessionCatalog::SqliteLazy] {
        let (root, mut original) = fixture(1, 128).await;
        let segment = serde_json::to_vec(
            &serde_json::json!({"version":1,"previous":null,"turns":original[0].turns}),
        )
        .unwrap();
        let digest = format!("{:x}", Sha256::digest(&segment));
        std::fs::create_dir(root.path().join("history")).unwrap();
        let path = root.path().join("history").join(&digest);
        std::fs::write(&path, &segment).unwrap();
        original[0].turns.clear();
        original[0].history_archive = Some(areal_protocol::HistoryArchive {
            head: digest,
            through_item_id: "answer-1".into(),
            completed_turns: 1,
            items: 2,
            bytes: segment.len() as u64,
        });
        std::fs::write(
            root.path().join(format!("{}.json", original[0].id)),
            encode(&original[0]).unwrap(),
        )
        .unwrap();
        let engine = open(root.path(), mode);
        assert_eq!(
            engine
                .read(&original[0].id, true)
                .await
                .unwrap()
                .turns
                .len(),
            1
        );
        engine.shutdown().await;
        drop(engine);
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        let mut corrupted = segment.clone();
        let index = corrupted.iter().position(|b| *b == b'1').unwrap();
        corrupted[index] = b'2';
        std::fs::write(&path, &corrupted).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        let error = Engine::open(
            root.path(),
            model(),
            Limits {
                session_catalog: mode,
                ..Default::default()
            },
        )
        .err()
        .unwrap();
        assert!(error.to_string().contains("integrity check"));
        assert_eq!(std::fs::read(&path).unwrap(), corrupted);
    }
}

#[tokio::test]
async fn a_smaller_fact_set_and_thread_limit_rebuild_an_oversized_stale_cache() {
    for mode in [SessionCatalog::MemoryLazy, SessionCatalog::SqliteLazy] {
        let (root, original) = fixture(6, 128).await;
        let engine = open(root.path(), mode);
        engine.shutdown().await;
        drop(engine);
        for thread in &original[..4] {
            std::fs::remove_file(root.path().join(format!("{}.json", thread.id))).unwrap();
        }
        let before = facts(root.path());
        for round in 0..2 {
            let engine = Engine::open(
                root.path(),
                model(),
                Limits {
                    session_catalog: mode,
                    max_threads: 2,
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(engine.list(None, 100, None).await.unwrap().0.len(), 2);
            if round == 1 {
                assert_eq!(
                    engine.store.loading_metrics()["cacheHits"],
                    2,
                    "已失效的旧目录不应导致每次重启都放弃缓存"
                );
                assert_eq!(engine.store.loading_metrics()["factsParsed"], 0);
            }
            assert_eq!(facts(root.path()), before);
            engine.shutdown().await;
        }
    }
}

#[tokio::test]
async fn interrupted_empty_sqlite_initialization_is_preserved_and_rebuilt() {
    for stage in [
        "empty-file",
        "wal-header",
        "application-header",
        "header-table",
        "full-schema",
    ] {
        let (root, original) = fixture(1, 128).await;
        std::fs::create_dir(root.path().join("catalog")).unwrap();
        let path = root.path().join("catalog/metadata.sqlite3");
        if stage == "empty-file" {
            std::fs::File::create(&path).unwrap();
        } else {
            let connection = rusqlite::Connection::open(&path).unwrap();
            connection.execute_batch("PRAGMA journal_mode=WAL").unwrap();
            if matches!(stage, "application-header" | "header-table" | "full-schema") {
                connection
                    .pragma_update(None, "application_id", APPLICATION)
                    .unwrap();
            }
            if matches!(stage, "header-table" | "full-schema") {
                connection.execute_batch("CREATE TABLE header(singleton INTEGER PRIMARY KEY CHECK(singleton=1),source TEXT NOT NULL)").unwrap();
            }
            if stage == "full-schema" {
                connection.execute_batch("CREATE TABLE metadata(id TEXT PRIMARY KEY,body TEXT NOT NULL) WITHOUT ROWID").unwrap();
            }
        }
        let interrupted = std::fs::read(&path).unwrap();
        let before = facts(root.path());
        let engine = open(root.path(), SessionCatalog::SqliteLazy);
        assert_eq!(
            engine
                .read(&original[0].id, true)
                .await
                .unwrap()
                .turns
                .len(),
            1
        );
        engine.shutdown().await;
        drop(engine);
        let engine = open(root.path(), SessionCatalog::SqliteLazy);
        assert_eq!(
            engine.store.loading_metrics()["cacheHits"],
            1,
            "{stage}: 中断初始化不能永久停用缓存"
        );
        assert_eq!(facts(root.path()), before);
        engine.shutdown().await;
        let preserved = std::fs::read_dir(root.path().join("catalog"))
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("rejected-metadata-")
            })
            .any(|e| {
                std::fs::read(e.path().join("metadata.sqlite3"))
                    .is_ok_and(|bytes| bytes == interrupted)
            });
        assert!(preserved, "{stage}: 重建前保留初始化残片");
    }
}

#[tokio::test]
async fn cancellation_after_fact_validation_does_not_publish_partial_state() {
    for mode in [SessionCatalog::MemoryLazy, SessionCatalog::SqliteLazy] {
        let (root, original) = fixture(1, 1024).await;
        let engine = open(root.path(), mode);
        let cell = engine.lookup_cell(&original[0].id).await.unwrap();
        let base = cell
            .pending_registry
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .clone();
        let original_refs = Arc::strong_count(&base);
        let bindings = cell.bindings.write().await;
        let reader = {
            let engine = engine.clone();
            let id = original[0].id.clone();
            tokio::spawn(async move { engine.read(&id, true).await })
        };
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            // 首次恢复只在事实验证之后克隆启动注册表；此时最后一个发布锁仍被本测试持有。
            while Arc::strong_count(&base) == original_refs {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        reader.abort();
        assert!(reader.await.unwrap_err().is_cancelled());
        assert!(!cell.state.is_loaded());
        assert_eq!(engine.store.loading_metrics()["historyMaterializations"], 0);
        assert!(engine.store.is_deferred(&original[0].id));
        drop(bindings);
        assert_eq!(
            serde_json::to_value(engine.read(&original[0].id, true).await.unwrap()).unwrap(),
            serde_json::to_value(&original[0]).unwrap()
        );
        assert_eq!(engine.store.loading_metrics()["historyMaterializations"], 1);
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn a_foreign_sqlite_schema_is_preserved_without_disabling_fact_reads() {
    let (root, original) = fixture(1, 128).await;
    std::fs::create_dir(root.path().join("catalog")).unwrap();
    let path = root.path().join("catalog/metadata.sqlite3");
    {
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection.execute_batch("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('foreign bytes remain')").unwrap();
    }
    let before = std::fs::read(&path).unwrap();
    let engine = open(root.path(), SessionCatalog::SqliteLazy);
    assert_eq!(
        engine
            .read(&original[0].id, true)
            .await
            .unwrap()
            .turns
            .len(),
        1
    );
    engine.shutdown().await;
    drop(engine);
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[tokio::test]
async fn a_busy_metadata_writer_preserves_changed_facts_and_recovers_on_next_open() {
    let (root, mut original) = fixture(3, 128).await;
    let engine = open(root.path(), SessionCatalog::SqliteLazy);
    engine.shutdown().await;
    drop(engine);
    let writer = rusqlite::Connection::open(root.path().join("catalog/metadata.sqlite3")).unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    original[0].name = Some("Session 7".into());
    std::fs::write(
        root.path().join(format!("{}.json", original[0].id)),
        encode(&original[0]).unwrap(),
    )
    .unwrap();
    let before = facts(root.path());
    let engine = open(root.path(), SessionCatalog::SqliteLazy);
    assert!(
        engine.store.loading_metrics()["cacheErrors"]
            .as_u64()
            .unwrap()
            > 0
    );
    assert_eq!(
        engine.read(&original[0].id, false).await.unwrap().name,
        original[0].name
    );
    assert_eq!(facts(root.path()), before);
    engine.shutdown().await;
    drop(engine);
    writer.execute_batch("ROLLBACK").unwrap();
    drop(writer);
    let engine = open(root.path(), SessionCatalog::SqliteLazy);
    assert_eq!(engine.store.loading_metrics()["factsParsed"], 1);
    assert_eq!(engine.store.loading_metrics()["cacheHits"], 2);
    engine.shutdown().await;
    drop(engine);
    let engine = open(root.path(), SessionCatalog::SqliteLazy);
    assert_eq!(engine.store.loading_metrics()["cacheHits"], 3);
    assert_eq!(facts(root.path()), before);
    engine.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn linked_metadata_cache_paths_preserve_the_target_and_use_validated_facts() {
    for mode in [SessionCatalog::MemoryLazy, SessionCatalog::SqliteLazy] {
        for hard_link in [false, true] {
            let (root, original) = fixture(1, 128).await;
            let outside = tempfile::tempdir().unwrap();
            let target = outside.path().join("sentinel");
            std::fs::write(&target, b"do not modify external cache target").unwrap();
            std::fs::create_dir(root.path().join("catalog")).unwrap();
            let path = root.path().join("catalog").join(if mode.is_sqlite() {
                "metadata.sqlite3"
            } else {
                "metadata.json"
            });
            if hard_link {
                std::fs::hard_link(&target, &path).unwrap();
            } else {
                std::os::unix::fs::symlink(&target, &path).unwrap();
            }
            let before = facts(root.path());
            let engine = open(root.path(), mode);
            assert!(
                engine.store.loading_metrics()["cacheErrors"]
                    .as_u64()
                    .unwrap()
                    > 0
            );
            assert_eq!(
                engine
                    .read(&original[0].id, true)
                    .await
                    .unwrap()
                    .turns
                    .len(),
                1
            );
            assert_eq!(facts(root.path()), before);
            engine.shutdown().await;
            drop(engine);
            assert_eq!(
                std::fs::read(&target).unwrap(),
                b"do not modify external cache target"
            );
            assert_eq!(
                std::fs::read(&path).unwrap(),
                b"do not modify external cache target"
            );
        }
    }
}

#[tokio::test]
async fn duplicate_cached_identities_rebuild_from_facts_instead_of_remaining_disabled() {
    for mode in [SessionCatalog::MemoryLazy, SessionCatalog::SqliteLazy] {
        let (root, _) = fixture(2, 128).await;
        let engine = open(root.path(), mode);
        engine.shutdown().await;
        drop(engine);
        if mode.is_sqlite() {
            let connection =
                rusqlite::Connection::open(root.path().join("catalog/metadata.sqlite3")).unwrap();
            connection
                .execute(
                    "UPDATE metadata SET body=(SELECT body FROM metadata ORDER BY id LIMIT 1)",
                    [],
                )
                .unwrap();
        } else {
            let path = root.path().join("catalog/metadata.json");
            let mut envelope: Envelope =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let mut rows: Vec<Cached> = serde_json::from_str(envelope.rows.get()).unwrap();
            rows[1] = rows[0].clone();
            let encoded = serde_json::to_string(&rows).unwrap();
            envelope.checksum = format!("{:x}", Sha256::digest(encoded.as_bytes()));
            envelope.rows = serde_json::value::RawValue::from_string(encoded).unwrap();
            std::fs::write(&path, serde_json::to_vec(&envelope).unwrap()).unwrap();
        }
        let before = facts(root.path());
        let engine = open(root.path(), mode);
        assert_eq!(engine.list(None, 100, None).await.unwrap().0.len(), 2);
        assert_eq!(engine.store.loading_metrics()["factsParsed"], 2);
        engine.shutdown().await;
        drop(engine);
        let engine = open(root.path(), mode);
        assert_eq!(engine.store.loading_metrics()["cacheHits"], 2);
        assert_eq!(facts(root.path()), before);
        engine.shutdown().await;
    }
}
