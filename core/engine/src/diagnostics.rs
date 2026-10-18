//! 非权威诊断的有界保留；不能用日志回收规则删除历史、Goal 账本或用户 scratch。
use fs2::FileExt;
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

const DAY: u64 = 24 * 60 * 60;
pub(crate) const MAX_RECORD_BYTES: usize = 1024 * 1024;
const JSONL_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Copy)]
pub(crate) struct Policy {
    pub age: Duration,
    pub count: usize,
    pub bytes: u64,
}
const REQUESTS: Policy = Policy {
    age: Duration::from_secs(30 * DAY),
    count: 4096,
    bytes: 64 * 1024 * 1024,
};
const ERRORS: Policy = Policy {
    age: Duration::from_secs(7 * DAY),
    count: 512,
    bytes: 8 * 1024 * 1024,
};
pub(crate) const CORE_AUDIT: Policy = Policy {
    age: Duration::from_secs(30 * DAY),
    count: 1024,
    bytes: 16 * 1024 * 1024,
};

pub(crate) fn private_dir(path: &Path) -> io::Result<()> {
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    let meta = std::fs::symlink_metadata(path)?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err(io::Error::other(
            "diagnostic directory must not be a symlink",
        ));
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
}

pub(crate) fn open(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
        .open(path)?;
    if !file.metadata()?.is_file() || file.metadata()?.nlink() != 1 {
        return Err(io::Error::other("invalid diagnostic file"));
    }
    file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    Ok(file)
}

pub(crate) fn lock(directory: &Path) -> io::Result<File> {
    private_dir(directory)?;
    let file = open(&directory.join("retention.lock"))?;
    file.lock_exclusive()?;
    Ok(file)
}

pub(crate) fn lease(directory: &Path, id: &str) -> io::Result<File> {
    private_dir(&directory.join(".leases"))?;
    let file = open(&directory.join(".leases").join(format!("{id}.lock")))?;
    file.lock_exclusive()?;
    Ok(file)
}

fn active(directory: &Path, id: &str) -> io::Result<bool> {
    let path = directory.join(".leases").join(format!("{id}.lock"));
    if !path.try_exists()? {
        return Ok(false);
    }
    let file = open(&path)?;
    match file.try_lock_exclusive() {
        Ok(()) => Ok(false),
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(true),
        Err(error) => Err(error),
    }
}

fn uuid_file(path: &Path, extension: &str) -> bool {
    path.extension().is_some_and(|e| e == extension)
        && path
            .file_stem()
            .and_then(|s| s.to_str())
            .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
}

// 清理只枚举已知目录和命名，索引大小受 count 限制，不遍历用户目录或跟随符号链接。
pub(crate) fn prune(
    directory: &Path,
    policy: Policy,
    now: SystemTime,
    mut protected: impl FnMut(&Path) -> io::Result<bool>,
) -> io::Result<()> {
    let mut retained = BTreeMap::<(SystemTime, PathBuf), u64>::new();
    let mut bytes = 0u64;
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() || !uuid_file(&entry.path(), "json") {
            continue;
        }
        let path = entry.path();
        if protected(&path)? {
            continue;
        }
        let meta = entry.metadata()?;
        let modified = meta.modified()?;
        if now.duration_since(modified).unwrap_or_default() >= policy.age {
            std::fs::remove_file(path)?;
            continue;
        }
        bytes = bytes.saturating_add(meta.len());
        retained.insert((modified, path), meta.len());
        while retained.len() > policy.count || bytes > policy.bytes {
            let ((_, path), size) = retained.pop_first().unwrap();
            std::fs::remove_file(path)?;
            bytes = bytes.saturating_sub(size);
        }
    }
    Ok(())
}

pub(crate) fn encode(value: &serde_json::Value) -> Vec<u8> {
    let bytes = value.to_string().into_bytes();
    if bytes.len() <= MAX_RECORD_BYTES {
        return bytes;
    }
    // 超大排障内容不影响权威历史，仅保存身份和截断事实。
    let mut summary = serde_json::json!({"auditTruncated":true,"originalBytes":bytes.len()});
    for field in [
        "requestId",
        "threadId",
        "turnId",
        "kind",
        "outcome",
        "usage",
        "usageObserved",
    ] {
        if let Some(value) = value.get(field).filter(|v| v.to_string().len() <= 4096) {
            summary[field] = value.clone();
        }
    }
    summary.to_string().into_bytes()
}

pub(crate) fn atomic_write(directory: &Path, path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = tempfile::Builder::new()
        .prefix(".audit-")
        .tempfile_in(directory)?;
    file.write_all(bytes)?;
    file.persist(path)?;
    Ok(())
}

fn trim_jsonl(path: &Path, now: SystemTime) -> io::Result<()> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => meta,
        Ok(_) => return Err(io::Error::other("invalid diagnostic JSONL path")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if now.duration_since(meta.modified()?).unwrap_or_default() >= REQUESTS.age {
        std::fs::remove_file(path)?;
    } else {
        let mut file = open(path)?;
        let oversized = meta.len() > JSONL_BYTES;
        if !oversized {
            if meta.len() == 0 {
                return Ok(());
            }
            file.seek(SeekFrom::End(-1))?;
            let mut last_byte = [0];
            file.read_exact(&mut last_byte)?;
            if last_byte[0] == b'\n' {
                return Ok(());
            }
        }
        file.seek(SeekFrom::Start(meta.len().saturating_sub(JSONL_BYTES)))?;
        let mut tail = Vec::new();
        (&mut file).take(JSONL_BYTES).read_to_end(&mut tail)?;
        // 丢弃尾窗口首个不完整记录；尾部也只保留已换行的完整记录。
        let first = if oversized {
            tail.iter()
                .position(|b| *b == b'\n')
                .map_or(tail.len(), |i| i + 1)
        } else {
            0
        };
        let last = tail
            .iter()
            .rposition(|b| *b == b'\n')
            .map_or(first, |i| i + 1)
            .max(first);
        if oversized {
            atomic_write(path.parent().unwrap(), path, &tail[first..last])?;
        } else if last < tail.len() {
            file.set_len(last as u64)?;
        }
    }
    Ok(())
}

pub(crate) fn append_jsonl(directory: &Path, value: &serde_json::Value) -> io::Result<()> {
    let path = directory.join("requests.jsonl");
    trim_jsonl(&path, SystemTime::now())?;
    let bytes = encode(value);
    let file = open(&path)?;
    if file
        .metadata()?
        .len()
        .saturating_add(bytes.len() as u64 + 1)
        > JSONL_BYTES
    {
        drop(file);
        let previous = directory.join("requests.jsonl.1");
        if previous.exists() {
            std::fs::remove_file(&previous)?;
        }
        std::fs::rename(&path, previous)?;
    }
    let mut file = open(&path)?;
    file.seek(SeekFrom::End(0))?;
    file.write_all(&bytes)?;
    file.write_all(b"\n")
}

pub(crate) fn sweep_model(directory: &Path, gate: &File, force: bool) -> io::Result<()> {
    let now = SystemTime::now();
    if !force
        && now
            .duration_since(gate.metadata()?.modified()?)
            .unwrap_or_default()
            < Duration::from_secs(60)
    {
        return Ok(());
    }
    let leases = directory.join(".leases");
    if leases.try_exists()? {
        private_dir(&leases)?;
    }
    prune(directory, REQUESTS, now, |path| {
        active(directory, path.file_stem().unwrap().to_str().unwrap())
    })?;
    let errors = directory.join("errors");
    if errors.try_exists()? {
        private_dir(&errors)?;
        prune(&errors, ERRORS, now, |path| {
            active(directory, path.file_stem().unwrap().to_str().unwrap())
        })?;
        for entry in std::fs::read_dir(&errors)? {
            let entry = entry?;
            if entry.file_type()?.is_file()
                && uuid_file(&entry.path(), "json")
                && !directory.join(entry.file_name()).exists()
                && !active(
                    directory,
                    entry.path().file_stem().unwrap().to_str().unwrap(),
                )?
            {
                std::fs::remove_file(entry.path())?;
            }
        }
    }
    for name in ["requests.jsonl", "requests.jsonl.1"] {
        trim_jsonl(&directory.join(name), now)?;
    }
    let leases = directory.join(".leases");
    if leases.try_exists()? {
        private_dir(&leases)?;
        for entry in std::fs::read_dir(&leases)? {
            let entry = entry?;
            if entry.file_type()?.is_file()
                && uuid_file(&entry.path(), "lock")
                && !active(
                    directory,
                    entry.path().file_stem().unwrap().to_str().unwrap(),
                )?
            {
                std::fs::remove_file(entry.path())?;
            }
        }
    }
    stale_temps(directory, now)?;
    if errors.exists() {
        stale_temps(&errors, now)?;
    }
    gate.set_modified(now)
}

fn stale_temps(directory: &Path, now: SystemTime) -> io::Result<()> {
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if entry.file_type()?.is_file()
            && (name.starts_with(".audit-")
                || name.starts_with(".tmp")
                || (name.ends_with(".tmp") && uuid_file(&entry.path(), "tmp")))
            && now
                .duration_since(entry.metadata()?.modified()?)
                .unwrap_or_default()
                >= Duration::from_secs(DAY)
        {
            std::fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

/// 仅回收 Core 非权威诊断；服务宿主每分钟调用，嵌入式调用方可按需调用。
pub fn collect(root: &Path) -> io::Result<()> {
    let mut first_error = None;
    for name in ["model-requests", "model-requests-child", "audit"] {
        let directory = root.join(name);
        let result = (|| -> io::Result<()> {
            if directory.try_exists()? {
                let gate = lock(&directory)?;
                if name == "audit" {
                    prune(&directory, CORE_AUDIT, SystemTime::now(), |_| Ok(false))?;
                    stale_temps(&directory, SystemTime::now())?;
                } else {
                    sweep_model(&directory, &gate, true)?;
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            first_error.get_or_insert(error);
        }
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record(directory: &Path, bytes: usize, age: u64) -> PathBuf {
        let path = directory.join(format!("{}.json", uuid::Uuid::new_v4()));
        std::fs::write(&path, vec![b'x'; bytes]).unwrap();
        File::open(&path)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(age))
            .unwrap();
        path
    }

    #[test]
    fn age_count_and_bytes_keep_newest_and_preserve_unrelated_files() {
        let dir = tempfile::tempdir().unwrap();
        let expired = record(dir.path(), 1, 101);
        let oldest = record(dir.path(), 4, 30);
        let middle = record(dir.path(), 4, 20);
        let newest = record(dir.path(), 4, 10);
        std::fs::write(dir.path().join("user.json"), b"keep").unwrap();
        prune(
            dir.path(),
            Policy {
                age: Duration::from_secs(100),
                count: 2,
                bytes: 7,
            },
            SystemTime::now(),
            |_| Ok(false),
        )
        .unwrap();
        assert!(!expired.exists() && !oldest.exists() && !middle.exists());
        assert!(newest.exists() && dir.path().join("user.json").exists());
        let other = record(dir.path(), 1, 0);
        prune(
            dir.path(),
            Policy {
                age: Duration::from_secs(100),
                count: 1,
                bytes: 100,
            },
            SystemTime::now(),
            |_| Ok(false),
        )
        .unwrap();
        assert!(!newest.exists() && other.exists());
    }

    #[test]
    fn active_requests_survive_then_expire_and_orphans_are_removed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("model-requests-child");
        let gate = lock(&root).unwrap();
        let path = record(&root, 4, 31 * DAY);
        let id = path.file_stem().unwrap().to_str().unwrap();
        let held = lease(&root, id).unwrap();
        private_dir(&root.join("errors")).unwrap();
        let detail = root.join("errors").join(path.file_name().unwrap());
        std::fs::write(&detail, b"error").unwrap();
        File::open(&detail)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(8 * DAY))
            .unwrap();
        let orphan = record(&root.join("errors"), 3, 0);
        let temp = root.join(".audit-crashed");
        std::fs::write(&temp, b"staging").unwrap();
        File::open(&temp)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(2 * DAY))
            .unwrap();
        sweep_model(&root, &gate, true).unwrap();
        assert!(path.exists() && detail.exists());
        assert!(!orphan.exists() && !temp.exists());
        drop(held);
        sweep_model(&root, &gate, true).unwrap();
        assert!(!path.exists() && !detail.exists());
        assert!(!root.join(".leases").join(format!("{id}.lock")).exists());
    }

    #[test]
    fn concurrent_writers_rotate_without_losing_complete_records() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let threads: Vec<_> = (0..4)
            .map(|worker| {
                let root = root.clone();
                std::thread::spawn(move || {
                    for index in 0..50 {
                        let _gate = lock(&root).unwrap();
                        append_jsonl(
                            &root,
                            &json!({"id":worker*50+index,"payload":"x".repeat(64*1024)}),
                        )
                        .unwrap();
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let mut ids = std::collections::BTreeSet::new();
        for name in ["requests.jsonl", "requests.jsonl.1"] {
            let path = root.join(name);
            assert!(std::fs::metadata(&path).unwrap().len() <= JSONL_BYTES);
            for line in std::fs::read_to_string(path).unwrap().lines() {
                let value: serde_json::Value = serde_json::from_str(line).unwrap();
                assert!(ids.insert(value["id"].as_u64().unwrap()));
            }
        }
        assert_eq!(ids.len(), 200);
    }

    #[test]
    fn legacy_jsonl_and_interrupted_append_are_repaired() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("requests.jsonl");
        std::fs::write(
            &path,
            [
                vec![b'x'; JSONL_BYTES as usize],
                b"\n{\"id\":1}\n{partial".to_vec(),
            ]
            .concat(),
        )
        .unwrap();
        let _gate = lock(dir.path()).unwrap();
        append_jsonl(dir.path(), &json!({"id":2})).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\"id\":1}\n{\"id\":2}\n"
        );
        std::fs::write(&path, b"{\"id\":3}\n{partial").unwrap();
        append_jsonl(dir.path(), &json!({"id":4})).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\"id\":3}\n{\"id\":4}\n"
        );
    }

    #[test]
    fn unsafe_paths_do_not_block_other_directories_or_modify_targets() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let sentinel = outside.path().join("retention.lock");
        std::fs::write(&sentinel, b"keep").unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("model-requests")).unwrap();
        let child = dir.path().join("model-requests-child");
        private_dir(&child).unwrap();
        let expired = record(&child, 1, 31 * DAY);
        assert!(collect(dir.path()).is_err());
        assert!(!expired.exists());
        assert_eq!(std::fs::read(&sentinel).unwrap(), b"keep");
        std::os::unix::fs::symlink(outside.path(), child.join(".leases")).unwrap();
        let gate = lock(&child).unwrap();
        assert!(sweep_model(&child, &gate, true).is_err());
        let hardlink = child.join("linked");
        std::fs::hard_link(&sentinel, &hardlink).unwrap();
        assert!(open(&hardlink).is_err());
        assert_eq!(std::fs::read(&sentinel).unwrap(), b"keep");
    }

    #[test]
    fn oversized_record_is_bounded_without_copying_raw_payload() {
        let encoded = encode(
            &json!({"requestId":"r", "outcome":"error", "payload":"x".repeat(MAX_RECORD_BYTES)}),
        );
        assert!(encoded.len() < 4096);
        let value: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(value["auditTruncated"], true);
        assert_eq!(value["requestId"], "r");
        assert!(value.get("payload").is_none());
    }
}
