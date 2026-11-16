"""Versioned native release with explicit public-input and phase-clock SDK overlay."""
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tarfile
import tempfile
import time
import zipfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def prepare(base_sdk, core_archive, expected, destination, sdk_overlays=None):
    destination = Path(destination)
    if destination.exists():
        raise ValueError("Fresh versioned runtime directory required")
    if sha(core_archive) != expected["core_archive_sha256"]:
        raise ValueError("Native core archive digest differs")
    with zipfile.ZipFile(base_sdk) as archive:
        original = json.loads(archive.read("manifest.json"))
        if original.get("sourceRevision") != expected["base_source_revision"]:
            raise ValueError("Original immutable SDK revision differs")
        for name, digest in expected["base_code_sha256"].items():
            if sha(archive.read(name)) != digest:
                raise ValueError("Original immutable SDK code differs: " + name)
        if sum(member.file_size for member in archive.infolist()) > 512 * 1024 * 1024:
            raise ValueError("Bounded immutable SDK required")
        destination.mkdir(mode=0o700)
        for member in archive.infolist():
            path = Path(member.filename)
            if path.is_absolute() or ".." in path.parts or stat.S_ISLNK(member.external_attr >> 16):
                raise ValueError("Unsafe immutable SDK member")
            target = destination / path
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(member) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output)
    with tarfile.open(fileobj=io.BytesIO(core_archive), mode="r:gz") as archive:
        manifest = json.loads(archive.extractfile("areal/manifest.json").read())
        if manifest.get("sourceRevision") != expected["native_source_revision"] or manifest.get("workingTree"):
            raise ValueError("Clean verified native release required")
        for name, digest in manifest["files"].items():
            path = Path(name)
            if path.is_absolute() or ".." in path.parts:
                raise ValueError("Unsafe native release member")
            member = archive.getmember("areal/" + name)
            if not member.isfile() or member.size > 128 * 1024 * 1024:
                raise ValueError("Regular bounded native release member required")
            data = archive.extractfile(member).read()
            if sha(data) != digest:
                raise ValueError("Native binary digest differs: " + name)
            target = destination / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        (destination / "base-native-manifest.json").write_text(json.dumps(original, indent=2) + "\n")
        (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    sdk_overlays = sdk_overlays or {}
    if set(sdk_overlays) != set(expected.get("sdk_overlay_sha256", {})) or set(sdk_overlays) - {"runner", "image_ingress.py", "image-ingress-helper", "launch.py"}:
        raise ValueError("Exact declared versioned SDK overlay required")
    for name, data in sdk_overlays.items():
        if len(data) > (128 * 1024 * 1024 if name == "image-ingress-helper" else 1024 * 1024) or sha(data) != expected["sdk_overlay_sha256"][name]:
            raise ValueError("Versioned SDK overlay digest differs")
        (destination / name).write_bytes(data)
        if name == "image-ingress-helper":
            (destination / name).chmod(0o755)
    # 只改变新版本解包目录，原 SDK、策略与工作区图片保持原字节。
    for name in expected["base_code_sha256"]:
        if sha((destination / name).read_bytes()) != expected.get("sdk_overlay_sha256", {}).get(name, expected["base_code_sha256"][name]):
            raise ValueError("Original SDK entry changed during release assembly")
    for folder in [destination / "bin", destination / "lib", destination / "libexec/areal"]:
        if folder.exists():
            for path in folder.iterdir():
                if path.is_file():
                    path.chmod(0o755)
    tool = destination / "bin/tools/rg"
    if tool.exists():
        tool.chmod(0o755)
    receipt = {"schema": "versioned-native-image-preview/v2" if sdk_overlays else "versioned-native-image-preview/v1", "native_source_revision": manifest["sourceRevision"], "native_files": manifest["files"], "base_source_revision": original["sourceRevision"], "base_code_unchanged": not bool(sdk_overlays), "request_proxy": False}
    if sdk_overlays:
        receipt["sdk_overlay_sha256"] = expected["sdk_overlay_sha256"]
        receipt["initial_input_policy"] = "approved-public-originals-with-ingress-preview/v1" if expected.get("input_ingress") else "exact-public-workspace-materials-anchor-and-three-views/v1"
        receipt["image_history_policy"] = {"max_request_images": 16, "public_references": 2, "recent_tool_images": 14, "persistent_history_unchanged": True}
        receipt["phase_clock_policy"] = "shared-loader-origin-native3510-terminate3525-grace10-for3600"
        if "input_carrier_policy" in expected:
            receipt["input_carrier_policy"] = expected["input_carrier_policy"]
        for name in ("terminal_notification_policy", "terminal_capture_policy", "input_ingress"):
            if name in expected:
                receipt[name] = expected[name]
    return receipt


def main():
    # Capture before large native extraction so it cannot extend the phase.
    phase_started = time.monotonic()
    with zipfile.ZipFile(sys.argv[0]) as archive:
        expected = json.loads(archive.read("release-binding.json"))
        core_archive = archive.read("native-core.tar.gz")
        sdk_overlays = {name: archive.read("sdk-overlays/" + name) for name in expected.get("sdk_overlay_sha256", {})}
    base = Path(os.environ["ARENA_ENV_DIR"]) / expected["base_sdk_destination"]
    if base.is_symlink() or not base.is_file():
        raise ValueError("Pinned immutable SDK Env asset required")
    parent = Path(tempfile.mkdtemp(prefix="areal-image-preview-release-"))
    runtime = parent / "sdk"
    receipt = prepare(base, core_archive, expected, runtime, sdk_overlays)
    output = Path(os.environ["ARENA_AGENT_OUTPUT_DIR"])
    output.mkdir(parents=True, exist_ok=True)
    (output / "image-preview-runtime.json").write_text(json.dumps(receipt, indent=2) + "\n")
    if sdk_overlays:
        os.environ["AREAL_ARENA_PHASE_STARTED_MONOTONIC"] = str(phase_started)
    with zipfile.ZipFile(sys.argv[0]) as bundle:
        for name in bundle.namelist():
            if name.startswith("cc-blender-skills/") or name in {"cc_skill_support.py", "cc-skill-instructions.md", "cc-skill-manifest.json", "CC-BLENDER-LICENSE"}:
                member = Path(name)
                if member.is_absolute() or ".." in member.parts:
                    raise ValueError("Unsafe Skill bundle path")
                target = runtime / member
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(bundle.read(name))
    workspace = Path(os.environ.get('ARENA_AGENT_WORKDIR') or os.environ.get('ARENA_WORKSPACE') or '/envarena/workspace')
    skill_manifest = json.loads((runtime/'cc-skill-manifest.json').read_text())
    for relative, expected_sha in skill_manifest['skill_files_sha256'].items():
        member = Path(relative)
        if member.is_absolute() or '..' in member.parts:
            raise ValueError('Unsafe native Skill path')
        data = (runtime/'cc-blender-skills'/member).read_bytes()
        if sha(data) != expected_sha:
            raise ValueError('Skill library digest mismatch')
        target = workspace/'.agents/skills'/member
        ancestors = (target, *list(target.parents)[:len(target.relative_to(workspace).parts)-1])
        if any(parent.is_symlink() for parent in ancestors):
            raise ValueError('Symlink in native Skill destination')
        if target.exists() and target.read_bytes() != data:
            raise ValueError('New Skill must not replace original task Skill: '+relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    discovery = {'native_skill_directory':str(workspace/'.agents/skills'),
        'mounted_skill_count':len(skill_manifest['skill_names']),
        'mounted_skill_files':len(skill_manifest['skill_files_sha256']),
        'upstream_commit':skill_manifest['upstream_commit'],
        'task_checkpoint_supplied':False}
    (runtime/'native-skill-discovery.json').write_text(json.dumps(discovery))
    os.execv(sys.executable, [sys.executable, str(runtime / "runner")])


if __name__ == "__main__":
    main()
