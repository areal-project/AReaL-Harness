import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    "launch", Path(__file__).resolve().parents[1] / "launch.py"
)
launch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launch)


class CoreArgumentsTest(unittest.TestCase):
    def test_tui_options_preserve_false_and_do_not_enter_core(self):
        args = argparse.Namespace(**dict.fromkeys((*launch.CORE_OPTIONS, *launch.TUI_OPTIONS)))
        args.theme = "light"
        args.color = "never"
        args.no_logo = "false"
        args.mouse = "false"
        args.tui_config = "/client config/tui.toml"
        self.assertEqual(launch.core_arguments(args), [])
        self.assertEqual(
            launch.tui_arguments(args),
            [
                "--theme=light",
                "--color=never",
                "--tui-config=/client config/tui.toml",
                "--no-logo=false",
                "--mouse=false",
            ],
        )

    def test_absent_values_are_not_promoted_to_cli_overrides(self):
        args = argparse.Namespace(**dict.fromkeys(launch.CORE_OPTIONS))
        self.assertEqual(launch.core_arguments(args), [])
        args.config = "config with spaces.toml"
        args.model = "explicit model"
        args.model_protocol = "responses"
        self.assertEqual(
            launch.core_arguments(args),
            [
                "--config",
                "config with spaces.toml",
                "--model",
                "explicit model",
                "--model-protocol",
                "responses",
            ],
        )

    def test_invalid_explicit_values_are_left_for_core_validation(self):
        args = argparse.Namespace(**dict.fromkeys(launch.CORE_OPTIONS))
        args.model = ""
        args.max_threads = "0"
        self.assertEqual(launch.core_arguments(args), ["--model", "", "--max-threads", "0"])

    def test_agent_limits_are_forwarded_without_changing_zero(self):
        args = argparse.Namespace(**dict.fromkeys(launch.CORE_OPTIONS))
        args.max_active_turns = "5"
        args.max_children_per_turn = "3"
        args.max_agent_depth = "0"
        self.assertEqual(
            launch.core_arguments(args),
            ["--max-active-turns", "5", "--max-children-per-turn", "3", "--max-agent-depth", "0"],
        )


class LauncherProcessTest(unittest.TestCase):
    def fixture(self, directory, invalid=False, linked=False, extra=()):
        root = Path(directory)
        (root / "workspace").mkdir()
        prefix = f"#!{sys.executable}\nimport json, os, sys\nfrom pathlib import Path\nroot=Path({str(root)!r})\n"
        server = (
            prefix
            + """
if sys.argv[1:3] == ['config', 'show']:
    (root/'preflight.json').write_text(json.dumps(sys.argv[1:]))
    if os.environ.get('INVALID_CONFIG'):
        sys.exit(2)
    print(json.dumps({'server': {'data_dir': str(root/'state')}, 'model': {'protocol': 'chat-completions'}}))
else:
    assert sys.argv[1] == 'app-server'
    (root/'core.json').write_text(json.dumps({'args': sys.argv[1:], 'key': os.environ.get('MODEL_KEY')}))
    Path(sys.argv[sys.argv.index('--ready-file')+1]).write_text('ws://127.0.0.1:12345')
    Path(sys.argv[sys.argv.index('--ready-metadata-file')+1]).write_text(json.dumps({'endpoint':'ws://127.0.0.1:12345','authFile':'/fixture/auth.json'}))
    import time
    time.sleep(0.2)
"""
        )
        runtime = (
            prefix
            + """
(root/'runtime.json').write_text(json.dumps({'has_key': 'MODEL_KEY' in os.environ, 'args': sys.argv[1:]}))
sys.stdin.buffer.read()
"""
        )
        for name, body in [
            ("areal", server),
            ("areal-runtime", runtime),
            ("areal-runtime-fs", prefix),
            ("areal-runtime-reaper", prefix),
        ]:
            p = root / name
            p.write_text(body)
            p.chmod(0o700)
        if linked:
            keg = root / "Cellar/areal/0.1.0"
            (keg / "bin").mkdir(parents=True)
            (keg / "libexec/areal").mkdir(parents=True)
            (root / "areal").rename(keg / "bin/areal")
            (root / "areal").symlink_to(keg / "bin/areal")
            for name in ["areal-runtime", "areal-runtime-fs", "areal-runtime-reaper"]:
                (root / name).rename(keg / "libexec/areal" / name)
        return subprocess.run(
            [
                sys.executable,
                str(Path(launch.__file__)),
                "--bin-dir",
                str(root),
                "--workspace",
                str(root / "workspace"),
                "--config",
                "selected.toml",
                "--model",
                "explicit",
                *extra,
            ],
            env={
                "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                "MODEL_KEY": "fixture-key",
                "AREAL_HARNESS_MODEL": "env-model",
                **({"INVALID_CONFIG": "1"} if invalid else {}),
            },
            text=True,
            capture_output=True,
            timeout=20,
        )

    def test_preflight_and_core_share_explicit_overrides_runtime_has_no_model_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.fixture(directory)
            self.assertEqual(result.returncode, 0, result.stderr)
            root = Path(directory)
            preflight = json.loads((root / "preflight.json").read_text())
            core = json.loads((root / "core.json").read_text())
            self.assertEqual(
                preflight, ["config", "show", "--config", "selected.toml", "--model", "explicit"]
            )
            self.assertNotIn("--data-dir", core["args"])
            self.assertNotIn("--model-endpoint", core["args"])
            self.assertNotIn("--listen", core["args"])
            self.assertEqual(core["key"], "fixture-key")
            self.assertFalse(json.loads((root / "runtime.json").read_text())["has_key"])

    def test_process_capacity_default_and_override_reach_runtime_only(self):
        for extra, expected in [((), "4"), (("--runtime-max-processes", "32"), "32")]:
            with self.subTest(expected=expected), tempfile.TemporaryDirectory() as directory:
                result = self.fixture(directory, extra=extra)
                self.assertEqual(result.returncode, 0, result.stderr)
                root = Path(directory)
                runtime = json.loads((root / "runtime.json").read_text())["args"]
                core = json.loads((root / "core.json").read_text())["args"]
                self.assertEqual(runtime[runtime.index("--max-processes") + 1], expected)
                self.assertNotIn("--cumulative-output-bytes", runtime)
                self.assertNotIn("--runtime-max-processes", core)
                self.assertNotIn("--max-processes", core)

    def test_cumulative_output_and_operations_are_independent(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.fixture(
                directory,
                extra=("--runtime-output-bytes", "1073741824", "--runtime-max-operations", "65536"),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            runtime = json.loads((Path(directory) / "runtime.json").read_text())["args"]
            self.assertEqual(runtime[runtime.index("--output-bytes") + 1], "8388608")
            self.assertEqual(runtime[runtime.index("--cumulative-output-bytes") + 1], "1073741824")
            self.assertEqual(runtime[runtime.index("--max-operations") + 1], "65536")
        for extra in (
            ("--runtime-output-bytes", "1"),
            ("--runtime-output-bytes", "17179869185"),
            ("--runtime-max-operations", "0"),
        ):
            with self.subTest(extra=extra), tempfile.TemporaryDirectory() as directory:
                result = self.fixture(directory, extra=extra)
                self.assertEqual(result.returncode, 2)
                self.assertFalse((Path(directory) / "runtime.json").exists())

    def test_invalid_process_capacity_starts_no_services(self):
        for value in ("0", "-1", "4294967296"):
            with self.subTest(value=value), tempfile.TemporaryDirectory() as directory:
                result = self.fixture(directory, extra=("--runtime-max-processes", value))
                self.assertEqual(result.returncode, 2)
                self.assertIn("runtime max processes", result.stderr)
                for name in ("preflight.json", "core.json", "runtime.json"):
                    self.assertFalse((Path(directory) / name).exists())

    def test_symlink_entry_resolves_helpers_inside_the_installed_keg(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.fixture(directory, linked=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((Path(directory) / "runtime.json").is_file())
            self.assertTrue((Path(directory) / "core.json").is_file())

    def test_failed_config_preflight_starts_no_services(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.fixture(directory, invalid=True)
            self.assertEqual(result.returncode, 2)
            self.assertFalse((Path(directory) / "core.json").exists())
            self.assertFalse((Path(directory) / "runtime.json").exists())


if __name__ == "__main__":
    unittest.main()
