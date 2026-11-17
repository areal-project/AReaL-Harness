//! 数据飞轮状态与控制：完全由 Host 管理配置、凭据注入、worker 进程与按项目采集重启。
use super::Host;
use anyhow::{Context, Result, ensure};
use areal_config::{ConfigErrorKind, ConfigInputs, TrajectoryConfig, load_management_config};
use areal_local_service::storage;
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    rc::Rc,
    time::Duration,
};

#[derive(Debug)]
struct Rejected(String);

impl std::fmt::Display for Rejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RESOURCE_UNAVAILABLE")
    }
}

impl std::error::Error for Rejected {}

fn rejected(message: impl Into<String>) -> anyhow::Error {
    Rejected(message.into()).into()
}

pub(super) fn rejection(error: &anyhow::Error) -> Option<Value> {
    error
        .downcast_ref::<Rejected>()
        .map(|failure| json!({"code": "RESOURCE_UNAVAILABLE", "message": failure.0}))
}

#[derive(Default)]
struct SourceApply {
    revision: Option<String>,
    pending_generations: BTreeMap<String, String>,
    error: Option<String>,
    abort: Option<tokio::task::AbortHandle>,
}

#[derive(Default)]
pub(super) struct Trajectory {
    writes: tokio::sync::Mutex<()>,
    apply: RefCell<BTreeMap<String, SourceApply>>,
}

impl Drop for Trajectory {
    fn drop(&mut self) {
        for entry in self.apply.borrow_mut().values_mut() {
            if let Some(handle) = entry.abort.take() {
                handle.abort();
            }
        }
    }
}

fn redact(text: &str, secrets: &[String]) -> String {
    let mut sanitized = text.to_owned();
    for secret in secrets {
        if !secret.is_empty() {
            sanitized = sanitized.replace(secret, "[redacted]");
        }
    }
    sanitized
}

fn management_inputs(
    host: &Host,
    source: &str,
) -> Result<(Value, ConfigInputs, BTreeMap<String, String>)> {
    let options = host.gateway.workbench.utility_options(source)?;
    let mut inputs = super::workbench_utility::inputs(&options)?;
    let env_creds = host.gateway.workbench.environment_credentials(source);
    for (name, value) in &env_creds {
        inputs.env.insert(name.into(), value.into());
    }
    Ok((options, inputs, env_creds))
}

fn write_private_bytes(path: &Path, content: &[u8]) -> Result<()> {
    let parent = path.parent().context("invalid CA bundle path")?;
    storage::private_dir(parent)?;
    let tmp = parent.join(format!(
        ".trajectory-ca-{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let write_res: Result<()> = (|| {
        use std::io::Write;
        let mut file = options.open(&tmp)?;
        file.write_all(content)?;
        file.sync_all()?;
        Ok(())
    })();
    if let Err(err) = write_res {
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }
    if let Err(err) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(err.into());
    }
    Ok(())
}

async fn worker_runtime(
    host: &Host,
    source: &str,
    options: &Value,
    inputs: &ConfigInputs,
    env_creds: &BTreeMap<String, String>,
    trajectory: &TrajectoryConfig,
) -> Result<(PathBuf, BTreeMap<OsString, OsString>, Vec<String>)> {
    let exe = options["binary"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| host.bin.join("areal"));
    let mut worker_env = inputs.env.clone();
    let mut secrets: Vec<String> = env_creds
        .values()
        .filter(|value| !value.is_empty())
        .cloned()
        .collect();
    if trajectory.enabled
        && trajectory.headers_file.is_none()
        && let Some(ref_name) = &trajectory.headers_env
        && !worker_env.contains_key(OsStr::new(ref_name))
    {
        let references = host.migration.vault.provider_references(source)?;
        if references.contains(ref_name) {
            let stored = host
                .migration
                .vault
                .dispatch_async(
                    "vault.read",
                    json!({
                        "slot": {
                            "kind": "providerCredential",
                            "sourceId": source,
                            "reference": ref_name,
                        },
                        "interactionAllowed": false,
                    }),
                    &host.identity.generation,
                    &host.migration,
                )
                .await
                .map_err(|_| rejected("数据飞轮凭据不可用，请先解锁凭据库后重试。"))?;
            let secret = stored["value"]
                .as_str()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| rejected("数据飞轮凭据不可用，请先解锁凭据库后重试。"))?;
            worker_env.insert(ref_name.into(), secret.into());
            secrets.push(secret.to_owned());
        }
    }
    let settings = super::library_store::read_source(host, source)?;
    let mut env_strings = BTreeMap::new();
    for (key, value) in std::env::vars_os() {
        if let (Some(key), Some(value)) = (key.to_str(), value.to_str()) {
            env_strings.insert(key.to_owned(), value.to_owned());
        }
    }
    for (key, value) in &worker_env {
        if let (Some(key), Some(value)) = (key.to_str(), value.to_str()) {
            env_strings.insert(key.to_owned(), value.to_owned());
        }
    }
    let net = crate::network::desktop(&settings["settings"], &env_strings)
        .await
        .map_err(|err| {
            rejected(redact(
                &format!("网络代理或证书配置不可用：{err}"),
                &secrets,
            ))
        })?;
    for (key, value) in net.proxies {
        worker_env.insert(key.into(), value.into());
    }
    if !net.extra_ca_pem.is_empty() {
        let ca_path = host.home.join("host/trajectory-ca.pem");
        write_private_bytes(&ca_path, net.extra_ca_pem.join("\n").as_bytes())?;
        worker_env.insert("SSL_CERT_FILE".into(), ca_path.into_os_string());
    }
    Ok((exe, worker_env, secrets))
}

fn slot_matches_source(
    host: &Host,
    source: &str,
    registration: &crate::ProjectRegistration,
) -> bool {
    let crate::ProjectSource::Gui { profile, .. } = &registration.source else {
        return false;
    };
    host.migration
        .navigation_source_id(profile)
        .ok()
        .flatten()
        .as_deref()
        == Some(source)
}

fn prune_pending(host: &Host, pending: &mut BTreeMap<String, String>) {
    let slots = host.slots.borrow();
    pending.retain(|project_id, old_gen| {
        let Some(slot) = slots.get(project_id) else {
            return false;
        };
        if slot.state == "stopped" {
            return false;
        }
        match &slot.service {
            Some(service) => old_gen.is_empty() || service.identity.generation == *old_gen,
            None => old_gen.is_empty(),
        }
    });
}

impl Trajectory {
    fn project_status(
        &self,
        host: &Host,
        source: &str,
        config: &areal_config::ResolvedCoreConfig,
        mut status: Value,
    ) -> Result<Value> {
        let config_path = config
            .config_file
            .clone()
            .unwrap_or_else(|| config.home.join("config.toml"));
        status["configPath"] = json!(config_path.display().to_string());
        status["config_revision"] = json!(config.trajectory.source_revision);

        let mut apply_map = self.apply.borrow_mut();
        if let Some(entry) = apply_map.get_mut(source) {
            prune_pending(host, &mut entry.pending_generations);
            let same_revision =
                entry.revision.as_deref() == Some(config.trajectory.source_revision.as_str());
            if same_revision && !entry.pending_generations.is_empty() {
                status["capture_apply_pending"] = json!(true);
                status["capture_apply_error"] = Value::Null;
            } else if let Some(error) = &entry.error {
                status["capture_apply_pending"] = json!(false);
                status["capture_apply_error"] = json!(error);
            }
        }
        serde_json::from_value::<areal_protocol::host::WorkbenchTrajectoryStatus>(status.clone())?;
        Ok(status)
    }

    pub(super) fn read(&self, host: &Rc<Host>, source: &str, params: Value) -> Result<Value> {
        serde_json::from_value::<areal_protocol::host::WorkbenchTrajectoryReadParams>(params)
            .context("INVALID_PARAMS")?;
        let (_, inputs, env_creds) = management_inputs(host, source)?;
        let secrets: Vec<String> = env_creds
            .values()
            .filter(|value| !value.is_empty())
            .cloned()
            .collect();
        let config = load_management_config(&inputs).map_err(|err| {
            crate::wire::error(
                "RESOURCE_UNAVAILABLE",
                redact(&format!("数据飞轮状态读取失败：{err}"), &secrets),
            )
        })?;
        let status = areal_trajectory::status(&config.trajectory).map_err(|err| {
            crate::wire::error(
                "RESOURCE_UNAVAILABLE",
                redact(&format!("数据飞轮状态读取失败：{err}"), &secrets),
            )
        })?;
        self.project_status(host, source, &config, status)
    }

    pub(super) async fn command(
        self: &Rc<Self>,
        host: &Rc<Host>,
        source: &str,
        params: Value,
    ) -> Result<Value> {
        let parsed =
            serde_json::from_value::<areal_protocol::host::WorkbenchTrajectoryCommandParams>(
                params,
            )
            .context("INVALID_PARAMS")?;
        let _guard = self.writes.lock().await;
        let (options, inputs, env_creds) = management_inputs(host, source)?;
        let initial_secrets: Vec<String> = env_creds
            .values()
            .filter(|value| !value.is_empty())
            .cloned()
            .collect();

        match parsed {
            areal_protocol::host::WorkbenchTrajectoryCommandParams::Variant1(_) => {
                let config = load_management_config(&inputs).map_err(|err| {
                    rejected(redact(
                        &format!("数据飞轮重试失败：{err}"),
                        &initial_secrets,
                    ))
                })?;
                let (exe, worker_env, secrets) = worker_runtime(
                    host,
                    source,
                    &options,
                    &inputs,
                    &env_creds,
                    &config.trajectory,
                )
                .await?;
                let status = areal_trajectory::retry_failed_with_runtime(
                    &config.trajectory,
                    (&exe, &worker_env),
                )
                .map_err(|err| rejected(redact(&format!("数据飞轮重试失败：{err}"), &secrets)))?;
                self.project_status(host, source, &config, status)
            }
            areal_protocol::host::WorkbenchTrajectoryCommandParams::Variant2(toggle) => {
                let before = load_management_config(&inputs).map_err(|err| match err.kind {
                    ConfigErrorKind::Conflict => anyhow::anyhow!("TARGET_CHANGED"),
                    _ => rejected(redact(
                        &format!("数据飞轮启停失败：{err}"),
                        &initial_secrets,
                    )),
                })?;
                ensure!(
                    toggle.expected_revision == before.trajectory.source_revision,
                    "TARGET_CHANGED"
                );
                let mut runtime_bundle = None;
                if toggle.enabled {
                    let mut preview = before.trajectory.clone();
                    preview.enabled = true;
                    runtime_bundle = Some(
                        worker_runtime(host, source, &options, &inputs, &env_creds, &preview)
                            .await?,
                    );
                }
                let config = areal_config::set_trajectory_enabled(
                    &inputs,
                    toggle.enabled,
                    Some(&toggle.expected_revision),
                )
                .map_err(|err| match err.kind {
                    ConfigErrorKind::Conflict => anyhow::anyhow!("TARGET_CHANGED"),
                    _ => rejected(redact(
                        &format!("数据飞轮启停失败：{err}"),
                        &initial_secrets,
                    )),
                })?;

                let status = if config.trajectory.enabled {
                    let (exe, worker_env, secrets) = match runtime_bundle {
                        Some(bundle) => bundle,
                        None => {
                            worker_runtime(
                                host,
                                source,
                                &options,
                                &inputs,
                                &env_creds,
                                &config.trajectory,
                            )
                            .await?
                        }
                    };
                    let outcome = (|| -> Result<Value> {
                        areal_trajectory::configure_with_runtime(
                            &config.trajectory,
                            (&exe, &worker_env),
                        )?;
                        if !before.trajectory.enabled {
                            areal_trajectory::resume_retained_with_runtime(
                                &config.trajectory,
                                (&exe, &worker_env),
                            )
                        } else {
                            areal_trajectory::status(&config.trajectory)
                        }
                    })();
                    outcome.map_err(|err| {
                        rejected(redact(&format!("数据飞轮启停失败：{err}"), &secrets))
                    })?
                } else {
                    areal_trajectory::configure(&config.trajectory)
                        .and_then(|()| areal_trajectory::status(&config.trajectory))
                        .map_err(|err| {
                            rejected(redact(
                                &format!("数据飞轮启停失败：{err}"),
                                &initial_secrets,
                            ))
                        })?
                };

                self.apply_change(host, source, &config.trajectory.source_revision)
                    .await;
                self.project_status(host, source, &config, status)
            }
        }
    }

    async fn apply_change(self: &Rc<Self>, host: &Rc<Host>, source: &str, revision: &str) {
        let pending_generations: BTreeMap<String, String> = host
            .slots
            .borrow()
            .iter()
            .filter_map(|(id, slot)| {
                if slot.state == "stopped" || !slot_matches_source(host, source, &slot.registration)
                {
                    return None;
                }
                let generation = slot
                    .service
                    .as_ref()
                    .map(|service| service.identity.generation.clone())
                    .unwrap_or_default();
                Some((id.clone(), generation))
            })
            .collect();

        {
            let mut map = self.apply.borrow_mut();
            let entry = map.entry(source.to_owned()).or_default();
            if let Some(handle) = entry.abort.take() {
                handle.abort();
            }
            entry.revision = Some(revision.to_owned());
            entry.pending_generations = pending_generations;
            entry.error = None;
        }

        if self.try_apply_once(host, source, revision).await {
            let this = Rc::clone(self);
            let host_ref = Rc::clone(host);
            let source_id = source.to_owned();
            let rev = revision.to_owned();
            let mut changes = host.changes.subscribe();
            let task = tokio::task::spawn_local(async move {
                loop {
                    tokio::select! {
                        _ = changes.changed() => {}
                        _ = tokio::time::sleep(Duration::from_millis(500)) => {}
                    }
                    if !this.try_apply_once(&host_ref, &source_id, &rev).await {
                        break;
                    }
                }
            });
            let abort = task.abort_handle();
            if let Some(entry) = self.apply.borrow_mut().get_mut(source)
                && entry.revision.as_deref() == Some(revision)
                && !entry.pending_generations.is_empty()
            {
                entry.abort = Some(abort);
            } else {
                abort.abort();
            }
        }
        host.changed();
    }

    async fn try_apply_once(&self, host: &Rc<Host>, source: &str, revision: &str) -> bool {
        let targets: Vec<(String, String)> = {
            let mut map = self.apply.borrow_mut();
            let Some(entry) = map.get_mut(source) else {
                return false;
            };
            if entry.revision.as_deref() != Some(revision) {
                return false;
            }
            prune_pending(host, &mut entry.pending_generations);
            if entry.pending_generations.is_empty() {
                entry.revision = None;
                entry.abort = None;
                return false;
            }
            entry
                .pending_generations
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        };

        let still_matches = management_inputs(host, source)
            .and_then(|(_, inputs, _)| Ok(load_management_config(&inputs)?))
            .is_ok_and(|config| config.trajectory.source_revision == revision);
        if !still_matches {
            let mut map = self.apply.borrow_mut();
            if let Some(entry) = map.get_mut(source)
                && entry.revision.as_deref() == Some(revision)
            {
                entry.revision = None;
                entry.pending_generations.clear();
                entry.error = Some("配置已有其它变化，请在后台服务中安全应用当前配置。".into());
                entry.abort = None;
            }
            host.changed();
            return false;
        }

        for (project_id, recorded_gen) in targets {
            let (state, service) = {
                let slots = host.slots.borrow();
                match slots.get(&project_id) {
                    Some(slot) => (slot.state.clone(), slot.service.clone()),
                    None => continue,
                }
            };
            if state == "stopped" {
                continue;
            }
            let Some(service) = service else {
                continue;
            };
            if !recorded_gen.is_empty() && service.identity.generation != recorded_gen {
                continue;
            }
            if state != "ready" {
                continue;
            }
            let Ok(srv_status) =
                areal_local_service::rpc(&service, "areal/server/status", json!({})).await
            else {
                continue;
            };
            if srv_status["restartSafe"] != true {
                continue;
            }
            if self
                .apply
                .borrow()
                .get(source)
                .is_none_or(|entry| entry.revision.as_deref() != Some(revision))
            {
                return false;
            }
            let stop_result = host
                .stop_project(super::Stop {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    expected_generation: host.identity.generation.clone(),
                    strategy: crate::StopStrategy::IfIdle,
                    suppress_scheduling: false,
                    project_id: Some(project_id.clone()),
                    service_generation: Some(service.identity.generation.clone()),
                })
                .await;
            let Ok(stopped) = stop_result else {
                continue;
            };
            if stopped["state"] != "completed" {
                continue;
            }
            if let Err(err) = host
                .ensure(super::Ensure {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    expected_generation: host.identity.generation.clone(),
                    project_id: project_id.clone(),
                    no_auto_restart: false,
                    resume_scheduling: false,
                    launch_inputs: None,
                    credentials: BTreeMap::new(),
                })
                .await
            {
                let mut map = self.apply.borrow_mut();
                if let Some(entry) = map.get_mut(source)
                    && entry.revision.as_deref() == Some(revision)
                {
                    entry.revision = None;
                    entry.pending_generations.clear();
                    entry.error = Some(err.to_string());
                    entry.abort = None;
                }
                host.changed();
                return false;
            }
            if let Some(entry) = self.apply.borrow_mut().get_mut(source)
                && entry.revision.as_deref() == Some(revision)
            {
                entry.pending_generations.remove(&project_id);
            }
        }

        let mut map = self.apply.borrow_mut();
        let Some(entry) = map.get_mut(source) else {
            return false;
        };
        if entry.revision.as_deref() != Some(revision) {
            return false;
        }
        prune_pending(host, &mut entry.pending_generations);
        let remaining = !entry.pending_generations.is_empty();
        if !remaining {
            entry.revision = None;
            entry.abort = None;
        }
        host.changed();
        remaining
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn host_with_source(base: &Path, config_body: &str) -> (Rc<Host>, String, PathBuf) {
        let mut host = crate::server::schedules::tests::fixture(base);
        let mut migration = crate::migration::Migration::new(&host.home).unwrap();
        migration.vault = crate::vault::Vault::isolated_files(&host.home);
        let core = base.join("core");
        let profile = base.join("profile");
        storage::private_dir(&core).unwrap();
        storage::private_dir(&profile).unwrap();
        storage::write(&core.join("projects.json"), &json!([])).unwrap();
        let source_desc = crate::migration::Source {
            profile: profile.clone(),
            core_home: core.clone(),
            // 过渡：到 0.2.0 删；导入夹具沿用迁移来源字段。
            legacy_service_home: base.join("legacy"),
        };
        migration
            .attach(source_desc.clone(), "fixture", None)
            .unwrap();
        let imported = migration
            .import(
                serde_json::from_value(json!({
                    "requestId": uuid::Uuid::new_v4().to_string(),
                    "expectedGeneration": host.identity.generation,
                    "source": source_desc,
                }))
                .unwrap(),
                "fixture",
                &[],
                &host.journal,
            )
            .unwrap();
        let source_id = imported["receipt"]["sourceId"].as_str().unwrap().to_owned();
        let config_path = core.join("config.toml");
        std::fs::write(&config_path, config_body).unwrap();
        host.migration = Rc::new(migration);
        let host = Rc::new(host);
        host.gateway.workbench.set_test_source_and_options(
            &source_id,
            json!({
                "home": core,
                "config": config_path,
                "cwd": base,
                "homedir": base,
                "profile": profile,
            }),
        );
        (host, source_id, config_path)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn read_only_status_does_not_unlock_vault_and_returns_revision() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let spool = base.join("spool");
        let body = format!(
            "schema_version = 2\n[trajectory]\nenabled = false\nendpoint = 'https://collector.example.test/ingest'\nheaders_env = 'AREAL_CREDENTIAL_TRAJECTORY'\nspool_dir = '{}'\n",
            spool.display()
        );
        let (host, source, config_path) = host_with_source(&base, &body).await;
        host.migration
            .vault
            .dispatch(
                "vault.replace",
                json!({
                    "requestId": uuid::Uuid::new_v4().to_string(),
                    "expectedGeneration": host.identity.generation,
                    "slot": {
                        "kind": "providerCredential",
                        "sourceId": source,
                        "reference": "AREAL_CREDENTIAL_TRAJECTORY",
                    },
                    "expectedRevision": 0,
                    "value": "secret-trajectory-token",
                }),
                &host.identity.generation,
                &host.migration,
            )
            .unwrap();
        let traj = Rc::new(Trajectory::default());
        let status = traj
            .read(
                &host,
                &source,
                json!({"sourceId": source, "operation": "status"}),
            )
            .unwrap();
        assert_eq!(status["enabled"], false);
        assert_eq!(
            status["configPath"],
            json!(config_path.display().to_string())
        );
        assert_eq!(status["config_revision"].as_str().unwrap().len(), 64);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn set_enabled_rejects_stale_revision_with_target_changed() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let spool = base.join("spool");
        let body = format!(
            "schema_version = 2\n[trajectory]\nenabled = false\nendpoint = 'https://collector.example.test/ingest'\nspool_dir = '{}'\n",
            spool.display()
        );
        let (host, source, _) = host_with_source(&base, &body).await;
        let traj = Rc::new(Trajectory::default());
        let err = traj
            .command(
                &host,
                &source,
                json!({
                    "sourceId": source,
                    "operation": "setEnabled",
                    "enabled": true,
                    "expectedRevision": "0".repeat(64),
                }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "TARGET_CHANGED");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn failure_messages_redact_trajectory_secrets() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let base = root.path().canonicalize().unwrap();
                let spool = base.join("spool");
                let body = format!(
                    "schema_version = 2\n[trajectory]\nenabled = false\nendpoint = 'http://127.0.0.1:1/ingest'\nheaders_env = 'AREAL_CREDENTIAL_TRAJECTORY'\nspool_dir = '{}'\n",
                    spool.display()
                );
                let (host, source, config_path) = host_with_source(&base, &body).await;
                let fake_binary = base.join("fake-areal.sh");
                std::fs::write(&fake_binary, "#!/bin/sh\nexit 1\n").unwrap();
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&fake_binary, std::fs::Permissions::from_mode(0o700))
                        .unwrap();
                }
                host.gateway.workbench.set_test_source_and_options(
                    &source,
                    json!({
                        "home": base.join("core"),
                        "config": config_path,
                        "cwd": base,
                        "homedir": base,
                        "profile": base.join("profile"),
                        "binary": fake_binary,
                    }),
                );
                let secret = "trajectory-secret-value";
                let mut creds = BTreeMap::new();
                creds.insert("AREAL_CREDENTIAL_TRAJECTORY".to_owned(), secret.to_owned());
                host.gateway
                    .workbench
                    .set_test_environment_credentials(&source, creds);
                assert_eq!(
                    redact(&format!("failed with {secret}"), &[secret.to_owned()]),
                    "failed with [redacted]"
                );
                let traj = Rc::new(Trajectory::default());
                let before = traj
                    .read(
                        &host,
                        &source,
                        json!({"sourceId": source, "operation": "status"}),
                    )
                    .unwrap();
                let err = traj
                    .command(
                        &host,
                        &source,
                        json!({
                            "sourceId": source,
                            "operation": "setEnabled",
                            "enabled": true,
                            "expectedRevision": before["config_revision"],
                        }),
                    )
                    .await
                    .unwrap_err();
                let rejection_val = rejection(&err).unwrap();
                assert_eq!(rejection_val["code"], "RESOURCE_UNAVAILABLE");
                assert!(!rejection_val["message"].as_str().unwrap().contains(secret));
                let retry_err = traj
                    .command(
                        &host,
                        &source,
                        json!({"sourceId": source, "operation": "retry"}),
                    )
                    .await
                    .unwrap_err();
                assert_eq!(
                    rejection(&retry_err).unwrap()["code"],
                    "RESOURCE_UNAVAILABLE"
                );
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn host_routes_trajectory_library_and_chatgpt_without_node_backend() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let base = root.path().canonicalize().unwrap();
                let spool = base.join("spool");
                let body = format!(
                    "schema_version = 2\n[trajectory]\nenabled = false\nendpoint = 'https://collector.example.test/ingest'\nspool_dir = '{}'\n",
                    spool.display()
                );
                let (host, source, config_path) = host_with_source(&base, &body).await;
                assert!(!host.gateway.workbench.has_running_backend());

                let traj_status = crate::server::workbench_route::backend_read(
                    &host,
                    "local",
                    &json!({"method": "trajectory.read", "params": {"sourceId": source, "operation": "status"}}),
                )
                .await
                .unwrap();
                assert_eq!(traj_status["enabled"], false);
                assert_eq!(
                    traj_status["configPath"],
                    json!(config_path.display().to_string())
                );

                let snap_receipt = crate::server::workbench_route::backend_command(
                    &host,
                    "local",
                    &json!({
                        "method": "library.command",
                        "commandId": uuid::Uuid::new_v4().to_string(),
                        "params": {
                            "sourceId": source,
                            "operation": "settings",
                            "key": "snapShot",
                            "value": {
                                "snapShotEnabled": true,
                                "snapShotIncludeAccessibility": false,
                                "snapShotShortcut": {
                                    "key": "S",
                                    "metaKey": false,
                                    "ctrlKey": false,
                                    "shiftKey": true,
                                    "altKey": false,
                                    "modKey": true,
                                },
                                "snapShotPlaySound": true,
                                "snapShotSound": "soft-pop",
                                "snapShotFlash": true,
                                "snapShotAnimations": true,
                            }
                        }
                    }),
                )
                .await
                .unwrap();
                assert_eq!(snap_receipt["admissionState"], "accepted");

                let font_receipt = crate::server::workbench_route::backend_command(
                    &host,
                    "local",
                    &json!({
                        "method": "library.command",
                        "commandId": uuid::Uuid::new_v4().to_string(),
                        "params": {
                            "sourceId": source,
                            "operation": "settings",
                            "key": "terminalFontFamily",
                            "value": "JetBrains Mono",
                        }
                    }),
                )
                .await
                .unwrap();
                assert_eq!(font_receipt["admissionState"], "accepted");
                assert!(
                    font_receipt["receipt"]["settings"]
                        .get("terminalFontFamily")
                        .is_none()
                );
                let stored_library =
                    crate::server::library_store::read_source(&host, &source).unwrap();
                assert_eq!(
                    stored_library["settings"]["terminalFontFamily"],
                    json!("JetBrains Mono")
                );

                let chatgpt = crate::server::workbench_route::desktop_command(
                    &host,
                    "local",
                    "conn-1",
                    &json!({
                        "params": {
                            "sourceId": source,
                            "command": "chatgpt",
                            "request": { "operation": "status", "provider": "openai" },
                        }
                    }),
                )
                .await
                .unwrap();
                assert_eq!(chatgpt["state"], "signed_out");
                assert!(!host.gateway.workbench.has_running_backend());
            })
            .await;
    }
}
