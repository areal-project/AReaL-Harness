"""对照共享计划核验结果全集、源码身份和当前 CI attempt。"""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("ci_scope", ROOT / "scripts/ci-scope.py")
scope = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scope)
spec = importlib.util.spec_from_file_location(
    "verification_evidence", ROOT / "scripts/verification-evidence.py"
)
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)


def validate(plan, reports, groups, ci_run=None, platform=None):
    expected = {
        item["id"]: item
        for item in plan["items"]
        if item["group"] in groups and (platform is None or platform in item["platforms"])
    }
    failures = []
    actual = {}
    for report in reports:
        try:
            evidence.validate(report, plan)
        except (ValueError, KeyError, TypeError) as error:
            failures.append("invalid verification evidence: " + str(error))
        if report.get("status") not in {"passed", "not-applicable"}:
            failures.append("report is incomplete, failed or invalidated")
        identity = report.get("identity", {})
        if identity.get("planHash") != plan["planHash"] or any(
            identity.get(key) != value for key, value in plan["source"].items()
        ):
            failures.append("report source or plan identity mismatch")
        if ci_run and (identity.get("ciRunId"), identity.get("ciAttempt")) != ci_run:
            failures.append("report is from another CI run or attempt")
        for result in report.get("results", []):
            name = result.get("id")
            if name in actual:
                failures.append("duplicate required check " + str(name))
            actual[name] = result
            if name not in expected:
                failures.append("unexpected check " + str(name))
                continue
            item = expected[name]
            if report.get("platform") not in item["platforms"]:
                failures.append("wrong platform for " + name)
            if ci_run and report.get("platform") != scope.CI_PLATFORMS[item["group"]]:
                failures.append("wrong CI execution lane for " + name)
            if result.get("status") != "passed" or result.get("exitCode") != 0:
                failures.append("required check did not pass: " + name)
            if "expectedTests" in item:
                tests = result.get("tests", [])
                names = [test.get("script") for test in tests]
                required = item["expectedTests"].get(report.get("platform"), [])
                if len(names) != len(set(names)) or set(names) != set(required):
                    failures.append("missing or duplicate runner tests: " + name)
                if not all(
                    test.get("status") == "passed"
                    and test.get("passed") is True
                    and test.get("exitCode") == 0
                    for test in tests
                ):
                    failures.append("runner contains unfinished tests: " + name)
    failures.extend(
        "missing required check " + name for name in sorted(set(expected) - set(actual))
    )
    return failures


def validate_jobs(plan, workflow, needs):
    failures = []
    for job, groups in scope.JOB_GROUPS[workflow].items():
        if job not in needs:
            failures.append("missing required job " + job)
            continue
        needed = groups is None or any(item["group"] in groups for item in plan["items"])
        value = needs[job].get("result")
        if value != "success" and (needed or value != "skipped"):
            failures.append(f"job {job}: {value}; applicable={needed}")
    return failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--workflow", choices=("gui", "verify", "release"), default=os.environ.get("GATE_KIND")
    )
    parser.add_argument("--base")
    parser.add_argument("--reports", type=Path, default=ROOT / "target/ci/checks")
    args = parser.parse_args()
    if args.workflow == "release":
        expected = {"SCOPE_RESULT", "WORK_RESULT", "HOMEBREW_RESULT"}
        results = {key: os.environ.get(key) for key in expected}
        needed = os.environ.get("NEEDED")
        passed = (
            needed in ("true", "false")
            and results["SCOPE_RESULT"] == "success"
            and all(
                scope.require_result(needed == "true", results[key])
                for key in ("WORK_RESULT", "HOMEBREW_RESULT")
            )
        )
        print(json.dumps({"needed": needed, "results": results, "passed": passed}))
        return 0 if passed else 1
    if args.workflow not in scope.WORKFLOW_GROUPS:
        raise ValueError("a declared workflow gate is required")
    plan = scope.repository_plan(ROOT, args.base)
    reports = []
    for path in args.reports.rglob("report.json"):
        value = json.loads(path.read_text())
        if value.get("kind") == "verification-report":
            reports.append(value)
    failures = validate(
        plan,
        reports,
        scope.WORKFLOW_GROUPS[args.workflow],
        (os.environ.get("GITHUB_RUN_ID"), os.environ.get("GITHUB_RUN_ATTEMPT")),
    )
    failures += validate_jobs(plan, args.workflow, json.loads(os.environ.get("NEEDS_JSON", "{}")))
    try:
        journeys = evidence.summarize(
            plan,
            [result for report in reports for result in report.get("results", [])],
            "invalidated" if failures else None,
        )
    except ValueError as error:
        failures.append(str(error))
        journeys = []
    print(
        json.dumps(
            {
                "planHash": plan["planHash"],
                "failures": failures,
                "passed": not failures,
                "journeys": journeys,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
