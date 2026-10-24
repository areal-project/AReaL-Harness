use super::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

const ROOT_BYTES: usize = 1024 * 1024;
const FILE_BYTES: usize = 256 * 1024 * 1024;
const PAGE_BYTES: usize = 131072;
const INDEX_BYTES: usize = 2048;
const INDEX_ROWS: usize = 64;
const INDEX_PACK_BYTES: usize = 128 * 1024;

#[cfg(feature = "test-support")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskCommitFault {
    BeforeLeaf,
    AfterLeaf,
    BeforeRoot,
    AfterRootReplace,
    AfterRootSync,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Catalog {
    version: u32,
    tasks: BTreeMap<String, TaskHead>,
    receipts: BTreeMap<u8, IndexRef>,
    bindings: BTreeMap<u8, IndexRef>,
    index_version: u32,
    preparations: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TaskHead {
    body: String,
    hot_bytes: usize,
    history: Option<String>,
    history_segments: u64,
    archived_count: u64,
    usage: GoalUsage,
    settlement_limit: usize,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct History {
    version: u32,
    task_id: String,
    previous: Option<String>,
    pub(super) runs: Vec<TaskRun>,
    messages: Vec<ChannelMessage>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct IndexRef {
    digest: String,
    leaf: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, bound(deserialize = "T: Deserialize<'de>"))]
struct IndexLeaf<T> {
    version: u32,
    prefix: String,
    #[serde(deserialize_with = "index_rows")]
    rows: Vec<(String, T)>,
    children: EmptyChildren,
}
fn index_rows<'de, D, T>(decoder: D) -> std::result::Result<Vec<(String, T)>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    struct Rows<T>(std::marker::PhantomData<T>);
    impl<'de, T: Deserialize<'de>> serde::de::Visitor<'de> for Rows<T> {
        type Value = Vec<(String, T)>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            write!(f, "at most {INDEX_ROWS} Task index rows")
        }
        fn visit_seq<S: serde::de::SeqAccess<'de>>(
            self,
            mut sequence: S,
        ) -> std::result::Result<Self::Value, S::Error> {
            let mut rows = Vec::with_capacity(sequence.size_hint().unwrap_or(0).min(INDEX_ROWS));
            for _ in 0..INDEX_ROWS {
                let Some(row) = sequence.next_element()? else {
                    return Ok(rows);
                };
                rows.push(row);
            }
            struct ExcessRow;
            impl<'de> Deserialize<'de> for ExcessRow {
                fn deserialize<D: serde::Deserializer<'de>>(
                    _: D,
                ) -> std::result::Result<Self, D::Error> {
                    Err(serde::de::Error::custom(
                        "Task index leaf exceeds row limit",
                    ))
                }
            }
            sequence.next_element::<ExcessRow>()?;
            Ok(rows)
        }
    }
    decoder.deserialize_seq(Rows(std::marker::PhantomData))
}
struct EmptyChildren;
impl<'de> Deserialize<'de> for EmptyChildren {
    fn deserialize<D: serde::Deserializer<'de>>(decoder: D) -> std::result::Result<Self, D::Error> {
        struct Empty;
        impl<'de> serde::de::Visitor<'de> for Empty {
            type Value = EmptyChildren;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("an empty leaf child map")
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut map: M,
            ) -> std::result::Result<EmptyChildren, M::Error> {
                if map.next_key::<serde::de::IgnoredAny>()?.is_some() {
                    return Err(serde::de::Error::custom("leaf cannot have children"));
                }
                Ok(EmptyChildren)
            }
        }
        decoder.deserialize_map(Empty)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, bound(deserialize = "T: Deserialize<'de>"))]
struct IndexNode<T> {
    version: u32,
    prefix: String,
    #[serde(deserialize_with = "index_rows")]
    rows: Vec<(String, T)>,
    children: BTreeMap<u8, IndexRef>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    task_id: String,
    run_id: String,
    segment: String,
}

fn storage(error: impl ToString) -> Error {
    Error::Storage(error.to_string())
}
fn key(id: &str) -> String {
    format!("{:x}", Sha256::digest(id.as_bytes()))
}
fn receipt_key(owner: &str, method: &str, request: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(owner, method, request)).unwrap())
    )
}
fn binding_key(kind: &str, id: &str) -> String {
    receipt_key("binding", kind, id)
}
fn bucket(key: &str) -> u8 {
    u8::from_str_radix(&key[..2], 16).unwrap()
}
fn nibble(key: &str, position: usize) -> u8 {
    (key.as_bytes()[position] as char).to_digit(16).unwrap() as u8
}
fn add_usage(total: &mut GoalUsage, usage: &GoalUsage) {
    total.input_tokens = total.input_tokens.saturating_add(usage.input_tokens);
    total.cached_input_tokens = total
        .cached_input_tokens
        .saturating_add(usage.cached_input_tokens);
    total.output_tokens = total.output_tokens.saturating_add(usage.output_tokens);
    total.tokens_used = total.tokens_used.saturating_add(usage.tokens_used);
    total.reserved_tokens = total.reserved_tokens.saturating_add(usage.reserved_tokens);
    total.unknown_requests = total
        .unknown_requests
        .saturating_add(usage.unknown_requests);
    total.time_used_seconds += usage.time_used_seconds;
    total.turns_started = total.turns_started.saturating_add(usage.turns_started);
    total.accounting_complete &= usage.accounting_complete;
}

impl Snapshot {
    fn read_leaf<T: serde::de::DeserializeOwned>(&self, digest: &str) -> Result<T> {
        self.read_leaf_limited(digest, FILE_BYTES)
    }
    fn read_leaf_limited<T: serde::de::DeserializeOwned>(
        &self,
        digest: &str,
        limit: usize,
    ) -> Result<T> {
        let path = self.leaf_path(digest)?;
        use std::{io::Read, os::unix::fs::OpenOptionsExt};
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(
                (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32,
            )
            .open(path)
            .map_err(storage)?;
        let metadata = file.metadata().map_err(storage)?;
        if !metadata.is_file() || metadata.len() > limit as u64 {
            return Err(storage("task ledger leaf exceeds read limit"));
        }
        let mut bytes = Vec::new();
        file.take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(storage)?;
        if bytes.len() > limit {
            return Err(storage("task ledger leaf exceeds read limit"));
        }
        if format!("{:x}", Sha256::digest(&bytes)) != digest {
            return Err(storage("task ledger checksum mismatch"));
        }
        serde_json::from_slice(&bytes).map_err(storage)
    }

    fn leaf_path(&self, digest: &str) -> Result<std::path::PathBuf> {
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(storage("invalid task ledger reference"));
        }
        Ok(self.root.join("desktop/task-ledger").join(digest))
    }

    #[cfg(feature = "test-support")]
    fn check_fault(&self, phase: TaskCommitFault) -> Result<()> {
        let mut fault = self.fault.lock().unwrap();
        if *fault == Some(phase) {
            *fault = None;
            return Err(storage(format!("injected Task commit failure {phase:?}")));
        }
        Ok(())
    }

    fn write_leaf(&self, value: &impl Serialize) -> Result<String> {
        let bytes = serde_json::to_vec(value).map_err(storage)?;
        if bytes.len() > FILE_BYTES {
            return Err(storage("task ledger leaf exceeds read limit"));
        }
        #[cfg(feature = "test-support")]
        self.check_fault(TaskCommitFault::BeforeLeaf)?;
        let digest =
            crate::store::write_immutable_staged(&self.root.join("desktop/task-ledger"), &bytes)
                .map_err(storage)?;
        #[cfg(feature = "test-support")]
        self.check_fault(TaskCommitFault::AfterLeaf)?;
        Ok(digest)
    }

    pub(super) fn open(root: &Path, store: &crate::store::Store) -> anyhow::Result<Self> {
        let path = root.join("desktop/task-mode.json");
        if !path.exists() {
            return Ok(Self {
                version: 5,
                root: root.into(),
                catalog: Catalog {
                    version: 5,
                    index_version: 3,
                    ..Default::default()
                },
                ..Default::default()
            });
        }
        let metadata = std::fs::symlink_metadata(&path)?;
        anyhow::ensure!(
            metadata.is_file() && metadata.len() <= MAX_BYTES as u64,
            "task store exceeds capacity"
        );
        let bytes = std::fs::read(&path)?;
        let header: Value = serde_json::from_slice(&bytes)?;
        if header["version"] == 4 || header["version"] == 5 {
            let upgrading = header["version"] == 4;
            if upgrading {
                crate::store::write_immutable(&root.join("desktop/task-legacy"), &bytes)?;
            }
            let mut state = Self::read_current_catalog(root, &bytes, usize::MAX)?
                .ok_or_else(|| anyhow::anyhow!("Task hot-state exceeds read budget"))?;
            if let Some(digest) = &state.catalog.preparations {
                state.preparations = state.read_leaf(digest)?;
            }
            state.validate_and_sync()?;
            let previous = state.clone();
            state.compact(&state.archiveable_ids(store, None), None)?;
            if upgrading
                || serde_json::to_value(&state.tasks)? != serde_json::to_value(&previous.tasks)?
                || state.preparations.len() != previous.preparations.len()
            {
                state.persist(Some(&previous), None)?;
            }
            Ok(state)
        } else {
            let mut state: Self = serde_json::from_slice(&bytes)?;
            anyhow::ensure!(
                matches!(state.version, 1..=3) && state.tasks.len() <= MAX_TASKS,
                "unsupported task store"
            );
            state.root = root.into();
            state.catalog.version = 5;
            state.catalog.index_version = 3;
            crate::store::write_immutable(&root.join("desktop/task-legacy"), &bytes)?;
            state.restore_runs();
            state.version = 5;
            state.compact(&state.archiveable_ids(store, None), None)?;
            state.persist(None, None)?;
            Ok(state)
        }
    }

    pub(super) fn read_current_catalog(
        root: &Path,
        bytes: &[u8],
        hot_budget: usize,
    ) -> anyhow::Result<Option<Self>> {
        anyhow::ensure!(bytes.len() <= ROOT_BYTES, "task catalog exceeds capacity");
        let catalog: Catalog = serde_json::from_slice(bytes)?;
        anyhow::ensure!(matches!(catalog.version, 4 | 5), "unsupported task store");
        anyhow::ensure!(catalog.index_version == 3, "unsupported Task index version");
        anyhow::ensure!(
            catalog.tasks.len() <= MAX_TASKS
                && catalog.receipts.len() <= 256
                && catalog.bindings.len() <= 256,
            "task catalog exceeds capacity"
        );
        let mut state = Self {
            version: 5,
            root: root.into(),
            catalog,
            ..Default::default()
        };
        if !state.catalog.tasks.is_empty() {
            let directory = std::fs::symlink_metadata(root.join("desktop/task-ledger"))?;
            anyhow::ensure!(
                directory.is_dir() && !directory.file_type().is_symlink(),
                "invalid Task ledger directory"
            );
        }
        let mut total = 0usize;
        for head in state.catalog.tasks.values() {
            let metadata = std::fs::symlink_metadata(state.leaf_path(&head.body)?)?;
            anyhow::ensure!(
                metadata.is_file()
                    && metadata.len() <= FILE_BYTES as u64
                    && metadata.len() == head.hot_bytes as u64
                    && head.settlement_limit >= head.hot_bytes
                    && head.settlement_limit <= FILE_BYTES,
                "invalid Task hot-state bounds"
            );
            total = total.saturating_add(head.hot_bytes);
        }
        if total > hot_budget {
            return Ok(None);
        }
        for (task_key, head) in &state.catalog.tasks {
            let task: Task = state.read_leaf(&head.body)?;
            anyhow::ensure!(key(&task.id) == *task_key, "task ledger identity mismatch");
            state.tasks.insert(task.id.clone(), task);
        }
        Ok(Some(state))
    }

    pub(super) fn visit_history(
        &self,
        task_id: &str,
        mut visit: impl FnMut(&History) -> Result<()>,
    ) -> Result<()> {
        self.visit_history_refs(task_id, |segment, _| visit(segment))
    }
    fn visit_history_refs(
        &self,
        task_id: &str,
        mut visit: impl FnMut(&History, &str) -> Result<()>,
    ) -> Result<()> {
        let head = self.catalog.tasks.get(&key(task_id));
        let mut cursor = head.and_then(|h| h.history.clone());
        let mut remaining = head.map_or(0, |h| h.history_segments);
        while let Some(digest) = cursor {
            if remaining == 0 {
                return Err(storage("Task history exceeds committed segment count"));
            }
            remaining -= 1;
            let segment: History = self.read_leaf(&digest)?;
            if segment.version != 1 || segment.task_id != task_id {
                return Err(storage("task history identity mismatch"));
            }
            visit(&segment, &digest)?;
            cursor = segment.previous;
        }
        if remaining != 0 {
            return Err(storage(
                "Task history is shorter than committed segment count",
            ));
        }
        Ok(())
    }

    fn validate_and_sync(&self) -> Result<()> {
        let directory = self.root.join("desktop/task-ledger");
        let sync = |digest: &str| -> Result<()> {
            std::fs::File::open(directory.join(digest))
                .and_then(|f| f.sync_all())
                .map_err(storage)
        };
        for task in self.tasks.values() {
            let head = &self.catalog.tasks[&key(&task.id)];
            sync(&head.body)?;
            self.visit_history_refs(&task.id, |_, digest| sync(digest))?;
        }
        for (&bucket, head) in &self.catalog.receipts {
            self.visit_index::<RequestReceipt>(head, None, sync, |row, key| {
                if receipt_key(&row.identity, &row.method, &row.request_id) != key
                    || self::bucket(key) != bucket
                {
                    return Err(storage("receipt index identity mismatch"));
                }
                Ok(())
            })?;
        }
        for (&bucket, head) in &self.catalog.bindings {
            self.visit_index::<Binding>(head, None, sync, |row, key| {
                let run = self.binding_run(row)?;
                if self::bucket(key) != bucket
                    || !(binding_key("run", &run.id) == key
                        || run
                            .goal_id
                            .as_ref()
                            .is_some_and(|goal| binding_key("goal", goal) == key))
                {
                    return Err(storage("Run binding identity mismatch"));
                }
                sync(&row.segment)
            })?;
        }
        if let Some(digest) = &self.catalog.preparations {
            sync(digest)?;
        }
        std::fs::File::open(self.root.join("desktop/task-mode.json"))
            .and_then(|f| f.sync_all())
            .map_err(storage)?;
        for path in [directory, self.root.join("desktop"), self.root.clone()] {
            std::fs::File::open(path)
                .and_then(|f| f.sync_all())
                .map_err(storage)?;
        }
        Ok(())
    }

    fn write_index<T: Serialize>(&self, node: &IndexNode<T>) -> Result<IndexRef> {
        let bytes = serde_json::to_vec(node).map_err(storage)?.len();
        if node.rows.is_empty() && bytes > INDEX_BYTES {
            return Err(storage("Task index branch exceeds decode bound"));
        }
        if node.rows.len() > INDEX_ROWS || node.rows.len() > 1 && bytes > INDEX_PACK_BYTES {
            return Err(storage("Task index leaf exceeds pack bound"));
        }
        Ok(IndexRef {
            digest: self.write_leaf(node)?,
            leaf: !node.rows.is_empty(),
        })
    }

    fn index_node<T: serde::de::DeserializeOwned + Serialize>(
        &self,
        reference: &IndexRef,
        parent: Option<(&str, u8)>,
    ) -> Result<IndexNode<T>> {
        let node: IndexNode<T> = if reference.leaf {
            let leaf: IndexLeaf<T> = self.read_leaf(&reference.digest)?;
            let _ = leaf.children;
            IndexNode {
                version: leaf.version,
                prefix: leaf.prefix,
                rows: leaf.rows,
                children: BTreeMap::new(),
            }
        } else {
            self.read_leaf_limited(&reference.digest, INDEX_BYTES)?
        };
        if node.rows.is_empty() == reference.leaf {
            return Err(storage("Task index reference kind mismatch"));
        }
        if node.version != 2
            || node.prefix.len() < 2
            || node.prefix.len() > 64
            || !node
                .prefix
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || reference.leaf
                && (!node.children.is_empty()
                    || node.rows.iter().any(|(key, _)| {
                        key.len() != 64
                            || !key.starts_with(&node.prefix)
                            || !key
                                .bytes()
                                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    })
                    || node.rows.windows(2).any(|rows| rows[0].0 >= rows[1].0))
            || !reference.leaf
                && (node.prefix.len() == 64
                    || !(2..=16).contains(&node.children.len())
                    || node.children.keys().any(|n| *n > 15))
        {
            return Err(storage("invalid Task index node"));
        }
        if node.rows.len() > 1
            && serde_json::to_vec(&node).map_err(storage)?.len() > INDEX_PACK_BYTES
        {
            return Err(storage("Task index leaf exceeds pack bound"));
        }
        if parent.is_some_and(|(prefix, edge)| {
            node.prefix.len() <= prefix.len()
                || !node.prefix.starts_with(prefix)
                || nibble(&node.prefix, prefix.len()) != edge
        }) {
            return Err(storage("Task index path mismatch"));
        }
        Ok(node)
    }
    fn visit_index<T: serde::de::DeserializeOwned + Serialize>(
        &self,
        reference: &IndexRef,
        parent: Option<(&str, u8)>,
        mut visit_file: impl FnMut(&str) -> Result<()>,
        mut visit_row: impl FnMut(&T, &str) -> Result<()>,
    ) -> Result<()> {
        fn walk<T: serde::de::DeserializeOwned + Serialize>(
            state: &Snapshot,
            reference: &IndexRef,
            parent: Option<(&str, u8)>,
            visit_file: &mut impl FnMut(&str) -> Result<()>,
            visit_row: &mut impl FnMut(&T, &str) -> Result<()>,
        ) -> Result<()> {
            let node = state.index_node::<T>(reference, parent)?;
            visit_file(&reference.digest)?;
            for (key, row) in &node.rows {
                visit_row(row, key)?;
            }
            for (edge, child) in &node.children {
                walk(
                    state,
                    child,
                    Some((&node.prefix, *edge)),
                    visit_file,
                    visit_row,
                )?;
            }
            Ok(())
        }
        walk(self, reference, parent, &mut visit_file, &mut visit_row)
    }
    fn index_get<T: serde::de::DeserializeOwned + Serialize>(
        &self,
        heads: &BTreeMap<u8, IndexRef>,
        key: &str,
    ) -> Result<Option<T>> {
        let Some(mut cursor) = heads.get(&bucket(key)).cloned() else {
            return Ok(None);
        };
        let mut parent: Option<(String, u8)> = None;
        for _ in 0..64 {
            let mut node =
                self.index_node::<T>(&cursor, parent.as_ref().map(|(p, e)| (p.as_str(), *e)))?;
            if self::bucket(&node.prefix) != bucket(key) {
                return Err(storage("Task index bucket mismatch"));
            }
            if !key.starts_with(&node.prefix) {
                return Ok(None);
            }
            if cursor.leaf {
                return Ok(node
                    .rows
                    .binary_search_by(|(candidate, _)| candidate.as_str().cmp(key))
                    .ok()
                    .map(|position| node.rows.swap_remove(position).1));
            }
            let edge = nibble(key, node.prefix.len());
            let Some(child) = node.children.get(&edge) else {
                return Ok(None);
            };
            cursor = child.clone();
            parent = Some((node.prefix, edge));
        }
        Err(storage("Task index depth exceeds key width"))
    }
    fn index_insert<T: serde::de::DeserializeOwned + Serialize + Clone>(
        &self,
        head: Option<&IndexRef>,
        key: &str,
        row: T,
    ) -> Result<IndexRef> {
        let Some(head) = head else {
            return self.index_build(&[(key.into(), row)]);
        };
        let mut node = self.index_node::<T>(head, None)?;
        if head.leaf {
            match node
                .rows
                .binary_search_by(|(candidate, _)| candidate.as_str().cmp(key))
            {
                Ok(position) => {
                    if serde_json::to_value(&node.rows[position].1).map_err(storage)?
                        != serde_json::to_value(&row).map_err(storage)?
                    {
                        return Err(storage("Task index key collision"));
                    }
                    return Ok(head.clone());
                }
                Err(position) => node.rows.insert(position, (key.into(), row)),
            }
            return self.index_build(&node.rows);
        }
        let common = node
            .prefix
            .bytes()
            .zip(key.bytes())
            .take_while(|(a, b)| a == b)
            .count();
        if common < 2 {
            return Err(storage("Task index bucket mismatch"));
        }
        if common < node.prefix.len() {
            let new = self.index_insert(None, key, row)?;
            return self.write_index(&IndexNode::<T> {
                version: 2,
                prefix: key[..common].into(),
                rows: Vec::new(),
                children: BTreeMap::from([
                    (nibble(&node.prefix, common), head.clone()),
                    (nibble(key, common), new),
                ]),
            });
        }
        let edge = nibble(key, node.prefix.len());
        let next = self.index_insert(node.children.get(&edge), key, row)?;
        node.children.insert(edge, next);
        self.write_index(&node)
    }
    fn index_build<T: Serialize + Clone>(&self, rows: &[(String, T)]) -> Result<IndexRef> {
        if rows.is_empty()
            || rows.iter().any(|(key, _)| {
                key.len() != 64
                    || !key
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
            || rows.windows(2).any(|rows| rows[0].0 >= rows[1].0)
        {
            return Err(storage("invalid or duplicate Task index key"));
        }
        let common = rows[0]
            .0
            .bytes()
            .zip(rows.last().unwrap().0.bytes())
            .take_while(|(a, b)| a == b)
            .count();
        if common < 2 {
            return Err(storage("Task index bucket mismatch"));
        }
        if rows.len() <= INDEX_ROWS {
            let leaf = IndexNode {
                version: 2,
                prefix: rows[0].0[..common].into(),
                rows: rows.to_vec(),
                children: BTreeMap::new(),
            };
            if rows.len() == 1
                || serde_json::to_vec(&leaf).map_err(storage)?.len() <= INDEX_PACK_BYTES
            {
                return self.write_index(&leaf);
            }
        }
        let mut children = BTreeMap::new();
        let mut start = 0;
        while start < rows.len() {
            let edge = nibble(&rows[start].0, common);
            let mut end = start + 1;
            while end < rows.len() && nibble(&rows[end].0, common) == edge {
                end += 1;
            }
            children.insert(edge, self.index_build(&rows[start..end])?);
            start = end;
        }
        self.write_index(&IndexNode::<T> {
            version: 2,
            prefix: rows[0].0[..common].into(),
            rows: Vec::new(),
            children,
        })
    }
    pub(super) fn stored_receipt(
        &self,
        owner: &str,
        method: &str,
        request: &str,
    ) -> Result<Option<RequestReceipt>> {
        let row = self.index_get::<RequestReceipt>(
            &self.catalog.receipts,
            &receipt_key(owner, method, request),
        )?;
        if row.as_ref().is_some_and(|row| {
            row.identity != owner || row.method != method || row.request_id != request
        }) {
            return Err(storage("Task receipt identity collision"));
        }
        Ok(row)
    }

    pub(super) fn old_receipt(
        &self,
        owner: &str,
        method: &str,
        request: &str,
        hash: &str,
    ) -> Result<Option<Value>> {
        let Some(row) = self.stored_receipt(owner, method, request)? else {
            return Ok(None);
        };
        if row.digest != hash {
            return Err(Error::Conflict);
        }
        Ok(Some(row.result))
    }
    fn binding_run(&self, binding: &Binding) -> Result<TaskRun> {
        if !self.tasks.contains_key(&binding.task_id) {
            return Err(storage("Task binding owner missing"));
        }
        let segment: History = self.read_leaf(&binding.segment)?;
        if segment.version != 1 || segment.task_id != binding.task_id {
            return Err(storage("Task binding segment mismatch"));
        }
        segment
            .runs
            .into_iter()
            .find(|run| run.id == binding.run_id)
            .ok_or_else(|| storage("Task binding Run missing"))
    }
    pub(super) fn cold_run(
        &self,
        goal_id: Option<&str>,
        run_id: Option<&str>,
    ) -> Result<Option<(String, TaskRun)>> {
        let mut found = None;
        for (kind, id) in [("goal", goal_id), ("run", run_id)] {
            let Some(id) = id else {
                continue;
            };
            if let Some(binding) =
                self.index_get::<Binding>(&self.catalog.bindings, &binding_key(kind, id))?
            {
                let run = self.binding_run(&binding)?;
                if kind == "goal" && run.goal_id.as_deref() != Some(id)
                    || kind == "run" && run.id != id
                {
                    return Err(storage("Task binding identity collision"));
                }
                if found
                    .as_ref()
                    .is_some_and(|(task, prior): &(String, TaskRun)| {
                        *task != binding.task_id || prior.id != run.id
                    })
                {
                    return Err(storage("ambiguous Task binding"));
                }
                found = Some((binding.task_id, run));
            }
        }
        Ok(found)
    }

    pub(super) fn visible(
        &self,
        task_id: &str,
        allowed: Option<&BTreeSet<String>>,
    ) -> Result<bool> {
        let task = self.tasks.get(task_id).ok_or(Error::NotFound)?;
        let Some(allowed) = allowed else {
            return Ok(true);
        };
        if task
            .thread_id
            .as_ref()
            .is_none_or(|id| !allowed.contains(id))
        {
            return Ok(false);
        }
        let mut visible = task
            .runs
            .iter()
            .all(|r| r.thread_id.as_ref().is_none_or(|id| allowed.contains(id)));
        self.visit_history(task_id, |segment| {
            visible &= segment
                .runs
                .iter()
                .all(|r| r.thread_id.as_ref().is_none_or(|id| allowed.contains(id)));
            Ok(())
        })?;
        Ok(visible)
    }

    pub(super) fn count(&self, task_id: &str) -> u64 {
        self.catalog
            .tasks
            .get(&key(task_id))
            .map_or(0, |h| h.archived_count)
    }

    pub(super) fn usage(&self, task_id: &str) -> GoalUsage {
        let mut usage = self.catalog.tasks.get(&key(task_id)).map_or_else(
            || GoalUsage {
                accounting_complete: true,
                ..Default::default()
            },
            |h| h.usage.clone(),
        );
        if let Some(task) = self.tasks.get(task_id) {
            for run in &task.runs {
                add_usage(&mut usage, &run.usage);
            }
        }
        usage
    }

    pub(super) fn message_exists(&self, task_id: &str, id: &str) -> Result<bool> {
        let task = self.tasks.get(task_id).ok_or(Error::NotFound)?;
        if task.messages.iter().any(|message| message.id == id) {
            return Ok(true);
        }
        let mut found = false;
        self.visit_history(task_id, |segment| {
            found |= segment.messages.iter().any(|message| message.id == id);
            Ok(())
        })?;
        Ok(found)
    }

    pub(super) fn message_page(
        &self,
        task_id: &str,
        after: u64,
        limit: usize,
        run_id: Option<&str>,
        recent: bool,
    ) -> Result<(Vec<ChannelMessage>, bool)> {
        let task = self.tasks.get(task_id).ok_or(Error::NotFound)?;
        let mut rows: BTreeMap<(u64, String), ChannelMessage> = BTreeMap::new();
        let mut add = |message: &ChannelMessage| {
            if message.sequence <= after || run_id.is_some_and(|id| message.run_id != id) {
                return;
            }
            let key = (message.sequence, message.id.clone());
            rows.insert(key, message.clone());
            if rows.len() > limit + 1 {
                if recent {
                    rows.pop_first();
                } else {
                    rows.pop_last();
                }
            }
        };
        for message in &task.messages {
            add(message);
        }
        self.visit_history(task_id, |segment| {
            for message in &segment.messages {
                add(message);
            }
            Ok(())
        })?;
        let more = rows.len() > limit;
        let mut rows: Vec<_> = rows.into_values().collect();
        if recent {
            rows.reverse();
        }
        rows.truncate(limit);
        Ok((rows, more))
    }

    pub(super) fn archiveable_ids(
        &self,
        store: &crate::store::Store,
        only: Option<&str>,
    ) -> HashSet<String> {
        let mut eligible = HashSet::new();
        let mut inspections = 0;
        for task in self
            .tasks
            .values()
            .filter(|task| only.is_none_or(|id| task.id == id))
        {
            let count = task.runs.len().saturating_sub(MAX_RUNS);
            let start = if count == 0 {
                0
            } else {
                task.revision as usize % count
            };
            for offset in 0..count {
                let run = &task.runs[(start + offset) % count];
                if !run.status.terminal()
                    || !(run.usage.accounting_complete
                        || run.goal_id.is_none()
                            && run.usage.tokens_used == 0
                            && run.usage.turns_started == 0)
                    || run.usage.reserved_tokens != 0
                    || run.usage.unknown_requests != 0
                    || run.workers.iter().any(|w| !w.settled)
                    || task
                        .messages
                        .iter()
                        .any(|m| m.run_id == run.id && m.status == "pending")
                {
                    continue;
                }
                if only.is_some() && inspections >= 16 {
                    break;
                }
                let mut safe = true;
                for thread_id in run.thread_id.iter().chain(
                    run.workers
                        .iter()
                        .map(|w| &w.thread_id)
                        .filter(|id| !id.is_empty()),
                ) {
                    if only.is_some() && inspections >= 16 {
                        safe = false;
                        break;
                    }
                    inspections += 1;
                    let Ok(thread) = store.read_thread_snapshot_sync(
                        thread_id,
                        64 * 1024 * 1024,
                        only.is_none(),
                    ) else {
                        safe = false;
                        break;
                    };
                    if thread.goals.goal.as_ref().is_some_and(|g|run.goal_id.as_ref()==Some(&g.id) && (g.status==GoalStatus::Active || g.active_turn_id.is_some() || g.settling))
                        || thread.turns.iter().any(|turn|turn.status==TurnStatus::InProgress)
                        || thread.desktop.as_ref().is_some_and(|d|d.interactions.iter().any(|i|i.status=="pending"))
                        || thread.turns.iter().any(|t| t.items.iter().any(|i|matches!(i,Item::DynamicToolCall {execution,..} if execution.inspection.is_none() && (matches!(execution.outcome,areal_protocol::ToolOutcome::Unknown|areal_protocol::ToolOutcome::Running) || execution.hooks.iter().any(|h|matches!(h.outcome,areal_protocol::ToolOutcome::Unknown|areal_protocol::ToolOutcome::Running)))))) {safe=false;break;}
                }
                if safe {
                    eligible.insert(run.id.clone());
                }
            }
        }
        eligible
    }

    pub(super) fn compact(&mut self, eligible: &HashSet<String>, only: Option<&str>) -> Result<()> {
        let consumed: HashSet<_> = self
            .tasks
            .values()
            .flat_map(|t| t.runs.iter())
            .filter(|r| r.goal_id.is_some() || r.status.terminal())
            .map(|r| r.id.clone())
            .collect();
        let mut bindings: BTreeMap<u8, Vec<(String, Binding)>> = BTreeMap::new();
        let ids: Vec<_> = self
            .tasks
            .keys()
            .filter(|id| only.is_none_or(|only| id.as_str() == only))
            .cloned()
            .collect();
        for task_id in ids {
            let mut head = self
                .catalog
                .tasks
                .get(&key(&task_id))
                .cloned()
                .unwrap_or_else(|| TaskHead {
                    body: String::new(),
                    hot_bytes: 0,
                    history: None,
                    history_segments: 0,
                    archived_count: 0,
                    usage: GoalUsage {
                        accounting_complete: true,
                        ..Default::default()
                    },
                    settlement_limit: 0,
                });
            let task = self.tasks.get_mut(&task_id).unwrap();
            let archive_count = task.runs.len().saturating_sub(MAX_RUNS);
            let mut runs = Vec::new();
            let mut position = 0;
            task.runs.retain(|run| {
                let archive = position < archive_count && eligible.contains(&run.id);
                position += 1;
                if archive {
                    runs.push(run.clone());
                }
                !archive
            });
            let archive_count = task.messages.len().saturating_sub(MAX_MESSAGES);
            let mut position = 0;
            let mut messages = Vec::new();
            task.messages.retain(|message| {
                let archive = position < archive_count && message.status != "pending";
                position += 1;
                if archive {
                    messages.push(message.clone());
                }
                !archive
            });
            for run in &runs {
                add_usage(&mut head.usage, &run.usage);
            }
            head.archived_count = head.archived_count.saturating_add(runs.len() as u64);
            if !runs.is_empty() || !messages.is_empty() {
                let archived = runs.clone();
                let digest = self.write_leaf(&History {
                    version: 1,
                    task_id: task_id.clone(),
                    previous: head.history,
                    runs,
                    messages,
                })?;
                for run in archived {
                    let binding = Binding {
                        task_id: task_id.clone(),
                        run_id: run.id.clone(),
                        segment: digest.clone(),
                    };
                    for (kind, id) in [
                        ("run", Some(run.id.as_str())),
                        ("goal", run.goal_id.as_deref()),
                    ] {
                        if let Some(id) = id {
                            let key = binding_key(kind, id);
                            let bucket = bucket(&key);
                            bindings
                                .entry(bucket)
                                .or_default()
                                .push((key, binding.clone()));
                        }
                    }
                }
                head.history = Some(digest);
                head.history_segments = head
                    .history_segments
                    .checked_add(1)
                    .ok_or_else(|| storage("Task history count overflow"))?;
            }
            let task = self.tasks.get_mut(&task_id).unwrap();
            task.archived_run_count = head.archived_count;
            task.run_count = head.archived_count + task.runs.len() as u64;
            task.runs_complete = head.archived_count == 0;
            self.catalog.tasks.insert(key(&task_id), head);
        }
        for (bucket, mut rows) in bindings {
            let head = if let Some(head) = self.catalog.bindings.get(&bucket) {
                let mut head = head.clone();
                for (key, row) in rows {
                    head = self.index_insert(Some(&head), &key, row)?;
                }
                head
            } else {
                rows.sort_by(|a, b| a.0.cmp(&b.0));
                self.index_build(&rows)?
            };
            self.catalog.bindings.insert(bucket, head);
        }
        self.preparations.retain(|id, _| !consumed.contains(id));
        Ok(())
    }

    pub(super) fn persist(
        &mut self,
        previous: Option<&Snapshot>,
        changed: Option<&str>,
    ) -> Result<()> {
        std::fs::create_dir_all(self.root.join("desktop/task-ledger")).map_err(storage)?;
        for task in self
            .tasks
            .values_mut()
            .filter(|task| changed.is_none_or(|id| task.id == id))
        {
            let count = self
                .catalog
                .tasks
                .get(&key(&task.id))
                .map_or(0, |head| head.archived_count);
            task.archived_run_count = count;
            task.run_count = count + task.runs.len() as u64;
            task.runs_complete = count == 0;
        }
        let task_bytes: BTreeMap<_, _> = self
            .tasks
            .iter()
            .filter(|(id, _)| changed.is_none_or(|only| id.as_str() == only))
            .map(|(id, t)| Ok((id.clone(), serde_json::to_vec(t).map_err(storage)?)))
            .collect::<Result<_>>()?;
        let preparation_bytes = serde_json::to_vec(&self.preparations).map_err(storage)?;
        let total: usize = task_bytes
            .values()
            .map(Vec::len)
            .sum::<usize>()
            .saturating_add(
                self.tasks
                    .keys()
                    .filter(|id| !task_bytes.contains_key(*id))
                    .map(|id| self.catalog.tasks.get(&key(id)).map_or(0, |h| h.hot_bytes))
                    .sum::<usize>(),
            )
            .saturating_add(preparation_bytes.len());
        let growth_blocked = total > MAX_BYTES;
        for (id, bytes) in &task_bytes {
            let task = &self.tasks[id];
            let previous_head = previous.and_then(|s| s.catalog.tasks.get(&key(id)));
            let settlement = previous
                .and_then(|s| s.tasks.get(id))
                .is_some_and(|old| settlement_only(old, task));
            if growth_blocked
                && previous.is_some()
                && (!settlement || previous_head.is_none_or(|h| bytes.len() > h.settlement_limit))
            {
                return Err(Error::Exhausted("task hot-state capacity reached; settle or cancel existing work before adding work".into()));
            }
            let digest = self.write_leaf(task)?;
            let limit = if growth_blocked && previous.is_some() {
                previous_head.unwrap().settlement_limit
            } else {
                settlement_limit(task, bytes.len())
            };
            let head = self
                .catalog
                .tasks
                .entry(key(id))
                .or_insert_with(|| TaskHead {
                    body: String::new(),
                    hot_bytes: 0,
                    history: None,
                    history_segments: 0,
                    archived_count: 0,
                    usage: GoalUsage {
                        accounting_complete: true,
                        ..Default::default()
                    },
                    settlement_limit: 0,
                });
            head.body = digest;
            head.hot_bytes = bytes.len();
            head.settlement_limit = limit;
        }
        if growth_blocked
            && previous.is_some_and(|old| {
                serde_json::to_value(&old.preparations).ok()
                    != serde_json::to_value(&self.preparations).ok()
            })
            && self.preparations.iter().any(|(id, p)| {
                previous.is_none_or(|old| {
                    old.preparations
                        .get(id)
                        .and_then(|v| serde_json::to_value(v).ok())
                        != serde_json::to_value(p).ok()
                })
            })
        {
            return Err(Error::Exhausted("task preparation capacity reached".into()));
        }
        let mut buckets: BTreeMap<u8, Vec<(String, RequestReceipt)>> = BTreeMap::new();
        for row in std::mem::take(&mut self.receipts) {
            let key = receipt_key(&row.identity, &row.method, &row.request_id);
            buckets.entry(bucket(&key)).or_default().push((key, row));
        }
        for (bucket, mut rows) in buckets {
            let head = if let Some(head) = self.catalog.receipts.get(&bucket) {
                let mut head = head.clone();
                for (key, row) in rows {
                    head = self.index_insert(Some(&head), &key, row)?;
                }
                head
            } else {
                rows.sort_by(|a, b| a.0.cmp(&b.0));
                self.index_build(&rows)?
            };
            self.catalog.receipts.insert(bucket, head);
        }
        self.catalog.preparations = if self.preparations.is_empty() {
            None
        } else {
            let digest = format!("{:x}", Sha256::digest(&preparation_bytes));
            if self.catalog.preparations.as_ref() == Some(&digest) {
                Some(digest)
            } else {
                Some(self.write_leaf(&self.preparations)?)
            }
        };
        self.catalog.version = 5;
        let bytes = serde_json::to_vec(&self.catalog).map_err(storage)?;
        if bytes.len() > ROOT_BYTES {
            return Err(storage("task catalog exceeds proven bound"));
        }
        for directory in [
            self.root.join("desktop/task-ledger"),
            self.root.join("desktop"),
            self.root.clone(),
        ] {
            std::fs::File::open(directory)
                .and_then(|f| f.sync_all())
                .map_err(storage)?;
        }
        #[cfg(feature = "test-support")]
        self.check_fault(TaskCommitFault::BeforeRoot)?;
        crate::store::write_metadata_after_replace(
            &self.root.join("desktop"),
            "task-mode",
            &bytes,
            || {
                #[cfg(feature = "test-support")]
                self.check_fault(TaskCommitFault::AfterRootReplace)
                    .map_err(|e| anyhow::anyhow!(e))?;
                Ok(())
            },
        )
        .map_err(storage)?;
        #[cfg(feature = "test-support")]
        self.check_fault(TaskCommitFault::AfterRootSync)?;
        Ok(())
    }
}

fn settlement_limit(task: &Task, bytes: usize) -> usize {
    let workers = task.runs.iter().map(|r| r.workers.len()).sum::<usize>();
    bytes
        .saturating_add((task.runs.len() + workers + 1).saturating_mul(262144))
        .saturating_add(task.messages.len().saturating_mul(512))
        .min(FILE_BYTES)
}

fn settlement_only(old: &Task, new: &Task) -> bool {
    let mut left = serde_json::to_value(old).unwrap();
    let mut right = serde_json::to_value(new).unwrap();
    for field in [
        "revision",
        "channelSequence",
        "paused",
        "cancelled",
        "deletedAt",
        "nextRunAt",
        "skippedRuns",
        "lastSkippedAt",
        "lastTriggerDecision",
        "runCount",
        "archivedRunCount",
        "runsComplete",
    ] {
        left.as_object_mut().unwrap().remove(field);
        right.as_object_mut().unwrap().remove(field);
    }
    for value in [&mut left, &mut right] {
        value.as_object_mut().unwrap().remove("runs");
        value.as_object_mut().unwrap().remove("messages");
    }
    if left != right {
        return false;
    }
    for run in &new.runs {
        let Some(prior) = old.runs.iter().find(|r| r.id == run.id) else {
            return false;
        };
        if run.thread_id != prior.thread_id
            || run.goal_id != prior.goal_id
            || serde_json::to_value(&run.accepted_schedule).ok()
                != serde_json::to_value(&prior.accepted_schedule).ok()
            || run.objective != prior.objective
            || run.scheduled_at != prior.scheduled_at
            || run.workers.len() != prior.workers.len()
            || run.reason.as_ref().is_some_and(|r| r.len() > 65536)
        {
            return false;
        }
        for (worker, prior) in run.workers.iter().zip(&prior.workers) {
            if worker.thread_id != prior.thread_id
                || worker.turn_id != prior.turn_id
                || worker.execution != prior.execution
                || worker.execution_id != prior.execution_id
                || worker.status.len() > 128
            {
                return false;
            }
        }
    }
    for message in &new.messages {
        if let Some(prior) = old.messages.iter().find(|m| m.id == message.id) {
            let mut a = serde_json::to_value(prior).unwrap();
            let mut b = serde_json::to_value(message).unwrap();
            for field in ["status", "sequence"] {
                a.as_object_mut().unwrap().remove(field);
                b.as_object_mut().unwrap().remove(field);
            }
            if a != b || message.status.len() > 128 {
                return false;
            }
        } else if !matches!(message.kind.as_str(), "report" | "workerReport")
            || message.status != "published"
            || !old.runs.iter().any(|r| r.id == message.run_id)
            || serde_json::to_vec(message).map_or(true, |b| b.len() > 65536)
        {
            return false;
        }
    }
    let reports: Vec<_> = new
        .messages
        .iter()
        .filter(|m| !old.messages.iter().any(|prior| prior.id == m.id))
        .collect();
    for run in &old.runs {
        let Some(next) = new.runs.iter().find(|next| next.id == run.id) else {
            continue;
        };
        let terminal_reports = reports
            .iter()
            .filter(|m| m.run_id == run.id && m.kind == "report")
            .count();
        if terminal_reports
            > usize::from(
                run.completed_at.is_none() && next.completed_at.is_some() && next.status.terminal(),
            )
        {
            return false;
        }
        let worker_reports = reports
            .iter()
            .filter(|m| m.run_id == run.id && m.kind == "workerReport")
            .count();
        let settlements = run
            .workers
            .iter()
            .zip(&next.workers)
            .filter(|(a, b)| !a.settled && b.settled)
            .count();
        let ready = reports
            .iter()
            .filter(|m| {
                m.run_id == run.id
                    && m.id.ends_with(":delivery-ready")
                    && run.workers.iter().any(|w| {
                        w.execution_id
                            .as_ref()
                            .is_some_and(|id| m.id == format!("{id}:delivery-ready"))
                    })
            })
            .count();
        if worker_reports > settlements + ready {
            return false;
        }
    }
    true
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RunCursor {
    task_id: String,
    upper: (i64, String),
    before: (i64, String),
}

impl Engine {
    pub async fn task_read_for_threads(
        &self,
        task_id: &str,
        allowed: Option<&BTreeSet<String>>,
    ) -> Result<Task> {
        let state = self.task_modes.state.lock().await.clone();
        if !state.visible(task_id, allowed)? {
            return Err(invalid("TASK_PERMISSION_DENIED"));
        }
        state.tasks.get(task_id).cloned().ok_or(Error::NotFound)
    }
    pub async fn task_list_for_threads(
        &self,
        allowed: Option<&BTreeSet<String>>,
    ) -> Result<Vec<Task>> {
        let state = self.task_modes.state.lock().await.clone();
        let mut tasks = Vec::new();
        for task in state.tasks.values() {
            if state.visible(&task.id, allowed)? {
                tasks.push(task.clone());
            }
        }
        Ok(tasks)
    }
    pub fn task_projection(task: &Task) -> Value {
        summary(task)
    }
    #[cfg(feature = "test-support")]
    pub async fn set_task_commit_fault(&self, fault: TaskCommitFault) {
        *self.task_modes.state.lock().await.fault.lock().unwrap() = Some(fault);
    }
    pub async fn task_visible(
        &self,
        task_id: &str,
        allowed: Option<&BTreeSet<String>>,
    ) -> Result<bool> {
        let state = self.task_modes.state.lock().await.clone();
        state.visible(task_id, allowed)
    }
    pub async fn task_summary(&self, task_id: &str) -> Result<Value> {
        self.task_summary_for_threads(task_id, None).await
    }
    pub async fn task_summary_for_threads(
        &self,
        task_id: &str,
        allowed: Option<&BTreeSet<String>>,
    ) -> Result<Value> {
        let state = self.task_modes.state.lock().await.clone();
        if !state.visible(task_id, allowed)? {
            return Err(invalid("TASK_PERMISSION_DENIED"));
        }
        let task = state.tasks.get(task_id).ok_or(Error::NotFound)?;
        Ok(summary(task))
    }
    pub async fn task_runs_list(&self, request: TaskRunsList) -> Result<TaskRunsPage> {
        self.task_runs_list_for_threads(request, None).await
    }
    pub async fn task_runs_list_for_threads(
        &self,
        request: TaskRunsList,
        allowed: Option<&BTreeSet<String>>,
    ) -> Result<TaskRunsPage> {
        let state = self.task_modes.state.lock().await.clone();
        if !state.visible(&request.task_id, allowed)? {
            return Err(invalid("TASK_PERMISSION_DENIED"));
        }
        let task = state.tasks.get(&request.task_id).ok_or(Error::NotFound)?;
        let limit = request.limit.unwrap_or(30);
        if !(1..=100).contains(&limit) {
            return Err(invalid("limit must be 1..100"));
        }
        let cursor: Option<RunCursor> = request
            .cursor
            .map(|c| {
                if c.len() > 4096 {
                    return Err(invalid("invalid Run cursor"));
                }
                serde_json::from_str(&c).map_err(invalid)
            })
            .transpose()?;
        if cursor.as_ref().is_some_and(|c| c.task_id != task.id) {
            return Err(invalid("Run cursor belongs to another Task"));
        }
        let ordering = |r: &TaskRun| (r.scheduled_at, r.id.clone());
        let mut upper = cursor.as_ref().map(|c| c.upper.clone());
        let mut rows: BTreeMap<(i64, String), TaskRun> = BTreeMap::new();
        let mut add = |run: &TaskRun| {
            let key = ordering(run);
            if upper.as_ref().is_none_or(|u| &key <= u)
                && cursor.as_ref().is_none_or(|c| key < c.before)
            {
                rows.insert(key, run.clone());
                if rows.len() > limit + 1 {
                    rows.pop_first();
                }
            }
        };
        for run in &task.runs {
            add(run);
        }
        state.visit_history(&task.id, |segment| {
            for run in &segment.runs {
                add(run);
            }
            Ok(())
        })?;
        if upper.is_none() {
            upper = rows.keys().next_back().cloned();
        }
        let mut data = Vec::new();
        let mut bytes = 0;
        let mut has_more = false;
        for (_, run) in rows.into_iter().rev() {
            let size = serde_json::to_vec(&run).map_err(invalid)?.len();
            if data.len() == limit || bytes + size > PAGE_BYTES {
                if data.is_empty() {
                    return Err(Error::Exhausted("TaskRun exceeds response capacity".into()));
                }
                has_more = true;
                break;
            }
            bytes += size;
            data.push(run);
        }
        let next_cursor = if has_more {
            Some(
                serde_json::to_string(&RunCursor {
                    task_id: task.id.clone(),
                    upper: upper.unwrap(),
                    before: ordering(data.last().unwrap()),
                })
                .map_err(invalid)?,
            )
        } else {
            None
        };
        Ok(TaskRunsPage {
            data,
            next_cursor,
            has_more,
            run_count: task.runs.len() as u64 + state.count(&task.id),
        })
    }
    pub async fn task_run_read(&self, request: TaskRunRead) -> Result<TaskRun> {
        self.task_run_read_for_threads(request, None).await
    }
    pub async fn task_run_read_for_threads(
        &self,
        request: TaskRunRead,
        allowed: Option<&BTreeSet<String>>,
    ) -> Result<TaskRun> {
        let state = self.task_modes.state.lock().await.clone();
        if !state.visible(&request.task_id, allowed)? {
            return Err(invalid("TASK_PERMISSION_DENIED"));
        }
        let task = state.tasks.get(&request.task_id).ok_or(Error::NotFound)?;
        let mut found = task.runs.iter().find(|r| r.id == request.run_id).cloned();
        if found.is_none() {
            state.visit_history(&task.id, |segment| {
                if let Some(run) = segment.runs.iter().find(|r| r.id == request.run_id) {
                    found = Some(run.clone());
                }
                Ok(())
            })?;
        }
        let run = found.ok_or(Error::NotFound)?;
        if serde_json::to_vec(&run).map_err(invalid)?.len() > PAGE_BYTES {
            return Err(Error::Exhausted("TaskRun exceeds response capacity".into()));
        }
        Ok(run)
    }
}
