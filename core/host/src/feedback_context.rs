//! 冻结截至被评价回复的完整权威历史；继承分片不完整时拒绝，不截断证据。
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{collections::BTreeMap, future::Future};

pub(super) const MAX_BYTES: usize = 16 * 1024 * 1024;

fn append(
    turns: &mut Vec<Value>,
    indices: &mut BTreeMap<String, usize>,
    entry: Value,
) -> Result<()> {
    let id = entry["sourceTurnId"].as_str().context("INVALID_RESPONSE")?;
    let index = if let Some(index) = indices.get(id) {
        *index
    } else {
        let mut turn = entry["turn"].clone();
        ensure!(
            turn.is_object()
                && entry["sourceThreadId"].is_string()
                && entry["sourceTurnStatus"].is_string(),
            "INVALID_RESPONSE"
        );
        turn["id"] = json!(id);
        turn["sourceThreadId"] = entry["sourceThreadId"].clone();
        turn["status"] = entry["sourceTurnStatus"].clone();
        turn["items"] = json!([]);
        let index = turns.len();
        indices.insert(id.into(), index);
        turns.push(turn);
        index
    };
    ensure!(entry["item"].is_object(), "INVALID_RESPONSE");
    turns[index]["items"]
        .as_array_mut()
        .unwrap()
        .push(entry["item"].clone());
    Ok(())
}

pub(super) async fn freeze<F, Fut>(
    mut request: F,
    thread_id: &str,
    turn_id: &str,
    item_id: &str,
) -> Result<(Value, String)>
where
    F: FnMut(&'static str, Value) -> Fut,
    Fut: Future<Output = Result<Value>>,
{
    let value = request(
        "thread/read",
        json!({"threadId":thread_id,"includeTurns":true}),
    )
    .await?;
    let thread = &value["thread"];
    ensure!(
        thread["id"] == thread_id && thread["conversation"]["kind"] != "side",
        "INVALID_PARAMS"
    );
    let own = thread["turns"].as_array().context("INVALID_RESPONSE")?;
    let index = own
        .iter()
        .position(|turn| turn["id"] == turn_id)
        .context("INVALID_PARAMS")?;
    let target = &own[index];
    ensure!(
        target["status"].is_string() && target["status"] != "inProgress",
        "RESOURCE_BUSY"
    );
    let item_index = target["items"]
        .as_array()
        .context("INVALID_RESPONSE")?
        .iter()
        .position(|item| item["id"] == item_id && item["type"] == "agentMessage")
        .context("INVALID_PARAMS")?;
    let mut turns = Vec::new();
    if thread["conversation"]["kind"] == "fork"
        && let Some(seed) = thread["conversation"]["historySeed"]["snapshotId"].as_str()
    {
        let mut indices = BTreeMap::new();
        let mut cursor: Option<String> = None;
        let mut partial: Option<(String, String)> = None;
        let mut bytes = 0_usize;
        let mut complete = false;
        for _ in 0..10000 {
            let mut input = json!({"threadId":thread_id,"view":"inherited","maxBytes":65536});
            if let Some(cursor) = &cursor {
                input["cursor"] = json!(cursor);
            }
            let page = request("areal/conversation/history", input).await?;
            ensure!(page["snapshotId"] == seed, "RESYNC_REQUIRED");
            bytes = bytes.saturating_add(serde_json::to_vec(&page)?.len());
            ensure!(bytes <= MAX_BYTES, "LIMIT_EXCEEDED");
            for entry in page["data"].as_array().context("INVALID_RESPONSE")? {
                if entry.get("fragment").is_none() {
                    ensure!(partial.is_none(), "INVALID_RESPONSE");
                    append(&mut turns, &mut indices, entry.clone())?;
                    continue;
                }
                let fragment = &entry["fragment"];
                let id = entry["sourceItemId"].as_str().context("INVALID_RESPONSE")?;
                ensure!(
                    fragment["offsetUtf8"].as_u64()
                        == Some(partial.as_ref().map_or(0, |(_, text)| text.len()) as u64)
                        && partial.as_ref().is_none_or(|(previous, _)| previous == id),
                    "INVALID_RESPONSE"
                );
                let mut text = partial.take().map_or_else(String::new, |(_, text)| text);
                text.push_str(fragment["text"].as_str().context("INVALID_RESPONSE")?);
                let total = fragment["totalBytes"]
                    .as_u64()
                    .context("INVALID_RESPONSE")?;
                ensure!(
                    text.len() as u64 <= total && text.len() <= MAX_BYTES,
                    "LIMIT_EXCEEDED"
                );
                if text.len() as u64 == total {
                    append(&mut turns, &mut indices, serde_json::from_str(&text)?)?;
                } else {
                    partial = Some((id.into(), text));
                }
            }
            if page["complete"] == true {
                ensure!(partial.is_none(), "INVALID_RESPONSE");
                complete = true;
                break;
            }
            let next = page["nextCursor"]
                .as_str()
                .filter(|value| !value.is_empty())
                .context("INVALID_RESPONSE")?;
            ensure!(cursor.as_deref() != Some(next), "RESYNC_REQUIRED");
            cursor = Some(next.into());
        }
        ensure!(complete, "LIMIT_EXCEEDED");
    }
    let mut prefix = own[..=index].to_vec();
    prefix[index]["items"]
        .as_array_mut()
        .unwrap()
        .truncate(item_index + 1);
    turns.extend(prefix);
    ensure!(turns.len() <= 1000, "LIMIT_EXCEEDED");
    let context = json!({"schema_version":"areal.feedback-context/v1","origin":"core_history_projection",
        "thread_id":thread_id,"through_turn_id":turn_id,"through_item_id":item_id,"turns":turns});
    let bytes = serde_json::to_vec(&context)?;
    ensure!(bytes.len() <= MAX_BYTES, "LIMIT_EXCEEDED");
    Ok((context, areal_local_service::storage::digest(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thread() -> Value {
        json!({"id":"main","turns":[
            {"id":"first","status":"completed","items":[{"id":"question","type":"userMessage","content":[{"type":"text","text":"original"}]},
                {"id":"reply","type":"agentMessage","text":"answer"},{"id":"later-item","type":"modelContext","value":"later"}]},
            {"id":"future","status":"inProgress","items":[{"id":"new-question","type":"userMessage","content":[]}]}]})
    }

    #[tokio::test]
    async fn freezes_only_the_authoritative_prefix_and_rejects_active_or_side_sources() {
        let value = thread();
        let (context, hash) = freeze(
            |method, params| {
                assert_eq!(method, "thread/read");
                assert_eq!(params, json!({"threadId":"main","includeTurns":true}));
                let value = value.clone();
                async move { Ok(json!({"thread":value})) }
            },
            "main",
            "first",
            "reply",
        )
        .await
        .unwrap();
        assert_eq!(context["turns"].as_array().unwrap().len(), 1);
        assert_eq!(context["turns"][0]["items"].as_array().unwrap().len(), 2);
        assert_eq!(
            context["turns"][0]["items"][0]["content"][0]["text"],
            "original"
        );
        assert!(hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()));
        let mut side = thread();
        side["conversation"] = json!({"kind":"side"});
        assert!(
            freeze(
                |_, _| {
                    let side = side.clone();
                    async move { Ok(json!({"thread":side})) }
                },
                "main",
                "first",
                "reply"
            )
            .await
            .is_err()
        );
        assert!(
            freeze(
                |_, _| async { Ok(json!({"thread":thread()})) },
                "main",
                "future",
                "new-question"
            )
            .await
            .is_err()
        );
    }

    #[tokio::test]
    async fn inherited_utf8_fragments_are_complete_and_bound_to_the_original_snapshot() {
        let mut main = thread();
        main["conversation"] = json!({"kind":"fork","historySeed":{"snapshotId":"seed"}});
        let entry = json!({"sourceThreadId":"ancestor","sourceTurnId":"inherited","sourceTurnStatus":"completed","sourceItemId":"old-reply",
            "turn":{"id":"inherited","status":"completed"},"item":{"id":"old-reply","type":"agentMessage","text":"完整继承上下文🌊"}});
        let raw = entry.to_string();
        let split = raw.find('🌊').unwrap();
        let pages = vec![
            json!({"snapshotId":"seed","data":[{"sourceItemId":"old-reply","fragment":{"offsetUtf8":0,"totalBytes":raw.len(),"text":&raw[..split]}}],"complete":false,"nextCursor":"page2"}),
            json!({"snapshotId":"seed","data":[{"sourceItemId":"old-reply","fragment":{"offsetUtf8":split,"totalBytes":raw.len(),"text":&raw[split..]}}],"complete":true}),
        ];
        for broken in [false, true] {
            let mut pending = std::collections::VecDeque::from(pages.clone());
            if broken {
                pending[1]["snapshotId"] = json!("changed");
            }
            let result = freeze(
                |method, params| {
                    let result = if method == "thread/read" {
                        json!({"thread":main})
                    } else {
                        assert_eq!(method, "areal/conversation/history");
                        if pending.len() == 1 {
                            assert_eq!(params["cursor"], "page2");
                        }
                        pending.pop_front().unwrap()
                    };
                    async move { Ok(result) }
                },
                "main",
                "first",
                "reply",
            )
            .await;
            if broken {
                assert!(result.is_err());
            } else {
                let (context, _) = result.unwrap();
                assert_eq!(context["turns"].as_array().unwrap().len(), 2);
                assert_eq!(context["turns"][0]["sourceThreadId"], "ancestor");
                assert_eq!(context["turns"][0]["items"][0]["text"], "完整继承上下文🌊");
            }
        }
    }
}
