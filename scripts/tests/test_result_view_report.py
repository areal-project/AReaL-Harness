import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    "result_view_report", Path(__file__).resolve().parents[2] / "tests/perf/result_view_report.py"
)
reporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reporter)


class ResultViewReportTest(unittest.TestCase):
    def test_missing_optional_usage_is_not_filled_from_budget_defaults(self):
        audit = {
            "usageObserved": True,
            "usage": {"cachedInputTokens": 0},
            "usageDetails": {"cachedInputTokens": None, "reasoningTokens": 7},
        }
        self.assertIsNone(reporter.usage_counter(audit, "cachedInputTokens"))
        self.assertEqual(reporter.usage_counter(audit, "reasoningTokens"), 7)

    def test_unknown_usage_is_not_reported_as_zero(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            (directory / "model-requests").mkdir()
            for index, observed in enumerate([True, False]):
                (directory / "model-requests" / f"{index}.json").write_text(
                    json.dumps(
                        {
                            "requestId": str(index),
                            "usageObserved": observed,
                            "usage": {"inputTokens": 10, "cachedInputTokens": 5, "outputTokens": 2},
                        }
                    )
                )
            result = reporter.report(directory, [])
            self.assertIsNone(result["usage"]["inputTokens"])
            self.assertIsNone(result["usage"]["uncachedInputTokens"])
            self.assertEqual(result["observedPartialUsage"]["inputTokens"], 10)
            self.assertEqual(result["unknownUsageRequests"], 1)

    def test_prefix_diagnostics_distinguish_append_and_existing_changes(self):
        def audit(index, blocks, schema="same"):
            return {
                "requestId": str(index),
                "startedAtUnixMs": index,
                "threadId": "t",
                "purpose": "Turn",
                "messageBlocks": [{"sha256": b, "bytes": 10} for b in blocks],
                "toolSchemaSha256": schema,
                "instructionsSha256": "same",
            }

        events = reporter.prefix_changes(
            [audit(0, "ab"), audit(1, "abc"), audit(2, "adc"), audit(3, "adce", "changed")]
        )
        self.assertEqual(
            [e["reason"] for e in events],
            ["appendOnly", "existingBlocksChanged", "toolSchemaChanged"],
        )
        self.assertEqual([e["sharedMessageBytes"] for e in events], [20, 10, 30])
