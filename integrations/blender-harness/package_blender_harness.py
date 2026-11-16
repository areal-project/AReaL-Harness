#!/usr/bin/env python3
"""从本目录源码与 Linux release native-core.tar.gz 组装确定性 areal-cc-blender-base-fix-thinking harness.pyz。"""

import argparse
import hashlib
import json
import zipfile
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native-core", type=Path, required=True, help="scripts/package.py 产出的 native-core.tar.gz")
    parser.add_argument("--image-ingress-helper", type=Path, required=True, help="Linux x86_64 image-ingress-helper 二进制")
    parser.add_argument("--output", type=Path, required=True, help="输出的 harness.pyz 路径")
    args = parser.parse_args()

    base = Path(__file__).resolve().parent
    payload_dir = base / "payload"
    modes = json.loads((base / "zip-modes.json").read_text())
    entries = {
        str(p.relative_to(payload_dir)): p.read_bytes()
        for p in sorted(payload_dir.rglob("*"))
        if p.is_file()
    }
    entries["native-core.tar.gz"] = args.native_core.read_bytes()
    entries["sdk-overlays/image-ingress-helper"] = args.image_ingress_helper.read_bytes()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("wb") as out:
        out.write(b"#!/usr/bin/env python3\n")
        with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for name in sorted(entries):
                info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = modes.get(name, 0o100644 << 16)
                zf.writestr(info, entries[name])
    args.output.chmod(0o755)
    digest = hashlib.sha256(args.output.read_bytes()).hexdigest()
    print(json.dumps({"output": str(args.output), "sha256": digest, "files": len(entries)}, indent=2))


if __name__ == "__main__":
    main()
