use super::*;
use anyhow::ensure;
pub use areal_config::skills::SkillMetadata;
use rustix::fs::{Mode, OFlags, open, openat};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Component, PathBuf},
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillLocation {
    pub id: String,
    pub revision: String,
    pub root: PathBuf,
    /// 可信启动器可注入已解析的元信息；省略时只读取 SKILL.md 文件头。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<SkillMetadata>,
}

#[derive(Clone)]
pub(super) struct Skill {
    pub location: SkillLocation,
    pub metadata: SkillMetadata,
    pub plugin: Option<areal_plugins::InstalledSkill>,
    package_directory: Option<Arc<File>>,
    package_prefix: PathBuf,
}

pub(super) struct SkillPage {
    pub bytes: Vec<u8>,
    pub size: usize,
}

const READ_FLAGS: OFlags = OFlags::RDONLY
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC)
    .union(OFlags::NONBLOCK);

impl Skill {
    pub fn load(mut location: SkillLocation, base: &Path) -> anyhow::Result<Self> {
        let result = (|| {
            ensure!(
                valid_id(&location.id) && valid_id(&location.revision),
                "invalid skill identity"
            );
            location.root = base.join(&location.root).canonicalize()?;
            let directory = File::from(open(
                &location.root,
                READ_FLAGS | OFlags::DIRECTORY,
                Mode::empty(),
            )?);
            let metadata = match location.metadata.take() {
                Some(metadata) => metadata,
                None => areal_config::skills::read_metadata(&directory, &location.id)?,
            };
            ensure!(
                !metadata.name.is_empty()
                    && metadata.name.len() <= 256
                    && metadata.description.len() <= 4096,
                "invalid skill metadata"
            );
            Ok(metadata)
        })()
        .with_context(|| format!("load skill {} ({})", location.id, location.root.display()))?;
        Ok(Self {
            location,
            metadata: result,
            plugin: None,
            package_directory: None,
            package_prefix: PathBuf::new(),
        })
    }

    pub fn load_plugin(info: areal_plugins::InstalledSkill) -> anyhow::Result<Self> {
        let mut skill = Self::load(
            SkillLocation {
                id: info.id.clone(),
                revision: info.revision.clone(),
                root: info.root.clone(),
                metadata: Some(SkillMetadata {
                    name: info.name.clone(),
                    description: info.description.clone(),
                }),
            },
            Path::new("/"),
        )?;
        skill.package_prefix = info.root.strip_prefix(&info.package_root)?.to_path_buf();
        skill.package_directory = Some(Arc::new(File::from(open(
            &info.package_root,
            READ_FLAGS | OFlags::DIRECTORY,
            Mode::empty(),
        )?)));
        skill.plugin = Some(info);
        Ok(skill)
    }

    pub async fn read(
        &self,
        resource: &str,
        offset: usize,
        max_bytes: usize,
    ) -> anyhow::Result<SkillPage> {
        let resource = if self.package_directory.is_some() {
            let mut path = self.package_prefix.clone();
            for part in Path::new(resource).components() {
                match part {
                    Component::Normal(p) => path.push(p),
                    Component::CurDir => {}
                    Component::ParentDir => ensure!(path.pop(), "plugin resource escapes package"),
                    _ => anyhow::bail!("plugin resource must be relative"),
                }
            }
            path.to_string_lossy().into_owned()
        } else {
            resource.to_owned()
        };
        let package_directory = self.package_directory.clone();
        let root = self.location.root.clone();
        // 不在 Tokio 执行线程上做磁盘读取，也不跨 I/O 持有全局目录锁。
        tokio::task::spawn_blocking(move || {
            let directory = match package_directory {
                Some(directory) => directory,
                None => {
                    #[cfg(target_os = "macos")]
                    let access = OFlags::from_bits_retain(libc::O_SEARCH as u32);
                    #[cfg(target_os = "linux")]
                    let access = OFlags::PATH;
                    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
                    let access = READ_FLAGS;
                    let flags = access | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
                    let mut directory = File::from(open("/", flags, Mode::empty())?);
                    // 规范根的祖先也可能被更新替换，逐段重开同时拒绝新增的目录链接。
                    for component in root.components().skip(1) {
                        directory = File::from(openat(
                            &directory,
                            component.as_os_str(),
                            flags,
                            Mode::empty(),
                        )?);
                    }
                    Arc::new(directory)
                }
            };
            read_resource(directory, &resource, offset, max_bytes)
        })
        .await?
    }
}

fn read_resource(
    root: Arc<File>,
    resource: &str,
    offset: usize,
    max_bytes: usize,
) -> anyhow::Result<SkillPage> {
    let result = (|| {
        let components: Vec<_> = Path::new(resource).components().collect();
        ensure!(
            !components.is_empty() && components.iter().all(|c| matches!(c, Component::Normal(_))),
            "skill resource must be a relative path without parent components"
        );
        // 逐段从已打开的 Skill 根解析；拒绝文件和中间目录链接，避免检查与读取之间被替换越界。
        let mut directory = root;
        for component in &components[..components.len() - 1] {
            directory = Arc::new(File::from(openat(
                directory.as_ref(),
                component.as_os_str(),
                READ_FLAGS | OFlags::DIRECTORY,
                Mode::empty(),
            )?));
        }
        let mut file = File::from(openat(
            directory.as_ref(),
            components.last().unwrap().as_os_str(),
            READ_FLAGS,
            Mode::empty(),
        )?);
        let metadata = file.metadata()?;
        ensure!(metadata.is_file(), "skill resource must be a regular file");
        let size = usize::try_from(metadata.len())?;
        ensure!(offset <= size, "offset exceeds resource size");
        file.seek(SeekFrom::Start(offset as u64))?;
        let mut bytes = Vec::new();
        file.take(max_bytes.min(size - offset) as u64)
            .read_to_end(&mut bytes)?;
        Ok(SkillPage { bytes, size })
    })();
    result.with_context(|| format!("read skill resource {resource}"))
}

#[derive(Clone)]
pub(super) struct Discovery {
    workspace: PathBuf,
    home: Option<PathBuf>,
    signature: String,
}
impl Engine {
    pub fn install_discovered_skill_sources(
        self: &Arc<Self>,
        workspace: PathBuf,
        home: Option<PathBuf>,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            workspace.is_absolute() && home.as_ref().is_none_or(|p| p.is_absolute()),
            "skill discovery requires trusted absolute paths"
        );
        let locations = Self::discover_skill_locations(&workspace, home.as_deref())?;
        let signature = digest(&locations)?;
        self.install_default_skills(locations)?;
        *self.desktop.discovered_skills.lock().unwrap() = Some(Discovery {
            workspace,
            home,
            signature,
        });
        self.watch_plugin_state();
        Ok(())
    }
    fn discover_skill_locations(
        workspace: &Path,
        home: Option<&Path>,
    ) -> anyhow::Result<Vec<SkillLocation>> {
        let discovered = areal_config::skills::discover(Some(workspace), home)?;
        for warning in discovered.warnings {
            tracing::warn!(%warning, "skill discovery warning");
        }
        Ok(discovered
            .skills
            .into_iter()
            .map(|skill| SkillLocation {
                id: skill.id,
                revision: skill.revision,
                root: skill.root,
                metadata: Some(skill.metadata),
            })
            .collect())
    }
    pub(super) async fn refresh_discovered_skills(self: &Arc<Self>) -> Result<()> {
        let Some(source) = self.desktop.discovered_skills.lock().unwrap().clone() else {
            return Ok(());
        };
        let _catalog = self.desktop.catalog_write.lock().await;
        let engine = self.clone();
        tokio::task::spawn_blocking(move || {
            let locations =
                Self::discover_skill_locations(&source.workspace, source.home.as_deref())?;
            let signature = digest(&locations)?;
            if signature != source.signature {
                engine.install_default_skills(locations)?;
                if let Some(current) = engine.desktop.discovered_skills.lock().unwrap().as_mut() {
                    current.signature = signature;
                }
            }
            Ok::<_, anyhow::Error>(())
        })
        .await
        .map_err(invalid)?
        .map_err(invalid)
    }
}
