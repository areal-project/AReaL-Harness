use crate::{PluginList, Store};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum UserConfigType {
    String,
    Boolean,
    Number,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(untagged)]
pub enum PublicConfigValue {
    String(String),
    Boolean(bool),
    Number(serde_json::Number),
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserConfigField {
    #[serde(rename = "type")]
    pub field_type: UserConfigType,
    pub title: Option<String>,
    pub description: Option<String>,
    pub required: bool,
    pub sensitive: bool,
    pub default: Option<PublicConfigValue>,
}
#[derive(Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum PluginConfigValue {
    String(String),
    Boolean(bool),
    Number(serde_json::Number),
    SecretRef(String),
}
impl std::fmt::Debug for PluginConfigValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PluginConfigValue([REDACTED])")
    }
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUserConfiguration {
    pub installed_digest: String,
    pub revision: u64,
    pub values: BTreeMap<String, PluginConfigValue>,
}
impl std::fmt::Debug for PluginUserConfiguration {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PluginUserConfiguration([REDACTED])")
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginConfigurationView {
    pub fields: BTreeMap<String, PluginConfigPublicField>,
    pub missing_required: Vec<String>,
    pub revision: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginConfigPublicField {
    pub definition: UserConfigField,
    pub configured: bool,
    pub value: Option<PublicConfigValue>,
}
pub(crate) fn schema(value: Option<&Value>) -> Result<BTreeMap<String, UserConfigField>> {
    let Some(value) = value else {
        return Ok(BTreeMap::new());
    };
    let values = value.as_object().context("userConfig must be an object")?;
    ensure!(values.len() <= 128, "userConfig exceeds 128 fields");
    values
        .iter()
        .map(|(key, value)| {
            ensure!(
                !key.is_empty()
                    && key.len() <= 128
                    && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'),
                "invalid userConfig field name"
            );
            let object = value.as_object().context("invalid userConfig field")?;
            ensure!(
                object.keys().all(|key| [
                    "type",
                    "title",
                    "description",
                    "required",
                    "sensitive",
                    "default"
                ]
                .contains(&key.as_str())),
                "unsupported userConfig field semantics"
            );
            let field_type = match object.get("type").and_then(Value::as_str) {
                Some("string") => UserConfigType::String,
                Some("boolean") => UserConfigType::Boolean,
                Some("number") => UserConfigType::Number,
                _ => anyhow::bail!("unsupported userConfig type"),
            };
            let boolean = |key| -> Result<bool> {
                object
                    .get(key)
                    .map(|v| v.as_bool().context("userConfig flag must be boolean"))
                    .transpose()
                    .map(|v| v.unwrap_or(false))
            };
            let text = |key| -> Result<Option<String>> {
                object
                    .get(key)
                    .map(|v| {
                        v.as_str()
                            .filter(|v| v.len() <= 4096)
                            .map(str::to_owned)
                            .context("invalid userConfig text")
                    })
                    .transpose()
            };
            let sensitive = boolean("sensitive")?;
            ensure!(
                !sensitive || matches!(field_type, UserConfigType::String),
                "sensitive userConfig must be string"
            );
            ensure!(
                !sensitive || !object.contains_key("default"),
                "sensitive defaults are unsupported"
            );
            let default = object
                .get("default")
                .map(|v| serde_json::from_value::<PublicConfigValue>(v.clone()))
                .transpose()?;
            let field = UserConfigField {
                field_type,
                title: text("title")?,
                description: text("description")?,
                required: boolean("required")?,
                sensitive,
                default,
            };
            if let Some(default) = &field.default {
                ensure!(
                    matches!(
                        (&field.field_type, default),
                        (UserConfigType::String, PublicConfigValue::String(_))
                            | (UserConfigType::Boolean, PublicConfigValue::Boolean(_))
                            | (UserConfigType::Number, PublicConfigValue::Number(_))
                    ),
                    "userConfig default type mismatch"
                );
            }
            Ok((key.clone(), field))
        })
        .collect()
}
impl PluginUserConfiguration {
    pub fn mcp_bindings(
        &self,
        schema: &BTreeMap<String, UserConfigField>,
        mut resolve_secret: impl FnMut(&str) -> Result<String>,
    ) -> Result<BTreeMap<String, areal_mcp::UserConfigBinding>> {
        self.validate(schema)?;
        let mut bindings = BTreeMap::new();
        for (key, field) in schema {
            let value = match self.values.get(key) {
                Some(PluginConfigValue::String(value)) => Some(value.clone()),
                Some(PluginConfigValue::Boolean(value)) => Some(value.to_string()),
                Some(PluginConfigValue::Number(value)) => Some(value.to_string()),
                Some(PluginConfigValue::SecretRef(reference)) => {
                    Some(resolve_secret(reference).map_err(|_| {
                        anyhow::anyhow!("plugin credential reference is unavailable")
                    })?)
                }
                None => field.default.as_ref().map(|value| match value {
                    PublicConfigValue::String(value) => value.clone(),
                    PublicConfigValue::Boolean(value) => value.to_string(),
                    PublicConfigValue::Number(value) => value.to_string(),
                }),
            };
            if let Some(value) = value {
                bindings.insert(
                    key.clone(),
                    areal_mcp::UserConfigBinding {
                        value,
                        sensitive: field.sensitive,
                    },
                );
            } else {
                ensure!(!field.required, "required plugin configuration is missing");
            }
        }
        Ok(bindings)
    }
    pub fn public_view(
        &self,
        schema: &BTreeMap<String, UserConfigField>,
    ) -> PluginConfigurationView {
        let mut missing_required = Vec::new();
        let fields = schema
            .iter()
            .map(|(key, definition)| {
                let configured = self.values.contains_key(key) || definition.default.is_some();
                if definition.required && !configured {
                    missing_required.push(key.clone());
                }
                let value = if definition.sensitive {
                    None
                } else {
                    match self.values.get(key) {
                        Some(PluginConfigValue::String(value)) => {
                            Some(PublicConfigValue::String(value.clone()))
                        }
                        Some(PluginConfigValue::Boolean(value)) => {
                            Some(PublicConfigValue::Boolean(*value))
                        }
                        Some(PluginConfigValue::Number(value)) => {
                            Some(PublicConfigValue::Number(value.clone()))
                        }
                        _ => definition.default.clone(),
                    }
                };
                (
                    key.clone(),
                    PluginConfigPublicField {
                        definition: definition.clone(),
                        configured,
                        value,
                    },
                )
            })
            .collect();
        PluginConfigurationView {
            fields,
            missing_required,
            revision: self.revision,
        }
    }
    pub fn validate(&self, schema: &BTreeMap<String, UserConfigField>) -> Result<()> {
        for (key, value) in &self.values {
            let field = schema.get(key).context("unknown userConfig field")?;
            let valid = match (field.sensitive, field.field_type, value) {
                (true, UserConfigType::String, PluginConfigValue::SecretRef(reference)) => {
                    !reference.is_empty() && reference.len() <= 4096 && !reference.contains('\0')
                }
                (false, UserConfigType::String, PluginConfigValue::String(value)) => {
                    value.len() <= 65536 && !value.contains('\0')
                }
                (false, UserConfigType::Boolean, PluginConfigValue::Boolean(_))
                | (false, UserConfigType::Number, PluginConfigValue::Number(_)) => true,
                _ => false,
            };
            ensure!(valid, "userConfig value type mismatch");
        }
        Ok(())
    }
}
impl Store {
    pub fn configure_user_values(
        &self,
        id: &str,
        expected_revision: u64,
        expected_digest: &str,
        values: BTreeMap<String, PluginConfigValue>,
    ) -> Result<PluginList> {
        self.transact(expected_revision, |state| {
            let detail = state.installed.get(id).context("plugin not installed")?;
            ensure!(
                detail.review_digest() == expected_digest,
                "installed plugin digest changed"
            );
            let components = self.installed_component(state, detail)?;
            let configuration = PluginUserConfiguration {
                installed_digest: expected_digest.into(),
                revision: state
                    .revision
                    .checked_add(1)
                    .context("plugin revision overflow")?,
                values,
            };
            configuration.validate(&components.user_config_schema)?;
            state.user_configuration.insert(id.into(), configuration);
            Ok(())
        })?;
        self.list()
    }
}
