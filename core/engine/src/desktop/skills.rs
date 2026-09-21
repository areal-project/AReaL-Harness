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
    directory: Arc<File>,
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
            Ok((metadata, Arc::new(directory)))
        })()
        .with_context(|| format!("load skill {} ({})", location.id, location.root.display()))?;
        Ok(Self {
            location,
            metadata: result.0,
            directory: result.1,
        })
    }

    pub async fn read(
        &self,
        resource: &str,
        offset: usize,
        max_bytes: usize,
    ) -> anyhow::Result<SkillPage> {
        let directory = self.directory.clone();
        let resource = resource.to_owned();
        // 不在 Tokio 执行线程上做磁盘读取，也不跨 I/O 持有全局目录锁。
        tokio::task::spawn_blocking(move || read_resource(directory, &resource, offset, max_bytes))
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
