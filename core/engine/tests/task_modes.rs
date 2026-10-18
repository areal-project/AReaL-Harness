use areal_engine::{
    Engine, Error, Limits,
    model::{Message, Model, ModelEvent, ModelStream, RequestPurpose, ToolCall},
};
use areal_protocol::{ModelUsage, goals::*, tasks::*};
use async_trait::async_trait;
use futures_util::stream;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

struct Fixture {
    calls: AtomicUsize,
    ask: bool,
    headless: bool,
}
fn tool(name: &str, args: Value, n: usize) -> ModelEvent {
    ModelEvent::ToolCall(ToolCall {
        id: format!("call-{n}"),
        name: name.into(),
        arguments: args.to_string(),
    })
}
#[async_trait]
impl Model for Fixture {
    fn name(&self) -> &str {
        "task-mode-fixture"
    }
    async fn stream(&self, m: Vec<Message>) -> anyhow::Result<ModelStream> {
        self.chat(m, vec![]).await
    }
    async fn chat_limited(
        &self,
        m: Vec<Message>,
        t: Vec<Value>,
        _: RequestPurpose,
        _: Option<u64>,
    ) -> anyhow::Result<ModelStream> {
        self.chat(m, t).await
    }
    async fn chat(&self, m: Vec<Message>, _: Vec<Value>) -> anyhow::Result<ModelStream> {
        let n = self.calls.fetch_add(1, Ordering::SeqCst);
        let text = m
            .iter()
            .map(Message::text_content)
            .collect::<Vec<_>>()
            .join("\n");
        let goal: Value = m
            .iter()
            .rev()
            .find_map(|m| {
                m.text_content()
                    .split("Current authoritative goal: ")
                    .nth(1)
                    .and_then(|s| serde_json::from_str(s).ok())
            })
            .unwrap();
        let complete = || {
            tool(
                "goal_update",
                json!({"expectedRevision":goal["revision"],"status":"complete","summary":"verified result","evidence":["fixture assertions passed"],"remaining":[]}),
                n,
            )
        };
        let event = if self.ask {
            if n == 0 {
                tool(
                    "ask_user_question",
                    json!({"questions":[{"id":"choice","title":"Choose the target","options":["A","B"],"allowFreeText":false}],"mode":if self.headless {"wait"}else{"async"},"required":true}),
                    n,
                )
            } else if self.headless {
                if n == 1 {
                    assert!(text.contains("unavailable") && text.contains("headless"));
                    complete()
                } else {
                    ModelEvent::TextDelta("completed without waiting for a user".into())
                }
            } else {
                match n {
                    1 => {
                        assert!(text.contains("questionId"));
                        tool(
                            "plan_update",
                            json!({"expectedRevision":0,"steps":[{"id":"independent","text":"Independent work completed while the question was pending","status":"completed"}]}),
                            n,
                        )
                    }
                    2 => tool("task_wait", json!({}), n),
                    3 => {
                        assert!(text.contains("\"choice\":\"B\""));
                        complete()
                    }
                    _ => ModelEvent::TextDelta("finished after an asynchronous reply".into()),
                }
            }
        } else if n.is_multiple_of(2) {
            complete()
        } else {
            ModelEvent::TextDelta("done".into())
        };
        Ok(Box::pin(stream::iter(vec![
            Ok(event),
            Ok(ModelEvent::Usage(ModelUsage {
                input_tokens: 10,
                cached_input_tokens: 0,
                output_tokens: 5,
            })),
        ])))
    }
}

fn open(ask: bool, headless: bool) -> (tempfile::TempDir, Arc<Engine>, Arc<Fixture>) {
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(Fixture {
        calls: AtomicUsize::new(0),
        ask,
        headless,
    });
    let engine = Engine::open(dir.path(), model.clone(), Limits::default()).unwrap();
    (dir, engine, model)
}
fn create(mode: TaskMode, thread_id: Option<String>) -> TaskCreate {
    TaskCreate {
        request_id: "create".into(),
        mode,
        objective: "Complete the fixture".into(),
        thread_id,
        interaction_mode: None,
        schedule: None,
        token_budget: Some(100000),
        max_turns: Some(8),
        max_active_seconds: Some(60),
    }
}
async fn until(engine: &Engine, id: &str, status: RunStatus) -> Task {
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let task = engine.task_read(id).await.unwrap();
            if task.runs.last().is_some_and(|r| r.status == status) {
                return task;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .ok();
    if let Some(task) = result {
        return task;
    }
    let task = engine.task_read(id).await.unwrap();
    let thread = engine
        .read(task.runs[0].thread_id.as_ref().unwrap(), true)
        .await
        .unwrap();
    panic!(
        "task did not reach {status:?}: {}\n{}",
        json!(task),
        json!(thread)
    )
}

#[tokio::test]
async fn async_question_allows_work_then_releases_turn_and_reply_resumes_same_run() {
    let (_dir, e, m) = open(true, false);
    let accepted = e
        .task_create("owner".into(), create(TaskMode::Background, None))
        .await
        .unwrap();
    let id = accepted["id"].as_str().unwrap();
    let task = until(&e, id, RunStatus::WaitingForInput).await;
    assert_eq!(m.calls.load(Ordering::SeqCst), 3);
    assert_eq!(e.server_status().await["activeTurns"], json!([]));
    let run = &task.runs[0];
    let thread = run.thread_id.as_ref().unwrap();
    assert_eq!(e.plan(thread).await.unwrap().steps[0].status, "completed");
    let mut reply = ChannelReply {
        request_id: "reply".into(),
        task_id: id.into(),
        run_id: run.id.clone(),
        question_id: task.messages[0].id.clone(),
        answers: BTreeMap::from([("choice".into(), "B".into())]),
    };
    reply.run_id = "unrelated-run".into();
    assert!(
        e.channel_reply("owner".into(), reply.clone())
            .await
            .is_err()
    );
    reply.run_id = run.id.clone();
    let result = e
        .channel_reply("owner".into(), reply.clone())
        .await
        .unwrap();
    assert_eq!(
        e.channel_reply("owner".into(), reply.clone())
            .await
            .unwrap(),
        result
    );
    let done = until(&e, id, RunStatus::Completed).await;
    assert_eq!(done.runs.len(), 1);
    assert_eq!(done.runs[0].id, run.id);
    assert_eq!(done.runs[0].usage.turns_started, 2);
    assert!(done.messages.iter().any(|m| m.kind == "report"));
    reply.request_id = "late-reply".into();
    assert!(e.channel_reply("owner".into(), reply).await.is_err());
    let page = e
        .channel_read(ChannelRead {
            task_id: id.into(),
            after_sequence: None,
            limit: Some(1),
        })
        .await
        .unwrap();
    assert_eq!(page["data"].as_array().unwrap().len(), 1);
    assert_eq!(page["hasMore"], true);
    e.shutdown().await;
}

#[tokio::test]
async fn headless_goal_never_waits_for_a_user() {
    let (_dir, e, m) = open(true, true);
    let thread = e.create(e.default_cwd()).await.unwrap();
    let result = e
        .goal_create(
            "owner".into(),
            GoalCreate {
                output_format: None,
                workflow: None,
                infer_limits: false,
                request_id: "headless".into(),
                thread_id: thread.id.clone(),
                expected_revision: 0,
                objective: "Finish without interactive input".into(),
                token_budget: Some(100000),
                max_turns: Some(3),
                max_active_seconds: Some(30),
                interaction_mode: Some(InteractionMode::Headless),
            },
        )
        .await
        .unwrap();
    let task = until(&e, result["taskId"].as_str().unwrap(), RunStatus::Completed).await;
    assert_eq!(m.calls.load(Ordering::SeqCst), 3);
    assert!(task.messages.iter().all(|m| m.kind != "question"));
    assert_eq!(e.interactions(&thread.id).await.unwrap()["data"], json!([]));
    e.shutdown().await;
}

#[tokio::test]
async fn scheduled_task_is_durable_and_runs_at_its_timestamp() {
    let (dir, e, _) = open(false, false);
    let thread = e.create(e.default_cwd()).await.unwrap();
    let mut request = create(TaskMode::Scheduled, Some(thread.id));
    request.schedule = Some(Schedule {
        at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
            + 2,
        interval_seconds: None,
    });
    let result = e
        .task_create("owner".into(), request.clone())
        .await
        .unwrap();
    assert_eq!(
        e.task_create("owner".into(), request).await.unwrap(),
        result
    );
    assert!(result["runs"].as_array().unwrap().is_empty());
    assert!(e.drain("ifIdle".into(), 0).await.is_err());
    let id = result["id"].as_str().unwrap().to_owned();
    e.shutdown().await;
    drop(e);
    let model = Arc::new(Fixture {
        calls: AtomicUsize::new(0),
        ask: false,
        headless: false,
    });
    let reopened = Engine::open(dir.path(), model, Limits::default()).unwrap();
    reopened.start_task_scheduler();
    let task = until(&reopened, &id, RunStatus::Completed).await;
    assert_eq!(task.runs.len(), 1);
    assert!(task.next_run_at.is_none());
    assert_eq!(task.interaction_mode, InteractionMode::Headless);
    reopened.shutdown().await;
}

struct Workers {
    root_calls: AtomicUsize,
    worker_calls: AtomicUsize,
    release: tokio::sync::Notify,
}
#[async_trait]
impl Model for Workers {
    fn name(&self) -> &str {
        "task-worker-fixture"
    }
    async fn stream(&self, m: Vec<Message>) -> anyhow::Result<ModelStream> {
        self.chat(m, vec![]).await
    }
    async fn chat_limited(
        &self,
        m: Vec<Message>,
        t: Vec<Value>,
        _: RequestPurpose,
        _: Option<u64>,
    ) -> anyhow::Result<ModelStream> {
        self.chat(m, t).await
    }
    async fn chat(&self, m: Vec<Message>, _: Vec<Value>) -> anyhow::Result<ModelStream> {
        let text = m
            .iter()
            .map(Message::text_content)
            .collect::<Vec<_>>()
            .join("\n");
        let event = if text.contains("You are a TaskRun worker.") {
            let n = self.worker_calls.fetch_add(1, Ordering::SeqCst);
            if n == 0 {
                self.release.notified().await;
                tool("goal_read", json!({}), n)
            } else {
                ModelEvent::TextDelta("Worker inspected the assigned evidence".into())
            }
        } else {
            let n = self.root_calls.fetch_add(1, Ordering::SeqCst);
            match n {
                0 => tool(
                    "task_spawn",
                    json!({"prompt":"Inspect assigned evidence and return the result"}),
                    n,
                ),
                1 => tool("task_wait", json!({}), n),
                2 => {
                    assert!(text.contains("workerReport"));
                    let goal: Value = m
                        .iter()
                        .rev()
                        .find_map(|m| {
                            m.text_content()
                                .split("Current authoritative goal: ")
                                .nth(1)
                                .and_then(|s| serde_json::from_str(s).ok())
                        })
                        .unwrap();
                    tool(
                        "goal_update",
                        json!({"expectedRevision":goal["revision"],"status":"complete","summary":"worker evidence verified","evidence":["workerReport inspected"],"remaining":[]}),
                        n,
                    )
                }
                _ => ModelEvent::TextDelta("coordinated result".into()),
            }
        };
        Ok(Box::pin(stream::iter(vec![
            Ok(event),
            Ok(ModelEvent::Usage(ModelUsage {
                input_tokens: 10,
                cached_input_tokens: 0,
                output_tokens: 5,
            })),
        ])))
    }
}

async fn worker_fixture() -> (tempfile::TempDir, Arc<Engine>, Arc<Workers>, String) {
    let dir = tempfile::tempdir().unwrap();
    let model = Arc::new(Workers {
        root_calls: AtomicUsize::new(0),
        worker_calls: AtomicUsize::new(0),
        release: tokio::sync::Notify::new(),
    });
    let engine = Engine::open(dir.path(), model.clone(), Limits::default()).unwrap();
    let mut request = create(TaskMode::Background, None);
    request.interaction_mode = Some(InteractionMode::Headless);
    request.token_budget = Some(100000);
    let task = engine.task_create("owner".into(), request).await.unwrap();
    (dir, engine, model, task["id"].as_str().unwrap().into())
}

#[tokio::test]
async fn task_worker_survives_coordinator_turn_and_shares_budget() {
    let (_dir, e, m, id) = worker_fixture().await;
    let waiting = until(&e, &id, RunStatus::WaitingForAgents).await;
    assert_eq!(m.root_calls.load(Ordering::SeqCst), 2);
    let worker = &waiting.runs[0].workers[0];
    assert!(
        e.start(
            &worker.thread_id,
            vec![areal_protocol::Input::text("unowned turn")]
        )
        .await
        .is_err()
    );
    let goal = e
        .goal_get(waiting.runs[0].thread_id.as_ref().unwrap())
        .await
        .unwrap();
    assert_eq!(goal["goal"]["waitingForInput"], false);
    assert_eq!(goal["goal"]["waitingForAgents"], true);
    assert_eq!(
        e.server_status().await["activeTurns"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    m.release.notify_one();
    let done = until(&e, &id, RunStatus::Completed).await;
    assert_eq!(m.worker_calls.load(Ordering::SeqCst), 2);
    assert_eq!(done.runs[0].usage.tokens_used, 90);
    assert_eq!(done.runs[0].usage.turns_started, 2);
    assert!(done.runs[0].workers[0].settled);
    assert_eq!(done.runs[0].workers[0].status, "completed");
    e.shutdown().await;
}

#[tokio::test]
async fn cancelling_task_cleans_detached_workers_and_prevents_goal_resume() {
    let (_dir, e, _m, id) = worker_fixture().await;
    let waiting = until(&e, &id, RunStatus::WaitingForAgents).await;
    let mut revision = waiting.revision;
    for attempt in 0..20 {
        let req = TaskControl {
            request_id: "cancel".into(),
            task_id: id.clone(),
            expected_revision: revision,
        };
        match e.task_control("owner".into(), "cancel".into(), req).await {
            Ok(_) => break,
            // worker 结算可能推进 Task revision；客户端也须读取新版本后重试。
            Err(Error::Conflict) => {
                assert!(attempt < 19, "cancellation remained conflicted");
                revision = e.task_read(&id).await.unwrap().revision;
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Err(error) => panic!("unexpected task cancellation error: {error}"),
        }
    }
    let done = until(&e, &id, RunStatus::Cancelled).await;
    assert!(done.runs[0].workers[0].settled);
    assert_eq!(e.server_status().await["activeTurns"], json!([]));
    let thread = done.runs[0].thread_id.as_ref().unwrap();
    let goal = e.goal_get(thread).await.unwrap();
    assert!(
        e.goal_control(
            "owner".into(),
            "resume".into(),
            GoalControl {
                request_id: "resume-cancelled".into(),
                thread_id: thread.clone(),
                goal_id: done.runs[0].goal_id.clone().unwrap(),
                expected_revision: goal["revision"].as_u64().unwrap()
            },
            None
        )
        .await
        .is_err()
    );
    e.shutdown().await;
}

#[tokio::test]
async fn interactive_foreground_goal_can_choose_async_questions() {
    let (_dir, e, _) = open(true, false);
    let thread = e.create(e.default_cwd()).await.unwrap();
    let result = e
        .task_create(
            "owner".into(),
            create(TaskMode::Foreground, Some(thread.id.clone())),
        )
        .await
        .unwrap();
    let task = until(
        &e,
        result["id"].as_str().unwrap(),
        RunStatus::WaitingForInput,
    )
    .await;
    assert_eq!(task.interaction_mode, InteractionMode::Interactive);
    assert_eq!(e.interactions(&thread.id).await.unwrap()["data"], json!([]));
    e.channel_reply(
        "owner".into(),
        ChannelReply {
            request_id: "answer".into(),
            task_id: task.id.clone(),
            run_id: task.runs[0].id.clone(),
            question_id: task.messages[0].id.clone(),
            answers: BTreeMap::from([("choice".into(), "B".into())]),
        },
    )
    .await
    .unwrap();
    until(&e, &task.id, RunStatus::Completed).await;
    e.shutdown().await;
}

struct Approval(AtomicUsize);
#[async_trait]
impl Model for Approval {
    fn name(&self) -> &str {
        "headless-approval"
    }
    async fn stream(&self, m: Vec<Message>) -> anyhow::Result<ModelStream> {
        let n = self.0.fetch_add(1, Ordering::SeqCst);
        let event = if n == 0 {
            tool(
                "plan_update",
                json!({"expectedRevision":0,"steps":[{"id":"one","text":"must not execute without approval","status":"completed"}]}),
                n,
            )
        } else {
            assert!(m.iter().any(|m| {
                m.text_content()
                    .contains("NON_INTERACTIVE_APPROVAL_REQUIRED")
            }));
            ModelEvent::TextDelta("approval-required work is unavailable".into())
        };
        Ok(Box::pin(stream::iter([Ok(event)])))
    }
}

#[tokio::test]
async fn headless_turn_override_denies_required_approval_without_creating_an_interaction() {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(
        dir.path(),
        Arc::new(Approval(AtomicUsize::new(0))),
        Limits::default(),
    )
    .unwrap();
    let thread = e.create(e.default_cwd()).await.unwrap();
    e.configure_thread(serde_json::from_value(json!({"threadId":thread.id,"expectedRevision":1,"options":{"approvalTools":["plan_update"]}})).unwrap()).await.unwrap();
    e.start_durable("owner".into(),serde_json::from_value(json!({"requestId":"headless-turn","threadId":thread.id,"input":[{"type":"text","text":"try the operation"}],"interactionMode":"headless"})).unwrap(),false).await.unwrap();
    let done = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let t = e.read(&thread.id, true).await.unwrap();
            if t.turns[0].status != areal_protocol::TurnStatus::InProgress {
                break t;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(done.turns[0].status, areal_protocol::TurnStatus::Completed);
    assert!(e.plan(&thread.id).await.unwrap().steps.is_empty());
    assert_eq!(e.interactions(&thread.id).await.unwrap()["data"], json!([]));
    assert_eq!(
        done.desktop.unwrap().configuration.options.interaction_mode,
        InteractionMode::Interactive
    );
    e.shutdown().await;
}

#[tokio::test]
async fn channel_reply_survives_restart_and_requires_explicit_task_resume() {
    let (dir, e, m) = open(true, false);
    let accepted = e
        .task_create("owner".into(), create(TaskMode::Background, None))
        .await
        .unwrap();
    let id = accepted["id"].as_str().unwrap().to_owned();
    let waiting = until(&e, &id, RunStatus::WaitingForInput).await;
    e.shutdown().await;
    drop(e);
    let e = Engine::open(dir.path(), m.clone(), Limits::default()).unwrap();
    let paused = e.task_read(&id).await.unwrap();
    assert!(paused.paused);
    assert_eq!(paused.runs[0].status, RunStatus::Paused);
    let request = ChannelReply {
        request_id: "reconnected-answer".into(),
        task_id: id.clone(),
        run_id: waiting.runs[0].id.clone(),
        question_id: waiting.messages[0].id.clone(),
        answers: BTreeMap::from([("choice".into(), "B".into())]),
    };
    let receipt = e
        .channel_reply("owner".into(), request.clone())
        .await
        .unwrap();
    e.shutdown().await;
    drop(e);
    let e = Engine::open(dir.path(), m.clone(), Limits::default()).unwrap();
    assert_eq!(
        e.channel_reply("owner".into(), request).await.unwrap(),
        receipt
    );
    assert_eq!(m.calls.load(Ordering::SeqCst), 3);
    let task = e.task_read(&id).await.unwrap();
    e.task_control(
        "owner".into(),
        "resume".into(),
        TaskControl {
            request_id: "resume".into(),
            task_id: id.clone(),
            expected_revision: task.revision,
        },
    )
    .await
    .unwrap();
    until(&e, &id, RunStatus::Completed).await;
    e.shutdown().await;
}

struct Expiry(AtomicUsize, bool);
#[async_trait]
impl Model for Expiry {
    fn name(&self) -> &str {
        "expiring-question"
    }
    async fn stream(&self, m: Vec<Message>) -> anyhow::Result<ModelStream> {
        self.chat(m, vec![]).await
    }
    async fn chat_limited(
        &self,
        m: Vec<Message>,
        t: Vec<Value>,
        _: RequestPurpose,
        _: Option<u64>,
    ) -> anyhow::Result<ModelStream> {
        self.chat(m, t).await
    }
    async fn chat(&self, m: Vec<Message>, _: Vec<Value>) -> anyhow::Result<ModelStream> {
        let n = self.0.fetch_add(1, Ordering::SeqCst);
        let event = match n {
            0 => tool(
                "ask_user_question",
                // 避免重负载下 1 秒边界先于 task_wait 提交，令用例只验证到期唤醒。
                json!({"questions":[{"id":"choice","title":"Choose a target","options":["A","B"],"allowFreeText":false}],"mode":"async","required":true,"timeoutSeconds":3}),
                n,
            ),
            1 if self.1 => tool(
                "ask_user_question",
                json!({"questions":[{"id":"optional","title":"Any additional preference?","allowFreeText":true}],"mode":"async","timeoutSeconds":3600}),
                n,
            ),
            n if n == 1 + usize::from(self.1) => tool("task_wait", json!({}), n),
            n if n == 2 + usize::from(self.1) => {
                assert!(
                    m.iter()
                        .any(|m| m.text_content().contains("\"status\":\"expired\""))
                );
                if self.1 {
                    assert!(m.iter().any(|m| {
                        m.text_content().contains("Current task channel:")
                            && m.text_content().contains("\"status\":\"pending\"")
                    }));
                }
                let goal: Value = m
                    .iter()
                    .rev()
                    .find_map(|m| {
                        m.text_content()
                            .split("Current authoritative goal: ")
                            .nth(1)
                            .and_then(|s| serde_json::from_str(s).ok())
                    })
                    .unwrap();
                tool(
                    "goal_update",
                    json!({"expectedRevision":goal["revision"],"status":"complete","summary":"completed using a verified fallback","evidence":["fallback verified after expiry"],"remaining":[]}),
                    n,
                )
            }
            _ => ModelEvent::TextDelta("fallback result".into()),
        };
        Ok(Box::pin(stream::iter(vec![
            Ok(event),
            Ok(ModelEvent::Usage(ModelUsage {
                input_tokens: 10,
                cached_input_tokens: 0,
                output_tokens: 5,
            })),
        ])))
    }
}

#[tokio::test]
async fn expired_required_question_wakes_run_without_accepting_a_late_answer() {
    check_expired_question(false).await;
}

#[tokio::test]
async fn one_expired_question_wakes_run_while_another_question_is_pending() {
    check_expired_question(true).await;
}

async fn check_expired_question(another_question: bool) {
    let dir = tempfile::tempdir().unwrap();
    let e = Engine::open(
        dir.path(),
        Arc::new(Expiry(AtomicUsize::new(0), another_question)),
        Limits::default(),
    )
    .unwrap();
    let accepted = e
        .task_create("owner".into(), create(TaskMode::Background, None))
        .await
        .unwrap();
    let done = until(&e, accepted["id"].as_str().unwrap(), RunStatus::Completed).await;
    assert_eq!(done.runs[0].usage.turns_started, 2);
    let question = done.messages.iter().find(|m| m.kind == "question").unwrap();
    assert_eq!(question.status, "expired");
    if another_question {
        let optional = done
            .messages
            .iter()
            .find(|m| m.questions.iter().any(|q| q.id == "optional"))
            .unwrap();
        assert_eq!(optional.status, "cancelled");
    }
    assert!(
        e.channel_reply(
            "owner".into(),
            ChannelReply {
                request_id: "late".into(),
                task_id: done.id.clone(),
                run_id: done.runs[0].id.clone(),
                question_id: question.id.clone(),
                answers: BTreeMap::from([("choice".into(), "B".into())])
            }
        )
        .await
        .is_err()
    );
    e.shutdown().await;
}

#[tokio::test]
async fn recurring_schedule_keeps_channel_identity_and_uses_distinct_runs_and_goals() {
    let (_dir, e, _) = open(false, false);
    let thread = e.create(e.default_cwd()).await.unwrap();
    let mut request = create(TaskMode::Scheduled, Some(thread.id.clone()));
    request.schedule = Some(Schedule {
        at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64,
        interval_seconds: Some(1),
    });
    let accepted = e.task_create("owner".into(), request).await.unwrap();
    let id = accepted["id"].as_str().unwrap();
    let task = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let task = e.task_read(id).await.unwrap();
            if task
                .runs
                .iter()
                .filter(|r| r.status == RunStatus::Completed)
                .count()
                >= 2
            {
                break task;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_ne!(task.runs[0].id, task.runs[1].id);
    assert_ne!(task.runs[0].goal_id, task.runs[1].goal_id);
    assert!(
        task.runs
            .iter()
            .all(|r| r.thread_id.as_deref() == Some(&thread.id))
    );
    assert_eq!(
        task.messages.iter().filter(|m| m.kind == "report").count(),
        task.runs
            .iter()
            .filter(|r| r.status == RunStatus::Completed)
            .count()
    );
    // 周期调度可能在读取后提交新版本；冲突未受理，须刷新版本后重试。
    let (request, receipt) = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let task = e.task_read(id).await.unwrap();
            let request = TaskControl {
                request_id: "cancel-recurrence".into(),
                task_id: task.id.clone(),
                expected_revision: task.revision,
            };
            match e
                .task_control("owner".into(), "cancel".into(), request.clone())
                .await
            {
                Ok(receipt) => break (request, receipt),
                Err(areal_engine::Error::Conflict) => tokio::task::yield_now().await,
                Err(error) => panic!("cancel recurrence failed: {error}"),
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        e.task_control("owner".into(), "cancel".into(), request)
            .await
            .unwrap(),
        receipt
    );
    assert!(e.task_read(id).await.unwrap().next_run_at.is_none());
    e.shutdown().await;
}
