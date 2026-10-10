"""损坏或重定向的发布包必须在启动 Runner 前拒绝。"""

import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "arena_bootstrap", ROOT / "integrations/envarena/bootstrap.py"
)
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class ArenaPackageTests(unittest.TestCase):
    def run_package(self, name="runner", corrupt=False):
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "package.pyz"
            data = b"frozen runner"
            manifest = {
                "target": "x86_64-unknown-linux-musl",
                "files": {
                    name: {
                        "bytes": len(data),
                        "sha256": hashlib.sha256(data).hexdigest(),
                        "executable": False,
                    }
                },
            }
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("manifest.json", json.dumps(manifest))
                output.writestr(name, b"changed bytes" if corrupt else data)
            with (
                patch.object(bootstrap.sys, "argv", [str(archive)]),
                patch.object(bootstrap.platform, "system", return_value="Linux"),
                patch.object(bootstrap.platform, "machine", return_value="x86_64"),
                patch.object(bootstrap.signal, "signal"),
                patch.object(bootstrap.subprocess, "Popen") as process,
            ):
                process.return_value.wait.return_value = 0
                if corrupt or name.startswith(".."):
                    with self.assertRaises(RuntimeError):
                        bootstrap.main()
                    process.assert_not_called()
                else:
                    self.assertEqual(bootstrap.main(), 0)
                    process.assert_called_once()

    def test_intact_package_starts_runner(self):
        self.run_package()

    def test_corrupt_package_never_starts_runner(self):
        self.run_package(corrupt=True)

    def test_parent_path_never_starts_runner(self):
        self.run_package(name="../outside")


if __name__ == "__main__":
    unittest.main()
