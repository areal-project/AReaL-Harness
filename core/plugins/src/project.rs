//! 项目身份：项目级启用选择按它记录，同一仓库的 worktree 共用一份选择。
use std::path::{Path, PathBuf};

/// 返回 `workspace` 所属项目的身份路径。
///
/// git worktree 的 `.git` 是指向主仓库 `worktrees/<name>` 的文件，身份取主工作区；
/// 其他情况（主工作区、非 git 目录、无法解析的链接）取工作区自身。
pub fn project_key(workspace: &Path) -> PathBuf {
    main_worktree(workspace).unwrap_or_else(|| workspace.to_owned())
}

fn main_worktree(workspace: &Path) -> Option<PathBuf> {
    let link = workspace.join(".git");
    if !std::fs::symlink_metadata(&link).ok()?.is_file() {
        return None;
    }
    let text = std::fs::read_to_string(&link).ok()?;
    let gitdir = text.lines().next()?.strip_prefix("gitdir:")?.trim();
    let gitdir = workspace.join(gitdir).canonicalize().ok()?;
    let common = match std::fs::read_to_string(gitdir.join("commondir")) {
        Ok(common) => gitdir.join(common.trim()).canonicalize().ok()?,
        Err(_) => return None,
    };
    // 只认普通仓库的 `<main>/.git`；裸仓库没有主工作区，保持按路径。
    if common.file_name()? != ".git" {
        return None;
    }
    let main = common.parent()?.to_owned();
    main.is_dir().then_some(main)
}

#[cfg(test)]
mod tests {
    use super::project_key;
    use std::process::Command;

    fn git(cwd: &std::path::Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    #[test]
    fn worktrees_share_the_main_worktree_identity() {
        let temp = tempfile::tempdir().unwrap();
        let main = temp.path().join("main");
        std::fs::create_dir(&main).unwrap();
        git(&main, &["init", "-q", "-b", "main"]);
        git(
            &main,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "init",
            ],
        );
        git(
            &main,
            &["worktree", "add", "-q", "../feature", "-b", "feature"],
        );
        let main = main.canonicalize().unwrap();
        let feature = temp.path().join("feature").canonicalize().unwrap();
        assert_eq!(project_key(&main), main);
        assert_eq!(project_key(&feature), main);
        let plain = temp.path().join("plain");
        std::fs::create_dir(&plain).unwrap();
        assert_eq!(project_key(&plain), plain);
    }
}
