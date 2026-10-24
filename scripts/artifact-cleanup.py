#!/usr/bin/env python3
"""Preview or explicitly remove old AReaL validation artifacts and Rust intermediates."""

import argparse
import fcntl
import hashlib
import json
import math
import os
import plistlib
import re
import shutil
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from contextlib import contextmanager, nullcontext
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
APP = "AReaL Harness GUI.app"
CACHE_DIRS = {"deps", "incremental", "build", ".fingerprint"}
PRUNE = {".git", "node_modules", ".venv", "pnpm-store", "__pycache__"}


def command(argv):
    return subprocess.run(argv, capture_output=True, text=True, errors="replace", timeout=120)


def within(path, root):
    return path == root or root in path.parents


def safe(path, roots):
    # resolve 不相等时拒绝穿过任何符号链接；只处理显式扫描范围内的真实路径。
    return (
        path.exists()
        and path.resolve() == path
        and any(path != root and within(path, root) for root in roots)
    )


def fingerprint(read, exists):
    info = plistlib.loads(read("Info.plist"))
    core = json.loads(read("Resources/areal-core/manifest.json"))
    identity = core.get("coreBuild", {}).get("inputHash")
    if not identity:
        raise ValueError("Missing Core build identity")
    required = ["bin/areal", "libexec/areal/areal-runtime", "libexec/areal/areal-runtime-fs"]
    if not all(
        name in core.get("files", {}) and exists("Resources/areal-core/" + name)
        for name in required
    ):
        raise ValueError("Incomplete embedded Core bundle")
    if not exists("MacOS/" + info.get("CFBundleExecutable", "AReaL Harness GUI")):
        raise ValueError("Missing GUI executable")
    asar = hashlib.sha256(read("Resources/app.asar")).hexdigest()
    return (info.get("CFBundleShortVersionString", "?"), identity, asar)


def app_identity(path):
    return fingerprint(
        lambda name: (path / "Contents" / name).read_bytes(),
        lambda name: (path / "Contents" / name).is_file(),
    )


def zip_identity(path):
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        return fingerprint(
            lambda name: archive.read(f"{APP}/Contents/{name}"),
            lambda name: f"{APP}/Contents/{name}" in names,
        )


def activity(roots):
    observations = []
    try:
        ps = command(["ps", "-axo", "pid=,ppid=,comm=,args="])
        opened = command(["lsof", "-n", "-P", "-Fpcfn"])
        if ps.returncode or opened.returncode or not opened.stdout:
            raise RuntimeError("Process/open-file inspection unavailable")
        parents, processes = {}, {}
        for line in ps.stdout.splitlines():
            parts = line.strip().split(None, 3)
            if len(parts) == 4 and parts[0].isdigit() and parts[1].isdigit():
                pid = int(parts[0])
                parents[pid] = int(parts[1])
                processes[pid] = {"program": parts[2], "command": parts[3], "cwd": ""}
        ignored = {os.getpid()}
        parent = os.getppid()
        while parent and parent not in ignored:
            ignored.add(parent)
            parent = parents.get(parent, 0)
        pid, fd = 0, ""
        for line in opened.stdout.splitlines():
            if line.startswith("p") and line[1:].isdigit():
                pid = int(line[1:])
            elif line.startswith("c") and pid in processes:
                # macOS ps 的 comm 会截断长路径；lsof 的程序名保留 make/cargo 等名称。
                processes[pid]["program"] = line[1:]
            elif line.startswith("f"):
                fd = line[1:]
            elif line.startswith("n/") and pid not in ignored:
                value = line[1:]
                if fd == "cwd" and pid in processes:
                    processes[pid]["cwd"] = value
                elif any(within(Path(value), root) for root in roots):
                    observations.append({"pid": pid, "type": "open-file", "path": value})
        builders = {
            "cargo",
            "rustc",
            "rustdoc",
            "cc",
            "c++",
            "clang",
            "clang++",
            "ld",
            "cmake",
            "ninja",
            "make",
            "gmake",
            "gnumake",
            "dsymutil",
        }
        debuggers = {"lldb", "debugserver", "gdb"}
        for pid, process in processes.items():
            if pid in ignored:
                continue
            program = Path(process["program"]).name
            if program in builders | debuggers:
                for root in roots:
                    if str(root) in process["command"] or within(Path(process["cwd"]), root):
                        observations.append(
                            {
                                "pid": pid,
                                "type": "builder" if program in builders else "debugger",
                                **process,
                            }
                        )
        return observations, None
    except (OSError, subprocess.SubprocessError, RuntimeError) as error:
        return [], str(error)


def busy(path, observations, repo=None):
    found = set()
    for observation in observations:
        if observation["type"] == "open-file":
            if within(Path(observation["path"]), path):
                found.add(observation["pid"])
        elif repo and (
            str(repo) in observation["command"] or within(Path(observation["cwd"]), repo)
        ):
            found.add(observation["pid"])
    return sorted(found)


@contextmanager
def build_locks(profile, create=False):
    handles = []
    try:
        for name in [".cargo-lock", ".cargo-build-lock", ".cargo-artifact-lock"]:
            path = profile / name
            if not path.exists() and not (create and name == ".cargo-lock"):
                continue
            if path.is_symlink():
                raise RuntimeError(f"Symlink build lock refused: {path}")
            fd = os.open(path, os.O_RDWR | (os.O_CREAT if create else 0), 0o644)
            handles.append(fd)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        for fd in reversed(handles):
            os.close(fd)


def discover(roots):
    evidence, apps, archives, repos, manifests = [], [], [], set(), []
    for root in roots:
        for base, dirs, files in os.walk(root, followlinks=False):
            path = Path(base)
            dirs[:] = [d for d in dirs if d not in PRUNE and not (path / d).is_symlink()]
            if (path / "Cargo.toml").is_file() and (path / "core/engine/Cargo.toml").is_file():
                if 'name = "areal-engine"' in (path / "core/engine/Cargo.toml").read_text():
                    repos.add(path)
            if "manifest.json" in files and not (path / "manifest.json").is_symlink():
                manifests.append(path / "manifest.json")
            if "package-evidence.json" in files:
                evidence.append(path / "package-evidence.json")
            for name in dirs[:]:
                child = path / name
                if name.endswith(".app"):
                    if name == APP:
                        apps.append(child)
                    dirs.remove(name)
                elif name == "target":
                    # 构建缓存单独枚举；历史 delivery 目录仍需识别 GUI 轮次。
                    dirs.remove(name)
                    for delivery in sorted(child.glob("delivery-*")):
                        if delivery.is_dir() and not delivery.is_symlink():
                            e, a, z, _, m = discover([delivery])
                            evidence.extend(e)
                            apps.extend(a)
                            archives.extend(z)
                            manifests.extend(m)
            archives.extend(path / name for name in files if name.endswith((".zip", ".dmg")))
    return (
        sorted(set(evidence)),
        sorted(set(apps)),
        sorted(set(archives)),
        sorted(repos),
        sorted(set(manifests)),
    )


def gui_plan(evidence, apps, archives, keep, roots, warnings):
    rounds = []
    owners = {}
    identities = {}
    for record in evidence:
        folder = record.parent
        data = json.loads(record.read_text())
        payload = []
        identity = None
        for key in ("app", "archive", "dmg"):
            if not data.get(key):
                continue
            value = data[key]
            if isinstance(value, dict):
                value = value.get("path")
            if not isinstance(value, str):
                warnings.append(f"Unrecognized {key} entry retained: {record}")
                continue
            path = Path(value)
            if not path.is_absolute():
                path = folder / path
            if not safe(path, roots) or not within(path, folder):
                continue
            payload.append(path)
            try:
                if path.name == APP:
                    identity = app_identity(path)
                elif path.suffix == ".zip" and identity is None:
                    identity = zip_identity(path)
            except (
                OSError,
                ValueError,
                KeyError,
                zipfile.BadZipFile,
                plistlib.InvalidFileException,
            ):
                pass
        if identity is None:
            warnings.append(f"Unidentified/incomplete GUI build retained: {folder}")
            continue
        entry = {
            "path": str(folder),
            "time": record.stat().st_mtime,
            "version": identity[0],
            "identity": identity,
            "payload": payload,
        }
        rounds.append(entry)
        for path in payload:
            owners[path] = entry
    rounds.sort(key=lambda r: (r["time"], r["path"]), reverse=True)
    for index, entry in enumerate(rounds):
        entry["retained"] = index < keep
        identities.setdefault(entry["identity"], entry)
    # 复制不创建新轮次；重复构建的相同内容副本归入最近的一轮，保守保留。
    for app in apps:
        if app in owners:
            continue
        try:
            entry = identities.get(app_identity(app))
        except (OSError, ValueError, KeyError, plistlib.InvalidFileException):
            entry = None
        if entry:
            owners[app] = entry
        else:
            warnings.append(f"GUI app without an identifiable build retained: {app}")
    paired = {}
    for archive in archives:
        if archive in owners:
            paired.setdefault(archive.parent, []).append(owners[archive])
            continue
        if archive.suffix == ".zip":
            try:
                entry = identities.get(zip_identity(archive))
            except (
                OSError,
                ValueError,
                KeyError,
                zipfile.BadZipFile,
                plistlib.InvalidFileException,
            ):
                entry = None
            if entry:
                owners[archive] = entry
                paired.setdefault(archive.parent, []).append(entry)
    for archive in archives:
        if archive.suffix == ".dmg" and archive not in owners:
            matches = paired.get(archive.parent, [])
            if matches and len({r["path"] for r in matches}) == 1:
                owners[archive] = matches[0]
            elif archive.name.startswith(("AReaL", "app-submission")):
                warnings.append(f"Archive without an identifiable build retained: {archive}")
    # Core staging 由已识别的打包轮次拥有；JSON 验收记录留存。
    for entry in rounds:
        core = Path(entry["path"]) / "areal-core"
        if safe(core, roots) and (core / "manifest.json").is_file():
            owners[core] = entry
    items = []
    for path, entry in owners.items():
        if not entry["retained"]:
            items.append({"path": str(path), "kind": "old-gui", "scope": entry["path"]})
    public = [{k: v for k, v in r.items() if k not in ("identity", "payload")} for r in rounds]
    return public, items


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def rust_bundles(manifests, keep, roots, warnings):
    bundles = []
    required = {"bin/areal", "libexec/areal/areal-runtime", "libexec/areal/areal-runtime-fs"}
    for record in manifests:
        try:
            data = json.loads(record.read_text())
            if not isinstance(data, dict):
                continue
            files = data.get("files", {})
            if not isinstance(files, dict) or not all(
                isinstance(name, str) and isinstance(digest, str) for name, digest in files.items()
            ):
                continue
            if not required.issubset(files) or not data.get("coreBuild", {}).get("inputHash"):
                continue
            folder = record.parent
            if not safe(folder, roots) or not all(
                safe(folder / name, [folder]) and (folder / name).is_file() for name in files
            ):
                continue
            # 只认完整的包目录，避免把源码目录或安装配置当作整包清除。
            if any(
                p.name not in {"bin", "libexec", "LICENSE", "manifest.json", ".DS_Store"}
                for p in folder.iterdir()
            ):
                continue
            actual_files = {
                str(path.relative_to(folder)) for path in folder.rglob("*") if path.is_file()
            }
            if actual_files - set(files) - {"manifest.json", ".DS_Store"}:
                continue
            identity = (data["coreBuild"]["inputHash"], tuple(sorted(files.items())))
            bundles.append(
                {
                    "path": str(folder),
                    "time": record.stat().st_mtime,
                    "identity": identity,
                    "manifest": data,
                }
            )
        except (OSError, ValueError, TypeError):
            continue
    bundles.sort(key=lambda r: (r["time"], r["path"]), reverse=True)
    retained_ids = []
    for bundle in bundles:
        identity = bundle["identity"]
        if identity in retained_ids:
            bundle["verified"] = False
            bundle["retained"] = False
            continue
        if len(retained_ids) < keep:
            # 删除旧版本前，先校验保留包的所有清单文件。
            folder = Path(bundle["path"])
            if any(
                sha256_file(folder / name) != digest
                for name, digest in bundle["manifest"]["files"].items()
            ):
                warnings.append(
                    f"Bundle integrity mismatch; retained without counting as a backup: {folder}"
                )
                bundle["verified"] = False
                bundle["retained"] = True
                continue
            retained_ids.append(identity)
        bundle["verified"] = identity in retained_ids
        bundle["retained"] = identity in retained_ids
    items = [
        {"path": b["path"], "kind": "old-rust-bundle", "scope": b["path"]}
        for b in bundles
        if not b["retained"]
    ]
    public = [{k: v for k, v in b.items() if k != "identity"} for b in bundles]
    return public, items, len(retained_ids) >= keep


def rust_plan(repos, roots, may_remove_loose, bundles):
    profiles, items = [], []
    for repo in repos:
        target = repo / "target"
        if not safe(target, roots):
            continue
        for base, dirs, _ in os.walk(target, followlinks=False):
            profile = Path(base)
            dirs[:] = [
                d
                for d in dirs
                if d not in PRUNE
                and not (profile / d).is_symlink()
                and not d.startswith("delivery-")
            ]
            caches = [profile / name for name in sorted(CACHE_DIRS) if safe(profile / name, roots)]
            if not caches:
                continue
            dirs[:] = []
            profiles.append({"path": str(profile), "repo": str(repo)})
            for path in caches:
                items.append(
                    {
                        "path": str(path),
                        "kind": "rust-intermediate",
                        "scope": str(repo),
                        "profile": str(profile),
                    }
                )
            loose_names = {
                "areal": "bin/areal",
                "areal-runtime": "libexec/areal/areal-runtime",
                "areal-runtime-fs": "libexec/areal/areal-runtime-fs",
            }
            known = False
            if may_remove_loose and all((profile / name).is_file() for name in loose_names):
                hashes = {name: sha256_file(profile / name) for name in loose_names}
                known = any(
                    all(
                        hashes[name] == bundle["manifest"]["files"][relative]
                        for name, relative in loose_names.items()
                    )
                    for bundle in bundles
                )
            profiles[-1]["loose_outputs_identified"] = known
            if known:
                for path in profile.iterdir():
                    if (
                        safe(path, roots)
                        and not path.name.startswith(".")
                        and (
                            path.is_file()
                            and (
                                os.access(path, os.X_OK)
                                or path.suffix in {".o", ".rlib", ".rmeta", ".d"}
                            )
                            or path.name.endswith(".dSYM")
                        )
                    ):
                        items.append(
                            {
                                "path": str(path),
                                "kind": "loose-rust-output",
                                "scope": str(repo),
                                "profile": str(profile),
                            }
                        )
    return profiles, items


def item_busy(item, observations):
    path = Path(item["path"])
    if item.get("temporary_worktree"):
        # 定期回收保护整个 profile，直接启动的 Core/Runtime 也可能再加载伴随资源。
        return busy(Path(item["profile"]), observations, Path(item["scope"]))
    if item["kind"] == "rust-intermediate":
        return busy(path, observations, Path(item["scope"]))
    if item["kind"] == "loose-rust-output":
        # 同一 profile 的 Core 可在以后再启动助手，因此一起保护伴随二进制。
        profile = Path(item["profile"])
        return busy(profile, observations, Path(item["scope"]))
    return busy(path, observations)


def registered_worktrees(warnings):
    result = command(["git", "-C", str(REPO), "worktree", "list", "--porcelain"])
    if result.returncode:
        raise RuntimeError("Cannot enumerate repository worktrees")
    paths = [Path(line[9:]) for line in result.stdout.splitlines() if line.startswith("worktree ")]
    if not paths:
        raise RuntimeError("No primary worktree found")
    existing = []
    for path in paths:
        if not path.is_dir():
            warnings.append(f"Missing registered worktree skipped: {path}")
        elif path.resolve() != path:
            warnings.append(f"Symlink worktree skipped: {path}")
        else:
            existing.append(path)
    return paths[0], existing


def cache_groups(items):
    groups = {}
    for item in items:
        groups.setdefault(item.get("profile", item["path"]), []).append(item)
    return groups


def remaining_cache_bytes(items):
    return sum(i["estimated_bytes"] for i in items if i["status"] != "deleted")


def measure_items(items, temporary, warnings):
    groups = cache_groups(items).values() if temporary else [items]
    for group in groups:
        if not group:
            continue
        sizes = command(["du", "-sk", *[i["path"] for i in group]])
        if sizes.returncode and not temporary:
            raise RuntimeError("Size scan failed: " + sizes.stderr.strip())
        by_path = {
            line.split("\t", 1)[1]: int(line.split("\t", 1)[0]) * 1024
            for line in sizes.stdout.splitlines()
        }
        known = sizes.returncode == 0
        if not known:
            warnings.append(f"Cache size unavailable; profile retained: {group[0]['profile']}")
        for item in group:
            item["estimated_bytes"] = by_path.get(item["path"], 0)
            item["size_known"] = known
            if not known and item["status"] == "eligible":
                item["status"] = "blocked-size-unknown"


def free_bytes(path):
    info = os.statvfs(path)
    return info.f_bavail * info.f_frsize


def plan_cache_budget(items, budget, min_free):
    remaining = remaining_cache_bytes(items)
    groups = cache_groups(items)
    # 目录修改时间表示最近写入，不把复用过的缓存宣称为精确 LRU。
    ordered = sorted(
        groups.items(),
        key=lambda pair: (max(i["last_modified_ns"] for i in pair[1]), pair[0]),
    )
    selected = []
    for profile, group in ordered:
        if any(i["status"] != "eligible" for i in group):
            for item in group:
                if item["status"] == "eligible":
                    item["status"] = "blocked-profile"
            continue
        if remaining > budget or free_bytes(profile) < min_free:
            selected.extend(group)
            remaining -= sum(i["estimated_bytes"] for i in group)
        else:
            for item in group:
                item["status"] = "retained-budget"
    return selected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        action="append",
        type=Path,
        help="Scan root (repeatable; default: ~/Documents/Codex)",
    )
    parser.add_argument(
        "--keep",
        type=int,
        default=5,
        help="Complete GUI/Core bundle versions to retain per category",
    )
    parser.add_argument("--no-worktrees", action="store_true", help="Only scan explicit roots")
    parser.add_argument(
        "--temporary-worktrees",
        action="store_true",
        help="Only budget Rust intermediate caches in registered secondary worktrees",
    )
    parser.add_argument("--cache-budget-gib", type=float, default=40, help="Secondary cache budget")
    parser.add_argument(
        "--min-free-gib", type=float, default=30, help="Free-space collection threshold"
    )
    parser.add_argument("--json", action="store_true", help="Print the complete JSON preview")
    parser.add_argument(
        "--report", type=Path, help="Save the complete JSON preview outside artifact roots"
    )
    parser.add_argument(
        "--apply", action="store_true", help="Delete eligible paths; default is preview only"
    )
    args = parser.parse_args()
    if args.keep < 1:
        parser.error("--keep must be at least 1")
    if any(not math.isfinite(v) or v < 0 for v in [args.cache_budget_gib, args.min_free_gib]):
        parser.error("Cache budget and free-space threshold must be finite and nonnegative")
    if args.apply and not args.report:
        parser.error("--apply requires --report for a durable deletion receipt")
    if args.temporary_worktrees and (args.root or args.no_worktrees):
        parser.error(
            "--temporary-worktrees selects registered worktrees; do not pass root overrides"
        )
    warnings = []
    roots = [p.expanduser().resolve() for p in (args.root or [Path.home() / "Documents/Codex"])]
    if not args.no_worktrees:
        primary, worktrees = registered_worktrees(warnings)
        if args.temporary_worktrees:
            roots = [p for p in worktrees if p != primary]
        else:
            roots.extend(worktrees)
    temporary_repos = list(roots)
    roots = sorted(set(roots), key=lambda p: (len(p.parts), str(p)))
    roots = [p for i, p in enumerate(roots) if not any(within(p, r) for r in roots[:i])]
    if any(not p.is_dir() or p == Path("/") or p == Path.home() for p in roots):
        parser.error("Every scan root must be an existing dedicated directory")
    if args.report:
        args.report = args.report.expanduser().resolve()
        if any(within(args.report, r) for r in roots):
            parser.error("--report must be outside scan roots")
    observations, activity_error = activity(roots)
    if activity_error:
        warnings.append(activity_error + "; all deletions blocked")
    if args.temporary_worktrees:
        print("Scanning registered secondary worktree caches...", file=sys.stderr)
        repos = [
            p
            for p in temporary_repos
            if (p / "Cargo.toml").is_file() and (p / "core/engine/Cargo.toml").is_file()
        ]
        gui, bundles, gui_items, bundle_items = [], [], [], []
        rust, rust_items = rust_plan(repos, roots, False, [])
        rust_items = [
            i
            for i in rust_items
            if (Path(i["profile"]) / ".cargo-lock").is_file()
            or (Path(i["profile"]) / ".fingerprint").is_dir()
        ]
        for item in rust_items:
            item["temporary_worktree"] = True
            item["last_modified_ns"] = max(
                Path(item["path"]).stat().st_mtime_ns,
                Path(item["profile"]).stat().st_mtime_ns,
            )
    else:
        print("Scanning GUI build records and Rust profiles...", file=sys.stderr)
        evidence, apps, archives, repos, manifests = discover(roots)
        gui, gui_items = gui_plan(evidence, apps, archives, args.keep, roots, warnings)
        bundles, bundle_items, may_remove_loose = rust_bundles(
            manifests, args.keep, roots, warnings
        )
        rust, rust_items = rust_plan(repos, roots, may_remove_loose, bundles)
        if not may_remove_loose:
            warnings.append(
                "Fewer than keep verified standalone Core bundles; loose profile outputs retained"
            )
    retained_bundles = [Path(bundle["path"]) for bundle in bundles if bundle["retained"]]
    raw = sorted(
        [
            item
            for item in gui_items + bundle_items + rust_items
            if not any(
                within(Path(item["path"]), kept) or within(kept, Path(item["path"]))
                for kept in retained_bundles
            )
        ],
        key=lambda i: (len(Path(i["path"]).parts), i["path"]),
    )
    mounts = command(["mount"])
    if mounts.returncode:
        raise RuntimeError("Cannot inspect mounted volumes")
    mount_paths = [Path(m.group(1)) for m in re.finditer(r" on (.*?) \(", mounts.stdout)]
    if not mount_paths:
        raise RuntimeError("Cannot parse mounted volumes")
    items = []
    for item in raw:
        path = Path(item["path"])
        if not safe(path, roots) or any(within(path, Path(i["path"])) for i in items):
            continue
        # 不删除挂载点；目录内存在挂载点时也拒绝整个目录。
        item["status"] = "eligible"
        pids = item_busy(item, observations)
        if activity_error:
            item["status"] = "blocked-activity-unknown"
        elif pids:
            item["status"] = "blocked-in-use"
            item["pids"] = pids
        if "profile" in item:
            try:
                with build_locks(Path(item["profile"])):
                    pass
            except (BlockingIOError, RuntimeError):
                item["status"] = "blocked-build-lock"
        if any(within(mount, path) for mount in mount_paths):
            item["status"] = "blocked-mounted"
        item["mtime_ns"] = path.stat().st_mtime_ns
        items.append(item)
    if items:
        print(f"Measuring {len(items)} cleanup paths (allocated blocks)...", file=sys.stderr)
        measure_items(items, args.temporary_worktrees, warnings)
    budget = int(args.cache_budget_gib * 1024**3)
    min_free = int(args.min_free_gib * 1024**3)
    selected = plan_cache_budget(items, budget, min_free) if args.temporary_worktrees else items
    report = {
        "mode": "apply" if args.apply else "preview",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "keep": args.keep,
        "roots": [str(p) for p in roots],
        "gui_rounds": gui,
        "rust_profiles": rust,
        "rust_bundles": bundles,
        "items": items,
        "warnings": warnings,
        "eligible_bytes": sum(i["estimated_bytes"] for i in items if i["status"] == "eligible"),
        "pending_bytes": 0,
    }
    if args.temporary_worktrees:
        report["cache_policy"] = {
            "budget_bytes": budget,
            "min_free_bytes": min_free,
            "before_bytes": remaining_cache_bytes(items),
            "unmeasured_profiles": sorted({i["profile"] for i in items if not i["size_known"]}),
        }
    if args.apply:
        if not args.report:
            parser.error("--apply requires --report for a durable deletion receipt")
        args.report.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
        groups = cache_groups([i for i in selected if i["status"] == "eligible"])
        for key, group in groups.items():
            try:
                profile = Path(key) if "profile" in group[0] else None
                with build_locks(profile, create=True) if profile else nullcontext():
                    if (
                        args.temporary_worktrees
                        and remaining_cache_bytes(items) <= budget
                        and free_bytes(profile) >= min_free
                    ):
                        for item in group:
                            item["status"] = "retained-budget"
                        continue
                    fresh, error = activity(roots)
                    if error:
                        raise RuntimeError("Deletion refused: " + error)
                    for item in group:
                        path = Path(item["path"])
                        if (
                            not safe(path, roots)
                            or path.stat().st_mtime_ns != item["mtime_ns"]
                            or item_busy(item, fresh)
                        ):
                            item["status"] = "skipped-changed-or-active"
                            continue
                        item["status"] = "deleting"
                        args.report.write_text(
                            json.dumps(report, indent=2, ensure_ascii=False) + "\n"
                        )
                        if path.is_dir():
                            shutil.rmtree(path)
                        else:
                            path.unlink()
                        item["status"] = "deleted"
                        print(f"Deleted: {path}", file=sys.stderr)
                        args.report.write_text(
                            json.dumps(report, indent=2, ensure_ascii=False) + "\n"
                        )
            except BlockingIOError:
                for item in group:
                    item["status"] = "skipped-build-lock"
        report["deleted_estimated_bytes"] = sum(
            i["estimated_bytes"] for i in items if i["status"] == "deleted"
        )
    if args.temporary_worktrees:
        remaining = remaining_cache_bytes(items)
        report["cache_policy"]["remaining_estimated_bytes"] = remaining
        report["cache_policy"]["budget_excess_bytes"] = max(0, remaining - budget)
        available = [free_bytes(root) for root in roots if root.is_dir()]
        report["cache_policy"]["min_observed_free_bytes"] = min(available, default=free_bytes(REPO))
        if args.apply and remaining > budget:
            warnings.append("Secondary cache budget remains exceeded; active or locked caches kept")
        if args.apply and available and min(available) < min_free:
            warnings.append(
                "Disk remains below free-space threshold; protected or unrelated data kept"
            )
    if args.report:
        args.report.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        if args.temporary_worktrees:
            print(f"{report['mode'].upper()}: secondary cache budget {args.cache_budget_gib:g} GiB")
        else:
            print(
                f"{report['mode'].upper()}: keep {args.keep} complete GUI/Core bundle versions; caches are independent"
            )
        for label, rounds in [("GUI", gui), ("Core bundle", bundles)]:
            for entry in rounds:
                print(f"{'KEEP' if entry['retained'] else 'OLD '} {label}: {entry['path']}")
        for item in items:
            print(f"{item['status']:30} {item['estimated_bytes'] / 1e9:9.3f} GB  {item['path']}")
        print(f"Eligible estimate: {report['eligible_bytes'] / 1e9:.3f} GB")
        if args.apply:
            print(f"Deleted estimate: {report['deleted_estimated_bytes'] / 1e9:.3f} GB")
        print(
            "Estimates use allocated blocks; APFS clones/snapshots can reduce actual space recovered."
        )
        for warning in warnings:
            print("WARNING: " + warning)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"artifact-cleanup: {error}", file=sys.stderr)
        sys.exit(1)
