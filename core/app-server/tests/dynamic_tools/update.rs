use super::*;

const SET: &str = "areal/thread/tools/set";

fn request(id: &str, revision: u64, definitions: &[Value]) -> Value {
    json!({"threadId":id,"expectedToolsetRevision":revision,"dynamicTools":definitions})
}
fn revised(name: &str) -> Value {
    json!({"name":name,"description":"Updated lookup","inputSchema":{"type":"object",
        "properties":{"id":{"type":"integer"}},"required":["id"],"additionalProperties":false},
        "outputSchema":{"type":"string"}})
}
fn ok(reply: Value) -> Value {
    assert!(reply.get("result").is_some(), "{reply}");
    reply["result"].clone()
}

struct ChangingModel;
#[async_trait]
impl Model for ChangingModel {
    fn name(&self) -> &str {
        "toolset-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat_limited(
        &self,
        messages: Vec<Message>,
        tools: Vec<Value>,
        purpose: areal_engine::model::RequestPurpose,
        cap: Option<u64>,
    ) -> anyhow::Result<ModelStream> {
        if purpose == areal_engine::model::RequestPurpose::PromptPrediction {
            assert!(tools.is_empty() && cap.is_some());
            return Ok(Box::pin(futures_util::stream::iter([Ok(
                ModelEvent::TextDelta("Look up another record".into()),
            )])));
        }
        assert!(cap.is_none());
        self.chat(messages, tools).await
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<AgentStream> {
        let step = messages
            .iter()
            .rev()
            .filter(|m| m.role == "user")
            .map(Message::text_content)
            .find(|text| text.starts_with("catalog:"))
            .unwrap_or_default();
        let exposed: Vec<_> = tools
            .iter()
            .map(|t| &t["function"])
            .filter(|f| matches!(f["name"].as_str(), Some("lookup" | "replacement")))
            .collect();
        let (name, args) = match step.as_str() {
            "catalog:old" => ("lookup", json!({"key":"seven"})),
            "catalog:old-args" => ("lookup", json!({"key":"stale"})),
            "catalog:new-schema" => ("lookup", json!({"id":7})),
            "catalog:removed" => ("lookup", json!({"id":7})),
            _ => ("replacement", json!({"id":7})),
        };
        if !step.is_empty() {
            let expected = match step.as_str() {
                "catalog:old" => Some(definition()),
                "catalog:old-args" | "catalog:new-schema" => Some(revised("lookup")),
                "catalog:empty" | "catalog:restricted" => None,
                _ => Some(revised("replacement")),
            };
            assert_eq!(
                exposed.len(),
                usize::from(expected.is_some()),
                "{step}: {exposed:?}"
            );
            if let Some(def) = expected {
                assert_eq!(exposed[0]["name"], def["name"], "{step}");
                assert_eq!(
                    exposed[0]["parameters"]["required"], def["inputSchema"]["required"],
                    "{step}"
                );
            }
            if step != "catalog:old" {
                assert!(
                    messages
                        .iter()
                        .any(|m| m.role == "tool" && m.text_content().contains("value 7")),
                    "换工具后模型应仍能看见第一轮的实际结果"
                );
            }
        }
        let event = if step.is_empty()
            || step == "catalog:empty"
            || messages.last().is_some_and(|m| m.role == "tool")
        {
            ModelEvent::TextDelta("done".into())
        } else {
            ModelEvent::ToolCall(ToolCall {
                id: uuid::Uuid::new_v4().to_string(),
                name: name.into(),
                arguments: args.to_string(),
            })
        };
        Ok(Box::pin(futures_util::stream::iter([Ok(event)])))
    }
}

async fn turn(
    engine: &Engine,
    socket: &mut Socket,
    id: &str,
    step: &str,
    callback: Option<(&str, Value, Value)>,
) -> areal_protocol::Turn {
    ok(call(
        socket,
        "turn/start",
        json!({"threadId":id,"input":[{"type":"text","text":step}]}),
    )
    .await);
    if let Some((name, args, result)) = callback {
        let req = tool_request(socket).await;
        assert_eq!(req["params"]["tool"], name);
        assert_eq!(req["params"]["arguments"], args);
        send(socket, json!({"id":req["id"],"result":result})).await;
    }
    let mut t = settled(engine, id).await.turns.pop().unwrap();
    assert_eq!(t.status, TurnStatus::Completed, "{step}: {:?}", t.error);
    // 只返回 Core 已持久化的工具条目。
    t.items
        .retain(|i| matches!(i, Item::DynamicToolCall { .. }));
    t
}
fn assert_outcome(turn: &areal_protocol::Turn, outcome: ToolOutcome) {
    assert!(
        matches!(&turn.items[..], [Item::DynamicToolCall { execution, .. }] if execution.outcome == outcome),
        "{:?}",
        turn.items
    );
}
async fn stop(
    engine: Arc<Engine>,
    mut socket: Socket,
    cancel: CancellationToken,
    task: tokio::task::JoinHandle<anyhow::Result<()>>,
) {
    socket.close(None).await.unwrap();
    engine.shutdown().await;
    cancel.cancel();
    task.await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while Arc::strong_count(&engine) > 1 {
            tokio::task::yield_now().await
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn replacement_schema_callbacks_history_and_restart() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(ChangingModel), Limits::default()).unwrap();
    let (url, cancel, task) = serve(engine.clone()).await;
    let mut owner = connected(&url).await;
    let id = start(&mut owner).await;
    let first = turn(
        &engine,
        &mut owner,
        &id,
        "catalog:old",
        Some(("lookup", json!({"key":"seven"}), result())),
    )
    .await;
    assert_outcome(&first, ToolOutcome::Succeeded);
    let old_history = json!(engine.read(&id, true).await.unwrap().turns);
    let has_desktop = engine.read(&id, false).await.unwrap().desktop.is_some();
    let new_result = json!({"success":true,"contentItems":[{"type":"inputText","text":"new output"}],"structuredContent":"seven"});

    assert_eq!(
        ok(call(&mut owner, SET, request(&id, 0, &[revised("lookup")])).await),
        json!({"threadId":id,"toolsetRevision":1})
    );
    assert_eq!(
        json!(engine.read(&id, true).await.unwrap().turns),
        old_history
    );
    assert_eq!(
        engine.read(&id, false).await.unwrap().desktop.is_some(),
        has_desktop
    );
    assert_outcome(
        &turn(&engine, &mut owner, &id, "catalog:old-args", None).await,
        ToolOutcome::Failed,
    );
    assert_outcome(
        &turn(
            &engine,
            &mut owner,
            &id,
            "catalog:new-schema",
            Some(("lookup", json!({"id":7}), new_result.clone())),
        )
        .await,
        ToolOutcome::Succeeded,
    );
    let b = revised("replacement");
    assert_eq!(
        ok(call(&mut owner, SET, request(&id, 1, std::slice::from_ref(&b))).await)["toolsetRevision"],
        2
    );
    assert_outcome(
        &turn(&engine, &mut owner, &id, "catalog:removed", None).await,
        ToolOutcome::Failed,
    );
    stop(engine, owner, cancel, task).await;

    let engine = Engine::open(
        dir.path(),
        Arc::new(ChangingModel),
        Limits {
            session_catalog: areal_engine::SessionCatalog::SqliteLazy,
            ..Default::default()
        },
    )
    .unwrap();
    let (url, cancel, task) = serve(engine.clone()).await;
    let mut owner = connected(&url).await;
    assert_eq!(
        call(&mut owner, SET, request(&id, 2, &[])).await["error"]["code"],
        -32009
    );
    let resumed = ok(call(&mut owner, "thread/resume", json!({"threadId":id})).await);
    assert_eq!(resumed["thread"]["toolsetRevision"], 2);
    assert_eq!(resumed["thread"]["dynamicTools"], json!([b]));
    assert_eq!(resumed["thread"]["turns"][0], old_history[0]);
    assert_outcome(
        &turn(
            &engine,
            &mut owner,
            &id,
            "catalog:resumed",
            Some(("replacement", json!({"id":7}), new_result)),
        )
        .await,
        ToolOutcome::Succeeded,
    );
    assert_eq!(
        ok(call(&mut owner, SET, request(&id, 2, &[])).await)["toolsetRevision"],
        3
    );
    assert!(
        turn(&engine, &mut owner, &id, "catalog:empty", None)
            .await
            .items
            .is_empty()
    );
    stop(engine, owner, cancel, task).await;
}

#[tokio::test]
async fn replacement_preserves_the_configured_allowlist_and_archive_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(ChangingModel), Limits::default()).unwrap();
    let (url, cancel, task) = serve(engine.clone()).await;
    let mut owner = connected(&url).await;
    let created = ok(call(
        &mut owner,
        "areal/thread/start",
        json!({"requestId":"restricted","cwd":"/workspace","dynamicTools":[definition()],
            "options":{"automaticSessionName":false,"toolAllowlist":["lookup","agent_spawn"]}}),
    )
    .await);
    let thread = &created["thread"];
    let id = thread["id"].as_str().unwrap();
    let config = &thread["desktop"]["configuration"];
    assert_eq!(config["toolAllowlist"], json!(["lookup", "agent_spawn"]));
    let first = turn(
        &engine,
        &mut owner,
        id,
        "catalog:old",
        Some(("lookup", json!({"key":"seven"}), result())),
    )
    .await;
    assert_outcome(&first, ToolOutcome::Succeeded);
    let mut observer = connected(&url).await;
    ok(call(
        &mut observer,
        "areal/thread/observe",
        json!({"threadId":id}),
    )
    .await);
    let prediction = ok(call(
        &mut owner,
        "areal/thread/prediction",
        json!({
            "threadId":id,"sourceTurnId":first.id,"operation":"request"
        }),
    )
    .await);
    assert_eq!(prediction["status"], "pending", "{prediction}");
    loop {
        let event = receive(&mut observer).await;
        if event["method"] == "areal/thread/predictionChanged"
            && event["params"]["promptPrediction"]["status"] != "pending"
        {
            assert_eq!(
                event["params"]["promptPrediction"]["status"], "ready",
                "{event}"
            );
            break;
        }
    }

    ok(call(&mut owner, SET, request(id, 0, &[revised("replacement")])).await);
    let saved = ok(call(&mut owner, "thread/read", json!({"threadId":id})).await);
    assert_eq!(&saved["thread"]["desktop"]["configuration"], config);
    let retired = &saved["thread"]["desktop"]["promptPrediction"];
    assert_eq!(retired["status"], "unavailable");
    assert_eq!(retired["sourceTurnId"], first.id);
    loop {
        let event = receive(&mut observer).await;
        if event["method"] == "areal/thread/predictionChanged" {
            assert_eq!(&event["params"]["promptPrediction"], retired);
            break;
        }
    }
    // 模型看不到新工具；即使点名调用，也不能越过原白名单派发回调。
    assert_outcome(
        &turn(&engine, &mut owner, id, "catalog:restricted", None).await,
        ToolOutcome::Failed,
    );
    ok(call(
        &mut owner,
        "areal/thread/archive",
        json!({"threadId":id,"requestId":"archive"}),
    )
    .await);
    let rejected = call(&mut owner, SET, request(id, 1, &[])).await;
    assert_eq!(rejected["error"]["code"], -32602);
    assert!(
        rejected["error"]["message"]
            .as_str()
            .unwrap()
            .contains("THREAD_ARCHIVED")
    );
    observer.close(None).await.unwrap();
    stop(engine, owner, cancel, task).await;
}

#[tokio::test]
async fn busy_invalid_and_competing_replacements_leave_one_committed_revision() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(FixtureModel), Limits::default()).unwrap();
    let (url, cancel, task) = serve(engine.clone()).await;
    let mut owner = connected(&url).await;
    let id = start(&mut owner).await;
    let a = definition();
    let b = revised("replacement");
    let mut observer = connected(&url).await;
    ok(call(
        &mut observer,
        "areal/thread/observe",
        json!({"threadId":id}),
    )
    .await);
    assert_eq!(
        call(&mut observer, SET, request(&id, 0, &[])).await["error"]["code"],
        -32009
    );
    for invalid in [
        vec![b.clone(), b.clone()],
        vec![b.clone(), revised("agent_spawn")],
        vec![
            b.clone(),
            json!({"name":"bad","description":"bad schema","inputSchema":{"type":"object","required":1}}),
        ],
    ] {
        assert_eq!(
            call(&mut owner, SET, request(&id, 0, &invalid)).await["error"]["code"],
            -32602
        );
    }
    assert_eq!(
        ok(call(&mut owner, SET, request(&id, 0, std::slice::from_ref(&a))).await)["toolsetRevision"],
        0
    );
    engine
        .start(&id, vec![Input::text("lookup")])
        .await
        .unwrap();
    let pending = tool_request(&mut owner).await;
    assert_eq!(
        call(&mut owner, SET, request(&id, 0, &[])).await["error"]["code"],
        -32009
    );
    send(&mut owner, json!({"id":pending["id"],"result":result()})).await;
    assert_eq!(
        settled(&engine, &id).await.turns.last().unwrap().status,
        TurnStatus::Completed
    );

    // 两笔写入以同一快照为前提；先发两笔，再读取任一响应。
    for (rpc, defs) in [(41, vec![b.clone()]), (42, vec![])] {
        send(
            &mut owner,
            json!({"id":rpc,"method":SET,"params":request(&id,0,&defs)}),
        )
        .await;
    }
    let mut replies = std::collections::BTreeMap::new();
    while replies.len() < 2 {
        let message = receive(&mut owner).await;
        if let Some(id @ (41 | 42)) = message["id"].as_u64() {
            replies.insert(id, message);
        }
    }
    let winner = replies
        .iter()
        .find(|(_, r)| r["result"]["toolsetRevision"] == 1)
        .unwrap()
        .0;
    assert_eq!(
        replies
            .values()
            .filter(|r| r["error"]["code"] == -32009)
            .count(),
        1
    );
    let expected = if *winner == 41 { vec![b] } else { vec![] };
    let event = loop {
        let m = receive(&mut observer).await;
        if m["method"] == "areal/thread/tools/attached" {
            break m["params"].clone();
        }
    };
    assert_eq!(
        event,
        json!({"threadId":id,"toolsetRevision":1,"dynamicTools":expected})
    );
    assert_eq!(
        call(&mut owner, SET, request(&id, 0, &expected)).await["error"]["code"],
        -32009
    );
    let observed = ok(call(&mut observer, "thread/read", json!({"threadId":id})).await);
    assert_eq!(observed["thread"]["toolsetRevision"], 1);
    assert_eq!(
        observed["thread"]
            .get("dynamicTools")
            .cloned()
            .unwrap_or(json!([])),
        json!(expected)
    );
    assert_eq!(
        ok(call(&mut owner, SET, request(&id, 1, &expected)).await)["toolsetRevision"],
        1
    );
    observer.close(None).await.unwrap();
    stop(engine, owner, cancel, task).await;
}

#[tokio::test]
async fn permissions_thread_scope_and_desktop_tool_ownership() {
    use areal_app_server::auth::{Authentication, Permission::*, Principal};
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(FixtureModel), Limits::default()).unwrap();
    let target = engine.create("/workspace".into()).await.unwrap();
    let outside = engine.create("/workspace".into()).await.unwrap();
    let principal = |id: &str, permissions, thread_ids| Principal {
        id: id.into(),
        token: uuid::Uuid::new_v4().simple().to_string(),
        permissions,
        thread_ids,
    };
    let principals = vec![
        principal(
            "gateway",
            [Observe, Interact, Tools].into(),
            Some([target.id.clone()].into()),
        ),
        principal("sender", [Observe, Interact].into(), None),
        principal("tool-only", [Observe, Tools].into(), None),
        principal("desktop-owner", [Observe, Interact, Tools].into(), None),
    ];
    let tokens: Vec<_> = principals.iter().map(|p| p.token.clone()).collect();
    let (url, cancel, task) = serve_with_auth(
        engine.clone(),
        Some(Authentication {
            version: 1,
            principals,
        }),
    )
    .await;
    for token in &tokens[1..3] {
        let mut denied = connected_with(&url, Some(token)).await;
        let caps = ok(call(&mut denied, "areal/capabilities", json!({})).await);
        assert!(!caps["methods"].as_array().unwrap().contains(&json!(SET)));
        assert_eq!(
            call(&mut denied, SET, request(&target.id, 0, &[definition()])).await["error"]["code"],
            -32003
        );
        denied.close(None).await.unwrap();
    }
    let mut gateway = connected_with(&url, Some(&tokens[0])).await;
    let caps = ok(call(&mut gateway, "areal/capabilities", json!({})).await);
    assert!(caps["methods"].as_array().unwrap().contains(&json!(SET)));
    assert_eq!(caps["methodSemantics"][SET], json!({"effect":"mutation"}));
    assert_eq!(
        call(&mut gateway, SET, request(&outside.id, 0, &[definition()])).await["error"]["code"],
        -32003
    );
    assert_eq!(
        ok(call(&mut gateway, SET, request(&target.id, 0, &[definition()])).await)["toolsetRevision"],
        1
    );
    let mut desktop = connected_with(&url, Some(&tokens[3])).await;
    assert_eq!(
        call(&mut desktop, SET, request(&target.id, 1, &[])).await["error"]["code"],
        -32009
    );

    let browser = json!(areal_protocol::desktop::browser_v1_tool());
    assert_eq!(
        call(
            &mut desktop,
            SET,
            request(&outside.id, 0, std::slice::from_ref(&browser))
        )
        .await["error"]["code"],
        -32602
    );
    ok(call(&mut desktop,"areal/thread/tools/attach",json!({"threadId":outside.id,"expectedToolsetRevision":0,"requestId":"fixed","bundleId":"areal.browser.v1"})).await);
    for defs in [vec![], vec![revised("browser_v1")]] {
        assert_eq!(
            call(&mut desktop, SET, request(&outside.id, 1, &defs)).await["error"]["code"],
            -32602
        );
    }
    assert_eq!(
        ok(call(
            &mut desktop,
            SET,
            request(&outside.id, 1, &[browser.clone(), definition()])
        )
        .await)["toolsetRevision"],
        2
    );
    assert_eq!(
        ok(call(&mut desktop, "thread/read", json!({"threadId":outside.id})).await)["thread"]["dynamicTools"],
        json!([browser, definition()])
    );
    desktop.close(None).await.unwrap();
    stop(engine, gateway, cancel, task).await;
}

#[tokio::test]
async fn persistence_limit_preserves_bindings_and_replacement_does_not_clear_unknown() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(
        dir.path(),
        Arc::new(FixtureModel),
        Limits {
            max_history_bytes: 64 * 1024,
            ..Default::default()
        },
    )
    .unwrap();
    let (url, cancel, task) = serve(engine.clone()).await;
    let mut owner = connected(&url).await;
    let id = start(&mut owner).await;
    // 每个定义本身有效；整个候选 Thread 超过当前 Store 的存储额度。
    let many: Vec<_> = (0..9)
        .map(|i| {
            let mut d = revised(&format!("large_{i}"));
            d["description"] = json!("x".repeat(8192));
            d
        })
        .collect();
    let rejected = call(&mut owner, SET, request(&id, 0, &many)).await;
    assert!(
        rejected["error"]["message"]
            .as_str()
            .unwrap()
            .contains("history limit"),
        "{rejected}"
    );
    let saved = ok(call(&mut owner, "thread/read", json!({"threadId":id})).await);
    assert_eq!(saved["thread"]["dynamicTools"], json!([definition()]));
    assert_eq!(saved["thread"]["toolsetRevision"].as_u64().unwrap_or(0), 0);
    engine
        .start(&id, vec![Input::text("lookup")])
        .await
        .unwrap();
    let callback = tool_request(&mut owner).await;
    assert_eq!(callback["params"]["tool"], "lookup");
    send(&mut owner,json!({"id":callback["id"],"error":{"code":-32601,"message":"fixture tool no longer available"}})).await;
    let failed = settled(&engine, &id).await;
    let item=failed.turns[0].items.iter().find(|i|matches!(i,Item::DynamicToolCall{execution,..} if execution.outcome==ToolOutcome::Unknown)).unwrap().id();
    assert_eq!(
        ok(call(&mut owner, SET, request(&id, 0, &[])).await)["toolsetRevision"],
        1
    );
    assert!(
        engine
            .start(&id, vec![Input::text("continue")])
            .await
            .unwrap_err()
            .to_string()
            .contains("UNKNOWN")
    );
    ok(call(
        &mut owner,
        "areal/tool/acknowledge",
        json!({"threadId":id,"itemId":item,"inspection":"fixture confirmed no dispatch"}),
    )
    .await);
    let after = engine.read(&id, true).await.unwrap();
    assert!(after.turns[0].items.iter().any(|i|matches!(i,Item::DynamicToolCall{execution,..} if execution.outcome==ToolOutcome::Unknown && execution.inspection.is_some())));
    stop(engine, owner, cancel, task).await;
}
