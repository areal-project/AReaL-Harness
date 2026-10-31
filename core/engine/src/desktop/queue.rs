use super::*;

impl Engine {
    pub async fn submit_turn(
        self: &Arc<Self>,
        identity: String,
        request: TurnSubmit,
    ) -> Result<Value> {
        let hash = digest(&request)?;
        {
            let cell = self.cell(&request.thread_id).await?;
            let state = cell.state.lock().await;
            if let Some(result) = receipt(
                &desktop(&state.thread),
                &identity,
                &request.request_id,
                "areal/turn/submit",
                &hash,
            )? {
                return Ok(result);
            }
        }
        self.refresh_plugins().await?;
        self.mutate(move |engine| async move {
            let _gate = engine.desktop.lifecycle.gate.lock().await;
            let cell = engine.cell(&request.thread_id).await?;
            let mut state = cell.state.lock().await;
            let method = "areal/turn/submit";
            let mut data = desktop(&state.thread);
            if let Some(result) = receipt(&data, &identity, &request.request_id, method, &hash)? {
                return Ok(result);
            }
            if !engine.accepting_work() { return Err(Error::Closed); }
            let _ordinary = engine.ordinary_admission(&state.thread).await?;
            if state.thread.is_read_only_side() || state.thread.goals.goal.is_some()
                || state.thread.goal_owner.is_some()
                || state.poisoned || state.compacting || data.archived
                || data.configuration.revision != request.expected_config_revision
                || state.active.as_ref().is_some_and(|active| active.cancel.is_cancelled() || active.sealed)
            { return Err(Error::Conflict); }
            if data.configuration.profile.as_ref().is_some_and(|profile| profile.workflow.is_some())
                || data.configuration.options.append_instructions.starts_with("AREAL_TASK_DRAFT_V1\n")
            { return Err(invalid("ordinary submit requires an ordinary conversation profile")); }
            engine.check_turn_available(&cell, &state).await?;
            if state.thread.is_side() && !matches!(&request.intent, TurnSubmitIntent::Message { .. }) {
                return Err(invalid("SIDE_POLICY_VIOLATION"));
            }
            let command = match &request.intent {
                TurnSubmitIntent::Message { command, .. } | TurnSubmitIntent::Edit { command, .. } => command.clone(),
                TurnSubmitIntent::Continue { .. } => None,
            };
            let pending = data.queue.items.iter().any(|item| item.status == "pending");
            let mut edit_source = None;
            let (input, continued_from) = match request.intent {
                TurnSubmitIntent::Message { input, command } => (engine.expand_plugin_command(input, command.as_ref()).await?, None),
                TurnSubmitIntent::Edit { expected_turn_id, item_id, input, command } => {
                    if state.active.is_some()
                        || data.queue.items.iter().any(|item| matches!(item.status.as_str(), "pending" | "running"))
                        || state.thread.turns.last().is_none_or(|turn| turn.id != expected_turn_id)
                    { return Err(Error::Conflict); }
                    // Rebuild from authoritative history, including compacted input.
                    // Discard summaries as they may contain the replaced response.
                    let mut source = engine.store.hydrate(state.thread.clone()).await
                        .map_err(|error| Error::Storage(error.to_string()))?;
                    let (turn_index, item_index) = source.turns.iter().enumerate().rev()
                        .filter(|(_, turn)| turn.continued_from_turn_id.is_none() && turn.goal.is_none())
                        .find_map(|(at, turn)| turn.items.iter().rposition(|item| matches!(item, Item::UserMessage { .. })).map(|index| (at, index)))
                        .ok_or(Error::Conflict)?;
                    if source.turns[turn_index].items[item_index].id() != item_id {
                        return Err(Error::Conflict);
                    }
                    source.turns.truncate(turn_index + 1);
                    source.turns[turn_index].items.truncate(item_index);
                    if item_index == 0 { source.turns.pop(); }
                    source.context_checkpoint = None;
                    if source.turns.is_empty() { source.preview.clear(); }
                    edit_source = Some(source);
                    (engine.expand_plugin_command(input, command.as_ref()).await?, None)
                }
                TurnSubmitIntent::Continue { expected_turn_id } => {
                    if state.active.is_some() { return Err(Error::Conflict); }
                    let turn = state.thread.turns.last().ok_or(Error::Conflict)?;
                    let recovery = turn.error.as_ref().and_then(|error| error.outcome.as_ref())
                        .is_some_and(|outcome| outcome.source == "core_recovery" && outcome.code == "HARNESS_INTERNAL_ERROR"
                            && outcome.details.as_ref().and_then(|details| details.get("reason")).and_then(Value::as_str) == Some("unknown_tool_outcome"));
                    if turn.id != expected_turn_id || !(turn.status == TurnStatus::Interrupted
                        || turn.status == TurnStatus::Failed && (turn.interruption.is_some() || recovery))
                    { return Err(Error::Conflict); }
                    (vec![Input::text("Continue the unfinished work in this conversation using the recorded history and the current workspace. Check the current state before acting. Do not replay operations whose outcomes are unknown.")], Some(expected_turn_id))
                }
            };
            let queued = pending || state.active.is_some();
            let mut result;
            let mut accepted_configuration = None;
            let mut candidate;
            let mut activation = None;
            if queued {
                let queue_item = if continued_from.is_none() {
                    if data.queue.items.len() >= 128 { return Err(Error::Exhausted("queue history capacity reached".into())); }
                    let mut configuration = engine.next_request_configuration(data.configuration.clone());
            engine.check_configuration_plugin_profile(&configuration)?;
                    engine.select_plugin_attachments(&mut configuration, &input, true)?;
                    let configuration = engine.freeze_configuration(configuration);
                    engine.validate_thread_input(&state.thread, &input, &engine.configured_model(&configuration)?.capabilities())?;
                    accepted_configuration = Some(configuration.clone());
                    let item = QueueItem {queued_at_ms:Some(crate::execution_trace::now_ms()), id: id(), input, configuration, submitted_by: identity.clone(), status: "pending".into(), turn_id: None };
                    let item_id = item.id.clone();
                    data.queue.items.push(item);
                    Some(item_id)
                } else { None };
                data.queue.paused = false;
                data.queue.pause_reason = None;
                data.queue.revision += 1;
                result = json!({"queueRevision": data.queue.revision, "configRevision": data.configuration.revision,
                    "queueItemId": queue_item});
                candidate = state.thread.clone();
                candidate.desktop = Some(data);
            } else {
                let (mut prepared, mut turn) = engine.prepare_turn(edit_source.as_ref().unwrap_or(&state.thread), input)?;
                turn.continued_from_turn_id = continued_from;
                *prepared.turns.last_mut().unwrap() = turn.clone();
                let queue = &mut prepared.desktop.get_or_insert_with(Default::default).queue;
                if queue.paused {
                    queue.paused = false;
                    queue.pause_reason = None;
                    queue.revision += 1;
                }
                let permit = engine.reserve_active_turn()?;
                accepted_configuration = turn.configuration.clone();
                result = json!({"turn": turn});
                candidate = prepared;
                activation = Some((turn, permit));
            }
            if let Some(configuration) = accepted_configuration {
                engine.remember_accepted_model(&mut candidate, &configuration)?;
                result["lastAcceptedModel"] = json!(candidate.desktop.as_ref().unwrap().last_accepted_model);
            }
            if let Some(command) = command { result["command"] = json!(command); }
            remember(candidate.desktop.as_mut().unwrap(), &identity, &request.request_id, method, hash, result.clone());
            engine.persist(&candidate).await?;
            state.thread = candidate;
            if edit_source.is_some() {
                // A deletion is explicit, unlike partial turn/completed events.
                cell.emit("areal/thread/edited", json!({"threadId": request.thread_id, "thread": state.thread}));
            }
            cell.emit("areal/queue/updated", json!({"threadId": request.thread_id, "queue": state.thread.desktop.as_ref().unwrap().queue}));
            if let Some((turn, permit)) = activation {
                engine.activate(&cell, &mut state, &turn, engine.shutdown.child_token(), permit);
            } else {
                drop(state);
                engine.spawn_goal_scheduler();
                engine.goals.request(&cell.id);
            }
            Ok(result)
        }).await
    }
    pub async fn start_durable(
        self: &Arc<Self>,
        identity: String,
        request: TurnStart,
        enqueue: bool,
    ) -> Result<Value> {
        self.start_durable_inner(identity, request, enqueue, None)
            .await
    }
    pub(super) async fn start_durable_with_skill(
        self: &Arc<Self>,
        identity: String,
        request: TurnStart,
        skill: VersionRef,
    ) -> Result<Value> {
        self.start_durable_inner(identity, request, false, Some(skill))
            .await
    }
    async fn start_durable_inner(
        self: &Arc<Self>,
        identity: String,
        request: TurnStart,
        enqueue: bool,
        skill: Option<VersionRef>,
    ) -> Result<Value> {
        self.refresh_plugins().await?;
        self.mutate(move |engine| async move {
            let _gate = engine.desktop.lifecycle.gate.lock().await;
            if !engine.accepting_work() { return Err(Error::Closed); }
            let cell = engine.cell(&request.thread_id).await?;
            let mut state = cell.state.lock().await;
            engine.ensure_hook_session_open(&cell,&state.thread)?;
            if state.thread.is_read_only_side() && (enqueue || request.interaction_mode.is_some() || request.input.len() != 1 || !matches!(&request.input[0], Input::Text { .. })) {
                return Err(invalid("SIDE_POLICY_VIOLATION"));
            }
            let method = if enqueue {"areal/turn/enqueue"} else {"areal/turn/start"};
            let hash = digest(&request)?;
            let mut data = desktop(&state.thread);
            if let Some(result) = receipt(&data,&identity,&request.request_id,method,&hash)? { return Ok(result); }
            if !enqueue && data.queue.items.iter().any(|item| matches!(item.status.as_str(), "pending" | "running")) { return Err(Error::Conflict); }
            if state.poisoned || state.thread.parent_thread_id.is_some() || state.thread.source == "nativeTaskAgent" { return Err(Error::Conflict); }
            if request.expected_config_revision.is_some_and(|revision| revision != data.configuration.revision) { return Err(Error::Conflict); }
            // 锁顺序为 lifecycle → Thread → Tasks；持久化和激活完成前保留 Task 预留锁。
            let _ordinary = if let Some(guard) = &request.admission_guard {
                if !guard.ordinary_session { return Err(invalid("ordinary admission requires ordinarySession=true")); }
                if enqueue {
                    let expected = guard.expected_turn_id.as_deref().filter(|id| !id.is_empty()).ok_or_else(|| invalid("ordinary enqueue requires expectedTurnId"))?;
                    if state.active.as_ref().is_none_or(|active| active.id != expected) { return Err(Error::Conflict); }
                }
                if guard.config_revision != data.configuration.revision || data.archived
                    // Pause controls queued work, not a new explicit turn when
                    // no queued work remains. Never resume or bypass retained items.
                    || (!enqueue && data.queue.items.iter().any(|item| matches!(item.status.as_str(), "pending" | "running")))
                { return Err(Error::Conflict); }
                if data.configuration.profile.as_ref().is_some_and(|profile| profile.workflow.is_some()) {
                    return Err(invalid("UNSUPPORTED_PROFILE: ordinary sessions cannot use a Workflow profile"));
                }
                Some(engine.ordinary_admission(&state.thread).await?)
            } else { None };
            let original_configuration = data.configuration.clone();
            if let Some(skill) = &skill {
                if state.thread.is_read_only_side() { return Err(invalid("setup requires an ordinary session")); }
                let mut scope = data.configuration.clone(); scope.selected_skills = None;
                if !engine.effective_skill_refs(&scope,false).contains(skill) { return Err(invalid("setup skill is outside the effective profile")); }
                data.configuration.selected_skills = Some(vec![skill.clone()]);
            }
            let mut configuration = engine.next_request_configuration(data.configuration.clone());
            engine.check_configuration_plugin_profile(&configuration)?;
            if skill.is_none() {
                engine.select_plugin_attachments(&mut configuration, &request.input, !state.thread.is_read_only_side() && state.thread.parent_thread_id.is_none() && state.thread.source != "nativeTaskAgent")?;
            }
            let mut configuration = engine.freeze_configuration(configuration);
            if let Some(mode) = request.interaction_mode { configuration.options.interaction_mode = mode; }
            engine.validate_thread_input(&state.thread,&request.input,&engine.configured_model(&configuration)?.capabilities())?;
            let accepted_configuration = configuration.clone();
            if enqueue {
                if data.queue.items.len()>=128 { return Err(Error::Exhausted("queue history capacity reached".into())); }
                let item = QueueItem {queued_at_ms:Some(crate::execution_trace::now_ms()),id:id(),input:request.input,configuration,submitted_by:identity.clone(),status:"pending".into(),turn_id:None};
                data.queue.revision+=1;
                let mut result = json!({"queueItemId":item.id,"queueRevision":data.queue.revision,"configRevision":item.configuration.revision});
                data.queue.items.push(item);
                let mut candidate=state.thread.clone();candidate.desktop=Some(data);
                if skill.is_none() {
                    engine.remember_accepted_model(&mut candidate, &accepted_configuration)?;
                    result["lastAcceptedModel"] = json!(candidate.desktop.as_ref().unwrap().last_accepted_model);
                }
                remember(candidate.desktop.as_mut().unwrap(),&identity,&request.request_id,method,hash,result.clone());
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
                if state.thread.is_read_only_side() && let Some(areal_protocol::Conversation::Side { origin, .. }) = &state.thread.conversation {
                    engine.check_side_capacity(&origin.source_thread_id, Some(&state.thread.id)).await?;
                }
                engine.check_turn_available(&cell,&state).await?;
                let previous_mode = data.configuration.options.interaction_mode;
                data.configuration.options.interaction_mode = configuration.options.interaction_mode;
                let mut source=state.thread.clone();source.desktop=Some(data);
                let (mut candidate,mut turn)=engine.prepare_turn_from_configuration(&source,request.input,skill.as_ref(),configuration)?;
                if let Some(mode) = request.interaction_mode { turn.configuration.get_or_insert_with(Default::default).options.interaction_mode = mode; *candidate.turns.last_mut().unwrap() = turn.clone(); }
                candidate.desktop.as_mut().unwrap().configuration.options.interaction_mode = previous_mode;
                if skill.is_some() { candidate.desktop.as_mut().unwrap().configuration = original_configuration; }
                let permit=engine.reserve_active_turn()?;
                let mut result=json!({"turn":turn});
                if skill.is_none() {
                    engine.remember_accepted_model(&mut candidate, &accepted_configuration)?;
                    result["lastAcceptedModel"] = json!(candidate.desktop.as_ref().unwrap().last_accepted_model);
                }
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
            let state = cell.state.lock().await;
            if state.thread.is_read_only_side() { return Err(invalid("SIDE_POLICY_VIOLATION")); }
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
            let input=data.queue.items[index].input.clone();
            drop(engine.prepare_steer(&state,&request.expected_turn_id,input.clone())?);
            let cancel=state.active.as_ref().ok_or(Error::Conflict)?.cancel.clone();
            drop(state);
            engine.plugin_hooks_user_input(&cell,&input,&cancel).await?;
            let mut state=cell.state.lock().await;
            let data=desktop(&state.thread);
            if let Some(result)=receipt(&data,&identity,&request.request_id,method,&hash)?{return Ok(result);}
            if state.poisoned || data.archived || data.queue.revision!=request.expected_revision {return Err(Error::Conflict);}
            let index=data.queue.items.iter().position(|item|item.id==request.queue_item_id&&item.status=="pending").ok_or(Error::Conflict)?;
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
        self.ensure_hook_session_open(cell, &state.thread)?;
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
        if state.thread.turns.iter().flat_map(|turn| &turn.items).any(|item| matches!(item,
            Item::DynamicToolCall { execution, .. } if execution.inspection.is_none()
                && execution.plugin.as_ref().is_some_and(|plugin| plugin.operations.iter().any(|op| op.outcome == areal_protocol::ToolOutcome::Unknown))))
            || state.thread.desktop.as_ref().is_some_and(|data| data.hook_runs.iter().any(|hook| hook.outcome == "unknown" && hook.inspection.is_none()))
        { return Err(invalid("UNKNOWN requires operator inspection")); }
        if state.thread.desktop.as_ref().is_some_and(|data| {
            data.processes.iter().any(|process| {
                !process.cleanup_confirmed
                    && (process.state == "unknown"
                        || state.active.is_none() && process.lifetime == "turn")
            })
        }) {
            return Err(invalid(
                "UNKNOWN process cleanup requires operator inspection",
            ));
        }
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
            engine.ensure_hook_session_open(&cell, &state.thread)?;
            if state.thread.is_read_only_side() {
                return Err(invalid("SIDE_POLICY_VIOLATION"));
            }
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
                        engine.validate_thread_input(
                            &state.thread,
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
        self.refresh_plugins().await?;
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
        if automatic && !self.task_allows_continuation(&state.thread).await? {
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
            let (mut candidate, mut turn) = if let Some(index) = index {
                self.prepare_turn_from_configuration(&source, input, None, data.queue.items[index].configuration.clone())?
            } else { self.prepare_turn(&source, input)? };
            if automatic { if let Some(goal) = &mut turn.goal { goal.origin = "continuation".into(); } *candidate.turns.last_mut().unwrap() = turn.clone(); }
            if let Some(index) = index {
                turn.trace.queued_at_ms = data.queue.items[index].queued_at_ms;
                turn.trace.queue_duration_ms = turn.trace.queued_at_ms.map(|start| crate::execution_trace::now_ms().saturating_sub(start).max(0) as u64);
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
                state.active.as_mut().unwrap().hook_user_input = index.is_some();
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
