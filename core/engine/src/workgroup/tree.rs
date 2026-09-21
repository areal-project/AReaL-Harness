use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::Write,
    path::{Component, Path},
};

#[cfg(unix)]
mod snapshot;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct File {
    pub bytes: Vec<u8>,
    pub executable: bool,
}

/// Bounded, immutable source artifact. Execution material is provisioned separately.
pub type Tree = BTreeMap<String, File>;

pub fn valid_path(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 4096
        && name.split('/').count() <= 40
        && !name.contains(['\\', '\0'])
        && name
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
        && Path::new(name).components().all(
            |part| matches!(part, Component::Normal(value) if !excluded(&value.to_string_lossy())),
        )
}

fn excluded(name: &str) -> bool {
    matches!(
        name,
        ".git" | ".toolchain" | ".scratch" | "__pycache__" | ".pytest_cache"
    )
}

pub fn snapshot(root: &Path) -> Result<Tree> {
    #[cfg(unix)]
    return snapshot::read(root);
    #[cfg(not(unix))]
    anyhow::bail!(
        "descriptor-relative Workgroup snapshots are unsupported: {}",
        root.display()
    )
}

pub fn digest(tree: &Tree) -> String {
    let mut hash = Sha256::new();
    for (path, file) in tree {
        hash.update((path.len() as u64).to_le_bytes());
        hash.update(path);
        hash.update([u8::from(file.executable)]);
        hash.update((file.bytes.len() as u64).to_le_bytes());
        hash.update(&file.bytes);
    }
    format!("{:x}", hash.finalize())
}

pub fn materialize(tree: &Tree, root: &Path) -> Result<()> {
    validate_tree(tree)?;
    ensure!(!root.exists(), "artifact destination already exists");
    std::fs::create_dir_all(root)?;
    for (name, file) in tree {
        ensure!(valid_path(name), "invalid artifact path");
        let path = root.join(name);
        std::fs::create_dir_all(path.parent().unwrap())?;
        let mut output = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)?;
        output.write_all(&file.bytes)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                path,
                std::fs::Permissions::from_mode(if file.executable { 0o755 } else { 0o644 }),
            )?;
        }
    }
    ensure!(
        snapshot(root)? == *tree,
        "filesystem cannot represent the source artifact exactly"
    );
    Ok(())
}

/// File-level optimistic composition. Conflicts return to the owning task.
pub fn compose(head: &Tree, base: &Tree, artifact: &Tree, writes: &[String]) -> Result<Tree> {
    validate_tree(artifact)?;
    let mut candidate = head.clone();
    let paths: std::collections::BTreeSet<_> = base.keys().chain(artifact.keys()).collect();
    for path in paths {
        if base.get(path) == artifact.get(path) {
            continue;
        }
        ensure!(
            writes.contains(path),
            "artifact writes outside ownership: {path}"
        );
        ensure!(
            head.get(path) == base.get(path) || head.get(path) == artifact.get(path),
            "stale artifact conflict: {path}"
        );
        match artifact.get(path) {
            Some(file) => {
                candidate.insert(path.clone(), file.clone());
            }
            None => {
                candidate.remove(path);
            }
        }
    }
    validate_tree(&candidate)?;
    Ok(candidate)
}

pub fn validate_tree(tree: &Tree) -> Result<()> {
    ensure!(tree.len() <= 10000, "artifact file count exceeded");
    let mut total = 0usize;
    for (path, file) in tree {
        ensure!(
            valid_path(path) && file.bytes.len() <= 2 * 1024 * 1024,
            "invalid artifact file"
        );
        total += file.bytes.len();
        ensure!(total <= 16 * 1024 * 1024, "artifact size exceeded");
        let mut parent = Path::new(path).parent();
        while let Some(value) = parent {
            ensure!(
                !tree.contains_key(value.to_str().unwrap()),
                "artifact file/directory collision"
            );
            parent = value.parent();
        }
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct Entry {
    blob: String,
    executable: bool,
}

fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn persist(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(path)?;
    #[cfg(unix)]
    std::fs::File::open(path.parent().unwrap())?.sync_all()?;
    Ok(())
}

/// Publish content before the authoritative run.json references it. One owner
/// holds the workgroup lock. A crash may leave unreferenced blobs, never a head
/// pointing at data which was only in a worker's mutable directory.
pub fn store(root: &Path, tree: &Tree) -> Result<String> {
    validate_tree(tree)?;
    let blobs = root.join("blobs");
    let manifests = root.join("trees");
    std::fs::create_dir_all(&blobs)?;
    std::fs::create_dir_all(&manifests)?;
    let mut size = 0;
    for dir in [&blobs, &manifests] {
        for entry in std::fs::read_dir(dir)? {
            size += entry?.metadata()?.len();
        }
    }
    let mut manifest = BTreeMap::new();
    for (path, file) in tree {
        let blob = hash_bytes(&file.bytes);
        let dest = blobs.join(&blob);
        if !dest.exists() {
            size += file.bytes.len() as u64;
            ensure!(
                size <= 128 * 1024 * 1024,
                "artifact store capacity exceeded"
            );
            persist(&dest, &file.bytes)?;
        } else {
            ensure!(
                hash_bytes(&std::fs::read(&dest)?) == blob,
                "artifact blob corrupted"
            );
        }
        manifest.insert(
            path,
            Entry {
                blob,
                executable: file.executable,
            },
        );
    }
    let id = digest(tree);
    let bytes = serde_json::to_vec(&manifest)?;
    ensure!(
        size + bytes.len() as u64 <= 128 * 1024 * 1024,
        "artifact store capacity exceeded"
    );
    persist(&manifests.join(&id), &bytes)?;
    #[cfg(unix)]
    std::fs::File::open(root)?.sync_all()?;
    Ok(id)
}

pub fn load(root: &Path, id: &str) -> Result<Tree> {
    ensure!(valid_hash(id), "invalid artifact id");
    let path = root.join("trees").join(id);
    ensure!(
        std::fs::metadata(&path)?.len() <= 8 * 1024 * 1024,
        "artifact manifest too large"
    );
    let manifest: BTreeMap<String, Entry> = serde_json::from_slice(&std::fs::read(path)?)?;
    ensure!(manifest.len() <= 10000, "artifact manifest too large");
    let mut tree = Tree::new();
    let mut total = 0;
    for (name, entry) in manifest {
        ensure!(
            valid_path(&name) && valid_hash(&entry.blob),
            "invalid artifact entry"
        );
        let path = root.join("blobs").join(&entry.blob);
        let size = std::fs::metadata(&path)?.len();
        total += size;
        ensure!(
            size <= 2 * 1024 * 1024 && total <= 16 * 1024 * 1024,
            "artifact size exceeded"
        );
        let bytes = std::fs::read(path)?;
        ensure!(hash_bytes(&bytes) == entry.blob, "artifact blob corrupted");
        tree.insert(
            name,
            File {
                bytes,
                executable: entry.executable,
            },
        );
    }
    validate_tree(&tree)?;
    ensure!(digest(&tree) == id, "artifact manifest corrupted");
    Ok(tree)
}

/// File hashing and durable artifact I/O must not occupy async scheduler threads.
pub(super) async fn store_async(root: &Path, tree: &Tree) -> Result<String> {
    let root = root.to_owned();
    let tree = tree.clone();
    tokio::task::spawn_blocking(move || store(&root, &tree)).await?
}
pub(super) async fn load_async(root: &Path, id: &str) -> Result<Tree> {
    let root = root.to_owned();
    let id = id.to_owned();
    tokio::task::spawn_blocking(move || load(&root, &id)).await?
}
