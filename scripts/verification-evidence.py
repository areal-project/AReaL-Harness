"""Validate the shared verification evidence envelope."""

import argparse
import json
from pathlib import Path


def validate(report):
    evidence = report.get("evidence")
    if not isinstance(evidence, dict) or evidence.get("schemaVersion") != 1:
        raise ValueError("verification report is missing evidence schemaVersion 1")
    for key in ("source", "journeys", "authorities", "checks"):
        if key not in evidence:
            raise ValueError("verification evidence is missing " + key)
    expected = {
        key: report["identity"].get(key)
        for key in ("baseRevision", "sourceRevision", "headRevision", "inputHash")
    }
    if evidence["source"] != expected:
        raise ValueError("verification evidence source does not match report identity")
    result_ids = {result["id"] for result in report.get("results", [])}
    if any(check.get("id") not in result_ids for check in evidence["checks"]):
        raise ValueError("verification evidence references an unknown check")
    for journey in evidence["journeys"]:
        if journey.get("status") not in {"passed", "failed", "blocked", "pending", "not-selected"}:
            raise ValueError("verification evidence has an invalid journey status")
    return evidence


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    args = parser.parse_args(argv)
    validate(json.loads(args.report.read_text()))
    print(json.dumps({"status": "passed", "report": str(args.report)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
