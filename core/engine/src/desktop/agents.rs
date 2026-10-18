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
            .is_some_and(|mode| !matches!(mode, "sharedReadOnly" | "sharedWrite" | "isolatedWrite"))
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
        if config.model.is_none() {
            config.default_model_revision = previous.default_model_revision.clone();
        }
        config.options = previous.options.clone();
        if let Some(profile) = &previous.profile
            && config
                .profile
                .as_ref()
                .is_none_or(|child| child.id != profile.id || child.revision != profile.revision)
            && !profile.approval_tools.is_empty()
        {
            // 切换 Profile 不能丢失父任务的强制审批，也不能以旧预批准绕过它。
            config
                .options
                .approval_tools
                .extend(profile.approval_tools.clone());
            config.options.approval_tools.sort();
            config.options.approval_tools.dedup();
            config.options.preapproved_tools.clear();
        }
        config.read_only |= previous.read_only
            || !matches!(
                request.workspace_mode.as_deref(),
                Some("sharedWrite" | "isolatedWrite")
            );
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
            // An explicit empty list means "use no additional skills". It is
            // valid for model-only child configurations that have no profile.
            if !skills.is_empty() {
                let profile = config
                    .profile
                    .as_mut()
                    .ok_or_else(|| invalid("non-empty skills require a profile"))?;
                if skills.iter().any(|s| !profile.skills.contains(s)) {
                    return Err(invalid("child skills exceed selected profile"));
                }
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
            .map(|t| format!("{}/{}", parent_id, t.id))
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
        if configuration.model.is_none() {
            configuration.default_model_revision = task.default_model_revision.clone();
        }
        configuration.read_only |= task.read_only;
        if task.approval_tools.len() > 256
            || task
                .system_prompt
                .as_ref()
                .is_some_and(|text| text.len() > 32768)
            || task.append_instructions.len() > 32768
        {
            return Err(invalid("worker inherited options exceed configured budget"));
        }
        // 隔离运行没有交互宿主；必须审批的操作直接拒绝，不能创建无人响应的审批。
        configuration.options.interaction_mode = areal_protocol::tasks::InteractionMode::Headless;
        configuration
            .options
            .approval_tools
            .extend(task.approval_tools.clone());
        configuration.options.approval_tools.sort();
        configuration.options.approval_tools.dedup();
        configuration.options.preapproved_tools.clear();
        configuration.options.system_prompt = task.system_prompt.clone();
        configuration.options.append_instructions = task.append_instructions.clone();
        if let Some(rounds) = task.max_model_rounds {
            if rounds == 0
                || rounds > 1024
                || configuration
                    .options
                    .max_model_rounds
                    .is_some_and(|limit| rounds > limit)
            {
                return Err(invalid("worker model rounds exceed configured limit"));
            }
            configuration.options.max_model_rounds = Some(rounds);
        }
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
    pub(crate) fn frozen_worker_configuration(&self, frozen: &EffectiveConfig) -> EffectiveConfig {
        // RSI 只固定实验配置；审批仍继承当前部署边界，禁止重用交互预批准。
        let mut configuration = frozen.clone();
        configuration.options.interaction_mode = areal_protocol::tasks::InteractionMode::Headless;
        configuration.options.preapproved_tools.clear();
        configuration
    }

    pub(crate) async fn create_worker(
        &self,
        worker: &Arc<Engine>,
        configuration: EffectiveConfig,
        cwd: String,
    ) -> Result<Thread> {
        // 隔离实例继承部署的 ask/deny 边界，不复制会话或项目授权记忆。
        worker
            .set_permissions(self.permission_config(), None)
            .map_err(invalid)?;
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
        self.spawn_agent_inner(request, None).await
    }

    pub(crate) async fn spawn_agent_for_model(
        self: &Arc<Self>,
        request: AgentSpawn,
        parent_turn: String,
    ) -> Result<Value> {
        self.spawn_agent_inner(request, Some(parent_turn)).await
    }

    async fn spawn_agent_inner(
        self: &Arc<Self>,
        request: AgentSpawn,
        model_parent_turn: Option<String>,
    ) -> Result<Value> {
        let cell = self.cell(&request.parent_thread_id).await?;
        if cell.exclusive_writer {
            return Err(invalid(
                "exclusive writers must return a handoff instead of recursively creating child executions",
            ));
        }
        if self.read(&request.parent_thread_id, false).await?.is_side() {
            return Err(invalid("SIDE_POLICY_VIOLATION"));
        }
        if request.workspace_mode.as_deref() != Some("isolatedWrite") {
            let (thread, turn) = if let Some(parent_turn) = model_parent_turn {
                // 模型委派必须加入父轮次的结果汇总；手工 RPC 保持原有寿命。
                self.spawn_configured_model_child(request, parent_turn)
                    .await?
            } else {
                self.spawn_configured_child(request).await?
            };
            return Ok(
                json!({"thread":thread,"turn":turn,"threadId":thread.id,"turnId":turn.id,"configuration":turn.configuration.as_ref().map(|c|json!({"revision":c.revision,"profile":c.profile.as_ref().map(|p|json!({"id":p.id,"revision":p.revision})),"model":c.model,"readOnly":c.read_only}))}),
            );
        }
        let mut state = cell.state.lock().await;
        let active = state
            .active
            .as_ref()
            .filter(|active| {
                !active.sealed
                    && model_parent_turn
                        .as_ref()
                        .is_none_or(|turn| *turn == active.id)
            })
            .ok_or(Error::Conflict)?;
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
        let owner = format!("{}/{}", state.thread.id, active.id);
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
                default_model_revision: configuration.default_model_revision,
                agent_profile: configuration.profile.as_ref().map(|p| VersionRef {
                    id: p.id.clone(),
                    revision: p.revision.clone(),
                }),
                model: configuration.model,
                skills: configuration.selected_skills,
                tool_allowlist: configuration.tool_allowlist,
                read_only: false,
                max_model_rounds: configuration.options.max_model_rounds,
                approval_tools: configuration.options.approval_tools,
                system_prompt: configuration.options.system_prompt,
                append_instructions: configuration.options.append_instructions,
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
        let _workspace = self.workspace_snapshot_guard(&cancel).await?;
        let result = self
            .workgroups()
            .map_err(invalid)?
            .start_with_goal(
                owner.clone(),
                request,
                cancel,
                self.goal_for_owner(&owner).await,
            )
            .await
            .map_err(invalid)?;
        Ok(
            json!({"agentId":format!("workgroup:{}",result["id"].as_str().unwrap()),"workspaceMode":"isolatedWrite","workgroup":crate::workgroup::tools::summary(&result)}),
        )
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use crate::model::{Message, Model, ModelEvent, ModelStream};
    use async_trait::async_trait;
    use tokio::sync::Semaphore;

    struct ApprovalWorker;

    #[tokio::test]
    async fn frozen_rsi_worker_keeps_provider_and_sampling_after_catalog_reload() {
        use futures_util::StreamExt;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let app = axum::Router::new().route("/original", axum::routing::post(move |axum::Json(request): axum::Json<Value>| {
            let tx = tx.clone();
            async move {
                tx.send(request).unwrap();
                ([("content-type", "text/event-stream")], "data: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n")
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/original", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let root = tempfile::tempdir().unwrap();
        let source = Engine::open(
            &root.path().join("source"),
            Arc::new(ApprovalWorker),
            Limits::default(),
        )
        .unwrap();
        let provider: Provider = serde_json::from_value(json!({
            "id":"rsi-provider","revision":1,"endpoint":endpoint,"protocol":"responses","models":["rsi-model"],
            "parameters":{"temperature":0.1,"maxOutputTokens":1024,"reasoningEffort":"low"}
        })).unwrap();
        let install = |provider: Provider| ConfiguredModels {
            provider_ids: [provider.id.clone()].into_iter().collect(),
            default_model: Some(ModelRef {
                provider_id: provider.id.clone(),
                model_id: "rsi-model".into(),
            }),
            providers: vec![provider],
            ..Default::default()
        };
        source
            .install_configured_models(install(provider.clone()))
            .unwrap();
        let mut frozen = source.resolve_config(None, None, serde_json::from_value(json!({
            "temperature":0.4,"maxOutputTokens":3072,"contextWindowTokens":65536,"reasoningEffort":"high"
        })).unwrap(), 7).unwrap();
        frozen.options.preapproved_tools = vec!["*".into()];
        frozen.options.max_model_rounds = Some(5);
        frozen.options.system_prompt = Some("frozen system prompt".into());
        frozen.instructions = "frozen harness inputs".into();
        let mut reloaded = provider;
        reloaded.endpoint = format!("{endpoint}/wrong");
        reloaded.parameters.max_output_tokens = Some(8192);
        source.install_configured_models(install(reloaded)).unwrap();
        let fresh = source
            .resolve_config(None, None, Default::default(), 1)
            .unwrap();
        assert_ne!(fresh.provider, frozen.provider);
        assert_eq!(fresh.parameters.max_output_tokens, Some(8192));
        // 模拟重启读取目标持久快照，不能从新目录默认值补齐旧配置。
        let restored: EffectiveConfig =
            serde_json::from_slice(&serde_json::to_vec(&frozen).unwrap()).unwrap();
        for snapshot in [&frozen, &restored] {
            let configuration = source.frozen_worker_configuration(snapshot);
            let mut expected = snapshot.clone();
            expected.options.interaction_mode = areal_protocol::tasks::InteractionMode::Headless;
            expected.options.preapproved_tools.clear();
            assert_eq!(configuration, expected);
            let selected = source.configured_model(&configuration).unwrap();
            let mut events = selected
                .stream(vec![Message::text("user", "verify snapshot")])
                .await
                .unwrap();
            while let Some(event) = events.next().await {
                event.unwrap();
            }
            let request = rx.recv().await.unwrap();
            assert_eq!(request["model"], "rsi-model");
            assert_eq!(request["temperature"], 0.4);
            assert_eq!(request["max_output_tokens"], 3072);
            assert_eq!(request["reasoning"]["effort"], "high");
            let worker = Engine::open(
                &root.path().join(format!("worker-{}", uuid::Uuid::new_v4())),
                Arc::new(ApprovalWorker),
                Limits::default(),
            )
            .unwrap();
            let thread = source
                .create_worker(&worker, configuration.clone(), "/workspace".into())
                .await
                .unwrap();
            assert_eq!(thread.desktop.unwrap().configuration, configuration);
            worker.shutdown().await;
        }
        source.shutdown().await;
        server.abort();
    }

    #[async_trait]
    impl Model for ApprovalWorker {
        fn name(&self) -> &str {
            "isolated-approval-worker"
        }

        async fn stream(&self, messages: Vec<Message>) -> anyhow::Result<ModelStream> {
            let event = if messages.iter().any(|message| message.role == "tool") {
                assert!(messages.iter().any(|message| {
                    message
                        .text_content()
                        .contains("NON_INTERACTIVE_APPROVAL_REQUIRED")
                }));
                ModelEvent::text("approval-required operation declined")
            } else {
                ModelEvent::ToolCall(crate::model::ToolCall {
                    id:"plan".into(), name:"plan_update".into(),
                    arguments:json!({"expectedRevision":0,"steps":[{"id":"one","text":"requires approval","status":"completed"}]}).to_string(),
                })
            };
            Ok(Box::pin(futures_util::stream::iter([Ok(event)])))
        }
    }

    #[tokio::test]
    async fn isolated_workers_preserve_approval_and_prompt_boundaries_without_waiting_for_input() {
        let root = tempfile::tempdir().unwrap();
        let source = Engine::open(
            &root.path().join("source"),
            Arc::new(ApprovalWorker),
            Limits::default(),
        )
        .unwrap();
        let deployment = root.path().join("deployment.json");
        std::fs::write(&deployment, serde_json::to_vec(&json!({"profiles":[
            {"id":"parent","revision":"v1","displayName":"parent","instructions":"","approvalTools":["plan_update"]},
            {"id":"worker","revision":"v1","displayName":"worker","instructions":"","approvalTools":["goal_update"],"toolAllowlist":["plan_update"]}
        ]})).unwrap()).unwrap();
        source.install_deployment(&deployment).unwrap();
        source
            .set_permissions(
                areal_config::PermissionConfig {
                    deny: vec!["fs_write".into()],
                    ask: vec!["run_command".into()],
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        let parent_ref = VersionRef {
            id: "parent".into(),
            revision: "v1".into(),
        };
        let mut previous = source
            .resolve_config(Some(parent_ref), None, Default::default(), 1)
            .unwrap();
        previous.options.approval_tools = vec!["fs_write".into()];
        previous.options.preapproved_tools = vec!["*".into()];
        previous.options.system_prompt = Some("trusted inherited system prompt".into());
        previous.options.append_instructions = "preserve the requested constraints".into();
        previous.options.max_model_rounds = Some(3);
        let mut parent = source.create("/workspace".into()).await.unwrap();
        parent
            .desktop
            .get_or_insert_with(Default::default)
            .configuration = previous;
        let request = serde_json::from_value(json!({
            "parentThreadId":parent.id,"input":[{"type":"text","text":"work"}],
            "workspaceMode":"isolatedWrite","agentProfile":{"id":"worker","revision":"v1"}
        }))
        .unwrap();
        let child = source
            .child_configuration(&parent, Some(&request))
            .unwrap()
            .unwrap();
        assert!(crate::permissions::forced(
            Some(&child),
            "plan_update",
            &json!({})
        ));
        assert!(crate::permissions::forced(
            Some(&child),
            "goal_update",
            &json!({})
        ));
        let task = crate::workgroup::TaskConfiguration {
            approval_tools: child.options.approval_tools,
            system_prompt: child.options.system_prompt,
            append_instructions: child.options.append_instructions,
            max_model_rounds: child.options.max_model_rounds,
            agent_profile: request.agent_profile,
            tool_allowlist: child.tool_allowlist,
            ..Default::default()
        };
        let configuration = source.worker_configuration(&task).unwrap();
        assert_eq!(
            configuration.options.interaction_mode,
            areal_protocol::tasks::InteractionMode::Headless
        );
        assert!(configuration.options.preapproved_tools.is_empty());
        assert_eq!(
            configuration.options.system_prompt.as_deref(),
            Some("trusted inherited system prompt")
        );
        assert_eq!(
            configuration.options.append_instructions,
            "preserve the requested constraints"
        );
        assert_eq!(configuration.options.max_model_rounds, Some(3));
        for tool in ["plan_update", "goal_update", "fs_write"] {
            assert!(crate::permissions::forced(
                Some(&configuration),
                tool,
                &json!({})
            ));
        }
        let mut expanded = task.clone();
        expanded.tool_allowlist = Some(vec!["goal_update".into()]);
        assert!(source.worker_configuration(&expanded).is_err());
        let worker = Engine::open(
            &root.path().join("worker"),
            Arc::new(ApprovalWorker),
            Limits::default(),
        )
        .unwrap();
        let thread = source
            .create_worker(
                &worker,
                source.worker_configuration(&task).unwrap(),
                "/workspace".into(),
            )
            .await
            .unwrap();
        let cell = worker.raw_cell(&thread.id).await.unwrap();
        assert_eq!(
            worker
                .permission_action(
                    &cell,
                    "fs_write",
                    &json!({"path":"result.txt","text":"unapproved"})
                )
                .await,
            "deny"
        );
        assert_eq!(
            worker
                .permission_action(&cell, "run_command", &json!({"argv":["true"]}))
                .await,
            "ask"
        );
        worker
            .start(&thread.id, vec![Input::text("try operation")])
            .await
            .unwrap();
        let done = tokio::time::timeout(Duration::from_secs(5), worker.wait(&thread.id))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(done.turns[0].status, TurnStatus::Completed);
        assert!(worker.plan(&thread.id).await.unwrap().steps.is_empty());
        assert_eq!(
            worker.interactions(&thread.id).await.unwrap()["data"],
            json!([])
        );
        worker.shutdown().await;
        source.shutdown().await;
    }

    struct ModelFixture {
        parent_started: Semaphore,
        parent_release: Semaphore,
        child_started: Semaphore,
        child_release: Semaphore,
    }

    #[async_trait]
    impl Model for ModelFixture {
        fn name(&self) -> &str {
            "configured-child-lifetime"
        }

        async fn stream(&self, messages: Vec<Message>) -> anyhow::Result<ModelStream> {
            let child = messages
                .iter()
                .any(|message| message.role == "user" && message.text_content() == "child");
            let joined = messages
                .iter()
                .any(|message| message.text_content().contains("child-evidence"));
            let text = if child {
                self.child_started.add_permits(1);
                self.child_release.acquire().await?.forget();
                "child-evidence"
            } else if joined {
                "integrated-child-evidence"
            } else {
                self.parent_started.add_permits(1);
                self.parent_release.acquire().await?.forget();
                "parent-ready"
            };
            Ok(Box::pin(futures_util::stream::iter(vec![Ok(
                ModelEvent::text(text),
            )])))
        }
    }

    #[tokio::test]
    async fn model_configured_child_is_joined_before_parent_completion() {
        let root = tempfile::tempdir().unwrap();
        let model = Arc::new(ModelFixture {
            parent_started: Semaphore::new(0),
            parent_release: Semaphore::new(0),
            child_started: Semaphore::new(0),
            child_release: Semaphore::new(0),
        });
        let engine = Engine::open(root.path(), model.clone(), Limits::default()).unwrap();
        let parent = engine.create("/workspace".into()).await.unwrap();
        let turn = engine
            .start(&parent.id, vec![Input::text("parent")])
            .await
            .unwrap();
        model.parent_started.acquire().await.unwrap().forget();
        let request = serde_json::from_value(json!({
            "parentThreadId": parent.id,
            "input": [{"type":"text","text":"child"}]
        }))
        .unwrap();
        let child = engine
            .spawn_agent_for_model(request, turn.id)
            .await
            .unwrap();
        model.child_started.acquire().await.unwrap().forget();
        model.parent_release.add_permits(1);
        assert!(
            tokio::time::timeout(Duration::from_millis(30), engine.wait(&parent.id))
                .await
                .is_err()
        );
        model.child_release.add_permits(1);
        let completed = tokio::time::timeout(Duration::from_secs(5), engine.wait(&parent.id))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(completed.turns[0].status, TurnStatus::Completed);
        assert!(completed.turns[0].items.iter().any(|item| matches!(item, Item::AgentMessage { text, .. } if text == "integrated-child-evidence")));
        let saved = engine
            .read(child["threadId"].as_str().unwrap(), true)
            .await
            .unwrap();
        assert_eq!(saved.turns[0].status, TurnStatus::Completed);
        engine.shutdown().await;
    }
}
