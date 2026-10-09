#!/usr/bin/env python3
"""用真实 CLI/Core/Runtime 和模型桩验收按需公开输入；不调用线上模型。"""

import argparse
import base64
import http.server
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import threading
import zlib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "integrations/envarena"))
import public_inputs  # noqa: E402


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("--bin-dir", type=Path, required=True)
    args = parser.parse_args()
    errors, requests = [], []
    with tempfile.TemporaryDirectory(prefix="arena-input-smoke-") as temporary:
        root = Path(temporary).resolve()
        repo, scratch, assets = (root / p for p in ("repo", "scratch", "assets"))
        for path in (repo, scratch, assets):
            path.mkdir()
        query = root / "TASK.md"
        query.write_text("Keep the original task contract.\n" + "Bounded line.\n" * 200000)

        def chunk(kind, content):
            return (
                struct.pack(">I", len(content))
                + kind
                + content
                + struct.pack(">I", zlib.crc32(kind + content))
            )

        png = (
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00"))
            + chunk(b"IEND", b"")
        )
        (assets / "still.png").write_bytes(png)
        gif = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\x00\x00\x00\x00\xff"
        for index in range(6):
            gif += (
                b"!\xf9\x04\x04\x02\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02"
                + bytes([0x44 if index % 2 == 0 else 0x4C, 1, 0])
            )
        (assets / "motion.gif").write_bytes(gif + b";")
        public = scratch / "public-inputs"
        receipt, records, baseline = public_inputs.prepare(query, public, assets)
        paths = {row["alias"]: row["path"] for row in records}
        inputs = public_inputs.bootstrap(receipt, public)
        input_path = root / "input.json"
        input_path.write_text(json.dumps(inputs))
        assert input_path.stat().st_size < 4096

        class Model(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                try:
                    raw = self.rfile.read(int(self.headers["Content-Length"]))
                    body = json.loads(raw)
                    requests.append(len(raw))
                    tools = [
                        json.loads(m["content"]) for m in body["messages"] if m["role"] == "tool"
                    ]
                    visuals = [
                        p
                        for m in body["messages"]
                        if isinstance(m.get("content"), list)
                        for p in m["content"]
                        if p.get("type") == "image_url"
                    ]
                    step = len(tools)
                    if step == 0:
                        assert not visuals
                    elif step == 1:
                        assert "original task contract" in json.dumps(tools[-1]), tools[-1]
                    elif step == 2:
                        assert "motion.gif" in json.dumps(tools[-1]), tools[-1]
                    elif step == 3:
                        assert len(visuals) == 1, visuals
                    elif step == 4:
                        assert tools[-1]["animation"]["frameCount"] == 6, tools[-1]
                        assert tools[-1]["animation"]["selectedFrames"] == [0, 3, 5]
                        assert len(visuals) == 4
                    elif step == 5:
                        assert tools[-1]["views"][0]["coverage"]["frameIndex"] == 1
                        assert len(visuals) == 5
                    elif step == 6:
                        assert "PERMISSION_DENIED" in json.dumps(tools[-1]).upper().replace(
                            "PERMISSIONDENIED", "PERMISSION_DENIED"
                        ), tools[-1]
                    for visual in visuals:
                        data = base64.b64decode(
                            visual["image_url"]["url"].split(",", 1)[1], validate=True
                        )
                        assert data.startswith(b"\x89PNG\r\n\x1a\n")
                    calls = [
                        ("read_file", {"path": receipt["task"]["path"], "limit": 2}),
                        ("read_file", {"path": receipt["manifest_path"]}),
                        ("image_read", {"path": paths["still.png"]}),
                        ("image_read", {"path": paths["motion.gif"]}),
                        ("image_read", {"path": paths["motion.gif"], "frameIndex": 1}),
                        ("fs_write", {"path": receipt["task"]["path"], "text": "tampered"}),
                    ]
                    delta, finish = {"content": "Input delivery verified."}, "stop"
                    if step < len(calls):
                        name, arguments = calls[step]
                        delta = {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": f"c{step}",
                                    "type": "function",
                                    "function": {"name": name, "arguments": json.dumps(arguments)},
                                }
                            ]
                        }
                        finish = "tool_calls"
                    response = {
                        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
                        "usage": {"prompt_tokens": 100, "completion_tokens": 20},
                    }
                    encoded = ("data: " + json.dumps(response) + "\n\ndata: [DONE]\n\n").encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Content-Length", str(len(encoded)))
                    self.end_headers()
                    self.wfile.write(encoded)
                except Exception as error:
                    errors.append(repr(error))
                    self.send_error(400)

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Model)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        config = root / "config.toml"
        config.write_text(f"""schema_version=1
[model]
name="fixture"
max_retries=0
max_request_bytes=4194304
[model.providers.default]
protocol="chat-completions"
endpoint="http://127.0.0.1:{server.server_port}/v1/chat/completions"
api_key_env="AREAL_API_KEY"
[limits]
context_compaction_enabled=false
context_window_tokens=0
context_window_bytes=0
max_tool_calls=16
""")
        environment = {k: v for k, v in os.environ.items() if not k.startswith("AREAL_")}
        environment.update(AREAL_API_KEY="fixture", AREAL_HARNESS_HOME=str(root / "home"))
        command = [
            sys.executable,
            str(ROOT / "scripts/launch.py"),
            "--bin-dir",
            str(args.bin_dir.resolve()),
            "--tui",
            "--config",
            str(config),
            "--data-dir",
            str(root / "data"),
            "--workspace",
            str(repo),
            "--scratch",
            str(scratch),
            "--read-only-path",
            str(public),
            "--sandbox-profile",
            "full-access",
            "--allow-write",
            "--input-error-file",
            str(root / "input-error.json"),
            "--input-file",
            str(input_path),
        ]
        try:
            done = subprocess.run(
                command, env=environment, text=True, capture_output=True, timeout=90
            )
            assert done.returncode == 0, done.stderr + done.stdout + str(errors)
            assert not errors, errors
            assert len(requests) == 7, requests
            public_inputs.verify(public, baseline)
            # 同一个真实入口拒绝旧式大封套，且不会发出额外模型请求。
            input_path.write_text(" " * (2 * 1024 * 1024 + 1))
            rejected = subprocess.run(
                command, env=environment, text=True, capture_output=True, timeout=60
            )
            assert rejected.returncode != 0
            error = json.loads((root / "input-error.json").read_text())
            assert error["code"] == "INPUT_ENVELOPE_TOO_LARGE"
            assert len(requests) == 7
            print(
                json.dumps(
                    {
                        "bootstrapBytes": public_inputs.validate_envelope(inputs),
                        "modelRequests": len(requests),
                        "maxRequestBytes": max(requests),
                        "visualViews": 5,
                        "publicInputIntegrity": "verified",
                        "oversizedInput": "rejected_before_model",
                    }
                )
            )
        finally:
            server.shutdown()
            thread.join(timeout=5)


if __name__ == "__main__":
    main()
