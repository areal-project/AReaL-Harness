use std::{path::PathBuf, process::Command};

fn main() {
    let root = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    let git = |args: &[&str]| {
        Command::new("git")
            .current_dir(&root)
            .args(args)
            .output()
            .ok()
            .filter(|v| v.status.success())
            .and_then(|v| String::from_utf8(v.stdout).ok())
            .map(|v| v.trim().to_owned())
    };
    println!("cargo:rerun-if-env-changed=AREAL_BUILD_REVISION");
    println!("cargo:rerun-if-env-changed=AREAL_BUILD_DIRTY");
    // 兼容 worktree、分支切换及源码包；无法核验的身份明确保留 unknown。
    for item in ["HEAD", "index"] {
        if let Some(path) = git(&["rev-parse", "--git-path", item]) {
            println!("cargo:rerun-if-changed={}", root.join(path).display());
        }
    }
    if let Some(reference) = git(&["symbolic-ref", "-q", "HEAD"])
        && let Some(path) = git(&["rev-parse", "--git-path", &reference])
    {
        println!("cargo:rerun-if-changed={}", root.join(path).display());
    }
    if let Some(files) = git(&["ls-files", "--cached", "--others", "--exclude-standard"]) {
        for path in files.lines().filter(|p| {
            p.ends_with(".rs") || p.ends_with("Cargo.toml") || p.ends_with("Cargo.lock")
        }) {
            println!("cargo:rerun-if-changed={}", root.join(path).display());
        }
    }
    let revision = std::env::var("AREAL_BUILD_REVISION")
        .ok()
        .filter(|s| s.len() >= 7 && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .or_else(|| git(&["rev-parse", "HEAD"]))
        .unwrap_or_else(|| "unknown".into());
    let dirty = std::env::var("AREAL_BUILD_DIRTY")
        .ok()
        .filter(|s| matches!(s.as_str(), "true" | "false" | "unknown"))
        .or_else(|| {
            git(&["status", "--porcelain", "--untracked-files=no"])
                .map(|s| (!s.is_empty()).to_string())
        })
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=AREAL_BUILD_REVISION={revision}");
    println!("cargo:rustc-env=AREAL_BUILD_DIRTY={dirty}");
}
