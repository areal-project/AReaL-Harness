//! Cloud 目标与 token 作为同一 Vault 修订保存，不能把旧目标的凭据带到新地址。
use super::{Host, library_store};
use crate::vault::Slot;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::rc::Rc;

#[derive(Default)]
pub(super) struct Cloud {
    pub(super) sessions: super::cloud_sessions::CloudSessions,
}
fn service_url(value: &str) -> Result<String> {
    let mut url = url::Url::parse(value).context("INVALID_PARAMS")?;
    ensure!(
        matches!(url.scheme(), "http" | "https" | "ws" | "wss")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "Cloud 地址必须是没有凭据、查询和片段的 app-server 服务地址"
    );
    let scheme = if matches!(url.scheme(), "http" | "ws") {
        "ws"
    } else {
        "wss"
    };
    url.set_scheme(scheme)
        .map_err(|_| anyhow::anyhow!("INVALID_PARAMS"))?;
    let path = url.path().trim_end_matches('/');
    let path = if path.is_empty() {
        "/openapi/v1/app-server"
    } else {
        path
    };
    ensure!(
        path.ends_with("/app-server"),
        "Cloud 服务地址不能附加 workspace"
    );
    url.set_path(&format!("{path}/"));
    Ok(url.as_str().trim_end_matches('/').into())
}
fn token(value: &str) -> Result<()> {
    ensure!(
        !value.trim().is_empty() && value.len() <= 16384 && !value.contains(['\r', '\n']),
        "Cloud token 无效"
    );
    Ok(())
}
fn public(value: &Value) -> Result<Value> {
    if value.is_null() {
        return Ok(json!({"baseURL":"","tokenConfigured":false}));
    }
    let base = value["baseURL"]
        .as_str()
        .context("invalid saved Cloud target")?;
    ensure!(service_url(base)? == base, "invalid saved Cloud target");
    token(
        value["token"]
            .as_str()
            .context("invalid saved Cloud token")?,
    )?;
    Ok(json!({"baseURL":base,"tokenConfigured":true}))
}
fn settled(result: &Value) -> Result<()> {
    match result["state"].as_str() {
        Some("completed") => Ok(()),
        Some("blocked") => Err(crate::wire::error(
            "storageBlocked",
            "Cloud 凭据保存被系统存储拒绝，请检查后重试",
        )),
        _ => Err(crate::wire::error(
            "SUBMISSION_UNKNOWN",
            format!(
                "Cloud 凭据保存待核对，原请求：{}",
                result["requestId"].as_str().unwrap_or("UNKNOWN")
            ),
        )),
    }
}

impl Cloud {
    async fn current(&self, host: &Host, source: &str) -> Result<(u64, Value)> {
        let value=host.migration.vault.dispatch_async("vault.read",json!({"slot":Slot::CloudAccount{source_id:source.into()},"interactionAllowed":false}),&host.identity.generation,&host.migration).await?;
        Ok((
            value["revision"]
                .as_u64()
                .context("invalid vault revision")?,
            value["value"].clone(),
        ))
    }
    // 过渡：到 0.2.0 删（Cloud 旧密文一次导入完成后移除）。
    fn legacy_pending(host: &Host, source: &str) -> Result<bool> {
        let path = library_store::source_home(host, source)?.join("cloud.json");
        let Some(bytes) = areal_local_service::storage::read_bytes(&path)? else {
            return Ok(false);
        };
        ensure!(bytes.len() <= 1024 * 1024, "LIMIT_EXCEEDED");
        let value: Value = serde_json::from_slice(&bytes)?;
        Ok(value["secret"]
            .as_str()
            .is_some_and(|secret| !secret.is_empty()))
    }
    pub(super) async fn import(
        &self,
        host: &Rc<Host>,
        source: &str,
        request: &Value,
    ) -> Result<Value> {
        let _: areal_protocol::host::LocalDesktopCloudImportParams =
            serde_json::from_value(request.clone()).context("INVALID_PARAMS")?;
        let request_id = request["requestId"].as_str().context("INVALID_PARAMS")?;
        crate::wire::request_id(request_id)?;
        let (revision, current) = self.current(host, source).await?;
        if revision > 0 {
            return public(&current);
        }
        let home = library_store::source_home(host, source)?;
        let raw = crate::schedule_resources::bounded(&home.join("cloud.json"), 1024 * 1024)?;
        ensure!(
            raw.len() <= 1024 * 1024
                && request["sourceDigest"] == areal_local_service::storage::digest(raw.as_bytes()),
            "SOURCE_CHANGED"
        );
        let original: Value = serde_json::from_str(&raw)?;
        ensure!(
            original["secret"]
                .as_str()
                .is_some_and(|value| !value.is_empty()),
            "CLOUD_IMPORT_REQUIRED"
        );
        let base = service_url(
            original["baseURL"]
                .as_str()
                .context("invalid Cloud import target")?,
        )?;
        let secret = request["token"].as_str().context("INVALID_PARAMS")?;
        token(secret)?;
        let value = json!({"baseURL":base,"token":secret});
        let result=host.migration.vault.dispatch_async("vault.replace",json!({"requestId":request_id,"expectedGeneration":host.identity.generation,"slot":Slot::CloudAccount{source_id:source.into()},"expectedRevision":0,"value":value}),&host.identity.generation,&host.migration).await?;
        settled(&result)?;
        host.schedules.connections.prune_cloud_revisions(host);
        public(&value)
    }

    pub(super) async fn attach(
        &self,
        host: &Rc<Host>,
        source: &str,
        request: &Value,
    ) -> Result<Value> {
        self.attach_for(host, source, request, None).await
    }
    pub(super) async fn attach_owned(
        &self,
        host: &Rc<Host>,
        source: &str,
        id: &str,
        request: &Value,
    ) -> Result<Value> {
        self.attach_for(host, source, request, Some(id)).await
    }
    async fn attach_for(
        &self,
        host: &Rc<Host>,
        source: &str,
        request: &Value,
        owner: Option<&str>,
    ) -> Result<Value> {
        let (revision, account) = self.current(host, source).await?;
        public(&account)?;
        let base = account["baseURL"]
            .as_str()
            .context("请先配置 Cloud 地址和 token")?;
        let base = url::Url::parse(&format!("{base}/"))?;
        let target = url::Url::parse(request["baseURL"].as_str().context("INVALID_PARAMS")?)?;
        ensure!(
            target.origin() == base.origin()
                && target.username().is_empty()
                && target.password().is_none()
                && target.query().is_none()
                && target.fragment().is_none(),
            "TARGET_CHANGED"
        );
        let suffix = target
            .path()
            .strip_prefix(base.path())
            .context("TARGET_CHANGED")?
            .trim_end_matches('/');
        ensure!(
            suffix.is_empty()
                || (suffix.len() <= 64
                    && suffix
                        .bytes()
                        .next()
                        .is_some_and(|b| b.is_ascii_alphanumeric())
                    && suffix
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))),
            "TARGET_CHANGED"
        );
        let params = json!({"baseURL":target.as_str(),"token":account["token"]});
        let result = if let Some(owner) = owner {
            host.schedules
                .connections
                .owned_cloud_attach(host, source, owner, &params)
                .await?
        } else {
            host.schedules
                .connections
                .workbench_cloud_attach(host, source, &params)
                .await?
        };
        let guard = host.schedules.connections.hold_attachment(
            host,
            result["projectId"].as_str().context("INVALID_RESPONSE")?,
            result["lease"].as_str().context("INVALID_RESPONSE")?,
        )?;
        let current = self.current(host, source).await;
        let valid = current
            .as_ref()
            .is_ok_and(|(current, _)| *current == revision);
        if !valid {
            current?;
            anyhow::bail!("TARGET_CHANGED");
        }
        host.schedules.connections.bind_cloud_revision(
            host,
            result["projectId"].as_str().context("INVALID_RESPONSE")?,
            result["lease"].as_str().context("INVALID_RESPONSE")?,
            revision,
        )?;
        guard.retain();
        Ok(result)
    }

    pub(super) async fn settings(
        &self,
        host: &Rc<Host>,
        source: &str,
        request: &Value,
    ) -> Result<Value> {
        let object = request.as_object().context("INVALID_PARAMS")?;
        let operation = request["operation"].as_str().context("INVALID_PARAMS")?;
        ensure!(
            matches!(operation, "status" | "save")
                && object.keys().all(|key| if operation == "status" {
                    key == "operation"
                } else {
                    ["operation", "baseURL", "token"].contains(&key.as_str())
                }),
            "INVALID_PARAMS"
        );
        host.admission()?;
        let (revision, previous) = self.current(host, source).await?;
        if operation == "status" {
            // 过渡：到 0.2.0 删（旧 Cloud 导入完成后移除此检查）。
            ensure!(
                !previous.is_null() || !Self::legacy_pending(host, source)?,
                crate::wire::error(
                    "CLOUD_IMPORT_REQUIRED",
                    "旧 Cloud 凭据尚待本机解密导入，原记录已保留"
                )
            );
            return public(&previous);
        }
        let base = service_url(request["baseURL"].as_str().context("INVALID_PARAMS")?)?;
        ensure!(
            request.get("token").is_none_or(Value::is_string),
            "INVALID_PARAMS"
        );
        let secret = match request["token"].as_str().filter(|value| !value.is_empty()) {
            Some(value) => value.to_owned(),
            None => {
                ensure!(previous["baseURL"] == base, "请为此 Cloud 地址提供 token");
                previous["token"]
                    .as_str()
                    .context("请为此 Cloud 地址提供 token")?
                    .into()
            }
        };
        token(&secret)?;
        host.admission()?;
        ensure!(
            host.gateway.workbench.active_source().as_deref() == Some(source),
            "RESYNC_REQUIRED"
        );
        let value = json!({"baseURL":base,"token":secret});
        let request_id = uuid::Uuid::new_v4().to_string();
        let result=host.migration.vault.dispatch_async("vault.replace",json!({"requestId":request_id,"expectedGeneration":host.identity.generation,"slot":Slot::CloudAccount{source_id:source.into()},"expectedRevision":revision,"value":value}),&host.identity.generation,&host.migration).await?;
        settled(&result)?;
        host.schedules.connections.prune_cloud_revisions(host);
        public(&value)
    }
}
