import ast
import time
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


class RunnerTest(unittest.TestCase):
    def test_adapter_exception_writes_failure_outcome_and_returns_nonzero(self):
        path = Path(__file__).with_name("runner.py")
        spec = importlib.util.spec_from_file_location("arena_runner", path)
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = {
                "ARENA_AGENT_OUTPUT_DIR": str(root / "agent"),
                "ARENA_OUTPUT_DIR": str(root / "out"),
                "ARENA_TRAJECTORY_PATH": str(root / "trajectory.jsonl"),
            }
            with (
                patch.dict(os.environ, env),
                patch.object(runner, "prepare_utilities", side_effect=RuntimeError("fixture")),
                patch.object(runner.signal, "signal"),
                contextlib.redirect_stdout(io.StringIO()),
                contextlib.redirect_stderr(io.StringIO()),
            ):
                self.assertEqual(runner.main(), 1)
            result = json.loads((root / "out/harness_result.json").read_text())
            self.assertEqual(result["status"], "ERROR")
            self.assertEqual(result["raw"]["outcome"]["code"], "HARNESS_INTERNAL_ERROR")
            self.assertEqual(result["raw"]["outcome"]["source"], "runner")
            self.assertEqual(json.loads((root / "agent/native-receipt.json").read_text()), result)
            trace = json.loads((root / "trajectory.jsonl").read_text())
            self.assertTrue(trace["is_error"])
            self.assertEqual(trace["result"]["raw"], result["raw"])

    def test_real_collection_conflict_preserves_core_error_in_all_results(self):
        # 直接执行 runner 的真实收集、异常和落盘分支，避免启动原生模型进程。
        source = Path(__file__).with_name("runner.py")
        spec = importlib.util.spec_from_file_location("arena_runner", source)
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        tree = ast.parse(source.read_text())
        main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "main")
        outer = next(n for n in main.body if isinstance(n, ast.Try))
        collection = next(
            n
            for n in ast.walk(outer)
            if isinstance(n, ast.If)
            and isinstance(n.test, ast.Name)
            and n.test.id == "graybox"
            and any(
                isinstance(i, ast.ImportFrom) and i.module == "graybox_collect" for i in ast.walk(n)
            )
        )
        block = ast.fix_missing_locations(
            ast.Module(
                body=[
                    ast.Try(
                        body=[collection],
                        handlers=outer.handlers,
                        orelse=[],
                        finalbody=outer.finalbody,
                    )
                ],
                type_ignores=[],
            )
        )
        for core_failed in (True, False):
            with self.subTest(core_failed=core_failed), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                work, output = root / "work", root / "agent"
                output.mkdir()
                for sub, content in [("stages", "first"), ("output/stages", "conflicting")]:
                    directory = work / sub
                    directory.mkdir(parents=True)
                    (directory / "02-graybox.blend").write_text(content)
                original = {
                    "message": "context window limit exceeded",
                    "outcome": {
                        "code": "LLM_CONTEXT_WINDOW_EXCEEDED",
                        "class": "agent",
                        "source": "core_context_budget",
                        "details": {"estimatedTokens": 188817},
                    },
                }
                turn = {
                    "id": "turn",
                    "status": "failed" if core_failed else "completed",
                    "error": original if core_failed else None,
                }
                result = {"status": "ERROR" if core_failed else "OK"}
                if core_failed:
                    result["error"] = [original]
                scope = dict(
                    vars(runner),
                    result=result,
                    threads=[{"id": "root", "turns": [turn]}],
                    graybox=True,
                    graybox_state=None,
                    workspace=str(work),
                    output=output,
                    trajectory_path=root / "trajectory.jsonl",
                    started=time.monotonic(),
                    adapter_error=False,
                    timed_out=False,
                    stopping=False,
                )
                with (
                    patch.dict(os.environ, {"ARENA_OUTPUT_DIR": str(root / "out")}),
                    contextlib.redirect_stdout(io.StringIO()),
                    contextlib.redirect_stderr(io.StringIO()),
                ):
                    exec(compile(block, str(source), "exec"), scope)
                final = json.loads((root / "out/harness_result.json").read_text())
                trace = json.loads((root / "trajectory.jsonl").read_text())
                receipt = json.loads((output / "native-receipt.json").read_text())
                self.assertEqual(final, receipt)
                self.assertEqual(trace["result"]["raw"], final["raw"])
                self.assertTrue(trace["is_error"])
                self.assertEqual(final["status"], "ERROR")
                raw = final["raw"]
                self.assertEqual(raw["outcome"]["code"], "HARNESS_INTERNAL_ERROR")
                self.assertIn("Conflicting", raw["adapter_error"]["message"])
                if core_failed:
                    self.assertEqual(raw["core_outcome"]["code"], "LLM_CONTEXT_WINDOW_EXCEEDED")
                    self.assertEqual(
                        raw["core_errors"],
                        [
                            {
                                "thread_id": "root",
                                "turn_id": "turn",
                                "status": "failed",
                                "error": original,
                            }
                        ],
                    )
                else:
                    self.assertNotIn("core_outcome", raw)
                    self.assertNotIn("core_errors", raw)


class LazyInputTest(unittest.TestCase):
    def test_optional_rules_path_may_be_absent_but_existing_rules_are_preserved(self):
        import public_inputs

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            task = root / "task.md"
            task.write_text("Original task contract")
            harness = root / "harness"
            harness.mkdir()
            rules = harness / "system-prompt.md"
            for name, content in [("absent", None), ("present", "原始附加规则\n"), ("empty", "")]:
                with self.subTest(name=name):
                    if content is not None:
                        rules.write_text(content)
                    destination = root / name
                    receipt, _, baseline = public_inputs.prepare(
                        task, destination, root / "no-assets", rules_path=rules
                    )
                    if content is None:
                        self.assertIsNone(receipt["rules"])
                        self.assertFalse((destination / "RULES.md").exists())
                        self.assertNotIn(
                            "RULES.md", public_inputs.bootstrap(receipt, destination)[0]["text"]
                        )
                    else:
                        self.assertEqual((destination / "RULES.md").read_text(), content)
                        self.assertEqual(receipt["rules"]["bytes"], len(content.encode()))
                    public_inputs.verify(destination, baseline)

    def test_optional_rules_reject_unsafe_paths_and_copy_failures(self):
        import public_inputs

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            task = root / "task.md"
            task.write_text("task")
            directory = root / "directory"
            directory.mkdir()
            (root / "link").symlink_to(task)
            (root / "dangling").symlink_to(root / "missing")
            (root / "parent-link").symlink_to(directory, target_is_directory=True)
            (root / "hardlink-source").write_text("rules")
            os.link(root / "hardlink-source", root / "hardlink")
            for name in ["directory", "link", "dangling", "parent-link/missing", "hardlink"]:
                with self.subTest(name=name), self.assertRaises(public_inputs.PublicInputError):
                    public_inputs.prepare(
                        task,
                        root / ("reject-" + name.replace("/", "-")),
                        root / "no-assets",
                        rules_path=root / name,
                    )
            rules = root / "rules.md"
            rules.write_text("required when present")
            copy_file = public_inputs.copy_file
            for error in [
                PermissionError("unreadable rules"),
                FileNotFoundError("rules removed during copy"),
            ]:

                def copy(source, destination):
                    if source == rules:
                        raise error
                    return copy_file(source, destination)

                with (
                    self.subTest(error=type(error).__name__),
                    patch.object(public_inputs, "copy_file", copy),
                ):
                    with self.assertRaises(type(error)):
                        public_inputs.prepare(
                            task, root / type(error).__name__, root / "no-assets", rules_path=rules
                        )

    def test_incident_shapes_have_small_bootstrap_and_preserve_aliases(self):
        import public_inputs
        import base64

        # 归档四例的字节数与重复关系；合成内容只验证输入交付，不冒充原图或真实 rollout。
        cases = {
            "carbon": [31724, 45867, 526320, 508661, 507047, 493699],
            "bpmn1200": [3721378],
            "bpmn1719": [2743627],
            "prettier": [54248, 328058, 671386, 183443] * 2,
        }
        for name, sizes in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                assets = root / "assets"
                assets.mkdir()
                query = root / "query.md"
                query.write_text("保留原题和输出合同\n" * 400000)
                for index, size in enumerate(sizes):
                    (assets / f"{index}.png").write_bytes(
                        bytes([index % 4 if name == "prettier" else index]) * size
                    )
                old_size = sum(len(base64.b64encode(p.read_bytes())) for p in assets.iterdir())
                self.assertGreater(old_size, 2 * 1024 * 1024)
                destination = root / "public-inputs"
                receipt, records, baseline = public_inputs.prepare(query, destination, assets)
                inputs = public_inputs.bootstrap(receipt, destination)
                self.assertLess(public_inputs.validate_envelope(inputs), 4096)
                self.assertNotIn("data:", json.dumps(inputs))
                self.assertEqual(len(records), len(sizes))
                self.assertEqual((destination / "TASK.md").read_bytes(), query.read_bytes())
                for record in records:
                    self.assertEqual(
                        Path(record["shell_path"]).read_bytes(), Path(record["source"]).read_bytes()
                    )
                self.assertEqual(
                    receipt["unique_attachment_count"], 4 if name == "prettier" else len(sizes)
                )
                public_inputs.verify(destination, baseline)

    def test_links_missing_task_and_tampering_fail_closed(self):
        import public_inputs

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            task = root / "task.md"
            task.write_text("task")
            assets = root / "assets"
            assets.mkdir()
            (assets / "private.png").symlink_to(task)
            with self.assertRaises(public_inputs.PublicInputError):
                public_inputs.prepare(task, root / "rejected", assets)
            (assets / "private.png").unlink()
            receipt, records, baseline = public_inputs.prepare(task, root / "public", assets)
            imported = root / "public/TASK.md"
            imported.chmod(0o644)
            imported.write_text("changed")
            with self.assertRaises(public_inputs.PublicInputError):
                public_inputs.verify(root / "public", baseline)
            os.link(task, assets / "hardlink")
            with self.assertRaises(public_inputs.PublicInputError):
                public_inputs.prepare(task, root / "hardlinks", assets)

    def test_context_policy_and_request_bytes_are_independent(self):
        import runner
        import tomllib

        default = tomllib.loads(runner.make_config("fixture", "http://localhost/v1", 30))
        self.assertFalse(default["limits"]["context_compaction_enabled"])
        configured = tomllib.loads(
            runner.make_config(
                "fixture",
                "http://localhost/v1",
                30,
                {
                    "max_request_bytes": 4000000,
                    "context_compaction_enabled": True,
                    "context_window_tokens": 262144,
                },
            )
        )
        self.assertEqual(configured["model"]["max_request_bytes"], 4000000)
        self.assertTrue(configured["limits"]["context_compaction_enabled"])
        self.assertEqual(configured["limits"]["context_window_tokens"], 262144)

    def test_model_overrides_allow_omission_without_changing_frozen_settings(self):
        import runner
        import tomllib

        settings = {"temperature": 1, "reasoning_effort": "medium", "max_output_tokens": 65536}
        with patch.dict(
            os.environ,
            {
                "AREAL_ARENA_TEMPERATURE": "null",
                "AREAL_ARENA_REASONING_EFFORT": "low",
                "AREAL_ARENA_MAX_OUTPUT_TOKENS": "2048",
            },
        ):
            parameters = runner.model_parameters(settings)
            config = tomllib.loads(
                runner.make_config("fixture", "http://localhost/v1", 30, settings)
            )
        self.assertEqual(
            parameters, {"temperature": None, "reasoning_effort": "low", "max_output_tokens": 2048}
        )
        self.assertNotIn("temperature", config["model"])
        self.assertEqual(config["model"]["reasoning_effort"], "low")
        self.assertEqual(config["model"]["max_output_tokens"], 2048)
        self.assertEqual(settings["temperature"], 1)
        self.assertEqual(settings["max_output_tokens"], 65536)

    def test_optional_sampling_preserves_none_effort_and_zero_temperature(self):
        import runner
        import tomllib

        with patch.dict(os.environ, {}, clear=True):
            for settings, wanted in [
                ({}, {"temperature": 1, "reasoning_effort": "medium"}),
                (
                    {"temperature": 0, "reasoning_effort": "none"},
                    {"temperature": 0, "reasoning_effort": "none"},
                ),
                ({"temperature": None, "reasoning_effort": None}, {}),
            ]:
                config = tomllib.loads(
                    runner.make_config("fixture", "http://localhost/v1", 30, settings)
                )
                actual = {
                    k: config["model"][k]
                    for k in ("temperature", "reasoning_effort")
                    if k in config["model"]
                }
                self.assertEqual(actual, wanted)
        with patch.dict(os.environ, {"AREAL_ARENA_REASONING_EFFORT": "null"}):
            config = tomllib.loads(runner.make_config("fixture", "http://localhost/v1", 30))
        self.assertNotIn("reasoning_effort", config["model"])


if __name__ == "__main__":
    unittest.main()
