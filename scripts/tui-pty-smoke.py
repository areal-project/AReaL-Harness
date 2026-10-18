"""Exercise the built full-screen TUI through a real POSIX terminal."""

import errno
import fcntl
import os
import re
import runpy
import select
import signal
import struct
import subprocess
import sys
import termios
import time
import tempfile
from pathlib import Path


TerminalScreen = runpy.run_path(str(Path(__file__).with_name("terminal_screen.py")))[
    "TerminalScreen"
]


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


def expect_trajectory_notice():
    if not os.environ.get("AREAL_PTY_EXPECT_TRAJECTORY"):
        return
    # 中文宽字符后有模拟器占位空格；核对当前画面，不靠历史输出证明仍可见。
    pattern = " ?".join("轨迹导出需要处理").encode()
    expect(pattern)
    rows = screen.text().splitlines()
    assert re.search(pattern, rows[1]), screen.text()
    assert len(re.findall(pattern, screen.text())) == 1, screen.text()


try:
    if os.environ.get("AREAL_PTY_INITIAL_PROMPT"):
        expect(rb"reply:pty-initial")
        expect(rb"Completed")
        os.write(master, b"/welcome\r")
    expect(rb"[a-f0-9]{8}-[a-f0-9]{4}-")
    root_id = re.search(rb"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9-]+", screen.text())[0]
    expect(rb"Welcome")
    expect_trajectory_notice()
    os.write(master, b"/theme\r")
    expect(rb"Preview.*Enter save")
    os.write(master, b"\x1b[B\r")
    expect(rb"Theme saved: Milk Tea Light")
    expect_trajectory_notice()
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
    # 验证终端按键解码与中间编辑后实际提交的文本，包括括号粘贴。
    os.write(master, b"Xpty-curor!\x01\x04\x05\x1b[D\x1b[3~")
    os.write(master, b"\x1b[D\x1b[D\x1b[D\x1b[C\x1b[200~s\x1b[201~\r")
    expect(rb"reply:pty-cursor")
    expect(rb"Completed")
    expect_trajectory_notice()
    os.write(master, "中👩‍💻文".encode() + b"\x1b[D\x7f\x01\x04\x05")
    os.write(master, b"\x1b[200~-unicode\x1b[201~\r")
    # 模拟器以终端单元格存储文本，中文后保留一个占位空格。
    expect("reply:文 -unicode".encode())
    expect(rb"Completed")
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
    expect_trajectory_notice()
    if os.environ.get("AREAL_PTY_TRACES"):
        os.write(master, b"trace-fixture\r")
        expect(rb"reply:trace-fixture")
        expect(rb"3 reads")
        assert b"PRIVATE_" not in screen.text()

        def click_row(row):
            os.write(master, f"\x1b[<0;3;{row + 1}M\x1b[<0;3;{row + 1}m".encode())

        group_row = next(i for i, row in enumerate(screen.text().splitlines()) if b"3 reads" in row)
        click_row(group_row)
        expect(rb"Tool.*fs_read")
        assert b"PRIVATE_" not in screen.text()
        tool_rows = [
            i
            for i, row in enumerate(screen.text().splitlines())
            if b"Tool" in row and b"fs_read" in row
        ]
        assert len(tool_rows) == 3, screen.text()
        click_row(tool_rows[1])
        expect(rb"PRIVATE_OUTPUT_1")
        assert b"PRIVATE_OUTPUT_0" not in screen.text()
        assert b"PRIVATE_OUTPUT_2" not in screen.text()
        os.write(master, b"\x1b[D\x1b[B\r")
        expect(rb"PRIVATE_OUTPUT_2")
        expect(rb"PRIVATE_OUTPUT_1", absent=True)
        os.write(master, b"\x1b[D")
        expect(rb"PRIVATE_OUTPUT_2", absent=True)
        os.write(master, b"\x1b")
        expect(rb"/: commands")
        os.write(master, b"\x1b[F")
        expect(rb"Read 100%.*LIVE")
        os.write(master, b"error-fixture\r")
        expect(rb"Turn failed")
        expect(rb"model HTTP status 400")
        expect_trajectory_notice()
        os.write(master, b"\x12")
        expect(rb"Reconnected")
        expect("Failed · live".encode())
        expect(rb"Turn failed")
        expect(rb"model HTTP status 400")
        expect_trajectory_notice()
    offset = len(output)
    os.write(master, b"hang\r")
    # 流式过程正文默认折叠；显式进入详细视图后才能看到。
    expect(rb"Waiting for model response")
    os.write(master, b"\x0f\x1b[F")
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
    expect_trajectory_notice()
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
    assert b"\x1b[?1000l" in output, "mouse capture was not disabled"
    if os.environ.get("AREAL_PTY_TRACES"):
        print(
            "PASS compact traces: hidden payloads, second-record mouse hit, third-record keyboard expansion, failure survives reconnect"
        )
    if os.environ.get("AREAL_PTY_EXPECT_TRAJECTORY"):
        print(
            "PASS owned trajectory notice: visible once in header alongside theme feedback, completed turns, reconnect, model failure and cancellation"
        )
    print(
        "PASS full-screen PTY: welcome, input cursor editing and Unicode deletion, slash completion, session/model pickers, theme persistence, long history, reconnect, topology, child navigation, resize, cancellation and terminal cleanup"
    )
finally:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGKILL)
    os.close(master)
    os.close(slave)
    child.wait(timeout=5)
    preferences.cleanup()
