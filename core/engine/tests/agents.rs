use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelEvent, ModelStream, ToolCall},
};
use areal_protocol::{Input, Item, ToolOutcome, TurnStatus};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Semaphore, mpsc};

fn call(name: &str, args: Value) -> ModelEvent {
    ModelEvent::ToolCall(ToolCall {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.into(),
        arguments: args.to_string(),
    })
}

fn stream(events: Vec<ModelEvent>) -> ModelStream {
    Box::pin(futures_util::stream::iter(events.into_iter().map(Ok)))
}

struct Delegating {
    calls: mpsc::UnboundedSender<String>,
    release: Arc<Semaphore>,
    wait_tool: bool,
}

#[async_trait]
impl Model for Delegating {
    fn name(&self) -> &str {
        "delegation-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<ModelStream> {
        let prompt = messages
            .iter()
            .find(|m| m.role == "user")
            .unwrap()
            .text_content();
        self.calls.send(prompt.clone()).unwrap();
        if prompt == "child" {
            // Depth 1 is a leaf even though the root can delegate by default.
            assert!(!tools.iter().any(|t| t["function"]["name"] == "agent_spawn"));
            self.release.acquire().await.unwrap().forget();
            return Ok(stream(vec![ModelEvent::text("child-result")]));
        }
        if messages
            .iter()
            .any(|m| m.role == "user" && m.text_content() == "updated task")
        {
            self.calls.send("observed-steering".into()).unwrap();
        }
        assert!(tools.iter().any(|t| t["function"]["name"] == "agent_spawn"));
        assert!(
            !tools
                .iter()
                .any(|t| t["function"]["name"] == "workgroup_start")
        );
        let results: Vec<_> = messages.iter().filter(|m| m.role == "tool").collect();
        if results.is_empty() {
            return Ok(stream(vec![
                call(
                    "agent_spawn",
                    json!({"prompt":"child","intent":"inspect","delivery":"report"}),
                ),
                call(
                    "agent_spawn",
                    json!({"prompt":"child","intent":"inspect","delivery":"report"}),
                ),
            ]));
        }
        if self.wait_tool && results.len() == 2 {
            let first: Value = serde_json::from_str(&results[0].text_content())?;
            return Ok(stream(vec![call(
                "agent_wait",
                json!({"executionId":first["executionId"],"timeoutMs":60000}),
            )]));
        }
        let summarized = messages
            .iter()
            .any(|m| m.text_content().starts_with("Settled child Agent results"));
        // 两个终态都已通过工具提供时，模型可直接综合；不能要求重复的自动汇总才算完成。
        let observed: std::collections::BTreeSet<String> = results
            .iter()
            .filter_map(|message| {
                let value: Value = serde_json::from_str(&message.text_content()).ok()?;
                if value["settled"] != true
                    || value["resourcesReleased"] != true
                    || value["status"] != "completed"
                    || value["text"] != "child-result"
                {
                    return None;
                }
                value["executionId"]
                    .as_str()
                    .or_else(|| value["threadId"].as_str())
                    .map(str::to_owned)
            })
            .collect();
        if summarized {
            assert!(
                messages
                    .iter()
                    .any(|m| m.text_content().contains("child-result"))
            );
        }
        Ok(stream(vec![ModelEvent::text(
            if summarized || observed.len() == 2 {
                "integrated"
            } else {
                "parent-ready"
            },
        )]))
    }
}

async fn bounded<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), future)
        .await
        .expect("task deadlocked")
}

#[tokio::test]
async fn default_tools_spawn_join_and_summarize_with_a_single_shared_model_permit() {
    for wait_tool in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let (calls, _received) = mpsc::unbounded_channel();
        let model = Arc::new(Delegating {
            calls,
            release: Arc::new(Semaphore::new(2)),
            wait_tool,
        });
        let pool = areal_engine::workgroup::native::SharedModel::pool(model, 1).unwrap();
        let engine = Engine::open(
            root.path(),
            pool,
            Limits {
                model_concurrency: 1,
                max_agent_depth: 1,
                ..Limits::default()
            },
        )
        .unwrap();
        let parent = engine.create("/workspace".into()).await.unwrap();
        engine
            .start(&parent.id, vec![Input::text("parent")])
            .await
            .unwrap();
        let parent = bounded(engine.wait(&parent.id)).await.unwrap();
        assert_eq!(
            parent.turns[0].status,
            TurnStatus::Completed,
            "{:?}",
            parent.turns[0].error
        );
        assert!(
            matches!(parent.turns[0].items.last().unwrap(), Item::AgentMessage{text,..} if text == "integrated")
        );
        let children = engine.list(None, 10, Some(&parent.id)).await.unwrap().0;
        assert_eq!(children.len(), 2);
        for child in children {
            let saved = engine.read(&child.id, true).await.unwrap();
            assert_eq!(saved.turns[0].status, TurnStatus::Completed);
            assert_eq!(saved.session_id, parent.session_id);
            assert_eq!(saved.cwd, parent.cwd);
        }
        for item in &parent.turns[0].items {
            if let Item::DynamicToolCall {
                execution, success, ..
            } = item
            {
                assert_eq!(*success, Some(true));
                assert_eq!(execution.outcome, ToolOutcome::Succeeded);
                assert_eq!(execution.backend.as_deref(), Some("coordination"));
                assert!(execution.scope_id.is_empty());
            }
        }
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn cancellation_during_child_join_cancels_and_settles_the_owned_tree() {
    let root = tempfile::tempdir().unwrap();
    let (calls, mut received) = mpsc::unbounded_channel();
    let engine = Engine::open(
        root.path(),
        Arc::new(Delegating {
            calls,
            release: Arc::new(Semaphore::new(0)),
            wait_tool: false,
        }),
        Limits {
            max_agent_depth: 1,
            ..Limits::default()
        },
    )
    .unwrap();
    let parent = engine.create("/workspace".into()).await.unwrap();
    let turn = engine
        .start(&parent.id, vec![Input::text("parent")])
        .await
        .unwrap();
    let mut children_started = 0;
    while children_started < 2 {
        if bounded(received.recv()).await.unwrap() == "child" {
            children_started += 1;
        }
    }
    engine.interrupt(&parent.id, &turn.id).await.unwrap();
    assert_eq!(
        bounded(engine.wait(&parent.id)).await.unwrap().turns[0].status,
        TurnStatus::Interrupted
    );
    for child in engine.list(None, 10, Some(&parent.id)).await.unwrap().0 {
        assert_eq!(
            engine.read(&child.id, true).await.unwrap().turns[0].status,
            TurnStatus::Interrupted
        );
    }
    engine.shutdown().await;
}

#[tokio::test]
async fn parent_steering_interrupts_auto_join_without_cancelling_children() {
    let root = tempfile::tempdir().unwrap();
    let (calls, mut received) = mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(0));
    let engine = Engine::open(
        root.path(),
        Arc::new(Delegating {
            calls,
            release: release.clone(),
            wait_tool: false,
        }),
        Limits {
            max_agent_depth: 1,
            ..Limits::default()
        },
    )
    .unwrap();
    let parent = engine.create("/workspace".into()).await.unwrap();
    let turn = engine
        .start(&parent.id, vec![Input::text("parent")])
        .await
        .unwrap();
    let mut child_calls = 0;
    let mut parent_calls = 0;
    while child_calls < 2 || parent_calls < 2 {
        match bounded(received.recv()).await.unwrap().as_str() {
            "child" => child_calls += 1,
            "parent" => parent_calls += 1,
            _ => unreachable!(),
        }
    }
    engine
        .steer(&parent.id, &turn.id, vec![Input::text("updated task")])
        .await
        .unwrap();
    while bounded(received.recv()).await.unwrap() != "observed-steering" {}
    for child in engine.list(None, 10, Some(&parent.id)).await.unwrap().0 {
        assert_eq!(
            engine.read(&child.id, true).await.unwrap().turns[0].status,
            TurnStatus::InProgress
        );
    }
    release.add_permits(2);
    assert_eq!(
        bounded(engine.wait(&parent.id)).await.unwrap().turns[0].status,
        TurnStatus::Completed
    );
    engine.shutdown().await;
}

struct Disabled;
#[async_trait]
impl Model for Disabled {
    fn name(&self) -> &str {
        "disabled"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<ModelStream> {
        assert!(!tools.iter().any(|t| {
            t["function"]["name"]
                .as_str()
                .unwrap()
                .starts_with("agent_")
        }));
        if messages.iter().any(|m| m.role == "tool") {
            assert!(
                messages
                    .last()
                    .unwrap()
                    .text_content()
                    .contains("unknown tool")
            );
            Ok(stream(vec![ModelEvent::text("single")]))
        } else {
            // A hallucinated call must fail execution too, not only be hidden.
            Ok(stream(vec![call(
                "agent_spawn",
                json!({"prompt":"child","intent":"inspect","delivery":"report"}),
            )]))
        }
    }
}

#[tokio::test]
async fn explicit_zero_limits_disable_delegation() {
    for limits in [
        Limits {
            max_children_per_turn: 0,
            ..Limits::default()
        },
        Limits {
            max_agent_depth: 0,
            ..Limits::default()
        },
    ] {
        let root = tempfile::tempdir().unwrap();
        // Keep a registered dynamic tool so the deliberately invalid call can
        // be journaled and corrected rather than failing the model protocol.
        struct Host;
        #[async_trait]
        impl areal_engine::tools::DynamicToolHost for Host {
            fn id(&self) -> &str {
                "host"
            }
            fn is_closed(&self) -> bool {
                false
            }
            async fn call(
                &self,
                _: Value,
                _: tokio_util::sync::CancellationToken,
            ) -> anyhow::Result<areal_protocol::DynamicToolResponse> {
                unreachable!()
            }
        }
        let engine = Engine::open(root.path(), Arc::new(Disabled), limits).unwrap();
        let parent = engine
            .create_with_tools(
                "/workspace".into(),
                vec![areal_protocol::ToolDefinition {
                    name: "fixture".into(),
                    description: "fixture".into(),
                    input_schema: json!({"type":"object"}),
                    output_schema: None,
                }],
                Arc::new(Host),
            )
            .await
            .unwrap();
        engine
            .start(&parent.id, vec![Input::text("single")])
            .await
            .unwrap();
        let result = bounded(engine.wait(&parent.id)).await.unwrap();
        assert_eq!(
            result.turns[0].status,
            TurnStatus::Completed,
            "{:?}",
            result.turns[0].error
        );
        assert!(
            engine
                .list(None, 10, Some(&parent.id))
                .await
                .unwrap()
                .0
                .is_empty()
        );
        engine.shutdown().await;
    }
}

struct UnevenChildren {
    events: mpsc::UnboundedSender<String>,
    fast: Semaphore,
    slow: Semaphore,
    explicit_wait: bool,
}

#[async_trait]
impl Model for UnevenChildren {
    fn name(&self) -> &str {
        "uneven-children"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, _: Vec<Value>) -> anyhow::Result<ModelStream> {
        let prompt = messages
            .iter()
            .find(|m| m.role == "user")
            .unwrap()
            .text_content();
        if prompt != "parent" {
            self.events.send(prompt.clone()).unwrap();
            let gate = if prompt == "fast" {
                &self.fast
            } else {
                &self.slow
            };
            gate.acquire().await.unwrap().forget();
            return Ok(stream(vec![ModelEvent::text(format!("{prompt}-result"))]));
        }
        let results: Vec<_> = messages.iter().filter(|m| m.role == "tool").collect();
        if results.is_empty() {
            return Ok(stream(vec![
                call(
                    "agent_spawn",
                    json!({"prompt":"slow","intent":"inspect","delivery":"report"}),
                ),
                call(
                    "agent_spawn",
                    json!({"prompt":"fast","intent":"inspect","delivery":"report"}),
                ),
            ]));
        }
        if self.explicit_wait && results.len() == 2 {
            let ids: Vec<Value> = results
                .iter()
                .map(|m| {
                    serde_json::from_str::<Value>(&m.text_content()).unwrap()["executionId"].clone()
                })
                .collect();
            return Ok(stream(vec![call(
                "agent_wait_any",
                json!({"executionIds":ids,"timeoutMs":60000}),
            )]));
        }
        let has_fast = messages
            .iter()
            .any(|m| m.text_content().contains("fast-result"));
        let has_slow = messages
            .iter()
            .any(|m| m.text_content().contains("slow-result"));
        self.events
            .send(
                if has_fast && !has_slow {
                    "consumed-fast"
                } else {
                    "parent-progress"
                }
                .into(),
            )
            .unwrap();
        Ok(stream(vec![ModelEvent::text(if has_fast && has_slow {
            "integrated-both"
        } else {
            "waiting-for-results"
        })]))
    }
}

#[tokio::test]
async fn fast_results_reach_parent_while_earlier_child_is_still_running() {
    for explicit_wait in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (events, mut received) = mpsc::unbounded_channel();
        let model = Arc::new(UnevenChildren {
            events,
            fast: Semaphore::new(0),
            slow: Semaphore::new(0),
            explicit_wait,
        });
        let engine = Engine::open(
            dir.path(),
            model.clone(),
            Limits {
                model_concurrency: 3,
                max_agent_depth: 1,
                ..Limits::default()
            },
        )
        .unwrap();
        let root = engine.create("/workspace".into()).await.unwrap();
        engine
            .start(&root.id, vec![Input::text("parent")])
            .await
            .unwrap();
        let mut started = std::collections::HashSet::new();
        while started.len() < 2 {
            let event = bounded(received.recv()).await.unwrap();
            if matches!(event.as_str(), "fast" | "slow") {
                started.insert(event);
            }
        }
        // 两个模型调用都已进入并等待各自信号；不依赖机器速度或 sleep 推断重叠。
        model.fast.add_permits(1);
        while bounded(received.recv()).await.unwrap() != "consumed-fast" {}
        let children = engine.list(None, 10, Some(&root.id)).await.unwrap().0;
        let slow = children.iter().find(|c| c.preview == "slow").unwrap();
        assert_eq!(
            engine.read(&slow.id, true).await.unwrap().turns[0].status,
            TurnStatus::InProgress
        );
        model.slow.add_permits(1);
        let done = bounded(engine.wait(&root.id)).await.unwrap();
        assert_eq!(
            done.turns[0].status,
            TurnStatus::Completed,
            "{:?}",
            done.turns[0].error
        );
        assert!(
            matches!(done.turns[0].items.last().unwrap(), Item::AgentMessage{text,..} if text == "integrated-both")
        );
        engine.shutdown().await;
    }
}

struct ReportingChild {
    fail: bool,
}

#[async_trait]
impl Model for ReportingChild {
    fn name(&self) -> &str {
        "reporting-child"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<ModelStream> {
        let prompt = messages
            .iter()
            .find(|m| m.role == "user")
            .unwrap()
            .text_content();
        let results: Vec<_> = messages.iter().filter(|m| m.role == "tool").collect();
        if prompt == "child" {
            if results.is_empty() {
                assert!(
                    tools
                        .iter()
                        .any(|t| t["function"]["name"] == "agent_report")
                );
                assert!(
                    !tools
                        .iter()
                        .any(|t| t["function"]["name"] == "agent_spawn_configured")
                );
                return Ok(stream(vec![call(
                    "agent_report",
                    json!({"summary":"confirmed finding","evidence":["src/example.rs:10"],"remaining":["integration test"]}),
                )]));
            }
            assert!(results[0].text_content().contains("recorded"));
            if self.fail {
                return Ok(Box::pin(futures_util::stream::iter(vec![
                    Ok(ModelEvent::text("\n \n")),
                    Err(anyhow::anyhow!("fixture stream failure")),
                ])));
            }
            assert!(
                tools.is_empty(),
                "last round must be reserved for a handoff"
            );
            assert!(
                messages
                    .iter()
                    .any(|m| m.text_content().contains("final allowed round"))
            );
            return Ok(stream(vec![ModelEvent::text("verified final handoff")]));
        }
        if results.is_empty() {
            return Ok(stream(vec![call(
                "agent_spawn",
                json!({"prompt":"child","intent":"inspect","delivery":"report","maxModelRounds":if self.fail {4} else {2}}),
            )]));
        }
        if results.len() == 1 {
            let child: Value = serde_json::from_str(&results[0].text_content())?;
            return Ok(stream(vec![call(
                "agent_wait",
                json!({"executionId":child["executionId"],"timeoutMs":60000}),
            )]));
        }
        let report: Value = serde_json::from_str(&results[1].text_content())?;
        if self.fail {
            assert_eq!(report["status"], "failed");
            assert_eq!(report["source"], "checkpoint");
            assert_eq!(report["partial"], true);
            assert!(
                report["text"]
                    .as_str()
                    .unwrap()
                    .starts_with("{\"summary\":")
            );
            assert!(
                report["text"]
                    .as_str()
                    .unwrap()
                    .contains("confirmed finding")
            );
            assert!(
                report["text"]
                    .as_str()
                    .unwrap()
                    .contains("src/example.rs:10")
            );
        } else {
            assert!(tools.is_empty());
            let handoff = messages
                .iter()
                .find(|m| m.text_content().starts_with("Settled child Agent results"))
                .expect("parent receives child results before its final round")
                .text_content();
            assert!(handoff.contains("Tools are unavailable"));
            assert!(!handoff.contains("agent_read"));
            assert_eq!(report["status"], "completed");
            assert_eq!(report["source"], "message");
            assert_eq!(report["partial"], false);
            assert_eq!(report["text"], "verified final handoff");
        }
        Ok(stream(vec![ModelEvent::text("parent inspected handoff")]))
    }
}

#[tokio::test]
async fn failed_child_keeps_durable_checkpoint_and_bounded_child_gets_final_round() {
    for fail in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(
            dir.path(),
            Arc::new(ReportingChild { fail }),
            Limits {
                model_concurrency: 1,
                max_agent_depth: 1,
                ..Limits::default()
            },
        )
        .unwrap();
        let root = engine.create("/workspace".into()).await.unwrap();
        if !fail {
            engine
                .configure_thread(
                    serde_json::from_value(json!({
                        "threadId":root.id,"expectedRevision":1,"options":{"maxModelRounds":3}
                    }))
                    .unwrap(),
                )
                .await
                .unwrap();
        }
        engine
            .start(&root.id, vec![Input::text("parent")])
            .await
            .unwrap();
        let done = bounded(engine.wait(&root.id)).await.unwrap();
        assert_eq!(
            done.turns[0].status,
            TurnStatus::Completed,
            "{:?}",
            done.turns[0].error
        );
        let child = engine
            .list(None, 10, Some(&root.id))
            .await
            .unwrap()
            .0
            .remove(0);
        let saved = engine.read(&child.id, true).await.unwrap();
        let model_rounds = saved.turns[0]
            .items
            .iter()
            .filter(|i| matches!(i, Item::AgentMessage { .. }))
            .count();
        assert_eq!(model_rounds, 2);
        engine.shutdown().await;
        drop(engine);
        let reopened = Engine::open(dir.path(), Arc::new(Disabled), Limits::default()).unwrap();
        let recovered = reopened.read(&child.id, true).await.unwrap();
        assert_eq!(
            serde_json::to_value(&saved).unwrap(),
            serde_json::to_value(&recovered).unwrap()
        );
        reopened.shutdown().await;
    }
}

struct IgnoresRoundLimit;
#[async_trait]
impl Model for IgnoresRoundLimit {
    fn name(&self) -> &str {
        "ignores-round-limit"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, _: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<ModelStream> {
        assert!(tools.is_empty());
        Ok(stream(vec![call(
            "agent_spawn",
            json!({"prompt":"must not start","intent":"inspect","delivery":"report"}),
        )]))
    }
}

#[tokio::test]
async fn final_round_rejects_new_work_as_budget_exhaustion_without_spawning() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(IgnoresRoundLimit), Limits::default()).unwrap();
    let root = engine.create("/workspace".into()).await.unwrap();
    engine
        .configure_thread(
            serde_json::from_value(json!({
                "threadId":root.id,"expectedRevision":1,"options":{"maxModelRounds":1}
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    engine
        .start(&root.id, vec![Input::text("parent")])
        .await
        .unwrap();
    let done = bounded(engine.wait(&root.id)).await.unwrap();
    assert_eq!(done.turns[0].status, TurnStatus::Failed);
    let outcome = done.turns[0]
        .error
        .as_ref()
        .unwrap()
        .outcome
        .as_ref()
        .unwrap();
    assert_eq!(outcome.code, "AGENT_MAX_TURNS_EXCEEDED");
    assert_eq!(outcome.details.as_ref().unwrap()["modelRounds"], 1);
    assert!(
        done.turns[0]
            .error
            .as_ref()
            .unwrap()
            .message
            .contains("MAX_MODEL_ROUNDS")
    );
    assert!(
        !done.turns[0]
            .items
            .iter()
            .any(|item| matches!(item, Item::DynamicToolCall { .. }))
    );
    assert!(
        engine
            .list(None, 10, Some(&root.id))
            .await
            .unwrap()
            .0
            .is_empty()
    );
    engine.shutdown().await;
}

struct ShadowedCoordination(&'static str);

#[async_trait]
impl Model for ShadowedCoordination {
    fn name(&self) -> &str {
        "shadowed-coordination"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<ModelStream> {
        assert!(!tools.iter().any(|t| t["function"]["name"] == self.0));
        if let Some(result) = messages.iter().find(|m| m.role == "tool") {
            assert!(
                result
                    .text_content()
                    .contains("read-only turns cannot invoke")
            );
            Ok(stream(vec![ModelEvent::text("external tool denied")]))
        } else {
            // 模拟模型仍请求被过滤的工具，执行端也必须拒绝，不能只靠声明隐藏。
            Ok(stream(vec![call(self.0, json!({}))]))
        }
    }
}

struct RecordingHost(AtomicBool);

#[async_trait]
impl areal_engine::tools::DynamicToolHost for RecordingHost {
    fn id(&self) -> &str {
        "recording-host"
    }
    fn is_closed(&self) -> bool {
        false
    }
    async fn call(
        &self,
        _: Value,
        _: tokio_util::sync::CancellationToken,
    ) -> anyhow::Result<areal_protocol::DynamicToolResponse> {
        self.0.store(true, Ordering::SeqCst);
        anyhow::bail!("external host must not be invoked")
    }
}

#[tokio::test]
async fn read_only_coordination_exception_does_not_authorize_same_named_external_tools() {
    for name in ["agent_read", "agent_wait", "agent_wait_any", "agent_report"] {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(
            dir.path(),
            Arc::new(ShadowedCoordination(name)),
            Limits {
                max_children_per_turn: 0,
                ..Limits::default()
            },
        )
        .unwrap();
        let host = Arc::new(RecordingHost(AtomicBool::new(false)));
        let root = engine
            .create_with_tools(
                "/workspace".into(),
                vec![areal_protocol::ToolDefinition {
                    name: name.into(),
                    description: "external tool with a coordination name".into(),
                    input_schema: json!({"type":"object"}),
                    output_schema: None,
                }],
                host.clone(),
            )
            .await
            .unwrap();
        engine
            .configure_thread(
                serde_json::from_value(json!({
                    "threadId":root.id,"expectedRevision":1,"options":{"readOnly":true}
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        engine
            .start(&root.id, vec![Input::text("read-only task")])
            .await
            .unwrap();
        let done = bounded(engine.wait(&root.id)).await.unwrap();
        assert_eq!(
            done.turns[0].status,
            TurnStatus::Completed,
            "{:?}",
            done.turns[0].error
        );
        assert!(!host.0.load(Ordering::SeqCst));
        assert!(done.turns[0].items.iter().any(|item| matches!(item,
            Item::DynamicToolCall { tool, success: Some(false), execution, .. }
                if tool == name && execution.outcome == ToolOutcome::Failed
        )));
        engine.shutdown().await;
    }
}

struct MeteredSteering {
    child_started: Arc<Semaphore>,
    sent: AtomicBool,
    before_headers: bool,
    delay: Duration,
    activity_count: usize,
    feedback_processed: Arc<Semaphore>,
}
#[async_trait]
impl Model for MeteredSteering {
    fn name(&self) -> &str {
        "metered-steering"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, _: Vec<Value>) -> anyhow::Result<ModelStream> {
        use futures_util::StreamExt;
        let prompt = messages
            .iter()
            .find(|m| m.role == "user")
            .unwrap()
            .text_content();
        let usage = |input_tokens| {
            ModelEvent::Usage(areal_protocol::ModelUsage {
                input_tokens,
                output_tokens: 1,
                cached_input_tokens: 0,
            })
        };
        if prompt == "metered-child" {
            if messages
                .iter()
                .any(|m| m.role == "user" && m.text_content() == "corrected scope")
            {
                return Ok(stream(vec![ModelEvent::text("corrected-child"), usage(7)]));
            }
            self.child_started.add_permits(1);
            let tail = vec![
                call(
                    "agent_report",
                    json!({"status":"working","summary":"stale-report-must-not-execute"}),
                ),
                usage(37),
            ];
            if self.before_headers {
                tokio::time::sleep(self.delay).await;
                return Ok(stream(tail));
            }
            let delay = self.delay;
            let activity_count = self.activity_count;
            let activity = futures_util::stream::unfold(0, move |count| async move {
                if count >= activity_count {
                    return None;
                }
                tokio::time::sleep(delay).await;
                Some((Ok(ModelEvent::Activity), count + 1))
            });
            return Ok(Box::pin(
                stream(vec![ModelEvent::text("unfinished response")])
                    .chain(activity)
                    .chain(
                        futures_util::stream::once(async move {
                            tokio::time::sleep(delay).await;
                            stream(tail)
                        })
                        .flatten(),
                    ),
            ));
        }
        let results: Vec<_> = messages.iter().filter(|m| m.role == "tool").collect();
        if results.is_empty() {
            return Ok(stream(vec![
                call("agent_spawn", json!({"prompt":"metered-child"})),
                usage(5),
            ]));
        }
        if !self.sent.swap(true, Ordering::SeqCst) {
            self.child_started.acquire().await.unwrap().forget();
            let child: Value = serde_json::from_str(&results[0].text_content())?;
            return Ok(stream(vec![
                call(
                    "agent_send_input",
                    json!({"threadId":child["threadId"],"prompt":"corrected scope"}),
                ),
                usage(5),
            ]));
        }
        self.feedback_processed.add_permits(1);
        Ok(stream(vec![ModelEvent::text("integrated"), usage(5)]))
    }
}
#[tokio::test]
async fn child_feedback_settles_delayed_usage_before_and_after_headers_without_stale_tools() {
    for before_headers in [false, true] {
        let data = tempfile::tempdir().unwrap();
        let model = Arc::new(MeteredSteering {
            child_started: Arc::new(Semaphore::new(0)),
            sent: AtomicBool::new(false),
            before_headers,
            delay: Duration::from_millis(1300),
            activity_count: 0,
            feedback_processed: Arc::new(Semaphore::new(0)),
        });
        let engine = Engine::open(
            data.path(),
            areal_engine::workgroup::native::SharedModel::pool(model, 4).unwrap(),
            Limits {
                model_concurrency: 4,
                ..Limits::default()
            },
        )
        .unwrap();
        let parent = engine.create("/workspace".into()).await.unwrap();
        engine
            .goal_create("fixture".into(), serde_json::from_value(json!({"requestId":"metered-feedback", "threadId":parent.id, "expectedRevision":0, "objective":"parent"})).unwrap())
            .await
            .unwrap();
        let parent = bounded(engine.wait(&parent.id)).await.unwrap();
        assert_eq!(
            parent.turns[0].status,
            TurnStatus::Completed,
            "{:?}",
            parent.turns[0].error
        );
        let children = engine.list(None, 10, Some(&parent.id)).await.unwrap().0;
        assert_eq!(children.len(), 1);
        let child = engine.read(&children[0].id, true).await.unwrap();
        assert_eq!(
            child.turns[0].status,
            TurnStatus::Completed,
            "{:?}",
            child.turns[0].error
        );
        assert_eq!(child.turns[0].usage.as_ref().unwrap().input_tokens, 44);
        assert!(
            child.turns[0]
                .items
                .iter()
                .any(|i| matches!(i,Item::AgentMessage{text,..} if text=="corrected-child"))
        );
        assert!(
            !child.turns[0]
                .items
                .iter()
                .any(|i| matches!(i,Item::DynamicToolCall{tool,..} if tool=="agent_report"))
        );
        let goal = engine.goal_get(&parent.id).await.unwrap();
        assert_eq!(goal["goal"]["usage"]["unknownRequests"], 0, "{goal}");
        assert_eq!(goal["goal"]["usage"]["accountingComplete"], true, "{goal}");
        engine.shutdown().await;
    }
}

// 虚拟时间覆盖真实长流；保持同一 Goal、真实计量包装与原生协作工具路径。
async fn long_child_feedback(
    before_headers: bool,
    delay_seconds: u64,
    activity_count: usize,
    idle_seconds: u64,
    stop: &str,
) {
    let data = tempfile::tempdir().unwrap();
    let feedback_processed = Arc::new(Semaphore::new(0));
    let model = Arc::new(MeteredSteering {
        child_started: Arc::new(Semaphore::new(0)),
        sent: AtomicBool::new(false),
        before_headers,
        delay: Duration::from_secs(delay_seconds),
        activity_count,
        feedback_processed: feedback_processed.clone(),
    });
    let engine = Engine::open(
        data.path(),
        areal_engine::workgroup::native::SharedModel::pool(model, 4).unwrap(),
        Limits {
            model_concurrency: 4,
            stream_idle_timeout: Duration::from_secs(idle_seconds),
            ..Limits::default()
        },
    )
    .unwrap();
    let root = engine.create("/workspace".into()).await.unwrap();
    engine
        .goal_create(
            "fixture".into(),
            serde_json::from_value(json!({
                "requestId":"long-feedback", "threadId":root.id,
                "expectedRevision":0, "objective":"parent",
                "maxActiveSeconds":if stop == "budget" {120} else {1200}
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    feedback_processed.acquire().await.unwrap().forget();
    let feedback_at = tokio::time::Instant::now();
    if stop == "cancel" {
        let active = engine.read(&root.id, true).await.unwrap();
        engine
            .interrupt(&root.id, &active.turns[0].id)
            .await
            .unwrap();
    }
    let done = engine.wait(&root.id).await.unwrap();
    let children = engine.list(None, 10, Some(&root.id)).await.unwrap().0;
    assert_eq!(children.len(), 1);
    let child = engine.read(&children[0].id, true).await.unwrap();
    assert!(
        !child.turns[0]
            .items
            .iter()
            .any(|i| matches!(i, Item::DynamicToolCall { tool, .. } if tool == "agent_report")),
        "stale tools must never execute"
    );
    let goal = engine.goal_get(&root.id).await.unwrap();
    let journal: Value = serde_json::from_slice(
        &std::fs::read(
            data.path()
                .join("goals")
                .join(format!("{}.json", goal["goal"]["id"].as_str().unwrap())),
        )
        .unwrap(),
    )
    .unwrap();
    for field in ["inputTokens", "outputTokens", "cachedInputTokens"] {
        let known_sum: u64 = journal["requests"]
            .as_object()
            .unwrap()
            .values()
            .filter_map(|request| request["usage"][field].as_u64())
            .sum();
        assert_eq!(
            goal["goal"]["usage"][field], known_sum,
            "{field} counted more than once"
        );
    }
    if stop == "complete" {
        assert_eq!(
            done.turns[0].status,
            TurnStatus::Completed,
            "{:?}",
            done.turns[0].error
        );
        assert_eq!(
            child.turns[0].status,
            TurnStatus::Completed,
            "{:?}",
            child.turns[0].error
        );
        assert_eq!(child.turns[0].usage.as_ref().unwrap().input_tokens, 44);
        assert!(
            child.turns[0]
                .items
                .iter()
                .any(|i| matches!(i, Item::AgentMessage { text, .. } if text == "corrected-child"))
        );
        assert_eq!(goal["goal"]["usage"]["unknownRequests"], 0, "{goal}");
        assert_eq!(goal["goal"]["usage"]["accountingComplete"], true, "{goal}");
    } else {
        assert_ne!(done.turns[0].status, TurnStatus::Completed);
        assert!(
            goal["goal"]["usage"]["unknownRequests"].as_u64().unwrap() > 0,
            "{goal}"
        );
        assert_eq!(goal["goal"]["usage"]["accountingComplete"], false, "{goal}");
        assert!(
            !child.turns[0]
                .items
                .iter()
                .any(|i| matches!(i, Item::AgentMessage { text, .. } if text == "corrected-child"))
        );
        if stop == "cancel" {
            assert_eq!(done.turns[0].status, TurnStatus::Interrupted);
            assert!(
                feedback_at.elapsed() <= Duration::from_secs(2),
                "cancel took {:?}",
                feedback_at.elapsed()
            );
        }
        if stop == "budget" {
            assert!(goal["goal"]["usage"]["timeUsedSeconds"].as_f64().unwrap() >= 120.0);
            assert!(
                goal["goal"]["usage"]["timeUsedSeconds"].as_f64().unwrap() <= 121.0,
                "{goal}"
            );
            assert_eq!(goal["goal"]["maxActiveSeconds"], 120);
        }
    }
    engine.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn child_feedback_waits_for_headers_beyond_180_seconds() {
    long_child_feedback(true, 240, 0, 600, "complete").await;
}

#[tokio::test(start_paused = true)]
async fn child_feedback_activity_refreshes_idle_deadline_beyond_180_seconds() {
    long_child_feedback(false, 60, 4, 90, "complete").await;
}

#[tokio::test(start_paused = true)]
async fn child_feedback_real_idle_preserves_unknown_before_and_after_headers() {
    for before_headers in [true, false] {
        long_child_feedback(before_headers, 240, 0, 90, "idle").await;
    }
}

#[tokio::test(start_paused = true)]
async fn child_feedback_explicit_cancel_preserves_unknown_before_and_after_headers() {
    for before_headers in [true, false] {
        long_child_feedback(before_headers, 30, 1000, 90, "cancel").await;
    }
}

#[tokio::test(start_paused = true)]
async fn child_feedback_original_goal_deadline_ends_active_drain() {
    long_child_feedback(false, 30, 1000, 90, "budget").await;
}
