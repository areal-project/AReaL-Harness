#!/usr/bin/env python3
"""Run pro acceptance tests with the task's Python and emit our own test record."""

import hashlib
import importlib.util
import json
import os
import shutil
import site
import sys
import unittest
from pathlib import Path


class AcceptanceResult(unittest.TextTestResult):
    """Count each test method once, even when several subtests fail."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.records = {}

    def mark(self, test, status, detail=None):
        record = self.records.setdefault(
            test.id(), {"name": test.id(), "status": status, "details": []}
        )
        priority = {"passed": 0, "skipped": 1, "failed": 2, "error": 3}
        if priority[status] >= priority[record["status"]]:
            record["status"] = status
        if detail:
            record["details"].append(detail)

    def addSuccess(self, test):
        super().addSuccess(test)
        self.mark(test, "passed")

    def addFailure(self, test, error):
        super().addFailure(test, error)
        self.mark(test, "failed", self._exc_info_to_string(error, test))

    def addError(self, test, error):
        super().addError(test, error)
        self.mark(test, "error", self._exc_info_to_string(error, test))

    def addSubTest(self, test, subtest, error):
        super().addSubTest(test, subtest, error)
        if error:
            self.mark(
                test,
                "failed",
                subtest.id() + "\n" + self._exc_info_to_string(error, test),
            )

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self.mark(getattr(test, "test_case", test), "skipped", reason)

    def addExpectedFailure(self, test, error):
        super().addExpectedFailure(test, error)
        self.mark(test, "skipped", "expected failure")

    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        self.mark(test, "failed", "unexpected success")


def restore_system_site_packages():
    # RHEL's Python can hide /usr/local system packages when user-site loading
    # is disabled. Restore only interpreter system directories, without loading
    # user packages or processing their .pth files.
    if sys.prefix == sys.base_prefix:
        system_sites = [
            directory
            for directory in site.getsitepackages([sys.base_prefix, "/usr/local"])
            if Path(directory).is_dir()
        ]
        for directory in system_sites:
            if directory not in sys.path:
                sys.path.append(directory)
        # Acceptance tests also launch the task's public Python runners. Give
        # those children the same trusted interpreter system packages.
        if system_sites:
            os.environ["PYTHONPATH"] = os.pathsep.join(dict.fromkeys(system_sites))
        else:
            os.environ.pop("PYTHONPATH", None)


def main():
    restore_system_site_packages()
    oracle = Path("/tests")
    manifest = oracle / "manifest.sha256"
    if manifest.exists():
        for line in manifest.read_text().splitlines():
            digest, name = line.split(maxsplit=1)
            path = (oracle / name.lstrip("*")).resolve()
            if (
                oracle not in path.parents
                or hashlib.sha256(path.read_bytes()).hexdigest() != digest
            ):
                raise RuntimeError("acceptance fixture checksum mismatch")
    # Two migration tasks execute candidates through this trusted privilege-drop
    # helper. Keep their fixture contract without invoking the platform reward.
    launcher = oracle / "candidate_launcher"
    if launcher.exists():
        trusted = Path("/trusted")
        trusted.mkdir(mode=0o755, exist_ok=True)
        shutil.copyfile(launcher, trusted / launcher.name)
        (trusted / launcher.name).chmod(0o555)
    sys.path.insert(0, str(oracle))
    spec = importlib.util.spec_from_file_location("pro_acceptance", oracle / "test_outputs.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    suite = unittest.defaultTestLoader.loadTestsFromModule(module)
    result = unittest.TextTestRunner(verbosity=2, resultclass=AcceptanceResult).run(suite)
    if result.testsRun == 0:
        raise RuntimeError("no acceptance tests executed")
    details = list(result.records.values())
    summary = {
        "tests": len(details),
        "passed": sum(t["status"] == "passed" for t in details),
        "failed": sum(t["status"] in {"failed", "error"} for t in details),
        "skipped": sum(t["status"] == "skipped" for t in details),
    }
    Path("/logs/verifier/ctrf.json").write_text(
        json.dumps({"results": {"summary": summary, "tests": details}}, indent=2) + "\n"
    )
    return 0  # A valid negative grade is not a broken evaluator.


if __name__ == "__main__":
    raise SystemExit(main())
