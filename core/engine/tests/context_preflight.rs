use areal_engine::{
    Engine, Limits,
    model::{AgentStream, Message, Model, ModelEvent, ModelStream, RequestPurpose, ToolCall},
    tools::DynamicToolHost,
};
use areal_protocol::{
    DynamicToolResponse, Input, Item, ModelUsage, Thread, ToolContent, ToolDefinition, TurnStatus,
};
use async_trait::async_trait;
use futures_util::stream;
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;

const PROMPT: &str = "Inspect the record, preserve the exact API and report verified evidence.";

fn text_tokens(text: &str) -> usize {
    text.bytes().filter(u8::is_ascii).count().div_ceil(3)
        + text.chars().filter(|c| !c.is_ascii()).count() * 2
}

fn request_tokens(messages: &[Message], tools: &[Value]) -> usize {
    messages
        .iter()
        .map(|m| {
            text_tokens(&m.text_content())
                + 16
                + m.tool_calls
                    .iter()
                    .map(|c| text_tokens(&c.to_string()))
                    .sum::<usize>()
                + m.provider_context
                    .as_ref()
                    .map_or(0, |c| text_tokens(&c.to_string()))
        })
        .sum::<usize>()
        + text_tokens(&serde_json::to_string(tools).unwrap())
        + 512
}

struct PreflightModel {
    requests: Mutex<Vec<(RequestPurpose, Vec<Message>)>>,
    payload_bytes: AtomicUsize,
    input_limit: usize,
    summary_gate: Option<(Notify, Notify)>,
}

#[async_trait]
impl Model for PreflightModel {
    fn name(&self) -> &str {
        "preflight-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat_for(
        &self,
        messages: Vec<Message>,
        tools: Vec<Value>,
        purpose: RequestPurpose,
    ) -> anyhow::Result<AgentStream> {
        let first = self.requests.lock().unwrap().is_empty();
        let estimate = request_tokens(&messages, &tools);
        assert!(
            estimate <= self.input_limit,
            "must never send the overflowing request"
        );
        if first {
            // 使追加调用后的原始估算超限，但按上一请求真实用量校准的预检仍能通过。
            // 不触发字节保护，必须走完整请求的强制恢复入口。
            assert!(estimate + 2048 < self.input_limit);
            let payload_bytes = (self.input_limit - estimate + 128) * 3;
            assert!(
                payload_bytes < 64000,
                "fixture must respect the tool argument limit"
            );
            self.payload_bytes.store(payload_bytes, Ordering::SeqCst);
        }
        self.requests.lock().unwrap().push((purpose, messages));
        let event = if purpose == RequestPurpose::Summary {
            assert!(tools.is_empty());
            if let Some((started, release)) = &self.summary_gate {
                started.notify_one();
                release.notified().await;
            }
            ModelEvent::text(
                "Observed the tool result. Continue without replaying the completed operation.",
            )
        } else if first {
            ModelEvent::ToolCall(ToolCall {
                id: "completed-operation".into(),
                name: "read_record".into(),
                arguments: json!({"payload":"x".repeat(self.payload_bytes.load(Ordering::SeqCst))})
                    .to_string(),
            })
        } else {
            // 自定义模型的默认适配器用空工具列表表达最终轮禁用。
            assert!(tools.is_empty());
            ModelEvent::text("Verified the requested record.")
        };
        Ok(Box::pin(stream::iter([
            Ok(event),
            Ok(ModelEvent::Usage(ModelUsage {
                input_tokens: 1,
                output_tokens: 1,
                cached_input_tokens: 0,
            })),
        ])))
    }
}

#[derive(Default)]
struct RecordHost {
    calls: AtomicUsize,
}
#[async_trait]
impl DynamicToolHost for RecordHost {
    fn id(&self) -> &str {
        "record-fixture"
    }
    fn is_closed(&self) -> bool {
        false
    }
    async fn call(
        &self,
        request: Value,
        _: tokio_util::sync::CancellationToken,
    ) -> anyhow::Result<DynamicToolResponse> {
        assert!(!request["arguments"]["payload"].as_str().unwrap().is_empty());
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(DynamicToolResponse {
            raw_mcp_result: None,
            success: true,
            structured_content: None,
            content_items: vec![ToolContent::InputText {
                text: "record observed successfully".into(),
            }],
        })
    }
}

fn limits() -> Limits {
    Limits {
        context_window_tokens: 26000,
        context_output_reserve_tokens: 2000,
        context_window_bytes: 0,
        ..Limits::default()
    }
}

async fn fixture(
    limits: Limits,
    hold_summary: bool,
) -> (
    tempfile::TempDir,
    Arc<Engine>,
    Arc<PreflightModel>,
    Arc<RecordHost>,
    Thread,
) {
    let data = tempfile::tempdir().unwrap();
    let model = Arc::new(PreflightModel {
        requests: Mutex::new(vec![]),
        payload_bytes: AtomicUsize::new(0),
        input_limit: limits.context_window_tokens - limits.context_output_reserve_tokens,
        summary_gate: hold_summary.then(|| (Notify::new(), Notify::new())),
    });
    let host = Arc::new(RecordHost::default());
    let engine = Engine::open(data.path(), model.clone(), limits).unwrap();
    let thread = engine.create_with_tools("/workspace".into(), vec![ToolDefinition {
        name: "read_record".into(), description: "Read a record once".into(),
        input_schema: json!({"type":"object","properties":{"payload":{"type":"string"}},"required":["payload"]}), output_schema: None,
    }], host.clone()).await.unwrap();
    engine
        .configure_thread(
            serde_json::from_value(
                json!({"threadId":thread.id,"expectedRevision":1,"options":{"maxModelRounds":2}}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    (data, engine, model, host, thread)
}

async fn wait(engine: &Arc<Engine>, thread: &Thread) -> Thread {
    tokio::time::timeout(Duration::from_secs(10), engine.wait(&thread.id))
        .await
        .unwrap()
        .unwrap()
}

fn request_context_count(thread: &Thread) -> usize {
    thread.turns.iter().flat_map(|t| &t.items).filter(|i| matches!(i, Item::ModelContext { value, .. } if value["type"] == "areal_request_context")).count()
}

#[tokio::test]
async fn full_request_preflight_compacts_completed_tail_without_replaying_tools() {
    let (data, engine, model, host, thread) = fixture(limits(), false).await;
    engine
        .start(&thread.id, vec![Input::text(PROMPT)])
        .await
        .unwrap();
    let done = wait(&engine, &thread).await;
    assert_eq!(
        done.turns.last().unwrap().status,
        TurnStatus::Completed,
        "{:?}",
        done.turns.last().unwrap().error
    );
    assert_eq!(host.calls.load(Ordering::SeqCst), 1);
    assert_eq!(done.context_checkpoint.as_ref().unwrap().compactions, 1);
    assert_eq!(
        request_context_count(&done),
        2,
        "only the two accepted solve requests may persist context"
    );
    {
        let requests = model.requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .filter(|(p, _)| *p == RequestPurpose::Summary)
                .count(),
            1
        );
        assert_eq!(
            requests
                .iter()
                .filter(|(p, _)| *p == RequestPurpose::Solve)
                .count(),
            2
        );
        let resumed = &requests.last().unwrap().1;
        assert!(
            resumed
                .iter()
                .any(|m| m.role == "user" && m.text_content() == PROMPT)
        );
        assert!(
            resumed
                .iter()
                .any(|m| m.text_content().contains("Observed the tool result"))
        );
        assert!(!resumed.iter().any(|m| m.role == "tool"));
    }
    let original = done
        .turns
        .iter()
        .flat_map(|t| &t.items)
        .find(|i| matches!(i, Item::DynamicToolCall { .. }))
        .unwrap();
    let original = serde_json::to_value(original).unwrap();
    assert_eq!(
        original["arguments"]["payload"].as_str().unwrap().len(),
        model.payload_bytes.load(Ordering::SeqCst)
    );
    engine.shutdown().await;
    drop(engine);
    let restored = Engine::open(data.path(), model, limits()).unwrap();
    let history = restored.read(&thread.id, true).await.unwrap();
    let record = history
        .turns
        .iter()
        .flat_map(|t| &t.items)
        .find(|i| matches!(i, Item::DynamicToolCall { .. }))
        .unwrap();
    assert_eq!(serde_json::to_value(record).unwrap(), original);
    restored.shutdown().await;
}

#[tokio::test]
async fn late_preflight_respects_manual_and_disabled_modes_without_phantom_context() {
    for enabled in [true, false] {
        let (_data, engine, model, host, thread) = fixture(
            Limits {
                context_compaction_enabled: enabled,
                context_auto_compaction: false,
                ..limits()
            },
            false,
        )
        .await;
        engine
            .start(&thread.id, vec![Input::text(PROMPT)])
            .await
            .unwrap();
        let done = wait(&engine, &thread).await;
        assert_eq!(done.turns.last().unwrap().status, TurnStatus::Failed);
        let outcome = done
            .turns
            .last()
            .unwrap()
            .error
            .as_ref()
            .unwrap()
            .outcome
            .as_ref()
            .unwrap();
        assert_eq!(outcome.code, "LLM_CONTEXT_WINDOW_EXCEEDED");
        assert_eq!(outcome.source, "core_context_budget");
        assert!(done.context_checkpoint.is_none());
        assert_eq!(model.requests.lock().unwrap().len(), 1);
        assert_eq!(host.calls.load(Ordering::SeqCst), 1);
        assert_eq!(request_context_count(&done), 1);
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn irreducible_input_fails_without_sending_or_silently_dropping_constraints() {
    let (_data, engine, model, host, thread) = fixture(limits(), false).await;
    let prompt = "Preserve this exact constraint. ".repeat(3000);
    engine
        .start(&thread.id, vec![Input::text(&prompt)])
        .await
        .unwrap();
    let done = wait(&engine, &thread).await;
    assert_eq!(done.turns.last().unwrap().status, TurnStatus::Failed);
    assert_eq!(
        done.turns
            .last()
            .unwrap()
            .error
            .as_ref()
            .unwrap()
            .outcome
            .as_ref()
            .unwrap()
            .code,
        "LLM_CONTEXT_WINDOW_EXCEEDED"
    );
    assert!(done.context_checkpoint.is_none());
    assert!(model.requests.lock().unwrap().is_empty());
    assert_eq!(host.calls.load(Ordering::SeqCst), 0);
    assert_eq!(request_context_count(&done), 0);
    let original = done
        .turns
        .iter()
        .flat_map(|t| &t.items)
        .find_map(|i| match i {
            Item::UserMessage { content, .. } => Some(serde_json::to_value(content).unwrap()),
            _ => None,
        })
        .unwrap();
    assert_eq!(original[0]["text"], prompt);
    engine.shutdown().await;
}

#[tokio::test]
async fn user_steer_during_late_preflight_compaction_survives_the_rebuilt_request() {
    let (_data, engine, model, host, thread) = fixture(limits(), true).await;
    let active = engine
        .start(&thread.id, vec![Input::text(PROMPT)])
        .await
        .unwrap();
    let (started, release) = model.summary_gate.as_ref().unwrap();
    tokio::time::timeout(Duration::from_secs(10), started.notified())
        .await
        .unwrap();
    let revision =
        "Latest correction: preserve the already accepted change; only report remaining work.";
    engine
        .steer(&thread.id, &active.id, vec![Input::text(revision)])
        .await
        .unwrap();
    release.notify_one();
    let done = wait(&engine, &thread).await;
    assert_eq!(
        done.turns.last().unwrap().status,
        TurnStatus::Completed,
        "{:?}",
        done.turns.last().unwrap().error
    );
    assert_eq!(host.calls.load(Ordering::SeqCst), 1);
    assert_eq!(request_context_count(&done), 2);
    {
        let requests = model.requests.lock().unwrap();
        let resumed = &requests.last().unwrap().1;
        assert!(
            resumed
                .iter()
                .any(|m| m.role == "user" && m.text_content() == revision)
        );
        assert_eq!(requests.len(), 3);
    }
    let items = &done.turns.last().unwrap().items;
    let revision_index = items.iter().position(|i| matches!(i, Item::UserMessage { content, .. } if serde_json::to_string(content).unwrap().contains(revision))).unwrap();
    let final_context = items.iter().rposition(|i| matches!(i, Item::ModelContext { value, .. } if value["type"] == "areal_request_context")).unwrap();
    assert!(revision_index < final_context);
    engine.shutdown().await;
}

struct RecoveryCompaction {
    recovery_requests: AtomicUsize,
    summaries: AtomicUsize,
}

#[async_trait]
impl Model for RecoveryCompaction {
    fn name(&self) -> &str {
        "recovery-compaction-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat_for(
        &self,
        messages: Vec<Message>,
        _: Vec<Value>,
        purpose: RequestPurpose,
    ) -> anyhow::Result<AgentStream> {
        let event = if purpose == RequestPurpose::Summary {
            self.summaries.fetch_add(1, Ordering::SeqCst);
            ModelEvent::text("Previous reference inspection completed; no operation needs replay.")
        } else if !messages
            .iter()
            .any(|m| m.text_content() == "finish-recovery")
        {
            ModelEvent::text("Previously verified reference evidence. ".repeat(300))
        } else if self.recovery_requests.fetch_add(1, Ordering::SeqCst) == 0 {
            // 仍在窗口内的真实用量接近上限，下一次恢复请求需要压缩旧的已完成 Turn。
            return Ok(Box::pin(stream::iter([Ok(ModelEvent::Usage(
                ModelUsage {
                    input_tokens: 23900,
                    output_tokens: 0,
                    cached_input_tokens: 0,
                },
            ))])));
        } else {
            assert!(self.summaries.load(Ordering::SeqCst) > 0);
            assert!(
                messages.iter().any(|m| {
                    m.role == "user"
                        && m.text_content()
                            .contains("Your last response contained no visible answer")
                }),
                "rebuilding after compaction must preserve the unconsumed recovery hint"
            );
            ModelEvent::text("Verified recovery without repeating work.")
        };
        Ok(Box::pin(stream::iter([
            Ok(event),
            Ok(ModelEvent::Usage(ModelUsage {
                input_tokens: 100,
                output_tokens: 1,
                cached_input_tokens: 0,
            })),
        ])))
    }
}

#[tokio::test]
async fn recovery_hint_survives_request_rebuild_after_compaction() {
    let data = tempfile::tempdir().unwrap();
    let model = Arc::new(RecoveryCompaction {
        recovery_requests: AtomicUsize::new(0),
        summaries: AtomicUsize::new(0),
    });
    let engine = Engine::open(
        data.path(),
        model.clone(),
        Limits {
            max_empty_completion_retries: 1,
            ..limits()
        },
    )
    .unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    engine
        .start(&thread.id, vec![Input::text("seed-history")])
        .await
        .unwrap();
    assert_eq!(
        wait(&engine, &thread).await.turns[0].status,
        TurnStatus::Completed
    );
    engine
        .start(&thread.id, vec![Input::text("finish-recovery")])
        .await
        .unwrap();
    let done = wait(&engine, &thread).await;
    engine.shutdown().await;
    assert_eq!(
        done.turns.last().unwrap().status,
        TurnStatus::Completed,
        "{:?}",
        done.turns.last().unwrap().error
    );
    assert_eq!(model.recovery_requests.load(Ordering::SeqCst), 2);
    assert_eq!(model.summaries.load(Ordering::SeqCst), 1);
    assert!(
        done.turns
            .last()
            .unwrap()
            .usage
            .as_ref()
            .unwrap()
            .input_tokens
            >= 24100
    );
}
