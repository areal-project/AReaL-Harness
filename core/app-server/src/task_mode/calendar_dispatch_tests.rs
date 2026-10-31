use super::*;
use areal_engine::model::{Message, Model, ModelEvent, ModelStream, RequestPurpose, ToolCall};
use std::sync::{
    Mutex as StdMutex,
    atomic::{AtomicBool, Ordering},
};

#[derive(Default)]
struct Observed {
    prepares: StdMutex<Vec<Value>>,
    goals: StdMutex<std::collections::BTreeSet<String>>,
    block: AtomicBool,
    hold: AtomicBool,
    release: tokio::sync::Notify,
}
#[async_trait::async_trait]
impl Model for Observed {
    fn name(&self) -> &str {
        "calendar-observer"
    }
    async fn stream(&self, m: Vec<Message>) -> anyhow::Result<ModelStream> {
        self.chat_limited(m, vec![], RequestPurpose::Solve, None)
            .await
    }
    async fn chat_limited(
        &self,
        m: Vec<Message>,
        _: Vec<Value>,
        _: RequestPurpose,
        _: Option<u64>,
    ) -> anyhow::Result<ModelStream> {
        let view: Value = m
            .iter()
            .rev()
            .find_map(|m| {
                m.text_content()
                    .split("Current authoritative goal: ")
                    .nth(1)
                    .and_then(|t| serde_json::from_str(t).ok())
            })
            .unwrap();
        self.goals
            .lock()
            .unwrap()
            .insert(view["goal"]["id"].as_str().unwrap().into());
        let event = if view["goal"]["limitsPending"] == true {
            ModelEvent::ToolCall(ToolCall {
                id: uuid::Uuid::new_v4().to_string(),
                name: "goal_set_limits".into(),
                arguments: json!({"expectedRevision":view["revision"],"sources":{}}).to_string(),
            })
        } else if view["goal"]["report"]["status"] == "complete"
            || view["goal"]["report"]["status"] == "blocked"
        {
            ModelEvent::TextDelta("calendar observed".into())
        } else {
            ModelEvent::ToolCall(ToolCall{id:uuid::Uuid::new_v4().to_string(),name:"goal_update".into(),arguments:json!({"expectedRevision":view["revision"],"status":if self.block.load(Ordering::SeqCst){"blocked"}else{"complete"},"summary":"calendar completed","evidence":["independent model observation"],"remaining":[],"blocker":if self.block.load(Ordering::SeqCst){Some("waiting explicitly")}else{None}}).to_string()})
        };
        Ok(Box::pin(futures_util::stream::iter(vec![
            Ok(event),
            Ok(ModelEvent::Usage(areal_protocol::ModelUsage {
                input_tokens: 10,
                cached_input_tokens: 0,
                output_tokens: 5,
            })),
        ])))
    }
}
#[async_trait::async_trait]
impl areal_engine::tools::DynamicToolHost for Observed {
    fn id(&self) -> &str {
        "calendar-host"
    }
    fn identity(&self) -> &str {
        "trusted-embedded-host"
    }
    fn is_closed(&self) -> bool {
        false
    }
    async fn prepare_schedule(&self, p: Value, _: CancellationToken) -> anyhow::Result<Value> {
        self.prepares.lock().unwrap().push(p);
        if self.hold.load(Ordering::SeqCst) {
            self.release.notified().await;
        }
        Ok(json!({}))
    }
    async fn call(
        &self,
        _: Value,
        _: CancellationToken,
    ) -> anyhow::Result<areal_protocol::DynamicToolResponse> {
        anyhow::bail!("unexpected call")
    }
}
fn open_calendar(path: &std::path::Path, model: Arc<Observed>, at: i64) -> Arc<Engine> {
    let e = Engine::open(path, model, areal_engine::Limits::default()).unwrap();
    e.set_schedule_time(at).unwrap();
    e
}
async fn rpc(e: &Arc<Engine>, method: &str, p: Value) -> Value {
    dispatch(e, &auth::Principal::embedded(), method, p)
        .await
        .unwrap()
}
async fn wait_calendar(e: &Arc<Engine>, id: &Value, n: usize, decision: Option<&str>) -> Value {
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let t = rpc(e, "areal/task/read", json!({"taskId":id})).await;
            let runs = t["runs"].as_array().unwrap();
            if runs.len() == n
                && (n == 0 || runs.last().unwrap()["status"] == "completed")
                && decision.is_none_or(|d| t["lastTriggerDecision"]["outcome"]["kind"] == d)
            {
                return t;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    match result {
        Ok(t) => t,
        Err(_) => panic!(
            "calendar wait failed: {}",
            rpc(e, "areal/task/read", json!({"taskId":id})).await
        ),
    }
}
fn plan(rule: Value, misfire: Value) -> Value {
    json!({"version":1,"rule":rule,"misfire":misfire,"overlap":"skip"})
}
async fn create_calendar(e: &Arc<Engine>, name: &str, schedule: Value) -> Value {
    let thread = e.create(e.default_cwd()).await.unwrap();
    rpc(e,"areal/task/create",json!({"requestId":name,"mode":"scheduled","objective":name,"threadId":thread.id,"scheduleV2":schedule})).await
}
#[tokio::test]
async fn calendar_preview_matches_five_durable_runs_across_restarts() {
    let literals: Value = serde_json::from_str(include_str!("calendar-literals.json")).unwrap();
    for (name, rule) in [
        (
            "shanghai-weekdays",
            json!({"kind":"calendar","frequency":"weekly","interval":1,"timeZone":"Asia/Shanghai","localTime":"09:00","anchorDate":"2026-10-23","weekdays":[1,2,3,4,5]}),
        ),
        (
            "new-york-gap",
            json!({"kind":"calendar","frequency":"daily","interval":1,"timeZone":"America/New_York","localTime":"02:30","anchorDate":"2026-03-07"}),
        ),
        (
            "new-york-fold",
            json!({"kind":"calendar","frequency":"daily","interval":1,"timeZone":"America/New_York","localTime":"01:30","anchorDate":"2026-10-31"}),
        ),
        (
            "shanghai-month31",
            json!({"kind":"calendar","frequency":"monthly","interval":1,"timeZone":"Asia/Shanghai","localTime":"09:00","anchorDate":"2026-01-31","monthDays":[31]}),
        ),
        (
            "shanghai-last-leap",
            json!({"kind":"calendar","frequency":"monthly","interval":1,"timeZone":"Asia/Shanghai","localTime":"09:00","anchorDate":"2028-01-31","monthDays":["last"]}),
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let seen = Arc::new(Observed::default());
        let expected: Vec<i64> = literals["cases"][name]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["at"].as_i64().unwrap())
            .collect();
        let schedule = plan(rule, json!({"kind":"skip","maxLatenessSeconds":300}));
        let mut e = open_calendar(dir.path(), seen.clone(), expected[0] - 1);
        let preview = rpc(
            &e,
            "areal/task/schedule/preview",
            json!({"schedule":schedule,"count":5}),
        )
        .await;
        assert_eq!(
            preview["occurrences"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v["at"].as_i64().unwrap())
                .collect::<Vec<_>>(),
            expected
        );
        let task = create_calendar(&e, name, schedule.clone()).await;
        for (i, at) in expected.iter().enumerate() {
            e.register_schedule_host(seen.clone()).await.unwrap();
            e.set_schedule_time(*at).unwrap();
            let t = wait_calendar(&e, &task["id"], i + 1, None).await;
            assert_eq!(t["runs"][i]["scheduledAt"], *at, "{name}");
            assert_eq!(t["runs"][i]["acceptedSchedule"]["scheduleV2"], schedule);
            assert_eq!(
                seen.goals.lock().unwrap().len(),
                i + 1,
                "independent model goal count"
            );
            assert_eq!(
                seen.prepares.lock().unwrap().len(),
                i + 1,
                "independent Host preparation count"
            );
            if name == "new-york-fold" && i == 1 {
                e.set_schedule_time(1793514600).unwrap();
                tokio::time::sleep(Duration::from_millis(1100)).await;
                let fold = rpc(&e, "areal/task/read", json!({"taskId":task["id"]})).await;
                assert_eq!(
                    fold["runs"].as_array().unwrap().len(),
                    2,
                    "later fold never admits"
                );
                assert_eq!(seen.prepares.lock().unwrap().len(), 2);
            }
            e.shutdown().await;
            drop(e);
            e = open_calendar(dir.path(), seen.clone(), *at);
        }
        let final_task = rpc(&e, "areal/task/read", json!({"taskId":task["id"]})).await;
        assert_eq!(
            final_task["runs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r["scheduledAt"].as_i64().unwrap())
                .collect::<Vec<_>>(),
            expected
        );
        e.shutdown().await;
    }
}
#[tokio::test]
async fn calendar_skip_window_and_coalesce_preserve_earliest_pending() {
    for late in [0, 1, 300, 301] {
        let dir = tempfile::tempdir().unwrap();
        let seen = Arc::new(Observed::default());
        let e = open_calendar(dir.path(), seen.clone(), 2000000000);
        let task = create_calendar(
            &e,
            "window",
            plan(
                json!({"kind":"once","at":2000000000}),
                json!({"kind":"skip","maxLatenessSeconds":300}),
            ),
        )
        .await;
        e.set_schedule_time(2000000000 + late).unwrap();
        assert_eq!(
            rpc(&e, "areal/task/read", json!({"taskId":task["id"]})).await["nextRunAt"],
            2000000000
        );
        e.register_schedule_host(seen.clone()).await.unwrap();
        let t = wait_calendar(
            &e,
            &task["id"],
            if late <= 300 { 1 } else { 0 },
            Some(if late <= 300 {
                "admitted"
            } else {
                "missedWindow"
            }),
        )
        .await;
        if late <= 300 {
            assert_eq!(t["runs"][0]["scheduledAt"], 2000000000);
        }
        assert_eq!(t["nextRunAt"], Value::Null);
        assert_eq!(t["lastTriggerDecision"]["originalScheduledAt"], 2000000000);
        assert_eq!(
            seen.prepares.lock().unwrap().len(),
            if late <= 300 { 1 } else { 0 }
        );
        e.shutdown().await;
    }
    let dir = tempfile::tempdir().unwrap();
    let seen = Arc::new(Observed::default());
    let e = open_calendar(dir.path(), seen.clone(), 2000000000);
    let task = create_calendar(
        &e,
        "coalesce",
        plan(
            json!({"kind":"interval","anchorAt":2000000000,"intervalSeconds":60}),
            json!({"kind":"coalesce"}),
        ),
    )
    .await;
    e.set_schedule_time(2000000301).unwrap();
    e.register_schedule_host(seen.clone()).await.unwrap();
    let t = wait_calendar(&e, &task["id"], 1, Some("admitted")).await;
    assert_eq!(t["runs"][0]["scheduledAt"], 2000000000);
    assert_eq!(t["nextRunAt"], 2000000360);
    assert_eq!(t["lastTriggerDecision"]["dueCount"], 6);
    e.shutdown().await;
}
#[tokio::test]
async fn calendar_original_civil_intent_receipt_and_accepted_rule_survive_edit() {
    let dir = tempfile::tempdir().unwrap();
    let seen = Arc::new(Observed::default());
    seen.hold.store(true, Ordering::SeqCst);
    let e = open_calendar(dir.path(), seen.clone(), 1792717199);
    let thread = e.create(e.default_cwd()).await.unwrap();
    let request = json!({"requestId":"civil-replay","mode":"scheduled","objective":"accepted objective","threadId":thread.id,"scheduleV2":plan(json!({"kind":"onceLocal","timeZone":"Asia/Shanghai","localTime":"09:00","date":{"kind":"next"}}),json!({"kind":"coalesce"}))});
    let task = rpc(&e, "areal/task/create", request.clone()).await;
    assert_eq!(task["nextRunAt"], 1792717200);
    e.register_schedule_host(seen.clone()).await.unwrap();
    e.set_schedule_time(1792717200).unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while seen.prepares.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let accepted = rpc(&e, "areal/task/read", json!({"taskId":task["id"]})).await;
    let edit=rpc(&e,"areal/task/update",json!({"requestId":"edit-accepted","taskId":task["id"],"expectedRevision":accepted["revision"],"objective":"future objective","scheduleV2":plan(json!({"kind":"once","at":1792976400}),json!({"kind":"skip","maxLatenessSeconds":300}))})).await;
    assert_eq!(edit["objective"], "future objective");
    assert_eq!(
        edit["scheduleV2"]["rule"],
        json!({"kind":"once","at":1792976400})
    );
    assert_eq!(edit["nextRunAt"], 1792976400);
    assert_eq!(edit["runs"], accepted["runs"]);
    assert_eq!(
        accepted["runs"][0]["acceptedSchedule"]["scheduleV2"]["rule"],
        json!({"kind":"once","at":1792717200})
    );
    assert_eq!(seen.prepares.lock().unwrap()[0]["scheduledAt"], 1792717200);
    assert_eq!(
        seen.prepares.lock().unwrap()[0]["runId"],
        accepted["runs"][0]["id"]
    );
    assert_eq!(seen.prepares.lock().unwrap()[0]["threadId"], thread.id);
    e.set_schedule_time(1792803600).unwrap();
    assert_eq!(
        rpc(&e, "areal/task/create", request.clone()).await,
        task,
        "receipt binds original civil intent"
    );
    seen.hold.store(false, Ordering::SeqCst);
    seen.release.notify_one();
    let done = wait_calendar(&e, &task["id"], 1, None).await;
    assert_eq!(
        done["runs"][0]["acceptedSchedule"],
        accepted["runs"][0]["acceptedSchedule"]
    );
    assert_eq!(done["runs"][0]["id"], accepted["runs"][0]["id"]);
    assert_eq!(done["runs"][0]["objective"], "accepted objective");
    assert_eq!(done["runs"][0]["scheduledAt"], 1792717200);
    let planned=rpc(&e,"areal/task/update",json!({"requestId":"manual-calendar-plan","taskId":task["id"],"expectedRevision":done["revision"],"scheduleV2":plan(json!({"kind":"calendar","frequency":"daily","timeZone":"America/New_York","localTime":"09:00","anchorDate":"2040-01-01","interval":1}),json!({"kind":"skip","maxLatenessSeconds":300}))})).await;
    let manual=rpc(&e,"areal/task/runNow",json!({"requestId":"manual-calendar","taskId":task["id"],"expectedRevision":planned["revision"]})).await;
    let manual_done = wait_calendar(&e, &task["id"], 2, None).await;
    assert_eq!(manual_done["runs"][1]["id"], manual["runId"]);
    assert_eq!(
        manual_done["runs"][1]["acceptedSchedule"]["scheduleV2"],
        planned["scheduleV2"]
    );
    assert_eq!(
        manual_done["runs"][1]["acceptedSchedule"]["scheduleV2"]["rule"]["timeZone"],
        "America/New_York"
    );
    assert!(
        manual_done["runs"][1]["acceptedSchedule"]
            .get("decision")
            .is_none()
    );
    assert_eq!(
        manual_done["lastTriggerDecision"],
        planned["lastTriggerDecision"]
    );
    assert_eq!(manual_done["nextRunAt"], planned["nextRunAt"]);
    e.shutdown().await;
    drop(e);
    let e = open_calendar(dir.path(), seen, 1792803600);
    assert_eq!(rpc(&e, "areal/task/create", request).await, task);
    e.shutdown().await;
}
#[tokio::test]
async fn calendar_periodic_miss_and_blocked_run_fails_without_overlap() {
    let dir = tempfile::tempdir().unwrap();
    let seen = Arc::new(Observed::default());
    let e = open_calendar(dir.path(), seen.clone(), 2000000000);
    let task = create_calendar(
        &e,
        "periodic-skip",
        plan(
            json!({"kind":"interval","anchorAt":2000000000,"intervalSeconds":60}),
            json!({"kind":"skip","maxLatenessSeconds":300}),
        ),
    )
    .await;
    e.set_schedule_time(2000000301).unwrap();
    e.register_schedule_host(seen.clone()).await.unwrap();
    let t = wait_calendar(&e, &task["id"], 0, Some("missedWindow")).await;
    assert_eq!(t["nextRunAt"], 2000000360);
    assert_eq!(t["lastTriggerDecision"]["dueCount"], 6);
    assert_eq!(t["skippedRuns"], 0);
    e.shutdown().await;
    let dir = tempfile::tempdir().unwrap();
    let seen = Arc::new(Observed::default());
    seen.block.store(true, Ordering::SeqCst);
    let e = open_calendar(dir.path(), seen.clone(), 2000000000);
    let task = create_calendar(
        &e,
        "blocked-overlap",
        plan(
            json!({"kind":"interval","anchorAt":2000000000,"intervalSeconds":60}),
            json!({"kind":"skip","maxLatenessSeconds":0}),
        ),
    )
    .await;
    e.register_schedule_host(seen.clone()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let t = rpc(&e, "areal/task/read", json!({"taskId":task["id"]})).await;
            if t["runs"][0]["status"] == "blocked" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    e.set_schedule_time(2000000301).unwrap();
    let t = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let t = rpc(&e, "areal/task/read", json!({"taskId":task["id"]})).await;
            if t["lastTriggerDecision"]["outcome"]["kind"] == "missedWindow" {
                break t;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    // 受阻的运行在下一次触发时结算为失败，不再把后续触发记为重叠。
    assert_eq!(t["runs"].as_array().unwrap().len(), 1);
    assert_eq!(t["runs"][0]["status"], "failed");
    assert_eq!(t["skippedRuns"], 0);
    assert_eq!(t["nextRunAt"], 2000000360);
    assert_eq!(seen.prepares.lock().unwrap().len(), 1);
    e.shutdown().await;
}
#[tokio::test]
async fn calendar_legacy_interval_stays_86400_and_receipt_survives_v4_migration() {
    let dir = tempfile::tempdir().unwrap();
    let seen = Arc::new(Observed::default());
    let e = open_calendar(dir.path(), seen.clone(), 1772868599);
    let thread = e.create(e.default_cwd()).await.unwrap();
    let request = json!({"requestId":"legacy-dst","mode":"scheduled","objective":"legacy","threadId":thread.id,"schedule":{"at":1772868600,"intervalSeconds":86400,"timeZone":"America/New_York"}});
    let task = rpc(&e, "areal/task/create", request.clone()).await;
    e.shutdown().await;
    drop(e);
    let root = dir.path().join("desktop/task-mode.json");
    let mut old: Value = serde_json::from_slice(&std::fs::read(&root).unwrap()).unwrap();
    old["version"] = json!(4);
    old.as_object_mut().unwrap().remove("schedules");
    let old_bytes = serde_json::to_vec(&old).unwrap();
    std::fs::write(&root, &old_bytes).unwrap();
    let mut e = open_calendar(dir.path(), seen.clone(), 1772868600);
    assert_eq!(rpc(&e, "areal/task/create", request.clone()).await, task);
    for (i, at) in [1772868600_i64, 1772955000, 1773041400]
        .into_iter()
        .enumerate()
    {
        e.set_schedule_time(at).unwrap();
        e.register_schedule_host(seen.clone()).await.unwrap();
        let t = wait_calendar(&e, &task["id"], i + 1, None).await;
        assert_eq!(t["runs"][i]["scheduledAt"], at);
        assert_eq!(t["nextRunAt"], at + 86400);
        assert_eq!(
            t["runs"][i]["acceptedSchedule"]["schedule"]["timeZone"],
            "America/New_York"
        );
        e.shutdown().await;
        drop(e);
        e = open_calendar(dir.path(), seen.clone(), at);
    }
    assert_eq!(rpc(&e, "areal/task/create", request).await, task);
    let upgraded: Value = serde_json::from_slice(&std::fs::read(root).unwrap()).unwrap();
    assert_eq!(upgraded["version"], 6);
    assert_eq!(upgraded["index_version"], 3);
    assert!(
        std::fs::read_dir(dir.path().join("desktop/task-legacy"))
            .unwrap()
            .any(|entry| std::fs::read(entry.unwrap().path()).unwrap() == old_bytes),
        "original root retained verbatim"
    );
    e.shutdown().await;
}
