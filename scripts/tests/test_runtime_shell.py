import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
VERSION = "GNU bash, version 5.3.20(1)-release"

spec = importlib.util.spec_from_file_location(
    "runtime_shell", ROOT / "scripts/prepare-runtime-shell.py"
)
shell = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shell)


class RuntimeShellCacheTests(unittest.TestCase):
    def test_key_changes_with_native_build_inputs(self):
        with (
            patch.object(shell.subprocess, "check_output", side_effect=["clang A", "15.4"]),
            patch.object(shell.platform, "mac_ver", return_value=("15.4", (), "")),
        ):
            identity = shell.build_identity(ROOT)
        for field in identity:
            with self.subTest(field=field):
                changed = {**identity, field: [identity[field], "changed"]}
                self.assertNotEqual(shell.cache_key(identity), shell.cache_key(changed))

    def fixture(self, root):
        lock = root / "runtime/host-tools/bash.lock.json"
        lock.parent.mkdir(parents=True)
        lock.write_text(json.dumps({"version": "fixture", "minimumMacOSVersion": "15.0"}))
        identity = {"lockSha256": shell.digest(lock), "compiler": "fixture compiler"}
        build = root / "target/runtime-shell" / shell.cache_key(identity)
        build.mkdir(parents=True)
        for name in ["bash", "corresponding-source.tar.gz", "COPYING"]:
            (build / name).write_text("fixture " + name)
        (build / "bash").chmod(0o755)
        metadata = {
            **identity,
            "binarySha256": shell.digest(build / "bash"),
            "sourceSha256": shell.digest(build / "corresponding-source.tar.gz"),
            "licenseSha256": shell.digest(build / "COPYING"),
        }
        (build / "build.json").write_text(json.dumps(metadata))
        return identity, build

    def test_complete_verified_cache_restores_without_download_or_compile(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            identity, build = self.fixture(root)
            with (
                patch.object(shell, "build_identity", return_value=identity),
                patch.object(shell, "fetch", side_effect=AssertionError("unexpected download")),
                patch.object(
                    shell.subprocess, "run", side_effect=AssertionError("unexpected compile")
                ),
            ):
                for profile in ["debug", "release"]:
                    output = root / "target" / profile / "shells"
                    shell.prepare(root, output)
                    self.assertTrue(os.access(output / "bash", os.X_OK))
                    for name in ["bash", "COPYING", "corresponding-source.tar.gz", "build.json"]:
                        self.assertEqual((output / name).read_bytes(), (build / name).read_bytes())

    def test_corrupt_or_wrong_identity_cache_fails_closed(self):
        for name in ["bash", "corresponding-source.tar.gz", "COPYING", "build.json"]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                identity, build = self.fixture(root)
                if name == "build.json":
                    metadata = json.loads((build / name).read_text())
                    metadata["compiler"] = "different compiler"
                    (build / name).write_text(json.dumps(metadata))
                else:
                    (build / name).write_text("corrupt")
                with patch.object(shell, "build_identity", return_value=identity):
                    with self.assertRaisesRegex(ValueError, "identity mismatch|checksum mismatch"):
                        shell.prepare(root, root / "output")
                self.assertFalse((root / "output").exists())


@unittest.skipUnless(platform.system() == "Darwin", "macOS private shell builder")
class RuntimeShellTests(unittest.TestCase):
    def test_cold_build_with_spaced_paths_and_subdirectory_compilers(self):
        with tempfile.TemporaryDirectory(prefix="areal-shell-test-") as temporary:
            fixture = Path(temporary)
            source = fixture / "source" / "bash-fixture"
            source.mkdir(parents=True)
            (source / "COPYING").write_text("fixture license\n")
            (source / "version.c").write_text(
                '#include <stdio.h>\nint main(void) { puts("' + VERSION + '"); return 0; }\n'
            )
            configure = source / "configure"
            configure.write_text(
                "#!/bin/sh\nset -eu\n"
                'printf "%s\\n" "$CC" > config.log\n'
                "mkdir probe builtins\n"
                "(cd probe; $CC ../version.c -o conftest; ./conftest)\n"
                'printf "CC = %s\\n" "$CC" > Makefile\n'
                "cat >> Makefile <<'MAKE'\n"
                "bash:\n"
                "\t$(MAKE) -C builtins helper\n"
                "\t$(CC) version.c -o bash\n"
                "MAKE\n"
                'printf "CC = %s\\n" "$CC" > builtins/Makefile\n'
                "cat >> builtins/Makefile <<'MAKE'\n"
                "helper:\n"
                "\t$(CC) ../version.c -o mkversion\n"
                "\ttest -x mkversion.native\n"
                "\t/usr/bin/codesign --verify --strict mkversion.native\n"
                "\ttest \"$$('./mkversion')\" = '" + VERSION + "'\n"
                "MAKE\n"
            )
            configure.chmod(0o755)
            archive = fixture / "bash-fixture.tar.gz"
            with tarfile.open(archive, "w:gz") as stream:
                stream.add(source, arcname="bash-fixture")
            selected_python = fixture / "selected Python" / "python3"
            selected_python.parent.mkdir()
            selected_python.symlink_to(sys.executable)
            runner = fixture / "prepare.py"
            runner.write_text(
                "import runpy, sys, tempfile\n"
                "from pathlib import Path\n"
                "tempfile.tempdir = sys.argv[2]\n"
                "sys.executable = sys.argv[5]\n"
                "runpy.run_path(sys.argv[1])['prepare'](Path(sys.argv[3]), Path(sys.argv[4]))\n"
            )
            for name, python in [
                ("wrapper path", sys.executable),
                ("Python path", selected_python),
            ]:
                with self.subTest(name=name):
                    repository = fixture / name
                    lock_path = repository / "runtime/host-tools/bash.lock.json"
                    lock_path.parent.mkdir(parents=True)
                    lock_path.write_text(
                        json.dumps(
                            {
                                "version": "5.3.20",
                                "minimumMacOSVersion": "15.0",
                                "sourceDirectory": "bash-fixture",
                                "archive": {
                                    "name": archive.name,
                                    "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                                    "urls": [],
                                },
                                "patches": [],
                            }
                        )
                    )
                    (repository / archive.name).write_bytes(archive.read_bytes())
                    work = repository / "temporary work"
                    work.mkdir()
                    output = repository / "output shells"
                    command = [
                        str(python),
                        str(runner),
                        str(ROOT / "scripts/prepare-runtime-shell.py"),
                        str(work),
                        str(repository),
                        str(output),
                        str(python),
                    ]
                    result = subprocess.run(
                        command,
                        text=True,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        timeout=60,
                    )
                    self.assertEqual(result.returncode, 0, result.stdout)
                    self.assertEqual(
                        subprocess.check_output(
                            [
                                "/usr/bin/python3",
                                "-I",
                                "-S",
                                "-c",
                                "import subprocess,sys; sys.stdout.buffer.write(subprocess.check_output(sys.argv[1:]))",
                                str(output / "bash"),
                                "--version",
                            ],
                            text=True,
                        ).strip(),
                        VERSION,
                    )
                    self.assertEqual((output / "sh").read_bytes(), (output / "bash").read_bytes())
                    subprocess.run(
                        ["/usr/bin/codesign", "--verify", "--strict", str(output / "bash")],
                        check=True,
                        capture_output=True,
                    )
                    metadata = json.loads((output / "build.json").read_text())
                    self.assertEqual(metadata["version"], "5.3.20")
                    self.assertEqual(metadata["minimumMacOSVersion"], "15.0")
                    for field, path in [
                        ("lockSha256", lock_path),
                        ("builderSha256", ROOT / "scripts/prepare-runtime-shell.py"),
                        ("binarySha256", output / "bash"),
                        ("sourceSha256", output / "corresponding-source.tar.gz"),
                    ]:
                        self.assertEqual(
                            metadata[field], hashlib.sha256(path.read_bytes()).hexdigest()
                        )
                    with tarfile.open(output / "corresponding-source.tar.gz") as stream:
                        self.assertEqual(
                            stream.getnames(),
                            [
                                archive.name,
                                "runtime/host-tools/bash.lock.json",
                                "scripts/prepare-runtime-shell.py",
                            ],
                        )
                    before = {path.name: path.read_bytes() for path in output.iterdir()}
                    cached = subprocess.run(
                        command,
                        text=True,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        timeout=60,
                    )
                    self.assertEqual(cached.returncode, 0, cached.stdout)
                    self.assertNotIn("Preparing pinned Bash", cached.stdout)
                    self.assertEqual(
                        {path.name: path.read_bytes() for path in output.iterdir()}, before
                    )
                    self.assertEqual(list(work.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
