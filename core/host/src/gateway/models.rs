use super::*;
use areal_local_service::storage;
use std::collections::BTreeSet;

fn catalog(core: &[Value], subscription: Option<&Value>, remembered: &[Value]) -> Vec<Value> {
    let metadata = subscription
        .and_then(|value| value["models"].as_array())
        .map(Vec::as_slice)
        .unwrap_or_default();
    let authenticated = subscription.is_some_and(|value| value["authenticated"] == true);
    let checking = subscription.is_some_and(|value| value["availability"] == "checking");
    let mut models = core.to_vec();
    if authenticated {
        let mut known: BTreeSet<String> = models
            .iter()
            .filter(|model| model["providerId"] == "areal_openai")
            .filter_map(|model| model["modelId"].as_str().map(str::to_owned))
            .collect();
        for model in metadata {
            if let Some(id) = model["id"].as_str().filter(|id| known.insert((*id).into())) {
                models.push(json!({"providerId":"areal_openai","modelId":id,"displayName":model.get("name").unwrap_or(&model["id"]),"reasoningEffortOptions":model.get("reasoningEffortOptions").cloned().unwrap_or(json!([]))}));
            }
        }
        if checking {
            for model in remembered {
                if model["providerId"] == "areal_openai"
                    && let Some(id) = model["modelId"]
                        .as_str()
                        .filter(|id| known.insert((*id).into()))
                {
                    models.push(json!({"providerId":"areal_openai","modelId":id,"displayName":id,"reasoningEffortOptions":[]}));
                }
            }
        }
    }
    models
        .iter()
        .take(200)
        .map(|model| {
            let mut value = projection::pick(
                model,
                &[
                    "providerId",
                    "modelId",
                    "displayName",
                    "reasoningEffortOptions",
                    "available",
                    "unavailableReason",
                    "providerName",
                    "providerRevision",
                    "isDefault",
                    "credentialState",
                    "availability",
                    "parameters",
                    "contextWindowTokens",
                    "maxOutputTokens",
                    "capabilities",
                ],
            );
            let entry = metadata
                .iter()
                .find(|entry| entry["id"] == model["modelId"]);
            if model["providerId"] == "areal_openai" {
                if !model["invalidReason"].is_null() {
                    value["available"] = json!(false);
                } else if checking {
                    value.as_object_mut().unwrap().remove("available");
                } else {
                    value["available"] = json!(authenticated && entry.is_some());
                }
                if let Some(name) = entry.and_then(|entry| entry.get("name")) {
                    value["displayName"] = name.clone();
                }
            }
            if value.get("displayName").is_none() {
                value["displayName"] = model["modelId"].clone();
            }
            for (field, keys) in [
                (
                    "parameters",
                    &[
                        "temperature",
                        "maxOutputTokens",
                        "contextWindowTokens",
                        "reasoningEffort",
                        "reasoningSummary",
                        "serviceTier",
                    ][..],
                ),
                (
                    "capabilities",
                    &["tools", "vision", "reasoning", "reasoningEffortOptions"][..],
                ),
            ] {
                if value[field].is_object() {
                    value[field] = projection::pick(&value[field], keys);
                } else {
                    value.as_object_mut().unwrap().remove(field);
                }
            }
            value
        })
        .collect()
}

impl Session {
    pub(super) fn persisted_model_catalog(&self, project: &str, request: &Value) -> Result<Value> {
        ensure!(
            exact(&request["context"], &["projectId"])
                && exact(&request["params"], &[])
                && request.get("commandId").is_none(),
            "INVALID_PARAMS"
        );
        self.authorize(Some(project), "observe")?;
        let id = self.project_id(project)?;
        ensure!(
            !crate::server::cloud_sessions::CloudSessions::is_virtual(&id),
            "CORE_UNAVAILABLE"
        );
        let registration = self.host.slots.borrow()[&id].registration.clone();
        let path = self
            .host
            .home
            .join("host/launch")
            .join(storage::digest(id.as_bytes()))
            .join("inputs.json");
        let mut inputs: crate::LaunchInputs =
            storage::read_optional(&path)?.unwrap_or(crate::LaunchInputs {
                workspace: registration.workspace.clone(),
                cwd: registration.workspace.clone(),
                config_home: self.host.home.clone(),
                homedir: None,
                config_path: None,
                deployment_path: None,
                schedule_preparation: None,
                environment: Default::default(),
                credential_names: vec![],
                options: Default::default(),
            });
        let source = self
            .host
            .migration
            .shared_credential_source(&registration, self.host.uses_shared_host_config(&inputs))?;
        let references = source
            .as_deref()
            .map(|source| self.host.migration.vault.provider_references(source))
            .transpose()?
            .unwrap_or_default()
            .into_iter()
            .collect::<Vec<_>>();
        // 目录只用凭据来源元数据；不解锁钥匙串，也不把“保存过”当成当前可用。
        let credentials = self.host.gateway.workbench.project_environment_credentials(
            &registration,
            source.as_deref(),
            &mut inputs.credential_names,
        );
        let config = areal_config::models::read(
            &crate::launch::config_inputs(&self.host.home, &inputs, &credentials),
            &references,
        )?;
        let effective_source = if self.local {
            source.as_deref().unwrap_or("")
        } else {
            &self.source_id
        };
        let subscription = self.host.subscription_model_catalog(effective_source)?;
        let models = configured_models(&config);
        let mut value = json!({"projectId":project,"gatewayGeneration":self.generation,
            "grantRevision":self.grant["revision"], "models":catalog(&models, subscription.as_ref(), &[])});
        let accepted = self.accepted_model(effective_source, Value::Null)?;
        if !accepted.is_null() {
            value["lastAcceptedModel"] = accepted;
        }
        if self.gui_read
            && let Some(default_profile) = crate::launch::remote_profile(&inputs)?
        {
            value["defaultProfile"] = serde_json::to_value(default_profile)?;
        }
        ensure!(
            serde_json::to_vec(&value)?.len() <= 128 * 1024,
            "LIMIT_EXCEEDED"
        );
        Ok(value)
    }

    pub(super) async fn project_models(
        &self,
        project: &str,
        generation: &str,
        request: &Value,
    ) -> Result<Value> {
        ensure!(
            exact(&request["context"], &["projectId"])
                && exact(&request["params"], &[])
                && request.get("commandId").is_none(),
            "INVALID_PARAMS"
        );
        self.authorize(Some(project), "observe")?;
        let (id, current) = self.project(project)?;
        ensure!(current == generation, "RESYNC_REQUIRED");
        if crate::server::cloud_sessions::CloudSessions::is_virtual(&id) {
            return self.cloud_models(project, generation).await;
        }
        let metadata = self
            .host
            .schedules
            .connections
            .model_metadata(&self.host, &id)?;
        let mut result = if metadata.is_some() {
            json!({"projectId":project,"gatewayGeneration":self.generation,
                "grantRevision":self.grant["revision"]})
        } else {
            self.persisted_model_catalog(project, request)?
        };
        result["serviceGeneration"] = json!(generation);
        let caps = match metadata.as_ref() {
            Some(value) => Some(value["capabilities"].clone()),
            None => self
                .host
                .schedules
                .connections
                .model_capabilities(&self.host, &id)?,
        };
        let source = if self.local {
            let registration = self.host.slots.borrow()[&id].registration.clone();
            self.host
                .migration
                .shared_credential_source(
                    &registration,
                    self.host.project_uses_shared_config(&registration),
                )?
                .unwrap_or_default()
        } else {
            self.source_id.clone()
        };
        if let Some(metadata) = &metadata {
            let subscription = self.host.subscription_model_catalog(&source)?;
            let models = metadata["models"]["data"]
                .as_array()
                .context("CORE_UNAVAILABLE")?;
            let mut remembered = vec![metadata["models"]["lastAcceptedModel"]["model"].clone()];
            remembered.extend(self.observed_model(project)?);
            result["models"] = json!(catalog(models, subscription.as_ref(), &remembered));
            result["lastAcceptedModel"] = metadata["models"]["lastAcceptedModel"].clone();
        } else if let Some(models) = result["models"].as_array_mut() {
            mark_checking(models);
        }
        result["lastAcceptedModel"] =
            self.accepted_model(&source, result["lastAcceptedModel"].clone())?;
        if self.gui_read {
            let profiles = metadata.as_ref().map(|value| &value["profiles"]);
            result["profiles"] = json!(
                profiles
                    .and_then(|profiles| profiles["data"].as_array())
                    .into_iter()
                    .flatten()
                    .map(|profile| projection::pick(
                        profile,
                        &[
                            "id",
                            "revision",
                            "displayName",
                            "instructions",
                            "model",
                            "readOnly",
                            "skills",
                            "workflow",
                            "toolAllowlist",
                            "approvalTools",
                            "allowThreadProcesses",
                            "allowConnectionProcesses",
                            "allowPluginSkills",
                            "requiredModalities",
                        ]
                    ))
                    .collect::<Vec<_>>()
            );
            let id = self.project_id(project)?;
            let saved: Option<crate::LaunchInputs> = storage::read_optional(
                &self
                    .host
                    .home
                    .join("host/launch")
                    .join(storage::digest(id.as_bytes()))
                    .join("inputs.json"),
            )?;
            result["defaultProfile"] = saved
                .as_ref()
                .map(crate::launch::remote_profile)
                .transpose()?
                .flatten()
                .map(serde_json::to_value)
                .transpose()?
                .unwrap_or(Value::Null);
        }
        self.authorize(Some(project), "observe")?;
        ensure!(self.project(project)?.1 == generation, "RESYNC_REQUIRED");
        if let Some(caps) = caps.as_ref() {
            result["features"] = public_features(caps);
        }
        ensure!(
            serde_json::to_vec(&result)?.len() <= 128 * 1024,
            "LIMIT_EXCEEDED"
        );
        Ok(result)
    }

    async fn cloud_models(&self, project: &str, generation: &str) -> Result<Value> {
        let core = self
            .rpc(project, generation, "areal/model/list", json!({}))
            .await?;
        let models = core["data"].as_array().context("CORE_UNAVAILABLE")?;
        ensure!(models.len() <= 200, "LIMIT_EXCEEDED");
        let models: Vec<_> = models
            .iter()
            .map(|model| {
                projection::pick(
                    model,
                    &[
                        "providerId",
                        "modelId",
                        "displayName",
                        "reasoningEffortOptions",
                        "available",
                        "unavailableReason",
                        "providerName",
                        "providerRevision",
                        "isDefault",
                        "credentialState",
                        "availability",
                        "parameters",
                        "contextWindowTokens",
                        "maxOutputTokens",
                        "capabilities",
                    ],
                )
            })
            .collect();
        let profiles = self
            .rpc(project, generation, "areal/profile/list", json!({}))
            .await?;
        let profiles = profiles["data"].as_array().context("CORE_UNAVAILABLE")?;
        ensure!(profiles.len() <= 200, "LIMIT_EXCEEDED");
        let profiles: Vec<_> = profiles
            .iter()
            .map(|profile| {
                projection::pick(
                    profile,
                    &[
                        "id",
                        "revision",
                        "displayName",
                        "instructions",
                        "model",
                        "readOnly",
                        "skills",
                        "workflow",
                        "toolAllowlist",
                        "approvalTools",
                        "allowThreadProcesses",
                        "allowConnectionProcesses",
                        "allowPluginSkills",
                        "requiredModalities",
                    ],
                )
            })
            .collect();
        let caps = self
            .rpc(project, generation, "areal/capabilities", json!({}))
            .await?;
        let result = json!({"projectId":project,"gatewayGeneration":self.generation,
            "grantRevision":self.grant["revision"],"serviceGeneration":generation,
            "models":models,"profiles":profiles,"defaultProfile":null,
            "lastAcceptedModel":core.get("lastAcceptedModel"),"features":public_features(&caps)});
        ensure!(
            serde_json::to_vec(&result)?.len() <= 128 * 1024,
            "LIMIT_EXCEEDED"
        );
        Ok(result)
    }

    fn accepted_model(&self, source: &str, mut accepted: Value) -> Result<Value> {
        if self.gui_read
            && let Some(home) = self.host.migration.power_sources()?.get(source)
        {
            let path = home.join("model-selection.json");
            let saved: Option<areal_protocol::host::WorkbenchCreationAcceptedModel> =
                storage::read_optional(&path)?;
            let saved_at = saved.as_ref().map(|item| item.accepted_at).unwrap_or(0);
            // Core 目录是权威来源；按单调递增的 acceptedAt 同步跨项目偏好，迟到读不覆盖更新选择。
            if let Ok(observed) = serde_json::from_value::<
                areal_protocol::host::WorkbenchCreationAcceptedModel,
            >(accepted.clone())
                && observed.accepted_at > saved_at
            {
                if let Err(error) = storage::write(&path, &observed) {
                    eprintln!("Host model-selection persistence failed: {error:#}");
                } else {
                    self.host.changed();
                }
            } else if let Some(saved) = saved
                && saved.accepted_at > accepted["acceptedAt"].as_i64().unwrap_or(0)
            {
                accepted = serde_json::to_value(saved)?;
            }
        }
        Ok(accepted)
    }

    pub(super) async fn model_catalog(
        &self,
        project: &str,
        generation: &str,
        observed_model: impl FnOnce() -> Result<Option<Value>>,
    ) -> Result<Value> {
        let (id, _) = self.project(project)?;
        if crate::server::cloud_sessions::CloudSessions::is_virtual(&id) {
            return self.cloud_models(project, generation).await;
        }
        let identity = self
            .host
            .schedules
            .connections
            .shared_identity(&self.host, &id)?;
        let source = if self.local {
            let registration = self.host.slots.borrow()[&id].registration.clone();
            self.host
                .migration
                .shared_credential_source(
                    &registration,
                    self.host.project_uses_shared_config(&registration),
                )?
                .unwrap_or_default()
        } else {
            self.source_id.clone()
        };
        let subscription = self
            .host
            .subscription_model_catalog(&source)
            .map_err(|_| fail("CORE_UNAVAILABLE"))?;
        self.authorize(Some(project), "observe")?;
        ensure!(self.project(project)?.1 == generation, "RESYNC_REQUIRED");
        let core = if let Some(metadata) = self
            .host
            .schedules
            .connections
            .model_metadata(&self.host, &id)?
        {
            metadata["models"].clone()
        } else {
            // 历史正文不依赖模型配置是否可解析；模型设置页仍单独报告配置错误。
            let mut saved = self
                .persisted_model_catalog(
                    project,
                    &json!({"context":{"projectId":project},"params":{}}),
                )
                .unwrap_or_else(|_| json!({"models":[]}));
            if let Some(models) = saved["models"].as_array_mut() {
                mark_checking(models);
            }
            json!({"data":saved["models"],"lastAcceptedModel":null})
        };
        let models = core["data"].as_array().context("CORE_UNAVAILABLE")?;
        let mut remembered = vec![core["lastAcceptedModel"]["model"].clone()];
        if subscription.as_ref().is_some_and(|value| {
            value["authenticated"] == true && value["availability"] == "checking"
        }) && let Some(model) = observed_model()?
        {
            remembered.push(model);
        }
        self.authorize(Some(project), "observe")?;
        ensure!(
            self.project(project)?.1 == generation
                && self
                    .host
                    .schedules
                    .connections
                    .shared_identity(&self.host, &id)?
                    == identity,
            "RESYNC_REQUIRED"
        );
        ensure!(
            self.host
                .subscription_model_catalog(&source)
                .map_err(|_| fail("CORE_UNAVAILABLE"))?
                == subscription,
            "RESYNC_REQUIRED"
        );
        let accepted = self.accepted_model(&source, core["lastAcceptedModel"].clone())?;
        let result = json!({"projectId":project,"gatewayGeneration":self.generation,"grantRevision":self.grant["revision"],"serviceGeneration":generation,"models":catalog(models, subscription.as_ref(), &remembered),"lastAcceptedModel":accepted});
        ensure!(
            serde_json::to_vec(&result)?.len() <= 128 * 1024,
            "LIMIT_EXCEEDED"
        );
        Ok(result)
    }
}

fn mark_checking(models: &mut [Value]) {
    for model in models {
        if model["available"] == true {
            model.as_object_mut().unwrap().remove("available");
            model["availability"] = json!("checking");
        }
    }
}

pub(crate) fn projectless_models(host: &Host, source: &str, options: &Value) -> Result<Value> {
    let mut inputs = crate::server::workbench_utility::inputs(options)?;
    for (name, value) in host.gateway.workbench.environment_credentials(source) {
        inputs.env.insert(name.into(), value.into());
    }
    let references: Vec<_> = host
        .migration
        .vault
        .provider_references(source)?
        .into_iter()
        .collect();
    for name in &references {
        inputs.env.remove(std::ffi::OsStr::new(name));
    }
    let config = areal_config::models::read(&inputs, &references)?;
    let mut rows = configured_models(&config);
    let effective = &config.effective["model"];
    if let Some(name) = effective["name"].as_str().filter(|name| !name.is_empty()) {
        let configured = rows
            .iter()
            .find(|row| row["providerId"] == effective["provider"] && row["modelId"] == name)
            .cloned();
        let mut parameters = json!({});
        for (key, field) in [
            ("temperature", "temperature"),
            ("max_output_tokens", "maxOutputTokens"),
            ("context_window_tokens", "contextWindowTokens"),
            ("reasoning_effort", "reasoningEffort"),
            ("service_tier", "serviceTier"),
        ] {
            if !effective[key].is_null() {
                parameters[field] = effective[key].clone();
            }
        }
        let available = configured
            .as_ref()
            .map(|row| row["available"] != false)
            .unwrap_or_else(|| {
                effective["endpoint"]
                    .as_str()
                    .is_some_and(|value| !value.is_empty())
                    && effective["api_key_env"].as_str().is_none_or(|key| {
                        inputs
                            .env
                            .get(std::ffi::OsStr::new(key))
                            .is_some_and(|value| !value.is_empty())
                    })
            });
        let mut row = json!({"providerId":null,"modelId":name,"displayName":configured.as_ref().map(|row|row["displayName"].clone()).unwrap_or(json!(name)),"available":available,"isDefault":!rows.iter().any(|row|row["isDefault"]==true),"parameters":parameters,"reasoningEffortOptions":configured.as_ref().map(|row|row["reasoningEffortOptions"].clone()).unwrap_or(json!([]))});
        if let Some(caps) = configured.as_ref().and_then(|row| row.get("capabilities")) {
            row["capabilities"] = caps.clone();
        }
        rows.insert(0, row);
    }
    let subscription = host.subscription_model_catalog(source)?;
    let mut models = catalog(&rows, subscription.as_ref(), &[]);
    for row in &mut models {
        if row.get("available").is_none() {
            row["available"] =
                json!(row["credentialState"] == "checking" || row["providerId"] == "areal_openai");
        }
        if row.get("parameters").is_none() {
            row["parameters"] = json!({});
        }
        if row["providerId"] == "areal_openai" {
            row["isDefault"] = json!(
                config
                    .default_model
                    .as_ref()
                    .is_some_and(|selected| selected.provider_id == "areal_openai"
                        && row["modelId"] == selected.model_id)
            );
        } else if row.get("isDefault").is_none() {
            row["isDefault"] = json!(false);
        }
        if row.get("reasoningEffortOptions").is_none() {
            row["reasoningEffortOptions"] = json!([]);
        }
    }
    if models
        .iter()
        .any(|row| !row["providerId"].is_null() && row["isDefault"] == true)
    {
        for row in &mut models {
            if row["providerId"].is_null() {
                row["isDefault"] = json!(false);
            }
        }
    }
    let home = crate::server::library_store::source_home(host, source)?;
    let accepted: Option<areal_protocol::host::WorkbenchCreationAcceptedModel> =
        storage::read_optional(&home.join("model-selection.json"))?;
    Ok(json!({"models":models,"lastAcceptedModel":accepted}))
}

fn configured_models(config: &areal_config::models::ModelConfiguration) -> Vec<Value> {
    config.data.iter().filter(|provider| provider.enabled).flat_map(|provider| {
        let stored = matches!(config.credential_sources.get(&provider.id),
            Some(areal_config::models::CredentialSource::Stored));
        let available = matches!(config.credential_states.get(&provider.id),
            Some(areal_config::models::CredentialState::Available | areal_config::models::CredentialState::NotRequired));
        provider.models.iter().filter(|model| model.enabled).map(move |model| {
            let mut value = json!({"providerId":provider.id, "modelId":model.id,
                "providerName":provider.name, "providerRevision":null,
                "displayName":model.display_name.as_deref().unwrap_or(&model.id),
                "parameters":model.parameters.overlay(&provider.parameters),
                "isDefault":config.default_model.as_ref().is_some_and(|selected|
                    selected.provider_id == provider.id && selected.model_id == model.id),
                "credentialState":if stored {json!("checking")} else {serde_json::to_value(config.credential_states.get(&provider.id)).unwrap_or(Value::Null)},
                "reasoningEffortOptions": model.capabilities.as_ref()
                    .and_then(|caps| caps.reasoning_effort_options.clone()).unwrap_or_default()});
            if let Some(capabilities) = &model.capabilities {
                value["capabilities"] = serde_json::to_value(capabilities).unwrap();
            }
            if !stored {
                value["available"] = json!(available);
            }
            value
        })
    }).collect()
}

/// 只投影 Core 当前连接公开声明的功能，界面据此显示入口；不据此授权。
fn public_features(caps: &Value) -> Value {
    let methods: std::collections::HashSet<&str> = caps["methods"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let supports = |required: &[&str]| required.iter().all(|method| methods.contains(method));
    let features = &caps["features"];
    let flag = |name: &str| features[name] == true;
    let derivation = &features["conversationDerivationV1"];
    let lists = |field: &str, value: &str| {
        derivation[field]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item == value))
    };
    json!({
        "conversation": supports(&["thread/start", "turn/start"]),
        "promptPrediction": supports(&["areal/thread/prediction"]),
        "ordinaryTurnSubmit": supports(&["areal/turn/submit"]) && flag("ordinaryTurnSubmit"),
        "editLastMessage": supports(&["areal/turn/submit"]) && flag("editLastMessage"),
        "permissionPresets": flag("permissionPresets"),
        "permissionFullAccess": flag("permissionFullAccess"),
        "forkPreview": supports(&["areal/thread/fork", "areal/conversation/history"])
            && lists("workspaceModes", "sharedCurrent"),
        "sideExecutableV2": supports(&["areal/side/create", "areal/side/close"])
            && flag("sideExecutableV2"),
        "sidePreview": supports(&["areal/side/start", "areal/side/context/read"])
            && lists("sideWorkspaceAccess", "none"),
        "sideWorkspaceRead": supports(&["areal/side/start"])
            && lists("sideWorkspaceAccess", "readOnly"),
        "goals": supports(&["areal/goal/create", "areal/goal/get"]),
        "tasks": supports(&["areal/task/create", "areal/inbox/list"]),
        "processes": supports(&[
            "areal/process/start", "areal/process/list", "areal/process/get",
            "areal/process/read", "areal/process/write", "areal/process/closeStdin",
            "areal/process/wait", "areal/process/terminate", "areal/process/resize",
        ]),
        "executions": supports(&["areal/agent/delegate", "areal/execution/list", "areal/execution/read"]),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_catalog_bounds_and_redacts_existing_core_models() {
        let core: Vec<_> = (0..210).map(|index| json!({"providerId":"provider","modelId":format!("model-{index}"),"available":false,"reasoningEffortOptions":["high"],"unavailableReason":"Unavailable","endpoint":"private-endpoint","apiKey":"private-key","providerRevision":1})).collect();
        let models = catalog(&core, None, &[]);
        assert_eq!(models.len(), 200);
        assert_eq!(
            models[0],
            json!({"providerId":"provider","modelId":"model-0","providerRevision":1,"displayName":"model-0","available":false,"reasoningEffortOptions":["high"],"unavailableReason":"Unavailable"})
        );
        assert!(!serde_json::to_string(&models).unwrap().contains("private-"));
        assert!(catalog(&[], None, &[]).is_empty());
    }

    #[test]
    fn checking_uses_current_core_and_observed_candidates_without_claiming_availability() {
        let core = [
            json!({"providerId":"areal_openai","modelId":"configured","displayName":"Applied name","available":true}),
            json!({"providerId":"areal_openai","modelId":"invalid","invalidReason":"MODEL_NOT_CONFIGURED","available":true}),
        ];
        let subscription = json!({"authenticated":true,"availability":"checking","models":[{"id":"cached","name":"Catalog name","reasoningEffortOptions":["low"]}]});
        let remembered = [
            json!({"providerId":"areal_openai","modelId":"last"}),
            json!({"providerId":"areal_openai","modelId":"observed"}),
            json!({"providerId":"areal_openai","modelId":"cached"}),
            json!({"providerId":"other","modelId":"ignored"}),
        ];
        let models = catalog(&core, Some(&subscription), &remembered);
        assert_eq!(models.len(), 5);
        assert_eq!(models[0]["displayName"], "Applied name");
        assert_eq!(models[1]["available"], false);
        assert_eq!(models[2]["displayName"], "Catalog name");
        assert_eq!(models[2]["reasoningEffortOptions"], json!(["low"]));
        for model in models.iter().filter(|model| model["modelId"] != "invalid") {
            assert!(model.get("available").is_none());
        }
        assert_eq!(models[3]["modelId"], "last");
        assert_eq!(models[4]["modelId"], "observed");
    }

    #[test]
    fn ready_and_signed_out_use_the_host_account_catalog() {
        let core = [
            json!({"providerId":"areal_openai","modelId":"present","displayName":"Old name","available":false}),
            json!({"providerId":"areal_openai","modelId":"removed","available":true}),
        ];
        let remembered = [json!({"providerId":"areal_openai","modelId":"previous"})];
        let subscription = json!({"authenticated":true,"availability":"available","models":[{"id":"present","name":"Account name"},{"id":"new","name":"New account model"}]});
        let models = catalog(&core, Some(&subscription), &remembered);
        assert_eq!(models.len(), 3);
        assert_eq!(models[0]["displayName"], "Account name");
        assert_eq!(models[0]["available"], true);
        assert_eq!(models[1]["available"], false);
        assert_eq!(models[2]["available"], true);
        let signed_out = catalog(
            &core,
            Some(&json!({"authenticated":false,"availability":"unavailable","models":[]})),
            &remembered,
        );
        assert_eq!(signed_out.len(), 2);
        assert!(signed_out.iter().all(|model| model["available"] == false));
        assert!(
            catalog(&core, None, &remembered)
                .iter()
                .all(|model| model["available"] == false)
        );
    }
}
