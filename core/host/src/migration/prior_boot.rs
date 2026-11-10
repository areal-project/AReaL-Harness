use super::*;
use areal_protocol::service::{Owner, State};
use std::os::unix::fs::MetadataExt;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Time {
    seconds: i64,
    nanoseconds: i64,
}
impl Time {
    fn valid(&self) -> bool {
        self.seconds > 0 && (0..1_000_000_000).contains(&self.nanoseconds)
    }
    fn before(&self, other: &Self) -> bool {
        (self.seconds, self.nanoseconds) < (other.seconds, other.nanoseconds)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stamp {
    device: u64,
    inode: u64,
    birth_time: Time,
    modified_time: Time,
    changed_time: Time,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Boot {
    session_id: String,
    boot_time: Time,
    observed_at: Time,
}
impl Boot {
    pub(super) fn current() -> Result<Self> {
        #[cfg(test)]
        if let Some(boot) = TEST_BOOT.with(|value| value.borrow().clone()) {
            return Ok(boot);
        }
        Self::kernel()
    }
    #[cfg(target_os = "macos")]
    fn kernel() -> Result<Self> {
        let mut bytes = [0u8; 128];
        let mut length = bytes.len();
        ensure!(
            unsafe {
                libc::sysctlbyname(
                    c"kern.bootsessionuuid".as_ptr(),
                    bytes.as_mut_ptr().cast(),
                    &mut length,
                    std::ptr::null_mut(),
                    0,
                )
            } == 0
                && (2..=bytes.len()).contains(&length),
            "kernel boot identity unavailable"
        );
        let session_id = std::ffi::CStr::from_bytes_with_nul(&bytes[..length])?
            .to_str()?
            .to_owned();
        ensure!(
            !uuid::Uuid::parse_str(&session_id)?.is_nil(),
            "invalid kernel boot identity"
        );
        let mut boot: libc::timeval = unsafe { std::mem::zeroed() };
        let mut length = std::mem::size_of_val(&boot);
        ensure!(
            unsafe {
                libc::sysctlbyname(
                    c"kern.boottime".as_ptr(),
                    (&mut boot as *mut libc::timeval).cast(),
                    &mut length,
                    std::ptr::null_mut(),
                    0,
                )
            } == 0
                && length == std::mem::size_of_val(&boot),
            "kernel boot time unavailable"
        );
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?;
        let boot = Self {
            session_id,
            boot_time: Time {
                seconds: boot.tv_sec,
                nanoseconds: i64::from(boot.tv_usec)
                    .checked_mul(1000)
                    .context("invalid kernel boot time")?,
            },
            observed_at: Time {
                seconds: now.as_secs().try_into()?,
                nanoseconds: now.subsec_nanos().into(),
            },
        };
        ensure!(
            boot.boot_time.valid()
                && boot.observed_at.valid()
                && boot.boot_time.before(&boot.observed_at),
            "untrusted kernel boot time"
        );
        Ok(boot)
    }
    #[cfg(not(target_os = "macos"))]
    fn kernel() -> Result<Self> {
        anyhow::bail!("prior-boot legacy adoption is unavailable on this platform")
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Adoption {
    version: u32,
    reason: String,
    legacy_project_id: String,
    descriptor: PathBuf,
    descriptor_sha256: String,
    file: Stamp,
    boot: Boot,
    service: Service,
    store_tree: Tree,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Tree {
    sha256: String,
    entry_count: usize,
}
#[cfg(target_os = "macos")]
fn stamp(metadata: &std::fs::Metadata) -> Stamp {
    use std::os::macos::fs::MetadataExt as MacMetadataExt;
    Stamp {
        device: metadata.dev(),
        inode: metadata.ino(),
        birth_time: Time {
            seconds: metadata.st_birthtime(),
            nanoseconds: metadata.st_birthtime_nsec(),
        },
        modified_time: Time {
            seconds: metadata.mtime(),
            nanoseconds: metadata.mtime_nsec(),
        },
        changed_time: Time {
            seconds: metadata.ctime(),
            nanoseconds: metadata.ctime_nsec(),
        },
    }
}
#[cfg(not(target_os = "macos"))]
fn stamp(metadata: &std::fs::Metadata) -> Stamp {
    Stamp {
        device: metadata.dev(),
        inode: metadata.ino(),
        birth_time: Time {
            seconds: 0,
            nanoseconds: 0,
        },
        modified_time: Time {
            seconds: metadata.mtime(),
            nanoseconds: metadata.mtime_nsec(),
        },
        changed_time: Time {
            seconds: metadata.ctime(),
            nanoseconds: metadata.ctime_nsec(),
        },
    }
}
fn precedes_boot(stamp: &Stamp, boot: &Boot) -> bool {
    [&stamp.birth_time, &stamp.modified_time, &stamp.changed_time]
        .iter()
        .all(|time| time.valid() && time.before(&boot.boot_time))
        && !stamp.changed_time.before(&stamp.birth_time)
        && !stamp.changed_time.before(&stamp.modified_time)
}
fn tree(data: &Path, boot: &Boot) -> Result<Tree> {
    fn walk(
        root: &Path,
        path: &Path,
        boot: &Boot,
        entries: &mut Vec<(PathBuf, Stamp)>,
    ) -> Result<()> {
        let metadata = std::fs::symlink_metadata(path)?;
        ensure!(
            (metadata.is_dir() || metadata.is_file())
                && metadata.uid() == unsafe { libc::geteuid() }
                && metadata.mode() & 0o022 == 0,
            "legacy Store tree has an untrusted entry"
        );
        let stamp = stamp(&metadata);
        ensure!(
            precedes_boot(&stamp, boot),
            "legacy Store was modified during or after this kernel boot"
        );
        entries.push((path.strip_prefix(root)?.into(), stamp));
        if metadata.is_dir() {
            for entry in std::fs::read_dir(path)? {
                walk(root, &entry?.path(), boot, entries)?;
            }
        }
        Ok(())
    }
    let mut entries = Vec::new();
    walk(data, data, boot, &mut entries)?;
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(Tree {
        sha256: storage::digest(&serde_json::to_vec(&entries)?),
        entry_count: entries.len(),
    })
}
pub(super) fn observe(
    home: &Path,
    record: &Record,
    binding: &Binding,
    directory: &Path,
    expected: &Service,
) -> Result<Adoption> {
    let boot = Boot::current()?;
    ensure!(
        boot.boot_time.valid()
            && boot.observed_at.valid()
            && boot.boot_time.before(&boot.observed_at),
        "untrusted boot observation"
    );
    ensure!(
        matches!(expected.state, State::Stopped | State::Unavailable),
        "legacy service is not stopped or unavailable"
    );
    ensure!(
        expected.identity.protocol_version == 1,
        "unsupported legacy service descriptor"
    );
    ensure!(
        matches!(&expected.owner, Some(Owner::Gui {profile,app_run_id}) if profile == &record.source.profile && uuid::Uuid::parse_str(app_run_id).is_ok()),
        "legacy GUI owner is not exact"
    );
    ensure!(
        record.source.clone().canonical()? == record.source
            && binding.data_dir.canonicalize()? == binding.data_dir
            && directory.canonicalize()? == directory,
        "legacy source path changed"
    );
    let descriptor = directory.join("service.json");
    storage::private_dir(directory)?;
    ensure!(
        descriptor.canonicalize()? == descriptor,
        "legacy descriptor is not canonical"
    );
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&descriptor)?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file()
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.mode() & 0o077 == 0
            && metadata.len() <= 256 * 1024,
        "legacy descriptor permissions or size are invalid"
    );
    let original = stamp(&metadata);
    ensure!(
        precedes_boot(&original, &boot),
        "legacy descriptor does not precede this kernel boot"
    );
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let service: Service = serde_json::from_slice(&bytes)?;
    ensure!(
        serde_json::to_value(&service)? == serde_json::to_value(expected)?,
        "legacy descriptor changed during observation"
    );
    let store_tree = tree(&binding.data_dir, &boot)?;
    for root in [&record.source.legacy_service_home, home] {
        let services = root.join("services");
        if !services.exists() {
            continue;
        }
        ensure!(
            services.canonicalize()? == services,
            "legacy registry is not canonical"
        );
        for entry in std::fs::read_dir(services)? {
            let path = entry?.path().join("service.json");
            if path == descriptor || !path.exists() {
                continue;
            }
            let other: Service = read_optional(&path)?.context("service mapping disappeared")?;
            ensure!(
                other.identity.data_dir != binding.data_dir,
                "another service descriptor maps the legacy Store"
            );
        }
    }
    ensure!(
        stamp(&file.metadata()?) == original
            && stamp(&std::fs::symlink_metadata(&descriptor)?) == original,
        "legacy descriptor was replaced during observation"
    );
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(0))?;
    let mut checked = Vec::new();
    file.read_to_end(&mut checked)?;
    ensure!(
        checked == bytes && tree(&binding.data_dir, &boot)? == store_tree,
        "legacy descriptor or Store changed during observation"
    );
    ensure!(
        stamp(&file.metadata()?) == original
            && stamp(&std::fs::symlink_metadata(&descriptor)?) == original,
        "legacy descriptor changed after Store observation"
    );
    let current = Boot::current()?;
    ensure!(
        current.session_id == boot.session_id
            && current.boot_time == boot.boot_time
            && !current.observed_at.before(&boot.observed_at),
        "kernel boot observation changed"
    );
    Ok(Adoption {
        version: 1,
        reason: "currentProcessLifetimeEnded".into(),
        legacy_project_id: binding.alias.legacy_project_id.clone(),
        descriptor,
        descriptor_sha256: storage::digest(&bytes),
        file: original,
        boot,
        service,
        store_tree,
    })
}
// 新 Host 接管独立于 GUI 导入和旧 cleanup 回执；调用方须持有 start.lock。
pub(crate) fn host_activation(
    home: &Path,
    registration: &ProjectRegistration,
    expected: &Service,
    owner: &Owner,
    publish: impl FnOnce(Value) -> Result<()>,
) -> Result<()> {
    ensure!(
        matches!((&expected.owner, owner),
            (Some(Owner::Host { host_id: old_id, generation: old_generation }),
             Owner::Host { host_id, generation })
            if old_id == host_id && old_generation != generation
                && uuid::Uuid::parse_str(old_generation).is_ok()),
        "prior-boot adoption requires the same Host and a different original generation"
    );
    ensure!(
        expected.identity.protocol_version == 1
            && expected.identity.data_dir == registration.data_dir
            && expected.identity.workspace == registration.workspace
            && expected.identity.service_id
                == storage::digest(registration.data_dir.as_os_str().as_encoded_bytes())[..24]
            && registration.data_dir.canonicalize()? == registration.data_dir
            && registration.workspace.canonicalize()? == registration.workspace,
        "prior-boot project identity changed"
    );
    let directory = storage::registry(home, &expected.identity.service_id)?;
    let descriptor = directory.join("service.json");
    ensure!(
        directory.canonicalize()? == directory && descriptor.canonicalize()? == descriptor,
        "prior-boot descriptor path changed"
    );
    let mut locks = Vec::new();
    for name in ["service.lock", "owner.lock"] {
        let path = registration.data_dir.join(name);
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&path)?;
        let metadata = file.metadata()?;
        ensure!(
            metadata.is_file()
                && metadata.uid() == unsafe { libc::geteuid() }
                && metadata.mode() & 0o022 == 0,
            "untrusted prior-boot lock"
        );
        file.try_lock_exclusive()
            .context("original service or Core still owns its lock")?;
        locks.push((path, file));
    }
    let observe = || -> Result<Value> {
        let boot = Boot::current()?;
        ensure!(
            boot.boot_time.valid()
                && boot.observed_at.valid()
                && boot.boot_time.before(&boot.observed_at),
            "untrusted boot observation"
        );
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&descriptor)?;
        let metadata = file.metadata()?;
        ensure!(
            metadata.is_file()
                && metadata.uid() == unsafe { libc::geteuid() }
                && metadata.mode() & 0o077 == 0
                && metadata.len() <= 256 * 1024,
            "untrusted prior-boot descriptor"
        );
        let original = stamp(&metadata);
        ensure!(
            precedes_boot(&original, &boot),
            "service descriptor changed during this kernel boot"
        );
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        let service: Service = serde_json::from_slice(&bytes)?;
        ensure!(
            serde_json::to_value(&service)? == serde_json::to_value(expected)?,
            "original service descriptor changed"
        );
        for entry in std::fs::read_dir(home.join("services"))? {
            let path = entry?.path().join("service.json");
            if path == descriptor || !path.exists() {
                continue;
            }
            let other: Service = storage::read(&path)?;
            ensure!(
                other.identity.data_dir != registration.data_dir,
                "another service maps this Store"
            );
        }
        let store_tree = tree(&registration.data_dir, &boot)?;
        for (path, file) in &locks {
            ensure!(
                stamp(&file.metadata()?) == stamp(&std::fs::symlink_metadata(path)?),
                "prior-boot lock was replaced"
            );
        }
        ensure!(
            stamp(&file.metadata()?) == original
                && stamp(&std::fs::symlink_metadata(&descriptor)?) == original,
            "prior-boot descriptor changed during observation"
        );
        Ok(
            json!({"version":1,"reason":"currentProcessLifetimeEnded","projectId":registration.project_id,
            "descriptor":descriptor,"descriptorSha256":storage::digest(&bytes),"file":original,
            "bootSessionId":boot.session_id,"bootTime":boot.boot_time,
            "service":service,"storeTree":store_tree,"newOwner":owner}),
        )
    };
    let proof = observe()?;
    ensure!(
        observe()? == proof,
        "prior-boot evidence changed before publication"
    );
    publish(proof.clone())?;
    ensure!(
        observe()? == proof,
        "prior-boot evidence changed before activation"
    );
    Ok(())
}

pub(super) fn revalidate(home: &Path, record: &Record, adoption: &Adoption) -> Result<()> {
    let binding = record
        .bindings
        .iter()
        .find(|binding| binding.alias.legacy_project_id == adoption.legacy_project_id)
        .context("prior-boot binding disappeared")?;
    let current = observe(
        home,
        record,
        binding,
        adoption
            .descriptor
            .parent()
            .context("prior-boot descriptor path missing")?,
        &adoption.service,
    )?;
    ensure!(
        current.descriptor == adoption.descriptor
            && current.descriptor_sha256 == adoption.descriptor_sha256
            && current.file == adoption.file
            && current.store_tree == adoption.store_tree
            && current.boot.session_id == adoption.boot.session_id
            && current.boot.boot_time == adoption.boot.boot_time
            && !current.boot.observed_at.before(&adoption.boot.observed_at),
        "prior-boot adoption evidence changed before publication"
    );
    Ok(())
}

#[cfg(test)]
thread_local! { static TEST_BOOT:RefCell<Option<Boot>> = const { RefCell::new(None) }; }
#[cfg(test)]
pub(crate) fn with_test_boot<T>(offset_seconds: i64, run: impl FnOnce() -> T) -> T {
    struct Reset(Option<Boot>);
    impl Drop for Reset {
        fn drop(&mut self) {
            TEST_BOOT.with(|value| *value.borrow_mut() = self.0.take());
        }
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let boot = Boot {
        session_id: uuid::Uuid::new_v4().to_string(),
        boot_time: Time {
            seconds: now + offset_seconds,
            nanoseconds: 0,
        },
        observed_at: Time {
            seconds: now + offset_seconds.max(0) + 1,
            nanoseconds: 0,
        },
    };
    let _reset = Reset(TEST_BOOT.with(|value| value.replace(Some(boot))));
    run()
}
#[cfg(test)]
pub(super) fn test_tree_digest(data: &Path) -> Result<String> {
    Ok(tree(data, &Boot::current()?)?.sha256)
}

#[cfg(all(test, target_os = "macos"))]
mod host_tests {
    use super::*;

    fn fixture(root: &Path) -> (ProjectRegistration, Service, Owner) {
        let home = root.join("home");
        let workspace = root.join("workspace");
        let data = home.join("data");
        for path in [&home, &workspace, &data] {
            storage::private_dir(path).unwrap();
        }
        for name in ["service.lock", "owner.lock"] {
            storage::open_private(&data.join(name), true).unwrap();
        }
        let registration = ProjectRegistration {
            project_id: "project".into(),
            workspace,
            data_dir: data,
            source: ProjectSource::Cli,
            default_binding: false,
        };
        let service_id =
            storage::digest(registration.data_dir.as_os_str().as_encoded_bytes())[..24].to_owned();
        let directory = storage::registry(&home, &service_id).unwrap();
        storage::private_dir(&directory).unwrap();
        let host_id = uuid::Uuid::new_v4().to_string();
        let owner = Owner::Host {
            host_id: host_id.clone(),
            generation: uuid::Uuid::new_v4().to_string(),
        };
        let service: Service =
            serde_json::from_value(json!({"protocolVersion":1,"serviceId":service_id,
            "generation":uuid::Uuid::new_v4().to_string(),"workspace":registration.workspace,
            "dataDir":registration.data_dir,"configFingerprint":"old",
            "owner":{"kind":"host","hostId":host_id,"generation":uuid::Uuid::new_v4().to_string()},
            "endpoint":"http://127.0.0.1:1","webUrl":"http://127.0.0.1:1",
            "authFile":directory.join("auth.json"),"logFile":directory.join("host.log"),
            "hostPid":500000000,"corePid":500000001,"state":"ready"}))
            .unwrap();
        storage::write(&directory.join("service.json"), &service).unwrap();
        (registration, service, owner)
    }

    #[test]
    fn prior_boot_host_proof_rejects_locked_changed_or_foreign_resources() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let (registration, service, owner) = fixture(&root);
        let home = root.join("home");
        with_test_boot(-10, || {
            assert!(
                host_activation(&home, &registration, &service, &owner, |_| panic!(
                    "published current-boot state"
                ))
                .is_err()
            )
        });
        with_test_boot(10, || {
            for name in ["service.lock", "owner.lock"] {
                let lock = storage::open_private(&registration.data_dir.join(name), false).unwrap();
                lock.try_lock_exclusive().unwrap();
                assert!(
                    host_activation(&home, &registration, &service, &owner, |_| panic!(
                        "published held lock"
                    ))
                    .is_err()
                );
            }
            let foreign = Owner::Host {
                host_id: uuid::Uuid::new_v4().to_string(),
                generation: uuid::Uuid::new_v4().to_string(),
            };
            assert!(
                host_activation(&home, &registration, &service, &foreign, |_| panic!(
                    "published foreign owner"
                ))
                .is_err()
            );
            let result = host_activation(&home, &registration, &service, &owner, |proof| {
                assert_eq!(proof["newOwner"], serde_json::to_value(&owner).unwrap());
                assert!(proof.get("cleanupConfirmed").is_none());
                for name in ["service.lock", "owner.lock"] {
                    assert!(!storage::available(&registration.data_dir.join(name))?);
                }
                std::fs::write(registration.data_dir.join("changed"), "new")?;
                Ok(())
            });
            assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("changed before activation")
            );
        });
        let directory = storage::registry(&home, &service.identity.service_id).unwrap();
        assert_eq!(
            storage::read::<Value>(&directory.join("service.json")).unwrap(),
            serde_json::to_value(&service).unwrap()
        );
        assert!(!directory.join("cleanup.json").exists());
    }
}
