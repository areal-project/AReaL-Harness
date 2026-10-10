//! 登记只提供发现线索；活性必须经控制连接和 Core 认证共同确认。
use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn canonical_pending(path: &Path) -> Result<PathBuf> {
    let path = std::path::absolute(path)?;
    if path.exists() {
        return Ok(path.canonicalize()?);
    }
    // 悬空链接不能被当作可创建的新目录。
    ensure!(std::fs::symlink_metadata(&path).is_err(), "dangling path");
    Ok(
        canonical_pending(path.parent().context("path has no parent")?)?
            .join(path.file_name().context("path has no name")?),
    )
}

pub fn private_dir(path: &Path) -> Result<()> {
    if !path.exists() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)?;
    }
    let meta = std::fs::symlink_metadata(path)?;
    ensure!(
        meta.is_dir()
            && meta.uid() == unsafe { libc::geteuid() }
            && meta.permissions().mode() & 0o077 == 0,
        "service directory must be owned by the current user with mode 700: {}",
        path.display()
    );
    Ok(())
}

pub fn open_private(path: &Path, create: bool) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(create)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    validate(&file)?;
    Ok(file)
}

fn validate(file: &File) -> Result<()> {
    let m = file.metadata()?;
    ensure!(
        m.is_file() && m.uid() == unsafe { libc::geteuid() } && m.permissions().mode() & 0o077 == 0,
        "service file must be a regular file owned by the current user with mode 600"
    );
    Ok(())
}

pub fn read<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    validate(&file)?;
    ensure!(
        file.metadata()?.len() <= 256 * 1024,
        "service file exceeds 256 KiB"
    );
    Ok(serde_json::from_reader(file)?)
}

pub fn write(path: &Path, value: &impl Serialize) -> Result<()> {
    let mut file = tempfile::NamedTempFile::new_in(path.parent().context("missing parent")?)?;
    file.as_file()
        .set_permissions(std::fs::Permissions::from_mode(0o600))?;
    serde_json::to_writer(&mut file, value)?;
    file.write_all(b"\n")?;
    file.as_file().sync_all()?;
    file.persist(path)?;
    File::open(path.parent().unwrap())?.sync_all()?;
    Ok(())
}

pub fn available(path: &Path) -> Result<bool> {
    let file = open_private(path, true)?;
    match file.try_lock_exclusive() {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => Ok(false),
        Err(e) => Err(e.into()),
    }
}

pub fn store_available(data: &Path) -> Result<bool> {
    let file = store_lock(data)?;
    match file.try_lock_exclusive() {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => Ok(false),
        Err(e) => Err(e.into()),
    }
}

fn store_lock(data: &Path) -> Result<File> {
    // 旧版 owner.lock 可能为 0644；它不包含身份或凭据，保留原有权限。
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(data.join("owner.lock"))?;
    let meta = file.metadata()?;
    ensure!(
        meta.is_file() && meta.uid() == unsafe { libc::geteuid() },
        "invalid Core owner lock"
    );
    Ok(file)
}

pub fn bind_workspace(data: &Path, workspace: &Path) -> Result<()> {
    let owner = store_lock(data)?;
    owner
        .try_lock_exclusive()
        .context("stop the Core before binding its data")?;
    let binding = data.join("service-workspace");
    if binding.exists() {
        ensure!(
            read::<PathBuf>(&binding)? == workspace,
            "data directory is bound to another workspace"
        );
        return Ok(());
    }
    // 首次绑定须在 Core 停止时检查历史；元数据不使用 Store 的 .json 后缀。
    for entry in std::fs::read_dir(data)? {
        let path = entry?.path();
        if path.extension().is_none_or(|e| e != "json") {
            continue;
        }
        let record: serde_json::Value = serde_json::from_slice(&std::fs::read(&path)?)?;
        let cwd = record["thread"]["cwd"]
            .as_str()
            .context("stored thread has no cwd")?;
        ensure!(
            Path::new(cwd).canonicalize()?.starts_with(workspace),
            "stored thread belongs to another workspace: {}",
            path.display()
        );
    }
    write(&binding, &workspace)
}

pub fn registry(root: &Path, id: &str) -> Result<PathBuf> {
    ensure!(
        id.len() == 24 && id.bytes().all(|b| b.is_ascii_hexdigit()),
        "invalid instance ID"
    );
    let path = root.join("services").join(id);
    ensure!(
        path.join("control.sock").as_os_str().len() < 104,
        "service socket path is too long; use a shorter AREAL_HARNESS_SERVICE_HOME"
    );
    Ok(path)
}

pub fn file_digest(path: &Path) -> Result<String> {
    let mut hash = Sha256::new();
    let mut file = File::open(path)?;
    let mut bytes = [0u8; 65536];
    loop {
        let n = file.read(&mut bytes)?;
        if n == 0 {
            break;
        }
        hash.update(&bytes[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn canonical_identity_and_private_records_reject_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("target");
        private_dir(&target).unwrap();
        let alias = root.path().join("alias");
        symlink(&target, &alias).unwrap();
        assert_eq!(
            canonical_pending(&alias.join("new/state")).unwrap(),
            target.canonicalize().unwrap().join("new/state")
        );
        assert!(private_dir(&alias).is_err());
        write(&target.join("record"), &"value").unwrap();
        symlink(target.join("record"), root.path().join("record")).unwrap();
        assert!(read::<String>(&root.path().join("record")).is_err());
    }

    #[test]
    fn binding_requires_exclusive_store_and_matching_history() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let other = root.path().join("other");
        let data = root.path().join("state");
        for path in [&workspace, &other, &data] {
            std::fs::create_dir(path).unwrap();
        }
        let workspace = workspace.canonicalize().unwrap();
        let other = other.canonicalize().unwrap();
        let owner = store_lock(&data).unwrap();
        owner.try_lock_exclusive().unwrap();
        assert!(bind_workspace(&data, &workspace).is_err());
        drop(owner);
        let record = data.join("00000000-0000-0000-0000-000000000000.json");
        write(&record, &serde_json::json!({"thread":{"cwd":other}})).unwrap();
        assert!(bind_workspace(&data, &workspace).is_err());
        write(&record, &serde_json::json!({"thread":{"cwd":workspace}})).unwrap();
        bind_workspace(&data, &workspace).unwrap();
        assert!(bind_workspace(&data, &other).is_err());
        assert_eq!(
            std::fs::read_dir(data)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|e| e.path().extension().is_some_and(|e| e == "json"))
                .count(),
            1
        );
    }
}
