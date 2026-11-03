"""通过真实 Git 和 CLI 边界验证门禁；GitHub 使用合成程序，无远端写入。"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "pr-create.py"


class PullRequestTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="pr gate ")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.git("init", "-b", "codex/test")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        (self.repo / "version").write_text("1")
        self.git("add", ".")
        self.git("-c", "core.hooksPath=/dev/null", "commit", "-m", "initial")
        self.sha = self.git("rev-parse", "HEAD")
        self.body = self.root / "body.md"
        self.body.write_text("Test PR")
        self.calls = self.root / "calls.jsonl"
        gh = self.root / "gh"
        gh.write_text(
            f"#!{sys.executable}\n"
            + """import json, os, sys
args = sys.argv[1:]
with open(os.environ['CALLS'], 'a') as f:
    f.write(json.dumps(args) + '\\n')
mode = os.environ.get('MODE', '')
sha = os.environ['SHA']
if args[:2] == ['api', '--method']:
    assert args[2] == 'GET' and 'head=fork:codex/test' in args and 'state=open' in args
    print(json.dumps([{'url': 'https://github.com/base/repo/pull/1'}] if mode == 'exists' else []))
elif args[0] == 'api':
    if mode == 'read-error': sys.exit(1)
    print(json.dumps({'object': {'sha': '0' * 40 if mode == 'stale' else sha}}))
elif args[:2] == ['pr', 'create']:
    if mode == 'unknown': sys.exit(1)
    print('https://github.com/base/repo/pull/2')
elif args[:2] == ['pr', 'view']:
    if mode == 'view-error': sys.exit(1)
    print(json.dumps({'state': 'MERGED' if mode == 'merged' else 'OPEN', 'headRefOid': '0'*40 if mode == 'race' else sha,
        'headRefName': 'codex/test', 'baseRefName': 'main',
        'headRepository': {'name': 'other' if mode == 'wrong-repo' else 'repo'},
        'headRepositoryOwner': {'login': 'fork'}}))
else: sys.exit(2)
"""
        )
        gh.chmod(0o755)

    def git(self, *args):
        return subprocess.check_output(
            ["git", *args], cwd=self.repo, text=True, stderr=subprocess.PIPE
        ).strip()

    def run_gate(self, mode="", expected=None):
        return subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--repo",
                "base/repo",
                "--head-repo",
                "fork/repo",
                "--branch",
                "codex/test",
                "--base",
                "main",
                "--expected-head",
                expected or self.sha,
                "--title",
                "Test",
                "--body-file",
                str(self.body),
            ],
            cwd=self.repo,
            env={
                **os.environ,
                "PATH": str(self.root) + os.pathsep + os.environ["PATH"],
                "SHA": self.sha,
                "MODE": mode,
                "CALLS": str(self.calls),
            },
            text=True,
            capture_output=True,
        )

    def commands(self):
        return (
            [json.loads(line) for line in self.calls.read_text().splitlines()]
            if self.calls.exists()
            else []
        )

    def test_creates_only_after_published_head_matches_then_reads_receipt(self):
        result = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["headRefOid"], self.sha)
        calls = self.commands()
        self.assertEqual(
            [c[:2] for c in calls],
            [
                ["api", "repos/fork/repo/git/ref/heads/codex%2Ftest"],
                ["api", "--method"],
                ["pr", "create"],
                ["pr", "view"],
            ],
        )
        self.assertIn("fork:codex/test", calls[2])

    def test_stale_or_failed_remote_and_existing_pr_prevent_creation(self):
        for mode in ("stale", "read-error", "exists"):
            with self.subTest(mode=mode):
                result = self.run_gate(mode)
                self.assertEqual(result.returncode, 1)
        self.assertFalse(any(c[:2] == ["pr", "create"] for c in self.commands()))

    def test_dirty_or_wrong_local_identity_prevents_any_github_call(self):
        self.assertEqual(self.run_gate(expected="0" * 40).returncode, 1)
        self.assertEqual(self.run_gate(expected=self.sha[:8]).returncode, 1)
        (self.repo / "untracked").write_text("other task")
        self.assertEqual(self.run_gate().returncode, 1)
        self.assertEqual(self.commands(), [])

    def test_another_local_branch_prevents_any_github_call(self):
        self.git("switch", "-c", "codex/other-task")
        self.assertEqual(self.run_gate().returncode, 1)
        self.assertEqual(self.commands(), [])

    def test_changed_head_wrong_repo_and_read_failure_preserve_known_pr(self):
        for mode in ("race", "wrong-repo", "view-error", "merged"):
            with self.subTest(mode=mode):
                result = self.run_gate(mode)
                self.assertEqual(result.returncode, 1)
                self.assertIn("https://github.com/base/repo/pull/2", result.stderr)
                self.assertIn("do not recreate", result.stderr)
        self.assertEqual(sum(c[:2] == ["pr", "create"] for c in self.commands()), 4)

    def test_unknown_creation_is_not_retried(self):
        result = self.run_gate("unknown")
        self.assertEqual(result.returncode, 1)
        self.assertIn("unknown", result.stderr)
        self.assertEqual(sum(c[:2] == ["pr", "create"] for c in self.commands()), 1)


if __name__ == "__main__":
    unittest.main()
