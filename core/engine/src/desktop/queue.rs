use super::*;

impl Engine {
    pub async fn start_durable(
        self: &Arc<Self>,
        identity: String,
        request: TurnStart,
        enqueue: bool,
    ) -> Result<Value> {
        self.mutate(move |engine| async move {
            let _gate = engine.desktop.lifecycle.gate.lock().await;
            if !engine.accepting_work() { return Err(Error::Closed); }
            let cell = engine.cell(&request.thread_id).await?;
            let mut state = cell.state.lock().await;
            let method = if enqueue {"areal/turn/enqueue"} else {"areal/turn/start"};
            let hash = digest(&request)?;
            let mut data = desktop(&state.thread);
            if let Some(result) = receipt(&data,&identity,&request.request_id,method,&hash)? { return Ok(result); }
            if state.poisoned || state.thread.parent_thread_id.is_some() || state.thread.source == "nativeTaskAgent" { return Err(Error::Conflict); }
            if request.expected_config_revision.is_some_and(|revision| revision != data.configuration.revision) { return Err(Error::Conflict); }
            engine.validate_uploads(&state.thread,&request.input)?;
            let mut configuration = engine.freeze_configuration(data.configuration.clone());
            if let Some(mode) = request.interaction_mode { configuration.options.interaction_mode = mode; }
            validate_input(&request.input,&engine.configured_model(&configuration)?.capabilities())?;
            if enqueue {
                if data.queue.items.len()>=128 { return Err(Error::Exhausted("queue history capacity reached".into())); }
                let item = QueueItem {id:id(),input:request.input,configuration,submitted_by:identity.clone(),status:"pending".into(),turn_id:None};
                data.queue.revision+=1;
                let result = json!({"queueItemId":item.id,"queueRevision":data.queue.revision,"configRevision":item.configuration.revision});
                data.queue.items.push(item);
                remember(&mut data,&identity,&request.request_id,method,hash,result.clone());
                let mut candidate=state.thread.clone();candidate.desktop=Some(data);
                if let Some(goal) = &mut candidate.goals.goal
                    && goal.status == areal_protocol::goals::GoalStatus::Active
                {
                    goal.report_turn_id = None;
                    candidate.goals.revision += 1;
                    candidate.goals.event_sequence += 1;
                }
                engine.persist(&candidate).await?;state.thread=candidate;
                engine.goal_emit(&cell, &state.thread);
                cell.emit("areal/queue/updated",json!({"threadId":request.thread_id,"queue":state.thread.desktop.as_ref().unwrap().queue}));
                drop(state);
                engine.spawn_goal_scheduler();
                engine.goals.request(&cell.id);
                Ok(result)
            } else {
                if state.active.is_some() || state.compacting { return Err(Error::Conflict); }
                engine.check_turn_available(&cell,&state).await?;
                let previous_mode = data.configuration.options.interaction_mode;
                data.configuration.options.interaction_mode = configuration.options.interaction_mode;
                let mut source=state.thread.clone();source.desktop=Some(data);
                let (mut candidate,mut turn)=engine.prepare_turn(&source,request.input)?;
                if let Some(mode) = request.interaction_mode { turn.configuration.get_or_insert_with(Default::default).options.interaction_mode = mode; *candidate.turns.last_mut().unwrap() = turn.clone(); }
                candidate.desktop.as_mut().unwrap().configuration.options.interaction_mode = previous_mode;
                let permit=engine.reserve_active_turn()?;
                let result=json!({"turn":turn});
                remember(candidate.desktop.as_mut().unwrap(),&identity,&request.request_id,method,hash,result.clone());
                engine.persist(&candidate).await?;state.thread=candidate;
                engine.activate(&cell,&mut state,&turn,engine.shutdown.child_token(),permit);
                Ok(result)
            }
        }).await
    }
    /// 队列转移、历史消息和受理收据同快照落盘；通知只发生在持久化成功后。
    pub async fn steer_queue(
        self: &Arc<Self>,
        identity: String,
        request: QueueSteer,
    ) -> Result<Value> {
        self.mutate(move |engine| async move {
            let cell = engine.cell(&request.thread_id).await?;
            let mut state = cell.state.lock().await;
            let method = "areal/queue/steer";
            let hash = digest(&request)?;
            let data = desktop(&state.thread);
            if let Some(result) = receipt(&data, &identity, &request.request_id, method, &hash)? {
                return Ok(result);
            }
            if state.poisoned || data.archived || data.queue.revision != request.expected_revision {
                return Err(Error::Conflict);
            }
            let index = data.queue.items.iter().position(|item| item.id == request.queue_item_id).ok_or(Error::NotFound)?;
            if data.queue.items[index].status != "pending" { return Err(Error::Conflict); }
            let (mut candidate, item, permit) = engine.prepare_steer(&state, &request.expected_turn_id, data.queue.items[index].input.clone())?;
            let next = candidate.desktop.get_or_insert_with(Default::default);
            next.queue.items[index].status = "steered".into();
            next.queue.items[index].turn_id = Some(request.expected_turn_id.clone());
            next.queue.revision += 1;
            let result = json!({"queueRevision": next.queue.revision, "queueItemId": request.queue_item_id, "turnId": request.expected_turn_id, "itemId": item.id()});
            remember(next, &identity, &request.request_id, method, hash, result.clone());
            engine.persist(&candidate).await?;
            state.thread = candidate;
            emit_item(&cell, "item/started", &request.thread_id, &request.expected_turn_id, &item);
            emit_item(&cell, "item/completed", &request.thread_id, &request.expected_turn_id, &item);
            engine.goal_emit(&cell, &state.thread);
            cell.emit("areal/queue/updated", json!({"threadId": request.thread_id, "queue": state.thread.desktop.as_ref().unwrap().queue}));
            permit.send(false);
            Ok(result)
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
                engine.spawn_goal_scheduler();
                engine.goals.request(&cell.id);
            }
            Ok(queue)
        })
        .await
    }
    pub(crate) async fn advance_thread(self: &Arc<Self>, cell: &Arc<Cell>) -> Result<()> {
        let _gate = self.desktop.lifecycle.gate.lock().await;
        let mut state = cell.state.lock().await;
        if state.active.is_some() || state.compacting || !self.accepting_work() || state.poisoned {
            return Ok(());
        }
        let data = desktop(&state.thread);
        let index = data.queue.items.iter().position(|i| i.status == "pending");
        let automatic = index.is_none()
            && state
                .thread
                .goals
                .goal
                .as_ref()
                .is_some_and(|g| g.status == areal_protocol::goals::GoalStatus::Active);
        if automatic && !self.task_allows_continuation(&state.thread).await {
            return Ok(());
        }
        if (index.is_some() && data.queue.paused) || (index.is_none() && !automatic) {
            return Ok(());
        }
        let prepared = async {
            self.check_turn_available(cell, &state).await?;
            let mut source = state.thread.clone();
            self.refresh_goal_usage(&mut source);
            let input = if let Some(index) = index {
                source.desktop.get_or_insert_with(Default::default).configuration = data.queue.items[index].configuration.clone();
                data.queue.items[index].input.clone()
            } else { vec![Input::text("Continue the active goal from confirmed evidence and remaining work. This automatic continuation adds no new user authorization. Report progress or completion with goal_update.")] };
            let (mut candidate, mut turn) = self.prepare_turn(&source, input)?;
            if automatic { if let Some(goal) = &mut turn.goal { goal.origin = "continuation".into(); } *candidate.turns.last_mut().unwrap() = turn.clone(); }
            if let Some(index) = index {
                turn.configuration.get_or_insert_with(Default::default).options.interaction_mode = data.queue.items[index].configuration.options.interaction_mode;
                *candidate.turns.last_mut().unwrap() = turn.clone();
                let next = candidate.desktop.as_mut().unwrap(); next.configuration = data.configuration.clone(); next.queue.items[index].status = "running".into(); next.queue.items[index].turn_id = Some(turn.id.clone()); next.queue.revision += 1;
            }
            let permit = self.reserve_active_turn()?;
            Ok::<_, Error>((candidate, turn, permit))
        }.await;
        match prepared {
            Ok((candidate, turn, permit)) => {
                self.persist_dispatch(cell, &mut state, &candidate).await?;
                state.thread = candidate;
                self.goal_emit(cell, &state.thread);
                self.activate(cell, &mut state, &turn, self.shutdown.child_token(), permit);
            }
            Err(Error::Exhausted(ref error)) if error.starts_with("active Turn capacity") => {
                let mut candidate = state.thread.clone();
                if let Some(goal) = &mut candidate.goals.goal
                    && !goal.waiting_for_capacity
                {
                    goal.waiting_for_capacity = true;
                    candidate.goals.event_sequence += 1;
                    self.persist_dispatch(cell, &mut state, &candidate).await?;
                    state.thread = candidate;
                    self.goal_emit(cell, &state.thread);
                }
                // 容量释放唤醒整个有界候选集合；这里不自唤醒形成忙循环。
                self.goals.defer(&state.thread.id);
            }
            Err(error) => {
                let mut candidate = state.thread.clone();
                if let Some(goal) = &mut candidate.goals.goal
                    && goal.status == areal_protocol::goals::GoalStatus::Active
                {
                    goal.status = areal_protocol::goals::GoalStatus::Blocked;
                    goal.reason = Some(error.to_string());
                    goal.waiting_for_capacity = false;
                    candidate.goals.revision += 1;
                    candidate.goals.event_sequence += 1;
                }
                if index.is_some() {
                    let queue = &mut candidate.desktop.as_mut().unwrap().queue;
                    queue.paused = true;
                    queue.pause_reason = Some(error.to_string());
                    queue.revision += 1;
                }
                self.persist_dispatch(cell, &mut state, &candidate).await?;
                state.thread = candidate;
                self.goal_emit(cell, &state.thread);
            }
        }
        if let Some(data) = &state.thread.desktop {
            cell.emit(
                "areal/queue/updated",
                json!({"threadId":state.thread.id,"queue":data.queue}),
            );
        }
        Ok(())
    }

    // 自动派发没有外部调用者承接错误；保存失败必须明确停止并禁止重放。
    async fn persist_dispatch(
        &self,
        cell: &Cell,
        state: &mut State,
        candidate: &Thread,
    ) -> Result<()> {
        if let Err(error) = self.persist(candidate).await {
            state.poisoned = true;
            state.thread.status = ThreadStatus::SystemError;
            if let Some(goal) = &mut state.thread.goals.goal {
                goal.status = areal_protocol::goals::GoalStatus::Failed;
                goal.reason = Some("storageFailure".into());
                state.thread.goals.revision += 1;
                state.thread.goals.event_sequence += 1;
            }
            self.goal_emit(cell, &state.thread);
            return Err(error);
        }
        Ok(())
    }
}
