//! 概览只读取有界摘要；授权先于排序/分页，锁顺序不跨 Task 与 Thread。
use super::*;
use areal_protocol::work::*;
use std::collections::BTreeSet;

const PAGE_BYTES: usize = 128 * 1024;
const SUMMARY_REFS: usize = 32;
const TITLE_BYTES: usize = 512;

fn bounded(text: &str, bytes: usize) -> String {
    let mut end = text.len().min(bytes);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end]
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .collect()
}
fn attention(
    kind: &str,
    thread: Option<&str>,
    turn: Option<&str>,
    native_id: &str,
) -> AttentionSummary {
    AttentionSummary {
        attention_ref: format!("{kind}:{}:{native_id}", thread.unwrap_or("task")),
        kind: kind.into(),
        thread_id: thread.map(str::to_owned),
        turn_id: turn.map(str::to_owned),
        task_id: None,
        run_id: None,
        interaction_id: None,
        question_id: None,
        summary: kind.into(),
        status: "pending".into(),
    }
}
fn add_attention(row: &mut WorkItem, value: AttentionSummary) {
    row.attention_count += 1;
    if row.attention_refs.len() < SUMMARY_REFS {
        row.attention_refs.push(value);
    }
    row.attention_complete = row.attention_count == row.attention_refs.len();
    row.summary_truncated |= !row.attention_complete;
}
fn empty_row(kind: &str, title: &str) -> WorkItem {
    WorkItem {
        kind: kind.into(),
        thread_id: None,
        parent_thread_id: None,
        task_id: None,
        run_id: None,
        title: bounded(title, TITLE_BYTES),
        source_updated_at: None,
        execution: Execution {
            state: "idle".into(),
            turn_id: None,
            turn_status: None,
            run_status: None,
        },
        attention_refs: vec![],
        attention_count: 0,
        attention_complete: true,
        result_available: false,
        // Remote 尚未实现详情和写方法；不提前宣称可用操作。
        available_actions: vec![],
        queue: QueueSummary::default(),
        workers: vec![],
        worker_count: 0,
        workers_complete: true,
        summary_truncated: title.len() > TITLE_BYTES,
    }
}
fn thread_details(row: &mut WorkItem, thread: &Thread, goal: Option<&str>, ordinary: bool) {
    let belongs = |turn: &&Turn| {
        ordinary
            || turn
                .goal
                .as_ref()
                .is_some_and(|g| Some(g.goal_id.as_str()) == goal)
    };
    let turn = thread.turns.iter().rev().find(belongs);
    if ordinary {
        row.source_updated_at =
            Some(crate::catalog::latest_activity_at(thread).max(thread.created_at));
        row.parent_thread_id = thread.parent_thread_id.clone();
        row.execution.state = match turn.map(|t| &t.status) {
            Some(TurnStatus::InProgress) => "running",
            Some(TurnStatus::Completed) => "completed",
            Some(TurnStatus::Failed) => "failed",
            Some(TurnStatus::Interrupted) => "interrupted",
            None => "idle",
        }
        .into();
    } else {
        // Task 没有通用 updatedAt；只使用该 Run 确有记录的执行时间，不填当前查询时间。
        row.source_updated_at = row
            .source_updated_at
            .into_iter()
            .chain(turn.and_then(|t| t.completed_at.or(t.started_at)))
            .max();
    }
    if let Some(turn) = turn {
        row.execution.turn_id = Some(turn.id.clone());
        row.execution.turn_status = Some(turn.status.clone());
        row.result_available |= turn.status != TurnStatus::InProgress
            || turn.items.iter().any(|i| {
                matches!(i, Item::AgentMessage { text, .. } if !text.is_empty())
                    || matches!(i, Item::AgentMedia { .. })
            });
    }
    if let Some(desktop) = &thread.desktop {
        row.queue = QueueSummary {
            pending_count: desktop
                .queue
                .items
                .iter()
                .filter(|i| i.status == "pending")
                .count(),
            paused: desktop.queue.paused,
        };
        for interaction in &desktop.interactions {
            if interaction.status != "pending" || interaction.expires_at <= now() {
                continue;
            }
            if !ordinary
                && !thread
                    .turns
                    .iter()
                    .filter(belongs)
                    .any(|t| t.id == interaction.turn_id)
            {
                continue;
            }
            let kind = if interaction.kind == "approval" {
                "approval"
            } else {
                "syncQuestion"
            };
            let mut item = attention(
                kind,
                Some(&thread.id),
                Some(&interaction.turn_id),
                &interaction.request_id,
            );
            item.interaction_id = Some(interaction.request_id.clone());
            item.summary = if kind == "approval" {
                "Tool approval required".into()
            } else {
                bounded(
                    interaction
                        .questions
                        .first()
                        .map_or("Question requires an answer", |q| q.title.as_str()),
                    256,
                )
            };
            item.task_id = row.task_id.clone();
            item.run_id = row.run_id.clone();
            add_attention(row, item);
        }
    }
    for turn in thread.turns.iter().filter(belongs) {
        for item in &turn.items {
            if let Item::DynamicToolCall { id, execution, .. } = item
                && execution.inspection.is_none()
                && (execution.outcome == areal_protocol::ToolOutcome::Unknown
                    || execution
                        .hooks
                        .iter()
                        .any(|h| h.outcome == areal_protocol::ToolOutcome::Unknown))
            {
                let mut item = attention("executionUnknown", Some(&thread.id), Some(&turn.id), id);
                item.summary = "Tool outcome unknown; desktop inspection required".into();
                item.task_id = row.task_id.clone();
                item.run_id = row.run_id.clone();
                add_attention(row, item);
            }
        }
    }
}
fn consider(
    rows: &mut BTreeMap<String, WorkItem>,
    key: String,
    row: WorkItem,
    request: &OverviewRequest,
    capacity: usize,
) {
    // 固定宽度的反向时间键保证分页先选最新记录，同秒再按身份稳定排序。
    let timestamp = row.source_updated_at.unwrap_or(0).max(0);
    let key = format!("v2:{:019}:{key}", i64::MAX - timestamp);
    if request.cursor.as_ref().is_some_and(|cursor| key <= *cursor) {
        return;
    }
    let matches = match request.filter.unwrap_or_default() {
        Filter::All => true,
        Filter::Attention => row.attention_count > 0,
        Filter::Active => matches!(
            row.execution.state.as_str(),
            "running" | "queued" | "waitingForInput" | "waitingForAgents"
        ),
    };
    if matches {
        rows.insert(key, row);
        if rows.len() > capacity {
            rows.pop_last();
        }
    }
}
impl Engine {
    pub async fn work_overview(
        &self,
        allowed: Option<&BTreeSet<String>>,
        request: OverviewRequest,
    ) -> Result<OverviewPage> {
        let limit = request.limit.unwrap_or(30);
        if !(1..=100).contains(&limit) {
            return Err(invalid("limit must be 1..100"));
        }
        if request.cursor.as_ref().is_some_and(|c| {
            c.len() > 256
                || !c.strip_prefix("v2:").is_some_and(|rest| {
                    rest.split_once(':').is_some_and(|(time, id)| {
                        time.len() == 19
                            && time.parse::<i64>().is_ok()
                            && (id.starts_with("thread:") || id.starts_with("taskRun:"))
                    })
                })
        }) {
            return Err(invalid("invalid overview cursor"));
        }
        let sees = |id: &str| allowed.is_none_or(|ids| ids.contains(id));
        let mut rows = BTreeMap::new();
        let mut owned = BTreeSet::new();
        let task_ids: Vec<_> = self
            .task_modes
            .state
            .lock()
            .await
            .tasks
            .keys()
            .cloned()
            .collect();
        for task_id in task_ids {
            let projections = {
                let state = self.task_modes.state.lock().await.clone();
                let Some(task) = state.tasks.get(&task_id) else {
                    continue;
                };
                if allowed.is_some() && task.thread_id.as_deref().is_none_or(|id| !sees(id)) {
                    continue;
                }
                let mut projections = Vec::new();
                for run in &task.runs {
                    if run.thread_id.as_deref().is_some_and(|id| !sees(id)) {
                        continue;
                    }
                    let mut row = empty_row("taskRun", &task.objective);
                    row.task_id = Some(task.id.clone());
                    row.run_id = Some(run.id.clone());
                    row.thread_id = run.thread_id.clone();
                    row.execution.run_status = Some(run.status);
                    row.execution.state = serde_json::to_value(run.status)
                        .unwrap()
                        .as_str()
                        .unwrap()
                        .into();
                    row.source_updated_at = run.completed_at;
                    row.result_available = run.status.terminal();
                    let workers: Vec<_> =
                        run.workers.iter().filter(|w| sees(&w.thread_id)).collect();
                    row.worker_count = workers.len();
                    row.workers_complete = workers.len() <= SUMMARY_REFS;
                    row.workers = workers
                        .iter()
                        .take(SUMMARY_REFS)
                        .map(|w| (*w).clone())
                        .collect();
                    row.summary_truncated |= !row.workers_complete;
                    for id in run
                        .thread_id
                        .iter()
                        .chain(workers.iter().map(|w| &w.thread_id))
                    {
                        owned.insert((id.clone(), run.goal_id.clone()));
                    }
                    for message in &task.messages {
                        if message.run_id != run.id
                            || message.kind != "question"
                            || message.status != "pending"
                            || message.expires_at.is_some_and(|at| at <= now())
                        {
                            continue;
                        }
                        // 异步问题保持 Run 的原状态，提问本身不表示执行挂起。
                        let mut item =
                            attention("asyncQuestion", run.thread_id.as_deref(), None, &message.id);
                        item.task_id = Some(task.id.clone());
                        item.run_id = Some(run.id.clone());
                        item.question_id = Some(message.id.clone());
                        item.summary = bounded(
                            message
                                .questions
                                .first()
                                .map_or("Task question requires an answer", |q| q.title.as_str()),
                            256,
                        );
                        row.source_updated_at = Some(
                            row.source_updated_at
                                .unwrap_or(message.created_at)
                                .max(message.created_at),
                        );
                        add_attention(&mut row, item);
                    }
                    projections.push((
                        row,
                        run.goal_id.clone(),
                        workers
                            .iter()
                            .map(|w| w.thread_id.clone())
                            .collect::<Vec<_>>(),
                    ));
                }
                state.visit_history(&task.id, |segment| {
                    for run in &segment.runs {
                        if run.thread_id.as_deref().is_some_and(|id| !sees(id)) {
                            continue;
                        }
                        for id in run
                            .thread_id
                            .iter()
                            .chain(run.workers.iter().map(|w| &w.thread_id))
                        {
                            owned.insert((id.clone(), run.goal_id.clone()));
                        }
                        let mut row = empty_row("taskRun", &task.objective);
                        row.task_id = Some(task.id.clone());
                        row.run_id = Some(run.id.clone());
                        row.thread_id = run.thread_id.clone();
                        row.execution.run_status = Some(run.status);
                        row.execution.state = serde_json::to_value(run.status)
                            .unwrap()
                            .as_str()
                            .unwrap()
                            .into();
                        row.source_updated_at = run.completed_at;
                        row.result_available = run.status.terminal();
                        let workers: Vec<_> =
                            run.workers.iter().filter(|w| sees(&w.thread_id)).collect();
                        row.worker_count = workers.len();
                        row.workers_complete = workers.len() <= SUMMARY_REFS;
                        row.workers = workers
                            .iter()
                            .take(SUMMARY_REFS)
                            .map(|w| (*w).clone())
                            .collect();
                        row.summary_truncated = !row.workers_complete;
                        consider(
                            &mut rows,
                            format!("taskRun:{}:{}", task.id, run.id),
                            row,
                            &request,
                            limit + 1,
                        );
                    }
                    Ok(())
                })?;
                projections
            };
            for (mut row, goal, workers) in projections {
                if let Some(id) = &row.thread_id.clone()
                    && let Ok(cell) = self.raw_cell(id).await
                {
                    let state = cell.state.lock().await;
                    thread_details(&mut row, &state.thread, goal.as_deref(), false);
                }
                for id in workers {
                    if let Ok(cell) = self.raw_cell(&id).await {
                        let state = cell.state.lock().await;
                        let mut worker = empty_row("thread", "");
                        worker.task_id = row.task_id.clone();
                        worker.run_id = row.run_id.clone();
                        thread_details(&mut worker, &state.thread, goal.as_deref(), true);
                        for item in worker.attention_refs {
                            add_attention(&mut row, item);
                        }
                        row.attention_count += worker.attention_count.saturating_sub(SUMMARY_REFS);
                        row.attention_complete = row.attention_count == row.attention_refs.len();
                        row.summary_truncated |= !row.attention_complete;
                    }
                }
                let key = format!(
                    "taskRun:{}:{}",
                    row.task_id.as_ref().unwrap(),
                    row.run_id.as_ref().unwrap()
                );
                consider(&mut rows, key, row, &request, limit + 1);
            }
        }
        let cells: Vec<_> = self
            .threads
            .read()
            .await
            .iter()
            .filter(|(id, _)| sees(id))
            .map(|(_, c)| c.clone())
            .collect();
        for cell in cells {
            let state = cell.state.lock().await;
            let thread = &state.thread;
            if thread.desktop.as_ref().is_some_and(|d| d.archived) {
                continue;
            }
            let goal = thread
                .turns
                .last()
                .and_then(|t| t.goal.as_ref())
                .map(|g| g.goal_id.clone())
                .or_else(|| thread.goal_owner.as_ref().map(|g| g.goal_id.clone()));
            if owned.contains(&(thread.id.clone(), goal)) {
                continue;
            }
            let mut row = empty_row(
                "thread",
                if thread.preview.is_empty() {
                    "Untitled session"
                } else {
                    &thread.preview
                },
            );
            row.thread_id = Some(thread.id.clone());
            thread_details(&mut row, thread, None, true);
            if row.parent_thread_id.as_deref().is_some_and(|id| !sees(id)) {
                row.parent_thread_id = None;
            }
            consider(
                &mut rows,
                format!("thread:{}", thread.id),
                row,
                &request,
                limit + 1,
            );
        }
        let mut data = Vec::new();
        let mut bytes = 512usize;
        let mut last = None;
        let mut more = false;
        for (key, row) in rows {
            let size = serde_json::to_vec(&row).map_err(invalid)?.len() + 1;
            if data.len() == limit || bytes + size > PAGE_BYTES {
                more = true;
                break;
            }
            bytes += size;
            last = Some(key);
            data.push(row);
        }
        Ok(OverviewPage {
            data,
            next_cursor: if more { last } else { None },
            complete: !more,
        })
    }
}

#[cfg(test)]
mod ordering_tests {
    use super::*;

    #[test]
    fn overview_pages_by_latest_modification_before_identity() {
        let request = OverviewRequest {
            limit: Some(1),
            ..Default::default()
        };
        let mut rows = BTreeMap::new();
        for (id, at) in [("thread:a", 100), ("thread:z", 300), ("thread:b", 200)] {
            let mut row = empty_row("thread", id);
            row.source_updated_at = Some(at);
            consider(&mut rows, id.into(), row, &request, 2);
        }
        let (cursor, newest) = rows.pop_first().unwrap();
        assert_eq!(newest.source_updated_at, Some(300));
        let request = OverviewRequest {
            cursor: Some(cursor),
            ..request
        };
        let mut next = BTreeMap::new();
        for (id, at) in [("thread:a", 100), ("thread:z", 300), ("thread:b", 200)] {
            let mut row = empty_row("thread", id);
            row.source_updated_at = Some(at);
            consider(&mut next, id.into(), row, &request, 2);
        }
        assert_eq!(
            next.values()
                .map(|r| r.source_updated_at.unwrap())
                .collect::<Vec<_>>(),
            vec![200, 100]
        );
    }
}
