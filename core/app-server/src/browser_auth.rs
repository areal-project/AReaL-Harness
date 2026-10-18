//! 浏览器凭据只在当前服务内存中存活；长期启动器 token 不进入 Cookie。
use crate::auth::{Authentication, Principal};
use areal_protocol::service::{BrowserBootstrap, BrowserBootstrapExchange};
use axum::{
    Extension, Json,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::time::Instant;

const BOOTSTRAP_TTL: Duration = Duration::from_secs(60);
const SESSION_TTL: Duration = Duration::from_secs(3600);
const MAX_BOOTSTRAPS: usize = 64;
const MAX_SESSIONS: usize = 1024;

type CredentialHash = [u8; 32];
struct Grant {
    principal: Arc<Principal>,
    expires: Instant,
}
#[derive(Default)]
struct Grants {
    bootstraps: HashMap<CredentialHash, Grant>,
    sessions: HashMap<CredentialHash, Grant>,
}
impl Grants {
    fn prune(&mut self) {
        let now = Instant::now();
        self.bootstraps.retain(|_, grant| grant.expires > now);
        self.sessions.retain(|_, grant| grant.expires > now);
    }
}

#[derive(Clone)]
pub(crate) struct BrowserAuth {
    authentication: Authentication,
    grants: Arc<Mutex<Grants>>,
    cookie_name: String,
}
impl BrowserAuth {
    pub(crate) fn new(authentication: Authentication, origin: &str) -> Self {
        // Cookie 不按端口隔离，名称须区分本机的多个服务。
        let suffix = format!("{:x}", Sha256::digest(origin.as_bytes()));
        Self {
            authentication,
            grants: Default::default(),
            cookie_name: format!("areal_session_{}", &suffix[..16]),
        }
    }

    pub(crate) fn authenticate(&self, headers: &HeaderMap) -> Option<Arc<Principal>> {
        self.connection(headers).map(|(principal, _)| principal)
    }

    pub(crate) fn connection(
        &self,
        headers: &HeaderMap,
    ) -> Option<(Arc<Principal>, Option<Instant>)> {
        // 显式但无效的 Authorization 不得回退到浏览器身份。
        if headers.contains_key(header::AUTHORIZATION) {
            return self
                .authentication
                .authenticate_bearer(headers)
                .map(|p| (p, None));
        }
        let supplied = headers
            .get(header::COOKIE)?
            .to_str()
            .ok()?
            .split(';')
            .find_map(|part| {
                let (name, value) = part.trim().split_once('=')?;
                (name == self.cookie_name).then_some(value)
            })?;
        let mut grants = self.grants.lock().unwrap();
        grants.prune();
        let grant = grants.sessions.get(&digest(supplied))?;
        Some((grant.principal.clone(), Some(grant.expires)))
    }

    fn issue_bootstrap(&self, principal: Arc<Principal>) -> Result<BrowserBootstrap, StatusCode> {
        let mut grants = self.grants.lock().unwrap();
        grants.prune();
        if grants.bootstraps.len() >= MAX_BOOTSTRAPS {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        let code = secret();
        grants.bootstraps.insert(
            digest(&code),
            Grant {
                principal,
                expires: Instant::now() + BOOTSTRAP_TTL,
            },
        );
        Ok(BrowserBootstrap {
            code,
            expires_in: BOOTSTRAP_TTL.as_secs(),
        })
    }

    fn session(&self, principal: Arc<Principal>) -> Result<String, StatusCode> {
        let mut grants = self.grants.lock().unwrap();
        grants.prune();
        self.insert_session(&mut grants, principal)
    }

    fn exchange(&self, code: &str) -> Result<String, StatusCode> {
        let mut grants = self.grants.lock().unwrap();
        grants.prune();
        // 验证和消费共用锁；并发兑换至多一个请求成功。
        let grant = grants
            .bootstraps
            .remove(&digest(code))
            .ok_or(StatusCode::UNAUTHORIZED)?;
        self.insert_session(&mut grants, grant.principal)
    }

    fn insert_session(
        &self,
        grants: &mut Grants,
        principal: Arc<Principal>,
    ) -> Result<String, StatusCode> {
        if grants.sessions.len() >= MAX_SESSIONS {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        let id = secret();
        grants.sessions.insert(
            digest(&id),
            Grant {
                principal,
                expires: Instant::now() + SESSION_TTL,
            },
        );
        Ok(format!(
            "{}={id}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}",
            self.cookie_name,
            SESSION_TTL.as_secs()
        ))
    }
}

fn secret() -> String {
    // 两个独立 UUID v4 提供 244 位操作系统随机熵，且只含 URL 安全字符。
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
fn digest(value: &str) -> CredentialHash {
    Sha256::digest(value.as_bytes()).into()
}
fn no_store(response: impl IntoResponse) -> Response {
    let mut response = response.into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}
fn session_response(result: Result<String, StatusCode>) -> Response {
    no_store(match result {
        Ok(cookie) => ([(header::SET_COOKIE, cookie)], StatusCode::NO_CONTENT).into_response(),
        Err(status) => status.into_response(),
    })
}
fn wrong_origin(headers: &HeaderMap, origin: Option<&str>) -> bool {
    headers
        .get(header::ORIGIN)
        .is_some_and(|value| origin.is_none() || value.to_str().ok() != origin)
}

pub(crate) async fn session(
    Extension(auth): Extension<Option<BrowserAuth>>,
    Extension(origin): Extension<Option<String>>,
    headers: HeaderMap,
) -> Response {
    if wrong_origin(&headers, origin.as_deref()) {
        return no_store(StatusCode::FORBIDDEN);
    }
    let Some(auth) = auth else {
        return no_store(StatusCode::UNAUTHORIZED);
    };
    let Some(principal) = auth.authentication.authenticate_bearer(&headers) else {
        return no_store(StatusCode::UNAUTHORIZED);
    };
    session_response(auth.session(principal))
}

pub(crate) async fn bootstrap(
    Extension(auth): Extension<Option<BrowserAuth>>,
    headers: HeaderMap,
) -> Response {
    // 仅可信本地客户端可签发；浏览器已有 Cookie 不能用于续签或签发登录码。
    if headers.contains_key(header::ORIGIN) {
        return no_store(StatusCode::FORBIDDEN);
    }
    let Some(auth) = auth else {
        return no_store(StatusCode::UNAUTHORIZED);
    };
    let Some(principal) = auth.authentication.authenticate_bearer(&headers) else {
        return no_store(StatusCode::UNAUTHORIZED);
    };
    match auth.issue_bootstrap(principal) {
        Ok(ticket) => no_store(Json(ticket)),
        Err(status) => no_store(status),
    }
}

pub(crate) async fn exchange(
    Extension(auth): Extension<Option<BrowserAuth>>,
    Extension(origin): Extension<Option<String>>,
    headers: HeaderMap,
    Json(body): Json<BrowserBootstrapExchange>,
) -> Response {
    if origin.is_none()
        || !headers.contains_key(header::ORIGIN)
        || wrong_origin(&headers, origin.as_deref())
    {
        return no_store(StatusCode::FORBIDDEN);
    }
    let Some(auth) = auth else {
        return no_store(StatusCode::UNAUTHORIZED);
    };
    session_response(auth.exchange(&body.code))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::Permission;
    fn auth() -> (BrowserAuth, Arc<Principal>) {
        let principal = Arc::new(Principal {
            id: "observer".into(),
            token: "a".repeat(64),
            permissions: [Permission::Observe].into(),
            thread_ids: Some(["thread-1".into()].into()),
        });
        (
            BrowserAuth::new(
                Authentication {
                    version: 1,
                    principals: vec![(*principal).clone()],
                },
                "http://127.0.0.1:4500",
            ),
            principal,
        )
    }
    fn headers(cookie: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            cookie.split(';').next().unwrap().parse().unwrap(),
        );
        headers
    }

    #[tokio::test(start_paused = true)]
    async fn expiry_replay_identity_and_restart() {
        let (auth, principal) = auth();
        let ticket = auth.issue_bootstrap(principal.clone()).unwrap();
        tokio::time::advance(BOOTSTRAP_TTL).await;
        assert_eq!(auth.exchange(&ticket.code), Err(StatusCode::UNAUTHORIZED));
        let ticket = auth.issue_bootstrap(principal.clone()).unwrap();
        let cookie = auth.exchange(&ticket.code).unwrap();
        assert!(!cookie.contains(&principal.token));
        assert_eq!(auth.exchange(&ticket.code), Err(StatusCode::UNAUTHORIZED));
        let headers = headers(&cookie);
        let session_principal = auth.authenticate(&headers).unwrap();
        assert_eq!(session_principal.permissions, principal.permissions);
        assert_eq!(session_principal.thread_ids, principal.thread_ids);
        let restarted = BrowserAuth::new(auth.authentication.clone(), "http://127.0.0.1:4500");
        assert!(restarted.authenticate(&headers).is_none());
        tokio::time::advance(SESSION_TTL).await;
        assert!(auth.authenticate(&headers).is_none());
        assert!(auth.authentication.authenticate_bearer(&headers).is_none());
    }

    #[test]
    fn capacity_does_not_evict_existing_grants() {
        let (auth, principal) = auth();
        let first = auth.issue_bootstrap(principal.clone()).unwrap();
        for _ in 1..MAX_BOOTSTRAPS {
            auth.issue_bootstrap(principal.clone()).unwrap();
        }
        assert!(matches!(
            auth.issue_bootstrap(principal.clone()),
            Err(StatusCode::TOO_MANY_REQUESTS)
        ));
        let cookie = auth.exchange(&first.code).unwrap();
        for _ in 1..MAX_SESSIONS {
            auth.session(principal.clone()).unwrap();
        }
        assert_eq!(auth.session(principal), Err(StatusCode::TOO_MANY_REQUESTS));
        assert!(auth.authenticate(&headers(&cookie)).is_some());
    }
}
