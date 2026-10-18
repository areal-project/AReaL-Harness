//! 有界反馈分叉；复用冻结输入、模型配置和累计预算，不把页面改进等同于跨任务收益。
use super::*;
use crate::workgroup::service::Service;

fn text(value: &str, max: usize) -> Result<()> {
    if value.trim().is_empty() || value.chars().count() > max {
        return Err(invalid(format!(
            "RSI text must contain 1..{max} characters"
        )));
    }
    Ok(())
}
impl Engine {
    pub async fn goal_evolve(
        self: &Arc<Self>,
        identity: String,
        request: GoalEvolve,
    ) -> Result<Value> {
        self.mutate(move |engine| async move {
            let _gate = engine.desktop.lifecycle.gate.lock().await;
            let cell = engine.cell(&request.control.thread_id).await?;
            let mut state = cell.state.lock().await;
            let mut thread = state.thread.clone();
            let hash = desktop::digest(&request)?;
            let method = "areal/goal/evolve";
            if let Some(value) = desktop::receipt(
                thread.desktop.get_or_insert_with(Default::default),
                &identity,
                &request.control.request_id,
                method,
                &hash,
            )? {
                return Ok(value);
            }
            if !engine.accepting_work() {
                return Err(Error::Closed);
            }
            if thread.is_side()
                || state.active.is_some()
                || state.compacting
                || state.poisoned
                || has_pending(&thread)
                || thread.goals.revision != request.control.expected_revision
            {
                return Err(Error::Conflict);
            }
            engine.check_thread_available(&state)?;
            text(&request.feedback, 8000)?;
            if request.variants.is_empty() || request.variants.len() > 3 {
                return Err(invalid("RSI branching factor must be 1..3"));
            }
            for variant in &request.variants {
                text(&variant.label, 80)?;
                text(&variant.hypothesis, 2000)?;
                text(&variant.harness, 16000)?;
            }
            let budget = engine
                .goals
                .budget(&thread)
                .ok_or_else(|| invalid("RSI budget journal missing"))?;
            let goal = thread
                .goals
                .goal
                .as_mut()
                .filter(|g| g.id == request.control.goal_id)
                .ok_or(Error::Conflict)?;
            if goal.settling {
                return Err(Error::Conflict);
            }
            if let Some(limit) = request.token_budget {
                engine.validate_goal_limits(Some(limit), None, goal.max_active_seconds)?;
                if goal.token_budget.is_some_and(|old| limit <= old) {
                    return Err(invalid(
                        "explicit RSI budget extension must increase the current limit",
                    ));
                }
                goal.token_budget = Some(limit);
            }
            let usage = budget.usage();
            if !usage.accounting_complete
                || goal
                    .token_budget
                    .is_some_and(|limit| usage.tokens_used >= limit)
                || goal
                    .max_active_seconds
                    .is_some_and(|limit| usage.time_used_seconds >= limit as f64)
            {
                return Err(invalid("RSI budget exhausted or accounting incomplete"));
            }
            let rsi = goal
                .rsi
                .as_mut()
                .ok_or_else(|| invalid("not an RSI goal"))?;
            if rsi.phase == RsiPhase::Running || rsi.candidates.len() + request.variants.len() > 12
            {
                return Err(invalid(
                    "RSI is running or the 12-version exploration limit was reached",
                ));
            }
            let parent = rsi
                .candidates
                .iter()
                .find(|c| {
                    c.id == request.parent_candidate_id
                        && matches!(
                            c.status,
                            RsiCandidateStatus::Completed
                                | RsiCandidateStatus::Selected
                                | RsiCandidateStatus::Failed
                        )
                })
                .ok_or_else(|| {
                    invalid("parent must have a settled artifact or execution failure")
                })?;
            if parent.round >= 3 {
                return Err(invalid("RSI maximum lineage depth is 3"));
            }
            if parent.status != RsiCandidateStatus::Failed && parent.evaluations.is_empty() {
                return Err(invalid("record parent evaluation before evolving"));
            }
            let round = parent.round + 1;
            let parent_harness = parent.harness.clone();
            if request
                .variants
                .iter()
                .any(|v| v.harness.trim() == parent_harness.trim())
            {
                return Err(invalid("a challenger must change the harness"));
            }
            // 下一轮只能使用首次执行冻结的配置和输入；丢失时拒绝，不采集新的工作区。
            let directory = engine.store.root().join("rsi").join(&goal.id);
            if !directory.join("input.json").is_file() {
                return Err(invalid("frozen RSI input missing"));
            }
            let config: EffectiveConfig = serde_json::from_slice(
                &tokio::fs::read(directory.join("configuration.json"))
                    .await
                    .map_err(invalid)?,
            )
            .map_err(invalid)?;
            let service = engine.execution_workgroups(true)?.clone();
            for variant in request.variants {
                let candidate_id = format!("candidate-{}", rsi.candidates.len() + 1);
                rsi.candidates.push(RsiCandidate {
                    parent_candidate_id: Some(request.parent_candidate_id.clone()),
                    round,
                    hypothesis: variant.hypothesis,
                    feedback: request.feedback.clone(),
                    evaluations: vec![],
                    run_id: Service::request_id(
                        &format!("rsi:{}:{}", thread.id, goal.id),
                        &candidate_id,
                    )
                    .map_err(invalid)?,
                    task_id: candidate_id.clone(),
                    id: candidate_id,
                    label: variant.label,
                    harness: variant.harness,
                    status: RsiCandidateStatus::Queued,
                    workspace_mode: "isolatedWrite".into(),
                    workspace_path: None,
                    artifact_path: None,
                    artifact_summary: None,
                    error: None,
                    started_at: None,
                    finished_at: None,
                });
            }
            // 上个 winner 保留为 incumbent；只有下一次显式选择才替换它。
            rsi.phase = RsiPhase::Running;
            goal.status = GoalStatus::Active;
            goal.reason = None;
            goal.settling = true;
            let execution = goal.clone();
            changed(&mut thread.goals);
            let result = projection(&thread);
            desktop::remember(
                thread.desktop.as_mut().unwrap(),
                &identity,
                &request.control.request_id,
                method,
                hash,
                result.clone(),
            );
            engine.persist(&thread).await?;
            state.thread = thread;
            emit(&cell, &state.thread);
            let runner = engine.clone();
            engine.tasks.spawn(async move {
                if let Err(error) = runner
                    .run_rsi_goal(execution, config, service, budget)
                    .await
                {
                    tracing::error!(%error, "RSI evolution failed");
                }
            });
            Ok(result)
        })
        .await
    }

    pub async fn goal_evaluate_candidate(
        self: &Arc<Self>,
        identity: String,
        request: GoalEvaluateCandidate,
    ) -> Result<Value> {
        self.mutate(move |engine| async move {
            let _gate = engine.desktop.lifecycle.gate.lock().await;
            let cell = engine.cell(&request.control.thread_id).await?;
            let mut state = cell.state.lock().await;
            let mut thread = state.thread.clone();
            let method = "areal/goal/evaluateCandidate";
            let hash = desktop::digest(&request)?;
            if let Some(value) = desktop::receipt(
                thread.desktop.get_or_insert_with(Default::default),
                &identity,
                &request.control.request_id,
                method,
                &hash,
            )? {
                return Ok(value);
            }
            if thread.goals.revision != request.control.expected_revision {
                return Err(Error::Conflict);
            }
            let goal = thread
                .goals
                .goal
                .as_mut()
                .filter(|g| g.id == request.control.goal_id)
                .ok_or(Error::Conflict)?;
            let rsi = goal
                .rsi
                .as_mut()
                .ok_or_else(|| invalid("not an RSI goal"))?;
            if rsi.phase == RsiPhase::Running || goal.settling {
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
                .ok_or(Error::NotFound)?;
            let evaluation = &request.evaluation;
            for value in [
                &evaluation.rubric_id,
                &evaluation.evaluator,
                &evaluation.task_id,
            ] {
                text(value, 200)?;
            }
            text(&evaluation.feedback, 8000)?;
            if candidate.evaluations.len() >= 16
                || evaluation.checks.len() > 32
                || evaluation.evidence.len() > 16
                || evaluation.checks.keys().any(|k| k.len() > 200)
                || evaluation.evidence.iter().any(|e| e.len() > 2000)
                || evaluation
                    .score
                    .is_some_and(|s| !s.is_finite() || !(0.0..=100.0).contains(&s))
            {
                return Err(invalid("RSI evaluation exceeds limits"));
            }
            let artifact = engine
                .execution_workgroups(true)?
                .artifact(
                    &candidate.run_id,
                    Some(&format!("rsi:{}:{}", thread.id, goal.id)),
                    Some(super::rsi::artifact_name(
                        &goal.id,
                        &candidate.id,
                        &rsi.output_format,
                    )),
                    0,
                )
                .await
                .map_err(invalid)?;
            if artifact["sha256"].as_str() != Some(&evaluation.artifact_sha256) {
                return Err(invalid("evaluation artifact hash mismatch"));
            }
            candidate.evaluations.push(request.evaluation);
            changed(&mut thread.goals);
            let result = projection(&thread);
            desktop::remember(
                thread.desktop.as_mut().unwrap(),
                &identity,
                &request.control.request_id,
                method,
                hash,
                result.clone(),
            );
            engine.persist(&thread).await?;
            state.thread = thread;
            emit(&cell, &state.thread);
            Ok(result)
        })
        .await
    }
}
