import http.client
import importlib.util
import json
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location(
    "observer", Path(__file__).resolve().parents[1] / "runner/model_observer.py"
)
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


class ObserverTests(unittest.TestCase):
    def test_stream_forwarding_usage_timing_and_secret_exclusion(self):
        body = json.dumps({"model": "fixture", "input": "SECRET_PROMPT", "stream": True}).encode()
        events = b'data: {"type":"response.completed","response":{"usage":{"input_tokens":9,"output_tokens":3,"input_tokens_details":{"cached_tokens":4}}}}\n\n'
        seen = []

        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                seen.append(
                    (
                        self.path,
                        self.rfile.read(int(self.headers["Content-Length"])),
                        self.headers["Authorization"],
                    )
                )
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                self.wfile.write(events[:29])
                self.wfile.flush()
                time.sleep(0.03)
                self.wfile.write(events[29:])

        server = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / "requests.jsonl"
                proxy = observer.ModelObserver(
                    f"http://127.0.0.1:{server.server_port}", output, time.monotonic()
                )
                connection = http.client.HTTPConnection("127.0.0.1", proxy.server.server_port)
                connection.request(
                    "POST",
                    "/v1/responses",
                    body,
                    {"Authorization": "Bearer SECRET_KEY"},
                )
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(response.read(), events)
                connection.close()
                result = proxy.close()
                self.assertEqual(seen, [("/v1/responses", body, "Bearer SECRET_KEY")])
                self.assertEqual(result["request_count"], 1)
                self.assertEqual(
                    result["observed_usage"],
                    {"input_tokens": 9, "output_tokens": 3, "cached_input_tokens": 4},
                )
                self.assertEqual(result["usage_coverage"], 1)
                record = json.loads(output.read_text())
                self.assertLess(record["first_byte_ms"], record["duration_ms"])
                self.assertNotIn("SECRET", output.read_text())
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_partial_usage_is_not_zero_and_overlapping_time_is_not_double_counted(self):
        reader = observer.UsageReader(True)
        reader.feed(
            b'data: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":4,"cache_creation_input_tokens":2}}}\n'
        )
        self.assertEqual(reader.usage, {"input_tokens": 9, "cached_input_tokens": 4})
        reader.feed(b'data: {"type":"message_delta","usage":{"output_tokens":7}}\n')
        self.assertEqual(reader.usage["output_tokens"], 7)
        self.assertEqual(observer.union_ms([[2, 8], [3, 4], [7, 11], [15, 18]]), 12)

    def test_anthropic_nullable_deltas_preserve_input_components(self):
        reader = observer.UsageReader(True)
        reader.feed(
            b'data: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":4,"cache_creation_input_tokens":2}}}\n'
        )
        reader.feed(
            b'data: {"type":"message_delta","usage":{"input_tokens":5,"output_tokens":7,"cache_read_input_tokens":null,"cache_creation_input_tokens":null}}\n'
        )
        self.assertEqual(
            reader.usage,
            {"input_tokens": 11, "output_tokens": 7, "cached_input_tokens": 4},
        )
        reader.feed(
            b'data: {"type":"message_delta","usage":{"input_tokens":null,"output_tokens":8,"cache_read_input_tokens":null,"cache_creation_input_tokens":null}}\n'
        )
        reader.feed(b'data: {"type":"message_stop"}\n')
        self.assertEqual(
            reader.usage,
            {"input_tokens": 11, "output_tokens": 8, "cached_input_tokens": 4},
        )
        self.assertEqual(reader.parse_errors, 0)
        self.assertTrue(reader.terminal)

    def test_anthropic_partial_or_invalid_counters_do_not_invent_input_usage(self):
        reader = observer.UsageReader(True)
        reader.feed(
            b'data: {"type":"message_delta","usage":{"input_tokens":null,"output_tokens":7,"cache_read_input_tokens":4,"cache_creation_input_tokens":null}}\n'
        )
        self.assertNotIn("input_tokens", reader.usage)
        self.assertEqual(reader.usage["output_tokens"], 7)
        reader.feed(
            b'data: {"type":"message_delta","usage":{"input_tokens":3,"cache_read_input_tokens":true}}\n'
        )
        self.assertEqual(reader.parse_errors, 1)

    def test_close_drains_terminal_response_before_snapshotting_usage(self):
        finish = threading.Event()
        events = b'data: {"type":"response.completed","response":{"usage":{"input_tokens":9,"output_tokens":3}}}\n\n'

        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                self.wfile.write(events)
                self.wfile.flush()
                finish.wait(timeout=5)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as temporary:
                proxy = observer.ModelObserver(
                    f"http://127.0.0.1:{server.server_port}",
                    Path(temporary) / "requests.jsonl",
                    time.monotonic(),
                )
                connection = http.client.HTTPConnection("127.0.0.1", proxy.server.server_port)
                try:
                    connection.request(
                        "POST",
                        "/v1/responses",
                        b'{"model":"fixture"}',
                        headers={"Connection": "close"},
                    )
                    self.assertEqual(connection.getresponse().read(len(events)), events)
                    connection.close()
                    shutdown = proxy.server.shutdown

                    def shutdown_then_release_tail():
                        shutdown()
                        threading.Timer(0.1, finish.set).start()

                    with mock.patch.object(
                        proxy.server, "shutdown", side_effect=shutdown_then_release_tail
                    ):
                        result = proxy.close()
                    self.assertEqual(result["inflight_at_agent_exit"], 0)
                    self.assertEqual(result["usage_coverage"], 1)
                    self.assertEqual(result["observed_usage"]["input_tokens"], 9)
                finally:
                    finish.set()
                    connection.close()
        finally:
            finish.set()
            server.shutdown()
            server.server_close()
            thread.join()


class ObservationFailureTests(unittest.TestCase):
    def test_metrics_parser_does_not_interrupt_forwarding_on_malformed_usage(self):
        reader = observer.UsageReader(True)
        reader.feed(b'data: {"choices":null,"usage":{"input_tokens":12}}\n')
        reader.feed(b'data: {"usage":{"prompt_tokens":2,"prompt_tokens_details":null}}\n')
        reader.feed(b"data: [DONE]\n")
        self.assertEqual(reader.parse_errors, 2)
        reader.feed(
            b'data: {"type":"response.completed","response":{"usage":{"input_tokens":9,"output_tokens":3}}}\n'
        )
        self.assertTrue(reader.terminal)
        self.assertEqual(reader.usage, {"input_tokens": 9, "output_tokens": 3})

    def test_partial_failed_and_unparsed_streams_do_not_claim_full_usage_coverage(self):
        complete = {
            "start_ms": 0,
            "end_ms": 10,
            "status": 200,
            "completed_transport": True,
            "streaming": True,
            "semantic_terminal_seen": True,
            "usage": {"input_tokens": 9, "output_tokens": 3},
        }
        instance = observer.ModelObserver.__new__(observer.ModelObserver)
        instance.server = mock.Mock()
        instance.thread = mock.Mock()
        instance.lock = threading.Lock()
        instance.active = 1
        instance.drained = threading.Event()
        instance.records = [
            complete,
            {
                **complete,
                "semantic_terminal_seen": False,
                "usage": {"input_tokens": 9, "output_tokens": 0},
            },
            {**complete, "semantic_failure_seen": True},
            {**complete, "usage_parse_errors": 1},
        ]
        result = instance.close()
        self.assertEqual(result["request_count"], 5)
        self.assertEqual(result["usage_requests"], 1)
        self.assertEqual(result["usage_coverage"], 0.2)
        self.assertEqual(result["inflight_at_agent_exit"], 1)
        self.assertEqual(result["observed_request_union_ms"], 10)
        self.assertEqual(result["observed_usage"]["output_tokens"], 9)


class TerminalDeliveryTests(unittest.TestCase):
    def test_client_disconnect_after_delivered_terminal_keeps_complete_usage(self):
        instance = observer.ModelObserver.__new__(observer.ModelObserver)
        instance.server = mock.Mock()
        instance.thread = mock.Mock()
        instance.lock = threading.Lock()
        instance.active = 0
        instance.drained = threading.Event()
        instance.drained.set()
        instance.records = [
            {
                "start_ms": 0,
                "end_ms": 15,
                "terminal_delivered_ms": 10,
                "status": 200,
                "streaming": True,
                "completed_transport": False,
                "semantic_terminal_seen": True,
                "usage": {"input_tokens": 9, "output_tokens": 3},
            }
        ]
        result = instance.close()
        self.assertEqual(result["usage_coverage"], 1)
        self.assertEqual(result["client_disconnects_after_terminal"], 1)
        self.assertEqual(result["observed_request_union_ms"], 10)
