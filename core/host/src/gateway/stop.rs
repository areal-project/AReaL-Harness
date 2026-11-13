use super::*;
use serde::Deserialize;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Message {
    thread_id: String,
    expected_turn_id: String,
}
#[derive(Serialize)]
struct Semantic<'a> {
    method: &'a str,
    #[serde(flatten)]
    params: &'a Message,
}
impl Session {
    pub(super) async fn stop_turn(
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
        ensure!(
            [&params.thread_id, &params.expected_turn_id]
                .iter()
                .all(|id| !id.is_empty() && id.len() <= 128),
            "INVALID_PARAMS"
        );
        let command = text(request, "commandId")?.to_ascii_lowercase();
        ensure!(command.len() == 36, "INVALID_PARAMS");
        uuid::Uuid::parse_str(&command).map_err(|_| fail("INVALID_PARAMS"))?;
        let digest = areal_local_service::storage::digest(&serde_json::to_vec(&Semantic {
            method: "turn.stop",
            params: &params,
        })?);
        self.authorize(Some(project), "interrupt")?;
        if let Some(record) = self.command_record(project, &command)? {
            ensure!(
                record["remote"]["semanticDigest"] == digest,
                "COMMAND_CONFLICT"
            );
            return self.command_result(project, Some(&record), &command).await;
        }
        let result = self
            .admit_stop(project, generation, request, &params, &command, &digest)
            .await;
        if result.is_err() {
            self.authorize(Some(project), "interrupt")?;
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
    async fn admit_stop(
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
                && self.project(project)?.1 == generation,
            "RESYNC_REQUIRED"
        );
        let id = self.project_id(project)?;
        let scope = self
            .host
            .schedules
            .connections
            .shared_identity(&self.host, &id)?;
        let caps = self
            .rpc(project, generation, "areal/capabilities", json!({}))
            .await?;
        ensure!(
            caps["features"]["turnInterruptAdmissionGuard"] == true
                && caps["features"]["atomicObserveOwnership"] == true
                && caps["methods"]
                    .as_array()
                    .is_some_and(|methods| methods.iter().any(|method| method == "turn/interrupt")),
            "CORE_INCOMPATIBLE"
        );
        let (native, _, _observation) = self
            .host
            .schedules
            .connections
            .remote_observe(&self.host, &id, generation, &params.thread_id)
            .await?;
        self.authorize(Some(project), "interrupt")?;
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
            state["activeTurnId"] == params.expected_turn_id,
            "TARGET_CHANGED"
        );
        let native = serde_json::to_value(areal_protocol::desktop::TurnInterrupt {
            thread_id: params.thread_id.clone(),
            turn_id: params.expected_turn_id.clone(),
            admission_guard: Some(areal_protocol::desktop::TurnInterruptAdmissionGuard {
                ordinary_session: true,
            }),
        })?;
        let operation = uuid::Uuid::new_v4().to_string();
        let record = json!({"method":"turn/interrupt","operationId":operation,"params":native,"threadId":params.thread_id,"turnId":params.expected_turn_id,"remote":{"hostId":self.host_peer,"devicePeerId":self.peer,"projectId":project,"commandId":command,"method":"turn.stop","capability":"interrupt","admittedGrantRevision":self.grant["revision"],"semanticDigest":digest,"target":params}});
        let (revision, mut snapshot) = self.host.journal.native_snapshot(&id)?;
        ensure!(crate::journal::has_capacity(&snapshot), "CAPACITY_EXCEEDED");
        self.authorize(Some(project), "interrupt")?;
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
                &self.host,
                &id,
                (&scope.0, generation, &scope.2),
                "turn/interrupt",
                native,
            )
            .await;
        let mut settled = record.clone();
        match response {
            Ok(_) => settled["admissionState"] = json!("accepted"),
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
                    self.authorize(Some(project), "interrupt")?;
                    return Ok(Self::command_view(Some(&record), command));
                };
                settled["admissionState"] = json!("rejected");
                settled["error"] = rejected.0.clone();
            }
        }
        let settled = self.settle_command(&id, settled)?;
        self.authorize(Some(project), "interrupt")?;
        Ok(Self::command_view(Some(&settled), command))
    }
}
