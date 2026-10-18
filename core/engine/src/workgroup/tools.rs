//! Coordination tools operate on Core state, outside Runtime/tool/model permits.
use super::service::{Service, Start};
use crate::tools::registry::Backend;
use crate::*;
use areal_protocol::ToolDefinition;
use serde::Deserialize;

pub(crate) fn definitions() -> Vec<ToolDefinition> {
    let string = json!({"type":"string","minLength":1,"maxLength":128});
    let task_id =
        json!({"type":"string","minLength":1,"maxLength":80,"pattern":"^[A-Za-z0-9_-]+$"});
    let plan = json!({"type":"object","required":["objective","tasks"],"additionalProperties":false,
        "properties":{"objective":{"type":"string","minLength":1,"maxLength":32000},"tasks":{"type":"array","minItems":1,"maxItems":64,
        "items":{"type":"object","additionalProperties":false,"required":["id","instruction","writes"],"properties":{
        "configuration":{"type":["object","null"],"properties":{"agentProfile":{"type":"object"},"model":{"type":"object"},"skills":{"type":"array"},"toolAllowlist":{"type":"array","items":{"type":"string"}},"readOnly":{"type":"boolean"}},"additionalProperties":false},"id":task_id,"instruction":{"type":"string","minLength":1,"maxLength":32000},"writes":{"type":"array","minItems":0,"maxItems":256,"uniqueItems":true,"items":{"type":"string","minLength":1,"maxLength":4096}},
        "depends":{"type":"array","maxItems":64,"uniqueItems":true,"items":task_id},"integrationDepends":{"type":"array","maxItems":64,"uniqueItems":true,"items":task_id},
        "checks":{"type":"array","maxItems":16,"items":{"type":"array","minItems":1,"maxItems":128,"items":{"type":"string"}}}}}}}});
    [
        ("workgroup_start", "Dispatch a bounded plan into isolated workspaces. Use only for substantial independent work; use one worker for coupled work. depends blocks execution; integrationDepends allows work against an explicit interface in instruction but blocks acceptance. Deployment final checks and allowed writes are immutable. Reuse requestId for retries. Result is a verified candidate, not an edit of the user's checkout.",
            json!({"requestId":string,"plan":plan,"workers":{"type":"integer","minimum":1,"maximum":32},"admission":{"enum":["fixed","auto","adaptive"]}}),vec!["requestId","plan"]),
        ("workgroup_artifact", "Read the final verified change list or a changed file in bounded byte chunks. baseSha256 is the original file version for conditional application to the parent workspace. Never overwrite a newer parent file without reconciling it. Null path lists changes.",json!({"id":string,"path":{"type":["string","null"]},"offset":{"type":"integer","minimum":0}}),vec!["id"]),
        ("workgroup_read", "Read this Turn's workgroup state, plan revision and verified result.", json!({"id":string}),vec!["id"]),
        ("workgroup_wait", "Wait for a state revision without holding model or execution capacity. Use the returned revision as afterRevision. Finishing this Turn also joins its groups and summarizes their final results.",json!({"id":string,"afterRevision":{"type":"integer","minimum":0},"timeoutMs":{"type":"integer","minimum":0,"maximum":60000}}),vec!["id","afterRevision"]),
        ("workgroup_revise", "Revise unstarted tasks or append tasks inside the original write scope. Retain existing task IDs/order/checks. Started contracts cannot change. Use planRevision for compare-and-swap, requestId for deduplication.",json!({"id":string,"requestId":string,"expectedRevision":{"type":"integer","minimum":0},"plan":plan}),vec!["id","requestId","expectedRevision","plan"]),
        ("workgroup_cancel", "Request cancellation; wait until state settles to confirm cleanup.",json!({"id":string}),vec!["id"]),
    ].into_iter().map(|(name,description,properties,required)| ToolDefinition {
        name:name.into(),description:description.into(),input_schema:json!({"type":"object","additionalProperties":false,"properties":properties,"required":required}), output_schema:None,
    }).collect()
}

pub(crate) fn summary(value: &Value) -> Value {
    let record = &value["record"];
    let excerpt =
        |text: &Value, n: usize| text.as_str().map(|s| s.chars().take(n).collect::<String>());
    let tasks = record["tasks"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let mut result = json!({"id":value["id"],"revision":record["revision"],"planRevision":record["planRevision"],
        "status":record["status"],"head":record["head"],"candidatePath":value["candidatePath"],
        "cleanupConfirmed":record["cleanupConfirmed"],"error":excerpt(&record["error"],256),
        "finalCheck":{"passed":record["finalCheck"]["passed"],"output":excerpt(&record["finalCheck"]["output"],256)},
        "admission":{"maxWorkers":record["admission"]["maxWorkers"],"targetWorkers":record["admission"]["targetWorkers"],"peakInflight":record["admission"]["peakInflight"]},
        "tasks":tasks.iter().map(|t| json!({"id":t["spec"]["id"],"status":t["status"],"generation":t["generation"]})).collect::<Vec<_>>(),
        "feedback":tasks.iter().filter(|t|t["feedback"].as_str().is_some_and(|s|!s.is_empty())).take(4)
            .map(|t|json!({"id":t["spec"]["id"],"text":excerpt(&t["feedback"],64)})).collect::<Vec<_>>()});
    // Retain valid structured results even for maximum IDs or very deep paths.
    if serde_json::to_vec(&result).is_ok_and(|b| b.len() > 14 * 1024) {
        result["candidatePath"] = Value::Null;
        result["feedback"] = Value::Null;
        result["detailsAvailable"] = json!(true);
    }
    result
}

pub(crate) fn summaries(values: &[Value]) -> Vec<Value> {
    let mut results: Vec<_> = values.iter().map(summary).collect();
    if serde_json::to_vec(&results).is_ok_and(|b| b.len() > 32 * 1024) {
        for result in &mut results {
            result["tasks"] = Value::Null;
            result["feedback"] = Value::Null;
            result["candidatePath"] = Value::Null;
            result["finalCheck"]["output"] = Value::Null;
            result["detailsAvailable"] = json!(true);
        }
    }
    results
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Wait {
    id: String,
    after_revision: u64,
    #[serde(default = "default_wait")]
    timeout_ms: u64,
}
fn default_wait() -> u64 {
    10000
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Revise {
    id: String,
    request_id: String,
    expected_revision: u64,
    plan: super::Plan,
}

impl Engine {
    async fn freeze_workgroup_models(
        &self,
        owner: &str,
        plan: &mut super::Plan,
    ) -> anyhow::Result<()> {
        let Some((thread, turn)) = owner.split_once('/') else {
            return Ok(());
        };
        let cell = self.cell(thread).await?;
        let state = cell.state.lock().await;
        anyhow::ensure!(
            state.active.as_ref().is_some_and(|active| active.id == turn
                && !active.sealed
                && !active.cancel.is_cancelled()),
            "Workgroup owner Turn is no longer active"
        );
        for task in &mut plan.tasks {
            let requested = task.configuration.clone().unwrap_or_default();
            let request = areal_protocol::desktop::AgentSpawn {
                parent_thread_id: thread.into(),
                input: vec![Input::text(task.instruction.clone())],
                instructions: None,
                agent_profile: requested.agent_profile.clone(),
                skills: requested.skills.clone(),
                model: requested.model.clone(),
                tool_allowlist: requested.tool_allowlist.clone(),
                workspace_mode: Some("isolatedWrite".into()),
                writes: Some(task.writes.clone()),
            };
            let inherited = self
                .child_configuration(&state.thread, Some(&request))?
                .context("Workgroup worker requires inherited configuration")?;
            anyhow::ensure!(
                requested.max_model_rounds.is_none_or(|rounds| {
                    (1..=1024).contains(&rounds)
                        && inherited
                            .options
                            .max_model_rounds
                            .is_none_or(|limit| rounds <= limit)
                }),
                "worker model rounds exceed parent boundary"
            );
            let mut approval_tools = inherited.options.approval_tools;
            approval_tools.extend(requested.approval_tools);
            approval_tools.sort();
            approval_tools.dedup();
            // 遗留模型入口同样固化父 Turn 边界；隐藏工具不允许绕过配置式委派约束。
            let frozen = super::TaskConfiguration {
                agent_profile: inherited.profile.as_ref().map(|profile| {
                    areal_protocol::desktop::VersionRef {
                        id: profile.id.clone(),
                        revision: profile.revision.clone(),
                    }
                }),
                model: inherited.model,
                default_model_revision: inherited.default_model_revision,
                skills: inherited.selected_skills,
                tool_allowlist: inherited.tool_allowlist,
                read_only: inherited.read_only || requested.read_only,
                approval_tools,
                system_prompt: inherited.options.system_prompt,
                append_instructions: inherited.options.append_instructions,
                max_model_rounds: requested
                    .max_model_rounds
                    .or(inherited.options.max_model_rounds),
            };
            self.worker_configuration(&frozen)?;
            task.configuration = Some(frozen);
        }
        Ok(())
    }
    pub(crate) async fn workspace_snapshot_guard(
        &self,
        cancel: &CancellationToken,
    ) -> Result<tokio::sync::OwnedRwLockWriteGuard<()>> {
        let guard = tokio::select! { biased;
            _ = cancel.cancelled() => return Err(Error::Closed),
            _ = self.shutdown.cancelled() => return Err(Error::Closed),
            guard = self.workspace_delivery_guard() => guard,
        };
        tokio::select! { biased;
            _ = cancel.cancelled() => return Err(Error::Closed),
            _ = self.shutdown.cancelled() => return Err(Error::Closed),
            result = self.ensure_workspace_processes_settled() => result?,
        }
        Ok(guard)
    }
    pub async fn start_workgroup(
        self: &Arc<Self>,
        owner: String,
        request: Start,
        cancel: CancellationToken,
    ) -> anyhow::Result<Value> {
        let engine = self.clone();
        // 先排队源快照，再持生命周期锁；不能让等候作者的请求阻塞 drain 取消。
        // 客户端断线后继续完成已受理的创建回执，避免释放准入后遗留未登记任务。
        tokio::spawn(async move {
            let _workspace = engine.workspace_snapshot_guard(&cancel).await?;
            let _admission = tokio::select! { biased;
                _ = cancel.cancelled() => anyhow::bail!("Workgroup creation cancelled"),
                _ = engine.shutdown.cancelled() => anyhow::bail!("Core is shutting down"),
                guard = engine.desktop.lifecycle.gate.lock() => guard,
            };
            anyhow::ensure!(engine.accepting_work(), "Core is shutting down");
            engine.workgroups()?.start(owner, request, cancel).await
        })
        .await?
    }

    pub fn workgroups(&self) -> anyhow::Result<&Arc<Service>> {
        self.workgroups
            .get()
            .context("workgroups require a trusted deployment policy")
    }
    pub fn attach_workgroups(&self, service: Arc<Service>) -> anyhow::Result<()> {
        self.workgroups
            .set(service)
            .map_err(|_| anyhow::anyhow!("workgroup service already attached"))
    }
    pub(crate) async fn coordinate(
        &self,
        owner: &str,
        name: &str,
        args: &Value,
        cancel: &CancellationToken,
    ) -> anyhow::Result<Value> {
        let service = self.workgroups()?;
        let value = match name {
            "workgroup_start" => {
                let mut request = serde_json::from_value::<Start>(args.clone())?;
                self.freeze_workgroup_models(owner, &mut request.plan)
                    .await?;
                let _workspace = self.workspace_snapshot_guard(cancel).await?;
                service
                    .start_with_goal(
                        owner.into(),
                        request,
                        cancel.clone(),
                        self.goal_for_owner(owner).await,
                    )
                    .await?
            }
            "workgroup_artifact" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Artifact {
                    id: String,
                    path: Option<String>,
                    #[serde(default)]
                    offset: usize,
                }
                let p: Artifact = serde_json::from_value(args.clone())?;
                return service.artifact(&p.id, Some(owner), p.path, p.offset).await;
            }
            "workgroup_read" => {
                let p: Target = serde_json::from_value(args.clone())?;
                service.read(&p.id, Some(owner)).await?
            }
            "workgroup_cancel" => {
                let p: Target = serde_json::from_value(args.clone())?;
                service.cancel(&p.id, Some(owner)).await?
            }
            "workgroup_wait" => {
                let p: Wait = serde_json::from_value(args.clone())?;
                tokio::select! { biased; _=cancel.cancelled()=>anyhow::bail!("cancelled"),
                value=service.wait(&p.id,Some(owner),p.after_revision,Duration::from_millis(p.timeout_ms))=>value? }
            }
            "workgroup_revise" => {
                let mut p: Revise = serde_json::from_value(args.clone())?;
                self.freeze_workgroup_models(owner, &mut p.plan).await?;
                service
                    .revise(
                        &p.id,
                        Some(owner),
                        p.request_id,
                        p.expected_revision,
                        p.plan,
                    )
                    .await?
            }
            _ => anyhow::bail!("unknown coordination tool"),
        };
        Ok(summary(&value))
    }
}

impl crate::tools::Registry {
    pub(crate) fn with_workgroups(mut self, enabled: bool) -> anyhow::Result<Self> {
        if enabled {
            for definition in definitions() {
                self.insert(definition, Backend::Coordination)?;
            }
        }
        Ok(self)
    }
}

#[cfg(test)]
mod inheritance_tests {
    use super::*;
    struct Pending;
    #[async_trait::async_trait]
    impl Model for Pending {
        fn name(&self) -> &str {
            "pending-workgroup-owner"
        }
        async fn stream(&self, _: Vec<model::Message>) -> anyhow::Result<model::ModelStream> {
            Ok(Box::pin(futures_util::stream::pending()))
        }
    }

    #[tokio::test]
    async fn legacy_workgroup_freezes_parent_permissions_and_round_budget() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(dir.path(), Arc::new(Pending), Limits::default()).unwrap();
        let deployment = dir.path().join("deployment.json");
        std::fs::write(&deployment, serde_json::to_vec(&json!({"profiles":[
            {"id":"parent","revision":"v1","displayName":"parent","instructions":"","approvalTools":["plan_update"],"toolAllowlist":["plan_read","plan_update"]},
            {"id":"child","revision":"v1","displayName":"child","instructions":"","approvalTools":["goal_update"],"toolAllowlist":["plan_read"]}
        ]})).unwrap()).unwrap();
        engine.install_deployment(&deployment).unwrap();
        let parent = engine.create("/workspace".into()).await.unwrap();
        let turn = engine
            .start(&parent.id, vec![Input::text("parent")])
            .await
            .unwrap();
        let cell = engine.cell(&parent.id).await.unwrap();
        {
            let mut configuration = engine
                .resolve_config(
                    Some(areal_protocol::desktop::VersionRef {
                        id: "parent".into(),
                        revision: "v1".into(),
                    }),
                    None,
                    Default::default(),
                    1,
                )
                .unwrap();
            configuration.options.max_model_rounds = Some(3);
            configuration.options.approval_tools = vec!["run_command".into()];
            configuration.options.system_prompt = Some("trusted system".into());
            configuration.options.append_instructions = "keep inherited constraints".into();
            cell.state.lock().await.thread.turns[0].configuration = Some(configuration);
        }
        let owner = format!("{}/{}", parent.id, turn.id);
        let plan: super::super::Plan = serde_json::from_value(json!({"objective":"work","tasks":[{
            "id":"child","instruction":"work","writes":["result.txt"],
            "configuration":{"agentProfile":{"id":"child","revision":"v1"}}
        }]}))
        .unwrap();
        let mut frozen = plan.clone();
        engine
            .freeze_workgroup_models(&owner, &mut frozen)
            .await
            .unwrap();
        let task = frozen.tasks[0].configuration.as_ref().unwrap();
        assert_eq!(task.max_model_rounds, Some(3));
        assert_eq!(task.tool_allowlist, Some(vec!["plan_read".into()]));
        assert_eq!(task.system_prompt.as_deref(), Some("trusted system"));
        assert_eq!(task.append_instructions, "keep inherited constraints");
        let effective = engine.worker_configuration(task).unwrap();
        for name in ["plan_update", "goal_update", "run_command"] {
            assert!(
                crate::permissions::forced(Some(&effective), name, &json!({})),
                "{name}"
            );
        }
        let mut oversized = plan.clone();
        oversized.tasks[0]
            .configuration
            .as_mut()
            .unwrap()
            .max_model_rounds = Some(4);
        assert!(
            engine
                .freeze_workgroup_models(&owner, &mut oversized)
                .await
                .is_err()
        );
        let mut expanded = plan;
        expanded.tasks[0]
            .configuration
            .as_mut()
            .unwrap()
            .tool_allowlist = Some(vec!["plan_update".into()]);
        assert!(
            engine
                .freeze_workgroup_models(&owner, &mut expanded)
                .await
                .is_err()
        );
        engine.shutdown().await;
    }
    struct SnapshotFixture;
    impl super::super::service::Factory for SnapshotFixture {
        fn executor(
            &self,
            _: &Path,
            _: &super::super::service::Policy,
        ) -> anyhow::Result<Arc<dyn super::super::Executor>> {
            Ok(Arc::new(Self))
        }
    }
    #[async_trait::async_trait]
    impl super::super::Executor for SnapshotFixture {
        async fn attempt(
            &self,
            _: super::super::Task,
            _: u32,
            base: super::super::tree::Tree,
            _: Option<super::super::tree::Tree>,
            _: String,
            _: CancellationToken,
        ) -> anyhow::Result<super::super::tree::Tree> {
            Ok(base)
        }
        async fn verify(
            &self,
            tree: super::super::tree::Tree,
            _: Vec<Vec<String>>,
            _: CancellationToken,
        ) -> anyhow::Result<super::super::Check> {
            Ok(super::super::Check {
                tree_hash: super::super::tree::digest(&tree),
                passed: true,
                output: "fixture".into(),
            })
        }
    }
    #[tokio::test]
    async fn legacy_snapshot_entries_wait_for_writer_without_blocking_lifecycle() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let engine = Engine::open(
            &dir.path().join("engine"),
            Arc::new(Pending),
            Limits::default(),
        )
        .unwrap();
        let service = Service::open(
            &dir.path().join("groups"),
            &workspace,
            super::super::service::Policy {
                allowed_writes: vec!["result.txt".into()],
                allowed_directories: vec![],
                checks: vec![vec!["true".into()]],
                workers: 1,
                verifiers: 1,
                active_groups: 4,
                timeout_seconds: 10,
                command_timeout_ms: 1000,
                max_model_requests: 32,
            },
            Arc::new(SnapshotFixture),
        )
        .unwrap();
        engine.attach_workgroups(service.clone()).unwrap();
        let parent = engine
            .create(workspace.to_string_lossy().into_owned())
            .await
            .unwrap();
        let turn = engine
            .start(&parent.id, vec![Input::text("owner")])
            .await
            .unwrap();
        let request = |key| {
            serde_json::from_value::<Start>(json!({"requestId":key,"plan":{"objective":"work","tasks":[{"id":"child","instruction":"work","writes":["result.txt"]}]}})).unwrap()
        };
        let writer = engine.workspace_delivery_guard().await;
        let rpc_engine = engine.clone();
        let rpc_request = request("rpc");
        let rpc = tokio::spawn(async move {
            rpc_engine
                .start_workgroup("rpc-client".into(), rpc_request, CancellationToken::new())
                .await
        });
        let tool_engine = engine.clone();
        let tool_request = serde_json::to_value(request("tool")).unwrap();
        let owner = format!("{}/{}", parent.id, turn.id);
        let tool = tokio::spawn(async move {
            tool_engine
                .coordinate(
                    &owner,
                    "workgroup_start",
                    &tool_request,
                    &CancellationToken::new(),
                )
                .await
        });
        let configured_engine = engine.clone();
        let configured_request = serde_json::from_value(json!({"parentThreadId":parent.id,"input":[{"type":"text","text":"work"}],"workspaceMode":"isolatedWrite","writes":["result.txt"]})).unwrap();
        let configured =
            tokio::spawn(async move { configured_engine.spawn_agent(configured_request).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!rpc.is_finished() && !tool.is_finished() && !configured.is_finished());
        assert_eq!(service.list().await, json!([]));
        assert!(engine.desktop.lifecycle.gate.try_lock().is_ok());
        let cancellation = CancellationToken::new();
        let cancelled = engine.start_workgroup(
            "cancelled".into(),
            request("cancelled"),
            cancellation.clone(),
        );
        tokio::pin!(cancelled);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut cancelled)
                .await
                .is_err()
        );
        cancellation.cancel();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), cancelled)
                .await
                .unwrap()
                .is_err()
        );
        drop(writer);
        tokio::time::timeout(Duration::from_secs(5), async {
            rpc.await.unwrap().unwrap();
            tool.await.unwrap().unwrap();
            configured.await.unwrap().unwrap();
        })
        .await
        .unwrap();
        assert_eq!(service.list().await.as_array().unwrap().len(), 3);
        engine.shutdown().await;
    }
}
