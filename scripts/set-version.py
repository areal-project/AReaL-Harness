#!/usr/bin/env python3
"""把 CLI/TUI/Host 与 GUI 设为同一版本号（X.Y.Z 或 X.Y.Z-beta.N），不允许回退。"""

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATTERN = re.compile(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?")
GUI_PACKAGES = ("clients/gui/package.json", "clients/gui/app/package.json")


def order(version):
    match = PATTERN.fullmatch(version)
    if not match:
        raise ValueError(f"version must be X.Y.Z or X.Y.Z-beta.N: {version}")
    major, minor, patch, beta = match.groups()
    return (int(major), int(minor), int(patch), beta is None, int(beta or 0))


def current(root):
    cargo = (root / "Cargo.toml").read_text()
    cli = re.search(r'(?ms)^\[workspace\.package\].*?^version = "([^"]+)"', cargo)[1]
    gui = [json.loads((root / path).read_text())["version"] for path in GUI_PACKAGES]
    return cli, gui


def set_version(root, version):
    cli, gui = current(root)
    for previous in [cli, *gui]:
        if PATTERN.fullmatch(previous) and order(version) < order(previous):
            raise ValueError(f"refusing to move version {previous} back to {version}")
    order(version)
    cargo = root / "Cargo.toml"
    text = cargo.read_text()
    cargo.write_text(
        re.sub(
            r'(?ms)(^\[workspace\.package\].*?^version = ")[^"]+(")',
            rf"\g<1>{version}\g<2>",
            text,
            count=1,
        )
    )
    lock = root / "Cargo.lock"
    if lock.exists():
        # 工作区成员在 Cargo.lock 里没有 source 行；只改这些条目的版本。
        blocks = lock.read_text().split("\n\n")
        for index, block in enumerate(blocks):
            if (
                block.startswith("[[package]]")
                and "\nsource = " not in block
                and f'\nversion = "{cli}"' in block
            ):
                blocks[index] = block.replace(f'\nversion = "{cli}"', f'\nversion = "{version}"', 1)
        lock.write_text("\n\n".join(blocks))
    for path in GUI_PACKAGES:
        file = root / path
        text = file.read_text()
        file.write_text(re.sub(r'("version":\s*")[^"]+(")', rf"\g<1>{version}\g<2>", text, count=1))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version", nargs="?")
    parser.add_argument(
        "--check", action="store_true", help="require CLI and GUI versions to match"
    )
    args = parser.parse_args()
    if args.version:
        set_version(ROOT, args.version)
    cli, gui = current(ROOT)
    print(json.dumps({"cli": cli, "gui": gui}))
    if args.check and any(version != cli for version in gui):
        raise SystemExit("CLI and GUI versions differ; run scripts/set-version.py X.Y.Z")


if __name__ == "__main__":
    main()
