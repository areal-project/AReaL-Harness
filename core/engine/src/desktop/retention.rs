//! 显式归档只释放驻留历史；去重收据、Blob 引用和磁盘快照仍然保留。
use super::*;
impl Engine {
    pub async fn archive_thread(self: &Arc<Self>, thread_id: String) -> Result<Value> {
        self.mutate(move|engine|async move{
   let cell=engine.cell(&thread_id).await?;let _resources=cell.resource_gate.lock().await;let mut state=cell.state.lock().await;
   if state.active.is_some()||state.compacting||state.poisoned {return Err(Error::Conflict);}
   let mut candidate=state.thread.clone();
   if candidate.turns.iter().flat_map(|t|&t.items).any(|i|matches!(i,Item::DynamicToolCall{execution,..}if execution.inspection.is_none()&&(execution.outcome==areal_protocol::ToolOutcome::Unknown||execution.hooks.iter().any(|h|h.outcome==areal_protocol::ToolOutcome::Unknown)))){return Err(invalid("inspect UNKNOWN before archiving"));}
   let data=candidate.desktop.get_or_insert_with(Default::default);
   if data.processes.iter().any(|p|!p.cleanup_confirmed)||data.queue.items.iter().any(|i|matches!(i.status.as_str(),"pending"|"running")){return Err(invalid("settle queue and resources before archiving"));}
   data.archived=true;engine.persist(&candidate).await?;
   candidate.turns.clear();candidate.context_checkpoint=None;state.thread=candidate;
   cell.emit("areal/thread/archived",json!({"threadId":thread_id}));Ok(json!({"threadId":thread_id,"archived":true,"history":"cold","receiptsRetained":true}))
  }).await
    }
    pub async fn release_upload(self: &Arc<Self>, thread_id: String, uri: String) -> Result<Value> {
        self.mutate(move |engine| async move {
            let cell = engine.cell(&thread_id).await?;
            let mut state = cell.state.lock().await;
            if state.active.is_some() || state.compacting {
                return Err(Error::Conflict);
            }
            if serde_json::to_string(&state.thread.turns)
                .map_err(invalid)?
                .contains(&uri)
                || state.thread.desktop.as_ref().is_some_and(|d| {
                    serde_json::to_string(&d.queue).is_ok_and(|s| s.contains(&uri))
                })
            {
                return Err(invalid("upload is referenced by retained history or queue"));
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
