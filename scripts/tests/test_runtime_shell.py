import hashlib
import json
from pathlib import Path
import platform
import subprocess
import sys
import tarfile
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
VERSION = "GNU bash, version 5.3.20(1)-release"


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
