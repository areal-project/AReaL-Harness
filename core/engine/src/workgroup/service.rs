//! Core service shared by model tools and clients. Executors remain replaceable;
//! no transport, model credentials or Runtime deployment grants enter the plan.
use super::*;
use futures_util::FutureExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, Semaphore, watch};
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
    #[serde(default)]
    pub timeout_seconds: u64,
    #[serde(default = "command_timeout")]
    pub command_timeout_ms: u64,
    #[serde(default)]
    pub max_model_requests: usize,
}
fn eight() -> usize {
    8
}
fn two() -> usize {
    2
}
fn command_timeout() -> u64 {
    300_000
}

impl Policy {
    pub fn validate(&self) -> Result<()> {
        self.validate_mode(true)
    }

    fn validate_mode(&self, strict: bool) -> Result<()> {
        validate_commands(&self.checks, strict)?;
        ensure!(
            serde_json::to_vec(self)?.len() <= 64 * 1024,
            "workgroup policy exceeds 64 KiB"
        );
        ensure!(
            (!strict || !self.allowed_writes.is_empty() || !self.allowed_directories.is_empty())
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
                && self.timeout_seconds <= 86400
                && (1..=86_400_000).contains(&self.command_timeout_ms)
                && self.max_model_requests <= 10000,
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

/// 探针失败只有确认没有遗留 Runtime 资源时才允许创建前改选共享执行。
#[derive(Clone, Debug, thiserror::Error)]
pub enum AvailabilityError {
    #[error("native isolation unavailable: {0}")]
    Unavailable(String),
    #[error("native isolation probe cleanup UNKNOWN: {0}")]
    CleanupUnknown(String),
}

/// Instantiated by the trusted server, never by an agent-provided command.
#[async_trait]
pub trait Factory: Send + Sync + 'static {
    /// 只返回已提交的报告；默认执行器没有交接正文，不把状态标题伪装成报告。
    async fn handoff(
        &self,
        _root: &Path,
        _task: &str,
        _generation: u32,
        _offset: usize,
    ) -> Result<Option<Value>> {
        Ok(None)
    }
    async fn trace(&self, _root: &Path) -> Result<Vec<areal_protocol::Thread>> {
        anyhow::bail!("executor does not expose internal traces")
    }
    async fn trace_result(&self, _root: &Path, _thread: &str, _uri: &str) -> Result<Vec<u8>> {
        anyhow::bail!("executor does not expose original results")
    }
    /// 自定义执行器保留原准入；原生工厂必须覆盖并核验实际隔离环境。
    async fn probe_availability(&self, _root: &Path) -> std::result::Result<(), AvailabilityError> {
        Ok(())
    }
    fn executor(&self, root: &Path, policy: &Policy) -> Result<Arc<dyn Executor>>;
    /// 自定义工厂必须显式接入目标预算，禁止默默绕过计量。
    fn executor_for_goal(
        &self,
        root: &Path,
        policy: &Policy,
        budget: Option<Arc<crate::goals::Budget>>,
    ) -> Result<Arc<dyn Executor>> {
        ensure!(
            budget.is_none(),
            "executor does not support Goal accounting"
        );
        self.executor(root, policy)
    }
}

pub struct NativeFactory {
    pub worker_limits: crate::Limits,
    pub catalog: Option<std::sync::Weak<crate::Engine>>,
    pub model: Arc<dyn crate::model::Model>,
    pub watchdog_disable: bool,
    pub tool_call_limits: crate::model::ToolCallLimits,
    pub runtime: PathBuf,
    pub file_helper: PathBuf,
    pub toolchain: Option<PathBuf>,
}
#[async_trait]
impl Factory for NativeFactory {
    async fn handoff(
        &self,
        root: &Path,
        task: &str,
        generation: u32,
        offset: usize,
    ) -> Result<Option<Value>> {
        let root = root.join("bindings");
        let task = task.to_owned();
        tokio::task::spawn_blocking(move || super::handoff::read(&root, &task, generation, offset))
            .await?
    }
    async fn trace(&self, root: &Path) -> Result<Vec<areal_protocol::Thread>> {
        let root = root.join("bindings");
        let maximum = self.worker_limits.max_history_bytes.max(1024 * 1024);
        tokio::task::spawn_blocking(move || -> Result<_> {
            let mut threads = Vec::new();
            for entry in std::fs::read_dir(root)? {
                let entry = entry?;
                let binding = entry.path().join("binding.json");
                if !binding.is_file() {
                    continue;
                }
                let binding: Value = serde_json::from_slice(&std::fs::read(binding)?)?;
                let id = binding["threadId"]
                    .as_str()
                    .context("worker binding has no thread ID")?;
                let thread = crate::store::Store::read_snapshot_at(
                    &entry.path().join("history"),
                    id,
                    maximum,
                    true,
                )?;
                threads.push(thread);
            }
            threads.sort_by_key(|t| (t.created_at, t.id.clone()));
            Ok(threads)
        })
        .await?
    }
    async fn trace_result(&self, root: &Path, thread: &str, uri: &str) -> Result<Vec<u8>> {
        use sha2::{Digest, Sha256};
        let root = root.join("bindings");
        let thread = thread.to_owned();
        let uri = uri.to_owned();
        let maximum = self.worker_limits.max_history_bytes.max(1024 * 1024);
        tokio::task::spawn_blocking(move || -> Result<_> {
            let blob = uri.strip_prefix("areal://blob/").context("invalid result URI")?;
            ensure!(blob.len() == 64 && blob.bytes().all(|c| c.is_ascii_hexdigit()), "invalid result blob");
            for entry in std::fs::read_dir(root)? {
                let path = entry?.path();
                if !path.join("binding.json").is_file() { continue; }
                let binding: Value = serde_json::from_slice(&std::fs::read(path.join("binding.json"))?)?;
                if binding["threadId"] != thread { continue; }
                let snapshot = crate::store::Store::read_snapshot_at(&path.join("history"), &thread, maximum, true)?;
                ensure!(snapshot.turns.iter().flat_map(|t| &t.items).any(|i| matches!(i, areal_protocol::Item::DynamicToolCall { execution, .. } if execution.result_snapshot.as_ref().is_some_and(|m| m.uri == uri))), "result does not belong to worker history");
                let path = path.join("history/blobs").join(blob);
                ensure!(std::fs::metadata(&path)?.len() <= 32 * 1024 * 1024, "original result exceeds read bound");
                let bytes = std::fs::read(path)?;
                ensure!(format!("{:x}", Sha256::digest(&bytes)) == blob, "result integrity mismatch");
                return Ok(bytes);
            }
            anyhow::bail!("worker result unavailable")
        }).await?
    }
    async fn probe_availability(&self, root: &Path) -> std::result::Result<(), AvailabilityError> {
        native::probe_availability(&self.runtime, &self.file_helper, root).await
    }

    fn executor(&self, root: &Path, policy: &Policy) -> Result<Arc<dyn Executor>> {
        self.executor_for_goal(root, policy, None)
    }
    fn executor_for_goal(
        &self,
        root: &Path,
        policy: &Policy,
        budget: Option<Arc<crate::goals::Budget>>,
    ) -> Result<Arc<dyn Executor>> {
        let capacity = self
            .model
            .load()
            .map_or(policy.workers, |m| m.capacity.min(policy.workers))
            .max(1);
        let selected = self
            .catalog
            .as_ref()
            .and_then(std::sync::Weak::upgrade)
            .map_or_else(|| self.model.clone(), |engine| engine.default_model());
        let model = native::SharedModel::new(
            budget.map_or_else(|| selected.clone(), |b| b.wrap(selected.clone())),
            capacity,
            policy.max_model_requests,
        )?;
        let mut executor = native::NativeExecutor::new(
            model,
            root.join("bindings"),
            self.runtime.clone(),
            self.file_helper.clone(),
            self.toolchain.clone(),
        )?;
        executor.worker_limits = self.worker_limits.clone();
        executor.catalog = self.catalog.clone();
        // 仅继承可信父 Runtime 的实际网络上限；未绑定宿主的独立执行器继续默认禁网。
        executor.network = if self
            .catalog
            .as_ref()
            .and_then(std::sync::Weak::upgrade)
            .is_some_and(|engine| engine.sandbox()["networkAccess"] == true)
        {
            areal_runtime_protocol::NetworkRequest::Inherit
        } else {
            areal_runtime_protocol::NetworkRequest::Deny
        };
        executor.watchdog_disable = self.watchdog_disable;
        executor.tool_call_limits = self.tool_call_limits;
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
    trace_started: Option<std::time::Instant>,
    intent: Intent,
    control: Control,
    cancel: CancellationToken,
    // 正常 Turn 收尾会取消执行 token；已完成 patch 仍可在后续 Turn 显式交付。
    delivery_cancel: CancellationToken,
}

pub struct Service {
    _lock: std::fs::File,
    root: PathBuf,
    workspace: PathBuf,
    policy: Policy,
    strict: bool,
    factory: Arc<dyn Factory>,
    availability:
        std::sync::OnceLock<watch::Receiver<Option<std::result::Result<(), AvailabilityError>>>>,
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
        Self::open_mode(root, workspace, policy, factory, true)
    }

    /// 仅由可信宿主在已有工作区写授权下装配，不将项目自检冒充部署验收。
    pub fn open_automatic(
        root: &Path,
        workspace: &Path,
        factory: Arc<dyn Factory>,
        workers: usize,
    ) -> Result<Arc<Self>> {
        let policy = Policy {
            allowed_writes: vec![],
            allowed_directories: vec![],
            checks: vec![],
            workers: workers.clamp(1, 32),
            verifiers: 2,
            active_groups: 8,
            timeout_seconds: 0,
            command_timeout_ms: command_timeout(),
            max_model_requests: 0,
        };
        Self::open_mode(root, workspace, policy, factory, false)
    }

    fn open_mode(
        root: &Path,
        workspace: &Path,
        policy: Policy,
        factory: Arc<dyn Factory>,
        strict: bool,
    ) -> Result<Arc<Self>> {
        policy.validate_mode(strict)?;
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
                    trace_started: None,
                    intent,
                    control,
                    cancel: CancellationToken::new(),
                    delivery_cancel: CancellationToken::new(),
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
            strict,
            factory,
            availability: std::sync::OnceLock::new(),
            entries: Mutex::new(entries),
            admission: Mutex::new(()),
            tasks: TaskTracker::new(),
            stop: CancellationToken::new(),
        }))
    }

    pub async fn probe_availability(
        self: &Arc<Self>,
    ) -> std::result::Result<(), AvailabilityError> {
        let admission = self.admission.lock().await;
        if self.stop.is_cancelled() {
            return Err(AvailabilityError::CleanupUnknown(
                "service is stopping".into(),
            ));
        }
        let mut received = self
            .availability
            .get_or_init(|| {
                let (sent, received) = watch::channel(None);
                let service = self.clone();
                // 探针拥有独立的清理寿命；取消一个等待者不会丢掉私有 Runtime。
                self.tasks.spawn(async move {
                    let result = std::panic::AssertUnwindSafe(
                        service.factory.probe_availability(&service.root),
                    )
                    .catch_unwind()
                    .await
                    .unwrap_or_else(|_| {
                        Err(AvailabilityError::CleanupUnknown(
                            "capability probe panicked".into(),
                        ))
                    });
                    sent.send_replace(Some(result));
                });
                received
            })
            .clone();
        drop(admission);
        loop {
            if let Some(result) = received.borrow().clone() {
                return result;
            }
            received.changed().await.map_err(|_| {
                AvailabilityError::CleanupUnknown("capability probe lost its result".into())
            })?;
        }
    }

    pub fn is_strict(&self) -> bool {
        self.strict
    }

    pub fn workspace(&self) -> &Path {
        &self.workspace
    }

    pub fn request_id(owner: &str, request_id: &str) -> Result<String> {
        Ok(format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(owner, request_id))?)
        ))
    }

    pub fn policy(&self) -> &Policy {
        &self.policy
    }

    pub fn validate_start(&self, request: &Start) -> Result<()> {
        validate(&request.plan)?;
        if self.strict {
            validate_directory_scope(
                &request.plan,
                &self.policy.allowed_writes,
                &self.policy.allowed_directories,
            )?;
        }
        let workers = request.workers.unwrap_or(2.min(self.policy.workers));
        ensure!(
            (1..=self.policy.workers).contains(&workers),
            "workers exceed deployment policy"
        );
        ensure!(
            serde_json::to_vec(request)?.len() <= 256 * 1024,
            "workgroup request exceeds 256 KiB"
        );
        Ok(())
    }

    pub async fn start(
        self: &Arc<Self>,
        owner: String,
        request: Start,
        parent: CancellationToken,
    ) -> Result<Value> {
        self.start_with_goal(owner, request, parent, None).await
    }
    pub(crate) async fn start_with_goal(
        self: &Arc<Self>,
        owner: String,
        request: Start,
        parent: CancellationToken,
        budget: Option<Arc<crate::goals::Budget>>,
    ) -> Result<Value> {
        ensure!(
            !owner.is_empty()
                && owner.len() <= 256
                && !request.request_id.is_empty()
                && request.request_id.len() <= 128,
            "invalid owner/request ID"
        );
        self.validate_start(&request)?;
        let workers = request.workers.unwrap_or(2.min(self.policy.workers));
        let bytes = serde_json::to_vec(&request)?;
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
            let strict = service.strict;
            let (mut group, base) = tokio::task::spawn_blocking(move || -> Result<_> {
                let required = planned.tasks.iter().flat_map(|task| &task.writes).map(|path| (path.clone(), tree::File { bytes: Vec::new(), executable: false })).collect();
                let base = tree::snapshot_source(&base_root, &required)?;
                // Keep explicit client task IDs for live revision and observation.
                let mut group = Workgroup::create(&root, planned, &base, Strategy::Contract)?;
                group.record.trusted_checks = strict;
                group.record.authorized_directories = authority.allowed_directories;
                group.record.authorized_writes = authority.allowed_writes;
                group.save()?;
                std::fs::write(root.join("source-projection.json"), serde_json::to_vec_pretty(&json!({
                    "version":1,"policy":"tracked, unignored and explicitly declared writable inputs; ignored products are not implicit execution dependencies",
                    "files":base.len(),"bytes":base.values().map(|file|file.bytes.len()).sum::<usize>(),
                    "tree":tree::digest(&base),"dirtyWorkspacePreserved":true
                }))?)?;
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
            let inner = match service
                .factory
                .executor_for_goal(&path, &service.policy, budget)
            {
                Ok(inner) => inner,
                Err(error) => {
                    group.record.status = "failed".into();
                    group.record.error = Some(bounded(&error.to_string()));
                    group.record.cleanup_confirmed = Some(true);
                    group.save_async().await?;
                    service.entries.lock().await.insert(
                        id.clone(),
                        Entry {
                            trace_started: None,
                            intent,
                            control: control.clone(),
                            cancel,
                            delivery_cancel: CancellationToken::new(),
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
                    trace_started: Some(std::time::Instant::now()),
                    intent,
                    control: control.clone(),
                    cancel: cancel.clone(),
                    delivery_cancel: CancellationToken::new(),
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
        let record = self.get(id, owner).await?.0.read();
        let mut value = self.view(id, &record);
        value["artifactAvailable"] = json!(self.artifact_available(&record));
        let elapsed = if record.status == "running" {
            self.entries.lock().await.get(id).and_then(|e| {
                e.trace_started
                    .map(|s| s.elapsed().as_millis().min(u64::MAX as u128) as u64)
            })
        } else {
            (record.wall_seconds > 0.0).then_some((record.wall_seconds * 1000.0) as u64)
        };
        value["elapsedMs"] = json!(elapsed);
        Ok(value)
    }

    fn artifact_available(&self, record: &Record) -> bool {
        record.status == "completed"
            && record.cleanup_confirmed == Some(true)
            && (!self.is_strict()
                || record
                    .final_check
                    .as_ref()
                    .is_some_and(|check| check.passed && check.tree_hash == record.head))
    }
    pub(crate) async fn handoff(
        &self,
        id: &str,
        owner: &str,
        offset: usize,
    ) -> Result<Option<Value>> {
        let record = self.get(id, Some(owner)).await?.0.read();
        let task = record.tasks.first().context("execution has no task")?;
        ensure!(
            record.tasks.len() == 1,
            "execution handoff requires one delegated task"
        );
        self.factory
            .handoff(&self.root.join(id), &task.spec.id, task.generation, offset)
            .await
    }
    pub(crate) async fn trace_live(&self, id: &str, owner: &str) -> Result<bool> {
        let (control, _) = self.get(id, Some(owner)).await?;
        let entries = self.entries.lock().await;
        Ok(control.read().status == "running"
            && entries
                .get(id)
                .is_some_and(|entry| entry.trace_started.is_some()))
    }
    pub(crate) async fn trace(&self, id: &str, owner: &str) -> Result<Vec<areal_protocol::Thread>> {
        self.get(id, Some(owner)).await?;
        self.factory.trace(&self.root.join(id)).await
    }
    pub(crate) async fn trace_result(
        &self,
        id: &str,
        owner: &str,
        thread: &str,
        uri: &str,
    ) -> Result<Vec<u8>> {
        self.get(id, Some(owner)).await?;
        self.factory
            .trace_result(&self.root.join(id), thread, uri)
            .await
    }
    pub(super) async fn delivery_journal(&self, id: &str) -> Result<PathBuf> {
        ensure!(
            self.entries.lock().await.contains_key(id),
            "workgroup not found"
        );
        Ok(self.root.join(id).join("delivery.json"))
    }

    pub(super) async fn delivery_bundle(
        &self,
        id: &str,
        expected_head: &str,
        allow_unverified: bool,
    ) -> Result<super::delivery::Bundle> {
        let (record, owner, cancel) = {
            let entries = self.entries.lock().await;
            let entry = entries.get(id).context("workgroup not found")?;
            if self.is_strict() {
                validate_directory_scope(
                    &entry.intent.request.plan,
                    &self.policy.allowed_writes,
                    &self.policy.allowed_directories,
                )?;
            }
            (
                entry.control.read(),
                entry.intent.owner.clone(),
                entry.delivery_cancel.clone(),
            )
        };
        ensure!(
            record.status == "completed" && record.cleanup_confirmed == Some(true),
            "workgroup candidate is not settled"
        );
        ensure!(record.head == expected_head, "workgroup candidate changed");
        let verified = record
            .final_check
            .as_ref()
            .is_some_and(|check| check.passed && check.tree_hash == record.head);
        ensure!(
            verified || (allow_unverified && !self.is_strict()),
            "artifact has not passed final acceptance"
        );
        let root = self.root.join(id);
        let workspace = self.workspace.clone();
        let strict = self.is_strict();
        tokio::task::spawn_blocking(move || -> Result<_> {
            let base = tree::load(
                &root,
                record
                    .history
                    .first()
                    .map_or(&record.head, |attempt| &attempt.base),
            )?;
            let candidate = tree::load(&root, &record.head)?;
            Ok(super::delivery::Bundle {
                owner,
                workspace,
                journal: root.join("delivery.json"),
                base,
                candidate,
                verified,
                strict,
                cancel,
            })
        })
        .await?
    }

    pub(super) async fn verify_delivery(
        &self,
        id: &str,
        candidate: Tree,
        cancel: CancellationToken,
    ) -> Result<Option<Check>> {
        ensure!(
            self.entries.lock().await.contains_key(id),
            "workgroup not found"
        );
        if self.policy.checks.is_empty() {
            ensure!(!self.is_strict(), "strict delivery requires trusted checks");
            return Ok(None);
        }
        // 验证目录属于原组，避免被服务恢复误识别为另一个组；检查只能来自可信 policy。
        let root = self
            .root
            .join(id)
            .join(format!("delivery-verification-{}", uuid::Uuid::new_v4()));
        let factory = self.factory.clone();
        let policy = self.policy.clone();
        let inner = tokio::task::spawn_blocking(move || factory.executor(&root, &policy)).await??;
        let executor = Pooled {
            inner,
            workers: self.workers.clone(),
            verifiers: self.verifiers.clone(),
        };
        Ok(Some(
            executor
                .verify(candidate, self.policy.checks.clone(), cancel)
                .await?,
        ))
    }

    /// 有界读取已结算候选及原始 CAS；自动组未执行可信验收时 verified 保持 false。
    /// 父 Agent 通过此接口读取私有制品，不能获得 worker/storage 路径写权限。
    pub async fn artifact(
        &self,
        id: &str,
        owner: Option<&str>,
        path: Option<String>,
        offset: usize,
    ) -> Result<Value> {
        let record = self.get(id, owner).await?.0.read();
        ensure!(
            self.artifact_available(&record),
            "artifact is not settled or has not passed required final acceptance"
        );
        let root = self.root.join(id);
        let verified = record
            .final_check
            .as_ref()
            .is_some_and(|c| c.passed && c.tree_hash == record.head);
        tokio::task::spawn_blocking(move || -> Result<Value> {
            use base64::{Engine, engine::general_purpose::STANDARD};
            let head = tree::load(&root,&record.head)?;
            let base = tree::load(&root,record.history.first().map_or(&record.head,|a|&a.base))?;
            let changed: BTreeSet<_> = base.keys().chain(head.keys()).filter(|p|base.get(*p)!=head.get(*p)).collect();
            let Some(path)=path else {
                ensure!(offset<=changed.len(),"artifact list offset outside change set");
                let mut used=0;let paths:Vec<_>=changed.iter().skip(offset).take_while(|p|{used+=p.len();used<=6000}).copied().collect();
                return Ok(json!({"head":record.head,"verified":verified,"paths":paths,"nextOffset":offset+paths.len(),"complete":offset+paths.len()==changed.len()}));
            };
            ensure!(tree::valid_path(&path) && changed.contains(&path), "path is not a changed artifact file");
            let before=base.get(&path);let after=head.get(&path);
            let bytes=after.map_or(&[][..],|f|f.bytes.as_slice());
            ensure!(offset<=bytes.len(),"artifact offset outside file");
            let end=(offset+4096).min(bytes.len());let chunk=&bytes[offset..end];
            let hash=|f:&tree::File| format!("{:x}",Sha256::digest(&f.bytes));
            Ok(json!({"head":record.head,"verified":verified,"path":path,"exists":after.is_some(),"baseSha256":before.map(hash),
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
        let (_, cancel) = self.get(id, owner).await?;
        self.entries
            .lock()
            .await
            .get(id)
            .unwrap()
            .delivery_cancel
            .cancel();
        cancel.cancel();
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
