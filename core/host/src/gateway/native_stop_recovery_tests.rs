use super::*;
use std::collections::HashMap;
use tokio::sync::broadcast;

#[derive(Default, Serialize)]
struct StopState {
    directory: PathBuf,
    hold_turn: Option<String>,
    held_request: Option<Value>,
    held_pending: Option<Value>,
    drop_turn: Option<String>,
    requests: Vec<Value>,
    forwarded: Vec<Value>,
    events: Vec<Value>,
    dropped_success: Option<Value>,
}

struct StopProxy {
    task: tokio::task::JoinHandle<()>,
    state: Rc<RefCell<StopState>>,
    release: broadcast::Sender<()>,
}

async fn attach_stop_proxy(f: &mut Fixture, native: &NativeCore) -> StopProxy {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("ws://{}/", listener.local_addr().unwrap());
    let auth: Value = storage::read(&native.direct.auth_file).unwrap();
    let token = auth["principals"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == "desktop-owner")
        .unwrap()["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let state = Rc::new(RefCell::new(StopState::default()));
    let (release, _) = broadcast::channel(8);
    let changes = release.clone();
    let observed = state.clone();
    let endpoint_upstream = native.direct.endpoint.clone();
    let host = f.host.clone();
    let task = tokio::task::spawn_local(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let mut request = endpoint_upstream.as_str().into_client_request().unwrap();
            request
                .headers_mut()
                .insert("authorization", format!("Bearer {token}").parse().unwrap());
            let state = observed.clone();
            let host = host.clone();
            let mut released = changes.subscribe();
            connections.spawn_local(async move {
                let mut downstream = tokio_tungstenite::accept_async(stream).await.unwrap();
                let (mut upstream,_) = tokio_tungstenite::connect_async(request).await.unwrap();
                let mut requests = HashMap::<String,Value>::new();
                let mut held = None;
                loop {
                    tokio::select! {
                        release = released.recv() => {
                            if release.is_err() { break; }
                            if let Some((message,value)) = held.take() {
                                if upstream.send(message).await.is_err() { break; }
                                state.borrow_mut().forwarded.push(value);
                            }
                        }
                        incoming = downstream.next() => {
                            let Some(Ok(message))=incoming else { break; };
                            let value = if let Message::Text(text)=&message { serde_json::from_str::<Value>(text).ok() } else { None };
                            if let Some(value)=value.filter(|value|value["method"]=="turn/interrupt") {
                                requests.insert(value["id"].to_string(),value.clone());
                                state.borrow_mut().requests.push(value.clone());
                                let should_hold=state.borrow().hold_turn.as_deref()==value["params"]["turnId"].as_str();
                                if should_hold {
                                    let (_,snapshot)=host.journal.native_snapshot("project").unwrap();
                                    let pending=snapshot["pending"].as_array().unwrap().iter().find(|row|row["method"]=="turn/interrupt" && row["params"]==value["params"]).unwrap().clone();
                                    let mut observation=state.borrow_mut();
                                    observation.hold_turn=None;
                                    observation.held_request=Some(value.clone());
                                    observation.held_pending=Some(pending);
                                    storage::write(&observation.directory.join("admitted-A.json"),&*observation).unwrap();
                                    held=Some((message,value));
                                    continue;
                                }
                                if upstream.send(message).await.is_err() { break; }
                                state.borrow_mut().forwarded.push(value);
                                continue;
                            }
                            if upstream.send(message).await.is_err() { break; }
                        }
                        incoming = upstream.next() => {
                            let Some(Ok(message))=incoming else { break; };
                            if let Message::Text(text)=&message {
                                let value: Value=serde_json::from_str(text).unwrap();
                                if let Some(request)=requests.remove(&value["id"].to_string()) {
                                    let response=json!({"request":request,"response":value});
                                    state.borrow_mut().events.push(response.clone());
                                    let should_drop = state.borrow().drop_turn.as_deref()==request["params"]["turnId"].as_str() && value.get("result").is_some() && state.borrow().dropped_success.is_none();
                                    if should_drop {
                                        state.borrow_mut().dropped_success=Some(response);
                                        state.borrow_mut().events.push(json!({"event":"drop-success-and-close-shared-socket","responseId":value["id"]}));
                                        storage::write(&state.borrow().directory.join("dropped-B-success.json"),&*state.borrow()).unwrap();
                                        let _=downstream.close(None).await;
                                        let _=upstream.close(None).await;
                                        break;
                                    }
                                }
                            }
                            if downstream.send(message).await.is_err() { break; }
                        }
                    }
                }
            });
        }
    });
    let mut service = native.direct.clone();
    service.endpoint = endpoint;
    f.host
        .slots
        .borrow_mut()
        .get_mut("project")
        .unwrap()
        .service = Some(service.clone());
    f.close = f
        .host
        .schedules
        .connections
        .connect_test_core(f.host.clone(), "project", service)
        .await
        .unwrap();
    StopProxy {
        task,
        state,
        release,
    }
}

async fn held_model(native: &NativeCore, client: &reqwest::Client, marker: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let response: Value = client
            .get(format!("{}/native-stop/held", native.model_origin))
            .query(&[("marker", marker)])
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if response["held"] == true {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "original model barrier deadline"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn release_model(native: &NativeCore, client: &reqwest::Client, marker: &str) {
    let response: Value = client
        .post(format!("{}/native-stop/release", native.model_origin))
        .query(&[("marker", marker)])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(response["held"], false);
}

async fn stop_turn_state(direct: &Service, thread: &str, turn: &str) -> Value {
    let value = areal_local_service::rpc(
        direct,
        "thread/read",
        json!({"threadId":thread,"includeTurns":true}),
    )
    .await
    .unwrap();
    value["thread"]["turns"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == turn)
        .cloned()
        .unwrap()
}

async fn settled_stop_turn(direct: &Service, thread: &str, turn: &str) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let value = stop_turn_state(direct, thread, turn).await;
        if ["completed", "failed", "interrupted"]
            .iter()
            .any(|status| value["status"] == *status)
        {
            return value;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "original Turn settlement deadline"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn result_value(value: &Result<Value>) -> Value {
    match value {
        Ok(value) => json!({"result":value}),
        Err(error) => json!({"error":error.to_string()}),
    }
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "real Core/Runtime startup; owner fixture only, no Noise or independent Host process; AREAL_NATIVE_STOP_REPETITIONS=1 or 100"]
async fn native_stop_admitted_race() {
    tokio::task::LocalSet::new()
        .run_until(run_stop_races())
        .await;
}

async fn run_stop_races() {
    let repetitions: usize = std::env::var("AREAL_NATIVE_STOP_REPETITIONS")
        .unwrap_or_else(|_| "1".into())
        .parse()
        .unwrap();
    assert!([1, 100].contains(&repetitions));
    let mut f = Fixture::new().await;
    (f.close)();
    f.server.abort();
    for peer in ["a", "b"] {
        f.grant(peer, |grant| {
            grant["capabilities"] = json!(["observe", "submit", "answer", "interrupt"])
        });
    }
    let mut native = start_native_core(&f).await;
    let root = native.run.clone();
    storage::write(&root.join("plan.json"),&json!({"repetitions":repetitions,"boundary":"real Core/Runtime startup; no Runtime tool execution or file side effect claimed; in-process Host owner+journal; no Remote Noise or independent Host crash"})).unwrap();
    let proxy = attach_stop_proxy(&mut f, &native).await;
    let client = reqwest::Client::new();
    let mut completed = vec![];
    for iteration in 0..repetitions {
        tokio::time::sleep(Duration::from_millis(1050)).await;
        let directory = root.join(format!("round-{iteration:03}"));
        storage::private_dir(&directory).unwrap();
        *proxy.state.borrow_mut() = StopState {
            directory: directory.clone(),
            ..Default::default()
        };
        let created=areal_local_service::rpc(&native.direct,"areal/thread/start",json!({"requestId":uuid::Uuid::new_v4().to_string(),"cwd":native.direct.identity.workspace,"agentProfile":{"id":"ordinary","revision":"v1"}})).await.unwrap();
        let thread = created["thread"]["id"].as_str().unwrap();
        let marker_a = format!("NATIVE_STOP:{}", uuid::Uuid::new_v4());
        let started=areal_local_service::rpc(&native.direct,"areal/turn/start",json!({"requestId":uuid::Uuid::new_v4().to_string(),"threadId":thread,"expectedConfigRevision":1,"input":[{"type":"text","text":marker_a}]})).await.unwrap();
        let turn_a = started["turn"]["id"].as_str().unwrap();
        held_model(&native, &client, &marker_a).await;
        proxy.state.borrow_mut().hold_turn = Some(turn_a.into());
        let command_a = uuid::Uuid::new_v4().to_string();
        let request = f.request(
            "turn.stop",
            json!({"threadId":thread,"expectedTurnId":turn_a}),
            Some(&command_a),
        );
        storage::write(&directory.join("original-A.json"), &request).unwrap();
        let running = Fixture::dispatch(f.session("a"), request);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        while proxy.state.borrow().held_request.is_none() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "admitted interrupt barrier deadline"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let pending = proxy.state.borrow().held_pending.clone().unwrap();
        assert_eq!(pending["remote"]["commandId"], command_a);
        assert_eq!(pending["remote"]["target"]["expectedTurnId"], turn_a);
        assert_eq!(pending["params"]["turnId"], turn_a);
        assert_eq!(pending["params"]["admissionGuard"]["ordinarySession"], true);
        release_model(&native, &client, &marker_a).await;
        let original_a = settled_stop_turn(&native.direct, thread, turn_a).await;
        assert_eq!(original_a["status"], "completed");
        let marker_b = format!("NATIVE_STOP:{}", uuid::Uuid::new_v4());
        let started=areal_local_service::rpc(&native.direct,"areal/turn/start",json!({"requestId":uuid::Uuid::new_v4().to_string(),"threadId":thread,"expectedConfigRevision":1,"input":[{"type":"text","text":marker_b}]})).await.unwrap();
        let turn_b = started["turn"]["id"].as_str().unwrap();
        held_model(&native, &client, &marker_b).await;
        proxy.release.send(()).unwrap();
        let (_, refusal) = running.await.unwrap();
        let refusal = refusal.unwrap();
        storage::write(&directory.join("original-A-refusal.json"), &refusal).unwrap();
        assert_eq!(refusal["admissionState"], "rejected");
        assert_eq!(refusal["error"]["code"], "TARGET_CHANGED");
        assert_eq!(refusal["commandId"], command_a);
        assert_eq!(refusal["operationId"], pending["operationId"]);
        assert_eq!(refusal["target"]["threadId"], thread);
        assert_eq!(refusal["target"]["expectedTurnId"], turn_a);
        assert_eq!(
            proxy.state.borrow().forwarded,
            vec![proxy.state.borrow().held_request.clone().unwrap()]
        );
        assert_eq!(
            stop_turn_state(&native.direct, thread, turn_b).await["status"],
            "inProgress"
        );
        let before = proxy.state.borrow().forwarded.len();
        let read = f
            .session("a")
            .request(&f.request("command.read", json!({"commandId":command_a}), None))
            .await
            .unwrap();
        assert_eq!(read["admissionState"], "rejected");
        assert_eq!(read["operationId"], refusal["operationId"]);
        assert_eq!(proxy.state.borrow().forwarded.len(), before);
        proxy.state.borrow_mut().drop_turn = Some(turn_b.into());
        let ids = [
            uuid::Uuid::new_v4().to_string(),
            uuid::Uuid::new_v4().to_string(),
        ];
        let requests = ids
            .iter()
            .map(|id| {
                f.request(
                    "turn.stop",
                    json!({"threadId":thread,"expectedTurnId":turn_b}),
                    Some(id),
                )
            })
            .collect::<Vec<_>>();
        storage::write(&directory.join("original-B.json"), &requests).unwrap();
        let one = Fixture::dispatch(f.session("a"), requests[0].clone());
        let two = Fixture::dispatch(f.session("b"), requests[1].clone());
        let (_, one) = one.await.unwrap();
        let (_, two) = two.await.unwrap();
        storage::write(
            &directory.join("B-results.json"),
            &json!([result_value(&one), result_value(&two)]),
        )
        .unwrap();
        let results = [one, two];
        let (_, journal) = f.host.journal.native_snapshot("project").unwrap();
        let records = journal["pending"]
            .as_array()
            .unwrap()
            .iter()
            .chain(journal["outcomes"].as_object().unwrap().values())
            .collect::<Vec<_>>();
        let mut associations = vec![];
        for (index, result) in results.iter().enumerate() {
            let record = records
                .iter()
                .find(|record| record["remote"]["commandId"] == ids[index]);
            if let Ok(result) = result {
                assert_eq!(result["commandId"], ids[index]);
                assert!(result["operationId"].is_string());
                assert_eq!(record.unwrap()["operationId"], result["operationId"]);
                if result["admissionState"] == "unknown" {
                    assert!(result.get("receipt").is_none());
                }
            }
            if let Some(record) = record {
                assert_eq!(
                    record["remote"]["devicePeerId"],
                    if index == 0 { "a" } else { "b" }
                );
                assert_eq!(record["remote"]["target"]["expectedTurnId"], turn_b);
                assert_eq!(record["threadId"], thread);
            }
            associations.push(json!({"commandId":ids[index],"devicePeerId":if index==0 {"a"} else {"b"},"originalResult":result_value(result),"journalRecord":record}));
        }
        storage::write(&directory.join("B-associations.json"), &associations).unwrap();
        let index = results
            .iter()
            .position(|result| {
                result
                    .as_ref()
                    .is_ok_and(|value| value["admissionState"] == "unknown")
            })
            .expect("at least one original B command remains UNKNOWN after real success is lost");
        let unknown = results[index].as_ref().unwrap();
        assert!(unknown.get("nativeRequestId").is_none());
        assert_eq!(unknown["commandId"], ids[index]);
        assert_eq!(unknown["target"]["expectedTurnId"], turn_b);
        let dropped = proxy
            .state
            .borrow()
            .dropped_success
            .clone()
            .expect("must lose an actual B Core success");
        assert_eq!(dropped["request"]["params"]["turnId"], turn_b);
        assert!(dropped["response"].get("result").is_some());
        release_model(&native, &client, &marker_b).await;
        let final_b = settled_stop_turn(&native.direct, thread, turn_b).await;
        f.reconnect().await;
        let before = proxy.state.borrow().requests.len();
        let receipt = f
            .session(if index == 0 { "a" } else { "b" })
            .request(&f.request("command.read", json!({"commandId":ids[index]}), None))
            .await
            .unwrap();
        assert_eq!(receipt["admissionState"], "unknown");
        assert_eq!(receipt["operationId"], unknown["operationId"]);
        assert!(receipt.get("nativeRequestId").is_none());
        assert!(receipt.get("receipt").is_none());
        assert_eq!(proxy.state.borrow().requests.len(), before);
        let fresh = f.request(
            "turn.stop",
            json!({"threadId":thread,"expectedTurnId":turn_b}),
            Some(&uuid::Uuid::new_v4().to_string()),
        );
        assert_eq!(
            f.session("a")
                .request(&fresh)
                .await
                .unwrap_err()
                .to_string(),
            "TARGET_CHANGED"
        );
        for terminal in [&original_a, &final_b] {
            assert!(
                !terminal["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|item| item["execution"]["backend"] == "runtime")
            );
        }
        let row = json!({"iteration":iteration,"threadId":thread,"turnA":turn_a,"turnB":turn_b,"originalACommand":command_a,"originalBCommands":ids,"unknownDevice":if index==0 {"a"} else {"b"},"originalUnknown":unknown,"originalUnknownRead":receipt,"A":original_a,"B":final_b,"refusal":refusal});
        storage::write(&directory.join("result.json"), &row).unwrap();
        storage::write(&directory.join("proxy.json"), &*proxy.state.borrow()).unwrap();
        completed.push(row);
        storage::write(
            &root.join("progress.json"),
            &json!({"completed":completed.len(),"repetitions":repetitions,"rounds":completed}),
        )
        .unwrap();
    }
    (f.close)();
    proxy.task.abort();
    let _ = proxy.task.await;
    for child in [&mut native.core, &mut native.model] {
        if child.0.try_wait().unwrap().is_none() {
            unsafe {
                libc::kill(child.0.id() as i32, libc::SIGINT);
            }
        }
        for _ in 0..400 {
            if child.0.try_wait().unwrap().is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(child.0.try_wait().unwrap().is_some());
    }
    storage::write(&root.join("result.json"),&json!({"businessPassed":true,"cleanupPassed":true,"repetitions":repetitions,"completed":completed.len(),"corePid":native.core.0.id(),"modelPid":native.model.0.id(),"runtimeToolExecution":false,"boundary":"in-process Host owner+journal with real Core/Runtime startup; no Remote Noise or independent Host process crash"})).unwrap();
    println!("native stop evidence: {}", root.display());
}
