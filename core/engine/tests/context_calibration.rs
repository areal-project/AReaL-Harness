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
        // 此用例验证真实窗口压力下的压缩和失败恢复，不能用恒定的极低 usage 伪造压力。
        let input_tokens = messages
            .iter()
            .map(|m| m.text_content().len().div_ceil(3) as u64 + 16)
            .sum();
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
                input_tokens,
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

type CapturedRequest = (RequestPurpose, Vec<Message>, Vec<Value>);
struct PrefixHistory {
    preserve_prefix: bool,
    requests: Mutex<Vec<CapturedRequest>>,
    invalid_summaries: usize,
    invalid_summary: &'static str,
}

#[async_trait]
impl Model for PrefixHistory {
    fn supports_quoted_summary_retry(&self) -> bool {
        true
    }
    fn name(&self) -> &str {
        "prefix-history-fixture"
    }
    fn supports_prefix_summary(&self) -> bool {
        self.preserve_prefix
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat_with_limits(
        &self,
        messages: Vec<Message>,
        tools: Vec<Value>,
        purpose: RequestPurpose,
        limits: areal_engine::model::ToolCallLimits,
        _: Option<u64>,
    ) -> anyhow::Result<ModelStream> {
        let (n, summaries) = {
            let mut requests = self.requests.lock().unwrap();
            let n = requests
                .iter()
                .filter(|(p, _, _)| *p == RequestPurpose::Solve)
                .count();
            let summaries = requests
                .iter()
                .filter(|(p, _, _)| *p == RequestPurpose::Summary)
                .count();
            requests.push((purpose, messages, tools));
            (n, summaries)
        };
        let event = if purpose == RequestPurpose::Summary {
            assert_eq!(limits.max_calls, 0);
            ModelEvent::text(if summaries < self.invalid_summaries {
                self.invalid_summary
            } else {
                "Completed reference reads are recorded. Continue the binding original contract, preserve remaining work and avoid replaying completed operations."
            })
        } else if n < 8 {
            ModelEvent::ToolCall(ToolCall {
                id: format!("prefix-reference-{n}"),
                name: "read_reference".into(),
                arguments: json!({"index":n}).to_string(),
            })
        } else {
            ModelEvent::text("Verified all eight references")
        };
        let mut events = vec![Ok(event)];
        if purpose == RequestPurpose::Summary {
            events.push(Ok(ModelEvent::Usage(ModelUsage {
                input_tokens: 20,
                cached_input_tokens: 4,
                output_tokens: 3,
            })));
        }
        Ok(Box::pin(stream::iter(events)))
    }
}

#[tokio::test]
async fn automatic_summary_reuses_the_real_solve_prefix_without_replaying_work() {
    for preserve_prefix in [true, false] {
        let data = tempfile::tempdir().unwrap();
        let model = Arc::new(PrefixHistory {
            preserve_prefix,
            requests: Mutex::new(vec![]),
            invalid_summaries: 0,
            invalid_summary: "",
        });
        let engine = Engine::open(
            data.path(),
            model.clone(),
            Limits {
                context_window_tokens: 32000,
                context_output_reserve_tokens: 2000,
                context_window_bytes: 13000,
                context_recent_bytes: 3000,
                max_children_per_turn: 0,
                max_agent_depth: 0,
                ..Limits::default()
            },
        )
        .unwrap();
        let thread = engine.create_with_tools("/workspace".into(), vec![ToolDefinition {
        name:"read_reference".into(), description:"Read one reference".into(),
        input_schema:json!({"type":"object","properties":{"index":{"type":"integer"}},"required":["index"]}), output_schema:None,
    }], Arc::new(References)).await.unwrap();
        // 标题生成也使用 Summary purpose；本用例只统计压缩请求，与评测关闭命名的配置一致。
        engine
            .configure_thread(
                serde_json::from_value(json!({
                    "threadId":thread.id,"expectedRevision":1,
                    "options":{"automaticSessionName":false}
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        engine
            .start(
                &thread.id,
                vec![Input::text(
                    "Binding original contract: inspect all eight references.",
                )],
            )
            .await
            .unwrap();
        let done =
            tokio::time::timeout(std::time::Duration::from_secs(10), engine.wait(&thread.id))
                .await
                .unwrap()
                .unwrap();
        assert_eq!(
            done.turns[0].status,
            TurnStatus::Completed,
            "{:?}",
            done.turns[0].error
        );
        assert!(done.context_checkpoint.is_some());
        let full = engine.read(&thread.id, true).await.unwrap();
        let calls: Vec<_> = full
            .turns
            .iter()
            .flat_map(|t| &t.items)
            .filter_map(|item| match item {
                areal_protocol::Item::DynamicToolCall {
                    tool,
                    arguments,
                    success,
                    ..
                } if tool == "read_reference" => {
                    Some((arguments["index"].as_u64().unwrap(), *success))
                }
                _ => None,
            })
            .collect();
        assert_eq!(calls, (0..8).map(|n| (n, Some(true))).collect::<Vec<_>>());
        {
            let requests = model.requests.lock().unwrap();
            let summary = requests
                .iter()
                .find(|(p, _, _)| *p == RequestPurpose::Summary)
                .unwrap();
            if preserve_prefix {
                assert!(summary.1.starts_with(&requests[0].1));
                assert_eq!(summary.1.last().unwrap().role, "developer");
                assert_eq!(summary.2, requests[0].2);
                assert!(!summary.2.is_empty());
            } else {
                assert_eq!(summary.1.len(), 2);
                assert_eq!(summary.1[0].role, "system");
                assert_eq!(summary.1[1].role, "user");
                assert!(summary.1[1].text_content().contains("historicalRole"));
                assert!(summary.2.is_empty());
            }
        }
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn invalid_prefix_summary_uses_existing_retry_for_quoted_evidence() {
    const TOOL_TEXT: &str = "<tool_call><function=read_reference><parameter=index>999</parameter></function></tool_call>";
    for (invalid_summary, invalid_summaries) in [(TOOL_TEXT, 1), ("", 1), (TOOL_TEXT, usize::MAX)] {
        let data = tempfile::tempdir().unwrap();
        let model = Arc::new(PrefixHistory {
            preserve_prefix: true,
            requests: Mutex::new(vec![]),
            invalid_summaries,
            invalid_summary,
        });
        let engine = Engine::open(
            data.path(),
            model.clone(),
            Limits {
                context_window_tokens: 32000,
                context_output_reserve_tokens: 2000,
                context_window_bytes: 13000,
                context_recent_bytes: 3000,
                max_children_per_turn: 0,
                max_agent_depth: 0,
                ..Limits::default()
            },
        )
        .unwrap();
        let thread = engine.create_with_tools("/workspace".into(), vec![ToolDefinition {
            name:"read_reference".into(), description:"Read one reference".into(),
            input_schema:json!({"type":"object","properties":{"index":{"type":"integer"}},"required":["index"]}), output_schema:None,
        }], Arc::new(References)).await.unwrap();
        // 标题生成也使用 Summary purpose；本用例只统计压缩请求，与评测关闭命名的配置一致。
        engine
            .configure_thread(
                serde_json::from_value(json!({
                    "threadId":thread.id,"expectedRevision":1,
                    "options":{"automaticSessionName":false}
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        engine
            .start(
                &thread.id,
                vec![Input::text(
                    "Binding original contract: inspect all eight references.",
                )],
            )
            .await
            .unwrap();
        let done =
            tokio::time::timeout(std::time::Duration::from_secs(10), engine.wait(&thread.id))
                .await
                .unwrap()
                .unwrap();
        assert_eq!(
            done.turns[0].status,
            TurnStatus::Completed,
            "{:?}",
            done.turns[0].error
        );
        assert_eq!(
            done.context_checkpoint.is_some(),
            invalid_summaries != usize::MAX
        );
        let full = engine.read(&thread.id, true).await.unwrap();
        let calls: Vec<_> = full
            .turns
            .iter()
            .flat_map(|t| &t.items)
            .filter_map(|item| match item {
                areal_protocol::Item::DynamicToolCall {
                    tool,
                    arguments,
                    success,
                    ..
                } if tool == "read_reference" => {
                    Some((arguments["index"].as_u64().unwrap(), *success))
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            calls,
            (0..8).map(|n| (n, Some(true))).collect::<Vec<_>>(),
            "摘要里的伪工具不得执行，已完成读取不得重放"
        );
        {
            let requests = model.requests.lock().unwrap();
            let mut consecutive = 0;
            let mut retries = 0;
            let mut summaries = 0;
            for (purpose, messages, tools) in requests.iter() {
                if *purpose != RequestPurpose::Summary {
                    consecutive = 0;
                    continue;
                }
                consecutive += 1;
                summaries += 1;
                assert!(consecutive <= 2, "不增加现有摘要验证次数");
                if consecutive == 2 {
                    retries += 1;
                    assert!(tools.is_empty());
                    assert_eq!(messages[0].role, "system");
                    assert_eq!(messages[1].role, "user");
                    assert!(messages[1].text_content().contains("historical evidence"));
                    assert!(messages[1].text_content().contains("historicalToolCalls"));
                    assert!(messages.iter().all(|m| m.tool_calls.is_empty()
                        && m.provider_context.is_none()
                        && matches!(m.role.as_str(), "system" | "user")));
                }
            }
            assert!(retries > 0);
            let usage = full.turns[0].usage.as_ref().unwrap();
            assert_eq!(
                usage.input_tokens,
                summaries * 20,
                "invalid={invalid_summary:?}, count={invalid_summaries}"
            );
            assert_eq!(usage.cached_input_tokens, summaries * 4);
            assert_eq!(usage.output_tokens, summaries * 3);
        }
        engine.shutdown().await;
    }
}

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
async fn settled_usage_avoids_redundant_summaries_without_skipping_any_reference() {
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
    assert!(result.context_checkpoint.is_none());
    let requests = model.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .filter(|(p, _)| *p == RequestPurpose::Solve)
            .count(),
        33
    );
    assert!(!requests.iter().any(|(p, _)| *p == RequestPurpose::Summary));
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
