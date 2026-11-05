use super::*;

#[derive(Debug)]
struct OutcomeWrite;
impl std::fmt::Display for OutcomeWrite {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("persist command outcome")
    }
}
impl std::error::Error for OutcomeWrite {}

impl Session {
    pub(super) fn creation_command_scope(&self, project: &str) -> String {
        // 外层工作台命令不占项目原生请求的槽；同一 requestId 仍由后台提交到 Core。
        format!(
            "workbench-{}",
            areal_local_service::storage::digest(
                json!([self.peer, project, "session.create"])
                    .to_string()
                    .as_bytes()
            )
        )
    }
    pub(super) async fn create_session(
        &self,
        project: &str,
        generation: &str,
        request: &Value,
    ) -> Result<Value> {
        let params = &request["params"];
        // gui-write-v1 可选权限预设与 Agent Profile；已发布客户端仍只能用默认 ask 与项目远程 Profile。
        ensure!(
            (exact(params, &[])
                || (self.gui_write
                    && exact(
                        params,
                        &[
                            "permissionPreset",
                            "agentProfile",
                            "requestId",
                            "parameters",
                            "options",
                            "profile",
                            "model",
                            "worktree",
                            "browserEnabled"
                        ]
                    )
                    && params.get("permissionPreset").is_none_or(|preset| matches!(
                        preset.as_str(),
                        Some("ask" | "autoReview" | "fullAccess")
                    ))
                    && params.get("agentProfile").is_none_or(|profile| {
                        exact(profile, &["id", "revision"])
                            && profile["id"]
                                .as_str()
                                .is_some_and(|id| !id.is_empty() && id.len() <= 128)
                            && profile["revision"].as_str().is_some_and(|revision| {
                                !revision.is_empty() && revision.len() <= 128
                            })
                    })))
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
        if params["permissionPreset"] == "fullAccess"
            || params["options"]["permissionPreset"] == "fullAccess"
        {
            self.authorize(Some(project), "manage")?;
        }
        let digest =
            areal_local_service::storage::digest(&serde_json::to_vec(&if exact(params, &[]) {
                json!({"method":"session.create"})
            } else {
                json!({"method":"session.create","params":params})
            })?);
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
        if [
            "requestId",
            "parameters",
            "options",
            "profile",
            "model",
            "worktree",
            "browserEnabled",
        ]
        .iter()
        .any(|key| params.get(key).is_some())
        {
            ensure!(
                self.local
                    && self.gui_write
                    && params.get("permissionPreset").is_none()
                    && params.get("agentProfile").is_none(),
                "INVALID_PARAMS"
            );
            let operation = params
                .get("requestId")
                .map(|value| value.as_str().context("INVALID_PARAMS"))
                .transpose()?
                .unwrap_or(&command)
                .to_owned();
            uuid::Uuid::parse_str(&operation).map_err(|_| fail("INVALID_PARAMS"))?;
            let mut original = params.clone();
            original["requestId"] = json!(operation);
            let mut execution = self
                .host
                .gateway
                .workbench
                .prepare_execution(
                    &self.host,
                    &self.connection,
                    &id,
                    "workbench/thread/create",
                    original.clone(),
                )
                .await?
                .context("CAPABILITY_UNAVAILABLE")?;
            for (key, value) in original.as_object().unwrap() {
                ensure!(execution.params[key] == *value, "INVALID_RESPONSE");
            }
            self.authorize(Some(project), "submit")?;
            if params["options"]["permissionPreset"] == "fullAccess" {
                self.authorize(Some(project), "manage")?;
            }
            if let Some(record) = self.command_record(project, &command)? {
                ensure!(
                    record["remote"]["semanticDigest"] == digest,
                    "COMMAND_CONFLICT"
                );
                return self.command_result(project, Some(&record), &command).await;
            }
            ensure!(
                self.host
                    .schedules
                    .connections
                    .shared_identity(&self.host, &id)?
                    == scope,
                "RESYNC_REQUIRED"
            );
            let record = json!({"method":"workbench/thread/create","workbenchJournal":true,"operationId":operation,"params":execution.params,"backendSource":execution.source,
                "coreScope":{"serviceId":scope.0,"generation":scope.1,"connectionId":scope.2},
                "remote":{"hostId":self.host_peer,"devicePeerId":self.peer,"projectId":project,"commandId":command,"method":"session.create","capability":"submit","admittedGrantRevision":self.grant["revision"],"semanticDigest":digest,"target":params}});
            ensure!(
                serde_json::to_vec(&record)?.len() <= self.command_pending_bytes(),
                "LIMIT_EXCEEDED"
            );
            let command_scope = self.creation_command_scope(&id);
            let (revision, mut snapshot) = self.host.journal.native_snapshot(&command_scope)?;
            ensure!(
                snapshot["pending"].as_array().unwrap().len()
                    + snapshot["outcomes"].as_object().unwrap().len()
                    < 4096,
                "RESOURCE_UNAVAILABLE"
            );
            ensure!(
                !snapshot["outcomes"]
                    .as_object()
                    .unwrap()
                    .contains_key(&operation)
                    && !snapshot["pending"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|pending| pending["operationId"] == operation),
                "COMMAND_CONFLICT"
            );
            snapshot["pending"]
                .as_array_mut()
                .unwrap()
                .push(record.clone());
            self.host
                .journal
                .native_replace(&command_scope, revision, snapshot)?;
            let dispatched = execution.dispatch().await;
            let settled = if let Some(failure) = dispatched
                .as_ref()
                .err()
                .and_then(|error| {
                    error.downcast_ref::<crate::server::schedule_connection::RpcFailure>()
                })
                .filter(|failure| failure.0["data"]["outcome"]["kind"] == "noMutation")
            {
                let mut rejected = record.clone();
                rejected["admissionState"] = json!("rejected");
                rejected["error"] = failure.0.clone();
                self.settle_command(&id, rejected)?
            } else {
                self.reconcile_creation(project, &record).await?
            };
            self.authorize(Some(project), "submit")?;
            return Ok(Self::command_view(Some(&settled), &command));
        }
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
        let configured = crate::launch::remote_profile(
            &crate::server::schedule_connection::inputs(&self.host, &id)?,
        )?;
        let profile = match params.get("agentProfile") {
            Some(requested) => Some(serde_json::from_value(requested.clone())?),
            None => configured.clone(),
        };
        let profiles = if profile.is_some() {
            Some(
                self.rpc(project, generation, "areal/profile/list", json!({}))
                    .await,
            )
        } else {
            None
        };
        if let Some(record) = self.command_record(project, &command)? {
            ensure!(
                record["remote"]["semanticDigest"] == digest,
                "COMMAND_CONFLICT"
            );
            return self.command_result(project, Some(&record), &command).await;
        }
        if let (Some(profile), Some(profiles)) = (&profile, profiles) {
            let profiles = profiles?;
            ensure!(
                profiles["data"].as_array().is_some_and(|rows| rows
                    .iter()
                    .any(|row| row["id"] == profile.id && row["revision"] == profile.revision)),
                "RESOURCE_UNAVAILABLE"
            );
        }
        ensure!(
            params["permissionPreset"] != "fullAccess"
                || caps["features"]["permissionFullAccess"] == true,
            "CORE_INCOMPATIBLE"
        );
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
        ensure!(
            crate::launch::remote_profile(&crate::server::schedule_connection::inputs(
                &self.host, &id
            )?)? == configured,
            "RESYNC_REQUIRED"
        );
        let operation = uuid::Uuid::new_v4().to_string();
        let workspace = self.host.slots.borrow()[&id].registration.workspace.clone();
        let native: areal_protocol::desktop::ThreadStart = serde_json::from_value(
            json!({"requestId":operation,"cwd":workspace,"options":{"permissionPreset":params.get("permissionPreset").cloned().unwrap_or(json!("ask"))},"agentProfile":profile,"admissionGuard":{"ordinarySession":true},"creationAdmission":caps["features"]["threadCreationJournal"]["binding"]}),
        )?;
        let original = serde_json::to_value(native)?;
        let mut execution = if self.uses_workbench_execution() {
            self.host
                .gateway
                .workbench
                .prepare_execution(
                    &self.host,
                    &self.connection,
                    &id,
                    "areal/thread/start",
                    original.clone(),
                )
                .await?
        } else {
            None
        };
        let native = execution
            .as_ref()
            .map(|prepared| prepared.params.clone())
            .unwrap_or_else(|| original.clone());
        for field in ["requestId", "cwd", "admissionGuard", "creationAdmission"] {
            ensure!(native[field] == original[field], "INVALID_RESPONSE");
        }
        ensure!(
            native["options"]["permissionPreset"] == original["options"]["permissionPreset"]
                && native["agentProfile"] == original["agentProfile"],
            "INVALID_RESPONSE"
        );
        let typed: areal_protocol::desktop::ThreadStart = serde_json::from_value(native.clone())?;
        let native_digest = areal_local_service::storage::digest(&serde_json::to_vec(&typed)?);
        self.authorize(Some(project), "submit")?;
        if params["permissionPreset"] == "fullAccess"
            || params["options"]["permissionPreset"] == "fullAccess"
        {
            self.authorize(Some(project), "manage")?;
        }
        if let Some(record) = self.command_record(project, &command)? {
            ensure!(
                record["remote"]["semanticDigest"] == digest,
                "COMMAND_CONFLICT"
            );
            return self.command_result(project, Some(&record), &command).await;
        }
        let record = json!({"method":"areal/thread/start","operationId":operation,"params":native,"nativeDigest":native_digest,"coreScope":{"serviceId":scope.0,"generation":scope.1,"connectionId":scope.2},"remote":{"hostId":self.host_peer,"devicePeerId":self.peer,"projectId":project,"commandId":command,"method":"session.create","capability":"submit","admittedGrantRevision":self.grant["revision"],"semanticDigest":digest,"target":if exact(params, &[]) {json!({})} else {params.clone()}}});
        ensure!(
            serde_json::to_vec(&record)?.len() <= self.command_pending_bytes(),
            "LIMIT_EXCEEDED"
        );
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
        let result = if let Some(prepared) = &mut execution {
            prepared.dispatch().await
        } else {
            self.host
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
                .await
        };
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
        let settled = match self.settle_command(&id, settled) {
            Ok(settled) => settled,
            Err(error)
                if error.is::<OutcomeWrite>()
                    && error.downcast_ref::<std::io::Error>().is_some() =>
            {
                match self.command_record(project, &command) {
                    Ok(Some(pending)) if pending == record => pending,
                    _ => return Err(error),
                }
            }
            Err(error) => return Err(error),
        };
        self.authorize(Some(project), "submit")?;
        Ok(Self::command_view(Some(&settled), &command))
    }
    fn creation_receipt(operation: &str, thread: &str) -> Value {
        json!({"requestId":operation,"method":"areal/thread/start","status":"completed","accepted":true,"threadId":thread,"result":{"threadId":thread},"operation":{"requestId":operation,"method":"areal/thread/start","target":{"kind":"thread","threadId":thread}}})
    }
    pub(super) fn settle_command(&self, id: &str, mut record: Value) -> Result<Value> {
        let operation = record["operationId"]
            .as_str()
            .context("RESOURCE_UNAVAILABLE")?
            .to_owned();
        let scope = if record["workbenchJournal"] == true {
            ensure!(
                record["method"] == "workbench/thread/create",
                "INVALID_RESPONSE"
            );
            self.creation_command_scope(id)
        } else {
            id.to_owned()
        };
        let (revision, mut snapshot) = self.host.journal.native_snapshot(&scope)?;
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
        self.host
            .journal
            .native_replace(&scope, revision, snapshot)
            .context(OutcomeWrite)?;
        Ok(record)
    }
    pub(super) async fn reconcile_creation(&self, project: &str, record: &Value) -> Result<Value> {
        if record.get("admissionState").is_some() {
            return Ok(record.clone());
        }
        self.authorize(Some(project), "submit")?;
        let id = self.project_id(project)?;
        if record["method"] == "workbench/thread/create" {
            let Some(source) = record["backendSource"].as_str() else {
                return Ok(record.clone());
            };
            let Ok(result) = self
                .host
                .gateway
                .workbench
                .read_creation(&self.host, &id, source, &record["params"])
                .await
            else {
                return Ok(record.clone());
            };
            let mut settled = record.clone();
            if result["state"] == "ready" {
                let Some(thread) = result["threadId"]
                    .as_str()
                    .filter(|value| !value.is_empty())
                else {
                    return Ok(record.clone());
                };
                let operation = record["operationId"].as_str().context("INVALID_RESPONSE")?;
                settled["threadId"] = json!(thread);
                settled["receipt"] = Self::creation_receipt(operation, thread);
                settled["receipt"]["result"]["executionProjectId"] =
                    result["executionProjectId"].clone();
                settled["admissionState"] = json!("accepted");
            } else if result["state"] == "rejected" {
                settled["admissionState"] = json!("rejected");
                settled["error"] = json!({"code":"CREATION_REJECTED","message":result["message"]});
            } else {
                return Ok(record.clone());
            }
            self.authorize(Some(project), "submit")?;
            return self.settle_command(&id, settled);
        }
        let Ok((service, generation, connection)) = self
            .host
            .schedules
            .connections
            .shared_identity(&self.host, &id)
        else {
            return Ok(record.clone());
        };
        if record["coreScope"]["serviceId"] != service {
            return Ok(record.clone());
        }
        let Some(operation) = record["params"]["requestId"].as_str() else {
            return Ok(record.clone());
        };
        let Some(digest) = record["nativeDigest"].as_str() else {
            return Ok(record.clone());
        };
        let Ok(original) = serde_json::from_value::<areal_protocol::desktop::CreationAdmission>(
            record["params"]["creationAdmission"].clone(),
        ) else {
            return Ok(record.clone());
        };
        if original.identity.is_empty()
            || uuid::Uuid::parse_str(&original.journal_epoch).is_err()
            || uuid::Uuid::parse_str(&original.core_instance_id).is_err()
        {
            return Ok(record.clone());
        }
        let caps = self
            .rpc(project, &generation, "areal/capabilities", json!({}))
            .await;
        self.authorize(Some(project), "submit")?;
        let Ok(caps) = caps else {
            return Ok(record.clone());
        };
        let Ok(binding) = serde_json::from_value::<areal_protocol::desktop::CreationAdmission>(
            caps["features"]["threadCreationJournal"]["binding"].clone(),
        ) else {
            return Ok(record.clone());
        };
        if binding.identity != original.identity
            || binding.journal_epoch != original.journal_epoch
            || uuid::Uuid::parse_str(&binding.core_instance_id).is_err()
            || self
                .host
                .schedules
                .connections
                .shared_identity(&self.host, &id)
                .ok()
                != Some((service.clone(), generation.clone(), connection.clone()))
        {
            return Ok(record.clone());
        }
        let result = self
            .host
            .schedules
            .connections
            .remote_request(
                &self.host,
                &id,
                &service,
                &generation,
                &connection,
                "areal/request/read",
                json!({"requestId":operation,"creationAdmission":original}),
            )
            .await;
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
        let Some(receipts) = value["data"].as_array() else {
            return Ok(record.clone());
        };
        let candidates = receipts
            .iter()
            .filter(|receipt| {
                receipt["requestId"] == operation
                    && receipt["method"] == "areal/thread/start"
                    && receipt["digest"] == digest
                    && receipt["identity"] == record["params"]["creationAdmission"]["identity"]
            })
            .collect::<Vec<_>>();
        if receipts.is_empty()
            && value["creationAdmission"]["status"] == "notAdmitted"
            && value["creationAdmission"]["requestId"] == operation
            && value["creationAdmission"]["method"] == "areal/thread/start"
            && value["creationAdmission"]["identity"] == original.identity
            && value["creationAdmission"]["journalEpoch"] == original.journal_epoch
            && value["creationAdmission"]["coreInstanceId"] == original.core_instance_id
            && binding.core_instance_id != original.core_instance_id
        {
            let mut settled = record.clone();
            settled["admissionState"] = json!("rejected");
            return self.settle_command(&id, settled);
        }
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
        if thread.is_empty()
            || receipt["operation"]["requestId"] != operation
            || receipt["operation"]["method"] != "areal/thread/start"
            || receipt["operation"]["target"]["kind"] != "thread"
            || receipt["operation"]["target"]["threadId"] != thread
            || receipt["status"] != "completed"
        {
            return Ok(record.clone());
        }
        let mut settled = record.clone();
        settled["threadId"] = json!(thread);
        settled["receipt"] = Self::creation_receipt(operation, thread);
        settled["admissionState"] = json!("accepted");
        self.settle_command(&id, settled)
    }
}
