use super::*;
use bytes::Bytes;
use futures_util::StreamExt;
use http_body_util::{BodyExt, Full, StreamBody, combinators::UnsyncBoxBody};
use hyper::{
    Request, Response,
    body::{Frame, Incoming},
    service::service_fn,
};
use hyper_util::rt::TokioIo;
use network::{NetworkInput, now_ms};
use serde_json::json;
use std::{
    cell::{Cell, RefCell},
    convert::Infallible,
    rc::Rc,
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::{Notify, Semaphore, mpsc},
    task::JoinHandle,
};

const FIRST: &[u8]=b"event: response.output_text.delta\r\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"first\"}\r\n\r\n";
const LAST: &[u8]=b"data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[]}}\n\n";
type TestBody = UnsyncBoxBody<Bytes, Infallible>;
fn bytes_response(status: u16, body: Bytes, content_type: Option<&str>) -> Response<TestBody> {
    let mut response = Response::builder().status(status);
    if let Some(content_type) = content_type {
        response = response.header("content-type", content_type);
    }
    response.body(Full::new(body).boxed_unsync()).unwrap()
}
fn json_response(status: u16, value: Value) -> Response<TestBody> {
    bytes_response(
        status,
        Bytes::from(serde_json::to_vec(&value).unwrap()),
        Some("application/json"),
    )
}
struct Upstream {
    refreshes: Cell<usize>,
    catalogs: Cell<usize>,
    posts: Cell<usize>,
    ordinary_requests: RefCell<Vec<Value>>,
    changed: Notify,
    hold_refresh: Cell<bool>,
    refresh_gate: Semaphore,
    hold_stream: Cell<bool>,
    stream_gate: Semaphore,
    unauthorized: Cell<bool>,
    catalog_unauthorized: Cell<bool>,
    hold_catalog: Cell<bool>,
    fail_catalog: Cell<bool>,
    catalog_gate: Semaphore,
    terminal: Cell<bool>,
    missing_type: Cell<bool>,
    invalid_stream: Cell<bool>,
    fail_commit: RefCell<Option<Rc<Migration>>>,
    received: RefCell<Vec<Value>>,
    headers: RefCell<Vec<reqwest::header::HeaderMap>>,
    forms: RefCell<Vec<String>>,
    token_payload: RefCell<Option<Value>>,
    streams: RefCell<Vec<JoinHandle<()>>>,
}
impl Upstream {
    fn new() -> Self {
        Self {
            refreshes: Cell::new(0),
            catalogs: Cell::new(0),
            posts: Cell::new(0),
            ordinary_requests: RefCell::new(Vec::new()),
            changed: Notify::new(),
            hold_refresh: Cell::new(false),
            refresh_gate: Semaphore::new(0),
            hold_stream: Cell::new(false),
            stream_gate: Semaphore::new(0),
            unauthorized: Cell::new(false),
            catalog_unauthorized: Cell::new(false),
            hold_catalog: Cell::new(false),
            fail_catalog: Cell::new(false),
            catalog_gate: Semaphore::new(0),
            terminal: Cell::new(false),
            missing_type: Cell::new(false),
            invalid_stream: Cell::new(false),
            fail_commit: RefCell::new(None),
            received: RefCell::new(Vec::new()),
            headers: RefCell::new(Vec::new()),
            forms: RefCell::new(Vec::new()),
            token_payload: RefCell::new(None),
            streams: RefCell::new(Vec::new()),
        }
    }
    async fn count(&self, field: &Cell<usize>, expected: usize) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let changed = self.changed.notified();
                if field.get() >= expected {
                    break;
                }
                changed.await;
            }
        })
        .await
        .unwrap();
    }
}
async fn upstream(
    state: Rc<Upstream>,
    request: Request<Incoming>,
) -> std::result::Result<Response<TestBody>, Infallible> {
    let path = request.uri().path().to_owned();
    let method = request.method().clone();
    let headers = request.headers().clone();
    let body = request.into_body().collect().await.unwrap().to_bytes();
    let response = match (method.as_str(), path.as_str()) {
        ("GET", "/auth.openai.com/.well-known/openid-configuration") => json_response(
            200,
            json!({"issuer":"https://auth.openai.com","authorization_endpoint":"https://auth.openai.com/authorize","token_endpoint":"https://auth.openai.com/token","jwks_uri":"https://auth.openai.com/jwks","revocation_endpoint":"https://auth.openai.com/revoke"}),
        ),
        ("POST", "/auth.openai.com/token") => {
            state.refreshes.set(state.refreshes.get() + 1);
            state
                .forms
                .borrow_mut()
                .push(String::from_utf8(body.to_vec()).unwrap());
            state.changed.notify_waiters();
            if state.hold_refresh.get() {
                state.refresh_gate.acquire().await.unwrap().forget();
            }
            if let Some(migration) = state.fail_commit.borrow_mut().take() {
                migration.vault.locked.set(true);
            }
            if state.terminal.get() {
                json_response(
                    400,
                    json!({"error":"refresh_token_reused","detail":"secret-refresh"}),
                )
            } else {
                json_response(200,state.token_payload.borrow().clone().unwrap_or(json!({"token_type":"Bearer","access_token":"next-access","refresh_token":"next-refresh","expires_in":3600,"scope":"openid resource.invoke chatgpt.tokens.use.direct"})))
            }
        }
        ("GET", "/api.openai.com/v1/models") => {
            state.catalogs.set(state.catalogs.get() + 1);
            state.changed.notify_waiters();
            if state.hold_catalog.get() {
                state.catalog_gate.acquire().await.unwrap().forget();
            }
            if state.catalog_unauthorized.replace(false) {
                json_response(401, json!({"error":{"code":"invalid_token"}}))
            } else if state.fail_catalog.get() {
                json_response(503, json!({"error":{"code":"fixture_catalog_unavailable"}}))
            } else {
                json_response(
                    200,
                    json!({"models":[{"slug":"fixture","visibility":"list","use_responses_lite":true,"support_verbosity":true,"default_verbosity":"low"}]}),
                )
            }
        }
        ("POST", "/ordinary/responses") => {
            state
                .ordinary_requests
                .borrow_mut()
                .push(serde_json::from_slice(&body).unwrap());
            bytes_response(
                200,
                Bytes::from([FIRST, LAST].concat()),
                Some("text/event-stream"),
            )
        }
        ("POST", "/api.openai.com/v1/responses") => {
            state.posts.set(state.posts.get() + 1);
            state
                .received
                .borrow_mut()
                .push(serde_json::from_slice(&body).unwrap());
            state.headers.borrow_mut().push(headers);
            state.changed.notify_waiters();
            if state.unauthorized.get() {
                let mut response = json_response(
                    401,
                    json!({"error":{"code":"invalid_token","message":"next-access secret-refresh"}}),
                );
                response
                    .headers_mut()
                    .insert("x-request-id", "next-access".parse().unwrap());
                response
            } else if state.invalid_stream.get() {
                bytes_response(200, Bytes::from_static(b"data: [DONE]\n\n"), None)
            } else if state.hold_stream.get() {
                let (sender, receiver) =
                    mpsc::channel::<std::result::Result<Frame<Bytes>, Infallible>>(2);
                sender
                    .send(Ok(Frame::data(Bytes::from_static(FIRST))))
                    .await
                    .unwrap();
                let stream_owner = state.clone();
                state
                    .streams
                    .borrow_mut()
                    .push(tokio::task::spawn_local(async move {
                        stream_owner.stream_gate.acquire().await.unwrap().forget();
                        let _ = sender.send(Ok(Frame::data(Bytes::from_static(LAST)))).await;
                    }));
                let stream = futures_util::stream::unfold(receiver, |mut rx| async {
                    rx.recv().await.map(|item| (item, rx))
                });
                let mut response = Response::builder();
                if !state.missing_type.get() {
                    response = response.header("content-type", "text/event-stream");
                }
                response
                    .header("x-codex-turn-state", "route-one")
                    .body(StreamBody::new(stream).boxed_unsync())
                    .unwrap()
            } else {
                let mut bytes = FIRST.to_vec();
                bytes.extend_from_slice(LAST);
                let mut response = bytes_response(
                    200,
                    bytes.into(),
                    if state.missing_type.get() {
                        None
                    } else {
                        Some("text/event-stream")
                    },
                );
                response
                    .headers_mut()
                    .insert("x-codex-turn-state", "route-one".parse().unwrap());
                response
            }
        }
        _ => json_response(404, json!({"error":"fixture_route_missing"})),
    };
    Ok(response)
}
struct Server {
    route: url::Url,
    cancel: CancellationToken,
    task: JoinHandle<()>,
    state: Rc<Upstream>,
}
impl Server {
    async fn start() -> Self {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = Rc::new(Upstream::new());
        let owner = state.clone();
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let task = tokio::task::spawn_local(async move {
            let mut connections = Vec::new();
            loop {
                let socket = tokio::select! {_=stop.cancelled()=>break,result=listener.accept()=>result.unwrap().0};
                let state = owner.clone();
                let stop = stop.clone();
                connections.push(tokio::task::spawn_local(async move {tokio::select! {_=stop.cancelled()=>{},_=hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(socket),service_fn(move|req|upstream(state.clone(),req)))=>{}}}));
            }
            for connection in connections {
                let _ = connection.await;
            }
        });
        Self {
            route: format!("http://127.0.0.1:{port}/").parse().unwrap(),
            cancel,
            task,
            state,
        }
    }
    async fn close(self) {
        self.state.refresh_gate.add_permits(100);
        self.state.catalog_gate.add_permits(100);
        self.state.stream_gate.add_permits(100);
        self.cancel.cancel();
        self.task.await.unwrap();
        let streams = std::mem::take(&mut *self.state.streams.borrow_mut());
        for stream in streams {
            stream.await.unwrap();
        }
        // 并行测试可复用已释放端口；确认原任务及其连接持有的状态都已释放。
        assert_eq!(Rc::strong_count(&self.state), 1);
    }
}
struct Rig {
    _root: tempfile::TempDir,
    migration: Rc<Migration>,
    source: Rc<SourceSubscription>,
    server: Server,
    transport: transport::Listener,
}
impl Rig {
    async fn new(expired: bool) -> Self {
        let tests::Fixture {
            root,
            home: _,
            migration,
            sources,
        } = tests::Fixture::new();
        let migration = Rc::new(migration);
        let mut grant = tests::grant();
        grant["payload"]["expires"] = json!(if expired { 1 } else { now_ms() + 3_600_000 });
        migration
            .vault
            .replace_subscription_account(
                &sources[0],
                &uuid::Uuid::new_v4().to_string(),
                0,
                grant,
                &migration,
            )
            .unwrap();
        migration
            .vault
            .replace_subscription_transport(
                &sources[0],
                &uuid::Uuid::new_v4().to_string(),
                0,
                json!({"token":"fixture-loopback","port":0,"network":{"preserved":true}}),
                &migration,
            )
            .unwrap();
        let server = Server::start().await;
        let network =
            network::Network::fixture(NetworkInput::default(), server.route.clone()).unwrap();
        let source =
            SourceSubscription::load(migration.clone(), sources[0].clone(), network).unwrap();
        let transport = transport::listen(source.clone(), None).await.unwrap();
        Self {
            _root: root,
            migration,
            source,
            server,
            transport,
        }
    }
    fn request(&self) -> reqwest::RequestBuilder {
        reqwest::Client::new().post(&self.transport.endpoint).bearer_auth("fixture-loopback").json(&json!({"model":"fixture","stream":true,"input":[{"role":"user","content":"hello"}]}))
    }
    fn stored(&self) -> Value {
        self.source.accounts().unwrap().directory.unwrap().encode()
    }
    async fn close(self) {
        self.source.close().await;
        assert!(self.source.lifetime.is_cancelled());
        assert!(self.source.tasks.borrow().is_empty());
        // listener 与每个连接都持有原 source；不能用可能已被复用的端口证明它们已退出。
        assert_eq!(Rc::strong_count(&self.source), 1);
        self.server.close().await;
    }
}

#[tokio::test(flavor = "current_thread")]
async fn single_flight_refresh_survives_cancel_and_persists_original_registration() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let rig = Rig::new(true).await;
            rig.server.state.hold_refresh.set(true);
            let first_cancel = CancellationToken::new();
            let second_cancel = CancellationToken::new();
            let one = rig.source.clone();
            let cancel = first_cancel.clone();
            let first =
                tokio::task::spawn_local(
                    async move { one.access_token(&cancel, false, None).await },
                );
            rig.server.state.count(&rig.server.state.refreshes, 1).await;
            let two = rig.source.clone();
            let second = tokio::task::spawn_local(async move {
                two.access_token(&second_cancel, false, None).await
            });
            first_cancel.cancel();
            assert_eq!(first.await.unwrap().err().unwrap().code, "cancelled");
            rig.server.state.refresh_gate.add_permits(1);
            assert_eq!(second.await.unwrap().unwrap().0, "next-access");
            assert_eq!(rig.server.state.refreshes.get(), 1);
            assert_eq!(rig.source.state.borrow().epoch, 0);
            let stored = rig.stored();
            let payload = &stored["payload"]["records"]["primary"]["record"]["payload"];
            assert_eq!(payload["refresh"], "next-refresh");
            assert_eq!(payload["clientId"], "client-one");
            assert_eq!(payload["subject"], "subject-one");
            let form = rig.server.state.forms.borrow()[0].clone();
            let fields = url::form_urlencoded::parse(form.as_bytes())
                .into_owned()
                .collect::<std::collections::BTreeMap<_, _>>();
            assert_eq!(fields["client_id"], "client-one");
            assert_eq!(fields["resource"], "https://api.openai.com/v1");
            rig.close().await;
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn rotated_result_survives_storage_failure_and_never_reexchanges() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let rig = Rig::new(true).await;
            *rig.server.state.fail_commit.borrow_mut() = Some(rig.migration.clone());
            let failure = rig
                .source
                .access_token(&CancellationToken::new(), false, None)
                .await
                .err()
                .unwrap();
            assert_eq!(failure.state(), "storage_locked");
            assert!(rig.source.state.borrow().pending.is_some());
            rig.migration.vault.locked.set(false);
            assert_eq!(
                rig.stored()["payload"]["records"]["primary"]["record"]["payload"]["refresh"],
                "secret-refresh"
            );
            assert_eq!(
                rig.source
                    .access_token(&CancellationToken::new(), false, None)
                    .await
                    .unwrap()
                    .0,
                "next-access"
            );
            assert_eq!(rig.server.state.refreshes.get(), 1);
            assert!(rig.source.state.borrow().pending.is_none());
            rig.close().await;
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn paused_sse_bytes_continue_with_source_owner_and_refresh_does_not_cancel_stream() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let rig = Rig::new(false).await;
            rig.source.discover(false).await.unwrap();
            rig.server.state.hold_stream.set(true);
            rig.server.state.missing_type.set(true);
            let response = rig
                .request()
                .header("x-areal-thread-id", "thread-one")
                .header("x-areal-turn-id", "turn-one")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 200);
            let mut stream = response.bytes_stream();
            let mut bytes = stream.next().await.unwrap().unwrap().to_vec();
            assert_eq!(bytes, FIRST);
            rig.source
                .access_token(
                    &CancellationToken::new(),
                    true,
                    Some("secret-access".into()),
                )
                .await
                .unwrap();
            assert_eq!(rig.source.state.borrow().epoch, 0);
            rig.server.state.stream_gate.add_permits(1);
            while let Some(chunk) = stream.next().await {
                bytes.extend_from_slice(&chunk.unwrap());
            }
            assert_eq!(bytes, [FIRST, LAST].concat());
            assert_eq!(rig.server.state.posts.get(), 1);
            assert_eq!(rig.server.state.refreshes.get(), 1);
            let saved = rig
                .migration
                .vault
                .subscription_transport(&rig.source.source, &rig.migration)
                .unwrap();
            assert_eq!(saved.1["port"], rig.transport.port);
            assert_eq!(saved.1["network"], json!({"preserved":true}));
            rig.close().await;
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn logout_cancels_old_epoch_and_late_refresh_cannot_resurrect_account() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let rig = Rig::new(true).await;
            rig.server.state.hold_refresh.set(true);
            let source = rig.source.clone();
            let refresh = tokio::task::spawn_local(async move {
                source
                    .access_token(&CancellationToken::new(), false, None)
                    .await
            });
            rig.server.state.count(&rig.server.state.refreshes, 1).await;
            rig.source.logout().unwrap();
            rig.server.state.refresh_gate.add_permits(1);
            assert_eq!(
                refresh.await.unwrap().err().unwrap().code,
                "account_changed"
            );
            assert_eq!(
                rig.stored()["payload"]["records"]["primary"]["record"]["kind"],
                "registration"
            );
            assert_eq!(rig.server.state.refreshes.get(), 1);
            assert!(
                rig.source
                    .access_token(&CancellationToken::new(), false, None)
                    .await
                    .is_err()
            );
            assert_eq!(rig.server.state.refreshes.get(), 1);
            rig.close().await;
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn native_inference_completes_while_catalog_is_held_and_refresh_recovers() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let rig = Rig::new(false).await;
            let state = &rig.server.state;
            rig.source.refresh_catalog(false).await.unwrap();
            let original = rig.source.snapshot().unwrap();
            state.hold_catalog.set(true);
            state.fail_catalog.set(true);
            let source = rig.source.clone();
            let discovery =
                tokio::task::spawn_local(async move { source.refresh_catalog(true).await });
            state.count(&state.catalogs, 2).await;

            let response = tokio::time::timeout(Duration::from_secs(5), async {
                let response = rig.request().send().await.unwrap();
                assert_eq!(response.status(), 200);
                response.bytes().await.unwrap()
            })
            .await
            .expect("configured inference completes before catalog release");
            assert_eq!(response.as_ref(), [FIRST, LAST].concat());
            assert_eq!(state.posts.get(), 1);
            assert_eq!(state.catalogs.get(), 2);
            assert!(!discovery.is_finished());

            state.hold_catalog.set(false);
            state.catalog_gate.add_permits(1);
            assert!(discovery.await.unwrap().is_err());
            let rejected = rig.source.snapshot().unwrap();
            assert_eq!(rejected["models"], original["models"]);
            assert_eq!(
                rejected["catalog"]["fetchedAt"],
                original["catalog"]["fetchedAt"]
            );
            assert_eq!(rejected["catalog"]["fresh"], false);
            assert!(rejected["modelError"].is_string());

            let input = json!([
                {"role":"user","content":"hello"},
                {"role":"assistant","content":"first"},
                {"role":"user","content":"continue after catalog failure"}
            ]);
            let continued = rig
                .request()
                .json(&json!({"model":"fixture","stream":true,"input":input}))
                .send()
                .await
                .unwrap();
            assert_eq!(continued.status(), 200);
            assert_eq!(
                continued.bytes().await.unwrap().as_ref(),
                [FIRST, LAST].concat()
            );
            assert_eq!(state.posts.get(), 2);
            assert_eq!(
                state.catalogs.get(),
                2,
                "sending cannot start catalog discovery"
            );
            let received = state.received.borrow()[1]["input"].clone();
            assert!(
                received
                    .to_string()
                    .contains("continue after catalog failure")
            );
            assert!(received.to_string().contains("hello"));
            assert!(rig.source.snapshot().unwrap()["modelError"].is_string());

            state.fail_catalog.set(false);
            rig.source.refresh_catalog(false).await.unwrap();
            let catalog = rig.source.discover(false).await.unwrap();
            assert_eq!(catalog.len(), 1);
            assert_eq!(catalog[0]["id"], "fixture");
            assert_eq!(state.catalogs.get(), 3);
            assert_eq!(state.posts.get(), 2);
            let recovered = rig.source.snapshot().unwrap();
            assert_eq!(recovered["catalog"]["fresh"], true);
            assert!(recovered["modelError"].is_null());
            rig.close().await;
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn core_sends_once_on_the_original_thread_across_subscription_catalog_failure() {
    use areal_engine::{
        Engine, Limits,
        model::{HttpModel, ModelProtocol},
    };
    use areal_protocol::{Input, Item, TurnStatus};
    use std::sync::Arc;

    tokio::task::LocalSet::new()
        .run_until(async {
            let rig = Rig::new(false).await;
            let state = &rig.server.state;
            let workspace = tempfile::tempdir().unwrap();
            let core = tempfile::tempdir().unwrap();
            let open = || {
                let model = HttpModel::with_protocol(
                    rig.transport.endpoint.clone(),
                    "fixture".into(),
                    Some("fixture-loopback".into()),
                    ModelProtocol::Responses,
                )
                .unwrap();
                Engine::open(core.path(), Arc::new(model), Limits::default()).unwrap()
            };
            rig.source.refresh_catalog(false).await.unwrap();
            let engine = open();
            let thread = engine
                .create(workspace.path().to_str().unwrap().into())
                .await
                .unwrap();

            state.hold_catalog.set(true);
            state.fail_catalog.set(true);
            let source = rig.source.clone();
            let discovery =
                tokio::task::spawn_local(async move { source.refresh_catalog(true).await });
            state.count(&state.catalogs, 2).await;

            let first = engine
                .start(
                    &thread.id,
                    vec![Input::text("Original subscription question")],
                )
                .await
                .unwrap();
            let finished = tokio::time::timeout(Duration::from_secs(5), engine.wait(&thread.id))
                .await
                .expect("Core completes before catalog release")
                .unwrap();
            assert_eq!(finished.turns[0].id, first.id);
            assert_eq!(finished.turns[0].status, TurnStatus::Completed);
            assert_eq!(state.posts.get(), 1);
            assert!(!discovery.is_finished());
            engine.shutdown().await;
            drop(engine);

            state.hold_catalog.set(false);
            state.catalog_gate.add_permits(1);
            assert!(discovery.await.unwrap().is_err());

            let restored = open();
            let history = restored.read(&thread.id, true).await.unwrap();
            assert_eq!(history.turns.len(), 1);
            assert_eq!(history.turns[0].id, first.id);
            assert_eq!(
                state.posts.get(),
                1,
                "reading History cannot replay inference"
            );
            let follow_up = restored
                .start(
                    &thread.id,
                    vec![Input::text("Continue the original question")],
                )
                .await
                .unwrap();
            let finished = tokio::time::timeout(Duration::from_secs(5), restored.wait(&thread.id))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(finished.turns.len(), 2);
            assert_eq!(finished.turns[1].id, follow_up.id);
            for turn in &finished.turns {
                assert_eq!(turn.status, TurnStatus::Completed);
                assert!(turn.items.iter().any(
                    |item| matches!(item, Item::AgentMessage { text, .. } if text == "first")
                ));
            }
            assert_eq!(
                state.catalogs.get(),
                2,
                "inference cannot discover a catalog"
            );
            assert_eq!(
                state.posts.get(),
                2,
                "each original Turn posts exactly once"
            );
            {
                let requests = state.received.borrow();
                let input = requests[1]["input"].as_array().unwrap();
                let users: Vec<_> = input
                    .iter()
                    .filter(|message| message["role"] == "user")
                    .filter_map(|message| message["content"][0]["text"].as_str())
                    .collect();
                assert_eq!(
                    users,
                    [
                        "Original subscription question",
                        "Continue the original question"
                    ]
                );
            }
            restored.shutdown().await;
            rig.close().await;
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn worktree_first_turns_keep_ordinary_and_subscription_models_independent() {
    use areal_engine::{
        Engine, Limits,
        model::{HttpModel, ModelProtocol},
    };
    use areal_protocol::desktop::{ClientOptions, ConfigureThread, EffectiveConfig};
    use areal_protocol::{Input, Item, TurnStatus};
    use std::{path::Path, process::Command, sync::Arc};

    fn git(repository: &Path, args: &[&str]) {
        let result = Command::new("git")
            .args(args)
            .current_dir(repository)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
    }

    tokio::task::LocalSet::new()
        .run_until(async {
            let rig = Rig::new(false).await;
            let state = &rig.server.state;
            let root = tempfile::tempdir().unwrap();
            let repository = root.path().join("repository");
            std::fs::create_dir(&repository).unwrap();
            git(&repository, &["init", "-b", "main"]);
            git(
                &repository,
                &[
                    "-c",
                    "user.email=fixture@example.invalid",
                    "-c",
                    "user.name=Fixture",
                    "commit",
                    "--allow-empty",
                    "-m",
                    "Seed worktree commit",
                ],
            );
            let ordinary_workspace = root.path().join("ordinary");
            let subscription_workspace = root.path().join("subscription");
            for workspace in [&ordinary_workspace, &subscription_workspace] {
                git(
                    &repository,
                    &["worktree", "add", "--detach", workspace.to_str().unwrap()],
                );
            }

            state.hold_catalog.set(true);
            let source = rig.source.clone();
            let discovery =
                tokio::task::spawn_local(async move { source.refresh_catalog(true).await });
            state.count(&state.catalogs, 1).await;

            for (workspace, model, prompt, endpoint, key) in [
                (
                    &ordinary_workspace,
                    "ordinary",
                    "first ordinary worktree turn",
                    rig.server
                        .route
                        .join("/ordinary/responses")
                        .unwrap()
                        .to_string(),
                    None,
                ),
                (
                    &subscription_workspace,
                    "fixture",
                    "first subscription worktree turn",
                    rig.transport.endpoint.clone(),
                    Some("fixture-loopback".into()),
                ),
            ] {
                if model == "fixture" {
                    assert!(!discovery.is_finished());
                    assert_eq!(state.ordinary_requests.borrow().len(), 1);
                    assert_eq!(state.posts.get(), 0);
                    state.hold_catalog.set(false);
                    state.catalog_gate.add_permits(1);
                }
                let http =
                    HttpModel::with_protocol(endpoint, model.into(), key, ModelProtocol::Responses)
                        .unwrap();
                let engine = Engine::open(
                    &root.path().join(format!("{model}-store")),
                    Arc::new(http),
                    Limits::default(),
                )
                .unwrap();
                if model == "fixture" {
                    // 用源的权威读取等首份目录完成；共享同一个已经发出的 GET。
                    let models = rig.source.discover(false).await.unwrap();
                    assert_eq!(models[0]["id"], model);
                }
                let target = workspace.canonicalize().unwrap();
                let thread = engine
                    .create(target.to_str().unwrap().into())
                    .await
                    .unwrap();
                // 这个夹具仅计执行轮次的请求，关闭独立的自动命名推理。
                engine
                    .configure_thread(ConfigureThread {
                        thread_id: thread.id.clone(),
                        expected_revision: thread.desktop.as_ref().map_or_else(
                            || EffectiveConfig::default().revision,
                            |desktop| desktop.configuration.revision,
                        ),
                        options: Some(ClientOptions {
                            automatic_session_name: Some(false),
                            ..Default::default()
                        }),
                        request_id: None,
                        agent_profile: None,
                        model: None,
                        reset_model: false,
                        parameters: None,
                        selected_skills: None,
                    })
                    .await
                    .unwrap();
                let turn = engine
                    .start(&thread.id, vec![Input::text(prompt)])
                    .await
                    .unwrap();
                let saved = tokio::time::timeout(Duration::from_secs(10), engine.wait(&thread.id))
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(saved.cwd, target.to_str().unwrap());
                assert_eq!(saved.turns.len(), 1);
                assert_eq!(saved.turns[0].id, turn.id);
                assert_eq!(saved.turns[0].status, TurnStatus::Completed);
                assert!(saved.turns[0].items.iter().any(
                    |item| matches!(item, Item::AgentMessage { text, .. } if text == "first")
                ));
                engine.shutdown().await;
            }
            discovery.await.unwrap().unwrap();
            assert_eq!(state.catalogs.get(), 1);
            assert_eq!(state.posts.get(), 1);
            let check_request = |requests: &[Value], model: &str, prompt: &str| {
                assert_eq!(requests.len(), 1);
                assert_eq!(requests[0]["model"], model);
                let users: Vec<_> = requests[0]["input"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|message| message["role"] == "user")
                    .map(|message| message["content"][0]["text"].as_str().unwrap())
                    .collect();
                assert_eq!(users, [prompt]);
            };
            check_request(
                &state.ordinary_requests.borrow(),
                "ordinary",
                "first ordinary worktree turn",
            );
            check_request(
                &state.received.borrow(),
                "fixture",
                "first subscription worktree turn",
            );
            rig.close().await;
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn catalog_401_get_can_refresh_but_inference_401_never_replays_and_redacts() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let rig = Rig::new(false).await;
            rig.server.state.catalog_unauthorized.set(true);
            rig.source.discover(false).await.unwrap();
            assert_eq!(rig.server.state.catalogs.get(), 2);
            assert_eq!(rig.server.state.refreshes.get(), 1);
            rig.server.state.unauthorized.set(true);
            let response = rig.request().send().await.unwrap();
            assert_eq!(response.status(), 401);
            let body = response.text().await.unwrap();
            assert!(!body.contains("next-access"));
            assert!(!body.contains("secret-refresh"));
            assert!(body.contains("invalid_token"));
            assert_eq!(rig.server.state.posts.get(), 1);
            assert_eq!(rig.server.state.refreshes.get(), 1);
            rig.close().await;
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn request_guards_adapters_affinity_and_invalid_stream_are_observed_on_http() {
    tokio::task::LocalSet::new().run_until(async {
    let rig=Rig::new(false).await;rig.source.discover(false).await.unwrap();
    assert_eq!(reqwest::Client::new().get(&rig.transport.endpoint).send().await.unwrap().status(),403);
    assert_eq!(rig.request().header("origin","http://untrusted.invalid").send().await.unwrap().status(),403);
    assert_eq!(reqwest::Client::new().post(format!("{}?x=1",rig.transport.endpoint)).bearer_auth("fixture-loopback").send().await.unwrap().status(),403);
    assert_eq!(rig.request().json(&json!({"model":"missing","stream":true,"input":[]})).send().await.unwrap().status(),400);
    let request=json!({"model":"fixture","stream":true,"input":[{"role":"system","content":"System"},{"type":"function_call","name":"run","call_id":"one","arguments":"{}"}],"tools":[{"type":"function","name":"run","parameters":{}}],"service_tier":"fast","max_output_tokens":100});
    for _ in 0..2 {let response=rig.request().header("x-areal-thread-id","thread").header("x-areal-turn-id","turn").json(&request).send().await.unwrap();assert_eq!(response.headers()["x-areal-provider-adjustments"],"max_output_tokens:core_budget_only");assert_eq!(response.bytes().await.unwrap(),[FIRST,LAST].concat());}
    { let received=rig.server.state.received.borrow();assert_eq!(received[0]["service_tier"],"priority");assert_eq!(received[0]["tools"][0]["type"],"namespace");assert_eq!(received[0]["input"][0]["call_id"],"one");}
    assert!(!rig.server.state.headers.borrow()[0].contains_key("x-codex-turn-state"));assert_eq!(rig.server.state.headers.borrow()[1]["x-codex-turn-state"],"route-one");
    rig.server.state.invalid_stream.set(true);assert_eq!(rig.request().send().await.unwrap().status(),502);assert_eq!(rig.server.state.posts.get(),3);
    rig.close().await;
}).await;
}

#[tokio::test(flavor = "current_thread")]
async fn logout_aborts_the_existing_http_body_and_source_close_drains_owned_tasks() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let rig = Rig::new(false).await;
            rig.source.discover(false).await.unwrap();
            rig.server.state.hold_stream.set(true);
            let response = rig.request().send().await.unwrap();
            let mut stream = response.bytes_stream();
            assert_eq!(stream.next().await.unwrap().unwrap(), FIRST);
            rig.source.logout().unwrap();
            let ended = tokio::time::timeout(Duration::from_secs(5), stream.next())
                .await
                .unwrap();
            assert!(
                ended.is_some_and(|chunk| chunk.is_err()),
                "old epoch must abort HTTP framing, not successfully finish"
            );
            assert_eq!(rig.server.state.posts.get(), 1);
            rig.close().await;
        })
        .await;
}
