//! 目标控制与执行归因；目标终态独立于单个 Turn 的终态。
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalState {
    pub revision: u64,
    pub event_sequence: u64,
    pub goal: Option<Goal>,
}
impl GoalState {
    pub fn is_empty(&self) -> bool {
        self.revision == 0 && self.goal.is_none()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum GoalStatus {
    Active,
    Paused,
    Blocked,
    Completed,
    BudgetLimited,
    Failed,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalUsage {
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    pub tokens_used: u64,
    pub reserved_tokens: u64,
    pub unknown_requests: u64,
    pub time_used_seconds: f64,
    pub turns_started: u64,
    pub accounting_complete: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalReport {
    pub expected_revision: u64,
    pub status: GoalReportStatus,
    pub summary: String,
    pub evidence: Vec<String>,
    pub remaining: Vec<String>,
    pub blocker: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum GoalReportStatus {
    Continue,
    Complete,
    Blocked,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Goal {
    #[serde(default)]
    pub interaction_mode: crate::tasks::InteractionMode,
    pub id: String,
    pub thread_id: String,
    pub objective: String,
    pub status: GoalStatus,
    pub reason: Option<String>,
    pub token_budget: Option<u64>,
    pub max_turns: u64,
    pub max_active_seconds: u64,
    pub usage: GoalUsage,
    pub active_turn_id: Option<String>,
    pub settling: bool,
    pub waiting_for_input: bool,
    #[serde(default)]
    pub waiting_for_agents: bool,
    pub waiting_for_capacity: bool,
    pub report: Option<GoalReport>,
    pub report_turn_id: Option<String>,
    pub unreported_turns: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalOwner {
    pub thread_id: String,
    pub goal_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalTurn {
    pub goal_id: String,
    pub sequence: u64,
    pub origin: String,
    pub predecessor_turn_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalCreate {
    #[serde(default)]
    pub interaction_mode: Option<crate::tasks::InteractionMode>,
    pub request_id: String,
    pub thread_id: String,
    pub expected_revision: u64,
    pub objective: String,
    pub token_budget: Option<u64>,
    pub max_turns: Option<u64>,
    pub max_active_seconds: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalControl {
    pub request_id: String,
    pub thread_id: String,
    pub expected_revision: u64,
    pub goal_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalUpdate {
    #[serde(flatten)]
    pub control: GoalControl,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub reopen_completed: bool,
    pub objective: Option<String>,
    #[serde(
        default,
        deserialize_with = "nullable_budget",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Option<u64>")]
    pub token_budget: Option<Option<u64>>,
    pub max_turns: Option<u64>,
    pub max_active_seconds: Option<u64>,
}
fn nullable_budget<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Option<u64>>, D::Error> {
    Option::<u64>::deserialize(d).map(Some)
}
