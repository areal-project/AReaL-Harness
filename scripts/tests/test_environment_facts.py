"""环境事实的范围、失效与验证收据边界。"""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"core/engine/src/tools/{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


environment = load("environment")
verification = load("verification")


class EnvironmentFactsTests(unittest.TestCase):
    def test_negative_scope_and_declaration_invalidation(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            (root / "nested").mkdir()
            (root / "nested/package.json").write_text('{"scripts":{"test":"do-not-run"}}')
            request = {"roots": {"repo": path}, "executables": []}
            original = environment.discover(request)
            self.assertEqual(original["declarations"], [])
            self.assertNotIn(str(root / "nested/package.json"), original["absentDeclarations"])
            self.assertEqual(original["fingerprint"], environment.discover(request)["fingerprint"])
            (root / "pytest.ini").write_text("[pytest]\ntestpaths = tests\n")
            changed = environment.discover(request)
            self.assertNotEqual(original["fingerprint"], changed["fingerprint"])
            self.assertEqual(changed["declarations"][0]["text"], "[pytest]\ntestpaths = tests\n")
            request["cwd"] = "workspace://repo/nested"
            nested = environment.discover(request)
            self.assertEqual(len(nested["declarations"]), 2)
            self.assertFalse((root / "do-not-run").exists())

    def test_actual_interpreter_and_environment_digest_do_not_expose_secret(self):
        with tempfile.TemporaryDirectory() as path:
            request = {"roots": {"repo": path}, "executables": [{"name": sys.executable, "kind": "python"}]}
            first = environment.discover(request)
            self.assertEqual(Path(first["executables"][0]["observed"]["executable"]).resolve(), Path(sys.executable).resolve())
            with patch.dict(os.environ, {"ENV_FACT_SECRET": "must-stay-private"}):
                second = environment.discover(request)
            self.assertNotEqual(first["fingerprint"], second["fingerprint"])
            self.assertNotIn("must-stay-private", json.dumps(second))
            self.assertNotIn("ENV_FACT_SECRET", json.dumps(second))

    def test_symlinks_and_escaping_cwd_do_not_widen_discovery(self):
        with tempfile.TemporaryDirectory() as path, tempfile.TemporaryDirectory() as outside:
            root = Path(path)
            (root / "pyproject.toml").symlink_to(Path(outside) / "private")
            (root / "outside").symlink_to(outside)
            request = {"roots": {"repo": path}, "executables": []}
            self.assertEqual(environment.discover(request)["declarations"][0]["status"], "notRegular")
            request["cwd"] = "workspace://repo/outside"
            with self.assertRaises(ValueError):
                environment.discover(request)

    def test_validation_receipt_binds_command_environment_and_source(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            workspace = root / "workspace"
            workspace.mkdir()
            scratch = root / "scratch"
            (workspace / "source.py").write_text("value = 1\n")
            request = {"scratch": str(scratch), "workspace": str(workspace), "cwd": str(workspace),
                       "argv": [sys.executable, "-I", "-c", "print('checked')"], "identity": "a" * 32}
            self.assertEqual(verification.run(request), 0)
            receipt = json.loads((scratch / "verification" / ("a" * 32 + ".json")).read_text())
            self.assertEqual(receipt["environmentBefore"], receipt["environmentAfter"])
            self.assertTrue(receipt["sourceUnchanged"])
            (workspace / "source.py").write_text("value = 2\n")
            self.assertNotEqual(receipt["sourceAfter"], verification.fingerprint(workspace))
            changed = verification.environment_binding([sys.executable, "-V"], workspace)
            self.assertNotEqual(receipt["environmentBefore"]["commandDigest"], changed["commandDigest"])
            with patch.dict(os.environ, {"ENV_FACT_SECRET": "different"}):
                changed = verification.environment_binding(request["argv"], workspace)
            self.assertNotEqual(receipt["environmentBefore"]["environmentDigest"], changed["environmentDigest"])


if __name__ == "__main__":
    unittest.main()
