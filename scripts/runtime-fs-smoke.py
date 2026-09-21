#!/usr/bin/env python3
"""Exercise the file provider through the real Runtime, helper and native sandbox."""

import argparse
import base64
import hashlib
from pathlib import Path
import runpy
import tempfile

Runtime = runpy.run_path(str(Path(__file__).with_name("runtime-smoke.py")))["Runtime"]


def run(binary, directory):
    workspace = directory / "workspace"
    workspace.mkdir()
    (workspace / "sub").mkdir()
    (workspace / "code").write_text("old content\n")
    (workspace / "subprocess.py").write_text(
        'raise AssertionError("workspace code imported by trusted launcher")\n'
    )
    (directory / "secret").write_text("outside-secret")
    (workspace / "escape").symlink_to(directory / "secret")
    runtime = Runtime(binary, workspace)
    try:
        runtime.info = runtime.call("connection.open", {"protocolVersion": "areal.runtime.v0"})
        assert "fs.execute" in runtime.info["capabilities"]["methods"]
        scope = runtime.scope()

        def request(command, target=scope):
            return {"operationId": runtime.op(), "scopeId": target, "command": command}

        def fs(kind, path="workspace://repo/code", **fields):
            return runtime.call("fs.execute", request({"kind": kind, "path": path, **fields}))

        # Exercise the advertised raw-byte boundary through every envelope and
        # the default output window, including replay and offset pagination.
        content = bytes(range(256)) * 257
        (workspace / "large.bin").write_bytes(content)
        for size in [65535, 65536]:
            read = request(
                {
                    "kind": "read",
                    "path": "workspace://repo/large.bin",
                    "offset": 0,
                    "maxBytes": size,
                }
            )
            page = runtime.call("fs.execute", read)
            assert base64.b64decode(page["dataBase64"]) == content[:size]
            assert page["nextOffset"] == size and not page["eof"]
            assert page["sha256"] == hashlib.sha256(content).hexdigest()
            assert runtime.call("fs.execute", read) == page
            tail = fs("read", "workspace://repo/large.bin", offset=size, maxBytes=65536)
            assert base64.b64decode(tail["dataBase64"]) == content[size:] and tail["eof"]
        (workspace / "empty").touch()
        empty = fs("read", "workspace://repo/empty", offset=0, maxBytes=65536)
        assert empty["dataBase64"] == "" and empty["eof"] and empty["nextOffset"] == 0

        for size in [65535, 65536]:
            path = f"workspace://repo/write-{size}"
            data = content[:size]
            write = request(
                {
                    "kind": "write",
                    "path": path,
                    "dataBase64": base64.b64encode(data).decode(),
                    "expected": {"kind": "absent"},
                }
            )
            result = runtime.call("fs.execute", write)
            assert result["size"] == size and result["sha256"] == hashlib.sha256(data).hexdigest()
            assert runtime.call("fs.execute", write) == result
            assert (workspace / f"write-{size}").read_bytes() == data
        oversized = request(
            {
                "kind": "write",
                "path": "workspace://repo/oversized",
                "dataBase64": base64.b64encode(content[:65537]).decode(),
                "expected": {"kind": "absent"},
            }
        )
        runtime.expect_error("INVALID_ARGUMENT", "fs.execute", oversized)
        assert not (workspace / "oversized").exists()

        # Escaped JSON text is serialized again inside helper argv. A valid
        # patch must retain its raw-text budget across both envelopes.
        escaped = '"' * 60000
        (workspace / "escaped").write_text("x")
        result = fs(
            "applyPatch",
            "workspace://repo/escaped",
            oldText="x",
            newText=escaped,
            expectedSha256=hashlib.sha256(b"x").hexdigest(),
        )
        assert result["size"] == len(escaped) and (workspace / "escaped").read_text() == escaped

        first = fs("read", offset=0, maxBytes=16384)
        assert base64.b64decode(first["dataBase64"]) == b"old content\n", first
        # A real lossless PNG larger than one raw chunk: the response's base64
        # envelope must not be mistaken for a 64 KiB output overflow.
        import random
        import struct
        import zlib

        def png_chunk(kind, data):
            return (
                struct.pack(">I", len(data))
                + kind
                + data
                + struct.pack(">I", zlib.crc32(kind + data))
            )

        pixels = random.Random(42).randbytes(256 * 256 * 3)
        scanlines = b"".join(b"\0" + pixels[y * 768 : (y + 1) * 768] for y in range(256))
        png = (
            b"\x89PNG\r\n\x1a\n"
            + png_chunk(b"IHDR", struct.pack(">IIBBBBB", 256, 256, 8, 2, 0, 0, 0))
            + png_chunk(b"IDAT", zlib.compress(scanlines))
            + png_chunk(b"IEND", b"")
        )
        (workspace / "noise.png").write_bytes(png)
        loaded = b""
        while len(loaded) < len(png):
            page = fs("read", "workspace://repo/noise.png", offset=len(loaded), maxBytes=65536)
            loaded += base64.b64decode(page["dataBase64"])
            assert page["sha256"] == hashlib.sha256(png).hexdigest()
        assert loaded == png and page["eof"]
        patch = request(
            {
                "kind": "applyPatch",
                "path": "workspace://repo/code",
                "oldText": "old",
                "newText": "new",
                "expectedSha256": first["sha256"],
            }
        )
        result = runtime.call("fs.execute", patch)
        assert (workspace / "code").read_text() == "new content\n"
        assert runtime.call("fs.execute", patch) == result
        runtime.expect_error(
            "CONFLICT", "fs.execute", {**patch, "command": {**patch["command"], "newText": "again"}}
        )
        runtime.expect_error("CONFLICT", "fs.execute", {**patch, "operationId": runtime.op()})
        create = request(
            {
                "kind": "write",
                "path": "workspace://repo/sub/binary",
                "dataBase64": base64.b64encode(b"a\0\xff").decode(),
                "expected": {"kind": "absent"},
            }
        )
        runtime.call("fs.execute", create)
        assert (workspace / "sub/binary").read_bytes() == b"a\0\xff"
        runtime.expect_error("CONFLICT", "fs.execute", {**create, "operationId": runtime.op()})
        assert (
            fs("list", "workspace://repo/sub", after=None, limit=1)["entries"][0]["name"]
            == "binary"
        )
        assert fs("stat", "workspace://repo/escape")["kind"] == "symlink"
        # No-follow and the OS policy jointly prohibit the redirection.
        try:
            fs("read", "workspace://repo/escape", offset=0, maxBytes=100)
        except Exception as error:
            assert getattr(error, "value", {}).get("code") in [
                "INVALID_ARGUMENT",
                "PERMISSION_DENIED",
            ], error
        else:
            raise AssertionError("followed an outside symlink")
        runtime.expect_error(
            "INVALID_ARGUMENT",
            "fs.execute",
            request({"kind": "stat", "path": "workspace://repo/../secret"}),
        )
        readonly = runtime.scope(readonly=True)
        runtime.expect_error(
            "PERMISSION_DENIED",
            "fs.execute",
            {**create, "operationId": runtime.op(), "scopeId": readonly},
        )
        for tty in [False, True]:
            assert runtime.info["capabilities"]["processInput"]["tty"] is True
            started = runtime.call(
                "process.start",
                {
                    "operationId": runtime.op(),
                    "scopeId": readonly,
                    "argv": [
                        "/bin/sh",
                        "-c",
                        ("test -t 0 || exit 9; " if tty else "")
                        + "IFS= read -r line; printf 'input:%s' \"$line\"",
                    ],
                    "cwd": "workspace://repo",
                    "tty": tty,
                    "pipeStdin": not tty,
                },
            )
            write = {
                "operationId": runtime.op(),
                "processId": started["processId"],
                "dataBase64": base64.b64encode(b"hello\n").decode(),
            }
            assert runtime.call("process.write", write) == {"accepted": True}
            assert runtime.call("process.write", write) == {"accepted": True}
            assert (
                runtime.call("process.wait", {"processId": started["processId"]})["exitCode"] == 0
            )
            chunks = runtime.output(started["processId"])["chunks"]
            assert b"input:hello" in b"".join(
                base64.b64decode(chunk["dataBase64"]) for chunk in chunks
            ), chunks
            runtime.expect_error(
                "SCOPE_CLOSED", "process.write", {**write, "operationId": runtime.op()}
            )

        # Keep the output small so this checks stdin's raw-byte boundary,
        # independently of the ordinary command-output retention window.
        for size in [65535, 65536]:
            started = runtime.call(
                "process.start",
                {
                    "operationId": runtime.op(),
                    "scopeId": readonly,
                    "argv": ["/bin/sh", "-c", f"head -c {size} | wc -c"],
                    "cwd": "workspace://repo",
                    "pipeStdin": True,
                },
            )
            write = {
                "operationId": runtime.op(),
                "processId": started["processId"],
                "dataBase64": base64.b64encode(content[:size]).decode(),
            }
            runtime.expect_error(
                "INVALID_ARGUMENT",
                "process.write",
                {**write, "dataBase64": base64.b64encode(content[:65537]).decode()},
            )
            assert runtime.call("process.write", write) == {"accepted": True}
            assert runtime.call("process.write", write) == {"accepted": True}
            assert (
                runtime.call("process.wait", {"processId": started["processId"]})["exitCode"] == 0
            )
            page = runtime.output(started["processId"])
            assert (
                int(b"".join(base64.b64decode(chunk["dataBase64"]) for chunk in page["chunks"]))
                == size
            )
        # Shell commands and file writes share the same mutation gate. A queued
        # conditional edit must check its hash after the command releases ownership.
        process = runtime.start(scope, "sleep 0.1; printf changed > code")
        queued = runtime.send(
            "fs.execute",
            request(
                {
                    "kind": "applyPatch",
                    "path": "workspace://repo/code",
                    "oldText": "new",
                    "newText": "bad",
                    "expectedSha256": result["sha256"],
                }
            ),
        )
        assert runtime.call("process.wait", {"processId": process})["exitCode"] == 0
        try:
            runtime.receive(queued)
        except Exception as error:
            assert getattr(error, "value", {}).get("code") == "CONFLICT", error
        else:
            raise AssertionError("stale edit overwrote a command's write")
        assert (workspace / "code").read_text() == "changed"
        # Owner revocation closes every resource and permanently fences that generation.
        owner = "fs-smoke-generation"
        params = {
            "operationId": runtime.op(),
            "parentScopeId": scope,
            "owner": {"taskId": "fixture", "pluginInstanceId": owner},
        }
        owned = runtime.call("scope.create", params)["scopeId"]
        runtime.start(owned, "exec /bin/sleep 30")
        revoked = runtime.call("owner.revoke", {"pluginInstanceId": owner})
        assert owned in revoked["scopeIds"]
        assert runtime.call("scope.waitClosed", {"scopeId": owned})["state"] == "closed"
        runtime.expect_error(
            "SCOPE_CLOSED", "scope.create", {**params, "operationId": runtime.op()}
        )
        runtime.call("scope.revoke", {"scopeId": scope})
        runtime.call("scope.waitClosed", {"scopeId": scope})
        runtime.call("connection.close", {})
        runtime.process.wait(timeout=12)
        assert runtime.process.returncode == 0, runtime.errors
    finally:
        runtime.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, default=Path("target/debug/areal-runtime"))
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="areal-fs-smoke-") as temporary:
        run(args.runtime.resolve(), Path(temporary).resolve())
    print(
        "PASS real Runtime filesystem: binary read/write, conditional patch, replay, conflicts, sandbox, stdin/TTY, write serialization, owner revocation and cleanup"
    )
