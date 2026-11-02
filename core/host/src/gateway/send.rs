use super::*;
use serde::Deserialize;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Message {
    thread_id: String,
    expected_config_revision: u64,
    text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    enqueue: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_turn_id: Option<String>,
}
#[derive(Serialize)]
struct Semantic<'a> {
    method: &'a str,
    #[serde(flatten)]
    params: &'a Message,
}
impl Session {
    pub(super) async fn send_session(
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
        ensure!(
            request["params"]
                .get("enqueue")
                .is_none_or(Value::is_boolean)
                && request["params"]
                    .get("expectedTurnId")
                    .is_none_or(Value::is_string),
            "INVALID_PARAMS"
        );
        let mut params: Message =
            serde_json::from_value(request["params"].clone()).context("INVALID_PARAMS")?;
        ensure!(
            !params.thread_id.is_empty()
                && params.thread_id.len() <= 128
                && params.expected_config_revision <= 9_007_199_254_740_991
                && !params.text.trim().is_empty()
                && params.text.len() <= 64 * 1024
                && params
                    .expected_turn_id
                    .as_ref()
                    .is_none_or(|id| id.len() <= 128),
            "INVALID_PARAMS"
        );
        params.expected_turn_id = params.expected_turn_id.filter(|id| !id.is_empty());
        let command = text(request, "commandId")?.to_ascii_lowercase();
        ensure!(command.len() == 36, "INVALID_PARAMS");
        uuid::Uuid::parse_str(&command).map_err(|_| fail("INVALID_PARAMS"))?;
        let digest = areal_local_service::storage::digest(&serde_json::to_vec(&Semantic {
            method: "session.send",
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
            .admit_send(project, generation, request, &params, &command, &digest)
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
    async fn admit_send(
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
        let enqueue = params.enqueue == Some(true);
        let method = if enqueue {
            "areal/turn/enqueue"
        } else {
            "areal/turn/start"
        };
        ensure!(
            caps["features"][if enqueue {
                "turnEnqueueAdmissionGuard"
            } else {
                "turnStartAdmissionGuard"
            }] == true
                && caps["features"]["atomicObserveOwnership"] == true
                && caps["features"]["threadCreationJournal"]["binding"].is_object()
                && caps["methods"]
                    .as_array()
                    .is_some_and(|methods| [method, "areal/request/read"]
                        .iter()
                        .all(|required| methods.iter().any(|method| method == required))),
            "CORE_INCOMPATIBLE"
        );
        let (native, _, _observation) = self
            .host
            .schedules
            .connections
            .remote_observe(&self.host, &id, generation, &params.thread_id)
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
                project.to_owned(),
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
        if enqueue {
            ensure!(
                state["activeTurnId"]
                    .as_str()
                    .is_some_and(|turn| Some(turn) == params.expected_turn_id.as_deref()),
                "TARGET_CHANGED"
            );
        } else {
            ensure!(
                state["activeTurnId"].is_null() && state["status"] == "idle",
                "TURN_BUSY"
            );
            ensure!(state["queue"]["pendingCount"] == 0, "TARGET_CHANGED");
        }
        ensure!(
            state["configRevision"] == params.expected_config_revision,
            "TARGET_CHANGED"
        );
        let operation = uuid::Uuid::new_v4().to_string();
        let mut guard =
            json!({"ordinarySession":true,"configRevision":params.expected_config_revision});
        if enqueue {
            guard["expectedTurnId"] = json!(params.expected_turn_id);
        }
        let native: areal_protocol::desktop::TurnStart = serde_json::from_value(
            json!({"requestId":operation,"threadId":params.thread_id,"input":[{"type":"text","text":params.text}],"expectedConfigRevision":params.expected_config_revision,"admissionGuard":guard}),
        )?;
        let native_digest = areal_local_service::storage::digest(&serde_json::to_vec(&native)?);
        let native = serde_json::to_value(native)?;
        let record = json!({"method":method,"operationId":operation,"params":native,"nativeDigest":native_digest,"coreScope":{"serviceId":scope.0,"generation":scope.1,"connectionId":scope.2,"storeBinding":caps["features"]["threadCreationJournal"]["binding"]},"threadId":params.thread_id,"remote":{"hostId":self.host_peer,"devicePeerId":self.peer,"projectId":project,"commandId":command,"method":"session.send","capability":"submit","admittedGrantRevision":self.grant["revision"],"semanticDigest":digest,"target":{"threadId":params.thread_id,"expectedConfigRevision":params.expected_config_revision}}});
        let (revision, mut snapshot) = self.host.journal.native_snapshot(&id)?;
        ensure!(
            snapshot["pending"].as_array().unwrap().len()
                + snapshot["outcomes"].as_object().unwrap().len()
                < 4096,
            "CAPACITY_EXCEEDED"
        );
        ensure!(
            !snapshot["pending"].as_array().unwrap().iter().any(|entry| {
                let settled = entry["remote"].is_object()
                    && entry["operationId"].as_str().is_some_and(|id| {
                        snapshot["outcomes"]
                            .get(id)
                            .is_some_and(|outcome| outcome["remote"].is_object())
                    });
                entry["params"]["threadId"] == params.thread_id
                    && !remote_control(entry)
                    && !settled
            }),
            "SUBMISSION_UNKNOWN"
        );
        self.authorize(Some(project), "submit")?;
        snapshot["pending"]
            .as_array_mut()
            .unwrap()
            .push(record.clone());
        self.host.journal.native_replace(&id, revision, snapshot)?;
        let _sending = gateway_owner::push::sending(&self.host, &record);
        let response = self
            .host
            .schedules
            .connections
            .remote_request(
                &self.host, &id, &scope.0, generation, &scope.2, method, native,
            )
            .await;
        let mut settled = record.clone();
        match response {
            Ok(result) => {
                if !Self::send_receipt(&mut settled, &result) {
                    self.authorize(Some(project), "submit")?;
                    return Ok(Self::command_view(Some(&record), command));
                }
            }
            Err(error) => {
                let Some(rejected) = error
                    .downcast_ref::<crate::server::schedule_connection::RpcFailure>()
                    .filter(|failure| {
                        matches!(
                            failure.0["data"]["outcome"]["kind"].as_str(),
                            Some("rejected" | "noMutation")
                        )
                    })
                else {
                    self.authorize(Some(project), "submit")?;
                    return Ok(Self::command_view(Some(&record), command));
                };
                settled["admissionState"] = json!("rejected");
                settled["error"] = if rejected.0["code"] == -32602
                    && rejected.0["message"]
                        .as_str()
                        .is_some_and(|message| message.contains("UNSUPPORTED_PROFILE:"))
                {
                    json!({"code":"UNSUPPORTED_PROFILE","coreCode":-32602})
                } else {
                    rejected.0.clone()
                };
            }
        }
        let settled = self.settle_command(&id, settled)?;
        gateway_owner::push::track(&self.host, &id, project, &settled, false);
        self.authorize(Some(project), "submit")?;
        Ok(Self::command_view(Some(&settled), command))
    }
    fn send_receipt(record: &mut Value, result: &Value) -> bool {
        if record["method"] == "areal/turn/enqueue" {
            let Some(queue) = result["queueItemId"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 128)
            else {
                return false;
            };
            record["receipt"] = json!({"queueItemId":queue});
        } else {
            let Some(turn) = result["turn"]["id"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 128)
            else {
                return false;
            };
            record["turnId"] = json!(turn);
        }
        record["admissionState"] = json!("accepted");
        true
    }
    pub(super) async fn reconcile_send(&self, project: &str, record: &Value) -> Result<Value> {
        if record.get("admissionState").is_some() {
            return Ok(record.clone());
        }
        self.authorize(Some(project), "submit")?;
        let id = self.project_id(project)?;
        let Ok(scope) = self
            .host
            .schedules
            .connections
            .shared_identity(&self.host, &id)
        else {
            return Ok(record.clone());
        };
        if record["coreScope"]["serviceId"] != scope.0 {
            return Ok(record.clone());
        }
        let result: Result<Value> = async {
            let caps = self
                .rpc(project, &scope.1, "areal/capabilities", json!({}))
                .await?;
            let binding = &caps["features"]["threadCreationJournal"]["binding"];
            let original = &record["coreScope"]["storeBinding"];
            ensure!(
                original["identity"].is_string()
                    && original["journalEpoch"].is_string()
                    && binding["identity"] == original["identity"]
                    && binding["journalEpoch"] == original["journalEpoch"],
                "RESYNC_REQUIRED"
            );
            let thread = record["params"]["threadId"]
                .as_str()
                .context("RESOURCE_UNAVAILABLE")?;
            let operation = record["params"]["requestId"]
                .as_str()
                .context("RESOURCE_UNAVAILABLE")?;
            let read = self
                .rpc(
                    project,
                    &scope.1,
                    "areal/request/read",
                    json!({"threadId":thread,"requestId":operation}),
                )
                .await?;
            ensure!(
                self.host
                    .schedules
                    .connections
                    .shared_identity(&self.host, &id)?
                    == scope,
                "RESYNC_REQUIRED"
            );
            let candidates = read["data"]
                .as_array()
                .context("RESOURCE_UNAVAILABLE")?
                .iter()
                .filter(|receipt| {
                    receipt["requestId"] == operation
                        && receipt["method"] == record["method"]
                        && receipt["digest"] == record["nativeDigest"]
                        && receipt["identity"] == original["identity"]
                        && receipt["threadId"] == thread
                        && receipt["operation"]["requestId"] == operation
                        && receipt["operation"]["method"] == record["method"]
                        && receipt["operation"]["target"]
                            == json!({"kind":"thread","threadId":thread})
                        && receipt["status"] == "completed"
                })
                .collect::<Vec<_>>();
            ensure!(candidates.len() == 1, "RESOURCE_UNAVAILABLE");
            Ok(candidates[0]["result"].clone())
        }
        .await;
        self.authorize(Some(project), "submit")?;
        let Ok(result) = result else {
            return Ok(record.clone());
        };
        let mut settled = record.clone();
        if !Self::send_receipt(&mut settled, &result) {
            return Ok(record.clone());
        }
        let settled = self.settle_command(&id, settled)?;
        gateway_owner::push::track(&self.host, &id, project, &settled, true);
        Ok(settled)
    }
}

fn remote_control(entry: &Value) -> bool {
    let params = &entry["params"];
    let remote = &entry["remote"];
    let target = &remote["target"];
    if !entry["operationId"].is_string() {
        return false;
    }
    match entry["method"].as_str() {
        Some("turn/interrupt") => {
            remote["method"] == "turn.stop"
                && remote["capability"] == "interrupt"
                && params["threadId"].is_string()
                && params["turnId"].is_string()
                && target["threadId"] == params["threadId"]
                && target["expectedTurnId"] == params["turnId"]
        }
        Some("areal/interaction/respond") => {
            remote["method"] == "interaction.respond"
                && remote["capability"] == "answer"
                && ["threadId", "turnId", "requestId"]
                    .iter()
                    .all(|key| params[key].is_string())
                && target["threadId"] == params["threadId"]
                && target["turnId"] == params["turnId"]
                && target["interactionId"] == params["requestId"]
        }
        Some("areal/channel/reply") => {
            remote["method"] == "task.question.reply"
                && remote["capability"] == "answer"
                && params["requestId"] == entry["operationId"]
                && ["taskId", "runId", "questionId"]
                    .iter()
                    .all(|key| params[key].is_string() && target[key] == params[key])
        }
        Some("areal/task/pause") => {
            remote["method"] == "task.pause"
                && remote["capability"] == "pauseTask"
                && params["requestId"] == entry["operationId"]
                && ["taskId", "expectedRunId"]
                    .iter()
                    .all(|key| params[key].is_string() && target[key] == params[key])
                && params["expectedRevision"].as_i64().is_some_and(|revision| {
                    (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&revision)
                })
                && target["expectedRevision"] == params["expectedRevision"]
        }
        _ => false,
    }
}
