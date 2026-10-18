from __future__ import annotations

import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

MODULE_PATH = Path(__file__).resolve().parents[1] / "perf.py"
sys.path.insert(0, str(MODULE_PATH.parent))
sys.path.insert(0, str(MODULE_PATH.parent))
SPEC = importlib.util.spec_from_file_location("areal_perf", MODULE_PATH)
assert SPEC and SPEC.loader
perf = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(perf)

AGENT_MODULE_PATH = Path(__file__).resolve().parents[1] / "runner" / "agent_entrypoint.py"
AGENT_SPEC = importlib.util.spec_from_file_location("areal_perf_agent", AGENT_MODULE_PATH)
assert AGENT_SPEC and AGENT_SPEC.loader
agent = importlib.util.module_from_spec(AGENT_SPEC)
AGENT_SPEC.loader.exec_module(agent)


GRADER_MODULE_PATH = Path(__file__).resolve().parents[1] / "runner" / "grader_entrypoint.py"
GRADER_SPEC = importlib.util.spec_from_file_location("areal_perf_grader", GRADER_MODULE_PATH)
assert GRADER_SPEC and GRADER_SPEC.loader
grader = importlib.util.module_from_spec(GRADER_SPEC)
GRADER_SPEC.loader.exec_module(grader)

PRO_GRADER_SPEC = importlib.util.spec_from_file_location(
    "pro_grader", AGENT_MODULE_PATH.with_name("pro_grader.py")
)
pro_grader = importlib.util.module_from_spec(PRO_GRADER_SPEC)
PRO_GRADER_SPEC.loader.exec_module(pro_grader)

PRO_TESTS_SPEC = importlib.util.spec_from_file_location(
    "pro_tests", AGENT_MODULE_PATH.with_name("pro_tests.py")
)
pro_tests = importlib.util.module_from_spec(PRO_TESTS_SPEC)
PRO_TESTS_SPEC.loader.exec_module(pro_tests)

CORE_SPEC = importlib.util.spec_from_file_location(
    "core_entrypoint", AGENT_MODULE_PATH.with_name("core_entrypoint.py")
)
core_adapter = importlib.util.module_from_spec(CORE_SPEC)
CORE_SPEC.loader.exec_module(core_adapter)


class LoopSmokeTests(unittest.TestCase):
    def test_trial_ownership_is_restored_on_cancel(self):
        with (
            tempfile.TemporaryDirectory() as temporary,
            mock.patch.object(perf, "run_command") as run,
        ):
            path = Path(temporary)
            owner = path.stat()
            with self.assertRaises(KeyboardInterrupt):
                with perf.trial_ownership("fixture-image", path):
                    raise KeyboardInterrupt()
            self.assertEqual(json.loads(run.call_args_list[0].args[0][-1]), [["/trial/0", 0, 0]])
            self.assertEqual(
                json.loads(run.call_args_list[1].args[0][-1]),
                [["/trial/0", owner.st_uid, owner.st_gid]],
            )

    def test_all_agents_run_without_network_or_host_secrets(self):
        with (
            mock.patch.object(perf, "run_command"),
            mock.patch.object(perf.subprocess, "run", return_value=mock.Mock(returncode=0)) as run,
        ):
            self.assertEqual(
                perf.dispatch(["smoke-loop", "--image", "fixture-image", "--python", "python3.11"]),
                0,
            )
        self.assertEqual(run.call_count, 3)
        for call, runner in zip(run.call_args_list, ("harness", "codex", "claudecode")):
            command = call.args[0]
            self.assertEqual(command[command.index("--network") + 1], "none")
            self.assertIn(f"AREAL_PERF_RUNNER={runner}", command)
            self.assertEqual(
                command[-3:], ["python3.11", "fixture-image", "/opt/areal-perf/loop_fixture.py"]
            )
            self.assertEqual(command.count("--env"), 1)

    def test_failure_stops_smoke_and_preserves_exit_code(self):
        with (
            mock.patch.object(perf, "run_command"),
            mock.patch.object(perf.subprocess, "run", return_value=mock.Mock(returncode=7)) as run,
        ):
            self.assertEqual(perf.dispatch(["smoke-loop"]), 7)
            run.assert_called_once()


class CoreAdapterTests(unittest.TestCase):
    def test_children_do_not_replace_root_status_and_their_usage_is_counted(self):
        root = {
            "id": "root",
            "turns": [
                {
                    "status": "failed",
                    "usage": {"inputTokens": 10, "cachedInputTokens": 2, "outputTokens": 4},
                    "items": [],
                }
            ],
        }
        child = {
            "id": "child",
            "parentThreadId": "root",
            "turns": [
                {
                    "status": "completed",
                    "usage": {"inputTokens": 20, "cachedInputTokens": 3, "outputTokens": 6},
                    "items": [{"type": "dynamicToolCall", "execution": {"durationMs": 9}}],
                }
            ],
        }
        for threads in [{"root": root, "child": child}, {"child": child, "root": root}]:
            actual, usage, executions, children = core_adapter.summarize_threads(threads)
            self.assertEqual(actual["turns"][0]["status"], "failed")
            self.assertEqual(usage, {"inputTokens": 30, "cachedInputTokens": 5, "outputTokens": 10})
            self.assertEqual(executions, [{"durationMs": 9}])
            self.assertEqual(children, ["child"])
        child["turns"][0]["usage"] = None
        self.assertIsNone(
            core_adapter.summarize_threads({"root": root, "child": child})[1]["inputTokens"]
        )

    def test_streaming_snapshots_emit_each_tool_and_final_message_once(self):
        turn = {
            "status": "inProgress",
            "items": [
                {"id": "tool", "type": "dynamicToolCall", "tool": "exec", "status": "inProgress"},
                {"id": "answer", "type": "agentMessage", "text": "partial"},
            ],
        }
        seen, completed = set(), set()
        with mock.patch.object(core_adapter, "emit") as emit:
            core_adapter.project({"turns": [turn]}, seen, completed)
            turn["items"][0].update(status="completed", success=False)
            core_adapter.project({"turns": [turn]}, seen, completed)
            turn["items"][1]["text"] = "final answer"
            turn["status"] = "completed"
            core_adapter.project({"turns": [turn]}, seen, completed)
            core_adapter.project({"turns": [turn]}, seen, completed)
        events = [call.args[0] for call in emit.call_args_list]
        self.assertEqual(
            [event["type"] for event in events], ["tool.started", "tool.failed", "item.completed"]
        )
        self.assertEqual(events[-1]["item"]["text"], "final answer")


class ProGraderTests(unittest.TestCase):
    def test_system_packages_reach_child_judges_without_user_path_override(self):
        with tempfile.TemporaryDirectory() as temporary:
            trusted = Path(temporary) / "system"
            untrusted = Path(temporary) / "user"
            trusted.mkdir()
            untrusted.mkdir()
            (trusted / "areal_judge_fixture_dependency.py").write_text("value = 42\n")
            (untrusted / "areal_judge_untrusted.py").write_text(
                "raise RuntimeError('user override loaded')\n"
            )
            with (
                mock.patch.object(pro_tests.sys, "prefix", "/system"),
                mock.patch.object(pro_tests.sys, "base_prefix", "/system"),
                mock.patch.object(pro_tests.sys, "path", list(sys.path)),
                mock.patch.object(pro_tests.site, "getsitepackages", return_value=[str(trusted)]),
                mock.patch.dict(
                    os.environ, {"PYTHONPATH": str(untrusted), "PYTHONNOUSERSITE": "1"}
                ),
            ):
                pro_tests.restore_system_site_packages()
                check = "import importlib.util; import areal_judge_fixture_dependency as d; assert d.value == 42; assert importlib.util.find_spec('areal_judge_untrusted') is None"
                child = perf.subprocess.run(
                    [sys.executable, "-S", "-c", check], capture_output=True, text=True, check=False
                )
                self.assertEqual(child.returncode, 0, child.stderr)

    def test_failing_subtests_count_one_method_and_skips_do_not_pass(self):
        class Candidates(unittest.TestCase):
            def test_many_failures(self):
                for number in range(3):
                    with self.subTest(number=number):
                        self.fail("candidate failed")

            def test_skip(self):
                with self.subTest():
                    self.skipTest("unavailable")

            def test_ok(self):
                self.assertTrue(True)

        result = unittest.TextTestRunner(
            stream=io.StringIO(), resultclass=pro_tests.AcceptanceResult
        ).run(unittest.defaultTestLoader.loadTestsFromTestCase(Candidates))
        self.assertEqual(result.testsRun, 3)
        self.assertEqual(
            sorted(record["status"] for record in result.records.values()),
            ["failed", "passed", "skipped"],
        )
        self.assertEqual(
            len(
                next(record for record in result.records.values() if record["status"] == "failed")[
                    "details"
                ]
            ),
            3,
        )

    def summary(self, **counts):
        return {"results": {"summary": counts}}

    def test_strict_grade_keeps_partial_progress_without_overriding_failures(self):
        scored = pro_grader.score_summary(self.summary(tests=4, passed=3, failed=1), 0)
        self.assertEqual(scored["score"], 0)
        self.assertEqual(scored["metrics"]["test_pass_rate"], 0.75)
        self.assertEqual(
            pro_grader.score_summary(self.summary(tests=4, passed=4, failed=0), 0)["score"], 1
        )
        self.assertEqual(
            pro_grader.score_summary(self.summary(tests=4, passed=3, failed=0, skipped=1), 0)[
                "score"
            ],
            0,
        )

    def test_broken_or_empty_grader_is_not_a_valid_zero_score(self):
        for counts in (
            {"tests": 0},
            {"tests": 2, "passed": 1},
            {"tests": True, "passed": 1},
            {"tests": 1, "passed": -1, "failed": 2},
        ):
            with self.assertRaises(ValueError):
                pro_grader.score_summary(self.summary(**counts), 0)
        with self.assertRaises(ValueError):
            pro_grader.score_summary(self.summary(tests=1, passed=1), 70)


class TaskTests(unittest.TestCase):
    def test_pro_subset_is_explicit_and_rejects_invalid_selection(self):
        all_tasks = perf.resolve_tasks("pro")
        selected = [all_tasks[3].name, all_tasks[0].name]
        self.assertEqual(perf.resolve_tasks("pro", selected), [all_tasks[0], all_tasks[3]])
        for suite, cases in [
            ("lite", selected),
            ("pro", ["missing"]),
            ("pro", [selected[0], selected[0]]),
        ]:
            with self.subTest(suite=suite, cases=cases), self.assertRaises(perf.PerfError):
                perf.resolve_tasks(suite, cases)

    def test_lite_alias_and_pinned_pro_suite(self) -> None:
        self.assertEqual(perf.resolve_tasks("lite"), [perf.resolve_task("python-fix-001")])
        paths = perf.resolve_tasks("pro")
        self.assertEqual(len(paths), 20)
        benchmark = json.loads((perf.PRO_ROOT / "benchmark.json").read_text())
        for path, entry in zip(paths, benchmark["spec"]["env_refs"], strict=True):
            task = perf.load_task(path)
            source = json.loads((path / "env.json").read_text())
            self.assertEqual(source["version"], entry["env_ref"]["version"])
            self.assertEqual(task["id"], entry["env_ref"]["key"])
            self.assertTrue((path / "oracle" / "test.sh").is_file())
            self.assertEqual(task["environment"]["image"], f"areal-perf-env:{task['id']}")
            context = perf.environment_context(path, task)
            self.assertTrue((context / "Dockerfile").is_file())
            self.assertFalse((context / "oracle").exists())
            with tempfile.TemporaryDirectory() as temporary:
                staged = Path(temporary) / "task"
                perf.stage_agent_task(path, task, staged)
                self.assertEqual({p.name for p in staged.iterdir()}, {"task.toml", "prompt.md"})

    def test_pro_rejects_mismatched_source_image(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            import shutil

            root = Path(temporary) / "task"
            shutil.copytree(perf.resolve_tasks("pro")[0], root)
            path = root / "env.json"
            path.write_text(path.read_text().replace(":91ac090", ":different"))
            with self.assertRaisesRegex(perf.PerfError, "pinned EnvArena source"):
                perf.load_task(root)

    def test_environment_build_context_excludes_grader_and_external_symlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ["Dockerfile", "origin.json"]:
                (root / name).touch()
            task = {"environment": {"build": "."}, "grader": {"path": "oracle"}}
            with self.assertRaisesRegex(perf.PerfError, "exclude the grader"):
                perf.environment_context(root, task)
            context = root / "environment"
            context.mkdir()
            for name in ["Dockerfile", "origin.json"]:
                (root / name).rename(context / name)
            task["environment"]["build"] = "environment"
            (context / "leak").symlink_to(root / "oracle")
            with self.assertRaisesRegex(perf.PerfError, "symlink escapes"):
                perf.environment_context(root, task)

    def test_environment_cache_tracks_inputs_and_executable_modes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "input.py"
            target.write_text("old")
            before = perf.environment_source_hash(root)
            target.write_text("new")
            changed = perf.environment_source_hash(root)
            self.assertNotEqual(before, changed)
            target.chmod(0o755)
            self.assertNotEqual(changed, perf.environment_source_hash(root))

    def test_environment_build_uses_isolated_context_and_does_not_pull_source(self):
        task_dir = perf.resolve_tasks("pro")[0]
        task = perf.load_task(task_dir)
        context = perf.environment_context(task_dir, task)
        fingerprint = perf.environment_source_hash(context)
        identity = {"architecture": "amd64", "environment_sha256": fingerprint}
        with (
            mock.patch.object(perf, "run_command", return_value=mock.Mock(returncode=1)) as run,
            mock.patch.object(
                perf.subprocess, "run", return_value=mock.Mock(returncode=0)
            ) as build,
            mock.patch.object(perf, "image_provenance", return_value=identity),
        ):
            result = perf.prepare_base_environment(task_dir, task)
        self.assertEqual(result["build_sha256"], fingerprint)
        self.assertEqual(build.call_args.args[0][-1], str(context))
        self.assertEqual(run.call_args.args[0][:3], ["docker", "image", "inspect"])
        self.assertNotIn("antgroup", " ".join(build.call_args.args[0]))

    def test_environment_cache_rejects_wrong_platform_or_label(self):
        task_dir = perf.resolve_tasks("pro")[0]
        task = perf.load_task(task_dir)
        fingerprint = perf.environment_source_hash(perf.environment_context(task_dir, task))
        for arch, label in [("arm64", fingerprint), ("amd64", "wrong")]:
            with (
                self.subTest(arch=arch, label=label),
                mock.patch.object(perf, "run_command", return_value=mock.Mock(returncode=0)),
                mock.patch.object(
                    perf,
                    "image_provenance",
                    return_value={
                        "architecture": arch,
                        "environment_sha256": label,
                    },
                ),
                self.assertRaisesRegex(perf.PerfError, "identity mismatch"),
            ):
                perf.prepare_base_environment(task_dir, task)

    def test_derived_environment_rechecks_runtime_without_exposing_oracle(self):
        directory = perf.resolve_task("pro/tbpc002013-migrate-support-case-rollup")
        task = perf.load_task(directory)
        with mock.patch.object(perf, "run_command") as run:
            perf.verify_environment_runtime(directory, task, "derived:local")
        command = run.call_args.args[0]
        self.assertIn("--read-only", command)
        self.assertEqual(command[command.index("--network") + 1], "none")
        self.assertIn("runtime.sha256", " ".join(command))
        self.assertNotIn("oracle", " ".join(command))
        self.assertIn("derived:local", command)

    def test_repository_fixture_is_valid(self) -> None:
        task_dir = perf.CASES_ROOT / "python-fix-001"
        task = perf.load_task(task_dir)
        self.assertEqual(task["id"], "python-fix-001")

    def test_rejects_workspace_escape(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "prompt.md").write_text("task")
            (root / "task.toml").write_text(
                "schema_version=1\nid='bad'\n[workspace]\npath='..'\n[prompt]\npath='prompt.md'\n"
                "[grader]\ncommand=['true']\n"
            )
            with self.assertRaisesRegex(perf.PerfError, "workspace"):
                perf.load_task(root)

    def test_hash_tree_changes_with_content(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "a"
            target.write_text("one")
            before = perf.hash_tree(root)
            target.write_text("two")
            self.assertNotEqual(before, perf.hash_tree(root))

    def test_agent_staging_excludes_grader(self) -> None:
        task_dir = perf.CASES_ROOT / "python-fix-001"
        task = perf.load_task(task_dir)
        with tempfile.TemporaryDirectory() as temporary:
            staged = Path(temporary) / "task"
            perf.stage_agent_task(task_dir, task, staged)
            self.assertTrue((staged / "prompt.md").is_file())
            self.assertTrue((staged / "fixture_agent.py").is_file())
            self.assertFalse((staged / "grader").exists())

    def test_runner_log_redaction_uses_passed_environment_names(self) -> None:
        environment = {
            "AREAL_PERF_REDACT_ENV_NAMES": "OPENAI_API_KEY,OTHER_VALUE",
            "OPENAI_API_KEY": "secret-value",
            "OTHER_VALUE": "visible-value",
        }
        redacted = agent.redact("secret-value and visible-value", environment)
        self.assertEqual(redacted, "[REDACTED] and [REDACTED]")

    @mock.patch.object(perf.subprocess, "run")
    def test_runtime_smoke_relaxes_outer_namespace_restrictions(self, run: mock.Mock) -> None:
        run.return_value.returncode = 0

        def smoke(command, **_):
            binding = next(part for part in command if part.endswith(",dst=/workspace"))
            workspace = Path(binding.split("src=", 1)[1].split(",dst=", 1)[0])
            self.assertEqual((workspace / "existing").read_text(), "original\n")
            (workspace / "existing").write_text("patched\n")
            return mock.Mock(returncode=0)

        run.side_effect = smoke
        with mock.patch.object(perf, "run_command"):
            self.assertEqual(perf.smoke_runtime_profile("runner:test"), 0)
        command = run.call_args.args[0]
        self.assertIn("seccomp=unconfined", command)
        self.assertIn("systempaths=unconfined", command)
        self.assertIn("apparmor=unconfined", command)
        self.assertNotIn("--privileged", command)
        self.assertNotIn("--cap-add", command)
        self.assertEqual(command[-2:], ["runner:test", "/opt/areal-perf/runtime_smoke.py"])

    def test_codex_activity_is_counted_once_per_tool_item(self) -> None:
        activity = {
            "turns": 0,
            "assistant_turns": 0,
            "tool_calls": 0,
            "tool_successes": 0,
            "tool_failures": 0,
        }
        seen: set[str] = set()
        completed: set[str] = set()
        events = [
            {"type": "turn.started"},
            {"type": "item.completed", "item": {"id": "message", "type": "agent_message"}},
            {"type": "item.started", "item": {"id": "tool", "type": "command_execution"}},
            {
                "type": "item.completed",
                "item": {
                    "id": "tool",
                    "type": "command_execution",
                    "status": "completed",
                    "exit_code": 0,
                },
            },
        ]
        for event in events:
            agent.record_activity(event, activity, seen, completed)
        self.assertEqual(
            activity,
            {
                "turns": 1,
                "assistant_turns": 1,
                "tool_calls": 1,
                "tool_successes": 1,
                "tool_failures": 0,
            },
        )


class ModelConfigTests(unittest.TestCase):
    def write_config(self, root: Path, extra: str = "") -> Path:
        path = root / "model.toml"
        path.write_text(
            "schema_version = 1\n"
            "model = 'model-x'\n"
            "base_url = 'http://127.0.0.1:9000/v1'\n"
            "api_key_env = 'TEST_MODEL_KEY'\n"
            f"{extra}"
        )
        return path

    def test_responses_is_the_default_and_secret_is_not_loaded(self) -> None:
        with (
            tempfile.TemporaryDirectory() as temporary,
            mock.patch.dict(os.environ, {"TEST_MODEL_KEY": "secret-value"}),
        ):
            config = perf.load_model_config(self.write_config(Path(temporary)))
        self.assertEqual(config["protocol"], "responses")
        self.assertEqual(config["api_key_env"], "TEST_MODEL_KEY")
        self.assertNotIn("secret-value", json.dumps(config))

    def test_protocols_map_to_llm_rosetta_provider_types(self) -> None:
        for protocol, provider_type in {
            "completions": "openai_chat",
            "responses": "openai_responses",
            "anthropic": "anthropic",
        }.items():
            with (
                self.subTest(protocol=protocol),
                tempfile.TemporaryDirectory() as temporary,
                mock.patch.dict(os.environ, {"TEST_MODEL_KEY": "secret-value"}),
            ):
                config = perf.load_model_config(
                    self.write_config(Path(temporary), f"protocol = '{protocol}'\n")
                )
                gateway = perf.gateway_config(config)
                self.assertEqual(gateway["providers"]["upstream"]["type"], provider_type)
                self.assertEqual(gateway["providers"]["upstream"]["api_key"], "${TEST_MODEL_KEY}")

    def test_localhost_is_reachable_from_the_gateway_container(self) -> None:
        self.assertEqual(
            perf.docker_upstream_url("http://localhost:9000/v1"),
            "http://host.docker.internal:9000/v1",
        )

    def test_explicit_xhigh_is_not_silently_clamped_by_gateway(self) -> None:
        with (
            tempfile.TemporaryDirectory() as temporary,
            mock.patch.dict(os.environ, {"TEST_MODEL_KEY": "secret-value"}),
        ):
            config = perf.load_model_config(
                self.write_config(Path(temporary), "[parameters]\nreasoning_effort='xhigh'\n")
            )
        entry = perf.gateway_config(config)["models"]["model-x"]
        self.assertEqual(entry["reasoning_override"]["effort_range"], ["minimal", "xhigh"])

    def test_invalid_parameter_is_rejected(self) -> None:
        with (
            tempfile.TemporaryDirectory() as temporary,
            mock.patch.dict(os.environ, {"TEST_MODEL_KEY": "secret-value"}),
        ):
            path = self.write_config(Path(temporary), "[parameters]\ntemperature = 0.5\n")
            with self.assertRaisesRegex(perf.PerfError, "unsupported model parameters"):
                perf.load_model_config(path)

    def test_runner_upstream_keeps_shared_model_and_credential(self) -> None:
        with (
            tempfile.TemporaryDirectory() as temporary,
            mock.patch.dict(os.environ, {"TEST_MODEL_KEY": "secret-value"}),
        ):
            config = perf.load_model_config(
                self.write_config(
                    Path(temporary),
                    "[runner_upstreams.claudecode]\nbase_url='https://example.com/api/anthropic'\nprotocol='anthropic'\n",
                )
            )
        selected = {**config, **config["runner_upstreams"]["claudecode"]}
        gateway = perf.gateway_config(selected)
        self.assertEqual(gateway["providers"]["upstream"]["type"], "anthropic")
        self.assertEqual(gateway["providers"]["upstream"]["api_key"], "${TEST_MODEL_KEY}")
        self.assertEqual(set(gateway["models"]), {"model-x"})

    def test_runner_upstream_rejects_credentials_and_model_overrides(self) -> None:
        for extra in (
            "base_url='https://secret@example.com'\nprotocol='anthropic'",
            "base_url='https://example.com'\nprotocol='anthropic'\nmodel='different'",
            "base_url=42\nprotocol='anthropic'",
        ):
            with (
                self.subTest(extra=extra),
                tempfile.TemporaryDirectory() as temporary,
                mock.patch.dict(os.environ, {"TEST_MODEL_KEY": "secret-value"}),
            ):
                with self.assertRaises(perf.PerfError):
                    perf.load_model_config(
                        self.write_config(
                            Path(temporary), "[runner_upstreams.claudecode]\n" + extra
                        )
                    )


class RunnerConfigTests(unittest.TestCase):
    def test_claudecode_uses_messages_gateway_and_pinned_model(self) -> None:
        environment = {
            "AREAL_PERF_MODEL": "model-x",
            "AREAL_PERF_GATEWAY_URL": "http://gateway:8765",
            "AREAL_PERF_MODEL_PARAMETERS": '{"reasoning_effort":"high"}',
        }
        command = agent.runner_command({}, "claudecode", "prompt", environment)
        self.assertEqual(command[0], "claude")
        self.assertIn("stream-json", command)
        self.assertEqual(command[-2:], ["--effort", "high"])
        self.assertEqual(environment["ANTHROPIC_BASE_URL"], "http://gateway:8765")
        for name in (
            "ANTHROPIC_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
        ):
            self.assertEqual(environment[name], "model-x")

    def test_claudecode_stream_counts_tools_cache_and_error_result(self) -> None:
        events = [
            {"type": "system", "subtype": "init"},
            {
                "type": "assistant",
                "message": {"id": "msg-1", "content": [{"type": "text", "text": "working"}]},
            },
            {
                "type": "assistant",
                "message": {
                    "id": "msg-1",
                    "content": [{"type": "tool_use", "id": "tool-1", "name": "Bash"}],
                },
            },
            {
                "type": "user",
                "message": {
                    "content": [{"type": "tool_result", "tool_use_id": "tool-1", "is_error": False}]
                },
            },
            {
                "type": "assistant",
                "message": {
                    "id": "msg-2",
                    "content": [{"type": "tool_use", "id": "tool-2", "name": "Bash"}],
                },
            },
            {
                "type": "user",
                "message": {
                    "content": [{"type": "tool_result", "tool_use_id": "tool-2", "is_error": True}]
                },
            },
            {
                "type": "result",
                "subtype": "error_max_turns",
                "is_error": True,
                "usage": {
                    "input_tokens": 10,
                    "cache_creation_input_tokens": 5,
                    "cache_read_input_tokens": 20,
                    "output_tokens": 7,
                },
            },
        ]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = root / "task"
            task.mkdir()
            (task / "task.toml").write_text("schema_version=1\n[prompt]\npath='prompt.md'\n")
            (task / "prompt.md").write_text("fix this")
            child = root / "child.py"
            child.write_text(
                "import sys\nsys.stdin.read()\n"
                + "\n".join(f"print({json.dumps(json.dumps(event))})" for event in events)
            )
            with (
                mock.patch.object(agent, "TASK_ROOT", task),
                mock.patch.object(agent, "WORKSPACE", root),
                mock.patch.object(agent, "OUTPUT", root / "output"),
                mock.patch.dict(os.environ, {"AREAL_PERF_RUNNER": "claudecode"}),
                mock.patch.object(
                    agent, "runner_command", return_value=[sys.executable, str(child)]
                ),
            ):
                self.assertEqual(agent.main(), 1)
            result = json.loads((root / "output" / "agent-result.json").read_text())
        self.assertTrue(result["terminal_event_seen"])
        self.assertEqual(result["termination_reason"], "claude_error_result")
        self.assertEqual(
            result["usage"], {"input_tokens": 35, "cached_input_tokens": 20, "output_tokens": 7}
        )
        self.assertEqual(
            result["activity"],
            {
                "turns": 1,
                "assistant_turns": 2,
                "tool_calls": 2,
                "tool_successes": 1,
                "tool_failures": 1,
            },
        )

    def test_codex_uses_the_local_responses_gateway(self) -> None:
        environment = {
            "AREAL_PERF_MODEL": "model-x",
            "AREAL_PERF_GATEWAY_URL": "http://gateway:8765",
            "AREAL_PERF_MODEL_PARAMETERS": '{"reasoning_effort":"high"}',
        }
        command = agent.runner_command({"runners": {"codex": {}}}, "codex", "prompt", environment)
        joined = " ".join(command)
        self.assertIn('model_providers.areal_perf.name="AReaL-Harness perf gateway"', joined)
        self.assertIn('model_providers.areal_perf.wire_api="responses"', joined)
        self.assertIn('model_reasoning_effort="high"', joined)
        self.assertNotIn("login", joined)
        self.assertEqual(environment["AREAL_PERF_GATEWAY_API_KEY"], "areal-local-perf")

    def test_harness_uses_production_core_adapter(self) -> None:
        environment = {
            "AREAL_PERF_MODEL": "model-x",
            "AREAL_PERF_GATEWAY_URL": "http://gateway:8765",
            "AREAL_PERF_MODEL_PARAMETERS": '{"verbosity":"low"}',
        }
        command = agent.runner_command(
            perf.load_task(perf.REPO_ROOT / "tests/perf/cases/python-fix-001"),
            "harness",
            "prompt",
            environment,
        )
        self.assertEqual(command, ["python3", "/opt/areal-perf/core_entrypoint.py"])
        self.assertEqual(
            environment["AREAL_MODEL_ENDPOINT"], "http://gateway:8765/v1/chat/completions"
        )
        self.assertEqual(environment["AREAL_MODEL_PARAMETERS"], '{"verbosity":"low"}')


class SourceIdentityTests(unittest.TestCase):
    def test_generated_files_do_not_change_identity_but_source_edits_do(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in (
                ".dockerignore",
                "Cargo.toml",
                "Cargo.lock",
                "scripts/launch.py",
                "tests/e2e/docker/Dockerfile",
                "tests/perf/perf.py",
                "tests/perf/runner/runtime_client.py",
                "core/engine/src/lib.rs",
                "runtime/sdk-typescript/package-lock.json",
                "clients/web/app.js",
            ):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("original")
            with mock.patch.object(perf, "REPO_ROOT", root):
                initial = perf.runner_source_hash()
                for name in (
                    "core/sdk-typescript/node_modules/pkg/index.js",
                    "runtime/sdk-typescript/dist/index.js",
                    "tests/perf/runner/__pycache__/client.pyc",
                    "core/.venv/pyvenv.cfg",
                    "clients/web/.DS_Store",
                    "runtime/scratch.tmp",
                ):
                    path = root / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("generated")
                self.assertEqual(perf.runner_source_hash(), initial)
                source = root / "core/engine/src/lib.rs"
                source.write_text("edited")
                self.assertNotEqual(perf.runner_source_hash(), initial)
                source.write_text("original")
                lockfile = root / "runtime/sdk-typescript/package-lock.json"
                lockfile.write_text("updated dependency")
                self.assertNotEqual(perf.runner_source_hash(), initial)
                lockfile.write_text("original")
                (root / "core/engine/src/new.rs").write_text("untracked source")
                self.assertNotEqual(perf.runner_source_hash(), initial)


class ImageTests(unittest.TestCase):
    def test_fail_fast_keeps_failed_trial_and_does_not_dispatch_later_trials(self):
        image = {"reference": "test-image", "architecture": "amd64"}

        def trial(_directory, task, runner, sequence, *_args):
            value = ReportTests().trial(runner, False, 100)
            value.update(task_id=task["id"], sequence=sequence)
            return value

        with (
            tempfile.TemporaryDirectory() as temporary,
            mock.patch.object(perf, "ensure_runner_image"),
            mock.patch.object(perf, "image_provenance", return_value=image),
            mock.patch.object(perf, "run_trial", side_effect=trial) as run_trial,
            mock.patch.object(sys, "stdout", new_callable=io.StringIO),
        ):
            args = perf.parser().parse_args(
                [
                    "run",
                    "--task",
                    "lite",
                    "--runner",
                    "fixture",
                    "--repeat",
                    "3",
                    "--fail-fast",
                    "--output",
                    temporary,
                ]
            )
            self.assertEqual(perf.execute(args, args.runner), 1)
            run_trial.assert_called_once()
            saved = json.loads(next(Path(temporary).glob("*/*/run.json")).read_text())
            self.assertEqual(saved["status"], "paused")
            self.assertEqual(saved["stop_reason"], "trial_failed")
            self.assertEqual(len(saved["trials"]), 1)
            self.assertEqual(saved["planned_trials"], 3)

    def test_resume_recovers_committed_trial_and_preserves_interrupted_artifacts(self):
        image = {"reference": "mutable-tag", "id": "sha256:frozen", "architecture": "amd64"}
        model = {
            "model": "fixture",
            "parameters": {},
            "protocol": "responses",
            "base_url": "http://fixture",
            "api_key_env": "TEST_KEY",
        }
        cases = perf.resolve_tasks("pro")[:2]
        invoked = []
        stop = True

        def trial(directory, task, runner, sequence, run_dir, image_id, *_):
            nonlocal stop
            self.assertEqual(image_id, "sha256:frozen")
            self.assertTrue(directory.is_relative_to(run_dir / "tasks"))
            self.assertTrue((run_dir / "runner/agent_entrypoint.py").exists())
            invoked.append(sequence)
            value = ReportTests().trial(runner, True, 100)
            value.update(sequence=sequence, task_id=task["id"])
            value["agent"]["status"] = "completed"
            trial_dir = run_dir / "trials" / f"{sequence:03d}-{runner}"
            trial_dir.mkdir(parents=True)
            perf.atomic_json(trial_dir / "trial.json", value)
            if sequence == 2 and stop:
                stop = False
                raise KeyboardInterrupt()
            return value

        with (
            tempfile.TemporaryDirectory() as temporary,
            mock.patch.object(perf, "resolve_tasks", return_value=cases),
            mock.patch.object(perf, "load_model_config", return_value=model),
            mock.patch.object(perf, "ensure_runner_image"),
            mock.patch.object(perf, "image_provenance", return_value=image),
            mock.patch.object(perf, "prepare_environment_image", return_value=image),
            mock.patch.object(
                perf, "start_gateway", return_value={"network": "test", "url": "http://gateway"}
            ),
            mock.patch.object(perf, "stop_gateway"),
            mock.patch.object(perf, "check_model_route"),
            mock.patch.object(perf, "run_trial", side_effect=trial),
            mock.patch.object(sys, "stdout", new_callable=io.StringIO),
            mock.patch.object(sys, "stderr", new_callable=io.StringIO),
        ):
            args = perf.parser().parse_args(
                [
                    "run",
                    "--task",
                    "pro",
                    "--runner",
                    "harness",
                    "--runner",
                    "codex",
                    "--runner",
                    "claudecode",
                    "--repeat",
                    "1",
                    "--seed",
                    "163",
                    "--output",
                    temporary,
                ]
            )
            with self.assertRaises(KeyboardInterrupt):
                perf.execute(args, args.runner)
            run_dir = next(Path(temporary).glob("pro/*"))
            saved = json.loads((run_dir / "run.json").read_text())
            self.assertEqual(saved["status"], "paused")
            self.assertEqual(len(saved["trials"]), 1)
            runner = saved["schedule"][2]["runner"]
            orphan = run_dir / "trials" / f"003-{runner}"
            orphan.mkdir()
            (orphan / "partial.log").write_text("retain this evidence")
            args.resume_run = run_dir
            self.assertEqual(perf.execute(args, args.runner), 0)
            saved = json.loads((run_dir / "run.json").read_text())
            self.assertEqual(saved["status"], "complete")
            self.assertEqual(len(saved["trials"]), 6)
            self.assertEqual(invoked, [1, 2, 3, 4, 5, 6])
            self.assertEqual(
                (run_dir / saved["interrupted_attempts"][0] / "partial.log").read_text(),
                "retain this evidence",
            )
            (run_dir / "runner/agent_entrypoint.py").write_text("changed")
            with self.assertRaisesRegex(perf.PerfError, "snapshot is missing or has changed"):
                perf.execute(args, args.runner)

    def test_pro_schedules_each_case_for_each_runner_and_repeat(self) -> None:
        image = {"reference": "test-image", "architecture": "amd64"}
        model = {
            "model": "test-model",
            "parameters": {},
            "protocol": "anthropic",
            "base_url": "http://model",
            "api_key_env": "TEST_KEY",
        }

        def trial(_directory, task, runner, sequence, *_args):
            value = ReportTests().trial(runner, True, 100)
            value["task_id"] = task["id"]
            value["sequence"] = sequence
            value["agent"]["status"] = "completed"
            return value

        with (
            tempfile.TemporaryDirectory() as temporary,
            mock.patch.object(perf, "load_model_config", return_value=model),
            mock.patch.object(perf, "ensure_runner_image"),
            mock.patch.object(perf, "image_provenance", return_value=image),
            mock.patch.object(perf, "prepare_environment_image", return_value=image),
            mock.patch.object(
                perf, "start_gateway", return_value={"network": "test", "url": "http://gateway"}
            ),
            mock.patch.object(perf, "stop_gateway"),
            mock.patch.object(perf, "check_model_route"),
            mock.patch.object(perf, "run_trial", side_effect=trial),
            mock.patch.object(sys, "stdout", new_callable=io.StringIO),
            mock.patch.object(sys, "stderr", new_callable=io.StringIO),
        ):
            args = perf.parser().parse_args(
                [
                    "run",
                    "--task",
                    "pro",
                    "--runner",
                    "codex",
                    "--runner",
                    "claudecode",
                    "--repeat",
                    "2",
                    "--seed",
                    "123",
                    "--output",
                    temporary,
                ]
            )
            self.assertEqual(perf.execute(args, args.runner), 0)
            report = json.loads(next(Path(temporary).glob("pro/*/report.json")).read_text())
        self.assertEqual(len(report["trials"]), 80)
        self.assertEqual(len(report["per_case"]), 20)
        for case in report["per_case"].values():
            for runner in ("codex", "claudecode"):
                self.assertEqual(case[runner]["attempts"], 2)
                self.assertEqual(case[runner]["score_mean"], 1)

    def test_pro_injects_oracle_after_agent_and_reuses_then_removes_container(self) -> None:
        task_dir = perf.resolve_tasks("pro")[0]
        task = perf.load_task(task_dir)
        calls = []
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)

            def command(argv, **kwargs):
                calls.append(argv)
                output = root / "trials/001-claudecode/output"
                if argv[-1] == "/opt/areal-perf/agent_entrypoint.py":
                    (output / "agent-result.json").write_text(
                        json.dumps(
                            {
                                "status": "completed",
                                "execution_started": True,
                                "terminal_event_seen": True,
                            }
                        )
                    )
                if argv[-1] == "/opt/areal-perf/pro_grader.py":
                    (output / "grader-result.json").write_text('{"status":"passed","score":1}')
                return mock.Mock(returncode=0, stdout="", stderr="")

            with (
                mock.patch.object(perf, "run_command", side_effect=command),
                mock.patch.object(perf, "container_state", return_value={}),
            ):
                trial = perf.run_environment_trial(
                    task_dir,
                    task,
                    "claudecode",
                    1,
                    root,
                    "image",
                    [],
                    {},
                    {"model": "model-x", "parameters": {}},
                    {"url": "http://gateway", "network": "net"},
                )
        self.assertEqual(trial["status"], "passed")
        self.assertNotIn("oracle", " ".join(calls[0]))
        agent_index = next(
            i for i, cmd in enumerate(calls) if cmd[-1] == "/opt/areal-perf/agent_entrypoint.py"
        )
        oracle_index = next(
            i
            for i, cmd in enumerate(calls)
            if cmd[:2] == ["docker", "cp"] and "/oracle/." in " ".join(cmd)
        )
        grader_index = next(
            i for i, cmd in enumerate(calls) if cmd[-1] == "/opt/areal-perf/pro_grader.py"
        )
        self.assertLess(agent_index, oracle_index)
        self.assertLess(oracle_index, grader_index)
        self.assertEqual(calls[agent_index][2], calls[grader_index][4])
        self.assertEqual(calls[-1][:3], ["docker", "rm", "--force"])

    def test_runner_sources_include_runtime_smoke_client(self) -> None:
        self.assertIn(
            perf.REPO_ROOT / "tests" / "perf" / "runner" / "runtime_client.py",
            perf.runner_source_paths(),
        )

    def test_runner_source_hash_is_stable_sha256(self) -> None:
        first = perf.runner_source_hash()
        self.assertEqual(first, perf.runner_source_hash())
        self.assertRegex(first, r"^[0-9a-f]{64}$")

    def test_default_image_is_rebuilt_when_source_hash_is_stale(self) -> None:
        inspected = mock.Mock(
            returncode=0,
            stdout=json.dumps(
                [
                    {
                        "Config": {
                            "Labels": {
                                "io.areal.perf.source-sha256": "stale",
                            }
                        }
                    }
                ]
            ),
        )
        with (
            mock.patch.object(perf, "run_command", return_value=inspected),
            mock.patch.object(perf, "build_runner_image", return_value=0) as build,
        ):
            perf.ensure_runner_image(perf.DEFAULT_IMAGE)
        build.assert_called_once()


class ReportTests(unittest.TestCase):
    def test_pro_mean_keeps_failed_and_unscored_cases_in_denominator(self) -> None:
        good = self.trial("claudecode", True, 100)
        good["agent"]["status"] = "completed"
        infrastructure = self.trial("claudecode", False, 1)
        infrastructure["agent"]["execution_started"] = False
        infrastructure["evaluation"] = {"valid": False, "score": None}
        timeout = self.trial("claudecode", False, 10)
        timeout["agent"]["status"] = "timeout"
        timeout["evaluation"]["score"] = 1.0
        summary = perf.aggregate([good, infrastructure, timeout], failed_as_zero=True)["claudecode"]
        self.assertAlmostEqual(summary["score_mean"], 1 / 3)
        self.assertEqual(summary["scored"], 2)
        self.assertEqual(summary["infrastructure_failures"], 1)
        self.assertEqual(summary["agent_wall_ms"]["median"], 100)

    def trial(self, runner: str, passed: bool, duration: float) -> dict:
        return {
            "schema_version": 1,
            "sequence": 1,
            "runner": runner,
            "status": "passed" if passed else "failed",
            "total_duration_ms": duration + 10,
            "agent": {
                "execution_started": True,
                "duration_ms": duration,
                "termination_reason": None if passed else "runner_exit",
                "resources": {"cpu_usec": duration * 500, "memory_peak_bytes": 1024 * 1024},
                "usage": {"input_tokens": 10, "cached_input_tokens": 2, "output_tokens": 3},
                "activity": {
                    "turns": 1,
                    "assistant_turns": 2,
                    "tool_calls": 3,
                    "tool_successes": 2,
                    "tool_failures": 1,
                },
                "milestones_ms": {"first_output": 10, "first_tool": 20},
            },
            "grader": {
                "status": "passed" if passed else "failed",
                "duration_ms": 5,
                "score": 1.0 if passed else 0.0,
            },
            "evaluation": {"valid": True, "score": 1.0 if passed else 0.0, "metrics": {}},
        }

    def test_failed_trials_do_not_reduce_latency(self) -> None:
        summary = perf.aggregate(
            [
                self.trial("harness", True, 100),
                self.trial("harness", True, 300),
                self.trial("harness", False, 1),
            ]
        )["harness"]
        self.assertEqual(summary["attempts"], 3)
        self.assertEqual(summary["passed"], 2)
        self.assertEqual(summary["agent_wall_ms"]["median"], 200)
        self.assertEqual(summary["agent_wall_ms"]["p95"], 300)
        self.assertEqual(summary["score_mean"], 2 / 3)
        self.assertAlmostEqual(summary["tool_success_rate"], 2 / 3)
        self.assertEqual(summary["token_efficiency"]["uncached_input_tokens_median"], 8)

    def test_infrastructure_failure_is_not_scored(self) -> None:
        invalid = self.trial("harness", False, 1)
        invalid["agent"]["execution_started"] = False
        invalid["evaluation"] = {"valid": False, "score": None, "metrics": {}}
        summary = perf.aggregate([invalid])["harness"]
        self.assertEqual(summary["scored"], 0)
        self.assertEqual(summary["infrastructure_failures"], 1)

    def test_paired_comparison_excludes_unmatched_successes_and_missing_usage(self):
        rows = []
        for task, runner, passed, duration in [
            ("common", "harness", True, 80),
            ("common", "codex", True, 100),
            ("easy", "harness", True, 1),
            ("easy", "codex", False, 300),
            ("hard", "codex", True, 900),
        ]:
            trial = self.trial(runner, passed, duration)
            trial["task_id"] = task
            rows.append(trial)
        rows[0]["agent"]["usage"] = {}
        comparison = perf.paired_comparisons(rows)["codex"]
        self.assertEqual(comparison["agent_wall_ms"]["matched_tasks"], 1)
        self.assertEqual(comparison["agent_wall_ms"]["median_ratio"], 0.8)
        self.assertEqual(comparison["total_tokens"]["matched_tasks"], 0)
        summary = perf.aggregate(rows)["harness"]
        self.assertEqual(summary["token_efficiency"]["usage_samples"], 1)
        self.assertIsNone(summary["token_efficiency"]["score_per_1k_tokens"])
        self.assertEqual(summary["all_attempts"]["agent_wall_ms"], 81)
        rows[0]["agent"]["usage"] = {"input_tokens": 12, "output_tokens": 8}
        rows[1]["agent"]["usage"] = {"input_tokens": 24, "output_tokens": 16}
        rows[0]["agent"]["usage_complete"] = True
        rows[1]["agent"]["usage_complete"] = False
        self.assertEqual(perf.paired_comparisons(rows)["codex"]["total_tokens"]["matched_tasks"], 0)
        rows[1]["agent"]["usage_complete"] = True
        self.assertEqual(
            perf.paired_comparisons(rows)["codex"]["total_tokens"]["median_ratio"], 0.5
        )

    def test_resume_rejects_changed_provenance_and_duplicate_trials(self):
        import copy

        saved = {
            "task": {"id": "pro"},
            "model_config": {"model": "same"},
            "schedule": [{"task_id": "a", "runner": "harness"}],
            "trials": [{"sequence": 1, "task_id": "a", "runner": "harness"}],
            "provenance": {"source_sha256": "frozen"},
        }
        perf.validate_resume(saved, copy.deepcopy(saved))
        changed = copy.deepcopy(saved)
        changed["provenance"]["source_sha256"] = "changed"
        with self.assertRaisesRegex(perf.PerfError, "source_sha256 differs"):
            perf.validate_resume(saved, changed)
        mismatched = copy.deepcopy(saved)
        mismatched["trials"][0]["runner"] = "codex"
        with self.assertRaisesRegex(perf.PerfError, "does not match"):
            perf.validate_resume(mismatched, copy.deepcopy(saved))
        repeated = copy.deepcopy(saved)
        repeated["schedule"][0]["repeat"] = 1
        repeated["trials"][0]["repeat"] = 1
        perf.validate_resume(repeated, copy.deepcopy(repeated))
        changed = copy.deepcopy(repeated)
        changed["schedule"][0]["repeat"] = 2
        with self.assertRaisesRegex(perf.PerfError, "schedule differs"):
            perf.validate_resume(repeated, changed)
        changed = copy.deepcopy(repeated)
        changed["trials"][0]["repeat"] = 2
        with self.assertRaisesRegex(perf.PerfError, "does not match"):
            perf.validate_resume(changed, repeated)
        saved["trials"].append({"sequence": 1})
        with self.assertRaisesRegex(perf.PerfError, "invalid recorded trial sequence"):
            perf.validate_resume(saved, copy.deepcopy(saved))

    def test_pro_report_renders_when_runners_pass_different_tasks(self):
        trials = []
        for sequence, (task, runner, passed) in enumerate(
            [
                ("a", "harness", True),
                ("a", "codex", False),
                ("b", "harness", False),
                ("b", "codex", True),
            ],
            1,
        ):
            trial = self.trial(runner, passed, 100)
            trial.update(sequence=sequence, task_id=task)
            trials.append(trial)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            perf.atomic_json(
                root / "run.json",
                {
                    "run_id": "disjoint-successes",
                    "created_at": "2026-01-01T00:00:00+00:00",
                    "status": "complete",
                    "planned_trials": 4,
                    "task": {"id": "pro", "suite": "pro", "cases": ["a", "b"], "sha256": "a" * 64},
                    "provenance": {
                        "git": {"commit": "abc", "dirty": False},
                        "image": {"reference": "image", "id": "sha256:1", "architecture": "amd64"},
                        "host_architecture": "amd64",
                    },
                    "trials": trials,
                },
            )
            report = perf.write_report(root)
            self.assertEqual(report["comparison"]["status"], "effect_only")
            self.assertEqual(report["comparison"]["score_delta"], 0)
            self.assertEqual(report["comparison"]["total_wall_ms"]["matched_tasks"], 0)
            self.assertIsNone(report["comparison"]["total_wall_ms"]["ratio"])
            rendered = perf.render_report(report)
            self.assertIn("Performance  INCOMPLETE", rendered)
            self.assertIn("same task", rendered)

    def test_comparison_reports_score_gate_and_efficiency_ratios(self) -> None:
        summary = perf.aggregate(
            [
                self.trial("harness", True, 80),
                self.trial("codex", True, 100),
            ]
        )
        result = perf.comparison(summary, 0.0)
        self.assertEqual(result["status"], "complete")
        self.assertFalse(result["score_regression"])
        self.assertLess(result["total_wall_ms"]["ratio"], 1)

    def test_comparison_detects_score_regression(self) -> None:
        harness = self.trial("harness", True, 80)
        harness["evaluation"]["score"] = 0.8
        summary = perf.aggregate([harness, self.trial("codex", True, 100)])
        result = perf.comparison(summary, 0.1)
        self.assertTrue(result["score_regression"])

    def test_grader_accepts_continuous_score_and_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            score_path = Path(temporary) / "grader-score.json"
            score_path.write_text('{"score": 0.75, "metrics": {"correctness": 1}}')
            with mock.patch.object(grader, "SCORE_PATH", score_path):
                score, metrics = grader.read_score(0.0)
        self.assertEqual(score, 0.75)
        self.assertEqual(metrics, {"correctness": 1.0})

    def test_write_report_produces_json_only(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run = {
                "run_id": "test-run",
                "created_at": "2026-01-01T00:00:00+00:00",
                "task": {"id": "task", "sha256": "a" * 64},
                "model": "test-model",
                "model_config": {
                    "model": "test-model",
                    "protocol": "responses",
                    "base_url": "http://model/v1",
                    "api_key_env": "MODEL_KEY",
                    "parameters": {},
                },
                "harness_runtime": {
                    "protocol_version": "areal.runtime.v0",
                    "sandbox_profile": "outerContainerPerfV1",
                },
                "provenance": {
                    "git": {"commit": "abc", "dirty": False},
                    "image": {"reference": "image", "id": "sha256:1", "architecture": "arm64"},
                    "host_architecture": "arm64",
                },
                "trials": [self.trial("codex", True, 100)],
            }
            perf.atomic_json(root / "run.json", run)
            report = perf.write_report(root)
            self.assertEqual(report["summary"]["codex"]["passed"], 1)
            self.assertEqual(report["task"]["score_regression_tolerance"], 0.0)
            self.assertEqual(report["comparison"]["status"], "incomplete")
            self.assertEqual(json.loads((root / "report.json").read_text())["schema_version"], 1)
            self.assertFalse((root / "report.md").exists())
            rendered = perf.render_report(report)
            self.assertNotIn("\033[", rendered)
            self.assertIn("Codex", rendered)
            self.assertIn("test-model via responses", rendered)
            self.assertIn("perf adapter -> areal.runtime.v0 via outerContainerPerfV1", rendered)
            self.assertIn("Score/kTok", rendered)
            self.assertIn("mainly reflects token cost", rendered)

    def test_render_report_can_add_terminal_colors(self) -> None:
        report = {
            "run_id": "test-run",
            "created_at": "2026-01-01T00:00:00+00:00",
            "task": {"id": "task"},
            "model_config": None,
            "harness_runtime": None,
            "provenance": {
                "git": {"commit": "abc", "dirty": True},
                "image": {"reference": "image", "architecture": "arm64"},
                "host_architecture": "arm64",
            },
            "trials": [self.trial("harness", True, 80), self.trial("codex", True, 100)],
        }
        rendered = perf.render_report(report, color=True)
        self.assertIn("\033[", rendered)
        self.assertIn("PASS", rendered)

    def test_terminal_color_respects_tty_and_no_color(self) -> None:
        stream = mock.Mock()
        stream.isatty.return_value = True
        with mock.patch.dict(os.environ, {"TERM": "xterm-256color"}, clear=True):
            self.assertTrue(perf.terminal_supports_color(stream))
        with mock.patch.dict(os.environ, {"TERM": "xterm-256color", "NO_COLOR": "1"}, clear=True):
            self.assertFalse(perf.terminal_supports_color(stream))


class InteractiveTests(unittest.TestCase):
    def test_pro_offers_claudecode_and_excludes_fixture(self) -> None:
        output = []
        arguments = perf.interactive_arguments(
            input_fn=self.input_from(["2", "3", "", "", "", "", ""]),
            output_fn=output.append,
        )
        self.assertEqual(arguments[:5], ["run", "--task", "pro", "--runner", "claudecode"])
        self.assertFalse(any("Fixture" in line for line in output))

    def input_from(self, values: list[str]):
        answers = iter(values)
        return lambda _: next(answers)

    def test_fixture_run_uses_defaults(self) -> None:
        output: list[str] = []
        arguments = perf.interactive_arguments(
            input_fn=self.input_from(["", "3", "", "", "", ""]),
            output_fn=output.append,
        )
        self.assertEqual(
            arguments,
            [
                "run",
                "--task",
                "lite",
                "--runner",
                "fixture",
                "--repeat",
                "1",
                "--image",
                perf.DEFAULT_IMAGE,
                "--allow-failures",
            ],
        )
        self.assertTrue(any(line.startswith("Command: ") for line in output))

    def test_multiple_runners_produce_one_run_command(self) -> None:
        arguments = perf.interactive_arguments(
            input_fn=self.input_from(["", "", "", "", "", "", ""]),
            output_fn=lambda _: None,
        )
        self.assertEqual(
            arguments,
            [
                "run",
                "--task",
                "lite",
                "--runner",
                "harness",
                "--runner",
                "codex",
                "--model-config",
                "tests/perf/model.toml",
                "--repeat",
                "5",
                "--image",
                perf.DEFAULT_IMAGE,
                "--allow-failures",
            ],
        )


class TraceReportTests(unittest.TestCase):
    def test_all_attempts_keep_missing_metrics_and_failed_trials(self):
        rows = [
            {
                "runner": "harness",
                "status": "passed",
                "trace_metrics": {
                    "tool_rounds": 2,
                    "poll_only_rounds": 0,
                    "return_reason_counts": {"completed": 2},
                },
            },
            {
                "runner": "harness",
                "status": "failed",
                "trace_metrics": {
                    "tool_rounds": 6,
                    "poll_only_rounds": 2,
                    "return_reason_counts": {"unknown": 3},
                },
            },
            {"runner": "harness", "status": "failed"},
            {"runner": "codex", "status": "passed"},
        ]
        summary = perf.aggregate(rows)
        trace = summary["harness"]["trace_metrics"]
        self.assertEqual(trace["median"]["tool_rounds"], 4)
        self.assertEqual(trace["samples"]["tool_rounds"], 2)
        self.assertEqual(trace["return_reason_counts"], {"completed": 2, "unknown": 3})
        self.assertIsNone(summary["codex"]["trace_metrics"]["median"]["tool_rounds"])
        self.assertIsNone(summary["codex"]["trace_metrics"]["return_reason_counts"])


if __name__ == "__main__":
    unittest.main()


class MissingUsageTests(unittest.TestCase):
    def test_usage_absence_and_partial_result_remain_missing(self):
        usage = {}
        agent.extract_usage({"type": "result", "usage": {}}, usage)
        self.assertEqual(usage, {})
        agent.extract_usage({"usage": {"input_tokens": 12}}, usage)
        self.assertEqual(usage, {"input_tokens": 12})
        agent.extract_usage({"usage": {"input_tokens": 12, "output_tokens": 5}}, usage)
        self.assertEqual(usage, {"input_tokens": 12, "output_tokens": 5})
