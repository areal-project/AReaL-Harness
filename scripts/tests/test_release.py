"""发行归档、formula 和版本化安装的回归。"""

import hashlib
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
versions = load("release_versions", "set-version.py")


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def private_shell(self, repository):
        directory = repository / "target/debug/shells"
        directory.mkdir(parents=True)
        lock = repository / "runtime/host-tools/bash.lock.json"
        lock.parent.mkdir(parents=True)
        lock.write_text(json.dumps({"version": "5.3.20", "minimumMacOSVersion": "15.0"}))
        builder = repository / "scripts/prepare-runtime-shell.py"
        builder.parent.mkdir(parents=True)
        builder.write_text("fixture build instructions")
        for name in ["bash", "sh"]:
            (directory / name).write_bytes(b"signed private shell")
        (directory / "COPYING").write_text("fixture GPL license")
        (directory / "corresponding-source.tar.gz").write_bytes(b"fixture complete source")
        (directory / "build.json").write_text(
            json.dumps(
                {
                    "lockSha256": hashlib.sha256(lock.read_bytes()).hexdigest(),
                    "builderSha256": hashlib.sha256(builder.read_bytes()).hexdigest(),
                    "binarySha256": hashlib.sha256((directory / "bash").read_bytes()).hexdigest(),
                    "sourceSha256": hashlib.sha256(
                        (directory / "corresponding-source.tar.gz").read_bytes()
                    ).hexdigest(),
                    "version": "5.3.20",
                    "minimumMacOSVersion": "15.0",
                    "license": "GPL-3.0-or-later",
                }
            )
        )
        return directory

    def test_private_shell_package_rejects_missing_sources_and_changed_build_inputs(self):
        repository = self.root / "shell-repository"
        directory = self.private_shell(repository)
        package.private_shell_info(repository, repository / "target/debug")
        (directory / "corresponding-source.tar.gz").write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            package.private_shell_info(repository, repository / "target/debug")
        (directory / "corresponding-source.tar.gz").write_bytes(b"fixture complete source")
        (repository / "scripts/prepare-runtime-shell.py").write_text("changed compiler inputs")
        with self.assertRaisesRegex(ValueError, "build inputs changed"):
            package.private_shell_info(repository, repository / "target/debug")

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
                    "sourceRevision": "a" * 40,
                    "prerequisites": [{"glibc": ">=2.35", "verifiedVersion": "2.35"}],
                }
            )
        )
        program = bundle / "bin/areal"
        program.write_text(
            "#!" + sys.executable + "\n"
            "import json, os, sys\n"
            "from pathlib import Path\n"
            "if sys.argv[1:] == ['--version']:\n"
            f"    print('areal {version}')\n"
            "elif sys.argv[1:] == ['service', 'list', '--json']:\n"
            "    path = os.environ.get('AREAL_INSTALL_FIXTURE_SERVICES')\n"
            "    print(Path(path).read_text() if path else '[]')\n"
            "else:\n"
            "    sys.exit(9)\n"
        )
        manifest_path = bundle / "manifest.json"
        data = json.loads(manifest_path.read_text())
        data["files"]["bin/areal"] = installer.checksum(program)
        manifest_path.write_text(json.dumps(data))
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

    def test_set_version_unifies_cli_and_gui_and_never_moves_back(self):
        (self.root / "clients/gui/app").mkdir(parents=True)
        (self.root / "Cargo.toml").write_text(
            '[workspace]\n\n[workspace.package]\nversion = "0.1.8"\n\n[workspace.dependencies]\nx = { version = "0.1.8" }\n'
        )
        (self.root / "Cargo.lock").write_text(
            '[[package]]\nname = "areal-cli"\nversion = "0.1.8"\n\n'
            '[[package]]\nname = "dep"\nversion = "0.1.8"\nsource = "registry+https://example"\n'
        )
        for path, version in (
            ("clients/gui/package.json", "0.1.18"),
            ("clients/gui/app/package.json", "0.1.18"),
        ):
            (self.root / path).write_text(json.dumps({"name": "x", "version": version}, indent=2))
        with self.assertRaisesRegex(ValueError, "back"):
            versions.set_version(self.root, "0.1.9")
        for invalid in ("0.2.0-rc.1", "0.2.0-beta.0", "v0.2.0"):
            with self.assertRaises(ValueError):
                versions.set_version(self.root, invalid)
        versions.set_version(self.root, "0.2.0-beta.1")
        self.assertEqual(
            versions.current(self.root), ("0.2.0-beta.1", ["0.2.0-beta.1", "0.2.0-beta.1"])
        )
        lock = (self.root / "Cargo.lock").read_text()
        self.assertIn('name = "areal-cli"\nversion = "0.2.0-beta.1"', lock)
        self.assertIn('name = "dep"\nversion = "0.1.8"', lock)
        self.assertIn('x = { version = "0.1.8" }', (self.root / "Cargo.toml").read_text())
        versions.set_version(self.root, "0.2.0")
        with self.assertRaisesRegex(ValueError, "back"):
            versions.set_version(self.root, "0.2.0-beta.2")

    def test_formula_uses_actual_archive_hash_and_full_bundle(self):
        archive = release.archive(self.bundle(target="darwin/arm64"), self.root / "assets")
        output = self.root / "Formula/areal.rb"
        release.formula(archive, output)
        text = output.read_text()
        self.assertIn(hashlib.sha256(archive.read_bytes()).hexdigest(), text)
        self.assertIn("/v0.1.0/" + archive.name, text)
        self.assertIn('prefix.install "bin", "libexec", "manifest.json", "LICENSE"', text)
        self.assertNotIn("PLACEHOLDER", text)

    def test_formula_platforms_and_beta_are_isolated(self):
        for version in ["0.1.7", "0.1.7-beta.2"]:
            mac = release.archive(self.bundle(version, "darwin/arm64"), self.root / version)
            linux = release.archive(self.bundle(version, "linux/x86_64"), self.root / version)
            output = self.root / (version + ".rb")
            release.formula(mac, output, extra_archives=[linux])
            text = output.read_text()
            self.assertIn("on_linux do", text)
            self.assertIn("on_macos do", text)
            self.assertIn(hashlib.sha256(linux.read_bytes()).hexdigest(), text)
            self.assertEqual('keg_only "the beta channel is opt-in' in text, "-beta." in version)
            self.assertEqual("class ArealBeta" in text, "-beta." in version)
            self.assertIn("/usr/bin/bwrap", text)
            with self.assertRaises(ValueError):
                release.formula(mac, output, extra_archives=[mac])
            with self.assertRaises(ValueError):
                release.formula(mac, output, url="file:///tmp/local", extra_archives=[linux])

    def test_release_rejects_dirty_or_debug_bundles(self):
        bundle = self.bundle()
        p = bundle / "manifest.json"
        data = json.loads(p.read_text())
        for field, value in [
            ("workingTree", True),
            ("profile", "debug"),
            ("sourceRevision", "unknown"),
        ]:
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
        self.private_shell(repository)

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
                    self.assertEqual(len(calls), len(names) + 2)
                    self.assertEqual(
                        manifest["thirdPartyComponents"][0]["license"], "GPL-3.0-or-later"
                    )
                    self.assertTrue(
                        (destination / "libexec/areal/shells/corresponding-source.tar.gz").is_file()
                    )
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
                self.root / ("assets-" + version),
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

    def test_release_outputs_are_never_overwritten(self):
        bundle = self.bundle()
        output = self.root / "assets"
        archive = release.archive(bundle, output)
        before = {p.name: p.read_bytes() for p in output.iterdir()}
        with self.assertRaisesRegex(ValueError, "already exists"):
            release.archive(bundle, output)
        archive.unlink()
        # 即使归档缺失，也不能覆盖既有摘要和来源清单。
        with self.assertRaisesRegex(ValueError, "already exists"):
            release.archive(bundle, output)
        self.assertEqual(
            {p.name: p.read_bytes() for p in output.iterdir()},
            {name: content for name, content in before.items() if name != archive.name},
        )


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

    def test_local_reuse_preserves_core_revision_but_rejects_changed_inputs(self):
        info = {"sourceRevision": "A", "inputHash": "same", "workingTree": "false",
                "apiVersion": "core.v1", "stateVersion": 1}
        metadata = {"apiVersion": "core.v1", "stateVersion": 1}
        self.assertEqual(package.validate_build_info(
            info, "B", "same", metadata, reuse_core=True), info)
        with self.assertRaises(ValueError):
            package.validate_build_info(info, "B", "changed", metadata, reuse_core=True)
