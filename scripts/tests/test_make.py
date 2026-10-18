import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class MakeArgumentsTest(unittest.TestCase):
    def test_dash_arguments_fail_before_build_or_launch(self):
        result = subprocess.run(
            ["make", "-n", "tui", "--", "--prompt", "hello"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("make tui ARGS='--prompt hello'", result.stderr)
        self.assertNotIn("cargo", result.stdout)

    def test_args_variable_is_forwarded(self):
        result = subprocess.run(
            ["make", "-n", "tui", "ARGS=--prompt hello"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("cargo run --locked -p areal-cli -- --prompt hello", result.stdout)


if __name__ == "__main__":
    unittest.main()
