"""探针的失败终态与用量缺失不能被统计成成功或免费请求。"""

import importlib.util
import json
from pathlib import Path
import time
import tempfile
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location(
    "tool_contract_lab", Path(__file__).resolve().parents[2] / "tests/perf/tool_contract_lab.py"
)
lab = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(lab)


class ToolContractLabTest(unittest.TestCase):
    schemas = {
        "read_file": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        }
    }
    call = {"type": "function_call", "name": "read_file", "arguments": '{"path":"a.py"}'}

    def test_missing_or_inconsistent_usage_remains_unknown(self):
        for usage in (
            None,
            {},
            {"input_tokens": 5},
            {"input_tokens": 5, "output_tokens": 2, "total_tokens": 6},
            {"input_tokens": 0, "output_tokens": 1, "total_tokens": True},
        ):
            with self.subTest(usage=usage):
                self.assertIsNone(lab.usage_of(usage, "responses")["total_tokens"])
        row = {"model_key": "qwen", "wall_seconds": 1, **lab.usage_of(None, "responses")}
        self.assertEqual(lab.summarize([row])["qwen"]["unknown_usage_requests"], 1)

    def test_usage_and_cache_have_separate_coverage(self):
        usage = {
            "input_tokens": 5,
            "output_tokens": 2,
            "total_tokens": 7,
            "input_tokens_details": {"cached_tokens": 8},
            "output_tokens_details": {"reasoning_tokens": 1},
        }
        parsed = lab.usage_of(usage, "responses")
        self.assertEqual(parsed["total_tokens"], 7)
        self.assertIsNone(parsed["cached_input_tokens"])
        self.assertEqual(parsed["reasoning_tokens"], 1)
        self.assertEqual(
            lab.usage_of({"prompt_tokens": 5, "completion_tokens": 2}, "chat-completions")[
                "total_tokens"
            ],
            7,
        )

    def test_failed_terminal_keeps_usage_without_claiming_success(self):
        for status in ("failed", "incomplete"):
            event = {
                "type": "response." + status,
                "response": {
                    "status": status,
                    "output": [self.call],
                    "usage": {"input_tokens": 5, "output_tokens": 2, "total_tokens": 7},
                },
            }
            raw = lab.parse_stream(
                [b"data: " + json.dumps(event).encode() + b"\n"], "responses", time.monotonic()
            )
            self.assertEqual(lab.usage_of(raw["usage"], "responses")["total_tokens"], 7)
            self.assertFalse(
                lab.assess(raw, "responses", "read_file", {"path": "a.py"}, self.schemas)[
                    "semantic_correct"
                ]
            )

    def test_no_terminal_and_malformed_stream_are_rejected(self):
        for stream in (
            [],
            [b"data: [DONE]\n"],
            [b"data: broken\n"],
            [b'data: {"error":{"message":"failed"}}\n'],
        ):
            with self.subTest(stream=stream), self.assertRaises(ValueError):
                lab.parse_stream(stream, "responses", time.monotonic())

    def test_chat_finish_with_usage_does_not_require_done_sentinel(self):
        events = [
            {
                "choices": [
                    {
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "function": {"name": "read_file", "arguments": '{"path":'},
                                }
                            ]
                        }
                    }
                ]
            },
            {
                "choices": [
                    {
                        "delta": {
                            "tool_calls": [{"index": 0, "function": {"arguments": '"a.py"}'}}]
                        },
                        "finish_reason": "tool_calls",
                    }
                ]
            },
            {"choices": [], "usage": {"prompt_tokens": 5, "completion_tokens": 2}},
        ]
        raw = lab.parse_stream(
            [b"data: " + json.dumps(e).encode() + b"\n" for e in events],
            "chat-completions",
            time.monotonic(),
        )
        self.assertTrue(
            lab.assess(raw, "chat-completions", "read_file", {"path": "a.py"}, self.schemas)[
                "semantic_correct"
            ]
        )
        self.assertEqual(lab.usage_of(raw["usage"], "chat-completions")["total_tokens"], 7)

    def test_multiple_malformed_or_wrong_calls_are_not_success(self):
        for calls in (
            [],
            [self.call, self.call],
            [{**self.call, "arguments": "broken"}],
            [{**self.call, "name": "unknown"}],
            [{**self.call, "arguments": '{"path":7}'}],
        ):
            with self.subTest(calls=calls):
                self.assertFalse(
                    lab.validate(calls, "read_file", {"path": "a.py"}, self.schemas)[
                        "semantic_correct"
                    ]
                )

    def test_interrupted_stream_is_retained_and_is_not_retried(self):
        line = b'data: {"type":"response.output_text.delta","delta":"partial"}\n'

        def interrupted():
            yield line
            raise OSError("fixture connection closed")

        response = mock.MagicMock()
        response.__enter__.return_value = interrupted()
        opener = mock.Mock()
        opener.open.return_value = response
        with (
            tempfile.TemporaryDirectory() as folder,
            mock.patch.object(lab.urllib.request, "build_opener", return_value=opener),
        ):
            result = lab.single(
                {"base_url": "https://fixture.invalid", "api_key": "test-only"},
                "astra",
                [],
                ("interrupted", "read_file", {"path": "a.py"}, "Read a.py."),
                0,
                Path(folder),
            )
            self.assertEqual(opener.open.call_count, 1)
            self.assertEqual(result["status"], "ERROR")
            self.assertIsNone(result["total_tokens"])
            self.assertFalse(result["semantic_correct"])
            self.assertEqual(
                (Path(folder) / "astra-interrupted-r0/response.sse").read_bytes(), line
            )


if __name__ == "__main__":
    unittest.main()
