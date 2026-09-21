"""按题目配对汇总指标，计算描述性性能对照。"""

from __future__ import annotations

import itertools
import math
import statistics
from typing import Any, Iterable

TRACE_COUNTS = (
    "archived_requests",
    "model_reply_rounds",
    "tool_rounds",
    "multi_tool_rounds",
    "poll_only_rounds",
    "rounds_with_tool_failure",
    "process_tool_results",
)


def numeric(values: Iterable[object]) -> list[float]:
    return [
        float(value)
        for value in values
        if isinstance(value, (int, float)) and not isinstance(value, bool)
    ]


def percentile(values: list[float], percent: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(percent * len(ordered)) - 1)]


def median(values: Iterable[object]) -> float | None:
    numbers = numeric(values)
    return statistics.median(numbers) if numbers else None


def observed_tokens(trial: dict[str, Any]) -> float | None:
    """Return observed CLI usage only; initialized zero counters are not evidence."""
    agent = trial.get("agent", {})
    usage = agent.get("usage", {})
    values = [usage.get("input_tokens"), usage.get("output_tokens")]
    if agent.get("usage_observed") is not True or len(numeric(values)) != 2:
        return None
    return sum(values) if all(value >= 0 for value in values) else None


def all_attempt_metrics(items: list[dict[str, Any]]) -> dict[str, Any]:
    walls = numeric(item.get("total_duration_ms") for item in items)
    tokens = [observed_tokens(item) for item in items]
    known = numeric(tokens)
    complete = [
        value
        for item, value in zip(items, tokens)
        if value is not None
        and item.get("agent", {}).get("usage_unknown_steps", 0) == 0
        and item.get("agent", {}).get("terminal_event_seen") is True
    ]
    failures: dict[str, int] = {}
    for item in items:
        if item.get("status") == "passed":
            continue
        agent, evaluation = item.get("agent", {}), item.get("evaluation", {})
        if agent.get("execution_started") is not True:
            kind = "execution_infrastructure"
        elif agent.get("status") != "completed":
            kind = "agent_" + str(agent.get("termination_reason") or "incomplete")
        elif evaluation.get("valid") is not True:
            kind = "invalid_grading"
        else:
            kind = "quality_or_artifact_gate"
        failures[kind] = failures.get(kind, 0) + 1
    return {
        "attempts": len(items),
        "failures": failures,
        "total_wall_ms": {
            "observed": len(walls),
            "sum": sum(walls),
            "median": median(walls),
            "p95": percentile(walls, 0.95),
        },
        "tokens": {
            "observed_trials": len(known),
            "unknown_trials": len(items) - len(known),
            "observed_sum": sum(known),
            "complete_cli_trials": len(complete),
            "complete_cli_median": median(complete),
            "scope": "CLI telemetry; interrupted and auxiliary calls can be unmetered; not a billing total",
        },
        "delegation_observed_trials": sum(
            isinstance(item.get("agent", {}).get("delegation"), dict) for item in items
        ),
    }


def pairwise_comparisons(trials: list[dict[str, Any]], tolerance: float) -> list[dict[str, Any]]:
    """Descriptive, task/repeat matched comparisons; never infer a winner here.

    Failed/invalid trials score zero, retaining the official pro aggregation.
    Old reports without repeat IDs cannot silently acquire artificial pairs.
    """
    names = sorted({item["runner"] for item in trials})
    results = []
    for candidate, baseline in itertools.combinations(names, 2):
        selected = [item for item in trials if item["runner"] in (candidate, baseline)]
        row: dict[str, Any] = {
            "candidate": candidate,
            "baseline": baseline,
            "selection_status": "descriptive_only_no_winner",
        }
        groups: dict[str, dict[tuple[str, int], dict[str, Any]]] = {candidate: {}, baseline: {}}
        bad = False
        for item in selected:
            repeat = item.get("repeat")
            if not isinstance(repeat, int) or isinstance(repeat, bool) or not item.get("task_id"):
                bad = True
                continue
            key = (item["task_id"], repeat)
            if key in groups[item["runner"]]:
                bad = True
            groups[item["runner"]][key] = item
        left, right = groups[candidate], groups[baseline]
        keys = sorted(left.keys() & right.keys())
        row.update(
            {
                "status": "incomplete"
                if bad or left.keys() != right.keys() or not keys
                else "paired",
                "matched_pairs": len(keys),
                "missing_or_duplicate_pair_ids": bad,
                "candidate_unmatched": len(left.keys() - right.keys()),
                "baseline_unmatched": len(right.keys() - left.keys()),
            }
        )

        def score(item: dict[str, Any]) -> float:
            value = item.get("evaluation", {}).get("score")
            valid = (
                item.get("evaluation", {}).get("valid") is True
                and item.get("agent", {}).get("status") == "completed"
                and numeric([value])
            )
            return float(value) if valid else 0.0

        deltas = [score(left[key]) - score(right[key]) for key in keys]
        candidate_only = sum(
            left[k]["status"] == "passed" and right[k]["status"] != "passed" for k in keys
        )
        baseline_only = sum(
            right[k]["status"] == "passed" and left[k]["status"] != "passed" for k in keys
        )
        jointly_passed = [k for k in keys if left[k]["status"] == right[k]["status"] == "passed"]
        ratios = [
            left[k]["total_duration_ms"] / right[k]["total_duration_ms"]
            for k in jointly_passed
            if len(numeric([left[k].get("total_duration_ms"), right[k].get("total_duration_ms")]))
            == 2
            and left[k]["total_duration_ms"] > 0
            and right[k]["total_duration_ms"] > 0
        ]
        delta = statistics.mean(deltas) if deltas else None
        row.update(
            {
                "paired_score_delta_failed_as_zero": delta,
                "candidate_only_passed": candidate_only,
                "baseline_only_passed": baseline_only,
                "jointly_passed_pairs": len(jointly_passed),
                "quality_gate_observed": (delta >= -tolerance and candidate_only >= baseline_only)
                if row["status"] == "paired"
                else None,
                "joint_pass_time_ratio_geomean": statistics.geometric_mean(ratios)
                if ratios
                else None,
                "time_ratio_pairs": len(ratios),
                "time_ratio_scope": "joint successes only; examine all-attempt costs and failures separately",
            }
        )
        results.append(row)
    return results


def usage_total(trial: dict[str, Any]) -> float | None:
    agent = trial.get("agent", {})
    if agent.get("usage_observed") is False:
        return None
    usage = agent.get("usage", {})
    values = [usage.get("input_tokens"), usage.get("output_tokens")]
    if any(not isinstance(value, (int, float)) or isinstance(value, bool) for value in values):
        return None
    return sum(values) if all(value >= 0 for value in values) else None


def paired_comparisons(trials: list[dict[str, Any]]) -> dict[str, Any]:
    """Equal task weight; ratios only for tasks with successful trials on both sides."""
    result = {}
    metrics = {
        "agent_wall_ms": lambda trial: trial.get("agent", {}).get("duration_ms"),
        "total_wall_ms": lambda trial: trial.get("total_duration_ms"),
        "total_tokens": lambda trial: (
            usage_total(trial) if trial.get("agent", {}).get("usage_complete") is True else None
        ),
        "memory_peak_bytes": lambda trial: (
            trial.get("agent", {}).get("resources", {}).get("memory_peak_bytes")
        ),
        "cpu_usec": lambda trial: trial.get("agent", {}).get("resources", {}).get("cpu_usec"),
        "assistant_turns": lambda trial: (
            trial.get("agent", {}).get("activity", {}).get("assistant_turns")
        ),
        "tool_calls": lambda trial: trial.get("agent", {}).get("activity", {}).get("tool_calls"),
    }
    tasks = sorted({trial.get("task_id", "default") for trial in trials})
    for baseline in ("codex", "claudecode"):
        paired = {}
        for name, extract in metrics.items():
            pairs = []
            for task in tasks:
                values = {}
                for runner in ("harness", baseline):
                    values[runner] = median(
                        extract(trial)
                        for trial in trials
                        if trial["runner"] == runner
                        and trial.get("task_id", "default") == task
                        and trial["status"] == "passed"
                    )
                candidate, reference = values["harness"], values[baseline]
                if candidate is not None and reference is not None and reference > 0:
                    pairs.append(
                        {
                            "task_id": task,
                            "harness": candidate,
                            baseline: reference,
                            "ratio": candidate / reference,
                        }
                    )
            paired[name] = {
                "matched_tasks": len(pairs),
                "median_ratio": median(pair["ratio"] for pair in pairs),
                "pairs": pairs,
            }
        result[baseline] = paired
    return result


def aggregate(trials: list[dict[str, Any]], *, failed_as_zero: bool = False) -> dict[str, Any]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for trial in trials:
        groups.setdefault(trial["runner"], []).append(trial)
    result: dict[str, Any] = {}
    for runner, items in sorted(groups.items()):
        passed = [item for item in items if item["status"] == "passed"]
        scored = [item for item in items if item.get("evaluation", {}).get("valid") is True]
        measured = [
            item
            for item in scored
            if item.get("agent", {}).get("usage_observed") is not False
            and item.get("agent", {}).get("usage_unknown_steps", 0) == 0
            and len(
                numeric(
                    item.get("agent", {}).get("usage", {}).get(key)
                    for key in ("input_tokens", "output_tokens")
                )
            )
            == 2
            and (
                item.get("agent", {}).get("usage_observed") is True
                or sum(item["agent"]["usage"][key] for key in ("input_tokens", "output_tokens")) > 0
            )
        ]
        agent_wall = numeric(item.get("agent", {}).get("duration_ms") for item in passed)
        total_wall = numeric(item.get("total_duration_ms") for item in passed)
        cpu = numeric(item.get("agent", {}).get("resources", {}).get("cpu_usec") for item in passed)
        memory = numeric(
            item.get("agent", {}).get("resources", {}).get("memory_peak_bytes") for item in passed
        )
        scores = numeric(item.get("evaluation", {}).get("score") for item in scored)
        if failed_as_zero:
            scores = [
                float(item["evaluation"]["score"])
                if item.get("evaluation", {}).get("valid") is True
                and item.get("agent", {}).get("status") == "completed"
                else 0.0
                for item in items
            ]
        measured = [item for item in scored if usage_total(item) is not None]
        token_totals = [usage_total(item) for item in measured]
        cache_rates = [
            cached / input_tokens
            for item in measured
            for input_tokens in [item["agent"]["usage"]["input_tokens"]]
            for cached in [item["agent"]["usage"].get("cached_input_tokens")]
            if input_tokens > 0 and isinstance(cached, (int, float))
        ]
        tool_calls = sum(
            int(item.get("agent", {}).get("activity", {}).get("tool_calls", 0)) for item in scored
        )
        tool_successes = sum(
            int(item.get("agent", {}).get("activity", {}).get("tool_successes", 0))
            for item in scored
        )
        total_tokens = sum(token_totals)
        score_metric_names = sorted(
            {name for item in scored for name in item.get("evaluation", {}).get("metrics", {})}
        )
        result[runner] = {
            "all_attempts": {
                **all_attempt_metrics(items),
                "agent_wall_ms": sum(
                    numeric(item.get("agent", {}).get("duration_ms") for item in items)
                ),
                "observed_tokens": sum(
                    value for item in items if (value := usage_total(item)) is not None
                ),
                "usage_samples": sum(usage_total(item) is not None for item in items),
                "complete_usage_samples": sum(
                    item.get("agent", {}).get("usage_complete") is True for item in items
                ),
            },
            "trace_metrics": {
                "basis": "all recorded attempts; missing values excluded, not zero-filled",
                "samples": {
                    key: sum(type(item.get("trace_metrics", {}).get(key)) is int for item in items)
                    for key in TRACE_COUNTS
                },
                "median": {
                    key: median(item.get("trace_metrics", {}).get(key) for item in items)
                    for key in TRACE_COUNTS
                },
                "return_reason_counts": sum_trace_counts(items, "return_reason_counts"),
                "tool_failure_categories": sum_trace_counts(items, "tool_failure_categories"),
                "tool_breakdown": sum_trace_counts(items, "tool_breakdown"),
            },
            "attempts": len(items),
            "passed": len(passed),
            "scored": len(scored),
            "infrastructure_failures": sum(
                item.get("agent", {}).get("execution_started") is not True for item in items
            ),
            "success_rate": len(passed) / len(items),
            "score_mean": statistics.mean(scores) if scores else None,
            "score_metrics_mean": {
                name: statistics.mean(values) if values else None
                for name in score_metric_names
                for values in [
                    numeric(
                        item.get("evaluation", {}).get("metrics", {}).get(name) for item in scored
                    )
                ]
            },
            "agent_wall_ms": {
                "median": statistics.median(agent_wall) if agent_wall else None,
                "p95": percentile(agent_wall, 0.95),
            },
            "total_wall_ms": {
                "median": statistics.median(total_wall) if total_wall else None,
                "p95": percentile(total_wall, 0.95),
            },
            "grader_wall_ms_median": median(
                item.get("grader", {}).get("duration_ms") for item in passed
            ),
            "milestones_ms_median": {
                key: median(
                    item.get("agent", {}).get("milestones_ms", {}).get(key) for item in passed
                )
                for key in ("first_output", "first_tool")
            },
            "cpu_ms_median": statistics.median(cpu) / 1000 if cpu else None,
            "memory_peak_bytes_median": statistics.median(memory) if memory else None,
            "tokens_median": {
                key: statistics.median(values) if values else None
                for key in ("input_tokens", "cached_input_tokens", "output_tokens")
                for values in [
                    numeric(item.get("agent", {}).get("usage", {}).get(key) for item in measured)
                ]
            },
            "token_efficiency": {
                "total_tokens_median": statistics.median(token_totals) if token_totals else None,
                "uncached_input_tokens_median": median(
                    max(
                        0,
                        item["agent"]["usage"]["input_tokens"]
                        - item["agent"]["usage"]["cached_input_tokens"],
                    )
                    for item in measured
                    if isinstance(item["agent"]["usage"].get("cached_input_tokens"), (int, float))
                ),
                "cache_hit_rate_median": statistics.median(cache_rates) if cache_rates else None,
                "score_per_1k_tokens": sum(scores) / total_tokens * 1000
                if total_tokens > 0
                and len(measured) == len(items)
                and all(item.get("agent", {}).get("usage_complete", True) for item in measured)
                else None,
                "usage_samples": len(measured),
            },
            "activity_median": {
                key: median(item.get("agent", {}).get("activity", {}).get(key) for item in scored)
                for key in ("turns", "assistant_turns", "tool_calls")
            },
            "tool_success_rate": tool_successes / tool_calls if tool_calls else None,
        }
    return result


def comparison(summary: dict[str, Any], tolerance: float) -> dict[str, Any]:
    harness = summary.get("harness")
    codex = summary.get("codex")
    missing = [
        name
        for name, values in (("harness", harness), ("codex", codex))
        if not values or not values["scored"]
    ]
    if missing:
        return {
            "status": "incomplete",
            "candidate": "harness",
            "baseline": "codex",
            "reason": f"no valid scored samples for: {', '.join(missing)}",
            "score_regression_tolerance": tolerance,
        }
    assert harness is not None and codex is not None
    score_delta = harness["score_mean"] - codex["score_mean"]
    performance_complete = bool(harness["passed"] and codex["passed"])
    values: dict[str, Any] = {
        "status": "complete" if performance_complete else "effect_only",
        "candidate": "harness",
        "baseline": "codex",
        "score_regression_tolerance": tolerance,
        "score_delta": score_delta,
        "score_regression": score_delta < -tolerance,
    }
    if not performance_complete:
        values["reason"] = "both runners need a passing sample for performance deltas"
        return values
    for name, path in (
        ("total_wall_ms", ("total_wall_ms", "median")),
        ("total_tokens", ("token_efficiency", "total_tokens_median")),
        ("assistant_turns", ("activity_median", "assistant_turns")),
        ("tool_calls", ("activity_median", "tool_calls")),
    ):
        candidate = harness[path[0]][path[1]]
        baseline = codex[path[0]][path[1]]
        values[name] = {
            "harness": candidate,
            "codex": baseline,
            "delta": candidate - baseline
            if candidate is not None and baseline is not None
            else None,
            "ratio": candidate / baseline
            if candidate is not None and baseline not in {None, 0}
            else None,
        }
    return values


def sum_trace_counts(items: list[dict[str, Any]], name: str) -> dict[str, int] | None:
    observed = [
        item["trace_metrics"][name] for item in items if name in item.get("trace_metrics", {})
    ]
    if not observed:
        return None
    return {
        key: sum(counts.get(key, 0) for counts in observed)
        for key in sorted({key for counts in observed for key in counts})
    }
