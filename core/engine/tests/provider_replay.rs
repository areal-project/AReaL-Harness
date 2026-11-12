#[path = "support/http_replay.rs"]
mod http_replay;
#[path = "support/solve_only_http.rs"]
mod solve_only_http;

use areal_engine::{
    Engine, Limits,
    model::{HttpModel, ModelOptions},
};
use areal_protocol::{Input, Item, TurnStatus};
use http_replay::HttpReplay;
use solve_only_http::SolveOnlyHttpModel;
use std::{sync::Arc, time::Duration};

fn model(replay: &HttpReplay) -> Arc<SolveOnlyHttpModel> {
    Arc::new(SolveOnlyHttpModel(
        HttpModel::new(replay.endpoint.clone(), "fixture".into(), None)
            .unwrap()
            .with_options(ModelOptions {
                max_retries: 0,
                ..Default::default()
            })
            .unwrap(),
    ))
}

fn limits() -> Limits {
    Limits {
        watchdog_disable: true,
        max_completion_retries: 0,
        max_empty_completion_retries: 0,
        ..Default::default()
    }
}

async fn wait(engine: &Engine, id: &str) -> areal_protocol::Thread {
    tokio::time::timeout(Duration::from_secs(10), engine.wait(id))
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn text_before_an_error_is_preserved_when_events_share_one_http_chunk() {
    let mut replay = HttpReplay::start(include_str!(
        "fixtures/provider-replay/text-before-error.json"
    ))
    .await;
    let data = tempfile::tempdir().unwrap();
    let engine = Engine::open(data.path(), model(&replay), limits()).unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    engine
        .start(&thread.id, vec![Input::text("test")])
        .await
        .unwrap();
    replay.request(0).await;
    let done = wait(&engine, &thread.id).await;
    assert_eq!(done.turns[0].status, TurnStatus::Failed);
    let outcome = done.turns[0]
        .error
        .as_ref()
        .unwrap()
        .outcome
        .as_ref()
        .unwrap();
    assert_eq!(outcome.code, "LLM_RESPONSE_FAILED");
    assert_eq!(outcome.source, "provider_stream");
    assert!(
        done.turns[0].items.iter().any(
            |item| matches!(item, Item::AgentMessage { text, .. } if text == "accepted-prefix")
        )
    );
    engine.shutdown().await;
    replay.finish().await;
}

#[tokio::test]
async fn transport_failure_after_finish_reason_does_not_release_tool_calls() {
    use areal_engine::model::{Message, Model, ModelEvent};
    use futures_util::StreamExt;
    let mut replay = HttpReplay::start(include_str!(
        "fixtures/provider-replay/finish-before-disconnect.json"
    ))
    .await;
    let events = tokio::time::timeout(Duration::from_secs(10), async {
        model(&replay)
            .stream(vec![Message::text("user", "fixture")])
            .await
            .unwrap()
            .collect::<Vec<_>>()
            .await
    })
    .await
    .unwrap();
    replay.request(0).await;
    replay.finish().await;
    assert!(
        events
            .iter()
            .any(|event| matches!(event, Ok(ModelEvent::TextDelta(text)) if text == "prefix"))
    );
    assert!(
        events
            .iter()
            .all(|event| !matches!(event, Ok(ModelEvent::ToolCall(_))))
    );
    assert!(
        events
            .last()
            .unwrap()
            .as_ref()
            .unwrap_err()
            .to_string()
            .contains("transport failed")
    );
}

#[tokio::test]
async fn cancelled_request_cannot_publish_a_late_answer() {
    let mut replay = HttpReplay::start(include_str!(
        "fixtures/provider-replay/cancel-before-headers.json"
    ))
    .await;
    let data = tempfile::tempdir().unwrap();
    let engine = Engine::open(data.path(), model(&replay), limits()).unwrap();
    let thread = engine.create("/workspace".into()).await.unwrap();
    let turn = engine
        .start(&thread.id, vec![Input::text("cancel at request arrival")])
        .await
        .unwrap();
    replay.request(0).await;
    engine.interrupt(&thread.id, &turn.id).await.unwrap();
    assert_eq!(
        wait(&engine, &thread.id).await.turns[0].status,
        TurnStatus::Interrupted
    );
    replay.release(0);
    replay.finish().await;
    engine.shutdown().await;
    drop(engine);
    let reopened = Engine::open(data.path(), model(&replay), limits()).unwrap();
    let saved = reopened.read(&thread.id, true).await.unwrap();
    assert_eq!(saved.turns[0].status, TurnStatus::Interrupted);
    assert!(!saved.turns[0].items.iter().any(
        |item| matches!(item, Item::AgentMessage { text, .. } if text.contains("late answer"))
    ));
    reopened.shutdown().await;
}

#[cfg(feature = "native-tests")]
#[tokio::test]
async fn persisted_runtime_write_survives_disconnect_and_reopen_without_replay() {
    use areal_engine::tools::RuntimeConfig;
    use areal_runtime_client::Client;
    use std::path::PathBuf;
    let bin = PathBuf::from(
        std::env::var_os("AREAL_TEST_BIN_DIR")
            .expect("set AREAL_TEST_BIN_DIR to a verified fixed Runtime bundle"),
    );
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let workspace_path = workspace.path().canonicalize().unwrap();
    let runtime = Client::launch(
        &bin.join("areal-runtime"),
        &bin.join("areal-runtime-fs"),
        &workspace_path,
        true,
    )
    .await
    .unwrap();
    let mut replay = HttpReplay::start(include_str!(
        "fixtures/provider-replay/persisted-write.json"
    ))
    .await;
    let config = || RuntimeConfig {
        client: runtime.clone(),
        workspace: workspace_path.clone(),
        writable: true,
        command_scope: None,
        command_scratch: None,
    };
    let engine =
        Engine::open_with_runtime(data.path(), model(&replay), limits(), config()).unwrap();
    let thread = engine
        .create(workspace_path.to_str().unwrap().into())
        .await
        .unwrap();
    engine
        .start(&thread.id, vec![Input::text("write proof.txt once")])
        .await
        .unwrap();
    replay.request(0).await;
    let followup = replay.request(1).await;
    assert!(
        followup["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["role"] == "tool" && m["tool_call_id"] == "write-once")
    );
    // 下一轮请求已携带工具结果；再独立检查持久记录，不能用网络里程碑冒充落盘。
    let saved: serde_json::Value = serde_json::from_slice(
        &std::fs::read(data.path().join(format!("{}.json", thread.id))).unwrap(),
    )
    .unwrap();
    assert!(
        saved["thread"]["turns"][0]["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["callId"] == "write-once" && i["success"] == true)
    );
    assert_eq!(
        std::fs::read_to_string(workspace_path.join("proof.txt")).unwrap(),
        "written once"
    );
    replay.release(1);
    assert_eq!(
        wait(&engine, &thread.id).await.turns[0].status,
        TurnStatus::Failed
    );
    engine.shutdown().await;
    drop(engine);
    // 若重开时错误重放写调用，哨兵内容会被覆盖或出现额外工具结果。
    std::fs::write(
        workspace_path.join("proof.txt"),
        "sentinel after completed write",
    )
    .unwrap();
    let reopened =
        Engine::open_with_runtime(data.path(), model(&replay), limits(), config()).unwrap();
    reopened
        .start(
            &thread.id,
            vec![Input::text("report the saved outcome without writing")],
        )
        .await
        .unwrap();
    let request = replay.request(2).await;
    assert!(
        request["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["role"] == "tool" && m["tool_call_id"] == "write-once")
    );
    let done = wait(&reopened, &thread.id).await;
    assert_eq!(done.turns.last().unwrap().status, TurnStatus::Completed);
    assert_eq!(done.turns.iter().flat_map(|t| &t.items).filter(|i| matches!(i, Item::DynamicToolCall { call_id, success: Some(true), .. } if call_id == "write-once")).count(), 1);
    assert_eq!(
        std::fs::read_to_string(workspace_path.join("proof.txt")).unwrap(),
        "sentinel after completed write"
    );
    reopened.shutdown().await;
    runtime.shutdown().await.unwrap();
    replay.finish().await;
}
