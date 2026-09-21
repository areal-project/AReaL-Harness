use anyhow::{Context, Result};
use std::{path::PathBuf, process::Command};

/// Options consumed only when the TUI owns a local Core + Runtime.
#[derive(clap::Args)]
#[group(multiple = true)]
pub struct LocalArgs {
    /// Core TOML configuration file (otherwise uses Core's normal config lookup).
    #[arg(long)]
    config: Option<PathBuf>,
    /// Task workspace (defaults to the current directory).
    #[arg(long)]
    workspace: Option<PathBuf>,
    /// Override the data directory from Core configuration.
    #[arg(long)]
    data_dir: Option<PathBuf>,
    /// Grant write access; trusted binaries and data must be outside the workspace.
    #[arg(long)]
    allow_write: bool,
    #[arg(long, requires = "allow_write")]
    workgroup_policy: Option<PathBuf>,
    #[arg(long, requires = "workgroup_policy")]
    workgroup_toolchain: Option<PathBuf>,
    /// Inherit the deployment network for tool processes.
    #[arg(long)]
    allow_network: bool,
    /// Permit overlapping workspace commands.
    #[arg(long)]
    allow_concurrent_writes: bool,
    #[arg(long)]
    command_timeout_ms: Option<u64>,
    #[arg(long)]
    command_output_bytes: Option<u64>,
    /// Override the full model request URL from Core configuration.
    #[arg(long)]
    model_endpoint: Option<String>,
    #[arg(long)]
    model_protocol: Option<String>,
    /// Override the model name from Core configuration.
    #[arg(long)]
    model: Option<String>,
    /// Select a provider from Core configuration.
    #[arg(long)]
    model_provider: Option<String>,
    /// Override the credential environment variable name from Core configuration.
    #[arg(long)]
    api_key_env: Option<String>,
}

pub fn launch(args: &super::Args) -> Result<()> {
    let binary = std::env::current_exe().context("locate TUI executable")?;
    // Embed the existing trusted launcher so installed binaries need no source checkout.
    // exec keeps one owner for Core/Runtime even if the original TUI process is signalled.
    let mut command = Command::new("/usr/bin/python3");
    command
        // The task's cwd, PATH and PYTHONPATH must not supply launcher code.
        .args(["-I", "-S", "-c"])
        .arg(include_str!("../../../scripts/launch.py"))
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
    for (flag, value) in [("--no-logo", args.ui.no_logo), ("--ascii", args.ui.ascii)] {
        if let Some(value) = value {
            command.arg(format!("{flag}={value}"));
        }
    }
    for (flag, value) in [
        ("--config", &args.local.config),
        ("--workspace", &args.local.workspace),
        ("--data-dir", &args.local.data_dir),
        ("--input-file", &args.input_file),
        ("--workgroup-policy", &args.local.workgroup_policy),
        ("--workgroup-toolchain", &args.local.workgroup_toolchain),
    ] {
        if let Some(value) = value {
            let mut argument = std::ffi::OsString::from(format!("{flag}="));
            argument.push(value);
            command.arg(argument);
        }
    }
    for (flag, value) in [
        ("--model-endpoint", &args.local.model_endpoint),
        ("--model-protocol", &args.local.model_protocol),
        ("--model", &args.local.model),
        ("--model-provider", &args.local.model_provider),
        ("--api-key-env", &args.local.api_key_env),
        ("--resume", &args.resume),
        ("--prompt", &args.prompt),
    ] {
        if let Some(value) = value {
            command.arg(format!("{flag}={value}"));
        }
    }
    if args.local.allow_write {
        command.arg("--allow-write");
    }
    if args.local.allow_network {
        command.arg("--allow-network");
    }
    if args.local.allow_concurrent_writes {
        command.arg("--allow-concurrent-writes");
    }
    for (flag, value) in [
        ("--command-timeout-ms", args.local.command_timeout_ms),
        ("--command-output-bytes", args.local.command_output_bytes),
    ] {
        if let Some(value) = value {
            command.arg(format!("{flag}={value}"));
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        Err(command.exec()).context("start local Harness (Python 3.10+ is required)")
    }
    #[cfg(not(unix))]
    anyhow::bail!("local Harness requires Unix; use --endpoint to connect to an existing Core")
}

#[cfg(test)]
mod tests {
    use super::super::Args;
    use clap::Parser;

    #[test]
    fn default_is_local_and_remote_alias_is_explicit() {
        assert!(
            Args::try_parse_from(["areal-tui"])
                .unwrap()
                .endpoint
                .is_none()
        );
        let args = Args::try_parse_from([
            "areal-tui",
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
            let mut args = vec!["areal-tui", "--endpoint", "ws://127.0.0.1:4500"];
            args.extend(local);
            assert!(Args::try_parse_from(args).is_err());
        }
    }
    #[test]
    fn appearance_options_are_valid_for_both_launch_modes() {
        for endpoint in [vec![], vec!["--endpoint", "ws://127.0.0.1:4500"]] {
            let mut args = vec!["areal-tui"];
            args.extend(endpoint);
            args.extend([
                "--theme=light",
                "--color=never",
                "--ascii",
                "--no-logo=false",
            ]);
            let args = Args::try_parse_from(args).unwrap();
            assert_eq!(args.ui.theme, Some(crate::theme::Theme::Light));
            assert_eq!(args.ui.color, Some(crate::theme::ColorMode::Never));
            assert_eq!(args.ui.no_logo, Some(false));
            assert_eq!(args.ui.ascii, Some(true));
        }
    }
}
