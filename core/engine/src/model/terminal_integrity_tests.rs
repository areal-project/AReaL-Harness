use super::*;

fn function(status: Option<Value>, arguments: &str) -> Value {
    let mut item = json!({"type":"function_call","id":"item-terminal",
        "call_id":"call-terminal","name":"fs_write","arguments":arguments});
    if let Some(status) = status {
        item["status"] = status;
    }
    item
}

fn decode(
    prefix: Vec<Value>,
    output: Vec<Value>,
    with_usage: bool,
    max_calls: usize,
    chunk: usize,
) -> (Vec<ModelEvent>, Result<()>) {
    let mut response = json!({"status":"completed","output":output});
    if with_usage {
        response["usage"] = json!({"input_tokens":19,"output_tokens":7});
    }
    let wire = prefix
        .into_iter()
        .chain([json!({"type":"response.completed","response":response})])
        .map(|event| format!("data: {event}\n\n"))
        .collect::<String>();
    let mut decoder = Decoder::Responses(ResponsesDecoder::new(ToolCallLimits {
        max_calls,
        ..ToolCallLimits::default()
    }));
    let mut events = Vec::new();
    for bytes in wire.as_bytes().chunks(chunk.min(wire.len())) {
        match decoder.feed(bytes) {
            Ok(part) => events.extend(part),
            Err(error) => return (events, Err(error)),
        }
    }
    match decoder.finish() {
        Ok(part) => {
            events.extend(part);
            (events, Ok(()))
        }
        Err(error) => (events, Err(error)),
    }
}

#[test]
fn terminal_validation_errors_keep_only_observed_final_usage() {
    for chunk in [1, 17, usize::MAX] {
        for with_usage in [false, true] {
            for case in 0..4 {
                let complete = function(Some(json!("completed")), "{}");
                let (prefix, output, max_calls) = match case {
                    0 => (vec![], vec![complete.clone()], 0),
                    1 => (
                        vec![json!({"type":"response.output_item.done","item":complete})],
                        vec![function(Some(json!("completed")), "{\"other\":true}")],
                        8,
                    ),
                    2 => (
                        vec![],
                        vec![json!({"type":"function_call","name":"fs_write","arguments":"{}"})],
                        8,
                    ),
                    _ => (
                        vec![json!({"type":"response.reasoning_summary_text.delta",
                            "item_id":"reasoning-terminal","summary_index":0,"delta":"original"})],
                        vec![json!({"type":"reasoning","id":"reasoning-terminal",
                            "summary":[{"type":"summary_text","text":"conflicting"}]})],
                        8,
                    ),
                };
                let (events, result) = decode(prefix, output, with_usage, max_calls, chunk);
                let error = result.unwrap_err();
                assert_eq!(
                    error.is::<FinalUsageError>(),
                    with_usage,
                    "case={case}, chunk={chunk}, error={error:#}"
                );
                assert_eq!(
                    events
                        .iter()
                        .filter(|e| matches!(e, ModelEvent::Usage(_)))
                        .count(),
                    usize::from(with_usage)
                );
                assert!(!events.iter().any(|e| matches!(e, ModelEvent::ToolCall(_))));
            }
        }
    }
}

#[test]
fn explicit_unfinished_function_items_never_become_calls() {
    for status in [
        json!("incomplete"),
        json!("in_progress"),
        json!("failed"),
        json!(false),
    ] {
        for with_usage in [false, true] {
            for chunk in [1, 17, usize::MAX] {
                let (events, result) = decode(
                    vec![],
                    vec![function(Some(status.clone()), "{}")],
                    with_usage,
                    8,
                    chunk,
                );
                let error = result.expect_err("An unfinished item cannot authorize a tool");
                assert_eq!(error.is::<FinalUsageError>(), with_usage);
                assert!(!events.iter().any(|e| matches!(e, ModelEvent::ToolCall(_))));
            }
        }
    }
}

#[test]
fn final_function_metadata_can_confirm_a_previously_unfinished_item() {
    let item = function(Some(json!("incomplete")), "{}");
    let (events, result) = decode(
        vec![json!({"type":"response.output_item.done","item":item})],
        vec![function(Some(json!("completed")), "{}")],
        true,
        8,
        1,
    );
    result.unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e, ModelEvent::ToolCall(_)))
            .count(),
        1
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, ModelEvent::ProviderContext(item)
        if item["items"][0]["type"] == "function_call" && item["items"][0]["status"] == "completed"))
    );
}

#[test]
fn final_unfinished_status_cannot_be_overridden_by_an_earlier_completed_item() {
    let item = function(Some(json!("completed")), "{}");
    let (events, result) = decode(
        vec![json!({"type":"response.output_item.done","item":item})],
        vec![function(Some(json!("incomplete")), "{}")],
        true,
        8,
        17,
    );
    assert!(result.unwrap_err().is::<FinalUsageError>());
    assert!(!events.iter().any(|e| matches!(e, ModelEvent::ToolCall(_))));
}

#[test]
fn legacy_function_items_with_no_status_remain_compatible() {
    for status in [None, Some(Value::Null), Some(json!("completed"))] {
        let (events, result) = decode(vec![], vec![function(status, "{}")], true, 8, 1);
        result.unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, ModelEvent::ToolCall(_)))
                .count(),
            1
        );
    }
}

fn message(id: &str, phase: Option<&str>, text: &str) -> Value {
    let mut item = json!({"type":"message","id":id,"role":"assistant","status":"completed",
        "content":[{"type":"output_text","text":text,"annotations":[]}]});
    if let Some(phase) = phase {
        item["phase"] = json!(phase);
    }
    item
}

#[test]
fn responses_output_preserves_phase_order_and_raw_fields_across_packet_boundaries() {
    let reasoning =
        json!({"type":"reasoning","id":"r-fidelity","summary":[],"encrypted_content":"opaque"});
    let preamble = message("m-one", Some("commentary"), "Inspect now. ");
    let answer = message("m-two", Some("final_answer"), "Done.");
    let call = function(Some(json!("completed")), "{ \"path\": \"x\" }");
    for chunk in [1, 17, usize::MAX] {
        // done 到达顺序刻意不同；终态完整数组才是原始语义顺序。
        let (events, result) = decode(
            vec![
                json!({"type":"response.output_text.delta","delta":"Inspect now. "}),
                json!({"type":"response.output_item.done","item":preamble}),
                json!({"type":"response.output_item.done","item":call}),
                json!({"type":"response.output_item.done","item":reasoning}),
            ],
            vec![
                reasoning.clone(),
                preamble.clone(),
                call.clone(),
                answer.clone(),
            ],
            true,
            8,
            chunk,
        );
        result.unwrap();
        let contexts: Vec<_> = events
            .iter()
            .filter_map(|event| match event {
                ModelEvent::ProviderContext(v) => Some(v),
                _ => None,
            })
            .collect();
        assert_eq!(contexts.len(), 1);
        assert_eq!(
            contexts[0]["items"],
            json!([reasoning, preamble, call, answer])
        );
        let text: String = events
            .iter()
            .filter_map(|event| match event {
                ModelEvent::TextDelta(s) => Some(s.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "Inspect now. Done.");
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, ModelEvent::ToolCall(_)))
                .count(),
            1
        );
    }
}

#[test]
fn conflicting_completed_message_never_releases_tools_and_keeps_observed_usage() {
    for chunk in [1, 17, usize::MAX] {
        for phase_conflict in [false, true] {
            let prefix = if phase_conflict {
                json!({"type":"response.output_item.done","item":message("m",Some("commentary"),"same")})
            } else {
                json!({"type":"response.output_text.delta","delta":"different"})
            };
            let (events, result) = decode(
                vec![prefix],
                vec![
                    message("m", Some("final_answer"), "same"),
                    function(None, "{}"),
                ],
                true,
                8,
                chunk,
            );
            assert!(result.unwrap_err().is::<FinalUsageError>());
            assert!(events.iter().any(|e| matches!(e, ModelEvent::Usage(_))));
            assert!(
                !events
                    .iter()
                    .any(|e| matches!(e, ModelEvent::ToolCall(_) | ModelEvent::ProviderContext(_)))
            );
        }
    }
}

#[test]
fn message_without_phase_is_not_relabelled_and_terminal_only_text_is_visible() {
    let raw = message("legacy", None, "complete without delta");
    let (events, result) = decode(vec![], vec![raw.clone()], false, 8, 1);
    result.unwrap();
    assert!(
        events
            .iter()
            .any(|e| matches!(e,ModelEvent::TextDelta(s) if s=="complete without delta"))
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e,ModelEvent::ProviderContext(v) if v["items"]==json!([raw])))
    );
}

#[tokio::test]
async fn canonical_output_wire_preserves_phase_and_hook_arguments_without_duplicates() {
    let reasoning = json!({"type":"reasoning","id":"rs","summary":[],"encrypted_content":"opaque"});
    let preamble = message("msg", Some("commentary"), "Inspect");
    let call = function(Some(json!("completed")), "{ \"path\": \"x\" }");
    for rewritten in [false, true] {
        let mut m = Message::text("assistant", "Inspect");
        m.provider_context = Some(
            json!({"type":"areal_response_output","visibleMessageId":"local-only","items":[reasoning,preamble,call]}),
        );
        let mut projected = json!({"id":"call-terminal","type":"function","function":{"name":"fs_write","arguments":if rewritten {"{\"path\":\"y\"}"} else {"{ \"path\": \"x\" }"}}});
        if !rewritten {
            projected["_responsesItem"] = call.clone();
        }
        m.tool_calls.push(projected);
        let expected_call = if rewritten {
            json!({"type":"function_call","call_id":"call-terminal","name":"fs_write","arguments":"{\"path\":\"y\"}"})
        } else {
            call.clone()
        };
        let output = m.responses_output().unwrap();
        assert_eq!(
            output,
            json!([reasoning, preamble, expected_call])
                .as_array()
                .unwrap()
                .clone()
        );
        assert_eq!(
            crate::context::message_bytes(&[m.clone()]),
            output.iter().map(|x| x.to_string().len()).sum::<usize>() + 64
        );
        let responses = HttpModel::with_protocol(
            "http://127.0.0.1:1/".into(),
            "fixture".into(),
            None,
            ModelProtocol::Responses,
        )
        .unwrap()
        .request_body(vec![m.clone()])
        .await
        .unwrap();
        assert_eq!(responses["input"], json!(output));
        assert!(!responses.to_string().contains("local-only"));
        let chat = HttpModel::with_protocol(
            "http://127.0.0.1:1/".into(),
            "fixture".into(),
            None,
            ModelProtocol::ChatCompletions,
        )
        .unwrap()
        .request_body(vec![m])
        .await
        .unwrap();
        let entries = chat["messages"].as_array().unwrap();
        let assistant = entries.iter().find(|v| v["role"] == "assistant").unwrap();
        assert_eq!(assistant["content"], "Inspect");
        assert_eq!(assistant["tool_calls"].as_array().unwrap().len(), 1);
        assert!(!chat.to_string().contains("encrypted_content"));
        assert!(!chat.to_string().contains("_responsesItem"));
    }
}

#[test]
fn canonical_context_counts_visible_bytes_once_without_changing_other_limits() {
    let context =
        json!({"type":"areal_response_output","items":[message("m",Some("commentary"),"检查🙂")]});
    let raw = serde_json::to_vec(&context).unwrap().len();
    for observed in [0, 1, "检查🙂".len(), 10000] {
        assert_eq!(
            provider_context_added_bytes(&context, observed).unwrap(),
            raw - observed.min("检查🙂".len())
        );
    }
    let opaque = json!({"type":"reasoning","encrypted_content":"opaque"});
    assert_eq!(
        provider_context_added_bytes(&opaque, 10000).unwrap(),
        serde_json::to_vec(&opaque).unwrap().len()
    );
}
