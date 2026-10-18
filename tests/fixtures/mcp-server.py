#!/usr/bin/env python3
"""Deterministic stdio MCP peer; standard library only, no external services."""

import json
import os
from pathlib import Path
import sys

log = Path(sys.argv[1])
mode = sys.argv[2] if len(sys.argv) > 2 else "normal"


def record(value):
    with log.open("a", encoding="utf-8") as output:
        output.write(json.dumps(value) + "\n")


def send(value):
    print(json.dumps({"jsonrpc": "2.0", **value}), flush=True)


record({"event": "started", "pid": os.getpid()})
try:
    for line in sys.stdin:
        request = json.loads(line)
        record(request)
        method = request.get("method")
        params = request.get("params", {})
        result = None
        if method == "initialize":
            if mode == "hang-startup":
                continue
            result = {
                "protocolVersion": "2025-11-25",
                "capabilities": {"tools": {"listChanged": True}},
                "serverInfo": {"name": "fixture", "version": "1"},
            }
        elif method == "tools/list":
            name = "echo.dot" if params.get("cursor") else "echo"
            result = {
                "tools": [
                    {
                        "name": name,
                        "description": "Echo a value",
                        "inputSchema": {
                            "type": "object",
                            "properties": {"value": {"type": "string"}},
                            "required": ["value"],
                            "additionalProperties": False,
                        },
                        "outputSchema": {
                            "type": "object",
                            "properties": {"echo": {"type": "string"}},
                            "required": ["echo"],
                        },
                    }
                ]
            }
            if not params.get("cursor") or mode == "repeat-cursor":
                result["nextCursor"] = "second-page"
        elif method == "tools/call":
            value = params["arguments"]["value"]
            if value == "hang":
                continue
            if value == "disconnect":
                break
            if value == "change":
                send({"method": "notifications/tools/list_changed"})
            text = (
                json.dumps(
                    {
                        "visible": os.getenv("MCP_VISIBLE"),
                        "hidden": os.getenv("MCP_HIDDEN"),
                        "cwd": os.getcwd(),
                        "proxy": {
                            key: os.getenv(key)
                            for key in (
                                "HTTP_PROXY",
                                "HTTPS_PROXY",
                                "ALL_PROXY",
                                "NO_PROXY",
                                "http_proxy",
                                "https_proxy",
                                "all_proxy",
                                "no_proxy",
                            )
                        },
                    }
                )
                if value == "environment"
                else value
            )
            result = {
                "content": [{"type": "text", "text": text}],
                "structuredContent": {"echo": 7 if value == "bad-output" else value},
                "isError": value == "failure",
            }
            if value == "large":
                result["content"][0]["text"] = "x" * 17000 + "关键值:violet\n" + "z" * 17000
            if value == "too-large":
                result["content"][0]["text"] = "x" * (8 * 1024 * 1024 + 1)
            if value == "image":
                result["content"] = [{"type": "image", "data": "AA==", "mimeType": "image/png"}]
        if result is not None:
            send({"id": request["id"], "result": result})
finally:
    record({"event": "exited"})
