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
    pub granted_scope: Option<String>,
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
    pub async fn run(mut self, post_hook_failed: &mut bool) -> rt::Result<(bool, Value)> {
        let mut arguments: Value = serde_json::from_str(&self.call.arguments).map_err(invalid)?;
        self.validate(&arguments)?;
        {
            let state = self.cell.state.lock().await;
            if state.thread.is_read_only_side()
                && !(matches!(
                    self.call.name.as_str(),
                    "side_context_read" | "gen_ui_publish"
                ) && matches!(self.entry.backend, Backend::Core))
                && !(state.thread.side_workspace_read()
                    && super::side_file_tool(&self.call.name, &self.entry.backend))
            {
                return Err(rt::Error::new(
                    rt::ErrorCode::PermissionDenied,
                    "SIDE_POLICY_VIOLATION",
                ));
            }
            if state.thread.side_workspace_read()
                && super::side_file_tool(&self.call.name, &self.entry.backend)
            {
                if !self.engine.side_workspace_read_available() {
                    return Err(rt::Error::new(
                        rt::ErrorCode::Unavailable,
                        "WORKSPACE_READ_UNAVAILABLE",
                    ));
                }
                let path = arguments.get("path").and_then(Value::as_str).unwrap_or(".");
                let runtime = self.engine.runtime.as_ref().ok_or_else(|| {
                    rt::Error::new(rt::ErrorCode::Unavailable, "WORKSPACE_READ_UNAVAILABLE")
                })?;
                let uri = super::resource_uri(path, runtime).map_err(invalid)?;
                if uri != "workspace://repo" && !uri.starts_with("workspace://repo/") {
                    return Err(rt::Error::new(
                        rt::ErrorCode::PermissionDenied,
                        "SIDE_POLICY_VIOLATION",
                    ));
                }
            }
            if state
                .thread
                .turns
                .last()
                .and_then(|t| t.configuration.as_ref())
                .is_some_and(|c| c.read_only)
                && matches!(
                    self.entry.backend,
                    Backend::Client
                        | Backend::Page(_)
                        | Backend::Mcp(_)
                        | Backend::Plugin(_)
                        | Backend::Coordination
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
        let (hook_name, hook_input) = crate::plugin_hooks::tool_input(&self.call.name, &arguments);
        let effects=self.engine.plugin_hook_event(self.cell,areal_plugins::hooks::HookEvent::PreToolUse,
            json!({"tool_name":hook_name,"tool_input":hook_input,"tool_use_id":self.call.id,"__areal_caller_admitted":!matches!(self.entry.backend,Backend::Agent|Backend::Coordination|Backend::Core)}),self.cancel).await.map_err(unknown)?;
        if let Some(reason) = effects.block {
            return Ok((false, json!({"blockedByHook":true,"reason":reason})));
        }
        if let Some(updated) = effects.updated_input {
            arguments = crate::plugin_hooks::updated_input(&self.call.name, &arguments, updated)
                .map_err(invalid)?;
            self.validate(&arguments)?;
            self.edit(|execution, _| execution.effective_arguments = Some(arguments.clone()))
                .await?;
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
            if self.cancel.is_cancelled() {
                return Err(rt::Error::new(
                    rt::ErrorCode::ScopeClosed,
                    "cancelled before dispatch",
                ));
            }
            let (success, value) = self.invoke(&arguments, None).await?;
            return self.codex_post(&arguments, success, value).await;
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
        let hook_arguments = arguments.clone();
        if matches!(self.entry.backend, Backend::Builtin)
            && let Some(runtime) = &self.engine.runtime
        {
            let model_arguments = arguments.clone();
            self.cell
                .state
                .lock()
                .await
                .active
                .as_ref()
                .unwrap()
                .handles
                .resolve(&self.call.name, &mut arguments, runtime)
                .map_err(invalid)?;
            if arguments != model_arguments {
                self.edit(|execution, _| {
                    execution.model_arguments = Some(model_arguments.clone());
                    execution.effective_arguments = Some(arguments.clone());
                })
                .await?;
            }
        }
        let requested_permissions = self
            .engine
            .requested_permissions(self.cell, &self.call.name, &mut arguments)
            .await?;
        if requested_permissions.is_some() {
            self.edit(|execution, _| execution.effective_arguments = Some(arguments.clone()))
                .await?;
        }
        let explicit_preset = self
            .cell
            .state
            .lock()
            .await
            .thread
            .turns
            .last()
            .and_then(|turn| turn.configuration.as_ref())
            .and_then(|c| c.options.permission_preset)
            .is_some();
        let browser_plan = if self.call.name == "browser_v1"
            && matches!(self.entry.backend, Backend::Client)
            && ((explicit_preset && arguments["operation"] == "describe")
                || matches!(
                    arguments["operation"].as_str(),
                    Some(
                        "act"
                            | "wait"
                            | "navigate"
                            | "newPage"
                            | "runBatch"
                            | "observe"
                            | "capture"
                            | "diagnostics"
                            | "command"
                    )
                )) {
            let host = self
                .host
                .as_ref()
                .ok_or_else(|| invalid("browser host unavailable"))?;
            let prepared = host.prepare_browser(json!({"threadId":self.thread_id,"turnId":self.turn_id,
                "callId":self.call.id,"tool":"browser_v1","arguments":arguments,"hostGeneration":host.id()}),
                self.cancel.clone()).await.map_err(invalid)?
                .ok_or_else(|| invalid("browser prepare capability unavailable"))?;
            if let Some(code) = prepared["error"].as_str() {
                return Err(invalid(format!(
                    "browser prepare {code}; dispatch is not_sent"
                )));
            }
            if prepared["preparedActionId"]
                .as_str()
                .is_none_or(str::is_empty)
                || (arguments["operation"] != "describe"
                    && prepared["pageId"] != arguments["parameters"]["pageId"])
                || prepared["operation"] != arguments["operation"]
                || prepared["origin"].as_str().is_none()
                || prepared["fingerprint"].as_str().is_none()
            {
                return Err(invalid("browser host returned an invalid plan"));
            }
            self.edit(|execution, _| {
                // 审批计划留在审计记录，模型回放只使用经 hooks 校验的规范参数。
                execution.model_arguments = Some(arguments.clone());
                execution.effective_arguments = Some(json!({"arguments":arguments,"plan":prepared}))
            })
            .await?;
            Some(prepared)
        } else {
            None
        };
        let computer_plan = if self.call.name == "computer_v1"
            && matches!(self.entry.backend, Backend::Client)
        {
            if self
                .cell
                .state
                .lock()
                .await
                .thread
                .parent_thread_id
                .is_some()
            {
                return Err(invalid("computer control is unavailable in child threads"));
            }
            let host = self
                .host
                .as_ref()
                .ok_or_else(|| invalid("computer host unavailable"))?;
            let prepared = host.prepare_computer(json!({"threadId":self.thread_id,"turnId":self.turn_id,
                "callId":self.call.id,"tool":"computer_v1","arguments":arguments,"hostGeneration":host.id()}),
                self.cancel.clone()).await.map_err(invalid)?
                .ok_or_else(|| invalid("computer prepare capability unavailable"))?;
            if let Some(code) = prepared["error"].as_str() {
                let mut error = invalid(format!("computer prepare {code}; dispatch is not_sent"));
                error.details = Some(prepared);
                return Err(error);
            }
            if prepared["preparedActionId"]
                .as_str()
                .is_none_or(str::is_empty)
                || prepared["operation"] != arguments["operation"]
                || prepared["parameters"] != arguments["parameters"]
                || prepared["origin"].as_str().is_none()
                || prepared["fingerprint"].as_str().is_none_or(str::is_empty)
            {
                return Err(invalid("computer host returned an invalid plan"));
            }
            self.edit(|execution, _| {
                execution.model_arguments = Some(arguments.clone());
                execution.effective_arguments =
                    Some(json!({"arguments":arguments,"plan":prepared}));
            })
            .await?;
            Some(prepared)
        } else {
            None
        };
        let approval_arguments = browser_plan
            .as_ref()
            .or(computer_plan.as_ref())
            .map(|plan| json!({"arguments":arguments,"plan":plan}));
        if let Err(error) = self
            .engine
            .approval(
                self.cell,
                &self.call.id,
                &self.call.name,
                approval_arguments.as_ref().unwrap_or(&arguments),
                self.cancel,
            )
            .await
        {
            self.discard_computer_plan(&arguments, computer_plan.as_ref())
                .await;
            return Err(error);
        }
        if self.cancel.is_cancelled() {
            self.discard_computer_plan(&arguments, computer_plan.as_ref())
                .await;
            return Err(rt::Error::new(
                rt::ErrorCode::ScopeClosed,
                "cancelled after approval",
            ));
        }
        if let Some(permissions) = requested_permissions {
            self.granted_scope = Some(
                self.engine
                    .approved_operation_scope(self.cell, &self.call.id, permissions)
                    .await?,
            );
        } else if matches!(
            self.call.name.as_str(),
            "read_process" | "write_process" | "terminate_process"
        ) {
            self.granted_scope = self
                .cell
                .state
                .lock()
                .await
                .active
                .as_ref()
                .and_then(|active| {
                    arguments["processId"]
                        .as_str()
                        .and_then(|id| active.handles.process_scopes.get(id))
                })
                .cloned();
            if let Some(scope) = &self.granted_scope {
                self.edit(|execution, _| execution.scope_id = scope.clone())
                    .await?;
            }
        }
        if browser_plan.is_some() || computer_plan.is_some() {
            let current = self.cell.bindings.read().await.host.clone();
            if self
                .host
                .as_ref()
                .zip(current.as_ref())
                .is_none_or(|(prepared, active)| prepared.id() != active.id() || active.is_closed())
            {
                self.discard_computer_plan(&arguments, computer_plan.as_ref())
                    .await;
                return Err(invalid(
                    "desktop host changed after approval; prepare again",
                ));
            }
        }
        if self.cancel.is_cancelled() && !matches!(self.entry.backend, Backend::Page(_)) {
            self.discard_computer_plan(&arguments, computer_plan.as_ref())
                .await;
            return Err(rt::Error::new(
                rt::ErrorCode::ScopeClosed,
                "cancelled before dispatch",
            ));
        }
        let result = if matches!(
            self.entry.backend,
            Backend::Mcp(_) | Backend::Plugin(_) | Backend::Page(_)
        ) {
            // These backends own cancellation and cleanup; do not drop their futures first.
            self.invoke(&arguments, browser_plan.as_ref().or(computer_plan.as_ref()))
                .await
        } else if matches!(self.entry.backend, Backend::Builtin)
            && matches!(
                self.call.name.as_str(),
                "fs_write" | "fs_create" | "fs_apply_patches"
            )
        {
            self.invoke(&arguments, browser_plan.as_ref().or(computer_plan.as_ref()))
                .await
        } else if matches!(self.entry.backend, Backend::Builtin)
            && matches!(
                self.call.name.as_str(),
                "run_command" | "read_process" | "verify_command"
            )
        {
            let runtime = self
                .engine
                .runtime
                .as_ref()
                .expect("registered Runtime tool");
            let mut invocation =
                Box::pin(self.invoke(&arguments, browser_plan.as_ref().or(computer_plan.as_ref())));
            tokio::select! {
                biased;
                result = &mut invocation => result,
                _ = self.cancel.cancelled() => {
                    let cleanup = runtime.client.close_scope(self.execution_scope()).await;
                    let result = invocation.await;
                    match cleanup {
                        Ok(_) => result,
                        Err(error) => {
                            let mut failure = unknown("Runtime scope cleanup failed; tool outcome is UNKNOWN");
                            failure.details = Some(json!({"cleanupError":error,"invocationResult":result}));
                            Err(failure)
                        }
                    }
                }
            }
        } else {
            tokio::select! {
                biased;
                _ = self.cancel.cancelled() => Err(unknown("interrupted tool invocation; outcome is UNKNOWN")),
                result = self.invoke(&arguments, browser_plan.as_ref().or(computer_plan.as_ref())) => result,
            }
        };
        // Known capture failures still run ordinary failure hooks. A cancelled
        // capture never submitted the write and must not start effectful hooks.
        if result.as_ref().is_err_and(|error| {
            uncertain(error)
                || self.cancel.is_cancelled()
                    && error
                        .details
                        .as_ref()
                        .is_some_and(|details| details["reason"] == "FILE_BEFORE_CAPTURE_FAILED")
        }) {
            return result;
        }
        let (success, value) = match result {
            Ok(result) => result,
            Err(error) => (false, self.failure(&arguments, error)),
        };
        if matches!(self.entry.backend, Backend::Page(_))
            && (self.cancel.is_cancelled()
                || value["status"] == "unknown"
                || value["status"] == "noEffect")
        {
            return Ok((success, value));
        }
        let event = if success {
            HookEvent::PostToolUse
        } else {
            HookEvent::PostToolUseFailure
        };
        let hooks = self.hooks(event);
        if !hooks.is_empty() && !matches!(self.entry.backend, Backend::Page(_)) {
            // Commit the actual tool outcome before invoking potentially effectful hooks.
            // A hook failure must never turn a successful write into a retryable failure.
            let prepared = self
                .engine
                .prepare_tool_result(self.cell, self.item_id, &self.call.name, &value, None)
                .await
                .map_err(unknown)?;
            self.edit(|execution, content| {
                execution.outcome = if success {
                    ToolOutcome::Succeeded
                } else {
                    ToolOutcome::Failed
                };
                *content = Some(if prepared.value == value {
                    content_items(&value)
                } else {
                    vec![json!({"type":"inputText","text":prepared.value.to_string()})]
                });
                execution.result_snapshot = prepared.snapshot;
                execution.output_projection = Some(prepared.metrics);
            })
            .await?;
        }
        for hook in hooks {
            if self
                .hook(hook, &hook_arguments, Some(&value))
                .await
                .is_err()
            {
                *post_hook_failed = true;
                break;
            }
        }
        if matches!(self.entry.backend, Backend::Page(_)) {
            return match self
                .codex_post(&hook_arguments, success, value.clone())
                .await
            {
                Ok(result) => Ok(result),
                Err(_) => {
                    *post_hook_failed = true;
                    Ok((success, value))
                }
            };
        }
        self.codex_post(&hook_arguments, success, value).await
    }

    async fn discard_computer_plan(&self, arguments: &Value, plan: Option<&Value>) {
        let (Some(host), Some(plan)) = (&self.host, plan) else {
            return;
        };
        let cancel = CancellationToken::new();
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            host.prepare_computer(json!({"threadId":self.thread_id,"turnId":self.turn_id,
                "callId":self.call.id,"tool":"computer_v1","arguments":arguments,"hostGeneration":host.id(),
                "discardPreparedPlan":true,"computerApproval":{"plan":plan}}), cancel.clone()),
        ).await;
        cancel.cancel();
    }

    async fn codex_post(
        &self,
        args: &Value,
        success: bool,
        value: Value,
    ) -> rt::Result<(bool, Value)> {
        // Persist actual outcome before effectful post handlers; feedback cannot roll back
        // a write or make it replayable. The model projection may be replaced separately.
        if !matches!(self.entry.backend, Backend::Page(_)) {
            let prepared = self
                .engine
                .prepare_tool_result(self.cell, self.item_id, &self.call.name, &value, None)
                .await
                .map_err(unknown)?;
            self.edit(|execution, content| {
                execution.outcome = if success {
                    ToolOutcome::Succeeded
                } else {
                    ToolOutcome::Failed
                };
                execution.result_snapshot = prepared.snapshot;
                execution.output_projection = Some(prepared.metrics);
                *content = Some(content_items(&value));
            })
            .await?;
        }
        let (name, input) = crate::plugin_hooks::tool_input(&self.call.name, args);
        let effects=self.engine.plugin_hook_event(self.cell,areal_plugins::hooks::HookEvent::PostToolUse,
            json!({"tool_name":name,"tool_input":input,"tool_response":value,"tool_use_id":self.call.id,"__areal_caller_admitted":!matches!(self.entry.backend,Backend::Agent|Backend::Coordination|Backend::Core)}),self.cancel).await.map_err(unknown)?;
        if let Some(reason) = effects.block.or(effects.stop) {
            if matches!(self.entry.backend, Backend::Page(_)) {
                self.edit(|execution, _| {
                    execution.hooks.push(HookExecution {
                        name: "page-post-feedback".into(),
                        event: "PostToolUse".into(),
                        operation_id: self.operation.into(),
                        outcome: ToolOutcome::Succeeded,
                        result: Some(json!({"hookFeedback":reason})),
                    })
                })
                .await?;
                return Ok((success, value));
            }
            return Ok((
                success,
                json!({"hookFeedback":reason,"toolOutcomeRetained":true}),
            ));
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
                "expectedSha256=null creates a new file. Read the existing file with fs_read, then use its full-file sha256 for fs_write or fs_apply_patches. Do not retry creation or overwrite without a fresh hash."
            );
        }
        value
    }

    fn validate(&self, args: &Value) -> rt::Result<()> {
        if serde_json::to_vec(args).map_err(invalid)?.len() > registry::MAX_ARGUMENT_BYTES {
            return Err(invalid("tool arguments exceed 64 KiB"));
        }
        if matches!(self.entry.backend, Backend::Page(_)) {
            if serde_json::to_vec(args).map_err(invalid)?.len()
                > areal_protocol::plugin_runtime::PAGE_BYTES
            {
                return Err(invalid("page arguments exceed 32 KiB"));
            }
            if let Backend::Page(tool) = &self.entry.backend
                && tool.binding.kind == areal_protocol::plugin_runtime::PageToolKind::ApplyPatch
            {
                let patch: areal_protocol::plugin_runtime::PagePatch =
                    serde_json::from_value(args.clone()).map_err(invalid)?;
                if patch.patch.insert.encode_utf16().count()
                    > areal_protocol::plugin_runtime::PAGE_TEXT_UNITS
                    || patch.patch.insert.contains('\r')
                {
                    return Err(invalid(
                        "page replacement exceeds UTF-16 bound or contains CR",
                    ));
                }
            }
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
    fn execution_scope(&self) -> &str {
        self.granted_scope.as_deref().unwrap_or(self.scope)
    }

    async fn invoke(
        &self,
        args: &Value,
        approval_plan: Option<&Value>,
    ) -> rt::Result<(bool, Value)> {
        trajectory::record_json(
            &tracing::Span::current(),
            "areal.tool.call.effective_arguments",
            args,
        );
        let mut response = match &self.entry.backend {
            Backend::Page(tool) => return self.invoke_page(tool, args).await,
            Backend::Agent => {
                return super::agents::invoke(self.engine, self.cell, &self.call.name, args)
                    .await
                    .map_err(invalid);
            }
            Backend::Core => {
                return self
                    .engine
                    .core_tool(
                        self.cell,
                        self.turn_id,
                        &self.call.id,
                        &self.call.name,
                        args,
                        self.cancel,
                    )
                    .await
                    .map(|value| {
                        (
                            !self.call.name.starts_with("scheduled_task_")
                                || value.get("error").is_none(),
                            value,
                        )
                    })
                    .map_err(|error| {
                        if self.call.name == "development_service_start"
                            && matches!(error, Error::Storage(_))
                        {
                            return unknown(error);
                        }
                        let mut result = invalid(&error);
                        if let Error::Invalid(message) = &error
                            && let Some(details) = message.strip_prefix("GOAL_COMPLETION_PENDING: ")
                        {
                            result.details = serde_json::from_str(details).ok();
                        }
                        result
                    });
            }
            Backend::Coordination => {
                if self.call.name.starts_with("agent_") {
                    let mut arguments = args.clone();
                    if self.call.name == "agent_spawn" && arguments.get("intent").is_some() {
                        arguments["requestId"] = serde_json::json!(self.call.id);
                    }
                    return self
                        .engine
                        .coordinate_agent(
                            self.cell,
                            self.turn_id,
                            &self.call.name,
                            &arguments,
                            self.cancel,
                        )
                        .await
                        .map(|value| {
                            let success =
                                self.call.name != "agent_spawn" || value["status"] != "failed";
                            (success, value)
                        })
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
                let runtime = self
                    .engine
                    .runtime
                    .as_ref()
                    .expect("registered Runtime tool");
                let effective = args.clone();
                let state = self.cell.state.lock().await;
                let call = ToolCall {
                    id: self.call.id.clone(),
                    name: self.call.name.clone(),
                    arguments: effective.to_string(),
                };
                if call.name == "read_file"
                    || call.name == "search_files" && !state.thread.is_read_only_side()
                {
                    drop(state);
                    return navigation::invoke(
                        runtime,
                        self.execution_scope(),
                        self.operation,
                        &call.name,
                        &effective,
                    )
                    .await;
                }
                if call.name == "image_read" {
                    drop(state);
                    return images::read(self.engine, runtime, self.execution_scope(), &effective)
                        .await;
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
                if let Request::File(command) = &request {
                    file_before::prepare(self, &runtime.client, command).await?;
                }
                let mut verification_receipt = None;
                if let Request::Command(command) = &mut request {
                    if effective.get("stdinOpen").is_none() && call.name == "run_command" {
                        command.stdin_open = !self.engine.limits.command_stdin_closed;
                    }
                    // 在验证子进程之前解析系统 shim，避免进入沙箱后查询开发工具路径。
                    if command
                        .argv
                        .first()
                        .is_some_and(|arg| arg == "/usr/bin/python3")
                    {
                        command.argv[0] = super::navigation::python_executable()?;
                    }
                    let scope: rt::ScopeInfo = runtime
                        .client
                        .call("scope.get", json!({"scopeId":self.execution_scope()}))
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
                            super::navigation::python_executable()?,
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
                    // 通过协议环境传递 scratch，保留 argv[0] 的可信程序身份。
                    command
                        .environment
                        .insert("TMPDIR".into(), scratch.display().to_string());
                    command
                        .environment
                        .insert("PYTHONDONTWRITEBYTECODE".into(), "1".into());
                }
                let command_argv =
                    if matches!(self.call.name.as_str(), "run_command" | "read_process") {
                        match &request {
                            Request::Command(command) => Some(command.argv.clone()),
                            Request::ReadProcess(read) => {
                                let state = self.cell.state.lock().await;
                                state
                                    .active
                                    .as_ref()
                                    .and_then(|active| {
                                        active.handles.process_commands.get(&read.process_id)
                                    })
                                    .cloned()
                            }
                            _ => None,
                        }
                    } else {
                        None
                    };
                let file_write = matches!(&request, Request::File(command) if command.writes());
                if file_write {
                    file_before::check_cancel(self.cancel).map_err(file_before::not_sent)?;
                }
                let invocation = execute(
                    &runtime.client,
                    request,
                    self.execution_scope(),
                    self.operation,
                    &self.engine.extensions.policy,
                    command_argv.as_deref(),
                );
                let (success, mut result) = if file_write {
                    tokio::select! {
                        biased;
                        result = invocation => result?,
                        _ = self.cancel.cancelled() => {
                            return Err(unknown("interrupted file write; outcome is UNKNOWN"));
                        }
                    }
                } else {
                    invocation.await?
                };
                if let Some(process) = result["processId"].as_str().map(str::to_owned) {
                    let receipt = {
                        let mut state = self.cell.state.lock().await;
                        let handles = &mut state.active.as_mut().unwrap().handles;
                        handles
                            .process_scopes
                            .insert(process.clone(), self.execution_scope().to_owned());
                        if self.call.name == "run_command"
                            && let Some(argv) = &command_argv
                        {
                            handles
                                .process_commands
                                .insert(process.clone(), argv.clone());
                        }
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
                        verification::attach(
                            &runtime.client,
                            self.execution_scope(),
                            &receipt,
                            &mut result,
                        )
                        .await;
                    }
                }
                return Ok((success, result));
            }
            Backend::Command(tool) => {
                let value = self
                    .command(
                        &tool.argv,
                        tool.timeout_ms,
                        self.operation,
                        args,
                        areal_protocol::MAX_TOOL_RESULT_BYTES,
                    )
                    .await?;
                serde_json::from_value::<DynamicToolResponse>(value).map_err(unknown)?
            }
            Backend::Mcp(tool) => {
                self.engine
                    .check_plugin_mcp(tool)
                    .await
                    .map_err(|e| rt::Error::new(rt::ErrorCode::PermissionDenied, e.to_string()))?;
                let mut owner = self
                    .engine
                    .mcp_call_owner(self.cell, self.call)
                    .await
                    .map_err(invalid)?;
                owner.cancellation = self.cancel.child_token();
                let call_cancel = owner.cancellation.clone();
                let owner_token = owner.token.clone();
                let _owner_drop = owner.cancellation.clone().drop_guard();
                let context = self.engine.mcp_request_context(
                    owner.clone(),
                    tool.server_name().into(),
                    tool.generation(),
                    Some(tool.as_ref().clone()),
                );
                let key = (tool.server_name().to_owned(), tool.generation());
                {
                    let mut calls = self.engine.desktop.mcp_apps.calls.lock().await;
                    if calls.contains_key(&key) {
                        return Err(rt::Error::new(
                            rt::ErrorCode::PermissionDenied,
                            "MCP server has an active caller; refusing ambiguous form ownership",
                        ));
                    }
                    calls.insert(key.clone(), owner);
                }
                let meta = self
                    .cell
                    .state
                    .lock()
                    .await
                    .active
                    .as_ref()
                    .and_then(|a| a.tool_meta.clone());
                let cwd = self.cell.state.lock().await.thread.cwd.clone();
                let source = self
                    .engine
                    .mcp_result_source(tool, self.thread_id, &cwd)
                    .await;
                let raw = tool
                    .call_raw_owned(args.clone(), meta, call_cancel, Some(&context))
                    .await;
                {
                    let mut calls = self.engine.desktop.mcp_apps.calls.lock().await;
                    if calls.get(&key).is_some_and(|o| o.token == owner_token) {
                        calls.remove(&key);
                    }
                }
                let raw = raw.map_err(|e| {
                    if e.is::<areal_mcp::AuthenticationFailed>() {
                        rt::Error::new(
                            rt::ErrorCode::PermissionDenied,
                            "MCP authentication required",
                        )
                    } else {
                        unknown(e)
                    }
                })?;
                let mut response = areal_mcp::project_result(&raw).map_err(unknown)?;
                self.engine
                    .materialize_tool_media(self.cell, &mut response.content_items)
                    .await
                    .map_err(unknown)?;
                if let Some(limit) = self.engine.mcp_output_limit(tool).await {
                    let text = serde_json::to_string(&response).map_err(unknown)?;
                    if text.len() > limit {
                        let text = text
                            .chars()
                            .scan(0usize, |used, c| {
                                *used += c.len_utf8();
                                Some((*used, c))
                            })
                            .take_while(|(used, _)| *used <= limit)
                            .map(|(_, c)| c)
                            .collect::<String>();
                        response.content_items =
                            vec![areal_protocol::ToolContent::InputText { text }];
                        response.structured_content = None;
                    }
                }
                let mut value = serde_json::to_value(&response).map_err(unknown)?;
                value["mcpResult"] = serde_json::to_value(&raw).map_err(unknown)?;
                value["mcpServer"] = json!({"serverId":tool.server_name(),"generation":tool.generation(),"toolMetadata":tool.metadata(),"source":source});
                if serde_json::to_vec(&value).map_err(unknown)?.len()
                    > areal_protocol::MAX_TOOL_RESULT_BYTES
                {
                    return Err(unknown(
                        "MCP result exceeds durable receive budget; inspect before retry",
                    ));
                }
                if response.success {
                    self.entry
                        .validate_output(raw.structured_content.as_ref().unwrap_or(&Value::Null))
                        .map_err(unknown)?;
                }
                return Ok((response.success, value));
            }
            Backend::Plugin(tool) => self.plugin(tool, args).await?,
            Backend::Client => {
                let host = self
                    .host
                    .as_ref()
                    .ok_or_else(|| unknown("dynamic tool client is unavailable"))?;
                let mut request = json!({"threadId":self.thread_id,"turnId":self.turn_id,"callId":self.call.id,"tool":self.call.name,"arguments":args,"hostGeneration":host.id()});
                if matches!(self.call.name.as_str(), "js" | "js_reset")
                    && self
                        .cell
                        .state
                        .lock()
                        .await
                        .thread
                        .desktop
                        .as_ref()
                        .is_some_and(|data| data.configuration.options.external_cua)
                {
                    let mut state = self.cell.state.lock().await;
                    if state.thread.parent_thread_id.is_some() || state.thread.is_read_only_side() {
                        return Err(rt::Error::new(
                            rt::ErrorCode::PermissionDenied,
                            "External CUA is available only in a new top-level desktop chat",
                        ));
                    }
                    request["definition"] =
                        serde_json::to_value(&self.entry.definition).map_err(unknown)?;
                    request["clientInstructions"] = json!(
                        state
                            .thread
                            .desktop
                            .as_ref()
                            .map(|data| &data.configuration.options.append_instructions)
                    );
                    state.active.as_mut().unwrap().cua_used = true;
                }
                if let Some(plan) = approval_plan {
                    let field = if self.call.name == "computer_v1" {
                        "computerApproval"
                    } else {
                        "browserApproval"
                    };
                    request[field] = json!({"plan":plan});
                }
                host.call(request, self.cancel.clone())
                    .await
                    .map_err(unknown)?
            }
        };
        let raw_mcp_result = response.raw_mcp_result.take();
        if let Some(raw) = &raw_mcp_result {
            let parsed = serde_json::from_value(raw.clone()).map_err(unknown)?;
            response = areal_mcp::project_result(&parsed).map_err(unknown)?;
        }
        if matches!(self.call.name.as_str(), "browser_v1" | "computer_v1")
            && response.structured_content.as_ref().is_some_and(|content| {
                content["code"] == "outcome_unknown" && content["dispatch"] == "unknown"
            })
        {
            self.cell.browser_permits.lock().await.clear();
            let mut error =
                unknown("desktop tool outcome is UNKNOWN; inspect before another action");
            error.details = response.structured_content;
            return Err(error);
        }
        if self.call.name == "browser_v1" && approval_plan.is_some() && response.success {
            let mut contents: Vec<Value> = response.structured_content.iter().cloned().collect();
            for content in &response.content_items {
                if let areal_protocol::ToolContent::InputText { text } = content
                    && let Ok(value) = serde_json::from_str::<Value>(text)
                {
                    contents.push(value);
                }
            }
            for content in contents {
                self.engine
                    .remember_browser_permit(self.cell, &content["controlPermit"])
                    .await;
                if let Some(permits) = content["controlPermits"].as_array() {
                    for permit in permits {
                        self.engine.remember_browser_permit(self.cell, permit).await;
                    }
                }
            }
        }
        self.engine
            .materialize_tool_media(self.cell, &mut response.content_items)
            .await
            .map_err(unknown)?;
        let mut value = serde_json::to_value(&response).map_err(unknown)?;
        if let Some(raw) = &raw_mcp_result {
            value["mcpResult"] = raw.clone();
        }
        let limit = if raw_mcp_result.is_some()
            || response
                .content_items
                .iter()
                .all(|item| matches!(item, areal_protocol::ToolContent::InputText { .. }))
        {
            areal_protocol::MAX_TOOL_RESULT_BYTES
        } else {
            MAX_RESULT
        };
        if serde_json::to_vec(&value).map_err(unknown)?.len() > limit
            || serde_json::to_vec(&content_items(&value))
                .map_err(unknown)?
                .len()
                > limit
        {
            return Err(unknown(
                "custom tool result exceeds its receive limit (8 MiB text/structured, 16 KiB mixed media references); inspect before retrying",
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
        let agent_control = matches!(self.entry.backend, Backend::Agent);
        let exclusive = self
            .cell
            .state
            .lock()
            .await
            .active
            .as_ref()
            .is_some_and(|active| active.workspace_exclusive);
        // Agent 主体仅协调子任务；hook 可能写源码，必须单独参与工作区互斥。
        let _workspace = if agent_control && !exclusive {
            Some(tokio::select! {biased;
                _ = self.cancel.cancelled() => return Err(rt::Error::new(rt::ErrorCode::ScopeClosed, "cancelled before hook workspace admission")),
                guard = self.engine.workspace_gate.clone().read_owned() => guard,
            })
        } else {
            None
        };
        let _permit = if agent_control {
            Some(tokio::select! {biased;
                _ = self.cancel.cancelled() => return Err(rt::Error::new(rt::ErrorCode::ScopeClosed, "cancelled before hook execution admission")),
                permit = self.engine.tool_permits.acquire() => permit.map_err(unknown)?,
            })
        } else {
            None
        };
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
            result = self.command(&hook.argv, hook.timeout_ms, &operation, &payload, MAX_RESULT) => result,
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
            ) || execution.page.as_ref().is_some_and(|p| p.is_terminal())
            {
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
        output_limit: usize,
    ) -> rt::Result<Value> {
        let client = &self
            .engine
            .runtime
            .as_ref()
            .expect("command requires Runtime")
            .client;
        let scope: rt::ScopeInfo = client
            .call("scope.get", json!({"scopeId":self.scope}))
            .await?;
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
                    wall_time_ms: Some(timeout_ms.min(scope.limits.wall_time_ms)),
                    output_bytes: Some(
                        ((output_limit + MAX_RESULT) as u64).min(scope.limits.output_bytes),
                    ),
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
            if page.gap
                || page.truncated
                || stdout.len() > output_limit
                || stderr.len() > MAX_RESULT
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
