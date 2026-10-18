"""Regression coverage for the published benchmark's aggregation rules."""

import copy
import hashlib
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "summarize_evidence", ROOT / "tests/perf/summarize_evidence.py"
)
evidence = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(evidence)


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.snapshot = json.loads(
            (ROOT / "docs/benchmarks/reports/perf-pro-five-evidence.json").read_text()
        )

    def test_publication_preserves_the_original_measurement_payload(self):
        publication = self.snapshot.pop("publication")
        self.assertEqual(publication["redaction_version"], 1)
        self.assertEqual(
            publication["original_document_sha256"],
            "031c4b4e4bb4e21bb9919c08f23b1df87845062567715e8d65359aa967df540d",
        )
        paths = [entry["path"] for entry in publication["redacted_fields"]]
        expected = {
            "/model_config/base_url",
            "/model_config/model",
            "/model_config/runner_upstreams/claudecode/base_url",
            "/attempts/6/agent_error",
            *(f"/cases/{key}/environment_image" for key in self.snapshot["cases"]),
        }
        self.assertEqual(len(paths), 10)
        self.assertEqual(set(paths), expected)
        for path in paths:
            parts = path.strip("/").split("/")
            parent = self.snapshot
            for part in parts[:-1]:
                parent = parent[int(part)] if isinstance(parent, list) else parent[part]
            key = int(parts[-1]) if isinstance(parent, list) else parts[-1]
            self.assertRegex(parent[key], r"redacted\.invalid|\[REDACTED")
            parent[key] = "[REDACTED]"
        canonical = json.dumps(
            self.snapshot, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode()
        # 固定原始快照的非脱敏载荷摘要，防止改写测量后同时更新元数据蒙混过关。
        expected_digest = "a735a6f38f72204fbe1a877fd705233cf25573dc37a897ea3bb7ee95e4d62149"
        self.assertEqual(hashlib.sha256(canonical).hexdigest(), expected_digest)
        self.assertEqual(publication["preserved_payload_sha256"], expected_digest)

    def test_publication_contains_no_private_endpoints_or_deployment_identifiers(self):
        self.assertEqual(self.snapshot["model_config"]["base_url"], "https://redacted.invalid/v1")
        self.assertEqual(
            self.snapshot["model_config"]["runner_upstreams"]["claudecode"]["base_url"],
            "https://redacted.invalid/anthropic",
        )
        self.assertEqual(
            self.snapshot["model_config"]["model"], "[REDACTED: internal model deployment]"
        )
        for case in self.snapshot["cases"].values():
            self.assertRegex(
                case["environment_image"], r"^redacted\.invalid/source-image@sha256:[a-f0-9]{64}$"
            )
        self.assertNotRegex(
            json.dumps(self.snapshot),
            r"(?i)antchat|antgroup|alipay|antfin|https?://(?!redacted\.invalid/)|"
            r"/Users/|/home/|/root/|\b(?:\d{1,3}\.){3}\d{1,3}\b",
        )

    def test_published_totals_include_failed_and_screened_out_attempts(self):
        summary = evidence.summarize(self.snapshot)
        for runner, expected in {
            "harness": (8, 7, 4, 3),
            "codex": (9, 6, 3, 3),
            "claudecode": (6, 6, 6, 5),
        }.items():
            row = summary["totals"][runner]
            self.assertEqual(
                tuple(
                    row[key]
                    for key in (
                        "attempts",
                        "correct",
                        "normal_correct",
                        "selected_normal_correct",
                    )
                ),
                expected,
            )
        report = (ROOT / "docs/benchmarks/reports/perf-pro-five-report.md").read_text()
        self.assertIn(f"{evidence.START}\n{evidence.render(summary)}\n{evidence.END}", report)
        self.assertIn(
            f"{evidence.CASE_START}\n{evidence.render_cases(summary['case_comparisons'])}\n{evidence.CASE_END}",
            report,
        )

    def test_same_case_metrics_prefer_normal_success_and_label_partial_usage(self):
        rows = evidence.case_comparisons(self.snapshot)
        self.assertEqual(len(rows), 15)
        device_harness = rows[0]
        self.assertEqual(device_harness["attempt_number"], 22)
        self.assertEqual(device_harness["total_tokens"], 278223)
        self.assertAlmostEqual(device_harness["cache_hit_rate"], 214720 / 230895)
        self.assertEqual(device_harness["uncached_input_tokens"], 16175)
        self.assertEqual(device_harness["task_turns"], 1)
        self.assertEqual(device_harness["model_requests"], 28)
        query_codex = rows[4]
        self.assertTrue(query_codex["partial"])
        self.assertEqual(query_codex["usage_source"], "observer")
        self.assertEqual(query_codex["total_tokens"], 956774)
        self.assertEqual(query_codex["tool_unfinished"], 1)
        self.assertAlmostEqual(query_codex["tool_success_rate"], 25 / 31)
        self.assertFalse(query_codex["usage_complete"])

    def test_missing_usage_remains_unknown_instead_of_zero(self):
        for attempt in self.snapshot["attempts"]:
            if attempt["runner"] == "codex":
                attempt["usage"] = {}
                attempt.pop("trace_metrics", None)
        row = evidence.case_comparisons(self.snapshot)[1]
        self.assertEqual(row["usage_source"], "missing")
        self.assertIsNone(row["total_tokens"])
        self.assertIsNone(row["cache_hit_rate"])

    def test_pairing_uses_first_normal_success_and_requires_complete_usage(self):
        original = evidence.summarize(self.snapshot)["paired_metrics"]
        self.assertEqual(len(original["codex"]["time"]["pairs"]), 2)
        self.assertEqual(len(original["claudecode"]["time"]["pairs"]), 3)
        for baseline in original.values():
            self.assertEqual(baseline["tokens"], {"pairs": [], "median_ratio": None})
        faster = copy.deepcopy(self.snapshot["attempts"][-2])
        faster.update(attempt_id="later-faster-attempt", agent_duration_ms=1)
        self.snapshot["attempts"].append(faster)
        self.assertEqual(evidence.summarize(self.snapshot)["paired_metrics"], original)

    def test_empty_or_skipped_tests_cannot_qualify_as_correct(self):
        attempt = self.snapshot["attempts"][0]
        attempt["evaluation"]["metrics"].update(tests=0, passed=0)
        self.assertFalse(evidence.correct(attempt))
        attempt["evaluation"]["metrics"].update(tests=3, passed=3, skipped=1)
        self.assertFalse(evidence.correct(attempt))

    def test_duplicate_attempt_rejected_instead_of_inflating_cost(self):
        self.snapshot["attempts"].append(self.snapshot["attempts"][0])
        with self.assertRaisesRegex(ValueError, "duplicate"):
            evidence.summarize(self.snapshot)


if __name__ == "__main__":
    unittest.main()
