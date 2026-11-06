use crate::{ProjectActivity, ProjectRegistration};
use anyhow::{Context, Result, ensure};
use areal_local_service::storage;
use areal_protocol::service::{Owner, Service, State, StopOperationState, VERSION};
use fs2::FileExt;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs::{File, OpenOptions},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};

pub(crate) async fn observe(
    home: &Path,
    registration: &ProjectRegistration,
    owner: &Owner,
    supervised: bool,
    known_service: Option<&Service>,
) -> Result<ProjectActivity> {
    let instance = &storage::digest(registration.data_dir.as_os_str().as_encoded_bytes())[..24];
    let directory = storage::registry(home, instance)?;
    let _startup = existing_lock(&directory.join("start.lock"))?;
    let record: Option<Service> = storage::read_optional(&directory.join("service.json"))?;
    let Some(service) = record else {
        ensure!(
            !supervised && known_service.is_none(),
            "known service record is missing"
        );
        let launch_inputs = home
            .join("host/launch")
            .join(storage::digest(registration.project_id.as_bytes()))
            .join("inputs.json");
        ensure!(
            storage::read_optional::<Value>(&launch_inputs)?.is_none(),
            "previous activation has no service record"
        );
        let _service = existing_lock(&registration.data_dir.join("service.lock"))?;
        let _store = existing_lock(&registration.data_dir.join("owner.lock"))?;
        return Ok(idle(&registration.project_id));
    };
    ensure!(
        service.identity.service_id == instance
            && service.identity.protocol_version == VERSION
            && service.identity.data_dir == registration.data_dir
            && service.identity.workspace == registration.workspace,
        "service does not match the registered project"
    );
    if service.state == State::Stopped {
        let _service = existing_lock(&registration.data_dir.join("service.lock"))?;
        let _store = existing_lock(&registration.data_dir.join("owner.lock"))?;
        ensure!(
            confirmed_cleanup(&directory, &service)?,
            "cleanup is unconfirmed"
        );
        return Ok(idle(&registration.project_id));
    }
    ensure!(
        service.state == State::Ready && supervised && service.owner.as_ref() == Some(owner),
        "project has no current supervised Core"
    );
    areal_local_service::probe(&service).await?;
    let status = areal_local_service::rpc(&service, "areal/server/status", json!({})).await?;
    let current: Service = storage::read(&directory.join("service.json"))?;
    ensure!(
        current.identity == service.identity
            && current.owner == service.owner
            && current.state == State::Ready,
        "service changed during observation"
    );
    counts(&registration.project_id, status)
}

fn existing_lock(path: &Path) -> Result<Option<File>> {
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && metadata.uid() == unsafe { libc::geteuid() },
        "invalid lifecycle lock"
    );
    FileExt::try_lock_shared(&file).context("project lifecycle is busy")?;
    Ok(Some(file))
}

fn confirmed_cleanup(directory: &Path, service: &Service) -> Result<bool> {
    if let Some(proof) =
        storage::read_optional::<storage::CleanupReceipt>(&directory.join("cleanup.json"))?
        && proof.version == VERSION
        && proof.identity == service.identity
        && proof.owner == service.owner
        && proof.cleanup_confirmed
    {
        return Ok(true);
    }
    if let Some(proof) =
        storage::read_optional::<storage::CrashReceipt>(&directory.join("crash.json"))?
        && proof.version == VERSION
        && proof.identity == service.identity
        && proof.owner == service.owner
        && proof.cleanup_confirmed
    {
        return Ok(true);
    }
    let operations = directory.join("operations");
    if !operations.exists() {
        return Ok(false);
    }
    for entry in std::fs::read_dir(operations)? {
        let receipt: storage::StopReceipt = storage::read(&entry?.path())?;
        if receipt.service.identity == service.identity
            && receipt.service.owner == service.owner
            && receipt.cleanup_confirmed
            && receipt.operation.version == VERSION
            && receipt.operation.service_id == service.identity.service_id
            && receipt.operation.generation == service.identity.generation
            && receipt.operation.state == StopOperationState::Completed
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn idle(project_id: &str) -> ProjectActivity {
    ProjectActivity::Observed {
        project_id: project_id.into(),
        active_tasks: 0,
        active_turns: 0,
        active_goals: 0,
        pending_queue_items: 0,
        idle_allowed: true,
    }
}

fn counts(project_id: &str, status: Value) -> Result<ProjectActivity> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Status {
        active_tasks: u64,
        active_turns: Vec<Value>,
        active_goals: Vec<Value>,
        pending_queue_items: u64,
        lifecycle: Lifecycle,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Lifecycle {
        version: u32,
        if_idle: Assessment,
    }
    #[derive(Deserialize)]
    struct Assessment {
        allowed: bool,
    }
    let status: Status = serde_json::from_value(status)?;
    ensure!(
        status.lifecycle.version == VERSION,
        "unsupported lifecycle assessment version"
    );
    Ok(ProjectActivity::Observed {
        project_id: project_id.into(),
        active_tasks: status.active_tasks,
        active_turns: status.active_turns.len() as u64,
        active_goals: status.active_goals.len() as u64,
        pending_queue_items: status.pending_queue_items,
        idle_allowed: status.lifecycle.if_idle.allowed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_counts_preserve_task_count_and_core_idle_assessment() {
        let status = json!({"activeTasks":2,"activeTurns":[{},{}],"activeGoals":[{}],"pendingQueueItems":3,"lifecycle":{"version":1,"ifIdle":{"allowed":false}},"unknownField":"ignored"});
        assert_eq!(
            counts("project", status.clone()).unwrap(),
            ProjectActivity::Observed {
                project_id: "project".into(),
                active_tasks: 2,
                active_turns: 2,
                active_goals: 1,
                pending_queue_items: 3,
                idle_allowed: false
            }
        );
        for path in [
            "activeTasks",
            "activeTurns",
            "activeGoals",
            "pendingQueueItems",
            "lifecycle",
        ] {
            let mut missing = status.clone();
            missing.as_object_mut().unwrap().remove(path);
            assert!(counts("project", missing).is_err(), "{path}");
        }
        for version in [Value::Null, json!(0), json!(2), json!("1")] {
            let mut unsupported = status.clone();
            unsupported["lifecycle"]["version"] = version;
            assert!(counts("project", unsupported).is_err());
        }
        let resources_busy = json!({"activeTasks":0,"activeTurns":[],"activeGoals":[],"pendingQueueItems":0,"lifecycle":{"version":1,"ifIdle":{"allowed":false}}});
        assert_eq!(
            counts("project", resources_busy).unwrap(),
            ProjectActivity::Observed {
                project_id: "project".into(),
                active_tasks: 0,
                active_turns: 0,
                active_goals: 0,
                pending_queue_items: 0,
                idle_allowed: false
            }
        );
    }
}
