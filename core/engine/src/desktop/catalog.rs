use super::skills::Skill;
use super::*;

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
    #[serde(default)]
    profiles: BTreeMap<String, AgentProfile>,
    // 接受旧目录格式并丢弃内容哈希；资源不再由启动快照固定。
    #[serde(default, rename = "skillHashes", skip_serializing)]
    _legacy_skill_hashes: serde::de::IgnoredAny,
    #[serde(skip)]
    skills: BTreeMap<String, Skill>,
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

impl Engine {
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
            deployment.profiles.len() <= 64 && deployment.skills.len() <= 128,
            "deployment catalog capacity exceeded"
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
        self.desktop
            .credentials
            .write()
            .unwrap()
            .insert(reference, value);
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
            engine.provider_model(&provider, &provider.models[0], &provider.parameters)?;
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
                self.desktop
                    .credentials
                    .read()
                    .unwrap()
                    .get(reference)
                    .cloned()
                    .ok_or_else(|| invalid("CREDENTIAL_UNAVAILABLE"))
            })
            .transpose()?;
        let model = model::HttpModel::with_protocol(
            provider.endpoint.clone(),
            name.into(),
            credential,
            protocol,
        )
        .map_err(invalid)?
        .with_options(model::ModelOptions {
            reasoning_effort: parameters.reasoning_effort.clone(),
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
            (Some(model), Some(provider)) => {
                self.provider_model(provider, &model.model_id, &configuration.parameters)
            }
            (None, None) if !self.model.name().is_empty() => {
                if configuration.parameters == ModelParameters::default() {
                    Ok(self.model.clone())
                } else {
                    self.model
                        .configure(&configuration.parameters)
                        .map_err(invalid)
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
        let profile = profile.as_ref().map(|p| self.profile(p)).transpose()?;
        let model = model.or_else(|| profile.as_ref().and_then(|p| p.model.clone()));
        let provider = model
            .as_ref()
            .map(|m| self.provider(&m.provider_id))
            .transpose()?;
        let defaults = provider
            .as_ref()
            .map(|p| p.parameters.clone())
            .unwrap_or_default();
        let parameters = ModelParameters {
            temperature: parameters.temperature.or(defaults.temperature),
            max_output_tokens: parameters.max_output_tokens.or(defaults.max_output_tokens),
            reasoning_effort: parameters.reasoning_effort.or(defaults.reasoning_effort),
        };
        let configuration = EffectiveConfig {
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
        if configuration.model.is_some() || !self.model.name().is_empty() {
            let actual = self.configured_model(&configuration)?;
            if configuration.profile.as_ref().is_some_and(|p| {
                p.required_modalities
                    .iter()
                    .any(|m| !actual.capabilities().supports_input(*m))
            }) {
                return Err(invalid("model does not meet profile modality requirements"));
            }
        }
        Ok(configuration)
    }
    fn selected_skill(
        &self,
        configuration: &EffectiveConfig,
        reference: &VersionRef,
    ) -> Result<Skill> {
        if !configuration
            .selected_skills
            .as_ref()
            .or_else(|| configuration.profile.as_ref().map(|p| &p.skills))
            .is_some_and(|s| s.contains(reference))
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
    pub async fn skills(&self, thread_id: &str) -> Result<Value> {
        let cell = self.cell(thread_id).await?;
        let state = cell.state.lock().await;
        let config = state
            .thread
            .desktop
            .as_ref()
            .map(|d| d.configuration.clone())
            .unwrap_or_default();
        let catalog = self.desktop.catalog.read().unwrap();
        let data: Vec<_> = config.selected_skills.as_ref().or_else(||config.profile.as_ref().map(|p| &p.skills)).into_iter().flatten().map(|r| {
            let skill = catalog.skills.get(&key(&r.id, &r.revision));
            let metadata = skill.map(|s| &s.metadata);
            json!({"id":r.id,"revision":r.revision,"available":skill.is_some(),
                "name":metadata.map_or(r.id.as_str(), |m| m.name.as_str()),
                "description":metadata.map_or("", |m| m.description.as_str()),
                "resources":null,
                "resourceRoot":skill.map(|s| format!("areal://skill/{}/{}",s.location.id,s.location.revision))})
        }).collect();
        Ok(json!({"data":data,"loaded":state.thread.desktop.as_ref().map(|d| &d.loaded_skills)}))
    }
    pub async fn read_skill(
        &self,
        thread_id: &str,
        reference: VersionRef,
        resource: &str,
        offset: usize,
        max_bytes: usize,
    ) -> Result<Value> {
        if max_bytes == 0 || max_bytes > 8192 {
            return Err(invalid("maxBytes must be 1..8192"));
        }
        let cell = self.cell(thread_id).await?;
        let mut state = cell.state.lock().await;
        let configuration = state
            .thread
            .desktop
            .as_ref()
            .map(|d| d.configuration.clone())
            .unwrap_or_default();
        let skill = self.selected_skill(&configuration, &reference)?;
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
        let bytes = &page.bytes;
        let end = offset + bytes.len();
        let mut candidate = state.thread.clone();
        candidate
            .desktop
            .get_or_insert_with(Default::default)
            .loaded_skills
            .insert(reference.id.clone(), reference.revision.clone());
        self.persist(&candidate).await?;
        state.thread = candidate;
        Ok(
            json!({"id":reference.id,"revision":reference.revision,"resource":resource,"sizeBytes":page.size,"dataBase64":base64::engine::general_purpose::STANDARD.encode(bytes),"text":std::str::from_utf8(bytes).ok(),"nextOffset":end,"eof":end>=page.size}),
        )
    }
}

impl Engine {
    pub async fn probe_provider(&self, id: &str, model: Option<String>) -> Result<Value> {
        use futures_util::StreamExt;
        let provider = self.provider(id)?;
        let name = model.unwrap_or_else(|| provider.models[0].clone());
        let mut parameters = provider.parameters.clone();
        parameters.max_output_tokens = Some(32);
        let adapter = self.provider_model(&provider, &name, &parameters)?;
        let probe = async {
            let _permit = self.permits.acquire().await.map_err(invalid)?;
            let mut stream = adapter
                .chat(vec![model::Message::text("user", "Reply with OK.")], vec![])
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
