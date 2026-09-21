use anyhow::{Context, Result};
use areal_config::{
    ConfigInputs, ConfigOverrides, ModelProtocolConfig, ResolvedCoreConfig, load_config,
};
use areal_engine::{
    Engine, Limits,
    model::{HttpModel, ModelOptions, ModelProtocol},
};
use clap::{Parser, Subcommand};
use std::{path::PathBuf, sync::Arc};

mod telemetry;
mod tool_extensions;

#[derive(clap::Args, Default)]
struct ConfigArgs {
    #[arg(long, global = true)]
    config: Option<PathBuf>,
    /// 无模型时仍启动经过认证的管理入口。
    #[arg(long, global = true)]
    management: bool,
    #[arg(long, global = true)]
    no_deployment_mcp: bool,
    #[arg(long, global = true)]
    listen: Option<String>,
    #[arg(long, global = true)]
    data_dir: Option<PathBuf>,
    #[arg(long, global = true)]
    model_endpoint: Option<String>,
    #[arg(long, global = true)]
    model: Option<String>,
    #[arg(long, global = true)]
    model_provider: Option<String>,
    #[arg(long, global = true)]
    model_protocol: Option<String>,
    #[arg(long, global = true)]
    api_key_env: Option<String>,
    #[arg(long, global = true)]
    model_concurrency: Option<String>,
    #[arg(long, global = true)]
    max_threads: Option<String>,
    #[arg(long, global = true)]
    max_active_turns: Option<String>,
    #[arg(long, global = true)]
    max_children_per_turn: Option<String>,
    #[arg(long, global = true)]
    max_agent_depth: Option<String>,
    #[arg(long, global = true)]
    log_filter: Option<String>,
}

#[derive(Subcommand)]
enum Command {
    /// Inspect configuration without starting services or writing state.
    Config {
        #[command(subcommand)]
        command: ConfigCommand,
    },
}

#[derive(Subcommand)]
enum ConfigCommand {
    Validate,
    Show {
        #[arg(long)]
        sources: bool,
    },
}

#[derive(Parser)]
#[command(version, about = "AReaL-Harness Core app-server")]
#[command(group(clap::ArgGroup::new("execution").args(["runtime", "runtime_stdio"]).multiple(false)))]
struct Args {
    #[command(flatten)]
    config: ConfigArgs,
    #[command(subcommand)]
    command: Option<Command>,
    /// Write the bound WebSocket endpoint for a supervising launcher.
    #[arg(long, hide = true)]
    ready_file: Option<PathBuf>,
    /// 受限认证文件；省略时在数据目录 security/auth.json 创建本地身份。
    #[arg(long)]
    auth_file: Option<PathBuf>,
    /// 可信 profile 与可重定位 Skill 资源清单。
    #[arg(long)]
    desktop_config: Option<PathBuf>,
    /// 额外发布版本化桌面元数据，不改变 ready-file 的纯 endpoint 格式。
    #[arg(long)]
    ready_metadata_file: Option<PathBuf>,
    /// Enable tools with this trusted Runtime binary over private pipes.
    #[arg(long, requires = "workspace")]
    runtime: Option<PathBuf>,
    /// Use a Runtime created by the trusted launcher over inherited stdin/stdout.
    #[arg(long, requires = "workspace")]
    runtime_stdio: bool,
    #[arg(long, requires = "execution")]
    workspace: Option<PathBuf>,
    /// Scratch already granted by the trusted Runtime launcher.
    #[arg(long, requires = "runtime_stdio")]
    command_scratch: Option<PathBuf>,
    #[arg(long, requires = "runtime")]
    file_helper: Option<PathBuf>,
    /// Trusted deployment grant. Model/client arguments cannot enable writes.
    #[arg(long, requires = "execution")]
    allow_write: bool,
    /// Trusted write ownership, final checks, and shared worker limits (JSON).
    #[arg(long, requires = "allow_write")]
    workgroup_policy: Option<PathBuf>,
    /// Read-only toolchain copied into private workgroup sandboxes.
    #[arg(long, requires = "workgroup_policy")]
    workgroup_toolchain: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = Args::parse();
    let cli = std::mem::take(&mut args.config);
    let management = cli.management;
    let no_deployment_mcp = cli.no_deployment_mcp;
    let inputs = ConfigInputs {
        cwd: std::env::current_dir()?,
        homedir: std::env::home_dir(),
        env: std::env::vars_os().collect(),
        config_file: cli.config,
        overrides: ConfigOverrides {
            listen: cli.listen,
            data_dir: cli.data_dir,
            model: cli.model,
            model_provider: cli.model_provider,
            model_endpoint: cli.model_endpoint,
            model_protocol: cli.model_protocol,
            api_key_env: cli.api_key_env,
            model_concurrency: cli.model_concurrency,
            max_threads: cli.max_threads,
            max_active_turns: cli.max_active_turns,
            max_children_per_turn: cli.max_children_per_turn,
            max_agent_depth: cli.max_agent_depth,
            log_filter: cli.log_filter,
        },
    };
    let config = Arc::new(if management {
        areal_config::load_management_config(&inputs)?
    } else {
        load_config(&inputs)?
    });
    let mut extensions = tool_extensions::load(config.tool_extensions_file.as_deref())?;
    if no_deployment_mcp {
        extensions.mcp_servers.clear();
    }
    let credential = config.credential(&inputs)?;
    let telemetry_config = telemetry::TelemetryConfig::from_env(&inputs.env)?;
    for warning in &config.warnings {
        eprintln!("Warning: {warning}");
    }
    if let Some(Command::Config { command }) = args.command.take() {
        anyhow::ensure!(
            args.runtime.is_none()
                && !args.runtime_stdio
                && args.workspace.is_none()
                && !args.allow_write
                && args.file_helper.is_none()
                && args.ready_file.is_none()
                && args.workgroup_policy.is_none(),
            "config diagnostics do not accept Runtime deployment flags"
        );
        match command {
            ConfigCommand::Validate => println!("Configuration is valid"),
            ConfigCommand::Show { sources } => println!(
                "{}",
                serde_json::to_string_pretty(&config.diagnostic(sources))?
            ),
        }
        return Ok(());
    }
    if let Some(workspace) = &args.workspace {
        let workspace = workspace.canonicalize()?;
        anyhow::ensure!(workspace.is_dir(), "workspace must be a directory");
        anyhow::ensure!(
            !canonicalize_pending(&config.data_dir)?.starts_with(&workspace),
            "Core data must be outside the execution workspace"
        );
    }
    if let Some(scratch) = &args.command_scratch {
        let scratch = scratch.canonicalize()?;
        anyhow::ensure!(
            !canonicalize_pending(&config.data_dir)?.starts_with(&scratch),
            "Core data must be outside command scratch"
        );
        anyhow::ensure!(
            !std::env::current_exe()?
                .canonicalize()?
                .starts_with(&scratch),
            "Core executable must be outside command scratch"
        );
    }
    let telemetry = telemetry::TelemetryGuard::init(telemetry_config, &config.log_filter)?;
    let stopping = tokio_util::sync::CancellationToken::new();
    let signal = stopping.clone();
    #[cfg(unix)]
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    #[cfg(unix)]
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    let signal_task = tokio::spawn(async move {
        #[cfg(unix)]
        tokio::select! { _ = term.recv() => {}, _ = interrupt.recv() => {} }
        #[cfg(not(unix))]
        let _ = tokio::signal::ctrl_c().await;
        signal.cancel();
    });
    let result = run(
        args,
        config,
        credential,
        stopping,
        extensions,
        inputs.env,
        inputs.homedir,
    )
    .await;
    signal_task.abort();
    let _ = signal_task.await;
    telemetry.shutdown();
    result
}

// Resolve existing ancestors without creating a data directory, including symlinks.
fn canonicalize_pending(path: &std::path::Path) -> Result<PathBuf> {
    match path.canonicalize() {
        Ok(path) => Ok(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            anyhow::ensure!(
                std::fs::symlink_metadata(path).is_err(),
                "data path contains a dangling symlink"
            );
            let parent = path.parent().ok_or(error)?;
            Ok(canonicalize_pending(parent)?.join(
                path.file_name()
                    .ok_or_else(|| anyhow::anyhow!("invalid data directory"))?,
            ))
        }
        Err(error) => Err(error.into()),
    }
}

async fn run(
    args: Args,
    config: Arc<ResolvedCoreConfig>,
    credential: Option<String>,
    stopping: tokio_util::sync::CancellationToken,
    extensions: areal_engine::tools::ToolExtensions,
    mcp_env: std::collections::BTreeMap<std::ffi::OsString, std::ffi::OsString>,
    homedir: Option<PathBuf>,
) -> Result<()> {
    let model: Arc<dyn areal_engine::model::Model> = if config.model.name.is_empty() {
        Arc::new(areal_engine::model::UnconfiguredModel)
    } else {
        Arc::new(
            HttpModel::with_protocol(
                config.model.endpoint.clone(),
                config.model.name.clone(),
                credential,
                match config.model.protocol {
                    ModelProtocolConfig::ChatCompletions => ModelProtocol::ChatCompletions,
                    ModelProtocolConfig::Responses => ModelProtocol::Responses,
                },
            )?
            .with_audit_directory(config.data_dir.join("model-requests"))
            .with_options(ModelOptions {
                reasoning_effort: config.model.reasoning_effort.clone(),
                max_output_tokens: config.model.max_output_tokens,
                max_retries: config.model.max_retries,
                temperature: config.model.temperature,
                top_p: config.model.top_p,
                top_k: config.model.top_k,
                min_p: config.model.min_p,
                presence_penalty: config.model.presence_penalty,
                repetition_penalty: config.model.repetition_penalty,
            })?,
        )
    };
    let model: Arc<dyn areal_engine::model::Model> =
        areal_engine::workgroup::native::SharedModel::pool(model, config.model_concurrency)?;
    let limits = Limits {
        model_concurrency: config.model_concurrency,
        max_threads: config.max_threads,
        max_active_turns: config.max_active_turns,
        max_children_per_turn: config.max_children_per_turn,
        max_agent_depth: config.max_agent_depth,
        turn_timeout: std::time::Duration::from_secs(config.turn_timeout_seconds),
        stream_idle_timeout: std::time::Duration::from_secs(config.stream_idle_timeout_seconds),
        max_history_bytes: config.max_history_bytes,
        max_output_bytes: config.max_output_bytes,
        max_tool_calls: config.max_tool_calls,
        context_window_bytes: config.context_window_bytes,
        context_window_tokens: config.context_window_tokens,
        context_output_reserve_tokens: config.context_output_reserve_tokens,
        context_recent_bytes: config.context_recent_bytes,
        max_completion_retries: config.max_completion_retries,
        ..Limits::default()
    };
    let runtime = if let Some(binary) = &args.runtime {
        let binary = binary.canonicalize()?;
        let helper = args
            .file_helper
            .clone()
            .unwrap_or_else(|| binary.with_file_name("areal-runtime-fs"))
            .canonicalize()?;
        let workspace = args.workspace.as_ref().unwrap().canonicalize()?;
        if args.allow_write {
            for path in [&binary, &helper, &std::env::current_exe()?.canonicalize()?] {
                anyhow::ensure!(
                    !path.starts_with(&workspace),
                    "trusted executables must be outside the writable workspace"
                );
            }
        }
        Some((
            areal_runtime_client::Client::launch(&binary, &helper, &workspace, args.allow_write)
                .await?,
            workspace,
        ))
    } else if args.runtime_stdio {
        #[cfg(unix)]
        {
            use std::os::fd::AsFd;
            let read = tokio::net::unix::pipe::Receiver::from_owned_fd(
                std::io::stdin().as_fd().try_clone_to_owned()?,
            )?;
            let write = tokio::net::unix::pipe::Sender::from_owned_fd(
                std::io::stdout().as_fd().try_clone_to_owned()?,
            )?;
            Some((
                areal_runtime_client::Client::connect(read, write).await?,
                args.workspace.as_ref().unwrap().canonicalize()?,
            ))
        }
        #[cfg(not(unix))]
        anyhow::bail!("inherited Runtime pipes require Unix");
    } else {
        None
    };
    let mut mcp = None;
    let mut plugins = Vec::new();
    let result: Result<()> = async {
        let base = config
            .tool_extensions_file
            .as_ref()
            .and_then(|p| p.parent())
            .map(std::path::Path::to_owned)
            .unwrap_or(std::env::current_dir()?);
        mcp = Some(
            areal_mcp::Connections::connect(
                &extensions.mcp_servers,
                &mcp_env,
                &base,
                stopping.clone(),
            )
            .await?,
        );
        anyhow::ensure!(
            runtime.is_some() || extensions.plugins.is_empty(),
            "plugins require a Runtime"
        );
        for (id, plugin) in &extensions.plugins {
            plugins.push(
                areal_engine::tools::plugins::PluginHost::launch(id, plugin, &base, &mcp_env)
                    .await?,
            );
        }
        let opened = Engine::open_with_plugins(
            &config.data_dir,
            model.clone(),
            limits,
            runtime
                .as_ref()
                .map(|(client, workspace)| areal_engine::tools::RuntimeConfig {
                    client: client.clone(),
                    workspace: workspace.clone(),
                    writable: args.allow_write,
                    command_scratch: args.command_scratch.clone(),
                }),
            extensions,
            mcp.as_ref().unwrap().tools(),
            plugins.iter().flat_map(|host| host.tools()).collect(),
        );
        let engine = opened?;
        if let Some(path) = &args.desktop_config { engine.install_deployment(path)?; }
        let workspace = PathBuf::from(engine.default_cwd());
        let skills = areal_config::skills::discover(Some(&workspace), homedir.as_deref())?;
        for warning in &skills.warnings { eprintln!("Warning: {warning}"); }
        engine.install_default_skills(skills.skills.into_iter().map(|s| areal_engine::desktop::SkillLocation {
            id: s.id, revision: s.revision, root: s.root,
            metadata: Some(s.metadata),
        }).collect())?;
        for (name, value) in &mcp_env {
            if let Some(reference) = name.to_str().and_then(|name| name.strip_prefix("AREAL_CREDENTIAL_")) {
                engine.register_credential(reference.into(), value.to_str().context("credential must be UTF-8")?.into())?;
            }
        }
        if let Some(policy_path) = &args.workgroup_policy {
            use areal_engine::workgroup::service::{NativeFactory, Policy, Service};
            let policy: Policy = serde_json::from_slice(&std::fs::read(policy_path)?)?;
            let binary = args
                .runtime
                .clone()
                .unwrap_or(std::env::current_exe()?.with_file_name("areal-runtime"))
                .canonicalize()?;
            let helper = args
                .file_helper
                .clone()
                .unwrap_or(binary.with_file_name("areal-runtime-fs"))
                .canonicalize()?;
            let workspace = args.workspace.as_ref().unwrap().canonicalize()?;
            anyhow::ensure!(
                !binary.starts_with(&workspace) && !helper.starts_with(&workspace),
                "trusted workgroup binaries must be outside source workspace"
            );
            let factory = Arc::new(NativeFactory {
                catalog:Some(Arc::downgrade(&engine)),
                model: model.clone(),
                runtime: binary,
                file_helper: helper,
                toolchain: args.workgroup_toolchain.clone(),
            });
            engine.attach_workgroups(Service::open(
                &config.data_dir.join("workgroups"),
                &workspace,
                policy,
                factory,
            )?)?;
        }
        let auth_path = args.auth_file.clone().unwrap_or_else(|| config.data_dir.join("security/auth.json"));
        if args.auth_file.is_none() && !auth_path.exists() {
            use std::io::Write;
            std::fs::create_dir_all(auth_path.parent().unwrap())?;
            let mut file = tempfile::NamedTempFile::new_in(auth_path.parent().unwrap())?;
            #[cfg(unix)] {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(auth_path.parent().unwrap(), std::fs::Permissions::from_mode(0o700))?;
                file.as_file().set_permissions(std::fs::Permissions::from_mode(0o600))?;
            }
            serde_json::to_writer(&mut file, &serde_json::json!({"version":1,"principals":[{
                "id":"desktop-owner", "token":format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple()),
                "permissions":["observe","interact","manage","tools"]}]}))?;
            file.flush()?;
            file.as_file().sync_all()?;
            file.persist_noclobber(&auth_path)?;
        }
        let authentication = areal_app_server::auth::Authentication::load(&auth_path)?;
        let listener = tokio::net::TcpListener::bind(config.listen).await?;
        let address = listener.local_addr()?;
        if let Some(path) = &args.ready_file {
            // Atomic publication: a launcher must never observe a partial endpoint.
            let pending = path.with_extension("pending");
            std::fs::write(&pending, format!("ws://{address}"))?;
            std::fs::rename(pending, path)?;
        }
        if let Some(path) = &args.ready_metadata_file {
            let pending = path.with_extension("pending");
            let metadata = serde_json::json!({"formatVersion":1,"apiVersion":areal_protocol::desktop::API_VERSION,
                "endpoint":format!("ws://{address}"),"authFile":auth_path.canonicalize()?,
                "pid":std::process::id(),"runtime":engine.runtime_capabilities(),"state":"ready"});
            std::fs::write(&pending, serde_json::to_vec(&metadata)?)?;
            #[cfg(unix)] {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&pending, std::fs::Permissions::from_mode(0o600))?;
            }
            std::fs::rename(pending, path)?;
        }
        eprintln!("AReaL Core listening on ws://{address}");
        tracing::info!(%address, "Core listener ready");
        let stop = tokio_util::sync::CancellationToken::new();
        let server = areal_app_server::serve_authenticated(listener, engine.clone(), stop.clone(), Some(authentication));
        tokio::pin!(server);
        tokio::select! {
            result = &mut server => { engine.shutdown().await; result?; },
            _ = stopping.cancelled() => {
                engine.shutdown().await;
                stop.cancel();
                // WebSocket clients have independent lifetimes; process shutdown is bounded.
                let _ = tokio::time::timeout(std::time::Duration::from_secs(2), &mut server).await;
            }
        }
        Ok(())
    }
    .await;
    for path in [&args.ready_file, &args.ready_metadata_file]
        .into_iter()
        .flatten()
    {
        let _ = std::fs::remove_file(path);
    }
    let mut plugin_cleanup = Ok(());
    for host in &plugins {
        if let Err(error) = host.shutdown().await {
            plugin_cleanup = Err(error);
        }
    }
    let mcp_cleanup = if let Some(mut mcp) = mcp {
        mcp.shutdown().await
    } else {
        Ok(())
    };
    if let Some((client, _)) = runtime
        && let Err(cleanup) = client.shutdown().await
    {
        return Err(anyhow::anyhow!("{cleanup}; Core result: {result:?}"));
    }
    if let Err(cleanup) = mcp_cleanup {
        return Err(anyhow::anyhow!("{cleanup}; Core result: {result:?}"));
    }
    if let Err(cleanup) = plugin_cleanup {
        return Err(anyhow::anyhow!("{cleanup}; Core result: {result:?}"));
    }
    result
}
