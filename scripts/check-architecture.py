"""Validate the machine-readable ownership and dependency boundaries."""

import argparse
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "schemas/architecture-manifest.json"


def load_manifest(path=MANIFEST):
    value = json.loads(path.read_text())
    if value.get("schemaVersion") != 1 or not isinstance(value.get("rules"), list):
        raise ValueError("architecture manifest must use schemaVersion 1 and contain rules")
    seen = set()
    for rule in value["rules"]:
        for key in ("id", "owner", "appliesTo", "forbiddenImportSubstrings", "reason"):
            if key not in rule:
                raise ValueError(f"architecture rule missing {key}: {rule!r}")
        if rule["id"] in seen:
            raise ValueError(f"duplicate architecture rule: {rule['id']}")
        seen.add(rule["id"])
        if not rule["appliesTo"] or not rule["forbiddenImportSubstrings"]:
            raise ValueError(f"architecture rule is empty: {rule['id']}")
    return value


def check(root=ROOT, manifest=None):
    manifest = manifest or load_manifest()
    violations = []
    for rule in manifest["rules"]:
        patterns = rule["forbiddenImportSubstrings"]
        regex = re.compile("|".join(re.escape(value) for value in patterns))
        for pattern in rule["appliesTo"]:
            for path in root.glob(pattern):
                if not path.is_file():
                    continue
                if str(path.relative_to(root)) in rule.get("excludedPaths", []):
                    continue
                for line_number, line in enumerate(
                    path.read_text(errors="replace").splitlines(), 1
                ):
                    is_rust = path.suffix == ".rs"
                    is_import = (
                        (
                            line.lstrip().startswith(("import ", "export ", "from "))
                            or "require(" in line
                        )
                        if not is_rust
                        else line.lstrip().startswith(("use ", "extern crate "))
                    )
                    if is_import and regex.search(line):
                        violations.append(
                            {
                                "rule": rule["id"],
                                "owner": rule["owner"],
                                "path": str(path.relative_to(root)),
                                "line": line_number,
                                "reason": rule["reason"],
                            }
                        )
    return violations


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args(argv)
    violations = check(args.root)
    if violations:
        print(
            json.dumps({"status": "failed", "violations": violations}, ensure_ascii=False, indent=2)
        )
        return 1
    print(
        json.dumps({"status": "passed", "rules": len(load_manifest()["rules"])}, ensure_ascii=False)
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
