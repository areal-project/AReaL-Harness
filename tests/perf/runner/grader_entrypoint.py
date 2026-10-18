#!/usr/bin/env python3
"""Run the trusted grader outside the agent container."""

from __future__ import annotations

import json
import math
import subprocess
import time
import tomllib
from pathlib import Path

TASK_ROOT = Path("/task")
OUTPUT = Path("/output")
WORKSPACE = Path("/workspace")
MAX_LOG_BYTES = 16 * 1024 * 1024
SCORE_PATH = OUTPUT / "grader-score.json"


def read_score(default: float) -> tuple[float, dict[str, float]]:
    if not SCORE_PATH.is_file():
        return default, {}
    value = json.loads(SCORE_PATH.read_text())
    if not isinstance(value, dict):
        raise ValueError("grader-score.json must contain an object")
    score = value.get("score")
    if not isinstance(score, (int, float)) or isinstance(score, bool) or not math.isfinite(score):
        raise ValueError("grader-score.json score must be a finite number")
    metrics = value.get("metrics", {})
    if not isinstance(metrics, dict) or any(
        not isinstance(metric, (int, float))
        or isinstance(metric, bool)
        or not math.isfinite(metric)
        for metric in metrics.values()
    ):
        raise ValueError("grader-score.json metrics must contain only finite numbers")
    return float(score), {str(name): float(metric) for name, metric in metrics.items()}


def main() -> int:
    started = time.monotonic()
    with (TASK_ROOT / "task.toml").open("rb") as handle:
        task = tomllib.load(handle)
    grader = task.get("grader", {})
    command = grader.get("command")
    timeout = int(grader.get("timeout_seconds", 60))
    result = {
        "schema_version": 1,
        "status": "failed",
        "exit_code": None,
        "score": None,
        "metrics": {},
    }
    try:
        if (
            not isinstance(command, list)
            or not command
            or not all(isinstance(part, str) and part for part in command)
        ):
            raise ValueError("grader.command must be a non-empty string array")
        SCORE_PATH.unlink(missing_ok=True)
        completed = subprocess.run(
            command,
            cwd=WORKSPACE,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=timeout,
            env={"PATH": "/usr/local/bin:/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"},
            check=False,
        )
        (OUTPUT / "grader.stdout.log").write_bytes(completed.stdout[:MAX_LOG_BYTES])
        (OUTPUT / "grader.stderr.log").write_bytes(completed.stderr[:MAX_LOG_BYTES])
        result["exit_code"] = completed.returncode
        result["status"] = "passed" if completed.returncode == 0 else "failed"
        result["score"], result["metrics"] = read_score(1.0 if completed.returncode == 0 else 0.0)
    except subprocess.TimeoutExpired as error:
        result["status"] = "timeout"
        (OUTPUT / "grader.stdout.log").write_bytes((error.stdout or b"")[:MAX_LOG_BYTES])
        (OUTPUT / "grader.stderr.log").write_bytes((error.stderr or b"")[:MAX_LOG_BYTES])
    except Exception as error:
        result["status"] = "failed"
        result["score"] = None
        result["metrics"] = {}
        result["error"] = str(error)
    result["duration_ms"] = round((time.monotonic() - started) * 1000, 3)
    temporary = OUTPUT / "grader-result.json.tmp"
    temporary.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    temporary.replace(OUTPUT / "grader-result.json")
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
