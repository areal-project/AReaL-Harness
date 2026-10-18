//! 宿主排障制品的回收与活跃日志租约；不清理任何业务历史。
use anyhow::Result;
use areal_local_service::storage;
use fs2::FileExt;
use std::{
    collections::BTreeMap,
    fs::File,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

pub(crate) fn create_log(data: &Path) -> Result<(PathBuf, File)> {
    let gate = storage::open_private(&data.join("log-retention.lock"), true)?;
    gate.lock_exclusive()?;
    let log = tempfile::Builder::new()
        .prefix("launch-")
        .suffix(".log")
        .tempfile_in(data)?
        .keep()?
        .1;
    let lease = storage::open_private(&log.with_extension("lock"), true)?;
    lease.lock_exclusive()?;
    Ok((log, lease))
}

pub(crate) fn logs(data: &Path) -> Result<()> {
    let gate = storage::open_private(&data.join("log-retention.lock"), true)?;
    gate.lock_exclusive()?;
    let now = SystemTime::now();
    let mut retained = BTreeMap::new();
    let mut bytes = 0u64;
    for entry in std::fs::read_dir(data)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !entry.file_type()?.is_file() || !name.starts_with("launch-") || !name.ends_with(".log")
        {
            continue;
        }
        let lease_path = path.with_extension("lock");
        let lease = if lease_path.exists() {
            Some(storage::open_private(&lease_path, false)?)
        } else {
            None
        };
        if let Some(lease) = &lease {
            match lease.try_lock_exclusive() {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => continue,
                Err(error) => return Err(error.into()),
            }
        }
        let meta = entry.metadata()?;
        let modified = meta.modified()?;
        if now.duration_since(modified).unwrap_or_default() >= Duration::from_secs(7 * 24 * 60 * 60)
        {
            std::fs::remove_file(&path)?;
        } else {
            bytes = bytes.saturating_add(meta.len());
            retained.insert((modified, path.clone()), meta.len());
            while retained.len() > 8 || bytes > 8 * 1024 * 1024 {
                let ((_, path), size) = retained.pop_first().unwrap();
                std::fs::remove_file(path)?;
                bytes = bytes.saturating_sub(size);
            }
        }
        if lease.is_some() {
            std::fs::remove_file(lease_path)?;
        }
    }
    // 日志已被删除或创建失败的崩溃遗留租约也必须回收。
    for entry in std::fs::read_dir(data)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if entry.file_type()?.is_file() && name.starts_with("launch-") && name.ends_with(".lock") {
            let lease = storage::open_private(&entry.path(), false)?;
            if lease.try_lock_exclusive().is_ok() {
                std::fs::remove_file(entry.path())?;
            }
        }
    }
    Ok(())
}

pub(crate) fn bound_log(path: &Path) {
    if let Ok(file) = storage::open_private(path, false)
        && file.metadata().is_ok_and(|meta| meta.len() > 1024 * 1024)
    {
        let _ = file.set_len(0);
    }
}

pub(crate) fn launcher_state(data: &Path) -> Result<(tempfile::TempDir, File)> {
    let root = data.join("launcher-state");
    storage::private_dir(&root)?;
    let gate = storage::open_private(&root.join("retention.lock"), true)?;
    gate.lock_exclusive()?;
    for entry in std::fs::read_dir(&root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() || !entry.file_name().to_string_lossy().starts_with(".run-")
        {
            continue;
        }
        storage::private_dir(&entry.path())?;
        let lease_path = entry.path().join("owner.lock");
        if lease_path.exists() {
            let lease = storage::open_private(&lease_path, false)?;
            match lease.try_lock_exclusive() {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => continue,
                Err(error) => return Err(error.into()),
            }
        }
        std::fs::remove_dir_all(entry.path())?;
    }
    // 固定私有目录与租约允许下一次启动识别 SIGKILL 遗留，不扫描系统 /tmp。
    let directory = tempfile::Builder::new().prefix(".run-").tempdir_in(&root)?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))?;
    let lease = storage::open_private(&directory.path().join("owner.lock"), true)?;
    lease.lock_exclusive()?;
    Ok((directory, lease))
}

pub(crate) fn generations(directory: &Path) -> Result<()> {
    // 调用者已独占实例锁并确认 Store 无旧所有者；UUID 子目录只保存启动握手信息。
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        if entry.file_type()?.is_dir()
            && entry
                .file_name()
                .to_str()
                .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
        {
            std::fs::remove_dir_all(entry.path())?;
        } else if entry.file_type()?.is_file()
            && entry.file_name().to_string_lossy().starts_with(".tmp")
        {
            std::fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_logs_are_protected_and_completed_logs_are_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let (active, lease) = create_log(dir.path()).unwrap();
        File::open(&active)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(8 * 24 * 3600))
            .unwrap();
        for index in 0..12 {
            let path = dir.path().join(format!("launch-old-{index}.log"));
            std::fs::write(&path, b"log").unwrap();
            File::open(&path)
                .unwrap()
                .set_modified(SystemTime::now() - Duration::from_secs(100 - index))
                .unwrap();
        }
        storage::open_private(&dir.path().join("launch-orphan.lock"), true).unwrap();
        std::fs::write(dir.path().join("user.log"), b"keep").unwrap();
        logs(dir.path()).unwrap();
        assert!(active.exists());
        assert!(!dir.path().join("launch-old-0.log").exists());
        assert!(dir.path().join("launch-old-11.log").exists());
        assert_eq!(
            std::fs::read_dir(dir.path())
                .unwrap()
                .filter(|entry| entry
                    .as_ref()
                    .unwrap()
                    .path()
                    .extension()
                    .is_some_and(|s| s == "log"))
                .count(),
            10
        );
        assert!(!dir.path().join("launch-orphan.lock").exists());
        drop(lease);
        logs(dir.path()).unwrap();
        assert!(!active.exists());
        let huge = dir.path().join("launch-huge.log");
        std::fs::write(&huge, vec![b'x'; 9 * 1024 * 1024]).unwrap();
        logs(dir.path()).unwrap();
        assert!(!huge.exists());
    }

    #[test]
    fn launcher_state_reclaims_crashes_and_preserves_active_owners() {
        let dir = tempfile::tempdir().unwrap();
        let (active, lease) = launcher_state(dir.path()).unwrap();
        let active_path = active.path().to_path_buf();
        let crashed = launcher_state(dir.path()).unwrap().0.keep();
        let (_next, _lease) = launcher_state(dir.path()).unwrap();
        assert!(active_path.exists());
        assert!(!crashed.exists());
        drop(lease);
        let _last = launcher_state(dir.path()).unwrap();
        assert!(!active_path.exists());
    }

    #[test]
    fn generations_ignore_user_files_and_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let generation = dir.path().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&generation).unwrap();
        std::fs::write(generation.join("ready.json"), b"ready").unwrap();
        std::fs::write(dir.path().join("descriptor.json"), b"keep").unwrap();
        std::fs::write(outside.path().join("sentinel"), b"keep").unwrap();
        std::os::unix::fs::symlink(
            outside.path(),
            dir.path().join(uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();
        generations(dir.path()).unwrap();
        assert!(!generation.exists());
        assert!(dir.path().join("descriptor.json").exists());
        assert!(outside.path().join("sentinel").exists());
    }

    #[test]
    fn append_writer_does_not_create_sparse_log_after_truncation() {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.log");
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        file.write_all(&vec![b'x'; 1024 * 1024 + 1]).unwrap();
        bound_log(&path);
        file.write_all(b"next").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"next");
    }
}
