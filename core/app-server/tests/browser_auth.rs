use areal_app_server::auth::{Authentication, Permission, Principal};
use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelCapabilities, ModelStream},
};
use areal_protocol::service::{BrowserBootstrap, Identity, Service, State};
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use reqwest::{Client, StatusCode};
use serde_json::json;
use std::{sync::Arc, time::Duration};
use tokio_tungstenite::tungstenite::{Message as Wire, client::IntoClientRequest};
use tokio_util::sync::CancellationToken;

struct NoModel;
#[async_trait]
impl Model for NoModel {
    fn name(&self) -> &str {
        "unused"
    }
    fn capabilities(&self) -> ModelCapabilities {
        ModelCapabilities {
            context_window_tokens: None,
            max_output_tokens: None,
            summary_output_tokens: None,
            input: vec![],
            output: vec![],
        }
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        panic!("authentication must not call a model")
    }
}
struct Fixture {
    _dir: tempfile::TempDir,
    engine: Arc<Engine>,
    stop: CancellationToken,
    server: tokio::task::JoinHandle<anyhow::Result<()>>,
    service: Service,
    token: String,
    http: Client,
}
impl Fixture {
    async fn new() -> Self {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(dir.path(), Arc::new(NoModel), Limits::default()).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let token = "native-owner-token-".repeat(4);
        let auth = Authentication {
            version: 1,
            principals: vec![Principal {
                id: "observer".into(),
                token: token.clone(),
                permissions: [Permission::Observe].into(),
                thread_ids: Some(["visible-thread".into()].into()),
            }],
        };
        let auth_file = dir.path().join("auth.json");
        std::fs::write(&auth_file, serde_json::to_vec(&auth).unwrap()).unwrap();
        std::fs::set_permissions(&auth_file, std::fs::Permissions::from_mode(0o600)).unwrap();
        let identity = Identity {
            protocol_version: 1,
            service_id: "test-service".into(),
            generation: uuid::Uuid::new_v4().to_string(),
            workspace: dir.path().into(),
            data_dir: dir.path().into(),
            config_fingerprint: "fixture".into(),
        };
        let service = Service {
            identity: identity.clone(),
            endpoint: format!("ws://{addr}"),
            web_url: format!("http://{addr}/ui"),
            auth_file,
            log_file: dir.path().join("log"),
            host_pid: 0,
            core_pid: 0,
            state: State::Ready,
        };
        let stop = CancellationToken::new();
        let server = tokio::spawn(areal_app_server::serve_service(
            listener,
            engine.clone(),
            stop.clone(),
            Some(auth),
            Some(identity),
        ));
        Self {
            _dir: dir,
            engine,
            stop,
            server,
            service,
            token,
            http: Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
        }
    }
    fn url(&self, path: &str) -> String {
        format!("{}{}", self.origin(), path)
    }
    fn origin(&self) -> String {
        self.service.web_url.trim_end_matches("/ui").into()
    }
    async fn ticket(&self) -> BrowserBootstrap {
        let response = self
            .http
            .post(self.url("/areal/auth/bootstrap"))
            .bearer_auth(&self.token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
        response.json().await.unwrap()
    }
    async fn exchange(&self, code: &str) -> reqwest::Response {
        self.http
            .post(self.url("/areal/auth/bootstrap/exchange"))
            .header("Origin", self.origin())
            .json(&json!({"code": code}))
            .send()
            .await
            .unwrap()
    }
    async fn close(self) {
        self.engine.shutdown().await;
        self.stop.cancel();
        tokio::time::timeout(Duration::from_secs(3), self.server)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
}

#[tokio::test]
async fn native_launcher_bootstrap_is_single_use_and_preserves_permissions() {
    let f = Fixture::new().await;
    let login = areal_local_service::browser_login_url(&f.service)
        .await
        .unwrap();
    let url = reqwest::Url::parse(&login).unwrap();
    assert_eq!(url.origin().ascii_serialization(), f.origin());
    assert_eq!(url.path(), "/ui");
    assert!(url.query().is_none());
    assert!(!login.contains(&f.token));
    assert!(
        !serde_json::to_string(&f.service)
            .unwrap()
            .contains("bootstrap=")
    );
    let code = url.fragment().unwrap().strip_prefix("bootstrap=").unwrap();
    let (a, b) = tokio::join!(f.exchange(code), f.exchange(code));
    let (success, replay) = if a.status().is_success() {
        (a, b)
    } else {
        (b, a)
    };
    assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(success.status(), StatusCode::NO_CONTENT);
    assert_eq!(success.headers()["cache-control"], "no-store");
    let cookie = success.headers()["set-cookie"].to_str().unwrap();
    for flag in ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=3600"] {
        assert!(cookie.contains(flag));
    }
    assert!(!cookie.contains(&f.token));
    assert!(!cookie.contains(code));
    let cookie = cookie.split(';').next().unwrap();
    let identity: Identity = f
        .http
        .get(f.url("/areal/service"))
        .header("Cookie", cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(identity, f.service.identity);
    let mut request = f.service.endpoint.as_str().into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Origin", f.origin().parse().unwrap());
    request
        .headers_mut()
        .insert("Cookie", cookie.parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    socket.send(Wire::Text(json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"}}}).to_string().into())).await.unwrap();
    let init: serde_json::Value =
        serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert!(init.get("result").is_some());
    socket
        .send(Wire::Text(
            json!({"id":2,"method":"thread/start","params":{}})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let denied: serde_json::Value =
        serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(denied["error"]["code"], -32003);
    // 使用已连接的真实 WebSocket 验证服务端会话期限，而非只依赖 Cookie Max-Age。
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(3601)).await;
    let closed = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap();
    assert!(matches!(closed, None | Some(Ok(Wire::Close(_)))));
    tokio::time::resume();
    assert_eq!(
        f.http
            .get(f.url("/areal/service"))
            .header("Cookie", cookie)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    f.close().await;
}

#[tokio::test]
async fn bootstrap_rejects_cross_origin_cookie_auth_and_other_instances() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    assert_eq!(
        f.http
            .post(f.url("/areal/auth/bootstrap"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    for origin in [
        f.origin(),
        "https://untrusted.example".into(),
        "null".into(),
    ] {
        assert_eq!(
            f.http
                .post(f.url("/areal/auth/bootstrap"))
                .bearer_auth(&f.token)
                .header("Origin", origin)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
    }
    let ticket = f.ticket().await;
    assert_eq!(ticket.expires_in, 60);
    for origin in [None, Some("https://untrusted.example"), Some("null")] {
        let mut request = f
            .http
            .post(f.url("/areal/auth/bootstrap/exchange"))
            .json(&json!({"code": ticket.code}));
        if let Some(origin) = origin {
            request = request.header("Origin", origin);
        }
        assert_eq!(
            request.send().await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        other.exchange(&ticket.code).await.status(),
        StatusCode::UNAUTHORIZED
    );
    let response = f.exchange(&ticket.code).await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    for path in ["/areal/auth/bootstrap", "/areal/auth/session"] {
        assert_eq!(
            f.http
                .post(f.url(path))
                .header("Cookie", cookie)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        f.http
            .get(f.url("/areal/service"))
            .header("Cookie", cookie)
            .bearer_auth("wrong")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        other
            .http
            .get(other.url("/areal/service"))
            .header("Cookie", cookie)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let manual = other
        .http
        .post(other.url("/areal/auth/session"))
        .header("Origin", other.origin())
        .bearer_auth(&other.token)
        .send()
        .await
        .unwrap();
    assert_eq!(manual.status(), StatusCode::NO_CONTENT);
    let other_cookie = manual.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    assert_ne!(cookie.split('=').next(), other_cookie.split('=').next());
    let all_cookies = format!("{cookie}; {other_cookie}");
    for fixture in [&f, &other] {
        assert_eq!(
            fixture
                .http
                .get(fixture.url("/areal/service"))
                .header("Cookie", &all_cookies)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            fixture
                .http
                .get(fixture.url("/areal/service"))
                .header("Cookie", format!("areal_session={}", fixture.token))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    let invalid = f
        .http
        .post(f.url("/areal/auth/bootstrap/exchange"))
        .header("Origin", f.origin())
        .json(&json!({"code":"x".repeat(2048)}))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::PAYLOAD_TOO_LARGE);
    f.close().await;
    other.close().await;
}
