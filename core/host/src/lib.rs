//! 每用户共享 Host。客户端发现与项目激活不承载 Core 执行或生命期。
mod activity;
mod client;
mod gateway;
mod journal;
mod launch;
mod migration;
mod remote_state;
mod schedule_admission;
mod schedule_resources;
mod server;
mod subscription;
mod vault;
mod wire;
use areal_local_service::LocalArgs;
use areal_protocol::service::Service;
pub use client::{Client, Subscription};
pub use launch::ResolveProject;
pub use schedule_resources::SchedulePreparation;
use serde::{Deserialize, Serialize};
use serde_json::Value;
pub use server::{HostExit, RunOptions, run};
use std::{collections::BTreeMap, path::PathBuf};

pub const VERSION: u32 = 1;
pub const CAPABILITIES: &[&str] = &[
    "projects",
    "stopOperations",
    "subscriptions",
    "legacyMigration",
    "guiImport",
    "submissionJournal",
    "credentialVault",
    "remoteState",
    "remoteGatewayV1",
    "subscriptionOwnerV1",
    "activity",
    "scheduledActivation",
    "scheduledPreparation",
    "powerV1",
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Activity {
    pub complete: bool,
    pub projects: Vec<ProjectActivity>,
    pub total_active_tasks: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase", deny_unknown_fields)]
pub enum ProjectActivity {
    Observed {
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "activeTasks")]
        active_tasks: u64,
        #[serde(rename = "activeTurns")]
        active_turns: u64,
        #[serde(rename = "activeGoals")]
        active_goals: u64,
        #[serde(rename = "pendingQueueItems")]
        pending_queue_items: u64,
        #[serde(rename = "idleAllowed")]
        idle_allowed: bool,
    },
    Unavailable {
        #[serde(rename = "projectId")]
        project_id: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostIdentity {
    pub version: u32,
    pub host_id: String,
    pub generation: String,
    pub socket_path: PathBuf,
    pub auth_file: PathBuf,
    pub pid: u32,
    pub executable_version: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ProjectSource {
    Cli,
    Gui {
        profile: PathBuf,
        #[serde(rename = "legacyProjectId")]
        legacy_project_id: String,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectRegistration {
    pub project_id: String,
    pub workspace: PathBuf,
    pub data_dir: PathBuf,
    pub source: ProjectSource,
    pub default_binding: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectStatus {
    pub registration: ProjectRegistration,
    pub state: String,
    #[serde(default)]
    pub schedule_activation_suppressed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule_activation_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service: Option<Service>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migration: Option<Value>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostStatus {
    pub host_id: String,
    pub generation: String,
    pub state: String,
    pub projects: Vec<ProjectStatus>,
    pub restart_pending: bool,
    pub stop_intent: bool,
    pub capabilities: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenResult {
    pub project: ProjectStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service: Option<Service>,
}
impl OpenResult {
    pub fn service(&self) -> anyhow::Result<&Service> {
        self.service
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("project is {}", self.project.state))
    }
}

/// 只包含可持久化输入；秘密通过 ensure 的独立字段传递。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchInputs {
    pub workspace: PathBuf,
    pub cwd: PathBuf,
    pub config_home: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homedir: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deployment_path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule_preparation: Option<SchedulePreparation>,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
    #[serde(default)]
    pub credential_names: Vec<String>,
    pub options: LocalArgs,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopStrategy {
    IfIdle,
    Cancel,
}
impl StopStrategy {
    pub(crate) fn cancel(self) -> bool {
        matches!(self, Self::Cancel)
    }
}

pub fn operation_offline(
    home: &std::path::Path,
    request_id: &str,
) -> anyhow::Result<Option<Value>> {
    wire::request_id(request_id)?;
    let record: Option<Value> =
        areal_local_service::storage::read_optional(&wire::operation_path(home, request_id))?;
    if let Some(record) = record {
        return Ok(Some(record["receipt"].clone()));
    }
    if let Some(receipt) = migration::Migration::operation_offline(home, request_id)? {
        return Ok(Some(receipt));
    }
    if let Some(receipt) = journal::Journal::operation_offline(home, request_id)? {
        return Ok(Some(receipt));
    }
    if let Some(receipt) = vault::Vault::operation_offline(home, request_id)? {
        return Ok(Some(receipt));
    }
    remote_state::RemoteState::operation_offline(home, request_id)
}

#[cfg(test)]
mod tests {
    #[tokio::test(flavor = "current_thread")]
    async fn missing_offline_operation_does_not_initialize_host_storage() {
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().join("not-created");
        assert!(super::Client::connect_at(home.clone()).await.is_err());
        assert_eq!(
            super::operation_offline(&home, &uuid::Uuid::new_v4().to_string()).unwrap(),
            None
        );
        assert!(!home.exists());
    }
}
