//! 每个部署实例一个宿主；GUI 宿主受应用生命期约束，公开停止须先完成 Core 结算。
use anyhow::{Context, Result, bail, ensure};
use areal_local_service::native_process::{TrustedChild as Child, TrustedCommand};
use areal_local_service::{
    LaunchSpec,
    gui_owner::{self, GuiLifetime},
    probe, rpc, storage,
};
use areal_protocol::service::{
    Capabilities, Identity, Request, Response, Service, State, StopOperation, StopOperationState,
    VERSION,
};
use fs2::FileExt;
use serde_json::{Value, json};
use std::{os::fd::AsRawFd, path::PathBuf, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    sync::Mutex,
    time::{Instant, timeout},
};
use tokio_util::sync::CancellationToken;
mod retention;
mod rotation;

#[derive(Clone, Copy)]
struct LaunchContext<'a> {
    ready: &'a std::path::Path,
    info: &'a std::path::Path,
    lease_fd: i32,
}

#[derive(Default)]
struct StopState {
    stopping: bool,
    operation: Option<storage::StopReceipt>,
}

pub async fn run() -> Result<()> {
    let lifetime = GuiLifetime::from_env()?;
    if let Some(lifetime) = &lifetime {
        lifetime.check_open()?;
    }
    let owner = gui_owner::from_env()?;
    ensure!(
        owner.is_some() == lifetime.is_some(),
        "GUI host requires matching owner and lifetime descriptor"
    );
    let shutdown = CancellationToken::new();
    let owner_task = lifetime.map(|lifetime| {
        let shutdown = shutdown.clone();
        tokio::spawn(async move {
            if let Err(error) = lifetime.closed().await {
                eprintln!("GUI lifetime stream failed: {error}");
            }
            shutdown.cancel();
        })
    });
    let result = run_host(owner, shutdown).await;
    if let Some(task) = owner_task {
        task.abort();
        let _ = task.await;
    }
    result
}

async fn run_host(
    owner: Option<areal_protocol::service::Owner>,
    shutdown: CancellationToken,
) -> Result<()> {
    let mut bytes = Vec::new();
    let mut input = tokio::io::stdin().take(256 * 1024);
    tokio::select! {
        _ = shutdown.cancelled() => bail!("GUI application ended before host startup"),
        result = timeout(Duration::from_secs(10), input.read_to_end(&mut bytes)) => { result??; },
    }
    let spec: LaunchSpec = serde_json::from_slice(&bytes)?;
    gui_owner::check(owner.as_ref(), spec.owner.as_ref())?;
    ensure!(
        !shutdown.is_cancelled(),
        "GUI application ended before host startup"
    );
    let directory = spec.directory()?;
    storage::private_dir(&directory)?;
    let data = spec
        .args
        .data_dir
        .as_ref()
        .context("missing data directory")?;
    let workspace = spec.args.workspace.as_ref().context("missing workspace")?;
    let ownership = storage::open_private(&data.join("service.lock"), true)?;
    ownership
        .try_lock_exclusive()
        .context("another service host owns the data directory")?;
    ensure!(
        storage::store_available(data)?,
        "previous Core still owns the store"
    );
    let socket = storage::control_socket(&directory)?;
    storage::private_dir(socket.parent().context("missing socket parent")?)?;
    retention::generations(&directory)?;
    storage::bind_workspace(data, workspace)?;
    let identity = Identity {
        protocol_version: VERSION,
        service_id: spec.service_id.clone(),
        generation: uuid::Uuid::new_v4().to_string(),
        workspace: workspace.clone(),
        data_dir: data.clone(),
        config_fingerprint: spec.fingerprint.clone(),
    };
    if let Some(original) = &spec.recovery_origin {
        let previous: Service = storage::read(&directory.join("service.json"))?;
        let proof: storage::CrashReceipt = storage::read(&directory.join("crash.json"))?;
        let mut replacement: storage::ReplacementReceipt =
            storage::read(&directory.join("replacement.json"))?;
        ensure!(
            previous.identity == *original
                && previous.owner == owner
                && proof.identity == *original
                && proof.version == VERSION
                && proof.unexpected_core_exit
                && proof.owner == owner
                && proof.cleanup_confirmed
                && proof.components == spec.components
                && replacement.original == *original
                && replacement.owner == owner
                && replacement.components == spec.components
                && matches!(
                    replacement.successor,
                    storage::ReplacementPublication::Unconfirmed
                )
                && original.service_id == identity.service_id
                && original.workspace == identity.workspace
                && original.data_dir == identity.data_dir
                && original.config_fingerprint == identity.config_fingerprint
                && !storage::has_admitted_stop_receipt(&directory, original)?,
            "crash recovery authorization changed"
        );
        let fresh = LaunchSpec::in_bin(&spec.args, spec.bin_dir.clone())?;
        ensure!(
            fresh.fingerprint == spec.fingerprint
                && fresh.components == spec.components
                && fresh.service_id == spec.service_id,
            "crash recovery configuration changed at Host startup"
        );
        ensure!(
            !shutdown.is_cancelled(),
            "GUI application ended before replacement startup"
        );
        replacement.successor = storage::ReplacementPublication::Published(identity.clone());
        storage::write(&directory.join("replacement.json"), &replacement)?;
    }
    let run = tempfile_dir(&directory, &identity.generation)?;
    let info = run.join("identity.json");
    storage::write(&info, &identity)?;
    let ready = run.join("ready.json");
    let lease_fd = ownership.as_raw_fd();
    let launch = LaunchContext {
        ready: &ready,
        info: &info,
        lease_fd,
    };
    ensure!(
        !shutdown.is_cancelled(),
        "GUI application ended before launcher startup"
    );
    // launcher 共同持有实例锁：宿主被强杀后，在旧 Core/Runtime 清理完之前仍禁止替代启动。
    // Rust launcher 保留此锁并在启动 Core/Runtime 前恢复 close-on-exec。
    let mut child = start_launcher(&spec, launch).await?;
    let signal_stop = shutdown.clone();
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    let signal_task = tokio::spawn(async move {
        tokio::select! { _=terminate.recv()=>{}, _=interrupt.recv()=>{} }
        signal_stop.cancel();
    });
    let generation = identity.generation.clone();
    let stopping = Arc::new(Mutex::new(StopState::default()));
    let result = serve(
        &spec,
        identity.clone(),
        launch,
        &socket,
        &mut child,
        shutdown.clone(),
        stopping.clone(),
    )
    .await;
    let exit_expectation = if result.is_ok() {
        ExitExpectation::RequireSuccess
    } else {
        ExitExpectation::ReapOnly
    };
    let process_cleanup = finish(&mut child, exit_expectation).await;
    let launcher_exited = child
        .try_wait()
        .is_ok_and(|status| status.is_some_and(|status| status.code().is_some()));
    let crash_proof = storage::read::<storage::LauncherCleanup>(&run.join("cleanup.json"));
    if result.is_err()
        && launcher_exited
        && !shutdown.is_cancelled()
        && process_cleanup.is_ok()
        && let Ok(proof) = crash_proof
        && proof.identity == identity
        && proof.unexpected_core_exit
        && proof.runtime_cleanup_confirmed
        && !storage::has_admitted_stop_receipt(&directory, &identity)?
        && let Ok(record) = storage::read::<Service>(&directory.join("service.json"))
        && record.identity == identity
        && record.state == State::Ready
    {
        storage::write(
            &directory.join("crash.json"),
            &storage::CrashReceipt {
                version: VERSION,
                unexpected_core_exit: true,
                identity: identity.clone(),
                owner: spec.owner.clone(),
                components: spec.components.clone(),
                cleanup_confirmed: true,
            },
        )?;
    }
    let socket_cleanup = match std::fs::remove_file(&socket) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    };
    let run_cleanup = std::fs::remove_dir_all(run).map_err(anyhow::Error::from);
    let cleanup = process_cleanup.and(socket_cleanup).and(run_cleanup);
    if let Ok(mut record) = storage::read::<Service>(&directory.join("service.json"))
        && record.identity.generation == generation
        && (result.is_ok() || cleanup.is_err())
    {
        record.state = if cleanup.is_ok() {
            State::Stopped
        } else {
            State::Unavailable
        };
        storage::write(&directory.join("service.json"), &record)?;
    }

    if let Some(receipt) = &mut stopping.lock().await.operation {
        if cleanup.is_ok() && result.is_ok() {
            receipt.cleanup_confirmed = true;
        } else {
            receipt.operation.state = StopOperationState::SettlementIncomplete;
            receipt.operation.message =
                Some("host cleanup is not confirmed; inspect the service log".into());
        }
        storage::write_stop_receipt(&directory, receipt)?;
    }

    signal_task.abort();
    let _ = signal_task.await;
    cleanup?;
    result
}

pub mod launcher;

fn tempfile_dir(parent: &std::path::Path, generation: &str) -> Result<PathBuf> {
    let path = parent.join(generation);
    storage::private_dir(&path)?;
    Ok(path)
}

async fn serve(
    spec: &LaunchSpec,
    identity: Identity,
    launch: LaunchContext<'_>,
    socket: &std::path::Path,
    child: &mut Child,
    shutdown: CancellationToken,
    stopping: Arc<Mutex<StopState>>,
) -> Result<()> {
    let directory = spec.directory()?;
    let log_file = directory.join("host.log");
    let service = wait_ready(spec, &identity, launch.ready, child, &shutdown).await?;
    if socket.exists() {
        std::fs::remove_file(socket)?;
    }
    let listener = UnixListener::bind(socket)?;
    storage::write(&directory.join("components.json"), &spec.components)?;
    storage::write(&directory.join("service.json"), &service)?;
    let service = Arc::new(Mutex::new(service));
    let mut requests = tokio::task::JoinSet::new();
    let mut log_tick = tokio::time::interval(Duration::from_secs(1));
    let mut rotation = rotation::Rotation::default();
    let outcome = loop {
        tokio::select! {
            _ = log_tick.tick() => {
                retention::bound_log(&log_file);
                let mut service = service.lock().await;
                let stopping = stopping.lock().await;
                if !stopping.stopping && !shutdown.is_cancelled()
                    && let Err(error) = rotation.check(spec, launch, &mut service, child, &shutdown).await {
                    break Err(error);
                }
                if shutdown.is_cancelled() { break Ok(()); }
            },
            _ = shutdown.cancelled() => break Ok(()),
            result = child.wait() => break Err(anyhow::anyhow!("Core/Runtime launcher exited: {:?}", result?)),
            incoming = listener.accept() => {
                let (socket, _) = incoming?;
                if requests.len() >= 32 { drop(socket); continue; }
                let service = service.clone();
                let stopping = stopping.clone();
                let shutdown = shutdown.clone();
                requests.spawn(async move { let _ = control(socket, &service, stopping, shutdown).await; });
            },
            _ = requests.join_next(), if !requests.is_empty() => {}
        }
    };
    requests.abort_all();
    while requests.join_next().await.is_some() {}
    outcome
}

async fn start_launcher(spec: &LaunchSpec, launch: LaunchContext<'_>) -> Result<Child> {
    let mut command = TrustedCommand::supervised(&spec.bin_dir.join("areal"), &[launch.lease_fd])?;
    command
        .env_remove(gui_owner::OWNER_ENV)
        .env_remove(gui_owner::LIFETIME_FD_ENV)
        .arg("launcher")
        .arg("--lease-fd")
        .arg(launch.lease_fd.to_string())
        .arg("--bin-dir")
        .arg(&spec.bin_dir)
        .args(spec.args.launcher_args())
        .arg("--desktop")
        .arg("--ready-metadata-file")
        .arg(launch.ready)
        .arg("--service-info")
        .arg(launch.info)
        .current_dir(&spec.launch_cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .kill_on_drop(false);
    command.parent_pid_arg();
    command
        .spawn()
        .await
        .context("start trusted Core/Runtime launcher")
}

async fn wait_ready(
    spec: &LaunchSpec,
    identity: &Identity,
    ready: &std::path::Path,
    child: &mut Child,
    shutdown: &CancellationToken,
) -> Result<Service> {
    let log_file = spec.directory()?.join("host.log");
    let deadline = Instant::now() + Duration::from_secs(40);
    loop {
        ensure!(!shutdown.is_cancelled(), "service startup cancelled");
        ensure!(
            child.try_wait()?.is_none(),
            "Core/Runtime launcher stopped during startup"
        );
        ensure!(Instant::now() < deadline, "Core/Runtime startup timed out");
        if let Ok(meta) = storage::read::<Value>(ready) {
            let endpoint = meta["endpoint"]
                .as_str()
                .context("missing endpoint")?
                .to_owned();
            let service = Service {
                owner: spec.owner.clone(),
                identity: identity.clone(),
                web_url: format!("{}/ui", endpoint.replacen("ws://", "http://", 1)),
                endpoint,
                auth_file: meta["authFile"]
                    .as_str()
                    .context("missing authFile")?
                    .into(),
                core_pid: meta["pid"].as_u64().context("missing Core pid")? as u32,
                host_pid: std::process::id(),
                log_file: log_file.clone(),
                state: State::Ready,
            };
            if probe(&service).await.is_ok() {
                return Ok(service);
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        retention::bound_log(&log_file);
    }
}

async fn control(
    socket: UnixStream,
    service: &Mutex<Service>,
    stopping: Arc<Mutex<StopState>>,
    shutdown: CancellationToken,
) -> Result<()> {
    let (read, mut write) = socket.into_split();
    let mut line = String::new();
    timeout(
        Duration::from_secs(2),
        BufReader::new(read.take(8192)).read_line(&mut line),
    )
    .await??;
    let request: Request = serde_json::from_str(&line)?;
    // 容量轮换持有同一锁，控制查询不能拿到已退出 Core 的旧 endpoint。
    let service = service.lock().await;
    let service = &*service;
    let mut should_stop = false;
    let outcome: Result<Response> = async {
        match request {
            Request::Status { version } => {
                ensure!(version == VERSION, "unsupported service protocol");
                let mut response = service.clone();
                if stopping.lock().await.stopping {
                    response.state = State::Stopping;
                }
                Ok(Response::Ok {
                    service: Box::new(response),
                })
            }
            Request::Capabilities {
                version,
                generation,
            } => {
                ensure!(
                    version == VERSION && generation == service.identity.generation,
                    "service generation/protocol mismatch"
                );
                Ok(Response::Capabilities {
                    capabilities: Capabilities {
                        version: VERSION,
                        stop_operations: 1,
                    },
                })
            }
            Request::Stop {
                version,
                generation,
                ..
            } => {
                ensure!(
                    version == VERSION && generation == service.identity.generation,
                    "service generation/protocol mismatch"
                );
                bail!(
                    "legacy stop requests are disabled; use the current areal CLI with `service stop --instance {} --expected-generation {} --request-id <unique-id>` and inspect that operation before retrying",
                    service.identity.service_id,
                    service.identity.generation
                );
            }
            Request::StopOperation {
                version,
                generation,
                request_id,
                cancel,
            } => {
                ensure!(version == VERSION, "unsupported service protocol");
                let mut guard = stopping.lock().await;
                if let Some(receipt) =
                    storage::read_stop_receipt(service.log_file.parent().unwrap(), &request_id)?
                {
                    ensure!(
                        receipt.operation.generation == generation
                            && receipt.operation.cancel == cancel,
                        "stop request conflict: generation or cancel strategy changed"
                    );
                    return Ok(Response::Operation {
                        operation: Box::new(receipt.operation),
                    });
                }
                ensure!(
                    generation == service.identity.generation,
                    "service generation/protocol mismatch"
                );
                let operation = begin_stop(service, &mut guard, request_id, cancel).await?;
                should_stop = guard.stopping;
                Ok(Response::Operation {
                    operation: Box::new(operation),
                })
            }
        }
    }
    .await;
    let response = match outcome {
        Ok(response) => response,
        Err(error) => Response::Error {
            message: error.to_string(),
        },
    };
    let mut bytes = serde_json::to_vec(&response)?;
    bytes.push(b'\n');
    let sent = timeout(Duration::from_secs(2), write.write_all(&bytes)).await;
    // stop 一旦受理，客户端丢失响应也不能撤销已开始的清理。
    if should_stop {
        shutdown.cancel();
    }
    sent??;
    Ok(())
}

async fn begin_stop(
    service: &Service,
    state: &mut StopState,
    request_id: String,
    cancel: bool,
) -> Result<StopOperation> {
    let directory = service.log_file.parent().unwrap();
    let mut receipt = storage::StopReceipt {
        operation: StopOperation {
            version: VERSION,
            request_id,
            service_id: service.identity.service_id.clone(),
            generation: service.identity.generation.clone(),
            cancel,
            state: StopOperationState::AcceptedPending,
            message: None,
            lifecycle: None,
        },
        service: service.clone(),
        cleanup_confirmed: false,
    };
    storage::write_stop_receipt(directory, &receipt)?;
    let admission = async {
        ensure!(!state.stopping, "service is already stopping");
        probe(service).await?;
        if !cancel {
            let status = rpc(service, "areal/server/status", json!({})).await?;
            receipt.operation.lifecycle = status.get("lifecycle").cloned();
            ensure!(
                if status.get("lifecycle").is_some() {
                    status["lifecycle"]["version"] == 1
                        && status["lifecycle"]["ifIdle"]["allowed"] == true
                } else {
                    status["restartSafe"] == true
                        && status["activeGoals"] == json!([])
                        && status["pendingQueueItems"] == 0
                        && status["activeTasks"].as_u64().unwrap_or(0) == 0
                },
                "service is busy; wait for work to settle or stop with --cancel"
            );
        }
        Ok::<_, anyhow::Error>(())
    }
    .await;
    if let Err(error) = admission {
        receipt.operation.state = StopOperationState::Blocked;
        receipt.operation.message = Some(error.to_string());
    } else {
        match rpc(
            service,
            "areal/server/drain",
            json!({
                "strategy":if cancel {"cancel"} else {"ifIdle"}, "timeoutMs":30000,
            }),
        )
        .await
        {
            Ok(status) => {
                receipt.operation.lifecycle = status.get("lifecycle").cloned();
                if status["restartSafe"] != true {
                    receipt.operation.state = StopOperationState::SettlementIncomplete;
                    receipt.operation.message = Some("service drain is incomplete; inspect resources/UNKNOWN outcomes before starting a new stop operation".into());
                }
            }
            Err(error) => {
                receipt.operation.state = StopOperationState::AdmissionUnknown;
                receipt.operation.message = Some(error.to_string());
            }
        }
    }
    storage::write_stop_receipt(directory, &receipt)?;
    if receipt.operation.state == StopOperationState::AcceptedPending {
        let mut record = service.clone();
        record.state = State::Stopping;
        storage::write(&directory.join("service.json"), &record)?;
        state.stopping = true;
        state.operation = Some(receipt.clone());
    }
    Ok(receipt.operation)
}

enum ExitExpectation {
    RequireSuccess,
    ReapOnly,
}

async fn finish(child: &mut Child, expectation: ExitExpectation) -> Result<()> {
    if let Some(status) = child.try_wait()? {
        ensure!(
            matches!(expectation, ExitExpectation::ReapOnly) || status.success(),
            "launcher reported cleanup failure"
        );
        return Ok(());
    }
    if let Some(pid) = child.id() {
        // 只对本进程尚未 wait 的子进程发信号，不使用登记中的历史 PID。
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }
    match timeout(Duration::from_secs(40), child.wait()).await {
        Ok(result) => {
            ensure!(result?.success(), "launcher reported cleanup failure");
            Ok(())
        }
        Err(_) => {
            child.kill().await?;
            let _ = child.wait().await;
            bail!("launcher cleanup timed out; Core lifetime pipe will close")
        }
    }
}
