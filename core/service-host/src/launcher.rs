//! 可信本地启动器；只管理独立 Core/Runtime 进程，不拥有其业务状态。
use anyhow::{Context, Result, bail, ensure};
use clap::Parser;
use std::{
    ffi::OsString,
    fs::{self, File},
    io::Read,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{process::Child, time::Instant};

#[derive(Parser)]
#[command(name = "areal launcher", disable_help_flag = false)]
struct Args {
    #[arg(long)]
    bin_dir: Option<PathBuf>,
    #[arg(long)]
    parent_pid: Option<u32>,
    #[arg(long)]
    lease_fd: Option<i32>,
    #[arg(long)]
    workspace: Option<PathBuf>,
    #[arg(long)]
    scratch: Option<PathBuf>,
    #[arg(long)]
    read_only_path: Vec<PathBuf>,
    #[arg(long)]
    allow_write: bool,
    #[arg(long)]
    task_credential_command: Vec<PathBuf>,
    #[arg(long, default_value_t = 4, value_parser = clap::value_parser!(u32).range(1..))]
    runtime_max_processes: u32,
    #[arg(long, default_value_t = 256)]
    runtime_max_scopes: u32,
    #[arg(long, default_value_t = 4096, value_parser = clap::value_parser!(u32).range(1..))]
    runtime_max_operations: u32,
    #[arg(long)]
    workgroup_policy: Option<PathBuf>,
    #[arg(long)]
    workgroup_toolchain: Option<PathBuf>,
    #[arg(long)]
    allow_network: bool,
    #[arg(long)]
    allow_concurrent_writes: bool,
    #[arg(long, default_value_t = 300_000)]
    command_timeout_ms: u64,
    #[arg(long)]
    desktop_process_timeout_ms: Option<u64>,
    #[arg(long, default_value_t = 8 * 1024 * 1024)]
    command_output_bytes: u64,
    #[arg(long)]
    runtime_output_bytes: Option<u64>,
    #[arg(long, default_value = "full-access", value_parser = ["native", "outer-container-perf", "full-access"])]
    sandbox_profile: String,
    #[arg(long)]
    permissions: Option<String>,
    #[arg(long)]
    config: Option<PathBuf>,
    #[arg(long)]
    data_dir: Option<PathBuf>,
    #[arg(long)]
    listen: Option<String>,
    #[arg(long)]
    model_endpoint: Option<String>,
    #[arg(long)]
    model: Option<String>,
    #[arg(long)]
    model_provider: Option<String>,
    #[arg(long)]
    model_protocol: Option<String>,
    #[arg(long)]
    api_key_env: Option<String>,
    #[arg(long)]
    model_concurrency: Option<String>,
    #[arg(long)]
    max_threads: Option<String>,
    #[arg(long)]
    log_filter: Option<String>,
    #[arg(long)]
    max_active_turns: Option<String>,
    #[arg(long)]
    max_children_per_turn: Option<String>,
    #[arg(long)]
    max_agent_depth: Option<String>,
    #[arg(long)]
    management: bool,
    #[arg(long)]
    no_deployment_mcp: bool,
    #[arg(long)]
    tui: bool,
    #[arg(long)]
    desktop: bool,
    #[arg(long)]
    ready_file: Option<PathBuf>,
    #[arg(long)]
    ready_metadata_file: Option<PathBuf>,
    #[arg(long)]
    auth_file: Option<PathBuf>,
    #[arg(long)]
    desktop_config: Option<PathBuf>,
    #[arg(long)]
    agent: Option<String>,
    #[arg(long)]
    service_info: Option<PathBuf>,
    #[arg(long, default_value_t = 30.0)]
    startup_timeout: f64,
    #[arg(long)]
    resume: Option<String>,
    #[arg(long)]
    initial_prompt: Option<String>,
    #[arg(long)]
    prompt: Option<String>,
    #[arg(long)]
    goal: Option<String>,
    #[arg(long)]
    goal_token_budget: Option<u64>,
    #[arg(long)]
    input_file: Option<PathBuf>,
    #[arg(long, requires = "input_file")]
    input_error_file: Option<PathBuf>,
    #[arg(long)]
    theme: Option<String>,
    #[arg(long)]
    color: Option<String>,
    #[arg(long)]
    tui_config: Option<PathBuf>,
    #[arg(long, num_args = 0..=1, default_missing_value = "true")]
    no_logo: Option<bool>,
    #[arg(long, num_args = 0..=1, default_missing_value = "true")]
    ascii: Option<bool>,
    #[arg(long, num_args = 0..=1, default_missing_value = "true")]
    mouse: Option<bool>,
}

impl Args {
    fn validate(&mut self) -> Result<()> {
        ensure!(
            !(self.desktop && self.tui),
            "--desktop and --tui are mutually exclusive"
        );
        ensure!(
            self.desktop_process_timeout_ms
                .is_none_or(|ms| self.desktop && (1..=86_400_000).contains(&ms)),
            "desktop process timeout requires --desktop and must be 1..86400000 ms"
        );
        ensure!(
            self.startup_timeout > 0.0 && self.startup_timeout <= 300.0,
            "startup timeout must be 0..300 seconds"
        );
        ensure!(
            (1..=86_400_000).contains(&self.command_timeout_ms)
                && (1..=64 * 1024 * 1024).contains(&self.command_output_bytes),
            "command timeout or output budget out of range"
        );
        ensure!(
            self.runtime_output_bytes.is_none_or(
                |value| value >= self.command_output_bytes && value <= 16 * 1024 * 1024 * 1024
            ),
            "runtime output budget must cover one command and be at most 16 GiB"
        );
        ensure!(
            self.tui || self.workspace.is_some(),
            "--workspace is required without --tui"
        );
        ensure!(
            self.tui
                || [
                    self.resume.is_some(),
                    self.prompt.is_some(),
                    self.initial_prompt.is_some(),
                    self.goal.is_some(),
                    self.input_file.is_some()
                ]
                .iter()
                .all(|v| !v),
            "client arguments require --tui"
        );
        ensure!(
            self.goal_token_budget
                .is_none_or(|v| self.goal.is_some() && v > 0),
            "--goal-token-budget requires --goal and a positive integer"
        );
        ensure!(
            self.tui
                || (self.theme.is_none()
                    && self.color.is_none()
                    && self.tui_config.is_none()
                    && self.no_logo.is_none()
                    && self.ascii.is_none()
                    && self.mouse.is_none()),
            "client appearance options require --tui"
        );
        ensure!(
            self.workgroup_toolchain.is_none() || self.workgroup_policy.is_some(),
            "--workgroup-toolchain requires --workgroup-policy"
        );
        ensure!(
            [&self.ready_file, &self.ready_metadata_file]
                .into_iter()
                .flatten()
                .all(|p| !p.exists()),
            "ready output already exists"
        );
        if self.sandbox_profile == "full-access" {
            self.allow_write = true;
            self.allow_network = true;
        }
        if (self.tui || self.desktop) && self.listen.is_none() {
            self.listen = Some("127.0.0.1:0".into());
        }
        ensure!(
            self.workgroup_policy.is_none() || self.allow_write,
            "--workgroup-policy requires --allow-write"
        );
        Ok(())
    }

    fn core_overrides(&self) -> Vec<OsString> {
        let mut out = Vec::new();
        for (name, value) in [
            ("permissions", self.permissions.as_ref().map(OsString::from)),
            (
                "config",
                self.config.as_ref().map(|p| p.as_os_str().to_owned()),
            ),
            (
                "data-dir",
                self.data_dir.as_ref().map(|p| p.as_os_str().to_owned()),
            ),
            ("listen", self.listen.as_ref().map(OsString::from)),
        ] {
            if let Some(value) = value {
                out.extend([format!("--{name}").into(), value]);
            }
        }
        for (name, value) in [
            ("model-endpoint", self.model_endpoint.as_deref()),
            ("model", self.model.as_deref()),
            ("model-provider", self.model_provider.as_deref()),
            ("model-protocol", self.model_protocol.as_deref()),
            ("api-key-env", self.api_key_env.as_deref()),
            ("model-concurrency", self.model_concurrency.as_deref()),
            ("max-threads", self.max_threads.as_deref()),
            ("log-filter", self.log_filter.as_deref()),
            ("max-active-turns", self.max_active_turns.as_deref()),
            (
                "max-children-per-turn",
                self.max_children_per_turn.as_deref(),
            ),
            ("max-agent-depth", self.max_agent_depth.as_deref()),
        ] {
            if let Some(value) = value {
                out.extend([format!("--{name}").into(), value.into()]);
            }
        }
        if self.management || self.desktop {
            out.push("--management".into());
        }
        if self.no_deployment_mcp {
            out.push("--no-deployment-mcp".into());
        }
        out
    }
}

fn push_option(
    command: &mut tokio::process::Command,
    flag: &str,
    value: Option<impl AsRef<std::ffi::OsStr>>,
) {
    if let Some(value) = value {
        command.arg(flag).arg(value);
    }
}

fn runtime_env(command: &mut tokio::process::Command, credentials: bool) {
    command.env_clear();
    for name in ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    if credentials {
        for name in [
            "MULTICA_TOKEN",
            "MULTICA_TASK_ID",
            "MULTICA_AGENT_ID",
            "MULTICA_WORKSPACE_ID",
            "MULTICA_SERVER_URL",
            "MULTICA_RUNTIME_PROVIDER",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
    }
}

fn pipe() -> Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0; 2];
    ensure!(
        unsafe { libc::pipe(fds.as_mut_ptr()) } == 0,
        "create launcher pipe: {}",
        std::io::Error::last_os_error()
    );
    let read = unsafe { OwnedFd::from_raw_fd(fds[0]) };
    let write = unsafe { OwnedFd::from_raw_fd(fds[1]) };
    for fd in [&read, &write] {
        ensure!(
            unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } >= 0,
            "set launcher pipe close-on-exec: {}",
            std::io::Error::last_os_error()
        );
    }
    Ok((read, write))
}

async fn finish(
    child: &mut Child,
    seconds: u64,
    terminate: bool,
    process_group: bool,
) -> Result<std::process::ExitStatus> {
    if terminate && child.try_wait()?.is_none() {
        unsafe {
            libc::kill(
                child.id().context("missing child pid")? as i32,
                libc::SIGTERM,
            );
        }
    }
    match tokio::time::timeout(Duration::from_secs(seconds), child.wait()).await {
        Ok(result) => Ok(result?),
        Err(_) => {
            if process_group {
                // 仅信号当前尚未回收的中转进程组；不能留下 Runtime 后释放实例锁。
                if let Some(pid) = child.id()
                    && unsafe { libc::kill(-(pid as i32), libc::SIGKILL) } != 0
                {
                    let error = std::io::Error::last_os_error();
                    if error.raw_os_error() != Some(libc::ESRCH) {
                        return Err(error).context("kill Runtime process group");
                    }
                }
            } else {
                child.start_kill()?;
            }
            Ok(child.wait().await?)
        }
    }
}

struct Terminal(Option<libc::termios>, bool);

impl Terminal {
    fn capture(args: &Args) -> Self {
        if !args.tui || unsafe { libc::isatty(libc::STDIN_FILENO) } != 1 {
            return Self(None, false);
        }
        let mut saved = std::mem::MaybeUninit::uninit();
        let state = if unsafe { libc::tcgetattr(libc::STDIN_FILENO, saved.as_mut_ptr()) } == 0 {
            Some(unsafe { saved.assume_init() })
        } else {
            None
        };
        Self(
            state,
            args.prompt.is_none() && args.goal.is_none() && args.input_file.is_none(),
        )
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        if let Some(state) = &self.0 {
            unsafe {
                libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, state);
            }
            if self.1 {
                eprint!("\x1b[?1049l\x1b[?25h");
            }
        }
    }
}

async fn preflight(args: &Args) -> Result<(PathBuf, PathBuf, PathBuf)> {
    let binary = binary(args)?;
    let workspace = args
        .workspace
        .as_ref()
        .map_or_else(std::env::current_dir, |p| Ok(p.clone()))?
        .canonicalize()?;
    ensure!(workspace.is_dir(), "workspace must be a directory");
    let mut check = tokio::process::Command::new(&binary);
    check.args(["config", "show"]).args(args.core_overrides());
    let output = check
        .output()
        .await
        .context("preflight Core configuration")?;
    ensure!(
        output.status.success(),
        "Core configuration failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let config: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    let data = config["server"]["data_dir"]
        .as_str()
        .context("missing Core data directory")?;
    let data = areal_local_service::storage::canonical_pending(Path::new(data))?;
    ensure!(
        !data.starts_with(&workspace),
        "Core data must be outside the execution workspace"
    );
    Ok((binary, workspace, data))
}

pub async fn run(args: Vec<OsString>) -> Result<()> {
    let mut args =
        Args::try_parse_from(std::iter::once(OsString::from("areal launcher")).chain(args))?;
    args.validate()?;
    if let Some(fd) = args.lease_fd {
        // 宿主持有锁；launcher 继承一份，但其子进程不得继续继承。
        ensure!(
            unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } >= 0,
            "invalid service lease fd"
        );
    }
    let (binary, workspace, data) = preflight(&args).await?;
    let mut log_lease = None;
    let log = if args.tui || args.desktop {
        fs::create_dir_all(&data)?;
        let (log, lease) = super::retention::create_log(&data)?;
        log_lease = Some(lease);
        if super::retention::logs(&data).is_err() {
            eprintln!("Could not clean retained launcher logs");
        }
        eprintln!(
            "Local Harness: {}\nService log: {}",
            workspace.display(),
            log.display()
        );
        Some(log)
    } else {
        None
    };
    let result = launch(&args, &binary, &workspace, &data, log.as_deref()).await;
    if let Err(error) = &result {
        eprintln!(
            "{}",
            serde_json::json!({"state":"failed","reason":format!("{error:#}"),"logFile":log})
        );
        if let Some(path) = &log {
            let mut file = File::open(path)?;
            let length = file.metadata()?.len();
            use std::io::{Seek, SeekFrom};
            file.seek(SeekFrom::Start(length.saturating_sub(32_768)))?;
            let mut tail = Vec::new();
            file.read_to_end(&mut tail)?;
            eprintln!("{}", String::from_utf8_lossy(&tail));
        }
    }
    drop(log_lease);
    if log.is_some() && super::retention::logs(&data).is_err() {
        eprintln!("Could not clean retained launcher logs");
    }
    result
}

fn binary(args: &Args) -> Result<PathBuf> {
    Ok(args
        .bin_dir
        .as_ref()
        .map_or_else(std::env::current_exe, |p| Ok(p.join("areal")))?
        .canonicalize()?)
}

async fn launch(
    args: &Args,
    binary: &Path,
    workspace: &Path,
    data: &Path,
    log: Option<&Path>,
) -> Result<()> {
    #[cfg(target_os = "macos")]
    check_system_python().await?;
    let bin_dir = binary.parent().context("missing executable directory")?;
    let runtime_bin = areal_local_service::runtime_bin_dir(bin_dir);
    let runtime = runtime_bin.join("areal-runtime");
    let helper = runtime_bin.join("areal-runtime-fs");
    for path in [binary, runtime.as_path(), helper.as_path()] {
        ensure!(
            path.is_file(),
            "executable missing: {}; run make build",
            path.display()
        );
    }
    if cfg!(target_os = "linux") {
        ensure!(
            runtime_bin.join("areal-runtime-reaper").is_file(),
            "missing runtime reaper; run make build"
        );
    }
    let overrides = args.core_overrides();
    let scratch = if let Some(scratch) = &args.scratch {
        scratch.canonicalize()?
    } else {
        let scratch = data
            .parent()
            .context("missing data parent")?
            .join("scratch");
        fs::create_dir_all(&scratch)?;
        scratch.canonicalize()?
    };
    ensure!(
        scratch.is_dir()
            && !scratch.starts_with(workspace)
            && !workspace.starts_with(&scratch)
            && !scratch.starts_with(data)
            && !data.starts_with(&scratch),
        "scratch must be an existing directory disjoint from workspace and Core data"
    );
    if args.sandbox_profile != "full-access" {
        for path in [binary, &runtime, &helper] {
            let path = path.canonicalize()?;
            ensure!(
                !(path.starts_with(&scratch) || args.allow_write && path.starts_with(workspace)),
                "trusted binaries must exist outside the writable workspace and scratch"
            );
        }
    }
    let (temporary, _state_lease) =
        super::retention::launcher_state(data).context("create launcher state")?;
    let ready = args
        .ready_file
        .clone()
        .unwrap_or_else(|| temporary.path().join("ready"));
    let metadata = args
        .ready_metadata_file
        .clone()
        .unwrap_or_else(|| temporary.path().join("ready.json"));
    let (request_read, request_write) = pipe()?;
    let (response_read, response_write) = pipe()?;
    let (supervisor, keepalive) = pipe()?;
    let supervisor_fd = supervisor.as_raw_fd();
    let diagnostic = log
        .map(|path| File::options().append(true).open(path))
        .transpose()?;
    let stderr = |file: &Option<File>| -> Result<Stdio> {
        match file {
            Some(file) => Ok(Stdio::from(file.try_clone()?)),
            None => Ok(Stdio::inherit()),
        }
    };
    // 沿用现有 macOS Runtime 中转方式，避免 AMFI 在进入 main 前拒绝本地二进制。
    // Python 等待 Runtime，二者共享独立进程组；Core 仍直接启动并拥有原生命周期管道。
    #[cfg(target_os = "macos")]
    let mut runtime_command = {
        let mut command = tokio::process::Command::new("/usr/bin/python3");
        command.args(["-I", "-S", "-c", "import subprocess,sys; p=subprocess.run(sys.argv[1:]); sys.exit(p.returncode if p.returncode>=0 else 128-p.returncode)"]);
        command.arg(&runtime).process_group(0);
        command
    };
    #[cfg(not(target_os = "macos"))]
    let mut runtime_command = tokio::process::Command::new(&runtime);
    runtime_command
        .arg("--workspace")
        .arg(workspace)
        .arg("--scratch")
        .arg(&scratch)
        .arg("--file-helper")
        .arg(&helper)
        .args([
            "--wall-time-ms",
            &args
                .command_timeout_ms
                .max(args.desktop_process_timeout_ms.unwrap_or(0))
                .to_string(),
        ])
        .args(["--output-bytes", &args.command_output_bytes.to_string()])
        .args(["--max-processes", &args.runtime_max_processes.to_string()])
        .args(["--max-scopes", &args.runtime_max_scopes.to_string()])
        .args(["--max-operations", &args.runtime_max_operations.to_string()])
        .args([
            "--output-window-bytes",
            &args.command_output_bytes.min(8 * 1024 * 1024).to_string(),
        ])
        .args(["--sandbox-profile", &args.sandbox_profile]);
    push_option(
        &mut runtime_command,
        "--cumulative-output-bytes",
        args.runtime_output_bytes.map(|v| v.to_string()),
    );
    for path in &args.task_credential_command {
        runtime_command.arg("--task-credential-command").arg(path);
    }
    for path in &args.read_only_path {
        runtime_command.arg("--read-only-path").arg(path);
    }
    for (flag, enabled) in [
        ("--allow-network", args.allow_network),
        ("--allow-concurrent-writes", args.allow_concurrent_writes),
        ("--allow-write", args.allow_write),
    ] {
        if enabled {
            runtime_command.arg(flag);
        }
    }
    runtime_env(
        &mut runtime_command,
        !args.task_credential_command.is_empty(),
    );
    runtime_command
        .stdin(Stdio::from(request_read))
        .stdout(Stdio::from(response_write))
        .stderr(stderr(&diagnostic)?);
    let mut runtime_child = runtime_command.spawn().context("start Runtime")?;
    drop(runtime_command);
    eprintln!(
        "AReaL launcher {} PID: {}",
        if cfg!(target_os = "macos") {
            "Runtime supervisor"
        } else {
            "Runtime"
        },
        runtime_child.id().unwrap_or_default()
    );
    let mut core_command = tokio::process::Command::new(binary);
    core_command
        .arg("app-server")
        .arg("--runtime-stdio")
        .arg("--supervisor-fd")
        .arg(supervisor_fd.to_string())
        .arg("--workspace")
        .arg(workspace)
        .arg("--command-scratch")
        .arg(&scratch)
        .args(&overrides)
        .arg("--ready-file")
        .arg(&ready)
        .arg("--ready-metadata-file")
        .arg(&metadata);
    if args.desktop_process_timeout_ms.is_some() {
        core_command
            .arg("--command-timeout-ms")
            .arg(args.command_timeout_ms.to_string());
    }
    push_option(
        &mut core_command,
        "--service-info",
        args.service_info.as_ref(),
    );
    push_option(
        &mut core_command,
        "--workgroup-policy",
        args.workgroup_policy.as_ref(),
    );
    push_option(
        &mut core_command,
        "--workgroup-toolchain",
        args.workgroup_toolchain.as_ref(),
    );
    push_option(&mut core_command, "--auth-file", args.auth_file.as_ref());
    push_option(
        &mut core_command,
        "--desktop-config",
        args.desktop_config.as_ref(),
    );
    if args.allow_write {
        core_command.arg("--allow-write");
    }
    core_command
        .stdin(Stdio::from(response_read))
        .stdout(Stdio::from(request_write))
        .stderr(stderr(&diagnostic)?);
    // Core 必须继承专用生命周期描述符；父端由 launcher 持有至退出。
    unsafe {
        core_command.pre_exec(move || {
            if libc::fcntl(supervisor_fd, libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let started_core = core_command.spawn();
    drop(core_command);
    match started_core {
        Ok(mut core_child) => {
            drop(supervisor);
            eprintln!(
                "AReaL launcher Core PID: {}",
                core_child.id().unwrap_or_default()
            );
            let result = supervise(
                args,
                binary,
                &ready,
                &metadata,
                log,
                &mut core_child,
                &mut runtime_child,
            )
            .await;
            let core_status = finish(&mut core_child, 15, true, false).await;
            let runtime_status =
                finish(&mut runtime_child, 20, false, cfg!(target_os = "macos")).await;
            drop(keepalive);
            if let Some(path) = &args.ready_file {
                let _ = fs::remove_file(path);
            }
            if let Some(path) = &args.ready_metadata_file {
                let _ = fs::remove_file(path);
            }
            let cancelled_during_startup = result?;
            let core_status = core_status?;
            let runtime_status = runtime_status?;
            ensure!(
                cancelled_during_startup || (core_status.success() && runtime_status.success()),
                "Core cleanup exited {core_status}; Runtime cleanup exited {runtime_status}"
            );
            Ok(())
        }
        Err(error) => {
            let _ = finish(&mut runtime_child, 20, false, cfg!(target_os = "macos")).await;
            Err(error).context("start Core")
        }
    }
}

#[cfg(target_os = "macos")]
async fn check_system_python() -> Result<()> {
    const REQUIRED: &str = "macOS Runtime requires a working /usr/bin/python3; install Xcode Command Line Tools (xcode-select --install) and retry";
    let mut child = tokio::process::Command::new("/usr/bin/python3")
        .args(["-I", "-S", "-c", "import subprocess,sys"])
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context(REQUIRED)?;
    match tokio::time::timeout(Duration::from_secs(10), child.wait()).await {
        Ok(status) => ensure!(status.context(REQUIRED)?.success(), REQUIRED),
        Err(_) => {
            child
                .kill()
                .await
                .context("reap timed-out Python preflight")?;
            bail!("{REQUIRED}; availability check timed out");
        }
    }
    Ok(())
}

async fn supervise(
    args: &Args,
    binary: &Path,
    ready: &Path,
    metadata: &Path,
    log: Option<&Path>,
    core: &mut Child,
    runtime: &mut Child,
) -> Result<bool> {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    let deadline = Instant::now() + Duration::from_secs_f64(args.startup_timeout);
    let mut last_log_cleanup = Instant::now();
    while !(ready.exists() && metadata.exists()) {
        if let Some(status) = core.try_wait()? {
            bail!("Core stopped before becoming ready: {status}");
        }
        if let Some(status) = runtime.try_wait()? {
            bail!("Runtime stopped before becoming ready: {status}");
        }
        ensure!(Instant::now() < deadline, "local Harness startup timed out");
        if !owner_alive(args.parent_pid) {
            return Ok(true);
        }
        tokio::select! { _ = terminate.recv() => return Ok(true), _ = interrupt.recv() => return Ok(true), _ = tokio::time::sleep(Duration::from_millis(50)) => {} }
        bound_log(log);
        if last_log_cleanup.elapsed() >= Duration::from_secs(60) {
            if let Some(path) = log {
                let _ = super::retention::logs(path.parent().unwrap());
            }
            last_log_cleanup = Instant::now();
        }
    }
    let _terminal = Terminal::capture(args);
    let mut tui = if args.tui {
        let meta: serde_json::Value = serde_json::from_slice(&fs::read(metadata)?)?;
        let mut command = tokio::process::Command::new(binary);
        command
            .arg("--endpoint")
            .arg(fs::read_to_string(ready)?)
            .arg("--auth-file")
            .arg(meta["authFile"].as_str().context("missing authFile")?);
        for (flag, value) in [
            ("--resume", args.resume.as_deref()),
            ("--agent", args.agent.as_deref()),
            ("--prompt", args.prompt.as_deref()),
            ("--goal", args.goal.as_deref()),
            ("--theme", args.theme.as_deref()),
            ("--color", args.color.as_deref()),
        ] {
            if let Some(value) = value {
                command.arg(format!("{flag}={value}"));
            }
        }
        push_option(
            &mut command,
            "--goal-token-budget",
            args.goal_token_budget.map(|v| v.to_string()),
        );
        push_option(&mut command, "--tui-config", args.tui_config.as_ref());
        push_option(&mut command, "--input-file", args.input_file.as_ref());
        push_option(
            &mut command,
            "--input-error-file",
            args.input_error_file.as_ref(),
        );
        for (flag, value) in [
            ("--no-logo", args.no_logo),
            ("--ascii", args.ascii),
            ("--mouse", args.mouse),
        ] {
            if let Some(value) = value {
                command.arg(format!("{flag}={value}"));
            }
        }
        if let Some(value) = &args.initial_prompt {
            command.arg("--").arg(value);
        }
        Some(command.spawn().context("start TUI")?)
    } else {
        None
    };
    loop {
        let tui_exited = match tui.as_mut() {
            Some(child) => child.try_wait()?.is_some(),
            None => false,
        };
        if core.try_wait()?.is_some() || runtime.try_wait()?.is_some() || tui_exited {
            break;
        }
        if !owner_alive(args.parent_pid) {
            break;
        }
        tokio::select! { _ = terminate.recv() => break, _ = interrupt.recv() => break, _ = tokio::time::sleep(Duration::from_millis(50)) => {} }
        bound_log(log);
        if last_log_cleanup.elapsed() >= Duration::from_secs(60) {
            if let Some(path) = log {
                let _ = super::retention::logs(path.parent().unwrap());
            }
            last_log_cleanup = Instant::now();
        }
    }
    if let Some(mut child) = tui {
        let status = finish(&mut child, 10, true, false).await?;
        ensure!(status.success(), "TUI exited with {status}");
    }
    Ok(false)
}

fn bound_log(path: Option<&Path>) {
    if let Some(path) = path {
        super::retention::bound_log(path);
    }
}

fn owner_alive(pid: Option<u32>) -> bool {
    pid.is_none_or(|pid| unsafe { libc::getppid() } as u32 == pid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_overrides_are_forwarded_without_promoting_defaults() {
        let mut args = Args::try_parse_from([
            "areal launcher",
            "--tui",
            "--config",
            "chosen.toml",
            "--model",
            "explicit",
            "--theme",
            "light",
            "--mouse=false",
        ])
        .unwrap();
        args.validate().unwrap();
        let forwarded: Vec<_> = args
            .core_overrides()
            .iter()
            .map(|s| s.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            forwarded,
            [
                "--config",
                "chosen.toml",
                "--listen",
                "127.0.0.1:0",
                "--model",
                "explicit"
            ]
        );
    }

    #[test]
    fn invalid_runtime_budgets_fail_before_startup() {
        for extra in [
            ["--runtime-output-bytes", "1"],
            ["--runtime-output-bytes", "17179869185"],
            ["--command-timeout-ms", "0"],
        ] {
            let mut args = Args::try_parse_from(
                ["areal launcher", "--workspace", "/tmp"]
                    .into_iter()
                    .chain(extra),
            )
            .unwrap();
            assert!(args.validate().is_err());
        }
    }
}
