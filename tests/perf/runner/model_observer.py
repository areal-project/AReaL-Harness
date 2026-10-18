"""Transparent local HTTP observer; never records prompts, outputs or credentials."""

from __future__ import annotations

import hashlib
import http.client
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
    "host",
}
MAX_BODY = 32 * 1024 * 1024


def union_ms(intervals):
    end, total = None, 0.0
    for start, stop in sorted(intervals):
        if stop < start:
            continue
        total += max(0.0, stop - max(start, end if end is not None else start))
        end = max(stop, end if end is not None else stop)
    return total


class UsageReader:
    def __init__(self, sse):
        self.sse = sse
        self.buffer = b""
        self.usage = {}
        self.anthropic_input_usage = {}
        self.terminal = False
        self.failed = False
        self.overflow = False
        self.parse_errors = 0

    def event(self, value):
        if not isinstance(value, dict):
            return
        kind = value.get("type")
        if kind in {"response.failed", "response.incomplete", "error"}:
            self.failed = True
        if any(
            choice.get("finish_reason") in {"stop", "tool_calls"}
            for choice in value.get("choices", [])
            if isinstance(choice, dict)
        ):
            self.terminal = True
        if kind in {"response.completed", "message_stop"}:
            self.terminal = True
        source = value.get("response") or value.get("message") or value
        usage = source.get("usage") if isinstance(source, dict) else None
        if not isinstance(usage, dict):
            return
        if "prompt_tokens" in usage:
            usage = {
                "input_tokens": usage["prompt_tokens"],
                "output_tokens": usage.get("completion_tokens"),
                "cached_input_tokens": usage.get("prompt_tokens_details", {}).get("cached_tokens"),
            }
        else:
            usage = dict(usage)
            if (
                kind in {"message_start", "message_delta"}
                or "cache_read_input_tokens" in usage
                or "cache_creation_input_tokens" in usage
            ):
                # Anthropic deltas may omit or null an unchanged counter. Keep
                # each component before calculating the total input usage.
                for key in (
                    "input_tokens",
                    "cache_read_input_tokens",
                    "cache_creation_input_tokens",
                ):
                    number = usage.get(key)
                    if number is None:
                        continue
                    if not isinstance(number, int) or isinstance(number, bool) or number < 0:
                        raise ValueError("invalid Anthropic usage counter")
                    self.anthropic_input_usage[key] = number
                if "input_tokens" in self.anthropic_input_usage:
                    usage["input_tokens"] = sum(self.anthropic_input_usage.values())
                else:
                    usage.pop("input_tokens", None)
                usage["cached_input_tokens"] = self.anthropic_input_usage.get(
                    "cache_read_input_tokens"
                )
            elif isinstance(usage.get("input_tokens_details"), dict):
                usage["cached_input_tokens"] = usage["input_tokens_details"].get("cached_tokens")
        for key in ("input_tokens", "output_tokens", "cached_input_tokens"):
            number = usage.get(key)
            if isinstance(number, int) and not isinstance(number, bool) and number >= 0:
                self.usage[key] = number

    def feed(self, chunk, final=False):
        if self.overflow:
            return
        self.buffer += chunk
        if len(self.buffer) > MAX_BODY:
            self.buffer = b""
            self.overflow = True
            return
        if self.sse:
            while b"\n" in self.buffer:
                line, self.buffer = self.buffer.split(b"\n", 1)
                if not line.startswith(b"data:"):
                    continue
                try:
                    self.event(json.loads(line[5:].strip()))
                except (ValueError, UnicodeError, TypeError, AttributeError):
                    # Metrics must never break an otherwise valid forwarded stream.
                    if line[5:].strip() != b"[DONE]":
                        self.parse_errors += 1
        elif final:
            try:
                self.event(json.loads(self.buffer))
            except (ValueError, UnicodeError, TypeError, AttributeError):
                self.parse_errors += 1
            self.buffer = b""


class ModelObserver:
    def __init__(self, upstream: str, output: Path, origin: float):
        parsed = urlsplit(upstream)
        if (
            parsed.scheme not in {"http", "https"}
            or parsed.username
            or parsed.password
            or parsed.query
        ):
            raise ValueError("observer requires a credential-free HTTP gateway URL")
        self.upstream, self.output, self.origin = parsed, output, origin
        self.lock = threading.Lock()
        self.records = []
        self.active = 0
        self.drained = threading.Event()
        self.drained.set()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_):
                pass

            def do_POST(self):
                start = time.monotonic()
                with owner.lock:
                    owner.active += 1
                    owner.drained.clear()
                record = {
                    "start_ms": (start - owner.origin) * 1000,
                    "path": urlsplit(self.path).path,
                    "status": None,
                    "first_byte_ms": None,
                    "completed_transport": False,
                    "usage": {},
                }
                connection = None
                response_started = False
                reader = None
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if not 0 < length <= MAX_BODY or self.headers.get("Transfer-Encoding"):
                        self.send_error(413)
                        return
                    body = self.rfile.read(length)
                    record["request_sha256"] = hashlib.sha256(body).hexdigest()
                    try:
                        request = json.loads(body)
                        record["model"] = request.get("model")
                        record["parameters"] = {
                            key: request[key]
                            for key in (
                                "reasoning",
                                "reasoning_effort",
                                "thinking",
                                "output_config",
                                "max_tokens",
                                "max_output_tokens",
                                "temperature",
                                "stream",
                            )
                            if key in request
                        }
                    except (ValueError, AttributeError):
                        pass
                    kind = (
                        http.client.HTTPSConnection
                        if parsed.scheme == "https"
                        else http.client.HTTPConnection
                    )
                    connection = kind(parsed.hostname, parsed.port, timeout=240)
                    headers = {
                        key: value
                        for key, value in self.headers.items()
                        if key.lower() not in HOP_HEADERS
                    }
                    connection.request("POST", parsed.path.rstrip("/") + self.path, body, headers)
                    response = connection.getresponse()
                    record["status"] = response.status
                    record["headers_ms"] = (time.monotonic() - start) * 1000
                    reader = UsageReader(
                        "text/event-stream" in response.getheader("Content-Type", "")
                    )
                    self.send_response(response.status)
                    for key, value in response.getheaders():
                        if key.lower() not in HOP_HEADERS:
                            self.send_header(key, value)
                    self.send_header("Transfer-Encoding", "chunked")
                    self.end_headers()
                    response_started = True
                    while chunk := response.read1(16384):
                        if record["first_byte_ms"] is None:
                            record["first_byte_ms"] = (time.monotonic() - start) * 1000
                        reader.feed(chunk)
                        self.wfile.write(f"{len(chunk):X}\r\n".encode() + chunk + b"\r\n")
                        self.wfile.flush()
                        if reader.terminal and "terminal_delivered_ms" not in record:
                            record["terminal_delivered_ms"] = (
                                time.monotonic() - owner.origin
                            ) * 1000
                    reader.feed(b"", final=True)
                    self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
                    record["completed_transport"] = True
                except Exception as error:
                    record["error_kind"] = type(error).__name__
                    self.close_connection = True
                    if not response_started:
                        try:
                            self.send_error(502, "model observer upstream connection failed")
                        except OSError:
                            pass
                finally:
                    if connection:
                        connection.close()
                    if reader:
                        record["streaming"] = reader.sse
                        record["semantic_failure_seen"] = reader.failed
                        record["usage"] = reader.usage
                        record["semantic_terminal_seen"] = reader.terminal
                        record["usage_parser_overflow"] = reader.overflow
                        record["usage_parse_errors"] = reader.parse_errors
                    record["end_ms"] = (time.monotonic() - owner.origin) * 1000
                    record["duration_ms"] = record["end_ms"] - record["start_ms"]
                    with owner.lock:
                        owner.active -= 1
                        if owner.active == 0:
                            owner.drained.set()
                        owner.records.append(record)
                        with owner.output.open("a") as handle:
                            handle.write(json.dumps(record, sort_keys=True) + "\n")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=1)
        self.drained.wait(timeout=2)
        with self.lock:
            records = list(self.records)
            active = self.active
        durations = [
            [item["start_ms"], item.get("terminal_delivered_ms", item["end_ms"])]
            for item in records
        ]
        complete_usage = [
            item
            for item in records
            if all(key in item["usage"] for key in ("input_tokens", "output_tokens"))
            and (item["completed_transport"] or item.get("terminal_delivered_ms") is not None)
            and item["status"] is not None
            and item["status"] < 400
            and not item.get("semantic_failure_seen")
            and not item.get("usage_parser_overflow")
            and not item.get("usage_parse_errors")
            and (not item.get("streaming") or item.get("semantic_terminal_seen"))
        ]
        hashes = [item.get("request_sha256") for item in records if item.get("request_sha256")]
        return {
            "request_count": len(records) + active,
            "completed_observations": len(records),
            "inflight_at_agent_exit": active,
            "observed_request_union_ms": union_ms(durations),
            "http_errors": sum(item["status"] is None or item["status"] >= 400 for item in records),
            "incomplete_transports": sum(not item["completed_transport"] for item in records),
            "client_disconnects_after_terminal": sum(
                not item["completed_transport"] and item.get("terminal_delivered_ms") is not None
                for item in records
            ),
            "identical_request_repeats": len(hashes) - len(set(hashes)),
            "usage_requests": len(complete_usage),
            "usage_coverage": len(complete_usage) / (len(records) + active)
            if records or active
            else None,
            "observed_usage": {
                key: sum(item["usage"][key] for item in records if key in item["usage"])
                if any(key in item["usage"] for item in records)
                else None
                for key in ("input_tokens", "output_tokens", "cached_input_tokens")
            },
            "timing_scope": "agent-container loopback observer to gateway; includes conversion, network and upstream latency",
            "retry_semantics": "identical request repeats are observed duplicates, not confirmed automatic retries",
        }
