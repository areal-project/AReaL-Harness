#!/usr/bin/env python3
"""发出 Rust 文件体积优化信号，不把行数当作合并门禁。

大文件让 Agent 每次都要整读、改动互相冲突。生成代码和测试不计。1500
行是设计参考线，登记文件只用于发现存量文件继续增长；两者都不会使检查失败。

    python3 scripts/check-rust-size.py          # 输出 AGENT_OPTIMIZATION_SIGNAL
    python3 scripts/check-rust-size.py --write  # 更新本地观察快照
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


def sizes(root=ROOT):
    output = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "*.rs"], cwd=root
    ).decode()
    result = {}
    for path in output.split("\0"):
        if path and not SKIP.search(path) and (root / path).is_file():
            result[path] = len((root / path).read_text(errors="replace").splitlines())
    return result


def report(root=ROOT, baseline=BASELINE):
    current = sizes(root)
    previous = json.loads(baseline.read_text()) if baseline.exists() else {}
    findings = []
    for path, lines in sorted(current.items()):
        baseline_lines = previous.get(path)
        over_guideline = lines > LIMIT
        grew = baseline_lines is not None and lines > baseline_lines
        if not over_guideline and not grew:
            continue
        findings.append(
            {
                "path": path,
                "lines": lines,
                "guidelineLines": LIMIT,
                "baselineLines": baseline_lines,
                "delta": None if baseline_lines is None else lines - baseline_lines,
                "reasons": [
                    reason
                    for reason, matched in (
                        ("aboveGuideline", over_guideline),
                        ("grewSinceBaseline", grew),
                    )
                    if matched
                ],
                "suggestion": "拆成按职责的子模块；若本次改动不适合拆分，保留理由并继续交付。",
            }
        )
    return {
        "kind": "agent-optimization-signal",
        "signal": "rust-file-size",
        "status": "advisory" if findings else "clear",
        "guidelineLines": LIMIT,
        "findings": findings,
        "summary": {
            "filesScanned": len(current),
            "aboveGuideline": sum("aboveGuideline" in item["reasons"] for item in findings),
            "grewSinceBaseline": sum("grewSinceBaseline" in item["reasons"] for item in findings),
        },
    }


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    current = sizes()
    if "--write" in argv:
        over = {path: lines for path, lines in current.items() if lines > LIMIT}
        BASELINE.write_text(json.dumps(dict(sorted(over.items())), indent=2) + "\n")
        print(f"已更新 Rust 文件体积观察快照：{len(over)} 个文件超过参考线 {LIMIT} 行")
        return 0
    signal = report()
    print(
        "AGENT_OPTIMIZATION_SIGNAL " + json.dumps(signal, ensure_ascii=False, separators=(",", ":"))
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
