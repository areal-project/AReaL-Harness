use anyhow::Result;
use areal_engine::workgroup::{
    self, Check, Executor, Options, Plan, Strategy, Task, Workgroup,
    tree::{self, File, Tree},
};
use async_trait::async_trait;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

fn task(id: &str, file: &str, deps: &[&str]) -> Task {
    Task {
        configuration: None,
        id: id.into(),
        instruction: format!("Implement {id}"),
        writes: vec![file.into()],
        depends: deps.iter().map(|s| (*s).into()).collect(),
        integration_depends: vec![],
        checks: vec![],
    }
}
fn plan(tasks: Vec<Task>) -> Plan {
    Plan {
        objective: "Implement all contracts".into(),
        tasks,
    }
}
fn checks() -> Vec<Vec<String>> {
    vec![vec!["final".into()]]
}
fn source(text: &str) -> File {
    File {
        bytes: text.as_bytes().to_vec(),
        executable: false,
    }
}

struct RecoveryFixture {
    mode: &'static str,
    seeds: Mutex<Vec<Tree>>,
}

struct DrainFixture {
    mode: &'static str,
    entered: tokio::sync::Notify,
    settled: AtomicBool,
}

#[async_trait]
impl Executor for DrainFixture {
    async fn attempt(
        &self,
        task: Task,
        _: u32,
        mut base: Tree,
        _: Option<Tree>,
        _: String,
        cancel: CancellationToken,
    ) -> Result<Tree> {
        if task.id == "first" {
            self.entered.notified().await;
            anyhow::bail!("earlier root failure");
        }
        if task.id == "slow" {
            cancel.cancelled().await;
            tokio::time::sleep(Duration::from_millis(20)).await;
            self.settled.store(true, Ordering::SeqCst);
            anyhow::bail!("cancelled after cleanup");
        }
        if self.mode == "verification" {
            base.insert(task.writes[0].clone(), source("candidate"));
            return Ok(base);
        }
        self.entered.notify_one();
        cancel.cancelled().await;
        if self.mode == "panic" {
            panic!("injected cleanup panic");
        }
        Err(workgroup::CleanupFailure::Worker.into())
    }
    async fn verify(
        &self,
        _: Tree,
        _: Vec<Vec<String>>,
        cancel: CancellationToken,
    ) -> Result<Check> {
        self.entered.notify_one();
        cancel.cancelled().await;
        Err(workgroup::CleanupFailure::Verification.into())
    }
}

#[tokio::test]
async fn drain_keeps_late_cleanup_failures_and_panics_without_skipping_other_owned_jobs() {
    for mode in ["worker", "verification", "panic"] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("group");
        let mut late = task("late", "late", &[]);
        late.checks = checks();
        let group = Workgroup::create(
            &root,
            plan(vec![
                task("first", "first", &[]),
                late,
                task("slow", "slow", &[]),
            ]),
            &Tree::new(),
            Strategy::Contract,
        )
        .unwrap();
        let executor = Arc::new(DrainFixture {
            mode,
            entered: tokio::sync::Notify::new(),
            settled: AtomicBool::new(false),
        });
        let record = group
            .run(
                Tree::new(),
                executor.clone(),
                checks(),
                Options {
                    workers: 3,
                    strategy: Strategy::Contract,
                    ..Default::default()
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(record.status, "failed");
        assert_eq!(record.error.as_deref(), Some("earlier root failure"));
        assert_eq!(record.cleanup_confirmed, Some(false));
        assert!(record.cleanup_error.is_some());
        assert!(executor.settled.load(Ordering::SeqCst));
        assert_eq!(
            Workgroup::inspect(&root).unwrap().cleanup_confirmed,
            Some(false)
        );
    }
}

#[async_trait]
impl Executor for RecoveryFixture {
    fn model_load(&self) -> Option<areal_engine::model::ModelLoad> {
        Some(areal_engine::model::ModelLoad {
            capacity: 3,
            ..Default::default()
        })
    }
    async fn attempt(
        &self,
        task: Task,
        generation: u32,
        mut base: Tree,
        seed: Option<Tree>,
        _: String,
        _: CancellationToken,
    ) -> Result<Tree> {
        if let Some(seed) = seed {
            self.seeds.lock().unwrap().push(seed.clone());
            base = seed;
        }
        if task.id != "a" || generation > 1 {
            if task.id == "peer" {
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
            base.insert(task.writes[0].clone(), source("complete"));
            return Ok(base);
        }
        if self.mode == "unknown" {
            anyhow::bail!("tool outcome UNKNOWN");
        }
        if self.mode != "unchanged" {
            let file = if self.mode == "scope" {
                "outside"
            } else {
                &task.writes[0]
            };
            base.insert(
                file.into(),
                source(if self.mode == "partial" {
                    "partial"
                } else {
                    "complete"
                }),
            );
        }
        Err(workgroup::AttemptCheckpoint {
            artifact: base,
            failure: areal_engine::model::ModelFailure::Truncated,
        }
        .into())
    }
    async fn verify(
        &self,
        candidate: Tree,
        _: Vec<Vec<String>>,
        _: CancellationToken,
    ) -> Result<Check> {
        Ok(Check {
            tree_hash: tree::digest(&candidate),
            passed: candidate.values().all(|f| f.bytes == b"complete"),
            output: "unfinished source".into(),
        })
    }
}

#[tokio::test]
async fn inference_checkpoints_require_acceptance_or_a_bounded_seeded_retry() {
    for (mode, local_check, repairs, status, generations) in [
        ("partial", true, 1, "completed", 2),
        ("complete", true, 1, "completed", 1),
        ("complete", false, 1, "completed", 2),
        ("unchanged", true, 1, "completed", 2),
        ("partial", true, 0, "failed", 1),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("group");
        let mut a = task("a", "a", &[]);
        if local_check {
            a.checks = checks();
        }
        let group = Workgroup::create(
            &root,
            plan(vec![
                a,
                task("peer", "peer", &[]),
                task("child", "child", &["a"]),
                task("grandchild", "grandchild", &["child"]),
            ]),
            &Tree::new(),
            Strategy::Contract,
        )
        .unwrap();
        let executor = Arc::new(RecoveryFixture {
            mode,
            seeds: Mutex::new(vec![]),
        });
        let record = group
            .run(
                Tree::new(),
                executor.clone(),
                checks(),
                Options {
                    repairs,
                    strategy: Strategy::Contract,
                    ..Default::default()
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(record.status, status, "{mode}: {:?}", record.error);
        assert_eq!(record.cleanup_confirmed, Some(true));
        assert_eq!(record.tasks[0].generation, generations);
        assert!(record.history[0].checkpoint.is_some());
        assert_eq!(record.tasks[1].status, workgroup::TaskStatus::Integrated);
        if status == "failed" {
            assert_eq!(record.tasks[0].status, workgroup::TaskStatus::Failed);
            assert_eq!(record.tasks[2].status, workgroup::TaskStatus::Blocked);
            assert_eq!(record.tasks[3].status, workgroup::TaskStatus::Blocked);
            assert_eq!(tree::snapshot(&root.join("candidate")).unwrap().len(), 1);
            assert!(record.final_check.is_none());
        }
        if generations == 2 && mode != "unchanged" {
            let seeds = executor.seeds.lock().unwrap();
            assert_eq!(seeds.len(), 1);
            assert!(seeds[0].contains_key("a"));
        }
        assert_eq!(Workgroup::inspect(&root).unwrap().version, 3);
    }
}

#[tokio::test]
async fn checkpoints_never_recover_unknown_tools_or_out_of_scope_writes() {
    for mode in ["unknown", "scope"] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("group");
        let mut a = task("a", "a", &[]);
        a.checks = checks();
        let group =
            Workgroup::create(&root, plan(vec![a]), &Tree::new(), Strategy::Contract).unwrap();
        let record = group
            .run(
                Tree::new(),
                Arc::new(RecoveryFixture {
                    mode,
                    seeds: Mutex::new(vec![]),
                }),
                checks(),
                Options {
                    strategy: Strategy::Contract,
                    ..Default::default()
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(record.status, "failed");
        assert_eq!(record.attempts, 1);
        assert!(tree::snapshot(&root.join("candidate")).unwrap().is_empty());
        assert!(record.final_check.is_none());
    }
}

#[tokio::test]
async fn adaptive_cold_start_uses_ready_width_and_model_capacity() {
    for (width, expected) in [(1, 1), (8, 3)] {
        let temp = tempfile::tempdir().unwrap();
        let tasks = (0..width)
            .map(|i| task(&format!("t{i}"), &format!("f{i}"), &[]))
            .collect();
        let group = Workgroup::create(
            &temp.path().join("group"),
            plan(tasks),
            &Tree::new(),
            Strategy::Contract,
        )
        .unwrap();
        let record = group
            .run(
                Tree::new(),
                Arc::new(RecoveryFixture {
                    mode: "complete",
                    seeds: Mutex::new(vec![]),
                }),
                checks(),
                Options {
                    strategy: Strategy::Contract,
                    workers: 8,
                    admission: workgroup::Admission::Adaptive,
                    initial_workers: 0,
                    ..Default::default()
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(record.status, "completed");
        assert_eq!(record.admission.initial_workers, expected);
        assert_eq!(record.peak_workers, expected);
    }
}

#[tokio::test]
async fn version_one_records_remain_readable_without_new_checkpoint_fields() {
    let (temp, _) = run(
        vec![task("a", "a", &[])],
        Arc::new(Fixture::default()),
        1,
        Duration::from_secs(2),
    )
    .await;
    let root = temp.path().join("group");
    let path = root.join("run.json");
    let mut record: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    record["version"] = serde_json::json!(1);
    record.as_object_mut().unwrap().remove("admission");
    record.as_object_mut().unwrap().remove("cleanupConfirmed");
    record.as_object_mut().unwrap().remove("cleanupError");
    for attempt in record["history"].as_array_mut().unwrap() {
        attempt.as_object_mut().unwrap().remove("checkpoint");
    }
    std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    let read = Workgroup::inspect(&root).unwrap();
    assert_eq!(read.status, "completed");
    assert!(read.history[0].checkpoint.is_none());
    assert!(read.cleanup_confirmed.is_none());
    record["version"] = serde_json::json!(4);
    std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    assert!(Workgroup::inspect(&root).is_err());
}

struct PlannerFixture(String);
#[async_trait]
impl areal_engine::model::Model for PlannerFixture {
    fn name(&self) -> &str {
        "planner-fixture"
    }
    async fn stream(
        &self,
        _: Vec<areal_engine::model::Message>,
    ) -> Result<areal_engine::model::ModelStream> {
        Ok(Box::pin(futures_util::stream::iter([Ok(
            areal_engine::model::ModelEvent::text(self.0.clone()),
        )])))
    }
}

#[tokio::test]
async fn planner_task_count_is_independent_of_worker_width_and_scope_remains_bounded() {
    for count in [9, workgroup::MAX_TASKS, workgroup::MAX_TASKS + 1] {
        let tasks: Vec<_> = (0..count)
            .map(|n| task(&format!("t{n}"), &format!("f{n}"), &[]))
            .collect();
        let allowed: Vec<_> = tasks.iter().flat_map(|t| t.writes.clone()).collect();
        let model = PlannerFixture(serde_json::to_string(&plan(tasks)).unwrap());
        let proposed =
            workgroup::native::propose(&model, "trusted objective", &Tree::new(), &allowed).await;
        if count <= workgroup::MAX_TASKS {
            let proposed = proposed.unwrap();
            assert_eq!(proposed.tasks.len(), count);
            assert_eq!(proposed.objective, "trusted objective");
            assert!(
                workgroup::native::propose(
                    &model,
                    "trusted objective",
                    &Tree::new(),
                    &allowed[..1]
                )
                .await
                .is_err()
            );
        } else {
            assert!(proposed.is_err());
        }
    }
}

#[derive(Default)]
struct Fixture {
    active: AtomicUsize,
    peak: AtomicUsize,
    events: Mutex<Vec<String>>,
    cleaned: AtomicBool,
    reject_once: AtomicBool,
    reject_final_once: AtomicBool,
    reject_final_always: bool,
    corrupt_receipt: bool,
    forbidden: bool,
    hold_final: bool,
    hold_worker: bool,
    overlap_gate: bool,
    verification_started: tokio::sync::Notify,
    third_started: tokio::sync::Notify,
}
#[async_trait]
impl Executor for Fixture {
    async fn attempt(
        &self,
        task: Task,
        generation: u32,
        mut base: Tree,
        seed: Option<Tree>,
        _: String,
        cancel: CancellationToken,
    ) -> Result<Tree> {
        if let Some(seed) = seed {
            self.events
                .lock()
                .unwrap()
                .push(format!("seed:{}:{generation}", task.id));
            base = seed;
        }
        self.events
            .lock()
            .unwrap()
            .push(format!("start:{}:{generation}", task.id));
        if self.overlap_gate && task.id == "c" {
            self.verification_started.notified().await;
            self.third_started.notify_one();
        }
        for dep in &task.depends {
            assert!(
                base.values()
                    .any(|f| String::from_utf8_lossy(&f.bytes).contains(dep))
            );
        }
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak.fetch_max(active, Ordering::SeqCst);
        if self.hold_worker {
            cancel.cancelled().await;
            tokio::time::sleep(Duration::from_millis(30)).await;
            self.cleaned.store(true, Ordering::SeqCst);
        } else {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        self.active.fetch_sub(1, Ordering::SeqCst);
        let key = if self.forbidden {
            "outside"
        } else {
            &task.writes[0]
        };
        let before = base
            .get(key)
            .map(|f| String::from_utf8_lossy(&f.bytes).into_owned())
            .unwrap_or_default();
        base.insert(key.into(), source(&format!("{before} {}", task.id)));
        self.events
            .lock()
            .unwrap()
            .push(format!("end:{}:{generation}", task.id));
        Ok(base)
    }
    async fn verify(
        &self,
        candidate: Tree,
        commands: Vec<Vec<String>>,
        cancel: CancellationToken,
    ) -> Result<Check> {
        if self.overlap_gate && commands == vec![vec!["barrier".to_owned()]] {
            self.verification_started.notify_one();
            self.third_started.notified().await;
        }
        if self.hold_final && !commands.is_empty() {
            cancel.cancelled().await;
            tokio::time::sleep(Duration::from_millis(30)).await;
            self.cleaned.store(true, Ordering::SeqCst);
            anyhow::bail!("cancelled after cleanup");
        }
        Ok(Check {
            tree_hash: if self.corrupt_receipt {
                "wrong".into()
            } else {
                tree::digest(&candidate)
            },
            passed: !self.reject_once.swap(false, Ordering::SeqCst)
                && (commands.is_empty()
                    || (!self.reject_final_always
                        && !self.reject_final_once.swap(false, Ordering::SeqCst))),
            output: "fixture gate".into(),
        })
    }
}
async fn run(
    tasks: Vec<Task>,
    fixture: Arc<Fixture>,
    repairs: u32,
    timeout: Duration,
) -> (tempfile::TempDir, workgroup::Record) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("group");
    let base = Tree::new();
    let group = Workgroup::create(&root, plan(tasks), &base, Strategy::Contract).unwrap();
    let record = tokio::time::timeout(
        Duration::from_secs(5),
        group.run(
            base,
            fixture,
            checks(),
            Options {
                workers: 2,
                repairs,
                timeout,
                strategy: Strategy::Contract,
                integration_repair: true,
                admission: workgroup::Admission::Fixed,
                initial_workers: 2,
                verification_batch: 4,
            },
            CancellationToken::new(),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    (temp, record)
}

#[tokio::test]
async fn independent_tasks_overlap_dependencies_use_integrated_head_and_artifacts_survive() {
    let fixture = Arc::new(Fixture::default());
    let (temp, record) = run(
        vec![
            task("a", "a.py", &[]),
            task("b", "b.py", &[]),
            task("c", "c.py", &["a", "b"]),
        ],
        fixture.clone(),
        1,
        Duration::from_secs(3),
    )
    .await;
    assert_eq!(record.status, "completed");
    assert_eq!(fixture.peak.load(Ordering::SeqCst), 2);
    let events = fixture.events.lock().unwrap();
    assert!(
        events.iter().position(|e| e == "start:c:1") > events.iter().position(|e| e == "end:b:1")
    );
    let root = temp.path().join("group");
    let durable = Workgroup::inspect(&root).unwrap();
    assert_eq!(
        tree::snapshot(&root.join("candidate")).unwrap(),
        tree::load(&root, &durable.head).unwrap()
    );
    assert_eq!(durable.tasks.len(), 3);
}

#[tokio::test]
async fn verification_does_not_block_dispatch_of_an_independent_worker() {
    let mut first = task("a", "a.py", &[]);
    first.checks = vec![vec!["barrier".into()]];
    let (_, record) = run(
        vec![first, task("b", "b.py", &[]), task("c", "c.py", &[])],
        Arc::new(Fixture {
            overlap_gate: true,
            ..Fixture::default()
        }),
        1,
        Duration::from_secs(3),
    )
    .await;
    assert_eq!(record.status, "completed");
    assert_eq!(record.attempts, 3);
}

#[tokio::test]
async fn overlapping_writer_waits_through_integration_and_preserves_accepted_change() {
    let (temp, record) = run(
        vec![task("a", "shared.py", &[]), task("b", "shared.py", &[])],
        Arc::new(Fixture::default()),
        1,
        Duration::from_secs(3),
    )
    .await;
    assert_eq!(record.status, "completed");
    assert_eq!(record.conflicts, 0);
    assert_eq!(record.repairs, 0);
    assert_eq!(record.attempts, 2);
    assert_eq!(record.peak_workers, 1);
    let text = std::fs::read_to_string(temp.path().join("group/candidate/shared.py")).unwrap();
    assert!(text.contains('a') && text.contains('b'));
    let base = Tree::from([("shared.py".into(), source("base"))]);
    let head = Tree::from([("shared.py".into(), source("accepted"))]);
    let stale = Tree::from([("shared.py".into(), source("stale"))]);
    assert!(tree::compose(&head, &base, &stale, &["shared.py".into()]).is_err());
}

#[tokio::test]
async fn concrete_final_failure_allows_one_bounded_integration_task_and_keeps_both_receipts() {
    let (_, record) = run(
        vec![task("a", "a.py", &[])],
        Arc::new(Fixture {
            reject_final_once: AtomicBool::new(true),
            ..Fixture::default()
        }),
        1,
        Duration::from_secs(3),
    )
    .await;
    assert_eq!(record.status, "completed");
    assert_eq!(record.tasks.len(), 2);
    assert_eq!(record.tasks[1].spec.writes, vec!["a.py"]);
    assert_eq!(record.tasks[1].spec.depends, vec!["a"]);
    assert_eq!(record.final_checks.len(), 2);
    assert!(!record.final_checks[0].passed && record.final_checks[1].passed);
    let (_, record) = run(
        vec![task("a", "a.py", &[])],
        Arc::new(Fixture {
            reject_final_always: true,
            ..Fixture::default()
        }),
        0,
        Duration::from_secs(3),
    )
    .await;
    assert_eq!(record.status, "failed");
    assert_eq!(record.tasks.len(), 2);
    assert_eq!(record.attempts, 2);
}

#[tokio::test]
async fn bad_gate_retries_owner_but_scope_and_receipt_violations_fail_closed() {
    let (temp, record) = run(
        vec![task("a", "a.py", &[])],
        Arc::new(Fixture {
            reject_once: AtomicBool::new(true),
            ..Fixture::default()
        }),
        1,
        Duration::from_secs(3),
    )
    .await;
    assert_eq!(record.status, "completed");
    assert_eq!(record.attempts, 2);
    let root = temp.path().join("group");
    assert!(record.history[0].seed.is_none());
    let retry = &record.history[1];
    let seed = tree::load(
        &root,
        retry
            .seed
            .as_ref()
            .expect("repair must retain previous edits"),
    )
    .unwrap();
    assert_eq!(seed["a.py"], source(" a"));
    assert_eq!(
        tree::load(&root, &retry.base).unwrap(),
        Tree::new(),
        "failed edits must not be accepted as the new base"
    );
    assert_eq!(
        tree::load(&root, &record.head).unwrap()["a.py"],
        source(" a a")
    );
    assert!(Workgroup::inspect(&root).is_ok());
    for fixture in [
        Fixture {
            forbidden: true,
            ..Fixture::default()
        },
        Fixture {
            corrupt_receipt: true,
            ..Fixture::default()
        },
    ] {
        let (_, record) = run(
            vec![task("a", "a.py", &[])],
            Arc::new(fixture),
            1,
            Duration::from_secs(3),
        )
        .await;
        assert_eq!(record.status, "failed");
        assert_eq!(record.head, tree::digest(&Tree::new()));
        assert!(record.final_check.is_none());
    }
}

#[tokio::test(start_paused = true)]
async fn worker_and_final_gate_deadlines_wait_for_resource_cleanup() {
    for fixture in [
        Fixture {
            hold_worker: true,
            ..Fixture::default()
        },
        Fixture {
            hold_final: true,
            ..Fixture::default()
        },
    ] {
        let fixture = Arc::new(fixture);
        let (_, record) = run(
            vec![task("a", "a.py", &[])],
            fixture.clone(),
            1,
            Duration::from_millis(80),
        )
        .await;
        assert_eq!(record.status, "failed");
        assert!(fixture.cleaned.load(Ordering::SeqCst));
        assert!(record.final_check.is_none());
    }
}

#[test]
fn claims_have_single_owner_crashes_are_unknown_and_corruption_is_detected() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("group");
    let base = Tree::from([("source".into(), source("before"))]);
    let group = Workgroup::create(
        &root,
        plan(vec![task("a", "source", &[])]),
        &base,
        Strategy::Contract,
    )
    .unwrap();
    assert!(Workgroup::inspect(&root).is_err());
    assert!(
        Workgroup::create(
            &root,
            plan(vec![task("a", "source", &[])]),
            &base,
            Strategy::Contract
        )
        .is_err()
    );
    drop(group);
    assert_eq!(Workgroup::inspect(&root).unwrap().status, "unknown");
    let blob = std::fs::read_dir(root.join("blobs"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    std::fs::write(blob, b"corrupt").unwrap();
    assert!(Workgroup::inspect(&root).is_err());
}

#[tokio::test]
async fn dropping_the_caller_does_not_drop_the_owner_or_its_cleanup_barrier() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("group");
    let base = Tree::new();
    let group = Workgroup::create(
        &root,
        plan(vec![task("a", "a.py", &[])]),
        &base,
        Strategy::Contract,
    )
    .unwrap();
    let fixture = Arc::new(Fixture {
        hold_worker: true,
        ..Fixture::default()
    });
    let stop = CancellationToken::new();
    let caller = tokio::spawn(group.run(
        base,
        fixture.clone(),
        checks(),
        Options {
            strategy: Strategy::Contract,
            timeout: Duration::from_secs(3),
            ..Options::default()
        },
        stop.clone(),
    ));
    tokio::time::timeout(Duration::from_secs(2), async {
        while fixture.active.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    assert!(!stop.is_cancelled());
    assert_eq!(fixture.active.load(Ordering::SeqCst), 1);
    let running: workgroup::Record =
        serde_json::from_slice(&std::fs::read(root.join("run.json")).unwrap()).unwrap();
    assert_eq!(
        running.peak_workers, 1,
        "dispatch accounting must be durable before a worker finishes"
    );
    assert!(
        Workgroup::inspect(&root).is_err(),
        "the Core owner must retain its lock"
    );
    stop.cancel();
    let record = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Ok(record) = Workgroup::inspect(&root) {
                break record;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(record.status, "cancelled");
    assert!(fixture.cleaned.load(Ordering::SeqCst));
    assert_eq!(fixture.active.load(Ordering::SeqCst), 0);
}

#[test]
fn materialization_preserves_source_and_refuses_filesystem_alias_collisions() {
    let temp = tempfile::tempdir().unwrap();
    let tree = Tree::from([(
        "script".into(),
        File {
            bytes: b"echo ok\n".to_vec(),
            executable: true,
        },
    )]);
    tree::materialize(&tree, &temp.path().join("valid")).unwrap();
    assert_eq!(tree::snapshot(&temp.path().join("valid")).unwrap(), tree);
    std::fs::write(temp.path().join("A"), b"probe").unwrap();
    if temp.path().join("a").exists() {
        let aliases = Tree::from([
            ("a".into(), source("first")),
            ("A".into(), source("second")),
        ]);
        assert!(tree::materialize(&aliases, &temp.path().join("aliases")).is_err());
    }
}

#[test]
fn balanced_packing_preserves_independent_branches_and_contracts_serial_boundaries() {
    let mut base = Tree::new();
    for name in ["a", "b", "c", "d"] {
        base.insert(name.into(), source(&"x".repeat(8000)));
    }
    // Two substantial independent chains: they must stay parallel, but each
    // chain can be handled in one context without delaying any other task.
    let original = plan(vec![
        task("a", "a", &[]),
        task("b", "b", &["a"]),
        task("c", "c", &[]),
        task("d", "d", &["c"]),
    ]);
    let packed =
        workgroup::packing::prepare(original.clone(), &base, Strategy::Balanced, &checks(), 2)
            .unwrap();
    assert_eq!(packed.tasks.len(), 2);
    assert!(
        packed
            .tasks
            .iter()
            .all(|t| t.depends.is_empty() && t.writes.len() == 2)
    );
    let serial =
        workgroup::packing::prepare(original.clone(), &base, Strategy::Balanced, &checks(), 1)
            .unwrap();
    assert_eq!(serial.tasks.len(), 1);
    let tiny_source: Tree = ["a", "b", "c", "d"]
        .into_iter()
        .map(|p| (p.into(), source("stub")))
        .collect();
    let tiny = workgroup::packing::prepare(
        original.clone(),
        &tiny_source,
        Strategy::Balanced,
        &checks(),
        4,
    )
    .unwrap();
    assert_eq!(tiny.tasks.len(), 1);
    let unknown =
        workgroup::packing::prepare(original, &Tree::new(), Strategy::Balanced, &checks(), 2)
            .unwrap();
    assert_eq!(
        unknown.tasks.len(),
        2,
        "absent source is unknown work, not zero work"
    );
    // Fan-out may not be contracted into one child and delay its sibling.
    let branched = plan(vec![
        task("a", "a", &[]),
        task("b", "b", &["a"]),
        task("c", "c", &["a"]),
        task("d", "d", &["b", "c"]),
    ]);
    let packed =
        workgroup::packing::prepare(branched, &base, Strategy::Balanced, &checks(), 2).unwrap();
    assert_eq!(packed.tasks.len(), 4);
    assert_eq!(
        packed
            .tasks
            .iter()
            .find(|t| t.writes == ["d"])
            .unwrap()
            .depends
            .len(),
        2
    );
    assert!(workgroup::validate(&packed).is_ok());
}

#[test]
fn planner_validation_and_coalescing_do_not_introduce_dependency_cycles() {
    let tasks = vec![
        task("a", "x", &[]),
        task("b", "y", &["a"]),
        task("c", "x", &["b"]),
    ];
    let merged = workgroup::adapt(plan(tasks), Strategy::Cohesion, &checks()).unwrap();
    assert_eq!(merged.tasks.len(), 1);
    assert_eq!(merged.tasks[0].writes.len(), 2);
    assert!(workgroup::validate_write_scope(&merged, &["x".into()]).is_err());
    assert!(workgroup::validate_write_scope(&merged, &["x".into(), "y".into()]).is_ok());
    assert!(workgroup::validate_write_scope(&merged, &["../x".into()]).is_err());
    assert!(
        workgroup::validate(&plan(vec![task("a", "x", &["b"]), task("b", "y", &["a"])])).is_err()
    );
    for bad in [
        "../x",
        "/x",
        "a//b",
        "a/./b",
        "a/",
        "a\\b",
        ".git/config",
        "a\0b",
    ] {
        assert!(!tree::valid_path(bad), "{bad}");
    }
    assert!(
        tree::validate_tree(&Tree::from([
            ("a".into(), source("x")),
            ("a/b".into(), source("x"))
        ]))
        .is_err()
    );
}

struct ToolFixture {
    stall: Option<i32>,
    command_tools_only: bool,
}
#[async_trait]
impl areal_engine::model::Model for ToolFixture {
    fn name(&self) -> &str {
        "workgroup-fixture"
    }
    async fn stream(
        &self,
        _: Vec<areal_engine::model::Message>,
    ) -> Result<areal_engine::model::ModelStream> {
        unreachable!()
    }
    async fn chat(
        &self,
        messages: Vec<areal_engine::model::Message>,
        tools: Vec<serde_json::Value>,
    ) -> Result<areal_engine::model::ModelStream> {
        use areal_engine::model::{ModelEvent, ToolCall};
        if self.command_tools_only {
            let names: Vec<_> = tools
                .iter()
                .map(|tool| tool["function"]["name"].as_str().unwrap())
                .collect();
            assert_eq!(
                names,
                [
                    "run_command",
                    "read_process",
                    "write_process",
                    "terminate_process"
                ]
            );
        }
        let event = if messages.last().unwrap().role == "tool" {
            if let Some(code) = self.stall {
                ModelEvent::ToolCall(ToolCall {id:format!("repeat-{}",messages.len()),name:"run_command".into(),
                    arguments:serde_json::json!({"argv":["/bin/sh","-c",format!("exit {code}")],"cwd":"workspace://repo","timeoutMs":1000}).to_string()})
            } else if messages
                .iter()
                .filter(|message| message.role == "tool")
                .count()
                == 1
            {
                ModelEvent::ToolCall(ToolCall {id:"check-scratch".into(),name:"run_command".into(),
                    arguments:serde_json::json!({"argv":["/bin/sh","-c","test \"$TMPDIR\" = \"$PWD/.scratch\" && test \"$PYTHONDONTWRITEBYTECODE\" = 1 && touch \"$TMPDIR/temporary\""],"cwd":"workspace://repo","timeoutMs":1000}).to_string()})
            } else {
                let output: serde_json::Value =
                    serde_json::from_str(&messages.last().unwrap().text_content())?;
                anyhow::ensure!(
                    output["exitCode"] == 0,
                    "worker command did not receive private scratch environment"
                );
                ModelEvent::TextDelta("Finished".into())
            }
        } else {
            let text = messages.last().unwrap().text_content();
            let file = if text.contains("Implement a\n") {
                "a"
            } else {
                "b"
            };
            if self.command_tools_only {
                ModelEvent::ToolCall(ToolCall {id:"write".into(),name:"run_command".into(),arguments:
                    serde_json::json!({"argv":["/bin/sh","-c",format!("printf {file} > {file}.txt")],"cwd":"workspace://repo","timeoutMs":1000}).to_string()})
            } else {
                ModelEvent::ToolCall(ToolCall {
                    id: "write".into(),
                    name: "fs_create".into(),
                    arguments: serde_json::json!({"path":format!("{file}.txt"),"text":file})
                        .to_string(),
                })
            }
        };
        Ok(Box::pin(futures_util::stream::iter([
            Ok(event),
            Ok(ModelEvent::Usage(areal_protocol::ModelUsage {
                input_tokens: 10,
                output_tokens: 2,
                cached_input_tokens: 0,
            })),
        ])))
    }
}

#[tokio::test]
async fn root_model_budget_is_shared_and_only_complete_usage_is_counted() {
    use areal_engine::{
        model::{Message, Model},
        workgroup::native::SharedModel,
    };
    use futures_util::StreamExt;
    let model = SharedModel::new(
        Arc::new(ToolFixture {
            stall: None,
            command_tools_only: false,
        }),
        1,
        2,
    )
    .unwrap();
    let mut first = model
        .chat(vec![Message::text("user", "Implement a\n")], vec![])
        .await
        .unwrap();
    while first.next().await.is_some() {}
    drop(first);
    let incomplete = model
        .chat(vec![Message::text("user", "Implement b\n")], vec![])
        .await
        .unwrap();
    drop(incomplete);
    assert!(
        model
            .chat(vec![Message::text("user", "third")], vec![])
            .await
            .is_err()
    );
    let usage = model.usage();
    assert_eq!(usage.requests, 2);
    assert_eq!(usage.finished_requests, 1);
    assert_eq!(usage.unknown_requests, 1);
    assert_eq!(usage.input_tokens, 10);
    assert_eq!(usage.output_tokens, 2);
}

#[test]
fn trusted_toolchain_must_not_overlap_attempt_storage() {
    use areal_engine::workgroup::native::NativeExecutor;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("bindings");
    let nested = root.join("nested-toolchain");
    let trusted = temp.path().join("trusted-toolchain");
    std::fs::create_dir_all(&nested).unwrap();
    std::fs::create_dir(&trusted).unwrap();
    let binary = temp.path().join("trusted-binary");
    std::fs::write(&binary, b"constructor does not execute this fixture").unwrap();
    let create = |toolchain| {
        NativeExecutor::new(
            Arc::new(ToolFixture {
                stall: None,
                command_tools_only: false,
            }),
            root.clone(),
            binary.clone(),
            binary.clone(),
            Some(toolchain),
        )
    };
    for invalid in [root.clone(), temp.path().to_owned(), nested, binary.clone()] {
        assert!(create(invalid.clone()).is_err(), "accepted {invalid:?}");
    }
    assert!(create(temp.path().join("missing")).is_err());
    #[cfg(unix)]
    {
        let alias = temp.path().join("ancestor-alias");
        std::os::unix::fs::symlink(temp.path(), &alias).unwrap();
        assert!(
            create(alias).is_err(),
            "symlink alias bypassed overlap check"
        );
    }
    assert_eq!(
        create(trusted.clone()).unwrap().toolchain,
        Some(trusted.canonicalize().unwrap())
    );
}

#[tokio::test]
async fn model_permits_cover_stream_lifetime_and_release_on_drop_without_budget_refund() {
    use areal_engine::{
        model::{Message, Model},
        workgroup::native::SharedModel,
    };
    use futures_util::StreamExt;
    let model = SharedModel::new(
        Arc::new(ToolFixture {
            stall: None,
            command_tools_only: false,
        }),
        2,
        3,
    )
    .unwrap();
    let messages = || vec![Message::text("user", "Implement a\n")];
    let first = model.chat(messages(), vec![]).await.unwrap();
    let mut second = model.chat(messages(), vec![]).await.unwrap();
    let third = model.chat(messages(), vec![]);
    tokio::pin!(third);
    assert!(futures_util::poll!(&mut third).is_pending());
    assert_eq!(model.usage().requests, 2);
    drop(first); // A disconnected stream releases its permit, but not its cost.
    let mut third = tokio::time::timeout(Duration::from_secs(1), third)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(model.usage().requests, 3);
    let fourth = model.chat(messages(), vec![]);
    tokio::pin!(fourth);
    assert!(futures_util::poll!(&mut fourth).is_pending());
    while second.next().await.is_some() {}
    drop(second);
    assert!(
        tokio::time::timeout(Duration::from_secs(1), fourth)
            .await
            .unwrap()
            .is_err()
    );
    while third.next().await.is_some() {}
    drop(third);
    let usage = model.usage();
    assert_eq!(usage.requests, 3);
    assert_eq!(usage.finished_requests, 2);
    assert_eq!(usage.unknown_requests, 1);
    assert_eq!(usage.input_tokens, 20);
}

struct WaveFixture {
    wave: tokio::sync::Barrier,
    active: AtomicUsize,
    peak: AtomicUsize,
    completed: AtomicUsize,
    verifying: AtomicUsize,
    verification_peak: AtomicUsize,
}

struct BackpressureFixture {
    started: AtomicUsize,
    gate_started: tokio::sync::Notify,
    release_gate: tokio::sync::Semaphore,
    first_gate: AtomicBool,
}

#[async_trait]
impl Executor for BackpressureFixture {
    async fn attempt(
        &self,
        task: Task,
        _: u32,
        mut base: Tree,
        _: Option<Tree>,
        _: String,
        _: CancellationToken,
    ) -> Result<Tree> {
        self.started.fetch_add(1, Ordering::SeqCst);
        base.insert(task.writes[0].clone(), source(&task.id));
        Ok(base)
    }
    async fn verify(
        &self,
        candidate: Tree,
        _: Vec<Vec<String>>,
        cancel: CancellationToken,
    ) -> Result<Check> {
        if self.first_gate.swap(false, Ordering::SeqCst) {
            self.gate_started.notify_one();
            tokio::select! {
                permit = self.release_gate.acquire() => { permit?.forget(); }
                _ = cancel.cancelled() => anyhow::bail!("cancelled verifier settled"),
            }
        }
        Ok(Check {
            tree_hash: tree::digest(&candidate),
            passed: true,
            output: String::new(),
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn auto_admission_bounds_unverified_work_and_resumes_without_losing_artifacts() {
    for (admission, expected) in [
        (workgroup::Admission::Auto, 9),
        (workgroup::Admission::Fixed, 24),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let base = Tree::new();
        let group = Workgroup::create(
            &temp.path().join("group"),
            plan(
                (0..24)
                    .map(|i| task(&format!("t{i}"), &format!("m{i}"), &[]))
                    .collect(),
            ),
            &base,
            Strategy::Contract,
        )
        .unwrap();
        let fixture = Arc::new(BackpressureFixture {
            started: AtomicUsize::new(0),
            gate_started: tokio::sync::Notify::new(),
            release_gate: tokio::sync::Semaphore::new(0),
            first_gate: AtomicBool::new(true),
        });
        let owned = fixture.clone();
        let run = tokio::spawn(group.run(
            base,
            owned,
            checks(),
            Options {
                workers: 8,
                admission,
                strategy: Strategy::Contract,
                timeout: Duration::from_secs(30),
                ..Options::default()
            },
            CancellationToken::new(),
        ));
        tokio::time::timeout(Duration::from_secs(5), fixture.gate_started.notified())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while fixture.started.load(Ordering::SeqCst) < expected {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        // The blocked first verifier gives the scheduler time to process all
        // immediate attempts; it must not dispatch beyond its unaccepted window.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(fixture.started.load(Ordering::SeqCst), expected);
        fixture.release_gate.add_permits(1);
        let record = run.await.unwrap().unwrap();
        assert_eq!(record.status, "completed", "{:?}", record.error);
        assert_eq!(record.admission.peak_inflight, expected);
        assert_eq!(record.admission.peak_pending_verification, expected);
        assert_eq!(record.attempts, 24);
        assert!(
            record
                .history
                .iter()
                .all(|a| a.verification_started_seconds.is_some()
                    && a.verification_finished_seconds >= a.verification_started_seconds)
        );
        assert_eq!(
            tree::load(&temp.path().join("group"), &record.head)
                .unwrap()
                .len(),
            24
        );
    }
}

#[tokio::test]
async fn cancellation_settles_a_backpressured_auto_group() {
    let temp = tempfile::tempdir().unwrap();
    let base = Tree::new();
    let group = Workgroup::create(
        &temp.path().join("group"),
        plan(
            (0..8)
                .map(|i| task(&format!("t{i}"), &format!("m{i}"), &[]))
                .collect(),
        ),
        &base,
        Strategy::Contract,
    )
    .unwrap();
    let fixture = Arc::new(BackpressureFixture {
        started: AtomicUsize::new(0),
        gate_started: tokio::sync::Notify::new(),
        release_gate: tokio::sync::Semaphore::new(0),
        first_gate: AtomicBool::new(true),
    });
    let cancel = CancellationToken::new();
    let run = tokio::spawn(group.run(
        base,
        fixture.clone(),
        checks(),
        Options {
            workers: 1,
            admission: workgroup::Admission::Auto,
            strategy: Strategy::Contract,
            ..Options::default()
        },
        cancel.clone(),
    ));
    fixture.gate_started.notified().await;
    cancel.cancel();
    let record = tokio::time::timeout(Duration::from_secs(3), run)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(record.status, "cancelled");
    assert!(record.attempts <= 2);
    assert!(Workgroup::inspect(&temp.path().join("group")).is_ok());
}

#[tokio::test]
async fn auto_window_releases_rejected_artifacts_and_preserves_dependency_barriers() {
    let temp = tempfile::tempdir().unwrap();
    let base = Tree::new();
    let group = Workgroup::create(
        &temp.path().join("group"),
        plan(vec![
            task("a", "a.py", &[]),
            task("b", "b.py", &[]),
            task("c", "c.py", &["a", "b"]),
        ]),
        &base,
        Strategy::Contract,
    )
    .unwrap();
    let fixture = Arc::new(Fixture {
        reject_once: AtomicBool::new(true),
        ..Fixture::default()
    });
    let record = tokio::time::timeout(
        Duration::from_secs(5),
        group.run(
            base,
            fixture.clone(),
            checks(),
            Options {
                workers: 1,
                admission: workgroup::Admission::Auto,
                strategy: Strategy::Contract,
                ..Options::default()
            },
            CancellationToken::new(),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(record.status, "completed", "{:?}", record.error);
    assert_eq!(record.attempts, 4);
    assert_eq!(record.repairs, 1);
    assert!(record.admission.peak_inflight <= 2);
    assert!(
        fixture
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event == "seed:a:2")
    );
    let dependent = record.history.iter().find(|a| a.task == "c").unwrap();
    for id in ["a", "b"] {
        let accepted = record
            .history
            .iter()
            .find(|a| a.task == id && a.status == workgroup::TaskStatus::Integrated)
            .unwrap();
        assert!(dependent.started_seconds >= accepted.verification_finished_seconds.unwrap());
    }
}

#[async_trait]
impl Executor for WaveFixture {
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
        let ready = tokio::select! {
            _ = self.wave.wait() => true,
            _ = cancel.cancelled() => false,
        };
        self.active.fetch_sub(1, Ordering::SeqCst);
        anyhow::ensure!(ready, "wave cancelled");
        base.insert(task.writes[0].clone(), source(&task.id));
        self.completed.fetch_add(1, Ordering::SeqCst);
        Ok(base)
    }
    async fn verify(
        &self,
        candidate: Tree,
        commands: Vec<Vec<String>>,
        _: CancellationToken,
    ) -> Result<Check> {
        let active = self.verifying.fetch_add(1, Ordering::SeqCst) + 1;
        self.verification_peak.fetch_max(active, Ordering::SeqCst);
        tokio::task::yield_now().await;
        let passed = commands.is_empty() || candidate.len() == 64;
        self.verifying.fetch_sub(1, Ordering::SeqCst);
        Ok(Check {
            tree_hash: tree::digest(&candidate),
            passed,
            output: "deterministic capacity check, not real-model performance".into(),
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn maximum_width_runs_two_waves_without_lost_artifacts_or_parallel_head_publication() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("group");
    let base = Tree::new();
    let tasks = (0..64)
        .map(|i| task(&format!("task_{i}"), &format!("module_{i}.py"), &[]))
        .collect();
    let planned =
        workgroup::packing::prepare(plan(tasks), &base, Strategy::Balanced, &checks(), 32).unwrap();
    assert_eq!(planned.tasks.len(), 64);
    let expected: Tree = planned
        .tasks
        .iter()
        .map(|task| (task.writes[0].clone(), source(&task.id)))
        .collect();
    let fixture = Arc::new(WaveFixture {
        wave: tokio::sync::Barrier::new(32),
        active: AtomicUsize::new(0),
        peak: AtomicUsize::new(0),
        completed: AtomicUsize::new(0),
        verifying: AtomicUsize::new(0),
        verification_peak: AtomicUsize::new(0),
    });
    let group = Workgroup::create(&root, planned.clone(), &base, Strategy::Balanced).unwrap();
    let record = tokio::time::timeout(
        Duration::from_secs(90),
        group.run(
            base.clone(),
            fixture.clone(),
            checks(),
            Options {
                workers: 32,
                admission: workgroup::Admission::Auto,
                timeout: Duration::from_secs(60),
                ..Options::default()
            },
            CancellationToken::new(),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(record.status, "completed", "{:?}", record.error);
    assert_eq!(record.peak_workers, 32);
    assert_eq!(fixture.peak.load(Ordering::SeqCst), 32);
    assert_eq!(fixture.completed.load(Ordering::SeqCst), 64);
    assert_eq!(fixture.verification_peak.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.active.load(Ordering::SeqCst), 0);
    assert_eq!(record.attempts, 64);
    assert_eq!(record.repairs, 0);
    let candidate = tree::load(&root, &Workgroup::inspect(&root).unwrap().head).unwrap();
    assert_eq!(candidate.len(), 64);
    assert_eq!(candidate, expected);
    let group = Workgroup::create(
        &temp.path().join("invalid"),
        planned,
        &base,
        Strategy::Balanced,
    )
    .unwrap();
    assert!(
        group
            .run(
                base,
                fixture.clone(),
                checks(),
                Options {
                    workers: 33,
                    ..Options::default()
                },
                CancellationToken::new()
            )
            .await
            .is_err()
    );
    assert_eq!(fixture.completed.load(Ordering::SeqCst), 64);
}

#[tokio::test]
#[ignore = "requires built native Runtime and file helper paths"]
async fn real_core_workers_use_private_runtimes_and_final_combination_is_verified() {
    for stalled in [None, Some(9), Some(0)] {
        real_worker(stalled, false).await;
    }
    real_worker(None, true).await;
    for final_gate in [false, true] {
        real_cancellation(final_gate).await;
    }
}

struct InterruptedModel(areal_engine::model::ModelFailure);

#[tokio::test]
#[ignore = "requires built native Runtime and file helper paths"]
async fn real_verification_inherits_the_configured_runtime_command_deadline() {
    use areal_engine::workgroup::native::NativeExecutor;
    let temporary = tempfile::tempdir().unwrap();
    let path = |name| std::path::PathBuf::from(std::env::var(name).expect(name));
    let mut executor = NativeExecutor::new(
        Arc::new(ToolFixture {
            stall: None,
            command_tools_only: false,
        }),
        temporary.path().join("bindings"),
        path("AREAL_WORKGROUP_RUNTIME"),
        path("AREAL_WORKGROUP_HELPER"),
        None,
    )
    .unwrap();
    executor.runtime_limits.wall_time_ms = 2000;
    let candidate = Tree::from([(
        "subprocess.py".into(),
        source("raise AssertionError('workspace code imported by trusted launcher')"),
    )]);
    let check = executor
        .verify(
            candidate.clone(),
            vec![vec!["/bin/sh".into(), "-c".into(), "printf ok".into()]],
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(check.passed, "{}", check.output);
    let check = executor
        .verify(
            candidate,
            vec![vec!["/bin/sh".into(), "-c".into(), "sleep 3".into()]],
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(
        !check.passed,
        "verification must enforce the deployment deadline"
    );
}
#[async_trait]
impl areal_engine::model::Model for InterruptedModel {
    fn name(&self) -> &str {
        "inference-interruption-fixture"
    }
    async fn stream(
        &self,
        _: Vec<areal_engine::model::Message>,
    ) -> Result<areal_engine::model::ModelStream> {
        unreachable!()
    }
    async fn chat(
        &self,
        messages: Vec<areal_engine::model::Message>,
        tools: Vec<serde_json::Value>,
    ) -> Result<areal_engine::model::AgentStream> {
        if messages.last().unwrap().role == "tool" {
            return Ok(Box::pin(futures_util::stream::iter([Err(self.0.into())])));
        }
        ToolFixture {
            stall: None,
            command_tools_only: false,
        }
        .chat(messages, tools)
        .await
    }
}

#[tokio::test]
#[ignore = "requires built native Runtime and file helper paths"]
async fn real_runtime_checkpoint_settles_writers_and_requires_independent_checks() {
    use areal_engine::{
        model::ModelFailure,
        workgroup::native::{NativeExecutor, SharedModel},
    };
    let path = |name| std::path::PathBuf::from(std::env::var(name).expect(name));
    for failure in [
        ModelFailure::Truncated,
        ModelFailure::Incomplete,
        ModelFailure::Transport,
    ] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("group");
        let mut a = task("a", "a.txt", &[]);
        a.checks = vec![vec![
            "/bin/sh".into(),
            "-c".into(),
            "test \"$(cat a.txt)\" = a".into(),
        ]];
        let checks = a.checks.clone();
        let group =
            Workgroup::create(&root, plan(vec![a]), &Tree::new(), Strategy::Contract).unwrap();
        let model = SharedModel::new(Arc::new(InterruptedModel(failure)), 1, 8).unwrap();
        let executor = NativeExecutor::new(
            model.clone(),
            root.join("bindings"),
            path("AREAL_WORKGROUP_RUNTIME"),
            path("AREAL_WORKGROUP_HELPER"),
            None,
        )
        .unwrap();
        let record = group
            .run(
                Tree::new(),
                Arc::new(executor),
                checks,
                Options {
                    workers: 1,
                    strategy: Strategy::Contract,
                    timeout: Duration::from_secs(30),
                    ..Default::default()
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(record.status, "completed", "{:?}", record.error);
        assert_eq!(record.attempts, 1);
        assert_eq!(record.history[0].checkpoint, Some(failure));
        assert!(record.history[0].check.as_ref().unwrap().passed);
        assert!(record.final_check.unwrap().passed);
        assert_eq!(
            tree::snapshot(&root.join("candidate")).unwrap()["a.txt"],
            source("a")
        );
        assert_eq!(model.usage().unknown_requests, 1);
        assert_eq!(model.usage().requests, 2);
    }
}

struct CommandFixture {
    slow_worker: bool,
}

struct CapacityModel {
    barrier: tokio::sync::Barrier,
}

#[async_trait]
impl areal_engine::model::Model for CapacityModel {
    fn name(&self) -> &str {
        "scripted-runtime-capacity"
    }
    async fn stream(
        &self,
        _: Vec<areal_engine::model::Message>,
    ) -> Result<areal_engine::model::ModelStream> {
        unreachable!()
    }
    async fn chat(
        &self,
        messages: Vec<areal_engine::model::Message>,
        _: Vec<serde_json::Value>,
    ) -> Result<areal_engine::model::ModelStream> {
        use areal_engine::model::{ModelEvent, ToolCall};
        let last = messages.last().unwrap();
        let event = if last.role == "tool" {
            let value: serde_json::Value = serde_json::from_str(&last.text_content())?;
            anyhow::ensure!(value["exitCode"] == 0, "capacity worker command failed");
            ModelEvent::TextDelta("done".into())
        } else {
            let text = last.text_content();
            let index: usize = text
                .lines()
                .find_map(|line| line.strip_prefix("CAPACITY_FILE:"))
                .unwrap()
                .parse()?;
            self.barrier.wait().await;
            ModelEvent::ToolCall(ToolCall { id: "write".into(), name: "run_command".into(), arguments: serde_json::json!({
                "argv":["/bin/sh","-c",format!("echo $$ > .scratch/pid; printf '%s' {index} > m{index}.txt; test \"$(cat m{index}.txt)\" = {index}")],"cwd":"workspace://repo","timeoutMs":10000
            }).to_string() })
        };
        Ok(Box::pin(futures_util::stream::iter([Ok(event)])))
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore = "requires real native Runtime and file helper; scripted model, not an LLM throughput score"]
async fn thirty_two_real_runtimes_isolate_writes_and_settle_before_final_publication() {
    use areal_engine::workgroup::native::{NativeExecutor, SharedModel};
    let path = |name| std::path::PathBuf::from(std::env::var(name).expect(name));
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("group");
    let base = Tree::new();
    let tasks = (0..32)
        .map(|i| Task {
            configuration: None,
            id: format!("t{i}"),
            instruction: format!("CAPACITY_FILE:{i}\n"),
            writes: vec![format!("m{i}.txt")],
            depends: vec![],
            integration_depends: vec![],
            checks: vec![vec![
                "/bin/sh".into(),
                "-c".into(),
                format!("test \"$(cat m{i}.txt)\" = {i}"),
            ]],
        })
        .collect();
    let group = Workgroup::create(&root, plan(tasks), &base, Strategy::Contract).unwrap();
    let model = SharedModel::new(
        Arc::new(CapacityModel {
            barrier: tokio::sync::Barrier::new(32),
        }),
        32,
        64,
    )
    .unwrap();
    let executor = Arc::new(
        NativeExecutor::new(
            model,
            root.join("bindings"),
            path("AREAL_WORKGROUP_RUNTIME"),
            path("AREAL_WORKGROUP_HELPER"),
            None,
        )
        .unwrap(),
    );
    let command = (0..32)
        .map(|i| format!("test \"$(cat m{i}.txt)\" = {i}"))
        .collect::<Vec<_>>()
        .join(" && ");
    let record = tokio::time::timeout(
        Duration::from_secs(120),
        group.run(
            base,
            executor,
            vec![vec!["/bin/sh".into(), "-c".into(), command]],
            Options {
                workers: 32,
                admission: workgroup::Admission::Auto,
                strategy: Strategy::Contract,
                timeout: Duration::from_secs(90),
                ..Options::default()
            },
            CancellationToken::new(),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(record.status, "completed", "{:?}", record.error);
    assert_eq!(record.peak_workers, 32);
    assert_eq!(record.repairs, 0);
    assert_eq!(tree::load(&root, &record.head).unwrap().len(), 32);
    let mut epochs = std::collections::BTreeSet::new();
    for entry in std::fs::read_dir(root.join("bindings")).unwrap().flatten() {
        let binding = entry.path().join("binding.json");
        if binding.exists() {
            let value: serde_json::Value =
                serde_json::from_slice(&std::fs::read(binding).unwrap()).unwrap();
            assert!(epochs.insert(value["runtimeEpoch"].as_str().unwrap().to_owned()));
            let pid = std::fs::read_to_string(entry.path().join("workspace/.scratch/pid")).unwrap();
            assert!(
                !std::process::Command::new("/bin/kill")
                    .args(["-0", pid.trim()])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .unwrap()
                    .success()
            );
        }
    }
    assert_eq!(epochs.len(), 32);
    assert!(
        Workgroup::inspect(&root)
            .unwrap()
            .final_check
            .unwrap()
            .passed
    );
}

#[async_trait]
impl areal_engine::model::Model for CommandFixture {
    fn name(&self) -> &str {
        "cancellation-fixture"
    }
    async fn stream(
        &self,
        _: Vec<areal_engine::model::Message>,
    ) -> Result<areal_engine::model::ModelStream> {
        unreachable!()
    }
    async fn chat(
        &self,
        messages: Vec<areal_engine::model::Message>,
        _: Vec<serde_json::Value>,
    ) -> Result<areal_engine::model::ModelStream> {
        use areal_engine::model::{ModelEvent, ToolCall};
        let event = if messages.last().unwrap().role == "tool" {
            ModelEvent::TextDelta("Finished".into())
        } else {
            let command = if self.slow_worker {
                "printf a > a.txt; echo $$ > .scratch/pid; exec /bin/sleep 20"
            } else {
                "printf a > a.txt"
            };
            ModelEvent::ToolCall(ToolCall { id:"write".into(),name:"run_command".into(),
                arguments:serde_json::json!({"argv":["/bin/sh","-c",command],"cwd":"workspace://repo","timeoutMs":30000}).to_string() })
        };
        Ok(Box::pin(futures_util::stream::iter([Ok(event)])))
    }
}

async fn real_cancellation(final_gate: bool) {
    use areal_engine::workgroup::native::{NativeExecutor, SharedModel};
    let path = |name| std::path::PathBuf::from(std::env::var(name).expect(name));
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("group");
    let base = Tree::new();
    let group = Workgroup::create(
        &root,
        plan(vec![task("a", "a.txt", &[])]),
        &base,
        Strategy::Contract,
    )
    .unwrap();
    let model = SharedModel::new(
        Arc::new(CommandFixture {
            slow_worker: !final_gate,
        }),
        1,
        4,
    )
    .unwrap();
    let executor = Arc::new(
        NativeExecutor::new(
            model,
            root.join("bindings"),
            path("AREAL_WORKGROUP_RUNTIME"),
            path("AREAL_WORKGROUP_HELPER"),
            None,
        )
        .unwrap(),
    );
    let command = if final_gate {
        "echo $$ > .scratch/pid; exec /bin/sleep 20"
    } else {
        "test -f a.txt"
    };
    let stop = CancellationToken::new();
    let job = tokio::spawn(group.run(
        base,
        executor,
        vec![vec!["/bin/sh".into(), "-c".into(), command.into()]],
        Options {
            strategy: Strategy::Contract,
            timeout: Duration::from_secs(30),
            ..Options::default()
        },
        stop.clone(),
    ));
    // Cancel only after a real shell has published its PID; this exercises the
    // resource shutdown barrier, not cancellation before tool admission.
    let pid = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if let Ok(entries) = std::fs::read_dir(root.join("bindings")) {
                for entry in entries.flatten() {
                    if let Ok(value) =
                        std::fs::read_to_string(entry.path().join("workspace/.scratch/pid"))
                        && let Ok(pid) = value.trim().parse::<u32>()
                    {
                        return pid;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("real command did not start");
    stop.cancel();
    let record = tokio::time::timeout(Duration::from_secs(15), job)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(record.status, "cancelled");
    assert!(record.final_check.is_none());
    assert!(pid > 1);
    assert!(
        !std::process::Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success(),
        "workgroup returned while its command was still alive"
    );
}

async fn real_worker(stalled: Option<i32>, command_tools_only: bool) {
    use areal_engine::workgroup::native::{NativeExecutor, SharedModel};
    let path = |name| std::path::PathBuf::from(std::env::var(name).expect(name));
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("group");
    let base = Tree::new();
    let sentinel = temp.path().join("outside-secret");
    std::fs::write(&sentinel, b"must remain outside Runtime read authority").unwrap();
    let group = Workgroup::create(
        &root,
        plan(vec![task("a", "a.txt", &[]), task("b", "b.txt", &[])]),
        &base,
        Strategy::Contract,
    )
    .unwrap();
    let model = SharedModel::new(
        Arc::new(ToolFixture {
            stall: stalled,
            command_tools_only,
        }),
        2,
        10,
    )
    .unwrap();
    let mut executor = NativeExecutor::new(
        model.clone(),
        root.join("bindings"),
        path("AREAL_WORKGROUP_RUNTIME"),
        path("AREAL_WORKGROUP_HELPER"),
        None,
    )
    .unwrap();
    executor.command_tools_only = command_tools_only;
    let executor = Arc::new(executor);
    let checks = vec![vec![
        "/bin/sh".into(),
        "-c".into(),
        format!(
            "test \"$(cat a.txt)\" = a && test \"$(cat b.txt)\" = b && ! cat '{}'",
            sentinel.display()
        ),
    ]];
    let record = group
        .run(
            base,
            executor,
            checks,
            Options {
                workers: 2,
                timeout: Duration::from_secs(30),
                strategy: Strategy::Contract,
                ..Options::default()
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        record.status, "completed",
        "{:?} {:?}",
        record.error, record.final_check
    );
    assert!(record.final_check.unwrap().passed);
    assert_eq!(record.peak_workers, 2);
    assert_eq!(
        model.usage().requests,
        match stalled {
            None => 6,
            Some(0) => 10,
            Some(_) => 8,
        }
    );
    assert_eq!(model.usage().unknown_requests, 0);
    assert_eq!(tree::load(&root, &record.head).unwrap().len(), 2);
}
