"""在独立仓库验证共享选检、完整失败收集和输入漂移。"""

from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("check_changed", ROOT / "scripts/check-changed.py")
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)


class ChangedChecks(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.dict(os.environ, {"GITHUB_EVENT_PATH": ""}))
        self.directory = tempfile.TemporaryDirectory(prefix="areal-changed-check-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.git("init", "-q")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        (self.root / ".gitignore").write_text("target/\n")
        for name in ("source.rs", "delete.rs", "rename old.rs", "stage.rs", "mixed.rs"):
            (self.root / name).write_text("base\n")
        self.gui = self.root / "clients/gui"
        (self.gui / "scripts").mkdir(parents=True)
        self.manifest = json.loads((ROOT / "clients/gui/scripts/test-manifest.json").read_text())
        (self.gui / "scripts/test-manifest.json").write_text(json.dumps(self.manifest))
        self.git("add", ".")
        self.git("commit", "-qm", "base")
        self.base = self.git("rev-parse", "HEAD").strip()
        self.serial = 0

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, text=True)

    def plan(self, paths):
        return checks.ci_scope.build_plan(
            paths,
            {
                "baseRevision": self.base,
                "sourceRevision": self.base,
                "headRevision": self.base,
                "inputHash": checks.input_key(self.root, self.base),
            },
            self.manifest,
        )

    def item(self, name, dependencies=(), requires=()):
        return {
            "id": name,
            "command": [name],
            "group": "early",
            "dependsOn": list(dependencies),
            "requires": list(requires),
            "platforms": ["darwin", "linux"],
        }

    def execute(self, items, runner=None, key=None):
        plan = self.plan([])
        plan["items"] = items
        if key is not None:
            plan["source"]["inputHash"] = key
        self.serial += 1
        return checks.preflight.run_plan(
            plan,
            self.root,
            items,
            self.root / "target/ci" / str(self.serial),
            runner=runner or (lambda *a, **k: subprocess.CompletedProcess(a, 0)),
            capability_probe=lambda *args: set(),
        )

    def test_merge_base_diff_keeps_every_worktree_state_and_both_rename_paths(self):
        (self.root / "source.rs").write_text("committed\n")
        self.git("add", "source.rs")
        self.git("commit", "-qm", "branch")
        (self.root / "stage.rs").write_text("staged\n")
        (self.root / "mixed.rs").write_text("staged\n")
        self.git("add", "stage.rs", "mixed.rs")
        (self.root / "mixed.rs").write_text("unstaged\n")
        (self.root / "delete.rs").unlink()
        self.git("mv", "rename old.rs", "rename new.rs")
        (self.root / "未跟踪\nfile.rs").write_text("new\n")
        self.assertEqual(
            checks.changed_paths(self.root, self.base),
            sorted(
                [
                    "source.rs",
                    "stage.rs",
                    "mixed.rs",
                    "delete.rs",
                    "rename old.rs",
                    "rename new.rs",
                    "未跟踪\nfile.rs",
                ]
            ),
        )

    def test_shared_and_unknown_code_keep_behavior_budget_native_and_every_smoke(self):
        for path in (
            "schemas/areal-core-v1.json",
            "core/protocol/src/lib.rs",
            "Cargo.lock",
            "Makefile",
            "unmapped/new-driver.ts",
        ):
            with self.subTest(path=path):
                names = {item["id"] for item in self.plan([path])["items"]}
                self.assertTrue(
                    {
                        "rust-types",
                        "rust-behavior",
                        "portable:bundle",
                        "native-replay",
                        "legacy-native-access",
                        "relay-contracts",
                    }
                    <= names
                )
                self.assertEqual(
                    {entry["script"] for entry in self.manifest if entry.get("ciSmoke")},
                    {name.removeprefix("smoke:") for name in names if name.startswith("smoke:")},
                )
        self.assertEqual(
            self.plan(["unmapped/new-driver.ts"])["fallbackPaths"], ["unmapped/new-driver.ts"]
        )

    def test_staged_change_cancelled_in_worktree_remains_selected(self):
        original = checks.input_key(self.root, self.base)
        (self.root / "source.rs").write_text("staged-only\n")
        self.git("add", "source.rs")
        (self.root / "source.rs").write_text("base\n")
        self.assertEqual(checks.changed_paths(self.root, self.base), ["source.rs"])
        self.assertNotEqual(checks.input_key(self.root, self.base), original)
        self.assertTrue(self.plan(["source.rs"])["items"])

    def change_index_only(self):
        content = (self.root / "source.rs").read_bytes()
        blob = (
            subprocess.check_output(
                ["git", "hash-object", "-w", "--stdin"], cwd=self.root, input=b"index-only\n"
            )
            .decode()
            .strip()
        )
        self.git("update-index", "--cacheinfo", f"100644,{blob},source.rs")
        self.assertEqual((self.root / "source.rs").read_bytes(), content)

    def test_index_only_drift_marks_every_required_item_invalidated_without_execution(self):
        key = checks.input_key(self.root, self.base)
        self.change_index_only()
        result = self.execute(
            [self.item("a"), self.item("b")],
            key=key,
            runner=lambda *a, **k: self.fail("invalid inputs cannot execute"),
        )
        self.assertEqual(result["status"], "invalidated")
        self.assertEqual(
            [item["status"] for item in result["results"]], ["invalidated", "invalidated"]
        )

    def test_docs_do_not_require_gui_but_gui_requires_production_budget_and_interactions(self):
        docs = self.plan(["docs/features.md"])
        self.assertFalse(
            any(item["group"] in checks.ci_scope.WORKFLOW_GROUPS["gui"] for item in docs["items"])
        )
        self.assertIn("docs", {item["id"] for item in docs["items"]})
        gui = self.plan(["clients/gui/renderer/src/Composer.tsx"])
        self.assertTrue(
            {"portable:bundle", "gui-types", "smoke:test:composer"}
            <= {item["id"] for item in gui["items"]}
        )
        self.assertIn(
            "scripts", {item["id"] for item in self.plan(["scripts/ci-scope.py"])["items"]}
        )

    def test_relay_service_alone_cannot_skip_pinned_transport_and_authorization(self):
        self.assertTrue(checks.ci_scope.applicable("gui", ["services/remote-relay/src/server.mjs"]))
        plan = self.plan(["services/remote-relay/src/server.mjs"])
        relay = next(item for item in plan["items"] if item["id"] == "relay-contracts")
        self.assertIn("node-24.2.0", relay["requires"])
        self.assertEqual(relay["command"][-1], "test:remote-relay")

    def test_plan_resolves_base_without_executing_and_records_full_pending_scope(self):
        (self.root / "docs").mkdir()
        (self.root / "docs/new.md").write_text("Documentation fixture\n")
        output = io.StringIO()
        with (
            patch.object(checks, "ROOT", self.root),
            patch.object(checks.preflight, "run_plan", side_effect=AssertionError("plan only")),
            redirect_stdout(output),
        ):
            self.assertEqual(checks.main(["--base", self.base, "--plan"]), 0)
        value = json.loads(output.getvalue())
        self.assertEqual(value["plan"]["source"]["baseRevision"], self.base)
        self.assertEqual(value["plan"]["source"]["headRevision"], self.base)
        self.assertEqual(value["plan"]["paths"], ["docs/new.md"])
        self.assertEqual(
            value["plan"]["source"]["inputHash"], checks.input_key(self.root, self.base)
        )

    def test_empty_selection_is_explicit_and_still_rechecks_inputs(self):
        self.assertEqual(self.execute([])["results"], [])
        key = checks.input_key(self.root, self.base)
        (self.root / "source.rs").write_text("after planning\n")
        self.assertEqual(self.execute([], key=key)["status"], "invalidated")

    def test_empty_plan_index_only_drift_cannot_report_green(self):
        key = checks.input_key(self.root, self.base)
        self.change_index_only()
        self.assertEqual(self.execute([], key=key)["status"], "invalidated")

    def test_native_capability_omission_blocks_instead_of_selecting_a_smaller_green_set(self):
        calls = []
        result = self.execute(
            [self.item("native-in-wrong-lane", requires=("native-runtime",))],
            runner=lambda *a, **k: calls.append(a),
        )
        self.assertEqual(calls, [])
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["results"][0]["status"], "blocked")
        self.assertEqual(result["results"][0]["missingRequirements"], ["native-runtime"])

    def test_independent_failures_are_collected_and_only_real_dependencies_block(self):
        calls = []

        def runner(command, **kwargs):
            calls.append(command[0])
            return subprocess.CompletedProcess(command, 7 if command == ["a"] else 0)

        report = self.execute([self.item("a"), self.item("b"), self.item("c", ("a",))], runner)
        self.assertEqual(calls, ["a", "b"])
        self.assertEqual(
            [item["status"] for item in report["results"]], ["failed", "passed", "blocked"]
        )
        saved = json.loads((self.root / "target/ci/1/report.json").read_text())
        self.assertEqual(saved["results"][0]["exitCode"], 7)

    def history_report(self, name, revision, status, timestamp, platform="darwin"):
        path = self.root / "target/ci/failures" / name / "report.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "kind": "verification-report",
                    "identity": {"headRevision": revision},
                    "platform": platform,
                    "startedAt": timestamp,
                    "results": [
                        {"id": "smoke:test:composer", "status": status, "completedAt": timestamp}
                    ],
                }
            )
        )
        return path

    def test_failure_selection_uses_current_branch_and_latest_result_per_platform(self):
        self.history_report("merged", self.base, "failed", "2026-01-01T01:00:00Z")
        (self.root / "source.rs").write_text("branch\n")
        self.git("commit", "-am", "branch")
        head = self.git("rev-parse", "HEAD").strip()
        plan = self.plan(["clients/gui/renderer/src/Composer.tsx"])
        plan["source"]["headRevision"] = head
        self.assertEqual(checks.failure_checks(plan, self.root), {})
        failed = self.history_report("failed", head, "failed", "2026-01-01T02:00:00Z")
        self.assertEqual(
            checks.failure_checks(plan, self.root), {"smoke:test:composer": [str(failed)]}
        )
        self.history_report("other-platform-pass", head, "passed", "2026-01-01T03:00:00Z", "linux")
        self.assertIn("smoke:test:composer", checks.failure_checks(plan, self.root))
        self.history_report("passed", head, "passed", "2026-01-01T04:00:00Z")
        self.assertEqual(checks.failure_checks(plan, self.root), {})
        invalidated = self.history_report("invalidated", head, "passed", "2026-01-01T04:30:00Z")
        value = json.loads(invalidated.read_text())
        value["status"] = "invalidated"
        invalidated.write_text(json.dumps(value))
        self.assertEqual(
            checks.failure_checks(plan, self.root), {"smoke:test:composer": [str(invalidated)]}
        )
        foreign = self.history_report("foreign", "f" * 40, "failed", "2026-01-01T05:00:00Z")
        self.assertEqual(
            checks.failure_checks(plan, self.root), {"smoke:test:composer": [str(invalidated)]}
        )
        with self.assertRaisesRegex(ValueError, "outside the current branch"):
            checks.failure_checks(plan, self.root, [foreign])
        (self.root / "source.rs").write_text("next revision\n")
        self.git("commit", "-am", "next revision")
        next_head = self.git("rev-parse", "HEAD").strip()
        plan["source"]["headRevision"] = next_head
        current = self.history_report(
            "current-failure", next_head, "failed", "2026-01-01T06:00:00Z"
        )
        self.history_report("late-ancestor-pass", head, "passed", "2026-01-01T07:00:00Z")
        self.assertEqual(
            checks.failure_checks(plan, self.root), {"smoke:test:composer": [str(current)]}
        )

    def test_fast_selection_adds_failed_smoke_and_build_dependencies_without_full_suite(self):
        plan = self.plan(["clients/gui/renderer/src/Composer.tsx"])
        selected = checks.select_checks(
            plan, "commit", {"smoke:test:composer": ["failure/report.json"]}
        )
        names = {item["id"] for item in selected}
        self.assertTrue(
            {
                "gui-types",
                "portable:bundle",
                "smoke:test:composer",
                "gui-core-build",
                "macos:renderer",
            }
            <= names
        )
        self.assertNotIn("smoke:test:model-selection", names)
        self.assertNotIn("core-contracts", names)
        for item in selected:
            self.assertTrue(set(item["dependsOn"]) <= names)
        self.assertIn("smoke:test:model-selection", {item["id"] for item in plan["items"]})
        self.assertEqual(checks.select_checks(plan, "full", {}), plan["items"])

    def test_quick_command_executes_failed_special_with_dependencies_and_propagates_failure(self):
        plan = self.plan([])
        plan["items"] = [
            self.item("fast"),
            self.item("build"),
            self.item("smoke:test:composer", ("build",)),
            self.item("unrelated-full"),
        ]
        for item in plan["items"]:
            item["phase"] = "commit" if item["id"] == "fast" else "full"
            item["command"] = [
                sys.executable,
                "-c",
                "from pathlib import Path; import sys; p=Path('target/executed'); p.parent.mkdir(exist_ok=True); p.open('a').write(sys.argv[1]+'\\n'); sys.exit(int(sys.argv[2]))",
                item["id"],
                "7" if item["id"] == "smoke:test:composer" else "0",
            ]
        self.history_report("known-failure", self.base, "failed", "2026-01-01T00:00:00Z")
        with (
            patch.object(checks, "ROOT", self.root),
            patch.object(checks.ci_scope, "repository_plan", return_value=plan),
            redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(checks.main(["--base", self.base]), 1)
        self.assertEqual(
            (self.root / "target/executed").read_text().splitlines(),
            ["fast", "build", "smoke:test:composer"],
        )
        report = json.loads(
            next((self.root / "target/ci/changed").glob("*/report.json")).read_text()
        )
        self.assertEqual(report["progress"]["counts"]["passed"], 2)
        self.assertEqual(report["progress"]["failed"], ["smoke:test:composer"])
        self.assertEqual(report["progress"]["pending"], ["unrelated-full"])

    def test_progress_keeps_failure_while_independent_commands_continue(self):
        items = [
            self.item("fails"),
            self.item("passes"),
            self.item("blocked", ("fails",)),
            self.item("remote"),
        ]
        items[-1]["platforms"] = ["other-platform"]
        snapshots = []

        def runner(command, **kwargs):
            snapshots.append(
                json.loads((self.root / "target/ci/1/report.json").read_text())["progress"]
            )
            return subprocess.run(
                [
                    sys.executable,
                    "-c",
                    "import sys; sys.exit(" + ("7" if command == ["fails"] else "0") + ")",
                ],
                **kwargs,
            )

        report = self.execute(items, runner)
        self.assertEqual(snapshots[0]["counts"]["passed"], 0)
        self.assertEqual(snapshots[0]["running"], ["fails"])
        self.assertEqual(snapshots[0]["pending"], ["passes", "blocked", "remote"])
        self.assertEqual(snapshots[1]["status"], "failed")
        self.assertEqual(snapshots[1]["failed"], ["fails"])
        summary = report["progress"]
        self.assertEqual(
            summary["counts"],
            {
                "passed": 1,
                "failed": 1,
                "blocked": 1,
                "pending": 1,
                "running": 0,
                "invalidated": 0,
                "cancelled": 0,
            },
        )
        self.assertEqual(summary["remoteRequired"], ["remote"])
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts/ci-preflight.py"),
                "--report",
                str(self.root / "target/ci/1/report.json"),
            ],
            text=True,
            capture_output=True,
            check=True,
        )
        self.assertEqual(json.loads(result.stdout)["progress"], summary)

    def test_progress_counts_unselected_full_checks_as_pending_and_rejects_mismatched_plan(self):
        plan = self.plan([])
        plan["items"] = [self.item("fast"), self.item("full")]
        output = self.root / "target/ci/progress"
        report = checks.preflight.run_plan(
            plan,
            self.root,
            plan["items"][:1],
            output,
            runner=lambda *a, **k: subprocess.CompletedProcess(a, 0),
        )
        self.assertEqual(report["status"], "passed")
        self.assertEqual(report["progress"]["status"], "pending")
        self.assertEqual(report["progress"]["passed"], ["fast"])
        self.assertEqual(report["progress"]["pendingFull"], ["full"])
        plan["planHash"] = "other-plan"
        (output / "plan.json").write_text(json.dumps(plan))
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts/ci-preflight.py"),
                "--report",
                str(output / "report.json"),
            ],
            text=True,
            capture_output=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not match", result.stderr)

    def test_final_input_invalidation_cannot_leave_progress_green(self):
        report = self.execute([self.item("a")])
        report["status"] = "invalidated"
        plan = self.plan([])
        plan["items"] = [self.item("a")]
        summary = checks.preflight.progress(plan, report)
        self.assertEqual(summary["status"], "invalidated")
        self.assertEqual(summary["counts"]["passed"], 0)
        self.assertEqual(summary["invalidated"], ["a"])

    def test_mutable_cargo_outputs_do_not_block_building_consumers_but_published_bundle_does(self):
        binary = self.root / "target/debug"
        binary.mkdir(parents=True)
        for owner in ("verify-core-build", "native-core-build", "gui-core-build"):
            for name in ("areal", "areal-runtime", "areal-runtime-fs", "areal-runtime-reaper"):
                (binary / name).write_bytes(b"built")
            producer = self.item(owner)
            cargo = self.item("cargo-tests", (owner,))
            consumer = self.item("consumer", (owner,))
            calls = []

            def runner(command, **kwargs):
                calls.append(command[0])
                if command[0] == "cargo-tests":
                    (binary / "areal-runtime-reaper").write_bytes(b"cargo-test-build")
                return subprocess.CompletedProcess(command, 0)

            report = self.execute([producer, cargo, consumer], runner)
            if owner == "gui-core-build":
                self.assertEqual(calls, [owner, "cargo-tests"])
                self.assertEqual(report["results"][-1]["staleArtifacts"], [owner])
                self.assertEqual(report["results"][-1]["status"], "blocked")
            else:
                self.assertEqual(calls, [owner, "cargo-tests", "consumer"])
                self.assertEqual(report["status"], "passed")

    def test_python_and_make_entries_require_supported_python_before_execution(self):
        plan = self.plan(["scripts/ci-preflight.py"])
        for item in plan["items"]:
            if item["command"][0] in {"python3", "make"} or item["id"] == "gui-portable":
                self.assertIn("python3", item["requires"], item["id"])

    def test_failed_attempt_reports_cannot_be_overwritten(self):
        self.execute([self.item("failed")], lambda *a, **k: subprocess.CompletedProcess(a, 9))
        path = self.root / "target/ci/1/report.json"
        saved = path.read_bytes()
        plan = self.plan([])
        with self.assertRaisesRegex(ValueError, "overwrite"):
            checks.preflight.run_plan(plan, self.root, [], path.parent)
        self.assertEqual(path.read_bytes(), saved)

    def test_source_change_during_execution_invalidates_green_command_and_remaining_checks(self):
        calls = []

        def runner(command, **kwargs):
            calls.append(command)
            (self.root / "source.rs").write_text("during check\n")
            return subprocess.CompletedProcess(command, 0)

        report = self.execute([self.item("a"), self.item("b")], runner)
        self.assertEqual(report["status"], "invalidated")
        self.assertEqual(calls, [["a"]])
        self.assertTrue(all(item["status"] == "invalidated" for item in report["results"]))

    def test_mapping_removal_still_falls_back_conservatively(self):
        with patch.dict(checks.ci_scope.SCOPES, {"gui": [], "release": []}, clear=True):
            plan = self.plan(["schemas/areal-core-v1.json"])
        self.assertIn("portable:bundle", {item["id"] for item in plan["items"]})
        self.assertEqual(plan["fallbackPaths"], ["schemas/areal-core-v1.json"])

    def test_legacy_manifest_preview_reports_missing_requirements_without_claiming_execution(self):
        result = subprocess.run(
            ["node", str(ROOT / "clients/gui/scripts/test-manifest.mjs"), "--select-changed"],
            input=json.dumps({"paths": ["schemas/new.json"], "available": [], "platform": "linux"}),
            text=True,
            capture_output=True,
            check=True,
        )
        selected = json.loads(result.stdout)
        self.assertIn("test:feedback-native", {item["script"] for item in selected["unexecuted"]})
        self.assertIn("test:composer", selected["deferred"])


if __name__ == "__main__":
    unittest.main()
