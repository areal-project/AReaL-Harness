//! Deterministic scheduler study using the production Workgroup and SharedModel.
//! Virtual time and scripted artifacts; NOT a coding/model quality benchmark.
use anyhow::{Context, Result, ensure};
use areal_engine::{
    model::{Message, Model, ModelEvent, ModelLoad, ModelStream},
    workgroup::{
        Admission, Check, Executor, Options, Plan, Strategy, Task, Workgroup,
        native::SharedModel,
        tree::{self, File, Tree},
    },
};
use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::json;
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy)]
struct Scenario {
    name: &'static str,
    tasks: usize,
    capacity: usize,
    rounds: usize,
    model_ms: u64,
    tool_ms: u64,
    gate_ms: u64,
    chain: bool,
    hotspot: bool,
    phase_shift: bool,
}

fn scenarios() -> Vec<Scenario> {
    let base = Scenario {
        name: "five_independent",
        tasks: 5,
        capacity: 8,
        rounds: 4,
        model_ms: 200,
        tool_ms: 4800,
        gate_ms: 200,
        chain: false,
        hotspot: false,
        phase_shift: false,
    };
    vec![
        base,
        Scenario {
            name: "model_bound",
            tasks: 16,
            capacity: 2,
            model_ms: 2000,
            tool_ms: 100,
            gate_ms: 100,
            ..base
        },
        Scenario {
            name: "mixed_tools",
            tasks: 24,
            capacity: 2,
            rounds: 2,
            model_ms: 1000,
            tool_ms: 5000,
            ..base
        },
        Scenario {
            name: "slow_verifier",
            tasks: 16,
            rounds: 1,
            model_ms: 100,
            tool_ms: 100,
            gate_ms: 3000,
            ..base
        },
        Scenario {
            name: "chain",
            tasks: 8,
            rounds: 1,
            model_ms: 500,
            tool_ms: 1000,
            chain: true,
            ..base
        },
        Scenario {
            name: "shared_file",
            tasks: 8,
            rounds: 1,
            model_ms: 500,
            tool_ms: 1000,
            hotspot: true,
            ..base
        },
        Scenario {
            name: "phase_shift",
            tasks: 32,
            capacity: 2,
            model_ms: 200,
            tool_ms: 1000,
            phase_shift: true,
            ..base
        },
    ]
}

struct ScriptedModel {
    scenario: Scenario,
    requests: AtomicUsize,
}
#[async_trait]
impl Model for ScriptedModel {
    fn name(&self) -> &str {
        "scripted-service"
    }
    async fn stream(&self, _: Vec<Message>) -> Result<ModelStream> {
        let request = self.requests.fetch_add(1, Ordering::SeqCst);
        let millis = if self.scenario.phase_shift && request >= 24 {
            3000
        } else {
            self.scenario.model_ms
        };
        Ok(Box::pin(futures_util::stream::once(async move {
            tokio::time::sleep(Duration::from_millis(millis)).await;
            Ok(ModelEvent::text("scripted receipt"))
        })))
    }
}

struct Fixture {
    scenario: Scenario,
    model: Arc<SharedModel>,
    active: AtomicUsize,
}
struct Active<'a>(&'a AtomicUsize);
impl Drop for Active<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[async_trait]
impl Executor for Fixture {
    fn model_load(&self) -> Option<ModelLoad> {
        self.model.load()
    }
    async fn attempt(
        &self,
        task: Task,
        _: u32,
        mut base: Tree,
        _: Option<Tree>,
        _: String,
        cancel: CancellationToken,
    ) -> Result<Tree> {
        self.active.fetch_add(1, Ordering::SeqCst);
        let _active = Active(&self.active);
        for dep in &task.depends {
            ensure!(base.contains_key(dep), "dependency not integrated");
        }
        let work = async {
            for _ in 0..self.scenario.rounds {
                let mut stream = self
                    .model
                    .stream(vec![Message::text("user", &task.id)])
                    .await?;
                while let Some(event) = stream.next().await {
                    event?;
                }
                drop(stream); // The request permit must not span the tool wait.
                tokio::time::sleep(Duration::from_millis(self.scenario.tool_ms)).await;
            }
            let file = base.entry(task.writes[0].clone()).or_insert(File {
                bytes: vec![],
                executable: false,
            });
            file.bytes
                .extend_from_slice(format!("{}\n", task.id).as_bytes());
            Ok(base)
        };
        tokio::select! { result = work => result, _ = cancel.cancelled() => anyhow::bail!("fixture cancelled and settled") }
    }
    async fn verify(
        &self,
        candidate: Tree,
        commands: Vec<Vec<String>>,
        cancel: CancellationToken,
    ) -> Result<Check> {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(self.scenario.gate_ms)) => {},
            _ = cancel.cancelled() => anyhow::bail!("fixture verifier cancelled and settled"),
        }
        let content: String = candidate
            .values()
            .map(|f| String::from_utf8_lossy(&f.bytes))
            .collect();
        let passed = if commands[0][0] == "final" {
            (0..self.scenario.tasks)
                .all(|i| content.lines().filter(|s| *s == format!("t{i}")).count() == 1)
        } else {
            content.lines().any(|s| s == commands[0][0])
        };
        Ok(Check {
            tree_hash: tree::digest(&candidate),
            passed,
            output: "scripted exact-once content gate".into(),
        })
    }
}

async fn run(
    root: &Path,
    scenario: Scenario,
    admission: Admission,
    workers: usize,
    stop: CancellationToken,
) -> Result<serde_json::Value> {
    let tasks = (0..scenario.tasks)
        .map(|i| Task {
            configuration: None,
            integration_depends: vec![],
            id: format!("t{i}"),
            instruction: format!("Append exactly t{i}"),
            writes: vec![if scenario.hotspot {
                "shared".into()
            } else {
                format!("t{i}")
            }],
            depends: if scenario.chain && i > 0 {
                vec![format!("t{}", i - 1)]
            } else {
                vec![]
            },
            checks: vec![vec![format!("t{i}")]],
        })
        .collect();
    let model = SharedModel::new(
        Arc::new(ScriptedModel {
            scenario,
            requests: AtomicUsize::new(0),
        }),
        scenario.capacity,
        10000,
    )?;
    let fixture = Arc::new(Fixture {
        scenario,
        model: model.clone(),
        active: AtomicUsize::new(0),
    });
    let group = Workgroup::create(
        root,
        Plan {
            objective: scenario.name.into(),
            tasks,
        },
        &Tree::new(),
        Strategy::Contract,
    )?;
    let started = tokio::time::Instant::now();
    let record = group
        .run(
            Tree::new(),
            fixture.clone(),
            vec![vec!["final".into()]],
            Options {
                verification_batch: 4,
                workers,
                admission,
                initial_workers: 0,
                strategy: Strategy::Contract,
                timeout: Duration::from_secs(10000),
                repairs: 0,
                integration_repair: false,
            },
            stop,
        )
        .await?;
    ensure!(
        fixture.active.load(Ordering::SeqCst) == 0,
        "live attempt survived owner"
    );
    let load = model.load().unwrap();
    ensure!(
        load.in_flight == 0 && load.waiting == 0,
        "model permits did not settle"
    );
    Ok(
        json!({ "scenario":scenario.name, "admission":admission,"workers":workers,
        "status":record.status,"simulated_seconds":started.elapsed().as_secs_f64(),
        "peak_workers":record.peak_workers,"attempts":record.attempts,"model_load":load,
        "admission_stats":record.admission, "root":root }),
    )
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let out = std::env::args_os()
        .nth(1)
        .context("usage: workgroup-admission-study NEW_OUTPUT_DIRECTORY")?;
    let out = Path::new(&out);
    ensure!(!out.exists(), "output already exists");
    std::fs::create_dir_all(out)?;
    tokio::time::pause();
    let mut rows = vec![];
    for scenario in scenarios() {
        for (admission, workers) in [
            (Admission::Fixed, 1),
            (Admission::Fixed, 2),
            (Admission::Fixed, 4),
            (Admission::Fixed, 8),
            (Admission::Fixed, 3),
            (Admission::Auto, 8),
            (Admission::Adaptive, 8),
        ] {
            let name = format!("{}-{admission:?}-{workers}", scenario.name);
            let row = run(
                &out.join(name),
                scenario,
                admission,
                workers,
                CancellationToken::new(),
            )
            .await?;
            ensure!(
                row["status"] == "completed",
                "scripted workload failed: {row}"
            );
            println!("{row}");
            rows.push(row);
        }
    }
    std::fs::write(
        out.join("study.json"),
        serde_json::to_vec_pretty(&json!({
        "kind":"deterministic_virtual_time_scheduler_study", "model_quality_evidence":false,
        "description":"Production Workgroup/SharedModel, scripted service/tool timing and source artifacts; no model tokens or inference.",
        "rows":rows }))?,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn five_ready_tasks_expand_beyond_two_and_serial_constraints_remain_serial() {
        let temp = tempfile::tempdir().unwrap();
        for scenario in scenarios()
            .into_iter()
            .filter(|s| ["five_independent", "chain", "shared_file"].contains(&s.name))
        {
            let row = run(
                &temp.path().join(scenario.name),
                scenario,
                Admission::Adaptive,
                8,
                CancellationToken::new(),
            )
            .await
            .unwrap();
            assert_eq!(row["status"], "completed");
            assert_eq!(
                row["peak_workers"],
                if scenario.chain || scenario.hotspot {
                    1
                } else {
                    5
                }
            );
            assert_eq!(row["attempts"], scenario.tasks);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn cancellation_after_expansion_drains_every_attempt_and_permit() {
        let temp = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(14)).await;
            stop.cancel();
        });
        let row = run(
            &temp.path().join("cancelled"),
            scenarios()[0],
            Admission::Adaptive,
            8,
            cancel,
        )
        .await
        .unwrap();
        assert_eq!(row["peak_workers"], 5);
        assert_ne!(row["status"], "completed");
    }
}
