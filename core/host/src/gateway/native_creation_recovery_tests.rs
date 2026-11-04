use super::*;
use std::{
    cell::RefCell,
    path::PathBuf,
    process::{Child, Command, Stdio},
};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

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

async fn run_native_creation_case() {
    let binary = PathBuf::from(std::env::var("AREAL_CORE_BIN").unwrap());
    let evidence = PathBuf::from(std::env::var("AREAL_NATIVE_FAULT_EVIDENCE").unwrap());
    std::fs::create_dir_all(&evidence).unwrap();
    let run = evidence.join(uuid::Uuid::new_v4().to_string());
    storage::private_dir(&run).unwrap();
    let mut f = Fixture::new().await;
    (f.close)();
    f.server.abort();
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
 const tool=!naming && !body.messages.some(m=>m.role==='tool');
 const delta=tool ? {{tool_calls:[{{index:0,id:'native-effect',type:'function',function:{{name:'run_command',arguments:JSON.stringify({{command:{command}}})}}}}]}} : {{content:'Native fixture complete'}};
 res.writeHead(200,{{'content-type':'text/event-stream'}});
 res.end('data: '+JSON.stringify({{choices:[{{index:0,delta,finish_reason:tool?'tool_calls':'stop'}}]}})+'\n\ndata: [DONE]\n\n');
}});
server.listen(0,'127.0.0.1',()=>writeFileSync({ready},String(server.address().port)));
"#,
        command = serde_json::to_string(&format!("printf x >> '{}'", effect.display())).unwrap(),
        ready = serde_json::to_string(&model_ready).unwrap()
    );
    let mut model = OwnedChild(
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
    let core_log = std::fs::File::create(run.join("core.log")).unwrap();
    let mut core = OwnedChild(
        Command::new(&binary)
            .arg("app-server")
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
    let authorization: Value = storage::read(&auth).unwrap();
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
    let proxy_requests = requests.clone();
    let proxy_dropped = dropped.clone();
    let proxy_run = run.clone();
    let proxy_upstream = upstream.clone();
    let proxy_token = token.clone();
    let proxy = tokio::task::spawn_local(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let requests = proxy_requests.clone();
            let dropped = proxy_dropped.clone();
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
                                    if value["method"]=="areal/thread/start" {
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
                                    if target.as_ref().is_some_and(|r|r["id"]==value["id"]) && value.get("result").is_some() && dropped.borrow().is_none() {
                                        let observation=json!({"request":target,"successResponse":value});
                                        storage::write(&run.join("dropped-success.json"),&observation).unwrap();
                                        *dropped.borrow_mut()=Some(observation);
                                        let _=downstream.close(None).await;
                                        let _=upstream.close(None).await;
                                        break;
                                    }
                                }
                                if downstream.send(message).await.is_err() { break; }
                            }
                        }
                    }
                });
        }
    });
    let mut service = f.host.slots.borrow()["project"].service.clone().unwrap();
    service.endpoint = endpoint;
    service.auth_file = auth;
    service.core_pid = core.0.id();
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
    let mut direct = service.clone();
    direct.endpoint = upstream;
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
    (f.close)();
    proxy.abort();
    let _ = proxy.await;
    for child in [&mut core, &mut model] {
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
    storage::write(&run.join("result.json"),&json!({"businessPassed":true,"cleanupPassed":true,"binary":binary,"corePid":core.0.id(),"modelPid":model.0.id(),"commandId":command,"operationId":operation,"threadId":thread,"forwardedCreateRequests":requests.borrow().clone(),"runtimeEffect":"x","boundary":"Host owner+journal test fixture and real Core/Runtime; subsequent normal Turn effect is separate from create; no Remote transport or independent Host crash"})).unwrap();
    println!("native fault evidence: {}", run.display());
}
