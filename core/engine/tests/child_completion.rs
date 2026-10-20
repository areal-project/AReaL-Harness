use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelEvent, ModelFailure, ModelStream, RequestPurpose, ToolCall},
};
use areal_protocol::{AgentMessagePhase, Input, Item, TurnStatus};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Semaphore, mpsc};

fn response(events: Vec<ModelEvent>) -> ModelStream {
    Box::pin(futures_util::stream::iter(events.into_iter().map(Ok)))
}

fn call(name: &str, arguments: Value) -> ModelEvent {
    ModelEvent::ToolCall(ToolCall {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.into(),
        arguments: arguments.to_string(),
    })
}

async fn bounded<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(10), future)
        .await
        .expect("child completion fixture deadlocked")
}

struct ObservedResult {
    execution_id: bool,
    read_tool: &'static str,
    fail_child: bool,
    compact: bool,
    interrupt_child: bool,
    recovery: Recovery,
    child_text: String,
    fanout: usize,
    parent_calls: AtomicUsize,
    summary_calls: AtomicUsize,
    summary_contexts: AtomicUsize,
    ready: mpsc::UnboundedSender<()>,
    release: Semaphore,
}

#[derive(Clone, Copy, Default, PartialEq)]
enum Recovery {
    #[default]
    None,
    Empty,
    Truncated,
    Reread,
    Steered,
}

struct ObservedOptions {
    execution_id: bool,
    read_tool: &'static str,
    fail_child: bool,
    compact: bool,
    interrupt_child: bool,
    recovery: Recovery,
    child_text: String,
    fanout: usize,
    final_round: bool,
}

impl Default for ObservedOptions {
    fn default() -> Self {
        Self {
            execution_id: true,
            read_tool: "agent_wait",
            fail_child: false,
            compact: false,
            interrupt_child: false,
            recovery: Recovery::None,
            child_text: "verified child finding".into(),
            fanout: 1,
            final_round: false,
        }
    }
}

impl ObservedResult {
    fn read_request(&self, messages: &[Message]) -> ModelEvent {
        let spawned: Vec<Value> = messages
            .iter()
            .filter(|m| m.role == "tool")
            .take(self.fanout)
            .map(|m| serde_json::from_str(&m.text_content()).unwrap())
            .collect();
        let key = if self.execution_id {
            "executionId"
        } else {
            "threadId"
        };
        assert_eq!(spawned.len(), self.fanout);
        assert!(spawned.iter().all(|v| v[key].is_string()));
        let args = if self.read_tool == "agent_wait_any" {
            json!({format!("{key}s"):spawned.iter().map(|v|v[key].clone()).collect::<Vec<_>>(),"timeoutMs":0})
        } else if self.read_tool == "agent_read" {
            json!({key:spawned[0][key],"offset":0})
        } else {
            json!({key:spawned[0][key],"timeoutMs":0})
        };
        call(self.read_tool, args)
    }

    fn final_answer(&self) -> ModelStream {
        response(vec![ModelEvent::text(
            if self.fail_child || self.interrupt_child {
                "The child did not complete; its work is incomplete."
            } else {
                "Completed using the observed child finding."
            },
        )])
    }
}

#[async_trait]
impl Model for ObservedResult {
    fn name(&self) -> &str {
        "observed-child-result"
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
        if purpose == RequestPurpose::Summary {
            self.summary_calls.fetch_add(1, Ordering::SeqCst);
            return Ok(response(vec![ModelEvent::text(
                "The parent has observed the child's completed finding. Continue the remaining plan inspection.",
            )]));
        }
        self.chat(messages, tools).await
    }

    async fn chat(&self, messages: Vec<Message>, _: Vec<Value>) -> anyhow::Result<ModelStream> {
        let prompt = messages
            .iter()
            .find(|m| m.role == "user")
            .unwrap()
            .text_content();
        if prompt == "child" {
            if self.interrupt_child {
                return Ok(Box::pin(futures_util::stream::pending()));
            }
            if self.fail_child {
                anyhow::bail!("fixture child failed; no work was completed");
            }
            return Ok(response(vec![ModelEvent::text(self.child_text.clone())]));
        }
        self.summary_contexts.fetch_add(
            messages
                .iter()
                .filter(|m| m.text_content().starts_with("Settled child Agent results"))
                .count(),
            Ordering::SeqCst,
        );
        match self.parent_calls.fetch_add(1, Ordering::SeqCst) {
            0 => {
                let args = if self.execution_id {
                    json!({"prompt":"child","intent":"inspect","delivery":"report"})
                } else {
                    json!({"prompt":"child"})
                };
                Ok(response(
                    (0..self.fanout)
                        .map(|_| call("agent_spawn", args.clone()))
                        .collect(),
                ))
            }
            1 => {
                self.ready.send(()).unwrap();
                self.release.acquire().await.unwrap().forget();
                Ok(response(vec![self.read_request(&messages)]))
            }
            2 => {
                let receipt = messages
                    .iter()
                    .rev()
                    .find(|m| m.role == "tool")
                    .unwrap()
                    .text_content();
                assert!(
                    receipt.contains(if self.interrupt_child {
                        if self.execution_id {
                            "cancelled"
                        } else {
                            "interrupted"
                        }
                    } else if self.fail_child {
                        "fixture child failed"
                    } else {
                        "verified child finding"
                    }),
                    "{receipt}"
                );
                match self.recovery {
                    Recovery::Empty => return Ok(response(Vec::new())),
                    Recovery::Truncated => {
                        return Ok(Box::pin(futures_util::stream::iter([
                            Ok(ModelEvent::text("discard this incomplete parent answer")),
                            Ok(call("plan_read", json!({}))),
                            Err(ModelFailure::Truncated.into()),
                        ])));
                    }
                    Recovery::Reread => {
                        return Ok(response(vec![self.read_request(&messages)]));
                    }
                    Recovery::Steered => {
                        self.ready.send(()).unwrap();
                        return Ok(Box::pin(futures_util::stream::pending()));
                    }
                    Recovery::None => {}
                }
                if self.compact {
                    return Ok(response(vec![
                        ModelEvent::text("recorded inspection details ".repeat(900)),
                        call("plan_read", json!({})),
                    ]));
                }
                Ok(self.final_answer())
            }
            3 if self.recovery != Recovery::None => {
                assert!(!messages.iter().any(|m| {
                    m.text_content()
                        .contains("discard this incomplete parent answer")
                }));
                if self.recovery == Recovery::Steered {
                    assert!(messages.iter().any(|m| m.role == "user"
                        && m.text_content() == "Use the observed evidence and finish."));
                }
                Ok(self.final_answer())
            }
            3 | 4 if self.compact => Ok(response(vec![
                ModelEvent::text("recorded inspection details ".repeat(900)),
                call("plan_read", json!({})),
            ])),
            5 if self.compact => Ok(response(vec![ModelEvent::text(
                "Completed using the observed child finding.",
            )])),
            // 多余请求故意返回空响应，验证正常答案不会被无意义续轮变成失败。
            _ => Ok(response(Vec::new())),
        }
    }
}

async fn observed_result(execution_id: bool, read_tool: &'static str, fail_child: bool) {
    observed_result_with_compaction(execution_id, read_tool, fail_child, false).await;
}

async fn observed_result_with_compaction(
    execution_id: bool,
    read_tool: &'static str,
    fail_child: bool,
    compact: bool,
) {
    observed_result_case(ObservedOptions {
        execution_id,
        read_tool,
        fail_child,
        compact,
        ..ObservedOptions::default()
    })
    .await;
}

async fn observed_result_case(options: ObservedOptions) {
    let ObservedOptions {
        execution_id,
        read_tool,
        fail_child,
        compact,
        interrupt_child,
        recovery,
        child_text,
        fanout,
        final_round,
    } = options;
    let dir = tempfile::tempdir().unwrap();
    let (ready, mut receiver) = mpsc::unbounded_channel();
    let model = Arc::new(ObservedResult {
        execution_id,
        read_tool,
        fail_child,
        compact,
        interrupt_child,
        recovery,
        child_text,
        fanout,
        parent_calls: AtomicUsize::new(0),
        summary_calls: AtomicUsize::new(0),
        summary_contexts: AtomicUsize::new(0),
        ready,
        release: Semaphore::new(0),
    });
    let engine = Engine::open(
        dir.path(),
        model.clone(),
        Limits {
            watchdog_disable: true,
            context_window_bytes: if compact { 24000 } else { 0 },
            context_recent_bytes: if compact { 512 } else { 0 },
            max_completion_retries: usize::from(recovery == Recovery::Truncated),
            max_empty_completion_retries: usize::from(recovery == Recovery::Empty),
            ..Limits::default()
        },
    )
    .unwrap();
    let parent = engine.create("/workspace".into()).await.unwrap();
    if final_round {
        engine
            .configure_thread(
                serde_json::from_value(json!({
                    "threadId":parent.id,"expectedRevision":1,"options":{"maxModelRounds":3}
                }))
                .unwrap(),
            )
            .await
            .unwrap();
    }
    let parent_turn = engine
        .start(&parent.id, vec![Input::text("parent")])
        .await
        .unwrap();
    bounded(receiver.recv()).await.unwrap();
    let children = engine.list(None, 64, Some(&parent.id)).await.unwrap().0;
    assert_eq!(children.len(), fanout);
    for child in children {
        if interrupt_child {
            let turn = engine.read(&child.id, true).await.unwrap().turns[0]
                .id
                .clone();
            engine.interrupt(&child.id, &turn).await.unwrap();
        }
        let child = bounded(engine.wait(&child.id)).await.unwrap();
        assert_eq!(
            child.turns[0].status,
            if interrupt_child {
                TurnStatus::Interrupted
            } else if fail_child {
                TurnStatus::Failed
            } else {
                TurnStatus::Completed
            }
        );
    }
    model.release.add_permits(1);
    if recovery == Recovery::Steered {
        bounded(receiver.recv()).await.unwrap();
        engine
            .steer(
                &parent.id,
                &parent_turn.id,
                vec![Input::text("Use the observed evidence and finish.")],
            )
            .await
            .unwrap();
    }
    let completed = bounded(engine.wait(&parent.id)).await.unwrap();
    engine.shutdown().await;
    assert_eq!(
        model.parent_calls.load(Ordering::SeqCst),
        if compact {
            6
        } else {
            3 + usize::from(recovery != Recovery::None)
        },
        "already-observed {read_tool} result requested a second final answer"
    );
    assert_eq!(
        completed.turns[0].status,
        TurnStatus::Completed,
        "{:?}",
        completed.turns[0].error
    );
    assert_eq!(
        model.summary_contexts.load(Ordering::SeqCst),
        usize::from(final_round),
        "old child result was injected again"
    );
    assert!(matches!(
        completed.turns[0].items.last(),
        Some(Item::AgentMessage {
            phase: Some(AgentMessagePhase::FinalAnswer),
            ..
        })
    ));
    if compact {
        assert!(completed.context_checkpoint.is_some());
        assert!(model.summary_calls.load(Ordering::SeqCst) > 0);
    }
    assert!(!completed.turns[0].items.iter().any(|item| matches!(
        item, Item::DynamicToolCall { tool, .. } if recovery == Recovery::Truncated && tool == "plan_read"
    )), "discarded response must not execute its tool");
}

#[tokio::test]
async fn real_compaction_does_not_forget_consumed_child_result() {
    observed_result_with_compaction(true, "agent_wait", false, true).await;
}

#[tokio::test]
async fn interrupted_child_results_do_not_request_another_answer() {
    for execution_id in [false, true] {
        for read_tool in ["agent_read", "agent_wait", "agent_wait_any"] {
            observed_result_case(ObservedOptions {
                execution_id,
                read_tool,
                interrupt_child: true,
                ..ObservedOptions::default()
            })
            .await;
        }
    }
}

#[tokio::test]
async fn recovered_response_and_repeated_read_preserve_child_consumption() {
    for execution_id in [false, true] {
        for recovery in [Recovery::Empty, Recovery::Truncated, Recovery::Reread] {
            observed_result_case(ObservedOptions {
                execution_id,
                recovery,
                ..ObservedOptions::default()
            })
            .await;
        }
    }
}

#[tokio::test]
async fn steer_during_completion_consumes_results_only_after_accepted_response() {
    for execution_id in [false, true] {
        observed_result_case(ObservedOptions {
            execution_id,
            recovery: Recovery::Steered,
            ..ObservedOptions::default()
        })
        .await;
    }
}

#[tokio::test]
async fn final_round_keeps_the_original_budget_and_delivers_child_evidence() {
    for execution_id in [false, true] {
        observed_result_case(ObservedOptions {
            execution_id,
            final_round: true,
            ..ObservedOptions::default()
        })
        .await;
    }
}

#[tokio::test]
async fn utf8_escaped_long_results_compare_the_same_initial_page() {
    for execution_id in [false, true] {
        for repetitions in [125, 255, 513] {
            observed_result_case(ObservedOptions {
                execution_id,
                child_text: format!(
                    "verified child finding {}",
                    "中\"\\\u{0001}".repeat(repetitions)
                ),
                ..ObservedOptions::default()
            })
            .await;
        }
    }
}

#[tokio::test]
async fn wait_any_consumes_every_observed_child_in_a_bounded_batch() {
    for execution_id in [false, true] {
        for fanout in [4, 16] {
            observed_result_case(ObservedOptions {
                execution_id,
                read_tool: "agent_wait_any",
                fanout,
                ..ObservedOptions::default()
            })
            .await;
        }
    }
}

macro_rules! observed_cases {
    ($(($name:ident, $execution:expr, $tool:literal, $failed:expr)),+ $(,)?) => {
        $(
            #[tokio::test]
            async fn $name() {
                observed_result($execution, $tool, $failed).await;
            }
        )+
    };
}

observed_cases!(
    (legacy_read_completed, false, "agent_read", false),
    (legacy_wait_completed, false, "agent_wait", false),
    (legacy_wait_any_completed, false, "agent_wait_any", false),
    (execution_read_completed, true, "agent_read", false),
    (execution_wait_completed, true, "agent_wait", false),
    (execution_wait_any_completed, true, "agent_wait_any", false),
    (legacy_read_failed, false, "agent_read", true),
    (legacy_wait_failed, false, "agent_wait", true),
    (legacy_wait_any_failed, false, "agent_wait_any", true),
    (execution_read_failed, true, "agent_read", true),
    (execution_wait_failed, true, "agent_wait", true),
    (execution_wait_any_failed, true, "agent_wait_any", true),
);

#[derive(Clone, Copy, Debug, PartialEq)]
enum Scenario {
    Unread,
    TailPage,
    Timeout,
    LateSibling,
    FollowupTool,
}

struct NewResult {
    scenario: Scenario,
    execution_id: bool,
    parent_calls: AtomicUsize,
    ready: mpsc::UnboundedSender<()>,
    candidate: mpsc::UnboundedSender<()>,
    root_release: Semaphore,
    fast_release: Semaphore,
    child_release: Semaphore,
}

#[async_trait]
impl Model for NewResult {
    fn name(&self) -> &str {
        "new-child-result"
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
            if prompt == "slow" {
                self.child_release.acquire().await.unwrap().forget();
                // 超时后的失败也是新信息，不能被 earlier running 回执消掉。
                if self.scenario == Scenario::Timeout {
                    anyhow::bail!("late child failure");
                }
            } else {
                self.fast_release.acquire().await.unwrap().forget();
            }
            return Ok(response(vec![ModelEvent::text(format!(
                "{prompt} finding {}",
                "evidence ".repeat(400)
            ))]));
        }
        let index = self.parent_calls.fetch_add(1, Ordering::SeqCst);
        if index == 0 {
            let prompts = match self.scenario {
                Scenario::LateSibling => vec!["fast", "slow"],
                Scenario::Timeout => vec!["slow"],
                _ => vec!["fast"],
            };
            return Ok(response(
                prompts
                    .into_iter()
                    .map(|prompt| {
                        call(
                            "agent_spawn",
                            if self.execution_id {
                                json!({"prompt":prompt,"intent":"inspect","delivery":"report"})
                            } else {
                                json!({"prompt":prompt})
                            },
                        )
                    })
                    .collect(),
            ));
        }
        if index == 1 {
            self.ready.send(()).unwrap();
            self.root_release.acquire().await.unwrap().forget();
            if matches!(self.scenario, Scenario::Unread | Scenario::FollowupTool) {
                return Ok(response(vec![ModelEvent::text(
                    "candidate before reading child",
                )]));
            }
            let spawned: Vec<Value> = messages
                .iter()
                .filter(|m| m.role == "tool")
                .map(|m| serde_json::from_str(&m.text_content()).unwrap())
                .collect();
            let key = if self.execution_id {
                "executionId"
            } else {
                "threadId"
            };
            return Ok(response(vec![match self.scenario {
                Scenario::LateSibling => call(
                    "agent_wait_any",
                    json!({format!("{key}s"):spawned.iter().map(|v|v[key].clone()).collect::<Vec<_>>(),"timeoutMs":0}),
                ),
                Scenario::Timeout => call("agent_wait", json!({key:spawned[0][key],"timeoutMs":0})),
                Scenario::TailPage => {
                    call("agent_read", json!({key:spawned[0][key],"offset":1024}))
                }
                _ => unreachable!(),
            }]));
        }
        if index == 2
            && matches!(
                self.scenario,
                Scenario::Timeout | Scenario::LateSibling | Scenario::TailPage
            )
        {
            let receipt = messages
                .iter()
                .rev()
                .find(|m| m.role == "tool")
                .unwrap()
                .text_content();
            if self.scenario == Scenario::Timeout {
                assert!(receipt.contains("\"timedOut\":true"), "{receipt}");
            }
            if self.scenario == Scenario::LateSibling {
                assert!(
                    receipt.contains("fast finding") && !receipt.contains("slow finding"),
                    "{receipt}"
                );
            }
            self.candidate.send(()).unwrap();
            return Ok(response(vec![ModelEvent::text(
                "candidate before all results",
            )]));
        }
        let summaries: Vec<_> = messages
            .iter()
            .filter(|m| m.text_content().starts_with("Settled child Agent results"))
            .collect();
        assert_eq!(
            summaries.len(),
            1,
            "unchanged child summaries must be appended once"
        );
        let summary = summaries[0].text_content();
        match self.scenario {
            Scenario::Timeout => assert!(summary.contains("late child failure"), "{summary}"),
            Scenario::LateSibling => assert!(
                summary.contains("slow finding"),
                "already-read fast child must not trigger a premature follow-up: {summary}"
            ),
            _ => assert!(summary.contains("fast finding"), "{summary}"),
        }
        if self.scenario == Scenario::FollowupTool && index == 2 {
            return Ok(response(vec![call("plan_read", json!({}))]));
        }
        Ok(response(vec![ModelEvent::text(
            "final includes newly delivered child evidence",
        )]))
    }
}

async fn new_result(scenario: Scenario, execution_id: bool) {
    let dir = tempfile::tempdir().unwrap();
    let (ready, mut ready_rx) = mpsc::unbounded_channel();
    let (candidate, mut candidate_rx) = mpsc::unbounded_channel();
    let model = Arc::new(NewResult {
        scenario,
        execution_id,
        parent_calls: AtomicUsize::new(0),
        ready,
        candidate,
        root_release: Semaphore::new(0),
        fast_release: Semaphore::new(0),
        child_release: Semaphore::new(0),
    });
    let engine = Engine::open(
        dir.path(),
        model.clone(),
        Limits {
            watchdog_disable: true,
            ..Limits::default()
        },
    )
    .unwrap();
    let parent = engine.create("/workspace".into()).await.unwrap();
    engine
        .start(&parent.id, vec![Input::text("parent")])
        .await
        .unwrap();
    bounded(ready_rx.recv()).await.unwrap();
    // 先确认 spawn 回执进入父请求，再结束 fast；避免 spawn 本身已经携带完整结果。
    model.fast_release.add_permits(1);
    let children = engine.list(None, 10, Some(&parent.id)).await.unwrap().0;
    for child in &children {
        let thread = engine.read(&child.id, true).await.unwrap();
        let input = serde_json::to_value(&thread.turns[0].items[0]).unwrap();
        if input["content"][0]["text"] == "fast" {
            bounded(engine.wait(&child.id)).await.unwrap();
        }
    }
    model.root_release.add_permits(1);
    if matches!(scenario, Scenario::Timeout | Scenario::LateSibling) {
        bounded(candidate_rx.recv()).await.unwrap();
        model.child_release.add_permits(1);
    }
    let completed = bounded(engine.wait(&parent.id)).await.unwrap();
    for child in &children {
        let child = engine.read(&child.id, true).await.unwrap();
        assert_ne!(
            child.turns[0].status,
            TurnStatus::InProgress,
            "parent finished before child settlement"
        );
    }
    engine.shutdown().await;
    assert_eq!(
        completed.turns[0].status,
        TurnStatus::Completed,
        "{:?}",
        completed.turns[0].error
    );
    let expected = if scenario == Scenario::Unread { 3 } else { 4 };
    assert_eq!(
        model.parent_calls.load(Ordering::SeqCst),
        expected,
        "{scenario:?}"
    );
    assert!(
        matches!(completed.turns[0].items.last(), Some(Item::AgentMessage { text, phase: Some(AgentMessagePhase::FinalAnswer), .. }) if text == "final includes newly delivered child evidence")
    );
}

#[tokio::test]
async fn unread_children_still_require_synthesis() {
    for execution in [false, true] {
        new_result(Scenario::Unread, execution).await;
    }
}

#[tokio::test]
async fn tail_page_does_not_acknowledge_unseen_start() {
    for execution in [false, true] {
        new_result(Scenario::TailPage, execution).await;
    }
}

#[tokio::test]
async fn timed_out_wait_does_not_hide_late_failure() {
    for execution in [false, true] {
        new_result(Scenario::Timeout, execution).await;
    }
}

#[tokio::test]
async fn observed_fast_child_does_not_hide_or_delay_slow_sibling() {
    for execution in [false, true] {
        new_result(Scenario::LateSibling, execution).await;
    }
}

#[tokio::test]
async fn followup_tool_does_not_append_identical_child_context_again() {
    for execution in [false, true] {
        new_result(Scenario::FollowupTool, execution).await;
    }
}
