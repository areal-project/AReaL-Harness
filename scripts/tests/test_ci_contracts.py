"""门禁、路径映射和独立审计的离线故障注入。"""

import importlib.util
import copy
import contextlib
import io
import json
import os
import re
from pathlib import Path
import subprocess
import tempfile
import textwrap
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
docs = load("check-docs")
timing = load("ci-timing")


class CiContracts(unittest.TestCase):
    def test_tracked_docs_cannot_link_ignored_or_untracked_markdown(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            (root / "guide.md").write_text("[local](target.md)\n")
            (root / ".gitignore").write_text("target.md\n")
            (root / "target.md").write_text("# Local-only target\n")
            subprocess.run(["git", "add", "guide.md", ".gitignore"], cwd=root, check=True)
            for ignored in (True, False):
                if not ignored:
                    (root / ".gitignore").write_text("")
                output = io.StringIO()
                with patch.object(docs, "ROOT", root), contextlib.redirect_stdout(output):
                    result = docs.main()
                self.assertEqual(result, 1)
                self.assertIn("未纳入 Git", output.getvalue())
            subprocess.run(["git", "add", "target.md"], cwd=root, check=True)
            with patch.object(docs, "ROOT", root), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(docs.main(), 0)

    def test_red_main_issue_changes_only_for_the_current_completed_attempt(self):
        workflow = (ROOT / ".github/workflows/ci-red-main.yml").read_text()
        script = textwrap.dedent(workflow.split("        run: |\n", 1)[1])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log = root / "commands.jsonl"
            gh = root / "gh"
            gh.write_text(
                f"#!{sys.executable}\n"
                + textwrap.dedent("""\
                    import json, os, sys
                    args = sys.argv[1:]
                    if args[0] == "api":
                        if os.environ.get("API_FAIL"):
                            sys.exit(1)
                        if "/git/ref/" in args[1]:
                            print(os.environ["MAIN_SHA"])
                        else:
                            print(os.environ["LATEST_RUN"])
                    elif args[:2] == ["issue", "list"]:
                        print(os.environ.get("ISSUE_NUMBER", "42"))
                    else:
                        with open(os.environ["COMMAND_LOG"], "a") as output:
                            output.write(json.dumps(args) + chr(10))
                    """)
            )
            gh.chmod(0o755)
            environment = {
                **os.environ,
                "PATH": str(root) + os.pathsep + os.environ["PATH"],
                "COMMAND_LOG": str(log),
                "GH_REPO": "fixture/repo",
                "OWNER": "fixture",
                "WORKFLOW": "GUI checks",
                "WORKFLOW_ID": "200",
                "RUN_ID": "100",
                "RUN_ATTEMPT": "1",
                "RUN_URL": "https://example.invalid/runs/100",
                "SHA": "current",
                "MAIN_SHA": "current",
                "CONCLUSION": "success",
                "LATEST_RUN": "100\t1\tcompleted\tsuccess",
            }
            for changes, expected in [
                ({"MAIN_SHA": "newer"}, None),
                ({"LATEST_RUN": "101\t1\tcompleted\tfailure"}, None),
                ({"LATEST_RUN": "100\t2\tcompleted\tfailure"}, None),
                ({"LATEST_RUN": "100\t1\tin_progress\t"}, None),
                ({}, ["issue", "close"]),
                (
                    {"CONCLUSION": "failure", "LATEST_RUN": "100\t1\tcompleted\tfailure"},
                    ["issue", "comment"],
                ),
            ]:
                with self.subTest(changes=changes):
                    log.unlink(missing_ok=True)
                    result = subprocess.run(
                        ["bash", "-c", script],
                        env={**environment, **changes},
                        capture_output=True,
                        text=True,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    mutations = (
                        [json.loads(line) for line in log.read_text().splitlines()]
                        if log.exists()
                        else []
                    )
                    self.assertEqual([row[:2] for row in mutations], [expected] if expected else [])
            log.unlink(missing_ok=True)
            failed = subprocess.run(
                ["bash", "-c", script],
                env={**environment, "API_FAIL": "1"},
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(failed.returncode, 0)
            self.assertFalse(log.exists())

    def test_dispatch_null_or_missing_inputs_preserves_the_full_release_plan(self):
        from unittest.mock import patch

        with tempfile.TemporaryDirectory() as directory:
            event = Path(directory) / "event.json"
            for payload in ({"inputs": None}, {}, {"inputs": {}}):
                event.write_text(json.dumps(payload))
                with patch.dict(os.environ, {"GITHUB_EVENT_PATH": str(event)}):
                    plan = scope.repository_plan(ROOT)
                self.assertEqual(
                    plan["source"]["sourceRevision"],
                    scope.git(ROOT, "rev-parse", "HEAD").decode().strip(),
                )
                self.assertIn("Cargo.toml", plan["paths"])
                self.assertTrue(plan["items"])

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
        }
        items = {item["id"]: item for item in plan["items"]}
        self.assertTrue(required <= items.keys(), required - items.keys())
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

    def test_timing_keeps_dependency_wait_and_mixed_builds_out_of_test_duration(self):
        run = {
            "id": 1,
            "name": "GUI checks",
            "head_sha": "source",
            "event": "pull_request",
            "status": "completed",
            "conclusion": "success",
            "created_at": "2026-01-01T00:00:00Z",
        }

        def job(number, name, created, started, ended, steps=()):
            return {
                "id": number,
                "name": name,
                "run_attempt": 1,
                "labels": ["macos-15"],
                "conclusion": "success",
                "created_at": f"2026-01-01T00:{created}",
                "started_at": f"2026-01-01T00:{started}",
                "completed_at": f"2026-01-01T00:{ended}",
                "steps": steps,
            }

        jobs = [
            job(1, "macOS GUI build and contracts", "00:00Z", "00:01Z", "05:00Z"),
            job(2, "macOS GUI smoke (fixture)", "05:00Z", "05:10Z", "06:00Z"),
        ]
        result = timing.analyze([{"run": run, "jobs": jobs}])
        smoke = result["jobs"][1]
        self.assertEqual(smoke["dag_wait_estimate_s"], 300)
        self.assertEqual(smoke["post_dependency_delay_estimate_s"], 10)
        self.assertIsNone(smoke["runner_wait_lower_bound_s"])
        self.assertEqual(smoke["unattributed_wait_s"], 0)
        self.assertEqual(result["runs"][0]["wall_s"], 360)
        self.assertEqual(
            timing.phase("Build and validate independent GUI checks from the shared plan"),
            "mixed_work",
        )
        self.assertEqual(timing.phase("Run actions/upload-artifact@revision"), "upload_cleanup")
        self.assertEqual(timing.phase("Build native backend tests"), "preparation")
        self.assertIsNone(result["runs"][0]["first_failure_feedback_s"])
        jobs[0]["steps"] = [
            {
                "name": "Test fixture prints failed result JSON",
                "conclusion": "success",
                "started_at": "2026-01-01T00:01:00Z",
                "completed_at": "2026-01-01T00:02:00Z",
            },
            {
                "name": "Run smoke",
                "conclusion": "failure",
                "started_at": "2026-01-01T00:02:00Z",
                "completed_at": "2026-01-01T00:03:00Z",
            },
        ]
        result = timing.analyze([{"run": run, "jobs": jobs}])
        self.assertEqual(result["runs"][0]["first_failure_feedback_s"], 180)
        self.assertEqual(result["runs"][0]["first_failure"]["step"], "Run smoke")
        self.assertEqual(result["runs"][0]["first_failure"]["phase"], "validation")

    def test_markdown_runtime_inputs_are_not_documentation_only(self):
        for path in (
            "clients/gui/app/assets/builtin-skills/sample/SKILL.md",
            "core/config/prompt.md",
            "examples/plugin-marketplace/sample/skills/sample/SKILL.md",
            "services/workbench/src/host-library-store.ts",
        ):
            with self.subTest(path=path):
                impact = scope.impact([path])
                self.assertTrue(impact["shared"] or impact["gui"])
        self.assertEqual(
            scope.impact(["services/workbench/src/host-library-store.ts"])["unknown"], []
        )
        for path in (
            "README.md",
            "AGENTS.md",
            "REVIEW.md",
            ".gitignore",
            ".worktreeinclude",
            "tests/guides/gui.md",
            "docs/guides/configuration.md",
            "website/src/App.tsx",
        ):
            with self.subTest(path=path):
                plan, _ = self.gate_fixture([path], workflow="verify")
                self.assertEqual({item["group"] for item in plan["items"]}, {"early"})

    def test_timing_collects_attempt_specific_runs_and_jobs(self):
        run = {"id": 7, "run_attempt": 2}

        def api(command, text):
            endpoint = command[-1]
            if "/attempts/" not in endpoint:
                return json.dumps({"workflow_runs": [run]})
            attempt = int(endpoint.split("/attempts/")[1].split("/")[0])
            if "/jobs?" in endpoint:
                return json.dumps({"jobs": [{"id": attempt, "run_attempt": attempt}]})
            return json.dumps({"id": 7, "run_attempt": attempt})

        with patch.object(timing.subprocess, "check_output", side_effect=api):
            collected = timing.collect("owner/repo", 1)
        self.assertEqual([entry["run"]["run_attempt"] for entry in collected], [1, 2])
        for entry in collected:
            self.assertEqual(entry["jobs"][0]["run_attempt"], entry["run"]["run_attempt"])

    def test_shell_cache_identity_failure_cannot_restore_a_partial_key(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            python = root / "python3"
            for workflow in ("ci", "gui"):
                declaration = (ROOT / f".github/workflows/{workflow}.yml").read_text()
                step = declaration.split("- name: Identify private Bash cache", 1)[1].split(
                    "- name: Restore verified private Bash build", 1
                )[0]
                command = textwrap.dedent(step.split("run: |\n", 1)[1])
                for body in ("exit 42", "exit 0", "echo verified-key"):
                    with self.subTest(workflow=workflow, body=body):
                        python.write_text("#!/bin/sh\n" + body + "\n")
                        python.chmod(0o755)
                        output = root / "output"
                        output.unlink(missing_ok=True)
                        result = subprocess.run(
                            ["bash", "-e", "-o", "pipefail", "-c", command],
                            env={
                                **os.environ,
                                "PATH": str(root) + os.pathsep + os.environ["PATH"],
                                "GITHUB_OUTPUT": str(output),
                            },
                        )
                        if body.startswith("echo"):
                            self.assertEqual(result.returncode, 0)
                            self.assertEqual(output.read_text(), "key=verified-key\n")
                        else:
                            self.assertNotEqual(result.returncode, 0)
                            self.assertFalse(output.exists())

    def test_timing_reruns_use_their_own_start_and_runner_minutes(self):
        run = {
            "id": 1,
            "name": "fixture",
            "head_sha": "source",
            "event": "pull_request",
            "status": "completed",
            "conclusion": "success",
            "created_at": "2026-01-01T00:00:00Z",
        }
        snapshot = []
        for attempt, start, job_start, end in [
            (1, "00:00", "00:01", "00:02"),
            (2, "01:00", "01:04", "01:05"),
        ]:

            def stamp(value):
                return f"2026-01-01T{value}:00Z"

            snapshot.append(
                {
                    "run": {**run, "run_attempt": attempt, "run_started_at": stamp(start)},
                    "jobs": [
                        {
                            "id": attempt,
                            "name": "fixture",
                            "run_attempt": attempt,
                            "started_at": stamp(job_start),
                            "completed_at": stamp(end),
                        }
                    ],
                }
            )
        result = timing.analyze(snapshot)
        self.assertEqual([run["wall_s"] for run in result["runs"]], [120, 300])
        self.assertEqual([run["runner_minutes"] for run in result["runs"]], [1, 1])
        self.assertEqual(result["jobs"][1]["wait_from_run_s"], 240)
        self.assertEqual([run["attempt"] for run in result["runs"]], [1, 2])
        snapshot[1]["jobs"][0]["run_attempt"] = 1
        with self.assertRaisesRegex(ValueError, "mixes workflow attempts"):
            timing.analyze(snapshot)

    def test_core_aggregate_waits_for_every_actual_shard(self):
        jobs = [
            {"id": 1, "name": "macOS GUI build and contracts"},
            {"id": 2, "name": "macOS Core contracts (contracts-1)"},
            {"id": 3, "name": "macOS Core contracts (contracts-2)"},
            {"id": 4, "name": "macOS Core contracts"},
        ]
        self.assertEqual(timing.predecessors(jobs[-1], jobs), jobs[1:3])

    def test_scheduling_experiment_cannot_raise_pr_or_main_parallelism(self):
        workflow = (ROOT / ".github/workflows/gui.yml").read_text()
        step = workflow.split("- name: Select measured smoke scheduling limit", 1)[1].split(
            "      - uses:", 1
        )[0]
        command = textwrap.dedent(step.split("run: |\n", 1)[1])
        self.assertIn("max-parallel: ${{ fromJSON(needs.scope.outputs.smoke_parallel) }}", workflow)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output"
            for event, requested, expected in [
                ("pull_request", "5", "4"),
                ("push", "5", "4"),
                ("workflow_dispatch", "", "4"),
                ("workflow_dispatch", "4", "4"),
                ("workflow_dispatch", "5", "5"),
                ("workflow_dispatch", "6", None),
                ("workflow_dispatch", "5; exit 0", None),
            ]:
                with self.subTest(event=event, requested=requested):
                    output.unlink(missing_ok=True)
                    result = subprocess.run(
                        ["bash", "-e", "-o", "pipefail", "-c", command],
                        env={
                            **os.environ,
                            "GITHUB_EVENT_NAME": event,
                            "SMOKE_PARALLEL_INPUT": requested,
                            "GITHUB_OUTPUT": str(output),
                        },
                        capture_output=True,
                        text=True,
                    )
                    if expected is None:
                        self.assertNotEqual(result.returncode, 0)
                        self.assertFalse(output.exists())
                    else:
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertEqual(output.read_text(), f"parallel={expected}\n")

    def test_main_runs_cannot_replace_each_other_and_prs_cancel_superseded_runs(self):
        for name in ("ci", "gui", "workflow-lint", "provider-config"):
            workflow = (ROOT / f".github/workflows/{name}.yml").read_text()
            concurrency = workflow.split("concurrency:\n", 1)[1].split("\njobs:", 1)[0]
            with self.subTest(workflow=name):
                self.assertIn("github.event.pull_request.number", concurrency)
                self.assertIn("format('run-{0}', github.run_id)", concurrency)
                self.assertIn(
                    "cancel-in-progress: ${{ github.event_name == 'pull_request' }}", concurrency
                )

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

    def test_workbench_source_changes_require_the_core_boundary_check(self):
        for path in (
            "services/workbench/src/desktop/core/project-connections.cjs",
            "services/workbench/src/new-owner.ts",
        ):
            with self.subTest(path=path):
                plan, reports = self.gate_fixture(paths=(path,))
                item = next(
                    item for item in plan["items"] if item["id"] == "workbench-core-boundary"
                )
                self.assertEqual(item["phase"], "commit")
                self.assertEqual(item["group"], "gui-portable")
                self.assertTrue(
                    any(
                        result["id"] == item["id"]
                        for report in reports
                        for result in report["results"]
                    )
                )

    def test_core_shards_cover_the_manifest_once_and_keep_native_requirements(self):
        plan, _ = self.gate_fixture()
        manifest = json.loads((ROOT / "clients/gui/scripts/test-manifest.json").read_text())
        shards = [item for item in plan["items"] if item["group"] == "core-contracts"]
        self.assertEqual(len(shards), 2)
        for platform in ("darwin", "linux"):
            required = [
                entry["script"]
                for entry in manifest
                if entry["layer"] != "e2e"
                and "core-binary" in entry["requires"]
                and platform in entry["platforms"]
            ]
            actual = [script for item in shards for script in item["expectedTests"][platform]]
            self.assertCountEqual(actual, required)
            self.assertEqual(len(actual), len(set(actual)))
        for item in shards:
            self.assertEqual(item["platforms"], ["darwin"])
            self.assertIn("native-runtime", item["requires"])
            self.assertIn("macos:desktop", item["dependsOn"])
        for group in ("gui-native-checks", "core-contracts", "smoke"):
            self.assertEqual(scope.CI_PLATFORMS[group], "darwin")

    def test_two_core_lanes_execute_every_contract_and_native_item_once(self):
        plan, _ = self.gate_fixture()
        selected = []
        for lane in scope.CORE_LANES:
            selected.extend(
                item["id"]
                for item in plan["items"]
                if item["group"] == lane["group"] and item["id"] == lane["item"]
            )
            if lane["native"]:
                selected.extend(
                    item["id"] for item in plan["items"] if item["group"] == "gui-native-checks"
                )
        required = [
            item["id"]
            for item in plan["items"]
            if item["group"] in {"core-contracts", "gui-native-checks"}
        ]
        self.assertCountEqual(selected, required)
        self.assertEqual(len(selected), len(set(selected)))
        workflow = (ROOT / ".github/workflows/gui.yml").read_text()
        self.assertIn("if: ${{ !cancelled() && matrix.native }}", workflow)
        self.assertIn("--output target/ci/checks/core-native-checks", workflow)

    def test_gate_rejects_missing_and_duplicate_core_shards(self):
        plan, reports = self.gate_fixture()
        required = "core-contracts:2"
        owner = next(
            report
            for report in reports
            if any(result["id"] == required for result in report["results"])
        )
        result = next(result for result in owner["results"] if result["id"] == required)
        owner["results"].remove(result)
        self.assertIn(
            "missing required check " + required,
            gate.validate(plan, reports, scope.WORKFLOW_GROUPS["gui"], ("run", "2")),
        )
        owner["results"].extend([result, copy.deepcopy(result)])
        self.assertIn(
            "duplicate required check " + required,
            gate.validate(plan, reports, scope.WORKFLOW_GROUPS["gui"], ("run", "2")),
        )

    def test_desktop_artifacts_include_all_consumed_modules_and_reject_missing_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outputs = [
                root / "clients/gui" / relative / "fixture.cjs"
                for relative in (
                    "packages/gen-ui/dist",
                    "packages/browser-automation/dist",
                    "packages/browser-data/dist",
                    "app/src/core/snapshots/build",
                )
            ]
            for output in outputs:
                output.parent.mkdir(parents=True)
                output.write_text("frozen module")
            item = {"id": "macos:desktop"}
            before = preflight.artifacts(item, root)
            self.assertEqual(len(before), len(outputs))
            outputs[0].write_text("different module")
            self.assertNotEqual(before, preflight.artifacts(item, root))
            outputs[0].unlink()
            with self.assertRaisesRegex(ValueError, "desktop build output is missing"):
                preflight.artifacts(item, root)

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
