#!/usr/bin/env python3
"""Deterministic suite smoke runner; it is not a benchmark implementation."""

import json
import os
from pathlib import Path

workspace = Path(os.environ["AREAL_PERF_WORKSPACE"])
target = workspace / "pricing.py"
source = target.read_text()
broken = "return subtotal - shipping"
fixed = "return subtotal + shipping"
if broken not in source:
    raise SystemExit("fixture no longer contains the expected defect")
print(json.dumps({"type": "tool.started", "tool": "apply_patch"}), flush=True)
target.write_text(source.replace(broken, fixed))
print(json.dumps({"type": "tool.completed", "tool": "apply_patch"}), flush=True)
print(json.dumps({"type": "task.completed", "usage": {"input_tokens": 0, "output_tokens": 0}}), flush=True)
