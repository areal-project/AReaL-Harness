use crate::package::SnapshotBudget;
use crate::{CATALOG_PATHS, PluginDetail, PluginList, Store, StoreError, package, seal_directory};
use anyhow::{Context, Result, bail, ensure};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256, Sha512};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
const LIMIT: u64 = 64 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
pub(crate) struct Candidate {
    pub detail: PluginDetail,
    pub root: PathBuf,
    #[serde(default)]
    pub definition: Option<package::Definition>,
}
#[derive(Serialize, Deserialize)]
pub(crate) struct GitPin {
    pub url: String,
    pub reference: Option<String>,
    pub commit: String,
    #[serde(default)]
    pub sparse_paths: Vec<String>,
}
pub(crate) fn is_remote(v: &Value) -> bool {
    matches!(
        v["source"].as_str().or(v["type"].as_str()),
        Some("url" | "git" | "git-subdir" | "npm" | "github" | "archive" | "command" | "pip")
    )
}
fn identity(entry: &Value, root: &Path) -> PathBuf {
    let bytes = serde_json::to_vec(&(root, entry)).unwrap();
    PathBuf::from(format!("remote-{:x}", Sha256::digest(bytes)))
}
pub(crate) fn preview(
    entry: &Value,
    id: &str,
    root: &Path,
    candidate: Option<&Candidate>,
) -> Result<PluginDetail> {
    let source = identity(entry, root);
    if let Some(c) = candidate.filter(|c| c.detail.source == source) {
        let mut detail = c.detail.clone();
        detail.definition = c.definition.clone();
        detail.catalog_source = crate::metadata::source(entry, root, None)?;
        detail.policy = crate::metadata::policy(entry)?;
        return Ok(detail);
    }
    let name = entry["name"].as_str().context("entry name missing")?;
    ensure!(
        !name.is_empty()
            && name.len() <= 128
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)),
        "invalid plugin name"
    );
    Ok(PluginDetail {
        revision: 0,
        id: id.into(),
        name: name.into(),
        display_name: name.into(),
        description: entry["description"].as_str().unwrap_or_default().into(),
        version: None,
        installed: false,
        installed_version: None,
        installed_digest: None,
        installed_source_digest: None,
        admission_digest: None,
        definition: None,
        installed_skills: vec![],
        component_choices: Default::default(),
        installed_metadata: None,
        component_support: None,
        installed_component_support: None,
        installed_onboarding_skill: None,
        enabled: false,
        source,
        source_digest: String::new(),
        catalog_source: crate::metadata::source(entry, root, None)?,
        policy: crate::metadata::policy(entry)?,
        interface: crate::metadata::catalog_interface(
            crate::metadata::interface(entry.get("interface"), None, root),
            entry,
        ),
        source_kind: entry["source"]["source"]
            .as_str()
            .or(entry["source"]["type"].as_str())
            .map(str::to_owned),
        resolved_commit: None,
        package_version: None,
        integrity: None,
        components: vec![],
        diagnostics: vec![
            if crate::metadata::source(entry, root, None)?["unsupported"] == true {
                "sourceUnsupported: this source type cannot be resolved or installed".into()
            } else {
                "Remote source requires explicit resolution and review before install".into()
            },
        ],
        skills: vec![],
        required_tools: vec![],
        onboarding_skill: None,
    })
}
fn http(url: &str) -> Result<Vec<u8>> {
    let url = reqwest::Url::parse(url)?;
    ensure!(
        matches!(url.scheme(), "https" | "http")
            && url.username().is_empty()
            && url.password().is_none(),
        "invalid registry URL"
    );
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()?;
    let mut response = client.get(url).send()?.error_for_status()?;
    ensure!(
        response.content_length().unwrap_or(0) <= LIMIT,
        "download exceeds 64 MiB"
    );
    let mut bytes = Vec::new();
    response.by_ref().take(LIMIT + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= LIMIT, "download exceeds 64 MiB");
    Ok(bytes)
}
fn git(repo: &Path, args: &[&str]) -> Result<String> {
    let out = tempfile::tempfile()?;
    use std::os::unix::process::CommandExt;
    let mut cmd = Command::new("git");
    cmd.process_group(0);
    cmd.env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .arg("-c")
        .arg("core.hooksPath=/dev/null")
        .arg("-c")
        .arg("protocol.ext.allow=never")
        .arg("-c")
        .arg("core.sshCommand=ssh -oBatchMode=yes -oStrictHostKeyChecking=yes")
        .current_dir(repo)
        .args(args)
        .stdin(Stdio::null())
        .stdout(out.try_clone()?)
        .stderr(Stdio::null());
    if let Some(socket) = std::env::var_os("SSH_AUTH_SOCK") {
        cmd.env("SSH_AUTH_SOCK", socket);
    }
    let mut child = cmd.spawn()?;
    let start = Instant::now();
    loop {
        fn disk_usage(path: &Path, count: &mut usize) -> Result<u64> {
            let mut size = 0;
            let entries = match fs::read_dir(path) {
                Ok(v) => v,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
                Err(e) => return Err(e.into()),
            };
            for entry in entries {
                let entry = entry?;
                *count += 1;
                ensure!(*count < 20000, "Git entry limit exceeded");
                let meta = match fs::symlink_metadata(entry.path()) {
                    Ok(v) => v,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(e) => return Err(e.into()),
                };
                size += if meta.is_dir() {
                    disk_usage(&entry.path(), count)?
                } else {
                    meta.len()
                };
                ensure!(size <= LIMIT * 2, "Git download exceeds 128 MiB");
            }
            Ok(size)
        }
        let within_limit = disk_usage(repo, &mut 0).is_ok();
        if let Some(status) = child.try_wait()? {
            ensure!(within_limit, "Git download exceeds size or entry limit");
            ensure!(status.success(), "git operation failed");
            break;
        }
        if !within_limit || start.elapsed() > Duration::from_secs(60) {
            // 整个传输组归本次操作所有，超时不能遗留 fetch/remote-helper。
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait();
            bail!("git operation timed out or exceeded size/entry limit");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    use std::io::{Seek, SeekFrom};
    let mut out = out;
    out.seek(SeekFrom::Start(0))?;
    let mut text = String::new();
    out.take(4097).read_to_string(&mut text)?;
    ensure!(text.len() <= 4096, "git output too large");
    Ok(text.trim().into())
}
pub(crate) fn normalize_git_url(url: &str, marketplace_root: &Path) -> Result<String> {
    let url = url.trim();
    ensure!(
        !url.is_empty()
            && !url.starts_with('-')
            && !url.chars().any(char::is_control)
            && !url.contains("::"),
        "invalid Git URL"
    );
    let safe_segments = |path: &str| !path.split(['/', '\\']).any(|s| s == "..");
    ensure!(
        safe_segments(url) && !url.to_ascii_lowercase().contains("%2e"),
        "Git source traversal prohibited"
    );
    if url.starts_with("./")
        || url.starts_with(".\\")
        || url.starts_with("../")
        || url.starts_with("..\\")
    {
        let relative = package::relative(&url.replace('\\', "/"))?;
        return Ok(marketplace_root
            .join(relative)
            .to_string_lossy()
            .into_owned());
    }
    if Path::new(url).is_absolute() {
        return Ok(url.into());
    }
    if url.starts_with("git@") {
        let (host, path) = url
            .strip_prefix("git@")
            .unwrap()
            .split_once(':')
            .context("invalid scp Git URL")?;
        ensure!(
            !host.is_empty()
                && !host.starts_with('-')
                && host
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b)),
            "invalid scp Git host"
        );
        ensure!(
            !path.is_empty()
                && safe_segments(path)
                && !path.starts_with('-')
                && path
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"/._-~@".contains(&b)),
            "unsafe scp Git path"
        );
        return Ok(url.into());
    }
    if url.contains("://") {
        let parsed = reqwest::Url::parse(url)?;
        ensure!(
            parsed.password().is_none() && parsed.query().is_none() && parsed.fragment().is_none(),
            "Git URL must not contain password, query or fragment"
        );
        match parsed.scheme() {
            "http" | "https" => {
                ensure!(
                    parsed.host_str().is_some() && parsed.username().is_empty(),
                    "invalid HTTP Git URL"
                );
                return Ok(
                    if url.starts_with("https://github.com/") && !url.ends_with(".git") {
                        format!("{url}.git")
                    } else {
                        url.into()
                    },
                );
            }
            "file" => {
                ensure!(
                    parsed.host_str().is_none_or(|host| host == "localhost")
                        && parsed.username().is_empty(),
                    "nonlocal file Git URL prohibited"
                );
                let local = parsed
                    .to_file_path()
                    .map_err(|_| anyhow::anyhow!("invalid file Git URL"))?;
                ensure!(
                    !local
                        .components()
                        .any(|c| matches!(c, std::path::Component::ParentDir)),
                    "Git source traversal prohibited"
                );
                return Ok(url.into());
            }
            "ssh" => {
                ensure!(
                    parsed.host_str().is_some_and(|host| !host.starts_with('-'))
                        && !parsed.username().starts_with('-')
                        && parsed
                            .username()
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)),
                    "invalid SSH Git user/host"
                );
                ensure!(
                    parsed.path().len() > 1
                        && parsed
                            .path()
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"/._-~@".contains(&b)),
                    "unsafe SSH Git path"
                );
                return Ok(url.into());
            }
            _ => bail!("unsupported Git transport"),
        }
    }
    let segments: Vec<_> = url.split('/').collect();
    ensure!(
        segments.len() == 2
            && segments.iter().all(|s| !s.is_empty()
                && *s != "."
                && *s != ".."
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))),
        "invalid GitHub shorthand"
    );
    let repo = segments[1].strip_suffix(".git").unwrap_or(segments[1]);
    ensure!(!repo.is_empty(), "invalid GitHub repository");
    Ok(format!("https://github.com/{}/{repo}.git", segments[0]))
}
fn fetch_git(stage: &Path, url: &str, reference: Option<&str>) -> Result<String> {
    fetch_git_sparse(stage, url, reference, &[])
}
fn fetch_git_sparse(
    stage: &Path,
    url: &str,
    reference: Option<&str>,
    sparse_paths: &[String],
) -> Result<String> {
    ensure!(
        sparse_paths.len() <= 256 && sparse_paths.iter().map(String::len).sum::<usize>() <= 65536,
        "sparse paths exceed budget"
    );
    for path in sparse_paths {
        package::relative(path)?;
        ensure!(
            !path.starts_with('-')
                && !path
                    .chars()
                    .any(|c| c.is_control() || "\\*?[]!".contains(c))
                && !path.split('/').any(|s| s == ".git" || s == "."),
            "unsafe sparse path"
        );
    }
    let url = normalize_git_url(url, stage)?;
    let reference = reference.unwrap_or("HEAD");
    ensure!(
        !reference.is_empty()
            && !reference.starts_with('-')
            && !reference.contains(':')
            && !reference.chars().any(char::is_whitespace),
        "invalid Git ref"
    );
    git(stage, &["init", "--quiet"])?;
    let mut fetch = vec!["fetch", "--depth=1", "--no-tags", "--no-recurse-submodules"];
    if !sparse_paths.is_empty() {
        fetch.push("--filter=blob:none");
    }
    fetch.extend(["--", &url, reference]);
    git(stage, &fetch)?;
    let commit = git(stage, &["rev-parse", "--verify", "FETCH_HEAD^{commit}"])?;
    ensure!(
        commit.len() == 40 && commit.bytes().all(|b| b.is_ascii_hexdigit()),
        "invalid resolved commit"
    );
    if !sparse_paths.is_empty() {
        let mut sparse = vec!["sparse-checkout", "set", "--cone", "--"];
        sparse.extend(sparse_paths.iter().map(String::as_str));
        git(stage, &sparse)?;
    }
    git(stage, &["checkout", "--quiet", "--detach", &commit])?;
    Ok(commit)
}
fn unpack(bytes: &[u8], destination: &Path) -> Result<()> {
    let decoder = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder.take(LIMIT + 1));
    let mut total = 0u64;
    let mut count = 0;
    let mut seen = std::collections::BTreeSet::new();
    for entry in archive.entries()? {
        let mut entry = entry?;
        count += 1;
        ensure!(count <= 8192, "archive entry limit exceeded");
        let raw = entry
            .path()?
            .to_str()
            .context("non UTF-8 archive path")?
            .to_owned();
        let normalized = package::relative(&raw)?;
        let Some(path) = normalized.strip_prefix("package/") else {
            ensure!(
                normalized == "package" && entry.header().entry_type().is_dir(),
                "npm archive requires package/ root"
            );
            continue;
        };
        let path = package::relative(path)?;
        ensure!(
            !path.split('/').any(|p| p == ".git"),
            "archive contains .git"
        );
        let kind = entry.header().entry_type();
        ensure!(
            kind.is_file() || kind.is_dir(),
            "archive links and special files prohibited"
        );
        ensure!(seen.insert(path.clone()), "duplicate archive entry");
        let output = destination.join(path);
        if kind.is_dir() {
            fs::create_dir_all(&output)?;
            continue;
        }
        total = total
            .checked_add(entry.size())
            .context("archive size overflow")?;
        ensure!(total <= LIMIT, "archive exceeds 64 MiB");
        fs::create_dir_all(output.parent().unwrap())?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(output)?;
        // 只保留可执行语义，不继承 setuid/setgid、归档所有者或写入权限。
        let executable = entry.header().mode()? & 0o111 != 0;
        std::io::copy(&mut entry, &mut file)?;
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(if executable {
            0o755
        } else {
            0o644
        }))?;
    }
    Ok(())
}
fn fetch_npm(source: &Value, stage: &Path) -> Result<(String, String)> {
    let name = source["package"].as_str().context("npm package missing")?;
    let parts: Vec<_> = name.trim_start_matches('@').split('/').collect();
    ensure!(
        (name.starts_with('@') && parts.len() == 2 || !name.starts_with('@') && parts.len() == 1)
            && parts.iter().all(|s| !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))),
        "invalid npm package name"
    );
    let registry = source["registry"]
        .as_str()
        .unwrap_or("https://registry.npmjs.org")
        .trim_end_matches('/');
    let packument: Value =
        serde_json::from_slice(&http(&format!("{registry}/{}", name.replace('/', "%2f")))?)?;
    let selector = source["version"].as_str().unwrap_or("latest");
    let versions = packument["versions"]
        .as_object()
        .context("npm versions missing")?;
    let version = if versions.contains_key(selector) {
        selector.to_owned()
    } else if let Some(tag) = packument["dist-tags"][selector].as_str() {
        tag.into()
    } else {
        let req = node_semver::Range::parse(selector).context("unsupported npm version range")?;
        versions
            .keys()
            .filter_map(|v| node_semver::Version::parse(v).ok())
            .filter(|v| v.satisfies(&req))
            .max()
            .context("no matching npm version")?
            .to_string()
    };
    let manifest = &packument["versions"][&version];
    ensure!(
        manifest["name"] == name && manifest["version"] == version,
        "npm resolved identity mismatch"
    );
    let integrity = manifest["dist"]["integrity"]
        .as_str()
        .context("npm integrity missing")?;
    let archive = http(
        manifest["dist"]["tarball"]
            .as_str()
            .context("npm tarball missing")?,
    )?;
    let valid = integrity.split_whitespace().any(|token| {
        let Some((alg, hash)) = token.split_once('-') else {
            return false;
        };
        let actual = match alg {
            "sha512" => Sha512::digest(&archive).to_vec(),
            "sha256" => Sha256::digest(&archive).to_vec(),
            _ => return false,
        };
        base64::engine::general_purpose::STANDARD
            .decode(hash)
            .is_ok_and(|v| v == actual)
    });
    ensure!(valid, "npm archive integrity mismatch");
    unpack(&archive, stage)?;
    let package_files = package::snapshot(stage)?;
    let package_json: Value = serde_json::from_slice(
        &package_files
            .get("package.json")
            .context("npm package.json missing")?
            .bytes,
    )?;
    ensure!(
        package_json["name"] == name && package_json["version"] == version,
        "npm archive package identity mismatch"
    );
    Ok((version, integrity.into()))
}
pub(crate) fn publish(
    store: &Store,
    files: &package::Files,
    budget: SnapshotBudget,
) -> Result<PathBuf> {
    let digest = package::digest(files);
    let root = store.root.join("cache").join(&digest);
    if root.exists() {
        ensure!(
            package::digest(&package::snapshot_with_budget(&root, budget)?)
                == package::digest(files),
            "cache integrity mismatch"
        );
        return Ok(root);
    }
    let stage = tempfile::tempdir_in(store.root.join("staging"))?;
    use std::os::unix::fs::PermissionsExt;
    for (path, bytes) in files {
        let dest = stage.path().join(path);
        fs::create_dir_all(dest.parent().unwrap())?;
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&dest)?;
        file.write_all(&bytes.bytes)?;
        file.sync_all()?;
        fs::set_permissions(
            &dest,
            fs::Permissions::from_mode(if bytes.executable { 0o555 } else { 0o444 }),
        )?;
    }
    ensure!(
        package::digest(&package::snapshot_with_budget(stage.path(), budget)?) == digest,
        "published package path collision"
    );
    fs::rename(stage.path(), &root)?;
    seal_directory(&root)?;
    Ok(root)
}
impl Store {
    fn prepare_git_marketplace(
        &self,
        url: &str,
        reference: Option<&str>,
        sparse_paths: &[String],
    ) -> Result<(GitPin, package::Files, String)> {
        let url = normalize_git_url(url, &self.workspace)?;
        let stage = tempfile::tempdir_in(self.root.join("staging"))?;
        let commit = fetch_git_sparse(stage.path(), &url, reference, sparse_paths)?;
        let files = package::snapshot_with_budget(stage.path(), SnapshotBudget::Marketplace)?;
        let catalog = CATALOG_PATHS
            .iter()
            .find_map(|path| files.get(*path))
            .context("marketplace catalog missing")?;
        let value: Value = serde_json::from_slice(&catalog.bytes)?;
        let name = value["name"].as_str().context("marketplace name missing")?;
        ensure!(
            !name.is_empty()
                && name.len() <= 128
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)),
            "invalid marketplace name"
        );
        ensure!(
            value["plugins"].as_array().is_some_and(|p| p.len() <= 1024),
            "invalid marketplace plugins"
        );
        Ok((
            GitPin {
                url,
                reference: reference.map(str::to_owned),
                commit,
                sparse_paths: sparse_paths.to_vec(),
            },
            files,
            name.into(),
        ))
    }
    fn register_git_marketplace(
        &self,
        state: &mut crate::State,
        pin: GitPin,
        files: &package::Files,
        name: &str,
    ) -> Result<()> {
        // URL 是登记身份；内容摘要只是快照路径。推进 ref 不得留下同名旧目录。
        let replaced: Vec<_> = state
            .git_marketplaces
            .iter()
            .filter(|(_, old)| old.url == pin.url)
            .map(|(root, _)| root.clone())
            .collect();
        state.marketplaces.retain(|root| !replaced.contains(root));
        for root in replaced {
            state.git_marketplaces.remove(&root);
        }
        let (markets, _, _) = self.catalogs(state);
        ensure!(
            !markets.iter().any(|market| market.name == name),
            "marketplace name already registered by another source: {name}"
        );
        let root = publish(self, files, SnapshotBudget::Marketplace)?;
        state.marketplaces.push(root.clone());
        state.git_marketplaces.insert(root, pin);
        Ok(())
    }
    pub fn add_git_marketplace(
        &self,
        url: &str,
        reference: Option<&str>,
        expected_revision: u64,
    ) -> Result<PluginList> {
        self.add_git_marketplace_sparse(url, reference, &[], expected_revision)
    }
    pub fn add_git_marketplace_sparse(
        &self,
        url: &str,
        reference: Option<&str>,
        sparse_paths: &[String],
        expected_revision: u64,
    ) -> Result<PluginList> {
        let actual = self.state()?.revision;
        if actual != expected_revision {
            return Err(StoreError::Conflict {
                expected: expected_revision,
                actual,
            }
            .into());
        }
        let (pin, files, name) = self.prepare_git_marketplace(url, reference, sparse_paths)?;
        self.transact(expected_revision, |state| {
            self.register_git_marketplace(state, pin, &files, &name)
        })?;
        self.list()
    }
    pub fn update_marketplaces(&self, expected_revision: u64) -> Result<PluginList> {
        self.update_selected_marketplaces(None, expected_revision)
    }
    pub fn update_selected_marketplaces(
        &self,
        selected_name: Option<&str>,
        expected_revision: u64,
    ) -> Result<PluginList> {
        let state = self.state()?;
        if state.revision != expected_revision {
            return Err(StoreError::Conflict {
                expected: expected_revision,
                actual: state.revision,
            }
            .into());
        }
        let (markets, _, _) = self.catalogs(&state);
        let roots = markets
            .iter()
            .filter(|m| selected_name.is_none_or(|name| m.name == name))
            .map(|m| m.root.clone())
            .collect::<std::collections::BTreeSet<_>>();
        if let Some(name) = selected_name {
            ensure!(
                markets.iter().any(|m| m.name == name),
                "marketplace registration not found"
            );
        }
        let prepared = state
            .git_marketplaces
            .iter()
            .filter(|(root, _)| roots.contains(*root))
            .map(|(_, pin)| {
                self.prepare_git_marketplace(&pin.url, pin.reference.as_deref(), &pin.sparse_paths)
            })
            .collect::<Result<Vec<_>>>()?;
        if prepared.is_empty() {
            return self.list();
        }
        self.transact(expected_revision, |state| {
            for (pin, files, name) in prepared {
                self.register_git_marketplace(state, pin, &files, &name)?;
            }
            Ok(())
        })?;
        self.list()
    }
    pub fn remove_marketplace(&self, root: &Path, expected_revision: u64) -> Result<PluginList> {
        let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        self.transact(expected_revision, |state| {
            ensure!(
                state.marketplaces.contains(&root),
                "marketplace registration not found"
            );
            state.marketplaces.retain(|registered| registered != &root);
            state.git_marketplaces.remove(&root);
            Ok(())
        })?;
        self.list()
    }
    pub fn resolve_remote(&self, id: &str, expected_revision: u64) -> Result<PluginDetail> {
        let state = self.state()?;
        if state.revision != expected_revision {
            return Err(StoreError::Conflict {
                expected: expected_revision,
                actual: state.revision,
            }
            .into());
        }
        let (markets, details, _) = self.catalogs(&state);
        let selected = details
            .into_iter()
            .find(|d| d.id == id)
            .context("plugin source unavailable")?;
        if selected.catalog_source["type"] == "local" {
            let detail = self.read(id)?;
            if detail.revision != expected_revision {
                return Err(StoreError::Conflict {
                    expected: expected_revision,
                    actual: detail.revision,
                }
                .into());
            }
            return Ok(detail);
        }
        let mut entry = None;
        for market in markets {
            for path in CATALOG_PATHS {
                if !market.root.join(path).exists() {
                    continue;
                }
                let v: Value = serde_json::from_slice(&package::read_catalog(
                    &market.root,
                    &market.root.join(path),
                )?)?;
                for (index, e) in v["plugins"]
                    .as_array()
                    .context("plugins missing")?
                    .iter()
                    .enumerate()
                {
                    if identity(e, &market.root) == selected.source {
                        entry = Some((
                            e.clone(),
                            market.root.clone(),
                            package::CatalogContext {
                                entry: e.clone(),
                                origin: format!("{path}#/plugins/{index}"),
                            },
                        ));
                    }
                }
                break;
            }
        }
        let (entry, marketplace_root, context) = entry.context("remote source selector missing")?;
        let source = &selected.catalog_source;
        ensure!(
            matches!(source["type"].as_str(), Some("git" | "npm")),
            "sourceUnsupported: source cannot be resolved"
        );
        let stage = tempfile::tempdir_in(self.root.join("staging"))?;
        let mut commit = None;
        let mut version = None;
        let mut integrity = None;
        let content = if source["type"].as_str() == Some("npm") {
            let (v, i) = fetch_npm(source, stage.path())?;
            version = Some(v);
            integrity = Some(i);
            stage.path().to_owned()
        } else {
            let sha = source["sha"].as_str();
            let pin = fetch_git(
                stage.path(),
                &normalize_git_url(
                    source["url"].as_str().context("Git URL missing")?,
                    &marketplace_root,
                )?,
                sha.or(source["refName"].as_str()),
            )?;
            if let Some(sha) = sha {
                ensure!(sha == pin, "Git commit mismatch");
            }
            commit = Some(pin);
            match source["path"].as_str() {
                Some(path) => stage.path().join(package::relative(path)?),
                None => stage.path().to_owned(),
            }
        };
        let files = package::snapshot(&content)?;
        let cache = self.root.join("cache").join(package::digest(&files));
        let (mut detail, _) =
            package::parse_context(&files, id, &selected.source, &cache, Some(&context))?;
        ensure!(
            detail.name == selected.name,
            "catalog/manifest plugin name mismatch"
        );
        detail.interface = crate::metadata::catalog_interface(detail.interface, &entry);
        detail.catalog_source = selected.catalog_source;
        detail.policy = selected.policy;
        detail.source_kind = selected.source_kind;
        detail.resolved_commit = commit;
        detail.package_version = version;
        detail.integrity = integrity;
        if detail.definition.is_some() {
            package::bind_definition(&mut detail, context)?;
        }
        self.transact(expected_revision, |s| {
            let (_, current, _) = self.catalogs(s);
            ensure!(
                current
                    .iter()
                    .any(|d| d.id == id && d.source == detail.source),
                "remote source changed during resolution"
            );
            let root = publish(self, &files, SnapshotBudget::Plugin)?;
            s.candidates.insert(
                id.into(),
                Candidate {
                    detail: detail.clone(),
                    root,
                    definition: detail.definition.clone(),
                },
            );
            Ok(())
        })?;
        self.read(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pinned_git_source_forms_and_unsafe_inputs() {
        let root = Path::new("/fixture/marketplace");
        for (input, expected) in [
            ("./repo", "/fixture/marketplace/repo"),
            (".\\repo", "/fixture/marketplace/repo"),
            (
                "ssh://git@github.com/openai/plugins.git",
                "ssh://git@github.com/openai/plugins.git",
            ),
            (
                "git@github.com:openai/plugins.git",
                "git@github.com:openai/plugins.git",
            ),
            ("openai/plugins", "https://github.com/openai/plugins.git"),
            (
                "https://github.com/openai/plugins",
                "https://github.com/openai/plugins.git",
            ),
        ] {
            assert_eq!(normalize_git_url(input, root).unwrap(), expected, "{input}");
        }
        for input in [
            "../repo",
            "./nested/../repo",
            "ext::sh -c touch /tmp/signal",
            "-oProxyCommand=sh",
            "ssh://git@host/repo;touch",
            "git@host:repo$(touch)",
            "file://remotehost/repo",
            "owner/../repo",
            "git@host:../repo",
            "file:///fixture/%2e%2e/repo",
            "ssh://-oProxyCommand=sh/repo",
        ] {
            assert!(normalize_git_url(input, root).is_err(), "accepted {input}");
        }
    }
}
