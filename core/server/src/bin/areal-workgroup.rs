//! A bounded Core workgroup runner. The input checkout is never a write target.
use anyhow::{Context, Result, ensure};
use areal_config::{ConfigInputs, ConfigOverrides, ModelProtocolConfig, load_config};
use areal_engine::{
    model::{HttpModel, Model, ModelOptions, ModelProtocol},
    workgroup::{
        self, Admission, Options, Plan, Strategy, Workgroup,
        native::{NativeExecutor, SharedModel, propose},
        tree,
    },
};
use clap::{Parser, Subcommand};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

#[derive(Parser)]
#[command(about = "Run isolated coding agents with Core-owned verified integration")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Run(Box<Args>),
    /// Inspect settled/crashed state and verify persisted source integrity.
    Inspect {
        state_dir: PathBuf,
    },
}

#[derive(clap::Args)]
struct Args {
    #[arg(long)]
    workspace: PathBuf,
    #[arg(long)]
    state_dir: PathBuf,
    /// JSON task graph. Omit to plan from --prompt-file with the same model budget.
    #[arg(
        long,
        conflicts_with = "prompt_file",
        required_unless_present = "prompt_file"
    )]
    plan: Option<PathBuf>,
    #[arg(
        long,
        conflicts_with = "plan",
        required_unless_present = "plan",
        requires = "write_scope"
    )]
    prompt_file: Option<PathBuf>,
    /// Trusted exact writable paths as a JSON array; mandatory for model planning.
    #[arg(long)]
    write_scope: Option<PathBuf>,
    /// Trusted JSON array of argv arrays. A final successful check is mandatory.
    #[arg(long)]
    checks: PathBuf,
    #[arg(long)]
    runtime: PathBuf,
    #[arg(long)]
    file_helper: PathBuf,
    /// Materialized trusted toolchain, copied fresh into each private workspace.
    #[arg(long)]
    toolchain: Option<PathBuf>,
    #[arg(long, default_value_t = 2)]
    workers: usize,
    /// Adaptive changes the target inside --workers using local model pressure.
    #[arg(long, default_value = "fixed", value_parser = ["fixed", "auto", "adaptive"])]
    admission: String,
    /// Adaptive starting target; 0 derives it from ready work and model capacity.
    #[arg(long, default_value_t = 0)]
    initial_workers: usize,
    #[arg(long, default_value_t = 1)]
    repairs: u32,
    #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
    integration_repair: bool,
    #[arg(long, default_value_t = 4)]
    verification_batch: usize,
    #[arg(long, default_value_t = 600)]
    seconds: u64,
    /// Per-command ceiling; the root deadline still cancels the whole group.
    #[arg(long, default_value_t = 300_000)]
    command_timeout_ms: u64,
    #[arg(long, default_value_t = 128)]
    max_model_requests: usize,
    #[arg(long, default_value = "balanced", value_parser = ["single", "contract", "cohesion", "balanced"])]
    strategy: String,
    /// Soft worker model-view byte target. Durable history stays complete; 0 disables.
    #[arg(long, default_value_t = 65536)]
    worker_context_bytes: usize,
    /// After an edit, checkpoint an unchanged source after this many model rounds; 0 disables.
    #[arg(long, default_value_t = 0)]
    worker_stall_rounds: usize,
    /// Tools exposed to worker models; execution still uses Engine and Runtime.
    #[arg(long, default_value = "all", value_parser = ["all", "command"])]
    worker_tools: String,
    #[arg(long)]
    config: Option<PathBuf>,
    #[arg(long)]
    model_endpoint: Option<String>,
    #[arg(long)]
    model: Option<String>,
    #[arg(long)]
    api_key_env: Option<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = match Cli::parse().command {
        Command::Run(args) => *args,
        Command::Inspect { state_dir } => {
            println!(
                "{}",
                serde_json::to_string_pretty(&Workgroup::inspect(&state_dir)?)?
            );
            return Ok(());
        }
    };
    let started = Instant::now();
    ensure!(
        (1..=32).contains(&args.workers)
            && args.initial_workers <= 32
            && args.repairs <= 3
            && (1..=32).contains(&args.verification_batch)
            && (1..=86400).contains(&args.seconds)
            && (1..=86_400_000).contains(&args.command_timeout_ms),
        "invalid workgroup limits"
    );
    ensure!(
        args.worker_context_bytes == 0 || (4096..=1048576).contains(&args.worker_context_bytes),
        "invalid worker context target"
    );
    ensure!(
        args.worker_stall_rounds == 0 || (8..=128).contains(&args.worker_stall_rounds),
        "invalid worker checkpoint interval"
    );
    ensure!(
        !args.state_dir.exists(),
        "state directory already exists; use Workgroup::inspect, never replay implicitly"
    );
    let workspace = args.workspace.canonicalize()?;
    let parent = args
        .state_dir
        .parent()
        .context("state directory needs a parent")?;
    std::fs::create_dir_all(parent)?;
    ensure!(
        !parent.canonicalize()?.starts_with(&workspace),
        "Core state must be outside the source workspace"
    );
    let inputs = ConfigInputs {
        cwd: std::env::current_dir()?,
        homedir: std::env::home_dir(),
        env: std::env::vars_os().collect(),
        config_file: args.config,
        overrides: ConfigOverrides {
            model_endpoint: args.model_endpoint,
            model: args.model,
            api_key_env: args.api_key_env,
            ..ConfigOverrides::default()
        },
    };
    let config = load_config(&inputs)?;
    let model = SharedModel::new(
        Arc::new(
            HttpModel::with_protocol(
                config.model.endpoint.clone(),
                config.model.name.clone(),
                config.credential(&inputs)?,
                match config.model.protocol {
                    ModelProtocolConfig::ChatCompletions => ModelProtocol::ChatCompletions,
                    ModelProtocolConfig::Responses => ModelProtocol::Responses,
                },
            )?
            .with_audit_directory(config.data_dir.join("model-requests"))
            .with_options(ModelOptions {
                reasoning_effort: config.model.reasoning_effort.clone(),
                max_output_tokens: config.model.max_output_tokens,
                temperature: config.model.temperature,
                top_p: config.model.top_p,
                top_k: config.model.top_k,
                min_p: config.model.min_p,
                presence_penalty: config.model.presence_penalty,
                repetition_penalty: config.model.repetition_penalty,
                max_retries: config.model.max_retries,
            })?,
        ),
        config.model_concurrency.min(32),
        args.max_model_requests,
    )?;
    let base = tree::snapshot(&workspace)?;
    let allowed: Option<Vec<String>> = args
        .write_scope
        .as_ref()
        .map(|p| -> Result<_> { Ok(serde_json::from_slice(&std::fs::read(p)?)?) })
        .transpose()?;
    let checks: Vec<Vec<String>> = serde_json::from_slice(&std::fs::read(&args.checks)?)?;
    workgroup::validate_commands(&checks, true)?;
    let stop = CancellationToken::new();
    let token = stop.clone();
    #[cfg(unix)]
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let signal = tokio::spawn(async move {
        #[cfg(unix)]
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
        #[cfg(not(unix))]
        let _ = tokio::signal::ctrl_c().await;
        token.cancel();
    });
    let limit = Duration::from_secs(args.seconds);
    let result: Result<()> = async {
        let plan: Plan = if let Some(path) = args.plan {
            serde_json::from_slice(&std::fs::read(path)?)?
        } else {
            let objective = std::fs::read_to_string(args.prompt_file.unwrap())?;
            ensure!(objective.len() <= 32000, "objective too large");
            if args.strategy == "single" {
                Plan { objective:objective.clone(), tasks:vec![workgroup::Task {
                    configuration: None,
                    id:"implementation".into(),instruction:objective,writes:allowed.clone().context("single prompt requires trusted write scope")?,
                    depends:vec![], integration_depends:vec![],checks:checks.clone()
                }] }
            } else { tokio::select! {
                _ = stop.cancelled() => anyhow::bail!("planning cancelled"),
                _ = tokio::time::sleep(limit.saturating_sub(started.elapsed())) => anyhow::bail!("planning exceeded root deadline"),
                plan = propose(model.as_ref(), &objective, &base, allowed.as_ref().context("model planning requires trusted write scope")?) => plan?,
            } }
        };
        if let Some(allowed) = &allowed { workgroup::validate_write_scope(&plan, allowed)?; }
        let strategy = match args.strategy.as_str() { "single" => Strategy::Single, "contract" => Strategy::Contract, "balanced" => Strategy::Balanced, _ => Strategy::Cohesion };
        let admission = match args.admission.as_str() { "adaptive" => Admission::Adaptive, "auto" => Admission::Auto, _ => Admission::Fixed };
        let original = serde_json::to_vec_pretty(&plan)?;
        let plan = workgroup::packing::prepare(plan, &base, strategy, &checks, args.workers)?;
        let group = Workgroup::create(&args.state_dir, plan, &base, strategy)?;
        std::fs::write(args.state_dir.join("plan.json"), original)?;
        std::fs::write(args.state_dir.join("config.json"), serde_json::to_vec_pretty(&serde_json::json!({
            "strategy":strategy,"workers":args.workers,"admission":admission,"repairs":args.repairs,"seconds":args.seconds,
            "initialWorkers":args.initial_workers.min(args.workers),
            "commandTimeoutMs":args.command_timeout_ms,"verificationBatch":args.verification_batch,
            "integrationRepair":args.integration_repair,"maxModelRequests":args.max_model_requests,"modelConcurrency":config.model_concurrency.min(32),
            "model":config.model.name,"writeScope":allowed,"workerContextBytes":args.worker_context_bytes,"workerStallRounds":args.worker_stall_rounds,"workerTools":args.worker_tools
        }))?)?;
        let mut executor = NativeExecutor::new(model.clone(), args.state_dir.join("bindings"), args.runtime.canonicalize()?,
            args.file_helper.canonicalize()?, args.toolchain.map(|p| p.canonicalize()).transpose()?)?;
        executor.watchdog_disable = config.watchdog_disable;
        executor.context_bytes = args.worker_context_bytes;
        executor.max_unchanged_rounds = args.worker_stall_rounds;
        executor.command_tools_only = args.worker_tools == "command";
        executor.runtime_limits.wall_time_ms = args.command_timeout_ms;
        let executor = Arc::new(executor);
        let remaining = limit.saturating_sub(started.elapsed());
        ensure!(!remaining.is_zero(), "root deadline exceeded during setup");
        let record = group.run(base, executor, checks, Options { verification_batch: args.verification_batch, workers: args.workers, admission, initial_workers: args.initial_workers, repairs: args.repairs,
            timeout: remaining, strategy, integration_repair: args.integration_repair }, stop.clone()).await?;
        println!("{}", serde_json::to_string(&record)?);
        ensure!(record.status == "completed", "workgroup {}: {}", record.status, record.error.unwrap_or_default());
        Ok(())
    }.await;
    signal.abort();
    let usage = serde_json::json!({"model":model.usage(), "modelLoad":model.load(), "totalSeconds":started.elapsed().as_secs_f64(), "success":result.is_ok()});
    if args.state_dir.exists() {
        std::fs::write(
            args.state_dir.join("usage.json"),
            serde_json::to_vec_pretty(&usage)?,
        )?;
    }
    eprintln!("{usage}");
    result
}
