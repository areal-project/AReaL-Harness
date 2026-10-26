"""用真实本地HTTP验证计量改进不改变转发、取消和上游调用次数。"""

import contextlib
import http.client
import importlib.util
import json
import socket
import struct
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location(
    "usage_observer", Path(__file__).resolve().parents[1] / "runner/model_observer.py"
)
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


def event(kind="response.completed", usage=None, identity="resp_fixture"):
    return json.dumps(
        {
            "type": kind,
            "response": {
                "id": identity,
                "usage": {"input_tokens": 9, "output_tokens": 3} if usage is None else usage,
            },
        }
    ).encode()


class ReceiptTests(unittest.TestCase):
    def test_json_finalization_is_idempotent(self):
        reader = observer.UsageReader(False)
        reader.feed(event(), final=True)
        reader.feed(b"", final=True)
        self.assertEqual(reader.parse_errors, 0)
        self.assertTrue(reader.receipt_complete)

    def test_json_recursion_error_cannot_escape_the_metrics_parser(self):
        for streaming in [False, True]:
            reader = observer.UsageReader(streaming)
            # 不依赖其他测试可能改动的全局递归上限，也不冒真实C栈溢出的风险。
            with mock.patch.object(observer.json, "loads", side_effect=RecursionError):
                reader.feed(b"data: {}\n\n" if streaming else b"{}", final=True)
            self.assertEqual(reader.parse_errors, 1)
            self.assertFalse(reader.receipt_complete)

    def test_receipt_waits_for_the_complete_multiline_event(self):
        reader = observer.UsageReader(True)
        reader.feed(b"data: " + event() + b"\n")
        self.assertFalse(reader.receipt_complete)
        reader.feed(b"data: not-json\n\n")
        self.assertFalse(reader.receipt_complete)
        self.assertEqual(reader.parse_errors, 1)
        reader.feed(b"data: " + event() + b"\n\n")
        self.assertTrue(reader.receipt_complete)

    def test_invalid_followup_cache_count_invalidates_prior_receipt(self):
        reader = observer.UsageReader(True)
        reader.feed(b"data: " + event() + b"\n\n")
        self.assertTrue(reader.receipt_complete)
        reader.feed(
            b"data: "
            + event(
                usage={
                    "input_tokens": 9,
                    "output_tokens": 3,
                    "input_tokens_details": {"cached_tokens": 10},
                }
            )
            + b"\n\n"
        )
        self.assertFalse(reader.receipt_complete)
        self.assertTrue(reader.response_id_conflict)

    def test_complete_eof_line_without_newline_is_retained(self):
        reader = observer.UsageReader(True)
        reader.feed(b"data: " + event())
        self.assertFalse(reader.receipt_complete)
        reader.feed(b"", final=True)
        self.assertTrue(reader.receipt_complete)
        self.assertEqual(reader.receipt_usage, {"input_tokens": 9, "output_tokens": 3})
        self.assertTrue(reader.eof_receipt_recovered)
        self.assertFalse(reader.terminal)

    def test_multiline_crlf_bare_cr_and_one_byte_chunks(self):
        for newline in [b"\n", b"\r\n", b"\r"]:
            with self.subTest(newline=newline):
                reader = observer.UsageReader(True)
                payload = (
                    b": keepalive"
                    + newline
                    + b'data: {"type":"response.completed",'
                    + newline
                    + b'data: "response":{"id":"resp_split","usage":'
                    + newline
                    + b'data: {"input_tokens":9,"output_tokens":3}}}'
                    + newline
                    + newline
                )
                for byte in payload:
                    reader.feed(bytes([byte]))
                reader.feed(b"", final=True)
                self.assertTrue(reader.receipt_complete)
                self.assertEqual(reader.response_id, "resp_split")
                self.assertEqual(reader.parse_errors, 0)

    def test_failed_incomplete_and_zero_receipts_are_known_without_success(self):
        for kind in ["response.failed", "response.incomplete"]:
            reader = observer.UsageReader(True)
            reader.feed(b"data: " + event(kind, {"input_tokens": 0, "output_tokens": 0}) + b"\n\n")
            self.assertTrue(reader.failed)
            self.assertFalse(reader.terminal)
            self.assertTrue(reader.receipt_complete)
            self.assertEqual(reader.receipt_usage, {"input_tokens": 0, "output_tokens": 0})

    def test_unknown_and_partial_usage_are_not_filled_with_zero(self):
        for usage in [{}, {"input_tokens": 9}, {"input_tokens": 9, "output_tokens": None}]:
            reader = observer.UsageReader(True)
            reader.feed(b"data: " + event(usage=usage) + b"\n\n")
            self.assertFalse(reader.receipt_complete)
            self.assertNotIn("output_tokens", reader.usage)

    def test_unrelated_parse_error_does_not_discard_later_authoritative_receipt(self):
        reader = observer.UsageReader(True)
        reader.feed(b"data: invalid\n\n")
        reader.feed(b"data: " + event() + b"\n\n")
        self.assertEqual(reader.parse_errors, 1)
        self.assertTrue(reader.receipt_complete)

    def test_conflicting_identity_or_terminal_counters_are_not_trusted(self):
        for same_identity in [False, True]:
            reader = observer.UsageReader(True)
            reader.feed(b"data: " + event() + b"\n\n")
            second = event(
                usage={"input_tokens": 8, "output_tokens": 2},
                identity="resp_fixture" if same_identity else "resp_other",
            )
            reader.feed(b"data: " + second + b"\n\n")
            self.assertTrue(reader.response_id_conflict)

    def test_chat_truncation_usage_after_finish_and_anthropic_final_are_counted(self):
        reader = observer.UsageReader(True)
        reader.feed(b'data: {"choices":[{"finish_reason":"length"}]}\n\n')
        reader.feed(b'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":3}}\n\n')
        self.assertTrue(reader.failed)
        self.assertTrue(reader.receipt_complete)
        anthropic = observer.UsageReader(True)
        anthropic.feed(b'data: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\n')
        anthropic.feed(b'data: {"type":"message_delta","usage":{"output_tokens":3}}\n\n')
        self.assertFalse(anthropic.receipt_complete)
        anthropic.feed(b'data: {"type":"message_stop"}\n\n')
        self.assertTrue(anthropic.receipt_complete)

    def test_event_limit_does_not_reject_large_batch_of_small_events(self):
        with mock.patch.object(observer, "MAX_BODY", 256):
            reader = observer.UsageReader(True)
            reader.feed(b": ignore\n\n" * 1000 + b"data: " + event() + b"\n\n")
            self.assertFalse(reader.overflow)
            self.assertTrue(reader.receipt_complete)
            reader = observer.UsageReader(True)
            reader.feed(b"data: " + b"x" * 300)
            self.assertTrue(reader.overflow)


@contextlib.contextmanager
def running(upstream):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            upstream(self)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
    thread.start()
    with tempfile.TemporaryDirectory() as directory:
        proxy = observer.ModelObserver(
            f"http://127.0.0.1:{server.server_port}",
            Path(directory) / "requests.jsonl",
            time.monotonic(),
        )
        try:
            yield proxy, Path(directory)
        finally:
            proxy.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=1)


def request(proxy, body=b'{"model":"fixture","stream":true}'):
    connection = http.client.HTTPConnection("127.0.0.1", proxy.server.server_port, timeout=4)
    try:
        connection.request("POST", "/responses", body, {"Authorization": "Bearer SECRET_KEY"})
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


def respond(handler, payload):
    handler.rfile.read(int(handler.headers["Content-Length"]))
    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream")
    handler.send_header("Content-Length", str(len(payload)))
    handler.send_header("x-request-id", "req_upstream_fixture")
    handler.end_headers()
    handler.wfile.write(payload)
    handler.wfile.flush()


class NonInterferenceTests(unittest.TestCase):
    def test_parallel_forwarding_identity_privacy_and_usage_are_exact(self):
        seen = []
        lock = threading.Lock()
        payload = b"data: " + event() + b"\n\n"

        def upstream(handler):
            body = handler.rfile.read(int(handler.headers["Content-Length"]))
            with lock:
                seen.append((handler.path, body, handler.headers.get("Authorization")))
            handler.send_response(200)
            handler.send_header("Content-Length", str(len(payload)))
            handler.send_header("Content-Type", "text/event-stream")
            handler.send_header("x-request-id", "req_upstream_fixture")
            handler.end_headers()
            handler.wfile.write(payload)

        with running(upstream) as (proxy, directory):
            bodies = [
                json.dumps({"model": "fixture", "input": f"SECRET_PROMPT_{i}"}).encode()
                for i in range(24)
            ]
            with ThreadPoolExecutor(max_workers=6) as pool:
                replies = list(pool.map(lambda body: request(proxy, body), bodies))
            summary = proxy.close()
            self.assertEqual(replies, [(200, payload)] * 24)
            self.assertEqual(sorted(x[1] for x in seen), sorted(bodies))
            self.assertTrue(all(x[0] == "/responses" and x[2] == "Bearer SECRET_KEY" for x in seen))
            self.assertEqual(summary["request_count"], 24)
            self.assertEqual(summary["usage_requests"], 24)
            self.assertEqual(summary["observed_usage"]["input_tokens"], 24 * 9)
            records = [
                json.loads(line) for line in (directory / "requests.jsonl").read_text().splitlines()
            ]
            self.assertEqual(len({x["observation_id"] for x in records}), 24)
            self.assertTrue(
                all(x["provider_request_id"] == "req_upstream_fixture" for x in records)
            )
            self.assertNotIn("SECRET", (directory / "requests.lifecycle.jsonl").read_text())
            self.assertEqual(summary["usage_field_coverage"]["cached_input_tokens"], 0)

    def test_disk_failure_cannot_fail_or_retry_service_request(self):
        calls = []
        payload = b"data: " + event() + b"\n\n"

        def upstream(handler):
            calls.append(1)
            respond(handler, payload)

        with running(upstream) as (proxy, directory):
            proxy.output = directory / "nonexistent" / "requests.jsonl"
            proxy.lifecycle_output = directory / "nonexistent" / "requests.lifecycle.jsonl"
            self.assertEqual(request(proxy), (200, payload))
            summary = proxy.close()
            self.assertEqual(summary["usage_coverage"], 1)
            self.assertGreater(summary["metadata_persistence"]["errors"], 0)
            self.assertEqual(calls, [1])

    def test_blocked_writer_cannot_hold_forwarding_lock(self):
        blocked, release = threading.Event(), threading.Event()
        payload = b"data: " + event() + b"\n\n"
        original = Path.open

        with running(lambda handler: respond(handler, payload)) as (proxy, directory):

            def slow_open(path, *args, **kwargs):
                if path.name.endswith(".lifecycle.jsonl"):
                    blocked.set()
                    release.wait(timeout=5)
                return original(path, *args, **kwargs)

            try:
                with mock.patch.object(Path, "open", slow_open):
                    self.assertEqual(request(proxy), (200, payload))
                    self.assertTrue(blocked.wait(timeout=1))
                    self.assertFalse(release.is_set())
                    # HTTP EOF 先于服务端 finally；等待明确结算，且不能先放开磁盘写入。
                    self.assertTrue(proxy.drained.wait(timeout=1))
                    with proxy.lock:
                        self.assertEqual(len(proxy.records), 1)
                    release.set()
                    self.assertEqual(proxy.close()["metadata_persistence"]["errors"], 0)
            finally:
                release.set()

    def test_close_keeps_received_receipt_while_upstream_tail_is_pending(self):
        release = threading.Event()
        payload = b"data: " + event() + b"\n\n"

        def upstream(handler):
            handler.rfile.read(int(handler.headers["Content-Length"]))
            handler.send_response(200)
            handler.send_header("Content-Type", "text/event-stream")
            handler.end_headers()
            handler.wfile.write(payload)
            handler.wfile.flush()
            release.wait(timeout=8)

        with running(upstream) as (proxy, directory):
            connection = http.client.HTTPConnection(
                "127.0.0.1", proxy.server.server_port, timeout=3
            )
            try:
                connection.request("POST", "/responses", b'{"model":"fixture"}')
                self.assertEqual(connection.getresponse().read(len(payload)), payload)
                summary = proxy.close()
                self.assertEqual(summary["inflight_at_agent_exit"], 1)
                self.assertEqual(summary["inflight_with_usage_receipt"], 1)
                self.assertEqual(summary["usage_coverage"], 1)
                self.assertEqual(summary["observed_usage"]["input_tokens"], 9)
                entries = [
                    json.loads(line)
                    for line in (directory / "requests.lifecycle.jsonl").read_text().splitlines()
                ]
                self.assertEqual(sum(x["event"] == "usage_receipt" for x in entries), 1)
            finally:
                release.set()
                connection.close()
                proxy.drained.wait(timeout=2)

    def test_disconnect_does_not_drain_to_get_usage_or_replay_generation(self):
        calls = []
        upstream_closed = threading.Event()

        def upstream(handler):
            calls.append(1)
            handler.rfile.read(int(handler.headers["Content-Length"]))
            handler.send_response(200)
            handler.send_header("Content-Type", "text/event-stream")
            handler.end_headers()
            try:
                for _ in range(100):
                    handler.wfile.write(b": keepalive" + b" " * 8192 + b"\n\n")
                    handler.wfile.flush()
                    time.sleep(0.005)
            except (BrokenPipeError, ConnectionResetError):
                upstream_closed.set()

        with running(upstream) as (proxy, _):
            client = socket.create_connection(("127.0.0.1", proxy.server.server_port), timeout=2)
            client.sendall(
                b"POST /responses HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n{}"
            )
            self.assertTrue(client.recv(4096))
            client.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
            client.close()
            self.assertTrue(proxy.drained.wait(timeout=2))
            self.assertTrue(upstream_closed.wait(timeout=2))
            summary = proxy.close()
            self.assertEqual(calls, [1])
            self.assertEqual(summary["usage_requests"], 0)
            self.assertIsNone(summary["observed_usage"]["input_tokens"])
            self.assertEqual(sum(summary["usage_unknown_by_reason"].values()), 1)

    def test_failed_receipt_is_counted_but_failure_is_retained(self):
        payload = b"data: " + event("response.incomplete") + b"\n\n"
        with running(lambda handler: respond(handler, payload)) as (proxy, _):
            self.assertEqual(request(proxy), (200, payload))
            summary = proxy.close()
            self.assertEqual(summary["usage_coverage"], 1)
            self.assertTrue(proxy.records[0]["semantic_failure_seen"])
            self.assertFalse(proxy.records[0]["semantic_terminal_seen"])

    def test_conflicting_live_receipt_invalidates_prior_checkpoint(self):
        allow_conflict, release = threading.Event(), threading.Event()
        first = b"data: " + event() + b"\n\n"
        second = b"data: " + event(identity="resp_other") + b"\n\n"

        def upstream(handler):
            handler.rfile.read(int(handler.headers["Content-Length"]))
            handler.send_response(200)
            handler.send_header("Content-Type", "text/event-stream")
            handler.end_headers()
            handler.wfile.write(first)
            handler.wfile.flush()
            allow_conflict.wait(timeout=5)
            handler.wfile.write(second)
            handler.wfile.flush()
            release.wait(timeout=8)

        with running(upstream) as (proxy, _):
            connection = http.client.HTTPConnection(
                "127.0.0.1", proxy.server.server_port, timeout=3
            )
            try:
                connection.request("POST", "/responses", b'{"model":"fixture"}')
                response = connection.getresponse()
                self.assertEqual(response.read(len(first)), first)
                allow_conflict.set()
                self.assertEqual(response.read(len(second)), second)
                summary = proxy.close()
                self.assertEqual(summary["usage_requests"], 0)
                self.assertEqual(summary["usage_unknown_by_reason"], {"conflicting_receipts": 1})
                self.assertIsNone(summary["observed_usage"]["input_tokens"])
            finally:
                allow_conflict.set()
                release.set()
                connection.close()
                proxy.drained.wait(timeout=2)


class BoundedWriterTests(unittest.TestCase):
    def test_queue_saturation_is_explicit_and_never_blocks_submit(self):
        blocked, release = threading.Event(), threading.Event()

        class SlowPath:
            def open(self, *_):
                blocked.set()
                release.wait(timeout=3)
                raise OSError("fixture disk failure")

        writer = observer.MetadataWriter(capacity=1)
        try:
            writer.submit(SlowPath(), {"n": 1})
            self.assertTrue(blocked.wait(timeout=1))
            writer.submit(SlowPath(), {"n": 2})
            writer.submit(SlowPath(), {"n": 3})
            self.assertEqual(writer.dropped, 1)
            before = time.monotonic()
            result = writer.close()
            self.assertLess(time.monotonic() - before, 0.6)
            self.assertGreater(result["pending_records"], 0)
        finally:
            release.set()
            writer.thread.join(timeout=2)
