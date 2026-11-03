import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { nativeHostFixture } from "./remote-native-host-fixture.mjs";

export async function assertNativeRelaySaveFailure(t, relay) {
  const f = await nativeHostFixture(t);
  f.evidence.relay = relay.resources;
  const path = join(f.source.source.coreHome, "host-remote-gateway-operation.json");
  const beforeBytes = await readFile(path);
  const mode = (await stat(path)).mode & 0o777;
  const before = await f.client.request("remote.read", {});
  const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const evidence = { path, originalMode: mode, beforeRemoteSha256: digest(before) };
  try {
    await chmod(path, 0o400);
    try {
      await f.remote.control({
        operation: "enable",
        relay: relay.origin,
        code: relay.admin("enrollment").code,
        confirmed: true,
      });
      assert.fail("read-only durable record unexpectedly accepted the write");
    } catch (error) {
      evidence.error = { name: error.name, code: error.code };
      evidence.reference = structuredClone(f.remote.pending);
      assert.equal(error.code, "EACCES");
    }
    const reference = evidence.reference;
    assert.equal(reference.method, "remote.gateway.control");
    assert.equal(reference.sourceId, f.source.sourceId);
    assert.equal(reference.hostId, f.client.hostId);
    assert.equal(reference.generation, f.client.generation);
    assert.match(reference.requestId, /^[0-9a-f-]{36}$/);
    assert.match(reference.controlDigest, /^[a-f0-9]{64}$/);
    const operation = await f.client.operation(reference.requestId);
    evidence.originalOperationFound = operation.operation !== null;
    assert.equal(evidence.originalOperationFound, false);
    const after = await f.client.request("remote.read", {});
    evidence.afterRemoteSha256 = digest(after);
    assert.ok(isDeepStrictEqual(after, before), "original Remote configuration remains unchanged");
    assert.deepEqual(await readFile(path), beforeBytes);
    const state = await f.remote.refresh();
    evidence.publicState = { enabled: state.enabled, connected: state.connected };
    assert.equal(state.enabled, false);
    assert.equal(state.connected, false);
    await new Promise((resolve) => setTimeout(resolve, 250));
    evidence.hostRegistrations = relay.hostRegistrations.slice();
    evidence.acceptedTlsConnections = relay.acceptedTlsConnections;
    assert.deepEqual(evidence.hostRegistrations, []);
    assert.equal(evidence.acceptedTlsConnections, 0);
    evidence.observation =
      "real EACCES before original control submission; original operation absent and configuration unchanged; no TLS connection or Host registration observed during the bounded 250ms follow-up";
  } finally {
    await chmod(path, mode);
    evidence.restoredMode = (await stat(path)).mode & 0o777;
    assert.equal(evidence.restoredMode, mode);
    await f.remote.close();
    const evidencePath = join(f.evidence.root, "native-relay-save-failure.json");
    f.evidence.nativeSaveFailure = { evidencePath, reference: evidence.reference };
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    t.diagnostic(`native save failure evidence: ${evidencePath}`);
  }
}
