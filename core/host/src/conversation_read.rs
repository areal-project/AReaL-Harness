use super::{
    Host,
    conversation_media::{self, MediaCache, MediaParams, MediaReference},
    schedule_connection::{CoreEvent, CoreObservation},
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub(super) const PAGE_BYTES: usize = 128 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Identity {
    project_id: String,
    thread_id: String,
    service_generation: String,
    subscription_id: String,
    sequence: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct HistoryParams {
    thread_id: String,
    subscription_id: String,
    view: HistoryView,
    cursor: Option<String>,
    max_bytes: Option<usize>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum HistoryView {
    Own,
    Inherited,
    Reference,
}

pub(super) struct ConversationReader {
    identity: Identity,
    observation: CoreObservation,
    barrier: u64,
    snapshot: Value,
    history_media: std::cell::RefCell<Vec<MediaReference>>,
    media_cache: Option<MediaCache>,
}

impl ConversationReader {
    pub(super) async fn open(
        host: &Host,
        project: &str,
        generation: &str,
        thread_id: &str,
    ) -> Result<(Self, Value)> {
        ensure!(
            !thread_id.is_empty() && thread_id.len() <= 256,
            "INVALID_PARAMS"
        );
        let (snapshot, barrier, observation) = host
            .schedules
            .connections
            .conversation_observe(host, project, generation, thread_id, PAGE_BYTES)
            .await?;
        check_size(&snapshot)?;
        let reader = Self {
            identity: Identity {
                project_id: project.into(),
                thread_id: thread_id.into(),
                service_generation: generation.into(),
                subscription_id: uuid::Uuid::new_v4().to_string(),
                sequence: 0,
            },
            observation,
            barrier,
            snapshot,
            history_media: Default::default(),
            media_cache: None,
        };
        let mut result = reader.keys();
        result["snapshot"] = reader.snapshot.clone();
        Ok((reader, result))
    }

    pub(super) fn project(&self) -> &str {
        &self.identity.project_id
    }
    pub(super) fn generation(&self) -> &str {
        &self.identity.service_generation
    }
    pub(super) fn subscription(&self) -> &str {
        &self.identity.subscription_id
    }
    pub(super) fn current(&self, host: &Host) -> bool {
        self.observation.current(host)
    }
    pub(super) fn model(&self) -> Option<Value> {
        self.snapshot["thread"]["desktop"]["configuration"]
            .get("model")
            .cloned()
    }
    fn keys(&self) -> Value {
        let mut value = serde_json::to_value(&self.identity).unwrap();
        value["view"] = json!("conversation");
        value
    }
    pub(super) async fn next_event(&mut self) -> Result<CoreEvent> {
        self.observation
            .events
            .recv()
            .await
            .context("RESYNC_REQUIRED")
    }
    pub(super) async fn event(&mut self, host: &Host, event: CoreEvent) -> Result<Option<Value>> {
        ensure!(self.current(host), "RESYNC_REQUIRED");
        if event.sequence <= self.barrier {
            return Ok(None);
        }
        let params = &event.value["params"];
        let thread = params
            .get("threadId")
            .or_else(|| params["interaction"].get("threadId"))
            .or_else(|| params["thread"].get("id"));
        if thread.and_then(Value::as_str) != Some(self.identity.thread_id.as_str()) {
            return Ok(None);
        }
        let (snapshot, barrier) = self.observation.snapshot(host).await?;
        check_size(&snapshot)?;
        let patch = difference(&self.snapshot, &snapshot)?;
        self.snapshot = snapshot;
        self.barrier = barrier;
        let Some(patch) = patch else {
            return Ok(None);
        };
        self.identity.sequence += 1;
        let mut result = self.keys();
        result["event"] = json!("session.updated");
        result["patch"] = patch;
        Ok(Some(result))
    }
    pub(super) async fn history(&self, host: &Host, params: HistoryParams) -> Result<Value> {
        ensure!(
            params.thread_id == self.identity.thread_id
                && params.subscription_id == self.identity.subscription_id,
            "INVALID_PARAMS"
        );
        let max_bytes = params.max_bytes.unwrap_or(PAGE_BYTES);
        ensure!((1024..=PAGE_BYTES).contains(&max_bytes), "INVALID_PARAMS");
        ensure!(
            params
                .cursor
                .as_ref()
                .is_none_or(|cursor| !cursor.is_empty() && cursor.len() <= 16384),
            "INVALID_PARAMS"
        );
        ensure!(self.current(host), "RESYNC_REQUIRED");
        let view = serde_json::to_value(params.view)?;
        let page = self
            .observation
            .history(
                host,
                view.as_str().unwrap(),
                params.cursor.as_deref(),
                max_bytes,
            )
            .await?;
        check_size(&page)?;
        *self.history_media.borrow_mut() = conversation_media::page_references(&page);
        let mut result = self.keys();
        result["page"] = page;
        Ok(result)
    }
    pub(super) async fn media(&mut self, host: &Host, value: &Value) -> Result<Value> {
        let params: MediaParams =
            serde_json::from_value(value.clone()).map_err(|_| anyhow::anyhow!("INVALID_PARAMS"))?;
        ensure!(
            params.view == "conversation"
                && params.thread_id == self.identity.thread_id
                && params.subscription_id == self.identity.subscription_id
                && params.service_generation == self.identity.service_generation,
            "INVALID_PARAMS"
        );
        let offset = params.offset.unwrap_or(0);
        let length = params.length.unwrap_or(32 * 1024);
        ensure!(
            (1..=64 * 1024).contains(&length) && offset < conversation_media::MAX_BYTES,
            "INVALID_PARAMS"
        );
        ensure!(self.current(host), "RESYNC_REQUIRED");
        let requested = MediaReference::requested(&params)?;
        let reference = conversation_media::snapshot_references(&self.snapshot)
            .into_iter()
            .chain(self.history_media.borrow().iter().cloned())
            .find(|reference| reference.matches(&params))
            .unwrap_or(requested);
        if self
            .media_cache
            .as_ref()
            .is_none_or(|cache| cache.reference != reference)
        {
            self.media_cache = None;
            let cache = conversation_media::fetch(
                self.observation.service(),
                &self.identity.thread_id,
                reference,
                || {
                    ensure!(self.current(host), "RESYNC_REQUIRED");
                    Ok(())
                },
            )
            .await;
            ensure!(self.current(host), "RESYNC_REQUIRED");
            self.media_cache = Some(cache?);
        }
        ensure!(self.current(host), "RESYNC_REQUIRED");
        let chunk = self.media_cache.as_ref().unwrap().chunk(offset, length)?;
        let mut result = self.keys();
        result
            .as_object_mut()
            .unwrap()
            .extend(chunk.as_object().unwrap().clone());
        Ok(result)
    }
    pub(super) fn invalidated(&self, error: &anyhow::Error) -> Value {
        let mut result = self.keys();
        result["event"] = json!("session.invalidated");
        result["sequence"] = json!(self.identity.sequence + 1);
        let code = if error.to_string() == "RESOURCE_UNAVAILABLE" {
            "RESOURCE_UNAVAILABLE"
        } else {
            "RESYNC_REQUIRED"
        };
        result["error"] = json!({"code":code,"message":"观察连接已变化；请重新打开会话"});
        result
    }
}

fn check_size(value: &Value) -> Result<()> {
    ensure!(
        serde_json::to_vec(value)?.len() <= PAGE_BYTES,
        "RESOURCE_UNAVAILABLE"
    );
    Ok(())
}

fn without(value: &Value, key: &str) -> Result<Value> {
    let mut head = value.as_object().context("CORE_INCOMPATIBLE")?.clone();
    head.remove(key);
    Ok(Value::Object(head))
}
fn order(values: &[Value]) -> Result<Vec<&str>> {
    values
        .iter()
        .map(|value| value["id"].as_str().context("CORE_INCOMPATIBLE"))
        .collect()
}
fn difference(before: &Value, after: &Value) -> Result<Option<Value>> {
    if before == after {
        return Ok(None);
    }
    let mut patch = json!({"turns":[]});
    let head = |value: &Value| -> Result<Value> {
        let mut head = value.clone();
        head["thread"] = without(&value["thread"], "turns")?;
        Ok(head)
    };
    let after_head = head(after)?;
    if head(before)? != after_head {
        patch["head"] = after_head;
    }
    let old_turns = before["thread"]["turns"]
        .as_array()
        .context("CORE_INCOMPATIBLE")?;
    let new_turns = after["thread"]["turns"]
        .as_array()
        .context("CORE_INCOMPATIBLE")?;
    if order(old_turns)? != order(new_turns)? {
        patch["order"] = json!(order(new_turns)?);
    }
    for turn in new_turns {
        let previous = old_turns.iter().find(|old| old["id"] == turn["id"]);
        if previous == Some(turn) {
            continue;
        }
        let mut change = json!({"id":turn["id"],"items":[]});
        let turn_head = without(turn, "items")?;
        if previous
            .map(|old| without(old, "items"))
            .transpose()?
            .as_ref()
            != Some(&turn_head)
        {
            change["head"] = turn_head;
        }
        let items = turn["items"].as_array().context("CORE_INCOMPATIBLE")?;
        let old_items = previous
            .and_then(|old| old["items"].as_array())
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        if previous.is_none() || order(old_items)? != order(items)? {
            change["order"] = json!(order(items)?);
        }
        for item in items {
            if old_items.iter().find(|old| old["id"] == item["id"]) != Some(item) {
                change["items"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"id":item["id"],"value":item}));
            }
        }
        patch["turns"].as_array_mut().unwrap().push(change);
    }
    Ok(Some(patch))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn conversation_media_binds_subscription_and_reuses_one_authorized_download() {
        use base64::{Engine, engine::general_purpose::STANDARD};
        use futures_util::{SinkExt, StreamExt};
        use sha2::{Digest, Sha256};
        use std::rc::Rc;
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };
        use tokio_tungstenite::tungstenite::Message;

        tokio::task::LocalSet::new().run_until(async {
            let root = tempfile::tempdir().unwrap();
            let host = Rc::new(super::super::schedules::tests::fixture(root.path()));
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let registration = host.slots.borrow()["project"].registration.clone();
            let service: areal_protocol::service::Service = serde_json::from_value(json!({
                "protocolVersion":1,"serviceId":"core","generation":"first","workspace":registration.workspace,"dataDir":registration.data_dir,"configFingerprint":"test",
                "owner":null,"endpoint":format!("ws://{}/",listener.local_addr().unwrap()),"webUrl":"","authFile":root.path().join("auth.json"),"logFile":root.path().join("core.log"),"hostPid":1,"corePid":2,"state":"ready"
            })).unwrap();
            areal_local_service::storage::write(&service.auth_file, &json!({"principals":[{"id":"desktop-owner","token":"private-owner"}]})).unwrap();
            {
                let mut slots = host.slots.borrow_mut();
                let slot = slots.get_mut("project").unwrap();
                slot.service = Some(service.clone());
                slot.state = "ready".into();
            }
            let bytes = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aKsAAAAASUVORK5CYII=").unwrap();
            let uri = format!("areal://blob/{:x}", Sha256::digest(&bytes));
            let observed = json!({"thread":{"id":"selected","turns":[{"id":"turn","items":[{"id":"image","type":"agentMedia","media":{"uri":uri,"mimeType":"image/png","sizeBytes":bytes.len()}}]}]}});
            let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
            let expected_bytes = bytes.clone();
            let server = tokio::task::spawn_local(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                for expected in ["initialize", "areal/capabilities", "areal/thread/observe"] {
                    loop {
                        let message = socket.next().await.unwrap().unwrap();
                        let Message::Text(text) = message else { continue; };
                        let request: Value = serde_json::from_str(&text).unwrap();
                        if request["method"] == "initialized" { continue; }
                        assert_eq!(request["method"], expected);
                        let result = match expected { "initialize" => json!({}), "areal/capabilities" => json!({"features":{"conversationObservation":true}}), _ => observed.clone() };
                        socket.send(Message::Text(json!({"id":request["id"],"result":result}).to_string().into())).await.unwrap();
                        break;
                    }
                }
                let (mut http, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    http.read_exact(&mut byte).await.unwrap();
                    request.push(byte[0]);
                    assert!(request.len() < 8192);
                }
                let request = String::from_utf8(request).unwrap();
                assert!(request.lines().next().unwrap().ends_with("?threadId=selected HTTP/1.1"));
                assert!(request.to_ascii_lowercase().contains("authorization: bearer private-owner\r\n"));
                http.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", bytes.len()).as_bytes()).await.unwrap();
                http.write_all(&bytes).await.unwrap();
                drop(http);
                tokio::select! {
                    _ = stop_rx => {},
                    _ = listener.accept() => panic!("a cached image chunk must not download the blob again"),
                }
                drop(socket);
            });
            let close = host.schedules.connections.connect_test_core(host.clone(), "project", service).await.unwrap();
            let (mut reader, _) = ConversationReader::open(&host, "project", "first", "selected").await.unwrap();
            let params = json!({"view":"conversation","threadId":"selected","subscriptionId":reader.subscription(),"serviceGeneration":"first","turnId":"turn","itemId":"image","uri":uri,"length":32});
            for field in ["threadId", "subscriptionId", "serviceGeneration"] {
                let mut wrong = params.clone();
                wrong[field] = json!("foreign");
                assert_eq!(reader.media(&host, &wrong).await.unwrap_err().to_string(), "INVALID_PARAMS");
            }
            let mut wrong = params.clone();
            wrong["uri"] = json!("file:///private/secret");
            assert_eq!(reader.media(&host, &wrong).await.unwrap_err().to_string(), "RESOURCE_UNAVAILABLE");
            let first = reader.media(&host, &params).await.unwrap();
            let mut next = params.clone();
            next["offset"] = first["nextOffset"].clone();
            next["length"] = json!(65536);
            let second = reader.media(&host, &next).await.unwrap();
            assert_eq!(first["subscriptionId"], params["subscriptionId"]);
            assert_eq!(first["sourceThreadId"], "selected");
            let mut result = STANDARD.decode(first["base64"].as_str().unwrap()).unwrap();
            result.extend(STANDARD.decode(second["base64"].as_str().unwrap()).unwrap());
            assert_eq!(result, expected_bytes);
            host.slots.borrow_mut().get_mut("project").unwrap().service.as_mut().unwrap().identity.generation = "second".into();
            assert_eq!(reader.media(&host, &params).await.unwrap_err().to_string(), "RESYNC_REQUIRED");
            stop_tx.send(()).unwrap();
            server.await.unwrap();
            close();
        }).await;
    }

    fn apply(mut snapshot: Value, patch: &Value) -> Value {
        if let Some(head) = patch.get("head") {
            let turns = snapshot["thread"]["turns"].take();
            snapshot = head.clone();
            snapshot["thread"]["turns"] = turns;
        }
        for change in patch["turns"].as_array().unwrap() {
            let turns = snapshot["thread"]["turns"].as_array_mut().unwrap();
            let index = turns
                .iter()
                .position(|turn| turn["id"] == change["id"])
                .unwrap_or_else(|| {
                    turns.push(json!({"id":change["id"],"items":[]}));
                    turns.len() - 1
                });
            let turn = &mut turns[index];
            if let Some(head) = change.get("head") {
                let items = turn["items"].take();
                *turn = head.clone();
                turn["items"] = items;
            }
            for item in change["items"].as_array().unwrap() {
                let items = turn["items"].as_array_mut().unwrap();
                if let Some(old) = items.iter_mut().find(|old| old["id"] == item["id"]) {
                    *old = item["value"].clone();
                } else {
                    items.push(item["value"].clone());
                }
            }
            if let Some(order) = change.get("order") {
                turn["items"] = order
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|id| {
                        turn["items"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|item| item["id"] == *id)
                            .unwrap()
                            .clone()
                    })
                    .collect();
            }
        }
        if let Some(order) = patch.get("order") {
            snapshot["thread"]["turns"] = order
                .as_array()
                .unwrap()
                .iter()
                .map(|id| {
                    snapshot["thread"]["turns"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|turn| turn["id"] == *id)
                        .unwrap()
                        .clone()
                })
                .collect();
        }
        snapshot
    }

    #[test]
    fn conversation_patch_preserves_native_fields_and_only_sends_changed_item() {
        let before = json!({"thread":{"id":"thread","updatedAt":1,"desktop":{"configuration":{"model":{"contextWindow":100000}}},"turns":[
            {"id":"inherited","sourceTurnId":"original","status":"completed","items":[{"id":"old","sourceItemId":"source-old","text":"unchanged".repeat(3000)}]},
            {"id":"active","status":"inProgress","items":[{"id":"image","type":"image","media":{"source":"fixture.png","width":720}},{"id":"answer","type":"agentMessage","text":"one"}]}
        ]},"ownership":{"kind":"main"},"history":{"view":"own","complete":false,"nextCursor":"native-cursor"}});
        let mut after = before.clone();
        after["thread"]["updatedAt"] = json!(2);
        after["thread"]["turns"][1]["items"][1]["text"] = json!("one two");
        let patch = difference(&before, &after).unwrap().unwrap();
        assert_eq!(patch["turns"].as_array().unwrap().len(), 1);
        assert_eq!(patch["turns"][0]["items"].as_array().unwrap().len(), 1);
        assert_eq!(patch["turns"][0]["items"][0]["id"], "answer");
        assert!(patch.get("order").is_none());
        assert_eq!(apply(before.clone(), &patch), after);
        let baseline = serde_json::to_vec(&after).unwrap().len();
        let delta = serde_json::to_vec(&patch).unwrap().len();
        eprintln!("conversation streaming serialized bytes snapshot={baseline} patch={delta}");
        assert!(delta < baseline / 10);
        assert!(difference(&after, &after).unwrap().is_none());

        let mut changed = after.clone();
        changed["thread"]["turns"].as_array_mut().unwrap().remove(0);
        changed["thread"]["turns"][0]["items"]
            .as_array_mut()
            .unwrap()
            .remove(0);
        changed["thread"]["turns"][0]["status"] = json!("completed");
        changed["thread"]["turns"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"new","customMetadata":{"source":"native"},"items":[]}));
        assert_eq!(
            apply(
                after.clone(),
                &difference(&after, &changed).unwrap().unwrap()
            ),
            changed
        );
        assert_eq!(
            apply(
                changed.clone(),
                &difference(&changed, &after).unwrap().unwrap()
            ),
            after
        );
    }
}
