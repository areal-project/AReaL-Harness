"""将评测汇总渲染为终端报告。"""

from __future__ import annotations

import math
import os
import sys
from typing import Any

from perf_metrics import TRACE_COUNTS, aggregate, comparison


def display_number(value: object, digits: int = 1) -> str:
    return "n/a" if value is None else f"{float(value):.{digits}f}"


def display_percent(value: object) -> str:
    return "n/a" if value is None else f"{float(value):.1%}"


def display_count(value: object) -> str:
    return "n/a" if value is None else f"{float(value):,.0f}"


def display_duration(value: object) -> str:
    if value is None:
        return "n/a"
    milliseconds = float(value)
    return f"{milliseconds / 1000:.2f} s" if abs(milliseconds) >= 1000 else f"{milliseconds:.1f} ms"


def terminal_supports_color(stream: Any | None = None) -> bool:
    target = stream or sys.stdout
    return (
        "NO_COLOR" not in os.environ
        and os.environ.get("TERM") != "dumb"
        and bool(getattr(target, "isatty", lambda: False)())
    )


def styled(text: str, *codes: str, enabled: bool) -> str:
    if not enabled or not codes:
        return text
    return f"\033[{';'.join(codes)}m{text}\033[0m"


def format_table(
    headers: list[str], rows: list[list[str]], right: set[int] | None = None
) -> list[str]:
    right = right or set()
    widths = [max(len(row[index]) for row in [headers, *rows]) for index in range(len(headers))]

    def format_row(row: list[str]) -> str:
        cells = [
            value.rjust(widths[index]) if index in right else value.ljust(widths[index])
            for index, value in enumerate(row)
        ]
        return "  ".join(cells).rstrip()

    return [
        format_row(headers),
        "  ".join("-" * width for width in widths),
        *(format_row(row) for row in rows),
    ]


def ordered_runners(summary: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    preferred = [
        name for name in ("harness", "codex", "claudecode", "dsh", "fixture") if name in summary
    ]
    return [(name, summary[name]) for name in [*preferred, *sorted(set(summary) - set(preferred))]]


def render_report(run: dict[str, Any], *, color: bool = False) -> str:
    summary = run.get("summary") or aggregate(
        run.get("trials", []), failed_as_zero=run["task"].get("suite") == "pro"
    )
    comparison_result = run.get("comparison") or comparison(summary, 0.0)
    runners = ordered_runners(summary)
    model_config = run.get("model_config")
    model_detail = "not applicable"
    if model_config:
        model_detail = (
            f"{model_config['model']} via {model_config['protocol']} at "
            f"{model_config['base_url']} (key: ${model_config['api_key_env']})"
        )
        for runner, upstream in model_config.get("runner_upstreams", {}).items():
            model_detail += f"; {runner}: {upstream['protocol']} at {upstream['base_url']}"
    runtime_detail = run.get("harness_runtime")
    if runtime_detail:
        runtime_detail = (
            f"{runtime_detail['protocol_version']} via {runtime_detail['sandbox_profile']}"
        )
    else:
        runtime_detail = "not observed"

    bold = "1"
    dim = "2"
    red = "31"
    green = "32"
    yellow = "33"
    cyan = "36"

    def heading(value: str) -> str:
        return styled(value, bold, cyan, enabled=color)

    comparison_status = comparison_result["status"]
    if comparison_status == "incomplete":
        gate, gate_color = "INCOMPLETE", yellow
        result_detail = comparison_result["reason"]
    else:
        failed_gate = comparison_result["score_regression"]
        gate, gate_color = ("FAIL", red) if failed_gate else ("PASS", green)
        result_detail = f"Harness - Codex score {comparison_result['score_delta']:+.3f}"
        if comparison_status == "complete":
            time_ratio = comparison_result["total_wall_ms"]["ratio"]
            token_ratio = comparison_result["total_tokens"]["ratio"]
            details = []
            if time_ratio is not None:
                details.append(f"time {(time_ratio - 1) * 100:+.1f}%")
            if token_ratio is not None:
                details.append(f"tokens {(token_ratio - 1) * 100:+.1f}%")
            if details:
                result_detail += "; " + ", ".join(details)
            if comparison_result.get("performance_basis"):
                result_detail += f"; paired successful tasks: time={comparison_result['total_wall_ms'].get('matched_tasks', 0)}, tokens={comparison_result['total_tokens'].get('matched_tasks', 0)}"

    source = run["provenance"]["git"].get("commit") or "unknown"
    task_images = run["provenance"].get("task_images", {})
    image_detail = run["provenance"]["image"]["reference"]
    image_architecture = run["provenance"]["image"].get("architecture") or "unknown"
    if task_images:
        image_detail = f"{len(task_images)} task images (provenance.task_images)"
        image_architecture = ", ".join(
            sorted({item.get("architecture") or "unknown" for item in task_images.values()})
        )
    if run["provenance"]["git"].get("dirty"):
        source += styled(" (dirty)", yellow, enabled=color)
    trials = run.get("trials", [])
    passed_trials = sum(trial.get("status") == "passed" for trial in trials)
    planned_trials = run.get("planned_trials") or len(trials)
    incomplete = run.get("status") == "paused" or len(trials) < planned_trials
    overall = (
        "INCOMPLETE"
        if incomplete or not trials
        else "PASS"
        if passed_trials == len(trials)
        else "FAIL"
    )
    overall_color = green if overall == "PASS" else red if overall == "FAIL" else yellow
    lines = [
        "",
        styled("AReaL-Harness local E2E/perf", bold, enabled=color),
        f"{run['task']['id']}  |  {run['run_id']}",
        f"Result  {styled(overall, bold, overall_color, enabled=color)}  {passed_trials}/{len(trials)} recorded trials passed; {len(trials)}/{planned_trials} completed; {result_detail}",
        "",
        heading("Run"),
        f"Created       {run['created_at']}",
        f"Source        {source}",
        f"Runner image  {image_detail}",
        f"Platform      host {run['provenance'].get('host_architecture', 'unknown')}, "
        f"image {image_architecture}",
        f"Model         {model_detail}",
        f"Harness path  TUI -> Rust Core -> {runtime_detail}"
        if (run.get("harness_runtime") or {}).get("harness") == "tui-core-runtime"
        else f"Harness path  perf adapter -> {runtime_detail}",
        "",
        heading("Effect and agent efficiency"),
    ]
    effect_rows: list[list[str]] = []
    for runner, values in runners:
        success = f"{values['passed']}/{values['attempts']} ({values['success_rate']:.0%})"
        activity = values["activity_median"]
        efficiency = values["token_efficiency"]
        effect_rows.append(
            [
                runner.title(),
                str(values["scored"]),
                display_number(values["score_mean"], 3),
                success,
                f"{display_number(activity['turns'], 0)} / {display_number(activity['assistant_turns'], 0)}",
                display_number(activity["tool_calls"], 1),
                display_percent(values["tool_success_rate"]),
                display_number(efficiency["score_per_1k_tokens"], 3),
            ]
        )
    effect_table = format_table(
        [
            "Runner",
            "Scored",
            "Score",
            "Success",
            "Task / model turns",
            "Tools",
            "Tool success",
            "Score/kTok",
        ],
        effect_rows,
        set(range(1, 8)),
    )
    lines.extend(
        [
            styled(effect_table[0], bold, enabled=color),
            styled(effect_table[1], dim, enabled=color),
            *effect_table[2:],
            "",
            heading("Tool loop - median of all recorded attempts"),
        ]
    )
    loop_rows = []
    for runner, values in runners:
        trace = values.get("trace_metrics", {})
        counts = trace.get("median", {})
        loop_rows.append(
            [
                runner.title(),
                *[display_count(counts.get(key)) for key in TRACE_COUNTS[:6]],
                f"{trace.get('samples', {}).get('model_reply_rounds', 0)}/{values['attempts']}",
            ]
        )
    lines.extend(
        format_table(
            [
                "Runner",
                "Requests",
                "Replies",
                "Tool rounds",
                "Multi-tool",
                "Poll-only",
                "Failure rounds",
                "Core samples",
            ],
            loop_rows,
            set(range(1, 8)),
        )
    )
    lines.extend(
        [
            "Core reply markers define rounds; poll-only and failure rounds may overlap. CLI rounds are n/a.",
            "",
            heading("Token usage - median scored trial"),
        ]
    )
    token_rows: list[list[str]] = []
    grader_metric_lines: list[str] = []
    for runner, values in runners:
        tokens = values["tokens_median"]
        efficiency = values["token_efficiency"]
        token_rows.append(
            [
                runner.title(),
                display_count(tokens["input_tokens"]),
                display_count(tokens["cached_input_tokens"]),
                display_count(efficiency["uncached_input_tokens_median"]),
                display_percent(efficiency["cache_hit_rate_median"]),
                display_count(tokens["output_tokens"]),
                display_count(efficiency["total_tokens_median"]),
            ]
        )
        if values["score_metrics_mean"]:
            metrics = ", ".join(
                f"{name} {display_number(value, 3)}"
                for name, value in values["score_metrics_mean"].items()
            )
            grader_metric_lines.append(f"{runner.title()} grader metrics: {metrics}")
    token_table = format_table(
        ["Runner", "Input", "Cached", "Uncached", "Cache hit", "Output", "Total"],
        token_rows,
        set(range(1, 7)),
    )
    lines.extend(
        [
            styled(token_table[0], bold, enabled=color),
            styled(token_table[1], dim, enabled=color),
            *token_table[2:],
            *grader_metric_lines,
            "",
            heading("Performance - passing trials only"),
        ]
    )
    performance_rows: list[list[str]] = []
    for runner, values in runners:
        milestones = values["milestones_ms_median"]
        memory = values["memory_peak_bytes_median"]
        performance_rows.append(
            [
                runner.title(),
                display_duration(values["agent_wall_ms"]["median"]),
                display_duration(values["agent_wall_ms"]["p95"]),
                display_duration(values["total_wall_ms"]["median"]),
                display_duration(milestones["first_output"]),
                display_duration(milestones["first_tool"]),
                display_duration(values["grader_wall_ms_median"]),
                display_duration(values["cpu_ms_median"]),
                "n/a" if memory is None else f"{memory / 1024 / 1024:.1f} MiB",
            ]
        )
    performance_table = format_table(
        [
            "Runner",
            "Agent med",
            "Agent p95",
            "Total med",
            "First output",
            "First tool",
            "Grader",
            "CPU",
            "Peak RAM",
        ],
        performance_rows,
        set(range(1, 9)),
    )
    lines.extend(
        [
            styled(performance_table[0], bold, enabled=color),
            styled(performance_table[1], dim, enabled=color),
            *performance_table[2:],
            "",
            heading("Comparison - Harness vs Codex"),
        ]
    )
    if comparison_result["status"] == "incomplete":
        lines.append(
            f"Effect gate  {styled('INCOMPLETE', bold, yellow, enabled=color)}  {comparison_result['reason']}"
        )
    else:
        gate = "FAIL" if comparison_result["score_regression"] else "PASS"
        lines.append(
            f"Effect gate  {styled(gate, bold, red if gate == 'FAIL' else green, enabled=color)}  "
            f"Harness - Codex score "
            f"{comparison_result['score_delta']:+.3f} "
            f"(allowed regression {comparison_result['score_regression_tolerance']:.3f})"
        )
        if comparison_result["status"] == "effect_only":
            lines.append(
                f"Performance  {styled('INCOMPLETE', bold, yellow, enabled=color)}  {comparison_result['reason']}"
            )
        else:
            comparison_rows: list[list[str]] = []
            for label, key, formatter, directional in (
                ("Total time", "total_wall_ms", display_duration, True),
                ("Total tokens", "total_tokens", display_count, True),
                ("Model turns", "assistant_turns", lambda value: display_number(value, 1), False),
                ("Tool calls", "tool_calls", lambda value: display_number(value, 1), False),
            ):
                metric = comparison_result[key]
                ratio = metric["ratio"]
                change = None if ratio is None else (ratio - 1) * 100
                if ratio is None or math.isclose(ratio, 1.0, rel_tol=0.005):
                    verdict = "SAME"
                elif directional:
                    verdict = "LOWER" if ratio < 1 else "HIGHER"
                else:
                    verdict = "FEWER" if ratio < 1 else "MORE"
                comparison_rows.append(
                    [
                        label,
                        formatter(metric["harness"]),
                        formatter(metric["codex"]),
                        "n/a" if ratio is None else f"{ratio:.2f}x",
                        "n/a" if change is None else f"{change:+.1f}%",
                        verdict,
                    ]
                )
            comparison_table = format_table(
                ["Metric", "Harness", "Codex", "Ratio", "Change", "Reading"],
                comparison_rows,
                {1, 2, 3, 4},
            )
            colored_comparison_rows = []
            verdict_colors = {
                "LOWER": green,
                "HIGHER": red,
                "FEWER": cyan,
                "MORE": yellow,
                "SAME": dim,
            }
            for row, line in zip(comparison_rows, comparison_table[2:]):
                verdict = row[-1]
                colored_comparison_rows.append(
                    line[: -len(verdict)] + styled(verdict, verdict_colors[verdict], enabled=color)
                )
            lines.extend(
                [
                    styled(comparison_table[0], bold, enabled=color),
                    styled(comparison_table[1], dim, enabled=color),
                    *colored_comparison_rows,
                ]
            )
    failed = [trial for trial in run.get("trials", []) if trial["status"] != "passed"]
    if failed:
        lines.extend(["", heading("Failures")])
        for trial in failed:
            agent = trial.get("agent", {})
            reason = (
                agent.get("error")
                or agent.get("termination_reason")
                or trial.get("grader", {}).get("status")
            )
            lines.append(
                styled(f"{trial['sequence']:03d}-{trial['runner']}  {reason}", red, enabled=color)
            )
    infrastructure = [
        trial
        for trial in run.get("trials", [])
        if trial.get("agent", {}).get("execution_started") is not True
    ]
    if infrastructure:
        lines.append(
            "Infrastructure failures count as zero in pro scores."
            if run.get("task", {}).get("suite") == "pro"
            else "Infrastructure failures are excluded from scores and comparison deltas."
        )
    lines.extend(
        [
            "",
            heading("Metric notes"),
            "Score/kTok  Total score / total input+output tokens x 1,000; higher is better. "
            "With a binary grader, it mainly reflects token cost.",
            "Cache hit    Cached input / input tokens. Compare the absolute Cached and Uncached "
            "columns, not this percentage alone.",
            styled("Values are medians unless the section says otherwise.", dim, enabled=color),
        ]
    )
    if run.get("per_case"):
        names = [name for name, _ in runners]
        lines.extend(["", heading("Pro case scores (failed_as_zero)")])
        lines.extend(
            format_table(
                ["Case", *names],
                [
                    [
                        case_id,
                        *[
                            display_number(values.get(name, {}).get("score_mean"), 3)
                            for name in names
                        ],
                    ]
                    for case_id, values in run["per_case"].items()
                ],
            )
        )
    lines.extend(["", heading("All attempts (including failures)")])
    lines.extend(
        format_table(
            ["Runner", "Time sum", "Observed tokens", "Unknown usage trials"],
            [
                [
                    name,
                    display_duration(values["all_attempts"]["total_wall_ms"]["sum"]),
                    display_count(values["all_attempts"]["tokens"]["observed_sum"]),
                    str(values["all_attempts"]["tokens"]["unknown_trials"]),
                ]
                for name, values in runners
                if "all_attempts" in values
            ],
        )
    )
    pairs = run.get("pairwise_comparisons", [])
    if pairs:
        lines.extend(["", heading("Paired comparisons (descriptive; no winner selected)")])
        lines.extend(
            format_table(
                [
                    "Candidate / baseline",
                    "Status",
                    "Pairs",
                    "Score delta",
                    "Both passed",
                    "Time ratio",
                ],
                [
                    [
                        f"{pair['candidate']} / {pair['baseline']}",
                        pair["status"],
                        str(pair["matched_pairs"]),
                        display_number(pair["paired_score_delta_failed_as_zero"], 3),
                        str(pair["jointly_passed_pairs"]),
                        display_number(pair["joint_pass_time_ratio_geomean"], 3),
                    ]
                    for pair in pairs
                ],
            )
        )
        lines.append(
            "Time ratios cover joint successes only. A missing usage record is unknown, never zero."
        )
    return "\n".join(lines)
