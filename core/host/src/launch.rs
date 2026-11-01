use crate::{LaunchInputs, ProjectRegistration, ProjectSource, wire::error};
use anyhow::{Context, Result, ensure};
use areal_local_service::{LaunchContext, LaunchSpec, LocalArgs, storage};
use std::{collections::BTreeMap, os::unix::fs::PermissionsExt, path::Path};

pub struct ResolveProject {
    pub explicit_data_dir: bool,
    pub no_auto_restart: bool,
    pub requested_project_id: Option<String>,
    pub registration: ProjectRegistration,
    pub launch_inputs: LaunchInputs,
    pub credentials: BTreeMap<String, String>,
}
impl ResolveProject {
    pub fn from_local_args(args: &LocalArgs) -> Result<Self> {
        let spec = LaunchSpec::resolve(args)?;
        let context = spec.context.as_ref().unwrap();
        let config = areal_config::load_management_config(&areal_config::ConfigInputs {
            cwd: context.cwd.clone(),
            homedir: context.homedir.clone(),
            env: context.environment.clone(),
            config_file: spec.args.config.clone(),
            overrides: areal_config::ConfigOverrides {
                api_key_env: args.api_key_env.clone(),
                model: args.model.clone(),
                model_provider: args.model_provider.clone(),
                model_endpoint: args.model_endpoint.clone(),
                model_protocol: args.model_protocol.clone(),
                ..Default::default()
            },
        })?;
        let mut credentials = BTreeMap::new();
        let mut names = Vec::new();
        let references: std::collections::BTreeSet<_> = config
            .model
            .api_key_env
            .iter()
            .chain(
                config
                    .model_catalog
                    .iter()
                    .filter_map(|provider| provider.api_key_env.as_ref()),
            )
            .collect();
        for name in references {
            if let Some(value) = context.environment.get(std::ffi::OsStr::new(name)) {
                names.push(name.clone());
                credentials.insert(
                    name.clone(),
                    value
                        .to_str()
                        .context("credential environment must be UTF-8")?
                        .to_owned(),
                );
            } else if config.model.api_key_env.as_ref() == Some(name) {
                names.push(name.clone());
            }
        }
        let environment = std::env::vars()
            .filter(|(name, _)| allowed_environment(name))
            .collect();
        let workspace = spec.args.workspace.clone().unwrap();
        Ok(Self {
            explicit_data_dir: args.data_dir.is_some()
                || !matches!(
                    config.sources.get("server.data_dir"),
                    Some(areal_config::ConfigSource::Default)
                ),
            requested_project_id: None,
            no_auto_restart: false,
            registration: ProjectRegistration {
                project_id: uuid::Uuid::new_v4().to_string(),
                workspace: workspace.clone(),
                data_dir: spec.args.data_dir.clone().unwrap(),
                source: ProjectSource::Cli,
                default_binding: false,
            },
            launch_inputs: LaunchInputs {
                workspace,
                cwd: context.cwd.clone(),
                config_home: config.home.clone(),
                homedir: context.homedir.clone(),
                config_path: spec.args.config.clone(),
                deployment_path: spec.args.desktop_config.clone(),
                environment,
                credential_names: names,
                options: spec.args,
            },
            credentials,
        })
    }
}
pub(crate) fn allowed_environment(name: &str) -> bool {
    areal_config::is_config_environment_name(name)
        || areal_config::PROXY_ENV_VARS.contains(&name)
        || areal_config::TLS_ENV_VARS.contains(&name)
        || matches!(
            name,
            "SSH_AUTH_SOCK"
                | "PATH"
                | "LANG"
                | "LC_ALL"
                | "TERM"
                | "TMPDIR"
                | "SHELL"
                | "USER"
                | "LOGNAME"
        )
}
pub(crate) fn validate(inputs: &LaunchInputs, registration: &ProjectRegistration) -> Result<()> {
    ensure!(
        inputs.workspace == registration.workspace,
        "configurationConflict: workspace differs from registration"
    );
    for path in std::iter::once(&inputs.cwd)
        .chain(std::iter::once(&inputs.config_home))
        .chain(inputs.homedir.iter())
        .chain(inputs.config_path.iter())
        .chain(inputs.deployment_path.iter())
        .chain(inputs.options.workspace.iter())
        .chain(inputs.options.data_dir.iter())
        .chain(inputs.options.scratch.iter())
        .chain(inputs.options.config.iter())
        .chain(inputs.options.desktop_config.iter())
        .chain(inputs.options.workgroup_policy.iter())
        .chain(inputs.options.workgroup_toolchain.iter())
        .chain(inputs.options.read_only_path.iter())
        .chain(inputs.options.task_credential_command.iter())
    {
        ensure!(
            path.is_absolute(),
            "invalidRequest: launch paths must be absolute"
        );
    }
    ensure!(
        inputs
            .options
            .workspace
            .as_ref()
            .is_none_or(|v| v == &registration.workspace)
            && inputs
                .options
                .data_dir
                .as_ref()
                .is_none_or(|v| v == &registration.data_dir),
        "configurationConflict: launch binding differs"
    );
    ensure!(
        inputs
            .environment
            .keys()
            .all(|name| allowed_environment(name)),
        "invalidRequest: unsupported environment name"
    );
    for name in &inputs.credential_names {
        ensure!(
            !name.is_empty()
                && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                && !allowed_environment(name)
                && !name.starts_with("AREAL_HARNESS_")
                && !matches!(
                    name.as_str(),
                    "HOME" | "DYLD_INSERT_LIBRARIES" | "LD_PRELOAD"
                ),
            "invalidRequest: invalid credential name"
        );
    }
    Ok(())
}
pub(crate) fn prepare(
    home: &Path,
    bin: &Path,
    registration: &ProjectRegistration,
    inputs: &LaunchInputs,
    credentials: &BTreeMap<String, String>,
) -> Result<(LaunchSpec, LaunchInputs)> {
    validate(inputs, registration)?;
    for name in &inputs.credential_names {
        if !credentials.contains_key(name) {
            return Err(error(
                "credentialsRequired",
                format!("missing credential environment {name}"),
            ));
        }
    }
    let mut saved = inputs.clone();
    let directory = home
        .join("host/launch")
        .join(storage::digest(registration.project_id.as_bytes()));
    storage::private_dir(&directory)?;
    if let Some(source) = &inputs.deployment_path {
        let mut value: serde_json::Value = serde_json::from_slice(&std::fs::read(source)?)?;
        if let Some(skills) = value
            .get_mut("skills")
            .and_then(serde_json::Value::as_array_mut)
        {
            for skill in skills {
                let path = skill
                    .get_mut("root")
                    .context("deployment skill root missing")?;
                let original = Path::new(
                    path.as_str()
                        .context("deployment skill root must be string")?,
                );
                let root = source.parent().unwrap().join(original).canonicalize()?;
                *path = serde_json::json!(snapshot_skill(&root, &directory)?);
            }
        }
        let digest = storage::digest(&serde_json::to_vec(&value)?);
        let target = directory.join(format!("deployment-{digest}.json"));
        storage::write(&target, &value)?;
        saved.deployment_path = Some(target);
    }
    let mut args = saved.options.clone();
    args.workspace = Some(registration.workspace.clone());
    args.data_dir = Some(registration.data_dir.clone());
    args.config = saved.config_path.clone();
    args.desktop_config = saved.deployment_path.clone();
    saved.options = args.clone();
    let mut environment: BTreeMap<std::ffi::OsString, std::ffi::OsString> = saved
        .environment
        .iter()
        .map(|(k, v)| (k.into(), v.into()))
        .collect();
    environment.insert(
        "AREAL_HARNESS_HOME".into(),
        saved.config_home.as_os_str().into(),
    );
    environment.insert("AREAL_HARNESS_SERVICE_HOME".into(), home.as_os_str().into());
    if let Some(homedir) = &saved.homedir {
        environment.insert("HOME".into(), homedir.as_os_str().into());
    }
    for name in &saved.credential_names {
        environment.insert(name.into(), credentials[name].as_str().into());
    }
    let context = LaunchContext {
        cwd: saved.cwd.clone(),
        homedir: saved.homedir.clone(),
        home: home.to_path_buf(),
        environment,
    };
    let config = areal_config::load_management_config(&areal_config::ConfigInputs {
        cwd: context.cwd.clone(),
        homedir: context.homedir.clone(),
        env: context.environment.clone(),
        config_file: args.config.clone(),
        overrides: areal_config::ConfigOverrides {
            api_key_env: args.api_key_env.clone(),
            model: args.model.clone(),
            model_provider: args.model_provider.clone(),
            model_endpoint: args.model_endpoint.clone(),
            model_protocol: args.model_protocol.clone(),
            ..Default::default()
        },
    })?;
    if let Some(name) = &config.model.api_key_env {
        if !saved.credential_names.contains(name) || !credentials.contains_key(name) {
            return Err(error(
                "credentialsRequired",
                format!("missing credential environment {name}"),
            ));
        }
    }
    let spec = LaunchSpec::in_context(&args, bin.to_path_buf(), &context)?;
    storage::write(&directory.join("inputs.json"), &saved)?;
    Ok((spec, saved))
}

fn snapshot_skill(source: &Path, directory: &Path) -> Result<std::path::PathBuf> {
    ensure!(source.is_dir(), "deployment skill root must be a directory");
    let mut files = Vec::new();
    let mut pending = vec![source.to_path_buf()];
    while let Some(parent) = pending.pop() {
        for entry in std::fs::read_dir(&parent)? {
            let path = entry?.path();
            let resolved = path.canonicalize()?;
            ensure!(
                resolved.starts_with(source),
                "skill reference escapes its root"
            );
            if resolved.is_dir() {
                ensure!(
                    !path.symlink_metadata()?.file_type().is_symlink(),
                    "skill directory symlinks are unsupported"
                );
                pending.push(path);
            } else {
                ensure!(resolved.is_file(), "skill resources must be regular files");
                files.push((
                    path.strip_prefix(source)?.to_path_buf(),
                    storage::file_digest(&resolved)?,
                    resolved.metadata()?.permissions().mode() & 0o111,
                ));
            }
        }
    }
    files.sort();
    let digest = storage::digest(&serde_json::to_vec(&files)?);
    let target = directory.join("skills").join(digest);
    storage::private_dir(&target)?;
    for (relative, expected, executable) in files {
        let source = source.join(&relative);
        let destination = target.join(&relative);
        storage::private_dir(destination.parent().unwrap())?;
        if !destination.exists() {
            let bytes = std::fs::read(&source)?;
            ensure!(
                storage::digest(&bytes) == expected,
                "skill changed during transfer"
            );
            use std::io::Write;
            let mut file = storage::open_private(&destination, true)?;
            file.write_all(&bytes)?;
            file.set_permissions(std::fs::Permissions::from_mode(0o600 | executable))?;
            file.sync_all()?;
            std::fs::File::open(destination.parent().unwrap())?.sync_all()?;
        }
        ensure!(
            storage::file_digest(&destination)? == expected,
            "invalid stored skill resource"
        );
    }
    std::fs::File::open(&target)?.sync_all()?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn launch_preserves_configuration_home_separate_from_service_registry() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let home = root.join("services");
        let config_home = root.join("configuration");
        let workspace = root.join("workspace");
        let bin = root.join("bin");
        for path in [&config_home, &workspace, &bin] {
            std::fs::create_dir(path).unwrap();
        }
        for name in [
            "areal",
            "areal-runtime",
            "areal-runtime-fs",
            "areal-runtime-reaper",
        ] {
            std::fs::write(bin.join(name), "fixture").unwrap();
        }
        let registration = ProjectRegistration {
            project_id: "separate-homes".into(),
            workspace: workspace.clone(),
            data_dir: root.join("data"),
            source: ProjectSource::Cli,
            default_binding: false,
        };
        let inputs = LaunchInputs {
            workspace: workspace.clone(),
            cwd: workspace,
            config_home: config_home.clone(),
            homedir: None,
            config_path: None,
            deployment_path: None,
            environment: BTreeMap::new(),
            credential_names: vec![],
            options: LocalArgs::default(),
        };
        let (spec, saved) = prepare(&home, &bin, &registration, &inputs, &BTreeMap::new()).unwrap();
        let context = spec.context.unwrap();
        let config = areal_config::load_management_config(&areal_config::ConfigInputs {
            cwd: context.cwd,
            homedir: context.homedir,
            env: context.environment,
            config_file: spec.args.config,
            overrides: Default::default(),
        })
        .unwrap();
        assert_eq!(config.home, config_home);
        assert_eq!(spec.home, home);
        assert_eq!(saved.config_home, config_home);
    }
    #[test]
    fn configuration_environment_keeps_budget_keys_and_excludes_unregistered_secrets() {
        for name in [
            "AREAL_HARNESS_CONTEXT_TARGET_TOKENS",
            "AREAL_HARNESS_MAX_OUTPUT_TOKENS",
            "AREAL_HARNESS_SUMMARY_MAX_OUTPUT_TOKENS",
            "AREAL_MODEL_ENDPOINT",
            "SSL_CERT_FILE",
            "LANG",
        ] {
            assert!(allowed_environment(name), "{name}");
        }
        for name in [
            "AREAL_HARNESS_API_KEY",
            "AREAL_HARNESS_FIXTURE_PROJECT",
            "AREAL_SERVICE_OWNER",
            "AREAL_HARNESS_CONFIG",
            "CUSTOM_API_KEY",
        ] {
            assert!(!allowed_environment(name), "{name}");
        }
    }
    #[test]
    fn transferred_skill_retains_nested_resources_and_executable_after_source_removal() {
        let source = tempfile::tempdir().unwrap();
        let root = source.path().canonicalize().unwrap();
        std::fs::create_dir(root.join("scripts")).unwrap();
        std::fs::write(root.join("SKILL.md"), "skill").unwrap();
        std::fs::write(root.join("scripts/run.sh"), "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(
            root.join("scripts/run.sh"),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        let host = tempfile::tempdir().unwrap();
        let target = snapshot_skill(&root, host.path()).unwrap();
        assert_eq!(target, snapshot_skill(&root, host.path()).unwrap());
        drop(source);
        assert_eq!(
            std::fs::read_to_string(target.join("SKILL.md")).unwrap(),
            "skill"
        );
        assert_eq!(
            std::fs::metadata(target.join("scripts/run.sh"))
                .unwrap()
                .permissions()
                .mode()
                & 0o100,
            0o100
        );
        assert!(
            std::process::Command::new(target.join("scripts/run.sh"))
                .status()
                .unwrap()
                .success()
        );
    }
}
