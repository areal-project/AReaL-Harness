use super::*;

#[test]
fn activity_counts_client_union_and_excludes_sleep_idle_and_clock_reversal() {
    let root = tempfile::tempdir().unwrap();
    let mut p = Projection::load(root.path());
    let time = Local
        .with_ymd_and_hms(2026, 11, 5, 10, 0, 0)
        .single()
        .unwrap()
        .timestamp_millis();
    let focused = json!({"focused":true,"idleSeconds":0});
    p.activity("gui", &focused, time);
    p.activity("web", &focused, time);
    p.activity("gui", &focused, time + 5000);
    p.activity("web", &focused, time + 5000);
    p.activity("gui", &json!({"focused":false}), time + 10000);
    p.activity("web", &json!({"focused":false}), time + 10000);
    p.activity("gui", &json!({"focused":false}), time + 15000);
    p.activity("gui", &focused, time + 60000);
    p.activity(
        "gui",
        &json!({"focused":true,"idleSeconds":600}),
        time + 65000,
    );
    p.activity("gui", &focused, time + 30000);
    assert_eq!(p.summary(time)["activeMs"], 10000.0);
    assert_eq!(p.summary(time)["activeDays"], 1);
}

#[test]
fn import_preserves_original_records_and_fractional_activity_without_overwriting_corrupt_state() {
    let root = tempfile::tempdir().unwrap();
    let mut p = Projection::load(root.path());
    p.turn(
        "p",
        "thread",
        &json!({"id":"live","usage":{"inputTokens":3,"outputTokens":1,"cachedInputTokens":0}}),
        Some("2026-11-05".into()),
    );
    let imported = json!({"version":1,"since":1,"days":{"2026-11-04":4000.5},"turns":{
            "[\"p\",\"thread\",\"live\"]":{"date":"2026-01-01","usage":{"inputTokens":99,"outputTokens":0,"cachedInputTokens":0}},
            "[\"p\",\"thread\",\"old\"]":{"date":"2026-11-04","usage":{"inputTokens":1,"outputTokens":1,"cachedInputTokens":0}}
        },"skills":{}});
    p.import(&imported).unwrap();
    p.import(&imported).unwrap();
    p.flush();
    let reopened = Projection::load(root.path());
    assert!(!reopened.read_only);
    let value = reopened.summary(now());
    assert_eq!(value["tokens"], 6);
    assert_eq!(value["activeMs"], 4000.5);
    assert_eq!(value["days"]["2026-11-05"]["tokens"], 4);
    assert_eq!(value["since"], 1.0);
    std::fs::write(&p.path, b"{broken").unwrap();
    let mut corrupt = Projection::load(root.path());
    assert!(corrupt.import(&imported).is_err());
    corrupt.turn("p", "thread", &json!({"id":"new"}), Some(day(now())));
    corrupt.flush();
    assert_eq!(std::fs::read(&p.path).unwrap(), b"{broken");
    assert!(corrupt.summary(now())["error"].is_string());
}

#[tokio::test(flavor = "current_thread")]
async fn native_sync_pages_the_shared_core_and_retains_live_dates_without_node() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    tokio::task::LocalSet::new().run_until(async {
            let root=tempfile::tempdir().unwrap();
            let host=Rc::new(super::super::schedules::tests::fixture(root.path()));
            let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let registration=host.slots.borrow()["project"].registration.clone();
            let service:areal_protocol::service::Service=serde_json::from_value(json!({
                "protocolVersion":1,"serviceId":"fixture","generation":"current","workspace":registration.workspace,"dataDir":registration.data_dir,
                "configFingerprint":"fixture","owner":host.owner(),"endpoint":format!("ws://{}/",listener.local_addr().unwrap()),"webUrl":"",
                "authFile":host.home.join("core-auth.json"),"logFile":host.home.join("core.log"),"hostPid":1,"corePid":2,"state":"ready"
            })).unwrap();
            storage::write(&service.auth_file,&json!({"principals":[{"id":"desktop-owner","token":"fixture"}]})).unwrap();
            {
                let (writer,lifetime)=areal_local_service::OwnerLifetime::pair().unwrap();
                let mut slots=host.slots.borrow_mut();let slot=slots.get_mut("project").unwrap();
                slot.state="ready".into();slot.service=Some(service.clone());slot.writer=Some(writer);slot.lifetime=Some(Rc::new(lifetime));
            }
            let calls=Rc::new(RefCell::new(Vec::new()));let received=calls.clone();
            let peer=tokio::task::spawn_local(async move {
                let (socket,_)=listener.accept().await.unwrap();
                let mut socket=tokio_tungstenite::accept_async(socket).await.unwrap();
                while let Some(Ok(Message::Text(text)))=socket.next().await {
                    let request:Value=serde_json::from_str(&text).unwrap();
                    if request.get("id").is_none(){continue;}
                    let result=match request["method"].as_str().unwrap(){
                        "initialize"=>json!({"capabilities":{}}),
                        "thread/list"=>{received.borrow_mut().push("list".to_owned());if request["params"]["cursor"].is_null(){json!({"data":[{"id":"a"}],"nextCursor":"next"})}else{json!({"data":[{"id":"b"}],"nextCursor":null})}},
                        "thread/read"=>{let id=request["params"]["threadId"].as_str().unwrap();received.borrow_mut().push(id.to_owned());json!({"thread":{"id":id,"turns":[{"id":"turn","usage":{"inputTokens":if id=="a"{3}else{4},"outputTokens":1,"cachedInputTokens":0},"items":[{"id":"skill","type":"dynamicToolCall","tool":"skill_read","status":"completed","success":true,"arguments":{"skill":{"id":"review"}}}]}]}})},
                        method=>panic!("unexpected analytics RPC: {method}"),
                    };
                    socket.send(Message::Text(json!({"id":request["id"],"result":result}).to_string().into())).await.unwrap();
                }
            });
            let close=host.schedules.connections.connect_test_core(host.clone(),"project",service).await.unwrap();
            let analytics=Rc::new(Analytics::default());
            analytics.observe(&host.home,"project",&json!({"method":"turn/started","params":{"threadId":"a","turn":{"id":"turn"}}}));
            let summary=analytics.request(&host,"analytics.sync",&json!({}),&json!({})).await.unwrap();
            assert_eq!(*calls.borrow(),vec!["list","list","a","b"]);
            assert_eq!(summary["tokens"],9);assert_eq!(summary["undatedTokens"],5);
            assert_eq!(summary["skillCalls"],2);assert_eq!(summary["skills"],json!([{"name":"review","calls":2}]));
            assert_eq!(summary["syncing"],false);assert!(summary["error"].is_null());
            assert!(root.path().join("home/workbench/analytics.json").is_file());
            close();peer.abort();
        }).await;
}
