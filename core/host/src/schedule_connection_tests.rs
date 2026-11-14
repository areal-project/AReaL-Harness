struct ScheduleHeaders;
impl tokio_tungstenite::tungstenite::handshake::server::Callback for ScheduleHeaders {
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
            "Bearer fixture-owner-token"
        );
        Ok(response)
    }
}

use super::*;
use tokio::net::TcpListener;
use tokio_tungstenite::WebSocketStream;

async fn receive(socket: &mut WebSocketStream<tokio::net::TcpStream>) -> Value {
    loop {
        if let Message::Text(text) = socket.next().await.unwrap().unwrap() {
            let value: Value = serde_json::from_str(&text).unwrap();
            if value["method"] != "initialized" {
                return value;
            }
        }
    }
}
async fn send(socket: &mut WebSocketStream<tokio::net::TcpStream>, value: Value) {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}
fn service(host: &Host, endpoint: String) -> Service {
    let registration = host.slots.borrow()["project"].registration.clone();
    let service = Service {
        identity: areal_protocol::service::Identity {
            protocol_version: 1,
            service_id: "fixture".into(),
            generation: "first".into(),
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
    storage::write(&service.auth_file, &json!({"principals":[{"id":"observer","token":"wrong-token"},{"id":"desktop-owner","token":"fixture-owner-token"}]})).unwrap();
    let mut slots = host.slots.borrow_mut();
    let slot = slots.get_mut("project").unwrap();
    slot.service = Some(service.clone());
    slot.state = "ready".into();
    service
}

#[tokio::test(flavor = "current_thread")]
async fn turn_completed_wakes_original_lifecycle_receipt_without_redispatch() {
    lifecycle_completion(false, false).await;
}

#[tokio::test(flavor = "current_thread")]
async fn terminal_only_in_replacement_snapshot_settles_original_lifecycle_without_redispatch() {
    lifecycle_completion(true, false).await;
}

#[tokio::test(flavor = "current_thread")]
async fn library_write_failure_preserves_authoritative_snapshot_and_hints_terminal_once() {
    lifecycle_completion(true, true).await;
}

async fn lifecycle_completion(snapshot_only: bool, library_failure: bool) {
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let mut base = super::super::schedules::tests::fixture(root.path());
        Rc::get_mut(&mut base.migration).unwrap().vault = crate::vault::Vault::isolated_files(&base.home);
        let source = crate::migration::Source { profile:root.path().join("profile"),core_home:root.path().join("core"),legacy_service_home:root.path().join("legacy") };
        storage::private_dir(&source.profile).unwrap();
        storage::private_dir(&source.core_home).unwrap();
        storage::write(&source.core_home.join("projects.json"),&json!([])).unwrap();
        base.migration.attach(source.clone(),"fixture",None).unwrap();
        let imported = base.migration.import(serde_json::from_value(json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":base.identity.generation,"source":source})).unwrap(),"fixture",&[],&base.journal).unwrap();
        assert_eq!(imported["kind"],"ready");
        let source_id = base.migration.source(source,&[]).unwrap()["sourceId"].as_str().unwrap().to_owned();
        let registration = base.slots.borrow()["project"].registration.clone();
        let alias = base.migration.remote_bindings(&source_id,&[registration]).unwrap().remove(0).1;
        let host = Rc::new(base);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let service = service(&host,format!("ws://{}/",listener.local_addr().unwrap()));
        let dispatches = Rc::new(Cell::new(0));
        let count = dispatches.clone();
        let (release, released) = oneshot::channel::<()>();
        let (snapshot_ready, snapshot_due) = oneshot::channel::<()>();
        let server = tokio::task::spawn_local(async move {
            let (stream,_) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_hdr_async(stream,ScheduleHeaders).await.unwrap();
            let mut released = Box::pin(released);
            let mut reads = 0;
            let mut subscribed = false;
            let mut snapshot_ready = Some(snapshot_ready);
            loop {
                let call = tokio::select! {
                    _ = released.as_mut() => break,
                    call = receive(&mut socket) => call,
                };
                match call["method"].as_str().unwrap() {
                    "initialize" => send(&mut socket,json!({"id":call["id"],"result":{}})).await,
                    "areal/capabilities" => send(&mut socket,json!({"id":call["id"],"result":{"features":{"conversationObservation":true}}})).await,
                    "areal/thread/observe" => {
                        assert_eq!(call["params"]["threadId"],"thread");
                        assert_eq!(call["params"]["mode"],"conversation");
                        assert_eq!(call["params"]["maxBytes"],64*1024);
                        subscribed = true;
                        let status = if reads < 2 { "inProgress" } else { "interrupted" };
                        send(&mut socket,json!({"id":call["id"],"result":{"thread":{"id":"thread","turns":[{"id":"turn","status":status}]}}})).await;
                    }
                    "turn/interrupt" => {
                        assert!(subscribed, "停止派发前必须建立原线程观察");
                        count.set(count.get()+1);
                        assert_eq!(call["params"],json!({"threadId":"thread","turnId":"turn"}));
                        send(&mut socket,json!({"id":call["id"],"result":{}})).await;
                    }
                    "thread/read" => {
                        if call["params"]["includeTurns"] == false {
                            send(&mut socket,json!({"id":call["id"],"result":{"thread":{"id":"thread"}}})).await;
                            continue;
                        }
                        reads += 1;
                        let status = if reads < 3 { "inProgress" } else { "interrupted" };
                        send(&mut socket,json!({"id":call["id"],"result":{"thread":{"id":"thread","turns":[{"id":"turn","status":status}]}}})).await;
                        if reads == 2 && subscribed {
                            // 原命令的首次结算仍在执行；终态通知只负责唤醒下一次权威读。
                            if snapshot_only {
                                snapshot_ready.take().unwrap().send(()).unwrap();
                            } else {
                            send(&mut socket,json!({"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","status":"interrupted"}}})).await;
                            }
                        }
                    }
                    "areal/subscription/remove" => send(&mut socket,json!({"id":call["id"],"result":{"subscriptionCount":0}})).await,
                    method => panic!("unexpected Core method {method}"),
                }
            }
        });
        let session = connect(host.clone(),"project",service).await.unwrap();
        session.ready.set(true);
        host.schedules.connections.sessions.borrow_mut().insert("project".into(),session.clone());
        let snapshot_session = session.clone();
        let refresh = tokio::task::spawn_local(async move {
            if snapshot_only {
                snapshot_due.await.unwrap();
                snapshot_session.request("areal/thread/observe", json!({"threadId":"thread","mode":"conversation","maxBytes":65536})).await.unwrap();
            }
        });
        if snapshot_only {
            host.gateway.workbench.test_source(&source_id);
            let completion = |thread: &str, turn: &str, status: &str| json!({"thread":{"id":thread,"turns":[{"id":turn,"status":status}]}});
            let initial = super::super::library_store::read_source(&host, &source_id).unwrap();
            session.snapshot_progress(&host, "history", &completion("history", "past", "completed"), None).unwrap();
            assert_eq!(super::super::library_store::read_source(&host, &source_id).unwrap(), initial, "首读历史终态不能标未读");
            session.snapshot_progress(&host, "guarded", &completion("guarded", "guard-turn", "inProgress"), None).unwrap();
            assert!(session.snapshot_progress(&host, "guarded", &completion("other-thread", "guard-turn", "completed"), None).is_err());
            let original = host.slots.borrow_mut().get_mut("project").unwrap().service.as_mut().unwrap().identity.generation.clone();
            host.slots.borrow_mut().get_mut("project").unwrap().service.as_mut().unwrap().identity.generation = "stale".into();
            assert!(session.snapshot_progress(&host, "guarded", &completion("guarded", "guard-turn", "completed"), None).is_err());
            host.slots.borrow_mut().get_mut("project").unwrap().service.as_mut().unwrap().identity.generation = original;
            host.schedules.connections.sessions.borrow_mut().remove("project");
            assert!(session.snapshot_progress(&host, "guarded", &completion("guarded", "guard-turn", "completed"), None).is_err(), "非当前session owner不能写资料库");
            host.schedules.connections.sessions.borrow_mut().insert("project".into(),session.clone());
            *session.workbench_lease.borrow_mut() = Some("replacement-lease".into());
            assert!(session.snapshot_progress(&host, "guarded", &completion("guarded", "guard-turn", "completed"), None).is_err(), "原租约过期响应不能先写投影");
            session.workbench_lease.borrow_mut().take();
            host.gateway.workbench.test_source("unbound-source");
            assert!(session.snapshot_progress(&host, "guarded", &completion("guarded", "guard-turn", "completed"), None).is_err(), "未知source不能写当前资料库");
            host.gateway.workbench.test_source(&source_id);
            assert_eq!(super::super::library_store::read_source(&host, &source_id).unwrap(), initial);
            session.observed_progress.borrow_mut().remove("guarded");
        }
        let library_path = super::super::library_store::source_home(&host,&source_id).unwrap().join("library.json");
        if library_failure { std::fs::create_dir(&library_path).unwrap(); }
        let changes = host.changes.subscribe();
        publish_event(&host,&session,json!({"method":"item/agentMessage/delta","params":{"threadId":"thread","delta":"text"}}));
        assert!(!changes.has_changed().unwrap(),"流delta不唤醒Host全局观察");
        let before_catalog = host.schedules.connections.model_catalog_revision(&host, "project").unwrap();
        publish_event(&host, &session, json!({"method":"areal/model/catalogChanged","params":{"revision":1}}));
        assert_ne!(host.schedules.connections.model_catalog_revision(&host, "project").unwrap(), before_catalog);
        assert!(changes.has_changed().unwrap(), "模型目录变化唤醒共享观察者");
        let original_generation = host.slots.borrow()["project"].service.as_ref().unwrap().identity.generation.clone();
        host.slots.borrow_mut().get_mut("project").unwrap().service.as_mut().unwrap().identity.generation = "replacement".into();
        let current_revision = session.model_revision.get();
        publish_event(&host, &session, json!({"method":"areal/model/catalogChanged","params":{"revision":2}}));
        assert_eq!(session.model_revision.get(), current_revision, "旧代事件不能推进目录版本");
        host.slots.borrow_mut().get_mut("project").unwrap().service.as_mut().unwrap().identity.generation = original_generation;
        let snapshot = super::super::workbench_lifecycle::read_request(&host,&source_id,"snapshot",&json!({"ownerNonce":uuid::Uuid::new_v4().to_string()})).await.unwrap();
        let request = uuid::Uuid::new_v4().to_string();
        let result = super::super::workbench_lifecycle::command(&host,&source_id,json!({"requestId":request,"kind":"interruptTurn","mode":"cancel","expectedDesktopGeneration":snapshot["desktopGeneration"],"expectedTargets":[{"projectId":alias,"serviceId":"fixture","generation":"first"}],"threadId":"thread","turnId":"turn"})).await.unwrap();
        assert_eq!(result["requestId"],request);
        assert_eq!(result["phase"],"completed");
        assert_eq!(result["targets"][0]["phase"],"completed");
        assert_eq!(dispatches.get(),1);
        if snapshot_only {
            if library_failure {
                let changes = host.changes.subscribe();
                let result = session.request("areal/thread/observe",json!({"threadId":"thread","mode":"conversation","maxBytes":65536})).await.unwrap();
                assert_eq!(result["thread"]["turns"][0]["status"],"interrupted", "库写失败不能封死权威读取");
                assert!(!changes.has_changed().unwrap(), "相同终态在库仍失败时不能重复触发失效");
                assert!(session.observed_progress.borrow()["thread"].terminal_hinted);
                std::fs::remove_dir(&library_path).unwrap();
                session.request("areal/thread/observe",json!({"threadId":"thread","mode":"conversation","maxBytes":65536})).await.unwrap();
                assert!(changes.has_changed().unwrap(), "库恢复后原completion可补写");
            }
            let key = format!("{alias}:thread");
            let library = super::super::library_store::read_source(&host,&source_id).unwrap();
            assert_eq!(library["threads"][&key]["completionId"],"turn");
            assert_eq!(library["threads"][&key]["unread"],true);
            super::super::library_store::change(&host,&source_id,|state| { state["threads"][&key]["unread"] = json!(false); Ok(()) }).unwrap();
            session.snapshot_progress(&host,"thread",&json!({"thread":{"id":"thread","turns":[{"id":"turn","status":"interrupted"}]}}), None).unwrap();
            assert_eq!(super::super::library_store::read_source(&host,&source_id).unwrap()["threads"][&key]["unread"],false,"重复终态不覆盖已读");
            assert!(session.observed_progress.borrow().is_empty(),"终态清除可重建进度");
            publish_event(&host,&session,json!({"method":"turn/started","params":{"threadId":"event-thread","turn":{"id":"event-turn","status":"inProgress"}}}));
            let mut completed_events = session.events.subscribe();
            session.snapshot_progress(&host,"event-thread",&json!({"thread":{"id":"event-thread","turns":[{"id":"event-turn","status":"completed"}]}}), None).unwrap();
            assert_eq!(super::super::library_store::read_source(&host,&source_id).unwrap()["threads"][format!("{alias}:event-thread")]["completionId"], "event-turn", "已见开始事件也能由终态快照补齐");
            assert!(session.observed_progress.borrow().is_empty());
            let completed = completed_events.try_recv().expect("替换快照中的终态必须同步给共享投影");
            assert_eq!(completed.value["method"], "turn/completed");
            assert_eq!(completed.value["params"]["turn"]["id"], "event-turn");
            assert_eq!(completed.value["params"]["turn"]["status"], "completed");
            assert!(completed.sequence > 0);
            session.snapshot_progress(&host,"event-thread",&json!({"thread":{"id":"event-thread","turns":[{"id":"event-turn","status":"completed"}]}}), None).unwrap();
            assert!(completed_events.try_recv().is_err(), "重复快照不重复广播终态");
        }
        let stored = super::super::workbench_lifecycle::read_request(&host,&source_id,"read",&json!({"requestId":request})).await.unwrap();
        assert_eq!(stored["phase"],"completed");
        assert_eq!(stored["requestId"],request);
        refresh.await.unwrap();
        release.send(()).unwrap();
        server.await.unwrap();
        session.close();
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn host_release_before_workbench_thread_start_receipt_preserves_subscription() {
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let host = Rc::new(super::super::schedules::tests::fixture(root.path()));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let service = service(&host, format!("ws://{}/", listener.local_addr().unwrap()));
        {
            let mut slots = host.slots.borrow_mut();
            let slot = slots.get_mut("project").unwrap();
            let (writer, lifetime) = areal_local_service::OwnerLifetime::pair().unwrap();
            slot.writer = Some(writer);
            slot.lifetime = Some(Rc::new(lifetime));
        }
        let server = tokio::task::spawn_local(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_hdr_async(stream, ScheduleHeaders).await.unwrap();
            let mut subscribed = false;
            let mut creation = None;
            while let Some(Ok(Message::Text(text))) = socket.next().await {
                let call: Value = serde_json::from_str(&text).unwrap();
                if call.get("id").is_none() { continue; }
                match call["method"].as_str().unwrap() {
                    "initialize" | "areal/capabilities" => send(&mut socket, json!({"id":call["id"],"result":{}})).await,
                    "thread/start" => {
                        subscribed = true;
                        creation = Some(call["id"].clone());
                        send(&mut socket, json!({"method":"thread/started","params":{"thread":{"id":"created"}}})).await;
                    }
                    "areal/thread/observe" => {
                        subscribed = true;
                        send(&mut socket, json!({"id":call["id"],"result":{"thread":{"id":"created","turns":[]}}})).await;
                    }
                    "areal/subscription/remove" => {
                        if call["params"]["threadIds"].as_array().unwrap().iter().any(|id| id == "created") { subscribed = false; }
                        send(&mut socket, json!({"id":call["id"],"result":{"subscriptionCount":usize::from(subscribed)}})).await;
                    }
                    "areal/server/status" => {
                        send(&mut socket, json!({"id":call["id"],"result":{"subscribed":subscribed}})).await;
                        if let Some(id) = creation.take() { send(&mut socket, json!({"id":id,"result":{"thread":{"id":"created"}}})).await; }
                        if subscribed { send(&mut socket, json!({"method":"item/agentMessage/delta","params":{"threadId":"created","delta":"original"}})).await; }
                    }
                    other => panic!("unexpected request {other}"),
                }
            }
        });
        let session = connect(host.clone(), "project", service).await.unwrap();
        session.ready.set(true);
        host.schedules.connections.sessions.borrow_mut().insert("project".into(), session.clone());
        let attached = host.schedules.connections.workbench_attach(&host, "project", None).await.unwrap();
        let lease = attached["lease"].as_str().unwrap().to_owned();
        let mut events = session.events.subscribe();
        let request_host = host.clone();
        let request_lease = lease.clone();
        let creation = tokio::task::spawn_local(async move {
            request_host.schedules.connections.workbench_request(&request_host, "project", &request_lease, "thread/start", json!({})).await.unwrap()
        });
        loop { if events.recv().await.unwrap().value["method"] == "thread/started" { break; } }
        let (_, _, observation) = host.schedules.connections.remote_observe(&host, "project", "first", "created").await.unwrap();
        drop(observation);
        session.request("areal/server/status", json!({})).await.unwrap();
        assert_eq!(creation.await.unwrap()["result"]["thread"]["id"], "created");
        let mut events = session.events.subscribe();
        let status = host.schedules.connections.workbench_request(&host, "project", &lease, "areal/server/status", json!({})).await.unwrap();
        assert_eq!(status["result"]["subscribed"], true, "Host release before creation receipt must not remove the new Workbench subscription");
        loop { if events.recv().await.unwrap().value["method"] == "item/agentMessage/delta" { break; } }
        host.schedules.connections.workbench_detach(&host, "project", &lease).unwrap();
        assert_eq!(session.request("areal/server/status", json!({})).await.unwrap()["subscribed"], false);
        let replacement = host.schedules.connections.workbench_attach(&host, "project", None).await.unwrap();
        let replacement_lease = replacement["lease"].as_str().unwrap().to_owned();
        let request_host = host.clone();
        let creation = tokio::task::spawn_local(async move {
            request_host.schedules.connections.workbench_request(&request_host, "project", &replacement_lease, "thread/start", json!({})).await
        });
        loop { if events.recv().await.unwrap().value["method"] == "thread/started" { break; } }
        let (_, _, observation) = host.schedules.connections.remote_observe(&host, "project", "first", "created").await.unwrap();
        drop(observation);
        creation.abort();
        assert!(creation.await.unwrap_err().is_cancelled());
        assert_eq!(session.request("areal/server/status", json!({})).await.unwrap()["subscribed"], false, "cancelled creation flushes deferred removal");
        session.close();
        server.await.unwrap();
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn shared_thread_subscription_survives_each_owner_release() {
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let host = Rc::new(super::super::schedules::tests::fixture(root.path()));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let service = service(&host, format!("ws://{}/", listener.local_addr().unwrap()));
        {
            let mut slots = host.slots.borrow_mut();
            let slot = slots.get_mut("project").unwrap();
            let (writer, lifetime) = areal_local_service::OwnerLifetime::pair().unwrap();
            slot.writer = Some(writer);
            slot.lifetime = Some(Rc::new(lifetime));
        }
        let server = tokio::task::spawn_local(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_hdr_async(stream, ScheduleHeaders).await.unwrap();
            let mut subscribed = false;
            while let Some(Ok(Message::Text(text))) = socket.next().await {
                let call: Value = serde_json::from_str(&text).unwrap();
                if call.get("id").is_none() { continue; }
                if call["method"] == "areal/thread/observe" && call["params"]["maxBytes"] == 0 {
                    send(&mut socket, json!({"id":call["id"],"error":{"code":-32602,"message":"invalid maxBytes"}})).await;
                    continue;
                }
                let result = match call["method"].as_str().unwrap() {
                    "initialize" | "areal/capabilities" => json!({}),
                    "areal/thread/observe" | "thread/resume" => { subscribed = true; json!({"thread":{"id":"thread","turns":[]}}) },
                    "areal/subscription/remove" => { if call["params"]["threadIds"].as_array().unwrap().iter().any(|id| id == "thread") { subscribed = false; } json!({"subscriptionCount":usize::from(subscribed)}) },
                    "areal/server/status" => json!({"subscribed":subscribed}),
                    other => panic!("unexpected request {other}"),
                };
                send(&mut socket, json!({"id":call["id"],"result":result})).await;
                if call["method"] == "areal/server/status" && subscribed {
                    send(&mut socket, json!({"method":"item/agentMessage/delta","params":{"threadId":"thread","delta":"original"}})).await;
                }
            }
        });
        let session = connect(host.clone(), "project", service).await.unwrap();
        session.ready.set(true);
        let connections = &host.schedules.connections;
        connections.sessions.borrow_mut().insert("project".into(), session.clone());
        let attached = connections.workbench_attach(&host, "project", None).await.unwrap();
        let lease = attached["lease"].as_str().unwrap();
        let (_, _, observation) = connections.remote_observe(&host, "project", "first", "thread").await.unwrap();
        let rejected = connections.workbench_request(&host, "project", lease, "areal/thread/observe", json!({"threadId":"thread","mode":"bounded","maxBytes":0})).await.unwrap();
        assert_eq!(rejected["error"]["code"], -32602);
        drop(observation);
        let status = connections.workbench_request(&host, "project", lease, "areal/server/status", json!({})).await.unwrap();
        assert_eq!(status["result"]["subscribed"], false, "rejected new claim cannot retain subscription");
        connections.workbench_request(&host, "project", lease, "thread/resume", json!({"threadId":"thread"})).await.unwrap();
        let rejected = connections.workbench_request(&host, "project", lease, "areal/thread/observe", json!({"threadId":"thread","mode":"bounded","maxBytes":0})).await.unwrap();
        assert_eq!(rejected["error"]["code"], -32602);
        let (_, _, observation) = connections.remote_observe(&host, "project", "first", "thread").await.unwrap();
        let mut workbench_events = session.events.subscribe();
        drop(observation);
        let status = connections.workbench_request(&host, "project", lease, "areal/server/status", json!({})).await.unwrap();
        assert_eq!(status["result"]["subscribed"], true, "Host release must retain Workbench subscription");
        loop { let event = workbench_events.recv().await.unwrap().value; if event["method"] == "item/agentMessage/delta" { assert_eq!(event["params"]["threadId"], "thread"); break; } }
        let (_, _, mut observation) = connections.remote_observe(&host, "project", "first", "thread").await.unwrap();
        connections.workbench_request(&host, "project", lease, "areal/subscription/remove", json!({"threadIds":["thread"]})).await.unwrap();
        let status = connections.workbench_request(&host, "project", lease, "areal/server/status", json!({})).await.unwrap();
        assert_eq!(status["result"]["subscribed"], true, "Workbench release must retain Host subscription");
        loop { if observation.events.recv().await.unwrap().value["method"] == "item/agentMessage/delta" { break; } }
        drop(observation);
        let status = connections.workbench_request(&host, "project", lease, "areal/server/status", json!({})).await.unwrap();
        assert_eq!(status["result"]["subscribed"], false, "last owner releases Core subscription");
        let replacement = connections.workbench_attach(&host, "project", None).await.unwrap();
        let replacement_lease = replacement["lease"].as_str().unwrap();
        assert_eq!(replacement["connectionId"], attached["connectionId"]);
        assert_eq!(replacement["coreGeneration"], attached["coreGeneration"]);
        connections.workbench_request(&host, "project", replacement_lease, "areal/thread/observe", json!({"threadId":"thread"})).await.unwrap();
        assert_eq!(connections.workbench_detach(&host, "project", lease).unwrap()["closed"], false);
        assert!(connections.workbench_request(&host, "project", lease, "areal/subscription/remove", json!({"threadIds":["thread"]})).await.is_err());
        let status = connections.workbench_request(&host, "project", replacement_lease, "areal/server/status", json!({})).await.unwrap();
        assert_eq!(status["result"]["subscribed"], true, "old lease cannot release replacement owner");
        connections.workbench_detach(&host, "project", replacement_lease).unwrap();
        assert_eq!(session.request("areal/server/status", json!({})).await.unwrap()["subscribed"], false);
        session.close();
        server.await.unwrap();
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn repeated_ready_activation_preserves_original_workbench_connection() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let host = Rc::new(super::super::schedules::tests::fixture(root.path()));
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let service = service(&host, format!("ws://{}/", listener.local_addr().unwrap()));
            {
                let mut slots = host.slots.borrow_mut();
                let slot = slots.get_mut("project").unwrap();
                let (writer, lifetime) = areal_local_service::OwnerLifetime::pair().unwrap();
                slot.writer = Some(writer);
                slot.lifetime = Some(Rc::new(lifetime));
            }
            let server = tokio::task::spawn_local(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_hdr_async(stream, ScheduleHeaders)
                    .await
                    .unwrap();
                while let Some(Ok(Message::Text(text))) = socket.next().await {
                    let request: Value = serde_json::from_str(&text).unwrap();
                    if request.get("id").is_none() {
                        continue;
                    }
                    let result = match request["method"].as_str().unwrap() {
                        "initialize" | "areal/capabilities" => json!({}),
                        "areal/server/status" => json!({"acceptingWork":true}),
                        other => panic!("unexpected request {other}"),
                    };
                    send(&mut socket, json!({"id":request["id"],"result":result})).await;
                }
            });
            let session = connect(host.clone(), "project", service.clone())
                .await
                .unwrap();
            session.ready.set(true);
            host.schedules
                .connections
                .sessions
                .borrow_mut()
                .insert("project".into(), session.clone());
            let attached = host
                .schedules
                .connections
                .workbench_attach(&host, "project", None)
                .await
                .unwrap();
            let lease = attached["lease"].as_str().unwrap();
            let original = host
                .schedules
                .connections
                .shared_identity(&host, "project")
                .unwrap();
            let mut changed = host.changes.subscribe();
            host.begin_project_activation(
                "project",
                &service.identity.config_fingerprint,
                Some(&service),
            );
            changed.changed().await.unwrap();
            assert_eq!(
                host.schedules
                    .connections
                    .shared_identity(&host, "project")
                    .unwrap(),
                original
            );
            assert_eq!(attached["connectionId"], original.2);
            let result = host
                .schedules
                .connections
                .workbench_request(&host, "project", lease, "areal/server/status", json!({}))
                .await
                .unwrap();
            assert_eq!(result["result"]["acceptingWork"], true);
            host.begin_project_activation("project", "changed-fingerprint", Some(&service));
            assert!(
                host.schedules
                    .connections
                    .shared_identity(&host, "project")
                    .is_err()
            );
            assert!(
                host.schedules
                    .connections
                    .workbench_request(&host, "project", lease, "areal/server/status", json!({}))
                    .await
                    .is_err()
            );
            session.close();
            server.await.unwrap();
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn workbench_attach_waits_for_original_project_startup_before_leasing_shared_socket() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let host = Rc::new(super::super::schedules::tests::fixture(root.path()));
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let service = service(&host, format!("ws://{}/", listener.local_addr().unwrap()));
            let server = tokio::task::spawn_local(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_hdr_async(stream, ScheduleHeaders)
                    .await
                    .unwrap();
                let initialize = receive(&mut socket).await;
                send(&mut socket, json!({"id":initialize["id"],"result":{}})).await;
                let capabilities = receive(&mut socket).await;
                assert_eq!(capabilities["method"], "areal/capabilities");
                send(&mut socket, json!({"id":capabilities["id"],"result":{}})).await;
                while let Some(message) = socket.next().await {
                    if message.is_err() {
                        break;
                    }
                }
            });
            let primary = connect(host.clone(), "project", service).await.unwrap();
            primary.ready.set(true);
            host.schedules
                .connections
                .sessions
                .borrow_mut()
                .insert("project".into(), primary.clone());
            let gate = host.gate("project").unwrap();
            let startup = gate.write().await;
            {
                let mut slots = host.slots.borrow_mut();
                let slot = slots.get_mut("project").unwrap();
                let (writer, lifetime) = areal_local_service::OwnerLifetime::pair().unwrap();
                slot.writer = Some(writer);
                slot.lifetime = Some(Rc::new(lifetime));
                slot.state = "starting".into();
            }
            let attach = host
                .schedules
                .connections
                .workbench_attach(&host, "project", None);
            tokio::pin!(attach);
            assert!(
                futures_util::poll!(attach.as_mut()).is_pending(),
                "启动未结算前不能发出失败或授予租约"
            );
            assert!(primary.workbench_lease.borrow().is_none());
            host.slots.borrow_mut().get_mut("project").unwrap().state = "ready".into();
            drop(startup);
            let attached = attach.await.unwrap();
            assert_eq!(attached["connectionId"], primary.connection_id);
            assert_eq!(
                attached["coreGeneration"],
                primary.service.identity.generation
            );
            assert!(attached["lease"].is_string());
            primary.close();
            server.await.unwrap();
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn terminal_detach_closes_only_its_original_core_socket() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let host = Rc::new(super::super::schedules::tests::fixture(root.path()));
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let service = service(&host, format!("ws://{}/", listener.local_addr().unwrap()));
            let server = tokio::task::spawn_local(async move {
                let mut sockets = Vec::new();
                for _ in 0..2 {
                    let (stream, _) = listener.accept().await.unwrap();
                    let mut socket = tokio_tungstenite::accept_hdr_async(stream, ScheduleHeaders)
                        .await
                        .unwrap();
                    let initialize = receive(&mut socket).await;
                    send(&mut socket, json!({"id":initialize["id"],"result":{}})).await;
                    sockets.push(socket);
                }
                let mut terminal = sockets.pop().unwrap();
                // 原Core连接关闭是connectionProcesses既有清理的触发点。
                while let Some(message) = terminal.next().await {
                    if message.is_err() || matches!(message, Ok(Message::Close(_))) {
                        break;
                    }
                }
                let mut primary = sockets.pop().unwrap();
                let request = receive(&mut primary).await;
                assert_eq!(request["method"], "areal/server/status");
                send(
                    &mut primary,
                    json!({"id":request["id"],"result":{"alive":true}}),
                )
                .await;
            });
            let primary = connect(host.clone(), "project", service.clone())
                .await
                .unwrap();
            let terminal = connect_owned(host.clone(), "project", service, true)
                .await
                .unwrap();
            *primary.workbench_lease.borrow_mut() = Some("primary".into());
            *terminal.workbench_lease.borrow_mut() = Some("terminal".into());
            host.schedules
                .connections
                .sessions
                .borrow_mut()
                .insert("project".into(), primary.clone());
            host.schedules
                .connections
                .terminals
                .borrow_mut()
                .insert("terminal".into(), terminal.clone());
            assert_eq!(
                host.schedules
                    .connections
                    .workbench_detach(&host, "project", "terminal")
                    .unwrap()["closed"],
                true
            );
            assert!(terminal.closed.get());
            assert!(!primary.closed.get());
            assert_eq!(
                host.schedules
                    .connections
                    .workbench_detach(&host, "project", "primary")
                    .unwrap()["closed"],
                true
            );
            assert!(!primary.closed.get(), "后台投影撤租不能关闭 Host 共享连接");
            assert!(primary.workbench_lease.borrow().is_none());
            assert_eq!(
                primary
                    .request("areal/server/status", json!({}))
                    .await
                    .unwrap()["alive"],
                true
            );
            server.await.unwrap();
            primary.close();
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn authenticated_socket_multiplexes_nested_prepare_reads_and_rejects_desktop_tools() {
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let host = Rc::new(super::super::schedules::tests::fixture(root.path()));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let service = service(&host, format!("ws://{}/", listener.local_addr().unwrap()));
        let server = tokio::task::spawn_local(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_hdr_async(stream, ScheduleHeaders).await.unwrap();
            let initialize = receive(&mut socket).await;
            assert_eq!(initialize["method"], "initialize");
            send(&mut socket, json!({"id":initialize["id"],"result":{}})).await;
            let first = receive(&mut socket).await;
            let second = receive(&mut socket).await;
            send(&mut socket, json!({"id":1,"method":"areal/task/prepare","params":{"taskId":"task","runId":"run","threadId":"anchor","intent":"start"}})).await;
            let nested = receive(&mut socket).await;
            assert_eq!(nested["method"], "areal/task/read");
            send(&mut socket, json!({"id":nested["id"],"result":{}})).await;
            let preparation = receive(&mut socket).await;
            assert_eq!(preparation["id"], 1);
            assert!(preparation.get("error").is_some());
            send(&mut socket, json!({"id":2,"method":"item/tool/call","params":{"tool":"js"}})).await;
            let tool = receive(&mut socket).await;
            assert_eq!(tool["id"], 2);
            assert!(tool.get("error").is_some());
            send(&mut socket, json!({"id":second["id"],"result":"second"})).await;
            send(&mut socket, json!({"id":first["id"],"result":"first"})).await;
            let pending = receive(&mut socket).await;
            assert_eq!(pending["method"], "waiting");
            socket.close(None).await.unwrap();
        });
        let session = connect(host, "project", service).await.unwrap();
        let (first, second) = tokio::join!(session.request("first", json!({})), session.request("second", json!({})));
        assert_eq!(first.unwrap(), "first");
        assert_eq!(second.unwrap(), "second");
        assert!(session.request("waiting", json!({})).await.is_err());
        assert!(session.pending.borrow().is_empty());
        assert!(session.closed.get());
        server.await.unwrap();
        session.close();
    }).await;
}
#[tokio::test(flavor = "current_thread")]
async fn refresh_records_drain_and_original_maintenance_stop_before_activation() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let host = Rc::new(super::super::schedules::tests::fixture(root.path()));
            let registration = host.slots.borrow()["project"].registration.clone();
            storage::private_dir(&registration.data_dir).unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut service = service(&host, format!("ws://{}/", listener.local_addr().unwrap()));
            service.identity.service_id = Host::service_id(&registration);
            host.slots.borrow_mut().get_mut("project").unwrap().service = Some(service.clone());
            let directory = storage::registry(&host.home, &service.identity.service_id).unwrap();
            storage::private_dir(&directory).unwrap();
            storage::write(&directory.join("service.json"), &service).unwrap();
            let deployment = host.home.join("deployment.json");
            storage::write(&deployment, &json!({"profiles":[]})).unwrap();
            let inputs = LaunchInputs {
                workspace: registration.workspace.clone(),
                cwd: registration.workspace,
                config_home: host.home.clone(),
                homedir: None,
                config_path: None,
                deployment_path: Some(deployment),
                schedule_preparation: Some(crate::SchedulePreparation::External {
                    default_profile: None,
                }),
                environment: BTreeMap::new(),
                credential_names: vec![],
                options: Default::default(),
            };
            let path = refresh_path(&host, "project");
            storage::private_dir(path.parent().unwrap()).unwrap();
            storage::write(&path.parent().unwrap().join("inputs.json"), &inputs).unwrap();
            let observed_host = host.clone();
            let server = tokio::task::spawn_local(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                for method in [
                    "initialize",
                    "areal/server/status",
                    "areal/plugin/mcp/list",
                    "areal/server/drain",
                ] {
                    let request = receive(&mut socket).await;
                    assert_eq!(request["method"], method);
                    let result = match method {
                        "areal/server/status" => json!({"restartSafe":true}),
                        "areal/plugin/mcp/list" => json!({"data":[]}),
                        "areal/server/drain" => {
                            assert_eq!(
                                request["params"],
                                json!({"strategy":"wait","timeoutMs":5000})
                            );
                            let captured: Refresh =
                                storage::read(&refresh_path(&observed_host, "project")).unwrap();
                            assert!(!captured.drained);
                            assert!(
                                observed_host
                                    .receipt(&captured.stop_request_id)
                                    .unwrap()
                                    .is_none()
                            );
                            assert!(
                                observed_host
                                    .receipt(&captured.request_id)
                                    .unwrap()
                                    .is_none()
                            );
                            json!({"restartSafe":true})
                        }
                        _ => json!({}),
                    };
                    send(&mut socket, json!({"id":request["id"],"result":result})).await;
                }
                let _ = socket.next().await;
            });
            let session = connect(host.clone(), "project", service.clone())
                .await
                .unwrap();
            let mut refresh = capture_refresh(&host, &session).await.unwrap();
            assert!(refresh.drained);
            session.close();
            server.await.unwrap();
            storage::write_stop_receipt(
                &directory,
                &storage::StopReceipt {
                    operation: StopOperation {
                        version: 1,
                        request_id: refresh.stop_request_id.clone(),
                        service_id: service.identity.service_id.clone(),
                        generation: service.identity.generation.clone(),
                        cancel: true,
                        state: StopOperationState::Blocked,
                        message: Some("fixture stop refused".into()),
                        lifecycle: None,
                    },
                    service,
                    cleanup_confirmed: false,
                },
            )
            .unwrap();
            assert!(restart(&host, "project", &mut refresh).await.is_err());
            assert!(!host.schedules.suppressed("project"));
            let stop = host.receipt(&refresh.stop_request_id).unwrap().unwrap();
            assert_eq!(stop.receipt["state"], "blocked");
            assert_eq!(stop.receipt["strategy"], "cancel");
            assert_eq!(
                stop.receipt["serviceGeneration"],
                refresh.previous_generation
            );
            assert!(host.receipt(&refresh.request_id).unwrap().is_none());
            let before =
                std::fs::read(wire::operation_path(&host.home, &refresh.stop_request_id)).unwrap();
            assert!(restart(&host, "project", &mut refresh).await.is_err());
            assert_eq!(
                std::fs::read(wire::operation_path(&host.home, &refresh.stop_request_id)).unwrap(),
                before
            );
            assert!(host.receipt(&refresh.request_id).unwrap().is_none());
        })
        .await;
}
#[tokio::test(flavor = "current_thread")]
async fn cold_slot_refresh_requires_exact_stopped_generation_cleanup_before_original_stop() {
    let root = tempfile::tempdir().unwrap();
    let host = super::super::schedules::tests::fixture(root.path());
    let registration = host.slots.borrow()["project"].registration.clone();
    storage::private_dir(&registration.data_dir).unwrap();
    let mut original = service(&host, "ws://127.0.0.1:1/".into());
    original.identity.service_id = Host::service_id(&registration);
    original.owner = Some(Owner::Host {
        host_id: host.identity.host_id.clone(),
        generation: "previous-host".into(),
    });
    let directory = storage::registry(&host.home, &original.identity.service_id).unwrap();
    storage::private_dir(&directory).unwrap();
    storage::write(&directory.join("service.json"), &original).unwrap();
    host.slots.borrow_mut().get_mut("project").unwrap().service = None;
    let mut refresh = Refresh {
        request_id: uuid::Uuid::new_v4().to_string(),
        stop_request_id: uuid::Uuid::new_v4().to_string(),
        previous_generation: original.identity.generation.clone(),
        drained: false,
        submitted: Default::default(),
        plugins: vec![],
        inputs: LaunchInputs {
            workspace: registration.workspace.clone(),
            cwd: registration.workspace,
            config_home: host.home.clone(),
            homedir: None,
            config_path: None,
            deployment_path: None,
            schedule_preparation: None,
            environment: BTreeMap::new(),
            credential_names: vec![],
            options: Default::default(),
        },
    };
    let path = refresh_path(&host, "project");
    storage::private_dir(path.parent().unwrap()).unwrap();
    storage::write(&path, &refresh).unwrap();
    assert!(restart(&host, "project", &mut refresh).await.is_err());
    assert!(!refresh.drained);
    assert!(host.receipt(&refresh.stop_request_id).unwrap().is_none());
    storage::write(
        &directory.join("cleanup.json"),
        &storage::CleanupReceipt {
            version: VERSION,
            identity: original.identity.clone(),
            owner: original.owner.clone(),
            components: BTreeMap::new(),
            cleanup_confirmed: true,
        },
    )
    .unwrap();
    let mut successor = original.clone();
    successor.identity.generation = "successor".into();
    storage::write(&directory.join("service.json"), &successor).unwrap();
    assert!(restart(&host, "project", &mut refresh).await.is_err());
    assert!(!refresh.drained);
    assert!(host.receipt(&refresh.stop_request_id).unwrap().is_none());
    storage::write(&directory.join("service.json"), &original).unwrap();
    assert!(restart(&host, "project", &mut refresh).await.is_err());
    assert!(refresh.drained);
    let stop = host.receipt(&refresh.stop_request_id).unwrap().unwrap();
    assert_eq!(stop.receipt["state"], "completed");
    assert_eq!(
        stop.receipt["serviceGeneration"],
        original.identity.generation
    );
    assert!(!host.schedules.suppressed("project"));
    assert!(host.receipt(&refresh.request_id).unwrap().is_some());
    assert!(activation_pending(&host, "project").await.unwrap());
    let mut completed = host.receipt(&refresh.request_id).unwrap().unwrap();
    completed.receipt["state"] = json!("completed");
    completed.receipt["result"] = json!({"service":original});
    storage::write(
        &wire::operation_path(&host.home, &refresh.request_id),
        &completed,
    )
    .unwrap();
    host.slots.borrow_mut().get_mut("project").unwrap().service = None;
    let original_receipt =
        std::fs::read(wire::operation_path(&host.home, &refresh.request_id)).unwrap();
    assert!(!activation_pending(&host, "project").await.unwrap());
    assert!(restart(&host, "project", &mut refresh).await.is_err());
    assert_eq!(
        std::fs::read(wire::operation_path(&host.home, &refresh.request_id)).unwrap(),
        original_receipt
    );
    assert!(refresh_path(&host, "project").exists());
}
#[tokio::test(flavor = "current_thread")]
async fn restore_reconciles_old_generation_receipt_but_requires_current_live_connection() {
    tokio::task::LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let host = Rc::new(super::super::schedules::tests::fixture(root.path()));
        let registration = host.slots.borrow()["project"].registration.clone();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let service = service(&host, format!("ws://{}/", listener.local_addr().unwrap()));
        let old_request = "refresh-old-plugin-0".to_owned();
        let mut refresh = Refresh {
            request_id: "refresh".into(), stop_request_id: "stop".into(), previous_generation: "old".into(), drained: true,
            submitted: [old_request.clone()].into(), plugins: vec![json!({"pluginId":"fixture@local","installedDigest":"digest"})],
            inputs: LaunchInputs { workspace: registration.workspace.clone(), cwd: registration.workspace, config_home: host.home.clone(), homedir: None, config_path: None, deployment_path: None, schedule_preparation: None, environment: BTreeMap::new(), credential_names: vec![], options: Default::default() },
        };
        storage::private_dir(refresh_path(&host, "project").parent().unwrap()).unwrap();
        let server = tokio::task::spawn_local(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let initialize = receive(&mut socket).await;
            send(&mut socket, json!({"id":initialize["id"],"result":{}})).await;
            let old = receive(&mut socket).await;
            assert_eq!(old["method"], "areal/request/read");
            assert_eq!(old["params"]["requestId"], old_request);
            send(&mut socket, json!({"id":old["id"],"result":{"data":[{"status":"completed"}]}})).await;
            let lookup = receive(&mut socket).await;
            assert_eq!(lookup["method"], "areal/request/read");
            assert_eq!(lookup["params"]["requestId"], "refresh-first-plugin-0");
            send(&mut socket, json!({"id":lookup["id"],"result":{"data":[]}})).await;
            let mutation = receive(&mut socket).await;
            assert_eq!(mutation["method"], "areal/plugin/connection");
            assert_eq!(mutation["params"]["requestId"], "refresh-first-plugin-0");
            send(&mut socket, json!({"id":mutation["id"],"result":{}})).await;
            let current = receive(&mut socket).await;
            assert_eq!(current["method"], "areal/plugin/mcp/list");
            send(&mut socket, json!({"id":current["id"],"result":{"data":[{"pluginId":"fixture@local","installedDigest":"digest","trusted":true,"state":"disconnected"}]}})).await;
            let _ = socket.next().await;
        });
        let session = connect(host.clone(), "project", service).await.unwrap();
        assert!(restore(&host, &session, &mut refresh).await.is_err());
        assert!(refresh.submitted.contains("refresh-old-plugin-0"));
        assert!(refresh.submitted.contains("refresh-first-plugin-0"));
        assert!(refresh_path(&host, "project").exists());
        session.close();
        server.await.unwrap();
    }).await;
}
