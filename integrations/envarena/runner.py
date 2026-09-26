#!/usr/bin/env python3
"""EnvArena adapter for the native TUI/Core/Runtime; owns no model loop."""

import hashlib
import base64
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from outcomes import finalize


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    temporary.replace(path)


def prepare_input(query, assets=Path("/problem_assets")):
    parts = [{"type": "text", "text": query}]
    images = []
    mime_types = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
    }
    if assets.is_dir():
        for path in sorted(assets.iterdir()):
            if path.is_file() and path.suffix.lower() in mime_types:
                data = path.read_bytes()
                mime = mime_types[path.suffix.lower()]
                images.append(
                    {
                        "path": str(path),
                        "sha256": hashlib.sha256(data).hexdigest(),
                        "bytes": len(data),
                    }
                )
                parts.extend(
                    [
                        {"type": "text", "text": "Problem image: " + path.name},
                        {
                            "type": "image",
                            "url": f"data:{mime};base64," + base64.b64encode(data).decode("ascii"),
                        },
                    ]
                )
    return parts, images


def find_node(nvm_root=Path("/usr/local/nvm")):
    source = shutil.which("node")
    if source:
        return Path(source)
    # Some offline images install one Node under nvm without exporting its
    # directory into the non-login runner's PATH. Use that installed version.
    candidates = sorted(
        path
        for path in nvm_root.glob("versions/node/*/bin/node")
        if path.is_file() and os.access(path, os.X_OK)
    )
    if len(candidates) > 1:
        raise RuntimeError("Multiple nvm Node versions without an active Node in PATH")
    return candidates[0] if candidates else None


def prepare_utilities(root):
    # The image's own toolchain remains authoritative (e.g. its pinned Node).
    if os.environ.get("IS_SANDBOX") != "1" or not os.environ.get("ARENA_TASK_ID"):
        raise RuntimeError("This adapter requires an EnvArena sandbox")
    for name in ("bwrap", "rg"):
        source = root / "bin" / ("bwrap" if name == "bwrap" else "tools/rg")
        target = Path("/usr/bin/bwrap") if name == "bwrap" else Path("/usr/local/bin/rg")
        if not target.exists():
            shutil.copy2(source, target)
            target.chmod(0o755)
    for source in (root / "lib").iterdir():
        target = Path("/lib") / source.name
        if not target.exists():
            shutil.copy2(source, target)
    node = find_node()
    for name in ("node", "npm", "npx"):
        sibling = node.parent / name if node else None
        source = str(sibling) if sibling and sibling.exists() else shutil.which(name)
        target = Path("/usr/local/bin") / name
        if source and not target.exists():
            if target.is_symlink():
                target.unlink()
            target.symlink_to(source)
    subprocess.run(
        ["/usr/bin/bwrap", "--unshare-all", "--ro-bind", "/", "/", "--", "/bin/true"],
        check=True,
        timeout=20,
    )
    return {"node": str(node) if node else None}


def project_item(item):
    kind = item["type"]
    identity = item["id"]
    if kind == "userMessage":
        content = []
        for part in item["content"]:
            if part["type"] == "text":
                content.append({"type": "text", "text": part["text"]})
            else:
                content.append({"type": "text", "text": "[Input media] " + json.dumps(part)})
        return [{"type": "user", "message": {"id": identity, "role": "user", "content": content}}]
    if kind == "agentMessage":
        return [
            {
                "type": "assistant",
                "message": {
                    "id": identity,
                    "role": "assistant",
                    "content": [{"type": "text", "text": item["text"]}],
                },
            }
        ]
    if kind == "modelContext":
        value = item["value"]
        if value.get("type") == "chat_reasoning":
            return [
                {
                    "type": "assistant",
                    "message": {
                        "id": identity,
                        "role": "assistant",
                        "content": [{"type": "thinking", "thinking": value["reasoning_content"]}],
                    },
                }
            ]
        return [{"type": "model_context", "item": item}]
    if kind == "dynamicToolCall":
        return [
            {
                "type": "assistant",
                "message": {
                    "id": identity,
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": item["callId"],
                            "name": item["tool"],
                            "input": item["arguments"],
                        }
                    ],
                },
            },
            {
                "type": "user",
                "message": {
                    "id": identity + "-result",
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": item["callId"],
                            "is_error": not item.get("success"),
                            "content": json.dumps(item.get("contentItems"), ensure_ascii=False),
                        }
                    ],
                },
            },
        ]
    return [{"type": "core_item", "item": item}]


def project(data, trajectory, seen):
    threads = []
    for path in sorted(data.glob("*.json")):
        thread = json.loads(path.read_text())["thread"]
        threads.append(thread)
        for turn in thread.get("turns", []):
            items = turn["items"]
            for index, item in enumerate(items):
                identity = item["id"]
                if identity in seen or item.get("status") == "inProgress":
                    continue
                if (
                    item["type"] == "agentMessage"
                    and index == len(items) - 1
                    and turn["status"] == "inProgress"
                ):
                    continue
                for event in project_item(item):
                    event.update({"thread_id": thread["id"], "turn_id": turn["id"]})
                    trajectory.write(json.dumps(event, ensure_ascii=False) + "\n")
                seen.add(identity)
    trajectory.flush()
    return threads


def make_config(model, endpoint, timeout, settings=None):
    settings = settings or {}
    q = json.dumps
    effort = os.environ.get(
        "AREAL_ARENA_REASONING_EFFORT", settings.get("reasoning_effort", "medium")
    )
    temperature = os.environ.get("AREAL_ARENA_TEMPERATURE", settings.get("temperature", 1))
    sampling = (f"reasoning_effort={q(effort)}\n" if effort is not None else "") + (
        f"temperature={float(temperature)}\n" if temperature is not None else ""
    )
    return f"""schema_version=1
[model]
provider="arena"
name={q(model)}
{sampling}max_output_tokens={int(os.environ.get("AREAL_ARENA_MAX_OUTPUT_TOKENS", settings.get("max_output_tokens", 16384)))}
max_retries={int(settings.get("http_retries", 2))}
[model.providers.arena]
protocol="chat-completions"
endpoint={q(endpoint)}
api_key_env="AREAL_API_KEY"
[limits]
turn_timeout_seconds={timeout}
stream_idle_timeout_seconds={int(settings.get("stream_idle_timeout_seconds", 900))}
max_completion_retries={int(settings.get("max_completion_retries", 0))}
max_history_bytes=134217728
max_output_bytes=16777216
max_tool_calls=512
context_window_bytes={int(settings.get("context_window_bytes", 196608))}
context_compaction_enabled=false
context_recent_bytes={int(settings.get("context_recent_bytes", 65536))}
context_window_tokens={int(settings.get("context_window_tokens", 0))}
context_output_reserve_tokens={int(settings.get("context_output_reserve_tokens", 0))}
max_children_per_turn=0
max_agent_depth=0
"""


def model_connection():
    model = (
        os.environ.get("OPENAI_MODEL")
        or os.environ.get("ANTHROPIC_MODEL")
        or os.environ.get("MODEL_NAME")
    )
    base = (
        os.environ.get("OPENAI_BASE_URL")
        or os.environ.get("ANTHROPIC_BASE_URL")
        or os.environ.get("LLM_BASE_URL")
    )
    key = (
        os.environ.get("OPENAI_API_KEY")
        or os.environ.get("ANTHROPIC_AUTH_TOKEN")
        or os.environ.get("ANTHROPIC_API_KEY")
    )
    if not model or not base or not key:
        raise RuntimeError("Model must provide model name, gateway base URL and a credential")
    base = base.rstrip("/")
    return (
        model,
        base + ("/chat/completions" if base.endswith("/v1") else "/v1/chat/completions"),
        key,
    )


def has_tracked_changes(workspace):
    # Inspect only the supplied task workspace, without credentials or Git
    # text-conversion hooks. This is not a correctness/score check.
    result = subprocess.run(
        [
            "git",
            "-c",
            "core.fileMode=false",
            "diff",
            "--quiet",
            "--no-ext-diff",
            "--no-textconv",
            "HEAD",
            "--",
        ],
        cwd=workspace,
        env={"PATH": "/usr/bin:/bin", "GIT_OPTIONAL_LOCKS": "0"},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=15,
    )
    if result.returncode not in (0, 1):
        raise RuntimeError(
            "Cannot inspect task workspace changes: " + result.stderr.decode(errors="replace")
        )
    return result.returncode == 1


def completion_confirmed(turns):
    if not turns:
        return False
    text = "\n".join(
        item.get("text", "")
        for item in turns[-1].get("items", [])
        if item["type"] == "agentMessage"
    )
    return any(
        line.strip()
        in ("IMPLEMENTATION_COMPLETE", "IMPLEMENTATION_BLOCKED", "IMPLEMENTATION_NO_CHANGE")
        for line in text.splitlines()
    )


def main():
    started = time.monotonic()
    root = Path(__file__).resolve().parent
    output = Path(os.environ["ARENA_AGENT_OUTPUT_DIR"])
    output.mkdir(parents=True, exist_ok=True)
    trajectory_path = Path(os.environ["ARENA_TRAJECTORY_PATH"])
    trajectory_path.parent.mkdir(parents=True, exist_ok=True)
    result = {
        "status": "ERROR",
        "implementation": "rust-core-runtime",
        "error": "Runner did not complete",
    }
    process = None
    graybox_state = None
    stopping = False
    timed_out = False
    adapter_error = False
    threads = []

    def stop(_signal, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        write_json(output / "runtime-utilities.json", prepare_utilities(root))
        model, endpoint, key = model_connection()
        settings_path = root / "settings.json"
        settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
        graybox = os.environ.get("ARENA_ENV_KEY", "").startswith(
            "graybox19-"
        ) or ":graybox19-" in os.environ.get("ARENA_TASK_ID", "")
        if graybox:
            settings.update(
                max_output_tokens=65536,
                context_window_bytes=2097152,
                context_recent_bytes=131072,
                context_window_tokens=262144,
                context_output_reserve_tokens=73728,
            )
        profile = settings.get("task_profile", "generic")
        query = Path(os.environ["ARENA_QUERY_PATH"]).read_text()
        inputs, images = prepare_input(query)
        prompt_path = os.environ.get("ARENA_SYSTEM_PROMPT_PATH")
        if prompt_path and Path(prompt_path).is_file():
            inputs[0]["text"] += (
                "\n\nTask rules from the frozen Harness:\n" + Path(prompt_path).read_text()
            )
        inputs[0]["text"] += (
            "\n\nThis is an implementation task: inspect the task and repository, make the required focused source changes, and verify them. Finish pending tool work before reporting completion. Do not search for upstream fixes or claim unperformed tests. Inspect the final diff."
        )
        if images:
            inputs[0]["text"] += (
                "\nProblem images are attached directly; /problem_assets is outside workspace tools."
            )
        if profile == "swe":
            inputs[0]["text"] += (
                "\nThe environment is offline with preinstalled dependencies. Preserve existing tests unless this issue explicitly requires test changes. Do not add temporary scripts or output to the repository."
            )
            testbed_python = next(
                (
                    path
                    for path in (
                        "/opt/miniconda3/envs/testbed/bin/python",
                        "/opt/conda/envs/testbed/bin/python",
                        "/opt/venv/bin/python",
                    )
                    if os.path.isfile(path) and os.access(path, os.X_OK)
                ),
                None,
            )
            if testbed_python:
                inputs[0]["text"] += (
                    f"\nThe installed project Python is {testbed_python}; use this executable for tests and reproductions. The default system Python may lack the project dependencies."
                )
        timeout = max(30, int(os.environ.get("ARENA_AGENT_TIMEOUT_SEC", "14400")) - 90)
        workspace = os.environ.get("ARENA_AGENT_WORKDIR") or os.environ.get("ARENA_WORKSPACE")
        if not workspace and Path("/envarena/workspace").is_dir():
            workspace = "/envarena/workspace"
        if not workspace or not Path(workspace).is_dir():
            raise RuntimeError("Missing Arena workspace")
        if graybox:
            from graybox_inputs import prepare

            graybox_state = prepare(workspace, output)
            if graybox_state is not None:
                inputs[0]["text"] += (
                    "\nGraybox public inputs are unpacked at public/. Run Blender as blender. Write deliverables to output/ using the task-required structure."
                )
        write_json(
            output / "runtime-utilities.json",
            {
                "workspace": workspace,
                "budget_profile": "graybox19" if graybox else "generic",
                **json.loads((output / "runtime-utilities.json").read_text()),
            },
        )
        with tempfile.TemporaryDirectory(prefix="areal-arena-") as temp:
            state = Path(temp)
            data = state / "core-data"
            data.mkdir()
            config = state / "config.toml"
            scratch = state / "task-scratch"
            scratch.mkdir()
            delivery_checks = bool(settings.get("delivery_checks", False))
            delivery = None
            piggy = None
            if delivery_checks or profile in ("swe", "piggy"):
                import delivery as delivery_module

                verification = delivery_module.load_verification(root)
            inputs[0]["text"] += (
                f"\nShared temporary files and verification logs belong in {scratch} (workspace://scratch). TMPDIR points there. /tmp itself is private to each command. Use verify_command for relevant test/build checks; it writes a source-bound exit receipt. After edits, rerun the relevant check and wait for exit."
            )
            if profile == "piggy":
                import piggy as piggy_module

                piggy = piggy_module.prepare(root, scratch, output)
                workspace = str(piggy["workspace"])
                inputs[0]["text"] += "\n\n" + piggy["prompt"]
            if profile == "swe":
                initial_test_hashes = delivery_module.test_fingerprints(workspace)

            require_completion_marker = bool(settings.get("require_completion_marker", False))
            if require_completion_marker:
                inputs[0]["text"] += (
                    "\nWhen the implementation and verification are finished, put IMPLEMENTATION_COMPLETE on its own line in your final response, followed by the change and test summary. If no source change is necessary, put IMPLEMENTATION_NO_CHANGE with verification evidence. If you cannot finish, put IMPLEMENTATION_BLOCKED on its own line and give the concrete remaining blocker. Do not emit either marker while there are still actions you intend to take; carry out those actions with tools first."
                )
            config.write_text(make_config(model, endpoint, timeout, settings))
            # This contains only the credential environment variable's name.
            # Preserve the exact adapter settings used by this attempt.
            shutil.copy2(config, output / "core-config.toml")
            input_file = state / "input.json"
            write_json(input_file, inputs)
            write_json(output / "input-media.json", images)
            write_json(output / "input.json", inputs)
            if images:
                shutil.copytree("/problem_assets", output / "problem-assets", dirs_exist_ok=True)
            environment = {
                k: v
                for k, v in os.environ.items()
                if not k.startswith("AREAL_HARNESS_")
                and k not in {"AREAL_MODEL", "AREAL_MODEL_ENDPOINT", "AREAL_MODEL_PROTOCOL"}
            }
            environment["AREAL_API_KEY"] = key
            environment["AREAL_HARNESS_HOME"] = str(state / "home")
            command = [
                sys.executable,
                str(root / "launch.py"),
                "--bin-dir",
                str(root / "bin"),
                "--tui",
                "--config",
                str(config),
                "--data-dir",
                str(data),
                "--workspace",
                workspace,
                "--scratch",
                str(scratch),
                "--allow-write",
                "--allow-network",
                "--allow-concurrent-writes",
                "--sandbox-profile",
                "full-access",
                "--command-timeout-ms",
                "600000",
                "--command-output-bytes",
                "67108864",
                "--input-file",
                str(input_file),
            ]
            seen = set()
            continuations = 0
            max_continuations = int(settings.get("max_no_change_continuations", 0))
            if not 0 <= max_continuations <= 3:
                raise ValueError("max_no_change_continuations must be 0..3")
            with trajectory_path.open("a") as trajectory, (output / "tui.log").open("w") as log:
                trajectory.write(
                    json.dumps(
                        {
                            "type": "system",
                            "subtype": "configuration",
                            "model": model,
                            "implementation": "rust-core-runtime",
                            "protocol": "chat-completions",
                            "system_prompt": (root / "system-prompt.md").read_text(),
                            "parameters": {
                                "temperature": settings.get("temperature", 1),
                                "reasoning_effort": settings.get("reasoning_effort", "medium"),
                                "max_output_tokens": settings.get("max_output_tokens", 16384),
                            },
                            "task_profile": profile,
                            "images": images,
                            "timeout_seconds": timeout,
                            "network": "inherit Arena offline policy",
                        }
                    )
                    + "\n"
                )
                trajectory.flush()
                while True:
                    process = subprocess.Popen(command, stdout=log, stderr=log, env=environment)
                    try:
                        while process.poll() is None:
                            project(data, trajectory, seen)
                            if stopping or time.monotonic() - started > timeout + 35:
                                timed_out = not stopping
                                process.terminate()
                                break
                            time.sleep(1)
                        try:
                            process.wait(timeout=45)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait()
                        threads = project(data, trajectory, seen)
                    finally:
                        if process.poll() is None:
                            process.terminate()
                            try:
                                process.wait(timeout=45)
                            except subprocess.TimeoutExpired:
                                process.kill()
                                process.wait()
                        shutil.copytree(data, output / "core-data", dirs_exist_ok=True)
                    turns = [turn for thread in threads for turn in thread.get("turns", [])]
                    success = (
                        process.returncode == 0
                        and bool(turns)
                        and all(t["status"] == "completed" for t in turns)
                    )
                    remaining = int(timeout - (time.monotonic() - started))
                    if delivery_checks and success:
                        delivery = delivery_module.inspect(
                            workspace,
                            scratch,
                            turns,
                            verification,
                            protect_tests=bool(settings.get("protect_tests", True)),
                        )
                        write_json(output / "delivery.json", delivery)
                    if piggy and success:
                        delivery = piggy_module.inspect(piggy, scratch, turns, verification)
                        write_json(output / "delivery.json", delivery)

                    if (
                        not success
                        or stopping
                        or remaining < 60
                        or continuations >= max_continuations
                    ):
                        break
                    has_changes = has_tracked_changes(workspace)
                    unfinished = require_completion_marker and not completion_confirmed(turns)
                    if delivery is not None:
                        unfinished = delivery["status"] == "incomplete"
                        if delivery["status"] in ("complete", "blocked"):
                            break
                    elif has_changes and not unfinished:
                        break
                    if len(threads) != 1:
                        raise RuntimeError("Continuation requires exactly one native Core thread")
                    continuations += 1
                    reason = (
                        "Your previous response ended without an explicit implementation completion or blocker report."
                        if unfinished
                        else "Your previous turn ended without changes to tracked files."
                    )
                    if delivery is not None:
                        reason = "Delivery inspection found: " + "; ".join(delivery["reasons"])
                    feedback = (
                        reason
                        + " Continue the original implementation task from the existing workspace and conversation. Inspect the current diff, finish the intended implementation and run relevant available checks; do not stop after analysis or a plan. Preserve existing tests. Processes from the previous turn have been cleaned up; start any needed commands again. If the task is already satisfied or your fix uses only new files, verify that with concrete file and test evidence before finishing."
                    )
                    if require_completion_marker:
                        feedback += " Finish with IMPLEMENTATION_COMPLETE on its own line and the actual change/test summary, or IMPLEMENTATION_BLOCKED on its own line with the concrete blocker."
                    command = (
                        command[: command.index("--input-file")]
                        if "--input-file" in command
                        else command[: command.index("--resume")]
                    )
                    command += ["--resume", threads[0]["id"], "--prompt", feedback]
                    config.write_text(make_config(model, endpoint, remaining, settings))
                    shutil.copy2(
                        config, output / ("core-config-continuation-%d.toml" % continuations)
                    )
                    trajectory.write(
                        json.dumps(
                            {
                                "type": "system",
                                "subtype": "completion_continuation",
                                "reason": "missing_completion_report"
                                if unfinished
                                else "no_tracked_changes",
                                "index": continuations,
                                "thread_id": threads[0]["id"],
                                "remaining_seconds": remaining,
                            }
                        )
                        + "\n"
                    )
                    trajectory.flush()
                if piggy and success:
                    if not delivery or delivery["status"] != "complete":
                        raise RuntimeError("Piggy delivery incomplete: " + str(delivery))
                    write_json(
                        output / "release-receipt.json", piggy_module.ship(piggy, scratch, output)
                    )
                if profile == "swe":
                    current_tests = delivery_module.test_fingerprints(workspace)
                    write_json(
                        output / "test-content-audit.json",
                        {
                            "changed": sorted(
                                p
                                for p in initial_test_hashes.keys() | current_tests.keys()
                                if initial_test_hashes.get(p) != current_tests.get(p)
                            )
                        },
                    )
                shutil.copytree(
                    scratch,
                    output / "scratch",
                    dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("skills"),
                )
                usage = {
                    key: sum((t.get("usage") or {}).get(key, 0) for t in turns)
                    for key in ("inputTokens", "outputTokens", "cachedInputTokens")
                }
                result = {
                    "status": "OK" if success else "ERROR",
                    "implementation": "rust-core-runtime",
                    "exit_code": process.returncode,
                    "turn_statuses": [t["status"] for t in turns],
                    "usage": usage,
                    "image_count": len(images),
                    "continuations": continuations,
                    "duration_ms": int((time.monotonic() - started) * 1000),
                    "delivery": delivery,
                }
                if not success:
                    result["error"] = [
                        t.get("error") for t in turns
                    ] or "No completed Core turn; see tui.log"
                if graybox:
                    from graybox_collect import collect

                    if graybox_state is not None:
                        from graybox_inputs import check_public_inputs

                        check_public_inputs(graybox_state[0] / "public", graybox_state[1])
                    receipt = collect(workspace, output)
                    write_json(output / "graybox-collection.json", receipt)
                    result["collection"] = {
                        "status": receipt["status"],
                        "file_count": receipt["file_count"],
                    }
                finalize(result, threads, timed_out=timed_out, interrupted=stopping)
                trajectory.write(
                    json.dumps(
                        {
                            "type": "result",
                            "subtype": "success" if success else "error",
                            "is_error": not success,
                            "num_turns": len(turns),
                            "usage": {
                                "input_tokens": usage["inputTokens"],
                                "output_tokens": usage["outputTokens"],
                            },
                            "duration_ms": result["duration_ms"],
                            "result": result,
                        }
                    )
                    + "\n"
                )
    except Exception as error:
        adapter_error = True
        result["status"] = "ERROR"
        result["error"] = str(error)
        finalize(result, threads, timed_out=timed_out, interrupted=stopping, adapter_error=True)
        print(str(error), file=sys.stderr, flush=True)
        with trajectory_path.open("a") as trajectory:
            trajectory.write(
                json.dumps(
                    {"type": "result", "subtype": "error", "is_error": True, "result": result}
                )
                + "\n"
            )
    finally:
        result["duration_ms"] = int((time.monotonic() - started) * 1000)
        marker = finalize(
            result, threads, timed_out=timed_out, interrupted=stopping, adapter_error=adapter_error
        )
        print(marker, flush=True)
        write_json(output / "native-receipt.json", result)
        write_json(Path(os.environ["ARENA_OUTPUT_DIR"]) / "harness_result.json", result)
        print(json.dumps(result), flush=True)
    return 0 if result["status"] == "OK" else 1


if __name__ == "__main__":
    raise SystemExit(main())
