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

    def test_multiline_model_strings_ending_with_literal_quotes_do_not_hide_tables(self):
        for quote in ('"', "'"):
            for count in (4, 5):
                original = (
                    "schema_version=2\n[model]\nprompt="
                    + quote * 3
                    + "ends with quotes"
                    + quote * count
                    + "\n[trajectory]\nenabled=false\n"
                )
                updated = MODULE.replace_trajectory(original, {"enabled": True})
                self.assertEqual(tomllib.loads(updated)["model"], tomllib.loads(original)["model"])
                self.assertTrue(tomllib.loads(updated)["trajectory"]["enabled"])

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

    def test_environment_selected_file_is_updated_without_touching_default_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / "home"
            selected = Path(directory) / "selected.toml"
            selected.write_text(
                'schema_version = 2\n[model]\nname = "keep"\n[trajectory]\n'
                'enabled = true\nendpoint = "https://collector.example"\n'
            )
            code, stdout, _ = self.run_script(
                home, "--disable", environment={"AREAL_HARNESS_CONFIG": str(selected)}
            )
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(stdout)["config"], str(selected))
            self.assertFalse(tomllib.loads(selected.read_text())["trajectory"]["enabled"])
            self.assertEqual(tomllib.loads(selected.read_text())["model"]["name"], "keep")
            self.assertFalse((home / "config.toml").exists())

    def test_credential_rotation_preserves_enabled_and_does_not_force_a_shared_spool(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            config = home / "dedicated.toml"
            config.write_text(
                "schema_version=2\n[trajectory]\nenabled=true\n"
                'endpoint="https://collector.example"\n'
            )
            code, _, _ = self.run_script(
                home,
                "--config",
                str(config),
                "--headers-env",
                "HEADERS",
                environment={"HEADERS": "authorization=Bearer%20rotated"},
            )
            self.assertEqual(code, 0)
            values = tomllib.loads(config.read_text())["trajectory"]
            self.assertTrue(values["enabled"])
            self.assertNotIn("spool_dir", values)
            self.assertEqual(
                Path(values["headers_file"]).read_text(), "authorization=Bearer%20rotated"
            )
            self.assertEqual(self.run_script(home, "--config", str(config))[0], 0)
            self.assertTrue(tomllib.loads(config.read_text())["trajectory"]["enabled"])

    def test_explicit_queue_can_be_preserved_or_reset_to_configuration_scoped_default(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            config = home / "config.toml"
            config.write_text('schema_version=2\n[trajectory]\nspool_dir="relative-spool"\n')
            self.assertEqual(self.run_script(home, "--disable")[0], 0)
            self.assertEqual(
                tomllib.loads(config.read_text())["trajectory"]["spool_dir"], "relative-spool"
            )
            with patch.object(MODULE.subprocess, "run") as run:
                run.return_value.returncode = 0
                self.assertEqual(
                    self.run_script(home, "--default-spool", binary="/safe/areal")[0], 0
                )
            self.assertEqual(
                [call.args[0][2] for call in run.call_args_list], ["suspend", "sync-config"]
            )
            self.assertNotIn("spool_dir", tomllib.loads(config.read_text())["trajectory"])

    def test_destination_migration_stops_old_control_before_replacing_configuration_or_secrets(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            self.assertEqual(
                self.run_script(
                    home,
                    "--enable",
                    "--endpoint",
                    "https://old.example",
                    "--headers-env",
                    "HEADERS",
                    environment={"HEADERS": "authorization=old-token"},
                )[0],
                0,
            )
            config = home / "config.toml"
            original = config.read_text()
            old_credential = Path(tomllib.loads(original)["trajectory"]["headers_file"])
            calls = []

            def control(argv, **_kwargs):
                calls.append(argv[2])
                self.assertEqual(argv[-1], str(config))
                if argv[2] == "suspend":
                    self.assertEqual(config.read_text(), original)
                    self.assertEqual(list(old_credential.parent.iterdir()), [old_credential])
                else:
                    current = tomllib.loads(config.read_text())["trajectory"]
                    self.assertEqual(current["endpoint"], "https://new.example")
                    self.assertNotEqual(Path(current["headers_file"]), old_credential)
                    self.assertEqual(
                        Path(current["headers_file"]).read_text(), "authorization=new-token"
                    )
                self.assertEqual(old_credential.read_text(), "authorization=old-token")
                return MODULE.subprocess.CompletedProcess(argv, 0)

            with patch.object(MODULE.subprocess, "run", side_effect=control):
                code, _, _ = self.run_script(
                    home,
                    "--endpoint",
                    "https://new.example",
                    "--headers-env",
                    "HEADERS",
                    environment={"HEADERS": "authorization=new-token"},
                    binary="/safe/areal",
                )
            self.assertEqual(code, 0)
            self.assertEqual(calls, ["suspend", "sync-config"])

    def test_migration_failure_preserves_existing_configuration_and_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            config = home / "config.toml"
            original = (
                'schema_version=2\n[trajectory]\nenabled=true\nendpoint="https://old.example"\n'
            )
            config.write_text(original)
            for binary in (None, "/safe/areal"):
                with patch.object(MODULE.subprocess, "run") as run:
                    run.return_value.returncode = 1
                    code, _, stderr = self.run_script(
                        home, "--spool-dir", str(home / "next-spool"), binary=binary
                    )
                self.assertEqual(code, 1)
                self.assertIn("停止原队列", stderr)
                self.assertEqual(config.read_text(), original)
                self.assertFalse((home / "trajectory-credentials").exists())
                self.assertFalse((home / "config.toml.trajectory.bak").exists())

    def test_editor_change_during_control_transition_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            config = home / "config.toml"
            original = 'schema_version=2\n[model]\nname="old"\n[trajectory]\nendpoint="https://old.example"\n'
            config.write_text(original)
            edited = original.replace('name="old"', 'name="edited"')

            def control(argv, **_kwargs):
                config.write_text(edited)
                return MODULE.subprocess.CompletedProcess(argv, 0)

            with patch.object(MODULE.subprocess, "run", side_effect=control) as run:
                code, _, _ = self.run_script(
                    home, "--endpoint", "https://new.example", binary="/safe/areal"
                )
            self.assertEqual(code, 1)
            self.assertEqual(config.read_text(), edited)
            self.assertEqual(run.call_count, 1)

    def test_rejects_configuration_values_that_core_cannot_load_before_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            config = home / "config.toml"
            for field in ["spool_dir=17", 'headers_file=""', "headers_env=12", 'enabled="true"']:
                original = f"schema_version=2\n[trajectory]\n{field}\n"
                config.write_text(original)
                self.assertEqual(self.run_script(home)[0], 1, field)
                self.assertEqual(config.read_text(), original)
            config.write_text("schema_version=2\n")
            self.assertEqual(self.run_script(home, "--endpoint", "界" * 1500)[0], 1)
            self.assertEqual(config.read_text(), "schema_version=2\n")


if __name__ == "__main__":
    unittest.main()
