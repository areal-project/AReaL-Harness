use super::*;
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
            value
        })
        .collect()
}

impl Session {
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
        self.model_catalog(project, generation, || self.observed_model(project))
            .await
    }

    pub(super) async fn model_catalog(
        &self,
        project: &str,
        generation: &str,
        observed_model: impl FnOnce() -> Result<Option<Value>>,
    ) -> Result<Value> {
        let (id, _) = self.project(project)?;
        let identity = self
            .host
            .schedules
            .connections
            .shared_identity(&self.host, &id)?;
        let subscription = self
            .host
            .subscription_model_catalog(&self.source_id)
            .map_err(|_| fail("CORE_UNAVAILABLE"))?;
        let core = self
            .rpc(project, generation, "areal/model/list", json!({}))
            .await;
        self.authorize(Some(project), "observe")?;
        ensure!(
            self.project(project)
                .is_ok_and(|(_, current)| current == generation)
                && self
                    .host
                    .schedules
                    .connections
                    .shared_identity(&self.host, &id)
                    .ok()
                    .as_ref()
                    == Some(&identity),
            "RESYNC_REQUIRED"
        );
        let core = core?;
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
                .subscription_model_catalog(&self.source_id)
                .map_err(|_| fail("CORE_UNAVAILABLE"))?
                == subscription,
            "RESYNC_REQUIRED"
        );
        let result = json!({"projectId":project,"gatewayGeneration":self.generation,"grantRevision":self.grant["revision"],"serviceGeneration":generation,"models":catalog(models, subscription.as_ref(), &remembered)});
        ensure!(
            serde_json::to_vec(&result)?.len() <= 128 * 1024,
            "LIMIT_EXCEEDED"
        );
        Ok(result)
    }
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
            json!({"providerId":"provider","modelId":"model-0","displayName":"model-0","available":false,"reasoningEffortOptions":["high"],"unavailableReason":"Unavailable"})
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
