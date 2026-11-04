import copy
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


class HostProtocolSchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.schema = json.loads((ROOT / GEN.SCHEMA).read_text())

    def test_current_inventory_matches_actual_dispatch_and_handshake(self):
        GEN.check_inventory(self.schema, ROOT)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("server.rs", "subscription/host.rs", "gateway/session.rs"):
                target = root / "core/host/src" / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / "core/host/src" / name, target)
            source = root / "core/host/src/gateway/session.rs"
            source.write_text(
                source.read_text().replace(
                    '    "session.create",', '    "future.added2",\n    "session.create",', 1
                )
            )
            with self.assertRaisesRegex(ValueError, "future.added2"):
                GEN.check_inventory(self.schema, root)
            shutil.copyfile(ROOT / "core/host/src/gateway/session.rs", source)
            source = root / "core/host/src/server.rs"
            source.write_text(
                source.read_text().replace(
                    '            "host.status" => {',
                    '            "host.added2" => Ok(json!({})),\n            "host.status" => {',
                    1,
                )
            )
            with self.assertRaisesRegex(ValueError, "host.added2"):
                GEN.check_inventory(self.schema, root)

    def test_generator_is_deterministic_and_check_never_repairs_stale_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in (
                GEN.SCHEMA,
                Path("core/host/src/server.rs"),
                Path("core/host/src/subscription/host.rs"),
                Path("core/host/src/gateway/session.rs"),
            ):
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / name, target)
            GEN.generate(root)
            original = [(root / name).read_bytes() for name in GEN.OUTPUTS]
            GEN.generate(root)
            self.assertEqual(original, [(root / name).read_bytes() for name in GEN.OUTPUTS])
            GEN.generate(root, check=True)
            changed = copy.deepcopy(self.schema)
            changed["$defs"]["LocalHelloParams"]["description"] = (
                "Schema-only edit must stale outputs."
            )
            (root / GEN.SCHEMA).write_text(json.dumps(changed))
            with self.assertRaisesRegex(ValueError, "stale generated file"):
                GEN.generate(root, check=True)
            self.assertEqual(original, [(root / name).read_bytes() for name in GEN.OUTPUTS])

    def test_unsupported_shapes_fail_instead_of_generating_wide_types(self):
        for shape in (
            {"allOf": [{"type": "string"}]},
            {"type": ["string", "null"]},
            {"$ref": "#/missing"},
            {"type": "object", "patternProperties": {".*": {"type": "string"}}},
            {
                "type": "object",
                "properties": {"known": {"type": "string"}},
                "additionalProperties": {"type": "integer"},
            },
        ):
            with self.subTest(shape=shape):
                changed = copy.deepcopy(self.schema)
                changed["$defs"]["Unsupported"] = shape
                with self.assertRaises(ValueError):
                    GEN.validate_schema(changed)

    def test_examples_and_boundary_semantics_with_standard_json_schema_validator(self):
        script = r"""
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Ajv = require('ajv/dist/2020.js').default;
const schema = JSON.parse(fs.readFileSync('schemas/areal-host-protocol-v1.json', 'utf8'));
const ajv = new Ajv({strict:false, allErrors:true});
const hyphenatedUuid = '[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}';
const uuid = new RegExp(`^(?:[0-9a-fA-F]{32}|${hyphenatedUuid}|urn:uuid:${hyphenatedUuid}|\\{${hyphenatedUuid}\\})$`);
ajv.addFormat('uuid', {type:'string',validate:(value)=>uuid.exec(value)?.[0]===value});
ajv.addKeyword({keyword:'x-maxUtf8Bytes',type:'string',schemaType:'number',validate:(limit,value)=>Buffer.byteLength(value)<=limit});
ajv.addSchema(schema);
const validate = (ref, value, expected = true) => {
  const validator = ajv.getSchema(schema.$id + ref);
  assert(validator, ref);
  assert.equal(validator(value), expected, ref + ': ' + ajv.errorsText(validator.errors));
};
for (const transport of ['local','remote']) {
  for (const [method, entry] of Object.entries(schema['x-current'][transport].methods)) {
    for (const kind of ['request','result']) {
      const def = schema.$defs[entry[kind].slice(8)];
      assert(def.examples?.length, `${transport} ${method} ${kind} has examples`);
      for (const example of def.examples) validate(entry[kind], example);
    }
    const request = structuredClone(schema.$defs[entry.request.slice(8)].examples[0]);
    request.extraEnvelopeField = true;
    validate(entry.request, request, false);
    delete request.extraEnvelopeField;
    delete request.params;
    validate(entry.request, request, false);
  }
}
const canonicalUuid = '01234567-89ab-cdef-0123-456789abcdef';
for (const commandId of [canonicalUuid, canonicalUuid.toUpperCase(), canonicalUuid.replaceAll('-', ''), `urn:uuid:${canonicalUuid}`, `{${canonicalUuid}}`]) {
  validate('#/$defs/RemoteCommandReadParams', {commandId});
}
for (const commandId of ['', 'not-a-uuid', canonicalUuid + '\n', `URN:UUID:${canonicalUuid}`, `{${canonicalUuid.replaceAll('-', '')}}`, canonicalUuid.replace('f', 'g')]) {
  validate('#/$defs/RemoteCommandReadParams', {commandId}, false);
}
validate('#/$defs/RemoteModel', {providerId:null,modelId:'default'});
validate('#/$defs/RemoteModel', {providerId:'provider',modelId:'configured'});
validate('#/$defs/RemoteModel', {modelId:'missing-provider'}, false);
validate('#/$defs/RemoteModel', {providerId:7,modelId:'invalid-provider'}, false);
validate('#/$defs/RemoteModelSelection', {providerId:null,modelId:'default'}, false);
validate('#/$defs/SubscriptionAction', {kind:'begin',target:null});
validate('#/$defs/SubscriptionAction', {kind:'begin',target:{kind:'future',extra:1}});
validate('#/$defs/SubscriptionAction', {kind:'refreshCatalog',force:'ignored'});
validate('#/$defs/RemoteHello', {method:'hello',apiVersion:'areal.remote.v2',clientVersion:'test',displayName:'test',inviteSecret:null}, false);
validate('#/$defs/RemoteConfig', {enabled:null,deviceGrants:[null]});
validate('#/$defs/RemoteConfig', {deviceGrants:[{projectIds:3}]}, false);
const send = structuredClone(schema.$defs.RemoteSessionSendRequest.examples[0]);
send.params.text = '界'.repeat(21845) + 'a';
validate('#/$defs/RemoteSessionSendRequest', send);
send.params.text += 'b';
validate('#/$defs/RemoteSessionSendRequest', send, false);
send.params.text = 'hello'; send.params.enqueue = null;
validate('#/$defs/RemoteSessionSendRequest', send, false);
delete send.params.enqueue; send.context.unknown = true;
validate('#/$defs/RemoteSessionSendRequest', send, false);
const open = structuredClone(schema.$defs.RemoteSessionOpenRequest.examples[0]);
open.context.unknown = true;
validate('#/$defs/RemoteSessionOpenRequest', open);
validate('#/$defs/RemoteProjectListResult', {projects:[{projectId:'p',name:'p',connectionState:'offline',serviceGeneration:null}],nextCursor:null});
validate('#/$defs/RemoteProjectListResult', {projects:[{projectId:'p',name:'p',connectionState:'offline'}],nextCursor:null}, false);
const controls = schema.$defs.RemoteSessionControlParams.examples;
for (const value of controls) validate('#/$defs/RemoteSessionControlParams', value);
validate('#/$defs/RemoteSessionControlParams', {threadId:'t',operation:'queuePause',expectedRevision:0,values:{text:'wrong'}}, false);
validate('#/$defs/RemoteSessionControlParams', {threadId:'t',operation:'goalCreate',expectedRevision:0,values:{goalId:'wrong'}}, false);
validate('#/$defs/RemoteSessionControlParams', {threadId:'t',operation:'configure',expectedRevision:0,values:{model:null}});
validate('#/$defs/RemoteSessionControlParams', {threadId:'t',operation:'configure',expectedRevision:0,values:{}}, false);
for (const name of Object.keys(schema['x-current'].remote.methods)) assert(!/upload|shell\./.test(name));
assert.deepEqual(schema.$defs.ProposalHelloParams.properties.grants.items.enum, ['observe','submit','approve','manage']);
"""
        subprocess.run(["node", "-e", script], cwd=ROOT, check=True)

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
