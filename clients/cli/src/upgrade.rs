//! 安装来源决定升级入口；源码构建不尝试覆盖正在运行的二进制。
use anyhow::{Context, Result, bail, ensure};
use areal_protocol::service::State;
use std::{path::PathBuf, process::Command};

enum Installation {
    Homebrew(Homebrew),
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
            .and_then(|p| p.parent())
            .is_some_and(|p| p.file_name().is_some_and(|n| n == "Cellar"))
        {
            let name = directory
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .context("invalid formula name")?;
            return Ok(Installation::Homebrew(homebrew(directory, name)?));
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
            && directory
                .parent()
                .and_then(|p| p.parent())
                .is_some_and(|p| p.file_name().is_some_and(|n| n == "lib"))
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

#[derive(Debug)]
struct Homebrew {
    formula: String,
    brew: PathBuf,
    beta: bool,
}

fn homebrew(keg: &std::path::Path, name: &str) -> Result<Homebrew> {
    let receipt: serde_json::Value = serde_json::from_slice(
        &std::fs::read(keg.join("INSTALL_RECEIPT.json"))
            .context("missing Homebrew receipt; refusing to guess tap")?,
    )?;
    let tap = receipt["source"]["tap"]
        .as_str()
        .context("receipt has no source tap")?;
    let parts: Vec<_> = tap.split('/').collect();
    ensure!(
        parts.len() == 2
            && parts.iter().all(|part| !part.is_empty()
                && part
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_".contains(c))),
        "invalid receipt tap"
    );
    ensure!(
        matches!(name, "areal" | "areal-beta"),
        "unsupported Homebrew formula"
    );
    let beta = name == "areal-beta";
    // beta 必须由显式独立 formula 跟踪，不能借安装版本猜测或跨频道。
    let version = receipt["source"]["versions"]["stable"]
        .as_str()
        .context("missing receipt version")?;
    ensure!(
        version.contains("-beta.") == beta,
        "Homebrew receipt channel mismatch"
    );
    let prefix = keg
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .context("invalid Cellar layout")?;
    Ok(Homebrew {
        formula: format!("{tap}/{name}"),
        brew: prefix.join("bin/brew"),
        beta,
    })
}

fn brew_output(source: &Homebrew, args: &[&str]) -> Result<String> {
    let output = Command::new(&source.brew)
        .args(args)
        .output()
        .context("owning Homebrew is required for this installation")?;
    ensure!(
        output.status.success(),
        "Homebrew failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(String::from_utf8(output.stdout)?)
}

fn formula_version(source: &Homebrew) -> Result<String> {
    let output = brew_output(source, &["info", "--json=v2", "--formula", &source.formula])?;
    let info: serde_json::Value = serde_json::from_str(&output)?;
    let formula = &info["formulae"][0];
    ensure!(
        formula["full_name"].as_str() == Some(&source.formula),
        "Homebrew resolved a different tap/formula"
    );
    let version = formula["versions"]["stable"]
        .as_str()
        .context("formula has no version")?;
    ensure!(
        version.contains("-beta.") == source.beta,
        "formula channel changed; refusing cross-channel upgrade"
    );
    Ok(version.to_owned())
}

fn brew_newer(latest: &str, current: &str) -> Result<bool> {
    fn parse(version: &str) -> Result<(u64, u64, u64, Option<u64>)> {
        let (base, beta) = if let Some((base, beta)) = version.split_once("-beta.") {
            (base, Some(beta.parse()?))
        } else {
            (version, None)
        };
        let parts: Vec<_> = base.split('.').collect();
        ensure!(parts.len() == 3, "invalid formula version");
        Ok((
            parts[0].parse()?,
            parts[1].parse()?,
            parts[2].parse()?,
            beta,
        ))
    }
    let l = parse(latest)?;
    let c = parse(current)?;
    ensure!(
        l.3.is_some() == c.3.is_some(),
        "refusing cross-channel upgrade"
    );
    Ok(l > c)
}

async fn upgrade_homebrew(source: Homebrew, check: bool) -> Result<()> {
    let current = env!("CARGO_PKG_VERSION");
    ensure!(
        current.contains("-beta.") == source.beta,
        "installed binary channel does not match its receipt"
    );
    if !check {
        // brew 可能清理旧 keg，现阶段先安全拒绝，绝不隐式停止用户服务。
        let services = areal_local_service::list(&areal_local_service::home()?).await?;
        ensure!(
            services.iter().all(|s| s.state == State::Stopped),
            "finish tasks and stop all shared services before upgrading Homebrew: areal service list"
        );
        brew_output(&source, &["update"])?;
    }
    let latest = formula_version(&source)?;
    println!("areal {current} ({}: {latest})", source.formula);
    if current == latest || check {
        if !check {
            prepare_host(&latest).await?;
        }
        return Ok(());
    }
    ensure!(
        brew_newer(&latest, current)?,
        "refusing to downgrade to {latest}"
    );
    let status = Command::new(&source.brew)
        .args(["upgrade", "--formula", &source.formula])
        .env("HOMEBREW_NO_INSTALL_CLEANUP", "1")
        .status()?;
    ensure!(status.success(), "Homebrew upgrade failed");
    let prefix = brew_output(&source, &["--prefix", &source.formula])?;
    let installed = PathBuf::from(prefix.trim()).join("bin/areal");
    let output = Command::new(installed).arg("--version").output()?;
    ensure!(
        output.status.success()
            && String::from_utf8_lossy(&output.stdout).trim() == format!("areal {latest}"),
        "Homebrew did not install areal {latest}"
    );
    prepare_host(&latest).await?;
    Ok(())
}

async fn prepare_host(target: &str) -> Result<()> {
    let Ok(client) = areal_host::Client::connect().await else {
        return Ok(());
    };
    let status = client.status().await?;
    if client.identity().executable_version == target
        || !status.capabilities.iter().any(|c| c == "updates")
    {
        return Ok(());
    }
    let request_id = uuid::Uuid::new_v4().to_string();
    eprintln!("Host update prepare requestId: {request_id}");
    let receipt = client
        .prepare_update(&request_id, &client.identity().generation, target)
        .await?;
    println!("{}", serde_json::to_string_pretty(&receipt)?);
    println!(
        "Host update prepared. Apply explicitly: areal host update apply --target-version {target} --strategy ifIdle"
    );
    Ok(())
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

fn newer_release(latest: &str, current: &str) -> Result<bool> {
    let parse = |version: &str| -> Result<(u64, u64, u64)> {
        let parts: Vec<_> = version.split('.').collect();
        ensure!(parts.len() == 3, "invalid release version");
        Ok((parts[0].parse()?, parts[1].parse()?, parts[2].parse()?))
    };
    let (base, preview) = current
        .split_once('-')
        .map_or((current, false), |(base, _)| (base, true));
    let latest = parse(latest)?;
    let current = parse(base)?;
    Ok(latest > current || latest == current && preview)
}

pub async fn run(check: bool) -> Result<()> {
    let executable = std::env::current_exe()?;
    let source = installation(&executable)?;
    let source = match source {
        Installation::Homebrew(source) => return upgrade_homebrew(source, check).await,
        Installation::Standalone(prefix) => prefix,
    };
    let current = env!("CARGO_PKG_VERSION");
    let latest = published_version()?;
    println!("areal {current} (latest published: {latest})");
    if current == latest || check {
        if !check {
            prepare_host(&latest).await?;
        }
        return Ok(());
    }
    ensure!(
        newer_release(&latest, current)?,
        "refusing to downgrade to {latest}"
    );
    let prefix = source
        .to_str()
        .context("installation prefix is not UTF-8")?;
    println!("{}", python(&["--version", &latest, "--prefix", prefix])?);
    prepare_host(&latest).await?;
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

    #[test]
    fn release_order_accepts_preview_to_same_release_but_never_downgrades() {
        assert!(newer_release("0.1.7", "0.1.7-beta.10").unwrap());
        assert!(!newer_release("0.1.6", "0.1.7-beta.1").unwrap());
        assert!(newer_release("0.1.7", "0.1.7-test.1").unwrap());
        assert!(newer_release("0.2.0", "0.1.7-test.1").unwrap());
        assert!(!newer_release("0.1.6", "0.1.7-test.1").unwrap());
        assert!(!newer_release("0.1.7", "0.1.7").unwrap());
        assert!(newer_release("0.1.10", "0.1.9").unwrap());
        assert!(newer_release("0.1.8-test.1", "0.1.7").is_err());
    }

    #[test]
    fn receipt_rejects_unknown_sources_and_cross_channel_versions() {
        let root = tempfile::tempdir().unwrap();
        let keg = root.path().join("Cellar/areal-beta/0.1.7-beta.2");
        std::fs::create_dir_all(&keg).unwrap();
        for (tap, version) in [
            ("other/tap/extra", "0.1.7-beta.2"),
            ("-bad/../tap", "0.1.7-beta.2"),
            ("custom/tap", "0.1.7"),
        ] {
            std::fs::write(
                keg.join("INSTALL_RECEIPT.json"),
                serde_json::json!({"source":{"tap":tap,"versions":{"stable":version}}}).to_string(),
            )
            .unwrap();
            assert!(homebrew(&keg, "areal-beta").is_err());
        }
        std::fs::write(
            keg.join("INSTALL_RECEIPT.json"),
            r#"{"source":{"tap":"custom/tap","versions":{"stable":"0.1.7-beta.2"}}}"#,
        )
        .unwrap();
        assert_eq!(
            homebrew(&keg, "areal-beta").unwrap().formula,
            "custom/tap/areal-beta"
        );
    }

    #[test]
    fn homebrew_cellar_is_owned_by_homebrew() {
        let root = tempfile::tempdir().unwrap();
        let exe = root.path().join("Cellar/areal/0.1.6/bin/areal");
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, "fixture").unwrap();
        assert!(installation(&exe).is_err());
        std::fs::write(
            exe.parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("INSTALL_RECEIPT.json"),
            r#"{"source":{"tap":"custom/release","versions":{"stable":"0.1.6"}}}"#,
        )
        .unwrap();
        let Installation::Homebrew(source) = installation(&exe).unwrap() else {
            panic!()
        };
        assert_eq!(source.formula, "custom/release/areal");
        assert_eq!(
            source.brew,
            root.path().canonicalize().unwrap().join("bin/brew")
        );
        assert!(brew_newer("0.1.7-beta.10", "0.1.7-beta.2").unwrap());
        assert!(brew_newer("0.1.7-beta.2", "0.1.6").is_err());
        assert!(brew_newer("0.1.7", "0.1.7-beta.2").is_err());
    }
}
