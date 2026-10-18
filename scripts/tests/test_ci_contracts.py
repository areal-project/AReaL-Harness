"""门禁、路径映射和独立审计的离线故障注入。"""

import importlib.util
from pathlib import Path
import subprocess
import tempfile
import shutil
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"scripts/{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


scope = load("ci-scope")
audit = load("dependency-audit")


class CiContracts(unittest.TestCase):
    def test_release_inputs_and_actual_workflow_scripts_are_mapped(self):
        paths = [
            "core/engine/src/lib.rs",
            "runtime/daemon/src/main.rs",
            "schemas/local-service-v1.json",
            "Makefile",
            "rust-toolchain.toml",
            "scripts/release-smoke.py",
            "scripts/native-tools-smoke.py",
            "examples/desktop-api/soak.mjs",
            "package-lock.json",
        ]
        for path in paths:
            with self.subTest(path=path):
                self.assertTrue(scope.applicable("release", [path]))
        self.assertFalse(scope.applicable("release", ["docs/features.md"]))

    def test_gui_inputs_and_inapplicable_docs(self):
        for path in (
            "clients/cli/src/main.rs",
            "clients/tui/src/lib.rs",
            "clients/web/app.js",
            "core/server/build.rs",
            "runtime/daemon/src/main.rs",
            "schemas/native-host-v2.json",
            "Makefile",
        ):
            with self.subTest(path=path):
                self.assertTrue(scope.applicable("gui", [path]))
        self.assertFalse(scope.applicable("gui", ["docs/features.md"]))

    def test_real_npm_scanner_error_in_isolated_lock_fixture_still_runs_next_scan(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ("package.json", "package-lock.json"):
                shutil.copy2(ROOT / name, root / name)
            results = audit.scan_all(
                [
                    (
                        "offline-registry",
                        [
                            "npm",
                            "audit",
                            "--json",
                            "--registry",
                            "http://127.0.0.1:1",
                            "--fetch-retries=0",
                            "--fetch-timeout=1000",
                        ],
                        ".",
                    ),
                    (
                        "next-scan",
                        [
                            sys.executable,
                            "-c",
                            'print(\'{"metadata":{"vulnerabilities":{"total":0,"high":0}}}\')',
                        ],
                        ".",
                    ),
                ],
                root=root,
            )
            self.assertEqual([item["status"] for item in results], ["scan_error", "clean"])
            self.assertFalse(all(item["status"] == "clean" for item in results))

    def test_unexpected_skip_failure_cancel_or_missing_result_fails(self):
        for needed in (True, False):
            for result in ("success", "failure", "cancelled", "skipped", ""):
                self.assertEqual(
                    scope.require_result(needed, result),
                    result == ("success" if needed else "skipped"),
                )

    def test_all_scanners_run_despite_vulnerable_fixture_and_scan_error(self):
        calls = []

        def runner(command, **kwargs):
            calls.append(command[0])
            if command[0] == "rust":
                return subprocess.CompletedProcess(
                    command, 1, '{"vulnerabilities":{"list":[{"id":"fixture-only"}]}}', ""
                )
            if command[0] == "broken":
                return subprocess.CompletedProcess(
                    command, 1, '{"error":{"code":"registry-unavailable"}}', ""
                )
            return subprocess.CompletedProcess(
                command, 0, '{"metadata":{"vulnerabilities":{"total":0,"high":0}}}', ""
            )

        results = audit.scan_all(
            [(name, [name], ".") for name in ("rust", "broken", "npm", "pnpm")], run=runner
        )
        self.assertEqual(calls, ["rust", "broken", "npm", "pnpm"])
        self.assertEqual(
            [item["status"] for item in results],
            ["vulnerabilities", "scan_error", "clean", "clean"],
        )

    def test_malformed_or_missing_scanner_results_cannot_pass(self):
        for report in (
            None,
            {},
            {"error": "failed"},
            {"metadata": None},
            {"metadata": []},
            {"metadata": "invalid"},
            {"metadata": {"vulnerabilities": None}},
            {"metadata": {"vulnerabilities": {"high": -1}}},
            {"metadata": {"vulnerabilities": {"high": "1"}}},
        ):
            self.assertEqual(audit.outcome(0, report), "scan_error")
        self.assertEqual(audit.outcome(1, {"vulnerabilities": {"list": []}}), "scan_error")
