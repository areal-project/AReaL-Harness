//! 目录查询通过真实 Engine 与 RPC 投影测量，不把文件准备和恢复计入查询耗时。
use super::*;
use areal_protocol::Thread;
use std::time::Instant;

pub(super) fn connection(principal: Arc<auth::Principal>) -> Connection {
    let (tx, _rx) = mpsc::channel(1);
    let stop = CancellationToken::new();
    Connection {
        configuration: None,
        principal,
        tool_host: dynamic_tools::ToolHost::new(tx.clone(), stop.clone()),
        initialized: true,
        experimental_api: false,
        ready: true,
        owner_subscription: None,
        subscriptions: HashMap::new(),
        suppressed: HashSet::new(),
        tx,
        stop,
        tasks: TaskTracker::new(),
        delivery: Arc::new(Mutex::new(())),
        rpc_permits: Arc::new(tokio::sync::Semaphore::new(16)),
    }
}

fn model() -> Arc<dyn areal_engine::model::Model> {
    Arc::new(
        areal_engine::model::ChatModel::new(
            "http://127.0.0.1:9".into(),
            "catalog-fixture".into(),
            None,
        )
        .unwrap(),
    )
}

fn catalog_limits() -> areal_engine::Limits {
    areal_engine::Limits {
        session_catalog: match std::env::var("AREAL_CATALOG_TEST_BACKEND").as_deref() {
            Ok("sqlite") => areal_engine::SessionCatalog::Sqlite,
            Ok("memory") => areal_engine::SessionCatalog::Memory,
            Ok("memory-lazy") => areal_engine::SessionCatalog::MemoryLazy,
            Ok("sqlite-lazy") => areal_engine::SessionCatalog::SqliteLazy,
            Err(_) => areal_engine::Limits::default().session_catalog,
            _ => panic!("invalid catalog test backend"),
        },
        ..Default::default()
    }
}

async fn fixture(count: usize, history_bytes: usize) -> (tempfile::TempDir, Arc<Engine>) {
    fixture_rows(count, history_bytes, |_, _| {}).await
}

async fn fixture_rows(
    count: usize,
    history_bytes: usize,
    prepare: impl Fn(usize, &mut Thread),
) -> (tempfile::TempDir, Arc<Engine>) {
    let root = fixture_files(count, history_bytes, prepare).await;
    let engine = Engine::open(root.path(), model(), catalog_limits()).unwrap();
    if catalog_limits().session_catalog == areal_engine::SessionCatalog::Sqlite {
        assert_eq!(engine.catalog_metrics().await["sqlite"]["disabled"], false);
    }
    (root, engine)
}

async fn fixture_files(
    count: usize,
    history_bytes: usize,
    prepare: impl Fn(usize, &mut Thread),
) -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    let engine = Engine::open(root.path(), model(), areal_engine::Limits::default()).unwrap();
    let thread = engine
        .create(root.path().to_string_lossy().into_owned())
        .await
        .unwrap();
    engine.shutdown().await;
    drop(engine);
    std::fs::remove_file(root.path().join(format!("{}.json", thread.id))).unwrap();
    for index in 0..count {
        let mut row = thread.clone();
        row.id = uuid::Uuid::from_u128(index as u128 + 1).to_string();
        row.session_id = row.id.clone();
        row.created_at = 1_700_000_000 + (index / 8) as i64;
        row.updated_at = row.created_at;
        row.name = Some(format!("Conversation {index}"));
        row.preview = format!("Catalog fixture {index}");
        if history_bytes > 0 {
            row.turns = serde_json::from_value(json!([{
                "id":format!("turn-{index}"), "status":"completed", "error":null,
                "items":[{"type":"agentMessage","id":format!("item-{index}"),
                    "text":"x".repeat(history_bytes)}]
            }]))
            .unwrap();
        }
        prepare(index, &mut row);
        write_thread(root.path(), &row);
    }
    root
}

#[tokio::test]
async fn metadata_matches_legacy_fields_without_changing_persistent_records() {
    let (root, engine) = fixture_rows(2, 512 * 1024, |_, thread| {
        let mut desktop = areal_protocol::desktop::DesktopState::default();
        desktop.configuration.revision = 17;
        desktop.configuration.options.append_instructions = "preserved metadata".into();
        thread.desktop = Some(desktop);
        thread.name_attempt_turn_id = Some("attempted-turn".into());
        thread.dynamic_tools = serde_json::from_value(json!([{
            "name":"catalog_fixture", "description":"preserve the original tool metadata",
            "inputSchema":{"type":"object","properties":{}}
        }]))
        .unwrap();
        thread.toolset_revision = 7;
    })
    .await;
    let before: Vec<_> = (1..=2)
        .map(|id| {
            let path = root
                .path()
                .join(format!("{}.json", uuid::Uuid::from_u128(id)));
            (path.clone(), std::fs::read(path).unwrap())
        })
        .collect();
    let mut conn = connection(auth::Principal::embedded());
    let page = conn
        .dispatch(&engine, "thread/list", json!({"limit":2}))
        .await
        .unwrap();
    for value in page["data"].as_array().unwrap() {
        let id = value["id"].as_str().unwrap();
        let mut expected = engine.read(id, true).await.unwrap();
        expected.turns.clear();
        expected.context_checkpoint = None;
        expected.history_archive = None;
        assert_eq!(*value, serde_json::to_value(&expected).unwrap());
        assert_eq!(
            *value,
            serde_json::to_value(engine.read(id, false).await.unwrap()).unwrap()
        );
    }
    assert!(page["nextCursor"].is_null());
    for (path, bytes) in before {
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
    engine.shutdown().await;
}

#[tokio::test]
async fn creation_cursor_keeps_timestamp_ties_and_existing_cursor_encoding() {
    let (_root, engine) = fixture_rows(6, 16, |index, thread| {
        thread.created_at = [30, 10, 10, 20, 10, 30][index];
    })
    .await;
    let conn = connection(auth::Principal::embedded());
    let mut next = Value::Null;
    let mut ids = Vec::new();
    for _ in 0..3 {
        let page = conn
            .conversation_list(
                &engine,
                json!({"view":"main","includeArchived":true,"limit":2,"cursor":next}),
            )
            .await
            .unwrap();
        ids.extend(
            page["data"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| t["id"].clone()),
        );
        next = page["nextCursor"].clone();
        if let Some(encoded) = next.as_str() {
            let saved: ConversationCursor =
                serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap();
            assert_eq!(saved.id, ids.last().unwrap().as_str().unwrap());
        }
    }
    assert!(next.is_null());
    assert_eq!(
        ids,
        [2, 3, 5, 4, 1, 6]
            .map(|id| json!(uuid::Uuid::from_u128(id).to_string()))
            .to_vec()
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn filtering_and_authorization_precede_page_size_for_both_list_routes() {
    let (_root, engine) = fixture_rows(12, 16, |index, thread| {
        if index % 4 == 1 {
            thread.source = "nativeTaskAgent".into();
        } else if index % 4 == 2 {
            thread.source = "nativeResearchAgent".into();
        } else if index % 4 == 3 {
            thread.parent_thread_id = Some(uuid::Uuid::from_u128(1).to_string());
            thread.session_id = uuid::Uuid::from_u128(1).to_string();
        }
        if index % 8 == 0 {
            thread.desktop = Some(areal_protocol::desktop::DesktopState {
                archived: true,
                ..Default::default()
            });
        }
    })
    .await;
    let mut principal = (*auth::Principal::embedded()).clone();
    principal.thread_ids = Some(
        [1, 4, 5, 6, 9, 12]
            .map(|id| uuid::Uuid::from_u128(id).to_string())
            .into(),
    );
    let mut conn = connection(Arc::new(principal));
    let active = conn
        .conversation_list(&engine, json!({"limit":2}))
        .await
        .unwrap();
    assert_eq!(active["data"].as_array().unwrap().len(), 1);
    assert_eq!(
        active["data"][0]["id"],
        uuid::Uuid::from_u128(5).to_string()
    );
    assert!(active["nextCursor"].is_null());
    let first = conn
        .conversation_list(&engine, json!({"includeArchived":true,"limit":2}))
        .await
        .unwrap();
    assert_eq!(first["data"].as_array().unwrap().len(), 2);
    let second = conn
        .conversation_list(
            &engine,
            json!({"includeArchived":true,"limit":2,"cursor":first["nextCursor"]}),
        )
        .await
        .unwrap();
    assert_eq!(
        second["data"][0]["id"],
        uuid::Uuid::from_u128(9).to_string()
    );
    assert!(second["nextCursor"].is_null());
    let mut seen = Vec::new();
    let mut next = Value::Null;
    loop {
        let page = conn
            .dispatch(&engine, "thread/list", json!({"limit":2,"cursor":next}))
            .await
            .unwrap();
        seen.extend(
            page["data"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| t["id"].clone()),
        );
        next = page["nextCursor"].clone();
        if next.is_null() {
            break;
        }
        assert_eq!(page["data"].as_array().unwrap().len(), 2);
    }
    assert_eq!(seen.len(), 6);
    let children = conn
        .dispatch(
            &engine,
            "areal/agent/list",
            json!({"limit":2,"parentThreadId":uuid::Uuid::from_u128(1).to_string()}),
        )
        .await
        .unwrap();
    assert_eq!(children["data"].as_array().unwrap().len(), 2);
    assert!(children["nextCursor"].is_null());
    engine.shutdown().await;
}

#[tokio::test]
async fn conversation_cursor_remains_bound_to_filter_and_principal() {
    let (_root, engine) = fixture(3, 0).await;
    let conn = connection(auth::Principal::embedded());
    let page = conn
        .conversation_list(&engine, json!({"limit":1,"includeArchived":true}))
        .await
        .unwrap();
    for params in [
        json!({"limit":1,"cursor":"not-a-cursor"}),
        json!({"limit":1,"cursor":page["nextCursor"]}),
        json!({"limit":1,"includeArchived":true,"view":"all","cursor":page["nextCursor"]}),
        json!({"limit":0}),
        json!({"limit":101}),
    ] {
        assert_eq!(
            conn.conversation_list(&engine, params)
                .await
                .unwrap_err()
                .code,
            -32602
        );
    }
    let mut principal = (*auth::Principal::embedded()).clone();
    principal.id = "other-reader".into();
    assert_eq!(
        connection(Arc::new(principal))
            .conversation_list(
                &engine,
                json!({"limit":1,"includeArchived":true,"cursor":page["nextCursor"]})
            )
            .await
            .unwrap_err()
            .code,
        -32602
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn first_page_does_not_wait_for_a_later_sessions_state_lock() {
    let (_root, engine) = fixture(16, 1024).await;
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let holding = {
        let engine = engine.clone();
        let entered = entered.clone();
        let release = release.clone();
        tokio::spawn(async move {
            engine
                .test_hold_thread_state(&uuid::Uuid::from_u128(16).to_string(), entered, release)
                .await;
        })
    };
    entered.notified().await;
    let conn = connection(auth::Principal::embedded());
    let read = tokio::time::timeout(
        Duration::from_millis(300),
        conn.conversation_list(&engine, json!({"limit":2,"includeArchived":true})),
    )
    .await;
    release.notify_one();
    holding.await.unwrap();
    assert_eq!(read.unwrap().unwrap()["data"].as_array().unwrap().len(), 2);
    engine.shutdown().await;
}

#[tokio::test]
async fn denied_sessions_cannot_block_an_authorized_directory_query() {
    let (_root, engine) = fixture(16, 1024).await;
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let holding = {
        let engine = engine.clone();
        let entered = entered.clone();
        let release = release.clone();
        tokio::spawn(async move {
            engine
                .test_hold_thread_state(&uuid::Uuid::from_u128(1).to_string(), entered, release)
                .await;
        })
    };
    entered.notified().await;
    let mut principal = (*auth::Principal::embedded()).clone();
    principal.thread_ids = Some([uuid::Uuid::from_u128(16).to_string()].into());
    let mut conn = connection(Arc::new(principal));
    let read = tokio::time::timeout(Duration::from_secs(2), async {
        let created = conn
            .conversation_list(&engine, json!({"limit":1,"includeArchived":true}))
            .await
            .unwrap();
        let uuid = conn
            .dispatch(&engine, "thread/list", json!({"limit":1}))
            .await
            .unwrap();
        assert_eq!(
            created["data"][0]["id"],
            uuid::Uuid::from_u128(16).to_string()
        );
        assert_eq!(uuid["data"][0]["id"], created["data"][0]["id"]);
    })
    .await;
    release.notify_one();
    holding.await.unwrap();
    read.unwrap();
    engine.shutdown().await;
}

#[tokio::test]
async fn archive_and_new_registration_update_the_existing_catalog() {
    let (_root, engine) = fixture(1, 1024).await;
    let conn = connection(auth::Principal::embedded());
    let id = uuid::Uuid::from_u128(1).to_string();
    engine.archive_thread(id.clone()).await.unwrap();
    assert!(
        conn.conversation_list(&engine, json!({})).await.unwrap()["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let archived = conn
        .conversation_list(&engine, json!({"includeArchived":true}))
        .await
        .unwrap();
    assert_eq!(archived["data"][0]["desktop"]["archived"], true);
    let created = engine
        .create(_root.path().to_string_lossy().into_owned())
        .await
        .unwrap();
    let current = conn.conversation_list(&engine, json!({})).await.unwrap();
    assert_eq!(current["data"].as_array().unwrap().len(), 1);
    assert_eq!(current["data"][0]["id"], created.id);
    engine.shutdown().await;
}

#[tokio::test]
async fn fork_registration_and_origin_filter_use_the_same_creation_catalog() {
    let (_root, engine) = fixture(1, 32).await;
    let source_id = uuid::Uuid::from_u128(1).to_string();
    let fork = engine
        .fork_thread(
            "catalog-reader".into(),
            serde_json::from_value(json!({
                "requestId":"catalog-fork", "sourceThreadId":source_id,
                "anchor":{"turnId":"turn-0","boundary":"after"},"workspaceMode":"sharedCurrent"
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    let conn = connection(auth::Principal::embedded());
    let related = conn
        .conversation_list(
            &engine,
            json!({"view":"all","sourceThreadId":source_id,"limit":1}),
        )
        .await
        .unwrap();
    assert_eq!(related["data"][0]["id"], fork.id);
    assert!(related["nextCursor"].is_null());
    let side = conn
        .conversation_list(&engine, json!({"view":"side","sourceThreadId":source_id}))
        .await
        .unwrap();
    assert!(side["data"].as_array().unwrap().is_empty());
    let main = conn.conversation_list(&engine, json!({})).await.unwrap();
    assert_eq!(main["data"].as_array().unwrap().len(), 2);
    engine.shutdown().await;
}

pub(super) fn write_thread(root: &std::path::Path, thread: &Thread) {
    std::fs::write(
        root.join(format!("{}.json", thread.id)),
        serde_json::to_vec(&json!({"version":areal_engine::state_version(),"thread":thread}))
            .unwrap(),
    )
    .unwrap();
}

#[tokio::test]
async fn nearly_full_page_still_finds_a_distant_authorized_continuation() {
    let (_root, engine) = fixture(2_000, 0).await;
    let mut principal = (*auth::Principal::embedded()).clone();
    principal.thread_ids = Some(
        (1..=100)
            .chain([2_000])
            .map(|id| uuid::Uuid::from_u128(id).to_string())
            .collect(),
    );
    let conn = connection(Arc::new(principal));
    let first = conn
        .conversation_list(&engine, json!({"limit":100,"includeArchived":true}))
        .await
        .unwrap();
    assert_eq!(first["data"].as_array().unwrap().len(), 100);
    assert!(first["nextCursor"].is_string());
    let last = conn
        .conversation_list(
            &engine,
            json!({"limit":100,"includeArchived":true,"cursor":first["nextCursor"]}),
        )
        .await
        .unwrap();
    assert_eq!(last["data"].as_array().unwrap().len(), 1);
    assert_eq!(
        last["data"][0]["id"],
        uuid::Uuid::from_u128(2_000).to_string()
    );
    assert!(last["nextCursor"].is_null());
    engine.shutdown().await;
}

#[tokio::test]
async fn mixed_directory_pages_equal_the_complete_authorized_reference() {
    let (_root, engine) = fixture_rows(257, 128, |index, thread| {
        thread.created_at = 1_700_000_000 + ((index * 73) % 37) as i64;
        thread.source = [
            "appServer",
            "nativeTaskAgent",
            "nativeResearchAgent",
            "appServer",
        ][index % 4]
            .into();
        if index % 7 == 1 {
            thread.parent_thread_id = Some(uuid::Uuid::from_u128(1).to_string());
            thread.session_id = uuid::Uuid::from_u128(1).to_string();
        }
        if index % 5 == 0 {
            thread.desktop = Some(areal_protocol::desktop::DesktopState {
                archived: true,
                ..Default::default()
            });
        }
    })
    .await;
    let mut principal = (*auth::Principal::embedded()).clone();
    principal.thread_ids = Some(
        (1..=257)
            .filter(|id| id % 3 != 0)
            .map(|id| uuid::Uuid::from_u128(id).to_string())
            .collect(),
    );
    let mut reference = Vec::new();
    for id in 1..=257 {
        let mut row = engine
            .read(&uuid::Uuid::from_u128(id).to_string(), true)
            .await
            .unwrap();
        row.turns.clear();
        row.history_archive = None;
        row.context_checkpoint = None;
        reference.push(row);
    }
    reference.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
    let principal = Arc::new(principal);
    let conn = connection(principal.clone());
    for view in ["main", "all"] {
        for include_archived in [false, true] {
            let expected: Vec<_> = reference
                .iter()
                .filter(|row| {
                    principal.sees(&row.id)
                        && (include_archived || !row.desktop.as_ref().is_some_and(|d| d.archived))
                        && (view == "all"
                            || (row.parent_thread_id.is_none() && row.source == "appServer"))
                })
                .map(|row| serde_json::to_value(row).unwrap())
                .collect();
            for limit in [1, 7, 100] {
                let mut next = Value::Null;
                let mut actual = Vec::new();
                loop {
                    let page = conn
                        .conversation_list(
                            &engine,
                            json!({"view":view,"includeArchived":include_archived,
                                "limit":limit,"cursor":next}),
                        )
                        .await
                        .unwrap();
                    let rows = page["data"].as_array().unwrap();
                    assert!(rows.len() <= limit);
                    actual.extend(rows.iter().cloned());
                    next = page["nextCursor"].clone();
                    if next.is_null() {
                        break;
                    }
                    assert_eq!(rows.len(), limit);
                    assert!(actual.len() < expected.len());
                }
                assert_eq!(actual, expected, "{view}/{include_archived}/{limit}");
            }
        }
    }
    engine.shutdown().await;
}

#[tokio::test]
#[ignore = "稀疏授权的局部性能对照；不设 CI 耗时断言"]
async fn catalog_filter_performance_comparison() {
    let phase = std::env::var("AREAL_CATALOG_PERF_PHASE").unwrap_or_else(|_| "candidate".into());
    for count in [2_000, 20_000] {
        let (_root, engine) = fixture(count, 0).await;
        for case in ["dense", "sparse", "tailGap", "noMatch"] {
            let mut principal = (*auth::Principal::embedded()).clone();
            if case != "dense" {
                principal.thread_ids = Some(
                    (1..=count)
                        .filter(|id| match case {
                            "sparse" => id % 100 == 0,
                            "tailGap" => *id <= 100 || *id == count,
                            _ => false,
                        })
                        .map(|id| uuid::Uuid::from_u128(id as u128).to_string())
                        .collect(),
                );
            }
            let expected = match case {
                "dense" | "tailGap" => 100,
                "sparse" => (count / 100).min(100),
                _ => 0,
            };
            let conn = connection(Arc::new(principal));
            let mut samples = Vec::new();
            for round in 0..12 {
                let started = Instant::now();
                let result = conn
                    .conversation_list(&engine, json!({"limit":100,"includeArchived":true}))
                    .await
                    .unwrap();
                std::hint::black_box(serde_json::to_vec(&result).unwrap());
                let elapsed = started.elapsed().as_secs_f64() * 1000.0;
                assert_eq!(result["data"].as_array().unwrap().len(), expected);
                if round >= 2 {
                    samples.push(elapsed);
                }
            }
            eprintln!(
                "CATALOG_FILTER_PERF {}",
                json!({"phase":phase,"case":case,"count":count,"limit":100,"samplesMs":samples})
            );
        }
        eprintln!("CATALOG_BACKEND_METRICS {}", engine.catalog_metrics().await);
        engine.shutdown().await;
    }
}

#[tokio::test]
#[ignore = "显式比较目录启动、完整分页、事实写入与并发查询；不作 CI 耗时断言"]
async fn catalog_backend_performance_comparison() {
    let phase = std::env::var("AREAL_CATALOG_TEST_BACKEND").unwrap_or_else(|_| "memory".into());
    let selected_model = model();
    for (case, count, bytes, metadata_bytes) in [
        ("small", 100, 0, 0),
        ("history", 2_000, 16 * 1024, 0),
        ("many", 20_000, 0, 0),
        ("metadata", 2_000, 0, 4 * 1024),
    ] {
        let root = fixture_files(count, bytes, |_, row| {
            if metadata_bytes > 0 {
                let mut desktop = areal_protocol::desktop::DesktopState::default();
                desktop.configuration.options.append_instructions = "m".repeat(metadata_bytes);
                row.desktop = Some(desktop);
            }
        })
        .await;
        for temperature in ["indexRebuild", "indexReuse"] {
            let start = Instant::now();
            let engine =
                Engine::open(root.path(), selected_model.clone(), catalog_limits()).unwrap();
            let elapsed = start.elapsed().as_secs_f64() * 1000.0;
            let metrics = engine.catalog_metrics().await;
            if phase == "sqlite" {
                assert_eq!(metrics["active"], "sqlite");
            }
            eprintln!(
                "CATALOG_BACKEND_PERF {}",
                json!({"backend":phase,"case":case,"count":count,"historyBytesPerThread":bytes,
                "operation":temperature,"samplesMs":[elapsed],"metrics":metrics})
            );
            if temperature == "indexReuse" {
                let conn = connection(auth::Principal::embedded());
                let mut samples = Vec::new();
                for round in 0..7 {
                    let start = Instant::now();
                    let mut cursor = Value::Null;
                    let mut total = 0;
                    loop {
                        let page = conn
                            .conversation_list(
                                &engine,
                                json!({"limit":100,"includeArchived":true,"cursor":cursor}),
                            )
                            .await
                            .unwrap();
                        std::hint::black_box(serde_json::to_vec(&page).unwrap());
                        total += page["data"].as_array().unwrap().len();
                        cursor = page["nextCursor"].clone();
                        if cursor.is_null() {
                            break;
                        }
                    }
                    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                    assert_eq!(total, count);
                    if round >= 2 {
                        samples.push(elapsed);
                    }
                }
                eprintln!(
                    "CATALOG_BACKEND_PERF {}",
                    json!({"backend":phase,"case":case,"count":count,
                    "operation":"fullDirectory","samplesMs":samples,"metrics":engine.catalog_metrics().await})
                );
            }
            engine.shutdown().await;
        }
    }
    backend_dynamic_filters(&phase).await;
    backend_writes_and_reads(&phase, false).await;
}

#[tokio::test]
#[ignore = "控制闭环查询的协作调度，诊断读写延迟差异；不作生产尾延迟承诺"]
async fn catalog_cooperative_concurrency_performance_comparison() {
    let phase = std::env::var("AREAL_CATALOG_TEST_BACKEND").unwrap_or_else(|_| "memory".into());
    backend_writes_and_reads(&phase, true).await;
}

async fn backend_dynamic_filters(phase: &str) {
    let count = 20_000;
    let (_root, engine) = fixture_rows(count, 0, |index, row| {
        row.source = "nativeTaskAgent".into();
        row.desktop = Some(areal_protocol::desktop::DesktopState {
            archived: index >= 100 && index + 1 < count,
            ..Default::default()
        });
    })
    .await;
    let conn = connection(auth::Principal::embedded());
    for (case, params, expected) in [
        ("archiveGap", json!({"view":"all","limit":100}), 100),
        (
            "sourceNoMatch",
            json!({"view":"main","includeArchived":true,"limit":100}),
            0,
        ),
    ] {
        let mut samples = Vec::new();
        for round in 0..12 {
            let start = Instant::now();
            let page = conn
                .conversation_list(&engine, params.clone())
                .await
                .unwrap();
            std::hint::black_box(serde_json::to_vec(&page).unwrap());
            let elapsed = start.elapsed().as_secs_f64() * 1000.0;
            assert_eq!(page["data"].as_array().unwrap().len(), expected);
            assert_eq!(!page["nextCursor"].is_null(), expected == 100);
            if round >= 2 {
                samples.push(elapsed);
            }
        }
        eprintln!(
            "CATALOG_BACKEND_PERF {}",
            json!({"backend":phase,"case":case,"count":count,"operation":"dynamicFilter",
                "samplesMs":samples,"metrics":engine.catalog_metrics().await})
        );
    }
    engine.shutdown().await;
}

struct SnapshotModel(std::sync::atomic::AtomicUsize);

#[async_trait::async_trait]
impl areal_engine::model::Model for SnapshotModel {
    fn name(&self) -> &str {
        "catalog-fixture"
    }
    async fn stream(
        &self,
        _: Vec<areal_engine::model::Message>,
    ) -> anyhow::Result<areal_engine::model::ModelStream> {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(Box::pin(futures_util::stream::iter([
            Ok(areal_engine::model::ModelEvent::text(
                "response ".repeat(128),
            )),
            Ok(areal_engine::model::ModelEvent::Usage(
                areal_protocol::ModelUsage {
                    input_tokens: 7,
                    output_tokens: 3,
                    cached_input_tokens: 0,
                },
            )),
        ])))
    }
}

async fn backend_writes_and_reads(phase: &str, cooperative: bool) {
    let root = fixture_files(100, 0, |_, _| {}).await;
    let model = Arc::new(SnapshotModel(std::sync::atomic::AtomicUsize::new(0)));
    let engine = Engine::open(root.path(), model.clone(), catalog_limits()).unwrap();
    let mut creates = Vec::new();
    for _ in 0..64 {
        let start = Instant::now();
        engine
            .create(root.path().to_string_lossy().into_owned())
            .await
            .unwrap();
        creates.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    let start = Instant::now();
    engine.flush_catalog().await;
    eprintln!(
        "CATALOG_BACKEND_PERF {}",
        json!({"backend":phase,"case":"writes","operation":"createFact", "samplesMs":creates,
        "indexDrainMs":start.elapsed().as_secs_f64()*1000.0,"metrics":engine.catalog_metrics().await})
    );
    let before = engine.catalog_metrics().await["sqlite"]["rowsWritten"].clone();
    let mut readers = Vec::new();
    for _ in 0..4 {
        let engine = engine.clone();
        readers.push(tokio::spawn(async move {
            let conn = connection(auth::Principal::embedded());
            let mut samples = Vec::new();
            for _ in 0..20 {
                let start = Instant::now();
                let result = conn
                    .conversation_list(&engine, json!({"limit":100,"includeArchived":true}))
                    .await
                    .unwrap();
                std::hint::black_box(serde_json::to_vec(&result).unwrap());
                samples.push(start.elapsed().as_secs_f64() * 1000.0);
                if cooperative {
                    // 内存读取可连续完成而不挂起；控制此调度差异，检验 State 写锁等待。
                    tokio::task::yield_now().await;
                }
            }
            samples
        }));
    }
    let id = uuid::Uuid::from_u128(1).to_string();
    let mut writes = Vec::new();
    for _ in 0..16 {
        let start = Instant::now();
        engine
            .start(&id, vec![areal_protocol::Input::text("fixture snapshot")])
            .await
            .unwrap();
        let result = engine.wait(&id).await.unwrap();
        assert_eq!(
            result.turns.last().unwrap().status,
            areal_protocol::TurnStatus::Completed
        );
        writes.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    let mut reads = Vec::new();
    for reader in readers {
        reads.extend(reader.await.unwrap());
    }
    engine.flush_catalog().await;
    assert_eq!(model.0.load(std::sync::atomic::Ordering::SeqCst), 16);
    assert_eq!(
        engine.catalog_metrics().await["sqlite"]["rowsWritten"],
        before
    );
    eprintln!(
        "CATALOG_BACKEND_PERF {}",
        json!({"backend":phase,"case":"mixed","operation":"turnWithReaders","cooperativeReaders":cooperative,"samplesMs":writes,
        "readSamplesMs":reads,"modelRequests":16,"metrics":engine.catalog_metrics().await})
    );
    engine.shutdown().await;
}

fn cursor(principal: &auth::Principal, index: usize) -> String {
    let filter = format!("{}\0main\0\0true", principal.id);
    URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&ConversationCursor {
            filter: format!("{:x}", Sha256::digest(filter.as_bytes())),
            created_at: 1_700_000_000 + (index / 8) as i64,
            id: uuid::Uuid::from_u128(index as u128 + 1).to_string(),
        })
        .unwrap(),
    )
}

#[tokio::test]
#[ignore = "本地显式性能对照；耗时不作为 CI 断言"]
async fn catalog_performance_comparison() {
    let phase = std::env::var("AREAL_CATALOG_PERF_PHASE").unwrap_or_else(|_| "candidate".into());
    for (case, count, history_bytes) in [
        ("small", 100, 0),
        ("history", 2_000, 16 * 1024),
        ("many", 20_000, 0),
    ] {
        let (_root, engine) = fixture(count, history_bytes).await;
        let principal = auth::Principal::embedded();
        let conn = connection(principal.clone());
        for (position, anchor) in [
            ("first", None),
            (
                "last",
                (count > 100).then(|| cursor(&principal, count - 101)),
            ),
        ] {
            if position == "last" && anchor.is_none() {
                continue;
            }
            let params = json!({"view":"main","includeArchived":true,"limit":100,"cursor":anchor});
            let mut samples = Vec::new();
            for round in 0..9 {
                let start = Instant::now();
                let result = conn
                    .conversation_list(&engine, params.clone())
                    .await
                    .unwrap();
                let encoded = serde_json::to_vec(&result).unwrap();
                let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                assert_eq!(result["data"].as_array().unwrap().len(), 100);
                std::hint::black_box(encoded);
                if round >= 2 {
                    samples.push(elapsed);
                }
            }
            eprintln!(
                "CATALOG_PERF {}",
                json!({"phase":phase,"case":case,"count":count,"historyBytesPerThread":history_bytes,
                    "operation":position,"samplesMs":samples})
            );
        }
        if count <= 2_000 {
            let mut samples = Vec::new();
            for _ in 0..5 {
                let start = Instant::now();
                let mut next = Value::Null;
                let mut seen = 0;
                loop {
                    let result = conn
                        .conversation_list(
                            &engine,
                            json!({"view":"main","includeArchived":true,"limit":100,"cursor":next}),
                        )
                        .await
                        .unwrap();
                    std::hint::black_box(serde_json::to_vec(&result).unwrap());
                    seen += result["data"].as_array().unwrap().len();
                    next = result["nextCursor"].clone();
                    if next.is_null() {
                        break;
                    }
                }
                samples.push(start.elapsed().as_secs_f64() * 1000.0);
                assert_eq!(seen, count);
            }
            eprintln!(
                "CATALOG_PERF {}",
                json!({"phase":phase,"case":case,"count":count,
                "historyBytesPerThread":history_bytes,"operation":"all","samplesMs":samples})
            );
        }
        engine.shutdown().await;
    }
}
