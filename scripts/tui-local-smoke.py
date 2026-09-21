#!/usr/bin/env python3
"""Built local TUI + real Runtime native backend, with a deterministic model fixture."""

import http.server
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
requests = []
errors = []


class Model(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        try:
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(request)
            tools = {tool["function"]["name"] for tool in request["tools"]}
            assert {"fs_read", "run_command"} <= tools, tools
            messages = request["messages"]
            prompt = next(m["content"] for m in reversed(messages) if m["role"] == "user")
            tool_results = [m for m in messages if m["role"] == "tool"]
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()

            def event(delta, reason=None):
                self.wfile.write(
                    (
                        "data: "
                        + json.dumps(
                            {
                                "choices": [
                                    {
                                        "index": 0,
                                        "delta": delta,
                                        "finish_reason": reason,
                                    }
                                ]
                            }
                        )
                        + "\n\n"
                    ).encode()
                )
                self.wfile.flush()

            if prompt == "read-fixture" and not tool_results:
                event(
                    {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_read",
                                "type": "function",
                                "function": {
                                    "name": "fs_read",
                                    "arguments": json.dumps(
                                        {
                                            "path": "workspace://repo/input.txt",
                                            "offset": 0,
                                            "maxBytes": 1024,
                                        }
                                    ),
                                },
                            }
                        ]
                    }
                )
                event({}, "tool_calls")
            else:
                if prompt == "read-fixture":
                    assert "local-runtime-fixture" in tool_results[-1]["content"], tool_results
                event({"content": "reply:" + prompt})
                if prompt == "hang":
                    # Keep SSE open until the TUI cancellation closes the connection.
                    self.connection.settimeout(15)
                    try:
                        self.connection.recv(1)
                    except (OSError, TimeoutError):
                        pass
                    return
                event({}, "stop")
            self.wfile.write(b"data: [DONE]\n\n")
        except Exception as error:
            errors.append(repr(error))
            print(f"model fixture failed: {error!r}", file=sys.stderr)
            self.close_connection = True


model = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Model)
threading.Thread(target=model.serve_forever, daemon=True).start()
try:
    with tempfile.TemporaryDirectory(prefix="areal-local-smoke-") as temporary:
        root = Path(temporary).resolve()
        workspace, data = root / "workspace", root / "data"
        workspace.mkdir()
        (workspace / "input.txt").write_text("local-runtime-fixture\n")
        # Both module and interpreter lookup must be independent of task files.
        marker = root / "untrusted-launcher-ran"
        untrusted = (
            "from pathlib import Path\n"
            f"Path({str(marker)!r}).write_text('untrusted')\n"
            "raise AssertionError('workspace code imported by trusted launcher')\n"
        )
        (workspace / "subprocess.py").write_text(untrusted)
        pythonpath = root / "pythonpath"
        pythonpath.mkdir()
        (pythonpath / "sitecustomize.py").write_text(untrusted)
        (workspace / "python3").write_text(f"#!/bin/sh\nprintf untrusted > '{marker}'\nexit 97\n")
        (workspace / "python3").chmod(0o755)
        config = root / "config.toml"
        config.write_text(f"""schema_version = 1
[server]
listen = "127.0.0.1:4500"
data_dir = "data"
[model]
provider = "fixture"
name = "fixture"
[model.providers.fixture]
protocol = "chat-completions"
endpoint = "http://127.0.0.1:{model.server_port}"
""")
        args = [
            str(ROOT / "target/debug/areal-tui"),
            "--workspace",
            str(workspace),
            "--config",
            str(config),
            "--theme=dark",
            "--ascii=true",
        ]
        # TOML-only model/data configuration must survive TUI -> launcher -> Core.
        env = {
            k: v
            for k, v in os.environ.items()
            if not k.startswith(("AREAL_HARNESS_", "AREAL_MODEL", "OTEL_")) and k != "AREAL_API_KEY"
        }
        env.update(
            {
                "HOME": str(root / "user"),
                "AREAL_HARNESS_HOME": str(root / "home"),
                "PATH": f"{workspace}:/usr/bin:/bin",
                "PYTHONPATH": str(pythonpath),
                "AREAL_CODEX_EXECUTABLE": "/nonexistent/must-not-be-used",
                "OTEL_SDK_DISABLED": "true",
                "NO_PROXY": "127.0.0.1,localhost",
                "no_proxy": "127.0.0.1,localhost",
            }
        )

        def run(command, cwd=ROOT):
            result = subprocess.run(
                command, env=env, text=True, capture_output=True, timeout=90, cwd=cwd
            )
            assert result.returncode == 0, result.stdout + result.stderr
            for pid in re.findall(r"AReaL launcher Core PID: (\d+)", result.stdout + result.stderr):
                try:
                    os.kill(int(pid), 0)
                except ProcessLookupError:
                    pass
                else:
                    raise AssertionError(f"Core {pid} leaked")
            return result

        first = run(
            [
                *args,
                "--prompt",
                "read-fixture",
                "--no-logo",
                "--color=never",
                "--tui-config=missing.toml",
            ],
            cwd=workspace,
        )
        assert not marker.exists(), "trusted launcher ran untrusted Python code"
        assert first.stdout.strip() == "reply:read-fixture", first
        thread_id = re.search(r"Thread: ([a-f0-9-]+)", first.stderr)[1]
        second = run([*args, "--resume", thread_id, "--prompt=-again with spaces"])
        assert second.stdout.strip() == "reply:-again with spaces", second
        snapshot = json.loads((data / f"{thread_id}.json").read_text())
        assert len(snapshot["thread"]["turns"]) == 2
        assert snapshot["thread"]["turns"][-1]["status"] == "completed"
        assert any(m["role"] == "tool" for m in requests[-1]["messages"])
        pty = run([sys.executable, "-I", "-S", str(ROOT / "scripts/tui-pty-smoke.py"), *args])
        print(pty.stdout.strip())
        # Every local launch must use its actual bound endpoint and close it on exit.
        for log in data.glob("launch-*.log"):
            match = re.search(r"listening on ws://127.0.0.1:(\d+)", log.read_text())
            assert match, log.read_text()
            with socket.socket() as connection:
                connection.settimeout(1)
                assert connection.connect_ex(("127.0.0.1", int(match[1]))) != 0, (
                    "Core listener leaked"
                )
        assert not errors, errors
        print(
            "PASS default local TUI: TOML-only model/data, real Runtime fs_read, persistent resume, ephemeral listener, PTY and owned Core cleanup"
        )
finally:
    model.shutdown()
    model.server_close()
