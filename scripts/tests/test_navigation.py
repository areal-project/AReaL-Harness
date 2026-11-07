import hashlib
import importlib.util
import json
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
            result = navigation.read_file(request)
            self.assertFalse(result["lines"][0]["complete"])
            self.assertEqual(result["nextRead"]["offset"], 1)
            path.unlink()
            path.symlink_to("/etc/hosts")
            with self.assertRaisesRegex(ValueError, "symlink"):
                navigation.read_file(request)

    def test_long_json_fragments_are_exact_bounded_and_version_bound(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "data.json"
            content = json.dumps({"text": '中😀\t\\"' * 10000}, ensure_ascii=False) + "\r\nlast\n"
            path.write_bytes(content.encode())
            request = {"roots": {"repo": temp}, "path": "workspace://repo/data.json"}
            fragments = []
            seen = set()
            for _ in range(100):
                result = navigation.read_file(request)
                self.assertLessEqual(
                    len(json.dumps(result, ensure_ascii=False).encode()), navigation.LIMIT
                )
                fragments.extend(line["text"] for line in result["lines"])
                if result["eof"]:
                    break
                cursor = result.get(
                    "nextRead", {"path": request["path"], "offset": result["nextLine"]}
                )
                identity = (cursor["offset"], cursor.get("column", 1))
                self.assertNotIn(identity, seen)
                seen.add(identity)
                request = {"roots": {"repo": temp}, **cursor}
            else:
                self.fail("read did not converge")
            self.assertEqual("".join(fragments), content)
            first = navigation.read_file({"roots": {"repo": temp}, "path": request["path"]})
            path.write_text("changed")
            with self.assertRaisesRegex(ValueError, "file changed"):
                navigation.read_file({"roots": {"repo": temp}, **first["nextRead"]})
