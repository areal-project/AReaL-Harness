use super::*;
use crate::tools::Backend;

impl Engine {
    pub async fn interactions(&self, thread_id: &str) -> Result<Value> {
        let data = desktop(&self.read(thread_id, false).await?);
        Ok(json!({"revision":data.interaction_revision,"data":data.interactions}))
    }
    pub async fn respond(self: &Arc<Self>, request: Respond) -> Result<Value> {
        self.mutate(move |engine| async move {
            let cell = engine.cell(&request.thread_id).await?;
            let mut state = cell.state.lock().await;
            if state
                .active
                .as_ref()
                .is_none_or(|a| a.id != request.turn_id || a.cancel.is_cancelled())
            {
                return Err(Error::Conflict);
            }
            let mut candidate = state.thread.clone();
            let data = candidate.desktop.get_or_insert_with(Default::default);
            let interaction = data
                .interactions
                .iter_mut()
                .find(|r| r.request_id == request.request_id && r.turn_id == request.turn_id)
                .ok_or(Error::NotFound)?;
            if interaction.status != "pending" || now() >= interaction.expires_at {
                return Err(Error::Conflict);
            }
            let response = if interaction.kind == "question" {
                if request.decision.is_some() || request.arguments_digest.is_some() {
                    return Err(invalid("question requires answers only"));
                }
                let answers = request.answers.ok_or_else(|| invalid("answers required"))?;
                if answers.len() != interaction.questions.len()
                    || interaction.questions.iter().any(|q| {
                        answers.get(&q.id).is_none_or(|answer| {
                            answer.len() > 4096
                                || (!q.allow_free_text && !q.options.contains(answer))
                        })
                    })
                {
                    return Err(invalid("answers do not match the questions"));
                }
                json!({"answers":answers})
            } else {
                if request.answers.is_some()
                    || request.arguments_digest != interaction.arguments_digest
                    || !matches!(
                        request.decision.as_deref(),
                        Some("allowOnce" | "allowSession" | "allowProject" | "deny")
                    )
                {
                    return Err(invalid(
                        "approval requires the current digest and a supported decision",
                    ));
                }
                json!({"decision":request.decision,"argumentsDigest":request.arguments_digest})
            };
            interaction.status = "answered".into();
            interaction.response = Some(response.clone());
            let resolved = interaction.clone();
            if matches!(
                request.decision.as_deref(),
                Some("allowSession" | "allowProject")
            ) {
                if resolved
                    .effective_permissions
                    .as_ref()
                    .is_none_or(|p| p["rememberAllowed"] != true)
                {
                    return Err(invalid("this approval cannot be remembered"));
                }
                let grant: PermissionGrant = serde_json::from_value(
                    resolved.effective_permissions.as_ref().unwrap()["grant"].clone(),
                )
                .map_err(invalid)?;
                if request.decision.as_deref() == Some("allowProject") {
                    let mut project = engine.permissions.project.lock().await;
                    let mut grants = if project.workspace == engine.default_cwd() {
                        project.grants.clone()
                    } else {
                        Vec::new()
                    };
                    crate::permissions::remember(&mut grants, grant)?;
                    let saved = crate::permissions::ProjectGrants {
                        workspace: engine.default_cwd(),
                        grants,
                    };
                    engine
                        .store
                        .save_metadata("permissions", &saved)
                        .await
                        .map_err(|e| Error::Storage(e.to_string()))?;
                    *project = saved;
                } else {
                    crate::permissions::remember(&mut data.permission_grants, grant)?;
                }
            }
            data.interaction_revision += 1;
            let revision = data.interaction_revision;
            engine.persist(&candidate).await?;
            state.thread = candidate;
            cell.interaction_changed.send_replace(revision);
            cell.emit(
                "areal/interaction/resolved",
                json!({"revision":revision,"interaction":resolved}),
            );
            Ok(response)
        })
        .await
    }
    pub(crate) async fn await_interaction(
        &self,
        cell: &Cell,
        call_id: &str,
        questions: Vec<Question>,
        approval: Option<(&str, Value)>,
        cancel: &CancellationToken,
        timeout_seconds: u64,
    ) -> Result<Value> {
        if timeout_seconds == 0 || timeout_seconds > 3600 {
            return Err(invalid(
                "interaction timeout must be 1..3600 seconds and remains bounded by the Turn deadline",
            ));
        }
        let mut ids = HashSet::new();
        if approval.is_none()
            && (questions.is_empty()
                || questions.len() > 8
                || questions.iter().any(|q| {
                    !valid_id(&q.id)
                        || !ids.insert(&q.id)
                        || q.title.is_empty()
                        || q.title.len() > 4096
                        || q.options.len() > 8
                        || q.options.iter().any(|s| s.is_empty() || s.len() > 1024)
                        || (q.options.is_empty() && !q.allow_free_text)
                }))
        {
            return Err(invalid("invalid questions"));
        }
        let is_approval = approval.is_some();
        let mut changed = cell.interaction_changed.subscribe();
        let request_id = id();
        {
            let mut state = cell.state.lock().await;
            let active = state.active.as_ref().ok_or(Error::Conflict)?;
            if active.cancel.is_cancelled() {
                return Err(Error::Closed);
            }
            let mut permissions = json!({"readOnly":cell.research || state.thread.turns.last().and_then(|t|t.configuration.as_ref()).is_some_and(|c|c.read_only),"runtime":self.runtime_capabilities()});
            let (generation, can_remember) = if let Some((tool, args)) = &approval {
                self.permission_identity(cell, tool, args).await
            } else {
                (None, false)
            };
            if let Some((tool, args)) = &approval {
                let config = self.permission_config();
                let turn = state
                    .thread
                    .turns
                    .last()
                    .and_then(|t| t.configuration.as_ref());
                let forced = crate::permissions::forced(turn, tool, args);
                permissions["rememberAllowed"] = json!(
                    can_remember
                        && !forced
                        && !config
                            .ask
                            .iter()
                            .any(|p| crate::permissions::matches_tool(p, tool))
                );
                permissions["grant"] = json!(
                    self.permission_grant(
                        tool,
                        args,
                        generation.as_deref(),
                        &crate::permissions::restrictions(turn)
                    )
                    .map_err(invalid)?
                );
            }
            let interaction = Interaction {
                request_id:request_id.clone(),thread_id:state.thread.id.clone(),turn_id:active.id.clone(),call_id:call_id.into(),
                kind:if approval.is_some() {"approval"} else {"question"}.into(),status:"pending".into(),expires_at:now()+timeout_seconds as i64,
                questions,tool:approval.as_ref().map(|(tool,_)| tool.to_string()),
                arguments_digest:approval.as_ref().map(|(tool,args)| digest(&json!({"threadId":state.thread.id,"turnId":active.id,"callId":call_id,"tool":tool,"arguments":args,"generation":generation,"permissions":permissions}))).transpose()?,
                generation,effective_permissions:Some(permissions),
                effective_arguments:approval.map(|(_,args)| args),response:None,
            };
            let mut candidate = state.thread.clone();
            let data = candidate.desktop.get_or_insert_with(Default::default);
            if data.interactions.len() >= 256 {
                return Err(Error::Exhausted(
                    "interaction history capacity reached".into(),
                ));
            }
            data.interactions.push(interaction.clone());
            data.interaction_revision += 1;
            let revision = data.interaction_revision;
            self.persist(&candidate).await?;
            state.thread = candidate;
            cell.interaction_changed.send_replace(revision);
            cell.emit(
                "areal/interaction/requested",
                json!({"revision":revision,"interaction":interaction}),
            );
        }
        let mut interaction_trace = self
            .trace_begin(
                cell,
                if is_approval {
                    "approvalWait"
                } else {
                    "questionWait"
                },
                "等待用户响应",
                Some(call_id),
                None,
            )
            .await
            .map_err(invalid)?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_seconds);
        loop {
            {
                let state = cell.state.lock().await;
                let interaction = state
                    .thread
                    .desktop
                    .as_ref()
                    .unwrap()
                    .interactions
                    .iter()
                    .find(|r| r.request_id == request_id)
                    .unwrap();
                if interaction.status == "answered" && !cancel.is_cancelled() {
                    let response = interaction.response.clone().unwrap();
                    drop(state);
                    self.trace_finish(cell, &mut interaction_trace, None)
                        .await
                        .map_err(invalid)?;
                    return Ok(response);
                }
            }
            let status = tokio::select! { biased;
                _=cancel.cancelled()=>Some("cancelled"),
                _=tokio::time::sleep_until(deadline)=>Some("expired"),
                result=changed.changed()=> { result.map_err(|_| Error::Closed)?; None },
            };
            if let Some(status) = status {
                let mut state = cell.state.lock().await;
                let mut candidate = state.thread.clone();
                let data = candidate.desktop.as_mut().unwrap();
                let interaction = data
                    .interactions
                    .iter_mut()
                    .find(|r| r.request_id == request_id)
                    .unwrap();
                // Stop 优先于尚未消费的答案，防止已取消工具继续提交副作用。
                interaction.status = status.into();
                let resolved = interaction.clone();
                data.interaction_revision += 1;
                let revision = data.interaction_revision;
                let block_schedule = status == "expired"
                    && resolved.kind == "approval"
                    && if let Some(goal) = &candidate.goals.goal {
                        self.is_desktop_schedule_goal(&goal.id).await?
                    } else {
                        false
                    };
                if block_schedule && let Some(goal) = candidate.goals.goal.as_mut() {
                    goal.status = areal_protocol::goals::GoalStatus::Blocked;
                    goal.reason = Some("approvalExpired".into());
                    goal.settling = state.active.is_some();
                    candidate.goals.revision += 1;
                    candidate.goals.event_sequence += 1;
                }
                self.persist(&candidate).await?;
                state.thread = candidate;
                cell.interaction_changed.send_replace(revision);
                cell.emit(
                    "areal/interaction/resolved",
                    json!({"revision":revision,"interaction":resolved}),
                );
                if block_schedule {
                    if let Some(active) = &state.active {
                        active.cancel.cancel();
                    }
                    self.wake_tasks();
                }
                drop(state);
                self.trace_finish(cell, &mut interaction_trace, Some(status))
                    .await
                    .map_err(invalid)?;
                return Err(invalid(format!("interaction {status}")));
            }
        }
    }
    pub(crate) async fn approval(
        self: &Arc<Self>,
        cell: &Arc<Cell>,
        call_id: &str,
        tool: &str,
        arguments: &Value,
        cancel: &CancellationToken,
    ) -> areal_runtime_protocol::Result<()> {
        use areal_runtime_protocol::{Error as RuntimeError, ErrorCode};
        let mut effective = arguments.clone();
        let backend = {
            cell.bindings
                .read()
                .await
                .registry
                .get(tool)
                .ok()
                .map(|t| t.backend.clone())
        };
        if matches!(backend, Some(Backend::Builtin))
            && let Some(runtime) = &self.runtime
        {
            for field in ["path", "cwd"] {
                if let Some(path) = effective[field].as_str() {
                    effective[field] =
                        json!(crate::tools::resource_uri(path, runtime).map_err(|e| {
                            RuntimeError::new(ErrorCode::InvalidArgument, e.to_string())
                        })?);
                }
            }
        }
        let arguments = &effective;
        let action = self.permission_action(cell, tool, arguments).await;
        if action == "deny" {
            return Err(RuntimeError::new(
                ErrorCode::PermissionDenied,
                "tool denied by permissions.deny",
            ));
        }
        let plugin_prompt = match &backend {
            Some(Backend::Mcp(tool)) => match tool.approval_mode() {
                Some(areal_mcp::ApprovalMode::Prompt | areal_mcp::ApprovalMode::Approve) => true,
                Some(areal_mcp::ApprovalMode::Writes) => !tool
                    .metadata()
                    .annotations
                    .as_ref()
                    .and_then(|a| a.read_only_hint)
                    .unwrap_or(false),
                _ => false,
            },
            _ => false,
        };
        let (forced, restrictions, preset) = {
            let state = cell.state.lock().await;
            let config = state
                .thread
                .turns
                .last()
                .and_then(|t| t.configuration.as_ref());
            (
                crate::permissions::forced(config, tool, arguments),
                crate::permissions::restrictions(config),
                config.and_then(|c| c.options.permission_preset),
            )
        };
        let (generation, can_remember) = self.permission_identity(cell, tool, arguments).await;
        let grant = self
            .permission_grant(tool, arguments, generation.as_deref(), &restrictions)
            .map_err(|e| RuntimeError::new(ErrorCode::InvalidArgument, e.to_string()))?;
        let session_allowed = cell
            .state
            .lock()
            .await
            .thread
            .desktop
            .as_ref()
            .is_some_and(|d| d.permission_grants.iter().any(|g| g.key == grant.key));
        let project_allowed = {
            let project = self.permissions.project.lock().await;
            project.workspace == self.default_cwd()
                && project.grants.iter().any(|g| g.key == grant.key)
        };
        let explicit_ask = self
            .permission_config()
            .ask
            .iter()
            .any(|p| crate::permissions::matches_tool(p, tool));
        let browser_action = tool == "browser_v1";
        let additional = arguments.get("permissionRequest").is_some();
        let ordinary_allowed = if let Some(preset) = preset {
            if preset == PermissionPreset::FullAccess {
                true
            } else if browser_action {
                self.browser_permitted(cell, arguments).await
            } else {
                matches!(backend, Some(Backend::Builtin)) && !additional
            }
        } else {
            false
        };
        let needs_approval = forced
            || plugin_prompt
            || explicit_ask
            || (!ordinary_allowed
                && (additional || action == "ask" || (browser_action && preset.is_none()))
                && (additional || !can_remember || !(session_allowed || project_allowed)));
        if needs_approval {
            if !tool.starts_with("hook:") {
                let (name, input) = crate::plugin_hooks::tool_input(tool, arguments);
                let effects=self.plugin_hook_event(cell,areal_plugins::hooks::HookEvent::PermissionRequest,
                    json!({"tool_name":name,"tool_input":input,"__areal_caller_admitted":backend.as_ref().is_some_and(|b|!matches!(b,Backend::Agent|Backend::Coordination|Backend::Core))}),cancel).await.map_err(|e|RuntimeError::new(ErrorCode::Unavailable,e.to_string()))?;
                match effects.permission {
                    Some(crate::plugin_hooks::output::PermissionDecision::Deny { reason }) => {
                        return Err(RuntimeError::new(ErrorCode::PermissionDenied, reason));
                    }
                    Some(crate::plugin_hooks::output::PermissionDecision::Allow)
                        if preset.is_none() && !forced && !explicit_ask =>
                    {
                        return Ok(());
                    }
                    _ => {}
                }
            }
            let reviewed = if preset == Some(PermissionPreset::AutoReview)
                && !forced
                && !explicit_ask
                && !plugin_prompt
            {
                match self
                    .review_permission(cell, call_id, tool, arguments, cancel)
                    .await?
                {
                    crate::permissions::ReviewDecision::Allow => true,
                    crate::permissions::ReviewDecision::Deny => {
                        let state = cell.state.lock().await;
                        let reason = state
                            .thread
                            .turns
                            .last()
                            .and_then(|turn| {
                                turn.items.iter().find_map(|item| match item {
                                    Item::DynamicToolCall {
                                        call_id: id,
                                        execution,
                                        ..
                                    } if id == call_id => execution
                                        .permission_review
                                        .as_ref()
                                        .and_then(|review| review["reason"].as_str()),
                                    _ => None,
                                })
                            })
                            .unwrap_or("independent permission review denied this operation");
                        return Err(RuntimeError::new(ErrorCode::PermissionDenied, reason));
                    }
                    crate::permissions::ReviewDecision::Ask => false,
                }
            } else {
                false
            };
            if !reviewed {
                if self.interaction_mode(cell).await
                    != areal_protocol::tasks::InteractionMode::Interactive
                {
                    return Err(RuntimeError::new(
                        ErrorCode::PermissionDenied,
                        "NON_INTERACTIVE_APPROVAL_REQUIRED: execution denied; no synchronous approval can be awaited",
                    ));
                }
                let result = self
                    .await_interaction(
                        cell,
                        call_id,
                        Vec::new(),
                        Some((tool, arguments.clone())),
                        cancel,
                        300,
                    )
                    .await
                    .map_err(|e| {
                        RuntimeError::new(
                            if cancel.is_cancelled() {
                                ErrorCode::ScopeClosed
                            } else {
                                ErrorCode::PermissionDenied
                            },
                            e.to_string(),
                        )
                    })?;
                if !matches!(
                    result["decision"].as_str(),
                    Some("allowOnce" | "allowSession" | "allowProject")
                ) {
                    return Err(RuntimeError::new(
                        ErrorCode::PermissionDenied,
                        "tool approval denied",
                    ));
                }
            }
        }
        if cancel.is_cancelled() {
            return Err(RuntimeError::new(
                ErrorCode::ScopeClosed,
                "cancelled before execution",
            ));
        }
        Ok(())
    }
}
