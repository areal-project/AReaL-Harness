use super::*;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    scope: String,
    fence: Option<String>,
    upper: Option<String>,
    before: Option<String>,
    item: Option<String>,
    offset: usize,
    version: Option<String>,
}
impl Cursor {
    fn encoded(&self) -> String {
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(self).expect("history cursor serializes"))
    }
    fn snapshot(&self) -> String {
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(&self.scope, &self.fence, &self.upper)).unwrap())
        )
    }
}
fn failure(thread: &Thread, reason: &'static str, restart_cursor: Option<String>) -> crate::Error {
    crate::Error::HistoryRead {
        reason,
        thread_id: thread.id.clone(),
        restart_cursor,
    }
}
fn storage(error: anyhow::Error) -> crate::Error {
    crate::Error::Storage(error.to_string())
}

fn walk(
    root: &Path,
    thread: &Thread,
    mut visit: impl FnMut(&Turn, &Item, bool) -> crate::Result<bool>,
) -> crate::Result<()> {
    fn scan(
        turns: &[Turn],
        visit: &mut impl FnMut(&Turn, &Item, bool) -> crate::Result<bool>,
    ) -> crate::Result<bool> {
        let oldest_turn = turns.iter().position(|turn| !turn.items.is_empty());
        for (turn_index, turn) in turns.iter().enumerate().rev() {
            for (item_index, item) in turn.items.iter().enumerate().rev() {
                if visit(
                    turn,
                    item,
                    Some(turn_index) == oldest_turn && item_index == 0,
                )? {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
    if scan(&thread.turns, &mut visit)? {
        return Ok(());
    }
    let mut cursor = thread.history_archive.clone();
    let mut seen = std::collections::HashSet::new();
    while let Some(reference) = cursor {
        if !seen.insert(reference.head.clone()) {
            return Err(crate::Error::Storage("cyclic history archive".into()));
        }
        let segment = read_segment(root, &reference.head).map_err(storage)?;
        if scan(&segment.turns, &mut visit)? {
            break;
        }
        cursor = segment.previous;
    }
    Ok(())
}
fn sealed_item(turn: &Turn, item: &Item) -> bool {
    turn.status != TurnStatus::InProgress
        || matches!(
            item,
            Item::UserMessage { .. }
                | Item::DynamicToolCall {
                    status: ToolStatus::Completed | ToolStatus::Failed,
                    ..
                }
        )
}
fn entry(thread: &Thread, turn: &Turn, item: &Item) -> Value {
    let presentation = json!({"id":turn.id,"status":turn.status,"error":turn.error,
        "interruption":turn.interruption,"continuedFromTurnId":turn.continued_from_turn_id,
        "startedAt":turn.started_at,"completedAt":turn.completed_at,"durationMs":turn.duration_ms,
        "goal":turn.goal,"usage":turn.usage,"generation":turn.generation,"trace":turn.trace,"configuration":turn.configuration});
    json!({"sourceThreadId":thread.id,"sourceTurnId":turn.id,"sourceItemId":item.id(),
        "sourceTurnStatus":turn.status,"turn":presentation,"item":item})
}
fn projected(
    mut template: Option<Value>,
    empty_active_turn: Option<&Turn>,
    snapshot: &str,
    newest_first: &[Value],
    next: Option<String>,
) -> Value {
    let data: Vec<Value> = newest_first.iter().rev().cloned().collect();
    let window = json!({"snapshotId":snapshot,"nextCursor":next,"complete":next.is_none()});
    if let Some(ref mut result) = template {
        let mut turns: Vec<Value> = Vec::new();
        for entry in data {
            if turns
                .last()
                .is_none_or(|turn| turn["id"] != entry["sourceTurnId"])
            {
                let mut turn = entry["turn"].clone();
                turn["items"] = json!([]);
                turns.push(turn);
            }
            let turn = turns.last_mut().unwrap();
            let items = turn["items"].take();
            *turn = entry["turn"].clone();
            turn["items"] = items;
            turn["items"]
                .as_array_mut()
                .unwrap()
                .push(entry["item"].clone());
        }
        if let Some(active) = empty_active_turn
            && !turns.iter().any(|turn| turn["id"] == active.id)
        {
            turns.push(json!(active));
        }
        result["thread"]["turns"] = json!(turns);
        result["history"] = window;
        template.unwrap()
    } else {
        json!({"snapshotId":snapshot,"data":data,"nextCursor":next,"complete":next.is_none()})
    }
}
fn bytes(value: &Value) -> usize {
    serde_json::to_vec(value)
        .expect("display JSON serializes")
        .len()
}

const MAX_CACHED_ENTRY_BYTES: usize = 128 * 1024 * 1024;

fn serialized_entry(
    cache: &std::sync::Mutex<Option<Arc<CachedOwnHistoryEntry>>>,
    scope: &str,
    entry: Value,
) -> Arc<CachedOwnHistoryEntry> {
    let previous = cache.lock().unwrap().clone();
    if let Some(previous) = previous
        && previous.scope == scope
        && previous.entry == entry
    {
        return previous;
    }
    let serialized: Arc<str> = serde_json::to_string(&entry).unwrap().into();
    let version = format!("{:x}", Sha256::digest(serialized.as_bytes()));
    let encoded = Arc::new(CachedOwnHistoryEntry {
        scope: scope.into(),
        entry,
        serialized,
        version,
    });
    let retained = (encoded.serialized.len() <= MAX_CACHED_ENTRY_BYTES).then(|| encoded.clone());
    let evicted = {
        let mut held = cache.lock().unwrap();
        std::mem::replace(&mut *held, retained)
    };
    drop(evicted);
    encoded
}

impl Store {
    pub(crate) async fn own_history_page(
        &self,
        thread: Thread,
        identity: String,
        cursor: Option<String>,
        max_bytes: usize,
        template: Option<Value>,
        empty_active_turn: Option<Turn>,
    ) -> crate::Result<Value> {
        let permit = self
            .fork_reads
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| crate::Error::Storage(e.to_string()))?;
        let root = self.root.clone();
        let cached_entry = self.own_history_entry.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let scope = format!("{:x}", Sha256::digest(serde_json::to_vec(&(identity, &thread.id, &thread.session_id, "own")).unwrap()));
            let mut cursor = if let Some(encoded) = cursor {
                if encoded.len() > 8192 { return Err(failure(&thread, "HISTORY_CURSOR_STALE", None)); }
                let decoded: Cursor = URL_SAFE_NO_PAD.decode(encoded).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).ok_or_else(|| failure(&thread, "HISTORY_CURSOR_STALE", None))?;
                if decoded.scope != scope { return Err(failure(&thread, "HISTORY_CURSOR_STALE", None)); }
                let mut fence_found = decoded.fence.is_none();
                let mut upper_found = decoded.upper.is_none();
                walk(&root, &thread, |_, item, _| {
                    fence_found |= decoded.fence.as_deref() == Some(item.id());
                    upper_found |= decoded.upper.as_deref() == Some(item.id());
                    Ok(fence_found && upper_found)
                })?;
                if !fence_found || !upper_found { return Err(failure(&thread, "HISTORY_CURSOR_STALE", None)); }
                decoded
            } else {
                let mut fence = None;
                let mut upper = None;
                walk(&root, &thread, |turn, item, _| {
                    if fence.is_none() && matches!(item, Item::UserMessage { .. }) { fence = Some(item.id().to_owned()); }
                    if upper.is_none() && sealed_item(turn, item) { upper = Some(item.id().to_owned()); }
                    Ok(fence.is_some() && upper.is_some())
                })?;
                Cursor { scope, fence, upper, before: None, item: None, offset: 0, version: None }
            };
            let snapshot = cursor.snapshot();
            if cursor.item.is_some() {
                let mut selected = None;
                walk(&root, &thread, |turn, item, _| {
                    if cursor.item.as_deref() == Some(item.id()) { selected = Some(entry(&thread, turn, item)); return Ok(true); }
                    Ok(false)
                })?;
                let entry = selected.ok_or_else(|| failure(&thread, "HISTORY_CURSOR_STALE", None))?;
                let encoded = serialized_entry(&cached_entry, &cursor.scope, entry);
                let serialized = &encoded.serialized;
                let version = &encoded.version;
                let entry = &encoded.entry;
                if cursor.version.as_deref() != Some(version.as_str()) {
                    cursor.offset = 0;
                    cursor.version = Some(version.clone());
                    return Err(failure(&thread, "HISTORY_ITEM_CHANGED", Some(cursor.encoded())));
                }
                if cursor.offset >= serialized.len() || !serialized.is_char_boundary(cursor.offset) { return Err(failure(&thread, "HISTORY_CURSOR_STALE", None)); }
                let remaining = &serialized[cursor.offset..];
                let fragment_page = |part: &str| {
                    let mut next = cursor.clone();
                    next.offset += part.len();
                    let next_cursor = (next.offset < serialized.len()).then(|| next.encoded());
                    json!({"snapshotId":snapshot,"data":[{"sourceThreadId":entry["sourceThreadId"],"sourceTurnId":entry["sourceTurnId"],"sourceItemId":entry["sourceItemId"],"sourceTurnStatus":entry["sourceTurnStatus"],"fragment":{"text":part,"offsetUtf8":cursor.offset,"nextOffsetUtf8":next.offset,"totalBytes":serialized.len(),"version":version}}],"nextCursor":next_cursor,"complete":next_cursor.is_none()})
                };
                return super::super::fit_history_fragment(remaining, max_bytes, fragment_page)
                    .ok_or_else(|| failure(&thread, "HISTORY_BUDGET_TOO_SMALL", None));
            }
            let observing = template.is_some();
            let mut data = Vec::new();
            let mut checkpoints = Vec::new();
            let mut fitted = 0;
            let mut check_at = 1;
            let mut singleton_overhead = None;
            let mut found = cursor.before.is_none();
            let mut sealed = false;
            let mut next = None;
            walk(&root, &thread, |turn, item, at_segment_end| {
                if !sealed { sealed = cursor.upper.as_deref() == Some(item.id()); }
                if !observing && !sealed { return Ok(false); }
                if !found { found = cursor.before.as_deref() == Some(item.id()); return Ok(false); }
                let mut value = entry(&thread, turn, item);
                let mut after = cursor.clone();
                after.before = sealed.then(|| item.id().into());
                let candidate_next = Some(after.encoded());
                let single_bytes = if observing {
                    let cursor_bytes = serde_json::to_vec(&candidate_next).unwrap().len();
                    let overhead = match singleton_overhead.as_ref() {
                        Some((id, overhead)) if id == &turn.id => *overhead,
                        _ => {
                            let item = value["item"].take();
                            let single = projected(template.clone(), empty_active_turn.as_ref(), &snapshot, std::slice::from_ref(&value), candidate_next.clone());
                            let overhead = bytes(&single) - bytes(&Value::Null) - cursor_bytes;
                            value["item"] = item;
                            singleton_overhead = Some((turn.id.clone(), overhead));
                            overhead
                        }
                    };
                    overhead + bytes(&value["item"]) + cursor_bytes
                } else {
                    bytes(&projected(template.clone(), empty_active_turn.as_ref(), &snapshot, std::slice::from_ref(&value), candidate_next.clone()))
                };
                if at_segment_end { singleton_overhead = None; }
                if single_bytes > max_bytes {
                    let serialized = serde_json::to_vec(&value).unwrap();
                    let version = format!("{:x}", Sha256::digest(&serialized));
                    let mut fragment = cursor.clone();
                    fragment.item = Some(item.id().into());
                    fragment.before = None;
                    fragment.version = Some(version.clone());
                    fragment.offset = 0;
                    value["item"] = json!({"type":"historyDeferred","id":item.id(),"originalType":value["item"]["type"],"cursor":fragment.encoded(),"version":version,"totalBytes":serialized.len()});
                }
                data.push(value);
                checkpoints.push((candidate_next, sealed));
                if data.len() < check_at && !at_segment_end { return Ok(false); }
                let fits = |count: usize| bytes(&projected(template.clone(), empty_active_turn.as_ref(), &snapshot, &data[..count], checkpoints[count - 1].0.clone())) <= max_bytes;
                if !fits(data.len()) {
                    let mut overflow = data.len();
                    while overflow - fitted > 1 {
                        let middle = fitted + (overflow - fitted) / 2;
                        if fits(middle) { fitted = middle; } else { overflow = middle; }
                    }
                    if fitted == 0 || !checkpoints[overflow - 1].1 { return Err(failure(&thread,"HISTORY_BUDGET_TOO_SMALL",None)); }
                    data.truncate(fitted);
                    next = checkpoints[fitted - 1].0.clone();
                    return Ok(true);
                }
                fitted = data.len();
                check_at = fitted.saturating_mul(2);
                next = checkpoints[fitted - 1].0.clone();
                Ok(false)
            })?;
            if !found { return Err(failure(&thread,"HISTORY_CURSOR_STALE",None)); }
            if let Some(last) = data.last() {
                let mut past = false;
                let mut more = false;
                walk(&root, &thread, |_,item, _| {
                    if !past { past = last["sourceItemId"] == item.id(); return Ok(false); }
                    more = true;
                    Ok(true)
                })?;
                if !more { next = None; }
            } else { next = None; }
            let result = projected(template, empty_active_turn.as_ref(), &snapshot, &data, next);
            if bytes(&result) > max_bytes { return Err(failure(&thread,"HISTORY_BUDGET_TOO_SMALL",None)); }
            Ok(result)
        }).await.map_err(|e| crate::Error::Storage(e.to_string()))?
    }
}
