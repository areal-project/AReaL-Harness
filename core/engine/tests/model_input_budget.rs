#[path = "support/solve_only_http.rs"]
mod solve_only_http;

use areal_engine::{Engine, Limits, model::HttpModel, tools::DynamicToolHost};
use areal_protocol::{DynamicToolResponse, Input, TurnStatus, desktop::ThreadStart};
use async_trait::async_trait;
use axum::{Json, Router, routing::post};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

struct NoDynamicTools;

#[async_trait]
impl DynamicToolHost for NoDynamicTools {
    fn id(&self) -> &str {
        "no-dynamic-tools"
    }
    fn is_closed(&self) -> bool {
        false
    }
    async fn call(&self, _: Value, _: CancellationToken) -> anyhow::Result<DynamicToolResponse> {
        unreachable!("input-budget fixture does not issue tool calls")
    }
}

async fn default_desktop_request(prompt: &str) -> Value {
    let (requests, mut received) = tokio::sync::mpsc::unbounded_channel();
    let app = Router::new().route(
        "/",
        post(move |Json(request): Json<Value>| {
            let requests = requests.clone();
            async move {
                requests.send(request).unwrap();
                (
                    [("content-type", "text/event-stream")],
                    "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Verified fixture.\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let data = tempfile::tempdir().unwrap();
    let model = HttpModel::new(endpoint, "input-budget".into(), None).unwrap();
    let engine = Engine::open(
        data.path(),
        Arc::new(solve_only_http::SolveOnlyHttpModel(model)),
        Limits::default(),
    )
    .unwrap();
    let thread = engine
        .create_configured(
            "input-budget".into(),
            ThreadStart {
                prepare_task_directory: None,
                creation_admission: None,
                request_id: "create".into(),
                cwd: Some(data.path().to_string_lossy().into_owned()),
                options: None,
                admission_guard: None,
                agent_profile: None,
                model: None,
                parameters: Default::default(),
                dynamic_tools: vec![],
            },
            Arc::new(NoDynamicTools),
        )
        .await
        .unwrap();
    engine
        .start(&thread.id, vec![Input::text(prompt)])
        .await
        .unwrap();
    let request = tokio::time::timeout(Duration::from_secs(10), received.recv())
        .await
        .unwrap()
        .unwrap();
    let done = tokio::time::timeout(Duration::from_secs(10), engine.wait(&thread.id))
        .await
        .unwrap()
        .unwrap();
    engine.shutdown().await;
    server.abort();
    let _ = server.await;
    assert_eq!(done.turns[0].status, TurnStatus::Completed);
    assert!(
        received.try_recv().is_err(),
        "only one solve request is measured"
    );
    assert!(
        request["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| { message["role"] == "user" && message["content"] == prompt })
    );
    request
}

fn measure(request: &Value) -> Value {
    let system: Vec<_> = request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "system")
        .map(|message| message["content"].as_str().unwrap())
        .collect();
    assert_eq!(
        system.len(),
        1,
        "measure the production ChatCompletions system projection"
    );
    let environment: Vec<_> = system[0]
        .split_inclusive('\n')
        .filter(|line| line.starts_with("Execution settings supplied by Core: "))
        .collect();
    assert_eq!(
        environment.len(),
        1,
        "the default profile must expose execution settings"
    );
    let environment_bytes = environment[0].len();
    let functions: Vec<_> = request["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| {
            let function = &tool["function"];
            json!({
                "name": function["name"].as_str().unwrap(),
                "description": function["description"].as_str().unwrap(),
                "parameters": function["parameters"],
            })
        })
        .collect();
    assert!(
        !functions.is_empty(),
        "the default Desktop tool surface must be measured"
    );
    let tools: BTreeMap<_, _> = functions
        .iter()
        .map(|function| {
            let name = function["name"].as_str().unwrap();
            (
                name,
                json!({
                    "nameUtf8Bytes": name.len(),
                    "descriptionUtf8Bytes": function["description"].as_str().unwrap().len(),
                    "parametersJsonUtf8Bytes": serde_json::to_vec(&function["parameters"]).unwrap().len(),
                }),
            )
        })
        .collect();
    assert_eq!(tools.len(), functions.len(), "tool names must be unique");
    json!({
        "profile": "desktop-default-no-runtime-or-plugins",
        "protocol": "chatCompletions",
        "systemInstructionsUtf8Bytes": system[0].len() - environment_bytes,
        "fixedEnvironmentUtf8Bytes": environment_bytes,
        "toolsJsonUtf8Bytes": serde_json::to_vec(&functions).unwrap().len(),
        "tools": tools,
    })
}

fn changes(baseline: &Value, measured: &Value) -> Vec<String> {
    let mut changes = Vec::new();
    for name in [
        "systemInstructionsUtf8Bytes",
        "fixedEnvironmentUtf8Bytes",
        "toolsJsonUtf8Bytes",
    ] {
        if baseline[name] != measured[name] {
            changes.push(format!("{name}: {} -> {}", baseline[name], measured[name]));
        }
    }
    let names: std::collections::BTreeSet<_> = baseline["tools"]
        .as_object()
        .into_iter()
        .flat_map(|tools| tools.keys())
        .chain(measured["tools"].as_object().unwrap().keys())
        .collect();
    for name in names {
        if baseline["tools"][name] != measured["tools"][name] {
            changes.push(format!(
                "tools.{name}: {} -> {}",
                baseline["tools"][name], measured["tools"][name]
            ));
        }
    }
    for name in ["profile", "protocol"] {
        assert_eq!(
            baseline[name], measured[name],
            "compare the same input profile"
        );
    }
    changes
}

#[tokio::test]
async fn default_desktop_model_input_matches_reviewed_static_byte_budget() {
    let first = default_desktop_request("Inspect a record and report evidence.").await;
    let second = default_desktop_request(
        "检查不同的用户输入；动态正文不计入静态预算。"
            .repeat(20)
            .as_str(),
    )
    .await;
    let measured = measure(&first);
    assert_eq!(
        measured,
        measure(&second),
        "random workspace paths, IDs and user text are outside the static baseline"
    );
    let baseline: Value =
        serde_json::from_str(include_str!("fixtures/model-input-budget.json")).unwrap();
    let differences = changes(&baseline, &measured);
    assert!(
        differences.is_empty(),
        "Review model-visible growth or shrinkage before manually updating the baseline:\n{}\nMeasured:\n{}",
        differences.join("\n"),
        serde_json::to_string_pretty(&measured).unwrap()
    );

    // 在已捕获的真实请求边界定向增减，证明预算会拒绝描述漂移，而非只验证总请求长度。
    for addition in [true, false] {
        let mut changed = first.clone();
        let description = changed["tools"][0]["function"]["description"]
            .as_str()
            .unwrap();
        let mut description = description.to_owned();
        if addition {
            description.push_str(" changed-description");
        } else {
            assert!(description.pop().is_some());
        }
        changed["tools"][0]["function"]["description"] = json!(description);
        assert!(!changes(&baseline, &measure(&changed)).is_empty());
    }
    let mut changed = first.clone();
    let text = changed["messages"][0]["content"]
        .as_str()
        .unwrap()
        .to_owned();
    changed["messages"][0]["content"] = json!(format!("{text}\nAdditional system instruction."));
    assert!(
        changes(&baseline, &measure(&changed))
            .iter()
            .any(|change| change.starts_with("systemInstructionsUtf8Bytes:"))
    );
}
