//! 已压缩历史按不可变分段追加；先同步分段，再提交引用它的当前状态快照。
use super::*;
use areal_protocol::{HistoryArchive, Turn};
mod own;

const MAX_SEGMENT_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
pub(super) struct Segment {
    version: u32,
    pub(super) previous: Option<HistoryArchive>,
    pub(super) turns: Vec<Turn>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) source_thread_ids: Vec<String>,
}

fn segment_path(root: &Path, digest: &str) -> Result<PathBuf> {
    anyhow::ensure!(
        digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit()),
        "invalid history segment ID"
    );
    Ok(root.join("history").join(digest))
}

pub(super) fn read_segment(root: &Path, digest: &str) -> Result<Segment> {
    let path = segment_path(root, digest)?;
    anyhow::ensure!(
        std::fs::metadata(&path)?.len() <= MAX_SEGMENT_BYTES,
        "history segment exceeds size limit"
    );
    let bytes = std::fs::read(path)?;
    anyhow::ensure!(
        format!("{:x}", Sha256::digest(&bytes)) == digest,
        "history segment integrity check failed"
    );
    let segment: Segment = serde_json::from_slice(&bytes)?;
    anyhow::ensure!(segment.version == 1, "unsupported history segment version");
    Ok(segment)
}

fn append_segment(root: &Path, bytes: &[u8]) -> Result<String> {
    use std::io::Write;
    anyhow::ensure!(
        bytes.len() as u64 <= MAX_SEGMENT_BYTES,
        "history segment exceeds size limit"
    );
    let digest = format!("{:x}", Sha256::digest(bytes));
    let path = segment_path(root, &digest)?;
    let directory = root.join("history");
    std::fs::create_dir_all(&directory)?;
    if !path.exists() {
        let mut temporary = tempfile::NamedTempFile::new_in(&directory)?;
        temporary.write_all(bytes)?;
        temporary.as_file().sync_all()?;
        temporary.persist(path)?;
        File::open(&directory)?.sync_all()?;
        File::open(root)?.sync_all()?;
    }
    Ok(digest)
}

fn merge_turns(result: &mut Vec<Turn>, turns: Vec<Turn>) {
    for mut turn in turns {
        if result.last().is_some_and(|old| old.id == turn.id) {
            let mut previous = result.pop().unwrap().items;
            previous.append(&mut turn.items);
            turn.items = previous;
        }
        result.push(turn);
    }
}

pub(super) fn hydrate(root: &Path, thread: &mut Thread) -> Result<()> {
    let mut cursor = thread.history_archive.clone();
    let mut segments = Vec::new();
    let mut visited = std::collections::HashSet::new();
    while let Some(reference) = cursor {
        anyhow::ensure!(
            visited.insert(reference.head.clone()),
            "cyclic history archive"
        );
        let segment = read_segment(root, &reference.head)?;
        cursor = segment.previous;
        segments.push(segment.turns);
    }
    let mut turns = Vec::new();
    for segment in segments.into_iter().rev() {
        merge_turns(&mut turns, segment);
    }
    merge_turns(&mut turns, std::mem::take(&mut thread.turns));
    thread.turns = turns;
    thread.history_archive = None;
    Ok(())
}

pub(super) fn visit_segments(
    root: &Path,
    reference: Option<HistoryArchive>,
    seen: &mut std::collections::BTreeSet<String>,
    mut visit: impl FnMut(&[Turn]) -> Result<()>,
) -> Result<()> {
    let mut cursor = reference;
    while let Some(reference) = cursor {
        if !seen.insert(reference.head.clone()) {
            break;
        }
        let segment = read_segment(root, &reference.head)?;
        visit(&segment.turns)?;
        cursor = segment.previous;
    }
    Ok(())
}

struct AcceptedTurnInputs {
    turn_id: String,
    previous: Option<String>,
    found: bool,
    initial_message_is_control: bool,
    messages: Vec<Vec<areal_protocol::Input>>,
    input: Vec<areal_protocol::Input>,
}

impl AcceptedTurnInputs {
    fn new(turn_id: String) -> Self {
        Self {
            turn_id,
            previous: None,
            found: false,
            initial_message_is_control: false,
            messages: Vec::new(),
            input: Vec::new(),
        }
    }

    fn flush(&mut self) {
        if self.initial_message_is_control {
            self.messages.pop();
        }
        self.input.extend(self.messages.drain(..).rev().flatten());
    }

    fn scan(&mut self, turns: &[Turn]) -> bool {
        for turn in turns.iter().rev() {
            if turn.id != self.turn_id && self.found {
                self.flush();
                let Some(previous) = self.previous.take() else {
                    return true;
                };
                self.turn_id = previous;
                self.found = false;
            }
            if turn.id != self.turn_id {
                continue;
            }
            self.found = true;
            self.previous = turn.continued_from_turn_id.clone();
            self.initial_message_is_control = self.previous.is_some()
                || turn
                    .goal
                    .as_ref()
                    .is_some_and(|goal| goal.origin == "continuation");
            for item in turn.items.iter().rev() {
                if let Item::UserMessage { content, .. } = item {
                    self.messages.push(content.clone());
                }
            }
        }
        false
    }

    fn finish(mut self) -> Result<Vec<areal_protocol::Input>> {
        anyhow::ensure!(
            self.found && self.previous.is_none(),
            "accepted input origin is missing"
        );
        self.flush();
        Ok(self.input)
    }
}

impl Store {
    pub(crate) async fn write_fork_snapshot(
        &self,
        turns: Vec<Turn>,
        source_thread_ids: Vec<String>,
        max_bytes: usize,
    ) -> Result<(String, usize)> {
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || {
            anyhow::ensure!(
                turns.len() == source_thread_ids.len(),
                "fork snapshot provenance mismatch"
            );
            let bytes = serde_json::to_vec(&Segment {
                version: 1,
                previous: None,
                turns,
                source_thread_ids,
            })?;
            let size = bytes.len();
            anyhow::ensure!(size <= max_bytes, "fork snapshot exceeds history limit");
            Ok((append_segment(&root, &bytes)?, size))
        })
        .await?
    }

    pub(crate) fn read_fork_snapshot(&self, snapshot_id: &str) -> Result<Vec<Turn>> {
        let segment = read_segment(&self.root, snapshot_id)?;
        anyhow::ensure!(
            segment.previous.is_none(),
            "fork snapshot contains archive chain"
        );
        anyhow::ensure!(
            segment.source_thread_ids.len() == segment.turns.len(),
            "fork snapshot provenance mismatch"
        );
        Ok(segment.turns)
    }
    pub(crate) fn read_fork_snapshot_with_sources(
        &self,
        snapshot_id: &str,
    ) -> Result<(Vec<Turn>, Vec<String>)> {
        let segment = read_segment(&self.root, snapshot_id)?;
        anyhow::ensure!(
            segment.previous.is_none(),
            "fork snapshot contains archive chain"
        );
        anyhow::ensure!(
            segment.source_thread_ids.len() == segment.turns.len(),
            "fork snapshot provenance mismatch"
        );
        Ok((segment.turns, segment.source_thread_ids))
    }
    pub(crate) async fn fork_snapshot_page<T, F>(
        &self,
        snapshot: String,
        page: F,
    ) -> crate::Result<T>
    where
        T: Send + 'static,
        F: FnOnce(Vec<Turn>, Vec<String>) -> crate::Result<T> + Send + 'static,
    {
        let permit = self
            .fork_reads
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| crate::Error::Storage(e.to_string()))?;
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let segment =
                read_segment(&root, &snapshot).map_err(|e| crate::Error::Storage(e.to_string()))?;
            if segment.previous.is_some() || segment.source_thread_ids.len() != segment.turns.len()
            {
                return Err(crate::Error::Storage(
                    "fork snapshot provenance mismatch".into(),
                ));
            }
            page(segment.turns, segment.source_thread_ids)
        })
        .await
        .map_err(|e| crate::Error::Storage(e.to_string()))?
    }
    pub(crate) async fn history_page(
        &self,
        thread: &Thread,
        before: Option<String>,
        limit: usize,
    ) -> Result<serde_json::Value> {
        anyhow::ensure!(
            (1..=16).contains(&limit),
            "history page limit must be 1..16"
        );
        let root = self.root.clone();
        let turns = thread.turns.clone();
        let mut cursor = thread.history_archive.clone();
        tokio::task::spawn_blocking(move || {
            let mut entries = Vec::new();
            let mut found = before.is_none();
            let mut scan = |turns: &[Turn]| -> Result<bool> {
                for turn in turns.iter().rev() {
                    for item in turn.items.iter().rev() {
                        if !found { found = before.as_deref() == Some(item.id()); continue; }
                        let value = serde_json::to_value(item)?;
                        let text = serde_json::to_string(item)?;
                        entries.push(serde_json::json!({"itemId":item.id(),"turnId":turn.id,"type":value["type"],"preview":crate::tools::prefix(&text,384)}));
                        if entries.len() > limit { return Ok(true); }
                    }
                }
                Ok(false)
            };
            let mut done = scan(&turns)?;
            let mut visited = std::collections::HashSet::new();
            while !done {
                let Some(reference) = cursor else { break; };
                anyhow::ensure!(visited.insert(reference.head.clone()), "cyclic history archive");
                let segment = read_segment(&root, &reference.head)?;
                done = scan(&segment.turns)?;
                cursor = segment.previous;
            }
            anyhow::ensure!(found, "history cursor is not in this thread");
            let more = entries.len() > limit;
            entries.truncate(limit);
            let next = more.then(|| entries.last().unwrap()["itemId"].clone());
            Ok(serde_json::json!({"items":entries,"nextBefore":next,"order":"newestFirst"}))
        }).await?
    }

    pub(crate) async fn hydrate(&self, mut thread: Thread) -> Result<Thread> {
        if thread.history_archive.is_none() {
            return Ok(thread);
        }
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || {
            hydrate(&root, &mut thread)?;
            Ok(thread)
        })
        .await?
    }

    pub(crate) async fn archive_prefix(&self, thread: &mut Thread, count: usize) -> Result<()> {
        if count == 0 {
            return Ok(());
        }
        let mut remaining = count;
        let mut prefix = Vec::new();
        let mut tail = Vec::new();
        let last = thread.turns.len().saturating_sub(1);
        let mut removed_turns = 0;
        for (index, turn) in thread.turns.iter().enumerate() {
            if remaining == 0 {
                tail.push(turn.clone());
                continue;
            }
            let take = remaining.min(turn.items.len());
            if take > 0 || turn.items.is_empty() {
                let mut part = turn.clone();
                part.items.truncate(take);
                // 未知副作用仍需人工核验，不能被摘要和冷历史隐藏。
                anyhow::ensure!(!part.items.iter().any(|item| matches!(item, Item::DynamicToolCall { execution, .. }
                    if execution.outcome == ToolOutcome::Running || execution.hooks.iter().any(|h| h.outcome == ToolOutcome::Running) || (execution.inspection.is_none() && (execution.outcome == ToolOutcome::Unknown || execution.hooks.iter().any(|h| h.outcome == ToolOutcome::Unknown))))), "unresolved tool cannot be archived");
                prefix.push(part);
                remaining -= take;
            }
            if take < turn.items.len() || index == last {
                let mut part = turn.clone();
                part.items = part.items.into_iter().skip(take).collect();
                tail.push(part);
            } else {
                removed_turns += 1;
            }
        }
        anyhow::ensure!(
            remaining == 0,
            "history archive boundary exceeds current items"
        );
        let through_item_id = prefix
            .last()
            .and_then(|turn| turn.items.last())
            .context("empty archive prefix")?
            .id()
            .to_owned();
        let previous = thread.history_archive.clone();
        let bytes = serde_json::to_vec(&Segment {
            version: 1,
            previous: previous.clone(),
            turns: prefix,
            source_thread_ids: Vec::new(),
        })?;
        let size = bytes.len() as u64;
        let root = self.root.clone();
        let head = tokio::task::spawn_blocking(move || append_segment(&root, &bytes)).await??;
        thread.history_archive = Some(HistoryArchive {
            head,
            through_item_id,
            completed_turns: previous.as_ref().map_or(0, |p| p.completed_turns) + removed_turns,
            items: previous.as_ref().map_or(0, |p| p.items) + count as u64,
            bytes: previous.as_ref().map_or(0, |p| p.bytes) + size,
        });
        thread.turns = tail;
        Ok(())
    }

    pub(crate) async fn accepted_turn_inputs(
        &self,
        thread: &Thread,
    ) -> Result<Vec<areal_protocol::Input>> {
        let Some(current) = thread.turns.last() else {
            return Ok(Vec::new());
        };
        let mut accepted = AcceptedTurnInputs::new(current.id.clone());
        if accepted.scan(&thread.turns) || thread.history_archive.is_none() {
            return accepted.finish();
        }
        let mut cursor = thread.history_archive.clone();
        let root = self.root.clone();
        let permit = self.fork_reads.clone().acquire_owned().await?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let mut seen = std::collections::HashSet::new();
            while let Some(reference) = cursor {
                anyhow::ensure!(
                    seen.insert(reference.head.clone()),
                    "cyclic history archive"
                );
                let segment = read_segment(&root, &reference.head)?;
                if accepted.scan(&segment.turns) {
                    break;
                }
                cursor = segment.previous;
            }
            accepted.finish()
        })
        .await?
    }

    pub(crate) async fn history_item(&self, thread: &Thread, id: &str) -> Result<Option<Item>> {
        if let Some(history_seed) = thread.model_history_seed()
            && let Some(item) = self
                .read_fork_snapshot(&history_seed.snapshot_id)?
                .into_iter()
                .flat_map(|turn| turn.items.into_iter())
                .find(|item| item.id() == id)
        {
            return Ok(Some(item));
        }
        if let Some(item) = thread
            .turns
            .iter()
            .flat_map(|t| &t.items)
            .find(|item| item.id() == id)
        {
            return Ok(Some(item.clone()));
        }
        let root = self.root.clone();
        let id = id.to_owned();
        let mut cursor = thread.history_archive.clone();
        tokio::task::spawn_blocking(move || {
            let mut visited = std::collections::HashSet::new();
            while let Some(reference) = cursor {
                anyhow::ensure!(
                    visited.insert(reference.head.clone()),
                    "cyclic history archive"
                );
                let segment = read_segment(&root, &reference.head)?;
                if let Some(item) = segment
                    .turns
                    .into_iter()
                    .flat_map(|t| t.items)
                    .find(|item| item.id() == id)
                {
                    return Ok(Some(item));
                }
                cursor = segment.previous;
            }
            Ok(None)
        })
        .await?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn thread() -> Thread {
        let id = uuid::Uuid::new_v4().to_string();
        serde_json::from_value(json!({
            "id":id,"sessionId":id,"preview":"archive fixture","modelProvider":"fixture",
            "createdAt":1,"updatedAt":1,"status":{"type":"idle"},"cwd":"/fixture",
            "cliVersion":"test","source":"appServer","ephemeral":false,"turns":[]
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn segments_restore_split_turns_page_originals_and_keep_blobs() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        let blob = store
            .save_blob("text/plain".into(), b"original evidence".to_vec())
            .await
            .unwrap();
        let mut hot = thread();
        for n in 0..3 {
            hot.turns.push(serde_json::from_value(json!({"id":format!("turn{n}"),"status":"completed","items":[
                {"type":"userMessage","id":format!("user{n}"),"content":[{"type":"text","text":format!("original {n}")}]},
                {"type":"modelContext","id":format!("context{n}"),"value":{"reference":blob.uri}},
                {"type":"agentMessage","id":format!("answer{n}"),"text":"recorded"}
            ]})).unwrap());
        }
        let original = serde_json::to_value(&hot).unwrap();
        store.archive_prefix(&mut hot, 2).await.unwrap();
        store.archive_prefix(&mut hot, 5).await.unwrap();
        assert_eq!(hot.turns.len(), 1);
        assert_eq!(hot.turns[0].items.len(), 2);
        assert_eq!(hot.history_archive.as_ref().unwrap().items, 7);
        store
            .save_encoded(&hot.id, encode(&hot).unwrap())
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(store.read_thread(&hot.id).await.unwrap()).unwrap(),
            original
        );
        let mut cursor = None;
        let mut ids = Vec::new();
        loop {
            let page = store.history_page(&hot, cursor, 2).await.unwrap();
            ids.extend(
                page["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|i| i["itemId"].as_str().unwrap().to_owned()),
            );
            cursor = page["nextBefore"].as_str().map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(
            ids,
            [
                "answer2", "context2", "user2", "answer1", "context1", "user1", "answer0",
                "context0", "user0"
            ]
        );
        assert!(store.history_item(&hot, "user0").await.unwrap().is_some());
        assert!(
            store
                .history_item(&thread(), "user0")
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .history_page(&hot, Some("foreign".into()), 2)
                .await
                .is_err()
        );
        store.collect_blobs().await.unwrap();
        assert!(
            directory
                .path()
                .join("blobs")
                .join(blob.uri.rsplit('/').next().unwrap())
                .exists()
        );
        drop(store);
        let store = Store::open(directory.path()).unwrap();
        let restored = store.load(1, 0).unwrap().pop().unwrap();
        assert_eq!(
            serde_json::to_value(store.hydrate(restored).await.unwrap()).unwrap(),
            original
        );
        let head = hot.history_archive.as_ref().unwrap().head.clone();
        std::fs::write(directory.path().join("history").join(head), b"corrupt").unwrap();
        assert!(store.load(1, 0).is_err());
    }

    #[tokio::test]
    async fn unresolved_effects_cannot_move_out_of_hot_state() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        for outcome in ["running", "unknown"] {
            let mut hot = thread();
            hot.turns.push(serde_json::from_value(json!({"id":"turn","status":"failed","items":[
                {"type":"dynamicToolCall","id":"tool","tool":"write","arguments":{},"callId":"call","status":"completed",
                    "execution":{"runtimeEpoch":"epoch","scopeId":"scope","operationId":"operation","outcome":outcome}}
            ]})).unwrap());
            assert!(store.archive_prefix(&mut hot, 1).await.is_err());
            assert!(hot.history_archive.is_none());
            assert_eq!(hot.turns[0].items.len(), 1);
        }
    }
    #[tokio::test]
    async fn snapshot_pages_bound_blocking_work_without_blocking_control() {
        let root = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(root.path()).unwrap());
        let (snapshot, _) = store
            .write_fork_snapshot(vec![], vec![], 1024)
            .await
            .unwrap();
        let gate = Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
        let (entered_tx, mut entered_rx) = tokio::sync::mpsc::unbounded_channel();
        let mut tasks = Vec::new();
        for index in 0..3 {
            let store = store.clone();
            let snapshot = snapshot.clone();
            let gate = gate.clone();
            let entered_tx = entered_tx.clone();
            tasks.push(tokio::spawn(async move {
                store
                    .fork_snapshot_page(snapshot, move |_, _| {
                        entered_tx.send(index).unwrap();
                        let (lock, ready) = &*gate;
                        let mut released = lock.lock().unwrap();
                        while !*released {
                            released = ready.wait(released).unwrap();
                        }
                        Ok(index)
                    })
                    .await
            }));
        }
        let mut cancelled = usize::MAX;
        let observed = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            cancelled = entered_rx.recv().await.unwrap();
            entered_rx.recv().await.unwrap();
            // 接收任务取消不能提前释放仍在运行的 blocking 工作所持名额。
            tasks[cancelled].abort();
            tokio::time::timeout(std::time::Duration::from_millis(100), entered_rx.recv())
                .await
                .is_err()
        })
        .await;
        // 无论断言结果如何先释放本测试拥有的 blocking 任务。
        let (lock, ready) = &*gate;
        *lock.lock().unwrap() = true;
        ready.notify_all();
        for (index, task) in tasks.into_iter().enumerate() {
            let result = task.await;
            if index == cancelled {
                assert!(result.unwrap_err().is_cancelled());
            } else {
                result.unwrap().unwrap();
            }
        }
        assert!(
            observed.unwrap_or(false),
            "snapshot reads must leave the async executor responsive and admit at most two blocking jobs"
        );
    }
}
