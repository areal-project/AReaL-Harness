"""Cleanup CLI contract checks; all artifacts belong to isolated fixtures."""

import fcntl
import hashlib
import json
import os
import plistlib
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "artifact-cleanup.py"


class TemporaryWorktreeCacheTest(unittest.TestCase):
    # 失败方式：删除主仓/可执行产物、忽略锁或打开文件、预算内全清、失效路径阻断。
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="worktree cache ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.repo = self.root / "main checkout"
        (self.repo / "scripts").mkdir(parents=True)
        shutil.copy2(SCRIPT, self.repo / "scripts/artifact-cleanup.py")
        (self.repo / "core/engine").mkdir(parents=True)
        (self.repo / "core/engine/Cargo.toml").write_text('[package]\nname = "areal-engine"\n')
        (self.repo / "Cargo.toml").write_text("[workspace]\n")
        self.git("init", "-q")
        self.git("add", ".")
        self.git(
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "fixture",
        )
        self.old = self.root / "old checkout"
        self.new = self.root / "new checkout"
        for path in [self.old, self.new]:
            self.git("worktree", "add", "--detach", str(path), "HEAD")
        for checkout, age in [(self.repo, 500), (self.old, 1000), (self.new, 2000)]:
            profile = checkout / "target/debug"
            profile.mkdir(parents=True)
            (profile / ".cargo-lock").touch()
            (profile / "areal").write_bytes(b"keep companion")
            for name in ["deps", "incremental"]:
                cache = profile / name
                cache.mkdir()
                (cache / "cache").write_bytes(b"x" * 16384)
                os.utime(cache, (age, age))
            os.utime(profile, (age, age))
        self.report = self.root / "result.json"

    def git(self, *args):
        return subprocess.check_output(
            ["git", *args], cwd=self.repo, stderr=subprocess.STDOUT, text=True
        )

    def run_cleanup(self, *args, budget="0"):
        result = subprocess.run(
            [
                sys.executable,
                str(self.repo / "scripts/artifact-cleanup.py"),
                "--temporary-worktrees",
                "--cache-budget-gib",
                budget,
                "--min-free-gib",
                "0",
                "--report",
                str(self.report),
                "--json",
                *args,
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_preview_and_apply_only_touch_registered_secondary_caches(self):
        missing = self.root / "missing checkout"
        self.git("worktree", "add", "--detach", str(missing), "HEAD")
        shutil.rmtree(missing)
        delivery = self.old / "target/delivery-keep/deps"
        dependency = self.old / "target/vendor/node_modules/pkg/build"
        for path in [delivery, dependency]:
            path.mkdir(parents=True)
            (path / "keep").write_text("preserved")
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "keep").write_text("preserved")
        (self.old / "target/release").mkdir()
        (self.old / "target/release/deps").symlink_to(outside, target_is_directory=True)
        preview = self.run_cleanup()
        self.assertTrue((self.old / "target/debug/deps/cache").exists())
        self.assertEqual(len(preview["items"]), 4)
        self.assertTrue(any("missing checkout" in w for w in preview["warnings"]))
        applied = self.run_cleanup("--apply")
        self.assertEqual(sum(i["status"] == "deleted" for i in applied["items"]), 4)
        for checkout in [self.old, self.new]:
            self.assertFalse((checkout / "target/debug/deps").exists())
            self.assertEqual((checkout / "target/debug/areal").read_bytes(), b"keep companion")
        self.assertTrue((self.repo / "target/debug/deps/cache").exists())
        for path in [delivery, dependency, outside]:
            self.assertEqual((path / "keep").read_text(), "preserved")

    def test_budget_retains_recent_profile_and_is_repeatable(self):
        budget = str(48 * 1024 / 1024**3)
        self.run_cleanup("--apply", budget=budget)
        self.assertFalse((self.old / "target/debug/deps").exists())
        self.assertTrue((self.new / "target/debug/deps/cache").exists())
        repeated = self.run_cleanup("--apply", budget=budget)
        self.assertFalse(any(i["status"] == "deleted" for i in repeated["items"]))

    def test_locks_and_open_companions_protect_entire_profile(self):
        companion = self.new / "target/debug/areal"
        child = subprocess.Popen(
            [
                sys.executable,
                "-c",
                "import sys; f=open(sys.argv[1]); print('ready',flush=True); sys.stdin.read()",
                str(companion),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
        )
        try:
            self.assertEqual(child.stdout.readline().strip(), "ready")
            with (self.old / "target/debug/.cargo-lock").open("r+") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                report = self.run_cleanup("--apply")
                self.assertFalse(any(i["status"] == "deleted" for i in report["items"]))
                self.assertEqual(
                    {i["status"] for i in report["items"]},
                    {"blocked-build-lock", "blocked-in-use"},
                )
            self.assertTrue((self.old / "target/debug/deps/cache").exists())
            self.assertTrue((self.new / "target/debug/deps/cache").exists())
            # 真 make 进程尚未打开缓存文件时，也必须保护工作树内的 profile。
            makefile = self.old / "waiting.mk"
            makefile.write_text("wait:\n\t@echo ready\n\t@sleep 60\n")
            builder = subprocess.Popen(
                ["make", "--no-print-directory", "-f", str(makefile), "wait"],
                cwd=self.old,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                start_new_session=True,
                env={
                    key: value
                    for key, value in os.environ.items()
                    if key not in {"MAKEFLAGS", "MFLAGS", "MAKELEVEL", "GNUMAKEFLAGS"}
                },
            )
            try:
                self.assertEqual(builder.stdout.readline().strip(), "ready")
                report = self.run_cleanup("--apply")
                self.assertEqual({i["status"] for i in report["items"]}, {"blocked-in-use"})
                self.assertTrue((self.old / "target/debug/deps/cache").exists())
            finally:
                os.killpg(builder.pid, signal.SIGTERM)
                builder.communicate(timeout=10)
        finally:
            child.communicate(timeout=10)

    def test_invalid_budget_rejects_before_effects(self):
        result = subprocess.run(
            [
                sys.executable,
                str(self.repo / "scripts/artifact-cleanup.py"),
                "--temporary-worktrees",
                "--cache-budget-gib",
                "nan",
                "--apply",
                "--report",
                str(self.report),
            ],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.old / "target/debug/deps/cache").exists())


class ArtifactCleanupTest(unittest.TestCase):
    def test_preview_keeps_five_rounds_and_never_changes_artifacts(self):
        with tempfile.TemporaryDirectory(prefix="artifact cleanup ") as tmp:
            root = Path(tmp).resolve() / "artifacts"
            root.mkdir()
            for i in range(7):
                folder = root / f"round-{i}"
                app = folder / "package" / "AReaL Harness GUI.app"
                resources = app / "Contents" / "Resources"
                resources.mkdir(parents=True)
                (resources / "app.asar").write_bytes(str(i).encode())
                core = resources / "areal-core"
                core.mkdir()
                files = {}
                for relative in [
                    "bin/areal",
                    "libexec/areal/areal-runtime",
                    "libexec/areal/areal-runtime-fs",
                ]:
                    binary = core / relative
                    binary.parent.mkdir(parents=True, exist_ok=True)
                    binary.write_bytes(b"embedded")
                    files[relative] = hashlib.sha256(b"embedded").hexdigest()
                (core / "manifest.json").write_text(
                    json.dumps({"coreBuild": {"inputHash": str(i)}, "files": files})
                )
                executable = app / "Contents/MacOS/AReaL Harness GUI"
                executable.parent.mkdir()
                executable.write_bytes(b"gui")
                with (app / "Contents" / "Info.plist").open("wb") as f:
                    plistlib.dump({"CFBundleShortVersionString": "1.0"}, f)
                evidence = folder / "package-evidence.json"
                evidence.write_text(json.dumps({"app": str(app)}))
                os.utime(evidence, (1000 + i, 1000 + i))
            before = {
                str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file()
            }
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--root", str(root), "--no-worktrees", "--json"],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            rounds = report["gui_rounds"]
            self.assertEqual(len(rounds), 7)
            self.assertEqual(sum(r["retained"] for r in rounds), 5)
            self.assertEqual(
                {Path(r["path"]).name for r in rounds if not r["retained"]}, {"round-0", "round-1"}
            )
            after = {
                str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file()
            }
            self.assertEqual(before, after)
            applied = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--root",
                    str(root),
                    "--no-worktrees",
                    "--apply",
                    "--report",
                    str(root.parent / "apply.json"),
                    "--json",
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(applied.returncode, 0, applied.stderr)
            self.assertFalse((root / "round-0/package/AReaL Harness GUI.app").exists())
            self.assertFalse((root / "round-1/package/AReaL Harness GUI.app").exists())
            self.assertTrue((root / "round-2/package/AReaL Harness GUI.app").exists())
            self.assertTrue((root / "round-0/package-evidence.json").exists())

    def test_rust_bundle_retention_is_separate_from_cache_and_obeys_locks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            for i in range(7):
                repo = root / f"repo-{i}"
                (repo / "core/engine").mkdir(parents=True)
                (repo / "core/engine/Cargo.toml").write_text('[package]\nname = "areal-engine"\n')
                (repo / "Cargo.toml").write_text("[workspace]\n")
                profile = repo / "target/debug"
                (profile / "deps").mkdir(parents=True)
                (profile / "deps/cache").write_bytes(b"cache")
                binary = profile / "areal"
                binary.write_bytes(b"runnable")
                binary.chmod(0o755)
                bundle = repo / "core-bundle"
                files = {}
                for relative in [
                    "bin/areal",
                    "libexec/areal/areal-runtime",
                    "libexec/areal/areal-runtime-fs",
                ]:
                    path = bundle / relative
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(f"binary-{i}".encode())
                    path.chmod(0o755)
                    files[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
                manifest = bundle / "manifest.json"
                manifest.write_text(
                    json.dumps({"coreBuild": {"inputHash": str(i)}, "files": files})
                )
                os.utime(manifest, (1000 + i, 1000 + i))
            lock = root / "repo-0/target/debug/.cargo-lock"
            with lock.open("w") as held:
                fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                result = subprocess.run(
                    [sys.executable, str(SCRIPT), "--root", str(root), "--no-worktrees", "--json"],
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                report = json.loads(result.stdout)
                self.assertEqual(len(report["rust_profiles"]), 7)
                self.assertEqual(sum(r["retained"] for r in report["rust_bundles"]), 5)
                planned = {i["path"]: i for i in report["items"]}
                self.assertEqual(
                    planned[str(root / "repo-0/target/debug/deps")]["status"], "blocked-build-lock"
                )
                self.assertIn(str(root / "repo-6/target/debug/deps"), planned)
                self.assertNotIn(str(root / "repo-6/target/debug"), planned)
                self.assertIn(str(root / "repo-0/core-bundle"), planned)
                self.assertNotIn(str(root / "repo-6/core-bundle"), planned)
                self.assertTrue((root / "repo-0/target/debug/areal").exists())

    def test_invalid_keep_fails_before_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / "untouched"
            marker.write_text("keep")
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--root", tmp, "--keep", "0", "--apply"],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(marker.read_text(), "keep")

    def test_symlink_outside_root_is_not_discovered(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as outside:
            (Path(outside) / "package-evidence.json").write_text("{}")
            (Path(tmp) / "escape").symlink_to(outside, target_is_directory=True)
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--root", tmp, "--no-worktrees", "--json"],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["gui_rounds"], [])


if __name__ == "__main__":
    unittest.main()
