#!/usr/bin/python3.9
import json
import sys
import unittest
from pathlib import Path

sys.path[:0] = ["/tests", "/usr/local/lib64/python3.9/site-packages", "/usr/local/lib/python3.9/site-packages"]

suite = unittest.defaultTestLoader.loadTestsFromName("test_outputs")
result = unittest.TextTestRunner(verbosity=2).run(suite)
failed = len(result.failures) + len(result.errors) + len(result.unexpectedSuccesses)
tests = max(result.testsRun, failed, 1)
Path(sys.argv[1]).write_text(json.dumps({
    "results": {"summary": {
        "tests": tests,
        "passed": tests - failed,
        "failed": failed,
        "skipped": len(result.skipped),
    }}
}, separators=(",", ":")) + "\n")
raise SystemExit(0 if result.wasSuccessful() else 1)
