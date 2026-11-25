"""Compare old manual triage with the registered journey plan for recent commits."""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]


def git(*args):
    return subprocess.check_output(["git", "--no-optional-locks", *args], cwd=ROOT, text=True)


def recent_commits(limit, *, ref="HEAD", all_refs=False):
    args = [
        "log",
        "--format=%H%x09%cI%x09%s",
        "--no-merges",
        "--since=90 days ago",
    ]
    if all_refs:
        args.append("--all")
    else:
        args.append(ref)
    if limit:
        args.extend(["-n", str(limit)])
    args.extend(["--", "core", "clients/gui", "services/workbench", "schemas"])
    rows = git(*args).splitlines()
    parsed = []
    for row in rows:
        commit, committed_at, subject = row.split("\t", 2)
        parsed.append((commit, committed_at, subject))
    return parsed


def observation_window(committed_at, *, days=14, now=None):
    """区分已观察满窗口的提交与仍在观察中的提交，避免用短窗口误判逃逸下降。"""
    current = datetime.now(timezone.utc) if now is None else now
    commit_time = datetime.fromisoformat(committed_at.replace("Z", "+00:00"))
    elapsed_days = round(max(0.0, (current - commit_time).total_seconds() / 86400.0), 2)
    mature = elapsed_days >= days
    return {
        "requiredDays": days,
        "elapsedDays": elapsed_days,
        "mature": mature,
        "status": "mature" if mature else "observing",
    }


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
    validator = importlib_load(ROOT / "scripts/verification-evidence.py", "triage_evidence")
    for path in sorted(evidence_root.glob("**/report.json")):
        try:
            report = json.loads(path.read_text())
            if report.get("identity", {}).get("sourceRevision") != commit:
                continue
            validator.validate(report, json.loads(path.with_name("plan.json").read_text()))
        except (OSError, ValueError, KeyError, TypeError):
            continue
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


def compare(
    limit=10,
    evidence_root=None,
    *,
    ref="HEAD",
    all_refs=False,
    include_unmapped=False,
    observation_days=14,
    now=None,
):
    scope_spec = importlib_load(ROOT / "scripts/ci-scope.py", "compare_ci_scope")
    manifest = json.loads((ROOT / "clients/gui/scripts/test-manifest.json").read_text())
    journey_manifest = json.loads((ROOT / "clients/gui/scripts/journey-manifest.json").read_text())
    rows = []
    started = time.perf_counter()
    considered = 0
    zero_hit_commits = 0
    scan_limit = limit if include_unmapped else max(limit * 4, 25)
    for commit, committed_at, subject in recent_commits(scan_limit, ref=ref, all_refs=all_refs):
        paths = changed_paths(commit)
        affected = scope_spec.journey_registry.affected(paths, journey_manifest)
        if not affected and not include_unmapped:
            continue
        considered += 1
        if not affected:
            zero_hit_commits += 1
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
        window = observation_window(committed_at, days=observation_days, now=now)
        rows.append(
            {
                "commit": commit,
                "committedAt": committed_at,
                "subject": subject,
                "changedPaths": len(paths),
                "observationWindow": window,
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
                "manualBaseline": {
                    "expectedJourneys": None,
                    "firstVerdictCorrect": None,
                    "humanMinutes": None,
                    "fixtureBlocked": None,
                    "escapedDefects": None,
                },
            }
        )
        if len(rows) >= limit:
            break
    machine_times = [row["newProcess"]["machineTriageMs"] for row in rows]
    evidence_rows = [
        evidence for row in rows for evidence in row["newProcess"]["realJourneyEvidence"]
    ]
    mature_commits = sum(row["observationWindow"]["mature"] for row in rows)
    return {
        "schemaVersion": 1,
        "sampleSize": len(rows),
        "measurement": {
            "sampleRef": "--all" if all_refs else ref,
            "includeUnmapped": include_unmapped,
            "sampleSelection": (
                "continuous non-merge commits on the selected ref including zero-journey-hit commits"
                if include_unmapped
                else "latest non-merge commits in the last 90 days that match a registered journey path"
            ),
            "consideredCommits": considered,
            "zeroHitCommits": zero_hit_commits,
            "observationWindow": {
                "requiredDays": observation_days,
                "matureCommits": mature_commits,
                "observingCommits": len(rows) - mature_commits,
            },
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
                (
                    "continuous single-ref sampling preserves zero-journey-hit commits and marks 14-day observation maturity"
                    if include_unmapped
                    else "the narrowed registry selects only commits that touch a registered journey path"
                ),
                "each selected commit receives deterministic checks, authorities, and evidence fields",
                "missing real-journey reports are surfaced as an explicit execution blocker",
            ],
            "nextMeasurement": "record human triage and evidence-assembly minutes for the frozen continuous sample, and only compute escape rates on mature (>=14d) commits",
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
    parser.add_argument("--ref", default="HEAD", help="integration branch or commit ref to sample")
    parser.add_argument(
        "--all", dest="all_refs", action="store_true", help="sample across all refs"
    )
    parser.add_argument(
        "--include-unmapped",
        action="store_true",
        help="include continuous commits with zero matched journeys to measure coverage gaps",
    )
    parser.add_argument(
        "--observation-days",
        type=int,
        default=14,
        help="minimum days elapsed before a commit counts as mature for escape tracking",
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--evidence-root",
        type=Path,
        default=ROOT / "target/ci",
        help="directory containing verification report.json files",
    )
    args = parser.parse_args(argv)
    result = compare(
        args.limit,
        args.evidence_root,
        ref=args.ref,
        all_refs=args.all_refs,
        include_unmapped=args.include_unmapped,
        observation_days=args.observation_days,
    )
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text)
    print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
