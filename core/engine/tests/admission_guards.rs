//! Native admission contract, using real Engine persistence and a held model.
use areal_engine::{
    Engine, Error, Limits,
    model::{Message, Model, ModelStream},
};
use async_trait::async_trait;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::Arc;
struct Held;
#[async_trait]
impl Model for Held {
    fn name(&self) -> &str {
        "admission-guard-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        Ok(Box::pin(futures_util::stream::pending()))
    }
}
#[tokio::test]
async fn ordinary_start_checks_config_before_acceptance_and_replays_after_restart() {
    let root = tempfile::tempdir().unwrap();
    let engine = Engine::open(root.path(), Arc::new(Held), Limits::default()).unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    let revision = thread.desktop.as_ref().map_or_else(
        || areal_protocol::desktop::EffectiveConfig::default().revision,
        |d| d.configuration.revision,
    );
    let request = |revision, key| {
        serde_json::from_value(json!({"requestId":key,"threadId":thread.id,
        "input":[{"type":"text","text":"ordinary"}],
        "admissionGuard":{"configRevision":revision,"ordinarySession":true}}))
        .unwrap()
    };
    assert!(matches!(
        engine
            .start_durable("owner".into(), request(revision + 1, "stale"), false)
            .await,
        Err(Error::Conflict)
    ));
    assert!(
        engine
            .read(&thread.id, true)
            .await
            .unwrap()
            .turns
            .is_empty()
    );
    let accepted = engine
        .start_durable("owner".into(), request(revision, "once"), false)
        .await
        .unwrap();
    assert_eq!(
        engine
            .start_durable("owner".into(), request(revision, "once"), false)
            .await
            .unwrap(),
        accepted
    );
    engine.shutdown().await;
    drop(engine);
    let engine = Engine::open(root.path(), Arc::new(Held), Limits::default()).unwrap();
    assert_eq!(
        engine
            .start_durable("owner".into(), request(revision, "once"), false)
            .await
            .unwrap(),
        accepted
    );
    assert_eq!(engine.read(&thread.id, true).await.unwrap().turns.len(), 1);
    engine.shutdown().await;
}

#[tokio::test]
async fn ordinary_start_accepts_paused_empty_queue_without_resuming_queue() {
    let root = tempfile::tempdir().unwrap();
    let engine = Engine::open(root.path(), Arc::new(Held), Limits::default()).unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    let revision = areal_protocol::desktop::EffectiveConfig::default().revision;
    let queue = engine
        .edit_queue(thread.id.clone(), 0, "pause".into(), json!({}))
        .await
        .unwrap();
    assert!(queue.paused && queue.items.is_empty());
    let request = |config_revision, key| {
        serde_json::from_value(json!({
        "requestId":key,"threadId":thread.id,"input":[{"type":"text","text":"explicit new turn"}],
        "admissionGuard":{"configRevision":config_revision,"ordinarySession":true}
    })).unwrap()
    };
    assert!(matches!(
        engine
            .start_durable("owner".into(), request(revision + 1, "stale"), false)
            .await,
        Err(Error::Conflict)
    ));
    let accepted = engine
        .start_durable("owner".into(), request(revision, "once"), false)
        .await
        .unwrap();
    assert!(engine.queue(&thread.id).await.unwrap().paused);
    assert_eq!(
        engine
            .start_durable("owner".into(), request(revision, "once"), false)
            .await
            .unwrap(),
        accepted
    );
    assert_eq!(engine.read(&thread.id, true).await.unwrap().turns.len(), 1);
    engine.shutdown().await;
}

#[tokio::test]
async fn ordinary_start_still_rejects_pending_queue_while_paused() {
    let root = tempfile::tempdir().unwrap();
    let engine = Engine::open(root.path(), Arc::new(Held), Limits::default()).unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    engine
        .edit_queue(thread.id.clone(), 0, "pause".into(), json!({}))
        .await
        .unwrap();
    let request = |key, guard| {
        serde_json::from_value(json!({
        "requestId":key,"threadId":thread.id,"input":[{"type":"text","text":"retained queued message"}],
        "admissionGuard":guard
    })).unwrap()
    };
    engine
        .start_durable(
            "owner".into(),
            request("queued", serde_json::Value::Null),
            true,
        )
        .await
        .unwrap();
    let guard = json!({"configRevision":areal_protocol::desktop::EffectiveConfig::default().revision,"ordinarySession":true});
    assert!(matches!(
        engine
            .start_durable("owner".into(), request("explicit", guard), false)
            .await,
        Err(Error::Conflict)
    ));
    let queue = engine.queue(&thread.id).await.unwrap();
    assert!(queue.paused);
    assert_eq!(queue.items[0].status, "pending");
    assert!(
        engine
            .read(&thread.id, true)
            .await
            .unwrap()
            .turns
            .is_empty()
    );
    engine.shutdown().await;
}

struct Host;
#[async_trait]
impl areal_engine::tools::DynamicToolHost for Host {
    fn id(&self) -> &str {
        "guard-host"
    }
    fn is_closed(&self) -> bool {
        false
    }
    async fn call(
        &self,
        _: serde_json::Value,
        _: tokio_util::sync::CancellationToken,
    ) -> anyhow::Result<areal_protocol::DynamicToolResponse> {
        unreachable!()
    }
}
#[tokio::test]
async fn ordinary_creation_rejects_workflow_before_creating_thread() {
    let root = tempfile::tempdir().unwrap();
    let deployment = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(deployment.path(), serde_json::to_vec(&json!({
        "profiles":[{"id":"flow","revision":"v1","displayName":"Flow","instructions":"","workflow":{"id":"flow","revision":"v1"}}],
        "skills":[],"workflows":[{"id":"flow","revision":"v1","displayName":"Flow","plan":{"objective":"fixture","tasks":[{"id":"one","instruction":"run","writes":[]}]}}]
    })).unwrap()).unwrap();
    let engine = Engine::open(root.path(), Arc::new(Held), Limits::default()).unwrap();
    engine.install_deployment(deployment.path()).unwrap();
    let req = serde_json::from_value(json!({"requestId":"ordinary-create","agentProfile":{"id":"flow","revision":"v1"},"admissionGuard":{"ordinarySession":true}})).unwrap();
    let err = engine
        .create_configured("owner".into(), req, Arc::new(Host))
        .await
        .unwrap_err();
    assert!(
        matches!(err, Error::Invalid(ref message) if message.starts_with("UNSUPPORTED_PROFILE:")),
        "{err}"
    );
    assert!(engine.list(None, 100, None).await.unwrap().0.is_empty());
    let ordinary = serde_json::from_value(
        json!({"requestId":"ordinary-ok","admissionGuard":{"ordinarySession":true}}),
    )
    .unwrap();
    let thread = engine
        .create_configured("owner".into(), ordinary, Arc::new(Host))
        .await
        .unwrap();
    assert!(thread.turns.is_empty());
    engine.shutdown().await;
    drop(engine);
    let engine = Engine::open(root.path(), Arc::new(Held), Limits::default()).unwrap();
    let ordinary = serde_json::from_value(
        json!({"requestId":"ordinary-ok","admissionGuard":{"ordinarySession":true}}),
    )
    .unwrap();
    assert_eq!(
        engine
            .create_configured("owner".into(), ordinary, Arc::new(Host))
            .await
            .unwrap()
            .id,
        thread.id
    );
    assert_eq!(engine.list(None, 100, None).await.unwrap().0.len(), 1);
    engine.shutdown().await;
}

// Durable fixture images represent histories from a previous Core process. Assertions
// use public Engine operations; no production mutation or test-only hooks are added.
fn task_fixture(thread: &str, statuses: &[&str], workers: serde_json::Value) -> serde_json::Value {
    // 准入用例保留当前 Run 的会话预留；旧格式迁移会释放未开始的定时会话。
    json!({"version":3,"receipts":[],"tasks":{"task":{
        "id":"task","revision":7,"channelSequence":0,"owner":"owner","mode":"scheduled",
        "interactionMode":"headless","objective":"fixture","threadId":thread,
        "schedule":{"at":4102444800_i64,"intervalSeconds":null},"nextRunAt":4102444800_i64,
        "paused":true,"cancelled":false,"tokenBudget":null,"maxTurns":null,"maxActiveSeconds":null,
        "messages":[],"runs":statuses.iter().enumerate().map(|(i,status)|json!({
            "id":format!("run-{i}"),"threadId":thread,"goalId":null,"status":status,"reason":null,
            "scheduledAt":1,"completedAt":null,"usage":areal_protocol::goals::GoalUsage::default(),
            "waitRequested":false,"workers":workers
        })).collect::<Vec<_>>()
    }}})
}
fn write_tasks(root: &std::path::Path, value: &serde_json::Value) {
    std::fs::create_dir_all(root.join("desktop")).unwrap();
    std::fs::write(
        root.join("desktop/task-mode.json"),
        serde_json::to_vec(value).unwrap(),
    )
    .unwrap();
}
#[tokio::test]
async fn pause_targets_current_run_but_accepted_replay_survives_new_run_and_restart() {
    let root = tempfile::tempdir().unwrap();
    write_tasks(
        root.path(),
        &task_fixture("thread", &["completed", "paused"], json!([])),
    );
    let engine = Engine::open(root.path(), Arc::new(Held), Limits::default()).unwrap();
    let request = |key, run| {
        serde_json::from_value(
            json!({"requestId":key,"taskId":"task","expectedRevision":7,"expectedRunId":run}),
        )
        .unwrap()
    };
    assert!(matches!(
        engine
            .task_control("owner".into(), "pause".into(), request("late", "run-0"))
            .await,
        Err(Error::Conflict)
    ));
    assert_eq!(engine.task_read("task").await.unwrap().revision, 7);
    assert!(matches!(
        engine
            .task_control(
                "owner".into(),
                "resume".into(),
                request("unsupported", "run-1")
            )
            .await,
        Err(Error::Invalid(_))
    ));
    let accepted = engine
        .task_control("owner".into(), "pause".into(), request("once", "run-1"))
        .await
        .unwrap();
    assert_eq!(
        engine
            .task_control("owner".into(), "pause".into(), request("once", "run-1"))
            .await
            .unwrap(),
        accepted
    );
    assert!(matches!(
        engine
            .task_control("owner".into(), "pause".into(), request("once", "run-0"))
            .await,
        Err(Error::Conflict)
    ));
    engine.shutdown().await;
    drop(engine);
    let path = root.path().join("desktop/task-mode.json");
    let mut persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["version"], 6);
    let task_key = format!("{:x}", Sha256::digest(b"task"));
    let head = &mut persisted["tasks"][task_key];
    let ledger = root.path().join("desktop/task-ledger");
    let mut task: serde_json::Value = serde_json::from_slice(
        &std::fs::read(ledger.join(head["body"].as_str().unwrap())).unwrap(),
    )
    .unwrap();
    task["revision"] = json!(20);
    let mut next = task["runs"][1].clone();
    next["id"] = json!("run-2");
    task["runs"].as_array_mut().unwrap().push(next);
    let bytes = serde_json::to_vec(&task).unwrap();
    let digest = format!("{:x}", Sha256::digest(&bytes));
    // 只发布新不可变叶；保留根中的原始回执索引，验证跨新 Run 的受理重放。
    std::fs::write(ledger.join(&digest), &bytes).unwrap();
    head["body"] = json!(digest);
    head["hot_bytes"] = json!(bytes.len());
    head["settlement_limit"] = json!(
        head["settlement_limit"]
            .as_u64()
            .unwrap()
            .max(bytes.len() as u64)
    );
    write_tasks(root.path(), &persisted);
    let engine = Engine::open(root.path(), Arc::new(Held), Limits::default()).unwrap();
    assert_eq!(
        engine
            .task_control("owner".into(), "pause".into(), request("once", "run-1"))
            .await
            .unwrap(),
        accepted
    );
    assert_eq!(engine.task_read("task").await.unwrap().revision, 20);
    engine.shutdown().await;
}

#[tokio::test]
async fn ordinary_send_preserves_archive_and_paused_queue_barriers() {
    for archived in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let engine = Engine::open(root.path(), Arc::new(Held), Limits::default()).unwrap();
        let thread = engine.create("/workspace".into()).await.unwrap();
        if archived {
            engine.archive_thread(thread.id.clone()).await.unwrap();
        } else {
            engine
                .edit_queue(thread.id.clone(), 0, "pause".into(), json!({}))
                .await
                .unwrap();
            let queued = serde_json::from_value(json!({"requestId":"retained","threadId":thread.id,"input":[{"type":"text","text":"retain pending"}]})).unwrap();
            engine
                .start_durable("owner".into(), queued, true)
                .await
                .unwrap();
        }
        let request = serde_json::from_value(json!({"requestId":"guarded","threadId":thread.id,"input":[{"type":"text","text":"ordinary"}],"admissionGuard":{"ordinarySession":true,"configRevision":1}})).unwrap();
        let result = engine.start_durable("owner".into(), request, false).await;
        if archived {
            assert!(
                matches!(result,Err(Error::Invalid(ref reason)) if reason.starts_with("THREAD_ARCHIVED:"))
            );
        } else {
            assert!(matches!(result, Err(Error::Conflict)));
        }
        assert!(
            engine
                .read(&thread.id, true)
                .await
                .unwrap()
                .turns
                .is_empty()
        );
        engine.shutdown().await;
    }
}
#[tokio::test]
async fn ordinary_send_distinguishes_queued_and_unsettled_ownership_from_history() {
    for (status, unsettled, allowed) in [
        (None, false, true),
        (Some("queued"), false, false),
        (Some("paused"), false, true),
        (Some("blocked"), false, true),
        (Some("completed"), false, true),
        (Some("completed"), true, false),
    ] {
        let root = tempfile::tempdir().unwrap();
        let engine = Engine::open(root.path(), Arc::new(Held), Limits::default()).unwrap();
        let thread = engine.create("/workspace".into()).await.unwrap();
        engine.shutdown().await;
        drop(engine);
        let workers = if unsettled {
            json!([{"threadId":"worker","turnId":"worker-turn","status":"running","settled":false}])
        } else {
            json!([])
        };
        let mut fixture =
            task_fixture(&thread.id, &status.into_iter().collect::<Vec<_>>(), workers);
        fixture["tasks"]["task"]["threadId"] = json!("hidden-task-coordinator");
        write_tasks(root.path(), &fixture);
        let engine = Engine::open(root.path(), Arc::new(Held), Limits::default()).unwrap();
        let (_, ownership, _) = engine
            .snapshot_and_subscribe_with_ownership(&thread.id, None)
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(&ownership).unwrap(),
            if allowed {
                json!({"kind":"ordinary"})
            } else {
                json!({"kind":"task","taskId":"task","runId":"run-0"})
            }
        );
        let hidden = std::collections::BTreeSet::from([thread.id.clone()]);
        let (_, ownership, _) = engine
            .snapshot_and_subscribe_with_ownership(&thread.id, Some(&hidden))
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(&ownership).unwrap(),
            if allowed {
                json!({"kind":"ordinary"})
            } else {
                json!({"kind":"task"})
            }
        );
        let request = serde_json::from_value(json!({"requestId":"guarded","threadId":thread.id,"input":[{"type":"text","text":"ordinary"}],"admissionGuard":{"ordinarySession":true,"configRevision":1}})).unwrap();
        let result = engine.start_durable("owner".into(), request, false).await;
        assert_eq!(
            result.is_ok(),
            allowed,
            "status={status:?}, unsettled={unsettled}: {result:?}"
        );
        assert_eq!(
            engine.read(&thread.id, true).await.unwrap().turns.len(),
            usize::from(allowed)
        );
        engine.shutdown().await;
    }
}
#[test]
fn omitted_guard_serialization_preserves_legacy_receipt_inputs() {
    use areal_protocol::{
        desktop::{ThreadStart, TurnStart},
        tasks::TaskControl,
    };
    let thread: ThreadStart = serde_json::from_value(json!({"requestId":"create"})).unwrap();
    assert_eq!(
        serde_json::to_string(&thread).unwrap(),
        r#"{"requestId":"create","cwd":null,"agentProfile":null,"model":null,"parameters":{"temperature":null,"maxOutputTokens":null,"reasoningEffort":null},"dynamicTools":[]}"#
    );
    let turn: TurnStart =
        serde_json::from_value(json!({"requestId":"start","threadId":"thread","input":[]}))
            .unwrap();
    assert_eq!(
        serde_json::to_string(&turn).unwrap(),
        r#"{"interactionMode":null,"requestId":"start","threadId":"thread","input":[],"expectedConfigRevision":null}"#
    );
    let pause: TaskControl =
        serde_json::from_value(json!({"requestId":"pause","taskId":"task","expectedRevision":7}))
            .unwrap();
    assert_eq!(
        serde_json::to_string(&pause).unwrap(),
        r#"{"requestId":"pause","taskId":"task","expectedRevision":7}"#
    );
}

#[tokio::test]
async fn observe_reports_goal_and_child_ownership_and_masks_hidden_task_identifiers() {
    let root = tempfile::tempdir().unwrap();
    let engine = Engine::open(root.path(), Arc::new(Held), Limits::default()).unwrap();
    let parent = engine.create("/workspace".into()).await.unwrap();
    engine
        .start(
            &parent.id,
            vec![serde_json::from_value(json!({"type":"text","text":"parent"})).unwrap()],
        )
        .await
        .unwrap();
    let (child, _) = engine
        .spawn_child(
            &parent.id,
            vec![areal_protocol::Input::Text {
                text: "child".into(),
                text_elements: vec![],
                mcp_content: None,
                review_comments: None,
            }],
        )
        .await
        .unwrap();
    let (_, ownership, _) = engine
        .snapshot_and_subscribe_with_ownership(&child.id, None)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(ownership).unwrap(),
        json!({"kind":"task"})
    );
    let goal_thread = engine.create("/workspace".into()).await.unwrap();
    engine
        .goal_create(
            "owner".into(),
            serde_json::from_value(json!({
                "requestId":"goal", "threadId":goal_thread.id, "expectedRevision":0,
                "objective":"held goal", "maxTurns":2
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    let (_, ownership, _) = engine
        .snapshot_and_subscribe_with_ownership(&goal_thread.id, None)
        .await
        .unwrap();
    let ownership = serde_json::to_value(ownership).unwrap();
    assert_eq!(ownership["kind"], "task");
    assert!(ownership["taskId"].is_string());
    assert!(ownership["runId"].is_string());
    let (_, hidden, _) = engine
        .snapshot_and_subscribe_with_ownership(
            &goal_thread.id,
            Some(&std::collections::BTreeSet::new()),
        )
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(hidden).unwrap(),
        json!({"kind":"task"})
    );
    let request = serde_json::from_value(json!({"requestId":"ordinary-goal","threadId":goal_thread.id,"input":[{"type":"text","text":"ordinary"}],"admissionGuard":{"ordinarySession":true,"configRevision":1}})).unwrap();
    assert!(matches!(
        engine.start_durable("owner".into(), request, false).await,
        Err(Error::Conflict)
    ));
    engine.shutdown().await;
}

#[tokio::test]
async fn observe_prefers_current_goal_run_over_other_queued_task_in_both_id_orders() {
    for active_task in ["z-task", "a-task"] {
        let root = tempfile::tempdir().unwrap();
        let engine = Engine::open(root.path(), Arc::new(Held), Limits::default()).unwrap();
        let thread = engine.create("/workspace".into()).await.unwrap();
        engine.shutdown().await;
        drop(engine);
        let mut snapshot = task_fixture(&thread.id, &["queued"], json!([]));
        let template = snapshot["tasks"]["task"].clone();
        snapshot["tasks"] = json!({});
        for task_id in ["a-task", "z-task"] {
            let mut task = template.clone();
            task["id"] = json!(task_id);
            task["mode"] = json!("foreground");
            task["schedule"] = json!(null);
            task["nextRunAt"] = json!(null);
            task["paused"] = json!(false);
            task["runs"][0]["id"] = json!(format!("run-{task_id}"));
            snapshot["tasks"][task_id] = task;
        }
        write_tasks(root.path(), &snapshot);
        let engine = Engine::open(root.path(), Arc::new(Held), Limits::default()).unwrap();
        let (_, ambiguous, _) = engine
            .snapshot_and_subscribe_with_ownership(&thread.id, None)
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(ambiguous).unwrap(),
            json!({"kind":"task"})
        );
        let request = serde_json::from_value(json!({"requestId":"ambiguous-ordinary","threadId":thread.id,"input":[{"type":"text","text":"ordinary"}],"admissionGuard":{"ordinarySession":true,"configRevision":1}})).unwrap();
        assert!(matches!(
            engine.start_durable("owner".into(), request, false).await,
            Err(Error::Conflict)
        ));
        let active_run = format!("run-{active_task}");
        let goal = engine
            .goal_create(
                "owner".into(),
                serde_json::from_value(json!({
                    "requestId":format!("task-run-{active_run}"), "threadId":thread.id,
                    "expectedRevision":0,"objective":"hold selected task", "maxTurns":2
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(goal["taskId"], active_task);
        assert_eq!(
            engine.task_read(active_task).await.unwrap().runs[0].status,
            areal_protocol::tasks::RunStatus::Running
        );
        let queued_task = if active_task == "a-task" {
            "z-task"
        } else {
            "a-task"
        };
        assert_eq!(
            engine.task_read(queued_task).await.unwrap().runs[0].status,
            areal_protocol::tasks::RunStatus::Queued
        );
        let (_, ownership, _) = engine
            .snapshot_and_subscribe_with_ownership(&thread.id, None)
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(ownership).unwrap(),
            json!({"kind":"task","taskId":active_task,"runId":active_run})
        );
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn guarded_interrupt_rejects_task_reservation_before_queue_mutation() {
    let root = tempfile::tempdir().unwrap();
    let engine = Engine::open(root.path(), Arc::new(Held), Limits::default()).unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    engine.shutdown().await;
    drop(engine);
    write_tasks(
        root.path(),
        &task_fixture(&thread.id, &["queued"], json!([])),
    );
    let engine = Engine::open(root.path(), Arc::new(Held), Limits::default()).unwrap();
    let turn = engine
        .start(
            &thread.id,
            vec![
                serde_json::from_value(json!({"type":"text","text":"legacy local turn"})).unwrap(),
            ],
        )
        .await
        .unwrap();
    let before = serde_json::to_value(engine.queue(&thread.id).await.unwrap()).unwrap();
    assert!(matches!(
        engine
            .interrupt_guarded(
                &thread.id,
                &turn.id,
                Some(areal_protocol::desktop::TurnInterruptAdmissionGuard {
                    ordinary_session: true
                })
            )
            .await,
        Err(Error::Conflict)
    ));
    assert_eq!(
        serde_json::to_value(engine.queue(&thread.id).await.unwrap()).unwrap(),
        before
    );
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_millis(50),
            engine.wait(&thread.id)
        )
        .await
        .is_err()
    );
    engine.shutdown().await;
}
