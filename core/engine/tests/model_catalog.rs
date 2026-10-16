use areal_engine::{
    Engine, Limits,
    model::{
        HttpModel, Message, Model, ModelOptions, ModelProtocol, RequestPurpose, UnconfiguredModel,
    },
    tools::DynamicToolHost,
};
use areal_protocol::{DynamicToolResponse, Input, desktop::*};
use async_trait::async_trait;
use axum::{Json, Router, routing::post};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

struct NoTools;
#[async_trait]
impl DynamicToolHost for NoTools {
    fn id(&self) -> &str {
        "fixture"
    }
    fn is_closed(&self) -> bool {
        false
    }
    async fn call(&self, _: Value, _: CancellationToken) -> anyhow::Result<DynamicToolResponse> {
        unreachable!()
    }
}

async fn server() -> (
    String,
    tokio::sync::mpsc::UnboundedReceiver<Value>,
    tokio::task::JoinHandle<()>,
) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let app = Router::new().route("/", post(move |Json(request): Json<Value>| {
        let tx = tx.clone();
        async move {
            tx.send(request.clone()).unwrap();
            let data = if request.get("input").is_some() {
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"done\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n"
            } else {
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"done\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
            };
            ([("content-type", "text/event-stream")], data)
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let handle = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (endpoint, rx, handle)
}

#[tokio::test]
async fn max_and_ultra_send_max_for_both_protocols_and_summary_overrides_remain_independent() {
    let (endpoint, mut requests, server) = server().await;
    for protocol in [ModelProtocol::Responses, ModelProtocol::ChatCompletions] {
        for effort in ["max", "ultra"] {
            let model =
                HttpModel::with_protocol(endpoint.clone(), "fixture".into(), None, protocol)
                    .unwrap()
                    .with_options(ModelOptions {
                        reasoning_effort: Some(effort.into()),
                        summary_reasoning_effort: Some("low".into()),
                        ..Default::default()
                    })
                    .unwrap();
            for (purpose, expected) in [
                (RequestPurpose::Solve, "max"),
                (RequestPurpose::Summary, "low"),
            ] {
                let events = model
                    .chat_for(vec![Message::text("user", "work")], vec![], purpose)
                    .await
                    .unwrap()
                    .collect::<Vec<_>>()
                    .await;
                assert!(events.iter().all(Result::is_ok), "{events:?}");
                let request = requests.recv().await.unwrap();
                let value = if protocol == ModelProtocol::Responses {
                    &request["reasoning"]["effort"]
                } else {
                    &request["reasoning_effort"]
                };
                assert_eq!(value, expected);
            }
        }
    }
    server.abort();
}

#[tokio::test]
async fn upstream_model_capabilities_control_selection_and_refresh_preserves_frozen_turns() {
    let root = tempfile::tempdir().unwrap();
    let engine = Engine::open(root.path(), Arc::new(UnconfiguredModel), Limits::default()).unwrap();
    let (endpoint, mut requests, server) = server().await;
    let provider: Provider = serde_json::from_value(json!({
        "id":"fixture", "revision":0, "endpoint":endpoint, "protocol":"responses",
        "models":["sol", "luna"], "modelCapabilities":{
            "sol":{"displayName":"Fixture Sol","defaultReasoningEffort":"low","reasoningEffortOptions":["low","medium","high","xhigh","max","ultra"]},
            "luna":{"reasoningEffortOptions":["low","high","max"]}
        }
    })).unwrap();
    let provider = engine.upsert_provider(provider, 0).await.unwrap();
    let mut unknown = provider.clone();
    unknown
        .model_capabilities
        .get_mut("sol")
        .unwrap()
        .reasoning_effort_options
        .push("future_effort".into());
    assert!(
        engine
            .upsert_provider(unknown, provider.revision)
            .await
            .is_err()
    );
    let catalog = engine.model_catalog();
    let sol = catalog["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["modelId"] == "sol")
        .unwrap();
    assert_eq!(
        sol["reasoningEffortOptions"],
        json!(["low", "medium", "high", "xhigh", "max", "ultra"])
    );
    assert_eq!(sol["displayName"], "Fixture Sol");
    let start = |request: &str, model: &str, effort: Option<&str>| {
        serde_json::from_value::<ThreadStart>(json!({
            "requestId":request,"model":{"providerId":"fixture","modelId":model},
            "parameters": {"reasoningEffort":effort}
        }))
        .unwrap()
    };
    assert!(
        engine
            .create_configured(
                "owner".into(),
                start("bad", "luna", Some("ultra")),
                Arc::new(NoTools)
            )
            .await
            .is_err()
    );
    let thread = engine
        .create_configured(
            "owner".into(),
            start("main", "sol", Some("ultra")),
            Arc::new(NoTools),
        )
        .await
        .unwrap();
    let default = engine
        .create_configured(
            "owner".into(),
            start("default", "sol", None),
            Arc::new(NoTools),
        )
        .await
        .unwrap();
    assert_eq!(
        default
            .desktop
            .unwrap()
            .configuration
            .parameters
            .reasoning_effort
            .as_deref(),
        Some("low")
    );
    engine
        .start(&thread.id, vec![Input::text("work")])
        .await
        .unwrap();
    let complete = engine.wait(&thread.id).await.unwrap();
    let request = requests.recv().await.unwrap();
    assert_eq!(request["reasoning"]["effort"], "max");
    let instructions = complete.turns[0].instruction_snapshot.as_ref().unwrap();
    assert!(instructions.contains("Ultra mode was explicitly selected"));
    assert!(instructions.contains("does not grant permissions"));
    let frozen = complete.turns[0].configuration.clone();
    engine
        .start(&default.id, vec![Input::text("ordinary work")])
        .await
        .unwrap();
    let ordinary = engine.wait(&default.id).await.unwrap();
    assert_eq!(requests.recv().await.unwrap()["reasoning"]["effort"], "low");
    assert!(
        !ordinary.turns[0]
            .instruction_snapshot
            .as_ref()
            .unwrap()
            .contains("Ultra mode was explicitly selected")
    );
    let mut updated = provider.clone();
    updated
        .model_capabilities
        .get_mut("sol")
        .unwrap()
        .reasoning_effort_options = vec!["low".into(), "high".into()];
    engine
        .upsert_provider(updated, provider.revision)
        .await
        .unwrap();
    assert_eq!(
        engine.model_catalog()["data"][0]["reasoningEffortOptions"],
        json!(["low", "high"])
    );
    assert_eq!(
        engine.read(&thread.id, true).await.unwrap().turns[0].configuration,
        frozen
    );
    engine.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn configured_default_alias_preserves_per_model_capabilities() {
    let root = tempfile::tempdir().unwrap();
    let model = HttpModel::with_protocol(
        "http://127.0.0.1:9/responses".into(),
        "sol".into(),
        None,
        ModelProtocol::Responses,
    )
    .unwrap();
    let engine = Engine::open(root.path(), Arc::new(model), Limits::default()).unwrap();
    let provider: Provider = serde_json::from_value(json!({
        "id":"fixture", "revision":0, "endpoint":"http://127.0.0.1:9/responses", "protocol":"responses",
        "models":["sol"], "modelCapabilities":{"sol":{"defaultReasoningEffort":"low",
            "reasoningEffortOptions":["low","medium","high","xhigh","max","ultra"]}}
    })).unwrap();
    engine
        .install_configured_models(areal_engine::desktop::ConfiguredModels {
            providers: vec![provider],
            provider_ids: ["fixture".into()].into(),
            default_model: Some(
                serde_json::from_value(json!({"providerId":"fixture","modelId":"sol"})).unwrap(),
            ),
            ..Default::default()
        })
        .unwrap();
    let catalog = engine.model_catalog();
    let data = catalog["data"].as_array().unwrap();
    let alias = data.iter().find(|m| m["providerId"].is_null()).unwrap();
    let selected = data.iter().find(|m| m["providerId"] == "fixture").unwrap();
    assert_eq!(
        alias["reasoningEffortOptions"],
        selected["reasoningEffortOptions"]
    );
    assert_eq!(
        alias["reasoningEffortOptions"]
            .as_array()
            .unwrap()
            .last()
            .unwrap(),
        "ultra"
    );
    assert_eq!(alias["defaultReasoningEffort"], "low");
}
