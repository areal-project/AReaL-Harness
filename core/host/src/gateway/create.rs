use super::*;

impl Session {
    pub(super) async fn create_session(
        &self,
        project: &str,
        generation: &str,
        request: &Value,
    ) -> Result<Value> {
        ensure!(
            exact(&request["params"], &[])
                && exact(
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
        let command = text(request, "commandId")?.to_ascii_lowercase();
        uuid::Uuid::parse_str(&command).map_err(|_| fail("INVALID_PARAMS"))?;
        self.authorize(Some(project), "submit")?;
        let digest = areal_local_service::storage::digest(&serde_json::to_vec(
            &json!({"method":"session.create"}),
        )?);
        if let Some(record) = self.command_record(project, &command)? {
            ensure!(
                record["remote"]["semanticDigest"] == digest,
                "COMMAND_CONFLICT"
            );
            return self.command_result(project, Some(&record), &command).await;
        }
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
        if let Some(record) = self.command_record(project, &command)? {
            ensure!(
                record["remote"]["semanticDigest"] == digest,
                "COMMAND_CONFLICT"
            );
            return self.command_result(project, Some(&record), &command).await;
        }
        ensure!(
            caps["features"]["threadStartAdmissionGuard"] == true
                && caps["features"]["permissionPresets"] == true
                && caps["features"]["threadCreationJournal"]["binding"].is_object()
                && caps["methods"].as_array().is_some_and(|methods| methods
                    .iter()
                    .any(|method| method == "areal/thread/start")
                    && methods.iter().any(|method| method == "areal/request/read")),
            "CORE_INCOMPATIBLE"
        );
        ensure!(
            self.host
                .schedules
                .connections
                .shared_identity(&self.host, &id)?
                == scope,
            "RESYNC_REQUIRED"
        );
        let operation = uuid::Uuid::new_v4().to_string();
        let workspace = self.host.slots.borrow()[&id].registration.workspace.clone();
        let native: areal_protocol::desktop::ThreadStart = serde_json::from_value(
            json!({"requestId":operation,"cwd":workspace,"options":{"permissionPreset":"ask"},"admissionGuard":{"ordinarySession":true},"creationAdmission":caps["features"]["threadCreationJournal"]["binding"]}),
        )?;
        let native_digest = areal_local_service::storage::digest(&serde_json::to_vec(&native)?);
        let native = serde_json::to_value(native)?;
        let record = json!({"method":"areal/thread/start","operationId":operation,"params":native,"nativeDigest":native_digest,"coreScope":{"serviceId":scope.0,"generation":scope.1,"connectionId":scope.2},"remote":{"hostId":self.host_peer,"devicePeerId":self.peer,"projectId":project,"commandId":command,"method":"session.create","capability":"submit","admittedGrantRevision":self.grant["revision"],"semanticDigest":digest,"target":{}}});
        let (revision, mut snapshot) = self.host.journal.native_snapshot(&id)?;
        ensure!(
            snapshot["pending"].as_array().unwrap().len()
                + snapshot["outcomes"].as_object().unwrap().len()
                < 4096,
            "RESOURCE_UNAVAILABLE"
        );
        self.authorize(Some(project), "submit")?;
        ensure!(
            self.host
                .schedules
                .connections
                .shared_identity(&self.host, &id)?
                == scope,
            "RESYNC_REQUIRED"
        );
        snapshot["pending"]
            .as_array_mut()
            .unwrap()
            .push(record.clone());
        self.host.journal.native_replace(&id, revision, snapshot)?;
        let result = self
            .host
            .schedules
            .connections
            .remote_request(
                &self.host,
                &id,
                &scope.0,
                generation,
                &scope.2,
                "areal/thread/start",
                native,
            )
            .await;
        let mut settled = record.clone();
        match result {
            Ok(value) => {
                let Some(thread) = value["thread"]["id"]
                    .as_str()
                    .filter(|thread| !thread.is_empty())
                else {
                    self.authorize(Some(project), "submit")?;
                    return Ok(Self::command_view(Some(&record), &command));
                };
                settled["threadId"] = json!(thread);
                settled["receipt"] = Self::creation_receipt(&operation, thread);
                settled["admissionState"] = json!("accepted");
            }
            Err(error) => {
                let rejected = error
                    .downcast_ref::<crate::server::schedule_connection::RpcFailure>()
                    .filter(|failure| {
                        matches!(
                            failure.0["data"]["outcome"]["kind"].as_str(),
                            Some("rejected" | "noMutation")
                        )
                    });
                let Some(rejected) = rejected else {
                    self.authorize(Some(project), "submit")?;
                    return Ok(Self::command_view(Some(&record), &command));
                };
                settled["admissionState"] = json!("rejected");
                settled["error"] = rejected.0.clone();
            }
        }
        let settled = self.settle_creation(&id, settled)?;
        self.authorize(Some(project), "submit")?;
        Ok(Self::command_view(Some(&settled), &command))
    }
    fn creation_receipt(operation: &str, thread: &str) -> Value {
        json!({"requestId":operation,"method":"areal/thread/start","status":"completed","accepted":true,"threadId":thread,"result":{"threadId":thread},"operation":{"requestId":operation,"method":"areal/thread/start","target":{"kind":"thread","threadId":thread}}})
    }
    fn settle_creation(&self, id: &str, mut record: Value) -> Result<Value> {
        let operation = record["operationId"]
            .as_str()
            .context("RESOURCE_UNAVAILABLE")?
            .to_owned();
        let (revision, mut snapshot) = self.host.journal.native_snapshot(id)?;
        if let Some(previous) = snapshot["outcomes"].get(&operation) {
            return Ok(previous.clone());
        }
        record["accepted"] = json!(record["admissionState"] == "accepted");
        record.as_object_mut().unwrap().remove("params");
        snapshot["pending"]
            .as_array_mut()
            .unwrap()
            .retain(|entry| entry["operationId"] != operation);
        snapshot["outcomes"][&operation] = record.clone();
        self.host.journal.native_replace(id, revision, snapshot)?;
        Ok(record)
    }
    pub(super) async fn reconcile_creation(&self, project: &str, record: &Value) -> Result<Value> {
        if record.get("admissionState").is_some() {
            return Ok(record.clone());
        }
        self.authorize(Some(project), "submit")?;
        let id = self.project_id(project)?;
        let Ok((service, generation, connection)) = self
            .host
            .schedules
            .connections
            .shared_identity(&self.host, &id)
        else {
            return Ok(record.clone());
        };
        if record["coreScope"]["serviceId"] != service
            || record["coreScope"]["generation"] != generation
        {
            return Ok(record.clone());
        }
        let Some(operation) = record["params"]["requestId"].as_str() else {
            return Ok(record.clone());
        };
        let Some(digest) = record["nativeDigest"].as_str() else {
            return Ok(record.clone());
        };
        let result=self.host.schedules.connections.remote_request(&self.host,&id,&service,&generation,&connection,"areal/request/read",json!({"requestId":operation,"creationAdmission":record["params"]["creationAdmission"]})).await;
        self.authorize(Some(project), "submit")?;
        let Ok(value) = result else {
            return Ok(record.clone());
        };
        if self
            .host
            .schedules
            .connections
            .shared_identity(&self.host, &id)
            .ok()
            != Some((service, generation, connection))
        {
            return Ok(record.clone());
        }
        let candidates = value["data"]
            .as_array()
            .context("RESOURCE_UNAVAILABLE")?
            .iter()
            .filter(|receipt| {
                receipt["requestId"] == operation
                    && receipt["method"] == "areal/thread/start"
                    && receipt["digest"] == digest
                    && receipt["identity"] == record["params"]["creationAdmission"]["identity"]
            })
            .collect::<Vec<_>>();
        if candidates.len() != 1 {
            return Ok(record.clone());
        }
        let receipt = candidates[0];
        let thread = receipt["threadId"]
            .as_str()
            .or_else(|| receipt["result"]["threadId"].as_str())
            .or_else(|| receipt["response"]["result"]["threadId"].as_str());
        let Some(thread) = thread else {
            return Ok(record.clone());
        };
        if receipt["operation"]["target"]["kind"] != "thread"
            || receipt["operation"]["target"]["threadId"] != thread
            || receipt["status"] != "completed"
        {
            return Ok(record.clone());
        }
        let mut settled = record.clone();
        settled["threadId"] = json!(thread);
        settled["receipt"] = Self::creation_receipt(operation, thread);
        settled["admissionState"] = json!("accepted");
        self.settle_creation(&id, settled)
    }
}
