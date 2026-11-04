use super::*;
use std::{
    cell::RefCell,
    path::PathBuf,
    process::{Child, Command, Stdio},
};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

#[path = "native_outcome_recovery_tests.rs"]
mod native_outcome_recovery_tests;

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if self.0.try_wait().unwrap().is_some() {
            return;
        }
        unsafe {
            libc::kill(self.0.id() as i32, libc::SIGINT);
        }
        for _ in 0..100 {
            if self.0.try_wait().unwrap().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

// 显式执行的真实进程验收；普通单测不启动本机固定槽或 Runtime。
#[tokio::test(flavor = "current_thread")]
#[ignore = "real Core/Runtime; Host owner fixture only, no Remote transport or Host crash; requires AREAL_CORE_BIN and AREAL_NATIVE_FAULT_EVIDENCE"]
async fn native_create_success_reply_lost_recovers_without_redispatch() {
    tokio::task::LocalSet::new()
        .run_until(run_native_creation_case())
        .await;
}

struct NativeCore {
    binary: PathBuf,
    run: PathBuf,
    effect: PathBuf,
    model: OwnedChild,
    core: OwnedChild,
    direct: Service,
}

struct NativeProxy {
    task: tokio::task::JoinHandle<()>,
    requests: Rc<RefCell<Vec<Value>>>,
    dropped: Rc<RefCell<Option<Value>>>,
    failed_outcome: Rc<RefCell<Option<Value>>>,
}

#[derive(Clone)]
enum NativeReplyFault {
    DropSuccess,
    DenyOutcomeWrite(PathBuf),
}

async fn start_native_core(f: &Fixture) -> NativeCore {
    let binary = PathBuf::from(std::env::var("AREAL_CORE_BIN").unwrap());
    let evidence = PathBuf::from(std::env::var("AREAL_NATIVE_FAULT_EVIDENCE").unwrap());
    std::fs::create_dir_all(&evidence).unwrap();
    let run = evidence.join(uuid::Uuid::new_v4().to_string());
    storage::private_dir(&run).unwrap();
    let workspace = f.host.slots.borrow()["project"]
        .registration
        .workspace
        .clone();
    let data = run.join("data");
    let ready = run.join("ready");
    let model_ready = run.join("model-ready");
    let effect = workspace.join("effect.txt");
    let model_script = format!(
        r#"
const {{createServer}} = require('node:http');
const {{writeFileSync}} = require('node:fs');
const server = createServer(async (req,res) => {{
 let raw=''; for await (const c of req) raw+=c;
 const body=JSON.parse(raw);
 const naming=body.messages.some(m=>m.role==='system' && typeof m.content==='string' && m.content.startsWith('Generate a concise semantic session title'));
 const latestUser=body.messages.findLastIndex(m=>m.role==='user');
 const tool=!naming && !body.messages.slice(latestUser+1).some(m=>m.role==='tool');
 const delta=tool ? {{tool_calls:[{{index:0,id:'native-effect',type:'function',function:{{name:'run_command',arguments:JSON.stringify({{command:{command}}})}}}}]}} : {{content:'Native fixture complete'}};
 res.writeHead(200,{{'content-type':'text/event-stream'}});
 res.end('data: '+JSON.stringify({{choices:[{{index:0,delta,finish_reason:tool?'tool_calls':'stop'}}]}})+'\n\ndata: [DONE]\n\n');
}});
server.listen(0,'127.0.0.1',()=>writeFileSync({ready},String(server.address().port)));
"#,
        command = serde_json::to_string(&format!("printf x >> '{}'", effect.display())).unwrap(),
        ready = serde_json::to_string(&model_ready).unwrap()
    );
    let model = OwnedChild(
        Command::new("node")
            .args(["-e", &model_script])
            .stdout(Stdio::null())
            .stderr(std::fs::File::create(run.join("model.log")).unwrap())
            .spawn()
            .unwrap(),
    );
    for _ in 0..400 {
        if model_ready.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let port = std::fs::read_to_string(&model_ready).unwrap();
    let config = run.join("config.toml");
    std::fs::write(&config,format!("schema_version=1\n[model]\nprovider=\"fixture\"\nname=\"fixture\"\n[model.providers.fixture]\nprotocol=\"chat-completions\"\nendpoint=\"http://127.0.0.1:{port}/v1/chat/completions\"\n")).unwrap();
    let deployment = run.join("deployment.json");
    storage::write(&deployment, &json!({"profiles":[
        {"id":"reviewed","revision":"v1","displayName":"Reviewed native fault","instructions":"Complete the task.","approvalTools":["run_command"]},
        {"id":"ordinary","revision":"v1","displayName":"Ordinary native follow-up","instructions":"Complete the task."}
    ]})).unwrap();
    let core_log = std::fs::File::create(run.join("core.log")).unwrap();
    let mut core = OwnedChild(
        Command::new(&binary)
            .arg("app-server")
            .arg("--desktop-config")
            .arg(&deployment)
            .arg("--config")
            .arg(&config)
            .args(["--listen", "127.0.0.1:0"])
            .arg("--data-dir")
            .arg(&data)
            .arg("--ready-file")
            .arg(&ready)
            .arg("--runtime")
            .arg(binary.with_file_name("areal-runtime"))
            .arg("--workspace")
            .arg(&workspace)
            .arg("--allow-write")
            .env("HOME", &run)
            .env("AREAL_HARNESS_HOME", run.join("user"))
            .stdout(Stdio::null())
            .stderr(core_log)
            .spawn()
            .unwrap(),
    );
    for _ in 0..800 {
        assert!(
            core.0.try_wait().unwrap().is_none(),
            "native Core exited; inspect core.log"
        );
        if ready.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let upstream = std::fs::read_to_string(&ready).unwrap();
    let auth = data.join("security/auth.json");
    let mut direct = f.host.slots.borrow()["project"].service.clone().unwrap();
    direct.endpoint = upstream;
    direct.auth_file = auth;
    direct.core_pid = core.0.id();
    NativeCore {
        binary,
        run,
        effect,
        model,
        core,
        direct,
    }
}

async fn attach_native_proxy(
    f: &mut Fixture,
    native: &NativeCore,
    method: &'static str,
    fault: NativeReplyFault,
) -> NativeProxy {
    let run = native.run.clone();
    let upstream = native.direct.endpoint.clone();
    let authorization: Value = storage::read(&native.direct.auth_file).unwrap();
    let token = authorization["principals"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == "desktop-owner")
        .unwrap()["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("ws://{}/", listener.local_addr().unwrap());
    let requests = Rc::new(RefCell::new(Vec::<Value>::new()));
    let dropped = Rc::new(RefCell::new(None::<Value>));
    let failed_outcome = Rc::new(RefCell::new(None::<Value>));
    let proxy_requests = requests.clone();
    let proxy_dropped = dropped.clone();
    let proxy_failed_outcome = failed_outcome.clone();
    let host = f.host.clone();
    let proxy_run = run.clone();
    let proxy_upstream = upstream.clone();
    let proxy_token = token.clone();
    let proxy = tokio::task::spawn_local(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let requests = proxy_requests.clone();
            let dropped = proxy_dropped.clone();
            let failed_outcome = proxy_failed_outcome.clone();
            let fault = fault.clone();
            let host = host.clone();
            let run = proxy_run.clone();
            let mut request = proxy_upstream.as_str().into_client_request().unwrap();
            request.headers_mut().insert(
                "authorization",
                format!("Bearer {}", proxy_token).parse().unwrap(),
            );
            connections.spawn_local(async move {
                    let mut downstream = tokio_tungstenite::accept_async(stream).await.unwrap();
                    let (mut upstream,_) = tokio_tungstenite::connect_async(request).await.unwrap();
                    let mut target = None;
                    let mut receipt_target = None;
                    loop {
                        tokio::select! {
                            message = downstream.next() => {
                                let Some(Ok(message)) = message else { break; };
                                if let Message::Text(text) = &message {
                                    let value: Value = serde_json::from_str(text).unwrap();
                                    if value["method"]==method {
                                        target=Some(value.clone());
                                        requests.borrow_mut().push(value);
                                    } else if value["method"]=="areal/request/read" {
                                        receipt_target=Some(value);
                                    }
                                }
                                if upstream.send(message).await.is_err() { break; }
                            }
                            message = upstream.next() => {
                                let Some(Ok(message)) = message else { break; };
                                if let Message::Text(text) = &message {
                                    let value: Value = serde_json::from_str(text).unwrap();
                                    if receipt_target.as_ref().is_some_and(|r|r["id"]==value["id"]) {
                                        storage::write(&run.join("core-receipt.json"),&json!({"request":receipt_target,"response":value})).unwrap();
                                    }
                                    if target.as_ref().is_some_and(|r|r["id"]==value["id"]) && value.get("result").is_some() && dropped.borrow().is_none() && failed_outcome.borrow().is_none() {
                                        let observation=json!({"request":target,"successResponse":value});
                                        match &fault {
                                            NativeReplyFault::DropSuccess => {
                                                storage::write(&run.join("dropped-success.json"),&observation).unwrap();
                                                *dropped.borrow_mut()=Some(observation);
                                                let _=downstream.close(None).await;
                                                let _=upstream.close(None).await;
                                                break;
                                            }
                                            NativeReplyFault::DenyOutcomeWrite(directory) => {
                                                let (_,snapshot)=host.journal.native_snapshot("project").unwrap();
                                                let operation=&observation["request"]["params"]["requestId"];
                                                let pending=snapshot["pending"].as_array().unwrap().iter().find(|row|&row["operationId"]==operation).unwrap();
                                                assert_eq!(pending["params"],observation["request"]["params"]);
                                                storage::write(&run.join("pending-before-outcome.json"),pending).unwrap();
                                                let record=directory.join(format!("{}.json",storage::digest(b"project")));
                                                std::fs::copy(record,run.join("journal-before-outcome.bin")).unwrap();
                                                storage::write(&run.join("outcome-write-success.json"),&observation).unwrap();
                                                std::fs::set_permissions(directory,std::fs::Permissions::from_mode(0o500)).unwrap();
                                                *failed_outcome.borrow_mut()=Some(observation);
                                            }
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
        .connect_test_core(f.host.clone(), "project", service.clone())
        .await
        .unwrap();
    NativeProxy {
        task: proxy,
        requests,
        dropped,
        failed_outcome,
    }
}

async fn stop_native(f: &mut Fixture, native: &mut NativeCore, proxy: NativeProxy) {
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
        assert!(
            child.0.try_wait().unwrap().is_some(),
            "owned process must settle and exit"
        );
    }
}

async fn run_native_creation_case() {
    let mut f = Fixture::new().await;
    (f.close)();
    f.server.abort();
    let mut native = start_native_core(&f).await;
    let proxy = attach_native_proxy(
        &mut f,
        &native,
        "areal/thread/start",
        NativeReplyFault::DropSuccess,
    )
    .await;
    let run = native.run.clone();
    let effect = native.effect.clone();
    let requests = proxy.requests.clone();
    let dropped = proxy.dropped.clone();
    let command = uuid::Uuid::new_v4().to_string();
    let request = f.request("session.create", json!({}), Some(&command));
    let (_, result) = Fixture::dispatch(f.session("a"), request.clone())
        .await
        .unwrap();
    let unknown = result.unwrap();
    storage::write(&run.join("original-unknown.json"), &unknown).unwrap();
    assert_eq!(unknown["commandId"], command);
    assert_eq!(unknown["admissionState"], "unknown");
    assert_eq!(unknown["submissionUnknown"], true);
    let observation = dropped
        .borrow()
        .clone()
        .expect("real upstream success must be dropped");
    let operation = observation["request"]["params"]["requestId"]
        .as_str()
        .unwrap();
    assert_eq!(unknown["operationId"], operation);
    assert_eq!(unknown["nativeRequestId"], operation);
    assert_eq!(requests.borrow().len(), 1);
    f.reconnect().await;
    let query = f.request("command.read", json!({"commandId":command}), None);
    let (_, result) = Fixture::dispatch(f.session("a"), query).await.unwrap();
    let recovered = result.unwrap();
    storage::write(&run.join("recovered.json"), &recovered).unwrap();
    assert_eq!(recovered["commandId"], command);
    assert_eq!(recovered["operationId"], operation);
    assert_eq!(recovered["admissionState"], "accepted");
    assert_eq!(recovered["nativeRequestId"], operation);
    let core_receipt: Value = storage::read(&run.join("core-receipt.json")).unwrap();
    assert_eq!(core_receipt["request"]["params"]["requestId"], operation);
    assert_eq!(
        core_receipt["response"]["result"]["data"][0]["requestId"],
        operation
    );
    assert_eq!(
        core_receipt["response"]["result"]["data"][0]["status"],
        "completed"
    );
    let thread = observation["successResponse"]["result"]["thread"]["id"]
        .as_str()
        .unwrap();
    assert_eq!(recovered["threadId"], thread);
    let (_, result) = Fixture::dispatch(f.session("a"), request).await.unwrap();
    assert_eq!(result.unwrap(), recovered);
    assert_eq!(
        requests.borrow().len(),
        1,
        "duplicate command must not reach Core create again"
    );
    let direct = native.direct.clone();
    let threads = areal_local_service::rpc(&direct, "thread/list", json!({"limit":100}))
        .await
        .unwrap();
    assert_eq!(threads["data"].as_array().unwrap().len(), 1);
    assert_eq!(threads["data"][0]["id"], thread);
    let turn=areal_local_service::rpc(&direct,"areal/turn/start",json!({"requestId":uuid::Uuid::new_v4().to_string(),"threadId":thread,"expectedConfigRevision":1,"input":[{"type":"text","text":"Append one marker"}]})).await.unwrap();
    let mut terminal = Value::Null;
    for _ in 0..1200 {
        let snapshot = areal_local_service::rpc(
            &direct,
            "thread/read",
            json!({"threadId":thread,"includeTurns":true}),
        )
        .await
        .unwrap();
        terminal = snapshot["thread"]["turns"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == turn["turn"]["id"])
            .cloned()
            .unwrap();
        if terminal["status"] != "inProgress" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    storage::write(&run.join("turn.json"), &terminal).unwrap();
    assert_eq!(terminal["status"], "completed");
    assert_eq!(std::fs::read_to_string(&effect).unwrap(), "x");
    stop_native(&mut f, &mut native, proxy).await;
    storage::write(&run.join("result.json"), &json!({"businessPassed":true,"cleanupPassed":true,"binary":native.binary,"corePid":native.core.0.id(),"modelPid":native.model.0.id(),"commandId":command,"operationId":operation,"threadId":thread,"forwardedCreateRequests":requests.borrow().clone(),"runtimeEffect":"x","boundary":"Host owner+journal test fixture and real Core/Runtime; subsequent normal Turn effect is separate from create; no Remote transport or independent Host crash"})).unwrap();
    println!("native fault evidence: {}", run.display());
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "real Core/Runtime; Host owner fixture only, no Remote wire or Main pending gate; requires AREAL_CORE_BIN and AREAL_NATIVE_FAULT_EVIDENCE"]
async fn native_interaction_lost_success_stays_unknown_without_replay() {
    tokio::task::LocalSet::new()
        .run_until(run_native_interaction_case())
        .await;
}

async fn run_native_interaction_case() {
    let mut f = Fixture::new().await;
    (f.close)();
    f.server.abort();
    let mut native = start_native_core(&f).await;
    let run = native.run.clone();
    let direct = native.direct.clone();
    let workspace = direct.identity.workspace.clone();
    let created = areal_local_service::rpc(
        &direct,
        "areal/thread/start",
        json!({
            "requestId":uuid::Uuid::new_v4().to_string(),"cwd":workspace,
            "agentProfile":{"id":"reviewed","revision":"v1"}
        }),
    )
    .await
    .unwrap();
    let thread = created["thread"]["id"].as_str().unwrap();
    let started = areal_local_service::rpc(&direct, "areal/turn/start", json!({
        "requestId":uuid::Uuid::new_v4().to_string(),"threadId":thread,
        "expectedConfigRevision":1,"input":[{"type":"text","text":"Append original marker after review"}]
    })).await.unwrap();
    let turn = started["turn"]["id"].as_str().unwrap();
    let mut original = Value::Null;
    for _ in 0..1200 {
        let listed = areal_local_service::rpc(
            &direct,
            "areal/interaction/list",
            json!({"threadId":thread}),
        )
        .await
        .unwrap();
        if let Some(item) = listed["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["turnId"] == turn && item["status"] == "pending")
        {
            original = item.clone();
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    storage::write(&run.join("original-pending.json"), &original).unwrap();
    assert_eq!(original["kind"], "approval");
    assert_eq!(original["tool"], "run_command");
    let target = json!({"threadId":thread,"turnId":turn,"interactionId":original["requestId"]});
    let proxy = attach_native_proxy(
        &mut f,
        &native,
        "areal/interaction/respond",
        NativeReplyFault::DropSuccess,
    )
    .await;
    let mut session = f.session("a");
    let mut review = session
        .request(&f.request("attention.read", target.clone(), None))
        .await
        .unwrap();
    while !review["nextCursor"].is_null() {
        let mut params = target.clone();
        params["cursor"] = review["nextCursor"].clone();
        review = session
            .request(&f.request("attention.read", params, None))
            .await
            .unwrap();
    }
    assert_eq!(review["complete"], true);
    let command = uuid::Uuid::new_v4().to_string();
    let mut params = target.clone();
    params["decision"] = json!("allowOnce");
    params["argumentsDigest"] = original["argumentsDigest"].clone();
    params["reviewToken"] = review["reviewToken"].clone();
    let mut request = f.request("interaction.respond", params, Some(&command));
    let unknown = session.request(&request).await.unwrap();
    storage::write(&run.join("original-unknown.json"), &unknown).unwrap();
    assert_eq!(unknown["admissionState"], "unknown");
    assert_eq!(unknown["submissionUnknown"], true);
    assert_eq!(unknown["commandId"], command);
    assert!(unknown.get("receipt").is_none());
    assert!(unknown.get("nativeRequestId").is_none());
    let dropped = proxy
        .dropped
        .borrow()
        .clone()
        .expect("the real upstream success must be dropped");
    assert_eq!(
        dropped["request"]["params"]["requestId"],
        original["requestId"]
    );
    assert_eq!(dropped["request"]["params"]["threadId"], thread);
    assert_eq!(dropped["request"]["params"]["turnId"], turn);
    assert!(dropped["successResponse"].get("result").is_some());
    assert_eq!(proxy.requests.borrow().len(), 1);
    f.reconnect().await;
    let mut observations = vec![];
    for _ in 0..3 {
        let value = f
            .session("a")
            .request(&f.request("command.read", json!({"commandId":command}), None))
            .await
            .unwrap();
        observations.push(value.clone());
        assert_eq!(value["commandId"], command);
        assert_eq!(value["operationId"], unknown["operationId"]);
        assert_eq!(value["admissionState"], "unknown");
        assert_eq!(value["observedState"]["status"], "answered");
        assert_eq!(value["observedState"]["provesCommandAdmission"], false);
        assert!(value.get("receipt").is_none());
    }
    request["params"]["reviewToken"] = json!("expired");
    let duplicate = f.session("a").request(&request).await.unwrap();
    assert_eq!(duplicate["admissionState"], "unknown");
    assert_eq!(duplicate["operationId"], unknown["operationId"]);
    assert!(duplicate.get("receipt").is_none());
    assert_eq!(
        proxy.requests.borrow().len(),
        1,
        "same original command must never dispatch a second Core answer"
    );
    assert_eq!(
        f.session("b")
            .request(&f.request("command.read", json!({"commandId":command}), None))
            .await
            .unwrap()["admissionState"],
        "notFound"
    );
    let terminal = wait_native_turn(&direct, thread, turn).await;
    storage::write(&run.join("original-terminal.json"), &terminal).unwrap();
    assert_eq!(terminal["status"], "completed");
    let writes: Vec<_> = terminal["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["tool"] == "run_command")
        .collect();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0]["callId"], original["callId"]);
    assert_eq!(writes[0]["execution"]["backend"], "runtime");
    assert_eq!(writes[0]["execution"]["outcome"], "succeeded");
    assert_eq!(std::fs::read_to_string(&native.effect).unwrap(), "x");
    let configured = areal_local_service::rpc(
        &direct,
        "areal/thread/configure",
        json!({
            "requestId":uuid::Uuid::new_v4().to_string(),"threadId":thread,"expectedRevision":1,
            "agentProfile":{"id":"ordinary","revision":"v1"}
        }),
    )
    .await
    .unwrap();
    let inspect =
        areal_local_service::rpc(&direct, "areal/thread/inspect", json!({"threadId":thread}))
            .await
            .unwrap();
    assert_eq!(inspect["configuration"]["revision"], 2);
    let later = areal_local_service::rpc(&direct,"areal/turn/start",json!({
        "requestId":uuid::Uuid::new_v4().to_string(),"threadId":thread,"expectedConfigRevision":2,
        "input":[{"type":"text","text":"Append later ordinary marker"}]
    })).await.unwrap();
    let later_turn = later["turn"]["id"].as_str().unwrap();
    assert_ne!(later_turn, turn);
    let later_terminal = wait_native_turn(&direct, thread, later_turn).await;
    assert_eq!(later_terminal["status"], "completed");
    assert_eq!(std::fs::read_to_string(&native.effect).unwrap(), "xx");
    let still_unknown = f
        .session("a")
        .request(&f.request("command.read", json!({"commandId":command}), None))
        .await
        .unwrap();
    assert_eq!(still_unknown["admissionState"], "unknown");
    assert_eq!(still_unknown["operationId"], unknown["operationId"]);
    assert!(still_unknown.get("receipt").is_none());
    assert_eq!(proxy.requests.borrow().len(), 1);
    f.grant("a", |grant| grant["capabilities"] = json!(["observe"]));
    assert_eq!(
        f.session("a")
            .request(&f.request("command.read", json!({"commandId":command}), None))
            .await
            .unwrap_err()
            .to_string(),
        "FORBIDDEN"
    );
    storage::write(&run.join("business.json"),&json!({
        "originalCase":"lost-response-no-receipt-no-replay-independent-observation",
        "commandId":command,"operationId":unknown["operationId"],"target":unknown["target"],
        "observations":observations,"duplicate":duplicate,"stillUnknown":still_unknown,
        "forwardedInteractionRequests":proxy.requests.borrow().clone(),
        "ordinaryConfigured":configured,"laterTerminal":later_terminal,
        "originalRuntimeEffect":"x","afterLaterTurnEffect":"xx",
        "remaining":"Main hasWork/pending and unknown ordinary submit rejection; Remote Noise transport and independent Host crash are not covered"
    })).unwrap();
    stop_native(&mut f, &mut native, proxy).await;
    storage::write(&run.join("result.json"),&json!({"businessPassed":true,"cleanupPassed":true,
        "binary":native.binary,"corePid":native.core.0.id(),"modelPid":native.model.0.id(),
        "boundary":"Host owner+journal fixture with real Core/Runtime; original interaction[7] finite fault and partial[12] Core ordinary operations; no Main gate or Remote wire"
    })).unwrap();
    println!("native interaction fault evidence: {}", run.display());
}

async fn wait_native_turn(service: &Service, thread: &str, turn: &str) -> Value {
    let mut terminal = Value::Null;
    for _ in 0..1200 {
        let snapshot = areal_local_service::rpc(
            service,
            "thread/read",
            json!({"threadId":thread,"includeTurns":true}),
        )
        .await
        .unwrap();
        terminal = snapshot["thread"]["turns"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == turn)
            .cloned()
            .unwrap();
        if terminal["status"] != "inProgress" {
            return terminal;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    terminal
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "real Core/Runtime; finite T19 Host owner fixture only, no Remote wire or 100-race gate; requires AREAL_CORE_BIN and AREAL_NATIVE_FAULT_EVIDENCE"]
async fn native_send_lost_success_recovers_original_turn_without_replay() {
    tokio::task::LocalSet::new()
        .run_until(run_native_send_case())
        .await;
}

async fn run_native_send_case() {
    let mut f = Fixture::new().await;
    (f.close)();
    f.server.abort();
    let mut native = start_native_core(&f).await;
    let run = native.run.clone();
    let direct = native.direct.clone();
    let created = areal_local_service::rpc(
        &direct,
        "areal/thread/start",
        json!({
            "requestId":uuid::Uuid::new_v4().to_string(),"cwd":direct.identity.workspace,
            "agentProfile":{"id":"ordinary","revision":"v1"}
        }),
    )
    .await
    .unwrap();
    let thread = created["thread"]["id"].as_str().unwrap();
    let proxy = attach_native_proxy(
        &mut f,
        &native,
        "areal/turn/start",
        NativeReplyFault::DropSuccess,
    )
    .await;
    let command = uuid::Uuid::new_v4().to_string();
    let params = json!({"threadId":thread,"expectedConfigRevision":1,"text":"Append the original send marker"});
    let request = f.request("session.send", params, Some(&command));
    let unknown = f.session("a").request(&request).await.unwrap();
    storage::write(&run.join("original-unknown.json"), &unknown).unwrap();
    assert_eq!(unknown["commandId"], command);
    assert_eq!(unknown["admissionState"], "unknown");
    assert_eq!(unknown["submissionUnknown"], true);
    assert!(unknown.get("receipt").is_none());
    let dropped = proxy
        .dropped
        .borrow()
        .clone()
        .expect("real upstream Turn success must be dropped");
    let operation = dropped["request"]["params"]["requestId"].as_str().unwrap();
    let turn = dropped["successResponse"]["result"]["turn"]["id"]
        .as_str()
        .unwrap();
    assert_eq!(unknown["operationId"], operation);
    assert_eq!(unknown["nativeRequestId"], operation);
    assert_eq!(dropped["request"]["params"]["threadId"], thread);
    assert_eq!(
        dropped["request"]["params"]["input"][0]["text"],
        request["params"]["text"]
    );
    assert_eq!(proxy.requests.borrow().len(), 1);
    let (_, pending_journal) = f.host.journal.native_snapshot("project").unwrap();
    let pending_record = pending_journal["pending"]
        .as_array()
        .unwrap()
        .iter()
        .find(|record| record["operationId"] == unknown["operationId"])
        .unwrap()
        .clone();
    storage::write(&run.join("original-pending-record.json"), &pending_record).unwrap();
    assert_eq!(pending_record["remote"]["commandId"], command);
    assert_eq!(pending_record["params"], dropped["request"]["params"]);
    f.reconnect().await;
    let recovered = f
        .session("a")
        .request(&f.request("command.read", json!({"commandId":command}), None))
        .await
        .unwrap();
    storage::write(&run.join("recovered.json"), &recovered).unwrap();
    assert_eq!(recovered["commandId"], command);
    assert_eq!(recovered["operationId"], operation);
    assert_eq!(recovered["nativeRequestId"], operation);
    assert_eq!(recovered["admissionState"], "accepted");
    assert_eq!(recovered["submissionUnknown"], false);
    assert_eq!(recovered["threadId"], thread);
    assert_eq!(recovered["turnId"], turn);
    let original_receipt: Value = storage::read(&run.join("core-receipt.json")).unwrap();
    assert_eq!(original_receipt["request"]["params"]["threadId"], thread);
    assert_eq!(
        original_receipt["request"]["params"]["requestId"],
        operation
    );
    let receipts = original_receipt["response"]["result"]["data"]
        .as_array()
        .unwrap();
    assert_eq!(receipts.len(), 1);
    let receipt = &receipts[0];
    assert_eq!(receipt["requestId"], operation);
    assert_eq!(receipt["method"], "areal/turn/start");
    assert_eq!(receipt["threadId"], thread);
    assert_eq!(receipt["status"], "completed");
    assert_eq!(receipt["operation"]["requestId"], operation);
    assert_eq!(receipt["operation"]["method"], "areal/turn/start");
    assert_eq!(
        receipt["operation"]["target"],
        json!({"kind":"thread","threadId":thread})
    );
    assert_eq!(receipt["result"]["turn"]["id"], turn);
    let (_, journal) = f.host.journal.native_snapshot("project").unwrap();
    let record = &journal["outcomes"][operation];
    assert_eq!(record["nativeDigest"], receipt["digest"]);
    assert_eq!(
        record["coreScope"]["storeBinding"]["identity"],
        receipt["identity"]
    );
    assert_eq!(record["remote"]["commandId"], command);
    let duplicate = f.session("a").request(&request).await.unwrap();
    assert_eq!(duplicate["operationId"], operation);
    assert_eq!(duplicate["turnId"], turn);
    assert_eq!(duplicate["admissionState"], "accepted");
    assert_eq!(
        proxy.requests.borrow().len(),
        1,
        "duplicate send must not forward a second Core Turn start"
    );
    let terminal = wait_native_turn(&direct, thread, turn).await;
    storage::write(&run.join("terminal.json"), &terminal).unwrap();
    assert_eq!(terminal["status"], "completed");
    let writes: Vec<_> = terminal["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["tool"] == "run_command")
        .collect();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0]["callId"], "native-effect");
    assert_eq!(writes[0]["execution"]["backend"], "runtime");
    assert_eq!(writes[0]["execution"]["outcome"], "succeeded");
    assert_eq!(std::fs::read_to_string(&native.effect).unwrap(), "x");
    let snapshot = areal_local_service::rpc(
        &direct,
        "thread/read",
        json!({"threadId":thread,"includeTurns":true}),
    )
    .await
    .unwrap();
    assert_eq!(snapshot["thread"]["turns"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["thread"]["turns"][0]["id"], turn);
    let mut changed = request;
    changed["params"]["text"] = json!("changed");
    assert_eq!(
        f.session("a")
            .request(&changed)
            .await
            .unwrap_err()
            .to_string(),
        "COMMAND_CONFLICT"
    );
    assert_eq!(proxy.requests.borrow().len(), 1);
    storage::write(&run.join("business.json"),&json!({
        "originalCase":"T19 lost session.send reply",
        "commandId":command,"operationId":operation,"threadId":thread,"turnId":turn,
        "duplicate":duplicate,"originalPendingRecord":pending_record,"journalRecord":record,"forwardedTurnStartRequests":proxy.requests.borrow().clone(),
        "runtimeEffect":"x","changedSemantics":"COMMAND_CONFLICT"
    })).unwrap();
    stop_native(&mut f, &mut native, proxy).await;
    storage::write(&run.join("result.json"),&json!({
        "businessPassed":true,"cleanupPassed":true,"binary":native.binary,"corePid":native.core.0.id(),"modelPid":native.model.0.id(),
        "boundary":"finite T19 Host owner+journal fixture with real Core/Runtime; no Remote Noise wire, independent Host process crash or 100-race gate"
    })).unwrap();
    println!("native send fault evidence: {}", run.display());
}
