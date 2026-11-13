use super::*;
struct FixtureModel;
#[async_trait::async_trait]
impl Model for FixtureModel {
    fn name(&self) -> &str {
        "checkpoint-reference-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<model::ModelStream> {
        unreachable!()
    }
}

#[tokio::test]
async fn checkpoint_reference_opt_in_respects_shared_allocation() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open(dir.path(), Arc::new(FixtureModel), Limits::default()).unwrap();
    let mut thread = engine.create("/fixture".into()).await.unwrap();
    let raw = json!({"path":"workspace://repo/reference.txt","sha256":"a".repeat(64),"source":"untrusted-protocol-middle".repeat(100)}).to_string();
    thread.turns.push(serde_json::from_value(json!({"id":"turn","status":"completed","error":null,"usage":null,"items":[
        {"type":"userMessage","id":"request","content":[{"type":"text","text":"preserve current requirements"}]},
        {"type":"dynamicToolCall","id":"read","callId":"read-call","tool":"read_file","arguments":{"path":"reference.txt"},"status":"completed","success":true,
        "execution":{"runtimeEpoch":"e","scopeId":"s","operationId":"read","outcome":"succeeded"},"contentItems":[{"type":"inputText","text":raw}]}
    ]})).unwrap());
    let original = serde_json::to_value(&thread).unwrap();
    let budget = ContextBudget {
        window: 16000,
        reserve: 2000,
        input_limit: 14000,
        target: 10000,
    };
    for reference_tokens in [0, 4096] {
        let planner = ContextPlan {
            budget: &budget,
            overhead_tokens: 128,
            byte_target: None,
            store: &engine.store,
            reference_tokens,
            history_thinking: model::HistoryThinking::Preserve,
        };
        let (checkpoint, tokens, _) = planner
            .checkpoint(&thread, 2, "fallible summary", true)
            .unwrap();
        assert_eq!(
            checkpoint
                .evidence
                .iter()
                .any(|s| s.contains("untrusted-protocol-middle")),
            reference_tokens > 0
        );
        assert!(tokens <= budget.target);
        assert_eq!(serde_json::to_value(&thread).unwrap(), original);
        let tiny = ContextBudget {
            target: 1,
            ..budget
        };
        let planner = ContextPlan {
            budget: &tiny,
            ..planner
        };
        let (checkpoint, _, _) = planner
            .checkpoint(&thread, 2, "fallible summary", true)
            .unwrap();
        assert!(
            !checkpoint
                .evidence
                .iter()
                .any(|s| s.contains("untrusted-protocol-middle")),
            "实验预算不能绕过共享请求分配器"
        );
    }
    engine.shutdown().await;
}
