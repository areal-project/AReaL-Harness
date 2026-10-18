#!/usr/bin/env python3
"""Verify the Docker-only Runtime profile enforces its declared boundaries."""

import base64
import hashlib
import shlex
import socket
from pathlib import Path

from runtime_client import RuntimeClient


def main() -> int:
    workspace = Path("/workspace")
    runtime = RuntimeClient(workspace)
    try:
        assert runtime.info["capabilities"]["rootNetwork"] == "deny"
        # This file was created by the host user and bound into the container.
        # A tmpfs populated as root would miss the UID-mapping regression.
        original = (workspace / "existing").read_bytes()
        runtime.call(
            "fs.execute",
            {
                "operationId": runtime.operation_id(),
                "scopeId": runtime.info["rootScopeId"],
                "command": {
                    "kind": "applyPatch",
                    "path": "workspace://repo/existing",
                    "oldText": "original",
                    "newText": "patched",
                    "expectedSha256": hashlib.sha256(original).hexdigest(),
                },
            },
        )
        assert (workspace / "existing").read_text() == "patched\n"
        data = bytes(range(256)) * 256
        write = {
            "operationId": runtime.operation_id(),
            "scopeId": runtime.info["rootScopeId"],
            "command": {
                "kind": "write",
                "path": "workspace://repo/boundary.bin",
                "dataBase64": base64.b64encode(data).decode(),
                "expected": {"kind": "absent"},
            },
        }
        written = runtime.call("fs.execute", write)
        assert written["size"] == 65536 and written["sha256"] == hashlib.sha256(data).hexdigest()
        assert runtime.call("fs.execute", write) == written
        read = runtime.call(
            "fs.execute",
            {
                "operationId": runtime.operation_id(),
                "scopeId": runtime.info["rootScopeId"],
                "command": {
                    "kind": "read",
                    "path": "workspace://repo/boundary.bin",
                    "maxBytes": 65536,
                },
            },
        )
        assert base64.b64decode(read["dataBase64"]) == data and read["eof"]
        escaped = '"' * 60000
        runtime.call(
            "fs.execute",
            {
                "operationId": runtime.operation_id(),
                "scopeId": runtime.info["rootScopeId"],
                "command": {
                    "kind": "applyPatch",
                    "path": "workspace://repo/existing",
                    "oldText": "patched\n",
                    "newText": escaped,
                    "expectedSha256": hashlib.sha256(b"patched\n").hexdigest(),
                },
            },
        )
        assert (workspace / "existing").read_text() == escaped
        # Preserve the host-staged result checked by smoke_runtime_profile.
        runtime.call(
            "fs.execute",
            {
                "operationId": runtime.operation_id(),
                "scopeId": runtime.info["rootScopeId"],
                "command": {
                    "kind": "write",
                    "path": "workspace://repo/existing",
                    "dataBase64": base64.b64encode(b"patched\n").decode(),
                    "expected": {
                        "kind": "sha256",
                        "value": hashlib.sha256(escaped.encode()).hexdigest(),
                    },
                },
            },
        )
        process = runtime.call(
            "process.start",
            {
                "operationId": runtime.operation_id(),
                "scopeId": runtime.info["rootScopeId"],
                "argv": ["/bin/sh", "-c", "head -c 65536 | wc -c"],
                "cwd": "workspace://repo",
                "pipeStdin": True,
            },
        )
        pid = process["processId"]
        stdin = {
            "operationId": runtime.operation_id(),
            "processId": pid,
            "dataBase64": base64.b64encode(data).decode(),
        }
        assert runtime.call("process.write", stdin) == {"accepted": True}
        assert runtime.call("process.write", stdin) == {"accepted": True}
        assert runtime.call("process.wait", {"processId": pid})["exitCode"] == 0
        page = runtime.call("output.read", {"processId": pid, "maxBytes": 65536})
        assert (
            int(b"".join(base64.b64decode(chunk["dataBase64"]) for chunk in page["chunks"]))
            == 65536
        )
        allowed_code, allowed_output, _ = runtime.execute(
            "printf 'allowed\\n' > /workspace/allowed"
        )
        patch_code, patch_output, _ = runtime.execute(
            "python3 -c "
            + shlex.quote(
                "from pathlib import Path; p=Path('/workspace/allowed'); p.write_text(p.read_text().replace('allowed', 'patched'))"
            )
        )
        outside_code, outside_output, _ = runtime.execute("printf denied > /output/denied")
        network_code, network_output, _ = runtime.execute(
            'python3 -c "import socket; socket.socket(socket.AF_INET, socket.SOCK_STREAM)"'
        )
        compiler_code, compiler_output, _ = runtime.execute(
            "set -e; "
            "if command -v cc >/dev/null; then "
            "printf '#include <stdio.h>\\nint main(void) { puts(\"compiled\"); return 0; }\\n' > /workspace/smoke.c; "
            "cc /workspace/smoke.c -o /workspace/smoke-c; /workspace/smoke-c; fi; "
            "if command -v cobc >/dev/null; then "
            "printf 'identification division.\\nprogram-id. smoke.\\nprocedure division.\\ndisplay \"compiled\".\\nstop run.\\n' > /workspace/smoke.cbl; "
            "cobc -x -free /workspace/smoke.cbl -o /workspace/smoke-cobol; /workspace/smoke-cobol; fi"
        )
        assert compiler_code == 0, (compiler_code, compiler_output)
        for tty in [False, True]:
            process = runtime.call(
                "process.start",
                {
                    "operationId": runtime.operation_id(),
                    "scopeId": runtime.info["rootScopeId"],
                    "argv": [
                        "/bin/sh",
                        "-c",
                        ("test -t 0 && test -t 1 && test -t 2 || exit 7; " if tty else "")
                        + "read -r line; printf 'input:%s' \"$line\"",
                    ],
                    "cwd": "workspace://repo",
                    "tty": tty,
                    "pipeStdin": not tty,
                },
            )
            pid = process["processId"]
            runtime.call(
                "process.write",
                {
                    "operationId": runtime.operation_id(),
                    "processId": pid,
                    "dataBase64": base64.b64encode(b"hello\n").decode(),
                },
            )
            result = runtime.call("process.wait", {"processId": pid})
            page = runtime.call("output.read", {"processId": pid, "maxBytes": 65536})
            output = b"".join(base64.b64decode(chunk["dataBase64"]) for chunk in page["chunks"])
            assert result["exitCode"] == 0 and b"input:hello" in output, (result, page)
            if tty:
                assert all(chunk["stream"] == "pty" for chunk in page["chunks"]), page
        process = runtime.call(
            "process.start",
            {
                "operationId": runtime.operation_id(),
                "scopeId": runtime.info["rootScopeId"],
                "argv": ["/bin/sh", "-c", "sleep 60 & printf ready; wait"],
                "cwd": "workspace://repo",
            },
        )
        pid = process["processId"]
        page = runtime.call("output.read", {"processId": pid, "waitMs": 1000, "maxBytes": 1024})
        assert page["chunks"], page
        runtime.call("process.terminate", {"processId": pid})
        result = runtime.call("process.wait", {"processId": pid})
        assert result["state"] == "exited" and result["cleanupError"] is None, result
    finally:
        runtime.close()

    assert allowed_code == 0, (allowed_code, allowed_output)
    assert patch_code == 0 and (workspace / "allowed").read_text() == "patched\n", (
        patch_code,
        patch_output,
    )
    assert outside_code != 0 and not Path("/output/denied").exists(), (outside_code, outside_output)
    assert network_code != 0, (network_code, network_output)
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    permitted = RuntimeClient(workspace, allow_network=True, concurrent_writes=True)
    try:
        assert permitted.info["capabilities"]["rootNetwork"] == "inherit"
        background = permitted.call(
            "process.start",
            {
                "operationId": permitted.operation_id(),
                "scopeId": permitted.info["rootScopeId"],
                "argv": ["/bin/sleep", "60"],
                "cwd": "workspace://repo",
            },
        )
        code, output, _ = permitted.execute(
            "python3 -c "
            + shlex.quote(
                f"import socket; connection=socket.create_connection(('127.0.0.1',{listener.getsockname()[1]}),3); connection.close()"
            )
        )
        assert code == 0, (code, output)
        peer, _ = listener.accept()
        peer.close()
        permitted.call("process.terminate", {"processId": background["processId"]})
        permitted.call("process.wait", {"processId": background["processId"]})
    finally:
        permitted.close()
        listener.close()
    print(
        "Runtime Docker sandbox smoke: PASS (64 KiB read/write/stdin, escaped patch, replay, default deny, explicit network/command concurrency, PTY/cleanup)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
