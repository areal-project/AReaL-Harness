"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { GuiSourceAdapter, GuiSourceSession } = require("node:module").createRequire(
  require.resolve("../app/package.json"),
)("@areal/client/gui-source");

test("native source preparation sends only configured environment credentials without starting Node", async () => {
  const owner = new GuiSourceSession({
    binary: "/unused",
    home: "/unused",
    singletonHeld: true,
    source: { profile: "/profile", coreHome: "/core", legacyServiceHome: "/legacy" },
  });
  const calls = [];
  owner.client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "backend.credentialNames") return { names: ["FIXTURE_KEY"] };
    return { identity: "owner" };
  };
  const options = { guiProfile: "/profile" };
  const prepared = await owner.prepareNative(options, { FIXTURE_KEY: "secret", OTHER: "hidden" });
  assert.deepEqual(prepared.environmentCredentials, { FIXTURE_KEY: "secret" });
  assert.deepEqual(
    calls.map((call) => call.method),
    ["backend.credentialNames"],
  );
  calls.length = 0;
  owner.client.request = async (method, params) => {
    calls.push({ method, params });
    return method === "backend.credentialNames"
      ? { names: [], configurationError: true }
      : { identity: "owner" };
  };
  const invalid = await owner.prepareNative(options, { FIXTURE_KEY: "secret" });
  assert.equal("environmentCredentials" in invalid, false);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["backend.credentialNames"],
  );
});

test("source migration reports safe actionable blockers without exposing source data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "areal-source-blockers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = new GuiSourceSession({
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

test("published source startup does not wait for credential handoff and close leaves the original task alive", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "areal-source-deferred-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = new GuiSourceSession({
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

test("native GUI source session publishes the original source without project projections", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "areal-native-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = new GuiSourceSession({
    binary: "/unused",
    home: join(root, "host"),
    singletonHeld: true,
    source: {
      profile: join(root, "profile"),
      coreHome: join(root, "core"),
      legacyServiceHome: join(root, "legacy"),
    },
  });
  const state = {
    sourceId: "source",
    migrationId: "original-migration",
    migration: { state: "pending" },
  };
  owner.client.connectOrStart = async () => {};
  owner.client.requireCapability = () => {};
  owner.client.sourceState = async () => state;
  owner.client.listProjects = async () =>
    assert.fail("native source cannot build a Node project projection");
  const imported = GuiSourceAdapter.prototype.import,
    retired = GuiSourceAdapter.prototype.retire;
  t.after(() => {
    GuiSourceAdapter.prototype.import = imported;
    GuiSourceAdapter.prototype.retire = retired;
    owner.close();
  });
  const calls = [];
  GuiSourceAdapter.prototype.import = async function (requestId) {
    calls.push(["import", requestId, this.source]);
    return { kind: "ready" };
  };
  GuiSourceAdapter.prototype.retire = async function (requestId) {
    calls.push(["retire", requestId, this.source]);
    return { state: "completed" };
  };
  await owner.init({ deferCredentials: true });
  assert.equal(owner.sourceId, "source");
  assert.equal(owner.migrationId, "original-migration");
  owner.close();
  await owner.migrating;
  assert.equal(calls.at(-1)[0], "retire");
  assert.equal(calls.at(-1)[1], "original-migration");
  assert.deepEqual(calls.at(-1)[2], owner.source);
});
