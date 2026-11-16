//! 工作台发现记录的持久所有权；继承锁证明旧写者已经退出，不以历史 PID 判断活性。
use anyhow::{Context, Result, ensure};
use areal_local_service::storage;
use fs2::FileExt;
use serde_json::{Value, json};
use std::{
    fs::File,
    path::{Path, PathBuf},
};

pub(crate) struct BackendOwner {
    pub(crate) lease: File,
    pub(crate) identity: Value,
    home: PathBuf,
}

impl BackendOwner {
    pub(crate) fn acquire(home: &Path, host: &crate::HostIdentity) -> Result<Self> {
        let lease = storage::open_private(&home.join("backend.lock"), true)?;
        lease
            .try_lock_exclusive()
            .context("Workbench owner is still active; recovery was not performed")?;
        let path = home.join("service.json");
        if let Some(record) = storage::read_json::<Value>(&path)? {
            let previous = storage::read_optional::<Value>(&home.join("backend-owner.json"))?
                .context("Workbench recovery requires the original owner record")?;
            let owner = &previous["owner"];
            ensure!(
                previous["version"] == 1
                    && owner["hostId"] == host.host_id
                    && owner["generation"]
                        .as_str()
                        .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
                    && owner["launchId"]
                        .as_str()
                        .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
                    && record["owner"] == *owner
                    && record["pid"].as_u64().is_some_and(|pid| pid > 1),
                "Workbench recovery owner or generation mismatch; discovery was preserved"
            );
            if let Some(service) = previous.get("service") {
                ensure!(
                    ["pid", "identity", "desktopGeneration"]
                        .iter()
                        .all(|key| record[key] == service[key]),
                    "Workbench recovery service identity mismatch; discovery was preserved"
                );
            }
            // 同一租约已经独占，旧 Host 与继承该锁的子进程均不再持有写权。
            std::fs::remove_file(&path)?;
        }
        let identity = json!({
            "hostId": host.host_id,
            "generation": host.generation,
            "launchId": uuid::Uuid::new_v4().to_string(),
        });
        storage::write(
            &home.join("backend-owner.json"),
            &json!({"version":1,"owner":identity}),
        )?;
        Ok(Self {
            lease,
            identity,
            home: home.to_path_buf(),
        })
    }

    pub(crate) fn ready(&self, service: &Value) -> Result<()> {
        storage::write(
            &self.home.join("backend-owner.json"),
            &json!({
                "version":1,
                "owner":self.identity,
                "service":{
                    "pid":service["pid"],
                    "identity":service["identity"],
                    "desktopGeneration":service["desktopGeneration"],
                }
            }),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(home: &Path) -> crate::HostIdentity {
        crate::HostIdentity {
            version: 1,
            host_id: uuid::Uuid::new_v4().to_string(),
            generation: uuid::Uuid::new_v4().to_string(),
            socket_path: home.join("control.sock"),
            auth_file: home.join("auth.json"),
            pid: std::process::id(),
            executable_version: "fixture".into(),
            executable_digest: None,
        }
    }

    #[test]
    fn successor_retires_matching_starting_claim_only_after_lease_release() {
        let root = tempfile::tempdir().unwrap();
        let mut host = host(root.path());
        let old = BackendOwner::acquire(root.path(), &host).unwrap();
        let record = json!({"state":"starting","pid":19,"owner":old.identity});
        storage::write(&root.path().join("service.json"), &record).unwrap();
        host.generation = uuid::Uuid::new_v4().to_string();
        assert!(BackendOwner::acquire(root.path(), &host).is_err());
        assert_eq!(
            storage::read::<Value>(&root.path().join("service.json")).unwrap(),
            record
        );
        drop(old);
        let next = BackendOwner::acquire(root.path(), &host).unwrap();
        assert_eq!(next.identity["generation"], host.generation);
        assert_ne!(next.identity, record["owner"]);
        assert!(!root.path().join("service.json").exists());
    }

    #[test]
    fn recovery_preserves_foreign_service_identities_and_generations() {
        for changed in [
            "pid",
            "identity",
            "desktopGeneration",
            "hostId",
            "generation",
            "launchId",
        ] {
            let root = tempfile::tempdir().unwrap();
            let mut host = host(root.path());
            let old = BackendOwner::acquire(root.path(), &host).unwrap();
            let service = json!({"pid":19,"identity":"backend","desktopGeneration":"desktop"});
            old.ready(&service).unwrap();
            let mut record = service;
            record["owner"] = old.identity.clone();
            if ["hostId", "generation", "launchId"].contains(&changed) {
                record["owner"][changed] = json!(uuid::Uuid::new_v4().to_string());
            } else {
                record[changed] = if changed == "pid" {
                    json!(20)
                } else {
                    json!("foreign")
                };
            }
            storage::write(&root.path().join("service.json"), &record).unwrap();
            drop(old);
            host.generation = uuid::Uuid::new_v4().to_string();
            assert!(
                BackendOwner::acquire(root.path(), &host).is_err(),
                "{changed}"
            );
            assert_eq!(
                storage::read::<Value>(&root.path().join("service.json")).unwrap(),
                record
            );
        }
    }

    #[test]
    fn recovery_preserves_unproven_records_and_other_hosts() {
        let root = tempfile::tempdir().unwrap();
        let host = host(root.path());
        let record = json!({"pid":19,"identity":"unowned","desktopGeneration":"unowned"});
        storage::write(&root.path().join("service.json"), &record).unwrap();
        assert!(BackendOwner::acquire(root.path(), &host).is_err());
        assert_eq!(
            storage::read::<Value>(&root.path().join("service.json")).unwrap(),
            record
        );
        std::fs::remove_file(root.path().join("service.json")).unwrap();
        let old = BackendOwner::acquire(root.path(), &host).unwrap();
        let record = json!({"pid":19,"state":"starting","owner":old.identity});
        storage::write(&root.path().join("service.json"), &record).unwrap();
        drop(old);
        let mut other = host;
        other.host_id = uuid::Uuid::new_v4().to_string();
        assert!(BackendOwner::acquire(root.path(), &other).is_err());
        assert_eq!(
            storage::read::<Value>(&root.path().join("service.json")).unwrap(),
            record
        );
    }
}
