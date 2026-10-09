//! 统一产品命令；子命令只装配已有入口，历史、工具循环和队列仍属于 Core。
mod local;
mod rpc;
mod run;
mod service;
mod trajectory;
mod upgrade;
use anyhow::{Result, ensure};
use clap::{CommandFactory, Parser, Subcommand};
use std::path::PathBuf;
#[derive(Parser)]
#[command(
    name = "areal",
    version,
    about = "AReaL-Harness — interactive agent and Core service",
    subcommand_negates_reqs = true,
    args_conflicts_with_subcommands = true,
    after_help = "Run without a subcommand to open the TUI. Use areal exec for scripts.
The existing areal -p / --print interface remains supported."
)]
struct MultitoolCli {
    #[command(subcommand)]
    command: Option<Command>,
    #[command(flatten)]
    interactive: areal_tui::Args,
}

#[derive(Subcommand)]
enum Command {
    /// 显示当前版本；等价于 --version。
    Version,
    /// 检查或安装最新已发布版本；按 Homebrew/独立安装来源升级。
    Upgrade {
        #[arg(long)]
        check: bool,
    },
    /// 非交互执行任务；支持 text、json 与 Claude stream-json 协议。
    Exec(Box<Cli>),
    /// 管理可被 TUI、Web 与 Desktop 复用的本地服务。
    Service {
        #[command(subcommand)]
        command: service::ServiceCommand,
    },
    /// 复用本地服务并打开 Web；--json 只返回连接描述。
    Web {
        #[command(flatten)]
        local: Box<areal_local_service::LocalArgs>,
        #[arg(long)]
        json: bool,
    },
    /// 前台启动 Core + Runtime；参数遵循嵌入式可信 launcher。
    #[command(trailing_var_arg = true, disable_help_flag = true)]
    Serve {
        #[arg(allow_hyphen_values = true)]
        args: Vec<std::ffi::OsString>,
    },
    /// 启动 Core app-server；可显式连接可信 Runtime。
    AppServer(Box<areal_server::Args>),
    /// 校验或查看脱敏后的有效配置。
    Config(Box<areal_server::ConfigCli>),
    /// 查看轨迹导出状态或重新排队失败批次。
    Trajectory(trajectory::Options),
    /// 轨迹导出内部 worker；共享持久队列，不拥有 Agent 会话。
    #[command(hide = true)]
    TrajectoryWorker {
        #[arg(long)]
        spool_dir: PathBuf,
    },
    /// 运行或检查隔离的 Workgroup。
    Workgroup {
        #[command(subcommand)]
        command: areal_server::workgroup::Command,
    },
    /// 本地服务内部宿主，由服务发现模块启动。
    #[command(hide = true)]
    ServiceHost,
    /// 仅供可信本地入口使用的 Core/Runtime 进程宿主。
    #[command(hide = true, trailing_var_arg = true, disable_help_flag = true)]
    Launcher {
        #[arg(allow_hyphen_values = true)]
        args: Vec<std::ffi::OsString>,
    },
}

#[derive(Parser)]
#[command(name = "areal", version)]
struct LegacyArgs {
    #[arg(short = 'p', long = "print", required = true)]
    print: bool,
    #[command(flatten)]
    cli: Cli,
}
#[derive(clap::Args)]
struct Cli {
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
    #[arg(long,default_value="inherit",value_parser=["inherit","default","bypassPermissions","dontAsk","plan","acceptEdits"])]
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
    permissions: Option<String>,
    #[arg(long, conflicts_with = "endpoint")]
    scratch: Option<PathBuf>,
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
    #[arg(long, conflicts_with = "endpoint")]
    workgroup_policy: Option<PathBuf>,
    #[arg(long, requires = "workgroup_policy", conflicts_with = "endpoint")]
    workgroup_toolchain: Option<PathBuf>,
    /// 选择已部署的 Agent Profile，格式为 id@revision。
    #[arg(long)]
    agent: Option<String>,
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
    let raw: Vec<_> = std::env::args_os().collect();
    let subcommand = raw.get(1).is_some_and(|arg| is_subcommand(arg));
    // 先完整验证旧协议，避免把提示词中的 -p 误当成路由标记。
    if !subcommand && let Ok(legacy) = LegacyArgs::try_parse_from(&raw) {
        execute(legacy.cli).await;
        return;
    }
    // 旧入口的帮助和错误沿用原解析器，正式子命令不做文本重写。
    if !subcommand
        && raw
            .get(1)
            .is_some_and(|arg| arg == "-p" || arg == "--print")
    {
        execute(LegacyArgs::parse_from(raw).cli).await;
        return;
    }
    let args = MultitoolCli::parse_from(raw);
    let result = match args.command {
        Some(Command::Version) => {
            println!("areal {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        Some(Command::Upgrade { check }) => upgrade::run(check).await,
        None => {
            if let Some(local) = args.interactive.local_options() {
                trajectory::warn_startup(local.config.as_deref());
            }
            areal_tui::run(args.interactive).await
        }
        Some(Command::Exec(cli)) => {
            execute(*cli).await;
            return;
        }
        Some(Command::Service { command }) => {
            service_result(service::execute(command).await);
            return;
        }
        Some(Command::Web { local, json }) => {
            service_result(service::web(*local, json).await);
            return;
        }
        Some(Command::Serve { args }) => areal_service_host::launcher::run(args).await,
        Some(Command::AppServer(args)) => areal_server::run(*args).await,
        Some(Command::Config(args)) => areal_server::diagnose(*args).await,
        Some(Command::Trajectory(options)) => trajectory::run(options),
        Some(Command::TrajectoryWorker { spool_dir }) => {
            areal_server::trajectory::run_worker(spool_dir).await
        }
        Some(Command::Workgroup { command }) => {
            let executable = std::env::current_exe()
                .expect("executable path")
                .canonicalize()
                .expect("resolve executable path");
            let runtime_bin = areal_local_service::runtime_bin_dir(executable.parent().unwrap());
            areal_server::workgroup::run(command, runtime_bin).await
        }
        Some(Command::ServiceHost) => areal_service_host::run().await,
        Some(Command::Launcher { args }) => areal_service_host::launcher::run(args).await,
    };
    if let Err(error) = result {
        eprintln!("AReaL: {error:#}");
        std::process::exit(1);
    }
}

fn is_subcommand(arg: &std::ffi::OsStr) -> bool {
    arg == "help"
        || MultitoolCli::command()
            .get_subcommands()
            .any(|command| arg == command.get_name())
}

async fn execute(args: Cli) {
    if args.endpoint.is_none() {
        trajectory::warn_startup(args.config.as_deref());
    }
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

fn service_result(result: Result<()>) {
    if let Err(error) = result {
        eprintln!(
            "{}",
            serde_json::json!({"error":{"code":"localServiceError","message":format!("{error:#}")}})
        );
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unified_routes_have_valid_help_without_starting_services() {
        MultitoolCli::command().debug_assert();
        for command in [
            vec![],
            vec!["exec"],
            vec!["version"],
            vec!["upgrade"],
            vec!["config"],
            vec!["config", "show"],
            vec!["trajectory"],
            vec!["trajectory", "status"],
            vec!["trajectory", "retry"],
            vec!["app-server"],
            vec!["service"],
            vec!["web"],
            vec!["workgroup"],
            vec!["workgroup", "run"],
        ] {
            let mut raw = vec!["areal"];
            raw.extend(command);
            raw.push("--help");
            assert_eq!(
                MultitoolCli::try_parse_from(raw).err().unwrap().kind(),
                clap::error::ErrorKind::DisplayHelp
            );
        }
    }

    #[test]
    fn scripts_and_default_interactive_mode_are_distinct() {
        assert!(
            MultitoolCli::try_parse_from(["areal"])
                .unwrap()
                .command
                .is_none()
        );
        assert!(
            MultitoolCli::try_parse_from(["areal", "inspect the code"])
                .unwrap()
                .command
                .is_none()
        );
        assert!(matches!(
            MultitoolCli::try_parse_from(["areal", "exec", "hello"])
                .unwrap()
                .command,
            Some(Command::Exec(_))
        ));
        assert!(
            MultitoolCli::try_parse_from([
                "areal",
                "--endpoint",
                "ws://localhost:1",
                "--workspace",
                "/tmp"
            ])
            .is_err()
        );
        assert!(
            MultitoolCli::try_parse_from(["areal", "--goal", "objective", "initial message"])
                .is_err()
        );
        assert!(
            MultitoolCli::try_parse_from(["areal", "--model", "ignored", "exec", "hello"]).is_err()
        );
        let args = MultitoolCli::try_parse_from(["areal", "serve", "--help"]).unwrap();
        assert!(matches!(args.command, Some(Command::Serve { args }) if args == ["--help"]));
    }

    #[test]
    fn legacy_print_requires_an_actual_flag_and_preserves_options() {
        for command in [
            "version",
            "upgrade",
            "exec",
            "serve",
            "app-server",
            "config",
            "workgroup",
            "service",
            "web",
            "service-host",
            "help",
        ] {
            assert!(is_subcommand(command.as_ref()));
            if command != "serve" {
                assert!(MultitoolCli::try_parse_from(["areal", command, "-p"]).is_err());
            }
        }
        assert!(!is_subcommand("-p".as_ref()));
        for raw in [
            vec!["areal", "-p", "hello", "--output-format", "stream-json"],
            vec![
                "areal",
                "--output-format",
                "stream-json",
                "--print",
                "hello",
            ],
        ] {
            let legacy = LegacyArgs::try_parse_from(raw).unwrap();
            assert_eq!(legacy.cli.prompt.as_deref(), Some("hello"));
            assert_eq!(legacy.cli.output_format, "stream-json");
        }
        assert!(LegacyArgs::try_parse_from(["areal", "--", "-p"]).is_err());
        assert!(LegacyArgs::try_parse_from(["areal", "exec", "--", "-p"]).is_err());
        assert!(
            MultitoolCli::try_parse_from(["areal", "--", "-p"])
                .unwrap()
                .command
                .is_none()
        );
    }
}
