"""一致性检查：文档里的反引号路径。"""

import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "check_references", ROOT / "scripts/check-references.py"
)
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)


class DocPathChecks(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="areal-references-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        self.enterContext(patch.object(checks, "ROOT", self.root))

    def test_missing_path_fails_but_gitignored_build_output_does_not(self):
        (self.root / ".gitignore").write_text("/services/app/generated/\n")
        (self.root / "AGENTS.md").write_text(
            "`services/app/generated/store.cjs`\n`scripts/gone.py`\n"
        )
        problems = checks.missing_doc_paths({"AGENTS.md", ".gitignore"})
        self.assertEqual(problems, ["AGENTS.md: 反引号路径不存在：scripts/gone.py"])


if __name__ == "__main__":
    unittest.main()
