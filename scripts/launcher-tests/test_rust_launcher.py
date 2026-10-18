"""对照现有 launcher 生命周期用例验证产品 Rust 入口。"""

import os
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))
import test_launcher_lifecycle as legacy


class RustLauncherTests(legacy.LauncherTests):
    def setUp(self):
        super().setUp()
        executable = Path(
            os.environ.get(
                "AREAL_TEST_BIN", Path(__file__).resolve().parents[2] / "target/debug/areal"
            )
        )
        if not executable.is_file():
            self.fail(f"missing launcher binary: {executable}; run make build first")
        self.command = [str(executable), "launcher", *self.command[2:]]
        # Rust launcher 只给自己创建的最终 TUI 标记本地队列检查来源。
        self.fixture(
            "interactive",
            """
assert sys.argv[1] == '--local-trajectory-monitor'
assert sys.argv[2:4] == ['--endpoint', 'ws://127.0.0.1:12345']
assert sys.argv[4:6] == ['--auth-file', '/fixture/auth.json']
assert sys.argv[6:] == ['--resume=thread-id', '--prompt=-hello with spaces']
print('fixture reply')
""",
        )

    def test_preflight_reports_exit_status_and_empty_stderr(self):
        dispatcher = self.bin / "areal"
        for body, expected in [
            ("sys.exit(7)", "exit status: 7"),
            ("os.kill(os.getpid(), signal.SIGKILL)", "signal: 9"),
        ]:
            with self.subTest(expected=expected):
                dispatcher.write_text(f"#!{sys.executable}\nimport os, signal, sys\n{body}\n")
                result = subprocess.run(self.command, text=True, capture_output=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Core configuration failed (", result.stderr)
                self.assertIn(expected, result.stderr)
                self.assertIn("<no stderr>", result.stderr)

    def test_starts_without_python_on_path(self):
        # 测试子进程使用绝对 shebang；此处验证产品 launcher 不查找 Python。
        child = subprocess.Popen(
            self.command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env={**os.environ, "PATH": "/nonexistent"},
        )
        self.children.append(child)
        out, err = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 0, err)
        self.assertIn("fixture reply", out)
        self.assert_reaped()

    def test_real_shared_service_without_python_on_path(self):
        executable = Path(self.command[0])
        config = self.root / "empty.toml"
        config.write_text("schema_version = 1\n")
        env = {
            **os.environ,
            "AREAL_HARNESS_HOME": str(self.root / "home"),
            "HOME": str(self.root / "user"),
            "PATH": "/nonexistent",
            "OTEL_SDK_DISABLED": "true",
        }
        base = [str(executable), "service"]
        started = subprocess.run(
            [
                *base,
                "ensure",
                "--json",
                "--workspace",
                str(self.workspace),
                "--config",
                str(config),
            ],
            env=env,
            text=True,
            capture_output=True,
            timeout=90,
        )
        self.assertEqual(started.returncode, 0, started.stderr)
        service = json.loads(started.stdout)
        try:
            self.assertEqual(service["state"], "ready")
            self.assertEqual(service["workspace"], str(self.workspace.resolve()))
        finally:
            stopped = subprocess.run(
                [*base, "stop", "--instance", service["serviceId"], "--cancel", "--json"],
                env=env,
                text=True,
                capture_output=True,
                timeout=60,
            )
            self.assertEqual(stopped.returncode, 0, stopped.stderr)


if __name__ == "__main__":
    import unittest

    unittest.main()
