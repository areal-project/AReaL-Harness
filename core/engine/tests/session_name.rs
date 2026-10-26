use areal_engine::{
    Engine, Limits,
    model::{AgentStream, Message, Model, ModelEvent, ModelStream, RequestPurpose},
};
use areal_protocol::Input;
use async_trait::async_trait;
use futures_util::stream;
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;

struct NamingModel {
    summaries: AtomicUsize,
    output: Option<String>,
    started: Notify,
    release: Notify,
    hold: bool,
}
#[async_trait]
impl Model for NamingModel {
    fn name(&self) -> &str {
        "name-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        Ok(Box::pin(stream::iter([Ok(ModelEvent::text(
            "Solved unchanged",
        ))])))
    }
    async fn chat_limited(
        &self,
        messages: Vec<Message>,
        tools: Vec<Value>,
        purpose: RequestPurpose,
        cap: Option<u64>,
    ) -> anyhow::Result<AgentStream> {
        if purpose != RequestPurpose::Summary {
            return self.stream(messages).await;
        }
        assert!(tools.is_empty());
        assert_eq!(cap, Some(96));
        assert!(
            messages
                .iter()
                .map(|m| m.text_content().len())
                .sum::<usize>()
                < 18000
        );
        self.summaries.fetch_add(1, Ordering::SeqCst);
        self.started.notify_one();
        if self.hold {
            self.release.notified().await;
        }
        let output = self
            .output
            .clone()
            .ok_or_else(|| anyhow::anyhow!("provider failed"))?;
        Ok(Box::pin(stream::iter([Ok(ModelEvent::text(output))])))
    }
}
fn model(output: Option<&str>, hold: bool) -> Arc<NamingModel> {
    Arc::new(NamingModel {
        summaries: AtomicUsize::new(0),
        output: output.map(str::to_owned),
        started: Notify::new(),
        release: Notify::new(),
        hold,
    })
}
async fn started(m: &NamingModel) {
    tokio::time::timeout(Duration::from_secs(3), m.started.notified())
        .await
        .expect("automatic summary request");
}
async fn solve(e: &Arc<Engine>, id: &str, text: &str) -> Value {
    e.start(id, vec![Input::text(text)]).await.unwrap();
    serde_json::to_value(
        tokio::time::timeout(Duration::from_secs(3), e.wait(id))
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap()
}
async fn named(e: &Engine, id: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let t = serde_json::to_value(e.read(id, true).await.unwrap()).unwrap();
            if t.get("name").is_some() {
                break t;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn naming_opt_out_preserves_solves_and_persists_without_backfill() {
    let dir = tempfile::tempdir().unwrap();
    let m = model(Some("must not be requested"), false);
    let e = Engine::open(dir.path(), m.clone(), Limits::default()).unwrap();
    let t = e.create("/workspace".into()).await.unwrap();
    e.configure_thread(
        serde_json::from_value(json!({
            "threadId":t.id,"expectedRevision":1,
            "options":{"automaticSessionName":false}
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    let first = solve(&e, &t.id, "persist this ordinary session").await;
    assert_eq!(first["turns"][0]["status"], "completed");
    assert_eq!(first["ephemeral"], false);
    e.shutdown().await;
    drop(e);
    let e = Engine::open(dir.path(), m.clone(), Limits::default()).unwrap();
    let restored = serde_json::to_value(e.read(&t.id, true).await.unwrap()).unwrap();
    assert_eq!(
        restored["desktop"]["configuration"]["options"]["automaticSessionName"],
        false
    );
    assert_eq!(restored["turns"], first["turns"]);
    // 后续启用只改变未来配置，不能重写第一轮的关闭决定或补发命名。
    e.configure_thread(
        serde_json::from_value(json!({
            "threadId":t.id,"expectedRevision":restored["desktop"]["configuration"]["revision"],
            "options":{"automaticSessionName":true}
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    let resumed = solve(&e, &t.id, "resume normally").await;
    assert_eq!(resumed["turns"].as_array().unwrap().len(), 2);
    assert_eq!(resumed["turns"][0], first["turns"][0]);
    assert_eq!(resumed["turns"][1]["status"], "completed");
    e.shutdown().await;
    assert_eq!(m.summaries.load(Ordering::SeqCst), 0);
    drop(e);
    let reopened = Engine::open(dir.path(), m, Limits::default()).unwrap();
    let final_state = reopened.read(&t.id, true).await.unwrap();
    assert!(final_state.name.is_none());
    assert!(final_state.name_attempt_turn_id.is_none());
    reopened.shutdown().await;
}

#[tokio::test]
async fn explicit_naming_enabled_keeps_the_single_request_contract() {
    let dir = tempfile::tempdir().unwrap();
    let m = model(Some("Configured session"), false);
    let e = Engine::open(dir.path(), m.clone(), Limits::default()).unwrap();
    let t = e.create("/workspace".into()).await.unwrap();
    e.configure_thread(
        serde_json::from_value(json!({
            "threadId":t.id,"expectedRevision":1,
            "options":{"automaticSessionName":true}
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    solve(&e, &t.id, "use a session title").await;
    assert_eq!(named(&e, &t.id).await["name"], "Configured session");
    solve(&e, &t.id, "continue").await;
    e.shutdown().await;
    assert_eq!(m.summaries.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn name_is_nonblocking_preserves_turns_merges_latest_and_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    let m = model(Some("修复会话标题"), true);
    let e = Engine::open(dir.path(), m.clone(), Limits::default()).unwrap();
    let t = e.create("/workspace".into()).await.unwrap();
    let mut events = e.subscribe(&t.id).await.unwrap();
    let first = solve(&e, &t.id, "请优化 session 名称的语义总结").await;
    started(&m).await;
    assert_eq!(e.read(&t.id, true).await.unwrap().turns.len(), 1);
    let second = solve(&e, &t.id, "继续验证兼容性").await;
    assert_eq!(second["turns"][0], first["turns"][0]);
    m.release.notify_one();
    let result = named(&e, &t.id).await;
    assert_eq!(result["name"], "修复会话标题");
    let edited = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let event = events.recv().await.unwrap();
            if event["method"] == "areal/thread/edited" {
                break event;
            }
        }
    })
    .await
    .unwrap();
    assert!(areal_protocol::desktop::NOTIFICATIONS.contains(&edited["method"].as_str().unwrap()));
    assert_eq!(edited["params"]["threadId"], t.id);
    assert_eq!(edited["params"]["thread"], result);
    assert_eq!(result["turns"], second["turns"]);
    assert_eq!(result["preview"], first["preview"]);
    assert_eq!(m.summaries.load(Ordering::SeqCst), 1);
    let list = serde_json::to_value(e.list(None, 20, None).await.unwrap().0).unwrap();
    assert_eq!(list[0]["name"], result["name"]);
    e.shutdown().await;
    drop(e);
    let reopened = Engine::open(dir.path(), m.clone(), Limits::default()).unwrap();
    assert_eq!(
        serde_json::to_value(reopened.read(&t.id, false).await.unwrap()).unwrap()["name"],
        result["name"]
    );
    solve(&reopened, &t.id, "restart follow up").await;
    reopened.shutdown().await;
    assert_eq!(m.summaries.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn invalid_or_failed_names_keep_fallback_and_never_retry_after_restart() {
    for output in [
        None,
        Some(""),
        Some("first\nsecond"),
        Some("bad\0binary"),
        Some("data:application/octet-stream;base64,AAAA"),
        Some("abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuv"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let m = model(output, false);
        let e = Engine::open(dir.path(), m.clone(), Limits::default()).unwrap();
        let t = e.create("/workspace".into()).await.unwrap();
        let original = solve(&e, &t.id, "original fallback").await;
        started(&m).await;
        e.shutdown().await;
        drop(e);
        let e = Engine::open(dir.path(), m.clone(), Limits::default()).unwrap();
        let read = serde_json::to_value(e.read(&t.id, true).await.unwrap()).unwrap();
        assert!(read.get("name").is_none());
        assert_eq!(read["turns"], original["turns"]);
        assert_eq!(read["preview"], "original fallback");
        assert_eq!(read["nameAttemptTurnId"], original["turns"][0]["id"]);
        solve(&e, &t.id, "later turn").await;
        e.shutdown().await;
        assert_eq!(m.summaries.load(Ordering::SeqCst), 1);
    }
}
#[tokio::test]
async fn shutdown_cancels_pending_name_without_blocking_and_keeps_claim() {
    let dir = tempfile::tempdir().unwrap();
    let m = model(Some("late title"), true);
    let e = Engine::open(dir.path(), m.clone(), Limits::default()).unwrap();
    let t = e.create("/workspace".into()).await.unwrap();
    solve(&e, &t.id, "user task").await;
    started(&m).await;
    tokio::time::timeout(Duration::from_secs(2), e.shutdown())
        .await
        .unwrap();
    drop(e);
    let e = Engine::open(dir.path(), m.clone(), Limits::default()).unwrap();
    solve(&e, &t.id, "after cancelled request").await;
    e.shutdown().await;
    assert_eq!(m.summaries.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn old_thread_records_default_name_metadata() {
    let t: areal_protocol::Thread = serde_json::from_value(json!({"id":"old","sessionId":"old","parentThreadId":null,"preview":"old preview","modelProvider":"fixture","createdAt":0,"updatedAt":0,"status":{"type":"idle"},"cwd":"/","cliVersion":"old","source":"appServer","ephemeral":false,"turns":[]})).unwrap();
    let mut value = serde_json::to_value(t).unwrap();
    assert!(value.get("name").is_none());
    assert!(value.get("nameAttemptTurnId").is_none());
    let id = uuid::Uuid::new_v4().to_string();
    value["id"] = json!(id);
    value["sessionId"] = json!(id);
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join(format!("{id}.json")),
        serde_json::to_vec(&json!({"version":15,"thread":value})).unwrap(),
    )
    .unwrap();
    let m = model(Some("旧会话兼容性"), false);
    let e = Engine::open(dir.path(), m.clone(), Limits::default()).unwrap();
    let loaded = serde_json::to_value(e.read(&id, true).await.unwrap()).unwrap();
    assert!(loaded.get("name").is_none());
    assert!(loaded.get("nameAttemptTurnId").is_none());
    assert_eq!(loaded["preview"], "old preview");
    solve(&e, &id, "继续旧会话").await;
    assert_eq!(named(&e, &id).await["name"], "旧会话兼容性");
    e.shutdown().await;
}
