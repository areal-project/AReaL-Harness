"""核对原题数值运行库，环境漂移时在构建阶段失败。"""
import hashlib
from pathlib import Path

files = [Path("/usr/bin/python3.9"), Path("/lib64/libpython3.9.so.1.0"), Path("/usr/local/lib/python3.9/site-packages/threadpoolctl.py")]
files += sorted(p for p in Path("/usr/local/lib64/python3.9/site-packages/numpy").rglob("*") if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc")
digest = hashlib.sha256()
for path in files:
    digest.update(str(path).encode() + b"\0")
    digest.update(path.read_bytes())
if digest.hexdigest() != "d49c5ae9f7881933a1b410a1a53793418b7ec5935736bbb2b0c9b8368820d6bd":
    raise SystemExit("Numerical runtime differs from the pinned oracle")
