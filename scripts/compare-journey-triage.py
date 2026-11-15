"""Compare old manual triage with the registered journey plan for recent commits."""

import argparse
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
    return [tuple(row.split("\t", 1)) for row in rows[:limit]]


def changed_paths(commit):
    return [
        path
        for path in git("diff-tree", "--no-commit-id", "--name-only", "-r", commit).splitlines()
        if path
    ]


def compare(limit=10):
    scope_spec = importlib_load(ROOT / "scripts/ci-scope.py", "compare_ci_scope")
    manifest = json.loads((ROOT / "clients/gui/scripts/test-manifest.json").read_text())
    rows = []
    started = time.perf_counter()
    for commit, subject in recent_commits(limit):
        paths = changed_paths(commit)
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
        rows.append(
            {
                "commit": commit,
                "subject": subject,
                "changedPaths": len(paths),
                "oldProcess": {
                    "journeys": "manual/unknown",
                    "authorities": "manual/unknown",
                    "evidenceFields": "manual/unknown",
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
                    "evidenceFields": 4,
                },
            }
        )
    return {
        "schemaVersion": 1,
        "sampleSize": len(rows),
        "measurement": {
            "old": "Git history cannot recover human minutes; old fields are therefore marked unknown.",
            "new": "Machine triage time measured by this script, excluding git startup.",
            "elapsedMs": round((time.perf_counter() - started) * 1000),
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
    args = parser.parse_args(argv)
    result = compare(args.limit)
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text)
    print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
