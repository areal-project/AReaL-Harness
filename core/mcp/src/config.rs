use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};

/// Explicit trusted-host integrations; none are discovered from a workspace.
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerConfig {
    pub transport: TransportConfig,
    #[serde(default = "startup_timeout")]
    pub startup_timeout_ms: u64,
    #[serde(default = "call_timeout")]
    pub call_timeout_ms: Option<u64>,
    /// Exact MCP names. None exposes all discovered tools; an empty list exposes none.
    #[serde(default)]
    pub enabled_tools: Option<Vec<String>>,
}
fn startup_timeout() -> u64 {
    30_000
}
fn call_timeout() -> Option<u64> {
    Some(120_000)
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum TransportConfig {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        cwd: Option<PathBuf>,
        /// Environment variable names to inherit, never secret values in config.
        #[serde(default, rename = "envVars")]
        env_vars: Vec<String>,
    },
    StreamableHttp {
        url: String,
        #[serde(default, rename = "bearerTokenEnv")]
        bearer_token_env: Option<String>,
    },
}

pub fn validate(servers: &BTreeMap<String, ServerConfig>) -> Result<()> {
    ensure!(servers.len() <= 16, "at most 16 MCP servers are supported");
    for (name, config) in servers {
        ensure!(
            !name.is_empty()
                && name.len() <= 32
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
            "MCP server names must contain 1..32 ASCII letters, digits, underscores or hyphens"
        );
        validate_timeout(config.startup_timeout_ms)?;
        if let Some(timeout) = config.call_timeout_ms {
            validate_timeout(timeout)?;
        }
        if let Some(names) = &config.enabled_tools {
            ensure!(
                names.len() <= 128 && names.iter().all(|v| !v.is_empty() && v.len() <= 256),
                "invalid MCP enabledTools"
            );
        }
        match &config.transport {
            TransportConfig::Stdio {
                command,
                args,
                cwd,
                env_vars,
            } => {
                ensure!(
                    !command.is_empty()
                        && !command.contains('\0')
                        && args.len() <= 256
                        && args.iter().all(|v| !v.contains('\0')),
                    "invalid MCP command or argv"
                );
                ensure!(
                    cwd.as_ref().is_none_or(|p| !p.as_os_str().is_empty()),
                    "MCP cwd cannot be empty"
                );
                ensure!(
                    env_vars.len() <= 64 && env_vars.iter().all(|v| valid_env(v)),
                    "invalid MCP envVars"
                );
            }
            TransportConfig::StreamableHttp {
                url,
                bearer_token_env,
            } => {
                let endpoint =
                    url::Url::parse(url).map_err(|_| anyhow::anyhow!("invalid MCP HTTP URL"))?;
                ensure!(
                    matches!(endpoint.scheme(), "http" | "https")
                        && endpoint.host_str().is_some()
                        && endpoint.username().is_empty()
                        && endpoint.password().is_none()
                        && endpoint.fragment().is_none(),
                    "MCP URL requires HTTP(S), a host, and no userinfo or fragment"
                );
                ensure!(
                    bearer_token_env.as_ref().is_none_or(|v| valid_env(v)),
                    "invalid MCP bearerTokenEnv"
                );
            }
        }
    }
    Ok(())
}
fn valid_env(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .enumerate()
            .all(|(i, b)| b.is_ascii_alphabetic() || b == b'_' || (i > 0 && b.is_ascii_digit()))
}

fn validate_timeout(ms: u64) -> Result<()> {
    ensure!(
        ms > 0
            && std::time::Instant::now()
                .checked_add(std::time::Duration::from_millis(ms))
                .is_some(),
        "MCP timeout must be positive and representable on this platform"
    );
    Ok(())
}
