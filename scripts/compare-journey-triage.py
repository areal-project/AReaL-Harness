"""Compare old manual triage with the registered journey plan for recent commits."""

import argparse
import fnmatch
import json
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]


def git(*args):
    return subprocess.check_output(["git", "--no-optional-locks", *args], cwd=ROOT, text=True)


def recent_commits(limit):
    rows = git(
        "log",
        "--format=%H%x09%s",
        "--no-merges",
        "--all",
        "--since=90 days ago",
        "--",
        "core",
        "clients/gui",
        "services/workbench",
        "schemas",
    ).splitlines()
    return [tuple(row.split("\t", 1)) for row in rows]


def changed_paths(commit):
    return [
        path
        for path in git("diff-tree", "--no-commit-id", "--name-only", "-r", commit).splitlines()
        if path
    ]


def matching_report(commit, evidence_root):
    """Return a persisted report for a historical commit when one exists."""
    if evidence_root is None or not evidence_root.is_dir():
        return None
    for path in sorted(evidence_root.glob("**/report.json")):
        try:
            report = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        identity = report.get("identity", {})
        if commit in {identity.get("sourceRevision"), identity.get("headRevision")}:
            return report
    return None


def journey_evidence(journeys, report):
    """Project persisted real-journey evidence, preserving blockers verbatim."""
    projected = []
    by_id = {
        journey.get("id"): journey
        for journey in (report or {}).get("evidence", {}).get("journeys", [])
    }
    for journey in journeys:
        observed = by_id.get(journey)
        if observed is None:
            projected.append(
                {
                    "id": journey,
                    "status": "unavailable",
                    "evidenceSource": "no-historical-report",
                    "blockedStage": "real-journey-execution",
                    "blockReasons": ["historical commit has no persisted real journey evidence"],
                }
            )
            continue
        projected.append(
            {
                "id": journey,
                "status": observed.get("status", "unknown"),
                "evidenceSource": "verification-report",
                "observedChecks": observed.get("observedChecks", []),
                "blockedStage": (
                    "real-journey-execution"
                    if observed.get("status") in {"blocked", "failed"}
                    else None
                ),
                "blockReasons": observed.get("blockReasons", []),
            }
        )
    return projected


def compare(limit=10, evidence_root=None):
    scope_spec = importlib_load(ROOT / "scripts/ci-scope.py", "compare_ci_scope")
    manifest = json.loads((ROOT / "clients/gui/scripts/test-manifest.json").read_text())
    journey_manifest = json.loads((ROOT / "clients/gui/scripts/journey-manifest.json").read_text())
    rows = []
    started = time.perf_counter()
    considered = 0
    for commit, subject in recent_commits(limit * 4):
        paths = changed_paths(commit)
        affected = [
            journey["id"]
            for journey in journey_manifest["journeys"]
            if any(
                fnmatch.fnmatchcase(path, pattern) for path in paths for pattern in journey["paths"]
            )
        ]
        if not affected:
            continue
        considered += 1
        row_started = time.perf_counter()
        plan = scope_spec.build_plan(
            paths,
            {
                "baseRevision": commit,
                "sourceRevision": commit,
                "headRevision": commit,
                "inputHash": "historical-comparison",
            },
            manifest,
        )
        persisted = matching_report(commit, evidence_root)
        evidence = journey_evidence(affected, persisted)
        rows.append(
            {
                "commit": commit,
                "subject": subject,
                "changedPaths": len(paths),
                "oldProcess": {
                    "journeys": "manual/unknown",
                    "authorities": "manual/unknown",
                    "evidenceFields": "manual/unknown",
                    "humanMinutes": None,
                    "measurement": "not recoverable from Git history",
                },
                "newProcess": {
                    "journeys": plan["affectedJourneys"],
                    "journeyCount": len(plan["affectedJourneys"]),
                    "requiredChecks": sorted(
                        {check for checks in plan["journeyChecks"].values() for check in checks}
                    ),
                    "authorityCount": len(
                        {
                            authority
                            for authorities in plan["journeyAuthorities"].values()
                            for authority in authorities
                        }
                    ),
                    "evidenceFields": 4
                    + sum(len(item.get("blockReasons", [])) for item in evidence),
                    "realJourneyEvidence": evidence,
                    "machineTriageMs": round((time.perf_counter() - row_started) * 1000),
                },
            }
        )
        if len(rows) >= limit:
            break
    machine_times = [row["newProcess"]["machineTriageMs"] for row in rows]
    evidence_rows = [
        evidence for row in rows for evidence in row["newProcess"]["realJourneyEvidence"]
    ]
    return {
        "schemaVersion": 1,
        "sampleSize": len(rows),
        "measurement": {
            "sampleSelection": "latest non-merge commits in the last 90 days that match a registered journey path",
            "consideredCommits": considered,
            "old": "Git history cannot recover human judgment or evidence-assembly minutes; old fields remain unknown.",
            "new": "Machine triage time measured per row by this script, excluding Git startup; persisted reports are reused when their revision matches.",
            "elapsedMs": round((time.perf_counter() - started) * 1000),
            "machineTriageMs": {
                "total": sum(machine_times),
                "median": sorted(machine_times)[len(machine_times) // 2] if machine_times else 0,
            },
            "realJourneyEvidence": {
                "rowsWithPersistedReport": sum(
                    evidence["evidenceSource"] == "verification-report"
                    for evidence in evidence_rows
                ),
                "rowsWithoutPersistedReport": sum(
                    evidence["evidenceSource"] == "no-historical-report"
                    for evidence in evidence_rows
                ),
            },
        },
        "conclusion": {
            "canConfirmHumanTimeReduction": False,
            "reason": "the sampled Git history has no before/after human timing records",
            "whatThisRunProves": [
                "the narrowed registry selects only commits that touch a registered journey path",
                "each selected commit receives deterministic checks, authorities, and evidence fields",
                "missing real-journey reports are surfaced as an explicit execution blocker",
            ],
            "nextMeasurement": "record human triage and evidence-assembly minutes for the next comparable sample, then compare against machineTriageMs and persisted evidence coverage",
        },
        "rows": rows,
    }


def importlib_load(path, name):
    import importlib.util

    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--evidence-root",
        type=Path,
        default=ROOT / "target/ci",
        help="directory containing verification report.json files",
    )
    args = parser.parse_args(argv)
    result = compare(args.limit, args.evidence_root)
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text)
    print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
