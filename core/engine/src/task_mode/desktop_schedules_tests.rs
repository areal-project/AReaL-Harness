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

struct ScheduleConnection {
    id: &'static str,
    owner: &'static str,
    closed: AtomicBool,
    preparations: std::sync::atomic::AtomicUsize,
}
impl ScheduleConnection {
    fn new(id: &'static str, owner: &'static str) -> Arc<Self> {
        Arc::new(Self {
            id,
            owner,
            closed: AtomicBool::new(false),
            preparations: std::sync::atomic::AtomicUsize::new(0),
        })
    }
}
#[async_trait::async_trait]
impl tools::DynamicToolHost for ScheduleConnection {
    fn id(&self) -> &str {
        self.id
    }
    fn identity(&self) -> &str {
        self.owner
    }
    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }
    async fn prepare_schedule(&self, _: Value, _: CancellationToken) -> anyhow::Result<Value> {
        self.preparations.fetch_add(1, Ordering::AcqRel);
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
async fn desktop_provider_registration_is_connection_scoped_and_revocable() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(Pending), Limits::default()).unwrap();
    let first = ScheduleConnection::new("first", "owner");
    let successor = ScheduleConnection::new("successor", "owner");
    let browser = || TaskToolsReady {
        bundles: vec![DesktopToolBundle::Browser],
    };
    engine
        .register_schedule_tools(browser(), first.clone())
        .await
        .unwrap();
    engine
        .register_schedule_tools(browser(), first.clone())
        .await
        .unwrap();
    assert!(matches!(
        engine
            .register_schedule_tools(browser(), successor.clone())
            .await,
        Err(Error::Conflict)
    ));
    assert!(
        engine
            .register_schedule_tools(
                TaskToolsReady {
                    bundles: vec![DesktopToolBundle::Browser, DesktopToolBundle::Browser]
                },
                first.clone()
            )
            .await
            .is_err()
    );
    engine
        .register_schedule_tools(TaskToolsReady { bundles: vec![] }, successor.clone())
        .await
        .unwrap();
    assert_eq!(
        engine.schedule_tools("owner").await.unwrap().host.id(),
        "first"
    );
    assert!(engine.schedule_tools("foreign").await.is_none());
    first.closed.store(true, Ordering::Release);
    assert!(engine.schedule_tools("owner").await.is_none());
    engine
        .register_schedule_tools(browser(), successor.clone())
        .await
        .unwrap();
    assert!(matches!(
        engine.register_schedule_tools(browser(), first).await,
        Err(Error::Closed)
    ));
    engine
        .register_schedule_tools(TaskToolsReady { bundles: vec![] }, successor)
        .await
        .unwrap();
    assert!(engine.schedule_tools("owner").await.is_none());
    engine.shutdown().await;
}

#[tokio::test]
async fn scheduled_run_keeps_scheduler_when_gui_disconnects_without_adopting_successor() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(Pending), Limits::default()).unwrap();
    engine.task_modes.started.store(true, Ordering::Release);
    let scheduler = ScheduleConnection::new("scheduler", "owner");
    let gui = ScheduleConnection::new("gui", "owner");
    engine
        .register_schedule_host(scheduler.clone())
        .await
        .unwrap();
    engine
        .register_schedule_tools(
            TaskToolsReady {
                bundles: vec![DesktopToolBundle::Browser, DesktopToolBundle::Computer],
            },
            gui.clone(),
        )
        .await
        .unwrap();
    let anchor = engine.create("/workspace".into()).await.unwrap();
    let task = engine.task_create("owner".into(), serde_json::from_value(json!({"requestId":"split", "mode":"scheduled", "objective":"inspect", "threadId":anchor.id,"schedule":{"at":now()-1}})).unwrap()).await.unwrap();
    let task_id = task["id"].as_str().unwrap();
    engine.advance_task(task_id).await.unwrap();
    let run = engine.task_read(task_id).await.unwrap().runs[0].clone();
    let thread_id = run.thread_id.as_ref().unwrap();
    let cell = engine.cell(thread_id).await.unwrap();
    let thread = engine.read(thread_id, false).await.unwrap();
    let visible = engine
        .visible_tools(&cell, &Default::default(), true, &thread)
        .await;
    for name in ["browser_v1", "computer_v1"] {
        assert!(visible.iter().any(|tool| tool["function"]["name"] == name));
    }
    let ordinary = engine.create_configured("owner".into(), serde_json::from_value(json!({"requestId":"ordinary-tools","cwd":"/workspace","dynamicTools":[areal_protocol::desktop::browser_v1_tool()]})).unwrap(), gui.clone()).await.unwrap();
    gui.closed.store(true, Ordering::Release);
    let successor = ScheduleConnection::new("successor", "owner");
    engine
        .register_schedule_tools(
            TaskToolsReady {
                bundles: vec![DesktopToolBundle::Browser, DesktopToolBundle::Computer],
            },
            successor,
        )
        .await
        .unwrap();
    engine.advance_task(task_id).await.unwrap();
    assert_eq!(
        engine.goal_get(thread_id).await.unwrap()["goal"]["status"],
        "active"
    );
    let current = engine.task_read(task_id).await.unwrap();
    assert_eq!(current.runs[0].id, run.id);
    assert_ne!(current.runs[0].reason.as_deref(), Some("hostUnavailable"));
    let visible = engine
        .visible_tools(&cell, &Default::default(), true, &thread)
        .await;
    assert!(!visible.iter().any(|tool| matches!(
        tool["function"]["name"].as_str(),
        Some("browser_v1" | "computer_v1")
    )));
    let bindings = cell.bindings.read().await;
    assert_eq!(bindings.host.as_ref().unwrap().id(), "gui");
    assert_eq!(bindings.schedule_host.as_ref().unwrap().id(), "scheduler");
    drop(bindings);
    assert!(matches!(
        engine
            .start(&ordinary.id, vec![Input::text("continue")])
            .await,
        Err(Error::Invalid(_))
    ));
    engine.shutdown().await;
}

#[tokio::test]
async fn prepared_schedule_restart_preserves_catalog_and_only_binds_compatible_provider() {
    for compatible in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(
            dir.path(),
            Arc::new(Pending),
            Limits {
                max_active_turns: 1,
                ..Default::default()
            },
        )
        .unwrap();
        engine.task_modes.started.store(true, Ordering::Release);
        let scheduler = ScheduleConnection::new("scheduler", "owner");
        engine
            .register_schedule_host(scheduler.clone())
            .await
            .unwrap();
        engine
            .register_schedule_tools(
                TaskToolsReady {
                    bundles: vec![DesktopToolBundle::Browser, DesktopToolBundle::Computer],
                },
                ScheduleConnection::new("old-gui", "owner"),
            )
            .await
            .unwrap();
        let anchor = engine.create("/workspace".into()).await.unwrap();
        let occupied = engine.reserve_active_turn().unwrap();
        let task = engine.task_create("owner".into(), serde_json::from_value(json!({"requestId":"prepared", "mode":"scheduled", "objective":"inspect", "threadId":anchor.id,"schedule":{"at":now()-1}})).unwrap()).await.unwrap();
        let task_id = task["id"].as_str().unwrap();
        engine.advance_task(task_id).await.unwrap();
        let run = engine.task_read(task_id).await.unwrap().runs[0].clone();
        assert_eq!(run.status, RunStatus::Queued);
        assert!(run.goal_id.is_none());
        assert_eq!(scheduler.preparations.load(Ordering::Acquire), 1);
        engine.shutdown().await;
        drop(occupied);
        drop(engine);
        let engine = Engine::open(dir.path(), Arc::new(Pending), Limits::default()).unwrap();
        engine.task_modes.started.store(true, Ordering::Release);
        let scheduler = ScheduleConnection::new("new-scheduler", "owner");
        engine
            .register_schedule_host(scheduler.clone())
            .await
            .unwrap();
        let bundles = if compatible {
            vec![DesktopToolBundle::Browser, DesktopToolBundle::Computer]
        } else {
            vec![DesktopToolBundle::Browser]
        };
        engine
            .register_schedule_tools(
                TaskToolsReady { bundles },
                ScheduleConnection::new("new-gui", "owner"),
            )
            .await
            .unwrap();
        engine.advance_task(task_id).await.unwrap();
        let current = engine.task_read(task_id).await.unwrap();
        assert_eq!(current.runs[0].id, run.id);
        assert_eq!(current.runs[0].thread_id, run.thread_id);
        assert!(current.runs[0].goal_id.is_some());
        assert_eq!(scheduler.preparations.load(Ordering::Acquire), 0);
        let thread_id = run.thread_id.as_ref().unwrap();
        let thread = engine.read(thread_id, false).await.unwrap();
        assert_eq!(
            thread
                .dynamic_tools
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            ["browser_v1", "computer_v1"]
        );
        let cell = engine.cell(thread_id).await.unwrap();
        let bindings = cell.bindings.read().await;
        assert_eq!(
            bindings.host.as_ref().map(|host| host.id()),
            compatible.then_some("new-gui")
        );
        assert_eq!(
            bindings.schedule_host.as_ref().unwrap().id(),
            "new-scheduler"
        );
        drop(bindings);
        engine.shutdown().await;
    }
}

async fn schedule_conversation(engine: &Arc<Engine>, host: Arc<ScheduleConnection>) -> Thread {
    engine
        .create_configured(
            host.owner.into(),
            serde_json::from_value(json!({"requestId":host.id,"cwd":"/workspace"})).unwrap(),
            host,
        )
        .await
        .unwrap()
}

fn sourced_schedule(source: &Thread, anchor: &Thread) -> TaskCreate {
    serde_json::from_value(json!({
        "requestId":"sourced-schedule", "mode":"scheduled", "objective":"inspect",
        "sourceThreadId":source.id, "threadId":anchor.id, "schedule":{"at":now()+3600}
    }))
    .unwrap()
}

#[tokio::test]
async fn schedule_tool_uses_registered_scheduler_for_a_distinct_gui_connection() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(Pending), Limits::default()).unwrap();
    engine.task_modes.started.store(true, Ordering::Release);
    let gui = ScheduleConnection::new("gui", "owner");
    let scheduler = ScheduleConnection::new("scheduler", "owner");
    engine
        .register_schedule_host(scheduler.clone())
        .await
        .unwrap();
    let source = schedule_conversation(&engine, gui.clone()).await;
    let turn = engine
        .start(&source.id, vec![Input::text("schedule")])
        .await
        .unwrap();
    let cell = engine.cell(&source.id).await.unwrap();
    assert!(
        engine
            .schedule_tools_available(&cell, &Default::default(), &source)
            .await
    );
    let result = engine.scheduled_task_tool(&cell, &turn.id, "create", "scheduled_task_create", &json!({
        "objective":"inspect", "scheduleV2":{"version":1,"rule":{"kind":"once","at":now()+3600},"misfire":{"kind":"skip","maxLatenessSeconds":300},"overlap":"skip"}
    })).await;
    assert!(result.get("error").is_none(), "{result}");
    let task = engine
        .task_read(result["task"]["id"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(task.owner, "owner");
    assert_eq!(task.source_thread_id.as_deref(), Some(source.id.as_str()));
    assert_eq!(task.delivery, TaskDelivery::Thread);
    let anchor = engine
        .cell(task.thread_id.as_deref().unwrap())
        .await
        .unwrap();
    assert_eq!(
        anchor.bindings.read().await.host.as_ref().unwrap().id(),
        scheduler.id
    );
    assert_eq!(
        cell.bindings.read().await.host.as_ref().unwrap().id(),
        gui.id
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn sourced_schedule_denies_disconnected_and_foreign_principals() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(Pending), Limits::default()).unwrap();
    engine.task_modes.started.store(true, Ordering::Release);
    let gui = ScheduleConnection::new("gui", "owner");
    let scheduler = ScheduleConnection::new("scheduler", "owner");
    engine
        .register_schedule_host(scheduler.clone())
        .await
        .unwrap();
    let source = schedule_conversation(&engine, gui.clone()).await;
    let anchor = schedule_conversation(&engine, scheduler.clone()).await;
    let request = sourced_schedule(&source, &anchor);
    assert!(
        engine
            .validate_schedule_source("owner", &request)
            .await
            .is_ok()
    );
    assert!(
        engine
            .validate_schedule_source("foreign", &request)
            .await
            .is_err()
    );
    gui.closed.store(true, Ordering::Release);
    assert!(
        engine
            .validate_schedule_source("owner", &request)
            .await
            .is_err()
    );
    gui.closed.store(false, Ordering::Release);
    scheduler.closed.store(true, Ordering::Release);
    assert!(
        engine
            .validate_schedule_source("owner", &request)
            .await
            .is_err()
    );
    let replacement = ScheduleConnection::new("replacement", "owner");
    engine.register_schedule_host(replacement).await.unwrap();
    assert!(
        engine
            .validate_schedule_source("owner", &request)
            .await
            .is_err()
    );
    let foreign_host = ScheduleConnection::new("foreign", "foreign");
    engine
        .register_schedule_host(foreign_host.clone())
        .await
        .unwrap();
    let foreign = schedule_conversation(&engine, foreign_host).await;
    assert!(
        engine
            .validate_schedule_source("owner", &sourced_schedule(&foreign, &anchor))
            .await
            .is_err()
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn sourced_schedule_accepts_its_live_source_anchor_without_rebinding_it() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(Pending), Limits::default()).unwrap();
    engine.task_modes.started.store(true, Ordering::Release);
    let gui = ScheduleConnection::new("gui", "owner");
    let scheduler = ScheduleConnection::new("scheduler", "owner");
    engine.register_schedule_host(scheduler).await.unwrap();
    let source = schedule_conversation(&engine, gui.clone()).await;
    let anchor = engine
        .create_configured(
            "owner".into(),
            serde_json::from_value(json!({"requestId":"gui-anchor","cwd":"/workspace"})).unwrap(),
            gui.clone(),
        )
        .await
        .unwrap();
    let created = engine
        .task_create("owner".into(), sourced_schedule(&source, &anchor))
        .await
        .unwrap();
    assert_eq!(created["sourceThreadId"], source.id);
    assert_eq!(created["threadId"], anchor.id);
    assert_eq!(
        engine
            .cell(&anchor.id)
            .await
            .unwrap()
            .bindings
            .read()
            .await
            .host
            .as_ref()
            .unwrap()
            .id(),
        gui.id
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn sourced_schedule_does_not_take_over_a_live_foreign_anchor() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(Pending), Limits::default()).unwrap();
    engine.task_modes.started.store(true, Ordering::Release);
    let scheduler = ScheduleConnection::new("scheduler", "owner");
    engine.register_schedule_host(scheduler).await.unwrap();
    let source = schedule_conversation(&engine, ScheduleConnection::new("gui", "owner")).await;
    let foreign = ScheduleConnection::new("foreign", "foreign");
    let anchor = schedule_conversation(&engine, foreign.clone()).await;
    assert!(
        engine
            .task_create("owner".into(), sourced_schedule(&source, &anchor))
            .await
            .is_err()
    );
    assert!(engine.task_list_for_threads(None).await.unwrap().is_empty());
    assert_eq!(
        engine
            .cell(&anchor.id)
            .await
            .unwrap()
            .bindings
            .read()
            .await
            .host
            .as_ref()
            .unwrap()
            .id(),
        foreign.id
    );
    engine.shutdown().await;
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
    engine
        .register_schedule_tools(
            TaskToolsReady {
                bundles: vec![DesktopToolBundle::Browser],
            },
            ScheduleConnection::new("old-gui", "fixture"),
        )
        .await
        .unwrap();
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
        .register_schedule_tools(
            TaskToolsReady {
                bundles: vec![DesktopToolBundle::Browser],
            },
            ScheduleConnection::new("resumed-gui", "fixture"),
        )
        .await
        .unwrap();
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
    assert!(
        engine
            .cell(&thread_id)
            .await
            .unwrap()
            .bindings
            .read()
            .await
            .host
            .is_none()
    );
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
    assert_eq!(
        engine
            .cell(&thread_id)
            .await
            .unwrap()
            .bindings
            .read()
            .await
            .host
            .as_ref()
            .unwrap()
            .id(),
        "resumed-gui"
    );
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

#[tokio::test]
async fn bound_schedule_waits_for_its_conversation_and_runs_there_with_its_fixed_model() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(Pending), Limits::default()).unwrap();
    engine.task_modes.started.store(true, Ordering::Release);
    engine
        .install_configured_models(crate::desktop::ConfiguredModels {
            providers: vec![
                serde_json::from_value(json!({
                    "id":"arena","revision":0,"endpoint":"http://127.0.0.1:9",
                    "protocol":"responses","models":["terra"]
                }))
                .unwrap(),
            ],
            provider_ids: ["arena".to_owned()].into(),
            ..Default::default()
        })
        .unwrap();
    engine
        .register_schedule_host(Arc::new(Host {
            closed: AtomicBool::new(false),
        }))
        .await
        .unwrap();
    let conversation = engine.create("/workspace".into()).await.unwrap();
    let busy = engine
        .start(&conversation.id, vec![Input::text("busy")])
        .await
        .unwrap();
    let value = engine
        .task_create(
            "fixture".into(),
            serde_json::from_value(json!({
                "requestId":"bound", "mode":"scheduled", "objective":"inspect",
                "threadId":conversation.id, "delivery":"thread",
                "model":{"providerId":"arena","modelId":"terra"},
                "parameters":{"temperature":null,"maxOutputTokens":null,"reasoningEffort":"high"},
                "schedule":{"at":now()-100,"intervalSeconds":3600}
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    let id = value["id"].as_str().unwrap();
    engine.advance_task(id).await.unwrap();
    let run = engine.task_read(id).await.unwrap().runs[0].clone();
    assert_eq!(
        run.status,
        RunStatus::Queued,
        "busy conversation defers the run"
    );
    assert!(run.thread_id.is_none() && run.goal_id.is_none());

    engine.interrupt(&conversation.id, &busy.id).await.unwrap();
    engine.wait(&conversation.id).await.unwrap();
    engine.advance_task(id).await.unwrap();
    let run = engine.task_read(id).await.unwrap().runs[0].clone();
    assert_eq!(run.thread_id.as_deref(), Some(conversation.id.as_str()));
    let thread = engine.read(&conversation.id, true).await.unwrap();
    let turn = thread.turns.last().unwrap();
    assert_eq!(
        turn.goal.as_ref().map(|g| g.goal_id.as_str()),
        run.goal_id.as_deref()
    );
    let configuration = turn.configuration.as_ref().unwrap();
    assert_eq!(configuration.model.as_ref().unwrap().model_id, "terra");
    assert_eq!(
        configuration.parameters.reasoning_effort.as_deref(),
        Some("high")
    );
    let default = &thread.desktop.as_ref().unwrap().configuration;
    assert!(
        default.model.is_none(),
        "the fixed model applies to the run only"
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn archiving_a_bound_conversation_pauses_its_tasks() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(Pending), Limits::default()).unwrap();
    let conversation = engine.create("/workspace".into()).await.unwrap();
    let create = |request: &str, delivery: &str| {
        serde_json::from_value::<TaskCreate>(json!({
            "requestId":request, "mode":"scheduled", "objective":"inspect",
            "threadId":conversation.id, "delivery":delivery,
            "schedule":{"at":now()+3600}
        }))
        .unwrap()
    };
    let bound = engine
        .task_create("fixture".into(), create("bound", "thread"))
        .await
        .unwrap();
    let detached = engine
        .task_create("fixture".into(), create("detached", "newThread"))
        .await
        .unwrap();
    engine
        .archive_thread(conversation.id.clone())
        .await
        .unwrap();
    let paused = |value: &Value| value["id"].as_str().unwrap().to_owned();
    assert!(engine.task_read(&paused(&bound)).await.unwrap().paused);
    assert!(!engine.task_read(&paused(&detached)).await.unwrap().paused);
    engine.shutdown().await;
}
