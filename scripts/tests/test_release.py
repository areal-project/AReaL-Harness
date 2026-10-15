"""发行归档、formula 和版本化安装的回归。"""

import hashlib
import base64
import importlib.util
import io
import json
import platform
import subprocess
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


installer = load("release_installer", "install.py")
release = load("release_artifacts", "release-artifacts.py")
package = load("release_package", "package.py")


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def bundle(self, version="0.1.0", target="linux/x86_64", manifest_version=1):
        bundle = self.root / (version + target.replace("/", "-"))
        bundle.mkdir()
        files = {}
        for name in [
            "bin/areal",
            "libexec/areal/areal-runtime",
            "libexec/areal/areal-runtime-fs",
            *(["libexec/areal/areal-runtime-reaper"] if target.startswith("linux/") else []),
            "LICENSE",
        ]:
            p = bundle / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text("fixture " + name)
            p.chmod(0o755)
            files[name] = installer.checksum(p)
        (bundle / "manifest.json").write_text(
            json.dumps(
                {
                    "manifestVersion": manifest_version,
                    "productVersion": "areal " + version,
                    "platform": target,
                    "files": files,
                    "profile": "release",
                    "workingTree": False,
                    "prerequisites": [{"glibc": ">=2.35", "verifiedVersion": "2.35"}],
                }
            )
        )
        if manifest_version == 2:
            path = bundle / "manifest.json"
            manifest = json.loads(path.read_text())
            manifest.update(
                {"sourceRevision": "a" * 40, "apiVersion": "areal.core.v1", "stateVersion": 14}
            )
            manifest["coreBuild"] = {
                "sourceRevision": "a" * 40,
                "inputHash": "b" * 64,
                "apiVersion": "areal.core.v1",
                "stateVersion": 14,
                "workingTree": "false",
            }
            path.write_text(json.dumps(manifest))
        return bundle

    def test_archive_roundtrip_and_tampered_checksum(self):
        bundle = self.bundle()
        archive = release.archive(bundle, self.root / "assets")
        sums = archive.with_name(archive.name + ".sha256")
        installer.verify_archive(archive, sums, archive.name)
        unpacked = installer.extract_bundle(archive, self.root / "unpack")
        installer.verify_bundle(unpacked, "0.1.0", "linux/x86_64")
        archive.write_bytes(archive.read_bytes() + b"tampered")
        with self.assertRaises(ValueError):
            installer.verify_archive(archive, sums, archive.name)

    def complete_candidates(self):
        core_assets, gui_assets = self.root / "core-assets", self.root / "gui-assets"
        for target in release.TARGETS:
            release.archive(self.bundle(target=target, manifest_version=2), core_assets)
        gui_assets.mkdir()
        version = json.loads((ROOT / "clients/gui/package.json").read_text())["version"]
        artifacts = []
        for extension in ("zip", "dmg"):
            name = f"AReaLHarness-{version}-macos-arm64.{extension}"
            data = ("signed fixture " + name).encode()
            (gui_assets / name).write_bytes(data)
            artifacts.append(
                {
                    "name": name,
                    "size": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "sha512": base64.b64encode(hashlib.sha512(data).digest()).decode(),
                }
            )
        metadata = {
            "version": version,
            "tag": "gui-v" + version,
            "repository": "areal-project/AReaL-Harness",
            "sourceRevision": "a" * 40,
            "coreVersion": "areal 0.1.0",
            "platform": "darwin/arm64",
            "feedUrl": "https://github.com/areal-project/AReaL-Harness/releases/download/gui-update-channel/",
            "packagedGui": "passed",
            "packagedModelSelection": "passed",
            "notarization": {key: {"status": "Accepted"} for key in ("zip", "dmg")},
            "artifacts": artifacts,
        }
        (gui_assets / "release.json").write_text(json.dumps(metadata))
        (gui_assets / "latest-mac.yml").write_text("fixture manifest")
        self.gui_checksums(gui_assets)
        return core_assets, gui_assets

    def gui_checksums(self, directory):
        (directory / "SHA256SUMS").write_text(
            "".join(
                f"{release.sha(p)}  {p.name}\n"
                for p in sorted(directory.iterdir())
                if p.name != "SHA256SUMS"
            )
        )

    def test_complete_release_validates_inventory_and_legacy_update_url(self):
        core, gui = self.complete_candidates()
        output = release.assemble(core, gui, self.root / "complete", "0.1.0", "a" * 40)
        manifest = json.loads((output / "release-manifest.json").read_text())
        self.assertEqual(manifest["sourceRevision"], "a" * 40)
        self.assertEqual(len(manifest["assets"]), 10)
        for path in output.iterdir():
            if path.name != "SHA256SUMS":
                installer.verify_archive(path, output / "SHA256SUMS", path.name)
        update = json.loads((output / "latest-mac.yml").read_text())
        self.assertIn(f"/gui-v{manifest['guiVersion']}/", update["files"][0]["url"])
        self.assertIn("/v0.1.0/", (output / "areal.rb").read_text())

    def test_complete_release_rejects_stale_or_unaccepted_gui(self):
        core, gui = self.complete_candidates()
        path = gui / "release.json"
        original = json.loads(path.read_text())
        for field, value in (
            ("sourceRevision", "b" * 40),
            ("coreVersion", "areal 0.0.9"),
            ("packagedModelSelection", "failed"),
            ("notarization", {}),
            ("artifacts", original["artifacts"][:1]),
        ):
            with self.subTest(field=field):
                path.write_text(json.dumps({**original, field: value}))
                self.gui_checksums(gui)
                output = self.root / ("rejected-" + field)
                with self.assertRaises(ValueError):
                    release.assemble(core, gui, output, "0.1.0", "a" * 40)
                self.assertFalse(output.exists())

    def test_complete_release_rejects_tampering_and_missing_platform(self):
        core, gui = self.complete_candidates()
        path = next(gui.glob("*.zip"))
        path.write_bytes(path.read_bytes() + b"changed")
        with self.assertRaises(ValueError):
            release.assemble(core, gui, self.root / "tampered", "0.1.0", "a" * 40)
        next(core.glob("*linux*.tar.gz")).unlink()
        with self.assertRaises(FileNotFoundError):
            release.assemble(core, gui, self.root / "missing", "0.1.0", "a" * 40)

    def test_manifest_rejects_missing_extra_and_changed_files(self):
        bundle = self.bundle()
        with self.assertRaises(ValueError):
            installer.verify_bundle(bundle, "0.1.1", "linux/x86_64")
        with self.assertRaises(ValueError):
            installer.verify_bundle(bundle, "0.1.0", "darwin/arm64")
        (bundle / "extra").write_text("not in manifest")
        with self.assertRaises(ValueError):
            installer.verify_bundle(bundle, "0.1.0", "linux/x86_64")
        (bundle / "extra").unlink()
        (bundle / "bin/areal").write_text("changed")
        with self.assertRaises(ValueError):
            installer.verify_bundle(bundle, "0.1.0", "linux/x86_64")

    def test_archive_rejects_traversal_links_and_duplicates(self):
        for mode in ["traversal", "symlink", "duplicate"]:
            archive = self.root / (mode + ".tar.gz")
            with tarfile.open(archive, "w:gz") as stream:
                member = tarfile.TarInfo(
                    "areal/../outside" if mode == "traversal" else "areal/bin/areal"
                )
                if mode == "symlink":
                    member.type = tarfile.SYMTYPE
                    member.linkname = "/etc/passwd"
                stream.addfile(member, io.BytesIO(b""))
                if mode == "duplicate":
                    stream.addfile(member, io.BytesIO(b""))
            with self.assertRaises(ValueError):
                installer.extract_bundle(archive, self.root / mode)
        self.assertFalse((self.root / "outside").exists())

    def test_formula_uses_actual_archive_hash_and_full_bundle(self):
        archive = release.archive(self.bundle(target="darwin/arm64"), self.root / "assets")
        output = self.root / "Formula/areal.rb"
        release.formula(archive, output)
        text = output.read_text()
        self.assertIn(hashlib.sha256(archive.read_bytes()).hexdigest(), text)
        self.assertIn("/v0.1.0/" + archive.name, text)
        self.assertIn('prefix.install "bin", "libexec", "manifest.json", "LICENSE"', text)
        self.assertNotIn("PLACEHOLDER", text)

    def test_release_rejects_dirty_or_debug_bundles(self):
        bundle = self.bundle()
        p = bundle / "manifest.json"
        data = json.loads(p.read_text())
        for field, value in [("workingTree", True), ("profile", "debug")]:
            changed = {**data, field: value}
            p.write_text(json.dumps(changed))
            with self.assertRaises(ValueError):
                release.archive(bundle, self.root / "assets")

    def test_latest_release_tag_is_validated(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_):
                pass

            def read(self, *_):
                return b'{"tag_name":"v0.1.2"}'

        with patch.object(installer.urllib.request, "urlopen", return_value=Response()):
            self.assertEqual(installer.latest_version(), "0.1.2")

        class Invalid(Response):
            def read(self, *_):
                return b'{"tag_name":"../0.1.2"}'

        with patch.object(installer.urllib.request, "urlopen", return_value=Invalid()):
            with self.assertRaises(ValueError):
                installer.latest_version()

    def test_standalone_installer_rejects_v2_identity_mismatch(self):
        target = "darwin/arm64" if platform.system() == "Darwin" else "linux/x86_64"
        bundle = self.bundle("0.1.2", target, manifest_version=2)
        path = bundle / "manifest.json"
        manifest = json.loads(path.read_text())
        manifest["coreBuild"]["sourceRevision"] = "c" * 40
        path.write_text(json.dumps(manifest))
        archive = release.archive(bundle, self.root / "bad-assets")
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts/install.py"),
                "--version",
                "0.1.2",
                "--prefix",
                str(self.root / "rejected-prefix"),
                "--archive",
                str(archive),
                "--checksums",
                str(archive.with_name(archive.name + ".sha256")),
            ],
            text=True,
            capture_output=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Core build identity does not match", result.stderr)
        self.assertFalse((self.root / "rejected-prefix/bin/areal").exists())

    def test_macos_package_preserves_valid_build_signatures_and_rejects_invalid_ones(self):
        repository = self.root / "repository"
        source = repository / "target/debug"
        source.mkdir(parents=True)
        (repository / "LICENSE").write_text("fixture license")
        (repository / "schemas").mkdir()
        (repository / "schemas/areal-core-v1.json").write_text(
            json.dumps({"apiVersion": "fixture-api-v1"})
        )
        (repository / "core/engine/src").mkdir(parents=True)
        (repository / "core/engine/src/store.rs").write_text(
            "pub(crate) const STATE_VERSION: u32 = 42;\n"
        )
        names = ["areal", "areal-runtime", "areal-runtime-fs"]
        for name in names:
            (source / name).write_bytes(b"signed build artifact: " + name.encode())

        def metadata(command, **kwargs):
            if command[-1] == "build-info":
                return json.dumps(
                    {
                        "sourceRevision": "fixture-revision",
                        "workingTree": "false",
                        "inputHash": hashlib.sha256(b"").hexdigest(),
                        "apiVersion": "fixture-api-v1",
                        "stateVersion": 42,
                    }
                )
            if command[-1] == "--version":
                return "areal 0.1.3\n"
            result = "fixture-revision\n" if command[1] == "rev-parse" else ""
            return result if kwargs.get("text") else result.encode()

        for valid in [True, False]:
            destination = self.root / ("valid-package" if valid else "invalid-package")
            calls = []

            def verify(command, **kwargs):
                calls.append(command)
                self.assertEqual(command[:3], ["/usr/bin/codesign", "--verify", "--strict"])
                self.assertTrue(kwargs["check"])
                if not valid:
                    raise subprocess.CalledProcessError(1, command, stderr=b"invalid signature")
                return subprocess.CompletedProcess(command, 0)

            with (
                patch.object(package, "__file__", str(repository / "scripts/package.py")),
                patch.object(package.platform, "system", return_value="Darwin"),
                patch.object(package.platform, "machine", return_value="arm64"),
                patch.object(package.subprocess, "run", side_effect=verify),
                patch.object(package.subprocess, "check_output", side_effect=metadata),
                patch.object(
                    sys, "argv", ["package.py", "--profile", "debug", "--output", str(destination)]
                ),
                redirect_stdout(io.StringIO()),
                self.subTest(valid=valid),
            ):
                if valid:
                    package.main()
                    manifest = json.loads((destination / "manifest.json").read_text())
                    self.assertEqual(manifest["apiVersion"], "fixture-api-v1")
                    self.assertEqual(manifest["stateVersion"], 42)
                    self.assertEqual(len(calls), len(names))
                    for name in names:
                        relative = Path("bin" if name == "areal" else "libexec/areal") / name
                        original = (source / name).read_bytes()
                        self.assertEqual((destination / relative).read_bytes(), original)
                        self.assertEqual(
                            manifest["files"][str(relative)], hashlib.sha256(original).hexdigest()
                        )
                else:
                    with self.assertRaises(subprocess.CalledProcessError):
                        package.main()
                    self.assertEqual(len(calls), 1)
                    self.assertFalse((destination / "manifest.json").exists())

    @unittest.skipUnless(
        (platform.system() == "Darwin" and platform.machine() == "arm64")
        or (
            platform.system() == "Linux"
            and platform.machine() == "x86_64"
            and platform.libc_ver()[0] == "glibc"
            and tuple(map(int, platform.libc_ver()[1].split(".")[:2])) >= (2, 35)
        ),
        "supported installer platform",
    )
    def test_install_upgrade_keeps_old_version_and_refuses_unmanaged_binary(self):
        prefix = self.root / "prefix with spaces"
        target = "darwin/arm64" if platform.system() == "Darwin" else "linux/x86_64"
        directory = "macos-arm64" if platform.system() == "Darwin" else "linux-x86_64"
        for version in ["0.1.0", "0.1.1"]:
            archive = release.archive(
                self.bundle(version, target, manifest_version=1 if version == "0.1.0" else 2),
                self.root / "assets",
            )
            command = [
                sys.executable,
                str(ROOT / "scripts/install.py"),
                "--version",
                version,
                "--prefix",
                str(prefix),
                "--archive",
                str(archive),
                "--checksums",
                str(archive.with_name(archive.name + ".sha256")),
            ]
            subprocess.run(command, check=True, capture_output=True)
            self.assertEqual(
                (prefix / "bin/areal").resolve(),
                (prefix / f"lib/areal/{version}-{directory}/bin/areal").resolve(),
            )
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
        self.assertTrue((prefix / f"lib/areal/0.1.0-{directory}/bin/areal").exists())
        (prefix / "bin/areal").unlink()
        (prefix / "bin/areal").write_text("user-owned executable")
        command[command.index("--version") + 1] = "0.1.2"
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
        self.assertEqual((prefix / "bin/areal").read_text(), "user-owned executable")


if __name__ == "__main__":
    unittest.main()


class BuildIdentityTests(unittest.TestCase):
    def test_binary_a_cannot_be_relabelled_as_source_b(self):
        info = {
            "sourceRevision": "A",
            "inputHash": "a",
            "workingTree": "false",
            "apiVersion": "core.v1",
            "stateVersion": 1,
        }
        for revision, fingerprint in [("B", "a"), ("A", "b")]:
            with self.assertRaises(ValueError):
                package.validate_build_info(
                    info, revision, fingerprint, {"apiVersion": "core.v1", "stateVersion": 1}
                )
        self.assertEqual(
            package.validate_build_info(
                info, "A", "a", {"apiVersion": "core.v1", "stateVersion": 1}
            ),
            info,
        )
