use super::*;
use fs2::FileExt;
use std::{cell::Cell, fs::File};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, UnixListener},
};

struct Boundary {
    host: Rc<Host>,
    service: Service,
    statuses: Rc<Cell<usize>>,
    initialized: Rc<Cell<usize>>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    _locks: Vec<File>,
    _root: tempfile::TempDir,
}

impl Drop for Boundary {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

async fn boundary(first_status_delay: Duration) -> Boundary {
    let root = tempfile::tempdir_in("/tmp").unwrap();
    let host = Rc::new(super::schedules::tests::fixture(root.path()));
    host.schedules.suppress("project", true).unwrap();
    let registration = host.slots.borrow()["project"].registration.clone();
    storage::private_dir(&registration.data_dir).unwrap();
    let id = Host::service_id(&registration);
    let directory = storage::registry(&host.home, &id).unwrap();
    storage::private_dir(&directory).unwrap();
    let locks = ["service.lock", "owner.lock"]
        .map(|name| {
            let file = storage::open_private(&registration.data_dir.join(name), true).unwrap();
            file.try_lock_exclusive().unwrap();
            file
        })
        .into_iter()
        .collect();
    let (writer, lifetime) = areal_local_service::OwnerLifetime::pair().unwrap();
    {
        let mut slots = host.slots.borrow_mut();
        let slot = slots.get_mut("project").unwrap();
        slot.writer = Some(writer);
        slot.lifetime = Some(Rc::new(lifetime));
    }
    let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let service = Service {
        identity: areal_protocol::service::Identity {
            protocol_version: 1,
            service_id: id,
            generation: uuid::Uuid::new_v4().to_string(),
            workspace: registration.workspace,
            data_dir: registration.data_dir,
            config_fingerprint: "recovery-boundary".into(),
        },
        owner: Some(host.owner()),
        endpoint: format!("ws://{}/", tcp.local_addr().unwrap()),
        web_url: String::new(),
        auth_file: directory.join("auth.json"),
        log_file: directory.join("host.log"),
        host_pid: std::process::id(),
        core_pid: std::process::id(),
        state: State::Ready,
    };
    storage::write(
        &service.auth_file,
        &json!({"principals":[{"id":"desktop-owner","token":"controlled-status-owner-token"}]}),
    )
    .unwrap();
    storage::write(&directory.join("service.json"), &service).unwrap();
    {
        let mut slots = host.slots.borrow_mut();
        let slot = slots.get_mut("project").unwrap();
        slot.state = "ready".into();
        slot.service = Some(service.clone());
    }
    let initialized = Rc::new(Cell::new(0));
    let connections = initialized.clone();
    let identity = service.identity.clone();
    let http_ws = tokio::task::spawn_local(async move {
        let mut clients = JoinSet::new();
        loop {
            let (mut stream, _) = tcp.accept().await.unwrap();
            let initialized = connections.clone();
            let identity = identity.clone();
            clients.spawn_local(async move {
                let mut bytes=[0u8;8192];
                let count=loop {
                    let count=stream.peek(&mut bytes).await.unwrap();
                    if count==0 {return;}
                    if bytes[..count].windows(4).any(|part|part==b"\r\n\r\n") {break count;}
                    tokio::time::sleep(Duration::from_millis(1)).await;
                };
                let headers=String::from_utf8_lossy(&bytes[..count]).to_ascii_lowercase();
                assert!(headers.lines().any(|line|line.trim()=="authorization: bearer controlled-status-owner-token"));
                if headers.starts_with("get /areal/service ") {
                    let mut consumed=vec![0;count];stream.read_exact(&mut consumed).await.unwrap();
                    let body=serde_json::to_string(&identity).unwrap();
                    stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
                    return;
                }
                let mut socket=tokio_tungstenite::accept_async(stream).await.unwrap();
                while let Some(Ok(Message::Text(text)))=socket.next().await {
                    let value:Value=serde_json::from_str(&text).unwrap();
                    if value["method"]=="initialized" {continue;}
                    let result=match value["method"].as_str().unwrap() {
                        "initialize"=>{initialized.set(initialized.get()+1);json!({"capabilities":{}})},
                        "areal/model/list"=>json!({"data":[{"providerId":"fixture","modelId":"fixture"}]}),
                        other=>panic!("unexpected shared request {other}"),
                    };
                    if socket.send(Message::Text(json!({"id":value["id"],"result":result}).to_string().into())).await.is_err() {break;}
                }
            });
        }
    });
    let unix = UnixListener::bind(storage::control_socket(&directory).unwrap()).unwrap();
    let statuses = Rc::new(Cell::new(0));
    let counts = statuses.clone();
    let current = service.clone();
    let control = tokio::task::spawn_local(async move {
        let mut clients = JoinSet::new();
        loop {
            let (mut stream, _) = unix.accept().await.unwrap();
            let service = current.clone();
            let attempt = counts.get();
            counts.set(attempt + 1);
            clients.spawn_local(async move {
                let mut line = String::new();
                BufReader::new(&mut stream)
                    .read_line(&mut line)
                    .await
                    .unwrap();
                assert!(matches!(
                    serde_json::from_str::<areal_protocol::service::Request>(&line).unwrap(),
                    areal_protocol::service::Request::Status { version: 1 }
                ));
                if attempt == 0 {
                    tokio::time::sleep(first_status_delay).await;
                }
                let response = serde_json::to_string(&areal_protocol::service::Response::Ok {
                    service: Box::new(service),
                })
                .unwrap()
                    + "\n";
                let _ = stream.write_all(response.as_bytes()).await;
            });
        }
    });
    Boundary {
        host,
        service,
        statuses,
        initialized,
        tasks: vec![http_ws, control],
        _locks: locks,
        _root: root,
    }
}

#[derive(Clone, Copy, Debug)]
enum AfterTimeout {
    KeepOwner,
    DropWriter,
    Stop,
    ForeignOwner,
    UncertainStartup,
}

async fn observe_recovery(fixture: Boundary, delay: Duration, after: AfterTimeout) -> Value {
    areal_local_service::probe(&fixture.service).await.unwrap();
    assert!(!storage::available(&fixture.service.identity.data_dir.join("service.lock")).unwrap());
    assert!(!storage::available(&fixture.service.identity.data_dir.join("owner.lock")).unwrap());
    let host = fixture.host.clone();
    let worker = tokio::task::spawn_local(run(host));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(12);
    let mut observed_states = vec![];
    let mut action_applied = matches!(after, AfterTimeout::KeepOwner);
    while tokio::time::Instant::now() < deadline {
        let state = fixture.host.slots.borrow()["project"].state.clone();
        if observed_states.last() != Some(&state) {
            observed_states.push(state);
        }
        if !action_applied && fixture.host.slots.borrow()["project"].state == "unavailable" {
            let mut slots = fixture.host.slots.borrow_mut();
            let slot = slots.get_mut("project").unwrap();
            match after {
                AfterTimeout::KeepOwner => unreachable!(),
                AfterTimeout::DropWriter => slot.writer = None,
                AfterTimeout::Stop => slot.state = "stopped".into(),
                AfterTimeout::ForeignOwner => {
                    slot.service.as_mut().unwrap().owner =
                        Some(areal_protocol::service::Owner::Host {
                            host_id: uuid::Uuid::new_v4().to_string(),
                            generation: uuid::Uuid::new_v4().to_string(),
                        })
                }
                AfterTimeout::UncertainStartup => slot.uncertain_start = true,
            }
            action_applied = true;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let slot_state = fixture.host.slots.borrow()["project"].state.clone();
    let shared = fixture
        .host
        .schedules
        .connections
        .shared_identity(&fixture.host, "project");
    let models = if let Ok((id, generation, connection)) = &shared {
        Some(
            fixture
                .host
                .schedules
                .connections
                .remote_request(
                    &fixture.host,
                    "project",
                    (id, generation, connection),
                    "areal/model/list",
                    json!({}),
                )
                .await
                .unwrap(),
        )
    } else {
        None
    };
    areal_local_service::probe(&fixture.service).await.unwrap();
    let persisted: Value = storage::read(&fixture.host.home.join("host/scheduling.json")).unwrap();
    let value = json!({"firstStatusDelayMs":delay.as_millis(),"observationBudgetMs":12000,
        "slotState":slot_state,"observedSlotStates":observed_states,"sharedAvailable":shared.is_ok(),"models":models,
        "sharedGeneration":shared.as_ref().ok().map(|(_,generation,_)|generation),
        "afterTimeout":format!("{after:?}"),"actionApplied":action_applied,
        "statusCalls":fixture.statuses.get(),"initializations":fixture.initialized.get(),
        "generation":fixture.service.identity.generation,"persistedScheduling":persisted,
        "directHttpProbeHealthyBeforeAndAfter":true,"hostStatusHealingCalls":0,
        "boundary":"real Host/local-service status logic and file locks, Unix control/HTTP/WS protocol fixture; no native Core/Runtime or fixed slot"
    });
    worker.abort();
    let _ = worker.await;
    value
}

#[tokio::test(flavor = "current_thread")]
async fn controlled_status_delay_recovers_without_host_status_healing() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let baseline = boundary(Duration::ZERO).await;
            let subject = boundary(Duration::from_millis(650)).await;
            let (control, delayed) = tokio::join!(
                observe_recovery(baseline, Duration::ZERO, AfterTimeout::KeepOwner),
                observe_recovery(subject, Duration::from_millis(650), AfterTimeout::KeepOwner)
            );
            let evidence = json!({"control":control,"delayed":delayed});
            if let Ok(directory) = std::env::var("AREAL_CORE_RECOVERY_EVIDENCE") {
                std::fs::create_dir_all(&directory).unwrap();
                storage::write(
                    &PathBuf::from(directory).join("controlled-pair.json"),
                    &evidence,
                )
                .unwrap();
            }
            println!("controlled recovery: {evidence}");
            assert_eq!(
                control["sharedAvailable"], true,
                "no-delay control must be healthy"
            );
            assert_eq!(control["models"]["data"][0]["modelId"], "fixture");
            assert_eq!(
                delayed["sharedAvailable"], true,
                "one status timeout must not permanently prevent recovery"
            );
            assert_eq!(delayed["models"]["data"][0]["modelId"], "fixture");
            assert_eq!(control["statusCalls"], 1);
            assert!(delayed["statusCalls"].as_u64().unwrap() >= 2);
            for result in [&control, &delayed] {
                assert_eq!(result["initializations"], 1);
                assert_eq!(result["sharedGeneration"], result["generation"]);
            }
            assert!(
                delayed["observedSlotStates"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|state| state == "unavailable")
            );
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn controlled_status_recovery_respects_lifecycle_authority() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let mut cases = vec![];
            for action in [
                AfterTimeout::DropWriter,
                AfterTimeout::Stop,
                AfterTimeout::ForeignOwner,
                AfterTimeout::UncertainStartup,
            ] {
                cases.push((boundary(Duration::from_millis(650)).await, action));
            }
            let observations =
                futures_util::future::join_all(cases.into_iter().map(|(fixture, action)| {
                    observe_recovery(fixture, Duration::from_millis(650), action)
                }))
                .await;
            if let Ok(directory) = std::env::var("AREAL_CORE_RECOVERY_EVIDENCE") {
                std::fs::create_dir_all(&directory).unwrap();
                storage::write(
                    &PathBuf::from(directory).join("negative-controls.json"),
                    &observations,
                )
                .unwrap();
            }
            println!("lifecycle recovery boundaries: {}", json!(observations));
            for result in &observations {
                assert_eq!(result["actionApplied"], true);
                assert_eq!(result["sharedAvailable"], false);
                assert_eq!(
                    result["statusCalls"], 1,
                    "authority loss must prevent even a new status probe"
                );
                assert_eq!(result["initializations"], 0);
                assert_eq!(result["directHttpProbeHealthyBeforeAndAfter"], true);
                assert_eq!(result["hostStatusHealingCalls"], 0);
                assert!(
                    result["observedSlotStates"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|state| state == "unavailable")
                );
            }
        })
        .await;
}
