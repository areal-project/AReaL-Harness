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

pub(super) async fn execute_with_options(
    host: &Host,
    source: &str,
    params: Value,
    options: Value,
) -> Result<Value> {
    host.migration.source_profile(source)?;
    let operation = params["operation"].as_str().context("INVALID_PARAMS")?;
    let fields: &[&str] = match operation {
        "modelsCatalog" | "modelsRead" | "configShow" | "feedbackStatus" => &["operation"],
        "modelsWrite" | "configValidate" | "feedbackSubmit" => &["operation", "document"],
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
    let mut inputs = inputs(&options)?;
    let mut stored = Vec::new();
    if operation == "modelsCatalog" {
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
        // 沿用配置解析器选出的实际凭据来源，包含当前模型的环境覆盖。
        for (id, source) in value["credentialSources"]
            .as_object()
            .cloned()
            .unwrap_or_default()
        {
            if source == "stored" {
                value["credentialStates"][&id] = json!("checking");
            }
        }
        return Ok(value);
    }

    if matches!(
        operation,
        "modelsRead" | "modelsWrite" | "feedbackStatus" | "feedbackSubmit"
    ) {
        if matches!(operation, "modelsRead" | "modelsWrite") {
            for (name, value) in host.gateway.workbench.environment_credentials(source) {
                inputs.env.insert(name.into(), value.into());
            }
        }
        let references = host.migration.vault.provider_references(source)?;
        for reference in references {
            inputs.env.remove(OsString::from(&reference).as_os_str());
            let value = host.migration.vault.dispatch_async("vault.read", json!({"slot":{"kind":"providerCredential","sourceId":source,"reference":reference},"interactionAllowed":false}), "", &host.migration).await;
            match value {
                Ok(value) => {
                    if let Some(value) = value["value"].as_str() {
                        inputs.env.insert(reference.clone().into(), value.into());
                        stored.push(reference);
                    }
                }
                Err(error)
                    if error
                        .downcast_ref::<crate::wire::Error>()
                        .is_some_and(|error| {
                            matches!(error.code, "storageLocked" | "storageMissing")
                        }) => {}
                Err(error) => return Err(error),
            }
        }
    }
    if operation == "feedbackStatus" || operation == "feedbackSubmit" {
        return feedback(host, &options, &inputs, operation, &params).await;
    }
    match operation {
        // 模型目录读写仍由 areal-config 执行 revision 校验、配置解析与脱敏。
        "modelsRead" | "modelsWrite" => {
            let value = if operation == "modelsRead" {
                areal_config::models::read(&inputs, &stored)?
            } else {
                areal_config::models::write(
                    &inputs,
                    serde_json::from_str(document(&params)?)?,
                    &stored,
                )?
            };
            Ok(serde_json::to_value(value)?)
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

async fn feedback(
    host: &Host,
    options: &Value,
    inputs: &ConfigInputs,
    operation: &str,
    params: &Value,
) -> Result<Value> {
    use areal_local_service::native_process::TrustedCommand;
    use std::{os::fd::OwnedFd, process::Stdio, time::Duration};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let data = if operation == "feedbackSubmit" {
        let text = params["document"].as_str().context("INVALID_PARAMS")?;
        ensure!(text.len() <= (16 << 20) + (128 << 10), "LIMIT_EXCEEDED");
        ensure!(
            serde_json::from_str::<Value>(text)?.is_object(),
            "INVALID_PARAMS"
        );
        text.as_bytes()
    } else {
        &[]
    };
    let mut command = TrustedCommand::supervised(&host.bin.join("areal"), &[])?;
    command
        .arg("trajectory")
        .arg(if operation == "feedbackStatus" {
            "feedback-status"
        } else {
            "feedback-submit"
        });
    if let Some(config) = options["config"].as_str() {
        command.arg("--config").arg(config);
    }
    let (reader, writer) = std::os::unix::net::UnixStream::pair()?;
    reader.set_nonblocking(true)?;
    command
        .env_clear()
        .envs(&inputs.env)
        .current_dir(&inputs.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::from(OwnedFd::from(writer)))
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().await?;
    drop(command);
    let mut stdin = child.stdin.take().context("feedback stdin missing")?;
    let stdout = tokio::net::UnixStream::from_std(reader)?;
    let result = tokio::time::timeout(Duration::from_secs(30), async {
        let write = async {
            stdin.write_all(data).await?;
            drop(stdin);
            Ok::<_, anyhow::Error>(())
        };
        let read = async {
            let mut bytes = Vec::new();
            stdout.take((2 << 20) + 1).read_to_end(&mut bytes).await?;
            ensure!(bytes.len() <= 2 << 20, "LIMIT_EXCEEDED");
            Ok::<_, anyhow::Error>(bytes)
        };
        // 子进程 stderr 不进入公开回执或日志，避免透出配置、地址或凭据。
        let (_, bytes) = tokio::try_join!(write, read)?;
        ensure!(child.wait().await?.success(), "feedback outcome unknown");
        let value: Value = serde_json::from_slice(&bytes)?;
        ensure!(value.is_object(), "invalid feedback receipt");
        Ok::<_, anyhow::Error>(value)
    })
    .await;
    match result {
        Ok(Ok(value)) => Ok(value),
        _ => {
            let _ = child.kill().await;
            anyhow::bail!("feedback outcome unknown")
        }
    }
}
