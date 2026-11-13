//! 显式导入禁用模板；一个来源供应商只认首次请求，恢复仅核对原结果。
use super::*;
use areal_config::models::{ModelConfigurationUpdate, ProviderConfig};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Import {
    request_id: String,
    space_id: Option<String>,
    provider_id: String,
    template_digest: String,
}
fn inputs(home: &std::path::Path) -> areal_config::ConfigInputs {
    areal_config::ConfigInputs {
        cwd: home.into(),
        env: [("AREAL_HARNESS_HOME".into(), home.as_os_str().to_owned())].into(),
        ..Default::default()
    }
}
fn candidate(id: &str, value: Value) -> Result<ProviderConfig> {
    let protocol = match value["protocol"].as_str() {
        Some("responses") => "responses",
        Some("chatCompletions") => "chat-completions",
        _ => anyhow::bail!("INVALID_PARAMS"),
    };
    let suffix = if protocol == "responses" {
        "/responses"
    } else {
        "/chat/completions"
    };
    serde_json::from_value(json!({"id":id,"name":value["name"],"endpoint":format!("{}{}",value["baseUrl"].as_str().context("INVALID_PARAMS")?.trim_end_matches('/'),suffix),"protocol":protocol,"enabled":false,"models":value["models"],"parameters":value["parameters"]})).map_err(Into::into)
}
fn public(request: &str, provider: &str, digest: &str, state: &str) -> Value {
    json!({"requestId":request,"providerId":provider,"templateDigest":digest,"state":state})
}
fn confirmed(home: &std::path::Path, record: &Operation) -> Result<bool> {
    let Some(value) = record.evidence.get("provider") else {
        return Ok(false);
    };
    let provider: ProviderConfig = serde_json::from_value(value.clone())?;
    ensure!(
        !provider.enabled && provider.api_key_env.is_none(),
        "invalid import evidence"
    );
    let current = areal_config::models::read(&inputs(home), &[])?;
    Ok(current.data.iter().any(|row| row == &provider))
}
impl Host {
    pub(super) fn reconcile_provider_import(&self, request: &str) -> Result<Option<Value>> {
        let Some(mut record) = self.receipt(request)? else {
            return Ok(None);
        };
        ensure!(
            record.receipt["method"] == "recovery.importProvider",
            "requestConflict"
        );
        if record.receipt["state"] != "completed" {
            record.receipt["state"] = json!(if confirmed(&self.home, &record).unwrap_or(false) {
                "completed"
            } else {
                "admissionUnknown"
            });
            self.save(request, &record.digest, &record.receipt)?;
        }
        Ok(Some(record.receipt))
    }
    pub(super) fn import_provider(&self, input: Import) -> Result<Value> {
        self.admission()?;
        wire::request_id(&input.request_id)?;
        ensure!(
            !input.provider_id.is_empty()
                && input.provider_id.len() <= 256
                && input.template_digest.len() == 64,
            "INVALID_PARAMS"
        );
        let (space, manifest_digest) =
            crate::space::import_context(&self.home, input.space_id.as_deref())?;
        let template_space = space.clone();
        let template_provider = input.provider_id.clone();
        let template_digest = input.template_digest.clone();
        self.import_provider_bound(input, space, manifest_digest, || {
            crate::space::import_template(
                &self.home,
                &template_space,
                &template_provider,
                &template_digest,
            )
        })
    }
    fn import_provider_bound(
        &self,
        mut input: Import,
        space: String,
        manifest_digest: String,
        template: impl FnOnce() -> Result<Value>,
    ) -> Result<Value> {
        input.space_id = Some(space.clone());
        let target = format!(
            "restored_{}",
            &storage::digest(format!("{space}\0{}", input.provider_id).as_bytes())[..24]
        );
        let claim_path = crate::space::import_claim_path(&self.home, &input.provider_id);
        if let Some(claim) = storage::read_optional::<Value>(&claim_path)? {
            ensure!(
                claim["manifestDigest"] == manifest_digest
                    && claim["templateDigest"] == input.template_digest
                    && claim["providerId"] == target,
                "requestConflict"
            );
            let request = claim["requestId"]
                .as_str()
                .context("invalid import claim")?;
            let receipt = self.reconcile_provider_import(request)?;
            return Ok(public(
                request,
                &target,
                claim["templateDigest"]
                    .as_str()
                    .context("invalid template claim")?,
                if receipt.is_some_and(|r| r["state"] == "completed") {
                    "completed"
                } else {
                    "admissionUnknown"
                },
            ));
        }
        // 已用过的请求不能建立另一个供应商 claim。
        ensure!(
            self.receipt(&input.request_id)?.is_none()
                && self.client_operation(&input.request_id)?.is_none(),
            "requestConflict"
        );
        let template = template()?;
        let provider = candidate(&target, template)?;
        let current = areal_config::models::read(&inputs(&self.home), &[])?;
        ensure!(
            !current.data.iter().any(|row| row.id == target),
            "providerConflict"
        );
        ensure!(current.data.len() < 32, "providerLimit");
        storage::private_dir(claim_path.parent().context("claim parent")?)?;
        // 先持久化唯一 claim；崩溃后即使尚无操作回执也保持 UNKNOWN，不能换 ID 重写。
        storage::write(
            &claim_path,
            &json!({"requestId":input.request_id,"providerId":target,"templateDigest":input.template_digest,"manifestDigest":manifest_digest,"sourceProviderId":input.provider_id,"name":provider.name}),
        )?;
        let (digest, _) =
            self.accepted(&input.request_id, "recovery.importProvider", &input, "")?;
        let mut record = self
            .receipt(&input.request_id)?
            .context("import receipt missing")?;
        record.receipt["providerId"] = json!(target);
        record.evidence = json!({"provider":provider,"expectedRevision":current.revision,"manifestDigest":manifest_digest});
        storage::write(
            &wire::operation_path(&self.home, &input.request_id),
            &record,
        )?;
        let mut data = current.data;
        data.push(provider);
        let outcome = areal_config::models::write(
            &inputs(&self.home),
            ModelConfigurationUpdate {
                expected_revision: current.revision,
                data,
                default_model: current.default_model,
            },
            &[],
        );
        // 失败可能发生在 rename 之后，只按落盘精确匹配结算；不重试写入。
        let completed = outcome.is_ok() && confirmed(&self.home, &record).unwrap_or(false);
        record.receipt["state"] = json!(if completed {
            "completed"
        } else {
            "admissionUnknown"
        });
        self.save(&input.request_id, &digest, &record.receipt)?;
        self.changed();
        Ok(public(
            &input.request_id,
            &target,
            &input.template_digest,
            record.receipt["state"].as_str().unwrap(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn template() -> Value {
        json!({"name":"Synthetic","baseUrl":"https://example.invalid/v1","protocol":"responses","enabled":false,"models":[{"id":"fixture"}],"parameters":{}})
    }
    fn request(id: &str) -> Import {
        Import {
            request_id: id.into(),
            space_id: None,
            provider_id: "old".into(),
            template_digest: storage::digest(&serde_json::to_vec(&template()).unwrap()),
        }
    }
    fn apply(host: &Host, id: &str) -> Value {
        host.import_provider_bound(request(id), "space".into(), "manifest".into(), || {
            Ok(template())
        })
        .unwrap()
    }
    #[test]
    fn explicit_template_import_is_disabled_and_unique_across_requests_and_restart() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let host = schedules::tests::fixture(&base);
        let id = uuid::Uuid::new_v4().to_string();
        let result = apply(&host, &id);
        assert_eq!(result["state"], "completed");
        assert_eq!(result["templateDigest"], request(&id).template_digest);
        let bytes = std::fs::read(host.home.join("config.toml")).unwrap();
        let config = areal_config::models::read(&inputs(&host.home), &[]).unwrap();
        assert_eq!(config.data.len(), 1);
        assert!(!config.data[0].enabled);
        assert!(config.data[0].api_key_env.is_none());
        assert_eq!(apply(&host, &id), result);
        let mut changed = request(&id);
        changed.template_digest = "f".repeat(64);
        assert!(
            host.import_provider_bound(changed, "space".into(), "manifest".into(), || Ok(
                template()
            ))
            .is_err()
        );
        assert_eq!(apply(&host, &id), result);
        drop(host);
        let host = schedules::tests::fixture(&base);
        let other = uuid::Uuid::new_v4().to_string();
        assert_eq!(apply(&host, &other), result);
        assert!(host.receipt(&other).unwrap().is_none());
        assert_eq!(std::fs::read(host.home.join("config.toml")).unwrap(), bytes);
    }
    #[test]
    fn interrupted_claim_never_replays_and_original_receipt_only_settles_exact_published_template()
    {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let host = schedules::tests::fixture(&base);
        let id = uuid::Uuid::new_v4().to_string();
        let mut input = request(&id);
        input.space_id = Some("space".into());
        let target = format!("restored_{}", &storage::digest(b"space\0old")[..24]);
        let claim = crate::space::import_claim_path(&host.home, "old");
        storage::private_dir(claim.parent().unwrap()).unwrap();
        storage::write(&claim,&json!({"requestId":id,"providerId":target,"templateDigest":input.template_digest,"manifestDigest":"manifest"})).unwrap();
        assert_eq!(apply(&host, &id)["state"], "admissionUnknown");
        assert!(!host.home.join("config.toml").exists());
        let (digest, _) = host
            .accepted(&id, "recovery.importProvider", &input, "")
            .unwrap();
        let provider = candidate(&target, template()).unwrap();
        let mut op = host.receipt(&id).unwrap().unwrap();
        op.evidence = json!({"provider":provider});
        op.receipt["providerId"] = json!(target);
        storage::write(&wire::operation_path(&host.home, &id), &op).unwrap();
        assert_eq!(
            apply(&host, &uuid::Uuid::new_v4().to_string())["state"],
            "admissionUnknown"
        );
        assert!(!host.home.join("config.toml").exists());
        let before = areal_config::models::read(&inputs(&host.home), &[]).unwrap();
        let mut different = provider.clone();
        different.enabled = true;
        let changed = areal_config::models::write(
            &inputs(&host.home),
            ModelConfigurationUpdate {
                expected_revision: before.revision,
                data: vec![different],
                default_model: None,
            },
            &[],
        )
        .unwrap();
        assert_eq!(
            host.reconcile_provider_import(&id).unwrap().unwrap()["state"],
            "admissionUnknown"
        );
        areal_config::models::write(
            &inputs(&host.home),
            ModelConfigurationUpdate {
                expected_revision: changed.revision,
                data: vec![provider],
                default_model: None,
            },
            &[],
        )
        .unwrap();
        assert_eq!(
            host.reconcile_provider_import(&id).unwrap().unwrap()["state"],
            "completed"
        );
        assert_eq!(host.receipt(&id).unwrap().unwrap().digest, digest);
    }
}
