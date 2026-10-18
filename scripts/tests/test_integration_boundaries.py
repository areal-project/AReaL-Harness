"""阻止平台适配器悄悄重新进入普通产品、发行或递归检查入口。"""

import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "integration_boundaries", ROOT / "scripts/check-integration-boundaries.py"
)
boundaries = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundaries)


class IntegrationBoundaryTests(unittest.TestCase):
    def test_manual_adapter_workflow_rejects_automatic_triggers(self):
        self.assertEqual(boundaries.check_workflow("on:\n  workflow_dispatch:\njobs:\n"), [])
        for event in ("pull_request", "push", "workflow_call", "schedule"):
            with self.subTest(event=event):
                self.assertTrue(
                    boundaries.check_workflow(f"on:\n  workflow_dispatch:\n  {event}:\njobs:\n")
                )

    def test_core_import_cargo_path_and_release_workflow_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            files = {
                "core/engine/src/lib.rs": 'include!("../../../integrations/envarena/bridge.rs");',
                "Cargo.toml": 'adapter = { path = "integrations/envarena" }',
                ".github/workflows/release.yml": "run: make envarena-check",
                "clients/gui/package.json": '{"adapter":"file:../../integrations/envarena"}',
            }
            for name, text in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text)
            self.assertEqual(len(boundaries.check_files(root, files)), len(files))

    def test_generic_arena_allocator_and_explicit_adapter_are_allowed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "Cargo.lock").write_text('name = "id-arena"\n')
            self.assertEqual(
                boundaries.check_files(root, ["Cargo.lock", "integrations/envarena/runner.py"]), []
            )

    def test_transitive_default_make_dependency_is_rejected_without_running_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            other = " ".join(target for target in boundaries.DEFAULT_TARGETS if target != "verify")
            (root / "Makefile").write_text(
                f"{other}:\n\t@echo independent\n"
                "verify:\n\t$(MAKE) script-test\n"
                "script-test: hidden-adapter\n"
                "hidden-adapter:\n\tpython3 integrations/envarena/arena-input-smoke.py\n"
                "\ttouch must-not-run\n"
            )
            self.assertEqual(len(boundaries.check_make(root)), 1)
            self.assertFalse((root / "must-not-run").exists())

    def test_adapter_package_test_is_outside_default_unittest_discovery(self):
        generic = unittest.defaultTestLoader.discover(str(ROOT / "scripts/tests"))

        def tests(suite):
            for item in suite:
                if isinstance(item, unittest.TestSuite):
                    yield from tests(item)
                else:
                    yield item.id()

        self.assertFalse(any("package_arena" in name for name in tests(generic)))


if __name__ == "__main__":
    unittest.main()
