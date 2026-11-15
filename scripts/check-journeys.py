"""Validate the user journey registry and map changed paths to journeys."""

import argparse
import fnmatch
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "clients/gui/scripts/journey-manifest.json"


def load_manifest(path=MANIFEST):
    value = json.loads(path.read_text())
    if value.get("schemaVersion") != 1 or not isinstance(value.get("journeys"), list):
        raise ValueError("journey manifest must use schemaVersion 1 and contain journeys")
    seen = set()
    for journey in value["journeys"]:
        required = ("id", "title", "surfaces", "paths", "authorities", "terminalFacts", "checks")
        missing = [key for key in required if not journey.get(key)]
        if missing:
            raise ValueError(f"journey {journey.get('id')} missing {', '.join(missing)}")
        if journey["id"] in seen:
            raise ValueError(f"duplicate journey: {journey['id']}")
        seen.add(journey["id"])
    return value


def affected(paths, manifest=None):
    journeys = load_manifest() if manifest is None else manifest
    return [
        journey["id"]
        for journey in journeys["journeys"]
        if any(fnmatch.fnmatchcase(path, pattern) for path in paths for pattern in journey["paths"])
    ]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*")
    args = parser.parse_args(argv)
    manifest = load_manifest()
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
