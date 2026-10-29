use areal_engine::{
    Engine, Limits, SessionCatalog,
    model::{Message, Model, ModelEvent, ModelStream, RequestPurpose, ToolCall},
    tools::DynamicToolHost,
};
use areal_protocol::{DynamicToolResponse, Input, Item, ModelUsage, ToolDefinition, TurnStatus};
use async_trait::async_trait;
use futures_util::stream;
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Notify;

#[derive(Clone, Debug, PartialEq)]
struct RecordedRequest {
    messages: Vec<Message>,
    tools: Vec<Value>,
}

struct RecordingModel(Mutex<Vec<RecordedRequest>>);

#[async_trait]
impl Model for RecordingModel {
    fn name(&self) -> &str {
        "catalog-observation-fixture"
    }

    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }

    async fn chat_for(
        &self,
        messages: Vec<Message>,
        tools: Vec<Value>,
        purpose: RequestPurpose,
    ) -> anyhow::Result<ModelStream> {
        if purpose != RequestPurpose::Solve {
            return Ok(Box::pin(stream::iter([Ok(ModelEvent::text(
                "Fixture title",
            ))])));
        }
        let number = {
            let mut requests = self.0.lock().unwrap();
            requests.push(RecordedRequest {
                messages: messages.clone(),
                tools,
            });
            requests.len()
        };
        let response = if number == 1 {
            ModelEvent::ToolCall(ToolCall {
                id: "catalog-write-once".into(),
                name: "write_once".into(),
                arguments: "{}".into(),
            })
        } else {
            assert!(matches!(number, 2 | 3), "unexpected model replay");
            assert_eq!(
                messages
                    .iter()
                    .filter(|message| message.role == "tool")
                    .count(),
                1
            );
            ModelEvent::text("Written and verified once")
        };
        Ok(Box::pin(stream::iter([
            Ok(response),
            Ok(ModelEvent::Usage(ModelUsage {
                input_tokens: 7,
                output_tokens: 3,
                cached_input_tokens: 0,
            })),
        ])))
    }
}

struct FileWrite {
    path: std::path::PathBuf,
    entered: Notify,
    release: Notify,
    calls: AtomicUsize,
}

#[async_trait]
impl DynamicToolHost for FileWrite {
    fn id(&self) -> &str {
        "catalog-write-host"
    }

    fn is_closed(&self) -> bool {
        false
    }

    async fn call(
        &self,
        _: Value,
        cancel: tokio_util::sync::CancellationToken,
    ) -> anyhow::Result<DynamicToolResponse> {
        assert_eq!(self.calls.fetch_add(1, Ordering::SeqCst), 0);
        self.entered.notify_one();
        tokio::select! {
            _ = cancel.cancelled() => anyhow::bail!("observation unexpectedly cancelled the write"),
            _ = self.release.notified() => {}
        }
        tokio::fs::write(&self.path, "one tool effect").await?;
        Ok(DynamicToolResponse {
            success: true,
            content_items: vec![],
            structured_content: Some(json!({"written":true})),
            raw_mcp_result: None,
        })
    }
}

#[tokio::test]
async fn directory_observations_preserve_model_inputs_tool_execution_and_restart_history() {
    for backend in [
        SessionCatalog::Memory,
        SessionCatalog::Sqlite,
        SessionCatalog::MemoryLazy,
        SessionCatalog::SqliteLazy,
    ] {
        observation_case(backend).await;
    }
}

async fn observation_case(backend: SessionCatalog) {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let model = Arc::new(RecordingModel(Mutex::new(Vec::new())));
    let host = Arc::new(FileWrite {
        path: workspace.path().join("result.txt"),
        entered: Notify::new(),
        release: Notify::new(),
        calls: AtomicUsize::new(0),
    });
    let limits = Limits {
        session_catalog: backend,
        ..Default::default()
    };
    let engine = Engine::open(data.path(), model.clone(), limits.clone()).unwrap();
    let thread = engine
        .create_with_tools(
            workspace.path().to_string_lossy().into_owned(),
            vec![ToolDefinition {
                name: "write_once".into(),
                description: "Fixture file side effect".into(),
                input_schema: json!({"type":"object"}),
                output_schema: None,
            }],
            host.clone(),
        )
        .await
        .unwrap();
    engine
        .start(&thread.id, vec![Input::text("Write one result")])
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), host.entered.notified())
        .await
        .unwrap();
    engine.flush_catalog().await;
    let index_writes = engine.catalog_metrics().await["sqlite"]["rowsWritten"].clone();

    let original = serde_json::to_value(engine.read(&thread.id, true).await.unwrap()).unwrap();
    let path = data.path().join(format!("{}.json", thread.id));
    let original_record = std::fs::read(&path).unwrap();
    let original_requests = model.0.lock().unwrap().clone();
    // 工具仍在真实准入后的等待窗口中；只读目录不能改变输入、回执或执行所有权。
    for _ in 0..32 {
        assert_eq!(engine.list(None, 100, None).await.unwrap().0.len(), 1);
        assert_eq!(
            engine
                .list_by_created(None, 100, |_| true)
                .await
                .unwrap()
                .0
                .len(),
            1
        );
        assert!(
            engine
                .read(&thread.id, false)
                .await
                .unwrap()
                .turns
                .is_empty()
        );
    }
    assert_eq!(
        serde_json::to_value(engine.read(&thread.id, true).await.unwrap()).unwrap(),
        original
    );
    assert_eq!(std::fs::read(&path).unwrap(), original_record);
    assert_eq!(*model.0.lock().unwrap(), original_requests);
    assert_eq!(
        engine.catalog_metrics().await["sqlite"]["rowsWritten"],
        index_writes
    );
    if backend == SessionCatalog::Sqlite {
        assert!(
            engine.catalog_metrics().await["sqlite"]["readHits"]
                .as_u64()
                .unwrap()
                > 0
        );
    }
    assert!(!host.path.exists());

    host.release.notify_one();
    let completed =
        tokio::time::timeout(std::time::Duration::from_secs(5), engine.wait(&thread.id))
            .await
            .unwrap()
            .unwrap();
    assert_eq!(completed.turns[0].status, TurnStatus::Completed);
    assert_eq!(completed.turns[0].usage.as_ref().unwrap().input_tokens, 14);
    assert_eq!(model.0.lock().unwrap().len(), 2);
    assert_eq!(host.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        std::fs::read_to_string(&host.path).unwrap(),
        "one tool effect"
    );
    assert_eq!(
        completed.turns[0]
            .items
            .iter()
            .filter(|item| matches!(item, Item::DynamicToolCall { .. }))
            .count(),
        1
    );
    engine.shutdown().await;
    drop(engine);

    let restored = Engine::open(data.path(), model.clone(), limits).unwrap();
    assert_eq!(
        serde_json::to_value(restored.read(&thread.id, true).await.unwrap().turns).unwrap(),
        serde_json::to_value(completed.turns).unwrap()
    );
    assert_eq!(model.0.lock().unwrap().len(), 2);
    assert_eq!(host.calls.load(Ordering::SeqCst), 1);
    restored
        .bind_tool_host(&thread.id, host.clone())
        .await
        .unwrap();
    restored
        .start(
            &thread.id,
            vec![Input::text("Continue from persisted history")],
        )
        .await
        .unwrap();
    let resumed = restored.wait(&thread.id).await.unwrap();
    assert_eq!(resumed.turns.len(), 2);
    assert_eq!(resumed.turns[1].status, TurnStatus::Completed);
    {
        let requests = model.0.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert_eq!(
            requests[2]
                .messages
                .iter()
                .filter(|m| m.role == "tool")
                .count(),
            1
        );
        assert_eq!(
            requests[2]
                .messages
                .iter()
                .filter(|m| m.role == "user")
                .map(Message::text_content)
                .collect::<Vec<_>>(),
            vec!["Write one result", "Continue from persisted history"]
        );
        assert_eq!(host.calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            std::fs::read_to_string(&host.path).unwrap(),
            "one tool effect"
        );
    }
    restored.shutdown().await;
}
