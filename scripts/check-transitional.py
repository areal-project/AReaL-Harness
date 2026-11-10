#!/usr/bin/env python3
"""过渡代码必须写明到哪个版本删，到期就报错。

产品处于前期 Beta，不支持降级；兼容旧数据、旧协议的代码只是过渡，要有删除期限。

1. 源码里名字带 legacy / compat 的地方，前后三行内要有一条“过渡：到 <版本> 删”的注释。
   存量没写的按文件登记在 scripts/check-transitional-baseline.json，每个文件只减不增，新文件为 0。
2. “过渡：… <版本>”里的版本不大于当前版本（Cargo.toml 的 workspace 版本）就算到期，报错。

fallback 与 migration 不在检查内：前者多是普通默认值，后者包含 Store 的正式迁移，都不是过渡。

    python3 scripts/check-transitional.py          # 检查
    python3 scripts/check-transitional.py --write  # 清理存量后收紧登记
"""

import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
BASELINE = ROOT / "scripts/check-transitional-baseline.json"
SUFFIXES = (".rs", ".ts", ".tsx", ".cjs", ".mjs", ".js")
# 测试、夹具、生成物和脚本不算产品代码：旧数据夹具本来就该叫 legacy。
SKIP = re.compile(
    r"(^|/)(node_modules|dist|build|generated|fixtures|tests?|scripts)/|\.test\.|_tests?\.rs$"
)
NAME = re.compile(r"legacy|compat", re.I)
MARK = re.compile(r"过渡：.*?(\d+\.\d+\.\d+)")


def version():
    text = (ROOT / "Cargo.toml").read_text()
    return tuple(
        int(part) for part in re.search(r'^version = "(\d+)\.(\d+)\.(\d+)"', text, re.M).groups()
    )


def sources():
    output = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT
    ).decode()
    return [
        path
        for path in output.split("\0")
        if path.endswith(SUFFIXES) and not SKIP.search(path) and (ROOT / path).is_file()
    ]


def scan(path, current):
    lines = (ROOT / path).read_text(errors="replace").splitlines()
    marked, expired = set(), []
    for index, line in enumerate(lines):
        match = MARK.search(line)
        if not match:
            continue
        marked.update(range(index - 3, index + 4))
        due = tuple(int(part) for part in match.group(1).split("."))
        if due <= current:
            expired.append(f"{path}:{index + 1}: 过渡代码已到期（{match.group(1)}），请删除")
    bare = sum(1 for index, line in enumerate(lines) if NAME.search(line) and index not in marked)
    return bare, expired


def main():
    current = version()
    counts, problems = {}, []
    for path in sources():
        bare, expired = scan(path, current)
        problems += expired
        if bare:
            counts[path] = bare
    if "--write" in sys.argv:
        BASELINE.write_text(
            json.dumps(dict(sorted(counts.items())), ensure_ascii=False, indent=2) + "\n"
        )
        print(f"已登记 {len(counts)} 个文件、{sum(counts.values())} 处未标期限的过渡代码")
        return 0
    allowed = json.loads(BASELINE.read_text()) if BASELINE.exists() else {}
    for path, bare in sorted(counts.items()):
        if bare > allowed.get(path, 0):
            problems.append(
                f"{path}: 名字带 legacy/compat 的行 {bare} 处没写“过渡：到 <版本> 删”（登记上限 {allowed.get(path, 0)}）"
            )
    shrunk = sorted(path for path, limit in allowed.items() if counts.get(path, 0) < limit)
    if shrunk:
        problems.append("这些文件的过渡代码已减少，请运行 --write 收紧登记：" + "、".join(shrunk))
    for problem in problems:
        print(problem)
    print(f"过渡代码检查：{len(problems)} 个问题；存量未标期限 {sum(allowed.values())} 处")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
