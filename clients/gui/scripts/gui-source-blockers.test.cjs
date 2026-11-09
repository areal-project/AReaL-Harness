"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { GuiHostProjects } = require("@areal/workbench-service/desktop/core/gui-host-projects.cjs");
const { GuiSourceAdapter } = require("@areal/workbench-service/desktop/core/gui-source.cjs");

test("source migration reports safe actionable blockers without exposing source data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "areal-source-blockers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = new GuiHostProjects({
    binary: "/unused",
    home: join(root, "host"),
    singletonHeld: true,
    source: {
      profile: join(root, "profile"),
      coreHome: join(root, "core"),
      legacyServiceHome: join(root, "legacy"),
    },
  });
  owner.client.connectOrStart = async () => {};
  owner.client.requireCapability = () => {};
  owner.client.sourceState = async () => null;
  const original = GuiSourceAdapter.prototype.import;
  t.after(() => {
    GuiSourceAdapter.prototype.import = original;
  });
  for (const [code, expected] of [
    ["sourceGuardRequired", /原.*单实例/],
    ["credentialsRequired", /凭据/],
    ["legacyPending", /旧后台/],
    ["unrecognized", /无法确认/],
  ]) {
    GuiSourceAdapter.prototype.import = async () => ({
      kind: "blocked",
      blockers: [{ code, message: "SECRET_FIXTURE" }],
    });
    await assert.rejects(owner.init(), (error) => {
      assert.equal(error.code, "GUI_SOURCE_PENDING");
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /SECRET_FIXTURE|unrecognized/);
      return true;
    });
  }
});

test("committed projects remain usable when retirement is pending and retry keeps its identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "areal-source-retirement-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = new GuiHostProjects({
    binary: "/unused",
    home: join(root, "host"),
    singletonHeld: true,
    source: {
      profile: join(root, "profile"),
      coreHome: join(root, "core"),
      legacyServiceHome: join(root, "legacy"),
    },
  });
  const migrationId = "00000000-0000-4000-a000-000000000001";
  const requestId = "00000000-0000-4000-a000-000000000002";
  const state = {
    sourceId: "source",
    migrationId,
    credentials: { references: [], migratedConfigPaths: [] },
    bindings: [
      {
        alias: { legacyProjectId: "a".repeat(24) },
        projectId: "project",
        workspace: root,
        dataDir: join(root, "data"),
        scratchDir: join(root, "scratch"),
        registration: { source: { kind: "gui" } },
      },
    ],
  };
  owner.client.connectOrStart = async () => {};
  owner.client.requireCapability = () => {};
  owner.client.sourceState = async () => state;
  owner.client.listProjects = async () => ({ projects: [] });
  owner.client.status = async () => ({ projects: [] });
  const original = GuiSourceAdapter.prototype.retire;
  t.after(() => {
    GuiSourceAdapter.prototype.retire = original;
  });
  const attempts = [];
  GuiSourceAdapter.prototype.retire = async (migration, id) => {
    attempts.push({ migration, id });
    if (attempts.length === 1)
      throw Object.assign(new Error("SECRET_FIXTURE"), {
        code: "storageLocked",
        requestId,
        migrationId,
      });
    assert.equal(id, requestId);
    return { state: "completed", migrationId, requestId, planId: "plan", next: null };
  };
  await assert.doesNotReject(owner.init());
  assert.equal((await owner.list()).length, 1);
  assert.equal(owner.retirement.state, "pending");
  assert.equal(owner.retirement.requestId, requestId);
  assert.doesNotMatch(owner.retirement.error, /SECRET_FIXTURE/);
  await owner.reconnect();
  assert.equal(owner.retirement.state, "completed");
  assert.equal(attempts.length, 2);
});

test("concurrent retirement recovery shares one operation before the first response", async (t) => {
  const owner = new GuiHostProjects({
    binary: "/unused",
    home: "/unused",
    singletonHeld: true,
    source: { profile: "/unused", coreHome: "/unused", legacyServiceHome: "/unused" },
  });
  owner.migrationId = "00000000-0000-4000-a000-000000000001";
  const original = GuiSourceAdapter.prototype.retire;
  t.after(() => {
    GuiSourceAdapter.prototype.retire = original;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  GuiSourceAdapter.prototype.retire = async () => {
    calls++;
    await gate;
    throw Object.assign(new Error("fixture timeout"), {
      requestId: "00000000-0000-4000-a000-000000000002",
    });
  };
  const one = owner.retire();
  const two = owner.retire();
  assert.equal(one, two);
  assert.equal(calls, 1);
  release();
  const [first, second] = await Promise.all([one, two]);
  assert.equal(first, second);
  assert.equal(first.state, "pending");
  assert.equal(first.requestId, "00000000-0000-4000-a000-000000000002");
});

test("published source startup does not wait for credential handoff and close leaves the original task alive", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "areal-source-deferred-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = new GuiHostProjects({
    binary: "/unused",
    home: join(root, "host"),
    singletonHeld: true,
    source: {
      profile: join(root, "profile"),
      coreHome: join(root, "core"),
      legacyServiceHome: join(root, "legacy"),
    },
  });
  const migrationId = "00000000-0000-4000-a000-000000000003";
  const state = {
    sourceId: "source",
    migrationId,
    bindings: [],
    credentials: { references: [], migratedConfigPaths: [] },
    migration: { state: "pending", pendingProjects: [] },
  };
  let published = false;
  owner.client.connectOrStart = async () => {};
  owner.client.requireCapability = () => {};
  owner.client.sourceState = async () => (published ? state : null);
  owner.client.listProjects = async () => ({ projects: [] });
  owner.client.status = async () => ({ projects: [] });
  let closed = false;
  owner.client.close = () => {
    closed = true;
  };
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const imports = [];
  const retirements = [];
  t.mock.method(GuiSourceAdapter.prototype, "import", async (id, options) => {
    imports.push({ id, options });
    if (options?.publishOnly) {
      published = true;
      return { kind: "blocked", sourcePublished: true };
    }
    await barrier;
    assert.equal(closed, true);
    return { kind: "ready", migrationId };
  });
  t.mock.method(GuiSourceAdapter.prototype, "retire", async (id) => {
    retirements.push(id);
  });
  try {
    await owner.init({ deferCredentials: true });
    assert.equal(imports.length, 2);
    assert.equal(imports[1].id, migrationId);
    assert.equal(retirements.length, 0);
    const running = owner.migrating;
    owner.close();
    release();
    await running;
    assert.deepEqual(retirements, [migrationId]);
  } finally {
    release();
    await owner.migrating;
  }
});

test("partial project retry retains its migration ID and keeps journal unavailable until publication", async () => {
  const owner = new GuiHostProjects({
    binary: "/unused",
    home: "/unused",
    singletonHeld: false,
    source: { profile: "/unused", coreHome: "/unused", legacyServiceHome: "/unused" },
  });
  owner.migrationId = "00000000-0000-4000-a000-000000000004";
  owner.bindings.set("legacy", { projectId: "project" });
  owner.state = { migration: { state: "pending", pendingProjects: ["project"] } };
  let reads = 0;
  owner.client.journal = async () => {
    reads++;
    return {};
  };
  assert.throws(() => owner.journal("legacy"), { code: "MIGRATION_PENDING" });
  owner.client.importSource = async (id, source) => {
    assert.equal(id, owner.migrationId);
    assert.equal(source, owner.source);
    return { kind: "ready" };
  };
  owner.list = async () => {
    owner.state.migration = { state: "completed", pendingProjects: [] };
    return [];
  };
  await owner.resumeMigration("legacy");
  await owner.journal("legacy");
  assert.equal(reads, 1);
});

test("source adapter retains a locked credential while confirming its independent sibling", async (t) => {
  const { HostClient } = require("../packages/client/node/host-client.cjs");
  const migrationId = "00000000-0000-4000-a000-000000000005";
  const locked = {
    slot: { kind: "providerCredential", reference: "locked" },
    sourceDigest: "a".repeat(64),
    requestId: "00000000-0000-4000-a000-000000000006",
  };
  const ready = {
    slot: { kind: "providerCredential", reference: "ready" },
    sourceDigest: "b".repeat(64),
    requestId: "00000000-0000-4000-a000-000000000007",
  };
  const later = {
    ...locked,
    sourceDigest: "c".repeat(64),
    requestId: "00000000-0000-4000-a000-000000000009",
  };
  let calls = 0;
  t.mock.method(HostClient.prototype, "connect", async () => {});
  t.mock.method(HostClient.prototype, "attachSource", async () => {});
  t.mock.method(HostClient.prototype, "close", () => {});
  t.mock.method(HostClient.prototype, "importSource", async (id) => {
    assert.equal(id, migrationId);
    return {
      kind: "blocked",
      sourcePublished: true,
      migrationId,
      pendingSecrets: ++calls === 1 ? [locked, later, ready] : [locked, later],
    };
  });
  const admitted = [];
  t.mock.method(HostClient.prototype, "importSecret", async (id, secret) => {
    admitted.push({ id, requestId: secret.requestId });
    return { state: "completed", sourceDigest: secret.sourceDigest };
  });
  t.mock.method(GuiSourceAdapter.prototype, "extract", async (secret) => {
    if (secret === locked)
      throw Object.assign(new Error("synthetic locked slot"), { code: "storageLocked" });
    return "synthetic-value";
  });
  const adapter = new GuiSourceAdapter({
    source: { profile: "/unused", coreHome: "/unused", legacyServiceHome: "/unused" },
    hostHome: "/unused",
    singletonHeld: true,
  });
  const result = await adapter.import(migrationId);
  assert.deepEqual(result.pendingSecrets, [locked, later]);
  assert.deepEqual(admitted, [{ id: migrationId, requestId: ready.requestId }]);
});

test("source adapter runs independent slots concurrently and preserves same-slot digest order", async (t) => {
  const { HostClient } = require("../packages/client/node/host-client.cjs");
  const source = { profile: "/unused", coreHome: "/unused", legacyServiceHome: "/unused" };
  const migrationId = "00000000-0000-4000-a000-000000000008";
  const secret = (reference, digest) => ({
    slot: { kind: "providerCredential", reference },
    sourceDigest: digest.repeat(64),
  });
  const first = secret("same", "a"),
    second = secret("same", "b"),
    independent = secret("other", "c");
  let reads = 0;
  t.mock.method(HostClient.prototype, "connect", async () => {});
  t.mock.method(HostClient.prototype, "attachSource", async () => {});
  t.mock.method(HostClient.prototype, "close", () => {});
  t.mock.method(HostClient.prototype, "importSource", async () =>
    ++reads === 1
      ? {
          kind: "blocked",
          sourcePublished: true,
          migrationId,
          pendingSecrets: [first, second, independent],
        }
      : { kind: "ready", migrationId },
  );
  t.mock.method(GuiSourceAdapter.prototype, "extract", async () => "synthetic");
  let release, observed;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const fast = new Promise((resolve) => {
    observed = resolve;
  });
  const order = [];
  t.mock.method(HostClient.prototype, "importSecret", async (id, item) => {
    assert.equal(id, migrationId);
    order.push(item);
    if (item === first) await barrier;
    if (item === independent) observed();
    return { state: "completed", sourceDigest: item.sourceDigest };
  });
  const adapter = new GuiSourceAdapter({ source, hostHome: "/unused", singletonHeld: true });
  const importing = adapter.import(migrationId);
  try {
    await fast;
    assert.deepEqual(order, [first, independent]);
    release();
    await importing;
    assert.deepEqual(order, [first, independent, second]);
  } finally {
    release();
    await importing;
  }
});
