//! 分块内容先保存在目标目录；只有完整摘要和基线都匹配时才发布目标文件。
use super::*;
use std::{
    io::{Seek, SeekFrom},
    os::unix::fs::MetadataExt,
};

fn staging(name: &str, upload: &str) -> Result<String> {
    if uuid::Uuid::parse_str(upload).is_err() {
        return Err(invalid("uploadId must be a UUID"));
    }
    Ok(format!(
        ".areal-delivery-{}-{upload}.tmp",
        &hash(name.as_bytes())[..16]
    ))
}

fn uncertain(message: &str) -> Error {
    Error::new(ErrorCode::Unavailable, message)
}

fn expected_mode(
    parent: &File,
    name: &str,
    value: &ExpectedFile,
    executable: Option<bool>,
) -> Result<u32> {
    let mode = expected(parent, name, value)?;
    match (value, executable) {
        (ExpectedFile::Absent, None) => {}
        (ExpectedFile::Sha256 { .. }, Some(want)) if (mode & 0o111 != 0) == want => {}
        _ => return Err(conflict()),
    }
    if matches!(value, ExpectedFile::Absent) {
        return Ok(mode);
    }
    let full_mode: u32 = fs::statat(parent, name, AtFlags::SYMLINK_NOFOLLOW)
        .map_err(io)?
        .st_mode as _;
    let full_mode = full_mode & 0o7777;
    if full_mode & 0o777 != mode {
        return Err(conflict());
    }
    Ok(full_mode)
}

fn unchanged_mode(
    parent: &File,
    name: &str,
    expected: &ExpectedFile,
    executable: Option<bool>,
    original: u32,
) -> Result<()> {
    if expected_mode(parent, name, expected, executable)? != original {
        return Err(conflict());
    }
    Ok(())
}

pub(super) fn execute(parent: &File, name: &str, command: FileCommand) -> Result<Value> {
    match command {
        FileCommand::StageFileChunk {
            upload_id,
            offset,
            data_base64,
            ..
        } => {
            let temporary = staging(name, &upload_id)?;
            if data_base64.len() > MAX_FILE_CHUNK.div_ceil(3) * 4 {
                return Err(invalid("staging chunk exceeds 64 KiB"));
            }
            let bytes = STANDARD
                .decode(data_base64)
                .map_err(|_| invalid("invalid base64"))?;
            if bytes.len() > MAX_FILE_CHUNK
                || offset > MAX_EDIT_FILE as u64
                || offset + bytes.len() as u64 > MAX_EDIT_FILE as u64
            {
                return Err(invalid("staged file exceeds 8 MiB"));
            }
            let mut flags = OFlags::WRONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK;
            if offset == 0 {
                flags |= OFlags::CREATE | OFlags::EXCL;
            }
            let mut file: File = fs::openat(
                parent,
                temporary.as_str(),
                flags,
                Mode::from_bits_truncate(0o600),
            )
            .map_err(io)?
            .into();
            regular(&file)?;
            let metadata = file.metadata().map_err(io)?;
            if metadata.nlink() != 1 || metadata.len() != offset {
                return Err(conflict());
            }
            file.seek(SeekFrom::Start(offset)).map_err(io)?;
            file.write_all(&bytes)
                .map_err(|_| uncertain("staging write is uncertain; inspect before retrying"))?;
            file.sync_all()
                .map_err(|_| uncertain("staging sync is uncertain; inspect before retrying"))?;
            parent
                .sync_all()
                .map_err(|_| uncertain("staging directory sync is uncertain"))?;
            Ok(json!({"uploadId":upload_id,"nextOffset":offset + bytes.len() as u64}))
        }
        FileCommand::CommitFile {
            upload_id,
            expected,
            expected_executable,
            sha256,
            executable,
            ..
        } => {
            let temporary = staging(name, &upload_id)?;
            let (bytes, _) = read(parent, &temporary)?;
            if hash(&bytes) != sha256 {
                return Err(conflict());
            }
            let original_mode = expected_mode(parent, name, &expected, expected_executable)?;
            // 不直接发布可被替换的 staging 路径；从已核验字节生成独立临时文件。
            let temporary_commit = format!(".areal-{}.tmp", uuid::Uuid::new_v4());
            // 内容更新不能放宽已有文件的读写权限；执行意图只调整普通执行位，不复制特殊权限位。
            let mode = if matches!(expected, ExpectedFile::Absent) {
                if executable { 0o755 } else { 0o644 }
            } else {
                let execute = if !executable {
                    0
                } else if original_mode & 0o111 != 0 {
                    original_mode & 0o111
                } else {
                    ((original_mode & 0o444) >> 2) | 0o100
                };
                (original_mode & 0o666) | execute
            };
            let mode = Mode::from_bits_truncate(mode as _);
            let mut file: File = fs::openat(
                parent,
                temporary_commit.as_str(),
                OFlags::CREATE | OFlags::EXCL | OFlags::WRONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                mode,
            )
            .map_err(io)?
            .into();
            let result = (|| {
                file.write_all(&bytes).map_err(io)?;
                fs::fchmod(&file, mode).map_err(io)?;
                file.sync_all().map_err(io)?;
                unchanged_mode(parent, name, &expected, expected_executable, original_mode)?;
                if matches!(expected, ExpectedFile::Absent) {
                    fs::linkat(
                        parent,
                        temporary_commit.as_str(),
                        parent,
                        name,
                        AtFlags::empty(),
                    )
                    .map_err(io)?;
                    fs::unlinkat(parent, temporary_commit.as_str(), AtFlags::empty())
                        .map_err(|_| uncertain("file created but staging cleanup is uncertain"))?;
                } else {
                    fs::renameat(parent, temporary_commit.as_str(), parent, name).map_err(io)?;
                }
                fs::unlinkat(parent, temporary.as_str(), AtFlags::empty())
                    .map_err(|_| uncertain("file committed but upload cleanup is uncertain"))?;
                parent
                    .sync_all()
                    .map_err(|_| uncertain("file committed but directory sync is uncertain"))?;
                Ok(json!({"sha256":sha256,"size":bytes.len(),"executable":executable}))
            })();
            let _ = fs::unlinkat(parent, temporary_commit.as_str(), AtFlags::empty());
            result
        }
        FileCommand::RemoveFile {
            expected_sha256,
            expected_executable,
            ..
        } => {
            expected_mode(
                parent,
                name,
                &ExpectedFile::Sha256 {
                    value: expected_sha256,
                },
                Some(expected_executable),
            )?;
            fs::unlinkat(parent, name, AtFlags::empty()).map_err(io)?;
            parent
                .sync_all()
                .map_err(|_| uncertain("file removed but directory sync is uncertain"))?;
            Ok(json!({"removed":true}))
        }
        _ => Err(invalid("unsupported delivery command")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn publication_recheck_rejects_chmod_without_content_or_execute_change() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("private");
        std::fs::write(&path, b"unchanged content").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
        let parent = File::open(root.path()).unwrap();
        let expected = ExpectedFile::Sha256 {
            value: hash(b"unchanged content"),
        };
        let before = expected_mode(&parent, "private", &expected, Some(false)).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            unchanged_mode(&parent, "private", &expected, Some(false), before)
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
