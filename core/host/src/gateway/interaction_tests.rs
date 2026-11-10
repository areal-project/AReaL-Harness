#[path = "native_creation_recovery_tests.rs"]
mod native_creation_recovery_tests;

#[path = "creation_recovery_tests.rs"]
mod creation_recovery_tests;

#[path = "artifact_tests.rs"]
mod artifact_tests;

use super::*;
use areal_local_service::storage;
use areal_protocol::service::{Service, State};
use futures_util::{SinkExt, StreamExt};
use std::os::unix::fs::PermissionsExt;
use tokio::{net::TcpListener, sync::mpsc, task::AbortHandle};
use tokio_tungstenite::tungstenite::Message;

const ORIGINAL_DIGEST: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

#[test]
fn unavailable_tool_host_retains_determinate_rejection() {
    let mut record = json!({"method":"areal/turn/start","operationId":"native-request",
        "admissionState":"rejected","remote":{"method":"session.send","target":{"threadId":"thread"}},
        "error":{"code":-32602,"message":"private diagnostic must not be forwarded",
            "data":{"reason":"TOOL_HOST_UNAVAILABLE","outcome":{"kind":"rejected"}}}});
    let unavailable = Session::command_view(Some(&record), "original-command");
    assert_eq!(unavailable["admissionState"], "rejected");
    assert_eq!(unavailable["submissionUnknown"], false);
    assert_eq!(unavailable["error"]["code"], "CAPABILITY_UNAVAILABLE");
    assert_eq!(unavailable["nativeRequestId"], "native-request");
    assert!(!unavailable.to_string().contains("private diagnostic"));
    record["error"]["data"]["reason"] = json!("REQUEST_REJECTED");
    assert_eq!(
        Session::command_view(Some(&record), "original-command")["error"]["code"],
        "INVALID_PARAMS"
    );
}

enum CoreResponse {
    Message(Value),
    Disconnect,
}

struct CoreCall {
    request: Value,
    responses: mpsc::UnboundedSender<CoreResponse>,
}
impl CoreCall {
    fn reply(self, result: Value) {
        self.responses
            .send(CoreResponse::Message(
                json!({"id":self.request["id"],"result":result}),
            ))
            .unwrap();
    }
    fn reject(self) {
        self.responses.send(CoreResponse::Message(json!({"id":self.request["id"],"error":{"code":-32009,"message":"original interaction already answered"}}))).unwrap();
    }
    fn invalid(self, message: &str) {
        self.responses
            .send(CoreResponse::Message(
                json!({"id":self.request["id"],"error":{"code":-32602,"message":message}}),
            ))
            .unwrap();
    }
    fn disconnect(self) {
        self.responses.send(CoreResponse::Disconnect).unwrap();
    }
}

struct Fixture {
    root: tempfile::TempDir,
    host: Rc<Host>,
    source: String,
    alias: String,
    calls: mpsc::UnboundedReceiver<CoreCall>,
    server: AbortHandle,
    close: Box<dyn Fn()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        (self.close)();
        self.server.abort();
    }
}
impl Fixture {
    async fn new() -> Self {
        Self::with_write_hook(None).await
    }
    async fn with_write_hook(hook: Option<std::sync::Arc<dyn Fn() + Send + Sync>>) -> Self {
        let root = tempfile::tempdir().unwrap();
        let mut host = crate::server::schedules::tests::fixture(root.path());
        Rc::get_mut(&mut host.migration).unwrap().vault =
            crate::vault::Vault::isolated_files(&host.home);
        let source = crate::migration::Source {
            profile: root.path().join("profile"),
            core_home: root.path().join("legacy-core"),
            legacy_service_home: root.path().join("legacy-service"),
        };
        storage::private_dir(&source.profile).unwrap();
        storage::private_dir(&source.core_home).unwrap();
        storage::write(&source.core_home.join("projects.json"), &json!([])).unwrap();
        host.migration
            .attach(source.clone(), "fixture", None)
            .unwrap();
        let imported = host.migration.import(
            serde_json::from_value(json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":host.identity.generation,"source":source})).unwrap(),
            "fixture", &[], &host.journal,
        ).unwrap();
        assert_eq!(imported["kind"], "ready");
        let source = host.migration.source(source, &[]).unwrap()["sourceId"]
            .as_str()
            .unwrap()
            .to_owned();
        let registration = host.slots.borrow()["project"].registration.clone();
        let launch_dir = host
            .home
            .join("host/launch")
            .join(storage::digest(b"project"));
        storage::private_dir(&launch_dir).unwrap();
        storage::write(
            &launch_dir.join("inputs.json"),
            &crate::LaunchInputs {
                workspace: registration.workspace.clone(),
                cwd: registration.workspace.clone(),
                config_home: host.home.clone(),
                homedir: None,
                config_path: None,
                deployment_path: None,
                schedule_preparation: None,
                environment: Default::default(),
                credential_names: vec![],
                options: Default::default(),
            },
        )
        .unwrap();
        let alias = host
            .migration
            .remote_projects(&source, &[registration])
            .unwrap()
            .remove(0);
        let identity = base64::engine::general_purpose::STANDARD.encode(
            libp2p_identity::Keypair::ed25519_from_bytes([9u8; 32])
                .unwrap()
                .to_protobuf_encoding()
                .unwrap(),
        );
        let config = json!({"identity":identity,"directEnabled":true,"deviceGrants":[
            {"devicePeerId":"a","status":"active","revision":1,"projectIds":[alias],"capabilities":["observe","answer","submit"]},
            {"devicePeerId":"b","status":"active","revision":1,"projectIds":[alias],"capabilities":["observe","answer","submit"]}
        ]});
        host.remote
            .dispatch(
                "remote.acquire",
                json!({"sourceId":source}),
                "fixture",
                &host.identity.generation,
                &host.migration,
                std::slice::from_ref(&alias),
            )
            .unwrap();
        host.remote.dispatch("remote.replace", json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":host.identity.generation,"expectedRevision":0,"sourceId":source,"config":config}), "fixture", &host.identity.generation, &host.migration, std::slice::from_ref(&alias)).unwrap();
        host.remote.disconnect("fixture");
        host.remote.handoff(json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":host.identity.generation,"sourceId":source,"expectedRevision":1}), &host.identity, &host.migration).unwrap();
        *host.gateway.generation.borrow_mut() = "gateway".into();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}/", listener.local_addr().unwrap());
        let (incoming, calls) = mpsc::unbounded_channel();
        let server = tokio::task::spawn_local(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let incoming = incoming.clone();
                connections.spawn_local(async move {
                    let socket = tokio_tungstenite::accept_hdr_async(stream,
                        OwnerHeaders).await.unwrap();
                    let (mut writer, mut reader) = socket.split();
                    let (responses, mut outgoing) = mpsc::unbounded_channel();
                    loop {
                        tokio::select! {
                            response = outgoing.recv() => match response {
                                Some(CoreResponse::Message(value)) => {
                                    if writer.send(Message::Text(value.to_string().into())).await.is_err() { break; }
                                }
                                Some(CoreResponse::Disconnect) | None => {
                                    let _ = writer.close().await;
                                    break;
                                }
                            },
                            message = reader.next() => {
                                let Some(Ok(Message::Text(text))) = message else { break; };
                                let request: Value = serde_json::from_str(&text).unwrap();
                                if request["method"] == "initialized" { continue; }
                                if request["method"] == "initialize" || request["method"] == "areal/subscription/remove" {
                                    writer.send(Message::Text(json!({"id":request["id"],"result":{}}).to_string().into())).await.unwrap();
                                    continue;
                                }
                                if incoming.send(CoreCall { request, responses: responses.clone() }).is_err() { break; }
                            }
                        }
                    }
                });
            }
        }).abort_handle();
        Rc::get_mut(&mut host.migration).unwrap().vault.before_write = hook;
        let host = Rc::new(host);
        let service = Self::service(&host, endpoint);
        let close = host
            .schedules
            .connections
            .connect_test_core(host.clone(), "project", service)
            .await
            .unwrap();
        Self {
            root,
            host,
            source,
            alias,
            calls,
            server,
            close,
        }
    }
    fn service(host: &Host, endpoint: String) -> Service {
        let registration = host.slots.borrow()["project"].registration.clone();
        let service = Service {
            identity: areal_protocol::service::Identity {
                protocol_version: 1,
                service_id: "original-service".into(),
                generation: "core-generation".into(),
                workspace: registration.workspace,
                data_dir: registration.data_dir,
                config_fingerprint: "fixture".into(),
            },
            owner: Some(host.owner()),
            endpoint,
            web_url: String::new(),
            auth_file: host.home.join("core-auth.json"),
            log_file: host.home.join("core.log"),
            host_pid: 1,
            core_pid: 2,
            state: State::Ready,
        };
        storage::write(
            &service.auth_file,
            &json!({"principals":[{"id":"desktop-owner","token":"original-owner-token"}]}),
        )
        .unwrap();
        let mut slots = host.slots.borrow_mut();
        let slot = slots.get_mut("project").unwrap();
        slot.service = Some(service.clone());
        slot.state = "ready".into();
        service
    }
    async fn reconnect(&mut self) {
        let service = self.host.slots.borrow()["project"].service.clone().unwrap();
        self.close = self
            .host
            .schedules
            .connections
            .connect_test_core(self.host.clone(), "project", service)
            .await
            .unwrap();
    }
    fn session(&self, peer: &str) -> Session {
        let snapshot = self.host.remote.snapshot(&self.host.migration).unwrap();
        Session {
            host: self.host.clone(),
            peer: peer.into(),
            grant: gateway_owner::grant(&snapshot["config"], peer).unwrap(),
            generation: "gateway".into(),
            connection: uuid::Uuid::new_v4().to_string(),
            host_peer: wire::Identity::from_base64(
                snapshot["config"]["identity"].as_str().unwrap(),
            )
            .unwrap()
            .peer()
            .to_string(),
            transport: gateway_owner::transport_key(
                &snapshot["config"],
                gateway_owner::TransportKind::Direct,
            ),
            kind: gateway_owner::TransportKind::Direct,
            source_id: self.source.clone(),
            viewer: None,
            shell: None,
            gui_read: false,
            gui_write: false,
            local: false,
            browser_device: None,
            uploads: Default::default(),
            token_key: [7; 32],
        }
    }
    fn grant(&self, peer: &str, mutate: impl FnOnce(&mut Value)) {
        let snapshot = self.host.remote.snapshot(&self.host.migration).unwrap();
        let mut config = snapshot["config"].clone();
        let grant = config["deviceGrants"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|grant| grant["devicePeerId"] == peer)
            .unwrap();
        mutate(grant);
        self.host.remote.dispatch("remote.gateway.replace", json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":self.host.identity.generation,"expectedRevision":snapshot["revision"],"sourceId":self.source,"config":config}), "fixture", &self.host.identity.generation, &self.host.migration, std::slice::from_ref(&self.alias)).unwrap();
    }
    async fn workspace_admission(&mut self) {
        let root = self.host.slots.borrow()["project"]
            .registration
            .workspace
            .clone();
        let thread = self.call("thread/read").await;
        assert_eq!(
            thread.request["params"],
            json!({"threadId":"thread","includeTurns":false})
        );
        thread.reply(json!({"thread":{"id":"thread","sessionId":"thread","cwd":root,"desktop":{"configuration":{"options":{}}}}}));
        let catalog = self.call("areal/task/list").await;
        assert_eq!(catalog.request["params"]["limit"], 100);
        catalog.reply(json!({"data":[],"nextCursor":null,"hasMore":false}));
    }
    async fn call(&mut self, method: &str) -> CoreCall {
        let call = tokio::time::timeout(Duration::from_secs(5), self.calls.recv())
            .await
            .unwrap_or_else(|_| panic!("Core peer did not receive {method}"))
            .unwrap();
        assert_eq!(call.request["method"], method);
        call
    }
    fn request(&self, method: &str, params: Value, command: Option<&str>) -> Value {
        let mut request = json!({"id":uuid::Uuid::new_v4().to_string(),"method":method,"params":params,"context":{"projectId":self.alias}});
        if let Some(command) = command {
            request["commandId"] = json!(command);
            request["context"]["gatewayGeneration"] = json!("gateway");
            request["context"]["grantRevision"] = json!(1);
            request["context"]["serviceGeneration"] = json!("core-generation");
        }
        request
    }
    fn native_read_request(&self, method: &str, params: Value) -> Value {
        let mut request = self.request(method, params, None);
        request["context"]["projectId"] = json!("project");
        request
    }
    fn item(status: &str) -> Value {
        json!({"threadId":"thread","turnId":"turn","requestId":"interaction","kind":"approval","status":status,"expiresAt":4_000_000_000u64,"argumentsDigest":ORIGINAL_DIGEST,"tool":"fs_create","generation":1,"effectiveArguments":{"path":"original.txt","text":"original"},"effectivePermissions":[]})
    }
    fn target() -> Value {
        json!({"threadId":"thread","turnId":"turn","interactionId":"interaction"})
    }
    fn capabilities() -> Value {
        json!({"features":{"atomicObserveOwnership":true,"turnStartAdmissionGuard":true,"threadCreationJournal":{"binding":{"identity":"store","journalEpoch":"epoch"}}},"methods":["areal/thread/configure","areal/turn/start","areal/request/read"]})
    }
    fn idle_thread(revision: u64) -> Value {
        json!({"thread":{"id":"thread","status":{"type":"idle"},"turns":[{"id":"turn","status":"completed","items":[]}],"desktop":{"configuration":{"revision":revision}}},"ownership":{"kind":"ordinary"}})
    }
    fn answer(&self, token: Value, command: &str) -> Value {
        let mut params = Self::target();
        params["argumentsDigest"] = json!(ORIGINAL_DIGEST);
        params["decision"] = json!("allowOnce");
        params["reviewToken"] = token;
        self.request("interaction.respond", params, Some(command))
    }
    async fn review(&mut self, mut session: Session) -> (Session, Value) {
        let request = self.request("attention.read", Self::target(), None);
        let reading = tokio::task::spawn_local(async move {
            let result = session.request(&request).await.unwrap();
            (session, result)
        });
        self.call("areal/interaction/list")
            .await
            .reply(json!({"data":[Self::item("pending")]}));
        let (session, detail) = reading.await.unwrap();
        assert_eq!(detail["complete"], true);
        (session, detail["reviewToken"].clone())
    }
    fn dispatch(
        mut session: Session,
        request: Value,
    ) -> tokio::task::JoinHandle<(Session, Result<Value>)> {
        tokio::task::spawn_local(async move {
            let result = session.request(&request).await;
            (session, result)
        })
    }
}

#[tokio::test(flavor = "current_thread")]
async fn lost_core_response_keeps_original_unknown_without_replay_or_cross_device_leak() {
    tokio::task::LocalSet::new().run_until(async {
        let mut f = Fixture::new().await;
        let (session, token) = f.review(f.session("a")).await;
        let command = uuid::Uuid::new_v4().to_string();
        let request = f.answer(token, &command);
        let answering = Fixture::dispatch(session, request.clone());
        f.call("areal/interaction/list").await.reply(json!({"data":[Fixture::item("pending")]}));
        let call = f.call("areal/interaction/respond").await;
        assert_eq!(call.request["params"], json!({"threadId":"thread","turnId":"turn","requestId":"interaction","decision":"allowOnce","argumentsDigest":ORIGINAL_DIGEST}));
        call.disconnect();
        let (session, result) = answering.await.unwrap();
        let original = result.unwrap();
        assert_eq!(original["admissionState"], "unknown");
        assert!(original.get("receipt").is_none());
        assert_eq!(original["submissionUnknown"], true);
        f.reconnect().await;
        for request in [request, f.request("command.read", json!({"commandId":command}), None)] {
            let reading = Fixture::dispatch(f.session("a"), request);
            f.call("areal/interaction/list").await.reply(json!({"data":[Fixture::item("answered")]}));
            let (_, result) = reading.await.unwrap();
            let result = result.unwrap();
            assert_eq!(result["admissionState"], "unknown");
            assert_eq!(result["operationId"], original["operationId"]);
            assert_eq!(result["observedState"]["status"], "answered");
            assert_eq!(result["observedState"]["provesCommandAdmission"], false);
            assert!(result.get("receipt").is_none());
        }
        let mut other = f.session("b");
        assert_eq!(other.request(&f.request("command.read", json!({"commandId":command}), None)).await.unwrap()["admissionState"], "notFound");
        f.grant("a", |grant| grant["capabilities"] = json!(["observe"]));
        let mut session = session;
        assert_eq!(session.request(&f.request("command.read", json!({"commandId":command}), None)).await.unwrap_err().to_string(), "FORBIDDEN");
        assert!(f.calls.try_recv().is_err());
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn two_preflighted_devices_keep_distinct_original_outcomes_and_one_core_answer() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let mut f = Fixture::new().await;
            let (a, token_a) = f.review(f.session("a")).await;
            let (b, token_b) = f.review(f.session("b")).await;
            let command_a = uuid::Uuid::new_v4().to_string();
            let command_b = uuid::Uuid::new_v4().to_string();
            let mut one = Fixture::dispatch(a, f.answer(token_a, &command_a));
            let mut two = Fixture::dispatch(b, f.answer(token_b, &command_b));
            let preflight_a = f.call("areal/interaction/list").await;
            let preflight_b = f.call("areal/interaction/list").await;
            preflight_a.reply(json!({"data":[Fixture::item("pending")]}));
            preflight_b.reply(json!({"data":[Fixture::item("pending")]}));
            let first = f.call("areal/interaction/respond").await;
            let second = tokio::select! {
                call = f.call("areal/interaction/respond") => call,
                done = &mut one => panic!("first original command returned before both Core dispatches: {:?}", done.unwrap().1),
                done = &mut two => panic!("second original command returned before both Core dispatches: {:?}", done.unwrap().1),
            };
            assert_eq!(first.request["params"], second.request["params"]);
            first.reply(json!({"answered":true,"requestId":"interaction"}));
            second.reject();
            for _ in 0..2 {
                f.call("areal/interaction/list")
                    .await
                    .reply(json!({"data":[Fixture::item("answered")]}));
            }
            let (mut a, one) = one.await.unwrap();
            let (_, two) = two.await.unwrap();
            let one = one.unwrap();
            let two = two.unwrap();
            assert_eq!(one["commandId"], command_a);
            assert_eq!(two["commandId"], command_b);
            for result in [&one, &two] {
                assert_eq!(result["target"]["threadId"], "thread");
                assert_eq!(result["target"]["turnId"], "turn");
                assert_eq!(result["target"]["interactionId"], "interaction");
                assert_eq!(result["target"]["argumentsDigest"], ORIGINAL_DIGEST);
            }
            let mut states = [
                one["admissionState"].as_str().unwrap(),
                two["admissionState"].as_str().unwrap(),
            ];
            states.sort();
            assert_eq!(states, ["accepted", "rejected"]);
            assert_ne!(one["operationId"], two["operationId"]);
            let rejected = if one["admissionState"] == "rejected" {
                &one
            } else {
                &two
            };
            assert_eq!(rejected["error"]["code"], "TARGET_CHANGED");
            assert_eq!(
                a.request(&f.request("command.read", json!({"commandId":command_b}), None))
                    .await
                    .unwrap()["admissionState"],
                "notFound"
            );
            assert!(f.calls.try_recv().is_err());
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn delayed_duplicate_preflight_returns_original_durable_outcome_without_dispatch() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let mut f = Fixture::new().await;
            let (a, token) = f.review(f.session("a")).await;
            let (second, second_token) = f.review(f.session("a")).await;
            let command = uuid::Uuid::new_v4().to_string();
            let request = f.answer(token, &command);
            let delayed = Fixture::dispatch(a, request.clone());
            let held = f.call("areal/interaction/list").await;
            let first = Fixture::dispatch(second, f.answer(second_token, &command));
            f.call("areal/interaction/list")
                .await
                .reply(json!({"data":[Fixture::item("pending")]}));
            f.call("areal/interaction/respond")
                .await
                .reply(json!({"answered":true,"requestId":"interaction"}));
            f.call("areal/interaction/list")
                .await
                .reply(json!({"data":[Fixture::item("answered")]}));
            let (_, accepted) = first.await.unwrap();
            let accepted = accepted.unwrap();
            assert_eq!(accepted["admissionState"], "accepted");
            held.reply(json!({"data":[Fixture::item("pending")]}));
            f.call("areal/interaction/list")
                .await
                .reply(json!({"data":[Fixture::item("answered")]}));
            let (_, duplicate) = delayed.await.unwrap();
            assert_eq!(duplicate.unwrap(), accepted);
            assert!(f.calls.try_recv().is_err());
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn detail_and_original_command_observation_fence_final_grant_and_service_identity() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for mode in ["revoke", "generation"] {
                let mut f = Fixture::new().await;
                let reading = Fixture::dispatch(
                    f.session("a"),
                    f.request("attention.read", Fixture::target(), None),
                );
                let held = f.call("areal/interaction/list").await;
                if mode == "revoke" {
                    f.grant("a", |grant| grant["status"] = json!("revoked"));
                } else {
                    f.host
                        .slots
                        .borrow_mut()
                        .get_mut("project")
                        .unwrap()
                        .service
                        .as_mut()
                        .unwrap()
                        .identity
                        .generation = "replacement".into();
                }
                held.reply(json!({"data":[Fixture::item("pending")]}));
                let (_, result) = reading.await.unwrap();
                assert!(result.is_err(), "{mode}");
                assert!(
                    f.host.journal.native_snapshot("project").unwrap().1["pending"]
                        .as_array()
                        .unwrap()
                        .is_empty()
                );
            }
            for mode in ["capability", "generation"] {
                let mut f = Fixture::new().await;
                let (session, token) = f.review(f.session("a")).await;
                let command = uuid::Uuid::new_v4().to_string();
                let answering = Fixture::dispatch(session, f.answer(token, &command));
                f.call("areal/interaction/list")
                    .await
                    .reply(json!({"data":[Fixture::item("pending")]}));
                f.call("areal/interaction/respond")
                    .await
                    .reply(json!({"answered":true}));
                f.call("areal/interaction/list")
                    .await
                    .reply(json!({"data":[Fixture::item("answered")]}));
                let (session, accepted) = answering.await.unwrap();
                assert_eq!(accepted.unwrap()["admissionState"], "accepted");
                let reading = Fixture::dispatch(
                    session,
                    f.request("command.read", json!({"commandId":command}), None),
                );
                let held = f.call("areal/interaction/list").await;
                if mode == "capability" {
                    f.grant("a", |grant| grant["capabilities"] = json!(["observe"]));
                } else {
                    f.host
                        .slots
                        .borrow_mut()
                        .get_mut("project")
                        .unwrap()
                        .service
                        .as_mut()
                        .unwrap()
                        .identity
                        .generation = "replacement".into();
                }
                held.reply(json!({"data":[Fixture::item("answered")]}));
                let (_, result) = reading.await.unwrap();
                assert!(result.is_err(), "{mode}");
            }
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn revocation_during_preflight_prevents_dispatch_and_after_dispatch_preserves_receipt() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let mut f = Fixture::new().await;
            let (session, token) = f.review(f.session("a")).await;
            let command = uuid::Uuid::new_v4().to_string();
            let answering = Fixture::dispatch(session, f.answer(token, &command));
            let held = f.call("areal/interaction/list").await;
            f.grant("a", |grant| grant["status"] = json!("revoked"));
            held.reply(json!({"data":[Fixture::item("pending")]}));
            assert_eq!(
                answering.await.unwrap().1.unwrap_err().to_string(),
                "GRANT_CHANGED"
            );
            assert!(f.calls.try_recv().is_err());
            assert!(
                f.host.journal.native_snapshot("project").unwrap().1["pending"]
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
            f.grant("a", |grant| grant["status"] = json!("active"));
            let (session, token) = f.review(f.session("a")).await;
            let command = uuid::Uuid::new_v4().to_string();
            let answering = Fixture::dispatch(session, f.answer(token, &command));
            f.call("areal/interaction/list")
                .await
                .reply(json!({"data":[Fixture::item("pending")]}));
            let held = f.call("areal/interaction/respond").await;
            f.grant("a", |grant| grant["status"] = json!("revoked"));
            held.reply(json!({"answered":true,"requestId":"interaction"}));
            assert_eq!(
                answering.await.unwrap().1.unwrap_err().to_string(),
                "GRANT_CHANGED"
            );
            f.grant("a", |grant| grant["status"] = json!("active"));
            let reading = Fixture::dispatch(
                f.session("a"),
                f.request("command.read", json!({"commandId":command}), None),
            );
            f.call("areal/interaction/list")
                .await
                .reply(json!({"data":[Fixture::item("answered")]}));
            let recovered = reading.await.unwrap().1.unwrap();
            assert_eq!(recovered["admissionState"], "accepted");
            assert_eq!(recovered["receipt"]["requestId"], "interaction");
            assert!(f.calls.try_recv().is_err());
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn lost_outcome_write_stays_unknown_after_same_home_owner_reconstruction() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let mut f = Fixture::new().await;
            let (session, token) = f.review(f.session("a")).await;
            let command = uuid::Uuid::new_v4().to_string();
            let request = f.answer(token, &command);
            let answering = Fixture::dispatch(session, request.clone());
            f.call("areal/interaction/list")
                .await
                .reply(json!({"data":[Fixture::item("pending")]}));
            let held = f.call("areal/interaction/respond").await;
            let (revision, pending) = f.host.journal.native_snapshot("project").unwrap();
            assert_eq!(pending["pending"].as_array().unwrap().len(), 1);
            let operation = pending["pending"][0]["operationId"].clone();
            crate::journal::FAIL_RECORD_WRITES.with(|fail| fail.set(true));
            held.reply(json!({"answered":true,"requestId":"interaction"}));
            let (_, result) = answering.await.unwrap();
            crate::journal::FAIL_RECORD_WRITES.with(|fail| fail.set(false));
            assert!(result.is_err());
            assert_eq!(
                f.host.journal.native_snapshot("project").unwrap(),
                (revision, pending)
            );
            let service = f.host.slots.borrow()["project"].service.clone().unwrap();
            (f.close)();
            let old_host = Rc::downgrade(&f.host);
            let mut restarted = crate::server::schedules::tests::fixture(f.root.path());
            Rc::get_mut(&mut restarted.migration).unwrap().vault =
                crate::vault::Vault::isolated_files(&restarted.home);
            assert!(restarted.remote.snapshot(&restarted.migration).is_err());
            restarted
                .remote
                .snapshot_async(&restarted.migration)
                .await
                .unwrap();
            *restarted.gateway.generation.borrow_mut() = "gateway".into();
            {
                let mut slots = restarted.slots.borrow_mut();
                let slot = slots.get_mut("project").unwrap();
                slot.service = Some(service.clone());
                slot.state = "ready".into();
            }
            f.host = Rc::new(restarted);
            f.close = f
                .host
                .schedules
                .connections
                .connect_test_core(f.host.clone(), "project", service)
                .await
                .unwrap();
            tokio::task::yield_now().await;
            assert!(old_host.upgrade().is_none());
            for request in [
                request,
                f.request("command.read", json!({"commandId":command}), None),
            ] {
                let reading = Fixture::dispatch(f.session("a"), request);
                f.call("areal/interaction/list")
                    .await
                    .reply(json!({"data":[Fixture::item("answered")]}));
                let (_, result) = reading.await.unwrap();
                let result = result.unwrap();
                assert_eq!(result["admissionState"], "unknown");
                assert_eq!(result["operationId"], operation);
                assert_eq!(result["observedState"]["provesCommandAdmission"], false);
                assert!(result.get("receipt").is_none());
            }
            assert!(f.calls.try_recv().is_err());
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn create_pending_write_failure_prevents_core_mutation() {
    tokio::task::LocalSet::new().run_until(async {
        let mut f = Fixture::new().await;
        let command = uuid::Uuid::new_v4().to_string();
        let creating = Fixture::dispatch(f.session("a"), f.request("session.create", json!({}), Some(&command)));
        let caps = f.call("areal/capabilities").await;
        let before = f.host.journal.native_snapshot("project").unwrap();
        crate::journal::FAIL_RECORD_WRITES.with(|fail| fail.set(true));
        caps.reply(json!({"features":{"threadStartAdmissionGuard":true,"permissionPresets":true,"threadCreationJournal":{"binding":{"identity":"store","journalEpoch":"epoch","coreInstanceId":"instance"}}},"methods":["areal/thread/start","areal/request/read"]}));
        let (_, result) = creating.await.unwrap();
        crate::journal::FAIL_RECORD_WRITES.with(|fail| fail.set(false));
        assert!(result.unwrap_err().chain().any(|error| error.downcast_ref::<std::io::Error>().is_some_and(|error| error.kind() == std::io::ErrorKind::PermissionDenied)));
        assert_eq!(f.host.journal.native_snapshot("project").unwrap(), before);
        assert!(f.calls.try_recv().is_err());
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn create_lost_outcome_recovers_original_receipt_after_owner_reconstruction() {
    tokio::task::LocalSet::new().run_until(async {
        let mut f = Fixture::new().await;
        let command = uuid::Uuid::new_v4().to_string();
        let request = f.request("session.create", json!({}), Some(&command));
        let mut creating = Fixture::dispatch(f.session("a"), request.clone());
        f.call("areal/capabilities").await.reply(json!({"features":{"threadStartAdmissionGuard":true,"permissionPresets":true,"threadCreationJournal":{"binding":{"identity":"store","journalEpoch":"11111111-1111-4111-8111-111111111111","coreInstanceId":"22222222-2222-4222-8222-222222222222"}}},"methods":["areal/thread/start","areal/request/read"]}));
        let held = tokio::select! {
            call = f.call("areal/thread/start") => call,
            done = &mut creating => panic!("creation ended before dispatch: {:?}", done.unwrap().1),
        };
        let (revision, pending) = f.host.journal.native_snapshot("project").unwrap();
        let record = &pending["pending"][0];
        let operation = record["operationId"].clone();
        assert_eq!(held.request["params"]["requestId"], operation);
        let digest = record["nativeDigest"].clone();
        crate::journal::FAIL_RECORD_WRITES.with(|fail| fail.set(true));
        held.reply(json!({"thread":{"id":"created-thread"}}));
        let (_, result) = creating.await.unwrap();
        crate::journal::FAIL_RECORD_WRITES.with(|fail| fail.set(false));
        let unknown = result.unwrap();
        assert_eq!(unknown["commandId"], command);
        assert_eq!(unknown["operationId"], operation);
        assert_eq!(unknown["admissionState"], "unknown");
        assert_eq!(unknown["submissionUnknown"], true);
        assert!(unknown.get("threadId").is_none());
        assert!(unknown.get("receipt").is_none());
        assert_eq!(f.host.journal.native_snapshot("project").unwrap(), (revision, pending));
        let service = f.host.slots.borrow()["project"].service.clone().unwrap();
        (f.close)();
        let old_host = Rc::downgrade(&f.host);
        let mut restarted = crate::server::schedules::tests::fixture(f.root.path());
        Rc::get_mut(&mut restarted.migration).unwrap().vault = crate::vault::Vault::isolated_files(&restarted.home);
        assert!(restarted.remote.snapshot(&restarted.migration).is_err());
        restarted.remote.snapshot_async(&restarted.migration).await.unwrap();
        *restarted.gateway.generation.borrow_mut() = "gateway".into();
        {
            let mut slots = restarted.slots.borrow_mut();
            let slot = slots.get_mut("project").unwrap();
            slot.service = Some(service.clone());
            slot.state = "ready".into();
        }
        f.host = Rc::new(restarted);
        f.close = f.host.schedules.connections.connect_test_core(f.host.clone(), "project", service).await.unwrap();
        tokio::task::yield_now().await;
        assert!(old_host.upgrade().is_none());
        let reading = Fixture::dispatch(f.session("a"), f.request("command.read", json!({"commandId":command}), None));
        f.call("areal/capabilities").await.reply(json!({"features":{"threadCreationJournal":{"binding":{"identity":"store","journalEpoch":"11111111-1111-4111-8111-111111111111","coreInstanceId":"22222222-2222-4222-8222-222222222222"}}}}));
        let query = f.call("areal/request/read").await;
        assert_eq!(query.request["params"], json!({"requestId":operation,"creationAdmission":{"identity":"store","journalEpoch":"11111111-1111-4111-8111-111111111111","coreInstanceId":"22222222-2222-4222-8222-222222222222"}}));
        query.reply(json!({"data":[{"requestId":operation,"method":"areal/thread/start","digest":digest,"identity":"store","status":"completed","threadId":"created-thread","operation":{"requestId":operation,"method":"areal/thread/start","target":{"kind":"thread","threadId":"created-thread"}}}]}));
        let (_, recovered) = reading.await.unwrap();
        let recovered = recovered.unwrap();
        assert_eq!(recovered["commandId"], command);
        assert_eq!(recovered["operationId"], operation);
        assert_eq!(recovered["admissionState"], "accepted");
        assert_eq!(recovered["receipt"]["threadId"], "created-thread");
        let (_, duplicate) = Fixture::dispatch(f.session("a"), request).await.unwrap();
        assert_eq!(duplicate.unwrap(), recovered);
        assert!(f.calls.try_recv().is_err());
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn stop_lost_response_keeps_original_unknown_without_redispatch() {
    tokio::task::LocalSet::new().run_until(async {
        let mut f = Fixture::new().await;
        f.grant("a", |grant| grant["capabilities"] = json!(["observe", "answer", "submit", "interrupt"]));
        let command = uuid::Uuid::new_v4().to_string();
        let request = f.request("turn.stop", json!({"threadId":"thread","expectedTurnId":"turn"}), Some(&command));
        let stopping = Fixture::dispatch(f.session("a"), request.clone());
        f.call("areal/capabilities").await.reply(json!({"features":{"turnInterruptAdmissionGuard":true,"atomicObserveOwnership":true},"methods":["turn/interrupt"]}));
        f.call("areal/thread/observe").await.reply(json!({"thread":{"id":"thread","status":{"type":"active"},"turns":[{"id":"turn","status":"inProgress","items":[]}]},"ownership":{"kind":"ordinary"}}));
        let interrupt = f.call("turn/interrupt").await;
        assert_eq!(interrupt.request["params"], json!({"threadId":"thread","turnId":"turn","admissionGuard":{"ordinarySession":true}}));
        interrupt.disconnect();
        let (_, result) = stopping.await.unwrap();
        let original = result.unwrap();
        assert_eq!(original["admissionState"], "unknown");
        f.reconnect().await;
        for request in [request, f.request("command.read", json!({"commandId":command}), None)] {
            let (_, result) = Fixture::dispatch(f.session("a"), request).await.unwrap();
            let result = result.unwrap();
            assert_eq!(result["admissionState"], "unknown");
            assert_eq!(result["commandId"], command);
            assert_eq!(result["operationId"], original["operationId"]);
        }
        assert!(f.calls.try_recv().is_err());
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn unknown_original_answer_allows_settled_ordinary_operations_but_not_unknown_submission() {
    tokio::task::LocalSet::new().run_until(async {
        let mut f = Fixture::new().await;
        let (session, token) = f.review(f.session("a")).await;
        let command = uuid::Uuid::new_v4().to_string();
        let answering = Fixture::dispatch(session, f.answer(token, &command));
        f.call("areal/interaction/list").await.reply(json!({"data":[Fixture::item("pending")]}));
        f.call("areal/interaction/respond").await.disconnect();
        let (session, unknown) = answering.await.unwrap();
        let original = unknown.unwrap();
        assert_eq!(original["admissionState"], "unknown");
        f.reconnect().await;
        let configure = f.request("session.control", json!({"threadId":"thread","operation":"configure","expectedRevision":1,"values":{"model":{"providerId":"fixture","modelId":"fixture"}}}), Some(&uuid::Uuid::new_v4().to_string()));
        let configuring = Fixture::dispatch(session, configure);
        f.call("areal/capabilities").await.reply(Fixture::capabilities());
        f.call("areal/thread/observe").await.reply(Fixture::idle_thread(1));
        f.call("areal/thread/inspect").await.reply(json!({"configuration":{"revision":1}}));
        let configuration = f.call("areal/thread/configure").await;
        assert_eq!(configuration.request["params"]["threadId"], "thread");
        assert_eq!(configuration.request["params"]["expectedRevision"], 1);
        configuration.reply(json!({"revision":2}));
        let (session, configured) = configuring.await.unwrap();
        assert_eq!(configured.unwrap()["admissionState"], "accepted");
        let send = f.request("session.send", json!({"threadId":"thread","expectedConfigRevision":2,"text":"later"}), Some(&uuid::Uuid::new_v4().to_string()));
        let sending = Fixture::dispatch(session, send);
        f.call("areal/capabilities").await.reply(Fixture::capabilities());
        f.call("areal/thread/observe").await.reply(Fixture::idle_thread(2));
        f.workspace_admission().await;
        let turn = f.call("areal/turn/start").await;
        assert_eq!(turn.request["params"]["threadId"], "thread");
        assert_eq!(turn.request["params"]["input"], json!([{"type":"text","text":"later","text_elements":[]}]));
        turn.reply(json!({"turn":{"id":"later-turn"}}));
        let (session, sent) = sending.await.unwrap();
        let sent = sent.unwrap();
        assert_eq!(sent["admissionState"], "accepted");
        assert_eq!(sent["turnId"], "later-turn");
        let reading = Fixture::dispatch(session, f.request("command.read", json!({"commandId":command}), None));
        f.call("areal/interaction/list").await.reply(json!({"data":[Fixture::item("answered")]}));
        let (session, recovered) = reading.await.unwrap();
        let recovered = recovered.unwrap();
        assert_eq!(recovered["operationId"], original["operationId"]);
        assert_eq!(recovered["admissionState"], "unknown");
        let ordinary = f.request("session.send", json!({"threadId":"thread","expectedConfigRevision":2,"text":"unresolved"}), Some(&uuid::Uuid::new_v4().to_string()));
        let sending = Fixture::dispatch(session, ordinary);
        f.call("areal/capabilities").await.reply(Fixture::capabilities());
        f.call("areal/thread/observe").await.reply(Fixture::idle_thread(2));
        f.workspace_admission().await;
        f.call("areal/turn/start").await.disconnect();
        let (session, unresolved) = sending.await.unwrap();
        assert_eq!(unresolved.unwrap()["admissionState"], "unknown");
        f.reconnect().await;
        let next = f.request("session.send", json!({"threadId":"thread","expectedConfigRevision":2,"text":"blocked"}), Some(&uuid::Uuid::new_v4().to_string()));
        let sending = Fixture::dispatch(session, next);
        f.call("areal/capabilities").await.reply(Fixture::capabilities());
        f.call("areal/thread/observe").await.reply(Fixture::idle_thread(2));
        assert_eq!(sending.await.unwrap().1.unwrap_err().to_string(), "SUBMISSION_UNKNOWN");
        assert!(f.calls.try_recv().is_err());
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn rc07_approval_digest_mismatch_is_target_changed_before_journal_admission() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let mut f = Fixture::new().await;
            let (session, token) = f.review(f.session("a")).await;
            let before = f.host.journal.native_snapshot("project").unwrap();
            let mut request = f.answer(token, &uuid::Uuid::new_v4().to_string());
            request["params"]["argumentsDigest"] = json!("f".repeat(64));
            let answering = Fixture::dispatch(session, request);
            f.call("areal/interaction/list")
                .await
                .reply(json!({"data":[Fixture::item("pending")]}));
            assert_eq!(
                answering.await.unwrap().1.unwrap_err().to_string(),
                "TARGET_CHANGED"
            );
            assert_eq!(f.host.journal.native_snapshot("project").unwrap(), before);
            assert!(f.calls.try_recv().is_err());
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn rc07_questions_require_exact_keys_options_and_utf8_budget_before_admission() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let mut f = Fixture::new().await;
            let mut question = Fixture::item("pending");
            question["kind"] = json!("question");
            question["argumentsDigest"] = Value::Null;
            question["questions"] = json!([
                {"id":"choice","title":"Pick","options":["a","b"],"allowFreeText":false},
                {"id":"text","title":"Explain","options":[],"allowFreeText":true}
            ]);
            let reading = Fixture::dispatch(
                f.session("a"),
                f.request("attention.read", Fixture::target(), None),
            );
            f.call("areal/interaction/list")
                .await
                .reply(json!({"data":[question]}));
            let (mut session, detail) = reading.await.unwrap();
            let token = detail.unwrap()["reviewToken"].clone();
            let before = f.host.journal.native_snapshot("project").unwrap();
            for answers in [
                json!({"choice":"a"}),
                json!({"choice":"a","text":"ok","extra":"bad"}),
                json!({"choice":"other","text":"ok"}),
                json!({"choice":"a","text":"界".repeat(1365)+"ab"}),
            ] {
                let mut params = Fixture::target();
                params["answers"] = answers;
                params["reviewToken"] = token.clone();
                let request = f.request(
                    "interaction.respond",
                    params,
                    Some(&uuid::Uuid::new_v4().to_string()),
                );
                let mut answering = Fixture::dispatch(session, request);
                let completed = tokio::select! {
                    result = &mut answering => result.unwrap(),
                    call = f.calls.recv() => {
                        let call = call.unwrap();
                        assert_eq!(call.request["method"], "areal/interaction/list");
                        call.reply(json!({"data":[question]}));
                        tokio::select! {
                            result = &mut answering => result.unwrap(),
                            call = f.calls.recv() => {
                                let call = call.unwrap();
                                assert_eq!(call.request["method"], "areal/interaction/respond");
                                call.invalid("answers do not match the questions");
                                f.call("areal/interaction/list").await.reply(json!({"data":[question]}));
                                answering.await.unwrap()
                            }
                        }
                    }
                };
                session = completed.0;
                assert_eq!(completed.1.unwrap_err().to_string(), "INVALID_PARAMS");
                assert_eq!(f.host.journal.native_snapshot("project").unwrap(), before);
            }
            let answers = json!({"choice":"a","text":"界".repeat(1365)+"a"});
            assert_eq!(answers["text"].as_str().unwrap().len(), 4096);
            let mut params = Fixture::target();
            params["answers"] = answers.clone();
            params["reviewToken"] = token;
            let request = f.request(
                "interaction.respond",
                params,
                Some(&uuid::Uuid::new_v4().to_string()),
            );
            let answering = Fixture::dispatch(session, request);
            f.call("areal/interaction/list")
                .await
                .reply(json!({"data":[question]}));
            let call = f.call("areal/interaction/respond").await;
            assert_eq!(call.request["params"]["answers"], answers);
            assert!(call.request["params"].get("decision").is_none());
            assert!(call.request["params"].get("argumentsDigest").is_none());
            call.reply(json!({"answers":answers}));
            question["status"] = json!("answered");
            f.call("areal/interaction/list")
                .await
                .reply(json!({"data":[question]}));
            assert_eq!(
                answering.await.unwrap().1.unwrap()["admissionState"],
                "accepted"
            );
            assert!(f.calls.try_recv().is_err());
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn rc07_deny_preserves_atomic_target_without_read_budget_and_retains_core_invalid_params() {
    tokio::task::LocalSet::new().run_until(async {
        let mut f = Fixture::new().await;
        let mut oversized = Fixture::item("pending");
        oversized["effectiveArguments"]["text"] = json!("x".repeat(4 * 1024 * 1024));
        let reading = Fixture::dispatch(f.session("a"), f.request("attention.read", Fixture::target(), None));
        f.call("areal/interaction/list").await.reply(json!({"data":[oversized]}));
        let (mut session, unreadable) = reading.await.unwrap();
        assert_eq!(unreadable.unwrap_err().to_string(), "RESOURCE_UNAVAILABLE");
        for reason in [None, Some("approval requires the current digest and a supported decision"), Some("question requires answers only")] {
            let mut params = Fixture::target();
            params["decision"] = json!("deny");
            params["argumentsDigest"] = json!(ORIGINAL_DIGEST);
            let request = f.request("interaction.respond", params, Some(&uuid::Uuid::new_v4().to_string()));
            let answering = Fixture::dispatch(session, request);
            let call = f.call("areal/interaction/respond").await;
            assert_eq!(call.request["params"], json!({"threadId":"thread","turnId":"turn","requestId":"interaction","decision":"deny","argumentsDigest":ORIGINAL_DIGEST}));
            match reason {
                None => call.reply(json!({"decision":"deny","argumentsDigest":ORIGINAL_DIGEST})),
                Some(reason) => call.invalid(reason),
            }
            f.call("areal/interaction/list").await.reply(json!({"data":[oversized]}));
            let completed = answering.await.unwrap();
            session = completed.0;
            let result = completed.1.unwrap();
            assert_eq!(result["target"]["interactionId"], "interaction");
            assert_eq!(result["observedState"]["status"], "unavailable");
            match reason {
                None => assert_eq!(result["admissionState"], "accepted"),
                Some(_) => {
                    assert_eq!(result["admissionState"], "rejected");
                    assert_eq!(result["error"]["coreCode"], -32602);
                    assert_eq!(result["error"]["code"], "INVALID_PARAMS");
                }
            }
        }
        assert!(f.calls.try_recv().is_err());
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn rc07_missing_thread_is_target_changed_after_final_identity_checks() {
    tokio::task::LocalSet::new().run_until(async {
        for mode in ["missing", "revoked", "generation"] {
            let mut f = Fixture::new().await;
            let reading = Fixture::dispatch(f.session("a"), f.request("attention.read", Fixture::target(), None));
            let call = f.call("areal/interaction/list").await;
            if mode == "revoked" {
                f.grant("a", |grant| grant["status"] = json!("revoked"));
            }
            if mode == "generation" {
                f.host.slots.borrow_mut().get_mut("project").unwrap().service.as_mut().unwrap().identity.generation = "replacement".into();
            }
            call.responses.send(CoreResponse::Message(json!({"id":call.request["id"],"error":{"code":-32004,"message":"thread not found"}}))).unwrap();
            let expected = match mode {
                "revoked" => "GRANT_CHANGED",
                "generation" => "RESYNC_REQUIRED",
                _ => "TARGET_CHANGED",
            };
            assert_eq!(reading.await.unwrap().1.unwrap_err().to_string(), expected);
        }
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn rc07_stale_cursor_rejects_same_digest_body_change_and_replaced_core_generation() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for mode in ["body", "generation"] {
                let mut f = Fixture::new().await;
                let mut item = Fixture::item("pending");
                item["effectiveArguments"]["text"] = json!("x".repeat(40000));
                let reading = Fixture::dispatch(
                    f.session("a"),
                    f.request("attention.read", Fixture::target(), None),
                );
                f.call("areal/interaction/list")
                    .await
                    .reply(json!({"data":[item]}));
                let (session, page) = reading.await.unwrap();
                let page = page.unwrap();
                assert_eq!(page["complete"], false);
                assert_eq!(page["reviewToken"], Value::Null);
                assert!(page["nextCursor"].is_string());
                assert_eq!(page["argumentsDigest"], ORIGINAL_DIGEST);
                let connection = session.connection.clone();
                let core_identity = f
                    .host
                    .schedules
                    .connections
                    .shared_identity(&f.host, "project")
                    .unwrap();
                let journal = f.host.journal.native_snapshot("project").unwrap();
                if mode == "body" {
                    item["effectiveArguments"]["text"] =
                        json!("x".repeat(40000) + "changed without digest");
                    assert_eq!(item["argumentsDigest"], ORIGINAL_DIGEST);
                    assert_eq!(
                        f.host
                            .schedules
                            .connections
                            .shared_identity(&f.host, "project")
                            .unwrap(),
                        core_identity
                    );
                } else {
                    f.host
                        .slots
                        .borrow_mut()
                        .get_mut("project")
                        .unwrap()
                        .service
                        .as_mut()
                        .unwrap()
                        .identity
                        .generation = "replacement".into();
                    f.reconnect().await;
                    let replacement = f
                        .host
                        .schedules
                        .connections
                        .shared_identity(&f.host, "project")
                        .unwrap();
                    assert_eq!(replacement.0, core_identity.0);
                    assert_eq!(replacement.1, "replacement");
                    assert_ne!(replacement.2, core_identity.2);
                }
                let mut params = Fixture::target();
                params["cursor"] = page["nextCursor"].clone();
                let reading = Fixture::dispatch(session, f.request("attention.read", params, None));
                f.call("areal/interaction/list")
                    .await
                    .reply(json!({"data":[item]}));
                let (session, result) = reading.await.unwrap();
                assert_eq!(session.connection, connection);
                assert_eq!(result.unwrap_err().to_string(), "TARGET_CHANGED", "{mode}");
                assert_eq!(f.host.journal.native_snapshot("project").unwrap(), journal);
                assert!(f.calls.try_recv().is_err());
            }
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn conversation_view_negotiation_native_pages_and_selection_fencing() {
    tokio::task::LocalSet::new().run_until(async {
        let mut f = Fixture::new().await;
        let request = f.native_read_request("session.open", json!({"threadId":"thread","view":"conversation"}));
        let mut legacy = f.session("a");
        let legacy_description = legacy.describe(false);
        assert!(legacy_description.get("negotiatedCapabilities").is_none());
        assert_eq!(legacy_description["limits"]["nativeHistoryBytes"], json!(4 * 1024 * 1024));
        let legacy_request = f.request("session.open", json!({"threadId":"thread","view":"conversation"}), None);
        assert_eq!(legacy.request(&legacy_request).await.unwrap_err().to_string(), "INVALID_PARAMS");
        assert!(f.calls.try_recv().is_err());
        let mut session = f.session("a");
        session.gui_read = true;
        assert_eq!(session.describe(false)["negotiatedCapabilities"], json!(["gui-read-v1"]));
        let opening = Fixture::dispatch(session, request);
        f.call("areal/capabilities").await.reply(json!({"features":{"conversationObservation":true}}));
        let observe = f.call("areal/thread/observe").await;
        assert_eq!(observe.request["params"], json!({"threadId":"thread","mode":"conversation","maxBytes":131072}));
        let native = json!({"thread":{"id":"thread","archived":true,"desktop":{"configuration":{"model":{"id":"actual-model","contextWindow":100000}}},"turns":[{"id":"turn","sourceTurnId":"source-turn","items":[{"id":"deferred","sourceItemId":"original-item","type":"historyDeferred","cursor":"native-body","version":"native-version","preview":{"type":"dynamicToolCall","tool":"shell"}}]}]},"ownership":{"kind":"main"},"history":{"nextCursor":"native-next","complete":false},"window":{"source":"native-topology"}});
        let notifications = observe.responses.clone();
        let initial_revision = f.host.schedules.connections.shell_revision(&f.host, "project").unwrap();
        notifications.send(CoreResponse::Message(json!({"method":"item/agentMessage/delta","params":{"threadId":"thread","turnId":"turn","itemId":"answer","delta":"token"}}))).unwrap();
        observe.reply(native.clone());
        let (mut session, result) = opening.await.unwrap();
        let opened = result.unwrap();
        assert_eq!(opened["snapshot"], native);
        assert_eq!(opened["view"], "conversation");
        assert_eq!(opened["projectId"], "project");
        let prior = session.next_event().await.unwrap();
        assert!(session.event(prior).await.unwrap().is_none(), "pre-snapshot notifications must remain behind its barrier");
        assert_eq!(f.host.schedules.connections.shell_revision(&f.host, "project").unwrap(), initial_revision);
        notifications.send(CoreResponse::Message(json!({"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn"}}}))).unwrap();
        session.next_event().await.unwrap();
        assert_eq!(f.host.schedules.connections.shell_revision(&f.host, "project").unwrap().2, initial_revision.2 + 1);
        let subscription = opened["subscriptionId"].clone();
        let reading = Fixture::dispatch(session, f.native_read_request("session.history", json!({"threadId":"thread","subscriptionId":subscription,"view":"inherited","cursor":"native-next","maxBytes":4096})));
        let history = f.call("areal/conversation/history").await;
        assert_eq!(history.request["params"], json!({"threadId":"thread","view":"inherited","cursor":"native-next","maxBytes":4096}));
        let page = json!({"data":[{"sourceTurnId":"source-turn","sourceItemId":"original-item","fragment":{"text":"native fragment","offset":0,"totalBytes":15}}],"nextCursor":"native-more","complete":false});
        history.reply(page.clone());
        let (mut session, read) = reading.await.unwrap();
        assert_eq!(read.unwrap()["page"], page);
        let wrong = f.native_read_request("session.history", json!({"threadId":"thread","subscriptionId":"prior-selection","view":"own"}));
        assert_eq!(session.request(&wrong).await.unwrap_err().to_string(), "INVALID_PARAMS");
        assert!(f.calls.try_recv().is_err());
        let closed = session.request(&f.native_read_request("subscription.close", json!({"subscriptionId":subscription}))).await.unwrap();
        assert_eq!(closed, json!({"closed":true}));
        assert!(session.viewer.is_none());
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn conversation_open_discards_reply_after_grant_or_core_generation_changes() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for failure in ["grant", "generation"] {
                let mut f = Fixture::new().await;
                let mut session = f.session("a");
                session.gui_read = true;
                let opening = Fixture::dispatch(
                    session,
                    f.native_read_request(
                        "session.open",
                        json!({"threadId":"thread","view":"conversation"}),
                    ),
                );
                f.call("areal/capabilities")
                    .await
                    .reply(json!({"features":{"conversationObservation":true}}));
                let observe = f.call("areal/thread/observe").await;
                if failure == "grant" {
                    f.grant("a", |grant| grant["status"] = json!("revoked"));
                } else {
                    f.host
                        .slots
                        .borrow_mut()
                        .get_mut("project")
                        .unwrap()
                        .service
                        .as_mut()
                        .unwrap()
                        .identity
                        .generation = "replacement".into();
                }
                observe.reply(json!({"thread":{"id":"thread","turns":[]}}));
                let (session, result) = opening.await.unwrap();
                assert!(result.is_err(), "{failure}");
                assert!(session.viewer.is_none());
            }
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn gui_write_resolves_shared_project_identity_without_expanding_grants() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let mut f = Fixture::new().await;
            let command = uuid::Uuid::new_v4().to_string();
            let read = f.native_read_request("command.read", json!({"commandId":command}));
            let mut session = f.session("a");
            session.gui_read = true;
            assert_eq!(
                session.request(&read).await.unwrap_err().to_string(),
                "FORBIDDEN"
            );
            session.gui_write = true;
            assert_eq!(
                session.request(&read).await.unwrap()["admissionState"],
                "notFound"
            );
            for project in ["project".to_owned(), f.alias.clone()] {
                let mut models = f.request("project.models", json!({}), None);
                models["context"]["projectId"] = json!(project);
                let listing = Fixture::dispatch(session, models);
                f.call("areal/model/list")
                    .await
                    .reply(json!({"data":[{"providerId":"fixture","modelId":"model"}]}));
                f.call("areal/capabilities")
                    .await
                    .reply(json!({"methods":["areal/side/create","areal/side/close","areal/side/start"],
                        "features":{"permissionPresets":true,"sideExecutableV2":true,
                            "conversationDerivationV1":{"sideWorkspaceAccess":["readOnly"]}}}));
                let (next, result) = listing.await.unwrap();
                let result = result.unwrap();
                assert_eq!(result["models"][0]["modelId"], "model");
                let features = &result["features"];
                assert_eq!(features["permissionPresets"], true);
                assert_eq!(features["permissionFullAccess"], false);
                // 声明了方法和功能才显示入口：侧边聊天可建、可读工作区，缺 context/read 就没有预览。
                assert_eq!(features["sideExecutableV2"], true);
                assert_eq!(features["sideWorkspaceRead"], true);
                assert_eq!(features["sidePreview"], false);
                assert_eq!(features["processes"], false);
                assert!(serde_json::from_value::<
                    areal_protocol::host::RemoteProjectModelsResult,
                >(result.clone())
                .is_ok());
                session = next;
            }
            let mut send = f.request(
                "session.send",
                json!({"threadId":"thread","expectedConfigRevision":1,"text":"shared identity"}),
                Some(&command),
            );
            send["context"]["projectId"] = json!("project");
            let sending = Fixture::dispatch(session, send);
            f.call("areal/capabilities")
                .await
                .reply(Fixture::capabilities());
            f.call("areal/thread/observe")
                .await
                .reply(Fixture::idle_thread(1));
            f.workspace_admission().await;
            let turn = f.call("areal/turn/start").await;
            assert_eq!(
                turn.request["params"]["input"][0]["text"],
                "shared identity"
            );
            turn.reply(json!({"turn":{"id":"shared-turn"}}));
            let (mut session, sent) = sending.await.unwrap();
            assert_eq!(sent.unwrap()["admissionState"], "accepted");
            assert_eq!(
                session.request(&read).await.unwrap()["admissionState"],
                "accepted"
            );
            let alias_read = f.request("command.read", json!({"commandId":command}), None);
            assert_eq!(
                session.request(&alias_read).await.unwrap()["admissionState"],
                "accepted"
            );
            let mut unknown = read.clone();
            unknown["context"]["projectId"] = json!("unregistered-project");
            assert_eq!(
                session.request(&unknown).await.unwrap_err().to_string(),
                "FORBIDDEN"
            );
            // 桌面命令通道只给本机已批准写入的网页；手机和远程即使有 gui-write 也拒绝。
            let desktop = json!({"id":"desktop","method":"desktop.command","params":{"sourceId":"source","command":"list","request":{}}});
            assert_eq!(session.request(&desktop).await.unwrap_err().to_string(), "FORBIDDEN");
            let mut local = f.session("a");
            local.local = true;
            assert_eq!(local.request(&desktop).await.unwrap_err().to_string(), "FORBIDDEN");
            // 从没开过桌面、没有可恢复的后台时，说明原因而不是笼统拒绝。
            local.gui_write = true;
            let error = local.request(&desktop).await.unwrap_err();
            assert_eq!(
                error.downcast_ref::<crate::wire::Error>().map(|error| error.code),
                Some("CAPABILITY_UNAVAILABLE")
            );
            // 来源可省略（新装桌面登记来源前），由 Host 按当前后台认定，同样先要求后台在运行。
            let unsourced = json!({"id":"desktop","method":"desktop.command","params":{"command":"list","request":{}}});
            let error = local.request(&unsourced).await.unwrap_err();
            assert_eq!(
                error.downcast_ref::<crate::wire::Error>().map(|error| error.code),
                Some("CAPABILITY_UNAVAILABLE")
            );
            // 元数据图片是页面入口的合法操作，不能被参数校验挡在 Host。
            serde_json::from_value::<areal_protocol::host::WorkbenchPageCommandParams>(json!({"operation":"metadataImage","source":"https://example.invalid/icon.png","projectId":"project"})).unwrap();
            let unsourced = json!({"id":"providers","method":"providers.read","params":{"operation":"list"}});
            assert_eq!(local.request(&unsourced).await.unwrap_err().to_string(), "CAPABILITY_UNAVAILABLE");
            f.grant("a", |grant| grant["projectIds"] = json!([]));
            let mut denied = f.session("a");
            denied.gui_read = true;
            denied.gui_write = true;
            for request in [read, alias_read] {
                assert_eq!(
                    denied.request(&request).await.unwrap_err().to_string(),
                    "FORBIDDEN"
                );
            }
            assert!(f.calls.try_recv().is_err());
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn gui_write_negotiation_accepts_desktop_rich_input_only_for_declaring_clients() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let mut f = Fixture::new().await;
            let rich = json!({"threadId":"thread","expectedConfigRevision":1,"text":"look","conversationQuotes":[{"text":"quoted"}],"attachments":[{"type":"image","url":"areal://blob/img_1"},{"type":"file","url":"areal://blob/doc-2","name":"spec.pdf","mimeType":"application/pdf","_meta":{"source":"snap"}}],"mcpContent":[{"type":"text","text":"tool note"}]});
            let legacy = f.session("a");
            assert!(legacy.describe(false).get("writeLimits").is_none());
            let (legacy, result) = Fixture::dispatch(legacy, f.request("session.send", rich.clone(), Some(&uuid::Uuid::new_v4().to_string()))).await.unwrap();
            assert_eq!(result.unwrap_err().to_string(), "INVALID_PARAMS");
            let long = json!({"threadId":"thread","expectedConfigRevision":1,"text":"x".repeat(64 * 1024 + 1)});
            let (_, result) = Fixture::dispatch(legacy, f.request("session.send", long.clone(), Some(&uuid::Uuid::new_v4().to_string()))).await.unwrap();
            assert_eq!(result.unwrap_err().to_string(), "INVALID_PARAMS");
            assert!(f.calls.try_recv().is_err());
            let mut session = f.session("a");
            session.gui_read = true;
            session.gui_write = true;
            let description = session.describe(false);
            assert_eq!(description["negotiatedCapabilities"], json!(["gui-read-v1", "gui-write-v1"]));
            assert_eq!(description["writeLimits"], write_limits());
            let (session, result) = Fixture::dispatch(session, f.request("session.send", long, Some(&uuid::Uuid::new_v4().to_string()))).await.unwrap();
            assert_eq!(result.unwrap_err().to_string(), "INVALID_PARAMS");
            let mut crowded = rich.clone();
            crowded["attachments"] = json!(vec![json!({"type":"image","url":"areal://blob/a"}); 17]);
            let (session, result) = Fixture::dispatch(session, f.request("session.send", crowded, Some(&uuid::Uuid::new_v4().to_string()))).await.unwrap();
            assert_eq!(result.unwrap_err().to_string(), "INVALID_PARAMS");
            let mut foreign = rich.clone();
            foreign["attachments"] = json!([{"type":"image","url":"https://example.com/a.png"}]);
            let (session, result) = Fixture::dispatch(session, f.request("session.send", foreign, Some(&uuid::Uuid::new_v4().to_string()))).await.unwrap();
            assert_eq!(result.unwrap_err().to_string(), "INVALID_PARAMS");
            assert!(f.calls.try_recv().is_err());
            let sending = Fixture::dispatch(session, f.request("session.send", rich, Some(&uuid::Uuid::new_v4().to_string())));
            f.call("areal/capabilities").await.reply(Fixture::capabilities());
            f.call("areal/thread/observe").await.reply(Fixture::idle_thread(1));
            f.workspace_admission().await;
            let turn = f.call("areal/turn/start").await;
            let input = turn.request["params"]["input"].as_array().unwrap().clone();
            assert_eq!(input[0], json!({"type":"text","text":"look","text_elements":[]}));
            assert_eq!(input[1]["text"], "# userselect:\n```userselect\n[{\"text\":\"quoted\"}]\n```");
            assert_eq!(input[2], json!({"type":"image","url":"areal://blob/img_1","detail":null}));
            assert_eq!(input[3], json!({"type":"file","url":"areal://blob/doc-2","name":"spec.pdf","mime_type":"application/pdf"}));
            assert_eq!(input[4]["mcpContent"], json!({"type":"text","text":"tool note"}));
            assert_eq!(input[5]["mcpContent"]["type"], "resource_link");
            assert_eq!(input[5]["mcpContent"]["_meta"], json!({"source":"snap"}));
            assert_eq!(input.len(), 6);
            turn.reply(json!({"turn":{"id":"rich-turn"}}));
            assert_eq!(sending.await.unwrap().1.unwrap()["admissionState"], "accepted");
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn local_desktop_principal_sends_through_the_shared_journal_without_device_grants() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let mut f = Fixture::new().await;
            let session = Session::local(f.host.clone(), "local-connection".into()).unwrap();
            let generation = f.host.identity.generation.clone();
            let command = uuid::Uuid::new_v4().to_string();
            let mut send = f.request("session.send", json!({"threadId":"thread","expectedConfigRevision":1,"text":"from desktop"}), Some(&command));
            send["context"] = json!({"projectId":"project","gatewayGeneration":generation,"grantRevision":0,"serviceGeneration":"core-generation"});
            let mut alias = send.clone();
            alias["context"]["projectId"] = json!(f.alias);
            let (session, rejected) = Fixture::dispatch(session, alias).await.unwrap();
            assert_eq!(rejected.unwrap_err().to_string(), "FORBIDDEN");
            let sending = Fixture::dispatch(session, send);
            f.call("areal/capabilities").await.reply(Fixture::capabilities());
            f.call("areal/thread/observe").await.reply(Fixture::idle_thread(1));
            f.workspace_admission().await;
            let turn = f.call("areal/turn/start").await;
            assert_eq!(turn.request["params"]["input"][0]["text"], "from desktop");
            turn.reply(json!({"turn":{"id":"desktop-turn"}}));
            let (session, sent) = sending.await.unwrap();
            assert_eq!(sent.unwrap()["admissionState"], "accepted");
            let (_, snapshot) = f.host.journal.native_snapshot("project").unwrap();
            let record = snapshot["outcomes"].as_object().unwrap().values().chain(snapshot["pending"].as_array().unwrap()).find(|entry| entry["remote"]["commandId"] == command).unwrap().clone();
            assert_eq!(record["remote"]["devicePeerId"], LOCAL_PEER);
            assert_eq!(record["remote"]["projectId"], "project");
            let mut read = f.request("command.read", json!({"commandId":command}), None);
            read["context"]["projectId"] = json!("project");
            let remote = f.session("a");
            let (_, foreign) = Fixture::dispatch(remote, read.clone()).await.unwrap();
            assert!(foreign.is_err() || foreign.unwrap()["admissionState"] == "notFound");
            let (_, recovered) = Fixture::dispatch(session, read).await.unwrap();
            assert_eq!(recovered.unwrap()["turnId"], "desktop-turn");
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn local_send_and_steer_freeze_authoritative_gen_ui_context_without_private_state() {
    tokio::task::LocalSet::new().run_until(async {
        let mut f = Fixture::new().await;
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let runner = f.root.path().join("prepare.cjs");
        let source = r#"
const {createRequire} = require('node:module');
const {join} = require('node:path');
const fs = require('node:fs');
const {once} = require('node:events');
const appRequire = createRequire(join(REPO,'clients/gui/app/package.json'));
const {CoreBackend} = appRequire('@areal/workbench-service/desktop/core/backend.cjs');
const {DesktopService} = appRequire('@areal/workbench-service/desktop/core/service-protocol.cjs');
const {prepareInput} = require(join(REPO,'services/workbench/src/pages.cjs'));
const out = value => console.log(JSON.stringify({version:1,...value}));
(async () => {
  const home = process.env.AREAL_WORKBENCH_DATA;
  const backend = new CoreBackend({home,binary:'/bin/true'});
  const project = {id:PROJECT_ALIAS,root:PROJECT_ROOT,state:{threads:{thread:{id:'thread'}}}};
  project.model = {state:project.state};
  const socket = new (appRequire('ws'))(CORE_ENDPOINT,{headers:{Authorization:'Bearer original-owner-token'}});
  await once(socket,'open');
  let next = 0;
  const calls = new Map();
  socket.on('message', bytes => { const message = JSON.parse(bytes); const pending = calls.get(message.id);
    if (!pending) return; calls.delete(message.id);
    if (message.error) pending.reject(Object.assign(new Error(message.error.message),message.error));
    else pending.resolve(message.result);
  });
  project.client = {closed:false, request:(method,params) => new Promise((resolve,reject) => {
    const id = ++next; calls.set(id,{resolve,reject}); socket.send(JSON.stringify({id,method,params}));
  })};
  project.service = {serviceId:'original-service',generation:'core-generation'};
  backend.projects.set(project.id,project);
  backend.saved = [project];
  const adapter = new DesktopService(backend,'fixture');
  adapter.schedule = () => {};
  const scope = {...backend.genUiScope(project,'thread'),path:'/artifacts/widget.html'};
  const save = selection => backend.genUiState.set(scope,{modelContent:{selection},privateContent:{secret:'fixture-private'}});
  await save(7);
  let nextHost = 0;
  const hostCalls = new Map();
  const hostCall = (call, params) => new Promise((resolve,reject) => {
    const id = `journal-${++nextHost}`; hostCalls.set(id,{resolve,reject}); out({id,call,params});
  });
  backend.host.journal = id => ({
    read:async()=>hostCall('fixture.journal.read',{}),
    change:async change=>{ const {revision,snapshot}=await hostCall('fixture.journal.read',{});
      await hostCall('fixture.journal.replace',{revision,snapshot:change(snapshot)}); },
  });
  backend.start = async id => { if(id!==project.id)throw Error('wrong project');return project; };
  backend.resources.beforeCreate = async () => {};
  backend.providers.manages = () => false;
  backend.refreshAfterAdmission = async () => {};
  project.client.capabilities = {features:{permissionPresets:true}};
  out({event:'ready',methods:['input.prepare','execution.prepare','execution.dispatch','creation.read']});
  require('node:readline').createInterface({input:process.stdin}).on('line', async line => {
    const frame = JSON.parse(line);
    try {
      if (hostCalls.has(frame.id)) { const pending=hostCalls.get(frame.id);hostCalls.delete(frame.id);
        if(frame.error)pending.reject(Error(frame.error.code));else pending.resolve(frame.result);return; }
      if (frame.event === 'execution.cancel') { adapter.cancelHostExecution(frame.handle,frame.connection); return; }
      if (frame.event === 'pages.disconnect') { adapter.disconnectHostExecution(frame.connection); await hostCall('fixture.disconnected',{connection:frame.connection}); return; }
      if (frame.method === 'creation.read') { out({id:frame.id,result:backend.worktrees.readThreadCreation(frame.params.projectId,frame.params.request)}); return; }
      if (frame.method === 'execution.prepare') {
        out({id:frame.id,result:await adapter.prepareHostExecution(frame.params,frame.context.connection)}); return;
      }
      if (frame.method === 'execution.dispatch') {
        out({id:frame.id,result:await adapter.dispatchHostExecution(frame.params.handle,frame.context.connection)}); return;
      }
      if (frame.method !== 'input.prepare') throw Error('unexpected method');
      fs.appendFileSync(join(home,'preparations'),'once\n');
      const result = await prepareInput({desktop:{backend,adapter},request:frame.params});
      await save(8);
      out({id:frame.id,result});
    } catch(error) { out({id:frame.id,error:{code:'INVALID_PARAMS',message:error.message}}); }
  });
})().catch(error => { console.error(error); process.exit(1); });
"#.replace("REPO", &serde_json::to_string(&repo).unwrap())
          .replace("PROJECT_ALIAS", &serde_json::to_string(&f.alias).unwrap())
          .replace("PROJECT_ROOT", &serde_json::to_string(&f.host.slots.borrow()["project"].registration.workspace).unwrap())
          .replace("CORE_ENDPOINT", &serde_json::to_string(&f.host.slots.borrow()["project"].service.as_ref().unwrap().endpoint).unwrap());
        std::fs::write(&runner, source).unwrap();
        let runtime = std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|path| path.join("node")).find(|path| path.is_file()).expect("Node is required");
        let journal_host = f.host.clone();
        let (disconnected, mut disconnects) = mpsc::unbounded_channel();
        let reverse: crate::workbench::Reverse = Rc::new(move |method, params| {
            let host = journal_host.clone();
            let disconnected = disconnected.clone();
            Box::pin(async move {
                match method.as_str() {
                    "fixture.disconnected" => { disconnected.send(params["connection"].clone()).unwrap(); Ok(json!({})) }
                    "fixture.journal.read" => { let (revision, snapshot) = host.journal.native_snapshot("project")?; Ok(json!({"revision":revision,"snapshot":snapshot})) }
                    "fixture.journal.replace" => { host.journal.native_replace("project", params["revision"].as_u64().unwrap(), params["snapshot"].clone())?; Ok(json!({})) }
                    _ => anyhow::bail!("FORBIDDEN"),
                }
            })
        });
        let backend = crate::workbench::Workbench::start(&runtime, &runner, f.root.path(), reverse).await.unwrap();
        f.host.gateway.workbench.bind_test_backend(backend, &f.source);
        let session = Session::local(f.host.clone(), "local-connection".into()).unwrap();
        let context = json!({"projectId":"project","gatewayGeneration":f.host.identity.generation,"grantRevision":0,"serviceGeneration":"core-generation"});
        let mut send = f.request("session.send", json!({"threadId":"thread","expectedConfigRevision":1,"text":"Continue"}), Some(&uuid::Uuid::new_v4().to_string()));
        send["context"] = context.clone();
        let sending = Fixture::dispatch(session, send.clone());
        f.call("areal/capabilities").await.reply(Fixture::capabilities());
        f.call("areal/thread/observe").await.reply(Fixture::idle_thread(1));
        f.workspace_admission().await;
        let turn = f.call("areal/turn/start").await;
        let input = turn.request["params"]["input"][0]["text"].as_str().unwrap().to_owned();
        assert!(input.starts_with("Continue"));
        assert!(input.contains("\"selection\":7"), "{input}");
        assert!(!input.contains("private"));
        let (_, journal) = f.host.journal.native_snapshot("project").unwrap();
        assert!(journal.to_string().contains("selection"));
        assert!(!journal.to_string().contains("fixture-private"));
        turn.reply(json!({"turn":{"id":"desktop-turn"}}));
        let (session, accepted) = sending.await.unwrap();
        let accepted = accepted.unwrap();
        let (session, duplicate) = Fixture::dispatch(session, send).await.unwrap();
        assert_eq!(duplicate.unwrap(), accepted);
        assert_eq!(std::fs::read_to_string(f.root.path().join("preparations")).unwrap(), "once\n");
        let mut steer = f.request("session.control", json!({"threadId":"thread","operation":"steer","expectedRevision":1,"values":{"text":"Adjust","expectedTurnId":"turn","conversationQuotes":[{"text":"quoted-message"}],"attachments":[{"type":"image","url":"areal://blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],"mcpContent":[{"type":"text","text":"mcp-message"}]}}), Some(&uuid::Uuid::new_v4().to_string()));
        steer["context"] = context;
        let steering = Fixture::dispatch(session, steer.clone());
        let mut caps = Fixture::capabilities();
        caps["methods"].as_array_mut().unwrap().push(json!("turn/steer"));
        f.call("areal/capabilities").await.reply(caps.clone());
        f.call("areal/thread/observe").await.reply(json!({"thread":{"id":"thread","status":{"type":"active"},"turns":[{"id":"turn","status":"inProgress","items":[]}]},"ownership":{"kind":"ordinary"}}));
        f.workspace_admission().await;
        let turn = f.call("turn/steer").await;
        let text = turn.request["params"]["input"][0]["text"].as_str().unwrap();
        assert_eq!(turn.request["params"]["input"].as_array().unwrap().len(), 4);
        assert!(turn.request["params"]["input"].to_string().contains("quoted-message"));
        assert!(turn.request["params"]["input"].to_string().contains("mcp-message"));
        assert!(text.starts_with("Adjust"));
        assert!(text.contains("\"selection\":8"), "{text}");
        assert!(!text.contains("private"));
        turn.reply(json!({"turnId":"turn"}));
        let (session, result) = steering.await.unwrap();
        assert_eq!(result.unwrap()["admissionState"], "accepted");
        let (session, repeated) = Fixture::dispatch(session, steer.clone()).await.unwrap();
        assert_eq!(repeated.unwrap()["admissionState"], "accepted");
        assert_eq!(std::fs::read_to_string(f.root.path().join("preparations")).unwrap(), "once\nonce\n");
        let creation_id = uuid::Uuid::new_v4().to_string();
        let mut create = f.request("session.create", json!({"requestId":creation_id,"parameters":{"reasoningEffort":"high","serviceTier":"fast"},"options":{"permissionPreset":"ask"},"model":{"providerId":"provider","modelId":"model"},"worktree":{"mode":"source"}}), Some(&creation_id));
        create["context"] = steer["context"].clone();
        let mut creating = Fixture::dispatch(session, create.clone());
        let native_create = tokio::select! { call = f.call("areal/thread/start") => call, result = &mut creating => panic!("local create returned before dispatch: {:?}", result.unwrap().1) };
        assert_eq!(native_create.request["params"]["requestId"], creation_id);
        assert_eq!(native_create.request["params"]["parameters"]["serviceTier"], "fast");
        let (_, native_pending) = f.host.journal.native_snapshot("project").unwrap();
        assert!(native_pending["pending"].as_array().unwrap().iter().any(|entry| entry["method"] == "areal/thread/start" && entry["params"]["requestId"] == creation_id));
        assert!(!native_pending["pending"].as_array().unwrap().iter().any(|entry| entry["method"] == "workbench/thread/create"));
        native_create.reply(json!({"thread":{"id":"original-created"}}));
        let (session, created) = creating.await.unwrap();
        let created = created.unwrap();
        assert_eq!(created["admissionState"], "accepted");
        assert_eq!(created["threadId"], "original-created");
        assert_eq!(created["nativeRequestId"], creation_id);
        assert_eq!(created["receipt"]["result"]["executionProjectId"], "project");
        let (_, native_complete) = f.host.journal.native_snapshot("project").unwrap();
        assert_eq!(native_complete["outcomes"][&creation_id]["method"], "areal/thread/start");
        let (_, command_complete) = f.host.journal.native_snapshot(&session.creation_command_scope("project")).unwrap();
        assert_eq!(command_complete["outcomes"][&creation_id]["method"], "workbench/thread/create");
        let (session, duplicate) = Fixture::dispatch(session, create).await.unwrap();
        assert_eq!(duplicate.unwrap(), created);
        // 旧远程客户端仍用原请求形状，执行与模型上下文来自同源后台。
        let mut remote = f.session("a");
        assert!(remote.uses_workbench_execution());
        remote.source_id = "another-source".into();
        assert!(!remote.uses_workbench_execution());
        remote.source_id = f.source.clone();
        let remote_send = f.request("session.send", json!({"threadId":"thread","expectedConfigRevision":1,"text":"Remote continue"}), Some(&uuid::Uuid::new_v4().to_string()));
        let sending = Fixture::dispatch(remote, remote_send.clone());
        f.call("areal/capabilities").await.reply(Fixture::capabilities());
        f.call("areal/thread/observe").await.reply(Fixture::idle_thread(1));
        f.workspace_admission().await;
        let turn = f.call("areal/turn/start").await;
        let text = turn.request["params"]["input"][0]["text"].as_str().unwrap();
        assert!(text.starts_with("Remote continue") && text.contains("\"selection\":8"));
        assert!(!text.contains("fixture-private"));
        turn.reply(json!({"turn":{"id":"remote-turn"}}));
        let (remote, accepted) = sending.await.unwrap();
        let accepted = accepted.unwrap();
        let (remote, repeated) = Fixture::dispatch(remote, remote_send).await.unwrap();
        assert_eq!(repeated.unwrap(), accepted);
        let remote_connection = remote.connection.clone();
        let mut creating = Fixture::dispatch(remote, f.request("session.create", json!({}), Some(&uuid::Uuid::new_v4().to_string())));
        f.call("areal/capabilities").await.reply(json!({"features":{"threadStartAdmissionGuard":true,"permissionPresets":true,"threadCreationJournal":{"binding":{"identity":"store","journalEpoch":"epoch","coreInstanceId":"instance"}}},"methods":["areal/thread/start","areal/request/read"]}));
        let created = tokio::select! { call = f.call("areal/thread/start") => call, result = &mut creating => panic!("remote create returned before dispatch: {:?}", result.unwrap().1) };
        assert_eq!(created.request["params"]["options"]["permissionPreset"], "ask");
        created.reply(json!({"thread":{"id":"remote-created"}}));
        let (_, created) = creating.await.unwrap();
        assert_eq!(created.unwrap()["admissionState"], "accepted");
        drop(SessionSlot {host:f.host.clone(),peer:None,pending:false,connection:Some(remote_connection.clone())});
        assert_eq!(tokio::time::timeout(Duration::from_secs(5), disconnects.recv()).await.unwrap().unwrap(), remote_connection);
        f.host.gateway.workbench.stop_backend().await;
        steer["commandId"] = json!(uuid::Uuid::new_v4().to_string());
        let failing = Fixture::dispatch(session, steer);
        f.call("areal/capabilities").await.reply(caps);
        let (_, result) = failing.await.unwrap();
        assert_eq!(result.unwrap_err().to_string(), "CAPABILITY_UNAVAILABLE");
        assert!(f.calls.try_recv().is_err());
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn gui_write_uploads_attachments_in_chunks_and_replays_the_final_receipt() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    tokio::task::LocalSet::new()
        .run_until(async {
            let f = Fixture::new().await;
            let generation = f.host.identity.generation.clone();
            let upload = uuid::Uuid::new_v4().to_string();
            let bytes = b"%PDF-1.7\nhello attachment".to_vec();
            let chunk = |offset: usize, part: &[u8]| {
                let mut request = f.request("attachment.upload", json!({"threadId":"thread","uploadId":upload,"mimeType":"application/pdf","sizeBytes":bytes.len(),"offset":offset,"base64":base64::engine::general_purpose::STANDARD.encode(part)}), None);
                request["context"] = json!({"projectId":"project","gatewayGeneration":generation,"grantRevision":0,"serviceGeneration":"core-generation"});
                request
            };
            let (_, legacy) = Fixture::dispatch(f.session("a"), chunk(0, &bytes[..10])).await.unwrap();
            assert!(legacy.is_err());
            let session = Session::local(f.host.clone(), "local-connection".into()).unwrap();
            let (session, first) = Fixture::dispatch(session, chunk(0, &bytes[..10])).await.unwrap();
            assert_eq!(first.unwrap()["receivedBytes"], 10);
            let (session, again) = Fixture::dispatch(session, chunk(0, &bytes[..10])).await.unwrap();
            assert_eq!(again.unwrap()["receivedBytes"], 10);
            let (session, changed) = Fixture::dispatch(session, chunk(0, b"0123456789")).await.unwrap();
            assert_eq!(changed.unwrap_err().to_string(), "COMMAND_CONFLICT");
            let (session, gap) = Fixture::dispatch(session, chunk(12, &bytes[12..])).await.unwrap();
            assert_eq!(gap.unwrap_err().to_string(), "TARGET_CHANGED");
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            f.host.slots.borrow_mut().get_mut("project").unwrap().service.as_mut().unwrap().endpoint = format!("ws://{}/", listener.local_addr().unwrap());
            let uri = format!("areal://blob/{:x}", <sha2::Sha256 as sha2::Digest>::digest(&bytes));
            let core = async {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).await.unwrap();
                    head.push(byte[0]);
                }
                let head = String::from_utf8(head).unwrap().to_lowercase();
                assert!(head.starts_with("post /areal/blobs?threadid=thread "));
                assert!(head.contains("authorization: bearer original-owner-token\r\n"));
                assert!(head.contains("content-type: application/pdf\r\n"));
                let mut body = vec![0; bytes.len()];
                socket.read_exact(&mut body).await.unwrap();
                assert_eq!(body, bytes);
                let reply = json!({"uri":uri,"mimeType":"application/pdf","sizeBytes":bytes.len()}).to_string();
                socket.write_all(format!("HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{reply}", reply.len()).as_bytes()).await.unwrap();
            };
            let ((session, done), _) = tokio::join!(async { Fixture::dispatch(session, chunk(10, &bytes[10..])).await.unwrap() }, core);
            let done = done.unwrap();
            assert_eq!(done["attachment"]["uri"], uri);
            assert_eq!(done["attachment"]["sizeBytes"], bytes.len());
            // 末块回复丢失后重发：直接拿回同一份回执，不再访问 Core。
            let (_, replay) = Fixture::dispatch(session, chunk(10, &bytes[10..])).await.unwrap();
            assert_eq!(replay.unwrap(), done);
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn remembered_approvals_need_gui_write_and_core_permission() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let mut f = Fixture::new().await;
            let mut legacy = f.answer(json!("token"), &uuid::Uuid::new_v4().to_string());
            legacy["params"]["decision"] = json!("allowSession");
            let (_, rejected) = Fixture::dispatch(f.session("a"), legacy).await.unwrap();
            assert_eq!(rejected.unwrap_err().to_string(), "INVALID_PARAMS");
            let generation = f.host.identity.generation.clone();
            let mut session = Session::local(f.host.clone(), "local-connection".into()).unwrap();
            for remember in [false, true] {
                let mut item = Fixture::item("pending");
                item["effectivePermissions"] = json!({"rememberAllowed":remember});
                let mut read = f.request("attention.read", Fixture::target(), None);
                read["context"] = json!({"projectId":"project"});
                let reading = Fixture::dispatch(session, read);
                f.call("areal/interaction/list").await.reply(json!({"data":[item.clone()]}));
                let (next, detail) = reading.await.unwrap();
                let detail = detail.unwrap();
                let mut answer = f.answer(detail["reviewToken"].clone(), &uuid::Uuid::new_v4().to_string());
                answer["params"]["decision"] = json!("allowProject");
                answer["context"] = json!({"projectId":"project","gatewayGeneration":generation,"grantRevision":0,"serviceGeneration":"core-generation"});
                let answering = Fixture::dispatch(next, answer);
                f.call("areal/interaction/list").await.reply(json!({"data":[item]}));
                if remember {
                    let call = f.call("areal/interaction/respond").await;
                    assert_eq!(call.request["params"]["decision"], "allowProject");
                    call.reply(json!({"answered":true,"requestId":"interaction"}));
                    let mut answered = Fixture::item("answered");
                    answered["effectivePermissions"] = json!({"rememberAllowed":true});
                    f.call("areal/interaction/list").await.reply(json!({"data":[answered]}));
                }
                let (next, result) = answering.await.unwrap();
                if remember {
                    assert_eq!(result.unwrap()["admissionState"], "accepted");
                } else {
                    assert_eq!(result.unwrap_err().to_string(), "INVALID_PARAMS");
                }
                session = next;
            }
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn gui_write_create_carries_permission_preset_and_profile_only_for_declaring_clients() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let mut f = Fixture::new().await;
            let options = json!({"permissionPreset":"autoReview","agentProfile":{"id":"reviewer","revision":"r3"}});
            let legacy = f.request("session.create", options.clone(), Some(&uuid::Uuid::new_v4().to_string()));
            let (_, rejected) = Fixture::dispatch(f.session("a"), legacy).await.unwrap();
            assert_eq!(rejected.unwrap_err().to_string(), "INVALID_PARAMS");
            let generation = f.host.identity.generation.clone();
            let mut create = f.request("session.create", options, Some(&uuid::Uuid::new_v4().to_string()));
            create["context"] = json!({"projectId":"project","gatewayGeneration":generation,"grantRevision":0,"serviceGeneration":"core-generation"});
            let session = Session::local(f.host.clone(), "local-connection".into()).unwrap();
            let creating = Fixture::dispatch(session, create);
            f.call("areal/capabilities").await.reply(json!({"features":{"threadStartAdmissionGuard":true,"permissionPresets":true,"threadCreationJournal":{"binding":{"identity":"store","journalEpoch":"epoch","coreInstanceId":"instance"}}},"methods":["areal/thread/start","areal/request/read"]}));
            f.call("areal/profile/list").await.reply(json!({"data":[{"id":"reviewer","revision":"r3"}]}));
            let start = f.call("areal/thread/start").await;
            assert_eq!(start.request["params"]["options"]["permissionPreset"], "autoReview");
            assert_eq!(start.request["params"]["agentProfile"], json!({"id":"reviewer","revision":"r3"}));
            // 只核对交给 Core 的参数；回执语义由已有创建恢复测试覆盖。
            creating.abort();
            drop(start);
        })
        .await;
}

struct OwnerHeaders;
impl tokio_tungstenite::tungstenite::handshake::server::Callback for OwnerHeaders {
    fn on_request(
        self,
        request: &tokio_tungstenite::tungstenite::handshake::server::Request,
        response: tokio_tungstenite::tungstenite::handshake::server::Response,
    ) -> Result<
        tokio_tungstenite::tungstenite::handshake::server::Response,
        tokio_tungstenite::tungstenite::handshake::server::ErrorResponse,
    > {
        assert_eq!(
            request.headers()["authorization"],
            "Bearer original-owner-token"
        );
        Ok(response)
    }
}

#[tokio::test(flavor = "current_thread")]
async fn permission_boundary_rejects_submit_only_create_and_configure() {
    tokio::task::LocalSet::new().run_until(async {
        let mut f = Fixture::new().await;
        f.grant("a", |grant| grant["capabilities"] = json!(["observe", "submit"]));
        for options in [
            json!({"permissionPreset":"fullAccess"}),
            json!({"permissionPreset":"autoReview"}),
            json!({"preapprovedTools":["exec_command"]}),
        ] {
            for method in ["session.control", "session.create"] {
                let params = if method == "session.control" {
                    json!({"threadId":"thread","operation":"configure","expectedRevision":1,"values":{"options":options}})
                } else if options.get("preapprovedTools").is_some() {
                    json!({"options":options})
                } else { options.clone() };
                let request = f.request(method, params, Some(&uuid::Uuid::new_v4().to_string()));
                let mut session = f.session("a");
                session.gui_write = true;
                let (_, result) = Fixture::dispatch(session, request).await.unwrap();
                assert_eq!(result.unwrap_err().to_string(), "FORBIDDEN", "{method}: {options}");
                assert!(f.calls.try_recv().is_err());
            }
        }
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn project_list_boundary_preserves_local_visibility_and_remote_grants() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let f = Fixture::new().await;
            let request = json!({"id":"projects","method":"project.list","params":{}});
            let local = Session::local(f.host.clone(), "local-projects".into()).unwrap();
            let (_, result) = Fixture::dispatch(local, request.clone()).await.unwrap();
            let result = result.unwrap();
            assert_eq!(
                result["projects"].as_array().unwrap().len(),
                f.host.slots.borrow().len()
            );
            assert_eq!(result["projects"][0]["projectId"], "project");
            let (_, result) = Fixture::dispatch(f.session("a"), request.clone())
                .await
                .unwrap();
            assert_eq!(result.unwrap()["projects"][0]["projectId"], f.alias);
            f.grant("a", |grant| grant["projectIds"] = json!([]));
            let (_, result) = Fixture::dispatch(f.session("a"), request).await.unwrap();
            assert_eq!(result.unwrap()["projects"], json!([]));
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn configure_permission_boundary_requires_core_full_access_and_preserves_authorized_options()
{
    tokio::task::LocalSet::new().run_until(async {
        let mut f = Fixture::new().await;
        for (options, full_access) in [
            (json!({"permissionPreset":"fullAccess"}), false),
            (json!({"permissionPreset":"fullAccess"}), true),
            (json!({"permissionPreset":"autoReview"}), false),
            (json!({"preapprovedTools":["exec_command"]}), false),
            (json!({"permissionPreset":"ask","preapprovedTools":[]}), false),
        ] {
            let session = Session::local(f.host.clone(), "local-options".into()).unwrap();
            let mut request = f.request("session.control", json!({"threadId":"thread","operation":"configure","expectedRevision":1,"values":{"options":options}}), Some(&uuid::Uuid::new_v4().to_string()));
            request["context"] = json!({"projectId":"project","gatewayGeneration":f.host.identity.generation,"grantRevision":0,"serviceGeneration":"core-generation"});
            let configuring = Fixture::dispatch(session, request);
            let mut caps = Fixture::capabilities();
            caps["features"]["permissionPresets"] = json!(true);
            caps["features"]["permissionFullAccess"] = json!(full_access);
            f.call("areal/capabilities").await.reply(caps);
            if options["permissionPreset"] == "fullAccess" && !full_access {
                assert_eq!(configuring.await.unwrap().1.unwrap_err().to_string(), "CORE_INCOMPATIBLE");
                assert!(f.calls.try_recv().is_err());
                continue;
            }
            f.call("areal/thread/observe").await.reply(Fixture::idle_thread(1));
            f.call("areal/thread/inspect").await.reply(json!({"configuration":{"revision":1,"options":{}}}));
            let configure = f.call("areal/thread/configure").await;
            for (key, value) in options.as_object().unwrap() {
                assert_eq!(configure.request["params"]["options"][key], *value);
            }
            configure.reply(json!({"revision":2}));
            assert_eq!(configuring.await.unwrap().1.unwrap()["admissionState"], "accepted");
        }
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn submit_only_browser_cannot_bypass_approval_with_nested_creation_options() {
    use ring::signature::KeyPair;
    tokio::task::LocalSet::new().run_until(async {
        let f = Fixture::new().await;
        let random = ring::rand::SystemRandom::new();
        let algorithm = &ring::signature::ECDSA_P256_SHA256_FIXED_SIGNING;
        let pkcs8 = ring::signature::EcdsaKeyPair::generate_pkcs8(algorithm, &random).unwrap();
        let key = ring::signature::EcdsaKeyPair::from_pkcs8(algorithm, pkcs8.as_ref(), &random).unwrap();
        let device = uuid::Uuid::new_v4().to_string();
        storage::write(&f.host.home.join("host/browser-grants.json"), &json!({"version":1,"devices":[{
            "deviceId":device,"publicKey":base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key.public_key().as_ref()),"scopes":["observe","submit"]
        }]})).unwrap();
        let _listener = crate::server::loopback::bind(f.host.clone(), true).await.unwrap();
        for options in [
            json!({"permissionPreset":"autoReview"}),
            json!({"preapprovedTools":["exec_command"]}),
            json!({"permissionPreset":"fullAccess"}),
        ] {
            for method in ["session.create", "session.control"] {
                let params = if method == "session.create" { json!({"options":options}) }
                    else { json!({"threadId":"thread","operation":"configure","expectedRevision":1,"values":{"options":options}}) };
                let mut request = f.request(method, params, Some(&uuid::Uuid::new_v4().to_string()));
                request["context"] = json!({"projectId":"project","gatewayGeneration":f.host.identity.generation,"grantRevision":0,"serviceGeneration":"core-generation"});
                let session = Session::browser(f.host.clone(), "browser-options".into(), device.clone()).unwrap();
                assert!(session.authorize(Some("project"), "submit").is_ok());
                let (_, result) = Fixture::dispatch(session, request).await.unwrap();
                assert_eq!(result.unwrap_err().to_string(), "FORBIDDEN", "{method}: {options}");
            }
        }
        assert!(f.calls.is_empty());
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn remote_authorization_uses_committed_grants_during_credential_io_and_revokes_at_commit() {
    tokio::task::LocalSet::new().run_until(async {
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let gate = std::sync::Mutex::new(Some((entered_tx, release_rx)));
        let f = Fixture::with_write_hook(Some(std::sync::Arc::new(move || {
            if let Some((entered, release)) = gate.lock().unwrap().take() {
                let _ = entered.send(());
                release.recv().unwrap();
            }
        }))).await;
        let session = f.session("a");
        let snapshot = f.host.remote.snapshot(&f.host.migration).unwrap();
        let mut config = snapshot["config"].clone();
        config["deviceGrants"][0]["status"] = json!("revoked");
        config["deviceGrants"][0]["revision"] = json!(2);
        let projects = [f.alias.clone()];
        let mut writing = Box::pin(f.host.remote.dispatch_async("remote.gateway.replace", json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":f.host.identity.generation,"sourceId":f.source,"expectedRevision":snapshot["revision"],"config":config}), "fixture", &f.host.identity.generation, &f.host.migration, &projects));
        tokio::select! {
            result = entered_rx => result.unwrap(),
            result = &mut writing => panic!("replacement ended before barrier: {result:?}"),
        }
        let during = session.authorize(Some(&f.alias), "observe");
        release_tx.send(()).unwrap();
        let completed = writing.await.unwrap();
        let after = session.authorize(Some(&f.alias), "observe");
        assert!(during.is_ok(), "in-flight credentials rejected a committed grant: {during:?}");
        assert_eq!(completed["state"], "completed");
        assert!(after.is_err(), "revoked grant remained usable after durable commit");
    }).await;
}
