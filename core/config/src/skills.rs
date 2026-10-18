//! 可信启动器提供工作区与用户目录；发现结果不扩大 Runtime 的文件权限。
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
};

#[derive(Debug, Serialize)]
pub struct DiscoveredSkill {
    pub id: String,
    pub revision: String,
    pub root: PathBuf,
    pub metadata: SkillMetadata,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct SkillMetadata {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Default, Serialize)]
pub struct SkillDiscovery {
    pub skills: Vec<DiscoveredSkill>,
    pub warnings: Vec<String>,
}

/// 按目录名覆盖：项目优先于全局，同级 .agents 优先于 .claude，最后是 .codex。
/// 只解析安装器的目录链接，Skill 内部资源仍禁止符号链接。
/// 单个 Skill 校验失败时返回告警，调用方负责展示；搜索目录本身的错误仍返回失败。
pub fn discover(workspace: Option<&Path>, homedir: Option<&Path>) -> Result<SkillDiscovery> {
    let workspace = workspace.map(Path::canonicalize).transpose()?;
    let mut roots = Vec::new();
    let mut allowed = Vec::new();
    if let Some(workspace) = &workspace {
        allowed.push(workspace.clone());
    }
    for base in [homedir, workspace.as_deref()].into_iter().flatten() {
        // agents > claude > codex；反向选取时保持项目目录优先于用户目录。
        for directory in [".codex/skills", ".claude/skills", ".agents/skills"] {
            let path = base.join(directory);
            match fs::symlink_metadata(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                result => {
                    result
                        .with_context(|| format!("inspect skills directory {}", path.display()))?;
                }
            }
            let root = path
                .canonicalize()
                .with_context(|| format!("resolve skills directory {}", path.display()))?;
            ensure!(
                root.is_dir(),
                "skills root is not a directory: {}",
                path.display()
            );
            if Some(base) == workspace.as_deref() {
                ensure!(
                    root.starts_with(base) || allowed.iter().any(|p| root.starts_with(p)),
                    "project skills directory escaped trusted roots: {}",
                    path.display()
                );
            } else {
                allowed.push(root.clone());
            }
            roots.push(root);
        }
    }
    let mut selected = BTreeMap::new();
    // 先选定最高优先级，避免低优先级副本的旧资源阻止项目覆盖。
    for root in roots.into_iter().rev() {
        let mut entries = fs::read_dir(&root)?
            .take(257)
            .collect::<std::io::Result<Vec<_>>>()?;
        entries.sort_by_key(|e| e.file_name());
        ensure!(
            entries.len() <= 256,
            "skills directory exceeds 256 entries: {}",
            root.display()
        );
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || selected.contains_key(&name) {
                continue;
            }
            let kind = entry.file_type()?;
            if !kind.is_dir() && !kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            let target = (|| -> Result<Option<PathBuf>> {
                let target = path
                    .canonicalize()
                    .with_context(|| format!("resolve skill directory {}", path.display()))?;
                ensure!(
                    allowed.iter().any(|p| target.starts_with(p)),
                    "skill directory escaped trusted roots: {}",
                    path.display()
                );
                if !target.is_dir() {
                    return Ok(None);
                }
                match fs::symlink_metadata(target.join("SKILL.md")) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                    result => {
                        result?;
                    }
                }
                ensure!(
                    !name.is_empty()
                        && name.len() <= 128
                        && name
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric()
                                || matches!(c, b'-' | b'_' | b'.' | b':')),
                    "invalid skill directory name: {name}"
                );
                Ok(Some(target))
            })();
            if matches!(target, Ok(None)) {
                continue;
            }
            // 无效的高优先级目录也占据名称，避免意外启用被覆盖的全局副本。
            selected.insert(name, (path, target));
            ensure!(
                selected.len() <= 128,
                "discovered skills exceed 128 entries"
            );
        }
    }
    let mut discovery = SkillDiscovery::default();
    for (id, (path, target)) in selected {
        let loaded = target.and_then(|root| {
            let root = root.context("skill directory missing")?;
            use rustix::fs::{Mode, OFlags, open};
            let directory = fs::File::from(open(
                &root,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )?);
            let metadata = read_metadata(&directory, &id)
                .with_context(|| format!("read {}", root.join("SKILL.md").display()))?;
            // 版本只标识发现元信息；正文和附件读取当前文件，不作为内容快照。
            let revision = format!(
                "metadata-{:x}",
                Sha256::digest(serde_json::to_vec(&metadata)?)
            );
            Ok(DiscoveredSkill {
                id: id.clone(),
                revision,
                root,
                metadata,
            })
        });
        match loaded {
            Ok(skill) => discovery.skills.push(skill),
            Err(error) => discovery.warnings.push(format!(
                "skipping auto-discovered skill {id} ({}): {error:#}",
                path.display()
            )),
        }
    }
    Ok(discovery)
}

/// 从可信调用方已打开的 Skill 目录读取元信息，不定位用户目录或扫描附件。
pub fn read_metadata(directory: &fs::File, id: &str) -> Result<SkillMetadata> {
    use rustix::fs::{Mode, OFlags, openat};
    let flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK;
    let file = fs::File::from(openat(directory, "SKILL.md", flags, Mode::empty())?);
    ensure!(
        file.metadata()?.is_file(),
        "SKILL.md must be a regular file"
    );
    // 只解析有界文件头；不遍历附件，也不要求正文或整个目录符合内存快照预算。
    let mut reader = BufReader::new(file.take(32 * 1024 + 1));
    let mut header = String::new();
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut consumed = line.len();
    let mut metadata = if line.trim_end() == "---" {
        loop {
            line.clear();
            ensure!(
                reader.read_line(&mut line)? > 0,
                "unterminated skill frontmatter"
            );
            consumed += line.len();
            ensure!(consumed <= 32 * 1024, "skill frontmatter exceeds 32 KiB");
            if matches!(line.trim_end(), "---" | "...") {
                break;
            }
            header.push_str(&line);
        }
        if header.trim().is_empty() {
            SkillMetadata::default()
        } else {
            serde_yaml_ng::from_str::<SkillMetadata>(&header)
                .context("invalid skill frontmatter")?
        }
    } else {
        ensure!(consumed <= 32 * 1024, "skill metadata line exceeds 32 KiB");
        SkillMetadata {
            name: id.into(),
            description: line.trim().into(),
        }
    };
    if metadata.name.trim().is_empty() {
        metadata.name = id.into();
    }
    ensure!(metadata.name.len() <= 256, "skill name exceeds 256 bytes");
    // 超长描述保留前缀，不让展示元信息成为全局 Skill 的兼容性门槛。
    if metadata.description.len() > 4096 {
        let end = metadata.description.floor_char_boundary(4096);
        metadata.description.truncate(end);
    }
    Ok(metadata)
}
