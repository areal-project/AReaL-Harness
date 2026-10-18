"""自定义 target-dir 有旧默认产物时仍必须执行刚构建的 schema 例程。"""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "desktop_schemas", ROOT / "scripts/desktop-schemas.py"
)
schemas = importlib.util.module_from_spec(spec)
spec.loader.exec_module(schemas)


class SchemaArtifactTests(unittest.TestCase):
    def test_custom_target_with_stale_default_executes_fresh_artifact(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "schemas").mkdir()
            (root / "schemas/fixture.json").write_text('{"fresh":true}')
            stale = root / "target/debug/examples/fixture"
            fresh = root / "custom/debug/examples/fixture"
            for path, body in [(stale, '{"stale":true}'), (fresh, '{"fresh":true}')]:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(body)
            calls = []

            def execute(command, **kwargs):
                calls.append(command)
                if command[0] == "cargo":
                    return json.dumps(
                        {
                            "reason": "compiler-artifact",
                            "target": {"name": "fixture", "kind": ["example"]},
                            "executable": str(fresh),
                        }
                    )
                return Path(command[0]).read_bytes()

            with (
                patch.object(schemas, "ROOT", root),
                patch.object(schemas, "GENERATORS", [("fixture", "fixture", [], "fixture.json")]),
                patch.object(schemas.subprocess, "check_output", side_effect=execute),
                patch("sys.argv", ["desktop-schemas.py"]),
            ):
                schemas.main()
            self.assertEqual(calls[1][0], str(fresh))
            self.assertNotIn(str(stale), [item for command in calls for item in command])

    def test_missing_or_ambiguous_artifacts_fail_instead_of_falling_back(self):
        with self.assertRaises(ValueError):
            schemas.artifact_executable("", "fixture")
        records = [
            json.dumps(
                {
                    "reason": "compiler-artifact",
                    "target": {"name": "fixture", "kind": ["example"]},
                    "executable": path,
                }
            )
            for path in ["/a", "/b"]
        ]
        with self.assertRaises(ValueError):
            schemas.artifact_executable("\n".join(records), "fixture")
