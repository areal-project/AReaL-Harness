//! 资料库（library.json）的单写者：切到 Host 后，桌面 Main 不再改 library.json，而是把整份新内容写到同目录的
//! 暂存文件（资料库可达 8 MiB，超过控制通道 1 MiB 帧），由 Host 按内容摘要比较后替换，冲突时 Main 从磁盘重读再重算。
//! 文件留在原 GUI 数据目录，不搬家。
use super::Host;
use crate::wire::error;
use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Write {
    profile: PathBuf,
    expected_digest: Option<String>,
    staged: String,
}

fn library_path(host: &Host, profile: &Path) -> Result<PathBuf> {
    let source = host
        .migration
        .navigation_source_id(profile)?
        .ok_or_else(|| error("notFound", "GUI profile has no committed navigation source"))?;
    let home = host
        .migration
        .power_sources()?
        .remove(&source)
        .context("navigation source disappeared")?;
    Ok(home.join("library.json"))
}

fn digest(path: &Path) -> Result<Option<String>> {
    Ok(crate::migration::read_bytes(path)?
        .map(|bytes| areal_local_service::storage::digest(&bytes)))
}

pub(super) fn write(host: &Host, input: Write) -> Result<Value> {
    let path = library_path(host, &input.profile)?;
    ensure!(
        staged_name(&input.staged),
        error("invalidRequest", "invalid staged library name")
    );
    let staged = path.with_file_name(&input.staged);
    let bytes = crate::migration::read_bytes(&staged)?
        .ok_or_else(|| error("invalidRequest", "staged library is missing"))?;
    let _ = std::fs::remove_file(&staged);
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| error("invalidRequest", "staged library is not JSON"))?;
    let digest = swap(&path, input.expected_digest.as_deref(), &value)?;
    host.changed();
    Ok(json!({ "digest": digest }))
}

fn staged_name(name: &str) -> bool {
    name.strip_prefix(".library-next-")
        .and_then(|rest| rest.strip_suffix(".json"))
        .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
}

/// 摘要检查与改名之间没有 await，单线程 Host 里两次写不会交错。
fn swap(path: &Path, expected: Option<&str>, value: &Value) -> Result<String> {
    ensure!(
        value.is_object(),
        error("invalidRequest", "library must be an object")
    );
    let bytes = serde_json::to_vec(value)?;
    crate::shell::validate_library(&bytes)
        .map_err(|_| error("invalidRequest", "library does not pass navigation limits"))?;
    if digest(path)?.as_deref() != expected {
        return Err(error("conflict", "library changed since it was read"));
    }
    crate::migration::atomic_bytes(path, &bytes)?;
    Ok(areal_local_service::storage::digest(&bytes))
}

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
    if let Some(bytes) = crate::migration::read_bytes(path)? {
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
    crate::migration::atomic_bytes(&path, &bytes)?;
    host.changed();
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compare_and_swap_rejects_stale_and_invalid_writes() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("library.json");
        let first = swap(&path, None, &json!({"projects":{}})).unwrap();
        assert_eq!(digest(&path).unwrap().as_deref(), Some(first.as_str()));
        let code = |result: Result<String>| {
            result
                .unwrap_err()
                .downcast::<crate::wire::Error>()
                .unwrap()
                .code
        };
        assert_eq!(code(swap(&path, None, &json!({"projects":{}}))), "conflict");
        assert_eq!(
            code(swap(&path, Some(&first), &json!({"projects":[]}))),
            "invalidRequest"
        );
        assert_eq!(
            code(swap(&path, Some(&first), &json!([1]))),
            "invalidRequest"
        );
        let second = swap(
            &path,
            Some(&first),
            &json!({"projects":{"p":{"pinned":true}}}),
        )
        .unwrap();
        assert_eq!(
            code(swap(&path, Some(&first), &json!({"projects":{}}))),
            "conflict"
        );
        assert_ne!(first, second);
        assert!(staged_name(
            ".library-next-11111111-1111-4111-8111-111111111111.json"
        ));
        assert!(!staged_name(".library-next-../library.json"));
        assert!(!staged_name("library.json"));
    }
}
