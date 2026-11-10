use crate::AuthorizedCredential;
use futures_util::stream::BoxStream;
use reqwest_mcp::header::{HeaderName, HeaderValue};
use rmcp::{
    model::{ClientJsonRpcMessage, JsonRpcMessage, RequestId},
    transport::streamable_http_client::*,
};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
#[derive(Debug)]
pub struct AuthenticationFailed;
impl std::fmt::Display for AuthenticationFailed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MCP authentication failed")
    }
}
impl std::error::Error for AuthenticationFailed {}
/// Private protocol data: never included in management DTOs, Debug or errors.
#[derive(Clone, Default)]
pub(crate) struct AuthChallenge(Arc<std::sync::Mutex<Option<String>>>);
impl std::fmt::Debug for AuthChallenge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AuthChallenge([REDACTED])")
    }
}
impl AuthChallenge {
    pub(crate) fn capture(&self, value: &str) {
        let value = value.trim();
        if value.is_empty() || value.len() > 8192 || value.chars().any(char::is_control) {
            return;
        }
        if let Ok(mut slot) = self.0.lock() {
            *slot = Some(value.to_owned());
        }
    }
    pub(crate) fn get(&self) -> Option<String> {
        self.0.lock().ok().and_then(|slot| slot.clone())
    }
}
#[derive(Clone, Debug)]
pub struct HttpFailure {
    pub kind: &'static str,
    pub status: Option<u16>,
}
pub(crate) type StartupHttpFailure = Arc<std::sync::Mutex<Option<HttpFailure>>>;
pub(crate) fn classify(error: &StreamableHttpError<reqwest_mcp::Error>) -> HttpFailure {
    use StreamableHttpError::*;
    let (kind, status) = match error {
        Client(e) => (
            if e.status().is_some() {
                "http_status"
            } else if e.is_timeout() {
                "timeout"
            } else if e.is_connect() {
                "connect"
            } else if e.is_decode() {
                "decode"
            } else if e.is_body() {
                "body"
            } else {
                "http_client"
            },
            e.status().map(|s| s.as_u16()),
        ),
        HttpStatus(e) => ("http_status", Some(e.status)),
        AuthRequired(_) => ("authentication", Some(401)),
        InsufficientScope(_) => ("scope", Some(403)),
        Auth(_) => ("authentication", None),
        UnexpectedContentType(_) => ("content_type", None),
        Deserialize(_) => ("json_decode", None),
        Sse(_) => ("sse", None),
        Io(_) => ("io", None),
        UnexpectedEndOfStream => ("end_of_stream", None),
        UnexpectedServerResponse(message) => {
            // 其余 HTTP 拒绝仍以 "HTTP <status>" 开头。
            // Copy only that bounded integer, never the provider body suffix.
            let status = message
                .strip_prefix("HTTP ")
                .and_then(|s| s.get(..3))
                .and_then(|s| s.parse::<u16>().ok())
                .filter(|s| (100..=599).contains(s));
            (
                if status.is_some() {
                    "http_status"
                } else {
                    "response_shape"
                },
                status,
            )
        }
        _ => ("http_transport", None),
    };
    HttpFailure { kind, status }
}
pub(crate) type AuthRejections = Arc<std::sync::Mutex<std::collections::HashSet<RequestId>>>;
pub(crate) fn take_rejection(rejected: &AuthRejections, id: &RequestId) -> bool {
    rejected
        .lock()
        .map(|mut ids| ids.remove(id))
        .unwrap_or(false)
}
// Only caller-owned tools/read requests are tracked, never initialization or
// discovery. Entries are consumed on every reply/cancellation; overflow fails
// before POST rather than evicting an in-flight credential binding.
type SentCredentialMap = HashMap<RequestId, (AuthorizedCredential, Option<String>)>;
#[derive(Clone, Default)]
pub(crate) struct SentCredentials(Arc<std::sync::Mutex<SentCredentialMap>>);
impl std::fmt::Debug for SentCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SentCredentials([REDACTED])")
    }
}
impl SentCredentials {
    fn insert(
        &self,
        id: RequestId,
        credential: AuthorizedCredential,
        token: Option<String>,
    ) -> Result<(), StreamableHttpError<reqwest_mcp::Error>> {
        let mut entries = self.0.lock().map_err(|_| {
            StreamableHttpError::UnexpectedServerResponse(
                "MCP credential binding unavailable".into(),
            )
        })?;
        if entries.len() >= 256 {
            return Err(StreamableHttpError::UnexpectedServerResponse(
                "MCP credential binding capacity exceeded".into(),
            ));
        }
        entries.insert(id, (credential, token));
        Ok(())
    }
    pub(crate) fn take(&self, id: &RequestId) -> Option<(AuthorizedCredential, Option<String>)> {
        self.0
            .lock()
            .ok()
            .and_then(|mut entries| entries.remove(id))
    }
}
#[derive(Clone)]
pub(crate) struct HttpClient {
    pub client: reqwest_mcp::Client,
    pub credential: Option<AuthorizedCredential>,
    pub failed: Arc<AtomicBool>,
    pub rejected: AuthRejections,
    pub startup_failure: StartupHttpFailure,
    pub challenge: AuthChallenge,
    pub sent_credentials: SentCredentials,
}
impl HttpClient {
    async fn token(
        &self,
        fallback: Option<String>,
        endpoint: &str,
    ) -> Result<Option<String>, StreamableHttpError<reqwest_mcp::Error>> {
        if fallback.is_some() {
            return Ok(fallback);
        }
        match &self.credential {
            Some(c)
                if c.fixed_header(endpoint)
                    .map_err(StreamableHttpError::Auth)?
                    .is_some() =>
            {
                Ok(None)
            }
            Some(c) => match c.token(endpoint).await {
                Ok(t) => Ok(Some(t)),
                Err(_) => {
                    self.failed.store(true, Ordering::Release);
                    Err(StreamableHttpError::Auth(
                        rmcp::transport::auth::AuthError::AuthorizationRequired,
                    ))
                }
            },
            None => Ok(fallback),
        }
    }
    fn authenticated_headers(
        &self,
        endpoint: &str,
        mut headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<HashMap<HeaderName, HeaderValue>, StreamableHttpError<reqwest_mcp::Error>> {
        if let Some(c) = &self.credential
            && let Some((name, value)) = c
                .fixed_header(endpoint)
                .map_err(StreamableHttpError::Auth)?
        {
            headers.insert(name, value);
        }
        Ok(headers)
    }
    fn record_rejection(&self, id: Option<RequestId>) {
        if let Some(id) = id
            && let Ok(mut ids) = self.rejected.lock()
            && ids.len() < 256
        {
            ids.insert(id);
        }
    }
    async fn result<T>(
        &self,
        token: Option<&str>,
        r: Result<T, StreamableHttpError<reqwest_mcp::Error>>,
    ) -> Result<T, StreamableHttpError<reqwest_mcp::Error>> {
        if let Err(error) = &r {
            if let Some(challenge) = error.auth_challenge() {
                self.challenge.capture(challenge);
            }
            if let Ok(mut slot) = self.startup_failure.lock() {
                *slot = Some(classify(error));
            }
        }
        if matches!(
            &r,
            Err(StreamableHttpError::AuthRequired(_)
                | StreamableHttpError::InsufficientScope(_)
                | StreamableHttpError::Auth(_))
        ) || matches!(&r,Err(StreamableHttpError::Client(e)) if e.status().is_some_and(|s|s==401||s==403))
        {
            self.failed.store(true, Ordering::Release);
            if let Some(c) = &self.credential {
                c.reject(token).await;
            }
        }
        r
    }
}
impl StreamableHttpClient for HttpClient {
    type Error = reqwest_mcp::Error;
    async fn post_message(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        auth_header: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<StreamableHttpPostResponse, StreamableHttpError<Self::Error>> {
        self.post_message_with_max_sse_event_size(
            uri,
            message,
            session_id,
            auth_header,
            headers,
            4 * 1024 * 1024,
        )
        .await
    }
    async fn post_message_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        auth_header: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
        limit: usize,
    ) -> Result<StreamableHttpPostResponse, StreamableHttpError<Self::Error>> {
        // JSON-RPC 请求 ID 由 SDK 的同一 RequestHandle 生成；不依赖共享故障标志判断在途请求结局。
        let id = match &message {
            JsonRpcMessage::Request(r) => Some(r.id.clone()),
            _ => None,
        };
        let track = matches!(&message, JsonRpcMessage::Request(r) if matches!(&r.request, rmcp::model::ClientRequest::CallToolRequest(_) | rmcp::model::ClientRequest::ReadResourceRequest(_)));
        let token = match self.token(auth_header, &uri).await {
            Ok(token) => token,
            Err(error) => {
                self.record_rejection(id);
                return Err(error);
            }
        };
        let headers = self.authenticated_headers(&uri, headers)?;
        if track && let (Some(id), Some(credential)) = (&id, &self.credential) {
            self.sent_credentials
                .insert(id.clone(), credential.clone(), token.clone())?;
        }
        let result = self
            .client
            .post_message_with_max_sse_event_size(
                uri,
                message,
                session_id,
                token.clone(),
                headers,
                limit,
            )
            .await;
        if matches!(
            &result,
            Err(StreamableHttpError::AuthRequired(_) | StreamableHttpError::InsufficientScope(_))
        ) || matches!(&result,Err(StreamableHttpError::Client(e)) if e.status().is_some_and(|s|s==401||s==403))
        {
            self.record_rejection(id.clone());
        }
        if result.is_err()
            && let Some(id) = &id
        {
            self.sent_credentials.take(id);
        }
        self.result(token.as_deref(), result).await
    }
    async fn delete_session(
        &self,
        uri: Arc<str>,
        session_id: Arc<str>,
        auth_header: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<(), StreamableHttpError<Self::Error>> {
        let token = self.token(auth_header, &uri).await?;
        let headers = self.authenticated_headers(&uri, headers)?;
        self.result(
            token.as_deref(),
            self.client
                .delete_session(uri, session_id, token.clone(), headers)
                .await,
        )
        .await
    }
    async fn get_stream(
        &self,
        uri: Arc<str>,
        session_id: Option<Arc<str>>,
        last_event_id: Option<String>,
        auth_header: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<
        BoxStream<'static, Result<sse_stream::Sse, SseError>>,
        StreamableHttpError<Self::Error>,
    > {
        self.get_stream_with_max_sse_event_size(
            uri,
            session_id,
            last_event_id,
            auth_header,
            headers,
            4 * 1024 * 1024,
        )
        .await
    }
    async fn get_stream_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        session_id: Option<Arc<str>>,
        last_event_id: Option<String>,
        auth_header: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
        limit: usize,
    ) -> Result<
        BoxStream<'static, Result<sse_stream::Sse, SseError>>,
        StreamableHttpError<Self::Error>,
    > {
        let token = self.token(auth_header, &uri).await?;
        let headers = self.authenticated_headers(&uri, headers)?;
        self.result(
            token.as_deref(),
            self.client
                .get_stream_with_max_sse_event_size(
                    uri,
                    session_id,
                    last_event_id,
                    token.clone(),
                    headers,
                    limit,
                )
                .await,
        )
        .await
    }
}
