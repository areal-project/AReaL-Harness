#!/usr/bin/env python3
"""Exercise the real Claude CLI against a local Anthropic protocol fixture."""

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import agent_entrypoint


class MessagesFixture(BaseHTTPRequestHandler):
    requests = 0

    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path.split("?")[0] == "/v1/messages/count_tokens":
            data = b'{"input_tokens":10}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        type(self).requests += 1
        has_result = any(
            block.get("type") == "tool_result"
            for message in body["messages"]
            if isinstance(message.get("content"), list)
            for block in message["content"]
            if isinstance(block, dict)
        )
        if has_result:
            block = {"type": "text", "text": ""}
            delta = {"type": "text_delta", "text": "Done."}
        else:
            block = {"type": "tool_use", "id": "tool_smoke", "name": "Bash", "input": {}}
            delta = {
                "type": "input_json_delta",
                "partial_json": json.dumps(
                    {
                        "command": "printf verified > /workspace/claude-smoke.txt",
                        "description": "Create the requested file",
                    }
                ),
            }
        events = [
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
                    "usage": {
                        "input_tokens": 10,
                        "output_tokens": 0,
                        "cache_read_input_tokens": 5,
                        "cache_creation_input_tokens": 2,
                    },
                },
            },
            {"type": "content_block_start", "index": 0, "content_block": block},
            {"type": "content_block_delta", "index": 0, "delta": delta},
            {"type": "content_block_stop", "index": 0},
            {
                "type": "message_delta",
                "delta": {
                    "stop_reason": "end_turn" if has_result else "tool_use",
                    "stop_sequence": None,
                },
                "usage": {"output_tokens": 7},
            },
            {"type": "message_stop"},
        ]
        data = "".join(
            f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> int:
    server = ThreadingHTTPServer(("127.0.0.1", 0), MessagesFixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    Path("/task/task.toml").write_text(
        "schema_version=1\n[prompt]\npath='prompt.md'\n[limits]\ntimeout_seconds=60\n"
    )
    Path("/task/prompt.md").write_text(
        "Create /workspace/claude-smoke.txt containing verified, using Bash."
    )
    os.environ.update(
        {
            "AREAL_PERF_RUNNER": "claudecode",
            "AREAL_PERF_MODEL": "claude-sonnet-4-5",
            "AREAL_PERF_GATEWAY_URL": f"http://127.0.0.1:{server.server_port}",
        }
    )
    try:
        code = agent_entrypoint.main()
    finally:
        server.shutdown()
        server.server_close()
    result = json.loads(Path("/output/agent-result.json").read_text())
    assert code == 0, result
    assert Path("/workspace/claude-smoke.txt").read_text() == "verified"
    assert result["activity"]["tool_calls"] == result["activity"]["tool_successes"] == 1, result
    assert result["activity"]["assistant_turns"] == 2, result
    assert result["usage"]["cached_input_tokens"] > 0, result
    assert result["terminal_event_seen"], result
    print("PASS Claude Code: Messages SSE -> Bash -> file -> success result and usage")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
