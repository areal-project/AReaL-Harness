use super::*;

impl Engine {
    pub async fn start_durable(
        self: &Arc<Self>,
        identity: String,
        request: TurnStart,
        enqueue: bool,
    ) -> Result<Value> {
        self.mutate(move |engine| async move {
            if !engine.accepting_work() { return Err(Error::Closed); }
            let cell = engine.cell(&request.thread_id).await?;
            let mut state = cell.state.lock().await;
            let method = if enqueue {"areal/turn/enqueue"} else {"areal/turn/start"};
            let hash = digest(&request)?;
            let mut data = desktop(&state.thread);
            if let Some(result) = receipt(&data,&identity,&request.request_id,method,&hash)? { return Ok(result); }
            if state.poisoned || state.thread.parent_thread_id.is_some() { return Err(Error::Conflict); }
            if request.expected_config_revision.is_some_and(|revision| revision != data.configuration.revision) { return Err(Error::Conflict); }
            engine.validate_uploads(&state.thread,&request.input)?;
            validate_input(&request.input,&engine.configured_model(&data.configuration)?.capabilities())?;
            if enqueue {
                if data.queue.items.len()>=128 { return Err(Error::Exhausted("queue history capacity reached".into())); }
                let item = QueueItem {id:id(),input:request.input,configuration:data.configuration.clone(),submitted_by:identity.clone(),status:"pending".into(),turn_id:None};
                data.queue.revision+=1;
                let result = json!({"queueItemId":item.id,"queueRevision":data.queue.revision,"configRevision":item.configuration.revision});
                data.queue.items.push(item);
                remember(&mut data,&identity,&request.request_id,method,hash,result.clone());
                let mut candidate=state.thread.clone();candidate.desktop=Some(data);
                engine.persist(&candidate).await?;state.thread=candidate;
                cell.emit("areal/queue/updated",json!({"threadId":request.thread_id,"queue":state.thread.desktop.as_ref().unwrap().queue}));
                drop(state);
                engine.advance_queue(&cell).await?;
                Ok(result)
            } else {
                if state.active.is_some() || state.compacting { return Err(Error::Conflict); }
                engine.check_turn_available(&cell,&state).await?;
                let mut source=state.thread.clone();source.desktop=Some(data);
                let (mut candidate,turn)=engine.prepare_turn(&source,request.input)?;
                let permit=engine.reserve_active_turn()?;
                let result=json!({"turn":turn});
                remember(candidate.desktop.as_mut().unwrap(),&identity,&request.request_id,method,hash,result.clone());
                engine.persist(&candidate).await?;state.thread=candidate;
                engine.activate(&cell,&mut state,&turn,engine.shutdown.child_token(),permit);
                Ok(result)
            }
        }).await
    }
    pub(crate) async fn check_turn_available(&self, cell: &Cell, state: &State) -> Result<()> {
        if self.is_closed() {
            return Err(Error::Closed);
        }
        if state.poisoned {
            return Err(Error::Storage(
                "thread requires restart after persistence or cleanup failure".into(),
            ));
        }
        if !state.thread.dynamic_tools.is_empty()
            && cell
                .bindings
                .read()
                .await
                .host
                .as_ref()
                .is_none_or(|host| host.is_closed())
        {
            return Err(invalid(
                "tool host unavailable; resume with its owner before dispatch",
            ));
        }
        if state.thread.turns.iter().flat_map(|t|&t.items).any(|i|matches!(i,Item::DynamicToolCall{execution,..} if execution.inspection.is_none() && (execution.outcome==areal_protocol::ToolOutcome::Unknown || execution.hooks.iter().any(|h|h.outcome==areal_protocol::ToolOutcome::Unknown)))){return Err(invalid("UNKNOWN requires operator inspection"));}
        Ok(())
    }
    pub async fn queue(&self, thread_id: &str) -> Result<Queue> {
        Ok(desktop(&self.read(thread_id, false).await?).queue)
    }
    pub async fn edit_queue(
        self: &Arc<Self>,
        thread_id: String,
        expected: u64,
        action: String,
        args: Value,
    ) -> Result<Queue> {
        self.mutate(move |engine| async move {
            let cell = engine.cell(&thread_id).await?;
            let mut state = cell.state.lock().await;
            let mut candidate = state.thread.clone();
            let data = candidate.desktop.get_or_insert_with(Default::default);
            if data.queue.revision != expected {
                return Err(Error::Conflict);
            }
            match action.as_str() {
                "pause" => {
                    data.queue.paused = true;
                    data.queue.pause_reason = Some("user".into());
                }
                "resume" => {
                    data.queue.paused = false;
                    data.queue.pause_reason = None;
                }
                "update" | "remove" => {
                    let item = data
                        .queue
                        .items
                        .iter_mut()
                        .find(|item| Some(item.id.as_str()) == args["queueItemId"].as_str())
                        .ok_or(Error::NotFound)?;
                    if item.status != "pending" {
                        return Err(Error::Conflict);
                    }
                    if action == "remove" {
                        item.status = "removed".into();
                    } else {
                        let input: Vec<Input> =
                            serde_json::from_value(args["input"].clone()).map_err(invalid)?;
                        engine.validate_uploads(&state.thread, &input)?;
                        validate_input(
                            &input,
                            &engine.configured_model(&item.configuration)?.capabilities(),
                        )?;
                        item.input = input;
                    }
                }
                "reorder" => {
                    let ids: Vec<String> =
                        serde_json::from_value(args["queueItemIds"].clone()).map_err(invalid)?;
                    let pending: Vec<_> = data
                        .queue
                        .items
                        .iter()
                        .filter(|i| i.status == "pending")
                        .cloned()
                        .collect();
                    if ids.len() != pending.len()
                        || ids.iter().collect::<HashSet<_>>().len() != ids.len()
                        || ids.iter().any(|id| !pending.iter().any(|i| &i.id == id))
                    {
                        return Err(invalid(
                            "reorder must contain every pending item exactly once",
                        ));
                    }
                    let ordered: Vec<_> = ids
                        .iter()
                        .map(|id| pending.iter().find(|i| &i.id == id).unwrap().clone())
                        .collect();
                    let mut ordered = ordered.into_iter();
                    for item in &mut data.queue.items {
                        if item.status == "pending" {
                            *item = ordered.next().unwrap();
                        }
                    }
                }
                _ => return Err(invalid("unknown queue operation")),
            }
            data.queue.revision += 1;
            let queue = data.queue.clone();
            engine.persist(&candidate).await?;
            state.thread = candidate;
            cell.emit(
                "areal/queue/updated",
                json!({"threadId":thread_id,"queue":queue}),
            );
            drop(state);
            if action == "resume" {
                engine.advance_queue(&cell).await?;
            }
            Ok(queue)
        })
        .await
    }
    pub(crate) async fn advance_queue(self: &Arc<Self>, cell: &Arc<Cell>) -> Result<()> {
        let mut state = cell.state.lock().await;
        if state.active.is_some() || state.compacting || !self.accepting_work() {
            return Ok(());
        }
        let data = desktop(&state.thread);
        if data.queue.paused {
            return Ok(());
        }
        let Some(index) = data
            .queue
            .items
            .iter()
            .position(|item| item.status == "pending")
        else {
            return Ok(());
        };
        let item = &data.queue.items[index];
        let prepared = async {
            self.check_turn_available(cell, &state).await?;
            let mut source = state.thread.clone();
            source
                .desktop
                .get_or_insert_with(Default::default)
                .configuration = item.configuration.clone();
            let (mut candidate, turn) = self.prepare_turn(&source, item.input.clone())?;
            let data = candidate.desktop.as_mut().unwrap();
            data.configuration = state.thread.desktop.as_ref().unwrap().configuration.clone();
            data.queue.items[index].status = "running".into();
            data.queue.items[index].turn_id = Some(turn.id.clone());
            data.queue.revision += 1;
            let permit = self.reserve_active_turn()?;
            Ok::<_, Error>((candidate, turn, permit))
        }
        .await;
        match prepared {
            Ok((candidate, turn, permit)) => {
                self.persist(&candidate).await?;
                state.thread = candidate;
                self.activate(cell, &mut state, &turn, self.shutdown.child_token(), permit);
            }
            Err(error) => {
                let mut candidate = state.thread.clone();
                let queue = &mut candidate.desktop.as_mut().unwrap().queue;
                queue.paused = true;
                queue.pause_reason = Some(error.to_string());
                queue.revision += 1;
                self.persist(&candidate).await?;
                state.thread = candidate;
            }
        }
        cell.emit("areal/queue/updated",json!({"threadId":state.thread.id,"queue":state.thread.desktop.as_ref().unwrap().queue}));
        Ok(())
    }
}
