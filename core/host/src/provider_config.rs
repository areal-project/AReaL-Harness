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

/// 配置写入只依赖 Host 的来源与规范配置，不等待任何项目进入空闲。
pub(super) fn native_write(request: &Value) -> bool {
    matches!(
        request["operation"].as_str(),
        Some(
            "save"
                | "remove"
                | "default"
                | "saveAndApply"
                | "removeAndApply"
                | "defaultAndApply"
                | "apply"
        )
    )
}

pub(super) fn endpoint(base: &str, protocol: &str) -> Result<String> {
    let mut url = url::Url::parse(base).map_err(|_| anyhow::anyhow!("INVALID_PARAMS"))?;
    ensure!(
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "INVALID_PARAMS"
    );
    let path = url.path().trim_end_matches('/');
    let path = path
        .strip_suffix("/responses")
        .or_else(|| path.strip_suffix("/chat/completions"))
        .unwrap_or(path)
        .to_owned();
    url.set_path(&path);
    Ok(format!(
        "{}{}",
        url.as_str().trim_end_matches('/'),
        if protocol == "responses" {
            "/responses"
        } else {
            "/chat/completions"
        }
    ))
}

pub(super) async fn write(
    host: &std::rc::Rc<Host>,
    source: &str,
    command: &str,
    request: &Value,
) -> Result<String> {
    ensure!(native_write(request), "INVALID_PARAMS");
    let options = host.gateway.workbench.utility_options(source)?;
    import_saved_configuration(host, source, &options)?;
    let current = workbench_utility::models_catalog(host, source, &options)?;
    ensure!(
        request["expectedRevision"] == current["revision"],
        "TARGET_CHANGED"
    );
    if request["operation"] == "apply" {
        host.changed();
        return Ok(current["revision"]
            .as_str()
            .context("INVALID_RESPONSE")?
            .to_owned());
    }
    let mut request = request.clone();
    let auto_discover = request["operation"] == "saveAndApply" || request["discoverModels"] == true;
    if let Some(operation) = request["operation"]
        .as_str()
        .and_then(|op| op.strip_suffix("AndApply"))
    {
        request["operation"] = json!(operation.to_owned());
    }
    let mut data: Vec<ProviderConfig> = serde_json::from_value(current["data"].clone())?;
    let mut default_model: Option<areal_config::models::ModelRef> =
        serde_json::from_value(current["defaultModel"].clone())?;
    let mut credential = None;
    match request["operation"].as_str() {
        Some("default") => {
            default_model =
                serde_json::from_value(request["model"].clone()).context("INVALID_PARAMS")?
        }
        Some("remove") => {
            let id = request["id"].as_str().context("INVALID_PARAMS")?;
            ensure!(
                data.iter().any(|provider| provider.id == id),
                "TARGET_CHANGED"
            );
            data.retain(|provider| provider.id != id);
            if default_model
                .as_ref()
                .is_some_and(|model: &areal_config::models::ModelRef| model.provider_id == id)
            {
                default_model = None;
            }
        }
        Some("save") => {
            let raw = &request["provider"];
            let previous = raw["id"]
                .as_str()
                .map(|id| {
                    data.iter()
                        .find(|provider| provider.id == id)
                        .cloned()
                        .context("TARGET_CHANGED")
                })
                .transpose()?;
            let protocol = match raw["protocol"].as_str() {
                Some("responses") => "responses",
                Some("chatCompletions") => "chat-completions",
                _ => anyhow::bail!("INVALID_PARAMS"),
            };
            let base = raw["baseUrl"].as_str().context("INVALID_PARAMS")?;
            let endpoint = if let Some(previous) = &previous
                && super::provider_catalog::base_url(&previous.endpoint) == base
                && serde_json::to_value(previous.protocol)? == protocol
            {
                previous.endpoint.clone()
            } else {
                endpoint(base, protocol)?
            };
            let mut models = raw["models"].as_array().context("INVALID_PARAMS")?.clone();
            for model in &mut models {
                model["id"] = json!(model["id"].as_str().context("INVALID_PARAMS")?.trim());
                if let Some(name) = model["displayName"].as_str() {
                    let name = name.trim().to_owned();
                    if name.is_empty() {
                        model.as_object_mut().unwrap().remove("displayName");
                    } else {
                        model["displayName"] = json!(name);
                    }
                }
            }
            let mut reference = previous
                .as_ref()
                .and_then(|provider| provider.api_key_env.clone());
            if request["authentication"] == "none" {
                reference = None;
            } else if let Some(key) = request.get("apiKey") {
                let key = key.as_str().context("INVALID_PARAMS")?;
                ensure!(
                    key.len() <= 16384 && key.bytes().all(|byte| (0x20..=0x7e).contains(&byte)),
                    "INVALID_PARAMS"
                );
                let key = key.trim();
                if !key.is_empty() {
                    let name = format!("AREAL_CREDENTIAL_{}", command.replace('-', ""));
                    credential = Some((name.clone(), key.to_owned()));
                    reference = Some(name);
                } else if request["authentication"] != "apiKey" {
                    reference = None;
                }
            }
            ensure!(
                request["authentication"] != "apiKey" || reference.is_some(),
                "PROVIDER_CREDENTIAL_REQUIRED"
            );
            if auto_discover && previous.is_none() && raw["enabled"] != false && models.is_empty() {
                let key = credential.as_ref().map(|(_, key)| key.clone());
                let discovered = host.gateway.workbench.discover_provider(host,source,json!({"baseUrl":base,
                    "protocol":raw["protocol"],"credential":match key {Some(key)=>json!({"kind":"draft","value":key}),None=>json!({"kind":"none"})}})).await?;
                let ids = discovered["models"]
                    .as_array()
                    .filter(|ids| !ids.is_empty())
                    .context("INVALID_RESPONSE")?;
                for id in ids {
                    let id = id.as_str().context("INVALID_RESPONSE")?;
                    let mut model = json!({"id":id,"enabled":true,"parameters":{},"capabilities":{"tools":true,"vision":false,"reasoning":true}});
                    if let Some(window) =
                        discovered["modelParameters"][id].get("contextWindowTokens")
                    {
                        model["reportedContextWindowTokens"] = window.clone();
                    }
                    models.push(model);
                }
            }
            let mut provider = json!({"id":previous.as_ref().map(|value|value.id.clone()).unwrap_or_else(||format!("app_{}", command.replace('-', ""))),
                "name":raw["name"].as_str().context("INVALID_PARAMS")?.trim(),
                "endpoint":endpoint,"protocol":protocol,"enabled":raw["enabled"] != false,"models":models,
                "parameters":raw.get("parameters").cloned().unwrap_or_else(||json!({}))});
            if let Some(reference) = reference {
                provider["apiKeyEnv"] = json!(reference);
            }
            let provider: ProviderConfig =
                serde_json::from_value(provider).context("INVALID_PARAMS")?;
            if let Some(previous) = previous {
                *data
                    .iter_mut()
                    .find(|provider| provider.id == previous.id)
                    .unwrap() = provider;
            } else {
                data.push(provider);
            }
        }
        _ => anyhow::bail!("INVALID_PARAMS"),
    }
    if let Some((reference, key)) = credential {
        let receipt = host.migration.vault.dispatch_async("vault.replace", json!({
            "requestId":command,"expectedGeneration":host.identity.generation,"expectedRevision":0,
            "slot":{"kind":"providerCredential","sourceId":source,"reference":reference},"value":key,
        }), &host.identity.generation, &host.migration).await?;
        ensure!(receipt["state"] == "completed", "SUBMISSION_UNKNOWN");
    }
    host.admission()?;
    ensure!(
        host.gateway.workbench.backend_has_source(source),
        "FORBIDDEN"
    );
    let mut inputs = workbench_utility::inputs(&options)?;
    for (name, value) in host.gateway.workbench.environment_credentials(source) {
        inputs.env.insert(name.into(), value.into());
    }
    let references = host
        .migration
        .vault
        .provider_references(source)?
        .into_iter()
        .collect::<Vec<_>>();
    for reference in &references {
        inputs.env.remove(std::ffi::OsStr::new(reference));
    }
    let written = areal_config::models::write(
        &inputs,
        ModelConfigurationUpdate {
            expected_revision: current["revision"]
                .as_str()
                .context("INVALID_RESPONSE")?
                .to_owned(),
            data,
            default_model,
        },
        &references,
    )
    .map_err(|error| match error.kind {
        areal_config::ConfigErrorKind::Conflict => anyhow::anyhow!("TARGET_CHANGED"),
        areal_config::ConfigErrorKind::Io => error.into(),
        _ => anyhow::anyhow!("INVALID_PARAMS"),
    })?;
    host.changed();
    Ok(written.revision)
}
