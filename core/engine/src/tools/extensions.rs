//! Tool dispatch and lifecycle hooks. Command tools and hooks belong to the Turn's Runtime scope.
use super::*;
use areal_protocol::{DynamicToolResponse, HookExecution};
use registry::RegisteredTool;

pub(super) struct Invocation<'a> {
    pub engine: &'a Arc<Engine>,
    pub cell: &'a Arc<Cell>,
    pub cancel: &'a CancellationToken,
    pub call: &'a ToolCall,
    pub scope: &'a str,
    pub operation: &'a str,
    pub item_id: &'a str,
    pub thread_id: &'a str,
    pub turn_id: &'a str,
    pub host: Option<Arc<dyn DynamicToolHost>>,
    pub entry: Arc<RegisteredTool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HookResponse {
    #[serde(default)]
    decision: Decision,
    reason: Option<String>,
    updated_arguments: Option<Value>,
}
#[derive(Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Decision {
    #[default]
    Allow,
    Block,
}

fn invalid(error: impl std::fmt::Display) -> rt::Error {
    rt::Error::new(rt::ErrorCode::InvalidArgument, error.to_string())
}
fn unknown(error: impl std::fmt::Display) -> rt::Error {
    rt::Error::new(rt::ErrorCode::Unavailable, error.to_string())
}
fn uncertain(error: &rt::Error) -> bool {
    matches!(
        error.code,
        rt::ErrorCode::Unavailable | rt::ErrorCode::StaleHandle | rt::ErrorCode::CleanupFailed
    )
}

impl Invocation<'_> {
    pub async fn run(&self, post_hook_failed: &mut bool) -> rt::Result<(bool, Value)> {
        let mut arguments: Value = serde_json::from_str(&self.call.arguments).map_err(invalid)?;
        self.validate(&arguments)?;
        {
            let state = self.cell.state.lock().await;
            if state
                .thread
                .turns
                .last()
                .and_then(|t| t.configuration.as_ref())
                .is_some_and(|c| c.read_only)
                && matches!(
                    self.entry.backend,
                    Backend::Client | Backend::Mcp(_) | Backend::Plugin(_) | Backend::Coordination
                )
                && !crate::agents::read_only_tool(&self.call.name, &self.entry.backend)
            {
                return Err(rt::Error::new(
                    rt::ErrorCode::PermissionDenied,
                    "read-only turns cannot invoke ambient hosts or writable workgroup executors",
                ));
            }
            if state
                .thread
                .turns
                .last()
                .and_then(|turn| turn.configuration.as_ref())
                .and_then(|c| c.tool_allowlist.as_ref())
                .is_some_and(|allowlist| !allowlist.contains(&self.call.name))
            {
                return Err(rt::Error::new(
                    rt::ErrorCode::PermissionDenied,
                    "tool is outside the immutable Turn allowlist",
                ));
            }
        }
        if matches!(self.entry.backend, Backend::Coordination | Backend::Core) {
            self.engine
                .approval(
                    self.cell,
                    &self.call.id,
                    &self.call.name,
                    &arguments,
                    self.cancel,
                )
                .await?;
            return self.invoke(&arguments).await;
        }
        for hook in self.hooks(HookEvent::PreToolUse) {
            let response = self.hook(hook, &arguments, None).await?;
            if response.decision == Decision::Block {
                return Ok((
                    false,
                    json!({"blockedByHook":hook.name,"reason":response.reason}),
                ));
            }
            if let Some(updated) = response.updated_arguments {
                self.validate(&updated)?;
                arguments = updated;
                self.edit(|execution, _| execution.effective_arguments = Some(arguments.clone()))
                    .await?;
            }
        }
        self.engine
            .approval(
                self.cell,
                &self.call.id,
                &self.call.name,
                &arguments,
                self.cancel,
            )
            .await?;
        let result = if matches!(self.entry.backend, Backend::Mcp(_) | Backend::Plugin(_)) {
            // These backends own cancellation and cleanup; do not drop their futures first.
            self.invoke(&arguments).await
        } else {
            tokio::select! {
                biased;
                _ = self.cancel.cancelled() => Err(unknown("interrupted tool invocation; outcome is UNKNOWN")),
                result = self.invoke(&arguments) => result,
            }
        };
        if result.as_ref().is_err_and(uncertain) {
            return result;
        }
        let (success, value) = match result {
            Ok(result) => result,
            Err(error) => (false, self.failure(&arguments, error)),
        };
        let event = if success {
            HookEvent::PostToolUse
        } else {
            HookEvent::PostToolUseFailure
        };
        let hooks = self.hooks(event);
        if !hooks.is_empty() {
            // Commit the actual tool outcome before invoking potentially effectful hooks.
            // A hook failure must never turn a successful write into a retryable failure.
            self.edit(|execution, content| {
                execution.outcome = if success {
                    ToolOutcome::Succeeded
                } else {
                    ToolOutcome::Failed
                };
                *content = Some(content_items(&value));
            })
            .await?;
        }
        for hook in hooks {
            if self.hook(hook, &arguments, Some(&value)).await.is_err() {
                *post_hook_failed = true;
                break;
            }
        }
        Ok((success, value))
    }

    fn failure(&self, arguments: &Value, error: rt::Error) -> Value {
        let create_conflict = matches!(self.entry.backend, Backend::Builtin)
            && self.call.name == "fs_write"
            && arguments.get("expectedSha256") == Some(&Value::Null)
            && error.code == rt::ErrorCode::Conflict;
        let mut value = json!({"error":error});
        if create_conflict {
            value["hint"] = json!(
                "expectedSha256=null creates a new file. Read the existing file with fs_read, then use its full-file sha256 for fs_write or fs_apply_patch. Do not retry creation or overwrite without a fresh hash."
            );
        }
        value
    }

    fn validate(&self, args: &Value) -> rt::Result<()> {
        if serde_json::to_vec(args).map_err(invalid)?.len() > registry::MAX_ARGUMENT_BYTES {
            return Err(invalid("tool arguments exceed 64 KiB"));
        }
        self.entry.validate_input(args).map_err(invalid)
    }
    fn hooks(&self, event: HookEvent) -> Vec<&HookDefinition> {
        if self.cell.research {
            return Vec::new();
        }
        self.engine
            .extensions
            .hooks
            .iter()
            .filter(|h| h.event == event && (h.matcher == "*" || h.matcher == self.call.name))
            .collect()
    }
    async fn invoke(&self, args: &Value) -> rt::Result<(bool, Value)> {
        let mut response = match &self.entry.backend {
            Backend::Agent => {
                return super::agents::invoke(self.engine, self.cell, &self.call.name, args)
                    .await
                    .map_err(invalid);
            }
            Backend::Core => {
                return self
                    .engine
                    .core_tool(self.cell, &self.call.id, &self.call.name, args, self.cancel)
                    .await
                    .map(|value| (true, value))
                    .map_err(invalid);
            }
            Backend::Coordination => {
                if self.call.name.starts_with("agent_") {
                    return self
                        .engine
                        .coordinate_agent(
                            self.cell,
                            self.turn_id,
                            &self.call.name,
                            args,
                            self.cancel,
                        )
                        .await
                        .map(|value| (true, value))
                        .map_err(|error| {
                            if matches!(error.downcast_ref::<Error>(), Some(Error::Storage(_))) {
                                unknown(error)
                            } else {
                                invalid(error)
                            }
                        });
                }
                return self
                    .engine
                    .coordinate(
                        &format!("{}/{}", self.thread_id, self.turn_id),
                        &self.call.name,
                        args,
                        self.cancel,
                    )
                    .await
                    .map(|value| (true, value))
                    .map_err(invalid);
            }
            Backend::Builtin => {
                if self.call.name == "task_state" {
                    return self
                        .engine
                        .task_state(self.cell)
                        .await
                        .map(|value| (true, value))
                        .map_err(invalid);
                }
                let runtime = self
                    .engine
                    .runtime
                    .as_ref()
                    .expect("registered Runtime tool");
                let mut effective = args.clone();
                let state = self.cell.state.lock().await;
                state
                    .active
                    .as_ref()
                    .unwrap()
                    .handles
                    .resolve(&self.call.name, &mut effective, runtime)
                    .map_err(invalid)?;
                let call = ToolCall {
                    id: self.call.id.clone(),
                    name: self.call.name.clone(),
                    arguments: effective.to_string(),
                };
                if matches!(call.name.as_str(), "read_file" | "search_files") {
                    drop(state);
                    return navigation::invoke(
                        runtime,
                        self.scope,
                        self.operation,
                        &call.name,
                        &effective,
                    )
                    .await;
                }
                if call.name == "image_read" {
                    drop(state);
                    return images::read(self.engine, runtime, self.scope, &effective).await;
                }
                let mut request = request_with_policy(
                    &call,
                    &runtime.workspace,
                    &runtime.client.info().runtime_epoch,
                    &state.active.as_ref().unwrap().process_cursors,
                    &self.engine.extensions.policy,
                )
                .map_err(invalid)?;
                drop(state);
                if effective != *args {
                    self.edit(|execution, _| {
                        execution.model_arguments = Some(args.clone());
                        execution.effective_arguments = Some(effective.clone());
                    })
                    .await?;
                }
                let mut verification_receipt = None;
                if let Request::Command(command) = &mut request {
                    let scope: rt::ScopeInfo = runtime
                        .client
                        .call("scope.get", json!({"scopeId":self.scope}))
                        .await?;
                    command.timeout_ms = command.timeout_ms.min(scope.limits.wall_time_ms);
                    if call.name == "verify_command" {
                        let scratch = self.engine.command_scratch(self.cell).ok_or_else(|| {
                            invalid("verify_command requires configured task scratch")
                        })?;
                        let cwd = if command.cwd == "workspace://repo" {
                            runtime.workspace.clone()
                        } else if let Some(path) = command.cwd.strip_prefix("workspace://repo/") {
                            runtime.workspace.join(path)
                        } else if command.cwd == "workspace://scratch" {
                            runtime.command_scratch.as_ref().unwrap().clone()
                        } else if let Some(path) = command.cwd.strip_prefix("workspace://scratch/")
                        {
                            runtime.command_scratch.as_ref().unwrap().join(path)
                        } else {
                            return Err(invalid("unsupported verification cwd"));
                        };
                        let identity = uuid::Uuid::new_v4().simple().to_string();
                        verification_receipt = Some(format!(
                            "{}/verification/{identity}.json",
                            self.engine.scratch_uri(self.cell)
                        ));
                        let request = json!({"argv":command.argv,"cwd":cwd,"workspace":runtime.workspace,"scratch":scratch,"identity":identity});
                        command.argv = vec![
                            "/usr/bin/python3".into(),
                            "-I".into(),
                            "-B".into(),
                            "-c".into(),
                            include_str!("verification.py").into(),
                            request.to_string(),
                        ];
                    }
                }
                if let Request::Command(command) = &mut request
                    && let Some(scratch) = self.engine.command_scratch(self.cell)
                {
                    let mut argv = vec![
                        "/usr/bin/env".into(),
                        format!("TMPDIR={}", scratch.display()),
                        "PYTHONDONTWRITEBYTECODE=1".into(),
                    ];
                    argv.append(&mut command.argv);
                    command.argv = argv;
                }
                let (success, mut result) = execute(
                    &runtime.client,
                    request,
                    self.scope,
                    self.operation,
                    &self.engine.extensions.policy,
                )
                .await?;
                if let Some(process) = result["processId"].as_str().map(str::to_owned) {
                    let receipt = {
                        let mut state = self.cell.state.lock().await;
                        let handles = &mut state.active.as_mut().unwrap().handles;
                        if let Some(receipt) = verification_receipt {
                            handles.verification.insert(process.clone(), receipt);
                        }
                        if handles.verification.contains_key(&process) {
                            if result["state"] == "exited" {
                                handles.pending_verifications.remove(&process);
                            } else {
                                handles.pending_verifications.insert(process.clone());
                            }
                        }
                        handles.verification.get(&process).cloned()
                    };
                    if let Some(receipt) = receipt {
                        verification::attach(&runtime.client, self.scope, &receipt, &mut result)
                            .await;
                    }
                }
                return Ok((success, result));
            }
            Backend::Command(tool) => {
                let value = self
                    .command(&tool.argv, tool.timeout_ms, self.operation, args)
                    .await?;
                serde_json::from_value::<DynamicToolResponse>(value).map_err(unknown)?
            }
            Backend::Mcp(tool) => tool
                .call(args.clone(), self.cancel.clone())
                .await
                .map_err(unknown)?,
            Backend::Plugin(tool) => self.plugin(tool, args).await?,
            Backend::Client => {
                let host = self
                    .host
                    .as_ref()
                    .ok_or_else(|| unknown("dynamic tool client is unavailable"))?;
                host.call(json!({"threadId":self.thread_id,"turnId":self.turn_id,"callId":self.call.id,"tool":self.call.name,"arguments":args,"hostGeneration":host.id()}), self.cancel.clone()).await.map_err(unknown)?
            }
        };
        self.engine
            .materialize_tool_media(self.cell, &mut response.content_items)
            .await
            .map_err(unknown)?;
        let value = serde_json::to_value(&response).map_err(unknown)?;
        if serde_json::to_vec(&value).map_err(unknown)?.len() > MAX_RESULT
            || serde_json::to_vec(&content_items(&value))
                .map_err(unknown)?
                .len()
                > MAX_RESULT
        {
            return Err(unknown(
                "custom tool result exceeds 16 KiB; inspect before retrying",
            ));
        }
        if response.success {
            self.entry
                .validate_output(response.structured_content.as_ref().unwrap_or(&Value::Null))
                .map_err(unknown)?;
        }
        Ok((response.success, value))
    }

    async fn hook(
        &self,
        hook: &HookDefinition,
        args: &Value,
        result: Option<&Value>,
    ) -> rt::Result<HookResponse> {
        self.engine.approval(self.cell, &self.call.id, &format!("hook:{}",hook.name), &json!({"argv":hook.argv,"event":hook.event,"tool":self.call.name,"arguments":args}),self.cancel).await?;
        let runtime = self.engine.runtime.as_ref().expect("hooks require Runtime");
        let operation = runtime.client.operation_id();
        self.edit(|execution, _| {
            execution.hooks.push(HookExecution {
                name: hook.name.clone(),
                event: hook.event.as_str().into(),
                operation_id: operation.clone(),
                outcome: ToolOutcome::Running,
                result: None,
            })
        })
        .await?;
        let payload = json!({"event":hook.event,"threadId":self.thread_id,"turnId":self.turn_id,"callId":self.call.id,"tool":self.call.name,"arguments":args,"result":result});
        let result = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => Err(unknown("interrupted hook; outcome is UNKNOWN")),
            result = self.command(&hook.argv, hook.timeout_ms, &operation, &payload) => result,
        };
        let parsed = result.and_then(|value| {
            let response: HookResponse = serde_json::from_value(value.clone()).map_err(unknown)?;
            if hook.event != HookEvent::PreToolUse
                && (response.decision != Decision::Allow || response.updated_arguments.is_some())
            {
                return Err(unknown("post-tool hooks cannot block or change arguments"));
            }
            Ok((response, value))
        });
        self.edit(|execution, _| {
            let entry = execution
                .hooks
                .iter_mut()
                .find(|h| h.operation_id == operation)
                .unwrap();
            match &parsed {
                Ok((_, value)) => {
                    entry.outcome = ToolOutcome::Succeeded;
                    entry.result = Some(value.clone());
                }
                Err(error) => {
                    entry.outcome = if uncertain(error) {
                        ToolOutcome::Unknown
                    } else {
                        ToolOutcome::Failed
                    };
                    entry.result = Some(json!({"error":error}));
                }
            }
        })
        .await?;
        parsed.map(|(response, _)| response)
    }

    pub(super) async fn edit(
        &self,
        update: impl FnOnce(&mut ToolExecution, &mut Option<Vec<Value>>),
    ) -> rt::Result<()> {
        let mut state = self.cell.state.lock().await;
        let mut candidate = state.thread.clone();
        let item = candidate
            .turns
            .last_mut()
            .unwrap()
            .items
            .iter_mut()
            .find(|i| i.id() == self.item_id)
            .unwrap();
        if let Item::DynamicToolCall {
            execution,
            content_items,
            status,
            success,
            ..
        } = item
        {
            update(execution, content_items);
            if matches!(
                execution.outcome,
                ToolOutcome::Succeeded | ToolOutcome::Failed
            ) {
                let succeeded = execution.outcome == ToolOutcome::Succeeded;
                *success = Some(succeeded);
                *status = if succeeded {
                    ToolStatus::Completed
                } else {
                    ToolStatus::Failed
                };
            }
        }
        if let Err(error) = self.engine.persist(&candidate).await {
            state.poisoned = true;
            return Err(unknown(error));
        }
        state.thread = candidate;
        Ok(())
    }

    /// A JSON line in, one JSON document out. Runtime owns timeouts, pipes and cleanup.
    async fn command(
        &self,
        argv: &[String],
        timeout_ms: u64,
        operation: &str,
        input: &Value,
    ) -> rt::Result<Value> {
        let client = &self
            .engine
            .runtime
            .as_ref()
            .expect("command requires Runtime")
            .client;
        let started = client
            .start(rt::StartProcess {
                operation_id: operation.into(),
                scope_id: self.scope.into(),
                argv: argv.to_vec(),
                cwd: "workspace://repo".into(),
                env: BTreeMap::new(),
                tty: false,
                pipe_stdin: true,
                limits: rt::LimitRequest {
                    wall_time_ms: Some(timeout_ms),
                    output_bytes: Some((MAX_RESULT * 2) as u64),
                    max_processes: None,
                },
            })
            .await?;
        // Runtime bounds the encoded operation envelope, including base64 overhead.
        // Chunking also handles hook metadata around an otherwise valid 64 KiB input.
        let input = format!("{input}\n");
        for chunk in input.as_bytes().chunks(16 * 1024) {
            client
                .write(rt::ProcessInput {
                    operation_id: client.operation_id(),
                    process_id: started.process_id.clone(),
                    data_base64: STANDARD.encode(chunk),
                })
                .await
                .map_err(unknown)?;
        }
        let mut after = None;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        loop {
            let page = client
                .output(rt::ReadOutput {
                    process_id: started.process_id.clone(),
                    after,
                    max_bytes: 4096,
                    wait_ms: 1000,
                })
                .await
                .map_err(unknown)?;
            for chunk in page.chunks {
                let bytes = STANDARD.decode(chunk.data_base64).map_err(unknown)?;
                match chunk.stream {
                    rt::OutputStream::Stderr => stderr.extend(bytes),
                    _ => stdout.extend(bytes),
                }
            }
            if page.gap || page.truncated || stdout.len() > MAX_RESULT || stderr.len() > MAX_RESULT
            {
                client
                    .terminate(&started.process_id)
                    .await
                    .map_err(unknown)?;
                client.wait(&started.process_id).await.map_err(unknown)?;
                return Err(unknown(
                    "extension output exceeded its limit; inspect before retrying",
                ));
            }
            after = Some(page.next_cursor);
            if page.closed {
                break;
            }
        }
        let done = client.wait(&started.process_id).await.map_err(unknown)?;
        if done.state == rt::ProcessState::Unknown {
            return Err(unknown("extension process outcome is UNKNOWN"));
        }
        if done.exit_code != Some(0) || done.stop_reason.is_some() {
            // A nonzero exit can follow a partial side effect: do not invite automatic replay.
            return Err(unknown(format!(
                "extension command did not complete successfully: exit={:?}, stop={:?}, stderr={}",
                done.exit_code,
                done.stop_reason,
                String::from_utf8_lossy(&stderr)
            )));
        }
        serde_json::from_slice(&stdout)
            .map_err(|e| unknown(format!("invalid extension JSON result: {e}")))
    }
}

pub(super) fn content_items(value: &Value) -> Vec<Value> {
    let mut items = value
        .get("contentItems")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| vec![json!({"type":"inputText","text":value.to_string()})]);
    if let Some(structured) = value.get("structuredContent") {
        items.push(json!({"type":"inputText","text":structured.to_string()}));
    }
    items
}
