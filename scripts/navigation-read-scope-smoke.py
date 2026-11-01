#!/usr/bin/env python3
"""真实 Runtime 的只读导航与后台写进程回归；模型为本机确定性夹具。"""

import argparse
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time

from fixture_session_title import reply_to_session_title


def exercise(binary, profile, base):
    repo, scratch, data = [base / name for name in ["repo", "scratch", "data"]]
    repo.mkdir()
    scratch.mkdir()
    (repo / "notes.txt").write_text("首行\ntarget=8\nend\n")
    (base / "outside.txt").write_text("outside-preserved")
    errors, requests, latencies = [], [], []
    state = {}

    class Model(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            try:
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if reply_to_session_title(self, request, "Read-only navigation fixture"):
                    return
                requests.append(request)
                results = [
                    json.loads(m["content"]) for m in request["messages"] if m["role"] == "tool"
                ]
                n = len(results)
                name, arguments, calls = None, None, []
                if n == 0:
                    name = "run_command"
                    arguments = {
                        "argv": [
                            "/usr/bin/python3",
                            "-I",
                            "-B",
                            "-c",
                            "from pathlib import Path; import time; Path('writer.ready').write_text('ready'); time.sleep(60)",
                        ],
                        "yieldMs": 0,
                        "timeoutMs": 90000,
                    }
                elif n == 1:
                    state["process"] = results[-1]["processId"]
                    deadline = time.monotonic() + 5
                    while not (repo / "writer.ready").exists():
                        assert time.monotonic() < deadline, (
                            "background writer did not acquire ownership"
                        )
                        time.sleep(0.01)
                    # 同一模型响应并发发出读与搜索，验证 scope 创建只发生一次。
                    calls = [
                        ("read_file", {"path": "notes.txt", "offset": 2, "limit": 1}),
                        (
                            "search_files",
                            {"path": "notes.txt", "pattern": "^target=", "context": 0},
                        ),
                    ]
                    state["navigation_started"] = time.monotonic()
                elif n == 3:
                    latencies.append(time.monotonic() - state["navigation_started"])
                    assert latencies[-1] < 5, f"read queued behind writer for {latencies[-1]:.3f}s"
                    reading = next(item for item in results[-2:] if "lines" in item)
                    searching = next(item for item in results[-2:] if "matches" in item)
                    assert reading["lines"][0]["text"] == "target=8\n", reading
                    assert searching["matches"], searching
                    state["version"] = reading["fileVersion"]
                    state["sha256"] = reading["sha256"]
                    name, arguments = "read_file", {"path": "notes.txt", "offset": 2, "limit": 1}
                elif n == 4:
                    # fileVersion 是每次观察生成的不透明句柄，不是内容哈希。
                    assert results[-1]["sha256"] == state["sha256"]
                    assert results[-1]["fileVersion"]
                    name, arguments = "terminate_process", {"processId": state["process"]}
                elif n == 5:
                    assert results[-1].get("state") == "exited", results[-1]
                    name, arguments = (
                        "fs_apply_patches",
                        {
                            "path": "notes.txt",
                            "patches": [{"oldText": "target=8", "newText": "target=9"}],
                        },
                    )
                elif n == 6:
                    assert results[-1].get("fileVersion") != state["version"], results[-1]
                    assert (repo / "notes.txt").read_text() == "首行\ntarget=9\nend\n"
                    # 外部改动必须使上一次观察失效，不能因更换读取 scope 关闭 CAS。
                    (repo / "notes.txt").write_text("首行\ntarget=10\nend\n")
                    name, arguments = (
                        "fs_apply_patches",
                        {
                            "path": "notes.txt",
                            "patches": [{"oldText": "target=10", "newText": "target=11"}],
                        },
                    )
                elif n == 7:
                    assert results[-1].get("error", {}).get("code") == "CONFLICT", results[-1]
                    assert (repo / "notes.txt").read_text() == "首行\ntarget=10\nend\n"
                    name, arguments = "read_file", {"path": "notes.txt"}
                elif n == 8:
                    assert any("target=10" in line["text"] for line in results[-1]["lines"])
                    name, arguments = (
                        "fs_apply_patches",
                        {
                            "path": "notes.txt",
                            "patches": [{"oldText": "target=10", "newText": "target=11"}],
                        },
                    )
                elif n == 9:
                    assert (repo / "notes.txt").read_text() == "首行\ntarget=11\nend\n"
                    name, arguments = "read_file", {"path": "../outside.txt"}
                elif n == 10:
                    assert results[-1].get("error"), results[-1]
                    assert (base / "outside.txt").read_text() == "outside-preserved"
                else:
                    raise AssertionError("unexpected extra model request")
                delta, finish = (
                    {"content": "Native navigation, ownership and version checks passed."},
                    "stop",
                )
                if name:
                    calls.append((name, arguments))
                if calls:
                    delta = {
                        "tool_calls": [
                            {
                                "index": index,
                                "id": f"nav-{n}-{index}",
                                "type": "function",
                                "function": {"name": name, "arguments": json.dumps(arguments)},
                            }
                            for index, (name, arguments) in enumerate(calls)
                        ]
                    }
                    finish = "tool_calls"
                body = (
                    "data: "
                    + json.dumps(
                        {
                            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
                            "usage": {"prompt_tokens": 100, "completion_tokens": 20},
                        }
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
    (base / "tools.json").write_text(json.dumps({"policy": {"parallelReadCalls": 2}}))
    config.write_text(f"""schema_version=1
[model]
name="fixture"
max_retries=0
[model.providers.default]
protocol="chat-completions"
endpoint="http://127.0.0.1:{server.server_port}/v1/chat/completions"
api_key_env="AREAL_API_KEY"
[limits]
context_window_tokens=0
max_tool_calls=16
[tools]
extensions_file="tools.json"
""")
    env = {
        k: v
        for k, v in os.environ.items()
        if not k.startswith(("AREAL_", "OPENAI_", "ANTHROPIC_", "CODEX_"))
        and k.lower() not in ["http_proxy", "https_proxy", "all_proxy"]
    }
    for key in ["NO_PROXY", "no_proxy"]:
        entries = list(filter(None, env.get(key, "").split(",")))
        env[key] = ",".join(dict.fromkeys(entries + ["127.0.0.1", "localhost", "::1"]))
    env.update(AREAL_API_KEY="fixture-only", AREAL_HARNESS_HOME=str(base / "private"))
    try:
        argv = [
            sys.executable,
            str(Path(__file__).with_name("launch.py")),
            "--bin-dir",
            str(binary),
            "--tui",
            "--sandbox-profile",
            profile,
            "--config",
            str(config),
            "--workspace",
            str(repo),
            "--scratch",
            str(scratch),
            "--data-dir",
            str(data),
            "--allow-write",
            "--prompt",
            "Exercise read-only navigation.",
        ]
        done = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=110)
        (base / "stdout.log").write_text(done.stdout)
        (base / "stderr.log").write_text(done.stderr)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    (base / "fixture-requests.json").write_text(
        json.dumps(requests, ensure_ascii=False, indent=2) + "\n"
    )
    items = {}

    def visit(value):
        if isinstance(value, dict):
            if value.get("type") == "dynamicToolCall":
                items[value["callId"]] = value
            for item in value.values():
                visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)

    for path in data.glob("*.json"):
        visit(json.loads(path.read_text()))
    navigations = [item for item in items.values() if item["tool"] in ["read_file", "search_files"]]
    scopes = [
        entry
        for item in navigations
        for entry in item["execution"].get("permissionScopes", [])
        if entry["kind"] == "navigationReadOnly"
    ]
    created = [entry for entry in scopes if not entry.get("reused")]
    successful_navigation = [item for item in navigations if item.get("success") is True]
    checks = {
        "no_fixture_error": not errors,
        "normal_exit": done.returncode == 0,
        "all_steps_observed": len(requests) == 10,
        "navigation_calls_observed": len(navigations) == 5 and len(successful_navigation) == 4,
        "one_reused_navigation_scope": len(created) == 1 and 4 <= len(scopes) <= 5,
        "successful_navigation_is_readonly": all(
            any(
                entry["kind"] == "navigationReadOnly"
                for entry in item["execution"].get("permissionScopes", [])
            )
            for item in successful_navigation
        ),
        "readonly_network_denied": bool(created)
        and created[0]["permissions"]["writeRoots"] == []
        and created[0]["permissions"]["network"] == "deny",
        "same_scope_recorded": len({entry["scopeId"] for entry in scopes}) == 1,
        "model_resource": "DETERMINISTIC_LOCAL_HTTP_FIXTURE_NO_REAL_MODEL",
    }
    passed = all(value for key, value in checks.items() if key != "model_resource")
    report = {
        "pass": passed,
        "checks": checks,
        "errors": errors,
        "navigation_seconds": latencies,
        "sandbox_profile": profile,
        "requests": len(requests),
        "exit_code": done.returncode,
    }
    (base / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False))
    return passed


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("--bin-dir", type=Path, required=True)
    parser.add_argument("--sandbox-profile", choices=["native", "full-access"], default="native")
    parser.add_argument("--evidence-dir", type=Path)
    args = parser.parse_args()
    if args.evidence_dir:
        args.evidence_dir.mkdir(parents=True, exist_ok=False)
        passed = exercise(args.bin_dir.resolve(), args.sandbox_profile, args.evidence_dir.resolve())
    else:
        with tempfile.TemporaryDirectory(prefix="areal-navigation-scope-") as temp:
            passed = exercise(args.bin_dir.resolve(), args.sandbox_profile, Path(temp))
    raise SystemExit(0 if passed else 1)


if __name__ == "__main__":
    main()
