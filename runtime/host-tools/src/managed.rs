//! 在可信启动边界解析已安装版本；不运行 shim、shell 配置、插件或安装器。
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

const MAX_ENTRIES: usize = 256;
const MAX_CONFIG: u64 = 64 * 1024;
const DIRECTORY_VARIABLES: &[&str] = &[
    "HOME",
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "NVM_DIR",
    "FNM_DIR",
    "VOLTA_HOME",
    "MISE_DATA_DIR",
    "MISE_CONFIG_DIR",
    "MISE_INSTALLS_DIR",
    "ASDF_DATA_DIR",
    "PYENV_ROOT",
    "RBENV_ROOT",
    "RUSTUP_HOME",
    "CARGO_HOME",
    "PNPM_HOME",
    "BUN_INSTALL",
    "DENO_INSTALL",
];
const VERSION_VARIABLES: &[&str] = &["RUSTUP_TOOLCHAIN", "PYENV_VERSION", "RBENV_VERSION"];

/// 只传递发现所需的路径/版本提示到 Runtime，绝不直接注入受限任务。
pub fn deployment_environment() -> BTreeMap<String, OsString> {
    let mut values = BTreeMap::new();
    for name in DIRECTORY_VARIABLES.iter().chain(VERSION_VARIABLES) {
        if let Some(value) = std::env::var_os(name)
            && value
                .to_str()
                .is_some_and(|s| s.len() <= 4096 && !s.contains('\0'))
            && (!DIRECTORY_VARIABLES.contains(name) || clean_absolute(Path::new(&value)))
        {
            values.insert((*name).into(), value);
        }
    }
    values
}

#[derive(Default)]
pub(super) struct Managed {
    pub replacements: BTreeMap<PathBuf, Vec<PathBuf>>,
    pub bins: Vec<PathBuf>,
    pub roots: Vec<PathBuf>,
    pub notices: Vec<String>,
}

fn clean_absolute(path: &Path) -> bool {
    path.is_absolute()
        && !path
            .components()
            .any(|p| matches!(p, Component::ParentDir | Component::CurDir))
}

fn stable_directory(path: &Path) -> bool {
    clean_absolute(path) && path.is_dir() && path.canonicalize().ok().as_deref() == Some(path)
}

fn inside(path: &Path, root: &Path) -> Option<PathBuf> {
    let actual = path.canonicalize().ok()?;
    (actual.starts_with(root) && actual != root).then_some(actual)
}

fn small_file(path: &Path) -> Option<String> {
    // 拒绝 FIFO/设备及过大配置，别名循环和异常文件不能阻塞启动。
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > MAX_CONFIG {
        return None;
    }
    let mut value = String::new();
    file.take(MAX_CONFIG + 1).read_to_string(&mut value).ok()?;
    (value.len() as u64 <= MAX_CONFIG).then_some(value)
}

fn children(path: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(path) else {
        return Vec::new();
    };
    let mut paths: Vec<_> = entries
        .take(MAX_ENTRIES + 1)
        .filter_map(Result::ok)
        .map(|e| e.path())
        .collect();
    if paths.len() > MAX_ENTRIES {
        return Vec::new();
    }
    paths.sort();
    paths
}

fn component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-+".contains(&b))
}

fn numbers(value: &str) -> Option<Vec<u64>> {
    value
        .trim_start_matches('v')
        .split('.')
        .map(|part| part.parse().ok())
        .collect()
}

fn bin_directory(root: &Path, suffix: &str) -> Option<PathBuf> {
    if suffix != "auto" {
        return root.join(suffix).is_dir().then(|| root.join(suffix));
    }
    for suffix in ["bin", "Contents/Home/bin"] {
        let bin = root.join(suffix);
        if bin.is_dir() {
            return Some(bin);
        }
    }
    // 部分单文件工具直接放在安装目录，不通过任意插件求值 bin_paths。
    children(root)
        .iter()
        .any(|p| {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            }
            #[cfg(not(unix))]
            {
                p.is_file()
            }
        })
        .then(|| root.to_owned())
}

/// 只在已安装集合中解析；未设置默认且有多个版本时拒绝猜测。
fn select(base: &Path, requested: Option<&str>, suffix: &str) -> Option<PathBuf> {
    if !stable_directory(base) {
        return None;
    }
    if let Some(request) = requested {
        if !component(request) || request == "system" {
            return None;
        }
        let exact = base.join(request);
        if fs::symlink_metadata(&exact).is_ok() {
            return inside(&exact, base).filter(|root| bin_directory(root, suffix).is_some());
        }
    }
    let mut candidates = Vec::new();
    for path in children(base) {
        let Some(root) = inside(&path, base) else {
            continue;
        };
        if bin_directory(&root, suffix).is_none() {
            continue;
        }
        if let Some(request) = requested {
            let name = path.file_name()?.to_str()?;
            let matches = if matches!(request, "node" | "stable" | "latest") {
                numbers(name).is_some()
            } else if let Some(prefix) = numbers(request) {
                numbers(name).is_some_and(|version| version.starts_with(&prefix))
            } else {
                name.strip_prefix(request)
                    .is_some_and(|tail| tail.starts_with('-'))
            };
            if !matches {
                continue;
            }
        }
        if !candidates.contains(&root) {
            candidates.push(root);
        }
    }
    if candidates.len() == 1 {
        return candidates.pop();
    }
    if requested.is_some_and(|s| numbers(s).is_some() || matches!(s, "node" | "stable" | "latest"))
    {
        candidates.sort_by_key(|p| p.file_name().and_then(|n| n.to_str()).and_then(numbers));
        return candidates.pop();
    }
    None
}

fn nvm_default(root: &Path) -> Option<String> {
    let mut name = "default".to_owned();
    for _ in 0..16 {
        if !(component(&name)
            || name
                .strip_prefix("lts/")
                .is_some_and(|s| component(s) || s == "*"))
        {
            return Some("/unsupported/".into());
        }
        match small_file(&root.join("alias").join(&name)) {
            Some(value) => name = value.trim().to_owned(),
            None if fs::symlink_metadata(root.join("alias").join(&name)).is_ok() => {
                return Some("/unsupported/".into());
            }
            None if name == "default" => return None,
            None => return Some(name),
        }
    }
    Some("/unsupported/".into())
}

fn tool_versions(path: &Path) -> Option<BTreeMap<String, String>> {
    if !path.try_exists().unwrap_or(true) {
        return Some(BTreeMap::new());
    }
    Some(
        small_file(path)?
            .lines()
            .filter_map(|line| {
                let mut words = line.split('#').next()?.split_whitespace();
                Some((words.next()?.to_owned(), words.next()?.to_owned()))
            })
            .collect(),
    )
}

fn toml_tools(path: &Path) -> Option<BTreeMap<String, String>> {
    if !path.try_exists().unwrap_or(true) {
        return Some(BTreeMap::new());
    }
    let document = small_file(path)?.parse::<toml_edit::DocumentMut>().ok()?;
    let Some(table) = document
        .get("tools")
        .and_then(toml_edit::Item::as_table_like)
    else {
        return Some(BTreeMap::new());
    };
    Some(
        table
            .iter()
            .map(|(name, item)| {
                let version = item
                    .as_str()
                    .or_else(|| {
                        item.as_array()
                            .and_then(|a| a.get(0))
                            .and_then(toml_edit::Value::as_str)
                    })
                    .or_else(|| item.get("version").and_then(toml_edit::Item::as_str));
                (
                    name.to_owned(),
                    version.unwrap_or("/unsupported/").to_owned(),
                )
            })
            .collect(),
    )
}

fn homebrew_rustup_prefix(path: &Path) -> Option<&'static Path> {
    [Path::new("/opt/homebrew"), Path::new("/usr/local")]
        .into_iter()
        .find(|prefix| {
            let Ok(relative) = path.strip_prefix(prefix) else {
                return false;
            };
            if relative == Path::new("opt/rustup/bin")
                || relative == Path::new("opt/rustup/libexec/bin")
            {
                return true;
            }
            let Ok(install) = relative.strip_prefix("Cellar/rustup") else {
                return false;
            };
            install.to_str().is_some_and(|install| {
                install
                    .strip_suffix("/libexec/bin")
                    .or_else(|| install.strip_suffix("/bin"))
                    .is_some_and(component)
            })
        })
}

fn rustup_default(settings: &Path, fallback: Option<&Path>) -> Option<String> {
    for path in std::iter::once(settings).chain(fallback) {
        if fs::symlink_metadata(path)
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
        {
            continue;
        }
        let Some(document) =
            small_file(path).and_then(|value| value.parse::<toml_edit::DocumentMut>().ok())
        else {
            return Some("/unsupported/".into());
        };
        if let Some(default) = document.get("default_toolchain") {
            return Some(default.as_str().unwrap_or("/unsupported/").to_owned());
        }
    }
    None
}

impl Managed {
    fn add(&mut self, root: &Path, bin: &Path) -> Option<PathBuf> {
        if !stable_directory(root) {
            return None;
        }
        let actual = bin.canonicalize().ok()?;
        if !actual.is_dir() || !actual.starts_with(root) || std::env::join_paths([&actual]).is_err()
        {
            return None;
        }
        if !self.roots.contains(&root.to_owned()) {
            self.roots.push(root.to_owned());
        }
        if !self.bins.contains(&actual) {
            self.bins.push(actual.clone());
        }
        Some(actual)
    }

    fn collection(
        &mut self,
        base: &Path,
        preferred: Option<&str>,
        suffix: &str,
        startup: &[PathBuf],
    ) -> Vec<PathBuf> {
        if !stable_directory(base) {
            return Vec::new();
        }
        let mut bins = Vec::new();
        // 激活过的具体 PATH 比全局默认优先；fnm 的临时符号链接也解析成固定安装。
        for entry in startup {
            let Some(actual) = inside(entry, base) else {
                continue;
            };
            let Some(root) = actual.ancestors().find(|p| p.parent() == Some(base)) else {
                continue;
            };
            if Some(actual.clone()) == bin_directory(root, suffix)
                && let Some(bin) = self.add(root, &actual)
            {
                self.replacements.insert(entry.clone(), vec![bin.clone()]);
                if !bins.contains(&bin) {
                    bins.push(bin);
                }
            }
        }
        if bins.is_empty() {
            if let Some(root) = select(base, preferred, suffix)
                && let Some(bin) = bin_directory(&root, suffix)
                && let Some(bin) = self.add(&root, &bin)
            {
                bins.push(bin);
            } else if !children(base).is_empty() {
                self.notices.push(format!("No unambiguous installed default in {}; select an installed version in the launch PATH or manager configuration", base.display()));
            }
        }
        bins
    }

    fn shim(&mut self, path: PathBuf, bins: Vec<PathBuf>) {
        // 受限 HOME 下不能运行依赖宿主状态的 shim；完整授权路径保持原样。
        self.replacements.insert(path, bins);
    }

    fn linked_resources(&mut self, bin: &Path, stores: &[PathBuf]) {
        for entry in children(bin) {
            let Ok(target) = entry.canonicalize() else {
                continue;
            };
            for store in stores {
                if !stable_directory(store) || !target.starts_with(store) {
                    continue;
                }
                let Some(root) = target.ancestors().find(|p| p.parent() == Some(store)) else {
                    continue;
                };
                if stable_directory(root) && !self.roots.contains(&root.to_owned()) {
                    self.roots.push(root.to_owned());
                    // uv/pipx venv 的 Python 可链接到 uv 的独立解释器安装。
                    for python in ["python", "python3"] {
                        let Ok(interpreter) = root.join("bin").join(python).canonicalize() else {
                            continue;
                        };
                        for store in stores {
                            if !stable_directory(store) || !interpreter.starts_with(store) {
                                continue;
                            }
                            if let Some(runtime) =
                                interpreter.ancestors().find(|p| p.parent() == Some(store))
                                && stable_directory(runtime)
                                && !self.roots.contains(&runtime.to_owned())
                            {
                                self.roots.push(runtime.to_owned());
                            }
                        }
                    }
                }
            }
        }
    }
}

pub(super) fn discover(startup: &[PathBuf], env: &BTreeMap<String, OsString>) -> Managed {
    let mut found = Managed::default();
    let Some(home) = env
        .get("HOME")
        .map(PathBuf::from)
        .filter(|p| clean_absolute(p))
        .and_then(|p| p.canonicalize().ok())
    else {
        return found;
    };
    let setting = |key: &str, default: PathBuf| -> PathBuf {
        let path = env
            .get(key)
            .map(PathBuf::from)
            .filter(|p| clean_absolute(p))
            .unwrap_or(default);
        path.canonicalize().unwrap_or(path)
    };
    let text = |key: &str| env.get(key).and_then(|s| s.to_str());
    let data = setting("XDG_DATA_HOME", home.join(".local/share"));
    let config = setting("XDG_CONFIG_HOME", home.join(".config"));

    let nvm = setting(
        "NVM_DIR",
        if env.contains_key("XDG_CONFIG_HOME") {
            config.join("nvm")
        } else {
            home.join(".nvm")
        },
    );
    if stable_directory(&nvm) {
        found.collection(
            &nvm.join("versions/node"),
            nvm_default(&nvm).as_deref(),
            "bin",
            startup,
        );
    }
    let fnm_default_root = if cfg!(target_os = "macos") {
        home.join("Library/Application Support/fnm")
    } else {
        data.join("fnm")
    };
    let fnm = setting("FNM_DIR", fnm_default_root);
    let fnm_roots = if env.contains_key("FNM_DIR") {
        vec![fnm]
    } else {
        vec![fnm, data.join("fnm"), home.join(".fnm")]
    };
    for root in fnm_roots {
        if !stable_directory(&root) {
            continue;
        }
        let base = root.join("node-versions");
        let selected = inside(&root.join("aliases/default"), &base).and_then(|p| {
            p.strip_prefix(&base)
                .ok()?
                .components()
                .next()?
                .as_os_str()
                .to_str()
                .map(str::to_owned)
        });
        found.collection(&base, selected.as_deref(), "installation/bin", startup);
    }

    let mise = setting("MISE_DATA_DIR", data.join("mise"));
    let mise_config = setting("MISE_CONFIG_DIR", config.join("mise"));
    let mise_installs = setting("MISE_INSTALLS_DIR", mise.join("installs"));
    let asdf = setting("ASDF_DATA_DIR", home.join(".asdf"));
    for (base, shim, versions) in [
        (
            mise_installs,
            mise.join("shims"),
            toml_tools(&mise_config.join("config.toml")),
        ),
        (
            asdf.join("installs"),
            asdf.join("shims"),
            tool_versions(&home.join(".tool-versions")),
        ),
    ] {
        if !stable_directory(&base) {
            continue;
        }
        if versions.is_none() {
            found.notices.push(format!(
                "Cannot read a bounded literal manager configuration for {}",
                base.display()
            ));
        }
        let mut bins = Vec::new();
        for tool in children(&base) {
            let Some(name) = tool.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if !component(name) || name.starts_with('.') {
                continue;
            }
            bins.extend(found.collection(
                &tool,
                versions.as_ref().map_or(Some("/unsupported/"), |versions| {
                    versions.get(name).map(String::as_str)
                }),
                "auto",
                startup,
            ));
        }
        found.shim(shim, bins);
    }

    for (variable, directory, version_variable) in [
        ("PYENV_ROOT", ".pyenv", "PYENV_VERSION"),
        ("RBENV_ROOT", ".rbenv", "RBENV_VERSION"),
    ] {
        let root = setting(variable, home.join(directory));
        if !stable_directory(&root) {
            continue;
        }
        let default = small_file(&root.join("version"));
        let selected = text(version_variable)
            .or(default.as_deref())
            .and_then(|s| s.split_whitespace().next());
        let bins = found.collection(&root.join("versions"), selected, "bin", startup);
        found.shim(root.join("shims"), bins);
    }

    let rustup = setting("RUSTUP_HOME", home.join(".rustup"));
    let cargo = setting("CARGO_HOME", home.join(".cargo"));
    if stable_directory(&rustup) {
        let shims: Vec<_> = startup
            .iter()
            .filter_map(|entry| {
                let prefix = homebrew_rustup_prefix(entry).or_else(|| {
                    entry
                        .canonicalize()
                        .ok()
                        .as_deref()
                        .and_then(homebrew_rustup_prefix)
                })?;
                Some((entry, prefix))
            })
            .collect();
        let prefix = shims
            .first()
            .map(|(_, prefix)| *prefix)
            .filter(|prefix| stable_directory(prefix))
            .or_else(|| {
                [Path::new("/opt/homebrew"), Path::new("/usr/local")]
                    .into_iter()
                    .find(|prefix| {
                        stable_directory(prefix)
                            && prefix
                                .join("opt/rustup/bin")
                                .canonicalize()
                                .is_ok_and(|bin| bin.starts_with(prefix) && bin.is_dir())
                    })
            });
        let fallback = prefix.map(|prefix| prefix.join("etc/rustup/settings.toml"));
        let default = rustup_default(&rustup.join("settings.toml"), fallback.as_deref());
        let toolchains = rustup.join("toolchains");
        let preferred = text("RUSTUP_TOOLCHAIN")
            .or(default.as_deref())
            .map(|request| {
                if !component(request) || fs::symlink_metadata(toolchains.join(request)).is_ok() {
                    return request.to_owned();
                }
                let matches: Vec<_> = children(&toolchains)
                    .into_iter()
                    .filter_map(|path| {
                        let name = path.file_name()?.to_str()?;
                        name.strip_prefix(request)
                            .filter(|tail| tail.starts_with('-'))?;
                        bin_directory(&inside(&path, &toolchains)?, "bin")?;
                        Some(name.to_owned())
                    })
                    .collect();
                match matches.as_slice() {
                    [selected] => selected.clone(),
                    _ => "/unsupported/".into(),
                }
            });
        let mut bins = found.collection(&toolchains, preferred.as_deref(), "bin", startup);
        if let Some(bin) = found.add(&cargo.join("bin"), &cargo.join("bin")) {
            bins.push(bin);
        }
        for (shim, _) in shims {
            found.shim(shim.clone(), bins.clone());
        }
        found.shim(cargo.join("bin"), bins);
    }

    let volta = setting("VOLTA_HOME", home.join(".volta"));
    if stable_directory(&volta) {
        let defaults: serde_json::Value = small_file(&volta.join("tools/user/platform.json"))
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let mut bins = Vec::new();
        // 包管理器必须先于 Node 附带的 npm，以保持显式默认版本。
        for tool in ["npm", "pnpm", "yarn", "node"] {
            bins.extend(found.collection(
                &volta.join("tools/image").join(tool),
                defaults[tool].as_str(),
                "auto",
                startup,
            ));
        }
        found.shim(volta.join("bin"), bins);
    }

    // 独立 CLI 只读 bin；不会为了 uv、pipx、pnpm 等开放整个用户数据目录。
    let stores = [
        data.join("uv/tools"),
        data.join("uv/python"),
        data.join("pipx/venvs"),
        home.join(".local/pipx/venvs"),
    ];
    for bin in [
        home.join(".local/bin"),
        cargo.join("bin"),
        setting("BUN_INSTALL", home.join(".bun")).join("bin"),
        setting("DENO_INSTALL", home.join(".deno")).join("bin"),
        setting(
            "PNPM_HOME",
            if cfg!(target_os = "macos") {
                home.join("Library/pnpm")
            } else {
                data.join("pnpm")
            },
        ),
    ] {
        found.add(&bin, &bin);
        found.linked_resources(&bin, &stores);
    }
    found.roots.sort();
    found.roots.dedup();
    found.notices.sort();
    found.notices.dedup();
    found
}

#[cfg(test)]
mod tests;
