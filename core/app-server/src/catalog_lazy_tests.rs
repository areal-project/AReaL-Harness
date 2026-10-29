//! 独立子进程测恢复和驻留量；文件准备由另一个进程执行，不污染被测峰值。
use super::*;
use areal_engine::{Limits, SessionCatalog};
use areal_protocol::{Thread, TurnStatus};
use std::{path::PathBuf, sync::Mutex as StdMutex, time::Instant};

fn mode() -> SessionCatalog {
    match std::env::var("AREAL_CATALOG_TEST_BACKEND").as_deref() {
        Ok("sqlite") => SessionCatalog::Sqlite,
        Ok("memory-lazy") => SessionCatalog::MemoryLazy,
        Ok("sqlite-lazy") => SessionCatalog::SqliteLazy,
        _ => SessionCatalog::Memory,
    }
}
fn number(name: &str) -> usize {
    std::env::var(name).unwrap().parse().unwrap()
}
fn rss() -> u64 {
    let output = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout)
        .unwrap()
        .trim()
        .parse::<u64>()
        .unwrap()
        * 1024
}
fn emit(value: Value) {
    eprintln!("LAZY_CATALOG_PERF {value}");
}

// 只在独立诊断进程订阅既有落盘计时点，不改生产写入路径或同步语义。
struct PersistencePhases(Arc<StdMutex<Vec<Value>>>);
impl tracing::Subscriber for PersistencePhases {
    fn enabled(&self, metadata: &tracing::Metadata<'_>) -> bool {
        metadata.target() == "areal::persistence"
    }
    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }
    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
    fn event(&self, event: &tracing::Event<'_>) {
        struct Fields(serde_json::Map<String, Value>);
        impl tracing::field::Visit for Fields {
            fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
                let encoded = format!("{value:?}");
                self.0.insert(
                    field.name().into(),
                    serde_json::from_str(&encoded).unwrap_or(Value::String(encoded)),
                );
            }
        }
        let mut fields = Fields(serde_json::Map::new());
        event.record(&mut fields);
        self.0.lock().unwrap().push(Value::Object(fields.0));
    }
    fn enter(&self, _: &tracing::span::Id) {}
    fn exit(&self, _: &tracing::span::Id) {}
}

struct RecordingModel(StdMutex<Vec<Vec<areal_engine::model::Message>>>);
#[async_trait::async_trait]
impl areal_engine::model::Model for RecordingModel {
    fn name(&self) -> &str {
        "catalog-loading-fixture"
    }
    async fn stream(
        &self,
        messages: Vec<areal_engine::model::Message>,
    ) -> anyhow::Result<areal_engine::model::ModelStream> {
        self.0.lock().unwrap().push(messages);
        Ok(Box::pin(futures_util::stream::iter([
            Ok(areal_engine::model::ModelEvent::text("completed fixture")),
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

fn limits(selected: SessionCatalog) -> Limits {
    Limits {
        session_catalog: selected,
        context_window_tokens: 2_000_000,
        max_history_bytes: 0,
        ..Default::default()
    }
}

async fn prepare(root: &std::path::Path, count: usize, body: usize, metadata: usize, case: &str) {
    assert!(root.is_absolute());
    assert!(
        std::fs::read_dir(root).unwrap().next().is_none(),
        "fixture destination must be empty"
    );
    let model = Arc::new(RecordingModel(StdMutex::new(Vec::new())));
    let engine = Engine::open(root, model, limits(SessionCatalog::Memory)).unwrap();
    let template = engine.create("/workspace".into()).await.unwrap();
    engine.shutdown().await;
    drop(engine);
    std::fs::remove_file(root.join(format!("{}.json", template.id))).unwrap();
    for index in 1..=count {
        let mut thread = template.clone();
        thread.id = uuid::Uuid::from_u128(index as u128).to_string();
        thread.session_id = thread.id.clone();
        thread.name = Some(format!("Session {index}"));
        thread.preview = format!("Fixture {index}");
        thread.created_at = 1_700_000_000 + (index / 8) as i64;
        thread.updated_at = thread.created_at;
        if body > 0 {
            thread.turns=serde_json::from_value(json!([{"id":format!("turn-{index}"),"status":"completed","error":null,
                "items":[{"id":format!("user-{index}"),"type":"userMessage","content":[{"type":"text","text":format!("original request {index}")}]},
                {"id":format!("answer-{index}"),"type":"agentMessage","text":format!("history-{index}:")+&"x".repeat(body)}]}])).unwrap();
        }
        if metadata > 0 || case == "archiveGap" || case == "mixed" {
            let mut desktop = areal_protocol::desktop::DesktopState::default();
            desktop.configuration.options.append_instructions = "m".repeat(metadata);
            desktop.archived = match case {
                "archiveGap" => index > 100 && index < count,
                "mixed" => index % 7 == 0,
                _ => false,
            };
            thread.desktop = Some(desktop);
        }
        if case == "mixed" && index % 5 == 0 {
            thread.parent_thread_id = Some(uuid::Uuid::from_u128((index - 1) as u128).to_string());
            thread.session_id = thread.parent_thread_id.clone().unwrap();
            thread.source = "nativeTaskAgent".into();
        }
        if case == "cli" {
            thread.source = "cli".into();
        }
        super::catalog_tests::write_thread(root, &thread);
    }
    emit(json!({"operation":"prepared","count":count,"bodyBytes":body,"metadataBytes":metadata}));
}

async fn directory(conn: &Connection, engine: &Arc<Engine>, params: Value) -> (Vec<f64>, usize) {
    let mut samples = Vec::new();
    let mut length = 0;
    for round in 0..12 {
        let start = Instant::now();
        let page = conn
            .conversation_list(engine, params.clone())
            .await
            .unwrap();
        std::hint::black_box(serde_json::to_vec(&page).unwrap());
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        length = page["data"].as_array().unwrap().len();
        if round >= 2 {
            samples.push(elapsed);
        }
    }
    (samples, length)
}

#[tokio::test]
#[ignore = "显式四方案恢复、分阶段内存与查询对照；准备和观测必须使用不同进程"]
async fn lazy_catalog_process_comparison() {
    let root = PathBuf::from(std::env::var("AREAL_LAZY_PERF_ROOT").unwrap());
    let operation = std::env::var("AREAL_LAZY_PERF_OPERATION").unwrap();
    let count = number("AREAL_LAZY_PERF_COUNT");
    let case = std::env::var("AREAL_LAZY_PERF_CASE").unwrap();
    if operation == "prepare" {
        prepare(
            &root,
            count,
            number("AREAL_LAZY_PERF_BODY"),
            number("AREAL_LAZY_PERF_METADATA"),
            &case,
        )
        .await;
        return;
    }
    let selected = mode();
    let persistence =
        (std::env::var("AREAL_LAZY_PERF_PERSISTENCE").as_deref() == Ok("1")).then(|| {
            let events = Arc::new(StdMutex::new(Vec::new()));
            tracing::subscriber::set_global_default(PersistencePhases(events.clone())).unwrap();
            events
        });
    let model = Arc::new(RecordingModel(StdMutex::new(Vec::new())));
    let before = rss();
    let start = Instant::now();
    let engine = Engine::open(&root, model.clone(), limits(selected)).unwrap();
    let open = start.elapsed().as_secs_f64() * 1000.0;
    let start = Instant::now();
    engine.recover_desktop_default_models().await.unwrap();
    let ready = open + start.elapsed().as_secs_f64() * 1000.0;
    emit(
        json!({"operation":"startup","openMs":open,"readyMs":ready,"residentBefore":before,"residentAfter":rss(),"metrics":engine.catalog_metrics().await,
        "threadBytes":std::mem::size_of::<Thread>()}),
    );
    if selected == SessionCatalog::Sqlite {
        assert_eq!(engine.catalog_metrics().await["active"], "sqlite");
    }
    if operation == "startup" {
        engine.shutdown().await;
        return;
    }
    let conn = super::catalog_tests::connection(auth::Principal::embedded());
    let (samples, rows) = directory(
        &conn,
        &engine,
        json!({"view":"all","includeArchived":true,"limit":100}),
    )
    .await;
    assert_eq!(rows, count.min(100));
    emit(json!({"operation":"firstPage","samplesMs":samples}));
    let mut principal = (*auth::Principal::embedded()).clone();
    principal.thread_ids = Some(
        (1..=count)
            .filter(|id| id % 100 == 0)
            .map(|id| uuid::Uuid::from_u128(id as u128).to_string())
            .collect(),
    );
    let filtered = super::catalog_tests::connection(Arc::new(principal));
    let (samples, rows) = directory(
        &filtered,
        &engine,
        json!({"view":"all","includeArchived":true,"limit":100}),
    )
    .await;
    assert_eq!(rows, (count / 100).min(100));
    emit(json!({"operation":"sparsePage","samplesMs":samples}));
    let (samples, _) = directory(&conn, &engine, json!({"view":"all","limit":100})).await;
    emit(json!({"operation":"archiveFilter","samplesMs":samples}));
    let (samples, rows) = directory(
        &conn,
        &engine,
        json!({"view":"all","includeArchived":true,"sourceThreadId":uuid::Uuid::from_u128(1).to_string(),"limit":100}),
    )
    .await;
    assert_eq!(rows, 0);
    emit(json!({"operation":"sourceFilter","samplesMs":samples}));
    if case == "cli" {
        let (samples, rows) = directory(
            &conn,
            &engine,
            json!({"view":"main","includeArchived":true,"limit":100}),
        )
        .await;
        assert_eq!(rows, count.min(100), "CLI 根会话属于既有主目录");
        emit(json!({"operation":"mainView","samplesMs":samples}));
    }
    let mut samples = Vec::new();
    for round in 0..7 {
        let start = Instant::now();
        let mut cursor = Value::Null;
        let mut seen = 0;
        loop {
            let page = conn
                .conversation_list(
                    &engine,
                    json!({"view":"all","includeArchived":true,"limit":100,"cursor":cursor}),
                )
                .await
                .unwrap();
            std::hint::black_box(serde_json::to_vec(&page).unwrap());
            seen += page["data"].as_array().unwrap().len();
            cursor = page["nextCursor"].clone();
            if cursor.is_null() {
                break;
            }
        }
        assert_eq!(seen, count);
        if round >= 2 {
            samples.push(start.elapsed().as_secs_f64() * 1000.0);
        }
    }
    let metrics = engine.catalog_metrics().await;
    if selected.is_lazy() {
        assert_eq!(metrics["loading"]["historyMaterializations"], 0);
    }
    emit(
        json!({"operation":"fullDirectory","samplesMs":samples,"residentAfter":rss(),"metrics":metrics}),
    );
    if matches!(operation.as_str(), "execution" | "preloaded-execution") {
        let id = uuid::Uuid::from_u128(9).to_string();
        let preload = if operation == "preloaded-execution" {
            let start = Instant::now();
            std::hint::black_box(engine.read(&id, true).await.unwrap());
            Some(start.elapsed().as_secs_f64() * 1000.0)
        } else {
            None
        };
        let start = Instant::now();
        engine
            .start(&id, vec![areal_protocol::Input::text("new request")])
            .await
            .unwrap();
        let admitted = start.elapsed().as_secs_f64() * 1000.0;
        let result = engine.wait(&id).await.unwrap();
        assert_eq!(result.turns.last().unwrap().status, TurnStatus::Completed);
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        let digest = {
            let requests = model.0.lock().unwrap();
            assert_eq!(requests.len(), 1);
            let content: Vec<_> = requests[0]
                .iter()
                .filter(|m| matches!(m.role.as_str(), "user" | "assistant"))
                .map(|m| (&m.role, m.text_content()))
                .collect();
            format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&content).unwrap())
            )
        };
        emit(
            json!({"operation":"firstExecution","samplesMs":[elapsed],"startMs":admitted,"waitMs":elapsed-admitted,"preloadMs":preload,"persistencePhases":persistence.as_ref().map(|events|events.lock().unwrap().clone()),"modelRequests":1,"historyInputHash":digest,"metrics":engine.catalog_metrics().await}),
        );
    }
    let first_id = match case.as_str() {
        "archiveGap" => 101,
        "mixed" => 7,
        _ => 1,
    };
    let id = uuid::Uuid::from_u128(first_id).to_string();
    let start = Instant::now();
    let thread = engine.read(&id, true).await.unwrap();
    std::hint::black_box(serde_json::to_vec(&thread).unwrap());
    emit(
        json!({"operation":"firstHistory","samplesMs":[start.elapsed().as_secs_f64()*1000.0],"turnCount":thread.turns.len(),"archived":thread.desktop.as_ref().is_some_and(|d|d.archived),"residentAfter":rss(),"metrics":engine.catalog_metrics().await}),
    );
    drop(thread);
    let mut samples = Vec::new();
    for _ in 0..10 {
        let start = Instant::now();
        let thread = engine.read(&id, true).await.unwrap();
        std::hint::black_box(serde_json::to_vec(&thread).unwrap());
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    emit(json!({"operation":"repeatHistory","samplesMs":samples}));
    for index in 1..=count.min(8) {
        if index as u128 == first_id {
            continue;
        }
        std::hint::black_box(
            engine
                .read(&uuid::Uuid::from_u128(index as u128).to_string(), true)
                .await
                .unwrap(),
        );
    }
    emit(
        json!({"operation":"eightOpened","residentAfter":rss(),"metrics":engine.catalog_metrics().await}),
    );
    if operation == "all" {
        let start = Instant::now();
        for index in 1..=count {
            let id = uuid::Uuid::from_u128(index as u128).to_string();
            std::hint::black_box(engine.read(&id, true).await.unwrap());
            if !engine
                .read(&id, false)
                .await
                .unwrap()
                .desktop
                .as_ref()
                .is_some_and(|d| d.archived)
            {
                drop(engine.subscribe(&id).await.unwrap());
            }
        }
        emit(
            json!({"operation":"allOpened","elapsedMs":start.elapsed().as_secs_f64()*1000.0,"residentAfter":rss(),"metrics":engine.catalog_metrics().await}),
        );
    }
    engine.shutdown().await;
}
