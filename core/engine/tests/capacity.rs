use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelStream},
};
use areal_protocol::{Input, TurnStatus};
use async_trait::async_trait;
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::watch;

struct LoadModel {
    entered: AtomicUsize,
    release: watch::Receiver<bool>,
}
#[async_trait]
impl Model for LoadModel {
    fn name(&self) -> &str {
        "capacity-fixture"
    }
    async fn stream(&self, messages: Vec<Message>) -> anyhow::Result<ModelStream> {
        let root = messages.last().unwrap().text_content() == "root";
        self.entered.fetch_add(1, Ordering::SeqCst);
        let mut release = self.release.clone();
        Ok(Box::pin(futures_util::stream::once(async move {
            if root {
                std::future::pending::<()>().await;
            }
            release.wait_for(|released| *released).await.unwrap();
            Ok("completed child".into())
        })))
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore = "full Core capacity benchmark with durable sessions; run explicitly"]
async fn ten_thousand_subagents_have_overlapping_model_calls_and_settle() {
    let count = 10_000;
    let dir = tempfile::tempdir().unwrap();
    let (release, receiver) = watch::channel(false);
    let model = Arc::new(LoadModel {
        entered: AtomicUsize::new(0),
        release: receiver,
    });
    let engine = Engine::open(
        dir.path(),
        model.clone(),
        Limits {
            max_threads: count + 1,
            model_concurrency: count + 1,
            max_active_turns: count + 1,
            max_children_per_turn: count,
            turn_timeout: Duration::from_secs(600),
            stream_idle_timeout: Duration::from_secs(600),
            ..Limits::default()
        },
    )
    .unwrap();
    let root = engine.create("/capacity".into()).await.unwrap();
    let root_turn = engine
        .start(&root.id, vec![Input::text("root")])
        .await
        .unwrap();
    let start = Instant::now();
    let mut ids = Vec::with_capacity(count);
    for _ in 0..count {
        ids.push(
            engine
                .spawn_child(&root.id, vec![Input::text("child")])
                .await
                .unwrap()
                .0
                .id,
        );
    }
    tokio::time::timeout(Duration::from_secs(30), async {
        while model.entered.load(Ordering::SeqCst) != count + 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let admission_ms = start.elapsed().as_millis();
    tokio::time::sleep(Duration::from_secs(1)).await;
    let finishing = Instant::now();
    release.send_replace(true);
    for id in &ids {
        let thread = tokio::time::timeout(Duration::from_secs(120), engine.wait(id))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(thread.turns[0].status, TurnStatus::Completed);
    }
    let completion_ms = finishing.elapsed().as_millis();
    engine.interrupt(&root.id, &root_turn.id).await.unwrap();
    engine.wait(&root.id).await.unwrap();
    engine.shutdown().await;
    assert_eq!(
        std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|p| p.ok())
            .filter(|p| p.path().extension().is_some_and(|e| e == "json"))
            .count(),
        count + 1
    );
    println!(
        "subagents={count} overlapping_model_calls={} admission_ms={admission_ms} completion_ms={completion_ms} persistence=atomic-json-with-fsync model=in-process-gated-fixture workers=8",
        model.entered.load(Ordering::SeqCst)
    );
}
