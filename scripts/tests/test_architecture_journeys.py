import copy
import importlib.util
import json
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest


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
        self.assertEqual(journeys.load_manifest()["schemaVersion"], 1)

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
            ["conversation-submit", "unknown-receipt-recovery", "host-stop-reopen"],
        )

    def test_shared_boundaries_select_existing_journey_checks_and_dependencies(self):
        manifest = json.loads((ROOT / "clients/gui/scripts/test-manifest.json").read_text())
        for path, expected in (
            (
                "core/host/src/gateway/session.rs",
                {"conversation-submit", "unknown-receipt-recovery"},
            ),
            ("services/workbench/src/desktop/core/providers.cjs", {"conversation-submit"}),
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


if __name__ == "__main__":
    unittest.main()
