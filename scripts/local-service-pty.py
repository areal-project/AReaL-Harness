"""通过两个真实终端验证共享服务不随窗口退出。"""

import errno
import fcntl
import json
import os
import re
import runpy
import struct
import subprocess
import sys
import termios
import threading
import time
from pathlib import Path

TerminalScreen = runpy.run_path(str(Path(__file__).with_name("terminal_screen.py")))[
    "TerminalScreen"
]

windows = []


def window():
    master, slave = os.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 150, 0, 0))
    child = subprocess.Popen(
        sys.argv[1:],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env={**os.environ, "TERM": "xterm-256color"},
        start_new_session=True,
    )
    os.close(slave)
    output = bytearray()
    ready = threading.Condition()
    screen = TerminalScreen()
    item = (master, child, output, ready, screen)
    windows.append(item)

    def read_output():
        # PTY 与真实终端一样持续消费输出；等待退出或执行 CLI 时也不能阻塞重绘。
        try:
            while chunk := os.read(master, 65536):
                with ready:
                    output.extend(chunk)
                    del output[:-262144]
                    screen.feed(chunk)
                    ready.notify_all()
        except OSError as error:
            if error.errno != errno.EIO:
                raise

    threading.Thread(target=read_output, daemon=True).start()
    return item


def expect(item, text):
    _, child, _, ready, screen = item

    with ready:
        if ready.wait_for(lambda: text in screen.text(), timeout=20):
            return
        raise AssertionError(f"missing {text!r}, exit={child.poll()}, screen={screen.text()!r}")


try:
    first, second = window(), window()
    # Welcome 先于 thread/start 完成；等待实际订阅后再发送输入。
    expect(first, b"live")
    expect(second, b"live")
    # 强杀一个窗口，另一个窗口仍能提交模型请求。
    first[1].kill()
    first[1].wait(timeout=5)
    os.write(second[0], b"window-survives\r")
    expect(second, b"reply:window-survives")
    if config_path := os.environ.get("TEST_RELOAD_CONFIG"):
        binary = str(Path(sys.argv[1]).with_name("areal"))
        before = json.loads(
            subprocess.check_output([binary, "service", "ensure", *sys.argv[2:]], text=True)
        )
        config = Path(config_path)
        changed = re.sub(
            r'^name = "[^"\n]*"$',
            'name = "fixture-pty"',
            config.read_text(),
            count=1,
            flags=re.MULTILINE,
        )
        pending = config.with_suffix(".pending")
        pending.write_text(changed)
        pending.replace(config)
        # 状态通知可在绘制前被后续响应覆盖；标题中的模型名称会持续反映热更新结果。
        expect(second, b"fixture-pty")
        after = json.loads(
            subprocess.check_output([binary, "service", "ensure", *sys.argv[2:]], text=True)
        )
        assert after["generation"] == before["generation"]
        # 文件限额变化由仍打开的 TUI 等待空闲后重启，并重建已有会话快照。
        changed, count = re.subn(
            r"^max_threads = \d+$", "max_threads = 1235", changed, count=1, flags=re.MULTILINE
        )
        assert count == 1
        with second[3]:
            second[2].clear()
            second[4].clear()
        pending.write_text(changed)
        pending.replace(config)
        # 重连提示可能在绘制前被会话快照覆盖；检查只读状态及恢复后的实际请求。
        end = time.monotonic() + 30
        while True:
            result = subprocess.run(
                [binary, "service", "status", "--instance", before["serviceId"]],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode == 0:
                after = json.loads(result.stdout)
                if after["state"] == "ready" and after["generation"] != before["generation"]:
                    break
            assert time.monotonic() < end, result.stderr
            time.sleep(0.1)
        expect(second, b"live")
        os.write(second[0], b"after-config-restart\r")
        expect(second, b"reply:after-config-restart")
    if os.environ.get("TEST_EXPLICIT_STOP"):
        binary = str(Path(sys.argv[1]).with_name("areal"))
        descriptor = json.loads(
            subprocess.check_output([binary, "service", "ensure", *sys.argv[2:]], text=True)
        )
        command = [binary, "service", "stop", "--instance", descriptor["serviceId"]]
        end = time.monotonic() + 10
        while True:
            result = subprocess.run(command, capture_output=True, text=True)
            if result.returncode == 0:
                break
            assert "service is busy" in result.stderr and time.monotonic() < end, result.stderr
            time.sleep(0.05)
        # 留出多个自动重连周期，确认打开的窗口不会撤销显式停止。
        time.sleep(3)
        state = json.loads(
            subprocess.check_output(
                [binary, "service", "status", "--instance", descriptor["serviceId"]], text=True
            )
        )
        assert state["state"] == "stopped", state
    os.write(second[0], b"\x11")
    try:
        assert second[1].wait(timeout=20) == 0
    except subprocess.TimeoutExpired as error:
        raise AssertionError(f"TUI did not exit after Ctrl-Q: {second[4].text()!r}") from error
finally:
    for master, child, _, _, _ in windows:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)
        os.close(master)
