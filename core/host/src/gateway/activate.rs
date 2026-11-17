use super::*;
use areal_local_service::storage;

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
                .activate(&self.host, &id)
                .await?;
            self.authorize(Some(project), "submit")?;
            return Ok(
                json!({"projectId":project,"state":"ready","serviceGeneration":scope.identity.1}),
            );
        }
        if self.host.schedules.suppressed(&id) {
            return Ok(json!({"projectId":project,"state":"blocked","reason":"explicitlyStopped"}));
        }
        if let Ok((_, generation)) = self.project(project) {
            return self.activation_ready(project, None, &generation).await;
        }
        // 启动是 Host 拥有的幂等资源操作。客户端重连只核对原 ensure，不重放未知启动。
        for path in storage::json_records(&self.host.home.join("host/operations"), false)? {
            let record: crate::server::Operation = storage::read(&path)?;
            if record.receipt["method"] == "project.ensure"
                && record.receipt["projectId"] == id
                && !record.settled()
            {
                let request = text(&record.receipt, "requestId")?;
                let receipt = self
                    .host
                    .reconcile(request)
                    .await?
                    .context("CORE_UNAVAILABLE")?;
                self.authorize(Some(project), "submit")?;
                return self.activation_result(project, request, &receipt).await;
            }
        }
        let activation = uuid::Uuid::new_v4().to_string();
        let result = self
            .host
            .ensure_cause(
                crate::server::Ensure {
                    request_id: activation.clone(),
                    expected_generation: self.host.identity.generation.clone(),
                    project_id: id,
                    launch_inputs: None,
                    credentials: Default::default(),
                    no_auto_restart: false,
                    resume_scheduling: false,
                },
                true,
            )
            .await;
        self.authorize(Some(project), "submit")?;
        if let Some(record) = self.host.receipt(&activation)? {
            return self
                .activation_result(project, &activation, &record.receipt)
                .await;
        }
        result?;
        Err(fail("CORE_UNAVAILABLE"))
    }

    async fn activation_result(
        &self,
        project: &str,
        activation: &str,
        receipt: &Value,
    ) -> Result<Value> {
        if receipt["state"] == "completed"
            && let Ok((_, generation)) = self.project(project)
        {
            return self
                .activation_ready(project, Some(activation), &generation)
                .await;
        }
        let blocked = receipt["state"] == "blocked" || receipt["state"] == "completed";
        Ok(json!({"projectId":project,"activationId":activation,
            "state":if blocked {"blocked"} else {"pending"}, "reason":"activationIncomplete"}))
    }

    async fn activation_ready(
        &self,
        project: &str,
        activation: Option<&str>,
        generation: &str,
    ) -> Result<Value> {
        let id = self.project_id(project)?;
        let connected = self
            .host
            .schedules
            .connections
            .ready(&self.host, &id, generation)
            .await;
        self.authorize(Some(project), "submit")?;
        let mut result = if self.host.schedules.suppressed(&id) {
            json!({"projectId":project,"state":"blocked","reason":"explicitlyStopped"})
        } else if connected.is_ok() && self.project(project)?.1 == generation {
            json!({"projectId":project,"state":"ready","serviceGeneration":generation})
        } else {
            json!({"projectId":project,"state":"pending","reason":"activationIncomplete"})
        };
        if let Some(activation) = activation {
            result["activationId"] = json!(activation);
        }
        Ok(result)
    }
}
