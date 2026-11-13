use super::*;

fn report() -> Value {
    json!({"executionId":"execution-fixture","status":"completed","settled":true,
        "resourcesReleased":true,"error":null,"delivery":{"status":"applied","head":"head-one"},
        "text":"Verified delivery","artifact":{"head":"head-one"},"timedOut":false})
}
fn message(value: &Value) -> model::Message {
    {
        let mut message = model::Message::text("tool", value.to_string());
        message.tool_call_id = Some("receipt-call".into());
        message
    }
}
fn observed(messages: &[model::Message], reports: &[Value]) -> bool {
    super::execution_receipts_observed(
        messages,
        reports,
        &HashSet::from(["receipt-call".to_owned()]),
    )
}
#[test]
fn delivered_receipts_can_be_observed_individually_or_in_wait_any() {
    let expected = report();
    let mut received = expected.clone();
    received.as_object_mut().unwrap().remove("timedOut");
    received["remainingToolCalls"] = json!(12);
    assert!(observed(
        &[message(&received)],
        std::slice::from_ref(&expected)
    ));
    assert!(observed(
        &[message(
            &json!({"completed":[received],"pending":[],"timedOut":false})
        )],
        &[expected]
    ));
}
#[test]
fn new_changed_failed_or_unreleased_evidence_still_requires_the_model() {
    let old = report();
    for change in [
        json!({"text":"A new verification result"}),
        json!({"status":"failed"}),
        json!({"error":"cleanup failed"}),
        json!({"resourcesReleased":false}),
        json!({"settled":false}),
        json!({"artifact":{"head":"head-two"}}),
        json!({"delivery":{"status":"awaitingDelivery"}}),
        json!({"executionId":"another-execution"}),
    ] {
        let mut changed = old.clone();
        changed
            .as_object_mut()
            .unwrap()
            .extend(change.as_object().unwrap().clone());
        assert!(!observed(&[message(&old)], &[changed]));
    }
    let mut timed_out = old.clone();
    timed_out["timedOut"] = json!(true);
    assert!(!observed(
        &[message(&timed_out)],
        std::slice::from_ref(&old)
    ));
    assert!(!observed(
        &[model::Message::text("user", old.to_string())],
        std::slice::from_ref(&old)
    ));
    assert!(!observed(
        &[message(&old)],
        &[old.clone(), json!({"executionId":"unseen"})]
    ));
}

#[test]
fn known_cancelled_and_failed_receipts_are_consumed_without_hiding_new_versions() {
    for (status, delivery) in [
        ("cancelled", "cancelled"),
        ("failed", "notRequired"),
        ("failed", "partial"),
    ] {
        let mut known = report();
        known["status"] = json!(status);
        known["delivery"]["status"] = json!(delivery);
        known["error"] = json!("reported failure or cancellation");
        assert!(observed(&[message(&known)], std::slice::from_ref(&known)));
        let mut changed = known.clone();
        changed["error"] = json!("a new failure");
        assert!(!observed(&[message(&known)], &[changed]));
    }
}

#[test]
fn unknown_unreleased_or_unread_pages_and_untrusted_tools_never_acknowledge_receipts() {
    for change in [
        json!({"status":"unknown"}),
        json!({"resourcesReleased":false}),
        json!({"delivery":{"status":"unknown"}}),
        json!({"delivery":{"status":"pending"}}),
        json!({"nextOffset":8192}),
        json!({"offset":8192}),
    ] {
        let mut value = report();
        value
            .as_object_mut()
            .unwrap()
            .extend(change.as_object().unwrap().clone());
        assert!(!observed(&[message(&value)], &[value]));
    }
    let value = report();
    let mut untrusted = message(&value);
    untrusted.tool_call_id = Some("external-tool".into());
    assert!(!observed(&[untrusted], &[value]));
}

#[test]
fn only_a_complete_contiguous_same_version_handoff_can_be_consumed() {
    let text = "交接".repeat(2000);
    let mut first = report();
    first["sourceItemId"] = json!("immutable-report");
    first["textBytes"] = json!(text.len());
    first["text"] = json!(&text[..8190]);
    first["offset"] = json!(0);
    first["nextOffset"] = json!(8190);
    let mut last = first.clone();
    last["text"] = json!(&text[8190..]);
    last["offset"] = json!(8190);
    last["nextOffset"] = Value::Null;
    assert!(!observed(&[message(&first)], std::slice::from_ref(&first)));
    assert!(observed(
        &[message(&first), message(&last)],
        std::slice::from_ref(&first)
    ));
    for change in [
        json!({"sourceItemId":"another-version"}),
        json!({"offset":8191}),
        json!({"delivery":{"status":"partial"}}),
    ] {
        let mut stale = last.clone();
        stale
            .as_object_mut()
            .unwrap()
            .extend(change.as_object().unwrap().clone());
        assert!(!observed(
            &[message(&first), message(&stale)],
            std::slice::from_ref(&first)
        ));
    }
}
