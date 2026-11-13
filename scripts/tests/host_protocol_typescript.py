"""生成的 TypeScript 声明要用 GUI 依赖里的编译器检查，所以不放进免安装的脚本测试，由 make host-protocol-check 运行。"""

import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "host_protocol_generator", ROOT / "scripts/generate-host-protocol.py"
)
GEN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GEN)


class HostProtocolTypeScriptTests(unittest.TestCase):
    def test_typescript_requires_fields_and_narrows_control_operation(self):
        package = ROOT / "clients/gui/renderer/node_modules/typescript"
        self.assertTrue(
            (package / "package.json").is_file(),
            "Install GUI dependencies before checking generated TypeScript",
        )
        metadata = json.loads((package / "package.json").read_text())
        compiler = package / metadata["bin"]["tsc6"]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shutil.copyfile(ROOT / GEN.OUTPUTS[1], root / "host-protocol.d.ts")
            (
                root / "consumer.ts"
            ).write_text("""import type { LocalHelloParams, RemoteProjectListResult, RemoteSessionControlParams, RemoteSessionSendParams } from './host-protocol';
const hello: LocalHelloParams = {protocolVersions:[1], capabilities:[], authToken:'fixture'};
// @ts-expect-error authToken is required.
const missing: LocalHelloParams = {protocolVersions:[1], capabilities:[]};
const result: RemoteProjectListResult = {projects:[{projectId:'p', name:'P', connectionState:'offline', serviceGeneration:null}], nextCursor:null};
// @ts-expect-error nullable serviceGeneration is required, not optional.
const incomplete: RemoteProjectListResult = {projects:[{projectId:'p', name:'P', connectionState:'offline'}], nextCursor:null};
// @ts-expect-error optional enqueue does not accept explicit null.
const send: RemoteSessionSendParams = {threadId:'t', expectedConfigRevision:1, text:'hello', enqueue:null};
function inspect(control: RemoteSessionControlParams) {
  if (control.operation === 'goalCreate') {
    control.values.objective.toUpperCase();
    // @ts-expect-error goalCreate does not carry queueItemId.
    control.values.queueItemId;
  }
  if (control.operation === 'configure') control.values.model?.providerId;
}
""")
            subprocess.run(
                [
                    "node",
                    str(compiler),
                    "--strict",
                    "--noEmit",
                    "--skipLibCheck",
                    "--ignoreConfig",
                    str(root / "consumer.ts"),
                ],
                cwd=ROOT,
                check=True,
            )


if __name__ == "__main__":
    unittest.main()
