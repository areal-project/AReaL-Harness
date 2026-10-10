use anyhow::{Context, Result};
use areal_config::{
    ConfigInputs, ConfigOverrides, ModelProtocolConfig, ResolvedCoreConfig, load_config,
};
use areal_engine::{Engine, Limits};
use clap::{Parser, Subcommand};
use std::{path::PathBuf, sync::Arc, time::Duration};

mod reload;
mod telemetry;
mod tool_extensions;
pub mod workgroup;

fn engine_limits(config: &ResolvedCoreConfig) -> Limits {
    Limits {
        goals: areal_engine::goals::Policy {
            max_turns: config.goals.max_turns,
            max_active_seconds: config.goals.max_active_seconds,
            max_unreported_turns: config.goals.max_unreported_turns,
            turn_model_rounds: config.goals.turn_model_rounds,
        },
        model_concurrency: config.model_concurrency,
        max_threads: config.max_threads,
        max_active_turns: config.max_active_turns,
        max_children_per_turn: config.max_children_per_turn,
        max_agent_depth: config.max_agent_depth,
        stream_idle_timeout: std::time::Duration::from_secs(config.stream_idle_timeout_seconds),
        max_history_bytes: config.max_history_bytes,
        max_output_bytes: config.max_output_bytes,
        max_tool_calls: config.max_tool_calls,
        max_response_tool_calls: config.max_response_tool_calls,
        max_response_bytes: config.max_response_bytes,
        max_tool_buffer_bytes: config.max_tool_buffer_bytes,
        context_window_bytes: config.context_window_bytes,
        context_compaction_enabled: config.context_compaction_enabled,
        context_auto_compaction: config.context_auto_compaction,
        context_recent_tokens: config.context_recent_tokens,
        context_window_tokens: config.context_window_tokens,
        context_target_tokens: config.context_target_tokens,
        context_output_reserve_tokens: config.context_output_reserve_tokens,
        context_recent_bytes: config.context_recent_bytes,
        max_completion_retries: config.max_completion_retries,
        watchdog_disable: config.watchdog_disable,
        ..Limits::default()
    }
}

#[derive(clap::Args, Default)]
struct ConfigArgs {
    #[arg(long, global = true)]
    permissions: Option<String>,
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
enum ConfigCommand {
    Models {
        /// 可信适配器从安全存储注入的环境变量名；只用于诊断，不写入配置。
        #[arg(long = "stored-credential-env", global = true)]
        stored_credential_envs: Vec<String>,
        #[command(subcommand)]
        command: ModelConfigCommand,
    },
    Validate,
    Show {
        #[arg(long)]
        sources: bool,
    },
}

#[derive(Subcommand)]
enum ModelConfigCommand {
    Read,
    Write,
}

/// 复用 Core 的诊断路径，避免 CLI 复制配置优先级和脱敏规则。
#[derive(clap::Args)]
pub struct ConfigCli {
    #[command(flatten)]
    config: ConfigArgs,
    #[command(subcommand)]
    command: ConfigCommand,
}

pub async fn diagnose(args: ConfigCli) -> Result<()> {
    run_configured(
        Args {
            config: args.config,
            ..Args::default()
        },
        Some(args.command),
    )
    .await
}

#[derive(Parser, Default)]
#[command(version, about = "AReaL-Harness Core app-server")]
#[command(group(clap::ArgGroup::new("execution").args(["runtime", "runtime_stdio"]).multiple(false)))]
pub struct Args {
    #[command(flatten)]
    config: ConfigArgs,
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
    /// 可信服务宿主提供的实例身份，仅用于认证后的发现验证。
    #[arg(long, hide = true, requires = "runtime_stdio")]
    service_info: Option<PathBuf>,
    /// 启动器死亡时通过 EOF 关闭 Core，避免 SIGKILL 留下孤儿服务。
    #[arg(long, hide = true, requires = "runtime_stdio")]
    supervisor_fd: Option<i32>,
    /// Enable tools with this trusted Runtime binary over private pipes.
    #[arg(long, requires = "workspace")]
    runtime: Option<PathBuf>,
    /// Use a Runtime created by the trusted launcher over inherited stdin/stdout.
    #[arg(long, requires = "workspace")]
    runtime_stdio: bool,
    /// 普通命令工具的墙钟上限；桌面进程使用 Runtime 根 Scope 的额度。
    #[arg(long, requires = "runtime_stdio")]
    command_timeout_ms: Option<u64>,
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

pub async fn run(args: Args) -> Result<()> {
    run_configured(args, None).await
}

async fn run_configured(mut args: Args, diagnostic: Option<ConfigCommand>) -> Result<()> {
    let cli = std::mem::take(&mut args.config);
    let management = cli.management;
    let no_deployment_mcp = cli.no_deployment_mcp;
    let inputs = ConfigInputs {
        cwd: std::env::current_dir()?,
        homedir: std::env::home_dir(),
        env: std::env::vars_os().collect(),
        config_file: cli.config,
        overrides: ConfigOverrides {
            permissions: cli.permissions,
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
    let diagnostic = match diagnostic {
        Some(ConfigCommand::Models {
            command,
            stored_credential_envs,
        }) => {
            let result = match command {
                ModelConfigCommand::Read => {
                    areal_config::models::read(&inputs, &stored_credential_envs)?
                }
                ModelConfigCommand::Write => {
                    use std::io::Read;
                    let mut bytes = Vec::new();
                    std::io::stdin()
                        .take(1024 * 1024 + 1)
                        .read_to_end(&mut bytes)?;
                    anyhow::ensure!(
                        bytes.len() <= 1024 * 1024,
                        "model configuration request exceeds 1 MiB"
                    );
                    let update = serde_json::from_slice(&bytes)
                        .map_err(|_| anyhow::anyhow!("invalid model configuration request"))?;
                    areal_config::models::write(&inputs, update, &stored_credential_envs)?
                }
            };
            println!("{}", serde_json::to_string(&result)?);
            return Ok(());
        }
        other => other,
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
    let telemetry_config = telemetry::TelemetryConfig::from_env(&inputs.env)?;
    for warning in &config.warnings {
        eprintln!("Warning: {warning}");
    }
    if let Some(command) = diagnostic {
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
            ConfigCommand::Models { .. } => unreachable!(),
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
    let model = reload::model(&config.model, &inputs, &config.data_dir, management)?;
    let telemetry = telemetry::TelemetryGuard::init(telemetry_config, &config.log_filter)?;
    let stopping = tokio_util::sync::CancellationToken::new();
    #[cfg(unix)]
    let supervisor_task = if let Some(fd) = args.supervisor_fd {
        use std::os::fd::{FromRawFd, OwnedFd};
        use tokio::io::AsyncReadExt;
        anyhow::ensure!(fd >= 3, "invalid supervisor descriptor");
        let mut pipe =
            tokio::net::unix::pipe::Receiver::from_owned_fd(unsafe { OwnedFd::from_raw_fd(fd) })?;
        let stop = stopping.clone();
        Some(tokio::spawn(async move {
            let mut byte = [0u8; 1];
            let _ = pipe.read(&mut byte).await;
            stop.cancel();
        }))
    } else {
        None
    };
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
    let diagnostics_stop = stopping.clone();
    let diagnostics_root = config.data_dir.clone();
    let diagnostics_task = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = diagnostics_stop.cancelled() => break,
                _ = interval.tick() => {
                    let root = diagnostics_root.clone();
                    if !matches!(tokio::task::spawn_blocking(move || areal_engine::diagnostics::collect(&root)).await, Ok(Ok(()))) {
                        tracing::warn!("diagnostic retention cleanup failed");
                    }
                }
            }
        }
    });
    let result = serve(args, config, model, stopping.clone(), extensions, inputs).await;
    stopping.cancel();
    let _ = diagnostics_task.await;
    signal_task.abort();
    let _ = signal_task.await;
    #[cfg(unix)]
    if let Some(task) = supervisor_task {
        task.abort();
        let _ = task.await;
    }
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

async fn serve(
    args: Args,
    config: Arc<ResolvedCoreConfig>,
    model: Arc<dyn areal_engine::model::Model>,
    stopping: tokio_util::sync::CancellationToken,
    extensions: areal_engine::tools::ToolExtensions,
    inputs: ConfigInputs,
) -> Result<()> {
    let mcp_env = inputs.env.clone();
    let homedir = inputs.homedir.clone();
    let model: Arc<dyn areal_engine::model::Model> =
        areal_engine::workgroup::native::SharedModel::pool(model, config.model_concurrency)?;
    let limits = engine_limits(&config);
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
        let command_scope = if let (Some((client, _)), Some(timeout)) = (&runtime, args.command_timeout_ms) {
            Some(client.create_scope(areal_runtime_protocol::CreateScope {
                operation_id: client.operation_id(),
                parent_scope_id: client.info().root_scope_id.clone(),
                owner: areal_runtime_protocol::Owner { task_id: "core-command-tools".into(), plugin_instance_id: None },
                permissions: Default::default(),
                limits: areal_runtime_protocol::LimitRequest { wall_time_ms: Some(timeout), ..Default::default() },
            }).await?)
        } else { None };
        let opened = Engine::open_with_plugins(
            &config.data_dir,
            model.clone(),
            limits.clone(),
            runtime
                .as_ref()
                .map(|(client, workspace)| areal_engine::tools::RuntimeConfig {
                    client: client.clone(),
                    workspace: workspace.clone(),
                    writable: args.allow_write,
                    command_scope: command_scope.clone(),
                    command_scratch: args.command_scratch.clone(),
                }),
            extensions,
            mcp.as_ref().unwrap().tools(),
            plugins.iter().flat_map(|host| host.tools()).collect(),
        );
        let engine = opened?;
        engine.set_permissions(config.permissions.clone(), config.sources.get("permissions.mode").cloned())?;
        let reload = if args.service_info.is_some() { Some(reload::Reload::open(inputs, &config, &engine)?) } else { None };
        if let Some(path) = &args.desktop_config { engine.install_deployment(path)?; }
        let workspace = PathBuf::from(engine.default_cwd());
        let skills = areal_config::skills::discover(Some(&workspace), homedir.as_deref())?;
        for warning in &skills.warnings { eprintln!("Warning: {warning}"); }
        engine.install_default_skills(skills.skills.into_iter().map(|s| areal_engine::desktop::SkillLocation {
            id: s.id, revision: s.revision, root: s.root,
            metadata: Some(s.metadata),
        }).collect())?;
        for name in mcp_env.keys() {
            if let Some(name) = name.to_str()
                && let Some(reference) = name.strip_prefix("AREAL_CREDENTIAL_")
                && let Some(value) = areal_config::credential_value(&mcp_env, name)
            {
                engine.register_credential(reference.into(), value.into())?;
            }
        }
        engine.install_configured_models(configured_models(&config, &mcp_env, &engine)?)?;
        if let Some(policy_path) = &args.workgroup_policy {
            use areal_engine::workgroup::service::{NativeFactory, Policy, Service};
            let policy: Policy = serde_json::from_slice(&std::fs::read(policy_path)?)?;
            // launcher 的主 Runtime 使用私有管道；工作组还需自行启动隔离
            // Runtime。沿用发行目录布局，源码构建才使用同目录辅助程序。
            let executable = std::env::current_exe()?;
            let bin_dir = executable.parent().context("executable directory missing")?;
            let packaged_runtime = bin_dir.join("../libexec/areal");
            let runtime_dir = if packaged_runtime.is_dir() {
                packaged_runtime
            } else {
                bin_dir.to_owned()
            };
            let binary = args
                .runtime
                .clone()
                .unwrap_or_else(|| runtime_dir.join("areal-runtime"))
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
                worker_limits: limits.clone(),
                watchdog_disable: config.watchdog_disable,
                tool_call_limits: areal_engine::model::ToolCallLimits { max_calls: config.max_response_tool_calls, max_buffer_bytes: config.max_tool_buffer_bytes },
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
        let identity = if let Some(path) = &args.service_info {
            let identity: areal_protocol::service::Identity = serde_json::from_slice(&std::fs::read(path)?)?;
            anyhow::ensure!(identity.protocol_version == areal_protocol::service::VERSION
                && identity.data_dir == config.data_dir.canonicalize()?
                && Some(&identity.workspace) == args.workspace.as_ref(), "service identity does not match deployment");
            Some(identity)
        } else { None };
        let server = areal_app_server::serve_service(listener, engine.clone(), stop.clone(), Some(authentication), identity);
        tokio::pin!(server);
        let reload = async {
            if let Some(reload) = reload { reload.run(engine.clone()).await; }
            std::future::pending::<()>().await;
        };
        tokio::pin!(reload);
        tokio::select! {
            _ = &mut reload => unreachable!(),
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

fn configured_models(
    config: &ResolvedCoreConfig,
    env: &std::collections::BTreeMap<std::ffi::OsString, std::ffi::OsString>,
    engine: &Engine,
) -> Result<areal_engine::desktop::ConfiguredModels> {
    use areal_protocol::desktop::{ModelParameters, ModelRef, Provider};
    let parameters = |value: &areal_config::models::Parameters| ModelParameters {
        context_window_tokens: value.context_window_tokens,
        temperature: value.temperature,
        max_output_tokens: value.max_output_tokens,
        reasoning_effort: value.reasoning_effort.clone(),
        reasoning_summary: None,
    };
    let mut result = areal_engine::desktop::ConfiguredModels::default();
    for item in &config.model_catalog {
        result.provider_ids.insert(item.id.clone());
        if !item.enabled {
            continue;
        }
        let selected = config.model.provider == item.id && !config.model.name.is_empty();
        let mut models: Vec<_> = item
            .models
            .iter()
            .filter(|m| m.enabled)
            .map(|m| m.id.clone())
            .collect();
        if selected && !models.contains(&config.model.name) {
            models.push(config.model.name.clone());
        }
        if models.is_empty() {
            continue;
        }
        let key_env = if selected {
            config.model.api_key_env.clone()
        } else {
            item.api_key_env.clone()
        };
        // 沿用桌面既有引用规则，轮换后旧任务仍能从启动环境解析冻结凭据。
        let reference = key_env.as_ref().map(|name| {
            name.strip_prefix("AREAL_CREDENTIAL_")
                .unwrap_or(name)
                .to_owned()
        });
        if let (Some(name), Some(reference)) = (&key_env, &reference)
            && let Some(value) = areal_config::credential_value(env, name)
        {
            engine.register_credential(reference.clone(), value.into())?;
        }
        let protocol = if selected {
            config.model.protocol
        } else {
            item.protocol
        };
        result.providers.push(Provider {
            id: item.id.clone(),
            revision: 0,
            endpoint: if selected {
                config.model.endpoint.clone()
            } else {
                item.endpoint.clone()
            },
            protocol: match protocol {
                ModelProtocolConfig::ChatCompletions => "chatCompletions",
                ModelProtocolConfig::Responses => "responses",
            }
            .into(),
            credential_ref: reference,
            models,
            parameters: parameters(&item.parameters),
        });
        for model in &item.models {
            result.parameters.insert(
                (item.id.clone(), model.id.clone()),
                parameters(&model.parameters),
            );
        }
        if selected {
            result.default_model = Some(ModelRef {
                provider_id: item.id.clone(),
                model_id: config.model.name.clone(),
            });
            result.parameters.insert(
                (item.id.clone(), config.model.name.clone()),
                ModelParameters {
                    context_window_tokens: config.model.context_window_tokens,
                    temperature: config.model.temperature,
                    max_output_tokens: config.model.max_output_tokens,
                    reasoning_effort: config.model.reasoning_effort.clone(),
                    reasoning_summary: config.model.reasoning_summary.clone(),
                },
            );
        }
    }
    if config.model.provider == "areal_openai" && !config.model.name.is_empty() {
        result.default_model = Some(ModelRef {
            provider_id: "areal_openai".into(),
            model_id: config.model.name.clone(),
        });
    }
    if !config.model_catalog_managed {
        result.default_model = None;
    }
    Ok(result)
}
