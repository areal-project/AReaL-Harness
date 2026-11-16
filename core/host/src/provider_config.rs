//! 旧桌面供应商只导入到现有配置一次；复用原路径标记，Node 不再执行配置导入。
use super::{Host, workbench_utility};
use anyhow::{Context, Result, ensure};
use areal_config::models::{ModelConfigurationUpdate, ProviderConfig};
use areal_local_service::storage;
use serde_json::{Value, json};

pub(super) fn import_saved_configuration(host: &Host, source: &str, options: &Value) -> Result<()> {
    let metadata = host.migration.source_credential_metadata(source)?;
    // 过渡：到 0.1.21 删；旧桌面配置完成停机导入后移除此来源读取。
    let Some(saved) = metadata.get("legacyProviders") else {
        return Ok(());
    };
    let home = super::library_store::source_home(host, source)?;
    let marker = home.join("model-config-migrations.json");
    let mut migrated: Vec<String> =
        serde_json::from_value(metadata["migratedConfigPaths"].clone())?;
    for path in storage::read_optional::<Vec<String>>(&marker)?.unwrap_or_default() {
        if !migrated.contains(&path) {
            migrated.push(path);
        }
    }
    let inputs = workbench_utility::inputs(options)?;
    let references: Vec<_> = host
        .migration
        .vault
        .provider_references(source)?
        .into_iter()
        .collect();
    let current = areal_config::models::read(&inputs, &references)?;
    let path = current
        .path
        .to_str()
        .context("invalid model configuration path")?
        .to_owned();
    if migrated.contains(&path) {
        return Ok(());
    }
    let mut data = current.data;
    for raw in saved["data"]
        .as_array()
        .context("invalid saved providers")?
    {
        let id = raw["id"].as_str().context("invalid saved provider ID")?;
        let protocol = match raw["protocol"].as_str() {
            Some("responses") => "responses",
            Some("chatCompletions" | "chat-completions") => "chat-completions",
            _ => anyhow::bail!("invalid saved provider protocol"),
        };
        let mut provider = json!({"id":id,"name":raw["name"],"enabled":raw["enabled"],
            "endpoint":format!("{}{}",raw["baseUrl"].as_str().context("invalid saved provider endpoint")?,
                if protocol=="responses" {"/responses"}else{"/chat/completions"}),
            "protocol":protocol,"models":raw["models"],"parameters":raw["parameters"]});
        if let Some(reference) = raw.get("apiKeyEnv") {
            ensure!(
                reference == &format!("AREAL_CREDENTIAL_{id}"),
                "invalid saved provider credential reference"
            );
            provider["apiKeyEnv"] = reference.clone();
        }
        let provider: ProviderConfig = serde_json::from_value(provider)?;
        if let Some(existing) = data.iter().find(|existing| existing.id == provider.id) {
            ensure!(
                *existing == provider,
                "saved provider conflicts with current model configuration"
            );
        } else {
            data.push(provider);
        }
    }
    areal_config::models::write(
        &inputs,
        ModelConfigurationUpdate {
            expected_revision: current.revision,
            data,
            default_model: current.default_model,
        },
        &references,
    )?;
    // 完成前保留来源快照；同 ID 冲突不能覆盖当前配置。
    migrated.push(path);
    storage::write(&marker, &migrated)?;
    host.changed();
    Ok(())
}
