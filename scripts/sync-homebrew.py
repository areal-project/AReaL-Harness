#!/usr/bin/env python3
"""从已公开且校验过的 Release 同步 tap：CLI 写 formula，GUI 写 cask；不创建凭据或仓库。"""

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.request

REPO = "areal-project/AReaL-Harness"
TAP = "areal-project/homebrew-tap"


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--tap-checkout", type=Path, required=True)
    parser.add_argument("--push", action="store_true")
    args = parser.parse_args()
    match = re.fullmatch(r"(gui-)?v(\d+\.\d+\.\d+(?:-beta\.[1-9]\d*)?)", args.tag)
    if not match:
        raise ValueError("expected stable or beta CLI tag (vX.Y.Z) or GUI tag (gui-vX.Y.Z)")
    gui = bool(match[1])
    version = match[2]
    beta = "-beta." in version
    release = json.loads(
        run(
            "gh",
            "release",
            "view",
            args.tag,
            "--repo",
            REPO,
            "--json",
            "isDraft,isPrerelease,tagName",
        )
    )
    if release["isDraft"] or release["isPrerelease"] != beta:
        raise ValueError("release must be public and match formula channel")
    checkout = args.tap_checkout.resolve()
    metadata = json.loads(run("gh", "repo", "view", TAP, "--json", "visibility"))
    if metadata["visibility"] != "PUBLIC":
        raise ValueError("tap must be publicly accessible")
    if run("git", "-C", str(checkout), "status", "--porcelain"):
        raise ValueError("tap checkout must be clean")
    remote = run("git", "-C", str(checkout), "remote", "get-url", "origin")
    if remote not in (f"https://github.com/{TAP}.git", f"git@github.com:{TAP}.git"):
        raise ValueError("tap remote does not match authorized repository")
    if gui:
        name = "areal-harness@beta.rb" if beta else "areal-harness.rb"
        formula = checkout / "Casks" / name
    else:
        formula = checkout / "Formula" / ("areal-beta.rb" if beta else "areal.rb")
    if formula.exists():
        previous = re.search(r'  version "([^"]+)"', formula.read_text())

        def order(v):
            base, _, suffix = v.partition("-beta.")
            return (*map(int, base.split(".")), not bool(suffix), int(suffix or 0))

        if not previous or order(version) < order(previous[1]):
            raise ValueError("refusing formula downgrade")
    spec = importlib.util.spec_from_file_location(
        "release_artifacts", Path(__file__).with_name("release-artifacts.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with tempfile.TemporaryDirectory(prefix="areal-tap-sync-") as temp:
        root = Path(temp)
        base = f"https://github.com/{REPO}/releases/download/{args.tag}"

        def download(name):
            destination = root / name
            with (
                urllib.request.urlopen(f"{base}/{name}", timeout=120) as response,
                destination.open("xb") as output,
            ):
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            return destination

        sums = download("SHA256SUMS").read_text().splitlines()

        def verified(name):
            path = download(name)
            expected = [
                line.split()[0]
                for line in sums
                if len(line.split()) == 2 and line.split()[1] == name
            ]
            if len(expected) != 1 or hashlib.sha256(path.read_bytes()).hexdigest() != expected[0]:
                raise ValueError(f"public asset checksum mismatch: {name}")
            return path

        if gui:
            # cask 由 release-assets.mjs 生成并计入 SHA256SUMS；这里再核对它引用的 DMG。
            cask = verified(formula.name).read_text()
            dmg = verified(f"AReaLHarness-{version}-macos-arm64.dmg")
            if f'version "{version}"' not in cask or (
                f'sha256 "{hashlib.sha256(dmg.read_bytes()).hexdigest()}"' not in cask
            ):
                raise ValueError("published cask does not match its DMG")
            formula.parent.mkdir(exist_ok=True)
            formula.write_text(cask)
        if not gui:
            archives = [
                verified(f"areal-harness-{args.tag}-{target}.tar.gz")
                for target in ("aarch64-apple-darwin", "x86_64-unknown-linux-gnu")
            ]
            module.formula(archives[0], formula, extra_archives=archives[1:])
    if args.push and run("git", "-C", str(checkout), "status", "--porcelain"):
        subprocess.run(["git", "-C", str(checkout), "add", str(formula)], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(checkout),
                "commit",
                "-m",
                f"Update {'beta' if beta else 'stable'} {'GUI' if gui else 'CLI'} to {version}",
            ],
            check=True,
        )
        subprocess.run(["git", "-C", str(checkout), "push", "origin", "HEAD:main"], check=True)
    print(formula)


if __name__ == "__main__":
    main()
