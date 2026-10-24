//! 显式归档只释放驻留历史；去重收据、Blob 引用和磁盘快照仍然保留。
use super::*;
impl Engine {
    pub async fn unarchive_conversation(self: &Arc<Self>, thread_id: String) -> Result<Value> {
        self.mutate(move |engine| async move {
            let cell = engine.raw_cell(&thread_id).await?;
            let mut state = cell.state.lock().await;
            if !state.thread.is_read_only_side() {
                return Err(invalid("only Side conversations can be restored here"));
            }
            if !state.thread.desktop.as_ref().is_some_and(|d| d.archived) {
                return Ok(json!({"threadId":thread_id,"archived":false}));
            }
            let mut candidate = engine
                .store
                .read_thread(&thread_id)
                .await
                .map_err(invalid)?;
            candidate.desktop.as_mut().unwrap().archived = false;
            engine.persist(&candidate).await?;
            state.thread = candidate;
            cell.emit("areal/thread/unarchived", json!({"threadId":thread_id}));
            Ok(json!({"threadId":thread_id,"archived":false}))
        })
        .await
    }
    pub async fn archive_thread(self: &Arc<Self>, thread_id: String) -> Result<Value> {
        self.mutate(move |engine| async move {
            // Turn admission and session close share one linearization gate. Do not
            // hold the thread lock across accepted hook cleanup/SessionEnd.
            let _admission = engine.desktop.lifecycle.gate.lock().await;
            let cell = engine.cell(&thread_id).await?;
            let _resources = cell.resource_gate.lock().await;
            {
                let state = cell.state.lock().await;
                if state.thread.is_executable_side() { return Err(invalid("use areal/side/close for executable Side conversations")); }
                validate_archive(&state)?;
            }
            engine.plugin_hooks_end(&cell).await.map_err(invalid)?;
            let mut state = cell.state.lock().await;
            validate_archive(&state)?;
            let mut candidate = state.thread.clone();
            candidate.desktop.get_or_insert_with(Default::default).archived = true;
            candidate.desktop.as_mut().unwrap().prompt_prediction = None;
            engine.persist(&candidate).await?;
            crate::prompt_prediction::invalidate(&mut state);
            candidate.turns.clear();
            candidate.context_checkpoint = None;
            state.thread = candidate;
            cell.emit("areal/thread/archived", json!({"threadId":thread_id}));
            Ok(json!({"threadId":thread_id,"archived":true,"history":"cold","receiptsRetained":true}))
        }).await
    }

    pub async fn release_upload(self: &Arc<Self>, thread_id: String, uri: String) -> Result<Value> {
        self.mutate(move |engine| async move {
            let cell = engine.cell(&thread_id).await?;
            let mut state = cell.state.lock().await;
            if state.active.is_some() || state.compacting {
                return Err(Error::Conflict);
            }
            if serde_json::to_string(
                &engine
                    .store
                    .hydrate(state.thread.clone())
                    .await
                    .map_err(invalid)?
                    .turns,
            )
            .map_err(invalid)?
            .contains(&uri)
                || state.thread.desktop.as_ref().is_some_and(|d| {
                    serde_json::to_string(&d.queue).is_ok_and(|s| s.contains(&uri))
                })
            {
                return Err(invalid("upload is referenced by retained history or queue"));
            }
            let snapshot = match &state.thread.conversation {
                Some(areal_protocol::Conversation::Fork { history_seed, .. }) => {
                    Some(&history_seed.snapshot_id)
                }
                Some(areal_protocol::Conversation::Side {
                    reference_snapshot, ..
                }) => Some(&reference_snapshot.snapshot_id),
                None => None,
            };
            if let Some(snapshot) = snapshot {
                let turns = engine.store.read_fork_snapshot(snapshot).map_err(invalid)?;
                if serde_json::to_string(&turns)
                    .map_err(invalid)?
                    .contains(&uri)
                {
                    return Err(invalid("upload is referenced by retained history or queue"));
                }
            }
            let mut candidate = state.thread.clone();
            let data = candidate.desktop.as_mut().ok_or(Error::NotFound)?;
            let old = data.uploads.len();
            data.uploads.retain(|m| m.uri != uri);
            if old == data.uploads.len() {
                return Err(Error::NotFound);
            }
            // 历史中的引用独立保留，释放上传所有权不能删除已被模型消费的内容。
            engine.persist(&candidate).await?;
            state.thread = candidate;
            Ok(json!({"released":true}))
        })
        .await
    }
    pub async fn garbage_collect(self: &Arc<Self>) -> Result<Value> {
        self.mutate(move |engine| async move {
            let _gate = engine.desktop.lifecycle.gate.lock().await;
            let status = engine.server_status().await;
            if status["draining"] != true || status["restartSafe"] != true {
                return Err(invalid(
                    "GC requires completed drain with no unresolved resources",
                ));
            }
            engine.store.collect_blobs().await.map_err(invalid)
        })
        .await
    }
}

pub(super) fn validate_archive(state: &State) -> Result<()> {
    if state.active.is_some() || state.compacting || state.poisoned {
        return Err(Error::Conflict);
    }
    let thread = &state.thread;
    if thread
        .goals
        .goal
        .as_ref()
        .is_some_and(|g| g.status == areal_protocol::goals::GoalStatus::Active)
    {
        return Err(invalid("pause Goal before archiving"));
    }
    if thread.turns.iter().flat_map(|t| &t.items).any(|i| matches!(i, Item::DynamicToolCall { execution, .. } if execution.inspection.is_none() && (execution.outcome == areal_protocol::ToolOutcome::Unknown || execution.hooks.iter().any(|h| h.outcome == areal_protocol::ToolOutcome::Unknown)))) { return Err(invalid("inspect UNKNOWN before archiving")); }
    if let Some(data) = &thread.desktop {
        if data
            .hook_runs
            .iter()
            .any(|r| r.outcome == "unknown" && r.inspection.is_none())
        {
            return Err(invalid("inspect UNKNOWN hooks before archiving"));
        }
        if data.processes.iter().any(|p| !p.cleanup_confirmed)
            || data
                .queue
                .items
                .iter()
                .any(|i| matches!(i.status.as_str(), "pending" | "running"))
        {
            return Err(invalid("settle queue and resources before archiving"));
        }
    }
    Ok(())
}
