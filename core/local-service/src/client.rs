use crate::{
    LaunchSpec,
    gui_owner::{self, OwnerLifetime},
    storage,
};
use anyhow::{Context, Result, bail, ensure};
use areal_protocol::service::{
    Capabilities, Identity, RecoveryInfo, RecoveryStatus, Request, Response, Service, State,
    StopOperation, StopOperationState, VERSION,
};
use fs2::FileExt;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
    time::{Instant, timeout},
};

#[derive(Debug)]
struct ControlTransportError(std::io::Error);
impl std::fmt::Display for ControlTransportError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(&self.0, formatter)
    }
}
impl std::error::Error for ControlTransportError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.0)
    }
}

pub async fn ensure(spec: &LaunchSpec) -> Result<Service> {
    ensure_inner(spec, None, false, true, None).await
}

pub async fn ensure_without_restart(spec: &LaunchSpec) -> Result<Service> {
    ensure_inner(spec, None, false, false, None).await
}

pub async fn restart(spec: &LaunchSpec, cancel: bool) -> Result<Service> {
    ensure_inner(spec, Some(cancel), false, true, None).await
}

pub async fn ensure_with_lifetime(
    spec: &LaunchSpec,
    lifetime: &OwnerLifetime,
    no_auto_restart: bool,
) -> Result<Service> {
    ensure!(spec.owner.is_some(), "service lifetime requires an owner");
    ensure_inner(spec, None, false, !no_auto_restart, Some(lifetime)).await
}

async fn ensure_inner(
    spec: &LaunchSpec,
    restart: Option<bool>,
    reconnect: bool,
    allow_automatic_restart: bool,
    lifetime: Option<&OwnerLifetime>,
) -> Result<Service> {
    ensure!(
        spec.owner.is_some() == lifetime.is_some(),
        "owned services require an inherited lifetime descriptor"
    );
    if let Some(lifetime) = lifetime {
        lifetime.check_open()?;
    }
    let directory = spec.directory()?;
    storage::private_dir(&spec.home.join("services"))?;
    storage::private_dir(&directory)?;
    let _startup = startup_lock(&directory).await?;
    if let Some(lifetime) = lifetime {
        lifetime.check_open()?;
    }
    if reconnect {
        let record: Service = storage::read(&directory.join("service.json"))?;
        ensure!(
            record.state == State::Ready,
            "service was explicitly stopped; open a new client or run areal service ensure to restart it"
        );
    }
    let data = spec.args.data_dir.as_ref().unwrap();
    std::fs::create_dir_all(data)?;
    let host_lock = data.join("service.lock");
    if !storage::available(&host_lock)? {
        let service = status_unlocked(&spec.home, &spec.service_id).await
            .context("service has an active owner but cannot be reached; inspect its log, do not start a second Core")?;
        ensure!(
            service.state == State::Ready,
            "service has an active owner but cannot be reached; inspect its log, do not start a second Core"
        );
        ensure!(
            Some(&service.identity.workspace) == spec.args.workspace.as_ref(),
            "data directory is bound to a different workspace"
        );
        gui_owner::check(spec.owner.as_ref(), service.owner.as_ref())?;
        if restart.is_none() && check_compatible(spec, &service, &directory).is_ok() {
            // 优先等待热更新；超时后只为有效配置走既有的空闲重启流程。
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                let state = rpc(&service, "areal/server/status", json!({})).await?;
                if state["configuration"]["modelRevision"].as_str()
                    == spec.components.get("model").map(String::as_str)
                {
                    return Ok(service);
                }
                if Instant::now() >= deadline {
                    check_model_restart(&state)?;
                    // 重连可持有旧 LaunchSpec；停止前重新校验文件和当前环境，避免停掉可用服务。
                    let current = match &spec.context {
                        Some(context) => {
                            LaunchSpec::in_context(&spec.args, spec.bin_dir.clone(), context)?
                        }
                        None => LaunchSpec::in_bin(&spec.args, spec.bin_dir.clone())?,
                    };
                    ensure!(
                        current.service_id == spec.service_id
                            && current.fingerprint == spec.fingerprint
                            && current.components == spec.components,
                        "configuration changed while waiting for model reload; the running service is unchanged; retry with the current configuration"
                    );
                    break;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
        if restart.is_none() {
            let previous: std::collections::BTreeMap<String, String> =
                storage::read(&directory.join("components.json"))?;
            for key in [
                "workspace",
                "permissions",
                "runtime",
                "deployment",
                "binaries",
                "model-inputs",
            ] {
                if previous
                    .get(key)
                    .is_some_and(|value| spec.components.get(key) != Some(value))
                {
                    check_compatible(spec, &service, &directory)?;
                }
            }
        }
        ensure!(
            restart.is_some() || allow_automatic_restart,
            "service requires explicit lifecycle restart; the running instance is unchanged"
        );
        stop_unlocked(&spec.home, &spec.service_id, restart.unwrap_or(false), None).await
            .with_context(|| format!("configuration requires a restart; wait for background work to finish, or run `{} --cancel` to explicitly cancel it", spec.restart_command()))?;
        if !reconnect {
            eprintln!("Restarting local service with the updated configuration");
        }
    }
    ensure!(
        storage::store_available(data)?,
        "another Core owns this data directory without a reusable service endpoint; use --endpoint or stop that Core explicitly"
    );
    if data.join("service-workspace").exists() {
        let bound: PathBuf = storage::read(&data.join("service-workspace"))?;
        ensure!(
            Some(&bound) == spec.args.workspace.as_ref(),
            "data directory is bound to a different workspace: {}",
            bound.display()
        );
    }
    launch_unlocked(spec, lifetime, &directory).await
}

async fn launch_unlocked(
    spec: &LaunchSpec,
    lifetime: Option<&OwnerLifetime>,
    directory: &Path,
) -> Result<Service> {
    let deadline = Instant::now() + Duration::from_secs(65);
    let log = storage::open_private(&directory.join("host.log"), true)?;
    log.set_len(0)?;
    // 宿主定期截断日志时，继承描述符必须 append，避免旧偏移产生稀疏大文件。
    use std::os::fd::AsRawFd;
    unsafe {
        let flags = libc::fcntl(log.as_raw_fd(), libc::F_GETFL);
        ensure!(
            flags >= 0 && libc::fcntl(log.as_raw_fd(), libc::F_SETFL, flags | libc::O_APPEND) >= 0,
            "could not configure service log append mode"
        );
    }
    if let Some(lifetime) = lifetime {
        lifetime.check_open()?;
    }
    let binary = spec.bin_dir.join("areal");
    let mut command = match lifetime {
        Some(lifetime) => {
            let mut command =
                crate::native_process::TrustedCommand::owned_host(&binary, lifetime.as_raw_fd())?;
            command
                .env(
                    gui_owner::SERVICE_LIFETIME_FD_ENV,
                    lifetime.as_raw_fd().to_string(),
                )
                .env(
                    gui_owner::SERVICE_OWNER_ENV,
                    serde_json::to_string(spec.owner.as_ref().unwrap())?,
                );
            command
        }
        None => crate::native_process::TrustedCommand::persistent(&binary)?,
    };
    if let Some(context) = &spec.context {
        command.env_clear().envs(&context.environment);
        if let Some(lifetime) = lifetime {
            command
                .env(
                    gui_owner::SERVICE_LIFETIME_FD_ENV,
                    lifetime.as_raw_fd().to_string(),
                )
                .env(
                    gui_owner::SERVICE_OWNER_ENV,
                    serde_json::to_string(spec.owner.as_ref().unwrap())?,
                );
        }
    }
    command
        .env_remove(gui_owner::OWNER_ENV)
        .env_remove(gui_owner::LIFETIME_FD_ENV)
        .arg("service-host");
    command
        .current_dir(&spec.launch_cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(log)
        .kill_on_drop(false);
    let mut child = command.spawn().await.context("start service host")?;
    drop(command);
    let mut input = child.stdin.take().unwrap();
    input.write_all(&serde_json::to_vec(spec)?).await?;
    input.shutdown().await?;
    drop(input);
    loop {
        if let Some(lifetime) = lifetime {
            lifetime.check_open()?;
        }
        if let Some(exit) = child.try_wait()? {
            let diagnostic =
                std::fs::read_to_string(directory.join("host.log")).unwrap_or_default();
            bail!(
                "service host exited ({exit}); log: {}\n{}",
                directory.join("host.log").display(),
                diagnostic.chars().take(4000).collect::<String>()
            );
        }
        // 启动门已由本客户端持有；只询问控制端点，不能用独占锁探测抢在新宿主前取锁。
        if let Ok(service) = request(
            &spec.home,
            &spec.service_id,
            Request::Status { version: VERSION },
        )
        .await
            && service.state == State::Ready
            && probe(&service).await.is_ok()
        {
            check_compatible(spec, &service, directory)?;
            // 后台 wait 回收同进程内退出的子进程；客户端退出不会发送终止信号。
            tokio::spawn(async move {
                let _ = child.wait().await;
            });
            return Ok(service);
        }
        ensure!(
            Instant::now() < deadline,
            "service startup timed out; inspect {}",
            directory.join("host.log").display()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn recovery_proof(directory: &Path, service: &Service) -> Result<storage::CrashReceipt> {
    ensure!(
        !storage::has_admitted_stop_receipt(directory, &service.identity)?,
        "explicitStopIntent"
    );
    ensure!(
        service.state != State::Ready && service.state != State::Stopping,
        "serviceStillRunning"
    );
    ensure!(service.owner.is_some(), "applicationOwnerRequired");
    ensure!(
        storage::available(&service.identity.data_dir.join("service.lock"))?
            && storage::store_available(&service.identity.data_dir)?,
        "cleanupUnconfirmed"
    );
    let proof: storage::CrashReceipt =
        storage::read(&directory.join("crash.json")).context("cleanupUnconfirmed")?;
    ensure!(
        proof.version == VERSION
            && proof.unexpected_core_exit
            && proof.identity == service.identity
            && proof.owner == service.owner
            && proof.cleanup_confirmed,
        "cleanupUnconfirmed"
    );
    Ok(proof)
}

pub async fn status_with_recovery(root: &Path, id: &str) -> Result<RecoveryStatus> {
    let directory = storage::registry(root, id)?;
    let _startup = startup_lock(&directory).await?;
    let service = status_unlocked(root, id).await?;
    let check = recovery_proof(&directory, &service).and_then(|_| {
        if let Some(replacement) = storage::read_optional::<storage::ReplacementReceipt>(
            &directory.join("replacement.json"),
        )? {
            ensure!(
                replacement.original != service.identity,
                "replacementAlreadyAttempted"
            );
        }
        Ok(())
    });
    let recovery = RecoveryInfo {
        version: VERSION,
        generation: service.identity.generation.clone(),
        eligible: check.is_ok(),
        reason: check
            .err()
            .map_or_else(|| "confirmedCoreCrash".into(), |e| e.to_string()),
    };
    Ok(RecoveryStatus { service, recovery })
}

fn check_recovery_spec(
    spec: &LaunchSpec,
    identity: &Identity,
    owner: Option<&areal_protocol::service::Owner>,
    components: &std::collections::BTreeMap<String, String>,
) -> Result<()> {
    gui_owner::check(spec.owner.as_ref(), owner)?;
    ensure!(
        identity.protocol_version == VERSION
            && identity.service_id == spec.service_id
            && Some(&identity.workspace) == spec.args.workspace.as_ref()
            && Some(&identity.data_dir) == spec.args.data_dir.as_ref()
            && identity.config_fingerprint == spec.fingerprint
            && components == &spec.components,
        "crash recovery configuration or identity changed"
    );
    Ok(())
}

/// 仅恢复同一存活 GUI 的已证明清理完成的 Core 崩溃；不能替代 ensure/restart。
pub async fn recover_crashed(
    spec: &LaunchSpec,
    expected_generation: &str,
    lifetime: &OwnerLifetime,
) -> Result<Service> {
    ensure!(spec.owner.is_some(), "crash recovery requires a GUI owner");
    lifetime.check_open()?;
    let directory = spec.directory()?;
    let _startup = startup_lock(&directory).await?;
    lifetime.check_open()?;
    let mut fresh = LaunchSpec::in_bin(&spec.args, spec.bin_dir.clone())?;
    fresh.owner = spec.owner.clone();
    ensure!(
        fresh.service_id == spec.service_id
            && fresh.fingerprint == spec.fingerprint
            && fresh.components == spec.components,
        "crash recovery configuration changed"
    );
    if let Some(receipt) =
        storage::read_optional::<storage::ReplacementReceipt>(&directory.join("replacement.json"))?
        && receipt.original.generation == expected_generation
    {
        check_recovery_spec(
            &fresh,
            &receipt.original,
            receipt.owner.as_ref(),
            &receipt.components,
        )?;
        ensure!(
            !storage::has_admitted_stop_receipt(&directory, &receipt.original)?,
            "original generation has explicit stop intent"
        );
        let successor = match receipt.successor {
            storage::ReplacementPublication::Published(identity) => identity,
            storage::ReplacementPublication::Unconfirmed => {
                bail!("replacement launch is unknown; automatic retry is forbidden")
            }
        };
        let service = status_unlocked(&fresh.home, &fresh.service_id).await?;
        ensure!(
            service.identity == successor && service.state == State::Ready,
            "recorded replacement is not ready; original generation cannot start another successor"
        );
        ensure!(
            !storage::has_admitted_stop_receipt(&directory, &successor)?,
            "successor has explicit stop intent"
        );
        check_compatible(&fresh, &service, &directory)?;
        lifetime.check_open()?;
        return Ok(service);
    }
    let service = status_unlocked(&fresh.home, &fresh.service_id).await?;
    ensure!(
        service.identity.generation == expected_generation,
        "crash recovery generation mismatch"
    );
    let proof = recovery_proof(&directory, &service)?;
    check_recovery_spec(
        &fresh,
        &proof.identity,
        proof.owner.as_ref(),
        &proof.components,
    )?;
    let latest = LaunchSpec::in_bin(&fresh.args, fresh.bin_dir.clone())?;
    ensure!(
        latest.fingerprint == fresh.fingerprint
            && latest.components == fresh.components
            && latest.service_id == fresh.service_id,
        "crash recovery configuration changed before launch"
    );
    lifetime.check_open()?;
    storage::write(
        &directory.join("replacement.json"),
        &storage::ReplacementReceipt {
            original: service.identity.clone(),
            owner: fresh.owner.clone(),
            components: fresh.components.clone(),
            successor: storage::ReplacementPublication::Unconfirmed,
        },
    )?;
    fresh.recovery_origin = Some(service.identity);
    launch_unlocked(&fresh, Some(lifetime), &directory).await
}

fn check_model_restart(state: &Value) -> Result<()> {
    // 缺失凭据由服务明确标记为需重启；解析、归档和持久化错误不能靠重启掩盖。
    if let Some(error) = state["configuration"]["error"].as_str() {
        ensure!(
            state["configuration"]["restartRequired"] == true,
            "model configuration has not been applied; the running service is unchanged: {error}"
        );
    }
    Ok(())
}

async fn startup_lock(directory: &Path) -> Result<std::fs::File> {
    let startup = storage::open_private(&directory.join("start.lock"), true)?;
    let deadline = Instant::now() + Duration::from_secs(65);
    loop {
        match startup.try_lock_exclusive() {
            Ok(()) => break,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(50)).await
            }
            Err(e) => return Err(e).context("waiting for the concurrent service launch"),
        }
    }
    Ok(startup)
}

pub async fn reconnect(spec: &LaunchSpec) -> Result<Service> {
    ensure_inner(spec, None, true, true, None).await
}

fn check_compatible(spec: &LaunchSpec, service: &Service, directory: &Path) -> Result<()> {
    gui_owner::check(spec.owner.as_ref(), service.owner.as_ref())?;
    ensure!(
        service.state == State::Ready,
        "service is not accepting connections: {:?}",
        service.state
    );
    ensure!(
        service.identity.protocol_version == VERSION
            && service.identity.service_id == spec.service_id
            && Some(&service.identity.data_dir) == spec.args.data_dir.as_ref(),
        "service identity mismatch"
    );
    if service.identity.config_fingerprint != spec.fingerprint {
        let previous: std::collections::BTreeMap<String, String> =
            storage::read(&directory.join("components.json"))?;
        let changed: Vec<_> = spec
            .components
            .iter()
            .filter(|(k, v)| previous.get(*k) != Some(*v))
            .map(|(k, _)| k.as_str())
            .collect();
        bail!(
            "service configuration conflict ({}) for instance {}; run `{}` using the same binary and environment as this client, or use another --data-dir",
            changed.join(", "),
            spec.service_id,
            spec.restart_command()
        );
    }
    Ok(())
}

/// 日常控制按工作区选择；多数据目录时要求显式消歧，不猜测要停止的服务。
pub async fn select(
    root: &Path,
    instance: Option<&str>,
    workspace: Option<&Path>,
    data: Option<&Path>,
) -> Result<String> {
    if let Some(instance) = instance {
        return Ok(instance.into());
    }
    let workspace = workspace
        .map(Path::to_path_buf)
        .unwrap_or(std::env::current_dir()?)
        .canonicalize()?;
    let data = data.map(storage::canonical_pending).transpose()?;
    let matches: Vec<_> = list(root)
        .await?
        .into_iter()
        .filter(|s| {
            s.identity.workspace == workspace
                && data.as_ref().is_none_or(|p| p == &s.identity.data_dir)
        })
        .collect();
    ensure!(
        !matches.is_empty(),
        "no service for this workspace; run `areal service ensure` first"
    );
    ensure!(
        matches.len() == 1,
        "multiple services for this workspace; specify --data-dir or --instance"
    );
    Ok(matches[0].identity.service_id.clone())
}

pub async fn request(root: &Path, id: &str, request: Request) -> Result<Service> {
    match control_request(root, id, request).await? {
        Response::Ok { service } => Ok(*service),
        _ => bail!("unexpected service control response"),
    }
}

async fn control_request(root: &Path, id: &str, request: Request) -> Result<Response> {
    let directory = storage::registry(root, id)?;
    ensure!(directory.is_dir(), "unknown service instance: {id}");
    storage::private_dir(&directory)?;
    let socket = storage::control_socket(&directory)?;
    storage::private_dir(socket.parent().context("missing socket parent")?)?;
    let connection = timeout(Duration::from_secs(2), UnixStream::connect(socket))
        .await?
        .map_err(ControlTransportError)?;
    let (read, mut write) = connection.into_split();
    let mut bytes = serde_json::to_vec(&request)?;
    bytes.push(b'\n');
    write
        .write_all(&bytes)
        .await
        .map_err(ControlTransportError)?;
    let mut reader = BufReader::new(read.take(256 * 1024));
    let mut line = String::new();
    // 服务仅在私有 socket 上返回有界的一行响应。
    use tokio::io::AsyncReadExt;
    let count = timeout(Duration::from_secs(65), reader.read_line(&mut line))
        .await?
        .map_err(ControlTransportError)?;
    if count == 0 {
        return Err(
            ControlTransportError(std::io::Error::from(std::io::ErrorKind::UnexpectedEof)).into(),
        );
    }
    match serde_json::from_str(&line)? {
        Response::Error { message } => bail!("{message}"),
        response => Ok(response),
    }
}

pub async fn capabilities(root: &Path, id: &str, generation: &str) -> Result<Capabilities> {
    let directory = storage::registry(root, id)?;
    let _startup = startup_lock(&directory).await?;
    capabilities_unlocked(root, id, generation).await
}

async fn capabilities_unlocked(root: &Path, id: &str, generation: &str) -> Result<Capabilities> {
    match control_request(
        root,
        id,
        Request::Capabilities {
            version: VERSION,
            generation: generation.to_owned(),
        },
    )
    .await
    .context("service does not expose stop-operation capabilities")?
    {
        Response::Capabilities { capabilities } => Ok(capabilities),
        _ => bail!("unexpected service capability response"),
    }
}

pub async fn operation(
    root: &Path,
    id: &str,
    generation: &str,
    request_id: &str,
) -> Result<Option<StopOperation>> {
    let directory = storage::registry(root, id)?;
    let _startup = startup_lock(&directory).await?;
    operation_unlocked(&directory, id, generation, request_id)
}

fn operation_unlocked(
    directory: &Path,
    id: &str,
    generation: &str,
    request_id: &str,
) -> Result<Option<StopOperation>> {
    let Some(receipt) = storage::read_stop_receipt(directory, request_id)? else {
        return Ok(None);
    };
    let mut operation = receipt.operation;
    ensure!(
        operation.version == VERSION
            && operation.service_id == id
            && operation.generation == generation
            && receipt.service.identity.service_id == id
            && receipt.service.identity.generation == generation,
        "stop request conflict: operation identity does not match"
    );
    if operation.state == StopOperationState::AcceptedPending {
        let current: Service = storage::read(&directory.join("service.json"))?;
        ensure!(current.identity.service_id == id, "invalid service record");
        let replaced = current.identity.generation != generation;
        if replaced
            || (storage::available(&receipt.service.identity.data_dir.join("service.lock"))?
                && storage::store_available(&receipt.service.identity.data_dir)?)
        {
            let settled = storage::read_stop_receipt(directory, request_id)?
                .context("the original stop receipt disappeared after shutdown")?;
            ensure!(
                settled.operation.version == operation.version
                    && settled.operation.service_id == operation.service_id
                    && settled.operation.generation == operation.generation
                    && settled.operation.cancel == operation.cancel
                    && settled.service.identity == receipt.service.identity,
                "stop request conflict: settled operation identity does not match"
            );
            operation = settled.operation;
            if operation.state == StopOperationState::AcceptedPending {
                operation.state = if settled.cleanup_confirmed {
                    StopOperationState::Completed
                } else {
                    StopOperationState::AdmissionUnknown
                };
                if !settled.cleanup_confirmed {
                    operation.message =
                        Some("the original host exited without confirming cleanup".into());
                }
            }
        }
    }
    Ok(Some(operation))
}

pub async fn stop_operation(
    root: &Path,
    id: &str,
    generation: &str,
    request_id: &str,
    cancel: bool,
) -> Result<StopOperation> {
    let directory = storage::registry(root, id)?;
    let _startup = startup_lock(&directory).await?;
    stop_operation_unlocked(root, id, generation, request_id, cancel)
        .await
        .with_context(|| format!("stop request {request_id} for generation {generation}"))
}

async fn stop_operation_unlocked(
    root: &Path,
    id: &str,
    generation: &str,
    request_id: &str,
    cancel: bool,
) -> Result<StopOperation> {
    let directory = storage::registry(root, id)?;
    if let Some(operation) = operation_unlocked(&directory, id, generation, request_id)? {
        ensure!(
            operation.cancel == cancel,
            "stop request conflict: cancel strategy changed"
        );
        return Ok(operation);
    }
    let capabilities = capabilities_unlocked(root, id, generation).await?;
    ensure!(
        capabilities.version == VERSION && capabilities.stop_operations == 1,
        "service does not support durable stop operations"
    );
    match control_request(root, id, Request::StopOperation {
        version: VERSION,
        generation: generation.to_owned(),
        request_id: request_id.to_owned(),
        cancel,
    }).await {
        Ok(Response::Operation { operation }) => {
            ensure!(
                operation.request_id == request_id && operation.service_id == id
                    && operation.generation == generation && operation.cancel == cancel,
                "invalid stop operation response"
            );
            Ok(*operation)
        }
        Ok(_) => bail!("unexpected stop operation response"),
        Err(error) => match operation_unlocked(&directory, id, generation, request_id)? {
            Some(operation) => {
                ensure!(operation.cancel == cancel, "stop request conflict: cancel strategy changed");
                Ok(operation)
            }
            None => Err(error).context("stop admission is unknown; read the original operation before taking further action"),
        },
    }
}

pub async fn status(root: &Path, id: &str) -> Result<Service> {
    let directory = storage::registry(root, id)?;
    // 外部状态探测与启动串行，避免暂持实例锁时被新宿主误认成另一个 owner。
    let _startup = startup_lock(&directory).await?;
    status_unlocked(root, id).await
}

async fn status_unlocked(root: &Path, id: &str) -> Result<Service> {
    let directory = storage::registry(root, id)?;
    let mut record: Service = storage::read(&directory.join("service.json"))?;
    ensure!(
        record.identity.service_id == id && record.identity.protocol_version == VERSION,
        "invalid service record"
    );
    if storage::available(&record.identity.data_dir.join("service.lock"))? {
        record.state = if record.state != State::Unavailable
            && storage::store_available(&record.identity.data_dir)?
        {
            State::Stopped
        } else {
            State::Unavailable
        };
        return Ok(record);
    }
    let mut live = match request(root, id, Request::Status { version: VERSION }).await {
        Ok(live) => live,
        Err(error)
            if error
                .downcast_ref::<ControlTransportError>()
                .is_some_and(|error| {
                    matches!(
                        error.0.kind(),
                        std::io::ErrorKind::NotFound
                            | std::io::ErrorKind::ConnectionRefused
                            | std::io::ErrorKind::ConnectionReset
                            | std::io::ErrorKind::BrokenPipe
                            | std::io::ErrorKind::UnexpectedEof
                    )
                }) =>
        {
            // Host 可先关闭控制端点再释放租约。只报告不可用，不伪造停止或清理回执；
            // 正常发现仍须核对代际，下一次查询只有两把锁都释放后才可观察 stopped。
            record.state = State::Unavailable;
            return Ok(record);
        }
        Err(error) => return Err(error),
    };
    ensure!(
        live.identity == record.identity,
        "service generation changed; retry discovery"
    );
    gui_owner::check(record.owner.as_ref(), live.owner.as_ref())?;
    if live.state == State::Ready {
        match probe(&live).await {
            Ok(()) => {}
            Err(error)
                if error
                    .downcast_ref::<reqwest::Error>()
                    .is_some_and(reqwest::Error::is_connect) =>
            {
                // Core 可先退出、Host 后发布清理证明；连接失败只投影不可用，不授予恢复权。
                live.state = State::Unavailable;
            }
            Err(error) => return Err(error),
        }
    }
    Ok(live)
}

pub async fn list(root: &Path) -> Result<Vec<Service>> {
    let directory = root.join("services");
    if !directory.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if !entry.path().join("service.json").exists() {
            continue;
        }
        match status(root, &id).await {
            Ok(service) => out.push(service),
            Err(_) => {
                let mut record: Service = storage::read(&entry.path().join("service.json"))?;
                record.state = State::Unavailable;
                out.push(record);
            }
        }
    }
    out.sort_by(|a, b| a.identity.service_id.cmp(&b.identity.service_id));
    Ok(out)
}

pub async fn stop(root: &Path, id: &str, cancel: bool) -> Result<Service> {
    let directory = storage::registry(root, id)?;
    let _startup = startup_lock(&directory).await?;
    stop_unlocked(root, id, cancel, None).await
}

/// 在同一启动锁内校验已确认实例，不能取消换代后的服务。
pub async fn stop_with_generation(
    root: &Path,
    id: &str,
    cancel: bool,
    generation: &str,
) -> Result<Service> {
    let directory = storage::registry(root, id)?;
    let _startup = startup_lock(&directory).await?;
    stop_unlocked(root, id, cancel, Some(generation)).await
}

async fn stop_unlocked(
    root: &Path,
    id: &str,
    cancel: bool,
    expected_generation: Option<&str>,
) -> Result<Service> {
    let mut service = status_unlocked(root, id).await?;
    if let Some(expected) = expected_generation {
        ensure!(
            service.identity.generation == expected,
            "service generation changed; confirm the current instance before stopping"
        );
    }
    if service.state == State::Stopped {
        return Ok(service);
    }
    let generation = service.identity.generation.clone();
    let request_id = uuid::Uuid::new_v4().to_string();
    let outcome: Result<Service> = async {
        let directory = storage::registry(root, id)?;
        let mut operation =
            stop_operation_unlocked(root, id, &generation, &request_id, cancel).await?;
        let deadline = Instant::now() + Duration::from_secs(45);
        loop {
            ensure!(
                matches!(operation.state, StopOperationState::AcceptedPending | StopOperationState::Completed),
                "service stop is {:?}: {}; inspect the original operation before taking further action",
                operation.state,
                operation.message.as_deref().unwrap_or("cleanup is not confirmed")
            );
            if operation.state == StopOperationState::Completed
                && storage::available(&service.identity.data_dir.join("service.lock"))?
                && storage::store_available(&service.identity.data_dir)?
            {
                let settled: Service = storage::read(&directory.join("service.json"))?;
                ensure!(
                    settled.identity.generation == generation && settled.state == State::Stopped,
                    "service did not confirm clean shutdown or has already restarted; inspect {}",
                    service.log_file.display()
                );
                service.state = State::Stopped;
                return Ok(service);
            }
            ensure!(
                Instant::now() < deadline,
                "service cleanup is not confirmed; inspect the original operation and {}",
                service.log_file.display()
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
            operation = operation_unlocked(&directory, id, &generation, &request_id)?
                .context("the original stop receipt is missing; admission is unknown")?;
        }
    }.await;
    outcome.with_context(|| format!("stop request {request_id} for generation {generation}"))
}

fn token(service: &Service) -> Result<String> {
    let auth: Value = storage::read(&service.auth_file)?;
    Ok(auth["principals"][0]["token"]
        .as_str()
        .context("missing service token")?
        .into())
}

fn http_endpoint(service: &Service) -> Result<reqwest::Url> {
    let endpoint = reqwest::Url::parse(&service.endpoint)?;
    ensure!(
        endpoint.scheme() == "ws"
            && matches!(endpoint.host_str(), Some("127.0.0.1" | "[::1]" | "::1"))
            && endpoint.username().is_empty()
            && endpoint.password().is_none()
            && endpoint.path() == "/"
            && endpoint.query().is_none()
            && endpoint.fragment().is_none(),
        "service endpoint must be loopback"
    );
    let mut url = endpoint;
    url.set_scheme("http").unwrap();
    Ok(url)
}

pub async fn probe(service: &Service) -> Result<()> {
    let mut url = http_endpoint(service)?;
    url.set_path("/areal/service");
    let identity: Identity = reqwest::Client::builder()
        .tls_built_in_native_certs(false)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()?
        .get(url)
        .bearer_auth(token(service)?)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    ensure!(
        identity == service.identity,
        "Core identity/generation does not match the service record"
    );
    Ok(())
}

/// 返回仅供打开浏览器的一次性 URL；调用方不得写入日志或发现描述。
pub async fn browser_login_url(service: &Service) -> Result<String> {
    probe(service).await?;
    let mut url = http_endpoint(service)?;
    url.set_path("/areal/auth/bootstrap");
    let mut response = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()?
        .post(url.clone())
        .bearer_auth(token(service)?)
        .send()
        .await?;
    ensure!(
        response.status().is_success(),
        "browser login could not be prepared; rerun areal web or sign in manually at {}",
        service.web_url
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            bytes.len() + chunk.len() <= 4096,
            "invalid browser login response"
        );
        bytes.extend_from_slice(&chunk);
    }
    let ticket: areal_protocol::service::BrowserBootstrap = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("invalid browser login response"))?;
    ensure!(
        ticket.code.len() == 64
            && ticket.code.bytes().all(|c| c.is_ascii_hexdigit())
            && (1..=60).contains(&ticket.expires_in),
        "invalid browser login response"
    );
    // 固定已校验的 loopback origin 和路径，不信任服务返回的跳转地址。
    url.set_path("/ui");
    url.set_fragment(Some(&format!("bootstrap={}", ticket.code)));
    Ok(url.into())
}

pub async fn rpc(service: &Service, method: &str, params: Value) -> Result<Value> {
    use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
    let mut request = service.endpoint.as_str().into_client_request()?;
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", token(service)?).parse()?,
    );
    timeout(Duration::from_secs(62), async {
        let (mut socket, _) = tokio_tungstenite::connect_async(request).await?;
        socket.send(Message::Text(json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"areal_service_host","version":env!("CARGO_PKG_VERSION")}}}).to_string().into())).await?;
        loop {
            let message = socket.next().await.context("Core disconnected during initialize")??;
            if let Message::Text(text) = message {
                let reply: Value = serde_json::from_str(&text)?;
                if reply["id"] == 1 {
                    ensure!(reply.get("result").is_some(), "Core initialization failed");
                    break;
                }
            }
        }
        socket.send(Message::Text(json!({"method":"initialized"}).to_string().into())).await?;
        socket.send(Message::Text(json!({"id":2,"method":method,"params":params}).to_string().into())).await?;
        while let Some(message) = socket.next().await {
            if let Message::Text(text) = message? {
                let reply: Value = serde_json::from_str(&text)?;
                if reply["id"] == 2 {
                    ensure!(reply.get("error").is_none(), "Core request failed: {}", reply["error"]);
                    return Ok(reply["result"].clone());
                }
            }
        }
        bail!("Core disconnected before replying")
    }).await?
}

pub async fn bind(root: &Path, workspace: &Path, data: &Path) -> Result<PathBuf> {
    let workspace = workspace.canonicalize()?;
    let data = data.canonicalize()?;
    ensure!(
        workspace.is_dir()
            && data.is_dir()
            && !data.starts_with(&workspace)
            && !root.starts_with(&workspace),
        "invalid workspace/data placement"
    );
    let lock = storage::open_private(&data.join("service.lock"), true)?;
    lock.try_lock_exclusive()
        .context("stop the service before binding its data")?;
    let directory = root.join("workspaces");
    storage::private_dir(&directory)?;
    let mapping = directory.join(format!(
        "{}.json",
        storage::digest(workspace.as_os_str().as_encoded_bytes())
    ));
    let mapping_lock = storage::open_private(&mapping.with_extension("lock"), true)?;
    mapping_lock
        .try_lock_exclusive()
        .context("another workspace binding is in progress")?;
    if mapping.exists() {
        ensure!(
            storage::read::<PathBuf>(&mapping)? == data,
            "workspace is already bound to another data directory"
        );
    }
    storage::bind_workspace(&data, &workspace)?;
    storage::write(&mapping, &data)?;
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn status_waits_for_startup_without_claiming_the_instance_lease() {
        let root = tempfile::tempdir_in("/tmp").unwrap();
        let id = "a".repeat(24);
        let directory = storage::registry(root.path(), &id).unwrap();
        storage::private_dir(&directory).unwrap();
        let data = root.path().join("data");
        storage::private_dir(&data).unwrap();
        let service = Service {
            owner: None,
            identity: Identity {
                protocol_version: VERSION,
                service_id: id.clone(),
                generation: "old-generation".into(),
                workspace: root.path().join("workspace"),
                data_dir: data.clone(),
                config_fingerprint: "fixture".into(),
            },
            endpoint: "ws://127.0.0.1:1".into(),
            web_url: "http://127.0.0.1:1/ui".into(),
            auth_file: data.join("auth.json"),
            log_file: directory.join("host.log"),
            core_pid: 1,
            host_pid: 2,
            state: State::Stopping,
        };
        storage::write(&directory.join("service.json"), &service).unwrap();
        let startup = startup_lock(&directory).await.unwrap();
        let mut pending = Box::pin(status(root.path(), &id));
        // 受控交错：新宿主尚未取得实例锁，status 必须等待启动门，不能抢锁。
        assert!(futures_util::poll!(pending.as_mut()).is_pending());
        let owner = storage::open_private(&data.join("service.lock"), true).unwrap();
        owner.try_lock_exclusive().unwrap();
        let listener = tokio::net::UnixListener::bind(directory.join("control.sock")).unwrap();
        let expected = service.clone();
        let host = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut line = String::new();
            BufReader::new(&mut socket)
                .read_line(&mut line)
                .await
                .unwrap();
            assert!(matches!(
                serde_json::from_str::<Request>(&line).unwrap(),
                Request::Status { .. }
            ));
            let mut bytes = serde_json::to_vec(&Response::Ok {
                service: Box::new(expected),
            })
            .unwrap();
            bytes.push(b'\n');
            socket.write_all(&bytes).await.unwrap();
        });
        drop(startup);
        let observed = timeout(Duration::from_secs(5), pending)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(observed.identity, service.identity);
        assert_eq!(observed.state, State::Stopping);
        assert!(!storage::available(&data.join("service.lock")).unwrap());
        host.await.unwrap();
    }

    #[tokio::test]
    async fn disconnected_control_is_unavailable_until_both_ownership_locks_release() {
        let root = tempfile::tempdir_in("/tmp").unwrap();
        let id = "b".repeat(24);
        let directory = storage::registry(root.path(), &id).unwrap();
        storage::private_dir(&directory).unwrap();
        let data = root.path().join("data");
        storage::private_dir(&data).unwrap();
        let service = Service {
            owner: None,
            identity: Identity {
                protocol_version: VERSION,
                service_id: id.clone(),
                generation: "original".into(),
                workspace: root.path().join("workspace"),
                data_dir: data.clone(),
                config_fingerprint: "fixture".into(),
            },
            endpoint: "ws://127.0.0.1:1".into(),
            web_url: "http://127.0.0.1:1/ui".into(),
            auth_file: data.join("auth.json"),
            log_file: directory.join("host.log"),
            core_pid: 1,
            host_pid: 2,
            state: State::Ready,
        };
        storage::write(&directory.join("service.json"), &service).unwrap();
        let lease = storage::open_private(&data.join("service.lock"), true).unwrap();
        lease.try_lock_exclusive().unwrap();
        let store = storage::open_private(&data.join("owner.lock"), true).unwrap();
        store.try_lock_exclusive().unwrap();
        assert_eq!(
            status(root.path(), &id).await.unwrap().state,
            State::Unavailable
        );
        let socket = directory.join("control.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        drop(listener);
        assert_eq!(
            status(root.path(), &id).await.unwrap().state,
            State::Unavailable
        );
        std::fs::remove_file(&socket).unwrap();
        for response in [
            "",
            "not-json",
            "{\"result\":\"error\",\"message\":\"disk failure\"}",
        ] {
            let listener = tokio::net::UnixListener::bind(&socket).unwrap();
            let response = response.to_owned();
            let disconnected = response.is_empty();
            let host = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut line = String::new();
                BufReader::new(&mut stream)
                    .read_line(&mut line)
                    .await
                    .unwrap();
                if !response.is_empty() {
                    stream.write_all(response.as_bytes()).await.unwrap();
                }
            });
            let observed = status(root.path(), &id).await;
            if disconnected {
                assert_eq!(observed.unwrap().state, State::Unavailable);
            } else {
                assert!(observed.is_err());
            }
            host.await.unwrap();
            std::fs::remove_file(&socket).unwrap();
        }
        drop(lease);
        assert_eq!(
            status(root.path(), &id).await.unwrap().state,
            State::Unavailable
        );
        drop(store);
        let observed = status(root.path(), &id).await.unwrap();
        assert_eq!(observed.state, State::Stopped);
        assert_eq!(observed.identity, service.identity);
        // 状态观察不补写 Host 的权威清理标记，恢复仍须另行核对它。
        assert_eq!(
            storage::read::<Service>(&directory.join("service.json"))
                .unwrap()
                .state,
            State::Ready
        );
        std::fs::remove_file(directory.join("service.json")).unwrap();
        assert!(status(root.path(), &id).await.is_err());
    }

    #[tokio::test]
    async fn ready_host_with_unreachable_core_is_unavailable_without_cleanup_authority() {
        for failure in [
            "connection-refused",
            "wrong-identity",
            "invalid-json",
            "unauthorized",
        ] {
            let root = tempfile::tempdir_in("/tmp").unwrap();
            let id = "c".repeat(24);
            let directory = storage::registry(root.path(), &id).unwrap();
            storage::private_dir(&directory).unwrap();
            let data = root.path().join("data");
            storage::private_dir(&data).unwrap();
            let core = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = core.local_addr().unwrap();
            let service = Service {
                owner: Some(areal_protocol::service::Owner::Gui {
                    app_run_id: "fixture".into(),
                    profile: root.path().join("profile"),
                }),
                identity: Identity {
                    protocol_version: VERSION,
                    service_id: id.clone(),
                    generation: "original".into(),
                    workspace: root.path().join("workspace"),
                    data_dir: data.clone(),
                    config_fingerprint: "fixture".into(),
                },
                endpoint: format!("ws://{address}"),
                web_url: format!("http://{address}/ui"),
                auth_file: data.join("auth.json"),
                log_file: directory.join("host.log"),
                core_pid: 1,
                host_pid: 2,
                state: State::Ready,
            };
            storage::write(&directory.join("service.json"), &service).unwrap();
            storage::write(
                &service.auth_file,
                &json!({"principals":[{"token":"fixture"}]}),
            )
            .unwrap();
            let lease = storage::open_private(&data.join("service.lock"), true).unwrap();
            lease.try_lock_exclusive().unwrap();
            let store = storage::open_private(&data.join("owner.lock"), true).unwrap();
            store.try_lock_exclusive().unwrap();
            let http = if failure == "connection-refused" {
                drop(core);
                None
            } else {
                let mut foreign = service.identity.clone();
                foreign.generation = "foreign".into();
                Some(tokio::spawn(async move {
                    let (mut stream, _) = core.accept().await.unwrap();
                    let mut request = BufReader::new(&mut stream);
                    loop {
                        let mut line = String::new();
                        request.read_line(&mut line).await.unwrap();
                        if line == "\r\n" {
                            break;
                        }
                    }
                    let (status, body) = match failure {
                        "wrong-identity" => ("200 OK", serde_json::to_string(&foreign).unwrap()),
                        "invalid-json" => ("200 OK", "not-json".into()),
                        _ => ("401 Unauthorized", "denied".into()),
                    };
                    stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                }))
            };
            let listener = tokio::net::UnixListener::bind(directory.join("control.sock")).unwrap();
            let expected = service.clone();
            let host = tokio::spawn(async move {
                for _ in 0..if failure == "connection-refused" {
                    2
                } else {
                    1
                } {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let mut line = String::new();
                    BufReader::new(&mut stream)
                        .read_line(&mut line)
                        .await
                        .unwrap();
                    assert!(matches!(
                        serde_json::from_str::<Request>(&line).unwrap(),
                        Request::Status { .. }
                    ));
                    let mut bytes = serde_json::to_vec(&Response::Ok {
                        service: Box::new(expected.clone()),
                    })
                    .unwrap();
                    bytes.push(b'\n');
                    stream.write_all(&bytes).await.unwrap();
                }
            });
            if failure == "connection-refused" {
                let observed = status(root.path(), &id).await.unwrap();
                assert_eq!(observed.state, State::Unavailable);
                assert_eq!(observed.identity, service.identity);
                let recovery = status_with_recovery(root.path(), &id).await.unwrap();
                assert!(!recovery.recovery.eligible);
                assert_eq!(recovery.recovery.reason, "cleanupUnconfirmed");
            } else {
                let error = status(root.path(), &id).await.unwrap_err();
                match failure {
                    "wrong-identity" => assert!(
                        error
                            .to_string()
                            .contains("Core identity/generation does not match the service record")
                    ),
                    "invalid-json" => assert!(
                        error
                            .downcast_ref::<reqwest::Error>()
                            .is_some_and(reqwest::Error::is_decode)
                    ),
                    _ => assert_eq!(
                        error.downcast_ref::<reqwest::Error>().unwrap().status(),
                        Some(reqwest::StatusCode::UNAUTHORIZED)
                    ),
                }
            }
            assert!(!storage::available(&data.join("service.lock")).unwrap());
            assert!(!storage::store_available(&data).unwrap());
            assert_eq!(
                storage::read::<Service>(&directory.join("service.json"))
                    .unwrap()
                    .state,
                State::Ready
            );
            assert!(!directory.join("crash.json").exists());
            assert!(!directory.join("replacement.json").exists());
            host.await.unwrap();
            if let Some(http) = http {
                http.await.unwrap();
            }
        }
    }

    #[test]
    fn model_restart_preserves_nonrecoverable_reload_errors() {
        for error in [
            "invalid TOML",
            "model configuration archive is full",
            "disk full",
        ] {
            let state = json!({"configuration":{"error":error,"restartRequired":false}});
            let diagnostic = check_model_restart(&state).unwrap_err().to_string();
            assert!(diagnostic.contains(error));
            assert!(diagnostic.contains("running service is unchanged"));
        }
        assert!(
            check_model_restart(&json!({"configuration":{
                "error":"missing credential", "restartRequired":true
            }}))
            .is_ok()
        );
        assert!(
            check_model_restart(&json!({"configuration":{
                "error":null, "restartRequired":false
            }}))
            .is_ok()
        );
    }
}
