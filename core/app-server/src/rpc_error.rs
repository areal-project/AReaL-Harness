use super::*;

pub(super) fn rejected(mut error: RpcError, reason: &str) -> RpcError {
    let mut data = match error.data.take() {
        Some(Value::Object(data)) => data,
        _ => serde_json::Map::new(),
    };
    data.entry("reason").or_insert_with(|| json!(reason));
    data.insert(
        "outcome".into(),
        json!(areal_protocol::desktop::FailureOutcome::Rejected),
    );
    data.insert(
        "recovery".into(),
        json!(areal_protocol::desktop::Recovery::None),
    );
    error.data = Some(Value::Object(data));
    error
}

pub(super) fn map_error(error: Error) -> RpcError {
    if let Error::Rejected(error) = error {
        return rejected(map_error(*error), "REQUEST_REJECTED");
    }
    if let Error::HistoryRead {
        reason,
        thread_id,
        restart_cursor,
    } = &error
    {
        return RpcError {
            code: -32012,
            message: "History view requires a fresh bounded read".into(),
            data: Some(
                json!({"reason":reason,"threadId":thread_id,"view":"own","reset":*reason == "HISTORY_CURSOR_STALE","restartCursor":restart_cursor,"retryable":false,"outcome":{"kind":"noMutation"},"recovery":{"kind":"none"}}),
            ),
        };
    }
    if let Error::OperationOutcome(failure) = &error {
        return RpcError {
            code: -32011,
            message: "Operation outcome requires reconciliation".into(),
            data: Some(json!(failure)),
        };
    }
    if let Error::Invalid(reason) = &error
        && let Some(code) = [
            "CREDENTIAL_UNAVAILABLE",
            "MODEL_CREDENTIAL_UNAVAILABLE",
            "UNSUPPORTED_PROFILE",
        ]
        .into_iter()
        .find(|code| reason == code || reason.starts_with(&format!("{code}:")))
    {
        return rejected(RpcError::invalid(error.to_string()), code);
    }
    if matches!(&error,Error::Invalid(reason) if reason=="TASK_PERMISSION_DENIED") {
        return RpcError {
            code: -32003,
            message: "task permission denied".into(),
            data: Some(
                json!({"reason":"PERMISSION_DENIED","outcome":{"kind":"rejected"},"recovery":{"kind":"none"}}),
            ),
        };
    }
    if matches!(&error, Error::Invalid(reason) if reason == "SIDE_POLICY_VIOLATION") {
        return RpcError {
            code: -32010,
            message: "SIDE_POLICY_VIOLATION".into(),
            data: Some(
                json!({"reason":"SIDE_POLICY_VIOLATION","retryable":false,"outcome":{"kind":"rejected"},"recovery":{"kind":"none"}}),
            ),
        };
    }
    let data = match &error {
        Error::ToolHostUnavailable => Some(json!({"reason":"TOOL_HOST_UNAVAILABLE"})),
        Error::Exhausted(reason) if reason == "input exceeds 1 MiB" => {
            Some(json!({"reason":"INPUT_LIMIT_EXCEEDED","retryable":false}))
        }
        Error::Exhausted(reason)
            if reason.starts_with("task hot-state capacity")
                || reason.starts_with("task preparation capacity") =>
        {
            Some(
                json!({"reason":"taskHotStateCapacity","resource":"taskHotState","recovery":"settleOrCancelExistingWork","retryable":false}),
            )
        }
        Error::Storage(reason) if reason.contains("Task persistence requires restart") => Some(
            json!({"reason":"taskStorageRecoveryRequired","resource":"taskStorage","recovery":"restartCore","retryable":false}),
        ),
        _ => None,
    };
    let code = match &error {
        Error::Invalid(_) | Error::ToolHostUnavailable => -32602,
        Error::NotFound => -32004,
        Error::Conflict => -32009,
        Error::Exhausted(_) => -32001,
        Error::Closed => -32000,
        Error::Storage(_)
        | Error::OperationOutcome(_)
        | Error::Rejected(_)
        | Error::HistoryRead { .. } => -32603,
    };
    RpcError {
        code,
        message: error.to_string(),
        data,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejected_oversized_input_has_a_distinct_reason() {
        let error = map_error(Error::Rejected(Box::new(Error::Exhausted(
            "input exceeds 1 MiB".into(),
        ))));
        assert_eq!(error.code, -32001);
        assert_eq!(
            error.data.as_ref().unwrap()["reason"],
            "INPUT_LIMIT_EXCEEDED"
        );
        assert_eq!(error.data.as_ref().unwrap()["outcome"]["kind"], "rejected");
    }
}
