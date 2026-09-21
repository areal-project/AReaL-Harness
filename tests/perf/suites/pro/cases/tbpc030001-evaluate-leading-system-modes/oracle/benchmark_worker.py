#!/usr/bin/python3.9
"""Trusted supervisor. Submission code never inherits this control channel."""

import array
import base64
import fcntl
import json
import mmap
import os
import select
import secrets
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

sys.path[:0] = ["/usr/local/lib64/python3.9/site-packages", "/usr/local/lib/python3.9/site-packages"]

import numpy as np


EXECUTOR = Path(__file__).with_name("candidate_executor")
CLOCK = time.perf_counter_ns

def write_all(fd, data):
    view = memoryview(data)
    while view:
        view = view[os.write(fd, view):]

def read_exact(fd, size):
    chunks = []
    while size:
        chunk = os.read(fd, size)
        if not chunk:
            raise RuntimeError("short memfd read")
        chunks.append(chunk)
        size -= len(chunk)
    return b"".join(chunks)


def send_control(payload):
    os.write(1, (json.dumps(payload, sort_keys=True) + "\n").encode())


def start_executor(mode, control_fd):
    image_fd = os.memfd_create("trusted-candidate-executor", os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
    try:
        write_all(image_fd, EXECUTOR.read_bytes())
        os.fchmod(image_fd, 0o500)
        fcntl.fcntl(
            image_fd,
            fcntl.F_ADD_SEALS,
            fcntl.F_SEAL_SEAL | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_GROW | fcntl.F_SEAL_WRITE,
        )
        return subprocess.Popen(
            [f"/proc/self/fd/{image_fd}", mode, str(control_fd)],
            pass_fds=(control_fd, image_fd),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
    finally:
        os.close(image_fd)


class Executor:
    def __init__(self, mode):
        parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        self.socket = parent
        self.callback_token = secrets.token_hex(16)
        self.process = start_executor(mode, child.fileno())
        child.close()
        if self.receive(20).get("phase") != "ready":
            raise RuntimeError("executor did not become ready")
        self.assert_one_task()

    def assert_one_task(self):
        if len(list(Path(f"/proc/{self.process.pid}/task").iterdir())) != 1:
            raise RuntimeError("executor is not limited to one operating-system task")

    def receive(self, timeout):
        readable, _, _ = select.select([self.socket], [], [], timeout)
        if not readable:
            raise TimeoutError("executor timed out")
        payload = self.socket.recv(1024 * 1024)
        if not payload:
            raise RuntimeError("executor closed its data channel")
        return json.loads(payload)

    def connect_callback(self, timeout):
        deadline = time.monotonic() + timeout
        address = "\0tbpc002009-" + self.callback_token
        while time.monotonic() < deadline:
            returncode = self.process.poll()
            if returncode is not None:
                raise RuntimeError(f"executor exited before callback (status {returncode})")
            callback = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
            try:
                callback.connect(address)
                return callback
            except (FileNotFoundError, ConnectionRefusedError):
                callback.close()
                time.sleep(0.001)
        raise TimeoutError("executor callback timed out")

    def run(self, index, matrices):
        raw = matrices.tobytes(order="C")
        fd = os.memfd_create("current-mode-input", os.MFD_CLOEXEC)
        try:
            write_all(fd, raw)
            os.lseek(fd, 0, os.SEEK_SET)
            command = json.dumps({"phase": "run", "index": index, "shape": list(matrices.shape), "callback": self.callback_token}).encode()
            started = CLOCK()
            self.socket.sendmsg([command], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [fd]))])
            self.socket.close()
            self.socket = self.connect_callback(30)
            response = self.receive(30)
            elapsed_ns = CLOCK() - started
            self.assert_one_task()
            os.lseek(fd, 0, os.SEEK_SET)
            after = read_exact(fd, len(raw))
        finally:
            os.close(fd)
        if response.get("phase") != "result" or response.get("index") != index:
            if response.get("phase") == "error" and response.get("index") == index:
                raise RuntimeError(response.get("error", "submitted function failed"))
            raise RuntimeError("executor response is out of order")
        return elapsed_ns, response, after

    def close(self):
        try:
            self.socket.send(json.dumps({"phase": "stop"}).encode())
        except OSError:
            pass
        self.socket.close()
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=2)


def main():
    executor = Executor(sys.argv[1])
    send_control({"phase": "ready"})
    try:
        for line in sys.stdin:
            command = json.loads(line)
            nonce = command["nonce"]
            if command["phase"] == "stop":
                send_control({"phase": "stopped", "nonce": nonce})
                return
            matrices = np.frombuffer(base64.b64decode(command["data"], validate=True), dtype=np.complex128).copy().reshape(command["shape"])
            elapsed_ns, response, after = executor.run(int(command["index"]), matrices)
            response.update({"phase": "result", "nonce": nonce, "elapsed_ns": elapsed_ns, "input_after": base64.b64encode(after).decode()})
            send_control(response)
    finally:
        executor.close()


if __name__ == "__main__":
    main()
