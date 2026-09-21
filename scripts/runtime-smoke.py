#!/usr/bin/env python3
"""通过真实 Runtime 原生执行后端验证进程、权限和关闭语义。"""

import argparse
import base64
import http.server
import json
import os
from pathlib import Path
import queue
import select
import shlex
import subprocess
import tempfile
import threading
import time
import uuid
import urllib.request


class RpcError(Exception):
    def __init__(self, value):
        self.value = value
        super().__init__(json.dumps(value, ensure_ascii=False))


class Runtime:
    def __init__(self, binary, workspace):
        self.process = subprocess.Popen(
            [str(binary), "--workspace", str(workspace), "--allow-write"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self.messages = queue.Queue()
        self.errors = []
        self.pending = {}
        self.next_id = 0
        self.read_gate = threading.Event()
        self.read_gate.set()
        self.read_thread = threading.Thread(target=self._read, daemon=True)
        self.error_thread = threading.Thread(target=self._errors, daemon=True)
        self.read_thread.start()
        self.error_thread.start()

    def _read(self):
        try:
            for line in self.process.stdout:
                self.read_gate.wait()
                self.messages.put(json.loads(line))
        except Exception as error:
            self.errors.append(str(error))
        finally:
            self.messages.put(None)

    def _errors(self):
        for line in self.process.stderr:
            self.errors.append(line.rstrip())

    def send(self, method, params):
        self.next_id += 1
        request = {"id": self.next_id, "method": method, "params": params}
        self.process.stdin.write(json.dumps(request) + "\n")
        self.process.stdin.flush()
        return self.next_id

    def receive(self, request_id, timeout=15):
        deadline = time.monotonic() + timeout
        while request_id not in self.pending:
            try:
                message = self.messages.get(timeout=max(0.01, deadline - time.monotonic()))
            except queue.Empty as error:
                raise AssertionError(f"Runtime response timeout: {self.errors}") from error
            if message is None:
                raise AssertionError(f"Runtime closed unexpectedly: {self.errors}")
            self.pending[message["id"]] = message
        message = self.pending.pop(request_id)
        if "error" in message:
            raise RpcError(message["error"])
        return message["result"]

    def call(self, method, params):
        return self.receive(self.send(method, params))

    def expect_error(self, code, method, params):
        try:
            self.call(method, params)
        except RpcError as error:
            assert error.value["code"] == code, error
            return
        raise AssertionError(f"expected {code} for {method}")

    def op(self):
        return f"{self.info['runtimeEpoch']}:op:{uuid.uuid4()}"

    def scope(self, readonly=False):
        params = {
            "operationId": self.op(),
            "parentScopeId": self.info["rootScopeId"],
            "owner": {"taskId": "runtime-smoke"},
        }
        if readonly:
            params["permissions"] = {"writeRoots": []}
        return self.call("scope.create", params)["scopeId"]

    def start(self, scope, command, limits=None):
        request = {
            "operationId": self.op(),
            "scopeId": scope,
            "argv": ["/bin/sh", "-c", command],
            "cwd": "workspace://repo",
        }
        if limits:
            request["limits"] = limits
        return self.call("process.start", request)["processId"]

    def output(self, process_id, max_bytes=65536, after=None):
        return self.call(
            "output.read", {"processId": process_id, "after": after, "maxBytes": max_bytes}
        )

    def close(self):
        self.read_gate.set()
        try:
            if self.process.poll() is None:
                self.process.stdin.close()
                self.process.wait(timeout=12)
        finally:
            if self.process.poll() is None:
                self.process.kill()
                self.process.wait()
            if not self.process.stdin.closed:
                try:
                    self.process.stdin.close()
                except BrokenPipeError:
                    pass
            self.read_thread.join(timeout=1)
            self.error_thread.join(timeout=1)
            self.process.stdout.close()
            self.process.stderr.close()


def text(page):
    return b"".join(base64.b64decode(c["dataBase64"]) for c in page["chunks"])


def run(binary, root):
    workspace = root / "workspace"
    workspace.mkdir()
    (workspace / "allowed.txt").write_text("allowed fixture\n")
    outside = root / "forbidden.txt"
    outside.write_text("outside-secret-fixture\n")
    runtime = Runtime(binary, workspace)
    leader = None
    try:
        runtime.expect_error("UNAUTHENTICATED", "scope.get", {"scopeId": "uninitialized"})
        runtime.expect_error("UNSUPPORTED", "connection.open", {"protocolVersion": "unknown"})
        runtime.info = runtime.call("connection.open", {"protocolVersion": "areal.runtime.v0"})
        assert runtime.info["capabilities"]["processTreeCleanupVerified"] is False
        assert runtime.info["capabilities"]["sandbox"] == "runtimeSeatbeltPathV1"
        assert runtime.info["capabilities"]["directoryObjectIsolation"] is False
        assert runtime.info["capabilities"]["sandboxDenialAttribution"] is False
        runtime.expect_error("UNSUPPORTED", "fs.read", {})
        writable = runtime.scope()
        readonly = runtime.scope(readonly=True)
        runtime.expect_error(
            "PERMISSION_DENIED",
            "scope.create",
            {
                "operationId": runtime.op(),
                "parentScopeId": readonly,
                "owner": {"taskId": "cannot-escalate"},
                "permissions": {"writeRoots": ["workspace://repo"]},
            },
        )
        runtime.expect_error(
            "INVALID_ARGUMENT",
            "process.start",
            {
                "operationId": runtime.op(),
                "scopeId": writable,
                "argv": ["/usr/bin/true"],
                "cwd": "workspace://repo",
                "approved": True,
            },
        )
        runtime.expect_error(
            "STALE_HANDLE", "operation.get", {"operationId": f"old:op:{uuid.uuid4()}"}
        )

        request = {
            "operationId": runtime.op(),
            "scopeId": writable,
            "argv": ["/bin/sh", "-c", "printf once >> count.txt; printf 'abcdef'; sleep 0.2"],
            "cwd": "workspace://repo",
        }
        first, retry = (
            runtime.send("process.start", request),
            runtime.send("process.start", request),
        )
        result = runtime.receive(first)
        assert runtime.receive(retry) == result
        runtime.expect_error("CONFLICT", "process.start", {**request, "argv": ["/usr/bin/true"]})
        process_id = result["processId"]
        assert runtime.call("process.wait", {"processId": process_id})["exitCode"] == 0
        assert (workspace / "count.txt").read_text() == "once"
        part = runtime.output(process_id, max_bytes=2)
        assert text(part) == b"ab" and not part["closed"]
        rest = runtime.output(process_id, after=part["nextCursor"])
        assert text(rest) == b"cdef" and rest["closed"] and not rest["gap"]
        assert (
            runtime.call("operation.get", {"operationId": request["operationId"]})["state"]
            == "succeeded"
        )

        process_id = runtime.start(readonly, "cat allowed.txt; printf denied > blocked.txt")
        denied = runtime.call("process.wait", {"processId": process_id})
        assert denied["exitCode"] != 0, denied
        assert not (workspace / "blocked.txt").exists()
        assert b"allowed fixture" in text(runtime.output(process_id))
        process_id = runtime.start(readonly, f"cat {shlex.quote(str(outside))}")
        denied = runtime.call("process.wait", {"processId": process_id})
        assert denied["exitCode"] != 0, denied
        assert b"outside-secret-fixture" not in text(runtime.output(process_id))

        for name in ("scope-root", "scope-cwd"):
            (workspace / name).mkdir()
        outside_dir = root / "outside-dir"
        outside_dir.mkdir()
        (outside_dir / "fixture.txt").write_text("outside-directory-fixture")
        narrowed = runtime.call(
            "scope.create",
            {
                "operationId": runtime.op(),
                "parentScopeId": readonly,
                "owner": {"taskId": "directory-identity"},
                "permissions": {
                    "readRoots": ["workspace://repo/scope-root", "workspace://repo/scope-cwd"]
                },
            },
        )["scopeId"]
        (workspace / "scope-root").rename(workspace / "original-scope-root")
        (workspace / "scope-root").symlink_to(outside_dir, target_is_directory=True)
        runtime.expect_error(
            "PERMISSION_DENIED",
            "process.start",
            {
                "operationId": runtime.op(),
                "scopeId": narrowed,
                "argv": ["/bin/cat", str(outside_dir / "fixture.txt")],
                "cwd": "workspace://repo/scope-cwd",
            },
        )
        runtime.expect_error(
            "PERMISSION_DENIED",
            "scope.create",
            {
                "operationId": runtime.op(),
                "parentScopeId": narrowed,
                "owner": {"taskId": "stale-inheritance"},
            },
        )

        # 窄 Scope 已运行后，由不参与 Runtime 写锁的外部 fixture 替换授权根。
        # 受管写进程现已串行；此处仍验证外部并发重定向无法绕过 OS 权限。
        for name in ("race-root", "race-cwd"):
            (workspace / name).mkdir()
        (workspace / "race-root" / "fixture.txt").write_text("allowed-race-fixture")
        racing_scope = runtime.call(
            "scope.create",
            {
                "operationId": runtime.op(),
                "parentScopeId": writable,
                "owner": {"taskId": "concurrent-replacement"},
                "permissions": {
                    "readRoots": ["workspace://repo/race-root", "workspace://repo/race-cwd"],
                    "writeRoots": ["workspace://repo/race-root"],
                },
            },
        )["scopeId"]
        victim = runtime.call(
            "process.start",
            {
                "operationId": runtime.op(),
                "scopeId": racing_scope,
                "argv": [
                    "/bin/sh",
                    "-c",
                    "printf ready; while [ ! -f go ]; do /bin/sleep 0.01; done; "
                    'cat "$1/fixture.txt"; printf escaped > "$1/forbidden.txt"',
                    "fixture",
                    str(workspace / "race-root"),
                ],
                "cwd": "workspace://repo/race-cwd",
            },
        )["processId"]
        ready = runtime.call("output.read", {"processId": victim, "maxBytes": 100, "waitMs": 1000})
        assert text(ready) == b"ready", ready
        (workspace / "race-root").rename(workspace / "race-original")
        (workspace / "race-root").symlink_to(outside_dir, target_is_directory=True)
        (workspace / "race-cwd" / "go").write_text("go")
        assert runtime.call("process.wait", {"processId": victim})["exitCode"] != 0
        assert b"outside-directory-fixture" not in text(runtime.output(victim))
        assert not (outside_dir / "forbidden.txt").exists()

        hits = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                hits.append(self.path)
                self.send_response(200)
                self.send_header("Content-Length", "7")
                self.end_headers()
                self.wfile.write(b"fixture")

            def log_message(self, *_args):
                pass

        network_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server_thread = threading.Thread(target=network_server.serve_forever, daemon=True)
        server_thread.start()
        endpoint = f"http://127.0.0.1:{network_server.server_port}/"
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(endpoint, timeout=3) as response:
                assert response.read() == b"fixture"
            hits.clear()
            process_id = runtime.start(
                readonly, f"/usr/bin/curl -q --silent --max-time 2 {shlex.quote(endpoint)}"
            )
            denied = runtime.call("process.wait", {"processId": process_id})
            assert denied["exitCode"] != 0 and not hits, "sandbox allowed loopback networking"
        finally:
            network_server.shutdown()
            network_server.server_close()
            server_thread.join(timeout=2)

        process_id = runtime.start(writable, "/usr/bin/head -c 100000 /dev/zero")
        assert runtime.call("process.wait", {"processId": process_id})["exitCode"] == 0
        page = runtime.output(process_id)
        assert page["gap"] and page["closed"] and len(text(page)) == 65536, page

        process_id = runtime.start(
            writable, "/usr/bin/head -c 9000 /dev/zero", {"outputBytes": 4096}
        )
        stopped = runtime.call("process.wait", {"processId": process_id})
        assert stopped["stopReason"] == "outputBytes exceeded", stopped
        page = runtime.output(process_id)
        assert page["truncated"] and len(text(page)) == 4096

        cancelled_scope = runtime.scope()
        process_id = runtime.start(cancelled_scope, "printf '%s\\n' \"$$\"; exec /bin/sleep 30")
        page = runtime.call(
            "output.read", {"processId": process_id, "maxBytes": 100, "waitMs": 1000}
        )
        leader = int(text(page).strip())
        # 填满长等待许可，撤销仍走固定控制路径。
        waiting = [runtime.send("process.wait", {"processId": process_id}) for _ in range(32)]
        revoked = runtime.call("scope.revoke", {"scopeId": cancelled_scope})
        assert revoked["state"] in ("revoking", "closed")
        for request_id in waiting:
            assert runtime.receive(request_id)["state"] == "exited"
        closed = runtime.call("scope.waitClosed", {"scopeId": cancelled_scope})
        assert closed["state"] == "closed" and closed["activeProcesses"] == 0
        try:
            os.kill(leader, 0)
        except ProcessLookupError:
            leader = None
        assert leader is None, "managed leader survived scope closure"

        # EOF 代表拥有该私有连接的 Core 退出；不能等到墙钟期限才回收进程。
        attached_scope = runtime.scope()
        process_id = runtime.start(attached_scope, "printf '%s\\n' \"$$\"; exec /bin/sleep 30")
        page = runtime.call(
            "output.read", {"processId": process_id, "maxBytes": 100, "waitMs": 1000}
        )
        leader = int(text(page).strip())
        start = time.monotonic()
        runtime.close()
        assert runtime.process.returncode == 0, runtime.errors
        assert time.monotonic() - start < 12
        try:
            os.kill(leader, 0)
        except ProcessLookupError:
            leader = None
        assert leader is None, "managed leader survived input EOF"

        runtime = Runtime(binary, workspace)
        runtime.info = runtime.call("connection.open", {"protocolVersion": "areal.runtime.v0"})
        process_id = runtime.start(runtime.scope(), "printf '%s\\n' \"$$\"; exec /bin/sleep 30")
        page = runtime.call(
            "output.read", {"processId": process_id, "maxBytes": 100, "waitMs": 1000}
        )
        leader = int(text(page).strip())
        runtime.process.terminate()
        runtime.process.wait(timeout=12)
        assert runtime.process.returncode == 0, runtime.errors
        try:
            os.kill(leader, 0)
        except ProcessLookupError:
            leader = None
        assert leader is None, "managed leader survived Runtime SIGTERM"
        runtime.close()

        # stdout 的内核管道被填满后，关闭不能依赖对端恢复读取。
        runtime = Runtime(binary, workspace)
        runtime.info = runtime.call("connection.open", {"protocolVersion": "areal.runtime.v0"})
        process_id = runtime.start(runtime.scope(), "printf '%s\\n' \"$$\"; exec /bin/sleep 30")
        page = runtime.call(
            "output.read", {"processId": process_id, "maxBytes": 100, "waitMs": 1000}
        )
        leader = int(text(page).strip())
        runtime.read_gate.clear()
        data = b"".join(
            (
                json.dumps(
                    {
                        "id": str(index) + "x" * 100,
                        "method": "scope.get",
                        "params": {"scopeId": runtime.info["rootScopeId"]},
                    }
                )
                + "\n"
            ).encode()
            for index in range(1024)
        )
        descriptor = runtime.process.stdin.fileno()
        os.set_blocking(descriptor, False)
        deadline = time.monotonic() + 5
        sent = 0
        while sent < len(data) and time.monotonic() < deadline:
            try:
                sent += os.write(descriptor, data[sent:])
            except BlockingIOError:
                select.select([], [descriptor], [], 0.05)
            except BrokenPipeError:
                break
        runtime.process.wait(timeout=12)
        try:
            os.kill(leader, 0)
        except ProcessLookupError:
            leader = None
        assert leader is None, "managed leader survived a full response pipe"
    finally:
        runtime.close()
        if leader is not None:
            # 仅清理由 fixture 自己输出并记录的进程。
            try:
                os.kill(leader, 9)
            except ProcessLookupError:
                pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, default=Path("target/debug/areal-runtime"))
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="areal-runtime-smoke-") as directory:
        run(args.runtime.resolve(), Path(directory).resolve())
    print(
        "Runtime smoke passed: filesystem/network denial, concurrent root replacement, deduplication, cursors, budgets, cancellation, EOF, SIGTERM and full-pipe cleanup"
    )


if __name__ == "__main__":
    main()
