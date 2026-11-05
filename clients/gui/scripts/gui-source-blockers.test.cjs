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
