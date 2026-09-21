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
        "--sandbox-profile", choices=["native", "outer-container-perf"], default="native"
    )
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    errors = []
    requests = []
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
                        assert results[1]["matches"][0]["line"] == 1
                        name = "fs_apply_patch"
                        arguments = {"path": "code.py", "oldText": "1", "newText": "2"}
                    elif n == 3:
                        assert results[2]["fileVersion"] != results[0]["fileVersion"]
                        name = "run_command"
                        arguments = {"command": 'printf "value = 3\\n" > code.py'}
                    elif n == 4:
                        name = "fs_apply_patch"
                        arguments = {"path": "code.py", "oldText": "3", "newText": "4"}
                    elif n == 5:
                        assert results[4]["error"]["code"] == "CONFLICT", results[4]
                        assert (repo / "code.py").read_text() == "value = 3\n"
                        name = "read_file"
                        arguments = {"path": "code.py"}
                    elif n == 6:
                        name = "fs_apply_patch"
                        arguments = {"path": "code.py", "oldText": "3", "newText": "4"}
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
[model]
name = "fixture"
max_retries = 0
[model.providers.default]
protocol = "chat-completions"
endpoint = "http://127.0.0.1:{server.server_port}/v1/chat/completions"
api_key_env = "AREAL_API_KEY"
[limits]
turn_timeout_seconds = 60
max_tool_calls = 20
"""
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
            receipts = list((scratch / "verification").glob("*.json"))
            assert len(receipts) == 1
            audits = [json.loads(p.read_text()) for p in (data / "model-requests").glob("*.json")]
            assert len(audits) == len(requests) and all(a["outcome"] == "completed" for a in audits)
            print(
                json.dumps(
                    {
                        "native_tool_smoke": "passed",
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
