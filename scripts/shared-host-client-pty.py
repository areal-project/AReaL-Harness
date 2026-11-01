import errno
import fcntl
import json
import os
import runpy
import signal
import struct
import subprocess
import sys
import termios
import threading
from pathlib import Path

TerminalScreen = runpy.run_path(str(Path(__file__).with_name("terminal_screen.py")))[
    "TerminalScreen"
]
master, slave = os.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 150, 0, 0))


def terminal():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


child = subprocess.Popen(
    sys.argv[1:],
    stdin=slave,
    stdout=slave,
    stderr=slave,
    env={**os.environ, "TERM": "xterm-256color"},
    preexec_fn=terminal,
)
os.close(slave)
screen = TerminalScreen()
ready = threading.Condition()
raw = bytearray()


def consume():
    try:
        while chunk := os.read(master, 65536):
            with ready:
                raw.extend(chunk)
                del raw[:-262144]
                screen.feed(chunk)
                ready.notify_all()
    except OSError as error:
        if error.errno != errno.EIO:
            raise
    finally:
        with ready:
            ready.notify_all()


threading.Thread(target=consume, daemon=True).start()
print(json.dumps({"ready": True, "pid": child.pid}), flush=True)
try:
    for line in sys.stdin:
        request = json.loads(line)
        try:
            operation = request["operation"]
            if operation == "expect":
                text = request["text"].encode()
                with ready:
                    assert ready.wait_for(
                        lambda: text in screen.text(), timeout=request.get("timeout", 30)
                    ), f"missing {text!r}, exit={child.poll()}"
            elif operation == "send":
                os.write(master, request["text"].encode())
            elif operation == "kill":
                child.send_signal(signal.SIGKILL)
                child.wait(timeout=10)
            elif operation == "exit":
                os.write(master, b"\x11")
                assert child.wait(timeout=20) == 0
            else:
                raise ValueError(f"unknown operation {operation}")
            with ready:
                result = {
                    "id": request["id"],
                    "pid": child.pid,
                    "exit": child.poll(),
                    "screen": screen.text().decode(errors="replace"),
                }
        except Exception as error:
            with ready:
                result = {
                    "id": request["id"],
                    "error": str(error),
                    "exit": child.poll(),
                    "screen": screen.text().decode(errors="replace"),
                    "raw": raw.decode(errors="replace"),
                }
        print(json.dumps(result), flush=True)
finally:
    if child.poll() is None:
        child.kill()
        child.wait(timeout=10)
    os.close(master)
