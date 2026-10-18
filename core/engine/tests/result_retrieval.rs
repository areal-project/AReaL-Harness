use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelEvent, ModelStream, ToolCall},
    tools::ToolExtensions,
};
use areal_mcp::{Connections, ServerConfig};
use areal_protocol::desktop::{ForkAnchor, ForkThread};
use areal_protocol::{Input, Item, TurnStatus};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct RetrievalModel {
    original_view: Mutex<Option<String>>,
    pages: Mutex<Vec<String>>,
}

#[derive(Default)]
struct ForkResultModel {
    pages: Mutex<Vec<String>>,
}

#[async_trait]
impl Model for ForkResultModel {
    fn name(&self) -> &str {
        "fork-result-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<ModelStream> {
        assert!(
            tools
                .iter()
                .any(|tool| tool["function"]["name"] == "read_tool_result")
        );
        let last = messages.last().unwrap();
        let result_id = messages
            .iter()
            .filter(|message| message.role == "tool")
            .filter_map(|message| serde_json::from_str::<Value>(&message.text_content()).ok())
            .find_map(|value| value["rawResult"]["resultId"].as_str().map(str::to_owned))
            .unwrap();
        let event = if last.role == "user" {
            ModelEvent::ToolCall(ToolCall {
                id: "fork-page-0".into(),
                name: "read_tool_result".into(),
                arguments: json!({"resultId":result_id}).to_string(),
            })
        } else {
            let page: Value = serde_json::from_str(&last.text_content()).unwrap();
            self.pages
                .lock()
                .unwrap()
                .push(page["text"].as_str().unwrap().into());
            if page["eof"] == true {
                let raw: Value =
                    serde_json::from_str(&self.pages.lock().unwrap().concat()).unwrap();
                assert!(
                    raw["contentItems"][0]["text"]
                        .as_str()
                        .unwrap()
                        .contains("关键值:violet")
                );
                ModelEvent::text("Inherited raw bytes recovered")
            } else {
                ModelEvent::ToolCall(ToolCall {
                    id: format!("fork-page-{}", self.pages.lock().unwrap().len()),
                    name: "read_tool_result".into(),
                    arguments: json!({"resultId":result_id,"after":page["nextCursor"]}).to_string(),
                })
            }
        };
        Ok(Box::pin(futures_util::stream::iter([Ok(event)])))
    }
}

#[async_trait]
impl Model for RetrievalModel {
    fn name(&self) -> &str {
        "result-retrieval-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<ModelStream> {
        assert!(
            tools
                .iter()
                .any(|tool| tool["function"]["name"] == "read_tool_result"),
            "真实模型必须能发现回取工具"
        );
        let results: Vec<_> = messages.iter().filter(|m| m.role == "tool").collect();
        let event = if results.is_empty() {
            ModelEvent::ToolCall(ToolCall {
                id: "source".into(),
                name: "mcp__fixture__echo".into(),
                arguments: json!({"value":"large"}).to_string(),
            })
        } else {
            let current = results[0].text_content();
            let mut original = self.original_view.lock().unwrap();
            if let Some(saved) = original.as_ref() {
                assert_eq!(saved, &current, "回取不能重写已发送的历史投影");
            } else {
                *original = Some(current.clone());
            }
            assert!(current.len() <= 16 * 1024);
            let preview: Value = serde_json::from_str(&current).unwrap();
            assert_eq!(preview["rawAvailable"], true);
            let result_id = preview["rawResult"]["resultId"].as_str().unwrap();
            let mut after = Value::Null;
            let mut finished = false;
            if results.len() > 1 {
                let page: Value =
                    serde_json::from_str(&results.last().unwrap().text_content()).unwrap();
                assert!(page["bytes"].as_u64().unwrap() <= 8192);
                assert!(page.to_string().len() <= 16 * 1024);
                self.pages
                    .lock()
                    .unwrap()
                    .push(page["text"].as_str().unwrap().into());
                after = page["nextCursor"].clone();
                finished = page["eof"] == true;
            }
            if finished {
                let restored: Value =
                    serde_json::from_str(&self.pages.lock().unwrap().concat()).unwrap();
                assert_eq!(
                    restored["contentItems"][0]["text"],
                    format!("{}关键值:violet\n{}", "x".repeat(17000), "z".repeat(17000))
                );
                assert_eq!(restored["structuredContent"]["echo"], "large");
                ModelEvent::text("All original bytes recovered")
            } else {
                ModelEvent::ToolCall(ToolCall {
                    id: format!("page{}", results.len()),
                    name: "read_tool_result".into(),
                    arguments: json!({"resultId":result_id,"after":after}).to_string(),
                })
            }
        };
        Ok(Box::pin(futures_util::stream::iter(vec![Ok(event)])))
    }
}

#[tokio::test]
async fn actual_mcp_large_result_is_retrieved_once_with_stable_history() {
    let directory = tempfile::tempdir().unwrap();
    let log = directory.path().join("mcp.jsonl");
    let servers:BTreeMap<String,ServerConfig> = [("fixture".into(),serde_json::from_value(json!({"transport":{"type":"stdio","command":"python3","args":[concat!(env!("CARGO_MANIFEST_DIR"),"/../../tests/fixtures/mcp-server.py"),log,"normal"]}})).unwrap())].into();
    let env = std::env::vars_os().collect();
    let mut connections =
        Connections::connect(&servers, &env, directory.path(), CancellationToken::new())
            .await
            .unwrap();
    let model = Arc::new(RetrievalModel::default());
    let engine = Engine::open_with_mcp(
        &directory.path().join("data"),
        model.clone(),
        Limits::default(),
        None,
        ToolExtensions::default(),
        connections.tools(),
    )
    .unwrap();
    let thread = engine.create("/fixture".into()).await.unwrap();
    engine
        .start(
            &thread.id,
            vec![Input::text("Read the full inventory once")],
        )
        .await
        .unwrap();
    let done = tokio::time::timeout(Duration::from_secs(15), engine.wait(&thread.id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        done.turns[0].status,
        TurnStatus::Completed,
        "{:?}",
        done.turns[0].error
    );
    assert!(model.pages.lock().unwrap().len() >= 4);
    let snapshots: Vec<_> = done.turns[0]
        .items
        .iter()
        .filter_map(|item| match item {
            Item::DynamicToolCall {
                tool, execution, ..
            } if execution.result_snapshot.is_some() => Some(tool.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(snapshots, ["mcp__fixture__echo"]);
    let fork = engine
        .fork_thread(
            "result-owner".into(),
            ForkThread {
                request_id: "raw-result-fork".into(),
                source_thread_id: thread.id.clone(),
                anchor: ForkAnchor {
                    turn_id: done.turns[0].id.clone(),
                    boundary: "after".into(),
                },
                workspace_mode: "sharedCurrent".into(),
                target: None,
            },
        )
        .await
        .unwrap();
    let fork_model = Arc::new(ForkResultModel::default());
    engine.register_default_model("fork-result-reader".into(), fork_model.clone(), true);
    engine
        .start(&fork.id, vec![Input::text("Read inherited original bytes")])
        .await
        .unwrap();
    let continued = tokio::time::timeout(Duration::from_secs(15), engine.wait(&fork.id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        continued.turns[0].status,
        TurnStatus::Completed,
        "{:?}",
        continued.turns[0].error
    );
    assert!(fork_model.pages.lock().unwrap().len() >= 4);
    engine.shutdown().await;
    connections.shutdown().await.unwrap();
    let calls = std::fs::read_to_string(log)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|v| v["method"] == "tools/call")
        .count();
    assert_eq!(calls, 1, "回取不得重跑 MCP 调用");
}
