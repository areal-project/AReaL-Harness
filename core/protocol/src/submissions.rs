//! 提交回执的绑定规则。Core 与 Host 共用；缺少原回执从不意味着未受理。
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpectedSubmission {
    pub method: String,
    pub params: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub strict: bool,
}
impl ExpectedSubmission {
    pub fn operation(&self) -> Value {
        self.operation.clone().unwrap_or_else(|| {
            let target = if creation(&self.method).is_some() {
                json!({"kind":"project"})
            } else if let Some(task) = self.params.get("taskId").filter(|id| id.is_string()) {
                json!({"kind":"task","taskId":task})
            } else if let Some(thread) = self.params.get("threadId").filter(|id| id.is_string()) {
                json!({"kind":"thread","threadId":thread})
            } else {
                json!({"kind":"project"})
            };
            json!({"method":self.method,"requestId":self.params["requestId"],"target":target})
        })
    }
}
fn creation(method: &str) -> Option<&'static str> {
    match method {
        "areal/thread/start" | "areal/thread/fork" | "areal/side/start" | "areal/side/create" => {
            Some("thread")
        }
        "areal/task/create" => Some("task"),
        _ => None,
    }
}
fn receipt_method(method: &str) -> &str {
    if matches!(
        method,
        "areal/process/write"
            | "areal/process/closeStdin"
            | "areal/process/resize"
            | "areal/process/terminate"
    ) {
        "areal/process/control"
    } else {
        method
    }
}
fn matches(expected: &ExpectedSubmission, receipt: &Value, scoped: Option<&str>) -> bool {
    let operation = expected.operation();
    let actual = receipt.get("operation");
    if actual
        .and_then(|value| value.get("requestId"))
        .unwrap_or(&receipt["requestId"])
        != &operation["requestId"]
        || actual
            .and_then(|value| value.get("method"))
            .unwrap_or(&receipt["method"])
            != receipt_method(&expected.method)
        || expected
            .digest
            .as_ref()
            .is_some_and(|digest| receipt["digest"] != *digest)
        || expected
            .identity
            .as_ref()
            .is_some_and(|identity| receipt["identity"] != *identity)
        || (expected.strict && actual.is_none())
    {
        return false;
    }
    if expected.strict
        && (receipt["requestId"] != operation["requestId"]
            || receipt["method"] != receipt_method(&expected.method))
    {
        return false;
    }
    if let Some(created) = creation(&expected.method) {
        let id = if created == "task" {
            receipt
                .get("taskId")
                .or_else(|| receipt["result"].get("id"))
        } else {
            receipt
                .get("threadId")
                .or_else(|| receipt["result"].get("threadId"))
                .or_else(|| receipt["result"]["thread"].get("id"))
        };
        return id.is_some_and(|id| {
            id.is_string()
                && actual.is_none_or(|actual| {
                    actual["target"]["kind"] == created
                        && actual["target"][if created == "task" {
                            "taskId"
                        } else {
                            "threadId"
                        }] == *id
                })
        });
    }
    if let Some(actual) = actual {
        if actual["target"] != operation["target"] {
            return false;
        }
        if expected.strict {
            match operation["target"]["kind"].as_str() {
                Some("thread") => return receipt["threadId"] == operation["target"]["threadId"],
                Some("task") => return receipt["taskId"] == operation["target"]["taskId"],
                _ => {}
            }
        }
        return true;
    }
    match operation["target"]["kind"].as_str() {
        Some("thread") => {
            receipt["threadId"].as_str().or(scoped) == operation["target"]["threadId"].as_str()
        }
        Some("task") => receipt["taskId"] == operation["target"]["taskId"],
        Some("project") => {
            receipt.get("threadId").is_none_or(Value::is_null)
                && receipt.get("taskId").is_none_or(Value::is_null)
        }
        _ => false,
    }
}

/// 只返回唯一且属于原方法、主体、目标与摘要的回执；歧义继续保持 UNKNOWN。
pub fn reconcile(
    expected: &ExpectedSubmission,
    result: &Value,
    coverage: &Value,
    scoped: Option<&str>,
) -> Option<Value> {
    let rows = result["data"].as_array()?;
    let mut candidates = rows
        .iter()
        .filter(|receipt| matches(expected, receipt, scoped));
    if let Some(receipt) = candidates.next() {
        if candidates.next().is_some() {
            return None;
        }
        let mut receipt = receipt.clone();
        receipt["accepted"] = json!(true);
        return Some(receipt);
    }
    let original = &expected.params["creationAdmission"];
    let proof = &result["creationAdmission"];
    if expected.method == "areal/thread/start"
        && original.is_object()
        && proof["status"] == "notAdmitted"
        && coverage["identity"].is_string()
        && coverage["identity"] == original["identity"]
        && proof["identity"] == original["identity"]
        && coverage["journalEpoch"] == original["journalEpoch"]
        && coverage["coreInstanceId"] != original["coreInstanceId"]
        && proof["requestId"] == expected.params["requestId"]
        && proof["journalEpoch"] == original["journalEpoch"]
        && proof["coreInstanceId"] == original["coreInstanceId"]
        && rows.is_empty()
    {
        return Some(
            json!({"method":expected.method,"requestId":expected.params["requestId"],"status":"failed","accepted":false,
            "operation":expected.operation(),"error":{"message":"原创建请求未受理，可重新提交。","data":{"reason":"NOT_ADMITTED"}}}),
        );
    }
    None
}

pub fn remote_control(entry: &Value) -> bool {
    let params = &entry["params"];
    let remote = &entry["remote"];
    let target = &remote["target"];
    if !entry["operationId"].is_string() {
        return false;
    }
    match entry["method"].as_str() {
        Some("turn/interrupt") => {
            remote["method"] == "turn.stop"
                && remote["capability"] == "interrupt"
                && params["threadId"].is_string()
                && params["turnId"].is_string()
                && target["threadId"] == params["threadId"]
                && target["expectedTurnId"] == params["turnId"]
        }
        Some("areal/interaction/respond") => {
            remote["method"] == "interaction.respond"
                && remote["capability"] == "answer"
                && ["threadId", "turnId", "requestId"]
                    .iter()
                    .all(|key| params[key].is_string())
                && target["threadId"] == params["threadId"]
                && target["turnId"] == params["turnId"]
                && target["interactionId"] == params["requestId"]
        }
        Some("areal/channel/reply") => {
            remote["method"] == "task.question.reply"
                && remote["capability"] == "answer"
                && params["requestId"] == entry["operationId"]
                && ["taskId", "runId", "questionId"]
                    .iter()
                    .all(|key| params[key].is_string() && target[key] == params[key])
        }
        Some("areal/task/pause") => {
            remote["method"] == "task.pause"
                && remote["capability"] == "pauseTask"
                && params["requestId"] == entry["operationId"]
                && ["taskId", "expectedRunId"]
                    .iter()
                    .all(|key| params[key].is_string() && target[key] == params[key])
                && params["expectedRevision"].as_i64().is_some_and(|revision| {
                    (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&revision)
                })
                && target["expectedRevision"] == params["expectedRevision"]
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn expected() -> ExpectedSubmission {
        serde_json::from_value(json!({"method":"areal/turn/start","params":{"requestId":"r","threadId":"t"},"digest":"digest","identity":"owner"})).unwrap()
    }
    fn receipt() -> Value {
        json!({"requestId":"r","method":"areal/turn/start","threadId":"t","digest":"digest","identity":"owner","status":"completed","operation":{"requestId":"r","method":"areal/turn/start","target":{"kind":"thread","threadId":"t"}},"result":{"turn":{"id":"turn"}}})
    }
    #[test]
    fn matches_only_original_method_identity_digest_and_target() {
        let expected = expected();
        let original = receipt();
        assert_eq!(
            reconcile(
                &expected,
                &json!({"data":[original]}),
                &Value::Null,
                Some("t")
            )
            .unwrap()["accepted"],
            true
        );
        for (field, value) in [
            ("identity", json!("another")),
            ("digest", json!("another")),
            (
                "operation",
                json!({"requestId":"r","method":"areal/turn/start","target":{"kind":"thread","threadId":"another"}}),
            ),
        ] {
            let mut altered = receipt();
            altered[field] = value;
            assert!(
                reconcile(
                    &expected,
                    &json!({"data":[altered]}),
                    &Value::Null,
                    Some("t")
                )
                .is_none()
            );
        }
    }
    #[test]
    fn missing_or_ambiguous_receipts_remain_unknown() {
        assert!(reconcile(&expected(), &json!({"data":[]}), &Value::Null, None).is_none());
        assert!(
            reconcile(
                &expected(),
                &json!({"data":[receipt(),receipt()]}),
                &Value::Null,
                None
            )
            .is_none()
        );
    }
    #[test]
    fn negative_creation_proof_requires_original_identity_epoch_and_instance() {
        let expected:ExpectedSubmission=serde_json::from_value(json!({"method":"areal/thread/start","params":{"requestId":"r","creationAdmission":{"identity":"owner","journalEpoch":"epoch","coreInstanceId":"old"}}})).unwrap();
        let coverage = json!({"identity":"owner","journalEpoch":"epoch","coreInstanceId":"new"});
        let mut proof = json!({"data":[],"creationAdmission":{"status":"notAdmitted","requestId":"r","identity":"owner","journalEpoch":"epoch","coreInstanceId":"old"}});
        assert_eq!(
            reconcile(&expected, &proof, &coverage, None).unwrap()["accepted"],
            false
        );
        proof["creationAdmission"]["coreInstanceId"] = json!("new");
        assert!(reconcile(&expected, &proof, &coverage, None).is_none());
    }
}
