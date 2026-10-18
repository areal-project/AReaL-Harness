//! 默认模型按提交固定版本；更新只改变后续提交，不改写已受理的工作。
use super::*;
use areal_protocol::desktop::EffectiveConfig;

#[derive(Default)]
pub(crate) struct DefaultModels {
    current: Option<String>,
    versions: BTreeMap<String, Arc<dyn Model>>,
}

impl Engine {
    pub fn register_default_model(&self, revision: String, model: Arc<dyn Model>, current: bool) {
        let mut models = self.default_models.write().unwrap();
        models
            .versions
            .insert(revision.clone(), self.model.share_capacity(model));
        if current {
            models.current = Some(revision);
        }
    }

    pub(crate) fn default_model(&self) -> Arc<dyn Model> {
        let models = self.default_models.read().unwrap();
        models
            .current
            .as_ref()
            .and_then(|r| models.versions.get(r))
            .cloned()
            .unwrap_or_else(|| self.model.clone())
    }

    pub(crate) fn freeze_configuration(
        &self,
        mut configuration: EffectiveConfig,
    ) -> EffectiveConfig {
        if configuration.model.is_none() && configuration.default_model_revision.is_none() {
            configuration.default_model_revision =
                self.default_models.read().unwrap().current.clone();
        }
        configuration
    }

    pub(crate) fn default_model_for(
        &self,
        configuration: &EffectiveConfig,
    ) -> Result<Arc<dyn Model>> {
        match &configuration.default_model_revision {
            Some(revision) => self.default_models.read().unwrap().versions.get(revision).cloned()
                .ok_or_else(|| Error::Invalid("DEFAULT_MODEL_REVISION_UNAVAILABLE: restore its configuration and credential before resuming queued work".into())),
            None => Ok(self.default_model()),
        }
    }

    pub async fn set_configuration_status(&self, status: Value) {
        {
            let mut previous = self.configuration_status.write().unwrap();
            if *previous == status {
                return;
            }
            *previous = status.clone();
        }
        for cell in self.threads.read().await.values() {
            cell.emit(
                "areal/server/configurationChanged",
                json!({"threadId":cell.id,"configuration":status}),
            );
        }
    }
}
