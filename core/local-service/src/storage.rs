//! 登记只提供发现线索；活性必须经控制连接和 Core 认证共同确认。
use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
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

pub fn prepare_host_home(path: &Path) -> Result<PathBuf> {
    if let Err(error) = std::fs::symlink_metadata(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(error.into());
        }
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)?;
    }
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    let meta = directory.metadata()?;
    ensure!(
        meta.is_dir() && meta.uid() == unsafe { libc::geteuid() },
        "Host home must be owned by the current user"
    );
    let mode = meta.permissions().mode() & 0o7777;
    if mode == 0o755 {
        directory.set_permissions(std::fs::Permissions::from_mode(0o700))?;
        eprintln!(
            "Restricted legacy Host home permissions to 700: {}",
            path.display()
        );
    } else {
        ensure!(
            mode & 0o7077 == 0,
            "Host home must be private or legacy mode 755"
        );
    }
    let after = directory.metadata()?;
    let named = std::fs::symlink_metadata(path)?;
    ensure!(
        named.is_dir()
            && after.uid() == unsafe { libc::geteuid() }
            && after.mode() & 0o7077 == 0
            && after.dev() == named.dev()
            && after.ino() == named.ino(),
        "Host home changed during initialization"
    );
    Ok(path.canonicalize()?)
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
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    write_bytes(path, &bytes)
}

/// 同目录临时文件 + fsync + 改名 + fsync 目录；临时文件名以 `.tmp` 开头，见 `json_records`。
pub fn write_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("missing parent")?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.as_file()
        .set_permissions(std::fs::Permissions::from_mode(0o600))?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    file.persist(path)?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

/// 读当前用户拥有的普通文件，不限大小、不要求 0600；不存在返回 None。
pub fn read_bytes(path: &Path) -> Result<Option<Vec<u8>>> {
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
    {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && metadata.uid() == unsafe { libc::geteuid() },
        "source must be a regular file owned by current user"
    );
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut file, &mut bytes)?;
    Ok(Some(bytes))
}

/// `read_bytes` 再按 JSON 解析。
pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    read_bytes(path)?
        .map(|bytes| serde_json::from_slice(&bytes).map_err(Into::into))
        .transpose()
}

/// 列出目录里的 `*.json` 记录。`write` 崩溃时留下的 `.tmp*` 临时文件不是记录，
/// `clean` 为真时顺手删掉；只在持有目录写权的启动阶段传真。
pub fn json_records(directory: &Path, clean: bool) -> Result<Vec<PathBuf>> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut records = Vec::new();
    for entry in entries {
        let path = entry?.path();
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if name.starts_with(".tmp") {
            if clean {
                match std::fs::remove_file(&path) {
                    Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                        return Err(error.into());
                    }
                    _ => {}
                }
            }
        } else if path
            .extension()
            .is_some_and(|extension| extension == "json")
        {
            records.push(path);
        }
    }
    records.sort();
    Ok(records)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StopReceipt {
    pub operation: areal_protocol::service::StopOperation,
    pub service: areal_protocol::service::Service,
    pub cleanup_confirmed: bool,
}

pub fn stop_receipt_path(directory: &Path, request_id: &str) -> Result<PathBuf> {
    ensure!(
        !request_id.is_empty() && request_id.len() <= 256,
        "request ID must contain 1 to 256 bytes"
    );
    Ok(directory
        .join("operations")
        .join(format!("{}.json", digest(request_id.as_bytes()))))
}

pub fn read_stop_receipt(directory: &Path, request_id: &str) -> Result<Option<StopReceipt>> {
    let path = stop_receipt_path(directory, request_id)?;
    if path.parent().unwrap().exists() {
        private_dir(path.parent().unwrap())?;
    }
    match read::<StopReceipt>(&path) {
        Ok(receipt) => {
            ensure!(
                receipt.operation.request_id == request_id,
                "invalid operation receipt"
            );
            Ok(Some(receipt))
        }
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

pub fn write_stop_receipt(directory: &Path, receipt: &StopReceipt) -> Result<()> {
    let path = stop_receipt_path(directory, &receipt.operation.request_id)?;
    private_dir(path.parent().unwrap())?;
    File::open(directory)?.sync_all()?;
    write(&path, receipt)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CrashReceipt {
    pub version: u32,
    pub unexpected_core_exit: bool,
    pub identity: areal_protocol::service::Identity,
    pub owner: Option<areal_protocol::service::Owner>,
    pub components: std::collections::BTreeMap<String, String>,
    pub cleanup_confirmed: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CleanupReceipt {
    pub version: u32,
    pub identity: areal_protocol::service::Identity,
    pub owner: Option<areal_protocol::service::Owner>,
    pub components: std::collections::BTreeMap<String, String>,
    pub cleanup_confirmed: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LauncherCleanup {
    pub identity: areal_protocol::service::Identity,
    pub unexpected_core_exit: bool,
    pub runtime_cleanup_confirmed: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ReplacementPublication {
    Unconfirmed,
    Published(areal_protocol::service::Identity),
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplacementReceipt {
    pub original: areal_protocol::service::Identity,
    pub owner: Option<areal_protocol::service::Owner>,
    pub components: std::collections::BTreeMap<String, String>,
    pub successor: ReplacementPublication,
}

pub fn read_optional<T: DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    match read(path) {
        Ok(value) => Ok(Some(value)),
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

pub fn has_admitted_stop_receipt(
    directory: &Path,
    identity: &areal_protocol::service::Identity,
) -> Result<bool> {
    let operations = directory.join("operations");
    if !operations.exists() {
        return Ok(false);
    }
    private_dir(&operations)?;
    for path in json_records(&operations, false)? {
        let receipt: StopReceipt = read(&path)?;
        if receipt.operation.generation != identity.generation {
            continue;
        }
        ensure!(
            receipt.service.identity == *identity
                && receipt.operation.service_id == identity.service_id
                && receipt.operation.version == areal_protocol::service::VERSION,
            "invalid original-generation stop receipt"
        );
        if receipt.operation.state != areal_protocol::service::StopOperationState::Blocked {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn available(path: &Path) -> Result<bool> {
    // 这里只观察独占 owner；真正启动或打开数据仍须取得独占锁。
    let file = open_private(path, true)?;
    match FileExt::try_lock_shared(&file) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => Ok(false),
        Err(e) => Err(e.into()),
    }
}

pub fn store_available(data: &Path) -> Result<bool> {
    let file = store_lock(data)?;
    match FileExt::try_lock_shared(&file) {
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
    Ok(root.join("services").join(id))
}

pub fn control_socket(directory: &Path) -> Result<PathBuf> {
    let inline = directory.join("control.sock");
    if inline.as_os_str().as_encoded_bytes().len() < 104 {
        return Ok(inline);
    }
    let path = PathBuf::from("/tmp")
        .join(format!("areal-{}", unsafe { libc::geteuid() }))
        .join(format!(
            "{}.sock",
            digest(directory.as_os_str().as_encoded_bytes())
        ));
    ensure!(
        path.as_os_str().as_encoded_bytes().len() < 104,
        "service socket path is too long: {}",
        path.display()
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
    fn availability_observers_share_reads_but_reject_live_owners() {
        let root = tempfile::tempdir().unwrap();
        for name in ["service.lock", "owner.lock"] {
            let path = root.path().join(name);
            let reader = open_private(&path, true).unwrap();
            FileExt::try_lock_shared(&reader).unwrap();
            assert!(available(&path).unwrap());
            if name == "owner.lock" {
                assert!(store_available(root.path()).unwrap());
            }
            let owner = open_private(&path, true).unwrap();
            assert!(owner.try_lock_exclusive().is_err());
            drop(reader);
            owner.try_lock_exclusive().unwrap();
            assert!(!available(&path).unwrap());
            if name == "owner.lock" {
                assert!(!store_available(root.path()).unwrap());
            }
        }
    }

    #[test]
    fn host_home_restricts_legacy_directory_without_changing_children() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("legacy");
        std::fs::create_dir(&home).unwrap();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o755)).unwrap();
        let child = home.join("child");
        std::fs::create_dir(&child).unwrap();
        std::fs::set_permissions(&child, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(home.join("config.toml"), b"original").unwrap();
        prepare_host_home(&home).unwrap();
        assert_eq!(std::fs::metadata(&home).unwrap().mode() & 0o7777, 0o700);
        assert_eq!(std::fs::metadata(&child).unwrap().mode() & 0o7777, 0o755);
        assert_eq!(
            std::fs::read(home.join("config.toml")).unwrap(),
            b"original"
        );
        prepare_host_home(&home).unwrap();
        let alias = root.path().join("alias");
        symlink(&home, &alias).unwrap();
        assert!(prepare_host_home(&alias).is_err());
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o775)).unwrap();
        assert!(prepare_host_home(&home).is_err());
        assert_eq!(std::fs::metadata(&home).unwrap().mode() & 0o7777, 0o775);
    }

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
