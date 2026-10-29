"""门禁、路径映射和独立审计的离线故障注入。"""

import importlib.util
import copy
import json
import os
import re
from pathlib import Path
import subprocess
import tempfile
import shutil
import sys
import tomllib
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"scripts/{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


scope = load("ci-scope")
audit = load("dependency-audit")
gate = load("ci-gate")
preflight = load("ci-preflight")


class CiContracts(unittest.TestCase):
    def test_mobile_environment_keeps_the_gui_runtime_and_passes_the_relay_runtime(self):
        with patch.dict(
            os.environ, {"PATH": "/gui-node/bin", "AREAL_RELAY_NODE_BIN": "/relay-node/bin/node"}
        ):
            env = preflight.environment(
                {
                    "id": "mobile-browser",
                    "group": "mobile",
                    "requires": ["node-24.22.1", "relay-node-24.2.0"],
                },
                ROOT,
            )
        self.assertEqual(env["PATH"], "/gui-node/bin")
        self.assertEqual(env["AREAL_RELAY_NODE"], "/relay-node/bin/node")

    def test_new_feature_acceptance_is_required_by_the_shared_gui_gate(self):
        plan, reports = self.gate_fixture(("clients/gui/renderer/src/Composer.tsx",))
        required = {
            "smoke:test:composer-files",
            "mobile-types",
            "mobile-relay-install",
            "mobile-browser",
        }
        items = {item["id"]: item for item in plan["items"]}
        self.assertTrue(required <= items.keys(), required - items.keys())
        self.assertEqual(items["mobile-browser"]["dependsOn"], ["mobile-relay-install"])
        self.assertEqual(scope.CI_PLATFORMS["mobile"], "linux")
        self.assertEqual(scope.JOB_GROUPS["gui"]["mobile"], {"mobile"})
        for name in required:
            missing = copy.deepcopy(reports)
            for report in missing:
                report["results"] = [row for row in report["results"] if row["id"] != name]
            self.assertIn(
                "missing required check " + name,
                gate.validate(plan, missing, scope.WORKFLOW_GROUPS["gui"], ("run", "2")),
            )

    def test_quick_plan_avoids_duplicate_builds_and_preserves_full_acceptance(self):
        plan, _ = self.gate_fixture()
        quick = {item["id"] for item in plan["items"] if item["phase"] == "commit"}
        full = {item["id"] for item in plan["items"]}
        expensive = {
            "relay:desktop",
            "relay:ui",
            "relay:renderer",
            "relay:bundle",
            "macos:desktop",
            "macos:ui",
            "macos:renderer",
            "macos:bundle",
            "computer-helper",
            "mobile-browser",
            "smoke:test:composer-files",
        }
        self.assertTrue(expensive <= full)
        self.assertFalse(expensive & quick)
        self.assertTrue({"portable:renderer", "portable:bundle", "mobile-types"} <= quick)
        for item in plan["items"]:
            if item["id"] in quick:
                self.assertTrue(set(item["dependsOn"]) <= quick, item["id"])

    def test_native_container_copies_side_test_runtime_fixture_inputs(self):
        dockerfile = (ROOT / "tests/e2e/docker/Dockerfile").read_text()
        image = dockerfile.split("\nFROM ${BASE_IMAGE}", 1)[0]
        copies = re.findall(r"^COPY (\S+) (\S+)$", image, re.MULTILINE)
        source = ROOT / "core/app-server/tests/side_workspace_read.rs"
        paths = re.findall(
            r'concat!\(\s*env!\("CARGO_MANIFEST_DIR"\)\s*,\s*"([^"]+)"\s*\)',
            source.read_text(),
        )
        self.assertTrue(paths, "native Side acceptance must retain its untrusted MCP fixture")
        for path in paths:
            asset = (source.parent.parent / path.lstrip("/")).resolve()
            self.assertTrue(asset.is_file(), f"missing native fixture: {asset}")
            expected = "/src/" + asset.relative_to(ROOT).as_posix()
            delivered = set()
            for copied, destination in copies:
                origin = ROOT / copied
                if origin.is_dir() and asset.is_relative_to(origin):
                    target = Path(destination) / asset.relative_to(origin)
                elif asset == origin:
                    target = (
                        Path(destination) / origin.name
                        if destination.endswith("/")
                        else Path(destination)
                    )
                else:
                    continue
                delivered.add(os.path.normpath(str(Path("/src") / target)))
            self.assertIn(
                expected,
                delivered,
                f"native runtime fixture is absent from its image path: {expected}",
            )

    def test_container_installs_the_matching_reaper_beside_in_process_test_hosts(self):
        dockerfile = (ROOT / "tests/e2e/docker/Dockerfile").read_text()
        stage = dockerfile.split("FROM runtime-builder AS runtime-tests\n", 1)[1].split(
            "\nFROM ", 1
        )[0]
        instructions = stage.replace("\\\n", " ").splitlines()
        bundle = re.search(r"^ENV AREAL_TEST_BIN_DIR=/src/(.+)$", stage, re.MULTILINE)[1]
        manifest = tomllib.loads((ROOT / "runtime/exec-native/Cargo.toml").read_text())
        reaper = manifest["bin"][0]["name"]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / bundle
            (binary / "deps").mkdir(parents=True)
            for name in ("areal-runtime", "areal-runtime-fs", reaper):
                path = binary / name
                path.write_text(f"matching build: {name}\n")
                path.chmod(0o755)
            tools = root / "tools"
            tools.mkdir()
            # 编译和包管理在边界外；执行真实安装命令，核对交付位置、字节和权限。
            for name in ("apk", "cargo"):
                path = tools / name
                path.write_text("#!/bin/sh\nexit 0\n")
                path.chmod(0o755)
            for instruction in instructions:
                if instruction.startswith("COPY "):
                    _, origin, destination = instruction.split()
                    target = (
                        root / Path(destination).relative_to("/src")
                        if destination.startswith("/src/")
                        else root / destination
                    )
                    if (ROOT / origin).is_dir():
                        shutil.copytree(ROOT / origin, target, dirs_exist_ok=True)
                    else:
                        target.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(ROOT / origin, target)
                if instruction.startswith("RUN "):
                    done = subprocess.run(
                        ["sh", "-c", "set -e\n" + instruction.removeprefix("RUN ")],
                        cwd=root,
                        env={**os.environ, "PATH": str(tools) + os.pathsep + os.environ["PATH"]},
                        capture_output=True,
                        text=True,
                    )
                    self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
            helper = binary / "deps" / reaper
            self.assertTrue(helper.is_file(), "in-process integration host has no sibling reaper")
            self.assertEqual(helper.read_bytes(), (binary / reaper).read_bytes())
            self.assertTrue(os.access(helper, os.X_OK))

    def test_gui_plan_jobs_install_the_declared_python_toolchain(self):
        workflow = (ROOT / ".github/workflows/gui.yml").read_text()
        for job in re.split(r"(?m)^  [a-z][a-z0-9-]+:\n", workflow):
            if "scripts/ci-preflight.py" in job:
                self.assertIn("actions/setup-python@", job)
                self.assertIn("python-version: '3.13'", job)
                self.assertLess(
                    job.index("actions/setup-python@"), job.index("scripts/ci-preflight.py")
                )

    def test_web_compile_time_assets_are_copied_into_container_and_trigger_checks(self):
        source = ROOT / "core/app-server/src/lib.rs"
        dockerfile = (ROOT / "tests/e2e/docker/Dockerfile").read_text()
        copied = re.findall(r"^COPY (\S+) ", dockerfile, re.MULTILINE)
        for relative in re.findall(r'include_str!\("([^"]+)"\)', source.read_text()):
            asset = (source.parent / relative).resolve().relative_to(ROOT).as_posix()
            with self.subTest(asset=asset):
                self.assertTrue(
                    any(asset == path or asset.startswith(path + "/") for path in copied)
                )
                self.assertTrue(scope.applicable("gui", [asset]))
                self.assertTrue(scope.applicable("release", [asset]))

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

    def gate_fixture(self, paths=("Makefile",), workflow="gui"):
        source = {
            "baseRevision": "base",
            "sourceRevision": "merge",
            "headRevision": "head",
            "inputHash": "inputs",
        }
        manifest = json.loads((ROOT / "clients/gui/scripts/test-manifest.json").read_text())
        plan = scope.build_plan(list(paths), source, manifest)
        grouped = {}
        for item in plan["items"]:
            if item["group"] not in scope.WORKFLOW_GROUPS[workflow]:
                continue
            platform = scope.CI_PLATFORMS[item["group"]]
            report = grouped.setdefault(
                platform,
                {
                    "kind": "verification-report",
                    "status": "passed",
                    "platform": platform,
                    "identity": {
                        **source,
                        "planHash": plan["planHash"],
                        "ciRunId": "run",
                        "ciAttempt": "2",
                    },
                    "results": [],
                },
            )
            result = {"id": item["id"], "status": "passed", "exitCode": 0}
            if "expectedTests" in item:
                result["tests"] = [
                    {"script": script, "status": "passed", "passed": True, "exitCode": 0}
                    for script in item["expectedTests"][platform]
                ]
            report["results"].append(result)
        return plan, list(grouped.values())

    def test_final_gate_rejects_omitted_required_check_even_when_every_received_check_passed(self):
        plan, reports = self.gate_fixture()
        self.assertEqual(
            gate.validate(plan, reports, scope.WORKFLOW_GROUPS["gui"], ("run", "2")), []
        )
        self.assertTrue(
            {"gui-portable", "relay-contracts", "core-contracts", "smoke:test:composer"}
            <= {item["id"] for item in plan["items"]}
        )
        removed = reports[0]["results"].pop()
        self.assertIn(
            "missing required check " + removed["id"],
            gate.validate(plan, reports, scope.WORKFLOW_GROUPS["gui"], ("run", "2")),
        )

    def test_gate_requires_every_declared_job_and_relay_cannot_fail_cancel_or_skip(self):
        plan, _ = self.gate_fixture()
        expected = {
            "scope",
            "gui-health",
            "gui-portable",
            "relay-contracts",
            "gui",
            "core-contracts",
            "smoke",
            "mobile",
        }
        self.assertEqual(set(scope.JOB_GROUPS["gui"]), expected)
        jobs = {name: {"result": "success"} for name in expected}
        self.assertEqual(gate.validate_jobs(plan, "gui", jobs), [])
        for name in expected:
            missing = copy.deepcopy(jobs)
            del missing[name]
            self.assertTrue(gate.validate_jobs(plan, "gui", missing))
        for status in ("failure", "cancelled", "skipped", "", None):
            jobs["relay-contracts"]["result"] = status
            self.assertTrue(gate.validate_jobs(plan, "gui", jobs))

    def test_runner_subtest_omission_is_rejected_even_with_a_successful_job(self):
        plan, reports = self.gate_fixture()
        result = next(
            result
            for report in reports
            for result in report["results"]
            if result["id"] == "gui-portable"
        )
        result["tests"].pop()
        failures = gate.validate(plan, reports, scope.WORKFLOW_GROUPS["gui"], ("run", "2"))
        self.assertIn("missing or duplicate runner tests: gui-portable", failures)

    def test_stale_sha_input_plan_attempt_and_invalidated_reports_cannot_pass(self):
        plan, original = self.gate_fixture()
        for key in ("sourceRevision", "inputHash", "planHash", "ciRunId", "ciAttempt"):
            reports = copy.deepcopy(original)
            reports[0]["identity"][key] = "stale"
            self.assertTrue(
                gate.validate(plan, reports, scope.WORKFLOW_GROUPS["gui"], ("run", "2")), key
            )
        reports = copy.deepcopy(original)
        reports[0]["status"] = "invalidated"
        self.assertTrue(gate.validate(plan, reports, scope.WORKFLOW_GROUPS["gui"], ("run", "2")))

    def test_duplicate_unexpected_and_wrong_platform_receipts_fail(self):
        plan, original = self.gate_fixture()
        for operation in ("duplicate", "unexpected", "platform"):
            reports = copy.deepcopy(original)
            if operation == "duplicate":
                reports[0]["results"].append(reports[0]["results"][0])
            elif operation == "unexpected":
                reports[0]["results"].append(
                    {"id": "not-required", "status": "passed", "exitCode": 0}
                )
            else:
                reports[0]["platform"] = "win32"
            self.assertTrue(
                gate.validate(plan, reports, scope.WORKFLOW_GROUPS["gui"], ("run", "2")), operation
            )

    def test_docs_only_skip_is_derived_from_an_empty_gui_projection(self):
        plan, reports = self.gate_fixture(("docs/features.md",))
        self.assertEqual(reports, [])
        jobs = {
            name: {"result": "success" if name == "scope" else "skipped"}
            for name in scope.JOB_GROUPS["gui"]
        }
        self.assertEqual(
            gate.validate(plan, reports, scope.WORKFLOW_GROUPS["gui"], ("run", "2")), []
        )
        self.assertEqual(gate.validate_jobs(plan, "gui", jobs), [])

    def test_gui_plan_preserves_every_current_production_build_prerequisite(self):
        plan, _ = self.gate_fixture(("clients/gui/native/computer-helper/Sources/main.swift",))
        config = (ROOT / "clients/gui/vite.config.mts").read_text()
        block = config.split('"build-suite": {', 1)[1].split('"design-build": {', 1)[0]
        dependencies = json.loads(re.search(r"dependsOn: (\[[^\]]+\])", block).group(1))
        tasks = {
            item.get("productionTask") for item in plan["items"] if item["group"] == "gui-build"
        }
        self.assertTrue(set(dependencies) <= tasks)
        helper = next(item for item in plan["items"] if item["id"] == "computer-helper")
        self.assertEqual(
            helper["command"], ["node", "clients/gui/scripts/build-computer-helper.mjs"]
        )
        self.assertIn("xcode", helper["requires"])

    def test_native_dmg_contract_has_one_declared_mac_owner(self):
        plan, _ = self.gate_fixture()
        portable = next(item for item in plan["items"] if item["id"] == "gui-portable")
        self.assertNotIn("test:macos-dmg", portable["expectedTests"]["darwin"])
        self.assertEqual(sum(item["command"][-1] == "test:macos-dmg" for item in plan["items"]), 1)

    def test_container_plan_keeps_all_existing_native_security_and_ownership_checks(self):
        plan, _ = self.gate_fixture()
        names = {item["id"] for item in plan["items"] if item["group"] == "container"}
        self.assertTrue(
            {
                "container-native",
                "container-sandbox",
                "container-tools",
                "container-unified",
                "container-ownership",
            }
            <= names
        )

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


class PreflightExecution(unittest.TestCase):
    """Exercise Make recipes while replacing only heavyweight external tools."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        shutil.copy2(ROOT / "Makefile", self.root / "Makefile")
        (self.root / "clients/gui").mkdir(parents=True)
        (self.root / "scripts").mkdir()
        for name in ("ci-preflight.py", "check-changed.py", "ci-scope.py"):
            shutil.copy2(ROOT / "scripts" / name, self.root / "scripts" / name)
        (self.root / "scripts/ci-fingerprint.py").write_text("print('{}')\n")
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "commands.jsonl"
        tool = self.bin / "tool"
        tool.write_text(
            f"#!{sys.executable}\n"
            "import json, os, pathlib, sys\n"
            "with open(os.environ['COMMAND_LOG'], 'a') as log:\n"
            " log.write(json.dumps({'tool': pathlib.Path(sys.argv[0]).name, "
            "'args': sys.argv[1:], 'base': os.environ.get('AREAL_DESIGN_BASE'), "
            "'core': os.environ.get('AREAL_CORE_BIN'), 'runtimeBin': os.environ.get('AREAL_TEST_BIN_DIR')}) + '\\n')\n"
            "if sys.argv[1:2] == ['scripts/ci-preflight.py']:\n"
            " os.execv(sys.executable, [sys.executable, *sys.argv[1:]])\n"
            "sys.exit(43 if os.environ.get('FAIL_ARG') and "
            "os.environ['FAIL_ARG'] in sys.argv[1:] else 0)\n"
        )
        tool.chmod(0o755)
        for name in (
            "cargo",
            "uv",
            "npm",
            "pnpm",
            "node",
            "python3",
            "actionlint",
        ):
            (self.bin / name).symlink_to(tool)
        self.environment = {
            **os.environ,
            "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}",
            "COMMAND_LOG": str(self.log),
            # 此夹具使用自有假 Core，不能继承真实 pre-push 的固定产物路径。
            "AREAL_CORE_BIN": "",
        }
        self.git("init", "-q")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "user.name", "Fixture")
        self.git("add", "Makefile")
        self.git("commit", "-qm", "fixture base")
        self.base = self.git("rev-parse", "HEAD").strip()
        self.comparison = self.git(
            "commit-tree", f"{self.base}^{{tree}}", "-p", self.base, "-m", "target branch"
        ).strip()
        (self.root / "head-only").write_text("current branch")
        self.git("add", "head-only")
        self.git("commit", "-qm", "current branch")

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, text=True)

    def make(self, target, *args, **env):
        return subprocess.run(
            ["make", target, *args],
            cwd=self.root,
            env={**self.environment, **env},
            capture_output=True,
            text=True,
        )

    def calls(self):
        return (
            [json.loads(line) for line in self.log.read_text().splitlines()]
            if self.log.exists()
            else []
        )

    def test_workspace_tests_require_build_and_receive_runtime_directory(self):
        result = self.make("test", AREAL_TEST_BIN_DIR="")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        build = next(
            i for i, row in enumerate(calls) if row["tool"] == "cargo" and "build" in row["args"]
        )
        tests = next(
            i for i, row in enumerate(calls) if row["tool"] == "cargo" and "test" in row["args"]
        )
        self.assertLess(build, tests)
        self.assertEqual(calls[tests]["runtimeBin"], str(self.root.resolve() / "target/debug"))
        self.log.unlink()
        result = self.make("test", FAIL_ARG="build")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(
            any(row["tool"] == "cargo" and "test" in row["args"] for row in self.calls())
        )

    def test_preflight_requires_an_explicit_comparison_base_before_running_tools(self):
        result = self.make("ci-preflight", "CI_BASE=")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("CI_BASE", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_fixed_core_must_match_freshly_built_bytes(self):
        built = self.root / "target/debug/areal"
        built.parent.mkdir(parents=True)
        shutil.copy2(self.bin / "tool", built)
        fixed = self.bin / "fixed-areal"
        shutil.copy2(built, fixed)
        from unittest.mock import patch

        with patch.dict(os.environ, {"AREAL_CORE_BIN": str(fixed)}):
            self.assertEqual(preflight.matching_core(self.root), fixed)
            fixed.write_text(fixed.read_text() + "# stale build\n")
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                preflight.matching_core(self.root)

    def test_portable_execution_cannot_inherit_a_core_binary(self):
        from unittest.mock import patch

        with patch.dict(os.environ, {"AREAL_CORE_BIN": "/must-not-use"}):
            env = preflight.environment(
                {"id": "gui-portable", "group": "gui-portable", "requires": []}, self.root
            )
        self.assertNotIn("AREAL_CORE_BIN", env)


if __name__ == "__main__":
    unittest.main()
