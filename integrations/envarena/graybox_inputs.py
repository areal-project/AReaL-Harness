import hashlib
import json
import os
import pathlib
import shutil
import stat
import tarfile
import tempfile
from pathlib import Path


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


class PublicInputError(RuntimeError):
    """Public input preparation or integrity failed; do not start/accept the agent."""


def public_manifest(public):
    """Hash a nonempty regular-file tree without following any links."""
    public = pathlib.Path(public)
    if public.is_symlink() or not public.is_dir():
        raise PublicInputError("Missing regular public input directory")
    manifest = {}

    def visit(directory):
        for item in sorted(directory.iterdir()):
            mode = item.lstat().st_mode
            if stat.S_ISDIR(mode):
                visit(item)
            elif stat.S_ISREG(mode) and item.stat().st_nlink == 1:
                manifest[str(item.relative_to(public))] = sha(item)
            else:
                raise PublicInputError(
                    "Public inputs contain a link or special file: " + str(item.relative_to(public))
                )

    visit(public)
    if not manifest:
        raise PublicInputError("Public inputs are empty")
    return manifest


def unpack_public_bundle(bundle, destination):
    """Accept public/ only; never extract links, private siblings, or archive metadata."""
    if bundle.is_symlink() or not bundle.is_file():
        raise PublicInputError("Solver bundle is not a regular file")
    with tarfile.open(bundle, "r:gz") as archive:
        members = []
        seen = set()
        for member in archive.getmembers():
            name = member.name
            if name.startswith("/") or "\\" in name or ".." in name.split("/"):
                raise PublicInputError("Unsafe solver bundle member path")
            parts = pathlib.PurePosixPath(name).parts
            if not parts and member.isdir():
                continue
            if not parts or parts[0] != "public":
                raise PublicInputError("Solver bundle contains a non-public member")
            if not (member.isdir() or member.isfile()) or member.issparse():
                raise PublicInputError("Solver bundle contains a link or special file")
            if len(parts) == 1 and not member.isdir():
                raise PublicInputError("Public archive root is not a directory")
            normalized = "/".join(parts)
            if normalized in seen:
                raise PublicInputError("Duplicate solver bundle member")
            seen.add(normalized)
            members.append((member, parts))
        # Validate all headers before materializing any content. Paths cannot escape
        # the fresh staging tree, and no tar ownership/mode/link metadata is applied.
        for member, parts in members:
            target = destination.joinpath(*parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output)


def initialize_public_inputs(source_work, work, environment, owner=(0, 0)):
    """Materialize the published public tree before taking its immutable baseline.

    Arena's actual plan supplies WORKSPACE and WORKSPACE_BASE, not ARENA_BUNDLE.
    Its Case.bundle single-object basename is solver-bundle.tar.gz. Only these
    observed locations are considered; oracle and arbitrary archives are never read.
    """
    source_work = pathlib.Path(source_work)
    work = pathlib.Path(work)
    destination = work / "public"
    if destination.exists() or destination.is_symlink():
        raise PublicInputError("Local public destination already exists")
    source = source_work / "public"
    bundle = None
    if source.exists() or source.is_symlink():
        source_hashes = public_manifest(source)
        origin = "mounted-public"
        input_path = source
    else:
        locations = [source_work]
        if environment.get("ARENA_WORKSPACE_BASE"):
            locations.append(pathlib.Path(environment["ARENA_WORKSPACE_BASE"]))
        for location in locations:
            candidate = location / "solver-bundle.tar.gz"
            if candidate.exists() or candidate.is_symlink():
                bundle = candidate
                break
        if bundle is None:
            raise PublicInputError("Public inputs and platform solver-bundle.tar.gz are missing")
        origin = "platform-solver-bundle"
        input_path = bundle
    with tempfile.TemporaryDirectory(prefix="public-input-", dir=work.parent) as temporary:
        staging = pathlib.Path(temporary)
        if bundle is None:
            shutil.copytree(source, staging / "public")
        else:
            unpack_public_bundle(bundle, staging)
        public = staging / "public"
        baseline = public_manifest(public)
        if bundle is None and baseline != source_hashes:
            raise PublicInputError("Local public copy differs from mounted input")
        public.rename(destination)
        # Root owns public. A root-owned sticky workspace below prevents admin from
        # renaming/deleting the whole read-only tree through its parent directory.
        for item in [*destination.rglob("*"), destination]:
            os.chown(item, *owner)
            os.chmod(item, 0o555 if item.is_dir() else 0o444)
    return baseline, {
        "status": "READY",
        "source_kind": origin,
        "source_path": str(input_path),
        "file_count": len(baseline),
        "files_sha256": baseline,
        "manifest_sha256": hashlib.sha256(
            json.dumps(baseline, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest(),
        "bundle_sha256": sha(bundle) if bundle else None,
        "private_paths_materialized": False,
    }


def check_public_inputs(public, baseline):
    if not baseline:
        raise PublicInputError("No nonempty public baseline was established")
    after = public_manifest(public)
    if baseline != after:
        raise PublicInputError("Public inputs changed during agent execution")
    return after


def prepare(workspace, output):
    work = Path(workspace)
    # Graybox's published Env delivers a public-only solver bundle.
    bundle = work / "solver-bundle.tar.gz"
    if not bundle.is_file():
        return None
    if (work / "public").exists():
        baseline = public_manifest(work / "public")
        receipt = {"status": "READY", "source_kind": "existing-public", "file_count": len(baseline)}
    else:
        baseline, receipt = initialize_public_inputs(work, work, os.environ)
    (work / "output").mkdir(exist_ok=True)
    (output / "public-input-baseline.json").write_text(json.dumps(receipt, indent=2))
    return (work, baseline)
