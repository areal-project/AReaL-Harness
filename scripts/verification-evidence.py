"""Validate the shared verification evidence envelope."""

import argparse
import json
from pathlib import Path


STATUSES = {"passed", "failed", "blocked", "pending", "running", "invalidated", "cancelled"}


def indexed(rows, label):
    values = {}
    for row in rows:
        name = row.get("id")
        if not name or name in values:
            raise ValueError(f"duplicate or missing {label} id: {name}")
        values[name] = row
    return values


def summarize(plan, results, report_status=None):
    by_id = indexed(results, "result")
    journeys = []
    for name in plan.get("affectedJourneys", []):
        required = plan["journeyChecks"][name]
        if not required or len(required) != len(set(required)):
            raise ValueError(f"journey {name} must require unique checks")
        observed = [by_id[check] for check in required if check in by_id]
        missing = [check for check in required if check not in by_id]
        states = []
        reasons = []
        for row in observed:
            status = row.get("status")
            if status not in STATUSES:
                raise ValueError(f"unknown result status: {status}")
            if status == "passed" and row.get("exitCode") != 0:
                status = "failed"
            states.append(status)
            if status != "passed":
                details = [
                    row.get("reason"),
                    *row.get("missingRequirements", []),
                    *row.get("blockedBy", []),
                ]
                reasons.extend(f"{row['id']}: {detail}" for detail in details if detail)
                if not any(details):
                    reasons.append(f"{row['id']}: {status}")
        if missing:
            states.append("pending")
            reasons.extend(f"missing check: {check}" for check in missing)
        if report_status in {"invalidated", "cancelled"}:
            states.append(report_status)
            reasons.append("report: " + report_status)
        status = next(
            (
                state
                for state in ("invalidated", "failed", "blocked", "cancelled", "running", "pending")
                if state in states
            ),
            "passed",
        )
        journeys.append(
            {
                "id": name,
                "requiredChecks": list(required),
                "observedChecks": [row["id"] for row in observed],
                "missingChecks": missing,
                "blockReasons": reasons,
                "status": status,
            }
        )
    return journeys


def build(plan, report):
    identity = report["identity"]
    if identity.get("planHash") != plan["planHash"] or any(
        identity.get(key) != value for key, value in plan["source"].items()
    ):
        raise ValueError("verification report source does not match plan identity")
    results = indexed(report["results"], "result")
    planned = indexed(plan["items"], "planned check")
    if results.keys() - planned.keys():
        raise ValueError("verification evidence references an unknown check")
    for result in results.values():
        if result.get("status") not in STATUSES:
            raise ValueError("verification evidence has an invalid check status")
        if report["platform"] not in planned[result["id"]]["platforms"]:
            raise ValueError("verification evidence uses the wrong platform: " + result["id"])
    return {
        "schemaVersion": 1,
        "source": dict(identity),
        "platform": report["platform"],
        "journeys": summarize(plan, report["results"], report["status"]),
        "authorities": sorted(
            {
                authority
                for name in plan.get("affectedJourneys", [])
                for authority in plan["journeyAuthorities"][name]
            }
        ),
        "checks": [
            {"id": row["id"], "status": row["status"], "authority": "ci-preflight"}
            for row in results.values()
        ],
    }


def validate(report, plan):
    evidence = report.get("evidence")
    if not isinstance(evidence, dict) or evidence.get("schemaVersion") != 1:
        raise ValueError("verification report is missing evidence schemaVersion 1")
    if evidence != build(plan, report):
        raise ValueError("verification evidence differs from plan, identity or results")
    return evidence


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    args = parser.parse_args(argv)
    plan = json.loads(args.report.with_name("plan.json").read_text())
    validate(json.loads(args.report.read_text()), plan)
    print(json.dumps({"status": "passed", "report": str(args.report)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
