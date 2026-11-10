//! 持久会话的固定只读投影；不打开 Store、不执行恢复、不创建 Runtime。
use super::{CachedOwnHistoryEntry, Record, STATE_VERSION, archive};
use anyhow::{Context, Result, ensure};
use areal_protocol::{Thread, TurnStatus};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::OpenOptions,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

pub const MAX_BYTES: usize = 64 * 1024 * 1024;

pub struct PersistedConversation {
    thread: Thread,
    digest: String,
    cache: Mutex<Option<Arc<CachedOwnHistoryEntry>>>,
}

fn stamp(metadata: &std::fs::Metadata) -> (u64, u64, u64, i64, i64, i64, i64) {
    (
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        metadata.mtime(),
        metadata.mtime_nsec(),
        metadata.ctime(),
        metadata.ctime_nsec(),
    )
}

/// 调用方持有原服务与 Store 锁；拒绝符号链接、超限和读取期间的替换。
fn read_file(root: &Path, relative: &Path, maximum: usize) -> Result<Vec<u8>> {
    ensure!(
        relative
            .components()
            .all(|part| matches!(part, std::path::Component::Normal(_))),
        "invalid snapshot path"
    );
    let path = root.join(relative);
    let parent = path.parent().context("snapshot parent missing")?;
    ensure!(
        root.canonicalize()? == root && parent.canonicalize()? == parent,
        "snapshot path changed"
    );
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&path)?;
    let before = file.metadata()?;
    ensure!(
        before.is_file()
            && before.uid() == unsafe { libc::geteuid() }
            && before.mode() & 0o022 == 0,
        "untrusted snapshot file"
    );
    ensure!(before.len() <= maximum as u64, "PERSISTED_HISTORY_LIMIT");
    let mut bytes = Vec::new();
    (&mut file)
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= maximum
            && stamp(&file.metadata()?) == stamp(&before)
            && stamp(&std::fs::symlink_metadata(&path)?) == stamp(&before),
        "snapshot changed during read"
    );
    Ok(bytes)
}

impl PersistedConversation {
    pub fn read(root: &Path, workspace: &Path, id: &str) -> Result<Self> {
        ensure!(uuid::Uuid::parse_str(id).is_ok(), "invalid thread ID");
        let bytes = read_file(root, Path::new(&format!("{id}.json")), MAX_BYTES)?;
        let mut record: Record = serde_json::from_slice(&bytes)?;
        ensure!(
            (1..=STATE_VERSION).contains(&record.version)
                && record.thread.id == id
                && Path::new(&record.thread.cwd).canonicalize()? == workspace,
            "PERSISTED_HISTORY_IDENTITY_MISMATCH"
        );
        let mut used = bytes.len();
        let mut hash = Sha256::new();
        hash.update(&bytes);
        let mut cursor = record.thread.history_archive.clone();
        let mut seen = BTreeSet::new();
        let mut segments = Vec::new();
        while let Some(reference) = cursor {
            ensure!(
                seen.len() < 1024 && seen.insert(reference.head.clone()),
                "invalid or excessive archive chain"
            );
            ensure!(
                reference.head.len() == 64
                    && reference.head.bytes().all(|byte| byte.is_ascii_hexdigit()),
                "invalid history digest"
            );
            let bytes = read_file(
                root,
                &PathBuf::from("history").join(&reference.head),
                MAX_BYTES - used,
            )?;
            used += bytes.len();
            hash.update(&bytes);
            let segment = archive::decode_segment(&bytes, &reference.head)?;
            cursor = segment.previous;
            segments.push(segment.turns);
        }
        let mut turns = Vec::new();
        for segment in segments.into_iter().rev() {
            archive::merge_turns(&mut turns, segment);
        }
        archive::merge_turns(&mut turns, std::mem::take(&mut record.thread.turns));
        record.thread.turns = turns;
        record.thread.history_archive = None;
        Ok(Self {
            thread: record.thread,
            digest: format!("{:x}", hash.finalize()),
            cache: Mutex::new(None),
        })
    }
    pub fn snapshot_id(&self) -> &str {
        &self.digest
    }
    pub fn thread(&self) -> &Thread {
        &self.thread
    }
    pub fn snapshot(&self, maximum: usize) -> crate::Result<Value> {
        let mut metadata = self.thread.clone();
        metadata.turns.clear();
        metadata.context_checkpoint = None;
        if let Some(desktop) = metadata.desktop.as_mut() {
            desktop.receipts.clear();
        }
        let empty_active = self
            .thread
            .turns
            .last()
            .filter(|turn| turn.status == TurnStatus::InProgress && turn.items.is_empty())
            .cloned();
        archive::own::page(
            Path::new(""),
            &self.thread,
            &self.digest,
            None,
            maximum,
            Some(json!({"cwd":metadata.cwd,"thread":metadata})),
            empty_active,
            true,
            &self.cache,
        )
    }
    pub fn history(&self, cursor: Option<String>, maximum: usize) -> crate::Result<Value> {
        archive::own::page(
            Path::new(""),
            &self.thread,
            &self.digest,
            cursor,
            maximum,
            None,
            None,
            false,
            &self.cache,
        )
    }
    pub fn blob(&self, root: &Path, uri: &str) -> Result<Vec<u8>> {
        let digest = uri
            .strip_prefix("areal://blob/")
            .context("invalid blob URI")?;
        ensure!(
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
            "invalid blob digest"
        );
        let bytes = read_file(root, &PathBuf::from("blobs").join(digest), 16 * 1024 * 1024)?;
        ensure!(
            format!("{:x}", Sha256::digest(&bytes)) == digest,
            "blob integrity check failed"
        );
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn persisted_history_keeps_original_status_archive_and_bytes_without_store_open() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        std::fs::create_dir(root.join("history")).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let old = json!({"id":"old","status":"completed","items":[{"type":"agentMessage","id":"old-message","text":"archived"}]});
        let segment =
            serde_json::to_vec(&json!({"version":1,"turns":[old],"previous":null})).unwrap();
        let digest = format!("{:x}", Sha256::digest(&segment));
        let old_path = root.join("history").join(&digest);
        std::fs::write(&old_path, &segment).unwrap();
        let record = json!({"version":17,"thread":{"id":id,"sessionId":id,"parentThreadId":null,"preview":"fixture","modelProvider":"fixture","createdAt":1,"updatedAt":2,"status":{"type":"active","activeFlags":[]},"cwd":root,"cliVersion":"fixture","source":"cli","ephemeral":false,"historyArchive":{"head":digest,"throughItemId":"old-message","completedTurns":1,"items":1,"bytes":segment.len()},"turns":[{"id":"pending","status":"inProgress","items":[{"type":"agentMessage","id":"pending-message","text":"not settled"}]}]}});
        let path = root.join(format!("{id}.json"));
        let bytes = serde_json::to_vec(&record).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        for path in [&path, &old_path] {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let snapshot = PersistedConversation::read(&root, &root, &id).unwrap();
        assert_eq!(snapshot.thread().turns.len(), 2);
        assert_eq!(snapshot.thread().turns[1].status, TurnStatus::InProgress);
        let visible = snapshot.snapshot(128 * 1024).unwrap();
        assert_eq!(visible["thread"]["turns"][1]["status"], "inProgress");
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert!(!root.join("owner.lock").exists());
        std::fs::write(&path, b"changed after snapshot").unwrap();
        assert_eq!(snapshot.snapshot(128 * 1024).unwrap(), visible);
        std::fs::write(&path, &bytes).unwrap();
        let mut large = record.clone();
        large["thread"]["turns"][0]["items"][0]["text"] = json!("分段历史".repeat(5000));
        std::fs::write(&path, serde_json::to_vec(&large).unwrap()).unwrap();
        let large_snapshot = PersistedConversation::read(&root, &root, &id).unwrap();
        let baseline = large_snapshot.snapshot(4096).unwrap();
        assert!(serde_json::to_vec(&baseline).unwrap().len() <= 4096);
        let deferred = &baseline["thread"]["turns"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["items"][0];
        assert_eq!(deferred["type"], "historyDeferred");
        let initial_cursor = deferred["cursor"].as_str().unwrap().to_owned();
        assert!(
            snapshot
                .history(Some(initial_cursor.clone()), 4096)
                .is_err(),
            "cursor must bind the immutable source snapshot"
        );
        let mut cursor = Some(initial_cursor);
        let mut decoded = String::new();
        while let Some(next) = cursor {
            let page = large_snapshot.history(Some(next), 4096).unwrap();
            assert!(serde_json::to_vec(&page).unwrap().len() <= 4096);
            decoded.push_str(page["data"][0]["fragment"]["text"].as_str().unwrap());
            cursor = page["nextCursor"].as_str().map(str::to_owned);
        }
        let entry: Value = serde_json::from_str(&decoded).unwrap();
        assert_eq!(
            entry["item"]["text"],
            large["thread"]["turns"][0]["items"][0]["text"]
        );
        let link = root.join("linked.json");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(read_file(&root, Path::new("linked.json"), MAX_BYTES).is_err());
        assert!(
            read_file(&root, Path::new(&format!("{id}.json")), 10)
                .unwrap_err()
                .to_string()
                .contains("PERSISTED_HISTORY_LIMIT")
        );
        std::fs::write(&path, &bytes).unwrap();
        std::fs::write(&old_path, b"corrupted").unwrap();
        assert!(PersistedConversation::read(&root, &root, &id).is_err());
    }
}
