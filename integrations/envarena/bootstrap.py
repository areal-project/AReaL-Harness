"""校验并展开不可变 Arena 包；模型循环仍由原生 Core 执行。"""

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import signal
import subprocess
import sys
import tempfile
import zipfile


def main():
    with zipfile.ZipFile(sys.argv[0]) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        target = {"x86_64": "x86_64-unknown-linux-musl", "aarch64": "aarch64-unknown-linux-musl"}
        if platform.system() != "Linux" or target.get(platform.machine()) != manifest["target"]:
            raise RuntimeError("Arena package architecture does not match this Linux environment")
        expected = set(manifest["files"]) | {"manifest.json"}
        if set(archive.namelist()) != expected or len(archive.namelist()) != len(expected):
            raise RuntimeError("Arena package contains missing, extra or duplicate entries")
        with tempfile.TemporaryDirectory(prefix="areal-arena-") as temporary:
            root = Path(temporary)
            for name, item in manifest["files"].items():
                path = PurePosixPath(name)
                if path.is_absolute() or ".." in path.parts or "\\" in name:
                    raise RuntimeError("Unsafe Arena package path")
                destination = root.joinpath(*path.parts)
                destination.parent.mkdir(parents=True, exist_ok=True)
                digest = hashlib.sha256()
                size = 0
                with archive.open(name) as source, destination.open("xb") as output:
                    while chunk := source.read(1024 * 1024):
                        size += len(chunk)
                        if size > item["bytes"]:
                            raise RuntimeError("Arena package file exceeds declared size")
                        digest.update(chunk)
                        output.write(chunk)
                if size != item["bytes"] or digest.hexdigest() != item["sha256"]:
                    raise RuntimeError("Arena package integrity mismatch: " + name)
                destination.chmod(0o755 if item["executable"] else 0o644)
            child = subprocess.Popen([sys.executable, str(root / "runner")], env=os.environ.copy())

            def forward(number, _frame):
                if child.poll() is None:
                    child.send_signal(number)

            signal.signal(signal.SIGTERM, forward)
            signal.signal(signal.SIGINT, forward)
            return child.wait()


if __name__ == "__main__":
    raise SystemExit(main())
