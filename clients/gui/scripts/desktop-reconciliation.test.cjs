"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { CoreBackend } = require("@areal/workbench-service/desktop/core/backend.cjs");
const contract = require("../packages/workbench/client/desktop-contract.cjs");
const { hostCoreClient } = require("./support/host-core-fixture.cjs");

async function fixture(t, entries, read) {
  const home = await mkdtemp(join(tmpdir(), "areal-desktop-receipts-"));
  const backend = Object.assign(Object.create(CoreBackend.prototype), {
    home,
    rustDomains: [],
    saves: new Map(),
    awaitingResponses: new Set(),
    onChange() {},
    providers: { redact: (value) => value, acceptModelSelection: async () => {}, rejectModel() {} },
    lifecycleOperations: { activeTargets: new Set(), blocking: () => false },
    listThreads: async () => {},
    openThread: async () => {},
  });
  const calls = [];
  const project = {
    id: "project",
    pending: entries,
    outcomes: {},
    configurations: {},
    connectionGeneration: 1,
    model: { state: { connected: true, threads: {} }, setTask() {} },
    client: await hostCoreClient({
      capabilities: {
        methods: [],
        features: { operationOutcomes: true, taskRequestReceipts: true },
      },
      request: async (method, params) => {
        calls.push({ method, params });
        return read(method, params);
      },
    }),
  };
  const journals = new Map();
  const journalFor = (id) => {
    let journal = journals.get(id);
    if (!journal) {
      const owner = id === project.id ? project : backend.projects.get(id);
      let snapshot = structuredClone({
        version: 1,
        pending: owner.pending,
        outcomes: owner.outcomes,
      });
      journal = {
        read: async () => ({ snapshot: structuredClone(snapshot) }),
        change: async (mutate) => {
          snapshot = structuredClone(await mutate(structuredClone(snapshot)));
          return { state: "completed" };
        },
      };
      journals.set(id, journal);
    }
    return journal;
  };
  backend.host = { journal: journalFor };
  t.after(async () => {
    backend.closing = true;
    clearTimeout(project.reconciliation?.timer);
    await rm(home, { recursive: true, force: true });
  });
  return { backend, project, calls };
}
const entry = (method, params) => ({ method, params: { ...params, requestId: randomUUID() } });
test("command declarations distinguish mixed reads, subscriptions and recoverable writes", () => {
  for (const name of Object.keys(contract.commandDefinitions))
    assert.ok(contract.commandDefinitions[name][2], name);
  for (const [name, operation, effect] of [
    ["manage", "task", "read"],
    ["manage", "taskWatch", "subscription"],
    ["manage", "taskPause", "mutation"],
    ["manage", "pluginSubmission", "read"],
    ["side", "context", "read"],
    ["resources", "skillRead", "read"],
    ["providers", "revealKey", "read"],
    ["library", "readThread", "mutation"],
  ])
    assert.equal(
      contract.commandSemantics(name, { operation }).effect,
      effect,
      `${name}/${operation}`,
    );
  assert.equal(contract.commandSemantics("create", {}).requestId, "requestId");
  assert.equal(
    contract.commandSemantics("manage", { operation: "taskDraftStart" }).requestId,
    "draftId",
  );
  assert.throws(() => contract.commandSemantics("manage", { operation: "futureRead" }));
});
test("legacy configuration recovery only observes and retains unknown original identity", async (t) => {
  const item = {
    method: "areal/thread/configure",
    localOnly: true,
    params: { threadId: "thread", expectedRevision: 1 },
  };
  const f = await fixture(t, [item], async (method) => {
    assert.equal(method, "areal/thread/inspect");
    return { configuration: { revision: 1 } };
  });
  await f.backend.reconcile(f.project);
  assert.deepEqual(f.project.pending, [item]);
  assert.equal(item.params.requestId, undefined);
  assert.equal(
    f.calls.some((call) => call.method === "areal/thread/configure"),
    false,
  );
});
test("legacy creation never infers rejection from a negative proof without its original binding", async (t) => {
  const item = entry("areal/thread/start", {});
  const f = await fixture(t, [item], async () => ({
    data: [],
    creationAdmission: {
      identity: "owner",
      journalEpoch: randomUUID(),
      coreInstanceId: randomUUID(),
      requestId: item.params.requestId,
      method: item.method,
      status: "notAdmitted",
    },
  }));
  await f.backend.reconcile(f.project);
  assert.deepEqual(f.project.pending, [item]);
  assert.equal(f.project.outcomes[item.params.requestId], undefined);
});
test("a rebuilt Remote control journal preserves the original interaction and operation identity", async (t) => {
  const started = Promise.withResolvers();
  const response = Promise.withResolvers();
  const f = await fixture(t, [], async () => {
    throw new Error("control recovery must not query Core while dispatch is pending");
  });
  const remote = {
    hostId: "host",
    devicePeerId: "device",
    projectId: f.project.id,
    commandId: "command",
    method: "interaction.respond",
    capability: "control",
    semanticDigest: "digest",
    target: {},
  };
  const submitting = f.backend.submit(
    f.project,
    "areal/interaction/respond",
    {
      requestId: "interaction-request",
      threadId: "thread",
      turnId: "turn",
    },
    {
      remote,
      dispatch: async () => {
        started.resolve();
        return response.promise;
      },
    },
  );
  await started.promise;
  const original = f.project.pending[0];
  const other = {
    ...structuredClone(original),
    operationId: randomUUID(),
    remote: { ...remote, commandId: "other-command" },
  };
  await f.backend.changePending(f.project, () => structuredClone([original, other]));
  try {
    const recovered = await f.backend.readRemoteRecord(f.project, remote);
    assert.equal(recovered.params.requestId, "interaction-request");
    assert.equal(recovered.operationId, original.operationId);
    assert.equal(f.calls.length, 0);
    await f.backend.reconcile(f.project);
    assert.deepEqual(f.project.pending, [original, other]);
  } finally {
    response.resolve({});
    await submitting;
  }
  assert.deepEqual(f.project.pending, [other]);
  assert.equal(f.project.outcomes[original.operationId].admissionState, "accepted");
  assert.equal(f.project.outcomes[other.operationId], undefined);
});
