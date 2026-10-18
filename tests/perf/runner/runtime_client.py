#!/usr/bin/env python3
"""供 Docker 沙箱冒烟测试使用的同步 Runtime 客户端。"""

from __future__ import annotations

import base64
import json
import os
import queue
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any

RUNTIME_PROTOCOL = "areal.runtime.v0"
RUNTIME_PROFILE = "outerContainerPerfV1"
MAX_TOOL_RESULT_BYTES = 64 * 1024
RPC_TIMEOUT_SECONDS = 20


class RuntimeRpcError(RuntimeError):
    pass


class RuntimeClient:
    def __init__(
        self, workspace: Path, *, allow_network: bool = False, concurrent_writes: bool = False
    ) -> None:
        binary = os.environ.get("AREAL_RUNTIME_BINARY", "/usr/local/libexec/areal/areal-runtime")
        self.process = subprocess.Popen(
            [
                binary,
                "--workspace",
                str(workspace),
                "--allow-write",
                *(["--allow-network"] if allow_network else []),
                *(["--allow-concurrent-writes"] if concurrent_writes else []),
                "--sandbox-profile",
                "outer-container-perf",
                "--wall-time-ms",
                "120000",
                "--output-bytes",
                str(16 * 1024 * 1024),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self.responses: queue.Queue[dict[str, Any] | None] = queue.Queue()
        self.errors: list[str] = []
        self.next_id = 0
        threading.Thread(target=self._read_responses, daemon=True).start()
        threading.Thread(target=self._read_errors, daemon=True).start()
        try:
            self.info = self.call(
                "connection.open",
                {"protocolVersion": RUNTIME_PROTOCOL},
                timeout=RPC_TIMEOUT_SECONDS,
            )
            profile = self.info.get("capabilities", {}).get("sandbox")
            if profile != RUNTIME_PROFILE:
                raise RuntimeRpcError(f"unexpected Runtime sandbox profile: {profile}")
        except Exception:
            self._terminate()
            raise

    def _read_responses(self) -> None:
        assert self.process.stdout is not None
        try:
            for line in self.process.stdout:
                self.responses.put(json.loads(line))
        except Exception as error:
            self.errors.append(str(error))
        finally:
            self.responses.put(None)

    def _read_errors(self) -> None:
        assert self.process.stderr is not None
        for line in self.process.stderr:
            self.errors.append(line.rstrip())

    def call(
        self, method: str, params: dict[str, Any], *, timeout: int = RPC_TIMEOUT_SECONDS
    ) -> Any:
        self.next_id += 1
        request_id = self.next_id
        assert self.process.stdin is not None
        try:
            self.process.stdin.write(
                json.dumps({"id": request_id, "method": method, "params": params}) + "\n"
            )
            self.process.stdin.flush()
        except BrokenPipeError as error:
            raise RuntimeRpcError(self._closed_message()) from error
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeRpcError(f"Runtime RPC timed out: {method}")
            try:
                response = self.responses.get(timeout=remaining)
            except queue.Empty as error:
                raise RuntimeRpcError(f"Runtime RPC timed out: {method}") from error
            if response is None:
                raise RuntimeRpcError(self._closed_message())
            if response.get("id") != request_id:
                raise RuntimeRpcError("Runtime returned an unexpected response id")
            if "error" in response:
                value = response["error"]
                raise RuntimeRpcError(
                    f"{value.get('code', 'ERROR')}: {value.get('message', 'Runtime rejected request')}"
                )
            return response.get("result")

    def _closed_message(self) -> str:
        detail = "; ".join(self.errors[-4:])
        return "Runtime closed unexpectedly" + (f": {detail}" if detail else "")

    def operation_id(self) -> str:
        return f"{self.info['runtimeEpoch']}:op:{uuid.uuid4()}"

    def execute(self, command: str) -> tuple[int, str, bool]:
        process = self.call(
            "process.start",
            {
                "operationId": self.operation_id(),
                "scopeId": self.info["rootScopeId"],
                "argv": ["/bin/sh", "-c", command],
                "cwd": "workspace://repo",
                "env": {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "CI": "1"},
            },
        )
        process_id = process["processId"]
        cursor = None
        output = bytearray()
        gap = False
        while True:
            page = self.call(
                "output.read",
                {
                    "processId": process_id,
                    "after": cursor,
                    "maxBytes": 65536,
                    "waitMs": 1000,
                },
            )
            gap = gap or bool(page.get("gap"))
            for chunk in page.get("chunks", []):
                output.extend(base64.b64decode(chunk["dataBase64"]))
            cursor = page["nextCursor"]
            if page.get("closed"):
                break
        result = self.call("process.wait", {"processId": process_id})
        truncated = bool(page.get("truncated")) or gap or len(output) > MAX_TOOL_RESULT_BYTES
        if len(output) > MAX_TOOL_RESULT_BYTES:
            output = output[-MAX_TOOL_RESULT_BYTES:]
        text = output.decode("utf-8", errors="replace")
        if gap:
            text = "[earlier Runtime output was evicted]\n" + text
        return (
            int(result.get("exitCode") if result.get("exitCode") is not None else -1),
            text,
            truncated,
        )

    def _terminate(self) -> None:
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait()

    def close(self) -> None:
        close_error: RuntimeRpcError | None = None
        if self.process.poll() is None:
            try:
                self.call("connection.close", {}, timeout=30)
            except RuntimeRpcError as error:
                close_error = error
        if self.process.stdin is not None and not self.process.stdin.closed:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self._terminate()
            if close_error is None:
                close_error = RuntimeRpcError("Runtime did not exit after connection.close")
        if self.process.returncode != 0 and close_error is None:
            close_error = RuntimeRpcError(self._closed_message())
        if close_error is not None:
            raise close_error
