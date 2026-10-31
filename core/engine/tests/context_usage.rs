use areal_engine::{
    Engine, Limits,
    model::{AgentStream, Message, Model, ModelEvent, ModelStream},
};
use areal_protocol::{Input, ModelUsage, desktop::Provider};
use async_trait::async_trait;
use futures_util::stream;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

struct UsageModel;
#[async_trait]
impl Model for UsageModel {
    fn name(&self) -> &str {
        "usage-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, _: Vec<Value>) -> anyhow::Result<AgentStream> {
        let mode = messages.last().unwrap().text_content();
        let events = match mode.as_str() {
            "single" => vec![
                Ok(ModelEvent::text("one response")),
                Ok(ModelEvent::Usage(ModelUsage {
                    input_tokens: 30,
                    cached_input_tokens: 10,
                    output_tokens: 90,
                })),
            ],
            "zero" => vec![
                Ok(ModelEvent::text("known zero")),
                Ok(ModelEvent::Usage(ModelUsage::default())),
            ],
            "unknown" => vec![Ok(ModelEvent::text("usage absent"))],
            "error" => vec![
                Ok(ModelEvent::text("first")),
                Ok(ModelEvent::text("second")),
                Ok(ModelEvent::Usage(ModelUsage {
                    input_tokens: 30,
                    cached_input_tokens: 10,
                    output_tokens: 90,
                })),
                Err(anyhow::anyhow!("fixture failure")),
            ],
            _ => vec![
                Ok(ModelEvent::text("first")),
                Ok(ModelEvent::text("second")),
                Ok(ModelEvent::Usage(ModelUsage {
                    input_tokens: 30,
                    cached_input_tokens: 10,
                    output_tokens: 10,
                })),
            ],
        };
        Ok(Box::pin(stream::unfold(
            events.into_iter(),
            |mut events| async move {
                let event = events.next()?;
                tokio::time::sleep(Duration::from_millis(15)).await;
                Some((event, events))
            },
        )))
    }
}

#[tokio::test]
async fn selected_capacity_changes_without_a_request_and_omitted_parameters_reset() {
    let data = tempfile::tempdir().unwrap();
    let engine = Engine::open(data.path(), Arc::new(UsageModel), Limits::default()).unwrap();
    for (id, capacity) in [("alpha", 64000), ("beta", 128000)] {
        engine.upsert_provider(serde_json::from_value::<Provider>(json!({"id":id,"revision":0,"endpoint":"http://127.0.0.1:9/v1","protocol":"chatCompletions","models":["same-name"],"parameters":{"contextWindowTokens":capacity}})).unwrap(), 0).await.unwrap();
    }
    let thread = engine.create("/workspace".into()).await.unwrap();
    for (revision, provider, capacity) in [(1, "alpha", 64000), (2, "beta", 128000)] {
        let config = engine.configure_thread(serde_json::from_value(json!({"threadId":thread.id,"expectedRevision":revision,"model":{"providerId":provider,"modelId":"same-name"}})).unwrap()).await.unwrap();
        assert_eq!(config.parameters.context_window_tokens, Some(capacity));
        let context = engine.context_read(&thread.id, 0, 16).await.unwrap();
        assert_eq!(context["budget"]["windowTokens"], capacity);
        assert_eq!(context["contextUsage"]["basis"]["provider"], provider);
    }
    engine.shutdown().await;
}

#[tokio::test]
async fn paired_rate_keeps_invalid_request_usage_and_survives_reopen() {
    let data = tempfile::tempdir().unwrap();
    let engine = Engine::open(data.path(), Arc::new(UsageModel), Limits::default()).unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    for mode in ["normal", "single", "error", "unknown", "zero"] {
        engine
            .start(&thread.id, vec![Input::text(mode)])
            .await
            .unwrap();
        engine.wait(&thread.id).await.unwrap();
    }
    let saved = serde_json::to_value(engine.read(&thread.id, true).await.unwrap()).unwrap();
    assert_eq!(saved["turns"][0]["usage"]["outputTokens"], 10);
    assert_eq!(saved["turns"][0]["generation"]["outputTokens"], 10);
    assert!(
        saved["turns"][0]["generation"]["durationMs"]
            .as_u64()
            .unwrap()
            >= 15
    );
    for index in [1, 2, 3, 4] {
        assert_eq!(saved["turns"][index]["generation"]["measuredRequests"], 0);
        assert_eq!(saved["turns"][index]["generation"]["unmeasuredRequests"], 1);
    }
    assert_eq!(saved["turns"][1]["usage"]["outputTokens"], 90);
    assert_eq!(saved["turns"][2]["usage"]["outputTokens"], 90);
    assert!(saved["turns"][3]["usage"].is_null());
    assert_eq!(saved["turns"][4]["usage"]["outputTokens"], 0);
    let context = engine.context_read(&thread.id, 0, 16).await.unwrap();
    assert_eq!(context["sessionUsage"]["knownTurns"], 4);
    assert_eq!(context["sessionUsage"]["unknownTurns"], 1);
    assert_eq!(context["sessionUsage"]["usage"]["inputTokens"], 90);
    assert_eq!(context["sessionUsage"]["usage"]["outputTokens"], 190);
    let estimate = &context["contextUsage"]["estimate"];
    let sum: u64 = estimate["parts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|part| part["estimatedTokens"].as_u64().unwrap())
        .sum();
    assert_eq!(sum, estimate["tokens"].as_u64().unwrap());
    let fork = engine.fork_thread("fixture".into(), serde_json::from_value(json!({"requestId":"usage-fork","sourceThreadId":thread.id,"anchor":{"turnId":saved["turns"][0]["id"],"boundary":"after"},"workspaceMode":"sharedCurrent"})).unwrap()).await.unwrap();
    let fork_reading = engine.context_read(&fork.id, 0, 16).await.unwrap();
    assert_eq!(fork_reading["sessionUsage"]["knownTurns"], 0);
    assert!(
        fork_reading["sessionUsage"]["usage"].is_null(),
        "inherited usage must not become this session's spend"
    );
    engine
        .start(&fork.id, vec![Input::text("normal")])
        .await
        .unwrap();
    engine.wait(&fork.id).await.unwrap();
    let fork_reading = engine.context_read(&fork.id, 0, 16).await.unwrap();
    assert_eq!(fork_reading["sessionUsage"]["usage"]["inputTokens"], 30);
    assert_eq!(
        fork_reading["sessionUsage"]["generation"]["measuredRequests"],
        1
    );
    engine.shutdown().await;
    drop(engine);
    let engine = Engine::open(data.path(), Arc::new(UsageModel), Limits::default()).unwrap();
    assert_eq!(
        serde_json::to_value(engine.read(&thread.id, true).await.unwrap()).unwrap(),
        saved
    );
    engine.shutdown().await;
}

struct ReusedCallModel;
#[async_trait]
impl Model for ReusedCallModel {
    fn name(&self) -> &str {
        "reused-call-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, _: Vec<Value>) -> anyhow::Result<AgentStream> {
        let last = messages.last().unwrap();
        let event = if last.role == "tool" {
            ModelEvent::text("done")
        } else {
            let (name, arguments) = if last.text_content() == "skill" {
                (
                    "skill_read",
                    json!({"skill":{"id":"fixture","revision":"v1"},"resource":"SKILL.md","offset":0,"maxBytes":8192}),
                )
            } else {
                ("plan_read", json!({}))
            };
            ModelEvent::ToolCall(areal_engine::model::ToolCall {
                id: "reused".into(),
                name: name.into(),
                arguments: arguments.to_string(),
            })
        };
        Ok(Box::pin(stream::iter([Ok(event)])))
    }
}

#[tokio::test]
async fn reused_call_id_cannot_classify_an_ordinary_result_as_skill_text() {
    let data = tempfile::tempdir().unwrap();
    let skill = tempfile::tempdir().unwrap();
    std::fs::write(
        skill.path().join("SKILL.md"),
        "Use the fixture skill carefully.",
    )
    .unwrap();
    let engine = Engine::open(data.path(), Arc::new(ReusedCallModel), Limits::default()).unwrap();
    engine
        .install_default_skills(vec![areal_engine::desktop::SkillLocation {
            id: "fixture".into(),
            revision: "v1".into(),
            root: skill.path().into(),
            metadata: None,
        }])
        .unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    let mut skills = Vec::new();
    for prompt in ["skill", "ordinary"] {
        engine
            .start(&thread.id, vec![Input::text(prompt)])
            .await
            .unwrap();
        engine.wait(&thread.id).await.unwrap();
        let saved = engine.read(&thread.id, true).await.unwrap();
        assert!(
            saved
                .turns
                .last()
                .unwrap()
                .items
                .iter()
                .any(|item| matches!(
                    item,
                    areal_protocol::Item::DynamicToolCall {
                        success: Some(true),
                        ..
                    }
                )),
            "fixture must execute the actual tool"
        );
        let reading = engine.context_read(&thread.id, 0, 16).await.unwrap();
        let estimate = &reading["contextUsage"]["estimate"];
        let parts = estimate["parts"].as_array().unwrap();
        assert_eq!(
            parts
                .iter()
                .map(|p| p["estimatedTokens"].as_u64().unwrap())
                .sum::<u64>(),
            estimate["tokens"].as_u64().unwrap()
        );
        skills.push(
            parts.iter().find(|p| p["kind"] == "skills").unwrap()["estimatedTokens"]
                .as_u64()
                .unwrap(),
        );
    }
    assert!(
        skills[1] <= skills[0],
        "ordinary result with reused call ID must not add Skills tokens: {skills:?}"
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn account_model_capacity_overrides_public_default_and_survives_reopen() {
    let data = tempfile::tempdir().unwrap();
    let engine = Engine::open(data.path(), Arc::new(UsageModel), Limits::default()).unwrap();
    let provider = json!({"id":"account","revision":0,"endpoint":"http://127.0.0.1:9/v1","protocol":"responses","models":["gpt-6.1-sol","gpt-6-sol"],"parameters":{},"modelParameters":{"gpt-6.1-sol":{"contextWindowTokens":500000},"gpt-6-sol":{"contextWindowTokens":272000}}});
    engine
        .upsert_provider(
            serde_json::from_value::<Provider>(provider.clone()).unwrap(),
            0,
        )
        .await
        .unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    for (revision, model, capacity) in [(1, "gpt-6.1-sol", 500000), (2, "gpt-6-sol", 272000)] {
        engine.configure_thread(serde_json::from_value(json!({"threadId":thread.id,"expectedRevision":revision,"model":{"providerId":"account","modelId":model}})).unwrap()).await.unwrap();
        assert_eq!(
            engine.context_read(&thread.id, 0, 16).await.unwrap()["budget"]["windowTokens"],
            capacity
        );
    }
    engine.configure_thread(serde_json::from_value(json!({"threadId":thread.id,"expectedRevision":3,"model":{"providerId":"account","modelId":"gpt-6.1-sol"},"parameters":{"contextWindowTokens":64000}})).unwrap()).await.unwrap();
    assert_eq!(
        engine.context_read(&thread.id, 0, 16).await.unwrap()["budget"]["windowTokens"],
        64000
    );
    let mut invalid = provider;
    invalid["modelParameters"]["unknown"] = json!({"contextWindowTokens":500000});
    assert!(
        engine
            .upsert_provider(serde_json::from_value(invalid).unwrap(), 1)
            .await
            .is_err()
    );
    engine.shutdown().await;
    drop(engine);
    let engine = Engine::open(data.path(), Arc::new(UsageModel), Limits::default()).unwrap();
    assert_eq!(
        engine.context_read(&thread.id, 0, 16).await.unwrap()["budget"]["windowTokens"],
        64000
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn existing_session_uses_current_report_without_rewriting_accepted_context() {
    let data = tempfile::tempdir().unwrap();
    let engine = Engine::open(
        data.path(),
        Arc::new(UsageModel),
        Limits {
            watchdog_disable: true,
            ..Limits::default()
        },
    )
    .unwrap();
    let provider = json!({"id":"account","revision":0,"endpoint":"http://127.0.0.1:9/v1","protocol":"responses","models":["gpt-6.1-sol"],"parameters":{}});
    engine
        .upsert_provider(serde_json::from_value(provider.clone()).unwrap(), 0)
        .await
        .unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    engine.configure_thread(serde_json::from_value(json!({"threadId":thread.id,"expectedRevision":1,"model":{"providerId":"account","modelId":"gpt-6.1-sol"}})).unwrap()).await.unwrap();
    engine
        .edit_queue(thread.id.clone(), 0, "pause".into(), json!({}))
        .await
        .unwrap();
    engine.start_durable("fixture".into(), serde_json::from_value(json!({"threadId":thread.id,"requestId":"accepted-before-report","input":[{"type":"text","text":"queued"}]})).unwrap(), true).await.unwrap();
    let accepted = serde_json::to_value(engine.queue(&thread.id).await.unwrap()).unwrap()["items"]
        [0]["configuration"]
        .clone();
    let mut current = provider;
    current["modelParameters"] = json!({"gpt-6.1-sol":{"contextWindowTokens":500000}});
    engine
        .upsert_provider(serde_json::from_value(current).unwrap(), 1)
        .await
        .unwrap();
    let context = engine.context_read(&thread.id, 0, 16).await.unwrap();
    assert_eq!(context["budget"]["windowTokens"], 500000);
    assert_eq!(context["budget"]["reportedWindowTokens"], 500000);
    assert_eq!(context["budget"]["windowSource"], "provider");
    assert_eq!(
        serde_json::to_value(engine.queue(&thread.id).await.unwrap()).unwrap()["items"][0]["configuration"],
        accepted
    );
    engine
        .edit_queue(thread.id.clone(), 2, "resume".into(), json!({}))
        .await
        .unwrap();
    for _ in 0..200 {
        if !engine
            .read(&thread.id, true)
            .await
            .unwrap()
            .turns
            .is_empty()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    engine.wait(&thread.id).await.unwrap();
    let saved = engine.read(&thread.id, true).await.unwrap();
    assert_eq!(
        serde_json::to_value(saved.turns[0].configuration.as_ref().unwrap()).unwrap(),
        accepted
    );
    let old_turn = serde_json::to_value(&saved.turns[0]).unwrap();
    let next = engine
        .start(&thread.id, vec![Input::text("next request")])
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(next.configuration).unwrap()["contextWindow"]["reportedWindowTokens"],
        500000
    );
    engine.wait(&thread.id).await.unwrap();
    assert_eq!(
        serde_json::to_value(&engine.read(&thread.id, true).await.unwrap().turns[0]).unwrap(),
        old_turn
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn account_defaults_allow_user_overrides_and_missing_reports_use_subscription_defaults() {
    let data = tempfile::tempdir().unwrap();
    let engine = Engine::open(
        data.path(),
        Arc::new(UsageModel),
        Limits {
            watchdog_disable: true,
            ..Limits::default()
        },
    )
    .unwrap();
    let provider = json!({"id":"account","revision":0,"endpoint":"http://127.0.0.1:9/v1","protocol":"responses","models":["gpt-6.1-sol","gpt-6-sol","gpt-6.1-terra","unlisted"],"contextSource":"account","parameters":{},"modelParameters":{"gpt-6.1-sol":{"contextWindowTokens":500000}}});
    engine
        .upsert_provider(serde_json::from_value(provider).unwrap(), 0)
        .await
        .unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    for (revision, model, budget, expected, source) in [
        (1, "gpt-6.1-sol", 64000, 64000, "user"),
        (2, "gpt-6.1-sol", 900000, 900000, "user"),
        (3, "gpt-6.1-sol", 0, 500000, "account"),
        (4, "gpt-6-sol", 0, 272000, "modelDefault"),
        (5, "gpt-6.1-terra", 0, 500000, "modelDefault"),
        (6, "unlisted", 0, 131072, "fallback"),
    ] {
        let parameters = if budget == 0 {
            json!({})
        } else {
            json!({"contextWindowTokens":budget})
        };
        engine.configure_thread(serde_json::from_value(json!({"threadId":thread.id,"expectedRevision":revision,"model":{"providerId":"account","modelId":model},"parameters":parameters})).unwrap()).await.unwrap();
        let context = engine.context_read(&thread.id, 0, 16).await.unwrap();
        assert_eq!(context["budget"]["windowTokens"], expected);
        assert_eq!(context["budget"]["windowSource"], source);
        assert_eq!(
            context["budget"]["userBudgetTokens"],
            if budget == 0 {
                Value::Null
            } else {
                json!(budget)
            }
        );
        assert_eq!(
            context["budget"]["reportedWindowSource"],
            if model == "gpt-6.1-sol" {
                json!("account")
            } else {
                Value::Null
            }
        );
    }
    let legacy = engine.create("/workspace".into()).await.unwrap();
    engine.configure_thread(serde_json::from_value(json!({"threadId":legacy.id,"expectedRevision":1,"model":{"providerId":"account","modelId":"gpt-6.1-sol"},"parameters":{"contextWindowTokens":900000}})).unwrap()).await.unwrap();
    engine.shutdown().await;
    drop(engine);
    let path = data.path().join(format!("{}.json", legacy.id));
    let mut record: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    record["thread"]["desktop"]["configuration"]
        .as_object_mut()
        .unwrap()
        .remove("contextWindow");
    std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    let engine = Engine::open(
        data.path(),
        Arc::new(UsageModel),
        Limits {
            watchdog_disable: true,
            ..Limits::default()
        },
    )
    .unwrap();
    let mut provider = record["thread"]["desktop"]["configuration"]["provider"].clone();
    provider["modelParameters"]["gpt-6.1-sol"]["contextWindowTokens"] = json!(400000);
    engine
        .upsert_provider(serde_json::from_value(provider).unwrap(), 1)
        .await
        .unwrap();
    let context = engine.context_read(&legacy.id, 0, 16).await.unwrap();
    assert_eq!(context["budget"]["windowTokens"], 900000);
    assert_eq!(context["budget"]["reportedWindowTokens"], 400000);
    assert_eq!(context["budget"]["userBudgetTokens"], 900000);
    assert_eq!(context["budget"]["windowSource"], "user");
    let next = engine
        .start(&legacy.id, vec![Input::text("preserve saved budget")])
        .await
        .unwrap();
    assert_eq!(
        next.configuration.unwrap().parameters.context_window_tokens,
        Some(900000)
    );
    engine.wait(&legacy.id).await.unwrap();
    engine.shutdown().await;
}
