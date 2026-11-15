import importlib.util
import json
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
            ["unknown-receipt-recovery"],
        )

    def test_evidence_requires_matching_identity(self):
        report = {
            "identity": {
                "baseRevision": "base",
                "sourceRevision": "source",
                "headRevision": "head",
                "inputHash": "hash",
            },
            "results": [{"id": "architecture-boundary", "status": "passed"}],
            "evidence": {
                "schemaVersion": 1,
                "source": {
                    "baseRevision": "base",
                    "sourceRevision": "source",
                    "headRevision": "head",
                    "inputHash": "hash",
                },
                "journeys": [],
                "authorities": [],
                "checks": [{"id": "architecture-boundary", "status": "passed"}],
            },
        }
        self.assertEqual(evidence.validate(report)["schemaVersion"], 1)
        report["evidence"]["source"]["inputHash"] = "changed"
        with self.assertRaises(ValueError):
            evidence.validate(report)

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
