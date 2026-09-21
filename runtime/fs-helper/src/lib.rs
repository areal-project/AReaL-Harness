use areal_runtime_protocol::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use rustix::fs::{self, AtFlags, Mode, OFlags};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Write},
    path::{Component, Path},
};

fn invalid(message: &str) -> Error {
    Error::new(ErrorCode::InvalidArgument, message)
}
fn conflict() -> Error {
    Error::new(
        ErrorCode::Conflict,
        "file changed or patch is not uniquely applicable",
    )
}
fn io(error: impl Into<std::io::Error>) -> Error {
    let error = error.into();
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => ErrorCode::NotFound,
        std::io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
        std::io::ErrorKind::AlreadyExists => ErrorCode::Conflict,
        _ => ErrorCode::InvalidArgument,
    };
    Error::new(code, format!("filesystem operation failed: {error}"))
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn regular(file: &File) -> Result<()> {
    let metadata = file.metadata().map_err(io)?;
    if !metadata.is_file() {
        return Err(invalid("expected a regular file"));
    }
    if metadata.len() > MAX_EDIT_FILE as u64 {
        return Err(Error::new(
            ErrorCode::ResourceExhausted,
            "file exceeds 8 MiB",
        ));
    }
    Ok(())
}
fn read(parent: &File, name: &str) -> Result<(Vec<u8>, u32)> {
    use std::os::unix::fs::MetadataExt;
    let file: File = fs::openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
        Mode::empty(),
    )
    .map_err(io)?
    .into();
    regular(&file)?;
    let metadata = file.metadata().map_err(io)?;
    // Hard links make unrelated paths share content and are not part of this provider contract.
    if metadata.nlink() != 1 {
        return Err(invalid("hard-linked files are not supported"));
    }
    let mut bytes = Vec::new();
    file.take(MAX_EDIT_FILE as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io)?;
    if bytes.len() > MAX_EDIT_FILE {
        return Err(Error::new(
            ErrorCode::ResourceExhausted,
            "file exceeds 8 MiB",
        ));
    }
    Ok((bytes, metadata.mode() & 0o777))
}
fn directory(parent: &File, name: &str) -> Result<File> {
    Ok(fs::openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(io)?
    .into())
}

/// Authorization is supplied by the Runtime's mandatory OS sandbox. Descriptor
/// traversal additionally rejects symlinks instead of checking then following them.
pub fn execute(request: FileHelperRequest) -> Result<Value> {
    let root: File = fs::open(
        &request.root,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(io)?
    .into();
    let path = request.command.path().to_owned();
    if path.contains('\0')
        || path.len() > 4096
        || Path::new(&path).is_absolute()
        || path.split('/').any(|p| p == "." || p == "..")
    {
        return Err(invalid("expected a relative path without dot components"));
    }
    let parts: Vec<_> = Path::new(&path)
        .components()
        .map(|p| match p {
            Component::Normal(name) => name.to_str().ok_or_else(|| invalid("path must be UTF-8")),
            _ => Err(invalid("invalid path")),
        })
        .collect::<Result<_>>()?;
    let mut parent = root;
    for part in parts.iter().take(parts.len().saturating_sub(1)) {
        parent = directory(&parent, part)?;
    }
    let name = parts.last().copied().unwrap_or(".");
    match request.command {
        FileCommand::Read {
            offset, max_bytes, ..
        } => {
            if max_bytes == 0 || max_bytes > MAX_FILE_CHUNK {
                return Err(invalid("maxBytes must be 1..65536"));
            }
            let (bytes, _) = read(&parent, name)?;
            let begin = usize::try_from(offset)
                .unwrap_or(usize::MAX)
                .min(bytes.len());
            let end = begin.saturating_add(max_bytes).min(bytes.len());
            Ok(
                json!({"dataBase64":STANDARD.encode(&bytes[begin..end]),"sha256":hash(&bytes),"size":bytes.len(),"nextOffset":end,"eof":end==bytes.len()}),
            )
        }
        FileCommand::Stat { .. } => {
            let stat = fs::statat(&parent, name, AtFlags::SYMLINK_NOFOLLOW).map_err(io)?;
            Ok(json!({"kind":kind(fs::FileType::from_raw_mode(stat.st_mode)),"size":stat.st_size}))
        }
        FileCommand::List { after, limit, .. } => {
            if limit == 0 || limit > 256 {
                return Err(invalid("list limit must be 1..256"));
            }
            let dir = directory(&parent, name)?;
            let mut entries = Vec::new();
            for entry in fs::Dir::read_from(&dir).map_err(io)? {
                let entry = entry.map_err(io)?;
                let name = entry
                    .file_name()
                    .to_str()
                    .map_err(|_| invalid("directory contains non-UTF-8 names"))?;
                if name == "." || name == ".." {
                    continue;
                }
                if entries.len() >= 4096 {
                    return Err(Error::new(
                        ErrorCode::ResourceExhausted,
                        "directory exceeds 4096 entries",
                    ));
                }
                entries.push((name.to_owned(), kind(entry.file_type())));
            }
            entries.sort_unstable();
            entries.retain(|(name, _)| after.as_ref().is_none_or(|after| name > after));
            let total = entries.len();
            let mut page = Vec::new();
            let mut bytes = 0;
            for (name, kind) in entries.into_iter().take(limit) {
                let entry = json!({"name":name,"kind":kind});
                let length = serde_json::to_vec(&entry).unwrap().len();
                if bytes + length > MAX_FILE_CHUNK / 2 {
                    break;
                }
                bytes += length;
                page.push(entry);
            }
            let cursor = if page.len() < total {
                page.last().map(|entry| entry["name"].clone())
            } else {
                None
            };
            Ok(json!({"entries":page,"nextCursor":cursor}))
        }
        FileCommand::Write {
            data_base64,
            expected,
            ..
        } => {
            if data_base64.len() > MAX_FILE_CHUNK.div_ceil(3) * 4 {
                return Err(invalid("write exceeds 16 KiB"));
            }
            let bytes = STANDARD
                .decode(data_base64)
                .map_err(|_| invalid("invalid base64"))?;
            if bytes.len() > MAX_FILE_CHUNK {
                return Err(invalid("write exceeds 16 KiB"));
            }
            replace(&parent, name, &bytes, &expected)
        }
        FileCommand::ApplyPatch {
            old_text,
            new_text,
            expected_sha256,
            ..
        } => {
            if old_text.is_empty() || old_text.len() + new_text.len() > MAX_FILE_CHUNK {
                return Err(invalid("patch must be nonempty and at most 16 KiB"));
            }
            let (bytes, _) = read(&parent, name)?;
            if hash(&bytes) != expected_sha256 {
                return Err(conflict());
            }
            let text = std::str::from_utf8(&bytes).map_err(|_| invalid("patch requires UTF-8"))?;
            if text.find(&old_text).is_none() || text.find(&old_text) != text.rfind(&old_text) {
                return Err(conflict());
            }
            let replaced = text.replacen(&old_text, &new_text, 1);
            if replaced.len() > MAX_EDIT_FILE {
                return Err(invalid("patched file exceeds 8 MiB"));
            }
            replace(
                &parent,
                name,
                replaced.as_bytes(),
                &ExpectedFile::Sha256 {
                    value: expected_sha256,
                },
            )
        }
    }
}

fn kind(kind: fs::FileType) -> &'static str {
    match kind {
        fs::FileType::RegularFile => "file",
        fs::FileType::Directory => "directory",
        fs::FileType::Symlink => "symlink",
        _ => "other",
    }
}
fn expected(parent: &File, name: &str, expectation: &ExpectedFile) -> Result<u32> {
    match expectation {
        ExpectedFile::Absent => match fs::statat(parent, name, AtFlags::SYMLINK_NOFOLLOW) {
            Err(rustix::io::Errno::NOENT) => Ok(0o600),
            Ok(_) => Err(conflict()),
            Err(error) => Err(io(error)),
        },
        ExpectedFile::Sha256 { value } => {
            let (bytes, mode) = read(parent, name)?;
            if value.len() != 64 || hash(&bytes) != *value {
                return Err(conflict());
            }
            Ok(mode)
        }
    }
}
fn replace(parent: &File, name: &str, bytes: &[u8], expectation: &ExpectedFile) -> Result<Value> {
    let mode = expected(parent, name, expectation)?;
    let temporary = format!(".areal-{}.tmp", uuid::Uuid::new_v4());
    let mode = Mode::from_bits_truncate(mode as _);
    let mut file: File = fs::openat(
        parent,
        temporary.as_str(),
        OFlags::CREATE | OFlags::EXCL | OFlags::WRONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        mode,
    )
    .map_err(io)?
    .into();
    let result = (|| {
        file.write_all(bytes).map_err(io)?;
        fs::fchmod(&file, mode).map_err(io)?;
        file.sync_all().map_err(io)?;
        expected(parent, name, expectation)?;
        if matches!(expectation, ExpectedFile::Absent) {
            // linkat creates without replacing a concurrently-created destination.
            fs::linkat(parent, temporary.as_str(), parent, name, AtFlags::empty()).map_err(io)?;
            fs::unlinkat(parent, temporary.as_str(), AtFlags::empty()).map_err(|_| {
                Error::new(
                    ErrorCode::Unavailable,
                    "file created but staging link cleanup failed; inspect before retrying",
                )
            })?;
        } else {
            fs::renameat(parent, temporary.as_str(), parent, name).map_err(io)?;
        }
        parent.sync_all().map_err(|_| {
            Error::new(
                ErrorCode::Unavailable,
                "file replaced but directory sync failed; outcome requires inspection",
            )
        })?;
        Ok(json!({"sha256":hash(bytes),"size":bytes.len()}))
    })();
    let _ = fs::unlinkat(parent, temporary.as_str(), AtFlags::empty());
    result
}
