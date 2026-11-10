//! App 数据跨 Turn 变化不得改写已经提交给模型的指令或消息前缀。
use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelEvent, ModelStream, RequestPurpose},
    tools::DynamicToolHost,
};
use areal_plugins::Store;
use areal_protocol::{DynamicToolResponse, Input, TurnStatus, desktop::ThreadStart};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Capture(Mutex<Vec<Vec<Message>>>, Mutex<Vec<Vec<Message>>>);
#[async_trait]
impl Model for Capture {
    fn name(&self) -> &str {
        "app-prefix-fixture"
    }
    async fn stream(&self, messages: Vec<Message>) -> anyhow::Result<ModelStream> {
        let text = if messages
            .iter()
            .rev()
            .find(|message| message.role == "user")
            .is_some_and(|message| message.text_content() == "ack-app-no-app-history")
        {
            "Completed background work. ".repeat(600)
        } else {
            "done".into()
        };
        Ok(Box::pin(futures_util::stream::iter([Ok(
            ModelEvent::text(text),
        )])))
    }
    async fn chat_for(
        &self,
        messages: Vec<Message>,
        _: Vec<Value>,
        purpose: RequestPurpose,
    ) -> anyhow::Result<ModelStream> {
        if purpose == RequestPurpose::Summary {
            self.1.lock().unwrap().push(messages);
            return Ok(Box::pin(futures_util::stream::iter([Ok(
                ModelEvent::text(
                    "The App previously selected prefix-selection-stale. Continue the task.",
                ),
            )])));
        }
        if purpose == RequestPurpose::Solve
            && messages
                .iter()
                .any(|m| m.role == "user" && m.text_content().starts_with("ack-app-"))
        {
            self.0.lock().unwrap().push(messages.clone());
        }
        self.stream(messages).await
    }
}
struct NoTools;
#[async_trait]
impl DynamicToolHost for NoTools {
    fn id(&self) -> &str {
        "no-tools"
    }
    fn is_closed(&self) -> bool {
        false
    }
    async fn call(&self, _: Value, _: CancellationToken) -> anyhow::Result<DynamicToolResponse> {
        unreachable!()
    }
}
fn write(root: &Path, path: &str, content: &str) {
    let p = root.join(path);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, content).unwrap();
}

struct AppFixture {
    _workspace: tempfile::TempDir,
    data: tempfile::TempDir,
    engine: Arc<Engine>,
    model: Arc<Capture>,
    thread: String,
    instance: String,
    generation: u64,
}

async fn app_fixture(limits: Limits) -> AppFixture {
    let workspace = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    write(
        workspace.path(),
        ".agents/plugins/marketplace.json",
        r#"{"name":"local","plugins":[{"name":"sample","source":"./pkg"}]}"#,
    );
    write(
        workspace.path(),
        "pkg/.codex-plugin/plugin.json",
        r#"{"name":"sample"}"#,
    );
    write(
        workspace.path(),
        "pkg/server.py",
        include_str!("../../mcp/tests/substrate.py"),
    );
    write(
        workspace.path(),
        "pkg/.mcp.json",
        r#"{"mcpServers":{"fixture":{"command":"python3","args":["server.py"]}}}"#,
    );
    let model = Arc::new(Capture::default());
    let engine = Engine::open(data.path(), model.clone(), limits).unwrap();
    let store = Arc::new(
        Store::open(
            workspace.path().join("plugins"),
            workspace.path().into(),
            None,
        )
        .unwrap(),
    );
    engine.install_plugin_store(store.clone()).unwrap();
    let detail = store.read("sample@local").unwrap();
    engine
        .plugin_install(
            detail.id.clone(),
            "user".into(),
            detail.revision,
            detail.source,
            detail.source_digest,
        )
        .await
        .unwrap();
    let detail = store.read(&detail.id).unwrap();
    engine
        .plugin_connection(detail.id, detail.installed_digest.unwrap(), true)
        .await
        .unwrap();
    let apps = engine.mcp_apps_list(None).await.unwrap();
    let server = apps["data"][0]["serverId"].as_str().unwrap().to_owned();
    let generation = apps["data"][0]["generation"].as_u64().unwrap();
    let thread = engine
        .create_configured(
            "owner".into(),
            ThreadStart {
                prepare_task_directory: None,
                creation_admission: None,
                request_id: "start".into(),
                cwd: Some(workspace.path().to_string_lossy().into_owned()),
                options: None,
                admission_guard: None,
                agent_profile: None,
                model: None,
                parameters: Default::default(),
                dynamic_tools: vec![],
            },
            Arc::new(NoTools),
        )
        .await
        .unwrap();
    let app = engine
        .mcp_app_open(
            "owner".into(),
            None,
            thread.id.clone(),
            server,
            generation,
            "app".into(),
            None,
            "open".into(),
            None,
            None,
        )
        .await
        .unwrap();
    let instance = app["instanceId"].as_str().unwrap().to_owned();
    AppFixture {
        _workspace: workspace,
        data,
        engine,
        model,
        thread: thread.id,
        instance,
        generation,
    }
}

async fn complete(engine: &Arc<Engine>, thread: &str, input: &str) {
    engine
        .start(thread, vec![Input::text(input)])
        .await
        .unwrap();
    let completed = tokio::time::timeout(Duration::from_secs(5), engine.wait(thread))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        completed.turns.last().unwrap().status,
        TurnStatus::Completed
    );
}

async fn update_context(fixture: &AppFixture, content: Vec<Value>) {
    fixture.engine.mcp_app_request(
        "owner".into(), fixture.thread.clone(), fixture.instance.clone(), fixture.generation,
        json!({"jsonrpc":"2.0","id":1,"method":"ui/update-model-context","params":{"content":content}}),
        None,
    ).await.unwrap();
}

#[tokio::test]
async fn real_app_updates_append_data_and_preserve_cross_turn_model_prefixes() {
    let fixture = app_fixture(Limits::default()).await;
    let AppFixture {
        engine,
        model,
        thread,
        instance,
        generation,
        ..
    } = &fixture;
    for (index, selected) in [
        "prefix-selection-A",
        "prefix-selection-A",
        "prefix-selection-B",
        "prefix-selection-A",
    ]
    .into_iter()
    .enumerate()
    {
        engine.mcp_app_request("owner".into(),thread.clone(),instance.clone(),*generation,
            json!({"jsonrpc":"2.0","id":index,"method":"ui/update-model-context","params":{"content":[{"type":"text","text":selected,"_meta":{"secret":true}}]}}),None).await.unwrap();
        engine
            .start(thread, vec![Input::text(format!("ack-app-{index}"))])
            .await
            .unwrap();
        let completed = tokio::time::timeout(Duration::from_secs(5), engine.wait(thread))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            completed.turns.last().unwrap().status,
            TurnStatus::Completed
        );
    }
    {
        let requests = model.0.lock().unwrap();
        assert_eq!(requests.len(), 4);
        let frames = |messages: &Vec<Message>| {
            messages
                .iter()
                .filter(|m| {
                    m.role == "areal_context"
                        && m.text_content()
                            .contains("Active App reference data snapshot")
                })
                .count()
        };
        assert_eq!(
            requests.iter().map(frames).collect::<Vec<_>>(),
            vec![1, 1, 2, 3]
        );
        for pair in requests.windows(2) {
            assert_eq!(
                &pair[1][..pair[0].len()],
                pair[0].as_slice(),
                "a changed App must append data after the entire previous request"
            );
        }
        for messages in &*requests {
            assert!(
                !messages
                    .iter()
                    .filter(|m| m.role == "system")
                    .any(|m| m.text_content().contains("prefix-selection-"))
            );
            assert!(
                !messages
                    .iter()
                    .any(|m| m.text_content().contains("\"secret\"")),
                "App _meta is not model context"
            );
        }
    }
    engine.shutdown().await;
}

#[tokio::test]
async fn clearing_app_before_manual_compaction_sends_current_empty_context() {
    cleared_app_after_manual_compaction(false, Restart::None).await;
}

#[tokio::test]
async fn closing_app_before_manual_compaction_sends_empty_snapshot() {
    cleared_app_after_manual_compaction(true, Restart::None).await;
}

#[tokio::test]
async fn closed_app_stays_empty_after_restart_and_manual_compaction() {
    cleared_app_after_manual_compaction(true, Restart::AfterCompaction).await;
}

#[tokio::test]
async fn closed_app_stays_empty_when_restarted_before_compaction() {
    cleared_app_after_manual_compaction(true, Restart::BeforeCompaction).await;
}

#[tokio::test]
async fn legacy_compacted_app_history_restores_empty_snapshot_and_persists_migration() {
    cleared_app_after_manual_compaction(true, Restart::LegacyCheckpoint).await;
}

enum Restart {
    None,
    BeforeCompaction,
    AfterCompaction,
    LegacyCheckpoint,
}

async fn cleared_app_after_manual_compaction(close: bool, restart: Restart) {
    let fixture = app_fixture(Limits::default()).await;
    update_context(
        &fixture,
        vec![
            json!({"type":"text","text":format!("prefix-selection-stale {}", "x".repeat(16_000))}),
        ],
    )
    .await;
    complete(&fixture.engine, &fixture.thread, "ack-app-before-clear").await;
    complete(
        &fixture.engine,
        &fixture.thread,
        "ack-app-before-compaction",
    )
    .await;
    if close {
        fixture
            .engine
            .mcp_app_close(
                "owner".into(),
                fixture.thread.clone(),
                fixture.instance.clone(),
                fixture.generation,
            )
            .await
            .unwrap();
    } else {
        update_context(&fixture, vec![]).await;
    }
    let AppFixture {
        engine,
        data,
        model,
        thread,
        _workspace,
        ..
    } = fixture;
    let engine = if matches!(restart, Restart::BeforeCompaction) {
        engine.shutdown().await;
        drop(engine);
        Engine::open(data.path(), model.clone(), Limits::default()).unwrap()
    } else {
        engine
    };
    engine.context_compact(thread.clone()).await.unwrap();
    let legacy = matches!(restart, Restart::LegacyCheckpoint);
    let record_path = data.path().join(format!("{thread}.json"));
    let engine = if matches!(
        restart,
        Restart::AfterCompaction | Restart::LegacyCheckpoint
    ) {
        engine.shutdown().await;
        drop(engine);
        if legacy {
            let mut record: Value =
                serde_json::from_slice(&fs::read(&record_path).unwrap()).unwrap();
            record["thread"]["contextCheckpoint"]
                .as_object_mut()
                .unwrap()
                .remove("appReferenceSeen");
            fs::write(&record_path, serde_json::to_vec(&record).unwrap()).unwrap();
        }
        Engine::open(data.path(), model.clone(), Limits::default()).unwrap()
    } else {
        engine
    };
    complete(&engine, &thread, "ack-app-after-clear").await;
    assert_cleared_compacted_request(&model, close);
    complete(&engine, &thread, "ack-app-after-empty-snapshot").await;
    assert_cleared_compacted_request(&model, close);
    if legacy {
        let record: Value = serde_json::from_slice(&fs::read(&record_path).unwrap()).unwrap();
        assert_eq!(
            record["thread"]["contextCheckpoint"]["appReferenceSeen"], true,
            "legacy App history migration must persist its resolved checkpoint metadata"
        );
    }
    engine.shutdown().await;
}

#[tokio::test]
async fn closing_app_before_automatic_compaction_sends_empty_snapshot() {
    let fixture = app_fixture(Limits {
        context_window_bytes: 8_000,
        ..Limits::default()
    })
    .await;
    update_context(
        &fixture,
        vec![
            json!({"type":"text","text":format!("prefix-selection-stale {}", "x".repeat(16_000))}),
        ],
    )
    .await;
    complete(&fixture.engine, &fixture.thread, "ack-app-before-clear").await;
    assert!(fixture.model.1.lock().unwrap().is_empty());
    fixture
        .engine
        .mcp_app_close(
            "owner".into(),
            fixture.thread.clone(),
            fixture.instance.clone(),
            fixture.generation,
        )
        .await
        .unwrap();
    complete(&fixture.engine, &fixture.thread, "ack-app-after-clear").await;
    assert_cleared_compacted_request(&fixture.model, true);
    fixture.engine.shutdown().await;
}

fn assert_cleared_compacted_request(model: &Capture, closed: bool) {
    let summaries = model.1.lock().unwrap();
    assert!(
        !summaries.is_empty(),
        "the real compaction path must call the summary model"
    );
    assert!(
        summaries
            .iter()
            .flatten()
            .any(|message| message.text_content().contains("prefix-selection-stale")),
        "the summary must consume the old App selection"
    );
    let requests = model.0.lock().unwrap();
    let request = requests.last().unwrap();
    assert!(
        request.iter().any(|message| message
            .text_content()
            .contains("The App previously selected prefix-selection-stale")),
        "the final model request must contain the summary mentioning the old App data"
    );
    let snapshots: Vec<_> = request
        .iter()
        .filter(|message| message.role == "areal_context")
        .filter_map(|message| {
            message
                .text_content()
                .split_once("later snapshots supersede earlier ones): ")
                .map(|(_, value)| value.to_owned())
        })
        .collect();
    assert_eq!(
        snapshots.len(),
        1,
        "after compaction the current App snapshot must supersede the old selection"
    );
    let current: Value = serde_json::from_str(&snapshots[0]).unwrap();
    if closed {
        assert_eq!(
            current,
            json!([]),
            "closed Apps must produce an explicit empty snapshot"
        );
    } else {
        assert_eq!(current.as_array().unwrap().len(), 1);
        assert_eq!(current[0]["context"], json!({"content":[]}));
    }
}

#[tokio::test]
async fn conversation_without_apps_does_not_send_empty_app_snapshot() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let model = Arc::new(Capture::default());
    let engine = Engine::open(data.path(), model.clone(), Limits::default()).unwrap();
    let thread = engine
        .create(workspace.path().to_string_lossy().into_owned())
        .await
        .unwrap();
    complete(&engine, &thread.id, "ack-app-no-app-history").await;
    complete(&engine, &thread.id, "ack-app-before-compaction").await;
    engine.context_compact(thread.id.clone()).await.unwrap();
    complete(&engine, &thread.id, "ack-app-never-opened").await;
    assert!(
        !model.1.lock().unwrap().is_empty(),
        "the no-App control must actually compact"
    );
    assert!(
        !model
            .0
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .iter()
            .any(|message| message.role == "areal_context"
                && message
                    .text_content()
                    .contains("Active App reference data snapshot"))
    );
    engine.shutdown().await;
}
