//! Production adapter: the existing Rust Engine tool loop, one Runtime per
//! private attempt/verification workspace, and one shared model admission pool.
use super::*;
use crate::{
    Engine, Limits,
    model::{Message, Model, ModelEvent, ModelFailure, ModelLoad, ModelStream},
    tools::{RuntimeConfig, verify_command},
};
use areal_protocol::{Input, ModelUsage, TurnStatus};
use areal_runtime_client::Client;
use futures_util::{Stream, StreamExt};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    pin::Pin,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    task::{Context as TaskContext, Poll},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub requests: usize,
    pub finished_requests: usize,
    pub unknown_requests: usize,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_input_tokens: u64,
}

pub struct SharedModel {
    inner: Arc<dyn Model>,
    permits: Arc<Semaphore>,
    max_requests: usize,
    usage: Arc<Mutex<Usage>>,
    load: Arc<Mutex<LoadState>>,
}

struct LoadState {
    snapshot: ModelLoad,
    updated: tokio::time::Instant,
}

impl LoadState {
    fn update(&mut self) {
        let now = tokio::time::Instant::now();
        let seconds = now.duration_since(self.updated).as_secs_f64();
        self.snapshot.elapsed_seconds += seconds;
        if self.snapshot.waiting > 0 {
            self.snapshot.queued_seconds += seconds;
        }
        self.snapshot.occupied_slot_seconds += seconds * self.snapshot.in_flight as f64;
        self.updated = now;
    }
}

/// RAII counts cancellation during permit wait, HTTP setup, and stream polling.
/// No request/usage is invented when a waiter is cancelled before admission.
struct RequestLoad {
    load: Arc<Mutex<LoadState>>,
    active: bool,
}

impl RequestLoad {
    fn waiting(load: Arc<Mutex<LoadState>>) -> Self {
        {
            let mut state = load.lock().unwrap();
            state.update();
            state.snapshot.waiting += 1;
        }
        Self {
            load,
            active: false,
        }
    }
    fn start(mut self) -> Self {
        let mut state = self.load.lock().unwrap();
        state.update();
        state.snapshot.waiting -= 1;
        state.snapshot.in_flight += 1;
        state.snapshot.started_requests += 1;
        self.active = true;
        drop(state);
        self
    }
    fn completed(&self) {
        self.load.lock().unwrap().snapshot.completed_requests += 1;
    }
}

impl Drop for RequestLoad {
    fn drop(&mut self) {
        let mut state = self.load.lock().unwrap();
        state.update();
        if self.active {
            state.snapshot.in_flight -= 1;
        } else {
            state.snapshot.waiting -= 1;
        }
    }
}

struct InFlight {
    // Drop the load count before releasing the permit to a new caller.
    load: RequestLoad,
    _permit: OwnedSemaphorePermit,
}

impl SharedModel {
    /// Daemon-wide pool; request budgets belong to individual workgroups.
    pub fn pool(inner: Arc<dyn Model>, concurrency: usize) -> Result<Arc<Self>> {
        ensure!(
            concurrency > 0 && concurrency <= Semaphore::MAX_PERMITS,
            "invalid model concurrency"
        );
        let mut pool = Self::new(inner, 1, 1)?;
        let value = Arc::get_mut(&mut pool).unwrap();
        value.permits = Arc::new(Semaphore::new(concurrency));
        value.max_requests = usize::MAX;
        value.load.lock().unwrap().snapshot.capacity = concurrency;
        Ok(pool)
    }
    pub fn new(
        inner: Arc<dyn Model>,
        concurrency: usize,
        max_requests: usize,
    ) -> Result<Arc<Self>> {
        ensure!(
            (1..=32).contains(&concurrency) && (1..=10000).contains(&max_requests),
            "invalid root model limits"
        );
        Ok(Arc::new(Self {
            inner,
            permits: Arc::new(Semaphore::new(concurrency)),
            max_requests,
            usage: Arc::new(Mutex::new(Usage::default())),
            load: Arc::new(Mutex::new(LoadState {
                snapshot: ModelLoad {
                    capacity: concurrency,
                    ..ModelLoad::default()
                },
                updated: tokio::time::Instant::now(),
            })),
        }))
    }
    pub fn usage(&self) -> Usage {
        let mut usage = self.usage.lock().unwrap().clone();
        usage.unknown_requests = usage.requests - usage.finished_requests;
        usage
    }
}

struct MeteredStream {
    inner: ModelStream,
    request: InFlight,
    usage: Arc<Mutex<Usage>>,
    last_usage: Option<ModelUsage>,
    settled: bool,
    failed: bool,
}

impl Stream for MeteredStream {
    type Item = anyhow::Result<ModelEvent>;
    fn poll_next(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        let next = this.inner.as_mut().poll_next(cx);
        if matches!(&next, Poll::Ready(Some(Err(_)))) {
            this.failed = true;
        }
        if let Poll::Ready(Some(Ok(ModelEvent::Usage(usage)))) = &next {
            this.last_usage = Some(usage.clone());
        }
        if matches!(&next, Poll::Ready(None)) && !this.settled && !this.failed {
            this.settled = true;
            this.request.load.completed();
            if let Some(last) = &this.last_usage {
                let mut total = this.usage.lock().unwrap();
                total.finished_requests += 1;
                total.input_tokens = total.input_tokens.saturating_add(last.input_tokens);
                total.output_tokens = total.output_tokens.saturating_add(last.output_tokens);
                total.cached_input_tokens = total
                    .cached_input_tokens
                    .saturating_add(last.cached_input_tokens);
            }
        }
        next
    }
}

#[async_trait]
impl Model for SharedModel {
    fn configure(&self, p: &areal_protocol::desktop::ModelParameters) -> Result<Arc<dyn Model>> {
        Ok(self.share_capacity(self.inner.configure(p)?))
    }
    fn share_capacity(&self, inner: Arc<dyn Model>) -> Arc<dyn Model> {
        Arc::new(Self {
            inner,
            permits: self.permits.clone(),
            max_requests: self.max_requests,
            usage: self.usage.clone(),
            load: self.load.clone(),
        })
    }
    fn name(&self) -> &str {
        self.inner.name()
    }
    fn load(&self) -> Option<ModelLoad> {
        let mut state = self.load.lock().unwrap();
        state.update();
        Some(state.snapshot.clone())
    }
    fn provider(&self) -> &str {
        self.inner.provider()
    }
    fn capabilities(&self) -> crate::model::ModelCapabilities {
        self.inner.capabilities()
    }
    async fn stream(&self, messages: Vec<Message>) -> Result<ModelStream> {
        self.chat(messages, vec![]).await
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> Result<ModelStream> {
        self.chat_for(messages, tools, crate::model::RequestPurpose::Solve)
            .await
    }
    async fn chat_for(
        &self,
        messages: Vec<Message>,
        tools: Vec<Value>,
        purpose: crate::model::RequestPurpose,
    ) -> Result<ModelStream> {
        let load = RequestLoad::waiting(self.load.clone());
        let permit = self.permits.clone().acquire_owned().await?;
        {
            let mut usage = self.usage.lock().unwrap();
            ensure!(
                usage.requests < self.max_requests,
                "root model request budget exhausted"
            );
            usage.requests += 1;
        }
        let request = InFlight {
            load: load.start(),
            _permit: permit,
        };
        let stream = self.inner.chat_for(messages, tools, purpose).await?;
        Ok(Box::pin(MeteredStream {
            inner: stream,
            request,
            usage: self.usage.clone(),
            last_usage: None,
            settled: false,
            failed: false,
        }))
    }
}

/// Stop a demonstrably stuck tool loop before spending another model request.
/// This never certifies success: the closed worker's candidate still goes through
/// the same independent local and final gates (and bounded owner repair).
struct ProgressModel {
    inner: Arc<dyn Model>,
    stalled: Arc<AtomicBool>,
    failure: Arc<Mutex<Option<ModelFailure>>>,
    workspace: PathBuf,
    successful: Mutex<SuccessfulTools>,
    context_bytes: usize,
    context_audit: Mutex<Vec<super::context::Observation>>,
    progress: Mutex<SourceProgress>,
    max_unchanged_rounds: usize,
    command_tools_only: bool,
}

/// A configurable checkpoint, not proof that reasoning made no progress. Only
/// activate after a source edit; initial repository exploration is not capped.
struct SourceProgress {
    hash: String,
    edited: bool,
    unchanged: usize,
    observed: bool,
}

impl SourceProgress {
    fn observe(&mut self, current: Option<String>, limit: usize) -> bool {
        let Some(current) = current else {
            self.unchanged = 0;
            return false;
        };
        if !self.observed {
            self.observed = true;
            if current == self.hash {
                return false;
            }
        }
        if current != self.hash {
            self.hash = current;
            self.edited = true;
            self.unchanged = 0;
        } else if self.edited {
            self.unchanged += 1;
        }
        limit > 0 && self.edited && self.unchanged >= limit
    }
}

#[derive(Default)]
struct SuccessfulTools {
    // Only one observation per completed model/tool boundary. An unobserved
    // intervening tool in a batch must not count as an unchanged source state.
    recent: VecDeque<(String, String)>,
}

fn successful_tool(messages: &[Message], result: &Message) -> Option<Value> {
    let id = result.tool_call_id.as_deref()?;
    let call = messages
        .iter()
        .flat_map(|m| &m.tool_calls)
        .find(|call| call["id"] == id)?;
    let mut signature = call["function"].clone();
    signature["arguments"] = serde_json::from_str(signature["arguments"].as_str()?).ok()?;
    let mut output: Value = serde_json::from_str(&result.text_content()).ok()?;
    if output.get("error").is_some_and(|v| !v.is_null()) {
        return None;
    }
    match signature["name"].as_str()? {
        "run_command" => {
            if output.get("state") != Some(&Value::from("exited"))
                || output.get("outputClosed") != Some(&Value::Bool(true))
                || output.get("gap") != Some(&Value::Bool(false))
                || output.get("exitCode") != Some(&Value::from(0))
                || output.get("stopReason") != Some(&Value::Null)
                || output.get("truncated") != Some(&Value::Bool(false))
                || !output.get("stdout").is_some_and(Value::is_string)
                || !output.get("stderr").is_some_and(Value::is_string)
            {
                return None;
            }
            output.as_object_mut()?.remove("processId");
            // A cursor includes the unique process ID; it is not source progress.
            output.as_object_mut()?.remove("nextCursor");
        }
        // A model can repeatedly overwrite a file with identical bytes while
        // each conditional write succeeds. Treat only confirmed writes with
        // identical arguments, receipts and observed source as a checkpoint.
        // Read-only tools are excluded: repeated inspection is not a write loop.
        "fs_create" | "fs_write" | "fs_apply_patch" => {
            let hash = output.get("sha256")?.as_str()?;
            if hash.len() != 64
                || !hash
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                || output.get("size")?.as_u64().is_none()
            {
                return None;
            }
        }
        _ => return None,
    }
    // 工具调用余额属于调度元信息，不能被当作重复操作产生的新进展。
    output.as_object_mut()?.remove("remainingToolCalls");
    Some(serde_json::json!({"call":signature,"output":output}))
}

impl SuccessfulTools {
    fn observe(&mut self, messages: &[Message], workspace: &Path) -> bool {
        let recent: Vec<_> = messages
            .iter()
            .rev()
            .filter(|m| m.role == "tool")
            .take(4)
            .collect();
        let Some(result) = recent.first() else {
            self.recent.clear();
            return false;
        };
        let Some(signature) = successful_tool(messages, result) else {
            self.recent.clear();
            return false;
        };
        let id = result.tool_call_id.as_ref().unwrap();
        if self
            .recent
            .back()
            .is_some_and(|(previous, _)| previous == id)
        {
            return false;
        }
        let Ok(tree) = tree::snapshot(workspace) else {
            // A partial/unsupported snapshot is not evidence of no progress.
            self.recent.clear();
            return false;
        };
        self.recent.push_back((id.clone(), digest(&tree)));
        if self.recent.len() > 4 {
            self.recent.pop_front();
        }
        self.recent.len() == 4
            && recent.len() == 4
            && self
                .recent
                .iter()
                .rev()
                .zip(recent)
                .all(|((id, hash), result)| {
                    result.tool_call_id.as_ref() == Some(id)
                        && hash == &self.recent.back().unwrap().1
                        && successful_tool(messages, result).as_ref() == Some(&signature)
                })
    }
}

fn repeated_failure(messages: &[Message]) -> bool {
    let recent: Vec<_> = messages
        .iter()
        .rev()
        .filter(|m| m.role == "tool")
        .take(3)
        .collect();
    if recent.len() != 3 {
        return false;
    }
    let mut previous = None;
    for result in recent {
        let Ok(value) = serde_json::from_str::<Value>(&result.text_content()) else {
            return false;
        };
        if !(value.get("error").is_some_and(|error| !error.is_null())
            || value.get("success") == Some(&Value::Bool(false))
            || value
                .get("exitCode")
                .and_then(Value::as_i64)
                .is_some_and(|code| code != 0)
            || value
                .get("stopReason")
                .is_some_and(|reason| !reason.is_null()))
        {
            return false;
        }
        let Some(id) = result.tool_call_id.as_deref() else {
            return false;
        };
        let Some(call) = messages
            .iter()
            .flat_map(|m| &m.tool_calls)
            .find(|call| call["id"] == id)
        else {
            return false;
        };
        let mut signature = call["function"].clone();
        let Some(arguments) = signature["arguments"].as_str() else {
            return false;
        };
        let Ok(arguments) = serde_json::from_str::<Value>(arguments) else {
            return false;
        };
        signature["arguments"] = arguments;
        if previous.as_ref().is_some_and(|value| value != &signature) {
            return false;
        }
        previous = Some(signature);
    }
    true
}

#[async_trait]
impl Model for ProgressModel {
    fn name(&self) -> &str {
        self.inner.name()
    }
    fn provider(&self) -> &str {
        self.inner.provider()
    }
    fn capabilities(&self) -> crate::model::ModelCapabilities {
        self.inner.capabilities()
    }
    async fn stream(&self, messages: Vec<Message>) -> Result<ModelStream> {
        self.chat(messages, vec![]).await
    }
    async fn chat_for(
        &self,
        messages: Vec<Message>,
        tools: Vec<Value>,
        purpose: crate::model::RequestPurpose,
    ) -> Result<ModelStream> {
        if purpose == crate::model::RequestPurpose::Summary {
            self.inner.chat_for(messages, tools, purpose).await
        } else {
            self.chat(messages, tools).await
        }
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> Result<ModelStream> {
        let failed = repeated_failure(&messages);
        let unchanged = !failed
            && self
                .successful
                .lock()
                .unwrap()
                .observe(&messages, &self.workspace);
        let checkpoint = self.max_unchanged_rounds > 0
            && self.progress.lock().unwrap().observe(
                tree::snapshot(&self.workspace)
                    .ok()
                    .map(|tree| digest(&tree)),
                self.max_unchanged_rounds,
            );
        if failed || unchanged || checkpoint {
            self.stalled.store(true, Ordering::SeqCst);
            anyhow::bail!(
                "workgroup worker reached a verification checkpoint (repeated failures: {failed}, identical successful operations and source: {unchanged}, unchanged-source round limit: {checkpoint}); close and independently validate its candidate"
            );
        }
        let (messages, observation) = super::context::window(messages, self.context_bytes);
        self.context_audit.lock().unwrap().push(observation);
        let tools = if self.command_tools_only {
            tools
                .into_iter()
                .filter(|tool| {
                    matches!(
                        tool["function"]["name"].as_str(),
                        Some(
                            "run_command" | "read_process" | "write_process" | "terminate_process"
                        )
                    )
                })
                .collect()
        } else {
            tools
        };
        let stream = match self.inner.chat(messages, tools).await {
            Ok(stream) => stream,
            Err(error) => {
                *self.failure.lock().unwrap() = error.downcast_ref::<ModelFailure>().copied();
                return Err(error);
            }
        };
        let failure = self.failure.clone();
        Ok(Box::pin(stream.inspect(move |event| {
            if let Err(error) = event {
                *failure.lock().unwrap() = error.downcast_ref::<ModelFailure>().copied();
            }
        })))
    }
}

pub struct NativeExecutor {
    pub catalog: Option<std::sync::Weak<Engine>>,
    pub model: Arc<dyn Model>,
    pub runtime: PathBuf,
    pub file_helper: PathBuf,
    pub toolchain: Option<PathBuf>,
    pub root: PathBuf,
    pub runtime_limits: areal_runtime_protocol::Limits,
    pub context_bytes: usize,
    pub max_unchanged_rounds: usize,
    /// Model tool exposure only; Engine and Runtime permissions are unchanged.
    pub command_tools_only: bool,
    sequence: AtomicUsize,
}

impl NativeExecutor {
    pub fn new(
        model: Arc<dyn Model>,
        root: PathBuf,
        runtime: PathBuf,
        file_helper: PathBuf,
        toolchain: Option<PathBuf>,
    ) -> Result<Self> {
        std::fs::create_dir_all(&root)?;
        let root = root.canonicalize()?;
        for binary in [&runtime, &file_helper] {
            ensure!(
                binary.is_file() && !binary.canonicalize()?.starts_with(&root),
                "trusted binary must exist outside attempt storage"
            );
        }
        let toolchain = toolchain
            .map(|path| -> Result<PathBuf> {
                let path = path
                    .canonicalize()
                    .context("trusted toolchain must exist")?;
                ensure!(path.is_dir(), "trusted toolchain must be a directory");
                // Copying an ancestor of attempt storage recursively copies the
                // destination itself. A descendant would reuse execution data
                // as trusted input. Resolve aliases before checking either case.
                ensure!(
                    !root.starts_with(&path) && !path.starts_with(&root),
                    "trusted toolchain and attempt storage must not overlap"
                );
                Ok(path)
            })
            .transpose()?;
        Ok(Self {
            catalog: None,
            model,
            runtime,
            file_helper,
            toolchain,
            root,
            runtime_limits: areal_runtime_protocol::Limits {
                wall_time_ms: 300_000,
                ..Default::default()
            },
            context_bytes: 65536,
            max_unchanged_rounds: 0,
            command_tools_only: false,
            sequence: AtomicUsize::new(0),
        })
    }

    async fn workspace(&self, tree: &Tree, prefix: &str) -> Result<(PathBuf, PathBuf)> {
        let index = self.sequence.fetch_add(1, Ordering::Relaxed);
        let root = self.root.join(format!("{prefix}-{index}"));
        let tree = tree.clone();
        let toolchain = self.toolchain.clone();
        tokio::task::spawn_blocking(move || -> Result<_> {
            std::fs::create_dir(&root)?;
            let workspace = root.join("workspace");
            materialize(&tree, &workspace)?;
            if let Some(toolchain) = &toolchain {
                fn copy(source: &Path, dest: &Path) -> Result<()> {
                    std::fs::create_dir(dest)?;
                    for entry in std::fs::read_dir(source)? {
                        let entry = entry?;
                        let metadata = entry.metadata()?;
                        let target = dest.join(entry.file_name());
                        ensure!(
                            !entry.file_type()?.is_symlink(),
                            "toolchain must be a materialized trusted directory"
                        );
                        if metadata.is_dir() {
                            copy(&entry.path(), &target)?;
                        } else {
                            ensure!(metadata.is_file(), "unsupported toolchain entry");
                            std::fs::copy(entry.path(), target)?;
                        }
                    }
                    Ok(())
                }
                copy(toolchain, &workspace.join(".toolchain"))?;
            }
            std::fs::create_dir(workspace.join(".scratch"))?;
            Ok((root, workspace))
        })
        .await?
    }

    async fn runtime(&self, workspace: &Path) -> Result<Arc<Client>> {
        Ok(Client::launch_with_limits(
            &self.runtime,
            &self.file_helper,
            workspace,
            true,
            &self.runtime_limits,
        )
        .await?)
    }
}

#[async_trait]
impl Executor for NativeExecutor {
    fn model_load(&self) -> Option<ModelLoad> {
        self.model.load()
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
        ensure!(!cancel.is_cancelled(), "cancelled before attempt startup");
        let initial = seed.as_ref().unwrap_or(&base);
        compose(&base, &base, initial, &task.writes)?;
        let (root, workspace) = self
            .workspace(initial, &format!("{}-{generation}", task.id))
            .await?;
        let runtime = self.runtime(&workspace).await?;
        let stalled = Arc::new(AtomicBool::new(false));
        let selected = if let Some(configuration) = &task.configuration {
            let source = self
                .catalog
                .as_ref()
                .and_then(std::sync::Weak::upgrade)
                .context("worker configuration requires trusted catalog")?;
            self.model.share_capacity(
                source.configured_model(&source.worker_configuration(configuration)?)?,
            )
        } else {
            self.model.clone()
        };
        let worker_model = Arc::new(ProgressModel {
            inner: selected,
            stalled: stalled.clone(),
            failure: Arc::new(Mutex::new(None)),
            workspace: workspace.clone(),
            successful: Mutex::new(SuccessfulTools::default()),
            context_bytes: self.context_bytes,
            context_audit: Mutex::new(vec![]),
            progress: Mutex::new(SourceProgress {
                hash: digest(initial),
                edited: seed.is_some(),
                unchanged: 0,
                observed: false,
            }),
            max_unchanged_rounds: self.max_unchanged_rounds,
            command_tools_only: self.command_tools_only,
        });
        let result: Result<()> = async {
            let engine = Engine::open_with_runtime(&root.join("history"), worker_model.clone(),
                Limits { max_active_turns: 1, max_children_per_turn: 0, max_agent_depth: 0,
                    max_history_bytes: 8 * 1024 * 1024, max_output_bytes: 512 * 1024,
                    turn_timeout: Duration::from_secs(900), ..Limits::default() },
                RuntimeConfig { client: runtime.clone(), workspace: workspace.clone(), writable: true, command_scratch: Some(workspace.join(".scratch")) })?;
            let execution: Result<()> = async {
                let thread = if let Some(configuration)=&task.configuration {
                    let source=self.catalog.as_ref().and_then(std::sync::Weak::upgrade).context("task configuration requires a trusted catalog")?;
                    source.create_worker(&engine,configuration,workspace.to_string_lossy().into_owned()).await?
                } else { engine.create(workspace.to_string_lossy().into_owned()).await? };
                let python = if self.toolchain.is_some() { workspace.join(".toolchain/bin/python3").display().to_string() } else { "python3".into() };
                let mut prompt = format!("Implement this assigned task in the existing repository.\n{}\nAllowed source writes: {:?}. Other files are read-only task inputs. Preserve tests and unrelated code.\nBase artifact: {}. Generation: {}.\nEarlier verification feedback: {}\nWorkspace URI: workspace://repo. Actual working directory: {}. Python executable: {} (use -B). Every command starts in the repository. Commands receive TMPDIR pointing to the private .scratch directory automatically. Use it for temporary files. Do not launch background processes. Implement the complete contract, batch independent inspections where practical, run relevant checks and finish when ready for independent integration. Do not repeat a failing command without changing its inputs. Peers may implement dependencies in isolated workspaces; preserve their responsibilities.\nLocal checks: {:?}", task.instruction, task.writes, digest(&base), generation, feedback, workspace.display(), python, task.checks);
                let mut remaining = 16000;
                prompt.push_str("\nTool paths: fs_* path and run_command cwd accept workspace-relative paths or workspace://repo URIs. Use . for the root cwd. Inside argv or a shell command, use ordinary relative filesystem paths, never workspace:// URIs. fs_read offset is a byte offset, not a line number; use a single sed command for line ranges. For new files prefer fs_create(path, text), which never overwrites an existing path. fs_write also supports creation with explicit JSON null for expectedSha256; never pass the string \"null\". For an existing file, use its actual full-file SHA-256 when requesting a conditional edit. run_command timeoutMs sets its execution deadline; omit yieldMs to wait for completion or output, or use read_process after an early return. Prefer the exact local-check argv above: it includes the prepared Python and test environment. Use .toolchain/bin/python3 rather than reconstructing a long absolute path. Batch related inspections, then implement and run the relevant checks.");
                if seed.is_some() {
                    prompt.push_str("\nThe workspace retains your previous unaccepted patch, safely composed onto the latest accepted base. Fix the concrete verification feedback in this current source; preserve working changes. These edits have not yet passed integration.");
                }
                for path in &task.writes {
                    if let Some(file) = initial.get(path) && let Ok(source) = std::str::from_utf8(&file.bytes) && source.len() <= remaining {
                        let hash = format!("{:x}", Sha256::digest(&file.bytes));
                        prompt.push_str(&format!("\nAssigned source at attempt start: workspace://repo/{path}\nFull-file SHA-256 for conditional edits: {hash}\n{source}\n"));
                        remaining -= source.len();
                    }
                }
                prompt.push_str("\nPublic repository file inventory (bounded excerpt; omitted paths may still exist):\n");
                let mut inventory_bytes = 0;
                for (path, file) in initial {
                    let line = format!("{path} ({} bytes)\n", file.bytes.len());
                    if inventory_bytes + line.len() > 4096 { break; }
                    prompt.push_str(&line); inventory_bytes += line.len();
                }
                std::fs::write(root.join("binding.json"), serde_json::to_vec_pretty(&serde_json::json!({
                    "task":task.id,"generation":generation,"threadId":thread.id,
                    "runtimeEpoch":runtime.info().runtime_epoch,"rootScopeId":runtime.info().root_scope_id,
                    "workspace":workspace,"base":digest(&base),"initial":digest(initial),"commandScratch":workspace.join(".scratch")
                }))?)?;
                let turn = engine.start(&thread.id, vec![Input::text(prompt)]).await?;
                let completed = tokio::select! {
                    _ = cancel.cancelled() => {
                        engine.interrupt(&thread.id, &turn.id).await?;
                        engine.wait(&thread.id).await?
                    },
                    thread = engine.wait(&thread.id) => thread?,
                };
                ensure!(!cancel.is_cancelled(), "attempt cancelled");
                let last = completed.turns.last().context("worker has no turn")?;
                let model_failure = *worker_model.failure.lock().unwrap();
                let uncertain = completed.turns.iter().flat_map(|t| &t.items).find_map(|item| {
                    match item {
                        areal_protocol::Item::DynamicToolCall { tool, status, execution, content_items, .. }
                            if *status == areal_protocol::ToolStatus::InProgress || matches!(execution.outcome,
                                areal_protocol::ToolOutcome::Unknown | areal_protocol::ToolOutcome::Running) =>
                            Some(serde_json::json!({"tool":tool,"outcome":execution.outcome,"result":content_items})),
                        _ => None,
                    }
                });
                std::fs::write(root.join("worker-result.json"), serde_json::to_vec_pretty(&serde_json::json!({
                    "turnStatus":last.status,"stalled":stalled.load(Ordering::SeqCst),"error":last.error,"modelFailure":model_failure,"uncertainTool":uncertain
                }))?)?;
                ensure!(uncertain.is_none(), "worker tool execution remains uncertain: {}", bounded(&uncertain.unwrap().to_string()));
                ensure!(last.status == TurnStatus::Completed || (last.status == TurnStatus::Failed &&
                    (stalled.load(Ordering::SeqCst) || model_failure.is_some())), "worker failed: {:?}", last.error);
                Ok(())
            }.await;
            engine.shutdown().await;
            execution
        }.await;
        runtime.shutdown().await.context(CleanupFailure::Worker)?;
        std::fs::write(
            root.join("model-context.json"),
            serde_json::to_vec_pretty(&*worker_model.context_audit.lock().unwrap())?,
        )?;
        result?;
        let artifact = tree::snapshot(&workspace)?;
        compose(&base, &base, &artifact, &task.writes)?;
        let failure = *worker_model.failure.lock().unwrap();
        if let Some(failure) = failure {
            return Err(AttemptCheckpoint { artifact, failure }.into());
        }
        Ok(artifact)
    }

    async fn verify(
        &self,
        candidate: Tree,
        commands: Vec<Vec<String>>,
        cancel: CancellationToken,
    ) -> Result<Check> {
        let expected = digest(&candidate);
        if commands.is_empty() {
            return Ok(Check {
                tree_hash: expected,
                passed: true,
                output: "No local checks; final verification remains mandatory".into(),
            });
        }
        ensure!(
            !cancel.is_cancelled(),
            "verification cancelled before startup"
        );
        let (root, workspace) = self.workspace(&candidate, "verification").await?;
        let runtime = self.runtime(&workspace).await?;
        let result: Result<Check> = async {
            let mut passed = true;
            let mut output = String::new();
            for command in commands {
                let mut argv = vec![
                    "/usr/bin/env".into(),
                    format!("TMPDIR={}", workspace.join(".scratch").display()),
                    "PYTHONDONTWRITEBYTECODE=1".into(),
                ];
                argv.extend(command);
                let (success, value) = tokio::select! {
                    _ = cancel.cancelled() => anyhow::bail!("verification cancelled"),
                    result = verify_command(&runtime, argv) => result?,
                };
                passed &= success;
                output.push_str(&value.to_string());
                output.push('\n');
                output = bounded(&output);
            }
            Ok(Check {
                tree_hash: expected,
                passed,
                output,
            })
        }
        .await;
        runtime
            .shutdown()
            .await
            .context(CleanupFailure::Verification)?;
        let mut check = result?;
        // Recheck after the Runtime cleanup barrier, not just after the foreground
        // command exited. Scratch/cache files are excluded from source artifacts.
        check.passed &= digest(&tree::snapshot(&workspace)?) == check.tree_hash;
        std::fs::write(
            root.join("receipt.json"),
            serde_json::to_vec_pretty(&check)?,
        )?;
        Ok(check)
    }
}

/// An optional planner consumes only public source context. Its calls and usage
/// share the same root model budget as workers. Final checks come from the caller.
pub async fn propose(
    model: &dyn Model,
    objective: &str,
    tree: &Tree,
    allowed: &[String],
) -> Result<Plan> {
    let mut context = String::new();
    for (path, file) in tree {
        if context.len() > 48000 {
            break;
        }
        context.push_str(&format!("\nFILE {path}\n"));
        if let Ok(text) = std::str::from_utf8(&file.bytes) {
            context.extend(text.chars().take(2000));
        }
    }
    let prompt = format!(
        "Plan a coding task into a useful dependency graph of at most {MAX_TASKS} tasks. Task count is independent of execution concurrency; create only boundaries that enable useful independent work. Return ONLY JSON with objective and tasks; each task has id (ASCII letters/digits/underscore), instruction (include exact interfaces and behavior), writes (exact relative file paths), depends (task ids that must integrate before execution), optional integrationDepends (task ids that only block acceptance; specify the agreed interface in instruction), checks (argv arrays for public local tests, or []). Shared-file changes will be coalesced by Core. Do not create duplicate implementations. Use a single task if splitting has no useful independent work. Do not edit tests. Final verification is supplied independently.\nObjective: {objective}\nCaller-authorized writable paths (do not expand): {allowed:?}\nPublic repository context:{context}"
    );
    let mut stream = model
        .chat(vec![Message::text("user", prompt)], vec![])
        .await?;
    let mut text = String::new();
    while let Some(event) = stream.next().await {
        if let ModelEvent::TextDelta(delta) = event? {
            text.push_str(&delta);
        }
        ensure!(text.len() <= 64000, "planner output exceeded limit");
    }
    let text = text
        .trim()
        .strip_prefix("```json")
        .or_else(|| text.trim().strip_prefix("```"))
        .unwrap_or(text.trim())
        .trim()
        .trim_end_matches("```")
        .trim();
    let mut plan: Plan =
        serde_json::from_str(text).context("planner did not return a valid task graph")?;
    plan.objective = objective.into();
    validate(&plan)?;
    validate_write_scope(&plan, allowed)?;
    Ok(plan)
}

#[cfg(test)]
mod progress_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn source_checkpoint_requires_an_edit_and_consecutive_observed_unchanged_rounds() {
        let mut progress = SourceProgress {
            hash: "base".into(),
            edited: false,
            unchanged: 0,
            observed: false,
        };
        for _ in 0..40 {
            assert!(!progress.observe(Some("base".into()), 16));
        }
        assert!(!progress.observe(Some("edited".into()), 16));
        for _ in 0..15 {
            assert!(!progress.observe(Some("edited".into()), 16));
        }
        assert!(progress.observe(Some("edited".into()), 16));
        assert!(!progress.observe(Some("new edit".into()), 16));
        for _ in 0..15 {
            assert!(!progress.observe(Some("new edit".into()), 16));
        }
        assert!(!progress.observe(None, 16));
        assert!(!progress.observe(Some("new edit".into()), 16));
        for _ in 0..30 {
            assert!(!progress.observe(Some("new edit".into()), 0));
        }
    }

    fn history(commands: &[(&str, i32)]) -> Vec<Message> {
        let mut messages = vec![];
        for (index, (command, code)) in commands.iter().enumerate() {
            let id = index.to_string();
            let mut call = Message::text("assistant", "");
            call.tool_calls.push(json!({"id":id,"function":{"name":"run_command","arguments":json!({"argv":[command]}).to_string()}}));
            let mut result = Message::text(
                "tool",
                json!({"exitCode":code,"processId":index}).to_string(),
            );
            result.tool_call_id = Some(id);
            messages.extend([call, result]);
        }
        messages
    }

    #[test]
    fn only_three_identical_failed_operations_trigger_candidate_verification() {
        assert!(repeated_failure(&history(&[("a", 1), ("a", 1), ("a", 1)])));
        for input in [
            vec![("a", 1), ("a", 1)],
            vec![("a", 1), ("b", 1), ("a", 1)],
            vec![("a", 1), ("a", 0), ("a", 1)],
        ] {
            assert!(!repeated_failure(&history(&input)));
        }
    }

    fn successful_history(count: usize) -> Vec<Message> {
        let mut messages = history(&vec![("inspect", 0); count]);
        for (index, message) in messages.iter_mut().filter(|m| m.role == "tool").enumerate() {
            message.content = Message::text(
                "tool",
                json!({
                    "exitCode":0,"processId":index,"stdout":"same result","stderr":"",
                    "stopReason":null,"truncated":false,"state":"exited","outputClosed":true,"gap":false,
                    "nextCursor":format!("{index}/11"),
                    "remainingToolCalls":128 - index
                })
                .to_string(),
            )
            .content;
        }
        messages
    }

    #[test]
    fn stable_success_requires_four_distinct_observed_boundaries() {
        let workspace = tempfile::tempdir().unwrap();
        let mut guard = SuccessfulTools::default();
        for count in 1..=4 {
            let messages = successful_history(count);
            assert_eq!(guard.observe(&messages, workspace.path()), count == 4);
            assert!(
                !guard.observe(&messages, workspace.path()),
                "same result was counted twice"
            );
        }
        let mut batched = SuccessfulTools::default();
        assert!(!batched.observe(&successful_history(1), workspace.path()));
        assert!(!batched.observe(&successful_history(3), workspace.path()));
        assert!(!batched.observe(&successful_history(4), workspace.path()));
        assert!(!batched.observe(&successful_history(5), workspace.path()));
        assert!(batched.observe(&successful_history(6), workspace.path()));
    }

    fn write_history(count: usize) -> Vec<Message> {
        let mut messages = successful_history(count);
        for (index, pair) in messages.chunks_mut(2).enumerate() {
            pair[0].tool_calls[0]["function"] = json!({
                "name":"fs_write",
                "arguments":json!({"path":"workspace://repo/source", "text":"same",
                    "expectedSha256":"a".repeat(64)}).to_string()
            });
            pair[1].content = Message::text(
                "tool",
                json!({"sha256":"a".repeat(64),"size":4,"remainingToolCalls":128 - index})
                    .to_string(),
            )
            .content;
        }
        messages
    }

    #[test]
    fn identical_successful_writes_checkpoint_without_consuming_the_root_budget() {
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("source"), "same").unwrap();
        let mut guard = SuccessfulTools::default();
        for count in 1..=4 {
            assert_eq!(
                guard.observe(&write_history(count), workspace.path()),
                count == 4
            );
        }
        for variation in [
            "source",
            "arguments",
            "receipt",
            "error",
            "incomplete",
            "read",
        ] {
            let mut guard = SuccessfulTools::default();
            for count in 1..=4 {
                let mut messages = write_history(count);
                let last = messages.len() - 1;
                if count == 4 {
                    match variation {
                        "source" => std::fs::write(workspace.path().join("source"), "new").unwrap(),
                        "arguments" => {
                            messages[last - 1].tool_calls[0]["function"]["arguments"] =
                                json!("{\"text\":\"new\"}")
                        }
                        "receipt" => {
                            messages[last].content = Message::text(
                                "tool",
                                json!({"sha256":"b".repeat(64),"size":4}).to_string(),
                            )
                            .content
                        }
                        "error" => {
                            messages[last].content = Message::text(
                                "tool",
                                json!({"error":"conflict","sha256":"a".repeat(64),"size":4})
                                    .to_string(),
                            )
                            .content
                        }
                        "incomplete" => {
                            messages[last].content =
                                Message::text("tool", json!({"sha256":"a".repeat(64)}).to_string())
                                    .content
                        }
                        _ => {
                            messages[last - 1].tool_calls[0]["function"]["name"] = json!("fs_read")
                        }
                    }
                }
                assert!(!guard.observe(&messages, workspace.path()), "{variation}");
            }
        }
    }

    #[test]
    fn source_changes_and_distinct_outputs_are_progress() {
        let workspace = tempfile::tempdir().unwrap();
        let mut guard = SuccessfulTools::default();
        for count in 1..=6 {
            std::fs::write(workspace.path().join("source"), count.to_string()).unwrap();
            assert!(!guard.observe(&successful_history(count), workspace.path()));
        }
        for count in 7..=9 {
            assert_eq!(
                guard.observe(&successful_history(count), workspace.path()),
                count == 9
            );
        }
        for variation in [
            "output",
            "arguments",
            "other-tool",
            "running",
            "open-output",
            "gap",
            "truncated",
            "incomplete",
        ] {
            let mut guard = SuccessfulTools::default();
            for count in 1..=4 {
                let mut messages = successful_history(count);
                if count == 4 {
                    let last = messages.len() - 1;
                    match variation {
                        "arguments" => {
                            messages[last - 1].tool_calls[0]["function"]["arguments"] =
                                json!("{\"argv\":[\"different\"]}")
                        }
                        "other-tool" => {
                            messages[last - 1].tool_calls[0]["function"]["name"] = json!("fs_read")
                        }
                        _ => {
                            let mut value: Value =
                                serde_json::from_str(&messages[last].text_content()).unwrap();
                            match variation {
                                "output" => value["stdout"] = json!("new result"),
                                "truncated" => value["truncated"] = json!(true),
                                "running" => value["state"] = json!("running"),
                                "open-output" => value["outputClosed"] = json!(false),
                                "gap" => value["gap"] = json!(true),
                                _ => {
                                    value.as_object_mut().unwrap().remove("stopReason");
                                }
                            }
                            messages[last].content =
                                Message::text("tool", value.to_string()).content;
                        }
                    }
                }
                assert!(!guard.observe(&messages, workspace.path()), "{variation}");
            }
        }
    }

    #[test]
    fn unreadable_source_is_not_evidence_of_stagnation() {
        let workspace = tempfile::tempdir().unwrap();
        let mut guard = SuccessfulTools::default();
        for count in 1..=3 {
            assert!(!guard.observe(&successful_history(count), workspace.path()));
        }
        assert!(!guard.observe(&successful_history(4), &workspace.path().join("missing")));
        assert!(!guard.observe(&successful_history(5), workspace.path()));
    }
}
