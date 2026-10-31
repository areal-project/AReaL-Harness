//! 包清单仅在可信 Core 内保存字面量；公开投影不包含进程参数或凭据。
use crate::{ServerConfig, TransportConfig};
use anyhow::{Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize)]
pub struct PluginDiagnostic {
    pub server: String,
    pub message: String,
}
#[derive(Default, Debug)]
pub struct PluginConfigOutcome {
    pub servers: BTreeMap<String, PluginServerConfig>,
    pub diagnostics: Vec<PluginDiagnostic>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ToolPolicy {
    pub enabled: Option<bool>,
    pub approval_mode: Option<ApprovalMode>,
    pub output_token_limit: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalMode {
    Auto,
    Prompt,
    Writes,
    Approve,
}
#[derive(Clone, Debug, Default, Serialize, schemars::JsonSchema)]
pub struct PluginPolicy {
    pub enabled: bool,
    pub required: bool,
    pub default_tools_approval_mode: Option<ApprovalMode>,
    pub disabled_tools: Vec<String>,
    pub tools: BTreeMap<String, ToolPolicy>,
}
#[derive(Clone, Default)]
pub struct AuthPolicy {
    pub(crate) portable_declaration: Option<Value>,
    pub(crate) unsupported: bool,
    pub(crate) client_id: Option<String>,
    pub(crate) client_secret: Option<String>,
    pub(crate) client_metadata_url: Option<String>,
    pub(crate) scopes: Vec<String>,
    pub(crate) callback_port: Option<u16>,
    pub(crate) callback_url: Option<String>,
}
impl AuthPolicy {
    pub fn mode(&self) -> &str {
        self.portable_declaration
            .as_ref()
            .and_then(|v| v["type"].as_str())
            .unwrap_or("oauth")
    }
    pub fn requirements(&self) -> Value {
        let declaration = self.portable_declaration.as_ref();
        let method = declaration
            .and_then(|v| v["client"]["tokenEndpointAuthMethod"].as_str())
            .unwrap_or("none");
        json!({"mode":self.mode(),"apiKey":self.mode()=="api_key", "clientSecret":matches!(method,"client_secret_basic"|"client_secret_post"),"privateKey":method=="private_key_jwt", "tokenEndpointAuthMethod":method,"headerScheme":declaration.and_then(|v|v["headerScheme"].as_str()),"cimdFallback":"dcr"})
    }
    /// Portable policy declaration is retained internally; this reports whether the current host can execute it.
    pub fn is_supported(&self) -> bool {
        !self.unsupported
    }
}
impl std::fmt::Debug for AuthPolicy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AuthPolicy([REDACTED])")
    }
}
#[derive(Clone)]
pub struct PluginServerConfig {
    pub(crate) config: ServerConfig,
    pub(crate) env: BTreeMap<String, String>,
    pub(crate) headers: BTreeMap<String, String>,
    pub(crate) env_headers: BTreeMap<String, String>,
    pub(crate) policy: PluginPolicy,
    pub(crate) auth: Option<AuthPolicy>,
}
impl std::fmt::Debug for PluginServerConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PluginServerConfig([REDACTED])")
    }
}
impl PluginServerConfig {
    pub fn endpoint(&self) -> Option<&str> {
        match &self.config.transport {
            TransportConfig::StreamableHttp { url, .. } => Some(url),
            _ => None,
        }
    }
    pub fn policy(&self) -> &PluginPolicy {
        &self.policy
    }
    pub fn restrict_enabled(&mut self, enabled: bool) {
        self.policy.enabled &= enabled;
    }
    pub fn auth_policy(&self) -> Option<&AuthPolicy> {
        self.auth.as_ref()
    }
    pub fn redacted_view(&self) -> Value {
        json!({"transport":match self.config.transport {TransportConfig::Stdio{..}=>"stdio", _=>"streamable-http"},"enabled":self.policy.enabled,"authentication":self.auth.is_some(),"authenticationSupported":self.auth.as_ref().is_none_or(AuthPolicy::is_supported),"authenticationRequirements":self.auth.as_ref().map(AuthPolicy::requirements),"startupTimeoutMs":self.config.startup_timeout_ms,"callTimeoutMs":self.config.call_timeout_ms,"enabledTools":self.config.enabled_tools,"disabledTools":self.policy.disabled_tools})
    }
}
const OWNED: &[&str] = &[
    "accept",
    "authorization",
    "connection",
    "content-encoding",
    "content-length",
    "content-type",
    "host",
    "last-event-id",
    "mcp-protocol-version",
    "mcp-session-id",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "user-agent",
];
fn strings(v: Option<&Value>) -> Result<BTreeMap<String, String>> {
    v.map(|v| serde_json::from_value(v.clone()).map_err(|_| anyhow::anyhow!("expected string map")))
        .unwrap_or_else(|| Ok(BTreeMap::new()))
}
fn names(v: Option<&Value>) -> Result<Vec<String>> {
    v.map(|v| serde_json::from_value(v.clone()).map_err(|_| anyhow::anyhow!("expected name list")))
        .unwrap_or_else(|| Ok(Vec::new()))
}
fn text(v: Option<&Value>) -> Result<Option<String>> {
    v.map(|v| {
        v.as_str()
            .map(str::to_owned)
            .ok_or_else(|| anyhow::anyhow!("expected string"))
    })
    .transpose()
}
fn absolute(p: &Path) -> Result<PathBuf> {
    resolve(&if p.is_absolute() {
        p.to_owned()
    } else {
        std::env::current_dir()?.join(p)
    })
}
fn resolve(p: &Path) -> Result<PathBuf> {
    let mut q = p.to_owned();
    let mut tail = Vec::new();
    loop {
        match std::fs::canonicalize(&q) {
            Ok(mut root) => {
                for c in tail.iter().rev() {
                    root.push(c)
                }
                return Ok(root);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                ensure!(
                    !std::fs::symlink_metadata(&q).is_ok_and(|m| m.file_type().is_symlink()),
                    "dangling package symlink"
                );
                let c = q
                    .file_name()
                    .ok_or_else(|| anyhow::anyhow!("invalid package path"))?
                    .to_owned();
                tail.push(c);
                ensure!(q.pop(), "invalid package path");
            }
            Err(_) => bail!("cannot resolve package path"),
        }
    }
}
fn contained(root: &Path, suffix: &str) -> Result<PathBuf> {
    ensure!(!suffix.contains('\\'), "nonportable package path");
    let mut p = root.to_owned();
    for c in Path::new(suffix).components() {
        match c {
            std::path::Component::Normal(s) => p.push(s),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                ensure!(p != root, "package path escapes root");
                p.pop();
            }
            _ => bail!("absolute package suffix"),
        }
    }
    let p = resolve(&p)?;
    ensure!(p.starts_with(root), "package path escapes root");
    Ok(p)
}
fn expand(s: &str, root: &Path, data: &Path) -> String {
    // 单次替换，不再解释路径本身含有的占位符。
    let mut result = String::new();
    let mut rest = s;
    while let Some(i) = rest.find("${PLUGIN_") {
        result.push_str(&rest[..i]);
        rest = &rest[i..];
        if let Some(t) = rest.strip_prefix("${PLUGIN_ROOT}") {
            result.push_str(&root.to_string_lossy());
            rest = t
        } else if let Some(t) = rest.strip_prefix("${PLUGIN_DATA}") {
            result.push_str(&data.to_string_lossy());
            rest = t
        } else {
            result.push_str("${PLUGIN_");
            rest = &rest[9..]
        }
    }
    result.push_str(rest);
    result
}
#[derive(Clone)]
pub struct UserConfigBinding {
    pub value: String,
    pub sensitive: bool,
}
impl std::fmt::Debug for UserConfigBinding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("UserConfigBinding([REDACTED])")
    }
}
fn user_config_text(text: &str, mut replace: impl FnMut(&str) -> Result<String>) -> Result<String> {
    ensure!(
        !text.contains("${userConfig."),
        "unsupported userConfig reference syntax"
    );
    let mut result = String::new();
    let mut rest = text;
    while let Some(index) = rest.find("${user_config.") {
        result.push_str(&rest[..index]);
        let tail = &rest[index + "${user_config.".len()..];
        let end = tail
            .find('}')
            .ok_or_else(|| anyhow::anyhow!("unterminated userConfig reference"))?;
        let key = &tail[..end];
        ensure!(
            !key.is_empty() && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'),
            "invalid userConfig reference"
        );
        result.push_str(&replace(key)?);
        rest = &tail[end + 1..];
    }
    result.push_str(rest);
    Ok(result)
}
fn map_user_config(
    value: &mut Value,
    path: &mut Vec<String>,
    portable: bool,
    binding: &mut impl FnMut(&str, bool) -> Result<String>,
) -> Result<()> {
    match value {
        Value::String(text) => {
            *text = user_config_text(text, |key| {
                let field = path.first().map(String::as_str).unwrap_or_default();
                let sensitive_allowed = matches!(field, "env" | "headers" | "http_headers");
                ensure!(
                    !(portable
                        && field == "headers"
                        && path.get(1).is_some_and(
                            |header| OWNED.contains(&header.to_ascii_lowercase().as_str())
                        )),
                    "reserved portable header cannot consume userConfig"
                );
                ensure!(
                    sensitive_allowed || matches!(field, "args" | "url"),
                    "userConfig reference is unsupported at this MCP field"
                );
                binding(key, sensitive_allowed)
            })?;
        }
        Value::Array(values) => {
            for value in values {
                map_user_config(value, path, portable, binding)?;
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                path.push(key.clone());
                map_user_config(value, path, portable, binding)?;
                path.pop();
            }
        }
        _ => {}
    }
    Ok(())
}
/// Sensitive declaration input. Only envelope identities and normalized configurations leave it.
#[derive(Clone)]
pub struct PluginDeclaration {
    portable: bool,
    nested: bool,
    value: Value,
    document_error: Option<&'static str>,
    user_config_bound: bool,
}

pub enum PluginEnvelopeEntry<'a> {
    Server {
        nested: bool,
        name: &'a str,
        object: bool,
    },
    Empty {
        nested: bool,
    },
    Invalid {
        nested: bool,
    },
}

impl std::fmt::Debug for PluginDeclaration {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PluginDeclaration")
            .field("portable", &self.portable)
            .field("servers", &self.servers().map(serde_json::Map::len))
            .finish()
    }
}

impl PluginDeclaration {
    pub fn parse(portable: bool, value: Value) -> Self {
        let nested = value.get("mcpServers").is_some();
        let document_error = match value.as_object() {
            None => Some("MCP document must be an object"),
            Some(obj)
                if portable
                    && obj.get("$schema").and_then(Value::as_str)
                        != Some("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json") =>
            {
                Some("unsupported Agent Plugins MCP schema")
            }
            Some(obj) if portable && !obj.keys().all(|k| k == "$schema" || k == "mcpServers") => {
                Some("unknown Agent Plugins MCP document field")
            }
            Some(obj)
                if (portable || nested) && !obj.get("mcpServers").is_some_and(Value::is_object) =>
            {
                Some("mcpServers must be an object")
            }
            Some(_) => None,
        };
        Self {
            portable,
            nested,
            value,
            document_error,
            user_config_bound: false,
        }
    }

    fn servers(&self) -> Option<&serde_json::Map<String, Value>> {
        if self.nested {
            &self.value["mcpServers"]
        } else {
            &self.value
        }
        .as_object()
    }

    /// Static support recognizes envelopes even when runtime schema validation will reject them.
    pub fn envelope(&self) -> impl ExactSizeIterator<Item = PluginEnvelopeEntry<'_>> {
        let nested = self.nested;
        let rows: Vec<_> = match self.servers() {
            None => vec![PluginEnvelopeEntry::Invalid { nested }],
            Some(servers) if servers.is_empty() => vec![PluginEnvelopeEntry::Empty { nested }],
            Some(servers) => servers
                .iter()
                .map(|(name, value)| PluginEnvelopeEntry::Server {
                    nested,
                    name,
                    object: value.is_object(),
                })
                .collect(),
        };
        rows.into_iter()
    }

    /// Returns true when a previously nonempty document is completely shadowed.
    pub fn retain_servers(&mut self, mut keep: impl FnMut(&str) -> bool) -> bool {
        let value = if self.nested {
            &mut self.value["mcpServers"]
        } else {
            &mut self.value
        };
        if let Some(servers) = value.as_object_mut() {
            let had_servers = !servers.is_empty();
            servers.retain(|name, _| keep(name));
            had_servers && servers.is_empty()
        } else {
            false
        }
    }

    pub fn references_user_config(&self) -> bool {
        fn references(value: &Value) -> bool {
            match value {
                Value::String(s) => s.contains("${user_config.") || s.contains("${userConfig."),
                Value::Array(values) => values.iter().any(references),
                Value::Object(values) => values.values().any(references),
                _ => false,
            }
        }
        references(&self.value)
    }

    pub fn validate_user_config(&self, fields: &BTreeMap<String, bool>) -> Result<()> {
        let mut copy = self.clone();
        let servers = if copy.nested {
            &mut copy.value["mcpServers"]
        } else {
            &mut copy.value
        };
        if let Some(servers) = servers.as_object_mut() {
            for server in servers.values_mut() {
                map_user_config(
                    server,
                    &mut vec![],
                    self.portable,
                    &mut |key, sensitive_allowed| {
                        let sensitive = fields
                            .get(key)
                            .ok_or_else(|| anyhow::anyhow!("unknown userConfig reference"))?;
                        ensure!(
                            !sensitive || sensitive_allowed,
                            "sensitive userConfig is restricted to MCP env or headers"
                        );
                        Ok(String::new())
                    },
                )?;
            }
        }
        ensure!(
            !copy.references_user_config(),
            "userConfig reference is unsupported outside MCP server values"
        );
        Ok(())
    }
    pub fn bind_user_config(&self, values: &BTreeMap<String, UserConfigBinding>) -> Result<Self> {
        self.validate_user_config(
            &values
                .iter()
                .map(|(key, binding)| (key.clone(), binding.sensitive))
                .collect(),
        )?;
        let mut copy = self.clone();
        let servers = if copy.nested {
            &mut copy.value["mcpServers"]
        } else {
            &mut copy.value
        };
        if let Some(servers) = servers.as_object_mut() {
            for server in servers.values_mut() {
                map_user_config(
                    server,
                    &mut vec![],
                    self.portable,
                    &mut |key, sensitive_allowed| {
                        let binding = values.get(key).ok_or_else(|| {
                            anyhow::anyhow!("required userConfig value is missing")
                        })?;
                        ensure!(
                            !binding.sensitive || sensitive_allowed,
                            "sensitive userConfig is restricted to MCP env or headers"
                        );
                        Ok(binding.value.clone())
                    },
                )?;
            }
        }
        copy.user_config_bound = true;
        Ok(copy)
    }
    pub fn normalize(&self, package_root: &Path, data_root: &Path) -> Result<PluginConfigOutcome> {
        ensure!(
            self.user_config_bound || !self.references_user_config(),
            "userConfig values must be bound before normalization"
        );
        if let Some(error) = self.document_error {
            bail!(error);
        }
        let servers = self.servers().expect("validated MCP envelope");
        ensure!(servers.len() <= 16, "at most 16 MCP servers are supported");
        let root = absolute(package_root)?;
        let data = absolute(data_root)?;
        let mut out = PluginConfigOutcome::default();
        for (name, v) in servers {
            match normalize(self.portable, v, &root, &data).and_then(|s| {
                crate::validate(&[(name.clone(), s.config.clone())].into())?;
                Ok(s)
            }) {
                Ok(s) => {
                    if self.portable && v.get("extensions").is_some() {
                        out.diagnostics.push(PluginDiagnostic { server: name.clone(), message: "Portable authentication extension retained; pinned Codex rejects extensions".into() });
                    }
                    if s.auth.as_ref().is_some_and(|p| !p.is_supported()) {
                        out.diagnostics.push(PluginDiagnostic { server:name.clone(), message:"Authentication declaration retained but requires additional host support".into() });
                    }
                    out.servers.insert(name.clone(), s);
                }
                Err(error) => out.diagnostics.push(PluginDiagnostic {
                    server: name.clone(),
                    message: error.to_string(),
                }),
            }
        }
        Ok(out)
    }
}
pub fn normalize_plugin_document(
    portable: bool,
    value: &Value,
    package_root: &Path,
    data_root: &Path,
) -> Result<PluginConfigOutcome> {
    PluginDeclaration::parse(portable, value.clone()).normalize(package_root, data_root)
}
fn normalize(portable: bool, v: &Value, root: &Path, data: &Path) -> Result<PluginServerConfig> {
    let o = v
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("server must be object"))?;
    let kind = o.get("type").and_then(Value::as_str);
    ensure!(
        kind != Some("sse"),
        "legacy SSE transport is not supported by Codex"
    );
    if portable {
        let allowed = match kind {
            Some("stdio") => vec!["type", "command", "args", "env", "cwd", "extensions"],
            Some("streamable-http") => vec!["type", "url", "headers", "extensions"],
            _ => bail!("unsupported transport"),
        };
        ensure!(
            o.keys().all(|k| allowed.contains(&k.as_str())),
            "unsupported portable server field"
        );
    }
    if !portable {
        ensure!(
            o.keys().all(|k| [
                "type",
                "command",
                "args",
                "env",
                "cwd",
                "env_vars",
                "url",
                "auth",
                "bearer_token_env_var",
                "http_headers",
                "env_http_headers",
                "startup_timeout_sec",
                "startup_timeout_ms",
                "tool_timeout_sec",
                "enabled",
                "required",
                "enabled_tools",
                "disabled_tools",
                "default_tools_approval_mode",
                "tools",
                "oauth"
            ]
            .contains(&k.as_str())),
            "unsupported legacy MCP server field"
        );
    }
    if let Some(kind) = kind {
        ensure!(
            ["stdio", "http", "streamable-http", "streamable_http"].contains(&kind),
            "unsupported MCP transport"
        );
    }
    ensure!(
        !(o.contains_key("command") && o.contains_key("url")),
        "ambiguous MCP transport"
    );
    let mut env = strings(o.get("env"))?;
    let mut headers = strings(o.get(if portable { "headers" } else { "http_headers" }))?;
    let env_headers = strings(o.get("env_http_headers"))?;
    let mut seen = BTreeSet::new();
    for (k, v) in &headers {
        ensure!(seen.insert(k.to_ascii_lowercase()), "duplicate HTTP header");
        reqwest_mcp::header::HeaderName::from_bytes(k.as_bytes())
            .map_err(|_| anyhow::anyhow!("invalid HTTP header"))?;
        reqwest_mcp::header::HeaderValue::from_str(v)
            .map_err(|_| anyhow::anyhow!("invalid HTTP header"))?;
    }
    if portable {
        headers.retain(|k, _| !OWNED.contains(&k.to_ascii_lowercase().as_str()));
    } else {
        ensure!(
            headers
                .keys()
                .all(|k| k.eq_ignore_ascii_case("authorization")
                    || !OWNED.contains(&k.to_ascii_lowercase().as_str())),
            "reserved HTTP header"
        );
    }
    for (k, v) in &env_headers {
        ensure!(
            (!OWNED.contains(&k.to_ascii_lowercase().as_str())
                || (!portable && k.eq_ignore_ascii_case("authorization")))
                && seen.insert(k.to_ascii_lowercase()),
            "reserved or duplicate HTTP header"
        );
        ensure!(
            crate::config::valid_env(v),
            "invalid header environment reference"
        );
        reqwest_mcp::header::HeaderName::from_bytes(k.as_bytes())
            .map_err(|_| anyhow::anyhow!("invalid HTTP header"))?;
    }
    let transport = if let Some(mut command) = text(o.get("command"))? {
        let mut args = names(o.get("args"))?;
        let cwd = text(o.get("cwd"))?;
        let cwd = if portable {
            ensure!(
                !env.contains_key("PLUGIN_ROOT") && !env.contains_key("PLUGIN_DATA"),
                "reserved environment variable"
            );
            if command.starts_with("./") {
                command = contained(root, &command[2..])?
                    .to_string_lossy()
                    .into_owned()
            } else {
                ensure!(
                    !command.contains('/') && !command.contains('\\'),
                    "portable command must be bare or contained"
                );
            }
            for a in &mut args {
                *a = expand(a, root, data)
            }
            for v in env.values_mut() {
                *v = expand(v, root, data)
            }
            env.insert("PLUGIN_ROOT".into(), root.to_string_lossy().into_owned());
            env.insert("PLUGIN_DATA".into(), data.to_string_lossy().into_owned());
            let c = cwd.as_deref().unwrap_or("${PLUGIN_ROOT}");
            let (r, s) = if let Some(s) = c.strip_prefix("./") {
                (root, s)
            } else if c == "${PLUGIN_ROOT}" {
                (root, "")
            } else if c == "${PLUGIN_DATA}" {
                (data, "")
            } else if let Some(s) = c.strip_prefix("${PLUGIN_ROOT}/") {
                (root, s)
            } else if let Some(s) = c.strip_prefix("${PLUGIN_DATA}/") {
                (data, s)
            } else {
                bail!("invalid portable cwd")
            };
            Some(contained(r, s)?)
        } else {
            cwd.map(|s| root.join(s))
        };
        for (k, v) in &env {
            ensure!(
                crate::config::valid_env(k) && !v.contains('\0'),
                "invalid process environment"
            );
        }
        TransportConfig::Stdio {
            command,
            args,
            cwd,
            env_vars: o
                .get("env_vars")
                .map(|v| -> Result<Vec<String>> {
                    v.as_array()
                        .ok_or_else(|| anyhow::anyhow!("invalid environment references"))?
                        .iter()
                        .map(|v| {
                            if let Some(s) = v.as_str() {
                                return Ok(s.to_owned());
                            }
                            let o = v
                                .as_object()
                                .ok_or_else(|| anyhow::anyhow!("invalid environment reference"))?;
                            ensure!(
                                o.keys().all(|k| k == "name" || k == "source")
                                    && o.get("source").is_none_or(|v| v == "local"),
                                "remote environment references unsupported"
                            );
                            text(o.get("name"))?.ok_or_else(|| {
                                anyhow::anyhow!("missing environment reference name")
                            })
                        })
                        .collect()
                })
                .transpose()?
                .unwrap_or_default(),
        }
    } else {
        ensure!(env.is_empty(), "HTTP process environment unsupported");
        let url = text(o.get("url"))?.ok_or_else(|| anyhow::anyhow!("missing URL"))?;
        if portable {
            let u = url::Url::parse(&url).map_err(|_| anyhow::anyhow!("invalid URL"))?;
            let loopback = match u.host() {
                Some(url::Host::Domain(h)) => h == "localhost",
                Some(url::Host::Ipv4(a)) => a.is_loopback(),
                Some(url::Host::Ipv6(a)) => a.is_loopback(),
                _ => false,
            };
            ensure!(
                u.scheme() == "https" || (u.scheme() == "http" && loopback),
                "remote URL requires HTTPS"
            );
        }
        TransportConfig::StreamableHttp {
            url,
            bearer_token_env: text(o.get("bearer_token_env_var"))?,
        }
    };
    let timeout = |key: &str, default: u64| -> Result<u64> {
        o.get(key)
            .map(|v| {
                v.as_f64()
                    .filter(|x| x.is_finite() && *x > 0.0 && *x <= u64::MAX as f64 / 1000.0)
                    .map(|x| (x * 1000.0) as u64)
                    .ok_or_else(|| anyhow::anyhow!("invalid timeout"))
            })
            .unwrap_or(Ok(default))
    };
    let enabled = o
        .get("enabled")
        .map(|v| {
            v.as_bool()
                .ok_or_else(|| anyhow::anyhow!("invalid enabled"))
        })
        .transpose()?
        .unwrap_or(true);
    let tools: BTreeMap<String, ToolPolicy> = o
        .get("tools")
        .map(|v| {
            serde_json::from_value(v.clone()).map_err(|_| anyhow::anyhow!("invalid tool policy"))
        })
        .transpose()?
        .unwrap_or_default();
    ensure!(
        tools
            .values()
            .all(|t| t.output_token_limit.is_none_or(|n| n > 0)),
        "invalid output token limit"
    );
    let mut auth = o
        .get("oauth")
        .map(|v| -> Result<AuthPolicy> {
            let o = v
                .as_object()
                .ok_or_else(|| anyhow::anyhow!("invalid OAuth"))?;
            Ok(AuthPolicy {
                portable_declaration: None,
                unsupported: false,
                client_id: text(o.get("client_id").or(o.get("clientId")))?,
                client_secret: text(o.get("client_secret").or(o.get("clientSecret")))?,
                client_metadata_url: text(o.get("client_metadata_url"))?,
                scopes: names(o.get("scopes"))?,
                callback_url: text(o.get("callback_url").or(o.get("callbackUrl")))?,
                callback_port: o
                    .get("callback_port")
                    .or(o.get("callbackPort"))
                    .map(|v| {
                        v.as_u64()
                            .and_then(|n| u16::try_from(n).ok())
                            .ok_or_else(|| anyhow::anyhow!("invalid callback port"))
                    })
                    .transpose()?,
            })
        })
        .transpose()?;
    ensure!(
        o.get("auth").is_none_or(|v| v == "oauth"),
        "enterprise authentication requires host policy"
    );
    if auth.is_none() && o.get("auth").is_some_and(|v| v == "oauth") {
        auth = Some(AuthPolicy::default());
    }
    if portable && let Some(extensions) = o.get("extensions") {
        let extensions = extensions
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("invalid extensions"))?;
        let nested = extensions.get("com.openai").and_then(|v| v.get("auth"));
        let dotted = extensions.get("com.openai.auth");
        ensure!(
            nested.is_none() || dotted.is_none(),
            "duplicate authentication declaration"
        );
        if let Some(v) = nested.or(dotted) {
            auth = portable_auth(v)?;
        }
    }
    Ok(PluginServerConfig {
        config: ServerConfig {
            transport,
            startup_timeout_ms: if let Some(v) = o.get("startup_timeout_ms") {
                ensure!(
                    !o.contains_key("startup_timeout_sec"),
                    "duplicate startup timeout"
                );
                v.as_u64()
                    .ok_or_else(|| anyhow::anyhow!("invalid startup timeout"))?
            } else {
                timeout("startup_timeout_sec", 10000)?
            },
            call_timeout_ms: Some(timeout("tool_timeout_sec", 60000)?),
            enabled_tools: o.get("enabled_tools").map(|v| names(Some(v))).transpose()?,
        },
        env,
        headers,
        env_headers,
        policy: PluginPolicy {
            enabled,
            required: o
                .get("required")
                .map(|v| {
                    v.as_bool()
                        .ok_or_else(|| anyhow::anyhow!("invalid required"))
                })
                .transpose()?
                .unwrap_or(false),
            default_tools_approval_mode: o
                .get("default_tools_approval_mode")
                .map(|v| {
                    serde_json::from_value(v.clone())
                        .map_err(|_| anyhow::anyhow!("invalid approval mode"))
                })
                .transpose()?,
            disabled_tools: names(o.get("disabled_tools"))?,
            tools,
        },
        auth,
    })
}

// Keep the portable declaration in the trusted owner. Unsupported credential
// mechanisms remain explicit policies instead of silently becoming anonymous.
fn portable_auth(v: &Value) -> Result<Option<AuthPolicy>> {
    let o = v
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("invalid portable authentication"))?;
    let kind = o
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("missing authentication type"))?;
    ensure!(
        ["none", "oauth", "mixed", "api_key"].contains(&kind),
        "unsupported authentication type"
    );
    let allowed: &[&str] = match kind {
        "none" => &["type"],
        "api_key" => &["type", "headerScheme", "headerName"],
        _ => &[
            "type",
            "client",
            "authorizationUrl",
            "tokenUrl",
            "registrationUrl",
            "authorizationServerBase",
            "resource",
            "baseScopes",
            "defaultScopes",
            "oidcEnabled",
            "oidcConfigurationUrl",
            "oidcUserinfoEndpoint",
            "oidcScopesSupported",
        ],
    };
    ensure!(
        o.keys().all(|k| allowed.contains(&k.as_str())),
        "unsupported authentication declaration field"
    );
    if let Some(v) = o.get("oidcEnabled") {
        ensure!(v.is_boolean(), "invalid OIDC override");
    }
    if kind == "none" {
        return Ok(None);
    }
    let mut policy = AuthPolicy {
        portable_declaration: Some(v.clone()),
        unsupported: false,
        ..Default::default()
    };
    for key in [
        "authorizationUrl",
        "tokenUrl",
        "registrationUrl",
        "authorizationServerBase",
        "resource",
        "oidcConfigurationUrl",
        "oidcUserinfoEndpoint",
    ] {
        if let Some(raw) = o.get(key) {
            let u = url::Url::parse(
                raw.as_str()
                    .ok_or_else(|| anyhow::anyhow!("invalid authentication URL"))?,
            )
            .map_err(|_| anyhow::anyhow!("invalid authentication URL"))?;
            ensure!(
                matches!(u.scheme(), "https" | "http")
                    && u.host_str().is_some()
                    && u.username().is_empty()
                    && u.password().is_none()
                    && u.fragment().is_none(),
                "invalid authentication URL"
            );
        }
    }
    for key in ["baseScopes", "defaultScopes", "oidcScopesSupported"] {
        let values = names(o.get(key))?;
        ensure!(
            values.iter().all(|s| !s.trim().is_empty()),
            "invalid OAuth scope"
        );
        if key != "oidcScopesSupported" {
            policy.scopes.extend(values);
        }
    }
    policy.scopes.sort();
    policy.scopes.dedup();
    if let Some(client) = o.get("client") {
        let client = client
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("invalid OAuth client"))?;
        ensure!(
            !client.contains_key("clientSecret") && !client.contains_key("credentials"),
            "portable OAuth cannot embed client credentials"
        );
        ensure!(
            client
                .keys()
                .all(|k| ["mode", "clientId", "tokenEndpointAuthMethod"].contains(&k.as_str())),
            "unsupported OAuth client field"
        );
        if let Some(v) = client.get("tokenEndpointAuthMethod") {
            ensure!(
                v.is_string(),
                "invalid token endpoint authentication method"
            );
            ensure!(
                client.get("mode").is_some_and(|v| v == "provided"),
                "only provided clients declare token endpoint authentication method"
            );
        }
        match client.get("mode").and_then(Value::as_str) {
            Some("provided") => {
                policy.client_id = text(client.get("clientId"))?;
                ensure!(
                    policy.client_id.as_ref().is_some_and(|s| !s.is_empty()),
                    "provided OAuth requires clientId"
                );
            }
            Some("dcr") => ensure!(
                !client.contains_key("clientId"),
                "DCR cannot provide clientId"
            ),
            Some("cimd") => {
                ensure!(
                    !client.contains_key("clientId"),
                    "CIMD cannot provide clientId"
                );
            }
            _ => bail!("invalid OAuth client mode"),
        }
        if let Some(method) = client
            .get("tokenEndpointAuthMethod")
            .and_then(Value::as_str)
        {
            ensure!(
                [
                    "none",
                    "client_secret_basic",
                    "client_secret_post",
                    "private_key_jwt"
                ]
                .contains(&method),
                "invalid token endpoint authentication method"
            );
        }
    }
    if kind == "api_key" {
        let scheme = o.get("headerScheme").and_then(Value::as_str);
        ensure!(
            matches!(scheme, Some("bearer" | "basic" | "custom_header")),
            "invalid API key header scheme"
        );
        if scheme == Some("custom_header") {
            let header = o
                .get("headerName")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("missing API key header name"))?;
            ensure!(
                !OWNED.contains(&header.to_ascii_lowercase().as_str()),
                "reserved API key header"
            );
            reqwest_mcp::header::HeaderName::from_bytes(header.as_bytes())
                .map_err(|_| anyhow::anyhow!("invalid API key header"))?;
        } else {
            ensure!(
                !o.contains_key("headerName"),
                "unexpected API key header name"
            );
        }
    }
    Ok(Some(policy))
}

#[cfg(test)]
mod user_configuration_tests {
    use super::*;

    #[test]
    fn configuration_values_are_bound_once_only_at_supported_fields() {
        let temp = tempfile::tempdir().unwrap();
        let declaration = PluginDeclaration::parse(
            false,
            json!({"fixture":{"command":"node","args":["${user_config.device}"],"env":{"TOKEN":"prefix-${user_config.token}"}}}),
        );
        let bindings = BTreeMap::from([
            (
                "device".into(),
                UserConfigBinding {
                    value: "iPhone 16".into(),
                    sensitive: false,
                },
            ),
            (
                "token".into(),
                UserConfigBinding {
                    value: "canary-${user_config.device}".into(),
                    sensitive: true,
                },
            ),
        ]);
        let outcome = declaration
            .bind_user_config(&bindings)
            .unwrap()
            .normalize(temp.path(), temp.path())
            .unwrap();
        assert_eq!(
            outcome.servers["fixture"].env["TOKEN"],
            "prefix-canary-${user_config.device}"
        );
        assert!(
            !outcome.servers["fixture"]
                .redacted_view()
                .to_string()
                .contains("canary")
        );
        let disallowed = PluginDeclaration::parse(
            false,
            json!({"fixture":{"url":"https://example.test/${user_config.token}"}}),
        );
        assert!(disallowed.bind_user_config(&bindings).is_err());
        let command = PluginDeclaration::parse(
            false,
            json!({"fixture":{"command":"${user_config.device}"}}),
        );
        assert!(command.bind_user_config(&bindings).is_err());
        let alternate = PluginDeclaration::parse(
            false,
            json!({"fixture":{"command":"node","args":["${userConfig.device}"]}}),
        );
        assert!(alternate.bind_user_config(&bindings).is_err());
    }
}

#[cfg(test)]
mod retained_configuration_tests {
    use super::*;

    #[test]
    fn retained_document_configuration_scan_preserves_override_semantics() {
        let fields = BTreeMap::new();
        let metadata = PluginDeclaration::parse(
            false,
            json!({"mcpServers":{"fixture":{"command":"node"}},"metadata":"${user_config.secret}"}),
        );
        assert!(metadata.validate_user_config(&fields).is_err());
        assert!(metadata.bind_user_config(&BTreeMap::new()).is_err());
        let invalid_servers =
            PluginDeclaration::parse(false, json!({"mcpServers":"${userConfig.secret}"}));
        assert!(invalid_servers.validate_user_config(&fields).is_err());
        for (metadata, blocked) in [(None, false), (Some("${user_config.secret}"), true)] {
            let mut value = json!({"mcpServers":{"fixture":{"command":"node"},"shared":{"command":"${user_config.secret}"}}});
            if let Some(metadata) = metadata {
                value["metadata"] = json!(metadata);
            }
            let mut declaration = PluginDeclaration::parse(false, value);
            assert!(!declaration.retain_servers(|name| name != "shared"));
            assert_eq!(declaration.validate_user_config(&fields).is_err(), blocked);
        }
    }
}
