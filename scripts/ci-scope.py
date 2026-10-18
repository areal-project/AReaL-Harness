"""每个 PR 运行稳定门禁；只对适用路径执行昂贵矩阵。"""

import fnmatch
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SCOPES = {
    "gui": [
        "clients/**",
        "core/**",
        "runtime/**",
        "schemas/**",
        "Cargo.*",
        "rust-toolchain.toml",
        "Makefile",
        "scripts/**",
        ".github/workflows/**",
    ],
    "release": [
        "clients/**",
        "core/**",
        "runtime/**",
        "schemas/**",
        "Cargo.*",
        "rust-toolchain.toml",
        "Makefile",
        "scripts/**",
        "examples/desktop-api/**",
        "tests/fixtures/**",
        "package*.json",
        "upstream/**",
        ".github/workflows/**",
    ],
}


def applicable(scope, paths):
    return any(fnmatch.fnmatchcase(path, pattern) for path in paths for pattern in SCOPES[scope])


def require_result(needed, result):
    # 不适用必须由成功的路径判定明确声明，取消和意外 skip 都失败。
    return result == ("success" if needed else "skipped")


if __name__ == "__main__":
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    pr = event.get("pull_request")
    paths = (
        subprocess.check_output(
            ["git", "diff", "--name-only", pr["base"]["sha"], pr["head"]["sha"]],
            cwd=ROOT,
            text=True,
        ).splitlines()
        if pr
        else None
    )
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        for scope in SCOPES:
            needed = paths is None or applicable(scope, paths)
            print(f"{scope}={'true' if needed else 'false'}", file=output)
            print(json.dumps({"scope": scope, "needed": needed, "changedPaths": paths}))
