use super::*;
impl Engine {
    pub(crate) fn child_configuration(
        &self,
        parent: &Thread,
        request: Option<&AgentSpawn>,
    ) -> Result<Option<EffectiveConfig>> {
        let Some(request) = request else {
            // Turn 级覆盖同样属于父任务边界；仅继承 Thread 默认配置会丢失只读和预算约束。
            return Ok(parent
                .turns
                .last()
                .and_then(|t| t.configuration.clone())
                .or_else(|| parent.desktop.as_ref().map(|d| d.configuration.clone())));
        };
        if request
            .workspace_mode
            .as_deref()
            .is_some_and(|mode| !matches!(mode, "sharedReadOnly" | "isolatedWrite"))
        {
            return Err(invalid("unsupported workspaceMode"));
        }
        let previous = parent
            .turns
            .last()
            .and_then(|t| t.configuration.clone())
            .unwrap_or_else(|| desktop(parent).configuration);
        let mut config = if request.agent_profile.is_some() || request.model.is_some() {
            self.resolve_config(
                request.agent_profile.clone().or_else(|| {
                    previous.profile.as_ref().map(|p| VersionRef {
                        id: p.id.clone(),
                        revision: p.revision.clone(),
                    })
                }),
                request.model.clone().or(previous.model.clone()),
                previous.parameters.clone(),
                1,
            )?
        } else {
            previous.clone()
        };
        config.options = previous.options.clone();
        config.read_only |=
            previous.read_only || request.workspace_mode.as_deref() != Some("isolatedWrite");
        if let Some(instructions) = &request.instructions {
            if instructions.len() > 16 * 1024 {
                return Err(invalid("child instructions exceed 16 KiB"));
            }
            config.instructions.push_str("\nChild task instructions:\n");
            config.instructions.push_str(instructions);
        }
        let requested = request
            .tool_allowlist
            .as_ref()
            .or(config.tool_allowlist.as_ref());
        if let Some(names) = requested {
            if names.len() > 128 {
                return Err(invalid("tool allowlist exceeds 128 entries"));
            }
            for name in names {
                if previous
                    .tool_allowlist
                    .as_ref()
                    .is_some_and(|p| !p.contains(name))
                {
                    return Err(invalid("child tool allowlist exceeds parent boundary"));
                }
            }
            config.tool_allowlist = Some(names.clone());
        } else {
            config.tool_allowlist = previous.tool_allowlist;
        }
        if let Some(skills) = &request.skills {
            let profile = config
                .profile
                .as_mut()
                .ok_or_else(|| invalid("skills require a profile"))?;
            if skills.iter().any(|s| !profile.skills.contains(s)) {
                return Err(invalid("child skills exceed selected profile"));
            }
            config.selected_skills = Some(skills.clone());
        }
        Ok(Some(config))
    }
    pub async fn wait_children(
        &self,
        parent_id: &str,
        ids: Vec<String>,
        timeout_ms: u64,
    ) -> Result<Value> {
        if ids.is_empty()
            || ids.len() > 16
            || timeout_ms > 60000
            || ids.iter().collect::<HashSet<_>>().len() != ids.len()
        {
            return Err(invalid(
                "wait requires 1..16 unique child IDs and timeoutMs <= 60000",
            ));
        }
        let parent = self.cell(parent_id).await?;
        let cancel = {
            let state = parent.state.lock().await;
            state.active.as_ref().map(|a| a.cancel.clone())
        };
        let mut group_results = Vec::new();
        let owner = parent
            .state
            .lock()
            .await
            .thread
            .turns
            .last()
            .map(|t| t.id.clone())
            .ok_or(Error::Conflict)?;
        for id in ids.iter().filter(|id| id.starts_with("workgroup:")) {
            let service = self.workgroups().map_err(invalid)?;
            let group = id.strip_prefix("workgroup:").unwrap();
            let mut state = service.read(group, Some(&owner)).await.map_err(invalid)?;
            let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
            while state["record"]["status"] == "running" && tokio::time::Instant::now() < deadline {
                state = service
                    .wait(
                        group,
                        Some(&owner),
                        state["record"]["revision"].as_u64().unwrap(),
                        deadline.saturating_duration_since(tokio::time::Instant::now()),
                    )
                    .await
                    .map_err(invalid)?;
            }
            let record = &state["record"];
            // 多个子任务的聚合仍须落在单次工具结果预算内；详细制品由 workgroup/read 获取。
            group_results.push(json!({"agentId":id,"workspaceMode":"isolatedWrite","result":{"id":state["id"],"revision":record["revision"],"status":record["status"],"head":record["head"],"cleanupConfirmed":record["cleanupConfirmed"],"detailsAvailable":true}}));
        }
        let ids: Vec<_> = ids
            .into_iter()
            .filter(|id| !id.starts_with("workgroup:"))
            .collect();
        let mut children = Vec::new();
        for id in &ids {
            let cell = self.cell(id).await?;
            if cell.state.lock().await.thread.parent_thread_id.as_deref() != Some(parent_id) {
                return Err(invalid("thread is not a direct child of this parent"));
            }
            children.push(cell);
        }
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        for cell in children {
            let mut settled = cell.settled.subscribe();
            let cancellation = cancel.clone().unwrap_or_default();
            tokio::select! {biased;_=cancellation.cancelled()=>return Err(Error::Closed),_=tokio::time::timeout_at(deadline,settled.wait_for(|done|*done))=>{}}
        }
        let mut data = group_results;
        for id in ids {
            let thread = self.read(&id, true).await?;
            let turn = thread.turns.last().ok_or(Error::Conflict)?;
            let text = turn
                .items
                .iter()
                .filter_map(|i| {
                    if let Item::AgentMessage { text, .. } = i {
                        Some(text.as_str())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
            let mut text = text;
            let truncated = text.len() > 512;
            if truncated {
                let mut end = 512;
                while !text.is_char_boundary(end) {
                    end -= 1;
                }
                text.truncate(end);
            }
            data.push(json!({"threadId":id,"turnId":turn.id,"status":turn.status,"error":turn.error,"text":text,"truncated":truncated,"configuration":turn.configuration.as_ref().map(|c|json!({"revision":c.revision,"profile":c.profile.as_ref().map(|p|json!({"id":p.id,"revision":p.revision})),"model":c.model,"readOnly":c.read_only}))}));
        }
        Ok(json!({"data":data}))
    }
}

impl Engine {
    pub(crate) fn worker_configuration(
        &self,
        task: &crate::workgroup::TaskConfiguration,
    ) -> Result<EffectiveConfig> {
        let mut configuration = self.resolve_config(
            task.agent_profile.clone(),
            task.model.clone(),
            Default::default(),
            1,
        )?;
        configuration.read_only |= task.read_only;
        if let Some(skills) = &task.skills {
            if skills.iter().any(|s| {
                !configuration
                    .profile
                    .as_ref()
                    .is_some_and(|p| p.skills.contains(s))
            }) {
                return Err(invalid("worker skill outside profile"));
            }
            configuration.selected_skills = Some(skills.clone());
        }
        if let Some(names) = &task.tool_allowlist {
            for name in names {
                self.registry.get(name).map_err(invalid)?;
                if configuration
                    .tool_allowlist
                    .as_ref()
                    .is_some_and(|a| !a.contains(name))
                {
                    return Err(invalid("worker tools exceed profile"));
                }
            }
            configuration.tool_allowlist = Some(names.clone());
        }
        Ok(configuration)
    }
    pub(crate) async fn create_worker(
        &self,
        worker: &Arc<Engine>,
        task: &crate::workgroup::TaskConfiguration,
        cwd: String,
    ) -> Result<Thread> {
        let configuration = self.worker_configuration(task)?;
        *worker.desktop.catalog.write().unwrap() = self.desktop.catalog.read().unwrap().clone();
        worker
            .desktop
            .worker_model
            .store(true, std::sync::atomic::Ordering::Release);
        let data = DesktopState {
            configuration,
            ..Default::default()
        };
        worker
            .create_inner(cwd, None, None, vec![], None, Some(data))
            .await
            .map(|(t, _)| t)
    }
}

impl Engine {
    pub async fn spawn_agent(self: &Arc<Self>, request: AgentSpawn) -> Result<Value> {
        if request.workspace_mode.as_deref() != Some("isolatedWrite") {
            let (thread, turn) = self.spawn_configured_child(request).await?;
            return Ok(
                json!({"thread":thread,"turn":turn,"threadId":thread.id,"turnId":turn.id,"configuration":turn.configuration.as_ref().map(|c|json!({"revision":c.revision,"profile":c.profile.as_ref().map(|p|json!({"id":p.id,"revision":p.revision})),"model":c.model,"readOnly":c.read_only}))}),
            );
        }
        let cell = self.cell(&request.parent_thread_id).await?;
        let mut state = cell.state.lock().await;
        let active = state.active.as_ref().ok_or(Error::Conflict)?;
        if cell.depth >= self.limits.max_agent_depth
            || active.children.len() + active.isolated_children >= self.limits.max_children_per_turn
        {
            return Err(Error::Exhausted(
                "agent depth or parent Turn child limit reached".into(),
            ));
        }
        if active.cancel.is_cancelled() {
            return Err(Error::Closed);
        }
        let configuration = self
            .child_configuration(&state.thread, Some(&request))?
            .unwrap();
        if configuration.read_only {
            return Err(invalid(
                "parent/profile does not authorize an isolated writer",
            ));
        }
        let owner = active.id.clone();
        let cancel = active.cancel.clone();
        let writes = request.writes.clone().ok_or_else(|| {
            invalid("isolatedWrite requires exact writes within Workgroup policy")
        })?;
        let mut instruction = configuration.instructions.clone();
        for input in request.input {
            match input {
                Input::Text { text, .. } => {
                    instruction.push('\n');
                    instruction.push_str(&text);
                }
                _ => return Err(invalid("isolated tasks currently require text input")),
            }
        }
        let task = crate::workgroup::Task {
            id: "child".into(),
            instruction,
            writes,
            depends: vec![],
            integration_depends: vec![],
            checks: vec![],
            configuration: Some(crate::workgroup::TaskConfiguration {
                agent_profile: configuration.profile.as_ref().map(|p| VersionRef {
                    id: p.id.clone(),
                    revision: p.revision.clone(),
                }),
                model: configuration.model,
                skills: configuration.selected_skills,
                tool_allowlist: configuration.tool_allowlist,
                read_only: false,
            }),
        };
        state.active.as_mut().unwrap().isolated_children += 1;
        drop(state);
        let request = crate::workgroup::service::Start {
            request_id: id(),
            plan: crate::workgroup::Plan {
                objective: "Isolated child task".into(),
                tasks: vec![task],
            },
            workers: Some(1),
            admission: crate::workgroup::Admission::Fixed,
        };
        let result = self
            .workgroups()
            .map_err(invalid)?
            .start(owner, request, cancel)
            .await
            .map_err(invalid)?;
        Ok(
            json!({"agentId":format!("workgroup:{}",result["id"].as_str().unwrap()),"workspaceMode":"isolatedWrite","workgroup":crate::workgroup::tools::summary(&result)}),
        )
    }
}
