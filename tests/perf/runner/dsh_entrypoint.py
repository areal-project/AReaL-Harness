#!/usr/bin/env python3
"""Run the pinned native DSH loop and project its durable session evidence.

DSH headless prints plain final text. A successful process exit alone is not
invented into a terminal event: the root session must contain completed turn/end.
This adapter does not perform external agent fan-out or change DSH's loop.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def summarize_sessions(sessions: list[list[dict]]) -> dict:
    usage_by_step = {}
    started_steps = set()
    tool_calls = set()
    tool_successes = set()
    roots = []
    children = []
    intervals = []
    for events in sessions:
        if not events or events[0].get("type") != "session":
            raise ValueError("missing DSH session header")
        header = events[0]
        session_id = header["id"]
        child = bool(header.get("parentSession"))
        if child:
            children.append(session_id)
        last_end = None
        starts = {}
        for event in events[1:]:
            data = event.get("data", {})
            key = (session_id, data.get("turn"), data.get("step"))
            kind = event.get("type")
            if kind == "step/start":
                started_steps.add(key)
                starts[key] = event.get("time")
            elif kind == "step/end" and key in starts:
                start, end = starts.pop(key), event.get("time")
                if (
                    child
                    and isinstance(start, (int, float))
                    and isinstance(end, (int, float))
                    and end > start
                ):
                    intervals.append((start, end, session_id))
            elif kind == "turn/end":
                last_end = data.get("reason", {}).get("kind")
            elif kind == "assistant/chunk" and data.get("chunk", {}).get("type") == "usage":
                # Provider usage updates within a step are cumulative snapshots.
                usage_by_step[key] = data["chunk"]["usage"]
            elif kind == "tool/call":
                tool_calls.add((session_id, event.get("seq")))
            elif kind == "tool/result":
                tool_successes.add((session_id, event.get("seq")))
        if not child:
            roots.append({"id": session_id, "last_turn_end": last_end})
    totals = {"input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0}
    valid_usage = set()
    for key, usage in usage_by_step.items():
        values = [
            usage.get(name, 0)
            for name in ("inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens")
        ]
        if (
            "inputTokens" not in usage
            or "outputTokens" not in usage
            or any(
                not isinstance(value, int) or isinstance(value, bool) or value < 0
                for value in values
            )
        ):
            continue
        inp, output, cached, created = values
        totals["input_tokens"] += inp + cached + created
        totals["cached_input_tokens"] += cached
        totals["output_tokens"] += output
        valid_usage.add(key)
    events = sorted(
        [(a, 1, name) for a, b, name in intervals] + [(b, -1, name) for a, b, name in intervals]
    )
    active = set()
    peak = 0
    overlap_ms = 0
    previous = None
    for at, change, name in events:
        if previous is not None and len(active) > 1:
            overlap_ms += at - previous
        if change == 1:
            active.add(name)
        else:
            active.discard(name)
        peak = max(peak, len(active))
        previous = at
    return {
        "roots": roots,
        "terminal_completed": len(roots) == 1 and roots[0]["last_turn_end"] == "completed",
        "usage": totals,
        "unknown_usage_steps": len(started_steps - valid_usage),
        "usage_source": "DSH durable per-step usage; title/auxiliary calls may be absent; prefer upstream metering",
        "delegation": {
            "children_created": len(children),
            "child_session_ids": children,
            "peak_overlapping_completed_child_steps": peak,
            "completed_child_step_overlap_ms": overlap_ms,
        },
        "activity": {"tool_calls": len(tool_calls), "tool_results": len(tool_successes)},
    }


def read_sessions(root: Path) -> list[list[dict]]:
    sessions = []
    for path in sorted(root.rglob("session.jsonl.zstd")):
        # zstd -dc handles every concatenated frame; Node's one-shot decoder may
        # only read the first header frame in these DSH append-only session files.
        result = subprocess.run(
            ["zstd", "--decompress", "--stdout", str(path)],
            capture_output=True,
            check=True,
            timeout=30,
        )
        sessions.append([json.loads(line) for line in result.stdout.splitlines() if line.strip()])
    return sessions


def run_cli(command: list[str], environment: dict[str, str]) -> int:
    # Native headless stdout is model text, not trusted telemetry. Nest every
    # line so a JSON-looking final answer cannot forge usage/completion events.
    with subprocess.Popen(command, env=environment, stdout=subprocess.PIPE, text=True) as process:
        for line in process.stdout:
            print(json.dumps({"type": "dsh.output", "text": line.rstrip("\n")}), flush=True)
        return process.wait()


def main() -> int:
    output = Path(os.environ.get("AREAL_PERF_OUTPUT", "/output"))
    # The output mount survives timeout/container cleanup, including a kill
    # before this wrapper has a chance to produce its final summary.
    root = output / "dsh-home"
    root.mkdir(mode=0o700, exist_ok=False)
    environment = dict(os.environ)
    environment["DSH_HOME"] = str(root)
    environment["AREAL_DSH_API_KEY"] = "areal-local-perf"
    model = environment["AREAL_MODEL"]
    endpoint = environment["AREAL_PERF_GATEWAY_URL"]
    settings = {
        "llm-pi-ai": {
            "providers": {
                "lab": {
                    "apiKeyEnv": "AREAL_DSH_API_KEY",
                    "api": "anthropic-messages",
                    "baseURL": endpoint,
                    "models": [
                        {"id": model, "name": model, "contextWindow": 65536, "maxTokens": 4096}
                    ],
                }
            }
        }
    }
    (root / "settings.yaml").write_text(json.dumps(settings))
    patch = root / "model.patch.yaml"
    patch.write_text(
        json.dumps([{"id": "agent-default-model", "config": {"provider": "lab", "model": model}}])
    )
    returncode = run_cli(
        ["dsh", "--profile", "headless", "--patch", str(patch), environment["AREAL_PERF_PROMPT"]],
        environment,
    )
    try:
        # Preserve evidence even when decompression or parsing fails.
        if (root / "sessions").exists():
            shutil.copytree(root / "sessions", output / "dsh-sessions")
        summary = summarize_sessions(read_sessions(root / "sessions"))
        (output / "dsh-summary.json").write_text(json.dumps(summary, indent=2))
        print(json.dumps({"type": "dsh.summary", **summary}), flush=True)
        if returncode == 0 and summary["terminal_completed"]:
            print(json.dumps({"type": "task.completed", "usage": summary["usage"]}), flush=True)
            return 0
    except Exception as error:
        print(json.dumps({"type": "dsh.evidence_error", "error": str(error)}), flush=True)
    return returncode or 1


if __name__ == "__main__":
    sys.exit(main())
