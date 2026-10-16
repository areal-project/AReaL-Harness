//! 启停只修改当前配置的开关；地址、凭据引用、模型和队列归属保持原值。
use crate::{
    ConfigErrorKind as Kind, ConfigInputs, ResolvedCoreConfig, Result, error, file, resolve,
};
use sha2::{Digest, Sha256};
use std::{fs, io::Write};
use toml_edit::{DocumentMut, Item};

pub fn set_trajectory_enabled(
    inputs: &ConfigInputs,
    enabled: bool,
    expected_revision: Option<&str>,
) -> Result<ResolvedCoreConfig> {
    let location = resolve::location(inputs)?;
    let path = &location.selected;
    let at = file::source(path, "", 0);
    let failure = |kind, message| error(kind, "trajectory.enabled", &at, message);
    let parent = path
        .parent()
        .ok_or_else(|| failure(Kind::Io, "invalid configuration path"))?;
    // 与模型编辑和独立配置工具使用同一把文件锁，拒绝并发覆盖。
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32);
    }
    let lock = options
        .open(parent.join(format!(
            ".{}.lock",
            path.file_name().unwrap().to_string_lossy()
        )))
        .map_err(|_| failure(Kind::Io, "cannot lock trajectory configuration"))?;
    fs2::FileExt::try_lock_exclusive(&lock)
        .map_err(|_| failure(Kind::Conflict, "another configuration writer is active"))?;
    let metadata = fs::symlink_metadata(path).map_err(|_| {
        failure(
            Kind::Io,
            "configure a trajectory receiver before enabling export",
        )
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(failure(
            Kind::Io,
            "configuration must be a regular unlinked file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err(failure(Kind::Io, "configuration must not be hard linked"));
        }
    }
    let before = resolve::load_mode(inputs, true, None)?;
    if expected_revision.is_some_and(|revision| revision != before.trajectory.source_revision) {
        return Err(failure(
            Kind::Conflict,
            "configuration changed; refresh before toggling",
        ));
    }
    if enabled && before.trajectory.endpoint.trim().is_empty() {
        return Err(failure(
            Kind::MissingValue,
            "configure a trajectory receiver before enabling export",
        ));
    }
    if enabled
        && !url::Url::parse(&before.trajectory.endpoint).is_ok_and(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
        })
    {
        return Err(failure(
            Kind::InvalidValue,
            "configure a valid trajectory receiver before enabling export",
        ));
    }
    if before.trajectory.enabled == enabled {
        return Ok(before);
    }
    let original = file::read(path, true)?;
    if format!("{:x}", Sha256::digest(original.text.as_bytes()))
        != before.trajectory.source_revision
    {
        return Err(failure(
            Kind::Conflict,
            "configuration changed; refresh before toggling",
        ));
    }
    let mut doc: DocumentMut = original
        .text
        .parse()
        .map_err(|_| failure(Kind::Parse, "invalid TOML configuration"))?;
    if let Some(value) = doc.get_mut("trajectory").and_then(Item::as_table_like_mut) {
        let mut replacement = toml_edit::value(enabled);
        if let Some(previous) = value.get_mut("enabled") {
            // enabled 的前置注释和行尾说明属于用户配置，不随布尔值替换丢失。
            if let Some(previous_value) = previous.as_value() {
                *replacement.as_value_mut().unwrap().decor_mut() = previous_value.decor().clone();
            }
            *previous = replacement;
        } else {
            value.insert("enabled", replacement);
        }
    } else {
        return Err(failure(
            Kind::MissingValue,
            "configure a trajectory receiver before toggling export",
        ));
    }
    let text = doc.to_string();
    let candidate = resolve::load_mode(inputs, true, Some(file::parse(path, &text)?))?;
    if candidate.trajectory.enabled != enabled {
        return Err(failure(
            Kind::Conflict,
            "trajectory enabled is overridden outside this configuration",
        ));
    }
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| failure(Kind::Io, "cannot save trajectory configuration"))?;
    temporary
        .as_file()
        .set_permissions(metadata.permissions())
        .and_then(|()| temporary.write_all(text.as_bytes()))
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|_| failure(Kind::Io, "cannot save trajectory configuration"))?;
    // 外部编辑器不一定参与锁；提交前再次确认读取快照没有变化。
    if file::read(path, true)?.text != original.text {
        return Err(failure(
            Kind::Conflict,
            "configuration changed; refresh before toggling",
        ));
    }
    temporary
        .persist(path)
        .map_err(|_| failure(Kind::Io, "cannot save trajectory configuration"))?;
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| failure(Kind::Io, "cannot sync trajectory configuration"))?;
    Ok(candidate)
}
