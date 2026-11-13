use super::*;
#[test]
fn task_rejection_is_definitive_on_loopback_wire() {
    let error: anyhow::Error = super::super::task_catalog::TaskRejection(
        json!({"code":-32009,"message":"private","data":{"outcome":{"kind":"rejected"}}}),
    )
    .into();
    assert_eq!(
        loopback_error(
            &json!({"method":"manage.command","commandId":"original"}),
            &error
        ),
        json!({"code":"TASK_REJECTED","message":"Core rejected task request","coreCode":-32009,"coreError":{"code":-32009,"message":"Core rejected task request","data":{"outcome":{"kind":"rejected"}}},"submissionUnknown":false,"commandId":"original"})
    );
}
use crate::{Client, HostIdentity};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::{
    rand::SystemRandom,
    signature::{self, KeyPair},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::{
    net::UnixListener,
    sync::{Mutex, Notify, watch},
};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

struct Fixture {
    _root: Rc<tempfile::TempDir>,
    host: Rc<Host>,
    tasks: JoinSet<()>,
}
impl Fixture {
    async fn start() -> Self {
        Self::start_in(Rc::new(tempfile::tempdir().unwrap())).await
    }
    async fn start_in(root: Rc<tempfile::TempDir>) -> Self {
        let home = root.path().canonicalize().unwrap().join("home");
        storage::private_dir(&home).unwrap();
        storage::private_dir(&home.join("host")).unwrap();
        storage::private_dir(&home.join("host/operations")).unwrap();
        let socket = storage::control_socket(&home.join("host")).unwrap();
        storage::private_dir(socket.parent().unwrap()).unwrap();
        if socket.exists() {
            std::fs::remove_file(&socket).unwrap();
        }
        let unix = UnixListener::bind(&socket).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).unwrap();
        let (changes, _) = watch::channel(0);
        let mut migration = crate::migration::Migration::new(&home).unwrap();
        migration.vault = crate::vault::Vault::isolated_files(&home);
        let host = Rc::new(Host {
            identity: HostIdentity {
                version: VERSION,
                host_id: storage::read_optional(&home.join("host/identity.json"))
                    .unwrap()
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                generation: uuid::Uuid::new_v4().to_string(),
                socket_path: socket,
                auth_file: home.join("host/auth.json"),
                pid: std::process::id(),
                executable_version: "fixture".into(),
            },
            bin: home.clone(),
            token: "isolated-auth-fixture".into(),
            slots: RefCell::new(BTreeMap::new()),
            stop: RefCell::new(None),
            host_stop_gate: Mutex::new(()),
            changes,
            exit: Notify::new(),
            migration: migration.into(),
            journal: crate::journal::Journal::new(&home).unwrap(),
            remote: crate::remote_state::RemoteState::new(&home),
            gateway: super::super::gateway_owner::Gateway::default(),
            subscriptions: super::super::subscriptions::Subscriptions::default(),
            schedules: super::super::schedules::Schedules::load(&home).unwrap(),
            power: super::super::power::Power::default(),
            read_models: Default::default(),
            loopback: Loopback::default(),
            home,
        });
        storage::write(
            &host.home.join("host/identity.json"),
            &host.identity.host_id,
        )
        .unwrap();
        storage::write(&host.identity.auth_file, &host.token).unwrap();
        storage::write(&host.home.join("host/host.json"), &host.identity).unwrap();
        let mut listener = bind(host.clone(), true).await.unwrap();
        let mut tasks = JoinSet::new();
        tasks.spawn_local(async move {
            listener.run().await.unwrap();
        });
        let owner = host.clone();
        tasks.spawn_local(async move {
            let mut connections = JoinSet::new();
            loop { tokio::select! {
                accepted = unix.accept() => { let (stream, _) = accepted.unwrap(); let host = owner.clone(); connections.spawn_local(async move { let _ = super::super::connection_loop(host, stream).await; }); }
                _ = connections.join_next(), if !connections.is_empty() => {}
            } }
        });
        Self {
            _root: root,
            host,
            tasks,
        }
    }
    async fn client(&self) -> Client {
        Client::connect_at(self.host.home.clone()).await.unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.tasks.abort_all();
    }
}

type ClientSocket = WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;
async fn connect(ticket: &LocalWebTicketResult, origin: &str) -> ClientSocket {
    let mut request = ticket.websocket_url.clone().into_client_request().unwrap();
    request
        .headers_mut()
        .insert("origin", origin.parse().unwrap());
    tokio_tungstenite::connect_async(request).await.unwrap().0
}
fn hello(ticket: &LocalWebTicketResult) -> Value {
    json!({"version":1,"id":"hello","method":"hello","params":{"protocolVersions":[1],"capabilities":[],"ticket":ticket.ticket,"expectedGeneration":ticket.generation}})
}
async fn write(socket: &mut ClientSocket, value: Value) {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}
async fn read(socket: &mut ClientSocket) -> Value {
    let message = tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    serde_json::from_str(message.to_text().unwrap()).unwrap()
}
async fn closed(socket: &mut ClientSocket) {
    let message = tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .unwrap();
    assert!(matches!(
        message,
        None | Some(Err(_)) | Some(Ok(Message::Close(_)))
    ));
}
async fn authenticate(ticket: &LocalWebTicketResult) -> ClientSocket {
    let mut socket = connect(ticket, &ticket.origin).await;
    write(&mut socket, hello(ticket)).await;
    assert_eq!(
        read(&mut socket).await["result"]["generation"],
        ticket.generation
    );
    socket
}

fn browser_key() -> signature::EcdsaKeyPair {
    let random = SystemRandom::new();
    let pkcs8 = signature::EcdsaKeyPair::generate_pkcs8(
        &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
        &random,
    )
    .unwrap();
    signature::EcdsaKeyPair::from_pkcs8(
        &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
        pkcs8.as_ref(),
        &random,
    )
    .unwrap()
}
fn browser_params(key: &signature::EcdsaKeyPair) -> Value {
    json!({"publicKey":URL_SAFE_NO_PAD.encode(key.public_key().as_ref())})
}
fn browser_proof(key: &signature::EcdsaKeyPair, challenge: &Value, origin: &str) -> Value {
    let message = format!(
        "{}\n{}\n{}",
        challenge["hostId"].as_str().unwrap(),
        challenge["nonce"].as_str().unwrap(),
        origin
    );
    let signature = key.sign(&SystemRandom::new(), message.as_bytes()).unwrap();
    json!({"publicKey":browser_params(key)["publicKey"],"nonce":challenge["nonce"],"signature":URL_SAFE_NO_PAD.encode(signature.as_ref())})
}
async fn browser_post(
    endpoint: &LoopbackEndpoint,
    origin: &str,
    path: &str,
    params: Value,
) -> (u16, Value) {
    let authority = endpoint.origin.strip_prefix("http://").unwrap();
    let mut stream = TcpStream::connect(authority).await.unwrap();
    let body = params.to_string();
    let request = format!(
        "POST /host/auth/{path} HTTP/1.1\r\nHost: {authority}\r\nOrigin: {origin}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut response))
        .await
        .unwrap()
        .unwrap();
    let text = std::str::from_utf8(&response).unwrap();
    let (headers, body) = text.split_once("\r\n\r\n").unwrap();
    let status = headers.split_whitespace().nth(1).unwrap().parse().unwrap();
    (status, serde_json::from_str(body).unwrap_or(Value::Null))
}
async fn approve_browser(fixture: &Fixture, key: &signature::EcdsaKeyPair) -> String {
    let endpoint = fixture.host.loopback.endpoint().unwrap();
    let (status, pending) = browser_post(
        &endpoint,
        &endpoint.origin,
        "challenge",
        browser_params(key),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(pending["state"], "pending");
    fixture
        .client()
        .await
        .approve_browser(pending["requestId"].as_str().unwrap())
        .await
        .unwrap()
        .device_id
}
async fn browser_ticket(fixture: &Fixture, key: &signature::EcdsaKeyPair) -> LocalWebTicketResult {
    let endpoint = fixture.host.loopback.endpoint().unwrap();
    let (status, challenge) = browser_post(
        &endpoint,
        &endpoint.origin,
        "challenge",
        browser_params(key),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(challenge["state"], "challenge");
    let (status, ticket) = browser_post(
        &endpoint,
        &endpoint.origin,
        "ticket",
        browser_proof(key, &challenge, &endpoint.origin),
    )
    .await;
    assert_eq!(status, 200);
    serde_json::from_value(ticket).unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn browser_revoke_invalidates_unused_tickets_active_connections_and_persisted_grants() {
    tokio::task::LocalSet::new().run_until(async {
        let mut fixture = Fixture::start().await;
        let key = browser_key();
        let device_id = approve_browser(&fixture, &key).await;
        let devices = serde_json::to_value(fixture.client().await.browser_devices().await.unwrap()).unwrap();
        assert_eq!(devices["devices"].as_array().unwrap().len(), 1);
        assert_eq!(devices["devices"][0]["deviceId"], device_id);
        assert_eq!(devices["devices"][0]["scopes"], json!(["observe"]));
        assert_eq!(devices["devices"][0]["fingerprint"], storage::digest(key.public_key().as_ref()));
        let unused = browser_ticket(&fixture, &key).await;
        let active = browser_ticket(&fixture, &key).await;
        let mut socket = authenticate(&active).await;
        write(&mut socket, json!({"version":1,"id":"devices","method":"web.devices","params":{}})).await;
        assert_eq!(read(&mut socket).await["error"]["code"], "methodNotFound");
        write(&mut socket, json!({"version":1,"id":"revoke","method":"web.revoke","params":{"deviceId":device_id,"expectedGeneration":active.generation}})).await;
        assert_eq!(read(&mut socket).await["error"]["code"], "methodNotFound");
        let receipt = fixture.client().await.revoke_browser(&device_id).await.unwrap();
        assert_eq!(receipt.device_id, device_id);
        assert!(receipt.revoked);
        closed(&mut socket).await;
        let mut unused_socket = connect(&unused, &unused.origin).await;
        write(&mut unused_socket, hello(&unused)).await;
        closed(&mut unused_socket).await;
        assert!(fixture.client().await.revoke_browser(&device_id).await.unwrap().revoked);
        assert!(fixture.client().await.browser_devices().await.unwrap().devices.is_empty());
        let root = fixture._root.clone();
        fixture.tasks.shutdown().await;
        drop(fixture);
        let restarted = Fixture::start_in(root).await;
        assert!(restarted.client().await.browser_devices().await.unwrap().devices.is_empty());
        let endpoint = restarted.host.loopback.endpoint().unwrap();
        let (status, pending) = browser_post(&endpoint, &endpoint.origin, "challenge", browser_params(&key)).await;
        assert_eq!(status, 200);
        assert_eq!(pending["state"], "pending");
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn ticket_is_single_use_and_origin_generation_and_expiry_bound() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let fixture = Fixture::start().await;
            let client = fixture.client().await;
            let ticket = client.web_ticket(ELECTRON_ORIGIN).await.unwrap();
            let own_origin = fixture
                .host
                .loopback
                .endpoint
                .borrow()
                .as_ref()
                .unwrap()
                .origin
                .clone();
            let mut wrong_origin = connect(&ticket, &own_origin).await;
            write(&mut wrong_origin, hello(&ticket)).await;
            closed(&mut wrong_origin).await;
            let mut wrong_generation = connect(&ticket, ELECTRON_ORIGIN).await;
            let mut input = hello(&ticket);
            input["params"]["expectedGeneration"] = json!("previous-generation");
            write(&mut wrong_generation, input).await;
            closed(&mut wrong_generation).await;
            let _first = authenticate(&ticket).await;
            let mut replay = connect(&ticket, ELECTRON_ORIGIN).await;
            write(&mut replay, hello(&ticket)).await;
            closed(&mut replay).await;
            let expired = client.web_ticket(ELECTRON_ORIGIN).await.unwrap();
            fixture
                .host
                .loopback
                .tickets
                .borrow_mut()
                .get_mut(&storage::digest(expired.ticket.as_bytes()))
                .unwrap()
                .deadline = Instant::now() - Duration::from_secs(1);
            let mut socket = connect(&expired, ELECTRON_ORIGIN).await;
            write(&mut socket, hello(&expired)).await;
            closed(&mut socket).await;
            let own_ticket = client.web_ticket(&own_origin).await.unwrap();
            let _own_socket = authenticate(&own_ticket).await;
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn upgrade_rejects_untrusted_origin_authority_query_and_large_headers() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let fixture = Fixture::start().await;
            let ticket = fixture
                .client()
                .await
                .web_ticket(ELECTRON_ORIGIN)
                .await
                .unwrap();
            for origin in [
                None,
                Some("null"),
                Some("https://untrusted.invalid"),
                Some("areal-ui://app.evil"),
            ] {
                let mut request = ticket.websocket_url.clone().into_client_request().unwrap();
                if let Some(origin) = origin {
                    request
                        .headers_mut()
                        .insert("origin", origin.parse().unwrap());
                }
                assert!(tokio_tungstenite::connect_async(request).await.is_err());
            }
            for field in ["host", "query", "duplicate-origin", "large-header"] {
                let url = if field == "query" {
                    format!("{}?unexpected=1", ticket.websocket_url)
                } else {
                    ticket.websocket_url.clone()
                };
                let mut request = url.into_client_request().unwrap();
                request
                    .headers_mut()
                    .insert("origin", ELECTRON_ORIGIN.parse().unwrap());
                match field {
                    "host" => {
                        request
                            .headers_mut()
                            .insert("host", "attacker.invalid".parse().unwrap());
                    }
                    "duplicate-origin" => {
                        request
                            .headers_mut()
                            .append("origin", ELECTRON_ORIGIN.parse().unwrap());
                    }
                    "large-header" => {
                        request
                            .headers_mut()
                            .insert("x-padding", "x".repeat(9000).parse().unwrap());
                    }
                    _ => {}
                }
                assert!(
                    tokio_tungstenite::connect_async(request).await.is_err(),
                    "{field}"
                );
            }
            let _valid = authenticate(&ticket).await;
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn unauthenticated_business_and_non_negotiated_methods_are_rejected() {
    tokio::task::LocalSet::new().run_until(async {
        let fixture = Fixture::start().await;
        let client = fixture.client().await;
        let ticket = client.web_ticket(ELECTRON_ORIGIN).await.unwrap();
        let mut socket = connect(&ticket, ELECTRON_ORIGIN).await;
        write(&mut socket, json!({"version":1,"id":"early","method":"host.status","params":{}})).await;
        closed(&mut socket).await;
        let mut socket = authenticate(&ticket).await;
        for method in ["web.ticket", "host.stop", "projects.list", "gui.attachSource"] {
            write(&mut socket, json!({"version":1,"id":"forbidden","method":method,"params":{}})).await;
            assert_eq!(read(&mut socket).await["error"]["code"], "methodNotFound");
        }
        write(&mut socket, json!({"version":1,"id":"invalid","method":"host.status","params":{"extra":true}})).await;
        assert_eq!(read(&mut socket).await["error"]["code"], "invalidRequest");
        write(&mut socket, json!({"version":1,"id":"status","method":"host.status","params":{}})).await;
        assert_eq!(read(&mut socket).await["result"]["hostId"], ticket.host_id);
        for frame in [
            json!({"version":1,"id":"early","method":"web.ticket","params":{"origin":ELECTRON_ORIGIN,"expectedGeneration":ticket.generation}}),
            json!({"version":1,"id":"hello","method":"hello","params":{"protocolVersions":[1],"capabilities":[],"authToken":"wrong"}}),
            json!({"version":1,"id":"hello","method":"hello","params":{"protocolVersions":[1],"capabilities":[],"authToken":fixture.host.token,"ticket":"unknown-field"}}),
        ] {
            let stream = tokio::net::UnixStream::connect(&fixture.host.identity.socket_path).await.unwrap();
            let mut stream = tokio::io::BufReader::new(stream);
            wire::write(stream.get_mut(), &frame).await.unwrap();
            assert!(tokio::time::timeout(Duration::from_secs(2), wire::read(&mut stream)).await.unwrap().unwrap().is_none());
        }
        assert_eq!(fixture.client().await.status().await.unwrap().host_id, ticket.host_id);
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn persisted_history_reads_stopped_project_without_activation_or_unknown_replay() {
    use fs2::FileExt;
    tokio::task::LocalSet::new().run_until(async {
        let fixture = Fixture::start().await;
        storage::private_dir(&fixture.host.home.join("host/projects")).unwrap();
        let client = fixture.client().await;
        let workspace = fixture.host.home.join("workspace");
        let data = fixture.host.home.join("persisted-data");
        for path in [&workspace, &data, &data.join("blobs")] { storage::private_dir(path).unwrap(); }
        let registration = crate::ProjectRegistration { project_id:"persisted".into(), workspace:workspace.clone(), data_dir:data.clone(), source:crate::ProjectSource::Cli, default_binding:false };
        client.register(&uuid::Uuid::new_v4().to_string(), registration.clone()).await.unwrap();
        let directory = storage::registry(&fixture.host.home, &Host::service_id(&registration)).unwrap(); storage::private_dir(&directory).unwrap();
        for path in [directory.join("start.lock"),data.join("service.lock"),data.join("owner.lock")] { storage::open_private(&path, true).unwrap(); }
        storage::write(&data.join("service-workspace"), &workspace).unwrap();
        let generation = uuid::Uuid::new_v4().to_string();
        let descriptor = json!({"protocolVersion":1,"serviceId":Host::service_id(&registration),"generation":generation,
            "workspace":workspace,"dataDir":data,"configFingerprint":"old", "owner":{"kind":"host","hostId":fixture.host.identity.host_id,"generation":uuid::Uuid::new_v4().to_string()},
            "endpoint":"http://127.0.0.1:1","webUrl":"http://127.0.0.1:1","authFile":directory.join("auth.json"),"logFile":directory.join("host.log"),"hostPid":500000000,"corePid":500000001,"state":"ready"});
        storage::write(&directory.join("service.json"), &descriptor).unwrap();
        let thread = uuid::Uuid::new_v4().to_string();
        let blob = b"synthetic persisted attachment";
        let digest = storage::digest(blob); let uri = format!("areal://blob/{digest}");
        std::fs::write(data.join("blobs").join(&digest), blob).unwrap();
        let record = json!({"version":17,"thread":{"id":thread,"sessionId":thread,"parentThreadId":null,"preview":"fixture","modelProvider":"fixture","createdAt":1,"updatedAt":2,"status":{"type":"active","activeFlags":[]},"cwd":workspace,"cliVersion":"fixture","source":"cli","ephemeral":false,"turns":[{"id":"turn","status":"inProgress","items":[{"type":"userMessage","id":"user","content":[{"type":"file","url":uri}]},{"type":"agentMessage","id":"answer","text":"synthetic pending text"}]}]}});
        storage::write(&data.join(format!("{thread}.json")), &record).unwrap();
        let request = uuid::Uuid::new_v4().to_string();
        let operation = super::super::Operation {digest:"fixed-original".into(),receipt:json!({"version":1,"requestId":request,"method":"project.ensure","projectId":"persisted","state":"admissionUnknown"}),evidence:Value::Null};
        storage::write(&wire::operation_path(&fixture.host.home, &request), &operation).unwrap();
        let original_operation = std::fs::read(wire::operation_path(&fixture.host.home, &request)).unwrap();
        let unnegotiated_ticket = client.web_ticket(ELECTRON_ORIGIN).await.unwrap();
        let mut unnegotiated = authenticate(&unnegotiated_ticket).await;
        write(&mut unnegotiated,json!({"version":1,"id":"denied","method":"session.openPersisted","context":{"projectId":"persisted"},"params":{"threadId":thread,"view":"conversation"}})).await;
        assert_eq!(read(&mut unnegotiated).await["error"]["code"],"methodNotFound");
        drop(unnegotiated);
        let ticket = client.web_ticket(ELECTRON_ORIGIN).await.unwrap(); let mut socket = connect(&ticket,ELECTRON_ORIGIN).await;
        write(&mut socket,json!({"version":1,"id":"hello","method":"hello","params":{"protocolVersions":[1],"capabilities":["gui-read-v1","persistedHistoryV1"],"ticket":ticket.ticket,"expectedGeneration":ticket.generation}})).await;
        let hello = read(&mut socket).await; assert!(hello["result"]["methods"].as_array().unwrap().iter().any(|method|method=="session.openPersisted"));
        let context = json!({"projectId":"persisted","serviceGeneration":generation});
        write(&mut socket,json!({"version":1,"id":"live","method":"session.open","context":context,"params":{"threadId":thread,"view":"conversation"}})).await;
        assert!(read(&mut socket).await.get("error").is_some());
        write(&mut socket,json!({"version":1,"id":"wrong-generation","method":"session.openPersisted","context":{"projectId":"persisted","serviceGeneration":"different"},"params":{"threadId":thread,"view":"conversation"}})).await;
        assert_eq!(read(&mut socket).await["error"]["code"],"PERSISTED_HISTORY_UNAVAILABLE");
        let held = storage::open_private(&data.join("owner.lock"), false).unwrap(); held.try_lock_exclusive().unwrap();
        write(&mut socket,json!({"version":1,"id":"held","method":"session.openPersisted","context":context,"params":{"threadId":thread,"view":"conversation"}})).await;
        assert_eq!(read(&mut socket).await["error"]["code"],"RESOURCE_BUSY"); drop(held);
        write(&mut socket,json!({"version":1,"id":"open","method":"session.openPersisted","context":context,"params":{"threadId":thread,"view":"conversation"}})).await;
        let reply = read(&mut socket).await; assert!(reply.get("error").is_none(),"{reply}"); let opened = &reply["result"];
        assert_eq!(opened["access"]["kind"],"persisted"); assert_eq!(opened["access"]["readOnly"],true);
        assert_eq!(opened["serviceGeneration"],generation); assert_eq!(opened["snapshot"]["thread"]["turns"][0]["status"],"inProgress");
        let subscription = opened["subscriptionId"].clone();
        write(&mut socket,json!({"version":1,"id":"media","method":"artifact.read","context":context,"params":{"view":"conversation","threadId":thread,"serviceGeneration":generation,"subscriptionId":subscription,"turnId":"turn","itemId":"user","uri":uri}})).await;
        assert_eq!(read(&mut socket).await["result"]["totalBytes"],blob.len());
        write(&mut socket,json!({"version":1,"id":"forged","method":"artifact.read","context":context,"params":{"view":"conversation","threadId":thread,"serviceGeneration":generation,"subscriptionId":subscription,"turnId":"turn","itemId":"wrong-item","uri":uri}})).await;
        assert_eq!(read(&mut socket).await["error"]["code"],"RESOURCE_UNAVAILABLE");
        write(&mut socket,json!({"version":1,"id":"page","method":"session.history","context":context,"params":{"threadId":thread,"subscriptionId":subscription,"view":"own","maxBytes":4096}})).await;
        assert!(read(&mut socket).await["result"]["page"].is_object());
        assert_eq!(storage::read::<Value>(&data.join(format!("{thread}.json"))).unwrap(),record);
        assert_eq!(std::fs::read(wire::operation_path(&fixture.host.home,&request)).unwrap(),original_operation);
        assert_eq!(storage::read::<Value>(&directory.join("service.json")).unwrap(),descriptor);
        assert!(!directory.join("cleanup.json").exists()); assert!(!directory.join("launch.json").exists());
        write(&mut socket,json!({"version":1,"id":"close","method":"subscription.close","context":context,"params":{"subscriptionId":subscription}})).await;
        assert_eq!(read(&mut socket).await["result"]["closed"],true);
        write(&mut socket,json!({"version":1,"id":"after-close","method":"session.history","context":context,"params":{"threadId":thread,"subscriptionId":subscription,"view":"own"}})).await;
        assert_eq!(read(&mut socket).await["error"]["code"],"RESYNC_REQUIRED");
        let mut readers = Vec::new();
        for index in 0..3 {
            let ticket = client.web_ticket(ELECTRON_ORIGIN).await.unwrap();
            let mut peer = connect(&ticket, ELECTRON_ORIGIN).await;
            write(&mut peer,json!({"version":1,"id":"hello","method":"hello","params":{"protocolVersions":[1],"capabilities":["gui-read-v1","persistedHistoryV1"],"ticket":ticket.ticket,"expectedGeneration":ticket.generation}})).await;
            assert!(read(&mut peer).await.get("result").is_some());
            write(&mut peer,json!({"version":1,"id":"open","method":"session.openPersisted","context":context,"params":{"threadId":thread,"view":"conversation"}})).await;
            let response = read(&mut peer).await;
            if index < 2 { assert_eq!(response["result"]["access"]["readOnly"],true); }
            else { assert_eq!(response["error"]["code"],"RESOURCE_BUSY"); }
            readers.push((peer,response["result"]["subscriptionId"].clone()));
        }
        let (first, first_subscription) = &mut readers[0];
        write(first,json!({"version":1,"id":"release","method":"subscription.close","context":context,"params":{"subscriptionId":first_subscription}})).await;
        assert_eq!(read(first).await["result"]["closed"],true);
        let (third, _) = &mut readers[2];
        write(third,json!({"version":1,"id":"retry","method":"session.openPersisted","context":context,"params":{"threadId":thread,"view":"conversation"}})).await;
        assert_eq!(read(third).await["result"]["access"]["readOnly"],true);
        fixture.host.slots.borrow_mut().get_mut("persisted").unwrap().registration.workspace = fixture.host.home.join("rebound-workspace");
        fixture.host.changed();
        assert_eq!(read(third).await["method"],"session.invalidated");
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn page_events_are_delivered_only_to_the_authenticated_connection() {
    tokio::task::LocalSet::new().run_until(async {
        let fixture = Fixture::start().await;
        let client = fixture.client().await;
        let mut sockets = Vec::new();
        for _ in 0..2 {
            let ticket = client.web_ticket(ELECTRON_ORIGIN).await.unwrap();
            let mut socket = connect(&ticket, ELECTRON_ORIGIN).await;
            write(&mut socket, json!({"version":1,"id":"hello","method":"hello","params":{
                "protocolVersions":[1],"capabilities":["gui-read-v1","gui-write-v1"],
                "ticket":ticket.ticket,"expectedGeneration":ticket.generation
            }})).await;
            let hello = read(&mut socket).await["result"].clone();
            sockets.push((socket, hello["connectionId"].clone()));
        }
        let (mut second, _) = sockets.pop().unwrap();
        let (mut first, owner) = sockets.pop().unwrap();
        super::super::workbench_route::reverse(&fixture.host)("pages.event".into(), json!({
            "connection":owner,"token":"page-token","notification":{"jsonrpc":"2.0","method":"ui/notifications/closed"}
        })).await.unwrap();
        let event = read(&mut first).await;
        assert_eq!(event["method"], "pages.event");
        assert_eq!(event["params"]["connectionId"], owner);
        write(&mut second, json!({"version":1,"id":"barrier","method":"host.status","params":{}})).await;
        assert_eq!(read(&mut second).await["id"], "barrier");
    }).await;
}

#[test]
fn loopback_errors_distinguish_reads_and_unknown_writes() {
    for method in [
        "providers.read",
        "analytics.import",
        "providers.command",
        "library.command",
    ] {
        let request = json!({"method":method,"commandId":"command"});
        let unknown = loopback_error(&request, &anyhow::anyhow!("connection lost after dispatch"));
        assert_eq!(
            unknown["submissionUnknown"],
            method != "providers.read",
            "{method}"
        );
        assert_eq!(unknown["commandId"].is_string(), method != "providers.read");
        for code in [
            "FORBIDDEN",
            "INVALID_PARAMS",
            "COMMAND_CONFLICT",
            "CAPABILITY_UNAVAILABLE",
            "LIMIT_EXCEEDED",
        ] {
            let rejected = loopback_error(&request, &anyhow::anyhow!("{code}"));
            assert_eq!(rejected["submissionUnknown"], false, "{method}: {code}");
            assert_eq!(rejected["code"], code);
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn lagged_page_events_keep_the_loopback_connection_alive() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let fixture = Fixture::start().await;
            let ticket = fixture
                .client()
                .await
                .web_ticket(ELECTRON_ORIGIN)
                .await
                .unwrap();
            let mut socket = connect(&ticket, ELECTRON_ORIGIN).await;
            write(
                &mut socket,
                json!({"version":1,"id":"hello","method":"hello","params":{
                    "protocolVersions":[1],"capabilities":["gui-read-v1","gui-write-v1"],
                    "ticket":ticket.ticket,"expectedGeneration":ticket.generation
                }}),
            )
            .await;
            let owner = read(&mut socket).await["result"]["connectionId"].clone();
            let reverse = super::super::workbench_route::reverse(&fixture.host);
            let mut witness = fixture.host.gateway.workbench.page_events();
            // 单线程内连续填满广播缓冲，不让 WebSocket 消费者运行，确定性触发 Lagged。
            for index in 0..96 {
                reverse(
                    "pages.event".into(),
                    json!({"connection":owner,"token":"burst","notification":{"index":index}}),
                )
                .await
                .unwrap();
            }
            assert!(matches!(
                witness.try_recv(),
                Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_))
            ));
            write(
                &mut socket,
                json!({"version":1,"id":"after-lag","method":"host.status","params":{}}),
            )
            .await;
            let mut events = 0;
            let mut replied = false;
            while events < 32 || !replied {
                let packet = read(&mut socket).await;
                if packet["id"] == "after-lag" {
                    assert!(packet["result"].is_object());
                    replied = true;
                } else {
                    assert_eq!(packet["method"], "pages.event");
                    assert_eq!(packet["params"]["connectionId"], owner);
                    events += 1;
                }
            }
            reverse(
                "pages.event".into(),
                json!({"connection":owner,"token":"after-lag","notification":{}}),
            )
            .await
            .unwrap();
            assert_eq!(read(&mut socket).await["params"]["token"], "after-lag");
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn only_desktop_tickets_negotiate_local_writes() {
    tokio::task::LocalSet::new().run_until(async {
        let fixture = Fixture::start().await;
        let client = fixture.client().await;
        let ticket = client.web_ticket(ELECTRON_ORIGIN).await.unwrap();
        let mut socket = connect(&ticket, ELECTRON_ORIGIN).await;
        write(&mut socket, json!({"version":1,"id":"hello","method":"hello","params":{"protocolVersions":[1],"capabilities":["gui-read-v1","gui-write-v1"],"ticket":ticket.ticket,"expectedGeneration":ticket.generation}})).await;
        let hello = read(&mut socket).await["result"].clone();
        assert_eq!(hello["negotiatedCapabilities"], json!(["gui-read-v1", "gui-write-v1"]));
        assert_eq!(hello["writeMethods"], json!(WRITE_METHODS));
        assert_eq!(hello["writeLimits"], super::super::gateway_owner::write_limits());
        write(&mut socket, json!({"version":1,"id":"read","method":"command.read","params":{"commandId":uuid::Uuid::new_v4().to_string()},"context":{"projectId":"missing"}})).await;
        assert_eq!(read(&mut socket).await["error"]["code"], "FORBIDDEN");
        write(&mut socket, json!({"version":1,"id":"x".repeat(65),"method":"command.read","params":{}})).await;
        closed(&mut socket).await;

        let key = browser_key();
        approve_browser(&fixture, &key).await;
        let browser = browser_ticket(&fixture, &key).await;
        let endpoint = fixture.host.loopback.endpoint().unwrap();
        let mut socket = connect(&browser, &endpoint.origin).await;
        write(&mut socket, json!({"version":1,"id":"hello","method":"hello","params":{"protocolVersions":[1],"capabilities":["gui-read-v1","gui-write-v1"],"ticket":browser.ticket,"expectedGeneration":browser.generation}})).await;
        let hello = read(&mut socket).await["result"].clone();
        assert_eq!(hello["negotiatedCapabilities"], json!(["gui-read-v1"]));
        assert!(hello.get("writeMethods").is_none() && hello.get("writeLimits").is_none());
        write(&mut socket, json!({"version":1,"id":"send","method":"session.send","params":{},"context":{"projectId":"p"},"commandId":uuid::Uuid::new_v4().to_string()})).await;
        assert_eq!(read(&mut socket).await["error"]["code"], "methodNotFound");
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn browser_write_scopes_are_explicit_enforced_and_revocable() {
    tokio::task::LocalSet::new().run_until(async {
        let fixture = Fixture::start().await;
        let endpoint = fixture.host.loopback.endpoint().unwrap();
        for scope in ["submit", "approve", "manage"] {
            let key = browser_key();
            let (_, pending) = browser_post(&endpoint, &endpoint.origin, "challenge", browser_params(&key)).await;
            // 授权仍通过本机认证控制通道；网页不能给自己增加范围。
            let grant = fixture.client().await.approve_browser_with_scopes(pending["requestId"].as_str().unwrap(), &["observe", scope]).await.unwrap();
            let ticket = browser_ticket(&fixture, &key).await;
            let mut socket = connect(&ticket, &endpoint.origin).await;
            write(&mut socket, json!({"version":1,"id":"hello","method":"hello","params":{"protocolVersions":[1],"capabilities":["gui-read-v1","gui-write-v1"],"ticket":ticket.ticket,"expectedGeneration":ticket.generation}})).await;
            let hello = read(&mut socket).await["result"].clone();
            assert_eq!(hello["scopes"], json!(["observe", scope]));
            let methods = hello["writeMethods"].as_array().unwrap();
            assert_eq!(methods.contains(&json!("library.command")), scope == "manage");
            for method in ["worktree.read", "tasks.read", "trajectory.read", "trajectory.command", "feedback.read", "feedback.command", "manage.read", "manage.command", "providers.read", "providers.command"] {
                assert_eq!(methods.contains(&json!(method)), scope == "manage");
            }
            assert_eq!(methods.contains(&json!("session.send")), scope == "submit");
            assert_eq!(methods.contains(&json!("interaction.respond")), scope == "approve");
            write(&mut socket, json!({"version":1,"id":"write","method":"library.command","params":{"sourceId":"fixture","operation":"createSection","title":"fixture"},"commandId":uuid::Uuid::new_v4().to_string()})).await;
            let error = read(&mut socket).await["error"].clone();
            assert_eq!(error["code"], if scope == "manage" { "CAPABILITY_UNAVAILABLE" } else { "FORBIDDEN" });
            assert_eq!(error["submissionUnknown"], false);
            for operation in ["open", "request"] {
                write(&mut socket, json!({"version":1,"id":"page","method":"pages.command","params":{"operation":operation}})).await;
                assert_eq!(read(&mut socket).await["error"]["code"], "FORBIDDEN");
            }
            fixture.client().await.revoke_browser(&grant.device_id).await.unwrap();
            write(&mut socket, json!({"version":1,"id":"revoked","method":"host.status","params":{}})).await;
            closed(&mut socket).await;
        }
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn public_page_proxy_is_static_and_sandboxed_without_exposing_resources() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let fixture = Fixture::start().await;
            let endpoint = fixture.host.loopback.endpoint().unwrap();
            let authority = endpoint.origin.strip_prefix("http://").unwrap();
            for path in [
                "/host/pages/proxy",
                "/host/pages/private-page/view",
                "/host/pages/proxy?token=private",
            ] {
                let mut stream = TcpStream::connect(authority).await.unwrap();
                stream
                    .write_all(
                        format!(
                            "GET {path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\r\n"
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                let mut bytes = Vec::new();
                tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut bytes))
                    .await
                    .unwrap()
                    .unwrap();
                let text = std::str::from_utf8(&bytes).unwrap();
                let (headers, body) = text.split_once("\r\n\r\n").unwrap();
                if path == "/host/pages/proxy" {
                    assert!(headers.starts_with("HTTP/1.1 200"));
                    assert!(headers.contains("sandbox allow-scripts"));
                    assert!(!headers.contains("allow-same-origin"));
                    assert_eq!(body, include_str!("page_proxy.html"));
                    assert!(!body.contains("areal-ui://"));
                } else {
                    assert!(!headers.starts_with("HTTP/1.1 200"));
                    assert!(!body.contains("private"));
                }
            }
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn tickets_frames_and_connections_have_bounded_capacity() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let fixture = Fixture::start().await;
            let client = fixture.client().await;
            let ticket = client.web_ticket(ELECTRON_ORIGIN).await.unwrap();
            for _ in 1..MAX_TICKETS {
                client.web_ticket(ELECTRON_ORIGIN).await.unwrap();
            }
            assert!(
                client
                    .web_ticket(ELECTRON_ORIGIN)
                    .await
                    .unwrap_err()
                    .to_string()
                    .contains("resourceLimit")
            );
            let mut socket = authenticate(&ticket).await;
            let next = client.web_ticket(ELECTRON_ORIGIN).await.unwrap();
            let _ = socket
                .send(Message::Text(" ".repeat(wire::MAX_FRAME + 1).into()))
                .await;
            closed(&mut socket).await;
            let mut connections = Vec::new();
            for _ in 0..MAX_CONNECTIONS {
                connections.push(connect(&next, ELECTRON_ORIGIN).await);
            }
            let mut request = next.websocket_url.clone().into_client_request().unwrap();
            request
                .headers_mut()
                .insert("origin", ELECTRON_ORIGIN.parse().unwrap());
            assert!(
                tokio::time::timeout(
                    Duration::from_secs(2),
                    tokio_tungstenite::connect_async(request)
                )
                .await
                .unwrap()
                .is_err()
            );
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn restart_preserves_browser_origin_and_port_collision_rejects_old_origin_credentials() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let mut fixture = Fixture::start().await;
            let client = fixture.client().await;
            let key = browser_key();
            let device_id = approve_browser(&fixture, &key).await;
            let original_endpoint = fixture.host.loopback.endpoint().unwrap();
            let unused = client.web_ticket(ELECTRON_ORIGIN).await.unwrap();
            let active = client.web_ticket(ELECTRON_ORIGIN).await.unwrap();
            let mut socket = authenticate(&active).await;
            let root = fixture._root.clone();
            let path = fixture.host.home.join("host/endpoint.json");
            fixture.tasks.shutdown().await;
            assert!(!path.exists());
            closed(&mut socket).await;
            drop(fixture);
            let mut restarted = Fixture::start_in(root).await;
            let endpoint = restarted.host.loopback.endpoint().unwrap();
            assert_eq!(endpoint.origin, original_endpoint.origin);
            assert_eq!(
                restarted
                    .client()
                    .await
                    .browser_devices()
                    .await
                    .unwrap()
                    .devices[0]
                    .device_id,
                device_id
            );
            let browser = browser_ticket(&restarted, &key).await;
            let mut browser_socket = authenticate(&browser).await;
            let fresh = restarted
                .client()
                .await
                .web_ticket(ELECTRON_ORIGIN)
                .await
                .unwrap();
            assert_eq!(fresh.host_id, unused.host_id);
            assert_ne!(fresh.generation, unused.generation);
            let mut socket = connect(&fresh, ELECTRON_ORIGIN).await;
            let mut old = hello(&unused);
            old["params"]["expectedGeneration"] = json!(fresh.generation);
            write(&mut socket, old).await;
            closed(&mut socket).await;
            let _valid = authenticate(&fresh).await;
            let (status, challenge) = browser_post(
                &endpoint,
                &endpoint.origin,
                "challenge",
                browser_params(&key),
            )
            .await;
            assert_eq!(status, 200);
            let old_proof = browser_proof(&key, &challenge, &endpoint.origin);
            let unused_browser = browser_ticket(&restarted, &key).await;
            let root = restarted._root.clone();
            restarted.tasks.shutdown().await;
            closed(&mut browser_socket).await;
            drop(restarted);
            let blocker = TcpListener::bind(endpoint.origin.strip_prefix("http://").unwrap())
                .await
                .unwrap();
            let moved = Fixture::start_in(root).await;
            let moved_endpoint = moved.host.loopback.endpoint().unwrap();
            assert_ne!(moved_endpoint.origin, endpoint.origin);
            assert_eq!(moved_endpoint.host_id, endpoint.host_id);
            assert_ne!(moved_endpoint.generation, endpoint.generation);
            let mut old_origin_request = moved_endpoint
                .websocket_url
                .clone()
                .into_client_request()
                .unwrap();
            old_origin_request
                .headers_mut()
                .insert("origin", endpoint.origin.parse().unwrap());
            assert!(
                tokio_tungstenite::connect_async(old_origin_request)
                    .await
                    .is_err()
            );
            let (status, error) =
                browser_post(&moved_endpoint, &moved_endpoint.origin, "ticket", old_proof).await;
            assert_eq!(status, 403);
            assert_eq!(error, json!({"error":"authentication failed"}));
            let mut stale = unused_browser.clone();
            stale.origin = moved_endpoint.origin.clone();
            stale.websocket_url = moved_endpoint.websocket_url.clone();
            stale.generation = moved_endpoint.generation.clone();
            let mut stale_socket = connect(&stale, &stale.origin).await;
            write(&mut stale_socket, hello(&stale)).await;
            closed(&mut stale_socket).await;
            let new_ticket = browser_ticket(&moved, &key).await;
            let _new_socket = authenticate(&new_ticket).await;
            assert_eq!(
                moved
                    .client()
                    .await
                    .browser_devices()
                    .await
                    .unwrap()
                    .devices[0]
                    .device_id,
                device_id
            );
            drop(blocker);
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn authenticated_unix_ticket_connects_to_real_loopback_status() {
    tokio::task::LocalSet::new().run_until(async {
        let fixture = Fixture::start().await;
        let client = fixture.client().await;
        let ticket = client.web_ticket(ELECTRON_ORIGIN).await.unwrap();
        let endpoint: LoopbackEndpoint = storage::read(&fixture.host.home.join("host/endpoint.json")).unwrap();
        assert_eq!(endpoint.websocket_url, ticket.websocket_url);
        assert_eq!(endpoint.generation, client.identity().generation);
        let mut request = ticket.websocket_url.clone().into_client_request().unwrap();
        request.headers_mut().insert("origin", ELECTRON_ORIGIN.parse().unwrap());
        let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        socket.send(Message::Text(json!({"version":1,"id":"hello","method":"hello","params":{"protocolVersions":[1],"capabilities":[],"ticket":ticket.ticket,"expectedGeneration":ticket.generation}}).to_string().into())).await.unwrap();
        let hello: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(hello["result"]["hostId"], client.identity().host_id);
        assert_eq!(hello["result"]["methods"], json!(["host.status"]));
        socket.send(Message::Text(json!({"version":1,"id":"status","method":"host.status","params":{}}).to_string().into())).await.unwrap();
        let response: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(response["result"], serde_json::to_value(client.status().await.unwrap()).unwrap());
        let typed: areal_protocol::host::LocalHostStatusResult = serde_json::from_value(response["result"].clone()).unwrap();
        assert_eq!(serde_json::to_value(typed).unwrap(), response["result"]);
    }).await;
}
