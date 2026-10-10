use crate::storage;
use anyhow::{Context, Result, ensure};
use areal_config::{ConfigInputs, ConfigOverrides, ConfigSource};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{collections::BTreeMap, ffi::OsString, path::PathBuf};

/// 所有本地入口共用启动参数；客户端外观不属于服务配置。
#[derive(Clone, Default, clap::Args, Serialize, Deserialize)]
#[group(multiple = true)]
#[serde(deny_unknown_fields)]
pub struct LocalArgs {
    #[arg(long)]
    pub permissions: Option<String>,
    #[arg(long)]
    pub scratch: Option<PathBuf>,
    #[arg(long)]
    pub config: Option<PathBuf>,
    #[arg(long)]
    pub workspace: Option<PathBuf>,
    #[arg(long)]
    pub data_dir: Option<PathBuf>,
    #[arg(long)]
    pub allow_write: bool,
    #[arg(long)]
    pub workgroup_policy: Option<PathBuf>,
    #[arg(long, requires = "workgroup_policy")]
    pub workgroup_toolchain: Option<PathBuf>,
    #[arg(long)]
    pub allow_network: bool,
    #[arg(long)]
    pub allow_concurrent_writes: bool,
    #[arg(long)]
    pub command_timeout_ms: Option<u64>,
    /// 交互终端单独预算，不放宽普通工具的命令期限。
    #[arg(long, value_parser = clap::value_parser!(u64).range(1..=86_400_000))]
    pub desktop_process_timeout_ms: Option<u64>,
    #[arg(long)]
    pub command_output_bytes: Option<u64>,
    #[arg(long, value_parser = clap::value_parser!(u32).range(1..))]
    pub runtime_max_processes: Option<u32>,
    #[arg(long, value_parser = clap::value_parser!(u32).range(1..))]
    pub runtime_max_operations: Option<u32>,
    #[arg(long, value_parser = clap::value_parser!(u64).range(1..=17_179_869_184))]
    pub runtime_output_bytes: Option<u64>,
    #[arg(long)]
    pub model_endpoint: Option<String>,
    #[arg(long)]
    pub model_protocol: Option<String>,
    #[arg(long)]
    pub model: Option<String>,
    #[arg(long)]
    pub model_provider: Option<String>,
    #[arg(long)]
    pub api_key_env: Option<String>,
    #[arg(long)]
    pub desktop_config: Option<PathBuf>,
}

impl LocalArgs {
    pub fn launcher_args(&self) -> Vec<OsString> {
        let mut out = Vec::new();
        for (name, value) in [
            ("scratch", &self.scratch),
            ("config", &self.config),
            ("workspace", &self.workspace),
            ("data-dir", &self.data_dir),
            ("workgroup-policy", &self.workgroup_policy),
            ("workgroup-toolchain", &self.workgroup_toolchain),
            ("desktop-config", &self.desktop_config),
        ] {
            if let Some(value) = value {
                out.extend([format!("--{name}").into(), value.as_os_str().to_owned()]);
            }
        }
        for (name, value) in [
            ("permissions", &self.permissions),
            ("model-endpoint", &self.model_endpoint),
            ("model-protocol", &self.model_protocol),
            ("model", &self.model),
            ("model-provider", &self.model_provider),
            ("api-key-env", &self.api_key_env),
        ] {
            if let Some(value) = value {
                out.push(format!("--{name}={value}").into());
            }
        }
        for (name, enabled) in [
            ("allow-write", self.allow_write),
            ("allow-network", self.allow_network),
            ("allow-concurrent-writes", self.allow_concurrent_writes),
        ] {
            if enabled {
                out.push(format!("--{name}").into());
            }
        }
        for (name, value) in [
            ("command-timeout-ms", self.command_timeout_ms),
            (
                "desktop-process-timeout-ms",
                self.desktop_process_timeout_ms,
            ),
            ("command-output-bytes", self.command_output_bytes),
            ("runtime-output-bytes", self.runtime_output_bytes),
            (
                "runtime-max-operations",
                self.runtime_max_operations.map(u64::from),
            ),
            (
                "runtime-max-processes",
                self.runtime_max_processes.map(u64::from),
            ),
        ] {
            if let Some(value) = value {
                out.push(format!("--{name}={value}").into());
            }
        }
        out
    }
}

pub fn parse_agent_profile(value: &str) -> Result<areal_protocol::desktop::VersionRef> {
    let (id, revision) = value
        .rsplit_once('@')
        .context("--agent must use id@revision")?;
    ensure!(
        !id.is_empty() && !revision.is_empty(),
        "--agent must use id@revision"
    );
    ensure!(
        id.len() <= 128 && revision.len() <= 128,
        "--agent reference is too long"
    );
    ensure!(
        id.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.' | b':'))
            && revision
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.' | b':')),
        "--agent reference contains invalid characters"
    );
    Ok(areal_protocol::desktop::VersionRef {
        id: id.into(),
        revision: revision.into(),
    })
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchSpec {
    pub args: LocalArgs,
    pub home: PathBuf,
    pub bin_dir: PathBuf,
    pub launch_cwd: PathBuf,
    pub service_id: String,
    pub fingerprint: String,
    pub components: BTreeMap<String, String>,
}

impl LaunchSpec {
    pub fn resolve(args: &LocalArgs) -> Result<Self> {
        Self::in_bin(
            args,
            std::env::current_exe()?
                .canonicalize()?
                .parent()
                .context("binary directory")?
                .to_path_buf(),
        )
    }

    pub fn in_bin(args: &LocalArgs, bin_dir: PathBuf) -> Result<Self> {
        ensure!(
            args.desktop_process_timeout_ms
                .is_none_or(|value| (1..=86_400_000).contains(&value)),
            "desktop process timeout must be 1..86400000 ms"
        );
        ensure!(
            args.runtime_max_processes.is_none_or(|value| value > 0),
            "runtime max processes must be positive"
        );
        ensure!(
            args.runtime_max_operations.is_none_or(|value| value > 0),
            "runtime max operations must be positive"
        );
        ensure!(
            args.runtime_output_bytes.is_none_or(|value| value
                >= args.command_output_bytes.unwrap_or(8 * 1024 * 1024)
                && value <= 16 * 1024 * 1024 * 1024),
            "runtime output budget must cover one command and be at most 16 GiB"
        );
        let launch_cwd = std::env::current_dir()?.canonicalize()?;
        let workspace = args
            .workspace
            .as_ref()
            .unwrap_or(&launch_cwd)
            .canonicalize()?;
        ensure!(workspace.is_dir(), "workspace must be a directory");
        let inputs = ConfigInputs {
            cwd: launch_cwd.clone(),
            homedir: std::env::home_dir(),
            env: std::env::vars_os().collect(),
            config_file: args.config.clone(),
            overrides: ConfigOverrides {
                permissions: args.permissions.clone(),
                listen: Some("127.0.0.1:0".into()),
                data_dir: args.data_dir.clone(),
                model: args.model.clone(),
                model_provider: args.model_provider.clone(),
                model_endpoint: args.model_endpoint.clone(),
                model_protocol: args.model_protocol.clone(),
                api_key_env: args.api_key_env.clone(),
                ..Default::default()
            },
        };
        let config = areal_config::load_management_config(&inputs)?;
        config.credential(&inputs)?;
        let root = crate::home()?;
        let workspace_key = storage::digest(workspace.as_os_str().as_encoded_bytes());
        let mapping = root
            .join("workspaces")
            .join(format!("{workspace_key}.json"));
        let data = if matches!(
            config.sources.get("server.data_dir"),
            Some(ConfigSource::Default)
        ) {
            if mapping.exists() {
                storage::read::<PathBuf>(&mapping)?
            } else {
                let legacy = root.join("state");
                if legacy.is_dir()
                    && std::fs::read_dir(&legacy)?
                        .filter_map(Result::ok)
                        .any(|entry| entry.path().extension().is_some_and(|e| e == "json"))
                {
                    eprintln!(
                        "Existing history remains at {}. Use --data-dir to open it, or areal service bind to select it for this workspace.",
                        legacy.display()
                    );
                }
                root.join("instances")
                    .join(&workspace_key[..24])
                    .join("state")
            }
        } else {
            config.data_dir.clone()
        };
        let data = storage::canonical_pending(&data)?;
        ensure!(
            !data.starts_with(&workspace) && !root.starts_with(&workspace),
            "service state and registry must be outside the workspace"
        );
        let bin_dir = bin_dir.canonicalize()?;
        let mut binaries = BTreeMap::new();
        for name in ["areal", "areal-runtime", "areal-runtime-fs"]
            .into_iter()
            .chain(cfg!(target_os = "linux").then_some("areal-runtime-reaper"))
        {
            let directory = if name == "areal" {
                bin_dir.clone()
            } else {
                crate::runtime_bin_dir(&bin_dir)
            };
            let path = directory
                .join(name)
                .canonicalize()
                .with_context(|| format!("missing {name}; run make build"))?;
            // 比较文件内容，避免原路径被重新构建后静默复用旧服务。
            binaries.insert(name, storage::file_digest(&path)?);
        }
        let mut resolved = args.clone();
        resolved.workspace = Some(workspace.clone());
        resolved.data_dir = Some(data.clone());
        resolved.config = config.config_file.clone();
        for path in [
            &mut resolved.scratch,
            &mut resolved.workgroup_policy,
            &mut resolved.workgroup_toolchain,
            &mut resolved.desktop_config,
        ]
        .into_iter()
        .flatten()
        {
            *path = path.canonicalize()?;
        }
        let mut effective = config.diagnostic(false);
        effective["server"]["data_dir"] = json!(data);
        // 默认模型单独按版本比较；热更新不改变部署身份。
        effective.as_object_mut().unwrap().remove("model");
        let mut files = BTreeMap::new();
        for (key, path) in [
            ("extensions", config.tool_extensions_file.as_ref()),
            ("deployment", resolved.desktop_config.as_ref()),
            ("workgroup", resolved.workgroup_policy.as_ref()),
        ] {
            if let Some(path) = path {
                files.insert(key, (path, storage::file_digest(path)?));
            }
        }
        let mut components = BTreeMap::new();
        let model_environment: BTreeMap<_, _> = config
            .sources
            .iter()
            .filter_map(|(field, source)| {
                if field.starts_with("model.")
                    && let ConfigSource::Env { name } = source
                {
                    Some((
                        name,
                        inputs
                            .env
                            .get(std::ffi::OsStr::new(name))
                            .map(|v| v.to_string_lossy()),
                    ))
                } else {
                    None
                }
            })
            .collect();
        for (key, value) in [
            (
                "model-inputs",
                json!({"environment":model_environment,"cli":[args.model.clone(),args.model_provider.clone(),args.model_endpoint.clone(),args.model_protocol.clone(),args.api_key_env.clone()]}),
            ),
            ("workspace", json!(workspace)),
            ("configuration", effective),
            (
                "permissions",
                json!({"policy":config.permissions,"scratch":resolved.scratch,
                    "sandbox":"full-access","allowConcurrentWrites":args.allow_concurrent_writes}),
            ),
            (
                "runtime",
                json!({"timeout":args.command_timeout_ms.unwrap_or(300000),
                "desktopTimeout":args.desktop_process_timeout_ms,
                "output":args.command_output_bytes.unwrap_or(8*1024*1024),
                "maxProcesses":args.runtime_max_processes.unwrap_or(4),
                "maxOperations":args.runtime_max_operations.unwrap_or(4096),
                "cumulativeOutput":args.runtime_output_bytes.unwrap_or(args.command_output_bytes.unwrap_or(8*1024*1024)),"toolchain":resolved.workgroup_toolchain}),
            ),
            ("deployment", json!(files)),
            ("binaries", json!(binaries)),
        ] {
            components.insert(key.into(), storage::digest(&serde_json::to_vec(&value)?));
        }
        let fingerprint = storage::digest(&serde_json::to_vec(&components)?);
        components.insert("model".into(), config.model.fingerprint());
        let service_id = storage::digest(data.as_os_str().as_encoded_bytes())[..24].to_owned();
        storage::registry(&root, &service_id)?;
        Ok(Self {
            args: resolved,
            home: root,
            bin_dir,
            launch_cwd,
            service_id,
            fingerprint,
            components,
        })
    }

    pub fn directory(&self) -> Result<PathBuf> {
        storage::registry(&self.home, &self.service_id)
    }

    pub(crate) fn restart_command(&self) -> String {
        // PATH 中的安装版可能与当前开发版不同；保留参数以重启同一部署。
        std::iter::once(self.bin_dir.join("areal").into_os_string())
            .chain([OsString::from("service"), OsString::from("restart")])
            .chain(self.args.launcher_args())
            .map(|arg| shell_quote(&arg.to_string_lossy()))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

fn shell_quote(value: &str) -> String {
    if !value.is_empty()
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"/_-.=:".contains(&c))
    {
        value.into()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[derive(Parser)]
    struct Cli {
        #[command(flatten)]
        local: LocalArgs,
    }

    #[test]
    fn restart_command_uses_current_binary_and_preserves_deployment_args() {
        let spec = LaunchSpec {
            args: LocalArgs {
                workspace: Some("/tmp/work space".into()),
                data_dir: Some("/tmp/state".into()),
                config: Some("/tmp/user's config.toml".into()),
                runtime_max_processes: Some(32),
                permissions: Some("ASK_PERMISSIONS".into()),
                ..Default::default()
            },
            bin_dir: "/repo/target/debug".into(),
            home: "/tmp/home".into(),
            launch_cwd: "/repo".into(),
            service_id: String::new(),
            fingerprint: String::new(),
            components: BTreeMap::new(),
        };
        assert_eq!(
            spec.restart_command(),
            "/repo/target/debug/areal service restart --config '/tmp/user'\\''s config.toml' --workspace '/tmp/work space' --data-dir /tmp/state --permissions=ASK_PERMISSIONS --runtime-max-processes=32"
        );
        assert_eq!(
            shell_quote("$(touch /tmp/unwanted)"),
            "'$(touch /tmp/unwanted)'"
        );
    }

    #[test]
    fn process_capacity_is_optional_positive_and_forwarded() {
        let default = Cli::try_parse_from(["areal"]).unwrap();
        assert_eq!(default.local.runtime_max_processes, None);
        assert!(default.local.launcher_args().is_empty());
        let configured = Cli::try_parse_from(["areal", "--runtime-max-processes", "32"]).unwrap();
        assert_eq!(configured.local.runtime_max_processes, Some(32));
        assert_eq!(
            configured.local.launcher_args(),
            [OsString::from("--runtime-max-processes=32")]
        );
        for invalid in ["0", "-1", "4294967296"] {
            assert!(Cli::try_parse_from(["areal", "--runtime-max-processes", invalid]).is_err());
        }
    }

    #[test]
    fn cumulative_output_and_operations_are_validated_and_forwarded() {
        let args = Cli::try_parse_from([
            "areal",
            "--runtime-output-bytes",
            "1073741824",
            "--runtime-max-operations",
            "65536",
        ])
        .unwrap()
        .local;
        assert!(
            args.launcher_args()
                .contains(&OsString::from("--runtime-output-bytes=1073741824"))
        );
        assert!(
            args.launcher_args()
                .contains(&OsString::from("--runtime-max-operations=65536"))
        );
        for (flag, value) in [
            ("--runtime-output-bytes", "0"),
            ("--runtime-output-bytes", "17179869185"),
            ("--runtime-max-operations", "0"),
            ("--runtime-max-operations", "4294967296"),
        ] {
            assert!(Cli::try_parse_from(["areal", flag, value]).is_err());
        }
        let smaller = LocalArgs {
            runtime_output_bytes: Some(1),
            ..Default::default()
        };
        assert!(
            LaunchSpec::in_bin(&smaller, PathBuf::new())
                .err()
                .unwrap()
                .to_string()
                .contains("runtime output budget must cover one command")
        );
    }

    #[test]
    fn deserialized_zero_is_rejected_before_service_resolution() {
        let args = LocalArgs {
            runtime_max_processes: Some(0),
            ..Default::default()
        };
        let error = LaunchSpec::in_bin(&args, PathBuf::new()).err().unwrap();
        assert!(
            error
                .to_string()
                .contains("runtime max processes must be positive")
        );
    }
}
