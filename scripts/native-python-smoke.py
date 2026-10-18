#!/usr/bin/env python3
"""真实 Core/Runtime 的 Python 执行与 scratch 能力回归，不调用外部模型。"""

import argparse
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading


def check(binary, explicit_scratch, sandbox_profile):
    root = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="areal-python-smoke-") as temp:
        base = Path(temp)
        repo, data = (base / name for name in ("repo", "data"))
        scratch = base / ("custom-scratch" if explicit_scratch else "scratch")
        repo.mkdir()
        if explicit_scratch:
            scratch.mkdir()
        (repo / "example.py").write_text('print("PYTHON_OK")\n')
        (repo / "json.py").write_text('raise RuntimeError("untrusted import")\n')
        steps = [
            ("read_file", {"path": "example.py"}, None),
            ("run_command", {"command": "python3 -B example.py"}, 0),
            ("run_command", {"argv": ["/usr/bin/python3", "-c", "raise SystemExit(7)"]}, 7),
            ("verify_command", {"argv": ["python3", "-B", "example.py"]}, 0),
            ("verify_command", {"argv": ["python3", "-c", "raise SystemExit(7)"]}, 7),
        ]
        errors, results = [], []
        state = {"step": 0, "calls": 0, "done": False}

        class Model(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                try:
                    request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    names = {tool["function"]["name"] for tool in request["tools"]}
                    assert "verify_command" in names, names
                    responses = [m for m in request["messages"] if m["role"] == "tool"]
                    name, arguments = None, None
                    if responses:
                        result = json.loads(responses[-1]["content"])
                        if (
                            result.get("state") == "running"
                            or result.get("outputReadComplete") is False
                        ):
                            name, arguments = "read_process", {"processId": result["processId"]}
                        else:
                            tool, _, exit_code = steps[state["step"]]
                            if tool == "read_file":
                                assert result["lines"][0]["text"] == 'print("PYTHON_OK")\n', result
                            else:
                                assert result["exitCode"] == exit_code, result
                                assert result["commandStatus"] == (
                                    "succeeded" if exit_code == 0 else "failed"
                                ), result
                                if tool == "verify_command":
                                    assert result["verification"]["status"] == "complete", result
                                    assert result["verification"]["exitCode"] == exit_code, result
                            results.append(result)
                            state["step"] += 1
                    if name is None and state["step"] < len(steps):
                        name, arguments, _ = steps[state["step"]]
                    delta, finish = {"content": "PYTHON_SMOKE_DONE"}, "stop"
                    if name:
                        state["calls"] += 1
                        delta = {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": f"call_{state['calls']}",
                                    "type": "function",
                                    "function": {"name": name, "arguments": json.dumps(arguments)},
                                }
                            ]
                        }
                        finish = "tool_calls"
                    else:
                        state["done"] = True
                    body = (
                        "data: "
                        + json.dumps(
                            {"choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                        )
                        + "\n\ndata: [DONE]\n\n"
                    ).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                except Exception as error:
                    errors.append(repr(error))
                    self.send_error(400)

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Model)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        config = base / "config.toml"
        config.write_text(f"""schema_version = 1
[model]
name = "fixture"
max_retries = 0
[model.providers.default]
protocol = "chat-completions"
endpoint = "http://127.0.0.1:{server.server_port}/v1/chat/completions"
api_key_env = "AREAL_API_KEY"
[limits]
max_tool_calls = 20
""")
        env = {k: v for k, v in os.environ.items() if not k.startswith("AREAL_")}
        env.update(
            HOME=str(base / "user"),
            AREAL_HARNESS_HOME=str(base / "home"),
            AREAL_API_KEY="fixture-only",
        )
        try:
            done = subprocess.run(
                [
                    sys.executable,
                    str(root / "scripts/launch.py"),
                    "--bin-dir",
                    str(binary),
                    "--tui",
                    "--workspace",
                    str(repo),
                    "--data-dir",
                    str(data),
                    "--config",
                    str(config),
                    "--allow-write",
                    *(["--sandbox-profile", sandbox_profile] if sandbox_profile else []),
                    *(["--scratch", str(scratch)] if explicit_scratch else []),
                    "--prompt",
                    "Verify Python execution.",
                ],
                env=env,
                capture_output=True,
                text=True,
                timeout=70,
            )
            assert not errors, errors
            assert done.returncode == 0, done.stdout[-3000:] + done.stderr[-3000:]
            assert state["done"] and len(results) == len(steps), (state, done.stdout)
            assert "PYTHON_OK" in results[1]["stdout"], results[1]
            # 自动与显式目录都应使用每个 Thread 的私有子目录，并保留真实验证回执。
            task_scratch = list(scratch.glob("agent-*"))
            assert len(task_scratch) == 1, task_scratch
            receipts = list((task_scratch[0] / "verification").glob("*.json"))
            assert len(receipts) == 2, receipts
            assert sorted(json.loads(p.read_text())["exitCode"] for p in receipts) == [0, 7]
            if explicit_scratch:
                assert not (base / "scratch").exists()
            print(
                json.dumps(
                    {
                        "native_python": "passed",
                        "scratch": "explicit" if explicit_scratch else "automatic",
                        "sandbox_profile": sandbox_profile or "default",
                        "tools": len(steps),
                        "receipts": len(receipts),
                    }
                )
            )
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bin-dir", type=Path, required=True)
    args = parser.parse_args()
    for profile in (None, "native"):
        for configured in (False, True):
            check(args.bin_dir.resolve(), configured, profile)
