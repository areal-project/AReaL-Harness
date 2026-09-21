use areal_runtime_protocol::{Error, ErrorCode, LimitRequest, Limits, Result};
use std::path::{Component, Path, PathBuf};

pub(crate) struct Workspace {
    pub root: PathBuf,
    identity: Directory,
    scratch: Option<(PathBuf, Directory)>,
}

/// 拒绝已观察到的目录替换。OS 路径权限另由执行后端强制执行；这里不承诺目录对象隔离。
pub(crate) struct Directory {
    path: PathBuf,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}
impl Directory {
    pub fn bind(path: &Path) -> Result<Self> {
        let canonical = path
            .canonicalize()
            .map_err(|_| denied("authorization directory is missing"))?;
        if canonical != path {
            return Err(denied("authorization directory was redirected"));
        }
        let metadata = std::fs::symlink_metadata(path)
            .map_err(|_| denied("authorization directory is missing"))?;
        if !metadata.is_dir() {
            return Err(denied("authorization root is no longer a directory"));
        }
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Ok(Self {
            path: path.into(),
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
        })
    }
    pub fn validate(&self) -> Result<()> {
        let current = Self::bind(&self.path)?;
        #[cfg(unix)]
        if current.device != self.device || current.inode != self.inode {
            return Err(denied(
                "authorization directory identity changed; create a new scope",
            ));
        }
        #[cfg(not(unix))]
        let _ = current;
        Ok(())
    }
}
impl Workspace {
    pub fn new(root: &Path) -> Result<Self> {
        let root = root
            .canonicalize()
            .map_err(|_| invalid("workspace must exist"))?;
        if !root.is_dir() {
            return Err(invalid("workspace must be a directory"));
        }
        let identity = Directory::bind(&root)?;
        Ok(Self {
            root,
            identity,
            scratch: None,
        })
    }
    pub fn set_scratch(&mut self, path: &Path) -> Result<()> {
        let root = path
            .canonicalize()
            .map_err(|_| invalid("scratch must exist"))?;
        if root.starts_with(&self.root) || self.root.starts_with(&root) {
            return Err(invalid(
                "scratch and workspace must be disjoint directories",
            ));
        }
        let identity = Directory::bind(&root)?;
        self.scratch = Some((root, identity));
        Ok(())
    }
    pub fn scratch_root(&self) -> Option<&PathBuf> {
        self.scratch.as_ref().map(|(root, _)| root)
    }
    pub fn validate(&self) -> Result<()> {
        self.identity.validate()?;
        if let Some((_, identity)) = &self.scratch {
            identity.validate()?;
        }
        Ok(())
    }
    pub fn resolve(&self, uri: &str) -> Result<PathBuf> {
        let (root, relative) = self.relative(uri)?;
        let path = root
            .join(relative)
            .canonicalize()
            .map_err(|_| Error::new(ErrorCode::NotFound, "workspace path does not exist"))?;
        if !path.starts_with(root) {
            return Err(denied("resolved path escapes the configured workspace"));
        }
        if !path.is_dir() {
            return Err(invalid("scope roots and cwd must be directories"));
        }
        Ok(path)
    }
    pub fn file_path(&self, uri: &str) -> Result<PathBuf> {
        let (root, relative) = self.relative(uri)?;
        Ok(root.join(relative))
    }
    fn relative<'a>(&self, uri: &'a str) -> Result<(&Path, &'a Path)> {
        let (root, namespace) =
            if uri == "workspace://scratch" || uri.starts_with("workspace://scratch/") {
                (
                    self.scratch_root()
                        .ok_or_else(|| denied("scratch is not configured"))?,
                    "workspace://scratch",
                )
            } else {
                (&self.root, "workspace://repo")
            };
        let suffix = uri
            .strip_prefix(namespace)
            .filter(|s| s.is_empty() || s.starts_with('/'))
            .ok_or_else(|| invalid("expected workspace://repo[/path]"))?;
        // v0 使用未编码的工作区路径；不允许 URL 解析器归一化掉越界证据。
        if suffix.contains(['%', '?', '#', '\\', '\0']) || suffix.len() > 4096 {
            return Err(invalid("unsupported workspace path encoding"));
        }
        let relative = Path::new(suffix.trim_start_matches('/'));
        if suffix.split('/').any(|part| part == "." || part == "..")
            || relative
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err(invalid(
                "workspace paths cannot contain dot or parent components",
            ));
        }
        Ok((root, relative))
    }
    pub fn uri(&self, path: &Path) -> String {
        if let Some(root) = self.scratch_root()
            && let Ok(relative) = path.strip_prefix(root)
        {
            return if relative.as_os_str().is_empty() {
                "workspace://scratch".into()
            } else {
                format!("workspace://scratch/{}", relative.display())
            };
        }
        let relative = path
            .strip_prefix(&self.root)
            .expect("validated workspace path");
        if relative.as_os_str().is_empty() {
            "workspace://repo".into()
        } else {
            format!("workspace://repo/{}", relative.display())
        }
    }
    pub fn roots(
        &self,
        requested: &Option<Vec<String>>,
        parent: &[PathBuf],
    ) -> Result<Vec<PathBuf>> {
        let Some(requested) = requested else {
            return Ok(parent.to_vec());
        };
        if requested.len() > 16 {
            return Err(invalid("at most 16 permission roots"));
        }
        let mut roots = Vec::new();
        for uri in requested {
            let path = self.resolve(uri)?;
            if !within(&path, parent) {
                return Err(denied("child permissions exceed parent permissions"));
            }
            if !roots.contains(&path) {
                roots.push(path);
            }
        }
        roots.sort();
        Ok(roots)
    }
}
pub(crate) fn within(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| path.starts_with(root))
}
pub(crate) fn narrow(parent: &Limits, request: &LimitRequest) -> Result<Limits> {
    let limits = Limits {
        wall_time_ms: request.wall_time_ms.unwrap_or(parent.wall_time_ms),
        output_bytes: request.output_bytes.unwrap_or(parent.output_bytes),
        max_processes: request.max_processes.unwrap_or(parent.max_processes),
    };
    if limits.wall_time_ms == 0
        || limits.wall_time_ms > parent.wall_time_ms
        || limits.output_bytes > parent.output_bytes
        || limits.max_processes > parent.max_processes
    {
        return Err(denied(
            "limits may only narrow the parent limits; wallTimeMs must be positive",
        ));
    }
    Ok(limits)
}
pub(crate) fn invalid(message: &str) -> Error {
    Error::new(ErrorCode::InvalidArgument, message)
}
pub(crate) fn denied(message: &str) -> Error {
    Error::new(ErrorCode::PermissionDenied, message)
}

#[cfg(test)]
mod scratch_tests {
    use super::*;
    #[test]
    fn scratch_is_explicit_disjoint_and_rejects_traversal() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        let scratch = temp.path().join("scratch");
        std::fs::create_dir(&repo).unwrap();
        std::fs::create_dir(&scratch).unwrap();
        let mut w = Workspace::new(&repo).unwrap();
        assert!(w.resolve("workspace://scratch").is_err());
        assert!(w.set_scratch(temp.path()).is_err());
        assert!(w.set_scratch(&repo).is_err());
        w.set_scratch(&scratch).unwrap();
        std::fs::write(scratch.join("log.txt"), "fixture").unwrap();
        assert_eq!(
            w.file_path("workspace://scratch/log.txt").unwrap(),
            scratch.canonicalize().unwrap().join("log.txt")
        );
        assert!(w.resolve("workspace://scratch/../repo/file").is_err());
        assert_eq!(
            w.uri(&scratch.canonicalize().unwrap()),
            "workspace://scratch"
        );
        let old = temp.path().join("old-scratch");
        std::fs::rename(&scratch, &old).unwrap();
        std::fs::create_dir(&scratch).unwrap();
        assert!(w.validate().is_err());
    }
}
