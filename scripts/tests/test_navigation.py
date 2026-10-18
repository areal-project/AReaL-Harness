import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "navigation", ROOT / "core/engine/src/tools/navigation.py"
)
navigation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(navigation)


class NavigationTest(unittest.TestCase):
    def test_lines_unicode_hash_and_output_limit(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "code.py"
            content = "首行\nsecond\nthird\n"
            path.write_text(content)
            request = {
                "roots": {"repo": temp},
                "path": "workspace://repo/code.py",
                "offset": 2,
                "limit": 1,
            }
            result = navigation.read_file(request)
            self.assertEqual(result["lines"], [{"number": 2, "text": "second\n"}])
            self.assertEqual(result["nextLine"], 3)
            self.assertFalse(result["eof"])
            self.assertEqual(result["sha256"], hashlib.sha256(content.encode()).hexdigest())
            request["offset"] = 3
            self.assertTrue(navigation.read_file(request)["eof"])
            path.write_text("x" * 20000)
            request["offset"] = 1
            with self.assertRaisesRegex(ValueError, "single line"):
                navigation.read_file(request)
            path.unlink()
            path.symlink_to("/etc/hosts")
            with self.assertRaisesRegex(ValueError, "symlink"):
                navigation.read_file(request)
