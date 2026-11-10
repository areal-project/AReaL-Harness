#!/usr/bin/env python3
"""脚本、清单、CI、文档之间的名字一致性检查。

1. package.json 脚本、Makefile、工作流里写到的仓库文件必须存在。
2. 开发与测试文档里用反引号写的仓库路径必须存在。
3. clients/gui/scripts 与 scripts 下的脚本必须有入口：被 package.json、Makefile、工作流、
   测试清单引用，或被另一个有入口的脚本引用。没有入口的脚本不会被任何人运行，要么登记要么删除。
   存量登记在 scripts/check-references-baseline.json，只减不增。

    python3 scripts/check-references.py          # 检查
    python3 scripts/check-references.py --write  # 删完孤儿脚本后收紧存量
"""

import fnmatch
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
BASELINE = ROOT / "scripts/check-references-baseline.json"
SCRIPT_DIRS = ("clients/gui/scripts/", "scripts/")
SCRIPT_SUFFIXES = (".mjs", ".cjs", ".js", ".py", ".sh", ".ts")
# 入口：这些文件本身就是“有人会运行”的地方。
ENTRY_GLOBS = (
    "package.json",
    "clients/gui/package.json",
    "clients/gui/*/package.json",
    "services/*/package.json",
    "Makefile",
    ".github/workflows/*.yml",
    "clients/gui/scripts/test-manifest.json",
    "clients/gui/vite.config.mts",
    ".githooks/*",
    # 使用指南与开发文档里写明手动运行的工具也算有入口。
    "docs/guides/*.md",
    "docs/development/*.md",
    "tests/guides/*.md",
)
# 只检查这些文档里的反引号路径：Agent 按它们找文件，断了就会走错。
DOC_GLOBS = (
    "AGENTS.md",
    "CLAUDE.md",
    "docs/development/README*.md",
    "docs/development/testing*.md",
    "tests/guides/*.md",
    ".agents/skills/*/SKILL.md",
)
PATH_TOKEN = re.compile(
    r"`((?:\.?[\w@.-]+/)+[\w@.*-]+\.(?:mjs|cjs|js|ts|tsx|py|sh|rs|md|json|toml|yml|css))`"
)
FILE_TOKEN = re.compile(
    r"(?<![\w/.-])((?:\.{0,2}/)?(?:[\w@.-]+/)*[\w@.*-]+\.(?:mjs|cjs|js|py|sh|ts|json|toml|yml))\b"
)


def tracked():
    output = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT
    ).decode()
    return [path for path in output.split("\0") if path]


def matches(pattern, files, base):
    """把引用解析成仓库路径；支持相对当前文件目录、仓库根和 glob。"""
    candidates = [pattern.lstrip("./")]
    if base:
        candidates.append(str(Path(base, pattern)).replace("\\", "/"))
        candidates.append(
            str((Path(base) / pattern).resolve().relative_to(ROOT.resolve()))
            if (ROOT / base / pattern).resolve().is_relative_to(ROOT.resolve())
            else pattern
        )
    found = set()
    for candidate in candidates:
        candidate = str(Path(candidate)).replace("\\", "/")
        if any(ch in candidate for ch in "*?["):
            found.update(path for path in files if fnmatch.fnmatch(path, candidate))
        elif candidate in files:
            found.add(candidate)
    return found


def references(path, files):
    text = (ROOT / path).read_text(errors="replace")
    base = str(Path(path).parent)
    result = set()
    tokens = set()
    for line in text.splitlines():
        for token in FILE_TOKEN.findall(line):
            # glob 只有交给测试运行器时才算入口；格式化命令里的 glob 不算。
            if any(ch in token for ch in "*?[") and "--test" not in line:
                continue
            tokens.add(token)
    for token in tokens:
        result |= matches(token, files, base)
        # package.json 的命令在包目录下运行；工作流和 Makefile 也常写 --dir 后的相对路径。
        for prefix in ("clients/gui/", "clients/gui/app/", "services/workbench/"):
            result |= matches(prefix + token.lstrip("./"), files, None)
    return result


def missing_entry_references(files):
    """入口文件里像仓库路径的字符串找不到对应文件，就是断头引用。

    命令可能在任意包目录下运行，所以只要有文件以这个路径结尾就算存在；构建产物不检查。
    """
    problems = []
    suffixes = {"/" + path for path in files} | set(files)
    pattern = re.compile(
        r"(?<![\w$/.{-])((?:scripts|clients|core|services|tests|runtime)/[\w@./-]+\.(?:mjs|cjs|js|py|sh|json))\b"
    )
    for glob in [g for g in ENTRY_GLOBS if not g.endswith(".md")] + [
        "clients/gui/packages/*/package.json"
    ]:
        for path in sorted(p for p in files if fnmatch.fnmatch(p, glob)):
            text = (ROOT / path).read_text(errors="replace")
            for token in sorted(set(pattern.findall(text))):
                if re.search(r"/(dist|build|target|node_modules)/", "/" + token):
                    continue
                if not any(
                    candidate.endswith("/" + token) or candidate == token for candidate in suffixes
                ):
                    problems.append(f"{path}: 引用的文件不存在：{token}")
    return problems


def missing_doc_paths(files):
    """文档按所在包写相对路径很常见，所以有文件以它结尾、或磁盘上有这个生成文件，就算存在。"""
    problems = []
    suffixes = {"/" + path for path in files} | set(files)
    for glob in DOC_GLOBS:
        for path in sorted(p for p in files if fnmatch.fnmatch(p, glob)):
            text = (ROOT / path).read_text(errors="replace")
            for token in sorted(set(PATH_TOKEN.findall(text))):
                if (
                    token.startswith(("http", "~", "/", ".", "target/"))
                    or "<" in token
                    or "*" in token
                ):
                    continue
                if re.search(r"(^|/)(dist|build|node_modules)/", token):
                    continue
                if (ROOT / token).exists() or (ROOT / path).parent.joinpath(token).exists():
                    continue
                if not any(
                    candidate.endswith("/" + token) or candidate == token for candidate in suffixes
                ):
                    problems.append(f"{path}: 反引号路径不存在：{token}")
    return problems


def orphan_scripts(files):
    scripts = [
        path
        for path in files
        if path.startswith(SCRIPT_DIRS)
        and path.endswith(SCRIPT_SUFFIXES)
        and "/fixtures/" not in path  # 夹具是数据，由测试按目录读取
    ]
    reachable, frontier = set(), set()
    for glob in ENTRY_GLOBS:
        for path in [p for p in files if fnmatch.fnmatch(p, glob)]:
            frontier |= references(path, files)
    while frontier:
        path = frontier.pop()
        if path in reachable or not (ROOT / path).is_file():
            continue
        reachable.add(path)
        if path.endswith(SCRIPT_SUFFIXES):
            frontier |= references(path, files) - reachable
    # Python 测试按目录发现：unittest discover 的目录下 test_*.py 都算有入口。
    discovered = {
        path for path in scripts if re.match(r"scripts/(tests|launcher-tests)/test_\w+\.py$", path)
    }
    return sorted(set(scripts) - reachable - discovered)


def main():
    files = set(tracked())
    problems = missing_entry_references(files) + missing_doc_paths(files)
    orphans = orphan_scripts(files)
    if "--write" in sys.argv:
        BASELINE.write_text(
            json.dumps({"orphanScripts": orphans}, ensure_ascii=False, indent=2) + "\n"
        )
        print(f"已记录 {len(orphans)} 个无入口脚本")
        return 0
    allowed = set(json.loads(BASELINE.read_text())["orphanScripts"]) if BASELINE.exists() else set()
    for path in orphans:
        if path not in allowed:
            problems.append(
                f"{path}: 没有任何入口运行它；登记到 package.json/测试清单/Makefile，或删除"
            )
    stale = sorted(allowed - set(orphans))
    if stale:
        problems.append(
            "存量里的这些脚本已删除或已有入口，请运行 --write 收紧：" + "、".join(stale)
        )
    for problem in problems:
        print(problem)
    print(f"一致性检查：{len(problems)} 个问题；存量无入口脚本 {len(allowed & set(orphans))} 个")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
