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
fn validate(params: &Message) -> Result<()> {
    ensure!(
        !params.thread_id.is_empty()
            && params.thread_id.len() <= 128
            && params.operation == "configure"
            && params.expected_revision <= 9_007_199_254_740_991
            && exact(&params.values, &["model", "parameters", "options"])
            && !params.values.as_object().unwrap().is_empty(),
        "INVALID_PARAMS"
    );
    let values = &params.values;
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
    pub(super) async fn configure_session(
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
        validate(&params)?;
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
            .admit_configure(project, generation, request, &params, &command, &digest)
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
    async fn admit_configure(
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
        ensure!(
            caps["features"]["atomicObserveOwnership"] == true
                && caps["features"]["threadCreationJournal"]["binding"].is_object()
                && caps["methods"].as_array().is_some_and(|methods| [
                    "areal/thread/configure",
                    "areal/thread/inspect",
                    "areal/request/read"
                ]
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
        let (native, _, _observation) = self
            .host
            .schedules
            .connections
            .remote_observe(&self.host, &id, generation, &params.thread_id)
            .await?;
        let inspection = self
            .rpc(
                project,
                generation,
                "areal/thread/inspect",
                json!({"threadId":params.thread_id}),
            )
            .await?;
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
        ensure!(
            state["ownership"]["kind"] == "ordinary",
            "TASK_CONTROL_REQUIRED"
        );
        ensure!(
            state["activeTurnId"].is_null()
                && state["configRevision"] == params.expected_revision
                && inspection["configuration"]["revision"] == params.expected_revision,
            "TARGET_CHANGED"
        );
        let operation = uuid::Uuid::new_v4().to_string();
        let mut native = json!({"requestId":operation,"threadId":params.thread_id,"expectedRevision":params.expected_revision});
        if let Some(model) = params.values.get("model") {
            native["model"] = model.clone();
        }
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
        let native: areal_protocol::desktop::ConfigureThread =
            serde_json::from_value(native).context("INVALID_PARAMS")?;
        let native_digest = areal_local_service::storage::digest(&serde_json::to_vec(&native)?);
        let native = serde_json::to_value(native)?;
        let record = json!({"method":"areal/thread/configure","operationId":operation,"params":native,"nativeDigest":native_digest,"coreScope":{"serviceId":scope.0,"generation":scope.1,"connectionId":scope.2,"storeBinding":caps["features"]["threadCreationJournal"]["binding"]},"threadId":params.thread_id,"remote":{"hostId":self.host_peer,"devicePeerId":self.peer,"projectId":project,"commandId":command,"method":"session.control","capability":"submit","admittedGrantRevision":self.grant["revision"],"semanticDigest":digest,"target":{"threadId":params.thread_id,"operation":"configure","expectedRevision":params.expected_revision}}});
        let (revision, mut snapshot) = self.host.journal.native_snapshot(&id)?;
        ensure!(
            snapshot["pending"].as_array().unwrap().len()
                + snapshot["outcomes"].as_object().unwrap().len()
                < 4096,
            "CAPACITY_EXCEEDED"
        );
        ensure!(
            !snapshot["pending"].as_array().unwrap().iter().any(
                |entry| entry["params"]["threadId"] == params.thread_id
                    && !send::remote_control(entry)
                    && !entry["operationId"]
                        .as_str()
                        .is_some_and(|id| snapshot["outcomes"]
                            .get(id)
                            .is_some_and(|outcome| outcome["remote"].is_object()))
            ),
            "SUBMISSION_UNKNOWN"
        );
        snapshot["pending"]
            .as_array_mut()
            .unwrap()
            .push(record.clone());
        self.host.journal.native_replace(&id, revision, snapshot)?;
        let response = self
            .host
            .schedules
            .connections
            .remote_request(
                &self.host,
                &id,
                &scope.0,
                generation,
                &scope.2,
                "areal/thread/configure",
                native,
            )
            .await;
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
