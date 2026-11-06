use areal_runtime_protocol::*;
use areal_runtime_supervisor::{
    Config, Supervisor,
    backend::{Backend, Event, Execution, ScopeAccess},
};
use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Semaphore, mpsc};

struct Executor {
    starts: AtomicUsize,
    terminations: AtomicUsize,
    gate: Semaphore,
    entered: Semaphore,
    reject: AtomicBool,
    reject_restricted: AtomicBool,
    lose_start_reply: AtomicBool,
    cleanup_start_failure: AtomicBool,
    fail_cleanup: AtomicBool,
    routes: Mutex<HashMap<String, mpsc::Sender<Event>>>,
    executions: Mutex<Vec<Execution>>,
}
impl Executor {
    fn new(gated: bool) -> Arc<Self> {
        Arc::new(Self {
            starts: AtomicUsize::new(0),
            terminations: AtomicUsize::new(0),
            gate: Semaphore::new(if gated { 0 } else { 100 }),
            entered: Semaphore::new(0),
            reject: AtomicBool::new(false),
            reject_restricted: AtomicBool::new(false),
            lose_start_reply: AtomicBool::new(false),
            cleanup_start_failure: AtomicBool::new(false),
            fail_cleanup: AtomicBool::new(false),
            routes: Mutex::new(HashMap::new()),
            executions: Mutex::new(Vec::new()),
        })
    }
    async fn entered(&self) {
        self.entered.acquire().await.unwrap().forget();
    }
    async fn finish(&self, id: &str, bytes: &[u8]) {
        let sender = self.routes.lock().unwrap().remove(id).unwrap();
        if !bytes.is_empty() {
            let _ = sender
                .send(Event::Output(OutputStream::Stdout, bytes.to_vec()))
                .await;
        }
        let _ = sender
            .send(Event::Exited {
                exit_code: Some(0),
                signal: None,
                sandbox_denied: false,
            })
            .await;
        let _ = sender.send(Event::Closed).await;
    }
}
#[async_trait]
impl Backend for Executor {
    fn check_scope(&self, access: ScopeAccess, has_read_only_paths: bool) -> Result<()> {
        if self.reject_restricted.load(Ordering::SeqCst)
            && (access == ScopeAccess::Restricted || has_read_only_paths)
        {
            return Err(Error::new(
                ErrorCode::Unsupported,
                "fixture: restricted sandbox unavailable",
            ));
        }
        Ok(())
    }
    async fn start(&self, execution: Execution) -> Result<mpsc::Receiver<Event>> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        self.executions.lock().unwrap().push(execution.clone());
        if self.reject.load(Ordering::SeqCst) {
            return Err(Error::new(
                ErrorCode::PermissionDenied,
                "fixture denied start",
            ));
        }
        let (tx, rx) = mpsc::channel(16);
        self.routes
            .lock()
            .unwrap()
            .insert(execution.process_id.clone(), tx);
        self.entered.add_permits(1);
        self.gate.acquire().await.unwrap().forget();
        if self.lose_start_reply.load(Ordering::SeqCst) {
            return Err(Error::new(
                if self.cleanup_start_failure.load(Ordering::SeqCst) {
                    ErrorCode::CleanupFailed
                } else {
                    ErrorCode::Unavailable
                },
                "fixture lost start reply",
            ));
        }
        Ok(rx)
    }
    async fn terminate(&self, id: &str) -> Result<()> {
        self.terminations.fetch_add(1, Ordering::SeqCst);
        if self.fail_cleanup.load(Ordering::SeqCst) {
            return Err(Error::new(ErrorCode::Unavailable, "fixture lost executor"));
        }
        let sender = self.routes.lock().unwrap().remove(id);
        if let Some(sender) = sender {
            let _ = sender
                .send(Event::Exited {
                    exit_code: Some(137),
                    signal: None,
                    sandbox_denied: false,
                })
                .await;
            let _ = sender.send(Event::Closed).await;
        }
        Ok(())
    }
    async fn shutdown(&self) -> Result<()> {
        self.routes.lock().unwrap().clear();
        if self.fail_cleanup.load(Ordering::SeqCst) {
            return Err(Error::new(
                ErrorCode::CleanupFailed,
                "fixture cleanup could not be confirmed",
            ));
        }
        Ok(())
    }
}

fn op(runtime: &Supervisor) -> String {
    format!(
        "{}:op:{}",
        runtime.connection_info().runtime_epoch,
        uuid::Uuid::new_v4()
    )
}

#[tokio::test]
async fn restricted_home_uses_authorized_scratch_without_importing_or_widening_permissions() {
    let repo = tempfile::tempdir().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let repo_path = repo.path().canonicalize().unwrap();
    let scratch_path = scratch.path().canonicalize().unwrap();
    let thread_scratch = scratch_path.join("thread");
    std::fs::create_dir(&thread_scratch).unwrap();
    let escape = repo_path.join("escape");
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path(), &escape).unwrap();
    for requested in [
        None,
        Some(thread_scratch.clone()),
        Some(outside.path().to_path_buf()),
        Some(escape),
        Some("relative".into()),
    ] {
        let executor = Executor::new(false);
        let mut config = Config::read_only(repo_path.clone());
        config.scratch = Some(scratch_path.clone());
        let runtime = Supervisor::new(config, executor.clone()).unwrap();
        let root = runtime.connection_info().root_scope_id;
        let mut request = child(&runtime, &root);
        request.permissions.read_roots = Some(vec![
            "workspace://repo".into(),
            "workspace://scratch/thread".into(),
        ]);
        request.permissions.write_roots = Some(vec!["workspace://scratch/thread".into()]);
        request.permissions.network = NetworkRequest::Deny;
        let scope = runtime.create_scope(request).unwrap();
        let mut request = process(&runtime, &scope.scope_id);
        if let Some(path) = &requested {
            request
                .env
                .insert("TMPDIR".into(), path.to_string_lossy().into_owned());
        }
        let started = bounded(runtime.start(request)).await.unwrap();
        let execution = executor.executions.lock().unwrap()[0].clone();
        let expected = if requested.is_none() || requested.as_ref() == Some(&thread_scratch) {
            &thread_scratch
        } else {
            &repo_path
        };
        assert_eq!(execution.env["HOME"], expected.to_string_lossy());
        assert_eq!(execution.write_roots, vec![thread_scratch.clone()]);
        assert_eq!(execution.network, NetworkRequest::Deny);
        if requested.is_none() {
            assert_eq!(execution.env["TMPDIR"], thread_scratch.to_string_lossy());
        }
        let mut expected_reads = vec![repo_path.clone(), thread_scratch.clone()];
        expected_reads.sort();
        assert_eq!(execution.read_roots, expected_reads);
        executor.finish(&started.process_id, b"").await;
        bounded(runtime.shutdown()).await.unwrap();
    }
}

#[tokio::test]
async fn full_access_preserves_the_deployment_path_and_explicit_command_overrides() {
    let repo = tempfile::tempdir().unwrap();
    let executor = Executor::new(false);
    let mut config = Config::read_only(repo.path().into());
    config.full_access = true;
    config.writable = true;
    config.allow_network = true;
    config.command_search_path = Some("/deployment/bin:/usr/bin:/bin".into());
    config.unrestricted_command_search_path =
        Some("/host/shims:/deployment/bin:/usr/bin:/bin".into());
    let runtime = Supervisor::new(config, executor.clone()).unwrap();
    let root = runtime.connection_info().root_scope_id;
    for override_path in [None, Some("/explicit/bin:/usr/bin")] {
        let mut request = process(&runtime, &root);
        if let Some(path) = override_path {
            request.env.insert("PATH".into(), path.into());
        }
        let started = bounded(runtime.start(request)).await.unwrap();
        let execution = executor.executions.lock().unwrap().last().unwrap().clone();
        assert_eq!(
            execution.env["PATH"],
            override_path.unwrap_or("/host/shims:/deployment/bin:/usr/bin:/bin")
        );
        if let Ok(home) = std::env::var("HOME") {
            assert_eq!(execution.env["HOME"], home);
        }
        executor.finish(&started.process_id, b"").await;
    }
    let child = runtime
        .create_scope(CreateScope {
            operation_id: op(&runtime),
            parent_scope_id: root,
            owner: Owner {
                task_id: "restricted".into(),
                plugin_instance_id: None,
            },
            permissions: PermissionRequest {
                read_roots: Some(vec!["workspace://repo".into()]),
                write_roots: Some(vec![]),
                network: NetworkRequest::Deny,
            },
            limits: LimitRequest::default(),
        })
        .unwrap();
    let started = runtime
        .start(process(&runtime, &child.scope_id))
        .await
        .unwrap();
    let execution = executor.executions.lock().unwrap().last().unwrap().clone();
    assert_eq!(execution.env["PATH"], "/deployment/bin:/usr/bin:/bin");
    assert_eq!(
        execution.env["HOME"],
        repo.path().canonicalize().unwrap().to_string_lossy()
    );
    assert!(!execution.env.contains_key("RUSTUP_HOME"));
    executor.finish(&started.process_id, b"").await;
    bounded(runtime.shutdown()).await.unwrap();
}

struct InputExecutor {
    process: Arc<Executor>,
    expected: Vec<u8>,
    writes: AtomicUsize,
    entered: Semaphore,
    reply: Semaphore,
    lose_reply: bool,
}
#[async_trait]
impl Backend for InputExecutor {
    fn supports_input(&self) -> bool {
        true
    }
    async fn start(&self, execution: Execution) -> Result<mpsc::Receiver<Event>> {
        self.process.start(execution).await
    }
    async fn terminate(&self, id: &str) -> Result<()> {
        self.process.terminate(id).await
    }
    async fn shutdown(&self) -> Result<()> {
        self.process.shutdown().await
    }
    async fn write(&self, _: &str, _: &str, bytes: &[u8]) -> Result<()> {
        assert_eq!(bytes, self.expected);
        self.writes.fetch_add(1, Ordering::SeqCst);
        self.entered.add_permits(1);
        self.reply.acquire().await.unwrap().forget();
        if self.lose_reply {
            Err(Error::new(
                ErrorCode::Unavailable,
                "input acknowledgement lost",
            ))
        } else {
            Ok(())
        }
    }
}

#[tokio::test]
async fn cancelled_input_waiter_retains_one_operation_and_revoke_blocks_new_input() {
    let directory = tempfile::tempdir().unwrap();
    let executor = Arc::new(InputExecutor {
        process: Executor::new(false),
        expected: b"input\n".to_vec(),
        writes: AtomicUsize::new(0),
        entered: Semaphore::new(0),
        reply: Semaphore::new(0),
        lose_reply: false,
    });
    let runtime =
        Supervisor::new(Config::read_only(directory.path().into()), executor.clone()).unwrap();
    let root = runtime.connection_info().root_scope_id;
    let mut start = process(&runtime, &root);
    start.pipe_stdin = true;
    let started = runtime.start(start).await.unwrap();
    let request = ProcessInput {
        operation_id: op(&runtime),
        process_id: started.process_id,
        data_base64: STANDARD.encode(b"input\n"),
    };
    let waiting = {
        let runtime = runtime.clone();
        let request = request.clone();
        tokio::spawn(async move { runtime.write(request).await })
    };
    bounded(executor.entered.acquire()).await.unwrap().forget();
    waiting.abort();
    let _ = waiting.await;
    executor.reply.add_permits(1);
    assert_eq!(
        bounded(runtime.write(request.clone())).await.unwrap(),
        serde_json::json!({"accepted":true})
    );
    assert_eq!(executor.writes.load(Ordering::SeqCst), 1);
    assert_eq!(
        runtime.operation(&request.operation_id).unwrap().state,
        OperationState::Succeeded
    );
    let mut conflict = request.clone();
    conflict.data_base64 = STANDARD.encode(b"other");
    assert_eq!(
        runtime.write(conflict).await.unwrap_err().code,
        ErrorCode::Conflict
    );
    runtime.revoke(&root).unwrap();
    assert_eq!(
        runtime
            .write(ProcessInput {
                operation_id: op(&runtime),
                ..request
            })
            .await
            .unwrap_err()
            .code,
        ErrorCode::ScopeClosed
    );
    bounded(runtime.shutdown()).await.unwrap();
}

#[tokio::test]
async fn lost_input_acknowledgement_is_unknown_and_closes_admission_without_replay() {
    let directory = tempfile::tempdir().unwrap();
    let executor = Arc::new(InputExecutor {
        process: Executor::new(false),
        expected: b"input\n".to_vec(),
        writes: AtomicUsize::new(0),
        entered: Semaphore::new(0),
        reply: Semaphore::new(1),
        lose_reply: true,
    });
    let runtime =
        Supervisor::new(Config::read_only(directory.path().into()), executor.clone()).unwrap();
    let root = runtime.connection_info().root_scope_id;
    let mut start = process(&runtime, &root);
    start.pipe_stdin = true;
    let started = runtime.start(start).await.unwrap();
    let request = ProcessInput {
        operation_id: op(&runtime),
        process_id: started.process_id,
        data_base64: STANDARD.encode(b"input\n"),
    };
    assert_eq!(
        bounded(runtime.write(request.clone()))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Unavailable
    );
    assert_eq!(
        runtime.operation(&request.operation_id).unwrap().state,
        OperationState::Unknown
    );
    assert_ne!(runtime.scope(&root).unwrap().state, ScopeState::Active);
    assert_eq!(
        bounded(runtime.write(request)).await.unwrap_err().code,
        ErrorCode::Unavailable
    );
    assert_eq!(executor.writes.load(Ordering::SeqCst), 1);
    let _ = bounded(runtime.shutdown()).await;
}

#[tokio::test]
async fn binary_input_accepts_the_full_chunk_once_and_rejects_oversized_input() {
    let directory = tempfile::tempdir().unwrap();
    let bytes: Vec<_> = (0..MAX_FILE_CHUNK).map(|index| index as u8).collect();
    let executor = Arc::new(InputExecutor {
        process: Executor::new(false),
        expected: bytes.clone(),
        writes: AtomicUsize::new(0),
        entered: Semaphore::new(0),
        reply: Semaphore::new(1),
        lose_reply: false,
    });
    let runtime =
        Supervisor::new(Config::read_only(directory.path().into()), executor.clone()).unwrap();
    let mut start = process(&runtime, &runtime.connection_info().root_scope_id);
    start.pipe_stdin = true;
    let started = runtime.start(start).await.unwrap();
    let request = ProcessInput {
        operation_id: op(&runtime),
        process_id: started.process_id,
        data_base64: STANDARD.encode(&bytes),
    };
    let mut oversized = request.clone();
    oversized.data_base64 = STANDARD.encode(vec![0; MAX_FILE_CHUNK + 1]);
    assert_eq!(
        runtime.write(oversized).await.unwrap_err().code,
        ErrorCode::InvalidArgument
    );
    assert_eq!(executor.writes.load(Ordering::SeqCst), 0);
    assert_eq!(
        bounded(runtime.write(request.clone())).await.unwrap(),
        serde_json::json!({"accepted":true})
    );
    assert_eq!(
        bounded(runtime.write(request)).await.unwrap(),
        serde_json::json!({"accepted":true})
    );
    assert_eq!(executor.writes.load(Ordering::SeqCst), 1);
    bounded(runtime.shutdown()).await.unwrap();
}

#[tokio::test]
async fn file_responses_preserve_full_chunks_with_small_command_windows() {
    for window in [1, MAX_READ_BYTES] {
        let directory = tempfile::tempdir().unwrap();
        let executor = Executor::new(false);
        let mut config = Config::read_only(directory.path().into());
        config.output_window_bytes = window;
        config.file_helper = Some(std::env::current_exe().unwrap());
        let runtime = Supervisor::new(config, executor.clone()).unwrap();
        let request = FileRequest {
            operation_id: op(&runtime),
            scope_id: runtime.connection_info().root_scope_id,
            command: FileCommand::Read {
                path: "workspace://repo/file".into(),
                offset: 0,
                max_bytes: MAX_FILE_CHUNK,
            },
        };
        let call = {
            let runtime = runtime.clone();
            let request = request.clone();
            tokio::spawn(async move { runtime.filesystem(request).await })
        };
        bounded(executor.entered()).await;
        let process_id = executor.executions.lock().unwrap()[0].process_id.clone();
        let expected = serde_json::json!({"dataBase64": STANDARD.encode(vec![0xab; MAX_FILE_CHUNK]),
            "sha256":"a".repeat(64),"size":MAX_FILE_CHUNK,"nextOffset":MAX_FILE_CHUNK,"eof":true});
        executor
            .finish(
                &process_id,
                &serde_json::to_vec(&serde_json::json!({"result":expected})).unwrap(),
            )
            .await;
        assert_eq!(bounded(call).await.unwrap().unwrap(), expected);
        assert_eq!(
            bounded(runtime.filesystem(request.clone())).await.unwrap(),
            expected
        );
        let operation = runtime.operation(&request.operation_id).unwrap();
        assert_eq!(operation.state, OperationState::Succeeded);
        assert!(serde_json::to_vec(&operation).unwrap().len() < MAX_FRAME_BYTES);
        assert_eq!(executor.starts.load(Ordering::SeqCst), 1);
        bounded(runtime.shutdown()).await.unwrap();
    }
}

#[tokio::test]
async fn readonly_file_output_quota_is_known_but_mutation_acknowledgement_remains_unknown() {
    for kind in ["write", "read", "image"] {
        let writes = kind == "write";
        let directory = tempfile::tempdir().unwrap();
        let executor = Executor::new(false);
        let mut config = Config::read_only(directory.path().into());
        config.writable = true;
        config.file_helper = Some(std::env::current_exe().unwrap());
        config.limits.output_bytes = 1024;
        let runtime = Supervisor::new(config, executor.clone()).unwrap();
        let root = runtime.connection_info().root_scope_id;
        let request = FileRequest {
            operation_id: op(&runtime),
            scope_id: root.clone(),
            command: if writes {
                FileCommand::Write {
                    path: "workspace://repo/file".into(),
                    data_base64: STANDARD.encode("changed"),
                    expected: ExpectedFile::Absent,
                }
            } else if kind == "image" {
                FileCommand::ReadImage {
                    path: "workspace://repo/file".into(),
                    options: Default::default(),
                }
            } else {
                FileCommand::Read {
                    path: "workspace://repo/file".into(),
                    offset: 0,
                    max_bytes: MAX_FILE_CHUNK,
                }
            },
        };
        let call = {
            let runtime = runtime.clone();
            let request = request.clone();
            tokio::spawn(async move { runtime.filesystem(request).await })
        };
        bounded(executor.entered()).await;
        let process_id = executor.executions.lock().unwrap()[0].process_id.clone();
        executor
            .finish(
                &process_id,
                &serde_json::to_vec(
                    &serde_json::json!({"result":{"dataBase64":STANDARD.encode(vec![0xab;8192])}}),
                )
                .unwrap(),
            )
            .await;
        let error = bounded(call).await.unwrap().unwrap_err();
        assert_eq!(runtime.scope(&root).unwrap().output_bytes, 1024);
        assert!(runtime.process(&process_id).unwrap().cleanup_confirmed);
        assert_eq!(
            error.code,
            if writes {
                ErrorCode::Unavailable
            } else {
                ErrorCode::ResourceExhausted
            },
            "{error}"
        );
        assert_eq!(
            runtime.operation(&request.operation_id).unwrap().state,
            if writes {
                OperationState::Unknown
            } else {
                OperationState::Failed
            }
        );
        assert_eq!(
            runtime.filesystem(request).await.unwrap_err().code,
            error.code
        );
        assert_eq!(executor.starts.load(Ordering::SeqCst), 1);
        bounded(runtime.shutdown()).await.unwrap();
    }
}

#[tokio::test]
async fn queued_process_start_retains_identity_and_runs_once_after_capacity_is_freed() {
    let directory = tempfile::tempdir().unwrap();
    let executor = Executor::new(false);
    let mut config = Config::read_only(directory.path().into());
    config.limits.max_processes = 1;
    let runtime = Supervisor::new(config, executor.clone()).unwrap();
    let root = runtime.connection_info().root_scope_id;
    let background = runtime.start(process(&runtime, &root)).await.unwrap();
    bounded(executor.entered()).await;
    let request = process(&runtime, &root);
    let first = {
        let runtime = runtime.clone();
        let request = request.clone();
        tokio::spawn(async move { runtime.start_queued(request).await })
    };
    bounded(async {
        while runtime.operation(&request.operation_id).is_err() {
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert_eq!(
        runtime.operation(&request.operation_id).unwrap().state,
        OperationState::Accepted
    );
    first.abort();
    let replay = {
        let runtime = runtime.clone();
        let request = request.clone();
        tokio::spawn(async move { runtime.start_queued(request).await })
    };
    let mut conflict = request.clone();
    conflict.argv.push("different".into());
    assert_eq!(
        runtime.start_queued(conflict).await.unwrap_err().code,
        ErrorCode::Conflict
    );
    assert_eq!(executor.starts.load(Ordering::SeqCst), 1);
    executor.finish(&background.process_id, b"").await;
    let started = bounded(replay).await.unwrap().unwrap();
    assert_eq!(
        runtime
            .start_queued(request.clone())
            .await
            .unwrap()
            .process_id,
        started.process_id
    );
    assert_eq!(executor.starts.load(Ordering::SeqCst), 2);
    assert_eq!(
        runtime.operation(&request.operation_id).unwrap().state,
        OperationState::Succeeded
    );
    assert_eq!(runtime.scope(&root).unwrap().active_processes, 1);
    executor.finish(&started.process_id, b"").await;
    bounded(runtime.shutdown()).await.unwrap();
}

#[tokio::test]
async fn queued_start_keeps_unknown_outcome_without_replaying_the_backend() {
    let directory = tempfile::tempdir().unwrap();
    let executor = Executor::new(false);
    executor.lose_start_reply.store(true, Ordering::SeqCst);
    let runtime =
        Supervisor::new(Config::read_only(directory.path().into()), executor.clone()).unwrap();
    let request = process(&runtime, &runtime.connection_info().root_scope_id);
    for _ in 0..2 {
        let error = bounded(runtime.start_queued(request.clone()))
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Unavailable);
        assert_eq!(
            runtime.operation(&request.operation_id).unwrap().state,
            OperationState::Unknown
        );
    }
    assert_eq!(executor.starts.load(Ordering::SeqCst), 1);
    let _ = bounded(runtime.shutdown()).await;
}

#[tokio::test]
async fn queued_process_start_records_cancellation_before_any_execution() {
    let directory = tempfile::tempdir().unwrap();
    let executor = Executor::new(false);
    let mut config = Config::read_only(directory.path().into());
    config.limits.max_processes = 1;
    let runtime = Supervisor::new(config, executor.clone()).unwrap();
    let root = runtime.connection_info().root_scope_id;
    runtime.start(process(&runtime, &root)).await.unwrap();
    let scope = runtime.create_scope(child(&runtime, &root)).unwrap();
    let request = process(&runtime, &scope.scope_id);
    let queued = {
        let runtime = runtime.clone();
        let request = request.clone();
        tokio::spawn(async move { runtime.start_queued(request).await })
    };
    bounded(async {
        while runtime.operation(&request.operation_id).is_err() {
            tokio::task::yield_now().await;
        }
    })
    .await;
    runtime.revoke(&scope.scope_id).unwrap();
    assert_eq!(
        bounded(queued).await.unwrap().unwrap_err().code,
        ErrorCode::ScopeClosed
    );
    assert_eq!(
        runtime.operation(&request.operation_id).unwrap().state,
        OperationState::Cancelled
    );
    assert_eq!(executor.starts.load(Ordering::SeqCst), 1);
    bounded(runtime.shutdown()).await.unwrap();
}

// 单个祖先名额被后台命令占用时，所有文件操作排队且每个 operation 只执行一次。
#[tokio::test]
async fn file_helpers_wait_for_shared_process_capacity_without_replay() {
    let directory = tempfile::tempdir().unwrap();
    let executor = Executor::new(false);
    let mut config = Config::read_only(directory.path().into());
    config.limits.max_processes = 1;
    config.file_helper = Some(std::env::current_exe().unwrap());
    let runtime = Supervisor::new(config, executor.clone()).unwrap();
    let root = runtime.connection_info().root_scope_id;
    let background = runtime.start(process(&runtime, &root)).await.unwrap();
    bounded(executor.entered()).await;
    let scope = runtime.create_scope(child(&runtime, &root)).unwrap();
    let mut calls = Vec::new();
    let mut requests = Vec::new();
    for n in 0..8 {
        let request = FileRequest {
            operation_id: op(&runtime),
            scope_id: scope.scope_id.clone(),
            command: FileCommand::Read {
                path: format!("workspace://repo/file-{n}"),
                offset: 0,
                max_bytes: 64,
            },
        };
        // 并发重放相同 ID 必须复用等待和结果。
        for _ in 0..2 {
            let runtime = runtime.clone();
            let request = request.clone();
            calls.push(tokio::spawn(
                async move { runtime.filesystem(request).await },
            ));
        }
        requests.push(request);
    }
    bounded(async {
        while requests
            .iter()
            .any(|request| runtime.operation(&request.operation_id).is_err())
        {
            tokio::task::yield_now().await;
        }
    })
    .await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(calls.iter().all(|call| !call.is_finished()));
    assert_eq!(executor.starts.load(Ordering::SeqCst), 1);
    // 显式命令保持原来的资源拒绝语义。
    assert_eq!(
        runtime
            .start(process(&runtime, &root))
            .await
            .unwrap_err()
            .code,
        ErrorCode::ResourceExhausted
    );
    executor.finish(&background.process_id, b"").await;
    let result = serde_json::json!({"dataBase64":STANDARD.encode("value"),"eof":true});
    let envelope = serde_json::to_vec(&serde_json::json!({"result":result})).unwrap();
    for n in 1..=8 {
        bounded(executor.entered()).await;
        assert_eq!(executor.starts.load(Ordering::SeqCst), n + 1);
        assert_eq!(runtime.scope(&root).unwrap().active_processes, 1);
        let id = executor.executions.lock().unwrap()[n].process_id.clone();
        executor.finish(&id, &envelope).await;
    }
    for call in calls {
        assert_eq!(bounded(call).await.unwrap().unwrap(), result);
    }
    for request in requests {
        assert_eq!(runtime.filesystem(request).await.unwrap(), result);
    }
    assert_eq!(executor.starts.load(Ordering::SeqCst), 9);
    bounded(runtime.shutdown()).await.unwrap();
}

#[tokio::test]
async fn queued_files_stop_on_scope_revocation_and_admission_deadline() {
    for revoke in [true, false] {
        let directory = tempfile::tempdir().unwrap();
        let executor = Executor::new(false);
        let mut config = Config::read_only(directory.path().into());
        config.limits.max_processes = 1;
        config.file_helper = Some(std::env::current_exe().unwrap());
        let runtime = Supervisor::new(config, executor.clone()).unwrap();
        let root = runtime.connection_info().root_scope_id;
        runtime.start(process(&runtime, &root)).await.unwrap();
        bounded(executor.entered()).await;
        let mut request = child(&runtime, &root);
        request.limits.wall_time_ms = Some(if revoke { 5000 } else { 80 });
        let scope = runtime.create_scope(request).unwrap();
        let request = FileRequest {
            operation_id: op(&runtime),
            scope_id: scope.scope_id.clone(),
            command: FileCommand::Stat {
                path: "workspace://repo/file".into(),
            },
        };
        let call = {
            let runtime = runtime.clone();
            let request = request.clone();
            tokio::spawn(async move { runtime.filesystem(request).await })
        };
        bounded(async {
            while runtime.operation(&request.operation_id).is_err() {
                tokio::task::yield_now().await;
            }
        })
        .await;
        if revoke {
            runtime.revoke(&scope.scope_id).unwrap();
        }
        let error = bounded(call).await.unwrap().unwrap_err();
        assert_eq!(
            error.code,
            if revoke {
                ErrorCode::ScopeClosed
            } else {
                ErrorCode::ResourceExhausted
            }
        );
        assert_eq!(
            runtime.operation(&request.operation_id).unwrap().state,
            if revoke {
                OperationState::Cancelled
            } else {
                OperationState::Failed
            }
        );
        assert_eq!(executor.starts.load(Ordering::SeqCst), 1);
        bounded(runtime.shutdown()).await.unwrap();
    }
}

#[tokio::test]
async fn exhausted_output_is_not_treated_as_temporary_file_capacity() {
    let directory = tempfile::tempdir().unwrap();
    let executor = Executor::new(false);
    let mut config = Config::read_only(directory.path().into());
    config.limits.output_bytes = 1;
    config.file_helper = Some(std::env::current_exe().unwrap());
    let runtime = Supervisor::new(config, executor.clone()).unwrap();
    let root = runtime.connection_info().root_scope_id;
    let background = runtime.start(process(&runtime, &root)).await.unwrap();
    executor.finish(&background.process_id, b"x").await;
    bounded(async {
        while runtime.scope(&root).unwrap().active_processes != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await;
    let error = bounded(runtime.filesystem(FileRequest {
        operation_id: op(&runtime),
        scope_id: root,
        command: FileCommand::Stat {
            path: "workspace://repo/file".into(),
        },
    }))
    .await
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::ResourceExhausted);
    assert!(error.message.contains("cumulative output"));
    assert_eq!(executor.starts.load(Ordering::SeqCst), 1);
    bounded(runtime.shutdown()).await.unwrap();
}

#[tokio::test]
async fn handshake_reports_the_effective_root_network_grant() {
    for allow in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let mut config = Config::read_only(directory.path().into());
        config.allow_network = allow;
        let runtime = Supervisor::new(config, Executor::new(false)).unwrap();
        let info = runtime.connection_info();
        let root = runtime.scope(&info.root_scope_id).unwrap();
        assert_eq!(
            info.capabilities["rootNetwork"],
            serde_json::json!(root.network)
        );
        assert_eq!(root.network == NetworkRequest::Inherit, allow);
        bounded(runtime.shutdown()).await.unwrap();
    }
}

#[tokio::test]
async fn malformed_file_helper_error_preserves_an_unknown_operation() {
    let directory = tempfile::tempdir().unwrap();
    let executor = Executor::new(false);
    let mut config = Config::read_only(directory.path().into());
    config.file_helper = Some(std::env::current_exe().unwrap());
    let runtime = Supervisor::new(config, executor.clone()).unwrap();
    let operation_id = op(&runtime);
    let request = FileRequest {
        operation_id: operation_id.clone(),
        scope_id: runtime.connection_info().root_scope_id,
        command: FileCommand::Stat {
            path: "workspace://repo/file".into(),
        },
    };
    let call = {
        let runtime = runtime.clone();
        tokio::spawn(async move { runtime.filesystem(request).await })
    };
    bounded(executor.entered()).await;
    let process_id = executor.executions.lock().unwrap()[0].process_id.clone();
    executor
        .finish(&process_id, br#"{"error":{"malformed":true}}"#)
        .await;
    assert_eq!(
        bounded(call).await.unwrap().unwrap_err().code,
        ErrorCode::Unavailable
    );
    assert_eq!(
        runtime.operation(&operation_id).unwrap().state,
        OperationState::Unknown
    );
    bounded(runtime.shutdown()).await.unwrap();
}

#[tokio::test]
async fn revoking_a_plugin_generation_fences_future_scopes_and_closes_descendants() {
    let directory = tempfile::tempdir().unwrap();
    let executor = Executor::new(false);
    let runtime =
        Supervisor::new(Config::read_only(directory.path().into()), executor.clone()).unwrap();
    let root = runtime.connection_info().root_scope_id;
    let a = runtime.create_scope(child(&runtime, &root)).unwrap();
    let b = runtime.create_scope(child(&runtime, &root)).unwrap();
    let mut descendant = child(&runtime, &a.scope_id);
    descendant.owner.plugin_instance_id = Some("other-generation".into());
    let descendant = runtime.create_scope(descendant).unwrap();
    runtime
        .start(process(&runtime, &descendant.scope_id))
        .await
        .unwrap();
    let result = runtime
        .revoke_owner(RevokeOwner {
            plugin_instance_id: "fixture-plugin".into(),
        })
        .unwrap();
    assert_eq!(result.scope_ids.len(), 2);
    for scope in [&a.scope_id, &b.scope_id, &descendant.scope_id] {
        assert_eq!(
            bounded(runtime.wait_closed(scope)).await.unwrap().state,
            ScopeState::Closed
        );
    }
    assert_eq!(
        runtime
            .create_scope(child(&runtime, &root))
            .unwrap_err()
            .code,
        ErrorCode::ScopeClosed
    );
    runtime
        .revoke_owner(RevokeOwner {
            plugin_instance_id: "never-loaded".into(),
        })
        .unwrap();
    let mut future = child(&runtime, &root);
    future.owner.plugin_instance_id = Some("never-loaded".into());
    assert_eq!(
        runtime.create_scope(future).unwrap_err().code,
        ErrorCode::ScopeClosed
    );
    bounded(runtime.shutdown()).await.unwrap();
}

#[tokio::test]
async fn revocation_cancels_a_queued_writer_without_starting_it() {
    let directory = tempfile::tempdir().unwrap();
    let executor = Executor::new(false);
    let mut config = Config::read_only(directory.path().into());
    config.writable = true;
    let runtime = Supervisor::new(config, executor.clone()).unwrap();
    let root = runtime.connection_info().root_scope_id;
    let first = runtime.start(process(&runtime, &root)).await.unwrap();
    let scope = runtime.create_scope(child(&runtime, &root)).unwrap();
    let owned = runtime.clone();
    let request = process(&runtime, &scope.scope_id);
    let queued = tokio::spawn(async move { owned.start(request).await });
    bounded(async {
        while runtime.scope(&scope.scope_id).unwrap().active_processes == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await;
    runtime.revoke(&scope.scope_id).unwrap();
    assert_eq!(
        bounded(queued).await.unwrap().unwrap_err().code,
        ErrorCode::ScopeClosed
    );
    bounded(runtime.wait_closed(&scope.scope_id)).await.unwrap();
    assert_eq!(executor.starts.load(Ordering::SeqCst), 1);
    executor.finish(&first.process_id, b"").await;
    bounded(runtime.shutdown()).await.unwrap();
}
fn child(runtime: &Supervisor, parent: &str) -> CreateScope {
    CreateScope {
        operation_id: op(runtime),
        parent_scope_id: parent.into(),
        owner: Owner {
            task_id: "fixture-task".into(),
            plugin_instance_id: Some("fixture-plugin".into()),
        },
        permissions: PermissionRequest::default(),
        limits: LimitRequest::default(),
    }
}

#[tokio::test]
async fn unavailable_restricted_scope_is_side_effect_free_and_does_not_disable_full_access_parent()
{
    let directory = tempfile::tempdir().unwrap();
    let executor = Executor::new(false);
    executor.reject_restricted.store(true, Ordering::SeqCst);
    let mut config = Config::read_only(directory.path().into());
    config.full_access = true;
    config.writable = true;
    config.allow_network = true;
    let runtime = Supervisor::new(config, executor.clone()).unwrap();
    let info = runtime.connection_info();
    assert_eq!(info.capabilities["restrictedScopes"]["available"], false);
    let before = runtime.status();
    assert!(
        runtime
            .check_scope(CheckScope {
                parent_scope_id: info.root_scope_id.clone(),
                permissions: PermissionRequest::default(),
            })
            .unwrap()
            .available
    );
    let permissions = PermissionRequest {
        read_roots: Some(vec!["workspace://repo".into()]),
        write_roots: Some(Vec::new()),
        network: NetworkRequest::Deny,
    };
    for _ in 0..2 {
        assert_eq!(
            runtime
                .check_scope(CheckScope {
                    parent_scope_id: info.root_scope_id.clone(),
                    permissions: permissions.clone(),
                })
                .unwrap_err()
                .code,
            ErrorCode::Unsupported
        );
    }
    let mut request = child(&runtime, &info.root_scope_id);
    request.permissions = permissions;
    assert_eq!(
        runtime.create_scope(request).unwrap_err().code,
        ErrorCode::Unsupported
    );
    assert_eq!(runtime.status()["scopes"], before["scopes"]);
    assert_eq!(runtime.status()["operations"], before["operations"]);
    assert_eq!(executor.starts.load(Ordering::SeqCst), 0);
    let started = runtime
        .start(process(&runtime, &info.root_scope_id))
        .await
        .unwrap();
    executor
        .finish(&started.process_id, b"parent remains usable")
        .await;
    bounded(runtime.wait_process(&started.process_id))
        .await
        .unwrap();
    assert_eq!(
        executor.executions.lock().unwrap()[0].scope_access,
        ScopeAccess::Unrestricted
    );
    bounded(runtime.shutdown()).await.unwrap();
}

#[tokio::test]
async fn scope_check_preserves_parent_permissions_and_closed_scope_admission() {
    let directory = tempfile::tempdir().unwrap();
    let executor = Executor::new(false);
    let runtime = Supervisor::new(Config::read_only(directory.path().into()), executor).unwrap();
    let root = runtime.connection_info().root_scope_id;
    assert_eq!(
        runtime
            .check_scope(CheckScope {
                parent_scope_id: root.clone(),
                permissions: PermissionRequest {
                    write_roots: Some(vec!["workspace://repo".into()]),
                    ..Default::default()
                },
            })
            .unwrap_err()
            .code,
        ErrorCode::PermissionDenied
    );
    let scope = runtime.create_scope(child(&runtime, &root)).unwrap();
    runtime.revoke(&scope.scope_id).unwrap();
    assert_eq!(
        runtime
            .check_scope(CheckScope {
                parent_scope_id: scope.scope_id,
                permissions: PermissionRequest::default(),
            })
            .unwrap_err()
            .code,
        ErrorCode::ScopeClosed
    );
    bounded(runtime.shutdown()).await.unwrap();
}

#[tokio::test]
async fn file_writes_overlap_on_disjoint_paths_but_aliases_and_shell_roots_wait() {
    let directory = tempfile::tempdir().unwrap();
    let executor = Executor::new(false);
    let mut config = Config::read_only(directory.path().into());
    config.writable = true;
    config.limits.max_processes = 8;
    config.file_helper = Some(std::env::current_exe().unwrap());
    let runtime = Supervisor::new(config, executor.clone()).unwrap();
    let root = runtime.connection_info().root_scope_id;
    let write = |path: &str| {
        let request = FileRequest {
            operation_id: op(&runtime),
            scope_id: root.clone(),
            command: FileCommand::Write {
                path: format!("workspace://repo/{path}"),
                data_base64: STANDARD.encode("value"),
                expected: ExpectedFile::Absent,
            },
        };
        let runtime = runtime.clone();
        tokio::spawn(async move { runtime.filesystem(request).await })
    };
    let first = write("a");
    bounded(executor.entered()).await;
    let second = write("b");
    bounded(executor.entered()).await;
    assert_eq!(executor.starts.load(Ordering::SeqCst), 2);
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let third = write("A");
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let third = write("a");
    bounded(async {
        while runtime.scope(&root).unwrap().active_processes < 3 {
            tokio::task::yield_now().await;
        }
    })
    .await;
    let shell = {
        let r = runtime.clone();
        let p = process(&runtime, &root);
        tokio::spawn(async move { r.start(p).await })
    };
    bounded(async {
        while runtime.scope(&root).unwrap().active_processes < 4 {
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert_eq!(executor.starts.load(Ordering::SeqCst), 2);
    let processes = executor.executions.lock().unwrap().clone();
    executor
        .finish(&processes[0].process_id, br#"{"result":{}}"#)
        .await;
    bounded(first).await.unwrap().unwrap();
    bounded(executor.entered()).await;
    assert_eq!(executor.starts.load(Ordering::SeqCst), 3);
    let third_id = executor.executions.lock().unwrap()[2].process_id.clone();
    executor.finish(&third_id, br#"{"result":{}}"#).await;
    bounded(third).await.unwrap().unwrap();
    assert!(
        !shell.is_finished(),
        "enclosing shell still conflicts with b"
    );
    executor
        .finish(&processes[1].process_id, br#"{"result":{}}"#)
        .await;
    bounded(second).await.unwrap().unwrap();
    let shell = bounded(shell).await.unwrap().unwrap();
    executor.finish(&shell.process_id, b"").await;
    bounded(runtime.shutdown()).await.unwrap();
}

#[tokio::test]
async fn commands_with_disjoint_narrow_write_roots_run_concurrently() {
    let directory = tempfile::tempdir().unwrap();
    for name in ["a", "b"] {
        std::fs::create_dir(directory.path().join(name)).unwrap();
    }
    let executor = Executor::new(false);
    let mut config = Config::read_only(directory.path().into());
    config.writable = true;
    let runtime = Supervisor::new(config, executor.clone()).unwrap();
    let root = runtime.connection_info().root_scope_id;
    let mut processes = vec![];
    for name in ["a", "b"] {
        let mut request = child(&runtime, &root);
        request.permissions.write_roots = Some(vec![format!("workspace://repo/{name}")]);
        let scope = runtime.create_scope(request).unwrap();
        processes.push(
            bounded(runtime.start(process(&runtime, &scope.scope_id)))
                .await
                .unwrap(),
        );
    }
    assert_eq!(executor.starts.load(Ordering::SeqCst), 2);
    for process in processes {
        executor.finish(&process.process_id, b"").await;
    }
    bounded(runtime.shutdown()).await.unwrap();
}

#[tokio::test]
async fn deployment_network_is_inherited_but_denied_descendants_cannot_restore_it() {
    for granted in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let executor = Executor::new(false);
        let mut config = Config::read_only(directory.path().into());
        config.allow_network = granted;
        let runtime = Supervisor::new(config, executor.clone()).unwrap();
        let root = runtime.connection_info().root_scope_id;
        let inherited = runtime.create_scope(child(&runtime, &root)).unwrap();
        assert_eq!(
            inherited.network,
            if granted {
                NetworkRequest::Inherit
            } else {
                NetworkRequest::Deny
            }
        );
        let mut denied = child(&runtime, &inherited.scope_id);
        denied.permissions.network = NetworkRequest::Deny;
        let denied = runtime.create_scope(denied).unwrap();
        let descendant = runtime
            .create_scope(child(&runtime, &denied.scope_id))
            .unwrap();
        assert_eq!(descendant.network, NetworkRequest::Deny);
        let a = runtime
            .start(process(&runtime, &inherited.scope_id))
            .await
            .unwrap();
        let b = runtime
            .start(process(&runtime, &descendant.scope_id))
            .await
            .unwrap();
        let executions = executor.executions.lock().unwrap().clone();
        assert_eq!(executions[0].network, inherited.network);
        assert_eq!(executions[1].network, NetworkRequest::Deny);
        executor.finish(&a.process_id, b"").await;
        executor.finish(&b.process_id, b"").await;
        bounded(runtime.shutdown()).await.unwrap();
    }
}

#[tokio::test]
async fn explicitly_concurrent_commands_can_overlap_and_are_reclaimed() {
    let directory = tempfile::tempdir().unwrap();
    let executor = Executor::new(false);
    let mut config = Config::read_only(directory.path().into());
    config.writable = true;
    config.concurrent_writes = true;
    let runtime = Supervisor::new(config, executor.clone()).unwrap();
    let root = runtime.connection_info().root_scope_id;
    let first = bounded(runtime.start(process(&runtime, &root)))
        .await
        .unwrap();
    let second = bounded(runtime.start(process(&runtime, &root)))
        .await
        .unwrap();
    assert_eq!(runtime.scope(&root).unwrap().active_processes, 2);
    runtime.revoke(&root).unwrap();
    bounded(runtime.wait_closed(&root)).await.unwrap();
    assert_eq!(
        runtime.process(&first.process_id).unwrap().state,
        ProcessState::Exited
    );
    assert_eq!(
        runtime.process(&second.process_id).unwrap().state,
        ProcessState::Exited
    );
    bounded(runtime.shutdown()).await.unwrap();
}
fn process(runtime: &Supervisor, scope: &str) -> StartProcess {
    StartProcess {
        operation_id: op(runtime),
        scope_id: scope.into(),
        argv: vec!["fixture".into()],
        cwd: "workspace://repo".into(),
        env: BTreeMap::new(),
        tty: false,
        pipe_stdin: false,
        limits: LimitRequest::default(),
    }
}
async fn bounded<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(3), future)
        .await
        .expect("test must converge")
}

#[tokio::test]
async fn cumulative_output_warns_before_exhaustion_without_resetting_the_epoch() {
    for (limit, bytes, expected) in [
        (10, &b"1234567"[..], false),
        (10, &b"12345678"[..], true),
        (u64::MAX, &b"12345678"[..], false),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let executor = Executor::new(false);
        let mut config = Config::read_only(dir.path().into());
        config.limits.output_bytes = limit;
        let runtime = Supervisor::new(config, executor.clone()).unwrap();
        let epoch = runtime.connection_info().runtime_epoch;
        let root = runtime.connection_info().root_scope_id;
        assert_eq!(runtime.status()["rotationRecommended"], false);
        let started = runtime.start(process(&runtime, &root)).await.unwrap();
        bounded(executor.entered()).await;
        executor.finish(&started.process_id, bytes).await;
        bounded(runtime.wait_process(&started.process_id))
            .await
            .unwrap();
        let status = runtime.status();
        assert_eq!(status["outputBytes"]["used"], bytes.len());
        assert_eq!(status["rotationRecommended"], expected);
        assert_eq!(status["runtimeEpoch"], epoch);
        assert_eq!(status["activeProcesses"], 0);
        assert_eq!(status["scopes"]["used"], 1);
        bounded(runtime.shutdown()).await.unwrap();
    }
}

#[tokio::test]
async fn lost_caller_and_concurrent_retry_share_one_pending_start() {
    let dir = tempfile::tempdir().unwrap();
    let executor = Executor::new(true);
    let runtime = Supervisor::new(Config::read_only(dir.path().into()), executor.clone()).unwrap();
    let scope = runtime.connection_info().root_scope_id;
    let request = process(&runtime, &scope);
    let first = {
        let r = runtime.clone();
        let input = request.clone();
        tokio::spawn(async move { r.start(input).await })
    };
    bounded(executor.entered()).await;
    first.abort();
    let _ = first.await;
    let second = {
        let r = runtime.clone();
        let input = request.clone();
        tokio::spawn(async move { r.start(input).await })
    };
    assert_eq!(
        runtime.operation(&request.operation_id).unwrap().state,
        OperationState::Running
    );
    let mut changed = request.clone();
    changed.argv.push("different".into());
    assert_eq!(
        runtime.start(changed).await.unwrap_err().code,
        ErrorCode::Conflict
    );
    executor.gate.add_permits(1);
    let accepted = bounded(second).await.unwrap().unwrap();
    assert_eq!(executor.starts.load(Ordering::SeqCst), 1);
    executor.finish(&accepted.process_id, b"once").await;
    bounded(runtime.wait_process(&accepted.process_id))
        .await
        .unwrap();
    assert_eq!(
        runtime.start(request.clone()).await.unwrap().process_id,
        accepted.process_id
    );
    assert_eq!(
        runtime.operation(&request.operation_id).unwrap().state,
        OperationState::Succeeded
    );
    bounded(runtime.shutdown()).await.unwrap();
}

#[tokio::test]
async fn revoke_during_start_waits_for_registration_and_real_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let executor = Executor::new(true);
    let runtime = Supervisor::new(Config::read_only(dir.path().into()), executor.clone()).unwrap();
    let scope = runtime
        .create_scope(child(&runtime, &runtime.connection_info().root_scope_id))
        .unwrap();
    let r = runtime.clone();
    let request = process(&runtime, &scope.scope_id);
    let starting = tokio::spawn(async move { r.start(request).await });
    bounded(executor.entered()).await;
    assert_eq!(
        runtime.revoke(&scope.scope_id).unwrap().state,
        ScopeState::Revoking
    );
    assert_eq!(
        runtime
            .start(process(&runtime, &scope.scope_id))
            .await
            .unwrap_err()
            .code,
        ErrorCode::ScopeClosed
    );
    assert!(
        tokio::time::timeout(
            Duration::from_millis(20),
            runtime.wait_closed(&scope.scope_id)
        )
        .await
        .is_err()
    );
    executor.gate.add_permits(1);
    let started = bounded(starting).await.unwrap().unwrap();
    assert_eq!(
        bounded(runtime.wait_closed(&scope.scope_id))
            .await
            .unwrap()
            .active_processes,
        0
    );
    assert_eq!(
        runtime.process(&started.process_id).unwrap().state,
        ProcessState::Exited
    );
    assert_eq!(executor.terminations.load(Ordering::SeqCst), 1);
    bounded(runtime.shutdown()).await.unwrap();
}

#[tokio::test]
async fn nested_scopes_share_parent_capacity_and_revoke_only_owned_resources() {
    let dir = tempfile::tempdir().unwrap();
    let executor = Executor::new(false);
    let mut config = Config::read_only(dir.path().into());
    config.limits.max_processes = 2;
    let runtime = Supervisor::new(config, executor.clone()).unwrap();
    let root = runtime.connection_info().root_scope_id;
    let a = runtime.create_scope(child(&runtime, &root)).unwrap();
    let b = runtime.create_scope(child(&runtime, &root)).unwrap();
    let nested = runtime.create_scope(child(&runtime, &a.scope_id)).unwrap();
    let p = runtime
        .start(process(&runtime, &nested.scope_id))
        .await
        .unwrap();
    let q = runtime.start(process(&runtime, &b.scope_id)).await.unwrap();
    assert_eq!(
        runtime
            .start(process(&runtime, &b.scope_id))
            .await
            .unwrap_err()
            .code,
        ErrorCode::ResourceExhausted
    );
    runtime.revoke(&a.scope_id).unwrap();
    bounded(runtime.wait_closed(&a.scope_id)).await.unwrap();
    assert_eq!(
        runtime.scope(&nested.scope_id).unwrap().state,
        ScopeState::Closed
    );
    assert_eq!(
        runtime.process(&p.process_id).unwrap().state,
        ProcessState::Exited
    );
    assert_eq!(
        runtime.process(&q.process_id).unwrap().state,
        ProcessState::Running
    );
    let next = runtime.start(process(&runtime, &b.scope_id)).await.unwrap();
    assert_ne!(next.process_id, q.process_id);
    bounded(runtime.shutdown()).await.unwrap();
    assert_eq!(runtime.scope(&root).unwrap().active_processes, 0);
}

#[tokio::test]
async fn cumulative_output_does_not_reset_when_children_exit() {
    let dir = tempfile::tempdir().unwrap();
    let executor = Executor::new(false);
    let mut config = Config::read_only(dir.path().into());
    config.limits.output_bytes = 10;
    let runtime = Supervisor::new(config, executor.clone()).unwrap();
    let root = runtime.connection_info().root_scope_id;
    let a = runtime.create_scope(child(&runtime, &root)).unwrap();
    let b = runtime.create_scope(child(&runtime, &root)).unwrap();
    let first = runtime.start(process(&runtime, &a.scope_id)).await.unwrap();
    executor.finish(&first.process_id, b"123456").await;
    bounded(runtime.wait_process(&first.process_id))
        .await
        .unwrap();
    let second = runtime.start(process(&runtime, &b.scope_id)).await.unwrap();
    executor.finish(&second.process_id, b"abcdef").await;
    let done = bounded(runtime.wait_process(&second.process_id))
        .await
        .unwrap();
    assert_eq!(done.stop_reason.as_deref(), Some("outputBytes exceeded"));
    assert_eq!(runtime.scope(&root).unwrap().output_bytes, 10);
    let output = runtime
        .output(ReadOutput {
            process_id: second.process_id,
            after: None,
            max_bytes: 100,
            wait_ms: 0,
        })
        .await
        .unwrap();
    assert!(output.truncated);
    assert!(output.closed);
    assert_eq!(
        STANDARD.decode(&output.chunks[0].data_base64).unwrap(),
        b"abcd"
    );
    assert_eq!(
        runtime
            .start(process(&runtime, &a.scope_id))
            .await
            .unwrap_err()
            .code,
        ErrorCode::ResourceExhausted
    );
    bounded(runtime.shutdown()).await.unwrap();
}

#[tokio::test]
async fn byte_cursor_reads_retained_output_beyond_memory_window() {
    let dir = tempfile::tempdir().unwrap();
    let executor = Executor::new(false);
    let mut config = Config::read_only(dir.path().into());
    config.output_window_bytes = 4;
    let runtime = Supervisor::new(config, executor.clone()).unwrap();
    let p = runtime
        .start(process(&runtime, &runtime.connection_info().root_scope_id))
        .await
        .unwrap();
    executor.finish(&p.process_id, b"01234567").await;
    bounded(runtime.wait_process(&p.process_id)).await.unwrap();
    let first = runtime
        .output(ReadOutput {
            process_id: p.process_id.clone(),
            after: None,
            max_bytes: 2,
            wait_ms: 0,
        })
        .await
        .unwrap();
    assert!(!first.gap);
    assert!(!first.closed);
    assert_eq!(
        STANDARD.decode(&first.chunks[0].data_base64).unwrap(),
        b"01"
    );
    let second = runtime
        .output(ReadOutput {
            process_id: p.process_id.clone(),
            after: Some(first.next_cursor),
            max_bytes: 2,
            wait_ms: 0,
        })
        .await
        .unwrap();
    assert!(!second.gap);
    assert!(!second.closed);
    assert_eq!(
        STANDARD.decode(&second.chunks[0].data_base64).unwrap(),
        b"23"
    );
    let error = runtime
        .output(ReadOutput {
            process_id: p.process_id,
            after: Some("other/8".into()),
            max_bytes: 2,
            wait_ms: 0,
        })
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::StaleHandle);
    bounded(runtime.shutdown()).await.unwrap();
}

#[tokio::test]
async fn permissions_environment_and_epoch_are_checked_before_backend_admission() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("sub")).unwrap();
    let executor = Executor::new(false);
    let runtime = Supervisor::new(Config::read_only(dir.path().into()), executor.clone()).unwrap();
    let root = runtime.connection_info().root_scope_id;
    let mut wider = child(&runtime, &root);
    wider.permissions.write_roots = Some(vec!["workspace://repo".into()]);
    assert_eq!(
        runtime.create_scope(wider).unwrap_err().code,
        ErrorCode::PermissionDenied
    );
    let mut narrower = child(&runtime, &root);
    narrower.permissions.read_roots = Some(vec!["workspace://repo/sub".into()]);
    let request = narrower.clone();
    let scope = runtime.create_scope(narrower).unwrap();
    assert_eq!(
        runtime.create_scope(request).unwrap().scope_id,
        scope.scope_id
    );
    assert_eq!(
        runtime
            .start(process(&runtime, &scope.scope_id))
            .await
            .unwrap_err()
            .code,
        ErrorCode::PermissionDenied
    );
    let mut bad = process(&runtime, &root);
    bad.cwd = "workspace://repo/../escape".into();
    assert_eq!(
        runtime.start(bad).await.unwrap_err().code,
        ErrorCode::InvalidArgument
    );
    let mut bad = process(&runtime, &root);
    bad.env.insert("DYLD_INSERT_LIBRARIES".into(), "bad".into());
    assert_eq!(
        runtime.start(bad).await.unwrap_err().code,
        ErrorCode::PermissionDenied
    );
    let mut bad = process(&runtime, &root);
    bad.operation_id = format!("old:op:{}", uuid::Uuid::new_v4());
    assert_eq!(
        runtime.start(bad).await.unwrap_err().code,
        ErrorCode::StaleHandle
    );
    let mut too_large = child(&runtime, &root);
    too_large.limits.max_processes = Some(100);
    assert_eq!(
        runtime.create_scope(too_large).unwrap_err().code,
        ErrorCode::PermissionDenied
    );
    assert_eq!(executor.starts.load(Ordering::SeqCst), 0);
    #[cfg(unix)]
    {
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escape")).unwrap();
        let mut bad = process(&runtime, &root);
        bad.cwd = "workspace://repo/escape".into();
        assert_eq!(
            runtime.start(bad).await.unwrap_err().code,
            ErrorCode::PermissionDenied
        );
    }
    bounded(runtime.shutdown()).await.unwrap();
}

#[tokio::test]
async fn explicit_rejection_releases_reservation_but_lost_cleanup_remains_unknown() {
    let dir = tempfile::tempdir().unwrap();
    let executor = Executor::new(false);
    let runtime = Supervisor::new(Config::read_only(dir.path().into()), executor.clone()).unwrap();
    let root = runtime.connection_info().root_scope_id;
    executor.reject.store(true, Ordering::SeqCst);
    let rejected = process(&runtime, &root);
    assert_eq!(
        runtime.start(rejected.clone()).await.unwrap_err().code,
        ErrorCode::PermissionDenied
    );
    assert_eq!(runtime.scope(&root).unwrap().active_processes, 0);
    assert_eq!(
        runtime.operation(&rejected.operation_id).unwrap().state,
        OperationState::Failed
    );
    executor.reject.store(false, Ordering::SeqCst);
    executor.fail_cleanup.store(true, Ordering::SeqCst);
    let p = runtime.start(process(&runtime, &root)).await.unwrap();
    runtime.revoke(&root).unwrap();
    assert_eq!(
        bounded(runtime.wait_closed(&root)).await.unwrap_err().code,
        ErrorCode::CleanupFailed
    );
    assert_eq!(runtime.scope(&root).unwrap().state, ScopeState::Revoking);
    assert_eq!(runtime.scope(&root).unwrap().active_processes, 1);
    assert_eq!(
        runtime.process(&p.process_id).unwrap().state,
        ProcessState::Unknown
    );
    assert!(bounded(runtime.shutdown()).await.is_err());
}

#[tokio::test]
async fn confirmed_execution_cleanup_isolates_only_its_scope_and_never_replays() {
    let dir = tempfile::tempdir().unwrap();
    let executor = Executor::new(false);
    let runtime = Supervisor::new(Config::read_only(dir.path().into()), executor.clone()).unwrap();
    let root = runtime.connection_info().root_scope_id;
    let first = runtime
        .create_scope(child(&runtime, &root))
        .unwrap()
        .scope_id;
    let sibling = runtime
        .create_scope(child(&runtime, &root))
        .unwrap()
        .scope_id;
    let request = process(&runtime, &first);
    let broken = runtime.start(request.clone()).await.unwrap();
    let running = runtime.start(process(&runtime, &sibling)).await.unwrap();
    let sender = executor
        .routes
        .lock()
        .unwrap()
        .remove(&broken.process_id)
        .unwrap();
    sender
        .send(Event::Failed {
            error: Error::new(ErrorCode::Unavailable, "fixture output receipt lost"),
            cleanup_confirmed: true,
        })
        .await
        .unwrap();
    drop(sender);
    assert!(
        bounded(runtime.wait_process(&broken.process_id))
            .await
            .is_err()
    );
    let info = runtime.process(&broken.process_id).unwrap();
    assert_eq!(info.state, ProcessState::Unknown);
    assert!(info.cleanup_confirmed);
    assert!(info.cleanup_error.is_none());
    bounded(runtime.wait_closed(&first)).await.unwrap();
    assert_eq!(runtime.scope(&sibling).unwrap().state, ScopeState::Active);
    assert_eq!(
        runtime.process(&running.process_id).unwrap().state,
        ProcessState::Running
    );
    assert_eq!(
        runtime.start(request).await.unwrap().process_id,
        broken.process_id
    );
    assert_eq!(executor.starts.load(Ordering::SeqCst), 2);
    assert_eq!(runtime.status()["admissionOpen"], true);
    assert!(runtime.status()["recovery"].is_null());
    executor
        .finish(&running.process_id, b"sibling complete")
        .await;
    bounded(runtime.wait_process(&running.process_id))
        .await
        .unwrap();
    let next = runtime
        .create_scope(child(&runtime, &root))
        .unwrap()
        .scope_id;
    let next = runtime.start(process(&runtime, &next)).await.unwrap();
    executor.finish(&next.process_id, b"fresh work").await;
    bounded(runtime.wait_process(&next.process_id))
        .await
        .unwrap();
    bounded(runtime.shutdown()).await.unwrap();
}

#[tokio::test]
async fn backend_failure_preserves_the_cause_and_fences_new_work_without_replay() {
    let dir = tempfile::tempdir().unwrap();
    let executor = Executor::new(false);
    executor.fail_cleanup.store(true, Ordering::SeqCst);
    let runtime = Supervisor::new(Config::read_only(dir.path().into()), executor.clone()).unwrap();
    let root = runtime.connection_info().root_scope_id;
    let started = runtime.start(process(&runtime, &root)).await.unwrap();
    let sender = executor
        .routes
        .lock()
        .unwrap()
        .remove(&started.process_id)
        .unwrap();
    sender
        .send(Event::Failed {
            error: Error::new(
                ErrorCode::CleanupFailed,
                "fixture cannot inspect owned descendant",
            ),
            cleanup_confirmed: false,
        })
        .await
        .unwrap();
    drop(sender);
    let failure = bounded(runtime.wait_process(&started.process_id))
        .await
        .unwrap_err();
    assert_eq!(failure.code, ErrorCode::CleanupFailed);
    assert!(
        failure
            .message
            .contains("fixture cannot inspect owned descendant"),
        "{failure}"
    );
    let scope = runtime.scope(&root).unwrap();
    assert_eq!(scope.state, ScopeState::Revoking);
    assert_eq!(scope.active_processes, 1);
    let error = bounded(runtime.wait_closed(&root)).await.unwrap_err();
    assert!(
        error
            .message
            .contains("fixture cannot inspect owned descendant"),
        "{error}"
    );
    assert_eq!(
        runtime.process(&started.process_id).unwrap().state,
        ProcessState::Unknown
    );
    assert_eq!(
        runtime
            .start(process(&runtime, &root))
            .await
            .unwrap_err()
            .code,
        ErrorCode::ScopeClosed
    );
    assert_eq!(executor.starts.load(Ordering::SeqCst), 1);
    assert!(bounded(runtime.shutdown()).await.is_err());
}

#[tokio::test]
async fn lost_start_reply_is_not_replayed_and_fences_the_connection() {
    assert_unknown_start(false).await;
}

#[tokio::test]
async fn startup_cleanup_failure_preserves_unknown_and_reservation() {
    assert_unknown_start(true).await;
}

async fn assert_unknown_start(cleanup_failed: bool) {
    let dir = tempfile::tempdir().unwrap();
    let executor = Executor::new(false);
    executor.fail_cleanup.store(true, Ordering::SeqCst);
    executor.lose_start_reply.store(true, Ordering::SeqCst);
    executor
        .cleanup_start_failure
        .store(cleanup_failed, Ordering::SeqCst);
    let runtime = Supervisor::new(Config::read_only(dir.path().into()), executor.clone()).unwrap();
    let root = runtime.connection_info().root_scope_id;
    let request = process(&runtime, &root);
    assert_eq!(
        bounded(runtime.start(request.clone()))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Unavailable
    );
    assert_eq!(
        runtime.operation(&request.operation_id).unwrap().state,
        OperationState::Unknown
    );
    assert_eq!(runtime.scope(&root).unwrap().state, ScopeState::Revoking);
    assert_eq!(runtime.scope(&root).unwrap().active_processes, 1);
    assert_eq!(
        runtime.start(request).await.unwrap_err().code,
        ErrorCode::Unavailable
    );
    assert_eq!(executor.starts.load(Ordering::SeqCst), 1);
    assert_eq!(
        runtime
            .start(process(&runtime, &root))
            .await
            .unwrap_err()
            .code,
        ErrorCode::ScopeClosed
    );
    assert_eq!(
        bounded(runtime.shutdown()).await.unwrap_err().code,
        ErrorCode::CleanupFailed
    );
}

#[tokio::test]
async fn operation_capacity_preserves_old_results_and_shutdown_seals_admission() {
    let dir = tempfile::tempdir().unwrap();
    let executor = Executor::new(false);
    let mut config = Config::read_only(dir.path().into());
    config.max_operations = 1;
    let runtime = Supervisor::new(config, executor).unwrap();
    let root = runtime.connection_info().root_scope_id;
    let request = child(&runtime, &root);
    let scope = runtime.create_scope(request.clone()).unwrap();
    assert_eq!(
        runtime
            .create_scope(child(&runtime, &root))
            .unwrap_err()
            .code,
        ErrorCode::ResourceExhausted
    );
    assert_eq!(
        runtime.create_scope(request.clone()).unwrap().scope_id,
        scope.scope_id
    );
    bounded(runtime.shutdown()).await.unwrap();
    assert_eq!(
        runtime
            .start(process(&runtime, &root))
            .await
            .unwrap_err()
            .code,
        ErrorCode::ScopeClosed
    );
    assert_eq!(
        runtime.create_scope(request).unwrap().scope_id,
        scope.scope_id
    );
}

#[cfg(unix)]
#[tokio::test]
async fn replaced_authorization_roots_are_rejected_before_executor_admission() {
    for symlink in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        for name in ["allowed", "cwd"] {
            std::fs::create_dir(dir.path().join(name)).unwrap();
        }
        let executor = Executor::new(false);
        let runtime =
            Supervisor::new(Config::read_only(dir.path().into()), executor.clone()).unwrap();
        let mut request = child(&runtime, &runtime.connection_info().root_scope_id);
        request.permissions.read_roots = Some(vec![
            "workspace://repo/allowed".into(),
            "workspace://repo/cwd".into(),
        ]);
        let scope = runtime.create_scope(request).unwrap();
        std::fs::rename(dir.path().join("allowed"), dir.path().join("original")).unwrap();
        if symlink {
            std::os::unix::fs::symlink(outside.path(), dir.path().join("allowed")).unwrap();
        } else {
            std::fs::create_dir(dir.path().join("allowed")).unwrap();
        }
        let mut request = process(&runtime, &scope.scope_id);
        request.cwd = "workspace://repo/cwd".into();
        let result = runtime.start(request).await;
        let inherited = runtime.create_scope(child(&runtime, &scope.scope_id));
        bounded(runtime.shutdown()).await.unwrap();
        assert_eq!(result.unwrap_err().code, ErrorCode::PermissionDenied);
        assert_eq!(inherited.unwrap_err().code, ErrorCode::PermissionDenied);
        assert_eq!(executor.starts.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn exit_allows_output_drain_but_duplicate_exit_facts_fence_the_runtime() {
    for duplicate in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let executor = Executor::new(false);
        let runtime =
            Supervisor::new(Config::read_only(dir.path().into()), executor.clone()).unwrap();
        let root = runtime.connection_info().root_scope_id;
        let process = runtime.start(process(&runtime, &root)).await.unwrap();
        let sender = executor
            .routes
            .lock()
            .unwrap()
            .remove(&process.process_id)
            .unwrap();
        sender
            .send(Event::Exited {
                exit_code: Some(0),
                signal: None,
                sandbox_denied: false,
            })
            .await
            .unwrap();
        sender
            .send(if duplicate {
                Event::Exited {
                    exit_code: Some(1),
                    signal: None,
                    sandbox_denied: false,
                }
            } else {
                Event::Output(OutputStream::Stdout, b"drained".to_vec())
            })
            .await
            .unwrap();
        let _ = sender.send(Event::Closed).await;
        let done = bounded(runtime.wait_process(&process.process_id)).await;
        if duplicate {
            assert_eq!(done.unwrap_err().code, ErrorCode::CleanupFailed);
            bounded(async {
                while runtime.status()["recovery"]["cleanupConfirmed"] != true {
                    tokio::task::yield_now().await;
                }
            })
            .await;
            assert_eq!(runtime.scope(&root).unwrap().active_processes, 0);
            assert!(!runtime.status()["admissionOpen"].as_bool().unwrap());
            assert_eq!(
                runtime.process(&process.process_id).unwrap().state,
                ProcessState::Unknown
            );
            bounded(runtime.shutdown()).await.unwrap();
        } else {
            assert_eq!(done.unwrap().exit_code, Some(0));
            let page = runtime
                .output(ReadOutput {
                    process_id: process.process_id,
                    after: None,
                    max_bytes: 100,
                    wait_ms: 0,
                })
                .await
                .unwrap();
            assert!(page.closed);
            assert_eq!(
                STANDARD.decode(&page.chunks[0].data_base64).unwrap(),
                b"drained"
            );
            bounded(runtime.shutdown()).await.unwrap();
        }
    }
}

#[tokio::test]
async fn file_helper_accepts_full_binary_chunk_inside_larger_base64_envelope() {
    let directory = tempfile::tempdir().unwrap();
    let executor = Executor::new(false);
    let mut config = Config::read_only(directory.path().into());
    config.file_helper = Some(std::env::current_exe().unwrap());
    let runtime = Supervisor::new(config, executor.clone()).unwrap();
    let operation_id = op(&runtime);
    let request = FileRequest {
        operation_id: operation_id.clone(),
        scope_id: runtime.connection_info().root_scope_id,
        command: FileCommand::Read {
            path: "workspace://repo/image.png".into(),
            offset: 0,
            max_bytes: MAX_FILE_CHUNK,
        },
    };
    let call = {
        let runtime = runtime.clone();
        tokio::spawn(async move { runtime.filesystem(request).await })
    };
    bounded(executor.entered()).await;
    let process_id = executor.executions.lock().unwrap()[0].process_id.clone();
    let raw = vec![127u8; MAX_FILE_CHUNK];
    let response = serde_json::json!({"result":{"dataBase64":STANDARD.encode(&raw),"eof":false,"nextOffset":MAX_FILE_CHUNK,"sha256":"a".repeat(64)}});
    let bytes = serde_json::to_vec(&response).unwrap();
    assert!(bytes.len() > MAX_READ_BYTES);
    executor.finish(&process_id, &bytes).await;
    let result = bounded(call).await.unwrap().unwrap();
    assert_eq!(
        STANDARD
            .decode(result["dataBase64"].as_str().unwrap())
            .unwrap(),
        raw
    );
    assert_eq!(
        runtime.operation(&operation_id).unwrap().state,
        OperationState::Succeeded
    );
    bounded(runtime.shutdown()).await.unwrap();
}

#[tokio::test]
async fn task_credentials_are_scoped_to_canonical_deployment_executable() {
    let workspace = tempfile::tempdir().unwrap();
    let deployment = tempfile::tempdir().unwrap();
    let program = deployment.path().join("task-tool");
    std::fs::write(&program, b"fixture").unwrap();
    let program = program.canonicalize().unwrap();
    let executor = Executor::new(false);
    let mut config = Config::read_only(workspace.path().into());
    config.task_credential_commands.push(program.clone());
    config
        .task_environment
        .insert("MULTICA_TOKEN".into(), "test-task-secret".into());
    let runtime = Supervisor::new(config, executor.clone()).unwrap();
    let root = runtime.connection_info().root_scope_id;
    let mut ordinary = process(&runtime, &root);
    ordinary.argv = vec!["/bin/sh".into()];
    runtime.start(ordinary).await.unwrap();
    let mut allowed = process(&runtime, &root);
    #[cfg(unix)]
    {
        let alias = deployment.path().join("alias");
        std::os::unix::fs::symlink(&program, &alias).unwrap();
        allowed.argv = vec![alias.to_string_lossy().into_owned()];
    }
    #[cfg(not(unix))]
    {
        allowed.argv = vec![program.to_string_lossy().into_owned()];
    }
    let accepted = runtime.start(allowed.clone()).await.unwrap();
    assert_eq!(
        runtime.start(allowed).await.unwrap().process_id,
        accepted.process_id
    );
    let executions = executor.executions.lock().unwrap().clone();
    assert_eq!(executions.len(), 2);
    assert!(!executions[0].env.contains_key("MULTICA_TOKEN"));
    assert_eq!(executions[1].env["MULTICA_TOKEN"], "test-task-secret");
    assert_eq!(executions[1].trusted_executable.as_ref(), Some(&program));
    assert_eq!(executions[1].argv[0], program.to_string_lossy());
    // Planned boundary: package-owned hooks cannot inherit task-provider credentials
    // even when their executable is otherwise an allowed credential recipient.
    let mut hook_scope = child(&runtime, &root);
    hook_scope.owner.plugin_instance_id = Some("hook:fixture:package-digest".into());
    let hook_scope = runtime.create_scope(hook_scope).unwrap();
    let mut hook_command = process(&runtime, &hook_scope.scope_id);
    hook_command.argv = vec![program.to_string_lossy().into_owned()];
    runtime.start(hook_command).await.unwrap();
    assert!(
        !executor.executions.lock().unwrap()[2]
            .env
            .contains_key("MULTICA_TOKEN")
    );
    let mut forged = process(&runtime, &root);
    forged.env.insert("MULTICA_TOKEN".into(), "forged".into());
    assert_eq!(
        runtime.start(forged).await.unwrap_err().code,
        ErrorCode::PermissionDenied
    );
    assert!(
        !serde_json::to_string(&runtime.process(&accepted.process_id).unwrap())
            .unwrap()
            .contains("test-task-secret")
    );
    bounded(runtime.shutdown()).await.unwrap();
}

#[tokio::test]
async fn deployment_output_budget_preserves_single_process_cap_and_counts_reads_once() {
    let dir = tempfile::tempdir().unwrap();
    let executor = Executor::new(false);
    let mut config = Config::read_only(dir.path().into());
    config.limits.output_bytes = 10;
    config.cumulative_output_bytes = Some(32);
    let runtime = Supervisor::new(config, executor.clone()).unwrap();
    let root = runtime.connection_info().root_scope_id;
    let scope = runtime.create_scope(child(&runtime, &root)).unwrap();
    assert_eq!(runtime.scope(&root).unwrap().limits.output_bytes, 32);
    for bytes in [b"12345678".as_slice(), b"abcdefgh"] {
        let started = runtime
            .start(process(&runtime, &scope.scope_id))
            .await
            .unwrap();
        executor.finish(&started.process_id, bytes).await;
        let done = bounded(runtime.wait_process(&started.process_id))
            .await
            .unwrap();
        assert!(done.stop_reason.is_none());
        for _ in 0..2 {
            let page = runtime
                .output(ReadOutput {
                    process_id: started.process_id.clone(),
                    after: None,
                    max_bytes: 100,
                    wait_ms: 0,
                })
                .await
                .unwrap();
            assert!(!page.truncated);
        }
    }
    assert_eq!(runtime.scope(&root).unwrap().output_bytes, 16);
    assert_eq!(runtime.status()["outputBytes"]["limit"], 32);
    // 单命令仍只能输出10字节，不能因部署额度增加到32而扩大。
    let large = runtime
        .start(process(&runtime, &scope.scope_id))
        .await
        .unwrap();
    executor
        .finish(&large.process_id, b"0123456789EXCESS")
        .await;
    let done = bounded(runtime.wait_process(&large.process_id))
        .await
        .unwrap();
    assert_eq!(done.stop_reason.as_deref(), Some("outputBytes exceeded"));
    assert_eq!(runtime.scope(&root).unwrap().output_bytes, 26);
    let last = runtime
        .start(process(&runtime, &scope.scope_id))
        .await
        .unwrap();
    executor.finish(&last.process_id, b"0123456789").await;
    bounded(runtime.wait_process(&last.process_id))
        .await
        .unwrap();
    assert_eq!(runtime.scope(&root).unwrap().output_bytes, 32);
    assert_eq!(
        runtime
            .start(process(&runtime, &scope.scope_id))
            .await
            .unwrap_err()
            .code,
        ErrorCode::ResourceExhausted
    );
    bounded(runtime.shutdown()).await.unwrap();
}

#[test]
fn cumulative_output_cannot_be_less_than_a_single_process() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::read_only(dir.path().into());
    config.cumulative_output_bytes = Some(config.limits.output_bytes - 1);
    assert!(Supervisor::new(config, Executor::new(false)).is_err());
}

#[tokio::test]
async fn artifact_commands_require_write_authority_and_keep_operation_receipts() {
    let directory = tempfile::tempdir().unwrap();
    let executor = Executor::new(false);
    let mut config = Config::read_only(directory.path().into());
    config.writable = true;
    config.file_helper = Some(std::env::current_exe().unwrap());
    let runtime = Supervisor::new(config, executor.clone()).unwrap();
    let root = runtime.connection_info().root_scope_id;
    assert_eq!(
        runtime.connection_info().capabilities["filesystem"]["artifactDelivery"],
        true
    );
    let mut child = child(&runtime, &root);
    child.permissions.write_roots = Some(vec![]);
    let readonly = runtime.create_scope(child).unwrap();
    let commands = [
        FileCommand::StageFileChunk {
            path: "workspace://repo/code".into(),
            upload_id: uuid::Uuid::new_v4().to_string(),
            offset: 0,
            data_base64: STANDARD.encode(b"source"),
        },
        FileCommand::CommitFile {
            path: "workspace://repo/code".into(),
            upload_id: uuid::Uuid::new_v4().to_string(),
            expected: ExpectedFile::Absent,
            expected_executable: None,
            sha256: "a".repeat(64),
            executable: true,
        },
        FileCommand::RemoveFile {
            path: "workspace://repo/code".into(),
            expected_sha256: "a".repeat(64),
            expected_executable: true,
        },
    ];
    for command in commands {
        let denied = FileRequest {
            operation_id: op(&runtime),
            scope_id: readonly.scope_id.clone(),
            command: command.clone(),
        };
        assert_eq!(
            runtime.filesystem(denied).await.unwrap_err().code,
            ErrorCode::PermissionDenied
        );
        let request = FileRequest {
            operation_id: op(&runtime),
            scope_id: root.clone(),
            command,
        };
        let call = {
            let runtime = runtime.clone();
            let request = request.clone();
            tokio::spawn(async move { runtime.filesystem(request).await })
        };
        bounded(executor.entered()).await;
        let id = executor
            .executions
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .process_id
            .clone();
        executor
            .finish(&id, br#"{"result":{"confirmed":true}}"#)
            .await;
        assert_eq!(bounded(call).await.unwrap().unwrap()["confirmed"], true);
        let starts = executor.starts.load(Ordering::SeqCst);
        assert_eq!(
            runtime.filesystem(request).await.unwrap()["confirmed"],
            true
        );
        assert_eq!(executor.starts.load(Ordering::SeqCst), starts);
    }
}

#[tokio::test]
async fn deployment_public_inputs_reject_writes_replacement_and_permission_expansion() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let public = root.join("public");
    std::fs::create_dir(&public).unwrap();
    let executor = Executor::new(false);
    let mut config = Config::read_only(root.clone());
    config.writable = true;
    config.file_helper = Some("/bin/true".into());
    config.read_only_paths = vec![public.clone()];
    let runtime = Supervisor::new(config.clone(), executor.clone()).unwrap();
    let scope = runtime.connection_info().root_scope_id;
    for path in ["workspace://repo/public/new", "workspace://repo"] {
        let error = runtime
            .filesystem(FileRequest {
                operation_id: op(&runtime),
                scope_id: scope.clone(),
                command: FileCommand::Write {
                    path: path.into(),
                    data_base64: STANDARD.encode("changed"),
                    expected: ExpectedFile::Absent,
                },
            })
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::PermissionDenied);
    }
    assert_eq!(executor.starts.load(Ordering::SeqCst), 0);
    let child = runtime.create_scope(child(&runtime, &scope)).unwrap();
    let started = runtime
        .start(process(&runtime, &child.scope_id))
        .await
        .unwrap();
    assert_eq!(
        executor.executions.lock().unwrap()[0].read_only_paths,
        vec![public.clone()]
    );
    executor.finish(&started.process_id, &[]).await;
    std::fs::rename(&public, root.join("original")).unwrap();
    std::fs::create_dir(&public).unwrap();
    let error = runtime
        .filesystem(FileRequest {
            operation_id: op(&runtime),
            scope_id: scope,
            command: FileCommand::Stat {
                path: "workspace://repo/public".into(),
            },
        })
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::PermissionDenied);
    runtime.shutdown().await.unwrap();
    config.read_only_paths = vec![root.parent().unwrap().into()];
    assert!(Supervisor::new(config, Executor::new(false)).is_err());
}

// Contract: task metadata is not authority; hook participation is explicitly minted
// by the connection owner. These exercise the real supervisor admission/cleanup
// boundary; Executor models only OS process lifetime and exposes actual starts.
fn participant(
    runtime: &Supervisor,
    parent: &str,
    role: ScopeParticipation,
) -> CreateParticipantScope {
    CreateParticipantScope {
        authority_scope_id: runtime.connection_info().root_scope_id,
        scope: child(runtime, parent),
        participation: role,
    }
}
fn grouped_runtime(path: &std::path::Path, executor: Arc<Executor>) -> Arc<Supervisor> {
    let mut config = Config::read_only(path.into());
    config.writable = true;
    config.limits.max_processes = 16;
    Supervisor::new(config, executor).unwrap()
}
#[tokio::test]
async fn hook_group_reentry_preserves_foreign_fifo_and_ordinary_exclusion() {
    let dir = tempfile::tempdir().unwrap();
    let executor = Executor::new(false);
    let runtime = grouped_runtime(dir.path(), executor.clone());
    let root = runtime.connection_info().root_scope_id;
    let task = runtime
        .create_participant_scope(participant(
            &runtime,
            &root,
            ScopeParticipation::Task {
                admission_window_ms: 2000,
            },
        ))
        .unwrap();
    let hook = runtime
        .create_participant_scope(participant(
            &runtime,
            &task.scope_id,
            ScopeParticipation::Hook {
                task_scope_id: task.scope_id.clone(),
            },
        ))
        .unwrap();
    let first = runtime
        .start(process(&runtime, &hook.scope_id))
        .await
        .unwrap();
    // Exact copied task/plugin metadata outside the admitted ancestry grants nothing.
    let copied_metadata = runtime.create_scope(child(&runtime, &root)).unwrap();
    let foreign = {
        let rt = runtime.clone();
        let req = process(&rt, &copied_metadata.scope_id);
        tokio::spawn(async move { rt.start(req).await })
    };
    bounded(async {
        while runtime.scope(&root).unwrap().active_processes < 2 {
            tokio::task::yield_now().await;
        }
    })
    .await;
    let own = bounded(runtime.start(process(&runtime, &task.scope_id)))
        .await
        .unwrap();
    let hook2 = bounded(runtime.start(process(&runtime, &hook.scope_id)))
        .await
        .unwrap();
    let ordinary = {
        let rt = runtime.clone();
        let req = process(&rt, &task.scope_id);
        tokio::spawn(async move { rt.start(req).await })
    };
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!ordinary.is_finished());
    assert!(!foreign.is_finished());
    executor.finish(&first.process_id, b"").await;
    executor.finish(&hook2.process_id, b"").await;
    assert!(!foreign.is_finished());
    executor.finish(&own.process_id, b"").await;
    let ordinary = bounded(ordinary).await.unwrap().unwrap();
    assert!(!foreign.is_finished());
    executor.finish(&ordinary.process_id, b"").await;
    let foreign = bounded(foreign).await.unwrap().unwrap();
    executor.finish(&foreign.process_id, b"").await;
    bounded(runtime.shutdown()).await.unwrap();
}
#[tokio::test]
async fn hook_group_seals_without_extension_and_next_generation_waits_behind_foreign() {
    let dir = tempfile::tempdir().unwrap();
    let executor = Executor::new(false);
    let runtime = grouped_runtime(dir.path(), executor.clone());
    let root = runtime.connection_info().root_scope_id;
    let task = runtime
        .create_participant_scope(participant(
            &runtime,
            &root,
            ScopeParticipation::Task {
                admission_window_ms: 80,
            },
        ))
        .unwrap();
    let hook = runtime
        .create_participant_scope(participant(
            &runtime,
            &task.scope_id,
            ScopeParticipation::Hook {
                task_scope_id: task.scope_id.clone(),
            },
        ))
        .unwrap();
    let first = runtime
        .start(process(&runtime, &hook.scope_id))
        .await
        .unwrap();
    let foreign = {
        let rt = runtime.clone();
        let req = process(&rt, &root);
        tokio::spawn(async move { rt.start(req).await })
    };
    tokio::time::sleep(Duration::from_millis(40)).await;
    let second = runtime
        .start(process(&runtime, &hook.scope_id))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(60)).await;
    let late = {
        let rt = runtime.clone();
        let req = process(&rt, &hook.scope_id);
        tokio::spawn(async move { rt.start(req).await })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!late.is_finished());
    executor.finish(&first.process_id, b"").await;
    executor.finish(&second.process_id, b"").await;
    let foreign = bounded(foreign).await.unwrap().unwrap();
    assert!(!late.is_finished());
    executor.finish(&foreign.process_id, b"").await;
    let late = bounded(late).await.unwrap().unwrap();
    executor.finish(&late.process_id, b"").await;
    bounded(runtime.shutdown()).await.unwrap();
}
#[tokio::test]
async fn hook_group_authority_cannot_be_forged_by_metadata_parent_or_epoch() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = grouped_runtime(dir.path(), Executor::new(false));
    let root = runtime.connection_info().root_scope_id;
    let task = runtime
        .create_participant_scope(participant(
            &runtime,
            &root,
            ScopeParticipation::Task {
                admission_window_ms: 100,
            },
        ))
        .unwrap();
    let mut forged = participant(
        &runtime,
        &task.scope_id,
        ScopeParticipation::Hook {
            task_scope_id: task.scope_id.clone(),
        },
    );
    forged.authority_scope_id = task.scope_id.clone();
    assert!(runtime.create_participant_scope(forged).is_err());
    assert!(
        runtime
            .create_participant_scope(participant(
                &runtime,
                &root,
                ScopeParticipation::Hook {
                    task_scope_id: task.scope_id.clone()
                }
            ))
            .is_err()
    );
    assert!(
        runtime
            .create_participant_scope(participant(
                &runtime,
                &task.scope_id,
                ScopeParticipation::Task {
                    admission_window_ms: 100
                }
            ))
            .is_err()
    );
    assert!(
        runtime
            .create_participant_scope(participant(
                &runtime,
                &root,
                ScopeParticipation::Task {
                    admission_window_ms: 60_001
                }
            ))
            .is_err()
    );
    let other = grouped_runtime(dir.path(), Executor::new(false));
    let mut stale = participant(
        &runtime,
        &task.scope_id,
        ScopeParticipation::Hook {
            task_scope_id: task.scope_id.clone(),
        },
    );
    stale.authority_scope_id = other.connection_info().root_scope_id;
    assert!(runtime.create_participant_scope(stale).is_err());
    runtime.revoke(&task.scope_id).unwrap();
    assert!(
        runtime
            .create_participant_scope(participant(
                &runtime,
                &task.scope_id,
                ScopeParticipation::Hook {
                    task_scope_id: task.scope_id.clone()
                }
            ))
            .is_err()
    );
    bounded(runtime.shutdown()).await.unwrap();
    bounded(other.shutdown()).await.unwrap();
}

#[tokio::test]
async fn hook_group_expansion_queues_atomically_but_covered_reentry_survives() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("a")).unwrap();
    std::fs::create_dir(dir.path().join("b")).unwrap();
    let executor = Executor::new(false);
    let runtime = grouped_runtime(dir.path(), executor.clone());
    let root = runtime.connection_info().root_scope_id;
    let task = runtime
        .create_participant_scope(participant(
            &runtime,
            &root,
            ScopeParticipation::Task {
                admission_window_ms: 2000,
            },
        ))
        .unwrap();
    let mut a = participant(
        &runtime,
        &task.scope_id,
        ScopeParticipation::Hook {
            task_scope_id: task.scope_id.clone(),
        },
    );
    a.scope.permissions.write_roots = Some(vec!["workspace://repo/a".into()]);
    let a = runtime.create_participant_scope(a).unwrap();
    let first = runtime.start(process(&runtime, &a.scope_id)).await.unwrap();
    let foreign = {
        let rt = runtime.clone();
        let req = process(&rt, &root);
        tokio::spawn(async move { rt.start(req).await })
    };
    bounded(async {
        while runtime.scope(&root).unwrap().active_processes < 2 {
            tokio::task::yield_now().await;
        }
    })
    .await;
    let expanded = runtime
        .create_participant_scope(participant(
            &runtime,
            &task.scope_id,
            ScopeParticipation::Hook {
                task_scope_id: task.scope_id.clone(),
            },
        ))
        .unwrap();
    let expand = {
        let rt = runtime.clone();
        let req = process(&rt, &expanded.scope_id);
        tokio::spawn(async move { rt.start(req).await })
    };
    bounded(async {
        while runtime.scope(&expanded.scope_id).unwrap().active_processes < 1 {
            tokio::task::yield_now().await;
        }
    })
    .await;
    let reentry = bounded(runtime.start(process(&runtime, &a.scope_id)))
        .await
        .unwrap();
    assert!(!foreign.is_finished());
    assert!(!expand.is_finished());
    runtime.revoke(&expanded.scope_id).unwrap();
    assert!(bounded(expand).await.unwrap().is_err());
    executor.finish(&first.process_id, b"").await;
    assert!(!foreign.is_finished());
    executor.finish(&reentry.process_id, b"").await;
    let foreign = bounded(foreign).await.unwrap().unwrap();
    executor.finish(&foreign.process_id, b"").await;
    bounded(runtime.shutdown()).await.unwrap();
}
#[tokio::test]
async fn hook_group_cancelled_member_and_cleanup_unknown_do_not_release_other_members() {
    let dir = tempfile::tempdir().unwrap();
    let executor = Executor::new(false);
    let runtime = grouped_runtime(dir.path(), executor.clone());
    let root = runtime.connection_info().root_scope_id;
    let task = runtime
        .create_participant_scope(participant(
            &runtime,
            &root,
            ScopeParticipation::Task {
                admission_window_ms: 2000,
            },
        ))
        .unwrap();
    let hook = runtime
        .create_participant_scope(participant(
            &runtime,
            &task.scope_id,
            ScopeParticipation::Hook {
                task_scope_id: task.scope_id.clone(),
            },
        ))
        .unwrap();
    let first = runtime
        .start(process(&runtime, &hook.scope_id))
        .await
        .unwrap();
    let own = runtime
        .start(process(&runtime, &task.scope_id))
        .await
        .unwrap();
    let foreign = {
        let rt = runtime.clone();
        let req = process(&rt, &root);
        tokio::spawn(async move { rt.start(req).await })
    };
    runtime.revoke(&hook.scope_id).unwrap();
    bounded(runtime.wait_closed(&hook.scope_id)).await.unwrap();
    assert_eq!(
        runtime.process(&first.process_id).unwrap().state,
        ProcessState::Exited
    );
    assert!(!foreign.is_finished());
    executor.fail_cleanup.store(true, Ordering::SeqCst);
    runtime.revoke(&task.scope_id).unwrap();
    assert!(bounded(runtime.wait_closed(&task.scope_id)).await.is_err());
    assert_eq!(
        runtime.process(&own.process_id).unwrap().state,
        ProcessState::Unknown
    );
    assert!(bounded(foreign).await.unwrap().is_err());
    assert_eq!(executor.starts.load(Ordering::SeqCst), 2);
    assert!(runtime.start(process(&runtime, &root)).await.is_err());
}

#[tokio::test]
async fn image_response_is_retained_and_paged_without_enlarging_rpc_frames() {
    let dir = tempfile::tempdir().unwrap();
    let executor = Executor::new(false);
    let mut config = Config::read_only(dir.path().into());
    config.file_helper = Some(std::env::current_exe().unwrap());
    config.output_window_bytes = 64;
    let runtime = Supervisor::new(config, executor.clone()).unwrap();
    let root = runtime.connection_info().root_scope_id;
    let request = FileRequest {
        operation_id: op(&runtime),
        scope_id: root.clone(),
        command: FileCommand::ReadImage {
            path: "workspace://repo/image.png".into(),
            options: Default::default(),
        },
    };
    let call = {
        let runtime = runtime.clone();
        let request = request.clone();
        tokio::spawn(async move { runtime.filesystem(request).await })
    };
    bounded(executor.entered()).await;
    let process = executor.executions.lock().unwrap()[0].process_id.clone();
    let raw = serde_json::to_vec(&serde_json::json!({"result":{"views":[{"dataBase64":STANDARD.encode(vec![42u8; 300_000])}]}})).unwrap();
    executor.finish(&process, &raw).await;
    let response = bounded(call).await.unwrap().unwrap();
    assert!(serde_json::to_vec(&response).unwrap().len() < MAX_FRAME_BYTES);
    assert_eq!(response["imageOutput"]["bytes"], raw.len());
    assert_eq!(runtime.scope(&root).unwrap().output_bytes, raw.len() as u64);
    let mut restored = Vec::new();
    let mut after = None;
    loop {
        let page = runtime
            .output(ReadOutput {
                process_id: process.clone(),
                after,
                max_bytes: MAX_READ_BYTES,
                wait_ms: 0,
            })
            .await
            .unwrap();
        assert!(!page.gap && !page.truncated);
        assert!(serde_json::to_vec(&page).unwrap().len() < MAX_FRAME_BYTES);
        for chunk in page.chunks {
            restored.extend(STANDARD.decode(chunk.data_base64).unwrap());
        }
        if page.closed {
            break;
        }
        after = Some(page.next_cursor);
    }
    assert_eq!(restored, raw);
    assert_eq!(runtime.filesystem(request).await.unwrap(), response);
    assert_eq!(runtime.scope(&root).unwrap().output_bytes, raw.len() as u64);
    bounded(runtime.shutdown()).await.unwrap();
}

#[tokio::test]
async fn image_preprocessing_cancellation_keeps_one_operation_and_no_success() {
    let dir = tempfile::tempdir().unwrap();
    let executor = Executor::new(false);
    let mut config = Config::read_only(dir.path().into());
    config.file_helper = Some(std::env::current_exe().unwrap());
    let runtime = Supervisor::new(config, executor.clone()).unwrap();
    let root = runtime.connection_info().root_scope_id;
    let scope = runtime.create_scope(child(&runtime, &root)).unwrap();
    let request = FileRequest {
        operation_id: op(&runtime),
        scope_id: scope.scope_id.clone(),
        command: FileCommand::ReadImage {
            path: "workspace://repo/a.png".into(),
            options: Default::default(),
        },
    };
    let call = {
        let runtime = runtime.clone();
        let request = request.clone();
        tokio::spawn(async move { runtime.filesystem(request).await })
    };
    bounded(executor.entered()).await;
    runtime.revoke(&scope.scope_id).unwrap();
    let error = bounded(call).await.unwrap().unwrap_err();
    assert_eq!(error.code, ErrorCode::ScopeClosed);
    assert_eq!(
        runtime.operation(&request.operation_id).unwrap().state,
        OperationState::Cancelled
    );
    assert_eq!(
        runtime.filesystem(request).await.unwrap_err().code,
        ErrorCode::ScopeClosed
    );
    assert_eq!(executor.starts.load(Ordering::SeqCst), 1);
    bounded(runtime.shutdown()).await.unwrap();
}
