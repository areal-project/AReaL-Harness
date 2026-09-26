import ast
import json
from pathlib import Path
import re
import unittest

from outcomes import core_outcome, finalize


def thread(code="LLM_CONTEXT_WINDOW_EXCEEDED", parent=None, message="opaque"):
    return {
        "parentThreadId": parent,
        "turns": [
            {
                "status": "failed",
                "error": {
                    "message": message,
                    "outcome": {
                        "code": code,
                        "class": "agent",
                        "source": "core_context_budget",
                        "details": {"estimatedTokens": 188817},
                    },
                },
            }
        ],
    }


class OutcomesTest(unittest.TestCase):
    def test_core_outcome_is_forwarded_not_inferred(self):
        root = thread(message="timeout HTTP 413")
        child = thread("LLM_OUTPUT_TOKEN_LIMIT_EXCEEDED", parent="root")
        result = {"status": "ERROR"}
        marker = finalize(result, [child, root])
        self.assertEqual(result["raw"]["outcome"]["code"], "LLM_CONTEXT_WINDOW_EXCEEDED")
        self.assertEqual(result["raw"]["outcome"]["details"], {"estimatedTokens": 188817})
        self.assertIn("GAMEAGENT_OUTCOME_CODE=LLM_CONTEXT_WINDOW_EXCEEDED", marker)
        self.assertEqual(result["status"], "ERROR")

    def test_round_limit_is_forwarded_as_agent_failure(self):
        result = {"status": "ERROR"}
        finalize(result, [thread("AGENT_MAX_TURNS_EXCEEDED")])
        self.assertEqual(result["raw"]["outcome"]["code"], "AGENT_MAX_TURNS_EXCEEDED")
        self.assertEqual(result["raw"]["outcome"]["class"], "agent")
        self.assertEqual(result["status"], "ERROR")

    def test_legacy_and_no_result_do_not_guess(self):
        root = thread()
        del root["turns"][0]["error"]["outcome"]
        self.assertEqual(core_outcome([root])["code"], "HARNESS_INTERNAL_ERROR")
        result = {"status": "ERROR", "error": "context_length_exceeded"}
        finalize(result)
        self.assertEqual(result["raw"]["outcome"]["code"], "HARNESS_INTERNAL_ERROR")

    def test_runner_causes_and_success_are_explicit(self):
        for flags, code in [
            ({"timed_out": True}, "AGENT_RUN_TIMEOUT"),
            ({"interrupted": True}, "HARNESS_INTERRUPTED"),
            ({"adapter_error": True}, "HARNESS_INTERNAL_ERROR"),
        ]:
            result = {"status": "ERROR"}
            finalize(result, [thread()], **flags)
            self.assertEqual(result["raw"]["outcome"]["code"], code)
        result = {"status": "OK"}
        finalize(result)
        self.assertEqual(result["raw"]["outcome"]["class"], "success")

    def test_adapter_failure_preserves_deadline_and_is_idempotent(self):
        result = {"status": "ERROR", "error": "collect failed"}
        for flags, code in [
            ({"timed_out": True}, "AGENT_RUN_TIMEOUT"),
            ({"interrupted": True}, "HARNESS_INTERRUPTED"),
        ]:
            finalize(result, [thread()], adapter_error=True, **flags)
            previous = json.loads(json.dumps(result))
            finalize(result, [thread()], adapter_error=True, **flags)
            self.assertEqual(result, previous)
            self.assertEqual(result["raw"]["runner_outcome"]["code"], code)
            self.assertEqual(len(result["raw"]["core_errors"]), 1)
            self.assertEqual(result["raw"]["outcome"]["class"], "infrastructure")

    def test_areal_consumer_contract(self):
        # 直接执行调用方的无依赖提取方法，验证结构化与旧 marker 两条链路。
        source = Path.home() / "src/AReaL/examples/swe/arena_agent.py"
        if not source.exists():
            self.skipTest("AReaL checkout unavailable")
        tree = ast.parse(source.read_text())
        method = next(
            n
            for n in ast.walk(tree)
            if isinstance(n, ast.FunctionDef) and n.name == "_gameagent_outcome_code"
        )
        method.decorator_list = []
        scope = {
            "Any": object,
            "_GAMEAGENT_OUTCOME_CODE_VALUE_PATTERN": re.compile(r"^[A-Z][A-Z0-9_]{0,127}$"),
            "_GAMEAGENT_OUTCOME_CODE_PATTERN": re.compile(
                r"(?:^|\s)GAMEAGENT_OUTCOME_CODE=([A-Z][A-Z0-9_]{0,127})(?:\s|$)"
            ),
        }
        exec(compile(ast.Module(body=[method], type_ignores=[]), str(source), "exec"), scope)
        result = {"status": "ERROR"}
        finalize(result, [thread()])
        extract = scope["_gameagent_outcome_code"]
        self.assertEqual(
            extract(json.loads(json.dumps(result["raw"]))), "LLM_CONTEXT_WINDOW_EXCEEDED"
        )
        self.assertEqual(extract({"error": result["summary"]}), "LLM_CONTEXT_WINDOW_EXCEEDED")


if __name__ == "__main__":
    unittest.main()
