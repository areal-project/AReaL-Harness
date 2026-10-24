use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelEvent, ModelStream, RequestPurpose, ToolCall},
    tools::DynamicToolHost,
};
use areal_protocol::{
    DynamicToolResponse, Input, ModelUsage, ToolContent, ToolDefinition, TurnStatus,
};
use async_trait::async_trait;
use futures_util::stream;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

struct DelegatedHistory {
    attempts: Mutex<std::collections::HashMap<String, usize>>,
    summaries: std::sync::atomic::AtomicUsize,
}

#[async_trait]
impl Model for DelegatedHistory {
    fn name(&self) -> &str {
        "delegated-history-fixture"
    }
    async fn stream(&self, messages: Vec<Message>) -> anyhow::Result<ModelStream> {
        self.chat_for(messages, vec![], RequestPurpose::Solve).await
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<ModelStream> {
        self.chat_for(messages, tools, RequestPurpose::Solve).await
    }
    async fn chat_for(
        &self,
        messages: Vec<Message>,
        _: Vec<Value>,
        purpose: RequestPurpose,
    ) -> anyhow::Result<ModelStream> {
        if purpose == RequestPurpose::Summary {
            self.summaries
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            return Ok(Box::pin(stream::iter([Ok(ModelEvent::text(
                "Completed reference reads remain in the archive. Continue the original task.",
            ))])));
        }
        let prompt = messages
            .iter()
            .find(|m| m.role == "user")
            .unwrap()
            .text_content();
        let n = {
            let mut attempts = self.attempts.lock().unwrap();
            let n = attempts.entry(prompt.clone()).or_default();
            let before = *n;
            *n += 1;
            before
        };
        let call = |name: &str, args: Value| {
            ModelEvent::ToolCall(ToolCall {
                id: uuid::Uuid::new_v4().to_string(),
                name: name.into(),
                arguments: args.to_string(),
            })
        };
        if prompt == "coordinate" {
            let events = if n == 0 {
                (0..3).map(|worker| Ok(call("agent_spawn", json!({"prompt":format!("worker-{worker}"),"intent":"inspect","delivery":"report","maxModelRounds":64})))).collect::<Vec<_>>()
            } else {
                vec![Ok(ModelEvent::text("Integrated confirmed child results"))]
            };
            return Ok(Box::pin(stream::iter(events)));
        }
        // 每个子任务在已确认五次读操作后断流；失败流中的新调用不得执行。
        if n == 5 {
            return Ok(Box::pin(stream::iter([
                Ok(ModelEvent::text("discard interrupted draft")),
                Ok(call(
                    "agent_report",
                    json!({"summary":"must-not-execute","evidence":[],"remaining":[]}),
                )),
                Err(areal_engine::model::ModelFailure::Transport.into()),
            ])));
        }
        let completed = n - usize::from(n > 5);
        Ok(Box::pin(stream::iter([
            Ok(ModelEvent::text(
                "observed reference evidence. ".repeat(150),
            )),
            Ok(if completed < 32 {
                call(
                    "agent_report",
                    json!({"summary":format!("{prompt}: confirmed reference {completed}"),"evidence":[],"remaining":[]}),
                )
            } else {
                ModelEvent::text(format!("{prompt} confirmed all references"))
            }),
            Ok(ModelEvent::Usage(ModelUsage {
                input_tokens: 100,
                cached_input_tokens: 20,
                output_tokens: 10,
            })),
        ])))
    }
}

#[tokio::test]
async fn concurrent_long_children_compact_and_recover_without_replaying_failed_calls() {
    let data = tempfile::tempdir().unwrap();
    let model = Arc::new(DelegatedHistory {
        attempts: Mutex::new(Default::default()),
        summaries: Default::default(),
    });
    let pool = areal_engine::workgroup::native::SharedModel::pool(model.clone(), 1).unwrap();
    let engine = Engine::open(
        data.path(),
        pool.clone(),
        Limits {
            context_window_tokens: 16000,
            context_output_reserve_tokens: 2000,
            context_window_bytes: 0,
            max_agent_depth: 1,
            max_children_per_turn: 3,
            model_concurrency: 2,
            ..Limits::default()
        },
    )
    .unwrap();
    let parent = engine.create_with_tools("/workspace".into(), vec![ToolDefinition {
        name:"read_reference".into(), description:"Read one reference".into(),
        input_schema:json!({"type":"object","properties":{"index":{"type":"integer"}},"required":["index"]}), output_schema:None,
    }], Arc::new(References)).await.unwrap();
    engine
        .start(&parent.id, vec![Input::text("coordinate")])
        .await
        .unwrap();
    let result = tokio::time::timeout(std::time::Duration::from_secs(30), engine.wait(&parent.id))
        .await
        .unwrap()
        .unwrap();
    let children = engine.list(None, 10, Some(&parent.id)).await.unwrap().0;
    engine.shutdown().await;
    assert_eq!(
        result.turns[0].status,
        TurnStatus::Completed,
        "{:?}",
        result.turns[0].error
    );
    assert_eq!(children.len(), 3);
    for child in children {
        let child = engine.read(&child.id, true).await.unwrap();
        assert_eq!(
            child.turns[0].status,
            TurnStatus::Completed,
            "{:?}; checkpoint={:?}; attempts={:?}",
            child.turns[0].error,
            child.context_checkpoint,
            model.attempts.lock().unwrap()
        );
        assert!(child.context_checkpoint.as_ref().unwrap().compactions > 0);
        let calls: Vec<_> = child.turns[0]
            .items
            .iter()
            .filter_map(|i| match i {
                areal_protocol::Item::DynamicToolCall {
                    tool,
                    arguments,
                    success,
                    ..
                } if tool == "agent_report" => {
                    Some((arguments["summary"].as_str().unwrap().to_owned(), *success))
                }
                _ => None,
            })
            .collect();
        let first = serde_json::to_value(&child.turns[0].items[0]).unwrap();
        let prompt = first["content"][0]["text"].as_str().unwrap();
        assert_eq!(
            calls,
            (0..32)
                .map(|n| (format!("{prompt}: confirmed reference {n}"), Some(true)))
                .collect::<Vec<_>>()
        );
    }
    assert_eq!(pool.load().unwrap().in_flight, 0);
    assert!(model.summaries.load(std::sync::atomic::Ordering::SeqCst) >= 3);
}

struct CalibratedHistory {
    requests: Mutex<Vec<(RequestPurpose, Vec<Message>)>>,
}

#[async_trait]
impl Model for CalibratedHistory {
    fn name(&self) -> &str {
        "calibrated-history-fixture"
    }

    async fn stream(&self, messages: Vec<Message>) -> anyhow::Result<ModelStream> {
        self.chat_for(messages, vec![], RequestPurpose::Solve).await
    }

    async fn chat_for(
        &self,
        messages: Vec<Message>,
        _: Vec<Value>,
        purpose: RequestPurpose,
    ) -> anyhow::Result<ModelStream> {
        let n = {
            let mut requests = self.requests.lock().unwrap();
            let n = requests
                .iter()
                .filter(|(p, _)| *p == RequestPurpose::Solve)
                .count();
            requests.push((purpose, messages));
            n
        };
        let output = if purpose == RequestPurpose::Summary {
            ModelEvent::text(
                "Reference reads have completed. Continue from the recorded results; preserve the original task.",
            )
        } else if n < 32 {
            ModelEvent::ToolCall(ToolCall {
                id: format!("reference-{n}"),
                name: "read_reference".into(),
                arguments: json!({"index":n}).to_string(),
            })
        } else {
            ModelEvent::text("Verified all references")
        };
        // 实际 tokenizer 比保守估算小；每次追加仍然很小，累计原始估算最终越界。
        Ok(Box::pin(stream::iter([
            Ok(output),
            Ok(ModelEvent::Usage(ModelUsage {
                input_tokens: 100,
                cached_input_tokens: 20,
                output_tokens: 10,
            })),
        ])))
    }
}

struct References;

#[async_trait]
impl DynamicToolHost for References {
    fn id(&self) -> &str {
        "reference-fixture"
    }
    fn is_closed(&self) -> bool {
        false
    }
    async fn call(
        &self,
        request: Value,
        _: CancellationToken,
    ) -> anyhow::Result<DynamicToolResponse> {
        Ok(DynamicToolResponse {
            raw_mcp_result: None,
            success: true,
            structured_content: None,
            content_items: vec![ToolContent::InputText {
                text: format!(
                    "reference {}: {}",
                    request["arguments"]["index"],
                    "observed reference material. ".repeat(90)
                ),
            }],
        })
    }
}

#[tokio::test]
async fn calibrated_usage_cannot_skip_the_full_request_compaction_gate() {
    let data = tempfile::tempdir().unwrap();
    let model = Arc::new(CalibratedHistory {
        requests: Mutex::new(vec![]),
    });
    let engine = Engine::open(
        data.path(),
        model.clone(),
        Limits {
            context_window_tokens: 8000,
            context_output_reserve_tokens: 1000,
            context_window_bytes: 0,
            max_children_per_turn: 0,
            max_agent_depth: 0,
            ..Limits::default()
        },
    )
    .unwrap();
    let thread = engine.create_with_tools("/workspace".into(), vec![ToolDefinition {
        name: "read_reference".into(),
        description: "Read one reference".into(),
        input_schema: json!({"type":"object","properties":{"index":{"type":"integer"}},"required":["index"]}),
        output_schema: None,
    }], Arc::new(References)).await.unwrap();
    engine
        .start(
            &thread.id,
            vec![Input::text(
                "Original contract: inspect all 32 references and retain the evidence.",
            )],
        )
        .await
        .unwrap();
    let result = tokio::time::timeout(std::time::Duration::from_secs(20), engine.wait(&thread.id))
        .await
        .unwrap()
        .unwrap();
    engine.shutdown().await;
    assert_eq!(
        result.turns[0].status,
        TurnStatus::Completed,
        "{:?}",
        result.turns[0].error
    );
    assert!(result.context_checkpoint.as_ref().unwrap().compactions > 0);
    let requests = model.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .filter(|(p, _)| *p == RequestPurpose::Solve)
            .count(),
        33
    );
    assert!(requests.iter().any(|(p, _)| *p == RequestPurpose::Summary));
    assert_eq!(
        result.turns[0].usage.as_ref().unwrap().input_tokens,
        requests.len() as u64 * 100
    );
    let history = serde_json::to_string(&result).unwrap();
    for n in 0..32 {
        assert!(history.contains(&format!("reference {n}:")));
    }
    assert!(
        requests
            .last()
            .unwrap()
            .1
            .iter()
            .any(|m| m.role == "user" && m.text_content().contains("Original contract"))
    );
}
