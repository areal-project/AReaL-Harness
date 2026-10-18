"""Archived telemetry must preserve missing data and count each tool once."""

import copy
import json
import tempfile
import importlib.util
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "trace_metrics", Path(__file__).resolve().parents[1] / "trace_metrics.py"
)
trace = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(trace)


class TraceMetricsTests(unittest.TestCase):
    def record(self, **changes):
        return {
            "request_sha256": "request",
            "status": 200,
            "semantic_terminal_seen": True,
            "terminal_delivered_ms": 100,
            "first_byte_ms": 10,
            "usage": {
                "input_tokens": 100,
                "cached_input_tokens": 80,
                "output_tokens": 20,
            },
            **changes,
        }

    def test_invalid_usage_and_failed_requests_are_not_zero_filled(self):
        records = [
            self.record(),
            self.record(status=502, semantic_terminal_seen=False, usage={}),
            self.record(
                usage_parse_errors=1,
                usage={"input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0},
            ),
            self.record(terminal_delivered_ms=None),
        ]
        before = copy.deepcopy(records)
        metrics = trace.model_metrics(records)
        self.assertEqual(metrics["archived_requests"], 4)
        self.assertEqual(metrics["usage_requests"], 1)
        self.assertEqual(metrics["observed_usage"], records[0]["usage"])
        self.assertEqual(metrics["http_status_counts"], {"200": 3, "502": 1})
        self.assertEqual(records, before)
        self.assertEqual(trace.model_metrics(records[1:])["observed_usage"], {})
        self.assertEqual(trace.model_metrics([])["observed_usage"], {})

    def test_impossible_cache_counter_is_not_accepted(self):
        row = self.record(usage={"input_tokens": 10, "cached_input_tokens": 20, "output_tokens": 0})
        self.assertFalse(trace.valid_usage(row))

    def test_tools_deduplicate_started_completed_and_streamed_blocks(self):
        codex = [
            {
                "event": {
                    "type": kind,
                    "item": {"id": "one", "type": "command_execution"},
                }
            }
            for kind in ("item.started", "item.completed")
        ]
        self.assertEqual(trace.tool_breakdown(codex, "codex"), {"command_execution": 1})
        event = {
            "event": {
                "type": "assistant",
                "message": {
                    "content": [
                        {"type": "tool_use", "id": "one", "name": "Bash"},
                    ]
                },
            }
        }
        self.assertEqual(trace.tool_breakdown([event, event], "claudecode"), {"Bash": 1})

    def test_rounds_include_empty_replies_and_keep_error_poll_overlap(self):
        thread = {
            "turns": [
                {
                    "items": [
                        {"type": "agentMessage", "text": ""},
                        {"type": "dynamicToolCall", "tool": "fs_read", "success": True},
                        {
                            "type": "dynamicToolCall",
                            "tool": "fs_read",
                            "success": False,
                        },
                        {"type": "agentMessage", "text": ""},
                        {
                            "type": "dynamicToolCall",
                            "tool": "read_process",
                            "success": False,
                        },
                        {"type": "agentMessage", "text": "done"},
                    ]
                }
            ],
            "contextCheckpoint": {
                "compactions": 1,
                "totalDurationMs": 15,
                "usage": {"inputTokens": 20, "cachedInputTokens": 0, "outputTokens": 4},
            },
        }
        metrics = trace.harness_round_metrics(thread)
        self.assertEqual(metrics["model_reply_rounds"], 3)
        self.assertEqual(metrics["tool_rounds"], 2)
        self.assertEqual(metrics["multi_tool_rounds"], 1)
        self.assertEqual(metrics["rounds_with_tool_failure"], 2)
        self.assertEqual(metrics["poll_only_rounds"], 1)
        self.assertEqual(metrics["context_compactions"], 1)
        self.assertEqual(metrics["compaction_usage"]["inputTokens"], 20)

    def test_return_reasons_and_effective_write_conditions(self):
        def tool(name, value, args=None, effective=None):
            return {
                "type": "dynamicToolCall",
                "tool": name,
                "success": "error" not in value,
                "arguments": args or {},
                "execution": {"effectiveArguments": effective},
                "contentItems": [{"type": "inputText", "text": json.dumps(value)}],
            }

        conflict = {"error": {"code": "CONFLICT", "message": "condition failed"}}
        items = [
            {"type": "agentMessage"},
            tool("run_command", {"state": "running", "returnReason": "outputQuiet"}),
            tool("read_process", {"state": "exited"}),
            tool("custom_tool", {"error": "plugin diagnostic"}),
            tool("fs_write", conflict, {"expectedSha256": "a" * 64}, {"expectedSha256": None}),
            tool("fs_write", conflict, {"expectedSha256": None}, {"expectedSha256": "a" * 64}),
            tool("fs_apply_patches", conflict, {"patches": [{"oldText": "a", "newText": "b"}]}),
            tool(
                "read_process",
                {
                    "error": {
                        "code": "INVALID_ARGUMENT",
                        "message": "invalid processId; copy the complete processId returned by run_command unchanged",
                    }
                },
            ),
        ]
        metrics = trace.harness_round_metrics({"turns": [{"items": items}]})
        self.assertEqual(metrics["return_reason_counts"], {"outputQuiet": 1, "unknown": 2})
        self.assertEqual(
            metrics["tool_failure_categories"],
            {
                "file_create_conflict": 1,
                "file_edit_conflict": 2,
                "invalid_process_id": 1,
                "other_confirmed_failure": 1,
            },
        )
        self.assertEqual(metrics["rounds_with_tool_failure"], 1)

    def test_collect_missing_files_is_not_an_observed_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            metrics = trace.collect(output, "harness")
            self.assertEqual(metrics, {"source_sha256": {}, "core_trace_status": "missing"})
            (output / "agent-events.jsonl").write_text("")
            self.assertEqual(trace.collect(output, "codex")["tool_breakdown"], {})
            self.assertNotIn("model_reply_rounds", trace.collect(output, "codex"))


if __name__ == "__main__":
    unittest.main()
