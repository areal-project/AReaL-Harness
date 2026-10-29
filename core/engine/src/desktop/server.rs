//! Drain 将资源结算与历史执行结果分开报告。
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
pub(crate) struct Lifecycle {
    pub draining: AtomicBool,
    pub gate: Mutex<()>,
    idle_clock: std::sync::Mutex<IdleClock>,
}
struct IdleClock {
    since: std::time::Instant,
    busy: bool,
}
impl Default for Lifecycle {
    fn default() -> Self {
        Self {
            draining: AtomicBool::new(false),
            gate: Mutex::new(()),
            idle_clock: std::sync::Mutex::new(IdleClock {
                since: std::time::Instant::now(),
                busy: false,
            }),
        }
    }
}
fn lifecycle_assessment(
    status: &Value,
    unsettled_groups: bool,
    uninspected_outcomes: usize,
) -> Value {
    let mut settlement = Vec::new();
    for (field, code) in [
        ("activeTurns", "activeTurn"),
        ("resources", "resource"),
        ("compactions", "compaction"),
    ] {
        let count = status[field].as_array().map_or(0, Vec::len);
        if count > 0 {
            settlement.push(json!({"code":code,"count":count}));
        }
    }
    if unsettled_groups {
        settlement.push(json!({"code":"workgroup","count":1}));
    }
    let mut idle = settlement.clone();
    let goals = status["activeGoals"].as_array().map_or(0, Vec::len) as u64;
    for (code, count) in [
        ("activeGoal", goals),
        (
            "queuedMessage",
            status["pendingQueueItems"].as_u64().unwrap_or(0),
        ),
        ("activeTask", status["activeTasks"].as_u64().unwrap_or(0)),
    ] {
        if count > 0 {
            idle.push(json!({"code":code,"count":count}));
        }
    }
    json!({"version":1,"admission":if status["closed"] == true {"closed"}
        else if status["draining"] == true {"draining"} else {"open"},
        "ifIdle":{"allowed":idle.is_empty(),"reasons":idle},
        "settled":{"allowed":settlement.is_empty(),"reasons":settlement},
        "executionOutcomes":{"uninspectedUnknown":uninspected_outcomes}})
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
        let mut uninspected_outcomes = 0usize;
        let mut compacting = Vec::new();
        let mut active_goals = Vec::new();
        let mut pending_queue_items = 0usize;
        let mut latest_activity = 0i64;
        for cell in &cells {
            if let Some(scope) = self.hook_task_unknown(cell).await {
                unknown.push(scope.clone());
                let mut resource = scope;
                resource["state"] = json!("cleanupUnknown");
                resources.push(resource);
            }
            let s = cell.state.lock().await;
            // 冷目录保留全部持久轮次的最大活动时间，不能只用尾轮摘要提前回收。
            latest_activity = latest_activity.max(s.latest_activity_at());
            if cell.hooks.closing.load(Ordering::Acquire)
                && !cell.hooks.ended.load(Ordering::Acquire)
            {
                resources
                    .push(json!({"threadId":s.thread.id,"kind":"hookSession","state":"closing"}));
            }
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
                for hook in &d.hook_runs {
                    if hook.outcome == "running" {
                        resources.push(json!({"threadId":s.thread.id,"id":hook.id,"kind":"hook","state":"running"}));
                    }
                    if hook.outcome == "unknown" && hook.inspection.is_none() {
                        uninspected_outcomes += 1;
                        unknown.push(
                            json!({"threadId":s.thread.id,"invocationId":hook.id,"kind":"hook"}),
                        );
                    }
                }
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
                        uninspected_outcomes += 1;
                        unknown.push(json!({"threadId":s.thread.id,"itemId":item.id()}));
                    }
                }
            }
        }
        let runtime = match &self.runtime {
            Some(r) => match r.client.status().await {
                Ok(v) => {
                    let scope_id = &r.client.info().root_scope_id;
                    let scope: areal_runtime_protocol::Result<areal_runtime_protocol::ScopeInfo> =
                        r.client
                            .call("scope.get", json!({"scopeId":scope_id}))
                            .await;
                    match scope {
                        Ok(scope) => {
                            let active = v["activeProcesses"]
                                .as_u64()
                                .unwrap_or(0)
                                .max(scope.active_processes as u64);
                            if active > 0
                                || scope.cleanup_error.is_some()
                                || scope.state == areal_runtime_protocol::ScopeState::Revoking
                            {
                                resources.push(json!({"kind":"runtime","scopeId":scope_id,
                                    "state":if scope.cleanup_error.is_some() {"cleanupUnknown"}
                                        else if scope.state == areal_runtime_protocol::ScopeState::Revoking {"closing"}
                                        else {"running"},
                                    "activeProcesses":active,"cleanupError":scope.cleanup_error,
                                    "epoch":r.client.info().runtime_epoch}));
                            }
                        }
                        Err(_) => resources.push(json!({"kind":"runtime","scopeId":scope_id,
                            "state":"cleanupUnknown","epoch":r.client.info().runtime_epoch})),
                    }
                    v
                }
                Err(_) => {
                    resources.push(json!({"kind":"runtime","state":"unavailable",
                        "epoch":r.client.info().runtime_epoch}));
                    json!({"state":"unavailable","epoch":r.client.info().runtime_epoch})
                }
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
        let preparations = self.desktop.plugin_mcp.pending_preparations();
        if preparations > 0 {
            resources
                .push(json!({"kind":"pluginPreparation","state":"running","count":preparations}));
        }
        let mut status = json!({"configuration":self.configuration_status.read().unwrap().clone(),"activeTasks":active_tasks,"activeGoals":active_goals,"pendingQueueItems":pending_queue_items,"compactions":compacting,"workgroups":groups,"apiVersion":API_VERSION,"stateVersion":crate::store::STATE_VERSION,"productVersion":env!("CARGO_PKG_VERSION"),"draining":self.desktop.lifecycle.draining.load(Ordering::Acquire),"closed":self.is_closed(),"acceptingWork":self.accepting_work(),"activeTurns":active,"resources":resources,"unresolvedTools":unknown,"runtime":runtime,"capacity":{"threads":cells.len(),"maxThreads":self.limits.max_threads,"activeTurns":self.limits.max_active_turns-self.active_turns.available_permits(),"maxActiveTurns":self.limits.max_active_turns,"historyBytesPerThread":self.limits.max_history_bytes,"blobBytes":512*1024*1024u64}});
        status["lifecycle"] = lifecycle_assessment(&status, unsettled, uninspected_outcomes);
        status["restartSafe"] = status["lifecycle"]["settled"]["allowed"].clone();
        // 观察、轮询和 WebSocket 心跳不延长空闲时间；活动工作与持久 Turn 时间才计入。
        let mut idle_clock = self.desktop.lifecycle.idle_clock.lock().unwrap();
        let busy = status["lifecycle"]["ifIdle"]["allowed"] != true;
        if busy || idle_clock.busy {
            // 从忙碌转为空闲后重新计时，不把最后一次忙碌观察之后的时间算作空闲。
            idle_clock.since = std::time::Instant::now();
        }
        idle_clock.busy = busy;
        let wall_now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        // 持久时间只精确到秒，取该秒末尾以免高估空闲时长、提前回收。
        let persisted_idle = wall_now.saturating_sub((latest_activity.max(0) as u128 + 1) * 1000);
        status["idleForMs"] = json!(
            idle_clock
                .since
                .elapsed()
                .as_millis()
                .min(persisted_idle)
                .min(u64::MAX as u128) as u64
        );
        status
    }
    pub async fn drain(self: &Arc<Self>, strategy: String, timeout_ms: u64) -> Result<Value> {
        self.drain_with_idle(strategy, timeout_ms, None).await
    }
    pub async fn drain_with_idle(
        self: &Arc<Self>,
        strategy: String,
        timeout_ms: u64,
        idle_timeout_ms: Option<u64>,
    ) -> Result<Value> {
        if !matches!(strategy.as_str(), "wait" | "cancel" | "ifIdle")
            || timeout_ms > 60000
            || idle_timeout_ms.is_some_and(|v| v == 0 || v > 604_800_000 || strategy != "ifIdle")
        {
            return Err(invalid(
                "strategy must be wait, cancel or ifIdle and timeoutMs <= 60000; idleTimeoutMs requires ifIdle and 1..604800000",
            ));
        }
        let engine = self.clone();
        // 断线只放弃响应；已开始的结算仍由进程持有。
        tokio::spawn(async move {
            let _guard = engine.desktop.lifecycle.gate.lock().await;
            if strategy == "ifIdle" {
                let status = engine.server_status().await;
                if idle_timeout_ms
                    .is_some_and(|minimum| status["idleForMs"].as_u64().unwrap_or(0) < minimum)
                {
                    return Err(invalid("service idle timeout has not elapsed"));
                }
                if status["lifecycle"]["ifIdle"]["allowed"] != true {
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
                if !cell.state.is_loaded()
                    && cell
                        .state
                        .lock()
                        .await
                        .thread
                        .desktop
                        .as_ref()
                        .is_some_and(|d| d.archived)
                {
                    continue;
                }
                engine.materialize_cell(cell).await?;
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
                if strategy == "cancel" {
                    cell.hooks.cancel.cancel();
                    if let Some(owner) = &state.compaction_owner {
                        owner.cancellation.cancel();
                    }
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
                while cell.state.lock().await.compacting {
                    if tokio::time::Instant::now() >= deadline {
                        return Ok(engine.server_status().await);
                    }
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            }
            if strategy == "cancel" {
                for cell in &cells {
                    let closing_engine = engine.clone();
                    let cell = cell.clone();
                    // The accepted close owns cleanup even when the drain deadline
                    // expires or its caller disconnects; dropping a join is no abort.
                    let closing =
                        tokio::spawn(async move { closing_engine.plugin_hooks_end(&cell).await });
                    if tokio::time::timeout_at(deadline, closing).await.is_err() {
                        return Ok(engine.server_status().await);
                    }
                }
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
    pub async fn model_catalog(&self) -> Value {
        let last_accepted_model = self.last_accepted_model().await;
        let _configuration = self.desktop.model_configuration.read().unwrap();
        let mut data = Vec::new();
        let model = self.default_model();
        let default_model = self
            .desktop
            .configured_models
            .read()
            .unwrap()
            .default_model
            .clone();
        let parameters = self
            .default_model_metadata(None)
            .map(|(_, parameters)| parameters)
            .unwrap_or_default();
        if !model.name().is_empty() {
            let model_capabilities = model.capabilities();
            let declared = model_capabilities.declared.as_ref();
            let reasoning_efforts = declared
                .filter(|value| value.reasoning)
                .and_then(|value| value.reasoning_effort_options.clone())
                .unwrap_or_default();
            let available = model.check_work().map_or_else(
                |error| {
                    error
                        .downcast_ref::<model::ModelConfigurationError>()
                        .is_some()
                },
                |_| true,
            );
            data.push(json!({"providerId":null,"providerRevision":null,"modelId":model.name(),"parameters":parameters,"isDefault":default_model.is_none(),"available":available,"transport":model.provider(),"capabilities":declared,"reasoningEffortOptions":reasoning_efforts,"input":model.capabilities().input,"output":model.capabilities().output,"contextWindowTokens":model.capabilities().context_window_tokens,"effectiveContextWindowTokens":model.capabilities().context_window_tokens.unwrap_or(self.limits.context_window_tokens)}));
        }
        let mut factory = model::HttpModelFactory::default();
        for p in self.desktop.catalog.read().unwrap().providers.values() {
            for name in &p.models {
                let reference = ModelRef {
                    provider_id: p.id.clone(),
                    model_id: name.clone(),
                };
                let parameters = self.model_parameters(&reference, p);
                let result =
                    self.provider_model_with_factory(p, name, &parameters, None, &mut factory);
                let mut capabilities = match p.protocol.as_str() {
                    "responses" => model::ModelProtocol::Responses.capabilities(),
                    _ => model::ModelProtocol::ChatCompletions.capabilities(),
                };
                let resolved =
                    model::resolved_capabilities(&p.endpoint, name, p.model_capabilities.get(name));
                let declared = resolved.as_ref();
                if declared.is_some_and(|declared| !declared.vision) {
                    capabilities
                        .input
                        .retain(|modality| *modality != areal_protocol::Modality::Image);
                }
                let reasoning = declared.is_none_or(|declared| declared.reasoning);
                let reasoning_efforts: Vec<String> = if reasoning {
                    declared
                        .and_then(|declared| declared.reasoning_effort_options.clone())
                        .unwrap_or_default()
                } else {
                    Vec::new()
                };
                let window =
                    self.provider_context_window(p, name, parameters.context_window_tokens);
                let mut parameter_capabilities =
                    vec!["temperature", "maxOutputTokens", "contextWindowTokens"];
                if reasoning {
                    parameter_capabilities.push("reasoningEffort");
                    if p.protocol == "responses" {
                        parameter_capabilities.push("reasoningSummary");
                    }
                }
                data.push(json!({"providerId":p.id,"providerRevision":p.revision,"modelId":name,"parameters":parameters,"isDefault":default_model.as_ref() == Some(&reference),"transport":p.protocol,"input":capabilities.input,"output":capabilities.output,"available":result.is_ok(),"credentialState":self.provider_view(p)["credentialState"],"contextWindowTokens":window.window_tokens,"effectiveContextWindowTokens":window.window_tokens,"reportedWindowTokens":window.reported_window_tokens,"reportedWindowSource":window.reported_window_source,"userBudgetTokens":window.user_budget_tokens,"windowSource":window.source,"capabilities":declared,"parameterCapabilities":parameter_capabilities,"reasoningEffortOptions":reasoning_efforts,"connectionState":"unchecked"}));
            }
        }
        json!({"data":data,"lastAcceptedModel":last_accepted_model})
    }
}
