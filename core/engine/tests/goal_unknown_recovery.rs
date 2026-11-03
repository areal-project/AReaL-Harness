use areal_engine::{
    Engine, Limits,
    model::{
        Message, Model, ModelCapabilities, ModelEvent, ModelFailure, ModelStream, RequestPurpose,
        ToolCall,
    },
};
use areal_protocol::{ModelUsage, goals::GoalCreate};
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

struct FlakyGoal {
    calls: AtomicUsize,
    failures: usize,
    bounds: bool,
    transient: bool,
}
#[async_trait]
impl Model for FlakyGoal {
    fn name(&self) -> &str {
        "bounded-goal-network-fixture"
    }
    fn capabilities(&self) -> ModelCapabilities {
        let mut capabilities = ModelCapabilities::text();
        if self.bounds {
            capabilities.context_window_tokens = Some(100_000);
            capabilities.max_output_tokens = Some(16_384);
        }
        capabilities
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat_limited(
        &self,
        messages: Vec<Message>,
        _: Vec<Value>,
        purpose: RequestPurpose,
        cap: Option<u64>,
    ) -> anyhow::Result<ModelStream> {
        if purpose != RequestPurpose::Solve {
            return Ok(Box::pin(stream::iter([
                Ok(ModelEvent::text("fixture title")),
                Ok(ModelEvent::Usage(ModelUsage {
                    input_tokens: 1,
                    output_tokens: 1,
                    cached_input_tokens: 0,
                })),
            ])));
        }
        assert!(cap.is_some_and(|n| n > 0 && n <= 16_384));
        let number = self.calls.fetch_add(1, Ordering::SeqCst);
        if number < self.failures {
            return if self.transient {
                Err(ModelFailure::Unavailable.into())
            } else {
                anyhow::bail!("permanent request configuration failure")
            };
        }
        let event = if number == self.failures {
            let goal: Value = messages
                .iter()
                .rev()
                .filter_map(|message| {
                    message
                        .text_content()
                        .split("Current authoritative goal: ")
                        .nth(1)
                        .and_then(|text| serde_json::from_str(text).ok())
                })
                .next()
                .unwrap();
            ModelEvent::ToolCall(ToolCall {id:"completion-report".into(),name:"goal_update".into(),arguments:json!({"expectedRevision":goal["revision"],"status":"complete","summary":"fixture delivery verified","evidence":["deterministic fixture completed"],"remaining":[]}).to_string()})
        } else {
            ModelEvent::text("Verified completion")
        };
        Ok(Box::pin(stream::iter([
            Ok(event),
            Ok(ModelEvent::Usage(ModelUsage {
                input_tokens: 10,
                output_tokens: 2,
                cached_input_tokens: 0,
            })),
        ])))
    }
}

async fn exercise(
    enabled: bool,
    failures: usize,
    bounds: bool,
    transient: bool,
    tokens: u64,
) -> (Value, usize, Vec<Value>) {
    let directory = tempfile::tempdir().unwrap();
    let model = Arc::new(FlakyGoal {
        calls: AtomicUsize::new(0),
        failures,
        bounds,
        transient,
    });
    let engine = Engine::open(
        directory.path(),
        model.clone(),
        Limits {
            max_completion_retries: 2,
            goal_recover_unknown_model_usage: enabled,
            watchdog_disable: true,
            ..Limits::default()
        },
    )
    .unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    engine
        .goal_create(
            "fixture".into(),
            GoalCreate {
                model_override: None,
                request_id: "create".into(),
                thread_id: thread.id.clone(),
                expected_revision: 0,
                objective: "Complete the deterministic fixture".into(),
                token_budget: Some(tokens),
                max_turns: Some(4),
                max_active_seconds: None,
                infer_limits: false,
                interaction_mode: None,
            },
        )
        .await
        .unwrap();
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let projection = engine.goal_get(&thread.id).await.unwrap();
            if projection["goal"]["status"] != "active"
                && projection["goal"]["activeTurnId"].is_null()
            {
                break projection;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    engine.shutdown().await;
    let goal_id = result["goal"]["id"].as_str().unwrap();
    let journal: Value = serde_json::from_slice(
        &std::fs::read(
            directory
                .path()
                .join("goals")
                .join(format!("{goal_id}.json")),
        )
        .unwrap(),
    )
    .unwrap();
    let requests = journal["requests"]
        .as_object()
        .unwrap()
        .values()
        .cloned()
        .collect();
    (result, model.calls.load(Ordering::SeqCst), requests)
}

#[tokio::test]
async fn explicit_recovery_preserves_unknown_and_its_full_bound_after_completion() {
    let (result, calls, requests) = exercise(true, 1, true, true, 400_000).await;
    assert_eq!(result["goal"]["status"], "completed", "{result}");
    assert_eq!(calls, 3);
    assert_eq!(result["goal"]["usage"]["unknownRequests"], 1);
    assert_eq!(result["goal"]["usage"]["accountingComplete"], false);
    assert_eq!(result["goal"]["usage"]["reservedTokens"], 116_384);
    assert_eq!(result["goal"]["usage"]["tokensUsed"], 24);
    let unknown: Vec<_> = requests.iter().filter(|r| r["unknown"] == true).collect();
    assert_eq!(unknown.len(), 1);
    assert_eq!(unknown[0]["acknowledged"], true);
    assert_eq!(unknown[0]["reserved"], 116_384);
    assert!(unknown[0]["usage"].is_null());
}

#[tokio::test]
async fn default_missing_bounds_permanent_errors_and_insufficient_budget_still_block() {
    for (enabled, bounds, transient, tokens) in [
        (false, true, true, 400_000),
        (true, false, true, 400_000),
        (true, true, false, 400_000),
        (true, true, true, 100_000),
    ] {
        let (result, calls, requests) = exercise(enabled, 1, bounds, transient, tokens).await;
        assert_eq!(result["goal"]["status"], "blocked", "{result}");
        assert_eq!(result["goal"]["reason"], "usageUnknown");
        assert_eq!(calls, 1);
        assert_eq!(result["goal"]["usage"]["unknownRequests"], 1);
        assert_eq!(result["goal"]["tokenBudget"], tokens);
        assert!(
            requests
                .iter()
                .filter(|r| r["unknown"] == true)
                .all(|r| r["acknowledged"] == false)
        );
    }
}

#[tokio::test]
async fn recovery_ceiling_is_the_existing_completion_allowance_and_keeps_all_attempts() {
    let (result, calls, requests) = exercise(true, 3, true, true, 600_000).await;
    assert_eq!(result["goal"]["status"], "blocked", "{result}");
    assert_eq!(calls, 3);
    assert_eq!(result["goal"]["usage"]["unknownRequests"], 3);
    assert_eq!(result["goal"]["usage"]["tokensUsed"], 0);
    assert_eq!(result["goal"]["usage"]["accountingComplete"], false);
    assert_eq!(
        requests
            .iter()
            .filter(|r| r["acknowledged"] == true)
            .count(),
        2
    );
    assert_eq!(requests.iter().filter(|r| r["unknown"] == true).count(), 3);
    assert_eq!(result["goal"]["tokenBudget"], 600_000);
}
