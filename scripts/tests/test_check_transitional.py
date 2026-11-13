"""过渡代码检查：未标期限只减不增，到期报错。"""

import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "check_transitional", ROOT / "scripts/check-transitional.py"
)
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)


class TransitionalChecks(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="areal-transitional-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        (self.root / "Cargo.toml").write_text('[workspace.package]\nversion = "0.2.0"\n')
        self.enterContext(patch.object(checks, "ROOT", self.root))
        self.enterContext(patch.object(checks, "BASELINE", self.root / "baseline.json"))

    def run_check(self, source, baseline=None):
        (self.root / "core").mkdir(exist_ok=True)
        (self.root / "core/read.rs").write_text(source)
        if baseline is not None:
            (self.root / "baseline.json").write_text(json.dumps(baseline))
        with patch("builtins.print"):
            return checks.main()

    def test_business_words_and_vendored_bundles_are_not_transitional(self):
        source = "const coreIncompatible = true;\nconst compatibility = 1;\n"
        self.assertEqual(self.run_check(source, {}), 0)
        self.assertEqual(self.run_check("fn compat_read() {}\n", {}), 1)
        (self.root / "core/vendor").mkdir(parents=True)
        (self.root / "core/vendor/lib.js").write_text("var legacy = 1;\n")
        (self.root / "core/app.min.js").write_text("var legacy = 1;\n")
        self.assertEqual(self.run_check("", {}), 0)

    def test_unmarked_legacy_name_beyond_baseline_fails(self):
        self.assertEqual(self.run_check("fn legacy_read() {}\n", {}), 1)
        self.assertEqual(self.run_check("fn legacy_read() {}\n", {"core/read.rs": 1}), 0)

    def test_marked_name_passes_until_its_version(self):
        self.assertEqual(self.run_check("// 过渡：到 0.3.0 删\nfn legacy_read() {}\n", {}), 0)
        self.assertEqual(self.run_check("// 过渡：到 0.2.0 删\nfn legacy_read() {}\n", {}), 1)

    def test_shrunk_baseline_must_be_tightened(self):
        self.assertEqual(self.run_check("fn read() {}\n", {"core/read.rs": 2}), 1)


if __name__ == "__main__":
    unittest.main()
