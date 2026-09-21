#!/usr/bin/env python3
"""Build a relocatable Harness bundle with an integrity manifest."""

import argparse
import hashlib
import json
import platform
import shutil
import subprocess
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=("debug", "release"), default="release")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    destination = args.output.resolve()
    if destination.exists():
        parser.error("output must not exist")
    if (platform.system(), platform.machine()) != ("Darwin", "arm64"):
        parser.error("the verified package target is macOS arm64")
    names = ("areal", "areal-server", "areal-runtime", "areal-runtime-fs", "areal-tui")
    source = root / "target" / args.profile
    for name in names:
        if not (source / name).is_file():
            parser.error(f"missing {name}; build the selected Cargo profile first")
    python = subprocess.check_output(["/usr/bin/python3", "--version"], text=True).strip()
    files = {}
    (destination / "bin").mkdir(parents=True)
    shutil.copy2(root / "LICENSE", destination / "LICENSE")
    files["LICENSE"] = hashlib.sha256((destination / "LICENSE").read_bytes()).hexdigest()
    for name in names:
        target = destination / "bin" / name
        shutil.copy2(source / name, target)
        subprocess.run(
            ["/usr/bin/codesign", "--force", "--sign", "-", str(target)],
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["/usr/bin/codesign", "--verify", "--strict", str(target)],
            check=True,
            capture_output=True,
        )
        files[f"bin/{name}"] = hashlib.sha256(target.read_bytes()).hexdigest()
    version = subprocess.check_output([str(source / "areal"), "--version"], text=True).strip()
    manifest = {
        "manifestVersion": 1,
        "productVersion": version,
        "sourceRevision": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=root, text=True
        ).strip(),
        "workingTree": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=root)),
        "profile": args.profile,
        "apiVersion": "areal.core.v1",
        "stateVersion": 6,
        "platform": "darwin/arm64",
        "files": files,
        "prerequisites": [
            {"path": "/usr/bin/python3", "verifiedVersion": python},
            {"path": "/usr/bin/sandbox-exec"},
        ],
        "optionalRuntimes": "Node/Python for configured tool hosts; explicitly supplied by deployment",
        "signing": "ad-hoc; Developer ID signing and notarization require a separate distribution pipeline",
    }
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"bundle": str(destination), "manifest": "manifest.json"}))


if __name__ == "__main__":
    main()
