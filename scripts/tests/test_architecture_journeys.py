from contextlib import redirect_stdout
import copy
import importlib.util
import io
import json
import os
import subprocess
import sys
from io import StringIO
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


architecture = load("check_architecture", "check-architecture.py")
journeys = load("check_journeys", "check-journeys.py")
evidence = load("verification_evidence", "verification-evidence.py")
scope = load("journey_ci_scope", "ci-scope.py")
preflight = load("journey_preflight", "ci-preflight.py")
gate = load("journey_gate", "ci-gate.py")
triage = load("compare_journey_triage", "compare-journey-triage.py")


class ArchitectureAndJourneys(unittest.TestCase):
    def test_repository_manifests_pass(self):
        self.assertEqual(architecture.check(ROOT), [])
        manifest = journeys.load_manifest()
        self.assertEqual(manifest["schemaVersion"], 1)
        tracked = subprocess.check_output(["git", "ls-files"], cwd=ROOT, text=True).splitlines()
        journeys.validate_path_patterns(manifest, tracked)

    def test_message_render_children_select_history_journeys_without_overmatching_siblings(self):
        manifest = json.loads((ROOT / "clients/gui/scripts/test-manifest.json").read_text())
        expected = {"conversation-submit", "unknown-receipt-recovery", "connection-recovery"}
        for path in (
            "clients/gui/renderer/src/components/ai-elements/message.tsx",
            "clients/gui/renderer/src/components/ai-elements/message-response-renderer.tsx",
        ):
            with self.subTest(path=path):
                plan = scope.build_plan([path], {"baseRevision": "base"}, manifest)
                self.assertEqual(set(plan["affectedJourneys"]), expected)
                items = {item["id"] for item in plan["items"]}
                for journey in expected:
                    self.assertTrue(set(plan["journeyChecks"][journey]) <= items)
        # 无关兄弟组件不应误触发历史投影旅程，防止 glob 过度放宽。
        sibling = scope.build_plan(
            ["clients/gui/renderer/src/components/ai-elements/diagram-reader.tsx"],
            {"baseRevision": "base"},
            manifest,
        )
        self.assertEqual(sibling["affectedJourneys"], [])
        self.assertEqual(
            journeys.affected(["clients/gui/renderer/src/components/ui/button.tsx"]),
            [],
        )

    def test_forbidden_renderer_import_is_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "clients/gui/renderer/src/bad.ts"
            path.parent.mkdir(parents=True)
            path.write_text('import { ipc } from "desktop-contract";\n')
            manifest = {
                "schemaVersion": 1,
                "rules": [
                    {
                        "id": "test",
                        "owner": "renderer",
                        "appliesTo": ["clients/gui/renderer/src/**/*.ts"],
                        "forbiddenImportSubstrings": ["desktop-contract"],
                        "reason": "use the platform boundary",
                    }
                ],
            }
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps(manifest))
            loaded = architecture.load_manifest(manifest_path)
            violations = architecture.check(root, loaded)
            self.assertEqual(violations[0]["rule"], "test")

    def test_changed_paths_map_to_registered_narrow_paths(self):
        self.assertEqual(
            journeys.affected(["clients/gui/renderer/src/DraftComposer.tsx"]),
            ["conversation-submit"],
        )
        self.assertEqual(
            journeys.affected(["core/host/src/client.rs"]),
            [
                "conversation-submit",
                "unknown-receipt-recovery",
                "host-stop-reopen",
                "connection-recovery",
            ],
        )

    def test_shared_boundaries_select_existing_journey_checks_and_dependencies(self):
        manifest = json.loads((ROOT / "clients/gui/scripts/test-manifest.json").read_text())
        for path, expected in (
            (
                "core/host/src/gateway/session.rs",
                {"conversation-submit", "unknown-receipt-recovery"},
            ),
            ("core/host/src/model_application.rs", {"conversation-submit"}),
            (
                "clients/gui/app/src/core/service-client.cjs",
                {"unknown-receipt-recovery", "host-stop-reopen"},
            ),
            (
                "clients/gui/app/src/core/main.cjs",
                {"unknown-receipt-recovery", "host-stop-reopen"},
            ),
            (
                "clients/gui/renderer/src/host-history-cache.ts",
                {"conversation-submit", "unknown-receipt-recovery"},
            ),
        ):
            with self.subTest(path=path):
                plan = scope.build_plan([path], {"baseRevision": "base"}, manifest)
                self.assertTrue(expected <= set(plan["affectedJourneys"]))
                items = {item["id"]: item for item in plan["items"]}
                for journey in expected:
                    for check in plan["journeyChecks"][journey]:
                        self.assertIn(check, items)
                        self.assertTrue(set(items[check]["dependsOn"]) <= items.keys())
                if "conversation-submit" in expected:
                    self.assertIn("smoke:test:web-journeys", items)
        plan = scope.build_plan(["docs/features.md"], {}, manifest)
        self.assertEqual(plan["affectedJourneys"], [])
        self.assertFalse(any(item["group"] == "smoke" for item in plan["items"]))
        plan = scope.build_plan(
            ["clients/gui/renderer/src/unrelated.ts"], {"baseRevision": "base"}, manifest
        )
        self.assertNotIn("smoke:test:stop-reopen", {item["id"] for item in plan["items"]})

    def test_manifest_rejects_unknown_boundary_and_unplanned_checks(self):
        manifest = journeys.load_manifest()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            for mutate in ("boundary", "check", "duplicate"):
                broken = copy.deepcopy(manifest)
                if mutate == "boundary":
                    broken["journeys"][0]["boundaries"] = ["nonexistent"]
                elif mutate == "check":
                    broken["journeys"][0]["checks"] = ["smoke:test:nonexistent"]
                else:
                    broken["journeys"][0]["checks"] *= 2
                path.write_text(json.dumps(broken))
                with self.subTest(mutate=mutate), self.assertRaises(ValueError):
                    value = journeys.load_manifest(path)
                    journeys.validate_checks(value, [])

    def evidence_fixture(self):
        plan = {
            "planHash": "plan",
            "source": {
                "baseRevision": "base",
                "sourceRevision": "source",
                "headRevision": "head",
                "inputHash": "inputs",
            },
            "affectedJourneys": ["submit"],
            "journeyChecks": {"submit": ["smoke:send", "smoke:read"]},
            "journeyAuthorities": {"submit": ["host", "core"]},
            "items": [
                {"id": name, "platforms": ["darwin"]}
                for name in ("smoke:send", "smoke:read", "other:smoke:send")
            ],
        }
        report = {
            "identity": {**plan["source"], "planHash": "plan", "ciRunId": "run", "ciAttempt": "2"},
            "platform": "darwin",
            "status": "passed",
            "results": [{"id": "smoke:send", "status": "passed", "exitCode": 0}],
        }
        return plan, report

    def test_journey_summary_requires_exact_complete_successful_results(self):
        plan, report = self.evidence_fixture()
        for results, status in (
            ([], "pending"),
            ([{"id": "other:smoke:send", "status": "passed", "exitCode": 0}], "pending"),
            ([{"id": "smoke:send", "status": "passed", "exitCode": 0}], "pending"),
            (
                [
                    {"id": "smoke:send", "status": "passed", "exitCode": 0},
                    {"id": "other:smoke:send", "status": "passed", "exitCode": 0},
                ],
                "pending",
            ),
            (
                [
                    {"id": "smoke:send", "status": "passed", "exitCode": 0},
                    {"id": "smoke:read", "status": "passed", "exitCode": 0},
                ],
                "passed",
            ),
        ):
            report["results"] = results
            summary = evidence.build(plan, report)["journeys"][0]
            self.assertEqual(summary["status"], status)
            self.assertEqual(
                summary["missingChecks"],
                [
                    name
                    for name in ("smoke:send", "smoke:read")
                    if name not in {row["id"] for row in results}
                ],
            )
        for status in ("failed", "blocked", "invalidated", "cancelled", "running", "pending"):
            report["results"][-1]["status"] = status
            self.assertEqual(evidence.build(plan, report)["journeys"][0]["status"], status)
        report["results"][-1].update(status="passed", exitCode=1)
        self.assertEqual(evidence.build(plan, report)["journeys"][0]["status"], "failed")
        report["results"][-1]["exitCode"] = 0
        report["status"] = "invalidated"
        self.assertEqual(evidence.build(plan, report)["journeys"][0]["status"], "invalidated")

    def test_evidence_validator_rejects_missing_duplicate_and_forged_evidence(self):
        plan, report = self.evidence_fixture()
        report["evidence"] = evidence.build(plan, report)
        evidence.validate(report, plan)
        for mutate in (
            "check",
            "journey",
            "required",
            "observed",
            "status",
            "source",
            "platform",
            "duplicate",
            "wrong-lane",
        ):
            forged = copy.deepcopy(report)
            if mutate == "check":
                forged["evidence"]["checks"] = []
            elif mutate == "journey":
                forged["evidence"]["journeys"] = []
            elif mutate == "required":
                forged["evidence"]["journeys"][0]["requiredChecks"] = []
            elif mutate == "observed":
                forged["evidence"]["journeys"][0]["observedChecks"] = ["smoke:read"]
            elif mutate == "status":
                forged["evidence"]["journeys"][0]["status"] = "passed"
            elif mutate == "source":
                forged["evidence"]["source"]["ciAttempt"] = "1"
            elif mutate == "platform":
                forged["evidence"]["platform"] = "linux"
            elif mutate == "wrong-lane":
                forged["platform"] = forged["evidence"]["platform"] = "linux"
            else:
                forged["results"] *= 2
            with self.subTest(mutate=mutate), self.assertRaises(ValueError):
                evidence.validate(forged, plan)

    def test_evidence_requires_matching_identity(self):
        plan, report = self.evidence_fixture()
        report["evidence"] = evidence.build(plan, report)
        self.assertEqual(evidence.validate(report, plan)["schemaVersion"], 1)
        report["evidence"]["source"]["inputHash"] = "changed"
        with self.assertRaises(ValueError):
            evidence.validate(report, plan)

    def test_historical_triage_uses_validated_source_reports(self):
        plan, report = self.evidence_fixture()
        report["evidence"] = evidence.build(plan, report)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "plan.json").write_text(json.dumps(plan))
            path = root / "report.json"
            path.write_text(json.dumps(report))
            self.assertIsNotNone(triage.matching_report("source", root))
            self.assertIsNone(triage.matching_report("head", root))
            report["evidence"]["journeys"][0]["status"] = "passed"
            path.write_text(json.dumps(report))
            self.assertIsNone(triage.matching_report("source", root))

    def test_gate_rejects_forged_journey_even_when_checks_pass(self):
        plan, report = self.evidence_fixture()
        for item in plan["items"]:
            item.update(group="smoke", platforms=["darwin"])
        report["results"] = [
            {"id": item["id"], "status": "passed", "exitCode": 0} for item in plan["items"]
        ]
        report["evidence"] = evidence.build(plan, report)
        self.assertEqual(gate.validate(plan, [report], {"smoke"}), [])
        report["evidence"]["journeys"] = []
        self.assertTrue(gate.validate(plan, [report], {"smoke"}))

    def test_smoke_matrix_covers_exactly_the_selected_journey_checks(self):
        manifest = json.loads((ROOT / "clients/gui/scripts/test-manifest.json").read_text())
        plan = scope.build_plan(["core/host/src/client.rs"], {"baseRevision": "base"}, manifest)
        scripts = [row["script"] for row in scope.smoke_matrix(plan, manifest)["include"]]
        self.assertIn("test:ux-journeys", scripts)
        self.assertIn("test:web-journeys", scripts)
        self.assertIn("test:service-reopen", scripts)
        self.assertIn("test:stop-reopen", scripts)
        self.assertEqual(len(scripts), len(set(scripts)))
        self.assertEqual(
            {"smoke:" + script for script in scripts},
            {item["id"] for item in plan["items"] if item["group"] == "smoke"},
        )

    def test_preflight_persists_and_cli_validates_partial_journey(self):
        plan, _ = self.evidence_fixture()
        for item in plan["items"]:
            item.update(
                command=[sys.executable, "-c", "pass"],
                group="early",
                requires=[],
                dependsOn=[],
                platforms=[sys.platform],
            )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "attempt"
            report = preflight.run_plan(
                plan,
                root,
                plan["items"][:1],
                output,
                input_probe=lambda: "inputs",
                capability_probe=lambda *args: set(),
            )
            self.assertEqual(report["status"], "passed")
            self.assertEqual(report["evidence"]["journeys"][0]["status"], "pending")
            self.assertEqual(report["evidence"]["journeys"][0]["missingChecks"], ["smoke:read"])
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scripts/verification-evidence.py"),
                    str(output / "report.json"),
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_recent_triage_report_has_explicit_measurement_limits(self):
        report = triage.compare(1)
        self.assertEqual(report["schemaVersion"], 1)
        self.assertEqual(report["sampleSize"], 1)
        self.assertIn("human", report["measurement"]["old"])
        self.assertIn("realJourneyEvidence", report["rows"][0]["newProcess"])
        self.assertIn("blockReasons", report["rows"][0]["newProcess"]["realJourneyEvidence"][0])
        self.assertFalse(report["conclusion"]["canConfirmHumanTimeReduction"])

    def test_triage_continuous_baseline_includes_unmapped_and_marks_observation_window(self):
        from datetime import datetime, timezone

        now = datetime(2026, 11, 22, 12, 0, tzinfo=timezone.utc)
        mature = triage.observation_window("2026-11-01T00:00:00+00:00", days=14, now=now)
        observing = triage.observation_window("2026-11-20T00:00:00+00:00", days=14, now=now)
        self.assertEqual(mature["status"], "mature")
        self.assertTrue(mature["mature"])
        self.assertEqual(observing["status"], "observing")
        self.assertFalse(observing["mature"])
        report = triage.compare(3, include_unmapped=True, ref="HEAD", now=now)
        self.assertEqual(report["measurement"]["sampleRef"], "HEAD")
        self.assertTrue(report["measurement"]["includeUnmapped"])
        self.assertIn("zeroHitCommits", report["measurement"])
        self.assertIn("observationWindow", report["measurement"])
        self.assertIn("manualBaseline", report["rows"][0])

    def fact_fixture(self):
        plan, report = self.evidence_fixture()
        contract = {"journeyId": "submit", "terminalFacts": ["visibleResult", "noReplay"]}
        plan["journeyEvidence"] = {"submit": {"check": "smoke:send", **contract}}
        plan["items"][0]["journeyEvidence"] = contract
        detail = {
            "schemaVersion": 1,
            "journeyId": "submit",
            "identity": report["identity"],
            "status": "passed",
            "facts": [
                {"id": name, "status": "passed", "evidence": ["observation.json"]}
                for name in contract["terminalFacts"]
            ],
            "firstFailure": None,
            "reached": ["send", "recover"],
            "unreached": [],
            "cleanup": {"status": "passed", "evidence": ["cleanup.json"]},
        }
        return plan, report, contract, detail

    def test_successful_process_without_business_evidence_cannot_pass(self):
        plan, _report, _contract, _detail = self.fact_fixture()
        for item in plan["items"]:
            item.update(
                command=[sys.executable, "-c", "pass"],
                group="early",
                requires=[],
                dependsOn=[],
                platforms=[sys.platform],
            )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = preflight.run_plan(
                plan, root, plan["items"][:1], root / "attempt", input_probe=lambda: "inputs"
            )
            self.assertEqual(report["results"][0]["status"], "failed")
            self.assertEqual(report["evidence"]["journeys"][0]["status"], "failed")

    def test_final_gate_combines_business_facts_only_from_its_own_attempt(self):
        plan, envelope, _, detail = self.fact_fixture()
        plan["items"] = plan["items"][:2]
        for item in plan["items"]:
            item["group"] = "smoke"
        jobs = {name: {"result": "success"} for name in scope.JOB_GROUPS["gui"]}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index, item in enumerate(plan["items"]):
                row = {"id": item["id"], "status": "passed", "exitCode": 0}
                if index == 0:
                    row["journeyEvidence"] = {
                        **detail,
                        "artifacts": {"observation.json": "a" * 64, "cleanup.json": "b" * 64},
                    }
                report = {**envelope, "kind": "verification-report", "results": [row]}
                report["evidence"] = evidence.build(plan, report)
                path = root / str(index)
                path.mkdir()
                (path / "report.json").write_text(json.dumps(report))
            for attempt in ("2", "3"):
                env = {
                    "NEEDS_JSON": json.dumps(jobs),
                    "GITHUB_RUN_ID": "run",
                    "GITHUB_RUN_ATTEMPT": attempt,
                }
                with (
                    self.subTest(attempt=attempt),
                    patch.dict("os.environ", env),
                    patch.object(gate.scope, "repository_plan", return_value=plan),
                    patch.object(
                        sys, "argv", ["ci-gate", "--workflow", "gui", "--reports", str(root)]
                    ),
                    patch("sys.stdout", new_callable=StringIO) as output,
                ):
                    code = gate.main()
                    result = json.loads(output.getvalue())
                    if attempt == "2":
                        self.assertEqual(code, 0, result["failures"])
                        self.assertEqual(result["journeys"][0]["status"], "passed")
                        self.assertEqual(result["journeys"][0]["facts"], detail["facts"])
                    else:
                        self.assertEqual(code, 1)
                        self.assertIn(
                            "report is from another CI run or attempt", result["failures"]
                        )

    def test_fact_report_rejects_missing_duplicate_stale_and_false_success(self):
        _plan, report, contract, detail = self.fact_fixture()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "report.json"
            (root / "observation.json").write_text('{"requestId":"original"}')
            (root / "cleanup.json").write_text('{"processesExited":true}')
            for mutation in (
                "missing",
                "duplicate",
                "unknown",
                "identity",
                "failed",
                "cleanup",
                "unreached",
                "missing-file",
                "bad-status",
                "bad-fact-status",
                "escape",
                "symlink",
            ):
                broken = copy.deepcopy(detail)
                if mutation == "missing":
                    broken["facts"].pop()
                elif mutation == "duplicate":
                    broken["facts"] *= 2
                elif mutation == "unknown":
                    broken["facts"][0]["id"] = "other"
                elif mutation == "identity":
                    broken["identity"]["ciAttempt"] = "old"
                elif mutation == "failed":
                    broken["facts"][0]["status"] = "failed"
                elif mutation == "cleanup":
                    broken["cleanup"]["status"] = "failed"
                elif mutation == "unreached":
                    broken["unreached"] = ["later"]
                elif mutation == "missing-file":
                    broken["facts"][0]["evidence"] = ["missing.json"]
                elif mutation == "bad-status":
                    broken["status"] = {}
                elif mutation == "bad-fact-status":
                    broken["facts"][0]["status"] = []
                elif mutation == "escape":
                    broken["facts"][0]["evidence"] = ["../outside.json"]
                else:
                    (root / "link.json").symlink_to(root / "observation.json")
                    broken["facts"][0]["evidence"] = ["link.json"]
                path.write_text(json.dumps(broken))
                with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                    evidence.read_journey_report(path, contract, report["identity"])

    def test_fact_evidence_preserves_failure_and_artifact_digests(self):
        plan, report, contract, detail = self.fact_fixture()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "observation.json").write_text('{"requestId":"original"}')
            (root / "cleanup.json").write_text('{"processesExited":true}')
            path = root / "report.json"
            for status in ("passed", "failed"):
                detail["status"] = status
                detail["facts"][0]["status"] = status
                detail["firstFailure"] = None if status == "passed" else "visibleResult"
                path.write_text(json.dumps(detail))
                imported = evidence.read_journey_report(path, contract, report["identity"])
                self.assertEqual(len(imported["artifacts"]["observation.json"]), 64)
                report["results"][0].update(
                    journeyEvidence=imported, status=status, exitCode=0 if status == "passed" else 1
                )
                report["results"].append({"id": "smoke:read", "status": "passed", "exitCode": 0})
                summary = evidence.build(plan, report)["journeys"][0]
                self.assertEqual(summary["status"], status)
                self.assertEqual(summary["facts"][0]["status"], status)
                report["results"].pop()

    def test_preflight_imports_business_report_from_its_assigned_run_directory(self):
        plan, _report, _contract, template = self.fact_fixture()
        for item in plan["items"]:
            item.update(
                command=["synthetic-runner"],
                group="early",
                requires=[],
                dependsOn=[],
                platforms=[sys.platform],
            )
        for state in ("passed", "failed"):
            with self.subTest(state=state), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)

                def runner(command, cwd, env):
                    path = Path(env["AREAL_JOURNEY_REPORT"])
                    self.assertTrue(path.is_relative_to((root / "attempt").resolve()))
                    detail = copy.deepcopy(template)
                    detail["identity"] = json.loads(env["AREAL_VERIFICATION_IDENTITY"])
                    detail["status"] = detail["facts"][0]["status"] = state
                    detail["firstFailure"] = None if state == "passed" else "visibleResult"
                    (path.parent / "observation.json").write_text('{"requestId":"original"}')
                    (path.parent / "cleanup.json").write_text('{"processesExited":true}')
                    path.write_text(json.dumps(detail))
                    return subprocess.CompletedProcess(command, 0)

                report = preflight.run_plan(
                    plan,
                    root,
                    plan["items"][:1],
                    root / "attempt",
                    runner=runner,
                    input_probe=lambda: "inputs",
                )
                result = report["results"][0]
                self.assertEqual(result["status"], state)
                self.assertEqual(result["journeyEvidence"]["identity"], report["identity"])
                self.assertEqual(
                    result["journeyEvidence"]["firstFailure"],
                    None if state == "passed" else "visibleResult",
                )
                evidence.validate(report, plan)

    def test_invalid_report_preserves_business_failure_in_diagnostic(self):
        _plan, report, contract, detail = self.fact_fixture()
        detail["status"] = "failed"
        detail["facts"][0]["status"] = "failed"
        detail["firstFailure"] = {"stage": "automaticRecovery", "reason": "old owner retained"}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.json"
            path.write_text(json.dumps(detail))
            with self.assertRaisesRegex(ValueError, "automaticRecovery"):
                evidence.read_journey_report(path, contract, report["identity"])

    def test_plan_binds_business_evidence_to_its_registered_check(self):
        registry = journeys.load_manifest()
        manifest = json.loads((ROOT / "clients/gui/scripts/test-manifest.json").read_text())
        contract = registry["journeys"][0]
        contract["evidenceCheck"] = contract["checks"][0]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "journeys.json"
            path.write_text(json.dumps(registry))
            with patch.object(scope, "JOURNEY_MANIFEST", path):
                plan = scope.build_plan(
                    ["clients/gui/renderer/src/DraftComposer.tsx"],
                    {"baseRevision": "base"},
                    manifest,
                )
        item = next(item for item in plan["items"] if item["id"] == contract["evidenceCheck"])
        self.assertEqual(item["journeyEvidence"]["terminalFacts"], contract["terminalFacts"])
        self.assertEqual(plan["journeyEvidence"][contract["id"]]["check"], item["id"])

    def test_connection_recovery_selects_only_its_business_contract(self):
        registry = journeys.load_manifest()
        manifest = json.loads((ROOT / "clients/gui/scripts/test-manifest.json").read_text())
        for path in (
            "clients/gui/renderer/src/host-snapshot.ts",
            "clients/gui/renderer/src/state/useSessionNavigation.ts",
        ):
            with self.subTest(path=path):
                plan = scope.build_plan([path], {"baseRevision": "base"}, manifest)
                self.assertEqual(plan["affectedJourneys"], ["connection-recovery"])
                contract = plan["journeyEvidence"]["connection-recovery"]
                self.assertEqual(contract["check"], "smoke:test:connection-recovery")
                self.assertEqual(
                    contract["terminalFacts"],
                    [
                        "loadingWithoutFalseFailure",
                        "automaticRecovery",
                        "draftAndSelectionPreserved",
                        "continuedSubmission",
                        "explicitStopRespected",
                        "unknownNotReplayed",
                    ],
                )
        self.assertEqual(
            [entry["id"] for entry in registry["journeys"] if "evidenceCheck" in entry],
            [
                "conversation-submit",
                "unknown-receipt-recovery",
                "host-stop-reopen",
                "connection-recovery",
                "ui-visual-audit",
            ],
        )
        visual_plan = scope.build_plan(
            ["clients/gui/renderer/src/workbench.css"], {"baseRevision": "base"}, manifest
        )
        self.assertEqual(visual_plan["affectedJourneys"], ["ui-visual-audit"])
        self.assertEqual(
            visual_plan["journeyEvidence"]["ui-visual-audit"]["check"], "smoke:test:ui-audit"
        )

    def test_gate_rejects_exit_zero_without_required_business_report(self):
        plan, report, _contract, _detail = self.fact_fixture()
        with self.assertRaisesRegex(ValueError, "missing required business evidence"):
            evidence.build(plan, report)

    def test_decision_summary_compresses_without_losing_triage_facts(self):
        _plan, _report, _contract, detail = self.fact_fixture()
        detail["status"] = "failed"
        detail["facts"][0]["status"] = "failed"
        detail["facts"][1]["status"] = "pending"
        detail["firstFailure"] = {"stage": "visibleResult", "message": "reply missing"}
        detail["unreached"] = ["noReplay"]
        detail["faults"] = {
            "visibleResult": {"injectionReached": True, "evidence": ["wire.json"]},
        }
        detail["artifacts"] = {"observation.json": "a" * 64, "cleanup.json": "b" * 64}
        compact = evidence.decision_summary(detail, full_ci=None, report_path="report.json")
        self.assertEqual(compact["journeyId"], "submit")
        self.assertEqual(compact["status"], "failed")
        self.assertEqual(compact["facts"], {"visibleResult": "failed", "noReplay": "pending"})
        self.assertEqual(compact["firstFailure"], detail["firstFailure"])
        self.assertEqual(compact["unreached"], ["noReplay"])
        self.assertEqual(compact["faultsInjectionReached"], {"visibleResult": True})
        self.assertEqual(compact["cleanup"], {"status": "passed"})
        self.assertIsNone(compact["fullCiPassed"])
        self.assertNotIn("artifacts", compact)
        self.assertLess(len(json.dumps(compact)), len(json.dumps(detail)))

    def test_ci_gate_validates_journey_report_against_current_run_identity(self):
        plan, report, contract, detail = self.fact_fixture()
        plan["items"][0]["group"] = "smoke"
        plan["items"][1]["group"] = "smoke"
        plan["items"][2]["group"] = "smoke"
        plan["items"] = plan["items"][:2]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "observation.json").write_text('{"requestId":"original"}')
            (root / "cleanup.json").write_text('{"processesExited":true}')
            detail_path = root / "journey.json"
            detail_path.write_text(json.dumps(detail))
            imported = evidence.read_journey_report(detail_path, contract, report["identity"])
            report.update(
                kind="verification-report",
                results=[
                    {
                        "id": "smoke:send",
                        "status": "passed",
                        "exitCode": 0,
                        "journeyEvidence": imported,
                    },
                    {"id": "smoke:read", "status": "passed", "exitCode": 0},
                ],
            )
            report["evidence"] = evidence.build(plan, report)
            reports_dir = root / "checks"
            reports_dir.mkdir()
            (reports_dir / "report.json").write_text(json.dumps(report))
            needs = {
                job: {"result": "success" if job in ("scope", "smoke") else "skipped"}
                for job in scope.JOB_GROUPS["gui"]
            }
            env = {
                "GITHUB_RUN_ID": "run",
                "GITHUB_RUN_ATTEMPT": "2",
                "NEEDS_JSON": json.dumps(needs),
            }
            with (
                patch.object(gate.scope, "repository_plan", return_value=plan),
                patch.dict(os.environ, env, clear=False),
                patch.object(
                    sys, "argv", ["ci-gate.py", "--workflow", "gui", "--reports", str(reports_dir)]
                ),
            ):
                buf = io.StringIO()
                with redirect_stdout(buf):
                    code = gate.main()
            payload = json.loads(buf.getvalue())
            self.assertEqual(code, 0, payload)
            self.assertEqual(payload["passed"], True)
            self.assertEqual(payload["failures"], [])
            self.assertEqual(payload["journeys"][0]["status"], "passed")

            # 篡改旅程报告内的 ciAttempt 仍必须被门禁拒绝。
            forged = copy.deepcopy(report)
            forged["results"][0]["journeyEvidence"]["identity"]["ciAttempt"] = "1"
            (reports_dir / "report.json").write_text(json.dumps(forged))
            with (
                patch.object(gate.scope, "repository_plan", return_value=plan),
                patch.dict(os.environ, env, clear=False),
                patch.object(
                    sys, "argv", ["ci-gate.py", "--workflow", "gui", "--reports", str(reports_dir)]
                ),
            ):
                buf = io.StringIO()
                with redirect_stdout(buf):
                    code = gate.main()
            rejected = json.loads(buf.getvalue())
            self.assertEqual(code, 1)
            self.assertEqual(rejected["passed"], False)
            self.assertTrue(
                any(
                    "journey report identity differs from its current plan/run" in msg
                    for msg in rejected["failures"]
                ),
                rejected,
            )


if __name__ == "__main__":
    unittest.main()
