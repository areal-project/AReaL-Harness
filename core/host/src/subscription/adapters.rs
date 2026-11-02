use serde_json::{Map, Value, json};

pub(super) fn hints(model: &Value) -> Value {
    let mut hints = Map::new();
    if model["use_responses_lite"] == true {
        hints.insert("reasoningContext".into(), json!("all_turns"));
    }
    if model["support_verbosity"] == true
        && matches!(
            model["default_verbosity"].as_str(),
            Some("low" | "medium" | "high")
        )
    {
        hints.insert("verbosity".into(), model["default_verbosity"].clone());
    }
    Value::Object(hints)
}

pub(super) fn encode(body: &Value, hints: &Value) -> Result<Value, ()> {
    let model = body["model"].as_str().ok_or(())?;
    let input = body["input"].as_array().ok_or(())?;
    if body["stream"] != true {
        return Err(());
    }
    for field in [
        "background",
        "conversation",
        "metadata",
        "moderation",
        "multi_agent",
        "prompt",
        "prompt_cache_retention",
        "safety_identifier",
        "temperature",
        "top_logprobs",
        "top_p",
        "min_p",
        "top_k",
        "presence_penalty",
        "repetition_penalty",
        "truncation",
        "user",
        "previous_response_id",
        "max_tool_calls",
    ] {
        if !body[field].is_null() {
            return Err(());
        }
    }
    let mut controls = std::collections::BTreeMap::<String, Map<String, Value>>::new();
    for field in ["reasoning", "text"] {
        let value = &body[field];
        if !value.is_null() && !value.is_object() {
            return Err(());
        }
        controls.insert(field.into(), value.as_object().cloned().unwrap_or_default());
    }
    let reasoning = controls.get_mut("reasoning").unwrap();
    if !reasoning.contains_key("context") && hints["reasoningContext"] == "all_turns" {
        reasoning.insert("context".into(), json!("all_turns"));
    }
    let text = controls.get_mut("text").unwrap();
    if !text.contains_key("verbosity")
        && matches!(hints["verbosity"].as_str(), Some("low" | "medium" | "high"))
    {
        text.insert("verbosity".into(), hints["verbosity"].clone());
    }
    let mut instructions = Vec::new();
    if let Some(value) = body["instructions"].as_str().filter(|s| !s.is_empty()) {
        instructions.push(value.to_owned());
    }
    let mut output = Vec::new();
    for item in input {
        if item["role"] == "system" {
            let instruction = if let Some(value) = item["content"].as_str() {
                value.to_owned()
            } else {
                item["content"]
                    .as_array()
                    .ok_or(())?
                    .iter()
                    .map(|part| part["text"].as_str().ok_or(()))
                    .collect::<Result<Vec<_>, _>>()?
                    .join("\n")
            };
            if !instruction.is_empty() {
                instructions.push(instruction);
            }
        } else {
            let mut item = item.clone();
            if item["type"] == "function_call" {
                item["namespace"] = json!("areal");
            }
            output.push(item);
        }
    }
    let mut value = json!({"model":model,"input":output,"instructions":if instructions.is_empty() { "You are a helpful assistant.".into() } else { instructions.join("\n\n") },"stream":true,"store":false,"include":["reasoning.encrypted_content"]});
    for field in ["service_tier", "parallel_tool_calls"] {
        if let Some(field_value) = body.get(field) {
            value[field] = field_value.clone();
        }
    }
    if value["service_tier"] == "fast" {
        value["service_tier"] = json!("priority");
    }
    if let Some(tools) = body.get("tools") {
        if let Some(list) = tools.as_array().filter(|list| !list.is_empty()) {
            if list.iter().any(|tool| tool["type"] != "function") {
                return Err(());
            }
            value["tools"] = json!([{"type":"namespace","name":"areal","description":"AReaL Runtime tools","tools":list}]);
        } else if !tools.is_null() && tools != &Value::Bool(false) {
            value["tools"] = tools.clone();
        }
    }
    if let Some(choice) = body
        .get("tool_choice")
        .filter(|v| !v.is_null() && **v != Value::Bool(false))
    {
        value["tool_choice"] = choice.clone();
        if choice["type"] == "function" {
            value["tool_choice"]["namespace"] = json!("areal");
        }
    }
    for (field, control) in controls {
        if !control.is_empty()
            || body
                .get(&field)
                .is_some_and(|v| !v.is_null() && *v != Value::Bool(false))
        {
            value[field] = Value::Object(control);
        }
    }
    Ok(value)
}

#[test]
fn original_js_adapter_oracle() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("fixtures/adapters.json")).unwrap();
    for case in cases {
        let actual = encode(&case["input"], &case["hints"]);
        if case["error"] == true {
            assert!(actual.is_err(), "{}", case["input"]);
        } else {
            assert_eq!(actual.unwrap(), case["output"]);
        }
    }
}
