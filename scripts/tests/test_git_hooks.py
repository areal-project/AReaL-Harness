"""通过临时 Git 仓库验证暂存快照、推送身份和真实子进程失败传播。"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class GitHooks(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "checkout"
        self.root.mkdir()
        local_variables = subprocess.run(
            ["git", "rev-parse", "--local-env-vars"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=True,
        ).stdout.splitlines()
        self.env = {
            **{key: value for key, value in os.environ.items() if key not in local_variables},
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
        }
        self.git("init", "-q")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.test")
        for name in (
            "scripts/git-hooks.py",
            "scripts/ci-scope.py",
            "clients/gui/scripts/test-manifest.mjs",
            "clients/gui/scripts/test-manifest.json",
            ".githooks/pre-commit",
            ".githooks/pre-push",
        ):
            self.put(name, (ROOT / name).read_text()).chmod((ROOT / name).stat().st_mode)
        self.put(
            ".gitignore", "node_modules/\n.local/\n.venv/\ntarget/\npreflight-ran\nnested.git/\n"
        )
        self.put("package.json", "{}\n")
        self.put(
            "clients/gui/package.json",
            json.dumps(
                {
                    "devDependencies": {"vite-plus": "1.4.0"},
                    "scripts": {
                        entry["script"]: "true"
                        for entry in json.loads(
                            (ROOT / "clients/gui/scripts/test-manifest.json").read_text()
                        )
                    },
                }
            ),
        )
        self.put("clients/gui/renderer/src/example.ts", "initial\n")
        self.put("format-input.txt", "formatted\n")
        self.put(
            "Makefile",
            "fmt-check:\n\t@python3 -c \"from pathlib import Path; import sys; sys.exit(17 if Path('format-input.txt').read_text().strip() != 'formatted' else 0)\"\ncheck-changed:\n\t@python3 -c \"from pathlib import Path; Path('preflight-ran').write_text('$(CI_BASE)')\"\nci-preflight:\n\t@exit 99\n",
        )
        self.put(
            "scripts/check-workflows.py",
            "import pathlib,sys\nsys.exit(31 if any('invalid' in pathlib.Path(p).read_text() for p in sys.argv[1:]) else 0)\n",
        )
        self.put(".github/workflows/fixture.yml", "valid\n")
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        self.initial = self.git("rev-parse", "HEAD").stdout.strip()
        self.remote = Path(self.temporary.name) / "remote.git"
        self.git("init", "--bare", "-q", str(self.remote))
        self.git("remote", "add", "upstream", str(self.remote))
        self.git("push", "-q", "upstream", "HEAD:refs/heads/main")
        self.git("fetch", "-q", "upstream", "main")
        self.put("clients/gui/node_modules/vite-plus/package.json", '{"version":"1.4.0"}\n')
        self.put(
            "clients/gui/node_modules/vite-plus/bin/vp",
            "const fs=require('node:fs');process.exit(fs.readFileSync('renderer/src/example.ts','utf8').trim()==='staged'?0:23);\n",
        )

    def put(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def run_command(self, *args, input=None):
        return subprocess.run(
            args, cwd=self.root, env=self.env, input=input, text=True, capture_output=True
        )

    def git(self, *args):
        result = self.run_command("git", *args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def hook(self, operation, input=None):
        return self.run_command(sys.executable, "scripts/git-hooks.py", operation, input=input)

    def install(self):
        return self.run_command(
            sys.executable, "scripts/git-hooks.py", "install", "--base", "upstream/main"
        )

    def push_input(self, sha=None):
        return f"refs/heads/main {sha or self.initial} refs/heads/main {'0' * 40}\n"

    def test_install_refuses_existing_foreign_hook_path_and_nonremote_base(self):
        self.git("config", "core.hooksPath", "other-hooks")
        self.assertNotEqual(self.install().returncode, 0)
        self.assertEqual(self.git("config", "core.hooksPath").stdout.strip(), "other-hooks")
        self.git("config", "--unset", "core.hooksPath")
        invalid = self.run_command(
            sys.executable, "scripts/git-hooks.py", "install", "--base", "HEAD"
        )
        self.assertNotEqual(invalid.returncode, 0)
        self.assertEqual(self.install().returncode, 0)
        self.assertEqual(self.git("config", "core.hooksPath").stdout.strip(), ".githooks")
        self.assertEqual(
            self.git("config", "areal.ciBase").stdout.strip(), "refs/remotes/upstream/main"
        )

    def test_precommit_uses_index_not_unstaged_source_and_preserves_files(self):
        self.put("clients/gui/renderer/src/example.ts", "staged\n")
        self.git("add", "clients/gui/renderer/src/example.ts")
        self.put("clients/gui/renderer/src/example.ts", "unstaged-invalid\n")
        result = self.hook("pre-commit")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            (self.root / "clients/gui/renderer/src/example.ts").read_text(), "unstaged-invalid\n"
        )
        self.assertEqual(
            self.git("show", ":clients/gui/renderer/src/example.ts").stdout, "staged\n"
        )

    def test_staged_manifest_failure_cannot_be_hidden_by_unstaged_repair(self):
        manifest = self.root / "clients/gui/scripts/test-manifest.json"
        original = manifest.read_text()
        manifest.write_text("[]\n")
        self.git("add", "clients/gui/scripts/test-manifest.json")
        manifest.write_text(original)
        result = self.hook("pre-commit")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Unregistered tests", result.stderr)
        self.assertEqual(manifest.read_text(), original)

    def test_deleted_source_is_in_staged_impact_plan(self):
        self.git("rm", "clients/gui/renderer/src/example.ts")
        result = self.hook("pre-commit")
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads((self.root / "target/ci/staged-plan.json").read_text())
        self.assertIn("clients/gui/renderer/src/example.ts", plan["paths"])
        self.assertEqual(plan["source"]["validationTarget"], "index-plan-only")
        self.assertIn("smoke:test:composer", {item["id"] for item in plan["items"]})

    def test_prepush_rejects_untracked_source(self):
        self.assertEqual(self.install().returncode, 0)
        self.put("clients/gui/renderer/src/uncommitted.ts", "required source\n")
        result = self.hook("pre-push", self.push_input())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Untracked inputs", result.stderr)
        self.assertFalse((self.root / "preflight-ran").exists())

    def test_prepush_cannot_inherit_plan_only_arguments(self):
        makefile = self.root / "Makefile"
        makefile.write_text(
            makefile.read_text().replace(
                "check-changed:\n", 'check-changed:\n\t@test "$(ARGS)" = ""\n'
            )
        )
        self.git("add", "Makefile")
        self.git("commit", "-qm", "require real quick execution")
        self.assertEqual(self.install().returncode, 0)
        self.env["ARGS"] = "--plan"
        result = self.hook(
            "pre-push", self.push_input(self.git("rev-parse", "HEAD").stdout.strip())
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.root / "preflight-ran").exists())

    def test_precommit_preserves_gui_and_workflow_failure_exit_codes(self):
        self.put("clients/gui/renderer/src/example.ts", "invalid\n")
        self.git("add", "clients/gui/renderer/src/example.ts")
        self.assertEqual(self.hook("pre-commit").returncode, 23)
        self.put("clients/gui/renderer/src/example.ts", "staged\n")
        self.git("add", "clients/gui/renderer/src/example.ts")
        self.put(".github/workflows/fixture.yml", "invalid\n")
        self.git("add", ".github/workflows/fixture.yml")
        self.assertEqual(self.hook("pre-commit").returncode, 31)

    def test_precommit_runs_repository_format_check_on_staged_snapshot(self):
        self.put("format-input.txt", "invalid\n")
        self.git("add", "format-input.txt")
        self.put("format-input.txt", "formatted\n")
        self.assertNotEqual(self.hook("pre-commit").returncode, 0)

    def test_prepush_rejects_dirty_or_different_sha_and_allows_deleted_refs(self):
        self.assertEqual(self.install().returncode, 0)
        self.put("format-input.txt", "dirty\n")
        self.assertNotEqual(self.hook("pre-push", self.push_input()).returncode, 0)
        self.assertFalse((self.root / "preflight-ran").exists())
        self.git("restore", "format-input.txt")
        self.put("format-input.txt", "staged-dirty\n")
        self.git("add", "format-input.txt")
        self.put("format-input.txt", "formatted\n")
        self.assertNotEqual(self.hook("pre-push", self.push_input()).returncode, 0)
        self.assertFalse((self.root / "preflight-ran").exists())
        self.git("restore", "--staged", "format-input.txt")
        self.assertNotEqual(self.hook("pre-push", self.push_input("f" * 40)).returncode, 0)
        self.assertFalse((self.root / "preflight-ran").exists())
        self.assertEqual(self.hook("pre-push", self.push_input("0" * 40)).returncode, 0)

    def test_prepush_fetches_remote_base_and_runs_preflight_on_same_head(self):
        self.assertEqual(self.install().returncode, 0)
        advanced = self.run_command(
            "git",
            "commit-tree",
            f"{self.initial}^{{tree}}",
            "-p",
            self.initial,
            input="remote advance\n",
        )
        self.assertEqual(advanced.returncode, 0, advanced.stderr)
        remote_sha = advanced.stdout.strip()
        self.git(
            "-c",
            "core.hooksPath=/dev/null",
            "push",
            "-q",
            "upstream",
            f"{remote_sha}:refs/heads/main",
        )
        self.git("update-ref", "refs/remotes/upstream/main", self.initial)
        result = self.hook("pre-push", self.push_input())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "preflight-ran").read_text(), remote_sha)
        self.assertEqual(self.git("rev-parse", "HEAD").stdout.strip(), self.initial)

    def test_prepush_preserves_preflight_failure_exit_code(self):
        self.put(
            "Makefile",
            "fmt-check:\n\t@true\ncheck-changed:\n\t@python3 -c 'import sys; sys.exit(19)'\n",
        )
        self.git("add", "Makefile")
        self.git("commit", "-qm", "failing preflight")
        head = self.git("rev-parse", "HEAD").stdout.strip()
        self.assertEqual(self.install().returncode, 0)
        self.assertEqual(self.hook("pre-push", self.push_input(head)).returncode, 2)

    def test_git_push_preflight_does_not_leak_caller_git_environment(self):
        self.put(
            "Makefile",
            "fmt-check:\n\t@true\ncheck-changed:\n\t@python3 scripts/nested-repository.py\n",
        )
        self.put(
            "scripts/nested-repository.py",
            "from pathlib import Path\nimport subprocess\n"
            "Path('nested.git').mkdir()\n"
            "subprocess.run(['git', 'init', '--bare', '-q'], cwd='nested.git', check=True)\n"
            "subprocess.run(['git', '-C', 'nested.git', 'config', 'user.name', 'Nested'], check=True)\n"
            "assert Path('nested.git/config').is_file()\n",
        )
        self.git("add", ".")
        self.git("commit", "-qm", "nested repository preflight")
        self.assertEqual(self.install().returncode, 0)
        config = (self.root / ".git/config").read_bytes()
        index = (self.root / ".git/index").read_bytes()
        head = self.git("rev-parse", "HEAD").stdout.strip()
        result = subprocess.run(
            ["git", "push", "-q", "upstream", "HEAD:refs/heads/topic"],
            cwd=self.root,
            env={**self.env, "GIT_DIR": str(self.root / ".git")},
            text=True,
            capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / ".git/config").read_bytes(), config)
        self.assertEqual((self.root / ".git/index").read_bytes(), index)
        self.assertEqual(self.git("rev-parse", "HEAD").stdout.strip(), head)
        self.assertEqual(
            self.git("ls-remote", "upstream", "refs/heads/topic").stdout.split()[0], head
        )
        self.assertEqual(
            self.git("-C", "nested.git", "config", "user.name").stdout.strip(), "Nested"
        )

    def test_git_hooks_prefer_repository_tools_over_caller_path(self):
        self.assertEqual(self.install().returncode, 0)
        python = self.root / ".venv/bin/python3"
        python.parent.mkdir(parents=True)
        python.symlink_to(sys.executable)
        node = self.root / ".local/tools/node/bin/node"
        node.parent.mkdir(parents=True)
        node.symlink_to(shutil.which("node"))
        for name in ("python3", "node"):
            self.put(f".local/caller-bin/{name}", "#!/bin/sh\nexit 97\n").chmod(0o755)
        self.env["PATH"] = f"{self.root / '.local/caller-bin'}{os.pathsep}{self.env['PATH']}"
        self.put("format-input.txt", "formatted\n\n")
        self.git("add", "format-input.txt")
        self.git("commit", "-qm", "repository tools")
        self.git("push", "-q", "upstream", "HEAD:refs/heads/topic")
        self.assertEqual((self.root / "preflight-ran").read_text(), self.initial)
        self.assertEqual(
            self.git("ls-remote", "upstream", "refs/heads/topic").stdout.split()[0],
            self.git("rev-parse", "HEAD").stdout.strip(),
        )

    def test_git_commit_invokes_hook_and_retains_failed_index(self):
        self.assertEqual(self.install().returncode, 0)
        self.put("clients/gui/renderer/src/example.ts", "invalid\n")
        self.git("add", "clients/gui/renderer/src/example.ts")
        result = self.run_command("git", "commit", "-qm", "must reject")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.git("rev-parse", "HEAD").stdout.strip(), self.initial)
        self.assertEqual(
            self.git("show", ":clients/gui/renderer/src/example.ts").stdout, "invalid\n"
        )


if __name__ == "__main__":
    unittest.main()
