use anyhow::{Context, Result, ensure};
use areal_local_service::storage;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceInstallation {
    pub label: String,
    pub descriptor: PathBuf,
    pub executable: PathBuf,
    pub home: PathBuf,
    descriptor_digest: String,
}
impl ServiceInstallation {
    pub fn status(home: &Path) -> Result<serde_json::Value> {
        let Some(installation) =
            storage::read_optional::<Self>(&home.join("host/service-install.json"))?
        else {
            return Ok(serde_json::json!({"installed":false}));
        };
        ensure!(
            installation.home == storage::canonical_pending(home)?,
            "service home mismatch"
        );
        installation.verify_descriptor()?;
        Ok(serde_json::json!({"installed":true,"label":installation.label}))
    }
    pub fn current() -> Result<Self> {
        let home = areal_local_service::home().context("resolve Host home for service manager")?;
        let user_home = std::env::home_dir().context("user home unavailable")?;
        let root = if cfg!(target_os = "macos") {
            user_home.join("Library/LaunchAgents")
        } else {
            std::env::var_os("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| user_home.join(".config"))
                .join("systemd/user")
        };
        let executable = std::env::current_exe().context("resolve service executable")?;
        Self::at(home, &root, &executable)
    }
    pub fn at(home: PathBuf, service_directory: &Path, executable: &Path) -> Result<Self> {
        let home = storage::canonical_pending(&home)
            .with_context(|| format!("resolve Host home {}", home.display()))?;
        let real = executable
            .canonicalize()
            .with_context(|| format!("resolve service executable {}", executable.display()))?;
        let keg = real.parent().and_then(Path::parent);
        let brew_entry = keg.and_then(|keg| {
            let formula = keg.parent()?;
            let cellar = formula.parent()?;
            if cellar.file_name()? != "Cellar" {
                return None;
            }
            let name = formula.file_name()?;
            if name != "areal" && name != "areal-beta" {
                return None;
            }
            let entry = cellar.parent()?.join("opt").join(name).join("bin/areal");
            entry
                .canonicalize()
                .is_ok_and(|path| path == real)
                .then_some(entry)
        });
        let stable = brew_entry.unwrap_or_else(|| {
            real.ancestors()
                .skip(1)
                .map(|p| p.join("bin/areal"))
                .find(|path| path.is_symlink() && path.canonicalize().is_ok_and(|p| p == real))
                .unwrap_or_else(|| real.clone())
        });
        let label = format!(
            "org.areal.host.{}",
            &storage::digest(home.as_os_str().as_encoded_bytes())[..16]
        );
        let descriptor = storage::canonical_pending(service_directory)
            .with_context(|| format!("resolve service directory {}", service_directory.display()))?
            .join(format!(
                "{label}.{}",
                if cfg!(target_os = "macos") {
                    "plist"
                } else {
                    "service"
                }
            ));
        let mut installation = Self {
            label,
            descriptor,
            executable: stable,
            home,
            descriptor_digest: String::new(),
        };
        installation.descriptor_digest = storage::digest(installation.contents()?.as_bytes());
        Ok(installation)
    }
    pub fn contents(&self) -> Result<String> {
        let exe = self
            .executable
            .to_str()
            .context("non-UTF-8 service executable")?;
        let home = self.home.to_str().context("non-UTF-8 service home")?;
        ensure!(
            !exe.contains(['\n', '\r', '\0']) && !home.contains(['\n', '\r', '\0']),
            "invalid service path"
        );
        let log = self.home.join("host-service.log");
        if cfg!(target_os = "macos") {
            let xml = |s: &str| {
                s.replace('&', "&amp;")
                    .replace('<', "&lt;")
                    .replace('>', "&gt;")
                    .replace('"', "&quot;")
                    .replace('\'', "&apos;")
            };
            return Ok(format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n<key>Label</key><string>{}</string>\n<key>ProgramArguments</key><array><string>{}</string><string>host</string><string>run</string><string>--managed</string></array>\n<key>EnvironmentVariables</key><dict><key>AREAL_HARNESS_HOME</key><string>{}</string><key>AREAL_HARNESS_SERVICE_HOME</key><string>{}</string><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>1</integer>\n<key>StandardOutPath</key><string>{}</string><key>StandardErrorPath</key><string>{}</string>\n</dict></plist>\n",
                xml(&self.label),
                xml(exe),
                xml(home),
                xml(home),
                xml(&log.to_string_lossy()),
                xml(&log.to_string_lossy())
            ));
        }
        let quote = |s: &str| {
            format!(
                "\"{}\"",
                s.replace('\\', "\\\\")
                    .replace('"', "\\\"")
                    .replace('%', "%%")
                    .replace('$', "$$")
            )
        };
        Ok(format!(
            "[Unit]\nDescription=AReaL shared Host\nStartLimitIntervalSec=0\n\n[Service]\nType=simple\nExecStart={} host run --managed\nEnvironment={}\nEnvironment={}\nEnvironment=PATH=/usr/bin:/bin:/usr/sbin:/sbin\nRestart=on-failure\nRestartSec=1\nRestartPreventExitStatus=73\n\n[Install]\nWantedBy=default.target\n",
            quote(exe),
            quote(&format!("AREAL_HARNESS_HOME={home}")).replace("$$", "$"),
            quote(&format!("AREAL_HARNESS_SERVICE_HOME={home}")).replace("$$", "$")
        ))
    }
    pub fn install(&self) -> Result<()> {
        storage::private_dir(&self.home)
            .with_context(|| format!("check Host home {}", self.home.display()))?;
        let host_dir = self.home.join("host");
        storage::private_dir(&host_dir)
            .with_context(|| format!("check Host directory {}", host_dir.display()))?;
        let lock_path = self.home.join("host.lock");
        let lock = storage::open_private(&lock_path, true)
            .with_context(|| format!("open Host lock {}", lock_path.display()))?;
        lock.try_lock_exclusive()
            .context("Host is running; explicitly stop it before installing a system service")?;
        let directory = self
            .descriptor
            .parent()
            .context("missing service directory")?;
        std::fs::create_dir_all(directory)
            .with_context(|| format!("create service directory {}", directory.display()))?;
        let meta = std::fs::symlink_metadata(directory)
            .with_context(|| format!("inspect service directory {}", directory.display()))?;
        ensure!(
            meta.is_dir() && meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o022 == 0,
            "service directory must be owned by this user and not writable by others"
        );
        let record_path = host_dir.join("service-install.json");
        let existing: Option<Self> = storage::read_optional(&record_path).with_context(|| {
            format!("read service installation record {}", record_path.display())
        })?;
        if std::fs::symlink_metadata(&self.descriptor).is_ok() {
            let previous = existing
                .as_ref()
                .context("unowned service descriptor exists")?;
            previous.verify_descriptor()?;
            ensure!(
                previous.descriptor == self.descriptor
                    && previous.label == self.label
                    && previous.home == self.home,
                "service installation identity changed"
            );
        }
        if let Some(previous) = &existing {
            ensure!(
                previous.descriptor_digest == self.descriptor_digest,
                "stop and uninstall the existing service before changing its launch settings"
            );
        }
        let domain = format!("gui/{}", unsafe { libc::geteuid() });
        let loaded = cfg!(target_os = "macos")
            && Command::new("/bin/launchctl")
                .args(["print", &format!("{domain}/{}", self.label)])
                .output()
                .with_context(|| format!("run launchctl print for {domain}/{}", self.label))?
                .status
                .success();
        ensure!(
            !loaded || existing.is_some(),
            "an unowned service is already registered under this label"
        );
        let temporary = directory.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
        let mut file = storage::open_private(&temporary, true).with_context(|| {
            format!("open temporary service descriptor {}", temporary.display())
        })?;
        file.write_all(self.contents()?.as_bytes())
            .with_context(|| {
                format!("write temporary service descriptor {}", temporary.display())
            })?;
        file.sync_all().with_context(|| {
            format!("sync temporary service descriptor {}", temporary.display())
        })?;
        std::fs::rename(&temporary, &self.descriptor).with_context(|| {
            format!(
                "publish service descriptor {} to {}",
                temporary.display(),
                self.descriptor.display()
            )
        })?;
        storage::write(&record_path, self).with_context(|| {
            format!(
                "write service installation record {}",
                record_path.display()
            )
        })?;
        drop(lock);
        if cfg!(target_os = "macos") {
            if !loaded {
                checked(
                    Command::new("/bin/launchctl")
                        .args(["bootstrap", &domain])
                        .arg(&self.descriptor),
                )?;
            }
        } else {
            checked(Command::new("/usr/bin/systemctl").args(["--user", "daemon-reload"]))?;
            checked(
                Command::new("/usr/bin/systemctl")
                    .args(["--user", "enable", "--now"])
                    .arg(&self.descriptor),
            )?;
        }
        Ok(())
    }
    pub async fn start_installed(home: &Path) -> Result<bool> {
        let Some(installation) =
            storage::read_optional::<Self>(&home.join("host/service-install.json"))?
        else {
            return Ok(false);
        };
        ensure!(
            installation.home == storage::canonical_pending(home)?,
            "service home mismatch"
        );
        installation.verify_descriptor()?;
        if let Ok(client) = crate::Client::connect_at(home.to_owned()).await {
            ensure!(
                crate::service_run::ServiceRun::is_managed_process(home, client.identity().pid)?,
                "running Host is not managed; explicitly stop it before starting the installed service"
            );
            return Ok(true);
        }
        let lock = storage::open_private(&home.join("host.lock"), true)?;
        lock.try_lock_exclusive().context(
            "Host startup is unresolved; check its original identity before starting the service",
        )?;
        crate::service_run::ServiceRun::acknowledge_start(home)?;
        drop(lock);
        if cfg!(target_os = "macos") {
            let domain = format!("gui/{}", unsafe { libc::geteuid() });
            let target = format!("{domain}/{}", installation.label);
            if !Command::new("/bin/launchctl")
                .args(["print", &target])
                .output()?
                .status
                .success()
            {
                checked(
                    Command::new("/bin/launchctl")
                        .args(["bootstrap", &domain])
                        .arg(&installation.descriptor),
                )?;
            }
            checked(Command::new("/bin/launchctl").args(["kickstart", &target]))?;
        } else {
            checked(
                Command::new("/usr/bin/systemctl")
                    .args(["--user", "start"])
                    .arg(
                        installation
                            .descriptor
                            .file_name()
                            .context("missing unit name")?,
                    ),
            )?;
        }
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            if let Ok(client) = crate::Client::connect_at(home.to_owned()).await {
                ensure!(
                    crate::service_run::ServiceRun::is_managed_process(
                        home,
                        client.identity().pid
                    )?,
                    "service start reached an unmanaged Host; registration retained for inspection"
                );
                return Ok(true);
            }
            ensure!(
                tokio::time::Instant::now() < deadline,
                "installed service startup remains unavailable; check its saved state and service manager"
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }
    fn verify_descriptor(&self) -> Result<()> {
        let meta = std::fs::symlink_metadata(&self.descriptor)?;
        ensure!(
            meta.is_file() && meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o077 == 0,
            "invalid owned service descriptor"
        );
        ensure!(
            storage::digest(&std::fs::read(&self.descriptor)?) == self.descriptor_digest,
            "service descriptor changed since installation"
        );
        Ok(())
    }
    pub async fn uninstall(home: &Path) -> Result<Option<Self>> {
        Self::uninstall_mode(home, false).await
    }
    pub async fn uninstall_stopped(home: &Path) -> Result<Option<Self>> {
        Self::uninstall_mode(home, true).await
    }
    async fn uninstall_mode(home: &Path, stopped_only: bool) -> Result<Option<Self>> {
        let path = home.join("host/service-install.json");
        let Some(installation) = storage::read_optional::<Self>(&path)? else {
            return Ok(None);
        };
        ensure!(
            installation.home == storage::canonical_pending(home)?,
            "service home mismatch"
        );
        installation.verify_descriptor()?;
        if let Ok(client) = crate::Client::connect_at(home.to_owned()).await {
            ensure!(
                !stopped_only,
                "Host is running again; service removal requires the original confirmed stop and never submits a new stop"
            );
            let request = uuid::Uuid::new_v4().to_string();
            let receipt = client
                .stop(
                    &request,
                    &client.identity().generation,
                    crate::StopStrategy::IfIdle,
                )
                .await
                .with_context(|| {
                    format!("service removal stop {request} needs its original operation lookup")
                })?;
            ensure!(
                receipt["state"] == "completed",
                "service removal stopped at original operation {request}: {}",
                receipt["state"]
            );
        }
        let lock = storage::open_private(&home.join("host.lock"), true)?;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            match lock.try_lock_exclusive() {
                Ok(()) => break,
                Err(e)
                    if e.kind() == std::io::ErrorKind::WouldBlock
                        && tokio::time::Instant::now() < deadline =>
                {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await
                }
                Err(e) => {
                    return Err(e)
                        .context("Host has not finished stopping; service registration retained");
                }
            }
        }
        if cfg!(target_os = "macos") {
            let domain = format!("gui/{}", unsafe { libc::geteuid() });
            if Command::new("/bin/launchctl")
                .args(["print", &format!("{domain}/{}", installation.label)])
                .output()?
                .status
                .success()
            {
                checked(
                    Command::new("/bin/launchctl")
                        .args(["bootout", &domain])
                        .arg(&installation.descriptor),
                )?;
            }
        } else {
            checked(
                Command::new("/usr/bin/systemctl")
                    .args(["--user", "disable", "--now"])
                    .arg(
                        installation
                            .descriptor
                            .file_name()
                            .context("missing unit name")?,
                    ),
            )?;
        }
        std::fs::remove_file(&installation.descriptor)?;
        if cfg!(target_os = "linux") {
            checked(Command::new("/usr/bin/systemctl").args(["--user", "daemon-reload"]))?;
        }
        std::fs::remove_file(path)?;
        Ok(Some(installation))
    }
}
fn checked(command: &mut Command) -> Result<()> {
    let output = command.output()?;
    ensure!(
        output.status.success(),
        "service manager failed ({}): {}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn installed_stable_entry_survives_a_version_symlink_switch() {
        let root = tempfile::tempdir().unwrap();
        let prefix = root
            .path()
            .canonicalize()
            .unwrap()
            .join("prefix & installer");
        let version_one = prefix.join("lib/areal/first/bin");
        let version_two = prefix.join("lib/areal/second/bin");
        std::fs::create_dir_all(&version_one).unwrap();
        std::fs::create_dir_all(&version_two).unwrap();
        std::fs::create_dir_all(prefix.join("bin")).unwrap();
        std::fs::write(version_one.join("areal"), "first").unwrap();
        std::fs::write(version_two.join("areal"), "second").unwrap();
        let stable = prefix.join("bin/areal");
        symlink(version_one.join("areal"), &stable).unwrap();
        let service = ServiceInstallation::at(
            root.path().join("home"),
            &root.path().join("agents"),
            &version_one.join("areal"),
        )
        .unwrap();
        assert_eq!(service.executable, stable);
        let descriptor = service.contents().unwrap();
        std::fs::remove_file(&stable).unwrap();
        symlink(version_two.join("areal"), &stable).unwrap();
        assert_eq!(
            std::fs::read_to_string(&service.executable).unwrap(),
            "second"
        );
        assert_eq!(service.contents().unwrap(), descriptor);
        if cfg!(target_os = "macos") {
            let path = root.path().join("service.plist");
            std::fs::write(&path, descriptor).unwrap();
            assert!(
                Command::new("/usr/bin/plutil")
                    .arg("-lint")
                    .arg(&path)
                    .output()
                    .unwrap()
                    .status
                    .success()
            );
        }
        assert!(!root.path().join("agents").exists());
        assert!(!root.path().join("home").exists());
    }
    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "requires explicit approval for the exact isolated launchd label and paths"]
    async fn isolated_launchd_service_preserves_stop_and_explicit_managed_restart() {
        let root = PathBuf::from(
            std::env::var_os("AREAL_HOST_SERVICE_VERIFY_ROOT")
                .expect("set the approved isolated root"),
        )
        .canonicalize()
        .unwrap();
        assert!(root.starts_with("/private/tmp"));
        let executable = PathBuf::from(
            std::env::var_os("AREAL_HOST_SERVICE_VERIFY_BINARY")
                .expect("set the approved immutable executable"),
        )
        .canonicalize()
        .unwrap();
        let home = root.join("home");
        assert!(
            !home.exists(),
            "use a fresh approved home, retaining all earlier attempts"
        );
        let installation =
            ServiceInstallation::at(home.clone(), &root.join("agents"), &executable).unwrap();
        let mut evidence = serde_json::json!({"installation":installation,"checks":[],"receipts":[],"passed":false});
        let evidence_path = root.join("result.json");
        std::fs::write(
            &evidence_path,
            serde_json::to_vec_pretty(&evidence).unwrap(),
        )
        .unwrap();
        use futures_util::FutureExt;
        let case = async {
            installation.install().unwrap();
            let first = wait_managed(&home).await;
            let first_identity = first.identity().clone();
            assert!(
                installation
                    .install()
                    .unwrap_err()
                    .to_string()
                    .contains("Host is running")
            );
            evidence["checks"].as_array_mut().unwrap().push(serde_json::json!({"name":"manager starts real Host; active install refused","identity":first_identity}));
            std::fs::write(
                &evidence_path,
                serde_json::to_vec_pretty(&evidence).unwrap(),
            )
            .unwrap();
            let original = uuid::Uuid::new_v4().to_string();
            evidence["pendingStop"] = serde_json::json!({"requestId":original,"hostId":first_identity.host_id,"generation":first_identity.generation});
            std::fs::write(
                &evidence_path,
                serde_json::to_vec_pretty(&evidence).unwrap(),
            )
            .unwrap();
            let stop = first
                .stop(
                    &original,
                    &first_identity.generation,
                    crate::StopStrategy::IfIdle,
                )
                .await
                .unwrap();
            evidence["receipts"]
                .as_array_mut()
                .unwrap()
                .push(stop.clone());
            std::fs::write(
                &evidence_path,
                serde_json::to_vec_pretty(&evidence).unwrap(),
            )
            .unwrap();
            assert_eq!(stop["state"], "completed");
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
            while home.join("host/host.json").exists() {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "Host descriptor remains after completed stop"
                );
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            let target = format!("gui/{}/{}", unsafe { libc::geteuid() }, installation.label);
            checked(Command::new("/bin/launchctl").args(["kickstart", &target])).unwrap();
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            assert!(crate::Client::connect_at(home.clone()).await.is_err());
            assert_eq!(
                crate::operation_offline(&home, &original).unwrap().unwrap(),
                stop
            );
            assert_eq!(
                crate::offline_service_status(&home).unwrap()["stopIntent"],
                true
            );
            evidence["checks"].as_array_mut().unwrap().push(serde_json::json!({"name":"passive manager launch preserves original completed stop","requestId":original}));
            assert!(ServiceInstallation::start_installed(&home).await.unwrap());
            let second = wait_managed(&home).await;
            assert_eq!(second.identity().host_id, first_identity.host_id);
            assert_ne!(second.identity().generation, first_identity.generation);
            evidence["checks"].as_array_mut().unwrap().push(serde_json::json!({"name":"explicit start restarts installed manager with stable identity","identity":second.identity()}));
            let final_request = uuid::Uuid::new_v4().to_string();
            evidence["pendingStop"] = serde_json::json!({"requestId":final_request,"hostId":second.identity().host_id,"generation":second.identity().generation});
            std::fs::write(
                &evidence_path,
                serde_json::to_vec_pretty(&evidence).unwrap(),
            )
            .unwrap();
            let final_stop = second
                .stop(
                    &final_request,
                    &second.identity().generation,
                    crate::StopStrategy::IfIdle,
                )
                .await
                .unwrap();
            evidence["receipts"]
                .as_array_mut()
                .unwrap()
                .push(final_stop.clone());
            std::fs::write(
                &evidence_path,
                serde_json::to_vec_pretty(&evidence).unwrap(),
            )
            .unwrap();
            assert_eq!(final_stop["state"], "completed");
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
            while home.join("host/host.json").exists() {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "final Host stop is not complete"
                );
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            ServiceInstallation::uninstall(&home).await.unwrap();
            assert!(!installation.descriptor.exists());
            assert!(!home.join("host/service-install.json").exists());
            assert_eq!(
                storage::read::<String>(&home.join("host/identity.json")).unwrap(),
                first_identity.host_id
            );
            assert_eq!(
                crate::operation_offline(&home, &original).unwrap().unwrap(),
                stop
            );
            assert!(
                !Command::new("/bin/launchctl")
                    .args(["print", &target])
                    .output()
                    .unwrap()
                    .status
                    .success()
            );
            evidence["checks"].as_array_mut().unwrap().push(serde_json::json!({"name":"uninstall drains Host and removes only exact manager registration; identity and original receipt retained"}));
            evidence["passed"] = serde_json::json!(true);
        };
        let outcome = std::panic::AssertUnwindSafe(case).catch_unwind().await;
        let cleanup = async {
            if !home.join("host/service-install.json").exists() {
                return Ok::<_, anyhow::Error>(());
            }
            let reference = &evidence["pendingStop"];
            let request = reference["requestId"]
                .as_str()
                .context("no recorded stop; cleanup requires an explicit new intent")?;
            let operation = match crate::Client::connect_at(home.clone()).await {
                Ok(client) => client.operation(request).await?,
                Err(_) => crate::operation_offline(&home, request)?,
            }
            .context("original stop outcome is unknown; retain service registration")?;
            ensure!(
                operation["requestId"] == reference["requestId"]
                    && operation["hostId"] == reference["hostId"]
                    && operation["generation"] == reference["generation"]
                    && operation["state"] == "completed",
                "original stop is not confirmed completed; retain service registration"
            );
            ensure!(
                crate::Client::connect_at(home.clone()).await.is_err(),
                "a Host is still live; no new cleanup stop will be submitted"
            );
            let lock = storage::open_private(&home.join("host.lock"), false)?;
            lock.try_lock_exclusive()
                .context("original Host has not released its lock")?;
            drop(lock);
            ServiceInstallation::uninstall(&home).await?;
            Ok(())
        }
        .await;
        evidence["cleanup"] = match &cleanup {
            Ok(_) => serde_json::json!({"completed":true}),
            Err(error) => {
                serde_json::json!({"completed":false,"cleanupRequired":true,"reference":evidence["pendingStop"],"error":format!("{error:#}")})
            }
        };
        if cleanup.is_err() {
            evidence["passed"] = serde_json::json!(false);
        }
        std::fs::write(
            &evidence_path,
            serde_json::to_vec_pretty(&evidence).unwrap(),
        )
        .unwrap();
        if let Err(error) = outcome {
            std::panic::resume_unwind(error);
        }
        cleanup.unwrap();
    }
    #[cfg(target_os = "macos")]
    async fn wait_managed(home: &Path) -> crate::Client {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            if let Ok(client) = crate::Client::connect_at(home.to_owned()).await {
                assert!(
                    crate::service_run::ServiceRun::is_managed_process(home, client.identity().pid)
                        .unwrap()
                );
                return client;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "managed Host startup timed out"
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }
}
