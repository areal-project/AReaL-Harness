"""Rust 文件体积检查只发出优化信号，不阻断快检。"""

import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "check_rust_size", ROOT / "scripts/check-rust-size.py"
)
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class RustSizeSignal(unittest.TestCase):
    def test_report_marks_guideline_and_growth_without_declaring_failure(self):
        with tempfile.TemporaryDirectory(prefix="areal-rust-size-") as directory:
            root = Path(directory)
            (root / "src").mkdir()
            (root / "tests").mkdir()
            (root / "src/large.rs").write_text("line\n" * 1601)
            (root / "src/stable.rs").write_text("line\n" * 1500)
            (root / "tests/ignored.rs").write_text("line\n" * 3000)
            baseline = root / "baseline.json"
            baseline.write_text(json.dumps({"src/large.rs": 1600, "src/stable.rs": 1500}))

            with patch.object(
                check,
                "sizes",
                return_value={"src/large.rs": 1601, "src/stable.rs": 1500},
            ):
                signal = check.report(root, baseline)

            self.assertEqual(signal["status"], "advisory")
            self.assertEqual(signal["summary"]["aboveGuideline"], 1)
            self.assertEqual(signal["summary"]["grewSinceBaseline"], 1)
            self.assertEqual(
                signal["findings"][0]["reasons"], ["aboveGuideline", "grewSinceBaseline"]
            )

    def test_main_returns_success_and_emits_machine_readable_signal(self):
        signal = {
            "kind": "agent-optimization-signal",
            "signal": "rust-file-size",
            "status": "advisory",
            "findings": [{"path": "core/host/src/vault.rs"}],
        }
        output = io.StringIO()
        with patch.object(check, "report", return_value=signal), redirect_stdout(output):
            self.assertEqual(check.main([]), 0)
        prefix, payload = output.getvalue().strip().split(" ", 1)
        self.assertEqual(prefix, "AGENT_OPTIMIZATION_SIGNAL")
        self.assertEqual(json.loads(payload), signal)


if __name__ == "__main__":
    unittest.main()
