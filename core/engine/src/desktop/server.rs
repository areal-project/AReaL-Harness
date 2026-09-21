//! Drain 关闭准入后保留观察与取消；不隐式重建仍有资源或 UNKNOWN 的实例。
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
pub(super) struct Lifecycle {
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
        let cells: Vec<_> = self.threads.read().await.values().cloned().collect();
        let mut active = Vec::new();
        let mut resources = Vec::new();
        let mut unknown = Vec::new();
        let mut compacting = Vec::new();
        for cell in &cells {
            let s = cell.state.lock().await;
            if s.compacting {
                compacting.push(s.thread.id.clone());
            }
            if let Some(a) = &s.active {
                active.push(json!({"threadId":s.thread.id,"turnId":a.id}));
            }
            if let Some(d) = &s.thread.desktop {
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
        let groups = if let Some(service) = self.workgroups.get() {
            service.list().await
        } else {
            json!([])
        };
        let unsettled = groups.as_array().is_some_and(|g| {
            g.iter()
                .any(|g| g["status"] == "running" || g["cleanupConfirmed"] != true)
        });
        json!({"compactions":compacting,"workgroups":groups,"apiVersion":API_VERSION,"stateVersion":6,"productVersion":env!("CARGO_PKG_VERSION"),"draining":self.desktop.lifecycle.draining.load(Ordering::Acquire),"closed":self.is_closed(),"acceptingWork":self.accepting_work(),"activeTurns":active,"resources":resources,"unresolvedTools":unknown,"runtime":runtime,"capacity":{"threads":cells.len(),"maxThreads":self.limits.max_threads,"activeTurns":self.limits.max_active_turns-self.active_turns.available_permits(),"maxActiveTurns":self.limits.max_active_turns,"historyBytesPerThread":self.limits.max_history_bytes,"blobBytes":512*1024*1024u64},"restartSafe":active.is_empty()&&resources.is_empty()&&unknown.is_empty()&&compacting.is_empty()&&!unsettled})
    }
    pub async fn drain(self: &Arc<Self>, strategy: String, timeout_ms: u64) -> Result<Value> {
        if !matches!(strategy.as_str(), "wait" | "cancel") || timeout_ms > 60000 {
            return Err(invalid(
                "strategy must be wait or cancel and timeoutMs <= 60000",
            ));
        }
        let engine = self.clone();
        // 断线只放弃响应；已开始的结算仍由进程持有。
        tokio::spawn(async move {
            let _guard = engine.desktop.lifecycle.gate.lock().await;
            engine
                .desktop
                .lifecycle
                .draining
                .store(true, Ordering::Release);
            let cells: Vec<_> = engine.threads.read().await.values().cloned().collect();
            for cell in &cells {
                let mut state = cell.state.lock().await;
                if state.thread.desktop.as_ref().is_some_and(|d| d.archived) {
                    continue;
                }
                let mut candidate = state.thread.clone();
                if let Some(d) = &mut candidate.desktop {
                    d.queue.paused = true;
                    d.queue.pause_reason = Some("serverDraining".into());
                    d.queue.revision += 1;
                }
                engine.persist(&candidate).await?;
                state.thread = candidate;
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
                if let Some(service) = engine.workgroups.get() {
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
        if !self.model.name().is_empty() {
            data.push(json!({"providerId":null,"providerRevision":null,"modelId":self.model.name(),"transport":self.model.provider(),"input":self.model.capabilities().input,"output":self.model.capabilities().output}));
        }
        for p in self.desktop.catalog.read().unwrap().providers.values() {
            for name in &p.models {
                let result = self.provider_model(p, name, &p.parameters);
                let capabilities = match p.protocol.as_str() {
                    "responses" => model::ModelProtocol::Responses.capabilities(),
                    _ => model::ModelProtocol::ChatCompletions.capabilities(),
                };
                data.push(json!({"providerId":p.id,"providerRevision":p.revision,"modelId":name,"transport":p.protocol,"input":capabilities.input,"output":capabilities.output,"available":result.is_ok(),"credentialState":self.provider_view(p)["credentialState"],"contextWindowTokens":null,"parameterCapabilities":["temperature","maxOutputTokens","reasoningEffort"],"connectionState":"unchecked"}));
            }
        }
        json!({"data":data})
    }
}
