//! Optional model-controlled research tasks; Core owns lifetime, Runtime owns permissions.
use super::*;
use areal_protocol::ToolDefinition;

pub(super) fn definitions() -> Vec<ToolDefinition> {
    let task = json!({"oneOf":[{"type":"string","minLength":1,"maxLength":16000},
        {"type":"object","properties":{"prompt":{"type":"string","minLength":1,"maxLength":16000}},"required":["prompt"],"additionalProperties":false}]});
    [
        ("delegate_tasks", "Start 1–3 independent research agents and return their threadId handles immediately. Each task is a string or {prompt: text}. Include the question, relevant context, and useful stopping evidence. Example: {tasks:[{prompt: 'Inspect callers of normalize(); report whether any depend on input mutation. Do not edit source.'}]}. Continue independent work, then read_agent; wait=true explicitly requests synchronous waiting. Workers have read-only source, private scratch, shared budgets and parent cancellation. Delegation is optional.",
         json!({"tasks":{"type":"array","minItems":1,"maxItems":3,"items":task},"wait":{"type":"boolean","default":false}}), vec!["tasks"]),
        ("read_agent", "Read an owned research agent's status and bounded report. waitMs=0 returns immediately; up to 60000 waits for completion. A partial report is commentary, not a completed finding. Example: {threadId: '<id from delegate_tasks>', waitMs: 1000}. Only agents created by this parent Turn are accessible.",
         json!({"threadId":{"type":"string"},"waitMs":{"type":"integer","minimum":0,"maximum":60000,"default":0}}), vec!["threadId"]),
        ("cancel_agent", "Cancel an owned research agent and wait for its execution resources to settle. Idempotent for a settled agent. Cancelling does not refund cumulative request/tool/child budgets. Example: {threadId: '<id from delegate_tasks>'}.",
         json!({"threadId":{"type":"string"}}), vec!["threadId"]),
    ].into_iter().map(|(name, description, properties, required)| ToolDefinition {
        name:name.into(), description:description.into(),
        input_schema:json!({"type":"object","properties":properties,"required":required,"additionalProperties":false}),
        output_schema:None,
    }).collect()
}

fn report(thread: &Thread) -> anyhow::Result<Value> {
    let turn = thread.turns.last().context("child has no turn")?;
    let text = turn
        .items
        .iter()
        .rev()
        .find_map(|item| match item {
            Item::AgentMessage { text, .. } if !text.trim().is_empty() => Some(text.as_str()),
            _ => None,
        })
        .unwrap_or("");
    let full = turn.status == TurnStatus::Completed;
    let content = prefix(text, 3000);
    Ok(json!({"threadId":thread.id,"status":turn.status,
        "reportKind":if full {"final"} else if text.is_empty() {"none"} else {"partial"},
        "report":content,"truncated":content.len()<text.len(),
        "error":turn.error.as_ref().map(|e| json!({"message":prefix(&e.message,512),"truncated":e.message.len()>512})),"usage":turn.usage,
        "advisory":true}))
}

async fn child_report(child: &Cell, wait: bool) -> anyhow::Result<Value> {
    if wait {
        child.settled.subscribe().wait_for(|done| *done).await?;
    }
    // Serialize only the bounded report while holding the lock. Polling must
    // not copy a worker's potentially large persisted history.
    report(&child.state.lock().await.thread)
}

async fn owned_child(engine: &Engine, parent: &Cell, id: &str) -> anyhow::Result<Arc<Cell>> {
    {
        let state = parent.state.lock().await;
        anyhow::ensure!(
            state
                .active
                .as_ref()
                .context("parent inactive")?
                .children
                .iter()
                .any(|child| child == id),
            "agent is not owned by this parent Turn; use task_state for valid handles"
        );
    }
    engine.cell(id).await.map_err(Into::into)
}

// Erase recursive generate -> tool -> child generate futures at the ownership boundary.
pub(super) fn invoke<'a>(
    engine: &'a Arc<Engine>,
    cell: &'a Arc<Cell>,
    name: &'a str,
    args: &'a Value,
) -> futures_util::future::BoxFuture<'a, anyhow::Result<(bool, Value)>> {
    Box::pin(async move {
        anyhow::ensure!(
            !cell.research,
            "research agents cannot delegate or control other agents"
        );
        if name != "delegate_tasks" {
            let id = args["threadId"].as_str().context("threadId required")?;
            let child = owned_child(engine, cell, id).await?;
            if name == "cancel_agent" {
                let turn = child
                    .state
                    .lock()
                    .await
                    .thread
                    .turns
                    .last()
                    .context("child has no turn")?
                    .id
                    .clone();
                engine.interrupt(id, &turn).await?;
                return Ok((true, child_report(&child, true).await?));
            }
            anyhow::ensure!(name == "read_agent", "unknown agent operation");
            let wait = Duration::from_millis(args["waitMs"].as_u64().unwrap_or(0));
            let mut settled = child.settled.subscribe();
            if !wait.is_zero() {
                let _ = tokio::time::timeout(wait, settled.wait_for(|done| *done)).await;
            }
            return Ok((true, child_report(&child, false).await?));
        }
        let tasks = args["tasks"].as_array().context("tasks must be an array")?;
        {
            let state = cell.state.lock().await;
            let active = state.active.as_ref().context("parent inactive")?;
            anyhow::ensure!(
                active.children.len() + tasks.len() <= engine.limits.max_children_per_turn,
                "batch exceeds remaining child budget; inspect existing agents with task_state"
            );
        }
        let mut ids = Vec::new();
        let mut rejected = Vec::new();
        for (index, task) in tasks.iter().enumerate() {
            let prompt = task
                .as_str()
                .or_else(|| task["prompt"].as_str())
                .context("task prompt required")?;
            match engine
                .spawn_child_inner(&cell.id, vec![Input::text(prompt)], true, None, None, None)
                .await
            {
                Ok((thread, _)) => ids.push(thread.id),
                Err(error) => {
                    rejected.push(json!({"index":index,"error":error.to_string()}));
                    for index in index + 1..tasks.len() {
                        rejected.push(
                            json!({"index":index,"error":"not started after admission failure"}),
                        );
                    }
                    break;
                }
            }
        }
        let mut reports = Vec::new();
        for id in &ids {
            let child = owned_child(engine, cell, id).await?;
            reports.push(child_report(&child, args["wait"] == true).await?);
        }
        Ok((
            !ids.is_empty(),
            json!({"reports":reports,"rejected":rejected,
            "requested":tasks.len(),"started":ids.len(),"allAccepted":ids.len()==tasks.len(),
            "asynchronous":args["wait"]!=true,"advisory":true,"sourceWriter":"parent",
            "guidance":"Continue independent work. Use read_agent before relying on a result; cancel_agent when no longer needed. Parent completion cancels and reaps outstanding agents."}),
        ))
    })
}

impl Engine {
    pub(super) async fn task_state(&self, cell: &Cell) -> anyhow::Result<Value> {
        let (mut value, children) = {
            let state = cell.state.lock().await;
            let active = state.active.as_ref().context("Turn inactive")?;
            let mut value = active.handles.snapshot();
            value["turnId"] = json!(active.id);
            value["scratchPath"] = json!(self.command_scratch(cell));
            value["scratchUri"] = json!(self.scratch_uri(cell));
            value["summaryThroughItemId"] = json!(
                state
                    .thread
                    .context_checkpoint
                    .as_ref()
                    .map(|c| &c.through_item_id)
            );
            (value, active.children.clone())
        };
        let mut agents = Vec::new();
        for id in children.iter().take(64) {
            let child = self.cell(id).await?;
            let state = child.state.lock().await;
            let row = json!({"threadId":id,"status":state.thread.turns.last().map(|t| &t.status)});
            if value.to_string().len() + serde_json::to_vec(&agents)?.len() + row.to_string().len()
                > 14000
            {
                break;
            }
            agents.push(row);
        }
        value["agents"] = json!(agents);
        value["agentCount"] = json!(children.len());
        // Include metadata in the total budget too (deep scratch paths can be
        // large). Never return a truncated path or opaque handle as usable.
        for field in ["files", "processes", "agents"] {
            while value.to_string().len() > MAX_RESULT - 512 {
                if value[field].as_array_mut().unwrap().pop().is_none() {
                    break;
                }
                value["listsTruncated"] = json!(true);
            }
        }
        if value.to_string().len() > MAX_RESULT - 512 {
            value.as_object_mut().unwrap().remove("scratchPath");
            value.as_object_mut().unwrap().remove("scratchUri");
            value["scratchPathsOmitted"] = json!(true);
        }
        Ok(value)
    }
}

impl Engine {
    pub(crate) fn command_scratch(&self, cell: &Cell) -> Option<PathBuf> {
        self.runtime.as_ref()?.command_scratch.as_ref().map(|root| {
            if cell.research {
                root.join(format!("agent-{}", cell.id))
            } else {
                root.clone()
            }
        })
    }
    pub(crate) fn scratch_uri(&self, cell: &Cell) -> String {
        if cell.research {
            format!("workspace://scratch/agent-{}", cell.id)
        } else {
            "workspace://scratch".into()
        }
    }
    pub(crate) fn scope_permissions(&self, cell: &Cell) -> rt::PermissionRequest {
        if cell.research {
            rt::PermissionRequest {
                write_roots: Some(vec![self.scratch_uri(cell)]),
                ..Default::default()
            }
        } else {
            rt::PermissionRequest::default()
        }
    }
    pub(crate) fn agent_budget_hint(&self, cell: &Cell) -> Option<String> {
        let config = self.extensions.agents.as_ref()?;
        let mut requests = config
            .max_model_requests
            .saturating_sub(self.agent_model_requests.load(Ordering::Relaxed));
        let mut tools = config
            .max_tool_calls
            .saturating_sub(self.agent_tool_calls.load(Ordering::Relaxed));
        if cell.research {
            requests = requests.min(
                config
                    .max_worker_model_requests
                    .saturating_sub(cell.agent_requests.load(Ordering::Relaxed)),
            );
            tools = tools.min(
                config
                    .max_worker_tool_calls
                    .saturating_sub(cell.agent_tools.load(Ordering::Relaxed)),
            );
        }
        (requests <= 8 || tools <= 12).then(|| format!("Agent budget remaining before this request: at most {requests} model requests and {tools} tool calls, subject to shared concurrent consumption. Conclude with verified evidence and remaining limitations before exhaustion; do not start broad new exploration."))
    }
    pub(crate) fn reserve_agent_model_request(&self, cell: &Cell) -> anyhow::Result<()> {
        if let Some(config) = &self.extensions.agents {
            if cell.research {
                reserve(
                    &cell.agent_requests,
                    config.max_worker_model_requests,
                    "research model request",
                )?;
            }
            reserve(
                &self.agent_model_requests,
                config.max_model_requests,
                "shared model request",
            )?;
        }
        Ok(())
    }
    pub(crate) fn reserve_agent_tool_call(&self, cell: &Cell) -> anyhow::Result<()> {
        if let Some(config) = &self.extensions.agents {
            if cell.research {
                reserve(
                    &cell.agent_tools,
                    config.max_worker_tool_calls,
                    "research tool call",
                )?;
            }
            reserve(
                &self.agent_tool_calls,
                config.max_tool_calls,
                "shared tool call",
            )?;
        }
        Ok(())
    }
}
fn reserve(counter: &AtomicUsize, limit: usize, label: &str) -> anyhow::Result<()> {
    counter
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |used| {
            (used < limit).then_some(used + 1)
        })
        .map_err(|_| anyhow::anyhow!("{label} budget exhausted"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct SummaryModel;
    #[async_trait::async_trait]
    impl Model for SummaryModel {
        fn name(&self) -> &str {
            "state-fixture"
        }
        async fn stream(&self, _: Vec<Message>) -> anyhow::Result<model::ModelStream> {
            Ok(Box::pin(futures_util::stream::pending()))
        }
        async fn chat_for(
            &self,
            _: Vec<Message>,
            _: Vec<Value>,
            purpose: model::RequestPurpose,
        ) -> anyhow::Result<model::AgentStream> {
            if purpose == model::RequestPurpose::Summary {
                Ok(Box::pin(futures_util::stream::iter([Ok(
                    ModelEvent::text("Original contract retained; command result still pending."),
                )])))
            } else {
                Ok(Box::pin(futures_util::stream::pending()))
            }
        }
    }
    #[tokio::test]
    async fn compact_retains_owned_state_but_new_turns_and_restart_expire_it() {
        let data = tempfile::tempdir().unwrap();
        let engine = Engine::open(
            data.path(),
            Arc::new(SummaryModel),
            Limits {
                context_window_bytes: 2200,
                context_recent_bytes: 256,
                ..Limits::default()
            },
        )
        .unwrap();
        let parent = engine.create("/fixture".into()).await.unwrap();
        let turn = engine
            .start(&parent.id, vec![Input::text("Keep original_api unchanged")])
            .await
            .unwrap();
        let other = engine.create("/fixture".into()).await.unwrap();
        engine
            .start(&other.id, vec![Input::text("unrelated")])
            .await
            .unwrap();
        let (child, _) = engine
            .spawn_child(&parent.id, vec![Input::text("inspect")])
            .await
            .unwrap();
        let cell = engine.cell(&parent.id).await.unwrap();
        let unrelated = engine.cell(&other.id).await.unwrap();
        assert!(owned_child(&engine, &cell, &child.id).await.is_ok());
        assert!(owned_child(&engine, &unrelated, &child.id).await.is_err());
        {
            let mut state = cell.state.lock().await;
            let active = state.active.as_mut().unwrap();
            active
                .handles
                .processes
                .insert("p-fixture".into(), "runtime-process".into());
            active.handles.process_snapshots.insert(
                "p-fixture".into(),
                json!({"processId":"p-fixture","state":"running","nextCursor":"c-fixture"}),
            );
            for _ in 0..3 {
                state
                    .thread
                    .turns
                    .last_mut()
                    .unwrap()
                    .items
                    .push(Item::AgentMessage {
                        id: id(),
                        text: "observed evidence ".repeat(100),
                    });
            }
        }
        let before = engine.task_state(&cell).await.unwrap();
        engine
            .compact_context(&cell, &CancellationToken::new(), 0, None, false)
            .await
            .unwrap();
        let after = engine.task_state(&cell).await.unwrap();
        assert_eq!(after["processes"], before["processes"]);
        assert_eq!(after["agentCount"], 1);
        assert!(after["summaryThroughItemId"].is_string());
        let recorded = engine.read(&parent.id, true).await.unwrap();
        assert!(
            history(&recorded, &engine.store).unwrap()[0]
                .text_content()
                .contains("original_api")
        );
        assert!(recorded.turns[0].items.len() >= 4);
        engine.interrupt(&parent.id, &turn.id).await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), engine.wait(&parent.id))
            .await
            .unwrap()
            .unwrap();
        engine
            .start(&parent.id, vec![Input::text("continue")])
            .await
            .unwrap();
        assert!(owned_child(&engine, &cell, &child.id).await.is_err());
        assert_eq!(engine.task_state(&cell).await.unwrap()["processCount"], 0);
        engine.shutdown().await;
        drop(engine);
        let engine = Engine::open(data.path(), Arc::new(SummaryModel), Limits::default()).unwrap();
        engine
            .start(&parent.id, vec![Input::text("resume")])
            .await
            .unwrap();
        let cell = engine.cell(&parent.id).await.unwrap();
        let state = engine.task_state(&cell).await.unwrap();
        assert_eq!(state["agentCount"], 0);
        assert_eq!(state["processCount"], 0);
        engine.shutdown().await;
    }
}
