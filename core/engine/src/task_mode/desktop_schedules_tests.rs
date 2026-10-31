//! 先固定桌面准入与忙碌跳过的可观察行为。
use super::*;
struct Pending;
#[async_trait::async_trait]
impl Model for Pending {
    fn name(&self) -> &str {
        "scheduled-fixture"
    }
    async fn stream(&self, _: Vec<model::Message>) -> anyhow::Result<model::ModelStream> {
        Ok(Box::pin(futures_util::stream::pending()))
    }
    async fn chat_limited(
        &self,
        m: Vec<model::Message>,
        _: Vec<Value>,
        _: model::RequestPurpose,
        _: Option<u64>,
    ) -> anyhow::Result<model::ModelStream> {
        self.stream(m).await
    }
}
struct Host {
    closed: AtomicBool,
}
#[async_trait::async_trait]
impl tools::DynamicToolHost for Host {
    fn id(&self) -> &str {
        "fixture-host"
    }
    fn identity(&self) -> &str {
        "fixture"
    }
    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }
    async fn prepare_schedule(&self, _: Value, _: CancellationToken) -> anyhow::Result<Value> {
        Ok(json!({}))
    }
    async fn call(
        &self,
        _: Value,
        _: CancellationToken,
    ) -> anyhow::Result<areal_protocol::DynamicToolResponse> {
        anyhow::bail!("unexpected tool")
    }
}
#[tokio::test]
async fn desktop_schedule_requires_host_skips_busy_and_pauses_only_future_runs() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(Pending), Limits::default()).unwrap();
    engine.task_modes.started.store(true, Ordering::Release);
    let anchor = engine.create("/workspace".into()).await.unwrap();
    let value = engine.task_create("fixture".into(), serde_json::from_value(json!({"requestId":"schedule", "mode":"scheduled", "objective":"inspect", "threadId":anchor.id,"schedule":{"at":now()-100,"intervalSeconds":10}})).unwrap()).await.unwrap();
    let id = value["id"].as_str().unwrap();
    engine.advance_task(id).await.unwrap();
    assert!(engine.task_read(id).await.unwrap().runs.is_empty());
    let host = Arc::new(Host {
        closed: AtomicBool::new(false),
    });
    engine.register_schedule_host(host.clone()).await.unwrap();
    engine.advance_task(id).await.unwrap();
    let task = engine.task_read(id).await.unwrap();
    assert_eq!(task.runs.len(), 1);
    let run = task.runs.last().unwrap();
    assert_ne!(run.thread_id.as_ref(), Some(&anchor.id));
    assert!(run.started_at.is_some());
    engine
        .edit_task(id, |t| t.next_run_at = Some(now() - 30))
        .await
        .unwrap();
    engine.advance_task(id).await.unwrap();
    let task = engine.task_read(id).await.unwrap();
    assert_eq!(task.runs.len(), 1);
    assert!(task.skipped_runs > 0);
    engine
        .task_control(
            "fixture".into(),
            "pause".into(),
            TaskControl {
                request_id: "pause".into(),
                task_id: id.into(),
                expected_revision: task.revision,
                expected_run_id: None,
            },
        )
        .await
        .unwrap();
    engine.advance_task(id).await.unwrap();
    let task = engine.task_read(id).await.unwrap();
    let view = engine
        .goal_get(task.runs[0].thread_id.as_ref().unwrap())
        .await
        .unwrap();
    assert_eq!(view["goal"]["status"], "active");
    host.closed.store(true, Ordering::Release);
    engine.advance_task(id).await.unwrap();
    engine
        .wait(task.runs[0].thread_id.as_ref().unwrap())
        .await
        .unwrap();
    engine.advance_task(id).await.unwrap();
    let run = &engine.task_read(id).await.unwrap().runs[0];
    assert_eq!(run.status, RunStatus::Paused);
    assert_eq!(run.reason.as_deref(), Some("hostUnavailable"));
    assert!(run.completed_at.is_none());
    engine.shutdown().await;
}

#[tokio::test]
async fn interrupted_schedule_run_remains_resumable_until_the_next_trigger() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(Pending), Limits::default()).unwrap();
    engine.task_modes.started.store(true, Ordering::Release);
    let anchor = engine.create("/workspace".into()).await.unwrap();
    let value = engine.task_create("fixture".into(), serde_json::from_value(json!({"requestId":"restart", "mode":"scheduled", "objective":"inspect", "threadId":anchor.id,"schedule":{"at":now()-100,"intervalSeconds":3600}})).unwrap()).await.unwrap();
    let id = value["id"].as_str().unwrap().to_string();
    let host = Arc::new(Host {
        closed: AtomicBool::new(false),
    });
    engine.register_schedule_host(host.clone()).await.unwrap();
    engine.advance_task(&id).await.unwrap();
    assert_eq!(engine.task_read(&id).await.unwrap().runs.len(), 1);
    engine.shutdown().await;
    drop(engine);

    let engine = Engine::open(dir.path(), Arc::new(Pending), Limits::default()).unwrap();
    engine.task_modes.started.store(true, Ordering::Release);
    let run = engine.task_read(&id).await.unwrap().runs[0].clone();
    assert_eq!(run.status, RunStatus::Paused);
    assert_eq!(run.reason.as_deref(), Some("serverRestarted"));
    engine.advance_task(&id).await.unwrap();
    engine.wait(run.thread_id.as_ref().unwrap()).await.unwrap();
    engine.advance_task(&id).await.unwrap();
    let run = engine.task_read(&id).await.unwrap().runs[0].clone();
    assert_eq!(run.status, RunStatus::Paused);
    assert_eq!(run.reason.as_deref(), Some("serverRestarted"));
    assert!(run.completed_at.is_none());

    let host = Arc::new(Host {
        closed: AtomicBool::new(false),
    });
    engine.register_schedule_host(host).await.unwrap();
    let before = engine
        .read(run.thread_id.as_ref().unwrap(), true)
        .await
        .unwrap();
    engine.advance_task(&id).await.unwrap();
    assert_eq!(
        engine.task_read(&id).await.unwrap().runs[0].status,
        RunStatus::Paused
    );
    assert_eq!(
        engine
            .read(run.thread_id.as_ref().unwrap(), true)
            .await
            .unwrap()
            .turns
            .len(),
        before.turns.len()
    );
    engine
        .edit_task(&id, |t| t.next_run_at = Some(now() - 1))
        .await
        .unwrap();
    engine.advance_task(&id).await.unwrap();
    let task = engine.task_read(&id).await.unwrap();
    assert_eq!(task.runs.len(), 2);
    assert_eq!(task.skipped_runs, 0);
    assert_eq!(task.runs[0].status, RunStatus::Failed);
    assert!(task.runs[0].completed_at.is_some());
    assert_ne!(task.runs[1].id, run.id);
    assert_ne!(task.runs[1].thread_id, run.thread_id);
    engine.shutdown().await;
}

#[tokio::test]
async fn interrupted_schedule_explicit_resume_keeps_run_and_thread_with_a_fresh_turn() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(Pending), Limits::default()).unwrap();
    engine.task_modes.started.store(true, Ordering::Release);
    let anchor = engine.create("/workspace".into()).await.unwrap();
    let value = engine.task_create("fixture".into(), serde_json::from_value(json!({"requestId":"manual-restart", "mode":"scheduled", "objective":"inspect", "threadId":anchor.id,"schedule":{"at":now()-1,"intervalSeconds":3600}})).unwrap()).await.unwrap();
    let id = value["id"].as_str().unwrap().to_string();
    engine
        .register_schedule_host(Arc::new(Host {
            closed: AtomicBool::new(false),
        }))
        .await
        .unwrap();
    engine.advance_task(&id).await.unwrap();
    let original = engine.task_read(&id).await.unwrap().runs[0].clone();
    let thread_id = original.thread_id.as_ref().unwrap().clone();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while engine
            .read(&thread_id, true)
            .await
            .unwrap()
            .turns
            .is_empty()
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    engine.shutdown().await;
    drop(engine);
    let engine = Engine::open(dir.path(), Arc::new(Pending), Limits::default()).unwrap();
    engine.task_modes.started.store(true, Ordering::Release);
    let before = engine.read(&thread_id, true).await.unwrap();
    engine
        .register_schedule_host(Arc::new(Host {
            closed: AtomicBool::new(false),
        }))
        .await
        .unwrap();
    engine.advance_task(&id).await.unwrap();
    let task = engine.task_read(&id).await.unwrap();
    assert_eq!(task.runs[0].status, RunStatus::Paused);
    assert!(task.runs[0].completed_at.is_none());
    assert_eq!(
        engine.read(&thread_id, true).await.unwrap().turns.len(),
        before.turns.len()
    );
    engine
        .task_control(
            "fixture".into(),
            "resumeRun".into(),
            TaskControl {
                request_id: "manual-resume".into(),
                task_id: id.clone(),
                expected_revision: task.revision,
                expected_run_id: Some(original.id.clone()),
            },
        )
        .await
        .unwrap();
    engine.advance_task(&id).await.unwrap();
    let resumed = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let thread = engine.read(&thread_id, true).await.unwrap();
            if thread.turns.len() > before.turns.len() {
                break thread;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let task = engine.task_read(&id).await.unwrap();
    assert_eq!(task.runs.len(), 1);
    assert_eq!(task.runs[0].id, original.id);
    assert_eq!(task.runs[0].thread_id, original.thread_id);
    assert_ne!(
        resumed.turns.last().unwrap().id,
        before.turns.last().unwrap().id
    );
    assert_eq!(task.runs[0].status, RunStatus::Running);
    engine.shutdown().await;
}

#[tokio::test]
async fn next_trigger_cannot_supersede_resume_intent_active_runs_or_unsettled_workers() {
    for (status, reason, unsettled) in [
        (RunStatus::Paused, "resumeRequested", false),
        (RunStatus::Paused, "hostUnavailable", true),
        (RunStatus::Running, "", false),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(dir.path(), Arc::new(Pending), Limits::default()).unwrap();
        engine.task_modes.started.store(true, Ordering::Release);
        let anchor = engine.create("/workspace".into()).await.unwrap();
        let value = engine.task_create("fixture".into(), serde_json::from_value(json!({"requestId":"busy", "mode":"scheduled", "objective":"inspect", "threadId":anchor.id,"schedule":{"at":now()+3600,"intervalSeconds":3600}})).unwrap()).await.unwrap();
        let id = value["id"].as_str().unwrap().to_string();
        engine.edit_task(&id, |task| {
            let mut run = new_run(None, now()-3600);
            run.status = status;
            run.reason = Some(reason.into());
            if unsettled { run.workers.push(serde_json::from_value(json!({"threadId":"worker", "turnId":"turn", "status":"running", "settled":false})).unwrap()); }
            task.runs.push(run);
            task.next_run_at = Some(now()-1);
        }).await.unwrap();
        engine.admit_schedule_due(&id, true, now()).await.unwrap();
        let task = engine.task_read(&id).await.unwrap();
        assert_eq!(task.runs.len(), 1);
        assert_eq!(task.runs[0].status, status);
        assert!(task.runs[0].completed_at.is_none());
        assert_eq!(task.skipped_runs, 1);
        engine
            .edit_task(&id, |task| task.runs[0].workers.clear())
            .await
            .unwrap();
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn stalled_schedule_run_is_settled_when_the_next_trigger_is_due() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(Pending), Limits::default()).unwrap();
    engine.task_modes.started.store(true, Ordering::Release);
    let anchor = engine.create("/workspace".into()).await.unwrap();
    let value = engine.task_create("fixture".into(), serde_json::from_value(json!({"requestId":"stalled", "mode":"scheduled", "objective":"inspect", "threadId":anchor.id,"schedule":{"at":now()+3600,"intervalSeconds":3600}})).unwrap()).await.unwrap();
    let id = value["id"].as_str().unwrap().to_string();
    engine
        .edit_task(&id, |t| {
            let mut run = new_run(None, now() - 7200);
            run.status = RunStatus::Paused;
            run.reason = Some("goalPaused".into());
            t.runs.push(run);
            t.next_run_at = Some(now() - 1);
        })
        .await
        .unwrap();
    engine.admit_schedule_due(&id, false, now()).await.unwrap();
    assert_eq!(engine.task_read(&id).await.unwrap().runs.len(), 1);
    engine.admit_schedule_due(&id, true, now()).await.unwrap();
    let task = engine.task_read(&id).await.unwrap();
    assert_eq!(task.runs.len(), 2);
    assert_eq!(task.runs[0].status, RunStatus::Failed);
    assert_eq!(task.runs[0].reason.as_deref(), Some("goalPaused"));
    assert_eq!(task.runs[1].status, RunStatus::Queued);
    assert_eq!(task.skipped_runs, 0);
    engine.shutdown().await;
}

#[tokio::test]
async fn settled_schedule_history_does_not_stop_the_129th_trigger() {
    use model::{Message, ModelEvent, ModelStream, RequestPurpose, ToolCall};
    use std::sync::atomic::AtomicUsize;
    struct Complete(AtomicUsize);
    #[async_trait::async_trait]
    impl Model for Complete {
        fn name(&self) -> &str {
            "recurring-ledger-fixture"
        }
        async fn stream(&self, m: Vec<Message>) -> anyhow::Result<ModelStream> {
            self.chat_limited(m, vec![], RequestPurpose::Solve, None)
                .await
        }
        async fn chat_limited(
            &self,
            m: Vec<Message>,
            _: Vec<Value>,
            _: RequestPurpose,
            _: Option<u64>,
        ) -> anyhow::Result<ModelStream> {
            let n = self.0.fetch_add(1, Ordering::SeqCst);
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
            let event = if n.is_multiple_of(2) {
                ModelEvent::ToolCall(ToolCall {id:format!("report-{n}"),name:"goal_update".into(),arguments:json!({"expectedRevision":goal["revision"],"status":"complete","summary":"verified","evidence":["fixture"],"remaining":[]}).to_string()})
            } else {
                ModelEvent::TextDelta("done".into())
            };
            Ok(Box::pin(futures_util::stream::iter(vec![
                Ok(event),
                Ok(ModelEvent::Usage(areal_protocol::ModelUsage {
                    input_tokens: 10,
                    cached_input_tokens: 0,
                    output_tokens: 5,
                })),
            ])))
        }
    }
    let run_count = std::env::var("AREAL_TASK_LEDGER_RUNS")
        .ok()
        .map(|n| n.parse::<usize>().unwrap())
        .unwrap_or(130);
    assert!((130..=2000).contains(&run_count));
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(
        dir.path(),
        Arc::new(Complete(AtomicUsize::new(0))),
        Limits {
            max_threads: run_count + 8,
            ..Limits::default()
        },
    )
    .unwrap();
    engine.task_modes.started.store(true, Ordering::Release);
    let anchor = engine.create("/workspace".into()).await.unwrap();
    let value=engine.task_create("fixture".into(),serde_json::from_value(json!({"requestId":"long-schedule","mode":"scheduled","objective":"inspect","threadId":anchor.id,"schedule":{"at":now()+3600,"intervalSeconds":1},"tokenBudget":100000})).unwrap()).await.unwrap();
    let task_id = value["id"].as_str().unwrap();
    engine
        .register_schedule_host(Arc::new(Host {
            closed: AtomicBool::new(false),
        }))
        .await
        .unwrap();
    let mut first = None;
    for n in 0..run_count {
        engine
            .edit_task(task_id, |task| task.next_run_at = Some(now() - 1))
            .await
            .unwrap();
        engine.advance_task(task_id).await.unwrap();
        let task = engine.task_read(task_id).await.unwrap();
        assert!(!task.paused, "trigger {n} must remain admitted");
        let run = task.runs.last().unwrap().clone();
        let thread_id = run.thread_id.as_ref().unwrap();
        if n == 0 {
            first = Some(run.clone());
        }
        let view = engine.goal_get(thread_id).await.unwrap();
        assert_eq!(view["goal"]["tokenBudget"], 100000 - n as u64 * 30);
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let view = engine.goal_get(thread_id).await.unwrap();
                if view["goal"]["status"] == "completed" {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        engine
            .edit_task(task_id, |task| task.next_run_at = Some(now() + 3600))
            .await
            .unwrap();
        engine.advance_task(task_id).await.unwrap();
    }
    let task = engine.task_read(task_id).await.unwrap();
    assert_eq!(task.run_count, run_count as u64);
    assert_eq!(task.archived_run_count, run_count as u64 - 128);
    assert_eq!(task.runs.len(), 128);
    let first = first.unwrap();
    let goal_id = first.goal_id.as_ref().unwrap();
    assert!(!engine.task_goal_can_resume(goal_id).await.unwrap());
    assert!(engine.validate_prompt_limit_owner(goal_id).await.is_err());
    assert!(engine.is_desktop_schedule_goal(goal_id).await.unwrap());
    let thread_id = first.thread_id.as_ref().unwrap();
    let view = engine.goal_get(thread_id).await.unwrap();
    assert!(matches!(
        engine
            .goal_control(
                "fixture".into(),
                "resume".into(),
                GoalControl {
                    request_id: "old-resume".into(),
                    thread_id: thread_id.clone(),
                    goal_id: goal_id.clone(),
                    expected_revision: view["revision"].as_u64().unwrap()
                },
                None
            )
            .await,
        Err(Error::Conflict)
    ));
    let mut allowed = std::collections::BTreeSet::from([anchor.id]);
    for run in &task.runs {
        allowed.extend(run.thread_id.clone());
    }
    assert!(!engine.task_visible(task_id, Some(&allowed)).await.unwrap());
    let mut cursor = None;
    let mut runs = std::collections::BTreeSet::new();
    loop {
        let page = engine
            .task_runs_list(TaskRunsList {
                task_id: task_id.into(),
                cursor,
                limit: Some(100),
            })
            .await
            .unwrap();
        assert_eq!(page.run_count, run_count as u64);
        for run in page.data {
            assert!(runs.insert(run.id));
        }
        if !page.has_more {
            break;
        }
        cursor = page.next_cursor;
    }
    assert_eq!(runs.len(), run_count);
    assert_eq!(
        engine
            .task_run_read(TaskRunRead {
                task_id: task_id.into(),
                run_id: first.id.clone()
            })
            .await
            .unwrap()
            .usage
            .tokens_used,
        30
    );
    engine.shutdown().await;
}
