import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    "navigation", Path(__file__).resolve().parents[2] / "core/engine/src/tools/navigation.py"
)
nav = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nav)


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
            result = nav.read_file(request)
            self.assertEqual(result["lines"], [{"number": 2, "text": "second\n"}])
            self.assertEqual(result["nextLine"], 3)
            self.assertFalse(result["eof"])
            self.assertEqual(result["sha256"], hashlib.sha256(content.encode()).hexdigest())
            request["offset"] = 3
            self.assertTrue(nav.read_file(request)["eof"])
            path.write_text("x" * 20000)
            request["offset"] = 1
            with self.assertRaisesRegex(ValueError, "single line"):
                nav.read_file(request)
            path.unlink()
            path.symlink_to("/etc/hosts")
            with self.assertRaisesRegex(ValueError, "symlink"):
                nav.read_file(request)

    def test_search_distinguishes_empty_invalid_and_limited(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "a.py").write_text("first\nneedle\nlast\nneedle\n")
            request = {
                "roots": {"repo": temp},
                "path": "workspace://repo",
                "pattern": "needle",
                "context": 1,
                "limit": 10,
            }
            result = nav.search_files(request)
            self.assertFalse(result["limited"])
            self.assertEqual([r["line"] for r in result["matches"] if r["kind"] == "match"], [2, 4])
            request["limit"] = 1
            self.assertTrue(nav.search_files(request)["limited"])
            request["pattern"] = "absent"
            self.assertEqual(nav.search_files(request)["matches"], [])
            request["pattern"] = "["
            with self.assertRaisesRegex(ValueError, "search failed"):
                nav.search_files(request)
