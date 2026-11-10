"""在基准提交和当前工作区各跑一遍同一条测试命令，只报告状态变化的测试。

用途：基线上本来就红的测试不算你的；只有“基准通过、现在失败”的才是回归。
    make baseline-diff BASE=origin/codex/one-protocol-integration CMD='cargo test -p areal-host --lib'
    make baseline-diff BASE=... CMD='pnpm --dir clients/gui exec vp test run' PREPARE='make gui-install'

基准工作区放在 target/baseline/<提交>，Cargo 产物放在 target/baseline-target，重复运行会复用。
能逐条解析的输出：cargo test、node --test（TAP/spec）、vitest；其它命令只比较退出码。
"""

import argparse
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]

CARGO = re.compile(r"^test (\S+) \.\.\. (ok|FAILED|ignored)", re.M)
# node --test 的 spec 输出：✔ 名称 (1.2ms) / ✖ 名称 (3ms)
NODE_SPEC = re.compile(r"^\s*([✔✖﹣])\s+(.+?)(?: \([\d.]+m?s\))?$", re.M)
# vitest 默认输出：✓ / × 文件 > 用例
VITEST = re.compile(r"^\s*([✓×↓])\s+(\S.*?)(?:\s+\d+m?s)?$", re.M)


def parse(output):
    cases = {}
    for name, status in CARGO.findall(output):
        cases[name] = {"ok": "pass", "FAILED": "fail", "ignored": "skip"}[status]
    if not cases:
        for mark, name in NODE_SPEC.findall(output):
            cases[name] = {"✔": "pass", "✖": "fail", "﹣": "skip"}[mark]
    if not cases:
        for mark, name in VITEST.findall(output):
            cases[name] = {"✓": "pass", "×": "fail", "↓": "skip"}[mark]
    return cases


def run(command, cwd, env, log):
    print(f"[baseline-diff] {cwd}: {command}", file=sys.stderr)
    result = subprocess.run(
        command, cwd=cwd, env=env, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT
    )
    output = result.stdout.decode(errors="replace")
    log.write_text(output)
    return result.returncode, output


def worktree(base):
    revision = subprocess.check_output(
        ["git", "rev-parse", "--verify", "--end-of-options", base + "^{commit}"],
        cwd=ROOT,
        text=True,
    ).strip()
    path = ROOT / "target/baseline" / revision[:12]
    if not (path / ".git").exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "worktree", "prune"], cwd=ROOT, check=True)
        subprocess.run(
            ["git", "worktree", "add", "--detach", str(path), revision], cwd=ROOT, check=True
        )
    return revision, path


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", required=True, help="基准提交或分支")
    parser.add_argument("--command", required=True, help="两边都运行的测试命令")
    parser.add_argument("--prepare", default="", help="只在基准工作区先运行的准备命令")
    args = parser.parse_args()
    if not args.base or not args.command:
        parser.error("BASE 和 CMD 都要给")
    revision, base_tree = worktree(args.base)
    logs = ROOT / "target/baseline/logs"
    logs.mkdir(parents=True, exist_ok=True)
    # 基准产物不带调试信息、不做增量，体积约为常规构建的三分之一（与 CI 相同设置）。
    base_env = dict(
        os.environ,
        CARGO_TARGET_DIR=str(ROOT / "target/baseline-target"),
        CARGO_PROFILE_DEV_DEBUG="0",
        CARGO_PROFILE_TEST_DEBUG="0",
        CARGO_INCREMENTAL="0",
    )
    base_env.setdefault("AREAL_TEST_BIN_DIR", str(ROOT / "target/baseline-target/debug"))
    if args.prepare:
        subprocess.run(args.prepare, cwd=base_tree, env=base_env, shell=True, check=True)
    base_code, base_output = run(args.command, base_tree, base_env, logs / "base.log")
    head_code, head_output = run(args.command, ROOT, dict(os.environ), logs / "head.log")
    before, after = parse(base_output), parse(head_output)
    print(f"基准 {revision[:12]} 退出码 {base_code}；当前退出码 {head_code}")
    print(f"日志：{logs / 'base.log'}、{logs / 'head.log'}")
    if not before and not after:
        regressed = base_code == 0 and head_code != 0
        print("输出无法逐条解析，只比较退出码：" + ("回归" if regressed else "无回归"))
        return 1 if regressed else 0
    changes = {
        name: (before.get(name, "absent"), after.get(name, "absent"))
        for name in sorted(set(before) | set(after))
        if before.get(name) != after.get(name)
    }
    regressions = [name for name, (old, new) in changes.items() if new == "fail" and old != "fail"]
    already = sorted(
        name for name, status in after.items() if status == "fail" and before.get(name) == "fail"
    )
    print(f"共 {len(after)} 条；基准上就失败 {len(already)} 条；状态变化 {len(changes)} 条")
    for name, (old, new) in changes.items():
        print(f"  {old:>6} → {new:<6} {name}")
    if already:
        print("基准上就失败（不是本次改动造成）：")
        for name in already:
            print(f"  {name}")
    if regressions:
        print(f"新增失败 {len(regressions)} 条", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
