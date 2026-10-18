"""Behavioral checks for bounded, cancellation-safe RPC fanout."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import signal
import socket
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from rpc_fixture import Server, expected, requests_for


PROGRAM = Path("/app/rpc_fanout.py")


def write_requests(root, requests):
    path = root / "requests.json"
    path.write_text(json.dumps(requests) + "\n", encoding="utf-8")
    return path


def command(server, request_path, output_path, limit, timeout_ms):
    return ["python3", str(PROGRAM), "127.0.0.1", str(server.port), str(request_path), str(output_path), str(limit), str(timeout_ms)]


def load_module():
    spec = importlib.util.spec_from_file_location("candidate_fanout", PROGRAM)
    if spec is None or spec.loader is None:
        raise AssertionError("cannot import candidate module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TaskTests(unittest.TestCase):
    def assert_program(self):
        self.assertTrue(PROGRAM.is_file(), "required CLI is missing")

    def test_order_and_real_concurrency_bounds(self):
        self.assert_program()
        for seed, limit in ((413, 3), (722, 1)):
            with tempfile.TemporaryDirectory() as name, Server() as server:
                root = Path(name)
                requests = requests_for(seed, 7, 105)
                request_path = write_requests(root, requests)
                output = root / "result.json"
                started = time.monotonic()
                completed = subprocess.run(command(server, request_path, output, limit, 700), timeout=8, capture_output=True, text=True)
                elapsed = time.monotonic() - started
                self.assertEqual(completed.returncode, 0, completed.stderr)
                wanted = expected(requests)
                self.assertEqual(output.read_bytes(), (json.dumps(wanted, separators=(",", ":")) + "\n").encode())
                self.assertLessEqual(server.state.max_active, limit)
                self.assertEqual(server.state.max_active, min(limit, len(requests)))
                if limit == 3:
                    self.assertLess(elapsed, 1.3)

    def test_fixture_counts_connections_before_request_bytes(self):
        with Server() as server:
            sockets = [socket.create_connection(("127.0.0.1", server.port), timeout=2) for _ in range(4)]
            try:
                deadline = time.monotonic() + 2
                while server.state.max_active < 4 and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertEqual(server.state.max_active, 4)
                self.assertEqual(server.state.started, [])
            finally:
                for item in sockets:
                    item.close()
            self.assertTrue(server.state.wait_idle())

    def test_failure_and_timeout_stop_queue_then_clean(self):
        self.assert_program()
        cases = (("failure", 40, 900), ("timeout", 900, 90))
        for mode, first_delay, timeout_ms in cases:
            with tempfile.TemporaryDirectory() as name, Server() as server:
                root = Path(name)
                requests = requests_for(119 if mode == "failure" else 208, 6, 850)
                requests[0]["payload"]["delay_ms"] = first_delay
                requests[0]["payload"]["fail"] = mode == "failure"
                request_path = write_requests(root, requests)
                output = root / "result.json"
                output.write_bytes(b"stale\n")
                completed = subprocess.run(command(server, request_path, output, 2, timeout_ms), timeout=5, capture_output=True, text=True)
                self.assertNotEqual(completed.returncode, 0)
                self.assertFalse(output.exists())
                self.assertEqual(list(root.glob("result.json.tmp-*")), [])
                self.assertTrue(server.state.wait_idle())
                self.assertEqual(len(server.state.started), 2)
                self.assertEqual(set(server.state.started), {requests[0]["id"], requests[1]["id"]})

    def test_sigint_stops_queued_calls_and_closes_connections(self):
        self.assert_program()
        for seed, limit in ((331, 1), (954, 2)):
            with tempfile.TemporaryDirectory() as name, Server() as server:
                root = Path(name)
                requests = requests_for(seed, 7, 1500)
                request_path = write_requests(root, requests)
                output = root / "result.json"
                process = subprocess.Popen(command(server, request_path, output, limit, 5000), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                self.assertTrue(server.state.wait_started(limit))
                process.send_signal(signal.SIGINT)
                process.communicate(timeout=4)
                self.assertEqual(process.returncode, 130)
                self.assertTrue(server.state.wait_idle())
                started_after_exit = list(server.state.started)
                time.sleep(0.08)
                self.assertEqual(server.state.started, started_after_exit)
                self.assertEqual(len(started_after_exit), limit)
                self.assertFalse(output.exists())

    def test_coroutine_returns_cancellation_only_after_child_tasks_finish(self):
        self.assert_program()
        module = load_module()

        async def scenario(server):
            requests = requests_for(587, 5, 1200)
            baseline = set(asyncio.all_tasks())
            parent = asyncio.create_task(module.fanout("127.0.0.1", server.port, requests, 2, 5000))
            started = await asyncio.to_thread(server.state.wait_started, 2)
            self.assertTrue(started)
            parent.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await parent
            remaining = {task for task in asyncio.all_tasks() if task not in baseline and not task.done()}
            self.assertEqual(remaining, set())
            self.assertTrue(await asyncio.to_thread(server.state.wait_idle))

        with Server() as server:
            asyncio.run(scenario(server))

    def test_invalid_limit_starts_nothing(self):
        self.assert_program()
        with tempfile.TemporaryDirectory() as name, Server() as server:
            root = Path(name)
            request_path = write_requests(root, requests_for(42, 2))
            completed = subprocess.run(command(server, request_path, root / "result.json", 0, 300), timeout=3, capture_output=True, text=True)
            self.assertEqual(completed.returncode, 2)
            self.assertEqual(server.state.started, [])

    def test_request_schema_and_protocol_failures_are_orthogonal(self):
        invalid_requests = [
            [], [{"id": "x", "payload": {}, "extra": 1}], [{"id": "", "payload": {}}],
            [{"id": "x", "payload": []}], [{"id": "x", "payload": {}}, {"id": "x", "payload": {}}],
        ]
        for value in invalid_requests:
            with self.subTest(value=value), tempfile.TemporaryDirectory() as name, Server() as server:
                root = Path(name); request_path = write_requests(root, value); output = root / "result.json"; output.write_bytes(b"stale\n")
                completed = subprocess.run(command(server, request_path, output, 2, 300), timeout=3, capture_output=True, text=True)
                self.assertEqual(completed.returncode, 2)
                self.assertEqual(server.state.started, [])
                self.assertFalse(output.exists())
        for mode in ("invalid_json", "wrong_shape"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as name, Server() as server:
                root = Path(name); requests = requests_for(91, 1); requests[0]["payload"]["response_mode"] = mode
                output = root / "result.json"; output.write_bytes(b"stale\n")
                completed = subprocess.run(command(server, write_requests(root, requests), output, 1, 500), timeout=3, capture_output=True, text=True)
                self.assertNotEqual(completed.returncode, 0)
                self.assertFalse(output.exists())
                self.assertTrue(server.state.wait_idle())


if __name__ == "__main__":
    unittest.main()
