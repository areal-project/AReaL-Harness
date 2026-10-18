//! 文件更新先完整校验并持久化模型版本；失败时保留当前配置。
use anyhow::{Result, ensure};
use areal_config::{ConfigInputs, ModelProtocolConfig, ResolvedCoreConfig, SelectedModelConfig};
use areal_engine::{
    Engine,
    model::{
        CredentialUnavailableModel, HttpModel, Model, ModelOptions, ModelProtocol,
        UnconfiguredModel,
    },
};
use serde_json::{Value, json, value::RawValue};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path, sync::Arc, time::Duration};

pub fn model(
    config: &SelectedModelConfig,
    inputs: &ConfigInputs,
    data: &Path,
    allow_missing_credential: bool,
) -> Result<Arc<dyn Model>> {
    if config.name.is_empty() || config.endpoint.is_empty() {
        return Ok(Arc::new(UnconfiguredModel));
    }
    let credential = match config.credential(inputs) {
        Ok(credential) => credential,
        Err(error)
            if allow_missing_credential
                && error.kind == areal_config::ConfigErrorKind::MissingValue =>
        {
            return Ok(Arc::new(CredentialUnavailableModel {
                name: config.name.clone(),
                provider: config.provider.clone(),
                credential_env: config
                    .api_key_env
                    .clone()
                    .expect("missing credential requires a reference"),
            }));
        }
        Err(error) => return Err(error.into()),
    };
    Ok(Arc::new(
        HttpModel::with_protocol(
            config.endpoint.clone(),
            config.name.clone(),
            credential,
            match config.protocol {
                ModelProtocolConfig::ChatCompletions => ModelProtocol::ChatCompletions,
                ModelProtocolConfig::Responses => ModelProtocol::Responses,
            },
        )?
        .with_audit_directory(data.join("model-requests"))
        .with_options(ModelOptions {
            context_window_tokens: config.context_window_tokens,
            responses_websocket: config.responses_websocket,
            reasoning_effort: config.reasoning_effort.clone(),
            summary_reasoning_effort: config.summary_reasoning_effort.clone(),
            summary_max_output_tokens: config.summary_max_output_tokens,
            reasoning_summary: config.reasoning_summary.clone(),
            max_output_tokens: config.max_output_tokens,
            max_request_bytes: config.max_request_bytes,
            max_retries: config.max_retries,
            temperature: config.temperature,
            top_p: config.top_p,
            top_k: config.top_k,
            min_p: config.min_p,
            presence_penalty: config.presence_penalty,
            repetition_penalty: config.repetition_penalty,
        })?,
    ))
}

fn deployment(config: &ResolvedCoreConfig) -> Value {
    let mut value = config.diagnostic(false);
    if config.model_catalog_managed {
        // 共享目录采用显式安全应用；普通 CLI 文件保留已有默认模型重载语义。
        value["modelCatalog"] = json!(config.model_catalog);
    } else {
        value.as_object_mut().unwrap().remove("model");
    }
    value
}

pub struct Reload {
    inputs: ConfigInputs,
    deployment: Value,
    models: BTreeMap<String, Box<RawValue>>,
    current: String,
    data: std::path::PathBuf,
}

impl Reload {
    pub fn open(
        inputs: ConfigInputs,
        config: &ResolvedCoreConfig,
        engine: &Engine,
    ) -> Result<Self> {
        let path = config.data_dir.join("desktop/default-models.json");
        std::fs::create_dir_all(path.parent().unwrap())?;
        let models: BTreeMap<String, Box<RawValue>> = if path.exists() {
            ensure!(
                path.metadata()?.len() <= 1024 * 1024,
                "model configuration archive exceeds 1 MiB"
            );
            serde_json::from_slice(&std::fs::read(&path)?)?
        } else {
            BTreeMap::new()
        };
        ensure!(
            models.len() <= 128,
            "model configuration archive exceeds 128 revisions"
        );
        for (revision, encoded) in &models {
            // 校验原始登记字节，不能用新增默认字段后的重编码推断旧版本损坏。
            // 后续保存保留原字节，已有 Turn 引用的 revision 不被重写。
            ensure!(
                *revision == format!("{:x}", Sha256::digest(encoded.get().as_bytes())),
                "model configuration archive digest mismatch"
            );
            let previous: SelectedModelConfig = serde_json::from_str(encoded.get())?;
            // 退役凭据缺失不阻止服务启动；使用该版本的队列恢复会明确拒绝。
            if let Ok(model) = model(&previous, &inputs, &config.data_dir, false) {
                engine.register_default_model(revision.clone(), model, false);
            }
        }
        let mut reload = Self {
            inputs,
            deployment: deployment(config),
            models,
            current: String::new(),
            data: config.data_dir.clone(),
        };
        reload.apply(&config.model, engine, true)?;
        Ok(reload)
    }

    fn apply(
        &mut self,
        config: &SelectedModelConfig,
        engine: &Engine,
        startup: bool,
    ) -> Result<()> {
        let revision = config.fingerprint();
        if revision == self.current {
            return Ok(());
        }
        let model = model(config, &self.inputs, &self.data, startup)?;
        let mut candidate = self.models.clone();
        candidate.insert(revision.clone(), serde_json::value::to_raw_value(config)?);
        ensure!(
            candidate.len() <= 128,
            "model configuration archive is full (128 revisions); retain queued history and use another data directory"
        );
        let bytes = serde_json::to_vec(&candidate)?;
        ensure!(
            bytes.len() <= 1024 * 1024,
            "model configuration archive exceeds 1 MiB"
        );
        let mut file = tempfile::NamedTempFile::new_in(self.data.join("desktop"))?;
        use std::io::Write;
        file.write_all(&bytes)?;
        file.as_file().sync_all()?;
        file.persist(self.data.join("desktop/default-models.json"))?;
        std::fs::File::open(self.data.join("desktop"))?.sync_all()?;
        engine.register_default_model(revision.clone(), model, true);
        self.models = candidate;
        self.current = revision;
        Ok(())
    }

    pub async fn run(mut self, engine: Arc<Engine>) {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        engine
            .set_configuration_status(
                json!({"modelRevision":self.current,"restartRequired":false,"error":null}),
            )
            .await;
        let mut pending = None;
        loop {
            interval.tick().await;
            let result = match areal_config::load_management_config(&self.inputs) {
                Ok(config) => {
                    let candidate = (deployment(&config), config.model.fingerprint());
                    // 连续两次读到同一有效配置后再应用，兼容编辑器的替换保存与连续写入。
                    if pending.as_ref() != Some(&candidate) {
                        pending = Some(candidate);
                        continue;
                    }
                    if candidate.0 != self.deployment {
                        Ok(true)
                    } else {
                        self.apply(&config.model, &engine, false).map(|()| false)
                    }
                }
                Err(error) => {
                    pending = None;
                    Err(anyhow::Error::from(error))
                }
            };
            let (restart, error) = match result {
                Ok(restart) => (restart, None),
                Err(error) => (requires_fresh_credentials(&error), Some(error.to_string())),
            };
            engine
                .set_configuration_status(
                    json!({"modelRevision":self.current,"restartRequired":restart,"error":error}),
                )
                .await;
        }
    }
}

fn requires_fresh_credentials(error: &anyhow::Error) -> bool {
    // 新终端可提供旧服务环境中不存在的凭据；客户端仍须先校验自身配置再安全重启。
    error
        .downcast_ref::<areal_config::ConfigError>()
        .is_some_and(|error| {
            error.kind == areal_config::ConfigErrorKind::MissingValue
                && error.field.starts_with("model.providers.")
                && error.field.ends_with(".api_key_env")
                && matches!(error.source, areal_config::ConfigSource::Env { .. })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn management_model_rejects_missing_credential_before_network() {
        let mut inputs = ConfigInputs::default();
        inputs.cwd = std::env::current_dir().unwrap();
        inputs.homedir = Some(inputs.cwd.clone());
        inputs.overrides.model = Some("test".into());
        inputs.overrides.model_endpoint = Some("http://127.0.0.1:1/v1/chat/completions".into());
        inputs.overrides.api_key_env = Some("GROK_API_KEY".into());
        let config = areal_config::load_management_config(&inputs).unwrap();
        let unavailable = model(&config.model, &inputs, &config.data_dir, true).unwrap();
        let error = unavailable.check_work().unwrap_err().to_string();
        assert!(error.contains("MODEL_CREDENTIAL_UNAVAILABLE"));
        assert!(error.contains("GROK_API_KEY"));
        assert!(
            unavailable
                .configure(&Default::default())
                .unwrap()
                .check_work()
                .unwrap_err()
                .to_string()
                .contains("MODEL_CREDENTIAL_UNAVAILABLE")
        );
        assert!(model(&config.model, &inputs, &config.data_dir, false).is_err());
    }

    #[test]
    fn missing_credential_on_reload_preserves_last_valid_revision() {
        let temp = tempfile::tempdir().unwrap();
        let mut inputs = ConfigInputs {
            cwd: temp.path().into(),
            homedir: Some(temp.path().into()),
            ..Default::default()
        };
        inputs.overrides.model = Some("valid".into());
        inputs.overrides.model_endpoint = Some("http://127.0.0.1:1/v1/chat/completions".into());
        let valid = areal_config::load_config(&inputs).unwrap();
        let engine =
            Engine::open(temp.path(), Arc::new(UnconfiguredModel), Default::default()).unwrap();
        let mut reload = Reload::open(inputs.clone(), &valid, &engine).unwrap();
        let revision = reload.current.clone();
        inputs.overrides.api_key_env = Some("MISSING_KEY".into());
        let unavailable = areal_config::load_management_config(&inputs).unwrap();
        let error = reload
            .apply(&unavailable.model, &engine, false)
            .unwrap_err();
        assert!(requires_fresh_credentials(&error));
        assert!(!requires_fresh_credentials(&anyhow::anyhow!(
            "archive full"
        )));
        assert_eq!(reload.current, revision);
        assert_eq!(reload.models.len(), 1);
    }
    #[test]
    fn model_archive_keeps_original_revision_bytes_across_optional_field_additions() {
        for variant in 0..4 {
            let temp = tempfile::tempdir().unwrap();
            let mut inputs = ConfigInputs {
                cwd: temp.path().into(),
                homedir: Some(temp.path().into()),
                ..Default::default()
            };
            inputs.overrides.model = Some("valid".into());
            inputs.overrides.model_endpoint = Some("http://127.0.0.1:1/v1/chat/completions".into());
            inputs.overrides.data_dir = Some(temp.path().to_path_buf());
            let config = areal_config::load_config(&inputs).unwrap();
            let mut encoded = serde_json::to_string(&config.model).unwrap();
            assert!(!encoded.contains("summary_reasoning_effort"));
            assert!(!encoded.contains("responses_websocket"));
            if variant == 1 || variant == 2 {
                encoded = encoded.replace(
                    ",\"temperature\":",
                    ",\"responses_websocket\":false,\"temperature\":",
                );
            }
            if variant == 2 {
                encoded = encoded.replace(",\"reasoning_summary\":", ",\"summary_reasoning_effort\":null,\"summary_max_output_tokens\":null,\"reasoning_summary\":");
            }
            if variant == 3 {
                encoded = encoded.replace(",\"temperature\":", ",\"summary_reasoning_effort\":\"low\",\"summary_max_output_tokens\":4096,\"temperature\":");
            }
            let revision = format!("{:x}", Sha256::digest(encoded.as_bytes()));
            let path = config.data_dir.join("desktop/default-models.json");
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, format!("{{\"{revision}\":{encoded}}}")).unwrap();
            let engine =
                Engine::open(temp.path(), Arc::new(UnconfiguredModel), Default::default()).unwrap();
            let reload = Reload::open(inputs.clone(), &config, &engine).unwrap();
            assert_eq!(reload.models[&revision].get(), encoded);
            let stored: BTreeMap<String, Box<RawValue>> =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            assert_eq!(stored[&revision].get(), encoded);
            drop(reload);
            let again = Reload::open(inputs.clone(), &config, &engine).unwrap();
            assert_eq!(again.models[&revision].get(), encoded);
            // 兼容只保留原字节，不豁免完整性校验。
            let corrupted = std::fs::read_to_string(&path)
                .unwrap()
                .replace("valid", "tampered");
            std::fs::write(&path, corrupted).unwrap();
            assert!(
                Reload::open(inputs, &config, &engine)
                    .err()
                    .unwrap()
                    .to_string()
                    .contains("digest mismatch")
            );
        }
    }
}
