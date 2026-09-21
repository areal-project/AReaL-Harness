#!/usr/bin/env python3
"""Executable public benchmark matching the scored reference protocol."""

import importlib.util
import array
import base64
import json
import mmap
import os
import resource
import select
import secrets
import socket
import statistics
import subprocess
import sys
import time
from pathlib import Path

for variable in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ[variable] = "1"

sys.path[:0] = ["/usr/local/lib64/python3.9/site-packages", "/usr/local/lib/python3.9/site-packages"]
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fixture_factory import make_family


PROFILES = ((4, 256, 3.0), (7, 224, 80.0), (11, 192, 1200.0))
WARMUPS = 1
TIMED_REPETITIONS = 7
MAX_AGGREGATE_RATIO = 0.85

def write_all(fd, data):
    view = memoryview(data)
    while view:
        view = view[os.write(fd, view):]


def load_submission():
    spec = importlib.util.spec_from_file_location("submitted_modes", "/app/modes.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def reference(matrices):
    values = []
    vectors = []
    for matrix in matrices:
        np.linalg.eigvals(matrix)
        current_values, current_vectors = np.linalg.eig(matrix)
        selected = int(np.argmax(np.abs(current_values)))
        values.append(current_values[selected])
        vectors.append(current_vectors[:, selected])
    return np.asarray(values), np.asarray(vectors)


class Executor:
    def __init__(self, mode):
        parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        self.socket = parent
        self.callback_token = secrets.token_hex(16)
        self.process = subprocess.Popen([sys.executable, "-I", str(Path(__file__).resolve()), "--executor", mode, str(child.fileno())], pass_fds=(child.fileno(),), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        child.close()
        if json.loads(self.socket.recv(4096)).get("phase") != "ready":
            raise RuntimeError("executor startup failed")

    def call(self, matrices):
        raw = matrices.tobytes(order="C")
        fd = os.memfd_create("public-current-input", os.MFD_CLOEXEC)
        try:
            write_all(fd, raw)
            started = time.perf_counter_ns()
            command = json.dumps({"phase": "run", "shape": list(matrices.shape), "callback": self.callback_token}).encode()
            self.socket.sendmsg([command], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [fd]))])
            self.socket.close()
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                callback = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
                try:
                    callback.connect("\0tbpc002009-public-" + self.callback_token)
                    self.socket = callback
                    break
                except (FileNotFoundError, ConnectionRefusedError):
                    callback.close()
                    time.sleep(0.001)
            else:
                raise TimeoutError("executor callback timed out")
            response = json.loads(self.socket.recv(1024 * 1024))
            elapsed = (time.perf_counter_ns() - started) / 1e9
        finally:
            os.close(fd)
        values = np.frombuffer(base64.b64decode(response["values"]), dtype=np.complex128)
        vectors = np.frombuffer(base64.b64decode(response["vectors"]), dtype=np.complex128).reshape(matrices.shape[:2])
        return elapsed, values, vectors

    def close(self):
        self.socket.send(json.dumps({"phase": "stop"}).encode())
        self.socket.close()
        self.process.wait(timeout=5)


def checked_call(executor, matrices):
    elapsed, values, vectors = executor.call(matrices)
    if values.shape != (len(matrices),) or vectors.shape != matrices.shape[:2]:
        raise AssertionError("wrong result shape")
    return elapsed


def benchmark():
    reference_executor = Executor("reference")
    candidate_executor = Executor("candidate")
    reference_times = [[] for _ in PROFILES]
    candidate_times = [[] for _ in PROFILES]
    for profile_index, (n, batch, condition) in enumerate(PROFILES):
        warmup = make_family(810000 + profile_index * 100, batch, n, condition)
        checked_call(reference_executor, warmup.copy())
        checked_call(candidate_executor, warmup.copy())
    for repetition in range(TIMED_REPETITIONS):
        order = ((reference_executor, reference_times), (candidate_executor, candidate_times)) if repetition % 2 == 0 else ((candidate_executor, candidate_times), (reference_executor, reference_times))
        for profile_index, (n, batch, condition) in enumerate(PROFILES):
            matrices = make_family(810001 + profile_index * 100 + repetition, batch, n, condition)
            for executor, timings in order:
                timings[profile_index].append(checked_call(executor, matrices.copy()))
    candidate_executor.close()
    reference_executor.close()
    reference_score = sum(statistics.median(values) for values in reference_times)
    candidate_score = sum(statistics.median(values) for values in candidate_times)
    print(json.dumps({"profiles": PROFILES, "warmups": WARMUPS, "timed_repetitions": TIMED_REPETITIONS, "max_aggregate_ratio": MAX_AGGREGATE_RATIO, "reference_score": reference_score, "candidate_score": candidate_score, "ratio": candidate_score / reference_score}, sort_keys=True))


def executor_main(mode, socket_fd):
    sock = socket.socket(fileno=socket_fd)
    if mode == "candidate":
        source = Path("/app/modes.py").read_bytes()
        resource.setrlimit(resource.RLIMIT_NPROC, (1, 1))
        os.setgroups([])
        os.setgid(65534)
        os.setuid(65534)
        namespace = {"__name__": "submitted_modes", "__file__": "/app/modes.py"}
        exec(compile(source, "/app/modes.py", "exec"), namespace)
        function = namespace["dominant_modes"]
    else:
        function = reference
    sock.send(json.dumps({"phase": "ready"}).encode())
    while True:
        payload, ancillary, _, _ = sock.recvmsg(65536, socket.CMSG_SPACE(array.array("i").itemsize))
        command = json.loads(payload)
        if command["phase"] == "stop":
            return
        fds = array.array("i")
        for level, kind, data in ancillary:
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                fds.frombytes(data[: len(data) - len(data) % fds.itemsize])
        fd = fds[0]
        try:
            with mmap.mmap(fd, 0, access=mmap.ACCESS_WRITE) as mapping:
                matrices = np.ndarray(tuple(command["shape"]), dtype=np.complex128, buffer=mapping)
                sock.close()
                values, vectors = function(matrices)
                metadata = {"values_shape": list(values.shape), "vectors_shape": list(vectors.shape), "values_dtype": values.dtype.str, "vectors_dtype": vectors.dtype.str, "values_c": bool(values.flags.c_contiguous), "vectors_c": bool(vectors.flags.c_contiguous), "finite": bool(np.isfinite(values).all() and np.isfinite(vectors).all())}
                listener = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
                listener.bind("\0tbpc002009-public-" + command["callback"])
                listener.listen(1)
                sock, _ = listener.accept()
                listener.close()
                sock.send(json.dumps({"metadata": metadata, "values": base64.b64encode(values.tobytes(order="C")).decode(), "vectors": base64.b64encode(vectors.tobytes(order="C")).decode()}, sort_keys=True).encode())
        finally:
            os.close(fd)


def example():
    matrices = np.asarray(
        [
            [[2 + 1j, 0.2 - 0.1j, 0], [0, -0.4 + 0.3j, 0.1], [0, 0, 0.3 - 0.2j]],
            [[-1.8j, 0, 0.1], [0.2, 0.6 + 0.1j, 0], [0, 0.1, -0.2]],
        ],
        dtype=np.complex128,
        order="C",
    )
    values, vectors = load_submission().dominant_modes(matrices)
    if values.shape != (2,) or vectors.shape != (2, 3):
        raise AssertionError("wrong result shape")
    for matrix, value, vector in zip(matrices, values, vectors):
        residual = np.linalg.norm(matrix @ vector - value * vector)
        residual /= np.linalg.norm(matrix, 2) * np.linalg.norm(vector)
        if residual > 1e-10 or abs(np.linalg.norm(vector) - 1) > 1e-10:
            raise AssertionError("public numerical contract failed")
    benchmark()


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--executor":
        executor_main(sys.argv[2], int(sys.argv[3]))
    else:
        example()
