"""验证终端 smoke 在等待子进程退出时持续读取 PTY。"""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "local-service-pty.py"


class LocalServicePtyTests(unittest.TestCase):
    def test_large_terminal_cleanup_does_not_block_exit(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Path(temporary) / "tui.py"
            fixture.write_text("""import os, tty
tty.setraw(0)
os.write(1, b'live')
prompt = bytearray()
while True:
    key = os.read(0, 1)
    if key == b'\\x11':
        # 超过 PTY 容量，确保只调用 wait() 会稳定超时。
        output = memoryview(b'x' * (2 * 1024 * 1024))
        while output:
            output = output[os.write(1, output):]
        break
    if key == b'\\r':
        os.write(1, b'reply:' + prompt)
        prompt.clear()
    else:
        prompt.extend(key)
""")
            result = subprocess.run(
                [sys.executable, "-I", "-S", str(SCRIPT), sys.executable, str(fixture)],
                env={
                    key: value for key, value in os.environ.items() if key != "TEST_EXPLICIT_STOP"
                },
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
