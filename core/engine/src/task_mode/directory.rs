use super::*;
use sha2::{Digest, Sha256};

pub(super) const ROW_BYTES: usize = 16 * 1024;
const PAGE_BYTES: usize = 128 * 1024;

pub(super) fn bounded(value: &str, limit: usize) -> String {
    let mut end = value.len().min(limit);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}
fn run_row(run: &TaskRun) -> RunDirectoryRow {
    RunDirectoryRow {
        id: run.id.clone(),
        thread_id: run.thread_id.clone(),
        status: run.status,
        reason_preview: run.reason.as_ref().map(|s| bounded(s, 256)),
        reason_truncated: run.reason.as_ref().is_some_and(|s| s.len() > 256),
        scheduled_at: run.scheduled_at,
        started_at: run.started_at,
        completed_at: run.completed_at,
    }
}
pub(super) fn row(task: &Task) -> Result<TaskDirectoryRow> {
    let pending: Vec<_> = task
        .messages
        .iter()
        .filter(|m| m.kind == "question" && m.status == "pending")
        .collect();
    let row = TaskDirectoryRow {
        id: task.id.clone(),
        revision: task.revision,
        channel_sequence: task.channel_sequence,
        mode: task.mode,
        delivery: task.delivery,
        source_thread_id: task.source_thread_id.clone(),
        thread_id: task.thread_id.clone(),
        objective_preview: bounded(&task.objective, 512),
        objective_truncated: task.objective.len() > 512,
        paused: task.paused,
        cancelled: task.cancelled,
        deleted_at: task.deleted_at,
        enabled: task.mode == TaskMode::Scheduled
            && !task.paused
            && !task.cancelled
            && task.deleted_at.is_none()
            && task.next_run_at.is_some(),
        next_run_at: task.next_run_at,
        schedule: task.schedule.clone(),
        schedule_v2: task.schedule_v2.clone(),
        skipped_runs: task.skipped_runs,
        last_skipped_at: task.last_skipped_at,
        last_trigger_decision: task.last_trigger_decision.clone(),
        run_count: task.archived_run_count + task.runs.len() as u64,
        latest_run: task.runs.last().map(run_row),
        active_run: task.runs.iter().find(|r| !r.status.terminal()).map(run_row),
        has_unsettled_work: task
            .runs
            .iter()
            .any(|r| !r.status.terminal() || r.workers.iter().any(|w| !w.settled)),
        pending_questions: pending.len() as u32,
        pending_question_expires_at: pending.iter().filter_map(|m| m.expires_at).min(),
    };
    if serde_json::to_vec(&row).map_err(invalid)?.len() > ROW_BYTES {
        return Err(Error::Exhausted(
            "Task directory row exceeds capacity".into(),
        ));
    }
    Ok(row)
}
pub(super) fn visible(row: &TaskDirectoryRow) -> bool {
    row.deleted_at.is_none() || row.has_unsettled_work
}

pub(super) struct PreparedTask {
    row: Arc<TaskDirectoryRow>,
    attention: Vec<OwnerAttention>,
    facts: Vec<OwnerNoticeFact>,
    bindings: Vec<(String, String, String)>,
}
impl PreparedTask {
    pub(super) fn refresh_row(&mut self, task: &Task) -> Result<()> {
        self.row = Arc::new(row(task)?);
        Ok(())
    }
    pub(super) fn new(task: &Task, previous: Option<&Task>) -> Result<Self> {
        let row = Arc::new(row(task)?);
        let attention: Vec<_> = task
            .messages
            .iter()
            .filter(|m| m.kind == "question" && m.status == "pending")
            .map(|m| OwnerAttention {
                id: format!("question:{}:{}", task.id, m.id),
                kind: OwnerAttentionKind::AsyncQuestion,
                task_id: Some(task.id.clone()),
                run_id: Some(m.run_id.clone()),
                thread_id: None,
                question_id: Some(m.id.clone()),
                interaction_id: None,
                objective_preview: row.objective_preview.clone(),
                summary: bounded(
                    m.questions
                        .first()
                        .map_or(m.text.as_str(), |q| q.title.as_str()),
                    256,
                ),
                expires_at: m.expires_at,
            })
            .collect();
        validate_attention(&attention)?;
        let mut facts: Vec<_> = task
            .runs
            .iter()
            .filter(|r| {
                r.status == RunStatus::Completed
                    && previous.is_none_or(|old| {
                        !old.runs
                            .iter()
                            .any(|p| p.id == r.id && p.status == RunStatus::Completed)
                    })
            })
            .map(|r| OwnerNoticeFact {
                kind: OwnerNoticeKind::TaskCompleted,
                task_id: Some(task.id.clone()),
                run_id: Some(r.id.clone()),
                thread_id: r.thread_id.clone(),
                question_id: None,
                interaction_id: None,
                interaction_kind: None,
                objective_preview: bounded(r.objective.as_deref().unwrap_or(&task.objective), 512),
                expires_at: None,
            })
            .collect();
        facts.extend(
            attention
                .iter()
                .filter(|a| {
                    previous.is_none_or(|old| {
                        !old.messages
                            .iter()
                            .any(|m| Some(&m.id) == a.question_id.as_ref() && m.status == "pending")
                    })
                })
                .map(notice),
        );
        let bindings = task
            .runs
            .iter()
            .flat_map(|run| {
                run.thread_id
                    .iter()
                    .chain(run.workers.iter().map(|w| &w.thread_id))
                    .filter(|id| !id.is_empty())
                    .map(|id| {
                        (
                            id.clone(),
                            run.id.clone(),
                            bounded(run.objective.as_deref().unwrap_or(&task.objective), 512),
                        )
                    })
            })
            .collect();
        Ok(Self {
            row,
            attention,
            facts,
            bindings,
        })
    }
}
fn validate_attention(rows: &[OwnerAttention]) -> Result<()> {
    if rows
        .iter()
        .any(|row| serde_json::to_vec(row).map_or(true, |bytes| bytes.len() > ROW_BYTES))
    {
        return Err(Error::Exhausted(
            "Owner attention row exceeds capacity".into(),
        ));
    }
    Ok(())
}
fn notice(row: &OwnerAttention) -> OwnerNoticeFact {
    OwnerNoticeFact {
        kind: if row.kind == OwnerAttentionKind::AsyncQuestion {
            OwnerNoticeKind::QuestionPending
        } else {
            OwnerNoticeKind::InteractionPending
        },
        task_id: row.task_id.clone(),
        run_id: row.run_id.clone(),
        thread_id: row.thread_id.clone(),
        question_id: row.question_id.clone(),
        interaction_id: row.interaction_id.clone(),
        interaction_kind: (row.kind != OwnerAttentionKind::AsyncQuestion).then_some(row.kind),
        objective_preview: row.objective_preview.clone(),
        expires_at: row.expires_at,
    }
}
pub(crate) fn thread_attention(thread: &Thread) -> Result<Vec<OwnerAttention>> {
    let rows = thread
        .desktop
        .iter()
        .flat_map(|d| d.interactions.iter())
        .filter(|i| i.status == "pending")
        .map(|i| OwnerAttention {
            id: format!("interaction:{}:{}", thread.id, i.request_id),
            kind: if i.kind == "approval" {
                OwnerAttentionKind::Approval
            } else {
                OwnerAttentionKind::SyncQuestion
            },
            task_id: None,
            run_id: None,
            thread_id: Some(thread.id.clone()),
            question_id: None,
            interaction_id: Some(i.request_id.clone()),
            objective_preview: bounded(thread.name.as_deref().unwrap_or(&thread.preview), 512),
            summary: bounded(
                i.questions
                    .first()
                    .map_or("Tool approval required", |q| q.title.as_str()),
                256,
            ),
            expires_at: Some(i.expires_at),
        })
        .collect::<Vec<_>>();
    validate_attention(&rows)?;
    Ok(rows)
}

struct View {
    generation: String,
    sequence: u64,
    directory_revision: u64,
    attention_revision: u64,
    rows: BTreeMap<String, Arc<TaskDirectoryRow>>,
    attention: BTreeMap<String, Vec<OwnerAttention>>,
    bindings: BTreeMap<String, (String, String, String)>,
}
pub(crate) struct OwnerDirectory {
    state: std::sync::Mutex<View>,
    events: broadcast::Sender<Arc<OwnerInvalidation>>,
}
impl OwnerDirectory {
    pub(super) fn new(snapshot: &Snapshot) -> Result<Self> {
        let owner = Self {
            state: std::sync::Mutex::new(View {
                generation: id(),
                sequence: 0,
                directory_revision: 0,
                attention_revision: 0,
                rows: BTreeMap::new(),
                attention: BTreeMap::new(),
                bindings: BTreeMap::new(),
            }),
            events: broadcast::channel(256).0,
        };
        for task in snapshot.tasks.values() {
            owner.publish_task(PreparedTask::new(task, Some(task))?, false);
        }
        Ok(owner)
    }
    pub(super) fn publish_task(&self, prepared: PreparedTask, emit: bool) {
        let mut state = self.state.lock().unwrap();
        let task_id = prepared.row.id.clone();
        let previous_bindings: BTreeMap<_, _> = state
            .bindings
            .iter()
            .filter(|(_, binding)| binding.0 == task_id)
            .map(|(thread, (_, run, objective))| (thread.clone(), (run.clone(), objective.clone())))
            .collect();
        let next_bindings: BTreeMap<_, _> = prepared
            .bindings
            .iter()
            .map(|(thread, run, objective)| (thread.clone(), (run.clone(), objective.clone())))
            .collect();
        if previous_bindings != next_bindings
            && state.attention.iter().any(|(source, rows)| {
                !rows.is_empty()
                    && source.strip_prefix("thread:").is_some_and(|thread| {
                        previous_bindings.contains_key(thread) || next_bindings.contains_key(thread)
                    })
            })
        {
            state.attention_revision += 1;
        }
        if visible(&prepared.row) {
            state.rows.insert(task_id.clone(), prepared.row);
        } else {
            state.rows.remove(&task_id);
        }
        state.directory_revision += 1;
        let source = format!("task:{task_id}");
        if state
            .attention
            .get(&source)
            .map(Vec::as_slice)
            .unwrap_or_default()
            != prepared.attention.as_slice()
        {
            state.attention_revision += 1;
            if prepared.attention.is_empty() {
                state.attention.remove(&source);
            } else {
                state.attention.insert(source, prepared.attention);
            }
        }
        state.bindings.retain(|_, binding| binding.0 != task_id);
        for (thread, run, objective) in prepared.bindings {
            state
                .bindings
                .insert(thread, (task_id.clone(), run, objective));
        }
        if emit {
            self.emit(&mut state, vec![task_id], vec![], prepared.facts);
        }
    }
    pub(crate) fn publish_thread(&self, thread: &str, rows: Vec<OwnerAttention>, emit: bool) {
        let mut state = self.state.lock().unwrap();
        let source = format!("thread:{thread}");
        if state
            .attention
            .get(&source)
            .is_none_or(|old| old.is_empty())
            && rows.is_empty()
        {
            return;
        }
        if state.attention.get(&source) == Some(&rows) {
            return;
        }
        let facts = rows
            .iter()
            .filter(|row| {
                state
                    .attention
                    .get(&source)
                    .is_none_or(|old| !old.iter().any(|item| item.id == row.id))
            })
            .map(|row| notice(&bind_attention(&state, row)))
            .collect();
        if rows.is_empty() {
            state.attention.remove(&source);
        } else {
            state.attention.insert(source, rows);
        }
        state.attention_revision += 1;
        if emit {
            self.emit(&mut state, vec![], vec![thread.into()], facts);
        }
    }
    fn emit(
        &self,
        state: &mut View,
        tasks: Vec<String>,
        threads: Vec<String>,
        facts: Vec<OwnerNoticeFact>,
    ) {
        let batches = facts.len().div_ceil(4).max(1);
        for batch in 0..batches {
            state.sequence += 1;
            let _ = self.events.send(Arc::new(OwnerInvalidation {
                generation: state.generation.clone(),
                sequence: state.sequence,
                changed_tasks: tasks.clone(),
                changed_threads: threads.clone(),
                facts: facts.iter().skip(batch * 4).take(4).cloned().collect(),
            }));
        }
    }
}
fn bind_attention(state: &View, row: &OwnerAttention) -> OwnerAttention {
    let mut row = row.clone();
    if let Some((task, run, objective)) =
        row.thread_id.as_ref().and_then(|id| state.bindings.get(id))
    {
        row.task_id = Some(task.clone());
        row.run_id = Some(run.clone());
        row.objective_preview = objective.clone();
    }
    row
}
fn limit(limit: Option<usize>) -> Result<usize> {
    let limit = limit.unwrap_or(30);
    if !(1..=100).contains(&limit) {
        return Err(invalid("limit must be 1..100"));
    }
    Ok(limit)
}
fn ids(ids: &[String]) -> Result<()> {
    if ids.len() > 100 || ids.iter().any(|id| id.is_empty() || id.len() > 256) {
        return Err(invalid("expected at most 100 identifiers of 1..256 bytes"));
    }
    Ok(())
}
#[derive(Serialize, Deserialize)]
struct Cursor {
    generation: String,
    revision: u64,
    query: String,
    after: String,
}
fn cursor(cursor: Option<&str>, state: &View, revision: u64, query: &str) -> Result<String> {
    let Some(cursor) = cursor else {
        return Ok(String::new());
    };
    if cursor.len() > 2048 {
        return Err(invalid("invalid directory cursor"));
    }
    let cursor: Cursor = serde_json::from_str(cursor).map_err(invalid)?;
    if cursor.generation != state.generation || cursor.revision != revision || cursor.query != query
    {
        return Err(invalid("DIRECTORY_CHANGED: restart from the first page"));
    }
    Ok(cursor.after)
}
fn next_cursor(
    state: &View,
    revision: u64,
    query: String,
    after: Option<String>,
) -> Option<String> {
    after.map(|after| {
        serde_json::to_string(&Cursor {
            generation: state.generation.clone(),
            revision,
            query,
            after,
        })
        .unwrap()
    })
}
impl Engine {
    pub fn owner_watch(&self) -> (OwnerWatch, broadcast::Receiver<Arc<OwnerInvalidation>>) {
        let state = self.task_modes.directory.state.lock().unwrap();
        let events = self.task_modes.directory.events.subscribe();
        (
            OwnerWatch {
                generation: state.generation.clone(),
                sequence: state.sequence,
                directory_revision: state.directory_revision,
                attention_revision: state.attention_revision,
            },
            events,
        )
    }
    pub fn task_directory_list(&self, request: TaskDirectoryList) -> Result<TaskDirectoryPage> {
        let limit = limit(request.limit)?;
        let state = self.task_modes.directory.state.lock().unwrap();
        let query = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(request.mode, &request.source_thread_id)).unwrap())
        );
        let after = cursor(
            request.cursor.as_deref(),
            &state,
            state.directory_revision,
            &query,
        )?;
        let mut data = Vec::new();
        let mut bytes = 0;
        let mut more = false;
        for row in state.rows.values().filter(|row| {
            row.id > after
                && request.mode.is_none_or(|mode| row.mode == mode)
                && request
                    .source_thread_id
                    .as_ref()
                    .is_none_or(|id| row.source_thread_id.as_ref() == Some(id))
        }) {
            let size = serde_json::to_vec(row.as_ref()).map_err(invalid)?.len();
            if data.len() >= limit || bytes + size > PAGE_BYTES - 4096 {
                more = true;
                break;
            }
            bytes += size;
            data.push(row.as_ref().clone());
        }
        let next_cursor = next_cursor(
            &state,
            state.directory_revision,
            query,
            if more {
                data.last().map(|r| r.id.clone())
            } else {
                None
            },
        );
        Ok(TaskDirectoryPage {
            generation: state.generation.clone(),
            revision: state.directory_revision,
            data,
            next_cursor,
        })
    }
    pub fn task_directory_read(&self, request: TaskDirectoryRead) -> Result<TaskDirectoryRows> {
        ids(&request.task_ids)?;
        let state = self.task_modes.directory.state.lock().unwrap();
        let mut data = vec![];
        let mut removed = vec![];
        for id in request.task_ids {
            if let Some(row) = state.rows.get(&id) {
                data.push(row.as_ref().clone());
            } else {
                removed.push(id);
            }
        }
        let result = TaskDirectoryRows {
            generation: state.generation.clone(),
            revision: state.directory_revision,
            data,
            removed,
        };
        if serde_json::to_vec(&result).map_err(invalid)?.len() > PAGE_BYTES {
            return Err(invalid(
                "directory read exceeds page capacity; request fewer IDs",
            ));
        }
        Ok(result)
    }
    pub fn owner_attention_read(&self, request: OwnerAttentionRead) -> Result<OwnerAttentionPage> {
        if let Some(values) = &request.task_ids {
            ids(values)?;
        }
        if let Some(values) = &request.thread_ids {
            ids(values)?;
        }
        let limit = limit(request.limit)?;
        let state = self.task_modes.directory.state.lock().unwrap();
        let query = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(&request.task_ids, &request.thread_ids)).unwrap())
        );
        let after = cursor(
            request.cursor.as_deref(),
            &state,
            state.attention_revision,
            &query,
        )?;
        let mut selected = BTreeMap::new();
        for row in state
            .attention
            .values()
            .flatten()
            .filter(|row| row.id > after && row.expires_at.is_none_or(|at| at > now()))
        {
            let task = row.task_id.as_ref().or_else(|| {
                row.thread_id
                    .as_ref()
                    .and_then(|id| state.bindings.get(id))
                    .map(|binding| &binding.0)
            });
            if !(request
                .task_ids
                .as_ref()
                .is_some_and(|ids| task.is_some_and(|id| ids.contains(id)))
                || request
                    .thread_ids
                    .as_ref()
                    .is_some_and(|ids| row.thread_id.as_ref().is_some_and(|id| ids.contains(id)))
                || request.task_ids.is_none() && request.thread_ids.is_none())
            {
                continue;
            }
            selected.insert(&row.id, row);
            if selected.len() > limit + 1 {
                selected.pop_last();
            }
        }
        let mut data = vec![];
        let mut bytes = 0;
        let mut more = false;
        for row in selected.into_values() {
            let row = bind_attention(&state, row);
            let size = serde_json::to_vec(&row).map_err(invalid)?.len();
            if data.len() >= limit || bytes + size > PAGE_BYTES - 4096 {
                more = true;
                break;
            }
            bytes += size;
            data.push(row);
        }
        let next_cursor = next_cursor(
            &state,
            state.attention_revision,
            query,
            if more {
                data.last().map(|r| r.id.clone())
            } else {
                None
            },
        );
        Ok(OwnerAttentionPage {
            generation: state.generation.clone(),
            revision: state.attention_revision,
            data,
            next_cursor,
        })
    }
}
