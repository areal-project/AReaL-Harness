#!/usr/bin/env python3
"""Recompute historical benchmark tables from the portable measurement snapshot.

This checks aggregation, not the original task solutions. Fresh task execution
and scoring use scripts/perf run; the snapshot contains no private workspaces.
"""

from __future__ import annotations

import argparse
import json
import statistics
from pathlib import Path

RUNNERS = {"harness": "AReaL-Harness", "codex": "Codex", "claudecode": "Claude Code"}
START = "<!-- benchmark-summary:start -->"
END = "<!-- benchmark-summary:end -->"
CASE_START = "<!-- benchmark-cases:start -->"
CASE_END = "<!-- benchmark-cases:end -->"


def correct(attempt: dict) -> bool:
    evaluation = attempt["evaluation"]
    metrics = evaluation.get("metrics", {})
    return (
        evaluation.get("valid") is True
        and evaluation.get("score") == 1
        and metrics.get("tests", 0) > 0
        and metrics.get("passed") == metrics["tests"]
        and all(metrics.get(key) == 0 for key in ("failed", "other", "pending", "skipped"))
    )


def tokens(attempt: dict) -> int | None:
    usage = attempt.get("usage") or {}
    counts = [usage.get("input_tokens"), usage.get("output_tokens")]
    return sum(counts) if all(isinstance(value, int) for value in counts) else None


def case_comparisons(evidence: dict) -> list[dict]:
    """Prefer first normal success; expose the first correct partial run otherwise."""
    rows = []
    for task in evidence["qualified_cases"]:
        for runner in RUNNERS:
            candidates = [
                attempt
                for attempt in evidence["attempts"]
                if attempt["task_id"] == task and attempt["runner"] == runner and correct(attempt)
            ]
            if not candidates:
                raise ValueError(f"qualified task has no correct attempt: {task}/{runner}")
            attempt = next(
                (a for a in candidates if a["agent_status"] == "completed"),
                candidates[0],
            )
            partial = attempt["agent_status"] != "completed"
            usage = attempt.get("usage") or {}
            source = "CLI" if tokens(attempt) is not None else "missing"
            trace = attempt.get("trace_metrics", {})
            if source == "missing" and trace.get("observed_usage"):
                usage = trace["observed_usage"]
                source = "observer"
            input_tokens, cached, output_tokens = (
                usage.get(key) for key in ("input_tokens", "cached_input_tokens", "output_tokens")
            )
            fresh = (
                input_tokens - cached if input_tokens is not None and cached is not None else None
            )
            activity = attempt["activity"]
            unfinished = (
                activity["tool_calls"] - activity["tool_successes"] - activity["tool_failures"]
            )
            if unfinished < 0:
                raise ValueError("tool outcomes exceed the number of calls")
            rows.append(
                {
                    "task_id": task,
                    "task_title": evidence["cases"][task].get("title", task),
                    "runner": runner,
                    "attempt_id": attempt["attempt_id"],
                    "attempt_number": evidence["attempts"].index(attempt) + 1,
                    "agent_status": attempt["agent_status"],
                    "partial": partial,
                    "usage_source": source,
                    "usage_complete": attempt["usage_complete"],
                    "input_tokens": input_tokens,
                    "cached_input_tokens": cached,
                    "uncached_input_tokens": fresh,
                    "output_tokens": output_tokens,
                    "total_tokens": input_tokens + output_tokens
                    if input_tokens is not None and output_tokens is not None
                    else None,
                    "cache_hit_rate": cached / input_tokens
                    if cached is not None and input_tokens
                    else None,
                    "task_turns": activity["turns"],
                    "model_requests": attempt["model_requests"],
                    "tool_successes": activity["tool_successes"],
                    "tool_failures": activity["tool_failures"],
                    "tool_unfinished": unfinished,
                    "tool_success_rate": activity["tool_successes"] / activity["tool_calls"]
                    if activity["tool_calls"]
                    else None,
                    "agent_seconds": attempt["agent_duration_ms"] / 1000,
                    "observed_model_seconds": attempt["observed_model_ms"] / 1000,
                    "archived_requests": trace.get("archived_requests"),
                    "requests_with_usage": trace.get("usage_requests"),
                    "first_byte_ms_p50": trace.get("first_byte_ms_p50"),
                    **{
                        key: trace.get(key)
                        for key in (
                            "model_reply_rounds",
                            "tool_rounds",
                            "multi_tool_rounds",
                            "poll_only_rounds",
                            "rounds_with_tool_failure",
                            "return_reason_counts",
                            "tool_failure_categories",
                        )
                    },
                }
            )
    return rows


def summarize(evidence: dict) -> dict:
    if evidence.get("schema_version") != 2:
        raise ValueError("expected evidence schema_version = 2")
    attempts = evidence["attempts"]
    ids = [attempt["attempt_id"] for attempt in attempts]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate attempt_id would double-count costs")
    selected = evidence["qualified_cases"]
    first = {}
    totals = {}
    for runner in RUNNERS:
        rows = [row for row in attempts if row["runner"] == runner]
        good = [row for row in rows if correct(row)]
        normal = [row for row in good if row["agent_status"] == "completed"]
        for row in normal:
            if row["task_id"] in selected:
                first.setdefault((runner, row["task_id"]), row)
        usage = [tokens(row) for row in rows if tokens(row) is not None]
        totals[runner] = {
            "attempts": len(rows),
            "correct": len(good),
            "normal_correct": len(normal),
            "selected_normal_correct": len({row["task_id"] for row in normal} & set(selected)),
            "timeouts": sum(row["agent_status"] == "timeout" for row in rows),
            "failures": sum(row["agent_status"] == "failed" for row in rows),
            "agent_ms": sum(row["agent_duration_ms"] for row in rows),
            "reported_tokens": sum(usage) if usage else None,
            "reported_usage_attempts": len(usage),
            "complete_usage_attempts": sum(row["usage_complete"] for row in rows),
        }
    pairs = {}
    for baseline in ("codex", "claudecode"):
        metrics = {name: [] for name in ("time", "cpu", "memory", "tokens")}
        for task in selected:
            harness, other = first.get(("harness", task)), first.get((baseline, task))
            if harness is None or other is None:
                continue
            values = {
                "time": (harness["agent_duration_ms"], other["agent_duration_ms"]),
                "cpu": (
                    harness["resources"].get("cpu_usec"),
                    other["resources"].get("cpu_usec"),
                ),
                "memory": (
                    harness["resources"].get("memory_peak_bytes"),
                    other["resources"].get("memory_peak_bytes"),
                ),
            }
            if harness["usage_complete"] and other["usage_complete"]:
                values["tokens"] = (tokens(harness), tokens(other))
            for name, (left, right) in values.items():
                if left is not None and right is not None and right > 0:
                    metrics[name].append({"task_id": task, "ratio": left / right})
        pairs[baseline] = {
            name: {
                "pairs": rows,
                "median_ratio": statistics.median(row["ratio"] for row in rows) if rows else None,
            }
            for name, rows in metrics.items()
        }
    return {
        "totals": totals,
        "paired_metrics": pairs,
        "case_comparisons": case_comparisons(evidence),
    }


def render_cases(rows: list[dict]) -> str:
    lines = [
        "| 题目 | Agent / 尝试 | 结束状态 | 模型请求轮次 | 工具成功 / 失败 / 未结束（成功率） | 缓存命中率 | 总 token | 耗时 s |",
        "|---|---|---|---:|---:|---:|---:|---:|",
    ]
    for row in rows:
        suffix = "†" if row["partial"] else ""
        cache = f"{row['cache_hit_rate']:.2%}{suffix}" if row["cache_hit_rate"] is not None else "—"
        total = f"{row['total_tokens']:,}{suffix}" if row["total_tokens"] is not None else "—"
        tools = f"{row['tool_successes']} / {row['tool_failures']} / {row['tool_unfinished']}"
        rate = f"{row['tool_success_rate']:.1%}" if row["tool_success_rate"] is not None else "—"
        status = {"completed": "正常", "failed": "失败†", "timeout": "超时†"}[row["agent_status"]]
        lines.append(
            f"| {row['task_title']} | {RUNNERS[row['runner']]} #{row['attempt_number']} | {status} | {row['model_requests']} | {tools}（{rate}） | {cache} | {total} | {row['agent_seconds']:,.1f} |"
        )
    lines.extend(
        [
            "",
            "输入 / 输出拆分（缓存 token 已包含在输入中，不重复累加）：",
            "",
            "| 题目 / Agent | 输入 token | 其中缓存读取 | 未缓存输入 | 输出 token | 用量来源 / 归档请求覆盖 |",
            "|---|---:|---:|---:|---:|---|",
        ]
    )
    for row in rows:
        values = [
            f"{row[key]:,}" if row[key] is not None else "—"
            for key in (
                "input_tokens",
                "cached_input_tokens",
                "uncached_input_tokens",
                "output_tokens",
            )
        ]
        source = {"CLI": "CLI", "observer": "逐请求观测", "missing": "缺失"}[row["usage_source"]]
        suffix = "†" if row["partial"] else ""
        archived = row["archived_requests"] if row["archived_requests"] is not None else "—"
        lines.append(
            f"| {row['task_title']} / {RUNNERS[row['runner']]}{suffix} | "
            + " | ".join(values)
            + f" | {source}；{archived}/{row['model_requests']} |"
        )
    return "\n".join(lines)


def render(summary: dict) -> str:
    lines = [
        "| Agent | 尝试数 | 答案全对 | 正常结束且全对 | 超时 / 运行失败 | 全部 Agent 时间 | CLI 已报告 token（上报覆盖） | 公共完整用量覆盖 |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for runner, name in RUNNERS.items():
        row = summary["totals"][runner]
        usage = f"{row['reported_tokens']:,}" if row["reported_tokens"] is not None else "—"
        lines.append(
            f"| {name} | {row['attempts']} | {row['correct']} | {row['normal_correct']} | "
            f"{row['timeouts']} / {row['failures']} | {row['agent_ms'] / 60000:.1f} min | "
            f"{usage}（{row['reported_usage_attempts']}/{row['attempts']} 次） | "
            f"{row['complete_usage_attempts']}/{row['attempts']} |"
        )
    lines.extend(
        [
            "",
            "正常完成且全对样本的 AReaL-Harness / 基线比值中位数（括号为配对题数）：",
            "",
            "| 基线 | Agent 墙钟时间 | CPU 时间 | 容器峰值内存 | 完整采集的输入＋输出 token |",
            "|---|---:|---:|---:|---:|",
        ]
    )
    for baseline, metrics in summary["paired_metrics"].items():
        cells = []
        for metric in metrics.values():
            ratio = metric["median_ratio"]
            value = f"{ratio:.2f}×" if ratio is not None else "—"
            cells.append(f"{value} ({len(metric['pairs'])})")
        lines.append(f"| {RUNNERS[baseline]} | " + " | ".join(cells) + " |")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path)
    parser.add_argument(
        "--check-report",
        type=Path,
        help="verify the generated summary block in a Markdown report",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="print machine-readable totals and per-case ratios",
    )
    args = parser.parse_args()
    summary = summarize(json.loads(args.snapshot.read_text()))
    markdown = render(summary)
    if args.check_report:
        report = args.check_report.read_text()
        for start, end, table in (
            (START, END, markdown),
            (CASE_START, CASE_END, render_cases(summary["case_comparisons"])),
        ):
            expected = f"{start}\n{table}\n{end}"
            if report.count(start) != 1 or report.count(end) != 1 or expected not in report:
                parser.error("report tables differ from the measurement snapshot")
        print("Report summary matches the measurement snapshot.")
    else:
        print(
            json.dumps(summary, ensure_ascii=False, indent=2)
            if args.json
            else render_cases(summary["case_comparisons"]) + "\n\n" + markdown
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
