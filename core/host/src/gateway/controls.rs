use super::*;
use serde::Deserialize;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Message {
    thread_id: String,
    operation: String,
    expected_revision: u64,
    values: Value,
}
#[derive(Serialize)]
struct Semantic<'a> {
    method: &'a str,
    #[serde(flatten)]
    params: &'a Message,
}
fn validate(params: &Message, text_bytes: usize, gui_write: bool) -> Result<()> {
    ensure!(
        !params.thread_id.is_empty()
            && params.thread_id.len() <= 128
            && params.expected_revision <= 9_007_199_254_740_991
            && method(&params.operation).is_some(),
        "INVALID_PARAMS"
    );
    let fields: &[&str] = match params.operation.as_str() {
        "configure" => &["model", "parameters", "options"],
        "goalCreate" => &["objective", "inferLimits"],
        "goalPause" | "goalResume" | "goalClear" => &["goalId"],
        "queueUpdate" => &["queueItemId", "text"],
        "queueRemove" => &["queueItemId"],
        "queueReorder" => &["queueItemIds"],
        "queuePause" | "queueResume" => &[],
        "queueSteer" => &["queueItemId", "expectedTurnId"],
        "steer" if gui_write => &[
            "text",
            "expectedTurnId",
            "attachments",
            "conversationQuotes",
            "mcpContent",
        ],
        "steer" => &["text", "expectedTurnId"],
        _ => unreachable!(),
    };
    ensure!(exact(&params.values, fields), "INVALID_PARAMS");
    let values = &params.values;
    if params.operation != "configure" {
        if params.operation == "goalCreate" {
            let objective = values["objective"].as_str().context("INVALID_PARAMS")?;
            ensure!(
                !objective.trim().is_empty()
                    && objective.len() <= text_bytes
                    && objective.chars().count() <= 4000
                    && values.get("inferLimits").is_none_or(Value::is_boolean),
                "INVALID_PARAMS"
            );
        }
        for (operations, key) in [
            (&["goalPause", "goalResume", "goalClear"][..], "goalId"),
            (
                &["queueUpdate", "queueRemove", "queueSteer"][..],
                "queueItemId",
            ),
            (&["steer", "queueSteer"][..], "expectedTurnId"),
        ] {
            if operations.contains(&params.operation.as_str()) {
                text(values, key)?;
            }
        }
        if params.operation == "steer" && gui_write {
            let text = values
                .get("text")
                .map(|v| v.as_str().context("INVALID_PARAMS"))
                .transpose()?
                .unwrap_or_default();
            ensure!(text.len() <= text_bytes, "INVALID_PARAMS");
            super::send::rich_message_input(text, values).context("INVALID_PARAMS")?;
        } else if matches!(params.operation.as_str(), "queueUpdate" | "steer") {
            ensure!(
                values["text"]
                    .as_str()
                    .is_some_and(|text| !text.trim().is_empty() && text.len() <= text_bytes),
                "INVALID_PARAMS"
            );
        }
        if params.operation == "queueReorder" {
            let items = values["queueItemIds"]
                .as_array()
                .context("INVALID_PARAMS")?;
            let mut unique = std::collections::BTreeSet::new();
            ensure!(
                items.len() <= 128
                    && items.iter().all(|item| item
                        .as_str()
                        .is_some_and(|id| !id.is_empty() && id.len() <= 128 && unique.insert(id))),
                "INVALID_PARAMS"
            );
        }
        return Ok(());
    }
    ensure!(!values.as_object().unwrap().is_empty(), "INVALID_PARAMS");
    if let Some(model) = values.get("model").filter(|model| !model.is_null()) {
        ensure!(exact(model, &["providerId", "modelId"]), "INVALID_PARAMS");
        text(model, "providerId")?;
        text(model, "modelId")?;
    }
    if let Some(parameters) = values.get("parameters") {
        ensure!(
            exact(parameters, &["reasoningEffort"])
                && matches!(
                    parameters["reasoningEffort"].as_str(),
                    Some(
                        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
                    )
                ),
            "INVALID_PARAMS"
        );
    }
    if let Some(options) = values.get("options") {
        ensure!(
            exact(
                options,
                &[
                    "permissionPreset",
                    "readOnly",
                    "appendInstructions",
                    "approvalTools",
                    "preapprovedTools"
                ]
            ),
            "INVALID_PARAMS"
        );
        if let Some(preset) = options.get("permissionPreset") {
            ensure!(
                matches!(preset.as_str(), Some("ask" | "autoReview" | "fullAccess")),
                "INVALID_PARAMS"
            );
        }
        ensure!(
            options.get("readOnly").is_none_or(Value::is_boolean),
            "INVALID_PARAMS"
        );
        ensure!(
            options
                .get("appendInstructions")
                .is_none_or(|value| value.as_str().is_some_and(|value| value.len() <= 8192)),
            "INVALID_PARAMS"
        );
        for key in ["approvalTools", "preapprovedTools"] {
            ensure!(
                options
                    .get(key)
                    .is_none_or(
                        |value| value.as_array().is_some_and(|items| items.len() <= 128
                            && items.iter().all(|item| item
                                .as_str()
                                .is_some_and(|id| !id.is_empty() && id.len() <= 128)))
                    ),
                "INVALID_PARAMS"
            );
        }
    }
    Ok(())
}
impl Session {
    pub(super) async fn control_session(
        &self,
        project: &str,
        generation: &str,
        request: &Value,
    ) -> Result<Value> {
        ensure!(
            exact(
                &request["context"],
                &[
                    "projectId",
                    "gatewayGeneration",
                    "grantRevision",
                    "serviceGeneration"
                ]
            ),
            "INVALID_PARAMS"
        );
        let params: Message =
            serde_json::from_value(request["params"].clone()).context("INVALID_PARAMS")?;
        validate(&params, self.command_text_bytes(), self.gui_write)?;
        let command = text(request, "commandId")?.to_ascii_lowercase();
        uuid::Uuid::parse_str(&command).map_err(|_| fail("INVALID_PARAMS"))?;
        let digest = areal_local_service::storage::digest(&serde_json::to_vec(&Semantic {
            method: "session.control",
            params: &params,
        })?);
        self.authorize(Some(project), "submit")?;
        if let Some(record) = self.command_record(project, &command)? {
            ensure!(
                record["remote"]["semanticDigest"] == digest,
                "COMMAND_CONFLICT"
            );
            return self.command_result(project, Some(&record), &command).await;
        }
        let result = self
            .admit_control(project, generation, request, &params, &command, &digest)
            .await;
        if result.is_err() {
            self.authorize(Some(project), "submit")?;
            if let Some(record) = self.command_record(project, &command)? {
                ensure!(
                    record["remote"]["semanticDigest"] == digest,
                    "COMMAND_CONFLICT"
                );
                return self.command_result(project, Some(&record), &command).await;
            }
        }
        result
    }
    async fn admit_control(
        &self,
        project: &str,
        generation: &str,
        request: &Value,
        params: &Message,
        command: &str,
        digest: &str,
    ) -> Result<Value> {
        ensure!(
            request["context"]["gatewayGeneration"] == self.generation
                && request["context"]["grantRevision"] == self.grant["revision"]
                && request["context"]["serviceGeneration"] == generation,
            "RESYNC_REQUIRED"
        );
        let (id, _) = self.project(project)?;
        let scope = self
            .host
            .schedules
            .connections
            .shared_identity(&self.host, &id)?;
        let caps = self
            .rpc(project, generation, "areal/capabilities", json!({}))
            .await?;
        let method = method(&params.operation).unwrap();
        ensure!(
            caps["features"]["atomicObserveOwnership"] == true
                && caps["features"]["threadCreationJournal"]["binding"].is_object()
                && caps["methods"]
                    .as_array()
                    .is_some_and(|methods| [method, "areal/request/read"]
                        .iter()
                        .all(|required| methods.iter().any(|method| method == required))),
            "CORE_INCOMPATIBLE"
        );
        if params.values["options"].get("permissionPreset").is_some() {
            ensure!(
                caps["features"]["permissionPresets"] == true,
                "CORE_INCOMPATIBLE"
            );
        }
        let prepared = if params.operation == "steer" && self.uses_workbench_execution() {
            Some(
                self.host
                    .gateway
                    .workbench
                    .prepare_input(
                        &self.host,
                        &id,
                        &params.thread_id,
                        params.values["text"].as_str().unwrap_or_default(),
                    )
                    .await?,
            )
        } else {
            None
        };
        let (native, _, _observation) = self
            .host
            .schedules
            .connections
            .remote_observe(&self.host, &id, generation, &params.thread_id)
            .await?;
        let inspection = if params.operation == "configure" {
            self.rpc(
                project,
                generation,
                "areal/thread/inspect",
                json!({"threadId":params.thread_id}),
            )
            .await?
        } else {
            Value::Null
        };
        self.authorize(Some(project), "submit")?;
        if let Some(record) = self.command_record(project, command)? {
            ensure!(
                record["remote"]["semanticDigest"] == digest,
                "COMMAND_CONFLICT"
            );
            return self.command_result(project, Some(&record), command).await;
        }
        ensure!(
            self.host
                .schedules
                .connections
                .shared_identity(&self.host, &id)?
                == scope,
            "RESYNC_REQUIRED"
        );
        let state = projection::snapshot(
            &native["thread"],
            &native["ownership"],
            &[
                project.into(),
                scope.0.clone(),
                scope.1.clone(),
                params.thread_id.clone(),
            ],
            &caps["features"],
        )?;
        let own_goal = matches!(
            params.operation.as_str(),
            "goalPause" | "goalResume" | "goalClear"
        ) && self.goal_control_allowed(project, &native["thread"])?
            && state["goals"]["goal"]["id"] == params.values["goalId"];
        if matches!(
            params.operation.as_str(),
            "goalPause" | "goalResume" | "goalClear"
        ) {
            ensure!(own_goal, "TASK_CONTROL_REQUIRED");
        }
        ensure!(
            state["ownership"]["kind"] == "ordinary" || own_goal,
            "TASK_CONTROL_REQUIRED"
        );
        if params.operation == "configure" {
            ensure!(
                state["activeTurnId"].is_null()
                    && state["configRevision"] == params.expected_revision
                    && inspection["configuration"]["revision"] == params.expected_revision,
                "TARGET_CHANGED"
            );
        }
        if matches!(params.operation.as_str(), "steer" | "queueSteer") {
            ensure!(
                state["activeTurnId"] == params.values["expectedTurnId"],
                "TARGET_CHANGED"
            );
        }
        if params.operation == "queueUpdate" {
            let item = state["queue"]["items"]
                .as_array()
                .and_then(|items| {
                    items
                        .iter()
                        .find(|item| item["id"] == params.values["queueItemId"])
                })
                .context("TARGET_CHANGED")?;
            ensure!(
                item["truncated"] == false && item["hasAttachments"] == false,
                "TARGET_CHANGED"
            );
        }
        if params.operation.starts_with("goal") {
            ensure!(
                state["goals"]["revision"] == params.expected_revision,
                "TARGET_CHANGED"
            );
        }
        if params.operation.starts_with("queue") {
            ensure!(
                state["queue"]["revision"] == params.expected_revision,
                "TARGET_CHANGED"
            );
        }
        let operation = uuid::Uuid::new_v4().to_string();
        let mut native = params.values.clone();
        if let Some(text) = prepared {
            native["text"] = json!(text);
        }
        native["threadId"] = json!(params.thread_id);
        if params.operation != "steer" {
            native["requestId"] = json!(operation);
            native["expectedRevision"] = json!(params.expected_revision);
        }
        if params.operation == "steer" {
            native["input"] = serde_json::to_value(super::send::rich_message_input(
                native["text"].as_str().unwrap_or_default(),
                &params.values,
            )?)?;
            for key in ["text", "attachments", "conversationQuotes", "mcpContent"] {
                native.as_object_mut().unwrap().remove(key);
            }
        } else if let Some(text) = native.get("text").and_then(Value::as_str) {
            native["input"] = serde_json::to_value(vec![areal_protocol::Input::text(text)])?;
            native.as_object_mut().unwrap().remove("text");
        }
        if params.operation == "configure" {
            for key in ["parameters", "options"] {
                if let Some(values) = params.values.get(key) {
                    let mut merged = inspection["configuration"][key]
                        .as_object()
                        .context("CORE_INCOMPATIBLE")?
                        .clone();
                    merged.extend(values.as_object().unwrap().clone());
                    native[key] = Value::Object(merged);
                }
            }
            native = serde_json::to_value(
                serde_json::from_value::<areal_protocol::desktop::ConfigureThread>(native)
                    .context("INVALID_PARAMS")?,
            )?;
        } else if params.operation == "goalCreate" {
            native = serde_json::to_value(
                serde_json::from_value::<areal_protocol::goals::GoalCreate>(native)
                    .context("INVALID_PARAMS")?,
            )?;
        } else if matches!(
            params.operation.as_str(),
            "goalPause" | "goalResume" | "goalClear"
        ) {
            native = serde_json::to_value(
                serde_json::from_value::<areal_protocol::goals::GoalControl>(native)
                    .context("INVALID_PARAMS")?,
            )?;
        } else if params.operation == "queueSteer" {
            native = serde_json::to_value(
                serde_json::from_value::<areal_protocol::desktop::QueueSteer>(native)
                    .context("INVALID_PARAMS")?,
            )?;
        }
        let mut execution = if params.operation == "steer" && self.uses_workbench_execution() {
            self.host
                .gateway
                .workbench
                .prepare_execution(&self.host, &self.connection, &id, method, native.clone())
                .await?
        } else {
            None
        };
        if let Some(prepared) = &execution {
            ensure!(prepared.params == native, "INVALID_RESPONSE");
            self.authorize(Some(project), "submit")?;
            if let Some(record) = self.command_record(project, command)? {
                ensure!(
                    record["remote"]["semanticDigest"] == digest,
                    "COMMAND_CONFLICT"
                );
                return self.command_result(project, Some(&record), command).await;
            }
            ensure!(
                self.host
                    .schedules
                    .connections
                    .shared_identity(&self.host, &id)?
                    == scope,
                "RESYNC_REQUIRED"
            );
        }
        let native_digest = native_digest(method, &native)?;
        let record = json!({"method":method,"operationId":operation,"params":native,"nativeDigest":native_digest,"coreScope":{"serviceId":scope.0,"generation":scope.1,"connectionId":scope.2,"storeBinding":caps["features"]["threadCreationJournal"]["binding"]},"threadId":params.thread_id,"remote":{"hostId":self.host_peer,"devicePeerId":self.peer,"projectId":project,"commandId":command,"method":"session.control","capability":"submit","admittedGrantRevision":self.grant["revision"],"semanticDigest":digest,"target":{"threadId":params.thread_id,"operation":params.operation,"expectedRevision":params.expected_revision}}});
        let mut record = record;
        if native_digest.is_none() {
            record.as_object_mut().unwrap().remove("nativeDigest");
        }
        ensure!(
            serde_json::to_vec(&record)?.len() <= self.command_pending_bytes(),
            "LIMIT_EXCEEDED"
        );
        self.host.journal.native_preflight(&id, &record, true)?;
        self.host
            .schedules
            .connections
            .workbench_core_admit(&self.host, &id, None, method, &record["params"])
            .await?;
        let (revision, snapshot) = self.host.journal.native_snapshot(&id)?;
        self.host
            .journal
            .native_admit(&id, revision, snapshot, record.clone(), true)?;
        let response = if let Some(prepared) = &mut execution {
            prepared.dispatch().await
        } else {
            self.host
                .schedules
                .connections
                .remote_request(
                    &self.host,
                    &id,
                    (&scope.0, generation, &scope.2),
                    method,
                    native,
                )
                .await
        };
        let mut settled = record.clone();
        match response {
            Ok(result) => {
                if !Self::submission_receipt(&mut settled, &result) {
                    return self.command_result(project, Some(&record), command).await;
                }
            }
            Err(error) => {
                let Some(failure) = error
                    .downcast_ref::<crate::server::schedule_connection::RpcFailure>()
                    .filter(|failure| {
                        matches!(
                            failure.0["data"]["outcome"]["kind"].as_str(),
                            Some("rejected" | "noMutation")
                        )
                    })
                else {
                    return self.command_result(project, Some(&record), command).await;
                };
                settled["admissionState"] = json!("rejected");
                settled["error"] = failure.0.clone();
            }
        }
        let settled = self.settle_command(&id, settled)?;
        self.authorize(Some(project), "submit")?;
        Ok(Self::command_view(Some(&settled), command))
    }
}

pub(crate) fn method(operation: &str) -> Option<&'static str> {
    Some(match operation {
        "configure" => "areal/thread/configure",
        "goalCreate" => "areal/goal/create",
        "goalPause" => "areal/goal/pause",
        "goalResume" => "areal/goal/resume",
        "goalClear" => "areal/goal/clear",
        "queueUpdate" => "areal/queue/update",
        "queueRemove" => "areal/queue/remove",
        "queueReorder" => "areal/queue/reorder",
        "queuePause" => "areal/queue/pause",
        "queueResume" => "areal/queue/resume",
        "queueSteer" => "areal/queue/steer",
        "steer" => "turn/steer",
        _ => return None,
    })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueueEdit {
    request_id: String,
    thread_id: String,
    expected_revision: u64,
    queue_item_id: Option<String>,
    input: Option<Vec<areal_protocol::Input>>,
    queue_item_ids: Option<Vec<String>>,
}
pub(crate) fn native_digest(method: &str, params: &Value) -> Result<Option<String>> {
    let bytes = match method {
        "areal/thread/configure" => serde_json::to_vec(&serde_json::from_value::<
            areal_protocol::desktop::ConfigureThread,
        >(params.clone())?)?,
        "areal/goal/create" => serde_json::to_vec(&serde_json::from_value::<
            areal_protocol::goals::GoalCreate,
        >(params.clone())?)?,
        "areal/goal/pause" | "areal/goal/resume" | "areal/goal/clear" => serde_json::to_vec(&(
            serde_json::from_value::<areal_protocol::goals::GoalControl>(params.clone())?,
            Option::<areal_protocol::goals::GoalUpdate>::None,
        ))?,
        "areal/queue/steer" => serde_json::to_vec(&serde_json::from_value::<
            areal_protocol::desktop::QueueSteer,
        >(params.clone())?)?,
        "areal/queue/update"
        | "areal/queue/remove"
        | "areal/queue/reorder"
        | "areal/queue/pause"
        | "areal/queue/resume" => {
            let typed: QueueEdit = serde_json::from_value(params.clone())?;
            ensure!(
                !typed.request_id.is_empty()
                    && !typed.thread_id.is_empty()
                    && typed.expected_revision <= 9_007_199_254_740_991,
                "INVALID_PARAMS"
            );
            let valid = match method {
                "areal/queue/update" => {
                    typed.queue_item_id.is_some()
                        && typed.input.is_some()
                        && typed.queue_item_ids.is_none()
                }
                "areal/queue/remove" => {
                    typed.queue_item_id.is_some()
                        && typed.input.is_none()
                        && typed.queue_item_ids.is_none()
                }
                "areal/queue/reorder" => {
                    typed.queue_item_id.is_none()
                        && typed.input.is_none()
                        && typed.queue_item_ids.is_some()
                }
                _ => {
                    typed.queue_item_id.is_none()
                        && typed.input.is_none()
                        && typed.queue_item_ids.is_none()
                }
            };
            ensure!(valid, "INVALID_PARAMS");
            let mut original = params.clone();
            original.as_object_mut().unwrap().remove("requestId");
            serde_json::to_vec(&original)?
        }
        "turn/steer" => return Ok(None),
        _ => anyhow::bail!("INVALID_PARAMS"),
    };
    Ok(Some(areal_local_service::storage::digest(&bytes)))
}
pub(crate) fn apply_result(record: &mut Value, result: &Value) -> bool {
    let expected = record["remote"]["target"]["expectedRevision"]
        .as_u64()
        .and_then(|value| value.checked_add(1));
    let params = &record["params"];
    let valid = match record["method"].as_str() {
        Some("areal/thread/configure") => {
            expected.is_some() && result["revision"].as_u64() == expected
        }
        Some("areal/goal/create") => {
            expected.is_some()
                && result["revision"].as_u64() == expected
                && result["goal"]["id"]
                    .as_str()
                    .is_some_and(|id| !id.is_empty() && id.len() <= 128)
        }
        Some("areal/goal/pause" | "areal/goal/resume") => {
            expected.is_some()
                && result["revision"].as_u64() == expected
                && result["goal"]["id"] == params["goalId"]
        }
        Some("areal/goal/clear") => {
            expected.is_some()
                && result["revision"].as_u64() == expected
                && result["goal"].is_null()
        }
        Some("areal/queue/steer") => {
            expected.is_some()
                && result["queueRevision"].as_u64() == expected
                && result["queueItemId"] == params["queueItemId"]
                && result["turnId"] == params["expectedTurnId"]
                && result["itemId"].is_string()
        }
        Some(
            "areal/queue/update"
            | "areal/queue/remove"
            | "areal/queue/reorder"
            | "areal/queue/pause"
            | "areal/queue/resume",
        ) => expected.is_some() && result["revision"].as_u64() == expected,
        Some("turn/steer") => {
            result["turnId"].is_string() && result["turnId"] == params["expectedTurnId"]
        }
        _ => false,
    };
    if !valid {
        return false;
    }
    if record["method"] == "areal/goal/create" {
        record["receipt"] = json!({"goalId":result["goal"]["id"],"revision":result["revision"]});
    }
    record["admissionState"] = json!("accepted");
    true
}
impl Session {
    pub(super) fn goal_control_allowed(&self, project: &str, thread: &Value) -> Result<bool> {
        let Some(goal) = thread["goals"]["goal"]["id"].as_str() else {
            return Ok(false);
        };
        if !thread["parentThreadId"].is_null()
            || !thread["goalOwner"].is_null()
            || thread["source"] == "nativeTaskAgent"
        {
            return Ok(false);
        }
        let id = self.project_id(project)?;
        let (_, snapshot) = self.host.journal.native_snapshot(&id)?;
        Ok(snapshot["outcomes"]
            .as_object()
            .unwrap()
            .values()
            .any(|record| {
                let remote = &record["remote"];
                remote["hostId"] == self.host_peer
                    && remote["devicePeerId"] == self.peer
                    && remote["projectId"] == project
                    && remote["method"] == "session.control"
                    && remote["target"]["operation"] == "goalCreate"
                    && record["admissionState"] == "accepted"
                    && record["receipt"]["goalId"] == goal
            }))
    }
}
