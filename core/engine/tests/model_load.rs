use anyhow::Result;
use areal_engine::{
    model::{Message, Model, ModelStream},
    workgroup::native::SharedModel,
};
use async_trait::async_trait;
use futures_util::StreamExt;
use std::{sync::Arc, time::Duration};

struct WaitingModel;
#[async_trait]
impl Model for WaitingModel {
    fn name(&self) -> &str {
        "load-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> Result<ModelStream> {
        Ok(Box::pin(futures_util::stream::pending()))
    }
}

#[tokio::test(start_paused = true)]
async fn permit_queue_and_stream_cancellation_leave_exact_load_counts() {
    let model = SharedModel::new(Arc::new(WaitingModel), 1, 10).unwrap();
    let stream = model.stream(vec![]).await.unwrap();
    let other = model.clone();
    let waiting = tokio::spawn(async move { other.stream(vec![]).await });
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(4)).await;
    let load = model.load().unwrap();
    assert_eq!(
        (load.in_flight, load.waiting, load.started_requests),
        (1, 1, 1)
    );
    assert_eq!(
        (load.queued_seconds, load.occupied_slot_seconds),
        (4.0, 4.0)
    );
    waiting.abort();
    let _ = waiting.await;
    assert_eq!(model.load().unwrap().waiting, 0);
    drop(stream);
    tokio::time::advance(Duration::from_secs(2)).await;
    let load = model.load().unwrap();
    assert_eq!(
        (load.in_flight, load.waiting, load.completed_requests),
        (0, 0, 0)
    );
    assert_eq!(
        (load.queued_seconds, load.occupied_slot_seconds),
        (4.0, 4.0)
    );
    assert_eq!(model.usage().requests, 1);
}

struct SetupModel {
    fail: bool,
}

struct BrokenStream;
#[async_trait]
impl Model for BrokenStream {
    fn name(&self) -> &str {
        "partial-usage-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> Result<ModelStream> {
        use areal_engine::model::{ModelEvent, ModelFailure};
        Ok(Box::pin(futures_util::stream::iter([
            Ok(ModelEvent::Usage(areal_protocol::ModelUsage {
                input_tokens: 10,
                output_tokens: 2,
                cached_input_tokens: 0,
            })),
            Err(ModelFailure::Incomplete.into()),
        ])))
    }
}

#[tokio::test]
async fn consuming_past_an_error_cannot_settle_partial_usage() {
    let model = SharedModel::new(Arc::new(BrokenStream), 1, 1).unwrap();
    let mut stream = model.stream(vec![]).await.unwrap();
    assert!(stream.next().await.unwrap().is_ok());
    assert!(stream.next().await.unwrap().is_err());
    assert!(stream.next().await.is_none());
    drop(stream);
    assert_eq!(model.usage().unknown_requests, 1);
    assert_eq!(model.usage().finished_requests, 0);
    assert_eq!(model.load().unwrap().completed_requests, 0);
    assert_eq!(model.load().unwrap().in_flight, 0);
}
#[async_trait]
impl Model for SetupModel {
    fn name(&self) -> &str {
        "setup-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> Result<ModelStream> {
        tokio::time::sleep(Duration::from_secs(2)).await;
        anyhow::ensure!(!self.fail, "fixture setup error");
        Ok(Box::pin(futures_util::stream::empty()))
    }
}

#[tokio::test(start_paused = true)]
async fn setup_error_cancellation_empty_eof_and_budget_rejection_settle_load() {
    for fail in [true, false] {
        let model = SharedModel::new(Arc::new(SetupModel { fail }), 1, 2).unwrap();
        let other = model.clone();
        let pending = tokio::spawn(async move { other.stream(vec![]).await });
        tokio::task::yield_now().await;
        assert_eq!(model.load().unwrap().in_flight, 1);
        pending.abort();
        let _ = pending.await;
        assert_eq!(model.load().unwrap().in_flight, 0);
        match model.stream(vec![]).await {
            Ok(mut stream) => {
                assert!(!fail);
                assert!(stream.next().await.is_none());
                assert!(stream.next().await.is_none());
            }
            Err(_) => assert!(fail),
        }
        assert!(model.stream(vec![]).await.is_err());
        let load = model.load().unwrap();
        assert_eq!(
            (load.in_flight, load.waiting, load.started_requests),
            (0, 0, 2)
        );
        assert_eq!(load.completed_requests, u64::from(!fail));
        // Completed without usage is still unknown usage, not zero tokens.
        assert_eq!(model.usage().unknown_requests, 2);
    }
}
