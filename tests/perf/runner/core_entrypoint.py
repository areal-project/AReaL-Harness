#!/usr/bin/env python3
"""Run the real TUI/Core/Runtime stack and project its persisted tool events.

This adapter owns no model loop. Core remains the source of truth for messages,
tool results, usage and the terminal turn status.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def emit(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)


def project(thread, seen, completed):
    for turn in thread.get("turns", []):
        items = turn.get("items", [])
        for index, item in enumerate(items):
            key = item["id"]
            if item["type"] == "dynamicToolCall":
                if key not in seen:
                    emit({"type": "tool.started", "id": key, "tool": item["tool"]})
                    seen.add(key)
                if item["status"] != "inProgress" and key not in completed:
                    emit(
                        {
                            "type": "tool.completed" if item.get("success") else "tool.failed",
                            "id": key,
                            "tool": item["tool"],
                            "result": item,
                        }
                    )
                    completed.add(key)
            elif (
                item["type"] == "agentMessage"
                and key not in seen
                and (index < len(items) - 1 or turn["status"] != "inProgress")
            ):
                emit(
                    {
                        "type": "item.completed",
                        "item": {
                            "id": key,
                            "type": "agent_message",
                            "text": item["text"],
                        },
                    }
                )
                seen.add(key)


def summarize_threads(threads):
    """Root completion determines the trial; usage includes every child Turn."""
    roots = [thread for thread in threads.values() if not thread.get("parentThreadId")]
    if len(roots) > 1:
        raise ValueError("one perf trial must contain exactly one root Agent")
    turns = [turn for thread in threads.values() for turn in thread.get("turns", [])]
    usage = {}
    for key in ("inputTokens", "cachedInputTokens", "outputTokens"):
        values = [(turn.get("usage") or {}).get(key) for turn in turns]
        usage[key] = (
            sum(values) if values and all(isinstance(value, int) for value in values) else None
        )
    executions = [
        item.get("execution", {})
        for turn in turns
        for item in turn.get("items", [])
        if item.get("type") == "dynamicToolCall"
    ]
    children = sorted(thread["id"] for thread in threads.values() if thread.get("parentThreadId"))
    return (roots[0] if roots else {}), usage, executions, children


def main():
    output = Path(os.environ["AREAL_PERF_OUTPUT"])
    with tempfile.TemporaryDirectory(prefix="areal-perf-core-") as temporary:
        root = Path(temporary)
        data = root / "data"
        config = root / "config.toml"
        # JSON string quoting is compatible with TOML basic strings here.
        quote = json.dumps
        parameters = json.loads(os.environ.get("AREAL_MODEL_PARAMETERS", "{}"))
        applied = {
            key: value
            for key, value in parameters.items()
            if key in {"reasoning_effort", "max_output_tokens"}
        }
        timeout = int(os.environ.get("AREAL_PERF_TASK_TIMEOUT", "300"))
        endpoint = os.environ["AREAL_PERF_GATEWAY_URL"].rstrip("/") + "/v1/responses"
        config.write_text(
            'schema_version=1\n[model]\nprovider="perf"\nname='
            + quote(os.environ["AREAL_MODEL"])
            + "\n"
            + "".join(f"{key}={quote(value)}\n" for key, value in applied.items())
            + '[model.providers.perf]\nprotocol="responses"\nendpoint='
            + quote(endpoint)
            + '\napi_key_env="AREAL_API_KEY"\n[limits]\n'
            + f"turn_timeout_seconds={timeout}\nstream_idle_timeout_seconds=180\n"
            + "max_history_bytes=67108864\nmax_output_bytes=8388608\nmax_tool_calls=512\n"
        )
        command = [
            sys.executable,
            "/opt/areal-launch/launch.py",
            "--bin-dir",
            "/usr/local/bin",
            "--tui",
            "--config",
            str(config),
            "--data-dir",
            str(data),
            "--workspace",
            os.environ["AREAL_PERF_WORKSPACE"],
            "--allow-write",
            "--allow-network",
            "--allow-concurrent-writes",
            "--command-timeout-ms",
            str(timeout * 1000),
            "--command-output-bytes",
            str(64 * 1024 * 1024),
            "--sandbox-profile",
            "outer-container-perf",
            "--prompt",
            os.environ["AREAL_PERF_PROMPT"],
        ]
        seen, completed = set(), set()
        emit(
            {
                "type": "harness.configuration",
                "implementation": "tui-core-runtime",
                "model_parameters": applied,
                "requested_parameters": parameters,
                "unapplied_parameters": sorted(set(parameters) - set(applied)),
                "parameter_policy": "explicit Core configuration; upstream acceptance is checked separately",
                "model_protocol": "responses",
                "turn_timeout_seconds": timeout,
                "stream_idle_timeout_seconds": 180,
                "tool_network": "inherit-container",
                "concurrent_commands": True,
                "multi_agent": "enabled; model-directed delegation under Core limits",
            }
        )
        emit({"type": "turn.started"})
        threads = {}
        with (output / "tui.stdout.log").open("w") as stdout:
            environment = {
                key: value
                for key, value in os.environ.items()
                if not key.startswith("AREAL_HARNESS_")
                and key not in {"AREAL_MODEL", "AREAL_MODEL_ENDPOINT", "AREAL_MODEL_PROTOCOL"}
            }
            environment["AREAL_HARNESS_HOME"] = str(root / "home")
            process = subprocess.Popen(command, stdout=stdout, stderr=sys.stderr, env=environment)
            try:
                while True:
                    for path in data.glob("*.json"):
                        thread = json.loads(path.read_text())["thread"]
                        threads[thread["id"]] = thread
                        project(thread, seen, completed)
                    if process.poll() is not None:
                        break
                    time.sleep(0.05)
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=45)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
                if data.exists():
                    for path in data.glob("*.json"):
                        thread = json.loads(path.read_text())["thread"]
                        threads[thread["id"]] = thread
                        project(thread, seen, completed)
                    shutil.copytree(data, output / "core-data", dirs_exist_ok=True)
        thread, usage, tool_executions, children = summarize_threads(threads)
        turns = thread.get("turns", [])
        turn = turns[-1] if turns else {}
        emit(
            {
                "type": "harness.metrics",
                "context_checkpoint": {
                    key: value
                    for key, value in (thread.get("contextCheckpoint") or {}).items()
                    if key in {"compactions", "totalDurationMs", "usage"}
                },
                "tool_duration_ms": sum(
                    item["durationMs"]
                    for item in tool_executions
                    if isinstance(item.get("durationMs"), int)
                ),
                "tool_timing_samples": sum(
                    isinstance(item.get("durationMs"), int) for item in tool_executions
                ),
                "tool_timing_scope": "Core dispatch journal through Runtime result; excludes final commit",
                "delegation": {"children_created": len(children), "child_session_ids": children},
            }
        )
        if turns:
            emit(
                {
                    "type": "runtime.connected",
                    "protocol_version": "areal.runtime.v0",
                    "sandbox_profile": "outerContainerPerfV1",
                    "harness": "tui-core-runtime",
                }
            )
        success = process.returncode == 0 and turn.get("status") == "completed"
        result = {
            "type": "turn.completed" if success else "turn.failed",
            "usage": {
                "input_tokens": usage.get("inputTokens"),
                "cached_input_tokens": usage.get("cachedInputTokens"),
                "output_tokens": usage.get("outputTokens"),
            },
        }
        if not success:
            result["error"] = turn.get("error") or {
                "message": f"TUI exit {process.returncode}; Core turn {turn.get('status', 'missing')}"
            }
        emit(result)
        return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(main())
