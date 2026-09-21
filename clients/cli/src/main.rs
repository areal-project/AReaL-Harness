//! 对外直接使用 Claude Code CLI/stdio 协议；历史、工具循环和队列仍属于 Core。
mod local;
mod rpc;
mod run;
use anyhow::{Result, ensure};
use clap::{Parser, Subcommand};
use std::path::PathBuf;
#[derive(Parser)]
#[command(
    name = "areal",
    version,
    about = "AReaL-Harness — Core + Runtime client",
    subcommand_negates_reqs = true,
    args_conflicts_with_subcommands = true
)]
struct Args {
    #[command(subcommand)]
    command: Option<Command>,
    #[command(flatten)]
    cli: Cli,
}
#[derive(Subcommand)]
enum Command {
    /// 启动桌面 Core + Runtime；参数遵循嵌入式可信 launcher。
    #[command(trailing_var_arg = true)]
    Serve {
        #[arg(allow_hyphen_values = true)]
        args: Vec<String>,
    },
}
#[derive(clap::Args)]
struct Cli {
    #[arg(short = 'p', long = "print", required = true)]
    print: bool,
    prompt: Option<String>,
    #[arg(long,default_value="text",value_parser=["text","json","stream-json"])]
    output_format: String,
    #[arg(long,default_value="text",value_parser=["text","stream-json"])]
    input_format: String,
    #[arg(long)]
    verbose: bool,
    #[arg(long)]
    include_partial_messages: bool,
    #[arg(short = 'r', long)]
    resume: Option<String>,
    #[arg(long)]
    model: Option<String>,
    #[arg(long)]
    effort: Option<String>,
    #[arg(long)]
    max_turns: Option<usize>,
    #[arg(long,default_value="default",value_parser=["default","bypassPermissions","dontAsk","plan","acceptEdits"])]
    permission_mode: String,
    #[arg(long)]
    dangerously_skip_permissions: bool,
    #[arg(long="allowedTools", alias="allowed-tools", action=clap::ArgAction::Append)]
    allowed_tools: Vec<String>,
    #[arg(long="disallowedTools", alias="disallowed-tools", action=clap::ArgAction::Append)]
    disallowed_tools: Vec<String>,
    #[arg(long)]
    tools: Option<String>,
    #[arg(long, conflicts_with = "system_prompt_file")]
    system_prompt: Option<String>,
    #[arg(long)]
    system_prompt_file: Option<PathBuf>,
    #[arg(long, conflicts_with = "append_system_prompt_file")]
    append_system_prompt: Option<String>,
    #[arg(long)]
    append_system_prompt_file: Option<PathBuf>,
    #[arg(long,action=clap::ArgAction::Append)]
    mcp_config: Vec<String>,
    #[arg(long)]
    strict_mcp_config: bool,
    #[arg(long)]
    endpoint: Option<String>,
    #[arg(long, requires = "endpoint")]
    auth_file: Option<PathBuf>,
    #[arg(long, conflicts_with = "endpoint")]
    config: Option<PathBuf>,
    #[arg(long, conflicts_with = "endpoint")]
    workspace: Option<PathBuf>,
    #[arg(long, conflicts_with = "endpoint")]
    allow_write: bool,
    #[arg(long, conflicts_with = "endpoint")]
    task_credential_command: Vec<PathBuf>,
    #[arg(long, conflicts_with = "endpoint")]
    allow_network: bool,
    #[arg(long, conflicts_with = "endpoint")]
    allow_concurrent_writes: bool,
    #[arg(long, conflicts_with = "endpoint")]
    desktop_config: Option<PathBuf>,
}
fn key() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn read_text(path: &std::path::Path) -> Result<String> {
    ensure!(
        std::fs::metadata(path)?.len() <= 32768,
        "instruction file exceeds 32 KiB"
    );
    Ok(std::fs::read_to_string(path)?)
}
#[tokio::main]
async fn main() {
    let parsed = Args::parse();
    if let Some(command) = parsed.command {
        match command {
            Command::Serve { args } => {
                use std::os::unix::process::CommandExt;
                let executable = std::env::current_exe().expect("executable path");
                let error = std::process::Command::new("/usr/bin/python3")
                    .args(["-I", "-S", "-c"])
                    .arg(include_str!("../../../scripts/launch.py"))
                    .arg("--bin-dir")
                    .arg(executable.parent().unwrap())
                    .args(args)
                    .exec();
                eprintln!("AReaL launcher: {error}");
                std::process::exit(1);
            }
        }
    }
    let args = parsed.cli;
    let started = std::time::Instant::now();
    let result = run::execute(&args).await;
    let code = match result {
        Ok(code) => code,
        Err(error) => {
            eprintln!("AReaL: {error}");
            if args.output_format != "text" {
                let value = serde_json::json!({"type":"result","subtype":"error_during_execution","is_error":true,"session_id":args.resume.as_deref().unwrap_or(""),"errors":[error.to_string()],"duration_ms":started.elapsed().as_millis(),"num_turns":0,"stop_reason":null,"uuid":key()});
                let _ = run::emit(&value);
            }
            1
        }
    };
    std::process::exit(code);
}
