#!/usr/bin/env python3
"""Local, strict scoring of the vendored pro acceptance tests.

The local unittest driver prepares case fixtures and emits a complete test
summary. No platform reward script or prebuilt grading runtime is executed.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import time
from pathlib import Path

import tomllib

POLICY = "areal-pro-strict-v1"


def score_summary(value: dict, exit_code: int) -> dict:
    if exit_code != 0:
        raise ValueError(f"acceptance driver failed with exit {exit_code}")
    summary = value["results"]["summary"]
    counts = {
        key: summary.get(key, 0)
        for key in ("tests", "passed", "failed", "skipped", "pending", "other")
    }
    if any(type(count) is not int or count < 0 for count in counts.values()):
        raise ValueError("invalid acceptance test counts")
    if (
        counts["tests"] == 0
        or sum(counts[key] for key in counts if key != "tests") != counts["tests"]
    ):
        raise ValueError("empty or inconsistent acceptance test summary")
    return {
        "score": float(counts["passed"] == counts["tests"]),
        "metrics": {**counts, "test_pass_rate": counts["passed"] / counts["tests"]},
    }


def main() -> int:
    started = time.monotonic()
    output = Path("/output")
    verifier = Path("/logs/verifier")
    result = {
        "schema_version": 1,
        "policy": POLICY,
        "status": "failed",
        "score": None,
        "metrics": {},
        "exit_code": None,
    }
    process = None
    try:
        task = tomllib.loads(Path("/task/task.toml").read_text())
        verifier.mkdir(parents=True, exist_ok=True)
        for filename in ("ctrf.json", "reward.txt"):
            (verifier / filename).unlink(missing_ok=True)
        # No model credentials or Python search-path overrides reach the judge.
        environment = {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "HOME": "/root",
            "LANG": "C.UTF-8",
            "PYTHONNOUSERSITE": "1",
        }
        with (
            (output / "grader.stdout.log").open("w") as stdout,
            (output / "grader.stderr.log").open("w") as stderr,
        ):
            process = subprocess.Popen(
                task["grader"]["command"],
                cwd=task["environment"]["workdir"],
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=stdout,
                stderr=stderr,
                start_new_session=True,
            )
            result["exit_code"] = process.wait(timeout=task["grader"]["timeout_seconds"])
        summary = json.loads((verifier / "ctrf.json").read_text())
        result.update(score_summary(summary, result["exit_code"]))
        (output / "grader-tests.json").write_text(json.dumps(summary, indent=2) + "\n")
        result["status"] = "passed" if result["score"] == 1 else "failed"
    except subprocess.TimeoutExpired:
        result.update(status="timeout", error="acceptance tests exceeded the grader deadline")
    except Exception as error:
        result["error"] = str(error)
    finally:
        if process is not None:
            # Reap the whole test process group, including leaked child commands.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
    result["duration_ms"] = round((time.monotonic() - started) * 1000, 3)
    path = output / "grader-result.json"
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(result, indent=2) + "\n")
    temporary.replace(path)
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
