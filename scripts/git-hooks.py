"""在暂存快照检查提交，在干净 HEAD 上运行受影响快检与失败专项。"""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def run(args, cwd=ROOT, capture=False, env=None):
    result = subprocess.run(
        args, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE if capture else None
    )
    if result.returncode:
        raise subprocess.CalledProcessError(result.returncode, args)
    return result.stdout.strip() if capture else None


def git(*args, capture=True):
    return run(["git", *args], capture=capture)


def remote_base(value):
    reference = git("rev-parse", "--symbolic-full-name", "--verify", value)
    git("rev-parse", "--verify", f"{reference}^{{commit}}")
    for remote in sorted(git("remote").splitlines(), key=len, reverse=True):
        prefix = f"refs/remotes/{remote}/"
        if reference.startswith(prefix):
            branch = reference[len(prefix) :]
            if branch != "HEAD":
                return reference, remote, branch
    raise ValueError(
        "CI base must be an existing remote-tracking branch, such as upstream-readonly/main"
    )


def install(base):
    reference, _, _ = remote_base(base)
    configured = subprocess.run(
        ["git", "config", "--get", "core.hooksPath"], cwd=ROOT, text=True, capture_output=True
    )
    if configured.returncode not in (0, 1):
        raise subprocess.CalledProcessError(configured.returncode, configured.args)
    if (
        configured.returncode == 0
        and (ROOT / configured.stdout.strip()).resolve() != ROOT / ".githooks"
    ):
        raise ValueError(
            "core.hooksPath already points elsewhere; existing hooks were not overwritten"
        )
    for name in ("pre-commit", "pre-push"):
        if not os.access(ROOT / ".githooks" / name, os.X_OK):
            raise ValueError(f"Repository hook is missing or not executable: {name}")
    git("config", "--local", "areal.ciBase", reference, capture=False)
    git("config", "--local", "core.hooksPath", ".githooks", capture=False)
    print(f"Installed repository hooks; CI base: {reference}")


def precommit():
    staged = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=ROOT)
    if staged.returncode == 0:
        return
    if staged.returncode != 1:
        raise subprocess.CalledProcessError(staged.returncode, staged.args)
    paths = git(
        "diff", "--cached", "--name-only", "--no-renames", "--diff-filter=ACDMT", "-z"
    ).split("\0")
    with tempfile.TemporaryDirectory(prefix="areal-staged-check-") as directory:
        snapshot = Path(directory)
        git("checkout-index", "--all", f"--prefix={snapshot}{os.sep}", capture=False)
        run(["node", "scripts/test-manifest.mjs", "--list"], cwd=snapshot / "clients/gui")
        # 使用同一暂存快照中的规则和 manifest，避免未暂存规则掩盖漏测。
        spec = importlib.util.spec_from_file_location(
            "staged_ci_scope", snapshot / "scripts/ci-scope.py"
        )
        scope = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(scope)
        tree = git("write-tree")
        plan = scope.build_plan(
            [path for path in paths if path],
            {
                "baseRevision": git("rev-parse", "HEAD"),
                "sourceRevision": tree,
                "headRevision": git("rev-parse", "HEAD"),
                "inputHash": tree,
                "validationTarget": "index-plan-only",
            },
            json.loads((snapshot / "clients/gui/scripts/test-manifest.json").read_text()),
        )
        output = ROOT / "target/ci/staged-plan.json"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n")
        print(
            f"Staged impact plan: {output}; {len(plan['items'])} required checks (not yet executed)",
            flush=True,
        )
        # 只复用依赖，不链接源码或 .git；未暂存的用户修改不进入验收快照。
        packages = git("ls-files", "-z", "--", "*package.json").split("\0")
        for parent in {Path("."), *(Path(path).parent for path in packages if path)}:
            source = ROOT / parent / "node_modules"
            destination = snapshot / parent / "node_modules"
            if source.is_dir() and destination.parent.is_dir():
                destination.symlink_to(source, target_is_directory=True)
        gui = [
            path.removeprefix("clients/gui/")
            for path in paths
            if path.startswith("clients/gui/") and (snapshot / path).is_file()
        ]
        if gui:
            workspace = snapshot / "clients/gui"
            package = json.loads((workspace / "package.json").read_text())
            installed = workspace / "node_modules/vite-plus/package.json"
            if (
                not installed.is_file()
                or json.loads(installed.read_text())["version"]
                != package["devDependencies"]["vite-plus"]
            ):
                raise ValueError(
                    "Install the staged GUI lockfile before running its pinned Vite+ check"
                )
            run(
                [
                    "node",
                    "node_modules/vite-plus/bin/vp",
                    "check",
                    "--deny-warnings",
                    "--no-error-on-unmatched-pattern",
                    *(f"./{path}" for path in gui),
                ],
                cwd=workspace,
            )
        workflows = [
            snapshot / path
            for path in paths
            if path.startswith(".github/workflows/")
            and path.endswith((".yml", ".yaml"))
            and (snapshot / path).is_file()
        ]
        if workflows:
            cache = ROOT / ".local/tools/actionlint"
            cache.mkdir(parents=True, exist_ok=True)
            (snapshot / ".local/tools").mkdir(parents=True, exist_ok=True)
            (snapshot / ".local/tools/actionlint").symlink_to(cache, target_is_directory=True)
            run(
                [
                    sys.executable,
                    str(snapshot / "scripts/check-workflows.py"),
                    *map(str, workflows),
                ],
                cwd=snapshot,
            )
        run(["make", "fmt-check"], cwd=snapshot)


def require_clean_head(expected):
    if git("rev-parse", "HEAD") != expected:
        raise ValueError(
            "Push SHA must equal the current HEAD; use a clean worktree for another branch"
        )
    for args in (("diff", "--quiet"), ("diff", "--cached", "--quiet")):
        result = subprocess.run(["git", *args], cwd=ROOT)
        if result.returncode == 1:
            raise ValueError(
                "Tracked worktree/index changes are present; push from a clean worktree without stashing or resetting other work"
            )
        if result.returncode:
            raise subprocess.CalledProcessError(result.returncode, result.args)

    if git("ls-files", "--others", "--exclude-standard", "-z"):
        raise ValueError(
            "Untracked inputs are present; commit required source or use a clean worktree before validating the pushed HEAD"
        )


def prepush():
    updates = []
    for line in sys.stdin:
        fields = line.split()
        if len(fields) != 4:
            raise ValueError("Invalid pre-push ref update")
        if fields[1] and set(fields[1]) == {"0"}:
            continue
        updates.append(fields[1])
    if not updates:
        return
    head = git("rev-parse", "HEAD")
    if any(value != head for value in updates):
        raise ValueError(
            "Every pushed SHA must equal current HEAD; use a clean worktree for other branches"
        )
    require_clean_head(head)
    base = git("config", "--get", "areal.ciBase")
    reference, remote, branch = remote_base(base)
    git("fetch", "--no-tags", remote, f"+refs/heads/{branch}:{reference}", capture=False)
    require_clean_head(head)
    # 使用抓取后的不可变 SHA，避免分支名进入 Make 的 shell 展开。
    revision = git("rev-parse", "--verify", f"{reference}^{{commit}}")
    # Git hooks 继承调用者的仓库定位变量；不能把它们传给会创建独立仓库的检查。
    local_variables = git("rev-parse", "--local-env-vars").splitlines()
    environment = {key: value for key, value in os.environ.items() if key not in local_variables}
    run(["make", "check-changed", f"CI_BASE={revision}", "ARGS="], env=environment)
    require_clean_head(head)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="operation", required=True)
    installer = commands.add_parser("install")
    installer.add_argument("--base", required=True)
    commands.add_parser("pre-commit")
    push = commands.add_parser("pre-push")
    push.add_argument("remote", nargs="?")
    push.add_argument("url", nargs="?")
    args = parser.parse_args()
    try:
        if args.operation == "install":
            install(args.base)
        elif args.operation == "pre-commit":
            precommit()
        else:
            prepush()
    except subprocess.CalledProcessError as error:
        print(f"Git hook check failed: {error.cmd[0]} (exit {error.returncode})", file=sys.stderr)
        return error.returncode if error.returncode >= 0 else 128 - error.returncode
    except (ValueError, OSError, KeyError) as error:
        print(f"Git hook: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
