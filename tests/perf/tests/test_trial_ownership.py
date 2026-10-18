import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest


spec = importlib.util.spec_from_file_location(
    "trial_ownership", Path(__file__).resolve().parents[1] / "runner/trial_ownership.py"
)
ownership = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ownership)


@unittest.skipUnless(
    sys.platform == "linux" and os.geteuid() == 0, "requires a root Linux test container"
)
class OwnershipBoundaryTests(unittest.TestCase):
    def test_private_tree_round_trip_preserves_modes_and_outside_symlink_targets(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace = root / "workspace"
            outside = root / "outside"
            workspace.mkdir(mode=0o755)
            outside.mkdir()
            (outside / "secret").write_text("outside")
            os.chown(outside, 601, 602)
            os.chown(outside / "secret", 601, 602)
            (workspace / "file").write_text("original")
            (workspace / "file").chmod(0o644)
            (workspace / "directory-link").symlink_to(outside)
            (workspace / "file-link").symlink_to(outside / "secret")
            (workspace / "dangling").symlink_to(root / "missing")
            ownership.set_owner(workspace, 501, 502)
            ownership.set_owner(workspace, 0, 0)
            self.assertEqual((workspace / "file").stat().st_uid, 0)
            self.assertEqual((workspace / "file").stat().st_mode & 0o777, 0o644)
            self.assertEqual(workspace.stat().st_mode & 0o777, 0o755)
            self.assertEqual((outside / "secret").stat().st_uid, 601)
            self.assertEqual(outside.stat().st_uid, 601)
            private = workspace / "private"
            private.mkdir(mode=0o700)
            (private / "result").write_text("result")
            (private / "result").chmod(0o600)
            ownership.set_owner(workspace, 501, 502)
            for path in [
                workspace,
                workspace / "file",
                private,
                private / "result",
                workspace / "file-link",
            ]:
                self.assertEqual((path.lstat().st_uid, path.lstat().st_gid), (501, 502))
            self.assertEqual((private / "result").stat().st_mode & 0o777, 0o600)
            self.assertEqual((outside / "secret").stat().st_uid, 601)
            self.assertEqual((outside / "secret").read_text(), "outside")

    def test_symlink_root_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            outside = root / "outside"
            outside.mkdir()
            os.chown(outside, 601, 602)
            link = root / "link"
            link.symlink_to(outside)
            with self.assertRaises(OSError):
                ownership.set_owner(link, 0, 0)
            self.assertEqual(outside.stat().st_uid, 601)
