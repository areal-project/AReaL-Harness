use super::*;
use serde_json::value::RawValue;

pub struct PreparedModelConfiguration {
    pub catalog: ConfiguredModels,
    pub credentials: BTreeMap<String, String>,
    pub default_revision: String,
    pub default_model: Arc<dyn Model>,
    pub default_name: String,
    pub default_parameters: ModelParameters,
    pub archive: BTreeMap<String, Box<RawValue>>,
    pub status: Value,
}

impl Engine {
    pub fn check_configured_credentials(&self, additions: &BTreeMap<String, String>) -> Result<()> {
        let credentials = self.desktop.credentials.read().unwrap();
        if additions
            .iter()
            .any(|(name, value)| credentials.get(name).is_some_and(|old| old != value))
        {
            return Err(invalid("credential references are immutable"));
        }
        Ok(())
    }

    pub fn model_configuration_status(&self) -> Value {
        self.configuration_status.read().unwrap().clone()
    }

    pub async fn apply_configured_models(
        &self,
        expected: AppliedModelConfiguration,
        prepared: PreparedModelConfiguration,
    ) -> Result<Value> {
        let _admission = self.desktop.lifecycle.gate.lock().await;
        if !self.accepting_work()
            || self.server_status().await["lifecycle"]["ifIdle"]["allowed"] != true
        {
            return Err(invalid(
                "MODEL_CONFIGURATION_BUSY: service must be idle and accepting work",
            ));
        }
        if self.configuration_status.read().unwrap()["applied"] != json!(expected) {
            return Err(Error::Conflict);
        }
        let _catalog_write = self.desktop.catalog_write.lock().await;
        {
            let _configuration = self.desktop.model_configuration.write().unwrap();
            let mut catalog = self.desktop.catalog.write().unwrap();
            let mut credentials = self.desktop.credentials.write().unwrap();
            for (reference, value) in &prepared.credentials {
                if !valid_id(reference)
                    || value.is_empty()
                    || credentials.get(reference).is_some_and(|old| old != value)
                {
                    return Err(invalid("credential references are immutable"));
                }
            }
            let candidate =
                catalog::configured_catalog(&catalog, &prepared.catalog).map_err(invalid)?;
            self.store
                .save_metadata_sync("default-models", &prepared.archive)
                .map_err(invalid)?;
            self.store
                .save_metadata_sync("catalog", &candidate)
                .map_err(invalid)?;
            credentials.extend(prepared.credentials);
            *catalog = candidate;
            *self.desktop.configured_models.write().unwrap() = prepared.catalog;
            self.register_default_model_metadata(
                prepared.default_revision.clone(),
                prepared.default_name,
                prepared.default_parameters,
            );
            self.register_default_model(prepared.default_revision, prepared.default_model, true);
            *self.configuration_status.write().unwrap() = prepared.status.clone();
        }
        self.emit_model_catalog_changed();
        for cell in self.threads.read().await.values() {
            cell.emit(
                "areal/server/configurationChanged",
                json!({"threadId":cell.id,"configuration":prepared.status}),
            );
        }
        Ok(prepared.status)
    }
}
