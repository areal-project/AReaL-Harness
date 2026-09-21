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
                call("agent_spawn", json!({"prompt":"child"})),
                call("agent_spawn", json!({"prompt":"child"})),
            ]));
        }
        if self.wait_tool && results.len() == 2 {
            let first: Value = serde_json::from_str(&results[0].text_content())?;
            return Ok(stream(vec![call(
                "agent_wait",
                json!({"threadId":first["threadId"],"timeoutMs":60000}),
            )]));
        }
        let summarized = messages
            .iter()
            .any(|m| m.text_content().starts_with("Settled child Agent results"));
        if summarized {
            assert!(
                messages
                    .iter()
                    .any(|m| m.text_content().contains("child-result"))
            );
        }
        Ok(stream(vec![ModelEvent::text(if summarized {
            "integrated"
        } else {
            "parent-ready"
        })]))
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
            Ok(stream(vec![call("agent_spawn", json!({"prompt":"child"}))]))
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
                call("agent_spawn", json!({"prompt":"slow"})),
                call("agent_spawn", json!({"prompt":"fast"})),
            ]));
        }
        if self.explicit_wait && results.len() == 2 {
            let ids: Vec<Value> = results
                .iter()
                .map(|m| {
                    serde_json::from_str::<Value>(&m.text_content()).unwrap()["threadId"].clone()
                })
                .collect();
            return Ok(stream(vec![call(
                "agent_wait_any",
                json!({"threadIds":ids,"timeoutMs":60000}),
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
                json!({"prompt":"child","maxModelRounds":if self.fail {4} else {2}}),
            )]));
        }
        if results.len() == 1 {
            let child: Value = serde_json::from_str(&results[0].text_content())?;
            return Ok(stream(vec![call(
                "agent_wait",
                json!({"threadId":child["threadId"],"timeoutMs":60000}),
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
            json!({"prompt":"must not start"}),
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
