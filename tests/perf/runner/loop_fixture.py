#!/usr/bin/env python3
"""Fixed-response CLI loop probe. This is not a task-quality benchmark."""

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import agent_entrypoint

COMMAND = 'printf verified > loop-existing.txt && printf verified > loop-probe.txt && test "$(cat loop-probe.txt)" = verified'


class Fixture(BaseHTTPRequestHandler):
    requests = 0

    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path.split("?")[0].endswith("count_tokens"):
            data = b'{"input_tokens":10}'
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if os.environ["AREAL_PERF_RUNNER"] == "harness":
            assert self.path == "/v1/responses", self.path
        type(self).requests += 1
        messages = body.get("input", body.get("messages", []))
        has_result = any(
            message.get("type") == "function_call_output"
            or message.get("role") == "tool"
            or any(
                block.get("type") == "tool_result"
                for block in message.get("content", [])
                if isinstance(block, dict)
            )
            for message in messages
            if isinstance(message, dict)
        )
        tools = {
            tool.get("name", tool.get("function", {}).get("name")): tool
            for tool in body.get("tools", [])
        }
        name = next(
            (
                name
                for name in (
                    "run_command",
                    "exec_command",
                    "shell_command",
                    "shell",
                    "Bash",
                )
                if name in tools
            ),
            None,
        )
        if name is None and not has_result:
            self.send_error(400, "no supported command tool")
            Path("/output/fixture-tool-names.json").write_text(
                json.dumps(sorted(str(name) for name in tools))
            )
            return
        args = {
            "run_command": {
                "argv": ["/bin/sh", "-c", COMMAND],
                "cwd": ".",
                "timeoutMs": 30000,
                "yieldMs": 1000,
            },
            "exec_command": {
                "cmd": COMMAND,
                "yield_time_ms": 1000,
                "max_output_tokens": 1024,
            },
            "shell_command": {"command": COMMAND, "timeout_ms": 30000},
            "shell": {"command": ["/bin/sh", "-c", COMMAND], "timeout_ms": 30000},
            "Bash": {"command": COMMAND, "description": "Write and verify probe file"},
        }.get(name)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()

        def emit(value):
            self.wfile.write((f"event: {value['type']}\ndata: {json.dumps(value)}\n\n").encode())
            self.wfile.flush()

        if "messages" in self.path:
            emit(
                {
                    "type": "message_start",
                    "message": {
                        "id": f"msg_{self.requests}",
                        "type": "message",
                        "role": "assistant",
                        "model": body["model"],
                        "content": [],
                        "stop_reason": None,
                        "stop_sequence": None,
                        "usage": {"input_tokens": 10, "output_tokens": 0},
                    },
                }
            )
            block = (
                {"type": "text", "text": ""}
                if has_result
                else {"type": "tool_use", "id": "call_probe", "name": name, "input": {}}
            )
            delta = (
                {"type": "text_delta", "text": "Verified."}
                if has_result
                else {"type": "input_json_delta", "partial_json": json.dumps(args)}
            )
            emit({"type": "content_block_start", "index": 0, "content_block": block})
            emit({"type": "content_block_delta", "index": 0, "delta": delta})
            emit({"type": "content_block_stop", "index": 0})
            emit(
                {
                    "type": "message_delta",
                    "delta": {
                        "stop_reason": "end_turn" if has_result else "tool_use",
                        "stop_sequence": None,
                    },
                    "usage": {"output_tokens": 5},
                }
            )
            emit({"type": "message_stop"})
        else:
            item = (
                {
                    "type": "message",
                    "id": "msg_probe",
                    "role": "assistant",
                    "status": "completed",
                    "content": [{"type": "output_text", "text": "Verified.", "annotations": []}],
                }
                if has_result
                else {
                    "type": "function_call",
                    "id": "fc_probe",
                    "call_id": "call_probe",
                    "name": name,
                    "arguments": json.dumps(args),
                    "status": "completed",
                }
            )
            response = {
                "id": f"resp_{self.requests}",
                "object": "response",
                "created_at": 0,
                "status": "in_progress",
                "model": body["model"],
                "output": [],
            }
            emit({"type": "response.created", "response": response})
            emit(
                {
                    "type": "response.output_item.added",
                    "output_index": 0,
                    "item": {**item, "status": "in_progress"},
                }
            )
            if has_result:
                emit(
                    {
                        "type": "response.output_text.delta",
                        "item_id": item["id"],
                        "output_index": 0,
                        "content_index": 0,
                        "delta": "Verified.",
                    }
                )
            emit({"type": "response.output_item.done", "output_index": 0, "item": item})
            emit(
                {
                    "type": "response.completed",
                    "response": {
                        **response,
                        "status": "completed",
                        "output": [item],
                        "usage": {
                            "input_tokens": 10,
                            "output_tokens": 5,
                            "total_tokens": 15,
                            "input_tokens_details": {"cached_tokens": 0},
                        },
                    },
                }
            )


def main():
    runner = os.environ["AREAL_PERF_RUNNER"]
    workspace = Path(os.environ.get("AREAL_PERF_WORKSPACE", "/workspace"))
    workspace.mkdir(exist_ok=True)
    Path("/task").mkdir(exist_ok=True)
    Path("/output").mkdir(exist_ok=True)
    Path("/task/task.toml").write_text(
        f"schema_version=1\n[prompt]\npath='prompt.md'\n[limits]\ntimeout_seconds=180\n[runners.harness]\ncommand=[{json.dumps(sys.executable)},'/opt/areal-perf/core_entrypoint.py']\n"
    )
    Path("/task/prompt.md").write_text(
        "Use a shell command to create loop-probe.txt containing verified, check the file, then report completion."
    )
    server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    os.environ.update(
        {
            "AREAL_PERF_MODEL": "fixture",
            "AREAL_PERF_GATEWAY_URL": f"http://127.0.0.1:{server.server_port}",
            "AREAL_PERF_MODEL_PARAMETERS": "{}",
        }
    )
    try:
        status = agent_entrypoint.main()
        result = json.loads(Path("/output/agent-result.json").read_text())
        assert status == 0, result
        assert (workspace / "loop-probe.txt").read_text() == "verified", result
        assert (workspace / "loop-existing.txt").read_text() == "verified", result
        assert Fixture.requests == 2, Fixture.requests
        assert result["model_observation"]["usage_requests"] == 2, result
        print(
            json.dumps(
                {
                    "runner": runner,
                    "fixed_model_requests": Fixture.requests,
                    "status": "passed",
                    "duration_ms": result["duration_ms"],
                }
            )
        )
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
