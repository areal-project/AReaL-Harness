//! 可信宿主的工具发现；不执行任务脚本，不读取模型或工作区配置。
use std::{
    io,
    path::{Path, PathBuf},
};

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
