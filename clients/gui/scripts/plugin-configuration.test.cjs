"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  configurePluginValues,
  reloadPluginCredentials,
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
        if (method === "areal/server/drain") return { restartSafe: true };
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
test("Main creates credential references with the existing owner and restarts before Core consumes them", async () => {
  const { backend, project, calls } = fixture();
  const result = await configurePluginValues(backend, project, {
    ...baseRequest,
    secrets: { TOKEN: "SECRET_CANARY" },
  });
  assert.equal(
    calls.findIndex((call) => call.restart) <
      calls.findIndex((call) => call.method === "areal/plugin/userConfig/set"),
    true,
  );
  assert.deepEqual(calls.at(-1).params.values, {
    TOKEN: { kind: "secretRef", value: "private_ref" },
  });
  assert.equal(JSON.stringify(result).includes("SECRET_CANARY"), false);
  assert.equal(JSON.stringify(result).includes("private_ref"), false);
});
test("sensitive changes restart idle managed projects after saving and defer busy projects", async () => {
  const { backend, project, calls } = fixture();
  const { CoreBackend } = require("@areal/workbench-service/desktop/core/backend.cjs");
  project.model = { state: { threads: {}, queues: {} } };
  backend.hasWork = CoreBackend.prototype.hasWork;
  const idle = {
    pending: [],
    client: {
      async request(method, params) {
        calls.push({ other: "drain", method, params });
        return { restartSafe: true };
      },
    },
  };
  const busy = {
    pending: [{}],
    client: {
      async request() {
        assert.fail("busy project drained");
      },
    },
  };
  const unmanaged = {
    client: {
      async request() {
        assert.fail("unmanaged project drained");
      },
    },
  };
  backend.projects = new Map([
    ["p", project],
    ["idle", idle],
    ["busy", busy],
    ["unmanaged", unmanaged],
  ]);
  backend.providers.manages = (other) => other !== unmanaged;
  backend.restartProject = async (other) => calls.push({ other: "restart", project: other });
  const result = await configurePluginValues(backend, project, {
    ...baseRequest,
    clearKeys: ["TOKEN"],
  });
  assert.equal(result.reloadDeferred, true);
  assert.ok(
    calls.findIndex((call) => call.method === "areal/plugin/userConfig/set") <
      calls.findIndex((call) => call.other === "drain"),
  );
  assert.deepEqual(calls.find((call) => call.other === "drain").params, {
    strategy: "ifIdle",
    timeoutMs: 2000,
  });
  assert.equal(calls.find((call) => call.other === "restart").project, idle);
});
test("unsafe or failed drains defer reload without failing the save", async () => {
  for (const request of [
    async () => ({ restartSafe: false }),
    async () => {
      throw new Error("offline");
    },
  ]) {
    const { backend, project } = fixture();
    backend.projects = new Map([["other", { pending: [], client: { request } }]]);
    assert.equal(
      (
        await configurePluginValues(backend, project, {
          ...baseRequest,
          clearKeys: ["TOKEN"],
        })
      ).reloadDeferred,
      true,
    );
  }
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
    host: { scheduling: () => ({ suppressed: false, activationError: null }) },
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

test("a project can explicitly reload shared credentials through the existing idle drain and restart", async () => {
  const { backend, project, calls } = fixture();
  assert.deepEqual(await reloadPluginCredentials(backend, project), { reloaded: true });
  assert.deepEqual(
    calls.map((call) => call.method ?? "restart"),
    ["areal/server/drain", "restart"],
  );
  assert.equal(
    calls.some((call) => call.credential || call.method === "areal/plugin/userConfig/set"),
    false,
  );
});

const { manage } = require("@areal/workbench-service/desktop/core/management.cjs");
const { pluginMutations } = require("../packages/workbench/client/desktop-contract/management.cjs");
const recoverableOperations = {
  pluginUserConfigSave: "areal/plugin/userConfig/set",
  pluginDevelopmentLink: "areal/plugin/development/link",
  pluginDevelopmentUnlink: "areal/plugin/development/unlink",
};
function receiptFixture(mutation, receipt) {
  const reads = [];
  let writes = 0;
  const entry = {
    method: recoverableOperations[mutation] ?? "original-method",
    params: { id: "example@local", requestId },
  };
  const project = {
    id: "p",
    pending: [entry],
    client: {
      request() {
        writes++;
        assert.fail("receipt observation issued a new Core request");
      },
    },
  };
  const backend = {
    async readSubmission(owner, method, parameters) {
      assert.equal(owner, project);
      reads.push({ method, parameters });
      return receipt;
    },
    submit() {
      writes++;
      assert.fail("receipt observation replayed a mutation");
    },
    onChange() {},
  };
  const request = { operation: "pluginSubmission", projectId: project.id, mutation, requestId };
  return { backend, project, entry, request, reads, writes: () => writes };
}
for (const [mutation, method] of Object.entries(recoverableOperations)) {
  for (const state of ["completed", "failed", "unresolved"]) {
    test(`${mutation} reads its original ${state} receipt without replaying the write`, async () => {
      const receipt =
        state === "unresolved"
          ? { confirmed: false, state: "unknown" }
          : state === "failed"
            ? {
                confirmed: true,
                accepted: true,
                status: "failed",
                error: { message: "ORIGINAL_MUTATION_FAILED" },
                message: "ORIGINAL_MUTATION_FAILED",
              }
            : {
                confirmed: true,
                accepted: true,
                status: "completed",
                result: { revision: 4, data: [], marketplaces: [], errors: [] },
              };
      const fixture = receiptFixture(mutation, receipt);
      const result = await manage(fixture.backend, fixture.project, fixture.request);
      assert.deepEqual(result, receipt);
      assert.deepEqual(fixture.reads, [{ method, parameters: { requestId } }]);
      assert.equal(fixture.writes(), 0);
      assert.equal(fixture.project.pending[0], fixture.entry);
      assert.equal(fixture.entry.params.requestId, requestId);
      if (state === "unresolved") assert.equal(result, receipt);
    });
  }
}
test("every typed plugin mutation can reach original-receipt observation through the management adapter", async () => {
  for (const mutation of Object.keys(pluginMutations)) {
    const receipt = { confirmed: false, state: "unknown" };
    const fixture = receiptFixture(mutation, receipt);
    assert.equal(await manage(fixture.backend, fixture.project, fixture.request), receipt);
    assert.equal(fixture.reads.length, 1);
    assert.equal(fixture.reads[0].parameters.requestId, requestId);
    assert.equal(fixture.writes(), 0);
  }
});
test("plugin recovery rejects unrelated mutations before reaching the receipt owner", async () => {
  for (const mutation of [
    "providerSave",
    "pluginInstall",
    "pluginCredentialsReload",
    "unknownMutation",
  ]) {
    const fixture = receiptFixture(mutation, { confirmed: false });
    await assert.rejects(manage(fixture.backend, fixture.project, fixture.request));
    assert.equal(fixture.reads.length, 0);
    assert.equal(fixture.writes(), 0);
  }
});

test("confirmed plugin setup recovery refreshes its thread without replaying setup", async () => {
  const {
    readPluginSubmission,
  } = require("@areal/workbench-service/desktop/core/plugin-submission.cjs");
  const receipt = { confirmed: true, result: { thread: { id: "setup-thread" } } };
  const fixture = receiptFixture("pluginSetup", receipt);
  const events = [];
  fixture.backend.openThread = async (project, id) => {
    assert.equal(project, fixture.project);
    events.push(id);
  };
  fixture.backend.listThreads = async () => events.push("list");
  fixture.backend.onChange = () => events.push("change");
  assert.deepEqual(
    await readPluginSubmission(
      fixture.backend,
      fixture.project,
      fixture.request,
      "areal/plugin/setup",
    ),
    receipt,
  );
  assert.deepEqual(events, ["setup-thread", "list", "change"]);
  assert.equal(fixture.writes(), 0);
  fixture.backend.openThread = async () => {
    throw new Error("REFRESH_FAILED");
  };
  const result = await readPluginSubmission(
    fixture.backend,
    fixture.project,
    fixture.request,
    "areal/plugin/setup",
  );
  assert.equal(result.confirmed, true);
  assert.equal(result.result, receipt.result);
  assert.match(result.warning, /REFRESH_FAILED/);
  assert.equal(fixture.writes(), 0);
});
