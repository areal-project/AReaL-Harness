"""Independent threaded RPC server and hidden case generator."""

from __future__ import annotations

import json
import select
import socketserver
import threading
import time


class State:
    def __init__(self):
        self.condition = threading.Condition()
        self.started = []
        self.active = 0
        self.max_active = 0

    def connection_open(self):
        with self.condition:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            self.condition.notify_all()

    def request_start(self, request_id):
        with self.condition:
            self.started.append(request_id)
            self.condition.notify_all()

    def connection_close(self):
        with self.condition:
            self.active -= 1
            self.condition.notify_all()

    def wait_started(self, count, timeout=3.0):
        deadline = time.monotonic() + timeout
        with self.condition:
            while len(self.started) < count and time.monotonic() < deadline:
                self.condition.wait(deadline - time.monotonic())
            return len(self.started) >= count

    def wait_idle(self, timeout=2.0):
        deadline = time.monotonic() + timeout
        with self.condition:
            while self.active and time.monotonic() < deadline:
                self.condition.wait(deadline - time.monotonic())
            return self.active == 0


class Handler(socketserver.StreamRequestHandler):
    def setup(self):
        super().setup()
        self.server.state.connection_open()

    def finish(self):
        try:
            super().finish()
        finally:
            self.server.state.connection_close()

    def handle(self):
        line = self.rfile.readline()
        if not line:
            return
        request = json.loads(line)
        state = self.server.state
        state.request_start(request["id"])
        try:
            payload = request["payload"]
            deadline = time.monotonic() + float(payload.get("delay_ms", 0)) / 1000
            disconnected = False
            while time.monotonic() < deadline:
                readable, _, _ = select.select([self.connection], [], [], min(0.01, deadline - time.monotonic()))
                if readable:
                    data = self.connection.recv(1, 0)
                    if data == b"":
                        disconnected = True
                        break
            if disconnected:
                return
            if payload.get("response_mode") == "invalid_json":
                self.wfile.write(b"{invalid\n")
                self.wfile.flush()
                return
            if payload.get("response_mode") == "wrong_shape":
                response = {"ok": True}
            elif payload.get("fail"):
                response = {"ok": False, "error": "hidden service rejection"}
            else:
                response = {"ok": True, "value": {"token": payload["token"], "request_id": request["id"]}}
            try:
                self.wfile.write(json.dumps(response, separators=(",", ":")).encode() + b"\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
        except (BrokenPipeError, ConnectionResetError):
            pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self):
        self.state = State()
        super().__init__(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)

    @property
    def port(self):
        return self.server_address[1]

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.shutdown()
        self.server_close()
        self.thread.join(timeout=2)


def requests_for(seed, count, delay_ms=90):
    prefix = "relay" if seed % 2 else "shard"
    return [
        {"id": f"{prefix}-{index:02d}", "payload": {"delay_ms": delay_ms + (index * 17 + seed) % 35, "token": f"v{seed}-{index}"}}
        for index in range(count)
    ]


def expected(requests):
    return [{"id": request["id"], "value": {"token": request["payload"]["token"], "request_id": request["id"]}} for request in requests]
