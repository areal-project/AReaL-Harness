"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  configurePluginValues,
} = require("@areal/workbench-service/desktop/core/plugin-configuration.cjs");
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
function fixture() {
  const calls = [];
  const field = (sensitive) => ({
    definition: {
      type: "string",
      title: null,
      description: null,
      required: false,
      sensitive,
      default: null,
    },
    configured: sensitive,
    value: sensitive ? null : "old",
  });
  const detail = {
    id: "example@local",
    name: "example",
    displayName: "Example",
    description: "",
    source: "/source",
    sourceDigest: "candidate",
    revision: 3,
    components: [],
    skills: [],
    diagnostics: [],
    installed: true,
    enabled: true,
    installedDigest: "fixed",
    userConfiguration: {
      fields: { TITLE: field(false), TOKEN: field(true) },
      missingRequired: [],
      revision: 1,
    },
  };
  const project = {
    id: "p",
    pending: [],
    client: {
      async request(method, params, options) {
        calls.push({ method, params });
        if (method === "areal/plugin/read") return options.decode(detail);
        if (method === "areal/plugin/credentials/register") return { registered: 1 };
        throw new Error(method);
      },
    },
  };
  const backend = {
    starting: new Map(),
    hasWork: () => false,
    onChange() {},
    providers: {
      config: {
        async credential(value) {
          calls.push({ credential: value });
          return "AREAL_CREDENTIAL_private_ref";
        },
        key: () => "NORMALIZED_SECRET",
      },
    },
    async restartProject() {
      calls.push({ restart: true });
    },
    async submit(_project, method, params, options) {
      calls.push({ method, params, options });
      return { revision: 4, data: [], marketplaces: [], errors: [] };
    },
  };
  return { backend, project, calls };
}
test("empty secret edits preserve stored credentials, and clearKeys is an explicit patch", async () => {
  const { backend, project, calls } = fixture();
  await configurePluginValues(backend, project, {
    ...baseRequest,
    values: { TITLE: { kind: "string", value: "new" } },
    clearKeys: ["TOKEN"],
  });
  const submitted = calls.at(-1);
  assert.deepEqual(submitted.params, {
    id: "example@local",
    expectedRevision: 3,
    expectedDigest: "fixed",
    values: { TITLE: { kind: "string", value: "new" } },
    clearKeys: ["TOKEN"],
  });
  assert.equal(
    calls.some((call) => call.credential || call.restart),
    false,
  );
  assert.equal(submitted.options.requestId, requestId);
});
test("new credentials reach running Cores by reference before saving, without a restart", async () => {
  const { backend, project, calls } = fixture();
  const other = {
    client: {
      async request(method, params) {
        calls.push({ other: method, params });
        return { registered: 1 };
      },
    },
  };
  const offline = {
    client: {
      async request() {
        throw new Error("offline");
      },
    },
  };
  backend.projects = new Map([
    ["p", project],
    ["other", other],
    ["offline", offline],
  ]);
  const result = await configurePluginValues(backend, project, {
    ...baseRequest,
    secrets: { TOKEN: "SECRET_CANARY" },
  });
  const register = calls.findIndex((call) => call.method === "areal/plugin/credentials/register");
  assert.ok(register >= 0);
  assert.ok(register < calls.findIndex((call) => call.method === "areal/plugin/userConfig/set"));
  assert.deepEqual(calls[register].params, { credentials: { private_ref: "NORMALIZED_SECRET" } });
  assert.deepEqual(calls.find((call) => call.other)?.params, calls[register].params);
  assert.equal(
    calls.some((call) => call.restart),
    false,
  );
  assert.equal(result.reloadDeferred, true);
  assert.deepEqual(calls.at(-1).params.values, {
    TOKEN: { kind: "secretRef", value: "private_ref" },
  });
  assert.equal(JSON.stringify(result).includes("SECRET_CANARY"), false);
  assert.equal(JSON.stringify(result).includes("private_ref"), false);
});
test("browser writes reject private references and Main verifies exact schema before saving", async () => {
  assert.throws(() =>
    validateCommand("manage", {
      ...baseRequest,
      values: { TOKEN: { kind: "secretRef", value: "stolen" } },
    }),
  );
  assert.throws(() =>
    validateCommand("manage", { ...baseRequest, operation: "pluginUserConfigSet" }),
  );
  for (const patch of [
    { expectedDigest: "stale" },
    { values: { TOKEN: { kind: "string", value: "wrong boundary" } } },
    { secrets: { TITLE: "wrong field" } },
    { values: { TITLE: { kind: "string", value: "x" } }, clearKeys: ["TITLE"] },
  ]) {
    const { backend, project, calls } = fixture();
    await assert.rejects(configurePluginValues(backend, project, { ...baseRequest, ...patch }));
    assert.equal(
      calls.some((call) => call.credential || call.method === "areal/plugin/userConfig/set"),
      false,
    );
  }
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
