#!/usr/bin/env python3
"""Add bounded, credential-free metrics from archived trials to a report snapshot.

Usage: python3 tests/perf/trace_metrics.py SNAPSHOT RUNS_DIRECTORY --output SNAPSHOT
RUNS_DIRECTORY contains <run-id>/trials/<sequence-runner>/output directories.
Only counts, timings, usage and source hashes are exported, never log contents.
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import statistics
from pathlib import Path

USAGE_KEYS = ("input_tokens", "cached_input_tokens", "output_tokens")


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def valid_usage(record: dict) -> bool:
    usage = record.get("usage", {})
    return (
        record.get("status") == 200
        and record.get("semantic_terminal_seen") is True
        and record.get("terminal_delivered_ms") is not None
        and not record.get("semantic_failure_seen")
        and not record.get("usage_parse_errors")
        and not record.get("usage_parser_overflow")
        and all(type(usage.get(key)) is int and usage[key] >= 0 for key in USAGE_KEYS)
        and usage["cached_input_tokens"] <= usage["input_tokens"]
    )


def model_metrics(records: list[dict]) -> dict:
    """Preserve historical completeness flags; salvage only valid archived usage."""
    valid = [record for record in records if valid_usage(record)]
    first_bytes = [
        record["first_byte_ms"]
        for record in records
        if record.get("status") == 200 and record.get("first_byte_ms") is not None
    ]
    hashes = [record["request_sha256"] for record in records]
    return {
        "archived_requests": len(records),
        "terminal_requests": sum(
            record.get("status") == 200
            and record.get("semantic_terminal_seen") is True
            and not record.get("semantic_failure_seen")
            for record in records
        ),
        "usage_requests": len(valid),
        "observed_usage": {key: sum(record["usage"][key] for record in valid) for key in USAGE_KEYS}
        if valid
        else {},
        "first_request_usage": {key: records[0]["usage"][key] for key in USAGE_KEYS}
        if records and valid_usage(records[0])
        else {},
        "http_status_counts": dict(
            sorted(collections.Counter(str(record.get("status")) for record in records).items())
        ),
        "identical_request_repeats": len(hashes) - len(set(hashes)),
        "first_byte_ms_p50": statistics.median(first_bytes) if first_bytes else None,
    }


def tool_breakdown(events: list[dict], runner: str) -> dict[str, int]:
    tools = {}
    for row in events:
        event = row.get("event", {})
        if runner == "harness" and event.get("type") == "tool.started":
            tools[event["id"]] = event["tool"]
        elif runner == "codex" and event.get("type") in {
            "item.started",
            "item.completed",
        }:
            item = event.get("item", {})
            if item.get("type") in {
                "command_execution",
                "file_change",
                "mcp_tool_call",
                "web_search",
            }:
                tools[item["id"]] = item["type"]
        elif runner == "claudecode" and event.get("type") == "assistant":
            for block in event.get("message", {}).get("content", []):
                if block.get("type") == "tool_use":
                    tools[block["id"]] = block["name"]
    return dict(sorted(collections.Counter(tools.values()).items()))


def harness_round_metrics(thread: dict) -> dict:
    """Group tool operations by Core's model reply marker, including empty replies."""
    rounds = []
    for turn in thread.get("turns", []):
        current = None
        for item in turn["items"]:
            if item["type"] == "agentMessage":
                current = []
                rounds.append(current)
            elif item["type"] == "dynamicToolCall":
                if current is None:
                    raise ValueError("tool item has no preceding model round")
                current.append(item)
    returns = collections.Counter()
    errors = collections.Counter()
    process_results = 0
    for tools in rounds:
        for tool in tools:
            value = None
            for content in tool.get("contentItems") or []:
                if content.get("type") == "inputText":
                    try:
                        parsed = json.loads(content.get("text", ""))
                    except (ValueError, TypeError):
                        continue
                    if isinstance(parsed, dict):
                        value = parsed
                        break
            if tool["tool"] in {"run_command", "read_process"}:
                process_results += 1
                reason = (value or {}).get("returnReason")
                returns[reason if isinstance(reason, str) else "unknown"] += 1
            error = (value or {}).get("error")
            error = error if isinstance(error, dict) else {}
            args = (tool.get("execution") or {}).get("effectiveArguments")
            if args is None:
                args = tool.get("arguments")
            args = args if isinstance(args, dict) else {}
            if (
                tool["tool"] in {"fs_write", "fs_apply_patch", "fs_create"}
                and error.get("code") == "CONFLICT"
            ):
                creation = tool["tool"] == "fs_create" or (
                    "expectedSha256" in args and args["expectedSha256"] is None
                )
                errors["file_create_conflict" if creation else "file_edit_conflict"] += 1
            elif error.get("code") == "INVALID_ARGUMENT" and str(
                error.get("message", "")
            ).startswith("invalid processId;"):
                errors["invalid_process_id"] += 1
            elif tool.get("success") is False:
                errors["other_confirmed_failure"] += 1
    checkpoint = thread.get("contextCheckpoint") or {}
    return {
        "model_reply_rounds": len(rounds),
        "process_tool_results": process_results,
        "return_reason_counts": dict(sorted(returns.items())),
        "tool_failure_categories": dict(sorted(errors.items())),
        "tool_rounds": sum(bool(tools) for tools in rounds),
        "multi_tool_rounds": sum(len(tools) > 1 for tools in rounds),
        "rounds_with_tool_failure": sum(
            any(tool.get("success") is False for tool in tools) for tools in rounds
        ),
        "poll_only_rounds": sum(
            len(tools) == 1 and tools[0]["tool"] == "read_process" for tools in rounds
        ),
        "context_compactions": checkpoint.get("compactions", 0),
        "compaction_duration_ms": checkpoint.get("totalDurationMs", 0),
        "compaction_usage": {
            key: checkpoint["usage"][key]
            for key in ("inputTokens", "cachedInputTokens", "outputTokens")
            if key in checkpoint.get("usage", {})
        },
    }


def collect(output: Path, runner: str) -> dict:
    """Extract available evidence; missing files and old fields remain unknown."""
    metrics = {"source_sha256": {}}
    for filename, extract in [
        ("model-requests.jsonl", model_metrics),
        ("agent-events.jsonl", lambda rows: {"tool_breakdown": tool_breakdown(rows, runner)}),
    ]:
        path = output / filename
        if path.is_file():
            metrics.update(extract(read_jsonl(path)))
            metrics["source_sha256"][filename] = hashlib.sha256(path.read_bytes()).hexdigest()
    if runner == "harness":
        threads = list((output / "core-data").glob("*.json"))
        if len(threads) == 1:
            metrics.update(harness_round_metrics(json.loads(threads[0].read_text())["thread"]))
            metrics["source_sha256"]["core-thread.json"] = hashlib.sha256(
                threads[0].read_bytes()
            ).hexdigest()
        else:
            metrics["core_trace_status"] = "missing" if not threads else "ambiguous"
    return metrics


def enrich(snapshot: dict, runs: Path) -> dict:
    root = runs.resolve()
    for attempt in snapshot["attempts"]:
        parts = attempt["attempt_id"].split("/")
        if len(parts) != 2:
            raise ValueError("attempt_id must contain run/trial")
        output = (root / parts[0] / "trials" / parts[1] / "output").resolve()
        if not output.is_relative_to(root):
            raise ValueError("attempt_id escapes the run directory")
        metrics = collect(output, attempt["runner"])
        attempt["trace_metrics"] = metrics
    return snapshot


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("runs_directory", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    snapshot = enrich(json.loads(args.snapshot.read_text()), args.runs_directory)
    args.output.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
