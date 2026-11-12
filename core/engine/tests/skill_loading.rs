#[path = "support/solve_only_http.rs"]
mod solve_only_http;

use areal_engine::{
    Engine, Limits,
    desktop::{SkillLocation, SkillMetadata},
    model::{Message, Model, ModelEvent, ModelStream, RequestPurpose, ToolCall, UnconfiguredModel},
};
use areal_protocol::{Input, Item, Thread, TurnStatus, desktop::VersionRef};
use async_trait::async_trait;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

const ID: &str = "fixture";
const REV: &str = "v1";
const LIMIT: usize = 64 * 1024;

type Step = dyn Fn(usize, &[Message]) -> Vec<ModelEvent> + Send + Sync;
struct Script {
    next: AtomicUsize,
    summaries: AtomicUsize,
    step: Box<Step>,
}
impl Script {
    fn new(
        step: impl Fn(usize, &[Message]) -> Vec<ModelEvent> + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            next: AtomicUsize::new(0),
            summaries: AtomicUsize::new(0),
            step: Box::new(step),
        })
    }
}
#[async_trait]
impl Model for Script {
    fn name(&self) -> &str {
        "skill-loading-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat_for(
        &self,
        messages: Vec<Message>,
        _: Vec<Value>,
        purpose: RequestPurpose,
    ) -> anyhow::Result<ModelStream> {
        let events = if purpose == RequestPurpose::Summary {
            self.summaries.fetch_add(1, Ordering::SeqCst);
            vec![ModelEvent::text(
                "Earlier work summarized. Reload required skill instructions before applying them.",
            )]
        } else {
            (self.step)(self.next.fetch_add(1, Ordering::SeqCst), &messages)
        };
        Ok(Box::pin(futures_util::stream::iter(
            events.into_iter().map(Ok),
        )))
    }
}
fn reference() -> VersionRef {
    VersionRef {
        id: ID.into(),
        revision: REV.into(),
    }
}
fn call(name: &str, args: Value) -> Vec<ModelEvent> {
    vec![ModelEvent::ToolCall(ToolCall {
        id: format!("{name}-{}", uuid::Uuid::new_v4()),
        name: name.into(),
        arguments: args.to_string(),
    })]
}
fn load() -> Vec<ModelEvent> {
    call("skill_load", json!({"skill":reference()}))
}
fn last(messages: &[Message]) -> Value {
    serde_json::from_str(
        &messages
            .iter()
            .rev()
            .find(|m| m.role == "tool")
            .unwrap()
            .text_content(),
    )
    .unwrap()
}
fn done() -> Vec<ModelEvent> {
    vec![ModelEvent::text("Verified fixture.")]
}
struct Fixture {
    data: tempfile::TempDir,
    root: tempfile::TempDir,
    engine: Arc<Engine>,
    thread: Thread,
}
impl Fixture {
    async fn new(bytes: &[u8], model: Arc<dyn Model>, limits: Limits) -> Self {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("SKILL.md"), bytes).unwrap();
        let engine = Engine::open(data.path(), model, limits).unwrap();
        engine
            .install_default_skills(vec![SkillLocation {
                id: ID.into(),
                revision: REV.into(),
                root: root.path().into(),
                metadata: Some(SkillMetadata {
                    name: "Fixture".into(),
                    description: "Load fixture instructions".into(),
                }),
            }])
            .unwrap();
        let thread = engine
            .create(root.path().to_string_lossy().into_owned())
            .await
            .unwrap();
        Self {
            data,
            root,
            engine,
            thread,
        }
    }
    async fn run(&self) -> Thread {
        self.engine
            .start(&self.thread.id, vec![Input::text("Use the selected skill")])
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(20), self.engine.wait(&self.thread.id))
            .await
            .unwrap()
            .unwrap()
    }
}
fn completed(thread: &Thread) {
    let turn = thread.turns.last().unwrap();
    assert_eq!(turn.status, TurnStatus::Completed, "{:?}", turn.error);
}

#[tokio::test]
async fn complete_body_survives_result_projection_and_reopen() {
    let body = format!(
        "{}\nMIDDLE_REQUIRED_RULE\n{}\n末尾必须遵守的规则",
        "a中\\\"\n".repeat(1800),
        "body ".repeat(1800)
    );
    assert!(body.len() > 16384);
    let expected = body.clone();
    let model = Script::new(move |step, messages| match step {
        0 => load(),
        1 => {
            let value = last(messages);
            assert_eq!(value["complete"], true);
            assert_eq!(value["text"], expected);
            assert_eq!(value["sizeBytes"], expected.len());
            assert_eq!(
                value["sha256"],
                format!("{:x}", Sha256::digest(expected.as_bytes()))
            );
            assert!(value.get("truncated").is_none());
            assert!(value.get("dataBase64").is_none());
            call("skill_list", json!({}))
        }
        2 => {
            assert_eq!(last(messages)["loadedMain"][ID]["revision"], REV);
            done()
        }
        _ => panic!("unexpected extra solve"),
    });
    let fixture = Fixture::new(
        body.as_bytes(),
        model,
        Limits {
            context_observation_tokens: 1,
            ..Default::default()
        },
    )
    .await;
    let result = fixture.run().await;
    completed(&result);
    let projection = result.turns[0]
        .items
        .iter()
        .find_map(|item| match item {
            Item::DynamicToolCall {
                tool,
                execution,
                success: Some(true),
                ..
            } if tool == "skill_load" => execution.output_projection.as_ref(),
            _ => None,
        })
        .unwrap();
    assert_eq!(projection["transform"], "skill-body-v1");
    assert_eq!(projection["rawBytes"], projection["displayedBytes"]);
    fixture.engine.shutdown().await;
    drop(fixture.engine);
    let reopened = Engine::open(
        fixture.data.path(),
        Arc::new(UnconfiguredModel),
        Limits::default(),
    )
    .unwrap();
    assert!(
        reopened.skills(&fixture.thread.id).await.unwrap()["loadedMain"][ID]["sha256"].is_string()
    );
    reopened.shutdown().await;
}

#[tokio::test]
async fn invalid_or_over_budget_body_fails_without_partial_success() {
    for body in [
        vec![b'a'; LIMIT + 1],
        vec![b'\n'; LIMIT / 2],
        vec![0xff, 0xfe],
    ] {
        let model = Script::new(|step, messages| match step {
            0 => load(),
            1 => {
                let value = last(messages);
                assert!(
                    value["error"].to_string().contains("SKILL_NOT_LOADED"),
                    "{value}"
                );
                assert!(value.get("text").is_none());
                assert!(value.get("complete").is_none());
                done()
            }
            _ => unreachable!(),
        });
        let fixture = Fixture::new(&body, model, Limits::default()).await;
        let result = fixture.run().await;
        completed(&result);
        assert!(result.turns[0].items.iter().any(
            |i| matches!(i,Item::DynamicToolCall{tool,success:Some(false),..} if tool=="skill_load")
        ));
        let listing = fixture.engine.skills(&fixture.thread.id).await.unwrap();
        assert_eq!(listing["loaded"], json!({}));
        assert_eq!(listing["loadedMain"], json!({}));
        fixture.engine.shutdown().await;
    }
}

#[tokio::test]
async fn exact_serialized_limit_and_empty_body_have_unambiguous_results() {
    let mut length = LIMIT;
    loop {
        let value = json!({"id":ID,"revision":REV,"resource":"SKILL.md","resourceRoot":format!("areal://skill/{ID}/{REV}"),"sizeBytes":length,"sha256":"0".repeat(64),"text":"a".repeat(length),"complete":true,"remainingToolCalls":null});
        let size = value.to_string().len();
        if size == LIMIT {
            break;
        }
        length -= size - LIMIT;
    }
    for size in [0, length, length + 1] {
        let model = Script::new(move |step, messages| match step {
            0 => load(),
            1 => {
                let value = last(messages);
                if size <= length {
                    assert_eq!(value["text"], "a".repeat(size));
                    assert_eq!(value["complete"], true);
                    if size == length {
                        assert_eq!(value.to_string().len(), LIMIT);
                    }
                } else {
                    assert!(value["error"].to_string().contains("SKILL_NOT_LOADED"));
                }
                done()
            }
            _ => unreachable!(),
        });
        let fixture = Fixture::new(&vec![b'a'; size], model, Limits::default()).await;
        completed(&fixture.run().await);
        fixture.engine.shutdown().await;
    }
}

#[tokio::test]
async fn context_overflow_never_summarizes_an_unconsumed_skill() {
    let model = Script::new(|step, _| {
        assert_eq!(
            step, 0,
            "must not solve with only a summary of the new skill"
        );
        load()
    });
    let fixture = Fixture::new(
        &vec![b'a'; 60000],
        model.clone(),
        Limits {
            context_window_tokens: 16000,
            context_output_reserve_tokens: 1000,
            context_target_tokens: 8000,
            ..Default::default()
        },
    )
    .await;
    let result = fixture.run().await;
    assert_ne!(result.turns[0].status, TurnStatus::Completed);
    assert!(
        result.turns[0]
            .error
            .as_ref()
            .map(|e| e.message.as_str())
            .unwrap_or("")
            .contains("context"),
        "{:?}",
        result.turns[0].error
    );
    assert_eq!(model.next.load(Ordering::SeqCst), 1);
    assert_eq!(model.summaries.load(Ordering::SeqCst), 0);
    fixture.engine.shutdown().await;
}

#[tokio::test]
async fn turn_output_budget_is_not_expanded_for_skill_loading() {
    let model = Script::new(|step, messages| match step {
        0 => load(),
        1 => {
            assert!(
                messages
                    .iter()
                    .any(|m| m.text_content().to_lowercase().contains("budget"))
            );
            assert!(
                !messages
                    .iter()
                    .filter(|m| m.role == "tool")
                    .any(|m| m.text_content().contains("small skill"))
            );
            done()
        }
        _ => unreachable!(),
    });
    let fixture = Fixture::new(
        b"small skill",
        model,
        Limits {
            max_output_bytes: 100000,
            ..Default::default()
        },
    )
    .await;
    let result = fixture.run().await;
    assert!(!result.turns[0].items.iter().any(|item| matches!(item, Item::DynamicToolCall {tool,success:Some(true),..} if tool=="skill_load")));
    let listing = fixture.engine.skills(&fixture.thread.id).await.unwrap();
    assert_eq!(listing["loaded"], json!({}));
    assert_eq!(listing["loadedMain"], json!({}));
    fixture.engine.shutdown().await;
}

#[tokio::test]
async fn unselected_denied_and_symlink_skills_do_not_load() {
    for case in ["unselected", "denied", "symlink"] {
        let model = Script::new(|step, messages| match step {
            0 => load(),
            1 => {
                assert!(last(messages).get("error").is_some(), "{}", last(messages));
                done()
            }
            _ => unreachable!(),
        });
        let fixture = Fixture::new(b"private body", model, Limits::default()).await;
        match case {
            "unselected" => {
                let deployment = fixture.root.path().join("deployment.json");
                fs::write(&deployment, json!({"profiles":[{"id":"empty","revision":"v1","displayName":"Empty","instructions":"","skills":[]}]}).to_string()).unwrap();
                fixture.engine.install_deployment(&deployment).unwrap();
                fixture.engine.configure_thread(serde_json::from_value(json!({"threadId":fixture.thread.id,"expectedRevision":1,"agentProfile":{"id":"empty","revision":"v1"}})).unwrap()).await.unwrap();
            }
            "denied" => {
                fixture
                    .engine
                    .set_permissions(
                        areal_config::PermissionConfig {
                            deny: vec!["skill_load".into()],
                            ..Default::default()
                        },
                        None,
                    )
                    .unwrap();
            }
            "symlink" => {
                fs::rename(
                    fixture.root.path().join("SKILL.md"),
                    fixture.root.path().join("secret.md"),
                )
                .unwrap();
                std::os::unix::fs::symlink("secret.md", fixture.root.path().join("SKILL.md"))
                    .unwrap();
            }
            _ => unreachable!(),
        }
        completed(&fixture.run().await);
        assert_eq!(
            fixture.engine.skills(&fixture.thread.id).await.unwrap()["loadedMain"],
            json!({})
        );
        fixture.engine.shutdown().await;
    }
}

#[tokio::test]
async fn full_skill_reaches_chat_and_responses_wire_requests() {
    use areal_engine::model::{HttpModel, ModelProtocol};
    use axum::{Json, Router, routing::post};
    for protocol in [ModelProtocol::ChatCompletions, ModelProtocol::Responses] {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let calls = Arc::new(AtomicUsize::new(0));
        let app = Router::new().route("/", post(move |Json(request): Json<Value>| {
            let tx = tx.clone();
            let calls = calls.clone();
            async move {
                let first = calls.fetch_add(1, Ordering::SeqCst) == 0;
                tx.send(request).unwrap();
                let args = json!({"skill":reference()}).to_string();
                let event = match protocol {
                    ModelProtocol::ChatCompletions => {
                        if first {
                            json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"load-main","type":"function","function":{"name":"skill_load","arguments":args}}]},"finish_reason":"tool_calls"}]})
                        } else { json!({"choices":[{"index":0,"delta":{"content":"verified"},"finish_reason":"stop"}]}) }
                    },
                    ModelProtocol::Responses => {
                        let output = if first { json!({"type":"function_call","id":"fc_load","call_id":"load-main","name":"skill_load","arguments":args}) }
                            else {json!({"type":"message","id":"msg_done","role":"assistant","status":"completed","content":[{"type":"output_text","text":"verified"}]})};
                        json!({"type":"response.completed","response":{"status":"completed","output":[output]}})
                    },
                };
                let mut stream = format!("data: {event}\n\n");
                if protocol == ModelProtocol::ChatCompletions { stream.push_str("data: [DONE]\n\n"); }
                ([("content-type","text/event-stream")],stream)
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let model = Arc::new(solve_only_http::SolveOnlyHttpModel(
            HttpModel::with_protocol(url, "skill-fixture".into(), None, protocol).unwrap(),
        ));
        let body = format!(
            "{}MIDDLE_RULE{}末尾规则",
            "abc\n".repeat(5000),
            "中文".repeat(1000)
        );
        let fixture = Fixture::new(body.as_bytes(), model, Limits::default()).await;
        let result = fixture.run().await;
        fixture.engine.shutdown().await;
        server.abort();
        let _ = server.await;
        completed(&result);
        rx.try_recv().unwrap();
        let request = rx.try_recv().unwrap();
        let raw = match protocol {
            ModelProtocol::ChatCompletions => request["messages"]
                .as_array()
                .unwrap()
                .iter()
                .find(|m| m["role"] == "tool")
                .unwrap()["content"]
                .as_str()
                .unwrap()
                .to_owned(),
            ModelProtocol::Responses => request["input"]
                .as_array()
                .unwrap()
                .iter()
                .find(|m| m["type"] == "function_call_output")
                .unwrap()["output"]
                .as_str()
                .unwrap()
                .to_owned(),
        };
        let received: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(received["text"], body);
        assert_eq!(received["complete"], true);
        assert!(raw.len() > 16 * 1024);
        assert!(rx.try_recv().is_err());
    }
}

#[tokio::test]
async fn consumed_body_can_compact_and_loaded_status_expires() {
    let model = Script::new(|step, messages| match step {
        0 => load(),
        1 => {
            assert_eq!(last(messages)["complete"], true);
            done()
        }
        _ => done(),
    });
    let fixture = Fixture::new(
        &vec![b'a'; 30000],
        model.clone(),
        Limits {
            context_recent_tokens: 32,
            context_target_tokens: 4000,
            ..Default::default()
        },
    )
    .await;
    completed(&fixture.run().await);
    assert!(fixture.engine.skills(&fixture.thread.id).await.unwrap()["loadedMain"][ID].is_object());
    fixture
        .engine
        .context_compact(fixture.thread.id.clone())
        .await
        .unwrap();
    assert!(model.summaries.load(Ordering::SeqCst) > 0);
    let listing = fixture.engine.skills(&fixture.thread.id).await.unwrap();
    assert_eq!(listing["loadedMain"], json!({}));
    assert_eq!(listing["loaded"][ID], REV);
    fixture.engine.shutdown().await;
}
