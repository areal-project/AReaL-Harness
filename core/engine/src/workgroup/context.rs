//! A model-view window; durable Engine history is never modified or summarized.
use crate::model::Message;
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub original_bytes: usize,
    pub sent_bytes: usize,
    pub omitted_messages: usize,
}

fn bytes(message: &Message) -> usize {
    message.text_content().len()
        + message
            .tool_calls
            .iter()
            .map(|v| v.to_string().len())
            .sum::<usize>()
}

/// Preserve all leading instructions and the newest eight assistant exchanges.
/// Cut only before assistant messages, keeping each tool call with its results.
/// This is a soft byte target: retained instructions/recent exchanges may exceed
/// it, and non-text conversations are left intact. Zero disables the window.
pub fn window(messages: Vec<Message>, target: usize) -> (Vec<Message>, Observation) {
    let sizes: Vec<_> = messages.iter().map(bytes).collect();
    let mut suffix = vec![0; sizes.len() + 1];
    for i in (0..sizes.len()).rev() {
        suffix[i] = suffix[i + 1] + sizes[i];
    }
    let original_bytes = suffix[0];
    let mut observation = Observation {
        original_bytes,
        sent_bytes: original_bytes,
        omitted_messages: 0,
    };
    if target == 0
        || original_bytes <= target
        || messages.iter().any(|m| {
            m.content
                .iter()
                .any(|p| !matches!(p, crate::model::ContentPart::Text(_)))
        })
    {
        return (messages, observation);
    }
    let first = messages
        .iter()
        .position(|m| m.role == "assistant")
        .unwrap_or(messages.len());
    // A later user instruction must not be accidentally evicted. Workgroup's
    // ordinary single turn has only the leading assignment, but keep this safe
    // if Engine later supports feedback injection during a worker turn.
    if messages[first..]
        .iter()
        .any(|m| m.role != "assistant" && m.role != "tool")
    {
        return (messages, observation);
    }
    let boundaries: Vec<_> = messages
        .iter()
        .enumerate()
        .skip(first)
        .filter_map(|(i, m)| (m.role == "assistant").then_some(i))
        .collect();
    if boundaries.len() <= 8 {
        return (messages, observation);
    }
    let prefix_bytes = original_bytes - suffix[first];
    let mut cut = first;
    for &boundary in boundaries.iter().skip(1).take(boundaries.len() - 8) {
        cut = boundary;
        if prefix_bytes + suffix[cut] <= target {
            break;
        }
    }
    if cut == first {
        return (messages, observation);
    }
    // Refuse an unsafe boundary if a retained result belongs to an omitted
    // assistant call (including providers that emit interleaved call batches).
    let retained_calls: std::collections::BTreeSet<_> = messages[cut..]
        .iter()
        .flat_map(|m| &m.tool_calls)
        .filter_map(|v| v["id"].as_str())
        .collect();
    if messages[cut..]
        .iter()
        .filter(|m| m.role == "tool")
        .any(|m| {
            m.tool_call_id
                .as_deref()
                .is_none_or(|id| !retained_calls.contains(id))
        })
    {
        return (messages, observation);
    }
    let mut kept = messages[..first].to_vec();
    kept.push(Message::text("user", format!(
        "Context window: {} older assistant/tool messages are omitted from this model view. The durable execution history is retained. The initial source excerpt describes the attempt's starting snapshot, not current source. Re-read current files when needed; do not infer success from omitted results. Continue the assigned task and use the declared checks.", cut - first)));
    kept.extend_from_slice(&messages[cut..]);
    observation.omitted_messages = cut - first;
    observation.sent_bytes = kept.iter().map(bytes).sum();
    (kept, observation)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn window_preserves_contract_recent_edits_and_call_result_pairs() {
        let mut messages = vec![Message::text("user", "Keep the exact contract")];
        for i in 0..20 {
            let mut call = Message::text("assistant", format!("step {i}"));
            call.tool_calls
                .push(json!({"id":i.to_string(),"function":{"name":"read","arguments":"{}"}}));
            messages.push(call);
            let mut result = Message::text("tool", "x".repeat(4000));
            result.tool_call_id = Some(i.to_string());
            messages.push(result);
        }
        let original = messages.clone();
        let (kept, audit) = window(messages, 40000);
        assert!(audit.omitted_messages > 0 && audit.sent_bytes < audit.original_bytes);
        assert_eq!(kept[0], original[0]);
        assert_eq!(&kept[kept.len() - 16..], &original[original.len() - 16..]);
        let (disabled, audit) = window(original.clone(), 0);
        assert_eq!(disabled, original);
        assert_eq!(audit.omitted_messages, 0);
        for role in ["user", "system", "developer"] {
            let mut injected = original.clone();
            injected.insert(4, Message::text(role, "Never discard this correction"));
            assert_eq!(window(injected.clone(), 40000).0, injected);
        }
    }

    #[test]
    fn recent_large_exchange_is_retained_in_full() {
        let history = vec![
            Message::text("user", "contract"),
            Message::text("assistant", "edit".repeat(50000)),
        ];
        assert_eq!(window(history.clone(), 4000).0, history);
    }
}
