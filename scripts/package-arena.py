#!/usr/bin/env python3
"""从同一干净提交、Linux release 二进制及冻结配置生成可校验的 Arena zipapp。"""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import zipfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bin-dir", type=Path, required=True)
    parser.add_argument("--utilities", type=Path, required=True)
    parser.add_argument("--settings", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--target",
        choices=("x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"),
        required=True,
    )
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    if subprocess.check_output(["git", "status", "--porcelain"], cwd=root):
        parser.error("commit the verified source before packaging")
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    if args.output.exists():
        parser.error("output already exists; never overwrite a frozen package")
    sources = {
        "LICENSE": root / "LICENSE",
        "launch.py": root / "scripts/launch.py",
        "system-prompt.md": root / "core/engine/src/instructions.md",
        "settings.json": args.settings,
    }
    adapter = root / "integrations/envarena"
    mapping = json.loads((adapter / "provenance.json").read_text())["package_paths"]
    sources.update({target: adapter / source for source, target in mapping.items()})
    sources["__main__.py"] = adapter / "bootstrap.py"
    for name in ("areal", "areal-runtime", "areal-runtime-fs", "areal-runtime-reaper"):
        sources["bin/" + name] = args.bin_dir / name
    sources["bin/bwrap"] = args.utilities / "bin/bwrap"
    sources["bin/tools/rg"] = args.utilities / "bin/tools/rg"
    sources.update({"lib/" + p.name: p for p in (args.utilities / "lib").iterdir()})
    sources.update(
        {
            str(p.relative_to(args.utilities)): p
            for p in (args.utilities / "licenses").rglob("*")
            if p.is_file()
        }
    )
    settings = json.loads(args.settings.read_text())
    if not isinstance(settings, dict):
        parser.error("settings must be an object")
    if settings.get("task_profile", "generic") not in ("generic", "original") or settings.get(
        "delivery_checks", False
    ):
        parser.error(
            "this package supports generic/original profiles without external delivery modules"
        )
    machine = 62 if args.target.startswith("x86_64") else 183
    for name, source in sources.items():
        if not source.is_file():
            parser.error("missing regular input: " + str(source))
        if name.startswith("bin/"):
            with source.open("rb") as stream:
                header = stream.read(20)
            if (
                header[:6] != b"\x7fELF\x02\x01"
                or int.from_bytes(header[18:20], "little") != machine
            ):
                parser.error("wrong ELF architecture: " + name)
    payload = args.output / "payload"
    payload.mkdir(parents=True)
    files = {}
    for name, source in sorted(sources.items()):
        destination = payload / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        executable = name.startswith("bin/") or (
            name.startswith("lib/") and bool(source.stat().st_mode & 0o111)
        )
        destination.chmod(0o755 if executable else 0o644)
        with destination.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        files[name] = {
            "sha256": digest,
            "bytes": destination.stat().st_size,
            "executable": executable,
        }
    manifest = {
        "schema": "areal.arena-package.v1",
        "sourceRevision": revision,
        "target": args.target,
        "profile": "release",
        "files": files,
    }
    (payload / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    )
    archive = args.output / "areal-arena.pyz"
    # 固定 ZIP 元信息；同一组冻结文件生成相同归档字节。
    with archive.open("wb") as output:
        output.write(b"#!/usr/bin/env python3\n")
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
            for path in sorted(p for p in payload.rglob("*") if p.is_file()):
                info = zipfile.ZipInfo(str(path.relative_to(payload)), (1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                bundle.writestr(info, path.read_bytes())
    archive.chmod(0o755)
    with archive.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    (args.output / "SHA256SUMS").write_text(digest + "  " + archive.name + "\n")
    print(
        json.dumps(
            {"archive": str(archive.resolve()), "sourceRevision": revision, "sha256": digest}
        )
    )


if __name__ == "__main__":
    main()
