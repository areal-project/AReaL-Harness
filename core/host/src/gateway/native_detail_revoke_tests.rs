use super::*;
use tokio::sync::oneshot;

struct DetailProxy {
    task: tokio::task::JoinHandle<()>,
    observed: oneshot::Receiver<Value>,
    release: Option<oneshot::Sender<()>>,
}
impl Drop for DetailProxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn attach_detail_proxy(f: &mut Fixture, native: &NativeCore, target: Value) -> DetailProxy {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("ws://{}/", listener.local_addr().unwrap());
    let auth: Value = storage::read(&native.direct.auth_file).unwrap();
    let token = auth["principals"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == "desktop-owner")
        .unwrap()["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let upstream_url = native.direct.endpoint.clone();
    let run = native.run.clone();
    let (observed_tx, observed) = oneshot::channel();
    let (release, mut release_rx) = oneshot::channel();
    let task = tokio::task::spawn_local(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut request = upstream_url.as_str().into_client_request().unwrap();
        request
            .headers_mut()
            .insert("authorization", format!("Bearer {token}").parse().unwrap());
        let mut downstream = tokio_tungstenite::accept_async(stream).await.unwrap();
        let (mut upstream, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        let mut original_request: Option<Value> = None;
        let mut held: Option<Message> = None;
        let mut observed_tx = Some(observed_tx);
        loop {
            tokio::select! {
                released = &mut release_rx, if held.is_some() => {
                    if released.is_err() { break; }
                    if downstream.send(held.take().unwrap()).await.is_err() { break; }
                }
                incoming = downstream.next() => {
                    let Some(Ok(message)) = incoming else { break; };
                    if let Message::Text(text) = &message {
                        let value: Value = serde_json::from_str(text).unwrap();
                        if value["method"] == "areal/interaction/list" && value["params"]["threadId"] == target["threadId"] {
                            assert!(original_request.is_none(), "only one matching Core request");
                            original_request = Some(value);
                        }
                    }
                    if upstream.send(message).await.is_err() { break; }
                }
                incoming = upstream.next() => {
                    let Some(Ok(message)) = incoming else { break; };
                    if let Message::Text(text) = &message {
                        let value: Value = serde_json::from_str(text).unwrap();
                        if original_request.as_ref().is_some_and(|request| request["id"] == value["id"]) {
                            let request = original_request.take().unwrap();
                            let items = value["result"]["data"].as_array().expect("real Core success result");
                            let original = items.iter().find(|item| item["threadId"] == target["threadId"] && item["turnId"] == target["turnId"] && item["requestId"] == target["interactionId"]).expect("original target in real Core result");
                            assert_eq!(original["status"], "pending");
                            let frame = json!({"request":request,"response":value});
                            storage::write(&run.join("detail-held-frame.json"), &frame).unwrap();
                            held = Some(message);
                            observed_tx.take().expect("one held frame").send(frame).unwrap();
                            continue;
                        }
                    }
                    if downstream.send(message).await.is_err() { break; }
                }
            }
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
    DetailProxy {
        task,
        observed,
        release: Some(release),
    }
}

async fn pending_approval(native: &NativeCore) -> (Value, Value) {
    let direct = &native.direct;
    let created = areal_local_service::rpc(
        direct,
        "areal/thread/start",
        json!({
            "requestId":uuid::Uuid::new_v4().to_string(),"cwd":direct.identity.workspace,
            "agentProfile":{"id":"reviewed","revision":"v1"}
        }),
    )
    .await
    .unwrap();
    let thread = created["thread"]["id"].as_str().unwrap();
    let started = areal_local_service::rpc(direct, "areal/turn/start", json!({
        "requestId":uuid::Uuid::new_v4().to_string(),"threadId":thread,"expectedConfigRevision":1,
        "input":[{"type":"text","text":"Append original marker after review"}]
    })).await.unwrap();
    let turn = started["turn"]["id"].as_str().unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let listed =
            areal_local_service::rpc(direct, "areal/interaction/list", json!({"threadId":thread}))
                .await
                .unwrap();
        if let Some(item) = listed["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["turnId"] == turn && item["status"] == "pending")
        {
            assert_eq!(item["kind"], "approval");
            assert_eq!(item["tool"], "run_command");
            return (
                json!({"threadId":thread,"turnId":turn,"interactionId":item["requestId"]}),
                item.clone(),
            );
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "pending approval deadline"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn observed_grant(f: &Fixture) -> Value {
    let snapshot = f.host.remote.snapshot(&f.host.migration).unwrap();
    let grant = snapshot["config"]["deviceGrants"]
        .as_array()
        .unwrap()
        .iter()
        .find(|grant| grant["devicePeerId"] == "a")
        .unwrap();
    json!({"devicePeerId":grant["devicePeerId"],"revision":grant["revision"],
        "status":grant["status"],"capabilities":grant["capabilities"],"projectIds":grant["projectIds"]})
}

async fn detail_case(mode: &str) {
    let mut f = Fixture::new().await;
    (f.close)();
    f.server.abort();
    let mut native = start_native_core(&f).await;
    let (target, original) = pending_approval(&native).await;
    let run = native.run.clone();
    storage::write(&run.join("detail-plan.json"), &json!({"target":target,"original":original,"mode":mode,"boundary":"real Core/Runtime startup, in-process Host owner; no Noise or independent Host"})).unwrap();
    let mut proxy = attach_detail_proxy(&mut f, &native, target.clone()).await;
    let original_journal = f.host.journal.native_snapshot("project").unwrap();
    let request = f.request("attention.read", target.clone(), None);
    storage::write(&run.join("detail-request.json"), &request).unwrap();
    let reading = Fixture::dispatch(f.session("a"), request);
    let frame = tokio::time::timeout(Duration::from_secs(20), &mut proxy.observed)
        .await
        .expect("held response deadline")
        .expect("proxy must hold real success");
    let held_item = frame["response"]["result"]["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["requestId"] == target["interactionId"])
        .unwrap();
    assert_eq!(held_item, &original);
    let before_grant = observed_grant(&f);
    let before_service = f.host.slots.borrow()["project"].service.clone().unwrap();
    let mut replacement = if mode == "replacement" {
        let mut replacement = start_native_core(&f).await;
        // 独立 Core 是真实进程；服务描述符换代由此 Host owner 夹具显式发布。
        replacement.direct.identity.generation = uuid::Uuid::new_v4().to_string();
        assert_ne!(before_service.core_pid, replacement.direct.core_pid);
        assert_ne!(native.direct.endpoint, replacement.direct.endpoint);
        assert_ne!(
            before_service.identity.generation,
            replacement.direct.identity.generation
        );
        f.host
            .slots
            .borrow_mut()
            .get_mut("project")
            .unwrap()
            .service = Some(replacement.direct.clone());
        Some(replacement)
    } else {
        None
    };
    if mode == "revoke" {
        f.grant("a", |grant| grant["status"] = json!("revoked"));
    }
    let after_grant = observed_grant(&f);
    if mode == "revoke" {
        assert_eq!(before_grant["status"], "active");
        assert_eq!(after_grant["status"], "revoked");
        assert_ne!(before_grant, after_grant);
    } else {
        assert_eq!(before_grant, after_grant);
    }
    storage::write(
        &run.join("detail-grant-after-held.json"),
        &json!({"heldRequestId":frame["request"]["id"],"before":before_grant,"after":after_grant,
            "beforeService":before_service,"afterService":f.host.slots.borrow()["project"].service}),
    )
    .unwrap();
    proxy.release.take().unwrap().send(()).unwrap();
    let (_, result) = tokio::time::timeout(Duration::from_secs(20), reading)
        .await
        .expect("detail result deadline")
        .unwrap();
    let recorded = match &result {
        Ok(value) => json!({"result":value}),
        Err(error) => json!({"error":error.to_string()}),
    };
    storage::write(&run.join("detail-result.json"), &recorded).unwrap();
    if mode == "revoke" {
        assert_eq!(result.unwrap_err().to_string(), "GRANT_CHANGED");
        assert!(recorded.get("result").is_none());
    } else if mode == "replacement" {
        assert_eq!(
            result
                .unwrap_err()
                .downcast_ref::<crate::wire::Error>()
                .unwrap()
                .code,
            "scheduleHostUnavailable"
        );
        assert!(recorded.get("result").is_none());
    } else {
        let detail = result.unwrap();
        assert_eq!(detail["interactionId"], target["interactionId"]);
        assert_eq!(detail["threadId"], target["threadId"]);
        assert_eq!(detail["turnId"], target["turnId"]);
        assert_eq!(detail["argumentsDigest"], original["argumentsDigest"]);
        assert_eq!(detail["complete"], true);
        assert!(detail["reviewToken"].is_string());
        let body: Value =
            serde_json::from_str(detail["review"]["chunk"].as_str().unwrap()).unwrap();
        assert_eq!(
            body,
            json!({"tool":original["tool"],"generation":original["generation"],
            "effectiveArguments":original["effectiveArguments"],"effectivePermissions":original["effectivePermissions"],
            "questions":original.get("questions").cloned().unwrap_or(json!([]))})
        );
    }
    assert_eq!(
        f.host.journal.native_snapshot("project").unwrap(),
        original_journal
    );
    let after = areal_local_service::rpc(
        &native.direct,
        "areal/interaction/list",
        json!({"threadId":target["threadId"]}),
    )
    .await
    .unwrap();
    assert_eq!(
        after["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["requestId"] == target["interactionId"])
            .unwrap(),
        &original
    );
    assert!(!native.effect.exists());
    (f.close)();
    proxy.task.abort();
    let mut children = vec![&mut native.core, &mut native.model];
    if let Some(replacement) = replacement.as_mut() {
        assert!(!replacement.effect.exists());
        children.extend([&mut replacement.core, &mut replacement.model]);
    }
    for child in children {
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
            "owned child must exit"
        );
    }
    storage::write(&run.join("detail-complete.json"), &json!({"passed":true,"mode":mode,"corePid":native.core.0.id(),"modelPid":native.model.0.id(),"effectAbsent":true,
        "replacement":replacement.as_ref().map(|core|json!({"corePid":core.core.0.id(),"modelPid":core.model.0.id(),"run":core.run}))})).unwrap();
    println!("native detail evidence: {}", run.display());
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "real Core/Runtime; in-process Host owner only, no Noise or independent Host"]
async fn native_detail_publication_fences_revoke_after_real_core_read() {
    tokio::task::LocalSet::new()
        .run_until(async {
            detail_case("control").await;
            detail_case("revoke").await;
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "two real Core/Runtime instances; in-process Host owner only, no Noise or independent Host"]
async fn native_detail_publication_fences_service_identity_change() {
    tokio::task::LocalSet::new()
        .run_until(detail_case("replacement"))
        .await;
}
