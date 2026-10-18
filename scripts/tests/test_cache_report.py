import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "cache_report", Path(__file__).resolve().parents[1] / "cache-report.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CacheReportTests(unittest.TestCase):
    def test_unknown_usage_is_not_a_cache_miss_and_tool_changes_break_prefix(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / "model-requests"
            data.mkdir()
            block = {"sha256": "one", "bytes": 100}
            rows = [
                {
                    "requestId": "one",
                    "startedAtUnixMs": 1,
                    "usageObserved": True,
                    "usage": {"inputTokens": 100, "cachedInputTokens": 0},
                    "usageDetails": {"cachedInputTokens": 0},
                    "messageBlocks": [block],
                },
                {
                    "requestId": "two",
                    "startedAtUnixMs": 2,
                    "usageObserved": True,
                    "usage": {"inputTokens": 120, "cachedInputTokens": 100},
                    "usageDetails": {"cachedInputTokens": 100},
                    "messageBlocks": [block, {"sha256": "two", "bytes": 20}],
                },
                {
                    "requestId": "three",
                    "startedAtUnixMs": 3,
                    "usageObserved": False,
                    "usage": {"inputTokens": 0, "cachedInputTokens": 0},
                    "messageBlocks": [block],
                },
            ]
            for row in rows:
                row.update(
                    threadId="thread",
                    purpose="Solve",
                    protocol="chat-completions",
                    parameters={"model": "fixture"},
                    toolSchemaSha256="stable",
                    instructionsSha256="stable",
                    outcome="completed",
                )
                (data / (row["requestId"] + ".json")).write_text(json.dumps(row))
            result = module.report(root)
            self.assertEqual(result["totals"]["inputTokens"], 220)
            self.assertEqual(result["totals"]["cachedInputTokens"], 100)
            self.assertEqual(result["totals"]["unknownUsageRequests"], 1)
            self.assertEqual(result["totals"]["preservedPrefixPairs"], 1)
            self.assertAlmostEqual(result["totals"]["weightedCacheRate"], 100 / 220)
            rows[1]["toolSchemaSha256"] = "changed"
            (data / "two.json").write_text(json.dumps(rows[1]))
            self.assertFalse(module.report(root)["requests"][1]["completePreviousInputPrefix"])

    def test_missing_cache_counts_stay_unknown_and_jsonl_is_not_double_counted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / "model-requests"
            data.mkdir()
            row = {
                "requestId": "one",
                "usageObserved": True,
                "usage": {"inputTokens": 100, "cachedInputTokens": 0},
            }
            (data / "one.json").write_text(json.dumps(row))
            (data / "requests.jsonl").write_text(json.dumps(row) + "\n")
            result = module.report(root)["totals"]
            self.assertEqual(result["requests"], 1)
            self.assertEqual(result["unknownCacheRequests"], 1)
            self.assertIsNone(result["weightedCacheRate"])


if __name__ == "__main__":
    unittest.main()
