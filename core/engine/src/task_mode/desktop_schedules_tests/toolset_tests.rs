use super::*;

async fn set(engine: &Arc<Engine>, id: &str, host: Arc<ScheduleConnection>) -> Result<()> {
    engine
        .set_thread_tools(
            serde_json::from_value(json!({
                "threadId":id,"expectedToolsetRevision":0,
                "dynamicTools":[{"name":"lookup","description":"Look up a value","inputSchema":{"type":"object"}}]
            }))
            .unwrap(),
            host,
        )
        .await
        .map(|_| ())
}

#[tokio::test]
async fn background_creation_and_toolset_replacement_cannot_both_commit() {
    let root = tempfile::tempdir().unwrap();
    let engine = Engine::open(root.path(), Arc::new(Pending), Limits::default()).unwrap();
    engine.task_modes.started.store(true, Ordering::Release);
    let thread = engine.create("/workspace".into()).await.unwrap();
    let cell = engine.raw_cell(&thread.id).await.unwrap();
    let held = cell.state.lock().await;
    let request = serde_json::from_value(json!({
        "requestId":"background-binding","mode":"background","objective":"inspect","threadId":thread.id,
    })).unwrap();
    let admission = tokio::spawn({
        let engine = engine.clone();
        async move { engine.task_create("owner".into(), request).await }
    });
    // 当前线程执行器在后台创建真正进入准入、等待指定 Thread 时交回控制。
    while engine.desktop.lifecycle.gate.try_lock().is_ok() {
        tokio::task::yield_now().await;
    }
    let tasks = engine.task_modes.state.lock().await;
    drop(held);
    tokio::task::yield_now().await;
    let replacing = tokio::spawn({
        let engine = engine.clone();
        let id = thread.id.clone();
        async move { set(&engine, &id, ScheduleConnection::new("tools", "owner")).await }
    });
    tokio::task::yield_now().await;
    drop(tasks);
    let created = admission.await.unwrap().unwrap();
    assert!(matches!(replacing.await.unwrap(), Err(Error::Conflict)));
    let task = engine
        .task_read(created["id"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(task.runs[0].thread_id.as_ref(), Some(&thread.id));
    assert!(
        engine
            .read(&thread.id, false)
            .await
            .unwrap()
            .dynamic_tools
            .is_empty()
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn paused_background_run_keeps_its_toolset_across_restart() {
    let root = tempfile::tempdir().unwrap();
    let engine = Engine::open(root.path(), Arc::new(Pending), Limits::default()).unwrap();
    engine.task_modes.started.store(true, Ordering::Release);
    let thread = engine.create("/workspace".into()).await.unwrap();
    let task = engine
        .task_create(
            "owner".into(),
            serde_json::from_value(json!({
                "requestId":"detach","mode":"background","objective":"inspect","threadId":thread.id,
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    let task_id = task["id"].as_str().unwrap();
    engine.advance_task(task_id).await.unwrap();
    assert!(
        engine.task_read(task_id).await.unwrap().runs[0]
            .goal_id
            .is_some()
    );
    engine.shutdown().await;
    drop(engine);
    let engine = Engine::open(root.path(), Arc::new(Pending), Limits::default()).unwrap();
    let run = &engine.task_read(task_id).await.unwrap().runs[0];
    assert_eq!(run.status, RunStatus::Paused);
    assert!(matches!(
        set(
            &engine,
            &thread.id,
            ScheduleConnection::new("reconnected", "owner")
        )
        .await,
        Err(Error::Conflict)
    ));
    assert!(
        engine
            .read(&thread.id, false)
            .await
            .unwrap()
            .dynamic_tools
            .is_empty()
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn settled_bound_schedule_releases_toolset_but_dedicated_run_keeps_its_own() {
    let root = tempfile::tempdir().unwrap();
    let engine = Engine::open(
        root.path(),
        Arc::new(Complete(AtomicUsize::new(0))),
        Limits::default(),
    )
    .unwrap();
    engine.task_modes.started.store(true, Ordering::Release);
    let scheduler = ScheduleConnection::new("scheduler", "owner");
    engine
        .register_schedule_host(scheduler.clone())
        .await
        .unwrap();
    let tools = ScheduleConnection::new("tools", "owner");
    let initial: areal_protocol::ToolDefinition = serde_json::from_value(json!({
        "name":"original","description":"Original tool","inputSchema":{"type":"object"}
    }))
    .unwrap();
    let conversation = engine
        .create_with_tools("/workspace".into(), vec![initial.clone()], tools.clone())
        .await
        .unwrap();
    let mut dedicated = String::new();
    for delivery in ["thread", "newThread"] {
        let value = engine.task_create("owner".into(),serde_json::from_value(json!({
            "requestId":delivery,"mode":"scheduled","objective":"inspect","threadId":conversation.id,
            "delivery":delivery,"schedule":{"at":now()-1},
        })).unwrap()).await.unwrap();
        let id = value["id"].as_str().unwrap();
        engine.admit_schedule_due(id, true, now()).await.unwrap();
        let queued = engine.task_read(id).await.unwrap();
        assert_eq!(queued.runs[0].status, RunStatus::Queued);
        assert!(queued.runs[0].thread_id.is_none());
        if delivery == "thread" {
            assert!(matches!(
                set(&engine, &conversation.id, tools.clone()).await,
                Err(Error::Conflict)
            ));
        }
        engine.advance_task(id).await.unwrap();
        let run = engine.task_read(id).await.unwrap().runs[0].clone();
        let target = run.thread_id.as_deref().unwrap();
        engine.wait(target).await.unwrap();
        engine.advance_task(id).await.unwrap();
        assert_eq!(
            engine.task_read(id).await.unwrap().runs[0].status,
            RunStatus::Completed
        );
        if delivery == "thread" {
            assert_eq!(target, conversation.id);
            assert!(
                engine
                    .read(target, false)
                    .await
                    .unwrap()
                    .goals
                    .goal
                    .is_none()
            );
            let (_, mut events) = engine.snapshot_and_subscribe(target).await.unwrap();
            let unchanged = engine
                .set_thread_tools(
                    serde_json::from_value(json!({
                        "threadId": target, "expectedToolsetRevision":0,"dynamicTools":[initial]
                    }))
                    .unwrap(),
                    tools.clone(),
                )
                .await
                .unwrap();
            assert_eq!(unchanged.toolset_revision, 0);
            assert!(matches!(
                events.try_recv(),
                Err(tokio::sync::broadcast::error::TryRecvError::Empty)
            ));
            tools.closed.store(true, Ordering::Release);
            assert!(matches!(
                engine.start(target, vec![Input::text("follow up")]).await,
                Err(Error::ToolHostUnavailable)
            ));
            let successor = ScheduleConnection::new("successor", "owner");
            engine
                .bind_tool_host(target, successor.clone())
                .await
                .unwrap();
            set(&engine, target, successor).await.unwrap();
            assert_eq!(
                engine.read(target, false).await.unwrap().dynamic_tools[0].name,
                "lookup"
            );
        } else {
            assert_ne!(target, conversation.id);
            assert!(matches!(
                set(&engine, target, scheduler.clone()).await,
                Err(Error::Conflict)
            ));
            dedicated = target.to_owned();
        }
    }
    engine.shutdown().await;
    drop(engine);
    let engine = Engine::open(root.path(), Arc::new(Pending), Limits::default()).unwrap();
    assert!(matches!(
        set(
            &engine,
            &dedicated,
            ScheduleConnection::new("restored-tools", "owner")
        )
        .await,
        Err(Error::Conflict)
    ));
    assert!(
        engine
            .read(&dedicated, false)
            .await
            .unwrap()
            .dynamic_tools
            .is_empty()
    );
    engine.shutdown().await;
}
