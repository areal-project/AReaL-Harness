#!/usr/bin/env python3
"""检查独立产品与默认构建入口不会加载仓库中的可选平台适配器。"""

from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OPTIONAL_WORKFLOW = ".github/workflows/arena-package.yml"
DEFAULT_TARGETS = (
    "build",
    "release",
    "package",
    "install",
    "verify",
    "verify-harness",
    "verify-native",
)
# 不按 arena 子串拦截通用依赖（如 Rust 的 id-arena 分配器）。
ADAPTER_REFERENCE = re.compile(
    r"integrations[/\\]|(?:package-arena|arena-input-smoke|fetch-arena-fixtures)\.py"
    r"|\benvarena-(?:check|smoke)\b|\bArenaOnlineGateway\b",
    re.IGNORECASE,
)
SOURCE_SUFFIXES = {".rs", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".py"}


def product_file(name):
    path = Path(name)
    if name in {
        "scripts/check-integration-boundaries.py",
        "scripts/tests/test_integration_boundaries.py",
    }:
        return False
    if path.parts[0] == "scripts":
        return path.suffix in SOURCE_SUFFIXES
    if path.parts[0] in {"core", "runtime", "clients"}:
        return path.suffix in SOURCE_SUFFIXES or path.name in {
            "Cargo.toml",
            "package.json",
            "package-lock.json",
            "pnpm-lock.yaml",
        }
    return name in {
        "Cargo.toml",
        "Cargo.lock",
        "package.json",
        "package-lock.json",
        "Dockerfile",
        "tests/e2e/docker/Dockerfile",
    } or (name.startswith(".github/workflows/") and name != OPTIONAL_WORKFLOW)


def check_files(root, names):
    errors = []
    for name in sorted(names):
        if not product_file(name):
            continue
        path = root / name
        if not path.is_file():
            continue
        for line, text in enumerate(path.read_text().splitlines(), 1):
            if ADAPTER_REFERENCE.search(text):
                errors.append(f"{name}:{line}: independent product references an optional adapter")
    return errors


def check_workflow(text):
    # 明确选择手动工作流；不把 push/PR/workflow_call 重新加入默认依赖链。
    trigger = re.search(r"(?ms)^on:\s*\n(.*?)(?=^\S|\Z)", text)
    if trigger is None or trigger.group(1).strip() != "workflow_dispatch:":
        return [f"{OPTIONAL_WORKFLOW}: optional adapter must use workflow_dispatch only"]
    return []


def check_make(root):
    # --dry-run 展开递归 Make 的实际依赖图，不执行普通构建和测试 recipe。
    result = subprocess.run(
        ["make", "--no-print-directory", "--dry-run", *DEFAULT_TARGETS],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if result.returncode:
        return ["Makefile: unable to expand independent build/check targets"]
    return [
        "Makefile: default build/check graph invokes an optional adapter: " + line.strip()
        for line in result.stdout.splitlines()
        if ADAPTER_REFERENCE.search(line)
    ]


def main():
    names = (
        subprocess.check_output(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT
        )
        .decode()
        .split("\0")
    )
    errors = check_files(ROOT, [name for name in names if name])
    workflow = ROOT / OPTIONAL_WORKFLOW
    if workflow.is_file():
        errors += check_workflow(workflow.read_text())
    errors += check_make(ROOT)
    if errors:
        raise SystemExit("\n".join(errors))
    print("integration boundaries: independent product, release and default checks verified")


if __name__ == "__main__":
    main()
