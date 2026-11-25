//! 资料库的同步单写事务：按当前状态应用变更，校验后原子保存。
use super::Host;
use anyhow::{Context, Result};
use areal_local_service::storage;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// Host 原生来源不伪装 GUI profile；已发布 GUI 来源仍只读原位置。
pub(super) fn source_home(host: &Host, source: &str) -> Result<PathBuf> {
    if source == "host" {
        return Ok(host.home.join("workbench/native"));
    }
    host.migration
        .power_sources()?
        .remove(source)
        .context("RESOURCE_UNAVAILABLE")
}
pub(super) fn read_source(host: &Host, source: &str) -> Result<Value> {
    read_path(&source_home(host, source)?.join("library.json"))
}
fn read_path(path: &Path) -> Result<Value> {
    let mut state = json!({"projects":{},"threads":{},"projectOrder":[],"sections":[],"sidebarThreadOrder":[],"sidebarRevision":0,"settings":{}});
    if let Some(bytes) = storage::read_bytes(path)? {
        crate::shell::validate_library(&bytes)?;
        let value: Value = serde_json::from_slice(&bytes)?;
        state
            .as_object_mut()
            .unwrap()
            .extend(value.as_object().context("invalid library")?.clone());
    }
    Ok(state)
}
/// 同步读、计算、校验和原子写入之间不 await，所有领域共用一个写者。
/// 未识别的桌面设置和其它领域元数据始终原样保留。
pub(super) fn change(
    host: &Host,
    source: &str,
    update: impl FnOnce(&mut Value) -> Result<()>,
) -> Result<Value> {
    let home = source_home(host, source)?;
    areal_local_service::storage::private_dir(&home)?;
    let path = home.join("library.json");
    let mut value = read_path(&path)?;
    let original = value.clone();
    let previous = super::library_commands::layout(&value);
    let revision = value["sidebarRevision"]
        .as_u64()
        .context("invalid sidebar revision")?;
    update(&mut value)?;
    if super::library_commands::layout(&value) != previous {
        value["sidebarRevision"] = json!(
            revision
                .checked_add(1)
                .context("sidebar revision exhausted")?
        );
    }
    if value == original {
        return Ok(value);
    }
    let bytes = serde_json::to_vec(&value)?;
    crate::shell::validate_library(&bytes)?;
    storage::write_bytes(&path, &bytes)?;
    host.changed();
    Ok(value)
}
