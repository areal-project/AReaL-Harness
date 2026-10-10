"""对照现有 launcher 生命周期用例验证产品 Rust 入口。"""

import os
import json
import subprocess
from pathlib import Path

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
            self.skipTest("build target/debug/areal first")
        self.command = [str(executable), "launcher", *self.command[2:]]

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
