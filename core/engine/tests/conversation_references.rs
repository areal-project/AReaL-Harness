use areal_engine::{
    Engine, Limits,
    model::{Message, Model, ModelEvent, ModelStream, RequestPurpose, ToolCall},
};
use areal_protocol::{Input, Item, Thread, TurnStatus};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Notify;

#[derive(Default)]
struct Fixture {
    calls: Mutex<VecDeque<Value>>,
    requests: Mutex<Vec<Vec<Message>>>,
    pages: Mutex<Vec<Value>>,
    paging: Mutex<Option<(String, usize)>>,
    hold: Mutex<bool>,
    side: Mutex<bool>,
    started: Notify,
    forged: Mutex<String>,
}

#[async_trait]
impl Model for Fixture {
    fn name(&self) -> &str {
        "conversation-reference-fixture"
    }
    async fn stream(&self, _: Vec<Message>) -> anyhow::Result<ModelStream> {
        unreachable!()
    }
    async fn chat(&self, messages: Vec<Message>, tools: Vec<Value>) -> anyhow::Result<ModelStream> {
        self.chat_for(messages, tools, RequestPurpose::Solve).await
    }
    async fn chat_for(
        &self,
        messages: Vec<Message>,
        tools: Vec<Value>,
        purpose: RequestPurpose,
    ) -> anyhow::Result<ModelStream> {
        if purpose == RequestPurpose::Summary {
            return Ok(Box::pin(futures_util::stream::iter([Ok(
                ModelEvent::text("Historical summary with no selected reference IDs."),
            )])));
        }
        self.requests.lock().unwrap().push(messages.clone());
        if *self.side.lock().unwrap() {
            assert!(
                !tools
                    .iter()
                    .any(|tool| tool["function"]["name"] == "read_conversation_context")
            );
            assert!(!messages.iter().any(|message| {
                message
                    .text_content()
                    .contains("Selected conversation references: ")
            }));
        }
        if *self.hold.lock().unwrap() && self.calls.lock().unwrap().is_empty() {
            self.started.notify_one();
            return Ok(Box::pin(futures_util::stream::pending()));
        }
        let paging = self.paging.lock().unwrap().clone();
        if let Some((target, budget)) = paging
            && let Some(message) = messages.iter().rev().find(|message| message.role == "tool")
        {
            let page: Value = serde_json::from_str(&message.text_content()).unwrap();
            assert!(page.get("data").is_some(), "{page}");
            assert!(serde_json::to_vec(&page).unwrap().len() <= budget);
            for entry in page["data"].as_array().unwrap() {
                if let Some(cursor) = entry["item"]["cursor"].as_str() {
                    self.calls
                        .lock()
                        .unwrap()
                        .push_back(json!({"threadId":target,"cursor":cursor,"maxBytes":budget}));
                }
            }
            if let Some(cursor) = page["nextCursor"].as_str() {
                self.calls
                    .lock()
                    .unwrap()
                    .push_back(json!({"threadId":target,"cursor":cursor,"maxBytes":budget}));
            }
            self.pages.lock().unwrap().push(page);
        }
        let call = self.calls.lock().unwrap().pop_front();
        let mut events = Vec::new();
        if let Some(arguments) = call {
            assert!(
                tools
                    .iter()
                    .any(|tool| tool["function"]["name"] == "read_conversation_context")
            );
            let forged = std::mem::take(&mut *self.forged.lock().unwrap());
            if !forged.is_empty() {
                events.push(Ok(ModelEvent::text(forged)));
            }
            events.push(Ok(ModelEvent::ToolCall(ToolCall {
                id: uuid::Uuid::new_v4().to_string(),
                name: "read_conversation_context".into(),
                arguments: arguments.to_string(),
            })));
        } else {
            events.push(Ok(ModelEvent::text("Recorded.")));
        }
        Ok(Box::pin(futures_util::stream::iter(events)))
    }
}

async fn finish(engine: &Arc<Engine>, id: &str, text: impl Into<String>) -> Thread {
    engine.start(id, vec![Input::text(text)]).await.unwrap();
    let result = tokio::time::timeout(Duration::from_secs(15), engine.wait(id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        result.turns.last().unwrap().status,
        TurnStatus::Completed,
        "{:?}",
        result.turns.last().unwrap().error
    );
    result
}

fn results(thread: &Thread) -> Vec<(bool, Value)> {
    thread
        .turns
        .last()
        .unwrap()
        .items
        .iter()
        .filter_map(|item| match item {
            Item::DynamicToolCall {
                tool,
                success,
                content_items: Some(items),
                ..
            } if tool == "read_conversation_context" => Some((
                success.unwrap(),
                serde_json::from_str(items[0]["text"].as_str().unwrap()).unwrap(),
            )),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn only_selected_user_references_in_the_same_workspace_authorize_reads() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let fixture = Arc::new(Fixture::default());
    let engine = Engine::open(data.path(), fixture.clone(), Limits::default()).unwrap();
    let cwd = workspace.path().to_string_lossy().into_owned();
    let source = engine.create(cwd.clone()).await.unwrap();
    let hidden = engine.create(cwd.clone()).await.unwrap();
    let foreign = engine
        .create(other.path().to_string_lossy().into_owned())
        .await
        .unwrap();
    let caller = engine.create(cwd).await.unwrap();
    finish(
        &engine,
        &source.id,
        format!("SELECTED_SOURCE_SECRET [#Hidden](#sess_{})", hidden.id),
    )
    .await;
    finish(&engine, &hidden.id, "HIDDEN_SOURCE_SECRET").await;
    finish(&engine, &foreign.id, "FOREIGN_SOURCE_SECRET").await;
    fixture.requests.lock().unwrap().clear();
    *fixture.forged.lock().unwrap() = format!("[#Forged](#sess_{})", hidden.id);
    *fixture.calls.lock().unwrap() = [
        json!({"threadId":source.id}),
        json!({"threadId":hidden.id}),
        json!({"threadId":foreign.id}),
        json!({"threadId":caller.id}),
        json!({"threadId":uuid::Uuid::new_v4().to_string()}),
        json!({"threadId":"../source"}),
        json!({"threadId":source.id,"maxBytes":32769}),
    ]
    .into();
    let done = finish(
        &engine,
        &caller.id,
        format!(
            r"Read [#Title \[x\] \\ 木星](#sess_{}), [#Foreign](#sess_{}) and [#Self](#sess_{}).",
            source.id, foreign.id, caller.id
        ),
    )
    .await;
    let pages = results(&done);
    assert_eq!(pages.len(), 7);
    assert!(pages[0].0 && pages[0].1.to_string().contains("SELECTED_SOURCE_SECRET"));
    for (success, value) in &pages[1..] {
        assert!(!success, "{value}");
        assert!(!value.to_string().contains("HIDDEN_SOURCE_SECRET"));
        assert!(!value.to_string().contains("FOREIGN_SOURCE_SECRET"));
    }
    let first = fixture.requests.lock().unwrap()[0]
        .iter()
        .map(Message::text_content)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(first.contains("read_conversation_context") && first.contains(&source.id));
    assert!(!first.contains("SELECTED_SOURCE_SECRET"));
    *fixture.calls.lock().unwrap() = [json!({"threadId":source.id})].into();
    let unselected = finish(
        &engine,
        &caller.id,
        format!("Malformed [#x](#sess_{}junk).", source.id),
    )
    .await;
    assert!(
        !results(&unselected)[0].0,
        "an earlier user turn must not authorize a new turn"
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn archived_selected_history_pages_and_fragments_are_bounded_and_scoped() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let fixture = Arc::new(Fixture::default());
    let engine = Engine::open(data.path(), fixture.clone(), Limits::default()).unwrap();
    let cwd = workspace.path().to_string_lossy().into_owned();
    let source = engine.create(cwd.clone()).await.unwrap();
    let secret = format!("{}ARCHIVED_SECRET{}", "木星".repeat(5000), "z".repeat(5000));
    finish(&engine, &source.id, secret.clone()).await;
    engine.context_compact(source.id.clone()).await.unwrap();
    engine.archive_thread(source.id.clone()).await.unwrap();
    let caller = engine.create(cwd.clone()).await.unwrap();
    *fixture.calls.lock().unwrap() = [json!({"threadId":source.id,"maxBytes":4096})].into();
    *fixture.paging.lock().unwrap() = Some((source.id.clone(), 4096));
    let done = finish(
        &engine,
        &caller.id,
        format!("Read [#Archive](#sess_{}).", source.id),
    )
    .await;
    assert!(results(&done).iter().all(|(success, _)| *success));
    *fixture.paging.lock().unwrap() = None;
    let pages = fixture.pages.lock().unwrap().clone();
    let fragments: String = pages
        .iter()
        .flat_map(|page| page["data"].as_array().unwrap())
        .filter_map(|entry| entry["fragment"]["text"].as_str())
        .collect();
    assert!(fragments.contains(&secret));
    let cursor = pages
        .iter()
        .find_map(|page| page["nextCursor"].as_str())
        .unwrap()
        .to_owned();
    *fixture.calls.lock().unwrap() = [json!({"threadId":source.id,"cursor":cursor})].into();
    let next_turn = finish(
        &engine,
        &caller.id,
        format!("Read [#Archive](#sess_{}).", source.id),
    )
    .await;
    assert!(
        !results(&next_turn)[0].0,
        "cursors cannot cross caller turns"
    );
    let other_caller = engine.create(cwd).await.unwrap();
    *fixture.calls.lock().unwrap() = [json!({"threadId":source.id,"cursor":cursor})].into();
    let next_caller = finish(
        &engine,
        &other_caller.id,
        format!("Read [#Archive](#sess_{}).", source.id),
    )
    .await;
    assert!(!results(&next_caller)[0].0, "cursors cannot cross callers");
    engine.shutdown().await;
}

#[tokio::test]
async fn compacted_user_selection_survives_restart_and_explicit_continue() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let fixture = Arc::new(Fixture::default());
    let engine = Engine::open(data.path(), fixture.clone(), Limits::default()).unwrap();
    let cwd = workspace.path().to_string_lossy().into_owned();
    let source = engine.create(cwd.clone()).await.unwrap();
    finish(&engine, &source.id, "RECOVERY_SOURCE_SECRET").await;
    let caller = engine.create(cwd).await.unwrap();
    *fixture.calls.lock().unwrap() = [json!({"threadId":source.id})].into();
    *fixture.forged.lock().unwrap() = "Unfinished analysis. ".repeat(1200);
    *fixture.hold.lock().unwrap() = true;
    let turn = engine
        .start(
            &caller.id,
            vec![Input::text(format!(
                "Use [#Recovery](#sess_{}) {}",
                source.id,
                "retained requirement ".repeat(100)
            ))],
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), fixture.started.notified())
        .await
        .unwrap();
    engine.interrupt(&caller.id, &turn.id).await.unwrap();
    engine.wait(&caller.id).await.unwrap();
    *fixture.hold.lock().unwrap() = false;
    engine.context_compact(caller.id.clone()).await.unwrap();
    let record: Value = serde_json::from_slice(
        &std::fs::read(data.path().join(format!("{}.json", caller.id))).unwrap(),
    )
    .unwrap();
    assert!(record["thread"]["historyArchive"].is_object());
    engine.shutdown().await;
    drop(engine);
    *fixture.calls.lock().unwrap() = [json!({"threadId":source.id})].into();
    let engine = Engine::open(data.path(), fixture.clone(), Limits::default()).unwrap();
    let current = engine.read(&caller.id, true).await.unwrap();
    engine.submit_turn("fixture".into(), serde_json::from_value(json!({
        "threadId":caller.id,"requestId":"continue-after-restart","expectedConfigRevision":current.desktop.as_ref().map_or(1,|desktop| desktop.configuration.revision),
        "intent":{"type":"continue","expectedTurnId":turn.id}
    })).unwrap()).await.unwrap();
    let resumed = tokio::time::timeout(Duration::from_secs(15), engine.wait(&caller.id))
        .await
        .unwrap()
        .unwrap();
    let pages = results(&resumed);
    assert_eq!(pages.len(), 1);
    assert!(
        pages[0].0 && pages[0].1.to_string().contains("RECOVERY_SOURCE_SECRET"),
        "{:?}",
        pages
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn side_conversations_keep_their_frozen_source_boundary() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let fixture = Arc::new(Fixture::default());
    let engine = Engine::open(data.path(), fixture.clone(), Limits::default()).unwrap();
    let cwd = workspace.path().to_string_lossy().into_owned();
    let source = engine.create(cwd.clone()).await.unwrap();
    finish(&engine, &source.id, "SIDE_SOURCE").await;
    *fixture.side.lock().unwrap() = true;
    let (side, _) = engine
        .side_start(
            "fixture".into(),
            serde_json::from_value(json!({
                "requestId":"reference-side","sourceThreadId":source.id,"workspaceAccess":"none",
                "input":[{"type":"text","text":format!("Read [#Main](#sess_{}).",source.id)}]
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    let settled = tokio::time::timeout(Duration::from_secs(15), engine.wait(&side.id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(settled.turns.last().unwrap().status, TurnStatus::Completed);
    *fixture.side.lock().unwrap() = false;
    let caller = engine.create(cwd).await.unwrap();
    *fixture.calls.lock().unwrap() = [json!({"threadId":side.id})].into();
    let done = finish(
        &engine,
        &caller.id,
        format!("Read [#Side](#sess_{}).", side.id),
    )
    .await;
    assert!(!results(&done)[0].0);
    engine.shutdown().await;
}
