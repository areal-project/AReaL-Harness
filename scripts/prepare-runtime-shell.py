#!/usr/bin/env python3
"""构建 macOS 私有 Bash；不修改系统 shell，也不扩大任务临时目录权限。"""

import argparse
import concurrent.futures
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile


HOST_CC = """import pathlib,subprocess,sys
args=sys.argv[1:]
result=subprocess.run(["/usr/bin/clang",*args])
if result.returncode == 0 and not any(a in args for a in ["-c","-E","-S"]):
    output=args[args.index("-o")+1] if "-o" in args else "a.out"
    path=pathlib.Path(output)
    if path.is_file() and path.read_bytes()[:4] in [b"\\xcf\\xfa\\xed\\xfe",b"\\xce\\xfa\\xed\\xfe",b"\\xca\\xfe\\xba\\xbe"]:
        subprocess.run(["/usr/bin/codesign","--force","--sign","-",str(path)],check=True)
        if path.name in ["mkbuiltins","mksyntax","mkversion","gen-helpfiles","psize"]:
            native=path.with_name(path.name+".native")
            path.replace(native)
            path.write_text("#!/usr/bin/python3\\nimport subprocess,sys\\nr=subprocess.run([__file__+'.native',*sys.argv[1:]])\\nsys.exit(r.returncode if r.returncode>=0 else 128-r.returncode)\\n")
            path.chmod(0o755)
sys.exit(result.returncode)
"""


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fetch(asset, cache):
    destination = cache / asset["name"]
    if destination.exists():
        if digest(destination) != asset["sha256"]:
            raise ValueError(f"cached source checksum mismatch: {destination}")
        return destination
    for url in asset["urls"]:
        temporary = destination.with_suffix(destination.suffix + ".download")
        result = subprocess.run(
            [
                "/usr/bin/curl",
                "--fail",
                "--location",
                "--silent",
                "--show-error",
                "--max-time",
                "30",
                url,
                "-o",
                str(temporary),
            ],
            check=False,
        )
        if result.returncode == 0:
            if digest(temporary) != asset["sha256"]:
                raise ValueError(f"downloaded source checksum mismatch: {url}")
            temporary.replace(destination)
            return destination
        temporary.unlink(missing_ok=True)
    raise RuntimeError(f"cannot fetch pinned source: {asset['name']}")


def prepare(root, output):
    lock_path = root / "runtime/host-tools/bash.lock.json"
    lock = json.loads(lock_path.read_text())
    identity = {
        "lockSha256": digest(lock_path),
        "builderSha256": digest(Path(__file__)),
        "machine": platform.machine(),
        "version": lock["version"],
        "minimumMacOSVersion": lock["minimumMacOSVersion"],
    }
    key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:20]
    cache = root / "target/runtime-shell"
    cache.mkdir(parents=True, exist_ok=True)
    # debug/release 与多个验收入口共享构建缓存，禁止同时覆盖同一组制品。
    with (cache / "build.lock").open("w") as gate:
        fcntl.flock(gate, fcntl.LOCK_EX)
        build = cache / key
        binary, sources = build / "bash", build / "corresponding-source.tar.gz"
        metadata = build / "build.json"
        if metadata.exists():
            previous = json.loads(metadata.read_text())
            if not all(previous.get(k) == v for k, v in identity.items()):
                raise ValueError("cached shell build identity mismatch")
            if (
                digest(binary) != previous["binarySha256"]
                or digest(sources) != previous["sourceSha256"]
            ):
                raise ValueError("cached shell artifact checksum mismatch")
        else:
            downloads = cache / "downloads"
            downloads.mkdir(exist_ok=True)
            assets = [lock["archive"], *lock["patches"]]
            # 对应源码包可离线重建；其中已经包含全部锁定归档和补丁。
            for asset in assets:
                local = root / asset["name"]
                if local.is_file() and digest(local) == asset["sha256"]:
                    shutil.copy2(local, downloads / asset["name"])
            print(f"Preparing pinned Bash {lock['version']}", flush=True)
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as workers:
                inputs = list(workers.map(lambda asset: fetch(asset, downloads), assets))
            build.mkdir(exist_ok=True)
            # 中间文件只存在于独立构建目录；不污染源码树或用户的系统 shell。
            with tempfile.TemporaryDirectory(prefix="areal-bash-build-") as temporary:
                work = Path(temporary)
                with tarfile.open(inputs[0]) as archive:
                    # 只接受数据文件及归档内安全链接；源归档不得写出构建目录。
                    archive.extractall(work, filter="data")
                source = work / lock["sourceDirectory"]
                for patch in inputs[1:]:
                    subprocess.run(
                        ["/usr/bin/patch", "--batch", "--forward", "-p0", "-i", str(patch)],
                        cwd=source,
                        check=True,
                    )
                flags = [
                    "--prefix=/areal-runtime-shell",
                    "--disable-nls",
                    "--disable-readline",
                    "--without-bash-malloc",
                ]
                environment = os.environ.copy()
                compiler = work / "host-cc.py"
                compiler.write_text(HOST_CC)
                # configure 按词展开 CC，需经 PATH 查找 launcher 后再解释路径引号。
                launcher = work / "areal-host-cc"
                launcher.write_text(
                    "#!/bin/sh\nexec "
                    + shlex.quote(sys.executable)
                    + " "
                    + shlex.quote(str(compiler))
                    + ' "$@"\n'
                )
                launcher.chmod(0o755)
                environment.update(
                    CC=launcher.name,
                    PATH=str(work) + os.pathsep + environment.get("PATH", ""),
                    CFLAGS="-O2",
                    LDFLAGS="",
                    # 与发行包支持的最低系统一致，不能隐式要求构建机器的较新 macOS。
                    MACOSX_DEPLOYMENT_TARGET=lock["minimumMacOSVersion"],
                )
                try:
                    subprocess.run(["./configure", *flags], cwd=source, env=environment, check=True)
                finally:
                    if (source / "config.log").exists():
                        shutil.copy2(source / "config.log", build / "configure.log")
                subprocess.run(
                    ["/usr/bin/make", "-j2", "bash"], cwd=source, env=environment, check=True
                )
                shutil.copy2(source / "bash", binary)
                subprocess.run(
                    ["/usr/bin/codesign", "--force", "--sign", "-", str(binary)], check=True
                )
                # 与原生 smoke 保持相同父进程边界，避免构建用 Python 触发 macOS 的执行拒绝。
                version = subprocess.check_output(
                    [
                        "/usr/bin/python3",
                        "-I",
                        "-S",
                        "-c",
                        "import subprocess,sys; sys.stdout.buffer.write(subprocess.check_output(sys.argv[1:]))",
                        str(binary),
                        "--version",
                    ],
                    text=True,
                ).splitlines()[0]
                if f"version {lock['version']}" not in version:
                    raise ValueError(f"unexpected built Bash version: {version}")
                # 独立 GPL 程序随包附带完整对应源码、补丁和构建方法，不静态链接进 Rust。
                with tarfile.open(sources, "w:gz") as archive:
                    for path in inputs:
                        archive.add(path, arcname=path.name)
                    archive.add(lock_path, arcname="runtime/host-tools/bash.lock.json")
                    archive.add(Path(__file__), arcname="scripts/prepare-runtime-shell.py")
                shutil.copy2(source / "COPYING", build / "COPYING")
                identity.update(
                    configure=flags,
                    binarySha256=digest(binary),
                    sourceSha256=digest(sources),
                    license="GPL-3.0-or-later",
                )
                metadata.write_text(json.dumps(identity, indent=2) + "\n")
        output.mkdir(parents=True, exist_ok=True)
        for name in ["bash", "sh"]:
            target = output / name
            if not target.exists() or digest(target) != digest(binary):
                shutil.copy2(binary, target)
        for name in ["COPYING", "corresponding-source.tar.gz", "build.json"]:
            shutil.copy2(build / name, output / name)
    print(f"Private Runtime shell: {output}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=["debug", "release"], default="debug")
    arguments = parser.parse_args()
    if platform.system() != "Darwin":
        return
    root = Path(__file__).resolve().parents[1]
    prepare(root, root / "target" / arguments.profile / "shells")


if __name__ == "__main__":
    main()
