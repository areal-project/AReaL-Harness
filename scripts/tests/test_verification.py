"""通过真实 CLI 边界验证构建身份、诊断与固定槽保护。"""

import importlib.util
import json
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("verification", ROOT / "scripts/verification.py")
verification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verification)


class VerificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="areal-verification-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "checkout with spaces"
        self.root.mkdir()
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(self.root),
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "--allow-empty",
                "-qm",
                "fixture",
            ],
            check=True,
        )
        self.source = self.root / "target/debug"
        self.source.mkdir(parents=True)
        (self.root / "Cargo.toml").write_text("[workspace]\n")
        gui = self.root / "clients/gui"
        (gui / "renderer/dist").mkdir(parents=True)
        (gui / "renderer/input.ts").write_text("source")
        self.expected = verification.source_input_hash(self.root)
        for name in verification.components():
            text = "{}"
            if name == "areal":
                text = json.dumps({"inputHash": self.expected})
            (self.source / name).write_text(f"#!{sys.executable}\nprint({text!r})\n")
            (self.source / name).chmod(0o755)
        if verification.platform.system() == "Darwin":
            for name in ["runtime/host-tools/bash.lock.json", "scripts/prepare-runtime-shell.py"]:
                destination = self.root / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / name, destination)
            shells = self.source / "shells"
            shells.mkdir()
            for name in ["bash", "sh"]:
                (shells / name).write_text("#!/bin/sh\nexit 0\n")
                (shells / name).chmod(0o755)
            (shells / "COPYING").write_text("fixture license")
            (shells / "corresponding-source.tar.gz").write_bytes(b"fixture source")
            lock = self.root / "runtime/host-tools/bash.lock.json"
            metadata = json.loads(lock.read_text())
            verification.write_json(
                shells / "build.json",
                {
                    "lockSha256": verification.digest(lock),
                    "builderSha256": verification.digest(
                        self.root / "scripts/prepare-runtime-shell.py"
                    ),
                    "version": metadata["version"],
                    "minimumMacOSVersion": metadata["minimumMacOSVersion"],
                    "license": "GPL-3.0-or-later",
                    "binarySha256": verification.digest(shells / "bash"),
                    "sourceSha256": verification.digest(shells / "corresponding-source.tar.gz"),
                },
            )
        verification.write_json(
            self.source / verification.RECEIPT, verification.build_receipt(self.root, self.source)
        )
        self.renderer = gui / "renderer/dist"
        (self.renderer / "index.html").write_text("original")
        verification.write_json(
            self.renderer / verification.RECEIPT,
            {
                "inputHash": verification.gui_inputs(self.root),
                "files": {"index.html": verification.digest(self.renderer / "index.html")},
            },
        )

    def cli(self, *arguments, passed=True):
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts/verification.py"),
                "--root",
                str(self.root),
                *map(str, arguments),
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0 if passed else 1, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def doctor(self, filename="doctor.json", passed=True, *observations):
        report = self.root / filename
        result = self.cli(
            "doctor",
            "--core",
            self.source / "areal",
            "--report",
            report,
            *observations,
            passed=passed,
        )
        self.assertEqual(result["report"], str(report))
        return json.loads(report.read_text())

    def test_matching_artifacts_and_unknown_authorization(self):
        report = self.doctor()
        self.assertTrue(report["passed"])
        self.assertEqual(len(report["components"]), 3)
        self.assertTrue(
            all(item["authorization"] == "unknown" for item in report["components"].values())
        )
        original = (self.root / "doctor.json").read_bytes()
        self.cli(
            "doctor",
            "--core",
            self.source / "areal",
            "--report",
            self.root / "doctor.json",
            passed=False,
        )
        self.assertEqual((self.root / "doctor.json").read_bytes(), original)

    @unittest.skipUnless(verification.platform.system() == "Darwin", "macOS private shell")
    def test_fixed_slot_includes_private_shell_executables_and_corresponding_source(self):
        destination = self.root / "fixed slot"
        self.cli(
            "deploy",
            "--source-dir",
            self.source,
            "--bin-dir",
            destination,
            "--evidence",
            self.root / "deployment.json",
        )
        receipt = json.loads((destination / verification.RECEIPT).read_text())
        for name in verification.artifact_files():
            self.assertEqual(verification.digest(destination / name), receipt["files"][name])
        for name in ["bash", "sh"]:
            self.assertTrue((destination / "shells" / name).stat().st_mode & 0o111)
        (destination / "shells/bash").write_text("tampered")
        diagnostic = self.cli(
            "doctor",
            "--core",
            destination / "areal",
            "--report",
            self.root / "shell-doctor.json",
            passed=False,
        )
        self.assertIn("artifact changed", " ".join(diagnostic["errors"]))
        with self.assertRaisesRegex(ValueError, "artifact changed"):
            verification.check_files(destination, receipt)
        (destination / "shells/bash").unlink()
        with self.assertRaisesRegex(ValueError, "missing real artifact"):
            verification.check_files(destination, receipt)

    @unittest.skipUnless(verification.platform.system() == "Darwin", "macOS private shell")
    def test_shell_tampering_and_missing_source_reject_deploy_before_slot_write(self):
        destination = self.root / "fixed slot"
        arguments = (
            "deploy",
            "--source-dir",
            self.source,
            "--bin-dir",
            destination,
            "--evidence",
            self.root / "deployment.json",
        )
        source = self.source / "shells/corresponding-source.tar.gz"
        source.write_bytes(b"tampered")
        self.assertIn("artifact changed", self.cli(*arguments, passed=False)["error"])
        source.unlink()
        self.assertIn("missing real artifact", self.cli(*arguments, passed=False)["error"])
        self.assertFalse(destination.exists())

    def installed_bundle(self):
        bundle = self.root / "prefix/lib/areal/0.1.8-fixture"
        (bundle / "bin").mkdir(parents=True)
        (bundle / "libexec/areal").mkdir(parents=True)
        for name in verification.components():
            destination = bundle / ("bin" if name == "areal" else "libexec/areal") / name
            shutil.copy2(self.source / name, destination)
        core = bundle / "bin/areal"
        identity = {
            "inputHash": self.expected,
            "sourceRevision": "fixture",
            "apiVersion": "areal.core.v1",
            "stateVersion": 1,
            "workingTree": "true",
        }
        core.write_text(
            f"#!{sys.executable}\nimport sys\nprint('areal 0.1.8' if '--version' in sys.argv else {json.dumps(identity)!r})\n"
        )
        (bundle / "LICENSE").write_text("fixture license")
        verification.write_json(
            bundle / "manifest.json",
            {
                "manifestVersion": 2,
                "productVersion": "areal 0.1.8",
                "platform": verification.TARGETS[
                    (verification.platform.system(), verification.platform.machine())
                ][0],
                "coreBuild": identity,
                "sourceRevision": "fixture",
                "apiVersion": "areal.core.v1",
                "stateVersion": 1,
                "workingTree": True,
                "files": {
                    str(path.relative_to(bundle)): verification.digest(path)
                    for path in bundle.rglob("*")
                    if path.is_file()
                },
            },
        )
        return bundle

    def bundle_doctor(self, bundle, passed=True):
        report = self.root / "bundle-doctor.json"
        self.cli("doctor", "--core", bundle / "bin/areal", "--report", report, passed=passed)
        return json.loads(report.read_text())

    def test_installed_bundle_uses_verified_inventory_and_libexec_probes(self):
        bundle = self.installed_bundle()
        report = self.bundle_doctor(bundle)
        self.assertTrue(report["passed"])
        self.assertEqual(report["build"]["core"]["layout"], "installedBundle")
        self.assertEqual(
            report["components"]["areal-runtime"]["path"],
            str((bundle / "libexec/areal/areal-runtime").resolve()),
        )
        self.assertFalse((bundle / "bin/verification-build.json").exists())

    def test_installed_bundle_tampering_is_rejected_before_program_execution(self):
        bundle = self.installed_bundle()
        marker = self.root / "tampered-program-ran"
        (bundle / "libexec/areal/areal-runtime").write_text(
            f"#!{sys.executable}\nfrom pathlib import Path\nPath({str(marker)!r}).touch()\n"
        )
        report = self.bundle_doctor(bundle, passed=False)
        self.assertIn("bundle file checksum mismatch", " ".join(report["errors"]))
        self.assertFalse(marker.exists())
        self.assertTrue(all(not row["passed"] for row in report["components"].values()))

    def test_installed_bundle_source_mismatch_is_rejected(self):
        bundle = self.installed_bundle()
        (self.root / "Cargo.toml").write_text("changed")
        report = self.bundle_doctor(bundle, passed=False)
        self.assertIn("Core/Runtime build inputs differ", " ".join(report["errors"]))

    def test_stale_sources_and_tampered_renderer_are_rejected(self):
        (self.root / "Cargo.toml").write_text("changed")
        self.assertIn(
            "Core/Runtime build inputs differ", " ".join(self.doctor(passed=False)["errors"])
        )
        (self.root / "Cargo.toml").write_text("[workspace]\n")
        (self.renderer / "index.html").write_text("tampered")
        self.assertIn(
            "Renderer artifact changed", " ".join(self.doctor("renderer.json", False)["errors"])
        )
        (self.renderer / "index.html").write_text("original")
        (self.root / "clients/gui/renderer/input.ts").write_text("changed")
        self.assertIn(
            "Renderer build inputs differ", " ".join(self.doctor("source.json", False)["errors"])
        )
        (self.root / "clients/gui/renderer/input.ts").write_text("source")
        service = self.root / "services/workbench/src/host-library-store.ts"
        service.parent.mkdir(parents=True)
        service.write_text("export const revision = 1;\n")
        self.assertIn(
            "Renderer build inputs differ", " ".join(self.doctor("workbench.json", False)["errors"])
        )

    def test_renderer_snapshot_survives_rebuild_and_refuses_overwrite(self):
        destination = self.root / "private renderer"
        args = ("snapshot-renderer", "--source-dir", self.renderer, "--output-dir", destination)
        receipt = self.cli(*args)
        self.assertEqual(receipt["inputHash"], verification.gui_inputs(self.root))
        self.assertEqual(receipt["snapshotDirectory"], str(destination.resolve()))
        self.assertEqual(
            receipt["sourceRevision"],
            verification.build_receipt(self.root, self.source)["sourceRevision"],
        )
        self.assertIn("File exists", self.cli(*args, passed=False)["error"])
        (self.renderer / "index.html").write_text("another build")
        (self.root / "clients/gui/renderer/input.ts").write_text("another source")
        self.assertEqual((destination / "index.html").read_text(), "original")
        self.cli(*args, passed=False)
        self.assertEqual(json.loads((destination / verification.RECEIPT).read_text()), receipt)

    def test_renderer_snapshot_rejects_stale_and_changed_builds(self):
        destination = self.root / "snapshot"
        args = ("snapshot-renderer", "--source-dir", self.renderer, "--output-dir", destination)
        (self.renderer / "index.html").write_text("tampered")
        self.assertIn("Renderer artifact changed", self.cli(*args, passed=False)["error"])
        self.assertFalse(destination.exists())
        (self.renderer / "index.html").write_text("original")
        (self.root / "clients/gui/renderer/input.ts").write_text("changed")
        self.assertIn("Renderer build inputs differ", self.cli(*args, passed=False)["error"])
        self.assertFalse(destination.exists())

    def test_renderer_copy_interrupted_by_rebuild_has_no_success_receipt(self):
        from argparse import Namespace

        destination = self.root / "snapshot"
        copy = verification.shutil.copyfile

        def concurrent_build(source, target):
            result = copy(source, target)
            (self.renderer / "index.html").write_text("concurrent build")
            return result

        with patch.object(verification.shutil, "copyfile", side_effect=concurrent_build):
            with self.assertRaisesRegex(ValueError, "Renderer artifact changed"):
                verification.snapshot_renderer(
                    Namespace(
                        root=self.root,
                        source_dir=self.renderer,
                        output_dir=destination,
                    )
                )
        self.assertFalse((destination / verification.RECEIPT).exists())

    def test_killed_and_missing_components_keep_full_diagnostics(self):
        runtime = self.source / "areal-runtime"
        runtime.write_text(
            f"#!{sys.executable}\nimport os,signal\nos.kill(os.getpid(),signal.SIGKILL)\n"
        )
        (self.source / "areal-runtime-fs").unlink()
        report = self.doctor(passed=False)
        self.assertEqual(report["components"]["areal-runtime"]["signal"], 9)
        self.assertIsNone(report["components"]["areal-runtime"]["exitCode"])
        self.assertIn("error", report["components"]["areal-runtime-fs"])
        self.assertTrue(report["components"]["areal"]["passed"])
        self.assertEqual(report["components"]["areal-runtime"]["authorization"], "unknown")

    def test_core_embedded_identity_must_match_even_with_a_matching_receipt(self):
        core = self.source / "areal"
        core.write_text(f'#!{sys.executable}\nprint(\'{{"inputHash":"stale"}}\')\n')
        verification.write_json(
            self.source / verification.RECEIPT, verification.build_receipt(self.root, self.source)
        )
        report = self.doctor(passed=False)
        self.assertIn("Core build-info differs", " ".join(report["errors"]))

    def test_deploy_preserves_identity_and_refuses_busy_or_changed_slots(self):
        destination = self.root / "fixed slot"
        arguments = (
            "deploy",
            "--source-dir",
            self.source,
            "--bin-dir",
            destination,
            "--evidence",
            self.root / "deployment.json",
        )
        self.cli(*arguments)
        before = {
            str(p.relative_to(destination)): p.read_bytes()
            for p in destination.rglob("*")
            if p.is_file()
        }
        with verification.slot_lock(destination):
            self.cli(*arguments, passed=False)
        self.assertEqual(
            before,
            {
                str(p.relative_to(destination)): p.read_bytes()
                for p in destination.rglob("*")
                if p.is_file()
            },
        )
        opened = (destination / "areal-runtime").open("rb")
        child = subprocess.Popen(["/bin/sleep", "30"], stdin=opened)
        try:
            result = self.cli(*arguments, passed=False)
            self.assertIn("in use", result["error"])
            self.assertEqual((destination / "areal-runtime").read_bytes(), before["areal-runtime"])
        finally:
            child.terminate()
            child.wait(timeout=5)
            opened.close()
        (self.source / "areal-runtime-fs").write_text("changed")
        self.cli(*arguments, passed=False)
        self.assertEqual((destination / "areal").read_bytes(), before["areal"])

    def test_node_verification_lease_blocks_python_deployment(self):
        destination = self.root / "node slot"
        destination.mkdir()
        verification.write_json(
            destination / verification.RECEIPT, {"deploymentDirectory": str(destination.resolve())}
        )
        module = (ROOT / "clients/gui/scripts/verification-build.mjs").as_uri()
        program = (
            f"import {{lockVerificationSlot}} from {json.dumps(module)};"
            "const release=await lockVerificationSlot(process.argv[1]);"
            "console.log('locked');await new Promise(resolve=>process.stdin.once('data',resolve));"
            "await release();"
        )
        child = subprocess.Popen(
            ["node", "--input-type=module", "-e", program, str(destination / "areal")],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
        )
        try:
            self.assertEqual(child.stdout.readline().strip(), "locked")
            result = self.cli(
                "deploy",
                "--source-dir",
                self.source,
                "--bin-dir",
                destination,
                "--evidence",
                self.root / "blocked.json",
                passed=False,
            )
            self.assertIn("in use", result["error"])
        finally:
            child.communicate("release\n", timeout=5)
        self.assertEqual(child.returncode, 0)
        self.assertFalse((destination / verification.LOCK).exists())


if __name__ == "__main__":
    unittest.main()
