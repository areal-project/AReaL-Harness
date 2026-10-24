use super::*;
use areal_protocol::delegation::ExecutionRef;

impl Engine {
    pub(crate) async fn spawn_task_worker(
        self: &Arc<Self>,
        parent: &Cell,
        args: &Value,
    ) -> Result<Value> {
        let input: Vec<Input> = if let Some(input) = args.get("input") {
            serde_json::from_value(input.clone()).map_err(invalid)?
        } else {
            vec![Input::text(
                args["prompt"]
                    .as_str()
                    .ok_or_else(|| invalid("prompt required"))?,
            )]
        };
        if input.iter().map(|item| item.as_text().len()).sum::<usize>() > 32000 {
            return Err(invalid("task worker input exceeds 32000 bytes"));
        }
        let parent_id = parent.id.clone();
        let requested_rounds = args["maxModelRounds"].as_u64();
        let exclusive_write = args["intent"] == "modify";
        let inspection = args["intent"] == "inspect";
        let configured_request = if let Some(intent) = args["intent"].as_str() {
            if !matches!(intent, "inspect" | "modify") {
                return Err(invalid("unsupported task worker intent"));
            }
            Some(
                serde_json::from_value::<areal_protocol::desktop::AgentSpawn>(json!({
                    "parentThreadId": parent_id,
                    "input": input,
                    "workspaceMode": self.shared_delegation_mode(exclusive_write),
                    "agentProfile": args["agentProfile"],
                    "model": args["model"],
                    "instructions": args["instructions"],
                    "skills": args["skills"],
                    "toolAllowlist": args["toolAllowlist"],
                }))
                .map_err(invalid)?,
            )
        } else {
            None
        };
        self.mutate(move |engine| async move {
            let _gate=engine.desktop.lifecycle.gate.lock().await;
            let parent=engine.cell(&parent_id).await?;
            let state=parent.state.lock().await;
            let active=state.active.as_ref().filter(|a|!a.cancel.is_cancelled()&&!a.sealed).ok_or(Error::Conflict)?;
            if parent.research || parent.depth!=0 || state.thread.goal_owner.is_some() || engine.limits.max_agent_depth==0 {
                return Err(invalid("only the TaskRun coordinator may create task workers"));
            }
            let goal=state.thread.goals.goal.as_ref().filter(|g|g.status==GoalStatus::Active).ok_or(Error::Conflict)?;
            let mut configuration=engine.child_configuration(&state.thread,configured_request.as_ref())?.unwrap_or_default();
            let deferred_write=inspection && engine.inspection_inherits_permissions() && !configuration.read_only;
            validate_input(&input,&engine.configured_model(&configuration)?.capabilities())?;
            if exclusive_write && configuration.read_only {return Err(invalid("parent/profile does not authorize a shared writer"));}
            let rounds=requested_rounds.map(|n|n as usize).or(configuration.options.max_model_rounds);
            if rounds.is_some_and(|rounds| rounds==0 || rounds>1024 || configuration.options.max_model_rounds.is_some_and(|n|rounds>n)) {
                return Err(invalid("worker model rounds exceed parent limit"));
            }
            if !state.thread.dynamic_tools.is_empty() {return Err(invalid("task workers require server-owned tools; client callbacks cannot be detached"));}
            let (task_id,run_id)={
                let tasks=engine.task_modes.state.lock().await;
                let (task,run)=tasks.tasks.values().find_map(|t|t.runs.iter().find(|r|r.goal_id.as_deref()==Some(&goal.id)).map(|r|(t,r))).ok_or(Error::NotFound)?;
                if (task.paused && task.mode != TaskMode::Scheduled) || task.cancelled || run.reason.as_deref()==Some("stopRequested") {return Err(Error::Conflict);}
                if run.workers.len()>=engine.limits.max_children_per_turn {return Err(Error::Exhausted("TaskRun worker capacity reached".into()));}
                (task.id.clone(),run.id.clone())
            };
            configuration.options.max_model_rounds=rounds;
            if configuration.options.interaction_mode == InteractionMode::Interactive { configuration.options.interaction_mode=InteractionMode::Asynchronous; }
            let definitions=engine.visible_tools(&parent,&configuration,true,&state.thread).await;
            configuration.tool_allowlist=Some(definitions.iter().filter_map(|d|d["function"]["name"].as_str())
                .filter(|n|!matches!(*n,"task_spawn"|"task_wait"|"goal_update"|"agent_spawn"|"agent_spawn_configured"|"delegate_tasks"))
                .map(str::to_owned).collect());
            configuration.instructions.push_str("\nYou are a TaskRun worker. Perform only the assigned work and return evidence. Your lifetime is owned by the TaskRun, independent of its coordinator's current Turn. Do not delegate, change the root goal, or suspend the coordinator. Task channel replies are available for inspection.");
            let permit=engine.reserve_active_turn()?;
            let (thread,_)=engine.create_inner(state.thread.cwd.clone(),None,None,vec![],None,Some(areal_protocol::desktop::DesktopState{configuration,execution_policy:areal_protocol::delegation::ChildExecutionPolicy{exclusive_write,deferred_write},..Default::default()}),true).await?;
            let worker=engine.raw_cell(&thread.id).await?;
            let mut worker_state=worker.state.lock().await;
            let mut source=worker_state.thread.clone();
            source.source="nativeTaskAgent".into();
            source.goal_owner=Some(GoalOwner{thread_id:parent_id.clone(),goal_id:goal.id.clone()});
            let (candidate,turn)=engine.prepare_turn(&source,input)?;
            engine.persist(&candidate).await?;
            let mut tasks=engine.task_modes.state.lock().await;
            let mut next=tasks.clone();
            let task=next.tasks.get_mut(&task_id).ok_or(Error::NotFound)?;
            if (task.paused && task.mode != TaskMode::Scheduled) || task.cancelled || active.cancel.is_cancelled() || task.runs.iter().find(|r|r.id==run_id).is_none_or(|r|r.reason.as_deref()==Some("stopRequested")) {return Err(Error::Conflict);}
            task.runs.iter_mut().find(|r|r.id==run_id).ok_or(Error::NotFound)?.workers.push(TaskWorker{
                thread_id:thread.id.clone(),turn_id:turn.id.clone(),status:"running".into(),settled:false,
                execution:Some(ExecutionRef::Thread{thread_id:thread.id.clone(),turn_id:turn.id.clone()}),execution_id:None,
            });
            task.revision+=1;
            engine.save_tasks(&mut tasks,next,&task_id,true).await?;
            drop(tasks);
            worker_state.thread=candidate;
            engine.activate(&worker,&mut worker_state,&turn,engine.shutdown.child_token(),permit);
            Ok(json!({"taskId":task_id,"runId":run_id,"threadId":thread.id,"turnId":turn.id,"status":"running","lifetime":"taskRun"}))
        })
        .await
    }

    pub(crate) async fn task_workers_ready(&self, cell: &Cell, successful: bool) -> Result<()> {
        let thread = cell.state.lock().await.thread.clone();
        self.task_workers_settled(&thread, successful).await
    }

    pub(crate) async fn task_workers_settled(
        &self,
        thread: &Thread,
        successful: bool,
    ) -> Result<()> {
        let Some(goal) = thread.goals.goal.as_ref() else {
            return Ok(());
        };
        let snapshot = self.task_modes.state.lock().await.clone();
        let workers = if let Some(run) = snapshot
            .tasks
            .values()
            .flat_map(|task| &task.runs)
            .find(|run| run.goal_id.as_deref() == Some(&goal.id))
        {
            run.workers.clone()
        } else {
            if snapshot.cold_run(Some(&goal.id), None)?.is_some() {
                return Err(Error::Conflict);
            }
            Vec::new()
        };
        for worker in &workers {
            let outcome = self.task_worker_outcome(&thread.id, worker, false).await?;
            if !worker.settled
                || outcome.is_none_or(|(status, _)| successful && status != "completed")
            {
                return Err(invalid(
                    "TaskRun workers must settle successfully before completion",
                ));
            }
        }
        Ok(())
    }

    pub(super) async fn settle_task_workers(self: &Arc<Self>, task: &Task) -> Result<()> {
        let Some(run) = task.runs.last() else {
            return Ok(());
        };
        // 只等待该 TaskRun 所属会话的创建回执，不阻塞其他任务的委派。
        if let Some(thread_id) = &run.thread_id {
            let parent = self.cell(thread_id).await?;
            let creation = parent.delegation_creation.lock().await;
            drop(creation);
        }
        if run.workers.is_empty() {
            return Ok(());
        }
        let goal = if let Some(thread) = &run.thread_id {
            self.goal_get(thread).await?
        } else {
            Value::Null
        };
        let stop = (task.paused && task.mode != TaskMode::Scheduled)
            || task.cancelled
            || run.reason.as_deref() == Some("stopRequested")
            || goal["goal"]["status"] != "active"
            || goal["goal"]["id"].as_str() != run.goal_id.as_deref();
        let owner_thread = run.thread_id.as_deref().ok_or(Error::Conflict)?;
        if stop {
            // 先通知全部执行，再读取结算；未知后端不能阻止其他 worker 收到取消。
            let mut failure = None;
            for worker in run.workers.iter().filter(|worker| !worker.settled) {
                if let Err(error) = self.cancel_task_worker(owner_thread, worker).await {
                    failure.get_or_insert(error);
                }
            }
            if let Some(error) = failure {
                return Err(error);
            }
        }
        for worker in &run.workers {
            if worker.settled {
                continue;
            }
            if !stop && let Some(execution_id) = &worker.execution_id {
                let projection = self.execution_read(owner_thread, execution_id).await?;
                if projection["status"] == "awaitingDelivery"
                    && self
                        .raw_cell(owner_thread)
                        .await?
                        .state
                        .lock()
                        .await
                        .active
                        .is_none()
                {
                    // 隔离执行已经结束，但写回需要活跃轮次承接权限与取消边界。
                    // 唤醒原协调者继续交付，不能把候选视作完成或再次派发 worker。
                    let snapshot = self.task_modes.state.lock().await.clone();
                    let existed = snapshot
                        .message_exists(&task.id, &format!("{execution_id}:delivery-ready"))?;
                    self.edit_task(&task.id, |task| {
                        let run = task.runs.iter_mut().find(|candidate| candidate.id == run.id).unwrap();
                        run.wait_requested = false;
                        let message_id = format!("{execution_id}:delivery-ready");
                        if !existed && !task.messages.iter().any(|message| message.id == message_id) {
                            task.channel_sequence += 1;
                            task.messages.push(ChannelMessage {
                                id:message_id, sequence:task.channel_sequence, run_id:run.id.clone(), author:execution_id.clone(),
                                kind:"workerReport".into(), status:"published".into(), created_at:now(), expires_at:None,
                                questions:vec![], required:false, in_reply_to:None, answers:None,
                                text:format!("Execution {execution_id} has a completed isolated candidate awaiting delivery. Continue its delivery in this Run; do not dispatch the work again."),
                            });
                        }
                    }).await?;
                    continue;
                }
                self.finish_execution_delivery(owner_thread, execution_id)
                    .await?;
            }
            let Some((status, report)) =
                self.task_worker_outcome(owner_thread, worker, stop).await?
            else {
                continue;
            };
            let execution = worker
                .execution_ref()
                .ok_or_else(|| invalid("TaskRun worker has no execution reference"))?;
            let author = match &execution {
                ExecutionRef::Thread { thread_id, .. } => thread_id.clone(),
                ExecutionRef::Workgroup { workgroup_id, .. } => format!("workgroup:{workgroup_id}"),
            };
            self.edit_task(&task.id, |task| {
                let run = task
                    .runs
                    .iter_mut()
                    .find(|candidate| candidate.id == run.id)
                    .unwrap();
                let w = run
                    .workers
                    .iter_mut()
                    .find(|worker| worker.execution_ref().as_ref() == Some(&execution))
                    .unwrap();
                // 调度和显式查询可能同时观察终态，同一结果只能发布一次。
                if w.settled {
                    return;
                }
                w.status = status.clone();
                w.settled = true;
                run.wait_requested = false;
                {
                    task.channel_sequence += 1;
                    task.messages.push(ChannelMessage {
                        id: id(),
                        sequence: task.channel_sequence,
                        run_id: run.id.clone(),
                        author,
                        kind: "workerReport".into(),
                        status: "published".into(),
                        created_at: now(),
                        expires_at: None,
                        questions: vec![],
                        required: false,
                        in_reply_to: None,
                        answers: None,
                        text: format!("Worker {status}: {report}"),
                    });
                }
            })
            .await?;
        }
        Ok(())
    }

    async fn cancel_task_worker(&self, owner_thread: &str, worker: &TaskWorker) -> Result<()> {
        if let Some(execution_id) = &worker.execution_id {
            let value = self.execution_read(owner_thread, execution_id).await?;
            if value["settled"] == true && value["resourcesReleased"] == true {
                return Ok(());
            }
        }
        match worker
            .execution_ref()
            .ok_or_else(|| invalid("TaskRun worker has no execution reference"))?
        {
            ExecutionRef::Thread { thread_id, turn_id } => {
                let cell = self.raw_cell(&thread_id).await?;
                let mut state = cell.state.lock().await;
                if let Some(active) = &mut state.active {
                    if active.id != turn_id {
                        return Err(Error::Conflict);
                    }
                    active.sealed = true;
                    active.cancel.cancel();
                }
            }
            ExecutionRef::Workgroup {
                workgroup_id,
                automatic,
            } => {
                self.execution_workgroups(automatic)?
                    .cancel(&workgroup_id, None)
                    .await
                    .map_err(invalid)?;
            }
        }
        Ok(())
    }

    async fn task_worker_outcome(
        &self,
        owner_thread: &str,
        worker: &TaskWorker,
        stopped: bool,
    ) -> Result<Option<(String, String)>> {
        if let Some(execution_id) = &worker.execution_id {
            let value = self.execution_read(owner_thread, execution_id).await?;
            if stopped
                && value["status"] == "awaitingDelivery"
                && value["resourcesReleased"] == true
            {
                return Ok(Some((
                    "cancelled".into(),
                    "Isolated candidate retained; delivery cancelled".into(),
                )));
            }
            if value["status"] == "unknown"
                || (value["settled"] == true && value["resourcesReleased"] != true)
            {
                return Err(invalid(
                    "TaskRun worker outcome or cleanup is UNKNOWN; inspect before continuing",
                ));
            }
            if value["settled"] != true {
                return Ok(None);
            }
            return Ok(Some((
                value["status"]
                    .as_str()
                    .ok_or_else(|| invalid("execution status is missing"))?
                    .into(),
                tools::prefix(
                    &json!({
                        "executionId": execution_id,
                        "text": value["text"],
                        "error": value["error"],
                        "verification": value["verification"],
                        "delivery": value["delivery"],
                        "artifact": value["artifact"],
                    })
                    .to_string(),
                    4096,
                )
                .into(),
            )));
        }
        match worker
            .execution_ref()
            .ok_or_else(|| invalid("TaskRun worker has no execution reference"))?
        {
            ExecutionRef::Thread { thread_id, turn_id } => {
                let cell = self.raw_cell(&thread_id).await?;
                let state = cell.state.lock().await;
                if let Some(active) = &state.active {
                    if active.id != turn_id {
                        return Err(Error::Conflict);
                    }
                    return Ok(None);
                }
                if state.poisoned || state.quarantined_admission.is_some() {
                    return Err(invalid("TaskRun worker cleanup is unconfirmed"));
                }
                let turn = state
                    .thread
                    .turns
                    .iter()
                    .find(|turn| turn.id == turn_id)
                    .ok_or(Error::NotFound)?;
                let status = match turn.status {
                    TurnStatus::Completed => "completed",
                    TurnStatus::Interrupted => "cancelled",
                    TurnStatus::InProgress => return Ok(None),
                    _ => "failed",
                };
                let report = turn
                    .items
                    .iter()
                    .rev()
                    .find_map(|item| match item {
                        Item::AgentMessage { text, .. } => {
                            Some(tools::prefix(text, 4096).to_owned())
                        }
                        _ => None,
                    })
                    .unwrap_or_default();
                Ok(Some((status.into(), report)))
            }
            ExecutionRef::Workgroup {
                workgroup_id,
                automatic,
            } => {
                let service = self.execution_workgroups(automatic)?;
                let value = service.read(&workgroup_id, None).await.map_err(invalid)?;
                let record = &value["record"];
                let status = record["status"]
                    .as_str()
                    .ok_or_else(|| invalid("Workgroup status is missing"))?;
                if status == "running" {
                    return Ok(None);
                }
                if status == "unknown" || record["cleanupConfirmed"] != true {
                    return Err(invalid(
                        "TaskRun isolated worker outcome or cleanup is UNKNOWN; inspect before continuing",
                    ));
                }
                let summary = crate::workgroup::tools::summary(&value);
                Ok(Some((
                    status.into(),
                    tools::prefix(&summary.to_string(), 4096).to_owned(),
                )))
            }
        }
    }
}
