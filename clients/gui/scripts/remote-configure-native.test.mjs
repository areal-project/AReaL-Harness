import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeHostFixture, nativeCoreProject } from "./remote-native-host-fixture.mjs";
import { fastPreservation } from "./remote-configure-scenario.mjs";
import { until, pushRelay, phone, runWithIsolatedCA } from "./remote-native-push-fixture.mjs";

const require = createRequire(import.meta.url);
const { CoreBackend } = require("../app/src/core/backend.cjs");
const { RemoteControl } = require("../app/src/core/remote.cjs");

if (!process.env.RC12_TLS_HOME) {
  test("native configure uses the isolated process CA", async () => {
    await runWithIsolatedCA(import.meta.filename);
  });
} else {
  test("native configure preserves the original Fast setting", { timeout: 120000 }, async (t) => {
    let backend, legacy, drained;
    const drain = () =>
      (drained ??= (async () => {
        await legacy?.close();
        await backend?.disconnect();
      })());
    t.after(drain);
    const relay = await pushRelay(t);
    const f = await nativeHostFixture(t, { deferNative: true });
    const native = await nativeCoreProject(t, f);
    const evidence = { responses: [] };
    t.after(() =>
      writeFile(
        join(f.evidence.root, "native-configure-evidence.json"),
        JSON.stringify(evidence, null, 2),
        {
          mode: 0o600,
        },
      ),
    );
    backend = new CoreBackend({
      binary: f.evidence.binary,
      home: f.source.source.coreHome,
      hostHome: f.home,
      guiProfile: f.source.source.profile,
      harnessHome: f.source.source.legacyServiceHome,
      sourceSingletonHeld: true,
      userHome: join(f.evidence.root, "user"),
      configHome: join(f.evidence.root, "configuration"),
      encryption: f.source.options.encryption,
    });
    backend.host = f.source;
    await backend.init();
    const oldProject = await backend.start(native.alias);
    assert.equal(oldProject.service.serviceId, native.service.serviceId);
    assert.equal(oldProject.service.generation, native.service.generation);
    legacy = new RemoteControl({ backend, schedule() {} });
    await legacy.init();
    await legacy.control({
      operation: "enable",
      relay: relay.origin,
      code: relay.enrollment(),
      confirmed: true,
    });
    await until(() => legacy.connected, "original JS owner connected");
    const oldPhone = await phone(t, legacy, native.alias, undefined, true);
    const oldContext = {
      projectId: native.alias,
      gatewayGeneration: oldPhone.active.gatewayGeneration,
      grantRevision: oldPhone.active.grantRevision,
      serviceGeneration: native.service.generation,
    };
    const oldResult = await fastPreservation({
      rpc: (method, params = {}) => oldPhone.rpc(method, params, randomUUID(), oldContext),
      native: (method, params) => native.core.call(method, params),
    });
    const dispatches = [];
    let originalOperation;
    const requestCore = oldProject.client.request.bind(oldProject.client);
    oldProject.client.request = async (method, params, ...rest) => {
      if (method === "areal/request/read" && params.requestId === originalOperation)
        throw Object.assign(new Error("original receipt withheld until owner drain"), {
          submissionUnknown: true,
        });
      if (method !== "areal/thread/configure") return requestCore(method, params, ...rest);
      dispatches.push(params.requestId);
      await requestCore(method, params, ...rest);
      originalOperation = params.requestId;
      throw Object.assign(new Error("original configure reply lost"), { submissionUnknown: true });
    };
    const originalId = randomUUID();
    const lost = await oldPhone.rpc(
      "session.control",
      {
        threadId: oldResult.fastThread,
        operation: "configure",
        values: { parameters: { reasoningEffort: "low" } },
        expectedRevision: oldResult.configuration.revision,
      },
      originalId,
      oldContext,
    );
    assert.equal(lost.result.admissionState, "unknown");
    assert.equal(dispatches.length, 1);
    const journal = f.client.journal(native.projectId);
    const old = (await journal.read()).snapshot.pending.find(
      (row) => row.operationId === originalOperation,
    );
    assert.equal(old.remote.commandId, originalId);
    assert.equal(old.nativeDigest, undefined);
    assert.equal(old.coreScope, undefined);
    evidence.legacy = { oldResult, lost, original: old, dispatches };
    oldPhone.close();
    await drain();
    const remote = await f.make();
    await until(async () => (await remote.refresh()).connected, "native Relay connected");
    const client = await phone(t, remote, native.alias, oldPhone.identity);
    const revisionBeforeRead = (
      await native.core.call("areal/thread/inspect", { threadId: oldResult.fastThread })
    ).configuration.revision;
    const recovered = await client.rpc("command.read", { commandId: originalId }, undefined, {
      projectId: native.alias,
    });
    assert.equal(recovered.result.admissionState, "accepted", JSON.stringify(recovered));
    assert.equal(recovered.result.operationId, originalOperation);
    assert.equal(
      (await native.core.call("areal/thread/inspect", { threadId: oldResult.fastThread }))
        .configuration.revision,
      revisionBeforeRead,
    );
    const retained = (
      await client.rpc(
        "command.read",
        { commandId: oldResult.effortSaved.result.commandId },
        undefined,
        { projectId: native.alias },
      )
    ).result;
    assert.equal(retained.operationId, oldResult.effortSaved.result.operationId);
    assert.equal(retained.admissionState, "accepted");
    const proved = (await journal.read()).snapshot.outcomes[originalOperation];
    assert.deepEqual(proved.remote, old.remote);
    assert.equal(proved.nativeDigest, undefined);
    assert.equal(proved.coreScope, undefined);
    assert.equal(proved.legacyReceiptProof.source.sourceId, f.source.sourceId);
    assert.equal(proved.legacyReceiptProof.source.migrationId, f.source.migrationId);
    evidence.legacy.recovered = recovered;
    evidence.legacy.proof = proved.legacyReceiptProof;
    const project = (await client.rpc("project.list")).result.projects.find(
      (project) => project.projectId === native.alias,
    );
    const context = {
      projectId: native.alias,
      gatewayGeneration: client.active.gatewayGeneration,
      grantRevision: client.active.grantRevision,
      serviceGeneration: project.serviceGeneration,
    };
    const rpc = async (method, params = {}, commandId = randomUUID()) => {
      const response = await client.rpc(
        method,
        params,
        method === "command.read" ? undefined : commandId,
        method === "command.read" ? { projectId: native.alias } : context,
      );
      evidence.responses.push({ method, commandId, response });
      return response;
    };
    const result = await fastPreservation({
      rpc,
      native: (method, params) => native.core.call(method, params),
    });
    evidence.result = result;
    const original = result.effortSaved.result;
    assert.equal(
      (await rpc("command.read", { commandId: original.commandId })).result.operationId,
      original.operationId,
    );
  });
}
