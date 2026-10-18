"""Independent numerical and isolated aggregate-performance checks."""

from __future__ import annotations

import hashlib
import json
import base64
import os
import select
import secrets
import signal
import statistics
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

import numpy as np

from fixture_factory import make_extreme_family, make_family


PROFILES = ((4, 256, 3.0), (7, 224, 80.0), (11, 192, 1200.0))
REPETITIONS = 7
LIMIT = 0.85
WORKER = Path(__file__).with_name("benchmark_worker.py")
PUBLIC_ASSETS = {
    Path("/app/public/benchmark.py"): "1c1b4679c2db56bc4fdf9d19f6292da1e2170344bf7f952380bd9ee37b0b739d",
    Path("/app/public/fixture_factory.py"): "4159dbd3807ce0163e152b51844757ba07305639fdc821df4858334849935114",
}
RUNTIME_SHA256 = "d49c5ae9f7881933a1b410a1a53793418b7ec5935736bbb2b0c9b8368820d6bd"
STARTUP_TIMEOUT = float(os.environ.get("TB_TEST_WORKER_STARTUP_TIMEOUT", "20"))
RUN_TIMEOUT = float(os.environ.get("TB_TEST_WORKER_RUN_TIMEOUT", "30"))
DUMP_TIMEOUT = float(os.environ.get("TB_TEST_WORKER_DUMP_TIMEOUT", "10"))
STOP_TIMEOUT = float(os.environ.get("TB_TEST_WORKER_STOP_TIMEOUT", "5"))


class Worker:
    def __init__(self, mode):
        self.mode = mode
        environment = os.environ.copy()
        for variable in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
            environment[variable] = "1"
        self.process = subprocess.Popen(
            [sys.executable, "-I", "-S", str(WORKER), mode],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=environment,
            start_new_session=True,
        )
        try:
            ready = self.read(STARTUP_TIMEOUT)
        except Exception:
            self.kill_group()
            for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
                stream.close()
            raise
        if ready != {"phase": "ready"}:
            raise AssertionError(ready)

    @staticmethod
    def assert_threads(threads):
        if not threads or any(value != 1 for value in threads):
            raise AssertionError(f"numerical libraries are not single-threaded: {threads}")

    def read(self, timeout):
        readable, _, _ = select.select([self.process.stdout], [], [], timeout)
        if not readable:
            self.kill_group()
            raise AssertionError(f"worker timed out after {timeout} seconds")
        line = self.process.stdout.readline()
        if not line:
            self.kill_group()
            raise AssertionError("worker exited without a response: " + self.process.stderr.read())
        return json.loads(line)

    def send(self, payload):
        self.process.stdin.write(json.dumps(payload) + "\n")
        self.process.stdin.flush()

    def run(self, index, matrices):
        nonce = secrets.token_hex(16)
        self.send({
            "phase": "run",
            "nonce": nonce,
            "index": index,
            "shape": list(matrices.shape),
            "data": base64.b64encode(matrices.tobytes(order="C")).decode("ascii"),
        })
        response = self.read(RUN_TIMEOUT)
        if response.get("phase") != "result" or response.get("nonce") != nonce or response.get("index") != index or type(response.get("elapsed_ns")) is not int:
            raise AssertionError(response)
        metadata = response["metadata"]
        values = np.frombuffer(base64.b64decode(response["values"], validate=True), dtype=np.complex128).copy()
        vectors = np.frombuffer(base64.b64decode(response["vectors"], validate=True), dtype=np.complex128).copy()
        input_after = base64.b64decode(response["input_after"], validate=True)
        return response["elapsed_ns"] / 1e9, metadata, values, vectors, input_after

    def kill_group(self):
        try:
            os.killpg(self.process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            self.process.wait(timeout=STOP_TIMEOUT)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=STOP_TIMEOUT)
        if self.mode == "candidate":
            self.kill_untrusted_processes()

    @staticmethod
    def kill_untrusted_processes():
        for status_path in Path("/proc").glob("[0-9]*/status"):
            try:
                fields = status_path.read_text(encoding="utf-8").splitlines()
                uid_line = next(line for line in fields if line.startswith("Uid:"))
                if int(uid_line.split()[2]) == 65534:
                    os.kill(int(status_path.parent.name), signal.SIGKILL)
            except (FileNotFoundError, ProcessLookupError, PermissionError, StopIteration, ValueError):
                pass

    def close(self):
        if self.process.poll() is None:
            try:
                nonce = secrets.token_hex(16)
                self.send({"phase": "stop", "nonce": nonce})
                if self.read(STOP_TIMEOUT) != {"phase": "stopped", "nonce": nonce}:
                    raise AssertionError("invalid stop response")
            except (AssertionError, BrokenPipeError):
                pass
        self.kill_group()
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            stream.close()


def check_result(test, matrices, truth, values, vectors, metadata, input_after):
    batch, n, _ = matrices.shape
    test.assertTrue(metadata["values_type"] and metadata["vectors_type"])
    test.assertEqual(metadata["values_dtype"], np.dtype(np.complex128).str)
    test.assertEqual(metadata["vectors_dtype"], np.dtype(np.complex128).str)
    test.assertEqual(metadata["values_shape"], [batch])
    test.assertEqual(metadata["vectors_shape"], [batch, n])
    test.assertEqual(values.size, batch)
    test.assertEqual(vectors.size, batch * n)
    test.assertTrue(np.isfinite(values).all() and np.isfinite(vectors).all())
    values = values.reshape(batch)
    vectors = vectors.reshape(batch, n)
    test.assertTrue(metadata["values_c"] and metadata["vectors_c"] and metadata["finite"])
    test.assertTrue(metadata["input_layout_unchanged"])
    test.assertEqual(input_after, matrices.tobytes(order="C"))
    relative = np.abs(values - truth) / np.abs(truth)
    test.assertLessEqual(float(relative.max()), 1e-8)
    norms = np.linalg.norm(vectors, axis=1)
    test.assertLessEqual(float(np.max(np.abs(norms - 1))), 1e-10)
    residuals = []
    for matrix, value, vector in zip(matrices, values, vectors):
        residuals.append(np.linalg.norm(matrix @ vector - value * vector) / (np.linalg.norm(matrix, 2) * np.linalg.norm(vector)))
    test.assertLessEqual(float(max(residuals)), 1e-10)


class TaskTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        for path, expected in PUBLIC_ASSETS.items():
            if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
                raise AssertionError(f"public benchmark asset changed: {path}")
        runtime_files = [Path("/usr/bin/python3.9"), Path("/lib64/libpython3.9.so.1.0"), Path("/usr/local/lib/python3.9/site-packages/threadpoolctl.py")]
        runtime_files += sorted(path for path in Path("/usr/local/lib64/python3.9/site-packages/numpy").rglob("*") if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc")
        digest = hashlib.sha256()
        for path in runtime_files:
            digest.update(str(path).encode() + b"\0")
            digest.update(path.read_bytes())
        if digest.hexdigest() != RUNTIME_SHA256:
            raise AssertionError("trusted Python numerical runtime changed")

    def test_01_domain_boundaries_and_repeated_calls(self):
        originals = [make_family(*specification) for specification in ((30001, 1, 3, 1.0, True), (30002, 11, 16, 1490.0, True), (30003, 7, 8, 37.0, False))]
        originals.append(make_extreme_family(30004))
        worker = Worker("candidate")
        try:
            for index in (0, 1, 2, 3, 1):
                matrices, truth = originals[index]
                _, metadata, values, vectors, input_after = worker.run(index, matrices)
                check_result(self, matrices, truth, values, vectors, metadata, input_after)
        finally:
            worker.close()

    def test_02_public_aggregate_performance(self):
        originals = []
        profile_indexes = []
        for profile_index, (n, batch, condition) in enumerate(PROFILES):
            indexes = []
            for repetition in range(REPETITIONS + 1):
                indexes.append(len(originals))
                originals.append(make_family(410000 + profile_index * 100 + repetition, batch, n, condition))
            profile_indexes.append(indexes)
        reference = candidate = None
        try:
            reference, candidate = Worker("reference"), Worker("candidate")
            for indexes in profile_indexes:
                for worker in (reference, candidate):
                    matrices, truth = originals[indexes[0]]
                    _, metadata, values, vectors, input_after = worker.run(indexes[0], matrices)
                    check_result(self, matrices, truth, values, vectors, metadata, input_after)
            reference_times = [[] for _ in PROFILES]
            candidate_times = [[] for _ in PROFILES]
            for repetition in range(REPETITIONS):
                order = (reference, candidate) if repetition % 2 == 0 else (candidate, reference)
                for profile_index, indexes in enumerate(profile_indexes):
                    fixture_index = indexes[repetition + 1]
                    for worker in order:
                        matrices, truth = originals[fixture_index]
                        elapsed, metadata, values, vectors, input_after = worker.run(fixture_index, matrices)
                        check_result(self, matrices, truth, values, vectors, metadata, input_after)
                        (reference_times if worker is reference else candidate_times)[profile_index].append(elapsed)
            reference_score = sum(statistics.median(values) for values in reference_times)
            candidate_score = sum(statistics.median(values) for values in candidate_times)
            self.assertLessEqual(candidate_score, LIMIT * reference_score, (candidate_score, reference_score, candidate_times, reference_times))
        finally:
            if candidate is not None:
                candidate.close()
            if reference is not None:
                reference.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
