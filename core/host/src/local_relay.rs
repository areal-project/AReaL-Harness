use anyhow::{Context, Result, ensure};
use areal_local_service::{
    native_process::{TrustedChild, TrustedCommand},
    storage,
};
use base64::Engine;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
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
    tls: std::cell::RefCell<Option<ReadyTls>>,
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
    tls: Option<ReadyTls>,
}
#[derive(Clone)]
struct ReadyTls {
    fingerprint: String,
    loopback_port: u16,
}
#[derive(Deserialize, Serialize)]
struct TlsMaterial {
    certificate: String,
    private_key: String,
}

fn tls_material(directory: &Path) -> Result<TlsMaterial> {
    let path = directory.join("tls-identity.json");
    match storage::read(&path) {
        Ok(material) => return Ok(material),
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) => {}
        Err(error) => return Err(error),
    }
    let issued = rcgen::generate_simple_self_signed(vec!["areal-local-relay".into()])?;
    let base64 = base64::engine::general_purpose::STANDARD;
    let material = TlsMaterial {
        certificate: base64.encode(issued.cert.der()),
        private_key: base64.encode(issued.key_pair.serialize_der()),
    };
    storage::write(&path, &material)?;
    Ok(material)
}
#[derive(Clone)]
pub(crate) struct Bundle {
    pub(crate) runtime: PathBuf,
    pub(crate) runner: PathBuf,
    root: PathBuf,
    assets: Option<PathBuf>,
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
/// 源码开发与验收用仓库相邻的 remote-relay 和 Node；发行包仍只接受签名清单。
fn source_bundle(bin: &Path) -> Option<Bundle> {
    if !cfg!(debug_assertions)
        || bin.file_name()? != "debug"
        || bin.parent()?.file_name()? != "target"
    {
        return None;
    }
    let root = bin
        .join("../../services/remote-relay")
        .canonicalize()
        .ok()?;
    let runner = root.join("src/host-runner.mjs");
    if !runner.is_file()
        || !root.join("package.json").is_file()
        || !root.join("node_modules/ws/package.json").is_file()
    {
        return None;
    }
    let runtime = std::env::var_os("AREAL_RELAY_NODE")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .and_then(|path| path.canonicalize().ok())
        .or_else(|| {
            std::env::split_paths(&std::env::var_os("PATH")?)
                .map(|path| path.join("node"))
                .find_map(|path| path.is_file().then(|| path.canonicalize().ok()).flatten())
        })?;
    let assets = root.join("assets");
    Some(Bundle {
        runtime,
        runner,
        assets: assets.is_dir().then_some(assets),
        root,
        version: "source".into(),
    })
}
impl Bundle {
    async fn discover(bin: &Path) -> Result<Self> {
        if let Some(bundle) = source_bundle(bin) {
            return Ok(bundle);
        }
        discover_bundle(
            bin,
            "areal-relay",
            "src/host-runner.mjs",
            &["src/host-runner.mjs", "node_modules/ws/package.json"],
            "localRelayUnavailable",
        )
        .await
        .map(|mut bundle| {
            bundle.assets = resolve_packaged_assets(&bundle.root);
            bundle
        })
    }
}

fn resolve_packaged_assets(root: &Path) -> Option<PathBuf> {
    let bundled_assets = root.join("assets");
    if bundled_assets.is_dir() {
        return Some(bundled_assets);
    }
    let gui_assets = root.parent().map(|dir| dir.join("areal-gui"));
    gui_assets.filter(|dir| dir.join("remote-assets.json").is_file())
}
/// 已签名 macOS 应用内的 Node 资源目录：校验签名与 bundle.json 清单后，用应用自带的 Electron 运行。
pub(crate) async fn discover_bundle(
    bin: &Path,
    name: &str,
    runner: &str,
    required: &[&str],
    unavailable: &'static str,
) -> Result<Bundle> {
    ensure!(cfg!(target_os = "macos"), unavailable);
    let contents = bin
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .context(unavailable)?;
    ensure!(
        contents.file_name().is_some_and(|name| name == "Contents"),
        unavailable
    );
    ensure!(
        bin == contents.join("Resources/areal-core/bin"),
        unavailable
    );
    let app = contents.parent().context(unavailable)?;
    let verified = tokio::time::timeout(
        Duration::from_secs(30),
        tokio::process::Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict"])
            .arg(app)
            .kill_on_drop(true)
            .output(),
    )
    .await??;
    ensure!(verified.status.success(), "{unavailable}: bundle signature");
    let root = contents.join("Resources").join(name);
    let manifest_file = File::open(root.join("bundle.json"))?;
    ensure!(
        manifest_file.metadata()?.len() <= 256 * 1024,
        "bundle manifest too large"
    );
    let mut manifest_bytes = Vec::new();
    std::io::Read::read_to_end(
        &mut std::io::Read::take(manifest_file, 256 * 1024 + 1),
        &mut manifest_bytes,
    )?;
    ensure!(
        manifest_bytes.len() <= 256 * 1024,
        "bundle manifest too large"
    );
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)?;
    verify_files(&root, &manifest, required)?;
    Ok(Bundle {
        runtime: contents.join("MacOS/AReaL Harness GUI"),
        runner: root.join(runner),
        root,
        assets: None,
        version: manifest.version,
    })
}
fn verify_files(root: &Path, manifest: &Manifest, required: &[&str]) -> Result<BTreeSet<PathBuf>> {
    let mut expected = BTreeSet::from([PathBuf::from("bundle.json")]);
    for entry in &manifest.files {
        let path = Path::new(&entry.path);
        ensure!(
            !path.as_os_str().is_empty()
                && path
                    .components()
                    .all(|part| matches!(part, Component::Normal(_))),
            "invalid bundle path"
        );
        ensure!(expected.insert(path.into()), "duplicate bundle path");
        let file = root.join(path);
        ensure!(
            std::fs::symlink_metadata(&file)?.is_file(),
            "invalid bundle file"
        );
        ensure!(
            storage::digest(&std::fs::read(file)?) == entry.sha256,
            "Relay bundle hash mismatch"
        );
    }
    ensure!(
        required
            .iter()
            .all(|path| expected.contains(Path::new(path))),
        "bundle is incomplete"
    );
    fn walk(root: &Path, current: &Path, found: &mut BTreeSet<PathBuf>) -> Result<()> {
        for entry in std::fs::read_dir(current)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_dir() {
                walk(root, &entry.path(), found)?;
            } else {
                ensure!(kind.is_file(), "invalid bundle entry");
                found.insert(entry.path().strip_prefix(root)?.into());
            }
        }
        Ok(())
    }
    let mut found = BTreeSet::new();
    walk(root, root, &mut found)?;
    ensure!(found == expected, "bundle inventory mismatch");
    Ok(expected)
}
fn local_candidate(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let first = address.octets()[0];
            (1..224).contains(&first) && !address.is_loopback() && !address.is_link_local()
        }
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
        matches!(origin.scheme(), "http" | "https")
            && local_candidate(address)
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
fn address_rank(name: &str, address: IpAddr) -> Option<u8> {
    if !local_candidate(address)
        || [
            "bridge", "br-", "virbr", "docker", "veth", "vmenet", "vmnet", "vboxnet", "awdl",
            "llw", "anpi",
        ]
        .iter()
        .any(|prefix| name.starts_with(prefix))
    {
        return None;
    }
    let tunnel = ["utun", "tun", "tap", "ppp", "ipsec", "wg"]
        .iter()
        .any(|prefix| name.starts_with(prefix));
    if matches!(address, IpAddr::V4(v4) if !v4.is_private()
        && (tunnel || !["en", "eth", "wl"].iter().any(|prefix| name.starts_with(prefix))))
    {
        return None;
    }
    Some(2 * u8::from(tunnel) + u8::from(address.is_ipv6()))
}

fn local_addresses() -> Result<Vec<(u8, IpAddr)>> {
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
    let mut addresses = Vec::new();
    while !current.is_null() {
        let interface = unsafe { &*current };
        if !interface.ifa_addr.is_null()
            && interface.ifa_flags & libc::IFF_UP as u32 != 0
            && interface.ifa_flags & libc::IFF_LOOPBACK as u32 == 0
        {
            let name = (!interface.ifa_name.is_null())
                .then(|| unsafe { std::ffi::CStr::from_ptr(interface.ifa_name) })
                .and_then(|name| name.to_str().ok())
                .unwrap_or_default();
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
            if let Some(address) = address
                && let Some(rank) = address_rank(name, address)
            {
                let needs_subnet = matches!(address, IpAddr::V4(v4) if !v4.is_private());
                if !needs_subnet
                    || (interface.ifa_flags & libc::IFF_BROADCAST as u32 != 0
                        && !interface.ifa_netmask.is_null()
                        && (1..=30).contains(&unsafe {
                            (*(interface.ifa_netmask as *const libc::sockaddr_in))
                                .sin_addr
                                .s_addr
                                .count_ones()
                        }))
                {
                    addresses.push((rank, address));
                }
            }
        }
        current = interface.ifa_next;
    }
    Ok(addresses)
}

fn unavailable_address() -> anyhow::Error {
    crate::wire::error(
        "localRelayAddressUnavailable",
        "No usable local Relay address on a LAN or VPN interface",
    )
}

fn select_address(addresses: impl IntoIterator<Item = (u8, IpAddr)>) -> Option<IpAddr> {
    addresses
        .into_iter()
        .min_by_key(|(rank, _)| *rank)
        .map(|(_, address)| address)
}

pub(crate) fn address() -> Result<IpAddr> {
    select_address(local_addresses()?).ok_or_else(unavailable_address)
}

/// 计算当前可用内网地址对应的本机 Relay origin，用于 DHCP 换址后直接引导一键切换。
pub(crate) fn suggested_origin(config: &Value) -> Option<String> {
    let port = config["relayLocal"]["port"].as_u64().unwrap_or(47820);
    if !(1024..=65535).contains(&port) {
        return None;
    }
    let addr = address().ok()?;
    Some(match addr {
        IpAddr::V4(ip) if !ip.is_private() => format!("https://{addr}:{port}"),
        IpAddr::V4(_) => format!("http://{addr}:{port}"),
        IpAddr::V6(_) => format!("http://[{addr}]:{port}"),
    })
}

pub(crate) fn ensure_local_address(origin: &url::Url) -> Result<()> {
    let address = match origin.host() {
        Some(url::Host::Ipv4(address)) => IpAddr::V4(address),
        Some(url::Host::Ipv6(address)) => IpAddr::V6(address),
        _ => return Err(unavailable_address()),
    };
    ensure!(
        local_addresses()?
            .iter()
            .any(|(_, candidate)| *candidate == address),
        unavailable_address()
    );
    Ok(())
}
pub(crate) fn configure(config: &mut Value) -> Result<()> {
    configure_at(config, address()?)
}
fn configure_at(config: &mut Value, address: IpAddr) -> Result<()> {
    let port = config["relayLocal"]["port"].as_u64().unwrap_or(47820);
    ensure!((1024..=65535).contains(&port), "invalid local Relay port");
    let origin = match address {
        IpAddr::V4(ip) if !ip.is_private() => format!("https://{address}:{port}"),
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
    pub(crate) fn fingerprint(&self) -> Option<String> {
        self.tls
            .borrow()
            .as_ref()
            .map(|tls| tls.fingerprint.clone())
    }
    pub(crate) fn routing_state(&self) -> Value {
        let mut state = self.state();
        if let Some(tls) = self.tls.borrow().as_ref() {
            state["loopbackPort"] = json!(tls.loopback_port);
        }
        state
    }
    fn publish(&self, inner: &Inner) {
        *self.tls.borrow_mut() = if inner.phase == "running" {
            inner
                .running
                .as_ref()
                .and_then(|running| running.tls.clone())
        } else {
            None
        };
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
        if let Err(error) = ensure_local_address(&origin) {
            inner.phase = "failed".into();
            inner.address.clear();
            inner.diagnostic = "已保存的内网地址不可用，请确认设备网络后重新开启内网连接。".into();
            self.publish(&inner);
            // 调用方的配置可能已保存，这里的监听失败不能作为未受理回执。
            return Err(anyhow::anyhow!("{error}"));
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
        if let Some(guard) = inner.guard.as_mut()
            && guard.try_wait()?.is_some()
        {
            inner.guard = None;
            inner.guard_lost = true;
            let _ = close(&mut inner).await;
            inner.phase = "failed".into();
            inner.diagnostic = "旧本机 Relay 独占保护已退出；已停止本机入口".into();
        }
        if let Some(running) = inner.running.as_mut()
            && let Some(status) = running.child.try_wait()?
        {
            inner.running = None;
            inner.unresolved = !status.success();
            inner.phase = "failed".into();
            inner.diagnostic = "本机 Relay 已退出；原 writer 清理结果需核查".into();
            let _ = close(&mut inner).await;
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
    let tls = (origin.scheme() == "https")
        .then(|| tls_material(&directory))
        .transpose()?;
    let listen = if tls.is_some() {
        origin.host_str().unwrap()
    } else if origin.host_str().unwrap().contains(':') {
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
    let mut runner_config = json!({"local":true,"publicOrigin":address,"listen":format!("{listen}:{}",origin.port().unwrap()),"allowedClientOrigins":[address],"allowedAppOrigins":["capacitor://localhost"],"dataDir":data});
    if let Some(assets) = &bundle.assets {
        runner_config["assetsDir"] = json!(assets);
    }
    let mut frame = json!({"version":1,"config":runner_config,"room":room});
    if let Some(material) = &tls {
        frame["tls"] = json!(material);
    }
    inner.running = Some(Running {
        child: command.spawn().await?,
        _lease: lease,
        tls: None,
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
        let response = serde_json::from_str::<Value>(&line)?;
        if let Some(material) = &tls {
            let port = response["loopbackPort"]
                .as_u64()
                .and_then(|port| u16::try_from(port).ok())
                .filter(|port| *port >= 1024)
                .context("invalid local Relay loopback port")?;
            ensure!(
                response == json!({"version":1,"event":"ready","loopbackPort":port}),
                "invalid local Relay readiness"
            );
            let certificate =
                base64::engine::general_purpose::STANDARD.decode(&material.certificate)?;
            running.tls = Some(ReadyTls {
                loopback_port: port,
                fingerprint: storage::digest(&certificate),
            });
        } else {
            ensure!(
                response == json!({"version":1,"event":"ready"}),
                "invalid local Relay readiness"
            );
        }
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
            "http://224.0.0.1:47820",
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
        verify_files(directory.path(), &manifest, &["src/host-runner.mjs"]).unwrap();
        std::fs::write(directory.path().join("assets/index.html"), b"changed").unwrap();
        assert!(verify_files(directory.path(), &manifest, &["src/host-runner.mjs"]).is_err());
        std::fs::write(directory.path().join("assets/index.html"), b"original").unwrap();
        std::fs::write(directory.path().join("unlisted.mjs"), b"extra").unwrap();
        assert!(verify_files(directory.path(), &manifest, &["src/host-runner.mjs"]).is_err());
        manifest.files[0].path = "../outside.mjs".into();
        assert!(verify_files(directory.path(), &manifest, &["src/host-runner.mjs"]).is_err());
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
            tls: None,
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

    #[test]
    fn local_relay_uses_on_link_wifi_ipv4_when_a_vm_bridge_exists() {
        let candidates = |interfaces: &[(&str, &str)]| {
            select_address(interfaces.iter().filter_map(|(interface, address)| {
                let address = address.parse().unwrap();
                address_rank(interface, address).map(|rank| (rank, address))
            }))
        };
        assert_eq!(
            candidates(&[
                ("bridge100", "192.168.139.3"),
                ("en0", "192.0.2.12"),
                ("en0", "fd00::5"),
                ("utun4", "10.0.0.3"),
            ]),
            Some("192.0.2.12".parse().unwrap())
        );
        assert_eq!(candidates(&[("bridge100", "192.168.139.3")]), None);
        assert_eq!(candidates(&[("vmenet0", "192.168.139.4")]), None);
        assert_eq!(candidates(&[("utun4", "192.0.2.12")]), None);
        assert_eq!(
            candidates(&[("utun4", "10.0.0.3")]),
            Some("10.0.0.3".parse().unwrap())
        );
    }

    #[test]
    fn packaged_assets_fallback_to_sibling_areal_gui_directory() {
        let root = tempfile::tempdir().unwrap();
        let resources = root.path().join("Contents/Resources");
        let relay = resources.join("areal-relay");
        let gui = resources.join("areal-gui");
        std::fs::create_dir_all(&relay).unwrap();
        std::fs::create_dir_all(&gui).unwrap();
        assert_eq!(resolve_packaged_assets(&relay), None);

        std::fs::write(gui.join("remote-assets.json"), "{}").unwrap();
        assert_eq!(resolve_packaged_assets(&relay), Some(gui));

        let local_assets = relay.join("assets");
        std::fs::create_dir_all(&local_assets).unwrap();
        assert_eq!(resolve_packaged_assets(&relay), Some(local_assets));
    }
}
