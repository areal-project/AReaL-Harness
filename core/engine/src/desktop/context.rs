use super::*;
impl Engine {
    pub async fn context_read(
        &self,
        thread_id: &str,
        offset: usize,
        limit: usize,
    ) -> Result<Value> {
        if limit == 0 || limit > 32 {
            return Err(invalid("context page limit must be 1..32"));
        }
        let thread = self.read(thread_id, true).await?;
        let messages = history(&thread, &self.store).map_err(invalid)?;
        if offset > messages.len() {
            return Err(invalid("context offset exceeds message count"));
        }
        let data:Vec<_>=messages.iter().skip(offset).take(limit).map(|m|json!({"role":m.role,"text":m.text_content(),"toolCalls":m.tool_calls,"toolCallId":m.tool_call_id,"opaqueProviderContextOmitted":m.provider_context.is_some(),"media":m.content.iter().filter_map(|p|match p{model::ContentPart::Image{..}=>Some("image"),model::ContentPart::Audio{..}=>Some("audio"),model::ContentPart::File{..}=>Some("file"),_=>None}).collect::<Vec<_>>()})).collect();
        Ok(
            json!({"threadId":thread_id,"view":"historyProjectionForNextRequest","systemInstructionsIncluded":thread.turns.last().is_some_and(|t|t.instruction_snapshot.is_some()),"instructionSnapshot":thread.turns.last().and_then(|t|t.instruction_snapshot.as_ref()),"checkpoint":thread.context_checkpoint,"offset":offset,"nextOffset":(offset+data.len()<messages.len()).then_some(offset+data.len()),"data":data}),
        )
    }
    pub async fn context_compact(self: &Arc<Self>, thread_id: String) -> Result<Value> {
        if !self.limits.context_compaction_enabled {
            return Err(Error::Invalid("context compaction is disabled".into()));
        }
        self.mutate(move|engine|async move{
            if !engine.accepting_work(){return Err(Error::Closed);}
            let admission=engine.desktop.lifecycle.gate.lock().await;
            if !engine.accepting_work(){return Err(Error::Closed);}
            let cell=engine.cell(&thread_id).await?;
            {let mut state=cell.state.lock().await;if state.active.is_some()||state.compacting||state.thread.goals.goal.as_ref().is_some_and(|g|g.status==areal_protocol::goals::GoalStatus::Active){return Err(Error::Conflict);}state.compacting=true;}
            drop(admission);
            let result=async {
                let _permit=tokio::select!{_=engine.shutdown.cancelled()=>return Err(invalid("compaction cancelled")),p=engine.permits.acquire()=>p.map_err(invalid)?};
                tokio::time::timeout(engine.limits.turn_timeout,engine.compact_context(&cell,&engine.shutdown,0,None,true)).await.map_err(invalid)?.map_err(invalid)
            }.await;
            cell.state.lock().await.compacting=false;
            engine.goals.request(&cell.id);
            result?;
            engine.context_read(&thread_id,0,16).await
        }).await
    }
}
