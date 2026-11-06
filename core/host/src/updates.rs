use super::{Host, Operation, Stop};
use crate::{ProjectActivity, StopStrategy, VERSION, wire};
use anyhow::{Context, Result, ensure};
use areal_local_service::{native_process::TrustedCommand, storage};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Request {
    request_id: String,
    expected_generation: String,
    action: Action,
    target_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    strategy: Option<StopStrategy>,
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Action {
    Prepare,
    Apply,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pending {
    prepare_request_id: String,
    apply_request_id: Option<String>,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    installation: PathBuf,
    entry: PathBuf,
    bundle: PathBuf,
    version: String,
    manifest_digest: String,
    homebrew: bool,
}

fn pending(home: &Path) -> Result<Option<Pending>> {
    storage::read_optional(&home.join("host/update.json"))
}

pub(crate) fn restart_pending(home: &Path) -> Result<bool> {
    let Some(pending) = pending(home)? else {
        return Ok(false);
    };
    if let Some(id) = pending.apply_request_id {
        let record: Operation = storage::read(&wire::operation_path(home, &id))?;
        return Ok(record.receipt["state"] != "completed");
    }
    Ok(true)
}

fn valid_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 96
        && version
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-".contains(&c))
        && version.as_bytes()[0].is_ascii_digit()
}

fn layout(executable: &Path, version: &str) -> Result<Target> {
    ensure!(valid_version(version), "invalid target version");
    let executable = executable.canonicalize()?;
    let bin = executable.parent().context("missing binary directory")?;
    ensure!(
        bin.file_name().is_some_and(|v| v == "bin"),
        "source builds have no installed update target"
    );
    let current = bin.parent().context("missing bundle directory")?;
    let (installation, entry, bundle, homebrew) = if current
        .parent()
        .and_then(Path::parent)
        .is_some_and(|p| p.file_name().is_some_and(|n| n == "Cellar"))
    {
        let formula = current.parent().unwrap();
        let name = formula
            .file_name()
            .and_then(|v| v.to_str())
            .context("invalid formula")?;
        ensure!(
            matches!(name, "areal" | "areal-beta"),
            "unsupported formula"
        );
        let prefix = formula
            .parent()
            .unwrap()
            .parent()
            .context("missing brew prefix")?;
        let entry = prefix.join("opt").join(name).join("bin/areal");
        let resolved = entry.canonicalize()?;
        let bundle = resolved
            .parent()
            .and_then(Path::parent)
            .context("missing target keg")?
            .to_owned();
        ensure!(
            bundle.parent() == Some(formula) && resolved == bundle.join("bin/areal"),
            "entry changed installation"
        );
        let receipt = |root: &Path| -> Result<Value> {
            Ok(serde_json::from_slice(&std::fs::read(
                root.join("INSTALL_RECEIPT.json"),
            )?)?)
        };
        let old = receipt(current)?;
        let new = receipt(&bundle)?;
        ensure!(
            old["source"]["tap"].as_str().is_some_and(|v| !v.is_empty())
                && old["source"]["tap"] == new["source"]["tap"],
            "formula source changed"
        );
        ensure!(
            new["source"]["versions"]["stable"] == version
                && version.contains("-beta.") == (name == "areal-beta"),
            "formula version or channel changed"
        );
        (formula.to_owned(), entry, bundle, true)
    } else {
        let versions = current.parent().context("missing version directory")?;
        ensure!(
            versions.file_name().is_some_and(|v| v == "areal")
                && versions
                    .parent()
                    .is_some_and(|p| p.file_name().is_some_and(|v| v == "lib")),
            "unmanaged executable layout"
        );
        let prefix = versions
            .parent()
            .and_then(Path::parent)
            .context("missing installer prefix")?;
        let suffix = if cfg!(target_os = "macos") {
            "macos-arm64"
        } else {
            "linux-x86_64"
        };
        ensure!(
            current
                .file_name()
                .is_some_and(|v| v == format!("{}-{suffix}", env!("CARGO_PKG_VERSION")).as_str()),
            "unmanaged version directory"
        );
        (
            prefix.to_owned(),
            prefix.join("bin/areal"),
            versions.join(format!("{version}-{suffix}")),
            false,
        )
    };
    ensure!(
        (homebrew || entry.is_symlink()) && entry.canonicalize()? == bundle.join("bin/areal"),
        "stable entry must already point to the requested installed target"
    );
    let bundle = bundle.canonicalize()?;
    let manifest_digest = storage::digest(&std::fs::read(bundle.join("manifest.json"))?);
    let target = Target {
        installation,
        entry,
        bundle,
        version: version.to_owned(),
        manifest_digest,
        homebrew,
    };
    target.verify()?;
    Ok(target)
}

impl Target {
    fn executable(&self) -> PathBuf {
        self.bundle.join("bin/areal")
    }
    fn verify(&self) -> Result<()> {
        ensure!(
            (self.homebrew || self.entry.is_symlink())
                && self.entry.canonicalize()? == self.executable(),
            "stable entry changed after preparation"
        );
        ensure!(
            self.bundle.canonicalize()? == self.bundle,
            "bundle path changed"
        );
        let bytes = std::fs::read(self.bundle.join("manifest.json"))?;
        ensure!(
            storage::digest(&bytes) == self.manifest_digest,
            "manifest changed after preparation"
        );
        let manifest: Value = serde_json::from_slice(&bytes)?;
        let platform = if cfg!(target_os = "macos") {
            "darwin/arm64"
        } else {
            "linux/x86_64"
        };
        ensure!(
            matches!(manifest["manifestVersion"].as_u64(), Some(1 | 2))
                && manifest["productVersion"] == format!("areal {}", self.version)
                && manifest["platform"] == platform,
            "manifest version or platform mismatch"
        );
        if manifest["manifestVersion"] == 2 {
            let identity = &manifest["coreBuild"];
            ensure!(
                identity["inputHash"]
                    .as_str()
                    .is_some_and(|v| v.len() == 64 && v.bytes().all(|c| c.is_ascii_hexdigit()))
                    && ["sourceRevision", "apiVersion", "stateVersion"]
                        .iter()
                        .all(|k| identity[k] == manifest[k])
                    && matches!(identity["workingTree"].as_str(), Some("true" | "false"))
                    && (identity["workingTree"] == "true") == (manifest["workingTree"] == true),
                "Core build identity does not match manifest"
            );
        }
        let expected = manifest["files"]
            .as_object()
            .context("missing bundle inventory")?;
        for required in [
            "bin/areal",
            "libexec/areal/areal-runtime",
            "libexec/areal/areal-runtime-fs",
            "LICENSE",
        ] {
            ensure!(
                expected.contains_key(required),
                "incomplete bundle: {required}"
            );
        }
        if cfg!(target_os = "linux") {
            ensure!(
                expected.contains_key("libexec/areal/areal-runtime-reaper"),
                "missing runtime reaper"
            );
        }
        let mut actual = BTreeSet::new();
        inventory(&self.bundle, &self.bundle, &mut actual, self.homebrew)?;
        ensure!(
            actual == expected.keys().cloned().collect(),
            "bundle file inventory mismatch"
        );
        for (name, hash) in expected {
            let path = Path::new(name);
            ensure!(
                !name.contains('\\')
                    && !path.is_absolute()
                    && path
                        .components()
                        .all(|v| matches!(v, std::path::Component::Normal(_))),
                "unsafe inventory path"
            );
            ensure!(
                hash.as_str()
                    == Some(storage::digest(&std::fs::read(self.bundle.join(path))?).as_str()),
                "bundle checksum mismatch: {name}"
            );
        }
        Ok(())
    }
    async fn check_program(&self) -> Result<()> {
        let mut command = TrustedCommand::persistent(&self.executable())?;
        command.arg("--version");
        let output = command.output(Duration::from_secs(30)).await?;
        ensure!(
            output.status.success()
                && String::from_utf8_lossy(&output.stdout).trim()
                    == format!("areal {}", self.version),
            "installed executable version mismatch"
        );
        self.verify()
    }
}

fn inventory(
    root: &Path,
    directory: &Path,
    files: &mut BTreeSet<String>,
    homebrew: bool,
) -> Result<()> {
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let relative = path
            .strip_prefix(root)?
            .to_str()
            .context("non-UTF8 inventory path")?
            .to_owned();
        let meta = std::fs::symlink_metadata(&path)?;
        ensure!(
            !meta.file_type().is_symlink(),
            "bundle contains symlink: {relative}"
        );
        if homebrew
            && (relative == ".brew"
                || relative == "INSTALL_RECEIPT.json"
                || relative == "sbom.spdx.json")
        {
            continue;
        }
        if meta.is_dir() {
            inventory(root, &path, files, homebrew)?;
        } else {
            ensure!(meta.is_file(), "unsupported bundle member");
            if relative != "manifest.json" {
                files.insert(relative);
            }
        }
    }
    Ok(())
}

impl Host {
    pub(super) fn update_status(&self) -> Result<Value> {
        let Some(pending) = pending(&self.home)? else {
            return Ok(
                json!({"restartPending":false,"targetVersion":null,"prepareRequestId":null,"operation":null}),
            );
        };
        let id = pending
            .apply_request_id
            .as_ref()
            .unwrap_or(&pending.prepare_request_id);
        let operation = self
            .receipt(id)?
            .context("missing original update receipt")?
            .receipt;
        Ok(
            json!({"restartPending":operation["state"]!="completed","targetVersion":operation["targetVersion"],"prepareRequestId":pending.prepare_request_id,"operation":operation}),
        )
    }

    pub(super) fn reserved_update_stop(&self) -> Result<Option<String>> {
        let Some(pending) = pending(&self.home)? else {
            return Ok(None);
        };
        let Some(id) = pending.apply_request_id else {
            return Ok(None);
        };
        let record = self
            .receipt(&id)?
            .context("missing original apply receipt")?;
        if matches!(
            record.receipt["state"].as_str(),
            Some("completed" | "blocked")
        ) {
            return Ok(None);
        }
        Ok(record.receipt["stopRequestId"].as_str().map(str::to_owned))
    }

    pub(super) async fn update(&self, input: Request) -> Result<Value> {
        self.generation(&input.expected_generation)?;
        wire::request_id(&input.request_id)?;
        let digest = storage::digest(&serde_json::to_vec(
            &json!({"method":"host.update","params":input}),
        )?);
        if let Some(record) = self.receipt(&input.request_id)? {
            ensure!(
                record.digest == digest,
                wire::error(
                    "requestConflict",
                    "requestId already binds another operation"
                )
            );
            return self.reconcile_update(&input.request_id).await;
        }
        ensure!(
            self.client_operation(&input.request_id)?.is_none(),
            wire::error("requestConflict", "requestId belongs to another operation")
        );
        let _guard = self.host_stop_gate.lock().await;
        if let Some(record) = self.receipt(&input.request_id)? {
            ensure!(
                record.digest == digest,
                wire::error(
                    "requestConflict",
                    "requestId already binds another operation"
                )
            );
            drop(_guard);
            return self.reconcile_update(&input.request_id).await;
        }
        ensure!(
            self.client_operation(&input.request_id)?.is_none(),
            wire::error("requestConflict", "requestId belongs to another operation")
        );
        self.admission()?;
        ensure!(
            self.reserved_update_stop()?.is_none(),
            wire::error(
                "stopInProgress",
                "reconcile original update before new intent"
            )
        );
        let mut receipt = json!({"version":VERSION,"requestId":input.request_id,"method":"host.update","hostId":self.identity.host_id,"generation":self.identity.generation,"targetVersion":input.target_version,"action":input.action,"state":"acceptedPending"});
        let target = match input.action {
            Action::Prepare => {
                ensure!(
                    input.strategy.is_none(),
                    wire::error("invalidRequest", "prepare does not accept a stop strategy")
                );
                ensure!(
                    input.target_version != self.identity.executable_version,
                    wire::error("invalidUpdateTarget", "target is already running")
                );
                let target = layout(&self.bin.join("areal"), &input.target_version)
                    .map_err(|e| wire::error("updateUnavailable", e.to_string()))?;
                target
                    .check_program()
                    .await
                    .map_err(|e| wire::error("invalidUpdateTarget", e.to_string()))?;
                target
            }
            Action::Apply => {
                ensure!(
                    input.strategy.is_some(),
                    wire::error("invalidRequest", "apply requires an explicit strategy")
                );
                let pending = pending(&self.home)?.context(wire::error(
                    "updateUnavailable",
                    "prepare an installed target first",
                ))?;
                let prepared = self
                    .receipt(&pending.prepare_request_id)?
                    .context("missing preparation")?;
                ensure!(
                    prepared.receipt["state"] == "prepared"
                        && prepared.receipt["targetVersion"] == input.target_version,
                    wire::error(
                        "invalidUpdateTarget",
                        "target does not match original preparation"
                    )
                );
                let target: Target = serde_json::from_value(prepared.evidence["target"].clone())?;
                target
                    .verify()
                    .map_err(|e| wire::error("invalidUpdateTarget", e.to_string()))?;
                target
            }
        };
        let stop_id = uuid::Uuid::new_v4().to_string();
        ensure!(
            self.receipt(&input.request_id)?.is_none()
                && self.client_operation(&input.request_id)?.is_none(),
            wire::error(
                "requestConflict",
                "requestId was admitted while verifying the installed target"
            )
        );
        if matches!(input.action, Action::Apply) {
            receipt["stopRequestId"] = json!(stop_id);
        }
        storage::write(
            &wire::operation_path(&self.home, &input.request_id),
            &Operation {
                digest: digest.clone(),
                receipt: receipt.clone(),
                evidence: json!({"target":target,"stopDispatch":"notStarted"}),
            },
        )?;
        match input.action {
            Action::Prepare => {
                storage::write(
                    &self.home.join("host/update.json"),
                    &Pending {
                        prepare_request_id: input.request_id.clone(),
                        apply_request_id: None,
                    },
                )?;
                receipt["state"] = json!("prepared");
                self.save(&input.request_id, &digest, &receipt)?;
            }
            Action::Apply => {
                let mut pending = pending(&self.home)?.context("missing preparation")?;
                pending.apply_request_id = Some(input.request_id.clone());
                storage::write(&self.home.join("host/update.json"), &pending)?;
                let strategy = input.strategy.unwrap();
                if !strategy.cancel() {
                    let activity = self.activity().await;
                    if !activity.complete
                        || activity.projects.iter().any(|p| {
                            !matches!(
                                p,
                                ProjectActivity::Observed {
                                    idle_allowed: true,
                                    ..
                                }
                            )
                        })
                    {
                        receipt["state"] = json!("blocked");
                        receipt["message"] =
                            json!("Host has active or unavailable work; no stop was admitted");
                        self.save(&input.request_id, &digest, &receipt)?;
                        self.changed();
                        return Ok(receipt);
                    }
                }
                let mut operation = self
                    .receipt(&input.request_id)?
                    .context("missing original update")?;
                operation.evidence["stopDispatch"] = json!("started");
                storage::write(
                    &wire::operation_path(&self.home, &input.request_id),
                    &operation,
                )?;
                match self
                    .stop_host_new(Stop {
                        request_id: stop_id,
                        expected_generation: self.identity.generation.clone(),
                        strategy,
                        suppress_scheduling: true,
                        project_id: None,
                        service_generation: None,
                    })
                    .await
                {
                    Ok(stop) => {
                        receipt["state"] = json!(if stop["state"] == "completed" {
                            "acceptedPending"
                        } else {
                            stop["state"].as_str().unwrap_or("admissionUnknown")
                        });
                    }
                    Err(e) => {
                        receipt["state"] = json!("admissionUnknown");
                        receipt["message"] = json!(e.to_string());
                    }
                }
                self.save(&input.request_id, &digest, &receipt)?;
            }
        }
        self.changed();
        Ok(receipt)
    }

    pub(super) async fn reconcile_update(&self, id: &str) -> Result<Value> {
        let mut record = self.receipt(id)?.context("missing update receipt")?;
        if record.receipt["action"] == "prepare"
            && matches!(
                record.receipt["state"].as_str(),
                Some("acceptedPending" | "prepared")
            )
        {
            let Ok(_guard) = self.host_stop_gate.try_lock() else {
                return Ok(record.receipt);
            };
            record = self
                .receipt(id)?
                .context("missing original preparation after gate")?;
            if record.receipt["action"] != "prepare"
                || !matches!(
                    record.receipt["state"].as_str(),
                    Some("acceptedPending" | "prepared")
                )
            {
                return Ok(record.receipt);
            }
            let was_prepared = record.receipt["state"] == "prepared";
            let registration = (|| -> Result<bool> {
                let current = pending(&self.home)?;
                if let Some(current) = current {
                    return Ok(current.prepare_request_id == id);
                }
                let target: Target = serde_json::from_value(record.evidence["target"].clone())?;
                target.verify()?;
                storage::write(
                    &self.home.join("host/update.json"),
                    &Pending {
                        prepare_request_id: id.into(),
                        apply_request_id: None,
                    },
                )?;
                Ok(true)
            })();
            match registration {
                Ok(true) => {
                    record.receipt["state"] = json!("prepared");
                    record.receipt.as_object_mut().unwrap().remove("message");
                    self.save(id, &record.digest, &record.receipt)?;
                    self.changed();
                }
                Ok(false) => {
                    if !was_prepared {
                        record.receipt["state"] = json!("blocked");
                        record.receipt["message"] = json!(
                            "Another preparation is registered; original preparation was not committed"
                        );
                        self.save(id, &record.digest, &record.receipt)?;
                        self.changed();
                    }
                }
                Err(e) => {
                    if !was_prepared {
                        record.receipt["state"] = json!("acceptedPending");
                    }
                    record.receipt["message"] = json!(format!(
                        "Original preparation registration is unconfirmed: {e}"
                    ));
                }
            }
            return Ok(record.receipt);
        }
        if record.receipt["action"] == "apply"
            && record.receipt["state"] == "acceptedPending"
            && record.evidence["stopDispatch"] == "notStarted"
        {
            let Ok(_guard) = self.host_stop_gate.try_lock() else {
                return Ok(record.receipt);
            };
            record = self
                .receipt(id)?
                .context("missing original apply after gate")?;
            if record.receipt["action"] != "apply"
                || record.receipt["state"] != "acceptedPending"
                || record.evidence["stopDispatch"] != "notStarted"
            {
                return Ok(record.receipt);
            }
            record.receipt["state"] = json!("blocked");
            record.receipt["message"] =
                json!("Original apply ended before stop dispatch; no stop was submitted");
            self.save(id, &record.digest, &record.receipt)?;
            self.changed();
            return Ok(record.receipt);
        }
        if record.receipt["action"] == "apply"
            && record.receipt["state"] != "completed"
            && record.evidence["stopDispatch"] == "started"
        {
            let stop_id = record.receipt["stopRequestId"]
                .as_str()
                .context("missing original stop identity")?
                .to_owned();
            let stop = self.reconcile(&stop_id).await?;
            if let Some(stop) = stop {
                record.receipt["state"] = json!(if stop["state"] == "completed" {
                    "acceptedPending"
                } else {
                    stop["state"].as_str().unwrap_or("admissionUnknown")
                });
                self.save(id, &record.digest, &record.receipt)?;
                if stop["state"] == "completed"
                    && stop["hostId"] == self.identity.host_id
                    && stop["generation"] == self.identity.generation
                    && self
                        .stop
                        .borrow()
                        .as_ref()
                        .is_some_and(|s| s["requestId"] == stop_id)
                {
                    self.exit.notify_one();
                }
            }
        }
        Ok(record.receipt)
    }

    pub(super) fn settle_update_start(&self) -> Result<()> {
        let Some(pending) = pending(&self.home)? else {
            return Ok(());
        };
        let Some(id) = pending.apply_request_id else {
            return Ok(());
        };
        let mut record = self.receipt(&id)?.context("missing update receipt")?;
        if record.receipt["state"] == "completed" || record.evidence["stopDispatch"] != "started" {
            return Ok(());
        }
        let target: Target = serde_json::from_value(record.evidence["target"].clone())?;
        let stop_id = record.receipt["stopRequestId"]
            .as_str()
            .context("missing original stop identity")?;
        let stop = self.receipt(stop_id)?;
        if stop.is_some_and(|s| {
            s.receipt["state"] == "completed"
                && s.receipt["hostId"] == record.receipt["hostId"]
                && s.receipt["generation"] == record.receipt["generation"]
        }) && record.receipt["hostId"] == self.identity.host_id
            && self.identity.executable_version == target.version
            && std::env::current_exe()?.canonicalize()? == target.executable()
            && target.verify().is_ok()
        {
            record.receipt["state"] = json!("completed");
            self.save(&id, &record.digest, &record.receipt)?;
        }
        Ok(())
    }

    pub(super) fn exec_update(&self, managed: bool) -> Result<()> {
        use std::os::unix::process::CommandExt;
        let Some(pending) = pending(&self.home)? else {
            return Ok(());
        };
        let Some(id) = pending.apply_request_id else {
            return Ok(());
        };
        let mut record = self
            .receipt(&id)?
            .context("missing original update receipt")?;
        if matches!(
            record.receipt["state"].as_str(),
            Some("completed" | "blocked")
        ) || record.evidence["stopDispatch"] != "started"
        {
            return Ok(());
        }
        let stop_id = record.receipt["stopRequestId"]
            .as_str()
            .context("missing original stop identity")?
            .to_owned();
        let stop: Option<Value> = storage::read_optional(&self.home.join("host/stop.json"))?;
        if !stop.is_some_and(|s| {
            s["requestId"] == stop_id
                && s["state"] == "completed"
                && s["hostId"] == record.receipt["hostId"]
                && s["generation"] == record.receipt["generation"]
                && s["generation"] == self.identity.generation
        }) {
            return Ok(());
        }
        let target: Target = serde_json::from_value(record.evidence["target"].clone())?;
        if let Err(e) = target.verify() {
            record.receipt["state"] = json!("blocked");
            record.receipt["message"] = json!(format!(
                "Prepared target unavailable; original stop retained: {e}"
            ));
            self.save(&id, &record.digest, &record.receipt)?;
            return Ok(());
        }
        let previous =
            crate::service_run::ServiceRun::acknowledge_controlled_stop(&self.home, &stop_id)?;
        let mut command = std::process::Command::new(target.executable());
        command
            .args(["host", "run"])
            .env("AREAL_HARNESS_HOME", &self.home)
            .env("AREAL_HARNESS_SERVICE_HOME", &self.home);
        if managed {
            command.arg("--managed");
        }
        let error = command.exec();
        crate::service_run::ServiceRun::undo_controlled_stop(&self.home, &stop_id, previous)?;
        record.receipt["state"] = json!("blocked");
        record.receipt["message"] = json!(format!(
            "Controlled exec failed; original stop retained: {error}"
        ));
        self.save(&id, &record.digest, &record.receipt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn prepared_inventory_rejects_entry_switch_and_changed_runtime() {
        let root = tempfile::tempdir().unwrap();
        let prefix = root.path().canonicalize().unwrap();
        let suffix = if cfg!(target_os = "macos") {
            "macos-arm64"
        } else {
            "linux-x86_64"
        };
        let current = prefix.join(format!("lib/areal/{}-{suffix}", env!("CARGO_PKG_VERSION")));
        let bundle = prefix.join(format!("lib/areal/9.0.0-{suffix}"));
        std::fs::create_dir_all(current.join("bin")).unwrap();
        std::fs::write(current.join("bin/areal"), "old-fixture").unwrap();
        let mut names = vec![
            "bin/areal",
            "libexec/areal/areal-runtime",
            "libexec/areal/areal-runtime-fs",
            "LICENSE",
        ];
        if cfg!(target_os = "linux") {
            names.push("libexec/areal/areal-runtime-reaper");
        }
        let mut files = serde_json::Map::new();
        for name in names {
            let path = bundle.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, name).unwrap();
            files.insert(name.into(), json!(storage::digest(name.as_bytes())));
        }
        std::fs::write(bundle.join("manifest.json"), serde_json::to_vec(&json!({"manifestVersion":1,"productVersion":"areal 9.0.0","platform":if cfg!(target_os="macos") {"darwin/arm64"} else {"linux/x86_64"},"files":files})).unwrap()).unwrap();
        std::fs::create_dir(prefix.join("bin")).unwrap();
        let entry = prefix.join("bin/areal");
        symlink(bundle.join("bin/areal"), &entry).unwrap();
        let target = layout(&current.join("bin/areal"), "9.0.0").unwrap();
        target.verify().unwrap();
        std::fs::remove_file(&entry).unwrap();
        symlink(current.join("bin/areal"), &entry).unwrap();
        assert!(
            target
                .verify()
                .unwrap_err()
                .to_string()
                .contains("stable entry changed")
        );
        std::fs::remove_file(&entry).unwrap();
        symlink(bundle.join("bin/areal"), &entry).unwrap();
        std::fs::write(bundle.join("libexec/areal/areal-runtime"), "changed").unwrap();
        assert!(
            target
                .verify()
                .unwrap_err()
                .to_string()
                .contains("checksum mismatch")
        );
    }

    #[test]
    fn source_layout_and_absent_state_never_create_update_state() {
        let root = tempfile::tempdir().unwrap();
        assert!(!restart_pending(root.path()).unwrap());
        let executable = root.path().join("areal");
        std::fs::write(&executable, "unmanaged").unwrap();
        assert!(layout(&executable, "9.0.0").is_err());
        assert!(!root.path().join("host").exists());
    }
}
