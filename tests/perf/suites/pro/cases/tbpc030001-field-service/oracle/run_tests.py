#!/usr/bin/env python3
"""Run an injected unittest module and write the CTRF summary expected by Arena."""

from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: run_tests.py TEST_FILE CTRF_FILE")
    test_file = Path(sys.argv[1])
    ctrf_file = Path(sys.argv[2])
    spec = importlib.util.spec_from_file_location("injected_task_tests", test_file)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {test_file}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    suite = unittest.defaultTestLoader.loadTestsFromModule(module)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    total = result.testsRun
    failed = len(result.failures) + len(result.errors) + len(result.unexpectedSuccesses)
    skipped = len(result.skipped)
    ctrf_file.parent.mkdir(parents=True, exist_ok=True)
    ctrf_file.write_text(
        json.dumps(
            {
                "results": {
                    "summary": {
                        "tests": total,
                        "passed": total - failed - skipped,
                        "failed": failed,
                        "skipped": skipped,
                    }
                }
            },
            separators=(",", ":"),
        )
        + "\n",
        encoding="utf-8",
    )
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
