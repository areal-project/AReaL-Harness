use bytes::Bytes;
use futures_util::StreamExt;
use reqwest::{Client, Response, Url};
use serde_json::{Value, json};
use std::time::Duration;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Failure {
    pub(super) code: String,
    pub(super) phase: String,
    pub(super) status: Option<u16>,
    pub(super) request_id: Option<String>,
}
pub(super) type Result<T> = std::result::Result<T, Failure>;
impl Failure {
    pub(super) fn new(code: &str, phase: &str) -> Self {
        Self {
            code: code.into(),
            phase: phase.into(),
            status: None,
            request_id: None,
        }
    }
    pub(super) fn state(&self) -> &'static str {
        if (self.phase == "refresh" && terminal(&self.code))
            || matches!(
                self.code.as_str(),
                "credential_missing" | "credential_invalid"
            )
        {
            "reauth_required"
        } else if matches!(
            self.code.as_str(),
            "storage_locked" | "storage_write_failed"
        ) {
            "storage_locked"
        } else if self.status == Some(429) {
            "quota_exceeded"
        } else if self.status == Some(403)
            || matches!(self.code.as_str(), "invalid_client" | "permission_missing")
        {
            "permission_denied"
        } else {
            "temporarily_unavailable"
        }
    }
    pub(super) fn diagnostic(&self) -> Value {
        json!({"code":self.code,"state":self.state(),"phase":self.phase,"httpStatus":self.status,"requestId":self.request_id})
    }
    pub(super) fn message(&self) -> &'static str {
        match self.state() {
            "reauth_required" => "ChatGPT 授权已终止，请重新登录。",
            "storage_locked" => "系统安全存储不可用，请解锁后重试；不会因此退出登录。",
            "permission_denied" => "ChatGPT 权限或客户端配置不允许此操作，请检查授权和服务限制。",
            "quota_exceeded" => "ChatGPT 使用额度受限，请在 ChatGPT 设置中检查应用用量。",
            _ => "ChatGPT 暂时不可用，请检查网络后重试；登录凭据已保留。",
        }
    }
    pub(super) fn storage(error: anyhow::Error) -> Self {
        let code = error.downcast_ref::<crate::wire::Error>().map(|e| e.code);
        Self::new(
            match code {
                Some("credentialInvalid") => "credential_invalid",
                Some("permissionMissing") => "permission_missing",
                Some("revisionConflict") => "account_changed",
                _ => "storage_locked",
            },
            "storage",
        )
    }
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message())
    }
}
impl std::error::Error for Failure {}
fn terminal(code: &str) -> bool {
    matches!(
        code,
        "invalid_grant"
            | "invalid_refresh_token"
            | "token_expired"
            | "refresh_token_expired"
            | "refresh_token_invalidated"
            | "refresh_token_reused"
    )
}
fn known(code: &str) -> bool {
    terminal(code)
        || matches!(
            code,
            "invalid_client"
                | "invalid_token"
                | "storage_locked"
                | "storage_write_failed"
                | "credential_missing"
                | "credential_invalid"
                | "account_changed"
                | "cancelled"
                | "network_error"
                | "http_error"
                | "invalid_response"
                | "permission_missing"
                | "subscription_sharing_user_not_eligible"
                | "subscription_sharing_usage_limit_exceeded"
                | "subscription_sharing_usage_unavailable"
                | "subscription_sharing_unsupported_capability"
                | "subscription_sharing_route_not_supported"
                | "subscription_sharing_invalid_user"
                | "chatpass_v2_scope_not_authorized"
                | "chatpass_v2_invalid_authorization_context"
                | "subscription_sharing_user_unavailable"
        )
}
pub(super) async fn response_error(response: Response, phase: &str, secrets: &[&str]) -> Failure {
    let status = response.status().as_u16();
    let id = response
        .headers()
        .get("x-request-id")
        .and_then(|h| h.to_str().ok())
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
                && !secrets
                    .iter()
                    .any(|secret| !secret.is_empty() && id.contains(secret))
        })
        .map(str::to_owned);
    let data = bounded(response, 16_384, phase)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let raw = data
        .as_ref()
        .and_then(|v| v["error"].as_str().or_else(|| v["error"]["code"].as_str()));
    Failure {
        code: raw.filter(|raw| known(raw)).unwrap_or("http_error").into(),
        phase: phase.into(),
        status: Some(status),
        request_id: id,
    }
}
pub(super) async fn bounded(response: Response, limit: usize, phase: &str) -> Result<Bytes> {
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| Failure::new("network_error", phase))?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(Failure::new("invalid_response", phase));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes.into())
}

pub(crate) use crate::network::NetworkInput;
#[derive(Clone)]
pub(crate) struct Network {
    client: Client,
    unavailable: bool,
    fixture_route: Option<Url>,
}
impl Network {
    pub(crate) fn new(input: NetworkInput) -> Result<Self> {
        Ok(Self {
            client: crate::network::client(&input)
                .map_err(|_| Failure::new("network_error", "transport"))?,
            unavailable: input.proxy_unavailable,
            fixture_route: None,
        })
    }
    #[cfg(test)]
    pub(super) fn fixture(input: NetworkInput, route: Url) -> Result<Self> {
        let mut network = Self::new(input)?;
        network.fixture_route = Some(route);
        Ok(network)
    }
    pub(super) fn request(
        &self,
        method: reqwest::Method,
        target: &str,
        phase: &str,
    ) -> Result<reqwest::RequestBuilder> {
        if self.unavailable {
            return Err(Failure::new("network_error", phase));
        }
        let original = Url::parse(target).map_err(|_| Failure::new("invalid_response", phase))?;
        if !matches!(
            original.origin().ascii_serialization().as_str(),
            "https://auth.openai.com" | "https://api.openai.com"
        ) || original.query().is_some()
            || original.fragment().is_some()
            || !original.username().is_empty()
            || original.password().is_some()
        {
            return Err(Failure::new("invalid_response", phase));
        }
        let url = self
            .fixture_route
            .as_ref()
            .map(|route| {
                route
                    .join(&format!(
                        "{}{}",
                        original.host_str().unwrap(),
                        original.path()
                    ))
                    .unwrap()
            })
            .unwrap_or(original);
        Ok(self.client.request(method, url))
    }
    pub(super) async fn json(
        &self,
        target: &str,
        method: reqwest::Method,
        form: Option<&[(String, String)]>,
        phase: &str,
    ) -> Result<Value> {
        let mut request = self
            .request(method, target, phase)?
            .timeout(Duration::from_secs(30));
        if let Some(form) = form {
            request = request.form(form);
        }
        let response = request
            .send()
            .await
            .map_err(|_| Failure::new("network_error", phase))?;
        if !response.status().is_success() {
            return Err(response_error(
                response,
                phase,
                &form
                    .into_iter()
                    .flatten()
                    .filter(|(k, _)| k == "refresh_token")
                    .map(|(_, v)| v.as_str())
                    .collect::<Vec<_>>(),
            )
            .await);
        }
        serde_json::from_slice(&bounded(response, 1_048_576, phase).await?)
            .map_err(|_| Failure::new("invalid_response", phase))
    }
}

pub(super) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
