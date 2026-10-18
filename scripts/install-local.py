#!/usr/bin/env python3
"""安装本地 release 构建，保持 CLI 与内部 Runtime 的目录关系。"""

import argparse
import os
from pathlib import Path
import platform
import shutil
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def install(prefix, destdir):
    if not prefix.is_absolute():
        raise ValueError("PREFIX must be absolute")
    destination = Path(destdir) / prefix.relative_to("/") if destdir else prefix
    source = ROOT / "target/release"
    files = {
        "bin/areal": source / "areal",
        "libexec/areal/areal-runtime": source / "areal-runtime",
        "libexec/areal/areal-runtime-fs": source / "areal-runtime-fs",
        "share/licenses/areal/LICENSE": ROOT / "LICENSE",
    }
    if platform.system() == "Linux":
        files["libexec/areal/areal-runtime-reaper"] = source / "areal-runtime-reaper"
    for source_file in files.values():
        if not source_file.is_file():
            raise ValueError(f"missing {source_file}; run make release")
    # 逐文件原子替换，避免覆写正在运行的可执行文件，也不跟随旧入口链接。
    for relative, source_file in files.items():
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as temporary:
            staged = Path(temporary.name)
        try:
            shutil.copyfile(source_file, staged)
            staged.chmod(0o644 if relative.endswith("LICENSE") else 0o755)
            os.replace(staged, target)
        finally:
            staged.unlink(missing_ok=True)
    print(f"Installed {destination / 'bin/areal'} and Runtime components")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefix", type=Path, default=Path("/usr/local"))
    parser.add_argument("--destdir", default="")
    args = parser.parse_args()
    install(args.prefix, args.destdir)


if __name__ == "__main__":
    main()
