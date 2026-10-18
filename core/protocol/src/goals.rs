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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rsi: Option<RsiGoalState>,
    #[serde(default)]
    pub interaction_mode: crate::tasks::InteractionMode,
    pub id: String,
    pub thread_id: String,
    pub objective: String,
    pub status: GoalStatus,
    pub reason: Option<String>,
    pub token_budget: Option<u64>,
    pub max_turns: Option<u64>,
    pub max_active_seconds: Option<u64>,
    #[serde(default)]
    pub limits_pending: bool,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_format: Option<String>,
    #[serde(default)]
    pub infer_limits: bool,
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RsiPhase {
    Running,
    AwaitingSelection,
    Selected,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RsiCandidateStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Selected,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RsiCandidate {
    #[serde(default)]
    pub parent_candidate_id: Option<String>,
    #[serde(default)]
    pub round: u32,
    #[serde(default)]
    pub hypothesis: String,
    #[serde(default)]
    pub feedback: String,
    #[serde(default)]
    pub evaluations: Vec<RsiEvaluation>,
    pub id: String,
    pub label: String,
    pub harness: String,
    pub status: RsiCandidateStatus,
    pub workspace_mode: String,
    pub workspace_path: Option<String>,
    pub artifact_path: Option<String>,
    pub artifact_summary: Option<String>,
    pub run_id: String,
    pub task_id: String,
    pub error: Option<String>,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RsiGoalState {
    #[serde(default = "rsi_markdown")]
    pub output_format: String,
    pub phase: RsiPhase,
    pub candidates: Vec<RsiCandidate>,
    pub selected_candidate_id: Option<String>,
}

fn rsi_markdown() -> String {
    "markdown".into()
}

/// 外部评测回执；Core 绑定产物哈希，不把调用方评分当成可信执行验证。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RsiEvaluation {
    pub rubric_id: String,
    pub evaluator: String,
    pub task_id: String,
    pub artifact_sha256: String,
    pub checks: std::collections::BTreeMap<String, bool>,
    pub score: Option<f64>,
    pub feedback: String,
    pub evidence: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RsiVariant {
    pub label: String,
    pub hypothesis: String,
    pub harness: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalEvolve {
    #[serde(default)]
    pub token_budget: Option<u64>,
    #[serde(flatten)]
    pub control: GoalControl,
    pub parent_candidate_id: String,
    pub feedback: String,
    pub variants: Vec<RsiVariant>,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalEvaluateCandidate {
    #[serde(flatten)]
    pub control: GoalControl,
    pub candidate_id: String,
    pub evaluation: RsiEvaluation,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalSelectCandidate {
    pub request_id: String,
    pub thread_id: String,
    pub goal_id: String,
    pub expected_revision: u64,
    pub candidate_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalCandidateArtifact {
    pub thread_id: String,
    pub goal_id: String,
    pub candidate_id: String,
    #[serde(default)]
    pub offset: usize,
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
    #[serde(default)]
    pub infer_limits: bool,
    #[serde(flatten)]
    pub control: GoalControl,
    pub objective: Option<String>,
    #[serde(
        default,
        deserialize_with = "nullable_budget",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Option<u64>")]
    pub token_budget: Option<Option<u64>>,
    #[serde(
        default,
        deserialize_with = "nullable_budget",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Option<u64>")]
    pub max_turns: Option<Option<u64>>,
    #[serde(
        default,
        deserialize_with = "nullable_budget",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Option<u64>")]
    pub max_active_seconds: Option<Option<u64>>,
}
fn nullable_budget<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Option<u64>>, D::Error> {
    Option::<u64>::deserialize(d).map(Some)
}
