use super::*;

impl Engine {
    pub async fn create_configured(
        self: &Arc<Self>,
        identity: String,
        request: ThreadStart,
        host: Arc<dyn crate::tools::DynamicToolHost>,
    ) -> Result<Thread> {
        self.mutate(move |engine| async move {
            let _serial = engine.desktop.creation.lock().await;
            let hash = digest(&request)?;
            let cells: Vec<_> = engine.threads.read().await.values().cloned().collect();
            for cell in cells {
                let state = cell.state.lock().await;
                if let Some(data) = &state.thread.desktop
                    && data.receipts.iter().any(|r| {
                        r.identity == identity
                            && r.request_id == request.request_id
                            && r.method == "areal/thread/start"
                    })
                    && receipt(
                        data,
                        &identity,
                        &request.request_id,
                        "areal/thread/start",
                        &hash,
                    )?
                    .is_some()
                {
                    return Ok(state.thread.clone());
                }
            }
            let mut data = DesktopState {
                configuration: engine.resolve_config(
                    request
                        .agent_profile
                        .or_else(|| engine.desktop.default_profile.read().unwrap().clone()),
                    request.model,
                    request.parameters,
                    1,
                )?,
                ..Default::default()
            };
            receipt(
                &data,
                &identity,
                &request.request_id,
                "areal/thread/start",
                &hash,
            )?;
            remember(
                &mut data,
                &identity,
                &request.request_id,
                "areal/thread/start",
                hash,
                Value::Null,
            );
            engine
                .create_inner(
                    request.cwd.unwrap_or_else(|| engine.default_cwd()),
                    None,
                    None,
                    request.dynamic_tools,
                    Some(host),
                    Some(data),
                )
                .await
                .map(|(thread, _)| thread)
        })
        .await
    }
    pub async fn configure_thread(
        self: &Arc<Self>,
        request: ConfigureThread,
    ) -> Result<EffectiveConfig> {
        self.mutate(move |engine| async move {
            let cell = engine.cell(&request.thread_id).await?;
            engine.refresh_managed_tools(&cell).await.map_err(invalid)?;
            let mut state = cell.state.lock().await;
            if state.active.is_some() || state.compacting {
                return Err(Error::Conflict);
            }
            let previous = desktop(&state.thread).configuration;
            if previous.revision != request.expected_revision {
                return Err(Error::Conflict);
            }
            if request.reset_model && request.model.is_some() {
                return Err(invalid("model and resetModel cannot be used together"));
            }
            let mut configuration = engine.resolve_config(
                request.agent_profile.or_else(|| {
                    previous.profile.map(|p| VersionRef {
                        id: p.id,
                        revision: p.revision,
                    })
                }),
                if request.reset_model {
                    None
                } else {
                    request.model.or(previous.model)
                },
                request.parameters.unwrap_or(previous.parameters),
                previous.revision + 1,
            )?;
            configuration.options = request.options.unwrap_or(previous.options);
            configuration.selected_skills = previous.selected_skills;
            let o = &configuration.options;
            configuration.read_only |= o.read_only;
            configuration.instructions = previous.instructions;
            if o.system_prompt.as_ref().is_some_and(|s| s.len() > 32768)
                || o.append_instructions.len() > 32768
                || o.max_model_rounds.is_some_and(|n| n == 0 || n > 1024)
                || o.approval_tools.len() > 128
                || o.preapproved_tools.len() > 128
            {
                return Err(invalid("invalid client option budget"));
            }
            if let Some(names) = &o.tool_allowlist {
                let registry = cell.bindings.read().await;
                if names.len() > 128 {
                    return Err(invalid("tool allowlist exceeds budget"));
                }
                for name in names {
                    registry.registry.get(name).map_err(invalid)?;
                    if configuration
                        .tool_allowlist
                        .as_ref()
                        .is_some_and(|allowed| !allowed.contains(name))
                    {
                        return Err(invalid("client tools exceed profile boundary"));
                    }
                }
                configuration.tool_allowlist = Some(names.clone());
            }
            let mut candidate = state.thread.clone();
            candidate
                .desktop
                .get_or_insert_with(Default::default)
                .configuration = configuration.clone();
            engine.persist(&candidate).await?;
            state.thread = candidate;
            cell.emit(
                "areal/thread/configured",
                json!({"threadId":request.thread_id,"configuration":configuration}),
            );
            Ok(configuration)
        })
        .await
    }
    pub async fn plan(&self, thread_id: &str) -> Result<Plan> {
        Ok(desktop(&self.read(thread_id, false).await?).plan)
    }
    pub async fn update_plan(self: &Arc<Self>, request: PlanUpdate) -> Result<Plan> {
        self.mutate(move |engine| async move { engine.update_plan_inner(request).await })
            .await
    }
    pub(super) async fn update_plan_inner(&self, request: PlanUpdate) -> Result<Plan> {
        let mut ids = HashSet::new();
        if request.steps.len() > 64
            || request.steps.iter().any(|s| {
                !valid_id(&s.id)
                    || !ids.insert(&s.id)
                    || s.text.is_empty()
                    || s.text.len() > 1024
                    || !matches!(
                        s.status.as_str(),
                        "pending" | "inProgress" | "completed" | "cancelled"
                    )
            })
        {
            return Err(invalid(
                "invalid plan steps (maximum 64 steps, 1024 bytes each, unique IDs)",
            ));
        }
        let cell = self.cell(&request.thread_id).await?;
        let mut state = cell.state.lock().await;
        let mut candidate = state.thread.clone();
        let data = candidate.desktop.get_or_insert_with(Default::default);
        if data.plan.revision != request.expected_revision {
            return Err(Error::Conflict);
        }
        data.plan = Plan {
            revision: data.plan.revision + 1,
            steps: request.steps,
        };
        let plan = data.plan.clone();
        self.persist(&candidate).await?;
        state.thread = candidate;
        cell.emit(
            "areal/plan/updated",
            json!({"threadId":request.thread_id,"plan":plan}),
        );
        Ok(plan)
    }
    pub(crate) async fn visible_tools(
        &self,
        cell: &Cell,
        config: &EffectiveConfig,
        desktop_enabled: bool,
    ) -> Vec<Value> {
        let bindings = cell.bindings.read().await;
        let mut definitions = bindings.registry.definitions();
        let core_names: Vec<_> = crate::desktop::definitions()
            .into_iter()
            .map(|d| d.name)
            .collect();
        definitions.retain(|d| {
            let name = d["function"]["name"].as_str().unwrap_or("");
            (!name.starts_with("workgroup_") || self.workgroups.get().is_some())
                && (!matches!(name, "agent_spawn" | "agent_spawn_configured")
                    || (cell.depth < self.limits.max_agent_depth
                        && self.limits.max_children_per_turn > 0))
                && (name != "agent_report" || cell.depth > 0)
                && (desktop_enabled || !core_names.iter().any(|n| n == name))
                && config
                    .tool_allowlist
                    .as_ref()
                    .is_none_or(|a| a.iter().any(|n| n == name))
                && (!config.read_only
                    || bindings.registry.get(name).is_ok_and(|t| {
                        crate::agents::read_only_tool(name, &t.backend)
                            || matches!(
                                t.backend,
                                crate::tools::Backend::Builtin
                                    | crate::tools::Backend::Core
                                    | crate::tools::Backend::Command(_)
                            )
                    }))
        });
        if let Some(service) = self.workgroups.get() {
            for definition in &mut definitions {
                if definition["function"]["name"] == "workgroup_start" {
                    definition["function"]["parameters"]["properties"]["workers"]["maximum"] =
                        json!(service.policy().workers);
                }
            }
        }
        definitions
    }
    pub async fn inspect(&self, thread_id: &str) -> Result<Value> {
        let cell = self.cell(thread_id).await?;
        let state = cell.state.lock().await;
        let config = state
            .thread
            .turns
            .last()
            .filter(|_| state.active.is_some())
            .and_then(|t| t.configuration.clone())
            .unwrap_or_else(|| desktop(&state.thread).configuration);
        let tools = self
            .visible_tools(&cell, &config, state.thread.desktop.is_some())
            .await;
        Ok(
            json!({"threadId":thread_id,"sessionId":state.thread.session_id,"parentThreadId":state.thread.parent_thread_id,
            "activeTurnId":state.active.as_ref().map(|a| &a.id),"configuration":config,
            "instructionSnapshot":state.thread.turns.last().and_then(|t|t.instruction_snapshot.as_ref()),"instructionSources":["runtime/defaultOrClientSystem","profile","childTask","clientAppend","workspace/AGENTS.md"],"tools":tools,"loadedSkills":state.thread.desktop.as_ref().map(|d| &d.loaded_skills),
            "contextCheckpoint":state.thread.context_checkpoint,"usage":state.thread.turns.last().and_then(|t| t.usage.as_ref()),
            "usageKnown":state.thread.turns.last().is_some_and(|t| t.usage.is_some()),
            "limits":{"turnTimeoutMs":self.limits.turn_timeout.as_millis(),"historyBytes":self.limits.max_history_bytes,"contextBytes":self.limits.context_window_bytes},
            "runtime":self.runtime_capabilities()}),
        )
    }
    pub async fn find_request(&self, identity: &str, request_id: &str) -> Result<Value> {
        let mut management = self.management_receipts(identity, request_id).await;
        let cells: Vec<_> = self.threads.read().await.values().cloned().collect();
        for cell in cells {
            let state = cell.state.lock().await;
            if let Some(d) = &state.thread.desktop {
                for receipt in &d.receipts {
                    if receipt.identity == identity && receipt.request_id == request_id {
                        let mut v = json!(receipt);
                        v["threadId"] = json!(state.thread.id);
                        management["data"].as_array_mut().unwrap().push(v);
                    }
                }
            }
        }
        Ok(management)
    }
    pub async fn request_status(
        &self,
        identity: &str,
        thread_id: &str,
        request_id: &str,
    ) -> Result<Value> {
        let thread = self.read(thread_id, false).await?;
        let records = desktop(&thread)
            .receipts
            .into_iter()
            .filter(|r| r.identity == identity && r.request_id == request_id)
            .collect::<Vec<_>>();
        Ok(json!({"data":records,"retention":"threadLifetime","capacity":1024}))
    }
    pub(crate) async fn active_permissions(
        &self,
        cell: &Cell,
    ) -> areal_runtime_protocol::PermissionRequest {
        let state = cell.state.lock().await;
        let readonly = state
            .thread
            .turns
            .last()
            .and_then(|t| t.configuration.as_ref())
            .is_some_and(|c| c.read_only);
        areal_runtime_protocol::PermissionRequest {
            write_roots: if readonly {
                Some(Vec::new())
            } else {
                self.scope_permissions(cell).write_roots
            },
            network: if readonly {
                areal_runtime_protocol::NetworkRequest::Deny
            } else {
                areal_runtime_protocol::NetworkRequest::Inherit
            },
            ..Default::default()
        }
    }
}
