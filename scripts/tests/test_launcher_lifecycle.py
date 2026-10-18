#!/usr/bin/env python3
"""Launcher lifecycle regression tests using isolated executable fixtures."""

import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

LAUNCHER = Path(__file__).resolve().parents[1] / "launch.py"


class LauncherTests(unittest.TestCase):
    def setUp(self):
        # 真实服务使用 Unix socket；系统默认 TMPDIR 在 macOS 上可能超出路径长度上限。
        self.temporary = tempfile.TemporaryDirectory(
            prefix="areal-launch-test-", dir="/tmp" if os.name == "posix" else None
        )
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.data = self.root / "data"
        dispatcher = self.bin / "areal"
        dispatcher.write_text(
            f"#!{sys.executable}\nimport sys, json\nfrom pathlib import Path\n"
            + "if sys.argv[1:3] == ['config', 'show']:\n"
            + f"    print(json.dumps({{'server': {{'data_dir': {str(self.data)!r}}}, 'model': {{'protocol': 'chat-completions'}}}}))\n"
            + "    sys.exit(0)\n"
            + "mode = 'app-server' if sys.argv[1] == 'app-server' else 'interactive'\n"
            + "if mode == 'app-server': del sys.argv[1]\n"
            + f"exec((Path({str(self.root)!r}) / (mode + '.py')).read_text())\n"
        )
        dispatcher.chmod(0o755)
        self.children = []
        self.addCleanup(self.cleanup_children)
        self.fixture("areal-runtime", "sys.stdin.read()")
        self.fixture("areal-runtime-fs", "pass")
        self.fixture("areal-runtime-reaper", "pass")
        self.fixture(
            "app-server",
            """
args = sys.argv[1:]
if '--ready-file' in args:
    time.sleep(0.15)
    Path(args[args.index('--ready-file') + 1]).write_text('ws://127.0.0.1:12345')
if '--ready-metadata-file' in args:
    Path(args[args.index('--ready-metadata-file') + 1]).write_text(json.dumps({'authFile': '/fixture/auth.json', 'endpoint': 'ws://127.0.0.1:12345'}))
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
while True: time.sleep(0.02)
""",
        )
        self.fixture(
            "interactive",
            """
assert sys.argv[1:3] == ['--endpoint', 'ws://127.0.0.1:12345']
assert sys.argv[3:5] == ['--auth-file', '/fixture/auth.json']
assert sys.argv[5:] == ['--resume=thread-id', '--prompt=-hello with spaces']
print('fixture reply')
""",
        )
        self.command = [
            sys.executable,
            str(LAUNCHER),
            "--bin-dir",
            str(self.bin),
            "--workspace",
            str(self.workspace),
            "--data-dir",
            str(self.data),
            "--model",
            "fixture",
            "--model-endpoint",
            "http://127.0.0.1:1",
            "--tui",
            "--resume",
            "thread-id",
            "--prompt=-hello with spaces",
        ]

    def fixture(self, name, body):
        path = (
            self.root / (name + ".py") if name in ("app-server", "interactive") else self.bin / name
        )
        pid_file = self.root / (name + ".pid")
        path.write_text(
            f"#!{sys.executable}\nimport os, sys, time, signal, json\nfrom pathlib import Path\n"
            + f"Path({str(pid_file)!r}).write_text(str(os.getpid()))\n"
            + body
            + "\n"
        )
        path.chmod(0o755)

    def start(self, command=None):
        child = subprocess.Popen(
            command or self.command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.children.append(child)
        return child

    def cleanup_children(self):
        for child in self.children:
            if child.poll() is None:
                child.terminate()
                child.communicate(timeout=35)
        # A failed assertion must not leak the fixture processes either.
        for path in self.root.glob("*.pid"):
            try:
                os.kill(int(path.read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass

    def assert_reaped(self):
        for path in self.root.glob("*.pid"):
            with self.assertRaises(ProcessLookupError, msg=str(path)):
                os.kill(int(path.read_text()), 0)

    def wait_for(self, path, child):
        deadline = time.monotonic() + 5
        while not path.exists():
            self.assertIsNone(child.poll())
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.02)

    def test_local_success_forwards_args_and_reaps_services(self):
        child = self.start()
        out, err = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 0, err)
        self.assertEqual(out.strip(), "fixture reply")
        self.assertTrue(list(self.data.glob("launch-*.log")))
        self.assert_reaped()

    def test_startup_failure_reports_diagnostics_and_reaps_runtime(self):
        self.fixture(
            "app-server",
            "print('fixture startup failure', file=sys.stderr); sys.exit(7)",
        )
        child = self.start()
        _, err = child.communicate(timeout=10)
        self.assertNotEqual(child.returncode, 0)
        self.assertIn("fixture startup failure", err)
        self.assertFalse((self.root / "interactive.pid").exists())
        self.assert_reaped()

    def test_owned_interactive_prompt_is_forwarded_after_option_terminator(self):
        self.fixture("interactive", "assert sys.argv[-2:] == ['--', '-initial with spaces']")
        child = self.start([*self.command[:-1], "--initial-prompt=-initial with spaces"])
        _, err = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 0, err)
        self.assert_reaped()

    def test_client_failure_reaps_services(self):
        self.fixture("interactive", "sys.exit(3)")
        child = self.start()
        child.communicate(timeout=10)
        self.assertNotEqual(child.returncode, 0)
        self.assert_reaped()

    def test_signal_reaps_client_and_services(self):
        self.fixture("interactive", "while True: time.sleep(0.02)")
        child = self.start()
        self.wait_for(self.root / "interactive.pid", child)
        child.terminate()
        child.communicate(timeout=10)
        self.assert_reaped()

    def test_signal_during_startup_reaps_services(self):
        self.fixture("app-server", "while True: time.sleep(0.02)")
        child = self.start()
        self.wait_for(self.root / "app-server.pid", child)
        child.terminate()
        child.communicate(timeout=10)
        self.assertFalse((self.root / "interactive.pid").exists())
        self.assert_reaped()

    def test_explicit_server_mode_keeps_running_without_client(self):
        child = self.start(self.command[: self.command.index("--tui")])
        self.wait_for(self.root / "app-server.pid", child)
        time.sleep(0.1)
        self.assertIsNone(child.poll())
        self.assertFalse((self.root / "interactive.pid").exists())
        child.terminate()
        _, err = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 0, err)
        self.assert_reaped()

    def test_startup_cancellation_reaps_writer_before_removing_ready_directory(self):
        marker = self.root / "handler-installed"
        witness = self.root / "ready-directory-survived"
        self.fixture(
            "app-server",
            f"""
ready = Path(sys.argv[sys.argv.index('--ready-file') + 1])
def stop(*_):
    time.sleep(0.05)
    ready.write_text('late startup result')
    Path({str(witness)!r}).write_text('writer stopped before cleanup')
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
Path({str(marker)!r}).touch()
while True: time.sleep(0.02)
""",
        )
        child = self.start()
        self.wait_for(marker, child)
        child.terminate()
        _, err = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 0, err)
        self.assertTrue(witness.exists(), err)
        self.assert_reaped()


if __name__ == "__main__":
    unittest.main()
