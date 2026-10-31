"""从本地与 CI 共用的计划运行快检；完整验收由 preflight 执行。"""

import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(
        name.replace("-", "_"), Path(__file__).with_name(name + ".py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ci_scope = load("ci-scope")
preflight = load("ci-preflight")
changed_paths = ci_scope.changed_paths
input_key = ci_scope.input_key


def unfinished_checks(report, path, plan, platform):
    # 未选择项不是欠账；只恢复本机中断尝试实际选中的检查，不复用旧通过证据。
    if report.get("status") not in {"running", "cancelled"} or report["platform"] != platform:
        return []
    selected = report.get("selectedRequired")
    if selected is None:
        saved_path = path.with_name("plan.json")
        if not saved_path.is_file():
            return []
        saved = json.loads(saved_path.read_text())
        identity = report["identity"]
        if saved["planHash"] != identity.get("planHash") or any(
            identity.get(key) != value for key, value in saved["source"].items()
        ):
            raise ValueError(f"Interrupted report plan identity differs: {path}")
        selected = {item["id"] for item in saved["items"]} - set(report["pendingRequired"])
    completed = {result["id"] for result in report["results"]}
    remote = set(report.get("remoteRequired", []))
    local = {item["id"] for item in plan["items"] if platform in item["platforms"]}
    return sorted(set(selected) & local - completed - remote)


def failure_checks(plan, root, extra_reports=(), platform=None):
    platform = platform or sys.platform
    # 历史报告只提供重验线索；旧命令和通过结果都不参与本轮执行。
    paths = {
        path
        for directory in ("preflight", "changed", "failures")
        for path in (root / "target/ci" / directory).glob("*/report.json")
    } | set(extra_reports)
    latest = {}
    source = plan["source"]
    revisions = (
        ci_scope.git(
            root, "rev-list", "--topo-order", source["headRevision"], "^" + source["baseRevision"]
        )
        .decode()
        .splitlines()
    )
    ancestors = {
        revision: -index for index, revision in enumerate(revisions or [source["headRevision"]])
    }
    for path in sorted(paths):
        report = json.loads(path.read_text())
        if report.get("kind") != "verification-report":
            raise ValueError(f"Not a verification report: {path}")
        revision = report["identity"]["headRevision"]
        if revision not in ancestors:
            if path in extra_reports:
                raise ValueError(f"Failure report is outside the current branch: {path}")
            continue
        results = report["results"] + [
            {"id": name, "status": "pending"}
            for name in unfinished_checks(report, path, plan, platform)
        ]
        for result in results:
            key = (result["id"], report["platform"])
            timestamp = (
                result.get("completedAt") or report.get("completedAt") or report["startedAt"]
            )
            status = "invalidated" if report.get("status") == "invalidated" else result["status"]
            # 祖先提交晚结束的检查不能清除后续提交已经发现的失败。
            order = (ancestors[revision], timestamp)
            if key not in latest or order > latest[key][0]:
                latest[key] = (order, status, str(path))
    required = {item["id"] for item in plan["items"]}
    failures = {}
    for (name, _), (_, status, path) in sorted(latest.items()):
        if name in required and status != "passed":
            failures.setdefault(name, []).append(path)
    return failures


def select_checks(plan, phase, failures):
    names = {item["id"] for item in plan["items"] if phase == "full" or item["phase"] == "commit"}
    names.update(failures)
    while True:
        expanded = names | {
            dependency
            for item in plan["items"]
            if item["id"] in names
            for dependency in item["dependsOn"]
        }
        if expanded == names:
            return [item for item in plan["items"] if item["id"] in names]
        names = expanded


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True)
    parser.add_argument("--plan", action="store_true")
    parser.add_argument("--phase", choices=("commit", "full"), default="commit")
    parser.add_argument("--failure-report", type=Path, action="append", default=[])
    args = parser.parse_args(argv)
    plan = ci_scope.repository_plan(ROOT, args.base)
    failures = failure_checks(plan, ROOT, args.failure_report)
    selected = select_checks(plan, args.phase, failures)
    print(
        json.dumps(
            {
                "plan": plan,
                "selected": [item["id"] for item in selected],
                "pendingFull": [item["id"] for item in plan["items"] if item not in selected],
                "failureChecks": failures,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    if args.plan:
        return 0
    output = ROOT / "target/ci/changed" / str(time.time_ns())
    report = preflight.run_plan(plan, ROOT, selected, output)
    print(
        json.dumps(
            {
                "report": str(output / "report.json"),
                "status": report["status"],
                "scope": args.phase,
                "overallStatus": report["overallStatus"],
            }
        ),
        flush=True,
    )
    return 0 if report["status"] in {"passed", "not-applicable"} else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, subprocess.CalledProcessError, ValueError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
