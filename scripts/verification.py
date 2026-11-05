#!/usr/bin/env python3
"""Record matching test artifacts, deploy an idle fixed slot, and diagnose startup."""

import argparse
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile

from package import source_input_hash, private_shell_info
from install import TARGETS, verify_bundle


ROOT = Path(__file__).resolve().parents[1]
RECEIPT = "verification-build.json"
LOCK = ".verification-lock"


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def components():
    return ["areal", "areal-runtime", "areal-runtime-fs"] + (
        ["areal-runtime-reaper"] if platform.system() == "Linux" else []
    )


def artifact_files():
    return components() + (
        [
            f"shells/{name}"
            for name in ["bash", "sh", "build.json", "COPYING", "corresponding-source.tar.gz"]
        ]
        if platform.system() == "Darwin"
        else []
    )


def gui_inputs(root):
    paths = (
        subprocess.check_output(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "clients/gui", "services/workbench"],
            cwd=root,
        )
        .decode()
        .split("\0")
    )
    value = hashlib.sha256()
    for path in sorted(set(paths)):
        if not path or not (root / path).is_file():
            continue
        if path.endswith(".md") or any(
            part in {"dist", "node_modules", "test-results"} for part in Path(path).parts
        ):
            continue
        value.update(path.encode() + b"\0" + (root / path).read_bytes() + b"\0")
    return value.hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def renderer_receipt(root, directory):
    receipt = json.loads((directory / RECEIPT).read_text())
    if receipt["inputHash"] != gui_inputs(root):
        raise ValueError("Renderer build inputs differ from checkout; run make gui-build")
    if "index.html" not in receipt["files"]:
        raise ValueError("Renderer receipt must include index.html")
    for name, expected_hash in receipt["files"].items():
        if Path(name).is_absolute() or ".." in Path(name).parts:
            raise ValueError("invalid Renderer artifact path")
        if digest(directory / name) != expected_hash:
            raise ValueError(f"Renderer artifact changed: {name}")
    return receipt


def snapshot_renderer(args):
    source = args.source_dir.resolve()
    receipt = renderer_receipt(args.root, source)
    destination = args.output_dir.resolve()
    destination.mkdir(parents=True, exist_ok=False)
    for name in receipt["files"]:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / name, target)
    # 复制期间输入或产物变化不能被独立目录掩盖；成功回执最后发布。
    if renderer_receipt(args.root, source) != receipt:
        raise ValueError("Renderer build changed during snapshot")
    for name, expected_hash in receipt["files"].items():
        if digest(destination / name) != expected_hash:
            raise ValueError(f"Renderer snapshot changed during copy: {name}")
    result = {
        **receipt,
        "sourceRoot": str(args.root),
        "sourceRevision": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=args.root, text=True
        ).strip(),
        "sourceDirectory": str(source),
        "snapshotDirectory": str(destination),
    }
    write_json(destination / RECEIPT, result)
    return result


@contextmanager
def slot_lock(directory):
    lock = directory / LOCK
    directory.mkdir(parents=True, exist_ok=True)
    try:
        lock.mkdir()
    except FileExistsError as error:
        raise ValueError(
            f"test slot is in use: {lock}; inspect its owner before cleanup"
        ) from error
    try:
        write_json(lock / "owner.json", {"pid": os.getpid()})
        yield
    finally:
        (lock / "owner.json").unlink(missing_ok=True)
        lock.rmdir()


def build_receipt(root, directory):
    if platform.system() == "Darwin":
        private_shell_info(root, directory)
    return {
        "schemaVersion": 1,
        "sourceRoot": str(root),
        "sourceRevision": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=root, text=True
        ).strip(),
        "inputHash": source_input_hash(root),
        "files": {name: digest(directory / name) for name in artifact_files()},
    }


def check_files(directory, receipt):
    if platform.system() == "Darwin" and (directory / "shells").is_symlink():
        raise ValueError("Runtime shells must be a real bundle directory")
    for name in artifact_files():
        path = directory / name
        executable = name in components() or name in {"shells/bash", "shells/sh"}
        if path.is_symlink() or not path.is_file() or (executable and not os.access(path, os.X_OK)):
            raise ValueError(f"missing real artifact: {path}")
        if digest(path) != receipt["files"].get(name):
            raise ValueError(f"artifact changed since build/deployment: {path}")


def deploy(args):
    source = args.source_dir.resolve()
    if (
        not args.bin_dir.is_absolute()
        or args.bin_dir.is_symlink()
        or source == args.bin_dir.resolve()
    ):
        raise ValueError("--bin-dir must be a different absolute real directory")
    destination = args.bin_dir.resolve()
    receipt = json.loads((source / RECEIPT).read_text())
    if receipt["inputHash"] != source_input_hash(args.root):
        raise ValueError("source changed since build; run make build/release first")
    check_files(source, receipt)
    with slot_lock(destination):
        # 复用已有进程与打开文件检查；无法读取占用情况时拒绝覆盖。
        spec = importlib.util.spec_from_file_location(
            "artifact_cleanup", ROOT / "scripts/artifact-cleanup.py"
        )
        cleanup = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cleanup)
        observations, error = cleanup.activity([destination])
        if error:
            raise ValueError(error)
        occupied = cleanup.busy(destination, observations)
        if occupied:
            raise ValueError(f"test slot is in use by PIDs {sorted(occupied)}")
        with tempfile.TemporaryDirectory(prefix=".deploy-", dir=destination) as temporary:
            staging = Path(temporary)
            if platform.system() == "Darwin" and (destination / "shells").is_symlink():
                raise ValueError("Runtime shells must be a real bundle directory")
            for name in artifact_files():
                target = destination / name
                if target.is_symlink():
                    raise ValueError(f"destination must be a real file: {target}")
                (staging / name).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source / name, staging / name)
            check_files(staging, receipt)
            check_files(source, receipt)
            for name in artifact_files():
                target = destination / name
                target.parent.mkdir(parents=True, exist_ok=True)
                if not target.exists() or digest(target) != receipt["files"][name]:
                    os.replace(staging / name, target)
            write_json(destination / RECEIPT, {**receipt, "deploymentDirectory": str(destination)})
        write_json(
            args.evidence,
            {**receipt, "binaryDirectory": str(destination), "authorization": "unknown"},
        )
    return {"passed": True, "evidence": str(args.evidence)}


def probe(path, arguments):
    result = {"path": str(path), "arguments": arguments, "authorization": "unknown"}
    try:
        result["sha256"] = digest(path)
        child = subprocess.run([str(path), *arguments], capture_output=True, text=True, timeout=15)
        result.update(
            exitCode=child.returncode if child.returncode >= 0 else None,
            signal=-child.returncode if child.returncode < 0 else None,
            stdout=child.stdout[:4096],
            stderr=child.stderr[:4096],
            passed=child.returncode == 0,
        )
    except (OSError, subprocess.SubprocessError) as error:
        result.update(passed=False, error=str(error))
    if platform.system() == "Darwin" and path.is_file():
        try:
            signature = subprocess.run(
                ["/usr/bin/codesign", "--verify", "--strict", str(path)],
                capture_output=True,
                text=True,
                timeout=15,
            )
            result["signature"] = {
                "exitCode": signature.returncode,
                "stderr": signature.stderr[:2048],
            }
        except (OSError, subprocess.SubprocessError) as error:
            result["signature"] = {"error": str(error)}
    return result


def doctor(args):
    directory = args.core.resolve().parent
    report = {
        "schemaVersion": 1,
        "passed": False,
        "root": str(args.root),
        "components": {},
        "errors": [],
    }
    for item in args.authorization_observation:
        name, observation = item.split("=", 1)
        if name not in components() or observation not in {
            "unknown",
            "prompt-seen",
            "allowed",
            "denied",
        }:
            raise ValueError(
                "authorization observation must be COMPONENT=unknown|prompt-seen|allowed|denied"
            )
    observations = dict(item.split("=", 1) for item in args.authorization_observation)
    bundle = directory.parent if directory.name == "bin" else None
    bundled = bundle is not None and (bundle / "manifest.json").is_file()
    manifest = None
    bundle_error = None
    if bundled:
        try:
            target = TARGETS.get((platform.system(), platform.machine()))
            if target is None:
                raise ValueError("unsupported bundle platform")
            metadata = json.loads((bundle / "manifest.json").read_text())
            version = str(metadata["productVersion"]).removeprefix("areal ")
            manifest = verify_bundle(bundle, version, target[0])
            if manifest["coreBuild"]["inputHash"] != source_input_hash(args.root):
                raise ValueError("Core/Runtime build inputs differ from checkout")
        except (OSError, ValueError, KeyError) as error:
            bundle_error = str(error)
            report["errors"].append(bundle_error)
    # 无请求参数的文件助手只返回 InvalidArgument，不执行文件操作。
    for name, arguments in [
        ("areal", ["build-info"]),
        ("areal-runtime", ["--version"]),
        ("areal-runtime-fs", []),
    ]:
        path = (
            args.core
            if name == "areal"
            else (bundle / "libexec/areal" / name if bundled else directory / name)
        )
        record = (
            {
                "path": str(path),
                "arguments": arguments,
                "passed": False,
                "error": f"bundle validation failed; program not executed: {bundle_error}",
            }
            if bundle_error
            else probe(path, arguments)
        )
        record["authorization"] = observations.get(name, "unknown")
        report["components"][name] = record
        if not record["passed"]:
            report["errors"].append(
                f"startup probe failed: {path}; inspect signal/exitCode and any security prompt"
            )
    try:
        expected = source_input_hash(args.root)
        if bundled:
            receipt = {"layout": "installedBundle", "bundle": str(bundle), "manifest": manifest}
            if not bundle_error:
                version = probe(args.core, ["--version"])
                report["bundleVersion"] = version
                if not version["passed"] or version["stdout"].strip() != manifest["productVersion"]:
                    raise ValueError("Core version differs from bundle manifest")
        else:
            receipt = json.loads((directory / RECEIPT).read_text())
            check_files(directory, receipt)
            if receipt["inputHash"] != expected:
                raise ValueError(
                    "Core/Runtime build inputs differ from checkout; rebuild and deploy"
                )
        core = report["components"]["areal"]
        if core["passed"] and json.loads(core["stdout"]).get("inputHash") != expected:
            raise ValueError("Core build-info differs from checkout inputs")
        gui = args.root / "clients/gui/renderer/dist"
        renderer = renderer_receipt(args.root, gui)
        report["build"] = {"core": receipt, "renderer": renderer}
    except (OSError, ValueError, KeyError) as error:
        report["errors"].append(str(error))
    report["passed"] = not report["errors"]
    write_json(args.report, report)
    return {"passed": report["passed"], "report": str(args.report), "errors": report["errors"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("gui-inputs")
    snapshot = commands.add_parser("snapshot-renderer")
    snapshot.add_argument("--source-dir", type=Path, required=True)
    snapshot.add_argument("--output-dir", type=Path, required=True)
    record = commands.add_parser("record-core")
    record.add_argument("--profile", choices=("debug", "release"), default="debug")
    copy = commands.add_parser("deploy")
    copy.add_argument("--source-dir", type=Path, required=True)
    copy.add_argument("--bin-dir", type=Path, required=True)
    copy.add_argument("--evidence", type=Path, required=True)
    inspect = commands.add_parser("doctor")
    inspect.add_argument("--core", type=Path, required=True)
    inspect.add_argument("--report", type=Path, required=True)
    inspect.add_argument("--authorization-observation", action="append", default=[])
    args = parser.parse_args()
    args.root = args.root.resolve()
    try:
        if args.command == "gui-inputs":
            result = {"inputHash": gui_inputs(args.root)}
        elif args.command == "snapshot-renderer":
            result = snapshot_renderer(args)
        elif args.command == "record-core":
            directory = args.root / "target" / args.profile
            result = build_receipt(args.root, directory)
            write_json(directory / RECEIPT, result)
        elif args.command == "deploy":
            result = deploy(args)
        else:
            if not args.core.is_absolute():
                raise ValueError("--core must be an absolute path")
            if args.report.exists():
                raise ValueError("report already exists; preserve each diagnosis in a new file")
            result = doctor(args)
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result.get("passed", True) else 1
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(json.dumps({"passed": False, "error": str(error)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
