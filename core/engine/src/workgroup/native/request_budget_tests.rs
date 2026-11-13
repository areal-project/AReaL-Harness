use super::*;
use crate::model::RequestPurpose;

struct RecoveredFailure(AtomicUsize);
#[async_trait]
impl Model for RecoveredFailure {
    fn name(&self) -> &str {
        "recovered-failure"
    }
    async fn stream(&self, _: Vec<Message>) -> Result<ModelStream> {
        let event = match self.0.fetch_add(1, Ordering::SeqCst) {
            0 => Err(ModelFailure::Transport.into()),
            1 => Ok(ModelEvent::TextDelta("recovered result".into())),
            _ => Err(ModelFailure::Truncated.into()),
        };
        Ok(Box::pin(futures_util::stream::iter([event])))
    }
}

#[tokio::test]
async fn recovered_inference_does_not_retain_a_prior_failure_or_hide_a_new_failure() {
    let workspace = tempfile::tempdir().unwrap();
    let worker = ProgressModel {
        inner: Arc::new(RecoveredFailure(AtomicUsize::new(0))),
        stalled: Arc::new(AtomicBool::new(false)),
        failure: Arc::new(Mutex::new(None)),
        workspace: workspace.path().into(),
        successful: Mutex::new(SuccessfulTools::default()),
        context_bytes: 65536,
        context_audit: Mutex::new(vec![]),
        progress: Mutex::new(SourceProgress {
            hash: String::new(),
            edited: false,
            unchanged: 0,
            observed: false,
        }),
        max_unchanged_rounds: 0,
        command_tools_only: false,
    };
    for expected in [
        Some(ModelFailure::Transport),
        None,
        Some(ModelFailure::Truncated),
    ] {
        let mut stream = worker
            .stream(vec![Message::text("user", "work")])
            .await
            .unwrap();
        while stream.next().await.is_some() {}
        assert_eq!(*worker.failure.lock().unwrap(), expected);
    }
    assert!(!worker.stalled.load(Ordering::SeqCst));
}

struct FailedUsage(bool);
#[async_trait]
impl Model for FailedUsage {
    fn name(&self) -> &str {
        "failed-usage-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> Result<ModelStream> {
        let error = anyhow::Error::new(ModelFailure::Truncated);
        let error = if self.0 {
            error.context(crate::model::FinalUsageError)
        } else {
            error
        };
        Ok(Box::pin(futures_util::stream::iter([
            Ok(ModelEvent::Usage(ModelUsage {
                input_tokens: 20,
                cached_input_tokens: 5,
                output_tokens: 10,
            })),
            Err(error),
        ])))
    }
}
#[tokio::test]
async fn pool_accounts_terminal_failure_without_counting_it_as_success() {
    for finalized in [false, true] {
        let pool = SharedModel::new(Arc::new(FailedUsage(finalized)), 1, 4).unwrap();
        let mut stream = pool
            .chat_for(
                vec![Message::text("user", "summarize")],
                vec![],
                RequestPurpose::Summary,
            )
            .await
            .unwrap();
        assert!(stream.next().await.unwrap().is_ok());
        assert!(stream.next().await.unwrap().is_err());
        drop(stream);
        let usage = pool.usage();
        assert_eq!(usage.unknown_requests, usize::from(!finalized));
        assert_eq!(usage.input_tokens, if finalized { 20 } else { 0 });
        assert_eq!(pool.load().unwrap().completed_requests, 0);
    }
}

type ObservedBudget = (RequestPurpose, usize, usize, Option<u64>);
struct BudgetModel(Mutex<Vec<ObservedBudget>>);
#[async_trait]
impl Model for BudgetModel {
    fn name(&self) -> &str {
        "budget-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> Result<ModelStream> {
        panic!("budget forwarding was lost")
    }
    async fn chat_with_limits(
        &self,
        _: Vec<Message>,
        _: Vec<Value>,
        purpose: RequestPurpose,
        limits: ToolCallLimits,
        cap: Option<u64>,
    ) -> Result<ModelStream> {
        self.0
            .lock()
            .unwrap()
            .push((purpose, limits.max_calls, limits.max_buffer_bytes, cap));
        let error = crate::model::tool_index(&serde_json::json!({}), 1, 0, 0, 0).unwrap_err();
        Ok(Box::pin(futures_util::stream::iter([Err(error)])))
    }
}

#[tokio::test]
async fn worker_forwards_solve_and_summary_budgets_without_protocol_checkpoints() {
    let workspace = tempfile::tempdir().unwrap();
    let inner = Arc::new(BudgetModel(Mutex::new(Vec::new())));
    let worker = ProgressModel {
        inner: inner.clone(),
        stalled: Arc::new(AtomicBool::new(false)),
        failure: Arc::new(Mutex::new(None)),
        workspace: workspace.path().into(),
        successful: Mutex::new(SuccessfulTools::default()),
        context_bytes: 65536,
        context_audit: Mutex::new(vec![]),
        progress: Mutex::new(SourceProgress {
            hash: String::new(),
            edited: false,
            unchanged: 0,
            observed: false,
        }),
        max_unchanged_rounds: 0,
        command_tools_only: false,
    };
    for purpose in [RequestPurpose::Solve, RequestPurpose::Summary] {
        let mut stream = worker
            .chat_with_limits(
                vec![],
                vec![],
                purpose,
                ToolCallLimits {
                    require_call: false,
                    max_calls: 3,
                    max_buffer_bytes: 1234,
                },
                Some(567),
            )
            .await
            .unwrap();
        let error = stream.next().await.unwrap().unwrap_err();
        assert!(
            error
                .downcast_ref::<crate::model::ToolCallIndexError>()
                .is_some()
        );
        assert!(!crate::model::is_network_error(&error));
        assert!(worker.failure.lock().unwrap().is_none());
    }
    assert_eq!(
        *inner.0.lock().unwrap(),
        [
            (RequestPurpose::Solve, 3, 1234, Some(567)),
            (RequestPurpose::Summary, 3, 1234, Some(567))
        ]
    );
}
