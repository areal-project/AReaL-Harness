//! GUI 与命令行共用的模型目录。只写非敏感配置，凭据值不进入此接口。
use crate::{
    ConfigErrorKind as Kind, ConfigInputs, ConfigSource, ModelProtocolConfig, Result, error, file,
    resolve,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use toml_edit::{Document, DocumentMut, Item, Table};

fn enabled() -> bool {
    true
}

#[derive(Clone, Default, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Parameters {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window_tokens: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
}
impl Parameters {
    pub fn overlay(&self, base: &Self) -> Self {
        Self {
            temperature: self.temperature.or(base.temperature),
            max_output_tokens: self.max_output_tokens.or(base.max_output_tokens),
            context_window_tokens: self.context_window_tokens.or(base.context_window_tokens),
            reasoning_effort: self
                .reasoning_effort
                .clone()
                .or_else(|| base.reasoning_effort.clone()),
        }
    }
    pub(crate) fn values(&self) -> Vec<(&'static str, String)> {
        let mut values = Vec::new();
        if let Some(value) = self.temperature {
            values.push(("temperature", value.to_string()));
        }
        if let Some(value) = self.context_window_tokens {
            values.push(("context_window_tokens", value.to_string()));
        }
        if let Some(value) = self.max_output_tokens {
            values.push(("max_output_tokens", value.to_string()));
        }
        if let Some(value) = &self.reasoning_effort {
            values.push(("reasoning_effort", value.clone()));
        }
        values
    }
    fn validate(&self, at: &ConfigSource) -> Result<()> {
        for (field, value) in self.values() {
            resolve::valid(
                &format!("model.{field}"),
                &file::Entry {
                    value,
                    source: at.clone(),
                },
            )?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelConfig {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default = "enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub parameters: Parameters,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub endpoint: String,
    pub protocol: ModelProtocolConfig,
    #[serde(default = "enabled")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_env: Option<String>,
    #[serde(default)]
    pub models: Vec<ModelConfig>,
    #[serde(default)]
    pub parameters: Parameters,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelRef {
    pub provider_id: String,
    pub model_id: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CredentialState {
    NotRequired,
    Available,
    Unavailable,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CredentialSource {
    None,
    Environment,
    Stored,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfiguration {
    pub path: PathBuf,
    pub revision: String,
    pub data: Vec<ProviderConfig>,
    pub default_model: Option<ModelRef>,
    pub credential_states: BTreeMap<String, CredentialState>,
    pub credential_sources: BTreeMap<String, CredentialSource>,
    pub effective: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelConfigurationUpdate {
    pub expected_revision: String,
    pub data: Vec<ProviderConfig>,
    pub default_model: Option<ModelRef>,
}

fn invalid(at: &ConfigSource, message: &'static str) -> crate::ConfigError {
    error(Kind::InvalidValue, "model.providers", at, message)
}
fn text_ok(text: &str, max: usize) -> bool {
    !text.trim().is_empty() && text.len() <= max && !text.chars().any(char::is_control)
}
fn validate(data: &[ProviderConfig], default: Option<&ModelRef>, at: &ConfigSource) -> Result<()> {
    if data.len() > 32 {
        return Err(invalid(at, "at most 32 providers are supported"));
    }
    let mut ids = BTreeSet::new();
    for provider in data {
        if !text_ok(&provider.id, 128)
            || !ids.insert(&provider.id)
            || provider.id == "areal_openai"
            || provider.id == "areal_chatgpt"
        {
            return Err(invalid(at, "invalid, duplicate or reserved provider ID"));
        }
        resolve::valid(
            "model.provider",
            &file::Entry {
                value: provider.id.clone(),
                source: at.clone(),
            },
        )?;
        resolve::valid(
            "model.endpoint",
            &file::Entry {
                value: provider.endpoint.clone(),
                source: at.clone(),
            },
        )?;
        if let Some(name) = &provider.api_key_env {
            resolve::valid(
                "model.api_key_env",
                &file::Entry {
                    value: name.clone(),
                    source: at.clone(),
                },
            )?;
        }
        if !text_ok(&provider.name, 128) || provider.models.len() > 64 {
            return Err(invalid(at, "invalid provider name or model capacity"));
        }
        provider.parameters.validate(at)?;
        let mut models = BTreeSet::new();
        for model in &provider.models {
            if !text_ok(&model.id, 256)
                || !models.insert(&model.id)
                || model
                    .display_name
                    .as_ref()
                    .is_some_and(|name| !text_ok(name, 128))
            {
                return Err(invalid(at, "invalid or duplicate model ID or display name"));
            }
            model.parameters.validate(at)?;
        }
    }
    if let Some(default) = default {
        if !text_ok(&default.model_id, 256) {
            return Err(invalid(at, "invalid default model"));
        }
        if default.provider_id != "areal_openai"
            && !data.iter().any(|p| {
                p.id == default.provider_id
                    && p.enabled
                    && p.models
                        .iter()
                        .any(|m| m.id == default.model_id && m.enabled)
            })
        {
            return Err(invalid(
                at,
                "default model must reference an enabled provider and model",
            ));
        }
    }
    Ok(())
}

fn json_value(item: &Item, at: &ConfigSource) -> Result<Value> {
    if let Some(table) = item.as_table_like() {
        let mut object = serde_json::Map::new();
        for (key, value) in table.iter() {
            let key = match key {
                "display_name" => "displayName",
                "api_key_env" => "apiKeyEnv",
                "max_output_tokens" => "maxOutputTokens",
                "context_window_tokens" => "contextWindowTokens",
                "reasoning_effort" => "reasoningEffort",
                value => value,
            };
            object.insert(key.to_owned(), json_value(value, at)?);
        }
        return Ok(Value::Object(object));
    }
    if let Some(values) = item.as_array_of_tables() {
        return values
            .iter()
            .map(|table| json_value(&Item::Table(table.clone()), at))
            .collect::<Result<Vec<_>>>()
            .map(Value::Array);
    }
    if let Some(values) = item.as_array() {
        return values
            .iter()
            .map(|value| json_value(&Item::Value(value.clone()), at))
            .collect::<Result<Vec<_>>>()
            .map(Value::Array);
    }
    if let Some(value) = item.as_str() {
        return Ok(json!(value));
    }
    if let Some(value) = item.as_bool() {
        return Ok(json!(value));
    }
    if let Some(value) = item.as_integer() {
        return Ok(json!(value));
    }
    if let Some(value) = item.as_float().filter(|value| value.is_finite()) {
        return Ok(json!(value));
    }
    Err(invalid(at, "unsupported model configuration value"))
}

pub(crate) fn parse_catalog(
    doc: &Document<&str>,
    path: &Path,
    text: &str,
) -> Result<Vec<ProviderConfig>> {
    let Some(model) = doc.get("model").and_then(Item::as_table_like) else {
        return Ok(Vec::new());
    };
    let selected = model
        .get("provider")
        .and_then(Item::as_str)
        .unwrap_or("default");
    let selected_model = model.get("name").and_then(Item::as_str);
    let Some(providers) = model.get("providers").and_then(Item::as_table_like) else {
        return Ok(Vec::new());
    };
    let mut data = Vec::new();
    for (id, item) in providers.iter() {
        let at = file::source(path, text, item.span().map_or(0, |v| v.start));
        let mut raw = json_value(item, &at)?;
        let object = raw
            .as_object_mut()
            .ok_or_else(|| invalid(&at, "expected provider table"))?;
        // 旧供应商表可由环境或 CLI 补齐端点；只交给既有解析链，不投影为完整目录。
        if model.get("catalog_version").is_none()
            && !object.contains_key("endpoint")
            && object
                .keys()
                .all(|key| matches!(key.as_str(), "protocol" | "apiKeyEnv"))
        {
            continue;
        }
        object.insert("id".into(), json!(id));
        object.entry("name").or_insert(json!(id));
        object
            .entry("protocol")
            .or_insert(json!("chat-completions"));
        // 原有单模型文件不要求补写目录；选中的名称投影为唯一目录项。
        if !object.contains_key("models")
            && id == selected
            && let Some(name) = selected_model
        {
            object.insert("models".into(), json!([{"id":name}]));
        }
        let provider: ProviderConfig = serde_json::from_value(raw)
            .map_err(|_| invalid(&at, "invalid provider fields or field types"))?;
        validate(std::slice::from_ref(&provider), None, &at)?;
        data.push(provider);
    }
    if data.len() > 32 {
        return Err(invalid(
            &file::source(path, text, 0),
            "at most 32 providers are supported",
        ));
    }
    if model.get("catalog_version").is_some() {
        let default = selected_model.map(|name| ModelRef {
            provider_id: selected.into(),
            model_id: name.into(),
        });
        validate(&data, default.as_ref(), &file::source(path, text, 0))?;
    }
    Ok(data)
}

fn default_model(layer: &file::FileLayer) -> Option<ModelRef> {
    layer.values.get("model.name").map(|name| ModelRef {
        provider_id: layer
            .values
            .get("model.provider")
            .map_or("default", |p| p.value.as_str())
            .into(),
        model_id: name.value.clone(),
    })
}
fn revision(path: &Path, layer: &file::FileLayer) -> String {
    let mut hash = Sha256::new();
    hash.update(path.as_os_str().as_encoded_bytes());
    hash.update([u8::from(layer.loaded)]);
    hash.update(layer.text.as_bytes());
    format!("{:x}", hash.finalize())
}
fn snapshot(
    inputs: &ConfigInputs,
    path: PathBuf,
    layer: file::FileLayer,
    stored_credential_envs: &[String],
) -> Result<ModelConfiguration> {
    // 共享编辑不能静默丢掉尚未补齐的旧供应商，也不能把临时覆盖当作文件值。
    if layer.catalog.len() != layer.providers.len() {
        return Err(invalid(
            &file::source(&path, &layer.text, 0),
            "shared model providers require endpoint in the configuration file",
        ));
    }
    for provider in &layer.catalog {
        if url::Url::parse(&provider.endpoint).is_ok_and(|url| url.query().is_some()) {
            return Err(invalid(
                &file::source(&path, &layer.text, 0),
                "shared model endpoints cannot contain query parameters; use api_key_env for credentials",
            ));
        }
    }
    let config = resolve::load_mode(inputs, true, Some(layer.clone()))?;
    // 只返回凭据状态；密钥不进入文件快照或 revision。选中供应商沿用解析后的覆盖。
    let (credential_states, credential_sources) = layer
        .catalog
        .iter()
        .map(|provider| {
            let reference = if config.model.provider == provider.id && !config.model.name.is_empty()
            {
                config.model.api_key_env.as_deref()
            } else {
                provider.api_key_env.as_deref()
            };
            let state = match reference {
                None => CredentialState::NotRequired,
                Some(name) if crate::credential_value(&inputs.env, name).is_some() => {
                    CredentialState::Available
                }
                Some(_) => CredentialState::Unavailable,
            };
            // 适配器声明安全存储注入的引用；来源诊断仍由 Core 结合实际引用判定。
            let source = match reference {
                None => CredentialSource::None,
                Some(name) if stored_credential_envs.iter().any(|stored| stored == name) => {
                    CredentialSource::Stored
                }
                Some(_) => CredentialSource::Environment,
            };
            ((provider.id.clone(), state), (provider.id.clone(), source))
        })
        .unzip();
    Ok(ModelConfiguration {
        revision: revision(&path, &layer),
        path,
        default_model: default_model(&layer),
        data: layer.catalog,
        credential_states,
        credential_sources,
        effective: config.diagnostic(true),
    })
}
pub fn read(
    inputs: &ConfigInputs,
    stored_credential_envs: &[String],
) -> Result<ModelConfiguration> {
    let location = resolve::location(inputs)?;
    let layer = file::read(&location.selected, location.explicit)?;
    snapshot(inputs, location.selected, layer, stored_credential_envs)
}

fn toml_value(value: Value) -> toml_edit::Value {
    match value {
        Value::String(value) => value.into(),
        Value::Bool(value) => value.into(),
        Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                value.into()
            } else {
                value.as_f64().unwrap().into()
            }
        }
        Value::Array(values) => {
            let mut array = toml_edit::Array::new();
            for value in values {
                array.push(toml_value(value));
            }
            array.into()
        }
        Value::Object(values) => {
            let mut table = toml_edit::InlineTable::new();
            for (key, value) in values {
                let key = match key.as_str() {
                    "displayName" => "display_name",
                    "maxOutputTokens" => "max_output_tokens",
                    "contextWindowTokens" => "context_window_tokens",
                    "reasoningEffort" => "reasoning_effort",
                    key => key,
                };
                table.insert(key, toml_value(value));
            }
            table.into()
        }
        Value::Null => unreachable!("optional fields are omitted"),
    }
}
fn render(layer: &file::FileLayer, update: &ModelConfigurationUpdate) -> String {
    let mut doc: DocumentMut = if layer.loaded {
        layer.text.parse().expect("validated TOML")
    } else {
        DocumentMut::new()
    };
    doc["schema_version"] = toml_edit::value(1);
    if !doc.contains_key("model") {
        doc["model"] = Item::Table(Table::new());
    }
    let model = doc["model"]
        .as_table_like_mut()
        .expect("validated model table");
    model.insert("catalog_version", toml_edit::value(1));
    if let Some(default) = &update.default_model {
        model.insert("provider", toml_edit::value(&default.provider_id));
        model.insert("name", toml_edit::value(&default.model_id));
    } else {
        model.remove("provider");
        model.remove("name");
    }
    let old = model.get("providers").cloned();
    let mut providers = Table::new();
    providers.set_implicit(true);
    for provider in &update.data {
        let mut table = old
            .as_ref()
            .and_then(Item::as_table_like)
            .and_then(|p| p.get(&provider.id))
            .and_then(Item::as_table)
            .cloned()
            .unwrap_or_default();
        table.insert("name", toml_edit::value(&provider.name));
        table.insert("endpoint", toml_edit::value(&provider.endpoint));
        table.insert(
            "protocol",
            toml_edit::value(match provider.protocol {
                ModelProtocolConfig::Responses => "responses",
                ModelProtocolConfig::ChatCompletions => "chat-completions",
            }),
        );
        table.insert("enabled", toml_edit::value(provider.enabled));
        if let Some(name) = &provider.api_key_env {
            table.insert("api_key_env", toml_edit::value(name));
        } else {
            table.remove("api_key_env");
        }
        table.insert("models", Item::Value(toml_value(json!(provider.models))));
        table.insert(
            "parameters",
            Item::Value(toml_value(json!(provider.parameters))),
        );
        providers.insert(&provider.id, Item::Table(table));
    }
    model.insert("providers", Item::Table(providers));
    doc.to_string()
}

pub fn write(
    inputs: &ConfigInputs,
    update: ModelConfigurationUpdate,
    stored_credential_envs: &[String],
) -> Result<ModelConfiguration> {
    let location = resolve::location(inputs)?;
    let path = &location.selected;
    let at = file::source(path, "", 0);
    validate(&update.data, update.default_model.as_ref(), &at)?;
    let io_error = || {
        error(
            Kind::Io,
            "config_file",
            &at,
            "cannot safely write model configuration",
        )
    };
    let parent = path.parent().ok_or_else(io_error)?;
    // 仅默认文件可首次创建；显式不存在的文件仍视为路径配置错误。
    let before = file::read(path, location.explicit)?;
    if revision(path, &before) != update.expected_revision {
        return Err(error(
            Kind::Conflict,
            "config_file",
            &at,
            "configuration changed; refresh before saving",
        ));
    }
    let text = render(&before, &update);
    if text.len() > 1024 * 1024 {
        return Err(invalid(&at, "configuration exceeds 1 MiB"));
    }
    let candidate = file::parse(path, &text)?;
    let result = snapshot(inputs, path.clone(), candidate, stored_credential_envs)?;
    fs::create_dir_all(parent).map_err(|_| io_error())?;
    let lock_path = parent.join(format!(
        ".{}.lock",
        path.file_name().ok_or_else(io_error)?.to_string_lossy()
    ));
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32);
    }
    let lock = options.open(lock_path).map_err(|_| io_error())?;
    fs2::FileExt::try_lock_exclusive(&lock).map_err(|_| {
        error(
            Kind::Conflict,
            "config_file",
            &at,
            "another configuration writer is active",
        )
    })?;
    if let Ok(metadata) = fs::symlink_metadata(path)
        && metadata.file_type().is_symlink()
    {
        return Err(io_error());
    }
    let current = file::read(path, location.explicit)?;
    if revision(path, &current) != update.expected_revision {
        return Err(error(
            Kind::Conflict,
            "config_file",
            &at,
            "configuration changed; refresh before saving",
        ));
    }
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|_| io_error())?;
    if let Ok(metadata) = fs::metadata(path) {
        temporary
            .as_file()
            .set_permissions(metadata.permissions())
            .map_err(|_| io_error())?;
    }
    temporary
        .write_all(text.as_bytes())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| io_error())?;
    // 外部编辑器未参与此锁；再次检查可检测已发生的编辑，不宣称文件系统原子 CAS。
    if revision(path, &file::read(path, location.explicit)?) != update.expected_revision {
        return Err(error(
            Kind::Conflict,
            "config_file",
            &at,
            "configuration changed; refresh before saving",
        ));
    }
    temporary.persist(path).map_err(|_| io_error())?;
    fs::File::open(parent)
        .and_then(|file| file.sync_all())
        .map_err(|_| io_error())?;
    Ok(result)
}
