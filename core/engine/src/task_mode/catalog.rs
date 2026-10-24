use super::*;
use sha2::{Digest, Sha256};
use std::io::Read;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PublishedTaskCatalogFallback {
    LegacyFormat,
    ReadBudgetExceeded,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PublishedTaskCatalog {
    Snapshot {
        root_digest: String,
        data: Vec<Value>,
        has_more: bool,
    },
    Empty,
    RequiresCore {
        reason: PublishedTaskCatalogFallback,
    },
}

/// Reads a published snapshot for a trusted local caller with unrestricted Thread visibility.
/// The snapshot does not establish live execution state or resolve unknown submissions.
pub fn read_published_task_catalog(
    root: &Path,
    source_thread_id: Option<&str>,
    limit: usize,
) -> Result<PublishedTaskCatalog> {
    use std::os::unix::fs::OpenOptionsExt;
    if !(1..=MAX_TASKS).contains(&limit) {
        return Err(invalid("limit must be 1..1024"));
    }
    let desktop = root.join("desktop");
    match std::fs::symlink_metadata(&desktop) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Err(Error::Storage("invalid Task catalog directory".into())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PublishedTaskCatalog::Empty);
        }
        Err(error) => return Err(Error::Storage(error.to_string())),
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags((rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32)
        .open(desktop.join("task-mode.json"));
    let file = match file {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PublishedTaskCatalog::Empty);
        }
        Err(error) => return Err(Error::Storage(error.to_string())),
    };
    let metadata = file.metadata().map_err(|e| Error::Storage(e.to_string()))?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES as u64 {
        return Err(Error::Storage("task store exceeds capacity".into()));
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| Error::Storage(e.to_string()))?;
    if bytes.len() > MAX_BYTES {
        return Err(Error::Storage("task store exceeds capacity".into()));
    }
    #[derive(Deserialize)]
    struct Header {
        version: u32,
    }
    let header: Header =
        serde_json::from_slice(&bytes).map_err(|error| Error::Storage(error.to_string()))?;
    if matches!(header.version, 1..=4) {
        return Ok(PublishedTaskCatalog::RequiresCore {
            reason: PublishedTaskCatalogFallback::LegacyFormat,
        });
    }
    if header.version != 5 {
        return Err(Error::Storage("unsupported task store".into()));
    }
    let state = Snapshot::read_current_catalog(root, &bytes, MAX_BYTES)
        .map_err(|error| Error::Storage(format!("{error:#}")))?;
    let Some(state) = state else {
        return Ok(PublishedTaskCatalog::RequiresCore {
            reason: PublishedTaskCatalogFallback::ReadBudgetExceeded,
        });
    };
    let mut tasks = state.tasks.values().filter(|task| {
        task.mode == TaskMode::Scheduled
            && source_thread_id.is_none_or(|id| task.source_thread_id.as_deref() == Some(id))
            && (task.deleted_at.is_none()
                || task.runs.iter().any(|run| {
                    !run.status.terminal() || run.workers.iter().any(|worker| !worker.settled)
                }))
    });
    let data = tasks.by_ref().take(limit).map(summary).collect();
    Ok(PublishedTaskCatalog::Snapshot {
        root_digest: format!("{:x}", Sha256::digest(&bytes)),
        data,
        has_more: tasks.next().is_some(),
    })
}
