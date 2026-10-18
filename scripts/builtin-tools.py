#!/usr/bin/env python3
"""构建固定源码的内置 rg；运行时只使用已安装的产物。"""

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", default="debug")
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--fetch-only", action="store_true")
    args = parser.parse_args()
    pin = json.loads((ROOT / "upstream/pins.json").read_text())["ripgrep"]
    cache = ROOT / "target/builtin-tools"
    cache.mkdir(parents=True, exist_ok=True)
    archive = args.archive or cache / f"ripgrep-{pin['version']}.tar.gz"
    if not archive.exists():
        with tempfile.NamedTemporaryFile(dir=cache, delete=False) as temporary:
            download = Path(temporary.name)
        try:
            subprocess.run(
                [
                    "curl",
                    "--fail",
                    "--location",
                    "--retry",
                    "2",
                    "--max-time",
                    "120",
                    pin["archive"],
                    "--output",
                    str(download),
                ],
                check=True,
            )
            if digest(download) != pin["sourceSha256"]:
                raise ValueError("ripgrep source checksum mismatch")
            os.replace(download, archive)
        finally:
            download.unlink(missing_ok=True)
    if digest(archive) != pin["sourceSha256"]:
        raise ValueError("ripgrep source checksum mismatch")
    source = cache / f"ripgrep-{pin['version']}"
    if not source.is_dir() or not (source / "Cargo.toml").is_file():
        if source.is_symlink():
            source.unlink()
        elif source.exists():
            shutil.rmtree(source)
        with tempfile.TemporaryDirectory(dir=cache) as directory:
            with tarfile.open(archive) as bundle:
                # 固定摘要之外仍验证解包边界，不允许链接或特殊文件逃逸。
                for member in bundle.getmembers():
                    path = Path(directory) / member.name
                    if not path.resolve().is_relative_to(Path(directory).resolve()):
                        raise ValueError("archive path escapes extraction directory")
                    if (
                        member.issym()
                        and member.name == f"{source.name}/HomebrewFormula"
                        and member.linkname == "pkg/brew"
                    ):
                        continue
                    if not (member.isfile() or member.isdir()):
                        raise ValueError("archive contains a link or special file")
                bundle.extractall(
                    directory, members=[m for m in bundle.getmembers() if not m.issym()]
                )
            os.replace(Path(directory) / source.name, source)
    if args.fetch_only:
        subprocess.run(["cargo", "fetch", "--locked"], cwd=source, check=True)
        return
    destination = ROOT / "target" / args.profile / "tools"
    expected_platform = f"{ {'Darwin': 'macos', 'Linux': 'linux'}[platform.system()] }-{ {'arm64': 'aarch64'}.get(platform.machine(), platform.machine()) }"
    manifest_path = destination / "rg.json"
    if manifest_path.exists() and (destination / "rg").is_file():
        try:
            manifest = json.loads(manifest_path.read_text())
        except (ValueError, OSError):
            manifest = {}
        if (
            manifest.get("version") == pin["version"]
            and manifest.get("manifestVersion") == 1
            and manifest.get("sourceSha256") == pin["sourceSha256"]
            and manifest.get("platform") == expected_platform
            and manifest.get("sha256") == digest(destination / "rg")
        ):
            print(f"builtin rg {pin['version']} verified: {destination}")
            return
    # 不继承调用者的 target 目录或交叉编译目标；工具必须匹配本次部署的宿主。
    build_env = os.environ.copy()
    build_env.pop("CARGO_BUILD_TARGET", None)
    build_env["CARGO_TARGET_DIR"] = str(source / "target")
    subprocess.run(
        [
            "cargo",
            "build",
            "--locked",
            "--release",
            "--manifest-path",
            str(source / "Cargo.toml"),
            "--bin",
            "rg",
        ],
        cwd=source,
        env=build_env,
        check=True,
    )
    destination.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source / "target/release/rg", destination / "rg")
    if platform.system() == "Darwin":
        subprocess.run(
            ["/usr/bin/codesign", "--force", "--sign", "-", str(destination / "rg")], check=True
        )
    licenses = destination / "licenses"
    licenses.mkdir(exist_ok=True)
    for name in ("COPYING", "LICENSE-MIT", "UNLICENSE"):
        shutil.copy2(source / name, licenses / name)
    metadata = json.loads(
        subprocess.check_output(
            ["cargo", "metadata", "--locked", "--format-version", "1"], cwd=source
        )
    )
    inventory = [
        {"name": p["name"], "version": p["version"], "license": p["license"], "source": p["source"]}
        for p in metadata["packages"]
    ]
    (licenses / "dependencies.json").write_text(json.dumps(inventory, indent=2) + "\n")
    for package in metadata["packages"]:
        package_root = Path(package["manifest_path"]).parent
        candidates = {
            p
            for p in package_root.iterdir()
            if p.is_file()
            and p.name.upper().startswith(("LICENSE", "LICENCE", "COPYING", "UNLICENSE"))
        }
        if package.get("license_file"):
            candidates.add(package_root / package["license_file"])
        for original in candidates:
            target = licenses / f"{package['name']}-{package['version']}" / original.name
            target.parent.mkdir(exist_ok=True)
            shutil.copy2(original, target)
    manifest_path.write_text(
        json.dumps(
            {
                "version": pin["version"],
                "manifestVersion": 1,
                "revision": pin["revision"],
                "sourceSha256": pin["sourceSha256"],
                "sha256": digest(destination / "rg"),
                "platform": expected_platform,
            },
            indent=2,
        )
        + "\n"
    )
    print(f"builtin rg {pin['version']} installed: {destination}")


if __name__ == "__main__":
    main()
