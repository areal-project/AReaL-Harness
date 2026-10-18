//! 安装来源决定升级入口；源码构建不尝试覆盖正在运行的二进制。
use anyhow::{Context, Result, bail, ensure};
use areal_protocol::service::State;
use std::{path::PathBuf, process::Command};

enum Installation {
    Homebrew,
    Standalone(PathBuf),
}

fn installation(executable: &std::path::Path) -> Result<Installation> {
    let executable = executable.canonicalize()?;
    let bin = executable
        .parent()
        .context("missing executable directory")?;
    if bin.file_name().is_some_and(|name| name == "bin") {
        let directory = bin.parent().context("missing installation directory")?;
        if directory
            .parent()
            .is_some_and(|parent| parent.file_name().is_some_and(|name| name == "areal"))
            && directory
                .parent()
                .and_then(|p| p.parent())
                .is_some_and(|parent| parent.file_name().is_some_and(|name| name == "Cellar"))
        {
            return Ok(Installation::Homebrew);
        }
        let target = if cfg!(target_os = "macos") {
            "macos-arm64"
        } else {
            "linux-x86_64"
        };
        if directory
            .file_name()
            .is_some_and(|name| name == format!("{}-{target}", env!("CARGO_PKG_VERSION")).as_str())
            && directory
                .parent()
                .is_some_and(|p| p.file_name().is_some_and(|n| n == "areal"))
        {
            let prefix = directory
                .parent()
                .and_then(|p| p.parent())
                .and_then(|p| p.parent())
                .context("invalid installation layout")?;
            let link = prefix.join("bin/areal");
            if link.is_symlink() && link.canonicalize()? == executable {
                return Ok(Installation::Standalone(prefix.to_path_buf()));
            }
        }
    }
    bail!("upgrade requires a Homebrew or installer-managed areal; see the installation guide")
}

fn python(args: &[&str]) -> Result<String> {
    let output = Command::new("python3")
        .args([
            "-I",
            "-S",
            "-c",
            include_str!("../../../scripts/install.py"),
        ])
        .args(args)
        .output()
        .context("upgrade requires Python 3.9+ on PATH")?;
    ensure!(
        output.status.success(),
        "installer failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}

fn published_version() -> Result<String> {
    python(&["--version", "latest", "--check"])
}

pub async fn run(check: bool) -> Result<()> {
    let executable = std::env::current_exe()?;
    let source = installation(&executable)?;
    let current = env!("CARGO_PKG_VERSION");
    let latest = published_version()?;
    println!("areal {current} (latest published: {latest})");
    if current == latest || check {
        return Ok(());
    }
    let newer = |version: &str| -> Result<(u64, u64, u64)> {
        let parts: Vec<_> = version.split('.').collect();
        ensure!(parts.len() == 3, "invalid release version");
        Ok((parts[0].parse()?, parts[1].parse()?, parts[2].parse()?))
    };
    ensure!(
        newer(&latest)? > newer(current)?,
        "refusing to downgrade to {latest}"
    );
    let root = areal_local_service::home()?;
    let services = areal_local_service::list(&root).await?;
    ensure!(
        services
            .iter()
            .all(|service| service.state == State::Stopped),
        "stop all shared services before upgrading: areal service list"
    );
    match source {
        Installation::Homebrew => {
            let status = Command::new("brew")
                .args(["upgrade", "--formula", "areal-project/tap/areal"])
                .status()
                .context("Homebrew is required for this installation")?;
            ensure!(status.success(), "Homebrew upgrade failed");
            let output = Command::new("brew")
                .args(["list", "--versions", "areal-project/tap/areal"])
                .output()?;
            ensure!(
                output.status.success()
                    && String::from_utf8_lossy(&output.stdout)
                        .split_whitespace()
                        .any(|part| part == latest),
                "Homebrew tap has not published areal {latest}; retry after its formula is updated"
            );
        }
        Installation::Standalone(prefix) => {
            let prefix = prefix
                .to_str()
                .context("installation prefix is not UTF-8")?;
            println!("{}", python(&["--version", &latest, "--prefix", prefix])?);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn only_owned_installation_is_upgradeable() {
        let root = tempfile::tempdir().unwrap();
        let prefix = root.path();
        let suffix = if cfg!(target_os = "macos") {
            "macos-arm64"
        } else {
            "linux-x86_64"
        };
        let exe = prefix.join(format!(
            "lib/areal/{}-{suffix}/bin/areal",
            env!("CARGO_PKG_VERSION")
        ));
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, "fixture").unwrap();
        assert!(installation(&exe).is_err());
        std::fs::create_dir_all(prefix.join("bin")).unwrap();
        symlink(&exe, prefix.join("bin/areal")).unwrap();
        assert!(matches!(
            installation(&exe).unwrap(),
            Installation::Standalone(_)
        ));
        std::fs::remove_file(prefix.join("bin/areal")).unwrap();
        std::fs::write(prefix.join("bin/areal"), "user-owned").unwrap();
        assert!(installation(&exe).is_err());
    }
}
