"""Check or explicitly synchronize the Cordis Git pin from Cargo.lock."""

import argparse
import json
import re
import tomllib
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


def expected_pin(root):
    manifest = tomllib.loads((root / "Cargo.toml").read_text())
    dependency = manifest["workspace"]["dependencies"]["cordis-rs"]
    packages = tomllib.loads((root / "Cargo.lock").read_text())["package"]
    selected = {}
    for name in ("cordis-rs", "cordis-core"):
        matches = [package for package in packages if package["name"] == name]
        if len(matches) != 1:
            raise ValueError(f"expected exactly one locked {name} package")
        selected[name] = matches[0]
    source = selected["cordis-rs"].get("source", "")
    if not source.startswith("git+") or selected["cordis-core"].get("source") != source:
        raise ValueError("Cordis facade and core must use the same Git revision")
    url = urlsplit(source[4:])
    repository = url._replace(query="", fragment="").geturl()
    if repository != dependency["git"] or parse_qs(url.query) != {"branch": [dependency["branch"]]}:
        raise ValueError("Cargo.lock does not match the configured Cordis Git branch")
    if not re.fullmatch(r"[0-9a-f]{40}", url.fragment):
        raise ValueError("Cargo.lock must contain a complete Cordis Git revision")
    return {
        "repository": repository,
        "branch": dependency["branch"],
        "revision": url.fragment,
        "version": selected["cordis-rs"]["version"],
        "coreVersion": selected["cordis-core"]["version"],
        "integrated": True,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--write", action="store_true", help="update pins.json after an intentional Cargo update"
    )
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    try:
        expected = expected_pin(root)
        path = root / "upstream/pins.json"
        pins = json.loads(path.read_text())
        if args.write:
            pins["cordisRs"] = expected
            path.write_text(json.dumps(pins, ensure_ascii=False, indent=2) + "\n")
        elif pins.get("cordisRs") != expected:
            raise ValueError(
                "Cordis pin differs from Cargo.lock; after an intentional update run python3 scripts/cordis-pin.py --write"
            )
    except (KeyError, ValueError, OSError) as error:
        parser.exit(1, f"Cordis pin check failed: {error}\n")
    print(
        f"Cordis Git pin: {expected['revision']} (cordis-rs {expected['version']}, cordis-core {expected['coreVersion']})"
    )


if __name__ == "__main__":
    main()
