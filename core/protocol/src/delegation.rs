//! 统一委派只记录身份与后端引用，执行状态仍由原执行器持有。
use crate::{
    Input,
    desktop::{ModelRef, VersionRef},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ExecutionRef {
    Thread {
        thread_id: String,
        turn_id: String,
    },
    Workgroup {
        workgroup_id: String,
        #[serde(default)]
        automatic: bool,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ExecutionOwner {
    Turn {
        thread_id: String,
        turn_id: String,
    },
    TaskRun {
        task_id: String,
        run_id: String,
        thread_id: String,
        goal_id: String,
    },
}

#[derive(
    Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum Intent {
    #[default]
    Inspect,
    Modify,
}

#[derive(
    Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum Delivery {
    #[default]
    Report,
    Changes,
    Patch,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DelegationRequest {
    pub request_id: String,
    pub parent_thread_id: String,
    pub input: Vec<Input>,
    #[serde(default)]
    pub intent: Intent,
    #[serde(default)]
    pub delivery: Delivery,
    #[serde(default)]
    pub writes: Vec<String>,
    #[serde(default)]
    pub independent: bool,
    #[serde(default)]
    pub requires_current_environment: bool,
    #[serde(default)]
    pub require_trusted_checks: bool,
    pub max_model_rounds: Option<usize>,
    pub agent_profile: Option<VersionRef>,
    pub instructions: Option<String>,
    pub skills: Option<Vec<VersionRef>>,
    pub model: Option<ModelRef>,
    pub tool_allowlist: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionRecord {
    pub execution_id: String,
    pub request_id: String,
    pub request_hash: String,
    pub owner: ExecutionOwner,
    pub title: String,
    pub delivery: Delivery,
    pub strategy: String,
    pub reason: String,
    /// 创建前先记录意图；没有后端引用的旧意图不得自动重派。
    pub execution: Option<ExecutionRef>,
    pub error: Option<String>,
    /// 取消是持久、单向的交付门禁；执行器终态不能抹掉尚未交付候选的取消。
    #[serde(default)]
    pub cancel_requested: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChildExecutionPolicy {
    #[serde(default)]
    pub exclusive_write: bool,
}
