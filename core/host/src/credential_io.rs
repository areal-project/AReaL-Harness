//! 系统凭据调用在同一可执行文件的独立进程中执行；事务与回执仍由 Host 持有。
use crate::wire::error;
use anyhow::{Result, ensure};
use areal_local_service::storage;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::File,
    io::{Read, Write},
    os::unix::{ffi::OsStringExt, fs::MetadataExt},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{net::UnixStream, process::CommandExt},
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
};
use subtle::ConstantTimeEq;

#[derive(Serialize, Deserialize)]
#[serde(tag = "operation", deny_unknown_fields)]
pub(crate) enum Request {
    Read {
        entry: String,
        interaction_allowed: bool,
    },
    Write {
        entry: String,
        value: Value,
    },
    #[cfg(test)]
    Hold,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Authority {
    host_id: String,
    generation: String,
    token: String,
}
impl Authority {
    pub(crate) fn new(identity: &crate::HostIdentity, token: &str) -> Self {
        Self {
            host_id: identity.host_id.clone(),
            generation: identity.generation.clone(),
            token: token.into(),
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Invocation {
    authority: Authority,
    request: Request,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    status: i32,
    value: Option<Value>,
}

fn send(channel: &mut UnixStream, value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    ensure!(
        bytes.len() <= crate::wire::MAX_FRAME,
        "credential frame exceeds limit"
    );
    channel.write_all(&(bytes.len() as u32).to_be_bytes())?;
    channel.write_all(&bytes)?;
    Ok(())
}
fn receive<T: serde::de::DeserializeOwned>(channel: &mut UnixStream) -> Result<T> {
    let mut length = [0; 4];
    channel.read_exact(&mut length)?;
    let length = u32::from_be_bytes(length) as usize;
    ensure!(
        length <= crate::wire::MAX_FRAME,
        "credential frame exceeds limit"
    );
    let mut bytes = vec![0; length];
    channel.read_exact(&mut bytes)?;
    // 解码错误不附带输入，避免秘密进入诊断。
    serde_json::from_slice(&bytes)
        .map_err(|_| error("storageLocked", "invalid credential helper response"))
}
fn spawn(owner: Option<&File>) -> Result<(Child, UnixStream)> {
    let (parent, child) = UnixStream::pair()?;
    let channel_fd = child.as_raw_fd();
    let owner_fd = owner.map(AsRawFd::as_raw_fd).unwrap_or(-1);
    let mut command = Command::new(std::env::current_exe()?);
    #[cfg(not(test))]
    command.args([
        "host",
        "credential-io",
        "--channel-fd",
        &channel_fd.to_string(),
        "--owner-fd",
        &owner_fd.to_string(),
    ]);
    #[cfg(test)]
    command
        .args([
            "--exact",
            "credential_io::tests::helper_entry",
            "--ignored",
            "--nocapture",
        ])
        .env("AREAL_TEST_CREDENTIAL_CHANNEL", channel_fd.to_string())
        .env("AREAL_TEST_CREDENTIAL_OWNER", owner_fd.to_string());
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // 仅在 fork 后的子进程取消这两个 fd 的 CLOEXEC；父进程标志不变。
    unsafe {
        command.pre_exec(move || {
            for fd in [channel_fd, owner_fd].into_iter().filter(|fd| *fd >= 0) {
                let flags = libc::fcntl(fd, libc::F_GETFD);
                if flags < 0 || libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    let process = command.spawn()?;
    drop(child);
    Ok((process, parent))
}

pub(crate) fn execute(
    owner: Option<&File>,
    authority: Option<&Authority>,
    request: Request,
) -> Result<Option<Value>> {
    let owner =
        owner.ok_or_else(|| error("storageLocked", "credential access requires the Host owner"))?;
    let authority = authority.ok_or_else(|| {
        error(
            "storageLocked",
            "credential access requires Host authentication",
        )
    })?;
    let (mut child, mut channel) = spawn(Some(owner))?;
    let response = send(
        &mut channel,
        &Invocation {
            authority: authority.clone(),
            request,
        },
    )
    .and_then(|()| receive::<Reply>(&mut channel));
    // 连接丢失也要等原子进程结束，不能超时杀死、放锁或重放写入。
    drop(channel);
    let exited = child.wait()?;
    ensure!(
        exited.success(),
        error("storageLocked", "credential helper exited without a result")
    );
    let response =
        response.map_err(|_| error("storageLocked", "credential helper result is unavailable"))?;
    match response.status {
        0 => Ok(response.value),
        -25300 => Ok(None),
        _ => Err(error("storageLocked", "Host Keychain access failed")),
    }
}

fn authenticate(channel: &UnixStream, owner: &File, authority: &Authority) -> Result<PathBuf> {
    let mut uid = 0;
    let mut gid = 0;
    ensure!(
        unsafe { libc::getpeereid(channel.as_raw_fd(), &mut uid, &mut gid) } == 0
            && uid == unsafe { libc::geteuid() },
        "invalid credential helper peer"
    );
    let mut peer = 0i32;
    let mut length = std::mem::size_of::<i32>() as libc::socklen_t;
    ensure!(
        unsafe {
            libc::getsockopt(
                channel.as_raw_fd(),
                libc::SOL_LOCAL,
                libc::LOCAL_PEERPID,
                (&mut peer as *mut i32).cast(),
                &mut length,
            )
        } == 0,
        "credential helper peer identity unavailable"
    );
    let mut path = [0u8; libc::PATH_MAX as usize];
    ensure!(
        unsafe { libc::fcntl(owner.as_raw_fd(), libc::F_GETPATH, path.as_mut_ptr()) } == 0,
        "credential owner path unavailable"
    );
    let end = path
        .iter()
        .position(|byte| *byte == 0)
        .ok_or_else(|| error("storageLocked", "invalid credential owner path"))?;
    let path = PathBuf::from(std::ffi::OsString::from_vec(path[..end].to_vec()));
    ensure!(
        path.file_name().is_some_and(|name| name == "host.lock"),
        "credential owner is not a Host lock"
    );
    let home = path
        .parent()
        .ok_or_else(|| error("storageLocked", "missing credential owner home"))?
        .to_owned();
    ensure!(
        home.canonicalize()? == home,
        "credential owner home is not canonical"
    );
    for directory in [&home, &home.join("host")] {
        let meta = std::fs::symlink_metadata(directory)?;
        ensure!(
            meta.is_dir() && meta.uid() == uid && meta.mode() & 0o077 == 0,
            "invalid credential owner directory"
        );
    }
    let named = storage::open_private(&path, false)?;
    let original = owner.metadata()?;
    let current = named.metadata()?;
    ensure!(
        original.is_file()
            && original.uid() == uid
            && original.mode() & 0o077 == 0
            && original.dev() == current.dev()
            && original.ino() == current.ino(),
        "credential owner file identity changed"
    );
    // 原锁已被持有，且此 fd 必须共享那一 open-file description；仅打开相同路径不够。
    ensure!(
        named
            .try_lock_exclusive()
            .is_err_and(|cause| cause.kind() == std::io::ErrorKind::WouldBlock),
        "credential owner is not locked"
    );
    owner.try_lock_exclusive().map_err(|_| {
        error(
            "storageLocked",
            "credential owner is not the inherited lock",
        )
    })?;
    let identity: crate::HostIdentity = storage::read(&home.join("host/host.json"))?;
    ensure!(
        identity.version == crate::VERSION
            && identity.pid == peer as u32
            && identity.host_id == authority.host_id
            && identity.generation == authority.generation
            && identity.auth_file == home.join("host/auth.json"),
        "credential Host identity changed"
    );
    let expected: String = storage::read(&identity.auth_file)?;
    ensure!(
        bool::from(expected.as_bytes().ct_eq(authority.token.as_bytes())),
        "credential Host authentication failed"
    );
    let mut executable = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    ensure!(
        unsafe {
            libc::proc_pidpath(
                peer,
                executable.as_mut_ptr().cast(),
                executable.len() as u32,
            )
        } > 0,
        "credential Host executable unavailable"
    );
    let end = executable
        .iter()
        .position(|byte| *byte == 0)
        .ok_or_else(|| error("storageLocked", "invalid Host executable"))?;
    ensure!(
        PathBuf::from(std::ffi::OsString::from_vec(executable[..end].to_vec())).canonicalize()?
            == std::env::current_exe()?.canonicalize()?,
        "credential helper peer is not the Host executable"
    );
    Ok(home)
}

fn entry_is_owned(home: &Path, entry: &str) -> Result<bool> {
    crate::wire::request_id(entry)?;
    for directory in [
        "vault-operations",
        "vault-slots",
        "remote-operations",
        "imports",
    ] {
        let root = home.join("host").join(directory);
        let meta = match std::fs::symlink_metadata(&root) {
            Ok(meta) => meta,
            Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => continue,
            Err(cause) => return Err(cause.into()),
        };
        ensure!(
            meta.is_dir() && meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o077 == 0,
            "invalid credential evidence directory"
        );
        for candidate in std::fs::read_dir(&root)? {
            let candidate = candidate?;
            let path = if directory == "imports" {
                let meta = candidate.file_type()?;
                ensure!(!meta.is_symlink(), "invalid credential evidence link");
                if !meta.is_dir() {
                    continue;
                }
                candidate.path().join("record.json")
            } else {
                if candidate
                    .path()
                    .extension()
                    .is_none_or(|extension| extension != "json")
                {
                    continue;
                }
                candidate.path()
            };
            let Some(record) = storage::read_json::<Value>(&path)? else {
                continue;
            };
            let owned = if directory == "imports" {
                record["vaultReceipts"].as_array().is_some_and(|receipts| {
                    receipts.iter().any(|receipt| receipt["entryId"] == entry)
                })
            } else {
                record["entryId"] == entry
            };
            if owned {
                return Ok(true);
            }
        }
    }
    Ok(
        storage::read_json::<Value>(&home.join("host/remote-state.json"))?
            .is_some_and(|state| state["entryId"] == entry),
    )
}

/// 内部 CLI 入口；继承描述符、Host 认证和持久 entry 证据共同限制凭据访问。
pub fn run(channel_fd: i32, owner_fd: i32) -> Result<()> {
    ensure!(
        channel_fd > 2 && owner_fd > 2 && owner_fd != channel_fd,
        "invalid credential helper descriptors"
    );
    let mut kind = 0i32;
    let mut length = std::mem::size_of::<i32>() as libc::socklen_t;
    ensure!(
        unsafe {
            libc::getsockopt(
                channel_fd,
                libc::SOL_SOCKET,
                libc::SO_TYPE,
                (&mut kind as *mut i32).cast(),
                &mut length,
            )
        } == 0
            && kind == libc::SOCK_STREAM,
        "credential helper requires a private socket"
    );
    let mut channel = unsafe { UnixStream::from_raw_fd(channel_fd) };
    // 继承原 open-file description；不能重新打开或显式 unlock，否则会提前解除共享锁。
    let owner = unsafe { File::from_raw_fd(owner_fd) };
    let invocation: Invocation = receive(&mut channel)?;
    let home = authenticate(&channel, &owner, &invocation.authority)?;
    let service = format!(
        "org.areal.host.v1.{}",
        storage::digest(home.as_os_str().as_encoded_bytes())
    );
    match &invocation.request {
        Request::Read { entry, .. } | Request::Write { entry, .. } => ensure!(
            entry_is_owned(&home, entry)?,
            "credential entry has no Host admission evidence"
        ),
        #[cfg(test)]
        Request::Hold => {}
    }
    let request = invocation.request;
    let response = match request {
        Request::Read {
            entry,
            interaction_allowed,
        } => {
            let _interaction = if interaction_allowed {
                None
            } else {
                Some(
                    security_framework::os::macos::keychain::SecKeychain::disable_user_interaction(
                    )?,
                )
            };
            match security_framework::passwords::get_generic_password(&service, &entry) {
                Ok(bytes) => Reply {
                    status: 0,
                    value: Some(
                        serde_json::from_slice(&bytes)
                            .map_err(|_| error("storageLocked", "invalid stored credential"))?,
                    ),
                },
                Err(cause) => Reply {
                    status: cause.code(),
                    value: None,
                },
            }
        }
        Request::Write { entry, value } => {
            let bytes = serde_json::to_vec(&value)?;
            let status =
                security_framework::passwords::set_generic_password(&service, &entry, &bytes)
                    .map_or_else(|cause| cause.code(), |()| 0);
            Reply {
                status,
                value: None,
            }
        }
        #[cfg(test)]
        Request::Hold => {
            send(
                &mut channel,
                &Reply {
                    status: 0,
                    value: None,
                },
            )?;
            let _: Value = receive(&mut channel)?;
            Reply {
                status: 0,
                value: None,
            }
        }
    };
    send(&mut channel, &response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fs2::FileExt;

    struct Fixture {
        root: tempfile::TempDir,
        owner: File,
        authority: Authority,
    }
    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let home = storage::prepare_host_home(root.path()).unwrap();
            storage::private_dir(&home.join("host")).unwrap();
            let owner = storage::open_private(&home.join("host.lock"), true).unwrap();
            owner.try_lock_exclusive().unwrap();
            let identity = crate::HostIdentity {
                version: crate::VERSION,
                host_id: uuid::Uuid::new_v4().to_string(),
                generation: uuid::Uuid::new_v4().to_string(),
                socket_path: home.join("socket"),
                auth_file: home.join("host/auth.json"),
                pid: std::process::id(),
                executable_version: "fixture".into(),
            };
            storage::write(&home.join("host/host.json"), &identity).unwrap();
            storage::write(&identity.auth_file, &"synthetic-auth").unwrap();
            Self {
                root,
                owner,
                authority: Authority::new(&identity, "synthetic-auth"),
            }
        }
        fn held(&self, owner: Option<&File>, authority: Authority) -> bool {
            let (mut child, mut channel) = spawn(owner).unwrap();
            let sent = send(
                &mut channel,
                &Invocation {
                    authority,
                    request: Request::Hold,
                },
            );
            let response = sent.and_then(|()| receive::<Reply>(&mut channel));
            if response.is_ok() {
                send(&mut channel, &Value::Null).unwrap();
                let _: Reply = receive(&mut channel).unwrap();
            }
            drop(channel);
            let status = child.wait().unwrap();
            response.is_ok() && status.success()
        }
    }

    #[test]
    fn helper_request_cannot_name_foreign_keychain_service() {
        assert!(serde_json::from_value::<Request>(serde_json::json!({
            "operation":"Read", "service":"unrelated.application", "entry":uuid::Uuid::new_v4().to_string(), "interaction_allowed":false
        })).is_err());
    }

    #[test]
    fn helper_rejects_unlocked_arbitrary_owner() {
        let fixture = Fixture::new();
        let owner =
            storage::open_private(&fixture.root.path().join("not-a-host.lock"), true).unwrap();
        assert!(!fixture.held(Some(&owner), fixture.authority.clone()));
        assert!(!fixture.held(None, fixture.authority.clone()));
        let reopened =
            storage::open_private(&fixture.root.path().join("host.lock"), false).unwrap();
        assert!(!fixture.held(Some(&reopened), fixture.authority.clone()));
        assert!(fixture.held(Some(&fixture.owner), fixture.authority.clone()));
        FileExt::unlock(&fixture.owner).unwrap();
        assert!(!fixture.held(Some(&fixture.owner), fixture.authority.clone()));
    }

    #[test]
    fn helper_rejects_changed_generation_authentication_and_unrecorded_entry() {
        let fixture = Fixture::new();
        let mut stale = fixture.authority.clone();
        stale.generation = uuid::Uuid::new_v4().to_string();
        assert!(!fixture.held(Some(&fixture.owner), stale));
        let mut wrong = fixture.authority.clone();
        wrong.token = "wrong-token".into();
        assert!(!fixture.held(Some(&fixture.owner), wrong));
        assert!(
            execute(
                Some(&fixture.owner),
                Some(&fixture.authority),
                Request::Read {
                    entry: uuid::Uuid::new_v4().to_string(),
                    interaction_allowed: false
                }
            )
            .is_err()
        );
        assert!(
            execute(
                Some(&fixture.owner),
                Some(&fixture.authority),
                Request::Write {
                    entry: uuid::Uuid::new_v4().to_string(),
                    value: serde_json::json!({"synthetic": true})
                }
            )
            .is_err()
        );
        let path = fixture.root.path().join("host/host.json");
        let mut identity: crate::HostIdentity = storage::read(&path).unwrap();
        identity.pid = 0;
        storage::write(&path, &identity).unwrap();
        assert!(!fixture.held(Some(&fixture.owner), fixture.authority.clone()));
    }

    #[test]
    fn helper_entry_scope_accepts_only_durable_vault_migration_and_remote_records() {
        let fixture = Fixture::new();
        let home = fixture.root.path();
        for directory in ["vault-operations", "vault-slots", "remote-operations"] {
            storage::private_dir(&home.join("host").join(directory)).unwrap();
            let entry = uuid::Uuid::new_v4().to_string();
            assert!(!entry_is_owned(home, &entry).unwrap());
            storage::write(
                &home.join("host").join(directory).join("fixture.json"),
                &serde_json::json!({"entryId":entry,"state":"acceptedPending"}),
            )
            .unwrap();
            assert!(entry_is_owned(home, &entry).unwrap());
        }
        let import = home
            .join("host/imports")
            .join(uuid::Uuid::new_v4().to_string());
        storage::private_dir(&import).unwrap();
        let entry = uuid::Uuid::new_v4().to_string();
        storage::write(
            &import.join("record.json"),
            &serde_json::json!({"vaultReceipts":[{"entryId":entry,"state":"completed"}]}),
        )
        .unwrap();
        assert!(entry_is_owned(home, &entry).unwrap());
        let remote = uuid::Uuid::new_v4().to_string();
        storage::write(
            &home.join("host/remote-state.json"),
            &serde_json::json!({"entryId":remote}),
        )
        .unwrap();
        assert!(entry_is_owned(home, &remote).unwrap());
        assert!(!entry_is_owned(home, &uuid::Uuid::new_v4().to_string()).unwrap());
    }

    #[test]
    #[ignore = "internal subprocess entry"]
    fn helper_entry() {
        let Ok(channel) = std::env::var("AREAL_TEST_CREDENTIAL_CHANNEL") else {
            return;
        };
        run(
            channel.parse().unwrap(),
            std::env::var("AREAL_TEST_CREDENTIAL_OWNER")
                .unwrap()
                .parse()
                .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn helper_retains_inherited_owner_until_io_ends() {
        let Fixture {
            root,
            owner,
            authority,
        } = Fixture::new();
        let path = root.path().join("host.lock");
        let (mut child, mut channel) = spawn(Some(&owner)).unwrap();
        send(
            &mut channel,
            &Invocation {
                authority,
                request: Request::Hold,
            },
        )
        .unwrap();
        let _: Reply = receive(&mut channel).unwrap();
        drop(owner);
        let contender = areal_local_service::storage::open_private(&path, false).unwrap();
        let blocked = contender.try_lock_exclusive().is_err();
        send(&mut channel, &Value::Null).unwrap();
        let _: Reply = receive(&mut channel).unwrap();
        assert!(child.wait().unwrap().success());
        assert!(blocked, "helper lost the original Host lock");
        // 并行测试 fork 时可能短暂继承此 CLOEXEC fd；以内核锁状态确认释放。
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match contender.try_lock_exclusive() {
                Ok(()) => break,
                Err(cause) if cause.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "helper retained the Host lock"
                    );
                    std::thread::yield_now();
                }
                Err(cause) => panic!("owner lock probe failed: {cause}"),
            }
        }
    }
}
