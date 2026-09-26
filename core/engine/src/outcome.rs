//! 保留原始错误类型，只在 Turn 的协议边界生成稳定的终止原因。
use areal_protocol::{TurnError, TurnOutcome};
use serde_json::{Value, json};

pub(crate) fn outcome(code: &str, class: &str, source: &str, details: Value) -> TurnOutcome {
    TurnOutcome {
        code: code.into(),
        class: class.into(),
        source: source.into(),
        details: Some(details),
    }
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub(crate) struct TerminalFailure {
    message: String,
    outcome: TurnOutcome,
}
impl TerminalFailure {
    pub(crate) fn new(message: impl Into<String>, outcome: TurnOutcome) -> Self {
        Self {
            message: message.into(),
            outcome,
        }
    }
}

pub(crate) fn model_round_limit(
    rounds: usize,
    limit: usize,
    final_handoff: bool,
) -> TerminalFailure {
    TerminalFailure::new(
        if final_handoff {
            "MAX_MODEL_ROUNDS: final handoff cannot execute tools"
        } else {
            "MAX_MODEL_ROUNDS"
        },
        outcome(
            "AGENT_MAX_TURNS_EXCEEDED",
            "agent",
            "core_model_round_budget",
            json!({
                "modelRounds": rounds, "maxModelRounds": limit,
                "reason": if final_handoff { "final_handoff_requested_tools" } else { "model_round_limit" }
            }),
        ),
    )
}

pub(crate) fn turn_error(error: &anyhow::Error) -> TurnError {
    let classified = error
        .downcast_ref::<TerminalFailure>()
        .map(|e| e.outcome.clone())
        .or_else(|| crate::model::terminal_outcome(error))
        .unwrap_or_else(|| {
            outcome(
                "HARNESS_INTERNAL_ERROR",
                "infrastructure",
                "core",
                json!({"reason":"unclassified"}),
            )
        });
    TurnError {
        message: error.to_string(),
        outcome: Some(classified),
    }
}

pub(crate) fn infrastructure(message: impl Into<String>, source: &str, reason: &str) -> TurnError {
    TurnError {
        message: message.into(),
        outcome: Some(outcome(
            "HARNESS_INTERNAL_ERROR",
            "infrastructure",
            source,
            json!({"reason":reason}),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wrapped_error_preserves_origin_and_unknown_text_is_not_classified() {
        let original = outcome(
            "AGENT_RUN_TIMEOUT",
            "agent",
            "core_turn_deadline",
            json!({}),
        );
        let error =
            anyhow::Error::new(TerminalFailure::new("deadline", original.clone())).context("outer");
        assert_eq!(turn_error(&error).outcome.unwrap(), original);
        let error = anyhow::anyhow!("context_length_exceeded HTTP 413 length timeout");
        assert_eq!(
            turn_error(&error).outcome.unwrap().code,
            "HARNESS_INTERNAL_ERROR"
        );
    }
}
