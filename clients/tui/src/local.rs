use anyhow::{Context, Result};
use std::process::Command;

pub use areal_local_service::LocalArgs;

pub fn launch(args: &super::Args) -> Result<()> {
    let binary = std::env::current_exe()
        .context("locate TUI executable")?
        .canonicalize()
        .context("resolve installed TUI executable")?;
    // exec 后由独立进程持有 Core/Runtime，终端退出仍能可靠清理。
    let mut command = Command::new(&binary);
    command
        .arg("launcher")
        .arg("--bin-dir")
        .arg(binary.parent().context("locate sibling Harness binaries")?)
        .arg("--tui");
    // 客户端选项必须穿过 launcher，且不能进入 Core 配置参数。
    if let Some(theme) = args.ui.theme {
        command.arg(format!("--theme={}", theme.key()));
    }
    if let Some(color) = args.ui.color {
        command.arg(format!("--color={}", color.key()));
    }
    if let Some(path) = &args.ui.tui_config {
        let mut argument = std::ffi::OsString::from("--tui-config=");
        argument.push(std::path::absolute(path).context("locate TUI preferences")?);
        command.arg(argument);
    }
    for (flag, value) in [
        ("--no-logo", args.ui.no_logo),
        ("--ascii", args.ui.ascii),
        ("--mouse", args.ui.mouse),
    ] {
        if let Some(value) = value {
            command.arg(format!("{flag}={value}"));
        }
    }
    command.args(args.local.launcher_args());
    if args.no_session_name {
        command.arg("--no-session-name");
    }
    if let Some(agent) = &args.agent {
        command.arg(format!("--agent={agent}"));
    }
    if let Some(value) = &args.input_file {
        command.arg("--input-file").arg(value);
    }
    for (flag, value) in [
        ("--resume", &args.resume),
        ("--prompt", &args.prompt),
        ("--goal", &args.goal),
    ] {
        if let Some(value) = value {
            command.arg(format!("{flag}={value}"));
        }
    }
    if let Some(prompt) = &args.initial_prompt {
        command.arg(format!("--initial-prompt={prompt}"));
    }
    if let Some(budget) = args.goal_token_budget {
        command.arg(format!("--goal-token-budget={budget}"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        Err(command.exec()).context("start local Harness")
    }
    #[cfg(not(unix))]
    anyhow::bail!("local Harness requires Unix; use --endpoint to connect to an existing Core")
}

#[cfg(test)]
mod tests {
    use super::super::Args;
    use clap::Parser;

    #[test]
    fn only_final_local_clients_monitor_trajectory() {
        let shared = Args::try_parse_from(["areal", "--config", "chosen.toml"]).unwrap();
        assert_eq!(
            shared.trajectory_monitor_config(),
            Some(Some("chosen.toml".into()))
        );
        for args in [
            vec!["areal", "--local-mode", "owned"],
            vec!["areal", "--prompt", "hello"],
        ] {
            assert!(
                Args::try_parse_from(args)
                    .unwrap()
                    .trajectory_monitor_config()
                    .is_none()
            );
        }
        let remote = ["areal", "--endpoint", "ws://localhost:1234"];
        assert!(
            Args::try_parse_from(remote)
                .unwrap()
                .trajectory_monitor_config()
                .is_none()
        );
        let owned = Args::try_parse_from(remote.into_iter().chain([
            "--local-trajectory-monitor",
            "--local-trajectory-config",
            "/resolved/chosen.toml",
        ]))
        .unwrap();
        assert_eq!(
            owned.trajectory_monitor_config(),
            Some(Some("/resolved/chosen.toml".into()))
        );
        assert!(Args::try_parse_from(["areal", "--local-trajectory-monitor"]).is_err());
        assert!(
            Args::try_parse_from(
                remote
                    .into_iter()
                    .chain(["--local-trajectory-config", "/resolved/chosen.toml"])
            )
            .is_err()
        );
    }

    #[test]
    fn default_is_local_and_remote_alias_is_explicit() {
        assert!(Args::try_parse_from(["areal"]).unwrap().endpoint.is_none());
        let args = Args::try_parse_from([
            "areal",
            "--remote",
            "ws://127.0.0.1:4500",
            "--resume",
            "thread-id",
        ])
        .unwrap();
        assert_eq!(args.endpoint.as_deref(), Some("ws://127.0.0.1:4500"));
        assert_eq!(args.resume.as_deref(), Some("thread-id"));
    }

    #[test]
    fn agent_profile_is_selected_by_id_and_revision() {
        let args = Args::try_parse_from(["areal", "--prompt", "hello", "--agent", "code-agent@v2"])
            .unwrap();
        assert_eq!(args.agent.as_deref(), Some("code-agent@v2"));
        assert_eq!(
            areal_local_service::parse_agent_profile(args.agent.as_deref().unwrap())
                .unwrap()
                .id,
            "code-agent"
        );
        let remote = Args::try_parse_from([
            "areal",
            "--endpoint",
            "ws://127.0.0.1:4500",
            "--prompt",
            "hello",
            "--agent",
            "code-agent@v2",
        ])
        .unwrap();
        assert_eq!(remote.agent.as_deref(), Some("code-agent@v2"));
    }

    #[test]
    fn remote_rejects_local_configuration_instead_of_ignoring_it() {
        for local in [
            vec!["--config", "/tmp/config.toml"],
            vec!["--model-provider", "company"],
            vec!["--workspace", "/tmp/workspace"],
            vec!["--data-dir", "/tmp/data"],
            vec!["--model", "model"],
            vec!["--model-endpoint", "http://localhost/model"],
            vec!["--api-key-env", "KEY"],
            vec!["--allow-write"],
        ] {
            let mut args = vec!["areal", "--endpoint", "ws://127.0.0.1:4500"];
            args.extend(local);
            assert!(Args::try_parse_from(args).is_err());
        }
    }
    #[test]
    fn appearance_options_are_valid_for_both_launch_modes() {
        for endpoint in [vec![], vec!["--endpoint", "ws://127.0.0.1:4500"]] {
            let mut args = vec!["areal"];
            args.extend(endpoint);
            args.extend([
                "--theme=light",
                "--color=never",
                "--ascii",
                "--no-logo=false",
                "--mouse=false",
            ]);
            let args = Args::try_parse_from(args).unwrap();
            assert_eq!(args.ui.theme, Some(crate::theme::Theme::Light));
            assert_eq!(args.ui.color, Some(crate::theme::ColorMode::Never));
            assert_eq!(args.ui.no_logo, Some(false));
            assert_eq!(args.ui.ascii, Some(true));
            assert_eq!(args.ui.mouse, Some(false));
        }
    }
}
