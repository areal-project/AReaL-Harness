#!/usr/bin/env python3
"""Build a relocatable Harness bundle with an integrity manifest."""

import argparse
import hashlib
import json
import platform
import re
import shutil
import subprocess
from pathlib import Path


def bundle_info(root):
    # 复用生成协议与 Store 版本常量，不能让包清单独立漂移。
    schema = json.loads((root / "schemas/areal-core-v1.json").read_text())
    versions = re.findall(
        r"^pub\(crate\) const STATE_VERSION: u32 = (\d+);$",
        (root / "core/engine/src/store.rs").read_text(),
        re.MULTILINE,
    )
    if len(versions) != 1 or not isinstance(schema.get("apiVersion"), str):
        raise ValueError("Core package metadata source is missing or ambiguous")
    return {"apiVersion": schema["apiVersion"], "stateVersion": int(versions[0])}


def source_input_hash(root):
    paths = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard"], cwd=root, text=True
    ).splitlines()
    selected = sorted(
        set(
            path
            for path in paths
            if path.endswith((".rs", "Cargo.toml", "Cargo.lock"))
            or path == "rust-toolchain.toml"
            or path.startswith("schemas/")
            and path.endswith(".json")
        )
    )
    value = hashlib.sha256()
    for path in selected:
        value.update(path.encode())
        value.update(b"\0")
        value.update((root / path).read_bytes())
        value.update(b"\0")
    return value.hexdigest()


def validate_build_info(info, revision, fingerprint, metadata):
    if (
        not isinstance(info, dict)
        or info.get("sourceRevision") != revision
        or info.get("inputHash") != fingerprint
        or any(info.get(key) != value for key, value in metadata.items())
    ):
        raise ValueError(
            "input Core binary does not match checkout inputs; rebuild before packaging"
        )
    if info.get("workingTree") not in ("true", "false"):
        raise ValueError("input Core build identity is unknown")
    return info


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=("debug", "release"), default="release")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--unsigned-local",
        action="store_true",
        help="preserve input bytes without creating signatures; local validation only",
    )
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    destination = args.output.resolve()
    metadata = bundle_info(root)
    if destination.exists():
        parser.error("output must not exist")
    targets = {("Darwin", "arm64"): "darwin/arm64", ("Linux", "x86_64"): "linux/x86_64"}
    target_platform = targets.get((platform.system(), platform.machine()))
    if target_platform is None:
        parser.error("package targets are macOS arm64 and Linux x86_64")
    names = ["areal", "areal-runtime", "areal-runtime-fs"]
    if platform.system() == "Linux":
        names.append("areal-runtime-reaper")
    source = root / "target" / args.profile
    for name in names:
        if not (source / name).is_file():
            parser.error(f"missing {name}; build the selected Cargo profile first")
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    identity = validate_build_info(
        json.loads(subprocess.check_output([str(source / "areal"), "build-info"], text=True)),
        revision,
        source_input_hash(root),
        metadata,
    )
    files = {}
    (destination / "bin").mkdir(parents=True)
    shutil.copy2(root / "LICENSE", destination / "LICENSE")
    files["LICENSE"] = hashlib.sha256((destination / "LICENSE").read_bytes()).hexdigest()
    for name in names:
        relative = Path("bin" if name == "areal" else "libexec/areal") / name
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / name, target)
        if platform.system() == "Darwin" and not args.unsigned_local:
            # 保留构建产物的有效签名和字节，不能隐式改变已验收二进制的代码身份。
            # 缺失或损坏的签名必须由构建流程修复，打包阶段不能掩盖它们。
            subprocess.run(
                ["/usr/bin/codesign", "--verify", "--strict", str(target)],
                check=True,
                capture_output=True,
            )
        files[str(relative)] = hashlib.sha256(target.read_bytes()).hexdigest()
        if (
            args.unsigned_local
            and files[str(relative)] != hashlib.sha256((source / name).read_bytes()).hexdigest()
        ):
            raise ValueError(f"unsigned local copy changed input bytes: {name}")
    version = subprocess.check_output([str(source / "areal"), "--version"], text=True).strip()
    manifest = {
        "manifestVersion": 2,
        "productVersion": version,
        "sourceRevision": identity["sourceRevision"],
        "workingTree": identity["workingTree"] == "true",
        "coreBuild": identity,
        "profile": args.profile,
        **metadata,
        "platform": target_platform,
        "files": files,
        "prerequisites": [
            *(
                [
                    {"path": "/usr/bin/sandbox-exec"},
                    {
                        "path": "/usr/bin/python3",
                        "requiredFor": "macOS Runtime and trusted helper launch; executable interpreter required",
                    },
                ]
                if platform.system() == "Darwin"
                else [
                    {"glibc": ">=2.35", "verifiedVersion": platform.libc_ver()[1]},
                    {
                        "path": "/usr/bin/bwrap",
                        "requiredFor": "restricted scopes; usable user namespaces required",
                    },
                ]
            ),
        ],
        "optionalRuntimes": "Node/Python for configured tool hosts; explicitly supplied by deployment",
        "signing": "no new signatures; input signatures preserved; local validation only"
        if args.unsigned_local
        else "input signatures preserved and verified; distribution signing and notarization handled separately"
        if platform.system() == "Darwin"
        else "unsigned; verify release SHA256SUMS",
    }
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"bundle": str(destination), "manifest": "manifest.json"}))


if __name__ == "__main__":
    main()
