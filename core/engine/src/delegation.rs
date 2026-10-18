//! 委派门面只持久化身份和创建回执，状态从 Thread 或隔离执行器读取。
use crate::*;
use areal_protocol::{delegation::*, desktop::AgentSpawn};
use sha2::{Digest, Sha256};

fn invalid(error: impl std::fmt::Display) -> Error {
    Error::Invalid(error.to_string())
}
fn owner_key(owner: &ExecutionOwner) -> String {
    match owner {
        ExecutionOwner::Turn { thread_id, turn_id } => format!("{thread_id}/{turn_id}"),
        ExecutionOwner::TaskRun {
            task_id, run_id, ..
        } => format!("task:{task_id}/{run_id}"),
    }
}
fn parent_id(owner: &ExecutionOwner) -> &str {
    match owner {
        ExecutionOwner::Turn { thread_id, .. } | ExecutionOwner::TaskRun { thread_id, .. } => {
            thread_id
        }
    }
}

impl Engine {
    pub fn attach_automatic_workgroups(
        &self,
        service: Arc<workgroup::service::Service>,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            !service.is_strict(),
            "automatic service must not advertise trusted verification"
        );
        self.automatic_workgroups
            .set(service)
            .map_err(|_| anyhow::anyhow!("automatic service already attached"))
    }
    pub(crate) fn execution_workgroups(
        &self,
        automatic: bool,
    ) -> Result<&Arc<workgroup::service::Service>> {
        (if automatic {
            self.automatic_workgroups.get()
        } else {
            self.workgroups.get()
        })
        .ok_or_else(|| invalid("isolated execution is unavailable in this deployment"))
    }
    pub(crate) async fn workspace_delivery_guard(&self) -> tokio::sync::OwnedRwLockWriteGuard<()> {
        self.workspace_gate.clone().write_owned().await
    }

    pub(crate) async fn ensure_workspace_processes_settled(&self) -> Result<()> {
        if let Some(runtime) = &self.runtime {
            let scope: areal_runtime_protocol::ScopeInfo = runtime
                .client
                .call(
                    "scope.get",
                    json!({"scopeId":runtime.client.info().root_scope_id}),
                )
                .await
                .map_err(invalid)?;
            if scope.active_processes != 0 {
                return Err(invalid(
                    "workspace is busy: settle active Runtime processes before exclusive source access",
                ));
            }
        }
        Ok(())
    }

    pub(crate) async fn owns_execution_group(
        &self,
        thread_id: &str,
        group_id: &str,
        automatic: bool,
        owner: &str,
    ) -> Result<bool> {
        let cell = self.cell(thread_id).await?;
        let records = cell
            .state
            .lock()
            .await
            .thread
            .desktop
            .as_ref()
            .map(|d| d.executions.clone())
            .unwrap_or_default();
        for record in records {
            if record.execution
                != Some(ExecutionRef::Workgroup {
                    workgroup_id: group_id.into(),
                    automatic,
                })
                || owner_key(&record.owner) != owner
            {
                continue;
            }
            match record.owner {
                ExecutionOwner::Turn {
                    thread_id: parent, ..
                } => return Ok(parent == thread_id),
                ExecutionOwner::TaskRun {
                    task_id,
                    run_id,
                    thread_id: parent,
                    goal_id,
                } => {
                    return self
                        .task_execution_owner_valid(&ExecutionOwner::TaskRun {
                            task_id,
                            run_id,
                            thread_id: parent,
                            goal_id,
                        })
                        .await;
                }
            }
        }
        Ok(false)
    }

    async fn save_execution(&self, parent: &str, mut record: ExecutionRecord) -> Result<()> {
        let cell = self.cell(parent).await?;
        let mut state = cell.state.lock().await;
        let mut candidate = state.thread.clone();
        let records = &mut candidate
            .desktop
            .get_or_insert_with(Default::default)
            .executions;
        if let Some(previous) = records
            .iter_mut()
            .find(|r| r.execution_id == record.execution_id)
        {
            // 创建回执可能晚于取消落盘，后到的旧副本不能重新打开交付。
            record.cancel_requested |= previous.cancel_requested;
            *previous = record;
        } else {
            if records.len() >= 10000 {
                return Err(Error::Exhausted(
                    "execution history capacity reached".into(),
                ));
            }
            records.push(record);
        }
        self.persist(&candidate).await?;
        state.thread = candidate;
        Ok(())
    }

    pub(crate) async fn execution_record(
        &self,
        parent: &str,
        execution_id: &str,
    ) -> Result<ExecutionRecord> {
        let cell = self.cell(parent).await?;
        let state = cell.state.lock().await;
        state
            .thread
            .desktop
            .as_ref()
            .and_then(|d| d.executions.iter().find(|r| r.execution_id == execution_id))
            .cloned()
            .ok_or(Error::NotFound)
    }

    pub(crate) async fn execution_group_cancel_requested(
        &self,
        parent: &str,
        group: &str,
        automatic: bool,
    ) -> Result<bool> {
        let cell = self.cell(parent).await?;
        let state = cell.state.lock().await;
        Ok(state.thread.desktop.as_ref().is_some_and(|data| data.executions.iter().any(|record| {
            record.cancel_requested && matches!(&record.execution, Some(ExecutionRef::Workgroup { workgroup_id, automatic: mode }) if workgroup_id == group && *mode == automatic)
        })))
    }

    pub(crate) async fn validate_execution_owner(
        &self,
        record: &ExecutionRecord,
        turn_id: &str,
    ) -> Result<()> {
        let valid = match &record.owner {
            ExecutionOwner::Turn { turn_id: owner, .. } => owner == turn_id,
            owner @ ExecutionOwner::TaskRun { .. } => {
                self.task_execution_owner_valid(owner).await?
            }
        };
        if valid {
            Ok(())
        } else {
            Err(invalid("execution belongs to another owner"))
        }
    }

    pub async fn delegate(self: &Arc<Self>, request: DelegationRequest) -> Result<Value> {
        self.mutate(move |engine| async move { engine.delegate_inner(request).await })
            .await
    }

    async fn delegate_inner(self: &Arc<Self>, request: DelegationRequest) -> Result<Value> {
        // 序列化创建与重复请求；不跨执行、等待或模型请求持锁。
        let serial = self.delegation_creation.lock().await;
        if request.request_id.is_empty()
            || request.request_id.len() > 128
            || request.input.is_empty()
            || request.writes.len() > 256
            || request
                .writes
                .iter()
                .any(|p| !workgroup::tree::valid_path(p))
            || request.writes.iter().collect::<HashSet<_>>().len() != request.writes.len()
        {
            return Err(invalid("invalid delegation request or write scope"));
        }
        let hash = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&request).map_err(invalid)?)
        );
        let parent = self.cell(&request.parent_thread_id).await?;
        if parent.exclusive_writer {
            return Err(invalid(
                "an exclusive writer cannot recursively delegate; return a handoff to its coordinator",
            ));
        }
        let (turn_id, configuration) = {
            let state = parent.state.lock().await;
            if let Some(existing) = state.thread.desktop.as_ref().and_then(|d| {
                d.executions
                    .iter()
                    .find(|r| r.request_id == request.request_id)
            }) {
                if existing.request_hash != hash {
                    return Err(invalid(
                        "requestId reused with different delegation arguments",
                    ));
                }
                let execution_id = existing.execution_id.clone();
                drop(state);
                drop(serial);
                return self
                    .execution_read(&request.parent_thread_id, &execution_id)
                    .await;
            }
            let active = state
                .active
                .as_ref()
                .filter(|a| !a.sealed && !a.cancel.is_cancelled())
                .ok_or(Error::Conflict)?;
            if parent.depth >= self.limits.max_agent_depth
                || active.children.len() + active.isolated_children
                    >= self.limits.max_children_per_turn
            {
                return Err(Error::Exhausted("child admission exhausted".into()));
            }
            (
                active.id.clone(),
                self.child_configuration(&state.thread, None)?
                    .unwrap_or_default(),
            )
        };
        if let Some(error) = self
            .goal_tool_guard(&parent, "agent_spawn")
            .await
            .map_err(invalid)?
        {
            return Err(invalid(error));
        }
        validate_input(
            &request.input,
            &self.configured_model(&configuration)?.capabilities(),
        )?;
        if request
            .input
            .iter()
            .map(Input::as_text)
            .map(|text| text.len())
            .sum::<usize>()
            > 32000
        {
            return Err(invalid("delegation input exceeds 32000 bytes"));
        }
        if request.intent == Intent::Modify && request.delivery == Delivery::Report {
            return Err(invalid("modification must deliver changes or a patch"));
        }
        if request.intent == Intent::Inspect
            && (request.delivery != Delivery::Report
                || !request.writes.is_empty()
                || request.require_trusted_checks)
        {
            return Err(invalid("inspection cannot request source changes"));
        }
        if request.intent == Intent::Modify
            && (configuration.read_only || self.runtime.as_ref().is_none_or(|r| !r.writable))
        {
            return Err(invalid("parent and Runtime must authorize source writes"));
        }
        if request.max_model_rounds.is_some_and(|n| {
            n == 0
                || n > 1024
                || configuration
                    .options
                    .max_model_rounds
                    .is_some_and(|m| n > m)
        }) {
            return Err(invalid("model rounds exceed parent boundary"));
        }
        let owner = self
            .task_run_owner(&parent)
            .await?
            .unwrap_or_else(|| ExecutionOwner::Turn {
                thread_id: request.parent_thread_id.clone(),
                turn_id: turn_id.clone(),
            });
        let required = request.delivery == Delivery::Patch || request.require_trusted_checks;
        let wants_isolated = request.intent == Intent::Modify && (required || request.independent);
        let automatic = !request.require_trusted_checks && self.workgroups.get().is_none();
        let mut reason = if request.intent == Intent::Inspect {
            "inspection uses narrowed shared read-only tools"
        } else {
            "coupled or environment-dependent work uses one shared writer"
        }
        .to_owned();
        let mut isolated = false;
        if wants_isolated {
            let availability: anyhow::Result<()> = async {
                anyhow::ensure!(
                    !request.requires_current_environment,
                    "task requires the current host environment"
                );
                anyhow::ensure!(
                    !request.writes.is_empty(),
                    "isolation requires an explicit bounded source change set"
                );
                let service = self
                    .execution_workgroups(automatic)
                    .map_err(anyhow::Error::from)?;
                anyhow::ensure!(
                    !request.require_trusted_checks || service.is_strict(),
                    "trusted checks are unavailable"
                );
                anyhow::ensure!(
                    Path::new(&parent.state.lock().await.thread.cwd).canonicalize()?
                        == service.workspace(),
                    "isolated service workspace differs from task workspace"
                );
                service.validate_start(&workgroup::service::Start {
                    request_id: request.request_id.clone(),
                    plan: workgroup::Plan {
                        objective: "delegation capability check".into(),
                        tasks: vec![workgroup::Task {
                            id: "child".into(),
                            instruction: "capability check".into(),
                            writes: request.writes.clone(),
                            depends: vec![],
                            integration_depends: vec![],
                            checks: vec![],
                            configuration: None,
                        }],
                    },
                    workers: Some(1),
                    admission: workgroup::Admission::Fixed,
                })?;
                let root = service.workspace().to_owned();
                // 文件表示能力是硬约束；复制失败不能变成运行中静默降级。
                tokio::task::spawn_blocking(move || workgroup::tree::snapshot(&root)).await??;
                service.probe_availability().await?;
                Ok(())
            }
            .await;
            match availability {
                Ok(()) => {
                    isolated = true;
                    reason="independent source changes or candidate delivery require an isolated workspace".into();
                }
                Err(error)
                    if matches!(
                        error.downcast_ref::<workgroup::service::AvailabilityError>(),
                        Some(workgroup::service::AvailabilityError::CleanupUnknown(_))
                    ) =>
                {
                    return Err(invalid(format!(
                        "isolated capability probe did not settle: {error}"
                    )));
                }
                Err(error) if required => {
                    return Err(invalid(format!(
                        "required execution guarantee unavailable: {error}"
                    )));
                }
                Err(error) => {
                    reason = format!("shared exclusive writer selected before execution: {error}")
                }
            }
        }
        let mut record = ExecutionRecord {
            execution_id: id(),
            request_id: request.request_id.clone(),
            request_hash: hash,
            owner: owner.clone(),
            title: request
                .input
                .iter()
                .map(Input::as_text)
                .collect::<Vec<_>>()
                .join("\n")
                .chars()
                .take(160)
                .collect(),
            delivery: request.delivery,
            strategy: if isolated {
                "isolated"
            } else if request.intent == Intent::Inspect {
                "sharedReadOnly"
            } else {
                "sharedExclusive"
            }
            .into(),
            reason,
            execution: None,
            error: None,
            cancel_requested: false,
        };
        // 创建意图先落盘，丢失响应时只读取原执行，不再派发。
        self.save_execution(&request.parent_thread_id, record.clone())
            .await?;
        let execution: Result<ExecutionRef> = async {
            if isolated {
                let service = self.execution_workgroups(automatic)?.clone();
                let key = owner_key(&owner);
                let group_id = workgroup::service::Service::request_id(&key, &request.request_id)
                    .map_err(invalid)?;
                let reference = ExecutionRef::Workgroup {
                    workgroup_id: group_id,
                    automatic,
                };
                let configured = AgentSpawn {
                    parent_thread_id: request.parent_thread_id.clone(),
                    input: request.input.clone(),
                    writes: Some(request.writes.clone()),
                    workspace_mode: Some("isolatedWrite".into()),
                    agent_profile: request.agent_profile.clone(),
                    instructions: request.instructions.clone(),
                    skills: request.skills.clone(),
                    model: request.model.clone(),
                    tool_allowlist: request.tool_allowlist.clone(),
                };
                let child = {
                    let state = parent.state.lock().await;
                    self.child_configuration(&state.thread, Some(&configured))?
                        .unwrap()
                };
                if child.read_only {
                    return Err(invalid("profile does not authorize a writer"));
                }
                let mut instruction = child.instructions.clone();
                for input in &request.input {
                    match input {
                        Input::Text { text, .. } => {
                            instruction.push('\n');
                            instruction.push_str(text)
                        }
                        _ => return Err(invalid("isolated tasks currently require text input")),
                    }
                }
                let plan = workgroup::Plan {
                    objective: record.title.clone(),
                    tasks: vec![workgroup::Task {
                        id: "child".into(),
                        instruction,
                        writes: request.writes.clone(),
                        depends: vec![],
                        integration_depends: vec![],
                        checks: vec![],
                        configuration: Some(workgroup::TaskConfiguration {
                            approval_tools: child.options.approval_tools,
                            system_prompt: child.options.system_prompt,
                            append_instructions: child.options.append_instructions,
                            max_model_rounds: request
                                .max_model_rounds
                                .or(child.options.max_model_rounds),
                            default_model_revision: child.default_model_revision,
                            agent_profile: child.profile.as_ref().map(|p| {
                                areal_protocol::desktop::VersionRef {
                                    id: p.id.clone(),
                                    revision: p.revision.clone(),
                                }
                            }),
                            model: child.model,
                            skills: child.selected_skills,
                            tool_allowlist: child.tool_allowlist,
                            read_only: false,
                        }),
                    }],
                };
                let start = workgroup::service::Start {
                    request_id: request.request_id.clone(),
                    plan,
                    workers: Some(1),
                    admission: workgroup::Admission::Fixed,
                };
                service.validate_start(&start).map_err(invalid)?;
                let token = {
                    let mut state = parent.state.lock().await;
                    let active = state
                        .active
                        .as_mut()
                        .filter(|a| a.id == turn_id && !a.sealed && !a.cancel.is_cancelled())
                        .ok_or(Error::Conflict)?;
                    active.isolated_children += 1;
                    if matches!(owner, ExecutionOwner::TaskRun { .. }) {
                        self.shutdown.child_token()
                    } else {
                        active.cancel.child_token()
                    }
                };
                let budget = self
                    .goal_for_owner(&format!("{}/{}", request.parent_thread_id, turn_id))
                    .await;
                // 冻结基线必须与当前工作区写入互斥；释放后作者在私有工作区运行。
                let _workspace = tokio::select! {biased;
                    _=token.cancelled()=>return Err(Error::Closed),
                    guard=self.workspace_gate.clone().write_owned()=>guard,
                };
                self.ensure_workspace_processes_settled().await?;
                record.execution = Some(reference.clone());
                self.save_execution(&request.parent_thread_id, record.clone())
                    .await?;
                if matches!(owner, ExecutionOwner::TaskRun { .. }) {
                    self.register_task_execution(&owner, &record.execution_id, &reference)
                        .await?;
                }
                service
                    .start_with_goal(key, start, token, budget)
                    .await
                    .map_err(invalid)?;
                if self
                    .execution_record(&request.parent_thread_id, &record.execution_id)
                    .await?
                    .cancel_requested
                    && let ExecutionRef::Workgroup { workgroup_id, .. } = &reference
                {
                    service
                        .cancel(workgroup_id, Some(&owner_key(&owner)))
                        .await
                        .map_err(invalid)?;
                }
                Ok(reference)
            } else if matches!(owner, ExecutionOwner::TaskRun { .. }) {
                let mut args = serde_json::to_value(&request).map_err(invalid)?;
                args["prompt"] = json!(
                    request
                        .input
                        .iter()
                        .map(Input::as_text)
                        .collect::<Vec<_>>()
                        .join("\n")
                );
                let result = self.spawn_task_worker(&parent, &args).await?;
                Ok(ExecutionRef::Thread {
                    thread_id: result["threadId"]
                        .as_str()
                        .ok_or_else(|| invalid("missing worker thread"))?
                        .into(),
                    turn_id: result["turnId"]
                        .as_str()
                        .ok_or_else(|| invalid("missing worker turn"))?
                        .into(),
                })
            } else {
                let configured = AgentSpawn {
                    parent_thread_id: request.parent_thread_id.clone(),
                    input: request.input.clone(),
                    writes: Some(request.writes.clone()),
                    workspace_mode: Some(
                        if request.intent == Intent::Inspect {
                            "sharedReadOnly"
                        } else {
                            "sharedWrite"
                        }
                        .into(),
                    ),
                    agent_profile: request.agent_profile.clone(),
                    instructions: request.instructions.clone(),
                    skills: request.skills.clone(),
                    model: request.model.clone(),
                    tool_allowlist: request.tool_allowlist.clone(),
                };
                let (thread, turn) = self
                    .spawn_delegated_child(
                        configured,
                        turn_id,
                        request.intent == Intent::Modify,
                        request.max_model_rounds,
                    )
                    .await?;
                Ok(ExecutionRef::Thread {
                    thread_id: thread.id,
                    turn_id: turn.id,
                })
            }
        }
        .await;
        match execution {
            Ok(reference) => {
                if matches!(owner, ExecutionOwner::TaskRun { .. }) {
                    self.register_task_execution(&owner, &record.execution_id, &reference)
                        .await?;
                }
                record.execution = Some(reference);
            }
            Err(error) => record.error = Some(error.to_string()),
        }
        self.save_execution(&request.parent_thread_id, record.clone())
            .await?;
        drop(serial);
        self.execution_read(&request.parent_thread_id, &record.execution_id)
            .await
    }

    pub async fn execution_read(&self, parent: &str, execution_id: &str) -> Result<Value> {
        self.execution_read_page(parent, execution_id, 0).await
    }
    pub async fn execution_read_page(
        &self,
        parent: &str,
        execution_id: &str,
        offset: usize,
    ) -> Result<Value> {
        let record = self.execution_record(parent, execution_id).await?;
        self.project_execution_page(&record, offset).await
    }
    async fn project_execution(&self, record: &ExecutionRecord) -> Result<Value> {
        self.project_execution_page(record, 0).await
    }
    async fn project_execution_page(
        &self,
        record: &ExecutionRecord,
        offset: usize,
    ) -> Result<Value> {
        if offset != 0 && !matches!(record.execution, Some(ExecutionRef::Thread { .. })) {
            return Err(invalid(
                "reply offset is only supported for shared executions; use execution/artifact for isolated files",
            ));
        }
        let mut value = json!({"executionId":record.execution_id,"parentThreadId":parent_id(&record.owner),"owner":record.owner,
            "title":record.title,"strategy":record.strategy,"reason":record.reason,"status":"unknown","settled":false,"resourcesReleased":false,
            "text":"","error":record.error,"stopRequested":record.cancel_requested,"verification":{"status":"notRun","kind":"none"},"delivery":{"status":"notRequired"}});
        if let Some(error) = &record.error
            && record.execution.is_none()
        {
            value["status"] = json!("failed");
            value["settled"] = json!(true);
            value["resourcesReleased"] = json!(true);
            value["error"] = json!(error);
            return Ok(value);
        }
        match &record.execution {
            Some(ExecutionRef::Thread { thread_id, turn_id }) => {
                let cell = self.cell(thread_id).await?;
                let state = cell.state.lock().await;
                let turn = state
                    .thread
                    .turns
                    .iter()
                    .find(|t| &t.id == turn_id)
                    .ok_or(Error::NotFound)?;
                let raw =
                    crate::agents::snapshot_turn(&state, turn_id, offset, 8192).map_err(invalid)?;
                value["threadId"] = json!(thread_id);
                value["turnId"] = json!(turn_id);
                value["status"] = json!(match turn.status {
                    TurnStatus::InProgress => "running",
                    TurnStatus::Completed => "completed",
                    TurnStatus::Interrupted => "cancelled",
                    TurnStatus::Failed => "failed",
                });
                for key in [
                    "settled",
                    "resourcesReleased",
                    "text",
                    "error",
                    "activity",
                    "partial",
                    "source",
                    "sourceItemId",
                    "offset",
                    "nextOffset",
                    "textBytes",
                    "maxModelRounds",
                    "threadStatus",
                    "stopRequested",
                ] {
                    value[key] = raw[key].clone();
                }
                if record.delivery == Delivery::Changes {
                    value["delivery"]["status"] = json!(if turn.status == TurnStatus::Completed
                        && raw["resourcesReleased"] == true
                    {
                        "applied"
                    } else {
                        "pending"
                    });
                }
            }
            Some(ExecutionRef::Workgroup {
                workgroup_id,
                automatic,
            }) => {
                let service = self.execution_workgroups(*automatic)?;
                let group = match service
                    .read(workgroup_id, Some(&owner_key(&record.owner)))
                    .await
                {
                    Ok(v) => v,
                    Err(error) => {
                        value["error"] = json!(format!("execution start outcome unknown: {error}"));
                        return Ok(value);
                    }
                };
                let state = &group["record"];
                let finished = matches!(
                    state["status"].as_str(),
                    Some("completed" | "failed" | "cancelled" | "unknown")
                );
                value["status"] = state["status"].clone();
                value["settled"] = json!(finished);
                value["resourcesReleased"] = json!(state["cleanupConfirmed"] == true);
                value["error"] = state["error"].clone();
                value["verification"] = json!({"status":if state["finalCheck"].is_null(){"notRun"}else if state["finalCheck"]["passed"]==true{"passed"}else{"failed"},"kind":if service.is_strict(){"trusted"}else{"none"}});
                value["delivery"]["status"] = json!(if state["status"] == "completed" {
                    "candidate"
                } else {
                    "pending"
                });
                value["artifact"] = json!({"head":state["head"],"workgroupId":workgroup_id});
                value["text"] = json!(format!(
                    "{}: {}",
                    record.title,
                    state["status"].as_str().unwrap_or("unknown")
                ));
                // 交付日志属于Core；执行完成与结果应用分别投影。
                let delivery = match self
                    .workgroup_delivery_status(workgroup_id, *automatic)
                    .await
                {
                    Ok(delivery) => delivery,
                    Err(error) => {
                        value["status"] = json!("unknown");
                        value["settled"] = json!(false);
                        value["resourcesReleased"] = json!(false);
                        value["error"] = json!(format!("delivery receipt unavailable: {error}"));
                        value["verification"] = json!({"status":"notRun","kind":if service.is_strict(){"trusted"}else{"none"}});
                        value["delivery"] = json!({"status":"unknown","error":value["error"],"retryPolicy":"inspectOnly"});
                        return Ok(value);
                    }
                };
                if !delivery.is_null() {
                    // 原候选的通过回执不能证明组合树；验收异常或中断时以交付日志为准。
                    value["verification"] = json!({"status":if delivery["verified"]==true{"passed"}else if delivery["verification"].is_null(){"notRun"}else{"failed"},"kind":if service.is_strict(){"trusted"}else{"none"},"head":delivery["head"]});
                    if matches!(
                        delivery["status"].as_str(),
                        Some("unknown" | "preparing" | "applying")
                    ) {
                        value["resourcesReleased"] = json!(false);
                    }
                    value["delivery"] = delivery;
                }
                if record.delivery == Delivery::Changes
                    && value["delivery"]["status"] != "applied"
                    && state["status"] == "completed"
                {
                    let terminal = matches!(
                        value["delivery"]["status"].as_str(),
                        Some("conflict" | "partial" | "unknown" | "failed")
                    );
                    value["status"] = json!(if terminal {
                        "failed"
                    } else {
                        "awaitingDelivery"
                    });
                    value["settled"] = json!(terminal);
                    if terminal {
                        value["error"] = value["delivery"]["error"].clone();
                    }
                }
                // 取消候选与交付回执分开：已发生的 applied/partial/unknown 不可被取消覆盖。
                if record.cancel_requested && value["delivery"]["status"] == "candidate" {
                    value["status"] = json!("cancelled");
                    value["settled"] = json!(state["cleanupConfirmed"] == true);
                    value["delivery"]["status"] = json!("cancelled");
                }
            }
            None => {
                value["error"] = json!(
                    "execution creation has no settled backend receipt; inspect before retrying"
                )
            }
        }
        Ok(value)
    }
    pub async fn execution_list(&self, parent: &str, offset: usize, limit: usize) -> Result<Value> {
        if limit == 0 || limit > 100 {
            return Err(invalid("limit must be 1..100"));
        }
        let cell = self.cell(parent).await?;
        let records = cell
            .state
            .lock()
            .await
            .thread
            .desktop
            .as_ref()
            .map(|d| d.executions.clone())
            .unwrap_or_default();
        if offset > records.len() {
            return Err(invalid("offset outside execution history"));
        }
        let mut data = Vec::new();
        for record in records.iter().skip(offset).take(limit) {
            data.push(self.project_execution(record).await?);
        }
        let next = offset + data.len();
        Ok(json!({"data":data,"nextOffset":(next<records.len()).then_some(next)}))
    }
    pub async fn execution_wait(
        self: &Arc<Self>,
        parent: &str,
        execution_id: &str,
        timeout_ms: u64,
    ) -> Result<Value> {
        if timeout_ms > 60000 {
            return Err(invalid("wait exceeds 60000 ms"));
        }
        let end = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let mut value = self.execution_read(parent, execution_id).await?;
            if value["settled"] == true
                || value["status"] == "awaitingDelivery"
                || tokio::time::Instant::now() >= end
            {
                value["timedOut"] =
                    json!(value["settled"] != true && value["status"] != "awaitingDelivery");
                return Ok(value);
            }
            tokio::select! {_ = self.shutdown.cancelled()=>return Err(Error::Closed),_ = tokio::time::sleep_until(end.min(tokio::time::Instant::now()+Duration::from_millis(100)))=>{}}
        }
    }
    pub(crate) async fn execution_wait_and_deliver(
        self: &Arc<Self>,
        parent: &str,
        execution_id: &str,
        timeout_ms: u64,
    ) -> Result<Value> {
        let value = self
            .execution_wait(parent, execution_id, timeout_ms)
            .await?;
        if value["status"] == "awaitingDelivery" {
            self.finish_execution_delivery(parent, execution_id).await?;
            return self.execution_read(parent, execution_id).await;
        }
        Ok(value)
    }
    pub async fn execution_cancel(
        self: &Arc<Self>,
        parent: &str,
        execution_id: &str,
        force: bool,
    ) -> Result<Value> {
        let parent = parent.to_owned();
        let execution_id = execution_id.to_owned();
        self.mutate(move |engine| async move {
            engine
                .execution_cancel_inner(&parent, &execution_id, force)
                .await
        })
        .await
    }
    async fn execution_cancel_inner(
        self: &Arc<Self>,
        parent: &str,
        execution_id: &str,
        force: bool,
    ) -> Result<Value> {
        let mut record = self.execution_record(parent, execution_id).await?;
        if record.execution.is_some() {
            record.cancel_requested = true;
            self.save_execution(parent, record.clone()).await?;
        }
        match &record.execution {
            Some(ExecutionRef::Thread { thread_id, turn_id }) => {
                let cell = self.cell(thread_id).await?;
                let grace = if force { 1000 } else { 60000 };
                self.store.save_audit(json!({"kind":"executionStopRequested","parentThreadId":parent,"executionId":execution_id,"threadId":thread_id,"turnId":turn_id,"graceMs":grace})).await.map_err(invalid)?;
                let mut pending = vec![cell.clone()];
                while let Some(node) = pending.pop() {
                    let children = {
                        let mut state = node.state.lock().await;
                        if node.id == *thread_id {
                            match state.active.as_ref() {
                                Some(active) if active.id != *turn_id => {
                                    return Err(Error::Conflict);
                                }
                                None => {
                                    drop(state);
                                    return self.execution_read(parent, execution_id).await;
                                }
                                _ => {}
                            }
                        }
                        node.cancel_grace_ms.store(grace, Ordering::Release);
                        if let Some(active) = state.active.as_mut() {
                            active.sealed = true;
                            active.children.clone()
                        } else {
                            Vec::new()
                        }
                    };
                    for child in children {
                        pending.push(self.cell(&child).await?);
                    }
                }
                self.interrupt(thread_id, turn_id).await?;
            }
            Some(ExecutionRef::Workgroup {
                workgroup_id,
                automatic,
            }) => {
                self.execution_workgroups(*automatic)?
                    .cancel(workgroup_id, Some(&owner_key(&record.owner)))
                    .await
                    .map_err(invalid)?;
            }
            None => {
                return Err(invalid(
                    "unknown creation outcome cannot be replayed or cancelled as a new task",
                ));
            }
        }
        self.execution_read(parent, execution_id).await
    }
    pub async fn execution_send_input(
        self: &Arc<Self>,
        parent: &str,
        execution_id: &str,
        prompt: String,
    ) -> Result<Value> {
        let record = self.execution_record(parent, execution_id).await?;
        match record.execution {
            Some(ExecutionRef::Thread { thread_id, turn_id }) => {
                self.steer_child_input(&thread_id, &turn_id, vec![Input::text(prompt)])
                    .await?
            }
            _ => {
                return Err(invalid(
                    "an isolated attempt has a frozen contract; cancel and delegate revised work after settlement",
                ));
            }
        }
        self.execution_read(parent, execution_id).await
    }
    pub async fn execution_artifact(
        &self,
        parent: &str,
        execution_id: &str,
        path: Option<String>,
        offset: usize,
    ) -> Result<Value> {
        let record = self.execution_record(parent, execution_id).await?;
        let Some(ExecutionRef::Workgroup {
            workgroup_id,
            automatic,
        }) = &record.execution
        else {
            return Err(invalid("execution has no isolated artifact"));
        };
        self.execution_workgroups(*automatic)?
            .artifact(workgroup_id, Some(&owner_key(&record.owner)), path, offset)
            .await
            .map_err(invalid)
    }
    pub async fn execution_apply(
        self: &Arc<Self>,
        parent: &str,
        execution_id: &str,
    ) -> Result<Value> {
        let parent = parent.to_owned();
        let execution_id = execution_id.to_owned();
        self.mutate(move |engine| async move {
            engine.execution_apply_inner(&parent, &execution_id).await
        })
        .await
    }
    async fn execution_apply_inner(
        self: &Arc<Self>,
        parent: &str,
        execution_id: &str,
    ) -> Result<Value> {
        let record = self.execution_record(parent, execution_id).await?;
        let Some(ExecutionRef::Workgroup {
            workgroup_id,
            automatic,
        }) = &record.execution
        else {
            return Err(invalid("execution has no isolated candidate"));
        };
        let group = self
            .execution_workgroups(*automatic)?
            .read(workgroup_id, Some(&owner_key(&record.owner)))
            .await
            .map_err(invalid)?;
        let delivery = self
            .apply_workgroup_artifact_from(
                parent,
                workgroup_id,
                group["record"]["head"]
                    .as_str()
                    .ok_or_else(|| invalid("candidate has no head"))?,
                *automatic,
            )
            .await?;
        let mut result = self.execution_read(parent, execution_id).await?;
        if delivery["status"] == "requiresActiveTurn" {
            result["delivery"] = delivery;
        }
        Ok(result)
    }
    pub(crate) async fn finish_execution_delivery(
        self: &Arc<Self>,
        parent: &str,
        execution_id: &str,
    ) -> Result<()> {
        let record = self.execution_record(parent, execution_id).await?;
        if record.delivery != Delivery::Changes || record.cancel_requested {
            return Ok(());
        }
        if let Some(ExecutionRef::Workgroup {
            workgroup_id,
            automatic,
        }) = &record.execution
        {
            let group = self
                .execution_workgroups(*automatic)?
                .read(workgroup_id, Some(&owner_key(&record.owner)))
                .await
                .map_err(invalid)?;
            if group["record"]["status"] == "completed"
                && group["record"]["cleanupConfirmed"] == true
            {
                self.apply_workgroup_artifact_from(
                    parent,
                    workgroup_id,
                    group["record"]["head"].as_str().unwrap_or(""),
                    *automatic,
                )
                .await?;
            }
        }
        Ok(())
    }
    pub(crate) async fn execution_completion_ready(&self, cell: &Cell) -> Result<()> {
        let (turn_id, records) = {
            let state = cell.state.lock().await;
            (
                state.active.as_ref().ok_or(Error::Conflict)?.id.clone(),
                state
                    .thread
                    .desktop
                    .as_ref()
                    .map(|d| d.executions.clone())
                    .unwrap_or_default(),
            )
        };
        for record in records
            .iter()
            .filter(|r| matches!(&r.owner,ExecutionOwner::Turn{turn_id:id,..} if *id==turn_id))
        {
            let value = self.project_execution(record).await?;
            if value["status"] != "completed"
                || value["settled"] != true
                || value["resourcesReleased"] != true
                || (record.delivery == Delivery::Changes
                    && value["delivery"]["status"] != "applied")
            {
                return Err(invalid(
                    "delegated execution and delivery must settle successfully before completing the goal",
                ));
            }
        }
        Ok(())
    }

    pub(crate) async fn settle_generation_groups(
        self: &Arc<Self>,
        cell: &Cell,
    ) -> anyhow::Result<Vec<Value>> {
        let mut values = self.settle_turn_executions(cell, false).await?;
        if let Some(service) = self.workgroups.get() {
            let owner = {
                let state = cell.state.lock().await;
                format!(
                    "{}/{}",
                    cell.id,
                    state.active.as_ref().ok_or(Error::Conflict)?.id
                )
            };
            values.extend(workgroup::tools::summaries(
                &service.settle_owner(&owner, false).await?,
            ));
        }
        Ok(values)
    }

    pub(crate) async fn settle_turn_executions(
        self: &Arc<Self>,
        cell: &Cell,
        cancel: bool,
    ) -> Result<Vec<Value>> {
        let (turn_id, records) = {
            let state = cell.state.lock().await;
            (
                state.active.as_ref().ok_or(Error::Conflict)?.id.clone(),
                state
                    .thread
                    .desktop
                    .as_ref()
                    .map(|d| d.executions.clone())
                    .unwrap_or_default(),
            )
        };
        let mut values = Vec::new();
        for record in records
            .iter()
            .filter(|r| matches!(&r.owner,ExecutionOwner::Turn{turn_id:id,..} if *id==turn_id))
        {
            if cancel {
                self.execution_cancel(&cell.id, &record.execution_id, true)
                    .await?;
            }
            if matches!(record.execution, Some(ExecutionRef::Workgroup { .. })) {
                loop {
                    if !cancel
                        && let Err(error) = self
                            .finish_execution_delivery(&cell.id, &record.execution_id)
                            .await
                    {
                        let mut value = self.execution_read(&cell.id, &record.execution_id).await?;
                        value["error"] = json!(format!("delivery is incomplete: {error}"));
                        values.push(value);
                        break;
                    }
                    let value = self
                        .execution_wait(&cell.id, &record.execution_id, 1000)
                        .await?;
                    if value["settled"] == true
                        || value["status"] == "unknown"
                        || value["status"] == "awaitingDelivery"
                    {
                        values.push(value);
                        break;
                    }
                    if self.shutdown.is_cancelled() {
                        return Err(Error::Closed);
                    }
                }
            }
        }
        Ok(values)
    }
}
