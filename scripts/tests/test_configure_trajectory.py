import contextlib
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import tomllib
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "configure-trajectory.py"
SPEC = importlib.util.spec_from_file_location("configure_trajectory", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ConfigureTrajectoryTests(unittest.TestCase):
    def run_script(self, home, *arguments, environment=None, binary=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        with (
            patch.dict(os.environ, environment or {}, clear=True),
            patch.object(MODULE.shutil, "which", return_value=binary),
            contextlib.redirect_stdout(stdout),
            contextlib.redirect_stderr(stderr),
        ):
            code = MODULE.main(["--home", str(home), *arguments])
        return code, stdout.getvalue(), stderr.getvalue()

    def test_isolated_enable_preserves_model_comments_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            config = home / "config.toml"
            old = (
                'schema_version = 2\n# preserve me\n[model]\nname = "fixture"\n'
                '[model.providers.fixture]\nendpoint = "https://model.example/v1"\n'
            )
            config.write_text(old)
            code, stdout, _ = self.run_script(
                home, "--enable", "--endpoint", "https://collector.example"
            )
            self.assertEqual(code, 0)
            self.assertTrue(json.loads(stdout)["changed"])
            updated = config.read_text()
            self.assertTrue(updated.startswith(old.rstrip()))
            self.assertEqual(tomllib.loads(updated)["model"], tomllib.loads(old)["model"])
            self.assertEqual((home / "config.toml.trajectory.bak").read_text(), old)
            before = config.stat().st_mtime_ns
            code, stdout, _ = self.run_script(home, "--enable")
            self.assertEqual(code, 0)
            self.assertFalse(json.loads(stdout)["changed"])
            self.assertEqual(config.stat().st_mtime_ns, before)
            self.assertEqual(config.stat().st_mode & 0o777, 0o600)

    def test_credentials_persist_privately_without_leaking_into_configuration_or_output(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            secret = "authorization=Bearer%20private-secret"
            code, stdout, stderr = self.run_script(
                home,
                "--enable",
                "--endpoint",
                "https://collector.example",
                "--headers-env",
                "EXPORT_HEADERS",
                environment={"EXPORT_HEADERS": secret},
            )
            self.assertEqual(code, 0)
            text = (home / "config.toml").read_text()
            self.assertNotIn(secret, text + stdout + stderr)
            credential = Path(tomllib.loads(text)["trajectory"]["headers_file"])
            self.assertEqual(credential.read_text().strip(), secret)
            self.assertEqual(credential.stat().st_mode & 0o777, 0o600)
            self.assertEqual(credential.parent.stat().st_mode & 0o777, 0o700)
            rotated = "authorization=Bearer%20rotated-secret"
            code, stdout, stderr = self.run_script(
                home,
                "--enable",
                "--headers-env",
                "EXPORT_HEADERS",
                environment={"EXPORT_HEADERS": rotated},
            )
            self.assertEqual(code, 0)
            self.assertNotIn(rotated, stdout + stderr)
            self.assertEqual(
                tomllib.loads((home / "config.toml").read_text())["trajectory"]["headers_file"],
                str(credential),
            )
            self.assertEqual(credential.read_text(), rotated)
            code, _, _ = self.run_script(home, "--disable")
            self.assertEqual(code, 0)
            self.assertFalse(
                tomllib.loads((home / "config.toml").read_text())["trajectory"]["enabled"]
            )

    def test_quoted_headers_and_multiline_model_content_are_preserved(self):
        original = '''schema_version = 2
[model]
instruction = """
[trajectory]
enabled = false
"""
["trajectory"]
enabled = false
endpoint = "https://old.example"
[permissions]
mode = "YOLO"
'''
        updated = MODULE.replace_trajectory(
            original, {"enabled": True, "endpoint": "https://new.example"}
        )
        parsed = tomllib.loads(updated)
        self.assertEqual(parsed["model"], tomllib.loads(original)["model"])
        self.assertEqual(parsed["permissions"]["mode"], "YOLO")
        self.assertEqual(parsed["trajectory"]["endpoint"], "https://new.example")

    def test_malformed_or_symlink_configuration_is_not_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            config = home / "config.toml"
            config.write_text("not valid TOML")
            self.assertEqual(self.run_script(home, "--disable")[0], 1)
            self.assertEqual(config.read_text(), "not valid TOML")
            config.unlink()
            other = home / "other.toml"
            other.write_text("schema_version = 2\n")
            config.symlink_to(other)
            self.assertEqual(self.run_script(home, "--disable")[0], 1)
            self.assertTrue(config.is_symlink())
            self.assertEqual(other.read_text(), "schema_version = 2\n")

    def test_sync_control_uses_fixed_argv_and_private_home(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            with patch.object(MODULE.subprocess, "run") as run:
                run.return_value.returncode = 0
                code, stdout, _ = self.run_script(home, "--disable", binary="/safe/areal")
            self.assertEqual(code, 0)
            self.assertTrue(json.loads(stdout)["controlApplied"])
            args, kwargs = run.call_args
            self.assertEqual(
                args[0],
                ["/safe/areal", "trajectory", "sync-config", "--config", str(home / "config.toml")],
            )
            self.assertEqual(kwargs["env"]["AREAL_HARNESS_HOME"], str(home))
            self.assertFalse(kwargs.get("shell", False))

    def test_fifo_configuration_is_rejected_without_waiting_for_a_writer(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            os.mkfifo(home / "config.toml")
            self.assertEqual(self.run_script(home, "--disable")[0], 1)

    def test_model_configuration_lock_prevents_concurrent_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            config = home / "config.toml"
            original = 'schema_version = 2\n[model]\nname = "keep"\n'
            config.write_text(original)
            with (home / ".config.toml.lock").open("w") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.assertEqual(self.run_script(home, "--disable")[0], 1)
            self.assertEqual(config.read_text(), original)

    def test_invalid_limits_never_replace_existing_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            config = home / "config.toml"
            original = "schema_version = 2\n"
            config.write_text(original)
            for arguments in [
                ("--max-retries", "101"),
                ("--max-disk-bytes", "1"),
                ("--retry-max-seconds", "1"),
            ]:
                self.assertEqual(self.run_script(home, "--disable", *arguments)[0], 1)
                self.assertEqual(config.read_text(), original)


if __name__ == "__main__":
    unittest.main()
