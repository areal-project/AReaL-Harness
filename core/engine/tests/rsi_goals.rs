use anyhow::Result;
use areal_engine::{
    Engine, Limits,
    goals::Budget,
    model::{Message, Model, ModelEvent, ModelStream},
    workgroup::{
        Check, Executor, Task,
        service::{Factory, Policy, Service},
        tree::{self, File, Tree},
    },
};
use areal_protocol::goals::*;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Barrier, Semaphore};
use tokio_util::sync::CancellationToken;

struct ModelFixture;
#[async_trait]
impl Model for ModelFixture {
    fn name(&self) -> &str {
        "rsi-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> Result<ModelStream> {
        Ok(Box::pin(futures_util::stream::iter([Ok(
            ModelEvent::text("ordinary reply"),
        )])))
    }
}
struct Worker {
    attempts: AtomicUsize,
    barrier: Barrier,
    bases: Mutex<Vec<String>>,
    configurations: Mutex<Vec<areal_protocol::desktop::EffectiveConfig>>,
    fail: bool,
    hold: bool,
    started: Semaphore,
}
struct FactoryFixture(Arc<Worker>);
impl Factory for FactoryFixture {
    fn executor(&self, _: &Path, _: &Policy) -> Result<Arc<dyn Executor>> {
        Ok(self.0.clone())
    }
    fn executor_for_goal(
        &self,
        root: &Path,
        policy: &Policy,
        _: Option<Arc<Budget>>,
    ) -> Result<Arc<dyn Executor>> {
        self.executor(root, policy)
    }
    fn executor_for_rsi(
        &self,
        root: &Path,
        policy: &Policy,
        _: Arc<Budget>,
        configuration: areal_protocol::desktop::EffectiveConfig,
    ) -> Result<Arc<dyn Executor>> {
        self.0.configurations.lock().unwrap().push(configuration);
        self.executor(root, policy)
    }
}
#[async_trait]
impl Executor for Worker {
    async fn attempt(
        &self,
        task: Task,
        _: u32,
        mut base: Tree,
        _: Option<Tree>,
        _: String,
        cancel: CancellationToken,
    ) -> Result<Tree> {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        assert!(base.contains_key("input.txt"));
        assert!(!base.keys().any(|key| key.starts_with("rsi-artifacts/")));
        self.bases.lock().unwrap().push(tree::digest(&base));
        assert_eq!(task.writes.len(), 1);
        assert!(task.instruction.contains("query for candidate comparison"));
        self.barrier.wait().await;
        self.started.add_permits(1);
        if self.hold {
            cancel.cancelled().await;
            anyhow::bail!("fixture cancelled and settled");
        }
        anyhow::ensure!(
            !(self.fail && task.id == "candidate-2"),
            "candidate-2 fixture failure"
        );
        base.insert(
            task.writes[0].clone(),
            File {
                bytes: format!("# {}\nquery artifact\n", task.id).into_bytes(),
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
        assert!(commands.is_empty());
        Ok(Check {
            tree_hash: tree::digest(&tree),
            passed: true,
            output: "structural settlement only, no scoring".into(),
        })
    }
}
fn worker(fail: bool, hold: bool) -> Arc<Worker> {
    Arc::new(Worker {
        attempts: AtomicUsize::new(0),
        barrier: Barrier::new(3),
        bases: Mutex::new(vec![]),
        configurations: Mutex::new(vec![]),
        fail,
        hold,
        started: Semaphore::new(0),
    })
}
fn attach(root: &Path, source: &Path, worker: Arc<Worker>) -> (Arc<Engine>, Arc<Service>) {
    let engine = Engine::open(
        &root.join("core"),
        Arc::new(ModelFixture),
        Limits::default(),
    )
    .unwrap();
    let service = Service::open_automatic(
        &root.join("groups"),
        source,
        Arc::new(FactoryFixture(worker)),
        3,
    )
    .unwrap();
    engine.attach_automatic_workgroups(service.clone()).unwrap();
    (engine, service)
}
fn request(thread: &str) -> GoalCreate {
    serde_json::from_value(json!({"requestId":"create-rsi","threadId":thread,"expectedRevision":0,"objective":"query for candidate comparison","workflow":"rsiArtifact"})).unwrap()
}
async fn settled(engine: &Engine, thread: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let value = engine.goal_get(thread).await.unwrap();
            if value["goal"]["rsi"]["phase"] != "running" {
                return value;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}
fn select(value: &Value, id: &str, candidate: &str) -> GoalSelectCandidate {
    serde_json::from_value(json!({"requestId":id,"threadId":value["threadId"],"goalId":value["goal"]["id"],"expectedRevision":value["revision"],"candidateId":candidate})).unwrap()
}
fn source(root: &Path) -> std::path::PathBuf {
    let path = root.join("source");
    std::fs::create_dir(&path).unwrap();
    std::fs::write(path.join("input.txt"), "immutable input").unwrap();
    path
}

#[tokio::test]
async fn parallel_candidates_failure_selection_conflict_and_restart() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(temp.path());
    let worker = worker(true, false);
    let (engine, service) = attach(temp.path(), &source, worker.clone());
    let thread = engine
        .create(source.to_string_lossy().into())
        .await
        .unwrap();
    let initial = engine
        .goal_create("gui".into(), request(&thread.id))
        .await
        .unwrap();
    assert_eq!(
        initial["goal"]["rsi"]["candidates"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        initial,
        engine
            .goal_create("gui".into(), request(&thread.id))
            .await
            .unwrap()
    );
    let ready = settled(&engine, &thread.id).await;
    assert_eq!(ready["goal"]["rsi"]["phase"], "awaitingSelection");
    let candidates = ready["goal"]["rsi"]["candidates"].as_array().unwrap();
    assert_eq!(candidates[0]["status"], "completed");
    assert_eq!(candidates[1]["status"], "failed");
    assert_eq!(candidates[2]["status"], "completed");
    assert_eq!(worker.attempts.load(Ordering::SeqCst), 3);
    let bases = worker.bases.lock().unwrap().clone();
    assert_eq!(bases.len(), 3);
    assert!(bases.iter().all(|base| *base == bases[0]));
    assert_ne!(
        candidates[0]["workspacePath"],
        candidates[2]["workspacePath"]
    );
    assert!(!source.join("rsi-artifacts").exists());
    for candidate in candidates {
        let dir = temp
            .path()
            .join("core/rsi")
            .join(ready["goal"]["id"].as_str().unwrap())
            .join(candidate["id"].as_str().unwrap());
        for name in ["request.json", "harness.md", "metadata.json", "result.json"] {
            assert!(dir.join(name).is_file(), "missing {name}");
        }
    }
    assert!(
        engine
            .goal_select_candidate("gui".into(), select(&ready, "failed", "candidate-2"))
            .await
            .is_err()
    );
    let chosen = select(&ready, "select", "candidate-3");
    let winner = engine
        .goal_select_candidate("gui".into(), chosen.clone())
        .await
        .unwrap();
    assert_eq!(winner["goal"]["rsi"]["selectedCandidateId"], "candidate-3");
    assert_eq!(
        winner,
        engine
            .goal_select_candidate("gui".into(), chosen)
            .await
            .unwrap()
    );
    assert!(
        engine
            .goal_select_candidate("gui-2".into(), select(&ready, "stale", "candidate-1"))
            .await
            .is_err()
    );
    assert_eq!(
        winner,
        engine
            .goal_select_candidate("gui".into(), select(&winner, "same-winner", "candidate-3"))
            .await
            .unwrap()
    );
    assert!(
        engine
            .goal_select_candidate("gui".into(), select(&winner, "same-winner", "candidate-1"))
            .await
            .is_err()
    );
    let artifact: GoalCandidateArtifact = serde_json::from_value(
        json!({"threadId":thread.id,"goalId":winner["goal"]["id"],"candidateId":"candidate-3"}),
    )
    .unwrap();
    assert!(
        engine
            .goal_candidate_artifact(artifact.clone())
            .await
            .unwrap()["text"]
            .as_str()
            .unwrap()
            .contains("# candidate-3")
    );
    engine.shutdown().await;
    service.shutdown().await;
    drop(engine);
    drop(service);
    let (engine, service) = attach(temp.path(), &source, worker.clone());
    let restored = engine.goal_get(&thread.id).await.unwrap();
    assert_eq!(restored["goal"]["rsi"], winner["goal"]["rsi"]);
    assert!(engine.goal_candidate_artifact(artifact).await.is_ok());
    assert_eq!(worker.attempts.load(Ordering::SeqCst), 3);
    engine.shutdown().await;
    service.shutdown().await;
}

#[tokio::test]
async fn interrupted_candidates_are_not_replayed_on_restart() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(temp.path());
    let worker = worker(false, true);
    let (engine, service) = attach(temp.path(), &source, worker.clone());
    let thread = engine
        .create(source.to_string_lossy().into())
        .await
        .unwrap();
    engine
        .goal_create("tui".into(), request(&thread.id))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), worker.started.acquire_many(3))
        .await
        .unwrap()
        .unwrap()
        .forget();
    engine.shutdown().await;
    service.shutdown().await;
    drop(engine);
    drop(service);
    let (engine, service) = attach(temp.path(), &source, worker.clone());
    let restored = settled(&engine, &thread.id).await;
    assert_eq!(restored["goal"]["rsi"]["phase"], "failed");
    assert_eq!(worker.attempts.load(Ordering::SeqCst), 3);
    engine.shutdown().await;
    service.shutdown().await;
}

#[tokio::test]
async fn unknown_workflow_is_explicit_and_unavailable_isolation_has_no_side_effect() {
    let temp = tempfile::tempdir().unwrap();
    let engine = Engine::open(temp.path(), Arc::new(ModelFixture), Limits::default()).unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    let mut unknown = request(&thread.id);
    unknown.workflow = Some("typo".into());
    assert!(
        engine
            .goal_create("test".into(), unknown)
            .await
            .unwrap_err()
            .to_string()
            .contains("unsupported goal workflow")
    );
    assert!(
        engine
            .goal_create("test".into(), request(&thread.id))
            .await
            .is_err()
    );
    assert!(engine.goal_get(&thread.id).await.unwrap()["goal"].is_null());
    engine.shutdown().await;
}

#[tokio::test]
async fn feedback_branch_preserves_frozen_input_lineage_incumbent_and_receipts() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(temp.path());
    let worker = worker(false, false);
    let (engine, service) = attach(temp.path(), &source, worker.clone());
    let configured = |endpoint: &str, output_tokens| {
        let provider: areal_protocol::desktop::Provider = serde_json::from_value(json!({
            "id":"fixture","revision":1,"endpoint":endpoint,"protocol":"responses",
            "models":["fixture-model"],"parameters":{"temperature":0.2,"maxOutputTokens":output_tokens,"reasoningEffort":"high"}
        })).unwrap();
        areal_engine::desktop::ConfiguredModels {
            provider_ids: ["fixture".into()].into_iter().collect(),
            providers: vec![provider],
            default_model: Some(areal_protocol::desktop::ModelRef {
                provider_id: "fixture".into(),
                model_id: "fixture-model".into(),
            }),
            ..Default::default()
        }
    };
    engine
        .install_configured_models(configured("http://127.0.0.1:1/first", 2048))
        .unwrap();
    let thread = engine
        .create(source.to_string_lossy().into())
        .await
        .unwrap();
    let mut create = request(&thread.id);
    engine
        .configure_thread(
            serde_json::from_value(json!({
                "threadId":thread.id,"expectedRevision":1,
                "parameters":{"temperature":0.4,"maxOutputTokens":3072,"reasoningEffort":"medium"}
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    create.output_format = Some("html".into());
    engine.goal_create("gui".into(), create).await.unwrap();
    let ready = settled(&engine, &thread.id).await;
    assert_eq!(ready["goal"]["rsi"]["outputFormat"], "html");
    let winner = engine
        .goal_select_candidate("gui".into(), select(&ready, "choose", "candidate-1"))
        .await
        .unwrap();
    let artifact = engine.goal_candidate_artifact(serde_json::from_value(json!({"threadId":thread.id,"goalId":winner["goal"]["id"],"candidateId":"candidate-1"})).unwrap()).await.unwrap();
    assert!(artifact["path"].as_str().unwrap().ends_with(".html"));
    let mut evaluation: GoalEvaluateCandidate = serde_json::from_value(json!({"requestId":"evaluate","threadId":thread.id,"goalId":winner["goal"]["id"],"expectedRevision":winner["revision"],"candidateId":"candidate-1","evaluation":{"rubricId":"browser-v1","evaluator":"independent-fixture","taskId":"page-a","artifactSha256":"wrong","checks":{"mobile":false},"score":40,"feedback":"mobile content overflows","evidence":["receipt.json"]}})).unwrap();
    assert!(
        engine
            .goal_evaluate_candidate("gui".into(), evaluation.clone())
            .await
            .is_err()
    );
    evaluation.evaluation.artifact_sha256 = artifact["sha256"].as_str().unwrap().into();
    let evaluated = engine
        .goal_evaluate_candidate("gui".into(), evaluation.clone())
        .await
        .unwrap();
    assert_eq!(
        engine
            .goal_evaluate_candidate("gui".into(), evaluation)
            .await
            .unwrap(),
        evaluated
    );
    let evolve: GoalEvolve = serde_json::from_value(json!({"requestId":"evolve","threadId":thread.id,"goalId":evaluated["goal"]["id"],"expectedRevision":evaluated["revision"],"parentCandidateId":"candidate-1","feedback":"mobile content overflows","variants":[{"label":"responsive","hypothesis":"fluid layout fixes overflow","harness":"Measure small screens and use fluid containers."},{"label":"accessible","hypothesis":"semantic layout improves mobile use","harness":"Use semantic controls and an accessible navigation."},{"label":"minimal","hypothesis":"reduce clutter","harness":"Prioritize content and remove needless decoration."}]})).unwrap();
    // 冻结后的源文件变化不能污染第二轮。
    std::fs::write(source.join("input.txt"), "changed after initial snapshot").unwrap();
    engine
        .install_configured_models(configured("http://127.0.0.1:1/reloaded", 8192))
        .unwrap();
    engine
        .configure_thread(
            serde_json::from_value(json!({
                "threadId":thread.id,"expectedRevision":2,
                "parameters":{"temperature":0.9,"maxOutputTokens":4096,"reasoningEffort":"low"}
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    let branching = engine
        .goal_evolve("gui".into(), evolve.clone())
        .await
        .unwrap();
    assert_eq!(
        engine
            .goal_evolve("gui".into(), evolve.clone())
            .await
            .unwrap(),
        branching
    );
    assert_eq!(
        branching["goal"]["rsi"]["selectedCandidateId"],
        "candidate-1"
    );
    let mut stale = evolve;
    stale.control.request_id = "stale".into();
    assert!(engine.goal_evolve("gui".into(), stale).await.is_err());
    let ready = settled(&engine, &thread.id).await;
    let candidates = ready["goal"]["rsi"]["candidates"].as_array().unwrap();
    assert_eq!(candidates.len(), 6);
    assert!(
        candidates[3..]
            .iter()
            .all(|c| c["parentCandidateId"] == "candidate-1"
                && c["round"] == 1
                && c["status"] == "completed")
    );
    let bases = worker.bases.lock().unwrap().clone();
    assert_eq!(bases.len(), 6);
    assert!(bases.iter().all(|b| b == &bases[0]));
    let configurations = worker.configurations.lock().unwrap().clone();
    assert_eq!(configurations.len(), 6);
    assert!(configurations.iter().all(|c| c == &configurations[0]));
    assert_eq!(configurations[0].parameters.max_output_tokens, Some(3072));
    assert_eq!(configurations[0].parameters.temperature, Some(0.4));
    assert_eq!(
        configurations[0].parameters.reasoning_effort.as_deref(),
        Some("medium")
    );
    assert_eq!(
        configurations[0].provider.as_ref().unwrap().endpoint,
        "http://127.0.0.1:1/first"
    );
    let winner = engine
        .goal_select_candidate("gui".into(), select(&ready, "promote", "candidate-4"))
        .await
        .unwrap();
    assert_eq!(winner["goal"]["rsi"]["selectedCandidateId"], "candidate-4");
    assert_eq!(
        winner["goal"]["rsi"]["candidates"][0]["status"],
        "completed"
    );
    engine.shutdown().await;
    service.shutdown().await;
    drop(engine);
    drop(service);
    let (engine, service) = attach(temp.path(), &source, worker.clone());
    let restored = engine.goal_get(&thread.id).await.unwrap();
    assert_eq!(restored["goal"]["rsi"], winner["goal"]["rsi"]);
    assert_eq!(worker.attempts.load(Ordering::SeqCst), 6);
    engine.shutdown().await;
    service.shutdown().await;
}

#[tokio::test]
async fn failed_parent_can_branch_with_explicit_budget_extension_without_replay() {
    let temp = tempfile::tempdir().unwrap();
    let source = source(temp.path());
    let worker = worker(true, false);
    let (engine, service) = attach(temp.path(), &source, worker.clone());
    let thread = engine
        .create(source.to_string_lossy().into())
        .await
        .unwrap();
    let mut create = request(&thread.id);
    create.token_budget = Some(1000);
    engine.goal_create("gui".into(), create).await.unwrap();
    let ready = settled(&engine, &thread.id).await;
    let mut request: GoalEvolve = serde_json::from_value(json!({"requestId":"recover","threadId":thread.id,"goalId":ready["goal"]["id"],"expectedRevision":ready["revision"],"parentCandidateId":"candidate-2","tokenBudget":1000,"feedback":"execution failure: use a bounded direct writer","variants":[{"label":"recovery-a","hypothesis":"reduce tool rounds","harness":"Write directly and finish."},{"label":"recovery-b","hypothesis":"check tool schema","harness":"Use the actual tool schema before writing."},{"label":"recovery-c","hypothesis":"limit probes","harness":"Avoid discovery; deliver a complete artifact."}]})).unwrap();
    assert!(
        engine
            .goal_evolve("gui".into(), request.clone())
            .await
            .is_err()
    );
    request.token_budget = Some(2000);
    let branching = engine.goal_evolve("gui".into(), request).await.unwrap();
    assert_eq!(branching["goal"]["tokenBudget"], 2000);
    assert_eq!(branching["goal"]["id"], ready["goal"]["id"]);
    let final_view = settled(&engine, &thread.id).await;
    assert_eq!(
        final_view["goal"]["rsi"]["candidates"][1]["status"],
        "failed"
    );
    assert!(
        final_view["goal"]["rsi"]["candidates"].as_array().unwrap()[3..]
            .iter()
            .all(|c| c["parentCandidateId"] == "candidate-2" && c["status"] == "completed")
    );
    assert_eq!(worker.attempts.load(Ordering::SeqCst), 6);
    engine.shutdown().await;
    service.shutdown().await;
}
