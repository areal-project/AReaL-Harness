use super::*;

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
                    || !matches!(request.decision.as_deref(), Some("allowOnce" | "deny"))
                {
                    return Err(invalid(
                        "approval requires the current digest and allowOnce or deny",
                    ));
                }
                json!({"decision":request.decision,"argumentsDigest":request.arguments_digest})
            };
            interaction.status = "answered".into();
            interaction.response = Some(response.clone());
            let resolved = interaction.clone();
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
        let mut changed = cell.interaction_changed.subscribe();
        let request_id = id();
        {
            let mut state = cell.state.lock().await;
            let active = state.active.as_ref().ok_or(Error::Conflict)?;
            if active.cancel.is_cancelled() {
                return Err(Error::Closed);
            }
            let permissions = json!({"readOnly":state.thread.turns.last().and_then(|t|t.configuration.as_ref()).is_some_and(|c|c.read_only),"runtime":self.runtime_capabilities()});
            let generation = if let Some((tool, args)) = &approval {
                let name = args.get("tool").and_then(Value::as_str).unwrap_or(tool);
                let bindings = cell.bindings.read().await;
                match bindings.registry.get(name).ok().map(|t| t.backend.clone()) {
                    Some(crate::tools::registry::Backend::Plugin(p)) => {
                        Some(p.host.generation.clone())
                    }
                    _ => args
                        .get("generation")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                }
            } else {
                None
            };
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
                    return Ok(interaction.response.clone().unwrap());
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
                self.persist(&candidate).await?;
                state.thread = candidate;
                cell.interaction_changed.send_replace(revision);
                cell.emit(
                    "areal/interaction/resolved",
                    json!({"revision":revision,"interaction":resolved}),
                );
                return Err(invalid(format!("interaction {status}")));
            }
        }
    }
    pub(crate) async fn approval(
        &self,
        cell: &Cell,
        call_id: &str,
        tool: &str,
        arguments: &Value,
        cancel: &CancellationToken,
    ) -> areal_runtime_protocol::Result<()> {
        use areal_runtime_protocol::{Error as RuntimeError, ErrorCode};
        let needed = {
            let state = cell.state.lock().await;
            let config = state
                .thread
                .turns
                .last()
                .and_then(|t| t.configuration.as_ref());
            let parent_tool = arguments.get("tool").and_then(Value::as_str);
            let matches = |name: &str| name == "*" || name == tool || parent_tool == Some(name);
            config.is_some_and(|c| {
                c.profile
                    .as_ref()
                    .is_some_and(|p| p.approval_tools.iter().any(|n| matches(n)))
                    || (c.options.approval_tools.iter().any(|n| matches(n))
                        && !c.options.preapproved_tools.iter().any(|n| matches(n)))
            })
        };
        if needed {
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
            if result["decision"] != "allowOnce" {
                return Err(RuntimeError::new(
                    ErrorCode::PermissionDenied,
                    "tool approval denied",
                ));
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
