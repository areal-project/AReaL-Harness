use crate::{PluginDetail, Store, StoreError, package, remote};
use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::File,
    io::{Cursor, Read},
    path::{Path, PathBuf},
};

const LIMIT: u64 = 64 * 1024 * 1024;
const ENTRIES: usize = 4096;

// Bound the central directory before the ZIP reader allocates its index. Its
// index coalesces duplicate raw names, so its final length must also match.
fn entry_count(bytes: &[u8]) -> Result<usize> {
    let end = (bytes.len().saturating_sub(65557)..bytes.len().saturating_sub(21))
        .rev()
        .find(|&i| {
            bytes.get(i..i + 4) == Some(b"PK\x05\x06")
                && i + 22 + u16::from_le_bytes([bytes[i + 20], bytes[i + 21]]) as usize
                    == bytes.len()
        })
        .context("ZIP end record missing")?;
    let u16_at = |i| u16::from_le_bytes([bytes[end + i], bytes[end + i + 1]]) as usize;
    let u32_at = |i| u32::from_le_bytes(bytes[end + i..end + i + 4].try_into().unwrap()) as usize;
    let count = u16_at(10);
    ensure!(
        u16_at(4) == 0 && u16_at(6) == 0 && u16_at(8) == count,
        "split ZIP archives are unsupported"
    );
    ensure!(
        (1..=ENTRIES).contains(&count),
        "ZIP exceeds 4096 entries or is empty"
    );
    ensure!(
        u32_at(16).checked_add(u32_at(12)) == Some(end),
        "ZIP64, appended data, or invalid central directory"
    );
    Ok(count)
}

fn contents(bytes: &[u8]) -> Result<package::Files> {
    let count = entry_count(bytes)?;
    let mut archive = zip::ZipArchive::with_config(
        zip::read::Config {
            archive_offset: zip::read::ArchiveOffset::Known(0),
        },
        Cursor::new(bytes),
    )?;
    ensure!(archive.len() == count, "duplicate ZIP entries");
    let mut files = package::Files::new();
    let mut names = BTreeSet::new();
    let mut total = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let raw = std::str::from_utf8(entry.name_raw()).context("ZIP paths must be UTF-8")?;
        ensure!(
            raw.len() <= 4096 && !raw.chars().any(char::is_control) && !raw.contains(':'),
            "invalid ZIP path"
        );
        let name = package::relative(raw)?;
        ensure!(
            !name.split('/').any(|p| p.eq_ignore_ascii_case(".git")),
            ".git is prohibited in archives"
        );
        ensure!(
            name.split('/').count() <= 64,
            "ZIP directory nesting exceeds 64"
        );
        ensure!(
            names.insert(name.to_lowercase()),
            "duplicate normalized ZIP path"
        );
        ensure!(!entry.encrypted(), "encrypted ZIP entries are unsupported");
        let mode = entry.unix_mode().unwrap_or(0);
        let kind = mode & 0o170000;
        let directory = entry.is_dir();
        ensure!(
            kind == 0 || kind == if directory { 0o040000 } else { 0o100000 },
            "ZIP links and special files are prohibited"
        );
        if directory {
            ensure!(entry.size() == 0, "ZIP directory contains data");
            continue;
        }
        ensure!(
            entry.size() <= LIMIT - total,
            "ZIP expanded content exceeds 64 MiB"
        );
        let mut data = Vec::new();
        entry
            .by_ref()
            .take(LIMIT - total + 1)
            .read_to_end(&mut data)?;
        ensure!(
            data.len() as u64 == entry.size() && data.len() as u64 <= LIMIT - total,
            "ZIP expanded size mismatch or exceeds 64 MiB"
        );
        total += data.len() as u64;
        files.insert(
            name,
            package::PackageFile {
                bytes: data,
                executable: mode & 0o111 != 0,
            },
        );
    }
    let manifests = [
        "plugin.json",
        ".codex-plugin/plugin.json",
        ".claude-plugin/plugin.json",
        ".cursor-plugin/plugin.json",
    ];
    if !manifests.iter().any(|p| files.contains_key(*p)) {
        let prefix = files
            .keys()
            .next()
            .and_then(|p| p.split_once('/'))
            .map(|(p, _)| format!("{p}/"))
            .context("plugin archive has no manifest")?;
        ensure!(
            files.keys().all(|p| p.starts_with(&prefix)),
            "archive must contain one plugin root"
        );
        files = files
            .into_iter()
            .map(|(name, bytes)| (name[prefix.len()..].to_owned(), bytes))
            .collect();
    }
    Ok(files)
}

impl Store {
    pub fn import_archive(&self, path: &Path, expected_revision: u64) -> Result<PluginDetail> {
        let actual = self.state()?.revision;
        if actual != expected_revision {
            return Err(StoreError::Conflict {
                expected: expected_revision,
                actual,
            }
            .into());
        }
        ensure!(path.is_absolute(), "archive path must be absolute");
        let mut file = File::from(rustix::fs::open(
            path,
            rustix::fs::OFlags::RDONLY
                | rustix::fs::OFlags::NOFOLLOW
                | rustix::fs::OFlags::NONBLOCK
                | rustix::fs::OFlags::CLOEXEC,
            rustix::fs::Mode::empty(),
        )?);
        let metadata = file.metadata()?;
        ensure!(
            metadata.is_file() && metadata.len() <= LIMIT,
            "archive must be a regular file of at most 64 MiB"
        );
        let mut bytes = Vec::new();
        file.by_ref().take(LIMIT + 1).read_to_end(&mut bytes)?;
        ensure!(bytes.len() as u64 <= LIMIT, "archive exceeds 64 MiB");
        let archive_digest = format!("{:x}", Sha256::digest(&bytes));
        let files = contents(&bytes)?;
        let source = PathBuf::from(format!("archive-{archive_digest}"));
        let root = self.root.join("cache").join(package::digest(&files));
        let preview = package::parse(&files, "archive-preview", &source, &root)?;
        let id = format!("{}@archive-{archive_digest}", preview.name);
        let mut detail = package::parse(&files, &id, &source, &root)?;
        detail.source_kind = Some("archive".into());
        detail.catalog_source = serde_json::json!({"type":"archive", "sha256":archive_digest});
        detail.integrity = Some(format!("sha256:{archive_digest}"));
        self.transact(expected_revision, |state| {
            let root = remote::publish(self, &files, package::SnapshotBudget::Plugin)?;
            state.candidates.insert(
                id.clone(),
                remote::Candidate {
                    detail,
                    root,
                    definition: None,
                },
            );
            Ok(())
        })?;
        self.read(&id)
    }
}
