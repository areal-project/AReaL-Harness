use anyhow::Result;
use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelEvent, ModelStream, ToolCall},
    workgroup::{
        self,
        service::*,
        tree::{self, File, Tree},
        *,
    },
};
use areal_protocol::{Input, Item, TurnStatus};
use async_trait::async_trait;
use serde_json::Value;
use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

fn task(id: &str, deps: &[&str]) -> Task {
    Task {
        configuration: None,
        id: id.into(),
        instruction: format!("Implement {id}"),
        writes: vec![id.into()],
        depends: deps.iter().map(|d| (*d).into()).collect(),
        integration_depends: vec![],
        checks: vec![],
    }
}
fn plan(tasks: Vec<Task>) -> Plan {
    Plan {
        objective: "independent work".into(),
        tasks,
    }
}
fn request(key: &str, tasks: Vec<Task>) -> Start {
    Start {
        request_id: key.into(),
        plan: plan(tasks),
        workers: Some(2),
        admission: Admission::Auto,
    }
}
fn policy() -> Policy {
    Policy {
        allowed_directories: vec![],
        allowed_writes: vec!["a".into(), "b".into(), "c".into()],
        checks: vec![vec!["final".into()]],
        workers: 2,
        verifiers: 1,
        active_groups: 4,
        timeout_seconds: 10,
        command_timeout_ms: 300_000,
        max_model_requests: 64,
    }
}
async fn bounded<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(8), future)
        .await
        .unwrap()
}
struct Fixture {
    started: Semaphore,
    release: Semaphore,
    active: AtomicUsize,
    peak: AtomicUsize,
    events: Mutex<Vec<String>>,
    model: Option<Arc<dyn Model>>,
    held: Option<String>,
    hold_gate: Semaphore,
    cancel_barrier: Option<tokio::sync::Barrier>,
}
impl Fixture {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            started: Semaphore::new(0),
            release: Semaphore::new(0),
            active: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
            events: Mutex::new(vec![]),
            model: None,
            held: None,
            hold_gate: Semaphore::new(0),
            cancel_barrier: None,
        })
    }
}
struct FactoryImpl(Arc<Fixture>);
impl Factory for FactoryImpl {
    fn executor(&self, _: &Path, _: &Policy) -> Result<Arc<dyn Executor>> {
        Ok(self.0.clone())
    }
}
#[async_trait]
impl Executor for Fixture {
    async fn attempt(
        &self,
        task: Task,
        _: u32,
        mut base: Tree,
        _: Option<Tree>,
        _: String,
        cancel: CancellationToken,
    ) -> Result<Tree> {
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak.fetch_max(active, Ordering::SeqCst);
        self.events.lock().unwrap().push(task.instruction.clone());
        self.started.add_permits(1);
        if let Some(model) = &self.model {
            use futures_util::StreamExt;
            let mut stream = model.stream(vec![Message::text("user", "worker")]).await?;
            while let Some(event) = stream.next().await {
                event?;
            }
        }
        let gate = if self.held.as_deref() == Some(task.id.as_str()) {
            &self.hold_gate
        } else {
            &self.release
        };
        tokio::select! {_=cancel.cancelled()=>{},p=gate.acquire()=>{p.unwrap().forget();}}
        if cancel.is_cancelled()
            && let Some(barrier) = &self.cancel_barrier
        {
            barrier.wait().await;
        }
        self.active.fetch_sub(1, Ordering::SeqCst);
        anyhow::ensure!(!cancel.is_cancelled(), "cancelled after cleanup");
        base.insert(
            task.writes[0].clone(),
            File {
                bytes: task.instruction.into_bytes(),
                executable: false,
            },
        );
        Ok(base)
    }
    async fn verify(&self, tree: Tree, _: Vec<Vec<String>>, _: CancellationToken) -> Result<Check> {
        Ok(Check {
            tree_hash: tree::digest(&tree),
            passed: true,
            output: "passed".into(),
        })
    }
}
async fn settled(service: &Service, id: &str) -> Value {
    bounded(async {
        loop {
            let v = service.read(id, None).await.unwrap();
            if v["record"]["status"] != "running" {
                return v;
            }
            service
                .wait(
                    id,
                    None,
                    v["record"]["revision"].as_u64().unwrap(),
                    Duration::from_secs(1),
                )
                .await
                .unwrap();
        }
    })
    .await
}

#[tokio::test]
async fn cancellation_reaches_all_owned_groups_before_waiting_for_cleanup() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    std::fs::create_dir(&source).unwrap();
    let mut fixture = Fixture::new();
    Arc::get_mut(&mut fixture).unwrap().cancel_barrier = Some(tokio::sync::Barrier::new(2));
    let service = Service::open(
        &temp.path().join("groups"),
        &source,
        policy(),
        Arc::new(FactoryImpl(fixture.clone())),
    )
    .unwrap();
    for id in ["a", "b"] {
        service
            .start(
                "parent".into(),
                request(id, vec![task(id, &[])]),
                CancellationToken::new(),
            )
            .await
            .unwrap();
    }
    bounded(fixture.started.acquire_many(2))
        .await
        .unwrap()
        .forget();
    // Each cleanup requires both cancellations to arrive. Serial cancel+join
    // would block the second group until its deadline instead of cancelling it.
    let results = bounded(service.settle_owner("parent", true)).await.unwrap();
    assert_eq!(results.len(), 2);
    assert!(
        results.iter().all(
            |r| r["record"]["status"] == "cancelled" && r["record"]["cleanupConfirmed"] == true
        )
    );
    assert_eq!(fixture.active.load(Ordering::SeqCst), 0);
    service.shutdown().await;
}

#[tokio::test]
async fn restart_ignores_incomplete_creation_without_an_intent_but_rejects_corrupt_intents() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let root = temp.path().join("groups");
    std::fs::create_dir(&source).unwrap();
    std::fs::create_dir_all(root.join("empty")).unwrap();
    std::fs::create_dir(root.join("only-lock")).unwrap();
    std::fs::write(root.join("only-lock/owner.lock"), "").unwrap();
    let fixture = Fixture::new();
    let service = Service::open(
        &root,
        &source,
        policy(),
        Arc::new(FactoryImpl(fixture.clone())),
    )
    .unwrap();
    assert_eq!(service.list().await, serde_json::json!([]));
    service.shutdown().await;
    drop(service);
    std::fs::write(root.join("empty/request.json"), "invalid intent").unwrap();
    assert!(Service::open(&root, &source, policy(), Arc::new(FactoryImpl(fixture))).is_err());
}

#[tokio::test]
async fn omitted_worker_count_respects_a_serial_deployment() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    std::fs::create_dir(&source).unwrap();
    let fixture = Fixture::new();
    let mut policy = policy();
    policy.workers = 1;
    let service = Service::open(
        &temp.path().join("groups"),
        &source,
        policy,
        Arc::new(FactoryImpl(fixture.clone())),
    )
    .unwrap();
    let mut request = request("serial", vec![task("a", &[])]);
    assert!(
        service
            .start("client".into(), request.clone(), CancellationToken::new())
            .await
            .is_err()
    );
    request.workers = None;
    let request = serde_json::from_value(serde_json::to_value(request).unwrap()).unwrap();
    let started = service
        .start("client".into(), request, CancellationToken::new())
        .await
        .unwrap();
    bounded(fixture.started.acquire()).await.unwrap().forget();
    fixture.release.add_permits(1);
    let done = settled(&service, started["id"].as_str().unwrap()).await;
    assert_eq!(done["record"]["status"], "completed");
    assert_eq!(done["record"]["admission"]["maxWorkers"], 1);
    assert_eq!(fixture.peak.load(Ordering::SeqCst), 1);
    service.shutdown().await;
}

#[tokio::test]
async fn shared_worker_cap_idempotency_cursor_cancel_and_restart_projection() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    std::fs::create_dir(&source).unwrap();
    let fixture = Fixture::new();
    let root = temp.path().join("groups");
    let service = Service::open(
        &root,
        &source,
        policy(),
        Arc::new(FactoryImpl(fixture.clone())),
    )
    .unwrap();
    let req = request("once", vec![task("a", &[]), task("b", &[])]);
    let a = service
        .start("client".into(), req.clone(), CancellationToken::new())
        .await
        .unwrap();
    let aid = a["id"].as_str().unwrap();
    bounded(fixture.started.acquire_many(2))
        .await
        .unwrap()
        .forget();
    let retry = service
        .start("client".into(), req.clone(), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(retry["id"], a["id"]);
    let mut bad = req;
    bad.workers = Some(1);
    assert!(
        service
            .start("client".into(), bad, CancellationToken::new())
            .await
            .is_err()
    );
    let b = service
        .start(
            "client".into(),
            request("second", vec![task("c", &[])]),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(fixture.peak.load(Ordering::SeqCst), 2);
    assert!(service.read(aid, Some("other-owner")).await.is_err());
    service.cancel(aid, None).await.unwrap();
    let a = settled(&service, aid).await;
    assert_eq!(a["record"]["status"], "cancelled");
    assert_eq!(a["record"]["cleanupConfirmed"], true);
    bounded(fixture.started.acquire()).await.unwrap().forget();
    fixture.release.add_permits(1);
    let bid = b["id"].as_str().unwrap();
    let b = settled(&service, bid).await;
    assert_eq!(b["record"]["status"], "completed");
    let paths = service.artifact(bid, None, None, 0).await.unwrap();
    assert_eq!(paths["paths"][0], "c");
    let content = service
        .artifact(bid, None, Some("c".into()), 0)
        .await
        .unwrap();
    assert_eq!(content["text"], "Implement c");
    assert!(content["baseSha256"].is_null());
    assert!(
        service
            .artifact(bid, None, Some("../escape".into()), 0)
            .await
            .is_err()
    );
    assert!(fixture.peak.load(Ordering::SeqCst) <= 2);
    service.shutdown().await;
    drop(service);
    let recovered = Service::open(
        &root,
        &source,
        policy(),
        Arc::new(FactoryImpl(fixture.clone())),
    )
    .unwrap();
    assert_eq!(
        recovered.read(bid, None).await.unwrap()["record"]["head"],
        b["record"]["head"]
    );
    assert_eq!(fixture.active.load(Ordering::SeqCst), 0);
    recovered.shutdown().await;
}

#[tokio::test]
async fn live_plan_revisions_are_cas_idempotent_and_cannot_change_running_contracts() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    std::fs::create_dir(&source).unwrap();
    let fixture = Fixture::new();
    let service = Service::open(
        &temp.path().join("groups"),
        &source,
        policy(),
        Arc::new(FactoryImpl(fixture.clone())),
    )
    .unwrap();
    let original = vec![task("a", &[]), task("b", &["a"])];
    let started = service
        .start(
            "client".into(),
            request("revise", original.clone()),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let id = started["id"].as_str().unwrap();
    bounded(fixture.started.acquire()).await.unwrap().forget();
    let mut tasks = original.clone();
    tasks[1].instruction = "Use agreed interface v2".into();
    let changed = service
        .revise(id, None, "change".into(), 0, plan(tasks.clone()))
        .await
        .unwrap();
    assert_eq!(changed["record"]["planRevision"], 1);
    assert!(
        service
            .revise(id, None, "change".into(), 0, plan(tasks.clone()))
            .await
            .is_ok()
    );
    assert!(
        service
            .revise(id, None, "stale".into(), 0, plan(tasks.clone()))
            .await
            .is_err()
    );
    tasks[0].instruction = "silently change active task".into();
    assert!(
        service
            .revise(id, None, "active".into(), 1, plan(tasks))
            .await
            .is_err()
    );
    fixture.release.add_permits(1);
    bounded(fixture.started.acquire()).await.unwrap().forget();
    fixture.release.add_permits(1);
    assert_eq!(settled(&service, id).await["record"]["status"], "completed");
    assert!(
        fixture
            .events
            .lock()
            .unwrap()
            .contains(&"Use agreed interface v2".into())
    );
    service.shutdown().await;
}

struct ParentModel {
    calls: AtomicUsize,
    steering: bool,
    observed_steer: Semaphore,
}
#[async_trait]
impl Model for ParentModel {
    fn name(&self) -> &str {
        "coordination-fixture"
    }
    async fn stream(&self, messages: Vec<Message>) -> Result<ModelStream> {
        self.chat(messages, vec![]).await
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> Result<ModelStream> {
        if messages.last().unwrap().text_content() == "worker" {
            return Ok(Box::pin(futures_util::stream::iter([Ok(
                ModelEvent::TextDelta("done".into()),
            )])));
        }
        let n = self.calls.fetch_add(1, Ordering::SeqCst);
        assert!(
            tools
                .iter()
                .any(|t| t["function"]["name"] == "workgroup_start")
        );
        let event = if n == 0 {
            ModelEvent::ToolCall(ToolCall {
                id: "start-group".into(),
                name: "workgroup_start".into(),
                arguments: serde_json::to_string(&request(
                    "model",
                    vec![task("a", &[]), task("b", &[])],
                ))
                .unwrap(),
            })
        } else {
            if self.steering && n == 2 {
                assert!(
                    messages
                        .iter()
                        .any(|m| m.role == "user" && m.text_content() == "adjust the plan")
                );
                self.observed_steer.add_permits(1);
            } else if n == 2 || (self.steering && n == 3) {
                assert!(
                    messages
                        .iter()
                        .any(|m| m.text_content().contains("cleanupConfirmed\":true"))
                );
            }
            ModelEvent::TextDelta("summary".into())
        };
        Ok(Box::pin(futures_util::stream::iter([Ok(event)])))
    }
}

#[tokio::test]
async fn parent_automatically_joins_and_summarizes_without_holding_the_only_model_permit() {
    parent_join(false).await;
}

#[tokio::test]
async fn parent_receives_steering_while_joining_live_workgroups() {
    parent_join(true).await;
}

async fn parent_join(steering: bool) {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    std::fs::create_dir(&source).unwrap();
    let inner = Arc::new(ParentModel {
        calls: AtomicUsize::new(0),
        steering,
        observed_steer: Semaphore::new(0),
    });
    let pool = workgroup::native::SharedModel::pool(inner.clone(), 1).unwrap();
    let mut fixture = Fixture::new();
    Arc::get_mut(&mut fixture).unwrap().model = Some(pool.clone());
    if !steering {
        fixture.release.add_permits(2);
    }
    let engine = Engine::open(
        &temp.path().join("engine"),
        pool.clone(),
        Limits {
            model_concurrency: 1,
            ..Limits::default()
        },
    )
    .unwrap();
    let service = Service::open(
        &temp.path().join("groups"),
        &source,
        policy(),
        Arc::new(FactoryImpl(fixture.clone())),
    )
    .unwrap();
    engine.attach_workgroups(service.clone()).unwrap();
    let thread = engine
        .create(source.to_string_lossy().into_owned())
        .await
        .unwrap();
    let turn = engine
        .start(&thread.id, vec![Input::text("implement")])
        .await
        .unwrap();
    if steering {
        bounded(async {
            while inner.calls.load(Ordering::SeqCst) != 2 || pool.load().unwrap().in_flight != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await;
        // The workers stay blocked: a steer must wake the joining parent without
        // waiting for their completion or cancelling their owned work.
        tokio::time::sleep(Duration::from_millis(20)).await;
        engine
            .steer(&thread.id, &turn.id, vec![Input::text("adjust the plan")])
            .await
            .unwrap();
        bounded(inner.observed_steer.acquire())
            .await
            .unwrap()
            .forget();
        assert_eq!(fixture.active.load(Ordering::SeqCst), 2);
        fixture.release.add_permits(2);
    }
    let result = bounded(engine.wait(&thread.id)).await.unwrap();
    assert_eq!(
        result.turns[0].status,
        TurnStatus::Completed,
        "{:?}",
        result.turns[0].error
    );
    assert_eq!(
        inner.calls.load(Ordering::SeqCst),
        if steering { 4 } else { 3 }
    );
    assert_eq!(fixture.active.load(Ordering::SeqCst), 0);
    let journal = result.turns[0]
        .items
        .iter()
        .find_map(|i| {
            if let Item::DynamicToolCall { execution, .. } = i {
                Some(execution)
            } else {
                None
            }
        })
        .unwrap();
    assert_eq!(journal.backend.as_deref(), Some("coordination"));
    assert!(journal.runtime_epoch.is_empty() && journal.scope_id.is_empty());
    engine.shutdown().await;
}

#[tokio::test]
async fn integration_only_edges_allow_early_execution_but_gate_publication() {
    let temp = tempfile::tempdir().unwrap();
    let mut fixture = Fixture::new();
    Arc::get_mut(&mut fixture).unwrap().held = Some("a".into());
    let mut consumer = task("b", &[]);
    consumer.integration_depends = vec!["a".into()];
    let group = Workgroup::create(
        &temp.path().join("group"),
        plan(vec![consumer, task("a", &[])]),
        &Tree::new(),
        Strategy::Contract,
    )
    .unwrap();
    let control = group.control();
    let handle = tokio::spawn(group.run(
        Tree::new(),
        fixture.clone(),
        vec![vec!["final".into()]],
        Options {
            strategy: Strategy::Contract,
            ..Options::default()
        },
        CancellationToken::new(),
    ));
    bounded(fixture.started.acquire_many(2))
        .await
        .unwrap()
        .forget();
    // Finish the consumer while its provider is still executing.
    fixture.release.add_permits(1);
    bounded(async {
        loop {
            let r = control.read();
            if r.tasks[0].status == TaskStatus::Submitted {
                assert_eq!(r.tasks[1].status, TaskStatus::Running);
                break;
            }
            control.wait(r.revision, Duration::from_secs(1)).await;
        }
    })
    .await;
    fixture.hold_gate.add_permits(1);
    let record = bounded(handle).await.unwrap().unwrap();
    assert_eq!(record.status, "completed");
    assert_eq!(record.peak_workers, 2);
    assert_eq!(
        record
            .history
            .iter()
            .find(|a| a.task == "b")
            .unwrap()
            .check
            .as_ref()
            .unwrap()
            .tree_hash,
        record.head
    );
}

struct BatchFixture {
    gate: Semaphore,
    first: Semaphore,
    checks: AtomicUsize,
    repairs: AtomicUsize,
    rejected: std::sync::atomic::AtomicBool,
}
#[async_trait]
impl Executor for BatchFixture {
    async fn attempt(
        &self,
        task: Task,
        generation: u32,
        mut base: Tree,
        _: Option<Tree>,
        _: String,
        _: CancellationToken,
    ) -> Result<Tree> {
        if generation > 1 {
            self.repairs.fetch_add(1, Ordering::SeqCst);
        }
        base.insert(
            task.writes[0].clone(),
            File {
                bytes: task.id.into_bytes(),
                executable: false,
            },
        );
        Ok(base)
    }
    async fn verify(
        &self,
        tree: Tree,
        commands: Vec<Vec<String>>,
        _: CancellationToken,
    ) -> Result<Check> {
        let n = self.checks.fetch_add(1, Ordering::SeqCst);
        if n == 0 {
            self.first.add_permits(1);
            self.gate.acquire().await.unwrap().forget();
        }
        let is_batch = commands.len() > 1;
        let passed = !is_batch || self.rejected.swap(true, Ordering::SeqCst);
        Ok(Check {
            tree_hash: tree::digest(&tree),
            passed,
            output: "fixture interaction".into(),
        })
    }
}

#[tokio::test]
async fn failed_verification_batch_splits_without_reexecuting_correct_workers() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = Arc::new(BatchFixture {
        gate: Semaphore::new(0),
        first: Semaphore::new(0),
        checks: AtomicUsize::new(0),
        repairs: AtomicUsize::new(0),
        rejected: std::sync::atomic::AtomicBool::new(false),
    });
    let tasks = (0..4)
        .map(|i| {
            let mut t = task(&format!("t{i}"), &[]);
            t.checks = vec![vec![t.id.clone()]];
            t
        })
        .collect();
    let group = Workgroup::create(
        &temp.path().join("group"),
        plan(tasks),
        &Tree::new(),
        Strategy::Contract,
    )
    .unwrap();
    let control = group.control();
    let handle = tokio::spawn(group.run(
        Tree::new(),
        fixture.clone(),
        vec![vec!["final".into()]],
        Options {
            workers: 4,
            strategy: Strategy::Contract,
            ..Options::default()
        },
        CancellationToken::new(),
    ));
    bounded(fixture.first.acquire()).await.unwrap().forget();
    bounded(async {
        loop {
            let r = control.read();
            if r.tasks
                .iter()
                .filter(|t| t.status == TaskStatus::Submitted)
                .count()
                == 3
            {
                break;
            }
            control.wait(r.revision, Duration::from_secs(1)).await;
        }
    })
    .await;
    fixture.gate.add_permits(1);
    let record = bounded(handle).await.unwrap().unwrap();
    assert_eq!(record.status, "completed");
    assert_eq!(record.attempts, 4);
    assert_eq!(record.repairs, 0);
    assert_eq!(fixture.repairs.load(Ordering::SeqCst), 0);
    assert!(fixture.rejected.load(Ordering::SeqCst));
    assert!(
        record
            .verifications
            .iter()
            .any(|v| v.members.len() > 1 && !v.check.passed)
    );
}

#[tokio::test]
async fn speculative_consumers_cannot_fill_the_auto_window_and_starve_their_provider() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = Fixture::new();
    fixture.release.add_permits(3);
    let mut b = task("b", &[]);
    b.integration_depends = vec!["a".into()];
    let mut c = task("c", &[]);
    c.integration_depends = vec!["a".into()];
    let group = Workgroup::create(
        &temp.path().join("group"),
        plan(vec![b, c, task("a", &[])]),
        &Tree::new(),
        Strategy::Contract,
    )
    .unwrap();
    let record = bounded(group.run(
        Tree::new(),
        fixture.clone(),
        vec![vec!["final".into()]],
        Options {
            workers: 1,
            admission: Admission::Auto,
            strategy: Strategy::Contract,
            ..Options::default()
        },
        CancellationToken::new(),
    ))
    .await
    .unwrap();
    assert_eq!(record.status, "completed", "{:?}", record.error);
    assert_eq!(fixture.events.lock().unwrap()[0], "Implement a");
}

struct Uncertain {
    calls: AtomicUsize,
    entered: tokio::sync::Barrier,
}
struct UncertainFactory(Arc<Uncertain>);
impl Factory for UncertainFactory {
    fn executor(&self, _: &Path, _: &Policy) -> Result<Arc<dyn Executor>> {
        Ok(self.0.clone())
    }
}
#[async_trait]
impl Executor for Uncertain {
    async fn attempt(
        &self,
        _: Task,
        _: u32,
        _: Tree,
        _: Option<Tree>,
        _: String,
        _: CancellationToken,
    ) -> Result<Tree> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.wait().await;
        Err(CleanupFailure::Worker.into())
    }
    async fn verify(&self, _: Tree, _: Vec<Vec<String>>, _: CancellationToken) -> Result<Check> {
        unreachable!()
    }
}
#[tokio::test]
async fn uncertain_cleanup_quarantines_shared_worker_slots_instead_of_oversubscribing() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    std::fs::create_dir(&source).unwrap();
    let fixture = Arc::new(Uncertain {
        calls: AtomicUsize::new(0),
        entered: tokio::sync::Barrier::new(2),
    });
    let service = Service::open(
        &temp.path().join("groups"),
        &source,
        policy(),
        Arc::new(UncertainFactory(fixture.clone())),
    )
    .unwrap();
    let first = service
        .start(
            "client".into(),
            request("uncertain", vec![task("a", &[]), task("b", &[])]),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let outcome = settled(&service, first["id"].as_str().unwrap()).await;
    assert_eq!(outcome["record"]["cleanupConfirmed"], false);
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 2);
    let next = service
        .start(
            "client".into(),
            request("next", vec![task("c", &[])]),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let id = next["id"].as_str().unwrap();
    bounded(async {
        loop {
            let current = service.read(id, None).await.unwrap();
            if current["record"]["tasks"][0]["status"] == "running" {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    service.cancel(id, None).await.unwrap();
    assert_eq!(settled(&service, id).await["record"]["status"], "cancelled");
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 2);
    service.shutdown().await;
}
