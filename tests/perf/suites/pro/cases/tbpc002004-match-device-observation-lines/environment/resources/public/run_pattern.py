#!/usr/bin/env python3
import json, re, sys
from pathlib import Path

if len(sys.argv) != 3:
    raise SystemExit("usage: run_pattern.py PATTERN CORPUS")
raw=Path(sys.argv[1]).read_bytes()
if not raw.endswith(b"\n") or raw.count(b"\n") != 1: raise SystemExit("pattern must be one LF-terminated line")
pattern=raw[:-1].decode("utf-8"); compiled=re.compile(pattern,re.MULTILINE)
if compiled.groups != 1: raise SystemExit("pattern must have one capture")
print(json.dumps(compiled.findall(Path(sys.argv[2]).read_text(encoding="utf-8")),ensure_ascii=False))
