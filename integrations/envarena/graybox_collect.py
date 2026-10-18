"""Publish Graybox deliverables from the local workspace to Arena's reward input."""

import hashlib
from pathlib import Path
import shutil
import stat

DIRECTORIES = ("stages", "scripts", "renders", "docs")
ROOT_SUFFIXES = {".blend", ".py", ".md", ".json", ".txt", ".png", ".jpg", ".jpeg", ".webp"}
RESERVED = {
    "native-input.txt",
    "harness_result.json",
    "native-receipt.json",
    "graybox-collection.json",
    "public-input-baseline.json",
    "runtime-utilities.json",
    "input-media.json",
    "media-upload-receipt.json",
    "core-export.json",
    "diagnostic-export.json",
    "deployment-environment.json",
    "test-content-audit.json",
    "tool-extensions.json",
}


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def collect(workspace, output):
    workspace, output = Path(workspace), Path(output)
    files = {}

    def visit(path, relative):
        mode = path.lstat().st_mode
        if stat.S_ISLNK(mode) or not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
            raise ValueError("Unsupported delivery link or special file: " + str(relative))
        if stat.S_ISDIR(mode):
            for child in sorted(path.iterdir()):
                visit(child, relative / child.name)
            return
        sha = digest(path)
        previous = files.get(str(relative))
        if previous and previous["sha256"] != sha:
            raise ValueError("Conflicting workspace/output deliverable: " + str(relative))
        files[str(relative)] = {"source": path, "sha256": sha, "bytes": path.stat().st_size}

    for base in (workspace, workspace / "output"):
        if base.is_symlink():
            raise ValueError("Delivery root cannot be a symlink")
        if not base.is_dir():
            continue
        root_files = [
            p.name
            for p in base.iterdir()
            if (p.is_file() or p.is_symlink())
            and not p.name.startswith(".")
            and p.name not in RESERVED
            and p.suffix.lower() in ROOT_SUFFIXES
        ]
        names = list(DIRECTORIES) + root_files
        if base == workspace / "output":
            names += [
                p.name
                for p in base.iterdir()
                if p.is_dir()
                and p.name not in DIRECTORIES
                and not p.name.startswith(".")
                and p.name not in {"public", "core-data", "scratch", "problem-assets"}
            ]
        for name in names:
            path = base / name
            if path.exists() or path.is_symlink():
                visit(path, Path(name))
    # Preflight all sources before writing; never collect public inputs, oracle,
    # arbitrary workspace state or files that can overwrite runner diagnostics.
    output.mkdir(parents=True, exist_ok=True)
    receipt = []
    for relative, record in sorted(files.items()):
        target = output / relative
        for parent in [target, *target.parents]:
            if parent == output.parent:
                break
            if parent.is_symlink():
                raise ValueError("Delivery destination contains a symlink")
        target.parent.mkdir(parents=True, exist_ok=True)
        # Closed ordinary copy works on OSS/FUSE; do not depend on rename support.
        with record["source"].open("rb") as src, target.open("wb") as dst:
            shutil.copyfileobj(src, dst, 1024 * 1024)
        if digest(target) != record["sha256"]:
            raise ValueError("Published delivery hash mismatch: " + relative)
        receipt.append({"path": relative, "bytes": record["bytes"], "sha256": record["sha256"]})
    return {
        "schema": "graybox-delivery-collection/v1",
        "status": "OK",
        "source_workspace": str(workspace),
        "destination": str(output),
        "file_count": len(receipt),
        "files": receipt,
    }
