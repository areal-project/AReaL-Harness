use super::*;
#[tokio::test]
async fn oversized_response_keeps_connection_and_original_command_recoverable() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = WebSocketStream::from_raw_socket(stream, Role::Server, None).await;
        let large = json!({"version":1,"id":"large","result":{
            "commandId":"original","data":"x".repeat(wire::MAX_FRAME)}});
        send(&mut socket, &large).await.unwrap();
        send(
            &mut socket,
            &json!({"version":1,"id":"next","result":{"ok":true}}),
        )
        .await
        .unwrap();
    });
    let stream = tokio::net::TcpStream::connect(address).await.unwrap();
    let mut socket = WebSocketStream::from_raw_socket(stream, Role::Client, None).await;
    let first = socket.next().await.unwrap().unwrap();
    let first: Value = serde_json::from_str(first.to_text().unwrap()).unwrap();
    assert_eq!(first["id"], "large");
    assert_eq!(first["error"]["code"], "LIMIT_EXCEEDED");
    assert_eq!(first["error"]["commandId"], "original");
    assert_eq!(first["error"]["submissionUnknown"], true);
    let next = socket.next().await.unwrap().unwrap();
    let next: Value = serde_json::from_str(next.to_text().unwrap()).unwrap();
    assert_eq!(next["result"]["ok"], true);
    server.await.unwrap();
}

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
                executable_digest: None,
            },
            bin: home.clone(),
            token: "isolated-auth-fixture".into(),
            slots: RefCell::new(BTreeMap::new()),
            stop: RefCell::new(None),
            host_stop_gate: Mutex::new(()),
            clients: Default::default(),
            changes,
            exit: Notify::new(),
            migration: migration.into(),
            journal: crate::journal::Journal::new(&home).unwrap(),
            remote: crate::remote_state::RemoteState::new(&home),
            gateway: super::super::gateway_owner::Gateway::default(),
            subscriptions: super::super::subscriptions::Subscriptions::default(),
            schedules: super::super::schedules::Schedules::load(&home).unwrap(),
            bots: super::super::bots::Bots::load(&home).unwrap(),
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
        for index in 0..7 {
            let ticket = client.web_ticket(ELECTRON_ORIGIN).await.unwrap();
            let mut peer = connect(&ticket, ELECTRON_ORIGIN).await;
            write(&mut peer,json!({"version":1,"id":"hello","method":"hello","params":{"protocolVersions":[1],"capabilities":["gui-read-v1","persistedHistoryV1"],"ticket":ticket.ticket,"expectedGeneration":ticket.generation}})).await;
            assert!(read(&mut peer).await.get("result").is_some());
            write(&mut peer,json!({"version":1,"id":"open","method":"session.openPersisted","context":context,"params":{"threadId":thread,"view":"conversation"}})).await;
            let response = read(&mut peer).await;
            if index < 6 { assert_eq!(response["result"]["access"]["readOnly"],true); }
            else { assert_eq!(response["error"]["code"],"RESOURCE_BUSY"); }
            readers.push((peer,response["result"]["subscriptionId"].clone()));
        }
        let (first, first_subscription) = &mut readers[0];
        write(first,json!({"version":1,"id":"release","method":"subscription.close","context":context,"params":{"subscriptionId":first_subscription}})).await;
        assert_eq!(read(first).await["result"]["closed"],true);
        let (seventh, _) = &mut readers[6];
        write(seventh,json!({"version":1,"id":"retry","method":"session.openPersisted","context":context,"params":{"threadId":thread,"view":"conversation"}})).await;
        assert_eq!(read(seventh).await["result"]["access"]["readOnly"],true);
        fixture.host.slots.borrow_mut().get_mut("persisted").unwrap().registration.workspace = fixture.host.home.join("rebound-workspace");
        fixture.host.changed();
        assert_eq!(read(seventh).await["method"],"session.invalidated");
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
async fn shell_subscription_keeps_inflight_catalog_query_running() {
    tokio::task::LocalSet::new().run_until(async {
        let fixture = Fixture::start().await;
        fixture.host.gateway.workbench.test_source("host");
        storage::private_dir(&fixture.host.home.join("host/projects")).unwrap();
        let workspace = fixture.host.home.join("workspace");
        let data = fixture.host.home.join("data");
        for path in [&workspace, &data] { storage::private_dir(path).unwrap(); }
        fixture.client().await.register(&uuid::Uuid::new_v4().to_string(), crate::ProjectRegistration {
            project_id: "project".into(), workspace, data_dir: data,
            source: crate::ProjectSource::Cli, default_binding: false,
        }).await.unwrap();
        let ticket = fixture.client().await.web_ticket(ELECTRON_ORIGIN).await.unwrap();
        let mut socket = connect(&ticket, ELECTRON_ORIGIN).await;
        write(&mut socket, json!({"version":1,"id":"hello","method":"hello","params":{
            "protocolVersions":[1],"capabilities":["gui-read-v1","gui-write-v1"],
            "ticket":ticket.ticket,"expectedGeneration":ticket.generation
        }})).await;
        read(&mut socket).await;
        let gate = fixture.host.gate("project").unwrap();
        let changing = gate.write().await;
        write(&mut socket, json!({"version":1,"id":"catalog","method":"tasks.read","params":{"sourceId":"host","operation":"list"}})).await;
        // 目录查询已拿到共享读模型锁，正在等待项目状态；此时订阅也需要读模型。
        let entered = tokio::time::timeout(Duration::from_secs(1), fixture.host.read_models.read_started.notified()).await;
        assert!(entered.is_ok(), "catalog did not enter shared read model");
        write(&mut socket, json!({"version":1,"id":"shell","method":"shell.subscribe","params":{}})).await;
        tokio::time::timeout(Duration::from_secs(1), fixture.host.read_models.read_started.notified()).await.unwrap();
        drop(changing);
        let mut responses = BTreeMap::new();
        for _ in 0..2 {
            let response = read(&mut socket).await;
            responses.insert(response["id"].as_str().unwrap().to_owned(), response);
        }
        assert!(responses["catalog"].get("error").is_none(), "{responses:?}");
        assert_eq!(responses["shell"]["result"]["snapshot"]["projects"][0]["projectId"], "project");
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn pending_workbench_requests_do_not_block_queries() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for blocked_method in ["manage.read", "desktop.command"] {
                let fixture = Fixture::start().await;
                let entered = Rc::new(Notify::new());
                let released = Rc::new(Notify::new());
                let mock_core_server: Option<tokio::task::JoinHandle<()>>;
                let mock_control_server: Option<tokio::task::JoinHandle<()>>;
                let mock_core_close: Option<Box<dyn Fn()>>;
                let mock_service_lock: Option<std::fs::File>;
                let creation_id = uuid::Uuid::new_v4().to_string();
                let slow_params;
                {
                    let base = fixture.host.home.parent().unwrap().canonicalize().unwrap();
                    let profile = base.join("profile");
                    let core_home = base.join("data");
                    let legacy = base.join("legacy");
                    let workspace = base.join("project");
                    let data_dir = base.join("project-data");
                    for dir in [&profile, &core_home, &workspace, &data_dir] {
                        storage::private_dir(dir).unwrap();
                    }
                    let src = crate::migration::Source {
                        profile: profile.clone(),
                        core_home: core_home.clone(),
                        legacy_service_home: legacy,
                    };
                    fixture.host.migration.attach(src.clone(), "fixture", None).unwrap();
                    let imported = fixture
                        .host
                        .migration
                        .import(
                            serde_json::from_value(json!({
                                "requestId": uuid::Uuid::new_v4().to_string(),
                                "expectedGeneration": fixture.host.identity.generation,
                                "source": src,
                            }))
                            .unwrap(),
                            "fixture",
                            &[],
                            &fixture.host.journal,
                        )
                        .unwrap();
                    assert_eq!(imported["kind"], "ready");
                    let source_id = fixture
                        .host
                        .migration
                        .navigation_source_id(&profile)
                        .unwrap()
                        .unwrap();
                    let alias = "fedcba9876543210fedcba98";
                    let registration = crate::ProjectRegistration {
                        project_id: "project".into(),
                        workspace: workspace.clone(),
                        data_dir,
                        source: crate::ProjectSource::Gui {
                            profile: profile.clone(),
                            legacy_project_id: alias.into(),
                        },
                        default_binding: false,
                    };
                    storage::write(
                        &core_home.join("projects.json"),
                        &json!([{ "id": alias, "root": workspace }]),
                    )
                    .unwrap();
                    storage::private_dir(&core_home.join("worktree-requests")).unwrap();
                    storage::write(
                        &core_home.join("worktree-requests").join(format!("{creation_id}.json")),
                        &json!({"kind":"checkout","requestId":creation_id,"projectId":alias,
                            "parameters":{},"state":"created","intent":"continue","events":[]}),
                    ).unwrap();
                    std::fs::write(fixture.host.bin.join("areal"), "").unwrap();
                    super::super::workbench_route::frontend_options(&fixture.host, &source_id,
                        json!({"binary":fixture.host.bin.join("areal"),"home":core_home,"guiProfile":profile,"hostHome":fixture.host.home,"userHome":base}), None).unwrap();
                    fixture.host.journal.initialize("project", json!({"version":1,"pending":[],"outcomes":{"original":{"method":"areal/turn/start","accepted":true,"threadId":"thread","turnId":"original-turn"}}})).unwrap();

                    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                    let service_id =
                        storage::digest(registration.data_dir.as_os_str().as_encoded_bytes())[..24]
                            .to_owned();
                    let service = areal_protocol::service::Service {
                        identity: areal_protocol::service::Identity {
                            protocol_version: 1,
                            service_id: service_id.clone(),
                            generation: "gen-1".into(),
                            workspace: registration.workspace.clone(),
                            data_dir: registration.data_dir.clone(),
                            config_fingerprint: "fixture".into(),
                        },
                        owner: Some(fixture.host.owner()),
                        endpoint: format!("ws://{}/", listener.local_addr().unwrap()),
                        web_url: String::new(),
                        auth_file: fixture.host.home.join("core-auth.json"),
                        log_file: fixture.host.home.join("core.log"),
                        host_pid: 1,
                        core_pid: 2,
                        state: areal_protocol::service::State::Ready,
                    };
                    storage::write(
                        &service.auth_file,
                        &json!({"principals":[{"id":"desktop-owner","token":"fixture"}]}),
                    )
                    .unwrap();
                    let service_dir = storage::registry(&fixture.host.home, &service_id).unwrap();
                    storage::private_dir(&service_dir).unwrap();
                    storage::write(&service_dir.join("service.json"), &service).unwrap();
                    let service_lock =
                        storage::open_private(&registration.data_dir.join("service.lock"), true)
                            .unwrap();
                    fs2::FileExt::try_lock_exclusive(&service_lock).unwrap();
                    mock_service_lock = Some(service_lock);

                    let control_path = storage::control_socket(&service_dir).unwrap();
                    storage::private_dir(control_path.parent().unwrap()).unwrap();
                    let control_listener = tokio::net::UnixListener::bind(&control_path).unwrap();
                    let control_service = service.clone();
                    mock_control_server = Some(tokio::task::spawn_local(async move {
                        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
                        while let Ok((stream, _)) = control_listener.accept().await {
                            let (read_half, mut write_half) = stream.into_split();
                            let mut line = String::new();
                            if BufReader::new(read_half).read_line(&mut line).await.unwrap_or(0) > 0 {
                                let mut reply = serde_json::to_vec(
                                    &areal_protocol::service::Response::Ok {
                                        service: Box::new(control_service.clone()),
                                    },
                                )
                                .unwrap();
                                reply.push(b'\n');
                                let _ = write_half.write_all(&reply).await;
                                let _ = write_half.flush().await;
                            }
                        }
                    }));

                    let mut slot = super::super::Slot::imported(registration);
                    slot.service = Some(service.clone());
                    slot.state = "ready".into();
                    let (writer, lifetime) = areal_local_service::OwnerLifetime::pair().unwrap();
                    slot.writer = Some(writer);
                    slot.lifetime = Some(Rc::new(lifetime));
                    fixture.host.slots.borrow_mut().insert("project".into(), slot);

                    let entered_cb = entered.clone();
                    let released_cb = released.clone();
                    let probe_identity = service.identity.clone();
                    let blocked = Rc::new(std::cell::Cell::new(false));
                    let server = tokio::task::spawn_local(async move {
                        use futures_util::{SinkExt, StreamExt};
                        use tokio::io::{AsyncReadExt, AsyncWriteExt};
                        use tokio_tungstenite::tungstenite::Message;
                        while let Ok((mut stream, _)) = listener.accept().await {
                            let mut peek = [0u8; 16];
                            let n = stream.peek(&mut peek).await.unwrap_or(0);
                            if peek[..n].starts_with(b"GET /areal/") {
                                let mut buf = [0u8; 4096];
                                let mut total = 0usize;
                                while total < buf.len() {
                                    let read = stream.read(&mut buf[total..]).await.unwrap_or(0);
                                    if read == 0 {
                                        break;
                                    }
                                    total += read;
                                    if buf[..total].windows(4).any(|w| w == b"\r\n\r\n") {
                                        break;
                                    }
                                }
                                let body = serde_json::to_vec(&probe_identity).unwrap();
                                let header = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                    body.len()
                                );
                                let _ = stream.write_all(header.as_bytes()).await;
                                let _ = stream.write_all(&body).await;
                                let _ = stream.flush().await;
                                continue;
                            }
                            let entered_cb = entered_cb.clone();
                            let released_cb = released_cb.clone();
                            let blocked = blocked.clone();
                            tokio::task::spawn_local(async move {
                                let socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                                let (writer, mut reader) = socket.split();
                                let writer = Rc::new(tokio::sync::Mutex::new(writer));
                                while let Some(Ok(Message::Text(text))) = reader.next().await {
                                    let call: Value = serde_json::from_str(&text).unwrap();
                                    if call.get("id").is_none() {
                                        continue;
                                    }
                                    let hold = call["method"] == "areal/server/status" && !blocked.replace(true);
                                    if hold { entered_cb.notify_one(); }
                                    let result = match call["method"].as_str().unwrap() {
                                        "initialize" => json!({}),
                                        "areal/task/list" | "areal/plugin/mcp/list" => json!({ "data": [], "nextCursor": null }),
                                        "areal/capabilities" => json!({"methods":["areal/thread/prediction","areal/thread/inspect","areal/context/read","areal/plugin/mcp/list"]}),
                                        "areal/thread/prediction" => json!({"threadId":"thread","sourceTurnId":"turn","text":"suggestion"}),
                                        "areal/thread/inspect" => json!({"threadId":"thread","configuration":{"revision":1}}),
                                        "areal/context/read" => json!({"threadId":"thread","items":[]}),
                                        "areal/server/status" => {
                                            json!({
                                                "acceptingWork": true,
                                                "activeGoals": [],
                                                "activeTasks": 0,
                                                "activeTurns": [],
                                                "apiVersion": "areal.core.v1",
                                                "capacity": {
                                                    "activeTurns": 0,
                                                    "blobBytes": 0,
                                                    "historyBytesPerThread": 0,
                                                    "maxActiveTurns": 4,
                                                    "maxThreads": 8,
                                                    "threads": 0
                                                },
                                                "closed": false,
                                                "compactions": [],
                                                "configuration": Value::Null,
                                                "draining": false,
                                                "idleForMs": 0,
                                                "lifecycle": {
                                                    "admission": "open",
                                                    "executionOutcomes": { "uninspectedUnknown": 0 },
                                                    "ifIdle": { "allowed": true, "reasons": [] },
                                                    "settled": { "allowed": true, "reasons": [] },
                                                    "version": 1
                                                },
                                                "pendingQueueItems": 0,
                                                "queues": [],
                                                "productVersion": "fixture",
                                                "resources": [],
                                                "restartSafe": true,
                                                "runtime": Value::Null,
                                                "stateVersion": 1,
                                                "unresolvedTools": [],
                                                "workgroups": []
                                            })
                                        }
                                        other => panic!("unexpected mock core method: {other}"),
                                    };
                                    let writer = writer.clone();
                                    let released = released_cb.clone();
                                    tokio::task::spawn_local(async move {
                                    if hold { released.notified().await; }
                                    writer.lock().await
                                        .send(Message::Text(
                                            json!({ "jsonrpc": "2.0", "id": call["id"], "result": result })
                                                .to_string()
                                                .into(),
                                        ))
                                        .await
                                        .unwrap();
                                    });
                                }
                            });
                        }
                    });
                    mock_core_server = Some(server);
                    mock_core_close = Some(
                        fixture
                            .host
                            .schedules
                            .connections
                            .connect_test_core(fixture.host.clone(), "project", service)
                            .await
                            .unwrap(),
                    );
                    slow_params = if blocked_method == "manage.read" {
                        json!({"sourceId": source_id, "projectId": alias, "operation": "server"})
                    } else {
                        json!({"sourceId": source_id, "command":"manage", "request":{"projectId":alias,"operation":"server"}})
                    };
                }
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
                let _hello = read(&mut socket).await;
                write(
                    &mut socket,
                    json!({"version":1,"id":"slow","method":blocked_method,
            "params":slow_params}),
                )
                .await;
                tokio::time::timeout(Duration::from_secs(2), entered.notified())
                    .await
                    .unwrap();
                if blocked_method == "desktop.command" {
                    write(
                        &mut socket,
                        json!({"version":1,"id":"second","method":"desktop.command",
                "params":slow_params}),
                    )
                    .await;
                }
                // 确认目标请求已进入后台且尚未释放，再检查同连接的安全读取不被阻塞。
                write(
                    &mut socket,
                    json!({"version":1,"id":"fast","method":"host.status","params":{}}),
                )
                .await;
                write(
                    &mut socket,
                    json!({"version":1,"id":"catalog","method":"analytics.read","params":{}}),
                )
                .await;
                if blocked_method == "desktop.command" {
                    write(&mut socket, json!({"version":1,"id":"cancel","method":"worktree.command",
                        "commandId":uuid::Uuid::new_v4().to_string(),
                        "params":{"sourceId":slow_params["sourceId"],"projectId":slow_params["request"]["projectId"],
                            "operation":"worktreeCancel","requestId":uuid::Uuid::new_v4().to_string(),"worktreeRequestId":creation_id}
                    })).await;
                }
                let progress = tokio::time::timeout(Duration::from_secs(1), async {
                    let mut status = false;
                    let mut catalog = false;
                    let mut cancelled = blocked_method != "desktop.command";
                    while !status || !catalog || !cancelled {
                        let packet = read(&mut socket).await;
                        assert_ne!(packet["id"], "slow");
                        assert_ne!(
                            packet["id"], "second",
                            "mutations must preserve connection order"
                        );
                        status |=
                            packet["id"] == "fast" && packet["result"]["hostId"] == ticket.host_id;
                        catalog |=
                            packet["id"] == "catalog" && packet["result"]["tokens"] == 0;
                        if packet["id"] == "cancel" {
                            assert_eq!(packet["result"]["receipt"]["requestId"], creation_id, "{packet}");
                            assert_eq!(packet["result"]["receipt"]["state"], "cancelled", "{packet}");
                            cancelled = true;
                        }
                    }
                })
                .await;
                if progress.is_ok() && blocked_method == "desktop.command" {
                    for index in 0..15 {
                        write(&mut socket, json!({"version":1,"id":format!("capacity-{index}"),
                            "method":"desktop.command","params":slow_params})).await;
                    }
                    let rejected = read(&mut socket).await;
                    assert_eq!(rejected["id"], "capacity-14");
                    assert_eq!(rejected["error"]["code"], "CAPACITY_EXCEEDED");
                    // 详情要能定位哪一队满了；上屏文案不读这些字段。
                    assert_eq!(rejected["error"]["method"], "desktop.command");
                    assert_eq!(rejected["error"]["reason"], "commandQueueFull");
                    write(&mut socket, json!({"version":1,"id":"recovery-read","method":"analytics.read","params":{}})).await;
                    let safe = tokio::time::timeout(Duration::from_secs(1), read(&mut socket)).await.unwrap();
                    assert_eq!(safe["id"], "recovery-read");
                    assert_eq!(safe["result"]["tokens"], 0, "full mutation admission must preserve independent reads");
                    write(&mut socket, json!({"version":1,"id":"original-status",
                        "method":"desktop.command","params":{"command":"reconcile",
                        "request":{"projectId":slow_params["request"]["projectId"],"requestId":"original"}}})).await;
                    let receipt = tokio::time::timeout(Duration::from_secs(1), read(&mut socket)).await.unwrap();
                    assert_eq!(receipt["id"], "original-status");
                    assert!(receipt.get("error").is_none(), "full mutation admission must preserve original receipt recovery: {receipt}");
                    assert_eq!(receipt["result"]["outcomes"]["original"]["turnId"], "original-turn");
                    write(&mut socket, json!({"version":1,"id":"prediction-read",
                        "method":"desktop.command","params":{"command":"prediction",
                        "request":{"projectId":slow_params["request"]["projectId"],"threadId":"thread","sourceTurnId":"turn","operation":"request"}}})).await;
                    let prediction = tokio::time::timeout(Duration::from_secs(1), read(&mut socket)).await.unwrap();
                    assert_eq!(prediction["id"], "prediction-read");
                    assert!(prediction.get("error").is_none(), "prediction must use bounded query admission: {prediction}");
                    write(&mut socket, json!({"version":1,"id":"inspect-read",
                        "method":"desktop.command","params":{"command":"manage",
                        "request":{"projectId":slow_params["request"]["projectId"],"threadId":"thread","operation":"inspect"}}})).await;
                    let inspect = tokio::time::timeout(Duration::from_secs(1), read(&mut socket)).await.unwrap();
                    assert_eq!(inspect["id"], "inspect-read");
                    assert!(inspect.get("error").is_none(), "manage inspect must use bounded query admission: {inspect}");
                    for (command, operation) in [("manage", "context"), ("workspace", "info"), ("resources", "skills")] {
                        let mut request = json!({"projectId":slow_params["request"]["projectId"],"operation":operation});
                        if command == "manage" { request["threadId"] = json!("thread"); }
                        if command == "resources" { request["scope"] = json!("project"); }
                        write(&mut socket, json!({"version":1,"id":operation,"method":"desktop.command",
                            "params":{"command":command,"request":request}})).await;
                        let reply = tokio::time::timeout(Duration::from_secs(1), read(&mut socket)).await.unwrap();
                        assert_eq!(reply["id"], operation);
                        assert!(reply.get("error").is_none(), "reopening a chat must not consume mutation slots for {command}/{operation}: {reply}");
                    }
                    write(&mut socket, json!({"version":1,"id":"mcp-read","method":"manage.read",
                        "params":{"sourceId":slow_params["sourceId"],"projectId":slow_params["request"]["projectId"],"operation":"pluginMcp"}})).await;
                    let mcp = tokio::time::timeout(Duration::from_secs(1), read(&mut socket)).await.unwrap();
                    assert_eq!(mcp["id"], "mcp-read");
                    assert_eq!(mcp["result"]["data"], json!([]), "MCP reads retain independent query admission: {mcp}");
                    write(&mut socket, json!({"version":1,"id":"activity-ping",
                        "method":"analytics.activity","params":{"focused":true,"idleSeconds":0}})).await;
                    let activity = tokio::time::timeout(Duration::from_secs(1), read(&mut socket)).await.unwrap();
                    assert_eq!(activity["id"], "activity-ping");
                    assert!(activity.get("error").is_none(), "analytics.activity must use bounded query admission: {activity}");
                }
                released.notify_one();
                if progress.is_ok() {
                    let slow = read(&mut socket).await;
                    assert_eq!(slow["id"], "slow");
                    if blocked_method == "manage.read" {
                        assert!(slow.get("error").is_none(), "{slow}");
                    } else if blocked_method == "desktop.command" {
                        assert_eq!(read(&mut socket).await["id"], "second");
                    }
                }
                if let Some(close) = mock_core_close {
                    close();
                }
                if let Some(control) = mock_control_server {
                    control.abort();
                }
                if let Some(server) = mock_core_server {
                    server.abort();
                }
                drop(mock_service_lock);
                assert!(
                    progress.is_ok(),
                    "a pending workbench request blocked the read/event loop"
                );
            }
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
            for method in ["worktree.read", "tasks.read", "trajectory.read", "trajectory.command", "feedback.read", "feedback.command", "manage.read", "manage.command", "providers.read", "providers.command", "bots.read", "bots.command"] {
                assert_eq!(methods.contains(&json!(method)), scope == "manage");
            }
            assert_eq!(methods.contains(&json!("session.send")), scope == "submit");
            assert_eq!(methods.contains(&json!("interaction.respond")), scope == "approve");
            write(&mut socket, json!({"version":1,"id":"write","method":"library.command","params":{"sourceId":"fixture","operation":"createSection","title":"fixture"},"commandId":uuid::Uuid::new_v4().to_string()})).await;
            let error = read(&mut socket).await["error"].clone();
            assert_eq!(error["code"], if scope == "manage" { "CAPABILITY_UNAVAILABLE" } else { "FORBIDDEN" });
            assert_eq!(error["submissionUnknown"], false);
            fixture.client().await.revoke_browser(&grant.device_id).await.unwrap();
            write(&mut socket, json!({"version":1,"id":"revoked","method":"host.status","params":{}})).await;
            closed(&mut socket).await;
        }
    }).await;
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

#[tokio::test(flavor = "current_thread")]
async fn ready_and_session_open_fail_immediately_when_project_is_stopping() {
    tokio::task::LocalSet::new().run_until(async {
        let fixture = Fixture::start().await;
        storage::private_dir(&fixture.host.home.join("host/projects")).unwrap();
        let client = fixture.client().await;
        let workspace = fixture.host.home.join("stopping-workspace");
        let data = fixture.host.home.join("stopping-data");
        for path in [&workspace, &data] {
            storage::private_dir(path).unwrap();
        }
        let registration = crate::ProjectRegistration {
            project_id: "stopping".into(),
            workspace: workspace.clone(),
            data_dir: data.clone(),
            source: crate::ProjectSource::Cli,
            default_binding: false,
        };
        client
            .register(&uuid::Uuid::new_v4().to_string(), registration.clone())
            .await
            .unwrap();
        let generation = uuid::Uuid::new_v4().to_string();
        let service: areal_protocol::service::Service = serde_json::from_value(json!({
            "protocolVersion": 1,
            "serviceId": Host::service_id(&registration),
            "generation": generation,
            "workspace": workspace,
            "dataDir": data,
            "configFingerprint": "fp",
            "owner": {
                "kind": "host",
                "hostId": fixture.host.identity.host_id,
                "generation": fixture.host.identity.generation
            },
            "endpoint": "http://127.0.0.1:1",
            "webUrl": "http://127.0.0.1:1",
            "authFile": data.join("auth.json"),
            "logFile": data.join("host.log"),
            "hostPid": 500000000,
            "corePid": 500000001,
            "state": "ready"
        }))
        .unwrap();
        {
            let mut slots = fixture.host.slots.borrow_mut();
            let slot = slots.get_mut("stopping").unwrap();
            slot.state = "stopping".into();
            slot.service = Some(service.clone());
        }
        // Case A: ready() called when slot is already "stopping" with old service still attached.
        let immediate = tokio::time::timeout(
            Duration::from_secs(1),
            fixture
                .host
                .schedules
                .connections
                .ready(&fixture.host, "stopping", &generation),
        )
        .await
        .expect("ready() must fail immediately on stopping slot instead of hanging 15s");
        assert!(immediate.is_err());

        // Case B: ready() is waiting on a "starting" slot that transitions to "stopping" via host.changed().
        {
            let mut slots = fixture.host.slots.borrow_mut();
            let slot = slots.get_mut("stopping").unwrap();
            slot.state = "starting".into();
            slot.service = Some(service);
        }
        let host = fixture.host.clone();
        let gen_clone = generation.clone();
        let waiter = tokio::task::spawn_local(async move {
            host.schedules
                .connections
                .ready(&host, "stopping", &gen_clone)
                .await
        });
        tokio::task::yield_now().await;
        {
            let mut slots = fixture.host.slots.borrow_mut();
            let slot = slots.get_mut("stopping").unwrap();
            slot.state = "stopping".into();
        }
        fixture.host.changed();
        let woken = tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("ready() must wake immediately when host.changed() transitions slot to stopping")
            .unwrap();
        assert!(woken.is_err());

        // Case C: loopback session.open on a stopping slot must return error immediately, not block 15s.
        let ticket = client.web_ticket(ELECTRON_ORIGIN).await.unwrap();
        let mut socket = connect(&ticket, ELECTRON_ORIGIN).await;
        write(
            &mut socket,
            json!({
                "version": 1,
                "id": "hello",
                "method": "hello",
                "params": {
                    "protocolVersions": [1],
                    "capabilities": ["gui-read-v1", "persistedHistoryV1"],
                    "ticket": ticket.ticket,
                    "expectedGeneration": ticket.generation
                }
            }),
        )
        .await;
        assert!(read(&mut socket).await.get("result").is_some());
        write(
            &mut socket,
            json!({
                "version": 1,
                "id": "open-stopping",
                "method": "session.open",
                "context": { "projectId": "stopping", "serviceGeneration": generation },
                "params": { "threadId": "thread-1", "view": "conversation" }
            }),
        )
        .await;
        let reply = tokio::time::timeout(Duration::from_secs(1), read(&mut socket))
            .await
            .expect("session.open must fail immediately when project is stopping");
        assert!(reply.get("error").is_some(), "expected error reply, got {reply}");
    })
    .await;
}

#[tokio::test(flavor = "current_thread")]
async fn shell_update_is_sent_before_session_invalidated_on_host_change() {
    tokio::task::LocalSet::new().run_until(async {
        let fixture = Fixture::start().await;
        storage::private_dir(&fixture.host.home.join("host/projects")).unwrap();
        let client = fixture.client().await;
        let workspace = fixture.host.home.join("order-workspace");
        let data = fixture.host.home.join("order-data");
        for path in [&workspace, &data, &data.join("blobs")] {
            storage::private_dir(path).unwrap();
        }
        let registration = crate::ProjectRegistration {
            project_id: "ordered".into(),
            workspace: workspace.clone(),
            data_dir: data.clone(),
            source: crate::ProjectSource::Cli,
            default_binding: false,
        };
        client
            .register(&uuid::Uuid::new_v4().to_string(), registration.clone())
            .await
            .unwrap();
        let directory =
            storage::registry(&fixture.host.home, &Host::service_id(&registration)).unwrap();
        storage::private_dir(&directory).unwrap();
        for path in [
            directory.join("start.lock"),
            data.join("service.lock"),
            data.join("owner.lock"),
        ] {
            storage::open_private(&path, true).unwrap();
        }
        storage::write(&data.join("service-workspace"), &workspace).unwrap();
        let generation = uuid::Uuid::new_v4().to_string();
        let descriptor = json!({
            "protocolVersion": 1,
            "serviceId": Host::service_id(&registration),
            "generation": generation,
            "workspace": workspace,
            "dataDir": data,
            "configFingerprint": "old",
            "owner": {
                "kind": "host",
                "hostId": fixture.host.identity.host_id,
                "generation": uuid::Uuid::new_v4().to_string()
            },
            "endpoint": "http://127.0.0.1:1",
            "webUrl": "http://127.0.0.1:1",
            "authFile": directory.join("auth.json"),
            "logFile": directory.join("host.log"),
            "hostPid": 500000000,
            "corePid": 500000001,
            "state": "ready"
        });
        storage::write(&directory.join("service.json"), &descriptor).unwrap();
        let thread = uuid::Uuid::new_v4().to_string();
        let record = json!({
            "version": 17,
            "thread": {
                "id": thread,
                "sessionId": thread,
                "parentThreadId": null,
                "preview": "fixture",
                "modelProvider": "fixture",
                "createdAt": 1,
                "updatedAt": 2,
                "status": { "type": "idle" },
                "cwd": workspace,
                "cliVersion": "fixture",
                "source": "cli",
                "ephemeral": false,
                "turns": []
            }
        });
        storage::write(&data.join(format!("{thread}.json")), &record).unwrap();

        let ticket = client.web_ticket(ELECTRON_ORIGIN).await.unwrap();
        let mut socket = connect(&ticket, ELECTRON_ORIGIN).await;
        write(
            &mut socket,
            json!({
                "version": 1,
                "id": "hello",
                "method": "hello",
                "params": {
                    "protocolVersions": [1],
                    "capabilities": ["gui-read-v1", "persistedHistoryV1"],
                    "ticket": ticket.ticket,
                    "expectedGeneration": ticket.generation
                }
            }),
        )
        .await;
        assert!(read(&mut socket).await.get("result").is_some());

        write(
            &mut socket,
            json!({
                "version": 1,
                "id": "shell",
                "method": "shell.subscribe",
                "params": {}
            }),
        )
        .await;
        assert!(read(&mut socket).await.get("result").is_some());

        write(
            &mut socket,
            json!({
                "version": 1,
                "id": "open",
                "method": "session.openPersisted",
                "context": { "projectId": "ordered", "serviceGeneration": generation },
                "params": { "threadId": thread, "view": "conversation" }
            }),
        )
        .await;
        assert!(read(&mut socket).await.get("result").is_some());

        // Trigger a Host change that both updates shell project state and invalidates the reader.
        {
            let mut slots = fixture.host.slots.borrow_mut();
            let slot = slots.get_mut("ordered").unwrap();
            slot.state = "stopping".into();
            slot.registration.workspace = fixture.host.home.join("rebound-order-workspace");
        }
        fixture.host.changed();

        let first = read(&mut socket).await;
        let second = read(&mut socket).await;
        assert!(
            matches!(
                first["method"].as_str(),
                Some("shell.updated" | "shell.snapshot")
            ),
            "expected shell update before session.invalidated, got first={first} second={second}"
        );
        assert_eq!(second["method"], "session.invalidated");
    })
    .await;
}

#[tokio::test(flavor = "current_thread")]
async fn loopback_bots_command_read_and_event_push() {
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
                json!({
                    "version": 1,
                    "id": "hello",
                    "method": "hello",
                    "params": {
                        "protocolVersions": [1],
                        "capabilities": ["gui-read-v1", "gui-write-v1"],
                        "ticket": ticket.ticket,
                        "expectedGeneration": ticket.generation
                    }
                }),
            )
            .await;
            let hello = read(&mut socket).await["result"].clone();
            let methods = hello["writeMethods"].as_array().unwrap();
            assert!(methods.contains(&json!("bots.read")));
            assert!(methods.contains(&json!("bots.command")));

            // 1. bots.command create -> 产生注册表更新并推送 bots.event (registryChanged)
            write(
                &mut socket,
                json!({
                    "version": 1,
                    "id": "bot-create",
                    "method": "bots.command",
                    "commandId": uuid::Uuid::new_v4().to_string(),
                    "params": {
                        "operation": "create",
                        "name": "Loopback Bot",
                        "workspace": "loopback-bot-1"
                    }
                }),
            )
            .await;

            let mut saw_create_reply = false;
            let mut saw_event = false;
            for _ in 0..4 {
                let msg = read(&mut socket).await;
                if msg.get("id") == Some(&json!("bot-create")) {
                    assert_eq!(msg["result"]["admissionState"], "accepted");
                    assert_eq!(
                        msg["result"]["receipt"]["bot"]["workspace"],
                        "loopback-bot-1"
                    );
                    saw_create_reply = true;
                } else if msg.get("method") == Some(&json!("bots.event")) {
                    assert_eq!(msg["params"]["event"], "bots.event");
                    assert_eq!(msg["params"]["notification"]["kind"], "registryChanged");
                    saw_event = true;
                }
                if saw_create_reply && saw_event {
                    break;
                }
            }
            assert!(saw_create_reply && saw_event);

            // 2. bots.read list -> 读回刚创建的 Bot
            write(
                &mut socket,
                json!({
                    "version": 1,
                    "id": "bot-list",
                    "method": "bots.read",
                    "params": { "operation": "list" }
                }),
            )
            .await;
            let list_reply = read(&mut socket).await;
            assert_eq!(list_reply["id"], "bot-list");
            assert_eq!(list_reply["result"]["bots"][0]["name"], "Loopback Bot");

            // 3. 查询不存在的 Bot -> 返回 NOT_FOUND 且 submissionUnknown == false
            write(
                &mut socket,
                json!({
                    "version": 1,
                    "id": "bot-missing",
                    "method": "bots.read",
                    "params": { "operation": "get", "id": "non-existent" }
                }),
            )
            .await;
            let missing = read(&mut socket).await;
            assert_eq!(missing["error"]["code"], "NOT_FOUND");
            assert_eq!(missing["error"]["submissionUnknown"], false);
        })
        .await;
}

#[test]
fn worktree_cancel_uses_control_lane_without_reclassifying_creation() {
    assert_eq!(
        request_lane("worktree.command", &json!({"operation":"worktreeCancel"})),
        Some(RemoteMethodLane::Control)
    );
    assert_eq!(
        request_lane("worktree.command", &json!({"operation":"worktreeCreate"})),
        Some(RemoteMethodLane::Mutation)
    );
}
