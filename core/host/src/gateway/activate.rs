use super::*;

impl Session {
    /// 唤醒只取得项目执行实例；消息仍须在重读会话后经原提交回执受理。
    pub(super) async fn activate_project(&self, project: &str, request: &Value) -> Result<Value> {
        ensure!(
            exact(&request["context"], &["projectId"])
                && exact(&request["params"], &[])
                && request.get("commandId").is_none(),
            "INVALID_PARAMS"
        );
        self.authorize(Some(project), "submit")?;
        self.host.admission()?;
        let id = self.project_id(project)?;
        if crate::server::cloud_sessions::CloudSessions::is_virtual(&id) {
            let scope = self
                .host
                .gateway
                .workbench
                .cloud
                .sessions
                .activate_authorized(&self.host, &id, &self.cloud_activation_auth())
                .await?;
            self.authorize(Some(project), "submit")?;
            return Ok(
                json!({"projectId":project,"state":"ready","serviceGeneration":scope.identity.1}),
            );
        }
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
        let outcome = self.host.activate_project_normal(&id, deadline).await?;
        self.authorize(Some(project), "submit")?;
        let mut response = match outcome {
            crate::server::ActivationOutcome::Ready {
                service_generation,
                activation_id,
            } => {
                let mut result = json!({
                    "projectId": project,
                    "state": "ready",
                    "serviceGeneration": service_generation,
                });
                if let Some(activation) = activation_id {
                    result["activationId"] = json!(activation);
                }
                result
            }
            crate::server::ActivationOutcome::Pending {
                activation_id,
                reason,
            } => {
                let mut result = json!({
                    "projectId": project,
                    "state": "pending",
                    "reason": reason,
                });
                if let Some(activation) = activation_id {
                    result["activationId"] = json!(activation);
                }
                result
            }
            crate::server::ActivationOutcome::Blocked {
                activation_id,
                reason,
            } => {
                let mut result = json!({
                    "projectId": project,
                    "state": "blocked",
                    "reason": reason,
                });
                if let Some(activation) = activation_id {
                    result["activationId"] = json!(activation);
                }
                result
            }
        };
        if response["state"] == "ready"
            && self
                .project(project)
                .map(|(_, generation)| generation)
                .ok()
                .as_deref()
                != response["serviceGeneration"].as_str()
        {
            response = json!({
                "projectId": project,
                "state": "pending",
                "reason": "activationIncomplete",
            });
        }
        Ok(response)
    }
}
