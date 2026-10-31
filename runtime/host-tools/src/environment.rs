//! 可信启动 PATH 的软件工具链投影；只接入程序资源，不导入凭据或任意 home 目录。
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug)]
pub struct CommandEnvironment {
    pub path: String,
    pub unrestricted_path: String,
    pub read_only_toolchains: Vec<PathBuf>,
    pub notices: Vec<String>,
}

pub fn command_environment(path: &OsStr) -> CommandEnvironment {
    // Finder/LaunchServices 不读取交互式 shell 配置，PATH 常常只有系统目录。
    // 仅补充已存在且未重定向的标准安装前缀，仍复用下面的只读资源白名单。
    let defaults: &[&Path] = if cfg!(target_os = "macos") {
        &[Path::new("/opt/homebrew"), Path::new("/usr/local")]
    } else {
        &[]
    };
    #[allow(unused_mut)]
    let mut environment = project_environment(path, defaults, &crate::deployment_environment());
    // macOS 的 libcurl/LibreSSL 在 cargo 等程序启动时读取系统公共 TLS 配置。
    // 不能因此开放整个 /etc；与第三方前缀使用相同的逐项公共资源规则。
    #[cfg(target_os = "macos")]
    environment
        .read_only_toolchains
        .extend(public_tls_resources(Path::new("/private")));
    environment
}

fn project_environment(
    path: &OsStr,
    defaults: &[&Path],
    env: &BTreeMap<String, OsString>,
) -> CommandEnvironment {
    let startup: Vec<_> = std::env::split_paths(path)
        .filter(|p| p.is_absolute())
        .collect();
    let managed = crate::managed::discover(&startup, env);
    let mut candidates = Vec::new();
    for entry in &startup {
        match managed.replacements.get(entry).or_else(|| {
            entry
                .canonicalize()
                .ok()
                .as_ref()
                .and_then(|p| managed.replacements.get(p))
        }) {
            Some(replacements) => candidates.extend(replacements.iter().cloned()),
            None => candidates.push(entry.clone()),
        }
    }
    // 只补充未激活的默认工具；已有显式路径顺序保持不变。
    candidates.extend(managed.bins.iter().cloned());
    let mut unrestricted: Vec<_> = startup.clone();
    unrestricted.extend(managed.bins.iter().cloned());
    for prefix in defaults {
        if prefix.canonicalize().ok().as_deref() != Some(*prefix) {
            continue;
        }
        for name in ["bin", "sbin"] {
            let entry = prefix.join(name);
            if entry
                .canonicalize()
                .is_ok_and(|p| p.starts_with(prefix) && p.is_dir())
                && !candidates.contains(&entry)
            {
                candidates.push(entry);
            }
        }
    }
    let mut entries = Vec::new();
    let mut prefixes = Vec::new();
    for entry in candidates {
        let Some(text) = entry.to_str() else {
            continue;
        };
        let prefix = ["/opt/homebrew", "/usr/local"].into_iter().find(|prefix| {
            entry == Path::new(prefix).join("bin") || entry == Path::new(prefix).join("sbin")
        });
        // 任意绝对部署 PATH 可以保留，但只有已识别安装树获得额外只读权限。
        if !entries.iter().any(|old| old == text) {
            entries.push(text.to_owned());
        }
        if let Some(prefix) = prefix
            && !prefixes.contains(&prefix)
        {
            prefixes.push(prefix);
        }
    }
    // 已知系统目录作为后备；保留可信部署中已接入工具链的优先级。
    for system in ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
        if !entries.iter().any(|old| old == system) {
            entries.push(system.to_owned());
        }
    }
    let mut read_only_toolchains = managed.roots;
    for prefix in prefixes {
        let prefix = Path::new(prefix);
        // 不接受把安装前缀重定向到用户目录的部署，避免借 PATH 获得任意内容读取。
        if prefix.canonicalize().ok().as_deref() != Some(prefix) {
            continue;
        }
        for name in [
            "bin",
            "sbin",
            "lib",
            "lib64",
            "libexec",
            "include",
            "share",
            "opt",
            "Cellar",
            "Frameworks",
        ] {
            let path = prefix.join(name);
            if let Ok(actual) = path.canonicalize()
                && actual.starts_with(prefix)
                && actual.is_dir()
                && !read_only_toolchains.contains(&actual)
            {
                read_only_toolchains.push(actual);
            }
        }
        // OpenSSL 的公共启动配置和 CA 资源通常位于安装前缀的 etc 中。
        // 只接入这些具体资源，不能因此开放相邻服务配置或 private 私钥目录。
        for path in public_tls_resources(prefix) {
            if !read_only_toolchains.contains(&path) {
                read_only_toolchains.push(path);
            }
        }
    }
    for entry in &entries {
        let path = PathBuf::from(entry);
        if !unrestricted.contains(&path) {
            unrestricted.push(path);
        }
    }
    let mut unique = Vec::new();
    for path in unrestricted {
        if !unique.contains(&path) {
            unique.push(path);
        }
    }
    CommandEnvironment {
        path: entries.join(":"),
        unrestricted_path: std::env::join_paths(unique)
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        read_only_toolchains,
        notices: managed.notices,
    }
}

fn public_tls_resources(prefix: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let Ok(entries) = std::fs::read_dir(prefix.join("etc")) else {
        return roots;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let openssl = name == "openssl"
            || name.strip_prefix("openssl@").is_some_and(|version| {
                !version.is_empty() && version.bytes().all(|b| b.is_ascii_digit() || b == b'.')
            });
        if name != "ssl" && !openssl {
            continue;
        }
        for resource in ["openssl.cnf", "cert.pem", "certs"] {
            let path = entry.path().join(resource);
            if let Ok(actual) = path.canonicalize()
                && actual.starts_with(prefix)
                && (actual.is_file() || actual.is_dir())
                && !roots.contains(&actual)
            {
                roots.push(actual);
            }
        }
    }
    roots.sort();
    roots
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn desktop_launch_finds_installed_toolchains_without_shell_startup_files() {
        let value = command_environment(OsStr::new("/usr/bin:/bin:/usr/sbin:/sbin"));
        for prefix in ["/opt/homebrew", "/usr/local"] {
            let bin = Path::new(prefix).join("bin");
            if bin.is_dir()
                && Path::new(prefix).canonicalize().ok().as_deref() == Some(Path::new(prefix))
            {
                assert!(
                    std::env::split_paths(&value.path).any(|p| p == bin),
                    "{} missing {bin:?}",
                    value.path
                );
                assert!(
                    value
                        .read_only_toolchains
                        .contains(&bin.canonicalize().unwrap())
                );
            }
        }
    }

    #[test]
    fn deployment_projection_preserves_absolute_paths_without_granting_unknown_roots() {
        let value = project_environment(
            OsStr::new(
                ".:/tmp/tools:/Users/example/.nvm/bin:/opt/homebrew/bin:/usr/bin:/opt/homebrew/bin:/usr/local/sbin:/bin",
            ),
            &[],
            &BTreeMap::new(),
        );
        assert_eq!(
            value.path,
            "/tmp/tools:/Users/example/.nvm/bin:/opt/homebrew/bin:/usr/bin:/usr/local/sbin:/bin:/usr/sbin:/sbin"
        );
        assert!(
            value
                .read_only_toolchains
                .iter()
                .all(|p| !p.ends_with("etc") && !p.ends_with("var") && !p.starts_with("/Users"))
        );
    }

    #[test]
    fn tls_resources_exclude_private_keys_other_configs_and_redirected_files() {
        let fixture = tempfile::tempdir().unwrap();
        let prefix = fixture.path().canonicalize().unwrap();
        let tls = prefix.join("etc/openssl@3");
        std::fs::create_dir_all(tls.join("private")).unwrap();
        std::fs::create_dir(tls.join("certs")).unwrap();
        std::fs::write(tls.join("openssl.cnf"), "[openssl_init]\n").unwrap();
        std::fs::write(tls.join("private/key.pem"), "private").unwrap();
        std::fs::create_dir_all(prefix.join("etc/service")).unwrap();
        std::fs::write(prefix.join("etc/service/password"), "secret").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/passwd", tls.join("cert.pem")).unwrap();
        let roots = public_tls_resources(&prefix);
        assert_eq!(roots, vec![tls.join("certs"), tls.join("openssl.cnf")]);
    }

    #[test]
    fn restricted_shim_resolution_preserves_explicit_order_and_host_shim_semantics() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        let install = home.join(".local/share/mise/installs/node/22.1.0");
        std::fs::create_dir_all(install.join("bin")).unwrap();
        let shim = home.join(".local/share/mise/shims");
        std::fs::create_dir_all(&shim).unwrap();
        let input =
            std::env::join_paths([Path::new("/explicit/bin"), &shim, Path::new("/usr/bin")])
                .unwrap();
        let env = BTreeMap::from([("HOME".into(), home.clone().into_os_string())]);
        let value = project_environment(&input, &[], &env);
        let restricted: Vec<_> = std::env::split_paths(&value.path).collect();
        let host: Vec<_> = std::env::split_paths(&value.unrestricted_path).collect();
        assert_eq!(
            &restricted[..3],
            &[
                PathBuf::from("/explicit/bin"),
                install.join("bin"),
                PathBuf::from("/usr/bin")
            ]
        );
        assert_eq!(
            &host[..3],
            &[
                PathBuf::from("/explicit/bin"),
                shim,
                PathBuf::from("/usr/bin")
            ]
        );
        assert_eq!(value.read_only_toolchains, [install]);
    }

    #[cfg(unix)]
    #[test]
    fn homebrew_rustup_projection_selects_real_cargo_and_preserves_custom_priority() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        let rust = home.join(".rustup/toolchains/stable-test-target");
        std::fs::create_dir_all(rust.join("bin")).unwrap();
        std::fs::write(
            home.join(".rustup/settings.toml"),
            "default_toolchain = 'stable-test-target'\n",
        )
        .unwrap();
        let custom = home.join("custom/bin");
        std::fs::create_dir_all(&custom).unwrap();
        for (bin, output) in [(&rust.join("bin"), "selected"), (&custom, "custom")] {
            std::fs::write(bin.join("cargo"), format!("#!/bin/sh\nprintf '{output}'\n")).unwrap();
            std::fs::set_permissions(bin.join("cargo"), std::fs::Permissions::from_mode(0o755))
                .unwrap();
        }
        let env = BTreeMap::from([("HOME".into(), home.clone().into_os_string())]);
        for prefix in ["/opt/homebrew", "/usr/local"] {
            for relative in [
                "opt/rustup/bin",
                "opt/rustup/libexec/bin",
                "Cellar/rustup/1.29.0_2/bin",
                "Cellar/rustup/1.29.0_2/libexec/bin",
            ] {
                let shim = Path::new(prefix).join(relative);
                for explicit in [false, true] {
                    let mut startup = Vec::new();
                    if explicit {
                        startup.push(custom.clone());
                    }
                    startup.extend([shim.clone(), PathBuf::from("/usr/bin")]);
                    let input = std::env::join_paths(&startup).unwrap();
                    let value = project_environment(&input, &[], &env);
                    let restricted: Vec<_> = std::env::split_paths(&value.path).collect();
                    assert_eq!(restricted[usize::from(explicit)], rust.join("bin"));
                    let host: Vec<_> = std::env::split_paths(&value.unrestricted_path).collect();
                    assert_eq!(&host[..startup.len()], startup);
                    let output = std::process::Command::new("/bin/sh")
                        .args(["-c", "cargo"])
                        .env_clear()
                        .env("HOME", home.join("scratch"))
                        .env("PATH", &value.path)
                        .output()
                        .unwrap();
                    assert!(output.status.success());
                    assert_eq!(
                        output.stdout,
                        if explicit { "custom" } else { "selected" }.as_bytes()
                    );
                    for private in [
                        ".cargo/credentials.toml",
                        ".rustup/settings.toml",
                        ".ssh/key",
                    ] {
                        assert!(
                            !value
                                .read_only_toolchains
                                .iter()
                                .any(|p| home.join(private).starts_with(p))
                        );
                    }
                }
            }
        }
    }
}
