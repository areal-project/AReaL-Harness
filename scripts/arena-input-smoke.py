#!/usr/bin/env python3
"""用真实 CLI/Core/Runtime 和模型桩验收按需公开输入；不调用线上模型。"""

import argparse
import base64
import http.server
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import zlib
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "integrations/envarena"))
import public_inputs  # noqa: E402


def main():
    parser = argparse.ArgumentParser(__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--bin-dir", type=Path)
    mode.add_argument(
        "--package", type=Path, help="validate a frozen pyz inside an isolated Linux container"
    )
    parser.add_argument(
        "--public-inputs-dir",
        type=Path,
        help="replay archived TASK.md and assets/ with the fixture model",
    )
    parser.add_argument(
        "--check-model-overrides",
        action="store_true",
        help="verify nullable sampling overrides through the packaged runner and HTTP requests",
    )
    args = parser.parse_args()
    if args.check_model_overrides and not args.package:
        parser.error("--check-model-overrides requires --package")
    errors, requests, visual_counts = [], [], []
    request_parameters = []
    image_evidence = {}
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
        if args.public_inputs_dir:
            query.write_bytes((args.public_inputs_dir / "TASK.md").read_bytes())
            shutil.rmtree(assets)
            shutil.copytree(args.public_inputs_dir / "assets", assets)
        if args.package:
            assert Path("/.dockerenv").exists(), "package smoke requires an isolated container"
            assert not Path("/problem_assets").exists(), "do not replace existing public inputs"
            shutil.copytree(assets, "/problem_assets")
        public = scratch / "public-inputs"
        receipt, records, baseline = public_inputs.prepare(query, public, assets)
        paths = {row["alias"]: row["path"] for row in records}
        replay_calls = [
            ("read_file", {"path": receipt["task"]["path"], "limit": 2}),
            ("read_file", {"path": receipt["manifest_path"]}),
        ]
        by_path = {row["path"]: row for row in records}
        for row in by_path.values():
            replay_calls.append(("image_read", {"path": row["path"]}))
            if row["mime_hint"] == "image/gif":
                replay_calls.append(("image_read", {"path": row["path"], "frameIndex": 0}))
        replay_calls.append(("fs_write", {"path": receipt["task"]["path"], "text": "tampered"}))
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
                    request_parameters.append(
                        {
                            key: body[key]
                            for key in ("temperature", "reasoning_effort", "max_completion_tokens")
                            if key in body
                        }
                    )
                    if args.check_model_overrides:
                        assert "temperature" not in body, "temperature must be omitted on the wire"
                        assert body["reasoning_effort"] == "low"
                        assert body["max_completion_tokens"] == 2048
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
                    visual_counts.append(len(visuals))
                    step = len(tools)
                    if args.public_inputs_dir:
                        if step == 0:
                            assert not visuals
                        elif step == 1:
                            marker = json.dumps(
                                query.read_text().splitlines()[0][:80], ensure_ascii=False
                            )[1:-1]
                            assert marker in json.dumps(tools[-1], ensure_ascii=False), tools[-1]
                        elif step == 2:
                            assert records[0]["sha256"] in json.dumps(tools[-1]), tools[-1]
                        elif replay_calls[step - 1][0] == "image_read":
                            params = replay_calls[step - 1][1]
                            row, result = by_path[params["path"]], tools[-1]
                            assert result["sourceSha256"] == row["sha256"], result
                            assert result["sourceBytes"] == row["bytes"], result
                            assert result["views"], result
                            if row["mime_hint"] == "image/gif":
                                animation = result["animation"]
                                count = animation["frameCount"]
                                selected = (
                                    [0]
                                    if "frameIndex" in params
                                    else sorted({0, count // 2, count - 1})
                                )
                                assert animation["selectedFrames"] == selected, animation
                            image_evidence[str(step)] = {
                                "sourceSha256": row["sha256"],
                                "sourceBytes": row["bytes"],
                                "animation": result["animation"],
                                "views": len(result["views"]),
                            }
                            assert len(visuals) == sum(
                                item["views"] for item in image_evidence.values()
                            )
                        else:
                            assert "PERMISSION_DENIED" in json.dumps(tools[-1]).upper().replace(
                                "PERMISSIONDENIED", "PERMISSION_DENIED"
                            ), tools[-1]
                    elif step == 0:
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
                        assert len(data) <= 1024 * 1024
                    calls = (
                        replay_calls
                        if args.public_inputs_dir
                        else [
                            ("read_file", {"path": receipt["task"]["path"], "limit": 2}),
                            ("read_file", {"path": receipt["manifest_path"]}),
                            ("image_read", {"path": paths["still.png"]}),
                            ("image_read", {"path": paths["motion.gif"]}),
                            ("image_read", {"path": paths["motion.gif"], "frameIndex": 1}),
                            ("fs_write", {"path": receipt["task"]["path"], "text": "tampered"}),
                        ]
                    )
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
max_request_bytes=16777216
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
        environment.update(
            AREAL_API_KEY="fixture", AREAL_HARNESS_HOME=str(root / "home"), HOME=str(root / "home")
        )
        command = [
            sys.executable,
            str(ROOT / "scripts/launch.py"),
            "--bin-dir",
            str(args.bin_dir.resolve()) if args.bin_dir else "",
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
            # 与 Runner 的累计工具输出预算一致，允许重新读取同一原始 GIF。
            "--command-output-bytes",
            "67108864",
            "--allow-write",
            "--input-error-file",
            str(root / "input-error.json"),
            "--input-file",
            str(input_path),
        ]
        if args.package:
            output = root / "arena-output"
            output.mkdir()
            harness = root / "platform-harness"
            harness.mkdir()
            environment.update(
                IS_SANDBOX="1",
                ARENA_TASK_ID="arena-package-input-smoke",
                ARENA_QUERY_PATH=str(query),
                ARENA_WORKSPACE=str(repo),
                ARENA_OUTPUT_DIR=str(output),
                ARENA_AGENT_OUTPUT_DIR=str(output / "agent"),
                ARENA_TRAJECTORY_PATH=str(output / "trajectory.jsonl"),
                # 平台会注入未物化的可选规则路径，包验收必须覆盖这一启动边界。
                ARENA_HARNESS_DIR=str(harness),
                ARENA_SYSTEM_PROMPT_PATH=str(harness / "system-prompt.md"),
                OPENAI_MODEL="fixture",
                OPENAI_BASE_URL=f"http://127.0.0.1:{server.server_port}/v1",
                OPENAI_API_KEY="fixture",
            )
            if args.check_model_overrides:
                environment.update(
                    AREAL_ARENA_TEMPERATURE="null",
                    AREAL_ARENA_REASONING_EFFORT="low",
                    AREAL_ARENA_MAX_OUTPUT_TOKENS="2048",
                )
            command = [sys.executable, str(args.package.resolve())]
        try:
            done = subprocess.run(
                command, env=environment, text=True, capture_output=True, timeout=90
            )
            assert done.returncode == 0, done.stderr + done.stdout + str(errors)
            assert not errors, errors
            expected_requests = len(replay_calls) + 1 if args.public_inputs_dir else 7
            assert len(requests) == expected_requests, requests
            if args.package:
                result = json.loads((output / "harness_result.json").read_text())
                delivery = json.loads((output / "agent/input-delivery.json").read_text())
                assert result["status"] == "OK", result
                assert delivery["integrity"] == "verified", delivery
                assert (output / "agent/public-inputs/TASK.md").read_bytes() == query.read_bytes()
                assert delivery["bootstrap_bytes"] < 4096, delivery
                assert delivery["rules"] is None, delivery
                assert not (output / "agent/public-inputs/RULES.md").exists()
                with zipfile.ZipFile(args.package) as archive:
                    manifest = json.loads(archive.read("manifest.json"))
                    settings = json.loads(archive.read("settings.json"))
                events = [
                    json.loads(line)
                    for line in (output / "trajectory.jsonl").read_text().splitlines()
                ]
                configuration = next(e for e in events if e.get("subtype") == "configuration")
                effective = configuration["parameters"]
                expected_wire = {
                    "max_completion_tokens" if key == "max_output_tokens" else key: value
                    for key, value in effective.items()
                    if value is not None
                }
                assert all(p == expected_wire for p in request_parameters), request_parameters
                if args.check_model_overrides:
                    assert effective == {
                        "temperature": None,
                        "reasoning_effort": "low",
                        "max_output_tokens": 2048,
                    }, effective
                if settings.get("task_profile") == "original":
                    prompt = json.loads((output / "agent/input.json").read_text())[0]["text"]
                    assert "This is an implementation task" not in prompt
                    assert "Use verify_command" not in prompt
                    assert "TASK.md" in prompt and "attachments.jsonl" in prompt
                print(
                    json.dumps(
                        {
                            "packagedRunner": "PASS",
                            "sourceRevision": manifest["sourceRevision"],
                            "bootstrapBytes": delivery["bootstrap_bytes"],
                            "modelRequests": len(requests),
                            "maxRequestBytes": max(requests),
                            "taskProfile": settings.get("task_profile", "generic"),
                            "visualViews": max(visual_counts),
                            "imageEvidence": image_evidence,
                            "publicInputIntegrity": "verified",
                            "effectiveModelParameters": effective,
                            "modelParametersMatchWire": True,
                            "missingOptionalRulesAccepted": True,
                        }
                    )
                )
                return
            public_inputs.verify(public, baseline)
            # 同一个真实入口拒绝旧式大封套，且不会发出额外模型请求。
            input_path.write_text(" " * (2 * 1024 * 1024 + 1))
            rejected = subprocess.run(
                command, env=environment, text=True, capture_output=True, timeout=60
            )
            assert rejected.returncode != 0
            error = json.loads((root / "input-error.json").read_text())
            assert error["code"] == "INPUT_ENVELOPE_TOO_LARGE"
            assert len(requests) == expected_requests
            print(
                json.dumps(
                    {
                        "bootstrapBytes": public_inputs.validate_envelope(inputs),
                        "modelRequests": len(requests),
                        "maxRequestBytes": max(requests),
                        "visualViews": max(visual_counts),
                        "imageEvidence": image_evidence,
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
