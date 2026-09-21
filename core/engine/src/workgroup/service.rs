//! Core service shared by model tools and clients. Executors remain replaceable;
//! no transport, model credentials or Runtime deployment grants enter the plan.
use super::*;
use futures_util::FutureExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, Semaphore};
use tokio_util::task::TaskTracker;

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    #[serde(default)]
    pub allowed_writes: Vec<String>,
    #[serde(default)]
    pub allowed_directories: Vec<String>,
    pub checks: Vec<Vec<String>>,
    #[serde(default = "eight")]
    pub workers: usize,
    #[serde(default = "two")]
    pub verifiers: usize,
    #[serde(default = "eight")]
    pub active_groups: usize,
    #[serde(default = "seconds")]
    pub timeout_seconds: u64,
    #[serde(default = "command_timeout")]
    pub command_timeout_ms: u64,
    #[serde(default = "requests")]
    pub max_model_requests: usize,
}
fn eight() -> usize {
    8
}
fn two() -> usize {
    2
}
fn seconds() -> u64 {
    600
}
fn command_timeout() -> u64 {
    300_000
}
fn requests() -> usize {
    128
}

impl Policy {
    pub fn validate(&self) -> Result<()> {
        validate_commands(&self.checks, true)?;
        ensure!(
            serde_json::to_vec(self)?.len() <= 64 * 1024,
            "workgroup policy exceeds 64 KiB"
        );
        ensure!(
            (!self.allowed_writes.is_empty() || !self.allowed_directories.is_empty())
                && self.allowed_directories.len() <= 64
                && self.allowed_directories.iter().all(|p| tree::valid_path(p))
                && self.allowed_writes.len() <= 1024
                && self.allowed_writes.iter().all(|p| tree::valid_path(p)),
            "invalid policy write scope"
        );
        ensure!(
            (1..=32).contains(&self.workers)
                && (1..=8).contains(&self.verifiers)
                && (1..=64).contains(&self.active_groups)
                && (1..=86400).contains(&self.timeout_seconds)
                && (1..=86_400_000).contains(&self.command_timeout_ms)
                && (1..=10000).contains(&self.max_model_requests),
            "invalid workgroup policy limits"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Start {
    pub request_id: String,
    pub plan: Plan,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workers: Option<usize>,
    #[serde(default)]
    pub admission: Admission,
}

/// Instantiated by the trusted server, never by an agent-provided command.
pub trait Factory: Send + Sync + 'static {
    fn executor(&self, root: &Path, policy: &Policy) -> Result<Arc<dyn Executor>>;
}

pub struct NativeFactory {
    pub catalog: Option<std::sync::Weak<crate::Engine>>,
    pub model: Arc<dyn crate::model::Model>,
    pub watchdog_disable: bool,
    pub runtime: PathBuf,
    pub file_helper: PathBuf,
    pub toolchain: Option<PathBuf>,
}
impl Factory for NativeFactory {
    fn executor(&self, root: &Path, policy: &Policy) -> Result<Arc<dyn Executor>> {
        let capacity = self
            .model
            .load()
            .map_or(policy.workers, |m| m.capacity.min(policy.workers))
            .max(1);
        let model =
            native::SharedModel::new(self.model.clone(), capacity, policy.max_model_requests)?;
        let mut executor = native::NativeExecutor::new(
            model,
            root.join("bindings"),
            self.runtime.clone(),
            self.file_helper.clone(),
            self.toolchain.clone(),
        )?;
        executor.catalog = self.catalog.clone();
        executor.watchdog_disable = self.watchdog_disable;
        executor.runtime_limits.wall_time_ms = policy.command_timeout_ms;
        Ok(Arc::new(executor))
    }
}

struct Pooled {
    inner: Arc<dyn Executor>,
    workers: Arc<Semaphore>,
    verifiers: Arc<Semaphore>,
}
#[async_trait]
impl Executor for Pooled {
    fn model_load(&self) -> Option<crate::model::ModelLoad> {
        self.inner.model_load()
    }
    async fn attempt(
        &self,
        task: Task,
        generation: u32,
        base: Tree,
        seed: Option<Tree>,
        feedback: String,
        cancel: CancellationToken,
    ) -> Result<Tree> {
        let permit = tokio::select! { biased;
            _ = cancel.cancelled() => anyhow::bail!("cancelled before worker admission"),
            permit = self.workers.acquire() => permit?,
        };
        let result = std::panic::AssertUnwindSafe(
            self.inner
                .attempt(task, generation, base, seed, feedback, cancel),
        )
        .catch_unwind()
        .await
        .unwrap_or_else(|_| Err(CleanupFailure::Worker.into()));
        if result
            .as_ref()
            .is_err_and(|e| e.downcast_ref::<CleanupFailure>().is_some())
        {
            permit.forget();
        }
        result
    }
    async fn verify(
        &self,
        tree: Tree,
        checks: Vec<Vec<String>>,
        cancel: CancellationToken,
    ) -> Result<Check> {
        let permit = tokio::select! { biased;
            _ = cancel.cancelled() => anyhow::bail!("cancelled before verification admission"),
            permit = self.verifiers.acquire() => permit?,
        };
        let result = std::panic::AssertUnwindSafe(self.inner.verify(tree, checks, cancel))
            .catch_unwind()
            .await
            .unwrap_or_else(|_| Err(CleanupFailure::Verification.into()));
        if result
            .as_ref()
            .is_err_and(|e| e.downcast_ref::<CleanupFailure>().is_some())
        {
            permit.forget();
        }
        result
    }
}

#[derive(Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Intent {
    owner: String,
    hash: String,
    request: Start,
}
struct Entry {
    intent: Intent,
    control: Control,
    cancel: CancellationToken,
}

pub struct Service {
    _lock: std::fs::File,
    root: PathBuf,
    workspace: PathBuf,
    policy: Policy,
    factory: Arc<dyn Factory>,
    entries: Mutex<BTreeMap<String, Entry>>,
    // Serializes creation/retry deduplication only, never execution or waits.
    admission: Mutex<()>,
    workers: Arc<Semaphore>,
    verifiers: Arc<Semaphore>,
    active: Arc<Semaphore>,
    tasks: TaskTracker,
    stop: CancellationToken,
}

impl Service {
    pub fn open(
        root: &Path,
        workspace: &Path,
        policy: Policy,
        factory: Arc<dyn Factory>,
    ) -> Result<Arc<Self>> {
        policy.validate()?;
        std::fs::create_dir_all(root)?;
        let root = root.canonicalize()?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join("owner.lock"))?;
        fs2::FileExt::try_lock_exclusive(&lock)
            .context("workgroup service already owned by another process")?;
        let workspace = workspace.canonicalize()?;
        ensure!(
            !root.starts_with(&workspace),
            "workgroup storage must be outside source workspace"
        );
        let mut entries = BTreeMap::new();
        for entry in std::fs::read_dir(&root)? {
            let path = entry?.path();
            if path.file_name().is_some_and(|name| name == "owner.lock") {
                continue;
            }
            ensure!(
                path.is_dir() && !path.is_symlink(),
                "invalid workgroup store entry"
            );
            let id = path
                .file_name()
                .and_then(|n| n.to_str())
                .context("invalid workgroup ID")?
                .to_owned();
            // An interrupted creation with no intent could never launch workers.
            // Check this first: the crash may precede even owner.lock/run.json.
            let bytes = match std::fs::read(path.join("request.json")) {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            let intent: Intent = serde_json::from_slice(&bytes)?;
            let record = Workgroup::inspect(&path)?;
            let (control, _) = Control::new(&record);
            entries.insert(
                id,
                Entry {
                    intent,
                    control,
                    cancel: CancellationToken::new(),
                },
            );
            ensure!(entries.len() <= 1024, "workgroup history capacity exceeded");
        }
        Ok(Arc::new(Self {
            _lock: lock,
            root,
            workspace,
            workers: Arc::new(Semaphore::new(policy.workers)),
            verifiers: Arc::new(Semaphore::new(policy.verifiers)),
            active: Arc::new(Semaphore::new(policy.active_groups)),
            policy,
            factory,
            entries: Mutex::new(entries),
            admission: Mutex::new(()),
            tasks: TaskTracker::new(),
            stop: CancellationToken::new(),
        }))
    }

    pub fn policy(&self) -> &Policy {
        &self.policy
    }

    pub async fn start(
        self: &Arc<Self>,
        owner: String,
        request: Start,
        parent: CancellationToken,
    ) -> Result<Value> {
        ensure!(
            !owner.is_empty()
                && owner.len() <= 256
                && !request.request_id.is_empty()
                && request.request_id.len() <= 128,
            "invalid owner/request ID"
        );
        validate(&request.plan)?;
        validate_directory_scope(
            &request.plan,
            &self.policy.allowed_writes,
            &self.policy.allowed_directories,
        )?;
        let workers = request.workers.unwrap_or(2.min(self.policy.workers));
        ensure!(
            (1..=self.policy.workers).contains(&workers),
            "workers exceed deployment policy"
        );
        let bytes = serde_json::to_vec(&request)?;
        ensure!(
            bytes.len() <= 256 * 1024,
            "workgroup request exceeds 256 KiB"
        );
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let id = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(&owner, &request.request_id))?)
        );
        let service = self.clone();
        // Persisted intent/owner lives past a dropped RPC/tool response.
        tokio::spawn(async move {
            let _admission = service.admission.lock().await;
            ensure!(
                !service.stop.is_cancelled() && !parent.is_cancelled(),
                "workgroup service is stopping"
            );
            {
                let entries = service.entries.lock().await;
                if let Some(entry) = entries.get(&id) {
                    ensure!(
                        entry.intent.hash == hash,
                        "request ID reused with different arguments"
                    );
                    return Ok(service.view(&id, &entry.control.read()));
                }
                ensure!(entries.len() < 1024, "workgroup history capacity exceeded");
            }
            let active = service
                .active
                .clone()
                .try_acquire_owned()
                .context("active workgroup limit reached")?;
            let path = service.root.join(&id);
            let base_root = service.workspace.clone();
            let planned = request.plan.clone();
            let root = path.clone();
            let checks = service.policy.checks.clone();
            let authority = service.policy.clone();
            let (mut group, base) = tokio::task::spawn_blocking(move || -> Result<_> {
                let base = tree::snapshot(&base_root)?;
                // Keep explicit client task IDs for live revision and observation.
                let mut group = Workgroup::create(&root, planned, &base, Strategy::Contract)?;
                group.record.authorized_directories = authority.allowed_directories;
                group.record.authorized_writes = authority.allowed_writes;
                group.save()?;
                Ok((group, base))
            })
            .await??;
            let intent = Intent {
                owner,
                hash,
                request: request.clone(),
            };
            let save_intent = intent.clone();
            let save_path = path.clone();
            tokio::task::spawn_blocking(move || -> Result<()> {
                let mut file = tempfile::NamedTempFile::new_in(&save_path)?;
                serde_json::to_writer(&mut file, &save_intent)?;
                file.as_file().sync_all()?;
                file.persist(save_path.join("request.json"))?;
                std::fs::File::open(save_path)?.sync_all()?;
                Ok(())
            })
            .await??;
            let control = group.control();
            let cancel = parent.child_token();
            let inner = match service.factory.executor(&path, &service.policy) {
                Ok(inner) => inner,
                Err(error) => {
                    group.record.status = "failed".into();
                    group.record.error = Some(bounded(&error.to_string()));
                    group.record.cleanup_confirmed = Some(true);
                    group.save_async().await?;
                    service.entries.lock().await.insert(
                        id.clone(),
                        Entry {
                            intent,
                            control: control.clone(),
                            cancel,
                        },
                    );
                    return Ok(service.view(&id, &control.read()));
                }
            };
            let executor: Arc<dyn Executor> = Arc::new(Pooled {
                inner,
                workers: service.workers.clone(),
                verifiers: service.verifiers.clone(),
            });
            let options = Options {
                workers,
                admission: request.admission,
                initial_workers: 0,
                timeout: Duration::from_secs(service.policy.timeout_seconds),
                strategy: Strategy::Contract,
                ..Options::default()
            };
            service.entries.lock().await.insert(
                id.clone(),
                Entry {
                    intent,
                    control: control.clone(),
                    cancel: cancel.clone(),
                },
            );
            let response = service.view(&id, &control.read());
            service.tasks.spawn(async move {
                let result = group.run(base, executor, checks, options, cancel).await;
                let confirmed = result
                    .as_ref()
                    .is_ok_and(|r| r.cleanup_confirmed == Some(true));
                if !confirmed {
                    active.forget();
                }
                if let Err(error) = result {
                    // Storage/panic failures cannot masquerade as a reusable finished group.
                    let mut record = (*control.read()).clone();
                    record.status = "unknown".into();
                    record.error = Some(bounded(&error.to_string()));
                    record.cleanup_confirmed = Some(false);
                    record.revision += 1;
                    control.publish(&record);
                }
            });
            Ok(response)
        })
        .await?
    }

    fn view(&self, id: &str, record: &Record) -> Value {
        let mut projection = json!(record);
        projection.as_object_mut().unwrap().remove("history");
        projection.as_object_mut().unwrap().remove("verifications");
        json!({"id":id, "record":projection, "historyCount":record.history.len(),"verificationCount":record.verifications.len(),
            "recordPath":self.root.join(id).join("run.json"), "candidatePath":self.root.join(id).join("candidate")})
    }

    async fn get(&self, id: &str, owner: Option<&str>) -> Result<(Control, CancellationToken)> {
        let entries = self.entries.lock().await;
        let entry = entries.get(id).context("workgroup not found")?;
        ensure!(
            owner.is_none_or(|o| o == entry.intent.owner),
            "workgroup belongs to another owner"
        );
        Ok((entry.control.clone(), entry.cancel.clone()))
    }
    pub async fn read(&self, id: &str, owner: Option<&str>) -> Result<Value> {
        Ok(self.view(id, &self.get(id, owner).await?.0.read()))
    }
    /// Bounded access to an accepted artifact, including its original CAS hash.
    /// Parent agents need this broker because their Runtime cannot read private
    /// worker/storage paths. It never grants write access to those paths.
    pub async fn artifact(
        &self,
        id: &str,
        owner: Option<&str>,
        path: Option<String>,
        offset: usize,
    ) -> Result<Value> {
        let record = self.get(id, owner).await?.0.read();
        ensure!(
            record.status == "completed"
                && record.cleanup_confirmed == Some(true)
                && record.final_check.as_ref().is_some_and(|c| c.passed),
            "artifact has not passed final acceptance"
        );
        let root = self.root.join(id);
        tokio::task::spawn_blocking(move || -> Result<Value> {
            use base64::{Engine, engine::general_purpose::STANDARD};
            let head = tree::load(&root,&record.head)?;
            let base = tree::load(&root,record.history.first().map_or(&record.head,|a|&a.base))?;
            let changed: BTreeSet<_> = base.keys().chain(head.keys()).filter(|p|base.get(*p)!=head.get(*p)).collect();
            let Some(path)=path else {
                ensure!(offset<=changed.len(),"artifact list offset outside change set");
                let mut used=0;let paths:Vec<_>=changed.iter().skip(offset).take_while(|p|{used+=p.len();used<=6000}).copied().collect();
                return Ok(json!({"head":record.head,"paths":paths,"nextOffset":offset+paths.len(),"complete":offset+paths.len()==changed.len()}));
            };
            ensure!(tree::valid_path(&path) && changed.contains(&path), "path is not a changed artifact file");
            let before=base.get(&path);let after=head.get(&path);
            let bytes=after.map_or(&[][..],|f|f.bytes.as_slice());
            ensure!(offset<=bytes.len(),"artifact offset outside file");
            let end=(offset+4096).min(bytes.len());let chunk=&bytes[offset..end];
            let hash=|f:&tree::File| format!("{:x}",Sha256::digest(&f.bytes));
            Ok(json!({"head":record.head,"path":path,"exists":after.is_some(),"baseSha256":before.map(hash),
                "sha256":after.map(hash),"executable":after.map(|f|f.executable),"bytes":bytes.len(),
                "offset":offset,"nextOffset":end,"complete":end==bytes.len(),"dataBase64":STANDARD.encode(chunk),
                "text":std::str::from_utf8(chunk).ok().filter(|text|text.chars().all(|c|!c.is_control()||matches!(c,'\n'|'\r'|'\t')))}))
        }).await?
    }
    pub async fn list(&self) -> Value {
        let entries = self.entries.lock().await;
        json!(
            entries
                .iter()
                .map(|(id, e)| {
                    let r = e.control.read();
                    json!({"id":id,"owner":e.intent.owner,"status":r.status,"revision":r.revision,
                "cleanupConfirmed":r.cleanup_confirmed,"cleanupError":r.cleanup_error,"objective":r.objective.chars().take(128).collect::<String>(),"peakWorkers":r.peak_workers,"head":r.head})
                })
                .collect::<Vec<_>>()
        )
    }
    pub async fn wait(
        &self,
        id: &str,
        owner: Option<&str>,
        after: u64,
        timeout: Duration,
    ) -> Result<Value> {
        ensure!(
            timeout <= Duration::from_secs(60),
            "wait must be at most 60 seconds"
        );
        let control = self.get(id, owner).await?.0;
        Ok(self.view(id, control.wait(after, timeout).await.as_ref()))
    }
    pub async fn cancel(&self, id: &str, owner: Option<&str>) -> Result<Value> {
        self.get(id, owner).await?.1.cancel();
        self.read(id, owner).await
    }
    pub async fn revise(
        &self,
        id: &str,
        owner: Option<&str>,
        key: String,
        expected: u64,
        plan: Plan,
    ) -> Result<Value> {
        validate_directory_scope(
            &plan,
            &self.policy.allowed_writes,
            &self.policy.allowed_directories,
        )?;
        self.get(id, owner)
            .await?
            .0
            .revise(key, expected, plan)
            .await?;
        self.read(id, owner).await
    }
    pub async fn settle_owner(&self, owner: &str, cancel: bool) -> Result<Vec<Value>> {
        let targets: Vec<_> = self
            .entries
            .lock()
            .await
            .iter()
            .filter(|(_, e)| e.intent.owner == owner)
            .map(|(id, e)| (id.clone(), e.control.clone(), e.cancel.clone()))
            .collect();
        let mut result = vec![];
        if cancel {
            // Broadcast before any cleanup barrier; one slow group must not
            // delay cancellation or consume model budget in its siblings.
            for (_, _, token) in &targets {
                token.cancel();
            }
        }
        for (id, control, _) in targets {
            loop {
                let record = control.read();
                if record.status != "running" {
                    result.push(self.view(&id, &record));
                    break;
                }
                control.wait(record.revision, Duration::from_secs(60)).await;
            }
        }
        Ok(result)
    }
    pub async fn shutdown(&self) {
        self.stop.cancel();
        let _admission = self.admission.lock().await;
        for entry in self.entries.lock().await.values() {
            entry.cancel.cancel();
        }
        self.tasks.close();
        drop(_admission);
        self.tasks.wait().await;
    }
}
