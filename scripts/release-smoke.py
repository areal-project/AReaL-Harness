#!/usr/bin/env python3
"""在解压或安装后的完整 bundle 上验证无源码启动、真实读写和内置搜索。"""

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import http.server
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path

from fixture_session_title import reply_to_session_title


def stop_fixture_host(executable, root, env, timeout=30):
    home = root / "home/.areal"
    assert env["AREAL_HARNESS_HOME"] == env["AREAL_HARNESS_SERVICE_HOME"] == str(home)
    descriptor = home / "host/host.json"
    if descriptor.exists():
        identity = json.loads(descriptor.read_text())
        request = str(uuid.uuid4())
        stopped = subprocess.run(
            [
                str(executable),
                "host",
                "stop",
                "--cancel",
                "--json",
                "--request-id",
                request,
                "--expected-generation",
                identity["generation"],
            ],
            cwd=root,
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
            check=True,
        )
        receipt = json.loads(stopped.stdout)
        assert (
            receipt["requestId"] == request
            and receipt["generation"] == identity["generation"]
            and receipt["hostId"] == identity["hostId"]
            and receipt["state"] == "completed"
        ), f"fixture Host stop is not settled; retained {root}"
    lock = home / "host.lock"
    if lock.exists():
        with lock.open("rb") as handle:
            deadline = time.monotonic() + timeout
            while True:
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError(
                            f"fixture Host still owns its lifecycle lock; retained {root}"
                        ) from None
                    time.sleep(0.05)
    assert not descriptor.exists(), f"fixture Host discovery still exists; retained {root}"


@contextmanager
def isolated_run(executable, timeout=30):
    root = Path(tempfile.mkdtemp(prefix="areal-release-smoke-")).resolve()
    env = {k: v for k, v in os.environ.items() if not k.startswith(("AREAL_", "OTEL_"))}
    env.update(
        HOME=str(root / "home"),
        AREAL_HARNESS_HOME=str(root / "home/.areal"),
        AREAL_HARNESS_SERVICE_HOME=str(root / "home/.areal"),
        NO_PROXY="127.0.0.1,localhost",
        no_proxy="127.0.0.1,localhost",
    )
    try:
        yield root, env
    finally:
        # owned 参数也连接持久 Host；必须先确认本探针的代际与锁结算，再删除状态。
        stop_fixture_host(executable, root, env, timeout)
        shutil.rmtree(root)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--executable", type=Path, help="verify the installer/Homebrew entry point")
    args = parser.parse_args()
    bundle = args.bundle.resolve()
    manifest = json.loads((bundle / "manifest.json").read_text())
    for name, digest in manifest["files"].items():
        assert hashlib.sha256((bundle / name).read_bytes()).hexdigest() == digest, name
    executable = (args.executable or bundle / "bin/areal").absolute()
    assert (
        subprocess.check_output([str(executable), "--version"], text=True).strip()
        == manifest["productVersion"]
    )
    calls = []
    errors = []

    class Model(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            try:
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if reply_to_session_title(self, request, "Release fixture"):
                    return
                results = [
                    json.loads(m["content"]) for m in request["messages"] if m["role"] == "tool"
                ]
                calls.append(len(results))
                if not results:
                    tool = {
                        "id": "write",
                        "type": "function",
                        "function": {
                            "name": "run_command",
                            "arguments": json.dumps(
                                {
                                    "argv": [
                                        "/usr/bin/python3",
                                        "-c",
                                        "from pathlib import Path; Path('release-check.txt').write_text('RELEASE_RW_OK\\n')",
                                    ],
                                    "cwd": ".",
                                    "timeoutMs": 10000,
                                }
                            ),
                        },
                    }
                elif len(results) == 1:
                    assert results[0]["exitCode"] == 0, results[0]
                    tool = {
                        "id": "read",
                        "type": "function",
                        "function": {
                            "name": "read_file",
                            "arguments": json.dumps({"path": "release-check.txt"}),
                        },
                    }
                elif len(results) == 2:
                    assert "RELEASE_RW_OK" in json.dumps(results[1]), results
                    tool = {
                        "id": "search",
                        "type": "function",
                        "function": {
                            "name": "search_files",
                            "arguments": json.dumps({"pattern": "RELEASE_RW_OK", "context": 0}),
                        },
                    }
                else:
                    assert len(results) == 3, results
                    assert results[2]["limited"] is False, results
                    assert len(results[2]["matches"]) == 1, results
                    assert results[2]["matches"][0]["text"] == "RELEASE_RW_OK\n", results
                    tool = None
                delta = (
                    {"tool_calls": [{"index": 0, **tool}]} if tool else {"content": "RELEASE_RW_OK"}
                )
                response = (
                    "data: "
                    + json.dumps(
                        {
                            "choices": [
                                {
                                    "index": 0,
                                    "delta": delta,
                                    "finish_reason": "tool_calls" if tool else "stop",
                                }
                            ],
                            "usage": {"prompt_tokens": 100, "completion_tokens": 10},
                        }
                    )
                    + "\n\ndata: [DONE]\n\n"
                )
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(response.encode())))
                self.end_headers()
                self.wfile.write(response.encode())
            except Exception as error:
                errors.append(repr(error))
                self.send_error(400)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Model)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with isolated_run(executable) as (root, env):
            workspace = root / "workspace"
            workspace.mkdir()
            config = root / "config.toml"
            config.write_text(f"""schema_version=1
[model]
name="release-fixture"
max_retries=0
[model.providers.default]
protocol="chat-completions"
endpoint="http://127.0.0.1:{server.server_port}/v1/chat/completions"
[limits]
watchdog_disable=true
""")
            result = subprocess.run(
                [
                    str(executable),
                    "--config",
                    str(config),
                    "--workspace",
                    str(workspace),
                    "--data-dir",
                    str(root / "state"),
                    "--local-mode",
                    "owned",
                    "--prompt",
                    "Write and read release-check.txt using tools.",
                ],
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
                timeout=120,
            )
            assert not errors, errors
            assert result.returncode == 0, result.stderr[-4000:]
            assert "RELEASE_RW_OK" in result.stdout, result.stdout
            assert (workspace / "release-check.txt").read_text() == "RELEASE_RW_OK\n"
            assert calls == [0, 1, 2, 3], calls
        print(
            json.dumps(
                {
                    "releaseSmoke": "passed",
                    "platform": manifest["platform"],
                    "profile": manifest["profile"],
                    "model": "local-fixture",
                    "toolCalls": 3,
                    "hostCleanupConfirmed": True,
                    "sourceRevision": manifest["sourceRevision"],
                }
            )
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == "__main__":
    main()
