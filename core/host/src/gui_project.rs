//! GUI 首次登记沿 Host 的既有启动输入与资源物化器准备，不启动 Node 或 Core。
use super::{Host, library_store, workbench_route, workbench_utility};
use crate::{
    LaunchInputs, ProjectRegistration, ProjectSource, SchedulePreparation, builtin_skills, launch,
    schedule_resources,
};
use anyhow::{Context, Result, ensure};
use areal_local_service::{LocalArgs, storage};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};

fn launch_path(host: &Host, project: &ProjectRegistration) -> PathBuf {
    host.home
        .join("host/launch")
        .join(storage::digest(project.project_id.as_bytes()))
        .join("inputs.json")
}

pub(super) async fn initialize(
    host: &Host,
    source: &str,
    project: &ProjectRegistration,
) -> Result<()> {
    let gate = host.gate(&project.project_id)?;
    let _initial = gate.write().await;
    host.admission()?;
    let path = launch_path(host, project);
    if storage::read_optional::<LaunchInputs>(&path)?.is_some() {
        return Ok(());
    }
    let options = options(host, source)?;
    let inputs = prepare(host, source, project, &options).await?;
    ensure!(self::options(host, source)? == options, "RESYNC_REQUIRED");
    storage::private_dir(path.parent().unwrap())?;
    storage::write(&path, &inputs)
}

pub(super) async fn missing_inputs(
    host: &Host,
    project: &ProjectRegistration,
) -> Result<LaunchInputs> {
    if !matches!(project.source, ProjectSource::Gui { .. }) {
        return Err(crate::wire::error(
            "configurationConflict",
            "first activation requires launchInputs",
        ));
    }
    let source = host
        .migration
        .credential_source(project)?
        .context("GUI_SOURCE_PENDING")?;
    let original = options(host, &source)?;
    let prepared = prepare(host, &source, project, &original).await?;
    ensure!(options(host, &source)? == original, "RESYNC_REQUIRED");
    Ok(prepared)
}

pub(super) fn options(host: &Host, source: &str) -> Result<Value> {
    host.schedules
        .connections
        .frontend_launch_options(source)
        .map(Ok)
        .unwrap_or_else(|| host.gateway.workbench.utility_options(source))
}

fn managed(host: &Host, options: &Value) -> Result<bool> {
    let Some(path) = options["desktopConfig"].as_str() else {
        return Ok(true);
    };
    let requested = Path::new(path);
    ensure!(requested.is_absolute(), "INVALID_PARAMS");
    let source = host
        .bin
        .join("../../clients/gui/packages/workbench/assets/desktop-profile.json")
        .canonicalize()
        .ok();
    let packaged = host
        .bin
        .join("../../app.asar")
        .canonicalize()
        .ok()
        .map(|path| path.join("node_modules/@areal/workbench/assets/desktop-profile.json"));
    Ok(source.as_deref() == Some(requested) || packaged.as_deref() == Some(requested))
}

fn hooks(home: &Path, options: &Value) -> Result<Value> {
    let config = areal_config::load_service_config(&workbench_utility::inputs(options)?)?.0;
    let external = config.tool_extensions_file;
    let path = external
        .clone()
        .unwrap_or_else(|| home.join("tool-extensions.json"));
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&path);
    let bytes = match file {
        Ok(file) => {
            ensure!(
                file.metadata()?.is_file(),
                "tool extensions must be a regular file"
            );
            let mut bytes = Vec::new();
            file.take(1024 * 1024 + 1).read_to_end(&mut bytes)?;
            ensure!(bytes.len() <= 1024 * 1024, "tool extensions exceed limit");
            bytes
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && external.is_none() => {
            storage::write_bytes(&path, b"{}")?;
            b"{}".to_vec()
        }
        Err(error) => return Err(error.into()),
    };
    let value: areal_engine::tools::ToolExtensions = serde_json::from_slice(&bytes)?;
    value.validate()?;
    Ok(serde_json::from_slice(&bytes)?)
}

async fn prepare(
    host: &Host,
    source: &str,
    project: &ProjectRegistration,
    options: &Value,
) -> Result<LaunchInputs> {
    let home = library_store::source_home(host, source)?;
    let alias = workbench_route::backend_project_alias(host, source, &project.project_id)?;
    let directory = home.join(&alias);
    storage::private_dir(&directory)?;
    let scratch = directory.join("scratch");
    storage::private_dir(&scratch)?;
    let config = workbench_utility::inputs(options)?;
    let mut environment: BTreeMap<String, String> = std::env::vars()
        .filter(|(key, _)| launch::allowed_environment(key))
        .collect();
    // 配置根沿 LaunchInputs 单独绑定，不能混入继承环境；秘密由 ensure_inner 注入。
    let config_home = options["configHome"]
        .as_str()
        .map(PathBuf::from)
        .or_else(|| {
            config
                .env
                .get(std::ffi::OsStr::new("AREAL_HARNESS_HOME"))
                .map(PathBuf::from)
        })
        .or_else(|| config.homedir.as_ref().map(|home| home.join(".areal")))
        .context("GUI configuration home missing")?;
    let mut args = LocalArgs {
        workspace: Some(project.workspace.clone()),
        data_dir: Some(project.data_dir.clone()),
        scratch: Some(scratch),
        config: config.config_file.clone(),
        allow_write: true,
        allow_network: false,
        allow_concurrent_writes: options["desktopProcesses"] == true,
        desktop_process_timeout_ms: (options["desktopProcesses"] == true).then_some(86400000),
        sandbox_profile: options["sandboxProfile"].as_str().map(str::to_owned),
        workgroup_policy: options["workgroupPolicy"].as_str().map(PathBuf::from),
        workgroup_toolchain: options["workgroupToolchain"].as_str().map(PathBuf::from),
        ..Default::default()
    };
    let settings = library_store::read_source(host, source)?;
    let network = match crate::network::desktop(&settings["settings"], &environment).await {
        Ok(network) => crate::network::launch_environment(
            network,
            launch_path(host, project).parent().unwrap(),
        ),
        Err(error) => Err(error),
    };
    match network {
        Ok(network) => environment.extend(network),
        Err(_) => {
            args.history_only = true;
            eprintln!("Host GUI network preparation unavailable; using history-only Core");
        }
    }
    let hook_value = match hooks(&home, options) {
        Ok(value) => value,
        Err(_) => {
            args.history_only = true;
            eprintln!("Host GUI hook preparation unavailable; using history-only Core");
            json!({})
        }
    };
    let extensions = directory.join("desktop-tool-extensions.json");
    storage::write(&extensions, &hook_value)?;
    environment.insert(
        "AREAL_HARNESS_TOOL_EXTENSIONS".into(),
        extensions.to_string_lossy().into_owned(),
    );
    let is_managed = managed(host, options)?;
    let builtin_profile: Value = serde_json::from_str(include_str!(
        "../../../clients/gui/packages/workbench/assets/desktop-profile.json"
    ))?;
    let default_profile=options.get("defaultProfile").cloned().unwrap_or_else(||json!({"id":builtin_profile["profiles"][0]["id"],"revision":builtin_profile["profiles"][0]["revision"]}));
    let preparation = if is_managed {
        SchedulePreparation::Managed {
            resource_state_path: home.join("resources.json"),
            user_managed_skills_root: home.join("resources/user/skills"),
            project_managed_skills_root: home.join("resources").join(&alias).join("skills"),
            project_resource_scope: alias.clone(),
            default_profile,
        }
    } else {
        SchedulePreparation::External {
            default_profile: options.get("defaultProfile").cloned(),
        }
    };
    let names = areal_config::load_service_config(&config)
        .ok()
        .map(|(config, _)| {
            config
                .model
                .api_key_env
                .into_iter()
                .chain(
                    config
                        .model_catalog
                        .into_iter()
                        .filter_map(|provider| provider.api_key_env),
                )
                .collect()
        })
        .unwrap_or_default();
    let mut inputs = LaunchInputs {
        workspace: project.workspace.clone(),
        cwd: project.workspace.clone(),
        config_home,
        homedir: config.homedir.clone(),
        config_path: config.config_file,
        deployment_path: None,
        schedule_preparation: Some(preparation),
        environment,
        credential_names: names,
        options: args,
    };
    let deployment = (|| -> Result<PathBuf> {
        if !is_managed {
            return options["desktopConfig"]
                .as_str()
                .map(PathBuf::from)
                .context("external deployment missing");
        }
        let builtin = builtin_skills::materialize(&home)?;
        let seed = home.join(format!("{alias}-desktop.json"));
        if !seed.try_exists()? {
            let mut value = builtin_profile;
            value["skills"] = json!([{"id":builtin_skills::ID,"revision":builtin.revision,"root":builtin.root,"metadata":{"name":builtin.metadata.name,"description":builtin.metadata.description}}]);
            storage::write(&seed, &value)?;
        }
        inputs.deployment_path = Some(seed);
        Ok(schedule_resources::materialize(&host.home, project, &inputs)?.deployment_path)
    })();
    match deployment {
        Ok(path) => {
            inputs.deployment_path = Some(path.clone());
            inputs.options.desktop_config = Some(path);
        }
        Err(_) => {
            inputs.options.history_only = true;
            inputs.deployment_path = None;
            eprintln!("Host GUI resource preparation unavailable; using history-only Core");
        }
    }
    launch::validate(&inputs, project)?;
    Ok(inputs)
}
