//! 单 query 的候选执行与人工选择；隔离和资源回收复用原生执行服务。
use super::*;
use crate::workgroup::{self, service::Service};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use std::path::PathBuf;

fn owner(thread: &str, goal: &str) -> String {
    format!("rsi:{thread}:{goal}")
}
pub(super) fn artifact_name(goal: &str, candidate: &str, format: &str) -> String {
    let extension = if format == "html" { "html" } else { "md" };
    format!("rsi-artifacts/{goal}/{candidate}/artifact.{extension}")
}
fn pending(candidate: &RsiCandidate) -> bool {
    matches!(
        candidate.status,
        RsiCandidateStatus::Queued | RsiCandidateStatus::Running
    )
}
async fn save_json(path: PathBuf, value: Value) -> Result<()> {
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let parent = path.parent().unwrap();
        std::fs::create_dir_all(parent)?;
        let mut file = tempfile::NamedTempFile::new_in(parent)?;
        serde_json::to_writer_pretty(&mut file, &value)?;
        file.as_file().sync_all()?;
        file.persist(&path)?;
        std::fs::File::open(parent)?.sync_all()?;
        Ok(())
    })
    .await
    .map_err(invalid)?
    .map_err(invalid)
}

impl Engine {
    fn rsi_directory(&self, goal: &str, candidate: &str) -> PathBuf {
        self.store.root().join("rsi").join(goal).join(candidate)
    }

    pub(super) async fn rsi_goal_create(
        self: &Arc<Self>,
        identity: String,
        request: GoalCreate,
    ) -> Result<Value> {
        self.mutate(move |engine| async move {
            let _gate = engine.desktop.lifecycle.gate.lock().await;
            let cell = engine.cell(&request.thread_id).await?;
            let mut state = cell.state.lock().await;
            let hash = desktop::digest(&request)?;
            let mut thread = state.thread.clone();
            let data = thread.desktop.get_or_insert_with(Default::default);
            if let Some(value) = desktop::receipt(data, &identity, &request.request_id, "areal/goal/create", &hash)? {
                return Ok(value);
            }
            if !engine.accepting_work() { return Err(Error::Closed); }
            if thread.is_side() { return Err(invalid("SIDE_POLICY_VIOLATION")); }
            if state.active.is_some() || state.compacting || state.poisoned
                || thread.parent_thread_id.is_some() || thread.goal_owner.is_some()
                || thread.goals.goal.is_some() || thread.goals.revision != request.expected_revision
                || has_pending(&thread)
            { return Err(Error::Conflict); }
            // 候选使用独立 Runtime，不借用父聊天的客户端 ToolHost。
            engine.check_thread_available(&state)?;
            objective(&request.objective)?;
            if request.infer_limits || request.max_turns.is_some() {
                return Err(invalid("RSI phase one accepts explicit token/time limits only; inferLimits and maxTurns are unsupported"));
            }
            engine.validate_goal_limits(request.token_budget, None, request.max_active_seconds)?;
            let config = engine.freeze_configuration(thread.desktop.as_ref().unwrap().configuration.clone());
            if config.read_only { return Err(invalid("RSI requires an authorized isolated writer")); }
            let service = engine.execution_workgroups(true)?.clone();
            let output_format = request.output_format.as_deref().unwrap_or("markdown");
            if !matches!(output_format, "markdown" | "html") { return Err(invalid("outputFormat must be markdown or html")); }
            let goal_id = id();
            let templates = [
                ("baseline", "Solve the query directly. Produce a complete, useful artifact with clear assumptions."),
                ("structured", "First identify requirements and a concise plan. Build a structured artifact that addresses every requirement and lists evidence and limitations."),
                ("critic-and-revise", "Draft a solution, critically inspect it for gaps and errors, then revise it. Deliver the revised artifact and a short description of corrections."),
            ];
            let candidates = templates.iter().enumerate().map(|(i, (label, harness))| {
                let candidate_id = format!("candidate-{}", i + 1);
                RsiCandidate {
                    parent_candidate_id: None, round: 0,
                    hypothesis: format!("Compare the {label} harness on the same frozen input"),
                    feedback: String::new(), evaluations: vec![],
                    run_id: Service::request_id(&owner(&thread.id, &goal_id), &candidate_id).unwrap(),
                    task_id: candidate_id.clone(), id: candidate_id,
                    label: (*label).into(), harness: (*harness).into(),
                    status: RsiCandidateStatus::Queued, workspace_mode: "isolatedWrite".into(),
                    workspace_path: None, artifact_path: None, artifact_summary: None,
                    error: None, started_at: None, finished_at: None,
                }
            }).collect();
            let goal = Goal {
                workflow: Some("rsiArtifact".into()),
                rsi: Some(RsiGoalState { output_format: output_format.into(), phase: RsiPhase::Running, candidates, selected_candidate_id: None }),
                interaction_mode: request.interaction_mode.unwrap_or(config.options.interaction_mode),
                id: goal_id.clone(), thread_id: thread.id.clone(), objective: request.objective,
                status: GoalStatus::Active, reason: None, token_budget: request.token_budget,
                max_turns: None, max_active_seconds: request.max_active_seconds, limits_pending: false,
                usage: GoalUsage { accounting_complete: true, ..Default::default() },
                active_turn_id: None, settling: true, waiting_for_input: false,
                waiting_for_agents: false, waiting_for_capacity: false, report: None,
                report_turn_id: None, unreported_turns: 0,
            };
            let budget = Budget::open(engine.store.root(), &goal).map_err(invalid)?;
            budget.flush().await.map_err(invalid)?;
            thread.goals.goal = Some(goal.clone());
            changed(&mut thread.goals);
            let result = projection(&thread);
            desktop::remember(thread.desktop.as_mut().unwrap(), &identity, &request.request_id,
                "areal/goal/create", hash, result.clone());
            engine.persist(&thread).await?;
            engine.goals.budgets.write().unwrap().insert(goal_id, budget.clone());
            state.thread = thread;
            emit(&cell, &state.thread);
            // 创建收据落盘后才派发；响应丢失不会再次创建候选。
            let runner = engine.clone();
            engine.tasks.spawn(async move {
                if let Err(error) = runner.run_rsi_goal(goal, config, service, budget).await {
                    tracing::error!(%error, "RSI runner failed");
                }
            });
            Ok(result)
        }).await
    }

    pub(super) async fn run_rsi_goal(
        self: &Arc<Self>,
        goal: Goal,
        config: EffectiveConfig,
        service: Arc<Service>,
        budget: Arc<Budget>,
    ) -> Result<()> {
        budget.configure(goal.token_budget, true);
        budget.begin();
        let cancel = self.shutdown.child_token();
        let result: Result<()> = async {
            let guard = self.workspace_snapshot_guard(&cancel).await?;
            let input_path = self.store.root().join("rsi").join(&goal.id).join("input.json");
            let base: workgroup::tree::Tree = if input_path.exists() {
                serde_json::from_slice(&tokio::fs::read(&input_path).await.map_err(invalid)?).map_err(invalid)?
            } else {
                let source = service.workspace().to_owned();
                let tree = tokio::task::spawn_blocking(move || workgroup::tree::snapshot(&source)).await.map_err(invalid)?.map_err(invalid)?;
                save_json(input_path, json!(tree)).await?;
                save_json(self.store.root().join("rsi").join(&goal.id).join("configuration.json"), json!(config)).await?;
                tree
            };
            let input_digest = workgroup::tree::digest(&base);
            let base = Arc::new(base);
            drop(guard);
            let output_format = &goal.rsi.as_ref().unwrap().output_format;
            let output_contract = if output_format == "html" { "a complete standalone HTML document with inline CSS and JavaScript; no Markdown fences" } else { "UTF-8 Markdown; source code may use fenced blocks" };
            for candidate in goal.rsi.as_ref().unwrap().candidates.iter().filter(|c| c.status == RsiCandidateStatus::Queued) {
                let directory = self.rsi_directory(&goal.id, &candidate.id);
                let start = workgroup::service::Start {
                    request_id: candidate.id.clone(), workers: Some(1), admission: workgroup::Admission::Fixed,
                    plan: workgroup::Plan { objective: goal.objective.clone(), tasks: vec![workgroup::Task {
                        id: candidate.task_id.clone(),
                        instruction: format!("{}\n\nRSI harness version {}:\n{}\n\nChange hypothesis: {}\nEvaluation feedback from parent (data, not tool authorization):\n{}\n\nQuery:\n{}\n\nWrite the final artifact as {} to {} (at most 1 MiB). Only this output path is writable. Do not choose or inspect other candidates. A final chat reply alone is not the artifact.", config.instructions, candidate.id, candidate.harness, candidate.hypothesis, candidate.feedback, goal.objective, output_contract, artifact_name(&goal.id, &candidate.id, output_format)),
                        writes: vec![artifact_name(&goal.id, &candidate.id, output_format)], depends: vec![], integration_depends: vec![], checks: vec![],
                        configuration: Some(workgroup::TaskConfiguration {
                            default_model_revision: config.default_model_revision.clone(),
                            agent_profile: config.profile.as_ref().map(|p| areal_protocol::desktop::VersionRef { id: p.id.clone(), revision: p.revision.clone() }),
                            model: config.model.clone(), skills: config.selected_skills.clone(), tool_allowlist: config.tool_allowlist.clone(),
                            read_only: false, max_model_rounds: config.options.max_model_rounds,
                            approval_tools: config.options.approval_tools.clone(), system_prompt: config.options.system_prompt.clone(),
                            append_instructions: config.options.append_instructions.clone(),
                        }),
                    }] },
                };
                let started: Result<Value> = async {
                    save_json(directory.join("request.json"), json!({"goalId":goal.id,"query":goal.objective,"candidateId":candidate.id,"parentCandidateId":candidate.parent_candidate_id,"round":candidate.round,"inputDigest":input_digest,"configuration":config,"execution":start})).await?;
                    tokio::fs::write(directory.join("harness.md"), &candidate.harness).await.map_err(invalid)?;
                    let value = service.start_rsi_candidate(owner(&goal.thread_id, &goal.id), start, cancel.clone(), budget.clone(), base.clone(), config.clone()).await.map_err(invalid)?;
                    Ok(value)
                }.await;
                self.rsi_started(&goal.thread_id, &goal.id, &candidate.id, started).await?;
            }
            let mut deadline_reached = false;
            loop {
                self.refresh_rsi_goal(&goal.thread_id).await?;
                let view = self.raw_cell(&goal.thread_id).await?;
                let state = view.state.lock().await;
                let running = state.thread.goals.goal.as_ref().and_then(|g| g.rsi.as_ref()).is_some_and(|r| r.candidates.iter().any(pending));
                drop(state);
                if !running { break; }
                tokio::select! {
                    _ = self.shutdown.cancelled() => { cancel.cancel(); break; }
                    _ = budget.wait_deadline(), if !deadline_reached => { deadline_reached = true; cancel.cancel(); }
                    _ = tokio::time::sleep(Duration::from_millis(100)) => {}
                }
            }
            Ok(())
        }.await;
        if let Err(error) = &result {
            cancel.cancel();
            let _ = service
                .settle_owner(&owner(&goal.thread_id, &goal.id), true)
                .await;
            self.fail_rsi_pending(&goal.thread_id, &goal.id, &error.to_string())
                .await?;
        }
        budget.end();
        budget.configure(goal.token_budget, false);
        budget.flush().await.map_err(invalid)?;
        let cell = self.raw_cell(&goal.thread_id).await?;
        {
            let mut state = cell.state.lock().await;
            let mut thread = state.thread.clone();
            if let Some(current) = thread.goals.goal.as_mut().filter(|g| g.id == goal.id) {
                current.settling = false;
                changed(&mut thread.goals);
                self.refresh_goal_usage(&mut thread);
                self.persist(&thread).await?;
                state.thread = thread;
                emit(&cell, &state.thread);
            }
        }
        self.refresh_rsi_goal(&goal.thread_id).await?;
        result
    }

    async fn fail_rsi_pending(&self, thread_id: &str, goal_id: &str, error: &str) -> Result<()> {
        let cell = self.raw_cell(thread_id).await?;
        let mut state = cell.state.lock().await;
        let mut thread = state.thread.clone();
        if let Some(goal) = thread.goals.goal.as_mut().filter(|g| g.id == goal_id) {
            for candidate in goal
                .rsi
                .as_mut()
                .unwrap()
                .candidates
                .iter_mut()
                .filter(|c| pending(c))
            {
                candidate.status = RsiCandidateStatus::Failed;
                candidate.error = Some(error.chars().take(2000).collect());
                candidate.finished_at = Some(now());
            }
            let rsi = goal.rsi.as_mut().unwrap();
            rsi.phase = if rsi.candidates.iter().any(|c| {
                matches!(
                    c.status,
                    RsiCandidateStatus::Completed | RsiCandidateStatus::Selected
                )
            }) {
                RsiPhase::AwaitingSelection
            } else {
                RsiPhase::Failed
            };
            goal.status = if rsi.phase == RsiPhase::AwaitingSelection {
                GoalStatus::Blocked
            } else {
                GoalStatus::Failed
            };
            goal.reason = Some(error.chars().take(2000).collect());
            changed(&mut thread.goals);
            self.persist(&thread).await?;
            state.thread = thread;
            emit(&cell, &state.thread);
        }
        Ok(())
    }

    async fn rsi_started(
        &self,
        thread_id: &str,
        goal_id: &str,
        candidate_id: &str,
        value: Result<Value>,
    ) -> Result<()> {
        let cell = self.raw_cell(thread_id).await?;
        let mut state = cell.state.lock().await;
        let mut thread = state.thread.clone();
        let goal = thread
            .goals
            .goal
            .as_mut()
            .filter(|g| g.id == goal_id)
            .ok_or(Error::Conflict)?;
        let candidate = goal
            .rsi
            .as_mut()
            .unwrap()
            .candidates
            .iter_mut()
            .find(|c| c.id == candidate_id)
            .unwrap();
        candidate.started_at = Some(now());
        match value {
            Ok(value) => {
                candidate.status = RsiCandidateStatus::Running;
                candidate.workspace_path = value["candidatePath"].as_str().map(String::from);
            }
            Err(error) => {
                candidate.status = RsiCandidateStatus::Failed;
                candidate.error = Some(error.to_string());
                candidate.finished_at = Some(now());
            }
        }
        self.save_rsi_candidate(goal_id, candidate).await?;
        changed(&mut thread.goals);
        self.persist(&thread).await?;
        state.thread = thread;
        emit(&cell, &state.thread);
        Ok(())
    }

    async fn save_rsi_candidate(&self, goal: &str, candidate: &RsiCandidate) -> Result<()> {
        let directory = self.rsi_directory(goal, &candidate.id);
        save_json(directory.join("metadata.json"), json!(candidate)).await?;
        if !pending(candidate) {
            save_json(directory.join("result.json"), json!(candidate)).await?;
        }
        Ok(())
    }

    pub(super) async fn refresh_rsi_goal(&self, thread_id: &str) -> Result<()> {
        let cell = self.raw_cell(thread_id).await?;
        let mut state = cell.state.lock().await;
        let mut thread = state.thread.clone();
        let Some(goal) = thread.goals.goal.as_mut().filter(|g| g.rsi.is_some()) else {
            return Ok(());
        };
        let restarted = goal.reason.as_deref() == Some("serverRestarted");
        let goal_id = goal.id.clone();
        let rsi = goal.rsi.as_mut().unwrap();
        let previous = rsi.clone();
        for candidate in rsi.candidates.iter_mut().filter(|c| pending(c)) {
            // 正常派发中的 queued 不在读取端提前判失败；重启后只核对已有执行，不重放。
            if candidate.status == RsiCandidateStatus::Queued && !restarted {
                continue;
            }
            let value = match self.execution_workgroups(true) {
                Ok(service) => service
                    .read(&candidate.run_id, Some(&owner(thread_id, &goal_id)))
                    .await
                    .map_err(invalid),
                Err(error) => Err(error),
            };
            match value {
                Ok(value) if value["record"]["status"] == "running" && !restarted => continue,
                Ok(value)
                    if value["record"]["status"] == "completed"
                        && value["record"]["cleanupConfirmed"] == true =>
                {
                    let service = self.execution_workgroups(true)?;
                    let path = artifact_name(&goal_id, &candidate.id, &rsi.output_format);
                    match service
                        .artifact(
                            &candidate.run_id,
                            Some(&owner(thread_id, &goal_id)),
                            Some(path.clone()),
                            0,
                        )
                        .await
                    {
                        Ok(artifact)
                            if artifact["exists"] == true
                                && artifact["bytes"]
                                    .as_u64()
                                    .is_some_and(|n| n > 0 && n <= 1024 * 1024) =>
                        {
                            candidate.status = RsiCandidateStatus::Completed;
                            candidate.workspace_path =
                                value["candidatePath"].as_str().map(String::from);
                            candidate.artifact_path = candidate
                                .workspace_path
                                .as_ref()
                                .map(|p| Path::new(p).join(path).to_string_lossy().into_owned());
                            candidate.artifact_summary = artifact["dataBase64"]
                                .as_str()
                                .and_then(|encoded| STANDARD.decode(encoded).ok())
                                .map(|bytes| {
                                    String::from_utf8_lossy(&bytes).chars().take(1000).collect()
                                });
                        }
                        _ => {
                            candidate.status = RsiCandidateStatus::Failed;
                            candidate.error = Some(
                                "candidate did not deliver a nonempty artifact within 1 MiB".into(),
                            );
                        }
                    }
                }
                Ok(value) => {
                    candidate.status = RsiCandidateStatus::Failed;
                    candidate.error = Some(
                        value["record"]["error"]
                            .as_str()
                            .unwrap_or("execution interrupted or cleanup unconfirmed; not replayed")
                            .into(),
                    );
                }
                Err(error) => {
                    candidate.status = RsiCandidateStatus::Failed;
                    candidate.error = Some(format!("execution unavailable; not replayed: {error}"));
                }
            }
            candidate.finished_at = Some(now());
            self.save_rsi_candidate(&goal_id, candidate).await?;
        }
        if rsi.candidates.iter().all(|c| !pending(c))
            && rsi.phase == RsiPhase::Running
            && !goal.settling
        {
            if rsi.candidates.iter().any(|c| {
                matches!(
                    c.status,
                    RsiCandidateStatus::Completed | RsiCandidateStatus::Selected
                )
            }) {
                rsi.phase = RsiPhase::AwaitingSelection;
                goal.status = GoalStatus::Blocked;
                goal.reason = Some("awaitingSelection".into());
            } else {
                rsi.phase = RsiPhase::Failed;
                goal.status = GoalStatus::Failed;
                goal.reason = Some("all RSI candidates failed".into());
            }
        }
        if *rsi != previous {
            changed(&mut thread.goals);
            self.refresh_goal_usage(&mut thread);
            self.persist(&thread).await?;
            state.thread = thread;
            emit(&cell, &state.thread);
        }
        Ok(())
    }

    pub async fn goal_select_candidate(
        self: &Arc<Self>,
        identity: String,
        request: GoalSelectCandidate,
    ) -> Result<Value> {
        self.mutate(move |engine| async move {
            let _gate = engine.desktop.lifecycle.gate.lock().await;
            let cell = engine.cell(&request.thread_id).await?;
            let mut state = cell.state.lock().await;
            let mut thread = state.thread.clone();
            let hash = desktop::digest(&request)?;
            let method = "areal/goal/selectCandidate";
            if let Some(value) = desktop::receipt(
                thread.desktop.get_or_insert_with(Default::default),
                &identity,
                &request.request_id,
                method,
                &hash,
            )? {
                return Ok(value);
            }
            if thread.goals.revision != request.expected_revision {
                return Err(Error::Conflict);
            }
            let goal = thread
                .goals
                .goal
                .as_mut()
                .filter(|g| g.id == request.goal_id)
                .ok_or(Error::Conflict)?;
            let rsi = goal
                .rsi
                .as_mut()
                .ok_or_else(|| invalid("goal is not an RSI artifact workflow"))?;
            if rsi.phase == RsiPhase::Selected {
                if rsi.selected_candidate_id.as_deref() == Some(&request.candidate_id) {
                    let result = projection(&thread);
                    desktop::remember(
                        thread.desktop.as_mut().unwrap(),
                        &identity,
                        &request.request_id,
                        method,
                        hash,
                        result.clone(),
                    );
                    engine.persist(&thread).await?;
                    state.thread = thread;
                    return Ok(result);
                }
                return Err(Error::Conflict);
            }
            if rsi.phase != RsiPhase::AwaitingSelection {
                return Err(Error::Conflict);
            }
            let candidate = rsi
                .candidates
                .iter_mut()
                .find(|c| {
                    c.id == request.candidate_id
                        && matches!(
                            c.status,
                            RsiCandidateStatus::Completed | RsiCandidateStatus::Selected
                        )
                })
                .ok_or_else(|| invalid("candidate has no completed artifact"))?;
            candidate.status = RsiCandidateStatus::Selected;
            for other in &mut rsi.candidates {
                if other.id != request.candidate_id && other.status == RsiCandidateStatus::Selected
                {
                    other.status = RsiCandidateStatus::Completed;
                }
            }
            rsi.selected_candidate_id = Some(request.candidate_id.clone());
            rsi.phase = RsiPhase::Selected;
            goal.status = GoalStatus::Completed;
            goal.reason = None;
            changed(&mut thread.goals);
            let result = projection(&thread);
            desktop::remember(
                thread.desktop.as_mut().unwrap(),
                &identity,
                &request.request_id,
                method,
                hash,
                result.clone(),
            );
            // winner 与选择收据同快照提交；不复制或自动应用产物，避免重复副作用。
            engine.persist(&thread).await?;
            state.thread = thread;
            emit(&cell, &state.thread);
            Ok(result)
        })
        .await
    }

    pub async fn goal_candidate_artifact(&self, request: GoalCandidateArtifact) -> Result<Value> {
        let cell = self.raw_cell(&request.thread_id).await?;
        let state = cell.state.lock().await;
        let goal = state
            .thread
            .goals
            .goal
            .as_ref()
            .filter(|g| g.id == request.goal_id)
            .ok_or(Error::NotFound)?;
        let candidate = goal
            .rsi
            .as_ref()
            .and_then(|r| r.candidates.iter().find(|c| c.id == request.candidate_id))
            .filter(|c| {
                matches!(
                    c.status,
                    RsiCandidateStatus::Completed | RsiCandidateStatus::Selected
                )
            })
            .ok_or(Error::NotFound)?;
        let run_id = candidate.run_id.clone();
        let format = goal.rsi.as_ref().unwrap().output_format.clone();
        drop(state);
        self.execution_workgroups(true)?
            .artifact(
                &run_id,
                Some(&owner(&request.thread_id, &request.goal_id)),
                Some(artifact_name(
                    &request.goal_id,
                    &request.candidate_id,
                    &format,
                )),
                request.offset,
            )
            .await
            .map_err(invalid)
    }
}
