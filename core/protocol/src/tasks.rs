//! 持久任务、独立通信频道与客户端控制契约。
use crate::{desktop::Question, goals::GoalUsage};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum InteractionMode {
    #[default]
    Interactive,
    Asynchronous,
    Headless,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TaskMode {
    Foreground,
    Scheduled,
    Background,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    Queued,
    Running,
    WaitingForInput,
    WaitingForAgents,
    Paused,
    Blocked,
    Completed,
    Failed,
    Cancelled,
}
impl RunStatus {
    pub fn terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Schedule {
    #[serde(default, rename = "timeZone", skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    /// UTC Unix 秒；间隔以该时间为锚点，避免执行耗时导致漂移。
    pub at: i64,
    pub interval_seconds: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleDefinition<R> {
    #[schemars(range(min = 1, max = 1))]
    pub version: u8,
    pub rule: R,
    pub misfire: Misfire,
    pub overlap: Overlap,
}
fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}
pub type ScheduleV2 = ScheduleDefinition<ScheduleRule>;
pub type ScheduleIntent = ScheduleDefinition<ScheduleIntentRule>;

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Misfire {
    Coalesce,
    Skip { max_lateness_seconds: u32 },
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Overlap {
    Skip,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Frequency {
    Daily,
    Weekly,
    Monthly,
}
#[derive(
    Clone, Debug, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq, PartialOrd, Ord,
)]
#[serde(untagged)]
pub enum MonthDay {
    Day(u8),
    Last(LastDay),
}
#[derive(
    Clone, Debug, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq, PartialOrd, Ord,
)]
pub enum LastDay {
    #[serde(rename = "last")]
    Last,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ScheduleRule {
    Once {
        at: i64,
    },
    Interval {
        anchor_at: i64,
        interval_seconds: u64,
    },
    Calendar {
        time_zone: String,
        frequency: Frequency,
        interval: u16,
        local_time: String,
        anchor_date: String,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        #[schemars(with = "Vec<u8>")]
        weekdays: Option<Vec<u8>>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        #[schemars(with = "Vec<MonthDay>")]
        month_days: Option<Vec<MonthDay>>,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ScheduleIntentRule {
    Once {
        at: i64,
    },
    Interval {
        anchor_at: i64,
        interval_seconds: u64,
    },
    Calendar {
        time_zone: String,
        frequency: Frequency,
        interval: u16,
        local_time: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        anchor_date: Option<String>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        #[schemars(with = "Vec<u8>")]
        weekdays: Option<Vec<u8>>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        #[schemars(with = "Vec<MonthDay>")]
        month_days: Option<Vec<MonthDay>>,
    },
    OnceLocal {
        time_zone: String,
        local_time: String,
        date: CivilDate,
    },
    IntervalLocal {
        time_zone: String,
        local_time: String,
        date: CivilDate,
        interval_seconds: u64,
    },
    OnceIso {
        at_iso: String,
    },
    IntervalIso {
        at_iso: String,
        interval_seconds: u64,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum CivilDate {
    Date { date: String },
    Relative { days: u16 },
    Next,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SchedulePreview {
    pub schedule: ScheduleIntent,
    pub from: Option<i64>,
    #[schemars(range(min = 1, max = 10))]
    pub count: u8,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleContextInput {
    pub time_zone: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleContext {
    pub core_now: i64,
    pub time_zone: String,
    pub local_date: String,
    pub local_time: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleOccurrence {
    pub at: i64,
    pub local_time: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SchedulePreviewed {
    pub core_now: i64,
    pub from: i64,
    pub schedule: ScheduleV2,
    pub time_zone: String,
    pub occurrences: Vec<ScheduleOccurrence>,
    pub warnings: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TriggerDecision {
    pub sequence: u64,
    pub decided_at: i64,
    pub plan_revision: u64,
    pub original_scheduled_at: i64,
    pub due_through: i64,
    pub due_count: u64,
    pub next_run_at: Option<i64>,
    pub outcome: TriggerOutcome,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TriggerOutcome {
    Admitted { run_id: String },
    SkippedOverlap,
    MissedWindow,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AcceptedSchedule {
    pub task_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<Schedule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule_v2: Option<ScheduleV2>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<TriggerDecision>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskCreate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_thread_id: Option<String>,
    pub request_id: String,
    pub mode: TaskMode,
    pub objective: String,
    pub thread_id: Option<String>,
    pub interaction_mode: Option<InteractionMode>,
    pub schedule: Option<Schedule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule_v2: Option<ScheduleIntent>,
    pub token_budget: Option<u64>,
    pub max_turns: Option<u64>,
    pub max_active_seconds: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskControl {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_run_id: Option<String>,
    pub request_id: String,
    pub task_id: String,
    pub expected_revision: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskRunNow {
    pub request_id: String,
    pub task_id: String,
    pub expected_revision: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskRunNowAccepted {
    pub task_id: String,
    pub run_id: String,
    pub revision: u64,
    pub accepted: bool,
}

#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum RunTrigger {
    #[default]
    Schedule,
    Manual,
}

/// 修改后续计划；不重新绑定执行会话、不重写已受理 Run 的 Goal。
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskUpdate {
    pub request_id: String,
    pub task_id: String,
    pub expected_revision: u64,
    pub objective: Option<String>,
    pub schedule: Option<Schedule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule_v2: Option<ScheduleIntent>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelReply {
    /// 回复操作的幂等键，与原问题的 questionId 分开。
    pub request_id: String,
    pub task_id: String,
    pub run_id: String,
    pub question_id: String,
    pub answers: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskTarget {
    pub task_id: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskList {
    pub after: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelRead {
    pub task_id: String,
    pub after_sequence: Option<u64>,
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChannelMessage {
    pub id: String,
    /// 每次新增或状态变化递增；客户端按 id 替换，不重复追加。
    pub sequence: u64,
    pub run_id: String,
    pub author: String,
    pub kind: String,
    pub status: String,
    pub created_at: i64,
    pub expires_at: Option<i64>,
    pub questions: Vec<Question>,
    pub required: bool,
    pub in_reply_to: Option<String>,
    pub answers: Option<BTreeMap<String, String>>,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskRun {
    #[serde(default)]
    pub trigger: RunTrigger,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_schedule: Option<AcceptedSchedule>,
    /// 受理时的任务内容；修改安排只影响之后的 Run。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub objective: Option<String>,
    #[serde(default)]
    pub started_at: Option<i64>,
    #[serde(default)]
    pub workers: Vec<TaskWorker>,
    pub id: String,
    pub thread_id: Option<String>,
    pub goal_id: Option<String>,
    pub status: RunStatus,
    pub reason: Option<String>,
    pub scheduled_at: i64,
    pub completed_at: Option<i64>,
    pub usage: GoalUsage,
    pub wait_requested: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskWorker {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub turn_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<crate::delegation::ExecutionRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_id: Option<String>,
    pub status: String,
    pub settled: bool,
}

impl TaskWorker {
    /// 旧快照只有 Thread/Turn；新执行引用不另存后端状态。
    pub fn execution_ref(&self) -> Option<crate::delegation::ExecutionRef> {
        self.execution.clone().or_else(|| {
            (!self.thread_id.is_empty() && !self.turn_id.is_empty()).then(|| {
                crate::delegation::ExecutionRef::Thread {
                    thread_id: self.thread_id.clone(),
                    turn_id: self.turn_id.clone(),
                }
            })
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<i64>,
    #[serde(default)]
    pub run_count: u64,
    #[serde(default)]
    pub archived_run_count: u64,
    #[serde(default = "complete_runs")]
    pub runs_complete: bool,
    #[serde(default)]
    pub skipped_runs: u64,
    #[serde(default)]
    pub last_skipped_at: Option<i64>,
    pub id: String,
    pub revision: u64,
    pub channel_sequence: u64,
    pub owner: String,
    pub mode: TaskMode,
    pub interaction_mode: InteractionMode,
    pub objective: String,
    pub thread_id: Option<String>,
    pub schedule: Option<Schedule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule_v2: Option<ScheduleV2>,
    pub next_run_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_trigger_decision: Option<TriggerDecision>,
    pub paused: bool,
    pub cancelled: bool,
    pub token_budget: Option<u64>,
    pub max_turns: Option<u64>,
    pub max_active_seconds: Option<u64>,
    pub runs: Vec<TaskRun>,
    pub messages: Vec<ChannelMessage>,
}

fn complete_runs() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskRunsList {
    pub task_id: String,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskRunRead {
    pub task_id: String,
    pub run_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskRunsPage {
    pub data: Vec<TaskRun>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
    pub run_count: u64,
}

#[cfg(test)]
mod worker_compatibility_tests {
    use super::TaskWorker;
    use crate::delegation::ExecutionRef;
    use serde_json::json;

    #[test]
    fn old_worker_snapshots_retain_their_execution_identity() {
        let worker: TaskWorker = serde_json::from_value(json!({
            "threadId":"thread", "turnId":"turn", "status":"running", "settled":false
        }))
        .unwrap();
        assert_eq!(
            worker.execution_ref(),
            Some(ExecutionRef::Thread {
                thread_id: "thread".into(),
                turn_id: "turn".into()
            })
        );
    }

    #[test]
    fn isolated_worker_reference_does_not_fabricate_thread_ids() {
        let worker: TaskWorker = serde_json::from_value(json!({
            "execution":{"kind":"workgroup","workgroupId":"group","automatic":true},
            "executionId":"execution", "status":"running", "settled":false
        }))
        .unwrap();
        assert_eq!(
            worker.execution_ref(),
            Some(ExecutionRef::Workgroup {
                workgroup_id: "group".into(),
                automatic: true
            })
        );
        let saved = serde_json::to_value(worker).unwrap();
        assert!(saved.get("threadId").is_none());
        assert!(saved.get("turnId").is_none());
    }
}
