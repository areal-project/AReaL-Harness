#!/usr/bin/env python3
"""Exercise the trusted task-catalog CLI against isolated published ledgers."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest


def encoded(value):
    return json.dumps(value, separators=(",", ":")).encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def usage():
    return {
        "inputTokens": 0,
        "cachedInputTokens": 0,
        "outputTokens": 0,
        "tokensUsed": 0,
        "reservedTokens": 0,
        "unknownRequests": 0,
        "timeUsedSeconds": 0.0,
        "turnsStarted": 0,
        "accountingComplete": True,
    }


def task(task_id, mode="scheduled", source="origin", objective=None):
    return {
        "id": task_id,
        "revision": 7,
        "channelSequence": 1,
        "sourceThreadId": source,
        "owner": "fixture",
        "mode": mode,
        "interactionMode": "interactive",
        "objective": objective or task_id,
        "threadId": None,
        "schedule": {"at": 4102444800, "intervalSeconds": 3600},
        "nextRunAt": 4102444800,
        "paused": False,
        "cancelled": False,
        "tokenBudget": None,
        "maxTurns": None,
        "maxActiveSeconds": None,
        "archivedRunCount": 2,
        "runCount": 3,
        "runsComplete": False,
        "runs": [
            {
                "id": task_id + "-run",
                "threadId": None,
                "goalId": None,
                "status": "running",
                "reason": None,
                "scheduledAt": 0,
                "completedAt": None,
                "usage": usage(),
                "waitRequested": False,
            }
        ],
        "messages": [
            {
                "id": "question",
                "sequence": 1,
                "runId": task_id + "-run",
                "author": "fixture",
                "kind": "question",
                "status": "pending",
                "createdAt": 0,
                "expiresAt": None,
                "questions": [],
                "required": True,
                "inReplyTo": None,
                "answers": None,
                "text": "Continue?",
            }
        ],
    }


class CatalogSmoke(unittest.TestCase):
    binary = None

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="areal-task-catalog-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.workspace = self.root / "workspace"
        self.data = self.root / "state"
        self.home = self.root / "home"
        self.workspace.mkdir()
        self.data.mkdir()
        self.home.mkdir()
        (self.home / "config.toml").write_text("not valid toml = [")
        self.bind()

    def bind(self, workspace=None):
        binding = self.data / "service-workspace"
        binding.write_bytes(encoded(str(workspace or self.workspace)))
        binding.chmod(0o600)

    def publish(self, tasks, install=True):
        ledger = self.data / "desktop/task-ledger"
        ledger.mkdir(parents=True, exist_ok=True)
        heads = {}
        for row in tasks:
            body = encoded(row)
            body_digest = digest(body)
            (ledger / body_digest).write_bytes(body)
            heads[digest(row["id"].encode())] = {
                "body": body_digest,
                "hot_bytes": len(body),
                "history": None,
                "history_segments": 0,
                "archived_count": row["archivedRunCount"],
                "usage": usage(),
                "settlement_limit": max(len(body), 1024 * 1024),
            }
        root = encoded(
            {
                "version": 5,
                "tasks": heads,
                "receipts": {},
                "bindings": {},
                "index_version": 3,
                "preparations": None,
            }
        )
        if install:
            (self.data / "desktop/task-mode.json").write_bytes(root)
        return root

    def invoke(self, *args, success=True, data=None):
        result = subprocess.run(
            [
                str(self.binary),
                "service",
                "task-catalog",
                "--workspace",
                str(self.workspace),
                "--data-dir",
                str(data or self.data),
                "--json",
                *args,
            ],
            cwd=self.workspace,
            env={
                "PATH": "/usr/bin:/bin",
                "HOME": str(self.home),
                "AREAL_HARNESS_HOME": str(self.home),
                "AREAL_HARNESS_SERVICE_HOME": str(self.home / "service-home"),
            },
            capture_output=True,
            text=True,
            timeout=15,
        )
        if success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        if result.stdout:
            return json.loads(result.stdout)
        try:
            return json.loads(result.stderr)
        except json.JSONDecodeError:
            return {"stderr": result.stderr}

    def test_published_projection_filters_before_limiting_without_recovery(self):
        tombstone = task("a-deleted")
        tombstone["deletedAt"] = 123
        settled = task("0-settled")
        settled["deletedAt"] = 123
        settled["runs"][0]["status"] = "completed"
        settled["messages"] = []
        worker = task("b-deleted-worker")
        worker["deletedAt"] = 123
        worker["runs"][0]["status"] = "completed"
        worker["runs"][0]["workers"] = [{"status": "running", "settled": False}]
        root = self.publish(
            [
                task("z-scheduled"),
                task("0-background", "background"),
                task("1-other", source="other"),
                tombstone,
                settled,
                worker,
            ]
        )
        value = self.invoke("--source-thread-id", "origin", "--limit", "1")
        self.assertEqual(value["version"], 1)
        self.assertEqual(value["source"], "published")
        self.assertEqual(value["executionState"], "unobserved")
        self.assertEqual(
            value["target"],
            {
                "workspace": str(self.workspace),
                "dataDir": str(self.data),
                "instanceId": digest(os.fsencode(self.data))[:24],
            },
        )
        catalog = value["catalog"]
        self.assertEqual(catalog["kind"], "snapshot")
        self.assertEqual(catalog["rootDigest"], digest(root))
        self.assertTrue(catalog["hasMore"])
        self.assertEqual([row["id"] for row in catalog["data"]], ["a-deleted"])
        row = catalog["data"][0]
        self.assertEqual(row["deletedAt"], 123)
        self.assertEqual(row["revision"], 7)
        self.assertEqual(row["runs"][0]["status"], "running")
        self.assertEqual(row["runCount"], 3)
        self.assertEqual(row["pendingQuestions"], 1)
        self.assertNotIn("messages", row)
        visible = self.invoke("--source-thread-id", "origin")["catalog"]
        self.assertEqual(
            [row["id"] for row in visible["data"]],
            [
                "a-deleted",
                "b-deleted-worker",
                "z-scheduled",
            ],
        )
        self.assertFalse(visible["hasMore"])
        empty = self.invoke("--source-thread-id", "missing")["catalog"]
        self.assertEqual(empty["kind"], "snapshot")
        self.assertEqual(empty["data"], [])
        self.assertFalse(empty["hasMore"])

    def test_absent_unbound_and_legacy_are_distinct(self):
        self.assertEqual(self.invoke()["catalog"], {"kind": "empty"})
        (self.data / "service-workspace").unlink()
        self.assertEqual(self.invoke()["catalog"], {"kind": "requiresCore", "reason": "unbound"})
        self.assertEqual(self.invoke(data=self.root / "missing")["catalog"]["reason"], "unbound")
        self.assertFalse((self.root / "missing").exists())
        self.bind()
        (self.data / "desktop").mkdir()
        path = self.data / "desktop/task-mode.json"
        original = encoded({"version": 3, "tasks": {}, "receipts": []})
        path.write_bytes(original)
        self.assertEqual(
            self.invoke()["catalog"], {"kind": "requiresCore", "reason": "legacyFormat"}
        )
        self.assertEqual(path.read_bytes(), original)
        self.assertFalse((self.data / "desktop/task-legacy").exists())

    def test_reader_ignores_lifecycle_locks_and_writes_nothing(self):
        self.publish([task("persisted")])
        registry = self.home / "service-home/services" / digest(os.fsencode(self.data))[:24]
        registry.mkdir(parents=True)
        handles = []
        for path in [registry / "start.lock", self.data / "service.lock", self.data / "owner.lock"]:
            handle = path.open("w")
            self.addCleanup(handle.close)
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            handles.append(handle)
        before = self.files()
        for path in self.data.rglob("*"):
            if path.is_file():
                path.chmod(0o400)
        self.assertEqual(self.invoke()["catalog"]["data"][0]["id"], "persisted")
        self.assertEqual(self.files(), before)

    def files(self):
        return {
            str(path.relative_to(self.root)): (digest(path.read_bytes()), path.stat().st_mtime_ns)
            for path in self.root.rglob("*")
            if path.is_file()
        }

    def test_corrupt_references_and_unsupported_formats_fail_closed(self):
        self.publish([task("valid")])
        path = self.data / "desktop/task-mode.json"
        valid = json.loads(path.read_bytes())
        for change in [
            lambda root: root.update(version=99),
            lambda root: root.update(index_version=2),
            lambda root: root.update(unrecognized=True),
            lambda root: next(iter(root["tasks"].values())).update(body="../escape"),
            lambda root: next(iter(root["tasks"].values())).update(hot_bytes=1),
        ]:
            root = json.loads(encoded(valid))
            change(root)
            body = encoded(root)
            path.write_bytes(body)
            self.assertIn("error", self.invoke(success=False))
            self.assertEqual(path.read_bytes(), body)
        path.write_bytes(encoded(valid))
        leaf = self.data / "desktop/task-ledger" / next(iter(valid["tasks"].values()))["body"]
        original = leaf.read_bytes()
        leaf.write_bytes(b"x" * len(original))
        self.assertIn("error", self.invoke(success=False))
        leaf.unlink()
        self.assertIn("error", self.invoke(success=False))

    def test_binding_mismatch_and_symlinks_do_not_become_empty(self):
        other = self.root / "other"
        other.mkdir()
        self.bind(other)
        self.assertIn("error", self.invoke(success=False))
        self.bind()
        self.publish([task("valid")])
        path = self.data / "desktop/task-mode.json"
        original = path.read_bytes()
        path.unlink()
        path.symlink_to(self.root / "absent-root")
        self.assertIn("error", self.invoke(success=False))
        path.unlink()
        path.write_bytes(original)
        root = json.loads(original)
        leaf = self.data / "desktop/task-ledger" / next(iter(root["tasks"].values()))["body"]
        leaf.unlink()
        leaf.symlink_to(self.root / "absent-leaf")
        self.assertIn("error", self.invoke(success=False))

    def test_oversized_hot_state_requires_core_without_partial_rows(self):
        row = task("large")
        row["messages"][0]["text"] = "x" * (33 * 1024 * 1024)
        self.publish([task("small"), row])
        self.assertEqual(
            self.invoke()["catalog"],
            {
                "kind": "requiresCore",
                "reason": "readBudgetExceeded",
            },
        )

    def test_atomic_root_replacement_keeps_each_response_coherent(self):
        roots = [
            self.publish([task(str(i), objective=marker) for i in range(3)], install=False)
            for marker in ["old", "new"]
        ]
        path = self.data / "desktop/task-mode.json"
        path.write_bytes(roots[0])
        stopped = threading.Event()
        failures = []

        def writer():
            try:
                while not stopped.is_set():
                    for root in roots:
                        temporary = path.with_suffix(".replacement")
                        temporary.write_bytes(root)
                        temporary.replace(path)
            except BaseException as error:
                failures.append(error)

        thread = threading.Thread(target=writer)
        thread.start()
        try:
            for _ in range(12):
                catalog = self.invoke()["catalog"]
                marker = "old" if catalog["rootDigest"] == digest(roots[0]) else "new"
                self.assertIn(catalog["rootDigest"], [digest(root) for root in roots])
                self.assertEqual([row["objective"] for row in catalog["data"]], [marker] * 3)
        finally:
            stopped.set()
            thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(failures, [])

    def test_limit_and_principal_arguments_are_rejected(self):
        self.publish([task("valid")])
        for args in [("--limit", "0"), ("--limit", "1025"), ("--thread-ids", "origin")]:
            self.invoke(*args, success=False)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=Path("target/debug/areal"))
    parser.add_argument("tests", nargs="*")
    options = parser.parse_args()
    CatalogSmoke.binary = options.binary.resolve()
    unittest.main(argv=[sys.argv[0], *options.tests], verbosity=2)
