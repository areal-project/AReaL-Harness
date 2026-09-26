use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelFailure, ModelStream},
};
use areal_protocol::{Input, TurnStatus};
use async_trait::async_trait;
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

struct FailureModel {
    fault: Option<ModelFailure>,
    requests: AtomicUsize,
}
#[async_trait]
impl Model for FailureModel {
    fn name(&self) -> &str {
        "outcome-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        self.requests.fetch_add(1, Ordering::SeqCst);
        match self.fault {
            Some(fault) => Err(anyhow::Error::new(fault).context("model request failed")),
            None => std::future::pending().await,
        }
    }
}

#[tokio::test]
async fn terminal_codes_survive_events_storage_and_restart_without_completion_retry() {
    for (fault, idle, deadline, expected) in [
        (
            Some(ModelFailure::Truncated),
            5000,
            5000,
            "LLM_OUTPUT_TOKEN_LIMIT_EXCEEDED",
        ),
        (
            Some(ModelFailure::EmptyCompletion),
            5000,
            5000,
            "LLM_RESPONSE_FAILED",
        ),
        (None, 25, 5000, "LLM_RESPONSE_TIMEOUT"),
        (None, 5000, 25, "AGENT_RUN_TIMEOUT"),
    ] {
        let data = tempfile::tempdir().unwrap();
        let model = Arc::new(FailureModel {
            fault,
            requests: AtomicUsize::new(0),
        });
        let limits = Limits {
            max_completion_retries: 0,
            watchdog_disable: true,
            stream_idle_timeout: Duration::from_millis(idle),
            turn_timeout: Duration::from_millis(deadline),
            ..Limits::default()
        };
        let engine = Engine::open(data.path(), model.clone(), limits.clone()).unwrap();
        let thread = engine.create("/workspace".into()).await.unwrap();
        let mut events = engine.subscribe(&thread.id).await.unwrap();
        engine
            .start(&thread.id, vec![Input::text("fail once")])
            .await
            .unwrap();
        let done = tokio::time::timeout(Duration::from_secs(5), engine.wait(&thread.id))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(done.turns[0].status, TurnStatus::Failed);
        let error = done.turns[0].error.as_ref().unwrap();
        assert_eq!(error.outcome.as_ref().unwrap().code, expected);
        assert_eq!(model.requests.load(Ordering::SeqCst), 1);
        let event = std::iter::from_fn(|| events.try_recv().ok())
            .find(|v| v["method"] == "turn/completed")
            .unwrap();
        assert_eq!(
            event["params"]["turn"]["error"],
            serde_json::to_value(error).unwrap()
        );
        engine.shutdown().await;
        drop(engine);
        let restored = Engine::open(data.path(), model, limits).unwrap();
        let loaded = restored.read(&thread.id, true).await.unwrap();
        assert_eq!(
            serde_json::to_value(&loaded.turns[0].error).unwrap(),
            serde_json::to_value(error).unwrap()
        );
        restored.shutdown().await;
    }
}
