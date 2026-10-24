use super::*;
use areal_protocol::{
    ToolDefinition,
    desktop::{EffectiveConfig, ThreadStart, ThreadStartAdmissionGuard},
};

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Create {
    objective: String,
    schedule_v2: ScheduleIntent,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Update {
    task_id: String,
    expected_revision: u64,
    objective: Option<String>,
    schedule_v2: Option<ScheduleIntent>,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
enum Action {
    Pause,
    Resume,
    RunNow,
    Delete,
    StopRun,
}
impl Action {
    fn method(&self) -> &'static str {
        match self {
            Self::Pause => "pause",
            Self::Resume => "resume",
            Self::RunNow => "runNow",
            Self::Delete => "delete",
            Self::StopRun => "stopRun",
        }
    }
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Control {
    task_id: String,
    expected_revision: u64,
    action: Action,
    expected_run_id: Option<String>,
}

pub(crate) fn definitions() -> Vec<ToolDefinition> {
    let definition = |name: &str, description: &str, input_schema: Value| ToolDefinition {
        name: name.into(),
        description: description.into(),
        input_schema,
        output_schema: None,
    };
    vec![
        definition(
            "scheduled_task_list",
            "Read schedules created in this ordinary conversation, including deleted history. Pass taskId to refresh one exact task and its current revision before changing it. Do not infer creation or current state from assistant prose. Schedule controls affect future triggers separately from the current Run. Execution requires Core and this desktop Host to be online.",
            json!({"type":"object","properties":{"taskId":{"type":"string"}},"additionalProperties":false}),
        ),
        definition(
            "scheduled_task_create",
            "Save a scheduled task from this ordinary conversation through Core. Write a complete standalone objective with the method, necessary references and output requirements; future Runs do not reread this conversation. Uses this project's workspace and current default model, with an independent execution conversation per Run. Provide a ScheduleIntent in scheduleV2 with an explicit IANA time zone for civil time, version 1, misfire and overlap. Ask about material ambiguity before saving. Creation does not run immediately. A successful result contains the authoritative task and receipt. If outcome is unknown, call scheduled_task_receipt with the returned requestId; never retry creation with a new tool call.",
            json!(schemars::schema_for!(Create)),
        ),
        definition(
            "scheduled_task_update",
            "Change only the requested objective or schedule of a task created in this conversation. Read the task first and supply its current expectedRevision. Omitted fields remain unchanged; accepted Runs keep their snapshot. A revision conflict requires refreshing and reconciling the user's intent, never silently overwriting. If outcome is unknown, inspect the returned requestId with scheduled_task_receipt before doing anything else.",
            json!(schemars::schema_for!(Update)),
        ),
        definition(
            "scheduled_task_control",
            "Control a task created in this conversation using its current expectedRevision. pause stops future triggers but lets the current Run continue; resume enables the schedule; runNow admits one Run without enabling a paused schedule; stopRun requires expectedRunId; delete retains history, disables future triggers and requests unsettled Runs to stop. Deleted tasks cannot be restored. A delete response with a nonterminal Run is still stopping. Unknown outcomes require scheduled_task_receipt with the returned requestId, never a new write.",
            json!(schemars::schema_for!(Control)),
        ),
        definition(
            "scheduled_task_receipt",
            "Inspect a previous schedule write's durable receipt using its returned requestId. Reads only receipts under the current desktop identity and source conversation. An empty result does not prove an uncertain write was rejected and is not permission to repeat it. Refresh the returned task for its current state.",
            json!({"type":"object","properties":{"requestId":{"type":"string","minLength":1,"maxLength":128}},"required":["requestId"],"additionalProperties":false}),
        ),
    ]
}

impl Engine {
    pub(crate) async fn schedule_tools_available(
        &self,
        cell: &Cell,
        config: &EffectiveConfig,
        source: &Thread,
    ) -> bool {
        !config.read_only && self.schedule_source_host(cell, source).await.is_ok()
    }

    async fn schedule_source_host(
        &self,
        cell: &Cell,
        source: &Thread,
    ) -> Result<Arc<dyn tools::DynamicToolHost>> {
        if source.parent_thread_id.is_some()
            || source.goal_owner.is_some()
            || source.is_side()
            || cell.handoff_worker.load(Ordering::Acquire)
            || cell.research
            || source.source == "nativeTaskAgent"
            || source.goals.goal.as_ref().is_some_and(|goal| {
                goal.status == GoalStatus::Active || goal.settling || goal.active_turn_id.is_some()
            })
            || source
                .desktop
                .as_ref()
                .is_none_or(|d| d.archived || d.workflow_run.is_some() || d.configuration.read_only)
        {
            return Err(invalid("TASK_PERMISSION_DENIED"));
        }
        if let Some(goal) = &source.goals.goal
            && self.is_desktop_schedule_goal(&goal.id).await?
        {
            return Err(invalid("TASK_PERMISSION_DENIED"));
        }
        let tasks = self.task_modes.state.lock().await;
        if !matches!(
            thread_ownership(source, &tasks, None),
            areal_protocol::desktop::ThreadOwnership::Ordinary
        ) || tasks.tasks.values().any(|task| {
            task.mode != TaskMode::Foreground
                && (task.thread_id.as_deref() == Some(source.id.as_str())
                    || task
                        .runs
                        .iter()
                        .any(|run| run.thread_id.as_deref() == Some(source.id.as_str())))
        }) {
            return Err(invalid("TASK_PERMISSION_DENIED"));
        }
        drop(tasks);
        let host = cell
            .bindings
            .read()
            .await
            .host
            .clone()
            .ok_or_else(|| invalid("TASK_PERMISSION_DENIED"))?;
        if !self.host_current(&host).await {
            return Err(invalid("TASK_PERMISSION_DENIED"));
        }
        Ok(host)
    }

    pub(super) async fn validate_schedule_source(
        &self,
        owner: &str,
        request: &TaskCreate,
    ) -> Result<()> {
        let Some(source_id) = &request.source_thread_id else {
            return Ok(());
        };
        if request.mode != TaskMode::Scheduled || request.thread_id.as_ref() == Some(source_id) {
            return Err(invalid(
                "scheduled sources require a separate execution anchor",
            ));
        }
        let source = self.cell(source_id).await?;
        let source_thread = source.state.lock().await.thread.clone();
        let host = self.schedule_source_host(&source, &source_thread).await?;
        if host.identity() != owner {
            return Err(invalid("TASK_PERMISSION_DENIED"));
        }
        let source_cwd = source.state.lock().await.thread.cwd.clone();
        let anchor = self
            .cell(
                request
                    .thread_id
                    .as_deref()
                    .ok_or_else(|| invalid("threadId required"))?,
            )
            .await?;
        if anchor.state.lock().await.thread.cwd != source_cwd {
            return Err(invalid(
                "source and execution anchor must share a workspace",
            ));
        }
        let anchor_host = anchor
            .bindings
            .read()
            .await
            .host
            .clone()
            .ok_or_else(|| invalid("TASK_PERMISSION_DENIED"))?;
        if anchor_host.id() != host.id() || !self.host_current(&anchor_host).await {
            return Err(invalid("TASK_PERMISSION_DENIED"));
        }
        Ok(())
    }

    async fn schedule_source_task(&self, owner: &str, source: &str, task_id: &str) -> Result<Task> {
        let task = self.task_read(task_id).await?;
        if task.owner != owner || task.source_thread_id.as_deref() != Some(source) {
            return Err(invalid("TASK_PERMISSION_DENIED"));
        }
        Ok(task)
    }

    pub(crate) async fn scheduled_task_tool(
        self: &Arc<Self>,
        cell: &Cell,
        turn_id: &str,
        call_id: &str,
        tool: &str,
        args: &Value,
    ) -> Value {
        let source = cell.id.clone();
        let request_id = format!(
            "schedule:{}",
            desktop::digest(&(&source, turn_id, call_id)).unwrap()
        );
        let method = match tool {
            "scheduled_task_create" => "create",
            "scheduled_task_update" => "update",
            "scheduled_task_control" => args["action"].as_str().unwrap_or("control"),
            _ => "read",
        };
        let receipt = json!({"requestId":request_id,"method":format!("areal/task/{method}")});
        let result = async {
            {
                let state = cell.state.lock().await;
                let config = state
                    .thread
                    .turns
                    .iter()
                    .find(|t| t.id == turn_id)
                    .and_then(|t| t.configuration.as_ref())
                    .ok_or(Error::Conflict)?;
                if config.read_only
                    || config
                        .tool_allowlist
                        .as_ref()
                        .is_some_and(|list| !list.iter().any(|name| name == tool))
                {
                    return Err(invalid("TASK_PERMISSION_DENIED"));
                }
            }
            let source_thread = cell.state.lock().await.thread.clone();
            let host = self.schedule_source_host(cell, &source_thread).await?;
            let owner = host.identity().to_owned();
            if tool == "scheduled_task_list" {
                let tasks = if let Some(task_id) = args["taskId"].as_str() {
                    vec![self.schedule_source_task(&owner, &source, task_id).await?]
                } else {
                    self.task_list_for_threads(None)
                        .await?
                        .into_iter()
                        .filter(|task| {
                            task.owner == owner && task.source_thread_id.as_deref() == Some(&source)
                        })
                        .collect()
                };
                return Ok(json!({"tasks":tasks.iter().map(summary).collect::<Vec<_>>()}));
            }
            if tool == "scheduled_task_receipt" {
                let id = args["requestId"]
                    .as_str()
                    .ok_or_else(|| invalid("requestId required"))?;
                let mut receipts = Vec::new();
                for record in self.task_receipts(&owner, id).await? {
                    if let Some(task_id) = record["taskId"].as_str()
                        && self
                            .schedule_source_task(&owner, &source, task_id)
                            .await
                            .is_ok()
                    {
                        receipts.push(record);
                    }
                }
                return Ok(json!({"receipts":receipts,"retention":"taskLifetime"}));
            }
            let task = match tool {
                "scheduled_task_create" => {
                    let input: Create = serde_json::from_value(args.clone()).map_err(invalid)?;
                    let previous = self
                        .task_receipts(&owner, &request_id)
                        .await?
                        .into_iter()
                        .find(|record| record["method"] == "areal/task/create");
                    let anchor_id = if let Some(record) = previous {
                        record["result"]["threadId"]
                            .as_str()
                            .ok_or_else(|| {
                                Error::Storage("schedule receipt has no execution anchor".into())
                            })?
                            .to_owned()
                    } else {
                        if input.objective.trim().is_empty()
                            || input.objective.chars().count() > 4000
                        {
                            return Err(invalid("objective must contain 1..4000 characters"));
                        }
                        schedule::resolve(input.schedule_v2.clone(), self.schedule_now())?;
                        let cwd = cell.state.lock().await.thread.cwd.clone();
                        let anchor = self
                            .create_configured(
                                owner.clone(),
                                ThreadStart {
                                    request_id: format!("anchor:{request_id}"),
                                    cwd: Some(cwd),
                                    agent_profile: None,
                                    model: None,
                                    parameters: Default::default(),
                                    dynamic_tools: vec![],
                                    options: None,
                                    admission_guard: Some(ThreadStartAdmissionGuard {
                                        ordinary_session: true,
                                    }),
                                },
                                host.clone(),
                            )
                            .await?;
                        anchor.id
                    };
                    self.task_create(
                        owner,
                        TaskCreate {
                            request_id: request_id.clone(),
                            mode: TaskMode::Scheduled,
                            objective: input.objective,
                            source_thread_id: Some(source),
                            thread_id: Some(anchor_id),
                            interaction_mode: Some(InteractionMode::Interactive),
                            schedule: None,
                            schedule_v2: Some(input.schedule_v2),
                            token_budget: None,
                            max_turns: None,
                            max_active_seconds: None,
                        },
                    )
                    .await?
                }
                "scheduled_task_update" => {
                    let input: Update = serde_json::from_value(args.clone()).map_err(invalid)?;
                    self.schedule_source_task(&owner, &source, &input.task_id)
                        .await?;
                    self.task_update(
                        owner,
                        TaskUpdate {
                            request_id: request_id.clone(),
                            task_id: input.task_id,
                            expected_revision: input.expected_revision,
                            objective: input.objective,
                            schedule: None,
                            schedule_v2: input.schedule_v2,
                        },
                    )
                    .await?
                }
                "scheduled_task_control" => {
                    let input: Control = serde_json::from_value(args.clone()).map_err(invalid)?;
                    self.schedule_source_task(&owner, &source, &input.task_id)
                        .await?;
                    if matches!(input.action, Action::RunNow) {
                        match self
                            .task_run_now(
                                owner,
                                TaskRunNow {
                                    request_id: request_id.clone(),
                                    task_id: input.task_id.clone(),
                                    expected_revision: input.expected_revision,
                                },
                            )
                            .await?
                        {
                            TaskRunNowAdmission::Accepted(_) => {
                                self.task_summary_for_threads(&input.task_id, None).await?
                            }
                            TaskRunNowAdmission::ActiveRun { .. } => {
                                return Err(invalid("activeRun"));
                            }
                        }
                    } else {
                        self.task_control(
                            owner,
                            input.action.method().into(),
                            TaskControl {
                                request_id: request_id.clone(),
                                task_id: input.task_id,
                                expected_revision: input.expected_revision,
                                expected_run_id: input.expected_run_id,
                            },
                        )
                        .await?
                    }
                }
                _ => return Err(invalid("unknown schedule tool")),
            };
            Ok(json!({"task":task,"receipt":receipt}))
        }
        .await;
        match result {
            Ok(value) => value,
            Err(error) => {
                let unknown = matches!(error, Error::Storage(_) | Error::OperationOutcome(_));
                let reason = match &error {
                    Error::Conflict => "REVISION_CONFLICT",
                    Error::Invalid(message) if message == "TASK_PERMISSION_DENIED" => {
                        "PERMISSION_DENIED"
                    }
                    Error::NotFound => "NOT_FOUND",
                    _ if unknown => "UNKNOWN",
                    _ => "REJECTED",
                };
                json!({"error":{"reason":reason,"message":error.to_string(),
                    "outcome":{"kind":if unknown {"unknown"} else {"rejected"}},
                    "recovery":if unknown {json!({"kind":"readReceipt","tool":"scheduled_task_receipt","requestId":request_id,"instruction":"Do not repeat the write with another tool call, even if its receipt is not yet available."})} else {json!({"kind":"none"})}},"receipt":receipt})
            }
        }
    }
}
