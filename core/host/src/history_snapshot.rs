//! 独立只读历史导出；不发现 Host、不建立项目服务、不恢复或结算原操作。
use anyhow::{Context, Result, ensure};
use areal_local_service::storage;
use areal_protocol::service::Service;
use fs2::FileExt;
use std::{
    fs::{File, OpenOptions},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};

pub struct HistorySnapshot {
    pub conversation: areal_engine::PersistedConversation,
    pub service_generation: String,
    pub data_dir: std::path::PathBuf,
    pub workspace: std::path::PathBuf,
}

fn lock(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    let meta = file.metadata()?;
    ensure!(
        meta.is_file() && meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o022 == 0,
        "untrusted history lock"
    );
    file.try_lock_exclusive().map_err(|_| {
        crate::wire::error(
            "RESOURCE_BUSY",
            "project history is currently owned; no snapshot was read",
        )
    })?;
    Ok(file)
}

pub fn read_history_snapshot(descriptor: &Path, thread: &str) -> Result<HistorySnapshot> {
    ensure!(
        descriptor
            .file_name()
            .is_some_and(|name| name == "service.json"),
        "expected original service.json"
    );
    let directory = descriptor.parent().context("service directory missing")?;
    ensure!(
        directory.canonicalize()? == directory,
        "service directory must be canonical and not symlinked"
    );
    let startup = lock(&directory.join("start.lock"))?;
    let service: Service = storage::read(descriptor)?;
    let root = &service.identity.data_dir;
    let workspace = &service.identity.workspace;
    ensure!(
        root.canonicalize()? == *root && workspace.canonicalize()? == *workspace,
        "history identity paths must be canonical"
    );
    ensure!(
        service.identity.protocol_version == 1
            && service.identity.service_id
                == storage::digest(root.as_os_str().as_encoded_bytes())[..24]
            && directory
                .file_name()
                .is_some_and(|name| name == service.identity.service_id.as_str()),
        "service identity mismatch"
    );
    let service_lock = lock(&root.join("service.lock"))?;
    let owner = lock(&root.join("owner.lock"))?;
    ensure!(
        storage::read::<std::path::PathBuf>(&root.join("service-workspace"))? == *workspace,
        "workspace binding mismatch"
    );
    let conversation = areal_engine::PersistedConversation::read(root, workspace, thread)?;
    ensure!(
        serde_json::to_value(storage::read::<Service>(descriptor)?)?
            == serde_json::to_value(&service)?,
        "service changed during snapshot"
    );
    for (path, file) in [
        (directory.join("start.lock"), &startup),
        (root.join("service.lock"), &service_lock),
        (root.join("owner.lock"), &owner),
    ] {
        let held = file.metadata()?;
        let named = std::fs::symlink_metadata(path)?;
        ensure!(
            named.is_file() && held.dev() == named.dev() && held.ino() == named.ino(),
            "history lock changed during snapshot"
        );
    }
    Ok(HistorySnapshot {
        conversation,
        service_generation: service.identity.generation,
        data_dir: root.clone(),
        workspace: workspace.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn standalone_snapshot_rejects_owner_and_preserves_unknown_and_source() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let root = base.join("state");
        storage::private_dir(&root).unwrap();
        let service_id = storage::digest(root.as_os_str().as_encoded_bytes())[..24].to_string();
        let directory = base.join(&service_id);
        storage::private_dir(&directory).unwrap();
        for path in [
            directory.join("start.lock"),
            root.join("service.lock"),
            root.join("owner.lock"),
        ] {
            drop(storage::open_private(&path, true).unwrap());
        }
        storage::write(&root.join("service-workspace"), &base).unwrap();
        let descriptor = directory.join("service.json");
        storage::write(&descriptor, &json!({"protocolVersion":1,"serviceId":service_id,"generation":"original-generation","workspace":base,"dataDir":root,"configFingerprint":"fixture","endpoint":"ws://127.0.0.1:1","webUrl":"http://127.0.0.1:1","authFile":directory.join("auth.json"),"logFile":directory.join("host.log"),"hostPid":99999999,"corePid":99999998,"state":"stopped"})).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let record = root.join(format!("{id}.json"));
        storage::write(&record,&json!({"version":17,"thread":{"id":id,"sessionId":id,"parentThreadId":null,"preview":"fixture","modelProvider":"fixture","createdAt":1,"updatedAt":2,"status":{"type":"active","activeFlags":[]},"cwd":base,"cliVersion":"fixture","source":"cli","ephemeral":false,"turns":[{"id":"pending","status":"inProgress","items":[{"type":"agentMessage","id":"message","text":"recorded"}]}]}})).unwrap();
        let receipt = directory.join("original-stop.json");
        storage::write(
            &receipt,
            &json!({"requestId":"original","state":"admissionUnknown"}),
        )
        .unwrap();
        let original = std::fs::read(&record).unwrap();
        let original_receipt = std::fs::read(&receipt).unwrap();
        let owned = lock(&root.join("owner.lock")).unwrap();
        assert!(
            read_history_snapshot(&descriptor, &id)
                .err()
                .unwrap()
                .to_string()
                .contains("currently owned")
        );
        drop(owned);
        let result = read_history_snapshot(&descriptor, &id).unwrap();
        assert_eq!(
            result.conversation.thread().turns[0].status,
            areal_protocol::TurnStatus::InProgress
        );
        assert_eq!(std::fs::read(&record).unwrap(), original);
        assert_eq!(std::fs::read(&receipt).unwrap(), original_receipt);
        assert!(!directory.join("auth.json").exists());
        storage::write(&root.join("service-workspace"), &root).unwrap();
        assert!(read_history_snapshot(&descriptor, &id).is_err());
    }
}
