//! Bounded owner mailbox and durable, compare-and-swap plan changes.
use super::*;
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, oneshot, watch};

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub digest: String,
    pub plan_revision: u64,
}

pub(super) struct Command {
    key: String,
    expected: u64,
    plan: Plan,
    reply: oneshot::Sender<Result<u64>>,
}

#[derive(Clone)]
pub struct Control {
    state: watch::Sender<Arc<Record>>,
    commands: mpsc::Sender<Command>,
}

impl Control {
    pub(super) fn new(record: &Record) -> (Self, mpsc::Receiver<Command>) {
        let (commands, receiver) = mpsc::channel(16);
        (
            Self {
                state: watch::channel(Arc::new(record.clone())).0,
                commands,
            },
            receiver,
        )
    }

    pub(super) fn publish(&self, record: &Record) {
        self.state.send_replace(Arc::new(record.clone()));
    }

    pub fn read(&self) -> Arc<Record> {
        self.state.borrow().clone()
    }

    /// Event-driven, cursor-based observation; never occupies a worker/model permit.
    pub async fn wait(&self, after: u64, timeout: Duration) -> Arc<Record> {
        let mut state = self.state.subscribe();
        let _ = tokio::time::timeout(
            timeout,
            state.wait_for(|r| r.revision > after || r.status != "running"),
        )
        .await;
        state.borrow().clone()
    }

    /// Idempotent edits can replace Ready tasks or append tasks inside the
    /// original authority. Started/accepted contracts and final gates are fixed.
    pub async fn revise(&self, key: String, expected: u64, plan: Plan) -> Result<u64> {
        ensure!(
            !key.is_empty() && key.len() <= 128,
            "invalid revision request key"
        );
        validate(&plan)?;
        ensure!(
            serde_json::to_vec(&plan)?.len() <= 256 * 1024,
            "plan exceeds 256 KiB"
        );
        if let Some(prior) = self.read().revisions.get(&key) {
            let digest = format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&(expected, &plan))?)
            );
            ensure!(
                prior.digest == digest,
                "revision key reused with different arguments"
            );
            return Ok(prior.plan_revision);
        }
        let record = self.read();
        ensure!(
            record.status == "running"
                && !record
                    .tasks
                    .iter()
                    .all(|t| t.status == TaskStatus::Integrated),
            "plan is sealed for final acceptance or already settled"
        );
        let (reply, receive) = oneshot::channel();
        self.commands
            .try_send(Command {
                key,
                expected,
                plan,
                reply,
            })
            .map_err(|_| anyhow::anyhow!("workgroup control mailbox full or owner settled"))?;
        receive
            .await
            .context("workgroup settled before revision acknowledgement")?
    }
}

impl Workgroup {
    pub(super) async fn revise(&mut self, command: Command) -> Result<()> {
        let validate = || -> Result<(String, Option<u64>)> {
            let hash = format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&(command.expected, &command.plan))?)
            );
            if let Some(prior) = self.record.revisions.get(&command.key) {
                ensure!(
                    prior.digest == hash,
                    "revision key reused with different arguments"
                );
                return Ok((hash, Some(prior.plan_revision)));
            }
            ensure!(
                self.record.revisions.len() < 128,
                "revision budget exhausted"
            );
            ensure!(
                command.expected == self.record.plan_revision,
                "stale plan revision"
            );
            ensure!(
                command.plan.objective == self.record.objective,
                "objective is immutable"
            );
            let allowed: Vec<_> = self
                .record
                .tasks
                .iter()
                .flat_map(|t| t.spec.writes.clone())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            validate_directory_scope(
                &command.plan,
                if self.record.authorized_writes.is_empty()
                    && self.record.authorized_directories.is_empty()
                {
                    &allowed
                } else {
                    &self.record.authorized_writes
                },
                &self.record.authorized_directories,
            )?;
            // Retain identity and order; append is deterministic and never lets
            // an old generation submit under a replacement contract.
            ensure!(
                command.plan.tasks.len() >= self.record.tasks.len(),
                "tasks cannot be removed; revise or depend on them"
            );
            for (old, new) in self.record.tasks.iter().zip(&command.plan.tasks) {
                ensure!(old.spec.id == new.id, "task identity/order is immutable");
                ensure!(
                    old.spec == *new || (old.status == TaskStatus::Ready && old.generation == 0),
                    "only unstarted tasks can be revised: {}",
                    old.spec.id
                );
                ensure!(
                    old.spec.checks.iter().all(|c| new.checks.contains(c)),
                    "task checks cannot be removed"
                );
            }
            Ok((hash, None))
        };
        let (hash, prior) = match validate() {
            Ok(result) => result,
            Err(error) => {
                let _ = command.reply.send(Err(error));
                return Ok(());
            }
        };
        if let Some(revision) = prior {
            let _ = command.reply.send(Ok(revision));
            return Ok(());
        }
        for (index, spec) in command.plan.tasks.into_iter().enumerate() {
            if let Some(task) = self.record.tasks.get_mut(index) {
                task.spec = spec;
            } else {
                self.record.tasks.push(TaskState {
                    spec,
                    generation: 0,
                    status: TaskStatus::Ready,
                    base: None,
                    artifact: None,
                    feedback: String::new(),
                });
            }
        }
        self.record.plan_revision += 1;
        self.record.revisions.insert(
            command.key,
            Revision {
                digest: hash,
                plan_revision: self.record.plan_revision,
            },
        );
        self.save_async().await?;
        let _ = command.reply.send(Ok(self.record.plan_revision));
        Ok(())
    }
}
