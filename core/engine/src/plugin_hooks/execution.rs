use super::*;
impl Engine {
    async fn hook_input(&self, cell: &Cell, event: HookEvent, extra: Value) -> Value {
        let state = cell.state.lock().await;
        let mut input = json!({"session_id":state.thread.session_id,"transcript_path":null,"cwd":state.thread.cwd,"hook_event_name":event.as_str()});
        if event != HookEvent::SessionEnd {
            input["model"] = json!(
                state
                    .active
                    .as_ref()
                    .map_or_else(|| self.model.name(), |a| a.model.name())
            );
        }
        if !matches!(
            event,
            HookEvent::SessionEnd | HookEvent::PreCompact | HookEvent::PostCompact
        ) {
            input["permission_mode"] = json!(if self.permission_config().mode
                == areal_config::PermissionMode::Yolo
            {
                "bypassPermissions"
            } else {
                "default"
            });
        }
        if !matches!(event, HookEvent::SessionStart | HookEvent::SessionEnd) {
            input["turn_id"] = json!(
                state
                    .active
                    .as_ref()
                    .map(|a| a.id.clone())
                    .unwrap_or_default()
            );
        }
        if state.thread.parent_thread_id.is_some()
            && !matches!(event, HookEvent::SessionStart | HookEvent::SessionEnd)
        {
            input["agent_id"] = json!(cell.id);
            input["agent_type"] = json!(hook_agent_type(&state.thread));
            if event == HookEvent::SubagentStop {
                input["agent_transcript_path"] = Value::Null;
            }
        }
        if let Some(extra) = extra.as_object() {
            for (k, v) in extra {
                input[k] = v.clone();
            }
        }
        input
    }
    async fn record_hook(
        &self,
        cell: &Cell,
        invocation: &str,
        raw: Option<&runner::RawOutput>,
        output: &HookOutput,
    ) -> Result<()> {
        let mut state = cell.state.lock().await;
        let mut candidate = state.thread.clone();
        if let Some(r) = candidate
            .desktop
            .as_mut()
            .and_then(|d| d.hook_runs.iter_mut().find(|r| r.id == invocation))
        {
            r.operation_id = raw.and_then(|r| r.operation_id.clone());
            r.outcome = raw.map_or("failed", |r| r.outcome.as_str()).into();
            if output.failed && r.outcome == "succeeded" {
                r.outcome = "failed".into();
            }
            r.output = serde_json::to_value(output).map_err(invalid)?;
        }
        self.persist(&candidate).await?;
        state.thread = candidate;
        cell.emit(
            "areal/hook/completed",
            json!({"threadId":cell.id,"invocationId":invocation}),
        );
        Ok(())
    }
    async fn invoke_hook(
        self: &Arc<Self>,
        cell: Arc<Cell>,
        hook: BoundHook,
        input: Value,
        invocation: String,
        cancel: CancellationToken,
    ) -> HookOutput {
        let result = async {
            ensure_current(self, &cell, &hook).await?;
            if hook.packaged && !hook.read_only {
                tokio::fs::create_dir_all(&hook.data_root).await?;
            }
            runner::run(self, &cell, &hook, &input, &cancel).await
        }
        .await;
        let mut output = match &result {
            Ok(raw) => output::parse(
                hook.definition.event.as_str(),
                raw.exit_code,
                &raw.stdout,
                &raw.stderr,
                hook.definition.r#async,
            ),
            Err(_) => HookOutput {
                failed: true,
                warning: Some("Hook unavailable; no implicit control decision".into()),
                ..Default::default()
            },
        };
        if let Some(context) = output.context.take() {
            output.context = Some(
                self.spill_hook_context(
                    &cell,
                    &invocation,
                    context,
                    hook.definition.additional_context_limit.unwrap_or(2500),
                )
                .await,
            );
        }
        if self
            .record_hook(&cell, &invocation, result.as_ref().ok(), &output)
            .await
            .is_err()
        {
            cell.state.lock().await.poisoned = true;
            output = HookOutput {
                failed: true,
                ..Default::default()
            };
        }
        self.plugin_hooks
            .invocations
            .lock()
            .unwrap()
            .remove(&invocation);
        output
    }
    pub(crate) async fn plugin_hook_event(
        self: &Arc<Self>,
        cell: &Arc<Cell>,
        event: HookEvent,
        mut extra: Value,
        cancel: &CancellationToken,
    ) -> anyhow::Result<Effects> {
        let (hooks, activation) = {
            let state = cell.state.lock().await;
            (
                state.active.as_ref().map_or_else(
                    || self.frozen_plugin_hooks(&state.thread),
                    |a| a.hooks.clone(),
                ),
                state.active.as_ref().map(|a| a.id.clone()),
            )
        };
        let candidate = extra
            .get("tool_name")
            .or_else(|| extra.get("source"))
            .or_else(|| extra.get("reason"))
            .or_else(|| extra.get("agent_type"))
            .or_else(|| extra.get("trigger"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let hooks: Vec<_> = hooks
            .into_iter()
            .filter(|h| h.definition.matches(event, &[candidate]))
            .collect();
        if hooks.is_empty() {
            return Ok(Effects::default());
        }
        let admitted = extra
            .as_object_mut()
            .and_then(|object| object.remove("__areal_caller_admitted"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let input = self.hook_input(cell, event, extra).await;
        let mut pending = futures_util::stream::FuturesUnordered::new();
        let mut outcomes = Vec::new();
        for (order, mut hook) in hooks.into_iter().enumerate() {
            hook.caller_admitted = admitted;
            if ensure_current(self, cell, &hook).await.is_err() {
                continue;
            }
            let invocation = id();
            let asynchronous = hook.definition.r#async;
            let token = if asynchronous {
                cell.hooks.cancel.child_token()
            } else {
                cancel.child_token()
            };
            let mut state = cell.state.lock().await;
            anyhow::ensure!(
                state.active.as_ref().map(|a| &a.id) == activation.as_ref()
                    && !state.active.as_ref().is_some_and(|a| a.sealed),
                "hook activation changed before admission"
            );
            anyhow::ensure!(
                event == HookEvent::SessionEnd || !cell.hooks.closing.load(Ordering::Acquire),
                "hook session closing before admission"
            );
            let turn_tasks = state.active.as_ref().map(|a| a.hook_tasks.clone());
            let mut candidate = state.thread.clone();
            let turn_id = state.active.as_ref().map(|a| a.id.clone());
            let runs = &mut candidate
                .desktop
                .get_or_insert_with(Default::default)
                .hook_runs;
            if runs.len() >= 1024 {
                if let Some(index) = runs
                    .iter()
                    .position(|r| r.outcome != "running" && r.outcome != "unknown" && r.delivered)
                {
                    runs.remove(index);
                } else {
                    anyhow::bail!("hook receipt capacity exhausted; inspect UNKNOWN");
                }
            }
            runs.push(HookRun {
                id: invocation.clone(),
                plugin_id: hook.plugin_id.clone(),
                package_digest: hook.package_digest.clone(),
                definition_digest: hook.definition.digest.clone(),
                event: event.as_str().into(),
                turn_id,
                tool_use_id: input["tool_use_id"].as_str().map(str::to_owned),
                operation_id: None,
                outcome: "running".into(),
                asynchronous,
                delivered: false,
                output: Value::Null,
                inspection: None,
            });
            self.persist(&candidate).await?;
            state.thread = candidate;
            self.plugin_hooks.invocations.lock().unwrap().insert(
                invocation.clone(),
                (hook.plugin_id.clone(), hook.packaged, token.clone()),
            );
            let engine = self.clone();
            let cell = cell.clone();
            let input = input.clone();
            // Session tasks own accepted work when a request future is dropped.
            let handle=cell.hooks.tasks.spawn({let cell=cell.clone();async move{
                let capacity=if asynchronous{tokio::select!{_ = token.cancelled()=>None,p=cell.hooks.capacity.acquire()=>p.ok()}}else{None};
                let output=engine.invoke_hook(cell.clone(),hook,input,invocation,token).await;drop(capacity);output
            }});
            if !asynchronous {
                if let Some(tasks) = turn_tasks {
                    let joined = tasks.spawn(async move { handle.await.unwrap_or_default() });
                    pending.push(
                        Box::pin(async move { (order, joined.await.unwrap_or_default()) })
                            as std::pin::Pin<
                                Box<dyn std::future::Future<Output = (usize, HookOutput)> + Send>,
                            >,
                    );
                } else {
                    pending.push(
                        Box::pin(async move { (order, handle.await.unwrap_or_default()) })
                            as std::pin::Pin<
                                Box<dyn std::future::Future<Output = (usize, HookOutput)> + Send>,
                            >,
                    );
                }
            }
            // Receipt, execution task and Turn tracker are admitted while the same
            // thread lock prevents terminal settlement from observing half an admission.
            drop(state);
        }
        let mut effects = Effects::default();
        let mut latest_rewrite = None;
        while let Some((order, output)) = pending.next().await {
            if let Some(value) = &output.updated_input {
                latest_rewrite = Some(value.clone());
            }
            outcomes.push((order, output));
        }
        outcomes.sort_by_key(|(order, _)| *order);
        for (_, output) in outcomes {
            if effects.block.is_none() {
                effects.block = output.block;
            }
            if effects.stop.is_none() {
                effects.stop = output.stop;
            }
            if let Some(reason) = output.continuation {
                effects.continuation.push(reason);
            }
            match output.permission {
                Some(PermissionDecision::Deny { reason }) => {
                    effects.permission = Some(PermissionDecision::Deny { reason })
                }
                Some(PermissionDecision::Allow)
                    if !matches!(effects.permission, Some(PermissionDecision::Deny { .. })) =>
                {
                    effects.permission = Some(PermissionDecision::Allow)
                }
                _ => {}
            }
        }
        if effects.block.is_none() {
            effects.updated_input = latest_rewrite;
        }
        // Async results are drained only by lifecycle/generation safe points.
        let closing_side = if event == HookEvent::SessionEnd {
            let state = cell.state.lock().await;
            state.thread.is_executable_side()
                && state
                    .thread
                    .desktop
                    .as_ref()
                    .is_some_and(|data| data.archived)
        } else {
            false
        };
        if !closing_side {
            self.drain_hook_results(cell, false).await?;
        }
        Ok(effects)
    }
    pub(crate) async fn drain_hook_results(
        &self,
        cell: &Cell,
        include_async: bool,
    ) -> Result<bool> {
        let mut state = cell.state.lock().await;
        if state.thread.desktop.as_ref().is_some_and(|d| {
            d.hook_runs
                .iter()
                .any(|r| r.outcome == "unknown" && r.inspection.is_none())
        }) {
            return Err(Error::Invalid(
                "UNKNOWN hook execution or cleanup; inspect before continuing, no replay".into(),
            ));
        }
        if state.active.is_none() {
            return Ok(false);
        }
        let mut candidate = state.thread.clone();
        let mut contexts = Vec::new();
        let mut warnings = Vec::new();
        let mut changed = false;
        let mut async_context = false;
        for run in &mut candidate
            .desktop
            .get_or_insert_with(Default::default)
            .hook_runs
        {
            if run.delivered
                || run.outcome == "running"
                || run.outcome == "unknown"
                || (!include_async && run.asynchronous)
            {
                continue;
            }
            let output: HookOutput = serde_json::from_value(run.output.clone()).unwrap_or_default();
            if let Some(context) = output.context {
                async_context |= run.asynchronous;
                contexts.push(format!(
                    "hooks.additional_context [{}]: {context}",
                    run.event
                ));
            }
            if let Some(warning) = output.warning {
                warnings.push(warning);
            }
            run.delivered = true;
            changed = true;
        }
        if !changed {
            return Ok(false);
        }
        for context in contexts {
            candidate.turns.last_mut().unwrap().items.push(Item::ModelContext{id:id(),value:json!({"type":"areal_request_context","messages":[{"role":"areal_context","text":context}]})});
        }
        self.persist(&candidate).await?;
        state.thread = candidate;
        for warning in warnings {
            cell.emit(
                "areal/hook/warning",
                json!({"threadId":cell.id,"message":warning}),
            );
        }
        Ok(async_context)
    }
}
