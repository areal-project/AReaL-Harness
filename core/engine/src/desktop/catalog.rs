use super::skills::Skill;
use super::*;
use areal_config::skills::MAX_REGISTERED_SKILLS;
use std::collections::BTreeSet;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Deployment {
    #[serde(default)]
    pub workflows: Vec<Workflow>,
    #[serde(default)]
    pub profiles: Vec<AgentProfile>,
    #[serde(default)]
    pub skills: Vec<SkillLocation>,
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Catalog {
    #[serde(default)]
    pub(super) workflows: BTreeMap<String, Workflow>,
    #[serde(default)]
    pub(super) providers: BTreeMap<String, Provider>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    configured_provider_ids: BTreeSet<String>,
    #[serde(default)]
    profiles: BTreeMap<String, AgentProfile>,
    // 接受旧目录格式并丢弃内容哈希；资源不再由启动快照固定。
    #[serde(default, rename = "skillHashes", skip_serializing)]
    _legacy_skill_hashes: serde::de::IgnoredAny,
    #[serde(skip)]
    pub(crate) skills: BTreeMap<String, Skill>,
}
impl Catalog {
    pub fn load(root: &Path) -> anyhow::Result<Self> {
        let path = root.join("desktop/catalog.json");
        if !path.exists() {
            return Ok(Self::default());
        }
        anyhow::ensure!(
            std::fs::metadata(&path)?.len() <= 2 * 1024 * 1024,
            "desktop catalog exceeds 2 MiB"
        );
        Ok(serde_json::from_slice(&std::fs::read(path)?)?)
    }
}
fn key(id: &str, revision: &str) -> String {
    format!("{id}/{revision}")
}

/// 可信启动配置的执行投影；文件路径、解析和写入不进入 Engine。
#[derive(Clone, Default)]
pub struct ConfiguredModels {
    pub responses_prompt_cache: bool,
    pub providers: Vec<Provider>,
    pub provider_ids: BTreeSet<String>,
    pub parameters: BTreeMap<(String, String), ModelParameters>,
    pub credential_environments: BTreeMap<(String, String), String>,
    pub default_model: Option<ModelRef>,
}

pub(super) fn configured_catalog(
    catalog: &Catalog,
    configured: &ConfiguredModels,
) -> anyhow::Result<Catalog> {
    let mut candidate = catalog.clone();
    for id in &catalog.configured_provider_ids {
        candidate.providers.remove(id);
    }
    for id in &configured.provider_ids {
        candidate.providers.remove(id);
    }
    for provider in &configured.providers {
        anyhow::ensure!(
            valid_id(&provider.id) && configured.provider_ids.contains(&provider.id),
            "invalid configured provider identity"
        );
        let mut provider = provider.clone();
        let previous = catalog.providers.get(&provider.id);
        provider.revision = previous.map_or(1, |old| old.revision);
        if previous.is_some_and(|old| old != &provider) {
            provider.revision += 1;
        }
        candidate.providers.insert(provider.id.clone(), provider);
    }
    candidate.configured_provider_ids = configured.provider_ids.clone();
    anyhow::ensure!(
        candidate.providers.len() <= 32 && serde_json::to_vec(&candidate)?.len() <= 2 * 1024 * 1024,
        "desktop provider catalog exceeds capacity"
    );
    Ok(candidate)
}

impl Engine {
    /// 只在启动装配期间调用。旧投影在落盘后替换，已持久化的任务配置保持原样。
    pub fn install_configured_models(&self, configured: ConfiguredModels) -> anyhow::Result<()> {
        let mut catalog = self.desktop.catalog.write().unwrap();
        let candidate = configured_catalog(&catalog, &configured)?;
        self.store.save_metadata_sync("catalog", &candidate)?;
        *catalog = candidate;
        *self.desktop.configured_models.write().unwrap() = configured;
        Ok(())
    }

    /// 仅可信装配入口可注册资源路径；RPC 和模型只接收版本引用。
    pub fn install_deployment(&self, path: &Path) -> anyhow::Result<()> {
        anyhow::ensure!(
            std::fs::metadata(path)?.len() <= 1024 * 1024,
            "deployment exceeds 1 MiB"
        );
        let deployment: Deployment = serde_json::from_slice(&std::fs::read(path)?)?;
        self.install_deployment_data(
            deployment,
            path.parent().context("deployment directory missing")?,
        )
    }

    /// 可信启动器已解析目录和版本引用；默认配置只用于未显式指定 Profile 的新会话。
    pub fn install_default_skills(&self, skills: Vec<SkillLocation>) -> anyhow::Result<()> {
        if skills.is_empty() {
            return Ok(());
        }
        anyhow::ensure!(
            skills.iter().all(|s| s.root.is_absolute()),
            "discovered skill roots must be absolute"
        );
        let references: Vec<_> = skills
            .iter()
            .map(|s| VersionRef {
                id: s.id.clone(),
                revision: s.revision.clone(),
            })
            .collect();
        let reference = VersionRef {
            id: "areal-discovered-skills".into(),
            revision: digest(&references)?,
        };
        let profile: AgentProfile = serde_json::from_value(json!({
            "id": reference.id, "revision": reference.revision,
            "displayName": "Discovered skills", "instructions": "",
            "skills": references
        }))?;
        self.install_deployment_data(
            Deployment {
                profiles: vec![profile],
                skills,
                workflows: vec![],
            },
            Path::new("/"),
        )?;
        *self.desktop.default_profile.write().unwrap() = Some(reference);
        Ok(())
    }

    fn install_deployment_data(&self, deployment: Deployment, base: &Path) -> anyhow::Result<()> {
        anyhow::ensure!(
            deployment.profiles.len() <= 64 && deployment.skills.len() <= MAX_REGISTERED_SKILLS,
            "deployment catalog capacity exceeded: profiles {} (limit 64), skills {} (limit {MAX_REGISTERED_SKILLS})",
            deployment.profiles.len(),
            deployment.skills.len()
        );
        let mut guard = self.desktop.catalog.write().unwrap();
        let mut catalog = guard.clone();
        for location in deployment.skills {
            let skill = Skill::load(location, base)?;
            let location = &skill.location;
            catalog
                .skills
                .insert(key(&location.id, &location.revision), skill);
        }
        for profile in deployment.profiles {
            anyhow::ensure!(
                valid_id(&profile.id)
                    && valid_id(&profile.revision)
                    && profile.instructions.len() <= 32 * 1024,
                "invalid profile identity or instruction budget"
            );
            for skill in &profile.skills {
                anyhow::ensure!(
                    catalog
                        .skills
                        .contains_key(&key(&skill.id, &skill.revision)),
                    "profile references an unavailable skill revision"
                );
            }
            if let Some(names) = &profile.tool_allowlist {
                for name in names {
                    self.registry.get(name)?;
                }
            }
            let identity = key(&profile.id, &profile.revision);
            if let Some(previous) = catalog.profiles.get(&identity) {
                anyhow::ensure!(
                    previous == &profile,
                    "profile revision is immutable; register a new revision"
                );
            }
            catalog.profiles.insert(identity, profile);
        }
        anyhow::ensure!(
            deployment.workflows.len() <= 64,
            "workflow directory exceeds budget"
        );
        for workflow in deployment.workflows {
            anyhow::ensure!(
                valid_id(&workflow.id) && valid_id(&workflow.revision),
                "invalid workflow identity"
            );
            crate::workgroup::validate(&workflow.plan)?;
            for task in &workflow.plan.tasks {
                if let Some(config) = &task.configuration
                    && let Some(profile) = &config.agent_profile
                {
                    anyhow::ensure!(
                        catalog
                            .profiles
                            .contains_key(&key(&profile.id, &profile.revision)),
                        "workflow profile unavailable"
                    );
                }
            }
            let identity = key(&workflow.id, &workflow.revision);
            anyhow::ensure!(
                catalog
                    .workflows
                    .get(&identity)
                    .is_none_or(|old| old == &workflow),
                "workflow revision is immutable"
            );
            catalog.workflows.insert(identity, workflow);
        }
        for profile in catalog.profiles.values() {
            if let Some(workflow) = &profile.workflow {
                anyhow::ensure!(
                    catalog
                        .workflows
                        .contains_key(&key(&workflow.id, &workflow.revision)),
                    "profile references an unavailable workflow revision"
                );
            }
        }
        anyhow::ensure!(
            serde_json::to_vec(&catalog)?.len() <= 2 * 1024 * 1024,
            "desktop catalog exceeds 2 MiB; retain existing revisions and provision a new data directory"
        );
        self.store.save_metadata_sync("catalog", &catalog)?;
        *guard = catalog;
        Ok(())
    }
    /// 凭据值仅由可信宿主注入，不序列化到配置和历史。
    pub fn register_credential(&self, reference: String, value: String) -> Result<()> {
        if !valid_id(&reference) || value.is_empty() {
            return Err(invalid("invalid credential reference"));
        }
        let mut credentials = self.desktop.credentials.write().unwrap();
        if credentials
            .get(&reference)
            .is_some_and(|previous| previous != &value)
        {
            return Err(invalid("credential references are immutable"));
        }
        credentials.insert(reference, value);
        Ok(())
    }
    pub fn profiles(&self) -> Value {
        json!({"data":self.desktop.catalog.read().unwrap().profiles.values().collect::<Vec<_>>()})
    }
    pub fn profile(&self, reference: &VersionRef) -> Result<AgentProfile> {
        self.desktop
            .catalog
            .read()
            .unwrap()
            .profiles
            .get(&key(&reference.id, &reference.revision))
            .cloned()
            .ok_or(Error::NotFound)
    }
    pub fn providers(&self) -> Value {
        json!({"data":self.desktop.catalog.read().unwrap().providers.values().map(|p|self.provider_view(p)).collect::<Vec<_>>()})
    }
    pub fn provider_view(&self, provider: &Provider) -> Value {
        let mut value = json!(provider);
        value["credentialState"] = json!(match &provider.credential_ref {
            None => "notRequired",
            Some(reference)
                if self
                    .desktop
                    .credentials
                    .read()
                    .unwrap()
                    .contains_key(reference) =>
                "available",
            Some(_) => "unavailable",
        });
        // 配置可用不等于实际 API 认证或推理成功；连通性只由显式 probe 报告。
        value["connectionState"] = json!("unchecked");
        value
    }
    pub fn provider(&self, id: &str) -> Result<Provider> {
        self.desktop
            .catalog
            .read()
            .unwrap()
            .providers
            .get(id)
            .cloned()
            .ok_or(Error::NotFound)
    }
    pub async fn upsert_provider(
        self: &Arc<Self>,
        mut provider: Provider,
        expected: u64,
    ) -> Result<Provider> {
        self.mutate(move |engine| async move {
            let _lock = engine.desktop.catalog_write.lock().await;
            if engine
                .desktop
                .configured_models
                .read()
                .unwrap()
                .provider_ids
                .contains(&provider.id)
            {
                return Err(invalid(
                    "CONFIGURATION_MANAGED: edit the shared model configuration",
                ));
            }
            if !valid_id(&provider.id)
                || provider.models.is_empty()
                || provider.models.len() > 64
                || provider
                    .models
                    .iter()
                    .any(|s| s.is_empty() || s.len() > 256)
            {
                return Err(invalid("invalid provider ID or model catalog"));
            }
            let mut candidate = engine.desktop.catalog.read().unwrap().clone();
            let revision = candidate
                .providers
                .get(&provider.id)
                .map_or(0, |p| p.revision);
            if revision != expected {
                return Err(Error::Conflict);
            }
            if candidate.providers.len() >= 32 && revision == 0 {
                return Err(Error::Exhausted("provider capacity reached".into()));
            }
            provider.revision = revision + 1;
            if provider.context_source.is_some_and(|source| {
                !matches!(
                    source,
                    areal_protocol::context::ContextWindowSource::Account
                        | areal_protocol::context::ContextWindowSource::Provider
                )
            }) {
                return Err(invalid(
                    "provider context source must be account or provider",
                ));
            }
            for name in provider
                .model_capabilities
                .keys()
                .chain(provider.model_parameters.keys())
            {
                if !provider.models.contains(name) {
                    return Err(invalid("unknown model"));
                }
            }
            let mut unselected = provider.clone();
            unselected.model_capabilities.clear();
            engine.provider_model(&unselected, &provider.models[0], &provider.parameters, None)?;
            for (name, parameters) in &provider.model_parameters {
                engine.provider_model(&unselected, name, parameters, None)?;
            }
            for name in &provider.models {
                let reference = ModelRef {
                    provider_id: provider.id.clone(),
                    model_id: name.clone(),
                };
                let parameters = engine.model_parameters(&reference, &provider);
                engine.provider_model(&provider, name, &parameters, None)?;
            }
            candidate
                .providers
                .insert(provider.id.clone(), provider.clone());
            if serde_json::to_vec(&candidate).map_err(invalid)?.len() > 2 * 1024 * 1024 {
                return Err(Error::Exhausted("desktop catalog exceeds 2 MiB".into()));
            }
            engine
                .store
                .save_metadata("catalog", &candidate)
                .await
                .map_err(invalid)?;
            *engine.desktop.catalog.write().unwrap() = candidate;
            Ok(provider)
        })
        .await
    }
    pub async fn remove_provider(self: &Arc<Self>, id: String, expected: u64) -> Result<()> {
        self.mutate(move |engine| async move {
            let _lock = engine.desktop.catalog_write.lock().await;
            if engine
                .desktop
                .configured_models
                .read()
                .unwrap()
                .provider_ids
                .contains(&id)
            {
                return Err(invalid(
                    "CONFIGURATION_MANAGED: edit the shared model configuration",
                ));
            }
            let mut candidate = engine.desktop.catalog.read().unwrap().clone();
            if candidate
                .providers
                .get(&id)
                .ok_or(Error::NotFound)?
                .revision
                != expected
            {
                return Err(Error::Conflict);
            }
            let cells: Vec<_> = engine.threads.read().await.values().cloned().collect();
            for cell in cells {
                let state = cell.state.lock().await;
                if state.active.is_some()
                    && state
                        .thread
                        .turns
                        .last()
                        .and_then(|t| t.configuration.as_ref())
                        .and_then(|c| c.model.as_ref())
                        .is_some_and(|m| m.provider_id == id)
                {
                    return Err(Error::Conflict);
                }
            }
            candidate.providers.remove(&id);
            engine
                .store
                .save_metadata("catalog", &candidate)
                .await
                .map_err(invalid)?;
            *engine.desktop.catalog.write().unwrap() = candidate;
            Ok(())
        })
        .await
    }
    pub(super) fn provider_model(
        &self,
        provider: &Provider,
        name: &str,
        parameters: &ModelParameters,
        context_window: Option<&areal_protocol::context::ContextWindow>,
    ) -> Result<Arc<dyn Model>> {
        let mut factory = model::HttpModelFactory::default();
        self.provider_model_with_factory(provider, name, parameters, context_window, &mut factory)
    }
    pub(super) fn provider_model_with_factory(
        &self,
        provider: &Provider,
        name: &str,
        parameters: &ModelParameters,
        context_window: Option<&areal_protocol::context::ContextWindow>,
        factory: &mut model::HttpModelFactory,
    ) -> Result<Arc<dyn Model>> {
        let protocol = match provider.protocol.as_str() {
            "chatCompletions" => model::ModelProtocol::ChatCompletions,
            "responses" => model::ModelProtocol::Responses,
            _ => return Err(invalid("unsupported model protocol")),
        };
        if !provider.models.iter().any(|m| m == name) {
            return Err(invalid("unknown model"));
        }
        let credential = provider
            .credential_ref
            .as_ref()
            .map(|reference| {
                let credential = self
                    .desktop
                    .credentials
                    .read()
                    .unwrap()
                    .get(reference)
                    .cloned();
                credential.ok_or_else(|| {
                    let configured = self.desktop.configured_models.read().unwrap();
                    match configured
                        .credential_environments
                        .get(&(provider.id.clone(), reference.clone()))
                    {
                        Some(name) => invalid(format!(
                            "CREDENTIAL_UNAVAILABLE: provider '{}' requires environment variable '{}'. Set it to a nonempty valid HTTP header value in the Core launch environment, then restart Core or the shared service.",
                            provider.id, name
                        )),
                        None => invalid(format!(
                            "CREDENTIAL_UNAVAILABLE: configure credentials for provider '{}' in Core, then restart Core or the shared service.",
                            provider.id
                        )),
                    }
                })
            })
            .transpose()?;
        let model = factory
            .build(provider.endpoint.clone(), name.into(), credential, protocol)
            .map_err(invalid)?
            .with_audit_directory(self.store.root().join("model-requests"))
            .with_options(model::ModelOptions {
                responses_prompt_cache: protocol == model::ModelProtocol::Responses
                    && self
                        .desktop
                        .configured_models
                        .read()
                        .unwrap()
                        .responses_prompt_cache,
                capabilities: provider.model_capabilities.get(name).cloned(),
                context_window: Some(context_window.cloned().unwrap_or_else(|| {
                    self.provider_context_window(provider, name, parameters.context_window_tokens)
                })),
                context_window_tokens: parameters.context_window_tokens,
                reasoning_effort: parameters.reasoning_effort.clone(),
                reasoning_summary: parameters.reasoning_summary.clone(),
                max_output_tokens: parameters.max_output_tokens,
                max_retries: 0,
                ..Default::default()
            })
            .map_err(invalid)?
            .with_temperature(parameters.temperature)
            .map_err(invalid)?;
        Ok(self.model.share_capacity(Arc::new(model)))
    }
    pub(crate) fn configured_model(
        &self,
        configuration: &EffectiveConfig,
    ) -> Result<Arc<dyn Model>> {
        if self
            .desktop
            .worker_model
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Ok(self.model.clone());
        }
        match (&configuration.model, &configuration.provider) {
            (Some(model), Some(provider)) => self.provider_model(
                provider,
                &model.model_id,
                &configuration.parameters,
                configuration.context_window.as_ref(),
            ),
            (None, None) => {
                let model = self.default_model_for(configuration)?;
                if model.name().is_empty() {
                    return Err(invalid("MODEL_NOT_CONFIGURED"));
                }
                if configuration.parameters == ModelParameters::default() {
                    Ok(model)
                } else {
                    model.configure(&configuration.parameters).map_err(invalid)
                }
            }
            _ => Err(invalid("MODEL_NOT_CONFIGURED")),
        }
    }
    pub(crate) fn resolve_config(
        &self,
        profile: Option<VersionRef>,
        model: Option<ModelRef>,
        parameters: ModelParameters,
        revision: u64,
    ) -> Result<EffectiveConfig> {
        let _configuration = self.desktop.model_configuration.read().unwrap();
        let profile = profile.as_ref().map(|p| self.profile(p)).transpose()?;
        let model = model
            .or_else(|| profile.as_ref().and_then(|p| p.model.clone()))
            .or_else(|| {
                self.desktop
                    .configured_models
                    .read()
                    .unwrap()
                    .default_model
                    .clone()
            });
        let provider = model
            .as_ref()
            .map(|m| self.provider(&m.provider_id))
            .transpose()?;
        let defaults = match (&model, &provider) {
            (Some(model), Some(provider)) => self.model_parameters(model, provider),
            _ => self
                .default_model_metadata(None)
                .map(|(_, parameters)| parameters)
                .unwrap_or_default(),
        };
        let parameters = merge_model_parameters(parameters, defaults);
        let mut configuration = EffectiveConfig {
            permissions: None,
            context_window: match (&model, &provider) {
                (Some(model), Some(provider)) => Some(self.provider_context_window(
                    provider,
                    &model.model_id,
                    parameters.context_window_tokens,
                )),
                _ => None,
            },
            allow_plugin_skills: false,
            plugin_skills: None,
            default_model_revision: None,
            options: ClientOptions::default(),
            selected_skills: None,
            revision,
            model,
            provider,
            read_only: profile.as_ref().is_some_and(|p| p.read_only),
            tool_allowlist: profile.as_ref().and_then(|p| p.tool_allowlist.clone()),
            profile,
            parameters,
            instructions: String::new(),
        };
        self.pin_desktop_default(&mut configuration);
        self.validate_config_model(&configuration)?;
        Ok(configuration)
    }
    pub(crate) fn validate_config_model(&self, configuration: &EffectiveConfig) -> Result<()> {
        if configuration.model.is_some()
            || configuration.default_model_revision.is_some()
            || !self.default_model().name().is_empty()
        {
            let actual = self.configured_model(configuration)?;
            if configuration.profile.as_ref().is_some_and(|p| {
                p.required_modalities
                    .iter()
                    .any(|m| !actual.capabilities().supports_input(*m))
            }) {
                return Err(invalid("model does not meet profile modality requirements"));
            }
        }
        Ok(())
    }
    pub(crate) fn model_parameters(
        &self,
        model: &ModelRef,
        provider: &Provider,
    ) -> ModelParameters {
        let configured = self.desktop.configured_models.read().unwrap();
        let parameters = configured
            .parameters
            .get(&(model.provider_id.clone(), model.model_id.clone()))
            .cloned()
            .unwrap_or_default();
        let mut reported = provider
            .model_parameters
            .get(&model.model_id)
            .cloned()
            .unwrap_or_default();
        reported.context_window_tokens = None;
        let defaults = merge_model_parameters(reported, provider.parameters.clone());
        merge_model_parameters(parameters, defaults)
    }
    pub(crate) fn update_model_parameters(
        &self,
        configuration: &mut EffectiveConfig,
        parameters: ModelParameters,
    ) {
        let _configuration = self.desktop.model_configuration.read().unwrap();
        let defaults = match (&configuration.model, &configuration.provider) {
            (Some(model), Some(provider)) => self.model_parameters(model, provider),
            _ => self
                .default_model_metadata(configuration.default_model_revision.as_deref())
                .map(|(_, parameters)| parameters)
                .unwrap_or_default(),
        };
        configuration.parameters = merge_model_parameters(parameters, defaults);
        configuration.context_window = match (&configuration.model, &configuration.provider) {
            (Some(model), Some(provider)) => Some(self.provider_context_window(
                provider,
                &model.model_id,
                configuration.parameters.context_window_tokens,
            )),
            _ => None,
        };
    }

    pub(super) fn provider_context_window(
        &self,
        provider: &Provider,
        name: &str,
        user_budget_tokens: Option<usize>,
    ) -> areal_protocol::context::ContextWindow {
        use areal_protocol::context::{ContextWindow, ContextWindowSource as Source};
        let reported_window_tokens = provider
            .model_parameters
            .get(name)
            .and_then(|parameters| parameters.context_window_tokens);
        let reported_source = provider.context_source.unwrap_or(Source::Provider);
        let (window_tokens, source) = match (reported_window_tokens, user_budget_tokens) {
            (Some(reported), Some(user)) if user < reported => (user, Source::User),
            (Some(reported), _) => (reported, reported_source),
            (None, Some(user)) => (user, Source::User),
            (None, None) => {
                if reported_source != Source::Account
                    && let Some(window) = model::known_context_window(name)
                {
                    (window, Source::ModelDefault)
                } else {
                    (self.limits.context_window_tokens, Source::Fallback)
                }
            }
        };
        ContextWindow {
            window_tokens,
            source,
            reported_window_tokens,
            reported_window_source: reported_window_tokens.map(|_| reported_source),
            user_budget_tokens,
        }
    }

    pub(crate) fn next_request_configuration(
        &self,
        mut configuration: EffectiveConfig,
    ) -> EffectiveConfig {
        let (Some(model), Some(provider)) = (&configuration.model, &mut configuration.provider)
        else {
            return configuration;
        };
        let user_budget = configuration
            .context_window
            .as_ref()
            .map(|window| window.user_budget_tokens)
            .unwrap_or(configuration.parameters.context_window_tokens);
        if let Some(current) = self
            .desktop
            .catalog
            .read()
            .unwrap()
            .providers
            .get(&model.provider_id)
            && current.endpoint == provider.endpoint
            && current.protocol == provider.protocol
            && current.credential_ref == provider.credential_ref
            && current.models.contains(&model.model_id)
        {
            let reported = current
                .model_parameters
                .get(&model.model_id)
                .and_then(|parameters| parameters.context_window_tokens);
            if reported.is_some() || provider.model_parameters.contains_key(&model.model_id) {
                provider
                    .model_parameters
                    .entry(model.model_id.clone())
                    .or_default()
                    .context_window_tokens = reported;
                if provider.model_parameters[&model.model_id] == ModelParameters::default() {
                    provider.model_parameters.remove(&model.model_id);
                }
            }
            match current.model_capabilities.get(&model.model_id) {
                Some(capabilities) => {
                    provider
                        .model_capabilities
                        .insert(model.model_id.clone(), capabilities.clone());
                }
                None => {
                    provider.model_capabilities.remove(&model.model_id);
                }
            }
            provider.context_source = current.context_source;
        }
        configuration.parameters.context_window_tokens = user_budget;
        configuration.context_window =
            Some(self.provider_context_window(provider, &model.model_id, user_budget));
        configuration
    }
    fn selected_skill(
        &self,
        configuration: &EffectiveConfig,
        reference: &VersionRef,
    ) -> Result<Skill> {
        if !self
            .effective_skill_refs(configuration, false)
            .contains(reference)
        {
            return Err(invalid("skill is outside the effective profile"));
        }
        let catalog = self.desktop.catalog.read().unwrap();
        catalog
            .skills
            .get(&key(&reference.id, &reference.revision))
            .cloned()
            .ok_or_else(|| invalid("skill revision is unavailable"))
    }
    pub(crate) fn skill_summaries(&self, references: &[VersionRef]) -> Vec<Value> {
        let catalog = self.desktop.catalog.read().unwrap();
        // 描述共享有界提示预算，完整发现描述仍可通过 skill_list 查询。
        let budget = 32 * 1024 / references.len().max(1);
        references
            .iter()
            .map(|reference| {
                let metadata = catalog
                    .skills
                    .get(&key(&reference.id, &reference.revision))
                    .map(|skill| &skill.metadata);
                let description = metadata.map_or("", |m| m.description.as_str());
                let description =
                    &description[..description.floor_char_boundary(budget.min(description.len()))];
                json!({"id":reference.id,"revision":reference.revision,
                "name":metadata.map_or(reference.id.as_str(), |m| m.name.as_str()),
                "description":description})
            })
            .collect()
    }
    /// 草稿目录仅观察已登记 Profile，不创建 Thread 或读取技能正文。
    pub fn profile_skills(&self, reference: &VersionRef) -> Result<Value> {
        let profile = self.profile(reference)?;
        let refs = self.effective_skill_refs(
            &EffectiveConfig {
                allow_plugin_skills: profile.allow_plugin_skills,
                profile: Some(profile),
                ..Default::default()
            },
            false,
        );
        let catalog = self.desktop.catalog.read().unwrap();
        let data: Vec<_> = refs.iter().map(|r| {
            let skill = catalog.skills.get(&key(&r.id, &r.revision));
            json!({"id":r.id,"revision":r.revision,"available":skill.is_some(),
                "name":skill.map_or(r.id.as_str(), |s| s.metadata.name.as_str()),
                "description":skill.map_or("", |s| s.metadata.description.as_str()),
                "pluginId":skill.and_then(|s|s.plugin.as_ref().map(|p|p.plugin_id.as_str())),
                "allowImplicitInvocation":skill.and_then(|s|s.plugin.as_ref().map(|p|p.allow_implicit_invocation)),
                "resources":null,
                "resourceRoot":skill.map(|s| format!("areal://skill/{}/{}",s.location.id,s.location.revision))})
        }).collect();
        Ok(json!({"data":data}))
    }
    pub async fn skills(&self, thread_id: &str) -> Result<Value> {
        self.skills_for_turn(thread_id, None).await
    }
    pub(super) async fn skills_for_turn(
        &self,
        thread_id: &str,
        turn_id: Option<&str>,
    ) -> Result<Value> {
        self.refresh_plugins().await?;
        let cell = self.cell(thread_id).await?;
        let (config, loaded) = {
            let state = cell.state.lock().await;
            let config = self.skill_configuration(&state.thread, turn_id)?;
            (
                config,
                state
                    .thread
                    .desktop
                    .as_ref()
                    .map(|d| d.loaded_skills.clone()),
            )
        };
        let refs = self.effective_skill_refs(&config, turn_id.is_some());
        let catalog = self.desktop.catalog.read().unwrap();
        let data: Vec<_> = refs.iter().map(|r| {
            let skill = catalog.skills.get(&key(&r.id, &r.revision));
            json!({"id":r.id,"revision":r.revision,"available":skill.is_some(),
                "name":skill.map_or(r.id.as_str(), |s| s.metadata.name.as_str()),
                "description":skill.map_or("", |s| s.metadata.description.as_str()),
                "pluginId":skill.and_then(|s|s.plugin.as_ref().map(|p|p.plugin_id.as_str())),
                "allowImplicitInvocation":skill.and_then(|s|s.plugin.as_ref().map(|p|p.allow_implicit_invocation)),
                "resources":null,
                "resourceRoot":skill.map(|s| format!("areal://skill/{}/{}",s.location.id,s.location.revision))})
        }).collect();
        Ok(json!({"data":data,"loaded":loaded}))
    }
    fn skill_configuration(
        &self,
        thread: &Thread,
        turn_id: Option<&str>,
    ) -> Result<EffectiveConfig> {
        match turn_id {
            Some(id) => thread
                .turns
                .iter()
                .find(|t| t.id == id)
                .map(|t| t.configuration.clone().unwrap_or_default())
                .ok_or(Error::NotFound),
            None => Ok(desktop(thread).configuration),
        }
    }
    /// 新草稿预览只读 Profile 允许的资源，不登记 Thread 加载状态。
    pub async fn read_profile_skill(
        &self,
        profile: VersionRef,
        reference: VersionRef,
        resource: &str,
        offset: usize,
        max_bytes: usize,
    ) -> Result<Value> {
        self.refresh_plugins().await?;
        let profile = self.profile(&profile)?;
        let configuration = EffectiveConfig {
            allow_plugin_skills: profile.allow_plugin_skills,
            profile: Some(profile),
            ..Default::default()
        };
        let skill = self.selected_skill(&configuration, &reference)?;
        self.read_skill_page(skill, &reference, resource, offset, max_bytes)
            .await
    }
    async fn read_skill_page(
        &self,
        skill: Skill,
        reference: &VersionRef,
        resource: &str,
        offset: usize,
        max_bytes: usize,
    ) -> Result<Value> {
        if max_bytes == 0 || max_bytes > 8192 {
            return Err(invalid("maxBytes must be 1..8192"));
        }
        self.check_plugin_skill(&skill).await?;
        let page = skill
            .read(resource, offset, max_bytes)
            .await
            .map_err(|error| {
                if error.downcast_ref::<rustix::io::Errno>() == Some(&rustix::io::Errno::NOENT) {
                    Error::NotFound
                } else {
                    invalid(format!("{error:#}"))
                }
            })?;
        use base64::Engine as _;
        let end = offset + page.bytes.len();
        Ok(
            json!({"id":reference.id,"revision":reference.revision,"resource":resource,"sizeBytes":page.size,
            "dataBase64":base64::engine::general_purpose::STANDARD.encode(&page.bytes),"text":std::str::from_utf8(&page.bytes).ok(),"nextOffset":end,"eof":end>=page.size}),
        )
    }
    pub async fn read_skill(
        &self,
        thread_id: &str,
        reference: VersionRef,
        resource: &str,
        offset: usize,
        max_bytes: usize,
    ) -> Result<Value> {
        self.read_skill_for_turn(thread_id, None, reference, resource, offset, max_bytes)
            .await
    }
    pub(super) async fn read_skill_for_turn(
        &self,
        thread_id: &str,
        turn_id: Option<&str>,
        reference: VersionRef,
        resource: &str,
        offset: usize,
        max_bytes: usize,
    ) -> Result<Value> {
        self.refresh_plugins().await?;
        let cell = self.cell(thread_id).await?;
        let (config, mut thread) = {
            let state = cell.state.lock().await;
            (
                self.skill_configuration(&state.thread, turn_id)?,
                state.thread.clone(),
            )
        };
        if turn_id.is_some()
            && !self
                .effective_skill_refs(&config, true)
                .contains(&reference)
        {
            return Err(invalid("skill is not selected for this Turn"));
        }
        let skill = self.selected_skill(&config, &reference)?;
        if skill
            .plugin
            .as_ref()
            .is_some_and(|p| !p.required_tools.is_empty())
        {
            thread
                .desktop
                .get_or_insert_with(Default::default)
                .configuration = config.clone();
            let registry = self
                .managed_registry(&thread, cell.research)
                .map_err(invalid)?;
            self.check_plugin_skill_tools(&skill, &config, &registry)?;
        }
        let page = self
            .read_skill_page(skill, &reference, resource, offset, max_bytes)
            .await?;
        let mut state = cell.state.lock().await;
        let mut candidate = state.thread.clone();
        candidate
            .desktop
            .get_or_insert_with(Default::default)
            .loaded_skills
            .insert(reference.id.clone(), reference.revision.clone());
        self.persist(&candidate).await?;
        state.thread = candidate;
        Ok(page)
    }
}

impl Engine {
    pub async fn probe_provider(&self, id: &str, model: Option<String>) -> Result<Value> {
        use futures_util::StreamExt;
        let provider = self.provider(id)?;
        let name = model.unwrap_or_else(|| provider.models[0].clone());
        let mut parameters = self.model_parameters(
            &ModelRef {
                provider_id: provider.id.clone(),
                model_id: name.clone(),
            },
            &provider,
        );
        parameters.max_output_tokens = Some(32);
        let adapter = self.provider_model(&provider, &name, &parameters, None)?;
        let probe = async {
            let _permit = self.permits.acquire().await.map_err(invalid)?;
            let mut stream = adapter
                .chat_with_limits(
                    vec![model::Message::text("user", "Reply with OK.")],
                    vec![],
                    model::RequestPurpose::Solve,
                    model::ToolCallLimits {
                        max_calls: 0,
                        max_buffer_bytes: self.limits.max_tool_buffer_bytes,
                    },
                    None,
                )
                .await
                .map_err(invalid)?;
            let mut text = false;
            let mut usage = None;
            while let Some(event) = stream.next().await {
                match event.map_err(invalid)? {
                    model::ModelEvent::TextDelta(s) => {
                        text |= !s.is_empty();
                    }
                    model::ModelEvent::Usage(u) => usage = Some(u),
                    _ => {}
                }
            }
            Ok::<_, Error>(json!({"textReceived":text,"usage":usage}))
        };
        let result = tokio::time::timeout(Duration::from_secs(15), probe).await;
        Ok(match result {
            Ok(Ok(evidence)) => {
                json!({"providerId":id,"providerRevision":provider.revision,"modelId":name,"state":"connected","checked":["authentication","textStream"],"evidence":evidence})
            }
            _ => {
                json!({"providerId":id,"providerRevision":provider.revision,"modelId":name,"state":"failed","error":"API_PROBE_FAILED","checked":["authentication","textStream"]})
            }
        })
    }
}

impl Engine {
    pub(crate) fn effective_skill_refs(
        &self,
        config: &EffectiveConfig,
        model: bool,
    ) -> Vec<VersionRef> {
        let catalog = self.desktop.catalog.read().unwrap();
        let manager = self.desktop.plugins.read().unwrap();
        let mut allowed = config
            .profile
            .as_ref()
            .map(|p| p.skills.clone())
            .unwrap_or_default();
        if config.allow_plugin_skills {
            allowed.extend(config.plugin_skills.clone().unwrap_or_else(|| {
                manager
                    .enabled
                    .iter()
                    .map(|s| VersionRef {
                        id: s.id.clone(),
                        revision: s.revision.clone(),
                    })
                    .collect()
            }));
        }
        if config.allow_plugin_skills && config.plugin_skills.is_none() {
            allowed.extend(
                config
                    .selected_skills
                    .iter()
                    .flatten()
                    .filter(|r| {
                        catalog
                            .skills
                            .get(&key(&r.id, &r.revision))
                            .is_some_and(|s| s.plugin.is_some())
                    })
                    .cloned(),
            );
        }
        let refs = config.selected_skills.as_ref().unwrap_or(&allowed);
        let mut result = Vec::new();
        for r in refs {
            if !allowed.contains(r) {
                continue;
            }
            let Some(skill) = catalog.skills.get(&format!("{}/{}", r.id, r.revision)) else {
                continue;
            };
            if let Some(plugin) = &skill.plugin
                && (!manager
                    .eligible_skill_refs
                    .contains(&(r.id.clone(), r.revision.clone()))
                    || (model
                        && !plugin.allow_implicit_invocation
                        && config.selected_skills.is_none()))
            {
                continue;
            }
            if !result.contains(r) {
                result.push(r.clone());
            }
        }
        result
    }
    pub(crate) fn freeze_plugin_skills(&self, config: &mut EffectiveConfig) {
        if config.plugin_skills.is_none() {
            let catalog = self.desktop.catalog.read().unwrap();
            let refs = config.selected_skills.clone().unwrap_or_else(|| {
                self.desktop
                    .plugins
                    .read()
                    .unwrap()
                    .enabled
                    .iter()
                    .map(|s| VersionRef {
                        id: s.id.clone(),
                        revision: s.revision.clone(),
                    })
                    .collect()
            });
            config.plugin_skills = Some(
                refs.into_iter()
                    .filter(|r| {
                        catalog
                            .skills
                            .get(&format!("{}/{}", r.id, r.revision))
                            .is_some_and(|s| s.plugin.is_some())
                    })
                    .collect(),
            );
        }
    }
}

impl Engine {
    /// The existing Composer transports an explicit attachment as a JSON-quoted
    /// <skill ... id="..." revision="..."> block. Only its ref is a selector;
    /// caller-supplied names, paths and body remain untrusted user text.
    pub(crate) fn select_plugin_attachments(
        &self,
        config: &mut EffectiveConfig,
        input: &[Input],
        ordinary: bool,
    ) -> Result<()> {
        let mut scope = config.clone();
        if ordinary {
            scope.selected_skills = None;
        }
        let allowed = self.effective_skill_refs(&scope, false);
        let mut selected = self.effective_skill_refs(config, true);
        let mut attached = false;
        for item in input {
            let Input::Text {
                text,
                mcp_content: None,
                ..
            } = item
            else {
                continue;
            };
            let mut remaining = text.as_str();
            while let Some(start) = remaining.find("<skill ") {
                let mut header = &remaining[start + 7..];
                let mut id = None;
                let mut revision = None;
                let mut valid = false;
                // Parse JSON string attribute values rather than searching inside names/bodies.
                for _ in 0..8 {
                    header = header.trim_start();
                    if let Some(body) = header.strip_prefix('>') {
                        if let Some(end) = body.find("</skill>") {
                            remaining = &body[end + 8..];
                            valid = true;
                        }
                        break;
                    }
                    let Some(equal) = header.find('=') else { break };
                    let name = &header[..equal];
                    if !name.bytes().all(|c| c.is_ascii_alphabetic()) {
                        break;
                    }
                    let mut value = serde_json::Deserializer::from_str(&header[equal + 1..])
                        .into_iter::<String>();
                    let Some(Ok(value_text)) = value.next() else {
                        break;
                    };
                    let consumed = value.byte_offset();
                    match name {
                        "id" => id = Some(value_text),
                        "revision" => revision = Some(value_text),
                        _ => {}
                    }
                    header = &header[equal + 1 + consumed..];
                }
                if !valid {
                    break;
                }
                let (Some(id), Some(revision)) = (id, revision) else {
                    continue;
                };
                let reference = VersionRef { id, revision };
                let plugin = self
                    .desktop
                    .catalog
                    .read()
                    .unwrap()
                    .skills
                    .get(&key(&reference.id, &reference.revision))
                    .is_some_and(|s| s.plugin.is_some());
                if !plugin {
                    continue;
                } // Standalone attachment behavior remains unchanged.
                if !allowed.contains(&reference) {
                    return Err(invalid(
                        "attached plugin skill is outside the effective scope",
                    ));
                }
                if !selected.contains(&reference) {
                    selected.push(reference);
                }
                if selected.len() > 128 {
                    return Err(invalid("selected skills exceed budget"));
                }
                attached = true;
            }
        }
        if attached {
            config.selected_skills = Some(selected);
        }
        Ok(())
    }
}

pub(crate) fn merge_model_parameters(
    parameters: ModelParameters,
    defaults: ModelParameters,
) -> ModelParameters {
    ModelParameters {
        context_window_tokens: parameters
            .context_window_tokens
            .or(defaults.context_window_tokens),
        temperature: parameters.temperature.or(defaults.temperature),
        max_output_tokens: parameters.max_output_tokens.or(defaults.max_output_tokens),
        reasoning_effort: parameters.reasoning_effort.or(defaults.reasoning_effort),
        reasoning_summary: parameters.reasoning_summary.or(defaults.reasoning_summary),
    }
}

#[cfg(test)]
mod request_audit_tests {
    use super::*;
    use futures_util::StreamExt;

    #[tokio::test]
    async fn selected_provider_requests_keep_private_errors_and_owner_correlation() {
        use axum::{Router, routing::post};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let app = Router::new().route("/", post(|| async {
            ([("content-type", "text/event-stream")], "data: {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"private-provider-explanation\"}}\n\n")
        }));
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let data = tempfile::tempdir().unwrap();
        let default = Arc::new(
            model::HttpModel::with_protocol(
                endpoint.clone(),
                "fixture".into(),
                None,
                model::ModelProtocol::Responses,
            )
            .unwrap(),
        );
        let engine = Engine::open(data.path(), default, Limits::default()).unwrap();
        engine
            .register_credential(
                "credential-fixture".into(),
                "private-credential-fixture".into(),
            )
            .unwrap();
        let provider: Provider = serde_json::from_value(json!({
            "id":"selected-provider","revision":1,"endpoint":endpoint,"protocol":"responses",
            "models":["fixture"],"credentialRef":"credential-fixture"
        }))
        .unwrap();
        let selected = engine
            .provider_model(&provider, "fixture", &ModelParameters::default(), None)
            .unwrap();
        for purpose in [model::RequestPurpose::Solve, model::RequestPurpose::Summary] {
            let events = model::REQUEST_OWNER
                .scope(("thread-fixture".into(), "turn-fixture".into()), async {
                    selected
                        .chat_for(
                            vec![model::Message::text("user", "private-task-fixture")],
                            vec![],
                            purpose,
                        )
                        .await
                        .unwrap()
                        .collect::<Vec<_>>()
                        .await
                })
                .await;
            assert!(events.iter().any(|event| event.is_err()));
        }
        let root = data.path().join("model-requests");
        let journal = std::fs::read_to_string(root.join("requests.jsonl")).unwrap();
        let audits: Vec<Value> = journal
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(audits.len(), 2);
        for (audit, purpose) in audits.iter().zip(["Solve", "Summary"]) {
            assert_eq!(audit["purpose"], purpose);
            assert_eq!(audit["threadId"], "thread-fixture");
            assert_eq!(audit["turnId"], "turn-fixture");
            assert_eq!(audit["outcome"], "failed");
            let path = std::path::PathBuf::from(audit["errorDetailFile"].as_str().unwrap());
            assert!(path.starts_with(root.canonicalize().unwrap().join("errors")));
            assert!(
                std::fs::read_to_string(&path)
                    .unwrap()
                    .contains("private-provider-explanation")
            );
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
        }
        for private in [
            "private-task-fixture",
            "private-credential-fixture",
            "private-provider-explanation",
        ] {
            assert!(!journal.contains(private));
        }
        engine.shutdown().await;
        server.abort();
        let _ = server.await;
    }
}
