//! 内置资源只物化编译时的固定清单；Core 不读取 ASAR，也不接受调用方指定的资源路径。
use anyhow::{Context, Result, ensure};
use areal_local_service::storage;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

pub(crate) const ID: &str = "openai-skill-creator";
const DIGEST: &str = "0f1420873667f4997fc9342ed78a543228c66f977f4f8be37a88e573a1a5ae71";
const REVISION: &str = "49f948faa9258a0c61caceaf225e179651397431";
macro_rules! asset { ($path:literal) => { ($path, include_bytes!(concat!("../../../clients/gui/packages/workbench/assets/builtin-skills/openai-skill-creator/", $path)).as_slice()) }; }
const FILES: &[(&str, &[u8])] = &[
    asset!("LICENSE.txt"),
    asset!("SKILL.md"),
    asset!("agents/openai.yaml"),
    asset!("references/openai_yaml.md"),
    asset!("scripts/generate_openai_yaml.py"),
    asset!("scripts/init_skill.py"),
    asset!("scripts/quick_validate.py"),
];
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    upstream: String,
    revision: String,
    content_digest: String,
    files: Vec<Entry>,
}
#[derive(Serialize, Deserialize)]
struct Entry {
    path: String,
    sha256: String,
    executable: bool,
}
#[derive(Deserialize)]
pub(crate) struct Metadata {
    pub name: String,
    pub description: String,
}
pub(crate) struct Skill {
    pub root: PathBuf,
    pub revision: String,
    pub metadata: Metadata,
}

fn verify(root: &Path, manifest: &Manifest) -> Result<()> {
    let mut found = Vec::new();
    let mut pending = vec![root.to_owned()];
    while let Some(directory) = pending.pop() {
        ensure!(
            directory.symlink_metadata()?.is_dir(),
            "builtin skill directory is invalid"
        );
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_dir() {
                pending.push(entry.path());
            } else {
                ensure!(
                    kind.is_file(),
                    "builtin skill cannot contain links or special files"
                );
                found.push(
                    entry
                        .path()
                        .strip_prefix(root)?
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
    }
    found.sort();
    ensure!(
        found
            == manifest
                .files
                .iter()
                .map(|file| file.path.clone())
                .collect::<Vec<_>>(),
        "builtin skill file inventory differs"
    );
    for (entry, (_, expected)) in manifest.files.iter().zip(FILES) {
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(root.join(&entry.path))?;
        ensure!(
            file.metadata()?.is_file(),
            "builtin skill resource is not a regular file"
        );
        let mut bytes = Vec::new();
        file.take(expected.len() as u64 + 1)
            .read_to_end(&mut bytes)?;
        ensure!(
            storage::digest(&bytes) == entry.sha256,
            "builtin skill content digest differs"
        );
    }
    Ok(())
}

pub(crate) fn materialize(home: &Path) -> Result<Skill> {
    let manifest: Manifest = serde_json::from_str(include_str!(
        "../../../clients/gui/packages/workbench/assets/builtin-skills/openai-skill-creator.source.json"
    ))?;
    ensure!(
        manifest.upstream == "https://github.com/openai/skills"
            && manifest.revision == REVISION
            && manifest.content_digest == DIGEST
            && storage::digest(&serde_json::to_vec(&manifest.files)?) == DIGEST
            && manifest.files.len() == FILES.len(),
        "builtin skill provenance differs"
    );
    for (entry, (path, bytes)) in manifest.files.iter().zip(FILES) {
        ensure!(
            entry.path == *path && storage::digest(bytes) == entry.sha256,
            "embedded builtin skill differs from inventory"
        );
    }
    let base = home.join("builtin-skills");
    storage::private_dir(&base)?;
    let root = base.join(DIGEST);
    match root.symlink_metadata() {
        Ok(_) => verify(&root, &manifest)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let stage = base.join(format!(".stage-{}", uuid::Uuid::new_v4()));
            storage::private_dir(&stage)?;
            let result = (|| -> Result<()> {
                for (entry, (_, bytes)) in manifest.files.iter().zip(FILES) {
                    let path = stage.join(&entry.path);
                    storage::private_dir(path.parent().unwrap())?;
                    let mut file = fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .mode(if entry.executable { 0o500 } else { 0o400 })
                        .open(path)?;
                    file.write_all(bytes)?;
                    file.sync_all()?;
                }
                verify(&stage, &manifest)?;
                if let Err(error) = fs::rename(&stage, &root) {
                    verify(&root, &manifest).context(error)?;
                }
                Ok(())
            })();
            if stage.exists() {
                fs::remove_dir_all(&stage)?;
            }
            result?;
            verify(&root, &manifest)?;
        }
        Err(error) => return Err(error.into()),
    }
    fs::set_permissions(&root, fs::Permissions::from_mode(0o500))?;
    let header = std::str::from_utf8(FILES[1].1)?
        .split("---")
        .nth(1)
        .context("builtin skill frontmatter missing")?;
    Ok(Skill {
        root,
        revision: format!("builtin-{DIGEST}"),
        metadata: serde_yaml_ng::from_str(header)?,
    })
}

pub(crate) fn descriptor(home: &Path) -> Result<serde_json::Value> {
    let skill = materialize(home)?;
    Ok(
        serde_json::json!({"skill":{"id":ID,"revision":skill.revision,"name":skill.metadata.name,"description":skill.metadata.description},"provenance":{"upstream":"https://github.com/openai/skills","revision":REVISION,"contentDigest":DIGEST}}),
    )
}
