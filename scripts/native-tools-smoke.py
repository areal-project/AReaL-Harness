#!/usr/bin/env python3
"""Real native binaries/tools with a deterministic model; no external model calls."""

import argparse
import base64
import hashlib
import http.server
import json
import os
from pathlib import Path
import random
import struct
import subprocess
import sys
import tempfile
import threading
import zlib


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("--bin-dir", type=Path, required=True)
    parser.add_argument(
        "--sandbox-profile",
        choices=["native", "outer-container-perf", "full-access"],
        default="native",
    )
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    errors = []
    requests = []
    recovered = {}
    with tempfile.TemporaryDirectory(prefix="areal-native-tools-") as temp:
        base = Path(temp)
        repo = base / "repo"
        scratch = base / "scratch"
        data = base / "data"
        repo.mkdir()
        scratch.mkdir()
        (repo / "code.py").write_text("value = 1\n")
        (repo / "json.py").write_text(
            'raise RuntimeError("repository must not shadow helper standard library")\n'
        )

        def chunk(kind, content):
            return (
                struct.pack(">I", len(content))
                + kind
                + content
                + struct.pack(">I", zlib.crc32(kind + content))
            )

        pixels = random.Random(42).randbytes(256 * 256 * 3)
        scan = b"".join(b"\0" + pixels[y * 768 : (y + 1) * 768] for y in range(256))
        png = (
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", 256, 256, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(scan))
            + chunk(b"IEND", b"")
        )
        (repo / "noise.png").write_bytes(png)

        class Model(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                try:
                    request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    requests.append(request)
                    names = {tool["function"]["name"] for tool in request["tools"]}
                    assert "fs_apply_patch" not in names
                    assert "fs_apply_patches" in names
                    assert "mcp__inventory__snapshot" in names
                    assert "read_tool_result" in names
                    results = [
                        json.loads(m["content"]) for m in request["messages"] if m["role"] == "tool"
                    ]
                    assert any("Tool budget:" in str(m["content"]) for m in request["messages"]), (
                        "missing budget notice"
                    )
                    n = len(results)
                    name = None
                    arguments = None
                    if n == 0:
                        name = "read_file"
                        arguments = {"path": "code.py"}
                    elif n == 1:
                        assert (
                            results[0].get("lines")
                            and results[0]["lines"][0]["number"] == 1
                            and results[0]["fileVersion"]
                        ), results[0]
                        name = "search_files"
                        arguments = {"pattern": "^value", "context": 0}
                    elif n == 2:
                        assert (
                            results[1].get("matches") and results[1]["matches"][0]["line"] == 1
                        ), results[1]
                        name = "fs_apply_patches"
                        arguments = {
                            "path": "code.py",
                            "patches": [{"oldText": "1", "newText": "2"}],
                        }
                    elif n == 3:
                        assert results[2]["fileVersion"] != results[0]["fileVersion"]
                        name = "run_command"
                        arguments = {"command": 'printf "value = 3\\n" > code.py'}
                    elif n == 4:
                        assert results[3]["exitCode"] == 0, results[3]
                        name = "fs_apply_patches"
                        arguments = {
                            "path": "code.py",
                            "patches": [{"oldText": "3", "newText": "4"}],
                        }
                    elif n == 5:
                        assert results[4]["error"]["code"] == "CONFLICT", results[4]
                        assert (repo / "code.py").read_text() == "value = 3\n"
                        name = "read_file"
                        arguments = {"path": "code.py"}
                    elif n == 6:
                        name = "fs_apply_patches"
                        arguments = {
                            "path": "code.py",
                            "patches": [{"oldText": "3", "newText": "4"}],
                        }
                    elif n == 7:
                        name = "verify_command"
                        arguments = {
                            "argv": [
                                "/usr/bin/python3",
                                "-c",
                                'import time; time.sleep(.2); from code import value; print("output"*4000); assert value == 4',
                            ],
                            "yieldMs": 0,
                        }
                    elif results[-1].get("verification", {}).get("status") == "pending":
                        name = "read_process"
                        arguments = {"processId": results[-1]["processId"]}
                    elif "verification" in results[-1]:
                        receipt = results[-1]["verification"]
                        assert receipt["status"] == "complete" and receipt["exitCode"] == 0, receipt
                        assert receipt["sourceUnchanged"] and receipt["logBytes"] > 16000
                        assert "outputTail" not in receipt and results[-1]["state"] == "exited"
                        name = "large_fixture"
                        arguments = {}
                    elif results[-1].get("rawAvailable"):
                        name = "read_tool_result"
                        arguments = {"resultId": results[-1]["rawResult"]["resultId"]}
                    elif results[-1].get("historicalSnapshot"):
                        page = results[-1]
                        pages = recovered.setdefault(page["resultId"], [])
                        pages.append(page["text"])
                        if not page["eof"]:
                            name = "read_tool_result"
                            arguments = {"resultId": page["resultId"], "after": page["nextCursor"]}
                        else:
                            original = json.loads("".join(pages))
                            text = original["contentItems"][0]["text"]
                            if text == "x" * 40000:
                                name = "mcp__inventory__snapshot"
                                arguments = {}
                            else:
                                rows = json.loads(text)
                                assert len(rows) == 700 and rows[347] == {
                                    "state": "active",
                                    "value": "quartz-river-846",
                                }
                                name = "image_read"
                                arguments = {"path": "noise.png"}
                    else:
                        metadata = results[-1]
                        assert metadata["sourceSha256"] == hashlib.sha256(png).hexdigest()
                        assert metadata["outputDimensions"] == [256, 256]
                        visuals = [
                            part
                            for message in request["messages"]
                            if message["role"] == "user" and isinstance(message["content"], list)
                            for part in message["content"]
                            if part["type"] == "image_url"
                        ]
                        assert len(visuals) == 1
                        image_url = visuals[0]["image_url"]["url"]
                        assert image_url.startswith("data:image/png;base64,")
                        delivered = base64.b64decode(image_url.split(",", 1)[1], validate=True)
                        assert delivered.startswith(b"\x89PNG\r\n\x1a\n")
                        assert struct.unpack(">II", delivered[16:24]) == (256, 256)
                    delta = {"content": "All native tools verified."}
                    finish = "stop"
                    if name:
                        delta = {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": "c" + str(n),
                                    "type": "function",
                                    "function": {"name": name, "arguments": json.dumps(arguments)},
                                }
                            ]
                        }
                        finish = "tool_calls"
                    payload = {
                        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
                        "usage": {"prompt_tokens": 100, "completion_tokens": 20},
                    }
                    body = ("data: " + json.dumps(payload) + "\n\ndata: [DONE]\n\n").encode()
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
        config = f"""schema_version = 1
[tools]
extensions_file = "tools.json"
[model]
name = "fixture"
max_retries = 0
[model.providers.default]
protocol = "chat-completions"
endpoint = "http://127.0.0.1:{server.server_port}/v1/chat/completions"
api_key_env = "AREAL_API_KEY"
[limits]
# 此 fixture 按完整工具历史计步；压缩行为由 Engine context 测试独立覆盖。
context_window_tokens = 0
max_tool_calls = 32
"""
        # 申请上限高于默认父 Scope，Core 应收窄额度；不能在执行前 PermissionDenied。
        awk = 'BEGIN { printf "{\\"success\\":true,\\"contentItems\\":[{\\"type\\":\\"inputText\\",\\"text\\":\\""; for(i=0;i<40000;i++) printf "x"; print "\\"}]}"; exit }'
        (base / "tools.json").write_text(
            json.dumps(
                {
                    "tools": [
                        {
                            "definition": {
                                "name": "large_fixture",
                                "description": "Return a large immutable fixture",
                                "inputSchema": {"type": "object", "properties": {}},
                            },
                            "argv": ["/usr/bin/awk", awk],
                            "timeoutMs": 10000,
                        }
                    ],
                    "mcpServers": {
                        "inventory": {
                            "transport": {
                                "type": "stdio",
                                "command": sys.executable,
                                "args": [str(root / "tests/fixtures/inventory-mcp.py")],
                            }
                        }
                    },
                }
            )
        )
        (base / "config.toml").write_text(config)
        environment = {
            k: v
            for k, v in os.environ.items()
            if not k.startswith("AREAL_HARNESS_")
            and k not in {"AREAL_MODEL", "AREAL_MODEL_ENDPOINT", "AREAL_MODEL_PROTOCOL"}
        }
        environment["HOME"] = str(base / "user")
        environment["AREAL_API_KEY"] = "fixture-only"
        environment["AREAL_HARNESS_HOME"] = str(base / "home")
        # 即使宿主 PATH 的 rg 不可用，search_files 仍必须通过内置库执行。
        host_tools = base / "host-tools"
        host_tools.mkdir()
        (host_tools / "rg").write_text("#!/bin/sh\nexit 99\n")
        (host_tools / "rg").chmod(0o755)
        environment["PATH"] = str(host_tools) + os.pathsep + environment.get("PATH", "")
        try:
            done = subprocess.run(
                [
                    sys.executable,
                    str(root / "scripts/launch.py"),
                    "--bin-dir",
                    str(args.bin_dir.resolve()),
                    "--tui",
                    "--sandbox-profile",
                    args.sandbox_profile,
                    "--config",
                    str(base / "config.toml"),
                    "--workspace",
                    str(repo),
                    "--scratch",
                    str(scratch),
                    "--data-dir",
                    str(data),
                    "--allow-write",
                    "--allow-concurrent-writes",
                    "--prompt",
                    "Exercise the native tools.",
                ],
                env=environment,
                capture_output=True,
                text=True,
                timeout=100,
            )
            assert not errors, errors
            assert done.returncode == 0, done.stdout[-5000:] + done.stderr[-5000:]
            assert (repo / "code.py").read_text() == "value = 4\n"
            task_scratch = list(scratch.glob("agent-*"))
            assert len(task_scratch) == 1, task_scratch
            receipts = list((task_scratch[0] / "verification").glob("*.json"))
            assert len(receipts) == 1, receipts
            assert json.loads(receipts[0].read_text())["exitCode"] == 0
            audits = [json.loads(p.read_text()) for p in (data / "model-requests").glob("*.json")]
            assert len(audits) == len(requests) and all(a["outcome"] == "completed" for a in audits)
            print(
                json.dumps(
                    {
                        "native_tool_smoke": "passed",
                        "sandbox_profile": args.sandbox_profile,
                        "model_requests": len(requests),
                        "verification_receipts": len(receipts),
                        "png_bytes": len(png),
                    }
                )
            )
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    main()
