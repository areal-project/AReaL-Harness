const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { ScopedResources } = require("../app/src/core/scoped-resources.cjs");

const config = {
  transport: {
    type: "streamableHttp",
    url: "https://mcp.fixture.invalid/mcp",
    bearerTokenEnv: null,
  },
  startupTimeoutMs: 10000,
  callTimeoutMs: 30000,
  enabledTools: null,
};
const original = {
  revision: 3,
  skills: {},
  mcp: [{ id: "existing", runtimeId: "user_existing", config }],
};

async function fixture(t, projects = [], initial = original) {
  const home = await mkdtemp(join(tmpdir(), "areal-scoped-mcp-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "resources.json"), JSON.stringify(initial));
  const applied = new Map();
  const backend = {
    home,
    projects: new Map(projects.map((project) => [project.id, project])),
    starting: new Set(),
    activeCommands: 0,
    resourcesUpdating: false,
    providerUpdating: false,
    onChange() {},
    async save(name, value) {
      await writeFile(join(home, name), JSON.stringify(value));
    },
    async submit(project, method, params) {
      assert.equal(method, "areal/mcp/configure");
      const persisted = JSON.parse(await readFile(join(home, "resources.json"), "utf8"));
      assert.deepEqual(
        persisted.mcp.find((item) => item.runtimeId === params.id)?.config,
        params.config,
        "the user configuration must be durable before synchronization",
      );
      if (project.syncFails) throw new Error("fixture synchronization failure");
      const records = applied.get(project.id) ?? [];
      records.push(params);
      applied.set(project.id, records);
    },
  };
  const resources = new ScopedResources(backend);
  await resources.init();
  const request = {
    operation: "mcpSave",
    scope: "user",
    id: "new_server",
    expectedRevision: initial.revision,
    config,
  };
  return {
    resources,
    backend,
    applied,
    request,
    async persisted() {
      return JSON.parse(await readFile(join(home, "resources.json"), "utf8"));
    },
    async reopened() {
      const reopened = new ScopedResources(backend);
      await reopened.init();
      return reopened.command({ operation: "mcp", scope: "user" });
    },
  };
}

function project(id, { ready = false, pending = [], live = [], syncFails = false } = {}) {
  return {
    id,
    root: `/fixture/${id}`,
    service: { serviceId: `service-${id}` },
    pending,
    syncFails,
    client: {
      ready,
      async request(method) {
        assert.equal(ready, true, "a disconnected project must not receive requests");
        assert.equal(method, "areal/mcp/list");
        return { data: live };
      },
    },
  };
}

test("new user MCP persists while an unrelated project is disconnected", async (t) => {
  const f = await fixture(t, [project("disconnected")]);
  assert.deepEqual(await f.resources.command(f.request), { revision: 4, warning: null });
  const saved = await f.persisted();
  const added = saved.mcp.find((item) => item.id === "new_server");
  assert.equal(saved.revision, 4);
  assert.deepEqual(saved.mcp[0], original.mcp[0]);
  assert.deepEqual(added.config, config);
  assert.notEqual(added.runtimeId, original.mcp[0].runtimeId);
  assert.deepEqual(
    (await f.reopened()).data.find((item) => item.id === "new_server"),
    { ...added, liveRevision: 0, scope: "user", state: "notApplied" },
  );
  assert.equal(f.backend.resourcesUpdating, false);
});

for (const id of ["new_server", "existing"]) {
  test(`pending operations block saving ${id} before persistence`, async (t) => {
    const f = await fixture(t, [
      project("pending", { ready: true, pending: [{ requestId: "unknown" }] }),
    ]);
    await assert.rejects(
      f.resources.command({ ...f.request, id }),
      /恢复所有项目连接并核对未确认操作/,
    );
    assert.deepEqual(await f.persisted(), original);
    assert.equal(f.applied.size, 0);
    assert.equal(f.backend.resourcesUpdating, false);
  });
}

test("editing an existing user MCP requires all started projects to be ready", async (t) => {
  const f = await fixture(t, [project("disconnected")]);
  await assert.rejects(
    f.resources.command({ ...f.request, id: "existing" }),
    /恢复所有项目连接并核对未确认操作/,
  );
  assert.deepEqual(await f.persisted(), original);
});

for (const state of ["connected", "stale"]) {
  test(`editing an existing ${state} user MCP requires disconnecting it`, async (t) => {
    const live = [{ id: "user_existing", revision: 7, state, config }];
    const f = await fixture(t, [project("active", { ready: true, live })]);
    await assert.rejects(
      f.resources.command({ ...f.request, id: "existing" }),
      /请先在 .* 断开 existing/,
    );
    assert.deepEqual(await f.persisted(), original);
    assert.equal(f.applied.size, 0);
  });
}

test("stale resource revisions fail before persistence", async (t) => {
  const f = await fixture(t, [project("disconnected")]);
  await assert.rejects(f.resources.command({ ...f.request, expectedRevision: 2 }), /配置已变化/);
  assert.deepEqual(await f.persisted(), original);
});

test("new user MCP synchronizes ready projects and defers disconnected projects", async (t) => {
  const f = await fixture(t, [project("ready", { ready: true }), project("disconnected")]);
  assert.deepEqual(await f.resources.command(f.request), { revision: 4, warning: null });
  const saved = await f.persisted();
  assert.deepEqual(
    f.applied.get("ready"),
    saved.mcp.map((item) => ({ id: item.runtimeId, expectedRevision: 0, config: item.config })),
  );
  assert.equal(f.applied.has("disconnected"), false);
});

test("editing a disconnected MCP retains its runtime identity and applies its current revision", async (t) => {
  const live = [{ id: "user_existing", revision: 7, state: "disconnected", config }];
  const f = await fixture(t, [project("ready", { ready: true, live })]);
  const updated = { ...config, callTimeoutMs: 45000 };
  assert.deepEqual(await f.resources.command({ ...f.request, id: "existing", config: updated }), {
    revision: 4,
    warning: null,
  });
  assert.deepEqual((await f.persisted()).mcp, [
    { id: "existing", runtimeId: "user_existing", config: updated },
  ]);
  assert.deepEqual(f.applied.get("ready"), [
    { id: "user_existing", expectedRevision: 7, config: updated },
  ]);
});

test("synchronization failure reports a warning after preserving the saved configuration", async (t) => {
  const f = await fixture(t, [project("failed", { ready: true, syncFails: true })]);
  const result = await f.resources.command(f.request);
  assert.equal(result.revision, 4);
  assert.match(result.warning, /配置已保存，部分项目未同步.*fixture synchronization failure/);
  assert.equal(
    (await f.reopened()).data.some((item) => item.id === "new_server"),
    true,
  );
  assert.equal(f.backend.resourcesUpdating, false);
});
