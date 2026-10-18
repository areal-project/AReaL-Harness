//! 在实现前固定跨队列/活动轮次的并发与失败契约；真实 Engine、Store 与可控模型边界。
use areal_engine::{
    Engine, Error, Limits,
    model::{Message, Model, ModelStream},
};
use areal_protocol::{
    Input, Item,
    desktop::{QueueSteer, TurnStart},
};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::sync::mpsc;

struct Held(mpsc::UnboundedSender<()>);
#[async_trait]
impl Model for Held {
    fn name(&self) -> &str {
        "held-queue-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        let _ = self.0.send(());
        Ok(Box::pin(futures_util::stream::pending()))
    }
}
async fn setup() -> (tempfile::TempDir, Arc<Engine>, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let engine = Engine::open(dir.path(), Arc::new(Held(tx)), Limits::default()).unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    let turn = engine
        .start(&thread.id, vec![Input::text("hold")])
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .unwrap()
        .unwrap();
    (dir, engine, thread.id, turn.id)
}
async fn enqueue(engine: &Arc<Engine>, thread: &str, request: &str) -> Value {
    engine
        .start_durable(
            "owner".into(),
            serde_json::from_value::<TurnStart>(json!({
                "requestId":request,"threadId":thread,"input":[{"type":"text","text":request}]
            }))
            .unwrap(),
            true,
        )
        .await
        .unwrap()
}
fn request(thread: &str, turn: &str, queued: &Value, key: &str) -> QueueSteer {
    serde_json::from_value(
        json!({"requestId":key,"threadId":thread,"expectedTurnId":turn,
        "queueItemId":queued["queueItemId"],"expectedRevision":queued["queueRevision"]}),
    )
    .unwrap()
}
async fn stop(engine: &Engine, thread: &str, turn: &str) {
    engine.interrupt(thread, turn).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), engine.wait(thread))
        .await
        .unwrap()
        .unwrap();
}
fn user_inputs(thread: &areal_protocol::Thread, text: &str) -> usize {
    thread.turns.iter().flat_map(|t| &t.items).filter(|i| matches!(i, Item::UserMessage { content,.. } if content.iter().any(|p| matches!(p,Input::Text{text:value,..} if value==text)))).count()
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_transfer_is_once_and_receipt_survives_restart() {
    let (dir, engine, thread, turn) = setup().await;
    let queued = enqueue(&engine, &thread, "queued-once").await;
    let req = request(&thread, &turn, &queued, "transfer-once");
    let (a, b) = tokio::join!(
        engine.steer_queue("owner".into(), req.clone()),
        engine.steer_queue("owner".into(), req.clone())
    );
    assert_eq!(a.unwrap(), b.unwrap());
    let state = engine.read(&thread, true).await.unwrap();
    assert_eq!(user_inputs(&state, "queued-once"), 1);
    let q = engine.queue(&thread).await.unwrap();
    assert_eq!(q.items[0].status, "steered");
    assert_eq!(q.items[0].turn_id.as_deref(), Some(turn.as_str()));
    assert_eq!(q.revision, queued["queueRevision"].as_u64().unwrap() + 1);
    let other = request(&thread, &turn, &queued, "different-key");
    assert!(matches!(
        engine.steer_queue("owner".into(), other).await,
        Err(Error::Conflict)
    ));
    let mut altered = req.clone();
    altered.expected_turn_id = "other-turn".into();
    assert!(matches!(
        engine.steer_queue("owner".into(), altered).await,
        Err(Error::Conflict)
    ));
    let receipt = engine
        .request_status("owner", &thread, "transfer-once")
        .await
        .unwrap();
    assert_eq!(receipt["data"].as_array().unwrap().len(), 1);
    stop(&engine, &thread, &turn).await;
    engine.shutdown().await;
    drop(engine);
    let (tx, _rx) = mpsc::unbounded_channel();
    let restored = Engine::open(dir.path(), Arc::new(Held(tx)), Limits::default()).unwrap();
    let again = restored.steer_queue("owner".into(), req).await.unwrap();
    assert_eq!(again, receipt["data"][0]["result"]);
    assert_eq!(
        user_inputs(&restored.read(&thread, true).await.unwrap(), "queued-once"),
        1
    );
    restored.shutdown().await;
}
#[tokio::test]
async fn stale_revision_and_wrong_turn_preserve_pending_input() {
    let (_dir, engine, thread, turn) = setup().await;
    let queued = enqueue(&engine, &thread, "keep-pending").await;
    let mut req = request(&thread, "wrong-turn", &queued, "wrong-turn-key");
    assert!(matches!(
        engine.steer_queue("owner".into(), req.clone()).await,
        Err(Error::Conflict)
    ));
    req.expected_turn_id = turn.clone();
    req.expected_revision += 1;
    assert!(matches!(
        engine.steer_queue("owner".into(), req).await,
        Err(Error::Conflict)
    ));
    assert_eq!(
        engine.queue(&thread).await.unwrap().items[0].status,
        "pending"
    );
    assert_eq!(
        user_inputs(&engine.read(&thread, true).await.unwrap(), "keep-pending"),
        0
    );
    stop(&engine, &thread, &turn).await;
    engine.shutdown().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_race_never_loses_or_duplicates_queued_input() {
    let (_dir, engine, thread, turn) = setup().await;
    let queued = enqueue(&engine, &thread, "stop-race").await;
    let req = request(&thread, &turn, &queued, "stop-transfer");
    let (result, interrupted) = tokio::join!(
        engine.steer_queue("owner".into(), req),
        engine.interrupt(&thread, &turn)
    );
    interrupted.unwrap();
    engine.wait(&thread).await.unwrap();
    let q = engine.queue(&thread).await.unwrap();
    let n = user_inputs(&engine.read(&thread, true).await.unwrap(), "stop-race");
    match result {
        Ok(_) => {
            assert_eq!(q.items[0].status, "steered");
            assert_eq!(n, 1);
        }
        Err(Error::Conflict) => {
            assert_eq!(q.items[0].status, "pending");
            assert_eq!(n, 0);
        }
        other => panic!("{other:?}"),
    }
    engine.shutdown().await;
}
#[tokio::test]
async fn failed_store_write_keeps_queue_and_history_unmodified() {
    let (dir, engine, thread, turn) = setup().await;
    let queued = enqueue(&engine, &thread, "storage-pending").await;
    let moved = dir.path().with_extension("held");
    std::fs::rename(dir.path(), &moved).unwrap();
    std::fs::write(dir.path(), "block store directory").unwrap();
    let result = engine
        .steer_queue(
            "owner".into(),
            request(&thread, &turn, &queued, "failed-store"),
        )
        .await;
    std::fs::remove_file(dir.path()).unwrap();
    std::fs::rename(moved, dir.path()).unwrap();
    assert!(result.is_err());
    assert_eq!(
        engine.queue(&thread).await.unwrap().items[0].status,
        "pending"
    );
    assert_eq!(
        user_inputs(
            &engine.read(&thread, true).await.unwrap(),
            "storage-pending"
        ),
        0
    );
    assert!(
        engine
            .request_status("owner", &thread, "failed-store")
            .await
            .unwrap()["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    stop(&engine, &thread, &turn).await;
    engine.shutdown().await;
}
