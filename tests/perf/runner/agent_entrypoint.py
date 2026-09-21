#!/usr/bin/env python3
"""Run one agent trial and emit a bounded, machine-readable result."""

from __future__ import annotations

import json
import os
import queue
import signal
import subprocess
import threading
import time
import tomllib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

TASK_ROOT = Path("/task")
WORKSPACE = Path(os.environ.get("AREAL_PERF_WORKSPACE", "/workspace"))
OUTPUT = Path("/output")
MAX_LOG_BYTES = 16 * 1024 * 1024


def atomic_json(path: Path, value: object) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def read_int(path: str) -> int | None:
    try:
        value = Path(path).read_text().strip()
        return None if value == "max" else int(value)
    except (OSError, ValueError):
        return None


def cgroup_metrics() -> dict[str, int | None]:
    cpu_usec = None
    try:
        for line in Path("/sys/fs/cgroup/cpu.stat").read_text().splitlines():
            key, value = line.split(maxsplit=1)
            if key == "usage_usec":
                cpu_usec = int(value)
    except (OSError, ValueError):
        pass

    read_bytes = 0
    write_bytes = 0
    io_found = False
    try:
        for line in Path("/sys/fs/cgroup/io.stat").read_text().splitlines():
            values = dict(part.split("=", 1) for part in line.split()[1:] if "=" in part)
            read_bytes += int(values.get("rbytes", 0))
            write_bytes += int(values.get("wbytes", 0))
            io_found = True
    except (OSError, ValueError):
        pass
    return {
        "cpu_usec": cpu_usec,
        "memory_peak_bytes": read_int("/sys/fs/cgroup/memory.peak"),
        "pids_peak": read_int("/sys/fs/cgroup/pids.peak"),
        "io_read_bytes": read_bytes if io_found else None,
        "io_write_bytes": write_bytes if io_found else None,
    }


def delta(after: int | None, before: int | None) -> int | None:
    if after is None or before is None:
        return None
    return max(0, after - before)


def load_task() -> dict[str, Any]:
    with (TASK_ROOT / "task.toml").open("rb") as handle:
        task = tomllib.load(handle)
    if task.get("schema_version") != 1:
        raise ValueError("task schema_version must be 1")
    return task


def safe_task_file(relative: str) -> Path:
    path = (TASK_ROOT / relative).resolve()
    if TASK_ROOT.resolve() not in path.parents:
        raise ValueError(f"task path escapes /task: {relative}")
    return path


def runner_command(
    task: dict[str, Any], runner: str, prompt: str, environment: dict[str, str]
) -> list[str]:
    runner_config = task.get("runners", {}).get(runner, {})
    model = environment.get("AREAL_PERF_MODEL") or runner_config.get("model")
    gateway_url = environment.get("AREAL_PERF_GATEWAY_URL")
    parameters = json.loads(environment.get("AREAL_PERF_MODEL_PARAMETERS", "{}"))
    if runner == "codex":
        if not gateway_url:
            raise RuntimeError("Codex requires AREAL_PERF_GATEWAY_URL")
        environment["CODEX_HOME"] = "/tmp/codex-home"
        Path(environment["CODEX_HOME"]).mkdir(mode=0o700, parents=True, exist_ok=True)
        environment["AREAL_PERF_GATEWAY_API_KEY"] = "areal-local-perf"
        command = [
            "codex",
            "exec",
            "--json",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--config",
            'model_provider="areal_perf"',
            "--config",
            'model_providers.areal_perf.name="AReaL-Harness perf gateway"',
            "--config",
            f'model_providers.areal_perf.base_url="{gateway_url}/v1"',
            "--config",
            'model_providers.areal_perf.env_key="AREAL_PERF_GATEWAY_API_KEY"',
            "--config",
            'model_providers.areal_perf.wire_api="responses"',
            "--dangerously-bypass-approvals-and-sandbox",
            "--cd",
            str(WORKSPACE),
            "-",
        ]
        if model:
            command[2:2] = ["--model", str(model)]
        for source, target in (
            ("reasoning_effort", "model_reasoning_effort"),
            ("reasoning_summary", "model_reasoning_summary"),
            ("verbosity", "model_verbosity"),
        ):
            value = parameters.get(source)
            if value is not None:
                command[2:2] = ["--config", f'{target}="{value}"']
        return command
    if runner == "claudecode":
        if not gateway_url or not model:
            raise RuntimeError("Claude Code requires the perf gateway and model")
        for name in (
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_FOUNDRY",
        ):
            environment.pop(name, None)
        environment.update(
            {
                "SHELL": "/bin/bash",
                "CLAUDE_CONFIG_DIR": "/tmp/claude-perf",
                "ANTHROPIC_BASE_URL": gateway_url,
                "ANTHROPIC_API_KEY": "areal-local-perf",
                "ANTHROPIC_MODEL": str(model),
                "ANTHROPIC_DEFAULT_OPUS_MODEL": str(model),
                "ANTHROPIC_DEFAULT_SONNET_MODEL": str(model),
                "ANTHROPIC_DEFAULT_HAIKU_MODEL": str(model),
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                "DISABLE_AUTOUPDATER": "1",
                "DISABLE_UPDATES": "1",
                # This runner is only launched inside the disposable Docker sandbox.
                "IS_SANDBOX": "1",
            }
        )
        command = [
            "claude",
            "--print",
            "--output-format",
            "stream-json",
            "--verbose",
            "--no-session-persistence",
            "--bare",
            "--setting-sources",
            "",
            "--strict-mcp-config",
            "--mcp-config",
            '{"mcpServers":{}}',
            "--dangerously-skip-permissions",
            "--model",
            str(model),
        ]
        effort = parameters.get("reasoning_effort")
        if effort is not None:
            if effort == "minimal":
                raise ValueError("Claude Code does not support reasoning_effort=minimal")
            command.extend(["--effort", effort])
        return command
    command = (
        ["python3", "/opt/areal-perf/dsh_entrypoint.py"]
        if runner == "dsh"
        else runner_config.get("command")
    )
    if (
        not isinstance(command, list)
        or not command
        or not all(isinstance(item, str) and item for item in command)
    ):
        raise ValueError(f"runners.{runner}.command must be a non-empty string array")
    environment["AREAL_PERF_PROMPT"] = prompt
    environment["AREAL_PERF_PROMPT_PATH"] = str(safe_task_file(task["prompt"]["path"]))
    environment["AREAL_PERF_WORKSPACE"] = str(WORKSPACE)
    environment["AREAL_PERF_OUTPUT"] = str(OUTPUT)
    environment["AREAL_PERF_TASK_TIMEOUT"] = str(task.get("limits", {}).get("timeout_seconds", 300))
    if gateway_url:
        environment["AREAL_MODEL_ENDPOINT"] = f"{gateway_url}/v1/chat/completions"
        environment["AREAL_API_KEY"] = "areal-local-perf"
        environment["AREAL_MODEL_PARAMETERS"] = json.dumps(parameters, separators=(",", ":"))
    if model:
        environment["AREAL_MODEL"] = str(model)
    return command


def write_limited(handle: Any, text: str, count: int) -> int:
    encoded = text.encode("utf-8", errors="replace")
    remaining = max(0, MAX_LOG_BYTES - count)
    if remaining:
        handle.write(encoded[:remaining].decode("utf-8", errors="ignore"))
        handle.flush()
    return count + len(encoded)


def redact(text: str, environment: dict[str, str]) -> str:
    names = environment.get("AREAL_PERF_REDACT_ENV_NAMES", "").split(",")
    secrets = sorted(
        {environment.get(name, "") for name in names if len(environment.get(name, "")) >= 4},
        key=len,
        reverse=True,
    )
    for secret in secrets:
        text = text.replace(secret, "[REDACTED]")
    return text


def extract_usage(event: dict[str, Any], totals: dict[str, int]) -> bool:
    # Claude's result is cumulative, and its input_tokens excludes both caches.
    # Ignore per-message usage to avoid counting partial/repeated blocks twice.
    if event.get("type") == "result" and isinstance(event.get("usage"), dict):
        usage = event["usage"]
        fields = (
            "input_tokens",
            "output_tokens",
            "cache_read_input_tokens",
            "cache_creation_input_tokens",
        )
        if any(key not in usage for key in fields[:2]) or any(
            not isinstance(usage.get(key, 0), int)
            or isinstance(usage.get(key, 0), bool)
            or usage.get(key, 0) < 0
            for key in fields
        ):
            return False
        totals["input_tokens"] = sum(usage.get(key, 0) for key in (fields[0], *fields[2:]))
        totals["cached_input_tokens"] = usage.get("cache_read_input_tokens", 0)
        totals["output_tokens"] = usage.get("output_tokens", 0)
        return True
    candidates: list[dict[str, Any]] = []
    if isinstance(event.get("usage"), dict):
        candidates.append(event["usage"])
    result = event.get("result")
    if isinstance(result, dict) and isinstance(result.get("usage"), dict):
        candidates.append(result["usage"])
    aliases = {
        "input_tokens": "input_tokens",
        "cached_input_tokens": "cached_input_tokens",
        "cache_read_input_tokens": "cached_input_tokens",
        "output_tokens": "output_tokens",
    }
    for usage in candidates:
        for source, target in aliases.items():
            value = usage.get(source)
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                totals[target] = max(totals.get(target, 0), value)
    return any(
        all(
            isinstance(usage.get(key), int)
            and not isinstance(usage.get(key), bool)
            and usage[key] >= 0
            for key in ("input_tokens", "output_tokens")
        )
        for usage in candidates
    )


def record_activity(
    event: dict[str, Any],
    activity: dict[str, int],
    seen_tools: set[str],
    completed_tools: set[str],
) -> bool:
    """Normalize Codex, Claude Code and Harness JSONL activity."""
    event_type = str(event.get("type", ""))
    if event_type == "system" and event.get("subtype") == "init":
        activity["turns"] += 1
    message = event.get("message")
    if event_type in {"assistant", "user"} and isinstance(message, dict):
        if event_type == "assistant":
            message_id = "message:" + str(message.get("id") or event.get("uuid"))
            if message_id not in seen_tools:
                seen_tools.add(message_id)
                activity["assistant_turns"] += 1
        new_tool = False
        content = message.get("content", [])
        for block in content if isinstance(content, list) else []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use":
                tool_id = str(block["id"])
                if tool_id not in seen_tools:
                    seen_tools.add(tool_id)
                    activity["tool_calls"] += 1
                    new_tool = True
            elif block.get("type") == "tool_result":
                tool_id = str(block["tool_use_id"])
                if tool_id not in completed_tools:
                    completed_tools.add(tool_id)
                    activity["tool_failures" if block.get("is_error") else "tool_successes"] += 1
        return new_tool
    if event_type == "turn.started":
        activity["turns"] += 1

    item = event.get("item")
    if (
        isinstance(item, dict)
        and event_type == "item.completed"
        and item.get("type") == "agent_message"
    ):
        activity["assistant_turns"] += 1

    tool_id: str | None = None
    tool_completed = False
    tool_succeeded = False
    if isinstance(item, dict) and item.get("type") in {
        "command_execution",
        "file_change",
        "mcp_tool_call",
        "web_search",
    }:
        tool_completed = event_type == "item.completed"
        if item.get("id") is not None:
            tool_id = str(item["id"])
        elif tool_completed:
            tool_id = f"completed:{item.get('type')}:{activity['tool_calls']}"
        else:
            return True
        status = item.get("status")
        exit_code = item.get("exit_code")
        tool_succeeded = (
            tool_completed and status not in {"failed", "error"} and exit_code in {None, 0}
        )
    elif event_type.startswith("tool."):
        tool_id = str(event.get("id") or event.get("tool") or f"generic:{len(seen_tools)}")
        tool_completed = event_type in {"tool.completed", "tool.failed"}
        tool_succeeded = event_type == "tool.completed" and event.get("status") not in {
            "failed",
            "error",
        }

    if tool_id is None:
        return False
    is_new = tool_id not in seen_tools
    if is_new:
        seen_tools.add(tool_id)
        activity["tool_calls"] += 1
    if tool_completed and tool_id not in completed_tools:
        completed_tools.add(tool_id)
        if tool_succeeded:
            activity["tool_successes"] += 1
        else:
            activity["tool_failures"] += 1
    return is_new


def main() -> int:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    started_wall = datetime.now(timezone.utc).isoformat()
    started = time.monotonic()
    resources_before = cgroup_metrics()
    runner = os.environ.get("AREAL_PERF_RUNNER", "")
    result: dict[str, Any] = {
        "schema_version": 1,
        "runner": runner,
        "started_at": started_wall,
        "status": "failed",
        "execution_started": False,
        "exit_code": None,
        "termination_reason": None,
        "terminal_event_seen": False,
        "milestones_ms": {},
        "usage": {},
        "usage_observed": False,
        "activity": {
            "turns": 0,
            "assistant_turns": 0,
            "tool_calls": 0,
            "tool_successes": 0,
            "tool_failures": 0,
        },
    }
    process: subprocess.Popen[str] | None = None
    observer = None
    try:
        task = load_task()
        prompt_path = safe_task_file(task["prompt"]["path"])
        prompt = prompt_path.read_text()
        timeout_seconds = int(task.get("limits", {}).get("timeout_seconds", 300))
        environment = dict(os.environ)
        if runner != "fixture" and environment.get("AREAL_PERF_GATEWAY_URL"):
            from model_observer import ModelObserver

            observer = ModelObserver(
                environment["AREAL_PERF_GATEWAY_URL"], OUTPUT / "model-requests.jsonl", started
            )
            environment["AREAL_PERF_GATEWAY_URL"] = observer.url
        command = runner_command(task, runner, prompt, environment)
        result["command"] = command
        result["milestones_ms"]["agent_start"] = round((time.monotonic() - started) * 1000, 3)
        process = subprocess.Popen(
            command,
            cwd=WORKSPACE,
            env=environment,
            stdin=subprocess.PIPE if runner in {"codex", "claudecode"} else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            start_new_session=True,
        )
        result["execution_started"] = True
        if runner in {"codex", "claudecode"}:
            assert process.stdin is not None
            process.stdin.write(prompt)
            process.stdin.close()

        messages: queue.Queue[tuple[str, str] | tuple[str, None]] = queue.Queue()

        def read_stream(name: str, stream: Any) -> None:
            try:
                for line in iter(stream.readline, ""):
                    messages.put((name, line))
            finally:
                messages.put((name, None))

        assert process.stdout is not None and process.stderr is not None
        threading.Thread(target=read_stream, args=("stdout", process.stdout), daemon=True).start()
        threading.Thread(target=read_stream, args=("stderr", process.stderr), daemon=True).start()
        open_streams = 2
        stdout_bytes = 0
        stderr_bytes = 0
        deadline = time.monotonic() + timeout_seconds
        terminal_types = {"turn.completed", "task.completed", "game_release.completed"}
        seen_tools: set[str] = set()
        completed_tools: set[str] = set()
        with (
            (OUTPUT / "agent.stdout.log").open("w") as stdout_log,
            (OUTPUT / "agent.stderr.log").open("w") as stderr_log,
            (OUTPUT / "agent-events.jsonl").open("w") as events_log,
        ):
            while open_streams or process.poll() is None:
                if time.monotonic() >= deadline and process.poll() is None:
                    result["termination_reason"] = "timeout"
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                    break
                try:
                    stream_name, line = messages.get(timeout=0.1)
                except queue.Empty:
                    continue
                if line is None:
                    open_streams -= 1
                    continue
                line = redact(line, environment)
                elapsed_ms = round((time.monotonic() - started) * 1000, 3)
                if stream_name == "stdout":
                    stdout_bytes = write_limited(stdout_log, line, stdout_bytes)
                    if "first_output" not in result["milestones_ms"]:
                        result["milestones_ms"]["first_output"] = elapsed_ms
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        event = {"type": "runner.output", "text": line.rstrip("\n")}
                    if isinstance(event, dict):
                        event_type = str(event.get("type", ""))
                        if event_type == "harness.metrics":
                            result["harness_metrics"] = event
                        if event_type == "harness.configuration":
                            result["harness_configuration"] = event
                        if event_type == "runtime.connected":
                            result["runtime"] = {
                                "protocol_version": event.get("protocol_version"),
                                "sandbox_profile": event.get("sandbox_profile"),
                                "harness": event.get("harness"),
                            }
                        if (
                            record_activity(event, result["activity"], seen_tools, completed_tools)
                            and "first_tool" not in result["milestones_ms"]
                        ):
                            result["milestones_ms"]["first_tool"] = elapsed_ms
                        if event_type in terminal_types:
                            result["terminal_event_seen"] = True
                        if runner == "claudecode" and event_type == "result":
                            result["terminal_event_seen"] = True
                            if event.get("is_error") or event.get("subtype") != "success":
                                result["termination_reason"] = "claude_error_result"
                                result["error"] = str(
                                    event.get("errors")
                                    or event.get("result")
                                    or event.get("subtype")
                                )
                        if event_type == "turn.failed":
                            error = event.get("error")
                            if isinstance(error, dict) and isinstance(error.get("message"), str):
                                result["error"] = error["message"]
                        result["usage_observed"] = (
                            extract_usage(event, result["usage"]) or result["usage_observed"]
                        )
                        if event_type == "dsh.summary":
                            result["delegation"] = event.get("delegation")
                            result["usage_unknown_steps"] = event.get("unknown_usage_steps")
                            result["usage_source"] = event.get("usage_source")
                            result["dsh_activity"] = event.get("activity")
                    events_log.write(
                        json.dumps(
                            {"elapsed_ms": elapsed_ms, "stream": stream_name, "event": event}
                        )
                        + "\n"
                    )
                    events_log.flush()
                else:
                    stderr_bytes = write_limited(stderr_log, line, stderr_bytes)
        try:
            exit_code = process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            exit_code = process.wait()
        result["exit_code"] = exit_code
        if result["termination_reason"] == "timeout":
            result["status"] = "timeout"
        elif result["termination_reason"] == "claude_error_result":
            result["status"] = "failed"
        elif exit_code != 0:
            result["termination_reason"] = "runner_exit"
        elif not result["terminal_event_seen"]:
            result["termination_reason"] = "missing_terminal_event"
        else:
            result["status"] = "completed"
    except Exception as error:
        result["termination_reason"] = type(error).__name__
        result["error"] = str(error)
        if process is not None and process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    finally:
        if process is not None:
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None:
                    stream.close()
        agent_ended = time.monotonic()
        if observer is not None:
            result["model_observation"] = observer.close()
        result["usage_complete"] = (
            result["status"] == "completed"
            and all(key in result["usage"] for key in ("input_tokens", "output_tokens"))
            and (observer is None or result["model_observation"]["usage_coverage"] == 1)
        )
        resources_after = cgroup_metrics()
        result["duration_ms"] = round((agent_ended - started) * 1000, 3)
        result["resources"] = {
            "cpu_usec": delta(resources_after["cpu_usec"], resources_before["cpu_usec"]),
            "memory_peak_bytes": resources_after["memory_peak_bytes"],
            "pids_peak": resources_after["pids_peak"],
            "io_read_bytes": delta(
                resources_after["io_read_bytes"], resources_before["io_read_bytes"]
            ),
            "io_write_bytes": delta(
                resources_after["io_write_bytes"], resources_before["io_write_bytes"]
            ),
        }
        # Extract while the trial user can still read Core's private directory.
        # Metrics do not change the agent outcome or measured execution duration.
        try:
            from trace_metrics import collect

            result["trace_metrics"] = collect(OUTPUT, runner)
        except (OSError, ValueError, KeyError) as error:
            result["trace_metrics"] = {"collection_error": type(error).__name__}
        atomic_json(OUTPUT / "agent-result.json", result)
    return 0 if result["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
