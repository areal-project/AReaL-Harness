#!/usr/bin/python3
"""Run one replacement in the evaluator-owned C/CPython chroot."""

from __future__ import annotations

import hashlib
import json
import os
import posixpath
import re
import signal
import stat
import subprocess
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path


HERE = Path(__file__).resolve().parent
TRUSTED_LAUNCHER = Path("/trusted/candidate_launcher")
MEMORY_KIB = 128 * 1024


@dataclass(frozen=True)
class IsolatedResult:
    args: list[str]
    returncode: int
    stdout: bytes
    stderr: bytes
    files: dict[str, bytes]
    entries: dict[str, str]
    pid: int
    max_rss_kib: int


class SandboxError(RuntimeError):
    def __init__(self, reason: str, pid: int = 0, max_rss_kib: int = 0) -> None:
        super().__init__(reason)
        self.pid = pid
        self.max_rss_kib = max_rss_kib


def _read_nofollow_regular(
    path: Path,
    *,
    expected_sha256: str | None = None,
    description: str,
) -> bytes:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    except FileNotFoundError as error:
        raise RuntimeError(f"{description} missing: {path}") from error
    except OSError as error:
        raise RuntimeError(f"{description} is not a regular non-symlink file: {path}") from error
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise RuntimeError(f"{description} is not a regular non-symlink file: {path}")
        blocks = []
        while True:
            block = os.read(descriptor, 1024 * 1024)
            if not block:
                break
            blocks.append(block)
        content = b"".join(blocks)
    finally:
        os.close(descriptor)
    actual = hashlib.sha256(content).hexdigest()
    if expected_sha256 is not None and actual != expected_sha256:
        raise RuntimeError(f"{description} digest mismatch: {path}: {actual}")
    return content


def _load_manifest() -> tuple[dict[str, object], list[tuple[dict[str, str], bytes]], bytes]:
    manifest_bytes = _read_nofollow_regular(
        HERE / "runtime-manifest.json", description="evaluator runtime manifest",
    )
    manifest = json.loads(manifest_bytes.decode("utf-8"))
    if manifest.get("schema_version") != 2 or not isinstance(manifest.get("files"), list):
        raise RuntimeError("invalid evaluator runtime manifest")
    if not isinstance(manifest.get("launcher_sha256"), str):
        raise RuntimeError("invalid evaluator launcher digest")
    launcher_bytes = _read_nofollow_regular(
        TRUSTED_LAUNCHER,
        expected_sha256=manifest["launcher_sha256"],
        description="evaluator launcher",
    )
    payloads = []
    destinations = set()
    for entry in manifest["files"]:
        if (not isinstance(entry, dict) or not isinstance(entry.get("source"), str)
                or not isinstance(entry.get("destination"), str)
                or not isinstance(entry.get("sha256"), str)):
            raise RuntimeError("invalid evaluator runtime manifest entry")
        destination = entry["destination"]
        if (not destination.startswith("/") or posixpath.normpath(destination) != destination
                or destination == "/" or destination in destinations):
            raise RuntimeError(f"invalid evaluator runtime destination: {destination}")
        destinations.add(destination)
        source = Path(entry["source"])
        content = _read_nofollow_regular(
            source,
            expected_sha256=entry["sha256"],
            description="trusted runtime component",
        )
        payloads.append((entry, content))
    return manifest, payloads, launcher_bytes


def _write_all(descriptor: int, content: bytes) -> None:
    offset = 0
    while offset < len(content):
        written = os.write(descriptor, content[offset:])
        if written <= 0:
            raise RuntimeError("short write while staging evaluator runtime")
        offset += written


def _write_staged_regular(
    root: Path,
    destination_path: str,
    content: bytes,
    expected_sha256: str,
    mode: int,
) -> None:
    destination = root / destination_path.lstrip("/")
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(
        destination,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
        mode,
    )
    try:
        _write_all(descriptor, content)
        os.fchmod(descriptor, mode)
    finally:
        os.close(descriptor)
    _read_nofollow_regular(
        destination,
        expected_sha256=expected_sha256,
        description="staged evaluator runtime component",
    )


def _verify_trusted_executable(path: Path, expected_sha256: str) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        status = os.fstat(descriptor)
        if (not stat.S_ISREG(status.st_mode) or status.st_uid != 0 or status.st_gid != 0
                or stat.S_IMODE(status.st_mode) != 0o555):
            raise RuntimeError(f"invalid trusted executable identity: {path}")
        digest = hashlib.sha256()
        while block := os.read(descriptor, 1024 * 1024):
            digest.update(block)
    finally:
        os.close(descriptor)
    if digest.hexdigest() != expected_sha256:
        raise RuntimeError(f"trusted executable digest mismatch: {path}")


def _stage_runtime(
    root: Path,
    payloads: list[tuple[dict[str, str], bytes]],
    launcher_bytes: bytes,
    launcher_sha256: str,
) -> None:
    for entry, content in payloads:
        mode = 0o555 if entry["destination"] in {
            "/runtime/lib/ld-linux-x86-64.so.2",
            "/runtime/loader/ld-linux-x86-64.so.2",
        } else 0o444
        _write_staged_regular(root, entry["destination"], content, entry["sha256"], mode)
        if mode == 0o555:
            _verify_trusted_executable(root / entry["destination"].lstrip("/"), entry["sha256"])
    _write_staged_regular(
        root, "/trusted/candidate_launcher", launcher_bytes, launcher_sha256, 0o555,
    )
    _verify_trusted_executable(root / "trusted/candidate_launcher", launcher_sha256)


def _group_is_gone(process_group: int) -> None:
    try:
        os.killpg(process_group, 0)
    except ProcessLookupError:
        return
    raise RuntimeError(f"candidate process group {process_group} survived cleanup")


def _rss_kib(pid: int) -> int:
    try:
        status = Path(f"/proc/{pid}/status").read_text(encoding="ascii")
    except (FileNotFoundError, ProcessLookupError):
        return 0
    match = re.search(r"^VmRSS:\s+(\d+)\s+kB$", status, re.MULTILINE)
    return int(match.group(1)) if match else 0


def _snapshot(root: Path, raw_paths: tuple[str, ...]) -> tuple[dict[str, bytes], dict[str, str]]:
    files: dict[str, bytes] = {}
    entries: dict[str, str] = {}

    def visit(path: Path) -> None:
        try:
            status = os.lstat(path)
        except FileNotFoundError:
            return
        raw = "/" + str(path.relative_to(root))
        mode = status.st_mode
        if stat.S_ISREG(mode):
            entries[raw] = "regular"
            files[raw] = path.read_bytes()
        elif stat.S_ISDIR(mode):
            entries[raw] = "directory"
            with os.scandir(path) as iterator:
                children = sorted((Path(item.path) for item in iterator), key=lambda item: item.name)
            for child in children:
                visit(child)
        elif stat.S_ISLNK(mode):
            entries[raw] = "symlink:" + os.readlink(path)
        elif stat.S_ISFIFO(mode):
            entries[raw] = "fifo"
        elif stat.S_ISSOCK(mode):
            entries[raw] = "socket"
        elif stat.S_ISCHR(mode):
            entries[raw] = "character-device"
        elif stat.S_ISBLK(mode):
            entries[raw] = "block-device"
        else:
            entries[raw] = "unknown"

    for raw_path in raw_paths:
        visit(root / raw_path.lstrip("/"))
    return files, entries


def run_isolated(
    candidate: Path,
    arguments: list[str],
    timeout: float = 5.0,
    *,
    input_files: dict[str, bytes] | None = None,
    collect_paths: tuple[str, ...] = (),
    candidate_path: str = "/app/candidate.py",
) -> IsolatedResult:
    candidate_bytes = _read_nofollow_regular(candidate, description="candidate source")
    manifest, runtime_payloads, launcher_bytes = _load_manifest()
    with tempfile.TemporaryDirectory(prefix="tbpc-002013-chroot-") as temporary:
        root = Path(temporary)
        root.chmod(0o755)
        _stage_runtime(root, runtime_payloads, launcher_bytes, manifest["launcher_sha256"])
        _write_staged_regular(
            root, candidate_path, candidate_bytes, hashlib.sha256(candidate_bytes).hexdigest(), 0o444,
        )

        work = root / "work"
        work.mkdir()
        work.chmod(0o777)
        for raw_path, content in (input_files or {}).items():
            if not raw_path.startswith("/work/"):
                raise ValueError(f"staged input must be below /work: {raw_path}")
            staged_input = root / raw_path.lstrip("/")
            staged_input.parent.mkdir(parents=True, exist_ok=True)
            staged_input.write_bytes(content)
            staged_input.chmod(0o444)
        for directory in sorted(
            {path.parent for path in work.rglob("*") if path.parent != work},
            key=lambda path: len(path.parts), reverse=True,
        ):
            directory.chmod(0o555)

        def enter_sandbox() -> None:
            os.chroot(root)
            os.chdir("/")

        sentinel_fds = (
            os.open(root, os.O_RDONLY),
            os.open(root, os.O_RDONLY),
            os.open(root, os.O_RDONLY),
        )
        try:
            process = subprocess.Popen(
                ["/trusted/candidate_launcher", candidate_path, *arguments],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True,
                preexec_fn=enter_sandbox,
                pass_fds=sentinel_fds,
                env={"LC_ALL": "C.UTF-8", "PATH": "/nonexistent"},
            )
        finally:
            for descriptor in sentinel_fds:
                os.close(descriptor)

        monitor_stop = threading.Event()
        over_rss = threading.Event()
        maximum_rss = [0]

        def monitor() -> None:
            while not monitor_stop.wait(0.005):
                current = _rss_kib(process.pid)
                maximum_rss[0] = max(maximum_rss[0], current)
                if current > MEMORY_KIB:
                    over_rss.set()
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    return

        monitor_thread = threading.Thread(target=monitor, daemon=True)
        monitor_thread.start()
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
            monitor_stop.set()
            monitor_thread.join()
            _group_is_gone(process.pid)
            raise SandboxError("candidate timed out", process.pid, maximum_rss[0])
        finally:
            monitor_stop.set()
            monitor_thread.join()
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        _group_is_gone(process.pid)
        if over_rss.is_set():
            raise SandboxError("candidate exceeded 128 MiB RSS", process.pid, maximum_rss[0])
        files, entries = _snapshot(root, collect_paths)
        return IsolatedResult(
            list(process.args), process.returncode, stdout, stderr, files, entries,
            process.pid, maximum_rss[0],
        )
