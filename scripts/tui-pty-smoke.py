"""Exercise the built full-screen TUI through a real POSIX terminal."""

import errno
import codecs
import fcntl
import os
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time
import unicodedata
import tempfile
from pathlib import Path


class TerminalScreen:
    """Apply the cursor/erase commands emitted by Crossterm before matching text."""

    def __init__(self, rows=40, columns=150):
        self.rows, self.columns = rows, columns
        self.cells = [[" "] * columns for _ in range(rows)]
        self.row = self.column = 0
        self.pending = ""
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")

    def feed(self, data):
        self.pending += self.decoder.decode(data)
        index = 0
        while index < len(self.pending):
            char = self.pending[index]
            if char == "\x1b":
                if index + 1 == len(self.pending):
                    break
                if self.pending[index + 1] == "[":
                    match = re.match(r"\x1b\[([0-?]*)([ -/]*)([@-~])", self.pending[index:])
                    if not match:
                        break
                    params, _, command = match.groups()
                    if params == "?1049" and command == "h":
                        self.cells = [[" "] * self.columns for _ in range(self.rows)]
                        self.row = self.column = 0
                    values = (
                        [int(value or 0) for value in params.split(";")]
                        if not params.startswith("?")
                        else []
                    )
                    amount = (values[0] if values else 0) or 1
                    if command in ("H", "f"):
                        self.row = amount - 1
                        self.column = ((values[1] if len(values) > 1 else 0) or 1) - 1
                    elif command == "A":
                        self.row -= amount
                    elif command == "B":
                        self.row += amount
                    elif command == "C":
                        self.column += amount
                    elif command == "D":
                        self.column -= amount
                    elif command == "G":
                        self.column = amount - 1
                    elif command == "d":
                        self.row = amount - 1
                    elif command == "J" and values and values[0] == 2:
                        self.cells = [[" "] * self.columns for _ in range(self.rows)]
                    elif command == "K":
                        mode = values[0] if values else 0
                        start = self.column if mode == 0 else 0
                        end = self.column + 1 if mode == 1 else self.columns
                        self.cells[self.row][start:end] = [" "] * (end - start)
                    self.row = max(0, min(self.rows - 1, self.row))
                    self.column = max(0, min(self.columns - 1, self.column))
                    index += len(match.group())
                    continue
                index += 2
                continue
            if char == "\r":
                self.column = 0
            elif char == "\n":
                self.row = min(self.row + 1, self.rows - 1)
            elif char == "\b":
                self.column = max(0, self.column - 1)
            elif char >= " " and not unicodedata.combining(char):
                if self.column >= self.columns:
                    self.column = 0
                    self.row = min(self.row + 1, self.rows - 1)
                self.cells[self.row][self.column] = char
                self.column += 2 if unicodedata.east_asian_width(char) in ("W", "F") else 1
            index += 1
        self.pending = self.pending[index:]

    def text(self):
        return "\n".join("".join(row) for row in self.cells).encode()


# An unchanged character is absent from the diff stream but remains on screen.
fixture = TerminalScreen(2, 40)
fixture.feed(b"Connecting\x1b[1;1H47fa\x1b[1C77e-4199-")
assert b"47fae77e-4199-" in fixture.text()


master, slave = os.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 150, 0, 0))


def controlling_terminal():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


# Keep a session leader alive while checking the terminal after the TUI exits.
# macOS revokes the slave terminal when its session leader exits.
wrapper = """
import subprocess, sys, termios
code = subprocess.call(sys.argv[1:])
assert termios.tcgetattr(0)[3] & termios.ICANON, 'TUI left the terminal in raw mode'
sys.exit(code)
"""
preferences = tempfile.TemporaryDirectory(prefix="areal-tui-preferences-")
child = subprocess.Popen(
    [
        sys.executable,
        "-I",
        "-S",
        "-c",
        wrapper,
        sys.argv[1],
        *(["--endpoint", sys.argv[2]] if len(sys.argv) == 3 else sys.argv[2:]),
    ],
    stdin=slave,
    stdout=slave,
    stderr=slave,
    env={
        **{key: value for key, value in os.environ.items() if not key.startswith("AREAL_TUI_")},
        "TERM": "xterm-256color",
        "XDG_CONFIG_HOME": preferences.name,
    },
    preexec_fn=controlling_terminal,
)
output = bytearray()
screen = TerminalScreen()


def record(chunk):
    output.extend(chunk)
    screen.feed(chunk)


def expect(pattern, offset=0, raw=False, absent=False):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if bool(re.search(pattern, output[offset:] if raw else screen.text())) != absent:
            return
        if select.select([master], [], [], 0.1)[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""
            if not chunk:
                break
            record(chunk)
        elif child.poll() is not None:
            break
    raise AssertionError(
        f"TUI did not display {pattern!r}; exit={child.poll()}, screen={screen.text()!r}"
    )


try:
    expect(rb"[a-f0-9]{8}-[a-f0-9]{4}-")
    root_id = re.search(rb"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9-]+", screen.text())[0]
    expect(rb"Welcome")
    os.write(master, b"/theme\r")
    expect(rb"Preview.*Enter save")
    os.write(master, b"\x1b[B\r")
    expect(rb"Theme saved: Milk Tea Light")
    assert 'theme = "light"' in (Path(preferences.name) / "areal-harness/tui.toml").read_text()
    # Slash 补全、会话弹窗和模型弹窗都不能把命令作为用户消息发送。
    os.write(master, b"/ses")
    expect(rb"Commands.*Tab complete")
    os.write(master, b"\t\r")
    expect(rb"Sessions.*Enter switch")
    os.write(master, root_id)
    expect(rb"Filter: " + root_id)
    os.write(master, b"\r")
    expect(rb"Conversation.*" + root_id[:8])
    os.write(master, b"draft\x1b[15~")  # F5 保留草稿，粘贴只进入筛选框。
    expect(rb"Sessions.*Enter switch")
    os.write(master, b"\x1b[200~missing-session\x1b[201~")
    expect(rb"No matches")
    os.write(master, b"\x1b")
    expect(rb"Sessions.*Enter switch", absent=True)
    expect(rb"draft")
    os.write(master, b"\x7f" * 5)
    os.write(master, b"/model\r")
    expect(rb"Models.*Enter apply")
    expect(rb"Default")
    if os.environ.get("AREAL_PTY_MODEL_SWITCH"):
        expect(rb"pty / alternate")
        os.write(master, b"alternate\r")
        expect(rb"Model changed: pty / alternate")
        os.write(master, b"switched-model\r")
        expect(rb"reply:switched-model")
        expect(rb"Completed")
        os.write(master, b"/model\r")
        expect(rb"Models.*Enter apply")
        os.write(master, b"\r")
        expect(rb"Model changed: test")
        os.write(master, b"reset-model\r")
        expect(rb"reply:reset-model")
        expect(rb"Completed")
    else:
        os.write(master, b"\x1b")
        expect(rb"Models.*Enter apply", absent=True)
    offset = len(output)
    os.write(master, b"pty-hello\r")
    expect(rb"reply:pty-hello", offset)
    expect(rb"Completed", offset)
    # 在真实 PTY 中覆盖超过一屏的历史与回到尾部，避免仅验证布局函数。
    long_prompt = " ".join(f"history-{i:04}" for i in range(600)).encode()
    os.write(master, b"\x1b[200~" + long_prompt + b"\x1b[201~\r")
    expect(rb"0599")
    expect(rb"Completed")
    os.write(master, b"\x1b[5~")
    expect(rb"Browsing")
    os.write(master, b"\x1b[F")
    expect(rb"Read 100%.*LIVE")
    # 重连不能重新提交最后一条用户消息，且仍可恢复历史和输入。
    os.write(master, b"\x12")
    expect(rb"Reconnected")
    # 连接恢复后还需等权威快照；旧历史仍在屏幕上，不能作为可发送的信号。
    expect("Completed · live".encode())
    expect(rb"0599")
    offset = len(output)
    os.write(master, b"hang\r")
    expect(rb"reply:hang", offset)
    os.write(master, b"/spawn pty-child\r")
    os.write(master, b"/topology\r")
    expect(rb"Agents.*session tree")
    expect(rb"pty-child")
    os.write(master, b"\x1b[B\r")
    expect(rb"reply:pty-child")
    os.write(master, b"/open " + root_id + b"\r")
    expect(rb"reply:hang")
    os.write(master, b"\x03")  # Ctrl-C is a TUI key, not a process signal in raw mode.
    expect(rb"Interrupted", offset)
    # resize 后进入单栏仍能操作，终端模拟器同步使用新的行列数。
    screen = TerminalScreen(24, 60)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 60, 0, 0))
    os.killpg(child.pid, signal.SIGWINCH)
    expect(rb"AReaL-Harness")
    offset = len(output)
    os.write(master, b"\x11")
    expect(rb"\x1b\[\?1049l", offset, raw=True)
    deadline = time.monotonic() + 5
    while child.poll() is None and time.monotonic() < deadline:
        if select.select([master], [], [], 0.1)[0]:
            record(os.read(master, 65536))
    assert child.wait(timeout=5) == 0
    # The terminal must leave raw mode and the alternate screen on normal exit.
    while select.select([master], [], [], 0)[0]:
        chunk = os.read(master, 65536)
        if not chunk:
            break
        record(chunk)
    assert b"\x1b[?1049l" in output
    print(
        "PASS full-screen PTY: welcome, slash completion, session/model pickers, theme persistence, long history, reconnect, topology, child navigation, resize, cancellation and terminal cleanup"
    )
finally:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGKILL)
    os.close(master)
    os.close(slave)
    child.wait(timeout=5)
    preferences.cleanup()
