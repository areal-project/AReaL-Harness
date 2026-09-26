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


if __name__ == "__main__":
    unittest.main()
