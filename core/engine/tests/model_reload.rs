use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelStream},
};
use areal_protocol::Input;
use async_trait::async_trait;
use futures_util::stream;
use serde_json::json;
use std::{sync::Arc, time::Duration};
use tokio::sync::{Notify, mpsc};

struct Fixture {
    name: &'static str,
    calls: mpsc::UnboundedSender<String>,
    release: Arc<Notify>,
}
#[async_trait]
impl Model for Fixture {
    fn name(&self) -> &str {
        self.name
    }
    async fn stream(&self, messages: Vec<Message>) -> anyhow::Result<ModelStream> {
        let text = messages.last().unwrap().text_content();
        self.calls.send(format!("{}:{text}", self.name)).unwrap();
        let release = self.release.clone();
        Ok(Box::pin(stream::once(async move {
            if text == "hold" {
                release.notified().await;
            }
            Ok("done".into())
        })))
    }
}

async fn call(rx: &mut mpsc::UnboundedReceiver<String>) -> String {
    tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn reload_preserves_active_children_and_queued_requests_but_new_submissions_follow_default() {
    let root = tempfile::tempdir().unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let release = Arc::new(Notify::new());
    let a = Arc::new(Fixture {
        name: "a",
        calls: tx.clone(),
        release: release.clone(),
    });
    let b = Arc::new(Fixture {
        name: "b",
        calls: tx,
        release: release.clone(),
    });
    let engine = Engine::open(root.path(), a.clone(), Limits::default()).unwrap();
    engine.register_default_model("a".into(), a, true);
    let thread = engine.create("/workspace".into()).await.unwrap();
    engine
        .start(&thread.id, vec![Input::text("hold")])
        .await
        .unwrap();
    assert_eq!(call(&mut rx).await, "a:hold");
    engine.start_durable("owner".into(), serde_json::from_value(json!({"requestId":"queued","threadId":thread.id,"input":[{"type":"text","text":"queued"}]})).unwrap(), true).await.unwrap();
    engine.register_default_model("b".into(), b, true);
    let child = engine
        .spawn_child(&thread.id, vec![Input::text("child")])
        .await
        .unwrap();
    assert_eq!(call(&mut rx).await, "a:child");
    engine.wait(&child.0.id).await.unwrap();
    assert!(engine.drain("ifIdle".into(), 100).await.is_err());
    assert_eq!(engine.server_status().await["acceptingWork"], true);
    release.notify_one();
    assert_eq!(call(&mut rx).await, "a:queued");
    engine.wait(&thread.id).await.unwrap();
    engine
        .start(&thread.id, vec![Input::text("new")])
        .await
        .unwrap();
    assert_eq!(call(&mut rx).await, "b:new");
    let saved = engine.wait(&thread.id).await.unwrap();
    let revisions: Vec<_> = saved
        .turns
        .iter()
        .map(|t| {
            t.configuration
                .as_ref()
                .unwrap()
                .default_model_revision
                .as_deref()
        })
        .collect();
    assert_eq!(revisions, [Some("a"), Some("a"), Some("b")]);
    engine.shutdown().await;
}
