#!/usr/bin/env python3
"""安装已校验的完整 bundle；升级不覆盖旧版本及用户状态。"""

import argparse
import fcntl
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path, PurePosixPath

RELEASES = "https://github.com/areal-project/AReaL-Harness/releases/download"
LATEST = "https://api.github.com/repos/areal-project/AReaL-Harness/releases/latest"
TARGETS = {
    ("Darwin", "arm64"): ("darwin/arm64", "aarch64-apple-darwin", "macos-arm64"),
    ("Linux", "x86_64"): ("linux/x86_64", "x86_64-unknown-linux-gnu", "linux-x86_64"),
}


def checksum(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_archive(archive, checksums, filename):
    matches = []
    for line in checksums.read_text().splitlines():
        match = re.fullmatch(r"([a-f0-9]{64})  ([^/\\]+)", line)
        if match and match[2] == filename:
            matches.append(match[1])
    if len(matches) != 1 or checksum(archive) != matches[0]:
        raise ValueError("archive checksum missing, ambiguous or incorrect")


def extract_bundle(archive, destination):
    # 拒绝链接、设备、路径逃逸和重复成员；验证完成前不执行包内程序。
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        names = set()
        total = 0
        for member in members:
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or "\\" in member.name:
                raise ValueError("unsafe archive path")
            if not path.parts or path.parts[0] != "areal":
                raise ValueError("archive must contain one areal directory")
            if member.name in names or not (member.isfile() or member.isdir()):
                raise ValueError("duplicate or unsupported archive entry")
            names.add(member.name)
            total += member.size
            if total > 2 * 1024**3:
                raise ValueError("archive exceeds extraction limit")
        for member in members:
            target = destination.joinpath(*PurePosixPath(member.name).parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.extractfile(member) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
    return destination / "areal"


def verify_bundle(bundle, version, target_platform):
    manifest = json.loads((bundle / "manifest.json").read_text())
    if (
        manifest.get("manifestVersion") not in (1, 2)
        or manifest.get("productVersion") != "areal " + version
        or manifest.get("platform") != target_platform
    ):
        raise ValueError("manifest version or platform mismatch")
    if manifest.get("manifestVersion") == 2:
        identity = manifest.get("coreBuild")
        if (
            not isinstance(identity, dict)
            or not re.fullmatch(r"[a-f0-9]{64}", str(identity.get("inputHash", "")))
            or any(
                identity.get(key) != manifest.get(key)
                for key in ("sourceRevision", "apiVersion", "stateVersion")
            )
            or identity.get("workingTree") not in ("true", "false")
            or (identity["workingTree"] == "true") != manifest.get("workingTree")
        ):
            raise ValueError("Core build identity does not match manifest")
    expected = manifest.get("files", {})
    required = {
        "bin/areal",
        "libexec/areal/areal-runtime",
        "libexec/areal/areal-runtime-fs",
        "LICENSE",
    }
    if target_platform == "linux/x86_64":
        required.add("libexec/areal/areal-runtime-reaper")
    actual = {str(p.relative_to(bundle)) for p in bundle.rglob("*") if p.is_file()} - {
        "manifest.json"
    }
    if not required.issubset(expected) or set(expected) != actual:
        raise ValueError("bundle file inventory mismatch")
    for name, digest in expected.items():
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts or checksum(bundle / name) != digest:
            raise ValueError("bundle file checksum mismatch: " + name)
    return manifest


def check_program(binary, version):
    result = subprocess.run(
        [str(binary), "--version"], capture_output=True, text=True, timeout=30, check=True
    )
    if result.stdout.strip() != "areal " + version:
        raise ValueError("installed program version does not match release")


def managed_link(link, versions):
    if not (link.exists() or link.is_symlink()):
        return None
    resolved = link.resolve()
    if (
        not link.is_symlink()
        or resolved.parent.name != "bin"
        or resolved.parent.parent.parent != versions
    ):
        raise ValueError(
            "refusing to replace an unmanaged bin/areal; Homebrew owns its installations"
        )
    return resolved


def install(args, version, target):
    target_platform, archive_target, install_target = target
    prefix = args.prefix.expanduser().resolve()
    versions = prefix / "lib/areal"
    final = versions / (version + "-" + install_target)
    link = prefix / "bin/areal"
    versions.mkdir(parents=True, exist_ok=True)
    # flock 在异常/进程退出后由内核释放；锁文件保留，避免 unlink 导致双锁。
    with (versions / ".install.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError("another installation is in progress for this prefix") from error
        previous = managed_link(link, versions)
        if final.exists() or final.is_symlink():
            raise ValueError(
                "version directory already exists; retain it for rollback or choose a new version"
            )
        filename = "areal-harness-v" + version + "-" + archive_target + ".tar.gz"
        with tempfile.TemporaryDirectory(prefix=".install-", dir=versions) as temporary:
            staging = Path(temporary)
            archive, checksums = args.archive, args.checksums
            if archive is None:
                archive, checksums = staging / filename, staging / "SHA256SUMS"
                base = RELEASES + "/v" + version + "/"
                download(base + filename, archive)
                download(base + "SHA256SUMS", checksums)
            verify_archive(archive, checksums, filename)
            bundle = extract_bundle(archive, staging / "unpack")
            verify_bundle(bundle, version, target_platform)
            check_program(bundle / "bin/areal", version)
            if managed_link(link, versions) != previous:
                raise ValueError("installation entry changed while preparing the update")
            link.parent.mkdir(parents=True, exist_ok=True)
            temporary_link = staging / "areal-link"
            temporary_link.symlink_to(final / "bin/areal")
            bundle.rename(final)
            try:
                os.replace(temporary_link, link)
            except BaseException:
                # 系统调用成功后仍可能收到中断；入口已指向候选时不能删除活动版本。
                if not link.is_symlink() or link.resolve() != final / "bin/areal":
                    shutil.rmtree(final)
                raise
    print("Installed " + str(link))
    selected = shutil.which("areal")
    if selected and Path(selected).resolve() != link.resolve():
        print("PATH selects another installation: " + selected)
    print("Add " + str(link.parent) + " to PATH; verify with: " + str(link) + " --version")
    print(
        "User configuration/state remains unchanged. Retain a backup before opening it with a new version."
    )
    if platform.system() == "Linux":
        print("Restricted scopes require /usr/bin/bwrap and usable user namespaces.")


def download(url, path):
    request = urllib.request.Request(url, headers={"User-Agent": "areal-installer"})
    with urllib.request.urlopen(request, timeout=60) as source, path.open("wb") as output:
        shutil.copyfileobj(source, output)


def latest_version():
    request = urllib.request.Request(
        LATEST, headers={"Accept": "application/vnd.github+json", "User-Agent": "areal-installer"}
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        tag = json.load(response)["tag_name"]
    if not re.fullmatch(r"v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", tag):
        raise ValueError("latest release has an invalid tag")
    return tag[1:]


def latest_beta_version():
    """最新 Beta 与最新正式版中较高者；只认 vX.Y.Z 与 vX.Y.Z-beta.N。"""
    request = urllib.request.Request(
        LATEST.removesuffix("/latest") + "?per_page=50",
        headers={"Accept": "application/vnd.github+json", "User-Agent": "areal-installer"},
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        releases = json.load(response)
    versions = []
    for release in releases:
        match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)(?:-beta\.([1-9]\d*))?", release["tag_name"])
        if match and not release.get("draft"):
            major, minor, patch, beta = match.groups()
            order = (int(major), int(minor), int(patch), beta is None, int(beta or 0))
            versions.append((order, release["tag_name"][1:]))
    if not versions:
        raise ValueError("no published release")
    return max(versions)[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    if sys.version_info < (3, 9):
        parser.error("Python 3.9+ required for the installer")
    parser.add_argument("--version", required=True, help="release version, latest, or latest-beta")
    parser.add_argument("--prefix", type=Path, default=Path.home() / ".local")
    parser.add_argument("--archive", type=Path, help="offline release archive")
    parser.add_argument("--checksums", type=Path, help="matching release SHA256SUMS")
    parser.add_argument("--check", action="store_true", help="print the latest published version")
    args = parser.parse_args()
    if args.check and args.version not in ("latest", "latest-beta"):
        parser.error("--check requires --version latest or latest-beta")
    if args.version in ("latest", "latest-beta") and args.archive:
        parser.error("offline installation requires an exact version")
    if args.version == "latest":
        version = latest_version()
    elif args.version == "latest-beta":
        version = latest_beta_version()
    else:
        version = args.version.removeprefix("v")
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", version):
        parser.error("invalid version")
    if args.check:
        print(version)
        return
    target = TARGETS.get((platform.system(), platform.machine()))
    if target is None:
        parser.error("supported platforms: macOS arm64 and Linux x86_64 glibc")
    if platform.system() == "Linux":
        libc, libc_version = platform.libc_ver()
        if libc != "glibc" or tuple(map(int, libc_version.split(".")[:2])) < (2, 35):
            parser.error("glibc >=2.35 required (Ubuntu 22.04 or newer); musl is not supported")
    elif tuple(map(int, platform.mac_ver()[0].split(".")[:1])) < (15,):
        parser.error("macOS 15 or newer required")
    if bool(args.archive) != bool(args.checksums):
        parser.error("--archive and --checksums must be provided together")
    install(args, version, target)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, tarfile.TarError, subprocess.SubprocessError) as error:
        print("Installation failed: " + str(error), file=sys.stderr)
        sys.exit(1)
