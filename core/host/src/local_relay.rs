use anyhow::{Context, Result, ensure};
use areal_local_service::{
    native_process::{TrustedChild, TrustedCommand},
    storage,
};
use base64::Engine;
use fs2::FileExt;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs::File,
    net::IpAddr,
    os::{
        fd::{AsRawFd, OwnedFd},
        unix::net::UnixStream,
    },
    path::{Component, Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::Mutex,
};

#[derive(Default)]
pub(crate) struct LocalRelay {
    inner: Mutex<Inner>,
    view: std::cell::RefCell<Value>,
    stopping: std::cell::Cell<bool>,
}
#[derive(Default)]
struct Inner {
    bundle: Option<Bundle>,
    running: Option<Running>,
    guard: Option<TrustedChild>,
    guard_lost: bool,
    phase: String,
    address: String,
    version: String,
    diagnostic: String,
    unresolved: bool,
}
struct Running {
    child: TrustedChild,
    _lease: File,
}
#[derive(Clone)]
struct Bundle {
    runtime: PathBuf,
    runner: PathBuf,
    root: PathBuf,
    version: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: String,
    files: Vec<BundleFile>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BundleFile {
    path: String,
    sha256: String,
}
impl Bundle {
    async fn discover(bin: &Path) -> Result<Self> {
        ensure!(cfg!(target_os = "macos"), "localRelayUnavailable");
        let contents = bin
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .context("localRelayUnavailable")?;
        ensure!(
            contents.file_name().is_some_and(|name| name == "Contents"),
            "localRelayUnavailable"
        );
        ensure!(
            bin == contents.join("Resources/areal-core/bin"),
            "localRelayUnavailable"
        );
        let app = contents.parent().context("localRelayUnavailable")?;
        let verified = tokio::time::timeout(
            Duration::from_secs(30),
            tokio::process::Command::new("/usr/bin/codesign")
                .args(["--verify", "--deep", "--strict"])
                .arg(app)
                .kill_on_drop(true)
                .output(),
        )
        .await??;
        ensure!(
            verified.status.success(),
            "localRelayUnavailable: bundle signature"
        );
        let root = contents.join("Resources/areal-relay");
        let manifest_file = File::open(root.join("bundle.json"))?;
        ensure!(
            manifest_file.metadata()?.len() <= 256 * 1024,
            "Relay manifest too large"
        );
        let mut manifest_bytes = Vec::new();
        std::io::Read::read_to_end(
            &mut std::io::Read::take(manifest_file, 256 * 1024 + 1),
            &mut manifest_bytes,
        )?;
        ensure!(
            manifest_bytes.len() <= 256 * 1024,
            "Relay manifest too large"
        );
        let manifest: Manifest = serde_json::from_slice(&manifest_bytes)?;
        verify_files(&root, &manifest)?;
        Ok(Self {
            runtime: contents.join("MacOS/AReaL Harness GUI"),
            runner: root.join("src/host-runner.mjs"),
            root,
            version: manifest.version,
        })
    }
}
fn verify_files(root: &Path, manifest: &Manifest) -> Result<()> {
    let mut expected = BTreeSet::from([PathBuf::from("bundle.json")]);
    for entry in &manifest.files {
        let path = Path::new(&entry.path);
        ensure!(
            !path.as_os_str().is_empty()
                && path
                    .components()
                    .all(|part| matches!(part, Component::Normal(_))),
            "invalid Relay bundle path"
        );
        ensure!(expected.insert(path.into()), "duplicate Relay bundle path");
        let file = root.join(path);
        ensure!(
            std::fs::symlink_metadata(&file)?.is_file(),
            "invalid Relay bundle file"
        );
        ensure!(
            storage::digest(&std::fs::read(file)?) == entry.sha256,
            "Relay bundle hash mismatch"
        );
    }
    ensure!(
        expected.contains(Path::new("src/host-runner.mjs"))
            && expected.contains(Path::new("node_modules/ws/package.json"))
            && expected.iter().any(|path| path.starts_with("assets")),
        "Relay bundle is incomplete"
    );
    fn walk(root: &Path, current: &Path, found: &mut BTreeSet<PathBuf>) -> Result<()> {
        for entry in std::fs::read_dir(current)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_dir() {
                walk(root, &entry.path(), found)?;
            } else {
                ensure!(kind.is_file(), "invalid Relay bundle entry");
                found.insert(entry.path().strip_prefix(root)?.into());
            }
        }
        Ok(())
    }
    let mut found = BTreeSet::new();
    walk(root, root, &mut found)?;
    ensure!(found == expected, "Relay bundle inventory mismatch");
    Ok(())
}
pub(crate) fn private_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => address.is_private(),
        IpAddr::V6(address) => address.segments()[0] & 0xfe00 == 0xfc00,
    }
}
pub(crate) fn local_origin(config: &Value) -> Result<url::Url> {
    let origin = url::Url::parse(
        config["relayLocal"]["origin"]
            .as_str()
            .context("local Relay origin missing")?,
    )?;
    let address: IpAddr = origin
        .host_str()
        .context("local Relay host missing")?
        .trim_matches(['[', ']'])
        .parse()?;
    ensure!(
        origin.scheme() == "http"
            && private_address(address)
            && origin.port().map(u64::from) == config["relayLocal"]["port"].as_u64()
            && origin.username().is_empty()
            && origin.password().is_none()
            && origin.path() == "/"
            && origin.query().is_none()
            && origin.fragment().is_none(),
        "invalid local Relay origin"
    );
    Ok(origin)
}
pub(crate) fn address() -> Result<IpAddr> {
    struct Interfaces(*mut libc::ifaddrs);
    impl Drop for Interfaces {
        fn drop(&mut self) {
            unsafe { libc::freeifaddrs(self.0) }
        }
    }
    let mut pointer = std::ptr::null_mut();
    ensure!(
        unsafe { libc::getifaddrs(&mut pointer) } == 0,
        "local network inspection failed"
    );
    let interfaces = Interfaces(pointer);
    let mut current = interfaces.0;
    let mut ipv6 = None;
    while !current.is_null() {
        let interface = unsafe { &*current };
        if !interface.ifa_addr.is_null()
            && interface.ifa_flags & libc::IFF_UP as u32 != 0
            && interface.ifa_flags & libc::IFF_LOOPBACK as u32 == 0
        {
            let family = unsafe { (*interface.ifa_addr).sa_family } as i32;
            let address = unsafe {
                match family {
                    libc::AF_INET => Some(IpAddr::V4(std::net::Ipv4Addr::from(
                        (*(interface.ifa_addr as *const libc::sockaddr_in))
                            .sin_addr
                            .s_addr
                            .to_ne_bytes(),
                    ))),
                    libc::AF_INET6 => Some(IpAddr::V6(std::net::Ipv6Addr::from(
                        (*(interface.ifa_addr as *const libc::sockaddr_in6))
                            .sin6_addr
                            .s6_addr,
                    ))),
                    _ => None,
                }
            };
            if let Some(address) = address.filter(|address| private_address(*address)) {
                if address.is_ipv4() {
                    return Ok(address);
                }
                ipv6 = Some(address);
            }
        }
        current = interface.ifa_next;
    }
    ipv6.context("没有可用的内网地址，请连接可互通的内网或 VPN 后重试")
}
pub(crate) fn configure(config: &mut Value) -> Result<()> {
    configure_at(config, address()?)
}
fn configure_at(config: &mut Value, address: IpAddr) -> Result<()> {
    let port = config["relayLocal"]["port"].as_u64().unwrap_or(47820);
    ensure!((1024..=65535).contains(&port), "invalid local Relay port");
    let origin = match address {
        IpAddr::V4(_) => format!("http://{address}:{port}"),
        IpAddr::V6(_) => format!("http://[{address}]:{port}"),
    };
    let mut profiles = config["relayProfiles"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if config["relay"].is_string()
        && config["capability"].is_string()
        && config["room"].is_string()
        && !profiles
            .iter()
            .any(|profile| profile["origin"] == config["relay"])
    {
        profiles.push(json!({"origin":config["relay"],"kind":if config["relayLocal"]["origin"].is_string() && config["relay"]==config["relayLocal"]["origin"] { "local" } else { "external" },"room":config["room"],"capability":config["capability"]}));
    }
    let previous_origin = config["relayLocal"]["origin"].clone();
    let mut profile = match profiles.iter().find(|profile| {
        profile["kind"] == "local"
            || (previous_origin.is_string() && profile["origin"] == previous_origin)
    }) {
        Some(profile) => profile.clone(),
        None => {
            let mut bytes = [0u8; 32];
            std::io::Read::read_exact(&mut File::open("/dev/urandom")?, &mut bytes)?;
            let capability = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
            json!({"kind":"local","room":storage::digest(capability.as_bytes()),"capability":capability})
        }
    };
    ensure!(
        profile["room"].as_str().is_some_and(
            |room| room.len() == 64 && room.bytes().all(|byte| byte.is_ascii_hexdigit())
        ) && profile["capability"]
            .as_str()
            .is_some_and(|value| !value.is_empty()),
        "invalid local Relay profile"
    );
    profile["origin"] = json!(origin);
    profile["kind"] = json!("local");
    profiles.retain(|profile| {
        profile["kind"] != "local"
            && (!previous_origin.is_string() || profile["origin"] != previous_origin)
    });
    profiles.push(profile.clone());
    config["relayLocal"] = json!({"enabled":true,"origin":origin,"port":port});
    config["relayProfiles"] = json!(profiles);
    config["relay"] = profile["origin"].clone();
    config["capability"] = profile["capability"].clone();
    config["room"] = profile["room"].clone();
    config["relayProtocol"] = json!("areal.remote.v2");
    config["enabled"] = json!(true);
    Ok(())
}
impl LocalRelay {
    pub(crate) fn quiesce(&self, stopping: bool) {
        self.stopping.set(stopping);
    }
    pub(crate) fn state(&self) -> Value {
        let view = self.view.borrow();
        if view.is_null() {
            return json!({"phase":"stopped","address":"","version":"","error":""});
        }
        view.clone()
    }
    fn publish(&self, inner: &Inner) {
        *self.view.borrow_mut() = json!({"phase":if inner.phase.is_empty(){"stopped"}else{&inner.phase},"address":inner.address,"version":inner.version,"error":inner.diagnostic});
    }
    pub(crate) async fn start(
        &self,
        home: &Path,
        bin: &Path,
        config: &Value,
        legacy_home: Option<&Path>,
    ) -> Result<()> {
        let mut inner = self.inner.lock().await;
        ensure!(!self.stopping.get(), "Host is stopping");
        ensure!(!inner.unresolved, "local Relay cleanup unconfirmed");
        ensure!(!inner.guard_lost, "legacy Relay guard exited");
        let origin = local_origin(config)?;
        let address = origin.origin().ascii_serialization();
        if let Some(running) = &mut inner.running {
            if let Some(status) = running.child.try_wait()? {
                inner.running = None;
                inner.unresolved = !status.success();
                inner.phase = "failed".into();
                let _ = close(&mut inner).await;
                self.publish(&inner);
                anyhow::bail!("local Relay exited");
            }
            ensure!(
                inner.address == address,
                "local Relay configuration changed"
            );
            return Ok(());
        }
        inner.phase = "starting".into();
        inner.address = address.clone();
        self.publish(&inner);
        let startup = start_runners(&mut inner, home, bin, config, legacy_home, &origin).await;
        let result = match startup {
            Ok(version) => {
                inner.phase = "running".into();
                inner.version = version;
                inner.diagnostic.clear();
                Ok(())
            }
            Err(error) => {
                let cleanup = close(&mut inner).await;
                inner.phase = "failed".into();
                inner.diagnostic = "本机 Relay 启动失败；请检查安装包、端口与原 writer 状态".into();
                match cleanup {
                    Ok(()) => Err(error),
                    Err(cleanup) => {
                        Err(error.context(format!("local Relay cleanup unconfirmed: {cleanup}")))
                    }
                }
            }
        };
        self.publish(&inner);
        result
    }
    pub(crate) async fn stop(&self) -> Result<()> {
        let mut inner = self.inner.lock().await;
        let result = close(&mut inner).await;
        inner.phase = if result.is_ok() { "stopped" } else { "failed" }.into();
        if result.is_ok() {
            inner.diagnostic.clear();
        } else {
            inner.diagnostic = "本机 Relay 清理尚未确认".into();
        }
        self.publish(&inner);
        result
    }
    pub(crate) async fn block_source(&self) {
        let mut inner = self.inner.lock().await;
        let _ = close(&mut inner).await;
        inner.guard_lost = true;
        inner.phase = "failed".into();
        inner.diagnostic = "旧本机 Relay 来源隔离已失效；需核查原迁移记录".into();
        self.publish(&inner);
    }
    pub(crate) async fn poll(&self) -> Result<()> {
        let mut inner = self.inner.lock().await;
        if let Some(guard) = inner.guard.as_mut() {
            if guard.try_wait()?.is_some() {
                inner.guard = None;
                inner.guard_lost = true;
                let _ = close(&mut inner).await;
                inner.phase = "failed".into();
                inner.diagnostic = "旧本机 Relay 独占保护已退出；已停止本机入口".into();
            }
        }
        if let Some(running) = inner.running.as_mut() {
            if let Some(status) = running.child.try_wait()? {
                inner.running = None;
                inner.unresolved = !status.success();
                inner.phase = "failed".into();
                inner.diagnostic = "本机 Relay 已退出；原 writer 清理结果需核查".into();
                let _ = close(&mut inner).await;
            }
        }
        self.publish(&inner);
        Ok(())
    }
}
async fn start_runners(
    inner: &mut Inner,
    home: &Path,
    bin: &Path,
    config: &Value,
    legacy_home: Option<&Path>,
    origin: &url::Url,
) -> Result<String> {
    let address = origin.origin().ascii_serialization();
    if inner.bundle.is_none() {
        inner.bundle = Some(Bundle::discover(bin).await?);
    }
    let bundle = inner.bundle.as_ref().unwrap().clone();
    let directory = home.join("host/local-relay");
    storage::private_dir(&directory)?;
    let data = legacy_home
        .map(|home| home.join("relay-service/local"))
        .unwrap_or_else(|| directory.join("data"));
    storage::private_dir(&data)?;
    let lease = storage::open_private(&directory.join("writer.lock"), true)?;
    lease
        .try_lock_exclusive()
        .context("local Relay writer is still owned")?;
    if let Some(legacy_home) = legacy_home {
        let legacy_home = legacy_home.canonicalize()?;
        let (reader, writer) = UnixStream::pair()?;
        reader.set_nonblocking(true)?;
        let mut command = TrustedCommand::supervised(&bundle.runtime, &[])?;
        command
            .arg(format!(
                "--areal-relay-legacy-guard={}",
                legacy_home.display()
            ))
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", home)
            .env("TMPDIR", std::env::temp_dir())
            .stdin(Stdio::piped())
            .stdout(Stdio::from(OwnedFd::from(writer)))
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        inner.guard = Some(command.spawn().await?);
        let guard = inner.guard.as_mut().unwrap();
        let ready = async {
            let mut line = String::new();
            BufReader::new(tokio::net::UnixStream::from_std(reader)?)
                .take(4096)
                .read_line(&mut line)
                .await?;
            ensure!(
                serde_json::from_str::<Value>(&line)?
                    == json!({"kind":"ready","coreHome":legacy_home,"pid":guard.id()}),
                "legacy Relay guard readiness mismatch"
            );
            ensure!(
                guard.try_wait()?.is_none(),
                "legacy Relay guard exited before readiness"
            );
            Ok::<_, anyhow::Error>(())
        };
        tokio::time::timeout(Duration::from_secs(20), ready)
            .await
            .context("legacy Relay guard timed out")??;
    }
    let (reader, writer) = UnixStream::pair()?;
    reader.set_nonblocking(true)?;
    let mut command = TrustedCommand::supervised(&bundle.runtime, &[lease.as_raw_fd()])?;
    command
        .arg(&bundle.runner)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", home)
        .env("TMPDIR", std::env::temp_dir())
        .env("ELECTRON_RUN_AS_NODE", "1")
        .env("AREAL_LOCAL_RELAY_LEASE_FD", lease.as_raw_fd().to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::from(OwnedFd::from(writer)))
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    let listen = if origin.host_str().unwrap().contains(':') {
        "[::]"
    } else {
        "0.0.0.0"
    };
    let room = config["relayProfiles"]
        .as_array()
        .and_then(|profiles| {
            profiles
                .iter()
                .find(|profile| profile["kind"] == "local" && profile["origin"] == address)
        })
        .map(|profile| &profile["room"])
        .or_else(|| (config["relay"] == address).then_some(&config["room"]))
        .context("local Relay profile missing")?;
    let frame = json!({"version":1,"config":{"local":true,"publicOrigin":address,"listen":format!("{listen}:{}",origin.port().unwrap()),"allowedClientOrigins":[address],"allowedAppOrigins":["capacitor://localhost"],"dataDir":data,"assetsDir":bundle.root.join("assets")},"room":room});
    inner.running = Some(Running {
        child: command.spawn().await?,
        _lease: lease,
    });
    let running = inner.running.as_mut().unwrap();
    let ready = async {
        running
            .child
            .stdin
            .as_mut()
            .context("local Relay stdin missing")?
            .write_all(format!("{frame}\n").as_bytes())
            .await?;
        let mut line = String::new();
        BufReader::new(tokio::net::UnixStream::from_std(reader)?)
            .take(1024)
            .read_line(&mut line)
            .await?;
        ensure!(
            serde_json::from_str::<Value>(&line)? == json!({"version":1,"event":"ready"}),
            "invalid local Relay readiness"
        );
        ensure!(
            running.child.try_wait()?.is_none(),
            "local Relay exited before readiness"
        );
        Ok::<_, anyhow::Error>(())
    };
    tokio::time::timeout(Duration::from_secs(20), ready)
        .await
        .context("local Relay readiness timed out")??;
    if let Some(guard) = inner.guard.as_mut() {
        ensure!(
            guard.try_wait()?.is_none(),
            "legacy Relay guard exited during startup"
        );
    }
    Ok::<_, anyhow::Error>(bundle.version)
}

async fn close(inner: &mut Inner) -> Result<()> {
    if let Some(running) = inner.running.as_mut() {
        running.child.stdin.take();
        let status = tokio::time::timeout(Duration::from_secs(20), running.child.wait())
            .await
            .context("local Relay cleanup timed out")??;
        inner.running = None;
        inner.unresolved = !status.success();
    }
    if let Some(guard) = inner.guard.as_mut() {
        guard.stdin.take();
        let status = tokio::time::timeout(Duration::from_secs(20), guard.wait())
            .await
            .context("legacy Relay guard cleanup timed out")??;
        inner.guard = None;
        inner.unresolved |= !status.success();
    }
    ensure!(!inner.unresolved, "local Relay cleanup unconfirmed");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configure_preserves_legacy_local_identity_without_profiles_and_other_grants() {
        let mut config = json!({"identity":"original-noise","deviceGrants":[{"devicePeerId":"phone"}],"relay":"http://192.168.1.2:47820","relayLocal":{"enabled":true,"port":47820,"origin":"http://192.168.1.2:47820"},"room":"a".repeat(64),"capability":"x".repeat(43)});
        configure_at(&mut config, "192.168.1.3".parse().unwrap()).unwrap();
        assert_eq!(config["identity"], "original-noise");
        assert_eq!(config["deviceGrants"], json!([{"devicePeerId":"phone"}]));
        assert_eq!(config["room"], "a".repeat(64));
        assert_eq!(config["capability"], "x".repeat(43));
        assert_eq!(config["relayProfiles"][0]["kind"], "local");
        assert_eq!(
            config["relayProfiles"][0]["origin"],
            "http://192.168.1.3:47820"
        );
        config["relayProfiles"][0]["kind"] = json!("external");
        configure_at(&mut config, "192.168.1.4".parse().unwrap()).unwrap();
        assert_eq!(config["relayProfiles"].as_array().unwrap().len(), 1);
        assert_eq!(config["relayProfiles"][0]["kind"], "local");
        assert_eq!(config["capability"], "x".repeat(43));
        let mut fresh = json!({"identity":"original-noise","relay":"https://relay.example","room":"external-room","capability":"external-capability"});
        configure_at(&mut fresh, "192.168.1.3".parse().unwrap()).unwrap();
        let capability = fresh["capability"].as_str().unwrap();
        assert_eq!(capability.len(), 43);
        assert_eq!(
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(capability)
                .unwrap()
                .len(),
            32
        );
        assert_eq!(fresh["room"], storage::digest(capability.as_bytes()));
        assert_eq!(fresh["relayProfiles"][0]["origin"], "https://relay.example");
        assert_eq!(fresh["relayProfiles"][0]["room"], "external-room");
    }

    #[tokio::test]
    async fn host_stop_barrier_rejects_start_after_waiting_for_owner_lock() {
        let relay = LocalRelay::default();
        let guard = relay.inner.lock().await;
        let config = json!({});
        let starting = relay.start(Path::new("/unused"), Path::new("/unused"), &config, None);
        tokio::pin!(starting);
        assert!(futures_util::poll!(starting.as_mut()).is_pending());
        relay.quiesce(true);
        drop(guard);
        assert!(
            starting
                .await
                .unwrap_err()
                .to_string()
                .contains("Host is stopping")
        );
    }

    #[test]
    fn local_origin_rejects_external_and_mismatched_authorities() {
        for origin in [
            "http://127.0.0.1:47820",
            "http://8.8.8.8:47820",
            "https://192.168.1.2:47820",
            "http://name.local:47820",
            "http://192.168.1.2:47820/path",
            "http://user@192.168.1.2:47820",
        ] {
            assert!(local_origin(&json!({"relayLocal":{"origin":origin,"port":47820}})).is_err());
        }
        assert!(
            local_origin(&json!({"relayLocal":{"origin":"http://192.168.1.2:47820","port":47821}}))
                .is_err()
        );
        assert!(
            local_origin(&json!({"relayLocal":{"origin":"http://192.168.1.2:47820","port":47820}}))
                .is_ok()
        );
        assert!(
            local_origin(&json!({"relayLocal":{"origin":"http://[fd00::1]:47820","port":47820}}))
                .is_ok()
        );
    }

    #[test]
    fn bundle_rejects_tampering_unlisted_files_and_escape() {
        let directory = tempfile::tempdir().unwrap();
        let mut manifest = Manifest {
            version: "fixture".into(),
            files: Vec::new(),
        };
        std::fs::write(directory.path().join("bundle.json"), b"{}").unwrap();
        for path in [
            "src/host-runner.mjs",
            "node_modules/ws/package.json",
            "assets/index.html",
        ] {
            let file = directory.path().join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, b"original").unwrap();
            manifest.files.push(BundleFile {
                path: path.into(),
                sha256: storage::digest(b"original"),
            });
        }
        verify_files(directory.path(), &manifest).unwrap();
        std::fs::write(directory.path().join("assets/index.html"), b"changed").unwrap();
        assert!(verify_files(directory.path(), &manifest).is_err());
        std::fs::write(directory.path().join("assets/index.html"), b"original").unwrap();
        std::fs::write(directory.path().join("unlisted.mjs"), b"extra").unwrap();
        assert!(verify_files(directory.path(), &manifest).is_err());
        manifest.files[0].path = "../outside.mjs".into();
        assert!(verify_files(directory.path(), &manifest).is_err());
    }

    async fn running(script: &str) -> (LocalRelay, tempfile::TempDir) {
        let directory = tempfile::tempdir().unwrap();
        let lease = storage::open_private(&directory.path().join("lease"), true).unwrap();
        lease.try_lock_exclusive().unwrap();
        let mut command =
            TrustedCommand::supervised(Path::new("/bin/sh"), &[lease.as_raw_fd()]).unwrap();
        command
            .args(["-c", script])
            .env_clear()
            .env("MARKER", directory.path().join("relay-closed"))
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = command.spawn().await.unwrap();
        let relay = LocalRelay::default();
        relay.inner.lock().await.running = Some(Running {
            child,
            _lease: lease,
        });
        (relay, directory)
    }

    #[tokio::test]
    async fn stop_waits_for_child_cleanup_and_releases_writer() {
        let (relay, directory) = running("while read line; do :; done; exit 0").await;
        let other = storage::open_private(&directory.path().join("lease"), false).unwrap();
        assert!(other.try_lock_exclusive().is_err());
        relay.stop().await.unwrap();
        assert_eq!(relay.state()["phase"], "stopped");
        other.try_lock_exclusive().unwrap();
    }

    #[tokio::test]
    async fn nonzero_cleanup_remains_unconfirmed_on_original_stop_retry() {
        let (relay, _directory) = running("while read line; do :; done; exit 7").await;
        assert!(relay.stop().await.is_err());
        assert!(relay.stop().await.is_err());
        assert!(relay.inner.lock().await.unresolved);
    }

    #[tokio::test]
    async fn legacy_guard_is_released_only_after_relay_cleanup() {
        let (relay, directory) = running("while read line; do :; done; : > \"$MARKER\"").await;
        let mut guard = TrustedCommand::supervised(Path::new("/bin/sh"), &[]).unwrap();
        guard
            .args(["-c", "while read line; do :; done; test -f \"$MARKER\""])
            .env_clear()
            .env("MARKER", directory.path().join("relay-closed"))
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        relay.inner.lock().await.guard = Some(guard.spawn().await.unwrap());
        relay.stop().await.unwrap();
        assert!(directory.path().join("relay-closed").is_file());
        assert!(relay.inner.lock().await.guard.is_none());
    }

    #[tokio::test]
    async fn lost_legacy_guard_stops_relay_and_blocks_automatic_reopen() {
        let (relay, directory) = running("while read line; do :; done; : > \"$MARKER\"").await;
        let mut guard = TrustedCommand::supervised(Path::new("/bin/sh"), &[]).unwrap();
        guard
            .args(["-c", "exit 0"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut guard = guard.spawn().await.unwrap();
        guard.wait().await.unwrap();
        relay.inner.lock().await.guard = Some(guard);
        relay.poll().await.unwrap();
        assert!(directory.path().join("relay-closed").is_file());
        assert!(relay.inner.lock().await.running.is_none());
        let error = relay
            .start(
                directory.path(),
                Path::new("/not-a-runtime"),
                &json!({}),
                None,
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("legacy Relay guard exited"));
    }

    #[tokio::test]
    async fn cli_source_path_cannot_select_a_runtime() {
        assert!(Bundle::discover(Path::new("/usr/local/bin")).await.is_err());
    }
}
