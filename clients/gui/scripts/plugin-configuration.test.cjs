"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { snapshotProject } = require("@areal/workbench-service/desktop/core/project-snapshot.cjs");
const { validateCommand } = require("../packages/workbench/client/desktop-contract.cjs");
const requestId = "00000000-0000-4000-a000-000000000111";
const baseRequest = {
  projectId: "p",
  operation: "pluginUserConfigSave",
  id: "example@local",
  expectedRevision: 3,
  expectedDigest: "fixed",
  requestId,
  values: {},
  secrets: {},
};
test("browser writes reject private references and internal operations", () => {
  assert.throws(() =>
    validateCommand("manage", {
      ...baseRequest,
      values: { TOKEN: { kind: "secretRef", value: "stolen" } },
    }),
  );
  assert.throws(() =>
    validateCommand("manage", { ...baseRequest, operation: "pluginUserConfigSet" }),
  );
});
test("unresolved public snapshots keep original request identity and omit private configuration references", () => {
  const entry = {
    method: "areal/plugin/userConfig/set",
    params: {
      requestId,
      id: "example@local",
      expectedDigest: "fixed",
      expectedRevision: 3,
      values: { TOKEN: { kind: "secretRef", value: "PRIVATE_REFERENCE_CANARY" } },
    },
  };
  const live = { pending: [entry], model: { getSnapshot: () => null } };
  const backend = {
    projects: new Map([["p", live]]),
    binary: "/trusted/areal",
    ownerTasks: { revision: () => 0 },
    host: {
      scheduling: () => ({ suppressed: false, activationError: null }),
      migrationError: () => undefined,
    },
    cloudConversations: {
      mergeSnapshot: (_id, value) => value,
      projection: () => ({ summaries: [] }),
    },
    providers: { catalog: () => [], manages: () => true },
    awaitingResponses: new Set(),
  };
  const published = snapshotProject(backend, { id: "p", root: "/workspace" }, new Set());
  assert.equal(JSON.stringify(published).includes("PRIVATE_REFERENCE_CANARY"), false);
  assert.deepEqual(published.pending[0].params, {
    id: "example@local",
    expectedRevision: 3,
    expectedDigest: "fixed",
    requestId,
  });
  assert.equal(entry.params.values.TOKEN.value, "PRIVATE_REFERENCE_CANARY");
});
