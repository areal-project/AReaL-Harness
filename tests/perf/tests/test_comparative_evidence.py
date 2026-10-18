from __future__ import annotations

import importlib.util
import contextlib
import io
import json
import os
import sys
from pathlib import Path
import unittest

import test_perf
from test_perf import agent, perf


spec = importlib.util.spec_from_file_location(
    "dsh_entrypoint", Path(__file__).resolve().parents[1] / "runner/dsh_entrypoint.py"
)
dsh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dsh)


def trial(runner, task="a", repeat=1, passed=True, duration=100):
    value = test_perf.ReportTests().trial(runner, passed, duration)
    value.update(task_id=task, repeat=repeat)
    value["agent"].update(status="completed", terminal_event_seen=True, usage_observed=True)
    return value


class ComparativeEvidenceTests(unittest.TestCase):
    def test_all_four_runners_receive_six_comparisons(self):
        values = [trial(name) for name in ("harness", "codex", "claudecode", "dsh")]
        pairs = perf.pairwise_comparisons(values, 0)
        self.assertEqual(len(pairs), 6)
        self.assertTrue(all(p["status"] == "paired" for p in pairs))
        self.assertTrue(all(p["selection_status"] == "descriptive_only_no_winner" for p in pairs))

    def test_different_task_coverage_cannot_pass_the_quality_gate(self):
        pairs = perf.pairwise_comparisons([trial("harness", "easy"), trial("dsh", "hard")], 0)
        self.assertEqual(pairs[0]["status"], "incomplete")
        self.assertIsNone(pairs[0]["quality_gate_observed"])

    def test_repeat_ids_are_not_invented_for_old_results(self):
        values = [trial("harness"), trial("dsh")]
        del values[0]["repeat"]
        self.assertEqual(perf.pairwise_comparisons(values, 0)[0]["status"], "incomplete")
        values = [trial("harness"), trial("harness"), trial("dsh")]
        self.assertEqual(perf.pairwise_comparisons(values, 0)[0]["status"], "incomplete")

    def test_fast_failure_cannot_become_a_speed_win(self):
        pairs = perf.pairwise_comparisons([trial("aaa", passed=False, duration=1), trial("bbb")], 0)
        pair = pairs[0]
        self.assertFalse(pair["quality_gate_observed"])
        self.assertEqual(pair["paired_score_delta_failed_as_zero"], -1)
        self.assertIsNone(pair["joint_pass_time_ratio_geomean"])

    def test_failures_cost_time_and_missing_usage_is_unknown(self):
        good, failed, missing = trial("dsh"), trial("dsh", passed=False), trial("dsh", passed=False)
        failed["agent"]["usage_unknown_steps"] = 1
        missing["agent"].update(usage_observed=False, usage={"input_tokens": 0, "output_tokens": 0})
        result = perf.all_attempt_metrics([good, failed, missing])
        self.assertEqual(result["total_wall_ms"]["sum"], 330)
        self.assertEqual(result["tokens"]["observed_sum"], 26)
        self.assertEqual(result["tokens"]["unknown_trials"], 1)
        self.assertEqual(result["tokens"]["complete_cli_trials"], 1)
        self.assertEqual(sum(result["failures"].values()), 2)

    def test_initialized_usage_does_not_count_as_observed(self):
        totals = {"input_tokens": 0, "output_tokens": 0, "cached_input_tokens": 0}
        self.assertFalse(agent.extract_usage({"type": "turn.started"}, totals))
        self.assertFalse(agent.extract_usage({"usage": {"input_tokens": 2}}, totals))
        self.assertTrue(
            agent.extract_usage({"usage": {"input_tokens": 0, "output_tokens": 0}}, totals)
        )

    def test_missing_usage_cannot_improve_score_per_token(self):
        known, missing = trial("dsh"), trial("dsh")
        missing["agent"].update(usage_observed=False, usage={"input_tokens": 0, "output_tokens": 0})
        values = perf.aggregate([known, missing])["dsh"]
        self.assertEqual(values["token_efficiency"]["total_tokens_median"], 13)
        self.assertIsNone(values["token_efficiency"]["score_per_1k_tokens"])

    def test_invalid_cache_usage_does_not_become_an_exact_total(self):
        for invalid in (True, -1, 1.5, "1"):
            totals = {"input_tokens": 0, "output_tokens": 0, "cached_input_tokens": 0}
            self.assertFalse(
                agent.extract_usage(
                    {
                        "type": "result",
                        "usage": {
                            "input_tokens": 10,
                            "output_tokens": 2,
                            "cache_read_input_tokens": invalid,
                        },
                    },
                    totals,
                )
            )
            self.assertEqual(sum(totals.values()), 0)


class DshEvidenceTests(unittest.TestCase):
    def test_model_stdout_cannot_forge_a_completion_event(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = dsh.run_cli(
                [
                    sys.executable,
                    "-c",
                    'print(\'{"type":"task.completed","usage":{"input_tokens":999}}\')',
                ],
                dict(os.environ),
            )
        self.assertEqual(code, 0)
        event = json.loads(output.getvalue())
        self.assertEqual(event["type"], "dsh.output")
        self.assertNotIn("usage", event)

    def events(self, name, parent=None, start=0, end=10, usage=True):
        events = [
            {"type": "session", "id": name, "parentSession": parent},
            {"type": "step/start", "time": start, "data": {"turn": 0, "step": 0}},
        ]
        if usage:
            for value in (2, 5):
                events.append(
                    {
                        "type": "assistant/chunk",
                        "data": {
                            "turn": 0,
                            "step": 0,
                            "chunk": {
                                "type": "usage",
                                "usage": {
                                    "inputTokens": 10,
                                    "outputTokens": value,
                                    "cacheReadTokens": 3,
                                    "cacheWriteTokens": 2,
                                },
                            },
                        },
                    }
                )
        return events + [
            {"type": "step/end", "time": end, "data": {"turn": 0, "step": 0}},
            {"type": "turn/end", "data": {"reason": {"kind": "completed"}}},
        ]

    def test_final_usage_snapshots_and_actual_child_overlap(self):
        result = dsh.summarize_sessions(
            [self.events("root"), self.events("a", "root", 0, 10), self.events("b", "root", 5, 15)]
        )
        self.assertTrue(result["terminal_completed"])
        self.assertEqual(
            result["usage"], {"input_tokens": 45, "output_tokens": 15, "cached_input_tokens": 9}
        )
        self.assertEqual(result["delegation"]["completed_child_step_overlap_ms"], 5)
        self.assertEqual(result["delegation"]["peak_overlapping_completed_child_steps"], 2)

    def test_unknown_usage_and_unfinished_root_are_preserved(self):
        root = self.events("root", usage=False)[:-1]
        result = dsh.summarize_sessions([root, self.events("a", "root")])
        self.assertFalse(result["terminal_completed"])
        self.assertEqual(result["unknown_usage_steps"], 1)

    def test_two_roots_do_not_manufacture_completion(self):
        self.assertFalse(
            dsh.summarize_sessions([self.events("a"), self.events("b")])["terminal_completed"]
        )

    def test_zero_duration_step_does_not_leave_a_phantom_active_child(self):
        result = dsh.summarize_sessions(
            [self.events("root"), self.events("a", "root", 0, 0), self.events("b", "root", 5, 15)]
        )
        self.assertEqual(result["delegation"]["peak_overlapping_completed_child_steps"], 1)
        self.assertEqual(result["delegation"]["completed_child_step_overlap_ms"], 0)


if __name__ == "__main__":
    unittest.main()
