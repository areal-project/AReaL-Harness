//! 可信宿主的工具发现；不执行任务脚本，不读取模型或工作区配置。
mod environment;
mod managed;
pub use environment::{CommandEnvironment, command_environment};
pub use managed::deployment_environment;
use std::{
    io,
    path::{Path, PathBuf},
};

/// Network configuration for explicitly authorized host network access.
pub fn network_environment() -> std::collections::BTreeMap<String, std::ffi::OsString> {
    [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "NODE_EXTRA_CA_CERTS",
        "REQUESTS_CA_BUNDLE",
        "CURL_CA_BUNDLE",
        "GIT_SSL_CAINFO",
    ]
    .into_iter()
    .filter_map(|key| std::env::var_os(key).map(|value| (key.to_owned(), value)))
    .collect()
}

/// Core 工具与 Runtime 命令使用同一解释器和路径校验规则。
pub fn system_python() -> io::Result<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        static PYTHON: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
        if let Some(python) = PYTHON.get() {
            return Ok(python.clone());
        }
        let python = discover_macos_python(
            |program, args| {
                let output = std::process::Command::new(program)
                    .args(args)
                    .env_clear()
                    .env("PATH", "/usr/bin:/bin")
                    .stdin(std::process::Stdio::null())
                    .output()?;
                if !output.status.success() {
                    return Err(io::Error::new(
                        io::ErrorKind::NotFound,
                        "xcrun could not locate Python; select an installed Xcode or Command Line Tools",
                    ));
                }
                String::from_utf8(output.stdout).map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        "xcrun returned a non-UTF-8 Python path",
                    )
                })
            },
            |path| std::fs::canonicalize(path),
        )?;
        use std::os::unix::fs::PermissionsExt;
        let metadata = std::fs::metadata(&python)?;
        if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "system Python is not executable",
            ));
        }
        // 只缓存成功发现；安装缺失时允许之后重试。不继承 DEVELOPER_DIR 或宿主 PATH。
        let _ = PYTHON.set(python.clone());
        Ok(python)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let path = std::env::var_os("PATH").unwrap_or_default();
        discover_linux_python(&path)
    }
}

/// 在可信宿主解析 Apple Git 入口，任务不需要读取开发工具链选择状态。
#[cfg(target_os = "macos")]
pub fn system_git() -> io::Result<PathBuf> {
    static GIT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    if let Some(git) = GIT.get() {
        return Ok(git.clone());
    }
    let git = discover_macos_git(
        || {
            let output = std::process::Command::new("/usr/bin/xcrun")
                .args(["--find", "git"])
                .env_clear()
                .env("PATH", "/usr/bin:/bin")
                .stdin(std::process::Stdio::null())
                .output()?;
            if !output.status.success() {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "xcrun could not locate Git",
                ));
            }
            String::from_utf8(output.stdout)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "non-UTF-8 Git path"))
        },
        |path| std::fs::canonicalize(path),
    )?;
    use std::os::unix::fs::PermissionsExt;
    let metadata = std::fs::metadata(&git)?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "system Git is not executable",
        ));
    }
    let _ = GIT.set(git.clone());
    Ok(git)
}

#[cfg(any(target_os = "macos", test))]
fn discover_macos_git(
    run: impl FnOnce() -> io::Result<String>,
    canonicalize: impl FnOnce(&Path) -> io::Result<PathBuf>,
) -> io::Result<PathBuf> {
    let selected = run()?;
    let path = Path::new(selected.trim());
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "non-absolute Git path",
        ));
    }
    let git = canonicalize(path)?;
    let clt = Path::new("/Library/Developer/CommandLineTools/usr/bin/git");
    let xcode = git.strip_prefix("/Applications").ok().is_some_and(|path| {
        let mut components = path.components();
        let Some(app) = components.next().and_then(|part| part.as_os_str().to_str()) else {
            return false;
        };
        let valid = app == "Xcode.app"
            || app
                .strip_prefix("Xcode_")
                .and_then(|name| name.strip_suffix(".app"))
                .is_some_and(|version| {
                    version
                        .split('.')
                        .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
                });
        valid && components.as_path() == Path::new("Contents/Developer/usr/bin/git")
    });
    if git != clt && !xcode {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "selected Git is outside supported system toolchains",
        ));
    }
    Ok(git)
}

/// 已校验的 Apple C/C++ 工具链入口与 macOS SDK；不包含宿主用户配置。
#[cfg(any(target_os = "macos", test))]
#[derive(Clone)]
pub struct SystemCompiler {
    pub executable: PathBuf,
    pub sdk: PathBuf,
}

#[cfg(target_os = "macos")]
pub fn system_compiler() -> io::Result<SystemCompiler> {
    static COMPILER: std::sync::OnceLock<SystemCompiler> = std::sync::OnceLock::new();
    if let Some(compiler) = COMPILER.get() {
        return Ok(compiler.clone());
    }
    let compiler = discover_macos_compiler(
        |args| {
            let output = std::process::Command::new("/usr/bin/xcrun")
                .args(args)
                .env_clear()
                .env("PATH", "/usr/bin:/bin")
                .stdin(std::process::Stdio::null())
                .output()?;
            if !output.status.success() {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "xcrun could not locate the system compiler or macOS SDK",
                ));
            }
            String::from_utf8(output.stdout).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "non-UTF-8 compiler or SDK path")
            })
        },
        |path| std::fs::canonicalize(path),
    )?;
    use std::os::unix::fs::PermissionsExt;
    let metadata = std::fs::metadata(&compiler.executable)?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 || !compiler.sdk.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "system compiler or SDK is unavailable",
        ));
    }
    let _ = COMPILER.set(compiler.clone());
    Ok(compiler)
}

#[cfg(any(target_os = "macos", test))]
fn discover_macos_compiler(
    mut run: impl FnMut(&[&str]) -> io::Result<String>,
    mut canonicalize: impl FnMut(&Path) -> io::Result<PathBuf>,
) -> io::Result<SystemCompiler> {
    let selected = run(&["--find", "clang"])?;
    let selected_sdk = run(&["--sdk", "macosx", "--show-sdk-path"])?;
    let compiler = Path::new(selected.trim());
    let sdk = Path::new(selected_sdk.trim());
    if !compiler.is_absolute() || !sdk.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "non-absolute compiler or SDK path",
        ));
    }
    let executable = canonicalize(compiler)?;
    let sdk = canonicalize(sdk)?;
    let sdk_directory =
        if executable == Path::new("/Library/Developer/CommandLineTools/usr/bin/clang") {
            Some(PathBuf::from("/Library/Developer/CommandLineTools/SDKs"))
        } else {
            executable
            .strip_prefix("/Applications")
            .ok()
            .and_then(|relative| {
                let mut components = relative.components();
                let app = components.next()?.as_os_str().to_str()?;
                let valid = app == "Xcode.app"
                    || app
                        .strip_prefix("Xcode_")
                        .and_then(|name| name.strip_suffix(".app"))
                        .is_some_and(|version| {
                            version.split('.').all(|part| {
                                !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit())
                            })
                        });
                if !valid
                    || components.as_path()
                        != Path::new(
                            "Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang",
                        )
                {
                    return None;
                }
                Some(
                    Path::new("/Applications")
                        .join(app)
                        .join("Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs"),
                )
            })
        };
    let valid_sdk = sdk_directory
        .as_ref()
        .is_some_and(|directory| sdk.parent() == Some(directory.as_path()))
        && sdk
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix("MacOSX"))
            .and_then(|name| name.strip_suffix(".sdk"))
            .is_some_and(|version| {
                version.is_empty()
                    || version
                        .split('.')
                        .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
            });
    if !valid_sdk {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "selected compiler or SDK is outside supported system toolchains",
        ));
    }
    Ok(SystemCompiler { executable, sdk })
}

/// 完整 Runtime 附带的非交互 shell；不寻找或安装用户的 Homebrew 程序。
#[cfg(target_os = "macos")]
pub fn runtime_shell_directory() -> io::Result<PathBuf> {
    let mut directory = std::env::current_exe()?;
    directory.pop();
    // 本 crate 作为其他 crate 的测试依赖时没有 cfg(test)，仍需识别 Cargo 测试布局。
    if directory.ends_with("deps") {
        directory.pop();
    }
    checked_shell_directory(&directory)
}

#[cfg(any(target_os = "macos", test))]
fn checked_shell_directory(directory: &Path) -> io::Result<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let expected = directory.canonicalize()?.join("shells");
    let actual = expected.canonicalize()?;
    if actual != expected {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Runtime shells directory must not redirect outside the bundle",
        ));
    }
    for name in ["bash", "sh"] {
        let file = actual.join(name);
        let metadata = std::fs::metadata(&file)?;
        if !file.canonicalize()?.starts_with(&actual)
            || !metadata.is_file()
            || metadata.permissions().mode() & 0o111 == 0
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Runtime shell is not a bundle executable",
            ));
        }
    }
    Ok(actual)
}

#[cfg(target_os = "linux")]
fn discover_linux_python(path: &std::ffi::OsStr) -> io::Result<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    for directory in std::env::split_paths(path) {
        if !directory.is_absolute() {
            continue;
        }
        let Ok(python) = directory.join("python3").canonicalize() else {
            continue;
        };
        if std::fs::metadata(&python)
            .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        {
            return Ok(python);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "Python 3 is not available on the trusted host PATH",
    ))
}

#[cfg(any(target_os = "macos", test))]
fn discover_macos_python(
    run: impl FnOnce(&str, &[&str]) -> io::Result<String>,
    canonicalize: impl FnOnce(&Path) -> io::Result<PathBuf>,
) -> io::Result<PathBuf> {
    // xcrun 通过系统选择机制发现 CLT；正常 CLT 安装不保证存在 developer_dir 链接。
    let selected = run("/usr/bin/xcrun", &["--find", "python3"])?;
    let path = Path::new(selected.trim());
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "xcrun returned a non-absolute Python path",
        ));
    }
    let python = canonicalize(path)?;
    if !is_macos_system_python(&python) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "selected Python is outside supported system Python frameworks",
        ));
    }
    Ok(python)
}

/// 只接受原生沙箱允许的系统 Python framework，不授予相邻工具链权限。
pub fn is_macos_system_python(python: &Path) -> bool {
    if python
        .starts_with("/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework")
    {
        return true;
    }
    let Ok(relative) = python.strip_prefix("/Applications") else {
        return false;
    };
    let mut components = relative.components();
    let Some(app) = components.next().and_then(|part| part.as_os_str().to_str()) else {
        return false;
    };
    let valid_name = app == "Xcode.app"
        || app
            .strip_prefix("Xcode_")
            .and_then(|name| name.strip_suffix(".app"))
            .is_some_and(|version| {
                version
                    .split('.')
                    .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
            });
    valid_name
        && components
            .as_path()
            .starts_with("Contents/Developer/Library/Frameworks/Python3.framework")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiler_discovery_rejects_redirected_tools_and_sdk_neighbors() {
        let xcode = "/Applications/Xcode_26.0.1.app/Contents/Developer";
        for (compiler, sdk, expected) in [
            (format!("{xcode}/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang"), format!("{xcode}/Platforms/MacOSX.platform/Developer/SDKs/MacOSX26.0.sdk"), true),
            ("/Library/Developer/CommandLineTools/usr/bin/clang".into(), "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk".into(), true),
            ("/opt/homebrew/bin/clang".into(), "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk".into(), false),
            (format!("{xcode}/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang"), "/private/tmp/SDKs/MacOSX.sdk".into(), false),
            (format!("{xcode}/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang"), format!("{xcode}/Platforms/MacOSX.platform/Developer/SDKs-neighbor/MacOSX.sdk"), false),
            ("/Applications/Xcode_evil.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang".into(), "/Applications/Xcode_evil.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk".into(), false),
        ] {
            let result = discover_macos_compiler(
                |args| Ok(if args == ["--find", "clang"] { compiler.clone() } else { sdk.clone() }),
                |path| Ok(path.to_path_buf()),
            );
            assert_eq!(result.is_ok(), expected, "{compiler} {sdk}");
        }
        assert!(
            discover_macos_compiler(
                |_| Ok("relative".into()),
                |_| panic!("must reject relative paths before resolving")
            )
            .is_err()
        );
        assert!(
            discover_macos_compiler(
                |args| Ok(if args == ["--find", "clang"] {
                    "/Library/Developer/CommandLineTools/usr/bin/clang".into()
                } else {
                    "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk".into()
                }),
                |_| Ok(PathBuf::from("/private/tmp/redirected"))
            )
            .is_err()
        );
    }

    #[test]
    fn git_discovery_rejects_shims_other_programs_and_resolved_escape_paths() {
        for (resolved, allowed) in [
            ("/Library/Developer/CommandLineTools/usr/bin/git", true),
            (
                "/Applications/Xcode_16.4.app/Contents/Developer/usr/bin/git",
                true,
            ),
            (
                "/Applications/Xcode_fake.app/Contents/Developer/usr/bin/git",
                false,
            ),
            (
                "/Library/Developer/CommandLineTools/usr/bin/git-extra",
                false,
            ),
            ("/Library/Developer/CommandLineTools/usr/bin/clang", false),
            ("/opt/homebrew/bin/git", false),
            ("/usr/bin/git", false),
        ] {
            let result = discover_macos_git(
                || Ok("/Library/Developer/CommandLineTools/usr/bin/git\n".into()),
                |_| Ok(PathBuf::from(resolved)),
            );
            assert_eq!(result.is_ok(), allowed, "{resolved}: {result:?}");
        }
        assert!(discover_macos_git(|| Ok("git".into()), |_| panic!("relative path")).is_err());
    }

    #[test]
    fn private_shell_discovery_never_follows_a_bundle_escape() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let shells = root.path().join("shells");
        std::fs::create_dir(&shells).unwrap();
        for name in ["bash", "sh"] {
            let path = shells.join(name);
            std::fs::write(&path, "fixture").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert_eq!(
            checked_shell_directory(root.path()).unwrap(),
            shells.canonicalize().unwrap()
        );
        std::fs::remove_file(shells.join("bash")).unwrap();
        std::fs::write(outside.path().join("bash"), "outside").unwrap();
        symlink(outside.path().join("bash"), shells.join("bash")).unwrap();
        assert!(checked_shell_directory(root.path()).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_python_uses_executable_from_absolute_host_path() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let root = tempfile::tempdir().unwrap();
        let invalid = root.path().join("invalid");
        let valid = root.path().join("valid");
        std::fs::create_dir_all(&invalid).unwrap();
        std::fs::create_dir_all(&valid).unwrap();
        std::fs::write(invalid.join("python3"), "not executable").unwrap();
        let interpreter = root.path().join("interpreter");
        std::fs::write(&interpreter, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&interpreter, std::fs::Permissions::from_mode(0o755)).unwrap();
        symlink(&interpreter, valid.join("python3")).unwrap();
        let path = std::env::join_paths([Path::new("relative"), &invalid, &valid]).unwrap();
        assert_eq!(discover_linux_python(&path).unwrap(), interpreter);
        assert!(discover_linux_python(invalid.as_os_str()).is_err());
    }

    #[test]
    fn clt_discovery_does_not_require_developer_dir_link() {
        let selected = "/Library/Developer/CommandLineTools/usr/bin/python3";
        let resolved = "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3.9";
        let python = discover_macos_python(
            |program, args| {
                assert_eq!(program, "/usr/bin/xcrun");
                assert_eq!(args, ["--find", "python3"]);
                Ok(format!("{selected}\n"))
            },
            |path| {
                // 仅 CLT 的解释器路径存在；任何 developer_dir 链接访问都失败。
                if path == Path::new(selected) {
                    Ok(PathBuf::from(resolved))
                } else {
                    Err(io::Error::from(io::ErrorKind::NotFound))
                }
            },
        )
        .unwrap();
        assert_eq!(python, Path::new(resolved));
    }

    #[test]
    fn discovery_validates_the_resolved_framework_not_the_shim() {
        for (resolved, allowed) in [
            (
                "/Applications/Xcode_16.4.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3.9",
                true,
            ),
            (
                "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework-sibling/python3",
                false,
            ),
            ("/opt/homebrew/bin/python3", false),
            ("/usr/bin/python3", false),
        ] {
            let result = discover_macos_python(
                |_, _| Ok("/Library/Developer/CommandLineTools/usr/bin/python3\n".into()),
                |_| Ok(PathBuf::from(resolved)),
            );
            assert_eq!(result.is_ok(), allowed, "{resolved}: {result:?}");
        }
    }

    #[test]
    fn discovery_reports_missing_tools_and_invalid_paths() {
        let missing = discover_macos_python(
            |_, _| Err(io::Error::from(io::ErrorKind::NotFound)),
            |_| panic!("must not resolve when xcrun fails"),
        );
        assert_eq!(missing.unwrap_err().kind(), io::ErrorKind::NotFound);
        for selected in ["", "python3"] {
            let invalid = discover_macos_python(
                |_, _| Ok(selected.into()),
                |_| panic!("must not resolve relative paths"),
            );
            assert_eq!(invalid.unwrap_err().kind(), io::ErrorKind::InvalidData);
        }
    }
}
