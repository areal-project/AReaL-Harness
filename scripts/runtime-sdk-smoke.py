#!/usr/bin/env python3
"""Give the Node SDK and Runtime exclusive inherited pipes, as a trusted host would."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]

with tempfile.TemporaryDirectory(prefix="areal-sdk-") as workspace:
    request_read, request_write = os.pipe()
    response_read, response_write = os.pipe()
    descriptors = {request_read, request_write, response_read, response_write}
    children = []
    try:
        runtime = subprocess.Popen(
            [
                str(root / "target/debug/areal-runtime"),
                "--workspace",
                workspace,
                "--allow-write",
                "--file-helper",
                str(root / "target/debug/areal-runtime-fs"),
            ],
            stdin=request_read,
            stdout=response_write,
            env={"PATH": "/usr/bin:/bin"},
        )
        children.append(runtime)
        for fd in (request_read, response_write):
            os.close(fd)
            descriptors.remove(fd)
        node = subprocess.Popen(
            [shutil.which("node"), str(root / "scripts/runtime-sdk-smoke.mjs"), workspace],
            stdin=response_read,
            stdout=request_write,
        )
        children.append(node)
        for fd in (response_read, request_write):
            os.close(fd)
            descriptors.remove(fd)
        node_code = node.wait(timeout=45)
        runtime_code = runtime.wait(timeout=15)
        if node_code or runtime_code:
            raise SystemExit(f"SDK smoke failed: Node {node_code}, Runtime {runtime_code}")
    finally:
        for fd in descriptors:
            os.close(fd)
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
