//! Drain 关闭准入后保留观察与取消；不隐式重建仍有资源或 UNKNOWN 的实例。
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
pub(crate) struct Lifecycle {
    pub draining: AtomicBool,
    pub gate: Mutex<()>,
}
impl Default for Lifecycle {
    fn default() -> Self {
        Self {
            draining: AtomicBool::new(false),
            gate: Mutex::new(()),
        }
    }
}
impl Engine {
    pub(crate) fn accepting_work(&self) -> bool {
        !self.is_closed() && !self.desktop.lifecycle.draining.load(Ordering::Acquire)
    }
    pub async fn server_status(&self) -> Value {
        let active_tasks = self.task_active_count().await;
        let cells: Vec<_> = self.threads.read().await.values().cloned().collect();
        let mut active = Vec::new();
        let mut resources = Vec::new();
        let mut unknown = Vec::new();
        let mut compacting = Vec::new();
        let mut active_goals = Vec::new();
        let mut pending_queue_items = 0usize;
        for cell in &cells {
            let s = cell.state.lock().await;
            if s.thread
                .goals
                .goal
                .as_ref()
                .is_some_and(|goal| goal.status == areal_protocol::goals::GoalStatus::Active)
            {
                active_goals.push(s.thread.id.clone());
            }
            if s.compacting {
                compacting.push(s.thread.id.clone());
            }
            if let Some(a) = &s.active {
                active.push(json!({"threadId":s.thread.id,"turnId":a.id}));
            }
            if let Some(d) = &s.thread.desktop {
                pending_queue_items += d
                    .queue
                    .items
                    .iter()
                    .filter(|item| matches!(item.status.as_str(), "pending" | "running"))
                    .count();
                for p in &d.processes {
                    if !p.cleanup_confirmed {
                        resources.push(json!({"threadId":s.thread.id,"id":p.id,"state":p.state,"epoch":p.runtime_epoch}));
                    }
                }
            }
            for t in &s.thread.turns {
                for item in &t.items {
                    if let Item::DynamicToolCall { execution, .. } = item
                        && execution.inspection.is_none()
                        && (execution.outcome == areal_protocol::ToolOutcome::Unknown
                            || execution
                                .hooks
                                .iter()
                                .any(|h| h.outcome == areal_protocol::ToolOutcome::Unknown))
                    {
                        unknown.push(json!({"threadId":s.thread.id,"itemId":item.id()}));
                    }
                }
            }
        }
        let runtime = match &self.runtime {
            Some(r) => match r.client.status().await {
                Ok(v) => v,
                Err(_) => json!({"state":"unavailable","epoch":r.client.info().runtime_epoch}),
            },
            None => Value::Null,
        };
        let mut groups = Vec::new();
        let mut unsettled = false;
        for (automatic, service) in [
            (false, self.workgroups.get()),
            (true, self.automatic_workgroups.get()),
        ] {
            let Some(service) = service else {
                continue;
            };
            for mut group in service.list().await.as_array().cloned().unwrap_or_default() {
                unsettled |= group["status"] == "running" || group["cleanupConfirmed"] != true;
                if let Some(id) = group["id"].as_str() {
                    match self.workgroup_delivery_status(id, automatic).await {
                        Ok(delivery) if !delivery.is_null() => {
                            unsettled |= matches!(
                                delivery["status"].as_str(),
                                Some("unknown" | "preparing" | "applying")
                            );
                            group["deliveryStatus"] = delivery["status"].clone();
                        }
                        Err(_) => unsettled = true,
                        _ => {}
                    }
                }
                groups.push(group);
            }
        }
        json!({"configuration":self.configuration_status.read().unwrap().clone(),"activeTasks":active_tasks,"activeGoals":active_goals,"pendingQueueItems":pending_queue_items,"compactions":compacting,"workgroups":groups,"apiVersion":API_VERSION,"stateVersion":crate::store::STATE_VERSION,"productVersion":env!("CARGO_PKG_VERSION"),"draining":self.desktop.lifecycle.draining.load(Ordering::Acquire),"closed":self.is_closed(),"acceptingWork":self.accepting_work(),"activeTurns":active,"resources":resources,"unresolvedTools":unknown,"runtime":runtime,"capacity":{"threads":cells.len(),"maxThreads":self.limits.max_threads,"activeTurns":self.limits.max_active_turns-self.active_turns.available_permits(),"maxActiveTurns":self.limits.max_active_turns,"historyBytesPerThread":self.limits.max_history_bytes,"blobBytes":512*1024*1024u64},"restartSafe":active.is_empty()&&resources.is_empty()&&unknown.is_empty()&&compacting.is_empty()&&!unsettled})
    }
    pub async fn drain(self: &Arc<Self>, strategy: String, timeout_ms: u64) -> Result<Value> {
        if !matches!(strategy.as_str(), "wait" | "cancel" | "ifIdle") || timeout_ms > 60000 {
            return Err(invalid(
                "strategy must be wait, cancel or ifIdle and timeoutMs <= 60000",
            ));
        }
        let engine = self.clone();
        // 断线只放弃响应；已开始的结算仍由进程持有。
        tokio::spawn(async move {
            let _guard = engine.desktop.lifecycle.gate.lock().await;
            if strategy == "ifIdle" {
                let status = engine.server_status().await;
                if status["restartSafe"] != true
                    || status["activeGoals"] != json!([])
                    || status["pendingQueueItems"] != 0
                    || status["activeTasks"] != 0
                {
                    return Err(invalid(
                        "service is busy; wait for work to settle or stop with --cancel",
                    ));
                }
            }
            engine
                .desktop
                .lifecycle
                .draining
                .store(true, Ordering::Release);
            engine.drain_task_modes().await?;
            let cells: Vec<_> = engine.threads.read().await.values().cloned().collect();
            for cell in &cells {
                let mut state = cell.state.lock().await;
                if state.thread.desktop.as_ref().is_some_and(|d| d.archived) {
                    continue;
                }
                let mut candidate = state.thread.clone();
                if let Some(goal) = &mut candidate.goals.goal
                    && goal.status == areal_protocol::goals::GoalStatus::Active
                {
                    goal.status = areal_protocol::goals::GoalStatus::Paused;
                    goal.reason = Some("serverDraining".into());
                    candidate.goals.revision += 1;
                    candidate.goals.event_sequence += 1;
                    if let Some(budget) = engine.goals.budget(&candidate) {
                        budget.configure(
                            candidate.goals.goal.as_ref().and_then(|g| g.token_budget),
                            strategy == "wait",
                        );
                    }
                }
                if let Some(d) = &mut candidate.desktop {
                    d.queue.paused = true;
                    d.queue.pause_reason = Some("serverDraining".into());
                    d.queue.revision += 1;
                }
                engine.persist(&candidate).await?;
                state.thread = candidate;
                engine.goal_emit(cell, &state.thread);
                if strategy == "cancel"
                    && let Some(active) = &state.active
                {
                    active.cancel.cancel();
                }
                cell.emit(
                    "areal/server/draining",
                    json!({"threadId":state.thread.id,"strategy":strategy}),
                );
            }
            let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
            for cell in &cells {
                let mut settled = cell.settled.subscribe();
                if tokio::time::timeout_at(deadline, settled.wait_for(|v| *v))
                    .await
                    .is_err()
                {
                    return Ok(engine.server_status().await);
                }
            }
            if strategy == "cancel" {
                for service in [engine.workgroups.get(), engine.automatic_workgroups.get()]
                    .into_iter()
                    .flatten()
                {
                    let _ = tokio::time::timeout_at(deadline, service.shutdown()).await;
                }
                for cell in &cells {
                    let _ = engine.close_managed(cell, None).await;
                }
            }
            Ok(engine.server_status().await)
        })
        .await
        .map_err(|_| invalid("drain task failed"))?
    }
    pub fn model_catalog(&self) -> Value {
        let mut data = Vec::new();
        // 这是现有 HTTP 适配器的允许值，不代表远端供应商已验证这些选项。
        let efforts = ["none", "minimal", "low", "medium", "high", "xhigh"];
        let model = self.default_model();
        if !model.name().is_empty() {
            data.push(json!({"providerId":null,"providerRevision":null,"modelId":model.name(),"transport":model.provider(),"reasoningEffortOptions":if matches!(model.provider(), "openai.responses" | "openai.chat_completions") {efforts.to_vec()} else {vec![]},"input":model.capabilities().input,"output":model.capabilities().output,"contextWindowTokens":model.capabilities().context_window_tokens,"effectiveContextWindowTokens":model.capabilities().context_window_tokens.unwrap_or(self.limits.context_window_tokens)}));
        }
        for p in self.desktop.catalog.read().unwrap().providers.values() {
            for name in &p.models {
                let mut parameters = p.parameters.clone();
                parameters.context_window_tokens = self
                    .desktop
                    .configured_models
                    .read()
                    .unwrap()
                    .parameters
                    .get(&(p.id.clone(), name.clone()))
                    .and_then(|p| p.context_window_tokens)
                    .or(parameters.context_window_tokens);
                let result = self.provider_model(p, name, &parameters);
                let capabilities = match p.protocol.as_str() {
                    "responses" => model::ModelProtocol::Responses.capabilities(),
                    _ => model::ModelProtocol::ChatCompletions.capabilities(),
                };
                data.push(json!({"providerId":p.id,"providerRevision":p.revision,"modelId":name,"transport":p.protocol,"input":capabilities.input,"output":capabilities.output,"available":result.is_ok(),"credentialState":self.provider_view(p)["credentialState"],"contextWindowTokens":parameters.context_window_tokens,"effectiveContextWindowTokens":parameters.context_window_tokens.unwrap_or(self.limits.context_window_tokens),"parameterCapabilities":if p.protocol == "responses" {vec!["temperature","maxOutputTokens","contextWindowTokens","reasoningEffort","reasoningSummary"]} else {vec!["temperature","maxOutputTokens","contextWindowTokens","reasoningEffort"]},"reasoningEffortOptions":efforts,"connectionState":"unchecked"}));
            }
        }
        json!({"data":data})
    }
}
