//! 页面宿主的有限配置操作复用原 Rust 权威，不运行 Core CLI，也不接收 argv/环境/任意路径。
use super::Host;
use anyhow::{Context, Result, ensure};
use areal_config::ConfigInputs;
use serde_json::{Value, json};
use std::{collections::BTreeMap, ffi::OsString, io::Read, path::PathBuf};

fn document(params: &Value) -> Result<&str> {
    let text = params["document"].as_str().context("INVALID_PARAMS")?;
    ensure!(text.len() <= 1024 * 1024, "LIMIT_EXCEEDED");
    Ok(text)
}
fn extensions(text: &[u8]) -> Result<()> {
    ensure!(text.len() <= 1024 * 1024, "LIMIT_EXCEEDED");
    let value: areal_engine::tools::ToolExtensions =
        serde_json::from_slice(text).context("invalid tool extensions JSON")?;
    value.validate()
}
pub(super) fn inputs(options: &Value) -> Result<ConfigInputs> {
    let user_home = options["userHome"]
        .as_str()
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from));
    let mut env: BTreeMap<OsString, OsString> = std::env::vars_os().collect();
    if let Some(home) = &user_home {
        env.insert("HOME".into(), home.as_os_str().to_owned());
    }
    if let Some(home) = options["configHome"].as_str() {
        env.insert("AREAL_HARNESS_HOME".into(), home.into());
    }
    if let Some(path) = options["toolExtensions"].as_str() {
        env.insert("AREAL_HARNESS_TOOL_EXTENSIONS".into(), path.into());
    }
    Ok(ConfigInputs {
        cwd: PathBuf::from(options["home"].as_str().context("CAPABILITY_UNAVAILABLE")?),
        homedir: user_home,
        env,
        config_file: options["config"].as_str().map(PathBuf::from),
        ..Default::default()
    })
}
pub(super) async fn execute(host: &Host, source: &str, params: Value) -> Result<Value> {
    let options = host.gateway.workbench.utility_options(source)?;
    execute_with_options(host, source, params, options).await
}

pub(super) fn models_catalog(host: &Host, source: &str, options: &Value) -> Result<Value> {
    let mut inputs = inputs(options)?;
    for (name, value) in host.gateway.workbench.environment_credentials(source) {
        inputs.env.insert(name.into(), value.into());
    }
    let references: Vec<_> = host
        .migration
        .vault
        .provider_references(source)?
        .into_iter()
        .collect();
    for reference in &references {
        inputs.env.remove(OsString::from(reference).as_os_str());
    }
    let mut value = serde_json::to_value(areal_config::models::read(&inputs, &references)?)?;
    for (id, source) in value["credentialSources"]
        .as_object()
        .cloned()
        .unwrap_or_default()
    {
        if source == "stored" {
            value["credentialStates"][&id] = json!("checking");
        }
    }
    Ok(value)
}

pub(super) async fn execute_with_options(
    host: &Host,
    source: &str,
    params: Value,
    options: Value,
) -> Result<Value> {
    host.migration.source_profile(source)?;
    let operation = params["operation"].as_str().context("INVALID_PARAMS")?;
    let fields: &[&str] = match operation {
        "modelsCatalog" | "modelsRead" | "configShow" => &["operation"],
        "configValidate" => &["operation", "document"],
        "pluginSnapshot" => &["operation", "projectId", "pluginId"],
        "pluginDoctor" => &["operation", "projectId"],
        _ => anyhow::bail!("INVALID_PARAMS"),
    };
    ensure!(
        params
            .as_object()
            .context("INVALID_PARAMS")?
            .keys()
            .all(|key| fields.contains(&key.as_str())),
        "INVALID_PARAMS"
    );
    for key in ["projectId", "pluginId"] {
        if let Some(value) = params.get(key) {
            ensure!(
                value.as_str().is_some_and(|value| !value.is_empty()
                    && value.chars().count() <= 256
                    && !value.contains('\0')),
                "INVALID_PARAMS"
            );
        }
    }
    if operation == "modelsRead" {
        super::provider_config::import_saved_configuration(host, source, &options)?;
    }
    let mut inputs = inputs(&options)?;
    let mut stored = Vec::new();
    let mut credential_values = BTreeMap::new();
    let mut credential_errors = BTreeMap::new();
    let mut credential_references = Vec::new();
    if operation == "modelsCatalog" {
        return models_catalog(host, source, &options);
    }

    if operation == "modelsRead" {
        for (name, value) in host.gateway.workbench.environment_credentials(source) {
            inputs.env.insert(name.into(), value.into());
        }
        let catalog = models_catalog(host, source, &options)?;
        let references = catalog["data"]
            .as_array()
            .context("INVALID_RESPONSE")?
            .iter()
            .filter_map(|provider| provider["apiKeyEnv"].as_str())
            .filter(|reference| reference.starts_with("AREAL_CREDENTIAL_"))
            .map(str::to_owned)
            .collect::<std::collections::BTreeSet<_>>();
        for reference in references {
            credential_references.push(reference.clone());
            inputs.env.remove(OsString::from(&reference).as_os_str());
            let value = host.migration.vault.dispatch_async("vault.read", json!({"slot":{"kind":"providerCredential","sourceId":source,"reference":reference},"interactionAllowed":false}), &host.identity.generation, &host.migration).await;
            match value {
                Ok(value) => {
                    if let Some(value) = value["value"].as_str() {
                        inputs.env.insert(reference.clone().into(), value.into());
                        credential_values.insert(reference.clone(), value.to_owned());
                        stored.push(reference);
                    }
                }
                Err(error)
                    if error
                        .downcast_ref::<crate::wire::Error>()
                        .is_some_and(|error| {
                            matches!(
                                error.code,
                                "storageLocked" | "storageMissing" | "storageAuthorizationRequired"
                            )
                        }) =>
                {
                    credential_errors.insert(
                        reference,
                        error.downcast_ref::<crate::wire::Error>().unwrap().code,
                    );
                }
                Err(error) => return Err(error),
            }
        }
    }
    match operation {
        // 模型读取沿规范配置；写入只经公共 providers.command。
        "modelsRead" => {
            let value = areal_config::models::read(&inputs, &stored)?;
            // 仅供受监督工作台的私有反向调用；凭据不进入公共目录或配置文件。
            Ok(json!({
                "snapshot": value,
                "credentials": {
                    "references": credential_references,
                    "values": credential_values,
                    "errors": credential_errors
                }
            }))
        }
        // show 使用与 Core 管理诊断相同的加载器；validate 只校验页面已读到的扩展文档。
        "configShow" => {
            let config = areal_config::load_management_config(&inputs)?;
            if let Some(path) = &config.tool_extensions_file {
                let mut bytes = Vec::new();
                std::fs::File::open(path)?
                    .take(1024 * 1024 + 1)
                    .read_to_end(&mut bytes)?;
                extensions(&bytes)?;
            }
            Ok(config.diagnostic(false))
        }
        "configValidate" => {
            areal_config::load_management_config(&inputs)?;
            extensions(document(&params)?.as_bytes())?;
            Ok(Value::Null)
        }
        // 插件只读快照直接复用插件库；工作区必须来自当前 source 的已登记 alias。
        "pluginSnapshot" | "pluginDoctor" => {
            let registrations: Vec<_> = host
                .slots
                .borrow()
                .values()
                .map(|slot| slot.registration.clone())
                .collect();
            let workspace = if let Some(alias) = params["projectId"].as_str() {
                let bindings = host.migration.remote_bindings(source, &registrations)?;
                let selected: Vec<_> = bindings.iter().filter(|(_, name)| name == alias).collect();
                ensure!(selected.len() == 1, "RESOURCE_UNAVAILABLE");
                Some(
                    registrations
                        .iter()
                        .find(|project| project.project_id == selected[0].0)
                        .context("RESOURCE_UNAVAILABLE")?
                        .workspace
                        .clone(),
                )
            } else {
                None
            };
            let home = options["configHome"]
                .as_str()
                .map(PathBuf::from)
                .or_else(|| inputs.homedir.as_ref().map(|home| home.join(".areal")))
                .context("CAPABILITY_UNAVAILABLE")?;
            let snapshot = areal_plugins::Store::read_snapshot(
                home.join("plugins"),
                workspace,
                inputs.homedir,
                params["pluginId"].as_str(),
            )?;
            Ok(if operation == "pluginDoctor" {
                serde_json::to_value(snapshot.doctor())?
            } else {
                serde_json::to_value(snapshot)?
            })
        }
        _ => anyhow::bail!("INVALID_PARAMS"),
    }
}

pub(super) async fn feedback(host: &Host, source: &str, document: Option<Value>) -> Result<Value> {
    host.migration.source_profile(source)?;
    if let Some(document) = &document {
        ensure!(document.is_object(), "INVALID_PARAMS");
        ensure!(
            serde_json::to_vec(document)?.len() <= (16 << 20) + (128 << 10),
            "LIMIT_EXCEEDED"
        );
    }
    let options = host.gateway.workbench.utility_options(source)?;
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        feedback_inner(host, source, inputs(&options)?, document),
    )
    .await
    .map_err(|_| anyhow::anyhow!("feedback outcome unknown"))?
}

async fn feedback_inner(
    host: &Host,
    source: &str,
    mut inputs: ConfigInputs,
    document: Option<Value>,
) -> Result<Value> {
    for (name, value) in host.gateway.workbench.environment_credentials(source) {
        inputs.env.insert(name.into(), value.into());
    }
    let config = areal_config::load_management_config(&inputs)
        .map_err(|_| anyhow::anyhow!("feedback_configuration_unavailable"))?
        .trajectory;
    if !areal_trajectory::feedback::is_active(&config)? {
        ensure!(document.is_none(), "feedback_export_disabled");
        return Ok(json!({"enabled":false,"connected":false}));
    }
    let profile = host.migration.source_profile(source)?;
    if config.headers_file.is_none()
        && let Some(reference) = &config.headers_env
    {
        let references = host.migration.vault.provider_references(source)?;
        if references.contains(reference) {
            inputs.env.remove(OsString::from(reference).as_os_str());
            let value = host.migration.vault.dispatch_async("vault.read", json!({"slot":{
                "kind":"providerCredential","sourceId":source,"reference":reference},"interactionAllowed":false}),
                &host.identity.generation,&host.migration).await
                .map_err(|_| anyhow::anyhow!("feedback_credential_unavailable"))?;
            inputs.env.insert(
                reference.into(),
                value["value"]
                    .as_str()
                    .context("feedback_credential_unavailable")?
                    .into(),
            );
        } else {
            ensure!(
                !reference.starts_with("AREAL_CREDENTIAL_"),
                "feedback_credential_unavailable"
            );
        }
    }
    let headers = areal_trajectory::credential_headers(
        &config,
        config
            .headers_env
            .as_ref()
            .and_then(|name| inputs.env.get(std::ffi::OsStr::new(name)))
            .and_then(|value| value.to_str()),
    )?;
    let settings = super::library_store::read_source(host, source)?;
    let environment = inputs
        .env
        .iter()
        .filter_map(|(name, value)| Some((name.to_str()?.to_owned(), value.to_str()?.to_owned())))
        .collect();
    let network = crate::network::desktop(&settings["settings"], &environment)
        .await
        .map_err(|_| anyhow::anyhow!("feedback_network_unavailable"))?;
    host.admission()?;
    ensure!(
        host.migration.source_profile(source)? == profile
            && host.gateway.workbench.backend_has_source(source),
        "TARGET_CHANGED"
    );
    let latest = areal_config::load_management_config(&inputs)
        .map_err(|_| anyhow::anyhow!("feedback_configuration_unavailable"))?;
    ensure!(
        latest.trajectory.source_revision == config.source_revision,
        "TARGET_CHANGED"
    );
    let client = crate::network::client(&network)
        .map_err(|_| anyhow::anyhow!("feedback_network_unavailable"))?;
    areal_trajectory::feedback::request_with_transport(
        &config,
        document,
        areal_trajectory::feedback::Transport { client, headers },
    )
    .await
}
