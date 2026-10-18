use super::{File, Tree, excluded, valid_path};
use anyhow::{Context, Result, ensure};
use rustix::fs::{self, Dir, Mode, OFlags};
use std::{
    fs::File as Handle,
    io::Read,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_TREE_BYTES: usize = 16 * 1024 * 1024;
const MAX_ENTRIES: usize = 20000;
const READ_FLAGS: OFlags = OFlags::RDONLY
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC)
    .union(OFlags::NONBLOCK);

pub(super) fn read(root: &Path) -> Result<Tree> {
    // Normalize a trailing slash so it cannot bypass NOFOLLOW on the root.
    // The deployment owns the root's ancestors; every entry below this opened
    // directory is untrusted and is resolved relative to a pinned descriptor.
    let root: PathBuf = root.components().collect();
    let directory: Handle = fs::open(&root, READ_FLAGS | OFlags::DIRECTORY, Mode::empty())?.into();
    let mut snapshot = Snapshot::default();
    snapshot.visit(&directory, "", 0)?;
    Ok(snapshot.tree)
}

#[derive(Default)]
struct Snapshot {
    tree: Tree,
    bytes: usize,
    entries: usize,
}

impl Snapshot {
    fn visit(&mut self, directory: &Handle, prefix: &str, depth: usize) -> Result<()> {
        ensure!(depth < 40, "source directory depth exceeded");
        for entry in Dir::read_from(directory)? {
            let entry = entry?;
            let name = entry.file_name().to_str().context("non-UTF8 source name")?;
            if matches!(name, "." | "..") || excluded(name) {
                continue;
            }
            self.entries += 1;
            ensure!(
                self.entries <= MAX_ENTRIES,
                "source entry capacity exceeded"
            );
            let path = if prefix.is_empty() {
                name.to_owned()
            } else {
                format!("{prefix}/{name}")
            };
            ensure!(valid_path(&path), "invalid source path");
            // Never check a pathname and then reopen it. Type, link count,
            // executable mode and bytes all come from the same opened object.
            let file: Handle = fs::openat(directory, name, READ_FLAGS, Mode::empty())?.into();
            let metadata = file.metadata()?;
            if metadata.is_dir() {
                self.visit(&file, &path, depth + 1)?;
                continue;
            }
            ensure!(
                metadata.is_file() && metadata.len() <= MAX_FILE_BYTES as u64,
                "unsupported source entry or file size"
            );
            ensure!(metadata.nlink() == 1, "source hardlinks are unsupported");
            ensure!(self.tree.len() < 10000, "source file capacity exceeded");
            // Concurrent growth cannot bypass the actual byte budget or cause
            // an unbounded allocation. A snapshot is not an atomic filesystem view.
            let limit = MAX_FILE_BYTES.min(MAX_TREE_BYTES - self.bytes);
            let mut bytes = Vec::new();
            (&file).take(limit as u64 + 1).read_to_end(&mut bytes)?;
            ensure!(
                bytes.len() <= limit,
                "source snapshot byte capacity exceeded"
            );
            ensure!(file.metadata()?.nlink() == 1, "source file links changed");
            self.bytes += bytes.len();
            self.tree.insert(
                path,
                File {
                    bytes,
                    executable: metadata.mode() & 0o111 != 0,
                },
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    #[test]
    fn pinned_directory_survives_path_replacement_without_following_the_new_link() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("source");
        let outside = temp.path().join("outside");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(root.join("safe"), b"source").unwrap();
        std::fs::write(outside.join("secret"), b"outside").unwrap();
        let directory = fs::open(&root, READ_FLAGS | OFlags::DIRECTORY, Mode::empty())
            .unwrap()
            .into();
        std::fs::rename(&root, temp.path().join("old-source")).unwrap();
        symlink(&outside, &root).unwrap();
        let mut snapshot = Snapshot::default();
        snapshot.visit(&directory, "subdirectory", 1).unwrap();
        assert_eq!(snapshot.tree.len(), 1);
        assert_eq!(snapshot.tree["subdirectory/safe"].bytes, b"source");
        assert!(read(&root).is_err());
        assert!(read(&root.join("")).is_err());
    }

    #[test]
    fn rejects_links_special_files_and_oversized_sources() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("source");
        std::fs::create_dir(&root).unwrap();
        let outside = temp.path().join("outside");
        std::fs::write(&outside, b"private").unwrap();
        let path = root.join("entry");
        symlink(&outside, &path).unwrap();
        assert!(read(&root).is_err());
        std::fs::remove_file(&path).unwrap();
        symlink(temp.path(), &path).unwrap();
        assert!(read(&root).is_err());
        std::fs::remove_file(&path).unwrap();
        std::fs::hard_link(&outside, &path).unwrap();
        assert!(read(&root).is_err());
        std::fs::remove_file(&path).unwrap();
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&path)
                .status()
                .unwrap()
                .success()
        );
        assert!(read(&root).is_err());
        std::fs::remove_file(&path).unwrap();
        Handle::create(&path)
            .unwrap()
            .set_len(MAX_FILE_BYTES as u64 + 1)
            .unwrap();
        assert!(read(&root).is_err());
    }

    #[test]
    fn snapshot_preserves_modes_exclusions_and_total_limits() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        std::fs::write(root.join("run"), b"script").unwrap();
        std::fs::set_permissions(root.join("run"), std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::create_dir(root.join(".git")).unwrap();
        symlink("/unreadable", root.join(".git/ignored")).unwrap();
        let tree = read(root).unwrap();
        assert_eq!(tree.len(), 1);
        assert!(tree["run"].executable);
        assert_eq!(tree["run"].bytes, b"script");
        for index in 0..8 {
            Handle::create(root.join(format!("file-{index}")))
                .unwrap()
                .set_len(MAX_FILE_BYTES as u64)
                .unwrap();
        }
        assert!(read(root).is_err());
    }

    #[test]
    fn concurrent_link_replacement_never_reads_outside_bytes() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("source");
        std::fs::create_dir(&root).unwrap();
        let outside = temp.path().join("outside");
        std::fs::write(&outside, b"private outside bytes").unwrap();
        let entry = root.join("entry");
        let replacement = temp.path().join("replacement");
        std::fs::write(&entry, b"safe source bytes").unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let writer_stop = stop.clone();
        let writer = std::thread::spawn(move || {
            while !writer_stop.load(Ordering::Relaxed) {
                symlink(&outside, &replacement).unwrap();
                std::fs::rename(&replacement, &entry).unwrap();
                std::fs::write(&replacement, b"safe source bytes").unwrap();
                std::fs::rename(&replacement, &entry).unwrap();
            }
        });
        let mut escaped = false;
        for _ in 0..2048 {
            if let Ok(tree) = read(&root) {
                escaped |= tree.values().any(|file| file.bytes != b"safe source bytes");
            }
        }
        stop.store(true, Ordering::Relaxed);
        writer.join().unwrap();
        assert!(!escaped, "snapshot followed a concurrently replaced link");
    }
}
