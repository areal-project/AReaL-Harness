#!/usr/bin/env python3
"""Rust 单文件行数上限：新文件不超过 1500 行，存量超限文件不超过登记时的行数。

大文件让 Agent 每次都要整读、改动互相冲突。生成代码和测试不计。

    python3 scripts/check-rust-size.py          # 检查
    python3 scripts/check-rust-size.py --write  # 拆分或删减后收紧登记（变小不强制收紧，免得每次删行都要改登记）
"""

import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
BASELINE = ROOT / "scripts/check-rust-size-baseline.json"
LIMIT = 1500
SKIP = re.compile(r"(^|/)(generated|tests)/|(^|/)tests?\.rs$|_tests?\.rs$")


def sizes():
    output = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "*.rs"], cwd=ROOT
    ).decode()
    result = {}
    for path in output.split("\0"):
        if path and not SKIP.search(path) and (ROOT / path).is_file():
            result[path] = len((ROOT / path).read_text(errors="replace").splitlines())
    return result


def main():
    over = {path: lines for path, lines in sizes().items() if lines > LIMIT}
    if "--write" in sys.argv:
        BASELINE.write_text(json.dumps(dict(sorted(over.items())), indent=2) + "\n")
        print(f"已登记 {len(over)} 个超过 {LIMIT} 行的 Rust 文件")
        return 0
    allowed = json.loads(BASELINE.read_text()) if BASELINE.exists() else {}
    problems = [
        f"{path}: {lines} 行，超过上限 {allowed.get(path, LIMIT)}；拆成按职责的子模块"
        for path, lines in sorted(over.items())
        if lines > allowed.get(path, LIMIT)
    ]
    for problem in problems:
        print(problem)
    print(f"Rust 文件体积检查：{len(problems)} 个问题；存量超限 {len(allowed)} 个文件")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
