#!/usr/bin/env python3
"""检查仓库 Markdown 的本地链接、标题锚点和维护文档的语言配对。"""

import re
import subprocess
from functools import cache
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
LINK = re.compile(r'\[[^\]\n]*\]\(([^\s)]+)\)|(?:href|src)="([^"]+)"')


def language_errors(path):
    """同目录语言切换必须指向本篇译文，避免跳到首页冒充翻译。"""
    if path.name.endswith(".en.md"):
        counterpart = path.with_name(path.name.removesuffix(".en.md") + ".md")
        expected = f"[中文]({counterpart.name}) | **English**"
    else:
        counterpart = path.with_name(path.stem + ".en.md")
        expected = f"**中文** | [English]({counterpart.name})"
    errors = []
    if not counterpart.is_file():
        errors.append(f"缺少对应语言文件: {counterpart.name}")
    lines = path.read_text().splitlines()
    if not lines or lines[0] != expected:
        errors.append(f"第一行应为: {expected}")
    return errors


@cache
def anchors(path):
    text = path.read_text()
    result = set(re.findall(r'(?:id|name)="([^"]+)"', text))
    counts = {}
    fenced = False
    for line in text.splitlines():
        if line.lstrip().startswith(("```", "~~~")):
            fenced = not fenced
            continue
        heading = re.match(r"^#{1,6}\s+(.+?)\s*#*$", line)
        if fenced or not heading:
            continue
        title = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", heading[1])
        slug = "".join(c for c in title.lower() if c.isalnum() or c in " _-").replace(" ", "-")
        count = counts.get(slug, 0)
        counts[slug] = count + 1
        result.add(slug + (f"-{count}" if count else ""))
    return result


def main():
    files = (
        subprocess.check_output(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT
        )
        .decode()
        .split("\0")
    )
    errors = []
    checked = 0
    for name in sorted(set(files)):
        path = ROOT / name
        if path.suffix != ".md" or not path.is_file():
            continue
        checked += 1
        text = path.read_text()
        if name.startswith("docs/") or name in {
            "README.md",
            "README.en.md",
            "CONTRIBUTING.md",
            "CONTRIBUTING.en.md",
            "SECURITY.md",
            "SECURITY.en.md",
        }:
            errors.extend(f"{name}:1: {error}" for error in language_errors(path))
        for match in LINK.finditer(text):
            url = match[1] or match[2]
            parts = urlsplit(url)
            if parts.scheme or parts.netloc:
                continue
            target = (path.parent / unquote(parts.path)).resolve() if parts.path else path
            reason = None
            if not target.exists():
                reason = "文件不存在"
            elif target.suffix == ".md" and parts.fragment:
                if unquote(parts.fragment) not in anchors(target):
                    reason = "锚点不存在"
            if reason:
                line = text[: match.start()].count("\n") + 1
                errors.append(f"{name}:{line}: {reason}: {url}")
    if errors:
        print("\n".join(errors))
        return 1
    print(f"文档链接与语言配对检查通过：{checked} 个 Markdown 文件")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
