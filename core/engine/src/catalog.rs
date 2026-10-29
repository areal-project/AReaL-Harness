//! 目录只索引身份和不可变创建顺序；动态字段仍从当前会话状态投影。
use super::*;
use std::collections::BTreeSet;
use std::ops::{Bound, Deref};
mod sqlite;

pub(crate) fn latest_activity_at(thread: &Thread) -> i64 {
    thread
        .turns
        .iter()
        .fold(thread.updated_at.max(0), |latest, turn| {
            latest
                .max(turn.started_at.unwrap_or(0))
                .max(turn.completed_at.unwrap_or(0))
        })
}

/// 桌面目录的既有视图；只用于共享过滤，不改变 RPC 游标或持久化状态。
#[derive(Clone, Copy, Debug, Default)]
pub enum ConversationView {
    #[default]
    Main,
    Side,
    All,
}

#[derive(Clone, Debug, Default)]
pub struct ConversationFilter {
    pub view: ConversationView,
    pub include_archived: bool,
    pub source_thread_id: Option<String>,
}

pub(crate) struct ConversationFields {
    archived: bool,
    root: bool,
    side: bool,
    worker: bool,
    origin: Option<String>,
}

fn conversation_origin(thread: &Thread) -> Option<&str> {
    match &thread.conversation {
        Some(areal_protocol::Conversation::Side { origin, .. })
        | Some(areal_protocol::Conversation::Fork { origin, .. }) => Some(&origin.source_thread_id),
        _ => None,
    }
}

impl ConversationFields {
    pub(crate) fn new(thread: &Thread) -> Self {
        Self {
            archived: thread.desktop.as_ref().is_some_and(|d| d.archived),
            root: thread.parent_thread_id.is_none(),
            side: thread.is_side(),
            worker: matches!(
                thread.source.as_str(),
                "nativeTaskAgent" | "nativeResearchAgent"
            ),
            origin: conversation_origin(thread).map(str::to_owned),
        }
    }
    pub(crate) fn included(&self, filter: &ConversationFilter) -> bool {
        filter.includes_fields(
            self.archived,
            self.root,
            self.side,
            self.worker,
            self.origin.as_deref(),
        )
    }
}

impl ConversationFilter {
    fn includes_fields(
        &self,
        archived: bool,
        root: bool,
        side: bool,
        worker: bool,
        origin: Option<&str>,
    ) -> bool {
        (self.include_archived || !archived)
            && match self.view {
                ConversationView::Main => root && !side && !worker,
                ConversationView::Side => side,
                ConversationView::All => true,
            }
            && self
                .source_thread_id
                .as_deref()
                .is_none_or(|source| origin == Some(source))
    }
    fn includes(&self, thread: &Thread) -> bool {
        self.includes_fields(
            thread.desktop.as_ref().is_some_and(|d| d.archived),
            thread.parent_thread_id.is_none(),
            thread.is_side(),
            matches!(
                thread.source.as_str(),
                "nativeTaskAgent" | "nativeResearchAgent"
            ),
            conversation_origin(thread),
        )
    }
}

pub(crate) struct ThreadCatalog {
    by_id: BTreeMap<String, Arc<Cell>>,
    by_created: BTreeMap<(i64, String), Arc<Cell>>,
    sqlite: Option<Arc<sqlite::Index>>,
    requested: areal_config::SessionCatalog,
    epoch: i64,
    initialization_ms: f64,
}

impl ThreadCatalog {
    pub(crate) fn new(
        root: &Path,
        threads: BTreeMap<String, Arc<Cell>>,
        requested: areal_config::SessionCatalog,
    ) -> Self {
        let started = std::time::Instant::now();
        // 复用恢复阶段已有的 UUID 目录，不销毁后再逐项注册。
        let by_created = threads
            .iter()
            .map(|(id, cell)| ((cell.created_at, id.clone()), cell.clone()))
            .collect();
        // 按需模式的元数据已由 SQLite 持久化；现有内存排序目录直接服务运行时查询。
        let sqlite = if requested == SessionCatalog::Sqlite {
            let keys: Vec<_> = threads
                .iter()
                .map(|(id, cell)| (id.clone(), cell.created_at))
                .collect();
            match sqlite::Index::open(root, &keys) {
                Ok(index) => Some(index),
                Err(error) => {
                    tracing::warn!(target:"areal::catalog", %error, "SQLite catalog unavailable; using memory directory");
                    None
                }
            }
        } else {
            None
        };
        Self {
            by_id: threads,
            by_created,
            sqlite,
            requested,
            epoch: 0,
            initialization_ms: started.elapsed().as_secs_f64() * 1000.0,
        }
    }

    pub(crate) fn insert(&mut self, id: String, cell: Arc<Cell>) -> Option<Arc<Cell>> {
        let previous = self.by_id.remove(&id);
        if let Some(previous) = &previous {
            self.by_created.remove(&(previous.created_at, id.clone()));
        }
        self.by_created
            .insert((cell.created_at, id.clone()), cell.clone());
        self.changed(id.clone(), Some(cell.created_at));
        self.by_id.insert(id, cell);
        previous
    }

    pub(crate) fn remove(&mut self, id: &str) -> Option<Arc<Cell>> {
        let cell = self.by_id.remove(id)?;
        self.by_created.remove(&(cell.created_at, id.to_owned()));
        self.changed(id.to_owned(), None);
        Some(cell)
    }

    fn changed(&mut self, id: String, created_at: Option<i64>) {
        if let Some(epoch) = self.epoch.checked_add(1) {
            self.epoch = epoch;
            if let Some(index) = &self.sqlite {
                index.change(epoch, id, created_at);
            }
        } else if let Some(index) = &self.sqlite {
            index.invalid_contents();
        }
    }

    fn page(
        &self,
        cursor: &CatalogCursor,
        limit: usize,
        allowed: Option<&BTreeSet<String>>,
    ) -> Vec<Arc<Cell>> {
        if let Some(allowed) = allowed {
            if let CatalogCursor::Id(after) = cursor {
                return allowed
                    .range::<str, _>((
                        after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                        Bound::Unbounded,
                    ))
                    .filter_map(|id| self.by_id.get(id))
                    .take(limit)
                    .cloned()
                    .collect();
            }
            // 小授权集合优先与 UUID 索引求交；广授权集合仍沿创建顺序有界扫描。
            let lookup_cost = allowed
                .len()
                .saturating_mul(self.by_id.len().max(1).ilog2() as usize + 1);
            if lookup_cost < self.by_id.len() {
                let mut cells: Vec<_> = allowed
                    .iter()
                    .filter_map(|id| self.by_id.get(id))
                    .filter(|cell| cursor.includes(cell))
                    .cloned()
                    .collect();
                let compare = |a: &Arc<Cell>, b: &Arc<Cell>| {
                    (a.created_at, &a.id).cmp(&(b.created_at, &b.id))
                };
                if cells.len() > limit {
                    cells.select_nth_unstable_by(limit, compare);
                    cells.truncate(limit);
                }
                cells.sort_unstable_by(compare);
                return cells;
            }
        }
        match cursor {
            CatalogCursor::Id(after) => self
                .by_id
                .range::<str, _>((
                    after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                    Bound::Unbounded,
                ))
                .filter(|(id, _)| allowed.is_none_or(|allowed| allowed.contains(id.as_str())))
                .take(limit)
                .map(|(_, cell)| cell.clone())
                .collect(),
            CatalogCursor::Created(after) => self
                .by_created
                .range((
                    after.as_ref().map_or(Bound::Unbounded, Bound::Excluded),
                    Bound::Unbounded,
                ))
                .filter(|((_, id), _)| allowed.is_none_or(|allowed| allowed.contains(id)))
                .take(limit)
                .map(|(_, cell)| cell.clone())
                .collect(),
        }
    }
}

// 只暴露原有只读目录操作；注册与回滚必须同时维护两个排序索引。
impl Deref for ThreadCatalog {
    type Target = BTreeMap<String, Arc<Cell>>;

    fn deref(&self) -> &Self::Target {
        &self.by_id
    }
}

#[derive(Clone)]
enum CatalogCursor {
    Id(Option<String>),
    Created(Option<(i64, String)>),
}

impl CatalogCursor {
    fn includes(&self, cell: &Cell) -> bool {
        match self {
            Self::Id(after) => after.as_ref().is_none_or(|after| &cell.id > after),
            Self::Created(after) => after
                .as_ref()
                .is_none_or(|after| (cell.created_at, &cell.id) > (after.0, &after.1)),
        }
    }

    fn advance(&mut self, cell: &Cell) {
        match self {
            Self::Id(after) => *after = Some(cell.id.clone()),
            Self::Created(after) => *after = Some((cell.created_at, cell.id.clone())),
        }
    }
}

/// 保留原 Thread 元数据契约，但从一开始就不复制正文、checkpoint 或冷历史清单。
pub(crate) fn metadata(thread: &Thread) -> Thread {
    Thread {
        conversation: thread.conversation.clone(),
        goals: thread.goals.clone(),
        goal_owner: thread.goal_owner.clone(),
        desktop: thread.desktop.clone(),
        id: thread.id.clone(),
        session_id: thread.session_id.clone(),
        parent_thread_id: thread.parent_thread_id.clone(),
        preview: thread.preview.clone(),
        name: thread.name.clone(),
        name_attempt_turn_id: thread.name_attempt_turn_id.clone(),
        model_provider: thread.model_provider.clone(),
        created_at: thread.created_at,
        updated_at: thread.updated_at,
        status: thread.status.clone(),
        cwd: thread.cwd.clone(),
        cli_version: thread.cli_version.clone(),
        source: thread.source.clone(),
        ephemeral: thread.ephemeral,
        turns: Vec::new(),
        history_archive: None,
        context_checkpoint: None,
        dynamic_tools: thread.dynamic_tools.clone(),
        toolset_revision: thread.toolset_revision,
    }
}

impl Engine {
    /// UUID 顺序与旧 thread/list 一致；授权和业务过滤在页大小计算之前执行。
    pub async fn list_filtered(
        &self,
        after: Option<&str>,
        limit: usize,
        include: impl Fn(&Thread) -> bool,
    ) -> Result<(Vec<Thread>, Option<String>)> {
        self.list_authorized(after, limit, None, include).await
    }

    /// 授权 ID 只用于候选求交，调用方的最终业务过滤仍在当前会话状态上执行。
    pub async fn list_authorized(
        &self,
        after: Option<&str>,
        limit: usize,
        allowed: Option<&BTreeSet<String>>,
        include: impl Fn(&Thread) -> bool,
    ) -> Result<(Vec<Thread>, Option<String>)> {
        let (data, more) = self
            .catalog_page(
                CatalogCursor::Id(after.map(str::to_owned)),
                limit,
                allowed,
                None,
                include,
            )
            .await?;
        let cursor = more.then(|| data.last().unwrap().id.clone());
        Ok((data, cursor))
    }

    /// 创建时间与 UUID 共同组成稳定排序键，后页不再扫描或重排前页。
    pub async fn list_by_created(
        &self,
        after: Option<&(i64, String)>,
        limit: usize,
        include: impl Fn(&Thread) -> bool,
    ) -> Result<(Vec<Thread>, Option<(i64, String)>)> {
        self.list_by_created_authorized(after, limit, None, include)
            .await
    }

    pub async fn list_by_created_authorized(
        &self,
        after: Option<&(i64, String)>,
        limit: usize,
        allowed: Option<&BTreeSet<String>>,
        include: impl Fn(&Thread) -> bool,
    ) -> Result<(Vec<Thread>, Option<(i64, String)>)> {
        let (data, more) = self
            .catalog_page(
                CatalogCursor::Created(after.cloned()),
                limit,
                allowed,
                None,
                include,
            )
            .await?;
        let cursor = more.then(|| {
            let last = data.last().unwrap();
            (last.created_at, last.id.clone())
        });
        Ok((data, cursor))
    }

    async fn catalog_page(
        &self,
        mut cursor: CatalogCursor,
        limit: usize,
        allowed: Option<&BTreeSet<String>>,
        conversation: Option<&ConversationFilter>,
        include: impl Fn(&Thread) -> bool,
    ) -> Result<(Vec<Thread>, bool)> {
        if !(1..=100).contains(&limit) {
            return Err(Error::Invalid("limit must be 1..100".into()));
        }
        if allowed.is_some_and(BTreeSet::is_empty) {
            return Ok((Vec::new(), false));
        }
        let sqlite = self
            .threads
            .read()
            .await
            .sqlite
            .clone()
            .filter(|index| !index.disabled());
        let allowed_json: Option<Arc<str>> = if sqlite.is_some() {
            allowed.map(|ids| {
                Arc::from(serde_json::to_string(ids).expect("authorization IDs serialize"))
            })
        } else {
            None
        };
        let mut data = Vec::with_capacity(limit);
        loop {
            // 候选批次不能随结果页填满而缩小，否则稀疏过滤的尾部会逐条重查索引。
            let capacity = limit + 1;
            // 目录锁只覆盖有界句柄读取；不能跨会话锁等待阻塞新会话注册。
            let cells = self
                .catalog_cells(
                    &cursor,
                    capacity,
                    allowed,
                    sqlite.as_ref(),
                    allowed_json.clone(),
                )
                .await;
            let complete = cells.len() < capacity;
            // 只有整批处理完才会继续范围读取；游标按批推进，避免每个过滤项都克隆 UUID。
            if let Some(last) = cells.last() {
                cursor.advance(last);
            }
            for cell in cells {
                let Some(state) = cell.state.lock_for_catalog(conversation).await else {
                    continue;
                };
                if !include(&state.thread) {
                    continue;
                }
                if data.len() == limit {
                    return Ok((data, true));
                }
                let mut thread = metadata(&state.thread);
                self.refresh_goal_usage(&mut thread);
                data.push(thread);
            }
            if complete {
                return Ok((data, false));
            }
        }
    }

    /// 共享视图过滤在冷目录解码前执行；已加载会话仍按当前状态检查。
    pub async fn list_conversations(
        &self,
        after: Option<&(i64, String)>,
        limit: usize,
        allowed: Option<&BTreeSet<String>>,
        filter: &ConversationFilter,
    ) -> Result<(Vec<Thread>, Option<(i64, String)>)> {
        let (data, more) = self
            .catalog_page(
                CatalogCursor::Created(after.cloned()),
                limit,
                allowed,
                Some(filter),
                |thread| filter.includes(thread),
            )
            .await?;
        let cursor = more.then(|| {
            let last = data.last().unwrap();
            (last.created_at, last.id.clone())
        });
        Ok((data, cursor))
    }

    async fn catalog_cells(
        &self,
        cursor: &CatalogCursor,
        limit: usize,
        allowed: Option<&BTreeSet<String>>,
        sqlite: Option<&Arc<sqlite::Index>>,
        allowed_json: Option<Arc<str>>,
    ) -> Vec<Arc<Cell>> {
        let Some(sqlite) = sqlite else {
            return self.threads.read().await.page(cursor, limit, allowed);
        };
        let epoch = self.threads.read().await.epoch;
        let keys = sqlite
            .page(epoch, cursor.clone(), limit, allowed_json)
            .await;
        let catalog = self.threads.read().await;
        if let Some(keys) = keys
            && catalog.epoch == epoch
        {
            let cells: Option<Vec<_>> = keys
                .into_iter()
                .map(|(id, created_at)| {
                    catalog
                        .by_id
                        .get(&id)
                        .filter(|cell| cell.created_at == created_at)
                        .cloned()
                })
                .collect();
            if let Some(cells) = cells {
                sqlite.hit();
                return cells;
            }
            sqlite.invalid_contents();
        }
        sqlite.fallback();
        catalog.page(cursor, limit, allowed)
    }

    /// 只结算可重建索引，不改变事实快照的提交或持久化保证。
    pub async fn flush_catalog(&self) {
        let sqlite = self.threads.read().await.sqlite.clone();
        if let Some(sqlite) = sqlite {
            sqlite.flush().await;
        }
    }

    pub async fn catalog_metrics(&self) -> Value {
        let catalog = self.threads.read().await;
        json!({"requested":catalog.requested,"epoch":catalog.epoch,"initializationMs":catalog.initialization_ms,
            "active":if catalog.sqlite.as_ref().is_some_and(|index| !index.disabled()) {"sqlite"} else {"memory"},
            "sqlite":catalog.sqlite.as_ref().map(|index| index.metrics()), "loading":self.store.loading_metrics()})
    }

    pub(crate) async fn close_catalog(&self) {
        let sqlite = self.threads.read().await.sqlite.clone();
        if let Some(sqlite) = sqlite {
            sqlite.shutdown().await;
        }
    }
}

#[cfg(test)]
mod sqlite_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn waiting_for_a_session_does_not_hold_the_registration_lock() {
        let root = tempfile::tempdir().unwrap();
        let model =
            model::ChatModel::new("http://127.0.0.1:9".into(), "fixture".into(), None).unwrap();
        let engine = Engine::open(root.path(), Arc::new(model), Limits::default()).unwrap();
        let existing = engine.create("/workspace".into()).await.unwrap();
        let cell = engine.raw_cell(&existing.id).await.unwrap();
        let state = cell.state.lock().await;
        let listing = engine.list_by_created(None, 100, |_| true);
        tokio::pin!(listing);
        // 先将查询轮询到真实会话锁等待，再尝试注册，避免用 sleep 猜测调度顺序。
        let created = tokio::time::timeout(Duration::from_secs(2), async {
            tokio::select! {
                biased;
                result = &mut listing => panic!("locked session unexpectedly readable: {result:?}"),
                created = engine.create("/another-workspace".into()) => created.unwrap(),
            }
        })
        .await;
        drop(state);
        let created = created.unwrap();
        let (rows, _) = listing.await.unwrap();
        assert!(rows.iter().any(|row| row.id == existing.id));
        assert!(engine.read(&created.id, false).await.is_ok());
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn failed_creation_removes_both_catalog_indexes_without_replaying_the_write() {
        for backend in [SessionCatalog::Memory, SessionCatalog::Sqlite] {
            failed_creation_case(backend).await;
        }
    }

    async fn failed_creation_case(backend: SessionCatalog) {
        let root = tempfile::tempdir().unwrap();
        let model =
            model::ChatModel::new("http://127.0.0.1:9".into(), "fixture".into(), None).unwrap();
        let engine = Engine::open(
            root.path(),
            Arc::new(model),
            Limits {
                session_catalog: backend,
                ..Default::default()
            },
        )
        .unwrap();
        engine
            .store
            .set_fork_fault(store::ForkFault::AfterPersistError);
        assert!(
            engine
                .create(root.path().to_string_lossy().into_owned())
                .await
                .is_err()
        );
        engine.flush_catalog().await;
        assert!(engine.list(None, 100, None).await.unwrap().0.is_empty());
        assert!(
            engine
                .list_by_created(None, 100, |_| true)
                .await
                .unwrap()
                .0
                .is_empty()
        );
        let next = engine
            .create(root.path().to_string_lossy().into_owned())
            .await
            .unwrap();
        engine.flush_catalog().await;
        let (rows, cursor) = engine.list_by_created(None, 100, |_| true).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, next.id);
        assert!(cursor.is_none());
        if backend == SessionCatalog::Sqlite {
            assert_eq!(engine.catalog_metrics().await["active"], "sqlite");
            assert!(
                engine.catalog_metrics().await["sqlite"]["readHits"]
                    .as_u64()
                    .unwrap()
                    > 0
            );
        }
        // 注入点发生在实际提交之后；查询回滚不删除这份结果未知的持久事实。
        assert_eq!(
            std::fs::read_dir(root.path())
                .unwrap()
                .flatten()
                .filter(|entry| entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "json"))
                .count(),
            2
        );
        engine.shutdown().await;
    }
}
