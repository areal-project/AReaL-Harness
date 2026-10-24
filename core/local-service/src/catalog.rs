use crate::storage;
use anyhow::{Result, ensure};
use serde::Serialize;
use std::{
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogTarget {
    pub workspace: PathBuf,
    pub data_dir: PathBuf,
    pub instance_id: String,
}

/// Resolves a trusted local, unrestricted catalog target without starting a service.
pub fn catalog_target(workspace: &Path, data_dir: &Path) -> Result<(CatalogTarget, bool)> {
    ensure!(
        workspace.is_absolute() && data_dir.is_absolute(),
        "catalog paths must be absolute"
    );
    let workspace = workspace.canonicalize()?;
    ensure!(workspace.is_dir(), "workspace must be a directory");
    let data_dir = storage::canonical_pending(data_dir)?;
    ensure!(
        !data_dir.starts_with(&workspace),
        "service state must be outside the workspace"
    );
    let instance_id = storage::digest(data_dir.as_os_str().as_encoded_bytes())[..24].to_owned();
    let target = CatalogTarget {
        workspace,
        data_dir,
        instance_id,
    };
    match std::fs::symlink_metadata(&target.data_dir) {
        Ok(metadata) => ensure!(
            metadata.is_dir() && metadata.uid() == unsafe { libc::geteuid() },
            "catalog data directory must be owned by the current user"
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((target, false)),
        Err(error) => return Err(error.into()),
    }
    let binding = target.data_dir.join("service-workspace");
    match std::fs::symlink_metadata(&binding) {
        Ok(metadata) => ensure!(metadata.is_file(), "invalid workspace binding file"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((target, false)),
        Err(error) => return Err(error.into()),
    }
    let workspace: PathBuf = storage::read(&binding)?;
    ensure!(
        workspace == target.workspace,
        "data directory is bound to another workspace"
    );
    Ok((target, true))
}
