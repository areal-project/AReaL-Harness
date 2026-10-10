use anyhow::{Context, Result};
use areal_runtime::components::RuntimeHost;
use areal_runtime_exec_native::SandboxProfile;
use areal_runtime_supervisor::Config;
use clap::Parser;
use std::path::PathBuf;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, Default, clap::ValueEnum)]
enum SandboxProfileArg {
    #[default]
    Native,
    FullAccess,
    OuterContainerPerf,
}

impl From<SandboxProfileArg> for SandboxProfile {
    fn from(value: SandboxProfileArg) -> Self {
        match value {
            SandboxProfileArg::Native => Self::Native,
            SandboxProfileArg::FullAccess => Self::FullAccess,
            SandboxProfileArg::OuterContainerPerf => Self::OuterContainerPerf,
        }
    }
}

#[derive(Parser)]
#[command(version, about = "AReaL-Harness attached Runtime over private stdio")]
struct Args {
    /// 固定映射为 workspace://repo 的执行端目录。
    #[arg(long)]
    workspace: PathBuf,
    /// Task scratch outside the workspace; exposes workspace://scratch.
    #[arg(long)]
    scratch: Option<PathBuf>,
    /// 固定保护公开输入目录；full-access 也执行 OS 只读隔离。
    #[arg(long)]
    read_only_path: Vec<PathBuf>,
    #[arg(long)]
    task_credential_command: Vec<PathBuf>,
    #[arg(long, default_value_t = 256)]
    max_scopes: usize,
    #[arg(long, default_value_t = 4096)]
    max_operations: usize,
    /// 部署入口授予工作区写权限；省略时只读。
    #[arg(long)]
    allow_write: bool,
    /// Explicitly inherit the deployment network; child scopes may still deny it.
    #[arg(long)]
    allow_network: bool,
    /// Permit overlapping workspace commands; conflicting file helpers still serialize.
    #[arg(long)]
    allow_concurrent_writes: bool,
    /// Fixed file helper binary; defaults to areal-runtime-fs beside this daemon.
    #[arg(long)]
    file_helper: Option<PathBuf>,
    #[arg(long, default_value_t = 4)]
    max_processes: usize,
    #[arg(long, default_value_t = 30_000)]
    wall_time_ms: u64,
    #[arg(long, default_value_t = 8 * 1024 * 1024)]
    output_bytes: u64,
    /// 独立的部署累计输出预算；省略时保持原来的单命令/累计共用上限。
    #[arg(long)]
    cumulative_output_bytes: Option<u64>,
    #[arg(long, default_value_t = 64 * 1024)]
    output_window_bytes: usize,
    /// Docker perf only: use Bubblewrap inside the runner container.
    #[arg(long, value_enum, default_value_t)]
    sandbox_profile: SandboxProfileArg,
}
#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let workspace = args
        .workspace
        .canonicalize()
        .context("workspace must exist")?;
    anyhow::ensure!(workspace.is_dir(), "workspace must be a directory");
    let mut config = Config::read_only(workspace);
    config.scratch = args.scratch;
    config.read_only_paths = args.read_only_path;
    config.full_access = matches!(args.sandbox_profile, SandboxProfileArg::FullAccess);
    config.writable = args.allow_write || config.full_access;
    config.max_scopes = args.max_scopes;
    config.max_operations = args.max_operations;
    for path in args.task_credential_command {
        let path = path.canonicalize()?;
        anyhow::ensure!(
            path.is_file() && !path.starts_with(&config.workspace),
            "task credential executable must be outside the workspace"
        );
        config.task_credential_commands.push(path);
    }
    if !config.task_credential_commands.is_empty() {
        for name in [
            "MULTICA_TOKEN",
            "MULTICA_TASK_ID",
            "MULTICA_AGENT_ID",
            "MULTICA_WORKSPACE_ID",
            "MULTICA_SERVER_URL",
            "MULTICA_RUNTIME_PROVIDER",
        ] {
            if let Ok(value) = std::env::var(name) {
                anyhow::ensure!(
                    value.len() <= 4096 && !value.contains('\0'),
                    "invalid task environment value"
                );
                config.task_environment.insert(name.into(), value);
            }
        }
    }
    config.allow_network = args.allow_network || config.full_access;
    config.concurrent_writes = args.allow_concurrent_writes;
    config.output_window_bytes = args.output_window_bytes;
    let helper = match args.file_helper {
        Some(path) => {
            anyhow::ensure!(path.is_file(), "--file-helper must name an existing binary");
            Some(path)
        }
        None => {
            let path = std::env::current_exe()?.with_file_name("areal-runtime-fs");
            path.is_file().then_some(path)
        }
    };
    config.file_helper = helper.map(|path| path.canonicalize()).transpose()?;
    if !config.full_access {
        let mut trusted = vec![std::env::current_exe()?.canonicalize()?];
        trusted.extend(config.file_helper.clone());
        let scratch = config
            .scratch
            .as_ref()
            .map(|p| p.canonicalize())
            .transpose()?;
        anyhow::ensure!(
            trusted.iter().all(
                |path| (!config.writable || !path.starts_with(&config.workspace))
                    && scratch.as_ref().is_none_or(|root| !path.starts_with(root))
            ),
            "trusted executables must be outside writable workspace and scratch"
        );
    }
    config.limits.max_processes = args.max_processes;
    config.limits.wall_time_ms = args.wall_time_ms;
    config.limits.output_bytes = args.output_bytes;
    config.cumulative_output_bytes = args.cumulative_output_bytes;
    #[cfg(unix)]
    let (read, write) = {
        use std::os::fd::AsFd;
        use tokio::net::unix::pipe::{Receiver, Sender};
        // tokio::io::stdin/stdout use blocking pool jobs which cannot be
        // cancelled. A pending read or a full output pipe would hang shutdown.
        (
            Receiver::from_owned_fd(std::io::stdin().as_fd().try_clone_to_owned()?)
                .context("Runtime stdin must be an inherited pipe")?,
            Sender::from_owned_fd(std::io::stdout().as_fd().try_clone_to_owned()?)
                .context("Runtime stdout must be an inherited pipe")?,
        )
    };
    #[cfg(not(unix))]
    let (read, write) = (tokio::io::stdin(), tokio::io::stdout());
    let stop = CancellationToken::new();
    let signal = stop.clone();
    // Install handlers before starting the executor. A stop during startup must
    // wait for owned initialization/rollback, not terminate the host midway.
    #[cfg(unix)]
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    #[cfg(unix)]
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    let signal_task = tokio::spawn(async move {
        #[cfg(unix)]
        {
            tokio::select! { _ = interrupt.recv() => {}, _ = term.recv() => {} }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
        signal.cancel();
    });
    let result: Result<()> = async {
        let runtime = RuntimeHost::launch_with_profile(config, args.sandbox_profile.into()).await?;
        areal_runtime::serve(read, write, runtime, stop).await?;
        Ok(())
    }
    .await;
    signal_task.abort();
    let _ = signal_task.await;
    result
}
