//! 每个部署实例一个宿主；UI 进程退出不影响服务，停止须先完成 Core 结算。
use anyhow::{Context, Result, bail, ensure};
use areal_local_service::native_process::{TrustedChild as Child, TrustedCommand};
use areal_local_service::{LaunchSpec, probe, rpc, storage};
use areal_protocol::service::{Identity, Request, Response, Service, State, VERSION};
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

pub async fn run() -> Result<()> {
    let mut bytes = Vec::new();
    timeout(
        Duration::from_secs(10),
        tokio::io::stdin().take(256 * 1024).read_to_end(&mut bytes),
    )
    .await??;
    let spec: LaunchSpec = serde_json::from_slice(&bytes)?;
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
    let run = tempfile_dir(&directory, &identity.generation)?;
    let info = run.join("identity.json");
    storage::write(&info, &identity)?;
    let ready = run.join("ready.json");
    let log_file = directory.join("host.log");
    let lease_fd = ownership.as_raw_fd();
    let mut command = TrustedCommand::supervised(&spec.bin_dir.join("areal"), &[lease_fd])?;
    command
        .arg("launcher")
        .arg("--lease-fd")
        .arg(ownership.as_raw_fd().to_string())
        .arg("--bin-dir")
        .arg(&spec.bin_dir)
        .args(spec.args.launcher_args())
        .arg("--desktop")
        .arg("--ready-metadata-file")
        .arg(&ready)
        .arg("--service-info")
        .arg(&info)
        .current_dir(&spec.launch_cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .kill_on_drop(false);
    // launcher 共同持有实例锁：宿主被强杀后，在旧 Core/Runtime 清理完之前仍禁止替代启动。
    // Rust launcher 保留此锁并在启动 Core/Runtime 前恢复 close-on-exec。
    command.parent_pid_arg();
    let mut child = command
        .spawn()
        .await
        .context("start trusted Core/Runtime launcher")?;
    drop(command);
    let shutdown = CancellationToken::new();
    let signal_stop = shutdown.clone();
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    let signal_task = tokio::spawn(async move {
        tokio::select! { _=terminate.recv()=>{}, _=interrupt.recv()=>{} }
        signal_stop.cancel();
    });
    let generation = identity.generation.clone();
    let result = serve(
        &spec, identity, &ready, log_file, &directory, &mut child, shutdown,
    )
    .await;
    let cleanup = finish(&mut child, result.is_ok()).await;
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

    signal_task.abort();
    let _ = signal_task.await;
    // 持锁清理当前 generation，旧实例不能删除新实例的登记。
    let _ = std::fs::remove_file(directory.join("control.sock"));
    let _ = std::fs::remove_dir_all(run);
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
    ready: &std::path::Path,
    log_file: PathBuf,
    directory: &std::path::Path,
    child: &mut Child,
    shutdown: CancellationToken,
) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(40);
    let service = loop {
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
                break service;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        retention::bound_log(&log_file);
    };
    let socket = directory.join("control.sock");
    if socket.exists() {
        std::fs::remove_file(&socket)?;
    }
    let listener = UnixListener::bind(&socket)?;
    storage::write(&directory.join("components.json"), &spec.components)?;
    storage::write(&directory.join("service.json"), &service)?;
    let service = Arc::new(service);
    let stopping = Arc::new(Mutex::new(false));
    let mut requests = tokio::task::JoinSet::new();
    let mut log_tick = tokio::time::interval(Duration::from_secs(1));
    let outcome = loop {
        tokio::select! {
            _ = log_tick.tick() => retention::bound_log(&log_file),
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

async fn control(
    socket: UnixStream,
    service: &Service,
    stopping: Arc<Mutex<bool>>,
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
    let mut should_stop = false;
    let outcome: Result<Service> = async {
        match request {
            Request::Status { version } => {
                ensure!(version == VERSION, "unsupported service protocol");
                let mut response = service.clone();
                if *stopping.lock().await {
                    response.state = State::Stopping;
                }
                Ok(response)
            }
            Request::Stop {
                version,
                generation,
                cancel,
            } => {
                ensure!(
                    version == VERSION && generation == service.identity.generation,
                    "service generation/protocol mismatch"
                );
                let mut guard = stopping.lock().await;
                ensure!(!*guard, "service is already stopping");
                probe(service).await?;
                if !cancel {
                    let status = rpc(service, "areal/server/status", json!({})).await?;
                    ensure!(
                        status["restartSafe"] == true
                            && status["activeGoals"] == json!([])
                            && status["pendingQueueItems"] == 0
                            && status["activeTasks"].as_u64().unwrap_or(0) == 0,
                        "service is busy; wait for work to settle or stop with --cancel"
                    );
                }
                let status = rpc(
                    service,
                    "areal/server/drain",
                    json!({
                    "strategy":if cancel {"cancel"} else {"ifIdle"},"timeoutMs":30000}),
                )
                .await?;
                ensure!(
                    status["restartSafe"] == true,
                    "service drain is incomplete; inspect resources/UNKNOWN outcomes and retry stop"
                );
                *guard = true;
                should_stop = true;
                let mut response = service.clone();
                response.state = State::Stopping;
                // 显式停止记入登记，已打开的窗口不能把它误当故障而自动重启。
                storage::write(
                    &service.log_file.parent().unwrap().join("service.json"),
                    &response,
                )?;
                Ok(response)
            }
        }
    }
    .await;
    let response = match outcome {
        Ok(service) => Response::Ok {
            service: Box::new(service),
        },
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

async fn finish(child: &mut Child, require_clean_exit: bool) -> Result<()> {
    if let Some(status) = child.try_wait()? {
        ensure!(
            !require_clean_exit || status.success(),
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
