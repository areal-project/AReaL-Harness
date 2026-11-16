"""Validate the user journey registry and map changed paths to journeys."""

import argparse
import fnmatch
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "clients/gui/scripts/journey-manifest.json"


def load_manifest(path=MANIFEST):
    value = json.loads(path.read_text())
    if value.get("schemaVersion") != 1 or not isinstance(value.get("journeys"), list):
        raise ValueError("journey manifest must use schemaVersion 1 and contain journeys")
    seen = set()
    boundaries = {}
    for boundary in value.get("boundaries", []):
        name = boundary.get("id")
        if not name or name in boundaries or not boundary.get("paths"):
            raise ValueError("shared boundary must have a unique id and paths")
        boundaries[name] = boundary
    for journey in value["journeys"]:
        required = ("id", "title", "surfaces", "paths", "authorities", "terminalFacts", "checks")
        missing = [key for key in required if not journey.get(key)]
        if missing:
            raise ValueError(f"journey {journey.get('id')} missing {', '.join(missing)}")
        if journey["id"] in seen:
            raise ValueError(f"duplicate journey: {journey['id']}")
        seen.add(journey["id"])
        for key in ("checks", "boundaries"):
            entries = journey.get(key, [])
            if not isinstance(entries, list) or len(entries) != len(set(entries)):
                raise ValueError(f"journey {journey['id']} has invalid or duplicate {key}")
        if set(journey.get("boundaries", [])) - boundaries.keys():
            raise ValueError(f"journey {journey['id']} references an unknown boundary")
    return value


def affected(paths, manifest=None):
    journeys = load_manifest() if manifest is None else manifest
    boundaries = {item["id"]: item["paths"] for item in journeys.get("boundaries", [])}
    return [
        journey["id"]
        for journey in journeys["journeys"]
        if any(
            fnmatch.fnmatchcase(path, pattern)
            for path in paths
            for pattern in journey["paths"]
            + [pattern for name in journey.get("boundaries", []) for pattern in boundaries[name]]
        )
    ]


def validate_checks(manifest, items, journey_ids=None):
    planned = {item["id"] for item in items}
    for journey in manifest["journeys"]:
        if journey_ids is not None and journey["id"] not in journey_ids:
            continue
        missing = set(journey["checks"]) - planned
        if missing:
            raise ValueError(f"journey {journey['id']} has unplanned checks: {sorted(missing)}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*")
    args = parser.parse_args(argv)
    manifest = load_manifest()
    # 使用真实计划检查 ID，避免登记了测试却没有任何执行入口。
    spec = importlib.util.spec_from_file_location("journey_scope", ROOT / "scripts/ci-scope.py")
    scope = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(scope)
    tests = json.loads((ROOT / "clients/gui/scripts/test-manifest.json").read_text())
    paths = [path for journey in manifest["journeys"] for path in journey["paths"]]
    plan = scope.build_plan(paths, {"baseRevision": "HEAD"}, tests)
    validate_checks(manifest, plan["items"])
    result = {
        "status": "passed",
        "journeys": affected(args.paths, manifest)
        if args.paths
        else [j["id"] for j in manifest["journeys"]],
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
