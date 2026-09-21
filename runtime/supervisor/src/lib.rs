//! 固定权限入口、ExecutionScope 和任务进程的唯一所有者。
pub mod backend;
mod filesystem;
mod input;
mod output;
mod policy;
mod writes;

use areal_runtime_protocol::*;
use backend::{Backend, Event, Execution};
use futures_util::FutureExt;
use output::Output;
use policy::{Directory, Workspace, denied, invalid, narrow, within};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::watch;
use tokio_util::{sync::CancellationToken, task::TaskTracker};

#[derive(Clone)]
pub struct Config {
    pub workspace: PathBuf,
    /// Explicit deployment-owned scratch, shared across commands, outside repo.
    pub scratch: Option<PathBuf>,
    pub writable: bool,
    pub allow_network: bool,
    /// Allow commands to overlap; overlapping file-helper writes still coordinate by path.
    pub concurrent_writes: bool,
    pub limits: Limits,
    pub max_scopes: usize,
    pub max_operations: usize,
    pub output_window_bytes: usize,
    pub cleanup_timeout: Duration,
    pub file_helper: Option<PathBuf>,
    /// 仅注入显式授权的任务客户端，不加入请求、诊断或操作摘要。
    pub task_credential_commands: Vec<PathBuf>,
    pub task_environment: BTreeMap<String, String>,
}
impl Config {
    pub fn read_only(workspace: PathBuf) -> Self {
        Self {
            workspace,
            scratch: None,
            writable: false,
            allow_network: false,
            concurrent_writes: false,
            limits: Limits::default(),
            max_scopes: 256,
            max_operations: 4096,
            output_window_bytes: MAX_READ_BYTES,
            cleanup_timeout: Duration::from_secs(3),
            file_helper: None,
            task_credential_commands: Vec::new(),
            task_environment: BTreeMap::new(),
        }
    }
}

struct Scope {
    info: ScopeInfo,
    reads: Vec<PathBuf>,
    writes: Vec<PathBuf>,
    directories: Vec<Directory>,
}
struct Process {
    info: ProcessInfo,
    ancestors: Vec<String>,
    cancel: CancellationToken,
    limits: Limits,
    output: Output,
    accepts_stdin: bool,
}
type Completion = watch::Sender<Option<Result<Value>>>;
type CompletionReceiver = watch::Receiver<Option<Result<Value>>>;
struct Operation {
    digest: [u8; 32],
    info: OperationInfo,
    complete: Completion,
}
#[derive(Default)]
struct Registry {
    scopes: BTreeMap<String, Scope>,
    processes: BTreeMap<String, Process>,
    operations: BTreeMap<String, Operation>,
    revoked_owners: BTreeSet<String>,
}

pub struct Supervisor {
    config: Config,
    workspace: Workspace,
    epoch: String,
    root: String,
    connection: String,
    registry: Mutex<Registry>,
    updates: watch::Sender<u64>,
    backend: Arc<dyn Backend>,
    tasks: TaskTracker,
    write_gate: Arc<writes::Writes>,
}
impl Supervisor {
    pub fn new(config: Config, backend: Arc<dyn Backend>) -> Result<Arc<Self>> {
        if config.limits.wall_time_ms == 0
            || config.max_scopes == 0
            || config.max_operations == 0
            || config.output_window_bytes == 0
            || config.output_window_bytes > 8 * 1024 * 1024
            || config.cleanup_timeout.is_zero()
        {
            return Err(invalid("invalid Runtime deployment limits"));
        }
        let mut workspace = Workspace::new(&config.workspace)?;
        if let Some(path) = &config.scratch {
            workspace.set_scratch(path)?;
        }
        let epoch = uuid::Uuid::new_v4().to_string();
        let root = handle(&epoch, "scope");
        let mut reads = vec![workspace.root.clone()];
        if let Some(root) = workspace.scratch_root() {
            reads.push(root.clone());
        }
        let writes = if config.writable {
            reads.clone()
        } else {
            Vec::new()
        };
        let mut registry = Registry::default();
        registry.scopes.insert(
            root.clone(),
            Scope {
                directories: bind_directories(&reads, &writes)?,
                info: ScopeInfo {
                    scope_id: root.clone(),
                    parent_scope_id: None,
                    state: ScopeState::Active,
                    owner: Owner {
                        task_id: "connection".into(),
                        plugin_instance_id: None,
                    },
                    read_roots: reads.iter().map(|p| workspace.uri(p)).collect(),
                    write_roots: if config.writable {
                        writes.iter().map(|p| workspace.uri(p)).collect()
                    } else {
                        Vec::new()
                    },
                    network: if config.allow_network {
                        NetworkRequest::Inherit
                    } else {
                        NetworkRequest::Deny
                    },
                    limits: config.limits.clone(),
                    active_processes: 0,
                    output_bytes: 0,
                    cleanup_error: None,
                },
                reads,
                writes,
            },
        );
        let write_gate = Arc::new(writes::Writes::new(workspace.root.clone()));
        Ok(Arc::new(Self {
            config,
            workspace,
            epoch,
            root,
            connection: uuid::Uuid::new_v4().to_string(),
            registry: Mutex::new(registry),
            updates: watch::channel(0).0,
            backend,
            tasks: TaskTracker::new(),
            write_gate,
        }))
    }
    pub fn connection_info(&self) -> ConnectionInfo {
        let mut info = ConnectionInfo {
            protocol_version: VERSION.into(),
            runtime_epoch: self.epoch.clone(),
            connection_id: self.connection.clone(),
            root_scope_id: self.root.clone(),
            capabilities: json!({
                "transport": "privateStdio", "authentication": "inheritedPipe", "reconnect": false,
                "sandbox": self.backend.sandbox_profile(), "processCleanup": "executorManagedProcesses",
                "processTreeCleanupVerified": false, "coreHostIsolated": false,
                "directoryObjectIsolation": false, "sandboxDenialAttribution": false,
                "processLimits": self.config.limits,
                "rootNetwork": if self.config.allow_network { NetworkRequest::Inherit } else { NetworkRequest::Deny },
                "methods": ["runtime.status", "connection.open", "connection.close", "scope.create", "scope.get", "scope.revoke",
                    "scope.waitClosed", "owner.revoke", "process.start", "process.get", "process.terminate", "process.wait", "output.read", "operation.get"]
            }),
        };
        if self.config.file_helper.is_some() {
            info.capabilities["methods"]
                .as_array_mut()
                .unwrap()
                .push(json!("fs.execute"));
            info.capabilities["filesystem"] = json!({"maxChunkBytes":MAX_FILE_CHUNK,"maxEditFileBytes":MAX_EDIT_FILE,"symlinks":"reject","writeSerialization":if self.config.concurrent_writes { "filePaths" } else { "conflictingPaths" },"externalConcurrentCAS":false});
        }
        if self.backend.supports_input() {
            info.capabilities["methods"]
                .as_array_mut()
                .unwrap()
                .push(json!("process.write"));
            info.capabilities["processInput"] = json!({"stdin":true,"tty":true,"resize":false,"closeStdin":false,"maxBytes":MAX_FILE_CHUNK});
        }
        if self.backend.supports_terminal_control() {
            info.capabilities["methods"]
                .as_array_mut()
                .unwrap()
                .extend([json!("process.resize"), json!("process.closeStdin")]);
            info.capabilities["processInput"]["resize"] = json!(true);
            info.capabilities["processInput"]["closeStdin"] = json!(true);
            info.capabilities["processInput"]["ptyEof"] = json!("canonicalVEOF");
        }
        info
    }
    pub fn status(&self) -> Value {
        let state = self.registry.lock().unwrap();
        json!({"rotationRecommended":state.scopes.len()*5>=self.config.max_scopes*4||state.operations.len()*5>=self.config.max_operations*4,"runtimeEpoch":self.epoch,"scopes":{"used":state.scopes.len(),"limit":self.config.max_scopes},
            "operations":{"used":state.operations.len(),"limit":self.config.max_operations},
            "activeProcesses":state.processes.values().filter(|p|p.info.state==ProcessState::Running || p.info.state==ProcessState::Starting).count(),
            "outputBytes":{"used":state.scopes[&self.root].info.output_bytes,"limit":self.config.limits.output_bytes}})
    }
    fn check_handle(&self, value: &str, kind: &str) -> Result<()> {
        let prefix = format!("{}:{kind}:", self.epoch);
        if value
            .strip_prefix(&prefix)
            .and_then(|s| uuid::Uuid::parse_str(s).ok())
            .is_none()
        {
            return Err(Error::new(
                ErrorCode::StaleHandle,
                "handle or operation belongs to another runtime epoch or kind",
            ));
        }
        Ok(())
    }
    fn changed(&self) {
        self.updates
            .send_modify(|version| *version = version.wrapping_add(1));
    }
    fn validate_operation(&self, operation_id: &str) -> Result<()> {
        self.check_handle(operation_id, "op")
    }

    pub fn scope(&self, scope_id: &str) -> Result<ScopeInfo> {
        self.check_handle(scope_id, "scope")?;
        self.registry
            .lock()
            .unwrap()
            .scopes
            .get(scope_id)
            .map(|s| s.info.clone())
            .ok_or_else(not_found)
    }
    pub fn process(&self, process_id: &str) -> Result<ProcessInfo> {
        self.check_handle(process_id, "process")?;
        self.registry
            .lock()
            .unwrap()
            .processes
            .get(process_id)
            .map(|p| p.info.clone())
            .ok_or_else(not_found)
    }
    pub fn operation(&self, operation_id: &str) -> Result<OperationInfo> {
        self.validate_operation(operation_id)?;
        self.registry
            .lock()
            .unwrap()
            .operations
            .get(operation_id)
            .map(|o| o.info.clone())
            .ok_or_else(not_found)
    }

    pub fn create_scope(&self, request: CreateScope) -> Result<ScopeInfo> {
        self.validate_operation(&request.operation_id)?;
        self.check_handle(&request.parent_scope_id, "scope")?;
        if request.owner.task_id.is_empty()
            || request.owner.task_id.len() > 256
            || request
                .owner
                .plugin_instance_id
                .as_ref()
                .is_some_and(|id| id.is_empty() || id.len() > 256)
        {
            return Err(invalid("owner identifiers must contain 1..256 bytes"));
        }
        let digest = digest("scope.create", &request)?;
        let mut state = self.registry.lock().unwrap();
        if let Some(old) = replay(&state, &request.operation_id, digest)? {
            return decode(
                old.borrow()
                    .clone()
                    .expect("scope creation is synchronous")?,
            );
        }
        self.admit_operation(&state)?;
        if request
            .owner
            .plugin_instance_id
            .as_ref()
            .is_some_and(|id| state.revoked_owners.contains(id))
        {
            return Err(Error::new(
                ErrorCode::ScopeClosed,
                "plugin instance was revoked; use a new generation identity",
            ));
        }
        self.validate_paths(&state, &request.parent_scope_id)?;
        if state.scopes.len() >= self.config.max_scopes {
            return Err(exhausted(
                "scope capacity reached; restart the attached runtime after draining",
            ));
        }
        let parent = state
            .scopes
            .get(&request.parent_scope_id)
            .ok_or_else(not_found)?;
        ensure_active(parent)?;
        let reads = self
            .workspace
            .roots(&request.permissions.read_roots, &parent.reads)?;
        let writes = self
            .workspace
            .roots(&request.permissions.write_roots, &parent.writes)?;
        if writes.iter().any(|path| !within(path, &reads)) {
            return Err(denied(
                "write roots must also be included in child read roots",
            ));
        }
        let limits = narrow(&parent.info.limits, &request.limits)?;
        let scope_id = handle(&self.epoch, "scope");
        let info = ScopeInfo {
            scope_id: scope_id.clone(),
            parent_scope_id: Some(request.parent_scope_id),
            state: ScopeState::Active,
            owner: request.owner,
            read_roots: reads.iter().map(|p| self.workspace.uri(p)).collect(),
            write_roots: writes.iter().map(|p| self.workspace.uri(p)).collect(),
            network: match request.permissions.network {
                NetworkRequest::Deny => NetworkRequest::Deny,
                NetworkRequest::Inherit => parent.info.network,
            },
            limits,
            active_processes: 0,
            output_bytes: 0,
            cleanup_error: None,
        };
        let directories = bind_directories(&reads, &writes)?;
        state.scopes.insert(
            scope_id,
            Scope {
                info: info.clone(),
                reads,
                writes,
                directories,
            },
        );
        let operation = new_operation(request.operation_id.clone(), digest);
        state
            .operations
            .insert(request.operation_id.clone(), operation);
        complete_operation(
            &mut state,
            &request.operation_id,
            Ok(json!(info)),
            OperationState::Succeeded,
        );
        self.changed();
        Ok(info)
    }
    fn admit_operation(&self, state: &Registry) -> Result<()> {
        ensure_active(state.scopes.get(&self.root).unwrap())?;
        if state.operations.len() >= self.config.max_operations {
            return Err(exhausted(
                "operation retention capacity reached; existing keys remain queryable",
            ));
        }
        Ok(())
    }

    fn validate_paths(&self, state: &Registry, scope_id: &str) -> Result<()> {
        self.workspace.validate()?;
        if !state.scopes.contains_key(scope_id) {
            return Err(not_found());
        }
        for id in ancestors(state, scope_id) {
            for directory in &state.scopes[&id].directories {
                directory.validate()?;
            }
        }
        Ok(())
    }

    pub async fn start(self: &Arc<Self>, request: StartProcess) -> Result<ProcessRef> {
        self.start_inner(request, None).await
    }
    async fn start_inner(
        self: &Arc<Self>,
        request: StartProcess,
        helper: Option<(PathBuf, bool, PathBuf)>,
    ) -> Result<ProcessRef> {
        self.validate_operation(&request.operation_id)?;
        self.check_handle(&request.scope_id, "scope")?;
        // Helper argv contains a JSON envelope, escaped once more by the
        // process record. Its public file request has already been bounded.
        let digest = if helper.is_some() {
            digest_bounded("process.start", &request, 2 * MAX_FRAME_BYTES + 4096)?
        } else {
            digest("process.start", &request)?
        };
        let mut completion = {
            let mut state = self.registry.lock().unwrap();
            if let Some(existing) = replay(&state, &request.operation_id, digest)? {
                existing
            } else {
                self.admit_operation(&state)?;
                validate_process(&request)?;
                if (request.tty || request.pipe_stdin) && !self.backend.supports_input() {
                    return Err(Error::new(
                        ErrorCode::Unsupported,
                        "backend does not support stdin or TTY",
                    ));
                }
                self.validate_paths(&state, &request.scope_id)?;
                let cwd = self.workspace.resolve(&request.cwd)?;
                let scope = state.scopes.get(&request.scope_id).ok_or_else(not_found)?;
                ensure_active(scope)?;
                if !within(&cwd, &scope.reads) {
                    return Err(denied("cwd is outside scope read roots"));
                }
                let limits = narrow(&scope.info.limits, &request.limits)?;
                let task_program = (helper.is_none()
                    && !self.config.task_credential_commands.is_empty()
                    && PathBuf::from(&request.argv[0]).is_absolute())
                .then(|| std::fs::canonicalize(&request.argv[0]).ok())
                .flatten()
                .filter(|path| self.config.task_credential_commands.contains(path));
                // 凭据接收方由可信部署固定；只开放该可执行文件，不放宽所在目录。
                let trusted_executable = helper
                    .as_ref()
                    .map(|(path, _, _)| path.clone())
                    .or_else(|| task_program.clone());
                let mut execution = Execution {
                    process_id: handle(&self.epoch, "process"),
                    argv: request.argv,
                    cwd,
                    env: request.env,
                    read_roots: scope.reads.clone(),
                    write_roots: scope.writes.clone(),
                    trusted_executable,
                    tty: request.tty,
                    pipe_stdin: request.pipe_stdin,
                    network: scope.info.network,
                };
                if let Some(program) = task_program {
                    // 使用已验证的目标执行，避免再次通过调用方的软链接解析。
                    execution.argv[0] = program.to_string_lossy().into_owned();
                    execution.env.extend(self.config.task_environment.clone());
                }
                if helper.as_ref().is_some_and(|(_, writes, _)| !writes) {
                    execution.write_roots.clear();
                }
                execution
                    .env
                    .entry("PATH".into())
                    .or_insert_with(|| "/usr/local/bin:/usr/bin:/bin".into());
                let write_paths = if execution.write_roots.is_empty()
                    || (self.config.concurrent_writes && helper.is_none())
                {
                    Vec::new()
                } else if let Some((_, _, path)) = &helper {
                    vec![path.clone()]
                } else {
                    execution.write_roots.clone()
                };
                let ancestors = ancestors(&state, &request.scope_id);
                for ancestor in &ancestors {
                    let scope = &state.scopes[ancestor];
                    ensure_active(scope)?;
                    if scope.info.active_processes >= scope.info.limits.max_processes
                        || scope.info.output_bytes >= scope.info.limits.output_bytes
                    {
                        return Err(exhausted(
                            "ancestor process or cumulative output budget exhausted",
                        ));
                    }
                }
                if limits.max_processes == 0 || limits.output_bytes == 0 {
                    return Err(exhausted("process budget is zero"));
                }
                for ancestor in &ancestors {
                    state
                        .scopes
                        .get_mut(ancestor)
                        .unwrap()
                        .info
                        .active_processes += 1;
                }
                let process_id = execution.process_id.clone();
                let cancel = CancellationToken::new();
                state.processes.insert(
                    process_id.clone(),
                    Process {
                        info: ProcessInfo {
                            process_id: process_id.clone(),
                            scope_id: request.scope_id,
                            state: ProcessState::Starting,
                            exit_code: None,
                            signal: None,
                            sandbox_denied: false,
                            stop_reason: None,
                            cleanup_error: None,
                        },
                        ancestors,
                        cancel,
                        limits,
                        // A fast helper can finish before its consumer polls.
                        // Retain its entire bounded envelope independently of
                        // the configurable command-output window.
                        output: Output::new(if helper.is_some() {
                            self.config.output_window_bytes.max(MAX_FRAME_BYTES)
                        } else {
                            self.config.output_window_bytes
                        }),
                        accepts_stdin: request.tty || request.pipe_stdin,
                    },
                );
                let operation = new_operation(request.operation_id.clone(), digest);
                let receiver = operation.complete.subscribe();
                state
                    .operations
                    .insert(request.operation_id.clone(), operation);
                // 在同一个准入临界区登记资源和任务。调用方丢弃 future 不会丢掉创建任务。
                let runtime = self.clone();
                self.tasks.spawn(async move {
                    let result = std::panic::AssertUnwindSafe(runtime.run(
                        &request.operation_id,
                        execution,
                        write_paths,
                    ))
                    .catch_unwind()
                    .await;
                    if result.is_err() {
                        runtime.unknown(
                            &process_id,
                            &request.operation_id,
                            "execution supervisor panicked",
                        );
                        let _ = runtime.backend.shutdown().await;
                    }
                });
                self.changed();
                receiver
            }
        };
        loop {
            if let Some(result) = completion.borrow().clone() {
                return decode(result?);
            }
            completion
                .changed()
                .await
                .map_err(|_| unavailable("operation result channel closed"))?;
        }
    }

    async fn run(
        self: &Arc<Self>,
        operation_id: &str,
        execution: Execution,
        write_paths: Vec<PathBuf>,
    ) {
        let process_id = execution.process_id.clone();
        let (cancel, limits) = {
            let state = self.registry.lock().unwrap();
            let process = &state.processes[&process_id];
            (process.cancel.clone(), process.limits.clone())
        };
        let deadline = tokio::time::Instant::now() + Duration::from_millis(limits.wall_time_ms);
        let _write_guard = if write_paths.is_empty() {
            None
        } else {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => { self.start_failed(&process_id, operation_id, Error::new(ErrorCode::ScopeClosed, "cancelled while awaiting workspace write ownership"), OperationState::Cancelled); return; }
                _ = tokio::time::sleep_until(deadline) => { self.start_failed(&process_id, operation_id, exhausted("workspace write queue deadline exceeded"), OperationState::Failed); return; }
                guard = self.write_gate.acquire(write_paths) => Some(guard),
            }
        };
        if cancel.is_cancelled() {
            self.start_failed(
                &process_id,
                operation_id,
                Error::new(ErrorCode::ScopeClosed, "cancelled before backend admission"),
                OperationState::Cancelled,
            );
            return;
        }
        // 任务可能在准入后才获得调度；不能把旧的路径校验结果跨越这段等待。
        let paths = {
            let state = self.registry.lock().unwrap();
            self.validate_paths(&state, &state.processes[&process_id].info.scope_id)
        };
        if let Err(error) = paths {
            self.start_failed(&process_id, operation_id, error, OperationState::Failed);
            return;
        }
        {
            let mut state = self.registry.lock().unwrap();
            state.operations.get_mut(operation_id).unwrap().info.state = OperationState::Running;
        }
        let started = tokio::time::timeout_at(
            deadline.min(tokio::time::Instant::now() + Duration::from_secs(5)),
            self.backend.start(execution),
        )
        .await;
        let mut events = match started {
            Ok(Ok(events)) => events,
            Ok(Err(error)) if error.code != ErrorCode::Unavailable => {
                self.start_failed(&process_id, operation_id, error, OperationState::Failed);
                return;
            }
            _ => {
                self.unknown(
                    &process_id,
                    operation_id,
                    "backend start outcome is unknown",
                );
                let _ = self.backend.shutdown().await;
                return;
            }
        };
        {
            let mut state = self.registry.lock().unwrap();
            let process = state.processes.get_mut(&process_id).unwrap();
            process.info.state = ProcessState::Running;
            let result = ProcessRef {
                process_id: process_id.clone(),
                scope_id: process.info.scope_id.clone(),
            };
            complete_operation(
                &mut state,
                operation_id,
                Ok(json!(result)),
                OperationState::Succeeded,
            );
            self.changed();
        }
        let mut stopping = false;
        let mut cleanup_deadline = deadline;
        let mut termination = None;
        let mut exited = false;
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled(), if !stopping => {
                    stopping = true;
                    cleanup_deadline = tokio::time::Instant::now() + self.config.cleanup_timeout;
                    let backend = self.backend.clone(); let id = process_id.clone();
                    termination = Some(Box::pin(async move { backend.terminate(&id).await }));
                }
                _ = tokio::time::sleep_until(deadline), if !stopping => {
                    self.stop(&process_id, "wallTimeMs exceeded").expect("owned process");
                }
                _ = tokio::time::sleep_until(cleanup_deadline), if stopping => {
                    self.unknown(&process_id, operation_id, "executor cleanup timed out");
                    let _ = self.backend.shutdown().await;
                    return;
                }
                result = async { termination.as_mut().unwrap().await }, if termination.is_some() => {
                    termination = None;
                    if result.is_err() {
                        self.unknown(&process_id, operation_id, "executor termination could not be confirmed");
                        let _ = self.backend.shutdown().await;
                        return;
                    }
                }
                event = events.recv() => match event {
                    Some(Event::Output(stream, bytes)) => self.append(&process_id, stream, &bytes),
                    Some(Event::Exited { exit_code, signal, sandbox_denied }) if !exited => {
                        exited = true;
                        let mut state = self.registry.lock().unwrap();
                        let process = state.processes.get_mut(&process_id).unwrap();
                        process.info.exit_code = exit_code; process.info.signal = signal.map(|n| n.to_string()); process.info.sandbox_denied = sandbox_denied;
                    }
                    Some(Event::Closed) if exited => { self.finished(&process_id); return; }
                    _ => {
                        self.unknown(&process_id, operation_id, "executor output/exit stream was lost or violated ordering");
                        let _ = self.backend.shutdown().await;
                        return;
                    }
                }
            }
        }
    }
    fn append(&self, process_id: &str, stream: OutputStream, bytes: &[u8]) {
        let mut state = self.registry.lock().unwrap();
        let process = &state.processes[process_id];
        let owners = process.ancestors.clone();
        let mut allowed = process
            .limits
            .output_bytes
            .saturating_sub(process.output.end);
        for owner in &owners {
            let scope = &state.scopes[owner].info;
            allowed = allowed.min(scope.limits.output_bytes.saturating_sub(scope.output_bytes));
        }
        let accepted = (bytes.len() as u64).min(allowed) as usize;
        for owner in &owners {
            state.scopes.get_mut(owner).unwrap().info.output_bytes += accepted as u64;
        }
        let process = state.processes.get_mut(process_id).unwrap();
        process.output.append(stream, &bytes[..accepted]);
        if accepted < bytes.len() {
            process.output.truncated = true;
            process
                .info
                .stop_reason
                .get_or_insert_with(|| "outputBytes exceeded".into());
            process.cancel.cancel();
        }
        self.changed();
    }
    fn finished(&self, process_id: &str) {
        let mut state = self.registry.lock().unwrap();
        release_process(&mut state, process_id);
        self.changed();
    }
    fn start_failed(
        &self,
        process_id: &str,
        operation_id: &str,
        error: Error,
        status: OperationState,
    ) {
        let mut state = self.registry.lock().unwrap();
        state
            .processes
            .get_mut(process_id)
            .unwrap()
            .info
            .stop_reason = Some(error.message.clone());
        complete_operation(&mut state, operation_id, Err(error), status);
        release_process(&mut state, process_id);
        self.changed();
    }
    fn unknown(&self, process_id: &str, operation_id: &str, reason: &str) {
        let mut state = self.registry.lock().unwrap();
        let process = state.processes.get_mut(process_id).unwrap();
        process.info.state = ProcessState::Unknown;
        process.info.cleanup_error = Some(reason.into());
        process.output.closed = true;
        process.output.truncated = true;
        let owners = process.ancestors.clone();
        for owner in owners {
            state.scopes.get_mut(&owner).unwrap().info.cleanup_error = Some(reason.into());
        }
        if matches!(
            state.operations[operation_id].info.state,
            OperationState::Accepted | OperationState::Running
        ) {
            complete_operation(
                &mut state,
                operation_id,
                Err(unavailable(reason)),
                OperationState::Unknown,
            );
        }
        // 丢失后端事实时封闭整个连接；不释放未知资源的名额、不伪造 CLOSED。
        revoke_locked(&mut state, &self.root);
        self.changed();
    }

    fn stop(&self, process_id: &str, reason: &str) -> Result<()> {
        self.check_handle(process_id, "process")?;
        let mut state = self.registry.lock().unwrap();
        let process = state.processes.get_mut(process_id).ok_or_else(not_found)?;
        if matches!(
            process.info.state,
            ProcessState::Starting | ProcessState::Running
        ) {
            process
                .info
                .stop_reason
                .get_or_insert_with(|| reason.into());
            process.cancel.cancel();
        }
        Ok(())
    }
    pub fn terminate(&self, process_id: &str) -> Result<()> {
        self.stop(process_id, "process terminated")
    }
    pub fn revoke(&self, scope_id: &str) -> Result<ScopeInfo> {
        self.check_handle(scope_id, "scope")?;
        let mut state = self.registry.lock().unwrap();
        if !state.scopes.contains_key(scope_id) {
            return Err(not_found());
        }
        revoke_locked(&mut state, scope_id);
        self.changed();
        Ok(state.scopes[scope_id].info.clone())
    }
    /// Owner identity includes the plugin generation. Revocation is permanent
    /// for this epoch, including when no scope has been created yet.
    pub fn revoke_owner(&self, request: RevokeOwner) -> Result<OwnerRevocation> {
        let owner = request.plugin_instance_id;
        if owner.is_empty() || owner.len() > 256 {
            return Err(invalid("owner identifiers must contain 1..256 bytes"));
        }
        let mut state = self.registry.lock().unwrap();
        if !state.revoked_owners.contains(&owner)
            && state.revoked_owners.len() >= self.config.max_scopes
        {
            return Err(exhausted("owner revocation retention capacity reached"));
        }
        state.revoked_owners.insert(owner.clone());
        let scope_ids: Vec<String> = state
            .scopes
            .iter()
            .filter(|(_, scope)| scope.info.owner.plugin_instance_id.as_ref() == Some(&owner))
            .map(|(id, _)| id.clone())
            .collect();
        for id in &scope_ids {
            revoke_locked(&mut state, id);
        }
        self.changed();
        Ok(OwnerRevocation {
            plugin_instance_id: owner,
            scope_ids,
        })
    }
    pub async fn wait_closed(&self, scope_id: &str) -> Result<ScopeInfo> {
        let mut updates = self.updates.subscribe();
        loop {
            let scope = self.scope(scope_id)?;
            if let Some(error) = &scope.cleanup_error {
                return Err(Error::new(ErrorCode::CleanupFailed, error));
            }
            if scope.state == ScopeState::Closed {
                return Ok(scope);
            }
            if scope.state == ScopeState::Active {
                return Err(invalid("revoke the scope before waiting for closure"));
            }
            updates
                .changed()
                .await
                .map_err(|_| unavailable("runtime stopped"))?;
        }
    }
    pub async fn wait_process(&self, process_id: &str) -> Result<ProcessInfo> {
        let mut updates = self.updates.subscribe();
        loop {
            let process = self.process(process_id)?;
            if process.state == ProcessState::Unknown {
                return Err(Error::new(
                    ErrorCode::CleanupFailed,
                    "process outcome or cleanup is unknown",
                ));
            }
            if process.state == ProcessState::Exited {
                return Ok(process);
            }
            updates
                .changed()
                .await
                .map_err(|_| unavailable("runtime stopped"))?;
        }
    }
    pub async fn output(&self, request: ReadOutput) -> Result<OutputPage> {
        self.check_handle(&request.process_id, "process")?;
        if request.max_bytes == 0 || request.max_bytes > MAX_READ_BYTES || request.wait_ms > 1000 {
            return Err(invalid("maxBytes must be 1..65536 and waitMs at most 1000"));
        }
        let deadline = tokio::time::Instant::now() + Duration::from_millis(request.wait_ms);
        let mut updates = self.updates.subscribe();
        loop {
            let page = {
                let state = self.registry.lock().unwrap();
                state
                    .processes
                    .get(&request.process_id)
                    .ok_or_else(not_found)?
                    .output
                    .page(
                        &request.process_id,
                        request.after.as_deref(),
                        request.max_bytes,
                    )?
            };
            if !page.chunks.is_empty()
                || page.closed
                || page.gap
                || page.truncated
                || tokio::time::Instant::now() >= deadline
            {
                return Ok(page);
            }
            tokio::select! { _ = tokio::time::sleep_until(deadline) => {}, _ = updates.changed() => {} }
        }
    }
    /// 关闭准入并确认任务资源清理；装配宿主随后关闭执行后端。
    pub async fn drain(&self) -> Result<()> {
        self.revoke(&self.root)?;
        self.tasks.close();
        self.tasks.wait().await;
        self.wait_closed(&self.root).await?;
        Ok(())
    }

    /// 独立使用 Supervisor 时，同时收尾任务资源与执行后端。
    pub async fn shutdown(&self) -> Result<()> {
        let clean = self.drain().await;
        let backend = self.backend.shutdown().await;
        clean?;
        backend
    }
}

fn handle(epoch: &str, kind: &str) -> String {
    format!("{epoch}:{kind}:{}", uuid::Uuid::new_v4())
}
fn bind_directories(reads: &[PathBuf], writes: &[PathBuf]) -> Result<Vec<Directory>> {
    reads
        .iter()
        .chain(writes)
        .map(|path| Directory::bind(path))
        .collect()
}
fn not_found() -> Error {
    Error::new(
        ErrorCode::NotFound,
        "resource or retained operation not found",
    )
}
fn unavailable(message: &str) -> Error {
    Error::new(ErrorCode::Unavailable, message)
}
fn exhausted(message: &str) -> Error {
    Error::new(ErrorCode::ResourceExhausted, message)
}
fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value)
        .map_err(|_| unavailable("stored operation result is inconsistent"))
}
fn digest(method: &str, value: &impl serde::Serialize) -> Result<[u8; 32]> {
    // Binary input expands in base64; keep room for the RPC frame while
    // accepting the protocol's complete 64 KiB raw-byte chunk.
    let limit = if matches!(method, "fs.execute" | "process.write") {
        MAX_FRAME_BYTES - 4096
    } else {
        64 * 1024
    };
    digest_bounded(method, value, limit)
}
fn digest_bounded(method: &str, value: &impl serde::Serialize, limit: usize) -> Result<[u8; 32]> {
    let bytes = serde_json::to_vec(&(method, value)).map_err(|_| invalid("invalid operation"))?;
    if bytes.len() > limit {
        return Err(invalid("operation payload exceeds its encoded byte limit"));
    }
    Ok(Sha256::digest(bytes).into())
}
fn new_operation(id: String, digest: [u8; 32]) -> Operation {
    Operation {
        digest,
        info: OperationInfo {
            operation_id: id,
            state: OperationState::Accepted,
            result: None,
            error: None,
        },
        complete: watch::channel(None).0,
    }
}
fn replay(state: &Registry, id: &str, digest: [u8; 32]) -> Result<Option<CompletionReceiver>> {
    match state.operations.get(id) {
        None => Ok(None),
        Some(old) if old.digest == digest => Ok(Some(old.complete.subscribe())),
        Some(_) => Err(Error::new(
            ErrorCode::Conflict,
            "operationId was already used for a different request",
        )),
    }
}
fn complete_operation(
    state: &mut Registry,
    id: &str,
    result: Result<Value>,
    status: OperationState,
) {
    let operation = state.operations.get_mut(id).unwrap();
    operation.info.state = status;
    match &result {
        Ok(value) => operation.info.result = Some(value.clone()),
        Err(error) => operation.info.error = Some(error.clone()),
    }
    operation.complete.send_replace(Some(result));
}
fn ensure_active(scope: &Scope) -> Result<()> {
    if scope.info.state != ScopeState::Active {
        Err(Error::new(
            ErrorCode::ScopeClosed,
            "scope admission is closed",
        ))
    } else {
        Ok(())
    }
}
fn ancestors(state: &Registry, scope_id: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let mut next = Some(scope_id);
    while let Some(id) = next {
        ids.push(id.into());
        next = state.scopes[id].info.parent_scope_id.as_deref();
    }
    ids
}
fn close_empty_scopes(state: &mut Registry) {
    for scope in state.scopes.values_mut() {
        if scope.info.state == ScopeState::Revoking
            && scope.info.active_processes == 0
            && scope.info.cleanup_error.is_none()
        {
            scope.info.state = ScopeState::Closed;
        }
    }
}
fn revoke_locked(state: &mut Registry, scope_id: &str) {
    let owned: Vec<_> = state
        .scopes
        .keys()
        .filter(|id| ancestors(state, id).iter().any(|p| p == scope_id))
        .cloned()
        .collect();
    for id in &owned {
        let scope = state.scopes.get_mut(id).unwrap();
        if scope.info.state == ScopeState::Active {
            scope.info.state = ScopeState::Revoking;
        }
    }
    for process in state.processes.values_mut() {
        if owned.contains(&process.info.scope_id)
            && matches!(
                process.info.state,
                ProcessState::Starting | ProcessState::Running
            )
        {
            process
                .info
                .stop_reason
                .get_or_insert_with(|| "scope revoked".into());
            process.cancel.cancel();
        }
    }
    close_empty_scopes(state);
}
fn release_process(state: &mut Registry, process_id: &str) {
    let process = state.processes.get_mut(process_id).unwrap();
    process.info.state = ProcessState::Exited;
    process.output.closed = true;
    let owners = process.ancestors.clone();
    for owner in owners {
        state.scopes.get_mut(&owner).unwrap().info.active_processes -= 1;
    }
    close_empty_scopes(state);
}
fn validate_process(request: &StartProcess) -> Result<()> {
    if request.limits.max_processes.is_some() {
        return Err(Error::new(
            ErrorCode::Unsupported,
            "maxProcesses applies to scopes, not individual processes",
        ));
    }
    if request.argv.is_empty()
        || request.argv.len() > 256
        || request.argv[0].is_empty()
        || request.argv.iter().any(|arg| arg.contains('\0'))
    {
        return Err(invalid("argv must contain 1..256 arguments without NUL"));
    }
    for (key, value) in &request.env {
        if !["PATH", "LANG", "LC_ALL", "TERM", "CI", "RUST_BACKTRACE"].contains(&key.as_str()) {
            return Err(denied(
                "environment variable is not in the deployment allowlist",
            ));
        }
        if value.contains('\0') || value.len() > 4096 {
            return Err(invalid("invalid environment value"));
        }
    }
    Ok(())
}
