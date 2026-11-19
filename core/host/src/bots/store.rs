//! Bot 注册表与凭据持久化：注册表与凭据分文件存储，测试隔离目录不触碰真实 `~/.areal`。
use anyhow::{Context, Result, ensure};
use areal_local_service::storage;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub(crate) const MAX_BOTS: usize = 64;
pub(crate) const MAX_NAME_LEN: usize = 80;
pub(crate) const MAX_AVATAR_LEN: usize = 32;
pub(crate) const MAX_DESCRIPTION_LEN: usize = 512;
pub(crate) const MAX_PREFERENCES_LEN: usize = 16 * 1024;
pub(crate) const MAX_STARTER_PROMPTS: usize = 6;
pub(crate) const MAX_STARTER_PROMPT_LEN: usize = 200;
pub(crate) const MAX_PREVIEW_LEN: usize = 240;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SystemPromptMode {
    #[default]
    PersonalAgent,
    Default,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProviderSyncMode {
    #[default]
    Auto,
    ArenaOnly,
    HostSync,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BotModelRef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    pub model_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BotCustomProvider {
    pub id: String,
    pub endpoint: String,
    pub protocol: String,
    pub models: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_ref: Option<String>,
}

/// 发送前持久化未决提交身份；断线或响应丢失后只能核对原 requestId，禁止盲目重放。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PendingSubmission {
    pub request_id: String,
    pub thread_id: String,
    pub digest: String,
    pub preview: String,
    pub created_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BotRecord {
    pub id: String,
    pub name: String,
    pub avatar: String,
    pub description: String,
    pub workspace: String,
    #[serde(default)]
    pub starter_prompts: Vec<String>,
    #[serde(default)]
    pub system_prompt_mode: SystemPromptMode,
    #[serde(default)]
    pub preferences: String,
    #[serde(default = "default_revision_one")]
    pub preferences_revision: u64,
    #[serde(default)]
    pub synced_preferences_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_override: Option<BotModelRef>,
    #[serde(default)]
    pub provider_sync_mode: ProviderSyncMode,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub custom_providers: Vec<BotCustomProvider>,
    pub thread_request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_thread_id: Option<String>,
    #[serde(default)]
    pub last_message_preview: String,
    #[serde(default)]
    pub last_active_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_submission: Option<PendingSubmission>,
}

fn default_revision_one() -> u64 {
    1
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ArenaSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// 未显式配置 token 时，可按需读取 `~/.arena-online-gateway/config.toml` 中对应 profile。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BotRegistry {
    #[serde(default = "default_version_one")]
    pub version: u32,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub arena: ArenaSettings,
    #[serde(default)]
    pub bots: Vec<BotRecord>,
}

fn default_version_one() -> u32 {
    1
}

impl Default for BotRegistry {
    fn default() -> Self {
        Self {
            version: 1,
            revision: 0,
            arena: ArenaSettings::default(),
            bots: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArenaCredentials {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    token: Option<String>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    provider_keys: std::collections::BTreeMap<String, String>,
}

#[derive(Clone, Debug)]
pub(crate) struct ResolvedArenaConfig {
    pub ws_base_url: String,
    pub token: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublicArenaSettings {
    pub base_url: Option<String>,
    pub profile: Option<String>,
    pub has_token: bool,
    pub source: &'static str,
    pub ready: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct BotStore {
    root: PathBuf,
    arena_config_path: Option<PathBuf>,
}

impl BotStore {
    pub(crate) fn new(host_home: &Path) -> Self {
        let arena_config_path =
            std::env::home_dir().map(|dir| dir.join(".arena-online-gateway").join("config.toml"));
        Self {
            root: host_home.join("bots"),
            arena_config_path,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_arena_config_path(
        host_home: &Path,
        arena_config_path: Option<PathBuf>,
    ) -> Self {
        Self {
            root: host_home.join("bots"),
            arena_config_path,
        }
    }

    fn registry_path(&self) -> PathBuf {
        self.root.join("registry.json")
    }

    fn credentials_path(&self) -> PathBuf {
        self.root.join("credentials.json")
    }

    pub(crate) fn load(&self) -> Result<BotRegistry> {
        let registry =
            storage::read_optional::<BotRegistry>(&self.registry_path())?.unwrap_or_default();
        Ok(registry)
    }

    pub(crate) fn save(&self, registry: &BotRegistry) -> Result<()> {
        storage::private_dir(&self.root)?;
        storage::write(&self.registry_path(), registry)
    }

    pub(crate) fn save_token(&self, token: Option<&str>) -> Result<()> {
        storage::private_dir(&self.root)?;
        let mut creds = storage::read_optional::<ArenaCredentials>(&self.credentials_path())?
            .unwrap_or_default();
        creds.token = match token {
            Some(value) => {
                validate_token(value)?;
                Some(value.to_owned())
            }
            None => None,
        };
        storage::write(&self.credentials_path(), &creds)
    }

    pub(crate) fn save_provider_key(&self, credential_ref: &str, api_key: &str) -> Result<()> {
        validate_token(api_key)?;
        storage::private_dir(&self.root)?;
        let mut creds = storage::read_optional::<ArenaCredentials>(&self.credentials_path())?
            .unwrap_or_default();
        creds
            .provider_keys
            .insert(credential_ref.to_owned(), api_key.to_owned());
        storage::write(&self.credentials_path(), &creds)
    }

    pub(crate) fn load_provider_key(&self, credential_ref: &str) -> Result<Option<String>> {
        let creds = storage::read_optional::<ArenaCredentials>(&self.credentials_path())?;
        Ok(creds
            .and_then(|c| c.provider_keys.get(credential_ref).cloned())
            .filter(|v| !v.is_empty()))
    }

    fn saved_token(&self) -> Result<Option<String>> {
        let creds = storage::read_optional::<ArenaCredentials>(&self.credentials_path())?;
        Ok(creds.and_then(|c| c.token).filter(|t| !t.is_empty()))
    }

    pub(crate) fn public_arena_settings(
        &self,
        settings: &ArenaSettings,
    ) -> Result<PublicArenaSettings> {
        let saved_token = self.saved_token()?;
        if let (Some(base), Some(_)) = (settings.base_url.as_ref(), saved_token.as_ref()) {
            return Ok(PublicArenaSettings {
                base_url: Some(base.clone()),
                profile: settings.profile.clone(),
                has_token: true,
                source: "saved",
                ready: true,
            });
        }
        let profile_name = settings.profile.as_deref().unwrap_or("prod");
        if let Some((profile_base, _)) = self.load_arena_cli_profile(profile_name)? {
            let effective_base = settings.base_url.clone().or(Some(profile_base));
            return Ok(PublicArenaSettings {
                base_url: effective_base,
                profile: Some(profile_name.to_owned()),
                has_token: true,
                source: if saved_token.is_some() {
                    "saved"
                } else {
                    "arenaCliConfig"
                },
                ready: true,
            });
        }
        Ok(PublicArenaSettings {
            base_url: settings.base_url.clone(),
            profile: settings.profile.clone(),
            has_token: saved_token.is_some(),
            source: if saved_token.is_some() || settings.base_url.is_some() {
                "saved"
            } else {
                "unconfigured"
            },
            ready: false,
        })
    }

    pub(crate) fn resolve_arena_config(
        &self,
        settings: &ArenaSettings,
    ) -> Result<ResolvedArenaConfig> {
        let saved_token = self.saved_token()?;
        let profile_name = settings.profile.as_deref().unwrap_or("prod");
        let cli_profile = if settings.base_url.is_none() || saved_token.is_none() {
            self.load_arena_cli_profile(profile_name)?
        } else {
            None
        };

        let raw_base = settings
            .base_url
            .clone()
            .or_else(|| cli_profile.as_ref().map(|(base, _)| base.clone()))
            .context("ARENA_NOT_CONFIGURED")?;
        let token = saved_token
            .or_else(|| cli_profile.as_ref().map(|(_, tok)| tok.clone()))
            .context("ARENA_NOT_CONFIGURED")?;
        validate_token(&token)?;
        let ws_base_url = to_ws_base_url(&raw_base)?;
        Ok(ResolvedArenaConfig { ws_base_url, token })
    }

    /// 解析 `~/.arena-online-gateway/config.toml` 中指定 `[profile]` 的 `baseurl` 与 `token`。
    fn load_arena_cli_profile(&self, profile: &str) -> Result<Option<(String, String)>> {
        let Some(path) = &self.arena_config_path else {
            return Ok(None);
        };
        if !path.is_file() {
            return Ok(None);
        }
        let text = match std::fs::read_to_string(path) {
            Ok(content) => content,
            Err(_) => return Ok(None),
        };
        Ok(parse_arena_toml_profile(&text, profile))
    }
}

pub(crate) fn parse_arena_toml_profile(content: &str, profile: &str) -> Option<(String, String)> {
    let header = format!("[{profile}]");
    let mut in_section = false;
    let mut base_url: Option<String> = None;
    let mut token: Option<String> = None;
    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            in_section = line == header;
            continue;
        }
        if !in_section {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        let unquoted = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value)
            .trim();
        if unquoted.is_empty() {
            continue;
        }
        match key {
            "baseurl" | "base_url" | "url" => base_url = Some(unquoted.to_owned()),
            "token" | "api_key" => token = Some(unquoted.to_owned()),
            _ => {}
        }
    }
    match (base_url, token) {
        (Some(base), Some(tok)) => Some((base, tok)),
        _ => None,
    }
}

pub(crate) fn validate_base_url(raw: &str) -> Result<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    ensure!(
        !trimmed.is_empty() && trimmed.len() <= 2048,
        "INVALID_PARAMS"
    );
    let url = url::Url::parse(trimmed).map_err(|_| anyhow::anyhow!("INVALID_PARAMS"))?;
    ensure!(
        matches!(url.scheme(), "http" | "https" | "ws" | "wss")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "INVALID_PARAMS"
    );
    Ok(trimmed.to_owned())
}

pub(crate) fn to_ws_base_url(raw: &str) -> Result<String> {
    let normalized = validate_base_url(raw)?;
    let ws = if let Some(rest) = normalized.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = normalized.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        normalized
    };
    Ok(ws)
}

pub(crate) fn build_workspace_ws_url(ws_base_url: &str, workspace: &str) -> Result<String> {
    validate_workspace_id(workspace)?;
    let base = ws_base_url.trim_end_matches('/');
    if base.ends_with("/app-server") {
        Ok(format!("{base}/{workspace}/"))
    } else {
        Ok(format!("{base}/app-server/{workspace}/"))
    }
}

pub(crate) fn validate_token(token: &str) -> Result<()> {
    ensure!(
        !token.is_empty()
            && token.len() <= 16384
            && !token.contains(['\r', '\n', '\0'])
            && token.bytes().all(|b| (0x20..=0x7e).contains(&b)),
        "INVALID_PARAMS"
    );
    Ok(())
}

/// EnvArena 要求 workspace 满足 `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`。
pub(crate) fn validate_workspace_id(workspace: &str) -> Result<()> {
    ensure!(
        !workspace.is_empty() && workspace.len() <= 64,
        "INVALID_PARAMS"
    );
    let bytes = workspace.as_bytes();
    ensure!(bytes[0].is_ascii_alphanumeric(), "INVALID_PARAMS");
    ensure!(
        bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-'),
        "INVALID_PARAMS"
    );
    Ok(())
}

pub(crate) fn generate_workspace_id(name: &str) -> String {
    let mut slug = String::from("bot-");
    let mut prev_dash = true;
    for ch in name.chars() {
        if slug.len() >= 32 {
            break;
        }
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && (ch.is_whitespace() || ch == '-' || ch == '_') {
            slug.push('-');
            prev_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() || slug == "bot" {
        slug = String::from("bot");
    }
    let suffix = &uuid::Uuid::new_v4().simple().to_string()[..8];
    format!("{slug}-{suffix}")
}

pub(crate) fn validate_name(name: &str) -> Result<String> {
    let trimmed = name.trim();
    ensure!(
        !trimmed.is_empty() && trimmed.chars().count() <= MAX_NAME_LEN && !trimmed.contains('\0'),
        "INVALID_PARAMS"
    );
    Ok(trimmed.to_owned())
}

pub(crate) fn validate_avatar(avatar: &str) -> Result<String> {
    let trimmed = avatar.trim();
    ensure!(
        !trimmed.is_empty()
            && trimmed.chars().count() <= MAX_AVATAR_LEN
            && !trimmed.contains(['\0', '\r', '\n']),
        "INVALID_PARAMS"
    );
    Ok(trimmed.to_owned())
}

pub(crate) fn validate_description(description: &str) -> Result<String> {
    let trimmed = description.trim();
    ensure!(
        trimmed.chars().count() <= MAX_DESCRIPTION_LEN && !trimmed.contains('\0'),
        "INVALID_PARAMS"
    );
    Ok(trimmed.to_owned())
}

pub(crate) fn validate_preferences(preferences: &str) -> Result<String> {
    ensure!(
        preferences.len() <= MAX_PREFERENCES_LEN && !preferences.contains('\0'),
        "INVALID_PARAMS"
    );
    Ok(preferences.to_owned())
}

pub(crate) fn validate_starter_prompts(prompts: Vec<String>) -> Result<Vec<String>> {
    ensure!(prompts.len() <= MAX_STARTER_PROMPTS, "INVALID_PARAMS");
    let mut out = Vec::with_capacity(prompts.len());
    for prompt in prompts {
        let trimmed = prompt.trim();
        if trimmed.is_empty() {
            continue;
        }
        ensure!(
            trimmed.chars().count() <= MAX_STARTER_PROMPT_LEN && !trimmed.contains('\0'),
            "INVALID_PARAMS"
        );
        out.push(trimmed.to_owned());
    }
    Ok(out)
}

pub(crate) fn truncate_preview(text: &str) -> String {
    let compact: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = String::new();
    for (idx, ch) in compact.chars().enumerate() {
        if idx >= MAX_PREVIEW_LEN {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}

pub(crate) fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

/// 将外部协议别名规范为 Core `Provider.protocol` 合法枚举（`responses` | `chatCompletions`）。
pub(crate) fn normalize_provider_protocol(raw: Option<&str>) -> Result<&'static str> {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        None | Some("responses" | "response" | "openai-responses" | "openai.responses") => {
            Ok("responses")
        }
        Some(
            "chatCompletions"
            | "chat-completions"
            | "chat_completions"
            | "chat"
            | "openai-chat"
            | "openai.chat_completions",
        ) => Ok("chatCompletions"),
        Some(_) => anyhow::bail!("INVALID_PARAMS"),
    }
}

/// 将 Base URL（如 `https://.../v1`）或完整路径规范为 Core 要求的完整 API Endpoint。
pub(crate) fn normalize_provider_endpoint(raw: &str, protocol: &str) -> Result<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    ensure!(
        !trimmed.is_empty() && trimmed.len() <= 2048,
        "INVALID_PARAMS"
    );
    let parsed = url::Url::parse(trimmed).map_err(|_| anyhow::anyhow!("INVALID_PARAMS"))?;
    ensure!(
        matches!(parsed.scheme(), "http" | "https")
            && parsed.host_str().is_some()
            && parsed.username().is_empty()
            && parsed.password().is_none()
            && parsed.fragment().is_none(),
        "INVALID_PARAMS"
    );
    let suffix = if protocol == "responses" {
        "/responses"
    } else {
        "/chat/completions"
    };
    if trimmed.ends_with("/responses") || trimmed.ends_with("/chat/completions") {
        return Ok(trimmed.to_owned());
    }
    Ok(format!("{trimmed}{suffix}"))
}
